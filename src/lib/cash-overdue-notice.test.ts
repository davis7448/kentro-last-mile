/**
 * Spec 026 · T10 — composicion del aviso de efectivo vencido y sus documentos (RF_05, RF_09).
 *
 * `functions/src/cash-overdue-notice.ts` es PURO (sin firebase-admin ni fetch). Ata:
 *  1. `selectNoticeCandidates(report, notifiedOrderIds)`: candidata = fila de `report.rows` (NUNCA de
 *     `nettedRows`) con `isOverdue`, `outstandingCop > 0`, `outstandingCop >= settings.notifyMinCop` y
 *     sin aviso previo. Orden `deliveredAt` asc (lo mas viejo primero).
 *  2. `composeOverdueNotice(candidates, { isIncomplete, now, maxLength? })`: UN mensaje por corrida,
 *     agrupado por lider (el mismo lider con muchos pedidos sale una vez), "Sin lider" con "no hay a
 *     quien cobrarle", tope de `NOTICE_MAX_LENGTH` (2.000) caracteres, "cifras incompletas" si el
 *     informe lo es, y sin datos del cliente. Sin candidatas devuelve `null` (no hay nada que enviar).
 *     Aunque recorte el detalle, el total de TODAS las candidatas sigue en el texto: la primera corrida
 *     avisa todo el atraso en un solo mensaje y lo marca entero.
 *  3. `buildNoticeDocs` (uno por pedido, id = orderId: "una vez por pedido") y `buildRunDoc` (la
 *     corrida, para auditar el "al menos una vez"): sin ningun `undefined` en profundidad (plan 2.8).
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle
 * con su propio mensaje en vez de tumbar el archivo entero.
 */
import { describe, expect, it } from "vitest";
import type { CashOutstandingRow } from "../../functions/src/cash-outstanding";

const load = () => import("../../functions/src/cash-overdue-notice");

const NOW = "2026-10-02T13:00:00.000Z";
const SETTINGS = { overdueDays: 7, notifyMinCop: 20_000 };

