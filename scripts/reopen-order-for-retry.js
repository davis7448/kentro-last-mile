#!/usr/bin/env node
/**
 * Reabre un pedido cerrado como "failed" y lo devuelve a retry_pending para una
 * nueva visita, CONSERVANDO los asientos de la visita perdida (el cobro de fallido
 * al vendedor y el pago al domiciliario siguen siendo validos: la visita se hizo).
 *
 * No existe callable para esto: applyOrderTransition rechaza los estados terminales
 * a proposito, asi que la correccion va por Admin SDK siguiendo el patron de
 * scripts/correct-delivered-to-failed.js, y:
 *   1. pasa status failed -> retry_pending, con la nueva fecha/franja agendada,
 *   2. marca retryDecision "retry" y limpia failedReason/failedCategory del pedido
 *      (la evidencia de la visita perdida se conserva intacta como historico),
 *   3. escribe un auditEvents documentando el cambio.
 *
 * Los asientos NO se tocan. Si la nueva visita vuelve a fallar, buildWalletEntries
 * genera un id por numero de intento (…-failed-fee-2), asi que se cobra aparte.
 *
 * Uso: node scripts/reopen-order-for-retry.js            (dry-run)
 *      node scripts/reopen-order-for-retry.js --apply     (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

const TARGETS = [
  {
    id: "shopify-7412252016929", // KNT-002682 - Bella Mujer
    scheduledDate: "2026-07-30",
    scheduledWindow: "11:00 AM - 2:00 PM",
    note: "Cliente pidio recibir el jueves; se conserva el cobro de la visita perdida del martes."
  }
];

async function processOrder(target) {
  const ref = db.collection("orders").doc(target.id);
  const snap = await ref.get();
  if (!snap.exists) return { id: target.id, skipped: "no existe" };
  const order = snap.data();

  if (order.status !== "failed") {
    return { id: target.id, trackingCode: order.trackingCode, skipped: `status actual "${order.status}" != failed` };
  }

  const weSnap = await db.collection("walletEntries").where("orderId", "==", target.id).get();
  const settled = weSnap.docs.filter((doc) => doc.data().settlementId);
  if (settled.length > 0) {
    return {
      id: target.id,
      trackingCode: order.trackingCode,
      aborted: "los asientos de la visita perdida ya estan liquidados; reabrir requiere revision manual",
      settled: settled.map((doc) => doc.id)
    };
  }

  const orderPatch = {
    status: "retry_pending",
    retryDecision: "retry",
    scheduledDate: target.scheduledDate,
    scheduledWindow: target.scheduledWindow,
    // El pedido vuelve a estar abierto: los rotulos de fallido dejan de aplicar.
    // La evidencia de la visita perdida se conserva en order.evidence.
    failedReason: admin.firestore.FieldValue.delete(),
    failedCategory: admin.firestore.FieldValue.delete(),
    failedCategorySource: admin.firestore.FieldValue.delete(),
    failedCategoryConfidence: admin.firestore.FieldValue.delete(),
    callNote: target.note,
    updatedAt: now
  };

  const auditId = `audit-reopen-retry-${Date.now()}-${target.id.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:reopen-order-for-retry",
    actorRole: "admin",
    action: "order.reopened_for_retry",
    entity: "order",
    entityId: target.id,
    summary: `Pedido ${order.trackingCode ?? target.id} reabierto failed -> retry_pending para ${target.scheduledDate} ${target.scheduledWindow}; se conservan ${weSnap.size} asiento(s) de la visita perdida`,
    createdAt: now
  };

  if (apply) {
    const batch = db.batch();
    batch.set(ref, orderPatch, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  return {
    id: target.id,
    trackingCode: order.trackingCode,
    applied: apply,
    from: order.status,
    to: "retry_pending",
    agendado: `${target.scheduledDate} ${target.scheduledWindow}`,
    asientosConservados: weSnap.docs.map((doc) => ({ type: doc.data().type, amountCop: doc.data().amountCop })),
    evidenciasConservadas: (order.evidence ?? []).length,
    auditId
  };
}

(async () => {
  const results = [];
  for (const target of TARGETS) results.push(await processOrder(target));
  console.log(JSON.stringify({ apply, now, results }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
