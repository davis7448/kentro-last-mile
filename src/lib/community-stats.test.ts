import { describe, expect, it } from "vitest";
import {
  buildCommunityStats,
  dateAxisLabel,
  deliveryRate,
  splitActiveStores,
  type RawCommunityAggregates
} from "../../functions/src/community-stats-math";

const raw: RawCommunityAggregates = {
  storeCount: 3,
  createdByStore: { "seller-1": 10, "seller-2": 4, "seller-3": 0 },
  dispatchedByStore: { "seller-1": 9, "seller-2": 3, "seller-3": 0 },
  deliveredByStore: { "seller-1": 7, "seller-2": 2, "seller-3": 0 },
  failedByStore: { "seller-1": 1, "seller-2": 1, "seller-3": 0 },
  cashbackAccruedCop: 21000,
  cashbackPaidCop: 9000,
  ordersWithoutCashbackByZoneFloor: 2
};

describe("T20 · aritmetica del panel del lider", () => {
  it("RF_48: el porcentaje de entrega excluye los abiertos y viaja con su denominador", () => {
    // 9 entregados sobre 11 cerrados (9 entregados + 2 fallidos). Los 14 creados NO son el
    // denominador: mezclar creados con cerrados es la trampa de ejes que ya mordio aqui.
    const rate = deliveryRate({ delivered: 9, failed: 2 });
    expect(rate.denominator).toBe(11);
    expect(rate.percent).toBeCloseTo(81.8, 1);
  });

  it("RF_48: sin pedidos cerrados no se inventa un porcentaje", () => {
    const rate = deliveryRate({ delivered: 0, failed: 0 });
    expect(rate.denominator).toBe(0);
    expect(rate.percent).toBeNull();
  });

  it("RF_47: activa es la tienda con al menos un pedido creado en el periodo", () => {
    const split = splitActiveStores(raw.createdByStore);
    expect(split.active).toEqual(["seller-1", "seller-2"]);
    expect(split.inactive).toEqual(["seller-3"]);
  });

  it("RF_46: cada bloque declara por que fecha agrupa", () => {
    expect(dateAxisLabel("created")).toBe("por fecha de creacion");
    expect(dateAxisLabel("dispatched")).toBe("por fecha de despacho");
    expect(dateAxisLabel("closed")).toBe("por fecha de cierre");
  });

  it("RF_29, RF_30: agrega el total y el desglose por tienda", () => {
    const stats = buildCommunityStats(raw);
    expect(stats.totals.created).toBe(14);
    expect(stats.totals.delivered).toBe(9);
    expect(stats.totals.failed).toBe(2);
    expect(stats.totals.activeStores).toBe(2);
    expect(stats.totals.inactiveStores).toBe(1);
    expect(stats.totals.cashbackAccruedCop).toBe(21000);
    expect(stats.totals.cashbackPendingCop).toBe(12000);
    expect(stats.byStore).toHaveLength(3);
    const first = stats.byStore.find((s) => s.sellerId === "seller-1")!;
    expect(first.created).toBe(10);
    expect(first.delivered).toBe(7);
    expect(first.deliveryRate.denominator).toBe(8);
  });

  it("RF_33: distingue cero real de sin datos", () => {
    const sinTiendas = buildCommunityStats({ ...raw, storeCount: 0, createdByStore: {}, dispatchedByStore: {}, deliveredByStore: {}, failedByStore: {}, cashbackAccruedCop: 0, cashbackPaidCop: 0 });
    expect(sinTiendas.emptiness).toBe("no_stores");

    const sinPedidos = buildCommunityStats({ ...raw, createdByStore: { "seller-1": 0 }, dispatchedByStore: {}, deliveredByStore: {}, failedByStore: {}, cashbackAccruedCop: 0, cashbackPaidCop: 0 });
    expect(sinPedidos.emptiness).toBe("no_orders_in_period");

    expect(buildCommunityStats(raw).emptiness).toBeNull();
  });

  it("RF_29: el markup que se comio el piso de zona se cuenta y no se esconde", () => {
    expect(buildCommunityStats(raw).totals.ordersWithoutCashbackByZoneFloor).toBe(2);
  });
});
