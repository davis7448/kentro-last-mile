/**
 * RF_35 de punta a punta: cuando sube una tarifa base, los precios de comunidad que quedan por
 * debajo suben solos hasta el nuevo piso.
 *
 * Es un TRIGGER y no una callable a proposito. La tarifa base la escribe el navegador del
 * administrador directamente en `settings/app`, asi que una llamada desde el cliente quedaria a
 * merced de que esa pestaña siga viva y de que nadie escriba los ajustes por otra via: la
 * elevacion se perderia en silencio y Kentro cobraria por debajo de su costo sin fecha de
 * caducidad. `onDocumentUpdated` se dispara escriba quien escriba y no se puede saltar.
 *
 * Este archivo es un traductor: lee, llama al plan y escribe lo que el plan dice. Toda la
 * aritmetica —que concepto subio, contra que precio se compara, que programada muere— vive en
 * `planFloorRaise` (`community-pricing.ts`), que es puro y esta probado sin Firestore.
 *
 * No hay recursion posible: escribe en `communities`, nunca en `settings/app`.
 */

import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { planFloorRaise, type CommunityLike } from "./community-pricing";

export const onSettingsFloorRaise = onDocumentUpdated("settings/app", async (event) => {
  const before = (event.data?.before.data() ?? {}) as Record<string, unknown>;
  const after = (event.data?.after.data() ?? {}) as Record<string, unknown>;
  const nowIso = new Date().toISOString();

  // Corte barato ANTES de leer `communities`: el trigger salta con CUALQUIER campo de los
  // ajustes (tokens, textos, puntos de recogida). Si ninguna base sube, no se toca Firestore.
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
    const ref = db.collection("communities").doc(change.communityId);
    const update: Record<string, unknown> = { ...change.communityUpdate };
    for (const path of change.deleteFields) update[path] = FieldValue.delete();

    const batch = db.batch();
    batch.update(ref, update);
    for (const entry of change.historyEntries) {
      // Id determinista: un reintento del mismo evento reescribe la misma entrada en vez de
      // duplicar el historial con elevaciones fantasma.
      batch.set(ref.collection("priceHistory").doc(`floor-${entry.field}-${nowIso}`), entry);
    }
    await batch.commit();
  }
});
