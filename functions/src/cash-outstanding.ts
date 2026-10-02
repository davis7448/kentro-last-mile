/**
 * Spec 026 — "efectivo que no llega a un corte": nucleo PURO del informe (plan 4.1, 4.2).
 *
 * Lista los pedidos entregados en efectivo cuyo recaudo la liquidacion de tienda todavia no da por
 * recibido de la flota, con cuanto falta por cada uno. Sin Firestore: el cargador (T12) le pasa los
 * pedidos, los cortes de domiciliario y los asientos ya leidos y validados.
 *
 * RF_01: la regla de "recibido" NO se reescribe aqui. Se importa `buildCodReceivedSet` (y
 * `codPartialReceivedCop`, que se apoya en ella) de `./seller-ledger`; este archivo no lee la materia
 * prima de esa regla, y la guarda anti-copia de `spec-026-guards.test.ts` lo vigila. El saldado de un
 * corte lo decide `isDriverSettlementCashSettled` (plan 2.9), no una comparacion de estado.
 *
 * Construido por tareas (plan 5.2):
 *   - T6: pertenencia a la lista, importes, `isIncomplete` y `unreadable*`.
 *   - T7: fecha de entrega, antiguedad, ubicacion, nombres y reparto `rows` / `nettedRows`.
 *   - T8: agrupaciones, totales y retenido por proveedor.
 *   - T9: conciliacion con la posicion de plataforma.
 * Mientras una tarea no llega, sus campos salen con valores neutros (vacios / cero / null).
 */
import { isReceivableCodEntry, isReceivableDriverPay } from "./driver-receivable";
import type { CashAlertSettings } from "./cash-outstanding-schemas";
import { buildCodReceivedSet, codPartialReceivedCop } from "./seller-ledger";
import { isDriverSettlementCashSettled } from "./settlement-math";
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";

export type { CashAlertSettings } from "./cash-outstanding-schemas";

// ---------------------------------------------------------------------------------------------------
// Tipos (plan 4.1)
// ---------------------------------------------------------------------------------------------------

export type CashSettlementLocation =
  | "outside_settlement"
  | "in_settlement_open"
  | "settlement_paid_short"
  | "covered_by_netting"; // RF_09: corte cerrado y saldado en total (plan 2.9)

export type DeliveredAtSource = "closedAt" | "evidence" | "cod_entry" | "updatedAt";

