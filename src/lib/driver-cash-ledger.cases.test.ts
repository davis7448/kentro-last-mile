import { describe, expect, it } from "vitest";
// Spec 038 T6 — los casos reales (RNF_03, RF_05, RF_05b) con datos de produccion ANONIMIZADOS.
//
// Fixtures generados el 2026-11-09 con `node specs/038_measure.js driver-1778271901513 --fixtures
// src/lib/fixtures` (solo lectura). Desde la medicion del 2026-11-07, produccion creo un corte pendiente
// nuevo con la regla vieja que le devuelve 8.000 por KNT-007828: por eso la diferencia de hoy es 686.200 y
// no 694.200. Sigue siendo pendiente, asi que lo recalculara la regla nueva al desplegar.
import {
  computeDriverCorte,
  computeHolds,
  type DriverLedgerBaseline,
  type DriverLedgerContext,
  lastRecalculatedAt,
  orderOwedByDriver,
  rebuildHistoricalCharges
} from "../../functions/src/driver-cash-ledger";
import type { SettlementDoc, WalletEntryDoc } from "../../functions/src/settlement-math";
import case002682 from "./fixtures/038-knt-002682.json";
import case002965 from "./fixtures/038-knt-002965.json";
import case003259 from "./fixtures/038-knt-003259.json";
import case004540 from "./fixtures/038-knt-004540.json";
import driver16 from "./fixtures/038-driver-16.json";

type Fixture = {
  driverId: string;
  expected: Array<{ orderId: string; trackingCode: string; chargedCop: number; dueCop: number; excessCop: number }>;
  orders: Array<{ id: string; trackingCode: string; status: string; createdAt: string }>;
  settlements: Array<SettlementDoc & { trimmed: boolean }>;
  entries: WalletEntryDoc[];
};

const COD = new Set(["cod_revenue", "cod_remittance"]);

function load(raw: unknown) {
  const fixture = raw as Fixture;
  const codByOrder = new Map<string, WalletEntryDoc[]>();
  const payByOrder = new Map<string, WalletEntryDoc[]>();
  for (const entry of fixture.entries) {
    if (entry.ownerType === "seller" && COD.has(entry.type)) codByOrder.set(entry.orderId, [...(codByOrder.get(entry.orderId) ?? []), entry]);
    if (entry.ownerType === "driver" && entry.ownerId === fixture.driverId && entry.type === "driver_earning") {
      payByOrder.set(entry.orderId, [...(payByOrder.get(entry.orderId) ?? []), entry]);
    }
  }
  const baseline: DriverLedgerBaseline = {
    driverId: fixture.driverId,
    createdAt: "2026-11-09T00:00:00.000Z",
    createdBy: "fixture",
    measuredDiffCop: 0,
    settlements: Object.fromEntries(fixture.settlements.map((s) => [s.id, rebuildHistoricalCharges(s, codByOrder, payByOrder)]))
  };
  const context: DriverLedgerContext = {
    driverId: fixture.driverId,
    settlements: fixture.settlements.map((s) => ({ id: s.id, status: s.status, orderIds: s.orderIds })),
    baseline,
    holds: null
  };
  const tracking = new Map(fixture.orders.map((o) => [o.id, o.trackingCode]));
  const idOf = (code: string) => fixture.orders.find((o) => o.trackingCode === code)!.id;
  const chargedByOrder = (orderId: string) =>
    Object.values(baseline.settlements).flat().filter((r) => r.orderId === orderId).reduce((a, r) => a + r.chargedCop, 0);
  return { fixture, codByOrder, payByOrder, baseline, context, tracking, idOf, chargedByOrder };
}

/** La regla vieja (`computeDriverCashSummary` antes de la 038), copiada como referencia: por pedido,
 * max(0, recaudo − TODO el pago del pedido), con los asientos que existian al recalcular el corte. */
function legacyExpected(codEntries: WalletEntryDoc[] = [], payEntries: WalletEntryDoc[] = [], until: string): number {
  const sum = (list: WalletEntryDoc[]) => list.filter((e) => e.createdAt <= until).reduce((a, e) => a + e.amountCop, 0);
  return Math.max(0, sum(codEntries) - sum(payEntries));
}

