/**
 * Spec 038 · T20 (RF_13-RF_16): `scripts/compensate-038.js` previsualiza la compensacion historica de un
 * domiciliario y, solo con `--apply` y la aprobacion del responsable, la aplica.
 *
 * - Por defecto no escribe: imprime pedido, cobrado, debido, diferencia y por donde entraria (RF_13).
 * - `--exclude KNT-...,KNT-...` deja fuera esos pedidos y los lista como pendientes (RF_16).
 * - `--apply` exige `--approved-by`, `--reason` y `--fingerprint` (la huella que imprimio la previsualizacion):
 *   dentro de una transaccion vuelve a leer y a previsualizar, y si la huella cambio aborta sin escribir
 *   (RF_14: se aplica exactamente lo que se aprobo). Escribe las retenciones liberadas y un registro de
 *   auditoria con `create`; no toca ningun corte.
 *
 * El script carga la regla de `functions/lib` (compilada): hace falta `cd functions && npm run build`.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type ScriptArgs = {
  driverId: string | null;
  apply: boolean;
  approvedBy: string | null;
  reason: string | null;
  fingerprint: string | null;
  exclude: string[];
  excludeReason: string;
};
type Loaded = { context: Record<string, unknown>; entries: Array<Record<string, unknown>> };
type CompensateScript = {
  parseArgs: (argv: string[]) => ScriptArgs;
  resolveExclusions: (trackingCodes: string[], orderIdByTracking: ReadonlyMap<string, string>, reason: string) => Map<string, string>;
  applyRefusal: (args: ScriptArgs) => string | null;
  applyCompensation: (input: {
    db: unknown;
    driverId: string;
    exclude: ReadonlyMap<string, string>;
    approval: { approvedBy: string; reason: string; at: string; compensationId: string; expectedFingerprint: string };
    load: (tx: unknown) => Promise<Loaded>;
  }) => Promise<{ totalCop: number; releasedOrderIds: string[] }>;
};

const requireCjs = createRequire(import.meta.url);
const load = (): CompensateScript => requireCjs("../../scripts/compensate-038.js") as CompensateScript;
const ledger = () => requireCjs("../../functions/lib/driver-cash-ledger.js") as typeof import("../../functions/src/driver-cash-ledger");

// d1: un corte viejo le cobro 50.000 por o1 y o1 hoy debe 40.000 (10.000 a su favor); o2, 8.000 en su contra.
function world() {
  const entries = [
    { id: "c1", ownerType: "seller", ownerId: "s1", orderId: "o1", type: "cod_revenue", amountCop: 40000, description: "", createdAt: "2026-09-30T00:00:00.000Z" },
    { id: "c2", ownerType: "seller", ownerId: "s1", orderId: "o2", type: "cod_revenue", amountCop: 30000, description: "", createdAt: "2026-09-30T00:00:00.000Z" }
  ];
  const settlements = [{ id: "A", status: "reconciled", orderIds: ["o1", "o2"] }];
  const baseline = {
    driverId: "d1", createdAt: "", createdBy: "t", measuredDiffCop: 2000,
    settlements: { A: [{ orderId: "o1", chargedCop: 50000, driverPayCop: 0, source: "allocation" }, { orderId: "o2", chargedCop: 22000, driverPayCop: 0, source: "allocation" }] }
  };
  const holds = { driverId: "d1", createdAt: "", holds: [{ orderId: "o1", holdCop: 10000 }, { orderId: "o2", holdCop: -8000 }] };
  return { context: { driverId: "d1", settlements, baseline, holds }, entries };
}

/** Doble de Firestore: registra lo que la transaccion escribiria. */
function fakeDb() {
  const writes: Array<{ op: string; path: string; data: Record<string, unknown> }> = [];
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const pending: typeof writes = [];
      const tx = {
        set: (ref: { path: string }, data: Record<string, unknown>) => { pending.push({ op: "set", path: ref.path, data }); },
        create: (ref: { path: string }, data: Record<string, unknown>) => { pending.push({ op: "create", path: ref.path, data }); },
        update: (ref: { path: string }, data: Record<string, unknown>) => { pending.push({ op: "update", path: ref.path, data }); }
      };
      const result = await fn(tx);
      writes.push(...pending);
      return result;
    }
  };
  return { db, writes };
}

