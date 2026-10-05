/**
 * Nucleo de las acciones de tienda sobre un pedido (spec 029, plan 2.2 y 4.1): confirmar, corregir datos
 * de entrega y anular. PURO: sin firebase-admin ni firebase-functions. Decide, no escribe (mismo patron que
 * `order-import-merge.ts` y `order-corrections-plan.ts`).
 *
 * Lo comparten el panel (callables de `orders.ts`) y la Store API (`store-api-write.ts`) a traves del
 * ejecutor transaccional (`order-seller-actions-run.ts`). Lo que difiere entre los dos canales es POLITICA
 * (`"panel"` / `"api"`), declarada aqui, no codigo duplicado en cada adaptador:
 *  - panel: las precondiciones y los mensajes de hoy (confirmar solo `imported`, anular segun rol);
 *  - api: "editable" segun el glosario (`isApiEditable`), no-op en vez de error (RF_05, RF_15) y el motivo
 *    de anular obligatorio.
 *
 * Orden de evaluacion (pasos 4-9 de la precedencia, decision 12 de la spec). La primera regla que aplica
 * responde:
 *   4) pedido de otra tienda → 404 `order_not_found`;
 *   5) 409 por estado (`order_cancelled`, `address_review_pending`, `order_not_editable`);
 *   6) 422 de validacion (`validation_failed` / `field_not_allowed`);
 *   7) sin cambios → `unchanged`, sin evento ni historial;
 *   8) `expectedStatus` presente y distinto → 409 `status_changed`. Va el ultimo a proposito: un no-op o un
 *      estado que bloquea responden lo suyo aunque `expectedStatus` no coincida;
 *   9) aplicar.
 *
 * Los parches conservan la forma de hoy: confirmar escribe `addressRisk`/`status`/`confirmedVia`, y anular
 * escribe `driverId: current.driverId ?? null` (en un editable vale `null`; en el panel, un admin que anula
 * un pedido asignado conserva su lider). El ejecutor los aplica con `merge`, asi que emitir solo lo que
 * cambia equivale al `{ ...current, ... }` de las callables de hoy.
 */
import { orderOwnsInventoryReservation } from "./inventory-movements";
import { CLOSED_STATUSES } from "./order-import-merge";
import { stripUndefined } from "./wallet-entries";

// ---------------------------------------------------------------------------------------------------
// Tipos (plan 4.1 y 4.2)
// ---------------------------------------------------------------------------------------------------

export type SellerActionPolicy = "panel" | "api";
export type SellerActor =
  | { kind: "user"; uid: string; role: "admin" | "seller" | "seller_logistics"; sellerId?: string }
  | { kind: "api"; sellerId: string; keyLast4: string };

export type DeliveryField = "customerName" | "customerPhone" | "addressRaw" | "deliveryNotes" | "cityId";
export type DeliveryInput = Partial<Record<Exclude<DeliveryField, "deliveryNotes">, string>> & {
  /** api: `null` o `""` = borrar (RF_09); panel: en blanco = conservar (hoy). */
  deliveryNotes?: string | null;
};

/**
 * Solo politica "panel": lo que hoy edita `updateImportedOrder` ademas de los datos de entrega, con los
 * mismos nombres de campo que escribe hoy. El adaptador lo arma (lineItems ya resueltos con
 * `resolveEditedOrderLines`); el nucleo lo mete en el parche con el sello.
 */
export type PanelEditExtras = {
  lineItems?: unknown[];
  productName?: string;
  sku?: string;
  quantity?: number;
  paymentMethod?: string;
  dispatchMode?: string;
  totalCop?: number;
  zoneId?: string | null;
  normalizedAddress?: string | null;
  [otherFieldWrittenTodayByUpdateImportedOrder: string]: unknown;
};

/** Errores de campo calculados por `parseWriteBody` (T8) en el paso 3 y respondidos aqui en el paso 6. */
export type FieldProblem = {
  field: string;
  code: "required" | "empty" | "too_long" | "invalid_phone" | "not_allowed" | "invalid_type";
};

export const API_EDITABLE_STATUSES = ["imported", "address_risk", "ready_to_assign"] as const;
export const ADDRESS_DERIVED_FIELDS = ["normalizedAddress", "lat", "lng", "geoProvider"] as const;

/** Motivo de anular por API: obligatorio, recortado, 1-500 (plan 4.4). */
export const CANCEL_REASON_MAX_LENGTH = 500;

export type CityFact = { id: string; active: boolean };

/**
 * Codigo con el que el adaptador del panel traduce `panel_precondition` a `HttpsError`. No esta en la
 * forma del plan 4.1, que solo trae `message`: sin el, el adaptador tendria que adivinar si el rechazo de
 * hoy era `permission-denied` (pedido de otra tienda) o `failed-precondition` (estado).
 */
