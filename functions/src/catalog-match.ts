/**
 * La unica regla que decide a que producto del catalogo corresponde una linea de un pedido.
 * SIN acceso a Firestore.
 *
 * Vivia dentro de `wallet-entries.ts`, que la usa para el costo de producto. Se movio aqui, tal
 * cual, para que la impresion de rotulos por proveedor (spec 040) use EXACTAMENTE la misma regla
 * que cobra, sin arrastrar al navegador las tarifas, las comunidades y los asientos. Si esta
 * regla cambia, cambian a la vez el cobro y la bodega a la que va cada linea: es a proposito.
 *
 * Orden: el `productId` (solo lo pasa quien no tiene `lineItems`), luego el SKU en mayusculas,
 * luego el nombre normalizado de un producto SIN SKU. Siempre de la misma tienda y activo.
 */

export function normalizeProductName(value?: string) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function matchCatalogForLine(
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
