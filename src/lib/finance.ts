import type { AppState, CashReceipt, Order, Settlement, WalletEntry } from "./types";

const dandaSellerIds = new Set(["seller-1779315416119"]);
const dandaPreferredDriverId = "driver-1778271901513";
const dandaDriverPayCutoff = Date.parse("2026-06-09T05:00:00.000Z");

type Tariffs = {
  sellerDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  fulfillmentFeeCop: number;
  driverDeliveredPayCop: number;
  driverFailedPayCop: number;
};

export function isChargeableFailedOrder(order: Pick<Order, "status" | "failedCategory">) {
  return order.status === "failed" && (order.failedCategory ?? "failed_visit") === "failed_visit";
}

function applySellerTariffOverrides(order: Order, tariffs: Tariffs): Tariffs {
  if (!dandaSellerIds.has(order.sellerId)) {
    return {
      ...tariffs,
      sellerFailedFeeCop: 12000
    };
  }
  const pickedUpAt = order.pickedUpAt ? Date.parse(order.pickedUpAt) : Number.NaN;
  const usesNewDriverPay =
    order.driverId === dandaPreferredDriverId &&
    Number.isFinite(pickedUpAt) &&
    pickedUpAt >= dandaDriverPayCutoff;
  return {
    ...tariffs,
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 0,
    driverDeliveredPayCop: usesNewDriverPay ? 11000 : 10000,
    driverFailedPayCop: 0
  };
}

export function formatCop(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(value);
}

export function normalizeProductName(value?: string) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type ProductCostLine = {
  productId?: string;
  productName?: string;
  supplierId?: string;
  supplierName?: string;
  unitCostCop: number;
  quantity: number;
  totalCostCop: number;
};

export function findCatalogMatch(
  state: AppState,
  sellerId: string,
  options: { sku?: string; productName?: string; productId?: string }
) {
  const catalog = state.productCatalog ?? [];
  const normalizedSku = options.sku?.trim().toUpperCase();
  const normalizedName = normalizeProductName(options.productName);
  return (
    (options.productId ? catalog.find((item) => item.id === options.productId && item.sellerId === sellerId && item.active !== false) : undefined) ??
    (normalizedSku ? catalog.find((item) => item.sellerId === sellerId && item.sku?.trim().toUpperCase() === normalizedSku && item.active !== false) : undefined) ??
    (normalizedName ? catalog.find((item) => item.sellerId === sellerId && !item.sku && item.normalizedProductName === normalizedName && item.active !== false) : undefined)
  );
}

// Costo de producto por linea/SKU: una entrada por producto del catalogo, cobrando costo
// unitario x cantidad. Si el pedido trae lineItems se calcula por linea (soporta combos y
// productos adicionales en un mismo pedido); si no, usa los campos colapsados (pedidos manuales
// o historicos de un solo producto). El costo del catalogo se interpreta SIEMPRE como por unidad.
export function productCostLinesForOrder(
  order: Pick<Order, "sellerId" | "productId" | "sku" | "productName" | "quantity" | "lineItems">,
  state: AppState
): ProductCostLine[] {
  const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
  const rawLines = hasLineItems
    ? order.lineItems!
    : [{ sku: order.sku, productName: order.productName, quantity: order.quantity }];
  const byProduct = new Map<string, ProductCostLine>();
  for (const line of rawLines) {
    const quantity = Math.max(1, Number(line.quantity) || 1);
    const product = findCatalogMatch(state, order.sellerId, {
      sku: line.sku,
      productName: line.productName,
      productId: hasLineItems ? undefined : order.productId
    });
    if (!product || !product.productCostConfigured) continue;
    const unitCostCop = Math.max(0, Number(product.productCostCop) || 0);
    const existing = byProduct.get(product.id);
    if (existing) {
      existing.quantity += quantity;
      existing.totalCostCop = existing.unitCostCop * existing.quantity;
    } else {
      const supplier = state.suppliers.find((item) => item.id === product.supplierId);
      byProduct.set(product.id, {
        productId: product.id,
        productName: product.name,
        supplierId: product.supplierId,
        supplierName: supplier?.name,
        unitCostCop,
        quantity,
        totalCostCop: unitCostCop * quantity
      });
    }
  }
  return Array.from(byProduct.values());
}

