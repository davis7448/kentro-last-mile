/**
 * Aritmetica de cortes, SIN acceso a Firestore.
 *
 * Existe para que la correccion administrativa de pedidos (order-corrections.ts) pueda
 * responder "como queda este corte DESPUES del cambio" sin escribir primero. La version
 * anterior de esta logica vivia dentro de `calculateDriverCashSummary`, que hacia sus
 * propias lecturas: eso obliga a commitear y recalcular en dos pasos (lo que hacian los
 * scripts de correccion), y si el proceso muere en medio el corte queda con cifras viejas
 * apuntando a asientos borrados.
 *
 * Con las lecturas fuera, el llamador carga los asientos una vez, aplica el delta EN
 * MEMORIA y evalua el resultado. La previsualizacion y la aplicacion recorren exactamente
 * el mismo codigo, asi que no pueden divergir.
 */
import { computeDriverCorte, type DriverCashCharge, type DriverLedgerContext } from "./driver-cash-ledger";
import { gmfForPayout } from "./gmf";

export type WalletEntryDoc = {
  id: string;
  ownerType: "seller" | "driver" | "admin" | "community_leader";
  ownerId: string;
  orderId: string;
  type:
    | "cod_revenue"
    | "cod_remittance"
    | "delivery_fee"
    | "failed_fee"
    | "fulfillment_fee"
    | "product_cost"
    | "driver_earning"
    | "platform_margin"
    | "cash_shortage"
    | "seller_abono"
    | "gmf_tax"
    | "community_cashback";
  amountCop: number;
  description: string;
  createdAt: string;
  settlementId?: string;
  supplierSettlementId?: string;
  supplierId?: string;
  supplierName?: string;
  productId?: string;
  productName?: string;
};

export type SettlementDoc = {
  id: string;
  kind: "seller" | "driver" | "supplier" | "community_leader";
  ownerId: string;
  ownerName: string;
  startDate: string;
  endDate: string;
  walletEntryIds: string[];
  orderIds: string[];
  codCop: number;
  feesCop: number;
  productCostCop?: number;
  driverPayCop: number;
  platformMarginCop: number;
  netCop: number;
  /** 4x1000 retenido en el corte. 0 si la cuenta cobra en efectivo. */
  gmfCop?: number;
  status: "pending" | "paid" | "reconciled";
  cashExpectedCop?: number;
  cashReceivedCop?: number;
  cashPendingCop?: number;
  cashExcessCop?: number;
  paidAmountCop?: number;
  cashReceiptStatus?: "none" | "partial" | "complete";
  cashReceipts?: Array<{ amountCop: number; receivedAt: string; note?: string }>;
  cashAllocations?: Array<{ orderId: string; expectedCop: number; receivedCop: number; covered: boolean }>;
  createdAt: string;
  paidAt?: string;
  reconciledAt?: string;
  note?: string;
};

export type SettlementOrderDoc = {
  paymentMethod?: "cod" | "prepaid";
  status?: string;
  createdAt?: string;
  trackingCode?: string;
};

export type DriverCashAllocation = {
  orderId: string;
  expectedCop: number;
  receivedCop: number;
  covered: boolean;
};

export type DriverCashSummary = {
  codCop: number;
  feesCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  expectedCop: number;
  allocations: DriverCashAllocation[];
};

/** Lo que la regla del corte de domiciliario necesita del mundo. Se carga una sola vez por invocacion. */
export type DriverCashInputs = {
  sellerEntries: WalletEntryDoc[];
  driverEntries: WalletEntryDoc[];
  /**
   * Asientos de cashback de lideres de comunidad. Opcional porque no interviene en el efectivo
   * del domiciliario —que es de lo que trata este modulo—, pero SI en el recalculo de un corte
   * pendiente: sin ellos, corregir un pedido vacia el corte del lider y le paga de menos.
   */
  leaderEntries?: WalletEntryDoc[];
  orderMeta: Map<string, SettlementOrderDoc>;
};

export function settlementCashReceivedCop(settlement: SettlementDoc) {
  if (typeof settlement.cashReceivedCop === "number") {
    return Math.max(0, Number(settlement.cashReceivedCop) || 0);
  }
  return (settlement.cashReceipts ?? []).reduce((sum, receipt) => sum + Math.max(0, Number(receipt.amountCop) || 0), 0);
}

/**
 * Corte de domiciliario con el efectivo total saldado (spec 026, plan 2.9): pagado o conciliado,
 * sin pendiente y con lo recibido >= lo esperado. No lee cashAllocations: una asignacion sin cubrir
 * en un corte saldado es un pedido cubierto por compensacion, no un faltante.
 */
export function isDriverSettlementCashSettled(settlement: SettlementDoc): boolean {
  return (
    settlement.kind === "driver" &&
    (settlement.status === "paid" || settlement.status === "reconciled") &&
    (settlement.cashPendingCop ?? 0) === 0 &&
    typeof settlement.cashExpectedCop === "number" &&
    settlementCashReceivedCop(settlement) >= settlement.cashExpectedCop
  );
}

