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

// ---------------------------------------------------------------------------------------------------
// T7
// ---------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const daysAgo = (days: number, extraMs = 0) => new Date(Date.parse(NOW) - days * DAY_MS - extraMs).toISOString();

/** Pedido entregado hace `days` dias (closedAt), con su recaudo y pago en el ledger. */
function aged(id: string, days: number, overrides: Partial<OrderFixture> = {}) {
  const at = daysAgo(days);
  return {
    order: order(id, { closedAt: at, updatedAt: at, ...overrides }),
    entries: [codEntry(id, 50_000), payEntry(id, 5_000)]
  };
}

/** Asignacion sin cubrir: el pedido NO cuenta como recibido segun la regla de RF_01. */
const uncovered = (orderId: string, receivedCop = 0) => ({ orderId, expectedCop: 45_000, receivedCop, covered: false });

/** Corte cerrado y saldado en total (plan 2.9) que deja al pedido sin asignacion cubierta. */
function settledNetting(id: string, orderId: string, overrides: Partial<SettlementFixture> = {}) {
  return settlement(id, {
    status: "paid",
    orderIds: [orderId, `${orderId}-otro`],
    cashExpectedCop: 90_000,
    cashReceivedCop: 90_000,
    cashPendingCop: 0,
    cashAllocations: [{ orderId: `${orderId}-otro`, expectedCop: 45_000, receivedCop: 90_000, covered: true }, uncovered(orderId)],
    ...overrides
  });
}

/** Corte pagado con faltante real: pendiente > 0 y recibido < esperado. */
function paidShort(id: string, orderId: string, overrides: Partial<SettlementFixture> = {}) {
  return settlement(id, {
    status: "paid",
    orderIds: [orderId],
    cashExpectedCop: 45_000,
    cashReceivedCop: 10_000,
    cashPendingCop: 35_000,
    cashAllocations: [uncovered(orderId, 10_000)],
    ...overrides
  });
}

function openSettlement(id: string, orderId: string, overrides: Partial<SettlementFixture> = {}) {
  return settlement(id, {
    status: "pending",
    orderIds: [orderId],
    cashExpectedCop: 45_000,
    cashReceivedCop: 0,
    cashPendingCop: 45_000,
    cashAllocations: [uncovered(orderId)],
    ...overrides
  });
}

