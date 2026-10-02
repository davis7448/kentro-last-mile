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

/**
 * Grupos por lider como los arma el servidor (`groupByLeader` de functions/src/cash-outstanding.ts):
 * `overdueCop` es el NETO vencido (Σ outstandingCop de las vencidas) y `overdueCollectedCop` el BRUTO
 * (Σ collectedCop de las vencidas, T19). Orden: `overdueCop` desc (empate `outstandingCop` desc, id).
 * T19 corrigio este ayudante: antes sumaba `collectedCop` en `overdueCop`, que no es lo que hace el
 * servidor, y por eso las pruebas no veian que la tarjeta mezclaba bruto y neto (R1-RF_03-1).
 */
/** `CashOutstandingGroup` con el campo que anade T19 (se tipa aparte mientras el servidor no lo tenga). */
type GroupT19 = CashOutstandingGroup & { overdueCollectedCop: number };

function groupsOf(rows: CashOutstandingRow[]): CashOutstandingGroup[] {
  const map = new Map<string, GroupT19>();
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
      overdueCollectedCop: 0,
      oldestDeliveredAt: row.deliveredAt,
    } as GroupT19;
    group.orderCount += 1;
    group.collectedCop += row.collectedCop;
    group.outstandingCop += row.outstandingCop;
    if (row.isOverdue) {
      group.overdueCount += 1;
      group.overdueCop += row.outstandingCop;
      group.overdueCollectedCop += row.collectedCop;
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
      // Como `computeTotals` del servidor: neto en `overdueCop`, bruto en `overdueCollectedCop` (T19).
      overdueCop: sum(rows.filter((row) => row.isOverdue), (row) => row.outstandingCop),
      overdueCollectedCop: sum(rows.filter((row) => row.isOverdue), (row) => row.collectedCop),
      nettedCount: nettedRows.length,
      nettedCollectedCop: sum(nettedRows, (row) => row.collectedCop),
      nettedSettlementCount: new Set(nettedRows.map((row) => row.attributedSettlementId)).size,
    } as CashOutstandingReport["totals"],
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
        // T21: `nettedAmountCop` es parte del contrato de bySupplier; 0 = sin compensados, el texto no cambia.
        { supplierId: "adma-lab", supplierName: "ADMA LABORATORIO", amountCop: 1_094_350, overdueAmountCop: 200_000, nettedAmountCop: 0 },
        { supplierId: "zero", supplierName: "Sin nada", amountCop: 0, overdueAmountCop: 0, nettedAmountCop: 0 },
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

describe("T21 · la linea de proveedor incluye el producto de los compensados (R1-RF_08-1, RF_08, RF_09)", () => {
  // `amountCop` ya incluye los compensados (el servidor no los paga); `nettedAmountCop` es esa parte.
  const report = () =>
    makeReport({
      rows: [makeRow({ orderId: "r1" })],
      bySupplier: [
        { supplierId: "adma-lab", supplierName: "ADMA LABORATORIO", amountCop: 1_246_347, overdueAmountCop: 200_000, nettedAmountCop: 1_151_997 },
        { supplierId: "solo-netted", supplierName: "Solo compensados", amountCop: 42_000, overdueAmountCop: 0, nettedAmountCop: 42_000 },
        { supplierId: "sin-netted", supplierName: "Sin compensados", amountCop: 94_350, overdueAmountCop: 0, nettedAmountCop: 0 },
      ],
    });

  it("con compensados: 'No se puede pagar todavia: $X' con X que los incluye, y 'incluye $Y de pedidos cubiertos por compensacion'", async () => {
    const { supplierPendingLine } = await loadView();
    const line = supplierPendingLine(report(), "adma-lab");
    expect(line?.amountCop).toBe(1_246_347);
    expect(line?.text).toMatch(/^No se puede pagar todavia: \$\s?1\.246\.347\b/);
    expect(line?.text).toMatch(/incluye \$\s?1\.151\.997 de pedidos cubiertos por compensacion/);
  });

  it("proveedor solo con compensados: tiene linea por el total compensado", async () => {
    const { supplierPendingLine } = await loadView();
    const line = supplierPendingLine(report(), "solo-netted");
    expect(line?.amountCop).toBe(42_000);
    expect(line?.text).toMatch(/^No se puede pagar todavia: \$\s?42\.000\b/);
    expect(line?.text).toMatch(/incluye \$\s?42\.000 de pedidos cubiertos por compensacion/);
  });

  it("sin compensados (nettedAmountCop 0): el texto queda como hoy, sin mencion de compensacion", async () => {
    const { supplierPendingLine } = await loadView();
    const line = supplierPendingLine(report(), "sin-netted");
    expect(line?.text).toMatch(/^No se puede pagar todavia: \$\s?94\.350 \(efectivo sin llegar\)$/);
    expect(line?.text).not.toMatch(/compensacion/);
  });
});

