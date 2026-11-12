/**
 * Spec 023, fase B — la posicion de la plataforma sale de sumas de Firestore, no del libro de caja entero.
 *
 * RF_03: `composePlatformPosition(sumas)` tiene que dar las mismas quince cifras que `computePlatformPosition`
 * (la lectura completa de siempre). Se comprueba de dos maneras sobre escenarios generados:
 *  - con el gemelo en memoria (`sumsFromEntries`), que fija las DEFINICIONES de cada suma;
 *  - con `loadPositionSums` contra un Firestore falso que implementa `sum()`/`count()`, que fija las CONSULTAS.
 * RF_04: un asiento sin indicador, un importe con decimales o un proveedor desconocido hacen fallar la carga.
 */
import { describe, expect, it } from "vitest";
import { computePlatformPosition } from "../../functions/src/platform-position";
import {
  composePlatformPosition,
  loadPositionSums,
  PositionSumsError,
  sumsFromEntries
} from "../../functions/src/platform-position-sums";
import type { SettlementDoc, WalletEntryDoc } from "../../functions/src/settlement-math";

type Data = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------
// Escenario generado (determinista)
// ---------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const SUPPLIERS = [
  { id: "sup-a", name: "Proveedor A" },
  { id: "sup-b", name: "Proveedor B" }
];

function scenario(seed: number, orderCount = 120) {
  const random = rng(seed);
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const wallet: WalletEntryDoc[] = [];
  const settlements: SettlementDoc[] = [];
  const statuses = ["pending", "paid", "reconciled", "draft"];
  const sellerSettlements = Array.from({ length: 6 }, (_, index) => ({
    id: `stl-s-${index}`,
    kind: "seller",
    ownerId: `seller-${index % 2}`,
    status: statuses[index % statuses.length],
    orderIds: [] as string[]
  }));
  const driverSettlements = Array.from({ length: 4 }, (_, index) => ({
    id: `stl-d-${index}`,
    kind: "driver",
    ownerId: "driver-1",
    status: statuses[index % statuses.length],
    orderIds: [] as string[],
    cashReceivedCop: 100_000 * (index + 1),
    cashPendingCop: index % 2 === 0 ? 37_000 * index : 0
  }));
  let id = 0;
  const add = (data: Partial<WalletEntryDoc> & Data) => {
    id += 1;
    wallet.push({ id: `w-${id}`, createdAt: "2026-11-01T10:00:00-05:00", description: "", ...data } as WalletEntryDoc);
  };
  for (let index = 0; index < orderCount; index += 1) {
    const orderId = `ord-${index}`;
    const sellerSettlement = random() < 0.6 ? pick(sellerSettlements) : undefined;
    const driverSettlement = random() < 0.7 ? pick(driverSettlements) : undefined;
    if (sellerSettlement) sellerSettlement.orderIds.push(orderId);
    if (driverSettlement) driverSettlement.orderIds.push(orderId);
    const settlementId = sellerSettlement?.id ?? "";
    const ownerId = `seller-${index % 2}`;
    const cod = 40_000 + Math.floor(random() * 100) * 1_000;
    add({ orderId, ownerType: "seller", ownerId, type: random() < 0.9 ? "cod_revenue" : "cod_remittance", amountCop: cod, settlementId });
    add({ orderId, ownerType: "seller", ownerId, type: pick(["delivery_fee", "failed_fee", "fulfillment_fee"]), amountCop: -9_000, settlementId });
    const supplier = random() < 0.85 ? pick(SUPPLIERS) : undefined;
    add({
      orderId,
      ownerType: "seller",
      ownerId,
      type: "product_cost",
      amountCop: -15_000,
      settlementId,
      supplierSettlementId: random() < 0.5 ? "" : "stl-sup-1",
      ...(supplier ? { supplierId: supplier.id, ...(random() < 0.7 ? { supplierName: supplier.name } : {}) } : {})
    });
    add({ orderId, ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 7_000, settlementId: driverSettlement?.id ?? "" });
    if (random() < 0.1) add({ orderId, ownerType: "admin", ownerId: "admin", type: "platform_margin", amountCop: 1_000, settlementId: "" });
    if (random() < 0.05) add({ orderId, ownerType: "driver", ownerId: "driver-1", type: "cash_shortage", amountCop: -5_000, settlementId: "" });
  }
  // Asientos sin pedido y abonos.
  add({ ownerType: "seller", ownerId: "seller-0", type: "seller_abono", amountCop: -200_000, settlementId: "stl-s-1", orderId: "" });
  add({ ownerType: "seller", ownerId: "seller-1", type: "seller_abono", amountCop: -50_000, settlementId: "" });
  add({ ownerType: "seller", ownerId: "seller-0", type: "gmf_tax", amountCop: -800, settlementId: "stl-s-2" });
  add({ ownerType: "seller", ownerId: "seller-0", type: "payout" as never, amountCop: -1_000, settlementId: "stl-s-1" });
  // Un corte de domiciliario que nombra un pedido que no existe en el wallet.
  driverSettlements[0].orderIds.push("ord-fantasma");
  settlements.push(...(sellerSettlements as unknown as SettlementDoc[]), ...(driverSettlements as unknown as SettlementDoc[]));
  return { wallet, settlements };
}

// ---------------------------------------------------------------------------------------------------
// Firestore falso con sum()/count()
// ---------------------------------------------------------------------------------------------------

type Filter = [string, string, unknown];

class FakeAggregateDb {
  queries = 0;
  constructor(private docs: Data[]) {}