export type DriverCorteSummaryInput = {
  inputs: DriverCashInputs;
  /** Id del corte que se calcula (al crearlo, el id que va a tener). */
  settlementId: string;
  orderIds: string[];
  /** Asientos de ESTE corte (`walletEntryIds`, o los que entran al crearlo). */
  ownEntryIds: string[];
  receivedCop: number;
  /** Obligatorio: los demas cortes del domiciliario, su foto historica y sus retenciones. */
  context: DriverLedgerContext;
};

/** Lo de `DriverCashSummary` mas lo que la 038 guarda en el corte. */
export type DriverCorteSummary = DriverCashSummary & {
  cashCharges: DriverCashCharge[];
  creditInCop: number;
  creditOutCop: number;
  grossNetCop: number;
  netCop: number;
  gmfCop: number;
  ledgerVersion: 1;
};

/**
 * Spec 038: las cifras de un corte de domiciliario con la regla nueva (cada recaudo se cobra una vez).
 * Delega en `computeDriverCorte` (driver-cash-ledger.ts), la unica regla. El contexto es obligatorio: sin
 * los demas cortes del domiciliario no se puede saber que ya se cobro, y calcular "a la antigua" fue lo que
 * le cobro $694.200 de mas a un domiciliario. La regla vieja (`computeDriverCashSummary`) se retiro en la T22.
 */
export function computeDriverCorteSummary(input: DriverCorteSummaryInput): DriverCorteSummary {
  if (!input.context) {
    throw new Error("Spec 038: computeDriverCorteSummary necesita el contexto del domiciliario (sus cortes, foto y retenciones).");
  }
  const figures = computeDriverCorte({
    settlementId: input.settlementId,
    orderIds: input.orderIds,
    ownEntryIds: input.ownEntryIds,
    entries: [...input.inputs.sellerEntries, ...input.inputs.driverEntries],
    context: input.context,
    receivedCop: input.receivedCop,
    orderMeta: input.inputs.orderMeta
  });
  return {
    codCop: figures.codCop,
    feesCop: figures.feesCop,
    driverPayCop: figures.driverPayCop,
    platformMarginCop: figures.platformMarginCop,
    expectedCop: figures.cashExpectedCop,
    allocations: figures.allocations,
    cashCharges: figures.charges,
    creditInCop: figures.creditInCop,
    creditOutCop: figures.creditOutCop,
    grossNetCop: figures.grossNetCop,
    netCop: figures.netCop,
    gmfCop: figures.gmfCop,
    ledgerVersion: 1
  };
}

export type SettlementTotals = {
  codCop: number;
  feesCop: number;
  productCostCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  grossNetCop: number;
  gmfCop: number;
  netCop: number;
};

/** Los cortes que se calculan con `settlementTotals`. El de domiciliario no: ver abajo. */
export type NonDriverSettlementKind = "seller" | "supplier" | "community_leader";

/**
 * Cifras de un corte de tienda, proveedor o lider a partir de sus asientos.
 *
 * Spec 038 T22: un corte de domiciliario NO pasa por aqui. Su rama vieja restaba todo el pago del pedido y no
 * sabia que cobraron otros cortes; sus cifras son las de `buildDriverSettlementFields` (driver-cash-ledger.ts).
 * Lanza si se le pide uno, para que nadie vuelva a calcularlo asi desde JavaScript sin tipos.
 */
export function settlementTotals(
  kind: NonDriverSettlementKind,
  entries: WalletEntryDoc[],
  paysInCash = false
): SettlementTotals {
  if ((kind as string) === "driver") {
    throw new Error("Spec 038: un corte de domiciliario se calcula con buildDriverSettlementFields, no con settlementTotals.");
  }
  const financialEntries = entries;
  const codCop = financialEntries
    .filter((entry) => entry.type === "cod_revenue" || entry.type === "cod_remittance")
    .reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  const feesCop = Math.max(
    0,
    -financialEntries
      .filter((entry) => entry.ownerType === "seller" && ["delivery_fee", "failed_fee", "fulfillment_fee"].includes(entry.type))
      .reduce((sum, entry) => sum + Number(entry.amountCop), 0)
  );
  const productCostCop = Math.max(
    0,
    -entries
      .filter((entry) => entry.ownerType === "seller" && entry.type === "product_cost")
      .reduce((sum, entry) => sum + Number(entry.amountCop), 0)
  );
  const driverPayCop = entries.filter((entry) => entry.type === "driver_earning").reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  const entryNetCop = entries.reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  const grossNetCop = kind === "supplier" ? productCostCop : entryNetCop;
  // 4x1000 sobre lo que sale por transferencia. `netCop` es lo que de verdad se gira.
  const gmfCop = gmfForPayout(grossNetCop, paysInCash);
  return {
    codCop,
    feesCop,
    productCostCop,
    driverPayCop,
    platformMarginCop: kind === "seller" ? feesCop - driverPayCop : 0,
    grossNetCop,
    gmfCop,
    netCop: grossNetCop - gmfCop
  };
}