export type PanelRejectionCode = "permission-denied" | "failed-precondition";

export type SellerActionRejection =
  | { code: "order_not_found" }
  | { code: "order_cancelled"; status: "cancelled" }
  | { code: "address_review_pending"; status: "address_risk" }
  | { code: "order_not_editable"; status: string; hasLeader: boolean }
  | { code: "field_not_allowed" | "validation_failed"; fields: FieldProblem[] }
  | { code: "no_fields" }
  | { code: "out_of_coverage"; field: "cityId" }
  | { code: "status_changed"; status: string }
  | { code: "panel_precondition"; message: string; httpsCode: PanelRejectionCode };

export type OrderHistoryOrigin = "api" | "panel";
export type OrderHistoryField = "status" | DeliveryField | "totalCop" | "productName" | "sku" | "quantity";
export type OrderHistoryChange = {
  field: OrderHistoryField;
  from: string | number | null;
  to: string | number | null;
};
export type OrderHistoryActor = { kind: "api"; keyLast4: string } | { kind: "user"; uid: string; role: string };

/** `orderHistory/{autoId}` tal como queda guardado (plan 4.2). */
export type OrderHistoryDoc = {
  id: string;
  orderId: string;
  sellerId: string;
  createdAt: string;
  origin: OrderHistoryOrigin;
  action: string;
  changes: OrderHistoryChange[];
  auditEventId: string;
  actor: OrderHistoryActor;
};

/**
 * Lo que devuelve el planificador: el registro sin los dos ids, que solo existen dentro de la transaccion
 * (el ejecutor crea las referencias y rellena `id` y `auditEventId`, que enlaza con el evento de la misma
 * escritura).
 */
export type OrderHistoryDraft = Omit<OrderHistoryDoc, "id" | "auditEventId">;

/** Evento de `auditEvents` sin `id` (lo pone el ejecutor al crear la referencia). */
export type AuditEventDoc = {
  actorId: string;
  actorRole: string;
  origin: OrderHistoryOrigin;
  apiKeyLast4?: string;
  action: string;
  entity: "order";
  entityId: string;
  fromStatus?: string;
  toStatus?: string;
  summary: string;
  createdAt: string;
};

export type SellerActionPlan = {
  outcome: "applied" | "unchanged";
  /** Ya con stripUndefined; vacio si `unchanged`. */
  patch: Record<string, unknown>;
  /** Claves a `FieldValue.delete()`. */
  clear: string[];
  audit: AuditEventDoc | null;
  /** `null` si no hay cambios en campos registrados. */
  history: OrderHistoryDraft | null;
  inventory: "release" | "none";
};

export type PlanInput<T> = {
  policy: SellerActionPolicy;
  actor: SellerActor;
  order: Record<string, unknown> & { id: string };
  input: T;
  now: string;
};

export type ConfirmInput = { expectedStatus?: string };
export type CancelInput = { reason?: string; expectedStatus?: string; fieldProblems?: FieldProblem[] };

// ---------------------------------------------------------------------------------------------------
// Piezas comunes a las tres acciones
// ---------------------------------------------------------------------------------------------------

/** Lider asignado: `driverId` nulo, ausente o `""` es "sin lider"; cualquier otro valor cuenta como lider. */
function hasLeader(order: { driverId?: unknown } | Record<string, unknown>): boolean {
  const driverId = (order as { driverId?: unknown }).driverId;
  return driverId !== null && driverId !== undefined && driverId !== "";
}

/** Glosario de la spec: editable por API = estado temprano Y sin lider. */
export function isApiEditable(order: { status?: string; driverId?: string | null }): boolean {
  return (API_EDITABLE_STATUSES as readonly string[]).includes(String(order.status ?? "")) && !hasLeader(order);
}

/** Paso 4. El admin ve cualquier tienda; tienda y key solo la suya (sin claim de tienda = ninguna). */
function belongsToActor(actor: SellerActor, order: Record<string, unknown>): boolean {
  if (actor.kind === "user" && actor.role === "admin") return true;
  return String(order.sellerId ?? "") === actor.sellerId;
}

function storeRejection(policy: SellerActionPolicy, panelMessage: string): SellerActionRejection {
  // En la API un pedido ajeno es indistinguible de uno inexistente (404); el panel conserva su error de hoy.
  return policy === "api"
    ? { code: "order_not_found" }
    : { code: "panel_precondition", message: panelMessage, httpsCode: "permission-denied" };
}

function panelPrecondition(message: string): SellerActionRejection {
  return { code: "panel_precondition", message, httpsCode: "failed-precondition" };
}