describe("casos reales de la spec 038 (RNF_03)", () => {
  const cases = [
    { name: "reversa neteada en el corte nuevo", tracking: "KNT-003259", raw: case003259, excess: 78900 },
    { name: "recaudo borrado por una correccion", tracking: "KNT-004540", raw: case004540, excess: 78900 },
    { name: "pedido cobrado en dos cortes", tracking: "KNT-002682", raw: case002682, excess: 93900 },
    { name: "pago descontado dos veces", tracking: "KNT-002965", raw: case002965, excess: -8000 }
  ];

  for (const testCase of cases) {
    describe(`${testCase.tracking}: ${testCase.name}`, () => {
      const { fixture, codByOrder, payByOrder, context, idOf, chargedByOrder } = load(testCase.raw);
      const orderId = idOf(testCase.tracking);
      const owed = orderOwedByDriver(fixture.entries, fixture.driverId).get(orderId)?.owedCop ?? 0;

      it("la regla vieja cobro de mas (o de menos) exactamente la diferencia de §1", () => {
        expect(chargedByOrder(orderId) - owed).toBe(testCase.excess);
        expect(fixture.expected).toEqual([expect.objectContaining({ trackingCode: testCase.tracking, excessCop: testCase.excess })]);
      });

      it("cada asignacion guardada la reproduce la regla vieja, salvo si una correccion borro el recaudo", () => {
        for (const settlement of fixture.settlements) {
          const allocation = settlement.cashAllocations?.find((a) => a.orderId === orderId);
          if (!allocation) continue;
          const legacy = legacyExpected(codByOrder.get(orderId), payByOrder.get(orderId), lastRecalculatedAt(settlement));
          if (testCase.tracking === "KNT-004540") {
            // Causa 2: el asiento de recaudo ya no existe; desde los asientos no se puede reconstruir.
            // Por eso RF_03 exige que el corte guarde su cifra y la foto la toma de la asignacion.
            expect(legacy).not.toBe(allocation.expectedCop);
          } else {
            expect(legacy).toBe(allocation.expectedCop);
          }
        }
      });

      it("con la regla nueva el siguiente corte devuelve (o cobra) la diferencia una sola vez", () => {
        const corte = computeDriverCorte({ settlementId: "NEXT", orderIds: [orderId], ownEntryIds: [], entries: fixture.entries, context });
        expect(corte.charges[0].chargedCop).toBe(-testCase.excess);
        const after = { ...context, settlements: [...context.settlements, { id: "NEXT", status: "reconciled", orderIds: [orderId], cashCharges: corte.charges }] };
        const again = computeDriverCorte({ settlementId: "NEXT2", orderIds: [orderId], ownEntryIds: [], entries: fixture.entries, context: after });
        expect(again.charges[0].chargedCop).toBe(0);
      });
    });
  }
});

