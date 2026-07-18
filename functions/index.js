const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

admin.initializeApp();

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