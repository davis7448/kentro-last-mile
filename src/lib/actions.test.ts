import { describe, expect, it } from "vitest";
import { closeDelivered, closeFailed, createManualOrder } from "./actions";
import type { AppState, InventoryItem } from "./types";

const SELLER_ID = "seller-1";
const SKU = "SKU-A";

function baseState(inventory: InventoryItem[]): AppState {
  return {
    activeRole: "admin",
    cities: [],
    zones: [],
    sellers: [{ id: SELLER_ID, name: "Tienda", shopDomain: "tienda.myshopify.com", cityId: "city-cali", bankAccount: "0" }],
    shopifyStores: [],
    storeWebhookConfigs: [],
    shopifyInstallRequests: [],
    shopifySyncIssues: [],
    drivers: [],
    messengers: [],
    pickupBatches: [],
    suppliers: [],
    productCatalog: [],
    inventory,
    orders: [],
    wallet: [],
    settlements: [],
    payouts: [],
    audit: [],
    settings: {
      activeCityId: "city-cali",
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 9000,
      fulfillmentFeeCop: 2000,
      driverDeliveredPayCop: 8000,
      driverFailedPayCop: 8000,
      pendingReserveCop: 0,
      debtBlockDays: 30,
      failedRateAlertPercent: 30,
      payoutDays: []
    }
  };
}

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return { id: "inv-1", sellerId: SELLER_ID, sku: SKU, name: "Producto A", available: 10, reserved: 0, ...overrides };
}

const manualInput = {
  sellerId: SELLER_ID,
  customerName: "Cliente",
  customerPhone: "3000000000",
  addressRaw: "Calle 1",
  paymentMethod: "cod" as const,
  fulfillmentMode: "seller_pickup" as const,
  totalCop: 100000,
  addressRisk: "accepted" as const
};

describe("createManualOrder", () => {
  it("colapsa varias lineas y reserva la cantidad de cada SKU conocido", () => {
    const state = createManualOrder(baseState([item()]), {
      ...manualInput,
      lineItems: [
        { productName: "Producto A", sku: SKU, quantity: 3 },
        { productName: "Producto libre sin ficha", quantity: 1 }
      ]
    });
    const order = state.orders[0];
    expect(order.productName).toBe("Producto A x3 + Producto libre sin ficha x1");
    expect(order.quantity).toBe(4);
    expect(order.lineItems).toHaveLength(2);
    expect(order.inventoryReserved).toBe(true);
    expect(state.inventory[0].reserved).toBe(3);
  });

  it("acepta un producto de texto libre que no esta en inventario", () => {
    const state = createManualOrder(baseState([item()]), {
      ...manualInput,
      lineItems: [{ productName: "2 frascos de resina dental", quantity: 2 }]
    });
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0].productName).toBe("2 frascos de resina dental");
    expect(state.orders[0].inventoryReserved).toBeUndefined();
    expect(state.inventory[0].reserved).toBe(0);
  });

  it("crea el pedido aunque la cantidad supere el stock libre", () => {
    const state = createManualOrder(baseState([item({ available: 2 })]), {
      ...manualInput,
      lineItems: [{ productName: "Producto A", sku: SKU, quantity: 5 }]
    });
    expect(state.orders).toHaveLength(1);
    expect(state.inventory[0].reserved).toBe(5);
  });

  it("sigue aceptando el payload viejo de campos planos", () => {
    const state = createManualOrder(baseState([item()]), { ...manualInput, productName: "Producto A", sku: SKU });
    expect(state.orders[0].quantity).toBe(1);
    expect(state.orders[0].lineItems).toEqual([{ quantity: 1, productName: "Producto A", sku: SKU }]);
    expect(state.inventory[0].reserved).toBe(1);
  });
});

describe("invariante de reserva", () => {
  const withOrder = () => createManualOrder(baseState([item({ available: 10, reserved: 0 })]), {
    ...manualInput,
    lineItems: [{ productName: "Producto A", sku: SKU, quantity: 3 }]
  });

  it("entregar consume el stock y devuelve la reserva a su valor inicial", () => {
    const created = withOrder();
    expect(created.inventory[0].reserved).toBe(3);
    const closed = closeDelivered(created, created.orders[0].id);
    expect(closed.inventory[0]).toMatchObject({ available: 7, reserved: 0 });
  });

  it("un fallido definitivo libera la reserva sin tocar el stock", () => {
    const created = withOrder();
    const closed = closeFailed(created, created.orders[0].id);
    expect(closed.inventory[0]).toMatchObject({ available: 10, reserved: 0 });
  });

  it("una visita reagendada mantiene la reserva viva", () => {
    const created = withOrder();
    const closed = closeFailed(created, created.orders[0].id, { reason: "Cliente reagenda visita" });
    expect(closed.inventory[0]).toMatchObject({ available: 10, reserved: 3 });
  });

  it("un pedido de texto libre no mueve inventario al cerrarse", () => {
    const created = createManualOrder(baseState([item()]), {
      ...manualInput,
      lineItems: [{ productName: "Producto sin ficha", quantity: 2 }]
    });
    const closed = closeDelivered(created, created.orders[0].id);
    expect(closed.inventory[0]).toMatchObject({ available: 10, reserved: 0 });
  });
});
