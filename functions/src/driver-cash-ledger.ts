/**
 * Spec 038 — LA UNICA REGLA de cuanto efectivo le cobra un corte a un domiciliario.
 *
 * Puro: sin firebase-admin ni Firestore, y sin `Date.now()`. Lo usan la creacion del corte, los
 * abonos, el pago y la conciliacion, la correccion de pedidos, el informe de efectivo de la 026, la
 * liquidacion de tienda y proveedor (via "recibido") y los scripts de medicion, foto y compensacion.
 *
 * Por que existe: hasta la 038 habia cuatro copias de la regla y cada una restaba algo distinto. Un
 * mismo pedido podia cobrarse en dos cortes, una reversa se neteaba dentro del corte nuevo en vez de
 * devolverse, y el pago del domiciliario se descontaba dos veces. Medido el 2026-11-07: $694.200 de mas a
 * un domiciliario en 16 pedidos (spec §1).
 *
 * Principio: cada peso de recaudo y de pago de un pedido se le cobra al domiciliario UNA vez. Un corte
 * cobra por un pedido lo que el pedido debe hoy menos lo que los demas cortes ya registraron (RF_02), y
 * deja registrada su cifra, sin recortar, para el siguiente (RF_03).
 */
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";

/** Tipos de asiento de tienda que son recaudo contra entrega (el positivo y su reversa). */
export const COD_ENTRY_TYPES: ReadonlySet<WalletEntryDoc["type"]> = new Set(["cod_revenue", "cod_remittance"]);

/** Lo que un corte de domiciliario cobro por un pedido en su ultimo calculo (RF_03). */
export type DriverCashCharge = {
  orderId: string;
  /** Recaudo que este corte cobra: cargo + pago propio. Puede ser negativo (devolucion). */
  codCop: number;
  /** Pago del domiciliario por asientos de ESTE corte. */
  driverPayCop: number;
  /** codCop - driverPayCop, SIN recortar (RF_08). La suma por pedido entre cortes es lo debido. */
  chargedCop: number;
  /** Recaudo vigente total del pedido al calcular. Solo para auditar (plan §3.7). */
  codSeenCop: number;
};

/** Campos que la 038 anade a un corte de domiciliario. Los existentes se siguen escribiendo. */
export type DriverSettlementLedgerFields = {
  /** Un elemento por pedido de `orderIds`, incluidos los de 0 y los negativos. */
  cashCharges: DriverCashCharge[];
  /** Saldo que el corte recibio de los demas: a favor si es positivo, deuda si es negativo (RF_08). */
  creditInCop: number;
  /** Lo que su total negativo deja para el siguiente corte (>= 0). */
  creditOutCop: number;
  ledgerVersion: 1;
};

/** Fila de la foto historica: lo que un corte viejo cobro por un pedido (RF_05, RF_05b). */
export type DriverBaselineCharge = {
  orderId: string;
  chargedCop: number;
  driverPayCop: number;
  source: "allocation" | "rebuilt";
};

/** Foto historica, un documento por domiciliario: `driverLedgerBaselines/{driverId}`. */
export type DriverLedgerBaseline = {
  driverId: string;
  createdAt: string;
  /** Quien aprobo escribirla (RF_05b). */
  createdBy: string;
  /** Diferencia medida al escribirla, para auditar. */
  measuredDiffCop: number;
  /** Por id de corte, sus filas. */
  settlements: Record<string, DriverBaselineCharge[]>;
};

/** Una retencion de RF_17: diferencia historica congelada hasta aprobar su compensacion. */
export type DriverCashHold = {
  orderId: string;
  holdCop: number;
  /** Diferencia previsualizada al liberar (RF_14). */
  releasedCop?: number;
  releasedBy?: string;
  releasedAt?: string;
  compensationId?: string;
};

/** `driverCashHolds/{driverId}`. */
export type DriverCashHolds = {
  driverId: string;
  createdAt: string;
  holds: DriverCashHold[];
};

/** Un corte de domiciliario tal como lo necesita la regla, con la marca de tiempo de su ultima escritura. */
export type DriverLedgerSettlement = {
  id: string;
  status: string;
  orderIds: string[];
  /** Presente en los cortes calculados con la 038. */
  cashCharges?: DriverCashCharge[];
  creditInCop?: number;
  creditOutCop?: number;
  /** `updateTime` de Firestore en ISO, para detectar recalculos cruzados (RF_04b). */
  updateTime?: string;
};

/** Todo lo que hace falta, ademas de los asientos, para calcular un corte de un domiciliario. */
export type DriverLedgerContext = {
  driverId: string;
  settlements: DriverLedgerSettlement[];
  baseline: DriverLedgerBaseline | null;
  holds: DriverCashHolds | null;
};

/** Lo que un pedido debe hoy a ojos de un domiciliario (plan §3.1). */
export type OrderOwed = {
  orderId: string;
  /** Recaudo vigente: cod_revenue + cod_remittance de cualquier tienda. */
  codCop: number;
  /** Pago vigente de ESTE domiciliario por el pedido. */
  driverPayCop: number;
  /** codCop - driverPayCop. Negativo si el domiciliario gano mas de lo que recaudo. */
  owedCop: number;
};

