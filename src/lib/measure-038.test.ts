/**
 * Spec 038 · T21 (RF_05b, RNF_01): `specs/038_measure.js` deja de llevar su copia de la regla (importa
 * `rebuildHistoricalCharges` y `orderOwedByDriver` de `functions/lib`) y anade dos comprobaciones de solo lectura:
 *
 * - `--check`: falla si un solo corte viejo no cuadra su `cashExpectedCop` guardado con la reconstruccion, o si un
 *   pedido con asignacion no reconstruye exactamente su cifra.
 * - `--deploy-check` (RNF_01): para cada corte pendiente y para el siguiente corte de cada domiciliario, el
 *   esperado con la regla vieja frente a la nueva CON las retenciones que escribiria la foto; y el conjunto de
 *   "recibidos" viejo frente al nuevo con esos cortes ya recalculados. Las dos diferencias deben ser 0.
 *
 * El script carga la regla de `functions/lib` (compilada): hace falta `cd functions && npm run build`.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import driver16 from "./fixtures/038-driver-16.json";

type Entry = Record<string, unknown>;
type Corte = Record<string, unknown>;
type MeasureRow = { orderId: string; chargedCop: number; dueCop: number; excessCop: number };
type DriverReport = { driverId: string; rows: MeasureRow[]; perOrderExcess: number; unverifiable: Array<{ id: string }>; allocationMismatches: Array<{ settlementId: string; orderId: string }> };
type DeployCheck = {
  pending: Array<{ settlementId: string; oldCop: number; newCop: number; deltaCop: number }>;
  next: { oldOrderIds: string[]; newOrderIds: string[]; oldCop: number; newCop: number; deltaCop: number };
  simulatedCortes: Corte[];
};
type MeasureScript = {
  measureDriver: (input: { driverId: string; cortes: Corte[]; entries: Entry[]; orders: Map<string, Record<string, unknown>> }) => DriverReport;
  checkFailures: (reports: DriverReport[]) => string[];
  deployCheckDriver: (input: { driverId: string; cortes: Corte[]; entries: Entry[]; orderMeta: Map<string, Record<string, unknown>>; now: string }) => DeployCheck;
  receivedDiff: (input: { settlements: Corte[]; simulated: Corte[]; entries: Entry[] }) => { added: string[]; removed: string[] };
};

const requireCjs = createRequire(import.meta.url);
const load = (): MeasureScript => requireCjs("../../specs/038_measure.js") as MeasureScript;

let seq = 0;
const cod = (orderId: string, amountCop: number, createdAt = "2026-09-30T00:00:00.000Z"): Entry =>
  ({ id: `c${++seq}`, ownerType: "seller", ownerId: "s1", orderId, type: "cod_revenue", amountCop, description: "", createdAt });
const pay = (orderId: string, amountCop: number, settlementId?: string, createdAt = "2026-09-30T00:00:00.000Z"): Entry =>
  ({ id: `p${++seq}`, ownerType: "driver", ownerId: "d1", orderId, type: "driver_earning", amountCop, description: "", createdAt, ...(settlementId ? { settlementId } : {}) });

/**
 * d1. A (conciliado) le cobro 50.000 por o1, cuyo recaudo luego se corrigio a 40.000: diferencia historica que la
 * foto retiene. P (pendiente) tiene o2 (30.000 - 5.000). o3 tiene un pago sin cortar: entra al siguiente corte.
 */
function world() {
  const payO2 = pay("o2", 5000, "P", "2026-11-01T00:00:00.000Z");
  const entries = [cod("o1", 40000), cod("o2", 30000, "2026-11-01T00:00:00.000Z"), payO2, cod("o3", 20000, "2026-11-05T00:00:00.000Z"), pay("o3", 5000, undefined, "2026-11-05T00:00:00.000Z")];
  const cortes: Corte[] = [
    { id: "A", kind: "driver", ownerId: "d1", status: "reconciled", orderIds: ["o1"], walletEntryIds: [], createdAt: "2026-10-01T00:00:00.000Z", reconciledAt: "2026-10-02T00:00:00.000Z",
      cashExpectedCop: 50000, cashReceivedCop: 50000, cashPendingCop: 0, cashAllocations: [{ orderId: "o1", expectedCop: 50000, receivedCop: 50000, covered: true }] },
    { id: "P", kind: "driver", ownerId: "d1", status: "pending", orderIds: ["o2"], walletEntryIds: [payO2.id], createdAt: "2026-11-02T00:00:00.000Z",
      cashExpectedCop: 25000, cashReceivedCop: 25000, cashPendingCop: 0, cashReceipts: [{ amountCop: 25000, receivedAt: "2026-11-03T00:00:00.000Z" }],
      cashAllocations: [{ orderId: "o2", expectedCop: 25000, receivedCop: 25000, covered: true }] }
  ];
  const orderMeta = new Map(["o1", "o2", "o3"].map((id, index) => [id, { createdAt: `2026-09-0${index + 1}T00:00:00.000Z`, trackingCode: `KNT-${id}` }]));
  return { entries, cortes, orderMeta };
}