export type CashOutstandingOrder = {
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

export type CashOutstandingScope = { kind: "admin"; includeReconciliation: boolean } | { kind: "leader"; driverId: string };

export type CashOutstandingInput = {
  orders: CashOutstandingOrder[];
  /** Cortes `kind: "driver"`; `cashPendingCop` puede faltar (= 0). */
  settlements: SettlementDoc[];
  receivableEntries: WalletEntryDoc[];
  /** `full`: todos los asientos por cobrar; `targeted`: solo los de pedidos no recibidos (plan 4.3). */
  coverage: "full" | "targeted";
  productCostEntries: WalletEntryDoc[];
  names: { sellers: Map<string, string>; leaders: Map<string, string>; messengers: Map<string, string> };
  settings: CashAlertSettings;
  settingsInvalid: boolean;
  channelConfigured: boolean | null;
  scope: CashOutstandingScope;
  now: string;
  unreadableOrderIds: string[];
  unreadableSettlementIds: string[];
  unreadableEntryIds: string[];
};

export type SupplierWithheld = { supplierId: string; supplierName: string; amountCop: number };

export type CashRowSettlement = {
  id: string;
  status: "pending" | "paid" | "reconciled";
  createdAt: string;
  cashSettled: boolean;
};

export type CashOutstandingRow = {
  orderId: string;
  trackingCode: string;
  sellerId: string;
  sellerName: string;
  leaderId: string | null;
  leaderName: string | null;
  messengerId: string | null;
  messengerName: string | null;
  deliveredAt: string;
  deliveredAtSource: DeliveredAtSource;
  ageDays: number;
  /** Falso si `covered_by_netting`. */
  isOverdue: boolean;
  collectedCop: number;
  collectedSource: "wallet" | "order_total";
  driverPayCop: number;
  expectedCashCop: number;
  receivedCop: number;
  outstandingCop: number;
  location: CashSettlementLocation;
  /** Cortes de domiciliario que contienen al pedido, `createdAt` desc. */
  settlements: CashRowSettlement[];
  attributedSettlementId: string | null;
  supplierWithheld: SupplierWithheld[];
};

export type CashOutstandingGroup = {
  /** null = "Sin lider". */
  leaderId: string | null;
  leaderName: string | null;
  orderCount: number;
  collectedCop: number;
  outstandingCop: number;
  overdueCount: number;
  overdueCop: number;
  oldestDeliveredAt: string;
};

export type ReconciliationCause =
  | "outside_orders_outside_universe"
  | "outside_unreadable_orders"
  | "outside_order_total_without_cod"
  | "outside_negative_net"
  | "outside_aggregate_clamp"
  | "settlement_cash_pending_stale"
  | "settlement_cash_pending_missing"
  | "settlement_orders_received"
  | "settlement_orders_covered_by_netting"
  | "settlement_orders_outside_universe"
  | "settlement_unreadable_orders"
  | "settlement_orders_attributed_elsewhere"
  | "settlement_order_total_without_cod"
  | "settlement_negative_net"
  | "settlement_expected_clamp"
  | "settlement_excess_received"
  | "settlement_cash_received"
  | "settlement_allocation_over_expected";

export type PositionReconciliation = {
  driverReceivableCop: number;
  listOutstandingCop: number;
  deltaCop: number;
  causes: Array<{ cause: ReconciliationCause; amountCop: number; orderIds: string[]; settlementId?: string }>;
  staleSettlementsCop: number;
  missingPendingSettlementsCop: number;
  /** deltaCop − Σ causes (todas, incluidas stale y missing). */
  unexplainedCop: number;
  unexplainedOrderIds: string[];
};

export type CashOutstandingTotals = {
  orderCount: number;
  collectedCop: number;
  outstandingCop: number;
  outsideSettlementCop: number;
  inOpenSettlementCop: number;
  paidShortCop: number;
  overdueCount: number;
  overdueCop: number;
  nettedCount: number;
  nettedCollectedCop: number;
  nettedSettlementCount: number;
};

export type CashOutstandingReport = {
  generatedAt: string;
  mode: "summary" | "with_reconciliation";
  settings: CashAlertSettings;
  settingsInvalid: boolean;
  channelConfigured: boolean | null;
  /** Efectivo que falta; `deliveredAt` asc. */
  rows: CashOutstandingRow[];
  /** RF_09, aparte; `deliveredAt` asc. */
  nettedRows: CashOutstandingRow[];
  /** Solo `rows`; orden `overdueCop` desc (empate: `outstandingCop`, id). */
  byLeader: CashOutstandingGroup[];
  /** Solo `rows`; `[]` para el lider. */
  bySupplier: Array<SupplierWithheld & { overdueAmountCop: number }>;
  totals: CashOutstandingTotals;
  reconciliation: PositionReconciliation | null;
  isIncomplete: boolean;
  unreadableOrderIds: string[];
  unreadableSettlementIds: string[];
  unreadableEntryIds: string[];
};

// ---------------------------------------------------------------------------------------------------
// Pertenencia (plan 4.2 paso 2)
// ---------------------------------------------------------------------------------------------------

const CASH_DELIVERED_STATUSES = new Set(["delivered", "liquidated"]);

function isInScope(order: CashOutstandingOrder, scope: CashOutstandingScope): boolean {
  return scope.kind === "admin" || order.driverId === scope.driverId;
}

/**
 * Filtro propio de la lista: efectivo, entregado o liquidado, dentro del alcance y no recibido segun
 * LA regla de la liquidacion de tienda. Sin ventana de fecha (RF_07): un pedido de junio cuenta igual.
 */
function isListedCandidate(order: CashOutstandingOrder, scope: CashOutstandingScope, received: Set<string>): boolean {
  return (
    order.paymentMethod === "cod" &&
    CASH_DELIVERED_STATUSES.has(order.status) &&
    isInScope(order, scope) &&
    !received.has(order.id)
  );
}

// ---------------------------------------------------------------------------------------------------
// Importes (plan 4.2 paso 3)
// ---------------------------------------------------------------------------------------------------

type OrderAmounts = { codCop: number; hasCodEntry: boolean; driverPayCop: number };

/** Recaudo y pago por pedido. Math.round por asiento, como la posicion de plataforma. */
function amountsByOrder(entries: WalletEntryDoc[]): Map<string, OrderAmounts> {
  const byOrder = new Map<string, OrderAmounts>();
  const slot = (orderId: string): OrderAmounts => {
    let current = byOrder.get(orderId);
    if (!current) {
      current = { codCop: 0, hasCodEntry: false, driverPayCop: 0 };
      byOrder.set(orderId, current);
    }
    return current;
  };
  for (const entry of entries) {
    if (!entry.orderId) continue;
    if (isReceivableCodEntry(entry)) {
      const current = slot(entry.orderId);
      current.codCop += Math.round(entry.amountCop);
      current.hasCodEntry = true;
    } else if (isReceivableDriverPay(entry)) {
      slot(entry.orderId).driverPayCop += Math.round(entry.amountCop);
    }
  }
  return byOrder;
}

/** Cortes de domiciliario que contienen cada pedido, con su saldado (plan 2.9), `createdAt` desc. */
function settlementsByOrder(settlements: SettlementDoc[]): Map<string, CashRowSettlement[]> {
  const byOrder = new Map<string, CashRowSettlement[]>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver") continue;
    const summary: CashRowSettlement = {
      id: settlement.id,
      status: settlement.status,
      createdAt: settlement.createdAt,
      cashSettled: isDriverSettlementCashSettled(settlement)
    };
    for (const orderId of settlement.orderIds ?? []) {
      const list = byOrder.get(orderId) ?? [];
      list.push(summary);
      byOrder.set(orderId, list);
    }
  }
  for (const list of byOrder.values()) {
    list.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
  }
  return byOrder;
}

