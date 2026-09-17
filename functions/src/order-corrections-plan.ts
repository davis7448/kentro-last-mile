/**
 * Planificador de correcciones administrativas de pedidos. PURO: no lee ni escribe nada.
 *
 * Sustituye a ocho scripts one-off (correct-*.js, clawback-*.js, reopen-order-for-retry.js)
 * que hacian esto mismo con el id del pedido a mano. Cada uno llevaba su propia copia de
 * buildWalletEntries / resolveTariffs / calculateDriverCashSummary; aqui NO se recalcula
 * ni un peso: la plata la sigue decidiendo buildWalletEntries (wallet-entries.ts), la misma
 * funcion que usa closeOrder. Lo unico que vive aqui es la RECONCILIACION entre lo que el
 * pedido tiene y lo que deberia tener.
 *
 * Al ser puro, la previsualizacion y la aplicacion recorren identico codigo: lo que el
 * admin aprueba en pantalla es literalmente lo que se escribe.
 *
 * Razonamiento heredado de los scripts, que es lo unico que valia de ellos:
 *
 *  1. Un corte ya pagado o conciliado NO se toca (clawback-knt003259.js). El dinero ya
 *     salio; reescribir el corte descuadra una conciliacion cerrada. La correccion se
 *     publica como asientos compensatorios en el periodo abierto y se netea en el
 *     siguiente corte.
 *  2. La reversa de un recaudo va como `cod_remittance`, no como `cod_revenue` negativo
 *     (clawback-knt003259.js:23-27). computeDriverCashSummary suma los dos por pedido, e
 *     isLiquidationWalletType / SELLER_LIQUIDATION_TYPES incluyen el remittance, asi que la
 *     reversa se barre al siguiente corte en vez de quedar como saldo eterno. Un
 *     cod_revenue negativo cuadraria igual pero mentiria en los reportes de recaudo.
 *  3. Hay que crear los asientos nuevos AUNQUE neteen a cero contra un corte congelado
 *     (correct-knt003316-to-delivered.js:29-36). computeDriverCashSummary arma el efectivo
 *     esperado a partir de los orderIds del corte: si el pedido no deja asientos, nunca
 *     reaparece y el recaudo no se le cobra a nadie.
 *  4. En un corte PENDIENTE, el pago de la visita se hereda al asiento que lo reemplaza
 *     (correct-delivered-to-chargeable-failed.js:11-18): si el nuevo naciera abierto, el
 *     pago de una misma visita se partiria entre dos cortes.
 *  5. Reabrir un fallido para nueva visita no mueve dinero (reopen-order-for-retry.js): la
 *     visita perdida se hizo y se cobra. buildWalletEntries numera el siguiente intento
 *     (`-failed-fee-2`), asi que un segundo fallido se cobra aparte sin pisar el primero.
 */
import {
  type InventoryMovement,
  type InventoryMovementKind,
  inventoryMovementsForOrder,
  orderOwnsInventoryReservation
} from "./inventory-movements";
import {
  computeDriverCashSummary,
  type DriverCashInputs,
  type SettlementDoc,
  settlementCashReceivedCop,
  settlementTotals,
  type WalletEntryDoc
} from "./settlement-math";
import { buildWalletEntries, type ProductCostLine, stripUndefined, withOpenSettlementFlags } from "./wallet-entries";

export const ORDER_CORRECTION_KINDS = [
  "failed_to_delivered",
  "delivered_to_failed",
  "cancelled_to_operational",
  "failed_to_retry_pending"
] as const;

export type OrderCorrectionKind = (typeof ORDER_CORRECTION_KINDS)[number];

/** Estado de partida exigido por cada correccion. Es la matriz completa: no hay otras. */
const REQUIRED_FROM_STATUS: Record<OrderCorrectionKind, string> = {
  failed_to_delivered: "failed",
  delivered_to_failed: "delivered",
  cancelled_to_operational: "cancelled",
  failed_to_retry_pending: "failed"
};

const AUDIT_ACTION: Record<OrderCorrectionKind, string> = {
  failed_to_delivered: "order.correct_failed_to_delivered",
  delivered_to_failed: "order.correct_delivered_to_failed",
  cancelled_to_operational: "order.correct_cancelled_to_operational",
  failed_to_retry_pending: "order.reopened_for_retry"
};

