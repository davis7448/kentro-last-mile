import crypto from "node:crypto";
import { z } from "zod";
import { CANCEL_REASON_MAX_LENGTH, validateDeliveryInput } from "./order-seller-actions";
import type { DeliveryField, DeliveryInput, FieldProblem } from "./order-seller-actions";

/**
 * Peticion, errores y limite de la Store API (spec 029, plan 2.1, 2.9, 2.10, 4.3, 4.4). PURO: sin firebase-admin
 * ni firebase-functions (solo `node:crypto` para el hash), para que el handler (T10/T11) y las pruebas compartan
 * la misma regla.
 *
 * Lo que vive aqui:
 *  - Paso 0 de la precedencia (`routeStoreApiRequest`): ruta y metodo, con `Allow` por ruta.
 *  - Paso 3: parametros de consulta (`validateQueryParameters`) y forma del cuerpo (`parseConfirmBody`,
 *    `parseWriteBody`). Los errores de CAMPO de PATCH y cancelar se calculan aqui pero NO se responden: el 422
 *    sale en el paso 6, despues de 404 y 409, construido con `buildFieldError`.
 *  - El catalogo `code` -> HTTP (congelado: los codigos se agregan, no se renombran, RNF_02), los cuerpos de
 *    error, la tabla de precedencia, el hash canonico de idempotencia y el limite de tasa.
 *
 * Las reglas de contenido de los datos de entrega NO estan aqui: son de `validateDeliveryInput` (nucleo, T5).
 */

// ---------------------------------------------------------------------------------------------------------
// Catalogo de codigos (plan 4.3)
// ---------------------------------------------------------------------------------------------------------

export const STORE_API_ERROR_HTTP = Object.freeze({
  route_not_found: 404,
  unknown_parameter: 400,
  invalid_shopify_order_id: 400,
  invalid_idempotency_key: 400,
  invalid_json: 400,
  invalid_body: 400,
  missing_credentials: 401,
  invalid_key: 401,
  key_in_query: 401,
  read_only_key: 403,
  order_not_found: 404,
  method_not_allowed: 405,
  status_changed: 409,
  order_cancelled: 409,
  address_review_pending: 409,
  order_not_editable: 409,
  validation_failed: 422,
  field_not_allowed: 422,
  out_of_coverage: 422,
  no_fields: 422,
  idempotency_key_reused: 422,
  rate_limited: 429,
  history_not_ready: 503,
  internal_error: 500
} as const);

export type StoreApiErrorCode = keyof typeof STORE_API_ERROR_HTTP;

const ERROR_MESSAGES: Record<StoreApiErrorCode, string> = {
  route_not_found: "La ruta no existe. Revisa la direccion: las rutas de un pedido son /orders/{id}, /orders/{id}/history, /orders/{id}/confirm y /orders/{id}/cancel.",
  unknown_parameter: "La peticion trae parametros de consulta que esta ruta no admite.",
  invalid_shopify_order_id: "El numero de pedido de Shopify no es valido: de 1 a 64 letras, digitos o los signos # . _ -.",
  invalid_idempotency_key: "La cabecera Idempotency-Key debe tener de 1 a 255 caracteres imprimibles.",
  invalid_json: "El cuerpo de la peticion no es JSON valido.",
  invalid_body: "El cuerpo de la peticion no tiene la forma esperada para esta ruta.",
  missing_credentials: "Faltan credenciales: envia sellerId y la clave en la cabecera Authorization: Bearer <clave>.",
  invalid_key: "La clave no es valida para esta tienda, o la tienda tiene la API desactivada.",
  key_in_query: "La clave de escritura no puede ir en la URL. Enviala en la cabecera Authorization: Bearer <clave>.",
  read_only_key: "Esta clave solo permite consultar. Para confirmar o corregir pedidos usa la clave de escritura.",
  order_not_found: "No existe un pedido con ese id en esta tienda.",
  method_not_allowed: "Esta ruta no admite ese metodo. Revisa la cabecera Allow de la respuesta.",
  status_changed: "El estado del pedido cambio desde que lo consultaste. Vuelve a leerlo antes de reintentar.",
  order_cancelled: "El pedido esta anulado y ya no se puede confirmar ni corregir.",
  address_review_pending: "El pedido tiene la direccion en revision. Corrige los datos de entrega antes de confirmarlo.",
  order_not_editable: "El pedido ya esta en operacion y no se puede cambiar por la API.",
  validation_failed: "Algunos campos no son validos. Revisa la lista de campos.",
  field_not_allowed: "La peticion intenta cambiar campos que la API no permite. Revisa la lista de campos.",
  out_of_coverage: "La ciudad indicada no tiene cobertura activa.",
  no_fields: "La peticion no trae ningun dato de entrega que corregir.",
  idempotency_key_reused: "Esa Idempotency-Key ya se uso con otra peticion distinta. Usa una clave nueva.",
  rate_limited: "Demasiadas escrituras en este minuto. Espera los segundos que indica Retry-After.",
  history_not_ready: "El historial de pedidos todavia no esta disponible. Intentalo mas tarde.",
  internal_error: "Error interno. Intentalo de nuevo en unos minutos."
};

