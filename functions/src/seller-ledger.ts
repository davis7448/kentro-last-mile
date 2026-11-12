/**
 * Elegibilidad del saldo de una tienda para liquidacion.
 *
 * Estos helpers vivian dentro de store-api.ts, pero la misma regla la necesitan tanto la API
 * de solo lectura como el callable que registra una solicitud de liquidacion. Reimplementarla
 * por tercera vez seria la peor opcion posible: es la logica que decide cuanta plata se le
 * paga a una tienda, y ya estaba duplicada entre la UI, store-api.ts y createSettlement.
 */

import { COD_ENTRY_TYPES } from "./driver-cash-ledger";
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
  const inNewCortes = ordersInNewCortes(settlements);
  // Spec 038 RF_11b (hallazgo H3): la parte nueva se SUMA a la regla de hoy. Un pedido con una asignacion sin
  // cubrir en un corte viejo (sin `cashCharges`) que no esta saldado en total sigue sin efectivo recibido, aunque
  // un corte nuevo saldado lo tenga.
  const uncoveredInOpenOldCorte = uncoveredInOpenOldCortes(settlements);
  for (const orderId of inNewCortes) {
    const codEntries = codByOrder?.get(orderId);
    if (!codEntries || uncoveredInOpenOldCorte.has(orderId) || !isOrderCodSettled(orderId, settlements, codEntries)) codReceived.delete(orderId);
    else codReceived.add(orderId);
  }
  return codReceived;
}

/** Pedidos que algun corte de domiciliario calculado con la 038 (con `cashCharges`) tiene. */
function ordersInNewCortes(settlements: SettlementDoc[]): Set<string> {
  const ids = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || !Array.isArray(settlement.cashCharges)) continue;
    for (const charge of settlement.cashCharges) if (charge?.orderId) ids.add(String(charge.orderId));
  }
  return ids;
}

/** RF_11b: pedidos con una asignacion sin cubrir en un corte viejo (sin `cashCharges`) no saldado en total. */
function uncoveredInOpenOldCortes(settlements: SettlementDoc[]): Set<string> {
  const ids = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || Array.isArray(settlement.cashCharges)) continue;
    if (isDriverSettlementCashSettled(settlement as MathSettlementDoc)) continue;
    for (const allocation of settlement.cashAllocations ?? []) {
      if (allocation?.orderId && !allocation.covered) ids.add(String(allocation.orderId));
    }
  }
  return ids;
}

/**
 * Spec 038 RF_12 (T30; hallazgo R2 de T28): de los pedidos que una vista PARCIAL tiene (los asientos de una
 * tienda, o solo los sin cortar), los que esa vista no da por recibidos y que mas asientos si podrian cambiar:
 * su efectivo ya llego y el ultimo corte saldado existe, pero el neto que ve la vista no es el que vio el corte.
 * El llamador lee los asientos completos de esos pedidos (`completeCodEntries`) y vuelve a decidir. A un pedido
 * que ya cuadra no se le leen mas: con todos sus asientos solo dejaria de cuadrar por un dato duplicado, y entonces
 * el domiciliario debe esa diferencia y el corte que la cobre lo bloquea (RF_11, primera condicion). En regimen
 * normal la lista sale vacia.
 */
