import type { AppState, ProductCatalogItem, WalletEntry } from "./types";
import { findCatalogMatch, normalizeProductName, productCostLinesForOrder } from "./finance";

export type UnassociatedProductRow = {
  key: string;
  sellerId: string;
  sellerName: string;
  productName: string;
  normalizedProductName: string;
  sku?: string;
  orderCount: number;
  quantity: number;
  lastOrderAt: string;
  // Rotulos combinados de los pedidos multi-item donde aparece este SKU (max 3, para mostrar origen).
  sources: string[];
};

// Una fila por SKU/nombre individual de linea (no por pedido): el catalogo y el cobro de
// closeOrder trabajan por lineItem, asi que asociar el sku combinado "A + B" nunca matchea.
export function buildUnassociatedProductRows(state: AppState): UnassociatedProductRow[] {
  const sellersById = new Map(state.sellers.map((seller) => [seller.id, seller]));
  const rows = new Map<string, UnassociatedProductRow>();
  const countedOrders = new Map<string, Set<string>>();
  for (const order of state.orders) {
    const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
    const lines = hasLineItems
      ? order.lineItems!
      : [{ sku: order.sku, productName: order.productName, quantity: order.quantity }];
    for (const line of lines) {
      const productName = line.productName?.trim();
      const sku = line.sku?.trim().toUpperCase();
      const normalizedName = normalizeProductName(productName);
      if (!productName && !sku) continue;
      if (findCatalogMatch(state, order.sellerId, { sku: line.sku, productName: line.productName, productId: hasLineItems ? undefined : order.productId })) continue;
      const key = `${order.sellerId}::${sku ? `sku:${sku}` : `name:${normalizedName}`}`;
      const quantity = Math.max(1, Number(line.quantity) || 1);
      const combinedLabel = hasLineItems && order.lineItems!.length > 1 ? order.productName?.trim() || order.sku?.trim() : undefined;
      const counted = countedOrders.get(key) ?? new Set<string>();
      countedOrders.set(key, counted);
      const existing = rows.get(key);
      if (existing) {
        if (!counted.has(order.id)) {
          existing.orderCount += 1;
          counted.add(order.id);
        }
        existing.quantity += quantity;
        if (order.createdAt > existing.lastOrderAt) {
          existing.lastOrderAt = order.createdAt;
          existing.productName = productName || existing.productName;
        }
        if (combinedLabel && !existing.sources.includes(combinedLabel) && existing.sources.length < 3) {
          existing.sources.push(combinedLabel);
        }
        continue;
      }
      counted.add(order.id);
      rows.set(key, {
        key,
        sellerId: order.sellerId,
        sellerName: sellersById.get(order.sellerId)?.name ?? order.sellerId,
        productName: productName || sku || "Producto sin nombre",
        normalizedProductName: normalizedName,
        sku,
        orderCount: 1,
        quantity,
        lastOrderAt: order.createdAt,
        sources: combinedLabel ? [combinedLabel] : []
      });
    }
  }
  return Array.from(rows.values()).sort((left, right) => right.orderCount - left.orderCount || left.sellerName.localeCompare(right.sellerName) || left.productName.localeCompare(right.productName));
}

export function buildMissingProductCostEntries(state: AppState, product: ProductCatalogItem): WalletEntry[] {
  if (!product.productCostConfigured) return [];
  // saveProduct llama antes del setState: incluir el producto nuevo/editado en la vista del catalogo.
  const stateWithProduct: AppState = {
    ...state,
    productCatalog: [product, ...(state.productCatalog ?? []).filter((item) => item.id !== product.id)]
  };
  const supplier = state.suppliers.find((item) => item.id === product.supplierId);
  const now = new Date().toISOString();
  const entries: WalletEntry[] = [];
  for (const order of state.orders) {
    if (order.status !== "delivered" || order.sellerId !== product.sellerId) continue;
    // Pedidos ya incluidos en una liquidacion de tienda no se retro-cobran.
    const orderEntryIds = new Set(state.wallet.filter((entry) => entry.orderId === order.id).map((entry) => entry.id));
    if (state.settlements.some((settlement) => settlement.kind === "seller" && settlement.walletEntryIds.some((entryId) => orderEntryIds.has(entryId)))) continue;
    // Dedupe por producto. La rama !entry.productId cubre entradas legacy (we-{orderId}-product-cost
    // sin productId): se prefiere no doble-cobrar aunque deje sin backfill otro producto del pedido.
    if (state.wallet.some((entry) => entry.orderId === order.id && entry.type === "product_cost" && (entry.productId === product.id || !entry.productId))) continue;
    const line = productCostLinesForOrder(order, stateWithProduct).find((item) => item.productId === product.id);
    if (!line) continue;
    const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
    entries.push({
      id: hasLineItems ? `we-${order.id}-product-cost-${product.id}` : `we-${order.id}-product-cost`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "product_cost",
      amountCop: -line.totalCostCop,
      description: `Costo producto ${order.shopifyOrderId}`,
      supplierId: product.supplierId,
      supplierName: supplier?.name,
      productId: product.id,
      productName: product.name,
      createdAt: now
    });
  }
  return entries;
}
