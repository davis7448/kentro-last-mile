#!/usr/bin/env node
/**
 * Corrige asientos product_cost que quedaron en CERO aunque el catalogo de la tienda
 * si tiene un costo configurado para ese producto.
 *
 * Causa: al guardar un producto nuevo en el catalogo SIN costo, el backfill creaba el
 * asiento en 0; cuando despues se guardaba el costo real, el dedupe de
 * buildMissingProductCostEntries lo consideraba "ya cobrado" y no lo corregia nunca.
 * El codigo ya esta arreglado (no crea asientos en 0 y los de 0 no bloquean el
 * backfill); este script repara los que quedaron mal antes del arreglo.
 *
 * Solo toca asientos SIN liquidar: si el pedido ya entro en una liquidacion de tienda,
 * lo reporta y lo omite (cambiarlo alteraria un corte ya cerrado).
 *
 * Uso: node scripts/fix-zero-product-costs.js            (dry-run)
 *      node scripts/fix-zero-product-costs.js --apply     (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

(async () => {
  const [weSnap, catSnap, ordSnap, setSnap] = await Promise.all([
    db.collection("walletEntries").where("ownerType", "==", "seller").get(),
    db.collection("productCatalog").get(),
    db.collection("orders").get(),
    db.collection("settlements").get()
  ]);
  const orderById = new Map(ordSnap.docs.map((doc) => [doc.id, doc.data()]));
  const catalog = catSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const settledEntryIds = new Set();
  for (const doc of setSnap.docs) {
    const settlement = doc.data();
    if (settlement.kind !== "seller") continue;
    for (const entryId of settlement.walletEntryIds ?? []) settledEntryIds.add(entryId);
  }

  const fixes = [];
  const blocked = [];
  for (const doc of weSnap.docs) {
    const entry = { id: doc.id, ...doc.data() };
    if (entry.type !== "product_cost" || Number(entry.amountCop || 0) !== 0) continue;
    const order = orderById.get(entry.orderId);
    if (!order) continue;

    // Match por sku y, si no hay, por nombre normalizado (igual que findCatalogMatch).
    const product = catalog.find((item) =>
      item.sellerId === order.sellerId &&
      Number(item.productCostCop || 0) > 0 &&
      ((item.sku && order.sku && String(item.sku) === String(order.sku)) ||
        (item.normalizedProductName && normalizeName(order.productName) === item.normalizedProductName))
    );
    if (!product) continue; // sin costo configurado: el 0 es correcto

    const quantity = Math.max(1, Number(order.quantity) || 1);
    const amountCop = -Number(product.productCostCop) * quantity;
    const row = {
      entryId: entry.id,
      trackingCode: order.trackingCode ?? entry.orderId,
      sku: order.sku ?? null,
      unitCostCop: Number(product.productCostCop),
      quantity,
      amountCop
    };
    if (settledEntryIds.has(entry.id)) {
      blocked.push({ ...row, reason: "ya incluido en una liquidacion de tienda" });
      continue;
    }
    fixes.push({ ...row, ref: doc.ref, product });
  }

  if (apply && fixes.length > 0) {
    const batch = db.batch();
    for (const fix of fixes) {
      batch.set(fix.ref, {
        amountCop: fix.amountCop,
        supplierId: fix.product.supplierId,
        productId: fix.product.id,
        productName: fix.product.name,
        updatedAt: now
      }, { merge: true });
      const auditId = `audit-fix-product-cost-${Date.now()}-${fix.entryId.slice(-10)}`;
      batch.set(db.collection("auditEvents").doc(auditId), {
        id: auditId,
        actorId: "script:fix-zero-product-costs",
        actorRole: "admin",
        action: "wallet.product_cost_corrected",
        entity: "order",
        entityId: fix.ref.id,
        summary: `${fix.trackingCode}: costo de producto corregido de $0 a ${fix.amountCop} (${fix.quantity} x ${fix.unitCostCop})`,
        createdAt: now
      });
    }
    await batch.commit();
  }

  console.log(JSON.stringify({
    apply,
    corregidos: fixes.map(({ ref, product, ...rest }) => rest),
    totalCop: fixes.reduce((sum, fix) => sum + fix.amountCop, 0),
    bloqueadosPorLiquidacion: blocked
  }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