export function codOrdersToComplete(settlements: SettlementDoc[], codByOrder: ReadonlyMap<string, readonly CodEntryLike[]>): string[] {
  const inNewCortes = ordersInNewCortes(settlements);
  const uncovered = uncoveredInOpenOldCortes(settlements);
  const ids: string[] = [];
  for (const [orderId, codEntries] of codByOrder) {
    if (!inNewCortes.has(orderId) || uncovered.has(orderId)) continue;
    if (codSettlementState(orderId, settlements, codEntries) === "net_mismatch") ids.push(orderId);
  }
  return ids.sort();
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
 * Cuando se calcularon por ultima vez las cifras (`cashCharges`) de un corte nuevo: al crearlo, al pagarlo y con
 * cada abono mientras estaba pendiente. Conciliar o abonar a un corte ya pagado NO recalcula (RF_04), asi que no
 * lo hace mas reciente. (`lastRecalculatedAt` cuenta esas fechas y por eso no sirve aqui.)
 */
function ledgerComputedAt(settlement: SettlementDoc): string {
  const paidAt = String(settlement.paidAt ?? "");
  const receipts = (Array.isArray(settlement.cashReceipts) ? settlement.cashReceipts : [])
    .map((receipt: { receivedAt?: string }) => String(receipt?.receivedAt ?? ""))
    .filter((at: string) => at && (!paidAt || at <= paidAt));
  return [String(settlement.createdAt ?? ""), paidAt, ...receipts].reduce((latest, at) => (at > latest ? at : latest), "");
}

/**
 * La parte nueva de "recibido" (spec 038 RF_11; plan §3.7 y §7.5) para un pedido con algun corte de domiciliario
 * calculado con la regla nueva:
 *
 * 1. todo corte nuevo que le cobro efectivo (`chargedCop > 0`) esta saldado para el pedido: su asignacion
 *    cubierta (aunque el corte siga pendiente, como hoy), o el corte saldado en total (spec 027 RF_01);
 * 2. hay al menos un corte nuevo saldado para el pedido que lo tiene en `cashCharges` (un corte que solo
 *    devuelve cuenta si esta saldado en total), y el recaudo neto vigente del pedido (todos sus asientos, de
 *    cualquier tienda) es el que vio el ultimo de ellos (`codSeenCop`).
 *
 * Segunda enmienda, 2026-11-12 (hallazgo R1 de T28): la primera ("lo posterior suma cero") fallaba cuando la
 * correccion borra y recrea el recaudo de una tienda que aun no cobro. Comparar con lo que vio el ultimo corte
 * saldado no depende de como se escribio el cambio. El caso B5 sigue bloqueado: el ultimo corte saldado es el
 * que devolvio, y vio 0.
 */
export function isOrderCodSettled(orderId: string, settlements: SettlementDoc[], codEntries: readonly CodEntryLike[]): boolean {
  return codSettlementState(orderId, settlements, codEntries) === "settled";
}

/**
 * La decision de `isOrderCodSettled` con su motivo: `cash_missing` (falta efectivo o no hay corte nuevo saldado:
 * mas asientos no lo cambian) o `net_mismatch` (el neto no es el que vio el ultimo corte saldado: lo cambian).
 */
function codSettlementState(orderId: string, settlements: SettlementDoc[], codEntries: readonly CodEntryLike[]): "settled" | "cash_missing" | "net_mismatch" {
  type Row = { ownerId: string; computedAt: string; createdAt: string; settled: boolean; otherDriver: boolean; codSeenCop: number };
  const later = (left: Row, right: Row) => left.computedAt > right.computedAt || (left.computedAt === right.computedAt && left.createdAt > right.createdAt);
  const rows: Row[] = [];
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || !Array.isArray(settlement.cashCharges)) continue;
    const charge = settlement.cashCharges.find((row: { orderId?: string }) => String(row?.orderId ?? "") === orderId);
    if (!charge) continue;
    // Un cargo positivo exige su efectivo: asignacion cubierta (aunque el corte siga pendiente, como hoy en la
    // 018 RF_04) o corte saldado en total. Un corte que solo devuelve cuenta si esta saldado en total.
    const settled = Number(charge.chargedCop) > 0
      ? isOrderCashSettledInCorte(settlement, orderId)
      : isDriverSettlementCashSettled(settlement as MathSettlementDoc);
    if (Number(charge.chargedCop) > 0 && !settled) return "cash_missing";
    rows.push({
      ownerId: String(settlement.ownerId ?? ""), computedAt: ledgerComputedAt(settlement), createdAt: String(settlement.createdAt ?? ""),
      settled, otherDriver: charge.codOtherDriver === true, codSeenCop: Number(charge.codSeenCop) || 0
    });
  }
  // T32/T33 (hallazgos N1 y M1): `codOtherDriver` dice que, al calcular ese corte, el pedido era de otro
  // domiciliario. Si el corte mas reciente de un domiciliario lleva la marca, ninguno de sus cortes decide: no le
  // cobro el recaudo de hoy (N1: su visita fallida, calculada despues, bloqueaba para siempre) y su corte viejo,
  // saldado cuando si lo entrego, ya no dice nada de el (M1: con la entrega pasada a otro, lo daba por recibido
  // antes de que nadie entregara el efectivo).
  const latestByDriver = new Map<string, Row>();
  for (const row of rows) {
    const current = latestByDriver.get(row.ownerId);
    if (!current || later(row, current)) latestByDriver.set(row.ownerId, row);
  }
  let governing: Row | null = null;
  for (const row of rows) {
    if (!row.settled || row.otherDriver || latestByDriver.get(row.ownerId)?.otherDriver) continue;
    if (!governing || later(row, governing)) governing = row;
  }
  if (!governing) return "cash_missing";
  const netCop = codEntries.reduce((sum, entry) => sum + (Number(entry.amountCop) || 0), 0);
  return netCop === governing.codSeenCop ? "settled" : "net_mismatch";
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
