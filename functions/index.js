const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");

const {
  onCall,
  HttpsError
} = require("firebase-functions/v2/https");

const {
  defineSecret
} = require("firebase-functions/params");

admin.initializeApp();

const geminiApiKey = defineSecret("GEMINI_API_KEY");

/*
  Waterside is a Jiji-style marketplace.

  Buyers and sellers arrange payment directly.
  Waterside does not collect or hold marketplace payments.

  The old MTN MoMo payment functions and exposed credentials
  have therefore been removed from this file.
*/


// ======================================================
// SECURE LISTING VIEW COUNTER
// ======================================================

exports.recordListingView = onCall(async (request) => {
  const data = request.data || {};

  const productId = data.productId;
  const viewerId = data.viewerId;

  if (
    typeof productId !== "string" ||
    productId.trim() === "" ||
    productId.length > 200
  ) {
    throw new HttpsError(
      "invalid-argument",
      "A valid product ID is required."
    );
  }

  /*
    Logged-out visitors need a browser-generated viewer ID.

    Logged-in users are identified using their Firebase UID.
  */
  if (
    !request.auth &&
    (
      typeof viewerId !== "string" ||
      viewerId.length < 16 ||
      viewerId.length > 120
    )
  ) {
    throw new HttpsError(
      "invalid-argument",
      "A valid viewer ID is required."
    );
  }

  const db = admin.firestore();
  const cleanProductId = productId.trim();

  const productRef = db
    .collection("products")
    .doc(cleanProductId);

  /*
    Create a private identifier for this viewer.

    The raw Firebase UID or browser ID is not stored.
  */
  const viewerKey = request.auth
    ? `user:${request.auth.uid}`
    : `browser:${viewerId}`;

  const viewerHash = crypto
    .createHash("sha256")
    .update(viewerKey)
    .digest("hex");

  const viewEventRef = db
    .collection("listingViewEvents")
    .doc(`${cleanProductId}_${viewerHash}`);

  const sixHoursMilliseconds =
    6 * 60 * 60 * 1000;

  const currentTime = Date.now();

  const result = await db.runTransaction(
    async (transaction) => {
      const productSnapshot =
        await transaction.get(productRef);

      if (!productSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Listing not found."
        );
      }

      const product = productSnapshot.data();

      /*
        Do not increase the view counter when the seller
        opens their own listing.
      */
      if (
        request.auth &&
        product.sellerId === request.auth.uid
      ) {
        return {
          counted: false,
          reason: "owner_view",
          viewCount: Number(
            product.viewCount ||
            product.views ||
            0
          )
        };
      }

      const eventSnapshot =
        await transaction.get(viewEventRef);

      let lastCountedMilliseconds = 0;

      if (eventSnapshot.exists) {
        const lastCountedAt =
          eventSnapshot.data().lastCountedAt;

        if (
          lastCountedAt &&
          typeof lastCountedAt.toMillis === "function"
        ) {
          lastCountedMilliseconds =
            lastCountedAt.toMillis();
        }
      }

      /*
        Prevent the same user or browser from increasing
        the count repeatedly within six hours.
      */
      if (
        lastCountedMilliseconds &&
        currentTime - lastCountedMilliseconds
          < sixHoursMilliseconds
      ) {
        return {
          counted: false,
          reason: "recently_counted",
          viewCount: Number(
            product.viewCount ||
            product.views ||
            0
          )
        };
      }

      transaction.set(
        viewEventRef,
        {
          productId: cleanProductId,
          viewerHash,
          authenticated: Boolean(request.auth),

          lastCountedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        },
        {
          merge: true
        }
      );

      transaction.update(
        productRef,
        {
          viewCount:
            admin.firestore.FieldValue.increment(1),

          lastViewedAt:
            admin.firestore.FieldValue
              .serverTimestamp()
        }
      );

      return {
        counted: true,
        reason: "counted",

        viewCount:
          Number(
            product.viewCount ||
            product.views ||
            0
          ) + 1
      };
    }
  );

  return result;
});


// ======================================================
// AI LISTING SCAM CHECK
// ======================================================

exports.checkListingWithAI = onCall(
  {
    secrets: [geminiApiKey]
  },

  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be logged in to submit a listing."
      );
    }

    const data = request.data || {};

    const productId = data.productId;
    const title = data.title;
    const description = data.description;
    const category = data.category;
    const priceUsd = data.priceUsd;

    if (!productId || !title) {
      throw new HttpsError(
        "invalid-argument",
        "Missing product ID or title."
      );
    }

    const prompt = `
You are a fraud-detection assistant for a Liberian
online marketplace called Waterside.

Review this listing and determine whether it shows
possible signs of being a scam.

Possible warning signs include:

- Unrealistic pricing
- Pressure or urgent-payment language
- Requests to pay before inspecting the product
- Vague descriptions
- Copied descriptions
- Mismatched product details
- Suspicious contact or payment instructions

Listing title:
${title}

Category:
${category || "Unknown"}

Price in USD:
${priceUsd || "Unknown"}

Description:
${description || "No description provided"}

Respond using only valid JSON in this exact format:

{
  "suspicious": true,
  "reasons": [
    "Short reason"
  ]
}

If the listing does not appear suspicious, respond:

{
  "suspicious": false,
  "reasons": []
}
`;

    try {
      const apiUrl =
        "https://generativelanguage.googleapis.com/" +
        "v1beta/models/gemini-2.0-flash:" +
        "generateContent" +
        `?key=${geminiApiKey.value()}`;

      const response = await axios.post(
        apiUrl,
        {
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
        },
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

      const candidates =
        response.data &&
        response.data.candidates;

      if (
        !Array.isArray(candidates) ||
        candidates.length === 0
      ) {
        throw new Error(
          "Gemini did not return a response."
        );
      }

      const rawText =
        candidates[0]
          .content
          .parts[0]
          .text;

      const cleanedText = rawText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const result = JSON.parse(cleanedText);

      const suspicious =
        Boolean(result.suspicious);

      const reasons =
        Array.isArray(result.reasons)
          ? result.reasons
          : [];

      if (
        suspicious &&
        reasons.length > 0
      ) {
        const productRef = admin
          .firestore()
          .collection("products")
          .doc(productId);

        const productSnapshot =
          await productRef.get();

        if (productSnapshot.exists) {
          const product =
            productSnapshot.data();

          const existingReasons =
            Array.isArray(product.flagReasons)
              ? product.flagReasons
              : [];

          const aiReasons = reasons.map(
            (reason) => `AI: ${reason}`
          );

          await productRef.update({
            status: "pending_review",
            flagged: true,

            flagReasons: [
              ...existingReasons,
              ...aiReasons
            ],

            aiCheckedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          });
        }
      }

      return {
        suspicious,
        reasons
      };
    } catch (error) {
      console.error(
        "AI listing check failed:",
        error.response
          ? error.response.data
          : error.message
      );

      /*
        Fail open.

        If Gemini is unavailable, the listing is not
        automatically blocked. Your existing marketplace
        checks and admin review system can still handle it.
      */
      return {
        suspicious: false,
        reasons: [],
        error: true
      };
    }
  }
);