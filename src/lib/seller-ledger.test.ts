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

// ---------------------------------------------------------------------------------------------
// Spec 026 · T4 (RF_01, plan 2.2). Import aparte para no tocar el bloque de imports existente.
// ---------------------------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codPartialReceivedCop } from "../../functions/src/seller-ledger";

describe("T4 · codPartialReceivedCop: efectivo parcial recibido por pedido no recibido", () => {
  it("parcial en un corte: devuelve el receivedCop de la asignacion no cubierta", () => {
    const partial = codPartialReceivedCop([
      {
        kind: "driver",
        status: "paid",
        orderIds: ["o-1", "o-2"],
        cashAllocations: [
          { orderId: "o-1", expectedCop: 100_000, receivedCop: 100_000, covered: true },
          { orderId: "o-2", expectedCop: 80_000, receivedCop: 30_000, covered: false }
        ]
      }
    ]);
    expect(partial).toBeInstanceOf(Map);
    expect(partial.get("o-2")).toBe(30_000);
    expect(partial.has("o-1")).toBe(false);
  });

  it("parcial en dos cortes: suma lo recibido en ambos", () => {
    const partial = codPartialReceivedCop([
      { kind: "driver", status: "paid", orderIds: ["o-2"], cashAllocations: [{ orderId: "o-2", expectedCop: 80_000, receivedCop: 30_000, covered: false }] },
      { kind: "driver", status: "pending", orderIds: ["o-2"], cashAllocations: [{ orderId: "o-2", expectedCop: 80_000, receivedCop: 20_000, covered: false }] }
    ]);
    expect(partial.get("o-2")).toBe(50_000);
  });

  it("parcial en un corte pero cubierto en otro: no aparece (ya es recibido segun buildCodReceivedSet)", () => {
    const settlements = [
      { kind: "driver", status: "paid", orderIds: ["o-2"], cashAllocations: [{ orderId: "o-2", expectedCop: 80_000, receivedCop: 30_000, covered: false }] },
      { kind: "driver", status: "paid", orderIds: ["o-2"], cashAllocations: [{ orderId: "o-2", expectedCop: 80_000, receivedCop: 80_000, covered: true }] }
    ];
    expect(buildCodReceivedSet(settlements).has("o-2")).toBe(true);
    expect(codPartialReceivedCop(settlements).has("o-2")).toBe(false);
  });

  it("corte pagado sin asignaciones: sus pedidos son recibidos y no aparecen como parciales", () => {
    const partial = codPartialReceivedCop([{ kind: "driver", status: "paid", orderIds: ["o-9"], cashReceivedCop: 50_000 }]);
    expect(partial.has("o-9")).toBe(false);
    expect(partial.size).toBe(0);
  });

  it("asignacion no cubierta con receivedCop 0 no aparece; cortes que no son de domiciliario se ignoran", () => {
    const partial = codPartialReceivedCop([
      { kind: "driver", status: "pending", orderIds: ["o-3"], cashAllocations: [{ orderId: "o-3", expectedCop: 50_000, receivedCop: 0, covered: false }] },
      { kind: "seller", status: "paid", orderIds: ["o-4"], cashAllocations: [{ orderId: "o-4", expectedCop: 50_000, receivedCop: 10_000, covered: false }] }
    ]);
    expect(partial.size).toBe(0);
  });

  it("sin cortes -> mapa vacio", () => {
    expect(codPartialReceivedCop([]).size).toBe(0);
  });

  it("reutiliza la regla de recibido: el cuerpo llama a buildCodReceivedSet y no la copia", () => {
    const source = readFileSync(resolve(__dirname, "../../functions/src/seller-ledger.ts"), "utf8");
    const start = source.indexOf("export function codPartialReceivedCop");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextExport = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, nextExport === -1 ? undefined : nextExport);
    expect(body).toMatch(/buildCodReceivedSet\s*\(/);
    // La regla ("covered" o el estado paid/reconciled del corte) no se reescribe aqui.
    expect(body).not.toMatch(/status\s*===\s*["']paid["']/);
    expect(body).not.toMatch(/status\s*===\s*["']reconciled["']/);
  });
});