export type CorrectionRequest = {
  kind: OrderCorrectionKind;
  reason: string;
  driverId?: string;
  failedCategory?: string;
  failedReason?: string;
  targetStatus?: string;
  scheduledDate?: string;
  scheduledWindow?: string;
};

export type EvidenceDoc = {
  id: string;
  type: "delivery" | "failed";
  photoLabel: string;
  photoUrl?: string;
  storagePath?: string;
  note: string;
  reason?: string;
  failedCategory?: string;
  createdAt: string;
  actorId: string;
};

export type PlanNote = { code: string; message: string };

export type PlannedSettlement = {
  id: string;
  kind: "seller" | "driver" | "supplier" | "community_leader";
  ownerName: string;
  /** Lo que se escribe en el documento del corte. */
  patch: Record<string, unknown>;
  before: { walletEntryCount: number; orderCount: number; netCop: number; cashExpectedCop?: number; cashPendingCop?: number };
  after: { walletEntryCount: number; orderCount: number; netCop: number; cashExpectedCop?: number; cashPendingCop?: number };
  /** Asientos del propio corte (4x1000, faltante de efectivo) que cambian con el. */
  relatedEntryPatches: Array<{ id: string; amountCop: number; reason: string }>;
};

export type OrderCorrectionPlan = {
  kind: OrderCorrectionKind;
  orderId: string;
  trackingCode: string;
  fromStatus: string;
  toStatus: string;
  /** Version legible del parche; los borrados van como el texto "(se borra)". */
  orderPatchPreview: Record<string, string>;
  /** Numero de visita fallida que quedara registrada. Decide el sufijo `-N` de los asientos. */
  failedAttempt?: number;
  entriesToDelete: WalletEntryDoc[];
  entriesToCreate: WalletEntryDoc[];
  entriesToCompensate: Array<{ sourceId: string; frozenSettlementId: string; entry: WalletEntryDoc }>;
  entriesToKeep: WalletEntryDoc[];
  settlementsToRecalculate: PlannedSettlement[];
  frozenSettlements: Array<{ id: string; kind: string; status: string; ownerName: string }>;
  inventory: { kind: InventoryMovementKind | "none"; movements: InventoryMovement[] };
  financials: {
    sellerNetBeforeCop: number;
    sellerNetAfterCop: number;
    sellerDeltaCop: number;
    driverNetBeforeCop: number;
    driverNetAfterCop: number;
    driverDeltaCop: number;
  };
  warnings: PlanNote[];
  blockers: PlanNote[];
  auditAction: string;
  auditSummary: string;
  /** Parche real del pedido. Los campos con DELETE_FIELD los traduce el callable. */
  orderPatch: Record<string, unknown>;
};

export type PlanInput = {
  order: Record<string, any>;
  /** Asientos del pedido que se corrige. */
  entries: WalletEntryDoc[];
  /** Cortes referenciados por esos asientos. */
  settlementsById: Map<string, SettlementDoc>;
  /** Todos los asientos seller/driver + metadatos de pedidos: para recalcular cortes. */
  cashInputs: DriverCashInputs;
  tariffs: Record<string, number>;
  productCostLines: ProductCostLine[];
  sellerPaysInCash: boolean;
  driverExists: boolean;
  request: CorrectionRequest;
  actorId: string;
  now: string;
};

/** Marcador de campo a borrar. El llamador lo traduce a FieldValue.delete(). */
export const DELETE_FIELD = "__delete__";

const FAILED_LABEL_FIELDS = ["failedReason", "failedCategory", "failedCategorySource", "failedCategoryConfidence"];

/**
 * Asiento que anula a otro sin tocarlo. Se usa cuando el original vive en un corte ya
 * pagado o conciliado.
 *
 * Historico: los scripts escribieron `-correction-reverse-delivery-fee` y
 * `-correction-reverse-driver-pay` para KNT-003259 y KNT-003316. Aqui el sufijo se deriva
 * mecanicamente del id original, asi que salen `-seller-delivery-fee` y
 * `-driver-delivery-pay`. No hay colision posible: esos dos pedidos ya estan corregidos.
 */
