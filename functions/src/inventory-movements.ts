/**
 * Lineas de producto de un pedido y sus movimientos de inventario.
 *
 * ESPEJO de src/lib/inventory-movements.ts (el cliente no puede importar de functions/
 * ni al reves). Cambiar los dos juntos EN LO QUE COMPARTEN: el derivado de lineas
 * (normalizeOrderLines / inventoryMovementsForOrder). La aplicacion sobre documentos es
 * propia de cada lado (el cliente expone applyInventoryMovementsToItems), asi que los
 * kinds `consume_available` / `restore_available` no tienen contraparte alli.
 *
 * Regla que ordena todo el diseno: una reserva solo se libera si alguien la creo.
 * Los movimientos se derivan de lineItems para cualquier pedido, pero solo se APLICAN
 * cuando orderOwnsInventoryReservation() es cierto (marcador `inventoryReserved`, que
 * escribe unicamente createManualOrder). Asi los pedidos importados por webhook quedan
 * fuera del control de stock, igual que hoy, y no aparecen reservas fantasma.
 */
import type { DocumentReference, Transaction } from "firebase-admin/firestore";

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
  lineItems: OrderLine[];
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

export type InventoryIndexEntry = {
  ref: DocumentReference;
  available: number;
  reserved: number;
};

export type InventoryIndex = Map<string, InventoryIndexEntry>;

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
    // Cada linea se limpia por separado: stripUndefined es shallow y el Admin SDK no
    // tiene ignoreUndefinedProperties, asi que un undefined anidado hace fallar el set.
    lineItems: lines.map((line) => {
      const entry: OrderLine = { quantity: line.quantity };
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
export function orderOwnsInventoryReservation(order: { inventoryReserved?: unknown }): boolean {
  return order.inventoryReserved === true;
}

/**
 * Todas las fichas de inventario del vendedor en UNA lectura, indexadas por SKU en
 * mayusculas. Sustituye la query por SKU: sirve para N lineas y unifica el matching
 * (reconcileInventoryReservations ya comparaba en mayusculas mientras crear/cancelar/
 * cerrar lo hacian exacto, con lo que se descuadraban entre si).
 */
export async function readSellerInventoryIndex(
  transaction: Transaction,
  collection: FirebaseFirestore.Query,
  sellerId: string
): Promise<InventoryIndex> {
  return buildSellerInventoryIndex(await transaction.get(collection.where("sellerId", "==", sellerId)));
}

/**
 * La parte sin transaccion: la correccion administrativa de pedidos trabaja con un batch
 * (necesita leer la coleccion de asientos entera, que no cabe en una transaccion) y aun asi
 * tiene que indexar el inventario igual que closeOrder.
 */
export function buildSellerInventoryIndex(snapshot: FirebaseFirestore.QuerySnapshot): InventoryIndex {
  const index: InventoryIndex = new Map();
  for (const doc of snapshot.docs) {
    const item = doc.data();
    const key = skuKeyOf(item.sku);
    if (!key) continue;
    index.set(key, {
      ref: doc.ref,
      available: Number(item.available) || 0,
      reserved: Number(item.reserved) || 0
    });
  }
  return index;
}

/**
 * `consume_available` y `restore_available` existen solo para las correcciones de estado.
 * Al pasar un pedido de fallido a entregado, el cierre fallido YA hizo `release` (bajo
 * `reserved`); lo unico que falta es descontar `available`. Reusar `consume` volveria a
 * decrementar `reserved` y dejaria el stock reservado en negativo logico.
 */
export type InventoryMovementKind = "reserve" | "release" | "consume" | "consume_available" | "restore_available";

/**
 * Aplica los movimientos sobre las fichas del indice. Los SKU sin ficha se ignoran en
 * silencio: se puede vender un producto que no esta en inventario (decision de producto).
 * No hay tope al reservar; nunca se bloquea un pedido por falta de stock.
 */
/**
 * Escritor estructural: sirve igual una Transaction que un WriteBatch. Las correcciones de
 * estado usan batch (necesitan leer la coleccion de asientos entera, que no cabe en una
 * transaccion) y aun asi tienen que mover inventario como lo hace closeOrder.
 */
export type InventoryWriter = {
  set(ref: DocumentReference, data: Record<string, unknown>, options: { merge: true }): unknown;
};

export function applyInventoryMovements(
  transaction: InventoryWriter,
  index: InventoryIndex,
  movements: InventoryMovement[],
  kind: InventoryMovementKind,
  now: string
): void {
  for (const movement of movements) {
    const entry = index.get(movement.skuKey);
    if (!entry) continue;
    const patch: Record<string, unknown> = { updatedAt: now };
    if (kind === "consume_available" || kind === "restore_available") {
      // Solo mueven `available`: la reserva ya se resolvio en el cierre anterior.
      entry.available = Math.max(0, entry.available + (kind === "restore_available" ? movement.quantity : -movement.quantity));
      patch.available = entry.available;
      transaction.set(entry.ref, patch, { merge: true });
      continue;
    }
    if (kind === "reserve") {
      entry.reserved += movement.quantity;
    } else {
      entry.reserved = Math.max(0, entry.reserved - movement.quantity);
      if (kind === "consume") {
        entry.available = Math.max(0, entry.available - movement.quantity);
        patch.available = entry.available;
      }
    }
    patch.reserved = entry.reserved;
    transaction.set(entry.ref, patch, { merge: true });
  }
}
