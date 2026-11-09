import { describe, expect, it } from "vitest";
// Spec 038: la unica regla de cuanto efectivo le cobra un corte a un domiciliario.
// T1: lo que un pedido debe hoy (RF_01, RF_02; plan §3.1).
import {
  applyCompensationPlan,
  buildDriverSettlementFields,
  computeDriverCorte,
  driverCorteOrderIdsAtCreation,
  computeHolds,
  type DriverLedgerContext,
  type DriverLedgerSettlement,
  lastRecalculatedAt,
  orderOwedByDriver,
  pendingDeltaOrders,
  planDriverCompensation,
  rebuildHistoricalCharges
} from "../../functions/src/driver-cash-ledger";
import type { SettlementDoc, WalletEntryDoc } from "../../functions/src/settlement-math";

const DRIVER = "driver-1";

function entry(over: Partial<WalletEntryDoc> & Pick<WalletEntryDoc, "id" | "ownerType" | "type" | "amountCop" | "orderId">): WalletEntryDoc {
  return { ownerId: "seller-1", description: "", createdAt: "2026-08-01T10:00:00.000Z", ...over };
}

const cod = (id: string, orderId: string, amountCop: number, over: Partial<WalletEntryDoc> = {}) =>
  entry({ id, ownerType: "seller", type: "cod_revenue", amountCop, orderId, ...over });
const pay = (id: string, orderId: string, amountCop: number, over: Partial<WalletEntryDoc> = {}) =>
  entry({ id, ownerType: "driver", ownerId: DRIVER, type: "driver_earning", amountCop, orderId, ...over });

describe("orderOwedByDriver", () => {
  it("debido = recaudo vigente menos el pago del domiciliario", () => {
    const owed = orderOwedByDriver([cod("c1", "o1", 100000), pay("p1", "o1", 8000)], DRIVER);
    expect(owed.get("o1")).toEqual({ orderId: "o1", codCop: 100000, driverPayCop: 8000, owedCop: 92000 });
  });

  it("una reversa de recaudo (cod_remittance negativo) resta", () => {
    // Causa 1 de la spec (KNT-003259): entregado y luego corregido a fallido.
    const owed = orderOwedByDriver(
      [
        cod("c1", "o1", 78900),
        entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -78900, orderId: "o1" }),
        pay("p1", "o1", 8000)
      ],
      DRIVER
    );
    expect(owed.get("o1")).toMatchObject({ codCop: 0, driverPayCop: 8000, owedCop: -8000 });
  });

  it("el pago de otro domiciliario no cuenta", () => {
    const owed = orderOwedByDriver(
      [cod("c1", "o1", 50000), pay("p1", "o1", 8000), pay("p2", "o1", 7000, { ownerId: "driver-2" })],
      DRIVER
    );
    expect(owed.get("o1")).toMatchObject({ driverPayCop: 8000, owedCop: 42000 });
  });

  it("un pedido con recaudo en dos tiendas suma las dos (cambio de tienda)", () => {
    const owed = orderOwedByDriver(
      [cod("c1", "o1", 27000, { ownerId: "seller-a" }), cod("c2", "o1", 27000, { ownerId: "seller-b" }), pay("p1", "o1", 8000)],
      DRIVER
    );
    expect(owed.get("o1")).toMatchObject({ codCop: 54000, owedCop: 46000 });
  });

  it("ignora asientos sin pedido y tipos que no son recaudo ni pago", () => {
    const owed = orderOwedByDriver(
      [
        cod("c1", "o1", 40000),
        entry({ id: "f1", ownerType: "seller", type: "delivery_fee", amountCop: -12000, orderId: "o1" }),
        entry({ id: "a1", ownerType: "driver", ownerId: DRIVER, type: "cash_shortage", amountCop: -5000, orderId: "o1" }),
        cod("c2", "", 99999)
      ],
      DRIVER
    );
    expect(owed.size).toBe(1);
    expect(owed.get("o1")).toMatchObject({ codCop: 40000, driverPayCop: 0, owedCop: 40000 });
  });

  it("un pedido con solo pago (prepagado) debe negativo", () => {
    const owed = orderOwedByDriver([pay("p1", "o2", 8000)], DRIVER);
    expect(owed.get("o2")).toEqual({ orderId: "o2", codCop: 0, driverPayCop: 8000, owedCop: -8000 });
  });
});

// T2: reconstruccion historica de un corte viejo (RF_05, RF_05b; plan §3.4). La regla es la que
// specs/038_measure.js valido contra los 60 cortes de produccion; aqui se prueba por pedido.
function corte(over: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    id: "s1",
    kind: "driver",
    ownerId: DRIVER,
    ownerName: "Driver",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    walletEntryIds: [],
    orderIds: [],
    codCop: 0,
    feesCop: 0,
    driverPayCop: 0,
    platformMarginCop: 0,
    netCop: 0,
    status: "reconciled",
    createdAt: "2026-08-08T10:00:00.000Z",
    ...over
  };
}

