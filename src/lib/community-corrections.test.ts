import { describe, expect, it } from "vitest";
import { type CorrectionRequest, planOrderCorrection, type PlanInput } from "../../functions/src/order-corrections-plan";
import type { SettlementDoc, WalletEntryDoc } from "../../functions/src/settlement-math";
import type { OrderCommunityPricing } from "./types";

const NOW = "2026-09-10T15:00:00.000Z";
const TARIFFS = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 8000,
  driverFailedPayCop: 8000
};

const FROZEN: OrderCommunityPricing = {
  communityId: "com-1",
  frozenAt: "2026-09-01T00:00:00.000Z",
  sellerDeliveredFeeCop: 15000,
  baseDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  baseFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  baseFulfillmentFeeCop: 2000
};

const deliveredOrder = {
  id: "o1",
  trackingCode: "KNT-000001",
  status: "delivered",
  sellerId: "seller-1",
  driverId: "driver-1",
  shopifyOrderId: "KNT001",
  paymentMethod: "cod",
  fulfillmentMode: "seller",
  totalCop: 100000,
  evidence: [],
  communityId: "com-1",
  communityPricing: FROZEN
};

/** El asiento de cashback que hoy tendria ese pedido entregado. */
function cashbackEntry(settlementId: string): WalletEntryDoc {
  return {
    id: "we-o1-community-cashback-delivered",
    ownerType: "community_leader",
    ownerId: "com-1",
    orderId: "o1",
    type: "community_cashback",
    amountCop: 3000,
    description: "Cashback comunidad entregado KNT001",
    createdAt: "2026-09-02T10:00:00.000Z",
    settlementId
  };
}

function settlement(status: SettlementDoc["status"]): SettlementDoc {
  return {
    id: "set-lider-1",
    kind: "community_leader",
    ownerId: "com-1",
    ownerName: "Comunidad",
    status,
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    walletEntryIds: ["we-o1-community-cashback-delivered"],
    orderIds: ["o1"],
    codCop: 0,
    feesCop: 0,
    driverPayCop: 0,
    platformMarginCop: 3000,
    netCop: 3000,
    createdAt: "2026-09-08T00:00:00.000Z"
  };
}

const request: CorrectionRequest = { kind: "delivered_to_failed", reason: "no estaba", failedCategory: "failed_visit" };

function plan(over: Partial<PlanInput> = {}) {
  const entries = over.entries ?? [];
  return planOrderCorrection({
    entries,
    settlementsById: new Map(),
    cashInputs: {
      sellerEntries: entries.filter((e) => e.ownerType === "seller"),
      driverEntries: entries.filter((e) => e.ownerType === "driver"),
      leaderEntries: entries.filter((e) => e.ownerType === "community_leader"),
      orderMeta: new Map()
    },
    tariffs: TARIFFS,
    productCostLines: [],
    sellerPaysInCash: false,
    driverExists: true,
    actorId: "admin-uid",
    now: NOW,
    request,
    order: deliveredOrder,
    ...over
  });
}

describe("T7 · cashback en las correcciones", () => {
  it("RF_24: si el corte del lider ya se pago, se compensa y no se toca el corte", () => {
    const existing = cashbackEntry("set-lider-1");
    const result = plan({
      entries: [existing],
      settlementsById: new Map([["set-lider-1", settlement("paid")]])
    });

    const reverse = result.entriesToCompensate.find((item) =>
      item.entry.id === "we-o1-correction-reverse-community-cashback-delivered"
    );
    expect(reverse).toBeDefined();
    expect(reverse!.entry.amountCop).toBe(-3000);
    expect(reverse!.entry.ownerType).toBe("community_leader");
    expect(reverse!.entry.ownerId).toBe("com-1");
    // El corte pagado no se reescribe.
    expect(result.entriesToDelete.map((e) => e.id)).not.toContain(existing.id);
    expect(result.settlementsToRecalculate.map((s) => s.id)).not.toContain("set-lider-1");
  });

  it("RF_25: si el corte del lider sigue pendiente, se recalcula en vez de compensarse", () => {
    const existing = cashbackEntry("set-lider-1");
    const result = plan({
      entries: [existing],
      settlementsById: new Map([["set-lider-1", settlement("pending")]])
    });

    expect(result.entriesToCompensate.map((item) => item.entry.id)).not.toContain(
      "we-o1-correction-reverse-community-cashback-delivered"
    );
    expect(result.entriesToDelete.map((e) => e.id)).toContain(existing.id);
    expect(result.settlementsToRecalculate.map((s) => s.id)).toContain("set-lider-1");
  });

  it("RF_25: al recalcular un corte pendiente NO se pierden los cashbacks de los demas pedidos", () => {
    // El caso que importa de verdad: un corte de lider con dos pedidos, se corrige uno.
    // Si el recalculo solo mira asientos de tienda y domiciliario, el otro cashback
    // desaparece del corte y el lider cobra de menos sin que nada avise.
    const corregido = cashbackEntry("set-lider-1");
    const otro: WalletEntryDoc = {
      ...cashbackEntry("set-lider-1"),
      id: "we-o2-community-cashback-delivered",
      orderId: "o2",
      amountCop: 4500
    };
    const corte = { ...settlement("pending"), walletEntryIds: [corregido.id, otro.id], orderIds: ["o1", "o2"], netCop: 7500 };
    // `entries` son los asientos DEL PEDIDO corregido; los del resto del corte van en cashInputs.
    const result = plan({
      entries: [corregido],
      cashInputs: {
        sellerEntries: [],
        driverEntries: [],
        leaderEntries: [corregido, otro],
        orderMeta: new Map()
      },
      settlementsById: new Map([["set-lider-1", corte]])
    });

    const recalculado = result.settlementsToRecalculate.find((s) => s.id === "set-lider-1");
    expect(recalculado).toBeDefined();
    expect(recalculado!.patch.walletEntryIds).toContain(otro.id);
    expect(recalculado!.patch.walletEntryIds).not.toContain(corregido.id);
    expect(recalculado!.patch.orderIds).toContain("o2");
  });

  it("RF_24: un pedido sin comunidad no produce ninguna reversa de cashback", () => {
    const result = plan({ order: { ...deliveredOrder, communityId: undefined, communityPricing: undefined } });
    const cashbacks = [...result.entriesToCreate, ...result.entriesToCompensate.map((i) => i.entry)]
      .filter((e) => e.type === "community_cashback");
    expect(cashbacks).toHaveLength(0);
  });
});
