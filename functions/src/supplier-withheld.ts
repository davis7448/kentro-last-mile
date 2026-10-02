/**
 * Clave y agrupacion del costo de producto retenido por proveedor (spec 026, T3, RF_08).
 *
 * Sale tal cual de `computePlatformPosition` para que la posicion y cualquier otra vista agrupen con
 * la misma clave, incluido el grupo "(sin proveedor)" de los asientos sin `supplierId`. Puro.
 */
import type { WalletEntryDoc } from "./settlement-math";

export const NO_SUPPLIER_KEY = "(sin proveedor)";

export type WithheldSupplierRow = { supplierId: string; supplierName: string; amountCop: number };

export function withheldSupplierKey(entry: WalletEntryDoc): string {
  return entry.supplierId ?? NO_SUPPLIER_KEY;
}

/**
 * Agrupa asientos YA filtrados como retenido (product_cost de tienda sin liquidar al proveedor).
 * Invierte el signo, toma el ultimo nombre no vacio, descarta grupos en 0 y ordena de mayor a menor
 * (estable: a igual importe conserva el orden de aparicion).
 */
export function groupWithheldBySupplier(entries: WalletEntryDoc[]): WithheldSupplierRow[] {
  const bySupplier = new Map<string, WithheldSupplierRow>();
  for (const entry of entries) {
    const supplierId = withheldSupplierKey(entry);
    const current = bySupplier.get(supplierId) ?? { supplierId, supplierName: entry.supplierName ?? supplierId, amountCop: 0 };
    current.amountCop += -Math.round(entry.amountCop);
    if (entry.supplierName) current.supplierName = entry.supplierName;
    bySupplier.set(supplierId, current);
  }
  return [...bySupplier.values()].filter((row) => row.amountCop !== 0).sort((left, right) => right.amountCop - left.amountCop);
}