describe("spec 038 · T20 · script de compensacion", () => {
  it("sin flags previsualiza; --apply con aprobacion, motivo y huella", () => {
    const { parseArgs } = load();
    expect(parseArgs(["driver-x"])).toEqual({ driverId: "driver-x", apply: false, approvedBy: null, reason: null, fingerprint: null, exclude: [], excludeReason: "excluido por el responsable" });
    expect(parseArgs(["driver-x", "--apply", "--approved-by", "Camilo", "--reason", "historico 038", "--fingerprint", "abc123", "--exclude", "KNT-005724,KNT-006347", "--exclude-reason", "por aclarar"]))
      .toEqual({ driverId: "driver-x", apply: true, approvedBy: "Camilo", reason: "historico 038", fingerprint: "abc123", exclude: ["KNT-005724", "KNT-006347"], excludeReason: "por aclarar" });
  });

  it("--apply se niega sin domiciliario, aprobacion, motivo o huella", () => {
    const { parseArgs, applyRefusal } = load();
    expect(applyRefusal(parseArgs(["d1"]))).toMatch(/previsualizacion/i);
    expect(applyRefusal(parseArgs(["--apply"]))).toMatch(/domiciliario/);
    expect(applyRefusal(parseArgs(["d1", "--apply"]))).toMatch(/--approved-by/);
    expect(applyRefusal(parseArgs(["d1", "--apply", "--approved-by", "C"]))).toMatch(/--reason/);
    expect(applyRefusal(parseArgs(["d1", "--apply", "--approved-by", "C", "--reason", "r"]))).toMatch(/--fingerprint/);
    expect(applyRefusal(parseArgs(["d1", "--apply", "--approved-by", "C", "--reason", "r", "--fingerprint", "f"]))).toBeNull();
  });

  it("una exclusion por codigo de seguimiento que no es del domiciliario aborta (no se excluye en silencio otra cosa)", () => {
    const { resolveExclusions } = load();
    const byTracking = new Map([["KNT-1", "o1"]]);
    expect(resolveExclusions(["KNT-1"], byTracking, "r")).toEqual(new Map([["o1", "r"]]));
    expect(() => resolveExclusions(["KNT-9"], byTracking, "r")).toThrow(/KNT-9/);
  });

  it("aplicar con la huella previsualizada libera lo no excluido y audita; no toca cortes", async () => {
    const { applyCompensation } = load();
    const { planDriverCompensation } = ledger();
    const data = world();
    const exclude = new Map([["o2", "por aclarar"]]);
    const plan = planDriverCompensation({ entries: data.entries as never, context: data.context as never, exclude });
    const { db, writes } = fakeDb();
    const result = await applyCompensation({
      db, driverId: "d1", exclude,
      approval: { approvedBy: "Camilo", reason: "historico 038", at: "2026-11-10T09:00:00.000Z", compensationId: "cmp-1", expectedFingerprint: plan.fingerprint },
      load: async () => world()
    });
    expect(result).toEqual({ totalCop: 10000, releasedOrderIds: ["o1"] });
    expect(writes.map((write) => [write.op, write.path])).toEqual([["set", "driverCashHolds/d1"], ["create", "driverCompensations/cmp-1"]]);
    const savedHolds = writes[0].data as { holds: Array<{ orderId: string; releasedBy?: string; releasedCop?: number }> };
    expect(savedHolds.holds.find((hold) => hold.orderId === "o1")).toMatchObject({ releasedBy: "Camilo", releasedCop: 10000, compensationId: "cmp-1" });
    expect(savedHolds.holds.find((hold) => hold.orderId === "o2")?.releasedBy).toBeUndefined();
    expect(writes[1].data).toMatchObject({ approvedBy: "Camilo", reason: "historico 038", totalCop: 10000, excludedOrderIds: ["o2"] });
    expect(writes.some((write) => write.path.startsWith("settlements/"))).toBe(false);
  });

  it("si los datos cambiaron desde la previsualizacion (otra huella), aborta sin escribir nada", async () => {
    const { applyCompensation } = load();
    const { db, writes } = fakeDb();
    await expect(applyCompensation({
      db, driverId: "d1", exclude: new Map(),
      approval: { approvedBy: "Camilo", reason: "r", at: "2026-11-10T09:00:00.000Z", compensationId: "cmp-2", expectedFingerprint: "00000000" },
      load: async () => world()
    })).rejects.toThrow(/huella/);
    expect(writes).toEqual([]);
  });

  it("sin documento de retenciones no hay nada que compensar: aborta", async () => {
    const { applyCompensation } = load();
    const { db, writes } = fakeDb();
    const data = world();
    await expect(applyCompensation({
      db, driverId: "d1", exclude: new Map(),
      approval: { approvedBy: "C", reason: "r", at: "2026-11-10T09:00:00.000Z", compensationId: "cmp-3", expectedFingerprint: "x" },
      load: async () => ({ ...data, context: { ...data.context, holds: null } })
    })).rejects.toThrow(/retenciones/);
    expect(writes).toEqual([]);
  });
});
