#!/usr/bin/env node
/**
 * Repara los pedidos cuyos lineItems quedaron colapsados en UNA sola linea con el SKU
 * pegado ("A + B") y la cantidad sumada.
 *
 * Causa: updateImportedOrder / updateOrderAdjustments reconstruian las lineas desde los
 * campos planos del pedido. Para un pedido multi-linea eso fabricaba un SKU inexistente
 * y multiplicaba el costo por el total de unidades (ver resolveEditedOrderLines en
 * functions/src/orders.ts, ya corregido).
 *
 * La fuente de verdad es el payload original que la tienda envio, guardado en
 * storeWebhookSamples. El script:
 *   1. localiza el sample de cada pedido por su numero de Shopify (match exacto),
 *   2. reconstruye lineItems y los campos planos con la misma logica de summarizeItems
 *      (functions/src/store-webhook.ts), excluyendo "envio prioritario",
 *   3. recalcula los asientos product_cost por SKU individual contra el catalogo vivo,
 *      SOLO si el pedido esta entregado y el asiento no esta liquidado,
 *   4. audita cada reparacion.
 *
 * ABORTA por pedido si no encuentra el payload original o si el asiento ya esta liquidado.
 *
 * Uso:  node scripts/repair-collapsed-line-items.js            (dry-run)
 *       node scripts/repair-collapsed-line-items.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();
const f = (n) => Math.round(Number(n || 0)).toLocaleString("es-CO");

function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

// Replica de isShippingLineItem (store-webhook.ts).
function isShippingLineItem(item) {
  const text = [item.name, item.title, item.sku]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return /\benvio\b/.test(text) && /\bprioritario\b/.test(text);
}

// Replica de summarizeItems (store-webhook.ts).
function summarizeItems(items) {
  const productItems = items.filter((item) => !isShippingLineItem(item));
  const source = productItems.length > 0 ? productItems : items;
  const normalized = source.map((item) => {
    const baseName = cleanText(item.name) || cleanText(item.title) || "Producto Shopify";
    const variant = cleanText(item.variant_title);
    const properties = (item.properties ?? [])
      .map((p) => [cleanText(p.name), cleanText(p.value)].filter(Boolean).join(": "))
      .filter(Boolean);
    const nameParts = [baseName];
    if (variant && !baseName.toLowerCase().includes(variant.toLowerCase())) nameParts.push(variant);
    nameParts.push(...properties);
    return { name: nameParts.join(" | "), sku: cleanText(item.sku), quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1 };
  });
  const lineItems = normalized.map((item) => {
    const entry = { quantity: item.quantity, productName: item.name };
    if (item.sku) entry.sku = item.sku;
    return entry;
  });
  return {
    productName: normalized.map((item) => `${item.name} x${item.quantity}`).join(" + "),
    sku: normalized.map((item) => item.sku).filter(Boolean).join(" + ") || undefined,
    quantity: normalized.reduce((sum, item) => sum + item.quantity, 0),
    lineItems,
  };
}

function findCatalogMatch(catalog, sellerId, sku, productName) {
  const nSku = sku?.trim().toUpperCase();
  const nName = String(productName ?? "").trim().toLowerCase();
  return (
    (nSku ? catalog.find((c) => c.sellerId === sellerId && String(c.sku ?? "").trim().toUpperCase() === nSku && c.active !== false) : undefined) ??
    (nName ? catalog.find((c) => c.sellerId === sellerId && !c.sku && String(c.normalizedProductName ?? "").toLowerCase() === nName && c.active !== false) : undefined)
  );
}

(async () => {
  const [ordersSnap, samplesSnap, onstockSnap, catalogSnap, suppliersSnap] = await Promise.all([
    db.collection("orders").get(),
    db.collection("storeWebhookSamples").get(),
    db.collection("onstockWebhookSamples").get(),
    db.collection("productCatalog").get(),
    db.collection("suppliers").get(),
  ]);
  const catalog = catalogSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const suppliers = new Map(suppliersSnap.docs.map((d) => [d.id, d.data().name]));

  // Indice de payloads por numero de pedido de la tienda (match exacto, no substring).
  const payloadByNumber = new Map();
  for (const d of [...samplesSnap.docs, ...onstockSnap.docs]) {
    const v = d.data();
    const raw = v.payload ?? v.body ?? v.raw;
    const order = raw?.order ?? raw;
    const items = order?.line_items;
    if (!Array.isArray(items) || items.length === 0) continue;
    for (const key of [order?.name, order?.order_number, order?.id].filter((x) => x !== undefined && x !== null)) {
      const k = String(key).replace(/^#/, "");
      const prev = payloadByNumber.get(k);
      // Se prefiere el payload con MAS lineas: es el pedido completo, no un fragmento.
      if (!prev || items.length > prev.items.length) payloadByNumber.set(k, { items, sampleId: d.id, at: v.createdAt });
    }
  }

  const results = [];
  for (const doc of ordersSnap.docs) {
    const order = doc.data();
    const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
    // Dos formas del mismo dano: lineas con el SKU pegado, o pedidos sin lineas cuyo
    // campo plano `sku` quedo pegado (nunca llegaron a tener lineItems).
    const lineasPegadas = lines.some((l) => String(l.sku ?? "").includes(" + "));
    const planoPegado = lines.length === 0 && String(order.sku ?? "").includes(" + ");
    if (!lineasPegadas && !planoPegado) continue;

    const key = String(order.shopifyOrderId ?? "").replace(/^#/, "");
    const payload = payloadByNumber.get(key);
    if (!payload) {
      results.push({ tc: order.trackingCode, aborted: `sin payload original para #${key}` });
      continue;
    }

    const summary = summarizeItems(payload.items);
    if (summary.lineItems.length < 2) {
      results.push({ tc: order.trackingCode, skipped: "el payload original tambien trae una sola linea" });
      continue;
    }

    // Recalculo del costo por SKU individual.
    const byProduct = new Map();
    for (const line of summary.lineItems) {
      const product = findCatalogMatch(catalog, order.sellerId, line.sku, line.productName);
      if (!product || !product.productCostConfigured) continue;
      const unit = Math.max(0, Number(product.productCostCop) || 0);
      const prev = byProduct.get(product.id);
      if (prev) prev.quantity += line.quantity;
      else byProduct.set(product.id, { product, quantity: line.quantity, unit });
    }

    const existing = await db.collection("walletEntries").where("orderId", "==", doc.id).where("type", "==", "product_cost").get();
    const liquidados = existing.docs.filter((d) => d.data().settlementId);
    if (liquidados.length > 0) {
      results.push({ tc: order.trackingCode, aborted: `tiene ${liquidados.length} asiento(s) product_cost ya liquidados` });
      continue;
    }

    const nuevos = order.status === "delivered"
      ? Array.from(byProduct.values())
          .filter((x) => x.unit * x.quantity > 0)
          .map((x) => ({
            id: `we-${doc.id}-product-cost-${x.product.id}`,
            ownerType: "seller",
            ownerId: order.sellerId,
            orderId: doc.id,
            type: "product_cost",
            amountCop: -(x.unit * x.quantity),
            description: `Costo producto ${order.shopifyOrderId}`,
            supplierId: x.product.supplierId,
            supplierName: suppliers.get(x.product.supplierId),
            productId: x.product.id,
            productName: x.product.name,
            createdAt: now,
          }))
      : [];

    const antes = existing.docs.reduce((s, d) => s + Number(d.data().amountCop || 0), 0);
    const despues = nuevos.reduce((s, e) => s + e.amountCop, 0);

    if (apply) {
      const batch = db.batch();
      batch.set(doc.ref, {
        lineItems: summary.lineItems,
        productName: summary.productName,
        sku: summary.sku ?? admin.firestore.FieldValue.delete(),
        quantity: summary.quantity,
        updatedAt: now,
      }, { merge: true });
      for (const d of existing.docs) batch.delete(d.ref);
      for (const e of nuevos) batch.set(db.collection("walletEntries").doc(e.id), e);
      const auditId = `audit-repair-lines-${Date.now()}-${doc.id.slice(-8)}`;
      batch.set(db.collection("auditEvents").doc(auditId), {
        id: auditId,
        actorId: "script:repair-collapsed-line-items",
        actorRole: "admin",
        action: "order.line_items_repaired",
        entity: "order",
        entityId: doc.id,
        summary: `${order.trackingCode}: lineas reconstruidas desde el payload original (${summary.lineItems.length} lineas); costo de producto ${f(antes)} -> ${f(despues)}`,
        createdAt: now,
      });
      await batch.commit();
    }

    results.push({
      tc: order.trackingCode,
      status: order.status,
      skuAntes: lines[0]?.sku ?? order.sku,
      lineasNuevas: summary.lineItems.map((l) => `${l.quantity}x ${l.sku ?? "(sin sku)"}`),
      costoAntes: f(antes),
      costoDespues: f(despues),
      diferencia: f(despues - antes),
    });
  }

  console.log(JSON.stringify(results, null, 2));
  const conCambio = results.filter((r) => r.costoAntes !== undefined);
  console.log(`\nPedidos reparados: ${conCambio.length} | abortados: ${results.filter((r) => r.aborted).length} | omitidos: ${results.filter((r) => r.skipped).length}`);
  console.log(apply ? ">>> APLICADO" : ">>> DRY-RUN (usar --apply para escribir)");
  process.exit(0);
})();
