/**
 * Correccion administrativa del estado de un pedido ya cerrado.
 *
 * Reemplaza a ocho scripts one-off que se corrian a mano desde el VPS con el id del pedido
 * hardcodeado (correct-cancelled-to-delivered.js, correct-delivered-to-chargeable-failed.js,
 * correct-delivered-to-failed.js, correct-failed-to-delivered.js,
 * correct-knt003316-to-delivered.js, clawback-knt003259.js, clawback-knt561.js,
 * reopen-order-for-retry.js). El razonamiento que justificaba cada uno esta recogido en la
 * cabecera de order-corrections-plan.ts, que es donde vive la matriz de decision.
 *
 * Este archivo es SOLO entrada/salida: leer, planificar, escribir. Ni un peso se calcula
 * aqui.
 *
 * Dos modos, el mismo codigo:
 *   dryRun: true   -> devuelve el plan y su huella, sin escribir nada.
 *   dryRun: false  -> exige la huella del plan aprobado y aplica el batch.
 * Como la planificacion es pura, lo que el admin ve en pantalla es literalmente lo que se
 * escribe: no pueden divergir.
 *
 * Por que un batch y no runTransaction: recalcular un corte necesita los asientos de las dos
 * colecciones completas (ver loadDriverCashInputs). Meter eso en el read-set de una
 * transaccion la haria chocar con cada closeOrder en vuelo. El batch conserva la atomicidad y
 * las precondiciones `lastUpdateTime` dan una concurrencia optimista MAS estricta que el
 * `expectedStatus` de applyOrderTransition: detectan cualquier cambio en el documento, no
 * solo el del estado.
 */
import crypto from "crypto";
import { FieldValue, getFirestore, type Precondition } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  applyInventoryMovements,
  buildSellerInventoryIndex,
  orderOwnsInventoryReservation
} from "./inventory-movements";
import {
  DELETE_FIELD,
  ORDER_CORRECTION_KINDS,
  type OrderCorrectionPlan,
  planOrderCorrection
} from "./order-corrections-plan";
import { loadDriverCashInputs, newAuditRef, OPERATIONAL_TARGET_STATUSES } from "./orders";
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";
import { resolveProductCostLinesForOrder, resolveTariffs } from "./wallet-entries";

const correctOrderStatusSchema = z
  .object({
    orderId: z.string().min(1),
    /** Concurrencia optimista legible: el error crudo de una precondicion no dice nada. */
    expectedStatus: z.enum(["delivered", "failed", "cancelled"]),
    kind: z.enum(ORDER_CORRECTION_KINDS),
    /** Obligatorio: es lo unico que hace util el rastro de auditoria dentro de seis meses. */
    reason: z.string().trim().min(10, "Explica por que se corrige este pedido."),
    dryRun: z.boolean(),
    /** Huella del plan que el admin aprobo. Solo al aplicar. */
    expectedPlanHash: z.string().optional(),
    driverId: z.string().trim().min(1).optional(),
    failedCategory: z.enum(["failed_visit", "no_coverage", "bad_order_or_no_contact", "bad_phone", "pending_review"]).optional(),
    failedReason: z.string().trim().min(1).optional(),
    targetStatus: z.enum(OPERATIONAL_TARGET_STATUSES).optional(),
    scheduledDate: z.string().trim().min(1).optional(),
    scheduledWindow: z.string().trim().min(1).optional()
  })
  .strict();

/**
 * Huella del plan SIN marcas de tiempo. `now` cambia entre la previsualizacion y la
 * aplicacion, asi que incluirlo haria fallar TODOS los apply.
 */
function hashPlan(plan: OrderCorrectionPlan): string {
  const VOLATILE = new Set(["createdAt", "updatedAt", "now", "pickedUpAt"]);
  const stripTimestamps = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripTimestamps);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !VOLATILE.has(key))
          .map(([key, item]) => [key, stripTimestamps(item)])
      );
    }
    return value;
  };
  const shape = stripTimestamps({
    kind: plan.kind,
    orderId: plan.orderId,
    fromStatus: plan.fromStatus,
    toStatus: plan.toStatus,
    entriesToDelete: plan.entriesToDelete,
    entriesToCreate: plan.entriesToCreate,
    entriesToCompensate: plan.entriesToCompensate,
    settlementsToRecalculate: plan.settlementsToRecalculate,
    blockers: plan.blockers
  });
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 32);
}