describe("T7 · fecha, antiguedad y ubicacion (incluida la compensacion)", () => {
  describe("RF_02: fecha de entrega y su fuente (plan 2.3: closedAt → ultima evidencia delivery → cod_revenue → updatedAt)", () => {
    it("con closedAt usa closedAt (fuente closedAt) aunque haya evidencia y updatedAt posteriores", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [
            order("o1", {
              closedAt: "2026-09-20T15:00:00.000Z",
              updatedAt: "2026-09-30T09:00:00.000Z",
              evidence: [{ type: "delivery", createdAt: "2026-09-21T10:00:00.000Z" }]
            })
          ],
          receivableEntries: [codEntry("o1", 50_000)]
        })
      );
      expect(report.rows[0]).toMatchObject({ deliveredAt: "2026-09-20T15:00:00.000Z", deliveredAtSource: "closedAt" });
    });

    it("sin closedAt usa la ULTIMA evidencia de tipo delivery (fuente evidence), ignorando las failed", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [
            order("o1", {
              closedAt: undefined,
              updatedAt: "2026-09-30T09:00:00.000Z",
              evidence: [
                { type: "failed", createdAt: "2026-09-18T10:00:00.000Z" },
                { type: "delivery", createdAt: "2026-09-22T10:00:00.000Z" },
                { type: "delivery", createdAt: "2026-09-19T10:00:00.000Z" },
                { type: "failed", createdAt: "2026-09-25T10:00:00.000Z" }
              ]
            })
          ],
          receivableEntries: [codEntry("o1", 50_000)]
        })
      );
      expect(report.rows[0]).toMatchObject({ deliveredAt: "2026-09-22T10:00:00.000Z", deliveredAtSource: "evidence" });
    });

    it("sin closedAt ni evidencia delivery usa la fecha del asiento cod_revenue (fuente cod_entry)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const revenue = { ...codEntry("o1", 50_000), createdAt: "2026-09-23T08:00:00.000Z" };
      const report = buildCashOutstandingReport(
        input({
          orders: [
            order("o1", {
              closedAt: undefined,
              updatedAt: "2026-09-30T09:00:00.000Z",
              evidence: [{ type: "failed", createdAt: "2026-09-18T10:00:00.000Z" }]
            })
          ],
          receivableEntries: [revenue, payEntry("o1", 5_000)]
        })
      );
      expect(report.rows[0]).toMatchObject({ deliveredAt: "2026-09-23T08:00:00.000Z", deliveredAtSource: "cod_entry" });
    });

    it("sin closedAt, sin evidencia delivery y sin asiento cod_revenue usa updatedAt (fuente updatedAt, \"aprox.\")", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(
        input({
          orders: [order("o1", { closedAt: undefined, updatedAt: "2026-09-24T07:00:00.000Z", evidence: [] })],
          receivableEntries: []
        })
      );
      expect(report.rows[0]).toMatchObject({ deliveredAt: "2026-09-24T07:00:00.000Z", deliveredAtSource: "updatedAt" });
    });
  });

  describe("RF_03: antiguedad y vencido contra settings.overdueDays", () => {
    it("dia 7 exacto → ageDays 7 y NO vencido (plazo 7)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o7", 7);
      const report = buildCashOutstandingReport(input({ orders: [o], receivableEntries: entries }));
      expect(report.rows[0]).toMatchObject({ ageDays: 7, isOverdue: false });
    });

    it("7 dias y 23 horas → ageDays 7 (floor) y NO vencido", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const at = daysAgo(7, 23 * 3_600_000);
      const report = buildCashOutstandingReport(
        input({ orders: [order("o7b", { closedAt: at, updatedAt: at })], receivableEntries: [codEntry("o7b", 50_000)] })
      );
      expect(report.rows[0]).toMatchObject({ ageDays: 7, isOverdue: false });
    });

    it("dia 8 → ageDays 8 y vencido (plazo 7)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o8", 8);
      const report = buildCashOutstandingReport(input({ orders: [o], receivableEntries: entries }));
      expect(report.rows[0]).toMatchObject({ ageDays: 8, isOverdue: true });
    });

    it("el plazo sale de settings.overdueDays: con 3, un pedido de 4 dias esta vencido y uno de 3 no", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("o3", 3);
      const b = aged("o4", 4);
      const report = buildCashOutstandingReport(
        input({
          orders: [a.order, b.order],
          receivableEntries: [...a.entries, ...b.entries],
          settings: { overdueDays: 3, notifyMinCop: 20_000 }
        })
      );
      const byId = new Map(report.rows.map((row) => [row.orderId, row]));
      expect(byId.get("o3")).toMatchObject({ ageDays: 3, isOverdue: false });
      expect(byId.get("o4")).toMatchObject({ ageDays: 4, isOverdue: true });
    });

    it("con un plazo de 30, un pedido de 8 dias NO esta vencido", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o8", 8);
      const report = buildCashOutstandingReport(
        input({ orders: [o], receivableEntries: entries, settings: { overdueDays: 30, notifyMinCop: 20_000 } })
      );
      expect(report.rows[0]).toMatchObject({ ageDays: 8, isOverdue: false });
    });
  });

  describe("RF_02 / RF_09: ubicacion con la precedencia del plan 2.9", () => {
    it("fuera de todo corte → outside_settlement, settlements [] y attributedSettlementId null", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-out", 10);
      const report = buildCashOutstandingReport(input({ orders: [o], receivableEntries: entries }));
      expect(report.rows[0]).toMatchObject({
        location: "outside_settlement",
        settlements: [],
        attributedSettlementId: null,
        isOverdue: true
      });
      expect(report.nettedRows).toEqual([]);
    });

    it("en un corte pendiente → in_settlement_open, atribuido a ese corte, en rows", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-open", 10);
      const report = buildCashOutstandingReport(
        input({ orders: [o], receivableEntries: entries, settlements: [openSettlement("s-open", "o-open")] })
      );
      expect(rowIds(report.rows)).toEqual(["o-open"]);
      expect(report.rows[0]).toMatchObject({ location: "in_settlement_open", attributedSettlementId: "s-open", isOverdue: true });
    });

    it("pagado con faltante real (pendiente > 0) → settlement_paid_short, en rows, vencido si pasa el plazo", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-short", 20);
      const report = buildCashOutstandingReport(
        input({ orders: [o], receivableEntries: entries, settlements: [paidShort("s-short", "o-short")] })
      );
      expect(rowIds(report.rows)).toEqual(["o-short"]);
      expect(report.nettedRows).toEqual([]);
      expect(report.rows[0]).toMatchObject({
        location: "settlement_paid_short",
        attributedSettlementId: "s-short",
        isOverdue: true,
        ageDays: 20
      });
    });

    it("corte pagado saldado en total con el pedido sin asignacion cubierta → covered_by_netting, en nettedRows, isOverdue false con 90 dias", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-net", 90);
      const report = buildCashOutstandingReport(
        input({ orders: [o], receivableEntries: entries, settlements: [settledNetting("s-net", "o-net")] })
      );
      expect(rowIds(report.rows)).toEqual([]);
      expect(rowIds(report.nettedRows)).toEqual(["o-net"]);
      expect(report.nettedRows[0]).toMatchObject({
        location: "covered_by_netting",
        attributedSettlementId: "s-net",
        ageDays: 90,
        isOverdue: false
      });
    });

    it("conciliado (reconciled) con excedente y pendiente ausente → tambien covered_by_netting", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-net", 40);
      const s = settledNetting("s-rec", "o-net", { status: "reconciled", cashReceivedCop: 95_000, cashPendingCop: undefined });
      const report = buildCashOutstandingReport(input({ orders: [o], receivableEntries: entries, settlements: [s] }));
      expect(rowIds(report.nettedRows)).toEqual(["o-net"]);
      expect(report.nettedRows[0]).toMatchObject({ location: "covered_by_netting", isOverdue: false });
    });

    it("pendiente + saldado → in_settlement_open (el abierto manda), en rows, atribuido al pendiente", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-mix", 30);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [
            settledNetting("s-net", "o-mix", { createdAt: "2026-09-25T10:00:00.000Z" }),
            openSettlement("s-open", "o-mix", { createdAt: "2026-09-20T10:00:00.000Z" })
          ]
        })
      );
      expect(rowIds(report.rows)).toEqual(["o-mix"]);
      expect(report.nettedRows).toEqual([]);
      expect(report.rows[0]).toMatchObject({ location: "in_settlement_open", attributedSettlementId: "s-open", isOverdue: true });
    });

    it("saldado + pagado con faltante → covered_by_netting (la compensacion manda sobre el faltante)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-both", 50);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [
            paidShort("s-short", "o-both", { createdAt: "2026-09-27T10:00:00.000Z" }),
            settledNetting("s-net", "o-both", { createdAt: "2026-09-10T10:00:00.000Z" })
          ]
        })
      );
      expect(rowIds(report.rows)).toEqual([]);
      expect(rowIds(report.nettedRows)).toEqual(["o-both"]);
      expect(report.nettedRows[0]).toMatchObject({ location: "covered_by_netting", attributedSettlementId: "s-net", isOverdue: false });
    });

    it("con dos cortes pendientes se atribuye al MAS RECIENTE", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-2open", 10);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [
            openSettlement("s-old", "o-2open", { createdAt: "2026-09-15T10:00:00.000Z" }),
            openSettlement("s-new", "o-2open", { createdAt: "2026-09-28T10:00:00.000Z" })
          ]
        })
      );
      expect(report.rows[0]).toMatchObject({ location: "in_settlement_open", attributedSettlementId: "s-new" });
    });

    it("con dos cortes pagados con faltante se atribuye al MAS RECIENTE", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-2short", 25);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [
            paidShort("s-new", "o-2short", { createdAt: "2026-09-26T10:00:00.000Z" }),
            paidShort("s-old", "o-2short", { createdAt: "2026-09-12T10:00:00.000Z" })
          ]
        })
      );
      expect(report.rows[0]).toMatchObject({ location: "settlement_paid_short", attributedSettlementId: "s-new" });
    });

    it("con dos cortes saldados se atribuye al saldado MAS RECIENTE", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-2net", 60);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [
            settledNetting("s-old", "o-2net", { createdAt: "2026-08-01T10:00:00.000Z" }),
            settledNetting("s-new", "o-2net", { createdAt: "2026-08-20T10:00:00.000Z" })
          ]
        })
      );
      expect(report.nettedRows[0]).toMatchObject({ location: "covered_by_netting", attributedSettlementId: "s-new" });
    });

    it("row.settlements lleva cashSettled por corte y orden createdAt desc", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-both", 50);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [
            settledNetting("s-net", "o-both", { createdAt: "2026-09-10T10:00:00.000Z" }),
            paidShort("s-short", "o-both", { createdAt: "2026-09-27T10:00:00.000Z" })
          ]
        })
      );
      const row = report.nettedRows[0];
      expect(row?.settlements).toEqual([
        { id: "s-short", status: "paid", createdAt: "2026-09-27T10:00:00.000Z", cashSettled: false },
        { id: "s-net", status: "paid", createdAt: "2026-09-10T10:00:00.000Z", cashSettled: true }
      ]);
    });

    it("universo mixto: o-netted (corte saldado con su asignacion sin cubrir) va a nettedRows; el resto a rows", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(mixedUniverse()));
      expect(rowIds(report.nettedRows)).toEqual(["o-netted"]);
      expect(rowIds(report.rows)).toEqual(["o-june", "o-liq", "o-no-leader", "o-other-leader", "o-out", "o-partial"].sort());
      const partial = report.rows.find((row) => row.orderId === "o-partial");
      expect(partial).toMatchObject({ location: "in_settlement_open", attributedSettlementId: "s-partial" });
    });
  });

  describe("nombres desde los Maps de input.names", () => {
    it("tienda, lider y mensajero salen de sus Maps", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o1", 2, { sellerId: "seller-9", driverId: "leader-9", messengerId: "msg-9" });
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          names: {
            sellers: new Map([["seller-9", "Tienda Nueve"]]),
            leaders: new Map([["leader-9", "Lider Nueve"]]),
            messengers: new Map([["msg-9", "Mensajero Nueve"]])
          }
        })
      );
      expect(report.rows[0]).toMatchObject({
        sellerName: "Tienda Nueve",
        leaderId: "leader-9",
        leaderName: "Lider Nueve",
        messengerId: "msg-9",
        messengerName: "Mensajero Nueve"
      });
    });

    it("las filas compensadas tambien llevan sus nombres", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-net", 90);
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          settlements: [settledNetting("s-net", "o-net")],
          names: {
            sellers: new Map([["seller-1", "Tienda Uno"]]),
            leaders: new Map([["leader-1", "Lider Uno"]]),
            messengers: new Map([["messenger-1", "Mensajero Uno"]])
          }
        })
      );
      expect(report.nettedRows[0]).toMatchObject({ sellerName: "Tienda Uno", leaderName: "Lider Uno", messengerName: "Mensajero Uno" });
    });

    it("sin lider ni mensajero → leaderName y messengerName null", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { order: o, entries } = aged("o-nl", 2, { driverId: null, messengerId: null });
      const report = buildCashOutstandingReport(
        input({
          orders: [o],
          receivableEntries: entries,
          names: { sellers: new Map([["seller-1", "Tienda Uno"]]), leaders: new Map(), messengers: new Map() }
        })
      );
      expect(report.rows[0]).toMatchObject({ sellerName: "Tienda Uno", leaderName: null, messengerName: null });
    });
  });

  describe("orden: rows y nettedRows por deliveredAt asc", () => {
    it("rows sale del mas antiguo al mas reciente, sin importar el orden de entrada", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("o-a", 3);
      const b = aged("o-b", 40);
      const c = aged("o-c", 12);
      const report = buildCashOutstandingReport(
        input({ orders: [a.order, b.order, c.order], receivableEntries: [...a.entries, ...b.entries, ...c.entries] })
      );
      expect(report.rows.map((row) => row.orderId)).toEqual(["o-b", "o-c", "o-a"]);
    });

    it("nettedRows sale del mas antiguo al mas reciente", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("n-a", 35);
      const b = aged("n-b", 95);
      const report = buildCashOutstandingReport(
        input({
          orders: [a.order, b.order],
          receivableEntries: [...a.entries, ...b.entries],
          settlements: [settledNetting("s-a", "n-a"), settledNetting("s-b", "n-b")]
        })
      );
      expect(report.nettedRows.map((row) => row.orderId)).toEqual(["n-b", "n-a"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// T8
// ---------------------------------------------------------------------------------------------------

/** Asiento `product_cost` de tienda (negativo, como en el ledger) retenido para un proveedor. */
function productCost(orderId: string, amountCop: number, supplier?: { id: string; name: string }, extra: Record<string, unknown> = {}) {
  entrySeq += 1;
  return {
    id: `pc-${orderId}-${entrySeq}`,
    ownerType: "seller" as const,
    ownerId: "seller-1",
    orderId,
    type: "product_cost" as const,
    amountCop: -Math.abs(amountCop),
    description: "",
    createdAt: "2026-09-28T15:00:00.000Z",
    ...(supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
    ...extra
  };
}

const SUP_A = { id: "sup-a", name: "Proveedor A" };
const SUP_B = { id: "sup-b", name: "Proveedor B" };
const sumOf = <T,>(items: T[], pick: (item: T) => number) => items.reduce((total, item) => total + pick(item), 0);

describe("T8 · agrupaciones, proveedor, alcance y totales", () => {
  describe("RF_03 / RF_06: byLeader solo de rows", () => {
    it("una fila con driverId null forma un grupo de byLeader con leaderId null (pedido sin lider)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("o-sin", 10, { driverId: null, messengerId: null });
      const b = aged("o-con", 10);
      const report = buildCashOutstandingReport(
        input({ orders: [a.order, b.order], receivableEntries: [...a.entries, ...b.entries] })
      );
      const orphan = report.byLeader.find((group) => group.leaderId === null);
      expect(orphan).toMatchObject({ leaderId: null, leaderName: null, orderCount: 1, outstandingCop: 45_000 });
      expect(report.byLeader.map((group) => group.leaderId).sort()).toEqual(["leader-1", null].sort());
    });

    it("cada grupo suma orderCount, collectedCop, outstandingCop, overdueCount, overdueCop y su entrega mas antigua", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("o-a", 3);
      const b = aged("o-b", 20);
      const c = aged("o-c", 12);
      const report = buildCashOutstandingReport(
        input({
          orders: [a.order, b.order, c.order],
          receivableEntries: [...a.entries, ...b.entries, ...c.entries],
          names: { sellers: new Map(), leaders: new Map([["leader-1", "Lider Uno"]]), messengers: new Map() }
        })
      );
      expect(report.byLeader).toEqual([
        {
          leaderId: "leader-1",
          leaderName: "Lider Uno",
          orderCount: 3,
          collectedCop: 150_000,
          outstandingCop: 135_000,
          overdueCount: 2,
          overdueCop: 90_000,
          // T19 (R1-RF_03-1): el bruto vencido junto al neto; sin el, este `toEqual` no ve la forma real.
          overdueCollectedCop: 100_000,
          oldestDeliveredAt: daysAgo(20)
        }
      ]);
    });

    it("orden por overdueCop desc aunque otro lider tenga mas pedidos", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const many = [aged("m-1", 2), aged("m-2", 3), aged("m-3", 4)]; // leader-1, ninguno vencido
      const few = aged("f-1", 15, { driverId: "leader-2" }); // leader-2, uno vencido
      const report = buildCashOutstandingReport(
        input({
          orders: [...many.map((item) => item.order), few.order],
          receivableEntries: [...many.flatMap((item) => item.entries), ...few.entries]
        })
      );
      expect(report.byLeader.map((group) => group.leaderId)).toEqual(["leader-2", "leader-1"]);
      expect(report.byLeader[0]).toMatchObject({ orderCount: 1, overdueCop: 45_000 });
      expect(report.byLeader[1]).toMatchObject({ orderCount: 3, overdueCop: 0 });
    });

    it("a igual overdueCop desempata por outstandingCop desc y luego por id", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const z = [aged("z-1", 2, { driverId: "leader-z" }), aged("z-2", 2, { driverId: "leader-z" })]; // 90.000 sin vencer
      const y = aged("y-1", 2, { driverId: "leader-y" }); // 45.000 sin vencer
      const x = aged("x-1", 2, { driverId: "leader-x" }); // 45.000 sin vencer
      const report = buildCashOutstandingReport(
        input({
          orders: [y.order, x.order, ...z.map((item) => item.order)],
          receivableEntries: [...y.entries, ...x.entries, ...z.flatMap((item) => item.entries)]
        })
      );
      expect(report.byLeader.map((group) => group.leaderId)).toEqual(["leader-z", "leader-x", "leader-y"]);
    });

    it("RF_09: un compensado no forma grupo ni suma al de su lider", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const netted = aged("o-net", 90, { driverId: "leader-2" });
      const nettedSame = aged("o-net-1", 60);
      const live = aged("o-live", 10);
      const report = buildCashOutstandingReport(
        input({
          orders: [netted.order, nettedSame.order, live.order],
          receivableEntries: [...netted.entries, ...nettedSame.entries, ...live.entries],
          settlements: [settledNetting("s-net", "o-net"), settledNetting("s-net-1", "o-net-1")]
        })
      );
      expect(report.byLeader).toHaveLength(1);
      expect(report.byLeader[0]).toMatchObject({
        leaderId: "leader-1",
        orderCount: 1,
        collectedCop: 50_000,
        outstandingCop: 45_000,
        overdueCount: 1,
        overdueCop: 45_000,
        oldestDeliveredAt: daysAgo(10)
      });
    });
  });

  describe("RF_03 / RF_09: totales", () => {
    function scenario() {
      const out = aged("t-out", 10); // fuera, vencido
      const open = aged("t-open", 3); // corte abierto, sin vencer
      const short = aged("t-short", 20); // pagado con faltante, vencido
      const n1 = aged("t-n1", 90);
      const n2 = aged("t-n2", 40);
      const n3 = aged("t-n3", 35);
      const sharedNetting = settlement("s-shared", {
        status: "paid",
        orderIds: ["t-n1", "t-n2", "t-shared-otro"],
        cashExpectedCop: 135_000,
        cashReceivedCop: 135_000,
        cashPendingCop: 0,
        cashAllocations: [
          { orderId: "t-shared-otro", expectedCop: 45_000, receivedCop: 135_000, covered: true },
          uncovered("t-n1"),
          uncovered("t-n2")
        ]
      });
      return {
        orders: [out, open, short, n1, n2, n3].map((item) => item.order),
        receivableEntries: [out, open, short, n1, n2, n3].flatMap((item) => item.entries),
        settlements: [openSettlement("s-open", "t-open"), paidShort("s-short", "t-short"), sharedNetting, settledNetting("s-n3", "t-n3")]
      };
    }

    it("orderCount, collectedCop y outstandingCop solo de rows", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(scenario()));
      expect(rowIds(report.rows)).toEqual(["t-open", "t-out", "t-short"]);
      expect(report.totals.orderCount).toBe(3);
      expect(report.totals.collectedCop).toBe(150_000);
      expect(report.totals.outstandingCop).toBe(sumOf(report.rows, (row) => row.outstandingCop));
      expect(report.totals.outstandingCop).toBeGreaterThan(0);
    });

    it("los subtotales por ubicacion suman outstandingCop", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(scenario()));
      const byLocation = (location: string) =>
        sumOf(report.rows.filter((row) => row.location === location), (row) => row.outstandingCop);
      expect(report.totals.outsideSettlementCop).toBe(byLocation("outside_settlement"));
      expect(report.totals.inOpenSettlementCop).toBe(byLocation("in_settlement_open"));
      expect(report.totals.paidShortCop).toBe(byLocation("settlement_paid_short"));
      expect(report.totals.outsideSettlementCop + report.totals.inOpenSettlementCop + report.totals.paidShortCop).toBe(
        report.totals.outstandingCop
      );
      expect(report.totals.outsideSettlementCop).toBe(45_000);
      expect(report.totals.inOpenSettlementCop).toBe(45_000);
    });

    it("overdueCount y overdueCop cuentan solo filas vencidas de rows", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(scenario()));
      const overdue = report.rows.filter((row) => row.isOverdue);
      expect(overdue.map((row) => row.orderId).sort()).toEqual(["t-out", "t-short"]);
      expect(report.totals.overdueCount).toBe(2);
      expect(report.totals.overdueCop).toBe(sumOf(overdue, (row) => row.outstandingCop));
    });

    it("RF_09: los compensados van a netted* y no a outstandingCop ni overdueCop", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const withNetted = buildCashOutstandingReport(input(scenario()));
      const base = scenario();
      const keep = new Set(["t-out", "t-open", "t-short"]);
      const withoutNetted = buildCashOutstandingReport(
        input({ ...base, orders: base.orders.filter((candidate) => keep.has(candidate.id)) })
      );
      expect(withNetted.totals.nettedCount).toBe(3);
      expect(withNetted.totals.nettedCollectedCop).toBe(150_000);
      expect(withNetted.totals.outstandingCop).toBe(withoutNetted.totals.outstandingCop);
      expect(withNetted.totals.overdueCop).toBe(withoutNetted.totals.overdueCop);
      expect(withNetted.totals.overdueCount).toBe(withoutNetted.totals.overdueCount);
      expect(withNetted.totals.orderCount).toBe(withoutNetted.totals.orderCount);
    });

    it("nettedSettlementCount = cortes distintos a los que se atribuyen los compensados (decision T8)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input(scenario()));
      expect(new Set(report.nettedRows.map((row) => row.attributedSettlementId))).toEqual(new Set(["s-shared", "s-n3"]));
      expect(report.totals.nettedSettlementCount).toBe(2);
    });

    it("sin pedidos, todos los totales en cero", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(input());
      expect(Object.values(report.totals).every((value) => value === 0)).toBe(true);
      expect(report.byLeader).toEqual([]);
      expect(report.bySupplier).toEqual([]);
    });
  });

  describe("RF_08: retenido por proveedor (clave de supplier-withheld.ts)", () => {
    it("supplierWithheld por fila = groupWithheldBySupplier de sus product_cost, solo de ese pedido", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const { groupWithheldBySupplier } = await import("../../functions/src/supplier-withheld");
      const a = aged("o-a", 10);
      const b = aged("o-b", 10);
      const costsA = [productCost("o-a", 12_000, SUP_A), productCost("o-a", 3_000, SUP_B), productCost("o-a", 1_000, SUP_A)];
      const costsB = [productCost("o-b", 7_000, SUP_B)];
      const report = buildCashOutstandingReport(
        input({
          orders: [a.order, b.order],
          receivableEntries: [...a.entries, ...b.entries],
          productCostEntries: [...costsA, ...costsB]
        })
      );
      const rowA = report.rows.find((row) => row.orderId === "o-a")!;
      expect(rowA.supplierWithheld).toEqual(groupWithheldBySupplier(costsA));
      expect(rowA.supplierWithheld).toEqual([
        { supplierId: "sup-a", supplierName: "Proveedor A", amountCop: 13_000 },
        { supplierId: "sup-b", supplierName: "Proveedor B", amountCop: 3_000 }
      ]);
    });

    it('un product_cost sin supplierId cae en "(sin proveedor)"', async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("o-a", 10);
      const report = buildCashOutstandingReport(
        input({ orders: [a.order], receivableEntries: a.entries, productCostEntries: [productCost("o-a", 8_000)] })
      );
      expect(report.rows[0].supplierWithheld).toEqual([{ supplierId: "(sin proveedor)", supplierName: "(sin proveedor)", amountCop: 8_000 }]);
      expect(report.bySupplier).toEqual([
        { supplierId: "(sin proveedor)", supplierName: "(sin proveedor)", amountCop: 8_000, overdueAmountCop: 8_000, nettedAmountCop: 0 }
      ]);
    });

    it("un product_cost ya liquidado al proveedor (supplierSettlementId) no cuenta como retenido (decision T8, como la posicion)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const a = aged("o-a", 10);
      const report = buildCashOutstandingReport(
        input({
          orders: [a.order],
          receivableEntries: a.entries,
          productCostEntries: [productCost("o-a", 5_000, SUP_A, { supplierSettlementId: "sup-set-1" }), productCost("o-a", 2_000, SUP_A)]
        })
      );
      expect(report.rows[0].supplierWithheld).toEqual([{ supplierId: "sup-a", supplierName: "Proveedor A", amountCop: 2_000 }]);
    });

    it("bySupplier agrega solo rows, con overdueAmountCop de las vencidas, ordenado por amountCop desc", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const overdue = aged("o-old", 15);
      const fresh = aged("o-new", 2);
      const report = buildCashOutstandingReport(
        input({
          orders: [overdue.order, fresh.order],
          receivableEntries: [...overdue.entries, ...fresh.entries],
          productCostEntries: [
            productCost("o-old", 4_000, SUP_A),
            productCost("o-new", 6_000, SUP_A),
            productCost("o-old", 20_000, SUP_B)
          ]
        })
      );
      expect(report.bySupplier).toEqual([
        { supplierId: "sup-b", supplierName: "Proveedor B", amountCop: 20_000, overdueAmountCop: 20_000, nettedAmountCop: 0 },
        { supplierId: "sup-a", supplierName: "Proveedor A", amountCop: 10_000, overdueAmountCop: 4_000, nettedAmountCop: 0 }
      ]);
    });

    // 2026-10-02 · R1-RF_08-1 (.sdd/findings.json), tarea T21: esta prueba afirmaba lo CONTRARIO ("el
    // product_cost de un compensado no suma a bySupplier"). RF_09 no cambia la regla de RF_01, asi que el corte
    // de proveedor del servidor (functions/src/orders.ts, isSellerEntryEligible + buildCodReceivedSet) tampoco
    // paga el producto de un pedido compensado: "No se puede pagar todavia" tiene que incluirlo.
    it("RF_09: el product_cost de un compensado SI suma a bySupplier.amountCop y a nettedAmountCop, no a overdueAmountCop", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const live = aged("o-live", 10);
      const netted = aged("o-net", 90);
      const report = buildCashOutstandingReport(
        input({
          orders: [live.order, netted.order],
          receivableEntries: [...live.entries, ...netted.entries],
          settlements: [settledNetting("s-net", "o-net")],
          productCostEntries: [productCost("o-live", 3_000, SUP_A), productCost("o-net", 50_000, SUP_A)]
        })
      );
      expect(rowIds(report.nettedRows)).toEqual(["o-net"]);
      expect(report.bySupplier).toEqual([
        { supplierId: "sup-a", supplierName: "Proveedor A", amountCop: 53_000, overdueAmountCop: 3_000, nettedAmountCop: 50_000 }
      ]);
    });
  });

  describe("RF_06: alcance de lider", () => {
    function leaderScenario() {
      const mine = aged("l-mine", 10);
      const mineFresh = aged("l-mine-2", 2);
      const other = aged("l-other", 30, { driverId: "leader-2" });
      const orphan = aged("l-orphan", 30, { driverId: null });
      const items = [mine, mineFresh, other, orphan];
      return input({
        orders: items.map((item) => item.order),
        receivableEntries: items.flatMap((item) => item.entries),
        productCostEntries: [productCost("l-mine", 9_000, SUP_A), productCost("l-other", 9_000, SUP_B)],
        scope: { kind: "leader", driverId: "leader-1" }
      });
    }

    it("el lider solo ve lo suyo: un grupo, el suyo, y totales solo de sus pedidos", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(leaderScenario());
      expect(rowIds(report.rows)).toEqual(["l-mine", "l-mine-2"]);
      expect(report.byLeader.map((group) => group.leaderId)).toEqual(["leader-1"]);
      expect(report.byLeader[0]).toMatchObject({ orderCount: 2, outstandingCop: 90_000, overdueCount: 1, overdueCop: 45_000 });
      expect(report.totals).toMatchObject({ orderCount: 2, outstandingCop: 90_000, overdueCount: 1, overdueCop: 45_000 });
    });

    it("sin proveedor para el lider: bySupplier [] y supplierWithheld [] por fila aunque lleguen product_cost", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(leaderScenario());
      expect(report.bySupplier).toEqual([]);
      expect(report.rows.every((row) => row.supplierWithheld.length === 0)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// T21 · el producto de los compensados tampoco se puede pagar al proveedor (R1-RF_08-1)
// ---------------------------------------------------------------------------------------------------

describe("T21 · bySupplier incluye el producto retenido de los compensados (R1-RF_08-1, RF_08, RF_09)", () => {
  it("proveedor solo con compensados: aparece con amountCop = nettedAmountCop y overdueAmountCop 0", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const n1 = aged("o-n1", 90);
    const n2 = aged("o-n2", 60);
    const report = buildCashOutstandingReport(
      input({
        orders: [n1.order, n2.order],
        receivableEntries: [...n1.entries, ...n2.entries],
        settlements: [settledNetting("s-n1", "o-n1"), settledNetting("s-n2", "o-n2")],
        productCostEntries: [productCost("o-n1", 30_000, SUP_A), productCost("o-n2", 12_000, SUP_A)]
      })
    );
    expect(report.rows).toEqual([]);
    expect(rowIds(report.nettedRows)).toEqual(["o-n1", "o-n2"]);
    expect(report.bySupplier).toEqual([
      { supplierId: "sup-a", supplierName: "Proveedor A", amountCop: 42_000, overdueAmountCop: 0, nettedAmountCop: 42_000 }
    ]);
  });

  it("mezcla: amountCop = rows + compensados, nettedAmountCop solo compensados, overdueAmountCop solo vencidas de rows", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const overdue = aged("o-old", 15); // rows, vencida
    const fresh = aged("o-new", 2); // rows, sin vencer
    const netted = aged("o-net", 90); // compensado: 90 dias, pero no vence
    const report = buildCashOutstandingReport(
      input({
        orders: [overdue.order, fresh.order, netted.order],
        receivableEntries: [...overdue.entries, ...fresh.entries, ...netted.entries],
        settlements: [settledNetting("s-net", "o-net")],
        productCostEntries: [
          productCost("o-old", 4_000, SUP_A),
          productCost("o-new", 6_000, SUP_A),
          productCost("o-net", 7_000, SUP_A),
          productCost("o-net", 1_500, SUP_B)
        ]
      })
    );
    expect(report.bySupplier.find((item) => item.supplierId === "sup-a")).toEqual({
      supplierId: "sup-a",
      supplierName: "Proveedor A",
      amountCop: 17_000,
      overdueAmountCop: 4_000,
      nettedAmountCop: 7_000
    });
    expect(report.bySupplier.find((item) => item.supplierId === "sup-b")).toEqual({
      supplierId: "sup-b",
      supplierName: "Proveedor B",
      amountCop: 1_500,
      overdueAmountCop: 0,
      nettedAmountCop: 1_500
    });
  });

  it("el product_cost de un compensado ya liquidado al proveedor (supplierSettlementId) no suma", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const netted = aged("o-net", 90);
    const report = buildCashOutstandingReport(
      input({
        orders: [netted.order],
        receivableEntries: netted.entries,
        settlements: [settledNetting("s-net", "o-net")],
        productCostEntries: [productCost("o-net", 9_000, SUP_A, { supplierSettlementId: "sup-set-1" }), productCost("o-net", 2_000, SUP_A)]
      })
    );
    expect(report.bySupplier).toEqual([
      { supplierId: "sup-a", supplierName: "Proveedor A", amountCop: 2_000, overdueAmountCop: 0, nettedAmountCop: 2_000 }
    ]);
  });

  it("el lider sigue con bySupplier [] aunque tenga compensados con product_cost", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const mine = aged("l-mine", 10);
    const netted = aged("l-net", 90);
    const report = buildCashOutstandingReport(
      input({
        orders: [mine.order, netted.order],
        receivableEntries: [...mine.entries, ...netted.entries],
        settlements: [settledNetting("s-net", "l-net")],
        productCostEntries: [productCost("l-mine", 9_000, SUP_A), productCost("l-net", 40_000, SUP_A)],
        scope: { kind: "leader", driverId: "leader-1" }
      })
    );
    expect(rowIds(report.nettedRows)).toEqual(["l-net"]);
    expect(report.bySupplier).toEqual([]);
  });

  it("orden por amountCop desc contando los compensados (un proveedor solo compensado puede ir primero)", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const live = aged("o-live", 10);
    const netted = aged("o-net", 90);
    const report = buildCashOutstandingReport(
      input({
        orders: [live.order, netted.order],
        receivableEntries: [...live.entries, ...netted.entries],
        settlements: [settledNetting("s-net", "o-net")],
        productCostEntries: [productCost("o-live", 10_000, SUP_A), productCost("o-net", 25_000, SUP_B)]
      })
    );
    expect(report.bySupplier.map((item) => [item.supplierId, item.amountCop])).toEqual([
      ["sup-b", 25_000],
      ["sup-a", 10_000]
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// T9 · conciliacion por causas sin residuo (plan 4.4)
// ---------------------------------------------------------------------------------------------------

type T9Row = ReturnType<CashOutstandingModule["buildCashOutstandingReport"]>["rows"][number];
type T9Reconciliation = import("../../functions/src/cash-outstanding").PositionReconciliation;
type T9ReconcileFn = (input: ReportInput, listed: { rows: T9Row[]; nettedRows: T9Row[] }) => T9Reconciliation;
type T9Entry = ReturnType<typeof codEntry> | ReturnType<typeof payEntry>;

type T9Math = {
  computeDriverCashSummary: typeof import("../../functions/src/settlement-math").computeDriverCashSummary;
  computeDriverReceivable: typeof import("../../functions/src/driver-receivable").computeDriverReceivable;
};

async function t9LoadMath(): Promise<T9Math> {
  const settlementMath = await import("../../functions/src/settlement-math");
  const receivable = await import("../../functions/src/driver-receivable");
  return {
    computeDriverCashSummary: settlementMath.computeDriverCashSummary,
    computeDriverReceivable: receivable.computeDriverReceivable
  };
}

/**
 * Contrato de T9: `cash-outstanding.ts` exporta la conciliacion como funcion pura que recibe la entrada
 * y LAS FILAS de la lista. Asi una fila quitada (o perdida por un fallo de la lista) se ve en
 * `unexplainedCop`: la clasificacion de cada pedido no se deduce de `rows`/`nettedRows`.
 */
function t9Reconcile(core: CashOutstandingModule): T9ReconcileFn {
  const fn = (core as unknown as { reconcileWithPlatformPosition?: T9ReconcileFn }).reconcileWithPlatformPosition;
  if (typeof fn !== "function") {
    throw new Error("T9: falta `export function reconcileWithPlatformPosition(input, { rows, nettedRows })` en functions/src/cash-outstanding.ts");
  }
  return fn;
}

const T9_SCOPE = { kind: "admin" as const, includeReconciliation: true };

type T9World = { orders: OrderFixture[]; entries: T9Entry[]; settlements: SettlementFixture[]; unreadable: string[] };

function t9Input(world: T9World, overrides: Partial<ReportInput> = {}): ReportInput {
  return input({
    orders: world.orders,
    receivableEntries: world.entries,
    settlements: world.settlements,
    unreadableOrderIds: world.unreadable,
    scope: T9_SCOPE,
    coverage: "full",
    ...overrides
  });
}

function t9Merge(...worlds: T9World[]): T9World {
  return {
    orders: worlds.flatMap((world) => world.orders),
    entries: worlds.flatMap((world) => world.entries),
    settlements: worlds.flatMap((world) => world.settlements),
    unreadable: worlds.flatMap((world) => world.unreadable)
  };
}

/** Entradas de un pedido: COD (si `codCop` no es null) y pago (si > 0). */
function t9Entries(orderId: string, codCop: number | null, payCop: number): T9Entry[] {
  const result: T9Entry[] = [];
  if (codCop !== null) result.push(codEntry(orderId, codCop));
  if (payCop > 0) result.push(payEntry(orderId, payCop));
  return result;
}

type T9SettlementOptions = {
  status: "pending" | "paid" | "reconciled";
  orderIds: string[];
  /** Efectivo recibido; "expected" = exactamente lo esperado recalculado. */
  received: number | "expected";
  /** "coherent" = pendiente recalculado; "absent" = sin el campo; numero = guardado tal cual. */
  pending?: "coherent" | "absent" | number;
  allocations?: boolean;
  createdAt?: string;
};

/**
 * Corte de domiciliario COHERENTE por construccion: esperado, asignaciones y pendiente salen de
 * `computeDriverCashSummary` sobre los mismos asientos que recibe el informe.
 */
function t9Settlement(math: T9Math, id: string, entries: T9Entry[], options: T9SettlementOptions): SettlementFixture {
  const cashInputs = {
    sellerEntries: entries.filter((entry) => entry.ownerType === "seller"),
    driverEntries: entries.filter((entry) => entry.ownerType === "driver"),
    orderMeta: new Map()
  };
  const expectedCop = math.computeDriverCashSummary(cashInputs as never, options.orderIds, 0).expectedCop;
  const receivedCop = options.received === "expected" ? expectedCop : options.received;
  const summary = math.computeDriverCashSummary(cashInputs as never, options.orderIds, receivedCop);
  const recalculatedPending = Math.max(0, summary.expectedCop - receivedCop);
  const built = settlement(id, {
    status: options.status,
    orderIds: options.orderIds,
    createdAt: options.createdAt ?? "2026-09-29T10:00:00.000Z",
    cashExpectedCop: summary.expectedCop,
    cashReceivedCop: receivedCop,
    cashPendingCop:
      options.pending === undefined || options.pending === "coherent" ? recalculatedPending : options.pending === "absent" ? 0 : options.pending,
    cashAllocations: summary.allocations
  });
  if (options.pending === "absent") delete built.cashPendingCop;
  if (options.allocations === false) delete built.cashAllocations;
  return built;
}

/** R_s del plan 4.4, recalculado aparte como oraculo: max(0, esperado - recibido). */
function t9RecalculatedPending(math: T9Math, entries: T9Entry[], stored: SettlementFixture): number {
  const cashInputs = {
    sellerEntries: entries.filter((entry) => entry.ownerType === "seller"),
    driverEntries: entries.filter((entry) => entry.ownerType === "driver"),
    orderMeta: new Map()
  };
  const expectedCop = math.computeDriverCashSummary(cashInputs as never, stored.orderIds, 0).expectedCop;
  return Math.max(0, expectedCop - (stored.cashReceivedCop ?? 0));
}

const t9Sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const t9CausesOf = (rec: T9Reconciliation, cause: string) => rec.causes.filter((item) => item.cause === cause);

/**
 * Identidad algebraica y anclas externas, comunes a todas las pruebas:
 *  - driverReceivableCop = computeDriverReceivable (la MISMA formula que la posicion, T3);
 *  - listOutstandingCop = suma de `rows[].outstandingCop` (nettedRows no suma: no falta dinero);
 *  - deltaCop = driverReceivableCop - listOutstandingCop = Σ causes.amountCop + unexplainedCop;
 *  - staleSettlementsCop / missingPendingSettlementsCop = Σ de las causas de su tipo (con signo).
 */
function t9ExpectIdentity(math: T9Math, data: ReportInput, rows: T9Row[], rec: T9Reconciliation) {
  const position = math.computeDriverReceivable(data.receivableEntries, data.settlements);
  expect(rec.driverReceivableCop, "driverReceivableCop = computeDriverReceivable").toBe(position.driverReceivableCop);
  expect(rec.listOutstandingCop, "listOutstandingCop = Σ rows.outstandingCop").toBe(t9Sum(rows.map((row) => row.outstandingCop)));
  expect(rec.deltaCop, "deltaCop = posicion - lista").toBe(rec.driverReceivableCop - rec.listOutstandingCop);
  expect(rec.deltaCop, "deltaCop = Σ causas + unexplainedCop").toBe(t9Sum(rec.causes.map((item) => item.amountCop)) + rec.unexplainedCop);
  expect(rec.staleSettlementsCop).toBe(t9Sum(t9CausesOf(rec, "settlement_cash_pending_stale").map((item) => item.amountCop)));
  expect(rec.missingPendingSettlementsCop).toBe(t9Sum(t9CausesOf(rec, "settlement_cash_pending_missing").map((item) => item.amountCop)));
}

async function t9Run(world: T9World, overrides: Partial<ReportInput> = {}) {
  const core = await loadCore();
  const math = await t9LoadMath();
  const data = t9Input(world, overrides);
  const report = core.buildCashOutstandingReport(data);
  expect(report.reconciliation, "admin + includeReconciliation + full debe traer reconciliation").not.toBeNull();
  const rec = report.reconciliation!;
  t9ExpectIdentity(math, data, report.rows, rec);
  return { core, math, data, report, rec, reconcile: t9Reconcile(core) };
}

// --- Escenarios: cada uno produce UNA causa (prefijo para poder juntarlos sin chocar ids) ---------

type T9Scenario = {
  cause: string;
  /** Importe con signo (aporte a deltaCop) cuando el plan lo fija sin ambiguedad; undefined = solo != 0. */
  amountCop?: number;
  settlementId?: (prefix: string) => string;
  orderId?: (prefix: string) => string;
  build: (math: T9Math, prefix: string) => T9World;
};

const T9_SCENARIOS: T9Scenario[] = [
  {
    cause: "outside_orders_outside_universe",
    amountCop: 27_000,
    orderId: (p) => `${p}ghost`,
    build: (_math, p) => ({
      orders: [order(`${p}o`)],
      entries: [...t9Entries(`${p}o`, 50_000, 5_000), ...t9Entries(`${p}ghost`, 30_000, 3_000)],
      settlements: [],
      unreadable: []
    })
  },
  {
    // Un ilegible tampoco esta en input.orders: gana la razon especifica.
    cause: "outside_unreadable_orders",
    amountCop: 27_000,
    orderId: (p) => `${p}bad`,
    build: (_math, p) => ({
      orders: [order(`${p}o`)],
      entries: [...t9Entries(`${p}o`, 50_000, 5_000), ...t9Entries(`${p}bad`, 30_000, 3_000)],
      settlements: [],
      unreadable: [`${p}bad`]
    })
  },
  {
    cause: "outside_order_total_without_cod",
    amountCop: -40_000,
    orderId: (p) => `${p}t`,
    build: (_math, p) => ({ orders: [order(`${p}t`, { totalCop: 40_000 })], entries: [], settlements: [], unreadable: [] })
  },
  {
    // Linea base: pedido de $1 con pago mayor (esperado 0 en la lista, -6.999 en la posicion).
    cause: "outside_negative_net",
    amountCop: -6_999,
    orderId: (p) => `${p}one`,
    build: (_math, p) => ({
      orders: [order(`${p}o`), order(`${p}one`)],
      entries: [...t9Entries(`${p}o`, 50_000, 5_000), ...t9Entries(`${p}one`, 1, 7_000)],
      settlements: [],
      unreadable: []
    })
  },
  {
    // Solo el de $1 fuera de corte: la posicion topa el agregado a 0.
    cause: "outside_aggregate_clamp",
    amountCop: 6_999,
    build: (_math, p) => ({ orders: [order(`${p}one`)], entries: t9Entries(`${p}one`, 1, 7_000), settlements: [], unreadable: [] })
  },
  {
    // Linea base: corte conciliado con pendiente guardado 0 y recalculado 129.900.
    cause: "settlement_cash_pending_stale",
    amountCop: -129_900,
    settlementId: (p) => `${p}s`,
    build: (math, p) => {
      const entries = [...t9Entries(`${p}a`, 50_000, 5_000), ...t9Entries(`${p}b`, 180_000, 5_100)];
      const stale = t9Settlement(math, `${p}s`, entries, {
        status: "reconciled",
        orderIds: [`${p}a`, `${p}b`],
        received: 90_000,
        pending: 0
      });
      // Lo que se guardo al conciliar: esperado 90.000 recibido entero, `b` sin cubrir.
      stale.cashExpectedCop = 90_000;
      stale.cashAllocations = [
        { orderId: `${p}a`, expectedCop: 45_000, receivedCop: 45_000, covered: true },
        { orderId: `${p}b`, expectedCop: 45_000, receivedCop: 45_000, covered: false }
      ];
      return { orders: [order(`${p}a`), order(`${p}b`)], entries, settlements: [stale], unreadable: [] };
    }
  },
  {
    cause: "settlement_cash_pending_missing",
    amountCop: -45_000,
    settlementId: (p) => `${p}s`,
    build: (math, p) => {
      const entries = t9Entries(`${p}o`, 50_000, 5_000);
      return {
        orders: [order(`${p}o`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}o`], received: 0, pending: "absent" })],
        unreadable: []
      };
    }
  },
  {
    // Pagado sin asignaciones: recibido por la regla de la tienda.
    cause: "settlement_orders_received",
    amountCop: 45_000,
    settlementId: (p) => `${p}s`,
    orderId: (p) => `${p}o`,
    build: (math, p) => {
      const entries = t9Entries(`${p}o`, 50_000, 5_000);
      return {
        orders: [order(`${p}o`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "paid", orderIds: [`${p}o`], received: "expected", allocations: false })],
        unreadable: []
      };
    }
  },
  {
    // El tipo medido (29 cortes): conciliado, recibido = esperado, pendiente 0, una asignacion sin cubrir.
    cause: "settlement_orders_covered_by_netting",
    amountCop: 45_000,
    settlementId: (p) => `${p}s`,
    orderId: (p) => `${p}n`,
    build: (math, p) => {
      const entries = [...t9Entries(`${p}x`, 50_000, 5_000), ...t9Entries(`${p}n`, 50_000, 5_000)];
      const netted = t9Settlement(math, `${p}s`, entries, { status: "reconciled", orderIds: [`${p}x`, `${p}n`], received: "expected" });
      netted.cashAllocations = [
        { orderId: `${p}x`, expectedCop: 45_000, receivedCop: 45_000, covered: true },
        { orderId: `${p}n`, expectedCop: 45_000, receivedCop: 0, covered: false }
      ];
      return { orders: [order(`${p}x`), order(`${p}n`)], entries, settlements: [netted], unreadable: [] };
    }
  },
  {
    cause: "settlement_orders_outside_universe",
    amountCop: 27_000,
    settlementId: (p) => `${p}s`,
    orderId: (p) => `${p}ghost`,
    build: (math, p) => {
      const entries = [...t9Entries(`${p}o`, 50_000, 5_000), ...t9Entries(`${p}ghost`, 30_000, 3_000)];
      return {
        orders: [order(`${p}o`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}o`, `${p}ghost`], received: 0 })],
        unreadable: []
      };
    }
  },
  {
    cause: "settlement_unreadable_orders",
    amountCop: 27_000,
    settlementId: (p) => `${p}s`,
    orderId: (p) => `${p}bad`,
    build: (math, p) => {
      const entries = [...t9Entries(`${p}o`, 50_000, 5_000), ...t9Entries(`${p}bad`, 30_000, 3_000)];
      return {
        orders: [order(`${p}o`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}o`, `${p}bad`], received: 0 })],
        unreadable: [`${p}bad`]
      };
    }
  },
  {
    // En un corte pagado con faltante (viejo) y en uno abierto (nuevo): la fila es del abierto.
    cause: "settlement_orders_attributed_elsewhere",
    amountCop: 45_000,
    settlementId: (p) => `${p}s-old`,
    orderId: (p) => `${p}o`,
    build: (math, p) => {
      const entries = t9Entries(`${p}o`, 50_000, 5_000);
      return {
        orders: [order(`${p}o`)],
        entries,
        settlements: [
          t9Settlement(math, `${p}s-old`, entries, { status: "paid", orderIds: [`${p}o`], received: 0, createdAt: "2026-09-20T10:00:00.000Z" }),
          t9Settlement(math, `${p}s-new`, entries, { status: "pending", orderIds: [`${p}o`], received: 0, createdAt: "2026-09-30T10:00:00.000Z" })
        ],
        unreadable: []
      };
    }
  },
  {
    cause: "settlement_order_total_without_cod",
    amountCop: -40_000,
    settlementId: (p) => `${p}s`,
    orderId: (p) => `${p}t`,
    build: (math, p) => ({
      orders: [order(`${p}t`, { totalCop: 40_000 })],
      entries: [],
      settlements: [t9Settlement(math, `${p}s`, [], { status: "pending", orderIds: [`${p}t`], received: 0 })],
      unreadable: []
    })
  },
  {
    cause: "settlement_negative_net",
    amountCop: -6_999,
    settlementId: (p) => `${p}s`,
    build: (math, p) => {
      const entries = [...t9Entries(`${p}o`, 50_000, 5_000), ...t9Entries(`${p}one`, 1, 7_000)];
      return {
        orders: [order(`${p}o`), order(`${p}one`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}o`, `${p}one`], received: 0 })],
        unreadable: []
      };
    }
  },
  {
    cause: "settlement_expected_clamp",
    amountCop: 6_999,
    settlementId: (p) => `${p}s`,
    build: (math, p) => {
      const entries = t9Entries(`${p}one`, 1, 7_000);
      return {
        orders: [order(`${p}one`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}one`], received: 0 })],
        unreadable: []
      };
    }
  },
  {
    cause: "settlement_excess_received",
    amountCop: 5_000,
    settlementId: (p) => `${p}s`,
    build: (math, p) => {
      const entries = t9Entries(`${p}o`, 50_000, 5_000);
      return {
        orders: [order(`${p}o`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "reconciled", orderIds: [`${p}o`], received: 50_000 })],
        unreadable: []
      };
    }
  },
  {
    // Corte abierto: `a-rec` cubierto con lo recibido, `b-open` en la lista entero.
    cause: "settlement_cash_received",
    amountCop: -45_000,
    settlementId: (p) => `${p}s`,
    build: (math, p) => {
      const entries = [...t9Entries(`${p}a-rec`, 50_000, 5_000), ...t9Entries(`${p}b-open`, 50_000, 5_000)];
      return {
        orders: [order(`${p}a-rec`), order(`${p}b-open`)],
        entries,
        settlements: [t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}a-rec`, `${p}b-open`], received: 45_000 })],
        unreadable: []
      };
    }
  }
];

