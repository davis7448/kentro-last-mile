import { describe, expect, it } from "vitest";
import { buildSellerBalanceInput, computeSellerBalance } from "../../functions/src/seller-balance";
import { buildStoreSummary } from "../../functions/src/store-summary";

/**
 * Spec 018 · T8 · RF_25. La API de solo lectura para tiendas devuelve las mismas cifras que la
 * pantalla de la tienda y el cierre del admin, porque las toma del mismo `SellerBalance`.
 */

const NOW = "2026-09-16T12:00:00.000Z";
const SELLER = "seller-x";

const wallet = [
  { id: "e-a1", ownerType: "seller", ownerId: SELLER, orderId: "o-a", type: "cod_revenue", amountCop: 52000, settlementId: "", createdAt: "2026-09-01T00:00:00.000Z" },
  { id: "e-a2", ownerType: "seller", ownerId: SELLER, orderId: "o-a", type: "delivery_fee", amountCop: -12000, settlementId: "", createdAt: "2026-09-01T00:00:00.000Z" },
  { id: "e-b1", ownerType: "seller", ownerId: SELLER, orderId: "o-b", type: "cod_revenue", amountCop: 42000, settlementId: "", createdAt: "2026-09-02T00:00:00.000Z" },
  { id: "e-b2", ownerType: "seller", ownerId: SELLER, orderId: "o-b", type: "delivery_fee", amountCop: -12000, settlementId: "", createdAt: "2026-09-02T00:00:00.000Z" },
  { id: "e-c1", ownerType: "seller", ownerId: SELLER, orderId: "o-c", type: "cod_revenue", amountCop: 62000, settlementId: "", createdAt: "2026-09-03T00:00:00.000Z" },
  { id: "e-abono", ownerType: "seller", ownerId: SELLER, orderId: "", type: "seller_abono", amountCop: -5000, settlementId: "", createdAt: "2026-09-04T00:00:00.000Z" },
  { id: "e-viejo", ownerType: "seller", ownerId: SELLER, orderId: "o-v", type: "cod_revenue", amountCop: 80000, settlementId: "stl-pend", createdAt: "2026-08-01T00:00:00.000Z" },
  { id: "e-pagado", ownerType: "seller", ownerId: SELLER, orderId: "o-p", type: "cod_revenue", amountCop: 90000, settlementId: "stl-paid", createdAt: "2026-07-01T00:00:00.000Z" }
];
const orders = [
  { id: "o-a", sellerId: SELLER, status: "delivered", paymentMethod: "prepaid" },
  { id: "o-b", sellerId: SELLER, status: "delivered", paymentMethod: "prepaid" },
  { id: "o-c", sellerId: SELLER, status: "delivered", paymentMethod: "cod" },
  { id: "o-calle", sellerId: SELLER, status: "in_route", paymentMethod: "cod", pickedUpAt: "2026-09-15T00:00:00.000Z", fulfillmentMode: "seller", evidence: [] }
];
const settlements = [
  { id: "stl-pend", kind: "seller", ownerId: SELLER, status: "pending", netCop: 80000 },
  { id: "stl-paid", kind: "seller", ownerId: SELLER, status: "paid", netCop: 90000, paidAt: "2026-07-05T00:00:00.000Z" }
];

describe("spec 018 · RF_25 · buildStoreSummary", () => {
  const balance = computeSellerBalance(buildSellerBalanceInput({ sellerId: SELLER, wallet, orders, settlements, settings: {}, zones: [], now: NOW }));
  const summary = buildStoreSummary(wallet, new Map(settlements.map((s) => [s.id, s])), balance, settlements);

  it("el disponible de la API es el de computeSellerBalance, al peso", () => {
    expect(balance.availableCop).toBe(40000 - 5000);
    expect(summary.saldoPendiente.disponibleCop).toBe(balance.availableCop);
  });

  it("expone el retenido y el efectivo con el domiciliario con la misma regla", () => {
    expect(summary.saldoPendiente.retenidoCop).toBe(balance.heldCop);
    expect(summary.saldoPendiente.retenidoPedidos).toBe(balance.heldOrderCount);
    expect(summary.saldoPendiente.bloqueadoCodCop).toBe(balance.codPendingCop);
    expect(summary.significado.retenidoCop).toMatch(/pedidos en la calle/);
  });

  it("el total cuadra: disponible + retenido + bloqueado + en liquidacion", () => {
    const p = summary.saldoPendiente;
    expect(p.enLiquidacionCop).toBe(80000);
    expect(p.totalCop).toBe(p.disponibleCop + p.retenidoCop + p.bloqueadoCodCop + p.enLiquidacionCop);
    expect(p.totalCop).toBe(balance.totalUnsettledCop + 80000);
  });

  it("conserva lo liquidado y los pagos", () => {
    expect(summary.totales.liquidadoCop).toBe(90000);
    expect(summary.pagos.some((pago) => pago.tipo === "liquidacion" && pago.montoCop === 90000)).toBe(true);
  });
});