/** Traduce los marcadores DELETE_FIELD del plan a borrados reales de Firestore. */
function materializeOrderPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value === DELETE_FIELD ? FieldValue.delete() : value])
  );
}

export const correctOrderStatus = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Solo un administrador puede corregir el estado de un pedido.");
  }
  const parsed = correctOrderStatusSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Datos de correccion invalidos.", parsed.error.flatten());
  }
  const input = parsed.data;
  const db = getFirestore();
  const now = new Date().toISOString();

  // --- Lectura ----------------------------------------------------------------------------
  const orderRef = db.collection("orders").doc(input.orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "El pedido no existe.");
  const order = { id: orderSnap.id, ...orderSnap.data() } as Record<string, any>;
  if (String(order.status ?? "") !== input.expectedStatus) {
    throw new HttpsError(
      "failed-precondition",
      `El pedido cambio de estado (ahora ${order.status}). Refresca e intenta de nuevo.`
    );
  }

  const sellerId = String(order.sellerId ?? "");
  const zoneId = typeof order.zoneId === "string" ? order.zoneId : undefined;
  const driverId = input.driverId || String(order.driverId ?? "");
  const needsInventory = orderOwnsInventoryReservation(order) && Boolean(sellerId);

  const [settingsSnap, zoneSnap, catalogSnap, entrySnaps, driverSnap, sellerSnap, inventorySnap] = await Promise.all([
    db.doc("settings/global").get(),
    zoneId ? db.collection("zones").doc(zoneId).get() : Promise.resolve(null),
    sellerId ? db.collection("productCatalog").where("sellerId", "==", sellerId).get() : Promise.resolve(null),
    db.collection("walletEntries").where("orderId", "==", input.orderId).get(),
    driverId ? db.collection("drivers").doc(driverId).get() : Promise.resolve(null),
    sellerId ? db.collection("sellers").doc(sellerId).get() : Promise.resolve(null),
    needsInventory ? db.collection("inventory").where("sellerId", "==", sellerId).get() : Promise.resolve(null)
  ]);

  const entryDocs = entrySnaps.docs.map((doc) => ({ snap: doc, entry: { id: doc.id, ...doc.data() } as WalletEntryDoc }));
  const entries = entryDocs.map((item) => item.entry);
  const settlementIds = Array.from(new Set(entries.map((entry) => entry.settlementId).filter((id): id is string => Boolean(id))));
  const settlementSnaps = await Promise.all(settlementIds.map((id) => db.collection("settlements").doc(id).get()));
  const settlementSnapById = new Map(settlementSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap]));
  const settlementsById = new Map(
    settlementSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, { id: snap.id, ...snap.data() } as SettlementDoc])
  );

  // Los asientos de TODOS los pedidos: es lo que necesita el recalculo de un corte. Se carga
  // una sola vez y se reusa para cuantos cortes toque el plan.
  const cashInputs = await loadDriverCashInputs(
    db,
    // El pedido que se corrige entra siempre, aunque el corte traiga orderIds desactualizados:
    // sin sus metadatos, el recalculo lo ordenaria mal al imputar el efectivo recibido.
    Array.from(new Set([input.orderId, ...Array.from(settlementsById.values()).flatMap((settlement) => settlement.orderIds ?? [])]))
  );

  const sellerCatalog = catalogSnap ? catalogSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Record<string, any>)) : [];

  // --- Planificacion ----------------------------------------------------------------------
  const plan = planOrderCorrection({
    order,
    entries,
    settlementsById,
    cashInputs,
    tariffs: resolveTariffs(settingsSnap.data() ?? {}, zoneSnap?.data()),
    productCostLines: resolveProductCostLinesForOrder(order, sellerCatalog),
    sellerPaysInCash: Boolean(sellerSnap?.data()?.paysInCash),
    driverExists: Boolean(driverSnap?.exists),
    request: {
      kind: input.kind,
      reason: input.reason,
      driverId: input.driverId,
      failedCategory: input.failedCategory,
      failedReason: input.failedReason,
      targetStatus: input.targetStatus,
      scheduledDate: input.scheduledDate,
      scheduledWindow: input.scheduledWindow
    },
    actorId: request.auth.uid,
    now
  });
  const planHash = hashPlan(plan);

  if (input.dryRun) {
    return { dryRun: true, applied: false, planHash, plan };
  }

  // --- Guardas previas a escribir ---------------------------------------------------------
  if (plan.blockers.length > 0) {
    throw new HttpsError("failed-precondition", plan.blockers.map((item) => item.message).join(" "));
  }
  if (!input.expectedPlanHash) {
    throw new HttpsError("invalid-argument", "Falta la huella del plan previsualizado.");
  }
  if (input.expectedPlanHash !== planHash) {
    // Atrapa lo que expectedStatus no ve: por ejemplo un corte que paso a pagado entre la
    // previsualizacion y el confirmar.
    throw new HttpsError("failed-precondition", "plan_stale: los datos cambiaron desde la previsualizacion. Vuelve a previsualizar.");
  }

  // --- Escritura --------------------------------------------------------------------------
  const batch = db.batch();
  const orderPrecondition: Precondition = { lastUpdateTime: orderSnap.updateTime };
  batch.update(orderRef, materializeOrderPatch(plan.orderPatch), orderPrecondition);

  const snapByEntryId = new Map(entryDocs.map((item) => [item.entry.id, item.snap]));
  for (const entry of plan.entriesToDelete) {
    const snap = snapByEntryId.get(entry.id);
    if (!snap) throw new HttpsError("internal", `El asiento ${entry.id} desaparecio entre la lectura y la escritura.`);
    // Sin esta precondicion, un createSettlement concurrente podria estampar settlementId
    // sobre un asiento que estamos borrando y dejar el corte apuntando a un documento muerto.
    batch.delete(snap.ref, { lastUpdateTime: snap.updateTime });
  }
  // `create` y no `set({merge:true})` a proposito: cerrar dos veces un pedido es el mismo
  // cierre, pero corregir dos veces seria una segunda correccion. Debe fallar ruidosamente.
  for (const entry of [...plan.entriesToCreate, ...plan.entriesToCompensate.map((item) => item.entry)]) {
    batch.create(db.collection("walletEntries").doc(entry.id), entry);
  }

  for (const settlement of plan.settlementsToRecalculate) {
    const snap = settlementSnapById.get(settlement.id);
    if (!snap) throw new HttpsError("internal", `El corte ${settlement.id} desaparecio entre la lectura y la escritura.`);
    batch.update(snap.ref, { ...settlement.patch, updatedAt: now }, { lastUpdateTime: snap.updateTime });
    for (const related of settlement.relatedEntryPatches) {
      // Solo se ajusta si el asiento existe: un corte sin faltante nunca creo el suyo.
      const exists = cashInputs.driverEntries.concat(cashInputs.sellerEntries).some((item) => item.id === related.id);
      if (!exists) continue;
      batch.set(db.collection("walletEntries").doc(related.id), { amountCop: related.amountCop, updatedAt: now }, { merge: true });
    }
  }

  if (plan.inventory.kind !== "none" && inventorySnap) {
    applyInventoryMovements(batch, buildSellerInventoryIndex(inventorySnap), plan.inventory.movements, plan.inventory.kind, now);
  }

  const auditRef = newAuditRef(db);
  batch.set(auditRef, {
    id: auditRef.id,
    actorId: request.auth.uid,
    actorRole: role,
    action: plan.auditAction,
    entity: "order",
    entityId: input.orderId,
    fromStatus: plan.fromStatus,
    toStatus: plan.toStatus,
    summary: plan.auditSummary,
    createdAt: now
  });

  await batch.commit();

  const orderAfter = { ...order, ...plan.orderPatch };
  for (const [key, value] of Object.entries(plan.orderPatch)) {
    if (value === DELETE_FIELD) delete orderAfter[key];
  }
  return {
    dryRun: false,
    applied: true,
    planHash,
    plan,
    order: orderAfter,
    walletEntries: [...plan.entriesToCreate, ...plan.entriesToCompensate.map((item) => item.entry)],
    deletedWalletEntryIds: plan.entriesToDelete.map((entry) => entry.id),
    settlements: plan.settlementsToRecalculate.map((settlement) => ({
      ...(settlementsById.get(settlement.id) as SettlementDoc),
      ...settlement.patch,
      updatedAt: now
    }))
  };
});