/** `{ ok: false, code, message }` mas los extras definidos (status, hasLeader, fields, activeCities...). */
export function buildErrorBody(code: StoreApiErrorCode, extras: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { ok: false, code, message: ERROR_MESSAGES[code] };
  for (const [key, value] of Object.entries(extras)) {
    if (value === undefined || key === "ok" || key === "code" || key === "message") continue;
    body[key] = value;
  }
  return body;
}

export type StoreApiFailure = {
  ok: false;
  httpStatus: number;
  code: string;
  allow?: string;
  body: Record<string, unknown>;
};

function failure(code: StoreApiErrorCode, extras?: Record<string, unknown>): StoreApiFailure {
  return { ok: false, httpStatus: STORE_API_ERROR_HTTP[code], code, body: buildErrorBody(code, extras) };
}

// ---------------------------------------------------------------------------------------------------------
// Precedencia (decision 12, plan 2.1)
// ---------------------------------------------------------------------------------------------------------

export type StoreApiPrecedenceRow = { step: string; check: string; codes: readonly string[]; where: string };

/**
 * Una sola secuencia para todas las rutas nuevas; la primera condicion que se cumple responde. Las rutas de
 * lectura nuevas usan los pasos 0-4. `history_not_ready` e `internal_error` no son pasos: son fallos del
 * servidor y pueden salir en cualquiera.
 */
export const STORE_API_PRECEDENCE: readonly StoreApiPrecedenceRow[] = Object.freeze([
  { step: "0", check: "ruta y metodo", codes: ["route_not_found", "method_not_allowed"], where: "store-api-request" },
  { step: "1", check: "key en query en una ruta de escritura", codes: ["key_in_query"], where: "store-api-auth" },
  {
    step: "2",
    check: "credenciales (tabla 2.3)",
    codes: ["missing_credentials", "invalid_key", "key_in_query", "read_only_key"],
    where: "store-api-auth"
  },
  {
    step: "3",
    check: "parametros de consulta y forma del cuerpo",
    codes: ["unknown_parameter", "invalid_json", "invalid_body", "invalid_idempotency_key", "invalid_shopify_order_id"],
    where: "store-api-request"
  },
  { step: "3a", check: "limite de tasa (solo escrituras)", codes: ["rate_limited"], where: "handler" },
  { step: "3b", check: "atajo de idempotencia (solo escrituras)", codes: ["idempotency_key_reused"], where: "handler" },
  { step: "4", check: "pedido de la tienda", codes: ["order_not_found"], where: "nucleo" },
  { step: "5", check: "estado", codes: ["order_cancelled", "address_review_pending", "order_not_editable"], where: "nucleo" },
  {
    step: "6",
    check: "validacion y cobertura",
    codes: ["field_not_allowed", "validation_failed", "no_fields", "out_of_coverage"],
    where: "nucleo + buildFieldError"
  },
  { step: "7", check: "sin cambios (200 changed: false)", codes: [], where: "nucleo" },
  { step: "8", check: "expectedStatus distinto", codes: ["status_changed"], where: "nucleo" },
  { step: "9", check: "aplicar (200 changed: true)", codes: [], where: "ejecutor" }
].map((row) => Object.freeze({ ...row, codes: Object.freeze([...row.codes]) })));

// ---------------------------------------------------------------------------------------------------------
// Paso 0: ruta y metodo
// ---------------------------------------------------------------------------------------------------------