function statusChanged(input: { expectedStatus?: string }, status: string): SellerActionRejection | null {
  return input.expectedStatus !== undefined && input.expectedStatus !== status ? { code: "status_changed", status } : null;
}

/** 422 con los problemas recibidos tal cual; `field_not_allowed` de primer nivel si hay alguno de ese tipo. */
function fieldRejection(fields: FieldProblem[]): SellerActionRejection {
  return { code: fields.some((problem) => problem.code === "not_allowed") ? "field_not_allowed" : "validation_failed", fields };
}

function unchangedPlan(): SellerActionPlan {
  return { outcome: "unchanged", patch: {}, clear: [], audit: null, history: null, inventory: "none" };
}

function originOf(policy: SellerActionPolicy): OrderHistoryOrigin {
  return policy === "api" ? "api" : "panel";
}

function orderLabel(order: Record<string, unknown> & { id: string }): string {
  return String(order.trackingCode ?? order.shopifyOrderId ?? order.id);
}

/**
 * Quien actuo, para el `summary`. Solo el tipo de actor, nunca su identidad: la tienda ve estos textos
 * (lista permitida del plan 2.7) y no deben nombrar a nadie de Kentro.
 */
function actorLabel(actor: SellerActor): string {
  if (actor.kind === "api") return "API de la tienda";
  if (actor.role === "admin") return "admin";
  return actor.role === "seller_logistics" ? "logistico tienda" : "vendedor";
}

function auditEvent(
  meta: { policy: SellerActionPolicy; actor: SellerActor; order: Record<string, unknown> & { id: string }; now: string },
  event: { action: string; fromStatus?: string; toStatus?: string; summary: string }
): AuditEventDoc {
  const { actor, order, now, policy } = meta;
  return stripUndefined({
    actorId: actor.kind === "api" ? "store-api" : actor.uid,
    actorRole: actor.kind === "api" ? "store_api" : actor.role,
    origin: originOf(policy),
    apiKeyLast4: actor.kind === "api" ? actor.keyLast4 : undefined,
    action: event.action,
    entity: "order" as const,
    entityId: order.id,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    summary: event.summary,
    createdAt: now
  });
}

/**
 * Registro de historial de una escritura. Devuelve `null` si no hay cambios (un registro vacio no se
 * escribe: RF_05, RF_15). T5 pondra encima `buildOrderHistoryRecord`, el diff de los campos registrados.
 */
function historyDraft(
  meta: { policy: SellerActionPolicy; actor: SellerActor; order: Record<string, unknown> & { id: string }; now: string },
  action: string,
  changes: OrderHistoryChange[]
): OrderHistoryDraft | null {
  if (changes.length === 0) return null;
  const { actor, order, now, policy } = meta;
  return {
    orderId: order.id,
    sellerId: String(order.sellerId ?? ""),
    createdAt: now,
    origin: originOf(policy),
    action,
    changes,
    actor: actor.kind === "api" ? { kind: "api", keyLast4: actor.keyLast4 } : { kind: "user", uid: actor.uid, role: actor.role }
  };
}

// ---------------------------------------------------------------------------------------------------
// Confirmar
// ---------------------------------------------------------------------------------------------------

/**
 * `imported` → `ready_to_assign`. En la API, confirmar algo ya confirmado (o posterior) es un no-op, y un
 * `address_risk` responde 409 aunque no tenga lider: RF_21 prevalece sobre `order_not_editable`, porque lo
 * que la tienda tiene que hacer es corregir la direccion, no esperar. `planConfirm` no recibe errores de
 * campo: su cuerpo invalido ya se respondio con 400 en el paso 3 (decision 13).
 */
export function planConfirm(i: PlanInput<ConfirmInput>): SellerActionRejection | SellerActionPlan {
  const { policy, actor, order, input, now } = i;
  const status = String(order.status ?? "");

  if (!belongsToActor(actor, order)) return storeRejection(policy, "Sellers can only confirm their own orders.");

  if (policy === "panel") {
    if (status !== "imported") return panelPrecondition("Only imported orders can be confirmed.");
  } else {
    if (status === "cancelled") return { code: "order_cancelled", status: "cancelled" };
    if (status === "address_risk") return { code: "address_review_pending", status: "address_risk" };
    if (status === "imported" && hasLeader(order)) return { code: "order_not_editable", status, hasLeader: true };
    if (status !== "imported") return unchangedPlan();
  }

  const conflict = statusChanged(input, status);
  if (conflict) return conflict;

  const meta = { policy, actor, order, now };
  return {
    outcome: "applied",
    patch: {
      addressRisk: "accepted",
      status: "ready_to_assign",
      // Deja explicito quien confirmo, para contrastarlo con las confirmaciones automaticas del bot
      // ("uchat" / "uchat_pull"): una persona en el panel o la integracion de la tienda.
      confirmedVia: policy === "api" ? "api" : "manual",
      updatedAt: now
    },
    clear: [],
    audit: auditEvent(meta, {
      action: "order.seller_confirmed",
      fromStatus: "imported",
      toStatus: "ready_to_assign",
      summary: `Pedido ${orderLabel(order)} confirmado por ${actorLabel(actor)}`
    }),
    history: historyDraft(meta, "order.seller_confirmed", [{ field: "status", from: "imported", to: "ready_to_assign" }]),
    inventory: "none"
  };
}

