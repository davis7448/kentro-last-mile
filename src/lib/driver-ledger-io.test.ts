import { describe, expect, it } from "vitest";
// Spec 038 T11: leer el contexto del domiciliario y detectar recalculos cruzados (RF_04b, RF_05b, RNF_04).
import {
  assertNoCrossedRecalc,
  CrossedRecalcError,
  loadDriverLedgerContext,
  loadDriverLedgerSnapshot,
  MissingBaselineError,
  recalculateDriverSettlement
} from "../../functions/src/driver-ledger-io";

const DRIVER = "driver-1";

type FakeDoc = { id: string; data: Record<string, unknown>; updateTime: string };

/** Firestore falso: solo lo que usa el cargador, y cuenta cada lectura (consulta o documento). */
function fakeDb(state: { settlements: FakeDoc[]; docs: Record<string, Record<string, unknown> | undefined>; collections?: Record<string, FakeDoc[]> }) {
  const reads: string[] = [];
  const snapshotOf = (doc: FakeDoc) => ({
    id: doc.id,
    data: () => doc.data,
    updateTime: { toDate: () => new Date(doc.updateTime) }
  });
  const db = {
    collection(name: string) {
      const filters: Array<[string, unknown]> = [];
      const query = {
        where(field: string, _op: string, value: unknown) {
          filters.push([field, value]);
          return query;
        },
        async get() {
          reads.push(`query:${name}:${filters.map(([f, v]) => `${f}=${v}`).join(",")}`);
          const pool = name === "settlements" ? state.settlements : (state.collections?.[name] ?? []);
          const docs = pool.filter((d) => filters.every(([f, v]) => d.data[f] === v)).map(snapshotOf);
          return { docs };
        },
        doc(id: string) {
          return {
            async get() {
              reads.push(`doc:${name}/${id}`);
              const data = state.docs[`${name}/${id}`];
              return { id, exists: data !== undefined, data: () => data };
            }
          };
        }
      };
      return query;
    }
  };
  return { db, reads };
}

const corte = (id: string, over: Record<string, unknown> = {}, updateTime = "2026-11-10T10:00:00.000Z"): FakeDoc => ({
  id,
  updateTime,
  data: { kind: "driver", ownerId: DRIVER, status: "reconciled", orderIds: ["o1"], ...over }
});

const baselineDoc = { driverId: DRIVER, createdAt: "2026-11-10T00:00:00.000Z", createdBy: "responsable", measuredDiffCop: 686202, settlements: { OLD: [] } };
const holdsDoc = { driverId: DRIVER, createdAt: "2026-11-10T00:00:00.000Z", holds: [{ orderId: "o1", holdCop: 27000 }] };