describe("T19 · la tarjeta y los grupos miden el vencido en bruto (R1-RF_03-1, spec 9 P1)", () => {
  type ViewGroupT19 = { leaderId: string | null; overdueCollectedCop?: number };

  /** Un lider, un pedido vencido: recaudo $100.000, pago al domiciliario $7.000 (neto $93.000). */
  function oneLeaderWithPay(): CashOutstandingReport {
    return makeReport({
      rows: [
        makeRow({ orderId: "p1", leaderId: "A", leaderName: "Ana", collectedCop: 100_000, driverPayCop: 7_000, expectedCashCop: 93_000, outstandingCop: 93_000 }),
      ],
    });
  }

  /**
   * Ana: recaudo $100.000, pago $30.000 -> neto $70.000. Beto: recaudo $80.000, sin pago -> neto $80.000.
   * Por neto (orden del servidor) va primero Beto; por bruto, Ana.
   */
  function grossAndNetDisagree(): CashOutstandingReport {
    return makeReport({
      rows: [
        makeRow({ orderId: "a1", leaderId: "A", leaderName: "Ana", collectedCop: 100_000, driverPayCop: 30_000, expectedCashCop: 70_000, outstandingCop: 70_000 }),
        makeRow({ orderId: "b1", leaderId: "B", leaderName: "Beto", collectedCop: 80_000, driverPayCop: 0, expectedCashCop: 80_000, outstandingCop: 80_000 }),
      ],
    });
  }

  it("el ayudante arma los grupos como el servidor: overdueCop neto y overdueCollectedCop bruto", () => {
    const [group] = oneLeaderWithPay().byLeader as GroupT19[];
    expect({ overdueCop: group.overdueCop, overdueCollectedCop: group.overdueCollectedCop }).toEqual({ overdueCop: 93_000, overdueCollectedCop: 100_000 });
  });

  it("recaudo $100.000 y pago $7.000: el total de la tarjeta es el bruto, $100.000", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(oneLeaderWithPay(), { viewport: "mobile", role: "admin" });
    expect(view.card.overdueCop).toBe(100_000);
  });

  it("recaudo $100.000 y pago $7.000: la linea del lider dice la misma cifra que el total", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(oneLeaderWithPay(), { viewport: "mobile", role: "admin" });
    expect(view.card.topLeader?.overdueCop).toBe(view.card.overdueCop);
  });

  it("recaudo $100.000 y pago $7.000: el texto de la linea pinta $100.000, no $93.000", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(oneLeaderWithPay(), { viewport: "mobile", role: "admin" });
    expect(view.card.topLeader?.text).toMatch(/^Ana, \$\s?100\.000 en 1 pedido$/);
  });

  it("dos lideres con orden distinto por bruto y por neto: topLeader es el de mayor bruto", async () => {
    const { buildCashOutstandingView } = await loadView();
    const report = grossAndNetDisagree();
    expect(report.byLeader[0].leaderId).toBe("B"); // precondicion: el servidor ordena por neto
    const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
    expect(view.card.topLeader?.leaderId).toBe("A");
  });

  it("dos lideres: la linea del de mayor bruto pinta su bruto ($100.000)", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(grossAndNetDisagree(), { viewport: "mobile", role: "admin" });
    expect(view.card.topLeader?.overdueCop).toBe(100_000);
  });

  it("cada grupo de la pestaña expone su vencido bruto en overdueCollectedCop", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(grossAndNetDisagree(), { viewport: "desktop", role: "admin" });
    const gross = Object.fromEntries((view.groups as ViewGroupT19[]).map((group) => [group.leaderId, group.overdueCollectedCop]));
    expect(gross).toEqual({ A: 100_000, B: 80_000 });
  });

  it("la franja (summary) y la suma en bruto de los grupos coinciden", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(grossAndNetDisagree(), { viewport: "desktop", role: "admin" });
    const groupsGross = (view.groups as ViewGroupT19[]).reduce((total, group) => total + (group.overdueCollectedCop ?? Number.NaN), 0);
    expect(groupsGross).toBe(view.summary.overdueCop);
  });
});