// ---------------------------------------------------------------------------------------------------
// Fecha de entrega, antiguedad y ubicacion (plan 2.3, 2.9, 4.2 paso 4)
// ---------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Fecha del asiento `cod_revenue` de tienda MAS ANTIGUO por pedido (fuente `cod_entry`). */
function oldestCodRevenueAt(entries: WalletEntryDoc[]): Map<string, string> {
  const byOrder = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.orderId || entry.ownerType !== "seller" || entry.type !== "cod_revenue" || !entry.createdAt) continue;
    const current = byOrder.get(entry.orderId);
    if (current === undefined || entry.createdAt < current) byOrder.set(entry.orderId, entry.createdAt);
  }
  return byOrder;
}

/** Plan 2.3: closedAt → ultima evidencia `delivery` → `cod_revenue` mas antiguo → updatedAt. */
function resolveDeliveredAt(
  order: CashOutstandingOrder,
  codRevenueAt: Map<string, string>
): { deliveredAt: string; deliveredAtSource: DeliveredAtSource } {
  if (order.closedAt) return { deliveredAt: order.closedAt, deliveredAtSource: "closedAt" };
  let latestDelivery: string | undefined;
  for (const item of order.evidence) {
    if (item.type !== "delivery" || !item.createdAt) continue;
    if (latestDelivery === undefined || item.createdAt > latestDelivery) latestDelivery = item.createdAt;
  }
  if (latestDelivery !== undefined) return { deliveredAt: latestDelivery, deliveredAtSource: "evidence" };
  const codAt = codRevenueAt.get(order.id);
  if (codAt !== undefined) return { deliveredAt: codAt, deliveredAtSource: "cod_entry" };
  return { deliveredAt: order.updatedAt ?? "", deliveredAtSource: "updatedAt" };
}

function ageInDays(now: string, deliveredAt: string): number {
  const elapsed = Date.parse(now) - Date.parse(deliveredAt);
  return Number.isFinite(elapsed) ? Math.floor(elapsed / DAY_MS) : 0;
}

/**
 * Plan 2.9: un corte abierto manda; si no, uno saldado en total (compensacion); si no, uno cerrado
 * con faltante. Los cortes llegan validados como pending|paid|reconciled, asi que "cerrado" es
 * "no pending", y el saldado lo decide `isDriverSettlementCashSettled` (ya volcado en `cashSettled`).
 * `settlements` viene `createdAt` desc: el primero de la clase ganadora es el mas reciente.
 */
function resolveLocation(settlements: CashRowSettlement[]): {
  location: CashSettlementLocation;
  attributedSettlementId: string | null;
} {
  const open = settlements.find((item) => item.status === "pending");
  if (open) return { location: "in_settlement_open", attributedSettlementId: open.id };
  const netted = settlements.find((item) => item.cashSettled);
  if (netted) return { location: "covered_by_netting", attributedSettlementId: netted.id };
  const closedShort = settlements[0];
  if (closedShort) return { location: "settlement_paid_short", attributedSettlementId: closedShort.id };
  return { location: "outside_settlement", attributedSettlementId: null };
}

function nameOf(names: Map<string, string>, id: string | null): string | null {
  return id === null ? null : names.get(id) ?? null;
}

