// Firebase connection for LoyaltyMarket

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBD-NuKtNClpnRN7ZpOjiM9tJ-KMP2-CFo",
  authDomain: "loyaltymarket-7fd88.firebaseapp.com",
  projectId: "loyaltymarket-7fd88",
  storageBucket: "loyaltymarket-7fd88.firebasestorage.app",
  messagingSenderId: "360241371084",
  appId: "1:360241371084:web:e25a3a31297014a510ef69",
  measurementId: "G-G7MK6JP23P"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);