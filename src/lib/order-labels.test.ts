import { describe, expect, it } from "vitest";
import { canPrintSellerLabel } from "./order-labels";
import type { Order } from "./types";

const baseOrder: Order = {
  id: "ord-1",
  shopifyOrderId: "#1001",
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
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z"
};

describe("seller label printing eligibility", () => {
  it("allows uncollected ready and assigned seller orders", () => {
    expect(canPrintSellerLabel({ ...baseOrder, status: "ready_to_assign" }, "seller-1")).toBe(true);
    expect(canPrintSellerLabel({ ...baseOrder, status: "assigned" }, "seller-1")).toBe(true);
  });

  it("excludes post-pickup and operational statuses even when unprinted", () => {
    const statuses: Order["status"][] = [
      "picked_up",
      "call_pending",
      "scheduled",
      "in_route",
      "retry_pending",
      "delivered",
      "failed"
    ];

    for (const status of statuses) {
      expect(canPrintSellerLabel({ ...baseOrder, status }, "seller-1")).toBe(false);
    }
  });

  it("excludes any order already associated with pickup data", () => {
    expect(canPrintSellerLabel({ ...baseOrder, pickupBatchId: "pb-1" }, "seller-1")).toBe(false);
    expect(canPrintSellerLabel({ ...baseOrder, pickedUpAt: "2026-06-24T22:40:39.055Z" }, "seller-1")).toBe(false);
    expect(canPrintSellerLabel({ ...baseOrder, messengerId: "messenger-1" }, "seller-1")).toBe(false);
  });
});
