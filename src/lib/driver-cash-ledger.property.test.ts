import { describe, expect, it } from "vitest";
// Spec 038 T5 — prueba de propiedad (RNF_02, RF_01, RF_08).
//
// Simula la vida de un domiciliario: entregas, visitas fallidas, correcciones entregado→fallido, recaudos
// borrados, re-entregas, cambios de tienda, abonos parciales, cortes que se crean, se recalculan en
// cualquier orden y se cierran, y retenciones historicas que se liberan. Despues de calcular cada corte
// comprueba la identidad del corte, y al final, tras saldarlo todo, que cada peso de cada pedido se le
// cobro al domiciliario exactamente una vez:
//
//   para todo pedido:   Σ cargos de todos sus cortes = debido + retencion vigente
//   para todo corte:    esperado + creditoEntrada − creditoSalida = Σ cargos
//
// El generador es un LCG con semilla fija: sin dependencias y reproducible.
import {
  computeDriverCorte,
  computeHolds,
  type DriverCashHolds,
  type DriverLedgerBaseline,
  type DriverLedgerContext,
  type DriverLedgerSettlement,
  orderOwedByDriver,
  pendingDeltaOrders
} from "../../functions/src/driver-cash-ledger";
import type { WalletEntryDoc } from "../../functions/src/settlement-math";

const DRIVER = "driver-p";
const SEQUENCES = 500;
const STEPS = 30;

/** LCG de Numerical Recipes. Determinista: misma semilla, misma secuencia. */
function lcg(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    int: (max: number) => Math.floor(next() * max),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  };
}

type SimSettlement = DriverLedgerSettlement & { ownEntryIds: string[]; receivedCop: number };

type Sim = {
  entries: WalletEntryDoc[];
  unsettledOwn: Set<string>;
  settlements: SimSettlement[];
  baseline: DriverLedgerBaseline;
  holds: DriverCashHolds | null;
  clock: number;
  nextId: number;
};

function iso(sim: Sim): string {
  sim.clock += 1;
  return new Date(Date.UTC(2026, 10, 10) + sim.clock * 60_000).toISOString();
}

function addEntry(sim: Sim, over: Omit<WalletEntryDoc, "id" | "description" | "createdAt">): WalletEntryDoc {
  const entry: WalletEntryDoc = { id: `e${sim.nextId++}`, description: "", createdAt: iso(sim), ...over };
  sim.entries.push(entry);
  if (entry.ownerType === "driver") sim.unsettledOwn.add(entry.id);
  return entry;
}

const codOf = (sim: Sim, orderId: string) =>
  sim.entries.filter((e) => e.orderId === orderId && e.ownerType === "seller" && (e.type === "cod_revenue" || e.type === "cod_remittance"));

function context(sim: Sim): DriverLedgerContext {
  return { driverId: DRIVER, settlements: sim.settlements, baseline: sim.baseline, holds: sim.holds };
}

function activeHold(sim: Sim, orderId: string): number {
  return (sim.holds?.holds ?? []).filter((h) => h.orderId === orderId && !h.releasedAt).reduce((a, h) => a + h.holdCop, 0);
}

/** Calcula (o recalcula) un corte con la regla y guarda su registro, como haran createSettlement y los abonos. */
function calculate(sim: Sim, settlement: SimSettlement) {
  const figures = computeDriverCorte({
    settlementId: settlement.id,
    orderIds: settlement.orderIds,
    ownEntryIds: settlement.ownEntryIds,
    entries: sim.entries,
    context: context(sim),
    receivedCop: settlement.receivedCop
  });
  settlement.cashCharges = figures.charges;
  settlement.creditInCop = figures.creditInCop;
  settlement.creditOutCop = figures.creditOutCop;
  // Identidad del corte (RF_08): lo recortado a 0 es exactamente el credito de salida.
  expect(figures.cashExpectedCop + figures.creditInCop - figures.creditOutCop).toBe(figures.chargedTotalCop);
  expect(figures.cashExpectedCop).toBeGreaterThanOrEqual(0);
  expect(figures.creditOutCop).toBeGreaterThanOrEqual(0);
  expect(new Set(figures.charges.map((c) => c.orderId)).size).toBe(figures.charges.length);
  // Justo despues de calcularlo, sus pedidos quedan cobrados una vez (RNF_02).
  assertCharged(sim, settlement.orderIds);
}

