import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isOrderOnTheStreet, retentionForOrder, type RetentionOrder } from "../../functions/src/seller-retention";
import { buildWalletEntries, resolveTariffs } from "../../functions/src/wallet-entries";

/**
 * Spec 018 · T2. Cuanto retiene un pedido abierto y cuales estan "en la calle".
 * La retencion tiene que ser EXACTAMENTE lo que el cierre cobraria si el pedido fallara ahora
 * (RF_07, RNF_02): las pruebas de igualdad construyen el pedido cerrado y le preguntan a
 * `buildWalletEntries`, que es la unica fuente de verdad del dinero de un pedido.
 */

const NOW = "2026-09-16T12:00:00.000Z";
const DANDA = "seller-1779315416119";
const TARIFFS = resolveTariffs({}, undefined);

function order(over: Partial<RetentionOrder> = {}): RetentionOrder {
  return {
    id: "ord-1",
    sellerId: "seller-x",
    status: "picked_up",
    pickedUpAt: "2026-09-15T10:00:00.000Z",
    fulfillmentMode: "seller",
    driverId: "driver-1",
    shopifyOrderId: "KNT001",
    evidence: [],
    ...over
  };
}

/** Lo que el cierre REAL cobra a la tienda si este pedido falla ahora en visita cobrable. */
function chargedIfFailedNow(input: RetentionOrder) {
  const closed = {
    ...input,
    status: "failed",
    failedCategory: "failed_visit",
    evidence: [...(input.evidence ?? []), { type: "failed", failedCategory: "failed_visit" }]
  };
  return 0 - buildWalletEntries(closed, TARIFFS, NOW, [])
    .filter((entry) => entry.ownerType === "seller" && (entry.type === "failed_fee" || entry.type === "fulfillment_fee"))
    .reduce((sum, entry) => sum + Number(entry.amountCop), 0);
}

const communityPricing = {
  communityId: "com-1",
  frozenAt: "2026-09-01T00:00:00.000Z",
  pricingVersion: 2 as const,
  leaderFailedFeeCop: 15000,
  sellerDeliveredFeeCop: 12000,
  baseDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 15000,
  baseFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  baseFulfillmentFeeCop: 2000
};

describe("spec 018 · RF_09 / RF_10 / RF_11 · que pedidos estan en la calle", () => {
  it("RF_09: recogido y en ruta retienen", () => {
    expect(isOrderOnTheStreet(order({ status: "picked_up" }))).toBe(true);
    expect(isOrderOnTheStreet(order({ status: "in_route" }))).toBe(true);
  });

  it("RF_09: recogido y en ruta retienen aunque falte la marca de recogida", () => {
    expect(isOrderOnTheStreet(order({ status: "in_route", pickedUpAt: undefined }))).toBe(true);
  });

  it("RF_09: un reabierto y reasignado que ya fue recogido sigue reteniendo", () => {
    for (const status of ["ready_to_assign", "assigned", "pickup_pending", "call_pending", "scheduled", "retry_pending"]) {
      expect(isOrderOnTheStreet(order({ status })), status).toBe(true);
    }
  });

  it("RF_10: sin haber sido recogido nunca, no retiene", () => {
    for (const status of ["imported", "address_risk", "ready_to_assign", "assigned", "call_pending", "scheduled", "pickup_pending", "retry_pending"]) {
      expect(isOrderOnTheStreet(order({ status, pickedUpAt: undefined })), status).toBe(false);
    }
  });

  it("RF_10: una marca de recogida vacia cuenta como no recogido", () => {
    expect(isOrderOnTheStreet(order({ status: "ready_to_assign", pickedUpAt: "" }))).toBe(false);
  });

  it("RF_11: un pedido cerrado deja de retener", () => {
    for (const status of ["delivered", "failed", "cancelled", "liquidated"]) {
      expect(isOrderOnTheStreet(order({ status })), status).toBe(false);
    }
  });
});

describe("spec 018 · RF_06 / RF_07 / RNF_02 · cuanto retiene", () => {
  it("tienda general: el fijo de fallido, igual al cobro real", () => {
    const input = order();
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(12000);
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(chargedIfFailedNow(input));
  });

  it("el fijo gana a la tarifa de la zona, como en el cierre", () => {
    const zoneTariffs = resolveTariffs({}, { sellerFailedFeeCop: 7000 });
    expect(retentionForOrder(order(), zoneTariffs, NOW)).toBe(12000);
  });

  it("DANDA: no se le cobra fallido, asi que no retiene", () => {
    const input = order({ sellerId: DANDA });
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(0);
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(chargedIfFailedNow(input));
  });

  it("comunidad: el precio congelado del lider cuando supera la base", () => {
    const input = order({ communityPricing });
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(15000);
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(chargedIfFailedNow(input));
  });

  it("comunidad: si el lider esta por debajo de la base, manda la base", () => {
    const input = order({ communityPricing: { ...communityPricing, leaderFailedFeeCop: 9000 } });
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(12000);
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(chargedIfFailedNow(input));
  });

  it("bodega, primera visita: fallido + manejo", () => {
    const input = order({ fulfillmentMode: "warehouse" });
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(14000);
    expect(retentionForOrder(input, TARIFFS, NOW)).toBe(chargedIfFailedNow(input));
  });

  it("bodega con el manejo ya cobrado: solo el fallido de la siguiente visita", () => {
    const input = order({ fulfillmentMode: "warehouse", status: "retry_pending" });
    expect(retentionForOrder(input, TARIFFS, NOW, { fulfillmentAlreadyCharged: true })).toBe(12000);
  });

  it("un pedido que no esta en la calle no retiene nada", () => {
    expect(retentionForOrder(order({ status: "ready_to_assign", pickedUpAt: undefined }), TARIFFS, NOW)).toBe(0);
    expect(retentionForOrder(order({ status: "delivered" }), TARIFFS, NOW)).toBe(0);
  });

  it("RF_07: el modulo no tiene un valor fijo propio ni una copia de la tarifa", () => {
    const source = readFileSync(fileURLToPath(new URL("../../functions/src/seller-retention.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b\d{1,3}[._]?000\b/);
    expect(code).not.toMatch(/pendingReserveCop|SELLER_FAILED_FEE_FIXED_COP|dandaSellerIds/);
    expect(code).toMatch(/buildWalletEntries\(/);
  });
});
