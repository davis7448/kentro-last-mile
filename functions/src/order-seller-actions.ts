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
import { CLOSED_STATUSES, MANUAL_EDIT_STAMP } from "./order-import-merge";
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
 * Registro de historial de una escritura de este modulo: el diff de los campos registrados entre el pedido
 * leido y como queda tras el parche. `null` si no hay cambios (un registro vacio no se escribe: RF_05, RF_15).
 */
function historyDraft(
  meta: { policy: SellerActionPolicy; actor: SellerActor; order: Record<string, unknown> & { id: string }; now: string },
  action: string,
  after: Record<string, unknown>
): OrderHistoryDraft | null {
  const { actor, order, now, policy } = meta;
  return buildOrderHistoryRecord(order, after, {
    orderId: order.id,
    sellerId: String(order.sellerId ?? ""),
    origin: originOf(policy),
    action,
    actor,
    now
  });
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
    history: historyDraft(meta, "order.seller_confirmed", { ...order, status: "ready_to_assign" }),
    inventory: "none"
  };
}

// ---------------------------------------------------------------------------------------------------
// Corregir datos de entrega (T5)
// ---------------------------------------------------------------------------------------------------

export type DeliveryCorrectionInput = DeliveryInput & {
  expectedStatus?: string;
  /** La ciudad de `cityId`, leida en la transaccion; `null` si no existe o no se envio `cityId`. */
  city: CityFact | null;
  panelExtras?: PanelEditExtras;
  fieldProblems?: FieldProblem[];
};

/** Orden fijo: el de los problemas devueltos y el de los cambios del historial. */
const DELIVERY_FIELDS: readonly DeliveryField[] = ["customerName", "customerPhone", "addressRaw", "deliveryNotes", "cityId"];
const HISTORY_FIELDS: readonly OrderHistoryField[] = ["status", ...DELIVERY_FIELDS, "totalCop", "productName", "sku", "quantity"];

const TEXT_MAX_LENGTH: Partial<Record<DeliveryField, number>> = { customerName: 120, addressRaw: 300, deliveryNotes: 500 };
const CITY_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const CITY_ID_MAX_LENGTH = 64;
const PHONE_SEPARATORS = /[\s\-.()]/g;
const PHONE_PATTERNS = [/^\d{10}$/, /^\+57\d{10}$/, /^\+[1-9]\d{7,14}$/];

/** Clave presente en el cuerpo: `undefined` es "no enviado"; `null` si cuenta (borrar o `empty`). */
function isSent(input: Record<string, unknown>, field: DeliveryField): boolean {
  return input[field] !== undefined;
}

function isValidPhone(phone: string): boolean {
  const compact = phone.replace(PHONE_SEPARATORS, "");
  return PHONE_PATTERNS.some((pattern) => pattern.test(compact));
}

function deliveryFieldProblem(field: DeliveryField, value: unknown): FieldProblem | null {
  if (field === "deliveryNotes") {
    // Unica excepcion de RF_09: null, "" o en blanco borran las indicaciones.
    if (value === null) return null;
    if (typeof value !== "string") return { field, code: "invalid_type" };
    return value.trim().length > (TEXT_MAX_LENGTH.deliveryNotes ?? 0) ? { field, code: "too_long" } : null;
  }
  if (value === null) return { field, code: "empty" };
  if (typeof value !== "string") return { field, code: "invalid_type" };
  const trimmed = value.trim();
  if (trimmed === "") return { field, code: "empty" };
  if (field === "customerPhone") return isValidPhone(trimmed) ? null : { field, code: "invalid_phone" };
  if (field === "cityId") {
    if (CITY_ID_PATTERN.test(trimmed)) return null;
    return { field, code: trimmed.length > CITY_ID_MAX_LENGTH ? "too_long" : "invalid_type" };
  }
  const max = TEXT_MAX_LENGTH[field];
  return max !== undefined && trimmed.length > max ? { field, code: "too_long" } : null;
}

/**
 * Reglas de contenido de la tabla 4.4 para los datos de entrega. Solo mira las claves enviadas y devuelve
 * TODOS los problemas a la vez. `no_fields` no es asunto suyo: lo decide el planificador.
 */
