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
 */
import { computeDriverReceivable, isReceivableCodEntry, isReceivableDriverPay } from "./driver-receivable";
import type { CashAlertSettings } from "./cash-outstanding-schemas";
import { buildCodReceivedSet, codPartialReceivedCop } from "./seller-ledger";
import { computeDriverCashSummary, isDriverSettlementCashSettled, settlementCashReceivedCop } from "./settlement-math";
import { groupWithheldBySupplier } from "./supplier-withheld";
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
  /** NETO vencido: Σ `outstandingCop` de las vencidas. Es la clave de orden de `byLeader`. */
  overdueCop: number;
  /** BRUTO vencido: Σ `collectedCop` de las vencidas (spec 026 seccion 9 P1: el admin ve recaudo bruto). */
  overdueCollectedCop: number;
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
  /** NETO vencido: Σ `outstandingCop` de las vencidas de `rows`. */
  overdueCop: number;
  /** BRUTO vencido: Σ `collectedCop` de las vencidas de `rows` (los compensados no cuentan). */
  overdueCollectedCop: number;
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
    overdueCollectedCop: 0,
    nettedCount: 0,
    nettedCollectedCop: 0,
    nettedSettlementCount: 0
  };
}

// ---------------------------------------------------------------------------------------------------
// Proveedor, agrupaciones y totales (plan 4.2)
// ---------------------------------------------------------------------------------------------------

/**
 * Costo de producto retenido de cada pedido: asientos con `orderId` y sin `supplierSettlementId` (ya
 * liquidado al proveedor = no retenido, como la posicion). La clave y el signo los pone
 * `groupWithheldBySupplier`, no este archivo (RF_08).
 */
function withheldCostsByOrder(entries: WalletEntryDoc[]): Map<string, WalletEntryDoc[]> {
  const byOrder = new Map<string, WalletEntryDoc[]>();
  for (const entry of entries) {
    if (!entry.orderId || entry.supplierSettlementId) continue;
    const list = byOrder.get(entry.orderId) ?? [];
    list.push(entry);
    byOrder.set(entry.orderId, list);
  }
  return byOrder;
}

type SupplierGroup = SupplierWithheld & { overdueAmountCop: number };

/** RF_08: solo `rows` (lo compensado no se debe). Orden `amountCop` desc, estable. */
function groupBySupplier(rows: CashOutstandingRow[]): SupplierGroup[] {
  const bySupplier = new Map<string, SupplierGroup>();
  for (const row of rows) {
    for (const item of row.supplierWithheld) {
      const current = bySupplier.get(item.supplierId) ?? {
        supplierId: item.supplierId,
        supplierName: item.supplierName,
        amountCop: 0,
        overdueAmountCop: 0
      };
      current.amountCop += item.amountCop;
      if (row.isOverdue) current.overdueAmountCop += item.amountCop;
      if (item.supplierName) current.supplierName = item.supplierName;
      bySupplier.set(item.supplierId, current);
    }
  }
  return [...bySupplier.values()].sort((left, right) => right.amountCop - left.amountCop);
}

