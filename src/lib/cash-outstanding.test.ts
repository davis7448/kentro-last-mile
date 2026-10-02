/**
 * Spec 026 — nucleo puro de "efectivo que no llega a un corte" (`functions/src/cash-outstanding.ts`).
 *
 * Un bloque `describe("T<n> · ...")` por tarea (plan 5.2): T6, T7, T8 y T9 comparten este archivo.
 * No editar los bloques de otra tarea.
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso
 * falle con su propio mensaje en vez de tumbar el archivo entero.
 */
import { describe, expect, it } from "vitest";
import { buildCodReceivedSet, isSellerEntryEligible } from "../../functions/src/seller-ledger";

type CashOutstandingModule = typeof import("../../functions/src/cash-outstanding");
type ReportInput = Parameters<CashOutstandingModule["buildCashOutstandingReport"]>[0];

const loadCore = (): Promise<CashOutstandingModule> => import("../../functions/src/cash-outstanding");

// ---------------------------------------------------------------------------------------------------
// Fixtures de T6
// ---------------------------------------------------------------------------------------------------

const NOW = "2026-10-02T12:00:00.000Z";

type OrderFixture = {
  id: string;
  trackingCode?: string;
  sellerId: string;
  driverId: string | null;
  messengerId: string | null;
  status: string;
  paymentMethod: string;
  totalCop: number;
  closedAt?: string;
  updatedAt?: string;
  evidence: Array<{ type: string; createdAt: string }>;
};

function order(id: string, overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id,
    trackingCode: `KNT-${id}`,
    sellerId: "seller-1",
    driverId: "leader-1",
    messengerId: "messenger-1",
    status: "delivered",
    paymentMethod: "cod",
    totalCop: 50_000,
    closedAt: "2026-09-28T15:00:00.000Z",
    updatedAt: "2026-09-28T15:00:00.000Z",
    evidence: [],
    ...overrides
  };
}

let entrySeq = 0;
function codEntry(orderId: string, amountCop: number, type: "cod_revenue" | "cod_remittance" = "cod_revenue") {
  entrySeq += 1;
  return {
    id: `cod-${orderId}-${entrySeq}`,
    ownerType: "seller" as const,
    ownerId: "seller-1",
    orderId,
    type,
    amountCop,
    description: "",
    createdAt: "2026-09-28T15:00:00.000Z"
  };
}

function payEntry(orderId: string, amountCop: number) {
  entrySeq += 1;
  return {
    id: `pay-${orderId}-${entrySeq}`,
    ownerType: "driver" as const,
    ownerId: "leader-1",
    orderId,
    type: "driver_earning" as const,
    amountCop,
    description: "",
    createdAt: "2026-09-28T15:00:00.000Z"
  };
}

type SettlementFixture = {
  id: string;
  kind: "driver";
  ownerId: string;
  ownerName: string;
  startDate: string;
  endDate: string;
  walletEntryIds: string[];
  orderIds: string[];
  codCop: number;
  feesCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  netCop: number;
  status: "pending" | "paid" | "reconciled";
  createdAt: string;
  cashExpectedCop?: number;
  cashReceivedCop?: number;
  cashPendingCop?: number;
  cashAllocations?: Array<{ orderId: string; expectedCop: number; receivedCop: number; covered: boolean }>;
};

function settlement(id: string, overrides: Partial<SettlementFixture> = {}): SettlementFixture {
  return {
    id,
    kind: "driver",
    ownerId: "leader-1",
    ownerName: "Lider Uno",
    startDate: "",
    endDate: "",
    walletEntryIds: [],
    orderIds: [],
    codCop: 0,
    feesCop: 0,
    driverPayCop: 0,
    platformMarginCop: 0,
    netCop: 0,
    status: "pending",
    createdAt: "2026-09-29T10:00:00.000Z",
    ...overrides
  };
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    orders: [],
    settlements: [],
    receivableEntries: [],
    coverage: "full",
    productCostEntries: [],
    names: { sellers: new Map(), leaders: new Map(), messengers: new Map() },
    settings: { overdueDays: 7, notifyMinCop: 20_000 },
    settingsInvalid: false,
    channelConfigured: null,
    scope: { kind: "admin", includeReconciliation: false },
    now: NOW,
    unreadableOrderIds: [],
    unreadableSettlementIds: [],
    unreadableEntryIds: [],
    ...overrides
  } as ReportInput;
}

