import type { Firestore } from "firebase-admin/firestore";
import type { SellerActionRejection } from "./order-seller-actions";
import {
  runCancel,
  runConfirm,
  runDeliveryCorrection,
  type IdempotentRunResult,
  type RunIdempotency,
  type RunRequest,
  type SellerActionRunDeps,
  type SellerActionRunResult,
  type StoredReply
} from "./order-seller-actions-run";
import type { OrderDoc, SettlementDoc, WalletEntryDoc } from "./seller-ledger";
import { toStoreHistoryResponse } from "./store-api-history";
import { buildPaymentInfo, classifyOrder, loadTargetedPaymentInputs, orderPayload } from "./store-api-orders";
import {
  bodyHash,
  buildErrorBody,
  buildFieldError,
  checkRateLimit,
  decideIdempotency,
  idempotencyDocId,
  parseConfirmBody,
  parseWriteBody,
  rateLimitDocId,
  STORE_API_ERROR_HTTP,
  STORE_API_WRITES_PER_MINUTE,
  validateIdempotencyKey,
  type StoreApiFailure
} from "./store-api-request";

/**
 * Rutas de la Store API que leen UN pedido o unos pocos (spec 029, plan 2.10): `GET /orders/{id}` y el filtro
 * `GET /orders?shopifyOrderId=`. Carga dirigida: nunca baja la tienda entera ni todos los cortes (RNF_05). Una
 * guarda de fuente lo vigila en este archivo: toda consulta por `sellerId` lleva un segundo filtro y no hay
 * lectura de la coleccion `settlements` completa.
 *
 * La autenticacion y los parametros ya se resolvieron en el handler (`store-api.ts`); aqui solo se lee y se
 * arma la respuesta. Devuelve `{ httpStatus, body }` y el handler la escribe.
 */

export type StoreApiReply = {
  httpStatus: number;
  body: Record<string, unknown>;
  /** Cabeceras extra que el handler escribe tal cual (p. ej. `Retry-After` del 429). */
  headers?: Record<string, string>;
};

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

/** Tope de registros por pedido (plan 2.5): lectura acotada aunque un pedido acumule muchos cambios. */
const HISTORY_READ_LIMIT = 200;

/** `settings/storeApi.historySince`, o `null` si el documento (o el dato) aun no existe (plan 2.4). */
export async function readHistorySince(db: Firestore): Promise<string | null> {
  const snap = await db.collection("settings").doc("storeApi").get();
  const value = snap.exists ? snap.data()?.historySince : undefined;
  return typeof value === "string" && value ? value : null;
}

/**
 * `GET /orders/{id}/history` (RF_17, RF_18, RF_24). Primero la propiedad del pedido (paso 4): un pedido ajeno o
 * inexistente da el MISMO 404 que `GET /orders/{id}` y no se llega a leer `orderHistory`. Sin
 * `settings/storeApi` → 503 `history_not_ready`. Los registros se leen por `orderId` con tope y se descartan los
 * que no sean de la tienda de la key (comprobacion doble, plan 2.5).
 */
