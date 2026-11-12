import { describe, expect, it } from "vitest";
// La logica vive en el backend (unica fuente de verdad para la elegibilidad de pago). Se importa
// desde functions/ en vez de duplicarla aqui: es la cifra que se le paga a una tienda y ya estaba
// triplicada entre la UI, store-api.ts y createSettlement.
import { computeSellerBalance } from "../../functions/src/seller-balance";
import { buildCodReceivedSet, codEntriesByOrder, isOrderCodSettled, isSellerEntryEligible, isWithinSettlementRange } from "../../functions/src/seller-ledger";

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
  // T29: `codSeenCop` es el recaudo que vio el corte (RF_11, segunda enmienda). En estos casos el pago es 8.000, asi
  // que vio el cargo + 8.000; un corte que solo devuelve vio 0 (el recaudo ya estaba revertido).
  const charge = (orderId: string, chargedCop: number, codSeenCop = chargedCop > 0 ? chargedCop + 8000 : 0) =>
    ({ orderId, codCop: chargedCop, driverPayCop: 0, chargedCop, codSeenCop });
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
  // T29: `codSeenCop` es el recaudo que vio el corte; en estos casos, 100.000.
  const charge = (orderId: string, chargedCop: number, codSeenCop = 100000) => ({ orderId, codCop: chargedCop, driverPayCop: 0, chargedCop, codSeenCop });
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

/**
 * Spec 038 · T29 (RF_11, segunda enmienda; hallazgo R1 de T28): recibido = el recaudo neto del pedido es el que
 * vio el ultimo corte saldado. Los asientos NO se escriben a mano: salen del planificador de correcciones, que
 * es lo que produce produccion (borrar y recrear cuando la tienda aun no cobro; reversa cuando si).
 */
