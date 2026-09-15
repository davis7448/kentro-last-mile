import { describe, expect, it } from "vitest";
import { closeDelivered, closeFailed, createManualOrder } from "./actions";
import type { AppState, InventoryItem } from "./types";

const SELLER_ID = "seller-1";
const SKU = "SKU-A";

function baseState(inventory: InventoryItem[]): AppState {
  return {
    activeRole: "admin",
    communities: [],
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
  cashSnapshots: [],
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

  /*
   * Spec 013, T4 (RF_09, RF_10 lado local). `deliveryNotes` todavia no esta en el tipo del input de
   * `createManualOrder` (lo gana en esta tarea, plan §2.4); `Order.deliveryNotes` si existe (T1).
   * El cast a `Parameters<typeof createManualOrder>[1]` deja pasar la clave extra sin `any` y
   * mantiene `tsc --noEmit` en verde en RED; cuando el coder ensanche el tipo, el cast sobra pero
   * no estorba.
   */
  type ManualInput = Parameters<typeof createManualOrder>[1];
  const conIndicaciones = (deliveryNotes?: string): ManualInput =>
    ({ ...manualInput, productName: "Producto A", sku: SKU, deliveryNotes }) as ManualInput;

  it("RF_09 · copia `deliveryNotes` recortado al pedido creado", () => {
    const state = createManualOrder(baseState([item()]), conIndicaciones("  timbre azul  "));
    expect(state.orders[0].deliveryNotes).toBe("timbre azul");
  });

  it("RF_09 · con `deliveryNotes` de solo espacios el pedido no lleva la clave con valor", () => {
    const state = createManualOrder(baseState([item()]), conIndicaciones("   "));
    expect(state.orders[0].deliveryNotes).toBeUndefined();
  });

  it("RF_09 · sin `deliveryNotes` el pedido tampoco lleva la clave con valor", () => {
    const state = createManualOrder(baseState([item()]), conIndicaciones(undefined));
    expect(state.orders[0].deliveryNotes).toBeUndefined();
  });

  it("RF_10 · las indicaciones no acaban en `normalizedAddress`: con `deliveryNotes` y sin corregida, queda undefined", () => {
    const state = createManualOrder(baseState([item()]), conIndicaciones("timbre azul"));
    const order = state.orders[0];
    // Positiva de control: la direccion original sigue siendo la que se envio.
    expect(order.addressRaw).toBe("Calle 1");
    expect(order.normalizedAddress).toBeUndefined();
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