/** Desempate final por id; el grupo "Sin lider" (null) ordena como cadena vacia. */
function compareLeaderIds(left: string | null, right: string | null): number {
  const leftKey = left ?? "";
  const rightKey = right ?? "";
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** RF_03 / RF_06: solo `rows`; `driverId` null forma el grupo "Sin lider". */
function groupByLeader(rows: CashOutstandingRow[]): CashOutstandingGroup[] {
  const byLeader = new Map<string | null, CashOutstandingGroup>();
  for (const row of rows) {
    const current = byLeader.get(row.leaderId) ?? {
      leaderId: row.leaderId,
      leaderName: row.leaderName,
      orderCount: 0,
      collectedCop: 0,
      outstandingCop: 0,
      overdueCount: 0,
      overdueCop: 0,
      overdueCollectedCop: 0,
      oldestDeliveredAt: row.deliveredAt
    };
    current.orderCount += 1;
    current.collectedCop += row.collectedCop;
    current.outstandingCop += row.outstandingCop;
    if (row.isOverdue) {
      current.overdueCount += 1;
      current.overdueCop += row.outstandingCop;
      current.overdueCollectedCop += row.collectedCop;
    }
    if (row.deliveredAt < current.oldestDeliveredAt) current.oldestDeliveredAt = row.deliveredAt;
    byLeader.set(row.leaderId, current);
  }
  return [...byLeader.values()].sort(
    (left, right) =>
      right.overdueCop - left.overdueCop ||
      right.outstandingCop - left.outstandingCop ||
      compareLeaderIds(left.leaderId, right.leaderId)
  );
}

/** RF_03 / RF_09: lo que falta sale solo de `rows`; lo compensado se cuenta aparte en `netted*`. */
function computeTotals(rows: CashOutstandingRow[], nettedRows: CashOutstandingRow[]): CashOutstandingTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.orderCount += 1;
    totals.collectedCop += row.collectedCop;
    totals.outstandingCop += row.outstandingCop;
    if (row.location === "outside_settlement") totals.outsideSettlementCop += row.outstandingCop;
    else if (row.location === "in_settlement_open") totals.inOpenSettlementCop += row.outstandingCop;
    else if (row.location === "settlement_paid_short") totals.paidShortCop += row.outstandingCop;
    if (row.isOverdue) {
      totals.overdueCount += 1;
      totals.overdueCop += row.outstandingCop;
      totals.overdueCollectedCop += row.collectedCop;
    }
  }
  const nettedSettlementIds = new Set<string>();
  for (const row of nettedRows) {
    totals.nettedCount += 1;
    totals.nettedCollectedCop += row.collectedCop;
    if (row.attributedSettlementId !== null) nettedSettlementIds.add(row.attributedSettlementId);
  }
  totals.nettedSettlementCount = nettedSettlementIds.size;
  return totals;
}

// ---------------------------------------------------------------------------------------------------
// Conciliacion con la posicion de plataforma (plan 4.4, RNF_02)
// ---------------------------------------------------------------------------------------------------

type ReconciliationCauseItem = PositionReconciliation["causes"][number];

/**
 * Por que un pedido con asientos "por cobrar" no esta en `rows`. Se decide desde los DATOS (pedidos,
 * cortes, ilegibles), nunca desde `rows`/`nettedRows`: si la lista pierde un pedido, ninguna razon lo
 * absorbe y cae en `unexplained`. Precedencia: ilegible > fuera del universo > recibido > compensado.
 */
type UnlistedReason = "unreadable" | "outside_universe" | "received" | "covered_by_netting";

/** Fuera de corte solo valen ilegible y fuera del universo: recibido y compensado los dice un corte. */
const UNLISTED_OUTSIDE_CAUSE: Partial<Record<UnlistedReason, ReconciliationCause>> = {
  unreadable: "outside_unreadable_orders",
  outside_universe: "outside_orders_outside_universe"
};

const UNLISTED_SETTLEMENT_CAUSE: Record<UnlistedReason, ReconciliationCause> = {
  unreadable: "settlement_unreadable_orders",
  outside_universe: "settlement_orders_outside_universe",
  received: "settlement_orders_received",
  covered_by_netting: "settlement_orders_covered_by_netting"
};

/** Acumula causas con importe con signo, una por (causa, corte), en orden de aparicion. */
function causeCollector() {
  const causes: ReconciliationCauseItem[] = [];
  const add = (cause: ReconciliationCause, amountCop: number, orderIds: string[], settlementId?: string): void => {
    if (amountCop === 0 && orderIds.length === 0) return;
    const existing = causes.find((item) => item.cause === cause && item.settlementId === settlementId);
    if (existing) {
      existing.amountCop += amountCop;
      existing.orderIds.push(...orderIds);
      return;
    }
    causes.push(
      settlementId === undefined
        ? { cause, amountCop, orderIds: [...orderIds] }
        : { cause, amountCop, orderIds: [...orderIds], settlementId }
    );
  };
  return { causes, add };
}

/**
 * Descompone `deltaCop = posicion - lista` en causas con importe, sin residuo (plan 4.4).
 *
 * Fuera de corte: `Σ_U(cod - pago) - T - N + K` (no listados por razon, filas sin asiento COD, netos
 * negativos topados a 0 en la fila, tope a 0 del agregado). Por corte: `G - R` (pendiente guardado
 * contra recalculado: `stale` si el campo existe y difiere, `missing` si falta), los pedidos no
 * atribuidos por razon, y los terminos de las filas atribuidas, del tope del esperado, del excedente y
 * de lo recibido. Lo que ninguna razon explica va a `unexplainedCop` con su id: es la UNICA condicion de
 * fallo; `stale` y `missing` se reportan, no fallan.
 *
 * Pura. `listed` solo aporta lo que la lista dice deber; la compensacion sale de los cortes, asi que
 * quitar una fila de `nettedRows` no cambia nada.
 */
