/**
 * Spec 040: cada bodega imprime lo suyo. SIN acceso a Firestore ni al navegador.
 *
 * Parte un pedido en paquetes, uno por proveedor, y una tanda de pedidos en grupos por proveedor.
 * Solo decide que se IMPRIME: no toca dinero, estado ni nada que se guarde (spec 040, RNF_02).
 *
 * La linea -> producto sale de `matchCatalogForLine`, la misma funcion que genera el `product_cost`
 * (RF_01). La unica diferencia con el cobro es deliberada: aqui NO se exige `productCostConfigured`,
 * porque un producto sin costo configurado sigue teniendo bodega. `supplier-packages.test.ts` deja
 * esa diferencia escrita y ata el resto al cobro.
 */
import { matchCatalogForLine } from "./catalog-match";

/** Clave del grupo de lineas sin proveedor (sin producto en el catalogo, o producto sin proveedor). */
export const NO_SUPPLIER = "__no_supplier__";

export type CatalogItemLike = {
  id: string;
  sellerId: string;
  supplierId?: string;
  sku?: string;
  name?: string;
  normalizedProductName?: string;
  active?: boolean;
};

export type SupplierLike = { id: string; name: string };

export type OrderLike = {
  id: string;
  sellerId: string;
  productId?: string;
  productName?: string;
  sku?: string;
  quantity?: number;
  lineItems?: Array<{ sku?: string; productName?: string; quantity: number }>;
};

export type PackageLine = { label: string; sku?: string; quantity: number };

export type OrderPackage = {
  orderId: string;
  /** `supplierId` del catalogo, o `NO_SUPPLIER`. */
  supplierKey: string;
  /** Indefinido si quien imprime no puede leer `suppliers` (la tienda) o es `NO_SUPPLIER`. */
  supplierName?: string;
  /** 1..total */
  index: number;
  total: number;
  lines: PackageLine[];
  /** Solo el paquete 1 lleva el cobro (spec 040, D3). */
  collectsPayment: boolean;
};

type RawLine = { sku?: string; productName?: string; quantity: number };

