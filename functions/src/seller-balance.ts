/**
 * Spec 018 — cuanto se le puede pagar HOY a una tienda, y por que el resto no.
 *
 * Una sola regla para cinco superficies: la pantalla de la tienda, el cierre pendiente del admin,
 * la solicitud de liquidacion, el corte y la API para tiendas. Antes cada una sumaba a su manera y
 * la tienda veia $1.603.350 donde el admin solo podia pagarle $354.280.
 *
 * Las cifras (con asientos legibles, total = disponible + efectivo con domiciliario + retenido):
 *  - total sin cortar: los asientos abiertos de tipo liquidable;
 *  - efectivo aun con el domiciliario: entregados contra entrega cuyo efectivo no ha llegado;
 *  - disponible: lo que un corte pagaria, en PEDIDOS COMPLETOS, sin superar lo pagable menos la
 *    retencion por pedidos en la calle;
 *  - retenido: lo pagable que queda fuera del disponible.
 *
 * Puro: sin Firestore. Lo importan el servidor y la app. Los tipos son laxos a proposito, porque
 * lo alimentan documentos de Firestore y el estado del navegador.
 */
import { buildCodReceivedSet, isSellerEntryEligible, SELLER_LIQUIDATION_TYPES, type OrderDoc, type SettlementDoc, type WalletEntryDoc } from "./seller-ledger";
import { isOrderOnTheStreet, retentionForOrder, type RetentionOrder } from "./seller-retention";
import { resolveTariffs } from "./seller-charges";

export type SellerBalanceInput = {
  /** Asientos de la tienda con `settlementId` vacio. */
  openEntries: WalletEntryDoc[];
  /** Pedidos de esos asientos (y de los candidatos). */
  ordersById: Map<string, OrderDoc>;
  /** Pedidos abiertos de la tienda; la funcion vuelve a filtrar los que estan en la calle. */
  streetCandidates: RetentionOrder[];
  codReceived: ReadonlySet<string>;
  /** Pedidos con asiento de manejo ya escrito (`we-<id>-fulfillment-fee`): no se retiene otra vez. */
  chargedFulfillmentOrderIds: ReadonlySet<string>;
  settings: Record<string, unknown>;
  zonesById: Map<string, Record<string, unknown>>;
  now: string;
};

export type PayoutSelection = {
  entryIds: string[];
  totalCop: number;
  includedOrderIds: string[];
  /** Pedidos con neto positivo (o restituciones sin pedido, por su id de asiento) que quedaron fuera, enteros. */
  heldOrderIds: string[];
};

export type SellerBalance = {
  totalUnsettledCop: number;
  payableCop: number;
  codPendingCop: number;
  codPendingOrderCount: number;
  retentionTheoreticalCop: number;
  streetOrderCount: number;
  availableCop: number;
  heldCop: number;
  heldOrderCount: number;
  unreadableEntryIds: string[];
  selection: PayoutSelection;
};

export type SettlementSelectionResult =
  | { ok: true; selection: PayoutSelection }
  | { ok: false; reason: "empty_by_retention"; selection: PayoutSelection };

const amountOf = (entry: WalletEntryDoc) => Math.round(Number(entry.amountCop || 0));

/**
 * Arma la entrada desde documentos planos. El cargador del servidor y la fila del admin pasan por
 * aqui: una sola forma de decidir que asientos estan abiertos, que pedidos son candidatos y que
 * manejos ya se cobraron.
 */
export function buildSellerBalanceInput(docs: {
  sellerId: string;
  wallet: WalletEntryDoc[];
  orders: OrderDoc[];
  settlements: SettlementDoc[];
  settings: Record<string, unknown>;
  zones: Record<string, unknown>[];
  now: string;
}): SellerBalanceInput {
  const { sellerId } = docs;
  const openEntries = docs.wallet.filter((entry) => entry.ownerType === "seller" && entry.ownerId === sellerId && !entry.settlementId);
  const chargedFulfillmentOrderIds = new Set(
    docs.wallet
      .filter((entry) => entry.ownerType === "seller" && entry.type === "fulfillment_fee" && entry.orderId)
      .map((entry) => String(entry.orderId))
  );
  return {
    openEntries,
    ordersById: new Map(docs.orders.map((order) => [String(order.id), order])),
    streetCandidates: docs.orders.filter((order) => order.sellerId === sellerId && isOrderOnTheStreet(order as RetentionOrder)) as RetentionOrder[],
    codReceived: buildCodReceivedSet(docs.settlements),
    chargedFulfillmentOrderIds,
    settings: docs.settings,
    zonesById: new Map(docs.zones.map((zone) => [String(zone.id), zone])),
    now: docs.now
  };
}

