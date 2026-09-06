import { getFirestore, type Query } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

/**
 * Indicadores de un periodo, calculados AGREGANDO EN EL SERVIDOR.
 *
 * Por que existe: el navegador solo descarga los pedidos cerrados de una ventana reciente. Para
 * mirar "el mes pasado" o el acumulado historico, la alternativa era ensanchar esa ventana y
 * bajarse miles de pedidos — hoy son 3.500, el ano que viene no se sabe. Aqui no se descarga ni
 * un documento: Firestore cuenta sobre el indice y devuelve numeros. Cuesta lo mismo con 3.000
 * pedidos que con 300.000.
 *
 * Alcance deliberado: SOLO los indicadores, que son contadores exactos. No devuelve el embudo
 * completo ni cifras de dinero:
 *  - El reparto de `picked_up` por mensajero necesitaria `messengerId` normalizado (hoy esta
 *    AUSENTE en 1.015 pedidos, y Firestore no consulta campos ausentes).
 *  - `sellerDeliveredFeeCop` de DANDA depende de la fecha de entrega de CADA pedido, asi que el
 *    recaudo neto no se puede agregar sin leer los documentos uno a uno.
 * Ambas cosas siguen calculandose en el cliente sobre los pedidos que si estan cargados, que es
 * donde son exactas. Aqui no se aproxima nada.
 */

const ACTIVE_WITH_DRIVER = [
  "call_pending",
  "scheduled",
  "picked_up",
  "in_route",
  "retry_pending",
  "delivered",
  "failed",
  "liquidated"
] as const;

/**
 * Las tres categorias que salen del denominador de despachables. OJO: no son "todas las no
 * cobrables" — existe ademas `pending_review`, que NO genera cobro pero SI cuenta como
 * despachable, exactamente igual que en el cliente.
 */
const NOT_DISPATCHABLE_FAILED = ["no_coverage", "bad_order_or_no_contact", "bad_phone"] as const;

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida.");
const statsSchema = z.object({
  // Vacio = sin limite por ese lado, igual que en las consultas de Firestore.
  startDate: z.union([isoDate, z.literal("")]).default(""),
  endDate: z.union([isoDate, z.literal("")]).default(""),
  sellerId: z.string().trim().optional()
});

export type OrderPeriodStats = {
  total: number;
  delivered: number;
  failed: number;
  cancelled: number;
  liquidated: number;
  chargeableFailed: number;
  pickedByDriver: number;
  dispatchable: number;
  closedDispatchable: number;
  openDispatchable: number;
  dispatchRate: number;
  completionRate: number;
  deliveryRate: number;
  returnRate: number;
};

const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export const getOrderStats = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || typeof role !== "string") {
    throw new HttpsError("permission-denied", "Debes iniciar sesion para ver los indicadores.");
  }

  const parsed = statsSchema.safeParse(request.data ?? {});
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Rango invalido.", parsed.error.flatten());
  }
  const { startDate, endDate } = parsed.data;
  if (startDate && endDate && startDate > endDate) {
    throw new HttpsError("invalid-argument", "La fecha inicial no puede ser posterior a la final.");
  }

  // Una tienda solo ve lo suyo, venga lo que venga en la peticion: el scoping se IMPONE desde el
  // claim, nunca se acepta del cliente.
  let sellerId = parsed.data.sellerId ?? "";
  if (role === "seller" || role === "seller_logistics") {
    const claim = typeof request.auth.token.sellerId === "string" ? request.auth.token.sellerId : "";
    if (!claim) throw new HttpsError("permission-denied", "Tu usuario no esta vinculado a una tienda.");
    sellerId = claim;
  } else if (role !== "admin") {
    throw new HttpsError("permission-denied", "Tu usuario no puede consultar indicadores de periodo.");
  }

  const db = getFirestore();
  // `createdAt` es ISO en UTC; el rango llega como fecha suelta. Se cierra el dia final completo
  // para que "hasta el 16" incluya el 16 entero, igual que el filtro del cliente.
  const base = (): Query => {
    let q: Query = db.collection("orders");
    if (sellerId) q = q.where("sellerId", "==", sellerId);
    if (startDate) q = q.where("createdAt", ">=", `${startDate}T00:00:00.000Z`);
    if (endDate) q = q.where("createdAt", "<=", `${endDate}T23:59:59.999Z`);
    return q;
  };
  const countOf = async (q: Query) => (await q.count().get()).data().count;

  const [total, delivered, failed, cancelled, liquidated, withDriverAll, withDriverNone, chargeableFailed, noCoverage, badOrder, badPhone] =
    await Promise.all([
      countOf(base()),
      countOf(base().where("status", "==", "delivered")),
      countOf(base().where("status", "==", "failed")),
      countOf(base().where("status", "==", "cancelled")),
      countOf(base().where("status", "==", "liquidated")),
      countOf(base().where("status", "in", [...ACTIVE_WITH_DRIVER])),
      // Se cuenta el complemento en vez de `driverId != null`: la desigualdad descartaria los
      // documentos SIN el campo, y restar deja el mismo resultado que `!order.driverId` en el
      // cliente. Verificado en produccion: ningun pedido tiene driverId como cadena vacia.
      countOf(base().where("status", "in", [...ACTIVE_WITH_DRIVER]).where("driverId", "==", null)),
      // Se cuenta `failed_visit` en POSITIVO en vez de restar las categorias no cobrables. Restar
      // obliga a enumerarlas todas y una categoria nueva se colaria como cobrable sin que nadie
      // se entere; asi, cualquier valor que no sea `failed_visit` queda no cobrable, que es lo
      // que hace el cliente. (Ya paso: `pending_review` no estaba en la lista y desviaba 44.)
      countOf(base().where("status", "==", "failed").where("failedCategory", "==", "failed_visit")),
      ...NOT_DISPATCHABLE_FAILED.map((category) =>
        countOf(base().where("status", "==", "failed").where("failedCategory", "==", category))
      )
    ]);

  const pickedByDriver = Math.max(0, withDriverAll - withDriverNone);
  const dispatchable = Math.max(0, pickedByDriver - noCoverage - badOrder - badPhone);
  const closedDispatchable = delivered + chargeableFailed + liquidated;

  const stats: OrderPeriodStats = {
    total,
    delivered,
    failed,
    cancelled,
    liquidated,
    chargeableFailed,
    pickedByDriver,
    dispatchable,
    closedDispatchable,
    openDispatchable: Math.max(0, dispatchable - closedDispatchable),
    dispatchRate: rate(dispatchable, pickedByDriver),
    completionRate: rate(closedDispatchable, dispatchable),
    deliveryRate: rate(delivered, dispatchable),
    returnRate: rate(chargeableFailed, dispatchable)
  };
  return stats;
});
