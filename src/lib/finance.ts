import type { AppState, CashReceipt, Order, Settlement, WalletEntry } from "./types";
import type { Tariffs } from "../../functions/src/seller-charges";
// Import de VALOR a proposito: seller-charges.ts no importa nada, asi que entra al bundle del
// cliente sin arrastrar el servidor. Es la unica copia de la regla de cobro (ver su cabecera).
import { resolveSellerCharges, resolveTariffs } from "../../functions/src/seller-charges";

export function isChargeableFailedOrder(order: Pick<Order, "status" | "failedCategory">) {
  return order.status === "failed" && (order.failedCategory ?? "failed_visit") === "failed_visit";
}

/**
 * Un pedido solo retiene la liquidacion de su tienda mientras haya efectivo COD
 * pendiente de recibir del domiciliario, es decir cuando fue ENTREGADO y cobrado
 * contraentrega. Un fallido no recauda nada (nunca entra a cashAllocations), asi
 * que exigirle "COD recibido" dejaba su cobro bloqueado de forma permanente.
 * El backend replica esta regla en createSettlement y en la API de tiendas.
 */
export function orderHasPendingDriverCod(order: Pick<Order, "status" | "paymentMethod">) {
  return order.paymentMethod === "cod" && (order.status === "delivered" || order.status === "liquidated");
}

export function isOrderEligibleForSellerSettlement(
  order: Pick<Order, "id" | "status" | "paymentMethod">,
  codReceivedOrderIds: ReadonlySet<string>
) {
  return !orderHasPendingDriverCod(order) || codReceivedOrderIds.has(order.id);
}

/**
 * Lo que se cobra (y se paga) por este pedido, con la MISMA regla que el cierre del servidor:
 * `resolveTariffs` (zona > ajuste > defecto) y `resolveSellerCharges` (fallido fijo, DANDA).
 *
 * La fecha de entrega sale de la ultima evidencia de entrega y, si aun no existe, del
 * cierre/actualizacion del pedido: es la que decide el flete de DANDA por fecha de ENTREGA.
 */