function byOrder(entries: WalletEntryDoc[]): Map<string, WalletEntryDoc[]> {
  const map = new Map<string, WalletEntryDoc[]>();
  for (const e of entries) map.set(e.orderId, [...(map.get(e.orderId) ?? []), e]);
  return map;
}

const at = (iso: string) => ({ createdAt: iso });

describe("lastRecalculatedAt", () => {
  it("es el mayor de creacion, pago, conciliacion y abonos", () => {
    const s = corte({
      createdAt: "2026-08-08T10:00:00.000Z",
      paidAt: "2026-08-09T10:00:00.000Z",
      reconciledAt: "2026-08-09T11:00:00.000Z",
      cashReceipts: [{ amountCop: 1, receivedAt: "2026-08-10T09:00:00.000Z" }]
    });
    expect(lastRecalculatedAt(s)).toBe("2026-08-10T09:00:00.000Z");
  });
});

describe("rebuildHistoricalCharges", () => {
  it("con asignacion guardada, el pedido cobra exactamente su expectedCop", () => {
    const s = corte({
      orderIds: ["o1", "o2"],
      cashExpectedCop: 162000,
      cashAllocations: [
        { orderId: "o1", expectedCop: 92000, receivedCop: 92000, covered: true },
        { orderId: "o2", expectedCop: 70000, receivedCop: 70000, covered: true }
      ]
    });
    // Los asientos actuales ya no cuadran (una correccion borro el recaudo de o2): manda la asignacion.
    const cods = byOrder([cod("c1", "o1", 100000)]);
    const pays = byOrder([pay("p1", "o1", 8000), pay("p2", "o2", 8000)]);
    const rows = rebuildHistoricalCharges(s, cods, pays);
    expect(rows).toEqual([
      { orderId: "o1", chargedCop: 92000, driverPayCop: 8000, source: "allocation" },
      { orderId: "o2", chargedCop: 70000, driverPayCop: 8000, source: "allocation" }
    ]);
  });

  it("corte con asignaciones que no lista un pedido: aporta como mucho el descuento del pago (min 0)", () => {
    // Forma del caso KNT-000056 (corte del 2026-05-29): un script recalculo el corte tras corregir
    // el pedido y su asignacion desaparecio; sus asientos actuales dicen +40.000 que nunca se cobraron.
    const s = corte({
      orderIds: ["o1", "o2", "o3"],
      cashAllocations: [{ orderId: "o1", expectedCop: 92000, receivedCop: 92000, covered: true }]
    });
    const cods = byOrder([cod("c1", "o1", 100000), cod("c2", "o2", 40000)]);
    const pays = byOrder([pay("p1", "o1", 8000), pay("p2", "o2", 8000), pay("p3", "o3", 7000)]);
    const rows = rebuildHistoricalCharges(s, cods, pays);
    expect(rows.find((r) => r.orderId === "o2")).toEqual({ orderId: "o2", chargedCop: 0, driverPayCop: 8000, source: "rebuilt" });
    expect(rows.find((r) => r.orderId === "o3")).toEqual({ orderId: "o3", chargedCop: -7000, driverPayCop: 7000, source: "rebuilt" });
  });

  it("corte sin asignaciones: reconstruye recaudo menos pago, sin recortar", () => {
    const s = corte({ orderIds: ["o1", "o2"] });
    const cods = byOrder([cod("c1", "o1", 50000)]);
    const pays = byOrder([pay("p1", "o1", 8000), pay("p2", "o2", 8000)]);
    expect(rebuildHistoricalCharges(s, cods, pays)).toEqual([
      { orderId: "o1", chargedCop: 42000, driverPayCop: 8000, source: "rebuilt" },
      { orderId: "o2", chargedCop: -8000, driverPayCop: 8000, source: "rebuilt" }
    ]);
  });

  it("un asiento posterior al ultimo recalculo del corte no cuenta", () => {
    const s = corte({ orderIds: ["o1"], createdAt: "2026-08-08T10:00:00.000Z" });
    const cods = byOrder([
      cod("c1", "o1", 78900, at("2026-08-05T10:00:00.000Z")),
      // Reversa de una correccion hecha despues de cerrar el corte: la cobra (o devuelve) otro corte.
      entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -78900, orderId: "o1", createdAt: "2026-08-20T10:00:00.000Z" })
    ]);
    const pays = byOrder([pay("p1", "o1", 8000, at("2026-08-05T10:00:00.000Z"))]);
    expect(rebuildHistoricalCharges(s, cods, pays)).toEqual([
      { orderId: "o1", chargedCop: 70900, driverPayCop: 8000, source: "rebuilt" }
    ]);
  });

  it("un pedido repetido en orderIds sale una sola vez", () => {
    const s = corte({ orderIds: ["o1", "o1"] });
    const rows = rebuildHistoricalCharges(s, byOrder([cod("c1", "o1", 10000)]), new Map());
    expect(rows).toHaveLength(1);
  });

  it("la suma de un corte con asignaciones y sin pedidos fuera de ellas cuadra con cashExpectedCop", () => {
    const s = corte({
      orderIds: ["o1", "o2"],
      cashExpectedCop: 130000,
      cashAllocations: [
        { orderId: "o1", expectedCop: 92000, receivedCop: 92000, covered: true },
        { orderId: "o2", expectedCop: 38000, receivedCop: 38000, covered: true }
      ]
    });
    const total = rebuildHistoricalCharges(s, new Map(), new Map()).reduce((a, r) => a + r.chargedCop, 0);
    expect(total).toBe(s.cashExpectedCop);
  });
});