describe("T22 · la tarjeta de Operacion dice 'cifras incompletas' (R2-RF_03-1, RF_03)", () => {
  /**
   * Contrato que fija este bloque (design-system: "si una cifra sale de datos incompletos, dilo o no la
   * muestres"):
   *   card.isIncomplete: boolean  — true si `report.isIncomplete` o si alguna lista `unreadable*Ids` trae ids
   *                                 (el mismo criterio que `view.incomplete`).
   *   Con `card.isIncomplete`: `isAllClear` false y `allClearText` null aunque el vencido legible sea 0; la
   *   cifra legible (overdueCop, overdueCount) se conserva tal cual.
   */
  type CardT22 = { isIncomplete?: boolean; isAllClear: boolean; allClearText: string | null; overdueCop: number; overdueCount: number };
  const cardOf = (view: { card: unknown }) => view.card as CardT22;

  /** Solo un pedido legible y no vencido: el vencido legible es $0. */
  const zeroOverdueRows = () => [makeRow({ orderId: "r1", isOverdue: false, ageDays: 3 })];

  type UnreadableKind = [string, Partial<Pick<CashOutstandingReport, "unreadableOrderIds" | "unreadableSettlementIds" | "unreadableEntryIds">>];
  const KINDS: UnreadableKind[] = [
    ["pedido", { unreadableOrderIds: ["o-bad"] }],
    ["corte", { unreadableSettlementIds: ["s-bad"] }],
    ["asiento", { unreadableEntryIds: ["e-bad"] }],
  ];

  it.each(KINDS)("vencido legible en cero y un %s ilegible: card.isIncomplete es true", async (_kind, unreadable) => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: zeroOverdueRows(), isIncomplete: true, ...unreadable }), { viewport: "mobile", role: "admin" });
    expect(cardOf(view).isIncomplete).toBe(true);
  });

  it.each(KINDS)("vencido legible en cero y un %s ilegible: no dice 'al dia' (isAllClear false, allClearText null)", async (_kind, unreadable) => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: zeroOverdueRows(), isIncomplete: true, ...unreadable }), { viewport: "mobile", role: "admin" });
    expect({ isAllClear: cardOf(view).isAllClear, allClearText: cardOf(view).allClearText }).toEqual({ isAllClear: false, allClearText: null });
  });

  it("lista vacia y un pedido ilegible (el escenario del hallazgo): sin 'al dia' y con aviso", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: [], isIncomplete: true, unreadableOrderIds: ["o-40-dias"] }), { viewport: "mobile", role: "admin" });
    expect({ isIncomplete: cardOf(view).isIncomplete, isAllClear: cardOf(view).isAllClear, allClearText: cardOf(view).allClearText }).toEqual({
      isIncomplete: true,
      isAllClear: false,
      allClearText: null,
    });
  });

  it("ids ilegibles aunque el servidor no marque isIncomplete: la tarjeta tambien avisa (mismo criterio que view.incomplete)", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: zeroOverdueRows(), isIncomplete: false, unreadableOrderIds: ["o-bad"] }), { viewport: "mobile", role: "admin" });
    expect({ isIncomplete: cardOf(view).isIncomplete, isAllClear: cardOf(view).isAllClear }).toEqual({ isIncomplete: true, isAllClear: false });
  });

  it("vencido > 0 e incompleto: la cifra legible se conserva y la tarjeta avisa", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(twoLeadersReport({ isIncomplete: true, unreadableSettlementIds: ["s-bad"] }), { viewport: "mobile", role: "admin" });
    expect({
      isIncomplete: cardOf(view).isIncomplete,
      overdueCop: cardOf(view).overdueCop,
      overdueCount: cardOf(view).overdueCount,
      isAllClear: cardOf(view).isAllClear,
      allClearText: cardOf(view).allClearText,
    }).toEqual({ isIncomplete: true, overdueCop: 450_000, overdueCount: 7, isAllClear: false, allClearText: null });
  });

  it("completo y vencido $0: igual que hoy, 'Efectivo vencido: $0 · al dia' y isIncomplete false", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: zeroOverdueRows() }), { viewport: "mobile", role: "admin" });
    expect(cardOf(view).isIncomplete).toBe(false);
    expect(cardOf(view).isAllClear).toBe(true);
    expect(cardOf(view).allClearText).toMatch(/^Efectivo vencido: \$\s?0 · al dia$/);
  });

  it("completo y vencido > 0: isIncomplete false", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(twoLeadersReport(), { viewport: "mobile", role: "admin" });
    expect(cardOf(view).isIncomplete).toBe(false);
  });
});

