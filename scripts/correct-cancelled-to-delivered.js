#!/usr/bin/env node
/**
 * Correccion manual cancelled -> delivered para pedidos que la tienda anulo DESPUES
 * de que el domiciliario ya los habia entregado.
 *
 * No existe callable oficial para esta transicion: "cancelled" es terminal
 * (TERMINAL_STATUS en functions/src/orders.ts, applyOrderTransition lo rechaza) y
 * closeOrder solo opera estados activos. Espejo de
 * scripts/correct-failed-to-delivered.js, con dos diferencias: aqui el pedido nunca
 * llego a tener domiciliario ni evidencia, asi que ambos se CREAN (el driver real lo
 * indica el target), y el inventario nunca se movio.
 *
 *   1. cambia order.status a "delivered", asigna driverId, fija pickedUpAt (proxy:
 *      labelPrintedAt) y reemplaza el callNote de la anulacion,
 *   2. agrega una evidencia de tipo "delivery" que documenta la correccion,
 *   3. crea los asientos de wallet que closeOrder(outcome=delivered) habria escrito,
 *      replicando buildWalletEntries (functions/src/orders.ts): cod_revenue (si COD),
 *      delivery_fee del seller, driver_earning y product_cost por linea de catalogo.
 *      Respeta las reglas Danda (fee 12.000/13.500 segun fecha de entrega; pago driver
 *      11.000 si es el driver preferido con pickedUpAt >= 2026-06-09T05:00Z) y
 *      fulfillment_fee solo en modo warehouse.
 *   4. ABORTA si el pedido ya tiene asientos de wallet (evita duplicar dinero) o si el
 *      driver indicado no existe.
 *   5. escribe un auditEvents documentando el cambio.
 *
 * Inventario: la anulacion solo libero reserva si el pedido la tenia
 * (orderOwnsInventoryReservation => marcador inventoryReserved === true). Si la tenia,
 * la entrega descuenta available; si no la tenia, no hay nada que ajustar.
 *
 * Uso:  node scripts/correct-cancelled-to-delivered.js            (dry-run)
 *       node scripts/correct-cancelled-to-delivered.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

// Pedidos a corregir (docId + quien hizo realmente la entrega).
const TARGETS = [
  {
    id: "ord-knt-003595", // KNT-003595 - vive zen
    driverId: "driver-1778271901513",
    note: "Correccion manual: la tienda anulo el pedido despues de que el domiciliario ya lo habia entregado.",
  },
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

// La tarifa de 13.500 aplica por fecha de ENTREGA. Aqui la entrega se registra ahora.
function dandaDeliveredFeeCop(deliveredAtIso) {
  const deliveredAt = Date.parse(deliveredAtIso);
  return Number.isFinite(deliveredAt) && deliveredAt >= dandaSellerFeeCutoff ? 13500 : 12000;
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

/** Solo los pedidos que reservaron pueden liberar/descontar (functions/src/inventory-movements.ts). */
function orderOwnsInventoryReservation(order) {
  return order.inventoryReserved === true;
}

