import { describe, expect, it } from "vitest";
import { entriesForClosedOrder, sellerBalance } from "./finance";
import { seedState } from "./seed";

describe("wallet calculations", () => {
  it("reserves 9.000 COP per pending order before withdrawal", () => {
    const state = seedState();
    const balance = sellerBalance(state, "seller-1");
    expect(balance.pendingOrders).toBeGreaterThan(0);
    expect(balance.reservedCop).toBe(balance.pendingOrders * 9000);
  });

  it("creates seller and driver entries for delivered COD warehouse orders", () => {
    const state = seedState();
    const order = {
      ...state.orders[0],
      status: "delivered" as const,
      paymentMethod: "cod" as const,
      fulfillmentMode: "warehouse" as const,
      driverId: "driver-1"
    };
    const entries = entriesForClosedOrder(order, state);
    expect(entries.some((entry) => entry.type === "cod_revenue" && entry.amountCop === order.totalCop)).toBe(true);
    expect(entries.some((entry) => entry.type === "delivery_fee" && entry.amountCop === -12000)).toBe(true);
    expect(entries.some((entry) => entry.type === "fulfillment_fee" && entry.amountCop === -2000)).toBe(true);
    expect(entries.some((entry) => entry.type === "driver_earning" && entry.amountCop === 9000)).toBe(true);
  });

  it("uses the special DANDA delivered tariff without failed charges", () => {
    const state = seedState();
    const deliveredOrder = {
      ...state.orders[0],
      id: "ord-danda-delivered",
      sellerId: "seller-1779315416119",
      status: "delivered" as const,
      paymentMethod: "prepaid" as const,
      fulfillmentMode: "seller_pickup" as const,
      driverId: "driver-1"
    };
    const failedOrder = {
      ...deliveredOrder,
      id: "ord-danda-failed",
      status: "failed" as const
    };

    const deliveredEntries = entriesForClosedOrder(deliveredOrder, state);
    const failedEntries = entriesForClosedOrder(failedOrder, state);

    expect(deliveredEntries.some((entry) => entry.ownerType === "seller" && entry.type === "delivery_fee" && entry.amountCop === -12000)).toBe(true);
    expect(deliveredEntries.some((entry) => entry.ownerType === "driver" && entry.type === "driver_earning" && entry.amountCop === 10000)).toBe(true);
    expect(failedEntries.some((entry) => entry.type === "failed_fee")).toBe(false);
    expect(failedEntries.some((entry) => entry.type === "driver_earning")).toBe(false);
  });

  it("pays the current driver 11.000 for DANDA orders picked up from June 9, 2026", () => {
    const state = seedState();
    const order = {
      ...state.orders[0],
      id: "ord-danda-new-driver-rate",
      sellerId: "seller-1779315416119",
      status: "delivered" as const,
      paymentMethod: "prepaid" as const,
      fulfillmentMode: "seller_pickup" as const,
      driverId: "driver-1778271901513",
      pickedUpAt: "2026-06-09T05:00:00.000Z"
    };

    const entries = entriesForClosedOrder(order, state);

    expect(entries.some((entry) => entry.type === "delivery_fee" && entry.amountCop === -12000)).toBe(true);
    expect(entries.some((entry) => entry.type === "driver_earning" && entry.amountCop === 11000)).toBe(true);
  });

  it("keeps DANDA at 10.000 before the cutoff or for another driver", () => {
    const state = seedState();
    const baseOrder = {
      ...state.orders[0],
      sellerId: "seller-1779315416119",
      status: "delivered" as const,
      paymentMethod: "prepaid" as const,
      fulfillmentMode: "seller_pickup" as const
    };
    const beforeCutoff = entriesForClosedOrder({
      ...baseOrder,
      id: "ord-danda-before-cutoff",
      driverId: "driver-1778271901513",
      pickedUpAt: "2026-06-09T04:59:59.999Z"
    }, state);
    const otherDriver = entriesForClosedOrder({
      ...baseOrder,
      id: "ord-danda-other-driver",
      driverId: "driver-other",
      pickedUpAt: "2026-06-09T05:00:00.000Z"
    }, state);

    expect(beforeCutoff.some((entry) => entry.type === "driver_earning" && entry.amountCop === 10000)).toBe(true);
    expect(otherDriver.some((entry) => entry.type === "driver_earning" && entry.amountCop === 10000)).toBe(true);
  });

  it("keeps DANDA failed orders without seller or driver charges after the cutoff", () => {
    const state = seedState();
    const order = {
      ...state.orders[0],
      id: "ord-danda-failed-new-rate",
      sellerId: "seller-1779315416119",
      status: "failed" as const,
      driverId: "driver-1778271901513",
      pickedUpAt: "2026-06-09T05:00:00.000Z"
    };

    const entries = entriesForClosedOrder(order, state);

    expect(entries.some((entry) => entry.type === "failed_fee")).toBe(false);
    expect(entries.some((entry) => entry.type === "driver_earning")).toBe(false);
  });

  it("charges every non-DANDA seller 12.000 for a failed order", () => {
    const state = seedState();
    const order = {
      ...state.orders[0],
      id: "ord-standard-failed-rate",
      sellerId: "seller-1",
      status: "failed" as const,
      driverId: "driver-1"
    };

    const entries = entriesForClosedOrder(order, state);

    expect(entries.some((entry) => entry.type === "failed_fee" && entry.amountCop === -12000)).toBe(true);
    expect(entries.some((entry) => entry.type === "driver_earning" && entry.amountCop === 9000)).toBe(true);
  });
});