describe("T23 · lo retenido a proveedores se ve aunque todo este compensado (R2-RF_08-1, RF_08, RF_09)", () => {
  /**
   * Contrato que fija este bloque (la decision vive en el modelo de vista, no en el componente):
   *   view.showSupplierWithheld: boolean — admin y `report.bySupplier` no vacio, haya o no `rows`.
   *                                        Siempre false para el lider.
   *   view.emptyState: "all_clear" | "only_netted" | null
   *     - null          si hay `rows`.
   *     - "only_netted" si no hay `rows` pero si compensados (`nettedRows`).
   *     - "all_clear"   solo si no hay `rows`, ni `bySupplier`, ni `nettedRows`.
   */
  type ViewT23 = { showSupplierWithheld?: boolean; emptyState?: "all_clear" | "only_netted" | null };
  const t23 = (view: unknown) => view as ViewT23;

  const LAB = { supplierId: "adma-lab", supplierName: "ADMA LABORATORIO", amountCop: 500_000, overdueAmountCop: 0, nettedAmountCop: 500_000 };
  const netted = () => [makeRow({ orderId: "n1", location: "covered_by_netting", attributedSettlementId: "s-1" })];

  /** El escenario del hallazgo: rows vacio, solo compensados con producto de LAB sin pagar. */
  const onlyNetted = () => makeReport({ rows: [], nettedRows: netted(), bySupplier: [LAB] });
  const allEmpty = () => makeReport({ rows: [] });

  it("rows vacio + compensados con producto: showSupplierWithheld es true", async () => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(onlyNetted(), { viewport: "mobile", role: "admin" })).showSupplierWithheld).toBe(true);
  });

  it("rows vacio + compensados con producto: emptyState es 'only_netted' (no promete que el proveedor cobre)", async () => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(onlyNetted(), { viewport: "mobile", role: "admin" })).emptyState).toBe("only_netted");
  });

  it("todo vacio: emptyState es 'all_clear'", async () => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(allEmpty(), { viewport: "mobile", role: "admin" })).emptyState).toBe("all_clear");
  });

  it("todo vacio: showSupplierWithheld es false", async () => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(allEmpty(), { viewport: "mobile", role: "admin" })).showSupplierWithheld).toBe(false);
  });

  it("rows vacio y sin compensados pero con retenido a proveedor: no es 'all_clear'", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: [], bySupplier: [{ ...LAB, nettedAmountCop: 0 }] }), { viewport: "mobile", role: "admin" });
    expect({ showSupplierWithheld: t23(view).showSupplierWithheld, isAllClear: t23(view).emptyState === "all_clear" }).toEqual({ showSupplierWithheld: true, isAllClear: false });
  });

  it("con rows: emptyState es null", async () => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(twoLeadersReport({ bySupplier: [LAB] }), { viewport: "desktop", role: "admin" })).emptyState).toBeNull();
  });

  it("con rows y bySupplier: showSupplierWithheld es true (como hoy)", async () => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(twoLeadersReport({ bySupplier: [LAB] }), { viewport: "desktop", role: "admin" })).showSupplierWithheld).toBe(true);
  });

  it.each([
    ["con rows", () => twoLeadersReport({ bySupplier: [LAB] })],
    ["solo compensados", onlyNetted],
    ["todo vacio", allEmpty],
  ] as const)("lider (%s): showSupplierWithheld es false", async (_case, build) => {
    const { buildCashOutstandingView } = await loadView();
    expect(t23(buildCashOutstandingView(build(), { viewport: "mobile", role: "leader" })).showSupplierWithheld).toBe(false);
  });
});

