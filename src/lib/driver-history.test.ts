import { describe, expect, it } from "vitest";
import { driverFleetClosedOrders, filterDriverHistoryOrders, isDriverActiveOrder, orderClosedAt } from "./driver-history";
import { seedState } from "./seed";
import type { AppState, Order } from "./types";

const baseOrder: Order = {
  id: "ord-base",
  trackingCode: "KNT-1",
  shopifyOrderId: "#1001",
  sellerId: "seller-1",
  cityId: "city-cali",
  driverId: "driver-1",
  customerName: "Cliente Uno",
  customerPhone: "3000000000",
  addressRaw: "Calle 1",
  addressRisk: "accepted",
  status: "picked_up",
  paymentMethod: "cod",
  fulfillmentMode: "seller_pickup",
  totalCop: 100000,
  evidence: [],
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T01:00:00.000Z"
};

function stateWithOrders(orders: Order[]): AppState {
  return {
    ...seedState(),
    messengers: [
      {
        id: "messenger-1",
        leaderDriverId: "driver-1",
        name: "Mensajero Uno",
        phone: "",
        active: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    ],
    orders
  };
}

describe("driver history helpers", () => {
  it("excludes liquidated orders from active driver orders", () => {
    expect(isDriverActiveOrder({ ...baseOrder, status: "picked_up" }, "driver-1")).toBe(true);
    expect(isDriverActiveOrder({ ...baseOrder, status: "liquidated" }, "driver-1")).toBe(false);
  });

  it("includes delivered and failed fleet orders only", () => {
    const state = stateWithOrders([
      { ...baseOrder, id: "delivered", status: "delivered" },
      { ...baseOrder, id: "failed", status: "failed", messengerId: "messenger-1" },
      { ...baseOrder, id: "cancelled", status: "cancelled" },
      { ...baseOrder, id: "active", status: "in_route" },
      { ...baseOrder, id: "other-driver", status: "delivered", driverId: "driver-2" }
    ]);

    expect(driverFleetClosedOrders(state, "driver-1").map((order) => order.id)).toEqual(["delivered", "failed"]);
  });

  it("uses closing evidence date before updatedAt fallback", () => {
    const orderWithEvidence: Order = {
      ...baseOrder,
      status: "delivered",
      updatedAt: "2026-06-03T00:00:00.000Z",
      evidence: [{
        id: "ev-1",
        type: "delivery",
        photoLabel: "foto",
        note: "ok",
        actorId: "driver-1",
        createdAt: "2026-06-02T00:00:00.000Z"
      }]
    };

    expect(orderClosedAt(orderWithEvidence)).toBe("2026-06-02T00:00:00.000Z");
    expect(orderClosedAt({ ...baseOrder, status: "failed" })).toBe(baseOrder.updatedAt);
  });

  it("combines search, status, messenger, seller and date filters", () => {
    const orders: Order[] = [
      {
        ...baseOrder,
        id: "match",
        trackingCode: "KNT-ABC",
        status: "failed",
        messengerId: "messenger-1",
        updatedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        ...baseOrder,
        id: "wrong-status",
        trackingCode: "KNT-ABC",
        status: "delivered",
        messengerId: "messenger-1",
        updatedAt: "2026-06-10T00:00:00.000Z"
      },
      {
        ...baseOrder,
        id: "wrong-date",
        trackingCode: "KNT-ABC",
        status: "failed",
        messengerId: "messenger-1",
        updatedAt: "2026-05-10T00:00:00.000Z"
      }
    ];

    const filtered = filterDriverHistoryOrders(orders, {
      search: "abc",
      status: "failed",
      messengerId: "messenger-1",
      sellerId: "seller-1",
      startDate: "2026-06-01",
      endDate: "2026-06-30"
    });

    expect(filtered.map((order) => order.id)).toEqual(["match"]);
  });
});
