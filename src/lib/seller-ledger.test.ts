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
    // Spec 038 T26 (RF_11 enmendado): lo posterior debe SUMAR cero. Una re-entrega que no netea, si bloquea.
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z"), cod(-50000, "2026-12-03T10:00:00.000Z"), cod(50000, "2026-12-04T10:00:00.000Z"), cod(30000, "2026-12-05T10:00:00.000Z")]]]);
    expect(buildCodReceivedSet([saldado("A", "o1", 42000)], codByOrder).has("o1")).toBe(false);
  });

  it("T26 (H2): entregado -> fallido -> entregado despues del corte saldado netea cero: sigue recibido", () => {
    // Antes de la enmienda era "no recibido" para siempre: el domiciliario debe lo mismo, asi que el pedido no
    // vuelve a ningun corte y nada movia el ultimo recalculo. El efectivo que entrego en A no cambio.
    const codByOrder = new Map([["o1", [cod(50000, "2026-11-30T10:00:00.000Z"), cod(-50000, "2026-12-03T10:00:00.000Z"), cod(50000, "2026-12-04T10:00:00.000Z")]]]);
    expect(buildCodReceivedSet([saldado("A", "o1", 42000)], codByOrder).has("o1")).toBe(true);
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

/**
 * Spec 038 · T16: los llamadores de "recibido" pasan el recaudo por pedido. Sin `codByOrder`, un pedido de un
 * corte nuevo nunca sale recibido (mas estricto): si un llamador olvida pasarlo, la tienda deja de cobrar.
 */
describe("spec 038 · T16: codEntriesByOrder y los llamadores de recibido", () => {
  const corteNuevo = {
    id: "A", kind: "driver", status: "reconciled", createdAt: "2026-12-01T10:00:00.000Z", reconciledAt: "2026-12-02T10:00:00.000Z",
    orderIds: ["o1"], cashCharges: [{ orderId: "o1", codCop: 42000, driverPayCop: 0, chargedCop: 42000, codSeenCop: 42000 }],
    cashExpectedCop: 42000, cashReceivedCop: 42000, cashPendingCop: 0,
    cashAllocations: [{ orderId: "o1", expectedCop: 42000, receivedCop: 42000, covered: true }]
  };

  it("agrupa solo el recaudo de tienda (cod_revenue y cod_remittance) por pedido, de cualquier tienda", async () => {
    const { codEntriesByOrder } = await import("../../functions/src/seller-ledger");
    const grouped = codEntriesByOrder([
      { ownerType: "seller", ownerId: "s1", orderId: "o1", type: "cod_revenue", amountCop: 42000, createdAt: "2026-11-30T10:00:00.000Z" },
      { ownerType: "seller", ownerId: "s2", orderId: "o1", type: "cod_remittance", amountCop: -5000, createdAt: "2026-11-30T11:00:00.000Z" },
      { ownerType: "seller", ownerId: "s1", orderId: "o1", type: "shipping_fee", amountCop: -9000, createdAt: "2026-11-30T10:00:00.000Z" },
      { ownerType: "driver", ownerId: "d1", orderId: "o1", type: "driver_earning", amountCop: 7000, createdAt: "2026-11-30T10:00:00.000Z" },
      { ownerType: "seller", ownerId: "s1", orderId: "", type: "cod_revenue", amountCop: 1, createdAt: "2026-11-30T10:00:00.000Z" }
    ] as never);
    expect([...grouped.keys()]).toEqual(["o1"]);
    expect(grouped.get("o1")?.map((entry) => entry.amountCop)).toEqual([42000, -5000]);
  });

  it("codPartialReceivedCop con el recaudo: un pedido recibido en un corte nuevo no es parcial", () => {
    const codByOrder = new Map([["o1", [{ amountCop: 42000, createdAt: "2026-11-30T10:00:00.000Z" }]]]);
    // Un corte VIEJO (sin cashCharges) saldado en total por compensacion (027 RF_01) dejo la asignacion de o1 sin
    // cubrir con 20.000 recibidos; el corte nuevo, saldado despues, lo cobro entero. T26 (RF_11b): si el viejo
    // siguiera PENDIENTE, o1 no estaria recibido con o sin recaudo (era el hallazgo H3), asi que aqui va saldado.
    const parcialViejo = { id: "B", kind: "driver", status: "reconciled", orderIds: ["o1"], cashExpectedCop: 42000, cashReceivedCop: 42000,
      cashPendingCop: 0, cashAllocations: [{ orderId: "o1", expectedCop: 42000, receivedCop: 20000, covered: false }] };
    // Sin recaudo, el corte nuevo saldado no cuenta y la parcial del viejo se sumaria.
    const both = [corteNuevo, parcialViejo] as never[];
    expect(codPartialReceivedCop(both).get("o1")).toBe(20000);
    expect(codPartialReceivedCop(both, codByOrder).get("o1")).toBeUndefined();
  });

  it("todo llamador de produccion pasa el recaudo por pedido (el prefiltro de la API de la 026, uno vacio a proposito)", () => {
    const files = [
      "functions/src/seller-balance.ts", "functions/src/store-api.ts", "functions/src/store-api-orders.ts",
      "functions/src/cash-outstanding.ts", "functions/src/cash-outstanding-api.ts", "functions/src/orders.ts",
      "functions/src/seller-ledger.ts"
    ];
    const bare: string[] = [];
    for (const file of files) {
      const text = readFileSync(resolve(__dirname, "../..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const match of text.matchAll(/(buildCodReceivedSet|codPartialReceivedCop)\(([^()]*)\)/g)) {
        if (match[0].startsWith("buildCodReceivedSet(settlements: SettlementDoc[]") || match[0].startsWith("codPartialReceivedCop(settlements: SettlementDoc[]")) continue;
        if (!match[2].includes(",")) bare.push(`${file}: ${match[0]}`);
      }
    }
    expect(bare).toEqual([]);
  });
});

/** Spec 038 · T26: los hallazgos H2 y H3 de la verificacion (RF_11 enmendado, RF_11b). */
describe("spec 038 · T26 · recibido tras la verificacion", () => {
  const charge = (orderId: string, chargedCop: number) => ({ orderId, codCop: chargedCop, driverPayCop: 0, chargedCop, codSeenCop: 0 });
  const codFrom = (ownerId: string, amountCop: number, createdAt: string) => ({ ownerType: "seller", ownerId, type: "cod_revenue", amountCop, createdAt });
  const corteX = {
    id: "X", kind: "driver", status: "reconciled", createdAt: "2026-12-01T00:00:00.000Z", reconciledAt: "2026-12-02T00:00:00.000Z",
    orderIds: ["o"], cashCharges: [charge("o", 100000)], cashExpectedCop: 100000, cashReceivedCop: 100000, cashPendingCop: 0,
    cashAllocations: [{ orderId: "o", expectedCop: 100000, receivedCop: 100000, covered: true }]
  };

  it("H2: el pedido pasa de la tienda A a la B despues del corte saldado (netea cero): la tienda B puede cobrar", () => {
    const codByOrder = new Map([["o", [
      codFrom("sA", 100000, "2026-11-30T00:00:00.000Z"),
      codFrom("sA", -100000, "2026-12-03T00:00:00.000Z"),
      codFrom("sB", 100000, "2026-12-03T00:00:01.000Z")
    ]]]);
    expect(buildCodReceivedSet([corteX], codByOrder).has("o")).toBe(true);
    expect(isOrderCodSettled("o", [corteX], codByOrder.get("o")!)).toBe(true);
  });

  it("H2: un cambio posterior que NO netea (otro monto) sigue bloqueando hasta el siguiente corte", () => {
    const entries = [codFrom("sA", 100000, "2026-11-30T00:00:00.000Z"), codFrom("sA", -100000, "2026-12-03T00:00:00.000Z"), codFrom("sB", 73000, "2026-12-03T00:00:01.000Z")];
    expect(isOrderCodSettled("o", [corteX], entries)).toBe(false);
  });

  it("H3: con una asignacion sin cubrir en un corte viejo pendiente, un corte nuevo saldado no lo da por recibido", () => {
    const viejoPendiente = { id: "A", kind: "driver", status: "pending", createdAt: "2026-11-01T00:00:00.000Z", orderIds: ["o", "q"],
      cashExpectedCop: 195000, cashReceivedCop: 0, cashPendingCop: 195000,
      cashAllocations: [{ orderId: "o", expectedCop: 95000, receivedCop: 0, covered: false }, { orderId: "q", expectedCop: 100000, receivedCop: 0, covered: false }] };
    const nuevoSaldado = { id: "B", kind: "driver", status: "reconciled", createdAt: "2026-12-01T00:00:00.000Z", reconciledAt: "2026-12-02T00:00:00.000Z",
      orderIds: ["o"], cashCharges: [charge("o", -5000)], cashExpectedCop: 0, cashReceivedCop: 0, cashPendingCop: 0, cashAllocations: [] };
    const codByOrder = new Map([["o", [codFrom("sA", 100000, "2026-10-30T00:00:00.000Z")]]]);
    expect(buildCodReceivedSet([viejoPendiente, nuevoSaldado], codByOrder).has("o")).toBe(false);
  });

  it("H3: la asignacion sin cubrir de un corte viejo SALDADO en total no frena (027 RF_01 sin cambios)", () => {
    const viejoSaldado = { id: "A", kind: "driver", status: "reconciled", createdAt: "2026-11-01T00:00:00.000Z", reconciledAt: "2026-11-02T00:00:00.000Z",
      orderIds: ["o", "q"], cashExpectedCop: 100000, cashReceivedCop: 100000, cashPendingCop: 0,
      cashAllocations: [{ orderId: "o", expectedCop: 95000, receivedCop: 0, covered: false }, { orderId: "q", expectedCop: 5000, receivedCop: 100000, covered: true }] };
    const nuevoSaldado = { id: "B", kind: "driver", status: "reconciled", createdAt: "2026-12-01T00:00:00.000Z", reconciledAt: "2026-12-02T00:00:00.000Z",
      orderIds: ["o"], cashCharges: [charge("o", -5000)], cashExpectedCop: 0, cashReceivedCop: 0, cashPendingCop: 0, cashAllocations: [] };
    const codByOrder = new Map([["o", [codFrom("sA", 100000, "2026-10-30T00:00:00.000Z")]]]);
    expect(buildCodReceivedSet([viejoSaldado, nuevoSaldado], codByOrder).has("o")).toBe(true);
  });
});