const rowIds = (rows: Array<{ orderId: string }>) => rows.map((row) => row.orderId).sort();
const listedIds = (report: { rows: Array<{ orderId: string }>; nettedRows: Array<{ orderId: string }> }) =>
  [...report.rows, ...report.nettedRows].map((row) => row.orderId).sort();

/**
 * Universo mixto: entregados y liquidados en efectivo (recibidos o no), fallidos, cancelados,
 * prepagados, uno de junio, uno cubierto en parte por un corte pendiente y uno en un corte saldado
 * por compensacion. Asientos completos de todos (modo `full`).
 */
function mixedUniverse() {
  const orders = [
    order("o-out"), // fuera de todo corte
    order("o-liq", { status: "liquidated" }),
    order("o-june", { closedAt: "2026-06-01T15:00:00.000Z", updatedAt: "2026-06-01T15:00:00.000Z" }),
    order("o-partial"), // corte pendiente que lo cubre en parte
    order("o-paid"), // corte pagado sin asignaciones: recibido
    order("o-alloc-covered"), // asignacion cubierta: recibido
    order("o-netted"), // corte saldado con su asignacion sin cubrir
    order("o-failed", { status: "failed" }),
    order("o-cancelled", { status: "cancelled" }),
    order("o-prepaid", { paymentMethod: "prepaid" }),
    order("o-prepaid-failed", { paymentMethod: "prepaid", status: "failed" }),
    order("o-other-leader", { driverId: "leader-2" }),
    order("o-no-leader", { driverId: null, messengerId: null })
  ];
  const settlements = [
    settlement("s-partial", {
      status: "pending",
      orderIds: ["o-partial"],
      cashExpectedCop: 45_000,
      cashReceivedCop: 20_000,
      cashPendingCop: 25_000,
      cashAllocations: [{ orderId: "o-partial", expectedCop: 45_000, receivedCop: 20_000, covered: false }]
    }),
    settlement("s-paid", { status: "paid", orderIds: ["o-paid"], cashExpectedCop: 45_000, cashReceivedCop: 45_000, cashPendingCop: 0 }),
    settlement("s-alloc", {
      status: "reconciled",
      orderIds: ["o-alloc-covered", "o-netted"],
      cashExpectedCop: 90_000,
      cashReceivedCop: 90_000,
      cashPendingCop: 0,
      cashAllocations: [
        { orderId: "o-alloc-covered", expectedCop: 45_000, receivedCop: 45_000, covered: true },
        { orderId: "o-netted", expectedCop: 45_000, receivedCop: 0, covered: false }
      ]
    })
  ];
  const receivableEntries = orders
    .filter((candidate) => candidate.paymentMethod === "cod" && candidate.status !== "failed" && candidate.status !== "cancelled")
    .flatMap((candidate) => [codEntry(candidate.id, 50_000), payEntry(candidate.id, 5_000)]);
  return { orders, settlements, receivableEntries };
}

// ---------------------------------------------------------------------------------------------------
// T6
// ---------------------------------------------------------------------------------------------------

