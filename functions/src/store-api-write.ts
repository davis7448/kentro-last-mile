import type { Firestore } from "firebase-admin/firestore";
import type { OrderDoc, SettlementDoc, WalletEntryDoc } from "./seller-ledger";
import { buildPaymentInfo, classifyOrder, loadTargetedPaymentInputs, orderPayload } from "./store-api-orders";
import { buildErrorBody, STORE_API_ERROR_HTTP } from "./store-api-request";

/**
 * Rutas de la Store API que leen UN pedido o unos pocos (spec 029, plan 2.10): `GET /orders/{id}` y el filtro
 * `GET /orders?shopifyOrderId=`. Carga dirigida: nunca baja la tienda entera ni todos los cortes (RNF_05). Una
 * guarda de fuente lo vigila en este archivo: toda consulta por `sellerId` lleva un segundo filtro y no hay
 * lectura de la coleccion `settlements` completa.
 *
 * La autenticacion y los parametros ya se resolvieron en el handler (`store-api.ts`); aqui solo se lee y se
 * arma la respuesta. Devuelve `{ httpStatus, body }` y el handler la escribe.
 */

export type StoreApiReply = { httpStatus: number; body: Record<string, unknown> };

/** Un elemento de `GET /orders`: la forma es una sola para la lista, el pedido suelto y las escrituras. */
export function storeOrderItem(
  order: OrderDoc,
  sellerEntries: WalletEntryDoc[],
  settlementsById: Map<string, SettlementDoc>,
  codReceived: Set<string>
) {
  return {
    ...orderPayload(order),
    operacion: classifyOrder(order),
    pago: buildPaymentInfo(order, sellerEntries, settlementsById, codReceived)
  };
}

/**
 * Ids que Firestore no acepta como documento (`.`, `..`, `__x__`, mas de 1500 bytes). Se tratan como
 * inexistentes: mismo 404 que cualquier otro, sin que la libreria lance.
 */
function isUsableDocumentId(id: string): boolean {
  if (!id || id === "." || id === "..") return false;
  if (/^__.*__$/.test(id)) return false;
  return Buffer.byteLength(id, "utf8") <= 1500;
}

/** Asientos del pedido (de cualquier dueno) y los cortes que lo tocan: lo justo para `buildPaymentInfo`. */
async function loadOrderItem(db: Firestore, sellerId: string, order: OrderDoc) {
  const orderId = String(order.id);
  const [entriesSnap, coveringSnap] = await Promise.all([
    db.collection("walletEntries").where("orderId", "==", orderId).get(),
    db.collection("settlements").where("orderIds", "array-contains", orderId).get()
  ]);
  const entries = entriesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as WalletEntryDoc);
  const covering = coveringSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as SettlementDoc);

  // Cortes de los asientos de la tienda que no esten ya entre los que nombran el pedido.
  const coveredIds = new Set(covering.map((settlement) => String(settlement.id)));
  const missingIds = [
    ...new Set(
      entries
        .filter((entry) => entry.ownerType === "seller" && entry.ownerId === sellerId)
        .map((entry) => (typeof entry.settlementId === "string" ? entry.settlementId : ""))
        .filter((id) => id && !coveredIds.has(id) && isUsableDocumentId(id))
    )
  ];
  const referencedSnaps = missingIds.length
    ? await db.getAll(...missingIds.map((id) => db.collection("settlements").doc(id)))
    : [];
  const referenced = referencedSnaps
    .filter((snap) => snap.exists)
    .map((snap) => ({ id: snap.id, ...snap.data() }) as SettlementDoc);

  const { sellerEntries, settlementsById, codReceived } = loadTargetedPaymentInputs({
    orderId,
    sellerId,
    entries,
    settlements: [...covering, ...referenced]
  });
  return storeOrderItem(order, sellerEntries, settlementsById, codReceived);
}

function orderNotFound(): StoreApiReply {
  // Mismo cuerpo para el pedido ajeno y el inexistente: no se dice cual de los dos es (RNF_01).
  return { httpStatus: STORE_API_ERROR_HTTP.order_not_found, body: buildErrorBody("order_not_found") };
}

/** `GET /orders/{id}` (RF_01): 200 `{ ok, pedido }` o 404 `order_not_found`. */
export async function readStoreOrder(db: Firestore, input: { sellerId: string; orderId: string }): Promise<StoreApiReply> {
  if (!isUsableDocumentId(input.orderId)) return orderNotFound();
  const snap = await db.collection("orders").doc(input.orderId).get();
  const data = snap.exists ? snap.data() : undefined;
  if (!data || data.sellerId !== input.sellerId) return orderNotFound();
  const order = { id: snap.id, ...data } as OrderDoc;
  return { httpStatus: 200, body: { ok: true, pedido: await loadOrderItem(db, input.sellerId, order) } };
}

/**
 * `GET /orders?shopifyOrderId=` (RF_02), ruta existente con su forma de respuesta de hoy. El numero ya llega
 * validado. `from`/`to` se ignoran; `status` y `limit` se aplican como en la lista completa. `shopifyOrderId`
 * se consulta solo como texto: T1 midio en produccion que siempre se guarda asi.
 */
export async function listStoreOrdersByShopifyOrderId(
  db: Firestore,
  input: { sellerId: string; sellerName: unknown; shopifyOrderId: string; statusFilter: string; limit: number }
): Promise<StoreApiReply> {
  const snap = await db.collection("orders").where("sellerId", "==", input.sellerId).where("shopifyOrderId", "==", input.shopifyOrderId).get();
  const found = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as OrderDoc)
    .filter((order) => !input.statusFilter || order.status === input.statusFilter)
    .sort((left, right) => String(right.createdAt || right.updatedAt).localeCompare(String(left.createdAt || left.updatedAt)))
    .slice(0, input.limit);
  const pedidos = await Promise.all(found.map((order) => loadOrderItem(db, input.sellerId, order)));
  return {
    httpStatus: 200,
    body: {
      ok: true,
      tienda: input.sellerName,
      // Con el filtro no se aplica rango de fechas: se dice asi en vez de devolver uno que no se uso.
      rango: { desde: null, hasta: null },
      total: pedidos.length,
      pedidos
    }
  };
}