export function reversalEntryFor(entry: WalletEntryDoc, now: string): WalletEntryDoc {
  const prefix = `we-${entry.orderId}-`;
  const suffix = entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
  return withOpenSettlementFlags(
    stripUndefined({
      id: `we-${entry.orderId}-correction-reverse-${suffix}`,
      ownerType: entry.ownerType,
      ownerId: entry.ownerId,
      orderId: entry.orderId,
      // Unico cambio de tipo: una reversa de recaudo es una remesa, no un ingreso negativo.
      type: entry.type === "cod_revenue" ? "cod_remittance" : entry.type,
      amountCop: -(Number(entry.amountCop) || 0),
      description: `Reversa por correccion: ${entry.description}`,
      createdAt: now,
      supplierId: entry.supplierId,
      supplierName: entry.supplierName,
      productId: entry.productId,
      productName: entry.productName
    }) as WalletEntryDoc
  );
}

/**
 * Reetiqueta la evidencia existente al sentido nuevo del pedido, conservandola siempre
 * (nunca se borra: es el historico de lo que paso en la calle). Si el pedido no tiene
 * evidencia, sintetiza una COMPLETA — `photoLabel` y `note` son obligatorios en el tipo
 * Evidence y los scripts los omitian.
 */
export function relabelEvidence(
  evidence: EvidenceDoc[],
  direction: "to_delivery" | "to_failed",
  options: { reason: string; failedCategory?: string; actorId: string; now: string; orderId: string }
): EvidenceDoc[] {
  const list = Array.isArray(evidence) ? evidence : [];
  if (list.length === 0) {
    return [
      {
        id: `ev-correction-${options.orderId}-${Date.parse(options.now) || 0}`,
        type: direction === "to_delivery" ? "delivery" : "failed",
        photoLabel: "Correccion administrativa (sin foto)",
        note: options.reason,
        ...(direction === "to_failed"
          ? { reason: options.reason, failedCategory: options.failedCategory ?? "failed_visit" }
          : {}),
        createdAt: options.now,
        actorId: options.actorId
      }
    ];
  }
  return list.map((item) => {
    if (direction === "to_delivery") {
      // Los rotulos de fallido dejan de aplicar; la nota original se conserva.
      const { reason: _reason, failedCategory: _failedCategory, ...rest } = item;
      return { ...rest, type: "delivery" as const };
    }
    return {
      ...item,
      type: "failed" as const,
      reason: item.reason ?? item.note ?? options.reason,
      failedCategory: options.failedCategory ?? "failed_visit"
    };
  });
}

function netOf(entries: WalletEntryDoc[], ownerType: "seller" | "driver") {
  return entries.filter((entry) => entry.ownerType === ownerType).reduce((sum, entry) => sum + (Number(entry.amountCop) || 0), 0);
}

function inventoryKindFor(kind: OrderCorrectionKind): InventoryMovementKind {
  // El cierre anterior ya resolvio la reserva; solo falta mover `available` en un sentido
  // u otro. Al reabrir (retry / reactivacion) el pedido vuelve a estar en la calle: reserva.
  if (kind === "failed_to_delivered") return "consume_available";
  if (kind === "delivered_to_failed") return "restore_available";
  return "reserve";
}

