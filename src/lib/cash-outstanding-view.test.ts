/**
 * Spec 026 · T14 — modelo de vista de "Efectivo sin llegar" (`src/lib/cash-outstanding-view.ts`).
 *
 * Puro: recibe el informe que devuelve `getCashOutstanding` y decide lo que se pinta (rotulos, grupos,
 * plegado, paginas, cuadre, tarjeta de Operacion, cifras incompletas, linea de proveedor). Ninguna prueba
 * llama al servidor ni a Firestore.
 *
 * Contrato (plan 4.1 "Rotulos"; README decisiones 2-12):
 *
 *   cashLocationLabel(row, role: "admin" | "leader"): string
 *   buildCashOutstandingView(report, { viewport: "mobile" | "desktop", role, leaderFilter?: string | null })
 *     -> { card, summary, groups, netted, reconciliation, incomplete }
 *   supplierPendingLine(report, supplierId) -> { amountCop, text } | null
 *   NO_LEADER_FILTER  (valor de `leaderFilter` que elige el grupo "Sin lider")
 *
 * Fechas de los rotulos: "<dia> <mes de 3 letras sin punto>" en hora de Bogota ("30 sep").
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle
 * con su propio mensaje.
 */
import { describe, expect, it } from "vitest";
import type {
  CashOutstandingGroup,
  CashOutstandingReport,
  CashOutstandingRow,
  CashRowSettlement,
  PositionReconciliation,
} from "../../functions/src/cash-outstanding";

type ViewModule = typeof import("./cash-outstanding-view");
const loadView = (): Promise<ViewModule> => import("./cash-outstanding-view");

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

const NOW = "2026-10-02T15:00:00.000Z";

function makeRow(over: Partial<CashOutstandingRow> & { orderId: string }): CashOutstandingRow {
  return {
    trackingCode: `KNT-${over.orderId}`,
    sellerId: "seller-1",
    sellerName: "DANDA",
    leaderId: "A",
    leaderName: "Ana",
    messengerId: "m-1",
    messengerName: "Kevin Rios",
    deliveredAt: "2026-09-20T15:00:00.000Z",
    deliveredAtSource: "closedAt",
    ageDays: 12,
    isOverdue: true,
    collectedCop: 10_000,
    collectedSource: "wallet",
    driverPayCop: 0,
    expectedCashCop: 10_000,
    receivedCop: 0,
    outstandingCop: 10_000,
    location: "outside_settlement",
    settlements: [],
    attributedSettlementId: null,
    supplierWithheld: [],
    ...over,
  };
}

/** Grupos por lider como los arma el servidor: `overdueCop` desc (empate `outstandingCop` desc, id). */
function groupsOf(rows: CashOutstandingRow[]): CashOutstandingGroup[] {
  const map = new Map<string, CashOutstandingGroup>();
  for (const row of rows) {
    const key = row.leaderId ?? "";
    const group = map.get(key) ?? {
      leaderId: row.leaderId,
      leaderName: row.leaderName,
      orderCount: 0,
      collectedCop: 0,
      outstandingCop: 0,
      overdueCount: 0,
      overdueCop: 0,
      oldestDeliveredAt: row.deliveredAt,
    };
    group.orderCount += 1;
    group.collectedCop += row.collectedCop;
    group.outstandingCop += row.outstandingCop;
    if (row.isOverdue) {
      group.overdueCount += 1;
      group.overdueCop += row.collectedCop;
    }
    if (row.deliveredAt < group.oldestDeliveredAt) group.oldestDeliveredAt = row.deliveredAt;
    map.set(key, group);
  }
  return [...map.values()].sort(
    (a, b) => b.overdueCop - a.overdueCop || b.outstandingCop - a.outstandingCop || String(a.leaderId).localeCompare(String(b.leaderId)),
  );
}

