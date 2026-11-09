/**
 * Elegibilidad del saldo de una tienda para liquidacion.
 *
 * Estos helpers vivian dentro de store-api.ts, pero la misma regla la necesitan tanto la API
 * de solo lectura como el callable que registra una solicitud de liquidacion. Reimplementarla
 * por tercera vez seria la peor opcion posible: es la logica que decide cuanta plata se le
 * paga a una tienda, y ya estaba duplicada entre la UI, store-api.ts y createSettlement.
 */

import { COD_ENTRY_TYPES, lastRecalculatedAt } from "./driver-cash-ledger";
import { isDriverSettlementCashSettled, type SettlementDoc as MathSettlementDoc } from "./settlement-math";

export type OrderDoc = Record<string, any>;
export type WalletEntryDoc = Record<string, any>;
export type SettlementDoc = Record<string, any>;

/**
 * Pedidos cuyo COD ya entro de la flota. Es LA definicion (spec 018, RF_04), la que usa el corte:
 * cashAllocations cubiertas cuando existen; si no, el corte del domiciliario pagado o conciliado.
 * Antes el cliente y esta funcion aceptaban ademas `cashPendingCop === 0` en un corte pendiente, y
 * el corte no: la pantalla podia prometer un pago que el corte no cerraba.
 *
 * Spec 027: en un corte saldado en total (`isDriverSettlementCashSettled`) cuentan TODAS sus
 * asignaciones, cubiertas o no. Lo esperado del corte descuenta el pago del domiciliario por visitas
 * fallidas (a menudo de otras tiendas), y el reparto pedido a pedido no: cuando el lider entrega
 * exactamente lo esperado, los ultimos pedidos quedaban "sin cubrir" aunque el efectivo entro entero.
 * Solo se recorren las asignaciones (RF_01b): un pedido que estaba en el corte sin deber efectivo no
 * entra por el. Con faltante real (RF_03) siguen contando solo las cubiertas.
 *
 * Spec 038 (RF_11, RF_12): un pedido que ya entro en un corte calculado con la regla nueva (con
 * `cashCharges`) ademas tiene que pasar `isOrderCodSettled`. `codByOrder` son sus asientos de recaudo
 * (`cod_revenue`/`cod_remittance`, cualquier tienda); sin el, ese pedido NO se da por recibido: es mas
 * estricto, nunca mas laxo. Un pedido que solo esta en cortes viejos sigue exactamente con la regla de hoy.
 */
export function buildCodReceivedSet(settlements: SettlementDoc[], codByOrder?: ReadonlyMap<string, readonly CodEntryLike[]>) {
  const codReceived = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver") continue;
    if (Array.isArray(settlement.cashAllocations) && settlement.cashAllocations.length > 0) {
      const settled = isDriverSettlementCashSettled(settlement as MathSettlementDoc);
      for (const allocation of settlement.cashAllocations) {
        if ((allocation.covered || settled) && allocation.orderId) codReceived.add(String(allocation.orderId));
      }
      continue;
    }
    if (settlement.status === "paid" || settlement.status === "reconciled") {
      for (const orderId of settlement.orderIds ?? []) codReceived.add(String(orderId));
    }
  }
  const inNewCortes = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || !Array.isArray(settlement.cashCharges)) continue;
    for (const charge of settlement.cashCharges) if (charge?.orderId) inNewCortes.add(String(charge.orderId));
  }
  for (const orderId of inNewCortes) {
    const codEntries = codByOrder?.get(orderId);
    if (!codEntries || !isOrderCodSettled(orderId, settlements, codEntries)) codReceived.delete(orderId);
    else codReceived.add(orderId);
  }
  return codReceived;
}

/**
 * El efectivo de un pedido en UN corte de domiciliario ya llego: su asignacion cubierta, o el corte saldado en
 * total (spec 027 RF_01). Es la pieza por corte de la regla de recibido; la usan `isOrderCodSettled` y la
 * conciliacion de la 026, para que no haya dos copias.
 */
export function isOrderCashSettledInCorte(settlement: SettlementDoc, orderId: string): boolean {
  if (isDriverSettlementCashSettled(settlement as MathSettlementDoc)) return true;
  return (settlement.cashAllocations ?? []).some((row: { orderId?: string; covered?: boolean }) => String(row?.orderId ?? "") === orderId && Boolean(row?.covered));
}

/** Lo minimo de un asiento de recaudo que necesita la regla de recibido. */
export type CodEntryLike = { amountCop: number; createdAt?: string };

/**
 * El `codByOrder` de `buildCodReceivedSet` a partir de los asientos que ya lee el llamador (spec 038 T16): el
 * recaudo de tienda (`cod_revenue`/`cod_remittance`) por pedido, de cualquier tienda. Lo demas se ignora, asi
 * que se le puede pasar la lectura entera.
 */
export function codEntriesByOrder(entries: readonly WalletEntryDoc[]): Map<string, CodEntryLike[]> {
  const byOrder = new Map<string, CodEntryLike[]>();
  for (const entry of entries) {
    const orderId = String(entry?.orderId ?? "");
    if (!orderId || entry.ownerType !== "seller" || !COD_ENTRY_TYPES.has(entry.type)) continue;
    const list = byOrder.get(orderId) ?? [];
    list.push(entry as CodEntryLike);
    byOrder.set(orderId, list);
  }
  return byOrder;
}

