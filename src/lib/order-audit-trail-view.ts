/**
 * Spec 029 · T19 — modelo de vista del "Historial del pedido" (RF_27, RF_17, RF_24).
 *
 * Puro: sin React ni Firebase. Recibe lo que devuelve `getOrderAuditTrail` y decide que se pinta; la
 * pantalla (T22) solo pinta lo que sale de aqui. Textos: README del diseno, decisiones 8-16.
 *
 * Lo que la tienda recibe ya viene filtrado por el servidor; aun asi este modulo nunca pone en la vista de la
 * tienda nombre, correo, rol ni uid (RF_27): la tienda solo ve la pildora de origen.
 */
import { formatCop } from "./finance";
import { statusLabel } from "./order-export";
import { formatBogotaDate, formatKeyDateTime } from "./store-api-keys-view";
import type { OrderAuditEntry, OrderAuditTrail, OrderStatus } from "./types";
import type { OrderHistoryField } from "../../functions/src/order-seller-actions";

/** Decision 15. Un `OrderHistoryField` sin fila aqui no compila (y la guarda de T19 lo caza). */
export const HISTORY_FIELD_LABELS: Record<OrderHistoryField, string> = {
  status: "Estado",
  customerName: "Cliente",
  customerPhone: "Telefono",
  addressRaw: "Direccion",
  deliveryNotes: "Indicaciones",
  cityId: "Ciudad",
  totalCop: "Valor",
  productName: "Producto",
  sku: "SKU",
  quantity: "Cantidad"
};

function isHistoryField(field: unknown): field is OrderHistoryField {
  return typeof field === "string" && Object.prototype.hasOwnProperty.call(HISTORY_FIELD_LABELS, field);
}

/** Nombre visible de un campo, o `null` si no esta en la tabla: nunca se inventa ni se pinta el crudo. */
export function historyFieldLabel(field: unknown): string | null {
  return isHistoryField(field) ? HISTORY_FIELD_LABELS[field] : null;
}

/**
 * Etiquetas de las acciones de auditoria. El backend construye algunas dinamicamente
 * (order.delivered / order.failed / order.retry_scheduled), asi que cualquier accion que no este aqui cae al
 * nombre crudo en vez de quedar en blanco.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "order.webhook_imported": "Importado por webhook",
  "order.manual_created": "Creado a mano",
  "order.imported_updated": "Editado antes de confirmar",
  "order.seller_confirmed": "Confirmado",
  "order.confirmed_uchat": "Confirmado por el bot",
  "order.transition": "Cambio de estado",
  "order.adjusted": "Ajustado",
  "order.cancelled": "Anulado",
  "order.delivered": "Entregado",
  "order.failed": "Fallido",
  "order.retry_scheduled": "Visita reagendada",
  "order.retry_confirmed": "Reintento confirmado",
  "order.failed_classified": "Fallido clasificado",
  "order.messenger_assigned": "Mensajero asignado",
  "order.messenger_reassigned": "Mensajero reasignado",
  "order.messenger_unassigned": "Mensajero retirado",
  "order.delivery_corrected": "Datos de entrega corregidos",
  "order.address_reviewed": "Direccion revisada",
  "order.picked_up": "Recogido",
  "order.correct_failed_to_delivered": "Corregido a entregado",
  "order.correct_delivered_to_failed": "Corregido a fallido",
  "order.correct_cancelled_to_operational": "Reactivado tras anulacion",
  "order.reopened_for_retry": "Reabierto para nueva visita",
  // Escritas por los scripts one-off que la correccion desde la UI reemplaza.
  "order.correct_cancelled_to_delivered": "Corregido a entregado (script)",
  "order.correct_delivered_to_chargeable_failed": "Corregido a fallido con cobro (script)",
  "order.clawback_delivered_financials": "Reversa de entrega (script)",
  "order.correct_retry_to_failed": "Reintento cerrado como fallido (script)"
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export const CHANGE_LABELS = { before: "Antes", after: "Ahora" } as const;
export const EMPTY_VALUE_TEXT = "Sin dato";

/** Acciones cuyo `summary` lleva ids de mensajero: a la tienda nunca se le pinta (decision 16). */
const MESSENGER_ACTIONS = new Set(["order.messenger_assigned", "order.messenger_unassigned", "order.messenger_reassigned"]);

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Valor de un lado de "Antes/Ahora" con el formato de la decision 15. */
export function formatHistoryValue(field: string, value: unknown, options?: { cityNames?: Record<string, string> }): string {
  if (isBlank(value)) return EMPTY_VALUE_TEXT;
  switch (field) {
    case "status":
      return statusLabel(String(value) as OrderStatus);
    case "totalCop": {
      const amount = typeof value === "number" ? value : Number(value);
      return Number.isFinite(amount) ? formatCop(amount) : EMPTY_VALUE_TEXT;
    }
    case "cityId":
      // Nunca el id (decision 15): sin nombre conocido se escribe "Sin dato".
      return options?.cityNames?.[String(value)] ?? EMPTY_VALUE_TEXT;
    default:
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : EMPTY_VALUE_TEXT;
  }
}

/** "6 oct 2026, 09:12" en hora de Bogota. */
export function formatHistoryDateTime(iso: string): string {
  return formatKeyDateTime(iso);
}

/** "6 oct 2026" en hora de Bogota. */
export function formatHistoryDate(iso: string): string {
  return formatBogotaDate(iso);
}

export type HistoryScopeNote = { name: "Que incluye el historial"; title: string; body: string };

