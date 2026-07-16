#!/usr/bin/env node
/**
 * Corrección manual delivered -> failed para pedidos cuya evidencia real es un fallido.
 *
 * No existe callable oficial para esta transición (delivered es terminal y está
 * bloqueado en applyOrderTransition/closeOrder/updateOrderAdjustments a propósito).
 * Esta corrección se hace vía Admin SDK, siguiendo el patrón de
 * scripts/reclassify-failed-categories.js, y:
 *   1. cambia order.status a "failed" (+ failedReason/failedCategory/updatedAt),
 *   2. convierte la evidencia mal etiquetada "delivery" -> "failed",
 *   3. reversa (elimina) los asientos de wallet de la entrega. Para sellers Danda
 *      un fallido genera 0 asientos, así que el estado correcto = sin asientos.
 *      El script ABORTA si algún asiento ya tiene settlementId (dinero liquidado):
 *      ese caso requiere clawback vía cod_remittance, fuera de este script.
 *   4. escribe un auditEvents documentando el cambio.
 *
 * Uso:  node scripts/correct-delivered-to-failed.js            (dry-run)
 *       node scripts/correct-delivered-to-failed.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

// Pedidos a corregir: docId + categoría de fallido decidida.
const TARGETS = [
  {
    id: "shopify-6687166824561", // KNT-001434
    failedCategory: "failed_visit",
    failedCategoryConfidence: 0.8,
  },
];

async function processOrder(target) {
  const ref = db.collection("orders").doc(target.id);
  const doc = await ref.get();
  if (!doc.exists) return { id: target.id, skipped: "no existe" };
  const order = doc.data();

  if (order.status !== "delivered") {
    return { id: target.id, trackingCode: order.trackingCode, skipped: `status actual "${order.status}" != delivered` };
  }

  // Evidencia que documenta el fallido (mal etiquetada como delivery).
  const evidence = Array.isArray(order.evidence) ? order.evidence : [];
  const failedNote = evidence.map((e) => e.note).filter(Boolean).join(" | ") || "Corrección manual: evidencia de fallido";
  const nextEvidence = evidence.map((e) => ({
    ...e,
    type: "failed",
    failedCategory: target.failedCategory,
    reason: e.reason ?? e.note ?? "fallido",
  }));

  // Reversa financiera: los asientos de la entrega deben desaparecer.
  const weSnap = await db.collection("walletEntries").where("orderId", "==", target.id).get();
  const wallet = weSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const settled = wallet.filter((w) => w.settlementId);
  if (settled.length > 0) {
    return {
      id: target.id,
      trackingCode: order.trackingCode,
      aborted: "tiene asientos ya liquidados (settlementId); requiere clawback cod_remittance manual",
      settledEntries: settled.map((w) => ({ id: w.id, settlementId: w.settlementId })),
    };
  }

  const orderPatch = {
    status: "failed",
    failedCategory: target.failedCategory,
    failedCategorySource: "manual_correction",
    failedCategoryConfidence: target.failedCategoryConfidence,
    failedReason: failedNote,
    evidence: nextEvidence,
    updatedAt: now,
  };

  const auditId = `audit-correct-failed-${Date.now()}-${target.id.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:correct-delivered-to-failed",
    actorRole: "admin",
    action: "order.correct_delivered_to_failed",
    entity: "order",
    entityId: target.id,
    summary: `Corrección manual delivered -> failed (${target.failedCategory}); reversados ${wallet.length} asientos de wallet`,
    createdAt: now,
  };

  if (apply) {
    const batch = db.batch();
    batch.set(ref, orderPatch, { merge: true });
    for (const w of wallet) batch.delete(db.collection("walletEntries").doc(w.id));
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  return {
    id: target.id,
    trackingCode: order.trackingCode,
    applied: apply,
    orderPatch: { ...orderPatch, evidence: `${nextEvidence.length} evidencia(s) delivery->failed` },
    walletEntriesDeleted: wallet.map((w) => ({ id: w.id, type: w.type, amountCop: w.amountCop })),
    auditId,
  };
}

(async () => {
  const results = [];
  for (const t of TARGETS) results.push(await processOrder(t));
  console.log(JSON.stringify({ apply, now, results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
