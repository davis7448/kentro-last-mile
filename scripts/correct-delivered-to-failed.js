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
 *   4. si algún asiento está en un settlement PENDIENTE (no pagado), lo desprende:
 *      quita el asiento y el pedido del corte y recalcula los campos financieros
 *      almacenados replicando calculateDriverCashSummary del backend (codCop,
 *      feesCop, driverPayCop, platformMarginCop, netCop, cashExpectedCop,
 *      cashPendingCop, cashAllocations). El efectivo ya recibido no cambia.
 *      ABORTA si el settlement está paid/reconciled (dinero entregado):
 *      ese caso requiere clawback vía cod_remittance, fuera de este script.
 *   5. escribe un auditEvents documentando el cambio.
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
    id: "shopify-6699106566257", // KNT-001859
    failedCategory: "failed_visit",
    failedCategoryConfidence: 0.8,
  },
];

// Réplica de calculateDriverCashSummary (functions/src/orders.ts): deriva el
// resumen financiero de un corte de driver desde los walletEntries vivos.
async function recomputeDriverSettlement(settlement, receivedCop) {
  const orderIds = Array.from(new Set(settlement.orderIds ?? []));
  const [sellerEntrySnap, driverEntrySnap, orderSnaps] = await Promise.all([
    db.collection("walletEntries").where("ownerType", "==", "seller").get(),
    db.collection("walletEntries").where("ownerType", "==", "driver").get(),
    Promise.all(orderIds.map((orderId) => db.collection("orders").doc(orderId).get())),
  ]);
  const orderIdSet = new Set(orderIds);
  const codByOrder = new Map();
  const feesByOrder = new Map();
  for (const doc of sellerEntrySnap.docs) {
    const entry = doc.data();
    const orderId = String(entry.orderId ?? "");
    if (!orderIdSet.has(orderId)) continue;
    if (entry.type === "cod_revenue") codByOrder.set(orderId, (codByOrder.get(orderId) ?? 0) + Number(entry.amountCop || 0));
    if (["delivery_fee", "failed_fee", "fulfillment_fee"].includes(entry.type)) feesByOrder.set(orderId, (feesByOrder.get(orderId) ?? 0) + Number(entry.amountCop || 0));
  }
  const driverPayByOrder = new Map();
  for (const doc of driverEntrySnap.docs) {
    const entry = doc.data();
    const orderId = String(entry.orderId ?? "");
    if (entry.type !== "driver_earning" || !orderIdSet.has(orderId)) continue;
    driverPayByOrder.set(orderId, (driverPayByOrder.get(orderId) ?? 0) + Number(entry.amountCop || 0));
  }
  const orderMeta = new Map(orderSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data()]));
  const sortedOrderIds = orderIds
    .filter((orderId) => Math.max(0, (codByOrder.get(orderId) ?? 0) - (driverPayByOrder.get(orderId) ?? 0)) > 0)
    .sort((left, right) => {
      const l = orderMeta.get(left);
      const r = orderMeta.get(right);
      return String(l?.createdAt ?? "").localeCompare(String(r?.createdAt ?? "")) || String(l?.trackingCode ?? left).localeCompare(String(r?.trackingCode ?? right));
    });
  let remaining = Math.max(0, Number(receivedCop) || 0);
  const allocations = sortedOrderIds.map((orderId) => {
    const expectedOrderCop = Math.max(0, (codByOrder.get(orderId) ?? 0) - (driverPayByOrder.get(orderId) ?? 0));
    const receivedOrderCop = Math.min(expectedOrderCop, remaining);
    remaining -= receivedOrderCop;
    return { orderId, expectedCop: expectedOrderCop, receivedCop: receivedOrderCop, covered: receivedOrderCop >= expectedOrderCop };
  });
  const codCop = Array.from(codByOrder.values()).reduce((sum, amount) => sum + amount, 0);
  const feesCop = Math.max(0, -Array.from(feesByOrder.values()).reduce((sum, amount) => sum + amount, 0));
  const driverPayCop = Array.from(driverPayByOrder.values()).reduce((sum, amount) => sum + amount, 0);
  const expectedCop = Math.max(0, codCop - driverPayCop);
  const pendingCop = Math.max(0, expectedCop - receivedCop);
  return {
    codCop,
    feesCop,
    driverPayCop,
    platformMarginCop: feesCop - driverPayCop,
    netCop: driverPayCop - codCop,
    cashExpectedCop: expectedCop,
    cashReceivedCop: receivedCop,
    cashPendingCop: pendingCop,
    cashReceiptStatus: expectedCop === 0 ? "complete" : pendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
    cashAllocations: allocations,
  };
}

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
  const previousNotes = evidence.map((e) => e.note).filter(Boolean).join(" | ");
  const failedNote = `Corrección manual: pedido fallido${previousNotes ? ` (evidencia previa: "${previousNotes}")` : ""}`;
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

  // Settlements afectados: solo se permite desprender de cortes PENDIENTES.
  const settlementIds = [...new Set(settled.map((w) => w.settlementId))];
  const settlements = [];
  for (const sid of settlementIds) {
    const snap = await db.collection("settlements").doc(sid).get();
    if (!snap.exists) return { id: target.id, trackingCode: order.trackingCode, aborted: `settlement ${sid} no existe` };
    const data = snap.data();
    if (data.status !== "pending") {
      return {
        id: target.id,
        trackingCode: order.trackingCode,
        aborted: `asiento en settlement ${sid} con status "${data.status}" (dinero entregado); requiere clawback cod_remittance manual`,
      };
    }
    settlements.push({ id: sid, ref: snap.ref, data });
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
    summary: `Corrección manual delivered -> failed (${target.failedCategory}); reversados ${wallet.length} asientos de wallet${settlements.length > 0 ? `; desprendido de ${settlements.map((s) => s.id).join(", ")} (pendiente) y corte recalculado` : ""}`,
    createdAt: now,
  };

  const settlementUpdates = [];
  const walletIdSet = new Set(wallet.map((w) => w.id));
  for (const s of settlements) {
    const nextOrderIds = (s.data.orderIds ?? []).filter((oid) => oid !== target.id);
    const nextWalletEntryIds = (s.data.walletEntryIds ?? []).filter((wid) => !walletIdSet.has(wid));
    const summary = await recomputeDriverSettlement(
      { ...s.data, orderIds: nextOrderIds },
      Number(s.data.cashReceivedCop || 0)
    );
    settlementUpdates.push({
      ref: s.ref,
      id: s.id,
      patch: { orderIds: nextOrderIds, walletEntryIds: nextWalletEntryIds, ...summary },
      before: {
        codCop: s.data.codCop, driverPayCop: s.data.driverPayCop, netCop: s.data.netCop,
        cashExpectedCop: s.data.cashExpectedCop, cashPendingCop: s.data.cashPendingCop,
        orders: (s.data.orderIds ?? []).length,
      },
    });
  }

  if (apply) {
    const batch = db.batch();
    batch.set(ref, orderPatch, { merge: true });
    for (const w of wallet) batch.delete(db.collection("walletEntries").doc(w.id));
    for (const u of settlementUpdates) batch.set(u.ref, u.patch, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  return {
    id: target.id,
    trackingCode: order.trackingCode,
    applied: apply,
    orderPatch: { ...orderPatch, evidence: `${nextEvidence.length} evidencia(s) delivery->failed` },
    walletEntriesDeleted: wallet.map((w) => ({ id: w.id, type: w.type, amountCop: w.amountCop, settlementId: w.settlementId ?? null })),
    settlementUpdates: settlementUpdates.map((u) => ({
      id: u.id,
      before: u.before,
      after: {
        codCop: u.patch.codCop, driverPayCop: u.patch.driverPayCop, netCop: u.patch.netCop,
        cashExpectedCop: u.patch.cashExpectedCop, cashPendingCop: u.patch.cashPendingCop,
        orders: u.patch.orderIds.length,
      },
    })),
    auditId,
  };
}

(async () => {
  const results = [];
  for (const t of TARGETS) results.push(await processOrder(t));
  console.log(JSON.stringify({ apply, now, results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