/** Rutas de toda clave cuyo valor es `undefined`, a cualquier profundidad (objetos y arrays). */
function undefinedPaths(value: unknown, path = "$"): string[] {
  if (value === undefined) return [path];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`));
}

const cop = (amount: number) => `$${amount.toLocaleString("es-CO")}`;

function row(orderId: string, overrides: Partial<CashOutstandingRow> = {}): CashOutstandingRow {
  return {
    orderId,
    trackingCode: `KNT-${orderId}`,
    sellerId: "seller-1",
    sellerName: "Tienda Uno",
    leaderId: "leader-1",
    leaderName: "Jhon Fredy Ruiz",
    messengerId: "messenger-1",
    messengerName: "Mensajero Uno",
    deliveredAt: "2026-09-10T15:00:00.000Z",
    deliveredAtSource: "closedAt",
    ageDays: 22,
    isOverdue: true,
    collectedCop: 95_000,
    collectedSource: "wallet",
    driverPayCop: 9_000,
    expectedCashCop: 86_000,
    receivedCop: 0,
    outstandingCop: 86_000,
    location: "outside_settlement",
    settlements: [],
    attributedSettlementId: null,
    supplierWithheld: [],
    ...overrides,
  };
}

function report(rows: CashOutstandingRow[], extra: { nettedRows?: CashOutstandingRow[]; notifyMinCop?: number; isIncomplete?: boolean } = {}) {
  return {
    rows,
    nettedRows: extra.nettedRows ?? [],
    settings: { ...SETTINGS, notifyMinCop: extra.notifyMinCop ?? SETTINGS.notifyMinCop },
    isIncomplete: extra.isIncomplete ?? false,
  };
}

const ids = (rows: readonly { orderId: string }[]) => rows.map((item) => item.orderId);

// ---------------------------------------------------------------------------------------------------
// 1. Candidatas
// ---------------------------------------------------------------------------------------------------

describe("T10 · selectNoticeCandidates: umbral, una vez y solo `rows`", () => {
  it("una fila vencida por encima del umbral y sin aviso previo es candidata", async () => {
    const { selectNoticeCandidates } = await load();
    expect(ids(selectNoticeCandidates(report([row("a")]), new Set()))).toEqual(["a"]);
  });

  it("umbral inclusivo: outstandingCop == notifyMinCop es candidata; un peso menos no", async () => {
    const { selectNoticeCandidates } = await load();
    const rows = [row("justo", { outstandingCop: 20_000 }), row("debajo", { outstandingCop: 19_999 })];
    expect(ids(selectNoticeCandidates(report(rows), new Set()))).toEqual(["justo"]);
  });

  it("caso limite: contraentrega con recaudo de $1 (KNT-005242) vencida no dispara el aviso", async () => {
    const { selectNoticeCandidates } = await load();
    const tiny = row("uno", { collectedCop: 1, driverPayCop: 0, expectedCashCop: 1, outstandingCop: 1, ageDays: 40 });
    expect(selectNoticeCandidates(report([tiny]), new Set())).toEqual([]);
  });

  it("con umbral 0, un pedido sin efectivo esperado (outstandingCop 0, plan 4.5) tampoco avisa", async () => {
    const { selectNoticeCandidates } = await load();
    const zero = row("cero", { collectedCop: 9_000, driverPayCop: 9_000, expectedCashCop: 0, outstandingCop: 0 });
    expect(selectNoticeCandidates(report([zero], { notifyMinCop: 0 }), new Set())).toEqual([]);
  });

  it("con umbral 0, el recaudo de $1 vencido si es candidato (el umbral es lo que lo filtra)", async () => {
    const { selectNoticeCandidates } = await load();
    const tiny = row("uno", { collectedCop: 1, driverPayCop: 0, expectedCashCop: 1, outstandingCop: 1 });
    expect(ids(selectNoticeCandidates(report([tiny], { notifyMinCop: 0 }), new Set()))).toEqual(["uno"]);
  });

  it("una fila no vencida (isOverdue false) no es candidata aunque el importe sea grande", async () => {
    const { selectNoticeCandidates } = await load();
    const fresh = row("nuevo", { ageDays: 3, isOverdue: false, outstandingCop: 900_000 });
    expect(selectNoticeCandidates(report([fresh]), new Set())).toEqual([]);
  });

  it("una sola vez por pedido: un pedido ya avisado no vuelve a ser candidato", async () => {
    const { selectNoticeCandidates } = await load();
    const rows = [row("avisado"), row("nuevo")];
    expect(ids(selectNoticeCandidates(report(rows), new Set(["avisado"])))).toEqual(["nuevo"]);
  });

  it("todas avisadas: no hay candidatas", async () => {
    const { selectNoticeCandidates } = await load();
    expect(selectNoticeCandidates(report([row("a"), row("b")]), new Set(["a", "b"]))).toEqual([]);
  });

  it("RF_09: un informe con nettedRows de 90 dias y $500.000 no produce candidatos", async () => {
    const { selectNoticeCandidates } = await load();
    // Aunque la fila compensada llegara marcada como vencida (no deberia), su lista no se mira.
    const netted = row("compensado", {
      ageDays: 90,
      deliveredAt: "2026-07-04T15:00:00.000Z",
      collectedCop: 509_000,
      expectedCashCop: 500_000,
      outstandingCop: 500_000,
      location: "covered_by_netting",
      isOverdue: true,
    });
    expect(selectNoticeCandidates(report([], { nettedRows: [netted] }), new Set())).toEqual([]);
  });

  it("RF_09: una fila covered_by_netting colada en `rows` tampoco es candidata", async () => {
    const { selectNoticeCandidates } = await load();
    const netted = row("compensado", { location: "covered_by_netting", isOverdue: true, outstandingCop: 500_000 });
    expect(selectNoticeCandidates(report([netted]), new Set())).toEqual([]);
  });

  it("orden: lo mas viejo primero (deliveredAt asc), sin importar el orden de entrada", async () => {
    const { selectNoticeCandidates } = await load();
    const rows = [
      row("sept", { deliveredAt: "2026-09-10T15:00:00.000Z" }),
      row("julio", { deliveredAt: "2026-07-01T15:00:00.000Z" }),
      row("agosto", { deliveredAt: "2026-08-05T15:00:00.000Z" }),
    ];
    expect(ids(selectNoticeCandidates(report(rows), new Set()))).toEqual(["julio", "agosto", "sept"]);
  });

  it("acepta los ids avisados como arreglo ademas de Set", async () => {
    const { selectNoticeCandidates } = await load();
    expect(ids(selectNoticeCandidates(report([row("a"), row("b")]), ["a"]))).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. Mensaje
// ---------------------------------------------------------------------------------------------------

describe("T10 · composeOverdueNotice: un mensaje por corrida, agrupado por lider", () => {
  it("sin candidatas devuelve null: no hay nada que enviar", async () => {
    const { composeOverdueNotice } = await load();
    expect(composeOverdueNotice([], { isIncomplete: false, now: NOW })).toBeNull();
  });

  it("el mismo lider con muchos vencidos se agrupa: un solo grupo, su nombre una vez en el texto", async () => {
    const { composeOverdueNotice } = await load();
    const candidates = ["a", "b", "c", "d", "e"].map((id, index) => row(id, { outstandingCop: 30_000 + index * 1_000 }));
    const notice = composeOverdueNotice(candidates, { isIncomplete: false, now: NOW });
    expect(notice).not.toBeNull();
    expect(notice!.groups).toHaveLength(1);
    expect(notice!.groups[0]).toMatchObject({ leaderId: "leader-1", leaderName: "Jhon Fredy Ruiz", orderCount: 5, outstandingCop: 160_000 });
    expect(notice!.groups[0].orderIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(notice!.text.split("Jhon Fredy Ruiz")).toHaveLength(2);
  });

  it("el texto nombra cada guia y el total del lider en pesos colombianos", async () => {
    const { composeOverdueNotice } = await load();
    const candidates = [row("a", { trackingCode: "KNT-001234", outstandingCop: 86_000 }), row("b", { trackingCode: "KNT-001240", outstandingCop: 1_065_720 })];
    const notice = composeOverdueNotice(candidates, { isIncomplete: false, now: NOW })!;
    expect(notice.text).toContain("KNT-001234");
    expect(notice.text).toContain("KNT-001240");
    expect(notice.text).toContain(cop(1_151_720));
  });

  it("varios lideres: un grupo por lider, ordenados por importe pendiente desc", async () => {
    const { composeOverdueNotice } = await load();
    const candidates = [
      row("a", { leaderId: "leader-1", leaderName: "Jhon Fredy Ruiz", outstandingCop: 40_000 }),
      row("b", { leaderId: "leader-2", leaderName: "Wilmer Ospina", outstandingCop: 300_000 }),
      row("c", { leaderId: "leader-1", leaderName: "Jhon Fredy Ruiz", outstandingCop: 50_000 }),
    ];
    const notice = composeOverdueNotice(candidates, { isIncomplete: false, now: NOW })!;
    expect(notice.groups.map((group) => [group.leaderId, group.outstandingCop])).toEqual([
      ["leader-2", 300_000],
      ["leader-1", 90_000],
    ]);
    expect(notice.orderCount).toBe(3);
    expect(notice.totalCop).toBe(390_000);
  });

  it("caso limite: pedido sin lider va al grupo leaderId null con 'Sin lider' y 'no hay a quien cobrarle'", async () => {
    const { composeOverdueNotice } = await load();
    const orphan = row("huerfano", { leaderId: null, leaderName: null, outstandingCop: 82_250 });
    const notice = composeOverdueNotice([orphan, row("a")], { isIncomplete: false, now: NOW })!;
    const orphanGroup = notice.groups.find((group) => group.leaderId === null);
    expect(orphanGroup).toMatchObject({ leaderId: null, leaderName: null, orderCount: 1, outstandingCop: 82_250, orderIds: ["huerfano"] });
    expect(notice.text).toContain("Sin lider");
    expect(notice.text).toContain("no hay a quien cobrarle");
  });

  it("con informe incompleto lo dice: 'cifras incompletas'", async () => {
    const { composeOverdueNotice } = await load();
    const notice = composeOverdueNotice([row("a")], { isIncomplete: true, now: NOW })!;
    expect(notice.text.toLowerCase()).toContain("cifras incompletas");
  });

  it("con informe completo no dice 'cifras incompletas'", async () => {
    const { composeOverdueNotice } = await load();
    const notice = composeOverdueNotice([row("a")], { isIncomplete: false, now: NOW })!;
    expect(notice.text.toLowerCase()).not.toContain("cifras incompletas");
  });

  it("sin datos del cliente: nada de lo que traiga la fila fuera del informe llega al texto", async () => {
    const { composeOverdueNotice } = await load();
    const leaky = {
      ...row("a"),
      customerName: "Maria Fernanda Lopez",
      customerPhone: "+573001112233",
      address: "Calle 5 # 38-25 Barrio San Fernando",
    } as CashOutstandingRow;
    const notice = composeOverdueNotice([leaky], { isIncomplete: false, now: NOW })!;
    expect(notice.text).not.toContain("Maria Fernanda");
    expect(notice.text).not.toContain("3001112233");
    expect(notice.text).not.toContain("San Fernando");
  });

  it("mensaje corto: no se recorta (truncated false) y cabe en el tope", async () => {
    const { composeOverdueNotice, NOTICE_MAX_LENGTH } = await load();
    expect(NOTICE_MAX_LENGTH).toBe(2_000);
    const notice = composeOverdueNotice([row("a"), row("b")], { isIncomplete: false, now: NOW })!;
    expect(notice.truncated).toBe(false);
    expect(notice.text.length).toBeLessThanOrEqual(2_000);
  });

  it("primera corrida con todo el atraso (300 pedidos, 12 lideres): un solo texto <= 2.000 caracteres, recortado, con el total de TODOS", async () => {
    const { composeOverdueNotice } = await load();
    const candidates = Array.from({ length: 300 }, (_, index) =>
      row(`o${index}`, {
        trackingCode: `KNT-${String(index).padStart(6, "0")}`,
        leaderId: `leader-${index % 12}`,
        leaderName: `Lider Con Un Nombre Bastante Largo Numero ${index % 12}`,
        outstandingCop: 25_000 + index,
      }),
    );
    const totalCop = candidates.reduce((sum, item) => sum + item.outstandingCop, 0);
    const notice = composeOverdueNotice(candidates, { isIncomplete: true, now: NOW })!;
    expect(typeof notice.text).toBe("string");
    expect(notice.text.length).toBeLessThanOrEqual(2_000);
    expect(notice.truncated).toBe(true);
    expect(notice.orderCount).toBe(300);
    expect(notice.totalCop).toBe(totalCop);
    expect(notice.text).toContain(cop(totalCop));
    expect(notice.text).toContain("300");
    // el aviso de cifras incompletas no se pierde con el recorte
    expect(notice.text.toLowerCase()).toContain("cifras incompletas");
    // los grupos cuentan todas las candidatas aunque el texto se recorte: se marcan todas
    expect(notice.groups.reduce((sum, group) => sum + group.orderCount, 0)).toBe(300);
  });

  it("respeta un maxLength menor si se le pasa", async () => {
    const { composeOverdueNotice } = await load();
    const candidates = Array.from({ length: 40 }, (_, index) => row(`o${index}`));
    const notice = composeOverdueNotice(candidates, { isIncomplete: false, now: NOW, maxLength: 500 })!;
    expect(notice.text.length).toBeLessThanOrEqual(500);
    expect(notice.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. Documentos
// ---------------------------------------------------------------------------------------------------

describe("T10 · buildNoticeDocs y buildRunDoc: planos y sin undefined (plan 2.8)", () => {
  it("buildNoticeDocs: un documento por pedido con id = orderId (marca de 'una vez por pedido')", async () => {
    const { buildNoticeDocs } = await load();
    const docs = buildNoticeDocs({ candidates: [row("a"), row("b", { leaderId: null, leaderName: null })], runId: "run-1", now: NOW });
    expect(docs.map((doc) => doc.id)).toEqual(["a", "b"]);
    expect(docs[0].data).toMatchObject({
      orderId: "a",
      trackingCode: "KNT-a",
      leaderId: "leader-1",
      outstandingCop: 86_000,
      ageDays: 22,
      deliveredAt: "2026-09-10T15:00:00.000Z",
      runId: "run-1",
      notifiedAt: NOW,
    });
    expect(docs[1].data.leaderId).toBeNull();
  });

  it("buildNoticeDocs: ningun undefined en profundidad aunque la fila llegue con huecos", async () => {
    const { buildNoticeDocs } = await load();
    const holes = { ...row("a"), trackingCode: undefined, leaderName: undefined, messengerName: undefined } as unknown as CashOutstandingRow;
    const docs = buildNoticeDocs({ candidates: [holes], runId: "run-1", now: NOW });
    expect(undefinedPaths(docs)).toEqual([]);
  });

  it("buildNoticeDocs: sin candidatas, sin documentos", async () => {
    const { buildNoticeDocs } = await load();
    expect(buildNoticeDocs({ candidates: [], runId: "run-1", now: NOW })).toEqual([]);
  });

  it("buildRunDoc: corrida enviada con sus pedidos, totales y estado", async () => {
    const { buildRunDoc } = await load();
    const doc = buildRunDoc({
      runId: "run-1",
      now: NOW,
      status: "sent",
      channelConfigured: true,
      isIncomplete: false,
      orderIds: ["a", "b"],
      leaderCount: 1,
      totalCop: 172_000,
      truncated: false,
    });
    expect(doc).toMatchObject({
      id: "run-1",
      createdAt: NOW,
      status: "sent",
      channelConfigured: true,
      isIncomplete: false,
      orderIds: ["a", "b"],
      orderCount: 2,
      leaderCount: 1,
      totalCop: 172_000,
      truncated: false,
    });
    expect(undefinedPaths(doc)).toEqual([]);
  });

  it("buildRunDoc: sin canal y sin error ni httpStatus, ningun undefined en profundidad", async () => {
    const { buildRunDoc } = await load();
    const doc = buildRunDoc({
      runId: "run-2",
      now: NOW,
      status: "skipped_no_channel",
      channelConfigured: false,
      isIncomplete: false,
      orderIds: [],
      leaderCount: 0,
      totalCop: 0,
      truncated: false,
      error: undefined,
      httpStatus: undefined,
    });
    expect(undefinedPaths(doc)).toEqual([]);
    expect(doc).not.toHaveProperty("error");
    expect(doc).not.toHaveProperty("httpStatus");
    expect(doc.status).toBe("skipped_no_channel");
  });

  it("buildRunDoc: un fallo de marcado (al menos una vez) conserva el error y el httpStatus", async () => {
    const { buildRunDoc } = await load();
    const doc = buildRunDoc({
      runId: "run-3",
      now: NOW,
      status: "mark_failed",
      channelConfigured: true,
      isIncomplete: false,
      orderIds: ["a"],
      leaderCount: 1,
      totalCop: 86_000,
      truncated: false,
      error: "DEADLINE_EXCEEDED",
      httpStatus: 204,
    });
    expect(doc).toMatchObject({ status: "mark_failed", error: "DEADLINE_EXCEEDED", httpStatus: 204 });
    expect(undefinedPaths(doc)).toEqual([]);
  });

  it("buildRunDoc: orderIds es una copia, no la misma referencia (documento plano)", async () => {
    const { buildRunDoc } = await load();
    const orderIds = ["a"];
    const doc = buildRunDoc({
      runId: "run-4",
      now: NOW,
      status: "send_failed",
      channelConfigured: true,
      isIncomplete: false,
      orderIds,
      leaderCount: 1,
      totalCop: 86_000,
      truncated: false,
      httpStatus: 500,
    });
    orderIds.push("b");
    expect(doc.orderIds).toEqual(["a"]);
  });
});