function byDeliveredAtAsc(left: CashOutstandingRow, right: CashOutstandingRow): number {
  if (left.deliveredAt !== right.deliveredAt) return left.deliveredAt < right.deliveredAt ? -1 : 1;
  return left.orderId < right.orderId ? -1 : left.orderId > right.orderId ? 1 : 0;
}

function emptyTotals(): CashOutstandingTotals {
  return {
    orderCount: 0,
    collectedCop: 0,
    outstandingCop: 0,
    outsideSettlementCop: 0,
    inOpenSettlementCop: 0,
    paidShortCop: 0,
    overdueCount: 0,
    overdueCop: 0,
    nettedCount: 0,
    nettedCollectedCop: 0,
    nettedSettlementCount: 0
  };
}

// ---------------------------------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------------------------------

export function buildCashOutstandingReport(input: CashOutstandingInput): CashOutstandingReport {
  // Paso 1: la regla de recibido, importada (RF_01).
  const received = buildCodReceivedSet(input.settlements);
  const partialReceived = codPartialReceivedCop(input.settlements);

  // Con `targeted` solo llegan asientos de no recibidos; como solo se miran los de los candidatos,
  // `full` y `targeted` dan las mismas filas (invariante del plan 4.2).
  const amounts = amountsByOrder(input.receivableEntries);
  const settlementsOf = settlementsByOrder(input.settlements);
  const codRevenueAt = oldestCodRevenueAt(input.receivableEntries);

  const allRows: CashOutstandingRow[] = input.orders
    .filter((order) => isListedCandidate(order, input.scope, received))
    .map((order) => {
      const orderAmounts = amounts.get(order.id);
      const hasCodEntry = orderAmounts?.hasCodEntry ?? false;
      const collectedCop = hasCodEntry ? orderAmounts!.codCop : Math.round(order.totalCop);
      const driverPayCop = orderAmounts?.driverPayCop ?? 0;
      const expectedCashCop = Math.max(0, collectedCop - driverPayCop);
      const receivedCop = partialReceived.get(order.id) ?? 0;
      const rowSettlements = settlementsOf.get(order.id) ?? [];
      const { deliveredAt, deliveredAtSource } = resolveDeliveredAt(order, codRevenueAt);
      const ageDays = ageInDays(input.now, deliveredAt);
      const { location, attributedSettlementId } = resolveLocation(rowSettlements);
      return {
        orderId: order.id,
        trackingCode: order.trackingCode ?? order.id,
        sellerId: order.sellerId,
        sellerName: input.names.sellers.get(order.sellerId) ?? order.sellerId,
        leaderId: order.driverId,
        leaderName: nameOf(input.names.leaders, order.driverId),
        messengerId: order.messengerId,
        messengerName: nameOf(input.names.messengers, order.messengerId),
        deliveredAt,
        deliveredAtSource,
        ageDays,
        // RF_09: lo cubierto por compensacion no vence (no falta dinero).
        isOverdue: ageDays > input.settings.overdueDays && location !== "covered_by_netting",
        collectedCop,
        collectedSource: hasCodEntry ? "wallet" : "order_total",
        driverPayCop,
        expectedCashCop,
        receivedCop,
        outstandingCop: Math.max(0, expectedCashCop - receivedCop),
        location,
        settlements: rowSettlements,
        attributedSettlementId,
        supplierWithheld: [] // T8
      };
    });

  const rows = allRows.filter((row) => row.location !== "covered_by_netting").sort(byDeliveredAtAsc);
  const nettedRows = allRows.filter((row) => row.location === "covered_by_netting").sort(byDeliveredAtAsc);

  const isIncomplete =
    input.unreadableOrderIds.length > 0 || input.unreadableSettlementIds.length > 0 || input.unreadableEntryIds.length > 0;

  return {
    generatedAt: input.now,
    mode: input.scope.kind === "admin" && input.scope.includeReconciliation ? "with_reconciliation" : "summary",
    settings: input.settings,
    settingsInvalid: input.settingsInvalid,
    channelConfigured: input.channelConfigured,
    rows,
    nettedRows,
    byLeader: [], // T8
    bySupplier: [], // T8
    totals: emptyTotals(), // T8
    reconciliation: null, // T9
    isIncomplete,
    unreadableOrderIds: [...input.unreadableOrderIds],
    unreadableSettlementIds: [...input.unreadableSettlementIds],
    unreadableEntryIds: [...input.unreadableEntryIds]
  };
}