// T3: el cargo de un corte (RF_02, RF_03, RF_09b; plan §3.2, §3.3).

const fee = (id: string, orderId: string, amountCop: number) =>
  entry({ id, ownerType: "seller", type: "delivery_fee", amountCop, orderId });

function ctx(over: Partial<DriverLedgerContext> = {}): DriverLedgerContext {
  return { driverId: DRIVER, settlements: [], baseline: { driverId: DRIVER, createdAt: "", createdBy: "", measuredDiffCop: 0, settlements: {} }, holds: null, ...over };
}

function newCorte(id: string, charges: Array<[string, number]>, over: Partial<DriverLedgerSettlement> = {}): DriverLedgerSettlement {
  return {
    id,
    status: "reconciled",
    orderIds: charges.map(([orderId]) => orderId),
    cashCharges: charges.map(([orderId, chargedCop]) => ({ orderId, codCop: chargedCop, driverPayCop: 0, chargedCop, codSeenCop: 0 })),
    ...over
  };
}

describe("computeDriverCorte", () => {
  it("un pedido nuevo: cobra recaudo menos su pago, y lo deja registrado", () => {
    const entries = [cod("c1", "o1", 100000), fee("f1", "o1", -12000), pay("p1", "o1", 8000)];
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: ["p1"], entries, context: ctx() });
    expect(result.charges).toEqual([{ orderId: "o1", codCop: 100000, driverPayCop: 8000, chargedCop: 92000, codSeenCop: 100000 }]);
    expect(result).toMatchObject({ codCop: 100000, driverPayCop: 8000, feesCop: 12000, platformMarginCop: 4000, chargedTotalCop: 92000 });
  });

  it("un pedido que otro corte nuevo ya cobro no se cobra otra vez (causa 3, KNT-002682)", () => {
    const entries = [cod("c1", "o1", 101900), pay("p1", "o1", 8000), pay("p2", "o2", 8000), cod("c2", "o2", 50000)];
    const context = ctx({ settlements: [newCorte("A", [["o1", 93900]])] });
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1", "o2"], ownEntryIds: ["p2"], entries, context });
    expect(result.charges.find((c) => c.orderId === "o1")).toMatchObject({ chargedCop: 0, driverPayCop: 0, codCop: 0 });
    expect(result.chargedTotalCop).toBe(42000);
  });

  it("el pago descontado en otro corte no se descuenta dos veces (causa 4, KNT-002965)", () => {
    // A cobro 70.900 (78.900 - 8.000). Luego la reversa deja el pedido en -8.000: X devuelve 78.900, no 86.900.
    const entries = [
      cod("c1", "o1", 78900),
      entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -78900, orderId: "o1" }),
      pay("p1", "o1", 8000)
    ];
    const context = ctx({ settlements: [newCorte("A", [["o1", 70900]])] });
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries, context });
    expect(result.charges[0]).toMatchObject({ chargedCop: -78900, driverPayCop: 0, codCop: -78900 });
  });

  it("un corte viejo sin cashCharges se lee de la foto, no de los asientos", () => {
    // Causa 2 (KNT-004540): una correccion borro el recaudo; la foto conserva lo que el corte cobro.
    const old: DriverLedgerSettlement = { id: "OLD", status: "reconciled", orderIds: ["o1"] };
    const context = ctx({
      settlements: [old],
      baseline: { driverId: DRIVER, createdAt: "", createdBy: "", measuredDiffCop: 0, settlements: { OLD: [{ orderId: "o1", chargedCop: 70900, driverPayCop: 8000, source: "allocation" }] } }
    });
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries: [pay("p1", "o1", 8000)], context });
    expect(result.charges[0].chargedCop).toBe(-78900);
  });

  it("la retencion sin liberar se suma al cargo; liberada no", () => {
    const entries = [pay("p1", "o1", 8000)];
    const settlements = [newCorte("A", [["o1", 70900]])];
    const held = computeDriverCorte({
      settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries,
      context: ctx({ settlements, holds: { driverId: DRIVER, createdAt: "", holds: [{ orderId: "o1", holdCop: 78900 }] } })
    });
    expect(held.charges[0].chargedCop).toBe(0);
    const released = computeDriverCorte({
      settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries,
      context: ctx({ settlements, holds: { driverId: DRIVER, createdAt: "", holds: [{ orderId: "o1", holdCop: 78900, releasedAt: "2026-11-10T00:00:00.000Z", releasedCop: 78900 }] } })
    });
    expect(released.charges[0].chargedCop).toBe(-78900);
  });

  it("el propio corte no se cuenta como 'otro' al recalcularse", () => {
    const entries = [cod("c1", "o1", 50000), pay("p1", "o1", 8000)];
    const context = ctx({ settlements: [newCorte("X", [["o1", 42000]], { status: "pending" })] });
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: ["p1"], entries, context });
    expect(result.charges[0].chargedCop).toBe(42000);
  });

  it("un pedido que entra sin asiento propio no aporta fletes ni margen", () => {
    const entries = [cod("c1", "o1", 0), fee("f1", "o1", -12000), pay("p1", "o1", 8000)];
    const context = ctx({ settlements: [newCorte("A", [["o1", 0]])] });
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries, context });
    expect(result).toMatchObject({ feesCop: 0, driverPayCop: 0, platformMarginCop: 0 });
  });

  it("un pedido por fila, y recaudo - pago = suma de cargos", () => {
    const entries = [cod("c1", "o1", 60000), pay("p1", "o1", 8000), pay("p2", "o2", 7000), cod("c2", "o3", 30000), pay("p3", "o3", 8000)];
    const result = computeDriverCorte({ settlementId: "X", orderIds: ["o1", "o2", "o3", "o1"], ownEntryIds: ["p1", "p2", "p3"], entries, context: ctx() });
    expect(result.charges.map((c) => c.orderId)).toEqual(["o1", "o2", "o3"]);
    expect(result.codCop - result.driverPayCop).toBe(result.chargedTotalCop);
    expect(result.chargedTotalCop).toBe(52000 - 7000 + 22000);
  });

  it("un corte viejo que contiene el pedido y no esta en la foto es un error, no un cero", () => {
    const context = ctx({ settlements: [{ id: "OLD", status: "paid", orderIds: ["o1"] }] });
    expect(() => computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries: [], context })).toThrow(/OLD/);
  });
});

