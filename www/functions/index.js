const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();

const geminiApiKey = defineSecret("GEMINI_API_KEY");

const MOMO_BASE_URL = "https://sandbox.momodeveloper.mtn.com";
const MOMO_SUBSCRIPTION_KEY = "f8c776dca14d4890940b71b9655e1d44";
const MOMO_API_USER = "e219d1a8-7f43-4b1e-9c2a-6d5e8f3b1a90";
const MOMO_API_KEY = "b9d15d9dc73549edbca7ffb2c0e73001";

async function getMomoAccessToken() {
  const credentials = Buffer.from(`${MOMO_API_USER}:${MOMO_API_KEY}`).toString("base64");

  const response = await axios.post(
      `${MOMO_BASE_URL}/collection/token/`,
      {},
      {
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Ocp-Apim-Subscription-Key": MOMO_SUBSCRIPTION_KEY,
        },
      },
  );

  return response.data.access_token;
}

// Called from the checkout modal to actually send a Request-to-Pay
// to the buyer's phone via MTN MoMo.
exports.requestMomoPayment = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to make a payment.");
  }

  const {orderId, phone, amountUsd} = request.data;

  if (!orderId || !phone || !amountUsd) {
    throw new HttpsError("invalid-argument", "Missing orderId, phone, or amount.");
  }

  const orderRef = admin.firestore().collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new HttpsError("not-found", "Order not found.");
  }

  const referenceId = crypto.randomUUID();

  try {
    const accessToken = await getMomoAccessToken();

    await axios.post(
        `${MOMO_BASE_URL}/collection/v1_0/requesttopay`,
        {
          amount: String(amountUsd),
          currency: "EUR",
          externalId: orderId,
          payer: {
            partyIdType: "MSISDN",
            partyId: phone,
          },
          payerMessage: "Waterside order payment",
          payeeNote: "Waterside order payment",
        },
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "X-Reference-Id": referenceId,
            "X-Target-Environment": "sandbox",
            "Ocp-Apim-Subscription-Key": MOMO_SUBSCRIPTION_KEY,
            "Content-Type": "application/json",
          },
        },
    );

    await orderRef.update({
      paymentStatus: "pending_confirmation",
      momoReferenceId: referenceId,
    });

    return {success: true, referenceId};
  } catch (error) {
    console.error("MoMo request-to-pay failed:", error.response ? error.response.data : error.message);
    throw new HttpsError("internal", "Could not send the payment request.");
  }
});

// Called after the buyer confirms on their phone, to check whether
// MTN has actually marked the payment successful yet.
exports.checkMomoPaymentStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to check payment status.");
  }

  const {orderId} = request.data;

  if (!orderId) {
    throw new HttpsError("invalid-argument", "Missing orderId.");
  }

  const orderRef = admin.firestore().collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new HttpsError("not-found", "Order not found.");
  }

  const referenceId = orderSnap.data().momoReferenceId;

  if (!referenceId) {
    throw new HttpsError("failed-precondition", "No payment request found for this order.");
  }

  try {
    const accessToken = await getMomoAccessToken();

    const response = await axios.get(
        `${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceId}`,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "X-Target-Environment": "sandbox",
            "Ocp-Apim-Subscription-Key": MOMO_SUBSCRIPTION_KEY,
          },
        },
    );

    const status = response.data.status;

    if (status === "SUCCESSFUL") {
      await orderRef.update({paymentStatus: "paid", status: "confirmed"});
    } else if (status === "FAILED") {
      await orderRef.update({paymentStatus: "failed"});
    }

    return {status};
  } catch (error) {
    console.error("MoMo status check failed:", error.response ? error.response.data : error.message);
    throw new HttpsError("internal", "Could not check payment status.");
  }
});

// Called after a listing is created/edited. Sends the listing to Gemini
// for a smarter scam-pattern check that runs alongside the existing
// rule-based checks. Never auto-rejects — only adds flagReasons and
// routes the listing into the same Pending Review queue admins already use.
exports.checkListingWithAI = onCall({secrets: [geminiApiKey]}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to submit a listing.");
  }

  const {productId, title, description, category, priceUsd} = request.data;

  if (!productId || !title) {
    throw new HttpsError("invalid-argument", "Missing productId or title.");
  }

  const prompt = `You are a fraud-detection assistant for a Liberian online marketplace called Waterside.
Review this listing and decide if it shows signs of being a scam (e.g. unrealistic pricing, urgency/pressure language, requests to pay outside the platform, vague or copy-pasted descriptions, mismatched details).

Title: ${title}
Category: ${category || "unknown"}
Price (USD): ${priceUsd || "unknown"}
Description: ${description || "none provided"}

Respond with ONLY a JSON object, no other text, in this exact shape:
{"suspicious": true or false, "reasons": ["short reason 1", "short reason 2"]}
If nothing seems wrong, respond with {"suspicious": false, "reasons": []}.`;

  try {
    const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey.value()}`,
        {
          contents: [{parts: [{text: prompt}]}],
        },
        {headers: {"Content-Type": "application/json"}},
    );

    const rawText = response.data.candidates[0].content.parts[0].text;
    const cleanedText = rawText.replace(/```json|```/g, "").trim();
    const result = JSON.parse(cleanedText);

    if (result.suspicious && Array.isArray(result.reasons) && result.reasons.length > 0) {
      const productRef = admin.firestore().collection("products").doc(productId);
      const productSnap = await productRef.get();

      if (productSnap.exists) {
        const existingReasons = Array.isArray(productSnap.data().flagReasons) ?
          productSnap.data().flagReasons : [];

        await productRef.update({
          status: "pending_review",
          flagged: true,
          flagReasons: [...existingReasons, ...result.reasons.map((r) => `AI: ${r}`)],
        });
      }
    }

    return {suspicious: Boolean(result.suspicious), reasons: result.reasons || []};
  } catch (error) {
    console.error("AI scam check failed:", error.response ? error.response.data : error.message);
    // Fail open: if the AI check errors out, don't block the listing —
    // the existing rule-based checks still ran separately.
    return {suspicious: false, reasons: [], error: true};
  }
});