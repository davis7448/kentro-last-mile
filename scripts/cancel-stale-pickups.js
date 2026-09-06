#!/usr/bin/env node
/**
 * Anula los pedidos que llevan dias parados en `ready_to_assign` porque la tienda
 * nunca los entrego al mensajero y ya no los va a despachar.
 *
 * Contexto: la bodega devolvio la planilla de "pendientes de recoger" del 25/08/2026 con el
 * estado real de cada paquete. Los que siguen en `ready_to_assign` con la marca SIN RECOGER
 * llevan entre 13 y 87 dias ocupando la cola de despacho y no van a salir nunca.
 *
 * Replica la transaccion del callable `cancelOrder` (functions/src/orders.ts):
 * status -> "cancelled", `callNote` con el motivo y un evento de auditoria "order.cancelled".
 * NO crea ni toca asientos de wallet: un pedido en `ready_to_assign` nunca genero ninguno.
 *
 * Dos cinturones de seguridad, porque esto se corre a mano sobre produccion:
 *  - Si el pedido no esta EXACTAMENTE en `ready_to_assign`, lo salta (alguien lo movio entre
 *    el analisis y la corrida).
 *  - Si el pedido tiene reserva de inventario, ABORTA en vez de anularlo. Liberar inventario
 *    es responsabilidad de `cancelOrder`, y aqui no se reimplementa a medias.
 *
 * Reversible: `correctOrderStatus` tiene la correccion `cancelled_to_operational`.
 *
 * Uso: node scripts/cancel-stale-pickups.js                 (dry-run, no escribe)
 *      node scripts/cancel-stale-pickups.js --apply         (anula)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");

/** Los 14 no-DANDA marcados SIN RECOGER por la bodega. KNT-002970 queda fuera a proposito:
 *  ese si salio, fallo la visita y ya tiene asientos de wallet; se decide aparte. */
const TARGETS = [
  "KNT-000271", "KNT-000939", "KNT-001238", "KNT-001270", "KNT-001266",
  "KNT-003126", "KNT-003159", "KNT-003156", "KNT-003177", "KNT-003257",
  "KNT-003296", "KNT-003326", "KNT-003368", "KNT-003461",
];

const REASON = "Anulado: la tienda nunca lo entrego para recogida y ya no lo despacha (planilla de bodega 25/08/2026).";
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CO");

(async () => {
  const found = new Map();
  for (let i = 0; i < TARGETS.length; i += 30) {
    const snap = await db.collection("orders").where("trackingCode", "in", TARGETS.slice(i, i + 30)).get();
    snap.forEach((d) => found.set(d.data().trackingCode, d));
  }

  const plan = [];
  const skipped = [];
  for (const code of TARGETS) {
    const doc = found.get(code);
    if (!doc) { skipped.push({ code, why: "no existe en Firestore" }); continue; }
    const o = doc.data();
    if (o.status !== "ready_to_assign") { skipped.push({ code, why: `status actual "${o.status}", ya no es ready_to_assign` }); continue; }
    if (o.inventoryReserved) { skipped.push({ code, why: "tiene reserva de inventario: anular por la UI/callable" }); continue; }
    plan.push({ ref: doc.ref, id: doc.id, code, order: o });
  }

  console.log(`${apply ? "ANULANDO" : "DRY-RUN"} — ${plan.length} de ${TARGETS.length} pedidos`);
  for (const p of plan) {
    console.log(`  ${p.code} | ${String(p.order.customerName || "").slice(0, 28).padEnd(28)} | ${money(p.order.totalCop).padStart(10)} | ${p.order.paymentMethod} | ${p.id}`);
  }
  console.log(`  valor total: ${money(plan.reduce((a, p) => a + (Number(p.order.totalCop) || 0), 0))}`);
  if (skipped.length) {
    console.log("\nSaltados:");
    for (const s of skipped) console.log(`  ${s.code} — ${s.why}`);
  }
  if (!apply) { console.log("\nSin --apply no se escribio nada."); process.exit(0); }

  const now = new Date().toISOString();
  const batch = db.batch();
  for (const p of plan) {
    batch.set(p.ref, { status: "cancelled", driverId: p.order.driverId ?? null, callNote: REASON, updatedAt: now }, { merge: true });
    const auditRef = db.collection("auditEvents").doc();
    batch.set(auditRef, {
      id: auditRef.id,
      actorId: "script:cancel-stale-pickups",
      actorRole: "admin",
      action: "order.cancelled",
      entity: "order",
      entityId: p.id,
      fromStatus: "ready_to_assign",
      toStatus: "cancelled",
      summary: `Pedido ${p.code} anulado por admin: ${REASON}`,
      createdAt: now,
    });
  }
  await batch.commit();
  console.log(`\nListo: ${plan.length} pedidos anulados.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
