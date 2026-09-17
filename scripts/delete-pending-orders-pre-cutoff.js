#!/usr/bin/env node
/**
 * Elimina pedidos de una tienda anteriores a un corte, filtrando por estado.
 * Caso de uso: una tienda que no estaba operando deja pedidos "Pendiente confirmacion"
 * (status `imported`) que nunca se trabajaron y ensucian tableros y reportes.
 *
 * Politica acordada con el usuario: por defecto SOLO se borran los `imported`
 * (= "Pendiente confirmacion"). Los entregados y fallidos NO se borran: tienen
 * movimientos de wallet y algunos ya estan dentro de liquidaciones `reconciled`
 * de transportista (multi-tienda), asi que borrarlos corrompe pagos conciliados.
 *
 * NUNCA toca walletEntries ni settlements.
 *
 * Uso:
 *   node scripts/delete-pending-orders-pre-cutoff.js --seller <id> --before <ISO>
 *   node scripts/delete-pending-orders-pre-cutoff.js --seller <id> --before <ISO> --apply
 *   ... --status imported,cancelled     (ampliar el filtro de estados)
 *
 * Ejemplo:
 *   node scripts/delete-pending-orders-pre-cutoff.js \
 *     --seller seller-1782485190827 --before 2026-07-05T00:00:00-05:00 --apply
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

const sellerId = arg("seller");
const beforeIso = arg("before");
const statuses = arg("status", "imported").split(",").map((value) => value.trim()).filter(Boolean);
const apply = process.argv.includes("--apply");

if (!sellerId || !beforeIso) {
  console.error("Faltan argumentos. Uso: --seller <id> --before <ISO> [--status imported] [--apply]");
  process.exit(1);
}

const cutoffMs = new Date(beforeIso).getTime();
if (Number.isNaN(cutoffMs)) {
  console.error(`Fecha de corte invalida: ${beforeIso}`);
  process.exit(1);
}

(async () => {
  const [sellerSnap, snapshot] = await Promise.all([
    db.collection("sellers").doc(sellerId).get(),
    db.collection("orders").where("sellerId", "==", sellerId).get(),
  ]);
  const sellerName = sellerSnap.data()?.name ?? "(tienda desconocida)";
  const all = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const inRange = all.filter((order) => new Date(order.createdAt).getTime() < cutoffMs);
  const doomed = inRange
    .filter((order) => statuses.includes(order.status))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const doomedIds = new Set(doomed.map((order) => order.id));
  const walletSnapshot = await db.collection("walletEntries").get();
  const orphaned = walletSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((entry) => entry.orderId && doomedIds.has(entry.orderId));

  const rangeByStatus = {};
  for (const order of inRange) rangeByStatus[order.status] = (rangeByStatus[order.status] ?? 0) + 1;

  console.log("Tienda:           ", sellerName, `(${sellerId})`);
  console.log("Corte:            ", beforeIso);
  console.log("Estados a borrar: ", statuses.join(", "));
  console.log("Pedidos totales:  ", all.length);
  console.log("En el rango:      ", inRange.length, JSON.stringify(rangeByStatus));
  console.log("A eliminar:       ", doomed.length);
  console.log("Se conservan:     ", all.length - doomed.length);
  if (orphaned.length > 0) console.log("AVISO: quedarian", orphaned.length, "walletEntries sin pedido (no se tocan)");
  for (const order of doomed) console.log("   -", order.createdAt.slice(0, 16), (order.trackingCode ?? order.id).padEnd(13), order.status);

  if (doomed.length === 0) {
    console.log("\nNada que borrar.");
    return;
  }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `orders-${sellerId}-${stamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ sellerId, sellerName, cutoff: beforeIso, statuses, deletedAt: new Date().toISOString(), orders: doomed, relatedWalletEntries: orphaned }, null, 2)
  );
  console.log("Respaldo escrito: ", backupPath);

  if (!apply) {
    console.log("\nDRY-RUN. Nada se borro. Repetir con --apply para ejecutar.");
    return;
  }

  let deleted = 0;
  for (let index = 0; index < doomed.length; index += 400) {
    const batch = db.batch();
    for (const order of doomed.slice(index, index + 400)) batch.delete(db.collection("orders").doc(order.id));
    await batch.commit();
    deleted += Math.min(400, doomed.length - index);
    console.log(`  borrados ${deleted}/${doomed.length}`);
  }

  const after = await db.collection("orders").where("sellerId", "==", sellerId).get();
  console.log(`\nListo. Pedidos restantes de ${sellerName}:`, after.size);
})().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