export async function readStoreOrderHistory(db: Firestore, input: { sellerId: string; orderId: string }): Promise<StoreApiReply> {
  if (!isUsableDocumentId(input.orderId)) return orderNotFound();
  const orderSnap = await db.collection("orders").doc(input.orderId).get();
  if (!orderSnap.exists || orderSnap.data()?.sellerId !== input.sellerId) return orderNotFound();

  const historySince = await readHistorySince(db);
  if (historySince === null) {
    return { httpStatus: STORE_API_ERROR_HTTP.history_not_ready, body: buildErrorBody("history_not_ready") };
  }

  const historySnap = await db.collection("orderHistory").where("orderId", "==", input.orderId).limit(HISTORY_READ_LIMIT).get();
  const records = historySnap.docs
    .map((doc) => doc.data() as Record<string, unknown>)
    .filter((record) => record.sellerId === input.sellerId);
  return { httpStatus: 200, body: { orderId: input.orderId, ...toStoreHistoryResponse(records, historySince) } };
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

// =========================================================================================================
// Rutas de escritura (T11): POST /orders/{id}/confirm, PATCH /orders/{id}, POST /orders/{id}/cancel
// =========================================================================================================
/*
 * Adaptadores de HTTP (regla de oro 1, RF_19): parsean el cuerpo, llaman al ejecutor transaccional
 * (`order-seller-actions-run.ts`) con politica api y traducen su resultado. No deciden ni escriben el pedido:
 * eso es del nucleo y del ejecutor. Credenciales y parametros ya los resolvio `store-api.ts` (pasos 0-3).
 */

export type ActiveCity = { id: string; name: string } & Record<string, unknown>;

/** Rechazo del nucleo → respuesta HTTP (plan 4.3). Puro. */
export function mapRejectionToResponse(
  rejection: SellerActionRejection,
  options: { activeCities?: ActiveCity[] } = {}
): StoreApiReply {
  switch (rejection.code) {
    case "order_not_found":
      return orderNotFound();
    case "order_cancelled":
    case "address_review_pending":
    case "status_changed":
      return { httpStatus: STORE_API_ERROR_HTTP[rejection.code], body: buildErrorBody(rejection.code, { status: rejection.status }) };
    case "order_not_editable":
      return {
        httpStatus: STORE_API_ERROR_HTTP.order_not_editable,
        body: buildErrorBody("order_not_editable", { status: rejection.status, hasLeader: rejection.hasLeader })
      };
    case "field_not_allowed":
    case "validation_failed": {
      const error = buildFieldError(rejection.fields);
      return { httpStatus: error.httpStatus, body: error.body };
    }
    case "no_fields":
      return { httpStatus: STORE_API_ERROR_HTTP.no_fields, body: buildErrorBody("no_fields") };
    case "out_of_coverage": {
      // El campo lleva el mismo mensaje que el resto de errores de campo; el codigo de primer nivel es el suyo.
      const fields = buildFieldError([{ field: rejection.field, code: "out_of_coverage" }]).body.fields;
      const activeCities = options.activeCities
        ?.map((city) => ({ id: String(city.id), name: String(city.name) }))
        .sort((left, right) => left.name.localeCompare(right.name, "es") || left.id.localeCompare(right.id));
      return {
        httpStatus: STORE_API_ERROR_HTTP.out_of_coverage,
        body: buildErrorBody("out_of_coverage", { fields, activeCities })
      };
    }
    default:
      // panel_precondition: imposible con politica api. No se filtra el mensaje del panel.
      return internalError();
  }
}

function internalError(): StoreApiReply {
  return { httpStatus: STORE_API_ERROR_HTTP.internal_error, body: buildErrorBody("internal_error") };
}

function failureReply(failure: StoreApiFailure): StoreApiReply {
  return { httpStatus: failure.httpStatus, body: failure.body };
}

export type StoreApiWriteRouteName = "order_confirm" | "order_patch" | "order_cancel";

export type StoreApiWriteInput = {
  route: StoreApiWriteRouteName;
  method: string;
  orderId: string;
  sellerId: string;
  keyLast4: string;
  rawBody: string | Buffer | null | undefined;
  /** Cabecera `Idempotency-Key` tal como vino: se valida aqui, en el paso 3. */
  idempotencyKey: string | undefined;
  now: string;
};

export type StoreApiWriteDeps = { db: Firestore; deleteField: () => unknown };

/**
 * Paso 3a (RNF_04, plan 2.9): cuenta la escritura en `storeApiRateLimits/{sellerId}__{YYYYMMDDHHmm}` en una
 * transaccion corta, ANTES de la de escritura. Una peticion ya por encima del limite no incrementa el contador
 * (no hace falta seguir contando para responder 429, y asi no se paga una escritura por cada rechazo).
 */
async function countWrite(db: Firestore, sellerId: string, now: Date): Promise<StoreApiReply | null> {
  const ref = db.collection("storeApiRateLimits").doc(rateLimitDocId(sellerId, now));
  // Fin del minuto mas 2 minutos: la politica TTL de Firestore borra el contador (plan 2.9).
  const expiresAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 3 * 60_000);
  const count = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const next = Number(snap.data()?.count ?? 0) + 1;
    if (next <= STORE_API_WRITES_PER_MINUTE) transaction.set(ref, { count: next, expiresAt });
    return next;
  });
  const verdict = checkRateLimit(count, now);
  if (verdict.ok) return null;
  return { httpStatus: verdict.httpStatus, body: verdict.body, headers: { "Retry-After": String(verdict.retryAfterSeconds) } };
}

function idempotencyConflict(): StoreApiReply {
  return { httpStatus: STORE_API_ERROR_HTTP.idempotency_key_reused, body: buildErrorBody("idempotency_key_reused") };
}

/**
 * Paso 3b: ATAJO fuera de la transaccion, solo para responder pronto un `replay` o un `conflict`. Si dice
 * `fresh`, no decide nada: la transaccion del ejecutor vuelve a leer el registro y manda (plan 2.8).
 */