// T4: saldo a favor, neto y reparto de lo recibido (RF_08, RF_09b; tabla de plan §3.3).
describe("computeDriverCorte: saldo a favor, neto y reparto", () => {
  const meta = new Map([
    ["o1", { createdAt: "2026-08-01T00:00:00.000Z", trackingCode: "KNT-1" }],
    ["o2", { createdAt: "2026-08-02T00:00:00.000Z", trackingCode: "KNT-2" }],
    ["o3", { createdAt: "2026-08-01T00:00:00.000Z", trackingCode: "KNT-0" }]
  ]);

  it("corte normal: esperado = suma de cargos, neto = -esperado, sin 4x1000 ni credito", () => {
    const entries = [cod("c1", "o1", 100000), pay("p1", "o1", 8000)];
    const r = computeDriverCorte({ settlementId: "X", orderIds: ["o1"], ownEntryIds: ["p1"], entries, context: ctx(), receivedCop: 0, orderMeta: meta });
    expect(r).toMatchObject({ creditInCop: 0, creditOutCop: 0, cashExpectedCop: 92000, grossNetCop: -92000, netCop: -92000, gmfCop: 0 });
  });

  it("devolucion mayor que lo debido: esperado 0, neto 0 y el resto como credito exacto", () => {
    // A cobro 78.900 por o1; la reversa lo devuelve. o2 debe 42.000. Bruto = 42.000 - 86.900 = -44.900.
    const entries = [
      cod("c1", "o1", 78900),
      entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -78900, orderId: "o1" }),
      pay("p1", "o1", 8000),
      cod("c2", "o2", 50000),
      pay("p2", "o2", 8000)
    ];
    const context = ctx({ settlements: [newCorte("A", [["o1", 78900]])] });
    const r = computeDriverCorte({ settlementId: "X", orderIds: ["o1", "o2"], ownEntryIds: ["p2"], entries, context, receivedCop: 0, orderMeta: meta });
    expect(r.chargedTotalCop).toBe(42000 - 86900);
    expect(r).toMatchObject({ cashExpectedCop: 0, creditOutCop: 44900, netCop: 0, grossNetCop: 0 });
  });

  it("el siguiente corte consume el credito una sola vez", () => {
    const entries = [cod("c1", "o4", 60000), pay("p1", "o4", 8000)];
    const withCredit = newCorte("X", [["o1", -44900]], { creditInCop: 0, creditOutCop: 44900 });
    const first = computeDriverCorte({ settlementId: "Y", orderIds: ["o4"], ownEntryIds: ["p1"], entries, context: ctx({ settlements: [withCredit] }), receivedCop: 0, orderMeta: meta });
    expect(first).toMatchObject({ creditInCop: 44900, cashExpectedCop: 52000 - 44900, creditOutCop: 0 });

    const consumed = newCorte("Y", [["o4", 52000]], { creditInCop: 44900, creditOutCop: 0 });
    const second = computeDriverCorte({ settlementId: "Z", orderIds: ["o5"], ownEntryIds: [], entries: [cod("c5", "o5", 30000)], context: ctx({ settlements: [withCredit, consumed] }), receivedCop: 0, orderMeta: meta });
    expect(second).toMatchObject({ creditInCop: 0, cashExpectedCop: 30000 });
  });

  it("un credito que un corte pendiente consumio de mas se cobra en el siguiente (credito de entrada negativo)", () => {
    // X dejo 10.000; Y consumio 10.000; luego X se recalculo y solo deja 4.000. Z debe cobrar los 6.000.
    const x = newCorte("X", [["o1", -4000]], { status: "pending", creditInCop: 0, creditOutCop: 4000 });
    const y = newCorte("Y", [["o2", 20000]], { creditInCop: 10000, creditOutCop: 0 });
    const r = computeDriverCorte({ settlementId: "Z", orderIds: ["o3"], ownEntryIds: [], entries: [cod("c3", "o3", 30000)], context: ctx({ settlements: [x, y] }), receivedCop: 0, orderMeta: meta });
    expect(r).toMatchObject({ creditInCop: -6000, cashExpectedCop: 36000 });
  });

  it("reparte lo recibido entre los pedidos con cargo positivo, por fecha y tracking", () => {
    const entries = [cod("c1", "o1", 50000), cod("c2", "o2", 40000), cod("c3", "o3", 30000), pay("p4", "o4", 8000)];
    const r = computeDriverCorte({ settlementId: "X", orderIds: ["o1", "o2", "o3", "o4"], ownEntryIds: ["p4"], entries, context: ctx(), receivedCop: 70000, orderMeta: meta });
    expect(r.allocations).toEqual([
      { orderId: "o3", expectedCop: 30000, receivedCop: 30000, covered: true },
      { orderId: "o1", expectedCop: 50000, receivedCop: 40000, covered: false },
      { orderId: "o2", expectedCop: 40000, receivedCop: 0, covered: false }
    ]);
    expect(r.allocations.reduce((a, x) => a + x.receivedCop, 0)).toBe(70000);
  });
});