/**
 * Por pedido, lo que debe hoy con los asientos vigentes (RF_01, RF_02).
 *
 * El recaudo se suma de TODAS las tiendas: un pedido que cambio de tienda tiene su recaudo repartido
 * entre dos y el domiciliario lo cobro una sola vez. El pago solo cuenta el de este domiciliario.
 */
export function orderOwedByDriver(entries: readonly WalletEntryDoc[], driverId: string): Map<string, OrderOwed> {
  const owed = new Map<string, OrderOwed>();
  const rowFor = (orderId: string): OrderOwed => {
    let row = owed.get(orderId);
    if (!row) {
      row = { orderId, codCop: 0, driverPayCop: 0, owedCop: 0 };
      owed.set(orderId, row);
    }
    return row;
  };
  for (const entry of entries) {
    const orderId = String(entry.orderId ?? "");
    if (!orderId) continue;
    const amountCop = Number(entry.amountCop) || 0;
    if (entry.ownerType === "seller" && COD_ENTRY_TYPES.has(entry.type)) {
      rowFor(orderId).codCop += amountCop;
    } else if (entry.ownerType === "driver" && entry.ownerId === driverId && entry.type === "driver_earning") {
      rowFor(orderId).driverPayCop += amountCop;
    }
  }
  for (const row of owed.values()) row.owedCop = row.codCop - row.driverPayCop;
  return owed;
}

/** Lo que `rebuildHistoricalCharges` necesita de un corte viejo. */
export type HistoricalSettlement = Pick<
  SettlementDoc,
  "id" | "orderIds" | "createdAt" | "paidAt" | "reconciledAt" | "cashReceipts" | "cashAllocations"
>;

/**
 * Ultimo instante en que un corte viejo recalculo su efectivo: lo hacia al crearse, en cada abono y al
 * pagarse o conciliarse. Los asientos posteriores no los vio, asi que no los cobro.
 */
export function lastRecalculatedAt(settlement: Pick<HistoricalSettlement, "createdAt" | "paidAt" | "reconciledAt" | "cashReceipts">): string {
  const times = [
    settlement.createdAt,
    settlement.paidAt,
    settlement.reconciledAt,
    ...(settlement.cashReceipts ?? []).map((receipt) => receipt.receivedAt)
  ]
    .filter((time): time is string => Boolean(time))
    .map(String);
  return times.sort().pop() ?? "";
}

function sumUntil(entries: readonly WalletEntryDoc[] | undefined, until: string): number {
  return (entries ?? [])
    .filter((entry) => !until || String(entry.createdAt ?? "") <= until)
    .reduce((sum, entry) => sum + (Number(entry.amountCop) || 0), 0);
}

/**
 * Lo que un corte creado antes de la 038 cobro por cada pedido (RF_05). Es la regla que
 * `specs/038_measure.js` valido contra los 60 cortes de produccion el 2026-11-07:
 *
 * - si el corte guardo la asignacion del pedido, esa es la cifra: es el registro de lo que se le pidio,
 *   y reconstruir desde asientos falla cuando una correccion los borro despues (KNT-004540, KNT-007828);
 * - si el corte tiene asignaciones pero no lista el pedido, el pedido no aporto recaudo: como mucho
 *   resto el pago (`min(0, …)`). Es KNT-000056 en el corte del 2026-05-29, que un script anterior al
 *   planificador recalculo tras corregir el pedido;
 * - si el corte no tiene asignaciones, se reconstruye con los asientos que existian en su ultimo recalculo.
 *
 * `codEntriesByOrder` son los asientos de recaudo de tienda; `payEntriesByOrder`, los `driver_earning` del
 * domiciliario del corte. Se ejecuta una vez, al escribir la foto (RF_05b); despues se lee la foto.
 */
export function rebuildHistoricalCharges(
  settlement: HistoricalSettlement,
  codEntriesByOrder: ReadonlyMap<string, readonly WalletEntryDoc[]>,
  payEntriesByOrder: ReadonlyMap<string, readonly WalletEntryDoc[]>
): DriverBaselineCharge[] {
  const until = lastRecalculatedAt(settlement);
  const allocationByOrder = new Map<string, number>();
  for (const allocation of settlement.cashAllocations ?? []) {
    if (allocation.orderId) allocationByOrder.set(String(allocation.orderId), Number(allocation.expectedCop) || 0);
  }
  const hasAllocations = allocationByOrder.size > 0;
  const orderIds = Array.from(new Set((settlement.orderIds ?? []).map(String)));
  return orderIds.map((orderId) => {
    const driverPayCop = sumUntil(payEntriesByOrder.get(orderId), until);
    const allocated = allocationByOrder.get(orderId);
    if (allocated !== undefined) {
      return { orderId, chargedCop: allocated, driverPayCop, source: "allocation" as const };
    }
    const rebuilt = sumUntil(codEntriesByOrder.get(orderId), until) - driverPayCop;
    return { orderId, chargedCop: hasAllocations ? Math.min(0, rebuilt) : rebuilt, driverPayCop, source: "rebuilt" as const };
  });
}
