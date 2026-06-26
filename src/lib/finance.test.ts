import { describe, expect, it } from "vitest";
import { calculateDriverFinancialSummary, calculateDriverSettlementFinancials, entriesForClosedOrder, sellerBalance } from "./finance";
import { seedState } from "./seed";
import type { AppState } from "./types";

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

  it("creates product cost entries for delivered orders with a configured catalog match", () => {
    const state: AppState = {
      ...seedState(),
      suppliers: [{ id: "sup-1", name: "Proveedor Uno", active: true, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }],
      productCatalog: [{
        id: "prd-1",
        sellerId: "seller-1",
        supplierId: "sup-1",
        sku: "AUR-CAFE-250",
        name: "Cafe premium 250g",
        normalizedProductName: "cafe premium 250g",
        productCostCop: 18000,
        productCostConfigured: true,
        active: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }]
    };
    const order = {
      ...state.orders[0],
      status: "delivered" as const,
      paymentMethod: "cod" as const,
      sku: "aur-cafe-250",
      quantity: 2
    };

    const entries = entriesForClosedOrder(order, state);
    const productCost = entries.find((entry) => entry.type === "product_cost");

    expect(productCost?.amountCop).toBe(-36000);
    expect(productCost?.supplierId).toBe("sup-1");
    expect(productCost?.productId).toBe("prd-1");
  });

  it("does not create product cost entries when cost is not configured", () => {
    const state: AppState = {
      ...seedState(),
      suppliers: [{ id: "sup-1", name: "Proveedor Uno", active: true, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }],
      productCatalog: [{
        id: "prd-1",
        sellerId: "seller-1",
        supplierId: "sup-1",
        sku: "AUR-CAFE-250",
        name: "Cafe premium 250g",
        normalizedProductName: "cafe premium 250g",
        productCostCop: 18000,
        productCostConfigured: false,
        active: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }]
    };
    const order = {
      ...state.orders[0],
      status: "delivered" as const,
      paymentMethod: "cod" as const
    };

    const entries = entriesForClosedOrder(order, state);

    expect(entries.some((entry) => entry.type === "product_cost")).toBe(false);
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

describe("driver financial summary", () => {
  const baseState = (): AppState => ({
    ...seedState(),
    orders: [],
    wallet: [],
    settlements: []
  });

  it("tracks partial driver settlement cash", () => {
    const state = baseState();
    state.settlements = [{
      id: "stl-partial",
      kind: "driver",
      ownerId: "driver-1",
      ownerName: "Driver",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      walletEntryIds: [],
      orderIds: ["ord-1"],
      codCop: 100,
      feesCop: 0,
      driverPayCop: 0,
      platformMarginCop: 0,
      netCop: -100,
      status: "paid",
      createdAt: "2026-06-02T00:00:00.000Z",
      cashPendingCop: 30,
      cashReceipts: [{ id: "rcp-1", amountCop: 70, receivedAt: "2026-06-02T01:00:00.000Z" }]
    }];

    const summary = calculateDriverFinancialSummary(state, "driver-1");

    expect(summary.pendingBalanceCop).toBe(30);
    expect(summary.receivedCop).toBe(70);
    expect(summary.incompleteSettlementsCop).toBe(30);
    expect(summary.receiptRows[0].pendingAfterCop).toBe(30);
  });

  it("keeps a pending settlement without receipts fully pending", () => {
    const state = baseState();
    state.settlements = [{
      id: "stl-pending",
      kind: "driver",
      ownerId: "driver-1",
      ownerName: "Driver",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      walletEntryIds: [],
      orderIds: ["ord-1"],
      codCop: 100,
      feesCop: 0,
      driverPayCop: 0,
      platformMarginCop: 0,
      netCop: -100,
      status: "pending",
      createdAt: "2026-06-02T00:00:00.000Z"
    }];

    const summary = calculateDriverFinancialSummary(state, "driver-1");

    expect(summary.pendingBalanceCop).toBe(100);
    expect(summary.receivedCop).toBe(0);
    expect(summary.incompleteSettlements).toHaveLength(1);
  });

  it("keeps a closed settlement out of the pending balance", () => {
    const state = baseState();
    state.settlements = [{
      id: "stl-closed",
      kind: "driver",
      ownerId: "driver-1",
      ownerName: "Driver",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      walletEntryIds: [],
      orderIds: ["ord-1"],
      codCop: 100,
      feesCop: 0,
      driverPayCop: 0,
      platformMarginCop: 0,
      netCop: -100,
      status: "reconciled",
      createdAt: "2026-06-02T00:00:00.000Z"
    }];

    const summary = calculateDriverFinancialSummary(state, "driver-1");

    expect(summary.pendingBalanceCop).toBe(0);
    expect(summary.receivedCop).toBe(100);
  });

  it("adds delivered COD orders without a driver settlement using total minus driver pay", () => {
    const state = baseState();
    state.orders = [{
      ...seedState().orders[0],
      id: "ord-uncut",
      shopifyOrderId: "1001",
      driverId: "driver-1",
      status: "delivered",
      paymentMethod: "cod",
      totalCop: 100
    }];
    state.wallet = [{
      id: "we-driver-pay",
      ownerType: "driver",
      ownerId: "driver-1",
      orderId: "ord-uncut",
      type: "driver_earning",
      amountCop: 20,
      description: "Pago transportista entregado 1001",
      createdAt: "2026-06-02T00:00:00.000Z"
    }];

    const summary = calculateDriverFinancialSummary(state, "driver-1");

    expect(summary.unsettledCashCop).toBe(80);
    expect(summary.pendingBalanceCop).toBe(80);
  });

  it("does not duplicate delivered COD orders already included in a settlement", () => {
    const state = baseState();
    state.orders = [{
      ...seedState().orders[0],
      id: "ord-settled",
      shopifyOrderId: "1001",
      driverId: "driver-1",
      status: "delivered",
      paymentMethod: "cod",
      totalCop: 100
    }];
    state.settlements = [{
      id: "stl-existing",
      kind: "driver",
      ownerId: "driver-1",
      ownerName: "Driver",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      walletEntryIds: [],
      orderIds: ["ord-settled"],
      codCop: 100,
      feesCop: 0,
      driverPayCop: 20,
      platformMarginCop: -20,
      netCop: -80,
      status: "pending",
      createdAt: "2026-06-02T00:00:00.000Z"
    }];

    const summary = calculateDriverFinancialSummary(state, "driver-1");

    expect(summary.unsettledCashCop).toBe(0);
    expect(summary.pendingBalanceCop).toBe(80);
  });

  it("ignores prepaid and failed orders as cash to return", () => {
    const state = baseState();
    state.orders = [
      {
        ...seedState().orders[0],
        id: "ord-prepaid",
        driverId: "driver-1",
        status: "delivered",
        paymentMethod: "prepaid",
        totalCop: 100
      },
      {
        ...seedState().orders[0],
        id: "ord-failed",
        driverId: "driver-1",
        status: "failed",
        paymentMethod: "cod",
        totalCop: 100
      }
    ];

    const summary = calculateDriverFinancialSummary(state, "driver-1");

    expect(summary.pendingBalanceCop).toBe(0);
    expect(summary.unsettledOrders).toHaveLength(0);
  });
});

describe("driver settlement financials", () => {
  it("calculates platform margin from seller fees minus driver pay without product cost", () => {
    const state = seedState();
    const settlement = {
      id: "stl-driver",
      kind: "driver" as const,
      ownerId: "driver-1",
      ownerName: "Driver",
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      walletEntryIds: ["we-driver-pay"],
      orderIds: ["ord-1"],
      codCop: 0,
      feesCop: 0,
      driverPayCop: 9000,
      platformMarginCop: -9000,
      netCop: 9000,
      status: "paid" as const,
      createdAt: "2026-06-02T00:00:00.000Z"
    };
    state.wallet = [
      {
        id: "we-seller-fee",
        ownerType: "seller",
        ownerId: "seller-1",
        orderId: "ord-1",
        type: "delivery_fee",
        amountCop: -12000,
        description: "Cobro entrega",
        createdAt: "2026-06-01T00:00:00.000Z"
      },
      {
        id: "we-product-cost",
        ownerType: "seller",
        ownerId: "seller-1",
        orderId: "ord-1",
        type: "product_cost",
        amountCop: -20000,
        description: "Costo producto",
        createdAt: "2026-06-01T00:00:00.000Z"
      },
      {
        id: "we-driver-pay",
        ownerType: "driver",
        ownerId: "driver-1",
        orderId: "ord-1",
        type: "driver_earning",
        amountCop: 9000,
        description: "Pago domiciliario",
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ];

    const financials = calculateDriverSettlementFinancials(state.wallet, settlement);

    expect(financials.feesCop).toBe(12000);
    expect(financials.driverPayCop).toBe(9000);
    expect(financials.platformMarginCop).toBe(3000);
  });
});
