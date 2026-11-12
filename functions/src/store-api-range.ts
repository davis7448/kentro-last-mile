/**
 * Spec 023, fase A: lo que `GET /orders` y `GET /kpis` leen de Firestore.
 *
 * Antes, cada llamada bajaba TODOS los pedidos de la tienda y TODOS sus asientos aunque pidiera un solo
 * dia: 19.148 lecturas por llamada para DANDA, y las integraciones de las tiendas la consultan cada hora.
 * Era entre el 66 % y el 80 % de las lecturas del proyecto (`.sdd/evidence/023/baseline.md`).
 *
 * Aqui hay dos cargadores con el MISMO contrato:
 * - `loadStoreOrdersFull` / `loadSellerEntriesFull`: lo de antes. Se conserva como oraculo: la prueba de
 *   equivalencia (RF_11) y `scripts/verify-023.js` comparan la respuesta de los dos.
 * - `loadStoreOrdersInRange` / `loadSellerEntriesForOrders`: lo dirigido (RF_09, RF_10).
 *
 * Por que la consulta por rango selecciona lo mismo que `inRange`: `inRange` compara
 * `String(createdAt || updatedAt).slice(0, 10)` con `from`/`to`. Si `from`/`to` son `YYYY-MM-DD` y
 * `createdAt` es un texto que empieza por fecha (los 8.308 pedidos lo cumplen el 2026-11-10: ISO con
 * `-05:00` o `Z`), entonces `createdAt >= from` y `createdAt < diaSiguiente(to)` en orden de texto son
 * exactamente `slice(0,10) >= from` y `slice(0,10) <= to`. Con un `from`/`to` que no sea `YYYY-MM-DD`
 * no se puede garantizar, y se usa la carga completa de antes. El filtro `inRange` se sigue aplicando
 * en memoria despues de la consulta, asi que la consulta solo tiene que devolver un superconjunto.
 *
 * Lo que NO cubre: un pedido sin `createdAt` (caeria a `updatedAt`). No existe ninguno; todas las vias de
 * creacion lo ponen.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { OrderDoc, WalletEntryDoc } from "./seller-ledger";

/** Firestore admite como mucho 30 valores en un `in`. */
export const WALLET_IN_BATCH = 30;
/**
 * Por encima de estos pedidos, pedir sus asientos por lotes deja de compensar frente a la consulta de la
 * tienda entera (cada pedido tiene ~2,3 asientos de todos los duenos, y la tienda ~1,7 por pedido propio).
 * Las dos vias dan el mismo resultado; solo cambia cuanto se lee.
 */
export const TARGETED_ENTRIES_MAX_ORDERS = 1500;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function nextIsoDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Se puede pedir por rango solo si hay rango y cada extremo presente es una fecha `YYYY-MM-DD` valida. */
export function canQueryByRange(from: string, to: string): boolean {
  if (!from && !to) return false;
  return (!from || isIsoDay(from)) && (!to || isIsoDay(to));
}

function toOrders(docs: Array<{ id: string; data(): unknown }>): OrderDoc[] {
  return docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }) as OrderDoc);
}

function toEntries(docs: Array<{ id: string; data(): unknown }>): WalletEntryDoc[] {
  return docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }) as WalletEntryDoc);
}

/** Carga de antes: todos los pedidos de la tienda. */
export async function loadStoreOrdersFull(db: Firestore, sellerId: string): Promise<OrderDoc[]> {
  const snap = await db.collection("orders").where("sellerId", "==", sellerId).get();
  return toOrders(snap.docs);
}

/**
 * RF_09: solo los pedidos de la tienda con `createdAt` en el rango. Sin rango valido, la carga de antes.
 * Usa el indice `sellerId ASC + createdAt ASC`, que ya existe.
 */
export async function loadStoreOrdersInRange(db: Firestore, sellerId: string, from: string, to: string): Promise<OrderDoc[]> {
  if (!canQueryByRange(from, to)) return loadStoreOrdersFull(db, sellerId);
  let query = db.collection("orders").where("sellerId", "==", sellerId);
  if (from) query = query.where("createdAt", ">=", from);
  if (to) query = query.where("createdAt", "<", nextIsoDay(to));
  const snap = await query.get();
  return toOrders(snap.docs);
}

/** Carga de antes: todos los asientos de la tienda. */
export async function loadSellerEntriesFull(db: Firestore, sellerId: string): Promise<WalletEntryDoc[]> {
  const snap = await db.collection("walletEntries").where("ownerType", "==", "seller").where("ownerId", "==", sellerId).get();
  return toEntries(snap.docs);
}

/**
 * RF_10: solo los asientos de la tienda que son de estos pedidos. `buildPaymentInfo` filtra por `orderId`,
 * asi que para estos pedidos da lo mismo que la carga completa. Se piden por `orderId in` (de cualquier
 * dueno) y se quedan los de la tienda, con el mismo criterio que la consulta de antes.
 *
 * RF_12: si un lote falla, la promesa falla entera. No se traga el error: un estado de pago con asientos
 * de menos diria "sin liquidar" de un pedido ya pagado.
 */
export async function loadSellerEntriesForOrders(db: Firestore, sellerId: string, orderIds: string[]): Promise<WalletEntryDoc[]> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (ids.length === 0) return [];
  if (ids.length > TARGETED_ENTRIES_MAX_ORDERS) return loadSellerEntriesFull(db, sellerId);
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += WALLET_IN_BATCH) batches.push(ids.slice(index, index + WALLET_IN_BATCH));
  const snaps = await Promise.all(batches.map((batch) => db.collection("walletEntries").where("orderId", "in", batch).get()));
  return snaps
    .flatMap((snap) => toEntries(snap.docs))
    .filter((entry) => entry.ownerType === "seller" && entry.ownerId === sellerId);
}
