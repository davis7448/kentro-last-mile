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
import type { DriverCashAllocation, SettlementDoc, SettlementOrderDoc, WalletEntryDoc } from "./settlement-math";

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
  /** Recaudo vigente total del pedido al calcular, el que le toca a este domiciliario (RF_01b). Lo usa RF_11. */
  codSeenCop: number;
  /**
   * Spec 038 T32 (hallazgo N1): el pedido lo entrego OTRO domiciliario, asi que este corte no le cobro el recaudo
   * y su `codSeenCop` es 0 por eso, no porque el recaudo fuera 0. Un corte asi no decide si el recaudo llego
   * (RF_11). Solo se escribe cuando es cierto, para no cambiar la forma de los demas cargos.
   */
  codOtherDriver?: true;
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
 * Quien entrego cada pedido: su `driverId` actual (RF_01b). `null` o ausente = no se sabe, y entonces el recaudo
 * cuenta como hasta ahora (un dato que falta no devuelve dinero).
 */
export type DeliveredBy = ReadonlyMap<string, string | null | undefined>;

/** El pedido lo tiene asignado OTRO domiciliario (no nulo): su recaudo no es de este (RF_01b). */
export function isDeliveredByOther(deliveredBy: DeliveredBy | undefined, orderId: string, driverId: string): boolean {
  const deliverer = deliveredBy?.get(orderId);
  return typeof deliverer === "string" && deliverer !== "" && deliverer !== driverId;
}

/**
 * Por pedido, lo que debe hoy con los asientos vigentes (RF_01, RF_01b, RF_02).
 *
 * El recaudo se suma de TODAS las tiendas: un pedido que cambio de tienda tiene su recaudo repartido
 * entre dos y el domiciliario lo cobro una sola vez. El pago solo cuenta el de este domiciliario. Y el recaudo
 * solo se le cobra al que entrego (`deliveredBy`): a quien hizo una visita fallida de un pedido que luego entrego
 * otro solo le queda su pago. Es la UNICA funcion que decide lo debido; las demas le pasan `deliveredBy`.
 */