/** Asignacion guardada por encima del esperado actual (los asientos cambiaron tras el abono). */
function t9AllocationOverExpected(math: T9Math, p: string): T9World {
  const entries = t9Entries(`${p}o`, 50_000, 25_000);
  const stored = t9Settlement(math, `${p}s`, entries, { status: "pending", orderIds: [`${p}o`], received: 30_000 });
  stored.cashExpectedCop = 45_000;
  stored.cashAllocations = [{ orderId: `${p}o`, expectedCop: 45_000, receivedCop: 30_000, covered: false }];
  return { orders: [order(`${p}o`)], entries, settlements: [stored], unreadable: [] };
}

// --- Generador con semilla fija para la propiedad ------------------------------------------------

function t9Mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type T9PendingMode = "coherent" | "stale" | "absent";

function t9RandomWorld(math: T9Math, rand: () => number, caseIndex: number, pendingModes: T9PendingMode[]): T9World {
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const p = `c${caseIndex}-`;
  const orders: OrderFixture[] = [];
  const entries: T9Entry[] = [];
  const unreadable: string[] = [];
  const ids: string[] = [];
  const orderCount = 3 + Math.floor(rand() * 8);
  for (let index = 0; index < orderCount; index += 1) {
    const id = `${p}o${String(index).padStart(2, "0")}`;
    ids.push(id);
    const kind = rand();
    if (kind < 0.1) {
      // fuera del universo: asientos sin pedido en input.orders
    } else if (kind < 0.18) {
      unreadable.push(id);
    } else {
      orders.push(
        order(id, {
          status: pick(["delivered", "liquidated"]),
          totalCop: pick([40_000, 80_000]),
          driverId: pick(["leader-1", "leader-2", null])
        })
      );
    }
    if (rand() >= 0.1) {
      const codCop = pick([1, 20_000, 50_000, 120_000]);
      entries.push(codEntry(id, codCop));
      if (rand() < 0.08) entries.push(codEntry(id, -codCop, "cod_remittance"));
    }
    const payCop = pick([0, 0, 3_000, 7_000, 25_000]);
    if (payCop > 0) entries.push(payEntry(id, payCop));
  }

  const settlements: SettlementFixture[] = [];
  const settlementCount = Math.floor(rand() * 4);
  for (let index = 0; index < settlementCount; index += 1) {
    const orderIds = ids.filter(() => rand() < 0.4);
    if (orderIds.length === 0) continue;
    const status = pick(["pending", "paid", "reconciled"] as const);
    const coherent = t9Settlement(math, "probe", entries, { status, orderIds, received: 0 });
    const expectedCop = coherent.cashExpectedCop ?? 0;
    const received = pick([0, Math.floor(expectedCop * rand()), expectedCop, expectedCop + 5_000]);
    const mode = pick(pendingModes);
    const recalculated = Math.max(0, expectedCop - received);
    const pending = mode === "coherent" ? "coherent" : mode === "absent" ? "absent" : recalculated + pick([-20_000, 5_000, 129_900]);
    settlements.push(
      t9Settlement(math, `${p}s${index}`, entries, {
        status,
        orderIds,
        received,
        pending: typeof pending === "number" ? (pending < 0 || pending === recalculated ? recalculated + 1_000 : pending) : pending,
        allocations: rand() < 0.85,
        createdAt: `2026-09-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`
      })
    );
  }
  return { orders, entries, settlements, unreadable };
}

