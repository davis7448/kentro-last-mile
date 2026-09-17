import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

/**
 * Limpieza diaria de shopifySyncIssues.
 *
 * Esa coleccion es un log append-only de pedidos de Shopify que no se pudieron
 * sincronizar (casi todos "fuera de Cali"): entran ~20.000 al mes y llego a
 * 45.000 documentos / ~17 MB, el 79% de la descarga inicial de la app antes de
 * acotar la consulta. Solo sirve para tener visibilidad de fallos recientes, asi
 * que se conservan los ultimos RETENTION_DAYS dias y se borra el resto.
 *
 * Los ids se generan por referencia (ssi-<dominio>-<referencia>), asi que un
 * pedido que vuelva a fallar crea un documento nuevo con fecha nueva: borrar los
 * viejos no impide detectar un problema que siga ocurriendo.
 */
export const RETENTION_DAYS = 30;

const BATCH_SIZE = 400;
const MAX_DELETES_PER_RUN = 20000;

export async function purgeOldSyncIssues(retentionDays = RETENTION_DAYS, maxDeletes = MAX_DELETES_PER_RUN) {
  const db = getFirestore();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;

  while (deleted < maxDeletes) {
    const snap = await db
      .collection("shopifySyncIssues")
      .where("createdAt", "<", cutoff)
      .limit(BATCH_SIZE)
      .get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  return { deleted, cutoff, retentionDays };
}

export const cleanupShopifySyncIssues = onSchedule(
  { schedule: "every day 03:30", timeZone: "America/Bogota", timeoutSeconds: 540, memory: "256MiB" },
  async () => {
    const result = await purgeOldSyncIssues();
    console.log(
      `[cleanupShopifySyncIssues] borrados ${result.deleted} registros anteriores a ${result.cutoff} (retencion ${result.retentionDays} dias)`
    );
  }
);
