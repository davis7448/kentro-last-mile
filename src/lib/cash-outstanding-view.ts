/**
 * Spec 026 — modelo de vista de "Efectivo sin llegar" (plan 4.1 "Rotulos"; README decisiones 2-12).
 *
 * PURO: recibe el informe que devuelve `getCashOutstanding` y decide lo que se pinta (rotulos, grupos,
 * plegado, paginas, cuadre, tarjeta de Operacion, cifras incompletas y linea de proveedor). No lee
 * Firestore ni recalcula importes: cada cifra sale del informe, que ya aplico la regla de "recibido" de
 * la liquidacion de tienda en el servidor. Aqui solo se filtra por lider y se suma lo filtrado.
 */
import type {
  CashOutstandingGroup,
  CashOutstandingReport,
  CashOutstandingRow,
  CashRowSettlement,
  PositionReconciliation,
} from "../../functions/src/cash-outstanding";
import { formatCop } from "./finance";

export type CashViewRole = "admin" | "leader";
export type CashViewport = "mobile" | "desktop";

/** Valor de `leaderFilter` que elige el grupo "Sin lider" (un id real nunca empieza por "__"). */
export const NO_LEADER_FILTER = "__no_leader__";

const PAGE_SIZE: Record<CashViewport, number> = { mobile: 6, desktop: 25 };

const NO_LEADER_TITLE = "Sin lider";
const NO_LEADER_NOTE = "no hay a quien cobrarle";
const NO_OVERDUE_NOTE = "sin vencidos";
const NETTED_TITLE = "Cubiertos por compensacion";
const INCOMPLETE_TITLE = "Cifras incompletas";

export interface CashOutstandingViewOptions {
  viewport: CashViewport;
  role: CashViewRole;
  /** `null`/ausente = todos; `NO_LEADER_FILTER` = el grupo "Sin lider". Filtra en el navegador. */
  leaderFilter?: string | null;
}

export interface CashOutstandingViewRow extends CashOutstandingRow {
  locationLabel: string;
  /** La fecha de entrega salio de `updatedAt`: se marca "aprox." (README decision 6). */
  deliveredAtApprox: boolean;
  /** "20 sep" o "20 sep aprox.", en hora de Bogota. */
  deliveredLabel: string;
}

export interface CashOutstandingViewGroup {
  leaderId: string | null;
  title: string;
  /** "no hay a quien cobrarle" (Sin lider), "sin vencidos" o null. */
  note: string | null;
  expanded: boolean;
  orderCount: number;
  collectedCop: number;
  outstandingCop: number;
  overdueCount: number;
  /** NETO vencido (como lo da el servidor). */
  overdueCop: number;
  /** BRUTO vencido: lo que se pinta al admin (spec 026 seccion 9 P1) y la clave de orden de los grupos. */
  overdueCollectedCop: number;
  pageSize: number;
  visibleRows: CashOutstandingViewRow[];
  remainingCount: number;
}

export interface CashOutstandingViewNetted {
  title: string;
  expanded: boolean;
  count: number;
  collectedCop: number;
  settlementCount: number;
  pageSize: number;
  visibleRows: CashOutstandingViewRow[];
  remainingCount: number;
}

export interface CashOutstandingViewSummary {
  orderCount: number;
  collectedCop: number;
  outstandingCop: number;
  overdueCount: number;
  overdueCop: number;
  outsideSettlementCop: number;
  inOpenSettlementCop: number;
  paidShortCop: number;
  /** Abierto + pagado con faltante: "en un corte sin cubrir" (README decision 5). */
  inUnsettledSettlementCop: number;
  nettedCount: number;
}

export interface CashOutstandingCardLeader {
  leaderId: string | null;
  leaderName: string;
  overdueCop: number;
  overdueCount: number;
  /** "Carolina Mesa, $388.471 en 6 pedidos". */
  text: string;
}

export interface CashOutstandingCard {
  overdueCop: number;
  overdueCount: number;
  oldestOverdueDays: number | null;
  topLeader: CashOutstandingCardLeader | null;
  nettedCount: number;
  /** "No cuenta N cubiertos por compensacion", o null sin compensados. */
  nettedText: string | null;
  isAllClear: boolean;
  /** "Efectivo vencido: $0 · al dia" con vencido $0; null en otro caso. */
  allClearText: string | null;
}