// T7: pedidos que vuelven solos al siguiente corte (RF_06, RF_07; plan §3.5).
describe("pendingDeltaOrders", () => {
  it("un pedido cuyo recaudo cambio de tienda sin asiento nuevo del domiciliario vuelve (forma de KNT-005724)", () => {
    // A cobro 19.000 (27.000 - 8.000). Luego el recaudo se movio a otra tienda y quedo en 0 neto.
    const entries = [
      cod("c1", "o1", 27000, { ownerId: "seller-a" }),
      entry({ id: "r1", ownerType: "seller", ownerId: "seller-a", type: "cod_remittance", amountCop: -27000, orderId: "o1" }),
      pay("p1", "o1", 8000)
    ];
    const context = ctx({ settlements: [newCorte("A", [["o1", 19000]])] });
    expect(pendingDeltaOrders({ entries, context })).toEqual([{ orderId: "o1", deltaCop: -27000 }]);
  });

  it("un pedido que esta en un corte pendiente no vuelve: lo absorbe ese corte al recalcularse", () => {
    const entries = [pay("p1", "o1", 8000)];
    const context = ctx({ settlements: [newCorte("A", [["o1", 19000]], { status: "pending" })] });
    expect(pendingDeltaOrders({ entries, context })).toEqual([]);
  });

  it("un pedido retenido no vuelve hasta que se libere", () => {
    const entries = [pay("p1", "o1", 8000)];
    const settlements = [newCorte("A", [["o1", 70900]])];
    const holds = { driverId: DRIVER, createdAt: "", holds: [{ orderId: "o1", holdCop: 78900 }] };
    expect(pendingDeltaOrders({ entries, context: ctx({ settlements, holds }) })).toEqual([]);
    const released = { ...holds, holds: [{ ...holds.holds[0], releasedAt: "2026-11-10T00:00:00.000Z", releasedCop: 78900 }] };
    expect(pendingDeltaOrders({ entries, context: ctx({ settlements, holds: released }) })).toEqual([{ orderId: "o1", deltaCop: -78900 }]);
  });

  it("una vez cobrada la diferencia deja de volver", () => {
    const entries = [pay("p1", "o1", 8000)];
    const settlements = [newCorte("A", [["o1", 70900]]), newCorte("B", [["o1", -78900]])];
    expect(pendingDeltaOrders({ entries, context: ctx({ settlements }) })).toEqual([]);
  });

  it("los pedidos de cortes viejos se comparan contra la foto", () => {
    const old: DriverLedgerSettlement = { id: "OLD", status: "reconciled", orderIds: ["o1", "o2"] };
    const context = ctx({
      settlements: [old],
      baseline: {
        driverId: DRIVER, createdAt: "", createdBy: "", measuredDiffCop: 0,
        settlements: { OLD: [
          { orderId: "o1", chargedCop: 42000, driverPayCop: 8000, source: "allocation" },
          { orderId: "o2", chargedCop: 30000, driverPayCop: 8000, source: "allocation" }
        ] }
      }
    });
    const entries = [cod("c1", "o1", 50000), pay("p1", "o1", 8000), cod("c2", "o2", 30000), pay("p2", "o2", 8000)];
    // o1 cuadra; o2 debe 22.000 y se cobraron 30.000: vuelve con -8.000 (el pago que no se desconto).
    expect(pendingDeltaOrders({ entries, context })).toEqual([{ orderId: "o2", deltaCop: -8000 }]);
  });
});