function chargesForOrder(order: Order, state: AppState): Tariffs {
  const zone = order.zoneId ? state.zones.find((item) => item.id === order.zoneId) : undefined;
  const tariffs = resolveTariffs(state.settings, zone);
  const deliveryEvidence = [...(order.evidence ?? [])].reverse().find((item) => item.type === "delivery");
  const deliveredAtIso = deliveryEvidence?.createdAt ?? order.updatedAt ?? order.createdAt;
  return resolveSellerCharges(order, tariffs, deliveredAtIso);
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

/**
 * Fusiona una tanda de movimientos recien traidos sobre los que ya estan en memoria.
 *
 * Antes hacia `wallet.map(e => nuevos.find(n => n.id === e.id) ?? e)`: un barrido lineal de la
 * tanda por CADA movimiento del ledger. Con 8.174 movimientos y una pagina de 2.000 son 16
 * millones de comparaciones, 202 ms medidos, y ocurre dentro de un setState que ademas dispara
 * el recalculo entero de la pantalla. Con indice por id son 1,9 ms.
 */
export function mergeWalletEntries(current: WalletEntry[], incoming: WalletEntry[]): WalletEntry[] {
  if (incoming.length === 0) return current;
  const incomingById = new Map(incoming.map((entry) => [entry.id, entry]));
  const known = new Set(current.map((entry) => entry.id));
  const added = incoming.filter((entry) => !known.has(entry.id));
  return [...added, ...current.map((entry) => incomingById.get(entry.id) ?? entry)];
}

export function sellerDeliveredFeeForOrder(order: Order, state: AppState): number {
  return chargesForOrder(order, state).sellerDeliveredFeeCop;
}

export function entriesForClosedOrder(order: Order, state: AppState): WalletEntry[] {
  const now = new Date().toISOString();
  const entries: WalletEntry[] = [];
  const tariffs = chargesForOrder(order, state);

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
    // Espejo de buildWalletEntries en functions/src/orders.ts: cada visita perdida
    // lleva su propio id para que un reintento no sobrescriba el cobro anterior.
    const attempt = Math.max(1, (order.evidence ?? []).filter((item) => item.type === "failed" && item.failedCategory).length);
    const attemptSuffix = attempt > 1 ? `-${attempt}` : "";
    const attemptLabel = attempt > 1 ? ` (visita ${attempt})` : "";
    if (tariffs.sellerFailedFeeCop > 0) {
      entries.push({
        id: `we-${order.id}-seller-failed-fee${attemptSuffix}`,
        ownerType: "seller",
        ownerId: order.sellerId,
        orderId: order.id,
        type: "failed_fee",
        amountCop: -tariffs.sellerFailedFeeCop,
        description: `Cobro fallido ${order.shopifyOrderId}${attemptLabel}`,
        createdAt: now
      });
    }
    if (tariffs.driverFailedPayCop > 0) {
      entries.push({
        id: `we-${order.id}-driver-failed-pay${attemptSuffix}`,
        ownerType: "driver",
        ownerId: order.driverId ?? "unassigned",
        orderId: order.id,
        type: "driver_earning",
        amountCop: tariffs.driverFailedPayCop,
        description: `Pago transportista fallido ${order.shopifyOrderId}${attemptLabel}`,
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

/**
 * Movimientos con algo pendiente, SIN filtrar por fecha.
 *
 * Son dos pendientes independientes:
 *  - `!settlementId`: no liquidado con la tienda o el domiciliario.
 *  - `product_cost` sin `supplierSettlementId`: no pagado al proveedor. Puede estar ya liquidado
 *    con la tienda y seguir pendiente con el proveedor, asi que NO se deriva del primero.
 *
 * La vista de liquidaciones filtraba todo esto por un rango de fechas de 7 dias por defecto, lo
 * que escondia lo mas viejo (que es justo lo que lleva mas tiempo sin pagarse) tanto de las filas
 * como del corte. El rango solo debe afectar al resumen del periodo.
 */
/**
 * Movimientos sin liquidar con la tienda o el domiciliario. Es el subconjunto de
 * `selectOpenWalletEntries` cuyos pedidos hacen falta de verdad para armar las filas de
 * liquidacion (la auditoria por pedido lee el estado, el COD y el pago del domiciliario).
 *
 * Los pendientes SOLO con el proveedor no entran aqui: ya pasaron por un corte de tienda, asi
 * que su compuerta de COD quedo resuelta en ese momento y no hace falta releer el pedido. La
 * diferencia no es menor: son 419 pedidos en vez de 1.761.
 */
export type WalletPeriodSummary = {
  codCop: number;
  sellerFeesCop: number;
  driverPayCop: number;
  deliveryFeeCop: number;
  failedFeeCop: number;
  fulfillmentCop: number;
  deliveredPayCop: number;
  failedPayCop: number;
  deliveredOrders: number;
  failedOrders: number;
  platformMarginCop: number;
};

function periodNetCop(entries: WalletEntry[], types: WalletEntry["type"][]) {
  return entries.filter((entry) => types.includes(entry.type)).reduce((sum, entry) => sum + entry.amountCop, 0);
}

function periodChargeCop(entries: WalletEntry[], types: WalletEntry["type"][]) {
  return Math.max(0, -periodNetCop(entries, types));
}

/**
 * Resumen financiero de un periodo, calculado SOLO desde los asientos de wallet.
 *
 * Antes esto se derivaba de `buildLiquidationOrderAudits`, que recorre `state.orders`. Cuando los
 * pedidos pasaron a descargarse por ventana, el resumen empezo a mostrar solo la parte del periodo
 * cuyos pedidos seguian en memoria: con "Ver todo" el margen operativo caia de $4.217.500 a
 * $1.488.000. El dinero no necesita el pedido — cada cifra sale del tipo de asiento — y verificado
 * contra produccion las nueve cifras coinciden al peso con el calculo completo.
 *
 * El recorte por pedido (`Math.max(0, -neto)`) se hace ANTES de sumar, igual que el calculo
 * original: una nota de credito de un pedido no puede compensar el cobro de otro.
 *
 * Los conteos de entregados/fallidos usan el estado real del pedido cuando esta cargado y, si no,
 * lo deducen del asiento (un `delivery_fee` solo nace de una entrega). La diferencia medida es del
 * 0,2% y solo afecta a pedidos corregidos despues de generar sus asientos.
 */
export function summarizeWalletPeriod(entries: WalletEntry[], ordersById: Map<string, Order>): WalletPeriodSummary {
  const byOrder = new Map<string, WalletEntry[]>();
  for (const entry of entries) {
    if (!entry.orderId) continue;
    const bucket = byOrder.get(entry.orderId);
    if (bucket) bucket.push(entry);
    else byOrder.set(entry.orderId, [entry]);
  }

  const summary: WalletPeriodSummary = {
    codCop: 0,
    sellerFeesCop: 0,
    driverPayCop: 0,
    deliveryFeeCop: 0,
    failedFeeCop: 0,
    fulfillmentCop: 0,
    deliveredPayCop: 0,
    failedPayCop: 0,
    deliveredOrders: 0,
    failedOrders: 0,
    platformMarginCop: 0
  };

  for (const [orderId, orderEntries] of byOrder) {
    const sellerEntries = orderEntries.filter((entry) => entry.ownerType === "seller");
    const driverEntries = orderEntries.filter((entry) => entry.ownerType === "driver");
    const deliveryFeeCop = periodChargeCop(sellerEntries, ["delivery_fee"]);
    const failedFeeCop = periodChargeCop(sellerEntries, ["failed_fee"]);
    const fulfillmentCop = periodChargeCop(sellerEntries, ["fulfillment_fee"]);

    summary.codCop += periodNetCop(sellerEntries, ["cod_revenue", "cod_remittance"]);
    summary.deliveryFeeCop += deliveryFeeCop;
    summary.failedFeeCop += failedFeeCop;
    summary.fulfillmentCop += fulfillmentCop;
    summary.sellerFeesCop += deliveryFeeCop + failedFeeCop + fulfillmentCop;
    summary.driverPayCop += periodNetCop(driverEntries, ["driver_earning"]);
    summary.deliveredPayCop += driverEntries
      .filter((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("entregado"))
      .reduce((sum, entry) => sum + entry.amountCop, 0);
    summary.failedPayCop += driverEntries
      .filter((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("fallido"))
      .reduce((sum, entry) => sum + entry.amountCop, 0);

    const order = ordersById.get(orderId);
    if (order) {
      if (order.status === "delivered") summary.deliveredOrders++;
      else if (order.status === "failed") summary.failedOrders++;
    } else if (deliveryFeeCop > 0) {
      summary.deliveredOrders++;
    } else if (failedFeeCop > 0 || driverEntries.some((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("fallido"))) {
      summary.failedOrders++;
    }
  }

  summary.platformMarginCop = summary.sellerFeesCop - summary.driverPayCop;
  return summary;
}

export function selectUnsettledWalletEntries(wallet: WalletEntry[]): WalletEntry[] {
  return wallet.filter((entry) => !entry.settlementId);
}

export function selectOpenWalletEntries(wallet: WalletEntry[]): WalletEntry[] {
  return wallet.filter((entry) => !entry.settlementId || (entry.type === "product_cost" && !entry.supplierSettlementId));
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
// COD que el domiciliario debe entregar por un pedido: solo aplica a entregados/
// liquidados. Un pedido fallido (aunque sea cobrable) no recauda efectivo, asi que
// da 0. Se calcula con el estado del pedido porque el domiciliario no ve los
// asientos del vendedor (cod_revenue es ownerType "seller", fuera de su scope).
function orderCollectedCodCop(order: Order | undefined) {
  if (!order || order.paymentMethod !== "cod") return 0;
  if (order.status !== "delivered" && order.status !== "liquidated") return 0;
  return Math.max(0, Number(order.totalCop) || 0);
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

/**
 * Abonos de efectivo de UN corte, con el saldo que quedaba pendiente despues de cada uno.
 *
 * `pendingAfterCop` es un saldo corriente (esperado menos lo acumulado hasta ese abono), no el
 * pendiente final del corte: con varios abonos, repetir la cifra final en cada fila no dice nada.
 *
 * Un corte antiguo puede tener `cashReceivedCop` sin el detalle de recibos (se registraba solo el
 * total). En ese caso se devuelve una unica fila sintetica, marcada como tal, en vez de fingir que
 * no hubo recaudo.
 */
export function driverCashReceiptRows(
  settlement: Settlement,
  expectedCashCop: number,
  fallbackReceivedCop: number
): DriverCashReceiptRow[] {
  const label = settlementLabel(settlement);
  const receipts = settlement.cashReceipts ?? [];

  if (receipts.length === 0) {
    if (fallbackReceivedCop <= 0) return [];
    return [{
      id: `${settlement.id}-legacy-received`,
      settlementId: settlement.id,
      settlementLabel: label,
      amountCop: fallbackReceivedCop,
      receivedAt: settlement.paidAt ?? settlement.reconciledAt ?? settlement.createdAt,
      pendingAfterCop: Math.max(0, expectedCashCop - fallbackReceivedCop),
      note: "Registro historico sin recibos detallados.",
      synthetic: true
    }];
  }

  let accumulatedCop = 0;
  return receipts.map((receipt) => {
    const amountCop = Math.max(0, Number(receipt.amountCop) || 0);
    accumulatedCop += amountCop;
    return {
      id: receipt.id ?? `${settlement.id}-${receiptDate(receipt, settlement.createdAt)}-${receipt.amountCop}`,
      settlementId: settlement.id,
      settlementLabel: label,
      amountCop,
      receivedAt: receiptDate(receipt, settlement.createdAt),
      pendingAfterCop: Math.max(0, expectedCashCop - accumulatedCop),
      note: receipt.note
    };
  });
}

/** Un abono a tienda, listo para pintar: monto en positivo y la nota sin el prefijo. */
export type SellerAbonoRow = {
  id: string;
  createdAt: string;
  amountCop: number;
  note: string;
};

/**
 * Los abonos de una tienda, uno por uno. Antes el admin solo veia el total en la fila
 * "Abonos ya pagados": una tienda recibe varios abonos en la misma semana y la nota de cada uno
 * (que dice por donde salio la plata) solo vive en la descripcion de su asiento.
 *
 * `recordSellerAbono` guarda la descripcion como `Abono a tienda <nombre>: <nota>`, asi que la nota
 * se recorta por la posicion del primer `": "`. Sin regex a proposito: el nombre de la tienda es
 * texto libre y puede traer `:` o caracteres que romperian el patron.
 */
export function sellerAbonoRows(entries: WalletEntry[]): SellerAbonoRow[] {
  return entries
    .filter((entry) => entry.type === "seller_abono")
    // ISO 8601 ordena bien comparando cadenas; localeCompare (Intl) es un orden de magnitud mas lento.
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))
    .map((entry) => {
      const separator = entry.description.indexOf(": ");
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        // Los asientos de abono se guardan en negativo (plata que sale hacia la tienda).
        amountCop: Math.abs(Math.round(Number(entry.amountCop) || 0)),
        note: separator === -1 ? "" : entry.description.slice(separator + 2).trim()
      };
    });
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
      const codCop = orderCollectedCodCop(order);
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

    receiptRows.push(...driverCashReceiptRows(settlement, expectedCashCop, receivedCop));
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

export type PlatformPosition = {
  cashCop: number;
  receivedFromDriverCop: number;
  paidToSellersCop: number;
  driverReceivableCop: number;
  driverPendingInSettlementsCop: number;
  driverCodOutsideSettlementsCop: number;
  payableToSellersCop: number;
  withheldForSuppliersCop: number;
  withheldBySupplier: Array<{ supplierId: string; supplierName: string; amountCop: number }>;
  feesCop: number;
  driverPayCop: number;
  profitCop: number;
  assetsCop: number;
  liabilitiesCop: number;
  netCop: number;
};

const SELLER_FEE_TYPES: WalletEntry["type"][] = ["delivery_fee", "failed_fee", "fulfillment_fee"];

/**
 * Posicion real de la plataforma. Existe porque la tabla de liquidaciones mostraba el
 * cobro bruto en la columna de margen y hacia parecer que quedaba mucho mas dinero del
 * que hay: la utilidad es cobros a tiendas MENOS pago a domiciliarios (~$2.000 por
 * pedido), y el costo de producto retenido no es utilidad sino plata de proveedores.
 *
 * El domiciliario descuenta su pago del efectivo antes de entregarlo, asi que
 * (COD - pago) es lo que debe entrar a caja, y (COD - cobros - costo) lo que sale a la
 * tienda; la diferencia entre ambos es justamente la utilidad.
 */
export function calculatePlatformPosition(state: AppState): PlatformPosition {
  const settlementById = new Map(state.settlements.map((settlement) => [settlement.id, settlement]));
  const isPaid = (settlementId?: string) => {
    const status = settlementId ? settlementById.get(settlementId)?.status : undefined;
    return status === "paid" || status === "reconciled";
  };
  const sum = (entries: WalletEntry[]) => entries.reduce((total, entry) => total + Math.round(entry.amountCop), 0);

  const sellerEntries = state.wallet.filter((entry) => entry.ownerType === "seller");
  const driverEarnings = state.wallet.filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning");

  // Caja: entra el efectivo del domiciliario, sale el neto de cada corte pagado y los
  // abonos (que se entregan por fuera del corte y luego se netean dentro de el).
  const receivedFromDriverCop = state.settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + Math.round(Number(settlement.cashReceivedCop) || 0), 0);
  const settlementPayoutsCop = sum(sellerEntries.filter((entry) => isPaid(entry.settlementId)));
  const abonosPaidCop = -sum(sellerEntries.filter((entry) => entry.type === "seller_abono"));
  const paidToSellersCop = settlementPayoutsCop + abonosPaidCop;
  const cashCop = receivedFromDriverCop - paidToSellersCop;

  // Por cobrar al domiciliario: lo pendiente en cortes MAS el COD de pedidos entregados
  // que todavia no entraron a ningun corte (esto ultimo no se ve en ninguna pantalla).
  const driverPendingInSettlementsCop = state.settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + Math.round(Number(settlement.cashPendingCop) || 0), 0);
  const orderIdsInDriverSettlements = new Set(
    state.settlements.filter((settlement) => settlement.kind === "driver").flatMap((settlement) => settlement.orderIds ?? [])
  );
  const outsideCod = sum(sellerEntries.filter((entry) =>
    (entry.type === "cod_revenue" || entry.type === "cod_remittance") && entry.orderId && !orderIdsInDriverSettlements.has(entry.orderId)
  ));
  const outsidePay = sum(driverEarnings.filter((entry) => entry.orderId && !orderIdsInDriverSettlements.has(entry.orderId)));
  const driverCodOutsideSettlementsCop = Math.max(0, outsideCod - outsidePay);
  const driverReceivableCop = driverPendingInSettlementsCop + driverCodOutsideSettlementsCop;

  const payableToSellersCop = sum(sellerEntries.filter((entry) => !entry.settlementId));

  // Costo de producto retenido: descontado a la tienda y aun no liquidado al proveedor.
  const withheldEntries = sellerEntries.filter((entry) => entry.type === "product_cost" && !entry.supplierSettlementId);
  const withheldForSuppliersCop = -sum(withheldEntries);
  const bySupplier = new Map<string, { supplierId: string; supplierName: string; amountCop: number }>();
  for (const entry of withheldEntries) {
    const supplierId = entry.supplierId ?? "(sin proveedor)";
    const current = bySupplier.get(supplierId) ?? { supplierId, supplierName: entry.supplierName ?? supplierId, amountCop: 0 };
    current.amountCop += -Math.round(entry.amountCop);
    if (entry.supplierName) current.supplierName = entry.supplierName;
    bySupplier.set(supplierId, current);
  }

  const feesCop = -sum(sellerEntries.filter((entry) => SELLER_FEE_TYPES.includes(entry.type)));
  const driverPayCop = sum(driverEarnings);
  const profitCop = feesCop - driverPayCop;

  const assetsCop = cashCop + driverReceivableCop;
  const liabilitiesCop = payableToSellersCop + withheldForSuppliersCop;

  return {
    cashCop,
    receivedFromDriverCop,
    paidToSellersCop,
    driverReceivableCop,
    driverPendingInSettlementsCop,
    driverCodOutsideSettlementsCop,
    payableToSellersCop,
    withheldForSuppliersCop,
    withheldBySupplier: [...bySupplier.values()].filter((row) => row.amountCop !== 0).sort((left, right) => right.amountCop - left.amountCop),
    feesCop,
    driverPayCop,
    profitCop,
    assetsCop,
    liabilitiesCop,
    netCop: assetsCop - liabilitiesCop
  };
}

export function weeklyFailedRate(state: AppState, driverId: string) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const closed = state.orders.filter((order) => {
    const closedStatus = order.status === "delivered" || order.status === "failed";
    return order.driverId === driverId && closedStatus && new Date(order.updatedAt).getTime() >= weekAgo;
  });
  const excluded = closed.filter((order) => order.status === "failed" && (order.failedCategory === "no_coverage" || order.failedCategory === "bad_order_or_no_contact" || order.failedCategory === "bad_phone")).length;
  const total = Math.max(0, closed.length - excluded);
  const failed = closed.filter(isChargeableFailedOrder).length;
  return { total, failed, rate: total === 0 ? 0 : Math.round((failed / total) * 100) };
}

/**
 * Gravamen a los movimientos financieros ("4x1000"): 4 pesos por cada 1.000 transferidos,
 * es decir el 0,4% de lo que sale del banco.
 *
 * Solo grava DINERO QUE SALE POR TRANSFERENCIA:
 *  - Una cuenta marcada `paysInCash` no genera gravamen: no hay movimiento bancario que gravar.
 *  - Un neto de cero o negativo tampoco. En domiciliarios el neto puede ser negativo (es el
 *    mensajero quien debe entregar efectivo): ahi no sale plata del banco, luego no hay 4x1000.
 *
 * Se redondea al peso, que es la unidad en la que se transfiere de verdad.
 */
export const GMF_RATE = 0.004;

export function gmfForPayout(payableCop: number, paysInCash = false): number {
  if (paysInCash) return 0;
  if (!Number.isFinite(payableCop) || payableCop <= 0) return 0;
  return Math.round(payableCop * GMF_RATE);
}

/** Lo que de verdad recibe la cuenta despues del gravamen. */
export function netAfterGmf(payableCop: number, paysInCash = false): number {
  return payableCop - gmfForPayout(payableCop, paysInCash);
}
