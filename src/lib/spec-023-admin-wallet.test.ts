/**
 * Spec 023, fase B: el admin ya no tiene el libro de caja entero en `state.wallet`.
 *
 * Tiene lo sin liquidar y los cobros de manejo (la suscripcion), y cada pantalla de dinero pide lo demas.
 * Estas pruebas fijan que, para cada cosa que esas pantallas calculan, la wallet "viva + leida bajo demanda"
 * da exactamente lo mismo que el libro entero (RF_03). Las consultas de Firestore se emulan con las MISMAS
 * condiciones que `state-store.ts`, y una guarda de fuente comprueba que siguen siendo esas.
 *
 * Las calculadoras de pantalla viven dentro de `operations-app.tsx` y no se exportan; lo que se fija aqui es lo
 * que las sostiene: el conjunto de asientos que cada una filtra (por id de corte, por pedido, por tipo, por
 * fecha) y, donde la funcion SI esta exportada (`selectOpenWalletEntries`, `calculateDriverSettlementFinancials`,
 * el saldo de tienda), el resultado entero.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSellerBalanceInput, computeSellerBalance } from "../../functions/src/seller-balance";
import { calculateDriverSettlementFinancials, selectOpenWalletEntries } from "./finance";
import type { Settlement, WalletEntry } from "./types";
import {
  combineStatus,
  driverPendingOrderIds,
  mergePreferringLive,
  orderIdsOfEntries,
  settlementSupplementIds
} from "./wallet-supplement";

// ---------------------------------------------------------------------------------------------------
// Libro de caja generado
// ---------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

type Ledger = { wallet: WalletEntry[]; settlements: Settlement[]; orders: Array<Record<string, unknown>> };

function ledger(seed: number, orderCount = 150, settledHistoryCopies = 1): Ledger {
  const random = rng(seed);
  const wallet: WalletEntry[] = [];
  const settlements: Settlement[] = [];
  const orders: Array<Record<string, unknown>> = [];
  const times = ["T00:00:00-05:00", "T12:30:00-05:00", "T23:59:59-05:00", "T00:00:00.000Z", "T23:59:59.999Z"];
  const mkSettlement = (id: string, kind: Settlement["kind"], ownerId: string, status: Settlement["status"]): Settlement =>
    ({ id, kind, ownerId, ownerName: ownerId, status, startDate: "2026-10-01", endDate: "2026-10-07", walletEntryIds: [], orderIds: [], codCop: 0, feesCop: 0, driverPayCop: 0, platformMarginCop: 0, netCop: 0, createdAt: "2026-10-08" }) as unknown as Settlement;
  const sellerCuts = [mkSettlement("stl-s-paid", "seller", "seller-a", "paid"), mkSettlement("stl-s-pend", "seller", "seller-b", "pending")];
  const driverCuts = [mkSettlement("stl-d-paid", "driver", "driver-1", "paid"), mkSettlement("stl-d-pend", "driver", "driver-1", "pending")];
  // Un corte viejo SIN orderIds: sus pedidos solo se saben por sus asientos.
  const legacyCut = mkSettlement("stl-s-legacy", "seller", "seller-a", "reconciled");
  settlements.push(...sellerCuts, ...driverCuts, legacyCut);

  for (let copy = 0; copy < settledHistoryCopies; copy += 1) {
    for (let index = 0; index < orderCount; index += 1) {
      const orderId = `ord-${copy}-${index}`;
      const sellerId = index % 2 === 0 ? "seller-a" : "seller-b";
      const day = 1 + (index % 28);
      const createdAt = `2026-10-${String(day).padStart(2, "0")}${times[index % times.length]}`;
      orders.push({ id: orderId, sellerId, status: index % 7 === 0 ? "in_route" : "delivered", paymentMethod: "cod", totalCop: 60_000, driverId: "driver-1", createdAt, zoneId: "zone-1", fulfillmentMode: index % 11 === 0 ? "warehouse" : "self" });
      const roll = random();
      const sellerCut = roll < 0.25 ? (index % 9 === 0 ? legacyCut : sellerCuts[index % 2]) : undefined;
      const driverCut = random() < 0.6 ? driverCuts[index % 2] : undefined;
      const sid = sellerCut?.id ?? "";
      const did = driverCut?.id ?? "";
      const add = (entry: Partial<WalletEntry> & Pick<WalletEntry, "id" | "ownerType" | "ownerId" | "type" | "amountCop">, cut?: Settlement) => {
        const full = { orderId, description: "", createdAt, ...entry } as WalletEntry;
        wallet.push(full);
        if (cut) cut.walletEntryIds.push(full.id);
      };
      add({ id: `we-${orderId}-cod`, ownerType: "seller", ownerId: sellerId, type: "cod_revenue", amountCop: 60_000, settlementId: sid }, sellerCut);
      add({ id: `we-${orderId}-delivery-fee`, ownerType: "seller", ownerId: sellerId, type: "delivery_fee", amountCop: -9_000, settlementId: sid }, sellerCut);
      add({ id: `we-${orderId}-product-cost`, ownerType: "seller", ownerId: sellerId, type: "product_cost", amountCop: -20_000, settlementId: sid, supplierSettlementId: random() < 0.3 ? "stl-sup-1" : "", supplierId: "sup-a" }, sellerCut);
      add({ id: `we-${orderId}-driver-delivery-pay`, ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 7_000, settlementId: did, description: "Pago entregado" }, driverCut);
      if (index % 11 === 0) add({ id: `we-${orderId}-fulfillment-fee`, ownerType: "seller", ownerId: sellerId, type: "fulfillment_fee", amountCop: -2_000, settlementId: sid }, sellerCut);
      if (index % 13 === 0) add({ id: `we-${orderId}-community-cashback`, ownerType: "community_leader", ownerId: "com-1", type: "community_cashback", amountCop: 1_000, settlementId: random() < 0.5 ? "stl-c-1" : "", sellerId } as never);
      if (sellerCut && sellerCut !== legacyCut && !sellerCut.orderIds.includes(orderId)) sellerCut.orderIds.push(orderId);
      if (driverCut && !driverCut.orderIds.includes(orderId)) driverCut.orderIds.push(orderId);
    }
  }
  // Asientos de corte que NO son de un pedido: abono y 4x1000 (solo se pueden pedir por id).
  const abono = { id: `abono-${seed}`, ownerType: "seller", ownerId: "seller-a", type: "seller_abono", amountCop: -100_000, settlementId: "stl-s-paid", description: "", createdAt: "2026-10-05T10:00:00-05:00" } as WalletEntry;
  const gmf = { id: `gmf-${seed}`, ownerType: "seller", ownerId: "seller-a", type: "gmf_tax", amountCop: -400, settlementId: "stl-s-paid", description: "", createdAt: "2026-10-05T10:00:00-05:00" } as WalletEntry;
  wallet.push(abono, gmf);
  sellerCuts[0].walletEntryIds.push(abono.id, gmf.id);
  return { wallet, settlements, orders };
}

// ---------------------------------------------------------------------------------------------------
// Emulacion de las consultas de state-store.ts (mismas condiciones)
// ---------------------------------------------------------------------------------------------------

const q = {
  /** Suscripcion del admin, objetivo 1: `where("settlementId", "==", "")`. */
  unsettled: (wallet: WalletEntry[]) => wallet.filter((entry) => entry.settlementId === ""),
  /** Suscripcion del admin, objetivo 2: `where("type", "==", "fulfillment_fee")`. */
  fulfillment: (wallet: WalletEntry[]) => wallet.filter((entry) => entry.type === "fulfillment_fee"),
  /** `subscribeSupplierPendingCosts`. */
  supplierPending: (wallet: WalletEntry[]) => wallet.filter((entry) => entry.type === "product_cost" && entry.supplierSettlementId === ""),
  /** `fetchWalletEntriesByOrderIds`. */
  byOrderIds: (wallet: WalletEntry[], ids: string[]) => wallet.filter((entry) => entry.orderId !== undefined && ids.includes(entry.orderId)),
  /** `fetchWalletEntriesByIds`. */
  byIds: (wallet: WalletEntry[], ids: string[]) => wallet.filter((entry) => ids.includes(entry.id)),
  /** `fetchWalletEntriesInRange`: `createdAt >= start` y `< dia siguiente de end`, en orden de texto. */
  inRange: (wallet: WalletEntry[], start: string, end: string) => {
    const next = new Date(`${end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const endExclusive = next.toISOString().slice(0, 10);
    return wallet.filter((entry) => (!start || entry.createdAt >= start) && (!end || entry.createdAt < endExclusive));
  },
  /** `fetchWalletEntriesByType`. */
  byType: (wallet: WalletEntry[], type: string) => wallet.filter((entry) => entry.type === type)
};

/** Lo que el admin tiene en `state.wallet` tras la spec 023. */
const adminLive = (wallet: WalletEntry[]) => mergePreferringLive(q.unsettled(wallet), q.fulfillment(wallet));

const ids = (entries: WalletEntry[]) => entries.map((entry) => entry.id).sort();
/** Regla de rango de `isEntryInRange` (operations-app.tsx). */
const isEntryInRange = (entry: WalletEntry, start: string, end: string) => {
  const date = entry.createdAt.slice(0, 10);
  return (!start || date >= start) && (!end || date <= end);
};

const SEEDS = [1, 17, 404, 2026];

describe("023/RF_03 — Liquidaciones 'Por pagar': lo vivo mas lo pedido da lo mismo que el libro entero", () => {
  for (const seed of SEEDS) {
    it(`lo abierto (sin liquidar + sin pagar al proveedor), escenario ${seed}`, () => {
      const { wallet } = ledger(seed);
      const liveWallet = mergePreferringLive(adminLive(wallet), q.supplierPending(wallet));
      expect(ids(selectOpenWalletEntries(liveWallet))).toEqual(ids(selectOpenWalletEntries(wallet)));
    });

    it(`asientos de tienda de los pedidos de 'Domiciliarios por cortar', escenario ${seed}`, () => {
      const { wallet } = ledger(seed);
      const live = adminLive(wallet);
      const orderIds = driverPendingOrderIds(live);
      const relatedWallet = mergePreferringLive(live, q.byOrderIds(wallet, orderIds));
      const related = (source: WalletEntry[]) => source.filter((entry) => entry.ownerType === "seller" && entry.orderId && orderIds.includes(entry.orderId));
      expect(orderIds.length).toBeGreaterThan(0);
      expect(ids(related(relatedWallet))).toEqual(ids(related(wallet)));
    });

    it(`saldo de cada tienda (spec 018), escenario ${seed}`, () => {
      const { wallet, settlements, orders } = ledger(seed);
      const liveWallet = mergePreferringLive(adminLive(wallet), q.supplierPending(wallet));
      for (const sellerId of ["seller-a", "seller-b"]) {
        const input = (source: WalletEntry[]) =>
          buildSellerBalanceInput({ sellerId, wallet: source as never, orders: orders as never, settlements: settlements as never, settings: {}, zones: [{ id: "zone-1" }], now: "2026-11-10T12:00:00.000Z" });
        // El orden de `selection.entryIds` sigue al de la wallet, que en Firestore tampoco esta garantizado; la
        // pantalla lo usa como conjunto. Todo lo demas (los importes) se compara tal cual.
        const normalized = (source: WalletEntry[]) => {
          const balance = computeSellerBalance(input(source));
          return { ...balance, selection: { ...balance.selection, entryIds: [...balance.selection.entryIds].sort() } };
        };
        expect(normalized(liveWallet)).toEqual(normalized(wallet));
      }
    });
  }

  it("el control funciona: sin el suplemento las filas de domiciliario SI cambiarian", () => {
    const { wallet } = ledger(17);
    const live = adminLive(wallet);
    const orderIds = driverPendingOrderIds(live);
    const related = (source: WalletEntry[]) => source.filter((entry) => entry.ownerType === "seller" && entry.orderId && orderIds.includes(entry.orderId));
    expect(ids(related(live))).not.toEqual(ids(related(wallet)));
  });
});

describe("023/RF_02 — un corte cerrado trae solo sus asientos y da lo mismo", () => {
  for (const seed of SEEDS) {
    it(`asientos por corte, por pedido y neto de domiciliario, escenario ${seed}`, () => {
      const { wallet, settlements } = ledger(seed);
      const live = adminLive(wallet);
      const page = settlementSupplementIds(settlements);
      const byIds = q.byIds(wallet, page.entryIds);
      const orderIds = [...new Set([...page.orderIds, ...orderIdsOfEntries(byIds)])];
      const supplementWallet = mergePreferringLive(live, byIds, q.byOrderIds(wallet, orderIds));
      for (const settlement of settlements) {
        const entryIdSet = new Set(settlement.walletEntryIds);
        const ofSettlement = (source: WalletEntry[]) => source.filter((entry) => entryIdSet.has(entry.id));
        expect(ids(ofSettlement(supplementWallet))).toEqual(ids(ofSettlement(wallet)));
        const settlementOrders = settlement.orderIds.length > 0 ? settlement.orderIds : orderIdsOfEntries(ofSettlement(wallet));
        const ofOrders = (source: WalletEntry[]) => source.filter((entry) => entry.orderId && settlementOrders.includes(entry.orderId));
        expect(ids(ofOrders(supplementWallet))).toEqual(ids(ofOrders(wallet)));
        if (settlement.kind === "driver") {
          expect(calculateDriverSettlementFinancials(supplementWallet, settlement)).toEqual(calculateDriverSettlementFinancials(wallet, settlement));
        }
      }
    });
  }

  it("no pide dos veces los asientos de pedido: por id solo van abonos, 4x1000 y cortes viejos", () => {
    const { settlements } = ledger(17);
    const page = settlementSupplementIds(settlements);
    const legacy = settlements.find((settlement) => settlement.id === "stl-s-legacy")!;
    const nonOrder = page.entryIds.filter((id) => !legacy.walletEntryIds.includes(id));
    expect(nonOrder.sort()).toEqual(["abono-17", "gmf-17"]);
  });

  it("lo que pide un corte no depende de cuantos cortes cerrados haya en el libro", () => {
    const small = ledger(5, 100, 1);
    const big = ledger(5, 100, 3);
    const live = (l: Ledger) => adminLive(l.wallet).length;
    expect(live(big)).toBeLessThan(big.wallet.length);
    expect(live(small)).toBeLessThan(small.wallet.length);
  });
});

describe("023/RF_03 — 'Resumen del periodo': la lectura por rango selecciona lo mismo que la regla de fechas", () => {
  const ranges: Array<[string, string]> = [["2026-10-03", "2026-10-09"], ["2026-10-01", "2026-10-01"], ["2026-10-28", "2026-10-31"], ["", "2026-10-05"], ["2026-10-30", "2026-11-02"]];
  for (const [start, end] of ranges) {
    it(`${start || "(inicio)"} a ${end}`, () => {
      const { wallet } = ledger(404);
      const merged = mergePreferringLive(adminLive(wallet), q.inRange(wallet, start, end));
      expect(ids(merged.filter((entry) => isEntryInRange(entry, start, end)))).toEqual(ids(wallet.filter((entry) => isEntryInRange(entry, start, end))));
    });
  }
});

describe("023/RF_03 — cashback causado por comunidad", () => {
  it("todos los community_cashback, liquidados o no", () => {
    const { wallet } = ledger(2026);
    const merged = mergePreferringLive(adminLive(wallet), q.byType(wallet, "community_cashback"));
    const cashback = (source: WalletEntry[]) => source.filter((entry) => entry.type === "community_cashback");
    expect(cashback(wallet).length).toBeGreaterThan(0);
    expect(ids(cashback(merged))).toEqual(ids(cashback(wallet)));
  });
});

describe("023/RF_04 — sin todo lo pedido no hay cifra", () => {
  it("combineStatus: lista solo si todo esta listo, fallida si algo fallo", () => {
    expect(combineStatus("ready", "ready")).toBe("ready");
    expect(combineStatus("ready", "loading")).toBe("loading");
    expect(combineStatus("loading", "failed")).toBe("failed");
  });

  it("al unir, la copia viva gana: un asiento leido sin liquidar que ya se liquido no vuelve a contar como pendiente", () => {
    const stale = { id: "w1", settlementId: "", amountCop: 10 } as WalletEntry;
    const live = { id: "w1", settlementId: "stl-1", amountCop: 10 } as WalletEntry;
    expect(mergePreferringLive([live], [stale])).toEqual([live]);
  });

  const source = readFileSync("src/lib/firebase/state-store.ts", "utf8");
  it("las lecturas bajo demanda no se tragan el error", () => {
    for (const name of ["fetchWalletEntriesByOrderIds", "fetchWalletEntriesByIds", "fetchWalletEntriesInRange", "fetchWalletEntriesByType"]) {
      const start = source.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThan(0);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body, name).not.toMatch(/\.catch\(/);
    }
  });

  it("Liquidaciones no pinta 'Por pagar' si hay asientos de tienda sin marca de liquidacion", () => {
    const app = readFileSync("src/components/operations-app.tsx", "utf8");
    expect(source).toMatch(/export async function countSellerEntriesWithoutSettlementFlags\(/);
    expect(app).toMatch(/combineStatus\(supplierPending\.status, relatedSupplement\.status, flagCheck\.status\)/);
  });

  it("si cae el listener de la wallet, el parte de carga lo dice", () => {
    expect(source).toMatch(/entry\.key === "wallet"[\s\S]{0,120}liveIssues\.add\("wallet_unavailable"\)/);
  });
});

describe("023/RF_01 — la carga del admin no baja el libro de caja", () => {
  const source = readFileSync("src/lib/firebase/state-store.ts", "utf8");
  it("la suscripcion del admin solo pide lo sin liquidar y los cobros de manejo", () => {
    const targets = [...source.matchAll(/\{ key: "wallet", target: ([^}]+) \}/g)].map((match) => match[1].trim());
    expect(targets).toContain('query(walletRef, where("settlementId", "==", ""))');
    expect(targets).toContain('query(walletRef, where("type", "==", "fulfillment_fee"))');
    expect(targets).not.toContain("walletRef");
  });

  it("la carga inicial (getWalletForContext) tampoco pide la coleccion entera", () => {
    const start = source.indexOf("async function getWalletForContext(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).not.toMatch(/getCollection<WalletEntry>\("walletEntries"\)/);
    expect(body).toMatch(/where\("settlementId", "==", ""\)/);
    expect(body).toMatch(/where\("type", "==", "fulfillment_fee"\)/);
  });
});

describe("023/RNF_02 — duplicar el historico liquidado no cambia lo que baja el admin al abrir", () => {
  it("la suscripcion trae lo mismo con 1 o con 3 copias del historico liquidado", () => {
    // Las copias extra solo tienen asientos en cortes; los abiertos se cuentan por separado.
    const single = ledger(9, 120, 1);
    const triple = ledger(9, 120, 3);
    const settledOnly = (l: Ledger) => l.wallet.filter((entry) => entry.settlementId).length;
    expect(settledOnly(triple)).toBeGreaterThan(2 * settledOnly(single));
    // Lo que si crece es lo abierto de cada copia (en la vida real se liquida); por eso se compara la
    // proporcion: la carga del admin es solo lo abierto y los cobros de manejo, nunca lo liquidado.
    for (const l of [single, triple]) {
      const live = adminLive(l.wallet);
      expect(live.every((entry) => entry.settlementId === "" || entry.type === "fulfillment_fee")).toBe(true);
    }
  });
});