function makeReport(over: Partial<CashOutstandingReport> & { rows: CashOutstandingRow[] }): CashOutstandingReport {
  const rows = [...over.rows].sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt));
  const nettedRows = over.nettedRows ?? [];
  const sum = (list: CashOutstandingRow[], pick: (row: CashOutstandingRow) => number) => list.reduce((total, row) => total + pick(row), 0);
  return {
    generatedAt: NOW,
    mode: "summary",
    settings: { overdueDays: 7, notifyMinCop: 20_000 },
    settingsInvalid: false,
    channelConfigured: true,
    nettedRows,
    byLeader: groupsOf(rows),
    bySupplier: [],
    totals: {
      orderCount: rows.length,
      collectedCop: sum(rows, (row) => row.collectedCop),
      outstandingCop: sum(rows, (row) => row.outstandingCop),
      outsideSettlementCop: sum(rows.filter((row) => row.location === "outside_settlement"), (row) => row.collectedCop),
      inOpenSettlementCop: sum(rows.filter((row) => row.location === "in_settlement_open"), (row) => row.collectedCop),
      paidShortCop: sum(rows.filter((row) => row.location === "settlement_paid_short"), (row) => row.collectedCop),
      overdueCount: rows.filter((row) => row.isOverdue).length,
      overdueCop: sum(rows.filter((row) => row.isOverdue), (row) => row.collectedCop),
      nettedCount: nettedRows.length,
      nettedCollectedCop: sum(nettedRows, (row) => row.collectedCop),
      nettedSettlementCount: new Set(nettedRows.map((row) => row.attributedSettlementId)).size,
    },
    reconciliation: null,
    isIncomplete: false,
    unreadableOrderIds: [],
    unreadableSettlementIds: [],
    unreadableEntryIds: [],
    ...over,
    rows,
  };
}

const settlement = (id: string, status: CashRowSettlement["status"], createdAt: string, cashSettled = false): CashRowSettlement => ({
  id,
  status,
  createdAt,
  cashSettled,
});

const RECONCILIATION: PositionReconciliation = {
  driverReceivableCop: 500_000,
  listOutstandingCop: 450_000,
  deltaCop: 50_000,
  causes: [{ cause: "outside_negative_net", amountCop: 50_000, orderIds: ["x"] }],
  staleSettlementsCop: 0,
  missingPendingSettlementsCop: 0,
  unexplainedCop: 0,
  unexplainedOrderIds: [],
};

/** Ana: 5 pedidos vencidos de $10.000 ($50.000). Beto: 2 pedidos vencidos de $200.000 ($400.000). */
function twoLeadersReport(over: Partial<CashOutstandingReport> = {}): CashOutstandingReport {
  const ana = Array.from({ length: 5 }, (_, i) =>
    makeRow({ orderId: `a${i}`, leaderId: "A", leaderName: "Ana", collectedCop: 10_000, outstandingCop: 10_000, ageDays: 10 + i, deliveredAt: `2026-09-${String(10 + i).padStart(2, "0")}T15:00:00.000Z` }),
  );
  const beto = [0, 1].map((i) =>
    makeRow({ orderId: `b${i}`, leaderId: "B", leaderName: "Beto", collectedCop: 200_000, outstandingCop: 200_000, ageDays: 20 + i, deliveredAt: `2026-09-0${1 + i}T15:00:00.000Z` }),
  );
  return makeReport({ rows: [...ana, ...beto], ...over });
}

// ---------------------------------------------------------------------------------------------------

