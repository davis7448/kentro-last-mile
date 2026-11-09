import { describe, expect, it } from "vitest";
// La logica vive en el backend (unica fuente de verdad para la elegibilidad de pago). Se importa
// desde functions/ en vez de duplicarla aqui: es la cifra que se le paga a una tienda y ya estaba
// triplicada entre la UI, store-api.ts y createSettlement.
import { computeSellerBalance } from "../../functions/src/seller-balance";
import { buildCodReceivedSet, isOrderCodSettled, isSellerEntryEligible, isWithinSettlementRange } from "../../functions/src/seller-ledger";

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

  describe("spec 027: un corte saldado en total cubre todos sus pedidos con efectivo", () => {
    // Forma real del 2026-11-05: corte conciliado al peso, el ultimo pedido quedo sin cubrir porque lo
    // esperado descuenta el pago del domiciliario por visitas fallidas de otras tiendas.
    const saldado = {
      kind: "driver",
      status: "reconciled",
      cashExpectedCop: 4_391_140,
      cashReceivedCop: 4_391_140,
      cashPendingCop: 0,
      orderIds: ["o-cubierto", "o-sin-cubrir", "o-fallido-luego-entregado"],
      cashAllocations: [
        { orderId: "o-cubierto", expectedCop: 78_900, receivedCop: 78_900, covered: true },
        { orderId: "o-sin-cubrir", expectedCop: 78_900, receivedCop: 62_900, covered: false }
      ]
    };

    it("RF_01: en un corte conciliado y saldado, una asignacion sin cubrir cuenta como recibida", () => {
      const set = buildCodReceivedSet([saldado]);
      expect(set.has("o-cubierto")).toBe(true);
      expect(set.has("o-sin-cubrir")).toBe(true);
    });

    it("RF_01: tambien en un corte pagado (no solo conciliado)", () => {
      expect(buildCodReceivedSet([{ ...saldado, status: "paid" }]).has("o-sin-cubrir")).toBe(true);
    });

    it("RF_01b: un pedido en orderIds sin asignacion en el corte saldado NO entra por ese corte", () => {
      expect(buildCodReceivedSet([saldado]).has("o-fallido-luego-entregado")).toBe(false);
    });

    it("RF_03: un corte pagado con faltante real deja sin cubrir lo que la asignacion no cubre", () => {
      const conFaltante = { ...saldado, status: "paid", cashReceivedCop: 4_000_000, cashPendingCop: 391_140 };
      const set = buildCodReceivedSet([conFaltante]);
      expect(set.has("o-cubierto")).toBe(true);
      expect(set.has("o-sin-cubrir")).toBe(false);
    });

    it("RF_03: recibido menor que lo esperado tampoco esta saldado aunque el pendiente diga 0", () => {
      const raro = { ...saldado, cashReceivedCop: 4_000_000, cashPendingCop: 0 };
      expect(buildCodReceivedSet([raro]).has("o-sin-cubrir")).toBe(false);
    });

    it("un corte pendiente con pendiente 0 sigue sin contar (spec 018 RF_04)", () => {
      expect(buildCodReceivedSet([{ ...saldado, status: "pending" }]).has("o-sin-cubrir")).toBe(false);
    });

    it("excedente: recibido mayor que lo esperado tambien esta saldado", () => {
      const excedente = { ...saldado, cashReceivedCop: 4_500_000 };
      expect(buildCodReceivedSet([excedente]).has("o-sin-cubrir")).toBe(true);
    });

    it("corte sin cashPendingCop y recibido igual a lo esperado cuenta como saldado", () => {
      const { cashPendingCop: _omit, ...sinPendiente } = saldado;
      expect(buildCodReceivedSet([sinPendiente]).has("o-sin-cubrir")).toBe(true);
    });

    it("lo recibido se toma de cashReceipts cuando falta cashReceivedCop", () => {
      const { cashReceivedCop: _omit, ...sinRecibido } = saldado;
      const conRecibos = { ...sinRecibido, cashReceipts: [{ amountCop: 4_391_140, receivedAt: "2026-10-08" }] };
      expect(buildCodReceivedSet([conRecibos]).has("o-sin-cubrir")).toBe(true);
    });
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

// Spec 038 T9 — "recibido" con cortes calculados por la regla nueva (RF_11, RF_12; plan §3.7).
describe("spec 038: recibido con cortes nuevos (cashCharges)", () => {
  const charge = (orderId: string, chargedCop: number) => ({ orderId, codCop: chargedCop, driverPayCop: 0, chargedCop, codSeenCop: 0 });
  const cod = (amountCop: number, createdAt: string) => ({ type: "cod_revenue", amountCop, createdAt });
  const saldado = (id: string, orderId: string, chargedCop: number, over: Record<string, unknown> = {}) => ({
    id, kind: "driver", status: "reconciled", createdAt: "2026-12-01T10:00:00.000Z", reconciledAt: "2026-12-02T10:00:00.000Z",
    orderIds: [orderId], cashCharges: [charge(orderId, chargedCop)], cashExpectedCop: Math.max(0, chargedCop),
    cashReceivedCop: Math.max(0, chargedCop), cashPendingCop: 0,
    cashAllocations: chargedCop > 0 ? [{ orderId, expectedCop: chargedCop, receivedCop: chargedCop, covered: true }] : [],
    ...over
  });

  it("un pedido solo con cortes viejos sigue con la regla de hoy (RF_12)", () => {
    const viejo = { kind: "driver", status: "reconciled", orderIds: ["o1"], cashAllocations: [{ orderId: "o1", covered: true }] };
    const codByOrder = new Map([["o1", [cod(50000, "2026-12-05T00:00:00.000Z")]]]);
    expect(buildCodReceivedSet([viejo], codByOrder).has("o1")).toBe(true);
    expect(buildCodReceivedSet([viejo]).has("o1")).toBe(true);
  });

  it("corte nuevo saldado que cobro el pedido y sin recaudo posterior: recibido", () => {
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z")]]]);
    expect(buildCodReceivedSet([saldado("A", "o1", 42000)], codByOrder).has("o1")).toBe(true);
  });

  it("corte nuevo que cobro el pedido pero sigue pendiente: no recibido", () => {
    const pendiente = saldado("A", "o1", 42000, { status: "pending", reconciledAt: undefined, cashReceivedCop: 0, cashPendingCop: 42000,
      cashAllocations: [{ orderId: "o1", expectedCop: 42000, receivedCop: 0, covered: false }] });
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z")]]]);
    expect(buildCodReceivedSet([pendiente], codByOrder).has("o1")).toBe(false);
  });

  it("asignacion cubierta en un corte nuevo aun pendiente: recibido, como hoy (018 RF_04)", () => {
    const pendiente = saldado("A", "o1", 42000, { status: "pending", reconciledAt: undefined, cashReceivedCop: 42000, cashPendingCop: 0,
      cashReceipts: [{ amountCop: 42000, receivedAt: "2026-12-01T12:00:00.000Z" }] });
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z")]]]);
    expect(buildCodReceivedSet([pendiente], codByOrder).has("o1")).toBe(true);
  });

  it("re-entrega: recaudo nuevo posterior al ultimo corte saldado no cuenta hasta saldar el siguiente", () => {
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z"), cod(-50000, "2026-12-03T10:00:00.000Z"), cod(50000, "2026-12-04T10:00:00.000Z")]]]);
    expect(buildCodReceivedSet([saldado("A", "o1", 42000)], codByOrder).has("o1")).toBe(false);
  });

  it("analyze B5: A cobra, B devuelve y se salda, re-entrega del mismo monto NO cuenta (comparacion por tiempo)", () => {
    const a = saldado("A", "o1", 70900);
    const b = saldado("B", "o1", -78900, { createdAt: "2026-12-05T10:00:00.000Z", reconciledAt: "2026-12-06T10:00:00.000Z" });
    const codByOrder = new Map([["o1", [
      cod(78900, "2026-11-30T10:00:00.000Z"),
      { type: "cod_remittance", amountCop: -78900, createdAt: "2026-12-04T10:00:00.000Z" },
      cod(78900, "2026-12-07T10:00:00.000Z")
    ]]]);
    // Por monto: vigente 78.900 <= codSeen 78.900 lo habria dado por recibido. Por tiempo, no.
    expect(buildCodReceivedSet([a, b], codByOrder).has("o1")).toBe(false);
  });

  it("corte nuevo saldado en total cuenta todas sus asignaciones, cubiertas o no (027 RF_01)", () => {
    const corte = saldado("A", "o1", 42000, {
      orderIds: ["o1", "o2"],
      cashCharges: [charge("o1", 42000), charge("o2", 30000)],
      cashExpectedCop: 64000, cashReceivedCop: 64000,
      cashAllocations: [{ orderId: "o1", expectedCop: 42000, receivedCop: 42000, covered: true }, { orderId: "o2", expectedCop: 30000, receivedCop: 22000, covered: false }]
    });
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z")]], ["o2", [cod(38000, "2026-11-30T10:00:00.000Z")]]]);
    const set = buildCodReceivedSet([corte], codByOrder);
    expect([set.has("o1"), set.has("o2")]).toEqual([true, true]);
  });

  it("sin el recaudo por pedido, un pedido con corte nuevo no se da por recibido (estricto, nunca laxo)", () => {
    expect(buildCodReceivedSet([saldado("A", "o1", 42000)]).has("o1")).toBe(false);
  });

  it("isOrderCodSettled: un corte nuevo que solo devuelve, aun pendiente, no da el pedido por saldado", () => {
    const viejo = { kind: "driver", status: "reconciled", orderIds: ["o1"], cashAllocations: [{ orderId: "o1", covered: true }] };
    const devolucion = saldado("B", "o1", -78900, { status: "pending", reconciledAt: undefined, cashPendingCop: 0 });
    expect(isOrderCodSettled("o1", [viejo, devolucion], [cod(78900, "2026-11-30T10:00:00.000Z")])).toBe(false);
  });
});
