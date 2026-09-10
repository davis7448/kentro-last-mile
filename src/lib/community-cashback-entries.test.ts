import { describe, expect, it } from "vitest";
import { buildWalletEntries } from "../../functions/src/wallet-entries";
import type { OrderCommunityPricing } from "./types";

const NOW = "2026-09-10T12:00:00.000Z";
const TARIFFS = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 9000
};

const frozen = (over: Partial<OrderCommunityPricing> = {}): OrderCommunityPricing => ({
  communityId: "com-1",
  frozenAt: "2026-09-01T00:00:00.000Z",
  sellerDeliveredFeeCop: 15000,
  baseDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 14000,
  baseFailedFeeCop: 12000,
  fulfillmentFeeCop: 2500,
  baseFulfillmentFeeCop: 2000,
  ...over
});

function order(over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    shopifyOrderId: "KNT001",
    sellerId: "seller-x",
    driverId: "driver-1",
    status: "delivered",
    paymentMethod: "cod",
    fulfillmentMode: "seller",
    totalCop: 100000,
    evidence: [],
    ...over
  };
}

const find = (entries: ReturnType<typeof buildWalletEntries>, id: string) => entries.find((e) => e.id === id);
const cashbacks = (entries: ReturnType<typeof buildWalletEntries>) =>
  entries.filter((e) => e.type === "community_cashback");

describe("T6 · asiento de cashback", () => {
  it("RF_22: un pedido entregado cobra el precio congelado, no la tarifa viva", () => {
    const entries = buildWalletEntries(order({ communityPricing: frozen() }), TARIFFS, NOW);
    expect(find(entries, "we-ord-1-seller-delivery-fee")?.amountCop).toBe(-15000);
  });

  it("RF_22: causa el cashback del lider como final menos base", () => {
    const entries = buildWalletEntries(order({ communityPricing: frozen() }), TARIFFS, NOW);
    const entry = find(entries, "we-ord-1-community-cashback-delivered");
    expect(entry?.ownerType).toBe("community_leader");
    expect(entry?.ownerId).toBe("com-1");
    expect(entry?.amountCop).toBe(3000);
    expect(entry?.createdAt).toBe(NOW);
  });

  it("RF_22: el flete de fallido congelado NO lo pisa la linea de los 12.000", () => {
    // Esta prueba existe por wallet-entries.ts:156, que fija sellerFailedFeeCop despues del
    // spread y ya anulo en silencio un cambio de tarifa en ago-2026.
    const entries = buildWalletEntries(
      order({ status: "failed", failedCategory: "failed_visit", communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    expect(find(entries, "we-ord-1-seller-failed-fee")?.amountCop).toBe(-14000);
    expect(find(entries, "we-ord-1-community-cashback-failed")?.amountCop).toBe(2000);
  });

  it("RF_22: el manejo desde bodega tambien genera cashback", () => {
    const entries = buildWalletEntries(
      order({ fulfillmentMode: "warehouse", communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    expect(find(entries, "we-ord-1-fulfillment-fee")?.amountCop).toBe(-2500);
    expect(find(entries, "we-ord-1-community-cashback-fulfillment")?.amountCop).toBe(500);
  });

  it("RF_23: un cashback de cero no emite asiento", () => {
    const sinMargen = frozen({ sellerDeliveredFeeCop: 12000, fulfillmentFeeCop: 2000, sellerFailedFeeCop: 12000 });
    const entries = buildWalletEntries(order({ communityPricing: sinMargen }), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(0);
  });

  it("RF_23: un pedido anulado no causa cashback", () => {
    const entries = buildWalletEntries(order({ status: "cancelled", communityPricing: frozen() }), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(0);
  });

  it("RF_23: un fallido no cobrable no causa cashback", () => {
    const entries = buildWalletEntries(
      order({ status: "failed", failedCategory: "no_coverage", communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    expect(cashbacks(entries)).toHaveLength(0);
  });

  it("RNF_02: un pedido SIN comunidad produce exactamente los mismos asientos que antes", () => {
    // La garantia de que esta funcionalidad no mueve el dinero que ya existe.
    const entries = buildWalletEntries(order(), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(0);
    expect(find(entries, "we-ord-1-seller-delivery-fee")?.amountCop).toBe(-12000);
    expect(find(entries, "we-ord-1-cod")?.amountCop).toBe(100000);
    expect(find(entries, "we-ord-1-driver-delivery-pay")?.amountCop).toBe(9000);
  });
});
