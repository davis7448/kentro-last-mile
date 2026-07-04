import { describe, expect, it } from "vitest";
import { buildOrderExportRows, orderExportColumns } from "./order-export";
import { seedState } from "./seed";
import type { AppState, Order } from "./types";

function baseState(): AppState {
  return {
    ...seedState(),
    messengers: [{
      id: "messenger-1",
      leaderDriverId: "driver-1",
      name: "Carlos Mensajero",
      phone: "+57 300 000 0000",
      active: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    }]
  };
}

function baseOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord-export",
    trackingCode: "KNT-001",
    shopifyOrderId: "#1001",
    sellerId: "seller-1",
    cityId: "city-cali",
    zoneId: "zone-north",
    driverId: "driver-1",
    messengerId: "messenger-1",
    customerName: "Cliente Uno",
    customerPhone: "+57 300 123 4567",
    addressRaw: "Calle 1 #2-3",
    normalizedAddress: "Calle 1 #2-3, Cali",
    lat: 3.4516,
    lng: -76.532,
    addressRisk: "accepted",
    status: "delivered",
    paymentMethod: "cod",
    fulfillmentMode: "warehouse",
    totalCop: 120000,
    productName: "Producto A",
    sku: "SKU-A",
    quantity: 2,
    pickupPointName: "Bodega principal",
    pickupAddress: "Carrera 9 #10-11",
    scheduledDate: "2026-06-29",
    scheduledWindow: "09:00-12:00",
    evidence: [{
      id: "ev-delivery",
      type: "delivery",
      photoLabel: "entrega.jpg",
      photoUrl: "https://example.com/entrega.jpg",
      note: "Entregado a cliente",
      createdAt: "2026-06-29T15:00:00.000Z",
      actorId: "driver-1"
    }],
    createdAt: "2026-06-29T10:00:00.000Z",
    updatedAt: "2026-06-29T16:00:00.000Z",
    ...overrides
  };
}

describe("order export rows", () => {
  it("builds rows for delivered, failed, active and cancelled orders", () => {
    const state = baseState();
    const rows = buildOrderExportRows([
      baseOrder({ id: "delivered", status: "delivered" }),
      baseOrder({
        id: "failed",
        status: "failed",
        failedCategory: "failed_visit",
        failedReason: "Cliente no sale",
        retryDecision: "pending",
        evidence: [{
          id: "ev-failed",
          type: "failed",
          photoLabel: "fallido.jpg",
          note: "No contestan",
          reason: "Cliente no sale",
          createdAt: "2026-06-29T14:00:00.000Z",
          actorId: "driver-1"
        }]
      }),
      baseOrder({ id: "active", status: "in_route" }),
      baseOrder({ id: "cancelled", status: "cancelled", paymentMethod: "prepaid" })
    ], state);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.estado)).toEqual(["Entregado", "Fallido", "En ruta", "Cancelado"]);
    expect(rows[1].categoria_fallido).toBe("Fallido real con visita");
    expect(rows[1].fallido_cobrable).toBe("si");
    expect(rows[3].valor_cod_cop).toBe("");
  });

  it("includes enriched seller, city, zone, driver and messenger data", () => {
    const [row] = buildOrderExportRows([baseOrder()], baseState());

    expect(row.vendedor).toBe("Tienda Aurora");
    expect(row.dominio_tienda).toBe("aurora-demo.myshopify.com");
    expect(row.ciudad).toBe("Cali");
    expect(row.zona).toBe("Norte Cali");
    expect(row.lider_logistico).toBe("Luis Rojas");
    expect(row.mensajero).toBe("Carlos Mensajero");
  });

  it("preserves every column when optional order fields are missing", () => {
    const [row] = buildOrderExportRows([
      baseOrder({
        trackingCode: undefined,
        zoneId: undefined,
        driverId: undefined,
        messengerId: undefined,
        productName: undefined,
        sku: undefined,
        quantity: undefined,
        evidence: []
      })
    ], baseState());

    expect(Object.keys(row)).toEqual([...orderExportColumns]);
    expect(row.numero_guia).toBe("");
    expect(row.zona).toBe("");
    expect(row.cantidad_evidencias).toBe(0);
    expect(row.evidencia_tipo).toBe("");
  });

  it("exports only the orders passed to the helper", () => {
    const state = baseState();
    state.orders = [baseOrder({ id: "included" }), baseOrder({ id: "excluded" })];

    const rows = buildOrderExportRows([state.orders[0]], state);

    expect(rows).toHaveLength(1);
    expect(rows[0].id_pedido).toBe("included");
  });
});
