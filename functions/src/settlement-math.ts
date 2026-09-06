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
import { gmfForPayout } from "./gmf";

export type WalletEntryDoc = {
  id: string;
  ownerType: "seller" | "driver" | "admin";
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
    | "gmf_tax";
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
  kind: "seller" | "driver" | "supplier";
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

/** Lo que `computeDriverCashSummary` necesita del mundo. Se carga una sola vez por invocacion. */
export type DriverCashInputs = {
  sellerEntries: WalletEntryDoc[];
  driverEntries: WalletEntryDoc[];
  orderMeta: Map<string, SettlementOrderDoc>;
};

export function settlementCashReceivedCop(settlement: SettlementDoc) {
  if (typeof settlement.cashReceivedCop === "number") {
    return Math.max(0, Number(settlement.cashReceivedCop) || 0);
  }
  return (settlement.cashReceipts ?? []).reduce((sum, receipt) => sum + Math.max(0, Number(receipt.amountCop) || 0), 0);
}

/**
 * Efectivo que el domiciliario debe entregar por los pedidos de un corte, y como se
 * imputa lo ya recibido pedido por pedido.
 */
export function computeDriverCashSummary(
  inputs: DriverCashInputs,
  settlementOrderIds: string[],
  receivedCop: number
): DriverCashSummary {
  const orderIds = Array.from(new Set(settlementOrderIds ?? []));
  if (orderIds.length === 0) {
    return { codCop: 0, feesCop: 0, driverPayCop: 0, platformMarginCop: 0, expectedCop: 0, allocations: [] };
  }

  const orderIdSet = new Set(orderIds);
  const codByOrder = new Map<string, number>();
  const feesByOrder = new Map<string, number>();
  for (const entry of inputs.sellerEntries) {
    const orderId = String(entry.orderId ?? "");
    if (!orderIdSet.has(orderId)) continue;
    // cod_remittance neteado: una reversa de COD (pedido revertido a fallido) deja
    // el COD del pedido en 0 y no debe figurar como efectivo esperado del domiciliario.
    if (entry.type === "cod_revenue" || entry.type === "cod_remittance") {
      codByOrder.set(orderId, (codByOrder.get(orderId) ?? 0) + Number(entry.amountCop || 0));
    }
    if (["delivery_fee", "failed_fee", "fulfillment_fee"].includes(entry.type)) {
      feesByOrder.set(orderId, (feesByOrder.get(orderId) ?? 0) + Number(entry.amountCop || 0));
    }
  }
  const driverPayByOrder = new Map<string, number>();
  for (const entry of inputs.driverEntries) {
    const orderId = String(entry.orderId ?? "");
    if (entry.type !== "driver_earning" || !orderIdSet.has(orderId)) continue;
    driverPayByOrder.set(orderId, (driverPayByOrder.get(orderId) ?? 0) + Number(entry.amountCop || 0));
  }
  const sortedOrderIds = orderIds
    .filter((orderId) => Math.max(0, (codByOrder.get(orderId) ?? 0) - (driverPayByOrder.get(orderId) ?? 0)) > 0)
    .sort((left, right) => {
      const leftOrder = inputs.orderMeta.get(left);
      const rightOrder = inputs.orderMeta.get(right);
      return (
        String(leftOrder?.createdAt ?? "").localeCompare(String(rightOrder?.createdAt ?? "")) ||
        String(leftOrder?.trackingCode ?? left).localeCompare(String(rightOrder?.trackingCode ?? right))
      );
    });

  let remaining = Math.max(0, Number(receivedCop) || 0);
  const allocations = sortedOrderIds.map((orderId) => {
    const expectedOrderCop = Math.max(0, (codByOrder.get(orderId) ?? 0) - (driverPayByOrder.get(orderId) ?? 0));
    const receivedOrderCop = Math.min(expectedOrderCop, remaining);
    remaining -= receivedOrderCop;
    return {
      orderId,
      expectedCop: expectedOrderCop,
      receivedCop: receivedOrderCop,
      covered: receivedOrderCop >= expectedOrderCop
    };
  });

  const codCop = Array.from(codByOrder.values()).reduce((sum, amount) => sum + amount, 0);
  const feesCop = Math.max(0, -Array.from(feesByOrder.values()).reduce((sum, amount) => sum + amount, 0));
  const driverPayCop = Array.from(driverPayByOrder.values()).reduce((sum, amount) => sum + amount, 0);
  return {
    codCop,
    feesCop,
    driverPayCop,
    platformMarginCop: feesCop - driverPayCop,
    expectedCop: Math.max(0, codCop - driverPayCop),
    allocations
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

/**
 * Cifras de un corte a partir de sus asientos. En un corte de domiciliario el COD y los
 * fletes salen de los asientos de la TIENDA de esos mismos pedidos (`relatedSellerEntries`),
 * porque el domiciliario no tiene asientos de recaudo propios.
 */
export function settlementTotals(
  kind: "seller" | "driver" | "supplier",
  entries: WalletEntryDoc[],
  relatedSellerEntries: WalletEntryDoc[] = [],
  paysInCash = false
): SettlementTotals {
  const financialEntries = kind === "driver" ? relatedSellerEntries : entries;
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
  const grossNetCop = kind === "driver" ? driverPayCop - codCop : kind === "supplier" ? productCostCop : entryNetCop;
  // 4x1000 sobre lo que sale por transferencia. `netCop` es lo que de verdad se gira.
  const gmfCop = gmfForPayout(grossNetCop, paysInCash);
  return {
    codCop,
    feesCop,
    productCostCop,
    driverPayCop,
    platformMarginCop: kind === "seller" || kind === "driver" ? feesCop - driverPayCop : 0,
    grossNetCop,
    gmfCop,
    netCop: grossNetCop - gmfCop
  };
}