export interface CashOutstandingIncomplete {
  title: string;
  text: string;
  /** Tipo e id de cada documento ilegible; vacio para el lider. */
  documents: Array<{ kind: "pedido" | "corte" | "asiento"; id: string }>;
  /** Un corte ilegible puede dejar en la lista pedidos ya cubiertos: se advierte aparte. */
  settlementWarning: boolean;
}

export interface CashOutstandingView {
  card: CashOutstandingCard;
  summary: CashOutstandingViewSummary;
  groups: CashOutstandingViewGroup[];
  netted: CashOutstandingViewNetted | null;
  /** Solo admin, con la carga con conciliacion y sin filtro de lider (README decision 3). */
  reconciliation: PositionReconciliation | null;
  incomplete: CashOutstandingIncomplete | null;
}

// ---------------------------------------------------------------------------------------------------
// Fechas: "<dia> <mes>" en hora de Bogota (UTC-5 todo el ano, sin horario de verano).
// ---------------------------------------------------------------------------------------------------

// Mapa propio: `toLocaleDateString("es-CO")` cambia entre motores ("sept.", "sep.", con punto o sin el).
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

export function formatBogotaDay(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const bogota = new Date(time - BOGOTA_OFFSET_MS);
  return `${bogota.getUTCDate()} ${MONTHS[bogota.getUTCMonth()]}`;
}