export function sellerDeliveredFeeForOrder(order: Order, state: AppState): number {
  const zone = order.zoneId ? state.zones.find((item) => item.id === order.zoneId) : undefined;
  const tariffs = applySellerTariffOverrides(order, {
    sellerDeliveredFeeCop: zone?.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop,
    sellerFailedFeeCop: zone?.sellerFailedFeeCop || state.settings.sellerFailedFeeCop,
    fulfillmentFeeCop: zone?.fulfillmentFeeCop || state.settings.fulfillmentFeeCop,
    driverDeliveredPayCop: zone?.driverDeliveredPayCop || state.settings.driverDeliveredPayCop,
    driverFailedPayCop: zone?.driverFailedPayCop || state.settings.driverFailedPayCop
  });
  return tariffs.sellerDeliveredFeeCop;
}

export function entriesForClosedOrder(order: Order, state: AppState): WalletEntry[] {
  const now = new Date().toISOString();
  const entries: WalletEntry[] = [];
  const zone = order.zoneId ? state.zones.find((item) => item.id === order.zoneId) : undefined;
  const tariffs = applySellerTariffOverrides(order, {
    sellerDeliveredFeeCop: zone?.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop,
    sellerFailedFeeCop: zone?.sellerFailedFeeCop || state.settings.sellerFailedFeeCop,
    fulfillmentFeeCop: zone?.fulfillmentFeeCop || state.settings.fulfillmentFeeCop,
    driverDeliveredPayCop: zone?.driverDeliveredPayCop || state.settings.driverDeliveredPayCop,
    driverFailedPayCop: zone?.driverFailedPayCop || state.settings.driverFailedPayCop
  });

  if (order.status === "delivered" && order.paymentMethod === "cod") {
    entries.push({
      id: `we-${order.id}-cod`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "cod_revenue",
      amountCop: order.totalCop,
      description: `Recaudo COD pedido ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  if (order.status === "delivered") {
    entries.push({
      id: `we-${order.id}-seller-delivery-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "delivery_fee",
      amountCop: -tariffs.sellerDeliveredFeeCop,
      description: `Flete entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
    entries.push({
      id: `we-${order.id}-driver-delivery-pay`,
      ownerType: "driver",
      ownerId: order.driverId ?? "unassigned",
      orderId: order.id,
      type: "driver_earning",
      amountCop: tariffs.driverDeliveredPayCop,
      description: `Pago transportista entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
    const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
    const productCostLines = productCostLinesForOrder(order, state);
    for (const line of productCostLines) {
      entries.push({
        id: hasLineItems ? `we-${order.id}-product-cost-${line.productId}` : `we-${order.id}-product-cost`,
        ownerType: "seller",
        ownerId: order.sellerId,
        orderId: order.id,
        type: "product_cost",
        amountCop: -line.totalCostCop,
        description: `Costo producto ${order.shopifyOrderId}`,
        supplierId: line.supplierId,
        supplierName: line.supplierName,
        productId: line.productId,
        productName: line.productName,
        createdAt: now
      });
    }
  }

  const chargeableFailed = isChargeableFailedOrder(order);
  if (chargeableFailed) {
    if (tariffs.sellerFailedFeeCop > 0) {
      entries.push({
        id: `we-${order.id}-seller-failed-fee`,
        ownerType: "seller",
        ownerId: order.sellerId,
        orderId: order.id,
        type: "failed_fee",
        amountCop: -tariffs.sellerFailedFeeCop,
        description: `Cobro fallido ${order.shopifyOrderId}`,
        createdAt: now
      });
    }
    if (tariffs.driverFailedPayCop > 0) {
      entries.push({
        id: `we-${order.id}-driver-failed-pay`,
        ownerType: "driver",
        ownerId: order.driverId ?? "unassigned",
        orderId: order.id,
        type: "driver_earning",
        amountCop: tariffs.driverFailedPayCop,
        description: `Pago transportista fallido ${order.shopifyOrderId}`,
        createdAt: now
      });
    }
  }

  if (order.fulfillmentMode === "warehouse" && (order.status === "delivered" || chargeableFailed)) {
    entries.push({
      id: `we-${order.id}-fulfillment-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "fulfillment_fee",
      amountCop: -tariffs.fulfillmentFeeCop,
      description: `Fulfillment desde bodega ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  return entries;
}

export function sellerBalance(state: AppState, sellerId: string) {
  const ledgerCop = state.wallet
    .filter((entry) => entry.ownerType === "seller" && entry.ownerId === sellerId)
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const pendingOrders = state.orders.filter(
    (order) =>
      order.sellerId === sellerId &&
      !["delivered", "failed", "cancelled", "liquidated"].includes(order.status)
  ).length;
  const reservedCop = pendingOrders * state.settings.pendingReserveCop;
  return { ledgerCop, pendingOrders, reservedCop, availableCop: Math.max(0, ledgerCop - reservedCop) };
}

export type DriverSettlementCashRow = {
  settlementId: string;
  label: string;
  orderCount: number;
  orders: DriverUnsettledCashOrderRow[];
  expectedCashCop: number;
  receivedCop: number;
  pendingCop: number;
  status: Settlement["status"];
  createdAt: string;
  note?: string;
};

export type DriverCashReceiptRow = {
  id: string;
  settlementId: string;
  settlementLabel: string;
  amountCop: number;
  receivedAt: string;
  pendingAfterCop: number;
  note?: string;
  synthetic?: boolean;
};

export type DriverUnsettledCashOrderRow = {
  orderId: string;
  trackingCode: string;
  shopifyOrderId: string;
  status?: Order["status"];
  totalCop: number;
  driverPayCop: number;
  expectedCashCop: number;
};

export type DriverFinancialSummary = {
  pendingBalanceCop: number;
  receivedCop: number;
  incompleteSettlementsCop: number;
  unsettledCashCop: number;
  incompleteSettlements: DriverSettlementCashRow[];
  settlementRows: DriverSettlementCashRow[];
  receiptRows: DriverCashReceiptRow[];
  unsettledOrders: DriverUnsettledCashOrderRow[];
};

export type DriverSettlementFinancials = {
  codCop: number;
  feesCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  cashToReturnCop: number;
  receivableCop: number;
  netCop: number;
};

export function calculateDriverSettlementFinancials(
  wallet: WalletEntry[],
  settlement: Pick<Settlement, "ownerId" | "walletEntryIds" | "orderIds">
): DriverSettlementFinancials {
  const walletEntryIds = settlement.walletEntryIds ?? [];
  const storedOrderIds = settlement.orderIds ?? [];
  const orderIds = storedOrderIds.length > 0
    ? storedOrderIds
    : Array.from(new Set(
      wallet
        .filter((entry) => walletEntryIds.includes(entry.id))
        .map((entry) => entry.orderId)
        .filter(Boolean) as string[]
    ));
  const orderIdSet = new Set(orderIds);
  const relatedSellerEntries = wallet.filter((entry) => entry.ownerType === "seller" && entry.orderId && orderIdSet.has(entry.orderId));
  const codCop = relatedSellerEntries
    .filter((entry) => entry.type === "cod_revenue")
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const feesCop = Math.max(0, -relatedSellerEntries
    .filter((entry) => entry.type === "delivery_fee" || entry.type === "failed_fee" || entry.type === "fulfillment_fee")
    .reduce((sum, entry) => sum + entry.amountCop, 0));
  const driverPayCop = wallet
    .filter((entry) =>
      entry.type === "driver_earning" &&
      (
        walletEntryIds.includes(entry.id) ||
        (entry.ownerType === "driver" && entry.ownerId === settlement.ownerId && Boolean(entry.orderId && orderIdSet.has(entry.orderId)))
      )
    )
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const netCop = driverPayCop - codCop;
  return {
    codCop,
    feesCop,
    driverPayCop,
    platformMarginCop: feesCop - driverPayCop,
    cashToReturnCop: Math.max(0, codCop - driverPayCop),
    receivableCop: Math.max(0, driverPayCop - codCop),
    netCop
  };
}

function settlementLabel(settlement: Pick<Settlement, "id" | "startDate" | "endDate">) {
  if (settlement.startDate && settlement.endDate) return `${settlement.startDate} a ${settlement.endDate}`;
  return settlement.id;
}

function settlementOrderIds(settlement: Settlement, wallet: WalletEntry[]) {
  const storedOrderIds = settlement.orderIds ?? [];
  const walletEntryIds = settlement.walletEntryIds ?? [];
  if (storedOrderIds.length > 0) return storedOrderIds;
  return Array.from(new Set(
    wallet
      .filter((entry) => walletEntryIds.includes(entry.id))
      .map((entry) => entry.orderId)
      .filter(Boolean) as string[]
  ));
}

function driverPayForOrder(wallet: WalletEntry[], driverId: string, orderId: string) {
  return wallet
    .filter((entry) => entry.ownerType === "driver" && entry.ownerId === driverId && entry.orderId === orderId && entry.type === "driver_earning")
    .reduce((sum, entry) => sum + entry.amountCop, 0);
}

function cashExpectedForSettlement(state: AppState, settlement: Settlement, orderIds: string[]) {
  const orderIdSet = new Set(orderIds);
  const walletEntryIds = settlement.walletEntryIds ?? [];
  const codCop = settlement.codCop > 0
    ? settlement.codCop
    : state.wallet
      .filter((entry) => entry.ownerType === "seller" && entry.orderId && orderIdSet.has(entry.orderId) && entry.type === "cod_revenue")
      .reduce((sum, entry) => sum + entry.amountCop, 0);
  const driverPayCop = settlement.driverPayCop > 0
    ? settlement.driverPayCop
    : state.wallet
      .filter((entry) => walletEntryIds.includes(entry.id) && entry.type === "driver_earning")
      .reduce((sum, entry) => sum + entry.amountCop, 0);
  return Math.max(0, codCop - driverPayCop);
}

function receiptDate(receipt: CashReceipt, fallback: string) {
  return receipt.receivedAt ?? receipt.createdAt ?? fallback;
}

export function calculateDriverFinancialSummary(state: AppState, driverId: string): DriverFinancialSummary {
  const driverSettlements = state.settlements.filter((settlement) => settlement.kind === "driver" && settlement.ownerId === driverId);
  const settledOrderIds = new Set<string>();
  const settlementRows: DriverSettlementCashRow[] = [];
  const receiptRows: DriverCashReceiptRow[] = [];

  for (const settlement of driverSettlements) {
    const orderIds = settlementOrderIds(settlement, state.wallet);
    for (const orderId of orderIds) settledOrderIds.add(orderId);

    const expectedCashCop = cashExpectedForSettlement(state, settlement, orderIds);
    const receipts = settlement.cashReceipts ?? [];
    const receivedFromReceipts = receipts.reduce((sum, receipt) => sum + Math.max(0, Number(receipt.amountCop) || 0), 0);
    const hasExplicitPending = typeof settlement.cashPendingCop === "number";
    const pendingCop = hasExplicitPending
      ? Math.max(0, Number(settlement.cashPendingCop) || 0)
      : settlement.status === "pending"
        ? Math.max(0, expectedCashCop - receivedFromReceipts)
        : 0;
    const receivedCop = receipts.length > 0 ? receivedFromReceipts : Math.max(0, expectedCashCop - pendingCop);
    const label = settlementLabel(settlement);

    // Detalle por pedido del corte (nivel caja: COD recaudado, pago al domiciliario, efectivo esperado).
    const orders: DriverUnsettledCashOrderRow[] = orderIds.map((orderId) => {
      const order = state.orders.find((item) => item.id === orderId);
      const orderDriverPayCop = driverPayForOrder(state.wallet, driverId, orderId);
      const codCop = order && order.paymentMethod === "cod" ? Math.max(0, Number(order.totalCop) || 0) : 0;
      return {
        orderId,
        trackingCode: order?.trackingCode ?? orderId,
        shopifyOrderId: order?.shopifyOrderId ?? "",
        status: order?.status,
        totalCop: codCop,
        driverPayCop: orderDriverPayCop,
        expectedCashCop: Math.max(0, codCop - orderDriverPayCop)
      };
    });

    settlementRows.push({
      settlementId: settlement.id,
      label,
      orderCount: orderIds.length,
      orders,
      expectedCashCop,
      receivedCop,
      pendingCop,
      status: settlement.status,
      createdAt: settlement.createdAt,
      note: settlement.note
    });

    if (receipts.length > 0) {
      for (const receipt of receipts) {
        receiptRows.push({
          id: receipt.id ?? `${settlement.id}-${receiptDate(receipt, settlement.createdAt)}-${receipt.amountCop}`,
          settlementId: settlement.id,
          settlementLabel: label,
          amountCop: Math.max(0, Number(receipt.amountCop) || 0),
          receivedAt: receiptDate(receipt, settlement.createdAt),
          pendingAfterCop: pendingCop,
          note: receipt.note
        });
      }
    } else if (receivedCop > 0) {
      receiptRows.push({
        id: `${settlement.id}-legacy-received`,
        settlementId: settlement.id,
        settlementLabel: label,
        amountCop: receivedCop,
        receivedAt: settlement.paidAt ?? settlement.reconciledAt ?? settlement.createdAt,
        pendingAfterCop: pendingCop,
        note: "Registro historico sin recibos detallados.",
        synthetic: true
      });
    }
  }

  const unsettledOrders = state.orders
    .filter((order) => order.driverId === driverId && order.status === "delivered" && order.paymentMethod === "cod" && !settledOrderIds.has(order.id))
    .map((order) => {
      const driverPayCop = driverPayForOrder(state.wallet, driverId, order.id);
      return {
        orderId: order.id,
        trackingCode: order.trackingCode ?? order.id,
        shopifyOrderId: order.shopifyOrderId,
        status: order.status,
        totalCop: order.totalCop,
        driverPayCop,
        expectedCashCop: Math.max(0, order.totalCop - driverPayCop)
      };
    });

  const incompleteSettlements = settlementRows.filter((row) => row.pendingCop > 0);
  const incompleteSettlementsCop = incompleteSettlements.reduce((sum, row) => sum + row.pendingCop, 0);
  const unsettledCashCop = unsettledOrders.reduce((sum, row) => sum + row.expectedCashCop, 0);

  return {
    pendingBalanceCop: incompleteSettlementsCop + unsettledCashCop,
    receivedCop: settlementRows.reduce((sum, row) => sum + row.receivedCop, 0),
    incompleteSettlementsCop,
    unsettledCashCop,
    incompleteSettlements,
    settlementRows: settlementRows.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    receiptRows: receiptRows.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt)),
    unsettledOrders: unsettledOrders.sort((left, right) => left.trackingCode.localeCompare(right.trackingCode))
  };
}

export function weeklyFailedRate(state: AppState, driverId: string) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const closed = state.orders.filter((order) => {
    const closedStatus = order.status === "delivered" || order.status === "failed";
    return order.driverId === driverId && closedStatus && new Date(order.updatedAt).getTime() >= weekAgo;
  });
  const excluded = closed.filter((order) => order.status === "failed" && (order.failedCategory === "no_coverage" || order.failedCategory === "bad_order_or_no_contact")).length;
  const total = Math.max(0, closed.length - excluded);
  const failed = closed.filter(isChargeableFailedOrder).length;
  return { total, failed, rate: total === 0 ? 0 : Math.round((failed / total) * 100) };
}