/**
 * La parte nueva de "recibido" (spec 038 RF_11; plan §3.7) para un pedido con algun corte de domiciliario
 * calculado con la regla nueva:
 *
 * 1. todo corte nuevo que le cobro efectivo (`chargedCop > 0`) esta saldado para el pedido: su asignacion
 *    cubierta (aunque el corte siga pendiente, como hoy), o el corte saldado en total (spec 027 RF_01);
 * 2. hay al menos un corte nuevo saldado para el pedido que lo tiene en `cashCharges` (un corte que solo
 *    devuelve cuenta si esta saldado en total), y ningun asiento de recaudo del pedido, de cualquier signo,
 *    es POSTERIOR al ultimo recalculo del ultimo de ellos.
 *
 * Se compara por tiempo, no por monto (analyze B5): con montos, A cobra 78.900, B lo devuelve y se salda, y
 * una re-entrega de 78.900 pasaba por recibida antes de que el domiciliario la entregara.
 */
export function isOrderCodSettled(orderId: string, settlements: SettlementDoc[], codEntries: readonly CodEntryLike[]): boolean {
  let lastSettledAt = "";
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || !Array.isArray(settlement.cashCharges)) continue;
    const charge = settlement.cashCharges.find((row: { orderId?: string }) => String(row?.orderId ?? "") === orderId);
    if (!charge) continue;
    // Un cargo positivo exige su efectivo: asignacion cubierta (aunque el corte siga pendiente, como hoy en la
    // 018 RF_04) o corte saldado en total. Un corte que solo devuelve cuenta si esta saldado en total.
    const settled = Number(charge.chargedCop) > 0
      ? isOrderCashSettledInCorte(settlement, orderId)
      : isDriverSettlementCashSettled(settlement as MathSettlementDoc);
    if (Number(charge.chargedCop) > 0 && !settled) return false;
    if (settled) {
      const at = lastRecalculatedAt(settlement as MathSettlementDoc);
      if (at > lastSettledAt) lastSettledAt = at;
    }
  }
  if (!lastSettledAt) return false;
  return !codEntries.some((entry) => String(entry.createdAt ?? "") > lastSettledAt);
}

/**
 * Efectivo ya recibido de la flota por pedidos cuyo COD aun NO cuenta como recibido (spec 026,
 * RF_01): suma, entre cortes de domiciliario, el `receivedCop` de las asignaciones no cubiertas.
 * La regla de "recibido" es la de buildCodReceivedSet; aqui solo se excluye lo que ella acepta.
 */
export function codPartialReceivedCop(settlements: SettlementDoc[], codByOrder?: ReadonlyMap<string, readonly CodEntryLike[]>): Map<string, number> {
  const received = buildCodReceivedSet(settlements, codByOrder);
  const partial = new Map<string, number>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || !Array.isArray(settlement.cashAllocations)) continue;
    for (const allocation of settlement.cashAllocations) {
      if (allocation.covered || !allocation.orderId) continue;
      const receivedCop = Number(allocation.receivedCop) || 0;
      if (receivedCop <= 0) continue;
      const orderId = String(allocation.orderId);
      if (received.has(orderId)) continue;
      partial.set(orderId, (partial.get(orderId) ?? 0) + receivedCop);
    }
  }
  return partial;
}

// Tipos de asiento del seller que cuentan para la liquidacion/saldo (misma lista
// que isLiquidationWalletType en functions/src/orders.ts, sin driver_earning).
export const SELLER_LIQUIDATION_TYPES = new Set(["cod_revenue", "cod_remittance", "delivery_fee", "failed_fee", "fulfillment_fee", "product_cost", "seller_abono", "gmf_tax"]);

// Elegibilidad para pago, misma compuerta que createSettlement (orders.ts):
// los abonos siempre; si no, el pedido debe existir y ser prepago o tener el COD ya recibido.
export function isSellerEntryEligible(entry: WalletEntryDoc, ordersById: Map<string, OrderDoc>, codReceived: Set<string>) {
  // Ni los abonos ni el 4x1000 cuelgan de un pedido: no pasan por la compuerta de COD recibido.
  if (entry.type === "seller_abono" || entry.type === "gmf_tax") return true;
  if (!entry.orderId) return false;
  const order = ordersById.get(String(entry.orderId));
  if (!order) return false;
  if (order.paymentMethod === "prepaid") return true;
  // Un pedido no entregado (fallido) no tiene COD por recaudar: su cobro no debe esperar.
  if (order.status !== "delivered" && order.status !== "liquidated") return true;
  return codReceived.has(String(entry.orderId));
}

/**
 * Un corte con rango ABIERTO (startDate/endDate vacios) se lleva todo lo pendiente de la cuenta.
 * Un corte es el total de lo que se debe, no lo que se debe dentro de una ventana; acotarlo por
 * fecha dejaba fuera lo mas antiguo, que es justo lo que lleva mas tiempo sin pagarse. Se
 * conserva el filtro cuando el llamante manda fechas, porque los cortes historicos se crearon asi.
 */
export function isWithinSettlementRange(entryDate: string, startDate: string, endDate: string) {
  return (!startDate || entryDate >= startDate) && (!endDate || entryDate <= endDate);
}
