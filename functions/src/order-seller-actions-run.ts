/**
 * Ejecutor transaccional de las acciones de tienda (spec 029, plan 2.2): confirmar, corregir datos de
 * entrega y anular. El planificador puro (`order-seller-actions.ts`) decide; este modulo lee, llama al
 * planificador DENTRO de la transaccion y escribe lo que el plan dice, en este orden:
 *
 *   pedido (`plan.patch` con merge + `plan.clear` con `FieldValue.delete()`) → inventario → evento → historial.
 *
 * Reglas que sostiene:
 *  - Todas las lecturas (pedido, ciudad, inventario) van antes de la primera escritura, como exige Firestore.
 *  - Si el plan rechaza o no hay cambios, no se escribe NADA en `orders`, `auditEvents` ni `orderHistory`.
 *  - RF_19: el plan se evalua con el pedido leido por `transaction.get`. Si otro escritor (lider que toma el
 *    pedido, ChatBy que confirma) lo cambia antes del commit, Firestore reintenta la funcion entera y la
 *    segunda evaluacion ve el estado nuevo: rechaza con 409 o responde `unchanged`.
 *  - Nunca crea pedidos: un pedido que no existe es `order_not_found`, y el pedido se escribe con merge.
 *
 * Sin `firebase-admin` en tiempo de ejecucion (solo tipos): la base y `FieldValue.delete` se inyectan, para
 * probarlo con una transaccion falsa desde la raiz del repo, que no tiene `firebase-admin` instalado. No sabe de
 * HTTP ni de `HttpsError`: eso es de los adaptadores (callables del panel y rutas de la Store API).
 */
import type { DocumentReference, Firestore, Query, Transaction } from "firebase-admin/firestore";
import {
  applyInventoryMovements,
  inventoryMovementsForOrder,
  readSellerInventoryIndex
} from "./inventory-movements";
import {
  planCancel,
  planConfirm,
  planDeliveryCorrection,
  validateDeliveryInput,
  type CancelInput,
  type CityFact,
  type ConfirmInput,
  type DeliveryCorrectionInput,
  type PanelEditExtras,
  type PlanInput,
  type SellerActionPlan,
  type SellerActionPolicy,
  type SellerActionRejection,
  type SellerActor
} from "./order-seller-actions";
import { stripUndefined } from "./wallet-entries";

export type SellerActionRunDeps = {
  db: Pick<Firestore, "runTransaction" | "collection">;
  /** En produccion, `() => FieldValue.delete()`. */
  deleteField: () => unknown;
};

export type RunRequest<T> = {
  orderId: string;
  policy: SellerActionPolicy;
  actor: SellerActor;
  input: T;
  now: string;
};

export type OrderView = Record<string, unknown> & { id: string };

export type SellerActionRunResult =
  | { kind: "rejected"; rejection: SellerActionRejection }
  | { kind: "applied" | "unchanged"; order: OrderView };

type Planner<T> = (input: PlanInput<T>) => SellerActionRejection | SellerActionPlan;

function isPlan(value: SellerActionRejection | SellerActionPlan): value is SellerActionPlan {
  return "outcome" in value;
}

/**
 * Esqueleto comun: lee el pedido, deja al llamador leer lo suyo (ciudad), planifica, lee el inventario si el
 * plan lo pide y, solo entonces, escribe.
 */