function assertCharged(sim: Sim, orderIds: readonly string[]) {
  const owed = orderOwedByDriver(sim.entries, DRIVER);
  for (const orderId of new Set(orderIds)) {
    const charged = sim.settlements.reduce((sum, s) => {
      if (!s.orderIds.includes(orderId)) return sum;
      if (s.cashCharges) return sum + (s.cashCharges.find((c) => c.orderId === orderId)?.chargedCop ?? 0);
      return sum + (sim.baseline.settlements[s.id]?.find((r) => r.orderId === orderId)?.chargedCop ?? 0);
    }, 0);
    expect({ orderId, charged }).toEqual({ orderId, charged: (owed.get(orderId)?.owedCop ?? 0) + activeHold(sim, orderId) });
  }
}

function createCorte(sim: Sim) {
  const own = Array.from(sim.unsettledOwn);
  const ownOrders = own.map((id) => sim.entries.find((e) => e.id === id)!.orderId);
  const deltas = pendingDeltaOrders({ entries: sim.entries, context: context(sim) }).map((d) => d.orderId);
  const orderIds = Array.from(new Set([...ownOrders, ...deltas]));
  if (orderIds.length === 0) return;
  const settlement: SimSettlement = { id: `s${sim.nextId++}`, status: "pending", orderIds, ownEntryIds: own, receivedCop: 0 };
  sim.settlements.push(settlement);
  sim.unsettledOwn.clear();
  calculate(sim, settlement);
}

/** Arranque: un corte viejo (anterior a la 038) en la foto, con errores historicos, y sus retenciones. */
function seed(rand: ReturnType<typeof lcg>): Sim {
  const sim: Sim = {
    entries: [],
    unsettledOwn: new Set(),
    settlements: [],
    baseline: { driverId: DRIVER, createdAt: "", createdBy: "test", measuredDiffCop: 0, settlements: {} },
    holds: null,
    clock: 0,
    nextId: 0
  };
  const oldOrders = ["o0", "o1", "o2"];
  for (const orderId of oldOrders) {
    addEntry(sim, { ownerType: "seller", ownerId: "store-a", orderId, type: "cod_revenue", amountCop: 50000 + rand.int(5) * 10000 });
    addEntry(sim, { ownerType: "driver", ownerId: DRIVER, orderId, type: "driver_earning", amountCop: 8000 });
  }
  const owed = orderOwedByDriver(sim.entries, DRIVER);
  const recalculatedAt = iso(sim);
  // Lo que el corte viejo cobro: lo debido, con un error historico aleatorio (cobro de mas o de menos).
  sim.baseline.settlements.OLD = oldOrders.map((orderId) => ({
    orderId,
    chargedCop: (owed.get(orderId)?.owedCop ?? 0) + rand.pick([0, 0, 8000, -8000, 78900]),
    driverPayCop: 8000,
    source: "allocation" as const
  }));
  sim.settlements.push({ id: "OLD", status: "reconciled", orderIds: oldOrders, ownEntryIds: [], receivedCop: 0 });
  sim.unsettledOwn.clear();
  const holds = computeHolds({ entries: sim.entries, context: context(sim), recalculatedAt: new Map([["OLD", recalculatedAt]]) });
  sim.holds = { driverId: DRIVER, createdAt: recalculatedAt, holds };
  return sim;
}

