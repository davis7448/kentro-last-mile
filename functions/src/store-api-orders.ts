/**
 * Forma de pedido de la API de tiendas (spec 029, T9): payload, clasificacion operativa, estado de pago y
 * KPIs, movidos TAL CUAL desde store-api.ts. Puro: sin firebase-admin ni firebase-functions en tiempo de
 * ejecucion, para que la lectura (/orders) y la escritura compartan la misma salida y se pueda probar.
 */
import {
  buildCodReceivedSet,
  type OrderDoc,
  type SettlementDoc,
  type WalletEntryDoc
} from "./seller-ledger";
import { chargeMagnitude, sumType } from "./store-summary";

// Misma semántica que orderDateValue() de la UI.
export function orderDateValue(order: OrderDoc) {
  return String(order.createdAt || order.updatedAt || "").slice(0, 10);
}

export function inRange(order: OrderDoc, from: string, to: string) {
  const date = orderDateValue(order);
  if (from && date && date < from) return false;
  if (to && date && date > to) return false;
  return true;
}

// Misma semántica que isChargeableFailedOrder() de src/lib/finance.ts.
export function isChargeableFailed(order: OrderDoc) {
  return order.status === "failed" && String(order.failedCategory ?? "failed_visit") === "failed_visit";
}

export const PICKED_BY_DRIVER_STATUSES = new Set(["call_pending", "scheduled", "picked_up", "in_route", "retry_pending", "delivered", "failed", "liquidated"]);

// Clasificación operativa por pedido, alineada con LogisticsKpis.
export function classifyOrder(order: OrderDoc) {
  const takenByDriver = Boolean(order.driverId) && PICKED_BY_DRIVER_STATUSES.has(String(order.status));
  const noCoverageFailed = order.status === "failed" && order.failedCategory === "no_coverage";
  const badOrderFailed = order.status === "failed" && order.failedCategory === "bad_order_or_no_contact";
  const badPhoneFailed = order.status === "failed" && order.failedCategory === "bad_phone";
  const dispatchable = takenByDriver && !noCoverageFailed && !badOrderFailed && !badPhoneFailed;
  return {
    takenByDriver,
    dispatchable,
    delivered: order.status === "delivered",
    failed: order.status === "failed",
    chargeableFailed: isChargeableFailed(order),
    noCoverageFailed,
    badOrderFailed,
    badPhoneFailed,
    closed: ["delivered", "failed", "cancelled", "liquidated"].includes(String(order.status))
  };
}

// Réplica exacta de LogisticsKpis (operations-app.tsx).
export function computeKpis(orders: OrderDoc[]) {
  const total = orders.length;
  const pendingConfirm = orders.filter((o) => o.status === "imported" || o.status === "address_risk").length;
  const readyWithoutLeader = orders.filter((o) => o.status === "ready_to_assign" && !o.driverId).length;
  const assignedPendingPickup = orders.filter((o) => o.status === "assigned").length;
  const pickedWithoutMessenger = orders.filter((o) => o.status === "picked_up" && !o.messengerId).length;
  const inOperation = orders.filter((o) => ["call_pending", "scheduled", "in_route", "retry_pending"].includes(String(o.status)) || (o.status === "picked_up" && Boolean(o.messengerId))).length;
  const delivered = orders.filter((o) => o.status === "delivered").length;
  const failed = orders.filter((o) => o.status === "failed").length;
  const chargeableFailed = orders.filter(isChargeableFailed).length;
  const noCoverageFailed = orders.filter((o) => o.status === "failed" && o.failedCategory === "no_coverage").length;
  const badOrderFailed = orders.filter((o) => o.status === "failed" && o.failedCategory === "bad_order_or_no_contact").length;
  const badPhoneFailed = orders.filter((o) => o.status === "failed" && o.failedCategory === "bad_phone").length;
  const cancelled = orders.filter((o) => o.status === "cancelled").length;
  const liquidated = orders.filter((o) => o.status === "liquidated").length;
  const pickedByDriver = orders.filter((o) => o.driverId && PICKED_BY_DRIVER_STATUSES.has(String(o.status))).length;
  const dispatchable = Math.max(0, pickedByDriver - noCoverageFailed - badOrderFailed - badPhoneFailed);
  const dispatchRate = pickedByDriver > 0 ? Math.round((dispatchable / pickedByDriver) * 100) : 0;
  const closedDispatchable = delivered + chargeableFailed + liquidated;
  const openDispatchable = Math.max(0, dispatchable - closedDispatchable);
  const completionRate = dispatchable > 0 ? Math.round((closedDispatchable / dispatchable) * 100) : 0;
  const deliveryRate = dispatchable > 0 ? Math.round((delivered / dispatchable) * 100) : 0;
  const returnRate = dispatchable > 0 ? Math.round((chargeableFailed / dispatchable) * 100) : 0;
  return {
    totalPedidos: total,
    embudo: {
      pendienteConfirmar: pendingConfirm,
      listoSinLider: readyWithoutLeader,
      asignadoPendienteRecoger: assignedPendingPickup,
      recogidoSinMensajero: pickedWithoutMessenger,
      enGestionORuta: inOperation,
      entregados: delivered,
      fallidos: failed,
      cancelados: cancelled,
      liquidados: liquidated
    },
    indicadores: {
      tomadosPorDomiciliario: pickedByDriver,
      despachables: dispatchable,
      abiertosDespachables: openDispatchable,
      porcentajeDespacho: dispatchRate,
      porcentajeTerminacion: completionRate,
      porcentajeEntrega: deliveryRate,
      porcentajeDevolucion: returnRate
    },
    fallidosPorCategoria: {
      fallidoConVisita: chargeableFailed,
      sinCobertura: noCoverageFailed,
      pedidoMaloNoContesta: badOrderFailed,
      sinTelefonoLineaInactiva: badPhoneFailed
    },
    formulas: {
      tomadosPorDomiciliario: "pedidos con domiciliario asignado en estado llamada/agendado/recogido/en ruta/reintento/entregado/fallido/liquidado",
      despachables: "tomados por domiciliario menos fallidos sin cobertura, pedido malo/no contesta y sin telefono/linea inactiva",
      porcentajeDespacho: "despachables / tomados por domiciliario",
      porcentajeTerminacion: "(entregados + fallidos con visita + liquidados) / despachables",
      porcentajeEntrega: "entregados / despachables",
      porcentajeDevolucion: "fallidos con visita / despachables"
    }
  };
}


