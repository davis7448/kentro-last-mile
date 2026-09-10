import { describe, expect, it } from "vitest";
import {
  applyScheduledChanges,
  cashbackForFrozenPricing,
  freezeOrderPricing,
  resolveCommunityPricing,
  scheduleEffectiveAt,
  SCHEDULED_RAISE_NOTICE_DAYS
} from "../../functions/src/community-pricing";
import type { Community, CommunityPricingFields } from "./types";

const BASE = { sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000 };
const T0 = "2026-09-01T00:00:00.000Z";
const day = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.parse(T0) + days * day).toISOString();

function community(pricing: CommunityPricingFields = {}, extra: Partial<Community> = {}): Community {
  return {
    id: "com-1", name: "Comunidad", slug: "comunidad",
    leaderName: "Ana", leaderEmail: "ana@x.co", leaderPhone: "3000000000",
    linkStatus: "active", status: "active", pricing,
    createdAt: T0, updatedAt: T0, ...extra
  };
}

describe("T3 · precio vigente y piso", () => {
  it("RF_20: sin precio propio se cobra la base y el cashback es cero", () => {
    const p = resolveCommunityPricing(BASE, community(), T0);
    expect(p.sellerDeliveredFeeCop).toBe(12000);
    expect(cashbackForFrozenPricing(freezeOrderPricing(BASE, community(), T0)!).totalCop).toBe(0);
  });

  it("RF_17, RF_18: con precio propio por encima, se cobra el del lider", () => {
    const p = resolveCommunityPricing(BASE, community({ sellerDeliveredFeeCop: 15000 }), T0);
    expect(p.sellerDeliveredFeeCop).toBe(15000);
  });

  it("RF_35: si la base supera el precio del lider, manda la base", () => {
    const p = resolveCommunityPricing({ ...BASE, sellerDeliveredFeeCop: 14000 }, community({ sellerDeliveredFeeCop: 13000 }), T0);
    expect(p.sellerDeliveredFeeCop).toBe(14000);
  });

  it("RF_36: el cashback nunca es negativo, suba antes la base o el precio", () => {
    const subeBase = freezeOrderPricing({ ...BASE, sellerDeliveredFeeCop: 20000 }, community({ sellerDeliveredFeeCop: 13000 }), T0)!;
    const subePrecio = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 13000 }), T0)!;
    expect(cashbackForFrozenPricing(subeBase).totalCop).toBe(0);
    expect(cashbackForFrozenPricing(subePrecio).totalCop).toBe(1000);
    expect(cashbackForFrozenPricing(subeBase).totalCop).toBeGreaterThanOrEqual(0);
  });

  it("RF_19: el minimo que se le puede exigir a un lider es la base", () => {
    const p = resolveCommunityPricing(BASE, community({ fulfillmentFeeCop: 1 }), T0);
    expect(p.fulfillmentFeeCop).toBe(2000);
  });
});

describe("T4 · cambios programados", () => {
  const conSubida = community({ sellerDeliveredFeeCop: 13000 }, {
    scheduled: {
      sellerDeliveredFeeCop: {
        field: "sellerDeliveredFeeCop", fromCop: 13000, toCop: 16000,
        effectiveAt: at(8), scheduledBy: "uid-lider", scheduledAt: T0
      }
    }
  });

  it("RF_28: una subida espera ocho dias antes de aplicarse", () => {
    expect(SCHEDULED_RAISE_NOTICE_DAYS).toBe(8);
    expect(scheduleEffectiveAt(13000, 16000, T0)).toBe(at(8));
    expect(applyScheduledChanges(conSubida, at(7)).sellerDeliveredFeeCop).toBe(13000);
    expect(applyScheduledChanges(conSubida, at(8)).sellerDeliveredFeeCop).toBe(16000);
    expect(applyScheduledChanges(conSubida, at(9)).sellerDeliveredFeeCop).toBe(16000);
  });

  it("RF_38: una bajada entra de inmediato", () => {
    expect(scheduleEffectiveAt(16000, 13000, T0)).toBe(T0);
  });

  it("RF_54: solo hay una programada por concepto y la segunda reinicia el plazo", () => {
    const segunda = scheduleEffectiveAt(13000, 18000, at(3));
    expect(segunda).toBe(at(11));
  });

  it("RF_40: el precio programado se ve antes de entrar, sin afectar al vigente", () => {
    expect(conSubida.scheduled?.sellerDeliveredFeeCop?.toCop).toBe(16000);
    expect(resolveCommunityPricing(BASE, conSubida, at(7)).sellerDeliveredFeeCop).toBe(13000);
  });
});

describe("T5 · congelado del precio en el pedido", () => {
  it("RF_21: guarda final y base de los tres conceptos", () => {
    const frozen = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 15000 }), T0)!;
    expect(frozen.communityId).toBe("com-1");
    expect(frozen.sellerDeliveredFeeCop).toBe(15000);
    expect(frozen.baseDeliveredFeeCop).toBe(12000);
    expect(frozen.frozenAt).toBe(T0);
  });

  it("RF_37: sin comunidad no se congela nada", () => {
    expect(freezeOrderPricing(BASE, undefined, T0)).toBeUndefined();
  });

  it("RF_21: el cashback se reparte por concepto", () => {
    const frozen = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 15000, fulfillmentFeeCop: 2500 }), T0)!;
    const cashback = cashbackForFrozenPricing(frozen);
    expect(cashback.deliveredCop).toBe(3000);
    expect(cashback.fulfillmentCop).toBe(500);
    expect(cashback.failedCop).toBe(0);
    expect(cashback.totalCop).toBe(3500);
  });
});