// T8: retenciones y compensacion (RF_13-RF_17; plan §3.6).
describe("computeHolds", () => {
  const times = new Map([["A", "2026-08-08T10:00:00.000Z"]]);

  it("retiene la diferencia historica de un pedido cuyo recaudo se borro (forma de KNT-007828)", () => {
    // A cobro 81.900; una correccion borro el recaudo de la tienda (no queda asiento): debe -8.000.
    const settlements = [newCorte("A", [["o1", 81900]])];
    const entries = [pay("p1", "o1", 8000, at("2026-08-05T10:00:00.000Z"))];
    expect(computeHolds({ entries, context: ctx({ settlements }), recalculatedAt: times })).toEqual([{ orderId: "o1", holdCop: 89900 }]);
  });

  it("una re-entrega de hoy aun sin cortar no queda retenida: la cobra el siguiente corte", () => {
    const settlements = [newCorte("A", [["o1", 70900]])];
    const entries = [
      cod("c1", "o1", 78900, at("2026-08-05T10:00:00.000Z")),
      pay("p1", "o1", 8000, at("2026-08-05T10:00:00.000Z")),
      entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -78900, orderId: "o1", createdAt: "2026-11-08T10:00:00.000Z" }),
      cod("c2", "o1", 78900, at("2026-11-08T12:00:00.000Z"))
    ];
    expect(computeHolds({ entries, context: ctx({ settlements }), recalculatedAt: times })).toEqual([]);
  });

  it("un pedido que la regla vieja no volveria a traer congela tambien lo posterior a su corte (KNT-005724)", () => {
    // Su unico corte cobro 19.000; el 2026-11-04, despues del corte, se revirtio el recaudo. No tiene pago
    // sin cortar ni corte pendiente: la regla vieja no lo cobraria nunca, asi que la diferencia es historica.
    const settlements = [newCorte("A", [["o1", 19000]])];
    const entries = [
      cod("c1", "o1", 27000, at("2026-08-05T10:00:00.000Z")),
      pay("p1", "o1", 8000, { createdAt: "2026-08-05T10:00:00.000Z", settlementId: "A" }),
      entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -27000, orderId: "o1", createdAt: "2026-11-04T16:46:11.312Z" })
    ];
    expect(computeHolds({ entries, context: ctx({ settlements }), recalculatedAt: times })).toEqual([{ orderId: "o1", holdCop: 27000 }]);
  });

  it("un pedido en un corte pendiente sigue cortando por fecha: ese corte cobra lo nuevo", () => {
    const settlements = [newCorte("A", [["o1", 19000]], { status: "pending" })];
    const entries = [
      cod("c1", "o1", 27000, at("2026-08-05T10:00:00.000Z")),
      pay("p1", "o1", 8000, { createdAt: "2026-08-05T10:00:00.000Z", settlementId: "A" }),
      entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -27000, orderId: "o1", createdAt: "2026-11-04T16:46:11.312Z" })
    ];
    expect(computeHolds({ entries, context: ctx({ settlements }), recalculatedAt: times })).toEqual([]);
  });

  it("un pedido que cuadra no se retiene, y uno cobrado de menos si (signo negativo)", () => {
    const settlements = [newCorte("A", [["o1", 42000], ["o2", 30000]])];
    const entries = [cod("c1", "o1", 50000), pay("p1", "o1", 8000), cod("c2", "o2", 30000), pay("p2", "o2", 8000)];
    // o2: se cobraron 30.000 y debia 22.000 -> retencion 8.000. Reves: si se cobraran 14.000, -8.000.
    expect(computeHolds({ entries, context: ctx({ settlements }), recalculatedAt: times })).toEqual([{ orderId: "o2", holdCop: 8000 }]);
    const under = [newCorte("A", [["o1", 42000], ["o2", 14000]])];
    expect(computeHolds({ entries, context: ctx({ settlements: under }), recalculatedAt: times })).toEqual([{ orderId: "o2", holdCop: -8000 }]);
  });
});

