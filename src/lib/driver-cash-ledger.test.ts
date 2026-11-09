import { describe, expect, it } from "vitest";
// Spec 038: la unica regla de cuanto efectivo le cobra un corte a un domiciliario.
// T1: lo que un pedido debe hoy (RF_01, RF_02; plan §3.1).
import { lastRecalculatedAt, orderOwedByDriver, rebuildHistoricalCharges } from "../../functions/src/driver-cash-ledger";
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
