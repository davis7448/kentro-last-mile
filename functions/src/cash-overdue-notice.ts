/**
 * Spec 026 · T10 — aviso de efectivo vencido (RF_05, RF_09, plan 2.4 y 2.8).
 *
 * PURO: sin firebase-admin ni fetch. Decide que pedidos se avisan, compone UN mensaje por corrida
 * agrupado por lider y construye los documentos que la funcion programada escribe:
 *  - `cashOverdueNotices/{orderId}`: marca de "una vez por pedido" (en la practica "al menos una vez":
 *    si el envio sale y el marcado cae, la corrida queda `mark_failed` y se repite).
 *  - `cashOverdueRuns/{runId}`: la corrida, para auditar.
 *
 * Las candidatas salen SOLO de `report.rows`. Los pedidos cubiertos por compensacion viven en
 * `report.nettedRows` y no se miran nunca (RF_09); si uno se colara en `rows`, su `location` lo excluye.
 * La regla de "recibido" no se repite aqui: el informe ya la aplico.
 */
import type { CashAlertSettings, CashOutstandingRow } from "./cash-outstanding";
import { stripUndefined } from "./wallet-entries";

/** Tope del texto del aviso, en caracteres. */
export const NOTICE_MAX_LENGTH = 2_000;

export type NoticeReportInput = {
  rows: readonly CashOutstandingRow[];
  settings: Pick<CashAlertSettings, "notifyMinCop">;
};

export type OverdueNoticeGroup = {
  leaderId: string | null;
  leaderName: string | null;
  orderCount: number;
  outstandingCop: number;
  orderIds: string[];
};

export type OverdueNotice = {
  text: string;
  truncated: boolean;
  orderCount: number;
  totalCop: number;
  groups: OverdueNoticeGroup[];
};

export type ComposeNoticeOptions = {
  isIncomplete: boolean;
  now: string;
  maxLength?: number;
};

export type CashOverdueNoticeDoc = {
  id: string;
  data: {
    orderId: string;
    trackingCode: string;
    sellerId: string | null;
    leaderId: string | null;
    messengerId: string | null;
    outstandingCop: number;
    ageDays: number;
    deliveredAt: string;
    runId: string;
    notifiedAt: string;
  };
};

export type CashOverdueRunStatus = "sent" | "skipped_no_channel" | "nothing_to_send" | "send_failed" | "mark_failed";

export type BuildRunDocInput = {
  runId: string;
  now: string;
  status: CashOverdueRunStatus;
  channelConfigured: boolean;
  isIncomplete: boolean;
  orderIds: readonly string[];
  leaderCount: number;
  totalCop: number;
  truncated: boolean;
  error?: string;
  httpStatus?: number;
};

export type CashOverdueRunDoc = {
  id: string;
  createdAt: string;
  status: CashOverdueRunStatus;
  channelConfigured: boolean;
  isIncomplete: boolean;
  orderIds: string[];
  orderCount: number;
  leaderCount: number;
  totalCop: number;
  truncated: boolean;
  error?: string;
  httpStatus?: number;
};

// ---------------------------------------------------------------------------------------------------
// Candidatas
// ---------------------------------------------------------------------------------------------------

/**
 * Vencida, con efectivo pendiente (> 0 y >= umbral, inclusivo), no cubierta por compensacion y sin
 * aviso previo. Lo mas viejo primero.
 */
export function selectNoticeCandidates(
  report: NoticeReportInput,
  notifiedOrderIds: ReadonlySet<string> | readonly string[],
): CashOutstandingRow[] {
  const notified = notifiedOrderIds instanceof Set ? notifiedOrderIds : new Set(notifiedOrderIds as readonly string[]);
  const minCop = report.settings.notifyMinCop;
  return report.rows
    .filter(
      (row) =>
        row.isOverdue &&
        row.location !== "covered_by_netting" &&
        row.outstandingCop > 0 &&
        row.outstandingCop >= minCop &&
        !notified.has(row.orderId),
    )
    .slice()
    .sort((left, right) => left.deliveredAt.localeCompare(right.deliveredAt) || left.orderId.localeCompare(right.orderId));
}

// ---------------------------------------------------------------------------------------------------
// Mensaje
// ---------------------------------------------------------------------------------------------------

function formatCop(amount: number): string {
  return `$${amount.toLocaleString("es-CO")}`;
}

function pluralOrders(count: number): string {
  return count === 1 ? "1 pedido" : `${count} pedidos`;
}

function groupByLeader(candidates: readonly CashOutstandingRow[]): OverdueNoticeGroup[] {
  const byKey = new Map<string, OverdueNoticeGroup>();
  for (const row of candidates) {
    const leaderId = row.leaderId ?? null;
    const key = leaderId ?? "\u0000sin-lider";
    let group = byKey.get(key);
    if (!group) {
      group = { leaderId, leaderName: leaderId === null ? null : (row.leaderName ?? null), orderCount: 0, outstandingCop: 0, orderIds: [] };
      byKey.set(key, group);
    }
    group.orderCount += 1;
    group.outstandingCop += row.outstandingCop;
    group.orderIds.push(row.orderId);
  }
  return [...byKey.values()].sort(
    (left, right) => right.outstandingCop - left.outstandingCop || (left.leaderId ?? "").localeCompare(right.leaderId ?? ""),
  );
}