export type StoreApiNewRoute = "order_read" | "order_history" | "order_confirm" | "order_patch" | "order_cancel";

export type StoreApiNewRouteMatch = {
  ok: true;
  kind: "new";
  route: StoreApiNewRoute;
  access: "read" | "write";
  orderId: string;
};

export type StoreApiLegacyRouteMatch = {
  ok: true;
  kind: "legacy";
  access: "legacy_read";
  /** Recurso de hoy (`orders`, `kpis`, `docs` para la raiz...); su 404 lo sigue decidiendo el handler. */
  resource: string;
};

export type StoreApiRouteMatch = StoreApiNewRouteMatch | StoreApiLegacyRouteMatch;

type MethodTable = Partial<Record<string, { route: StoreApiNewRoute; access: "read" | "write" }>>;

const ORDER_SUBROUTES: Record<string, MethodTable> = {
  "": {
    GET: { route: "order_read", access: "read" },
    PATCH: { route: "order_patch", access: "write" }
  },
  history: { GET: { route: "order_history", access: "read" } },
  confirm: { POST: { route: "order_confirm", access: "write" } },
  cancel: { POST: { route: "order_cancel", access: "write" } }
};

/** Ruta sin el prefijo `/storeApi` ni barras de los extremos, como la recorta hoy el handler. */
function normalizePath(path: string): string {
  return path.replace(/^\/storeApi(?=\/|$)/, "").replace(/^\/+|\/+$/g, "");
}

export function routeStoreApiRequest(request: { method: string; path: string }): StoreApiRouteMatch | StoreApiFailure {
  const method = String(request.method || "").toUpperCase();
  const trimmed = normalizePath(String(request.path || "/"));
  const segments = trimmed === "" ? [] : trimmed.split("/");

  // Todo lo que cuelga de orders/{id}/ es superficie nueva: error con la forma nueva.
  if (segments[0] === "orders" && segments.length >= 2 && segments[1] !== "") {
    const orderId = segments[1];
    const sub = segments.length === 2 ? "" : segments.length === 3 ? segments[2] : null;
    const table = sub === null ? undefined : ORDER_SUBROUTES[sub];
    if (!table) return failure("route_not_found");
    const entry = table[method];
    if (!entry) {
      const allow = Object.keys(table).join(", ");
      return { ...failure("method_not_allowed"), allow };
    }
    return { ok: true, kind: "new", route: entry.route, access: entry.access, orderId };
  }

  // Rutas de hoy: solo GET, con su 405 de siempre (RF_20).
  if (method !== "GET") {
    return {
      ok: false,
      httpStatus: STORE_API_ERROR_HTTP.method_not_allowed,
      code: "method_not_allowed",
      allow: "GET",
      body: { ok: false, error: "method_not_allowed" }
    };
  }
  return { ok: true, kind: "legacy", access: "legacy_read", resource: trimmed || "docs" };
}

// ---------------------------------------------------------------------------------------------------------
// Paso 3: parametros de consulta
// ---------------------------------------------------------------------------------------------------------

/** `key` por query solo vale en las lecturas nuevas; en escritura ya respondio 401 el paso 1. */
const ALLOWED_QUERY_PARAMETERS: Record<"read" | "write", readonly string[]> = {
  read: ["sellerId", "key"],
  write: ["sellerId"]
};