/** Nota de alcance (decision 9). La fecha sale de `historySince`; sin ella no hay nota. */
export function buildHistoryScopeNote(historySince: string | null, viewport: "mobile" | "desktop"): HistoryScopeNote | null {
  if (!historySince) return null;
  const date = formatHistoryDate(historySince);
  if (!date) return null;
  return {
    name: "Que incluye el historial",
    title: `Campo por campo desde el ${date}.`,
    body:
      viewport === "desktop"
        ? "No incluye los cambios de importaciones (Shopify y webhooks de tienda) ni la confirmacion automatica de ChatBy."
        : "No incluye importaciones de Shopify ni webhooks de tienda, ni ChatBy."
  };
}

export type AuditTrailViewer = "admin" | "store";
export type AuditTrailLoad = { status: "loading" } | { status: "error" } | { status: "loaded"; trail: OrderAuditTrail };

export type OrderAuditEventView = {
  id: string;
  dateText: string;
  origin: { text: "API" | "Kentro" | "Tu tienda" | "Panel"; tone: "info" | "muted" };
  actionLabel: string;
  transition: string | null;
  changes: { label: string; before: string; after: string }[];
  summary: string | null;
  who: { line: string; keyLine: string | null } | null;
};

export type OrderAuditTrailView = {
  state: "loading" | "error" | "empty" | "events";
  statusText: string | null;
  alert: { title: string; body: string; retryLabel: string } | null;
  note: HistoryScopeNote | null;
  empty: { title: string; body: string } | null;
  events: OrderAuditEventView[];
};

function isApiEvent(event: OrderAuditEntry): boolean {
  return event.origin === "api" || event.actorRole === "store_api";
}

function eventOrigin(event: OrderAuditEntry, viewer: AuditTrailViewer): OrderAuditEventView["origin"] {
  if (viewer === "store") {
    const tag = event.actorTag ?? "Kentro";
    return { text: tag, tone: tag === "API" ? "info" : "muted" };
  }
  return isApiEvent(event) ? { text: "API", tone: "info" } : { text: "Panel", tone: "muted" };
}

/** Linea de quien, solo para el admin (decision 12). */
function adminWho(event: OrderAuditEntry): OrderAuditEventView["who"] {
  if (isApiEvent(event)) {
    return {
      line: event.actorLabel || "Clave de escritura",
      keyLine: event.apiKeyLast4 ? `termina en ${event.apiKeyLast4}` : null
    };
  }
  const name = event.actorLabel || event.actorId || "Sistema";
  const withEmail = event.actorEmail ? `${name} (${event.actorEmail})` : name;
  return { line: event.actorRole ? `${withEmail} · ${event.actorRole}` : withEmail, keyLine: null };
}

function eventChanges(event: OrderAuditEntry, cityNames?: Record<string, string>): OrderAuditEventView["changes"] {
  return (event.changes ?? []).flatMap((change) => {
    const label = historyFieldLabel(change.field);
    if (!label) return [];
    const field = change.field as string;
    return [
      {
        label,
        before: formatHistoryValue(field, change.from, { cityNames }),
        after: formatHistoryValue(field, change.to, { cityNames })
      }
    ];
  });
}

function eventView(event: OrderAuditEntry, viewer: AuditTrailViewer, cityNames?: Record<string, string>): OrderAuditEventView {
  const changes = eventChanges(event, cityNames);
  const hideSummary = changes.length > 0 || (viewer === "store" && MESSENGER_ACTIONS.has(event.action));
  const summary = hideSummary || isBlank(event.summary) ? null : event.summary;
  return {
    id: event.id,
    dateText: formatHistoryDateTime(event.createdAt),
    origin: eventOrigin(event, viewer),
    actionLabel: auditActionLabel(event.action),
    transition:
      event.fromStatus && event.toStatus
        ? `${statusLabel(event.fromStatus as OrderStatus)} → ${statusLabel(event.toStatus as OrderStatus)}`
        : null,
    changes,
    summary,
    who: viewer === "admin" ? adminWho(event) : null
  };
}

function timeOf(iso: string): number {
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function buildOrderAuditTrailView(input: {
  viewer: AuditTrailViewer;
  viewport: "mobile" | "desktop";
  load: AuditTrailLoad;
  cityNames?: Record<string, string>;
}): OrderAuditTrailView {
  const base: OrderAuditTrailView = { state: "loading", statusText: null, alert: null, note: null, empty: null, events: [] };
  const { load } = input;

  if (load.status === "loading") return { ...base, statusText: "Cargando historial..." };
  if (load.status === "error") {
    return {
      ...base,
      state: "error",
      alert: {
        title: "No se pudo cargar el historial",
        body: "Revisa la conexion y vuelve a intentarlo. El pedido no ha cambiado por esto.",
        retryLabel: "Reintentar"
      }
    };
  }

  const { events, historySince } = load.trail;
  const note = buildHistoryScopeNote(historySince, input.viewport);

  if (events.length === 0) {
    const since = historySince ? formatHistoryDate(historySince) : "";
    return {
      ...base,
      state: "empty",
      note,
      empty: {
        title: "Sin cambios registrados",
        body: since
          ? `Este pedido no tiene cambios desde el ${since} ni eventos anteriores.`
          : "Este pedido no tiene cambios ni eventos registrados."
      }
    };
  }

  // Del mas viejo al mas nuevo (decision 8). Orden numerico por instante; `sort` es estable.
  const ordered = [...events].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
  return {
    ...base,
    state: "events",
    note,
    events: ordered.map((event) => eventView(event, input.viewer, input.cityNames))
  };
}