async function runPlanned<TInput, TPlanInput>(
  deps: SellerActionRunDeps,
  request: RunRequest<TInput>,
  plan: Planner<TPlanInput>,
  prepareInput: (transaction: Transaction, input: TInput, order: OrderView) => Promise<TPlanInput>
): Promise<SellerActionRunResult> {
  const { db } = deps;
  const { orderId, policy, actor, input, now } = request;
  const orderRef = db.collection("orders").doc(orderId);

  return db.runTransaction(async (transaction: Transaction): Promise<SellerActionRunResult> => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) return { kind: "rejected", rejection: { code: "order_not_found" } };
    const order: OrderView = { ...(snapshot.data() ?? {}), id: orderId };

    const planInput = await prepareInput(transaction, input, order);
    const decision = plan({ policy, actor, order, input: planInput, now });
    if (!isPlan(decision)) return { kind: "rejected", rejection: decision };
    if (decision.outcome === "unchanged") return { kind: "unchanged", order };

    // Ultima lectura, antes de cualquier escritura: las fichas de inventario de la tienda (mismo criterio que
    // `cancelOrder`: solo si el plan libera y el pedido tiene lineas con SKU).
    const sellerId = String(order.sellerId ?? "");
    const movements = decision.inventory === "release"
        ? inventoryMovementsForOrder(order as Parameters<typeof inventoryMovementsForOrder>[0])
        : [];
    const inventoryIndex =
      movements.length > 0 && sellerId
        ? await readSellerInventoryIndex(transaction, db.collection("inventory") as Query, sellerId)
        : null;

    // 1) Pedido: el parche con merge (conservar = no emitir la clave) y `clear` como borrado explicito.
    const cleared = Object.fromEntries(decision.clear.map((key) => [key, deps.deleteField()]));
    transaction.set(orderRef, stripUndefined({ ...decision.patch, ...cleared }), { merge: true });

    // 2) Inventario.
    if (inventoryIndex) applyInventoryMovements(transaction, inventoryIndex, movements, "release", now);

    // 3) Evento, con su id. 4) Historial, con id propio y enlazado al evento.
    if (!decision.audit) throw new Error("Plan aplicado sin evento de auditoria: invariante del planificador rota.");
    const auditRef: DocumentReference = db.collection("auditEvents").doc();
    transaction.create(auditRef, stripUndefined({ ...decision.audit, id: auditRef.id }));
    if (decision.history) {
      const historyRef: DocumentReference = db.collection("orderHistory").doc();
      transaction.create(historyRef, stripUndefined({ ...decision.history, id: historyRef.id, auditEventId: auditRef.id }));
    }

    const after: OrderView = { ...order, ...decision.patch, id: orderId };
    for (const key of decision.clear) delete after[key];
    return { kind: "applied", order: after };
  });
}

/** Sin preparacion: la entrada va tal cual al planificador. */
async function asIs<T>(_transaction: Transaction, input: T): Promise<T> {
  return input;
}

/**
 * La ciudad de `cityId`, leida dentro de la transaccion. Solo si se envio un `cityId` valido (uno invalido ya lo
 * rechaza la validacion, y un id con `/` ni siquiera es una ruta de documento). Inexistente → `null`.
 */
async function readCity(
  deps: SellerActionRunDeps,
  transaction: Transaction,
  cityId: unknown
): Promise<CityFact | null> {
  if (cityId === undefined || cityId === null) return null;
  if (validateDeliveryInput({ cityId: cityId as string }).length > 0) return null;
  const id = String(cityId).trim();
  const snapshot = await transaction.get(deps.db.collection("cities").doc(id));
  if (!snapshot.exists) return null;
  return { id, active: snapshot.data()?.active === true };
}

export function runConfirm(deps: SellerActionRunDeps, request: RunRequest<ConfirmInput>): Promise<SellerActionRunResult> {
  return runPlanned(deps, request, planConfirm, asIs);
}

/**
 * Extras del panel como funcion del pedido LEIDO EN LA TRANSACCION (spec 029 T6b). `updateImportedOrder`
 * resuelve las lineas con `resolveEditedOrderLines(input, current)`, y `current` tiene que ser el documento que
 * se va a pisar: con una lectura previa, una reimportacion entre esa lectura y el commit dejaria lineas
 * rearmadas desde campos planos encima de un pedido multilinea (el costo duplicado). Al evaluarse aqui, cada
 * reintento de Firestore la vuelve a llamar con el documento nuevo.
 */
export type PanelExtrasSource = PanelEditExtras | ((order: OrderView) => PanelEditExtras);

export type RunDeliveryCorrectionInput = Omit<DeliveryCorrectionInput, "city" | "panelExtras"> & {
  panelExtras?: PanelExtrasSource;
};

export function runDeliveryCorrection(
  deps: SellerActionRunDeps,
  request: RunRequest<RunDeliveryCorrectionInput>
): Promise<SellerActionRunResult> {
  if (request.policy === "api" && request.input.panelExtras !== undefined) {
    // Antes de abrir la transaccion y sin evaluar la funcion: con politica api es un error de programacion.
    return Promise.reject(new Error("panelExtras solo existe con politica panel: la validacion de la API nunca lo produce."));
  }
  return runPlanned(deps, request, planDeliveryCorrection, async (transaction, input, order) => {
    const { panelExtras, ...rest } = input;
    const resolved = typeof panelExtras === "function" ? panelExtras(order) : panelExtras;
    return {
      ...rest,
      ...(resolved !== undefined ? { panelExtras: resolved } : {}),
      city: await readCity(deps, transaction, input.cityId)
    };
  });
}

export function runCancel(deps: SellerActionRunDeps, request: RunRequest<CancelInput>): Promise<SellerActionRunResult> {
  return runPlanned(deps, request, planCancel, asIs);
}