describe("planDriverCompensation y applyCompensationPlan", () => {
  const settlements = [newCorte("A", [["o1", 81900], ["o2", 30000], ["o3", 46000]])];
  const entries = [pay("p1", "o1", 8000), cod("c2", "o2", 30000), pay("p2", "o2", 8000), cod("c3", "o3", 27000), pay("p3", "o3", 8000)];
  const holds = {
    driverId: DRIVER,
    createdAt: "2026-11-09T00:00:00.000Z",
    holds: [
      { orderId: "o1", holdCop: 89900 },
      { orderId: "o2", holdCop: 8000 },
      { orderId: "o3", holdCop: 27000 }
    ]
  };
  const exclude = new Map([["o3", "Pendiente de aclarar si el cliente pago en efectivo"]]);
  const approval = { approvedBy: "responsable", reason: "Compensacion opcion A", at: "2026-11-10T00:00:00.000Z", compensationId: "comp-1" };

  it("previsualiza por pedido; los excluidos se listan y quedan fuera del total", () => {
    const plan = planDriverCompensation({ entries, context: ctx({ settlements, holds }), exclude });
    expect(plan.rows).toEqual([
      { orderId: "o1", chargedCop: 81900, owedCop: -8000, releaseCop: 89900, excluded: false, entersVia: "next" },
      { orderId: "o2", chargedCop: 30000, owedCop: 22000, releaseCop: 8000, excluded: false, entersVia: "next" },
      { orderId: "o3", chargedCop: 46000, owedCop: 19000, releaseCop: 27000, excluded: true, excludedReason: "Pendiente de aclarar si el cliente pago en efectivo", entersVia: "next" }
    ]);
    expect(plan).toMatchObject({ totalCop: 97900, excludedCop: 27000 });
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(planDriverCompensation({ entries, context: ctx({ settlements, holds }), exclude }).fingerprint).toBe(plan.fingerprint);
  });

  it("un pedido en un corte pendiente se compensa al recalcular ese corte", () => {
    const pending = [newCorte("A", [["o1", 81900]], { status: "pending" })];
    const plan = planDriverCompensation({ entries, context: ctx({ settlements: pending, holds: { ...holds, holds: [holds.holds[0]] } }) });
    expect(plan.rows[0].entersVia).toBe("pending:A");
  });

  it("aplicar libera exactamente lo previsualizado, con autor y motivo, y deja los excluidos", () => {
    const plan = planDriverCompensation({ entries, context: ctx({ settlements, holds }), exclude });
    const result = applyCompensationPlan(holds, plan, { ...approval, expectedFingerprint: plan.fingerprint });
    expect(result.holds.holds).toEqual([
      { orderId: "o1", holdCop: 89900, releasedCop: 89900, releasedBy: "responsable", releasedAt: approval.at, compensationId: "comp-1" },
      { orderId: "o2", holdCop: 8000, releasedCop: 8000, releasedBy: "responsable", releasedAt: approval.at, compensationId: "comp-1" },
      { orderId: "o3", holdCop: 27000 }
    ]);
    expect(result.audit).toMatchObject({
      compensationId: "comp-1", driverId: DRIVER, approvedBy: "responsable", reason: "Compensacion opcion A",
      fingerprint: plan.fingerprint, releasedOrderIds: ["o1", "o2"], excludedOrderIds: ["o3"], totalCop: 97900
    });
    expect(holds.holds[0]).toEqual({ orderId: "o1", holdCop: 89900 });
  });

  it("aplicar con una huella distinta de la previsualizada lanza (los datos cambiaron)", () => {
    const plan = planDriverCompensation({ entries, context: ctx({ settlements, holds }), exclude });
    expect(() => applyCompensationPlan(holds, plan, { ...approval, expectedFingerprint: "deadbeef" })).toThrow(/huella/);
  });

  it("aplicar dos veces no cambia nada, y el pedido liberado no se devuelve dos veces", () => {
    const plan = planDriverCompensation({ entries, context: ctx({ settlements, holds }), exclude });
    const first = applyCompensationPlan(holds, plan, { ...approval, expectedFingerprint: plan.fingerprint });
    const again = planDriverCompensation({ entries, context: ctx({ settlements, holds: first.holds }), exclude });
    expect(again.rows.filter((r) => !r.excluded)).toEqual([]);
    expect(applyCompensationPlan(first.holds, again, { ...approval, compensationId: "comp-2", expectedFingerprint: again.fingerprint }).holds).toEqual(first.holds);

    // El siguiente corte recoge la devolucion de o1 y o2 una vez; despues ya no vuelven.
    const back = pendingDeltaOrders({ entries, context: ctx({ settlements, holds: first.holds }) });
    expect(back).toEqual([{ orderId: "o1", deltaCop: -89900 }, { orderId: "o2", deltaCop: -8000 }]);
    const refunded = [...settlements, newCorte("B", [["o1", -89900], ["o2", -8000]])];
    expect(pendingDeltaOrders({ entries, context: ctx({ settlements: refunded, holds: first.holds }) })).toEqual([]);
  });
});