  private matches(data: Data, [field, op, value]: Filter): boolean {
    const actual = data[field];
    if (op === "==") return actual === value;
    if (op === "in") return Array.isArray(value) && value.includes(actual);
    // Firestore: un campo ausente no entra en `not-in` ni en un rango.
    if (op === "not-in") return actual !== undefined && actual !== null && Array.isArray(value) && !value.includes(actual);
    if (op === ">") return typeof actual === typeof value && (actual as string) > (value as string);
    throw new Error(`operador no soportado: ${op}`);
  }

  private query(filters: Filter[]): unknown {
    const run = () => this.docs.filter((doc) => filters.every((filter) => this.matches(doc, filter)));
    return {
      where: (field: string, op: string, value: unknown) => this.query([...filters, [field, op, value]]),
      count: () => ({
        get: async () => {
          this.queries += 1;
          return { data: () => ({ count: run().length }) };
        }
      }),
      aggregate: () => ({
        get: async () => {
          this.queries += 1;
          const rows = run();
          return { data: () => ({ sumCop: rows.reduce((total, row) => total + Number(row.amountCop), 0), count: rows.length }) };
        }
      })
    };
  }

  collection(name: string) {
    if (name !== "walletEntries") throw new Error(`coleccion inesperada: ${name}`);
    return this.query([]);
  }
}

async function viaFirestore(wallet: WalletEntryDoc[], settlements: SettlementDoc[]) {
  const db = new FakeAggregateDb(wallet as unknown as Data[]);
  const sums = await loadPositionSums(db as never, settlements, SUPPLIERS);
  return composePlatformPosition(sums, settlements);
}

/** Lo que no es dinero: el nombre del proveedor sale de `suppliers` en la carga real. */
function moneyOnly(position: ReturnType<typeof computePlatformPosition>) {
  return { ...position, withheldBySupplier: position.withheldBySupplier.map(({ supplierId, amountCop }) => ({ supplierId, amountCop })) };
}

describe("023/RF_03 — la posicion por sumas da las mismas quince cifras", () => {
  for (const seed of [1, 7, 42, 2026, 99_991]) {
    it(`gemelo en memoria, escenario ${seed}`, () => {
      const { wallet, settlements } = scenario(seed);
      expect(composePlatformPosition(sumsFromEntries(wallet, settlements), settlements)).toEqual(computePlatformPosition(wallet, settlements));
    });
    it(`consultas a Firestore, escenario ${seed}`, async () => {
      const { wallet, settlements } = scenario(seed);
      expect(moneyOnly(await viaFirestore(wallet, settlements))).toEqual(moneyOnly(computePlatformPosition(wallet, settlements)));
    });
  }

  it("con el libro vacio", async () => {
    expect(composePlatformPosition(sumsFromEntries([], []), [])).toEqual(computePlatformPosition([], []));
    expect(moneyOnly(await viaFirestore([], []))).toEqual(moneyOnly(computePlatformPosition([], [])));
  });

  it("el control funciona: el escenario mueve las cifras que no son una suma simple", () => {
    const { wallet, settlements } = scenario(42);
    const position = computePlatformPosition(wallet, settlements);
    expect(position.driverCodOutsideSettlementsCop).toBeGreaterThan(0);
    expect(position.paidToSellersCop).not.toBe(0);
    expect(position.withheldBySupplier.map((row) => row.supplierId)).toEqual(expect.arrayContaining(["sup-a", "sup-b", "(sin proveedor)"]));
  });
});

describe("023/RF_04 — una suma que no se puede confiar falla, no da una cifra", () => {
  it("un asiento de tienda sin settlementId", async () => {
    const { wallet, settlements } = scenario(3, 10);
    delete (wallet[0] as Data).settlementId;
    await expect(viaFirestore(wallet, settlements)).rejects.toThrow(PositionSumsError);
    await expect(viaFirestore(wallet, settlements)).rejects.toThrow(/sin settlementId/);
  });

  it("un costo de producto sin supplierSettlementId", async () => {
    const { wallet, settlements } = scenario(3, 10);
    const productCost = wallet.find((entry) => entry.type === "product_cost") as Data;
    delete productCost.supplierSettlementId;
    await expect(viaFirestore(wallet, settlements)).rejects.toThrow(/sin supplierSettlementId/);
  });

  it("un importe con decimales", async () => {
    const { wallet, settlements } = scenario(3, 10);
    (wallet[0] as Data).amountCop = 1000.5;
    await expect(viaFirestore(wallet, settlements)).rejects.toThrow(/decimales/);
  });

  it("un costo retenido de un proveedor que no esta dado de alta", async () => {
    const { wallet, settlements } = scenario(3, 10);
    const productCost = wallet.find((entry) => entry.type === "product_cost") as Data;
    productCost.supplierSettlementId = "";
    productCost.supplierId = "sup-desconocido";
    await expect(viaFirestore(wallet, settlements)).rejects.toThrow(/no esta en suppliers/);
  });
});

describe("023/RNF_02 — las consultas no crecen con el libro de caja", () => {
  it("el numero de consultas solo depende de cortes y proveedores", async () => {
    const small = scenario(5, 50);
    const big = scenario(5, 1_000);
    const smallDb = new FakeAggregateDb(small.wallet as unknown as Data[]);
    const bigDb = new FakeAggregateDb(big.wallet as unknown as Data[]);
    // Mismos cortes en los dos, para aislar el efecto del libro.
    await loadPositionSums(smallDb as never, small.settlements, SUPPLIERS);
    await loadPositionSums(bigDb as never, small.settlements, SUPPLIERS);
    expect(bigDb.queries).toBe(smallDb.queries);
  });
});
