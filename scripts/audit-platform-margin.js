#!/usr/bin/env node
const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG_PROJECT_ID || "kentro-last-mile" });
const db = admin.firestore();

const startArg = process.argv.find((arg) => arg.startsWith("--start="));
const endArg = process.argv.find((arg) => arg.startsWith("--end="));
const startDate = startArg ? startArg.slice("--start=".length) : "";
const endDate = endArg ? endArg.slice("--end=".length) : "";

function inRange(entry) {
  const entryDate = String(entry.createdAt || "").slice(0, 10);
  return (!startDate || entryDate >= startDate) && (!endDate || entryDate <= endDate);
}

function money(value) {
  return Math.round(Number(value) || 0);
}

(async () => {
  const walletSnap = await db.collection("walletEntries").get();
  const entries = walletSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(inRange);
  const sellerFeesCop = Math.max(0, -entries
    .filter((entry) => entry.ownerType === "seller" && (entry.type === "delivery_fee" || entry.type === "failed_fee" || entry.type === "fulfillment_fee"))
    .reduce((sum, entry) => sum + money(entry.amountCop), 0));
  const productCostCop = Math.max(0, -entries
    .filter((entry) => entry.ownerType === "seller" && entry.type === "product_cost")
    .reduce((sum, entry) => sum + money(entry.amountCop), 0));
  const driverPayCop = entries
    .filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning")
    .reduce((sum, entry) => sum + money(entry.amountCop), 0);
  const codCop = entries
    .filter((entry) => entry.ownerType === "seller" && entry.type === "cod_revenue")
    .reduce((sum, entry) => sum + money(entry.amountCop), 0);
  console.log(JSON.stringify({
    startDate: startDate || null,
    endDate: endDate || null,
    walletEntries: entries.length,
    codCop,
    sellerFeesCop,
    driverPayCop,
    platformMarginCop: sellerFeesCop - driverPayCop,
    productCostCop,
    note: "platformMarginCop excludes productCostCop and COD."
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