export function validateQueryParameters(
  match: StoreApiRouteMatch,
  query: Record<string, unknown> | null | undefined
): { ok: true } | StoreApiFailure {
  // Las rutas viejas no validan parametros (RF_20).
  if (match.kind !== "new") return { ok: true };
  const allowed = ALLOWED_QUERY_PARAMETERS[match.access];
  const unknown = Object.keys(query ?? {}).filter((name) => !allowed.includes(name));
  if (unknown.length === 0) return { ok: true };
  const result = failure("unknown_parameter", {
    fields: unknown.map((field) => ({ field, code: "not_allowed", message: `El parametro "${field}" no se admite en esta ruta.` }))
  });
  result.body.message = `Parametros de consulta no admitidos: ${unknown.join(", ")}. Esta ruta solo admite: ${allowed.join(", ")}.`;
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// shopifyOrderId (plan 2.10)
// ---------------------------------------------------------------------------------------------------------

const SHOPIFY_ORDER_ID_PATTERN = /^[0-9A-Za-z#._-]{1,64}$/;

export function isValidShopifyOrderId(value: unknown): boolean {
  return typeof value === "string" && SHOPIFY_ORDER_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------------------------------------
// Paso 3: forma del cuerpo
// ---------------------------------------------------------------------------------------------------------

type RawBody = string | Buffer | null | undefined;

type DecodedBody = { ok: true; value: Record<string, unknown> | undefined } | StoreApiFailure;

/**
 * JSON del cuerpo crudo (`rawBody` de la funcion). Sin cuerpo (ausente o solo espacios) → `undefined`.
 * JSON roto → 400 `invalid_json`; algo que no es un objeto (array, numero, texto, null) → 400 `invalid_body`.
 */
function decodeBody(raw: RawBody): DecodedBody {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (text.trim() === "") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure("invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return failure("invalid_body");
  return { ok: true, value: parsed as Record<string, unknown> };
}

const EXPECTED_STATUS_SHAPE = z.string();

/** `expectedStatus` presente y no texto (tambien `null`) es forma del cuerpo: 400 `invalid_body`. */
function hasInvalidExpectedStatus(body: Record<string, unknown>): boolean {
  return "expectedStatus" in body && body.expectedStatus !== undefined && !EXPECTED_STATUS_SHAPE.safeParse(body.expectedStatus).success;
}

export type ParsedConfirmBody = { ok: true; expectedStatus?: string };

/** Confirmar (decision 13): vacio o `{ expectedStatus }` con texto; cualquier otra cosa → 400 `invalid_body`. */
export function parseConfirmBody(raw: RawBody): ParsedConfirmBody | StoreApiFailure {
  const decoded = decodeBody(raw);
  if (!decoded.ok) return decoded;
  const body = decoded.value;
  if (body === undefined) return { ok: true };
  if (Object.keys(body).some((key) => key !== "expectedStatus")) return failure("invalid_body");
  if (hasInvalidExpectedStatus(body)) return failure("invalid_body");
  return typeof body.expectedStatus === "string" ? { ok: true, expectedStatus: body.expectedStatus } : { ok: true };
}

export type StoreApiWriteRoute = "order_patch" | "order_cancel";

export type ParsedWriteBody = {
  ok: true;
  /** Solo claves permitidas con tipo correcto, con su valor tal como vino. */
  input: DeliveryInput & { reason?: string };
  expectedStatus: string | undefined;
  /** Calculados aqui, respondidos en el paso 6 con `buildFieldError`. */
  fieldProblems: FieldProblem[];
};

/** Claves que admite `PATCH`: los datos de entrega del nucleo. Solo la lista; el contenido lo valida T5. */
const PATCH_FIELDS: readonly DeliveryField[] = ["customerName", "customerPhone", "addressRaw", "deliveryNotes", "cityId"];
const CANCEL_FIELDS: readonly string[] = ["reason"];

/** Forma basica: texto, o `null` (en entrega, `null` borra las indicaciones o da `empty`; en el motivo, `required`). */
const TEXT_OR_NULL_SHAPE = z.union([z.string(), z.null()]);

function reasonProblem(reason: unknown): FieldProblem | null {
  if (reason === undefined || reason === null) return { field: "reason", code: "required" };
  const trimmed = String(reason).trim();
  if (trimmed === "") return { field: "reason", code: "empty" };
  if (trimmed.length > CANCEL_REASON_MAX_LENGTH) return { field: "reason", code: "too_long" };
  return null;
}

/**
 * Cuerpo de `PATCH` y cancelar (plan 4.4). Responde solo los 400 de forma (`invalid_json`, `invalid_body`);
 * los problemas de campo (claves no permitidas, tipos, contenido) se devuelven todos a la vez, sin responder.
 */
export function parseWriteBody(route: StoreApiWriteRoute, raw: RawBody): ParsedWriteBody | StoreApiFailure {
  const decoded = decodeBody(raw);
  if (!decoded.ok) return decoded;
  const body = decoded.value ?? {};
  if (hasInvalidExpectedStatus(body)) return failure("invalid_body");
  const expectedStatus = typeof body.expectedStatus === "string" ? body.expectedStatus : undefined;

  const allowed = route === "order_patch" ? (PATCH_FIELDS as readonly string[]) : CANCEL_FIELDS;
  const input: Record<string, unknown> = {};
  const fieldProblems: FieldProblem[] = [];

  for (const [field, value] of Object.entries(body)) {
    if (field === "expectedStatus" || value === undefined) continue;
    if (!allowed.includes(field)) {
      fieldProblems.push({ field, code: "not_allowed" });
    } else if (!TEXT_OR_NULL_SHAPE.safeParse(value).success) {
      fieldProblems.push({ field, code: "invalid_type" });
    } else {
      input[field] = value;
    }
  }

  if (route === "order_patch") {
    fieldProblems.push(...validateDeliveryInput(input as DeliveryInput));
  } else {
    const isTypeProblem = fieldProblems.some((problem) => problem.field === "reason");
    const problem = isTypeProblem ? null : reasonProblem(input.reason);
    if (problem) fieldProblems.push(problem);
    // `reason: null` pasa la forma pero es "falta el motivo": no entra en el input.
    if (input.reason === null) delete input.reason;
  }

  return { ok: true, input: input as ParsedWriteBody["input"], expectedStatus, fieldProblems };
}

// ---------------------------------------------------------------------------------------------------------
// Paso 6: el 422 de campos
// ---------------------------------------------------------------------------------------------------------

export type StoreApiFieldErrorCode = FieldProblem["code"] | "out_of_coverage";

const FIELD_MESSAGES: Record<StoreApiFieldErrorCode, string> = {
  required: "Este campo es obligatorio.",
  empty: "Este campo no puede ir vacio.",
  too_long: "Este campo supera el largo maximo permitido.",
  invalid_phone: "El telefono no es valido: 10 digitos, +57 y 10 digitos, o formato internacional E.164.",
  not_allowed: "Este campo no se puede cambiar por la API.",
  invalid_type: "El tipo de dato de este campo no es valido.",
  out_of_coverage: "La ciudad indicada no tiene cobertura activa."
};

export type StoreApiFieldError = {
  ok: false;
  httpStatus: number;
  code: "field_not_allowed" | "validation_failed";
  body: Record<string, unknown>;
};

/**
 * El 422 con TODOS los campos anotados. `field_not_allowed` de primer nivel si alguno es `not_allowed`; si no,
 * `validation_failed`. Lo llama el paso 6, nunca `parseWriteBody`.
 */
export function buildFieldError(problems: ReadonlyArray<{ field: string; code: StoreApiFieldErrorCode }>): StoreApiFieldError {
  const code = problems.some((problem) => problem.code === "not_allowed") ? "field_not_allowed" : "validation_failed";
  const fields = problems.map(({ field, code: fieldCode }) => ({ field, code: fieldCode, message: FIELD_MESSAGES[fieldCode] }));
  return { ok: false, httpStatus: STORE_API_ERROR_HTTP[code], code, body: buildErrorBody(code, { fields }) };
}

// ---------------------------------------------------------------------------------------------------------
// Idempotencia: hash canonico (plan 2.8)
// ---------------------------------------------------------------------------------------------------------

/** JSON con las claves de los objetos ordenadas en todos los niveles; el orden de los arrays si cuenta. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** sha256 hex de metodo + ruta + cuerpo canonico. */
export function bodyHash(method: string, path: string, body: unknown): string {
  const material = canonicalJson([String(method).toUpperCase(), String(path), body === undefined ? null : body]);
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------------------------------------
// Limite de tasa (plan 2.9, RNF_04)
// ---------------------------------------------------------------------------------------------------------

/** Escrituras por tienda y minuto. Unico sitio del limite: los demas modulos importan esta constante. */
export const STORE_API_WRITES_PER_MINUTE = 120;

const MS_PER_MINUTE = 60_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Ventana fija por minuto UTC: `bucketId` = `YYYYMMDDHHmm` (sufijo del id `{sellerId}__{bucketId}`) y los
 * segundos hasta el minuto siguiente para `Retry-After`, nunca menos de 1.
 */
export function rateWindow(now: Date): { bucketId: string; retryAfterSeconds: number } {
  const bucketId = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  const msIntoMinute = now.getTime() % MS_PER_MINUTE;
  const retryAfterSeconds = Math.max(1, Math.ceil((MS_PER_MINUTE - msIntoMinute) / 1000));
  return { bucketId, retryAfterSeconds };
}