function orderLines(order: OrderLike): { lines: RawLine[]; hasLineItems: boolean } {
  const hasLineItems = Array.isArray(order.lineItems) && order.lineItems.length > 0;
  if (hasLineItems) return { lines: order.lineItems!, hasLineItems };
  return { lines: [{ sku: order.sku, productName: order.productName, quantity: order.quantity ?? 1 }], hasLineItems };
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Orden de los PAQUETES de un pedido: por id de proveedor, `NO_SUPPLIER` al final. Nunca por nombre:
 * la tienda no puede leer `suppliers`, y si el orden dependiera del nombre, el "Paquete 1" (el que
 * cobra) del admin y el de la tienda podrian ser bodegas distintas.
 */
function comparePackageKeys(a: string, b: string) {
  if (a === b) return 0;
  if (a === NO_SUPPLIER) return 1;
  if (b === NO_SUPPLIER) return -1;
  return a < b ? -1 : 1;
}

/** Orden de los GRUPOS de una tanda (solo admin): por nombre de proveedor; `NO_SUPPLIER` al final. */
function compareSupplierKeys(a: string, b: string, names: Map<string, string>) {
  if (a === b) return 0;
  if (a === NO_SUPPLIER) return 1;
  if (b === NO_SUPPLIER) return -1;
  const byName = (names.get(a) ?? a).localeCompare(names.get(b) ?? b, "es");
  return byName !== 0 ? byName : a.localeCompare(b);
}

export function splitOrderIntoPackages(
  order: OrderLike,
  catalog: CatalogItemLike[],
  suppliers: SupplierLike[]
): OrderPackage[] {
  const { lines, hasLineItems } = orderLines(order);
  const names = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  // supplierKey -> (clave de linea -> linea). Las lineas del mismo producto se suman, como el cobro.
  const groups = new Map<string, Map<string, PackageLine>>();
  lines.forEach((line, position) => {
    const quantity = Math.max(1, Number(line?.quantity) || 1);
    const product = matchCatalogForLine(catalog as Record<string, any>[], order.sellerId, {
      sku: typeof line?.sku === "string" ? line.sku : undefined,
      productName: typeof line?.productName === "string" ? line.productName : undefined,
      productId: hasLineItems ? undefined : order.productId
    });
    const supplierKey = cleanText(product?.supplierId) ?? NO_SUPPLIER;
    const lineKey = product ? `p:${String(product.id)}` : `l:${position}`;
    const label = cleanText(line?.productName) ?? cleanText(product?.name) ?? "Producto";
    const sku = cleanText(line?.sku) ?? cleanText(product?.sku);
    const group = groups.get(supplierKey) ?? new Map<string, PackageLine>();
    const existing = group.get(lineKey);
    if (existing) {
      existing.quantity += quantity;
      // Dos lineas del mismo producto con nombres distintos ("variedad 1", "variedad 2"): el nombre de
      // una sola mentiria sobre la suma; se usa el del catalogo, que es el producto que se empaca.
      if (existing.label !== label) existing.label = cleanText(product?.name) ?? existing.label;
    } else group.set(lineKey, sku ? { label, sku, quantity } : { label, quantity });
    groups.set(supplierKey, group);
  });
  const keys = Array.from(groups.keys()).sort(comparePackageKeys);
  return keys.map((supplierKey, position) => {
    const supplierName = supplierKey === NO_SUPPLIER ? undefined : names.get(supplierKey);
    const pkg: OrderPackage = {
      orderId: order.id,
      supplierKey,
      index: position + 1,
      total: keys.length,
      lines: Array.from(groups.get(supplierKey)!.values()),
      collectsPayment: position === 0
    };
    if (supplierName) pkg.supplierName = supplierName;
    return pkg;
  });
}

export function packageUnits(pkg: OrderPackage) {
  return pkg.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export type BatchGroup = {
  supplierKey: string;
  supplierName?: string;
  packages: OrderPackage[];
  unitsByProduct: Array<{ label: string; quantity: number }>;
  /** Pedidos de este grupo que tienen otro paquete en un grupo que NO sale en esta impresion. */
  ordersWithPackagesElsewhere: string[];
};

export function groupBatchBySupplier(
  orders: OrderLike[],
  catalog: CatalogItemLike[],
  suppliers: SupplierLike[],
  options: { onlySupplierKey?: string } = {}
): BatchGroup[] {
  const names = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  const packagesByGroup = new Map<string, OrderPackage[]>();
  for (const order of orders) {
    for (const pkg of splitOrderIntoPackages(order, catalog, suppliers)) {
      const list = packagesByGroup.get(pkg.supplierKey) ?? [];
      list.push(pkg);
      packagesByGroup.set(pkg.supplierKey, list);
    }
  }
  const keys = Array.from(packagesByGroup.keys())
    .filter((key) => !options.onlySupplierKey || key === options.onlySupplierKey)
    .sort((a, b) => compareSupplierKeys(a, b, names));
  const printedKeys = new Set(keys);
  return keys.map((supplierKey) => {
    const packages = packagesByGroup.get(supplierKey)!;
    const units = new Map<string, number>();
    for (const pkg of packages) {
      for (const line of pkg.lines) units.set(line.label, (units.get(line.label) ?? 0) + line.quantity);
    }
    const elsewhere = new Set<string>();
    if (printedKeys.size < packagesByGroup.size) {
      for (const pkg of packages) {
        if (pkg.total < 2) continue;
        const otherKeys = Array.from(packagesByGroup.entries())
          .filter(([key, list]) => key !== supplierKey && !printedKeys.has(key) && list.some((other) => other.orderId === pkg.orderId));
        if (otherKeys.length > 0) elsewhere.add(pkg.orderId);
      }
    }
    const group: BatchGroup = {
      supplierKey,
      packages,
      unitsByProduct: Array.from(units.entries()).map(([label, quantity]) => ({ label, quantity })),
      ordersWithPackagesElsewhere: Array.from(elsewhere)
    };
    const supplierName = supplierKey === NO_SUPPLIER ? undefined : names.get(supplierKey);
    if (supplierName) group.supplierName = supplierName;
    return group;
  });
}

/** Proveedores que el selector del admin ofrece: los que tienen algun producto de alguna tienda. */
export function supplierOptionsForCatalog(catalog: CatalogItemLike[], suppliers: SupplierLike[]): SupplierLike[] {
  const used = new Set(catalog.filter((item) => item.active !== false).map((item) => cleanText(item.supplierId)).filter(Boolean) as string[]);
  const names = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  return Array.from(used)
    .sort((a, b) => compareSupplierKeys(a, b, names))
    .map((id) => ({ id, name: names.get(id) ?? id }));
}

/** Pedidos que entran en una impresion filtrada por proveedor (RF_06): los que tienen algun paquete suyo. */
export function ordersForSupplier<T extends OrderLike>(
  orders: T[],
  catalog: CatalogItemLike[],
  supplierKey: string | undefined
): T[] {
  if (!supplierKey) return orders;
  return orders.filter((order) => splitOrderIntoPackages(order, catalog, []).some((pkg) => pkg.supplierKey === supplierKey));
}