describe("T6 · pertenencia a la lista e importes (nucleo)", () => {
  describe("RF_01: equivalencia con la compuerta de la liquidacion de tienda", () => {
    it("todo pedido de rows o nettedRows es !isSellerEntryEligible, y todo no elegible del universo esta en una de las dos", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const universe = mixedUniverse();
      const report = buildCashOutstandingReport(input(universe));

      const ordersById = new Map(universe.orders.map((candidate) => [candidate.id, candidate]));
      const codReceived = buildCodReceivedSet(universe.settlements);
      const isEligible = (orderId: string) =>
        isSellerEntryEligible({ type: "cod_revenue", orderId }, ordersById, codReceived);

      const listed = listedIds(report);
      for (const orderId of listed) expect({ orderId, eligible: isEligible(orderId) }).toEqual({ orderId, eligible: false });

      const notEligible = universe.orders.map((candidate) => candidate.id).filter((orderId) => !isEligible(orderId)).sort();
      expect(listed).toEqual(notEligible);
    });

    it("la lista exacta del universo mixto: entregados y liquidados en efectivo que la regla no da por recibidos", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(mixedUniverse()));
      expect(listedIds(report)).toEqual(
        ["o-june", "o-liq", "o-netted", "o-no-leader", "o-other-leader", "o-out", "o-partial"].sort()
      );
    });
  });

  describe("filtro propio: cod, delivered|liquidated, alcance y no recibido", () => {
    it("un pedido failed en la entrada NO sale (caso limite: corregido de entregado a fallido)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const failed = order("o-failed", { status: "failed" });
      const report = buildCashOutstandingReport(
        input({ orders: [failed], receivableEntries: [codEntry("o-failed", 50_000), payEntry("o-failed", 5_000)] })
      );
      expect(listedIds(report)).toEqual([]);
    });

    it("un prepago entregado no sale", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input({ orders: [order("o-pre", { paymentMethod: "prepaid" })] }));
      expect(listedIds(report)).toEqual([]);
    });

    it("un pedido liquidated en efectivo sin corte si sale", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({ orders: [order("o-liq", { status: "liquidated" })], receivableEntries: [codEntry("o-liq", 50_000)] })
      );
      expect(rowIds(report.rows)).toEqual(["o-liq"]);
    });

    it("un pedido cubierto por un corte pagado sin asignaciones no sale (recibido)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [order("o-paid")],
          settlements: [settlement("s1", { status: "paid", orderIds: ["o-paid"], cashExpectedCop: 50_000, cashReceivedCop: 50_000, cashPendingCop: 0 })],
          receivableEntries: [codEntry("o-paid", 50_000)]
        })
      );
      expect(listedIds(report)).toEqual([]);
    });

    it("un pedido con asignacion covered no sale aunque el corte siga pendiente", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [order("o-cov")],
          settlements: [
            settlement("s1", {
              status: "pending",
              orderIds: ["o-cov"],
              cashAllocations: [{ orderId: "o-cov", expectedCop: 50_000, receivedCop: 50_000, covered: true }]
            })
          ],
          receivableEntries: [codEntry("o-cov", 50_000)]
        })
      );
      expect(listedIds(report)).toEqual([]);
    });

    it("alcance de lider: solo los pedidos con su driverId", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const universe = mixedUniverse();
      const report = buildCashOutstandingReport(input({ ...universe, scope: { kind: "leader", driverId: "leader-2" } }));
      expect(listedIds(report)).toEqual(["o-other-leader"]);
    });

    it("un pedido sin lider (driverId null) aparece para el admin", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({ orders: [order("o-nl", { driverId: null, messengerId: null })], receivableEntries: [codEntry("o-nl", 50_000)] })
      );
      expect(rowIds(report.rows)).toEqual(["o-nl"]);
      expect(report.rows[0].leaderId).toBeNull();
    });
  });

  describe("RF_07: sin ventana de fecha", () => {
    it("un pedido entregado el 2026-06-01 aparece en la lista (DoD 2)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const june = order("o-june", { closedAt: "2026-06-01T15:00:00.000Z", updatedAt: "2026-06-01T15:00:00.000Z" });
      const report = buildCashOutstandingReport(
        input({ orders: [june], receivableEntries: [codEntry("o-june", 80_000), payEntry("o-june", 6_000)] })
      );
      expect(rowIds(report.rows)).toEqual(["o-june"]);
      expect(report.rows[0].outstandingCop).toBe(74_000);
    });
  });

  describe("importes", () => {
    it("recaudo, pago, esperado, recibido y faltante de un pedido fuera de corte", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({ orders: [order("o1")], receivableEntries: [codEntry("o1", 50_000), payEntry("o1", 5_000)] })
      );
      expect(report.rows[0]).toMatchObject({
        orderId: "o1",
        collectedCop: 50_000,
        collectedSource: "wallet",
        driverPayCop: 5_000,
        expectedCashCop: 45_000,
        receivedCop: 0,
        outstandingCop: 45_000
      });
    });

    it("suma cod_revenue y cod_remittance del pedido (neto de reversas)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [order("o1")],
          receivableEntries: [codEntry("o1", 50_000), codEntry("o1", -10_000, "cod_remittance"), payEntry("o1", 5_000)]
        })
      );
      expect(report.rows[0]).toMatchObject({ collectedCop: 40_000, expectedCashCop: 35_000, outstandingCop: 35_000 });
    });

    it("ignora asientos de otros pedidos y de otros tipos (delivery_fee)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [order("o1")],
          receivableEntries: [
            codEntry("o1", 50_000),
            codEntry("o2", 99_000),
            payEntry("o1", 5_000),
            { ...codEntry("o1", -7_000), type: "delivery_fee" as never }
          ]
        })
      );
      expect(report.rows[0]).toMatchObject({ collectedCop: 50_000, driverPayCop: 5_000, outstandingCop: 45_000 });
    });

    it("sin asientos de COD, el recaudo sale del total del pedido (collectedSource order_total)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input({ orders: [order("o1", { totalCop: 62_000 })] }));
      expect(report.rows[0]).toMatchObject({
        collectedCop: 62_000,
        collectedSource: "order_total",
        driverPayCop: 0,
        expectedCashCop: 62_000,
        outstandingCop: 62_000
      });
    });

    it("caso limite: corte pendiente que cubre el pedido en parte → sigue en la lista con lo recibido descontado", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [order("o1")],
          settlements: [
            settlement("s1", {
              status: "pending",
              orderIds: ["o1"],
              cashExpectedCop: 45_000,
              cashReceivedCop: 20_000,
              cashPendingCop: 25_000,
              cashAllocations: [{ orderId: "o1", expectedCop: 45_000, receivedCop: 20_000, covered: false }]
            })
          ],
          receivableEntries: [codEntry("o1", 50_000), payEntry("o1", 5_000)]
        })
      );
      expect(rowIds(report.rows)).toEqual(["o1"]);
      expect(report.rows[0]).toMatchObject({ expectedCashCop: 45_000, receivedCop: 20_000, outstandingCop: 25_000 });
    });

    it("caso limite: contraentrega con recaudo de $1 aparece con su peso", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({ orders: [order("o-1peso", { totalCop: 1 })], receivableEntries: [codEntry("o-1peso", 1)] })
      );
      expect(rowIds(report.rows)).toEqual(["o-1peso"]);
      expect(report.rows[0]).toMatchObject({ collectedCop: 1, expectedCashCop: 1, outstandingCop: 1 });
    });

    it("plan 4.5: recaudo <= pago → aparece con expectedCashCop 0 y outstandingCop 0", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({ orders: [order("o1")], receivableEntries: [codEntry("o1", 5_000), payEntry("o1", 8_000)] })
      );
      expect(rowIds(report.rows)).toEqual(["o1"]);
      expect(report.rows[0]).toMatchObject({ expectedCashCop: 0, outstandingCop: 0 });
    });

    it("los importes son enteros (Math.round por asiento, como la posicion)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({ orders: [order("o1")], receivableEntries: [codEntry("o1", 50_000.4), payEntry("o1", 4_999.6)] })
      );
      expect(report.rows[0]).toMatchObject({ collectedCop: 50_000, driverPayCop: 5_000, outstandingCop: 45_000 });
    });
  });

  describe("invariante full / targeted (plan 4.2)", () => {
    it("rows y nettedRows son identicos con todos los asientos y con solo los de los no recibidos", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const universe = mixedUniverse();
      const received = buildCodReceivedSet(universe.settlements);
      const full = buildCashOutstandingReport(input({ ...universe, coverage: "full" }));
      const targeted = buildCashOutstandingReport(
        input({
          ...universe,
          coverage: "targeted",
          receivableEntries: universe.receivableEntries.filter((entry) => !received.has(entry.orderId))
        })
      );
      expect(full.rows.length + full.nettedRows.length).toBeGreaterThan(0);
      expect(targeted.rows).toEqual(full.rows);
      expect(targeted.nettedRows).toEqual(full.nettedRows);
    });
  });

  describe("isIncomplete y unreadable*", () => {
    it("sin nada ilegible → isIncomplete false y listas vacias", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(mixedUniverse()));
      expect(report.isIncomplete).toBe(false);
      expect(report.unreadableOrderIds).toEqual([]);
      expect(report.unreadableSettlementIds).toEqual([]);
      expect(report.unreadableEntryIds).toEqual([]);
    });

    it("un asiento ilegible → isIncomplete true y su id en unreadableEntryIds", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input({ ...mixedUniverse(), unreadableEntryIds: ["e-bad"] }));
      expect(report.isIncomplete).toBe(true);
      expect(report.unreadableEntryIds).toEqual(["e-bad"]);
    });

    it("un pedido ilegible → isIncomplete true y su id en unreadableOrderIds", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input({ ...mixedUniverse(), unreadableOrderIds: ["o-bad"] }));
      expect(report.isIncomplete).toBe(true);
      expect(report.unreadableOrderIds).toEqual(["o-bad"]);
    });

    it("un corte ilegible → isIncomplete true y su id en unreadableSettlementIds", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input({ ...mixedUniverse(), unreadableSettlementIds: ["s-bad"] }));
      expect(report.isIncomplete).toBe(true);
      expect(report.unreadableSettlementIds).toEqual(["s-bad"]);
    });
  });
});