async function idempotencyShortcut(db: Firestore, docId: string, hash: string, now: Date): Promise<StoreApiReply | null> {
  const snap = await db.collection("storeApiIdempotency").doc(docId).get();
  const decision = decideIdempotency(snap.exists ? snap.data() : undefined, { bodyHash: hash, now });
  if (decision.kind === "replay") return { httpStatus: decision.httpStatus, body: decision.body };
  if (decision.kind === "conflict") return idempotencyConflict();
  return null;
}

/** Ciudades activas para el 422 `out_of_coverage` (P4). Fuera de la transaccion; si falla, sin la lista. */
async function readActiveCities(db: Firestore): Promise<ActiveCity[] | undefined> {
  try {
    const snap = await db.collection("cities").where("active", "==", true).get();
    return snap.docs.map((doc) => ({ ...doc.data(), id: doc.id, name: String(doc.data()?.name ?? doc.id) }));
  } catch (error) {
    console.error("[storeApi] no se pudieron leer las ciudades activas", error);
    return undefined;
  }
}

function writePath(route: StoreApiWriteRouteName, orderId: string): string {
  if (route === "order_confirm") return `/orders/${orderId}/confirm`;
  if (route === "order_cancel") return `/orders/${orderId}/cancel`;
  return `/orders/${orderId}`;
}

type DeliveryRunInput = Parameters<typeof runDeliveryCorrection>[1]["input"];
type CancelRunInput = Parameters<typeof runCancel>[1]["input"];
type ConfirmRunInput = Parameters<typeof runConfirm>[1]["input"];

/** Cuerpo parseado (paso 3) listo para el ejecutor, con lo que entra en el hash de idempotencia. */
type PreparedWrite = {
  ok: true;
  /** Cuerpo recibido completo que se hashea (canonico en `bodyHash`): el mismo cuerpo da el mismo hash. */
  hashedBody: unknown;
  run: (runDeps: SellerActionRunDeps, base: RunBase, idempotency: RunIdempotency | undefined) => Promise<IdempotentRunResult>;
};

type RunBase = Omit<RunRequest<unknown>, "input" | "idempotency">;

/**
 * Cuerpo recibido tal cual para la huella de idempotencia (sin cuerpo = `{}`). Se hashea el cuerpo ENTERO, no el
 * input filtrado: si no, dos cuerpos que difieren en un campo no permitido o de tipo invalido darian la misma
 * huella y la key reutilizada se responderia como replay en vez de conflicto (R1-RF_12-1). Solo se llama cuando
 * el parseo ya dio ok, asi que el texto es vacio o un objeto JSON valido.
 */
function receivedBodyForHash(raw: StoreApiWriteInput["rawBody"]): unknown {
  if (raw === undefined || raw === null) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
}

/** Paso 3, forma del cuerpo por ruta: solo los 400 se responden aqui; los errores de campo van al nucleo. */
function prepareWrite(input: StoreApiWriteInput): PreparedWrite | StoreApiFailure {
  if (input.route === "order_confirm") {
    const parsed = parseConfirmBody(input.rawBody);
    if (!parsed.ok) return parsed;
    const confirmInput: ConfirmRunInput = parsed.expectedStatus === undefined ? {} : { expectedStatus: parsed.expectedStatus };
    return {
      ok: true,
      hashedBody: receivedBodyForHash(input.rawBody),
      run: (runDeps, base, idempotency) => runConfirm(runDeps, { ...base, input: confirmInput, idempotency })
    };
  }
  if (input.route === "order_patch") {
    const parsed = parseWriteBody("order_patch", input.rawBody);
    if (!parsed.ok) return parsed;
    // En PATCH el cuerpo solo admite datos de entrega: `reason` nunca llega al input.
    const delivery: DeliveryRunInput = parsed.input;
    const patchInput: DeliveryRunInput = { ...delivery, expectedStatus: parsed.expectedStatus, fieldProblems: parsed.fieldProblems };
    return {
      ok: true,
      hashedBody: receivedBodyForHash(input.rawBody),
      run: (runDeps, base, idempotency) => runDeliveryCorrection(runDeps, { ...base, input: patchInput, idempotency })
    };
  }
  const parsed = parseWriteBody("order_cancel", input.rawBody);
  if (!parsed.ok) return parsed;
  const cancelInput: CancelRunInput = { reason: parsed.input.reason, expectedStatus: parsed.expectedStatus, fieldProblems: parsed.fieldProblems };
  return {
    ok: true,
    hashedBody: receivedBodyForHash(input.rawBody),
    run: (runDeps, base, idempotency) => runCancel(runDeps, { ...base, input: cancelInput, idempotency })
  };
}

