#!/usr/bin/env node
/**
 * Normaliza a string vacio los campos de liquidacion de walletEntries.
 *
 * Por que: "lo pendiente por liquidar" se pregunta en todo el codigo como
 * `!entry.settlementId` (y `!entry.supplierSettlementId` para proveedores), pero en los
 * documentos pendientes esos campos NO existen — estan ausentes, no vacios. Firestore no
 * puede filtrar por campo ausente, asi que la unica forma de traer solo lo pendiente era
 * descargar la coleccion entera (8.027 documentos) y filtrarla en el navegador.
 *
 * Con el campo presente y vacio, el cliente consulta:
 *   walletEntries.where("settlementId", "==", "")
 *   walletEntries.where("type", "==", "product_cost").where("supplierSettlementId", "==", "")
 *
 * Seguridad: solo AÑADE un campo vacio a documentos que no lo tienen. No toca importes, no
 * toca documentos ya liquidados, y la semantica no cambia — `!x` es igual para `undefined`
 * que para `""`, asi que el codigo actual sigue funcionando durante y despues de la migracion.
 *
 * Uso: node scripts/backfill-wallet-settlement-flag.js            (dry-run, no escribe)
 *      node scripts/backfill-wallet-settlement-flag.js --apply    (respalda y escribe)
 */
const fs = require("fs");
const path = require("path");
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");
const BATCH_SIZE = 400;

(async () => {
  const snap = await db.collection("walletEntries").get();

  const pendingSettlement = [];
  const pendingSupplier = [];
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    if (data.settlementId === undefined) pendingSettlement.push(doc);
    if (data.type === "product_cost" && data.supplierSettlementId === undefined) pendingSupplier.push(doc);
  }

  const touched = new Set([...pendingSettlement, ...pendingSupplier].map((doc) => doc.id));

  console.log(`walletEntries totales: ${snap.size}`);
  console.log(`  sin campo settlementId .............. ${pendingSettlement.length}`);
  console.log(`  product_cost sin supplierSettlementId ${pendingSupplier.length}`);
  console.log(`  documentos a tocar (union) .......... ${touched.size}`);

  if (!apply) {
    console.log("\nDry-run: no se escribio nada. Repite con --apply para ejecutar.");
    return;
  }
  if (touched.size === 0) {
    console.log("\nNada que hacer.");
    return;
  }

  // Respaldo completo antes de escribir: son documentos financieros.
  const backupPath = path.join(
    __dirname,
    "..",
    "backups",
    `wallet-entries-pre-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, snap.docs.map((doc) => JSON.stringify({ id: doc.id, ...doc.data() })).join("\n") + "\n");
  console.log(`\nRespaldo completo en ${backupPath}`);

  const updates = new Map();
  for (const doc of pendingSettlement) {
    updates.set(doc.id, { ...(updates.get(doc.id) ?? {}), settlementId: "" });
  }
  for (const doc of pendingSupplier) {
    updates.set(doc.id, { ...(updates.get(doc.id) ?? {}), supplierSettlementId: "" });
  }

  const entries = [...updates.entries()];
  let written = 0;
  for (let index = 0; index < entries.length; index += BATCH_SIZE) {
    const batch = db.batch();
    for (const [id, payload] of entries.slice(index, index + BATCH_SIZE)) {
      batch.set(db.collection("walletEntries").doc(id), payload, { merge: true });
    }
    await batch.commit();
    written += Math.min(BATCH_SIZE, entries.length - index);
    console.log(`  escritos ${written}/${entries.length}`);
  }

  console.log(`\nListo. ${written} documentos normalizados.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