export function orderOwedByDriver(entries: readonly WalletEntryDoc[], driverId: string, deliveredBy?: DeliveredBy): Map<string, OrderOwed> {
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
      const row = rowFor(orderId);
      if (!isDeliveredByOther(deliveredBy, orderId, driverId)) row.codCop += amountCop;
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

/** Fletes de tienda que forman el margen de la plataforma en un corte de domiciliario. */
const FEE_ENTRY_TYPES: ReadonlySet<WalletEntryDoc["type"]> = new Set(["delivery_fee", "failed_fee", "fulfillment_fee"]);

export type DriverCorteInput = {
  /** Id del corte que se calcula. Si ya existe en el contexto, no se cuenta como "otro corte". */
  settlementId: string;
  orderIds: readonly string[];
  /**
   * Ids de los asientos que pertenecen a ESTE corte (`walletEntryIds`, o los que entran al crearlo). El
   * pago del corte son los `driver_earning` de esta lista; el de otros cortes ya lo registraron ellos.
   */
  ownEntryIds: readonly string[];
  /** Asientos de tienda de los pedidos del corte y `driver_earning` del domiciliario. */
  entries: readonly WalletEntryDoc[];
  context: DriverLedgerContext;
  /** Efectivo ya recibido del domiciliario para este corte (suma de sus abonos). */
  receivedCop?: number;
  /** Fecha de creacion y tracking de cada pedido, para repartir lo recibido en el orden de hoy. */
  orderMeta?: ReadonlyMap<string, Pick<SettlementOrderDoc, "createdAt" | "trackingCode">>;
  /** Quien entrego cada pedido (RF_01b). Sin el, el recaudo cuenta como hasta ahora. */
  deliveredBy?: DeliveredBy;
};

export type DriverCorteFigures = {
  /** Un elemento por pedido, en el orden de `orderIds` y sin repetir (RF_03). */
  charges: DriverCashCharge[];
  codCop: number;
  driverPayCop: number;
  feesCop: number;
  platformMarginCop: number;
  /** Suma de `chargedCop`, sin recortar. */
  chargedTotalCop: number;
  /** Saldo que este corte recibe de los demas: a favor si es positivo, deuda si es negativo (RF_08). */
  creditInCop: number;
  /** Lo que su total negativo deja para el siguiente corte (>= 0). */
  creditOutCop: number;
  /** max(0, chargedTotalCop - creditInCop): el efectivo que el domiciliario debe entregar. */
  cashExpectedCop: number;
  /** -cashExpectedCop. Un corte a favor del domiciliario no se transfiere: se arrastra. */
  grossNetCop: number;
  netCop: number;
  /** 0: un corte de domiciliario ya no gira dinero, asi que no hay 4x1000. */
  gmfCop: number;
  /** Reparto de lo recibido entre los pedidos con cargo positivo (lo leen la 026 y la 027). */
  allocations: DriverCashAllocation[];
};

/**
 * Saldo neto que los DEMAS cortes del domiciliario dejaron: lo que generaron menos lo que consumieron.
 * Puede ser negativo: si un corte pendiente reduce despues un credito que otro ya consumio, la diferencia
 * es una deuda que el siguiente corte cobra (RF_08, ratificado el 2026-11-09).
 */
export function creditCarriedIn(context: DriverLedgerContext, settlementId: string): number {
  return context.settlements
    .filter((settlement) => settlement.id !== settlementId)
    .reduce((sum, settlement) => sum + (Number(settlement.creditOutCop) || 0) - (Number(settlement.creditInCop) || 0), 0);
}

/** Reparte lo recibido entre los cargos positivos, por fecha de creacion y tracking (el orden de hoy). */
function allocateReceived(
  charges: readonly DriverCashCharge[],
  receivedCop: number,
  orderMeta: ReadonlyMap<string, Pick<SettlementOrderDoc, "createdAt" | "trackingCode">>,
  storedOrder: readonly string[] = []
): DriverCashAllocation[] {
  // Un corte congelado conserva el orden en que guardo sus asignaciones (T27): sus pedidos van primero, en ese
  // orden; los que no figuraban, despues, por fecha.
  const rank = new Map(storedOrder.map((orderId, index) => [orderId, index] as const));
  const rankOf = (orderId: string) => rank.get(orderId) ?? Number.MAX_SAFE_INTEGER;
  const owing = charges
    .filter((charge) => charge.chargedCop > 0)
    .sort((left, right) => {
      const leftMeta = orderMeta.get(left.orderId);
      const rightMeta = orderMeta.get(right.orderId);
      return (
        rankOf(left.orderId) - rankOf(right.orderId) ||
        String(leftMeta?.createdAt ?? "").localeCompare(String(rightMeta?.createdAt ?? "")) ||
        String(leftMeta?.trackingCode ?? left.orderId).localeCompare(String(rightMeta?.trackingCode ?? right.orderId))
      );
    });
  let remaining = Math.max(0, Number(receivedCop) || 0);
  return owing.map((charge) => {
    const received = Math.min(charge.chargedCop, remaining);
    remaining -= received;
    return { orderId: charge.orderId, expectedCop: charge.chargedCop, receivedCop: received, covered: received >= charge.chargedCop };
  });
}

/** Retencion vigente (sin liberar) de un pedido, segun RF_17. */
export function activeHoldCop(holds: DriverCashHolds | null, orderId: string): number {
  return (holds?.holds ?? [])
    .filter((hold) => hold.orderId === orderId && !hold.releasedAt)
    .reduce((sum, hold) => sum + (Number(hold.holdCop) || 0), 0);
}

/**
 * Lo que los demas cortes del domiciliario ya registraron para cada pedido (plan §3.2): de su `cashCharges`
 * si se calcularon con la 038, y si no, de la foto historica. Un corte viejo que contiene un pedido y no
 * esta en la foto es un error: devolver 0 cobraria otra vez lo que ese corte ya cobro.
 */
export function registeredByOtherCortes(context: DriverLedgerContext, settlementId: string, orderIds: ReadonlySet<string>): Map<string, number> {
  const registered = new Map<string, number>();
  const add = (orderId: string, amountCop: number) => registered.set(orderId, (registered.get(orderId) ?? 0) + amountCop);
  for (const settlement of context.settlements) {
    if (settlement.id === settlementId) continue;
    const touched = (settlement.orderIds ?? []).map(String).filter((orderId) => orderIds.has(orderId));
    if (touched.length === 0) continue;
    if (Array.isArray(settlement.cashCharges)) {
      for (const charge of settlement.cashCharges) {
        if (orderIds.has(charge.orderId)) add(charge.orderId, Number(charge.chargedCop) || 0);
      }
      continue;
    }
    const rows = context.baseline?.settlements?.[settlement.id];
    if (!rows) {
      throw new Error(`Spec 038: el corte ${settlement.id} es anterior a la regla nueva y no esta en la foto historica del domiciliario ${context.driverId}.`);
    }
    for (const row of rows) {
      if (orderIds.has(row.orderId)) add(row.orderId, Number(row.chargedCop) || 0);
    }
  }
  return registered;
}

/**
 * Las cifras de un corte de domiciliario con la regla de la 038 (RF_02, RF_03, RF_09b; plan §3.3):
 *
 *   cargo_X(o)   = debido(o) − registrado(o, X) + retencion(o)
 *   pago_X(o)    = driver_earning del domiciliario que pertenecen a X
 *   recaudo_X(o) = cargo_X(o) + pago_X(o)
 *
 * Los fletes (y por tanto el margen) solo cuentan para pedidos que entran a X por un asiento propio del
 * domiciliario: un pedido que vuelve a un corte solo para devolver o cobrar una diferencia (RF_07) ya
 * aporto sus fletes en el corte donde se entrego.
 */
export function computeDriverCorte(input: DriverCorteInput): DriverCorteFigures {
  const { context } = input;
  const orderIds = Array.from(new Set(input.orderIds.map(String)));
  const orderIdSet = new Set(orderIds);
  const ownEntryIds = new Set(input.ownEntryIds.map(String));
  const relevant = input.entries.filter((entry) => orderIdSet.has(String(entry.orderId ?? "")));
  const owed = orderOwedByDriver(relevant, context.driverId, input.deliveredBy);
  const registered = registeredByOtherCortes(context, input.settlementId, orderIdSet);

  const ownPayByOrder = new Map<string, number>();
  for (const entry of relevant) {
    if (entry.ownerType === "driver" && entry.ownerId === context.driverId && entry.type === "driver_earning" && ownEntryIds.has(entry.id)) {
      ownPayByOrder.set(entry.orderId, (ownPayByOrder.get(entry.orderId) ?? 0) + (Number(entry.amountCop) || 0));
    }
  }
  const ordersWithOwnEntry = new Set(
    relevant.filter((entry) => entry.ownerType === "driver" && ownEntryIds.has(entry.id)).map((entry) => entry.orderId)
  );

  const charges = orderIds.map((orderId): DriverCashCharge => {
    const owedRow = owed.get(orderId);
    const chargedCop = (owedRow?.owedCop ?? 0) - (registered.get(orderId) ?? 0) + activeHoldCop(context.holds, orderId);
    const driverPayCop = ownPayByOrder.get(orderId) ?? 0;
    const charge: DriverCashCharge = { orderId, codCop: chargedCop + driverPayCop, driverPayCop, chargedCop, codSeenCop: owedRow?.codCop ?? 0 };
    if (isDeliveredByOther(input.deliveredBy, orderId, context.driverId)) charge.codOtherDriver = true;
    return charge;
  });

  const feesCop = Math.max(
    0,
    -relevant
      .filter((entry) => entry.ownerType === "seller" && FEE_ENTRY_TYPES.has(entry.type) && ordersWithOwnEntry.has(entry.orderId))
      .reduce((sum, entry) => sum + (Number(entry.amountCop) || 0), 0)
  );
  const codCop = charges.reduce((sum, charge) => sum + charge.codCop, 0);
  const driverPayCop = charges.reduce((sum, charge) => sum + charge.driverPayCop, 0);
  const chargedTotalCop = charges.reduce((sum, charge) => sum + charge.chargedCop, 0);
  const creditInCop = creditCarriedIn(context, input.settlementId);
  // Un saldo a favor (positivo) reduce lo que se entrega; una deuda (negativo) lo aumenta.
  const grossCop = chargedTotalCop - creditInCop;
  const cashExpectedCop = Math.max(0, grossCop);
  return {
    charges,
    codCop,
    driverPayCop,
    feesCop,
    platformMarginCop: feesCop - driverPayCop,
    chargedTotalCop,
    creditInCop,
    creditOutCop: Math.max(0, -grossCop),
    cashExpectedCop,
    // `0 - x` y no `-x`: un -0 rompe toEqual y se colaria en Firestore.
    grossNetCop: 0 - cashExpectedCop,
    netCop: 0 - cashExpectedCop,
    gmfCop: 0,
    allocations: allocateReceived(charges, input.receivedCop ?? 0, input.orderMeta ?? new Map())
  };
}

/** Un pedido que debe entrar al siguiente corte para cobrar o devolver una diferencia (RF_07). */
export type PendingDeltaOrder = {
  orderId: string;
  /** debido + retencion − lo ya registrado. Negativo: se le devuelve al domiciliario. */
  deltaCop: number;
};

/**
 * Pedidos que deben entrar al siguiente corte del domiciliario AUNQUE no tengan asientos nuevos suyos
 * (RF_06, RF_07; plan §3.5): estan en algun corte del domiciliario, en ninguno pendiente (ese lo absorbe al
 * recalcularse), y lo que deben hoy (mas su retencion vigente) no es lo que ya se registro. Hasta la 038 un
 * pedido solo entraba a un corte de domiciliario por un asiento propio sin cortar, asi que KNT-005724 y
 * KNT-006347 nunca volvieron a entrar.
 *
 * `entries` son los asientos de tienda de esos pedidos y los `driver_earning` del domiciliario.
 */
export function pendingDeltaOrders(input: {
  entries: readonly WalletEntryDoc[];
  context: DriverLedgerContext;
  /** Quien entrego cada pedido (RF_01b): un pedido que entrego otro no le vuelve solo a este. */
  deliveredBy?: DeliveredBy;
}): PendingDeltaOrder[] {
  const { context } = input;
  const inPending = new Set<string>();
  const seen: string[] = [];
  for (const settlement of context.settlements) {
    for (const orderId of (settlement.orderIds ?? []).map(String)) {
      if (settlement.status === "pending") inPending.add(orderId);
      seen.push(orderId);
    }
  }
  const candidates = Array.from(new Set(seen)).filter((orderId) => !inPending.has(orderId));
  if (candidates.length === 0) return [];
  const candidateSet = new Set(candidates);
  const owed = orderOwedByDriver(
    input.entries.filter((entry) => candidateSet.has(String(entry.orderId ?? ""))),
    context.driverId,
    input.deliveredBy
  );
  // Ningun corte se excluye: se compara contra todo lo registrado por el domiciliario.
  const registered = registeredByOtherCortes(context, "", candidateSet);
  return candidates
    .map((orderId) => ({
      orderId,
      deltaCop: (owed.get(orderId)?.owedCop ?? 0) + activeHoldCop(context.holds, orderId) - (registered.get(orderId) ?? 0)
    }))
    .filter((row) => row.deltaCop !== 0);
}

/** Lo ya registrado por TODOS los cortes del domiciliario, por pedido. */
function registeredByAllCortes(context: DriverLedgerContext): Map<string, number> {
  const orderIds = new Set(context.settlements.flatMap((settlement) => (settlement.orderIds ?? []).map(String)));
  return registeredByOtherCortes(context, "", orderIds);
}

/**
 * Retenciones de RF_17, calculadas una vez al escribir la foto (plan §3.6):
 *
 *   retencion(o) = Σ cargos registrados − debidoVisto(o)
 *
 * `debidoVisto` usa solo asientos con `createdAt <=` el ultimo recalculo del ultimo corte que contiene el
 * pedido (`recalculatedAt`, por id de corte). Asi una re-entrega posterior aun sin cortar no queda congelada
 * (la cobra el siguiente corte), y un recaudo BORRADO por una correccion si, porque el asiento ya no existe
 * (KNT-007828). Con esto, desplegar no cambia el efectivo de ningun corte (RNF_01).
 *
 * El corte por fecha solo se aplica a pedidos que la regla vieja SI volveria a cobrar: con un
 * `driver_earning` del domiciliario sin cortar (sin `settlementId`) o en un corte pendiente. Un pedido sin
 * nada de eso no vuelve nunca a un corte con la regla vieja, asi que lo que arrastre es historico y se
 * congela entero (todos los asientos). Es KNT-005724/KNT-006347: recaudo revertido despues de su unico corte
 * y sin movimientos propios; con el corte por fecha salian sin retencion y se les devolvia solo (RF_17).
 *
 * Devuelve solo los pedidos con retencion distinta de 0, en el orden en que aparecen en los cortes.
 */
export function computeHolds(input: {
  entries: readonly WalletEntryDoc[];
  context: DriverLedgerContext;
  recalculatedAt: ReadonlyMap<string, string>;
  /** Quien entrego cada pedido (RF_01b), para lo debido visto. */
  deliveredBy?: DeliveredBy;
}): DriverCashHold[] {
  const { context } = input;
  const seenUntil = new Map<string, string>();
  for (const settlement of context.settlements) {
    const time = input.recalculatedAt.get(settlement.id) ?? "";
    for (const orderId of (settlement.orderIds ?? []).map(String)) {
      const previous = seenUntil.get(orderId);
      if (previous === undefined || time > previous) seenUntil.set(orderId, time);
    }
  }
  const reachable = new Set<string>();
  for (const settlement of context.settlements) {
    if (settlement.status === "pending") for (const orderId of settlement.orderIds ?? []) reachable.add(String(orderId));
  }
  for (const entry of input.entries) {
    if (entry.ownerType === "driver" && entry.ownerId === context.driverId && entry.type === "driver_earning" && !entry.settlementId) {
      reachable.add(String(entry.orderId ?? ""));
    }
  }
  const registered = registeredByAllCortes(context);
  const holds: DriverCashHold[] = [];
  for (const [orderId, seenTime] of seenUntil) {
    const until = reachable.has(orderId) ? seenTime : "";
    const visible = input.entries.filter(
      (entry) => String(entry.orderId ?? "") === orderId && (!until || String(entry.createdAt ?? "") <= until)
    );
    const owedSeen = orderOwedByDriver(visible, context.driverId, input.deliveredBy).get(orderId)?.owedCop ?? 0;
    const holdCop = (registered.get(orderId) ?? 0) - owedSeen;
    if (holdCop !== 0) holds.push({ orderId, holdCop });
  }
  return holds;
}

/** Lo que `buildDriverLedgerSnapshot` necesita de un corte: el historico y, si es nuevo, sus cargos. */
export type SnapshotSettlement = HistoricalSettlement & Pick<DriverLedgerSettlement, "status"> &
  Partial<Pick<DriverLedgerSettlement, "cashCharges" | "creditInCop" | "creditOutCop">>;

export type DriverLedgerSnapshot = {
  baseline: DriverLedgerBaseline;
  holds: DriverCashHolds;
  /** El contexto que resulta de leer esos dos documentos con estos cortes. */
  context: DriverLedgerContext;
  /** Suma de las retenciones: la diferencia historica que se congela (va tambien en `measuredDiffCop`). */
  totalHoldCop: number;
};

/**
 * La foto historica (RF_05b) y las retenciones (RF_17) de un domiciliario, tal como las escribe
 * `scripts/snapshot-038-baseline.js`. Es tambien lo que deriva el informe de la 026 cuando un domiciliario aun no
 * tiene foto: una sola copia de como se hace. `settlements` son SOLO los cortes de este domiciliario; los que ya
 * traen `cashCharges` (calculados con la regla nueva) no se fotografian, se leen. `entries` puede traer asientos
 * de otros duenos: cada pieza filtra los suyos.
 */
export function buildDriverLedgerSnapshot(input: {
  driverId: string;
  settlements: readonly SnapshotSettlement[];
  entries: readonly WalletEntryDoc[];
  now: string;
  createdBy: string;
  /** Quien entrego cada pedido (RF_01b): lo usan las retenciones. */
  deliveredBy?: DeliveredBy;
}): DriverLedgerSnapshot {
  const { driverId } = input;
  const codByOrder = new Map<string, WalletEntryDoc[]>();
  const payByOrder = new Map<string, WalletEntryDoc[]>();
  for (const entry of input.entries) {
    const orderId = String(entry.orderId ?? "");
    if (!orderId) continue;
    const isCod = entry.ownerType === "seller" && COD_ENTRY_TYPES.has(entry.type);
    const isOwnPay = entry.ownerType === "driver" && entry.ownerId === driverId && entry.type === "driver_earning";
    const target = isCod ? codByOrder : isOwnPay ? payByOrder : null;
    if (target) target.set(orderId, [...(target.get(orderId) ?? []), entry]);
  }
  const baselineSettlements: Record<string, DriverBaselineCharge[]> = {};
  for (const settlement of input.settlements) {
    if (!Array.isArray(settlement.cashCharges)) {
      baselineSettlements[settlement.id] = rebuildHistoricalCharges(settlement, codByOrder, payByOrder);
    }
  }
  const settlements: DriverLedgerSettlement[] = input.settlements.map((settlement) => ({
    id: settlement.id,
    status: settlement.status,
    orderIds: (settlement.orderIds ?? []).map(String),
    ...(Array.isArray(settlement.cashCharges) ? { cashCharges: settlement.cashCharges } : {}),
    ...(typeof settlement.creditInCop === "number" ? { creditInCop: settlement.creditInCop } : {}),
    ...(typeof settlement.creditOutCop === "number" ? { creditOutCop: settlement.creditOutCop } : {})
  }));
  const withoutHolds: DriverLedgerContext = {
    driverId,
    settlements,
    baseline: { driverId, createdAt: input.now, createdBy: input.createdBy, measuredDiffCop: 0, settlements: baselineSettlements },
    holds: null
  };
  const holdRows = computeHolds({
    entries: input.entries,
    context: withoutHolds,
    deliveredBy: input.deliveredBy,
    recalculatedAt: new Map(input.settlements.map((settlement) => [settlement.id, lastRecalculatedAt(settlement)]))
  });
  const totalHoldCop = holdRows.reduce((total, hold) => total + hold.holdCop, 0);
  const baseline: DriverLedgerBaseline = { ...withoutHolds.baseline!, measuredDiffCop: totalHoldCop };
  const holds: DriverCashHolds = { driverId, createdAt: input.now, holds: holdRows };
  return { baseline, holds, context: { ...withoutHolds, baseline, holds }, totalHoldCop };
}

/** Una fila de la previsualizacion de compensacion (RF_13). */
export type CompensationRow = {
  orderId: string;
  /** Lo que los cortes le cobraron por el pedido. */
  chargedCop: number;
  /** Lo que el pedido debe hoy. */
  owedCop: number;
  /** Retencion que se libera: positivo = se le devuelve; negativo = se le cobra. */
  releaseCop: number;
  excluded: boolean;
  excludedReason?: string;
  /**
   * El pedido lo tiene asignado otro domiciliario (RF_01b, spec §5): se lista aparte y no se devuelve. Solo
   * aparece cuando es `true`, para que la huella de los planes sin estos casos no cambie.
   */
  otherDriver?: true;
  /** "next": entra al siguiente corte (RF_07); "pending:<id>": lo absorbe ese corte al recalcularse. */
  entersVia: string;
};

export type CompensationPlan = {
  driverId: string;
  rows: CompensationRow[];
  /** Suma de `releaseCop` de las filas no excluidas. */
  totalCop: number;
  excludedCop: number;
  /** Huella determinista de las filas: aplicar exige la misma (RF_14). */
  fingerprint: string;
};

/** Motivo con que se aparta, sin devolverlo, un pedido que tiene asignado otro domiciliario (spec §5). */
export const OTHER_DRIVER_REASON = "lo tiene asignado otro domiciliario: revisar a mano (spec 038 §5)";

/** FNV-1a de 32 bits: huella estable sin dependencias y sin `crypto` (el modulo es puro). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Previsualiza la compensacion historica de un domiciliario (RF_13, RF_16), con la misma regla que cobra
 * los cortes (no una segunda copia). No escribe nada. Las filas son las retenciones vigentes; los pedidos de
 * `exclude` se listan con su motivo y no suman al total.
 */
export function planDriverCompensation(input: {
  entries: readonly WalletEntryDoc[];
  context: DriverLedgerContext;
  exclude?: ReadonlyMap<string, string>;
  /** Quien entrego cada pedido (RF_01b). */
  deliveredBy?: DeliveredBy;
}): CompensationPlan {
  const { context } = input;
  const active = (context.holds?.holds ?? []).filter((hold) => !hold.releasedAt && hold.holdCop !== 0);
  const registered = registeredByAllCortes(context);
  const owed = orderOwedByDriver(input.entries, context.driverId, input.deliveredBy);
  const pendingByOrder = new Map<string, string>();
  for (const settlement of context.settlements) {
    if (settlement.status !== "pending") continue;
    for (const orderId of (settlement.orderIds ?? []).map(String)) pendingByOrder.set(orderId, settlement.id);
  }
  const rows = active.map((hold): CompensationRow => {
    const otherDriver = isDeliveredByOther(input.deliveredBy, hold.orderId, context.driverId);
    const reason = input.exclude?.get(hold.orderId) ?? (otherDriver ? OTHER_DRIVER_REASON : undefined);
    const pending = pendingByOrder.get(hold.orderId);
    return {
      orderId: hold.orderId,
      chargedCop: registered.get(hold.orderId) ?? 0,
      owedCop: owed.get(hold.orderId)?.owedCop ?? 0,
      releaseCop: hold.holdCop,
      excluded: reason !== undefined,
      ...(reason !== undefined ? { excludedReason: reason } : {}),
      ...(otherDriver ? { otherDriver: true as const } : {}),
      entersVia: pending ? `pending:${pending}` : "next"
    };
  });
  const totalCop = rows.filter((row) => !row.excluded).reduce((sum, row) => sum + row.releaseCop, 0);
  const excludedCop = rows.filter((row) => row.excluded).reduce((sum, row) => sum + row.releaseCop, 0);
  return { driverId: context.driverId, rows, totalCop, excludedCop, fingerprint: fnv1a(JSON.stringify({ driverId: context.driverId, rows })) };
}

export type CompensationApproval = {
  approvedBy: string;
  reason: string;
  /** ISO de la aplicacion; lo pone el llamador (el modulo no lee el reloj). */
  at: string;
  compensationId: string;
  /** Huella de la previsualizacion que se aprobo. */
  expectedFingerprint: string;
};

export type CompensationAudit = {
  compensationId: string;
  driverId: string;
  approvedBy: string;
  reason: string;
  at: string;
  fingerprint: string;
  releasedOrderIds: string[];
  excludedOrderIds: string[];
  totalCop: number;
  rows: CompensationRow[];
};

/**
 * Aplica una compensacion aprobada (RF_14, RF_15): libera exactamente las filas no excluidas del plan y
 * devuelve el registro de auditoria. No toca ningun corte: el siguiente corte del domiciliario recoge los
 * pedidos liberados por `pendingDeltaOrders`. Si la huella no es la aprobada, los datos cambiaron desde la
 * previsualizacion y lanza. Aplicar otra vez no libera nada mas: esas filas ya no estan vigentes.
 */
export function applyCompensationPlan(
  holds: DriverCashHolds,
  plan: CompensationPlan,
  approval: CompensationApproval
): { holds: DriverCashHolds; audit: CompensationAudit } {
  if (plan.fingerprint !== approval.expectedFingerprint) {
    throw new Error(`Spec 038: la huella de la compensacion cambio (${approval.expectedFingerprint} -> ${plan.fingerprint}); vuelve a previsualizar.`);
  }
  const toRelease = new Map(plan.rows.filter((row) => !row.excluded).map((row) => [row.orderId, row.releaseCop]));
  const nextHolds = holds.holds.map((hold) => {
    const releaseCop = toRelease.get(hold.orderId);
    if (releaseCop === undefined || hold.releasedAt) return { ...hold };
    return {
      ...hold,
      releasedCop: releaseCop,
      releasedBy: approval.approvedBy,
      releasedAt: approval.at,
      compensationId: approval.compensationId
    };
  });
  return {
    holds: { ...holds, holds: nextHolds },
    audit: {
      compensationId: approval.compensationId,
      driverId: plan.driverId,
      approvedBy: approval.approvedBy,
      reason: approval.reason,
      at: approval.at,
      fingerprint: plan.fingerprint,
      releasedOrderIds: Array.from(toRelease.keys()),
      excludedOrderIds: plan.rows.filter((row) => row.excluded).map((row) => row.orderId),
      totalCop: plan.totalCop,
      rows: plan.rows
    }
  };
}

/**
 * Pedidos de un corte de domiciliario al CREARLO (RF_07): los de sus asientos sin cortar y, ademas, los que
 * tienen una diferencia pendiente aunque el domiciliario no tenga movimientos nuevos de ellos. Primero los
 * de sus asientos, en su orden; despues los que vuelven solos. Un corte formado solo por estos ultimos es
 * valido: es como se le paga a un domiciliario que ya no trabaja (spec §5).
 */
export function driverCorteOrderIdsAtCreation(
  ownEntries: readonly WalletEntryDoc[],
  entries: readonly WalletEntryDoc[],
  context: DriverLedgerContext,
  deliveredBy?: DeliveredBy
): string[] {
  const own = ownEntries.map((entry) => String(entry.orderId ?? "")).filter(Boolean);
  const returning = pendingDeltaOrders({ entries, context, deliveredBy }).map((row) => row.orderId);
  return Array.from(new Set([...own, ...returning]));
}

/** Lo que se escribe en un corte de domiciliario, al crearlo y en cada recalculo (abono, pago, conciliacion). */
export type DriverSettlementFields = {
  codCop: number;
  feesCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  netCop: number;
  gmfCop: number;
  cashExpectedCop: number;
  cashReceivedCop: number;
  cashPendingCop: number;
  cashExcessCop: number;
  cashReceiptStatus: "none" | "partial" | "complete";
  cashAllocations: DriverCashAllocation[];
} & DriverSettlementLedgerFields;

/**
 * El bloque de campos de un corte de domiciliario con la regla de la 038. `orders.ts` solo lo escribe: asi
 * crear, abonar y cambiar de estado se prueban sin Firestore, y no pueden calcular distinto (RF_09). Desde la
 * creacion el corte guarda `cashExpectedCop` y su registro por pedido; antes la app lo pintaba con su propia
 * copia hasta el primer abono.
 */
export function buildDriverSettlementFields(input: DriverCorteInput & { receivedCop: number }): DriverSettlementFields {
  const figures = computeDriverCorte(input);
  const receivedCop = Math.max(0, Math.round(Number(input.receivedCop) || 0));
  const cashPendingCop = Math.max(0, figures.cashExpectedCop - receivedCop);
  return {
    codCop: figures.codCop,
    feesCop: figures.feesCop,
    driverPayCop: figures.driverPayCop,
    platformMarginCop: figures.platformMarginCop,
    netCop: figures.netCop,
    gmfCop: figures.gmfCop,
    cashExpectedCop: figures.cashExpectedCop,
    cashReceivedCop: receivedCop,
    cashPendingCop,
    // Lo entregado por encima de lo esperado queda visible, como hoy, en vez de desaparecer.
    cashExcessCop: Math.max(0, receivedCop - figures.cashExpectedCop),
    cashReceiptStatus: figures.cashExpectedCop === 0 || cashPendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
    cashAllocations: figures.allocations,
    cashCharges: figures.charges,
    creditInCop: figures.creditInCop,
    creditOutCop: figures.creditOutCop,
    ledgerVersion: 1
  };
}

/** Lo que un corte congelado (pagado o conciliado) actualiza al recibir efectivo. */
export type FrozenReceiptFields = Pick<
  DriverSettlementFields,
  "cashReceivedCop" | "cashPendingCop" | "cashExcessCop" | "cashReceiptStatus" | "cashAllocations"
>;

/**
 * RF_04: un corte pagado o conciliado NO recalcula sus cifras ni su registro por pedido. Si recibe efectivo
 * (un abono tardio a un corte pagado), solo se actualiza lo recibido y su reparto, sobre lo que el corte ya
 * guardo: `cashCharges` si es de la 038, y si es viejo, sus `cashAllocations`. Nunca con la regla vieja.
 * El reparto sigue el orden de las `cashAllocations` guardadas (T27): conciliar o abonar tarde no mueve lo
 * recibido de un pedido a otro, y no hace falta leer los pedidos dentro de la transaccion.
 */
export function refreshFrozenReceipts(
  frozen: { cashExpectedCop?: number; cashCharges?: readonly DriverCashCharge[]; cashAllocations?: readonly DriverCashAllocation[] },
  receivedCop: number,
  orderMeta: ReadonlyMap<string, Pick<SettlementOrderDoc, "createdAt" | "trackingCode">> = new Map()
): FrozenReceiptFields {
  const expectedCop = Math.max(0, Number(frozen.cashExpectedCop) || 0);
  const received = Math.max(0, Math.round(Number(receivedCop) || 0));
  const charges: DriverCashCharge[] = frozen.cashCharges
    ? [...frozen.cashCharges]
    : (frozen.cashAllocations ?? []).map((allocation) => ({
        orderId: allocation.orderId,
        codCop: allocation.expectedCop,
        driverPayCop: 0,
        chargedCop: allocation.expectedCop,
        codSeenCop: 0
      }));
  const pendingCop = Math.max(0, expectedCop - received);
  return {
    cashReceivedCop: received,
    cashPendingCop: pendingCop,
    cashExcessCop: Math.max(0, received - expectedCop),
    cashReceiptStatus: expectedCop === 0 || pendingCop === 0 ? "complete" : received > 0 ? "partial" : "none",
    cashAllocations: allocateReceived(charges, received, orderMeta, (frozen.cashAllocations ?? []).map((allocation) => allocation.orderId))
  };
}