// ---------------------------------------------------------------------------------------------------
// Corregir datos de entrega (T5)
// ---------------------------------------------------------------------------------------------------

// T5: validateDeliveryInput, planDeliveryCorrection y buildOrderHistoryRecord van aqui, con las mismas
// piezas comunes de arriba (tienda, 409 por estado, fieldRejection, unchangedPlan, statusChanged).

// ---------------------------------------------------------------------------------------------------
// Anular
// ---------------------------------------------------------------------------------------------------

/** Estados en los que una tienda ya no puede anular desde el panel (hoy, en `cancelOrder`). */
const PANEL_SELLER_COLLECTED_STATUSES = new Set(["call_pending", "scheduled", "pickup_pending", "picked_up", "in_route", "retry_pending"]);

/**
 * Motivo de anular por API. Si `parseWriteBody` ya anoto problemas, se responden esos tal cual; si no (o
 * si alguien llama sin pasar por el), el nucleo no deja pasar un motivo ausente, vacio o largo.
 */
function cancelReasonProblems(input: CancelInput): FieldProblem[] {
  if (input.fieldProblems && input.fieldProblems.length > 0) return input.fieldProblems;
  if (input.reason === undefined || input.reason === null) return [{ field: "reason", code: "required" }];
  if (typeof input.reason !== "string") return [{ field: "reason", code: "invalid_type" }];
  const reason = input.reason.trim();
  if (reason === "") return [{ field: "reason", code: "empty" }];
  if (reason.length > CANCEL_REASON_MAX_LENGTH) return [{ field: "reason", code: "too_long" }];
  return [];
}

/**
 * → `cancelled`. En la API solo un editable (RF_14) y con motivo; anular lo ya anulado es un no-op (RF_15),
 * pero el motivo se valida antes (paso 6 antes que 7). En el panel, las precondiciones por rol de hoy: el
 * admin anula cualquier pedido no cerrado; la tienda, cualquiera que no se haya recogido.
 */
export function planCancel(i: PlanInput<CancelInput>): SellerActionRejection | SellerActionPlan {
  const { policy, actor, order, input, now } = i;
  const status = String(order.status ?? "");

  if (!belongsToActor(actor, order)) return storeRejection(policy, "Sellers can only cancel their own orders.");

  if (policy === "panel") {
    if ((CLOSED_STATUSES as readonly string[]).includes(status)) return panelPrecondition("Closed orders cannot be cancelled.");
    if (actor.kind === "user" && actor.role !== "admin" && PANEL_SELLER_COLLECTED_STATUSES.has(status)) {
      return panelPrecondition("This order was already collected. Only an admin can cancel it.");
    }
    if (input.fieldProblems && input.fieldProblems.length > 0) return fieldRejection(input.fieldProblems);
  } else {
    if (status !== "cancelled" && !isApiEditable(order as { status?: string; driverId?: string | null })) {
      return { code: "order_not_editable", status, hasLeader: hasLeader(order) };
    }
    const problems = cancelReasonProblems(input);
    if (problems.length > 0) return fieldRejection(problems);
    if (status === "cancelled") return unchangedPlan();
  }

  const conflict = statusChanged(input, status);
  if (conflict) return conflict;

  // Solo libera quien reservo, y un `imported` nunca reservo (misma regla que `cancelOrder`).
  const releasesInventory = orderOwnsInventoryReservation({ inventoryReserved: order.inventoryReserved }) && status !== "imported";
  const meta = { policy, actor, order, now };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  return {
    outcome: "applied",
    patch: stripUndefined({
      status: "cancelled",
      closedAt: now,
      driverId: order.driverId ?? null,
      // Panel: sin motivo se conserva la nota de hoy. API: el motivo ya es obligatorio y no vacio.
      callNote: reason || order.callNote,
      updatedAt: now
    }),
    clear: [],
    audit: auditEvent(meta, {
      action: "order.cancelled",
      fromStatus: status,
      toStatus: "cancelled",
      summary: `Pedido ${orderLabel(order)} anulado por ${actorLabel(actor)}`
    }),
    history: historyDraft(meta, "order.cancelled", [{ field: "status", from: status, to: "cancelled" }]),
    inventory: releasesInventory ? "release" : "none"
  };
}
