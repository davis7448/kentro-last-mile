/**
 * Relleno de la marca de edicion manual (spec 017, RF_19).
 *
 * Se corre UNA vez, entre dos despliegues: despues de subir las dos callables que sellan
 * (`updateImportedOrder` y `updateOrderAdjustments`) y ANTES de subir las vias de importacion. En
 * ese orden no queda ventana: desde el primer despliegue toda edicion nueva ya deja marca, y este
 * guion se ocupa de las viejas.
 *
 * Sin el, un pedido corregido la semana pasada no tiene marca, la reimportacion lo trata como "nadie
 * lo ha tocado", le refresca la direccion y le descarta la geocodificacion: el propio arreglo
 * causando la perdida que viene a impedir.
 *
 * **No replica la logica**: carga el modulo puro ya compilado, que es el que esta probado. Es lo
 * contrario de lo que hacen los demas guiones de `scripts/`, y es a proposito.
 *
 * Uso:
 *   cd functions && npm run build && cd ..
 *   node scripts/backfill-manual-edit-stamp.js           # dry-run
 *   node scripts/backfill-manual-edit-stamp.js --apply   # escribe
 */
const admin = require("../functions/node_modules/firebase-admin");
const { ordersToStamp, MANUAL_EDIT_ACTIONS } = require("../functions/lib/manual-edit-backfill");
const { MANUAL_EDIT_STAMP } = require("../functions/lib/order-import-merge");

const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

(async () => {
  const events = [];
  for (const action of MANUAL_EDIT_ACTIONS) {
    const snap = await db.collection("auditEvents").where("action", "==", action).get();
    snap.docs.forEach((doc) => events.push(doc.data()));
  }
  console.log(`Eventos de edicion manual encontrados: ${events.length}`);

  const orderIds = [...new Set(events.map((event) => String(event.entityId ?? "")).filter(Boolean))];
  const orders = [];
  // Uno a uno y no por lotes: un id inexistente tumbaria el lote entero, y aqui hay ids de pedidos
  // que pueden haberse borrado.
  for (const id of orderIds) {
    const snap = await db.collection("orders").doc(id).get();
    if (snap.exists) orders.push({ id: snap.id, ...snap.data(), _updateTime: snap.updateTime });
  }

  const plan = ordersToStamp(events, orders);
  const byId = new Map(orders.map((order) => [order.id, order]));
  console.table(plan.map((item) => ({
    pedido: byId.get(item.orderId)?.trackingCode ?? item.orderId,
    id: item.orderId,
    estado: byId.get(item.orderId)?.status,
    editado: item.editedAt,
    motivo: item.action
  })));
  console.log(`A marcar: ${plan.length} de ${orders.length} pedidos con edicion manual.`);

  if (!APPLY) {
    console.log("DRY-RUN: nada escrito. Repetir con --apply.");
    return;
  }

  // Por lotes de 400 (el limite del batch es 500) y con precondicion: si el pedido cambio desde que
  // se leyo, el lote falla entero y no pisa a nadie.
  for (let index = 0; index < plan.length; index += 400) {
    const chunk = plan.slice(index, index + 400);
    const batch = db.batch();
    for (const item of chunk) {
      const order = byId.get(item.orderId);
      batch.update(db.collection("orders").doc(item.orderId), { [MANUAL_EDIT_STAMP]: item.editedAt }, { lastUpdateTime: order._updateTime });
    }
    await batch.commit();
    console.log(`Marcados ${Math.min(index + 400, plan.length)}/${plan.length}`);
  }
  console.log("APLICADO.");
})().catch((error) => {
  console.error("FALLO:", error.message);
  process.exit(1);
});
