import { describe, expect, it } from "vitest";
// La logica vive en el backend (unica fuente de verdad para la elegibilidad de pago). Se importa
// desde functions/ en vez de duplicarla aqui: es la cifra que se le paga a una tienda y ya estaba
// triplicada entre la UI, store-api.ts y createSettlement.
import { computeSellerBalance } from "../../functions/src/seller-balance";
import { buildCodReceivedSet, isSellerEntryEligible, isWithinSettlementRange } from "../../functions/src/seller-ledger";

const orders = new Map<string, Record<string, unknown>>([
  ["o-prepago", { paymentMethod: "prepaid", status: "delivered" }],
  ["o-cod-cobrado", { paymentMethod: "cod", status: "delivered" }],
  ["o-cod-pendiente", { paymentMethod: "cod", status: "delivered" }],
  ["o-fallido", { paymentMethod: "cod", status: "failed" }]
]);

describe("buildCodReceivedSet", () => {
  it("toma cashAllocations como fuente autoritativa y solo cuenta las cubiertas", () => {
    const set = buildCodReceivedSet([
      { kind: "driver", cashAllocations: [{ orderId: "o-1", covered: true }, { orderId: "o-2", covered: false }] }
    ]);
    expect(set.has("o-1")).toBe(true);
    expect(set.has("o-2")).toBe(false);
  });

  it("cae al estado del corte cuando no hay cashAllocations", () => {
    const set = buildCodReceivedSet([{ kind: "driver", status: "paid", orderIds: ["o-3"] }]);
    expect(set.has("o-3")).toBe(true);
  });

  it("spec 018 RF_04: un corte pendiente sin asignaciones NO cuenta aunque su cashPendingCop sea 0 (regla del corte)", () => {
    const set = buildCodReceivedSet([{ kind: "driver", status: "pending", cashPendingCop: 0, orderIds: ["o-5"] }]);
    expect(set.has("o-5")).toBe(false);
  });

  it("spec 018 RF_04: el corte conciliado sin asignaciones si cuenta", () => {
    const set = buildCodReceivedSet([{ kind: "driver", status: "reconciled", orderIds: ["o-6"] }]);
    expect(set.has("o-6")).toBe(true);
  });

  it("spec 018 RF_04: una asignacion cubierta sin orderId se ignora", () => {
    const set = buildCodReceivedSet([{ kind: "driver", cashAllocations: [{ covered: true }, { orderId: "o-7", covered: true }] }]);
    expect([...set]).toEqual(["o-7"]);
  });

  it("spec 018 RF_03: abonos, 4x1000 y restituciones siguen siendo pagables sin pedido", () => {
    for (const entry of [
      { type: "seller_abono", amountCop: -50_000 },
      { type: "gmf_tax", amountCop: -200 },
      { type: "seller_abono", amountCop: 30_000 }
    ]) {
      expect(isSellerEntryEligible(entry, orders, new Set())).toBe(true);
    }
  });

  it("ignora los cortes que no son de domiciliario", () => {
    const set = buildCodReceivedSet([{ kind: "seller", status: "paid", orderIds: ["o-4"] }]);
    expect(set.size).toBe(0);
  });
});

// `summarizeSellerPayable` se retiro en la spec 018: su reparto vive ahora en `computeSellerBalance`
// (seller-balance.ts), que ademas aplica la retencion. Se conserva el caso auditado de OnStok.
describe("spec 018 · computeSellerBalance conserva el reparto auditado de OnStok (19-ago-2026)", () => {
  it("2.180.800 sin liquidar = 2.108.900 liquidables + 71.900 con el domiciliario", () => {
    const balance = computeSellerBalance({
      openEntries: [
        { id: "e-1", type: "cod_revenue", orderId: "o-prepago", amountCop: 2_108_900 },
        { id: "e-2", type: "cod_revenue", orderId: "o-cod-pendiente", amountCop: 71_900 }
      ],
      ordersById: orders,
      streetCandidates: [],
      codReceived: new Set(["o-cod-cobrado"]),
      chargedFulfillmentOrderIds: new Set(),
      settings: {},
      zonesById: new Map(),
      now: "2026-08-19T12:00:00.000Z"
    });
    expect(balance.availableCop).toBe(2_108_900);
    expect(balance.codPendingCop).toBe(71_900);
    expect(balance.totalUnsettledCop).toBe(2_180_800);
  });
});

describe("isWithinSettlementRange", () => {
  it("con rango abierto toma todo lo pendiente, por antiguo que sea", () => {
    // El movimiento pendiente mas antiguo en produccion es de 2026-05-30 y la pantalla venia con
    // un rango por defecto de 7 dias, asi que ni se veia ni entraba al corte.
    expect(isWithinSettlementRange("2026-05-30", "", "")).toBe(true);
    expect(isWithinSettlementRange("2026-08-21", "", "")).toBe(true);
  });

  it("con solo un extremo abierto acota por el otro", () => {
    expect(isWithinSettlementRange("2026-05-30", "", "2026-06-30")).toBe(true);
    expect(isWithinSettlementRange("2026-07-01", "", "2026-06-30")).toBe(false);
    expect(isWithinSettlementRange("2026-07-01", "2026-06-30", "")).toBe(true);
    expect(isWithinSettlementRange("2026-05-30", "2026-06-30", "")).toBe(false);
  });

  it("conserva el filtro cuando el llamante manda las dos fechas", () => {
    expect(isWithinSettlementRange("2026-06-15", "2026-06-01", "2026-06-30")).toBe(true);
    expect(isWithinSettlementRange("2026-05-31", "2026-06-01", "2026-06-30")).toBe(false);
    expect(isWithinSettlementRange("2026-07-01", "2026-06-01", "2026-06-30")).toBe(false);
  });
});

describe("consecuencia de revertir un pedido entregado a fallido", () => {
  // Contraintuitivo pero correcto: al dejar de ser "delivered", el pedido ya no espera COD,
  // asi que la reversa Y el recaudo original sin liquidar se vuelven elegibles a la vez y
  // netean en el mismo corte. Es lo que hace que un clawback no deje saldo colgado.
  it("libera de golpe el recaudo original y su reversa", () => {
    const revertido = new Map<string, Record<string, unknown>>([["o-revertido", { paymentMethod: "cod", status: "failed" }]]);
    const codReceived = new Set<string>(); // el COD nunca entro de la flota
    const asientos = [
      { type: "cod_revenue", orderId: "o-revertido", amountCop: 89900 },
      { type: "cod_remittance", orderId: "o-revertido", amountCop: -89900 }
    ];
    for (const asiento of asientos) {
      expect(isSellerEntryEligible(asiento as never, revertido as never, codReceived)).toBe(true);
    }
    // Mientras seguia entregado, ese mismo recaudo estaba retenido esperando el efectivo.
    const entregado = new Map<string, Record<string, unknown>>([["o-revertido", { paymentMethod: "cod", status: "delivered" }]]);
    expect(isSellerEntryEligible(asientos[0] as never, entregado as never, codReceived)).toBe(false);
  });
});