/**
 * La UNICA funcion que convierte el resultado del ejecutor en respuesta HTTP. Con `Idempotency-Key` la llama el
 * ejecutor dentro de la transaccion y lo que devuelve es lo que se guarda; sin ella la llama el handler. Asi el
 * cuerpo guardado y el respondido son el mismo. Pasa por JSON para que lo guardado sea exactamente lo que viaja
 * (sin `undefined`, que ademas Firestore rechaza).
 */
async function replyForResult(db: Firestore, sellerId: string, orderId: string, result: SellerActionRunResult): Promise<StoreApiReply> {
  let reply: StoreApiReply;
  if (result.kind === "rejected") {
    const activeCities = result.rejection.code === "out_of_coverage" ? await readActiveCities(db) : undefined;
    reply = mapRejectionToResponse(result.rejection, activeCities ? { activeCities } : {});
  } else {
    // El pedido que dejo (o leyo) la transaccion, con la forma de `GET /orders/{id}`.
    const order = { ...result.order, id: orderId } as OrderDoc;
    reply = {
      httpStatus: 200,
      body: { ok: true, changed: result.kind === "applied", pedido: await loadOrderItem(db, sellerId, order) }
    };
  }
  return { httpStatus: reply.httpStatus, body: JSON.parse(JSON.stringify(reply.body)) as Record<string, unknown> };
}

/**
 * Escrituras en el orden de la precedencia (plan 2.1): paso 3 (cabecera `Idempotency-Key` y forma del cuerpo;
 * solo los 400), 3a (tasa), 3b (atajo de idempotencia) y el ejecutor, que decide la idempotencia de verdad y
 * aplica los pasos 4-9. Exito o no-op: 200 `{ ok, changed, pedido }` con la misma forma que `GET /orders/{id}`.
 */
export async function handleStoreApiWrite(deps: StoreApiWriteDeps, input: StoreApiWriteInput): Promise<StoreApiReply> {
  const { db } = deps;
  const now = new Date(input.now);

  // Paso 3.
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey.ok) return failureReply(idempotencyKey);
  const prepared = prepareWrite(input);
  if (!prepared.ok) return failureReply(prepared);

  // Paso 3a: tasa (cuenta tambien las que despues sean replay o error del pedido).
  const limited = await countWrite(db, input.sellerId, now);
  if (limited) return limited;

  // Paso 3b: atajo de idempotencia. Va antes del 404: una key reutilizada se responde como tal (precedencia).
  const path = writePath(input.route, input.orderId);
  const hash = bodyHash(input.method, path, prepared.hashedBody);
  const docId = idempotencyKey.key === undefined ? undefined : idempotencyDocId(input.sellerId, idempotencyKey.key);
  if (docId) {
    const shortcut = await idempotencyShortcut(db, docId, hash, now);
    if (shortcut) return shortcut;
  }

  // Un id que Firestore no acepta como documento es un pedido inexistente: mismo 404, sin que la libreria lance.
  if (!isUsableDocumentId(input.orderId)) return orderNotFound();

  const respond = async (result: SellerActionRunResult): Promise<StoredReply> => {
    const reply = await replyForResult(db, input.sellerId, input.orderId, result);
    return { status: reply.httpStatus, body: reply.body };
  };
  const idempotency: RunIdempotency | undefined = docId
    ? { docId, bodyHash: hash, method: String(input.method).toUpperCase(), path, respond }
    : undefined;
  const base: RunBase = {
    orderId: input.orderId,
    policy: "api",
    actor: { kind: "api", sellerId: input.sellerId, keyLast4: input.keyLast4 },
    now: input.now
  };

  let result: IdempotentRunResult;
  try {
    result = await prepared.run({ db, deleteField: deps.deleteField }, base, idempotency);
  } catch (error) {
    console.error("[storeApi] fallo el ejecutor de escritura", { route: input.route, orderId: input.orderId, error });
    return internalError();
  }

  // Con enganche, la respuesta es la que el ejecutor guardo (o la guardada que repite).
  if (result.kind === "conflict") return idempotencyConflict();
  if (result.kind === "replay" || result.reply) {
    const reply = result.reply as StoredReply;
    return { httpStatus: reply.status, body: reply.body };
  }
  return replyForResult(db, input.sellerId, input.orderId, result);
}
