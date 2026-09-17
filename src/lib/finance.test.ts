import { describe, expect, it } from "vitest";
import { calculateDriverFinancialSummary, calculateDriverSettlementFinancials, calculatePlatformPosition, driverCashReceiptRows, entriesForClosedOrder, isOrderEligibleForSellerSettlement, selectOpenWalletEntries, sellerAbonoRows, sellerBalance, summarizeWalletPeriod } from "./finance";
import { seedState } from "./seed";
import type { AppState, Order, WalletEntry } from "./types";

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

  it("charges product cost per line item (combo + extra product) using per-unit catalog cost", () => {
    const state: AppState = {
      ...seedState(),
      suppliers: [{ id: "sup-1", name: "Proveedor Uno", active: true, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }],
      productCatalog: [
        {
          id: "prd-spray",
          sellerId: "seller-1",
          supplierId: "sup-1",
          sku: "SPRAY-X2",
          name: "Spray",
          normalizedProductName: "spray",
          productCostCop: 10000,
          productCostConfigured: true,
          active: true,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z"
        },
        {
          id: "prd-biohair",
          sellerId: "seller-1",
          supplierId: "sup-1",
          sku: "BIOHAIR",
          name: "Biohair",
          normalizedProductName: "biohair",
          productCostCop: 23000,
          productCostConfigured: true,
          active: true,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z"
        }
      ]
    };
    const order = {
      ...state.orders[0],
      status: "delivered" as const,
      paymentMethod: "cod" as const,
      sku: "SPRAY-X2 + BIOHAIR",
      quantity: 4,
      lineItems: [
        { sku: "SPRAY-X2", productName: "Spray", quantity: 3 },
        { sku: "BIOHAIR", productName: "Biohair", quantity: 1 }
      ]
    };

    const costEntries = entriesForClosedOrder(order, state).filter((entry) => entry.type === "product_cost");
    expect(costEntries).toHaveLength(2);
    expect(costEntries.find((entry) => entry.productId === "prd-spray")?.amountCop).toBe(-30000);
    expect(costEntries.find((entry) => entry.productId === "prd-biohair")?.amountCop).toBe(-23000);
    // 10.000x3 + 23.000x1 = 53.000, no 42.000x4 = 168.000 del combo pegado.
    expect(costEntries.reduce((sum, entry) => sum + entry.amountCop, 0)).toBe(-53000);
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
      driverId: "driver-1",
      updatedAt: "2026-07-17T04:59:59.999Z"
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

  it("charges DANDA 13.500 for orders delivered from July 17, 2026 Colombia time", () => {
    const state = seedState();
    const baseOrder = {
      ...state.orders[0],
      sellerId: "seller-1779315416119",
      status: "delivered" as const,
      paymentMethod: "prepaid" as const,
      fulfillmentMode: "seller_pickup" as const,
      driverId: "driver-1778271901513",
      pickedUpAt: "2026-07-17T05:00:00.000Z",
      // Creado antes del corte: la tarifa se decide por la fecha de ENTREGA.
      createdAt: "2026-07-01T05:00:00.000Z"
    };
    const beforeCutoff = entriesForClosedOrder({
      ...baseOrder,
      id: "ord-danda-before-seller-fee-cutoff",
      updatedAt: "2026-07-17T04:59:59.999Z"
    }, state);
    const atCutoff = entriesForClosedOrder({
      ...baseOrder,
      id: "ord-danda-at-seller-fee-cutoff",
      updatedAt: "2026-07-17T05:00:00.000Z"
    }, state);

    expect(beforeCutoff.some((entry) => entry.type === "delivery_fee" && entry.amountCop === -12000)).toBe(true);
    expect(atCutoff.some((entry) => entry.type === "delivery_fee" && entry.amountCop === -13500)).toBe(true);
    expect(beforeCutoff.some((entry) => entry.type === "driver_earning" && entry.amountCop === 11000)).toBe(true);
    expect(atCutoff.some((entry) => entry.type === "driver_earning" && entry.amountCop === 11000)).toBe(true);
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
      pickedUpAt: "2026-06-09T05:00:00.000Z",
      updatedAt: "2026-07-17T04:59:59.999Z"
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

  it("frees a failed order from the driver-cash gate but keeps delivered COD gated", () => {
    const codReceived = new Set<string>(["ord-cod-recibido"]);
    const gated = { id: "ord-cod-pendiente", status: "delivered" as const, paymentMethod: "cod" as const };
    const received = { id: "ord-cod-recibido", status: "delivered" as const, paymentMethod: "cod" as const };
    const failed = { id: "ord-fallido", status: "failed" as const, paymentMethod: "cod" as const };
    const prepaid = { id: "ord-prepago", status: "delivered" as const, paymentMethod: "prepaid" as const };

    // Un fallido no recauda COD: su cobro no puede quedar esperando dinero que nunca llega.
    expect(isOrderEligibleForSellerSettlement(failed, codReceived)).toBe(true);
    // La compuerta debe seguir reteniendo el COD entregado que aun no se recibe.
    expect(isOrderEligibleForSellerSettlement(gated, codReceived)).toBe(false);
    expect(isOrderEligibleForSellerSettlement(received, codReceived)).toBe(true);
    expect(isOrderEligibleForSellerSettlement(prepaid, new Set())).toBe(true);
  });

  it("charges each lost visit separately when an order is retried and fails again", () => {
    const state = seedState();
    const failedEvidence = (id: string) => ({
      id,
      type: "failed" as const,
      photoLabel: "",
      note: "Cliente no recibe",
      failedCategory: "failed_visit" as const,
      createdAt: "2026-07-28T13:00:00.000Z",
      actorId: "messenger-1"
    });
    const base = {
      ...state.orders[0],
      id: "ord-retry-failed-twice",
      sellerId: "seller-1",
      status: "failed" as const,
      driverId: "driver-1"
    };

    const first = entriesForClosedOrder({ ...base, evidence: [failedEvidence("ev-1")] }, state);
    const second = entriesForClosedOrder({ ...base, evidence: [failedEvidence("ev-1"), failedEvidence("ev-2")] }, state);

    // La primera visita conserva el id historico; la segunda usa uno propio, de modo
    // que al guardarse no sobrescribe el cobro anterior.
    expect(first.some((entry) => entry.id === "we-ord-retry-failed-twice-seller-failed-fee")).toBe(true);
    expect(second.some((entry) => entry.id === "we-ord-retry-failed-twice-seller-failed-fee-2")).toBe(true);
    expect(second.some((entry) => entry.id === "we-ord-retry-failed-twice-driver-failed-pay-2")).toBe(true);
  });
});

describe("platform position", () => {
  const entry = (over: Partial<AppState["wallet"][number]>): AppState["wallet"][number] => ({
    id: "we-x", ownerType: "seller", ownerId: "seller-1", orderId: "ord-1",
    type: "cod_revenue", amountCop: 0, description: "", createdAt: "2026-07-01T00:00:00.000Z", ...over
  });

  it("cuenta como utilidad el margen y no el cobro bruto", () => {
    const state: AppState = {
      ...seedState(),
      orders: [], settlements: [],
      wallet: [
        entry({ id: "we-1-cod", type: "cod_revenue", amountCop: 100000 }),
        entry({ id: "we-1-fee", type: "delivery_fee", amountCop: -12000 }),
        entry({ id: "we-1-pay", ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 9000 })
      ]
    };
    const position = calculatePlatformPosition(state);
    expect(position.feesCop).toBe(12000);
    expect(position.driverPayCop).toBe(9000);
    // La utilidad es el margen (3.000), NO el cobro bruto (12.000): ese era el bug de la tabla.
    expect(position.profitCop).toBe(3000);
  });

  it("deja el costo de producto retenido fuera de la utilidad", () => {
    const state: AppState = {
      ...seedState(),
      orders: [], settlements: [],
      wallet: [
        entry({ id: "we-1-fee", type: "delivery_fee", amountCop: -12000 }),
        entry({ id: "we-1-cost", type: "product_cost", amountCop: -5000, supplierId: "sup-1", supplierName: "Proveedor Uno" }),
        entry({ id: "we-1-pay", ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 9000 })
      ]
    };
    const position = calculatePlatformPosition(state);
    expect(position.profitCop).toBe(3000);
    expect(position.withheldForSuppliersCop).toBe(5000);
    expect(position.withheldBySupplier).toEqual([{ supplierId: "sup-1", supplierName: "Proveedor Uno", amountCop: 5000 }]);
  });

  it("incluye en el por cobrar el COD de pedidos que aun no entran a ningun corte", () => {
    const state: AppState = {
      ...seedState(),
      orders: [], settlements: [],
      wallet: [
        entry({ id: "we-2-cod", orderId: "ord-sin-corte", type: "cod_revenue", amountCop: 100000 }),
        entry({ id: "we-2-pay", orderId: "ord-sin-corte", ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 9000 })
      ]
    };
    const position = calculatePlatformPosition(state);
    expect(position.driverCodOutsideSettlementsCop).toBe(91000);
    expect(position.driverReceivableCop).toBe(91000);
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

describe("selectOpenWalletEntries", () => {
  const entry = (overrides: Partial<WalletEntry>): WalletEntry => ({
    id: "we-1",
    ownerType: "seller",
    ownerId: "seller-1",
    orderId: "order-1",
    type: "delivery_fee",
    amountCop: -9000,
    description: "Flete",
    createdAt: "2026-05-30T10:00:00.000Z",
    ...overrides
  });

  it("incluye lo pendiente por antiguo que sea: el rango de fechas no aplica aqui", () => {
    const viejo = entry({ id: "we-viejo", createdAt: "2026-05-30T10:00:00.000Z", settlementId: "" });
    const reciente = entry({ id: "we-reciente", createdAt: "2026-08-21T10:00:00.000Z", settlementId: "" });
    expect(selectOpenWalletEntries([viejo, reciente]).map((item) => item.id)).toEqual(["we-viejo", "we-reciente"]);
  });

  it("trata el campo ausente igual que el vacio", () => {
    const sinCampo = entry({ id: "we-sin-campo" });
    expect(selectOpenWalletEntries([sinCampo])).toHaveLength(1);
  });

  it("deja fuera lo ya liquidado", () => {
    const liquidado = entry({ id: "we-liquidado", settlementId: "stl-1" });
    expect(selectOpenWalletEntries([liquidado])).toEqual([]);
  });

  it("mantiene el costo de producto que sigue pendiente con el proveedor aunque ya se liquido con la tienda", () => {
    // Caso real: 1.441 asientos en produccion. Si se derivara del `settlementId` de la tienda,
    // el proveedor dejaria de aparecer como pendiente de cobro.
    const pendienteProveedor = entry({
      id: "we-costo",
      type: "product_cost",
      settlementId: "stl-tienda-1",
      supplierSettlementId: ""
    });
    expect(selectOpenWalletEntries([pendienteProveedor]).map((item) => item.id)).toEqual(["we-costo"]);
  });

  it("deja fuera el costo de producto ya pagado por ambos lados", () => {
    const cerrado = entry({
      id: "we-costo-cerrado",
      type: "product_cost",
      settlementId: "stl-tienda-1",
      supplierSettlementId: "stl-prov-1"
    });
    expect(selectOpenWalletEntries([cerrado])).toEqual([]);
  });
});

describe("sellerAbonoRows", () => {
  const abono = (overrides: Partial<WalletEntry>): WalletEntry => ({
    id: "we-abono-1",
    ownerType: "seller",
    ownerId: "seller-1",
    orderId: "",
    type: "seller_abono",
    amountCop: -50_000,
    description: "Abono a tienda Kovia",
    createdAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  });

  it("lista cada abono en orden, con el monto en positivo", () => {
    const filas = sellerAbonoRows([
      abono({ id: "we-b", amountCop: -120_000, createdAt: "2026-08-22T09:00:00.000Z" }),
      abono({ id: "we-a", amountCop: -50_000, createdAt: "2026-08-20T12:00:00.000Z" })
    ]);
    expect(filas.map((fila) => fila.id)).toEqual(["we-a", "we-b"]);
    expect(filas.map((fila) => fila.amountCop)).toEqual([50_000, 120_000]);
  });

  it("recorta el prefijo y deja solo la nota", () => {
    const [fila] = sellerAbonoRows([abono({ description: "Abono a tienda Kovia: nequi Martha agosto 18" })]);
    expect(fila.note).toBe("nequi Martha agosto 18");
  });

  it("devuelve nota vacia cuando el abono se registro sin nota", () => {
    const [fila] = sellerAbonoRows([abono({ description: "Abono a tienda Kovia" })]);
    expect(fila.note).toBe("");
  });

  it("conserva los dos puntos que vengan DENTRO de la nota", () => {
    // El nombre de la tienda y la nota son texto libre: recortar por el primer separador y
    // devolver el resto entero, no partir por cada ":".
    const [fila] = sellerAbonoRows([abono({ description: "Abono a tienda Kovia: transferencia 10:30 am" })]);
    expect(fila.note).toBe("transferencia 10:30 am");
  });

  it("ignora los asientos que no son abonos, como el 4x1000 hermano", () => {
    const filas = sellerAbonoRows([
      abono({ id: "we-abono" }),
      abono({ id: "we-abono-gmf", type: "gmf_tax", amountCop: -200, description: "4x1000 del abono a Kovia" })
    ]);
    expect(filas.map((fila) => fila.id)).toEqual(["we-abono"]);
  });
});

describe("summarizeWalletPeriod", () => {
  const walletEntry = (overrides: Partial<WalletEntry>): WalletEntry => ({
    id: `we-${Math.random()}`,
    ownerType: "seller",
    ownerId: "seller-1",
    orderId: "order-1",
    type: "delivery_fee",
    amountCop: -9000,
    description: "Flete entregado",
    createdAt: "2026-05-30T10:00:00.000Z",
    ...overrides
  });

  const periodo = [
    walletEntry({ orderId: "o-1", type: "cod_revenue", amountCop: 120000, description: "Recaudo COD" }),
    walletEntry({ orderId: "o-1", type: "delivery_fee", amountCop: -9000, description: "Flete entregado" }),
    walletEntry({ orderId: "o-1", type: "driver_earning", amountCop: 6000, ownerType: "driver", ownerId: "driver-1", description: "Pago transportista entregado" }),
    walletEntry({ orderId: "o-2", type: "failed_fee", amountCop: -12000, description: "Cobro fallido" }),
    walletEntry({ orderId: "o-2", type: "driver_earning", amountCop: 3000, ownerType: "driver", ownerId: "driver-1", description: "Pago transportista fallido" })
  ];

  it("calcula el periodo sin necesitar los pedidos cargados", () => {
    // Esta es la regresion que rompio "Ver todo": el resumen se derivaba de state.orders, que
    // ahora se descarga por ventana, y el margen operativo caia de $4.217.500 a $1.488.000.
    const sinPedidos = summarizeWalletPeriod(periodo, new Map());
    expect(sinPedidos.codCop).toBe(120000);
    expect(sinPedidos.sellerFeesCop).toBe(21000);
    expect(sinPedidos.driverPayCop).toBe(9000);
    expect(sinPedidos.platformMarginCop).toBe(12000);
  });

  it("da el mismo dinero con y sin los pedidos en memoria", () => {
    const ordersById = new Map<string, Order>([
      ["o-1", { id: "o-1", status: "delivered" } as Order],
      ["o-2", { id: "o-2", status: "failed" } as Order]
    ]);
    const conPedidos = summarizeWalletPeriod(periodo, ordersById);
    const sinPedidos = summarizeWalletPeriod(periodo, new Map());
    expect(conPedidos.codCop).toBe(sinPedidos.codCop);
    expect(conPedidos.sellerFeesCop).toBe(sinPedidos.sellerFeesCop);
    expect(conPedidos.driverPayCop).toBe(sinPedidos.driverPayCop);
    expect(conPedidos.platformMarginCop).toBe(sinPedidos.platformMarginCop);
  });

  it("separa el pago por entregas del pago por fallidos", () => {
    const resumen = summarizeWalletPeriod(periodo, new Map());
    expect(resumen.deliveredPayCop).toBe(6000);
    expect(resumen.failedPayCop).toBe(3000);
    expect(resumen.deliveryFeeCop).toBe(9000);
    expect(resumen.failedFeeCop).toBe(12000);
  });

  it("cuenta entregados y fallidos por estado del pedido, y si no esta cargado los deduce del asiento", () => {
    const ordersById = new Map<string, Order>([["o-1", { id: "o-1", status: "delivered" } as Order]]);
    const resumen = summarizeWalletPeriod(periodo, ordersById);
    expect(resumen.deliveredOrders).toBe(1);
    expect(resumen.failedOrders).toBe(1);
  });

  it("recorta el cobro por pedido antes de sumar: una nota de credito no compensa otro pedido", () => {
    const conNotaCredito = [
      walletEntry({ orderId: "o-1", type: "delivery_fee", amountCop: -9000 }),
      // reversa que deja el pedido o-2 en positivo; no puede restarle al cobro de o-1
      walletEntry({ orderId: "o-2", type: "delivery_fee", amountCop: 5000 })
    ];
    expect(summarizeWalletPeriod(conNotaCredito, new Map()).sellerFeesCop).toBe(9000);
  });

  it("ignora los asientos sin pedido, como los abonos a tienda", () => {
    const conAbono = [...periodo, walletEntry({ orderId: "", type: "seller_abono", amountCop: -50000, description: "Abono" })];
    expect(summarizeWalletPeriod(conAbono, new Map()).sellerFeesCop).toBe(21000);
  });
});

describe("driverCashReceiptRows", () => {
  const corte = (overrides: Record<string, unknown> = {}) => ({
    id: "stl-1",
    kind: "driver" as const,
    ownerId: "driver-1",
    ownerName: "Lider",
    startDate: "2026-08-18",
    endDate: "2026-08-20",
    walletEntryIds: [],
    orderIds: [],
    codCop: 0,
    feesCop: 0,
    driverPayCop: 0,
    platformMarginCop: 0,
    netCop: 0,
    status: "reconciled" as const,
    createdAt: "2026-08-20T10:00:00.000Z",
    ...overrides
  });

  it("lista cada abono con su nota, no solo el ultimo", () => {
    // 20 de los 26 cortes en produccion tienen mas de un abono, y la nota del corte solo conserva
    // la del ultimo porque recordDriverCashReceipt la sobreescribe.
    const rows = driverCashReceiptRows(corte({
      cashReceipts: [
        { id: "r1", amountCop: 4735000, receivedAt: "2026-08-20T12:00:00.000Z", note: "abono recaudo efectivo agosto 19" },
        { id: "r2", amountCop: 464300, receivedAt: "2026-08-20T15:00:00.000Z", note: "abono recaudo nequi Martha agosto 18" }
      ]
    }) as never, 6000000, 5199300);
    expect(rows.map((row) => row.note)).toEqual([
      "abono recaudo efectivo agosto 19",
      "abono recaudo nequi Martha agosto 18"
    ]);
  });

  it("lleva el saldo corriente, no repite el pendiente final", () => {
    const rows = driverCashReceiptRows(corte({
      cashReceipts: [
        { id: "r1", amountCop: 400000, receivedAt: "2026-08-20T12:00:00.000Z" },
        { id: "r2", amountCop: 300000, receivedAt: "2026-08-20T15:00:00.000Z" }
      ]
    }) as never, 1000000, 700000);
    expect(rows.map((row) => row.pendingAfterCop)).toEqual([600000, 300000]);
  });

  it("nunca deja el pendiente en negativo si se entrego de mas", () => {
    const rows = driverCashReceiptRows(corte({
      cashReceipts: [{ id: "r1", amountCop: 1200000, receivedAt: "2026-08-20T12:00:00.000Z" }]
    }) as never, 1000000, 1200000);
    expect(rows[0].pendingAfterCop).toBe(0);
  });

  it("devuelve una fila sintetica para cortes viejos que solo guardaron el total", () => {
    const rows = driverCashReceiptRows(corte({ paidAt: "2026-08-21T10:00:00.000Z" }) as never, 900000, 900000);
    expect(rows).toHaveLength(1);
    expect(rows[0].synthetic).toBe(true);
    expect(rows[0].amountCop).toBe(900000);
  });

  it("no inventa filas cuando no se recibio nada", () => {
    expect(driverCashReceiptRows(corte() as never, 900000, 0)).toEqual([]);
  });
});