describe("loadDriverLedgerContext", () => {
  it("lee los cortes del domiciliario, su foto y sus retenciones: tres lecturas (RNF_04)", async () => {
    const { db, reads } = fakeDb({
      settlements: [
        corte("OLD"),
        corte("NEW", { status: "pending", cashCharges: [{ orderId: "o1", codCop: 0, driverPayCop: 0, chargedCop: 0, codSeenCop: 0 }], creditInCop: 0, creditOutCop: 500 }),
        corte("OTHER", { ownerId: "driver-2" }),
        corte("SELLER", { kind: "seller" })
      ],
      docs: { [`driverLedgerBaselines/${DRIVER}`]: baselineDoc, [`driverCashHolds/${DRIVER}`]: holdsDoc }
    });
    const context = await loadDriverLedgerContext(db as never, DRIVER);
    expect(reads.sort()).toEqual(
      [`doc:driverCashHolds/${DRIVER}`, `doc:driverLedgerBaselines/${DRIVER}`, `query:settlements:kind=driver,ownerId=${DRIVER}`].sort()
    );
    expect(context.driverId).toBe(DRIVER);
    expect(context.settlements.map((s) => s.id)).toEqual(["OLD", "NEW"]);
    expect(context.settlements[1]).toMatchObject({ status: "pending", creditOutCop: 500, updateTime: "2026-11-10T10:00:00.000Z" });
    expect(context.settlements[0].cashCharges).toBeUndefined();
    expect(context.baseline).toEqual(baselineDoc);
    expect(context.holds).toEqual(holdsDoc);
  });

  it("con una transaccion, lee por ella (tx.get) y no por la base", async () => {
    const { db, reads } = fakeDb({ settlements: [corte("NEW", { cashCharges: [] })], docs: {} });
    const txReads: string[] = [];
    const tx = {
      async get(target: { get: () => Promise<unknown> }) {
        txReads.push("tx");
        return target.get();
      }
    };
    await loadDriverLedgerContext(db as never, DRIVER, tx as never);
    expect(txReads).toHaveLength(3);
    expect(reads).toHaveLength(3);
  });

  it("un domiciliario con cortes viejos y sin foto es un error explicito, no la regla vieja", async () => {
    const { db } = fakeDb({ settlements: [corte("OLD")], docs: {} });
    await expect(loadDriverLedgerContext(db as never, DRIVER)).rejects.toBeInstanceOf(MissingBaselineError);
  });

  it("un domiciliario nuevo (solo cortes nuevos, o ninguno) no necesita foto", async () => {
    const { db } = fakeDb({ settlements: [corte("NEW", { cashCharges: [] })], docs: {} });
    await expect(loadDriverLedgerContext(db as never, DRIVER)).resolves.toMatchObject({ baseline: null, holds: null });
    const empty = fakeDb({ settlements: [], docs: {} });
    await expect(loadDriverLedgerContext(empty.db as never, DRIVER)).resolves.toMatchObject({ settlements: [] });
  });
});

describe("assertNoCrossedRecalc (RF_04b)", () => {
  const ctx = (settlements: Array<{ id: string; status: string; updateTime?: string }>) => ({
    driverId: DRIVER,
    baseline: null,
    holds: null,
    settlements: settlements.map((s) => ({ ...s, orderIds: [] }))
  });

  it("nada cambio: no lanza", () => {
    const before = ctx([{ id: "A", status: "pending", updateTime: "t1" }, { id: "X", status: "pending", updateTime: "t1" }]);
    expect(() => assertNoCrossedRecalc(before, before, "X")).not.toThrow();
  });

  it("dos recalculos con el mismo contexto de fuera: el segundo detecta que otro corte pendiente cambio", () => {
    const before = ctx([{ id: "A", status: "pending", updateTime: "t1" }, { id: "X", status: "pending", updateTime: "t1" }]);
    const afterA = ctx([{ id: "A", status: "pending", updateTime: "t2" }, { id: "X", status: "pending", updateTime: "t1" }]);
    expect(() => assertNoCrossedRecalc(before, afterA, "X")).toThrow(CrossedRecalcError);
    try {
      assertNoCrossedRecalc(before, afterA, "X");
    } catch (error) {
      expect((error as CrossedRecalcError).code).toBe("recalculo_cruzado");
      expect((error as Error).message).toMatch(/A/);
    }
  });

  it("el propio corte puede cambiar (es el que se esta escribiendo)", () => {
    const before = ctx([{ id: "X", status: "pending", updateTime: "t1" }]);
    const after = ctx([{ id: "X", status: "pending", updateTime: "t9" }]);
    expect(() => assertNoCrossedRecalc(before, after, "X")).not.toThrow();
  });

  it("aparece otro corte pendiente nuevo, o uno pendiente se cierra: lanza", () => {
    const before = ctx([{ id: "A", status: "pending", updateTime: "t1" }]);
    expect(() => assertNoCrossedRecalc(before, ctx([{ id: "A", status: "pending", updateTime: "t1" }, { id: "B", status: "pending", updateTime: "t1" }]), "X")).toThrow(CrossedRecalcError);
    expect(() => assertNoCrossedRecalc(before, ctx([{ id: "A", status: "paid", updateTime: "t2" }]), "X")).toThrow(CrossedRecalcError);
  });

  it("un corte ya cerrado no cuenta: su registro no cambia (RF_04)", () => {
    const before = ctx([{ id: "C", status: "reconciled", updateTime: "t1" }]);
    const after = ctx([{ id: "C", status: "reconciled", updateTime: "t5" }]);
    expect(() => assertNoCrossedRecalc(before, after, "X")).not.toThrow();
  });
});