describe("spec 038 · T29 · recibido con los asientos reales de una correccion", async () => {
  const { planOrderCorrection } = await import("../../functions/src/order-corrections-plan");
  type Entry = import("../../functions/src/settlement-math").WalletEntryDoc;
  const TARIFFS = { sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000, driverDeliveredPayCop: 8000, driverFailedPayCop: 8000 };
  const corteX = {
    id: "X", kind: "driver", ownerId: "d1", ownerName: "D1", status: "reconciled", startDate: "", endDate: "",
    createdAt: "2026-12-01T00:00:00.000Z", paidAt: "2026-12-01T12:00:00.000Z", reconciledAt: "2026-12-02T00:00:00.000Z",
    orderIds: ["o"], walletEntryIds: ["we-o-driver-delivery-pay"], codCop: 100000, feesCop: 0, driverPayCop: 8000, platformMarginCop: 0, netCop: -92000,
    cashCharges: [{ orderId: "o", codCop: 100000, driverPayCop: 8000, chargedCop: 92000, codSeenCop: 100000 }],
    cashExpectedCop: 92000, cashReceivedCop: 92000, cashPendingCop: 0,
    cashAllocations: [{ orderId: "o", expectedCop: 92000, receivedCop: 92000, covered: true }]
  };
  const corteTienda = { id: "S", kind: "seller", ownerId: "sA", ownerName: "A", status: "paid", startDate: "", endDate: "", createdAt: "2026-12-01T00:00:00.000Z",
    orderIds: ["o"], walletEntryIds: ["we-o-cod", "we-o-seller-delivery-fee"], codCop: 100000, feesCop: 12000, driverPayCop: 0, platformMarginCop: 0, netCop: 88000 };
  const delivered = (storePaid: boolean): Entry[] => [
    { id: "we-o-cod", ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, description: "", createdAt: "2026-11-30T00:00:00.000Z", settlementId: storePaid ? "S" : "" },
    { id: "we-o-seller-delivery-fee", ownerType: "seller", ownerId: "sA", orderId: "o", type: "delivery_fee", amountCop: -12000, description: "", createdAt: "2026-11-30T00:00:00.000Z", settlementId: storePaid ? "S" : "" },
    { id: "we-o-driver-delivery-pay", ownerType: "driver", ownerId: "d1", orderId: "o", type: "driver_earning", amountCop: 8000, description: "", createdAt: "2026-11-30T00:00:00.000Z", settlementId: "X" }
  ] as Entry[];
  const order = { id: "o", trackingCode: "KNT-9", status: "delivered", sellerId: "sA", driverId: "d1", paymentMethod: "cod", totalCop: 100000, evidence: [] };

  /** Corre el planificador y aplica su resultado como lo haria la callable. */
  function correct(entries: Entry[], orderNow: Record<string, unknown>, request: { kind: string; reason: string; failedCategory?: string; failedReason?: string }, now: string): Entry[] {
    const settlementsById = new Map([["X", corteX], ["S", corteTienda]] as const);
    const result = planOrderCorrection({
      order: orderNow, entries, settlementsById: settlementsById as never, request: request as never,
      driverLedgers: new Map([["d1", { driverId: "d1", settlements: [{ id: "X", status: "reconciled", orderIds: ["o"], cashCharges: corteX.cashCharges }], baseline: null, holds: null }]]) as never,
      cashInputs: { sellerEntries: entries.filter((e) => e.ownerType === "seller"), driverEntries: entries.filter((e) => e.ownerType === "driver"), orderMeta: new Map() },
      tariffs: TARIFFS, productCostLines: [], sellerPaysInCash: false, driverExists: true, actorId: "admin", now
    });
    expect(result.blockers).toEqual([]);
    const deleted = new Set(result.entriesToDelete.map((e) => e.id));
    return [...entries.filter((e) => !deleted.has(e.id)), ...result.entriesToCompensate.map((c) => c.entry), ...result.entriesToCreate];
  }
  const roundTrip = (storePaid: boolean, totalCop = 100000) => {
    const failed = correct(delivered(storePaid), order, { kind: "delivered_to_failed", reason: "no lo recibio", failedCategory: "failed_visit", failedReason: "no contesta" }, "2026-12-03T00:00:00.000Z");
    return correct(failed, { ...order, status: "failed", totalCop, failedCategory: "failed_visit" }, { kind: "failed_to_delivered", reason: "si lo recibio" }, "2026-12-04T00:00:00.000Z");
  };
  const received = (entries: Entry[], settlements: unknown[] = [corteX]) => buildCodReceivedSet(settlements as never, codEntriesByOrder(entries as never)).has("o");

  it("la tienda aun no cobro: la correccion BORRA y RECREA el recaudo, y el pedido sigue recibido (R1)", () => {
    const after = roundTrip(false);
    const cod = after.filter((e) => e.ownerType === "seller" && (e.type === "cod_revenue" || e.type === "cod_remittance"));
    expect(cod.map((e) => [e.amountCop, e.createdAt > corteX.reconciledAt])).toEqual([[100000, true]]); // asi lo deja produccion
    expect(received(after)).toBe(true);
  });

  it("la tienda ya cobro: la correccion compensa con reversa, y el pedido sigue recibido", () => {
    expect(received(roundTrip(true))).toBe(true);
  });

  it("re-entrega con otro monto (130.000): no es recibido hasta que un corte saldado vea 130.000", () => {
    // Con la tienda ya cobrada el planificador se niega (`entry_id_collision`): no recrea un recaudo cortado con
    // otro monto. Por eso solo se puede producir con la tienda aun sin cobrar.
    expect(received(roundTrip(false, 130000))).toBe(false);
  });

  it("solo la mitad del camino (entregado -> fallido): el corte vio 100.000 y hoy no hay recaudo, no es recibido", () => {
    const failed = correct(delivered(true), order, { kind: "delivered_to_failed", reason: "no lo recibio", failedCategory: "failed_visit", failedReason: "no contesta" }, "2026-12-03T00:00:00.000Z");
    expect(received(failed)).toBe(false);
  });

  it("cambio de tienda despues del corte saldado: recibido, con el neto de todas las tiendas", () => {
    const entries = [
      { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-11-30T00:00:00.000Z" },
      { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_remittance", amountCop: -100000, createdAt: "2026-12-03T00:00:00.000Z" },
      { ownerType: "seller", ownerId: "sB", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-12-03T00:00:01.000Z" }
    ] as Entry[];
    expect(received(entries)).toBe(true);
  });

  it("analyze B5: el ultimo corte saldado es el que devolvio (vio 0); una re-entrega de 78.900 no es recibida", () => {
    const a = { ...corteX, id: "A", cashCharges: [{ orderId: "o", codCop: 78900, driverPayCop: 8000, chargedCop: 70900, codSeenCop: 78900 }] };
    const b = { ...corteX, id: "B", createdAt: "2026-12-05T00:00:00.000Z", paidAt: "2026-12-05T12:00:00.000Z", reconciledAt: "2026-12-06T00:00:00.000Z",
      cashCharges: [{ orderId: "o", codCop: -78900, driverPayCop: 0, chargedCop: -78900, codSeenCop: 0 }], cashExpectedCop: 0, cashReceivedCop: 0, cashAllocations: [] };
    const entries = [
      { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 78900, createdAt: "2026-11-30T00:00:00.000Z" },
      { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_remittance", amountCop: -78900, createdAt: "2026-12-04T00:00:00.000Z" },
      { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 78900, createdAt: "2026-12-07T00:00:00.000Z" }
    ] as Entry[];
    expect(received(entries, [a, b])).toBe(false);
    // Aunque A se concilie DESPUES de saldarse B: conciliar no recalcula, asi que B sigue siendo el ultimo calculo.
    const aLate = { ...a, paidAt: "2026-12-01T12:00:00.000Z", reconciledAt: "2026-12-10T00:00:00.000Z" };
    expect(received(entries, [aLate, b])).toBe(false);
  });
});

/**
 * Spec 038 · T30 (RF_12; hallazgo R2 de T28): una vista parcial (los asientos de una tienda, o solo los sin cortar)
 * completa los asientos de recaudo de los pedidos que su parte no da por recibidos y que mas asientos SI podrian
 * cambiar, antes de decidir. Asi el saldo de tienda y la API dan lo mismo que la liquidacion.
 */
describe("spec 038 · T30 · las vistas parciales completan los asientos", async () => {
  const { codOrdersToComplete } = await import("../../functions/src/seller-ledger");
  const { completeCodEntries } = await import("../../functions/src/seller-ledger-io");
  const corteX = {
    id: "X", kind: "driver", status: "reconciled", createdAt: "2026-12-01T00:00:00.000Z", paidAt: "2026-12-01T12:00:00.000Z", reconciledAt: "2026-12-02T00:00:00.000Z",
    orderIds: ["o"], cashCharges: [{ orderId: "o", codCop: 100000, driverPayCop: 8000, chargedCop: 92000, codSeenCop: 100000 }],
    cashExpectedCop: 92000, cashReceivedCop: 92000, cashPendingCop: 0, cashAllocations: [{ orderId: "o", expectedCop: 92000, receivedCop: 92000, covered: true }]
  };
  const pendiente = { ...corteX, id: "P", status: "pending", paidAt: undefined, reconciledAt: undefined, orderIds: ["p"], cashReceivedCop: 0, cashPendingCop: 50000,
    cashCharges: [{ orderId: "p", codCop: 50000, driverPayCop: 0, chargedCop: 50000, codSeenCop: 50000 }],
    cashAllocations: [{ orderId: "p", expectedCop: 50000, receivedCop: 0, covered: false }] };
  const entry = (id: string, ownerId: string, orderId: string, type: string, amountCop: number, createdAt: string, settlementId = "") =>
    ({ id, ownerType: "seller", ownerId, orderId, type, amountCop, createdAt, settlementId, description: "" });
  // Cambio de tienda despues del corte saldado: A cobro y se le revierte; B recibe el recaudo.
  const all = [
    entry("we-o-cod", "sA", "o", "cod_revenue", 100000, "2026-11-30T00:00:00.000Z", "S"),
    entry("we-o-cod-rev", "sA", "o", "cod_remittance", -100000, "2026-12-03T00:00:00.000Z"),
    entry("we-o-cod-b", "sB", "o", "cod_revenue", 100000, "2026-12-03T00:00:01.000Z"),
    { id: "we-o-pay", ownerType: "driver", ownerId: "d1", orderId: "o", type: "driver_earning", amountCop: 8000, createdAt: "2026-11-30T00:00:00.000Z", settlementId: "X" }
  ];
  const fakeDb = (docs: Record<string, unknown>[], calls: string[][]) => ({
    collection: (name: string) => ({
      where: (field: string, op: string, ids: string[]) => {
        expect([name, field, op]).toEqual(["walletEntries", "orderId", "in"]);
        expect(ids.length).toBeLessThanOrEqual(30);
        calls.push(ids);
        return { get: async () => ({ docs: docs.filter((doc) => ids.includes(String(doc.orderId))).map((doc) => ({ id: String(doc.id), data: () => doc })) }) };
      }
    })
  });

  it("solo pide completar lo que mas asientos pueden cambiar: ni lo recibido, ni lo pendiente de cobrar, ni lo ajeno", () => {
    const viewA = codEntriesByOrder(all.filter((e) => e.ownerId === "sA" && !e.settlementId) as never); // saldo de A: solo sin cortar
    expect(codOrdersToComplete([corteX], viewA)).toEqual(["o"]);
    const viewB = codEntriesByOrder(all.filter((e) => e.ownerId === "sB") as never);
    expect(codOrdersToComplete([corteX], viewB)).toEqual([]); // B ya cuadra: nada que leer
    const viewP = new Map([["p", [{ amountCop: 50000, createdAt: "2026-11-30T00:00:00.000Z" }]]]);
    expect(codOrdersToComplete([pendiente], viewP)).toEqual([]); // le falta el efectivo, no asientos
  });

  it("completa con la consulta de un campo (orderId in, de 30 en 30) y sustituye la lista del pedido, sin duplicar", async () => {
    const calls: string[][] = [];
    const partial = codEntriesByOrder(all.filter((e) => e.ownerId === "sA" && !e.settlementId) as never);
    const completed = await completeCodEntries(fakeDb(all, calls) as never, partial, ["o"]);
    expect(calls).toEqual([["o"]]);
    expect(completed.get("o")!.map((e) => e.amountCop).sort()).toEqual([-100000, 100000, 100000]);
    const many = Array.from({ length: 61 }, (_, i) => `x${i}`);
    const callsMany: string[][] = [];
    await completeCodEntries(fakeDb([], callsMany) as never, new Map(), many);
    expect(callsMany.map((ids) => ids.length)).toEqual([30, 30, 1]);
    const none: string[][] = [];
    expect(await completeCodEntries(fakeDb(all, none) as never, partial, [])).toBe(partial);
    expect(none).toEqual([]); // en regimen normal no lee nada
  });

  it("el cambio de tienda da lo mismo desde la tienda vieja, la nueva y la liquidacion", async () => {
    const liquidacion = buildCodReceivedSet([corteX], codEntriesByOrder(all as never)).has("o");
    const verdict = async (view: Map<string, unknown[]>) => {
      const completed = await completeCodEntries(fakeDb(all, []) as never, view as never, codOrdersToComplete([corteX], view as never));
      return buildCodReceivedSet([corteX], completed).has("o");
    };
    const viewA = codEntriesByOrder(all.filter((e) => e.ownerId === "sA" && !e.settlementId) as never);
    const viewB = codEntriesByOrder(all.filter((e) => e.ownerId === "sB") as never);
    expect([liquidacion, await verdict(viewA), await verdict(viewB)]).toEqual([true, true, true]);
  });

  it("el saldo de tienda acepta el recaudo ya completado (no lo vuelve a derivar de su vista parcial)", async () => {
    const { buildSellerBalanceInput } = await import("../../functions/src/seller-balance");
    const open = all.filter((e) => e.ownerId === "sA" && !e.settlementId);
    const base = { sellerId: "sA", wallet: open as never, orders: [], settlements: [corteX], settings: {}, zones: [], now: "2026-12-05T00:00:00.000Z" };
    expect(buildSellerBalanceInput(base).codReceived.has("o")).toBe(false);
    expect(buildSellerBalanceInput({ ...base, codByOrder: codEntriesByOrder(all as never) }).codReceived.has("o")).toBe(true);
  });
});
