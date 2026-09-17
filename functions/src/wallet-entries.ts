/**
 * Asientos de wallet y tarifas de un pedido. SIN acceso a Firestore.
 *
 * `buildWalletEntries` es la unica fuente de verdad sobre cuanta plata genera un pedido.
 * Vive aparte de orders.ts para que la correccion administrativa (order-corrections-plan.ts)
 * la reuse en vez de copiarla: los scripts one-off que esta reemplaza llevaban cada uno su
 * propia replica de esta funcion, de `resolveTariffs` y del costo de producto, y la copia
 * rancia es exactamente el riesgo del que advierte la regla de oro #3 de CLAUDE.md.
 *
 * Ids DETERMINISTAS a proposito: `we-{orderId}-cod`, `we-{orderId}-seller-delivery-fee`, etc.
 * Eso hace que cerrar dos veces el mismo pedido sea idempotente, y permite al planificador de
 * correcciones comparar por id lo que un pedido TIENE contra lo que DEBERIA tener.
 */
import { communityChargeAtClose, type CashbackBreakdown, type FrozenPricing } from "./community-pricing";
import { defaultSettings, resolveSellerCharges } from "./seller-charges";
import type { WalletEntryDoc } from "./settlement-math";

// Las tarifas y la regla de cobro a la tienda viven en seller-charges.ts (la unica copia). Se
// reexportan aqui, el mismo objeto y no una copia, para no romper a los importadores de siempre.
export { defaultSettings, dandaDeliveredFeeCop, resolveTariffs, tariffFields } from "./seller-charges";

// Entregado consume stock; fallido definitivo solo libera la reserva; reagendado no toca nada
// (la reserva sigue viva porque el pedido sigue abierto). Solo actua si el pedido reservo.

function normalizeProductName(value?: string) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type ProductCostLine = {
  productId: string;
  productName: string;
  supplierId?: string;
  supplierName?: string;
  totalCostCop: number;
};

function matchCatalogForLine(
  catalog: Record<string, any>[],
  sellerId: string,
  options: { sku?: string; productName?: string; productId?: string }
): Record<string, any> | null {
  const normalizedSku = typeof options.sku === "string" ? options.sku.trim().toUpperCase() : "";
  const normalizedName = normalizeProductName(typeof options.productName === "string" ? options.productName : "");
  const byId = options.productId
    ? catalog.find((item) => item.id === options.productId && item.sellerId === sellerId && item.active !== false)
    : undefined;
  const bySku = normalizedSku
    ? catalog.find((item) => item.sellerId === sellerId && item.active !== false && typeof item.sku === "string" && item.sku.trim().toUpperCase() === normalizedSku)
    : undefined;
  const byName = normalizedName
    ? catalog.find((item) => item.sellerId === sellerId && item.active !== false && !item.sku && item.normalizedProductName === normalizedName)
    : undefined;
  return byId ?? bySku ?? byName ?? null;
}

// Costo por linea/SKU: una entrada por producto del catalogo (costo unitario x cantidad).
// Si el pedido trae lineItems se calcula por linea (combos + productos adicionales); si no,
// usa los campos colapsados. El costo del catalogo se interpreta SIEMPRE como por unidad.
export function resolveProductCostLinesForOrder(order: Record<string, any>, catalog: Record<string, any>[]): ProductCostLine[] {
  const sellerId = String(order.sellerId ?? "");
  if (!sellerId) return [];
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const hasLineItems = lineItems.length > 0;
  const rawLines = hasLineItems
    ? lineItems
    : [{ sku: order.sku, productName: order.productName, quantity: order.quantity }];
  const byProduct = new Map<string, { product: Record<string, any>; quantity: number }>();
  for (const line of rawLines) {
    const quantity = Math.max(1, Number(line?.quantity) || 1);
    const product = matchCatalogForLine(catalog, sellerId, {
      sku: typeof line?.sku === "string" ? line.sku : undefined,
      productName: typeof line?.productName === "string" ? line.productName : undefined,
      productId: hasLineItems ? undefined : (typeof order.productId === "string" ? order.productId : undefined)
    });
    if (!product || product.productCostConfigured !== true) continue;
    const existing = byProduct.get(product.id);
    if (existing) existing.quantity += quantity;
    else byProduct.set(product.id, { product, quantity });
  }
  return Array.from(byProduct.values()).map(({ product, quantity }) => {
    const unitCostCop = Math.max(0, Number(product.productCostCop) || 0);
    return {
      productId: String(product.id ?? ""),
      productName: String(product.name ?? "Producto"),
      supplierId: typeof product.supplierId === "string" ? product.supplierId : undefined,
      supplierName: typeof product.supplierName === "string" ? product.supplierName : undefined,
      totalCostCop: unitCostCop * quantity
    };
  });
}