describe("T14 · rotulos de ubicacion (plan 4.1, README decision 5)", () => {
  const outside = makeRow({ orderId: "o1", location: "outside_settlement" });
  const open = makeRow({
    orderId: "o2",
    location: "in_settlement_open",
    settlements: [
      settlement("s-paid", "paid", "2026-09-28T15:00:00.000Z"),
      settlement("s-open-new", "pending", "2026-09-25T15:00:00.000Z"),
      settlement("s-open-old", "pending", "2026-09-20T15:00:00.000Z"),
    ],
  });
  const paidShort = makeRow({
    orderId: "o3",
    location: "settlement_paid_short",
    settlements: [settlement("s-new", "paid", "2026-09-30T15:00:00.000Z"), settlement("s-old", "reconciled", "2026-09-10T15:00:00.000Z")],
  });
  const covered = makeRow({
    orderId: "o4",
    location: "covered_by_netting",
    isOverdue: false,
    settlements: [
      settlement("s-unsettled", "paid", "2026-09-29T15:00:00.000Z", false),
      settlement("s-settled-new", "reconciled", "2026-09-15T15:00:00.000Z", true),
      settlement("s-settled-old", "paid", "2026-09-01T15:00:00.000Z", true),
    ],
  });

  it.each([
    ["outside_settlement admin", outside, "admin", "Fuera de todo corte"],
    ["in_settlement_open admin", open, "admin", "En corte abierto"],
    ["settlement_paid_short admin", paidShort, "admin", "Pagado con faltante"],
    ["covered_by_netting admin", covered, "admin", "Cubierto por compensacion"],
    ["outside_settlement lider", outside, "leader", "No esta en ningun corte"],
    ["in_settlement_open lider: el pendiente mas reciente, no el pagado", open, "leader", "En el corte del 25 sep, abierto"],
    ["settlement_paid_short lider: el corte mas reciente", paidShort, "leader", "Corte del 30 sep pagado con faltante"],
    ["covered_by_netting lider: el saldado mas reciente, no el pagado sin saldar", covered, "leader", "Cubierto en el corte del 15 sep"],
  ] as const)("%s", async (_name, row, role, expected) => {
    const { cashLocationLabel } = await loadView();
    expect(cashLocationLabel(row, role)).toBe(expected);
  });

  it("la fecha del corte es la de Bogota (02:00 UTC del 1 oct = 30 sep)", async () => {
    const { cashLocationLabel } = await loadView();
    const row = makeRow({ orderId: "o5", location: "in_settlement_open", settlements: [settlement("s", "pending", "2026-10-01T02:00:00.000Z")] });
    expect(cashLocationLabel(row, "leader")).toBe("En el corte del 30 sep, abierto");
  });

  it("cada fila de la vista lleva su rotulo segun el rol", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({ rows: [paidShort] });
    const admin = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    const leader = buildCashOutstandingView(report, { viewport: "mobile", role: "leader" });
    expect(admin.groups[0].visibleRows[0].locationLabel).toBe("Pagado con faltante");
    expect(leader.groups[0].visibleRows[0].locationLabel).toBe("Corte del 30 sep pagado con faltante");
  });
});

describe("T14 · grupos por lider, plegado y paginas (README decision 4)", () => {
  it("grupo 'Sin lider' con el texto 'no hay a quien cobrarle'", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({
      rows: [
        makeRow({ orderId: "x1", leaderId: null, leaderName: null, collectedCop: 80_000 }),
        makeRow({ orderId: "x2", leaderId: "A", leaderName: "Ana" }),
      ],
    });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    const sinLider = view.groups.find((group) => group.leaderId === null);
    expect(sinLider?.title).toBe("Sin lider");
    expect(sinLider?.note).toBe("no hay a quien cobrarle");
  });

  it("los grupos siguen el orden del informe (overdueCop desc) y solo el primero con vencidos va desplegado", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({
      rows: [
        makeRow({ orderId: "c1", leaderId: "C", leaderName: "Caro", isOverdue: false, ageDays: 2 }),
        ...twoLeadersReport().rows,
      ],
    });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    expect(view.groups.map((group) => group.leaderId)).toEqual(["B", "A", "C"]);
    expect(view.groups.map((group) => group.expanded)).toEqual([true, false, false]);
  });

  it("un grupo sin vencidos dice 'sin vencidos'", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({ rows: [makeRow({ orderId: "c1", leaderId: "C", leaderName: "Caro", isOverdue: false, ageDays: 2 })] });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    expect(view.groups[0].note).toBe("sin vencidos");
    expect(view.groups[0].expanded).toBe(false);
  });

  it("pagina de 6 en movil y de 25 en escritorio, del mas antiguo al mas reciente", async () => {
    const { buildCashOutstandingView } = await loadView();
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeRow({ orderId: `r${i}`, deliveredAt: `2026-09-${String(20 - i).padStart(2, "0")}T15:00:00.000Z` }),
    );
    const report = makeReport({ rows });
    const mobile = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    const desktop = buildCashOutstandingView(report, { viewport: "desktop", role: "admin" });

    expect(mobile.groups[0].pageSize).toBe(6);
    expect(mobile.groups[0].visibleRows).toHaveLength(6);
    expect(mobile.groups[0].remainingCount).toBe(2);
    expect(desktop.groups[0].pageSize).toBe(25);
    expect(desktop.groups[0].visibleRows).toHaveLength(8);
    expect(desktop.groups[0].remainingCount).toBe(0);

    const dates = desktop.groups[0].visibleRows.map((row) => row.deliveredAt);
    expect(dates).toEqual([...dates].sort());
  });

  it("'aprox.' solo cuando la fecha sale de updatedAt", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({
      rows: [
        makeRow({ orderId: "u1", deliveredAtSource: "updatedAt", deliveredAt: "2026-09-01T15:00:00.000Z" }),
        makeRow({ orderId: "u2", deliveredAtSource: "closedAt", deliveredAt: "2026-09-02T15:00:00.000Z" }),
        makeRow({ orderId: "u3", deliveredAtSource: "evidence", deliveredAt: "2026-09-03T15:00:00.000Z" }),
      ],
    });
    const view = buildCashOutstandingView(report, { viewport: "desktop", role: "admin" });
    expect(view.groups[0].visibleRows.map((row) => [row.orderId, row.deliveredAtApprox])).toEqual([
      ["u1", true],
      ["u2", false],
      ["u3", false],
    ]);
  });
});

