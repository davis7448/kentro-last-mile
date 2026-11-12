/**
 * Spec 038 RF_12 (T30): la lectura que completa una vista parcial del recaudo antes de decidir "recibido".
 *
 * El saldo de tienda lee solo los asientos sin cortar de la tienda y la API de tiendas, los de la tienda: si el
 * pedido cambio de tienda o tiene asientos ya cortados, su vista no suma lo que suma la liquidacion. Para los
 * pedidos que `codOrdersToComplete` senala (pocos, y ninguno en regimen normal), aqui se leen TODOS sus asientos
 * con la misma consulta que usa `createSettlement`: `orderId in`, de 30 en 30, indice de un campo. El tipo se
 * filtra en memoria con `codEntriesByOrder`.
 */
import type { Firestore } from "firebase-admin/firestore";
import { codEntriesByOrder, type CodEntryLike, type WalletEntryDoc } from "./seller-ledger";

/** Firestore admite hasta 30 valores en un `in`. */
const IN_LIMIT = 30;

/**
 * El `codByOrder` de la vista con la lista de cada pedido de `orderIds` sustituida por la completa (sustituida,
 * no sumada: la completa ya incluye lo que la vista tenia). Sin pedidos que completar, devuelve la misma vista
 * y no lee nada.
 */
export async function completeCodEntries(
  db: Firestore,
  partial: ReadonlyMap<string, readonly CodEntryLike[]>,
  orderIds: readonly string[]
): Promise<ReadonlyMap<string, readonly CodEntryLike[]>> {
  const ids = Array.from(new Set(orderIds.map(String).filter(Boolean)));
  if (ids.length === 0) return partial;
  const chunks = Array.from({ length: Math.ceil(ids.length / IN_LIMIT) }, (_, index) => ids.slice(index * IN_LIMIT, index * IN_LIMIT + IN_LIMIT));
  const snaps = await Promise.all(chunks.map((chunk) => db.collection("walletEntries").where("orderId", "in", chunk).get()));
  const full = codEntriesByOrder(snaps.flatMap((snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as WalletEntryDoc)));
  const merged = new Map(partial);
  for (const orderId of ids) merged.set(orderId, full.get(orderId) ?? []);
  return merged;
}