describe("spec 038 · T21 · medicion con el modulo", () => {
  it("con los datos reales: los 16 pedidos de la medicion, 686.200 por pedido", () => {
    const fixture = driver16 as unknown as { driverId: string; settlements: Corte[]; entries: Entry[]; orders: Array<{ id: string; trackingCode: string }>; expected: Array<{ orderId: string; excessCop: number }> };
    const report = load().measureDriver({
      driverId: fixture.driverId,
      cortes: fixture.settlements,
      entries: fixture.entries,
      orders: new Map(fixture.orders.map((order) => [order.id, order]))
    });
    expect(new Map(report.rows.map((row) => [row.orderId, row.excessCop]))).toEqual(new Map(fixture.expected.map((row) => [row.orderId, row.excessCop])));
    expect(report.perOrderExcess).toBe(686200);
  });

  it("--check en verde cuando todo cuadra; falla con el corte que no cuadra", () => {
    const { measureDriver, checkFailures } = load();
    const { entries, cortes } = world();
    const ok = measureDriver({ driverId: "d1", cortes, entries, orders: new Map() });
    expect(checkFailures([ok])).toEqual([]);
    const broken = cortes.map((corte) => (corte.id === "A" ? { ...corte, cashExpectedCop: 51000 } : corte));
    const failures = checkFailures([measureDriver({ driverId: "d1", cortes: broken, entries, orders: new Map() })]);
    expect(failures.join("\n")).toMatch(/A/);
  });

  it("--deploy-check: con las retenciones de la foto, el pendiente y el siguiente corte no cambian", () => {
    const { deployCheckDriver } = load();
    const { entries, cortes, orderMeta } = world();
    const check = deployCheckDriver({ driverId: "d1", cortes, entries, orderMeta, now: "2026-11-10T00:00:00.000Z" });
    expect(check.pending).toEqual([{ settlementId: "P", oldCop: 25000, newCop: 25000, deltaCop: 0 }]);
    // o1 no vuelve solo al siguiente corte: su diferencia historica esta retenida (RF_17).
    expect(check.next).toEqual({ oldOrderIds: ["o3"], newOrderIds: ["o3"], oldCop: 15000, newCop: 15000, deltaCop: 0 });
    expect(check.simulatedCortes.map((corte) => [corte.id, Array.isArray(corte.cashCharges)])).toEqual([["P", true]]);
  });

  it("--deploy-check: un cambio posterior al ultimo recalculo del pendiente lo recogen igual las dos reglas", () => {
    const { deployCheckDriver } = load();
    const { entries, cortes, orderMeta } = world();
    // El recaudo de o2 se corrigio DESPUES del ultimo recalculo de P: la regla vieja no lo vio al guardar, pero
    // recalcularia con el; la nueva tambien. Los dos dan lo mismo: 20.000 - 5.000.
    const corrected = [...entries, cod("o2", -10000, "2026-11-08T00:00:00.000Z")];
    const check = deployCheckDriver({ driverId: "d1", cortes, entries: corrected, orderMeta, now: "2026-11-10T00:00:00.000Z" });
    expect(check.pending).toEqual([{ settlementId: "P", oldCop: 15000, newCop: 15000, deltaCop: 0 }]);
  });

  it("recibidos: viejo y nuevo iguales con el pendiente recalculado; un pedido que cambia sale listado", () => {
    const { deployCheckDriver, receivedDiff } = load();
    const { entries, cortes, orderMeta } = world();
    const check = deployCheckDriver({ driverId: "d1", cortes, entries, orderMeta, now: "2026-11-10T00:00:00.000Z" });
    expect(receivedDiff({ settlements: cortes, simulated: check.simulatedCortes, entries })).toEqual({ added: [], removed: [] });
    // Si el corte nuevo de P no cubriera o2, o2 dejaria de estar recibido.
    const uncovered = check.simulatedCortes.map((corte) => ({ ...corte, status: "pending", cashReceivedCop: 0, cashPendingCop: 25000, cashAllocations: [{ orderId: "o2", expectedCop: 25000, receivedCop: 0, covered: false }] }));
    expect(receivedDiff({ settlements: cortes, simulated: uncovered, entries })).toEqual({ added: [], removed: ["o2"] });
  });
});