describe("T14 · cubiertos por compensacion (RF_09, README decision 12)", () => {
  function withNetted(): CashOutstandingReport {
    return makeReport({
      rows: [makeRow({ orderId: "r1", collectedCop: 30_000, isOverdue: true, ageDays: 12 })],
      nettedRows: [
        makeRow({ orderId: "n1", location: "covered_by_netting", isOverdue: false, ageDays: 40, collectedCop: 100_000, attributedSettlementId: "s1", settlements: [settlement("s1", "paid", "2026-08-20T15:00:00.000Z", true)] }),
        makeRow({ orderId: "n2", location: "covered_by_netting", isOverdue: false, ageDays: 45, collectedCop: 50_000, attributedSettlementId: "s1", settlements: [settlement("s1", "paid", "2026-08-20T15:00:00.000Z", true)] }),
      ],
    });
  }

  it("seccion propia, plegada, con sus totales", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(withNetted(), { viewport: "mobile", role: "admin" });
    expect(view.netted).not.toBeNull();
    expect(view.netted?.title).toBe("Cubiertos por compensacion");
    expect(view.netted?.expanded).toBe(false);
    expect(view.netted?.count).toBe(2);
    expect(view.netted?.collectedCop).toBe(150_000);
    expect(view.netted?.settlementCount).toBe(1);
    expect(view.netted?.visibleRows.map((row) => row.locationLabel)).toEqual(["Cubierto por compensacion", "Cubierto por compensacion"]);
  });

  it("no cuentan como vencidos, ni en la franja, ni en la tarjeta, ni en ningun grupo", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(withNetted(), { viewport: "mobile", role: "admin" });
    expect(view.summary.overdueCount).toBe(1);
    expect(view.summary.overdueCop).toBe(30_000);
    expect(view.summary.orderCount).toBe(1);
    expect(view.card.overdueCount).toBe(1);
    expect(view.card.overdueCop).toBe(30_000);
    expect(view.card.nettedCount).toBe(2);
    const groupedIds = view.groups.flatMap((group) => group.visibleRows.map((row) => row.orderId));
    expect(groupedIds).not.toContain("n1");
    expect(groupedIds).not.toContain("n2");
  });

  it("sin compensados no hay seccion", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: [makeRow({ orderId: "r1" })] }), { viewport: "mobile", role: "admin" });
    expect(view.netted).toBeNull();
  });
});

