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

/**
 * T28 · RNF_01 — cuantos documentos baja el navegador del lider segun el volumen.
 *
 * La spec pide comparar la cuenta con 100 y con 10.000 pedidos en el periodo y que sea la MISMA.
 * No hace falta produccion para medirlo: los asientos son deterministas y `buildWalletEntries` es
 * puro, asi que se puede contar exactamente lo que devolveria la consulta del rol.
 *
 * El filtro que se reproduce aqui es, literalmente, el de `subscribeFirestoreState`:
 *   where("ownerType", "==", "community_leader"), where("ownerId", "==", <comunidad>)
 * sin ventana de fecha, sin limite y —a diferencia del rol `seller`— sin `settlementId == ""`.
 */
const LEADER_ID = "com-1";

/** Lo que devolveria la consulta de wallet del lider sobre un periodo de `n` pedidos. */
function leaderWalletDocs(n: number): number {
  let docs = 0;
  for (let i = 0; i < n; i += 1) {
    // Mezcla deliberadamente conservadora: 8 de cada 10 entregados, 2 fallidos cobrables.
    // Cuantos menos asientos por pedido, mas favorable es la cuenta al codigo actual.
    const status = i % 10 < 8 ? "delivered" : "failed";
    const entries = buildWalletEntries(
      order({ id: `ord-${i}`, status, failedCategory: status === "failed" ? "failed_visit" : undefined, communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    docs += entries.filter((e) => e.ownerType === "community_leader" && e.ownerId === LEADER_ID).length;
  }
  return docs;
}

describe("T28 · RNF_01: la carga del lider frente al volumen", () => {
  it("RNF_01: mide la cuenta de documentos con 100 y con 10.000 pedidos", () => {
    const con100 = leaderWalletDocs(100);
    const con10k = leaderWalletDocs(10_000);

    // Cifras medidas, no estimadas. Se fijan para que cualquier arreglo las mueva a la vista.
    expect(con100).toBe(100);
    expect(con10k).toBe(10_000);

    /**
     * ESTO ES EL INCUMPLIMIENTO DE RNF_01, no una curiosidad.
     *
     * El comentario de `subscribeFirestoreState` promete "CERO pedidos" y es cierto: el lider no
     * consulta `orders`. Pero baja UN asiento de cashback POR PEDIDO, asi que la cuenta crece
     * uno a uno con el volumen igual que si los bajara. Es la misma deuda que ya tiene el admin
     * con `walletEntries` (3,58 MB, el 68% de su carga) y que docs/rendimiento.md llama
     * "la proxima deuda".
     *
     * Cuando se acote la suscripcion, esta prueba se pone en rojo y hay que reescribirla con la
     * cuenta nueva. Ese es exactamente su trabajo.
     */
    expect(con10k).toBe(con100 * 100);
    expect(con10k).not.toBe(con100); // RNF_01 exige que fueran iguales.
  });

  it("RNF_01: el filtro por corte que usa la tienda reduciria la cuenta, pero no la acota", () => {
    // `seller` filtra `settlementId == ""`; `community_leader` no. Aun anadiendolo, todo asiento
    // nace sin liquidar, asi que dentro de un periodo abierto la cuenta es la misma.
    const abiertos = (n: number) => {
      let docs = 0;
      for (let i = 0; i < n; i += 1) {
        const entries = buildWalletEntries(order({ id: `ord-${i}`, communityPricing: frozen() }), TARIFFS, NOW);
        docs += entries.filter(
          (e) => e.ownerType === "community_leader" && e.ownerId === LEADER_ID && e.settlementId === ""
        ).length;
      }
      return docs;
    };
    expect(abiertos(100)).toBe(100);
    expect(abiertos(10_000)).toBe(10_000);
  });
});