function groupHeader(group: OverdueNoticeGroup): string {
  const summary = `${pluralOrders(group.orderCount)}, ${formatCop(group.outstandingCop)}`;
  if (group.leaderId === null) return `Sin lider (no hay a quien cobrarle): ${summary}`;
  return `${group.leaderName ?? group.leaderId}: ${summary}`;
}

/**
 * Solo guia, antiguedad e importe: nada de lo que traiga la fila del cliente (nombre, telefono,
 * direccion) llega al texto.
 */
function orderLine(row: CashOutstandingRow): string {
  return `- ${row.trackingCode || row.orderId} · ${row.ageDays} dias · ${formatCop(row.outstandingCop)}`;
}

/**
 * Un mensaje por corrida. La cabecera (conteo y total de TODAS las candidatas, y "cifras incompletas")
 * se escribe siempre; el detalle por lider se recorta si no cabe en `maxLength`.
 */
export function composeOverdueNotice(candidates: readonly CashOutstandingRow[], options: ComposeNoticeOptions): OverdueNotice | null {
  if (candidates.length === 0) return null;
  const maxLength = options.maxLength ?? NOTICE_MAX_LENGTH;
  const groups = groupByLeader(candidates);
  const orderCount = candidates.length;
  const totalCop = candidates.reduce((sum, row) => sum + row.outstandingCop, 0);
  const rowsById = new Map(candidates.map((row) => [row.orderId, row]));

  const headerLines = [
    `Efectivo vencido sin entregar (${options.now.slice(0, 10)})`,
    `${pluralOrders(orderCount)} · total ${formatCop(totalCop)} · ${groups.length === 1 ? "1 lider" : `${groups.length} lideres`}`,
  ];
  if (options.isIncomplete) headerLines.push("Atencion: cifras incompletas (hubo documentos que no se pudieron leer).");

  const detailLines: Array<{ text: string; isOrder: boolean }> = [];
  for (const group of groups) {
    detailLines.push({ text: "", isOrder: false });
    detailLines.push({ text: groupHeader(group), isOrder: false });
    for (const orderId of group.orderIds) {
      const row = rowsById.get(orderId);
      if (row) detailLines.push({ text: orderLine(row), isOrder: true });
    }
  }

  const header = headerLines.join("\n");
  const fullText = [header, ...detailLines.map((line) => line.text)].join("\n");
  if (fullText.length <= maxLength) {
    return { text: fullText, truncated: false, orderCount, totalCop, groups };
  }

  // Recorte: se reserva sitio para la linea final que dice cuantos pedidos quedaron fuera.
  const trailer = (omitted: number) => `\n... y ${pluralOrders(omitted)} mas sin detallar (incluidos en el total).`;
  const reserve = trailer(orderCount).length;
  let text = header;
  let shownOrders = 0;
  for (const line of detailLines) {
    const candidateText = `${text}\n${line.text}`;
    if (candidateText.length + reserve > maxLength) break;
    text = candidateText;
    if (line.isOrder) shownOrders += 1;
  }
  text = `${text.replace(/\n+$/, "")}${trailer(orderCount - shownOrders)}`;
  if (text.length > maxLength) text = text.slice(0, maxLength);
  return { text, truncated: true, orderCount, totalCop, groups };
}

// ---------------------------------------------------------------------------------------------------
// Documentos (plan 2.8: planos y sin undefined)
// ---------------------------------------------------------------------------------------------------

export function buildNoticeDocs(input: { candidates: readonly CashOutstandingRow[]; runId: string; now: string }): CashOverdueNoticeDoc[] {
  return input.candidates.map((row) => ({
    id: row.orderId,
    data: stripUndefined({
      orderId: row.orderId,
      trackingCode: row.trackingCode ?? "",
      sellerId: row.sellerId ?? null,
      leaderId: row.leaderId ?? null,
      messengerId: row.messengerId ?? null,
      outstandingCop: row.outstandingCop,
      ageDays: row.ageDays,
      deliveredAt: row.deliveredAt ?? "",
      runId: input.runId,
      notifiedAt: input.now,
    }),
  }));
}

export function buildRunDoc(input: BuildRunDocInput): CashOverdueRunDoc {
  return stripUndefined({
    id: input.runId,
    createdAt: input.now,
    status: input.status,
    channelConfigured: input.channelConfigured,
    isIncomplete: input.isIncomplete,
    orderIds: [...input.orderIds],
    orderCount: input.orderIds.length,
    leaderCount: input.leaderCount,
    totalCop: input.totalCop,
    truncated: input.truncated,
    error: input.error,
    httpStatus: input.httpStatus,
  });
}