export function buildWalletEntries(order: Record<string, any>, settings: Record<string, any>, now: string, productCostLines?: ProductCostLine[] | null): WalletEntryDoc[] {
  // `settings` ya llega resuelto (resolveTariffs), pero se rellena con los valores por defecto
  // igual que siempre: si un llamador pasa un objeto incompleto, el importe no cambia.
  // DANDA y el fallido fijo (SELLER_FAILED_FEE_FIXED_COP) se deciden en seller-charges.ts.
  const values = resolveSellerCharges(order, { ...defaultSettings, ...settings }, now);

  /**
   * Pedido de comunidad (RF_11, RF_04, RF_06). Al crear solo se congela el precio PROPIO del
   * lider; la base se decide AQUI, al cerrar, y es `values`: la misma que pagaria una tienda sin
   * comunidad con esta zona, esta fecha y estos ajustes. Se cobra la mayor entre esa base y el
   * precio del lider, y el cashback es la diferencia. Congelar tambien la base cobraba de menos
   * cuando la zona se editaba despues de crear, y convertia una bajada de la base en cashback de
   * un lider que no habia fijado nada.
   *
   * Va despues de `resolveSellerCharges` a proposito: el fijo SELLER_FAILED_FEE_FIXED_COP y el
   * flete de DANDA entran en la base y hacen de piso. Si este bloque fuera antes, el flete de
   * fallido de una comunidad se anularia en silencio — lo que ya paso en ago-2026 con la
   * pantalla de ajustes.
   */
  const frozen = (order.communityPricing ?? undefined) as FrozenPricing | undefined;
  let cashback: CashbackBreakdown = { deliveredCop: 0, failedCop: 0, fulfillmentCop: 0, totalCop: 0 };
  if (frozen) {
    const atClose = communityChargeAtClose(frozen, {
      sellerDeliveredFeeCop: values.sellerDeliveredFeeCop,
      sellerFailedFeeCop: values.sellerFailedFeeCop,
      fulfillmentFeeCop: values.fulfillmentFeeCop
    });
    values.sellerDeliveredFeeCop = atClose.charged.sellerDeliveredFeeCop;
    values.sellerFailedFeeCop = atClose.charged.sellerFailedFeeCop;
    values.fulfillmentFeeCop = atClose.charged.fulfillmentFeeCop;
    cashback = atClose.cashback;
  }

  const entries: WalletEntryDoc[] = [];

  /**
   * Un cashback de cero NO emite asiento: un corte lleno de lineas en cero es ruido. Como
   * consecuencia, los asientos no sirven para CONTAR pedidos de una comunidad (un lider sin
   * margen no generaria ninguno); los contadores salen de `orders`. Sumar si es correcto.
   */
  const pushCashback = (concept: "delivered" | "failed" | "fulfillment", amountCop: number, label: string) => {
    if (!frozen || amountCop <= 0) return;
    entries.push({
      id: `we-${order.id}-community-cashback-${concept}`,
      ownerType: "community_leader",
      ownerId: frozen.communityId,
      orderId: order.id,
      type: "community_cashback",
      amountCop,
      description: `Cashback comunidad ${label} ${order.shopifyOrderId}`,
      createdAt: now
    });
  };

  if (order.status === "delivered" && order.paymentMethod === "cod") {
    entries.push({
      id: `we-${order.id}-cod`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "cod_revenue",
      amountCop: Number(order.totalCop) || 0,
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
      amountCop: -Number(values.sellerDeliveredFeeCop),
      description: `Flete entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
    entries.push({
      id: `we-${order.id}-driver-delivery-pay`,
      ownerType: "driver",
      ownerId: order.driverId ?? "unassigned",
      orderId: order.id,
      type: "driver_earning",
      amountCop: Number(values.driverDeliveredPayCop),
      description: `Pago transportista entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
    pushCashback("delivered", cashback.deliveredCop, "entregado");
    const costLines = productCostLines ?? [];
    const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
    for (const line of costLines) {
      entries.push(stripUndefined({
        id: hasLineItems ? `we-${order.id}-product-cost-${line.productId}` : `we-${order.id}-product-cost`,
        ownerType: "seller",
        ownerId: order.sellerId,
        orderId: order.id,
        type: "product_cost",
        amountCop: -line.totalCostCop,
        description: `Costo producto ${order.shopifyOrderId}`,
        supplierId: line.supplierId,
        supplierName: line.supplierName,
        productId: line.productId || undefined,
        productName: line.productName,
        createdAt: now
      }) as WalletEntryDoc);
    }
  }

  const isChargeableFailedVisit = order.status === "failed" && String(order.failedCategory ?? "failed_visit") === "failed_visit";
  if (isChargeableFailedVisit) {
    // Un pedido puede reabrirse a retry_pending y volver a visitarse. Cada visita
    // perdida debe generar su propio cobro, asi que el id lleva el numero de intento;
    // el primero conserva el id historico para no alterar los asientos ya existentes.
    // Se cuentan solo las evidencias de fallido cobrado (las de "Cliente reagenda
    // visita" no traen failedCategory y no generan asientos).
    const attempt = Math.max(
      1,
      (Array.isArray(order.evidence) ? order.evidence : []).filter(
        (item: Record<string, any>) => item?.type === "failed" && item?.failedCategory
      ).length
    );
    const attemptSuffix = attempt > 1 ? `-${attempt}` : "";
    const attemptLabel = attempt > 1 ? ` (visita ${attempt})` : "";
    if (Number(values.sellerFailedFeeCop) > 0) {
      entries.push({
        id: `we-${order.id}-seller-failed-fee${attemptSuffix}`,
        ownerType: "seller",
        ownerId: order.sellerId,
        orderId: order.id,
        type: "failed_fee",
        amountCop: -Number(values.sellerFailedFeeCop),
        description: `Cobro fallido ${order.shopifyOrderId}${attemptLabel}`,
        createdAt: now
      });
      pushCashback("failed", cashback.failedCop, "fallido");
    }
    if (Number(values.driverFailedPayCop) > 0) {
      entries.push({
        id: `we-${order.id}-driver-failed-pay${attemptSuffix}`,
        ownerType: "driver",
        ownerId: order.driverId ?? "unassigned",
        orderId: order.id,
        type: "driver_earning",
        amountCop: Number(values.driverFailedPayCop),
        description: `Pago transportista fallido ${order.shopifyOrderId}${attemptLabel}`,
        createdAt: now
      });
    }
  }

  if (order.fulfillmentMode === "warehouse" && (order.status === "delivered" || isChargeableFailedVisit)) {
    entries.push({
      id: `we-${order.id}-fulfillment-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "fulfillment_fee",
      amountCop: -Number(values.fulfillmentFeeCop),
      description: `Fulfillment desde bodega ${order.shopifyOrderId}`,
      createdAt: now
    });
    pushCashback("fulfillment", cashback.fulfillmentCop, "manejo");
  }

  return entries.map(withOpenSettlementFlags);
}

/** Deja `settlementId` (y `supplierSettlementId` en los costos de producto) presente y vacio
 *  cuando el asiento nace sin liquidar. Firestore no sabe filtrar por campo AUSENTE, asi que sin
 *  esto "lo pendiente por liquidar" no se puede consultar y hay que bajar la coleccion entera al
 *  navegador para filtrarla ahi. La semantica no cambia: `!entry.settlementId` es igual para
 *  undefined que para "". Ver scripts/backfill-wallet-settlement-flag.js para el historico. */
export function withOpenSettlementFlags<T extends { type?: string; settlementId?: string; supplierSettlementId?: string }>(entry: T): T {
  const normalized: T = { ...entry, settlementId: entry.settlementId ?? "" };
  if (normalized.type === "product_cost") {
    normalized.supplierSettlementId = normalized.supplierSettlementId ?? "";
  }
  return normalized;
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function isLiquidationWalletType(type: string) {
  // cod_remittance: reversas de COD por correcciones; sin el, esos asientos quedan huerfanos como saldo pendiente eterno
  // seller_abono: pagos parciales adelantados a la tienda; deben barrerse a la liquidacion final para no quedar como saldo eterno
  // gmf_tax: el 4x1000 de un abono nace suelto y tiene que arrastrarse al siguiente corte;
  // si no, queda como saldo abierto para siempre. El que nace DENTRO de un corte ya viene con
  // settlementId, asi que no lo recoge nadie dos veces.
  // community_cashback: el margen del lider de comunidad. Sin el en esta lista, su cashback
  // nunca entraria en un corte y quedaria como saldo abierto para siempre.
  return ["cod_revenue", "cod_remittance", "delivery_fee", "failed_fee", "fulfillment_fee", "product_cost", "driver_earning", "seller_abono", "gmf_tax", "community_cashback"].includes(type);
}
