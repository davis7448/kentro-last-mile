#!/usr/bin/env node
/**
 * Purga los registros antiguos de shopifySyncIssues (log de pedidos de Shopify que
 * no se pudieron sincronizar, casi todos "fuera de Cali").
 *
 * La coleccion llego a 45.000 documentos / ~17 MB creciendo ~20.000 al mes, y solo
 * sirve para tener visibilidad de fallos recientes. Este script hace la limpieza
 * puntual; el mantenimiento continuo lo hace la funcion programada
 * cleanupShopifySyncIssues (functions/src/sync-issues-cleanup.ts), con la misma
 * retencion.
 *
 * Antes de borrar exporta lo que se va a eliminar a un .jsonl, por si mas adelante
 * se quiere analizar el patron de rechazos.
 *
 * Uso: node scripts/purge-shopify-sync-issues.js                (dry-run)
 *      node scripts/purge-shopify-sync-issues.js --apply         (borra)
 *      node scripts/purge-shopify-sync-issues.js --days=60       (otra retencion)
 */
const fs = require("fs");
const path = require("path");
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");
const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
const retentionDays = daysArg ? Number(daysArg.split("=")[1]) : 30;
const BATCH_SIZE = 400;

(async () => {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("--days debe ser un numero positivo");
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const snap = await db.collection("shopifySyncIssues").where("createdAt", "<", cutoff).get();
  const docs = snap.docs;

  const porMes = {};
  for (const doc of docs) {
    const month = String(doc.data().createdAt ?? "").slice(0, 7);
    porMes[month] = (porMes[month] || 0) + 1;
  }

  if (apply && docs.length > 0) {
    // Respaldo antes de borrar: el log es la unica evidencia de estos rechazos.
    const backupPath = path.join(__dirname, `../shopify-sync-issues-backup-${cutoff.slice(0, 10)}.jsonl`);
    fs.writeFileSync(backupPath, docs.map((doc) => JSON.stringify({ id: doc.id, ...doc.data() })).join("\n") + "\n");
    console.log(`Respaldo escrito: ${backupPath}`);

    for (let start = 0; start < docs.length; start += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(start, start + BATCH_SIZE)) batch.delete(doc.ref);
      await batch.commit();
    }
  }

  const restantes = (await db.collection("shopifySyncIssues").count().get()).data().count;
  console.log(JSON.stringify({
    apply,
    retentionDays,
    cutoff,
    aBorrar: docs.length,
    porMes,
    documentosRestantes: apply ? restantes : restantes - docs.length
  }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
