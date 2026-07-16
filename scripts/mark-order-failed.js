#!/usr/bin/env node
/**
 * Marca como "failed" un pedido que quedó atascado en un estado operativo
 * (no terminal), cuando la evidencia de fallido existe fuera del sistema.
 *
 * A diferencia de correct-delivered-to-failed.js, aquí NO hay asientos de
 * entrega que reversar: el pedido nunca se cerró. Para sellers Danda un fallido
 * genera 0 asientos, así que no se crea nada financiero. El script ABORTA si el
 * pedido ya tiene asientos de wallet (caso inesperado que requiere revisión).
 *
 * Uso:  node scripts/mark-order-failed.js            (dry-run)
 *       node scripts/mark-order-failed.js --apply     (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

const TARGETS = [
  {
    id: "shopify-6682355007601", // KNT-001252
    failedCategory: "failed_visit",
    failedReason: "Corrección manual: pedido fallido (evidencia registrada fuera del sistema)",
  },
];

const TERMINAL = new Set(["delivered", "failed", "cancelled", "liquidated"]);

async function processOrder(target) {
  const ref = db.collection("orders").doc(target.id);
  const doc = await ref.get();
  if (!doc.exists) return { id: target.id, skipped: "no existe" };
  const order = doc.data();

  if (TERMINAL.has(order.status)) {
    return { id: target.id, trackingCode: order.trackingCode, skipped: `status "${order.status}" ya es terminal` };
  }

  const weSnap = await db.collection("walletEntries").where("orderId", "==", target.id).get();
  if (!weSnap.empty) {
    return {
      id: target.id,
      trackingCode: order.trackingCode,
      aborted: `tiene ${weSnap.size} asiento(s) de wallet inesperados; revisar manualmente`,
      wallet: weSnap.docs.map((d) => ({ id: d.id, type: d.data().type, amountCop: d.data().amountCop, settlementId: d.data().settlementId ?? null })),
    };
  }

  const existingEvidence = Array.isArray(order.evidence) ? order.evidence : [];
  const failedEvidence = {
    id: `ev-manual-${Date.now()}`,
    type: "failed",
    photoLabel: "",
    note: target.failedReason,
    reason: target.failedReason,
    failedCategory: target.failedCategory,
    createdAt: now,
    actorId: "script:mark-order-failed",
  };

  const orderPatch = {
    status: "failed",
    failedCategory: target.failedCategory,
    failedCategorySource: "manual_correction",
    failedCategoryConfidence: 0.5,
    failedReason: target.failedReason,
    evidence: [...existingEvidence, failedEvidence],
    updatedAt: now,
  };

  const auditId = `audit-mark-failed-${Date.now()}-${target.id.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:mark-order-failed",
    actorRole: "admin",
    action: "order.mark_failed_manual",
    entity: "order",
    entityId: target.id,
    summary: `Marcado manual ${order.status} -> failed (${target.failedCategory})`,
    createdAt: now,
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
    to: "failed",
    failedCategory: target.failedCategory,
    walletEntriesTouched: 0,
    auditId,
  };
}

(async () => {
  const results = [];
  for (const t of TARGETS) results.push(await processOrder(t));
  console.log(JSON.stringify({ apply, now, results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
