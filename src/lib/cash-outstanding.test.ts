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