const T9_SEED = 26_009;
const T9_CASES = 250;

describe("T9 · conciliacion por causas sin residuo (RNF_02, RF_09)", () => {
  describe("contrato y alcance: solo admin + includeReconciliation + coverage full", () => {
    function smallWorld(): T9World {
      return { orders: [order("g-o")], entries: t9Entries("g-o", 50_000, 5_000), settlements: [], unreadable: [] };
    }

    it("exporta reconcileWithPlatformPosition(input, { rows, nettedRows }) y el informe la usa tal cual", async () => {
      const { report, rec, data, reconcile } = await t9Run(smallWorld());
      expect(rec).toEqual(reconcile(data, { rows: report.rows, nettedRows: report.nettedRows }));
    });

    it("sin includeReconciliation → reconciliation null", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(t9Input(smallWorld(), { scope: { kind: "admin", includeReconciliation: false } }));
      expect(report.reconciliation).toBeNull();
    });

    it("coverage targeted → reconciliation null (no hay asientos completos)", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(t9Input(smallWorld(), { coverage: "targeted" }));
      expect(report.reconciliation).toBeNull();
    });

    it("alcance de lider → reconciliation null", async () => {
      const { buildCashOutstandingReport } = await loadCore();
      const report = buildCashOutstandingReport(t9Input(smallWorld(), { scope: { kind: "leader", driverId: "leader-1" } }));
      expect(report.reconciliation).toBeNull();
    });
  });

  describe("sin causas", () => {
    it("filas fuera de corte y en un corte abierto sin recibido: deltaCop 0, ninguna causa con importe, unexplained 0", async () => {
      const math = await t9LoadMath();
      const openEntries = [...t9Entries("n-s1", 50_000, 5_000), ...t9Entries("n-s2", 30_000, 3_000)];
      const world: T9World = {
        orders: [order("n-out1"), order("n-out2"), order("n-s1"), order("n-s2")],
        entries: [...t9Entries("n-out1", 50_000, 5_000), ...t9Entries("n-out2", 120_000, 0), ...openEntries],
        settlements: [t9Settlement(math, "n-s", openEntries, { status: "pending", orderIds: ["n-s1", "n-s2"], received: 0 })],
        unreadable: []
      };
      const { rec } = await t9Run(world);
      expect(rec.deltaCop).toBe(0);
      expect(rec.causes.filter((item) => item.amountCop !== 0)).toEqual([]);
      expect(rec.unexplainedCop).toBe(0);
      expect(rec.unexplainedOrderIds).toEqual([]);
      expect(rec.staleSettlementsCop).toBe(0);
      expect(rec.missingPendingSettlementsCop).toBe(0);
    });
  });

  describe("cada causa sola explica su diferencia (unexplainedCop === 0)", () => {
    it.each(T9_SCENARIOS.map((scenario) => [scenario.cause, scenario] as const))("%s", async (_name, scenario) => {
      const math = await t9LoadMath();
      const prefix = "one-";
      const { rec } = await t9Run(scenario.build(math, prefix));
      expect(rec.unexplainedCop).toBe(0);
      expect(rec.unexplainedOrderIds).toEqual([]);
      const matching = t9CausesOf(rec, scenario.cause).filter(
        (item) => scenario.settlementId === undefined || item.settlementId === scenario.settlementId(prefix)
      );
      expect(matching.length, `falta la causa ${scenario.cause}`).toBeGreaterThan(0);
      const amount = t9Sum(matching.map((item) => item.amountCop));
      if (scenario.amountCop !== undefined) expect(amount).toBe(scenario.amountCop);
      else expect(amount).not.toBe(0);
      if (scenario.orderId) expect(matching.flatMap((item) => item.orderIds)).toContain(scenario.orderId(prefix));
    });

    it("asignacion guardada por encima del esperado actual: identidad exacta y unexplained 0", async () => {
      const math = await t9LoadMath();
      const { rec } = await t9Run(t9AllocationOverExpected(math, "q-"));
      expect(rec.unexplainedCop).toBe(0);
      expect(rec.unexplainedOrderIds).toEqual([]);
    });

    it("todas las causas juntas: unexplainedCop === 0 y la identidad se mantiene", async () => {
      const math = await t9LoadMath();
      const world = t9Merge(
        ...T9_SCENARIOS.map((scenario, index) => scenario.build(math, `all${index}-`)),
        t9AllocationOverExpected(math, "all-q-")
      );
      const { rec } = await t9Run(world);
      expect(rec.unexplainedCop).toBe(0);
      expect(rec.unexplainedOrderIds).toEqual([]);
      // stale y missing se reportan por corte; distintos de 0 NO son residuo.
      expect(rec.staleSettlementsCop).toBe(-129_900);
      expect(rec.missingPendingSettlementsCop).toBe(-45_000);
    });
  });

  describe("una fila perdida no la absorbe ninguna causa", () => {
    it("fila con importe quitada de rows, FUERA de corte → unexplainedCop = su recaudo neto, con su id", async () => {
      const world: T9World = {
        orders: [order("r-a"), order("r-b")],
        entries: [...t9Entries("r-a", 50_000, 5_000), ...t9Entries("r-b", 30_000, 3_000)],
        settlements: [],
        unreadable: []
      };
      const { report, data, reconcile, rec: full } = await t9Run(world);
      expect(full.unexplainedCop).toBe(0);
      const rows = report.rows.filter((row) => row.orderId !== "r-b");
      const rec = reconcile(data, { rows, nettedRows: report.nettedRows });
      expect(rec.unexplainedCop).not.toBe(0);
      expect(rec.unexplainedCop).toBe(27_000);
      expect(rec.unexplainedOrderIds).toEqual(["r-b"]);
      t9ExpectIdentity(await t9LoadMath(), data, rows, rec);
    });

    it("fila con importe quitada de rows, EN un corte abierto → unexplainedCop = su esperado, con su id", async () => {
      const math = await t9LoadMath();
      const entries = [...t9Entries("r-c", 50_000, 5_000), ...t9Entries("r-d", 30_000, 3_000)];
      const world: T9World = {
        orders: [order("r-c"), order("r-d")],
        entries,
        settlements: [t9Settlement(math, "r-s", entries, { status: "pending", orderIds: ["r-c", "r-d"], received: 0 })],
        unreadable: []
      };
      const { report, data, reconcile, rec: full } = await t9Run(world);
      expect(full.unexplainedCop).toBe(0);
      expect(report.rows.find((row) => row.orderId === "r-d")?.location).toBe("in_settlement_open");
      const rows = report.rows.filter((row) => row.orderId !== "r-d");
      const rec = reconcile(data, { rows, nettedRows: report.nettedRows });
      expect(rec.unexplainedCop).not.toBe(0);
      expect(rec.unexplainedCop).toBe(27_000);
      expect(rec.unexplainedOrderIds).toEqual(["r-d"]);
      t9ExpectIdentity(math, data, rows, rec);
    });

    it("fila quitada de nettedRows → la conciliacion no cambia (la compensacion sale de los cortes)", async () => {
      const math = await t9LoadMath();
      const scenario = T9_SCENARIOS.find((item) => item.cause === "settlement_orders_covered_by_netting")!;
      const { report, data, reconcile, rec: full } = await t9Run(scenario.build(math, "rn-"));
      expect(rowIds(report.nettedRows)).toEqual(["rn-n"]);
      const rec = reconcile(data, { rows: report.rows, nettedRows: [] });
      expect(rec).toEqual(full);
    });
  });

  describe("cortes guardados: stale (campo presente y distinto) y missing (campo ausente)", () => {
    it("corte con pendiente guardado distinto del recalculado → settlement_cash_pending_stale por corte (G - R)", async () => {
      const math = await t9LoadMath();
      const entries = t9Entries("st-o", 50_000, 5_000);
      const world: T9World = {
        orders: [order("st-o")],
        entries,
        settlements: [t9Settlement(math, "st-s", entries, { status: "pending", orderIds: ["st-o"], received: 0, pending: 50_000 })],
        unreadable: []
      };
      const { rec } = await t9Run(world);
      const stale = t9CausesOf(rec, "settlement_cash_pending_stale");
      expect(stale.map((item) => [item.settlementId, item.amountCop])).toEqual([["st-s", 5_000]]);
      expect(rec.staleSettlementsCop).toBe(5_000);
      expect(t9CausesOf(rec, "settlement_cash_pending_missing")).toEqual([]);
      expect(rec.unexplainedCop).toBe(0);
    });

    it("corte sin cashPendingCop → settlement_cash_pending_missing (y NO stale), unexplained 0", async () => {
      const math = await t9LoadMath();
      const scenario = T9_SCENARIOS.find((item) => item.cause === "settlement_cash_pending_missing")!;
      const { rec } = await t9Run(scenario.build(math, "mi-"));
      expect(t9CausesOf(rec, "settlement_cash_pending_missing").map((item) => [item.settlementId, item.amountCop])).toEqual([
        ["mi-s", -45_000]
      ]);
      expect(rec.missingPendingSettlementsCop).toBe(-45_000);
      expect(t9CausesOf(rec, "settlement_cash_pending_stale")).toEqual([]);
      expect(rec.staleSettlementsCop).toBe(0);
      expect(rec.unexplainedCop).toBe(0);
    });

    it("corte coherente (guardado = recalculado) no se reporta ni stale ni missing", async () => {
      const math = await t9LoadMath();
      const entries = t9Entries("co-o", 50_000, 5_000);
      const world: T9World = {
        orders: [order("co-o")],
        entries,
        settlements: [t9Settlement(math, "co-s", entries, { status: "pending", orderIds: ["co-o"], received: 10_000 })],
        unreadable: []
      };
      const { rec } = await t9Run(world);
      expect(t9CausesOf(rec, "settlement_cash_pending_stale")).toEqual([]);
      expect(t9CausesOf(rec, "settlement_cash_pending_missing")).toEqual([]);
      expect(rec.unexplainedCop).toBe(0);
    });
  });

  describe("linea base 2026-10-02 (t1-linea-base.txt): cortes del tipo medido", () => {
    /**
     * Dos cortes conciliados con pendiente guardado $0 y recalculado $129.900 y $81.900 (seccion 6),
     * cada uno con pedidos sin cubrir (compensacion, seccion 5) y uno de ellos con el pedido de $1 cuyo
     * esperado es 0 (ord-knt-005242: sin asignacion, nunca `covered`). Mas filas fuera de corte.
     */
    function baselineWorld(math: T9Math): T9World {
      const firstEntries = [...t9Entries("lb-a", 50_000, 5_000), ...t9Entries("lb-b", 180_000, 5_100)];
      const first = t9Settlement(math, "stl-1786630129293-driver", firstEntries, {
        status: "reconciled",
        orderIds: ["lb-a", "lb-b"],
        received: 90_000,
        pending: 0
      });
      first.cashExpectedCop = 90_000;
      first.cashAllocations = [
        { orderId: "lb-a", expectedCop: 45_000, receivedCop: 45_000, covered: true },
        { orderId: "lb-b", expectedCop: 45_000, receivedCop: 45_000, covered: false }
      ];
      const secondEntries = [...t9Entries("lb-c", 50_000, 5_000), ...t9Entries("lb-d", 133_899, 0), ...t9Entries("lb-one", 1, 7_000)];
      const second = t9Settlement(math, "stl-1787066544779-driver", secondEntries, {
        status: "reconciled",
        orderIds: ["lb-c", "lb-d", "lb-one"],
        received: 90_000,
        pending: 0
      });
      second.cashExpectedCop = 90_000;
      second.cashAllocations = [
        { orderId: "lb-c", expectedCop: 45_000, receivedCop: 45_000, covered: true },
        { orderId: "lb-d", expectedCop: 45_000, receivedCop: 45_000, covered: false }
      ];
      const outsideEntries = [...t9Entries("lb-out1", 120_000, 7_000), ...t9Entries("lb-out2", 50_000, 5_000)];
      return {
        orders: ["lb-a", "lb-b", "lb-c", "lb-d", "lb-one", "lb-out1", "lb-out2"].map((id) => order(id)),
        entries: [...firstEntries, ...secondEntries, ...outsideEntries],
        settlements: [first, second],
        unreadable: []
      };
    }

    it("los cortes viejos se reportan como stale ($-211.800 por corte) y la compensacion los explica: unexplained 0", async () => {
      const math = await t9LoadMath();
      const world = baselineWorld(math);
      // Precondicion del fixture: el recalculado es el de la linea base.
      expect(world.settlements.map((item) => t9RecalculatedPending(math, world.entries, item))).toEqual([129_900, 81_900]);
      const { rec, report } = await t9Run(world);
      expect(rowIds(report.nettedRows)).toEqual(["lb-b", "lb-d", "lb-one"]);
      expect(rec.unexplainedCop).toBe(0);
      expect(rec.unexplainedOrderIds).toEqual([]);
      expect(
        t9CausesOf(rec, "settlement_cash_pending_stale")
          .map((item) => [item.settlementId, item.amountCop])
          .sort()
      ).toEqual([
        ["stl-1786630129293-driver", -129_900],
        ["stl-1787066544779-driver", -81_900]
      ]);
      expect(rec.staleSettlementsCop).toBe(-211_800);
      expect(rec.missingPendingSettlementsCop).toBe(0);
      const netting = t9CausesOf(rec, "settlement_orders_covered_by_netting");
      expect(netting.map((item) => item.settlementId).sort()).toEqual(["stl-1786630129293-driver", "stl-1787066544779-driver"]);
      expect(netting.flatMap((item) => item.orderIds).sort()).toEqual(["lb-b", "lb-d", "lb-one"]);
    });

    it("quitar de rows una fila fuera de corte en la linea base deja unexplainedCop != 0 con su id", async () => {
      const math = await t9LoadMath();
      const { report, data, reconcile } = await t9Run(baselineWorld(math));
      const rows = report.rows.filter((row) => row.orderId !== "lb-out1");
      const rec = reconcile(data, { rows, nettedRows: report.nettedRows });
      expect(rec.unexplainedCop).toBe(113_000);
      expect(rec.unexplainedOrderIds).toEqual(["lb-out1"]);
    });
  });

  describe(`propiedad (semilla ${T9_SEED}, ${T9_CASES} casos)`, () => {
    it("datos coherentes: deltaCop = Σ causas + unexplained y unexplainedCop === 0, sin stale ni missing", async () => {
      const core = await loadCore();
      const math = await t9LoadMath();
      const rand = t9Mulberry32(T9_SEED);
      for (let caseIndex = 0; caseIndex < T9_CASES; caseIndex += 1) {
        const data = t9Input(t9RandomWorld(math, rand, caseIndex, ["coherent"]));
        const report = core.buildCashOutstandingReport(data);
        const rec = report.reconciliation;
        expect(rec, `caso ${caseIndex}`).not.toBeNull();
        t9ExpectIdentity(math, data, report.rows, rec!);
        expect({ caseIndex, unexplainedCop: rec!.unexplainedCop, ids: rec!.unexplainedOrderIds }).toEqual({
          caseIndex,
          unexplainedCop: 0,
          ids: []
        });
        expect(rec!.staleSettlementsCop).toBe(0);
        expect(rec!.missingPendingSettlementsCop).toBe(0);
      }
    });

    it("con cortes viejos o sin campo: unexplained sigue en 0 y stale/missing = Σ (guardado - recalculado) por su tipo", async () => {
      const core = await loadCore();
      const math = await t9LoadMath();
      const rand = t9Mulberry32(T9_SEED + 1);
      let staleSeen = 0;
      let missingSeen = 0;
      for (let caseIndex = 0; caseIndex < T9_CASES; caseIndex += 1) {
        const world = t9RandomWorld(math, rand, caseIndex, ["coherent", "coherent", "stale", "absent"]);
        const data = t9Input(world);
        const report = core.buildCashOutstandingReport(data);
        expect(report.reconciliation, `caso ${caseIndex}`).not.toBeNull();
        const rec = report.reconciliation!;
        t9ExpectIdentity(math, data, report.rows, rec);
        let expectedStale = 0;
        let expectedMissing = 0;
        for (const item of world.settlements) {
          const recalculated = t9RecalculatedPending(math, world.entries, item);
          if (item.cashPendingCop === undefined) {
            expectedMissing += 0 - recalculated;
            missingSeen += 1;
          } else if (item.cashPendingCop !== recalculated) {
            expectedStale += item.cashPendingCop - recalculated;
            staleSeen += 1;
          }
        }
        expect({ caseIndex, unexplainedCop: rec.unexplainedCop }).toEqual({ caseIndex, unexplainedCop: 0 });
        expect({ caseIndex, stale: rec.staleSettlementsCop, missing: rec.missingPendingSettlementsCop }).toEqual({
          caseIndex,
          stale: expectedStale,
          missing: expectedMissing
        });
      }
      expect(staleSeen).toBeGreaterThan(20);
      expect(missingSeen).toBeGreaterThan(20);
    });

    it("quitar de rows cualquier fila con importe → unexplainedCop != 0 y su id en unexplainedOrderIds", async () => {
      const core = await loadCore();
      const math = await t9LoadMath();
      const reconcile = t9Reconcile(core);
      const rand = t9Mulberry32(T9_SEED + 2);
      let removals = 0;
      for (let caseIndex = 0; caseIndex < T9_CASES; caseIndex += 1) {
        const data = t9Input(t9RandomWorld(math, rand, caseIndex, ["coherent"]));
        const report = core.buildCashOutstandingReport(data);
        const candidates = report.rows.filter((row) => row.collectedSource === "wallet" && row.collectedCop - row.driverPayCop > 0);
        if (candidates.length === 0) continue;
        const removed = candidates[Math.floor(rand() * candidates.length)];
        const rows = report.rows.filter((row) => row.orderId !== removed.orderId);
        const rec = reconcile(data, { rows, nettedRows: report.nettedRows });
        removals += 1;
        expect({ caseIndex, removed: removed.orderId, lost: rec.unexplainedCop !== 0 }).toEqual({
          caseIndex,
          removed: removed.orderId,
          lost: true
        });
        expect(rec.unexplainedOrderIds).toContain(removed.orderId);
        t9ExpectIdentity(math, data, rows, rec);
      }
      expect(removals).toBeGreaterThanOrEqual(100);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// T19
// ---------------------------------------------------------------------------------------------------

describe("T19 · vencido bruto por grupo y en totales (R1-RF_03-1, spec 9 P1)", () => {
  type GroupT19 = { leaderId: string | null; overdueCop: number; overdueCollectedCop?: number };
  type TotalsT19 = { overdueCop: number; overdueCollectedCop?: number };

  /** Vencido de leader-1 con recaudo `collected` y pago al domiciliario `pay`. */
  function agedWithPay(id: string, days: number, collected: number, pay: number, overrides: Partial<OrderFixture> = {}) {
    const at = daysAgo(days);
    return {
      order: order(id, { closedAt: at, updatedAt: at, ...overrides }),
      entries: [codEntry(id, collected), payEntry(id, pay)]
    };
  }

  /**
   * leader-1: un vencido de $100.000 con pago $7.000 (neto $93.000), un vencido pagado con faltante
   * (recaudo $50.000, pago $5.000, recibido $10.000 → neto $35.000), uno sin vencer y uno compensado.
   */
  function scenario() {
    const withPay = agedWithPay("t19-pay", 10, 100_000, 7_000);
    const short = aged("t19-short", 20);
    const fresh = aged("t19-fresh", 2);
    const netted = aged("t19-net", 60);
    return {
      orders: [withPay, short, fresh, netted].map((item) => item.order),
      receivableEntries: [withPay, short, fresh, netted].flatMap((item) => item.entries),
      settlements: [paidShort("s19-short", "t19-short"), settledNetting("s19-net", "t19-net")]
    };
  }

  it("precondicion del escenario: netos de las vencidas $93.000 y $35.000", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const report = buildCashOutstandingReport(input(scenario()));
    const overdue = Object.fromEntries(report.rows.filter((row) => row.isOverdue).map((row) => [row.orderId, [row.collectedCop, row.outstandingCop]]));
    expect(overdue).toEqual({ "t19-pay": [100_000, 93_000], "t19-short": [50_000, 35_000] });
  });

  it("cada grupo de byLeader trae overdueCollectedCop = Σ collectedCop de sus vencidas", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const report = buildCashOutstandingReport(input(scenario()));
    const [group] = report.byLeader as GroupT19[];
    expect(group.overdueCollectedCop).toBe(150_000);
  });

  it("el grupo conserva overdueCop neto = Σ outstandingCop de sus vencidas", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const report = buildCashOutstandingReport(input(scenario()));
    const [group] = report.byLeader as GroupT19[];
    expect(group.overdueCop).toBe(128_000);
  });

  it("totals trae overdueCollectedCop = Σ collectedCop de las vencidas de rows (sin compensados)", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const report = buildCashOutstandingReport(input(scenario()));
    expect((report.totals as TotalsT19).overdueCollectedCop).toBe(150_000);
  });

  it("totals conserva overdueCop neto", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const report = buildCashOutstandingReport(input(scenario()));
    expect(report.totals.overdueCop).toBe(128_000);
  });

  it("varios lideres: Σ overdueCollectedCop de los grupos = totals.overdueCollectedCop", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const base = scenario();
    const other = agedWithPay("t19-b", 15, 80_000, 0, { driverId: "leader-2" });
    const orphan = aged("t19-orphan", 12, { driverId: null, messengerId: null });
    const report = buildCashOutstandingReport(
      input({
        ...base,
        orders: [...base.orders, other.order, orphan.order],
        receivableEntries: [...base.receivableEntries, ...other.entries, ...orphan.entries]
      })
    );
    const byLeader = Object.fromEntries((report.byLeader as GroupT19[]).map((group) => [String(group.leaderId), group.overdueCollectedCop]));
    expect(byLeader).toEqual({ "leader-1": 150_000, "leader-2": 80_000, null: 50_000 });
    expect((report.totals as TotalsT19).overdueCollectedCop).toBe(280_000);
  });

  it("un grupo sin vencidos trae overdueCollectedCop 0", async () => {
    const { buildCashOutstandingReport } = await loadCore();
    const fresh = aged("t19-only-fresh", 2);
    const report = buildCashOutstandingReport(input({ orders: [fresh.order], receivableEntries: fresh.entries }));
    expect((report.byLeader as GroupT19[])[0].overdueCollectedCop).toBe(0);
  });
});
