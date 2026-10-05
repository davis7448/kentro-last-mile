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

/*
 * "Historial del pedido" en la app (callable `getOrderAuditTrail`, spec 029 RF_27, plan 2.7). PURO: la callable
 * lee `auditEvents`, `orderHistory` y `settings/storeApi`, y resuelve actores SOLO para roles que no son tienda;
 * aqui se decide que sale para cada rol.
 */

/**
 * Acciones cuyas plantillas de `summary` se comprobaron sin identidades de Kentro (plan 2.7). Lista PERMITIDA:
 * una accion que no este aqui llega a la tienda con `summary: ""` (y solo si es verificable).
 */
export const STORE_SUMMARY_ACTIONS: readonly string[] = Object.freeze([
  "order.seller_confirmed",
  "order.imported_updated",
  "order.cancelled",
  "order.retry_confirmed",
  "order.transition",
  "order.delivered",
  "order.failed",
  "order.retry_scheduled",
  "order.webhook_imported",
  "order.manual_created",
  "order.confirmed_uchat",
  "order.failed_classified",
  "order.delivery_corrected",
  "order.address_reviewed",
  "order.picked_up"
]);

const STORE_SUMMARY_ACTION_SET: ReadonlySet<string> = new Set(STORE_SUMMARY_ACTIONS);

const STORE_ROLES: ReadonlySet<string> = new Set(["seller", "seller_logistics"]);

export type StoreActorTag = "Kentro" | "Tu tienda" | "API";

/** Lo unico que la tienda sabe de quien actuo. Solo lee `actorRole`: nunca un id, un nombre ni un correo. */
export function storeActorTag(actorRole: unknown): StoreActorTag {
  if (actorRole === "store_api") return "API";
  if (typeof actorRole === "string" && STORE_ROLES.has(actorRole)) return "Tu tienda";
  return "Kentro";
}

/** El `summary` para la tienda: tal cual si la accion esta en la lista permitida, `""` en cualquier otro caso. */
export function storeSafeSummary(action: string, summary: unknown): string {
  if (!STORE_SUMMARY_ACTION_SET.has(action) || typeof summary !== "string") return "";
  return summary;
}

/**
 * Mitigacion hasta la spec 032: hoy un cliente puede crear un `auditEvents` con el `entityId` de un pedido ajeno.
 * La tienda solo ve un evento si es verificable (tiene registro en `orderHistory`, que solo escribe el servidor)
 * o si su accion esta en la lista permitida.
 */
export function isStoreVisibleEvent(event: { id: string; action: string }, verifiedAuditEventIds: ReadonlySet<string>): boolean {
  if (event.id && verifiedAuditEventIds.has(event.id)) return true;
  return STORE_SUMMARY_ACTION_SET.has(event.action);
}

export type AuditTrailEvent = {
  id: string;
  createdAt: string;
  action: string;
  summary: string;
  fromStatus?: string;
  toStatus?: string;
  origin?: string;
  changes?: StoreHistoryChange[];
  /** Solo tienda. */
  actorTag?: StoreActorTag;
  /** Solo roles que no son tienda. */
  actorId?: string;
  actorLabel?: string;
  actorEmail?: string;
  actorRole?: string;
  /** Solo admin, solo eventos de la API. */
  apiKeyLast4?: string;
};

export type AuditTrailInput = {
  role: string;
  events: ReadonlyArray<Record<string, unknown>>;
  history: ReadonlyArray<Record<string, unknown>>;
  historySince: string | null;
  sellerName: string;
  /** SOLO para roles que no son tienda; para la tienda se ignora aunque venga. */
  actors?: ReadonlyMap<string, { label: string; email?: string }>;
};

export type AuditTrailResponse = { events: AuditTrailEvent[]; historySince: string | null };

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isApiEvent(row: Record<string, unknown>, historyRow: Record<string, unknown> | undefined): boolean {
  return row.actorRole === "store_api" || row.origin === "api" || historyRow?.origin === "api";
}

function historyKeyLast4(historyRow: Record<string, unknown> | undefined): string | undefined {
  const actor = historyRow?.actor;
  if (!actor || typeof actor !== "object") return undefined;
  return optionalText((actor as Record<string, unknown>).keyLast4);
}

/**
 * Respuesta de `getOrderAuditTrail`: `{ events, historySince }`, del mas viejo al mas nuevo. Cada evento se
 * construye con una lista EXPLICITA de claves (RF_18): lo que traiga el documento y no se copie aqui no sale.
 * El filtro financiero del `seller_logistics` lo aplica la callable antes de llamar aqui.
 */
export function buildAuditTrailResponse(input: AuditTrailInput): AuditTrailResponse {
  const isStore = STORE_ROLES.has(input.role);
  const historyByEvent = new Map<string, Record<string, unknown>>();
  for (const historyRow of input.history) {
    const auditEventId = optionalText(historyRow.auditEventId);
    if (auditEventId && !historyByEvent.has(auditEventId)) historyByEvent.set(auditEventId, historyRow);
  }
  const verified = new Set(historyByEvent.keys());

  const events = input.events
    .map((row) => ({ row, id: String(row.id ?? ""), action: String(row.action ?? ""), createdAt: String(row.createdAt ?? "") }))
    .filter((entry) => !isStore || isStoreVisibleEvent({ id: entry.id, action: entry.action }, verified))
    // Comparacion de cadenas ISO, no `localeCompare` (docs/rendimiento.md). `sort` es estable.
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))
    .map(({ row, id, action, createdAt }): AuditTrailEvent => {
      const historyRow = id ? historyByEvent.get(id) : undefined;
      const event: AuditTrailEvent = {
        id,
        createdAt,
        action,
        summary: isStore ? storeSafeSummary(action, row.summary) : typeof row.summary === "string" ? row.summary : ""
      };
      const fromStatus = optionalText(row.fromStatus);
      const toStatus = optionalText(row.toStatus);
      const origin = optionalText(historyRow?.origin) ?? optionalText(row.origin);
      if (fromStatus) event.fromStatus = fromStatus;
      if (toStatus) event.toStatus = toStatus;
      if (origin) event.origin = origin;
      if (historyRow) event.changes = Array.isArray(historyRow.changes) ? historyRow.changes.map(toStoreChange) : [];

      if (isStore) {
        event.actorTag = storeActorTag(row.actorRole);
        return event;
      }

      const actorId = String(row.actorId ?? "unknown");
      const actor = input.actors?.get(actorId);
      event.actorId = actorId;
      event.actorLabel = actor?.label ?? actorId;
      const actorEmail = optionalText(actor?.email);
      if (actorEmail) event.actorEmail = actorEmail;
      const actorRole = optionalText(row.actorRole);
      if (actorRole) event.actorRole = actorRole;

      if (input.role === "admin" && isApiEvent(row, historyRow)) {
        const keyLast4 = optionalText(row.apiKeyLast4) ?? historyKeyLast4(historyRow);
        if (keyLast4) event.apiKeyLast4 = keyLast4;
        event.actorLabel = `Clave de escritura de ${input.sellerName}`;
      }
      return event;
    });

  return { events, historySince: input.historySince };
}
