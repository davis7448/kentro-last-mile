#!/usr/bin/env node
/**
 * Restaura pedidos desde un respaldo generado por delete-pending-orders-pre-cutoff.js.
 * Reescribe cada documento con su id original, asi que los walletEntries y settlements
 * que quedaron apuntando a esos pedidos se vuelven a enlazar solos.
 *
 * Es idempotente: si el pedido ya existe se omite (no pisa datos mas nuevos).
 *
 * Uso:
 *   node scripts/restore-orders-from-backup.js --file backups/<archivo>.json
 *   node scripts/restore-orders-from-backup.js --file backups/<archivo>.json --status delivered,failed
 *   ... --apply
 */
const fs = require("fs");
const path = require("path");
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const file = arg("file");
const statusFilter = arg("status");
const apply = process.argv.includes("--apply");

if (!file) {
  console.error("Falta --file <ruta del respaldo>");
  process.exit(1);
}

(async () => {
  const backup = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const statuses = statusFilter ? statusFilter.split(",").map((value) => value.trim()) : null;
  const candidates = statuses ? backup.orders.filter((order) => statuses.includes(order.status)) : backup.orders;

  console.log("Respaldo:         ", file);
  console.log("Tienda:           ", backup.sellerName ?? backup.sellerId);
  console.log("Pedidos guardados:", backup.orders.length);
  console.log("Filtro de estado: ", statuses ? statuses.join(", ") : "(todos)");
  console.log("A restaurar:      ", candidates.length);

  const existing = await Promise.all(candidates.map((order) => db.collection("orders").doc(order.id).get()));
  const missing = candidates.filter((_, index) => !existing[index].exists);
  const present = candidates.length - missing.length;
  if (present > 0) console.log("Ya existen (se omiten):", present);
  console.log("Se escribiran:    ", missing.length);

  const byStatus = {};
  for (const order of missing) byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
  console.log("Detalle:          ", JSON.stringify(byStatus));

  if (missing.length === 0) {
    console.log("\nNada que restaurar.");
    return;
  }

  if (!apply) {
    console.log("\nDRY-RUN. Nada se escribio. Repetir con --apply para ejecutar.");
    return;
  }

  let written = 0;
  for (let index = 0; index < missing.length; index += 400) {
    const batch = db.batch();
    for (const order of missing.slice(index, index + 400)) {
      const { id, ...data } = order;
      batch.set(db.collection("orders").doc(id), data);
    }
    await batch.commit();
    written += Math.min(400, missing.length - index);
    console.log(`  restaurados ${written}/${missing.length}`);
  }

  const after = await db.collection("orders").where("sellerId", "==", backup.sellerId).get();
  console.log("\nListo. Pedidos de la tienda ahora:", after.size);
})().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
