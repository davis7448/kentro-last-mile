#!/usr/bin/env node
/**
 * KNT-000262 (shopify-7826098258070): quedó en status "delivered" pero sus financieros
 * ya fueron reversados a $0 (notas "Fallido no cobrable ni pagable Danda"). Esta corrección
 * solo alinea el estado a "failed" para que concuerde con el libro. NO mueve dinero.
 * Aborta si los financieros del pedido no netean a 0 (por seguridad).
 *
 * Uso:  node scripts/fix-knt262-status.js           (dry-run)
 *       node scripts/fix-knt262-status.js --apply
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const money = (n) => Math.round(Number(n || 0));
const now = new Date().toISOString();
const OID = "shopify-7826098258070";

(async () => {
  const ref = db.collection("orders").doc(OID);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Pedido no existe");
  const o = snap.data();
  if (o.status !== "delivered") throw new Error(`status actual "${o.status}" != delivered`);

  const wS = await db.collection("walletEntries").where("orderId", "==", OID).get();
  const netCod = money(wS.docs.map((d) => d.data()).filter((e) => ["cod_revenue", "cod_remittance"].includes(e.type)).reduce((a, e) => a + Number(e.amountCop || 0), 0));
  const netFee = money(wS.docs.map((d) => d.data()).filter((e) => e.type === "delivery_fee").reduce((a, e) => a + Number(e.amountCop || 0), 0));
  const netDriver = money(wS.docs.map((d) => d.data()).filter((e) => e.type === "driver_earning").reduce((a, e) => a + Number(e.amountCop || 0), 0));
  if (netCod !== 0 || netFee !== 0 || netDriver !== 0) {
    throw new Error(`Financieros NO netean a 0 (cod=${netCod}, fee=${netFee}, driver=${netDriver}); revisar antes de tocar estado`);
  }

  const patch = { status: "failed", updatedAt: now };
  const auditId = `audit-fix-status-${Date.now()}-${OID.slice(-8)}`;
  if (apply) {
    const batch = db.batch();
    batch.set(ref, patch, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), {
      id: auditId, actorId: "script:fix-knt262-status", actorRole: "admin",
      action: "order.align_status_to_reversed_financials", entity: "order", entityId: OID,
      summary: "KNT-000262: status delivered -> failed para concordar con financieros ya reversados a 0",
      createdAt: now,
    });
    await batch.commit();
  }
  console.log(JSON.stringify({ apply, order: OID, netCheck: { netCod, netFee, netDriver }, patch, auditId }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