describe("recalculateDriverSettlement (T13)", () => {
  const walletDoc = (id: string, data: Record<string, unknown>): FakeDoc => ({ id, updateTime: "2026-11-10T10:00:00.000Z", data: { id, description: "", createdAt: "2026-11-10T09:00:00.000Z", ...data } });
  const state = () => ({
    settlements: [corte("X", { status: "pending", orderIds: ["o1"], walletEntryIds: ["p1"], cashCharges: [] })],
    docs: { "orders/o1": { createdAt: "2026-11-09T00:00:00.000Z", trackingCode: "KNT-1" } },
    collections: {
      walletEntries: [
        walletDoc("c1", { ownerType: "seller", ownerId: "s1", orderId: "o1", type: "cod_revenue", amountCop: 50000 }),
        walletDoc("p1", { ownerType: "driver", ownerId: DRIVER, orderId: "o1", type: "driver_earning", amountCop: 8000, settlementId: "X" })
      ]
    }
  });
  const txOf = () => ({
    sets: 0,
    async get(target: { get: () => Promise<unknown> }) {
      return target.get();
    },
    async getAll(...refs: Array<{ get: () => Promise<unknown> }>) {
      return Promise.all(refs.map((ref) => ref.get()));
    },
    set() {
      this.sets += 1;
    }
  });
  const settlement = { id: "X", ownerId: DRIVER, orderIds: ["o1"], walletEntryIds: ["p1"] };

  it("recalcula un corte pendiente dentro de la transaccion con la regla nueva", async () => {
    const { db } = fakeDb(state());
    const before = await loadDriverLedgerContext(db as never, DRIVER);
    const fields = await recalculateDriverSettlement(db as never, txOf() as never, { settlement, receivedCop: 20000, before });
    expect(fields).toMatchObject({ cashExpectedCop: 42000, cashReceivedCop: 20000, cashPendingCop: 22000, cashReceiptStatus: "partial", ledgerVersion: 1 });
    expect(fields.cashCharges).toEqual([{ orderId: "o1", codCop: 50000, driverPayCop: 8000, chargedCop: 42000, codSeenCop: 50000 }]);
  });

  it("si otro corte pendiente cambio desde la lectura de fuera, lanza y no escribe nada", async () => {
    const world = state();
    world.settlements.push(corte("Y", { status: "pending", orderIds: ["o9"], cashCharges: [] }));
    const { db } = fakeDb(world);
    const before = await loadDriverLedgerContext(db as never, DRIVER);
    world.settlements[1].updateTime = "2026-11-10T11:00:00.000Z";
    const tx = txOf();
    await expect(recalculateDriverSettlement(db as never, tx as never, { settlement, receivedCop: 0, before })).rejects.toBeInstanceOf(CrossedRecalcError);
    expect(tx.sets).toBe(0);
  });
});

describe("loadDriverLedgerSnapshot (T14)", () => {
  it("devuelve el contexto y las referencias de los cortes PENDIENTES con su updateTime crudo, para precondiciones", async () => {
    const { db } = fakeDb({
      settlements: [corte("P", { status: "pending", cashCharges: [] }), corte("C", { status: "reconciled", cashCharges: [] })],
      docs: {}
    });
    const snapshot = await loadDriverLedgerSnapshot(db as never, DRIVER);
    expect(snapshot.context.settlements.map((s) => s.id)).toEqual(["P", "C"]);
    expect(Array.from(snapshot.pendingSettlements.keys())).toEqual(["P"]);
    expect(snapshot.pendingSettlements.get("P")?.updateTime).toBeDefined();
  });
});
