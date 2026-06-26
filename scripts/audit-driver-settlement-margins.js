#!/usr/bin/env node
const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG_PROJECT_ID || "kentro-last-mile" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");

function money(value) {
  return Math.round(Number(value) || 0);
}

function different(left, right) {
  return money(left) !== money(right);
}

function orderIdsForSettlement(settlement, walletById) {
  if (Array.isArray(settlement.orderIds) && settlement.orderIds.length > 0) {
    return Array.from(new Set(settlement.orderIds.filter(Boolean)));
  }
  return Array.from(new Set(
    (settlement.walletEntryIds || [])
      .map((entryId) => walletById.get(entryId)?.orderId)
      .filter(Boolean)
  ));
}

function calculate(settlement, wallet, walletById) {
  const orderIds = orderIdsForSettlement(settlement, walletById);
  const orderIdSet = new Set(orderIds);
  const sellerEntries = wallet.filter((entry) => entry.ownerType === "seller" && entry.orderId && orderIdSet.has(entry.orderId));
  const codCop = sellerEntries
    .filter((entry) => entry.type === "cod_revenue")
    .reduce((sum, entry) => sum + money(entry.amountCop), 0);
  const feesCop = Math.max(0, -sellerEntries
    .filter((entry) => entry.type === "delivery_fee" || entry.type === "failed_fee" || entry.type === "fulfillment_fee")
    .reduce((sum, entry) => sum + money(entry.amountCop), 0));
  const walletEntryIds = new Set(settlement.walletEntryIds || []);
  const driverPayCop = wallet
    .filter((entry) =>
      entry.type === "driver_earning" &&
      (
        walletEntryIds.has(entry.id) ||
        (entry.ownerType === "driver" && entry.ownerId === settlement.ownerId && entry.orderId && orderIdSet.has(entry.orderId))
      )
    )
    .reduce((sum, entry) => sum + money(entry.amountCop), 0);
  return {
    orderIds,
    codCop,
    feesCop,
    driverPayCop,
    platformMarginCop: feesCop - driverPayCop,
    netCop: driverPayCop - codCop
  };
}

(async () => {
  const [settlementsSnap, walletSnap] = await Promise.all([
    db.collection("settlements").where("kind", "==", "driver").get(),
    db.collection("walletEntries").get()
  ]);
  const wallet = walletSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const walletById = new Map(wallet.map((entry) => [entry.id, entry]));
  const differences = [];
  const batch = db.batch();
  let writes = 0;

  for (const doc of settlementsSnap.docs) {
    const settlement = { id: doc.id, ...doc.data() };
    const calculated = calculate(settlement, wallet, walletById);
    const patch = {};
    for (const field of ["codCop", "feesCop", "driverPayCop", "platformMarginCop", "netCop"]) {
      if (different(settlement[field], calculated[field])) {
        patch[field] = calculated[field];
      }
    }
    if (Object.keys(patch).length === 0) continue;
    differences.push({
      id: settlement.id,
      ownerId: settlement.ownerId,
      ownerName: settlement.ownerName,
      orderCount: calculated.orderIds.length,
      current: {
        codCop: money(settlement.codCop),
        feesCop: money(settlement.feesCop),
        driverPayCop: money(settlement.driverPayCop),
        platformMarginCop: money(settlement.platformMarginCop),
        netCop: money(settlement.netCop)
      },
      calculated: {
        codCop: calculated.codCop,
        feesCop: calculated.feesCop,
        driverPayCop: calculated.driverPayCop,
        platformMarginCop: calculated.platformMarginCop,
        netCop: calculated.netCop
      },
      patch
    });
    if (apply) {
      batch.set(doc.ref, patch, { merge: true });
      writes += 1;
    }
  }

  if (apply && writes > 0) await batch.commit();
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    settlements: settlementsSnap.size,
    differences: differences.length,
    writes,
    rows: differences
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
