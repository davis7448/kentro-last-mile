#!/usr/bin/env node
/**
 * Corrección manual delivered -> failed CON COBRO para tiendas que sí facturan el
 * fallido con visita (a diferencia de correct-delivered-to-failed.js, pensado para
 * Danda, donde un fallido genera 0 asientos).
 *
 * Estado final que deja el pedido, idéntico al que habría producido closeOrder si
 * el domiciliario lo hubiera cerrado como fallido desde el principio:
 *   - order.status = "failed" + failedCategory/failedReason, evidencia delivery -> failed
 *   - se eliminan los asientos de la entrega: cod_revenue, delivery_fee, product_cost
 *   - el pago al domiciliario se reemplaza por su equivalente de fallido
 *     (we-<id>-driver-delivery-pay -> we-<id>-driver-failed-pay), conservando el
 *     monto y la pertenencia al corte: la visita se hizo y se paga igual
 *   - se crea we-<id>-seller-failed-fee con el cobro del fallido a la tienda
 *   - el corte del domiciliario se recalcula (el COD de este pedido desaparece)
 *
 * ABORTA si el corte del domiciliario no está "pending": si ya se pagó, el dinero
 * salió y la corrección exige un clawback vía cod_remittance, fuera de este script.
 *
 * Uso:  node scripts/correct-delivered-to-chargeable-failed.js            (dry-run)
 *       node scripts/correct-delivered-to-chargeable-failed.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();
const f = (n) => Math.round(Number(n || 0)).toLocaleString("es-CO");

const TARGETS = [
  {
    id: "shopify-7432531902753", // KNT-002929 - Bella Mujer
    failedCategory: "failed_visit",
    sellerFailedFeeCop: 12000,
    failedReason: "Corrección manual: fallido con visita (se cerró como entregado por error)",
  },
];

// Réplica de calculateDriverCashSummary (functions/src/orders.ts): deriva el resumen
// financiero de un corte de driver desde los walletEntries vivos.
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

  const weSnap = await db.collection("walletEntries").where("orderId", "==", target.id).get();
  const wallet = weSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const driverPay = wallet.find((w) => w.type === "driver_earning");
  if (!driverPay) return { id: target.id, trackingCode: order.trackingCode, aborted: "sin asiento driver_earning" };

  // El número de pedido va en la descripción ("... #181238"), se reusa tal cual.
  const orderNumber = String(driverPay.description || "").split("#")[1]?.trim() || order.trackingCode;

  // Solo se puede tocar un corte que aún no se ha pagado.
  const settlementId = driverPay.settlementId;
  let settlement = null;
  if (settlementId) {
    const snap = await db.collection("settlements").doc(settlementId).get();
    if (!snap.exists) return { id: target.id, trackingCode: order.trackingCode, aborted: `settlement ${settlementId} no existe` };
    if (snap.data().status !== "pending") {
      return { id: target.id, trackingCode: order.trackingCode, aborted: `corte ${settlementId} en status "${snap.data().status}" (dinero entregado); requiere clawback manual` };
    }
    settlement = { id: settlementId, ref: snap.ref, data: snap.data() };
  }

  const evidence = Array.isArray(order.evidence) ? order.evidence : [];
  const previousNotes = evidence.map((e) => e.note).filter(Boolean).join(" | ");
  const nextEvidence = evidence.map((e) => ({
    ...e,
    type: "failed",
    failedCategory: target.failedCategory,
    reason: e.reason ?? e.note ?? "fallido con visita",
  }));

  const orderPatch = {
    status: "failed",
    failedCategory: target.failedCategory,
    failedCategorySource: "manual_correction",
    failedReason: `${target.failedReason}${previousNotes ? ` (evidencia previa: "${previousNotes}")` : ""}`,
    evidence: nextEvidence,
    updatedAt: now,
  };

  // Asientos de la entrega que desaparecen, incluido el pago "entregado" del driver.
  const toDelete = wallet.filter((w) => ["cod_revenue", "delivery_fee", "product_cost"].includes(w.type) || w.id === driverPay.id);

  const failedPayId = `we-${target.id}-driver-failed-pay`;
  const failedFeeId = `we-${target.id}-seller-failed-fee`;
  const toCreate = [
    {
      id: failedPayId,
      ownerType: "driver",
      ownerId: driverPay.ownerId,
      orderId: target.id,
      type: "driver_earning",
      amountCop: Math.round(Number(driverPay.amountCop || 0)),
      description: `Pago transportista fallido #${orderNumber}`,
      createdAt: driverPay.createdAt ?? now,
      ...(settlementId ? { settlementId } : {}),
    },
    {
      id: failedFeeId,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: target.id,
      type: "failed_fee",
      amountCop: -Math.abs(Math.round(target.sellerFailedFeeCop)),
      description: `Cobro fallido #${orderNumber}`,
      createdAt: now,
    },
  ];

  let settlementUpdate = null;
  if (settlement) {
    const nextWalletEntryIds = [
      ...(settlement.data.walletEntryIds ?? []).filter((wid) => wid !== driverPay.id),
      failedPayId,
    ];
    // Se recalcula DESPUÉS de aplicar los cambios de wallet, así que en dry-run se
    // simula restando el COD del pedido corregido.
    settlementUpdate = { ref: settlement.ref, id: settlement.id, nextWalletEntryIds, before: settlement.data };
  }

  if (apply) {
    const batch = db.batch();
    batch.set(ref, orderPatch, { merge: true });
    for (const w of toDelete) batch.delete(db.collection("walletEntries").doc(w.id));
    for (const e of toCreate) batch.set(db.collection("walletEntries").doc(e.id), e);
    await batch.commit();

    if (settlementUpdate) {
      const summary = await recomputeDriverSettlement(
        settlementUpdate.before,
        Number(settlementUpdate.before.cashReceivedCop || 0)
      );
      await settlementUpdate.ref.set({ walletEntryIds: settlementUpdate.nextWalletEntryIds, ...summary }, { merge: true });
      settlementUpdate.after = summary;
    }

    const auditId = `audit-correct-chargeable-failed-${Date.now()}-${target.id.slice(-8)}`;
    await db.collection("auditEvents").doc(auditId).set({
      id: auditId,
      actorId: "script:correct-delivered-to-chargeable-failed",
      actorRole: "admin",
      action: "order.correct_delivered_to_chargeable_failed",
      entity: "order",
      entityId: target.id,
      summary: `Corrección manual delivered -> failed (${target.failedCategory}) en ${order.trackingCode}: eliminados ${toDelete.length} asientos de entrega, creado cobro de fallido ${f(target.sellerFailedFeeCop)} y pago de fallido al domiciliario${settlementUpdate ? `; corte ${settlementUpdate.id} recalculado` : ""}`,
      createdAt: now,
    });
  }

  return {
    id: target.id,
    trackingCode: order.trackingCode,
    applied: apply,
    eliminados: toDelete.map((w) => ({ id: w.id, type: w.type, amountCop: w.amountCop })),
    creados: toCreate.map((e) => ({ id: e.id, type: e.type, amountCop: e.amountCop })),
    corte: settlementUpdate
      ? {
          id: settlementUpdate.id,
          antes: {
            codCop: settlementUpdate.before.codCop,
            cashExpectedCop: settlementUpdate.before.cashExpectedCop,
            cashPendingCop: settlementUpdate.before.cashPendingCop,
          },
          despues: settlementUpdate.after ?? "(dry-run: se recalcula al aplicar)",
        }
      : null,
  };
}

(async () => {
  const results = [];
  for (const target of TARGETS) results.push(await processOrder(target));
  console.log(JSON.stringify(results, null, 2));
  console.log(apply ? "\n>>> APLICADO" : "\n>>> DRY-RUN (usar --apply para escribir)");
  process.exit(0);
})();
