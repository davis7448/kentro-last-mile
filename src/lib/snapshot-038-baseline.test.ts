/**
 * Spec 038 · T19: `scripts/snapshot-038-baseline.js` escribe la foto historica (RF_05b) y las retenciones
 * (RF_17) de cada domiciliario. Por defecto NO escribe. Con `--write` exige `--approved-by` y las cifras de la
 * medicion de ese dia (`--expect-total`, `--expect-orders`), y aborta si las retenciones no coinciden. Nunca
 * pisa una foto existente: la foto se escribe una vez.
 *
 * El script carga la regla de `functions/lib` (compilada), asi que esta prueba necesita `cd functions && npm run
 * build`, como las guardas de la 026.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type ScriptArgs = { write: boolean; approvedBy: string | null; expectTotalCop: number | null; expectOrders: number | null; driverId: string | null };
type SnapshotPlan = {
  driverId: string; baseline: Record<string, unknown>; holds: { holds: Array<{ orderId: string; holdCop: number }> }; totalHoldCop: number; settlementCount: number;
};
type SnapshotScript = {
  parseArgs: (argv: string[]) => ScriptArgs;
  planSnapshots: (input: { settlements: Array<Record<string, unknown>>; entries: Array<Record<string, unknown>>; now: string; createdBy: string; driverId?: string | null }) => SnapshotPlan[];
  writeRefusal: (plans: SnapshotPlan[], args: ScriptArgs) => string | null;
  writeSnapshots: (db: unknown, plans: SnapshotPlan[]) => Promise<number>;
};

const requireCjs = createRequire(import.meta.url);
const load = (): SnapshotScript => requireCjs("../../scripts/snapshot-038-baseline.js") as SnapshotScript;

const corte = (id: string, ownerId: string, expectedCop: number, orderId: string) => ({
  id, kind: "driver", ownerId, status: "reconciled", orderIds: [orderId], createdAt: "2026-10-01T00:00:00.000Z",
  cashExpectedCop: expectedCop, cashAllocations: [{ orderId, expectedCop, receivedCop: expectedCop, covered: true }]
});
const cod = (orderId: string, amountCop: number) =>
  ({ id: `c-${orderId}`, ownerType: "seller", ownerId: "s1", orderId, type: "cod_revenue", amountCop, description: "", createdAt: "2026-09-30T00:00:00.000Z" });

// d1 cobro 50.000 por o1 y el recaudo hoy es 40.000: 10.000 retenidos. d2 cuadra.
const world = {
  settlements: [corte("A", "d1", 50000, "o1"), corte("B", "d2", 30000, "o2"), { id: "S", kind: "seller", ownerId: "s1", orderIds: ["o1"] }],
  entries: [cod("o1", 40000), cod("o2", 30000)],
  now: "2026-11-09T12:00:00.000Z",
  createdBy: "dry-run"
};

describe("spec 038 · T19 · script de la foto historica", () => {
  it("sin flags no escribe; --write con aprobacion y cifras esperadas", () => {
    const { parseArgs } = load();
    expect(parseArgs([])).toEqual({ write: false, approvedBy: null, expectTotalCop: null, expectOrders: null, driverId: null });
    expect(parseArgs(["--write", "--approved-by", "Camilo", "--expect-total", "686200", "--expect-orders", "16", "driver-x"]))
      .toEqual({ write: true, approvedBy: "Camilo", expectTotalCop: 686200, expectOrders: 16, driverId: "driver-x" });
  });

  it("un plan por domiciliario con cortes de domiciliario, con su foto y sus retenciones", () => {
    const plans = load().planSnapshots(world);
    expect(plans.map((plan) => [plan.driverId, plan.settlementCount, plan.totalHoldCop])).toEqual([["d1", 1, 10000], ["d2", 1, 0]]);
    expect(plans[0].holds.holds).toEqual([{ orderId: "o1", holdCop: 10000 }]);
    expect(plans[0].baseline).toMatchObject({ driverId: "d1", createdBy: "dry-run", measuredDiffCop: 10000 });
  });

  it("--write se niega sin aprobacion, sin cifras esperadas o si no coinciden con la medicion", () => {
    const { parseArgs, planSnapshots, writeRefusal } = load();
    const plans = planSnapshots(world);
    expect(writeRefusal(plans, parseArgs([]))).toMatch(/en seco/i);
    expect(writeRefusal(plans, parseArgs(["--write"]))).toMatch(/--approved-by/);
    expect(writeRefusal(plans, parseArgs(["--write", "--approved-by", "Camilo"]))).toMatch(/--expect-total/);
    expect(writeRefusal(plans, parseArgs(["--write", "--approved-by", "Camilo", "--expect-total", "9999", "--expect-orders", "1"]))).toMatch(/no coincide/);
    expect(writeRefusal(plans, parseArgs(["--write", "--approved-by", "Camilo", "--expect-total", "10000", "--expect-orders", "2"]))).toMatch(/no coincide/);
    expect(writeRefusal(plans, parseArgs(["--write", "--approved-by", "Camilo", "--expect-total", "10000", "--expect-orders", "1"]))).toBeNull();
  });

  it("escribe con create (nunca pisa una foto existente): dos documentos por domiciliario en un solo lote", async () => {
    const { planSnapshots, writeSnapshots } = load();
    const created: string[] = [];
    let commits = 0;
    const db = {
      collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
      batch: () => ({
        create: (ref: { path: string }) => { created.push(ref.path); },
        set: () => { throw new Error("set prohibido: la foto se escribe una vez"); },
        commit: async () => { commits += 1; }
      })
    };
    expect(await writeSnapshots(db, planSnapshots(world))).toBe(4);
    expect(created).toEqual(["driverLedgerBaselines/d1", "driverCashHolds/d1", "driverLedgerBaselines/d2", "driverCashHolds/d2"]);
    expect(commits).toBe(1);
  });
});