export function buildPaymentInfo(
  order: OrderDoc,
  sellerEntries: WalletEntryDoc[],
  settlementsById: Map<string, SettlementDoc>,
  codReceived: Set<string>
) {
  const entries = sellerEntries.filter((entry) => entry.orderId === order.id && entry.type !== "platform_margin");
  const netCop = Math.round(entries.reduce((sum, entry) => sum + Number(entry.amountCop || 0), 0));
  const settlementIds = Array.from(new Set(entries.map((entry) => entry.settlementId).filter(Boolean))) as string[];
  const unsettledCount = entries.filter((entry) => !entry.settlementId).length;
  const settlementStatuses = settlementIds.map((id) => String(settlementsById.get(id)?.status ?? "desconocido"));
  const allSettled = entries.length > 0 && unsettledCount === 0;
  const allPaid = allSettled && settlementStatuses.every((status) => status === "paid" || status === "reconciled");
  const eligible = order.paymentMethod === "prepaid" || codReceived.has(String(order.id));
  const estado = entries.length === 0
    ? "sin_movimientos"
    : allPaid
      ? "pagado"
      : allSettled
        ? "en_liquidacion"
        : eligible
          ? "pendiente_habilitado"
          : "pendiente_bloqueado_cod";
  return {
    estado,
    pagado: allPaid,
    habilitadoParaPago: eligible,
    netoCop: netCop,
    // Desglose real por pedido para que la tienda no asuma el flete (13.500/12.000).
    desglose: {
      codCop: sumType(entries, ["cod_revenue", "cod_remittance"]),
      fleteCop: chargeMagnitude(entries, ["delivery_fee"]),
      failedFeeCop: chargeMagnitude(entries, ["failed_fee"]),
      fulfillmentCop: chargeMagnitude(entries, ["fulfillment_fee"]),
      costoProductoCop: chargeMagnitude(entries, ["product_cost"])
    },
    movimientos: entries.length,
    movimientosSinLiquidar: unsettledCount,
    settlementIds,
    settlements: settlementIds.map((id) => ({
      id,
      status: String(settlementsById.get(id)?.status ?? "desconocido"),
      paidAt: settlementsById.get(id)?.paidAt ?? null
    }))
  };
}

export function orderPayload(order: OrderDoc) {
  return {
    id: order.id,
    trackingCode: order.trackingCode ?? null,
    shopifyOrderId: order.shopifyOrderId ?? null,
    status: order.status,
    failedCategory: order.failedCategory ?? null,
    failedReason: order.failedReason ?? null,
    paymentMethod: order.paymentMethod ?? null,
    totalCop: Math.round(Number(order.totalCop || 0)),
    customerName: order.customerName ?? null,
    createdAt: order.createdAt ?? null,
    updatedAt: order.updatedAt ?? null,
    fecha: orderDateValue(order)
  };
}

/**
 * Entradas de buildPaymentInfo a partir de la carga dirigida de un solo pedido (plan 2.10):
 * `entries` = walletEntries where orderId == id (de cualquier dueno); `settlements` = union de getAll de los
 * settlementId de la tienda y de settlements where orderIds array-contains id (puede repetir cortes).
 * Para ESE pedido da lo mismo que la carga completa de la tienda.
 */
export function loadTargetedPaymentInputs(input: {
  orderId: string;
  sellerId: string;
  entries: WalletEntryDoc[];
  settlements: SettlementDoc[];
}): { sellerEntries: WalletEntryDoc[]; settlementsById: Map<string, SettlementDoc>; codReceived: Set<string> } {
  const sellerEntries = input.entries.filter(
    (entry) => entry.ownerType === "seller" && entry.ownerId === input.sellerId && entry.orderId === input.orderId
  );
  const settlementsById = new Map<string, SettlementDoc>();
  for (const settlement of input.settlements) {
    const id = String(settlement.id);
    if (!settlementsById.has(id)) settlementsById.set(id, settlement);
  }
  const codReceived = buildCodReceivedSet(Array.from(settlementsById.values()));
  return { sellerEntries, settlementsById, codReceived };
}