describe("T14 · tarjeta 'Efectivo vencido' de Operacion (RF_03, README decision 2)", () => {
  it("con un lider de 5 pedidos y $50.000 vencidos y otro de 2 pedidos y $400.000, nombra al segundo", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(twoLeadersReport(), { viewport: "mobile", role: "admin" });
    expect(view.card.topLeader?.leaderId).toBe("B");
    expect(view.card.topLeader?.leaderName).toBe("Beto");
    expect(view.card.topLeader?.overdueCop).toBe(400_000);
    expect(view.card.topLeader?.overdueCount).toBe(2);
    expect(view.card.topLeader?.text).toMatch(/^Beto, .+ en 2 pedidos$/);
  });

  it("total vencido, numero de pedidos y antiguedad del mas viejo", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(twoLeadersReport(), { viewport: "mobile", role: "admin" });
    expect(view.card.overdueCop).toBe(450_000);
    expect(view.card.overdueCount).toBe(7);
    expect(view.card.oldestOverdueDays).toBe(21);
    expect(view.card.isAllClear).toBe(false);
    expect(view.card.allClearText).toBeNull();
  });

  it("la tarjeta no depende del filtro de lider", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(twoLeadersReport(), { viewport: "mobile", role: "admin", leaderFilter: "A" });
    expect(view.card.topLeader?.leaderId).toBe("B");
    expect(view.card.overdueCop).toBe(450_000);
  });

  it("tarjeta en $0: linea muda 'Efectivo vencido: $0 · al dia', sin lider", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({ rows: [makeRow({ orderId: "r1", isOverdue: false, ageDays: 3 })] });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    expect(view.card.isAllClear).toBe(true);
    expect(view.card.overdueCop).toBe(0);
    expect(view.card.overdueCount).toBe(0);
    expect(view.card.topLeader).toBeNull();
    expect(view.card.oldestOverdueDays).toBeNull();
    expect(view.card.allClearText).toMatch(/^Efectivo vencido: \$\s?0 · al dia$/);
  });

  it("tarjeta en $0 tambien con la lista vacia", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: [] }), { viewport: "mobile", role: "admin" });
    expect(view.card.isAllClear).toBe(true);
    expect(view.card.topLeader).toBeNull();
    expect(view.groups).toEqual([]);
  });
});

describe("T14 · filtro de lider en cliente y cuadre (README decision 3)", () => {
  it("sin filtro: el cuadre se muestra", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = twoLeadersReport({ mode: "with_reconciliation", reconciliation: RECONCILIATION });
    const view = buildCashOutstandingView(report, { viewport: "desktop", role: "admin", leaderFilter: null });
    expect(view.reconciliation).toEqual(RECONCILIATION);
  });

  it("con un lider elegido: el cuadre se oculta y solo queda su grupo con sus cifras", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = twoLeadersReport({ mode: "with_reconciliation", reconciliation: RECONCILIATION });
    const view = buildCashOutstandingView(report, { viewport: "desktop", role: "admin", leaderFilter: "A" });
    expect(view.reconciliation).toBeNull();
    expect(view.groups.map((group) => group.leaderId)).toEqual(["A"]);
    expect(view.summary.orderCount).toBe(5);
    expect(view.summary.collectedCop).toBe(50_000);
    expect(view.summary.overdueCount).toBe(5);
    expect(view.summary.overdueCop).toBe(50_000);
  });

  it("al quitar el filtro el cuadre vuelve (mismo informe, sin otra carga)", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = twoLeadersReport({ mode: "with_reconciliation", reconciliation: RECONCILIATION });
    buildCashOutstandingView(report, { viewport: "desktop", role: "admin", leaderFilter: "A" });
    const again = buildCashOutstandingView(report, { viewport: "desktop", role: "admin" });
    expect(again.reconciliation).toEqual(RECONCILIATION);
    expect(again.groups.map((group) => group.leaderId)).toEqual(["B", "A"]);
    expect(again.summary.orderCount).toBe(7);
  });

  it("NO_LEADER_FILTER elige el grupo 'Sin lider'", async () => {
    const { buildCashOutstandingView, NO_LEADER_FILTER } = await loadView();
    const report = makeReport({
      rows: [makeRow({ orderId: "x1", leaderId: null, leaderName: null }), makeRow({ orderId: "x2", leaderId: "A", leaderName: "Ana" })],
    });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin", leaderFilter: NO_LEADER_FILTER });
    expect(view.groups.map((group) => group.leaderId)).toEqual([null]);
    expect(view.summary.orderCount).toBe(1);
  });

  it("modo resumen: no hay cuadre que mostrar", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(twoLeadersReport(), { viewport: "desktop", role: "admin" });
    expect(view.reconciliation).toBeNull();
  });

  it("el lider nunca ve el cuadre", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = twoLeadersReport({ mode: "with_reconciliation", reconciliation: RECONCILIATION });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "leader" });
    expect(view.reconciliation).toBeNull();
  });
});