export function reconcileWithPlatformPosition(
  input: CashOutstandingInput,
  listed: { rows: CashOutstandingRow[]; nettedRows: CashOutstandingRow[] }
): PositionReconciliation {
  const driverSettlements = input.settlements.filter((settlement) => settlement.kind === "driver");
  const received = buildCodReceivedSet(driverSettlements);
  const universe = new Set(input.orders.map((order) => order.id));
  const unreadable = new Set(input.unreadableOrderIds);
  const settlementsOf = settlementsByOrder(driverSettlements);
  const rowById = new Map(listed.rows.map((row) => [row.orderId, row] as const));

  // Neto por pedido (cod - pago) con el mismo redondeo por asiento que la posicion; las claves son los
  // pedidos con algun asiento "por cobrar".
  const netByOrder = new Map<string, number>();
  for (const [orderId, orderAmounts] of amountsByOrder(input.receivableEntries)) {
    netByOrder.set(orderId, orderAmounts.codCop - orderAmounts.driverPayCop);
  }
  const netOf = (orderId: string): number => netByOrder.get(orderId) ?? 0;

  const reasonOf = (orderId: string): UnlistedReason | null => {
    if (unreadable.has(orderId)) return "unreadable";
    if (!universe.has(orderId)) return "outside_universe";
    if (received.has(orderId)) return "received";
    // Desde los cortes (plan 2.9), no desde nettedRows: sin corte abierto y alguno saldado en total.
    if (resolveLocation(settlementsOf.get(orderId) ?? []).location === "covered_by_netting") return "covered_by_netting";
    return null;
  };

  const { causes, add } = causeCollector();
  const unexplainedIds = new Set<string>();

  const addUnlisted = (orderId: string, settlementId?: string): void => {
    const reason = reasonOf(orderId);
    const cause =
      reason === null ? undefined : settlementId === undefined ? UNLISTED_OUTSIDE_CAUSE[reason] : UNLISTED_SETTLEMENT_CAUSE[reason];
    if (cause === undefined) {
      unexplainedIds.add(orderId);
      return;
    }
    add(cause, netOf(orderId), [orderId], settlementId);
  };

  /** Lo que la fila dice deber frente a lo que la posicion cuenta por ese pedido. */
  const addRowTerms = (row: CashOutstandingRow, settlementId?: string): void => {
    const gapCop = netOf(row.orderId) - row.expectedCashCop;
    if (gapCop !== 0) {
      const inSettlement = settlementId !== undefined;
      const cause: ReconciliationCause =
        row.collectedSource === "order_total"
          ? inSettlement
            ? "settlement_order_total_without_cod"
            : "outside_order_total_without_cod"
          : inSettlement
            ? "settlement_negative_net"
            : "outside_negative_net";
      add(cause, gapCop, [row.orderId], settlementId);
    }
    // Imputacion por encima del esperado actual (los asientos cambiaron tras el abono).
    const overExpectedCop = Math.min(0, row.expectedCashCop - row.receivedCop);
    if (overExpectedCop !== 0) add("settlement_allocation_over_expected", overExpectedCop, [row.orderId], settlementId);
  };

  // Fuera de todo corte de domiciliario.
  let outsideNetCop = 0;
  for (const orderId of netByOrder.keys()) {
    if (settlementsOf.has(orderId)) continue;
    outsideNetCop += netOf(orderId);
    if (!rowById.has(orderId)) addUnlisted(orderId);
  }
  for (const row of listed.rows) {
    if (!settlementsOf.has(row.orderId)) addRowTerms(row);
  }
  // La posicion topa a 0 el agregado de fuera de corte.
  if (outsideNetCop < 0) add("outside_aggregate_clamp", -outsideNetCop, []);

  // Por corte, con el pendiente recalculado sobre los mismos asientos.
  const cashInputs = {
    sellerEntries: input.receivableEntries.filter(isReceivableCodEntry),
    driverEntries: input.receivableEntries.filter(isReceivableDriverPay),
    orderMeta: new Map()
  };
  for (const settlement of driverSettlements) {
    const receivedCop = settlementCashReceivedCop(settlement);
    const summary = computeDriverCashSummary(cashInputs, settlement.orderIds ?? [], receivedCop);
    const recalculatedPendingCop = Math.max(0, summary.expectedCop - receivedCop);
    const storedPendingCop = Math.round(Number(settlement.cashPendingCop) || 0);
    if (settlement.cashPendingCop === undefined) {
      add("settlement_cash_pending_missing", storedPendingCop - recalculatedPendingCop, [], settlement.id);
    } else if (storedPendingCop !== recalculatedPendingCop) {
      add("settlement_cash_pending_stale", storedPendingCop - recalculatedPendingCop, [], settlement.id);
    }

    let settlementNetCop = 0;
    let receivedOnRowsCop = 0;
    for (const orderId of new Set(settlement.orderIds ?? [])) {
      settlementNetCop += netOf(orderId);
      const row = rowById.get(orderId);
      if (row && row.attributedSettlementId === settlement.id) {
        addRowTerms(row, settlement.id);
        receivedOnRowsCop += row.receivedCop;
      } else if (row) {
        add("settlement_orders_attributed_elsewhere", netOf(orderId), [orderId], settlement.id);
      } else {
        addUnlisted(orderId, settlement.id);
      }
    }
    const expectedClampCop = Math.max(0, -settlementNetCop);
    if (expectedClampCop !== 0) add("settlement_expected_clamp", expectedClampCop, [], settlement.id);
    const excessReceivedCop = Math.max(0, receivedCop - summary.expectedCop);
    if (excessReceivedCop !== 0) add("settlement_excess_received", excessReceivedCop, [], settlement.id);
    // Lo recibido que no esta imputado a filas atribuidas a este corte.
    const unassignedReceivedCop = receivedCop - receivedOnRowsCop;
    if (unassignedReceivedCop !== 0) add("settlement_cash_received", -unassignedReceivedCop, [], settlement.id);
  }

  const driverReceivableCop = computeDriverReceivable(input.receivableEntries, input.settlements).driverReceivableCop;
  const listOutstandingCop = listed.rows.reduce((total, row) => total + row.outstandingCop, 0);
  const deltaCop = driverReceivableCop - listOutstandingCop;
  const sumOf = (cause: ReconciliationCause): number =>
    causes.filter((item) => item.cause === cause).reduce((total, item) => total + item.amountCop, 0);

  return {
    driverReceivableCop,
    listOutstandingCop,
    deltaCop,
    causes,
    staleSettlementsCop: sumOf("settlement_cash_pending_stale"),
    missingPendingSettlementsCop: sumOf("settlement_cash_pending_missing"),
    unexplainedCop: deltaCop - causes.reduce((total, item) => total + item.amountCop, 0),
    unexplainedOrderIds: [...unexplainedIds].sort()
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
  // RF_08: el retenido por proveedor es solo del admin; el lider no lo ve.
  const isAdmin = input.scope.kind === "admin";
  const withheldCosts = isAdmin ? withheldCostsByOrder(input.productCostEntries) : new Map<string, WalletEntryDoc[]>();

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
        // Tambien en nettedRows, informativo: bySupplier solo suma rows.
        supplierWithheld: groupWithheldBySupplier(withheldCosts.get(order.id) ?? [])
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
    byLeader: groupByLeader(rows),
    bySupplier: isAdmin ? groupBySupplier(rows) : [],
    totals: computeTotals(rows, nettedRows),
    // Solo con asientos completos: con `targeted` la posicion no se puede reconstruir (plan 4.3).
    reconciliation:
      input.scope.kind === "admin" && input.scope.includeReconciliation && input.coverage === "full"
        ? reconcileWithPlatformPosition(input, { rows, nettedRows })
        : null,
    isIncomplete,
    unreadableOrderIds: [...input.unreadableOrderIds],
    unreadableSettlementIds: [...input.unreadableSettlementIds],
    unreadableEntryIds: [...input.unreadableEntryIds]
  };
}
