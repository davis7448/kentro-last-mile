/**
 * La UNICA copia de la escritura de una elevacion al piso en Firestore.
 *
 * La usan dos llamadores: el trigger de `settings/global` (RF_13) y la pasada unica de RF_14, que
 * eleva los precios que ya estaban por debajo de la base real. Si cada uno tuviera su propio
 * batch, bastaria con que uno olvidara copiar la marca `floorRaisedAt` o el historial para que el
 * lider dejara de enterarse de que le subieron el precio (el aviso de la spec 004 §6).
 *
 * Es un traductor: no decide nada. Lo que se escribe lo decide `planRaiseToFloors`
 * (`community-pricing.ts`), que es puro y esta probado sin Firestore. Este archivo importa
 * `firebase-admin` y no se prueba en unidad; lo ata una guarda de fuente en
 * `src/lib/community-pricing.test.ts`.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { CommunityFloorRaise } from "./community-pricing";

/**
 * Escribe UNA comunidad en un solo batch: el `update` del documento (precios, aviso, `updatedAt`
 * y las programadas que mueren) y sus entradas de historial. Todo o nada: un historial sin su
 * precio, o un precio sin su historial, contaria una historia que no ocurrio.
 */
export async function writeFloorRaise(db: Firestore, change: CommunityFloorRaise, nowIso: string): Promise<void> {
  const ref = db.collection("communities").doc(change.communityId);

  // Se copia `communityUpdate` ENTERO y no clave a clave: asi la marca de aviso no se puede perder.
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