/**
 * RF_12. Los asientos sin pedido (abonos, 4x1000, restituciones) y los pedidos con neto cero o
 * negativo entran siempre. Los pedidos con neto positivo entran del mas antiguo al mas nuevo
 * mientras la suma no pase del tope; el primero que no cabe ENTERO, y todos los posteriores,
 * quedan pendientes. Es lo mismo que ya hace el abono a proveedor.
 */
export function selectPayableOrders(entries: WalletEntryDoc[], capCop: number): PayoutSelection {
  const fixedEntries: WalletEntryDoc[] = [];
  const groups = new Map<string, { orderId: string; entries: WalletEntryDoc[]; netCop: number; oldest: string }>();
  for (const entry of entries) {
    const orderId = String(entry.orderId ?? "");
    // Sin pedido: abonos y 4x1000 (negativos) restan siempre. Una restitucion POSITIVA
    // (`we-unpaid-*`) es dinero a favor de la tienda: compite por el tope como un pedido entero,
    // o se saltaria la retencion (hallazgo R1-RF_02-1).
    if (!orderId && amountOf(entry) <= 0) {
      fixedEntries.push(entry);
      continue;
    }
    const unitId = orderId || String(entry.id);
    const createdAt = String(entry.createdAt ?? "");
    const group = groups.get(unitId) ?? { orderId: unitId, entries: [], netCop: 0, oldest: createdAt };
    group.entries.push(entry);
    group.netCop += amountOf(entry);
    if (createdAt < group.oldest) group.oldest = createdAt;
    groups.set(unitId, group);
  }

  const included: WalletEntryDoc[] = [...fixedEntries];
  const includedOrderIds: string[] = [];
  const heldOrderIds: string[] = [];
  let totalCop = fixedEntries.reduce((sum, entry) => sum + amountOf(entry), 0);

  const ordered = [...groups.values()].sort((left, right) => (left.oldest < right.oldest ? -1 : left.oldest > right.oldest ? 1 : left.orderId < right.orderId ? -1 : left.orderId > right.orderId ? 1 : 0));
  for (const group of ordered) {
    if (group.netCop > 0) continue;
    included.push(...group.entries);
    includedOrderIds.push(group.orderId);
    totalCop += group.netCop;
  }
  let stopped = false;
  for (const group of ordered) {
    if (group.netCop <= 0) continue;
    if (stopped || totalCop + group.netCop > capCop) {
      stopped = true;
      heldOrderIds.push(group.orderId);
      continue;
    }
    included.push(...group.entries);
    includedOrderIds.push(group.orderId);
    totalCop += group.netCop;
  }

  return { entryIds: included.map((entry) => String(entry.id)), totalCop, includedOrderIds, heldOrderIds };
}

/**
 * LA regla del tope (RF_12–RF_15, RF_23, RF_24). `balance` es SIEMPRE de la tienda entera;
 * `candidates` es todo lo pagable (saldo) o lo escogido (corte con rango).
 */
export function selectSettlementEntries(
  balance: Pick<SellerBalance, "payableCop" | "retentionTheoreticalCop">,
  candidates: WalletEntryDoc[]
): SettlementSelectionResult {
  if (balance.payableCop <= 0 || balance.retentionTheoreticalCop <= 0) {
    return { ok: true, selection: selectPayableOrders(candidates, Number.POSITIVE_INFINITY) };
  }
  const selection = selectPayableOrders(candidates, balance.payableCop - balance.retentionTheoreticalCop);
  if (selection.totalCop > 0) return { ok: true, selection };
  // Solo se rechaza si la retencion es la CAUSA: un corte que sin retencion ya pagaria cero o menos
  // (por ejemplo, solo cobros de fallidos) se crea igual que antes (hallazgo R1-RF_24-1).
  const unrestricted = selectPayableOrders(candidates, Number.POSITIVE_INFINITY);
  // Se devuelve la seleccion CON tope: el corte negativo se crea, pero sin liquidar pedidos que
  // la retencion deja fuera (hallazgo R2-RF_23-1).
  if (unrestricted.totalCop <= 0) return { ok: true, selection };
  return { ok: false, reason: "empty_by_retention", selection };
}

