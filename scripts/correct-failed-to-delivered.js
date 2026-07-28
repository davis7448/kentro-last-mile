#!/usr/bin/env node
/**
 * Corrección manual failed -> delivered para pedidos cuya evidencia real es una entrega.
 *
 * No existe callable oficial para esta transición (failed es terminal y closeOrder
 * solo opera estados activos). Espejo de scripts/correct-delivered-to-failed.js:
 *   1. cambia order.status a "delivered", elimina failedReason/failedCategory/
 *      failedCategorySource/retryDecision y actualiza updatedAt,
 *   2. convierte la evidencia mal etiquetada "failed" -> "delivery",
 *   3. crea los asientos de wallet que closeOrder(outcome=delivered) habría escrito,
 *      replicando buildWalletEntries (functions/src/orders.ts): cod_revenue (si COD),
 *      delivery_fee del seller, driver_earning y product_cost por línea de catálogo.
 *      Respeta las reglas Danda (fee 12.000/13.500 según createdAt vs corte
 *      2026-07-17T05:00Z; pago driver 11.000 si es el driver preferido con
 *      pickedUpAt >= 2026-06-09T05:00Z) y fulfillment_fee solo en modo warehouse.
 *   4. ABORTA si el pedido ya tiene asientos de wallet (evita duplicar dinero) o si
 *      el fallido había generado asientos liquidados (requiere revisión manual).
 *   5. escribe un auditEvents documentando el cambio.
 *
 * Inventario: el cierre fallido ya descontó reserved; una entrega descuenta además
 * available. Si existe doc de inventario para (sellerId, sku) se ajusta available -1.
 *
 * Uso:  node scripts/correct-failed-to-delivered.js            (dry-run)
 *       node scripts/correct-failed-to-delivered.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

// Pedidos a corregir (docId).
const TARGETS = [
  { id: "shopify-6710942531697" }, // KNT-002178
];

// Constantes replicadas de functions/src/orders.ts
const defaultSettings = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 9000,
};
const tariffFields = Object.keys(defaultSettings);
const dandaSellerIds = new Set(["seller-1779315416119"]);
const dandaPreferredDriverId = "driver-1778271901513";
const dandaDriverPayCutoff = Date.parse("2026-06-09T05:00:00.000Z");
const dandaSellerFeeCutoff = Date.parse("2026-07-17T05:00:00.000Z");

function dandaDeliveredFeeCop(order) {
  const createdAt = typeof order.createdAt === "string" ? Date.parse(order.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) && createdAt >= dandaSellerFeeCutoff ? 13500 : 12000;
}

function resolveTariffs(settings, zone) {
  const values = {};
  for (const field of tariffFields) {
    const zoneValue = Number(zone?.[field]);
    const settingValue = Number(settings[field]);
    const fallbackValue = Number(defaultSettings[field]);
    values[field] = Number.isFinite(zoneValue) && zoneValue > 0 ? zoneValue : Number.isFinite(settingValue) && settingValue > 0 ? settingValue : fallbackValue;
  }
  return values;
}

function normalizeProductName(value) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchCatalogForLine(catalog, sellerId, options) {
  const normalizedSku = typeof options.sku === "string" ? options.sku.trim().toUpperCase() : "";
  const normalizedName = normalizeProductName(typeof options.productName === "string" ? options.productName : "");
  const byId = options.productId
    ? catalog.find((item) => item.id === options.productId && item.sellerId === sellerId && item.active !== false)
    : undefined;
  const bySku = normalizedSku
    ? catalog.find((item) => item.sellerId === sellerId && item.active !== false && typeof item.sku === "string" && item.sku.trim().toUpperCase() === normalizedSku)
    : undefined;
  const byName = normalizedName
    ? catalog.find((item) => item.sellerId === sellerId && item.active !== false && !item.sku && item.normalizedProductName === normalizedName)
    : undefined;
  return byId ?? bySku ?? byName ?? null;
}

function resolveProductCostLinesForOrder(order, catalog) {
  const sellerId = String(order.sellerId ?? "");
  if (!sellerId) return [];
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const hasLineItems = lineItems.length > 0;
  const rawLines = hasLineItems
    ? lineItems
    : [{ sku: order.sku, productName: order.productName, quantity: order.quantity }];
  const byProduct = new Map();
  for (const line of rawLines) {
    const quantity = Math.max(1, Number(line?.quantity) || 1);
    const product = matchCatalogForLine(catalog, sellerId, {
      sku: typeof line?.sku === "string" ? line.sku : undefined,
      productName: typeof line?.productName === "string" ? line.productName : undefined,
      productId: hasLineItems ? undefined : (typeof order.productId === "string" ? order.productId : undefined),
    });
    if (!product || product.productCostConfigured !== true) continue;
    const existing = byProduct.get(product.id);
    if (existing) existing.quantity += quantity;
    else byProduct.set(product.id, { product, quantity });
  }
  return Array.from(byProduct.values()).map(({ product, quantity }) => ({
    productId: String(product.id ?? ""),
    productName: String(product.name ?? "Producto"),
    supplierId: typeof product.supplierId === "string" ? product.supplierId : undefined,
    supplierName: typeof product.supplierName === "string" ? product.supplierName : undefined,
    totalCostCop: Math.max(0, Number(product.productCostCop) || 0) * quantity,
  }));
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

// Réplica de buildWalletEntries para el caso delivered (functions/src/orders.ts).
function buildDeliveredWalletEntries(order, settings, productCostLines) {
  const pickedUpAt = typeof order.pickedUpAt === "string" ? Date.parse(order.pickedUpAt) : Number.NaN;
  const usesNewDandaDriverPay =
    String(order.driverId ?? "") === dandaPreferredDriverId &&
    Number.isFinite(pickedUpAt) &&
    pickedUpAt >= dandaDriverPayCutoff;
  const values = dandaSellerIds.has(String(order.sellerId ?? ""))
    ? {
        ...defaultSettings,
        ...settings,
        sellerDeliveredFeeCop: dandaDeliveredFeeCop(order),
        driverDeliveredPayCop: usesNewDandaDriverPay ? 11000 : 10000,
      }
    : { ...defaultSettings, ...settings };
  const entries = [];

  if (order.paymentMethod === "cod") {
    entries.push({
      id: `we-${order.id}-cod`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "cod_revenue",
      amountCop: Number(order.totalCop) || 0,
      description: `Recaudo COD pedido ${order.shopifyOrderId}`,
      createdAt: now,
    });
  }
  entries.push({
    id: `we-${order.id}-seller-delivery-fee`,
    ownerType: "seller",
    ownerId: order.sellerId,
    orderId: order.id,
    type: "delivery_fee",
    amountCop: -Number(values.sellerDeliveredFeeCop),
    description: `Flete entregado ${order.shopifyOrderId}`,
    createdAt: now,
  });
  entries.push({
    id: `we-${order.id}-driver-delivery-pay`,
    ownerType: "driver",
    ownerId: order.driverId ?? "unassigned",
    orderId: order.id,
    type: "driver_earning",
    amountCop: Number(values.driverDeliveredPayCop),
    description: `Pago transportista entregado ${order.shopifyOrderId}`,
    createdAt: now,
  });
  const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
  for (const line of productCostLines ?? []) {
    entries.push(stripUndefined({
      id: hasLineItems ? `we-${order.id}-product-cost-${line.productId}` : `we-${order.id}-product-cost`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "product_cost",
      amountCop: -line.totalCostCop,
      description: `Costo producto ${order.shopifyOrderId}`,
      supplierId: line.supplierId,
      supplierName: line.supplierName,
      productId: line.productId || undefined,
      productName: line.productName,
      createdAt: now,
    }));
  }
  if (order.fulfillmentMode === "warehouse") {
    entries.push({
      id: `we-${order.id}-fulfillment-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "fulfillment_fee",
      amountCop: -Number(values.fulfillmentFeeCop),
      description: `Fulfillment desde bodega ${order.shopifyOrderId}`,
      createdAt: now,
    });
  }
  return entries;
}

async function processOrder(target) {
  const ref = db.collection("orders").doc(target.id);
  const doc = await ref.get();
  if (!doc.exists) return { id: target.id, skipped: "no existe" };
  const order = { id: doc.id, ...doc.data() };

  if (order.status !== "failed") {
    return { id: target.id, trackingCode: order.trackingCode, skipped: `status actual "${order.status}" != failed` };
  }

  // Seguridad: si el fallido dejó asientos (p. ej. failed_fee de seller no Danda),
  // este script no sabe reversarlos; revisar a mano antes de duplicar dinero.
  const weSnap = await db.collection("walletEntries").where("orderId", "==", target.id).get();
  if (!weSnap.empty) {
    return {
      id: target.id,
      trackingCode: order.trackingCode,
      aborted: `el pedido ya tiene ${weSnap.size} asiento(s) de wallet; reversar/revisar manualmente antes de corregir`,
      existing: weSnap.docs.map((d) => ({ id: d.id, type: d.data().type, amountCop: d.data().amountCop, settlementId: d.data().settlementId ?? null })),
    };
  }

  const [settingsSnap, zoneSnap, catalogSnap] = await Promise.all([
    db.doc("settings/global").get(),
    typeof order.zoneId === "string" && order.zoneId ? db.collection("zones").doc(order.zoneId).get() : Promise.resolve(null),
    order.sellerId ? db.collection("productCatalog").where("sellerId", "==", order.sellerId).get() : Promise.resolve(null),
  ]);
  const sellerCatalog = catalogSnap ? catalogSnap.docs.map((c) => ({ id: c.id, ...c.data() })) : [];
  const tariffs = resolveTariffs(settingsSnap.data() ?? {}, zoneSnap?.exists ? zoneSnap.data() : undefined);
  const productCostLines = resolveProductCostLinesForOrder(order, sellerCatalog);
  const walletEntries = buildDeliveredWalletEntries(order, tariffs, productCostLines);

  // Evidencia que documenta la entrega (mal etiquetada como failed).
  const evidence = Array.isArray(order.evidence) ? order.evidence : [];
  const nextEvidence = evidence.map((e) => {
    const { reason, failedCategory, ...rest } = e;
    return {
      ...rest,
      type: "delivery",
      note: `Corrección manual: pedido entregado${e.note ? ` (evidencia previa: "${e.note}")` : ""}`,
    };
  });

  // Inventario: la entrega descuenta available (reserved ya fue liberado en el fallido).
  let inventoryUpdate = null;
  if (typeof order.sku === "string" && typeof order.sellerId === "string") {
    const invSnap = await db.collection("inventory").where("sellerId", "==", order.sellerId).where("sku", "==", order.sku).limit(1).get();
    if (!invSnap.empty) {
      const inv = invSnap.docs[0];
      const available = Number(inv.data().available) || 0;
      inventoryUpdate = { ref: inv.ref, id: inv.id, before: available, after: Math.max(0, available - 1) };
    }
  }

  const orderPatch = {
    status: "delivered",
    failedReason: FieldValue.delete(),
    failedCategory: FieldValue.delete(),
    failedCategorySource: FieldValue.delete(),
    failedCategoryConfidence: FieldValue.delete(),
    retryDecision: FieldValue.delete(),
    evidence: nextEvidence,
    updatedAt: now,
  };

  const auditId = `audit-correct-delivered-${Date.now()}-${target.id.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:correct-failed-to-delivered",
    actorRole: "admin",
    action: "order.correct_failed_to_delivered",
    entity: "order",
    entityId: target.id,
    summary: `Corrección manual failed -> delivered; creados ${walletEntries.length} asientos de wallet como los habría escrito closeOrder${inventoryUpdate ? "; inventario available -1" : ""}`,
    createdAt: now,
  };

  if (apply) {
    const batch = db.batch();
    batch.set(ref, orderPatch, { merge: true });
    for (const entry of walletEntries) batch.create(db.collection("walletEntries").doc(entry.id), entry);
    if (inventoryUpdate) batch.set(inventoryUpdate.ref, { available: inventoryUpdate.after, updatedAt: now }, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  return {
    id: target.id,
    trackingCode: order.trackingCode,
    applied: apply,
    orderPatch: { status: "delivered", removedFields: ["failedReason", "failedCategory", "failedCategorySource", "failedCategoryConfidence", "retryDecision"], evidence: `${nextEvidence.length} evidencia(s) failed->delivery` },
    walletEntriesCreated: walletEntries.map((w) => ({ id: w.id, type: w.type, amountCop: w.amountCop, ownerType: w.ownerType, ownerId: w.ownerId })),
    inventoryUpdate: inventoryUpdate ? { id: inventoryUpdate.id, available: `${inventoryUpdate.before} -> ${inventoryUpdate.after}` } : "sin doc de inventario (no-op)",
    auditId,
  };
}

(async () => {
  const results = [];
  for (const t of TARGETS) results.push(await processOrder(t));
  console.log(JSON.stringify({ apply, now, results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