function step(sim: Sim, rand: ReturnType<typeof lcg>) {
  const orderId = `o${rand.int(8)}`;
  const store = rand.pick(["store-a", "store-b"]);
  const pending = sim.settlements.filter((s) => s.status === "pending");
  switch (rand.int(10)) {
    case 0: // entrega (o re-entrega)
      addEntry(sim, { ownerType: "seller", ownerId: store, orderId, type: "cod_revenue", amountCop: 30000 + rand.int(8) * 10000 });
      addEntry(sim, { ownerType: "driver", ownerId: DRIVER, orderId, type: "driver_earning", amountCop: 8000 });
      break;
    case 1: // visita fallida: solo paga
      addEntry(sim, { ownerType: "driver", ownerId: DRIVER, orderId, type: "driver_earning", amountCop: 5000 });
      break;
    case 2: { // correccion entregado -> fallido: reversa del recaudo vigente
      const current = codOf(sim, orderId).reduce((a, e) => a + e.amountCop, 0);
      if (current !== 0) addEntry(sim, { ownerType: "seller", ownerId: store, orderId, type: "cod_remittance", amountCop: -current });
      break;
    }
    case 3: // recaudo borrado por una correccion (su corte de tienda seguia pendiente)
      sim.entries = sim.entries.filter((e) => !(e.orderId === orderId && e.ownerType === "seller"));
      break;
    case 4: { // cambio de tienda, a veces con otro monto
      const current = codOf(sim, orderId).reduce((a, e) => a + e.amountCop, 0);
      if (current === 0) break;
      addEntry(sim, { ownerType: "seller", ownerId: "store-a", orderId, type: "cod_remittance", amountCop: -current });
      addEntry(sim, { ownerType: "seller", ownerId: "store-b", orderId, type: "cod_revenue", amountCop: current + rand.pick([0, 0, -27000, 10000]) });
      break;
    }
    case 5: // abono parcial a un corte pendiente
      if (pending.length) {
        const s = rand.pick(pending);
        s.receivedCop += rand.int(5) * 10000;
        calculate(sim, s);
      }
      break;
    case 6:
      createCorte(sim);
      break;
    case 7: // recalculo de cualquier corte pendiente, en cualquier orden
      if (pending.length) calculate(sim, rand.pick(pending));
      break;
    case 8: // cierre (pagado o conciliado): congela sus cifras
      if (pending.length) rand.pick(pending).status = rand.pick(["paid", "reconciled"]);
      break;
    case 9: { // liberar una retencion (compensacion aprobada)
      const active = (sim.holds?.holds ?? []).filter((h) => !h.releasedAt);
      if (active.length) {
        const hold = rand.pick(active);
        hold.releasedAt = iso(sim);
        hold.releasedCop = hold.holdCop;
      }
      break;
    }
  }
}

/** Salda todo: recalcula los pendientes, crea el corte que recoge lo que falte y comprueba cada pedido. */
function settleAll(sim: Sim) {
  for (const s of sim.settlements.filter((x) => x.status === "pending")) calculate(sim, s);
  createCorte(sim);
  for (const s of sim.settlements.filter((x) => x.status === "pending")) s.status = "reconciled";
  expect(pendingDeltaOrders({ entries: sim.entries, context: context(sim) })).toEqual([]);
  const everyOrder = sim.settlements.flatMap((s) => s.orderIds);
  assertCharged(sim, everyOrder);
}

describe("driver-cash-ledger: cada peso se cobra una sola vez (propiedad)", () => {
  it(`${SEQUENCES} secuencias de ${STEPS} pasos`, () => {
    for (let seedValue = 1; seedValue <= SEQUENCES; seedValue += 1) {
      const rand = lcg(seedValue);
      const sim = seed(rand);
      try {
        for (let index = 0; index < STEPS; index += 1) step(sim, rand);
        settleAll(sim);
      } catch (error) {
        throw new Error(`semilla ${seedValue}: ${(error as Error).message}`);
      }
    }
  });

  it("es reproducible: la misma semilla da los mismos cortes", () => {
    const run = () => {
      const rand = lcg(42);
      const sim = seed(rand);
      for (let index = 0; index < STEPS; index += 1) step(sim, rand);
      settleAll(sim);
      return sim.settlements.map((s) => ({ id: s.id, orderIds: s.orderIds, charges: s.cashCharges, creditOutCop: s.creditOutCop }));
    };
    expect(run()).toEqual(run());
  });
});
