#!/usr/bin/env node
/**
 * Corrección puntual: la liquidación de vive zen stl-1784032933645 registró $275.000
 * (16 entregados) pero se pagó $239.000, porque 3 cobros por fallido (-$36.000) se
 * restaron en pantalla pero el backend no los barrió (divergencia cliente/servidor en
 * la elegibilidad COD de pedidos fallidos). Esta corrección adjunta esos 3 cobros a la
 * liquidación para que el registro cuadre con lo pagado y desaparezca el residual -$36.000.
 *
 * Uso:  node scripts/reconcile-vivezen-settlement.js           (dry-run)
 *       node scripts/reconcile-vivezen-settlement.js --apply
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const money = (n) => Math.round(Number(n || 0));
const now = new Date().toISOString();

const SID = "stl-1784032933645-seller-seller-1780588345624";
const FAILED_FEE_IDS = [
  "we-ord-knt-000348-seller-failed-fee",
  "we-ord-knt-000434-seller-failed-fee",
  "we-ord-knt-000435-seller-failed-fee",
];

(async () => {
  const sRef = db.collection("settlements").doc(SID);
  const sSnap = await sRef.get();
  if (!sSnap.exists) throw new Error("Settlement no existe");
  const s = sSnap.data();

  // Cargar los 3 asientos y validar
  const feeSnaps = await Promise.all(FAILED_FEE_IDS.map((id) => db.collection("walletEntries").doc(id).get()));
  const fees = feeSnaps.map((d) => ({ id: d.id, exists: d.exists, ...d.data() }));
  const problems = [];
  for (const f of fees) {
    if (!f.exists) problems.push(`${f.id}: no existe`);
    else if (f.type !== "failed_fee") problems.push(`${f.id}: tipo ${f.type} != failed_fee`);
    else if (f.settlementId) problems.push(`${f.id}: ya liquidado en ${f.settlementId}`);
    else if (f.ownerId !== s.ownerId) problems.push(`${f.id}: ownerId no coincide`);
  }
  if (problems.length > 0) throw new Error("Validación falló: " + problems.join("; "));

  const addFeesCop = -fees.reduce((a, f) => a + Number(f.amountCop || 0), 0); // 36000 (positivo)
  const newNetCop = money(s.netCop) - addFeesCop;        // 275000 - 36000 = 239000
  const newFeesCop = money(s.feesCop) + addFeesCop;      // 192000 + 36000 = 228000
  const newPlatformMarginCop = newFeesCop - money(s.driverPayCop || 0); // 228000
  const newOrderIds = fees.map((f) => f.orderId);
  const platformId = `we-${SID}-platform-margin`;

  const plan = {
    settlement: { netCop: `${money(s.netCop)} -> ${newNetCop}`, feesCop: `${money(s.feesCop)} -> ${newFeesCop}`, platformMarginCop: `${money(s.platformMarginCop)} -> ${newPlatformMarginCop}`, addOrderIds: newOrderIds, addWalletEntryIds: FAILED_FEE_IDS },
    platformEntry: { id: platformId, amountCop: `${money(s.feesCop)} -> ${newFeesCop}` },
    failedFeesAttached: FAILED_FEE_IDS,
  };

  if (apply) {
    const batch = db.batch();
    for (const id of FAILED_FEE_IDS) batch.set(db.collection("walletEntries").doc(id), { settlementId: SID }, { merge: true });
    batch.set(sRef, {
      netCop: newNetCop,
      feesCop: newFeesCop,
      platformMarginCop: newPlatformMarginCop,
      walletEntryIds: admin.firestore.FieldValue.arrayUnion(...FAILED_FEE_IDS),
      orderIds: admin.firestore.FieldValue.arrayUnion(...newOrderIds),
    }, { merge: true });
    batch.set(db.collection("walletEntries").doc(platformId), { amountCop: newFeesCop }, { merge: true });
    const auditId = `audit-reconcile-vivezen-${Date.now()}`;
    batch.set(db.collection("auditEvents").doc(auditId), {
      id: auditId,
      actorId: "script:reconcile-vivezen-settlement",
      actorRole: "admin",
      action: "settlement.reconcile_failed_fees",
      entity: "settlement",
      entityId: SID,
      summary: `Adjuntados 3 cobros por fallido (-${addFeesCop}) a liquidación; neto ${money(s.netCop)} -> ${newNetCop}`,
      createdAt: now,
    });
    await batch.commit();
  }

  console.log(JSON.stringify({ apply, plan }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
