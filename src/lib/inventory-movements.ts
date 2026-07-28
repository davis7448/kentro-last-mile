/**
 * Lineas de producto de un pedido y sus movimientos de inventario.
 *
 * ESPEJO de functions/src/inventory-movements.ts (el cliente no puede importar de
 * functions/ ni al reves). Cambiar los dos juntos.
 *
 * Regla que ordena todo el diseno: una reserva solo se libera si alguien la creo.
 * Los movimientos se derivan de lineItems para cualquier pedido, pero solo se APLICAN
 * cuando orderOwnsInventoryReservation() es cierto (marcador `inventoryReserved`, que
 * escribe unicamente createManualOrder). Asi los pedidos importados por webhook quedan
 * fuera del control de stock, igual que hoy, y no aparecen reservas fantasma.
 */
import type { InventoryItem, Order, OrderLineItem } from "./types";

export type OrderLine = {
  productName?: string;
  sku?: string;
  quantity: number;
};

export type InventoryMovement = {
  skuKey: string;
  quantity: number;
};

export type OrderLinesSummary = {
  productName?: string;
  sku?: string;
  quantity?: number;
  lineItems: OrderLineItem[];
};

type RawLine = {
  productName?: unknown;
  sku?: unknown;
  quantity?: unknown;
};

type LineSource = {
  lineItems?: unknown;
  productName?: unknown;
  sku?: unknown;
  quantity?: unknown;
};

const CLOSED_STATUSES = new Set(["delivered", "failed", "cancelled", "liquidated"]);

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanQuantity(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function skuKeyOf(value: unknown): string | undefined {
  const sku = cleanText(value);
  return sku ? sku.toUpperCase() : undefined;
}

/**
 * Normaliza el origen de lineas de un pedido (payload del formulario o doc de Firestore).
 * Prioriza lineItems; si no hay, cae a los campos colapsados. Un pedido sin producto
 * devuelve [] y sigue siendo valido, igual que hoy.
 */
export function normalizeOrderLines(source: LineSource): OrderLine[] {
  const rawLines: RawLine[] = Array.isArray(source.lineItems) ? (source.lineItems as RawLine[]) : [];
  const fromLineItems = rawLines
    .map((line) => ({
      productName: cleanText(line?.productName),
      sku: cleanText(line?.sku),
      quantity: cleanQuantity(line?.quantity)
    }))
    .filter((line) => line.productName || line.sku);
  if (fromLineItems.length > 0) return fromLineItems;

  const productName = cleanText(source.productName);
  const sku = cleanText(source.sku);
  if (!productName && !sku) return [];
  return [{ productName, sku, quantity: cleanQuantity(source.quantity) }];
}

/**
 * Colapsa N lineas a los campos planos del pedido, replicando el formato de
 * summarizeShopifyLineItems (functions/src/shopify.ts) para 2+ lineas.
 *
 * Con UNA sola linea el nombre va limpio, sin sufijo "xN": la tarjeta de pedido y el
 * rotulo de impresion ya pintan la cantidad en un campo aparte, y el sufijo la duplicaria.
 */
export function summarizeOrderLines(lines: OrderLine[]): OrderLinesSummary {
  if (lines.length === 0) return { lineItems: [] };
  const skus = lines.map((line) => line.sku).filter((sku): sku is string => Boolean(sku));
  return {
    productName: lines.length === 1
      ? lines[0].productName
      : lines.map((line) => `${line.productName ?? "Producto"} x${line.quantity}`).join(" + "),
    sku: skus.length > 0 ? skus.join(" + ") : undefined,
    quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    lineItems: lines.map((line) => {
      const entry: OrderLineItem = { quantity: line.quantity };
      if (line.productName) entry.productName = line.productName;
      if (line.sku) entry.sku = line.sku;
      return entry;
    })
  };
}

/**
 * Movimientos de inventario que implica un pedido, agrupados por SKU en mayusculas.
 * Las lineas sin SKU no mueven inventario (el pedido igual se crea).
 */
export function inventoryMovementsForOrder(order: LineSource): InventoryMovement[] {
  const byKey = new Map<string, number>();
  const rawLines: RawLine[] = Array.isArray(order.lineItems) ? (order.lineItems as RawLine[]) : [];

  if (rawLines.length > 0) {
    for (const line of rawLines) {
      const key = skuKeyOf(line?.sku);
      if (!key) continue;
      byKey.set(key, (byKey.get(key) ?? 0) + cleanQuantity(line?.quantity));
    }
  } else {
    const sku = cleanText(order.sku);
    // Los pedidos legacy de Shopify traen el SKU colapsado "A + B", que nunca matcheo
    // ninguna ficha. El guard lo deja explicito para que nadie lo "arregle" y active
    // reservas retroactivas sobre pedidos que jamas reservaron.
    if (sku && !sku.includes(" + ")) {
      const key = skuKeyOf(sku);
      if (key) byKey.set(key, cleanQuantity(order.quantity));
    }
  }

  return Array.from(byKey.entries()).map(([skuKey, quantity]) => ({ skuKey, quantity }));
}

/** Solo los pedidos que reservaron pueden liberar. Lo escribe unicamente createManualOrder. */
export function orderOwnsInventoryReservation(order: { inventoryReserved?: boolean }): boolean {
  return order.inventoryReserved === true;
}

export type InventoryMovementKind = "reserve" | "release" | "consume";

/**
 * Version pura del movimiento de stock para el modo offline (sin Firebase).
 * Los SKU sin ficha se ignoran: se puede vender algo que no esta en inventario.
 */
export function applyInventoryMovementsToItems(
  inventory: InventoryItem[],
  sellerId: string,
  movements: InventoryMovement[],
  kind: InventoryMovementKind
): InventoryItem[] {
  if (movements.length === 0) return inventory;
  const byKey = new Map(movements.map((movement) => [movement.skuKey, movement.quantity]));
  return inventory.map((item) => {
    if (item.sellerId !== sellerId) return item;
    const key = skuKeyOf(item.sku);
    const quantity = key ? byKey.get(key) : undefined;
    if (!quantity) return item;
    if (kind === "reserve") return { ...item, reserved: item.reserved + quantity };
    const reserved = Math.max(0, item.reserved - quantity);
    if (kind === "release") return { ...item, reserved };
    return { ...item, reserved, available: Math.max(0, item.available - quantity) };
  });
}

/**
 * Recalcula `reserved` de cada ficha desde los pedidos abiertos que poseen su reserva.
 * Es la prueba de consistencia del diseno: si crear/cancelar/cerrar estan bien, correr
 * esto no debe mover ningun numero.
 */
export function recomputeInventoryReservations(inventory: InventoryItem[], orders: Order[]): InventoryItem[] {
  const reservedByKey = new Map<string, number>();
  for (const order of orders) {
    if (!order.sellerId || CLOSED_STATUSES.has(order.status)) continue;
    if (!orderOwnsInventoryReservation(order)) continue;
    for (const movement of inventoryMovementsForOrder(order)) {
      const key = `${order.sellerId}::${movement.skuKey}`;
      reservedByKey.set(key, (reservedByKey.get(key) ?? 0) + movement.quantity);
    }
  }
  return inventory.map((item) => ({
    ...item,
    reserved: reservedByKey.get(`${item.sellerId}::${skuKeyOf(item.sku) ?? ""}`) ?? 0
  }));
}
