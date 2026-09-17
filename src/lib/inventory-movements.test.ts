import { describe, expect, it } from "vitest";
import {
  applyInventoryMovementsToItems,
  inventoryMovementsForOrder,
  normalizeOrderLines,
  orderOwnsInventoryReservation,
  recomputeInventoryReservations,
  summarizeOrderLines
} from "./inventory-movements";
import type { InventoryItem, Order } from "./types";

function inventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "inv-1",
    sellerId: "seller-1",
    sku: "SKU-A",
    name: "Producto A",
    available: 10,
    reserved: 0,
    ...overrides
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord-1",
    shopifyOrderId: "MAN-KNT-000001",
    sellerId: "seller-1",
    cityId: "city-cali",
    customerName: "Cliente",
    customerPhone: "3000000000",
    addressRaw: "Calle 1",
    addressRisk: "accepted",
    status: "ready_to_assign",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    totalCop: 100000,
    evidence: [],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides
  };
}

describe("normalizeOrderLines", () => {
  it("descarta las lineas vacias y sanea la cantidad", () => {
    const lines = normalizeOrderLines({
      lineItems: [
        { productName: "  Producto A  ", sku: " sku-a ", quantity: 3 },
        { productName: "   ", sku: "   ", quantity: 5 }
      ]
    });
    expect(lines).toEqual([{ productName: "Producto A", sku: "sku-a", quantity: 3 }]);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    ["2", 2],
    [2.7, 2],
    [undefined, 1]
  ])("convierte la cantidad %p en %p", (input, expected) => {
    expect(normalizeOrderLines({ lineItems: [{ productName: "A", quantity: input }] })[0].quantity).toBe(expected);
  });

  it("cae a los campos colapsados cuando no hay lineItems utiles", () => {
    expect(normalizeOrderLines({ lineItems: [], productName: "Suelto", sku: "S1", quantity: 4 }))
      .toEqual([{ productName: "Suelto", sku: "S1", quantity: 4 }]);
  });

  it("devuelve vacio cuando el pedido no tiene producto", () => {
    expect(normalizeOrderLines({})).toEqual([]);
  });
});

describe("summarizeOrderLines", () => {
  it("con una sola linea deja el nombre limpio, sin sufijo xN", () => {
    const summary = summarizeOrderLines([{ productName: "Resina dental", sku: "R1", quantity: 2 }]);
    expect(summary.productName).toBe("Resina dental");
    expect(summary.sku).toBe("R1");
    expect(summary.quantity).toBe(2);
  });

  it("con varias lineas replica el formato de summarizeShopifyLineItems", () => {
    const summary = summarizeOrderLines([
      { productName: "A", sku: "SKU1", quantity: 2 },
      { productName: "B", sku: "SKU2", quantity: 1 }
    ]);
    expect(summary.productName).toBe("A x2 + B x1");
    expect(summary.sku).toBe("SKU1 + SKU2");
    expect(summary.quantity).toBe(3);
    expect(summary.lineItems).toHaveLength(2);
  });

  it("no deja claves undefined dentro de lineItems", () => {
    const [line] = summarizeOrderLines([{ productName: "Sin sku", quantity: 1 }]).lineItems;
    expect(Object.keys(line).sort()).toEqual(["productName", "quantity"]);
    expect("sku" in line).toBe(false);
  });

  it("sin lineas no produce campos colapsados", () => {
    expect(summarizeOrderLines([])).toEqual({ lineItems: [] });
  });
});

describe("inventoryMovementsForOrder", () => {
  it("suma las lineas que repiten el mismo SKU, normalizando mayusculas", () => {
    const movements = inventoryMovementsForOrder({
      lineItems: [
        { sku: "sku-a", quantity: 2 },
        { sku: "SKU-A", quantity: 3 }
      ]
    });
    expect(movements).toEqual([{ skuKey: "SKU-A", quantity: 5 }]);
  });

  it("ignora las lineas sin SKU", () => {
    expect(inventoryMovementsForOrder({ lineItems: [{ productName: "Libre", quantity: 4 }] })).toEqual([]);
  });

  it("usa los campos colapsados cuando no hay lineItems", () => {
    expect(inventoryMovementsForOrder({ sku: "SKU-A", quantity: 3 })).toEqual([{ skuKey: "SKU-A", quantity: 3 }]);
  });

  it("no mueve nada con un SKU colapsado legacy de Shopify", () => {
    expect(inventoryMovementsForOrder({ sku: "SKU1 + SKU2", quantity: 3 })).toEqual([]);
  });
});

describe("orderOwnsInventoryReservation", () => {
  it("solo es cierto con el marcador explicito", () => {
    expect(orderOwnsInventoryReservation({ inventoryReserved: true })).toBe(true);
    expect(orderOwnsInventoryReservation({ inventoryReserved: false })).toBe(false);
    expect(orderOwnsInventoryReservation({})).toBe(false);
  });
});

describe("applyInventoryMovementsToItems", () => {
  const inventory = [inventoryItem({ available: 10, reserved: 1 })];

  it("reserva sumando la cantidad, sin tope por stock", () => {
    const next = applyInventoryMovementsToItems(inventory, "seller-1", [{ skuKey: "SKU-A", quantity: 25 }], "reserve");
    expect(next[0].reserved).toBe(26);
    expect(next[0].available).toBe(10);
  });

  it("consumir baja stock y reserva", () => {
    const next = applyInventoryMovementsToItems(inventory, "seller-1", [{ skuKey: "SKU-A", quantity: 1 }], "consume");
    expect(next[0]).toMatchObject({ available: 9, reserved: 0 });
  });

  it("no toca fichas de otro vendedor ni SKU desconocidos", () => {
    expect(applyInventoryMovementsToItems(inventory, "seller-2", [{ skuKey: "SKU-A", quantity: 1 }], "reserve")).toEqual(inventory);
    expect(applyInventoryMovementsToItems(inventory, "seller-1", [{ skuKey: "OTRO", quantity: 1 }], "reserve")).toEqual(inventory);
  });
});

describe("recomputeInventoryReservations", () => {
  it("solo cuenta pedidos abiertos que poseen su reserva, por cantidad", () => {
    const inventory = [inventoryItem({ reserved: 99 })];
    const orders = [
      order({ id: "manual-abierto", inventoryReserved: true, lineItems: [{ sku: "SKU-A", quantity: 3 }] }),
      order({ id: "shopify-abierto", lineItems: [{ sku: "SKU-A", quantity: 7 }] }),
      order({ id: "manual-cerrado", status: "delivered", inventoryReserved: true, lineItems: [{ sku: "SKU-A", quantity: 5 }] })
    ];
    expect(recomputeInventoryReservations(inventory, orders)[0].reserved).toBe(3);
  });
});
