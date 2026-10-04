/**
 * "Por cobrar al domiciliario" — la unica copia de la formula (spec 026, T3).
 *
 * Sale tal cual de `computePlatformPosition` para que la posicion de la plataforma y la lista de
 * efectivo no recibido (RNF_02) no puedan divergir: las dos llaman a esta funcion.
 *
 * Es lo pendiente en cortes de domiciliario MAS el COD de pedidos entregados que todavia no entraron
 * a ningun corte de domiciliario (neto de lo que se le paga al domiciliario por esos pedidos).
 *
 * Puro: sin Firestore. Los predicados `isReceivableCodEntry` / `isReceivableDriverPay` delimitan el
 * subconjunto del ledger que basta para el calculo; junto con los cortes `driver` da la misma cifra que
 * el ledger entero.
 */
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";

export type DriverReceivable = {
  driverReceivableCop: number;
  driverPendingInSettlementsCop: number;
  driverCodOutsideSettlementsCop: number;
};

/** COD de tienda que el domiciliario cobro y debe entregar. */
export function isReceivableCodEntry(entry: WalletEntryDoc): boolean {
  return entry.ownerType === "seller" && (entry.type === "cod_revenue" || entry.type === "cod_remittance");
}

/** Pago al domiciliario por un pedido: se descuenta del COD que debe. */
export function isReceivableDriverPay(entry: WalletEntryDoc): boolean {
  return entry.ownerType === "driver" && entry.type === "driver_earning";
}

/** Pedidos que ya entraron a algun corte de domiciliario. */
export function driverSettlementOrderIds(settlements: SettlementDoc[]): Set<string> {
  return new Set(
    settlements.filter((settlement) => settlement.kind === "driver").flatMap((settlement) => settlement.orderIds ?? [])
  );
}

export function computeDriverReceivable(wallet: WalletEntryDoc[], settlements: SettlementDoc[]): DriverReceivable {
  const sum = (entries: WalletEntryDoc[]) => entries.reduce((total, entry) => total + Math.round(entry.amountCop), 0);

  // Un corte sin `cashPendingCop` (asi lo crea buildSettlement) aporta 0.
  const driverPendingInSettlementsCop = settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + Math.round(Number(settlement.cashPendingCop) || 0), 0);

  const inDriverSettlements = driverSettlementOrderIds(settlements);
  const isOutside = (entry: WalletEntryDoc) => Boolean(entry.orderId) && !inDriverSettlements.has(entry.orderId);
  const outsideCod = sum(wallet.filter((entry) => isReceivableCodEntry(entry) && isOutside(entry)));
  const outsidePay = sum(wallet.filter((entry) => isReceivableDriverPay(entry) && isOutside(entry)));
  const driverCodOutsideSettlementsCop = Math.max(0, outsideCod - outsidePay);

  return {
    driverReceivableCop: driverPendingInSettlementsCop + driverCodOutsideSettlementsCop,
    driverPendingInSettlementsCop,
    driverCodOutsideSettlementsCop
  };
}
