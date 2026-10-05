import type { Firestore } from "firebase-admin/firestore";
import type { SellerActionRejection } from "./order-seller-actions";
import {
  runCancel,
  runConfirm,
  runDeliveryCorrection,
  type RunRequest,
  type SellerActionRunDeps,
  type SellerActionRunResult
} from "./order-seller-actions-run";
import type { OrderDoc, SettlementDoc, WalletEntryDoc } from "./seller-ledger";
import { buildPaymentInfo, classifyOrder, loadTargetedPaymentInputs, orderPayload } from "./store-api-orders";
import {
  bodyHash,
  buildErrorBody,
  buildFieldError,
  parseConfirmBody,
  parseWriteBody,
  STORE_API_ERROR_HTTP,
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
  /** Cabecera `Idempotency-Key` tal como vino (T12 la valida y la conecta). */
  idempotencyKey: string | undefined;
  now: string;
};

export type StoreApiWriteDeps = { db: Firestore; deleteField: () => unknown };

/**
 * Enganche de idempotencia (nota 11 de T11): el handler calcula la key y el hash del cuerpo y se los pasa al
 * ejecutor, que en T11 los ignora. T12 los conecta a `decideIdempotency` dentro de la transaccion.
 */
type IdempotencyHook = { idempotency: { key: string | undefined; bodyHash: string } };

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

/**
 * Paso 3 (forma del cuerpo: solo los 400 se responden aqui) y despues el ejecutor, que aplica los pasos 4-9 en
 * su orden. Exito o no-op: 200 `{ ok, changed, pedido }` con la misma forma que `GET /orders/{id}`.
 */
export async function handleStoreApiWrite(deps: StoreApiWriteDeps, input: StoreApiWriteInput): Promise<StoreApiReply> {
  const { db } = deps;
  const runDeps: SellerActionRunDeps = { db, deleteField: deps.deleteField };
  const base = {
    orderId: input.orderId,
    policy: "api" as const,
    actor: { kind: "api" as const, sellerId: input.sellerId, keyLast4: input.keyLast4 },
    now: input.now
  };
  const hook = (body: unknown): IdempotencyHook => ({
    idempotency: { key: input.idempotencyKey, bodyHash: bodyHash(input.method, writePath(input.route, input.orderId), body) }
  });

  let run: () => Promise<SellerActionRunResult>;
  if (input.route === "order_confirm") {
    const parsed = parseConfirmBody(input.rawBody);
    if (!parsed.ok) return failureReply(parsed);
    const confirmInput: ConfirmRunInput = parsed.expectedStatus === undefined ? {} : { expectedStatus: parsed.expectedStatus };
    const request: RunRequest<ConfirmRunInput> & IdempotencyHook = { ...base, input: confirmInput, ...hook(confirmInput) };
    run = () => runConfirm(runDeps, request);
  } else if (input.route === "order_patch") {
    const parsed = parseWriteBody("order_patch", input.rawBody);
    if (!parsed.ok) return failureReply(parsed);
    // En PATCH el cuerpo solo admite datos de entrega: `reason` nunca llega al input.
    const delivery: DeliveryRunInput = parsed.input;
    const patchInput: DeliveryRunInput = { ...delivery, expectedStatus: parsed.expectedStatus, fieldProblems: parsed.fieldProblems };
    const request: RunRequest<DeliveryRunInput> & IdempotencyHook = {
      ...base,
      input: patchInput,
      ...hook({ ...parsed.input, expectedStatus: parsed.expectedStatus })
    };
    run = () => runDeliveryCorrection(runDeps, request);
  } else {
    const parsed = parseWriteBody("order_cancel", input.rawBody);
    if (!parsed.ok) return failureReply(parsed);
    const cancelInput: CancelRunInput = { reason: parsed.input.reason, expectedStatus: parsed.expectedStatus, fieldProblems: parsed.fieldProblems };
    const request: RunRequest<CancelRunInput> & IdempotencyHook = {
      ...base,
      input: cancelInput,
      ...hook({ ...parsed.input, expectedStatus: parsed.expectedStatus })
    };
    run = () => runCancel(runDeps, request);
  }

  // Un id que Firestore no acepta como documento es un pedido inexistente: mismo 404, sin que la libreria lance.
  if (!isUsableDocumentId(input.orderId)) return orderNotFound();

  let result: SellerActionRunResult;
  try {
    result = await run();
  } catch (error) {
    console.error("[storeApi] fallo el ejecutor de escritura", { route: input.route, orderId: input.orderId, error });
    return internalError();
  }

  if (result.kind === "rejected") {
    const activeCities = result.rejection.code === "out_of_coverage" ? await readActiveCities(db) : undefined;
    return mapRejectionToResponse(result.rejection, activeCities ? { activeCities } : {});
  }

  // El pedido que dejo (o leyo) la transaccion, con la forma de `GET /orders/{id}`.
  const order = { ...result.order, id: input.orderId } as OrderDoc;
  return {
    httpStatus: 200,
    body: { ok: true, changed: result.kind === "applied", pedido: await loadOrderItem(db, input.sellerId, order) }
  };
}
