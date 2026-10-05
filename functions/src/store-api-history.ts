import type { OrderHistoryDoc } from "./order-seller-actions";
import { API_EDITABLE_STATUSES } from "./order-seller-actions";
import { STORE_API_ERROR_HTTP, STORE_API_PRECEDENCE } from "./store-api-request";

/**
 * Historial de un pedido tal como lo ve una tienda por la Store API (spec 029, plan 2.5 y 4.3). PURO: sin
 * firebase-admin. El handler (`store-api-write.ts`) lee `orderHistory` y comprueba la tienda; aqui solo se
 * decide QUE sale.
 *
 * RF_18: la salida es una lista EXPLICITA de claves. Un registro sale con `at`, `origin`, `action` y `changes`,
 * y cada cambio con `field`, `from` y `to`. Lo que el documento guarde para Kentro (actor, uid, auditEventId,
 * sellerId...) o lo que se le anada manana no sale porque nunca se copia: no se filtra quitando claves.
 */

/** Lo que el historial NO incluye (RF_17). Campo estable de la respuesta: se agregan valores, no se renombran. */
export const HISTORY_EXCLUDES = Object.freeze(["imports", "chatby"] as const);

/** El mismo alcance en texto, para quien lee la respuesta sin conocer `excludes`. */
export const HISTORY_NOTICE =
  "No incluye cambios de importaciones (Shopify y webhooks de tienda) ni la confirmacion automatica de ChatBy.";

export type StoreHistoryChange = { field: unknown; from: unknown; to: unknown };

export type StoreHistoryRecord = { at: string; origin: string; action: string; changes: StoreHistoryChange[] };

export type StoreHistoryResponse = {
  ok: true;
  historySince: string;
  excludes: Array<(typeof HISTORY_EXCLUDES)[number]>;
  aviso: string;
  registros: StoreHistoryRecord[];
};

type HistoryInput = Partial<OrderHistoryDoc> | Record<string, unknown>;

function toStoreChange(change: unknown): StoreHistoryChange {
  const source = (change && typeof change === "object" ? change : {}) as Record<string, unknown>;
  return { field: source.field ?? null, from: source.from ?? null, to: source.to ?? null };
}

function toStoreRecord(input: HistoryInput): StoreHistoryRecord {
  const source = input as Record<string, unknown>;
  return {
    at: String(source.createdAt ?? ""),
    origin: String(source.origin ?? ""),
    action: String(source.action ?? ""),
    changes: Array.isArray(source.changes) ? source.changes.map(toStoreChange) : []
  };
}

/**
 * `records` son los de `orderHistory` del pedido, ya filtrados por pedido y tienda en el handler. Ordena del
 * mas viejo al mas nuevo en memoria (la lectura no usa `orderBy`, plan 2.5). No muta la entrada.
 * `orderId` lo anade el handler: sin registros esta funcion no lo conoce.
 */
export function toStoreHistoryResponse(records: readonly HistoryInput[], historySince: string): StoreHistoryResponse {
  const registros = records
    .map(toStoreRecord)
    // Comparacion de cadenas ISO, no `localeCompare` (docs/rendimiento.md). `sort` es estable.
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  return {
    ok: true,
    historySince,
    excludes: [...HISTORY_EXCLUDES],
    aviso: HISTORY_NOTICE,
    registros
  };
}

/**
 * Claves NUEVAS de primer nivel del indice de la raiz (RF_17, RF_20, plan 2.1). Las claves de hoy no se tocan:
 * el handler las escribe tal cual y despues anade estas. `historySince` es `null` mientras no exista
 * `settings/storeApi` (el indice sigue respondiendo).
 */
export function buildStoreApiIndexAdditions(historySince: string | null): Record<string, unknown> {
  return {
    rutasDePedido: {
      "GET /orders/{id}": "Un pedido de la tienda por su id de Kentro, con la misma forma que un elemento de GET /orders. Un pedido de otra tienda o inexistente responde 404 order_not_found.",
      "GET /orders/{id}/history": "Historial de cambios del pedido desde historySince, del mas viejo al mas nuevo: { ok, orderId, historySince, excludes, aviso, registros: [{ at, origin, action, changes: [{ field, from, to }] }] }. No dice quien hizo el cambio.",
      "POST /orders/{id}/confirm": "Confirma el pedido (pasa a listo para asignar). Cuerpo opcional { expectedStatus }. Confirmar dos veces no cambia nada (200 changed: false).",
      "PATCH /orders/{id}": "Corrige los datos de entrega (customerName, customerPhone, addressRaw, deliveryNotes, cityId) mientras el pedido este en un estado editable. Cuerpo JSON con los campos a cambiar y expectedStatus opcional.",
      "POST /orders/{id}/cancel": "Anula el pedido mientras este en un estado editable. Cuerpo { reason } obligatorio y expectedStatus opcional."
    },
    autenticacionEscritura:
      "Las rutas de escritura solo aceptan la key de escritura, y solo en la cabecera Authorization: Bearer <key> (con sellerId por query). Una key en la URL de una ruta de escritura responde 401 key_in_query. La key de lectura en la cabecera de una escritura responde 403 read_only_key. Las escrituras admiten la cabecera Idempotency-Key.",
    filtroShopifyOrderId:
      "GET /orders?shopifyOrderId=%232849 busca el pedido por su numero de Shopify en esta tienda. El numeral (#) va codificado como %23: un # sin codificar lo corta el cliente HTTP como fragmento y el filtro llega vacio (400 invalid_shopify_order_id).",
    estadosEditables: [...API_EDITABLE_STATUSES],
    codigosDeError: { ...STORE_API_ERROR_HTTP },
    precedenciaDeErrores: STORE_API_PRECEDENCE.map((row) => ({ paso: row.step, comprueba: row.check, codigos: [...row.codes] })),
    formaDeError: "Las rutas nuevas responden los errores como { ok: false, code, message } y, segun el caso, fields, status, hasLeader o activeCities. Las rutas de antes conservan su forma { ok: false, error }.",
    historial: {
      historySince,
      excludes: [...HISTORY_EXCLUDES],
      aviso: HISTORY_NOTICE
    }
  };
}
