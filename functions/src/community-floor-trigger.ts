/**
 * RF_13 de la 004 (antes RF_35 de la 001) de punta a punta: cuando sube la base real de un
 * concepto, los precios de comunidad que quedan por debajo suben solos hasta el nuevo piso.
 *
 * Escucha `settings/global` porque es el documento del que salen las tarifas que se cobran
 * (`resolveTariffs` en el cierre). La version anterior escuchaba `settings/app`, que no existe en
 * produccion: el trigger estaba desplegado y no se habia disparado nunca, y nada lo delataba.
 *
 * Es un TRIGGER y no una callable a proposito. La tarifa base la escribe el navegador del
 * administrador directamente en los ajustes, asi que una llamada desde el cliente quedaria a
 * merced de que esa pestaña siga viva y de que nadie escriba los ajustes por otra via: la
 * elevacion se perderia en silencio y Kentro cobraria por debajo de su costo sin fecha de
 * caducidad. `onDocumentUpdated` se dispara escriba quien escriba y no se puede saltar.
 *
 * Este archivo es un traductor: lee, llama al plan y le pasa cada cambio al writer. La aritmetica
 * —que concepto subio con la base REAL, contra que precio se compara, que programada muere— vive
 * en `planFloorRaise` (`community-pricing.ts`), pura y probada sin Firestore. La escritura vive en
 * `community-floor-writer.ts`, la misma que usa la pasada unica de RF_14: una sola copia.
 *
 * No hay recursion posible: escribe en `communities`, nunca en `settings`.
 */

import { getFirestore } from "firebase-admin/firestore";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { planFloorRaise, type CommunityLike } from "./community-pricing";
import { writeFloorRaise } from "./community-floor-writer";

export const onSettingsFloorRaise = onDocumentUpdated("settings/global", async (event) => {
  const before = (event.data?.before.data() ?? {}) as Record<string, unknown>;
  const after = (event.data?.after.data() ?? {}) as Record<string, unknown>;
  const nowIso = new Date().toISOString();

  // Corte barato ANTES de leer `communities`: el trigger salta con CUALQUIER campo de los
  // ajustes (textos, plazos de pago). Si ninguna base real sube, no se toca Firestore.
  if (planFloorRaise({ before, after, communities: [], nowIso }).raisedFields.length === 0) return;

  const db = getFirestore();
  const snap = await db.collection("communities").get();
  const plan = planFloorRaise({
    before,
    after,
    communities: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as CommunityLike),
    nowIso
  });

  for (const change of plan.communities) {
    await writeFloorRaise(db, change, nowIso);
  }
});