// T12: lo que se guarda en un corte de domiciliario (al crearlo y en cada recalculo) (RF_03, RF_07, RF_09).
describe("driverCorteOrderIdsAtCreation", () => {
  it("los pedidos de sus asientos sin cortar mas los que vuelven solos, sin repetir", () => {
    const own = [pay("p9", "o9", 8000), pay("p8", "o1", 5000)];
    const entries = [...own, pay("p1", "o1", 8000), cod("c1", "o1", 27000), entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -27000, orderId: "o1" }), pay("p2", "o2", 8000), cod("c2", "o2", 50000)];
    const context = ctx({ settlements: [newCorte("A", [["o1", 19000], ["o2", 42000]])] });
    expect(driverCorteOrderIdsAtCreation(own, entries, context)).toEqual(["o9", "o1"]);
  });

  it("un corte formado solo por devoluciones es valido (domiciliario sin movimientos nuevos)", () => {
    const entries = [pay("p1", "o1", 8000)];
    const context = ctx({ settlements: [newCorte("A", [["o1", 70900]])] });
    expect(driverCorteOrderIdsAtCreation([], entries, context)).toEqual(["o1"]);
  });
});

describe("buildDriverSettlementFields", () => {
  const meta = new Map([["o1", { createdAt: "2026-11-01T00:00:00.000Z", trackingCode: "KNT-1" }]]);

  it("un corte normal: cifras completas desde la creacion, con cashExpectedCop y el registro por pedido", () => {
    const entries = [cod("c1", "o1", 100000), entry({ id: "f1", ownerType: "seller", type: "delivery_fee", amountCop: -12000, orderId: "o1" }), pay("p1", "o1", 8000)];
    const fields = buildDriverSettlementFields({ settlementId: "X", orderIds: ["o1"], ownEntryIds: ["p1"], entries, context: ctx(), receivedCop: 0, orderMeta: meta });
    expect(fields).toEqual({
      codCop: 100000,
      feesCop: 12000,
      driverPayCop: 8000,
      platformMarginCop: 4000,
      netCop: -92000,
      gmfCop: 0,
      cashExpectedCop: 92000,
      cashReceivedCop: 0,
      cashPendingCop: 92000,
      cashExcessCop: 0,
      cashReceiptStatus: "none",
      cashAllocations: [{ orderId: "o1", expectedCop: 92000, receivedCop: 0, covered: false }],
      cashCharges: [{ orderId: "o1", codCop: 100000, driverPayCop: 8000, chargedCop: 92000, codSeenCop: 100000 }],
      creditInCop: 0,
      creditOutCop: 0,
      ledgerVersion: 1
    });
  });

  it("un pedido que vuelve solo entra con cargo negativo y no toca el margen", () => {
    const entries = [pay("p1", "o1", 8000)];
    const context = ctx({ settlements: [newCorte("A", [["o1", 70900]])] });
    const fields = buildDriverSettlementFields({ settlementId: "X", orderIds: ["o1"], ownEntryIds: [], entries, context, receivedCop: 0, orderMeta: meta });
    expect(fields).toMatchObject({ cashExpectedCop: 0, creditOutCop: 78900, platformMarginCop: 0, driverPayCop: 0, cashReceiptStatus: "complete", cashAllocations: [] });
    expect(fields.cashCharges[0].chargedCop).toBe(-78900);
  });

  it("abonos: pendiente, excedente y estado como hoy", () => {
    const entries = [cod("c1", "o1", 50000), pay("p1", "o1", 8000)];
    const base = { settlementId: "X", orderIds: ["o1"], ownEntryIds: ["p1"], entries, context: ctx(), orderMeta: meta };
    expect(buildDriverSettlementFields({ ...base, receivedCop: 20000 })).toMatchObject({ cashPendingCop: 22000, cashExcessCop: 0, cashReceiptStatus: "partial" });
    expect(buildDriverSettlementFields({ ...base, receivedCop: 50000 })).toMatchObject({ cashPendingCop: 0, cashExcessCop: 8000, cashReceiptStatus: "complete" });
  });
});
