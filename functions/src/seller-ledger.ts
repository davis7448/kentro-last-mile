/**
 * Elegibilidad del saldo de una tienda para liquidacion.
 *
 * Estos helpers vivian dentro de store-api.ts, pero la misma regla la necesitan tanto la API
 * de solo lectura como el callable que registra una solicitud de liquidacion. Reimplementarla
 * por tercera vez seria la peor opcion posible: es la logica que decide cuanta plata se le
 * paga a una tienda, y ya estaba duplicada entre la UI, store-api.ts y createSettlement.
 */

export type OrderDoc = Record<string, any>;
export type WalletEntryDoc = Record<string, any>;
export type SettlementDoc = Record<string, any>;

/**
 * Pedidos cuyo COD ya entro de la flota. Es LA definicion (spec 018, RF_04), la que usa el corte:
 * cashAllocations cubiertas cuando existen; si no, el corte del domiciliario pagado o conciliado.
 * Antes el cliente y esta funcion aceptaban ademas `cashPendingCop === 0` en un corte pendiente, y
 * el corte no: la pantalla podia prometer un pago que el corte no cerraba.
 */
export function buildCodReceivedSet(settlements: SettlementDoc[]) {
  const codReceived = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver") continue;
    if (Array.isArray(settlement.cashAllocations) && settlement.cashAllocations.length > 0) {
      for (const allocation of settlement.cashAllocations) {
        if (allocation.covered && allocation.orderId) codReceived.add(String(allocation.orderId));
      }
      continue;
    }
    if (settlement.status === "paid" || settlement.status === "reconciled") {
      for (const orderId of settlement.orderIds ?? []) codReceived.add(String(orderId));
    }
  }
  return codReceived;
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
