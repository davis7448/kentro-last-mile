#!/usr/bin/env node
/**
 * KNT-002970 (shopify-7464153710764, tienda Kovia): vuelve a cerrarse como "failed".
 *
 * Historia: salio el 4/8, el domiciliario reporto "Cliente no responde" con foto y el 5/8 se
 * cerro como fallido (failed_visit) generando sus asientos. El 6/8 se confirmo un reintento
 * (order.retry_confirmed) que lo devolvio a `ready_to_assign` y le quito el driverId. Nunca
 * volvio a salir: la planilla de bodega del 25/08 lo tiene en devoluciones desde el 10/8.
 * Llevaba 26 dias ocupando la cola de despacho de un pedido que ya no existe fisicamente.
 *
 * Se cierra como fallido y no como anulado porque eso es lo que realmente paso: hubo visita,
 * fallo, y el cobro correspondiente ya se hizo. Anularlo dejaria un pedido "anulado" cargando
 * un cobro de fallido, que no se puede explicar leyendo la cuenta de Kovia.
 *
 * NO se tocan los asientos de wallet: los dos que existen siguen siendo validos.
 *   - driver_earning +8.000  (ya liquidado en stl-1785973758462-driver-driver-1778271901513)
 *   - failed_fee    -12.000  (sin liquidar, de Kovia)
 * Tampoco cambia su elegibilidad para el proximo corte: isSellerEntryEligible ya los daba por
 * elegibles con el pedido en `ready_to_assign` (regla "un pedido no entregado no espera COD"),
 * y los sigue dando con el pedido en `failed`. Este cambio no mueve un peso.
 *
 * Los rotulos del fallido original (failedReason, failedCategory, failedCategorySource y la
 * evidencia) siguen intactos desde el 5/8, asi que no hay que reescribirlos.
 *
 * `driverId` se deja en null, como quedo tras el reintento. Restaurarlo cambiaria el embudo por
 * mensajero y los insumos del corte del domiciliario, cuyo pago YA esta liquidado. La plata del
 * pedido vive en los asientos, no en este campo.
 *
 * Uso: node scripts/correct-knt002970-to-failed.js            (dry-run)
 *      node scripts/correct-knt002970-to-failed.js --apply     (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");
const ORDER_ID = "shopify-7464153710764";
const NOTE = "Cerrado como fallido: el reintento del 6/8 nunca salio y el paquete esta en devoluciones desde el 10/8 (planilla de bodega 25/08/2026).";
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CO");

(async () => {
  const ref = db.collection("orders").doc(ORDER_ID);
  const snap = await ref.get();
  if (!snap.exists) { console.error("El pedido no existe."); process.exit(1); }
  const order = snap.data();

  if (order.status !== "ready_to_assign") {
    console.error(`Abortado: status actual "${order.status}", se esperaba "ready_to_assign". Alguien lo movio.`);
    process.exit(1);
  }
  if (order.failedCategory !== "failed_visit") {
    console.error(`Abortado: failedCategory actual "${order.failedCategory}", se esperaba "failed_visit".`);
    process.exit(1);
  }

  const entries = await db.collection("walletEntries").where("orderId", "==", ORDER_ID).get();
  console.log(`${apply ? "APLICANDO" : "DRY-RUN"} — ${order.trackingCode}`);
  console.log(`  ${order.status} -> failed  (${order.failedCategory}, "${order.failedReason}")`);
  console.log(`  retryDecision "${order.retryDecision}" -> "cancel"`);
  console.log(`  driverId: ${order.driverId === null ? "null (sin cambio)" : order.driverId}`);
  console.log(`  evidencia conservada: ${(order.evidence || []).length}`);
  console.log("  asientos que NO se tocan:");
  entries.forEach((d) => {
    const e = d.data();
    console.log(`    ${String(e.type).padEnd(15)} ${money(e.amountCop).padStart(9)}  ${e.settlementId ? "liquidado en " + e.settlementId : "sin liquidar"}`);
  });

  if (!apply) { console.log("\nSin --apply no se escribio nada."); process.exit(0); }

  const now = new Date().toISOString();
  const auditId = `audit-correct-knt002970-failed-${Date.now()}`;
  const batch = db.batch();
  batch.set(ref, { status: "failed", retryDecision: "cancel", callNote: NOTE, updatedAt: now }, { merge: true });
  batch.set(db.collection("auditEvents").doc(auditId), {
    id: auditId,
    actorId: "script:correct-knt002970-to-failed",
    actorRole: "admin",
    action: "order.correct_retry_to_failed",
    entity: "order",
    entityId: ORDER_ID,
    fromStatus: "ready_to_assign",
    toStatus: "failed",
    summary: `Pedido ${order.trackingCode} vuelto a cerrar como fallido (${order.failedCategory}): el reintento confirmado el 6/8 nunca se despacho y el paquete esta en devoluciones. Se conservan los ${entries.size} asientos de la visita fallida del 5/8.`,
    createdAt: now,
  });
  await batch.commit();
  console.log(`\nListo: ${order.trackingCode} cerrado como fallido. Auditoria ${auditId}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