export function planOrderCorrection(input: PlanInput): OrderCorrectionPlan {
  const { order, entries, settlementsById, request, now, actorId } = input;
  const orderId = String(order.id ?? "");
  const fromStatus = String(order.status ?? "");
  const blockers: PlanNote[] = [];
  const warnings: PlanNote[] = [];

  const required = REQUIRED_FROM_STATUS[request.kind];
  if (fromStatus !== required) {
    blockers.push({
      code: "wrong_status",
      message: `El pedido esta en "${fromStatus}" y esta correccion solo aplica a "${required}". Refresca: puede que ya se haya corregido.`
    });
  }
  if (fromStatus === "liquidated") {
    blockers.push({ code: "liquidated_order", message: "El pedido ya esta liquidado: el dinero se giro y no se corrige por aqui." });
  }

  // --- Estado destino y parche del pedido -------------------------------------------------
  const orderPatch: Record<string, unknown> = { updatedAt: now };
  let toStatus = fromStatus;
  let evidence = (Array.isArray(order.evidence) ? order.evidence : []) as EvidenceDoc[];
  let driverId = String(order.driverId ?? "");

  if (request.kind === "failed_to_delivered") {
    toStatus = "delivered";
    driverId = request.driverId || driverId;
    if (!driverId) {
      // Sin domiciliario, buildWalletEntries escribiria ownerId "unassigned" y envenenaria
      // una wallet que no es de nadie.
      blockers.push({ code: "missing_driver", message: "Elige quien hizo la entrega: sin domiciliario no se puede pagar la visita." });
    } else if (!input.driverExists) {
      blockers.push({ code: "driver_not_found", message: `El domiciliario "${driverId}" no existe.` });
    }
    evidence = relabelEvidence(evidence, "to_delivery", { reason: request.reason, actorId, now, orderId });
    orderPatch.status = toStatus;
    orderPatch.driverId = driverId;
    // El pedido nunca llego a recogerse formalmente; se usa el mejor proxy disponible.
    orderPatch.pickedUpAt = order.pickedUpAt ?? order.labelPrintedAt ?? now;
    orderPatch.evidence = evidence;
    orderPatch.retryDecision = DELETE_FIELD;
    for (const field of FAILED_LABEL_FIELDS) orderPatch[field] = DELETE_FIELD;
  } else if (request.kind === "delivered_to_failed") {
    toStatus = "failed";
    const failedCategory = request.failedCategory || "failed_visit";
    evidence = relabelEvidence(evidence, "to_failed", { reason: request.failedReason || request.reason, failedCategory, actorId, now, orderId });
    orderPatch.status = toStatus;
    orderPatch.failedCategory = failedCategory;
    // "manual" es el valor que ya escribe classifyFailedOrder y el unico del tipo Order.
    orderPatch.failedCategorySource = "manual";
    orderPatch.failedReason = request.failedReason || request.reason;
    orderPatch.retryDecision = "pending";
    orderPatch.evidence = evidence;
  } else if (request.kind === "cancelled_to_operational") {
    toStatus = String(request.targetStatus ?? "");
    if (!toStatus) {
      blockers.push({ code: "kind_status_mismatch", message: "Elige a que estado operativo debe volver el pedido." });
    }
    if (request.driverId) {
      driverId = request.driverId;
      if (!input.driverExists) blockers.push({ code: "driver_not_found", message: `El domiciliario "${driverId}" no existe.` });
      orderPatch.driverId = driverId;
    }
    orderPatch.status = toStatus;
    orderPatch.cancelReason = DELETE_FIELD;
    orderPatch.cancelledAt = DELETE_FIELD;
  } else {
    toStatus = "retry_pending";
    if (!request.scheduledDate || !request.scheduledWindow) {
      blockers.push({ code: "kind_status_mismatch", message: "Una nueva visita necesita fecha y franja." });
    }
    orderPatch.status = toStatus;
    orderPatch.retryDecision = "retry";
    orderPatch.scheduledDate = request.scheduledDate;
    orderPatch.scheduledWindow = request.scheduledWindow;
    // La evidencia de la visita perdida se conserva intacta: es el soporte del cobro.
    for (const field of FAILED_LABEL_FIELDS) orderPatch[field] = DELETE_FIELD;
  }

  const nextOrder = stripUndefined({
    ...order,
    status: toStatus,
    driverId: driverId || undefined,
    pickedUpAt: (orderPatch.pickedUpAt as string | undefined) ?? order.pickedUpAt,
    failedCategory: request.kind === "delivered_to_failed" ? orderPatch.failedCategory : undefined,
    evidence
  });

  // --- Reconciliacion de asientos ---------------------------------------------------------
  /**
   * `closedAt` sigue al estado, porque es el eje de fecha con el que se agrupan las cifras de
   * dinero de una comunidad. Volver a un estado operativo lo borra: un pedido reabierto no
   * esta cerrado, y dejarselo puesto lo contaria como entrega de un periodo pasado.
   */
  if (toStatus) {
    const CLOSED = new Set(["delivered", "failed", "cancelled", "liquidated"]);
    orderPatch.closedAt = CLOSED.has(toStatus) ? (order.closedAt ?? now) : DELETE_FIELD;
  }

  const movesMoney = request.kind === "failed_to_delivered" || request.kind === "delivered_to_failed";
  const canonical = movesMoney ? buildWalletEntries(nextOrder, input.tariffs, now, input.productCostLines) : [];
  const canonicalById = new Map(canonical.map((entry) => [entry.id, entry]));

  const entriesToDelete: WalletEntryDoc[] = [];
  const entriesToKeep: WalletEntryDoc[] = [];
  const entriesToCompensate: OrderCorrectionPlan["entriesToCompensate"] = [];
  const frozenSettlements = new Map<string, { id: string; kind: string; status: string; ownerName: string }>();
  const pendingSettlementIds = new Set<string>();
  const consumed = new Set<string>();
  /** Pagos de domiciliario liberados de un corte pendiente, disponibles para heredar. */
  const inheritableDriverSlots: Array<{ ownerId: string; settlementId: string }> = [];

  if (request.kind === "failed_to_retry_pending") {
    // Regla 5: reabrir no mueve dinero. Ni un asiento se toca.
    entriesToKeep.push(...entries);
    const settled = entries.filter((entry) => entry.settlementId);
    if (settled.length > 0) {
      warnings.push({
        code: "settled_entries_kept",
        message: `${settled.length} asiento(s) de la visita perdida ya estan en un corte. Se conservan: la visita se hizo y se cobra igual.`
      });
    }
  } else if (request.kind === "cancelled_to_operational") {
    if (entries.length > 0) {
      blockers.push({
        code: "entries_on_cancelled",
        message: `El pedido anulado tiene ${entries.length} asiento(s) de wallet, algo que no deberia pasar. Revisalo antes de reactivarlo.`
      });
    }
  } else {
    for (const existing of entries) {
      const settlementId = existing.settlementId || "";
      const settlement = settlementId ? settlementsById.get(settlementId) : undefined;
      if (settlementId && !settlement) {
        blockers.push({ code: "settlement_missing", message: `El asiento ${existing.id} apunta al corte ${settlementId}, que no existe.` });
        continue;
      }
      const frozen = Boolean(settlement && (settlement.status === "paid" || settlement.status === "reconciled"));
      const match = canonicalById.get(existing.id);
      if (match && Number(match.amountCop) === Number(existing.amountCop) && match.ownerId === existing.ownerId) {
        entriesToKeep.push(existing);
        consumed.add(existing.id);
        continue;
      }
      if (frozen && settlement) {
        // Regla 1: el corte cerrado no se toca; se compensa en el periodo abierto.
        entriesToCompensate.push({ sourceId: existing.id, frozenSettlementId: settlement.id, entry: reversalEntryFor(existing, now) });
        frozenSettlements.set(settlement.id, { id: settlement.id, kind: settlement.kind, status: settlement.status, ownerName: settlement.ownerName });
        continue;
      }
      entriesToDelete.push(existing);
      if (settlement) {
        pendingSettlementIds.add(settlement.id);
        // Regla 4: solo el pago del domiciliario se hereda. Un cobro a la tienda que cambia
        // de naturaleza (recaudo -> cobro de fallido) nace abierto: no es "el mismo cargo".
        if (existing.type === "driver_earning") inheritableDriverSlots.push({ ownerId: existing.ownerId, settlementId: settlement.id });
      }
    }
  }

  const entriesToCreate: WalletEntryDoc[] = [];
  for (const entry of canonical) {
    if (consumed.has(entry.id)) continue;
    const existing = entries.find((item) => item.id === entry.id);
    if (existing && !entriesToDelete.some((item) => item.id === entry.id)) {
      // Invariante: un id canonico que sigue vivo nunca puede recrearse; seria acunar plata.
      blockers.push({ code: "entry_id_collision", message: `El asiento ${entry.id} ya existe y no fue clasificado. Aborta.` });
      continue;
    }
    let planned = entry;
    if (entry.type === "driver_earning") {
      const slotIndex = inheritableDriverSlots.findIndex((slot) => slot.ownerId === entry.ownerId);
      if (slotIndex >= 0) {
        const [slot] = inheritableDriverSlots.splice(slotIndex, 1);
        planned = { ...entry, settlementId: slot.settlementId };
      }
    }
    entriesToCreate.push(planned);
  }

  // --- Cortes pendientes que hay que recalcular -------------------------------------------
  const deletedIds = new Set(entriesToDelete.map((entry) => entry.id));
  const createdEntries = [...entriesToCreate, ...entriesToCompensate.map((item) => item.entry)];
  const adjustedInputs: DriverCashInputs = {
    sellerEntries: [
      ...input.cashInputs.sellerEntries.filter((entry) => !deletedIds.has(entry.id)),
      ...createdEntries.filter((entry) => entry.ownerType === "seller")
    ],
    driverEntries: [
      ...input.cashInputs.driverEntries.filter((entry) => !deletedIds.has(entry.id)),
      ...createdEntries.filter((entry) => entry.ownerType === "driver")
    ],
    leaderEntries: [
      ...(input.cashInputs.leaderEntries ?? []).filter((entry) => !deletedIds.has(entry.id)),
      ...createdEntries.filter((entry) => entry.ownerType === "community_leader")
    ],
    orderMeta: input.cashInputs.orderMeta
  };
  // Los tres tipos de dueno entran en el recalculo. Dejar fuera al lider vaciaba su corte
  // pendiente al corregir un solo pedido, y el sintoma habria sido cobrar de menos en silencio.
  const allAdjusted = [
    ...adjustedInputs.sellerEntries,
    ...adjustedInputs.driverEntries,
    ...(adjustedInputs.leaderEntries ?? [])
  ];

  const settlementsToRecalculate: PlannedSettlement[] = [];
  for (const settlementId of pendingSettlementIds) {
    const settlement = settlementsById.get(settlementId);
    if (!settlement) continue;
    const finalEntries = allAdjusted.filter((entry) => entry.settlementId === settlementId);
    // Regla del orden: primero el conjunto final de asientos, LUEGO se derivan
    // walletEntryIds y orderIds, y solo entonces se recalcula. Conservar los orderIds
    // viejos deja al corte contando pedidos que ya no aportan nada.
    const walletEntryIds = finalEntries.map((entry) => entry.id);
    const orderIds = Array.from(new Set(finalEntries.map((entry) => entry.orderId).filter(Boolean)));
    const relatedEntryPatches: PlannedSettlement["relatedEntryPatches"] = [];
    const patch: Record<string, unknown> = { walletEntryIds, orderIds };
    const before = {
      walletEntryCount: (settlement.walletEntryIds ?? []).length,
      orderCount: (settlement.orderIds ?? []).length,
      netCop: Number(settlement.netCop) || 0,
      cashExpectedCop: settlement.cashExpectedCop,
      cashPendingCop: settlement.cashPendingCop
    };
    let after: PlannedSettlement["after"];

    if (settlement.kind === "driver") {
      const receivedCop = settlementCashReceivedCop(settlement);
      const summary = computeDriverCashSummary(adjustedInputs, orderIds, receivedCop);
      const expectedCop = summary.expectedCop;
      const pendingCop = Math.max(0, expectedCop - receivedCop);
      const excessCop = Math.max(0, receivedCop - expectedCop);
      const netCop = summary.driverPayCop - summary.codCop;
      Object.assign(patch, {
        codCop: summary.codCop,
        feesCop: summary.feesCop,
        driverPayCop: summary.driverPayCop,
        platformMarginCop: summary.platformMarginCop,
        netCop,
        cashExpectedCop: expectedCop,
        cashPendingCop: pendingCop,
        cashExcessCop: excessCop,
        cashReceiptStatus: expectedCop === 0 || pendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
        cashAllocations: summary.allocations
      });
      // El faltante de efectivo es un asiento propio del corte: si no se mueve con el, la
      // wallet del domiciliario queda descuadrada justo por el delta.
      relatedEntryPatches.push({
        id: `we-${settlement.id}-cash-shortage`,
        amountCop: pendingCop === 0 ? 0 : -pendingCop,
        reason: "faltante de recaudo recalculado"
      });
      after = { walletEntryCount: walletEntryIds.length, orderCount: orderIds.length, netCop, cashExpectedCop: expectedCop, cashPendingCop: pendingCop };
    } else {
      const totals = settlementTotals(settlement.kind, finalEntries, [], settlement.kind === "seller" ? input.sellerPaysInCash : false);
      Object.assign(patch, {
        codCop: totals.codCop,
        feesCop: totals.feesCop,
        productCostCop: totals.productCostCop,
        driverPayCop: totals.driverPayCop,
        platformMarginCop: totals.platformMarginCop,
        gmfCop: totals.gmfCop,
        netCop: totals.netCop
      });
      if (Number(settlement.gmfCop ?? 0) !== totals.gmfCop) {
        // Mismo motivo que el faltante: el 4x1000 es un asiento del corte.
        relatedEntryPatches.push({ id: `we-${settlement.id}-gmf`, amountCop: -totals.gmfCop, reason: "4x1000 recalculado" });
      }
      after = { walletEntryCount: walletEntryIds.length, orderCount: orderIds.length, netCop: totals.netCop };
    }

    settlementsToRecalculate.push({ id: settlement.id, kind: settlement.kind, ownerName: settlement.ownerName, patch, before, after, relatedEntryPatches });
  }

  // --- Avisos ------------------------------------------------------------------------------
  for (const frozen of frozenSettlements.values()) {
    warnings.push({
      code: "frozen_settlement",
      message: `El corte ${frozen.id} de ${frozen.ownerName} esta ${frozen.status === "paid" ? "pagado" : "conciliado"}: no se toca. La diferencia se netea en el proximo corte.`
    });
  }
  if (toStatus === "delivered" && input.productCostLines.length === 0) {
    warnings.push({
      code: "no_product_cost",
      message: "El catalogo no resuelve costo de producto para este pedido: no se cargara ningun costo al proveedor."
    });
  }
  if (toStatus === "failed" && String(orderPatch.failedCategory ?? "") === "failed_visit" && !canonical.some((entry) => entry.type === "failed_fee")) {
    warnings.push({ code: "danda_zero_fee", message: "Por la tarifa de esta tienda, un fallido con visita no genera cobro." });
  }
  const totalOps = entriesToDelete.length + entriesToCreate.length + entriesToCompensate.length;
  if (movesMoney && totalOps === 0) {
    warnings.push({ code: "no_changes", message: "Los asientos ya son los correctos para el estado destino: solo cambia el estado del pedido." });
  }

  // --- Cifras y resumen --------------------------------------------------------------------
  // Los originales congelados SIGUEN existiendo (por eso se compensan en vez de borrarse),
  // asi que el estado final es "todo lo que habia menos lo borrado, mas lo nuevo".
  const afterEntries = [
    ...entries.filter((entry) => !deletedIds.has(entry.id)),
    ...entriesToCreate,
    ...entriesToCompensate.map((item) => item.entry)
  ];
  const sellerNetBeforeCop = netOf(entries, "seller");
  const sellerNetAfterCop = netOf(afterEntries, "seller");
  const driverNetBeforeCop = netOf(entries, "driver");
  const driverNetAfterCop = netOf(afterEntries, "driver");

  const failedAttempt = toStatus === "failed" ? Math.max(1, evidence.filter((item) => item?.type === "failed" && item?.failedCategory).length) : undefined;

  const inventory: OrderCorrectionPlan["inventory"] = orderOwnsInventoryReservation(order)
    ? { kind: inventoryKindFor(request.kind), movements: inventoryMovementsForOrder(order) }
    : { kind: "none", movements: [] };

  const trackingCode = String(order.trackingCode ?? order.shopifyOrderId ?? orderId);
  const frozenList = Array.from(frozenSettlements.values());
  const auditSummary = [
    `Correccion admin ${fromStatus} -> ${toStatus} en ${trackingCode}:`,
    `${entriesToDelete.length} asiento(s) eliminado(s), ${entriesToCreate.length} creado(s), ${entriesToCompensate.length} compensatorio(s);`,
    `neto tienda ${sellerNetBeforeCop} -> ${sellerNetAfterCop}, neto domiciliario ${driverNetBeforeCop} -> ${driverNetAfterCop};`,
    `corte(s) recalculado(s): ${settlementsToRecalculate.map((item) => item.id).join(", ") || "ninguno"};`,
    `corte(s) cerrado(s) intactos: ${frozenList.map((item) => item.id).join(", ") || "ninguno"}.`,
    `Motivo: ${request.reason}`
  ].join(" ");

  const orderPatchPreview: Record<string, string> = {};
  for (const [key, value] of Object.entries(orderPatch)) {
    if (key === "evidence") {
      orderPatchPreview[key] = `${(value as EvidenceDoc[]).length} evidencia(s) reetiquetada(s)`;
    } else {
      orderPatchPreview[key] = value === DELETE_FIELD ? "(se borra)" : String(value ?? "");
    }
  }

  return {
    kind: request.kind,
    orderId,
    trackingCode,
    fromStatus,
    toStatus,
    orderPatchPreview,
    failedAttempt,
    entriesToDelete,
    entriesToCreate,
    entriesToCompensate,
    entriesToKeep,
    settlementsToRecalculate,
    frozenSettlements: frozenList,
    inventory,
    financials: {
      sellerNetBeforeCop,
      sellerNetAfterCop,
      sellerDeltaCop: sellerNetAfterCop - sellerNetBeforeCop,
      driverNetBeforeCop,
      driverNetAfterCop,
      driverDeltaCop: driverNetAfterCop - driverNetBeforeCop
    },
    warnings,
    blockers,
    auditAction: AUDIT_ACTION[request.kind],
    auditSummary,
    orderPatch
  };
}