describe("los 16 pedidos de §1 (RF_05b)", () => {
  const { fixture, codByOrder, payByOrder, baseline, context, tracking, idOf, chargedByOrder } = load(driver16);
  const owed = orderOwedByDriver(fixture.entries, fixture.driverId);

  it("las 16 filas: cobrado, debido y diferencia, pedido a pedido", () => {
    expect(fixture.expected).toHaveLength(16);
    for (const row of fixture.expected) {
      expect({ tracking: row.trackingCode, charged: chargedByOrder(row.orderId), due: owed.get(row.orderId)?.owedCop ?? 0 }).toEqual({
        tracking: row.trackingCode,
        charged: row.chargedCop,
        due: row.dueCop
      });
    }
    expect(fixture.expected.reduce((a, r) => a + r.excessCop, 0)).toBe(686200);
    expect(fixture.expected.filter((r) => r.excessCop > 0).reduce((a, r) => a + r.excessCop, 0)).toBe(734200);
  });

  it("cada pedido con asignacion reconstruye su expectedCop", () => {
    for (const settlement of fixture.settlements) {
      const rows = new Map(baseline.settlements[settlement.id].map((r) => [r.orderId, r]));
      for (const allocation of settlement.cashAllocations ?? []) {
        if (!settlement.orderIds.includes(allocation.orderId)) continue;
        expect({ corte: settlement.id, order: allocation.orderId, cop: rows.get(allocation.orderId)?.chargedCop }).toEqual({
          corte: settlement.id,
          order: allocation.orderId,
          cop: allocation.expectedCop
        });
      }
    }
  });

  it("KNT-000056: el corte que no lo lista entre sus asignaciones cuadra su total con min(0, ...)", () => {
    const orderId = idOf("KNT-000056");
    // Son dos cortes (2026-05-29 y el siguiente): en ambos esta en orderIds y no entre las asignaciones.
    const whole = fixture.settlements.filter((s) => !s.trimmed && s.orderIds.includes(orderId));
    expect(whole.length).toBeGreaterThanOrEqual(1);
    for (const corte of whole) {
      const rows = rebuildHistoricalCharges(corte, codByOrder, payByOrder);
      expect(rows.find((r) => r.orderId === orderId)).toMatchObject({ source: "rebuilt" });
      expect(rows.find((r) => r.orderId === orderId)!.chargedCop).toBeLessThanOrEqual(0);
      expect({ corte: corte.id, total: Math.max(0, rows.reduce((a, r) => a + r.chargedCop, 0)) }).toEqual({ corte: corte.id, total: corte.cashExpectedCop });
    }
  });

  it("con las retenciones de RF_17 desplegar no cambia nada; liberarlas devuelve exactamente la diferencia", () => {
    const sixteen = fixture.expected.map((r) => r.orderId);
    const recalculatedAt = new Map(fixture.settlements.map((s) => [s.id, lastRecalculatedAt(s)]));
    const holds = computeHolds({ entries: fixture.entries, context, recalculatedAt });
    expect(new Map(holds.map((h) => [tracking.get(h.orderId), h.holdCop]))).toEqual(
      new Map(fixture.expected.map((r) => [r.trackingCode, r.excessCop]))
    );

    const held = { ...context, holds: { driverId: fixture.driverId, createdAt: "", holds } };
    const frozen = computeDriverCorte({ settlementId: "NEXT", orderIds: sixteen, ownEntryIds: [], entries: fixture.entries, context: held });
    expect(frozen.charges.every((c) => c.chargedCop === 0)).toBe(true);

    const released = { ...held, holds: { ...held.holds, holds: holds.map((h) => ({ ...h, releasedAt: "2026-11-10T00:00:00.000Z", releasedCop: h.holdCop })) } };
    const refund = computeDriverCorte({ settlementId: "NEXT", orderIds: sixteen, ownEntryIds: [], entries: fixture.entries, context: released });
    expect(refund.chargedTotalCop).toBe(-686200);
    expect(refund).toMatchObject({ cashExpectedCop: 0, creditOutCop: 686200 });
  });
});

/**
 * Spec 038 · T19: `buildDriverLedgerSnapshot` es lo que escribe `scripts/snapshot-038-baseline.js` (RF_05b,
 * RF_17). Con los datos reales del domiciliario de la spec da las 16 retenciones y los 686.200 de la medicion.
 */
describe("spec 038 · T19 · la foto historica de un domiciliario real", () => {
  const { fixture, baseline, tracking } = load(driver16);

  it("las retenciones son los 16 pedidos de la medicion y suman 686.200", async () => {
    const { buildDriverLedgerSnapshot } = await import("../../functions/src/driver-cash-ledger");
    const snapshot = buildDriverLedgerSnapshot({
      driverId: fixture.driverId,
      settlements: fixture.settlements,
      entries: fixture.entries,
      now: "2026-11-09T12:00:00.000Z",
      createdBy: "prueba"
    });
    expect(new Map(snapshot.holds.holds.map((h) => [tracking.get(h.orderId), h.holdCop]))).toEqual(
      new Map(fixture.expected.map((r) => [r.trackingCode, r.excessCop]))
    );
    expect(snapshot.totalHoldCop).toBe(686200);
    expect(snapshot.baseline).toEqual({ ...baseline, createdAt: "2026-11-09T12:00:00.000Z", createdBy: "prueba", measuredDiffCop: 686200 });
    expect(snapshot.holds).toMatchObject({ driverId: fixture.driverId, createdAt: "2026-11-09T12:00:00.000Z" });
  });
});

