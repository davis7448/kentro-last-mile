#!/usr/bin/env node
// Divide entradas de productCatalog con SKU combinado ("A + B") en una entrada por SKU
// individual y desactiva la combinada. El backend cobra costo por lineItem/SKU individual,
// asi que las combinadas nunca matchean. Dry-run por defecto; escribir con --apply.
const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");

function normalizeProductName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function lineItemNamesBySku(sellerId) {
  const bySku = new Map();
  const orders = await db.collection("orders").where("sellerId", "==", sellerId).get();
  for (const doc of orders.docs) {
    const lineItems = Array.isArray(doc.data().lineItems) ? doc.data().lineItems : [];
    for (const line of lineItems) {
      const sku = String(line.sku ?? "").trim().toUpperCase();
      const name = String(line.productName ?? "").trim();
      if (sku && name && !bySku.has(sku)) bySku.set(sku, name);
    }
  }
  return bySku;
}

(async () => {
  const catalog = await db.collection("productCatalog").get();
  const combined = catalog.docs.filter((doc) => String(doc.data().sku ?? "").includes(" + "));
  console.log(`Entradas combinadas encontradas: ${combined.length}`);
  const existingBySellerSku = new Set(
    catalog.docs
      .filter((doc) => doc.data().active !== false && doc.data().sku)
      .map((doc) => `${doc.data().sellerId}::${String(doc.data().sku).trim().toUpperCase()}`)
  );

  let sequence = Date.now();
  for (const doc of combined) {
    const item = doc.data();
    console.log(`\n${doc.id} | ${item.sellerId} | sku "${item.sku}" | costo ${item.productCostCop} | configurado ${item.productCostConfigured}`);
    if (item.active === false) {
      console.log("  ya inactiva — se omite");
      continue;
    }
    const namesBySku = await lineItemNamesBySku(item.sellerId);
    const skus = String(item.sku).split(" + ").map((sku) => sku.trim().toUpperCase()).filter(Boolean);
    // Danda tiene todo el catalogo en costo 0 configurado; el resto queda pendiente de
    // configurar desde la UI (decision del usuario: el asigna cada costo por SKU).
    const keepZeroConfigured = Number(item.productCostCop) === 0 && item.productCostConfigured === true;
    for (const sku of skus) {
      if (existingBySellerSku.has(`${item.sellerId}::${sku}`)) {
        console.log(`  sku ${sku}: ya existe entrada individual — se omite`);
        continue;
      }
      const name = namesBySku.get(sku) ?? sku;
      if (!namesBySku.get(sku)) console.log(`  sku ${sku}: sin nombre en lineItems, name = sku (editar a mano luego)`);
      const now = new Date().toISOString();
      const newItem = {
        id: `prd-${sequence++}`,
        sellerId: item.sellerId,
        supplierId: item.supplierId,
        sku,
        name,
        normalizedProductName: normalizeProductName(name),
        productCostCop: 0,
        productCostConfigured: keepZeroConfigured,
        active: true,
        createdAt: now,
        updatedAt: now
      };
      console.log(`  crear ${newItem.id}: sku ${sku} | "${name}" | costo 0 ${keepZeroConfigured ? "(configurado)" : "(PENDIENTE de configurar en la UI)"}`);
      if (apply) await db.collection("productCatalog").doc(newItem.id).set(newItem);
      existingBySellerSku.add(`${item.sellerId}::${sku}`);
    }
    console.log(`  desactivar entrada combinada ${doc.id}`);
    if (apply) await doc.ref.set({ active: false, updatedAt: new Date().toISOString() }, { merge: true });
  }
  console.log(apply ? "\nAplicado." : "\nDry-run (nada escrito). Ejecuta con --apply para escribir.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
