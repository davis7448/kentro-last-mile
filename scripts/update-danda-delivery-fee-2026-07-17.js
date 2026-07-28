#!/usr/bin/env node
/**
 * Ajusta a $13.500 el cobro por entrega de DANDA para pedidos ENTREGADOS desde
 * el 17-jul-2026 00:00 hora Colombia (sin importar su fecha de creacion).
 *
 * La fecha de entrega se toma de la evidencia de entrega del pedido (type
 * "delivery"); si no existe, del createdAt del asiento delivery_fee original
 * (que se crea en el mismo momento del cierre). Solo agrega la diferencia de
 * -$1.500 a pedidos entregados cuyo neto actual de delivery_fee sea -$12.000.
 * Es idempotente: omite los que ya estan en -$13.500 o ya tienen el ajuste.
 *
 * Uso: node scripts/update-danda-delivery-fee-2026-07-17.js          (dry-run)
 *      node scripts/update-danda-delivery-fee-2026-07-17.js --apply   (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");
const sellerId = "seller-1779315416119";
const cutoff = Date.parse("2026-07-17T05:00:00.000Z"); // 17-jul 00:00 hora Colombia
const desiredFeeCop = -13500;
const previousFeeCop = -12000;

function deliveryTimestamp(order, baseEntry) {
  const evidence = Array.isArray(order.evidence) ? order.evidence : [];
  const deliveryEv = [...evidence].reverse().find((e) => e.type === "delivery");
  const evAt = deliveryEv ? Date.parse(String(deliveryEv.createdAt ?? "")) : Number.NaN;
  if (Number.isFinite(evAt)) return evAt;
  return Date.parse(String(baseEntry?.createdAt ?? order.updatedAt ?? ""));
}

(async () => {
  const [ordersSnap, walletSnap] = await Promise.all([
    db.collection("orders").where("sellerId", "==", sellerId).get(),
    db.collection("walletEntries").where("ownerType", "==", "seller").where("ownerId", "==", sellerId).get()
  ]);
  const orderById = new Map(ordersSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const feesByOrder = new Map();
  for (const doc of walletSnap.docs) {
    const entry = { id: doc.id, ...doc.data() };
    if (entry.type !== "delivery_fee" || !entry.orderId) continue;
    const entries = feesByOrder.get(entry.orderId) ?? [];
    entries.push(entry);
    feesByOrder.set(entry.orderId, entries);
  }

  const adjustments = [];
  const skipped = [];
  for (const [orderId, entries] of feesByOrder) {
    const order = orderById.get(orderId);
    if (!order || order.status !== "delivered") continue;
    const netFeeCop = Math.round(entries.reduce((sum, e) => sum + Number(e.amountCop || 0), 0));
    const adjustmentId = `we-${orderId}-danda-fee-2026-07-17-adjustment`;
    if (netFeeCop === desiredFeeCop || entries.some((e) => e.id === adjustmentId)) {
      continue; // ya ajustado, sin ruido
    }
    if (netFeeCop !== previousFeeCop) {
      skipped.push({ trackingCode: order.trackingCode ?? orderId, reason: "neto inesperado; requiere revision", netFeeCop });
      continue;
    }
    const baseEntry = entries.find((e) => !e.id.includes("adjustment")) ?? entries[0];
    const deliveredAt = deliveryTimestamp(order, baseEntry);
    if (!(Number.isFinite(deliveredAt) && deliveredAt >= cutoff)) {
      continue; // entregado antes del 17-jul -> conserva $12.000
    }
    adjustments.push({
      id: adjustmentId,
      ownerType: "seller",
      ownerId: sellerId,
      orderId,
      type: "delivery_fee",
      amountCop: desiredFeeCop - previousFeeCop, // -1500
      description: `Ajuste tarifa DANDA (entregado desde 17/07/2026) ${order.shopifyOrderId ?? order.trackingCode ?? orderId}`,
      createdAt: new Date().toISOString(),
      trackingCode: order.trackingCode ?? orderId
    });
  }

  if (apply && adjustments.length > 0) {
    for (let start = 0; start < adjustments.length; start += 200) {
      const batch = db.batch();
      for (const adjustment of adjustments.slice(start, start + 200)) {
        const { trackingCode, ...entry } = adjustment;
        batch.create(db.collection("walletEntries").doc(entry.id), entry);
        const auditId = `audit-${entry.id}`;
        batch.create(db.collection("auditEvents").doc(auditId), {
          id: auditId,
          actorId: "script:update-danda-delivery-fee-2026-07-17",
          actorRole: "admin",
          action: "wallet.danda_delivery_fee_adjusted",
          entity: "order",
          entityId: entry.orderId,
          summary: `${trackingCode}: ajuste de tarifa DANDA por $1.500 (entregado desde 17/07/2026)`,
          createdAt: entry.createdAt
        });
      }
      await batch.commit();
    }
  }

  console.log(JSON.stringify({
    apply,
    cutoff: new Date(cutoff).toISOString(),
    totalAdjustments: adjustments.length,
    totalAdjustedCop: adjustments.length * 1500,
    adjustments: adjustments.map(({ trackingCode, orderId, amountCop }) => ({ trackingCode, orderId, amountCop })),
    skipped
  }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