function mostRecent(settlements: CashRowSettlement[], accept: (item: CashRowSettlement) => boolean): CashRowSettlement | null {
  let best: CashRowSettlement | null = null;
  for (const item of settlements) {
    if (!accept(item)) continue;
    if (!best || item.createdAt > best.createdAt) best = item;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// Rotulos (plan 4.1)
// ---------------------------------------------------------------------------------------------------

export function cashLocationLabel(row: CashOutstandingRow, role: CashViewRole): string {
  if (role === "admin") {
    switch (row.location) {
      case "outside_settlement":
        return "Fuera de todo corte";
      case "in_settlement_open":
        return "En corte abierto";
      case "settlement_paid_short":
        return "Pagado con faltante";
      case "covered_by_netting":
        return "Cubierto por compensacion";
    }
  }
  switch (row.location) {
    case "outside_settlement":
      return "No esta en ningun corte";
    case "in_settlement_open": {
      const open = mostRecent(row.settlements, (item) => item.status === "pending");
      return open ? `En el corte del ${formatBogotaDay(open.createdAt)}, abierto` : "En un corte abierto";
    }
    case "settlement_paid_short": {
      const latest = mostRecent(row.settlements, () => true);
      return latest ? `Corte del ${formatBogotaDay(latest.createdAt)} pagado con faltante` : "Corte pagado con faltante";
    }
    case "covered_by_netting": {
      const settled = mostRecent(row.settlements, (item) => item.cashSettled);
      return settled ? `Cubierto en el corte del ${formatBogotaDay(settled.createdAt)}` : "Cubierto en un corte saldado";
    }
  }
}

function toViewRow(row: CashOutstandingRow, role: CashViewRole): CashOutstandingViewRow {
  const deliveredAtApprox = row.deliveredAtSource === "updatedAt";
  const day = formatBogotaDay(row.deliveredAt);
  return {
    ...row,
    locationLabel: cashLocationLabel(row, role),
    deliveredAtApprox,
    deliveredLabel: deliveredAtApprox ? `${day} aprox.` : day,
  };
}

// ---------------------------------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------------------------------

function sumOf(rows: CashOutstandingRow[], pick: (row: CashOutstandingRow) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function byDeliveredAt(a: CashOutstandingRow, b: CashOutstandingRow): number {
  return a.deliveredAt < b.deliveredAt ? -1 : a.deliveredAt > b.deliveredAt ? 1 : 0;
}

function matchesLeader(leaderId: string | null, filter: string | null): boolean {
  if (filter === null) return true;
  if (filter === NO_LEADER_FILTER) return leaderId === null;
  return leaderId === filter;
}

function pluralOrders(count: number): string {
  return count === 1 ? "1 pedido" : `${count} pedidos`;
}

function paginate(rows: CashOutstandingRow[], pageSize: number, role: CashViewRole) {
  const sorted = [...rows].sort(byDeliveredAt);
  return {
    pageSize,
    visibleRows: sorted.slice(0, pageSize).map((row) => toViewRow(row, role)),
    remainingCount: Math.max(0, sorted.length - pageSize),
  };
}

function compareLeaderIds(left: string | null, right: string | null): number {
  const leftKey = left ?? "";
  const rightKey = right ?? "";
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Orden de la vista: vencido BRUTO desc, luego recaudo desc, luego id ("Sin lider" como cadena vacia).
 * El servidor ordena `byLeader` por el NETO; la vista pinta el bruto (seccion 9 P1), asi que reordena
 * aqui para que el lider de la tarjeta y el primer grupo desplegado sean el de mayor cifra pintada
 * (R1-RF_03-1).
 */
function byOverdueCollected(groups: CashOutstandingGroup[]): CashOutstandingGroup[] {
  return [...groups].sort(
    (left, right) =>
      right.overdueCollectedCop - left.overdueCollectedCop ||
      right.collectedCop - left.collectedCop ||
      compareLeaderIds(left.leaderId, right.leaderId)
  );
}

function buildCard(report: CashOutstandingReport): CashOutstandingCard {
  // La tarjeta no depende del filtro: siempre la flota entera, y nunca los compensados (no estan en `rows`).
  const overdueRows = report.rows.filter((row) => row.isOverdue);
  const overdueCop = sumOf(overdueRows, (row) => row.collectedCop);
  const overdueCount = overdueRows.length;
  const isAllClear = overdueCop <= 0;
  const first: CashOutstandingGroup | undefined = byOverdueCollected(report.byLeader)[0];
  const firstName = first ? (first.leaderId === null ? NO_LEADER_TITLE : (first.leaderName ?? first.leaderId)) : "";
  const topLeader: CashOutstandingCardLeader | null =
    !isAllClear && first && first.overdueCollectedCop > 0
      ? {
          leaderId: first.leaderId,
          leaderName: firstName,
          // Bruto, igual que el total de la tarjeta: las dos cifras se leen juntas.
          overdueCop: first.overdueCollectedCop,
          overdueCount: first.overdueCount,
          text: `${firstName}, ${formatCop(first.overdueCollectedCop)} en ${pluralOrders(first.overdueCount)}`,
        }
      : null;
  const nettedCount = report.nettedRows.length;
  return {
    overdueCop,
    overdueCount,
    oldestOverdueDays: overdueRows.length > 0 ? Math.max(...overdueRows.map((row) => row.ageDays)) : null,
    topLeader,
    nettedCount,
    nettedText: nettedCount > 0 ? `No cuenta ${nettedCount} cubiertos por compensacion` : null,
    isAllClear,
    allClearText: isAllClear ? `Efectivo vencido: ${formatCop(0)} · al dia` : null,
  };
}

function buildSummary(rows: CashOutstandingRow[], nettedCount: number): CashOutstandingViewSummary {
  const overdue = rows.filter((row) => row.isOverdue);
  const inOpenSettlementCop = sumOf(rows.filter((row) => row.location === "in_settlement_open"), (row) => row.collectedCop);
  const paidShortCop = sumOf(rows.filter((row) => row.location === "settlement_paid_short"), (row) => row.collectedCop);
  return {
    orderCount: rows.length,
    collectedCop: sumOf(rows, (row) => row.collectedCop),
    outstandingCop: sumOf(rows, (row) => row.outstandingCop),
    overdueCount: overdue.length,
    overdueCop: sumOf(overdue, (row) => row.collectedCop),
    outsideSettlementCop: sumOf(rows.filter((row) => row.location === "outside_settlement"), (row) => row.collectedCop),
    inOpenSettlementCop,
    paidShortCop,
    inUnsettledSettlementCop: inOpenSettlementCop + paidShortCop,
    nettedCount,
  };
}

function buildGroups(report: CashOutstandingReport, rows: CashOutstandingRow[], options: { role: CashViewRole; pageSize: number }): CashOutstandingViewGroup[] {
  const rowsByLeader = new Map<string | null, CashOutstandingRow[]>();
  for (const row of rows) {
    const list = rowsByLeader.get(row.leaderId) ?? [];
    list.push(row);
    rowsByLeader.set(row.leaderId, list);
  }
  let expandedTaken = false;
  // Orden por vencido BRUTO (`byOverdueCollected`), no el del informe; los grupos sin filas tras el
  // filtro desaparecen. Solo el primero con vencidos, en este orden, va desplegado.
  return byOverdueCollected(report.byLeader)
    .filter((group) => rowsByLeader.has(group.leaderId))
    .map((group) => {
      const groupRows = rowsByLeader.get(group.leaderId) ?? [];
      const isFirstWithOverdue = !expandedTaken && group.overdueCollectedCop > 0;
      if (isFirstWithOverdue) expandedTaken = true;
      const isNoLeader = group.leaderId === null;
      return {
        leaderId: group.leaderId,
        title: isNoLeader ? NO_LEADER_TITLE : (group.leaderName ?? group.leaderId ?? NO_LEADER_TITLE),
        note: isNoLeader ? NO_LEADER_NOTE : group.overdueCount === 0 ? NO_OVERDUE_NOTE : null,
        expanded: isFirstWithOverdue,
        orderCount: group.orderCount,
        collectedCop: group.collectedCop,
        outstandingCop: group.outstandingCop,
        overdueCount: group.overdueCount,
        overdueCop: group.overdueCop,
        overdueCollectedCop: group.overdueCollectedCop,
        ...paginate(groupRows, options.pageSize, options.role),
      };
    });
}

function buildNetted(rows: CashOutstandingRow[], options: { role: CashViewRole; pageSize: number }): CashOutstandingViewNetted | null {
  if (rows.length === 0) return null;
  const settlementIds = new Set(rows.map((row) => row.attributedSettlementId).filter((id): id is string => id !== null));
  return {
    title: NETTED_TITLE,
    expanded: false,
    count: rows.length,
    collectedCop: sumOf(rows, (row) => row.collectedCop),
    settlementCount: settlementIds.size,
    ...paginate(rows, options.pageSize, options.role),
  };
}

function buildIncomplete(report: CashOutstandingReport, role: CashViewRole): CashOutstandingIncomplete | null {
  const hasUnreadable =
    report.unreadableOrderIds.length > 0 || report.unreadableSettlementIds.length > 0 || report.unreadableEntryIds.length > 0;
  if (!report.isIncomplete && !hasUnreadable) return null;
  if (role === "leader") {
    return {
      title: INCOMPLETE_TITLE,
      text: "Hay datos que no se pudieron leer; el total puede no estar completo. Avisa al administrador.",
      documents: [],
      settlementWarning: false,
    };
  }
  const settlementWarning = report.unreadableSettlementIds.length > 0;
  return {
    title: INCOMPLETE_TITLE,
    text: settlementWarning
      ? "Hay documentos que no se pudieron leer; el total puede no estar completo. Un corte ilegible puede dejar en la lista pedidos que ya estan cubiertos."
      : "Hay documentos que no se pudieron leer; el total puede no estar completo.",
    documents: [
      ...report.unreadableOrderIds.map((id) => ({ kind: "pedido" as const, id })),
      ...report.unreadableSettlementIds.map((id) => ({ kind: "corte" as const, id })),
      ...report.unreadableEntryIds.map((id) => ({ kind: "asiento" as const, id })),
    ],
    settlementWarning,
  };
}

export function buildCashOutstandingView(report: CashOutstandingReport, options: CashOutstandingViewOptions): CashOutstandingView {
  const { viewport, role } = options;
  const filter = options.leaderFilter ?? null;
  const pageSize = PAGE_SIZE[viewport];
  const rows = report.rows.filter((row) => matchesLeader(row.leaderId, filter));
  const nettedRows = report.nettedRows.filter((row) => matchesLeader(row.leaderId, filter));

  return {
    card: buildCard(report),
    summary: buildSummary(rows, nettedRows.length),
    groups: buildGroups(report, rows, { role, pageSize }),
    netted: buildNetted(nettedRows, { role, pageSize }),
    // El cuadre compara la lista ENTERA con la posicion: con un lider elegido no cuadraria nada.
    reconciliation: role === "admin" && filter === null ? report.reconciliation : null,
    incomplete: buildIncomplete(report, role),
  };
}

// ---------------------------------------------------------------------------------------------------
// Proveedor (RF_08, README decision 8)
// ---------------------------------------------------------------------------------------------------

export function supplierPendingLine(report: CashOutstandingReport, supplierId: string): { amountCop: number; text: string } | null {
  const supplier = report.bySupplier.find((item) => item.supplierId === supplierId);
  if (!supplier || supplier.amountCop <= 0) return null;
  return {
    amountCop: supplier.amountCop,
    text: `No se puede pagar todavia: ${formatCop(supplier.amountCop)} (efectivo sin llegar)`,
  };
}