// Replica de buildWalletEntries para el caso delivered (functions/src/orders.ts).
function buildDeliveredWalletEntries(order, settings) {
  const pickedUpAt = typeof order.pickedUpAt === "string" ? Date.parse(order.pickedUpAt) : Number.NaN;
  const usesNewDandaDriverPay =
    String(order.driverId ?? "") === dandaPreferredDriverId &&
    Number.isFinite(pickedUpAt) &&
    pickedUpAt >= dandaDriverPayCutoff;
  const values = dandaSellerIds.has(String(order.sellerId ?? ""))
    ? {
        ...defaultSettings,
        ...settings,
        sellerDeliveredFeeCop: dandaDeliveredFeeCop(now),
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
  for (const line of order.productCostLines ?? []) {
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

  if (order.status !== "cancelled") {
    return { id: target.id, trackingCode: order.trackingCode, skipped: `status actual "${order.status}" != cancelled` };
  }

  // Seguridad: si la anulacion dejo asientos, este script no sabe reversarlos;
  // revisar a mano antes de duplicar dinero.
  const weSnap = await db.collection("walletEntries").where("orderId", "==", target.id).get();
  if (!weSnap.empty) {
    return {
      id: target.id,
      trackingCode: order.trackingCode,
      aborted: `el pedido ya tiene ${weSnap.size} asiento(s) de wallet; reversar/revisar manualmente antes de corregir`,
      existing: weSnap.docs.map((d) => ({ id: d.id, type: d.data().type, amountCop: d.data().amountCop, settlementId: d.data().settlementId ?? null })),
    };
  }

  const driverSnap = await db.collection("drivers").doc(target.driverId).get();
  if (!driverSnap.exists) {
    return { id: target.id, trackingCode: order.trackingCode, aborted: `el driver ${target.driverId} no existe` };
  }

  const [settingsSnap, zoneSnap, catalogSnap] = await Promise.all([
    db.doc("settings/global").get(),
    typeof order.zoneId === "string" && order.zoneId ? db.collection("zones").doc(order.zoneId).get() : Promise.resolve(null),
    order.sellerId ? db.collection("productCatalog").where("sellerId", "==", order.sellerId).get() : Promise.resolve(null),
  ]);
  const sellerCatalog = catalogSnap ? catalogSnap.docs.map((c) => ({ id: c.id, ...c.data() })) : [];
  const tariffs = resolveTariffs(settingsSnap.data() ?? {}, zoneSnap?.exists ? zoneSnap.data() : undefined);

  // El pedido entregado: los asientos se calculan sobre el estado FINAL (con driver
  // y pickedUpAt), igual que hace closeOrder con nextOrder.
  const pickedUpAt = typeof order.pickedUpAt === "string" && order.pickedUpAt
    ? order.pickedUpAt
    : (typeof order.labelPrintedAt === "string" ? order.labelPrintedAt : now);
  const productCostLines = resolveProductCostLinesForOrder(order, sellerCatalog);
  const deliveredOrder = { ...order, status: "delivered", driverId: target.driverId, pickedUpAt, productCostLines };
  const walletEntries = buildDeliveredWalletEntries(deliveredOrder, tariffs);

  // Evidencia que documenta la entrega (el pedido se anulo sin registrarla).
  const evidence = Array.isArray(order.evidence) ? order.evidence : [];
  const newEvidence = {
    id: `ev-correct-${Date.now()}`,
    type: "delivery",
    note: target.note,
    actorId: "script:correct-cancelled-to-delivered",
    createdAt: now,
  };
  const nextEvidence = [...evidence, newEvidence];

  // Inventario: solo si el pedido reservo (la anulacion habria liberado reserved,
  // y la entrega descuenta available).
  let inventoryUpdate = null;
  if (orderOwnsInventoryReservation(order) && typeof order.sku === "string" && typeof order.sellerId === "string") {
    const invSnap = await db.collection("inventory").where("sellerId", "==", order.sellerId).where("sku", "==", order.sku).limit(1).get();
    if (!invSnap.empty) {
      const inv = invSnap.docs[0];
      const available = Number(inv.data().available) || 0;
      inventoryUpdate = { ref: inv.ref, id: inv.id, before: available, after: Math.max(0, available - 1) };
    }
  }

  const orderPatch = {
    status: "delivered",
    driverId: target.driverId,
    pickedUpAt,
    evidence: nextEvidence,
    callNote: target.note,
    // El pedido deja de estar anulado: los rotulos de fallido no aplican (por si acaso).
    failedReason: FieldValue.delete(),
    failedCategory: FieldValue.delete(),
    failedCategorySource: FieldValue.delete(),
    failedCategoryConfidence: FieldValue.delete(),
    retryDecision: FieldValue.delete(),
    updatedAt: now,
  };

  const auditId = `audit-correct-cancelled-delivered-${Date.now()}-${target.id.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:correct-cancelled-to-delivered",
    actorRole: "admin",
    action: "order.correct_cancelled_to_delivered",
    entity: "order",
    entityId: target.id,
    fromStatus: "cancelled",
    toStatus: "delivered",
    summary: `La tienda anulo el pedido ${order.trackingCode ?? target.id} despues de que ya habia sido entregado; correccion manual cancelled -> delivered con driver ${target.driverId} y ${walletEntries.length} asiento(s) de wallet como los habria escrito closeOrder${inventoryUpdate ? "; inventario available -1" : ""}`,
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
    from: "cancelled",
    to: "delivered",
    driverId: `${order.driverId ?? "null"} -> ${target.driverId} (${driverSnap.data().name})`,
    pickedUpAt,
    evidenciaCreada: newEvidence,
    walletEntriesCreated: walletEntries.map((w) => ({ id: w.id, type: w.type, amountCop: w.amountCop, ownerType: w.ownerType, ownerId: w.ownerId })),
    netoSeller: walletEntries.filter((w) => w.ownerType === "seller").reduce((sum, w) => sum + w.amountCop, 0),
    inventoryUpdate: inventoryUpdate ? { id: inventoryUpdate.id, available: `${inventoryUpdate.before} -> ${inventoryUpdate.after}` } : "el pedido no reservo inventario (no-op)",
    auditId,
  };
}

(async () => {
  const results = [];
  for (const t of TARGETS) results.push(await processOrder(t));
  console.log(JSON.stringify({ apply, now, results }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
