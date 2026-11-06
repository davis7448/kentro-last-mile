#!/usr/bin/env node
/**
 * Spec 036 · T2 — lee la API de tiendas de produccion como la lee la tienda (GET con su key de lectura) y
 * dice si `/resumen`, `/orders` y el indice traen el aviso de pago, y las cifras de `/resumen`.
 * Solo lectura: la key se toma de `storeApiConfigs/{sellerId}.apiKey` y NUNCA se imprime.
 *
 * Uso: node scripts/verify-036.js [sellerId]   (por defecto, DANDA)
 * Correrlo antes y despues de desplegar `storeApi`: las cifras deben ser las mismas (RNF_01).
 */
const path = require("node:path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

const BASE = "https://us-central1-kentro-last-mile.cloudfunctions.net/storeApi";
const sellerId = process.argv[2] || "seller-1779315416119";

async function get(resource, key, query = "") {
  const res = await fetch(`${BASE}/${resource}?sellerId=${encodeURIComponent(sellerId)}${query}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const config = (await admin.firestore().collection("storeApiConfigs").doc(sellerId).get()).data();
  if (!config || typeof config.apiKey !== "string") throw new Error(`sin key de lectura para ${sellerId}`);
  const key = config.apiKey;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });

  const resumen = await get("resumen", key);
  const orders = await get("orders", key, `&from=${today}&to=${today}&limit=1`);
  const docs = await get("docs", key);

  const fechas = (avisos) => (Array.isArray(avisos) ? avisos.map((a) => a.fecha).join(", ") : "ninguno");
  const s = resumen.body.saldoPendiente || {};
  console.log(`Tienda: ${resumen.body.tienda} (${sellerId}) · ${new Date().toISOString()}`);
  console.log(`/resumen  HTTP ${resumen.status} · avisos: ${fechas(resumen.body.avisos)}`);
  console.log(`  disponibleCop ${s.disponibleCop} · retenidoCop ${s.retenidoCop} · enLiquidacionCop ${s.enLiquidacionCop} · bloqueadoCodCop ${s.bloqueadoCodCop} · totalCop ${s.totalCop}`);
  console.log(`  significado.bloqueadoCodCop: ${resumen.body.significado?.bloqueadoCodCop}`);
  console.log(`/orders   HTTP ${orders.status} · avisos: ${fechas(orders.body.avisos)} · significado.pago: ${orders.body.significado?.pago ? Object.keys(orders.body.significado.pago).join(", ") : "no"}`);
  console.log(`/docs     HTTP ${docs.status} · avisos: ${fechas(docs.body.avisos)} · avisoDePago: ${docs.body.avisoDePago?.fecha ?? "no"}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