export function validateDeliveryInput(input: DeliveryInput): FieldProblem[] {
  const body = input as Record<string, unknown>;
  const problems: FieldProblem[] = [];
  for (const field of DELIVERY_FIELDS) {
    if (!isSent(body, field)) continue;
    const problem = deliveryFieldProblem(field, body[field]);
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * Valor que quedaria guardado para un campo enviado, o `undefined` si el envio no toca el campo. En la API
 * unas indicaciones vacias borran (`null`); en el panel se conservan, como hoy hace `updateImportedOrder`.
 */
function sentDeliveryValue(policy: SellerActionPolicy, field: DeliveryField, value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (field === "deliveryNotes" && trimmed === "") return policy === "api" ? null : undefined;
  return trimmed;
}

/** Ausente y `null` son lo mismo para comparar y registrar. */
function historyValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  return typeof value === "number" || typeof value === "string" ? value : String(value);
}

/**
 * El registro de `orderHistory` de una escritura: el diff de los campos registrados (plan 2.5) entre el pedido
 * leido y como queda. Nunca `driverId`, `messengerId` ni `pickupBatchId`: no estan en la lista. `null` si no
 * cambio ninguno. Lo usan el ejecutor (via los planificadores) y, en T15/T16, las callables que ya tienen el id
 * de su evento (`auditEventId`).
 */
export function buildOrderHistoryRecord(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  meta: {
    orderId: string;
    sellerId: string;
    origin: OrderHistoryOrigin;
    action: string;
    actor: SellerActor;
    now: string;
    auditEventId?: string;
  }
): (OrderHistoryDraft & { auditEventId?: string }) | null {
  const changes: OrderHistoryChange[] = [];
  for (const field of HISTORY_FIELDS) {
    const from = historyValue(before[field]);
    const to = historyValue(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  if (changes.length === 0) return null;
  const { actor } = meta;
  return stripUndefined({
    orderId: meta.orderId,
    sellerId: meta.sellerId,
    createdAt: meta.now,
    origin: meta.origin,
    action: meta.action,
    changes,
    auditEventId: meta.auditEventId,
    actor: actor.kind === "api" ? { kind: "api" as const, keyLast4: actor.keyLast4 } : { kind: "user" as const, uid: actor.uid, role: actor.role }
  });
}

/** Paso 6 de la API: errores de campo, `no_fields` y cobertura de la ciudad (aunque sea la misma, RF_10). */
function apiDeliveryRejection(input: DeliveryCorrectionInput): SellerActionRejection | null {
  const body = input as Record<string, unknown>;
  const problems = input.fieldProblems && input.fieldProblems.length > 0 ? input.fieldProblems : validateDeliveryInput(input);
  if (problems.length > 0) return fieldRejection(problems);
  if (!DELIVERY_FIELDS.some((field) => isSent(body, field))) return { code: "no_fields" };
  if (isSent(body, "cityId")) {
    const cityId = String(body.cityId).trim();
    if (!input.city || input.city.id !== cityId || input.city.active !== true) return { code: "out_of_coverage", field: "cityId" };
  }
  return null;
}

/**
 * Corregir datos de entrega (plan 4.1): `PATCH` de la API y `updateImportedOrder` del panel.
 *
 * API: solo un editable; valida por su cuenta si no llegan `fieldProblems`; un `address_risk` sin lider vuelve a
 * `imported` con `addressRisk: "review"` aunque no cambie nada (RF_22, la unica forma de desbloquearlo); si
 * cambia la direccion se borran los derivados (RF_23). Panel: solo `imported`, sus mensajes de hoy, y cada
 * guardado es un cambio (escribe `panelExtras`, sello y evento siempre, como hoy).
 */
export function planDeliveryCorrection(i: PlanInput<DeliveryCorrectionInput>): SellerActionRejection | SellerActionPlan {
  const { policy, actor, order, input, now } = i;
  if (policy === "api" && input.panelExtras !== undefined) {
    throw new Error("panelExtras solo existe con politica panel: la validacion de la API nunca lo produce.");
  }
  const status = String(order.status ?? "");

  if (!belongsToActor(actor, order)) return storeRejection(policy, "Sellers can only edit their own orders.");

  if (policy === "panel") {
    if (status !== "imported") return panelPrecondition("Only imported orders pending confirmation can be edited.");
    if (input.fieldProblems && input.fieldProblems.length > 0) return fieldRejection(input.fieldProblems);
  } else {
    if (!isApiEditable(order as { status?: string; driverId?: string | null })) {
      return { code: "order_not_editable", status, hasLeader: hasLeader(order) };
    }
    const rejection = apiDeliveryRejection(input);
    if (rejection) return rejection;
  }

  const body = input as Record<string, unknown>;
  const changedFields: Partial<Record<DeliveryField, string | null>> = {};
  for (const field of DELIVERY_FIELDS) {
    const next = sentDeliveryValue(policy, field, body[field]);
    if (next !== undefined && historyValue(order[field]) !== next) changedFields[field] = next;
  }
  const hasFieldChanges = Object.keys(changedFields).length > 0;
  const reviewsAddress = policy === "api" && status === "address_risk";

  if (policy === "api" && !hasFieldChanges && !reviewsAddress) return unchangedPlan();

  const conflict = statusChanged(input, status);
  if (conflict) return conflict;

  const clear =
    policy === "api" && changedFields.addressRaw !== undefined
      ? ADDRESS_DERIVED_FIELDS.filter((key) => order[key] !== undefined)
      : [];
  const patch = stripUndefined({
    ...changedFields,
    ...(policy === "panel" ? (input.panelExtras ?? {}) : {}),
    ...(reviewsAddress ? { status: "imported", addressRisk: "review" } : {}),
    // RF_11: la marca de edicion manual, tambien en `order.address_reviewed`: la tienda ya decidio sobre la
    // direccion y una reimportacion no debe deshacerlo.
    [MANUAL_EDIT_STAMP]: now,
    updatedAt: now
  });

  const action =
    policy === "panel" ? "order.imported_updated" : hasFieldChanges ? "order.delivery_corrected" : "order.address_reviewed";
  const label = orderLabel(order);
  const summary =
    policy === "panel"
      ? `Pedido ${label} editado antes de confirmar`
      : hasFieldChanges
        ? `Pedido ${label}: datos de entrega corregidos por ${actorLabel(actor)}`
        : `Pedido ${label}: direccion revisada por ${actorLabel(actor)}`;
  const meta = { policy, actor, order, now };
  const after: Record<string, unknown> = { ...order, ...patch };
  for (const key of clear) delete after[key];

  return {
    outcome: "applied",
    patch,
    clear,
    audit: auditEvent(meta, {
      action,
      fromStatus: reviewsAddress ? status : undefined,
      toStatus: reviewsAddress ? "imported" : undefined,
      summary
    }),
    history: historyDraft(meta, action, after),
    inventory: "none"
  };
}

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
    history: historyDraft(meta, "order.cancelled", { ...order, status: "cancelled" }),
    inventory: releasesInventory ? "release" : "none"
  };
}
