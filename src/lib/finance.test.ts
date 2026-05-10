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
    expect(entries.some((entry) => entry.type === "driver_earning" && entry.amountCop === 8000)).toBe(true);
  });
});