export function computeSellerBalance(input: SellerBalanceInput): SellerBalance {
  const liquidation = input.openEntries.filter((entry) => SELLER_LIQUIDATION_TYPES.has(String(entry.type)));
  const payableEntries: WalletEntryDoc[] = [];
  const codPendingOrders = new Set<string>();
  const unreadableEntryIds: string[] = [];
  let totalUnsettledCop = 0;
  let payableCop = 0;
  let codPendingCop = 0;

  for (const entry of liquidation) {
    const amountCop = amountOf(entry);
    totalUnsettledCop += amountCop;
    if (isSellerEntryEligible(entry, input.ordersById, input.codReceived as Set<string>)) {
      payableEntries.push(entry);
      payableCop += amountCop;
      continue;
    }
    const order = entry.orderId ? input.ordersById.get(String(entry.orderId)) : undefined;
    if (order) {
      // Elegible = false con pedido legible solo pasa con un COD entregado cuyo efectivo no llego.
      codPendingCop += amountCop;
      codPendingOrders.add(String(entry.orderId));
      continue;
    }
    unreadableEntryIds.push(String(entry.id));
  }

  const street = input.streetCandidates.filter((order) => isOrderOnTheStreet(order));
  const retentionTheoreticalCop = street.reduce((sum, order) => {
    const zone = order.zoneId ? input.zonesById.get(String(order.zoneId)) : undefined;
    const tariffs = resolveTariffs(input.settings, zone);
    return sum + retentionForOrder(order, tariffs, input.now, { fulfillmentAlreadyCharged: input.chargedFulfillmentOrderIds.has(String(order.id)) });
  }, 0);

  const result = selectSettlementEntries({ payableCop, retentionTheoreticalCop }, payableEntries);
  // Sin corte posible (RF_14/RF_24), todos los pedidos con neto positivo quedan retenidos.
  const selection: PayoutSelection = result.ok
    ? result.selection
    : { entryIds: [], totalCop: 0, includedOrderIds: [], heldOrderIds: positiveOrderIds(payableEntries) };
  const availableCop = selection.totalCop;

  return {
    totalUnsettledCop,
    payableCop,
    codPendingCop,
    codPendingOrderCount: codPendingOrders.size,
    retentionTheoreticalCop,
    streetOrderCount: street.length,
    availableCop,
    heldCop: payableCop - availableCop,
    heldOrderCount: selection.heldOrderIds.length,
    unreadableEntryIds,
    selection
  };
}

/** Unidades con neto positivo: pedidos, y restituciones sin pedido por su id (misma unidad que selectPayableOrders). */
function positiveOrderIds(entries: WalletEntryDoc[]): string[] {
  const net = new Map<string, number>();
  for (const entry of entries) {
    const unitId = entry.orderId ? String(entry.orderId) : amountOf(entry) > 0 ? String(entry.id) : "";
    if (!unitId) continue;
    net.set(unitId, (net.get(unitId) ?? 0) + amountOf(entry));
  }
  return [...net].filter(([, value]) => value > 0).map(([orderId]) => orderId);
}

const pesos = (value: number) => `$ ${Math.round(value).toLocaleString("es-CO")}`;
const plural = (count: number, singular: string, pluralForm: string) => `${count} ${count === 1 ? singular : pluralForm}`;

/** RF_16 / RF_24. Por que no hay nada que pagar todavia, en palabras de la tienda. */
export function payoutRejectionMessage(balance: SellerBalance): string {
  if (balance.unreadableEntryIds.length > 0) {
    return "No pudimos calcular tu saldo completo. Kentro ya lo esta revisando.";
  }
  const reasons: string[] = [];
  if (balance.heldCop > 0) {
    reasons.push(
      `Tienes ${pesos(balance.heldCop)} retenidos (${plural(balance.heldOrderCount, "pedido", "pedidos")}) mientras haya ${plural(balance.streetOrderCount, "pedido en la calle", "pedidos en la calle")} que podrian volver como fallidos.`
    );
  }
  if (balance.codPendingCop > 0) {
    reasons.push(`Faltan ${pesos(balance.codPendingCop)} de efectivo por recibir del domiciliario (${plural(balance.codPendingOrderCount, "pedido", "pedidos")}).`);
  }
  if (reasons.length === 0) return "No tienes saldo pendiente por liquidar.";
  return `Todavia no hay saldo para liquidar. ${reasons.join(" ")}`;
}