describe("T24 · el aviso de la tarjeta dice hacia donde puede estar mal la cifra (R3-RF_03-1, RF_03)", () => {
  /**
   * Contrato que fija este bloque (el texto lo decide el modelo de vista, no el componente):
   *   card.incompleteText: string | null
   *     - null si los datos estan completos (mismo criterio que `card.isIncomplete`).
   *     - corte ilegible: contiene "pedidos ya cubiertos" (la cifra puede estar inflada).
   *     - solo pedido o asiento ilegible (o `isIncomplete` sin ids): contiene "puede faltar" (cifra corta).
   *     - corte + pedido ilegibles: contiene las dos ideas.
   *   Mismo criterio que la pestana: (incompleteText contiene "pedidos ya cubiertos") <=>
   *   view.incomplete.settlementWarning, para el admin.
   */
  type CardT24 = { isIncomplete?: boolean; incompleteText?: string | null };
  const cardOf = (view: { card: unknown }) => view.card as CardT24;
  type Unreadable = Partial<Pick<CashOutstandingReport, "isIncomplete" | "unreadableOrderIds" | "unreadableSettlementIds" | "unreadableEntryIds">>;
  const viewWith = async (unreadable: Unreadable) => {
    const { buildCashOutstandingView } = await loadView();
    return buildCashOutstandingView(makeReport({ rows: [makeRow({ orderId: "r1" })], isIncomplete: true, ...unreadable }), {
      viewport: "mobile",
      role: "admin",
    });
  };

  it("datos completos: incompleteText es null", async () => {
    const { buildCashOutstandingView } = await loadView();
    const view = buildCashOutstandingView(makeReport({ rows: [makeRow({ orderId: "r1" })] }), { viewport: "mobile", role: "admin" });
    expect(cardOf(view).incompleteText).toBeNull();
  });

  it("corte ilegible: incompleteText avisa de 'pedidos ya cubiertos' (cifra inflada)", async () => {
    const view = await viewWith({ unreadableSettlementIds: ["s-bad"] });
    expect(cardOf(view).incompleteText).toMatch(/pedidos ya cubiertos/);
  });

  it("corte ilegible: incompleteText NO dice que la cifra puede ser mayor", async () => {
    const view = await viewWith({ unreadableSettlementIds: ["s-bad"] });
    expect(cardOf(view).incompleteText ?? "").not.toMatch(/puede ser mayor/);
  });

  it.each([
    ["pedido", { unreadableOrderIds: ["o-bad"] }],
    ["asiento", { unreadableEntryIds: ["e-bad"] }],
  ] as Array<[string, Unreadable]>)("solo %s ilegible: incompleteText dice 'puede faltar'", async (_kind, unreadable) => {
    const view = await viewWith(unreadable);
    expect(cardOf(view).incompleteText).toMatch(/puede faltar/);
  });

  it.each([
    ["pedido", { unreadableOrderIds: ["o-bad"] }],
    ["asiento", { unreadableEntryIds: ["e-bad"] }],
  ] as Array<[string, Unreadable]>)("solo %s ilegible: incompleteText no habla de pedidos ya cubiertos", async (_kind, unreadable) => {
    const view = await viewWith(unreadable);
    expect(cardOf(view).incompleteText ?? "").not.toMatch(/pedidos ya cubiertos/);
  });

  it("isIncomplete sin ids: incompleteText dice 'puede faltar'", async () => {
    const view = await viewWith({});
    expect(cardOf(view).incompleteText).toMatch(/puede faltar/);
  });

  it("corte y pedido ilegibles: incompleteText trae las dos ideas", async () => {
    const view = await viewWith({ unreadableSettlementIds: ["s-bad"], unreadableOrderIds: ["o-bad"] });
    const text = cardOf(view).incompleteText ?? "";
    expect({ cubiertos: /pedidos ya cubiertos/.test(text), faltar: /puede faltar/.test(text) }).toEqual({ cubiertos: true, faltar: true });
  });

  it.each([
    ["completo", {}, false],
    ["corte", { unreadableSettlementIds: ["s-bad"] }, true],
    ["pedido", { unreadableOrderIds: ["o-bad"] }, true],
    ["asiento", { unreadableEntryIds: ["e-bad"] }, true],
    ["corte+pedido", { unreadableSettlementIds: ["s-bad"], unreadableOrderIds: ["o-bad"] }, true],
  ] as Array<[string, Unreadable, boolean]>)(
    "coherencia con la pestana (%s): 'pedidos ya cubiertos' en la tarjeta <=> view.incomplete.settlementWarning",
    async (_case, unreadable, incomplete) => {
      const { buildCashOutstandingView } = await loadView();
      const report = makeReport({ rows: [makeRow({ orderId: "r1" })], isIncomplete: incomplete, ...unreadable });
      const view = buildCashOutstandingView(report, { viewport: "mobile", role: "admin" });
      const text = cardOf(view).incompleteText;
      expect({
        hasText: typeof text === "string" && text.length > 0,
        cubiertos: /pedidos ya cubiertos/.test(text ?? ""),
      }).toEqual({ hasText: incomplete, cubiertos: view.incomplete?.settlementWarning ?? false });
    },
  );
});