/**
 * Spec 038 · T20 (analyze B2): la compensacion del domiciliario real con la opcion A, sobre los datos del
 * 2026-11-09. Previsualizar no escribe; aplicar libera exactamente lo previsualizado, con autor y motivo.
 */
describe("spec 038 · T20 · compensacion del domiciliario real (opcion A)", () => {
  const { fixture, context, idOf } = load(driver16);
  const recalculatedAt = new Map(fixture.settlements.map((s) => [s.id, lastRecalculatedAt(s)]));
  const holds = { driverId: fixture.driverId, createdAt: "2026-11-09T12:00:00.000Z", holds: computeHolds({ entries: fixture.entries, context, recalculatedAt }) };
  const held = { ...context, holds };
  const reason = "pendiente de aclarar si paso a prepago (spec §5)";
  const exclude = new Map([[idOf("KNT-005724"), reason], [idOf("KNT-006347"), reason]]);

  it("excluyendo KNT-005724 y KNT-006347: $632.200 a compensar y esos dos listados como pendientes ($54.000)", async () => {
    const { planDriverCompensation } = await import("../../functions/src/driver-cash-ledger");
    const plan = planDriverCompensation({ entries: fixture.entries, context: held, exclude });
    expect(plan.totalCop).toBe(632200);
    expect(plan.excludedCop).toBe(54000);
    expect(plan.rows.filter((row) => row.excluded).map((row) => [row.orderId, row.releaseCop, row.excludedReason]).sort()).toEqual(
      [[idOf("KNT-005724"), 27000, reason], [idOf("KNT-006347"), 27000, reason]].sort()
    );
    expect(plan.rows).toHaveLength(16);
    // Sin la exclusion es la diferencia entera de la medicion.
    expect(planDriverCompensation({ entries: fixture.entries, context: held }).totalCop).toBe(686200);
  });

  it("aplicar libera exactamente las 14 filas no excluidas, con autor y motivo; aplicar otra vez no libera nada", async () => {
    const { applyCompensationPlan, planDriverCompensation } = await import("../../functions/src/driver-cash-ledger");
    const plan = planDriverCompensation({ entries: fixture.entries, context: held, exclude });
    const approval = { approvedBy: "Responsable", reason: "compensacion historica 038", at: "2026-11-10T09:00:00.000Z", compensationId: "cmp-1", expectedFingerprint: plan.fingerprint };
    const { holds: next, audit } = applyCompensationPlan(holds, plan, approval);
    const released = next.holds.filter((hold) => hold.releasedAt);
    expect(released).toHaveLength(14);
    expect(released.every((hold) => hold.releasedBy === "Responsable" && hold.compensationId === "cmp-1" && hold.releasedCop === hold.holdCop)).toBe(true);
    expect(released.reduce((sum, hold) => sum + (hold.releasedCop ?? 0), 0)).toBe(632200);
    expect(next.holds.filter((hold) => !hold.releasedAt).map((hold) => hold.orderId).sort()).toEqual([idOf("KNT-005724"), idOf("KNT-006347")].sort());
    expect(audit).toMatchObject({ approvedBy: "Responsable", reason: "compensacion historica 038", totalCop: 632200, excludedOrderIds: expect.arrayContaining([idOf("KNT-005724"), idOf("KNT-006347")]) });

    const again = planDriverCompensation({ entries: fixture.entries, context: { ...held, holds: next }, exclude });
    expect(again.totalCop).toBe(0);
    expect(again.rows.map((row) => row.orderId).sort()).toEqual([idOf("KNT-005724"), idOf("KNT-006347")].sort());
  });
});