describe("T14 · cifras incompletas por tipo (README, estados)", () => {
  it("sin ilegibles no hay aviso", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: [makeRow({ orderId: "r1" })] }), { viewport: "mobile", role: "admin" });
    expect(view.incomplete).toBeNull();
  });

  type UnreadableCase = [
    string,
    Partial<Pick<CashOutstandingReport, "unreadableOrderIds" | "unreadableSettlementIds" | "unreadableEntryIds">>,
    Array<{ kind: string; id: string }>,
    boolean,
  ];
  it.each<UnreadableCase>([
    ["pedido", { unreadableOrderIds: ["o-bad"] }, [{ kind: "pedido", id: "o-bad" }], false],
    ["corte", { unreadableSettlementIds: ["s-bad"] }, [{ kind: "corte", id: "s-bad" }], true],
    ["asiento", { unreadableEntryIds: ["e-bad"] }, [{ kind: "asiento", id: "e-bad" }], false],
  ])("un %s ilegible basta para 'Cifras incompletas'", async (_kind, unreadable, documents, settlementWarning) => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({ rows: [makeRow({ orderId: "r1" })], isIncomplete: true, ...unreadable });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    expect(view.incomplete?.title).toBe("Cifras incompletas");
    expect(view.incomplete?.documents).toEqual(documents);
    expect(view.incomplete?.settlementWarning).toBe(settlementWarning);
  });

  it("los tres tipos a la vez, en orden pedido, corte, asiento", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({
      rows: [],
      isIncomplete: true,
      unreadableOrderIds: ["o1", "o2"],
      unreadableSettlementIds: ["s1"],
      unreadableEntryIds: ["e1"],
    });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    expect(view.incomplete?.documents).toEqual([
      { kind: "pedido", id: "o1" },
      { kind: "pedido", id: "o2" },
      { kind: "corte", id: "s1" },
      { kind: "asiento", id: "e1" },
    ]);
    expect(view.incomplete?.settlementWarning).toBe(true);
  });

  it("el lider ve 'Cifras incompletas' pero sin ids", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = makeReport({ rows: [], isIncomplete: true, unreadableEntryIds: ["e1"] });
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "leader" });
    expect(view.incomplete?.title).toBe("Cifras incompletas");
    expect(view.incomplete?.documents).toEqual([]);
  });
});

describe("T14 · linea de proveedor en Por pagar (RF_08, README decision 8)", () => {
  const report = () =>
    makeReport({
      rows: [makeRow({ orderId: "r1" })],
      bySupplier: [
        { supplierId: "adma-lab", supplierName: "ADMA LABORATORIO", amountCop: 1_094_350, overdueAmountCop: 200_000 },
        { supplierId: "zero", supplierName: "Sin nada", amountCop: 0, overdueAmountCop: 0 },
      ],
    });

  it("con importe retenido: 'No se puede pagar todavia: $X (efectivo sin llegar)'", async () => {
    const { supplierPendingLine } = await loadView();
    const line = supplierPendingLine(report(), "adma-lab");
    expect(line?.amountCop).toBe(1_094_350);
    expect(line?.text).toMatch(/^No se puede pagar todavia: \$\s?1\.094\.350 \(efectivo sin llegar\)$/);
  });

  it("proveedor sin efectivo sin llegar o con $0: sin linea", async () => {
    const { supplierPendingLine } = await loadView();
    expect(supplierPendingLine(report(), "otro")).toBeNull();
    expect(supplierPendingLine(report(), "zero")).toBeNull();
  });
});
