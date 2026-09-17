import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  applyInventoryMovements,
  type InventoryIndex,
  inventoryMovementsForOrder,
  normalizeOrderLines,
  orderOwnsInventoryReservation,
  readSellerInventoryIndex,
  skuKeyOf,
  summarizeOrderLines
} from "./inventory-movements";
import { gmfForPayout } from "./gmf";
import { buildCodReceivedSet, isSellerEntryEligible, isWithinSettlementRange } from "./seller-ledger";
import { computeSellerBalance, payoutRejectionMessage, selectSettlementEntries } from "./seller-balance";
import { loadSellerBalanceInput } from "./seller-balance-api";
import {
  computeDriverCashSummary,
  type DriverCashInputs,
  type DriverCashSummary,
  settlementCashReceivedCop,
  type SettlementDoc,
  type SettlementOrderDoc,
  settlementTotals,
  type WalletEntryDoc
} from "./settlement-math";
import { createCommunityPricingResolver } from "./community-order-pricing";
import { CLOSED_STATUSES, MANUAL_EDIT_STAMP } from "./order-import-merge";
import { operationalDataBlockMessage } from "./community-access";
import {
  buildWalletEntries,
  isLiquidationWalletType,
  type ProductCostLine,
  resolveProductCostLinesForOrder,
  resolveTariffs,
  stripUndefined,
  withOpenSettlementFlags
} from "./wallet-entries";

const requiredText = (label: string) => z.string().trim().min(1, `${label} es obligatorio.`);
const optionalText = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}, z.string().trim().min(1).optional());

const manualOrderLineSchema = z.object({
  productName: optionalText,
  sku: optionalText,
  quantity: z.number().int().positive().max(999).optional()
});

const manualOrderSchema = z.object({
  sellerId: requiredText("La tienda"),
  shopifyOrderId: optionalText,
  customerName: requiredText("El nombre del cliente"),
  customerPhone: requiredText("El telefono del cliente"),
  addressRaw: requiredText("La direccion"),
  normalizedAddress: optionalText,
  deliveryNotes: optionalText,
  zoneId: optionalText,
  paymentMethod: z.enum(["cod", "prepaid"]),
  fulfillmentMode: z.enum(["seller_pickup", "warehouse"]),
  totalCop: z.number().positive("El valor del pedido debe ser mayor a cero."),
  productId: optionalText,
  // productName/sku/quantity planos se conservan por compatibilidad: un navegador con el
  // bundle viejo en cache sigue enviandolos y normalizeOrderLines los convierte en una linea.
  productName: optionalText,
  sku: optionalText,
  quantity: z.number().int().positive().max(999).optional(),
  lineItems: z.array(manualOrderLineSchema).max(20).optional(),
  addressRisk: z.enum(["accepted", "review"])
});

const optionalString = z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional());
const optionalUrl = z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional());
const failedCategorySchema = z.enum(["failed_visit", "no_coverage", "bad_order_or_no_contact", "bad_phone", "pending_review"]);

const closeOrderSchema = z.object({
  orderId: z.string().min(1),
  outcome: z.enum(["delivered", "failed"]),
  note: z.string().min(1),
  photoLabel: z.string().min(1),
  photoUrl: optionalUrl,
  storagePath: optionalString,
  reason: optionalString,
  failedCategory: failedCategorySchema.optional(),
  scheduledDate: optionalString,
  scheduledWindow: optionalString
});

// startDate/endDate vacios = rango abierto. Un corte es el total de lo que se debe a la cuenta;
// acotarlo por fechas dejaba fuera lo pendiente mas antiguo. Se conserva el filtro cuando el
// llamante SI manda fechas, porque los cortes historicos se crearon asi.
/**
 * Estados de los que un pedido ya no sale por la via operativa. Definido arriba porque
 * `closeOrder` lo necesita para sellar `closedAt`, que es el eje de fecha del dinero.
 */
// Una sola lista, definida en el nucleo de la spec 017: dos listas iguales terminan divergiendo, y
// si divergieran, una reimportacion trataria un pedido cerrado como abierto y le refrescaria el
// catalogo (RF_09 caido, sin error y sin aviso).
const TERMINAL_STATUS = new Set<string>(CLOSED_STATUSES);

const settlementSchema = z.object({
  kind: z.enum(["seller", "driver", "supplier", "community_leader"]),
  ownerId: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  walletEntryIds: z.array(z.string().min(1)).optional(),
  note: optionalString,
  /** Si en ESTE corte se cobro el 4x1000. Sin valor, se hereda de la marca de la cuenta. */
  chargeGmf: z.boolean().optional()
});

const settlementStatusSchema = z.object({
  settlementId: z.string().min(1),
  status: z.enum(["paid", "reconciled"]),
  // Monto REALMENTE transferido. Si es menor al neto del corte, la diferencia se
  // restituye como saldo por pagar en vez de darse por pagada (paso con el corte de
  // DANDA del 30-jul: se marco pagado por 8.758.000 y solo se transfirieron 6.200.000).
  paidAmountCop: z.number().nonnegative().optional(),
  note: optionalString
});

const driverCashReceiptSchema = z.object({
  settlementId: z.string().min(1),
  receivedNowCop: z.number().min(0),
  note: optionalString
});

const sellerAbonoSchema = z.object({
  sellerId: z.string().min(1),
  amountCop: z.number().positive(),
  note: optionalString,
  /**
   * Si en ESTE abono se cobro el 4x1000. Sin valor, se hereda de la marca de la cuenta.
   * Va por transaccion porque un mismo vendedor puede recibir una vez en efectivo y otra por
   * transferencia, y quien paga lo sabe en el momento, no antes.
   */
  chargeGmf: z.boolean().optional()
});

const supplierAbonoSchema = z.object({
  supplierId: z.string().min(1),
  amountCop: z.number().positive(),
  note: optionalString,
  /** Si en ESTE abono se cobro el 4x1000. Sin valor, se hereda de la marca de la cuenta. */
  chargeGmf: z.boolean().optional()
});

const confirmImportedOrderSchema = z.object({
  orderId: z.string().min(1)
});

const confirmRetryOrderSchema = z.object({
  orderId: z.string().min(1)
});

const classifyFailedOrderSchema = z.object({
  orderId: z.string().min(1),
  failedCategory: failedCategorySchema
});

const cancelOrderSchema = z.object({
  orderId: z.string().min(1),
  reason: optionalString
});

const updateImportedOrderSchema = z.object({
  orderId: z.string().min(1),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  addressRaw: z.string().min(1),
  normalizedAddress: optionalString,
  deliveryNotes: optionalString,
  zoneId: optionalString,
  paymentMethod: z.enum(["cod", "prepaid"]),
  fulfillmentMode: z.enum(["seller_pickup", "warehouse"]),
  totalCop: z.number().positive(),
  productId: optionalString,
  productName: optionalString,
  sku: optionalString,
  quantity: z.number().positive().optional()
});

const updateOrderAdjustmentsSchema = z.object({
  orderId: z.string().min(1),
  totalCop: z.number().positive(),
  productId: optionalString,
  productName: optionalString,
  sku: optionalString,
  quantity: z.number().positive().optional()
});

const createMessengerSchema = z.object({
  messengerId: optionalString,
  name: z.string().min(1),
  phone: optionalString,
  leaderDriverId: optionalString,
  email: optionalString,
  password: optionalString
});

const pickupBatchSchema = z.object({
  orderIds: z.array(z.string().trim().min(1)).min(1)
});

const assignMessengerSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1),
  messengerId: z.string().min(1)
});

const unassignMessengerSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1)
});

type FailedCategory = z.infer<typeof failedCategorySchema>;

/**
 * Referencia para un evento de auditoria con ID autogenerado por Firestore.
 *
 * Antes cada sitio usaba `audit-${Date.now()}` como ID de documento: dos acciones en el
 * mismo milisegundo se pisaban en silencio y el rastro se perdia justo cuando habia
 * concurrencia, que es cuando la evidencia importa. Varios sitios ademas llamaban a
 * `Date.now()` dos veces (una para el ID del doc y otra para el campo `id`), asi que un
 * cambio de milisegundo entre ambas dejaba el campo `id` sin coincidir con el doc.
 *
 * El ID autogenerado elimina las dos fallas por construccion. Quien lo use debe escribir
 * `id: ref.id` para que el campo siga coincidiendo con el documento (`state-store.ts` y el
 * tipo `AuditEvent` lo asumen).
 */
export function newAuditRef(db: FirebaseFirestore.Firestore) {
  return db.collection("auditEvents").doc();
}

function zodFieldMessage(error: z.ZodError) {
  const flat = error.flatten();
  const messages = Object.entries(flat.fieldErrors)
    .flatMap(([field, errors]) => (errors ?? []).map((message) => `${field}: ${message}`));
  return messages.length > 0 ? `Revisa los datos del pedido. ${messages.join(" ")}` : "Revisa los datos del pedido.";
}

export const createManualOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller" && role !== "seller_logistics")) {
    throw new HttpsError("permission-denied", "Tu usuario no tiene permiso para crear pedidos.");
  }

  const parsed = manualOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", zodFieldMessage(parsed.error), parsed.error.flatten());
  }

  const input = parsed.data;
  if ((role === "seller" || role === "seller_logistics") && !sellerClaim) {
    throw new HttpsError("permission-denied", "Tu usuario no tiene una tienda asociada.");
  }
  if ((role === "seller" || role === "seller_logistics") && input.sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Solo puedes crear pedidos de tu propia tienda.");
  }

  const db = getFirestore();
  const seller = await db.collection("sellers").doc(input.sellerId).get();
  if (!seller.exists) {
    throw new HttpsError("not-found", "No se encontro el perfil de la tienda.");
  }

  const sellerData = seller.data() ?? {};
  const requestedNumber = input.shopifyOrderId?.trim();
  const formattedRequestedNumber = requestedNumber && (requestedNumber.startsWith("#") || requestedNumber.startsWith("MAN-")) ? requestedNumber : requestedNumber ? `#${requestedNumber}` : undefined;
  if (formattedRequestedNumber) {
    const duplicate = await db.collection("orders").where("sellerId", "==", input.sellerId).where("shopifyOrderId", "==", formattedRequestedNumber).limit(1).get();
    if (!duplicate.empty) {
      throw new HttpsError("already-exists", "Ya existe un pedido con esa referencia de la tienda.");
    }
  }

  const now = new Date().toISOString();
  const auditRef = newAuditRef(db);
  const lines = normalizeOrderLines(input);
  const collapsed = summarizeOrderLines(lines);
  const movements = inventoryMovementsForOrder(collapsed);
  /**
   * RF_44: una tienda registrada por enlace entra a la app, pero no crea pedidos hasta tener
   * ciudad, punto de recogida y cuenta bancaria. Sin eso no hay donde recoger ni a quien pagar.
   *
   * La decision y el texto viven en `community-access.ts`, como funcion pura y probada: aqui
   * dentro no se puede afirmar nada sin registrar una tienda de verdad y llamar a la callable.
   * Alli esta tambien el porque de comparar contra `false` EXPLICITO —las tiendas que ya
   * existian no tienen el campo, y tratarlas como incompletas dejaria a toda la plataforma sin
   * poder crear pedidos—. El `HttpsError` se sigue construyendo aqui.
   */
  const bloqueo = operationalDataBlockMessage(sellerData);
  if (bloqueo) throw new HttpsError("failed-precondition", bloqueo);

  /**
   * El precio de comunidad se congela AQUI, antes de abrir la transaccion: son lecturas de
   * otras colecciones y meterlas en el read-set del pedido no aporta nada. Un cambio de precio
   * justo en este instante afecta al pedido siguiente, no a este.
   */
  const zoneSnap = input.zoneId ? await db.collection("zones").doc(input.zoneId).get() : null;
  const pricingStamp = await createCommunityPricingResolver(db)(
    { id: input.sellerId, ...sellerData },
    zoneSnap?.data() ?? undefined,
    now
  );

  const order = await db.runTransaction(async (transaction) => {
    // Todas las lecturas antes de cualquier escritura (requisito de las transacciones).
    const inventoryIndex = movements.length > 0
      ? await readSellerInventoryIndex(transaction, db.collection("inventory"), input.sellerId)
      : null;
    const nextTracking = await nextTrackingCode(transaction);
    const trackingCode = nextTracking.code;
    const orderId = `ord-${trackingCode.toLowerCase()}`;
    const orderNumber = formattedRequestedNumber || `MAN-${trackingCode}`;
    // Se reserva lo que exista en inventario; los SKU sin ficha no bloquean el pedido.
    const reservedSomething = Boolean(inventoryIndex && movements.some((movement) => inventoryIndex.has(movement.skuKey)));
    if (inventoryIndex) applyInventoryMovements(transaction, inventoryIndex, movements, "reserve", now);
    transaction.set(nextTracking.ref, { next: nextTracking.next + 1, prefix: "KNT", updatedAt: now }, { merge: true });
    const orderDoc = stripUndefined({
      id: orderId,
      trackingCode,
      shopifyOrderId: orderNumber,
      sellerId: input.sellerId,
      cityId: typeof sellerData.cityId === "string" ? sellerData.cityId : "city-cali",
      zoneId: input.zoneId || undefined,
      driverId: null,
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim(),
      addressRaw: input.addressRaw.trim(),
      normalizedAddress: input.normalizedAddress?.trim() || undefined,
      deliveryNotes: input.deliveryNotes?.trim() || undefined,
      addressRisk: input.addressRisk,
      status: input.addressRisk === "review" ? "address_risk" : "ready_to_assign",
      paymentMethod: input.paymentMethod,
      fulfillmentMode: input.fulfillmentMode,
      totalCop: input.totalCop,
      productId: input.productId?.trim() || undefined,
      productName: collapsed.productName,
      sku: collapsed.sku,
      quantity: collapsed.quantity,
      lineItems: collapsed.lineItems.length > 0 ? collapsed.lineItems : undefined,
      // Marcador: solo los pedidos que reservaron algo pueden liberarlo al cerrarse.
      inventoryReserved: reservedSomething ? true : undefined,
      pickupPointName: typeof sellerData.pickupPointName === "string" && sellerData.pickupPointName.trim() ? sellerData.pickupPointName.trim() : String(sellerData.name ?? "Punto de recogida"),
      pickupAddress: typeof sellerData.pickupAddress === "string" ? sellerData.pickupAddress.trim() : "",
      evidence: [],
      // Precio de comunidad congelado al crear: es lo que se cobrara al cerrar, pase lo que
      // pase con la tarifa entretanto.
      communityId: pricingStamp.communityId,
      communityPricing: pricingStamp.communityPricing,
      createdAt: now,
      updatedAt: now
    });
    transaction.set(db.collection("orders").doc(orderDoc.id), orderDoc);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.manual_created",
      entity: "order",
      entityId: orderDoc.id,
      summary: lines.length > 0
        ? `Pedido manual ${orderDoc.trackingCode} creado (${lines.length} linea${lines.length === 1 ? "" : "s"}, ${collapsed.quantity} unidad${collapsed.quantity === 1 ? "" : "es"})`
        : `Pedido manual ${orderDoc.trackingCode} creado`,
      createdAt: now
    });
    return orderDoc;
  });

  return { order };
});

// 512 MiB no es por memoria sino por CPU: en Cloud Functions la CPU va atada a la memoria, y
// el arranque en frio medido contra produccion era de 2,33 s incluso en una funcion trivial.
// Esta esta en la ruta caliente del domiciliario, que lo paga al cerrar el primer pedido del
// dia. Sin `minInstances`: eso si tendria coste fijo mensual.
export const confirmImportedOrder = onCall({ memory: "512MiB" }, async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller" && role !== "seller_logistics")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can confirm imported orders.");
  }

  const parsed = confirmImportedOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid confirm order data.", parsed.error.flatten());
  }

  const db = getFirestore();
  const orderRef = db.collection("orders").doc(parsed.data.orderId);
  const now = new Date().toISOString();
  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    const sellerId = String(current.sellerId ?? "");
    if ((role === "seller" || role === "seller_logistics") && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only confirm their own orders.");
    }
    if (current.status !== "imported") {
      throw new HttpsError("failed-precondition", "Only imported orders can be confirmed.");
    }
    const updated = {
      ...current,
      addressRisk: "accepted",
      status: "ready_to_assign",
      // Deja explicito en el propio pedido que lo confirmo una persona, para contrastarlo
      // contra las confirmaciones automaticas del bot ("uchat" / "uchat_pull").
      confirmedVia: "manual",
      updatedAt: now
    };
    transaction.set(orderRef, updated, { merge: true });
    const auditRef = newAuditRef(db);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.seller_confirmed",
      entity: "order",
      entityId: snap.id,
      fromStatus: "imported",
      toStatus: "ready_to_assign",
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} confirmado por ${role === "admin" ? "admin" : "vendedor"}`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
});

/**
 * Resuelve las lineas de un pedido que se esta editando desde un formulario que solo
 * maneja los campos planos (productName/sku/quantity).
 *
 * Un pedido MULTI-LINEA no se puede reconstruir desde esos campos: `sku` viene pegado
 * ("A + B") y `quantity` es la suma de unidades. Rearmarlo fabricaba un SKU inexistente
 * -que nunca matchea el catalogo- y hacia que el costo se cobrara como
 * "costo del combo x total de unidades", duplicandolo. Por eso, cuando el pedido ya
 * tiene 2+ lineas se conservan tal cual y los campos planos se re-derivan DESDE ellas,
 * nunca al reves.
 */
function resolveEditedOrderLines(
  input: { productName?: string; sku?: string; quantity?: number },
  current: Record<string, unknown>
): { summary: ReturnType<typeof summarizeOrderLines> | null; preserved: boolean } {
  const currentLines = Array.isArray(current.lineItems) ? current.lineItems : [];
  if (currentLines.length > 1) {
    return { summary: summarizeOrderLines(normalizeOrderLines({ lineItems: currentLines })), preserved: true };
  }
  const editedProduct = input.productName !== undefined || input.sku !== undefined || input.quantity !== undefined;
  if (!editedProduct) return { summary: null, preserved: false };
  return {
    summary: summarizeOrderLines(normalizeOrderLines({
      productName: input.productName ?? (current.productName as string | undefined),
      sku: input.sku ?? (current.sku as string | undefined),
      quantity: input.quantity ?? (current.quantity as number | undefined)
    })),
    preserved: false
  };
}

export const updateImportedOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller" && role !== "seller_logistics")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can edit imported orders.");
  }

  const parsed = updateImportedOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid imported order data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const orderRef = db.collection("orders").doc(input.orderId);
  const now = new Date().toISOString();
  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    const sellerId = String(current.sellerId ?? "");
    if ((role === "seller" || role === "seller_logistics") && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only edit their own orders.");
    }
    if (current.status !== "imported") {
      throw new HttpsError("failed-precondition", "Only imported orders pending confirmation can be edited.");
    }
    // Edicion manual de producto. Un pedido `imported` nunca reservo inventario, asi que
    // aqui no hay delta de stock que aplicar.
    const { summary: editedSummary, preserved } = resolveEditedOrderLines(input, current);
    const updated = stripUndefined({
      ...current,
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim(),
      addressRaw: input.addressRaw.trim(),
      // Si el cliente no la envia, stripUndefined quita la clave y el merge conserva la corregida del mensajero (spec 013, RF_11).
      normalizedAddress: input.normalizedAddress?.trim(),
      deliveryNotes: input.deliveryNotes?.trim() || undefined,
      zoneId: input.zoneId?.trim(),
      paymentMethod: input.paymentMethod,
      fulfillmentMode: input.fulfillmentMode,
      totalCop: input.totalCop,
      productId: input.productId?.trim(),
      // Con lineas preservadas los campos planos salen de las lineas reales.
      productName: preserved ? editedSummary?.productName : input.productName?.trim(),
      sku: preserved ? editedSummary?.sku : input.sku?.trim(),
      quantity: preserved ? editedSummary?.quantity : input.quantity,
      lineItems: editedSummary?.lineItems,
      // Spec 017 (RF_17): la marca de que este pedido ya se toco a mano. Sin ella, "sigue
      // importado" se leeria como "nadie lo ha tocado" y una reimportacion se llevaria esta
      // correccion sin error y sin aviso.
      [MANUAL_EDIT_STAMP]: now,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    const auditRef = newAuditRef(db);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.imported_updated",
      entity: "order",
      entityId: snap.id,
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} editado antes de confirmar`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
});

export const confirmRetryOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller" && role !== "seller_logistics")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can confirm retries.");
  }

  const parsed = confirmRetryOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid retry confirmation data.", parsed.error.flatten());
  }

  const db = getFirestore();
  const orderRef = db.collection("orders").doc(parsed.data.orderId);
  const auditRef = newAuditRef(db);
  const now = new Date().toISOString();

  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    const sellerId = String(current.sellerId ?? "");
    if ((role === "seller" || role === "seller_logistics") && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only confirm retries for their own orders.");
    }
    if (String(current.status ?? "") !== "failed") {
      throw new HttpsError("failed-precondition", "Only failed orders can be confirmed for retry.");
    }

    const updated = stripUndefined({
      ...current,
      status: current.addressRisk === "review" ? "address_risk" : "ready_to_assign",
      driverId: null,
      messengerId: null,
      pickupBatchId: null,
      callOutcome: "pending",
      retryDecision: "retry",
      retryConfirmedAt: now,
      retryConfirmedBy: request.auth?.uid,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.retry_confirmed",
      entity: "order",
      entityId: snap.id,
      fromStatus: "failed",
      toStatus: String(updated.status ?? ""),
      summary: `Reintento confirmado para ${current.trackingCode ?? current.shopifyOrderId ?? snap.id}`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
});

export const classifyFailedOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Solo admins pueden clasificar fallidos pendientes.");
  }

  const parsed = classifyFailedOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Datos invalidos para clasificar el fallido.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const orderRef = db.collection("orders").doc(input.orderId);
  const settingsRef = db.doc("settings/global");
  const auditRef = newAuditRef(db);
  const now = new Date().toISOString();

  return db.runTransaction(async (transaction) => {
    const [orderSnap, settingsSnap] = await Promise.all([transaction.get(orderRef), transaction.get(settingsRef)]);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Pedido no encontrado.");
    const order = { id: orderSnap.id, ...orderSnap.data() } as Record<string, any>;
    if (String(order.status ?? "") !== "failed") {
      throw new HttpsError("failed-precondition", "Solo se pueden clasificar pedidos fallidos.");
    }
    if (String(order.failedCategory ?? "pending_review") !== "pending_review") {
      throw new HttpsError("failed-precondition", "Este fallido ya tiene clasificacion. Ajustalo manualmente con soporte si requiere cambio financiero.");
    }

    const existingEntriesSnap = await transaction.get(db.collection("walletEntries").where("orderId", "==", input.orderId));
    const hasFinancialEntries = existingEntriesSnap.docs.some((doc) => {
      const type = String(doc.data().type ?? "");
      return ["failed_fee", "driver_earning", "fulfillment_fee"].includes(type);
    });
    if (hasFinancialEntries) {
      throw new HttpsError("failed-precondition", "Este pedido ya tiene movimientos financieros. No se puede reclasificar desde esta accion.");
    }

    const zoneId = typeof order.zoneId === "string" ? order.zoneId : undefined;
    const zoneSnap = zoneId ? await transaction.get(db.collection("zones").doc(zoneId)) : null;
    const updated = stripUndefined({
      ...order,
      failedCategory: input.failedCategory,
      failedCategorySource: "manual",
      updatedAt: now
    });
    const walletEntries = input.failedCategory === "failed_visit"
      ? buildWalletEntries(updated, resolveTariffs(settingsSnap.data() ?? {}, zoneSnap?.data()), now, null)
      : [];

    transaction.set(orderRef, updated, { merge: true });
    for (const entry of walletEntries) {
      transaction.set(db.collection("walletEntries").doc(entry.id), entry, { merge: true });
    }
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.failed_classified",
      entity: "order",
      entityId: orderSnap.id,
      summary: `Fallido ${order.trackingCode ?? order.shopifyOrderId ?? orderSnap.id} clasificado como ${input.failedCategory}`,
      createdAt: now
    });
    return { order: { id: orderSnap.id, ...updated }, walletEntries };
  });
});

export const updateOrderAdjustments = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can edit order financial adjustments.");
  }

  const parsed = updateOrderAdjustmentsSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid order adjustment data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const orderRef = db.collection("orders").doc(input.orderId);
  const now = new Date().toISOString();
  const auditRef = newAuditRef(db);
  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    // Misma lista que TERMINAL_STATUS, y por el mismo motivo: si divergiera, el admin podria
    // ajustar producto y recaudo de un pedido ya cerrado (principio 10).
    if (TERMINAL_STATUS.has(String(current.status))) {
      throw new HttpsError("failed-precondition", "Closed, cancelled or liquidated orders cannot be adjusted from this form.");
    }
    // Edicion manual de producto (ver resolveEditedOrderLines: un pedido multi-linea
    // conserva sus lineas en vez de rearmarse desde los campos pegados).
    const { summary: editedSummary, preserved } = resolveEditedOrderLines(input, current);
    // Si el pedido tenia reserva viva, cambiar producto/cantidad debe mover el stock en el
    // acto; si no, `reserved` queda desfasado hasta que alguien reconcilie.
    const sellerId = String(current.sellerId ?? "");
    const adjustsReservation = Boolean(editedSummary) && orderOwnsInventoryReservation(current) && Boolean(sellerId);
    const inventoryIndex = adjustsReservation
      ? await readSellerInventoryIndex(transaction, db.collection("inventory"), sellerId)
      : null;
    const nextMovements = editedSummary ? inventoryMovementsForOrder(editedSummary) : [];
    if (inventoryIndex) {
      applyInventoryMovements(transaction, inventoryIndex, inventoryMovementsForOrder(current), "release", now);
      applyInventoryMovements(transaction, inventoryIndex, nextMovements, "reserve", now);
    }
    const updated = stripUndefined({
      ...current,
      totalCop: input.totalCop,
      productId: input.productId?.trim(),
      productName: preserved ? editedSummary?.productName : input.productName?.trim(),
      sku: preserved ? editedSummary?.sku : input.sku?.trim(),
      quantity: preserved ? editedSummary?.quantity : input.quantity,
      lineItems: editedSummary?.lineItems,
      // El marcador sigue al stock: si el producto nuevo no tiene ficha, ya no hay nada que liberar.
      inventoryReserved: inventoryIndex ? nextMovements.some((movement) => inventoryIndex.has(movement.skuKey)) : undefined,
      // Spec 017 (RF_17): este ajuste toca el RECAUDO de un pedido que puede ir ya en la calle, asi
      // que es la edicion manual mas cara de perder. La marca impide que una reimportacion la pise.
      [MANUAL_EDIT_STAMP]: now,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.adjusted",
      entity: "order",
      entityId: snap.id,
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} ajustado: producto/recaudo/cantidad`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
});

export const createMessengerProfile = onCall(async (request) => {
  const role = request.auth?.token.role;
  const driverClaim = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : undefined;
  if (!request.auth || (role !== "admin" && role !== "driver")) {
    throw new HttpsError("permission-denied", "Only admins and logistics leaders can create messengers.");
  }

  const parsed = createMessengerSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid messenger data.", parsed.error.flatten());
  }

  const leaderDriverId = role === "admin" ? parsed.data.leaderDriverId : driverClaim;
  if (!leaderDriverId) throw new HttpsError("invalid-argument", "leaderDriverId is required.");

  const db = getFirestore();
  const driverSnap = await db.collection("drivers").doc(leaderDriverId).get();
  if (!driverSnap.exists) throw new HttpsError("not-found", "Logistics leader not found.");

  const now = new Date().toISOString();
  const ref = parsed.data.messengerId
    ? db.collection("messengers").doc(parsed.data.messengerId)
    : db.collection("messengers").doc(`messenger-${Date.now()}`);
  if (parsed.data.messengerId) {
    const current = await ref.get();
    if (!current.exists || current.data()?.leaderDriverId !== leaderDriverId) {
      throw new HttpsError("permission-denied", "Messenger does not belong to this logistics leader.");
    }
  }

  const email = parsed.data.email?.trim().toLowerCase();
  const password = parsed.data.password ?? "";
  let authUid: string | undefined;
  let existingUser = false;
  if (email || password) {
    if (!email || password.length < 6) {
      throw new HttpsError("invalid-argument", "Email and password with at least 6 characters are required for messenger login.");
    }
    let user;
    try {
      user = await getAuth().createUser({ email, password, displayName: parsed.data.name.trim() });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      if (code !== "auth/email-already-exists") throw error;
      user = await getAuth().getUserByEmail(email);
      existingUser = true;
      if (user.displayName !== parsed.data.name.trim()) {
        user = await getAuth().updateUser(user.uid, { displayName: parsed.data.name.trim() });
      }
    }
    authUid = user.uid;
    await getAuth().setCustomUserClaims(user.uid, {
      role: "messenger",
      messengerId: ref.id
    });
  }

  const messenger = {
    id: ref.id,
    leaderDriverId,
    name: parsed.data.name.trim(),
    phone: parsed.data.phone?.trim() || "",
    email,
    authUid,
    active: true,
    createdAt: parsed.data.messengerId ? undefined : now,
    updatedAt: now
  };
  const cleanMessenger = stripUndefined(messenger);
  await ref.set(cleanMessenger, { merge: true });
  return { messenger: { ...(await ref.get()).data(), ...cleanMessenger, id: ref.id }, authUid, existingUser };
});

export const createOrUpdatePickupBatch = onCall(async (request) => {
  const role = request.auth?.token.role;
  const driverClaim = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : undefined;
  if (!request.auth || role !== "driver" || !driverClaim) {
    throw new HttpsError("permission-denied", "Only logistics leaders can confirm pickups.");
  }

  const parsed = pickupBatchSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Invalid pickup data.", parsed.error.flatten());

  const db = getFirestore();
  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const orderIds = Array.from(new Set(parsed.data.orderIds));
    const orderRefs = orderIds.map((orderId) => db.collection("orders").doc(orderId));
    const snaps = await Promise.all(orderRefs.map((ref) => transaction.get(ref)));
    const orders = snaps.map((snap) => ({ snap, data: snap.data() ?? {} }));
    const invalid = orders.find(({ snap, data }) => {
      const status = String(data.status ?? "");
      const currentDriverId = typeof data.driverId === "string" ? String(data.driverId) : "";
      const belongsToLeader = currentDriverId === driverClaim;
      const isFreeReady = !currentDriverId && status === "ready_to_assign";
      return !snap.exists || (!belongsToLeader && !isFreeReady) || !["assigned", "ready_to_assign"].includes(status);
    });
    if (invalid) throw new HttpsError("failed-precondition", "Only orders assigned to this leader and pending pickup can be collected.");

    const first = orders[0]?.data ?? {};
    const pickupPointName = String(first.pickupPointName || "Punto de recogida");
    const pickupAddress = String(first.pickupAddress || "");
    const pickupPointKey = `${pickupPointName}|${pickupAddress}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pickup";
    const batchRef = db.collection("pickupBatches").doc(`pb-${Date.now()}`);
    const batch = {
      id: batchRef.id,
      driverId: driverClaim,
      pickupPointKey,
      pickupPointName,
      pickupAddress,
      orderIds: snaps.map((snap) => snap.id),
      status: "closed",
      createdAt: now,
      updatedAt: now,
      closedAt: now
    };
    transaction.set(batchRef, batch);
    for (const { snap, data } of orders) {
      transaction.set(snap.ref, {
        ...data,
        driverId: driverClaim,
        pickupBatchId: batch.id,
        pickedUpAt: now,
        status: "picked_up",
        updatedAt: now
      }, { merge: true });
    }
    return { pickupBatch: batch };
  });
});

export const assignMessengerToOrders = onCall(async (request) => {
  const role = request.auth?.token.role;
  const driverClaim = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : undefined;
  if (!request.auth || role !== "driver" || !driverClaim) {
    throw new HttpsError("permission-denied", "Only logistics leaders can assign messengers.");
  }

  const parsed = assignMessengerSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Invalid assignment data.", parsed.error.flatten());

  const db = getFirestore();
  const messengerSnap = await db.collection("messengers").doc(parsed.data.messengerId).get();
  if (!messengerSnap.exists || messengerSnap.data()?.leaderDriverId !== driverClaim) {
    throw new HttpsError("permission-denied", "Messenger does not belong to this logistics leader.");
  }

  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const orderIds = Array.from(new Set(parsed.data.orderIds));
    const refs = orderIds.map((orderId) => db.collection("orders").doc(orderId));
    const snaps = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const orders = snaps.map((snap) => ({ snap, data: snap.data() ?? {} }));
    const invalid = orders.find(({ snap, data }) => !snap.exists || String(data.driverId ?? "") !== driverClaim || !["picked_up", "scheduled", "call_pending", "in_route", "retry_pending"].includes(String(data.status ?? "")));
    if (invalid) throw new HttpsError("failed-precondition", "Only picked up or active orders assigned to this leader can be assigned to a messenger.");

    const updatedOrders = orders.map(({ snap, data }) => {
      const previousMessengerId = typeof data.messengerId === "string" && data.messengerId ? data.messengerId : undefined;
      const nextStatus = String(data.status ?? "") === "picked_up" ? "call_pending" : String(data.status ?? "");
      const updated = {
        id: snap.id,
        ...data,
        messengerId: parsed.data.messengerId,
        status: nextStatus,
        callOutcome: nextStatus === "call_pending" ? "pending" : data.callOutcome,
        updatedAt: now
      };
      transaction.set(snap.ref, updated, { merge: true });
      if (previousMessengerId && previousMessengerId !== parsed.data.messengerId) {
        const auditRef = newAuditRef(db);
        transaction.set(auditRef, {
          id: auditRef.id,
          actorId: request.auth?.uid,
          actorRole: role,
          action: "order.messenger_reassigned",
          entity: "order",
          entityId: snap.id,
          summary: `Pedido ${data.trackingCode ?? data.shopifyOrderId ?? snap.id} reasignado de mensajero ${previousMessengerId} a ${parsed.data.messengerId} por el lider logistico`,
          createdAt: now
        });
      }
      return updated;
    });
    return { orders: updatedOrders };
  });
});

export const unassignMessengerFromOrders = onCall(async (request) => {
  const role = request.auth?.token.role;
  const driverClaim = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : undefined;
  if (!request.auth || role !== "driver" || !driverClaim) {
    throw new HttpsError("permission-denied", "Only logistics leaders can unassign messengers.");
  }

  const parsed = unassignMessengerSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Invalid unassignment data.", parsed.error.flatten());

  const db = getFirestore();
  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const orderIds = Array.from(new Set(parsed.data.orderIds));
    const refs = orderIds.map((orderId) => db.collection("orders").doc(orderId));
    const snaps = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const orders = snaps.map((snap) => ({ snap, data: snap.data() ?? {} }));
    const invalid = orders.find(({ snap, data }) =>
      !snap.exists
      || String(data.driverId ?? "") !== driverClaim
      || !data.messengerId
      || !["picked_up", "scheduled", "call_pending", "in_route", "retry_pending"].includes(String(data.status ?? ""))
    );
    if (invalid) throw new HttpsError("failed-precondition", "Only active orders of this leader with a messenger assigned can be reverted.");

    const updatedOrders = orders.map(({ snap, data }) => {
      const previousMessengerId = String(data.messengerId ?? "");
      const updated = {
        id: snap.id,
        ...data,
        messengerId: null,
        status: "picked_up",
        callOutcome: null,
        updatedAt: now
      };
      transaction.set(snap.ref, updated, { merge: true });
      const auditRef = newAuditRef(db);
      transaction.set(auditRef, {
        id: auditRef.id,
        actorId: request.auth?.uid,
        actorRole: role,
        action: "order.messenger_unassigned",
        entity: "order",
        entityId: snap.id,
        summary: `Pedido ${data.trackingCode ?? data.shopifyOrderId ?? snap.id} devuelto a pendiente de mensajero (antes: ${previousMessengerId}) por el lider logistico`,
        createdAt: now
      });
      return updated;
    });
    return { orders: updatedOrders };
  });
});

export const cancelOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller" && role !== "seller_logistics")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can cancel orders.");
  }

  const parsed = cancelOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid cancel order data.", parsed.error.flatten());
  }

  const db = getFirestore();
  const orderRef = db.collection("orders").doc(parsed.data.orderId);
  const now = new Date().toISOString();
  const collectedStatuses = new Set(["call_pending", "scheduled", "pickup_pending", "picked_up", "in_route", "retry_pending"]);
  const closedStatuses = new Set(["delivered", "failed", "cancelled", "liquidated"]);

  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    const sellerId = String(current.sellerId ?? "");
    const status = String(current.status ?? "");
    if ((role === "seller" || role === "seller_logistics") && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only cancel their own orders.");
    }
    if (closedStatuses.has(status)) {
      throw new HttpsError("failed-precondition", "Closed orders cannot be cancelled.");
    }
    if ((role === "seller" || role === "seller_logistics") && collectedStatuses.has(status)) {
      throw new HttpsError("failed-precondition", "This order was already collected. Only an admin can cancel it.");
    }

    // Solo libera quien reservo. Un pedido `imported` nunca reservo (cinturon y tirantes).
    const movements = orderOwnsInventoryReservation(current) && status !== "imported"
      ? inventoryMovementsForOrder(current)
      : [];
    const inventoryIndex = movements.length > 0 && sellerId
      ? await readSellerInventoryIndex(transaction, db.collection("inventory"), sellerId)
      : null;
    if (inventoryIndex) applyInventoryMovements(transaction, inventoryIndex, movements, "release", now);

    const updated = stripUndefined({
      ...current,
      status: "cancelled",
      closedAt: now,
      driverId: current.driverId ?? null,
      callNote: parsed.data.reason?.trim() || current.callNote,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    const auditRef = newAuditRef(db);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.cancelled",
      entity: "order",
      entityId: snap.id,
      fromStatus: String(current.status ?? ""),
      toStatus: "cancelled",
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} anulado por ${role === "admin" ? "admin" : role === "seller_logistics" ? "logistico tienda" : "vendedor"}`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
});

export const reconcileInventoryReservations = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can reconcile inventory reservations.");
  }

  const db = getFirestore();
  const [inventorySnap, ordersSnap] = await Promise.all([
    db.collection("inventory").get(),
    db.collection("orders").get()
  ]);
  const closedStatuses = new Set(["delivered", "failed", "cancelled", "liquidated"]);
  const reservedByItem = new Map<string, number>();

  // Solo cuentan los pedidos abiertos que poseen su reserva, y por CANTIDAD de cada linea.
  // Si crear/cancelar/cerrar estan bien, correr esto no debe mover ningun numero.
  ordersSnap.docs.forEach((doc) => {
    const order = doc.data();
    const sellerId = typeof order.sellerId === "string" ? order.sellerId : "";
    const status = typeof order.status === "string" ? order.status : "";
    if (!sellerId || closedStatuses.has(status) || !orderOwnsInventoryReservation(order)) return;
    for (const movement of inventoryMovementsForOrder(order)) {
      const key = `${sellerId}::${movement.skuKey}`;
      reservedByItem.set(key, (reservedByItem.get(key) ?? 0) + movement.quantity);
    }
  });

  const now = new Date().toISOString();
  const batch = db.batch();
  const inventory = inventorySnap.docs.map((doc) => {
    const item = doc.data();
    const sellerId = typeof item.sellerId === "string" ? item.sellerId : "";
    const reserved = reservedByItem.get(`${sellerId}::${skuKeyOf(item.sku) ?? ""}`) ?? 0;
    batch.set(doc.ref, { reserved, updatedAt: now }, { merge: true });
    return { id: doc.id, ...item, reserved };
  });

  await batch.commit();
  return { inventory };
});

async function nextTrackingCode(transaction: Transaction) {
  const counterRef = getFirestore().doc("counters/orders");
  const counterSnap = await transaction.get(counterRef);
  const next = Number(counterSnap.data()?.next ?? 1);
  return { code: `KNT-${String(next).padStart(6, "0")}`, next, ref: counterRef };
}

// 512 MiB no es por memoria sino por CPU: en Cloud Functions la CPU va atada a la memoria, y
// el arranque en frio medido contra produccion era de 2,33 s incluso en una funcion trivial.
// Esta esta en la ruta caliente del domiciliario, que lo paga al cerrar el primer pedido del
// dia. Sin `minInstances`: eso si tendria coste fijo mensual.
export const closeOrder = onCall({ memory: "512MiB" }, async (request) => {
  const role = request.auth?.token.role;
  const driverClaim = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : undefined;
  const messengerClaim = typeof request.auth?.token.messengerId === "string" ? request.auth.token.messengerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "driver" && role !== "messenger")) {
    throw new HttpsError("permission-denied", "Only admins, leaders and assigned messengers can close orders.");
  }

  const parsed = closeOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid close order data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const isVisitRescheduled = input.outcome === "failed" && input.reason === "Cliente reagenda visita";
  if (isVisitRescheduled && (!input.scheduledDate || !input.scheduledWindow)) {
    throw new HttpsError("invalid-argument", "scheduledDate and scheduledWindow are required when the customer reschedules the visit.");
  }

  const db = getFirestore();
  const orderRef = db.collection("orders").doc(input.orderId);
  const settingsRef = db.doc("settings/global");
  const auditRef = newAuditRef(db);
  const now = new Date().toISOString();

  return db.runTransaction(async (transaction) => {
    const [orderSnap, settingsSnap] = await Promise.all([transaction.get(orderRef), transaction.get(settingsRef)]);
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const order = { id: orderSnap.id, ...orderSnap.data() } as Record<string, any>;
    if (role === "driver" && (!driverClaim || order.driverId !== driverClaim)) {
      throw new HttpsError("permission-denied", "Drivers can only close their assigned orders.");
    }
    if (role === "messenger" && (!messengerClaim || order.messengerId !== messengerClaim)) {
      throw new HttpsError("permission-denied", "Messengers can only close their assigned orders.");
    }
    if (!["call_pending", "scheduled", "picked_up", "in_route", "retry_pending"].includes(String(order.status))) {
      throw new HttpsError("failed-precondition", "Only call pending, scheduled, picked up, in route or retry pending orders can be closed.");
    }
    if (input.storagePath && !input.storagePath.startsWith(`evidence/${input.orderId}/`)) {
      throw new HttpsError("invalid-argument", "Evidence storagePath does not match the order.");
    }

    const zoneId = typeof order.zoneId === "string" ? order.zoneId : undefined;
    const needsInventory = orderOwnsInventoryReservation(order) && typeof order.sellerId === "string" && Boolean(order.sellerId);
    const catalogQuery = typeof order.sellerId === "string" && order.sellerId
      ? db.collection("productCatalog").where("sellerId", "==", order.sellerId)
      : null;
    const [zoneSnap, inventoryIndex, catalogSnap] = await Promise.all([
      zoneId ? transaction.get(db.collection("zones").doc(zoneId)) : Promise.resolve(null),
      needsInventory ? readSellerInventoryIndex(transaction, db.collection("inventory"), String(order.sellerId)) : Promise.resolve(null),
      catalogQuery ? transaction.get(catalogQuery) : Promise.resolve(null)
    ]);
    const sellerCatalog = catalogSnap ? catalogSnap.docs.map((catalogDoc) => ({ id: catalogDoc.id, ...catalogDoc.data() } as Record<string, any>)) : [];

    const nextStatus = input.outcome === "delivered" ? "delivered" : isVisitRescheduled ? "retry_pending" : "failed";
    const failedCategory: FailedCategory | undefined = input.outcome === "failed"
      ? isVisitRescheduled
        ? undefined
        : input.failedCategory ?? "failed_visit"
      : undefined;
    const evidence = {
      id: `ev-${Date.now()}`,
      type: input.outcome === "delivered" ? "delivery" : "failed",
      photoLabel: input.photoLabel,
      photoUrl: input.photoUrl,
      storagePath: input.storagePath,
      note: input.note.trim(),
      reason: input.outcome === "failed" ? input.reason?.trim() || "Cliente no recibe" : undefined,
      failedCategory,
      actorId: request.auth?.uid ?? "unknown",
      createdAt: now
    };
    const nextOrder = stripUndefined({
      ...order,
      status: nextStatus,
      /**
       * Instante del cierre. Es el eje de fecha del dinero: las cifras de una comunidad
       * agrupan entregados y fallidos por aqui, no por `createdAt`. Un pedido reabierto a
       * `retry_pending` lo pierde, y vuelve a ganarlo cuando se cierre de nuevo.
       */
      closedAt: TERMINAL_STATUS.has(nextStatus) ? now : order.closedAt,
      failedReason: input.outcome === "failed" ? evidence.reason : order.failedReason,
      failedCategory: nextStatus === "failed" ? failedCategory : order.failedCategory,
      failedCategorySource: nextStatus === "failed" ? "driver" : order.failedCategorySource,
      retryDecision: isVisitRescheduled ? "retry" : input.outcome === "failed" ? "pending" : order.retryDecision,
      scheduledDate: isVisitRescheduled ? input.scheduledDate : order.scheduledDate,
      scheduledWindow: isVisitRescheduled ? input.scheduledWindow : order.scheduledWindow,
      evidence: [...(Array.isArray(order.evidence) ? order.evidence : []), stripUndefined(evidence)],
      updatedAt: now
    });

    transaction.set(orderRef, nextOrder, { merge: true });

    settleInventoryForOrder(transaction, inventoryIndex, nextOrder, input.outcome, isVisitRescheduled, now);
    const productCostLines = resolveProductCostLinesForOrder(nextOrder, sellerCatalog);
    const walletEntries = isVisitRescheduled ? [] : buildWalletEntries(nextOrder, resolveTariffs(settingsSnap.data() ?? {}, zoneSnap?.data()), now, productCostLines);
    for (const entry of walletEntries) {
      transaction.set(db.collection("walletEntries").doc(entry.id), entry, { merge: true });
    }

    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: nextStatus === "delivered" ? "order.delivered" : nextStatus === "failed" ? "order.failed" : "order.retry_scheduled",
      entity: "order",
      entityId: input.orderId,
      fromStatus: String(order.status ?? ""),
      toStatus: String(nextStatus ?? ""),
      summary: nextStatus === "delivered" ? "Pedido entregado y wallet actualizada" : nextStatus === "failed" ? "Pedido fallido y wallet actualizada" : "Visita reagendada por el cliente",
      createdAt: now
    });

    return { order: nextOrder, walletEntries };
  });
});

export const createSettlement = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can create settlements.");
  }

  const parsed = settlementSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid settlement data.", parsed.error.flatten());
  }

  const input = parsed.data;
  if (input.startDate && input.endDate && input.startDate > input.endDate) {
    throw new HttpsError("invalid-argument", "startDate must be before endDate.");
  }
  const isWithinRange = (entryDate: string) => isWithinSettlementRange(entryDate, input.startDate, input.endDate);

  const db = getFirestore();
  const ownerCollection =
    input.kind === "seller" ? "sellers"
    : input.kind === "driver" ? "drivers"
    : input.kind === "community_leader" ? "communities"
    : "suppliers";
  const ownerRef = db.collection(ownerCollection).doc(input.ownerId);
  const explicitEntryDocs = input.walletEntryIds && input.walletEntryIds.length > 0
    ? (await Promise.all(input.walletEntryIds.map((entryId) => db.collection("walletEntries").doc(entryId).get()))).filter((entry) => entry.exists)
    : null;
  const entriesQuery = input.kind === "supplier"
    ? db.collection("walletEntries").where("ownerType", "==", "seller").where("type", "==", "product_cost").where("supplierId", "==", input.ownerId)
    : db.collection("walletEntries").where("ownerType", "==", input.kind).where("ownerId", "==", input.ownerId);
  const entriesSnap = explicitEntryDocs ? null : await entriesQuery.get();
  const sourceDocs = explicitEntryDocs ?? entriesSnap?.docs ?? [];
  const unsettledEntryDocs = sourceDocs
    .filter((entry) => {
      const data = entry.data() ?? {};
      const entryDate = String(data.createdAt ?? "").slice(0, 10);
      const isUnsettled = input.kind === "supplier" ? !data.supplierSettlementId : !data.settlementId;
      const ownerMatches = input.kind === "supplier"
        ? data.ownerType === "seller" && data.type === "product_cost" && data.supplierId === input.ownerId
        : data.ownerType === input.kind && data.ownerId === input.ownerId;
      const inRange = explicitEntryDocs ? true : isWithinRange(entryDate);
      return ownerMatches && isUnsettled && isLiquidationWalletType(String(data.type ?? "")) && inRange;
    });

  let candidateDocs = unsettledEntryDocs;
  if (input.kind === "seller" || input.kind === "supplier") {
    const driverSettlementsSnap = await db
      .collection("settlements")
      .where("kind", "==", "driver")
      .get();
    // Spec 018 RF_04: la definicion unica de "efectivo recibido", la misma de la pantalla.
    const codReceivedOrderIds = buildCodReceivedSet(driverSettlementsSnap.docs.map((doc) => doc.data()));

    const orderIds = Array.from(new Set(unsettledEntryDocs.map((entry) => String((entry.data() ?? {}).orderId ?? "")).filter(Boolean)));
    const orderSnaps = await Promise.all(orderIds.map((orderId) => db.collection("orders").doc(orderId).get()));
    const ordersById = new Map(orderSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() as SettlementOrderDoc]));
    candidateDocs = unsettledEntryDocs.filter((entry) => isSellerEntryEligible(entry.data() ?? {}, ordersById, codReceivedOrderIds));

    // Spec 018 RF_12-RF_15, RF_23, RF_24: en tienda se liquidan pedidos COMPLETOS sin pasar del
    // disponible. El saldo es el de la tienda entera aunque el corte tenga rango o seleccion: lo
    // pagable que queda fuera ya cubre la retencion. Toda la regla vive en selectSettlementEntries.
    if (input.kind === "seller" && candidateDocs.length > 0) {
      const balance = computeSellerBalance(await loadSellerBalanceInput(db, input.ownerId, new Date().toISOString()));
      // RF_22 (R2-RF_20-1): con movimientos que no se pueden atribuir, el saldo no es fiable.
      if (balance.unreadableEntryIds.length > 0) {
        throw new HttpsError("failed-precondition", "No se crea el corte: la tienda tiene movimientos sin pedido legible. Revisalos antes de pagar.");
      }
      const candidates = candidateDocs.map((entry) => ({ id: entry.id, ...entry.data() }) as WalletEntryDoc);
      const choice = selectSettlementEntries(balance, candidates);
      if (!choice.ok) {
        throw new HttpsError("failed-precondition", `No se crea el corte: ${payoutRejectionMessage(balance)}`);
      }
      const selected = new Set(choice.selection.entryIds);
      candidateDocs = candidateDocs.filter((entry) => selected.has(entry.id));
    }
  }

  const candidateRefs = candidateDocs.map((entry) => entry.ref);

  if (candidateRefs.length === 0) {
    if ((input.kind === "seller" || input.kind === "supplier") && unsettledEntryDocs.length > 0) {
      const ownerLabel = input.kind === "supplier" ? "este proveedor" : "esta tienda";
      throw new HttpsError("failed-precondition", `No hay pedidos habilitados para pagar a ${ownerLabel}. Primero marca recibido el dinero del domiciliario.`);
    }
    throw new HttpsError("failed-precondition", "There are no unsettled wallet movements for this account and date range.");
  }

  const settlementRef = db.collection("settlements").doc(`stl-${Date.now()}-${input.kind}-${input.ownerId}`);
  const auditRef = newAuditRef(db);
  const now = new Date().toISOString();

  // Solicitudes de liquidacion abiertas de esta tienda: se cierran cuando el corte se crea de
  // verdad. Es la unica forma de resolver una solicitud, porque el flujo de payout no mueve plata.
  const openPayoutRefs = input.kind === "seller"
    ? (await db.collection("payouts").where("sellerId", "==", input.ownerId).get()).docs
        .filter((doc) => String(doc.data()?.status ?? "") === "requested")
        .map((doc) => doc.ref)
    : [];

  return db.runTransaction(async (transaction) => {
    const ownerSnap = await transaction.get(ownerRef);
    if (!ownerSnap.exists) {
      throw new HttpsError("not-found", "Settlement owner not found.");
    }
    const entrySnaps = await Promise.all(candidateRefs.map((ref) => transaction.get(ref)));
    const unsettledSnaps = entrySnaps
      .filter((snap) => snap.exists)
      .filter((snap) => {
        const entry = { id: snap.id, ...snap.data() } as WalletEntryDoc;
        const entryDate = String(entry.createdAt ?? "").slice(0, 10);
        const isUnsettled = input.kind === "supplier" ? !entry.supplierSettlementId : !entry.settlementId;
        const ownerMatches = input.kind === "supplier"
          ? entry.ownerType === "seller" && entry.type === "product_cost" && entry.supplierId === input.ownerId
          : entry.ownerType === input.kind && entry.ownerId === input.ownerId;
        const inRange = input.walletEntryIds && input.walletEntryIds.length > 0 ? true : isWithinRange(entryDate);
        return ownerMatches && isUnsettled && isLiquidationWalletType(entry.type) && inRange;
      });
    const entries = unsettledSnaps.map((snap) => ({ id: snap.id, ...snap.data() }) as WalletEntryDoc);

    if (entries.length === 0) {
      throw new HttpsError("failed-precondition", "The wallet movements were already settled.");
    }

    const entryOrderIds = Array.from(new Set(entries.map((entry) => entry.orderId).filter(Boolean)));
    const relatedSellerEntries = input.kind === "driver" && entryOrderIds.length > 0
      ? (await transaction.get(db.collection("walletEntries").where("ownerType", "==", "seller")))
        .docs
        .map((doc) => ({ id: doc.id, ...doc.data() }) as WalletEntryDoc)
        .filter((entry) => entry.orderId && entryOrderIds.includes(entry.orderId))
      : [];
    const settlement = buildSettlement(
      settlementRef.id,
      input.kind,
      input.ownerId,
      String(ownerSnap.data()?.name ?? input.ownerId),
      input.startDate,
      input.endDate,
      entries,
      now,
      input.note,
      relatedSellerEntries,
      // El override de la pantalla manda sobre la marca de la cuenta: quien paga sabe en el
      // momento si ese giro concreto salio por banco o en efectivo.
      input.chargeGmf === undefined ? Boolean(ownerSnap.data()?.paysInCash) : !input.chargeGmf
    );

    const platformEntry = buildPlatformWalletEntry(settlement, now);
    const gmfEntry = buildGmfWalletEntry(settlement, now);

    transaction.set(settlementRef, settlement);
    for (const snap of unsettledSnaps) {
      transaction.set(snap.ref, input.kind === "supplier" ? { supplierSettlementId: settlement.id } : { settlementId: settlement.id }, { merge: true });
    }
    if (platformEntry) {
      transaction.set(db.collection("walletEntries").doc(platformEntry.id), platformEntry, { merge: true });
    }
    if (gmfEntry) {
      transaction.set(db.collection("walletEntries").doc(gmfEntry.id), gmfEntry, { merge: true });
    }
    for (const payoutRef of openPayoutRefs) {
      transaction.set(payoutRef, { status: "paid", settlementId: settlement.id, paidAt: now }, { merge: true });
    }
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "settlement.created",
      entity: "settlement",
      entityId: settlement.id,
      summary: `Liquidacion creada para ${settlement.ownerName}`,
      createdAt: now
    });

    return {
      settlement,
      walletEntries: [
        ...entries.map((entry) => input.kind === "supplier" ? { ...entry, supplierSettlementId: settlement.id } : { ...entry, settlementId: settlement.id }),
        ...(platformEntry ? [platformEntry] : []),
        ...(gmfEntry ? [gmfEntry] : [])
      ]
    };
  });
});

export const updateSettlementStatus = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can update settlements.");
  }

  const parsed = settlementStatusSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid settlement status data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const settlementRef = db.collection("settlements").doc(input.settlementId);
  const auditRef = newAuditRef(db);
  const now = new Date().toISOString();
  const settlementPreviewSnap = await settlementRef.get();
  if (!settlementPreviewSnap.exists) {
    throw new HttpsError("not-found", "Settlement not found.");
  }
  const settlementPreview = { id: settlementPreviewSnap.id, ...settlementPreviewSnap.data() } as SettlementDoc;
  const previewReceivedCop = settlementCashReceivedCop(settlementPreview);
  const driverCash = settlementPreview.kind === "driver" ? await calculateDriverCashSummary(db, settlementPreview, previewReceivedCop) : null;
  const previewPendingCop = driverCash ? Math.max(0, driverCash.expectedCop - previewReceivedCop) : 0;
  if (driverCash && input.status === "paid" && previewPendingCop > 0) {
    throw new HttpsError("failed-precondition", "Este domiciliario aun tiene saldo pendiente. Registra primero el dinero recibido.");
  }
  if (driverCash && input.status === "reconciled" && previewPendingCop > 0) {
    throw new HttpsError("failed-precondition", "No se puede conciliar un corte de domiciliario con saldo pendiente.");
  }

  return db.runTransaction(async (transaction) => {
    const settlementSnap = await transaction.get(settlementRef);
    if (!settlementSnap.exists) {
      throw new HttpsError("not-found", "Settlement not found.");
    }
    const settlement = { id: settlementSnap.id, ...settlementSnap.data() } as SettlementDoc;
    if (settlement.status === "reconciled") {
      throw new HttpsError("failed-precondition", "Reconciled settlements cannot be changed.");
    }
    if (input.status === "reconciled" && settlement.status !== "paid") {
      throw new HttpsError("failed-precondition", "Only paid settlements can be reconciled.");
    }
    const receivedCop = settlementCashReceivedCop(settlement);
    const liveDriverCash = settlement.kind === "driver" ? await calculateDriverCashSummary(db, settlement, receivedCop) : null;
    const pendingCop = liveDriverCash ? Math.max(0, liveDriverCash.expectedCop - receivedCop) : 0;
    if (liveDriverCash && pendingCop > 0) {
      throw new HttpsError(
        "failed-precondition",
        input.status === "reconciled"
          ? "No se puede conciliar un corte de domiciliario con saldo pendiente."
          : "Este domiciliario aun tiene saldo pendiente. Registra primero el dinero recibido."
      );
    }

    const nextSettlement = stripUndefined({
      ...settlement,
      ...(liveDriverCash ? {
        codCop: liveDriverCash.codCop,
        feesCop: liveDriverCash.feesCop,
        driverPayCop: liveDriverCash.driverPayCop,
        platformMarginCop: liveDriverCash.platformMarginCop,
        netCop: liveDriverCash.driverPayCop - liveDriverCash.codCop,
        cashExpectedCop: liveDriverCash.expectedCop,
        cashReceivedCop: receivedCop,
        cashPendingCop: pendingCop,
        cashReceiptStatus: liveDriverCash.expectedCop === 0 ? "complete" : pendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
        cashAllocations: liveDriverCash.allocations
      } : {}),
      status: input.status,
      paidAt: input.status === "paid" ? now : settlement.paidAt,
      reconciledAt: input.status === "reconciled" ? now : settlement.reconciledAt,
      paidAmountCop: typeof input.paidAmountCop === "number" ? Math.round(input.paidAmountCop) : settlement.paidAmountCop,
      note: input.note?.trim() || settlement.note
    });

    // Pago parcial de un corte de tienda: la diferencia entre el neto y lo realmente
    // transferido vuelve a ser saldo por pagar, para que entre al proximo corte.
    if (settlement.kind === "seller" && typeof input.paidAmountCop === "number") {
      const netCop = Math.round(Number(settlement.netCop) || 0);
      const unpaidCop = netCop - Math.round(input.paidAmountCop);
      if (unpaidCop > 0) {
        const adjustmentId = `we-unpaid-${settlement.id}`;
        transaction.set(db.collection("walletEntries").doc(adjustmentId), withOpenSettlementFlags({
          id: adjustmentId,
          ownerType: "seller",
          ownerId: settlement.ownerId,
          orderId: "",
          type: "seller_abono",
          amountCop: unpaidCop, // positivo: restituye la deuda con la tienda
          description: `Saldo no transferido del corte ${settlement.startDate} a ${settlement.endDate} (neto ${netCop}, transferido ${Math.round(input.paidAmountCop)})`,
          createdAt: now
        }), { merge: true });
      }
    }

    transaction.set(settlementRef, nextSettlement, { merge: true });
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: input.status === "paid" ? "settlement.paid" : "settlement.reconciled",
      entity: "settlement",
      entityId: settlement.id,
      summary: input.status === "paid" ? `Liquidacion pagada ${settlement.ownerName}` : `Liquidacion conciliada ${settlement.ownerName}`,
      createdAt: now
    });

    return { settlement: nextSettlement };
  });
});

export const recordDriverCashReceipt = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can record driver cash receipts.");
  }

  const parsed = driverCashReceiptSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid driver cash receipt data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const settlementRef = db.collection("settlements").doc(input.settlementId);
  const now = new Date().toISOString();

  const settlementSnap = await settlementRef.get();
  if (!settlementSnap.exists) throw new HttpsError("not-found", "Settlement not found.");
  const currentSettlement = { id: settlementSnap.id, ...settlementSnap.data() } as SettlementDoc;
  if (currentSettlement.kind !== "driver") {
    throw new HttpsError("failed-precondition", "Cash receipts can only be recorded for driver settlements.");
  }
  if (currentSettlement.status === "reconciled") {
    throw new HttpsError("failed-precondition", "Reconciled settlements cannot receive cash updates.");
  }

  const cashSummaryBeforeReceipt = await calculateDriverCashSummary(db, currentSettlement, 0);

  return db.runTransaction(async (transaction) => {
    const liveSnap = await transaction.get(settlementRef);
    if (!liveSnap.exists) throw new HttpsError("not-found", "Settlement not found.");
    const settlement = { id: liveSnap.id, ...liveSnap.data() } as SettlementDoc;
    const expectedCop = cashSummaryBeforeReceipt.expectedCop;
    const previousReceivedCop = settlementCashReceivedCop(settlement);
    // Se registra el monto REAL entregado, sin topar en lo esperado. Antes se aplicaba
    // Math.min(..., expectedCop - previousReceivedCop): si el domiciliario entregaba de
    // mas, la diferencia se descartaba en silencio y quedaba sin rastro (de ahi la nota
    // "EXCEDENTE QUE NO SE PUDO REGISTRAR" que aparecio en produccion).
    const receivedNowCop = Math.max(0, Math.round(Number(input.receivedNowCop || 0)));
    const receivedCop = previousReceivedCop + receivedNowCop;
    const pendingCop = Math.max(0, expectedCop - receivedCop);
    // Excedente: lo que el domiciliario entrego por encima de lo esperado. Queda visible
    // para acreditarselo en el proximo corte en vez de desaparecer.
    const excessCop = Math.max(0, receivedCop - expectedCop);
    const cashSummary = await calculateDriverCashSummary(db, settlement, receivedCop);
    const receipts = [
      ...(Array.isArray(settlement.cashReceipts) ? settlement.cashReceipts : []),
      ...(receivedNowCop > 0 ? [stripUndefined({ amountCop: receivedNowCop, receivedAt: now, note: input.note?.trim() || undefined })] : [])
    ];
    const nextSettlement = {
      ...settlement,
      status: pendingCop === 0 ? "paid" : "pending",
      paidAt: pendingCop === 0 ? now : FieldValue.delete(),
      // reconciledAt puede no existir aun; undefined no es valido para Firestore
      reconciledAt: pendingCop === 0 ? settlement.reconciledAt ?? FieldValue.delete() : FieldValue.delete(),
      codCop: cashSummary.codCop,
      feesCop: cashSummary.feesCop,
      driverPayCop: cashSummary.driverPayCop,
      platformMarginCop: cashSummary.platformMarginCop,
      netCop: cashSummary.driverPayCop - cashSummary.codCop,
      cashExpectedCop: expectedCop,
      cashReceivedCop: receivedCop,
      cashPendingCop: pendingCop,
      cashExcessCop: excessCop,
      cashReceiptStatus: expectedCop === 0 ? "complete" : pendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
      cashReceipts: receipts,
      cashAllocations: cashSummary.allocations,
      note: input.note?.trim() || settlement.note || FieldValue.delete()
    };
    const responseSettlement = stripUndefined({
      ...settlement,
      status: pendingCop === 0 ? "paid" : "pending",
      paidAt: pendingCop === 0 ? now : undefined,
      reconciledAt: pendingCop === 0 ? settlement.reconciledAt : undefined,
      codCop: cashSummary.codCop,
      feesCop: cashSummary.feesCop,
      driverPayCop: cashSummary.driverPayCop,
      platformMarginCop: cashSummary.platformMarginCop,
      netCop: cashSummary.driverPayCop - cashSummary.codCop,
      cashExpectedCop: expectedCop,
      cashReceivedCop: receivedCop,
      cashPendingCop: pendingCop,
      cashExcessCop: excessCop,
      cashReceiptStatus: expectedCop === 0 ? "complete" : pendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
      cashReceipts: receipts,
      cashAllocations: cashSummary.allocations,
      note: input.note?.trim() || settlement.note
    });
    const shortageRef = db.collection("walletEntries").doc(`we-${settlement.id}-cash-shortage`);
    transaction.set(settlementRef, nextSettlement, { merge: true });
    transaction.set(shortageRef, withOpenSettlementFlags(stripUndefined({
      id: shortageRef.id,
      ownerType: "driver",
      ownerId: settlement.ownerId,
      orderId: settlement.id,
      type: "cash_shortage",
      amountCop: -pendingCop,
      description: `Saldo pendiente de recaudo ${settlement.ownerName}`,
      createdAt: now,
      settlementId: pendingCop === 0 ? settlement.id : undefined
    })), { merge: true });
    const auditRef = newAuditRef(db);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "settlement.cash_received",
      entity: "settlement",
      entityId: settlement.id,
      summary: `Abono recaudo ${settlement.ownerName}: ${receivedNowCop}`,
      createdAt: now
    });
    return { settlement: responseSettlement, walletEntries: [stripUndefined({ id: shortageRef.id, ownerType: "driver", ownerId: settlement.ownerId, orderId: settlement.id, type: "cash_shortage", amountCop: -pendingCop, description: `Saldo pendiente de recaudo ${settlement.ownerName}`, createdAt: now, settlementId: pendingCop === 0 ? settlement.id : undefined }) as WalletEntryDoc] };
  });
});

/**
 * Abono parcial a un proveedor. El saldo del proveedor no es un asiento propio: se
 * deriva de los product_cost de las tiendas que apuntan a el y aun no estan liquidados.
 * Por eso un abono no puede ser "un asiento negativo" como el de tiendas: se liquidan
 * asientos COMPLETOS, del mas antiguo al mas nuevo, hasta donde alcance el monto.
 *
 * Asi el saldo pendiente siempre cuadra con los pedidos que faltan por pagar, y no se
 * repite lo que paso con el corte de DANDA (marcado como pagado por mas de lo transferido).
 */
export const recordSupplierAbono = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can record supplier abonos.");
  }

  const parsed = supplierAbonoSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid supplier abono data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const supplierSnap = await db.collection("suppliers").doc(input.supplierId).get();
  if (!supplierSnap.exists) throw new HttpsError("not-found", "Supplier not found.");
  const supplierName = String(supplierSnap.data()?.name ?? input.supplierId);

  const entriesSnap = await db
    .collection("walletEntries")
    .where("ownerType", "==", "seller")
    .where("type", "==", "product_cost")
    .where("supplierId", "==", input.supplierId)
    .get();
  const unsettled = entriesSnap.docs
    .map((doc) => ({ ...(doc.data() as WalletEntryDoc), ref: doc.ref, id: doc.id }))
    .filter((entry) => !entry.supplierSettlementId);
  // Solo los negativos se pueden "cubrir" con un abono (son los costos por pagar), pero el
  // saldo real descuenta tambien los POSITIVOS: asientos de cruce, p.ej. fletes que el
  // proveedor nos debe y se compensan contra su cuenta. Sin esto el tope del abono era
  // mayor que la deuda y la seccion de proveedores mostraba una cifra distinta a esta.
  const pending = unsettled
    .filter((entry) => Number(entry.amountCop || 0) < 0)
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));

  const pendingCop = Math.max(0, -unsettled.reduce((sum, entry) => sum + Number(entry.amountCop || 0), 0));
  if (pendingCop <= 0) {
    throw new HttpsError("failed-precondition", "Este proveedor no tiene saldo pendiente.");
  }

  const requestedCop = Math.min(Math.round(Number(input.amountCop)), pendingCop);
  const covered: typeof pending = [];
  let appliedCop = 0;
  for (const entry of pending) {
    const cost = -Math.round(Number(entry.amountCop || 0));
    if (appliedCop + cost > requestedCop) break;
    covered.push(entry);
    appliedCop += cost;
  }

  // Si sobra monto que no alcanza a cubrir otro pedido entero, se PARTE ese pedido:
  // la porcion pagada queda liquidada y el resto sigue pendiente. Asi siempre se
  // registra el monto real transferido y no se pierde el sobrante.
  const now = new Date().toISOString();
  const settlementId = `stl-${Date.now()}-supplier-${input.supplierId}`;
  const remainderCop = requestedCop - appliedCop;
  const splitSource = remainderCop > 0 ? pending[covered.length] : undefined;
  let splitEntry: { id: string; amountCop: number; sourceRemainingCop: number } | undefined;
  if (splitSource && remainderCop > 0) {
    const originalCop = -Math.round(Number(splitSource.amountCop || 0));
    splitEntry = {
      id: `${splitSource.id}-parcial-${Date.now()}`,
      amountCop: -remainderCop,
      // El asiento original se queda solo con la parte que sigue debiendose.
      sourceRemainingCop: -(originalCop - remainderCop)
    };
    appliedCop += remainderCop;
  }

  if (covered.length === 0 && !splitEntry) {
    throw new HttpsError("failed-precondition", "El monto no alcanza a cubrir ningun costo pendiente.");
  }

  const settledIds = [...covered.map((entry) => entry.id), ...(splitEntry ? [splitEntry.id] : [])];
  const orderIds = Array.from(new Set(
    [...covered, ...(splitSource && splitEntry ? [splitSource] : [])].map((entry) => String(entry.orderId ?? "")).filter(Boolean)
  ));
  const dates = [...covered, ...(splitSource && splitEntry ? [splitSource] : [])].map((entry) => String(entry.createdAt ?? now)).sort();
  const settlement = stripUndefined({
    id: settlementId,
    kind: "supplier",
    ownerId: input.supplierId,
    ownerName: supplierName,
    startDate: dates[0].slice(0, 10),
    endDate: dates[dates.length - 1].slice(0, 10),
    walletEntryIds: settledIds,
    orderIds,
    codCop: 0,
    feesCop: 0,
    productCostCop: appliedCop,
    driverPayCop: 0,
    platformMarginCop: 0,
    netCop: appliedCop,
    // El 4x1000 del giro al proveedor. Va contra la plataforma porque el proveedor no tiene
    // wallet propia: su saldo se deriva de los product_cost de las tiendas.
    gmfCop: (input.chargeGmf ?? !Boolean(supplierSnap.data()?.paysInCash)) ? gmfForPayout(appliedCop) : 0,
    status: "paid",
    paidAt: now,
    createdAt: now,
    note: input.note?.trim() || undefined
  }) as SettlementDoc;

  const supplierGmfEntry = buildGmfWalletEntry(settlement, now);

  const batch = db.batch();
  batch.set(db.collection("settlements").doc(settlementId), settlement);
  if (supplierGmfEntry) batch.set(db.collection("walletEntries").doc(supplierGmfEntry.id), supplierGmfEntry);
  for (const entry of covered) batch.set(entry.ref, { supplierSettlementId: settlementId, updatedAt: now }, { merge: true });
  if (splitSource && splitEntry) {
    // El asiento original conserva solo lo que sigue pendiente...
    batch.set(splitSource.ref, { amountCop: splitEntry.sourceRemainingCop, updatedAt: now }, { merge: true });
    // ...y la porcion pagada nace como asiento propio ya liquidado.
    batch.set(db.collection("walletEntries").doc(splitEntry.id), withOpenSettlementFlags(stripUndefined({
      id: splitEntry.id,
      ownerType: "seller",
      ownerId: splitSource.ownerId,
      orderId: splitSource.orderId,
      type: "product_cost",
      amountCop: splitEntry.amountCop,
      description: `${splitSource.description ?? "Costo producto"} (pago parcial)`,
      supplierId: splitSource.supplierId,
      supplierName: splitSource.supplierName,
      productId: splitSource.productId,
      productName: splitSource.productName,
      supplierSettlementId: settlementId,
      createdAt: splitSource.createdAt ?? now
    })), { merge: true });
  }
  const auditRef = newAuditRef(db);
  batch.set(auditRef, {
    id: auditRef.id,
    actorId: request.auth?.uid,
    actorRole: role,
    action: "settlement.supplier_abono",
    entity: "supplier",
    entityId: input.supplierId,
    summary: `Abono a proveedor ${supplierName}: ${appliedCop} sobre un pendiente de ${pendingCop} (${covered.length} pedidos completos${splitEntry ? ` + ${remainderCop} parcial` : ""})`,
    createdAt: now
  });
  await batch.commit();

  return {
    settlement,
    appliedCop,
    requestedCop,
    // Con el pedido partido, el monto siempre se aplica completo.
    unappliedCop: requestedCop - appliedCop,
    remainingCop: pendingCop - appliedCop,
    orders: covered.length,
    partialCop: splitEntry ? remainderCop : 0
  };
});

export const recordSellerAbono = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can record seller abonos.");
  }

  const parsed = sellerAbonoSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid seller abono data.", parsed.error.flatten());
  }

  const input = parsed.data;
  const db = getFirestore();
  const sellerRef = db.collection("sellers").doc(input.sellerId);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists) {
    throw new HttpsError("not-found", "Seller not found.");
  }
  const sellerName = String(sellerSnap.data()?.name ?? input.sellerId);

  // Saldo pendiente = suma de asientos liquidables sin liquidar de la tienda (incluye abonos previos, que son negativos).
  const entriesSnap = await db
    .collection("walletEntries")
    .where("ownerType", "==", "seller")
    .where("ownerId", "==", input.sellerId)
    .get();
  const netOwedCop = entriesSnap.docs
    .map((doc) => doc.data() as WalletEntryDoc)
    .filter((entry) => !entry.settlementId && isLiquidationWalletType(String(entry.type ?? "")))
    .reduce((sum, entry) => sum + Number(entry.amountCop || 0), 0);

  const amountCop = Math.min(Math.round(Number(input.amountCop)), Math.max(0, Math.round(netOwedCop)));
  if (amountCop <= 0) {
    throw new HttpsError("failed-precondition", "La tienda no tiene saldo pendiente para abonar.");
  }

  const now = new Date().toISOString();
  const entryId = `we-abono-${input.sellerId}-${Date.now()}`;
  const abonoEntry: WalletEntryDoc = withOpenSettlementFlags(stripUndefined({
    id: entryId,
    ownerType: "seller",
    ownerId: input.sellerId,
    orderId: "",
    type: "seller_abono",
    amountCop: -amountCop,
    description: input.note?.trim() ? `Abono a tienda ${sellerName}: ${input.note.trim()}` : `Abono a tienda ${sellerName}`,
    createdAt: now
  })) as WalletEntryDoc;
  // El 4x1000 del abono: sale suelto (sin settlementId) para que el siguiente corte lo barra.
  const chargeGmf = input.chargeGmf ?? !Boolean(sellerSnap.data()?.paysInCash);
  const gmfCop = chargeGmf ? gmfForPayout(amountCop) : 0;
  const gmfEntry: WalletEntryDoc | null = gmfCop > 0
    ? (withOpenSettlementFlags(stripUndefined({
        id: `${entryId}-gmf`,
        ownerType: "seller",
        ownerId: input.sellerId,
        orderId: "",
        type: "gmf_tax",
        amountCop: -gmfCop,
        description: `4x1000 del abono a ${sellerName}`,
        createdAt: now
      })) as WalletEntryDoc)
    : null;
  const auditRef = newAuditRef(db);

  const batch = db.batch();
  batch.set(db.collection("walletEntries").doc(entryId), abonoEntry);
  if (gmfEntry) batch.set(db.collection("walletEntries").doc(gmfEntry.id), gmfEntry);
  batch.set(auditRef, {
    id: auditRef.id,
    actorId: request.auth?.uid,
    actorRole: role,
    action: "seller.abono",
    entity: "seller",
    entityId: input.sellerId,
    summary: `Abono de ${amountCop} COP a ${sellerName}`,
    createdAt: now
  });
  await batch.commit();

  return { walletEntry: abonoEntry, gmfEntry, gmfCop, netOwedBeforeCop: Math.round(netOwedCop), amountCop };
});

/**
 * Carga lo que la aritmetica de efectivo necesita del mundo. Se separa de
 * `computeDriverCashSummary` (settlement-math.ts) porque la correccion administrativa de
 * pedidos necesita evaluar el corte sobre un estado que AUN NO se escribio: carga estos
 * inputs una vez, les aplica el delta en memoria y vuelve a calcular.
 *
 * Ojo: barre las dos colecciones de asientos completas. Si se necesita para varios cortes
 * en la misma invocacion, cargarlos UNA vez y reusarlos.
 */
export async function loadDriverCashInputs(db: ReturnType<typeof getFirestore>, orderIds: string[]): Promise<DriverCashInputs> {
  const [sellerEntrySnap, driverEntrySnap, leaderEntrySnap, orderSnaps] = await Promise.all([
    db.collection("walletEntries").where("ownerType", "==", "seller").get(),
    db.collection("walletEntries").where("ownerType", "==", "driver").get(),
    // Hace falta para que corregir un pedido no vacie el corte pendiente de su lider.
    db.collection("walletEntries").where("ownerType", "==", "community_leader").get(),
    Promise.all(orderIds.map((orderId) => db.collection("orders").doc(orderId).get()))
  ]);
  return {
    sellerEntries: sellerEntrySnap.docs.map((doc) => doc.data() as WalletEntryDoc),
    driverEntries: driverEntrySnap.docs.map((doc) => doc.data() as WalletEntryDoc),
    leaderEntries: leaderEntrySnap.docs.map((doc) => doc.data() as WalletEntryDoc),
    orderMeta: new Map(orderSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() as SettlementOrderDoc]))
  };
}

async function calculateDriverCashSummary(db: ReturnType<typeof getFirestore>, settlement: SettlementDoc, receivedCop: number): Promise<DriverCashSummary> {
  const orderIds = Array.from(new Set(settlement.orderIds ?? []));
  if (orderIds.length === 0) {
    return { codCop: 0, feesCop: 0, driverPayCop: 0, platformMarginCop: 0, expectedCop: 0, allocations: [] };
  }
  const inputs = await loadDriverCashInputs(db, orderIds);
  return computeDriverCashSummary(inputs, orderIds, receivedCop);
}

function buildSettlement(
  id: string,
  kind: "seller" | "driver" | "supplier" | "community_leader",
  ownerId: string,
  ownerName: string,
  startDate: string,
  endDate: string,
  entries: WalletEntryDoc[],
  now: string,
  note?: string,
  relatedSellerEntries: WalletEntryDoc[] = [],
  paysInCash = false
): SettlementDoc {
  // La aritmetica vive en settlement-math.ts para que la correccion administrativa de
  // pedidos pueda recalcular un corte sin duplicarla. El gravamen queda ademas como
  // asiento propio para que la wallet de la cuenta cuadre en cero.
  const { codCop, feesCop, productCostCop, driverPayCop, platformMarginCop, gmfCop, netCop } =
    settlementTotals(kind, entries, relatedSellerEntries, paysInCash);
  // Con rango abierto el documento guarda el periodo REAL que cubrio el corte (primer y ultimo
  // movimiento incluido). Sin esto el historico de liquidaciones quedaria con fechas en blanco.
  const entryDates = entries.map((entry) => String(entry.createdAt ?? "").slice(0, 10)).filter(Boolean).sort();
  const resolvedStartDate = startDate || entryDates[0] || now.slice(0, 10);
  const resolvedEndDate = endDate || entryDates[entryDates.length - 1] || now.slice(0, 10);
  return stripUndefined({
    id,
    kind,
    ownerId,
    ownerName,
    startDate: resolvedStartDate,
    endDate: resolvedEndDate,
    walletEntryIds: entries.map((entry) => entry.id),
    orderIds: Array.from(new Set(entries.map((entry) => entry.orderId).filter(Boolean))),
    codCop,
    feesCop,
    productCostCop,
    driverPayCop,
    platformMarginCop,
    netCop,
    gmfCop,
    status: "pending",
    createdAt: now,
    note: note?.trim() || undefined
  });
}

/**
 * Asiento del 4x1000. Va contra la cuenta a la que se le retiene, no contra la plataforma: el
 * dinero es del banco, no un ingreso nuestro. Con el, los movimientos de la cuenta suman
 * exactamente lo que se transfirio y no queda un residuo eterno por la diferencia.
 */
function buildGmfWalletEntry(settlement: SettlementDoc, now: string): WalletEntryDoc | null {
  const gmfCop = Number(settlement.gmfCop ?? 0);
  if (gmfCop <= 0) return null;
  // El proveedor no tiene wallet propia: su saldo se deriva de los product_cost de las tiendas.
  // Ponerle el asiento a `ownerType: "seller"` con el id del PROVEEDOR crearia un movimiento que
  // no es de nadie y descuadraria esa wallet. Va contra la plataforma, que es quien asume el giro.
  const esProveedor = settlement.kind === "supplier";
  return {
    id: `we-${settlement.id}-gmf`,
    ownerType: esProveedor ? ("admin" as const) : (settlement.kind as "seller" | "driver"),
    ownerId: esProveedor ? "platform" : settlement.ownerId,
    orderId: settlement.id,
    type: "gmf_tax",
    amountCop: -gmfCop,
    description: `4x1000 retenido en el corte de ${settlement.ownerName}`,
    createdAt: now,
    settlementId: settlement.id
  };
}

function buildPlatformWalletEntry(settlement: SettlementDoc, now: string): WalletEntryDoc | null {
  if (settlement.kind === "supplier") return null;
  const amountCop = settlement.kind === "seller" ? settlement.feesCop : -settlement.driverPayCop;
  if (amountCop === 0) return null;
  return {
    id: `we-${settlement.id}-platform-margin`,
    ownerType: "admin",
    ownerId: "platform",
    orderId: settlement.id,
    type: "platform_margin",
    amountCop,
    description:
      settlement.kind === "seller"
        ? `Ingreso plataforma por fees ${settlement.ownerName}`
        : `Costo plataforma por pago transportista ${settlement.ownerName}`,
    createdAt: now,
    settlementId: settlement.id
  };
}

function settleInventoryForOrder(
  transaction: Transaction,
  inventoryIndex: InventoryIndex | null,
  order: Record<string, any>,
  outcome: "delivered" | "failed",
  retry: boolean,
  now: string
) {
  if (!inventoryIndex || !orderOwnsInventoryReservation(order)) return;
  if (outcome === "failed" && retry) return;
  const movements = inventoryMovementsForOrder(order);
  applyInventoryMovements(transaction, inventoryIndex, movements, outcome === "delivered" ? "consume" : "release", now);
}

// Transicion operativa validada en el servidor. Reemplaza las escrituras optimistas del cliente
// (saveFirestoreOrder) que podian "pisar" un pedido con estado viejo en cache.
const orderTransitionPatchSchema = z.object({
  status: z.string().optional(),
  addressRisk: z.enum(["accepted", "review", "rejected"]).optional(),
  driverId: z.string().nullable().optional(),
  geoProvider: z.string().optional(),
  normalizedAddress: z.string().optional(),
  callOutcome: z.enum(["pending", "confirmed", "rescheduled"]).optional(),
  callNote: z.string().optional(),
  scheduledDate: z.string().optional(),
  scheduledWindow: z.string().optional(),
  rescheduledDate: z.string().optional(),
  rescheduledWindow: z.string().optional(),
  pickupBatchId: z.string().optional(),
  pickedUpAt: z.string().optional()
}).strict();

const orderTransitionSchema = z.object({
  orderId: z.string().min(1),
  expectedStatus: z.string().min(1),
  patch: orderTransitionPatchSchema
});

// Tupla y no Set suelto: el zod de order-corrections.ts la consume tal cual, asi que la
// lista de estados operativos validos existe UNA sola vez.
export const OPERATIONAL_TARGET_STATUSES = ["address_risk", "ready_to_assign", "assigned", "call_pending", "scheduled", "picked_up", "in_route", "retry_pending"] as const;
const OPERATIONAL_TARGET_STATUS = new Set<string>(OPERATIONAL_TARGET_STATUSES);
// 512 MiB no es por memoria sino por CPU: en Cloud Functions la CPU va atada a la memoria, y
// el arranque en frio medido contra produccion era de 2,33 s incluso en una funcion trivial.
// Esta esta en la ruta caliente del domiciliario, que lo paga al cerrar el primer pedido del
// dia. Sin `minInstances`: eso si tendria coste fijo mensual.
export const applyOrderTransition = onCall({ memory: "512MiB" }, async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || (role !== "admin" && role !== "driver" && role !== "messenger")) {
    throw new HttpsError("permission-denied", "No autorizado para operar pedidos.");
  }
  const parsed = orderTransitionSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Datos de transicion invalidos.", parsed.error.flatten());
  }
  const { orderId, expectedStatus, patch } = parsed.data;
  const db = getFirestore();
  const ref = db.collection("orders").doc(orderId);
  const now = new Date().toISOString();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "El pedido no existe.");
    const order = snap.data() ?? {};

    // Scoping: lideres/mensajeros solo sus pedidos (o libres para tomar).
    if (role === "driver") {
      const driverId = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : "";
      const ownsIt = order.driverId === driverId;
      const canClaimFree = (order.driverId === null || order.driverId === undefined) && order.status === "ready_to_assign";
      if (!ownsIt && !canClaimFree) throw new HttpsError("permission-denied", "Pedido no asignado a este lider logistico.");
    }
    if (role === "messenger") {
      const messengerId = typeof request.auth?.token.messengerId === "string" ? request.auth.token.messengerId : "";
      if (order.messengerId !== messengerId) throw new HttpsError("permission-denied", "Pedido no asignado a este mensajero.");
    }

    // Optimistic concurrency: el estado real debe coincidir con lo que el cliente creia.
    if (String(order.status ?? "") !== expectedStatus) {
      throw new HttpsError("failed-precondition", `El pedido cambio de estado (ahora ${order.status}). Refresca e intenta de nuevo.`);
    }
    // No operar sobre estados terminales por esta via (van por closeOrder/cancelOrder/etc.).
    if (TERMINAL_STATUS.has(String(order.status ?? ""))) {
      throw new HttpsError("failed-precondition", "El pedido esta en un estado terminal; usa el flujo correspondiente.");
    }
    // El destino, si cambia el status, debe ser un estado operativo valido.
    if (patch.status !== undefined && !OPERATIONAL_TARGET_STATUS.has(patch.status)) {
      throw new HttpsError("invalid-argument", `Transicion a "${patch.status}" no permitida por esta via.`);
    }

    // Spec 018 (R1-RF_09-1): la retencion de un pedido reabierto depende de saber que ya salio a
    // la calle. El boton "confirmar recogido" pasa a `picked_up` sin lote de recogida, que es quien
    // sellaba `pickedUpAt`; sin la marca, al reagendarse dejaba de retener con la mercancia fuera.
    const stampsPickup = (patch.status === "picked_up" || patch.status === "in_route") && !order.pickedUpAt && !patch.pickedUpAt;
    const clean = stripUndefined({ ...patch, ...(stampsPickup ? { pickedUpAt: now } : {}), updatedAt: now } as Record<string, unknown>);
    transaction.set(ref, clean, { merge: true });
    const auditRef = newAuditRef(db);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid ?? "unknown",
      actorRole: role,
      action: "order.transition",
      entity: "order",
      entityId: orderId,
      // fromStatus/toStatus como campos: el `summary` se conserva porque es lo unico que
      // tienen los eventos historicos, pero no es filtrable ni fiable de parsear.
      fromStatus: String(order.status ?? ""),
      toStatus: String(patch.status ?? order.status ?? ""),
      summary: `Transicion ${order.status} -> ${patch.status ?? order.status}`,
      createdAt: now
    });
    return { ok: true, order: { ...order, ...clean, id: orderId } };
  });
});

const orderAuditTrailSchema = z.object({
  orderId: z.string().min(1)
});

// Tope defensivo: ningun pedido genera cientos de eventos en su ciclo de vida, y sin tope
// un pedido patologico podria devolver una respuesta enorme al navegador.
const AUDIT_TRAIL_LIMIT = 200;

// Actores que no son personas. Sin este mapa la UI mostraria el id crudo del proceso.
const SYSTEM_ACTOR_LABELS: Record<string, string> = {
  "uchat-pull": "Bot ChatBy (consulta programada)",
  "uchat-confirm-webhook": "Bot ChatBy (webhook)",
  "onstock-webhook": "Webhook OnStok",
  "store-order-webhook": "Webhook de tienda",
  "shopify-webhook": "Webhook Shopify",
  system: "Sistema",
  unknown: "Desconocido"
};

// El logistico de tienda no tiene acceso financiero (ver CLAUDE.md), asi que su historial
// omite las acciones que revelan plata.
const FINANCIAL_AUDIT_ACTIONS = new Set(["order.adjusted", "seller.abono", "settlement.supplier_abono", "settlement.cash_received", "settlement.created", "order.correct_failed_to_delivered", "order.correct_delivered_to_failed", "order.correct_cancelled_to_operational", "order.reopened_for_retry"]);

type ResolvedActor = { label: string; email?: string };

/**
 * Traduce los `actorId` de un lote de eventos a nombre y correo.
 *
 * Los eventos guardan el uid crudo de Firebase Auth. Solo el Admin SDK puede resolverlo, asi
 * que esto no se puede hacer en el cliente: es la razon principal por la que el historial
 * vive en un callable y no en una lectura directa de Firestore.
 */
async function resolveAuditActors(actorIds: string[]): Promise<Map<string, ResolvedActor>> {
  const resolved = new Map<string, ResolvedActor>();
  const humanIds: string[] = [];

  for (const actorId of actorIds) {
    const systemLabel = SYSTEM_ACTOR_LABELS[actorId];
    if (systemLabel) {
      resolved.set(actorId, { label: systemLabel });
    } else {
      humanIds.push(actorId);
    }
  }

  // getUsers acepta maximo 100 identificadores por llamada.
  for (let index = 0; index < humanIds.length; index += 100) {
    const chunk = humanIds.slice(index, index + 100);
    try {
      const result = await getAuth().getUsers(chunk.map((uid) => ({ uid })));
      for (const user of result.users) {
        resolved.set(user.uid, { label: user.displayName ?? user.email ?? user.uid, email: user.email });
      }
    } catch {
      // Un fallo de Auth no puede tumbar el historial: se cae al uid crudo mas abajo.
    }
  }

  // Usuarios borrados o no resueltos: mostrar el uid en vez de dejar la fila en blanco.
  for (const actorId of humanIds) {
    if (!resolved.has(actorId)) resolved.set(actorId, { label: actorId });
  }

  return resolved;
}

/**
 * Historial de auditoria de un pedido: quien hizo cada accion y cuando.
 *
 * Existe porque `auditEvents` es inalcanzable desde la app: la coleccion es admin-only y el
 * cliente solo carga los ultimos 50 eventos globales, asi que responder "quien confirmo este
 * pedido" exigia un script con Admin SDK contra produccion.
 */
export const getOrderAuditTrail = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || typeof role !== "string") {
    throw new HttpsError("permission-denied", "Debes iniciar sesion para ver el historial.");
  }

  const parsed = orderAuditTrailSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Pedido invalido.", parsed.error.flatten());
  }
  const { orderId } = parsed.data;

  const db = getFirestore();
  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "El pedido no existe.");
  const order = orderSnap.data() ?? {};

  // Mismo scoping por rol que usa applyOrderTransition para operar el pedido.
  if (role === "seller" || role === "seller_logistics") {
    const sellerClaim = typeof request.auth.token.sellerId === "string" ? request.auth.token.sellerId : "";
    if (!sellerClaim || order.sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Solo puedes ver el historial de los pedidos de tu tienda.");
    }
  } else if (role === "driver") {
    const driverClaim = typeof request.auth.token.driverId === "string" ? request.auth.token.driverId : "";
    if (!driverClaim || order.driverId !== driverClaim) {
      throw new HttpsError("permission-denied", "Pedido no asignado a este lider logistico.");
    }
  } else if (role === "messenger") {
    const messengerClaim = typeof request.auth.token.messengerId === "string" ? request.auth.token.messengerId : "";
    if (!messengerClaim || order.messengerId !== messengerClaim) {
      throw new HttpsError("permission-denied", "Pedido no asignado a este mensajero.");
    }
  } else if (role !== "admin") {
    throw new HttpsError("permission-denied", "Tu usuario no puede ver el historial de pedidos.");
  }

  // Igualdad simple sobre un campo: usa el indice automatico, sin indice compuesto. El orden
  // se resuelve en memoria porque son pocas decenas de eventos por pedido.
  const snap = await db.collection("auditEvents").where("entityId", "==", orderId).limit(AUDIT_TRAIL_LIMIT).get();
  const rows = snap.docs
    .map((doc) => doc.data())
    .filter((row) => !(role === "seller_logistics" && FINANCIAL_AUDIT_ACTIONS.has(String(row.action ?? ""))))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));

  const actors = await resolveAuditActors([...new Set(rows.map((row) => String(row.actorId ?? "unknown")))]);

  const events = rows.map((row) => {
    const actorId = String(row.actorId ?? "unknown");
    const actor = actors.get(actorId);
    return stripUndefined({
      id: String(row.id ?? ""),
      createdAt: String(row.createdAt ?? ""),
      action: String(row.action ?? ""),
      actorId,
      actorLabel: actor?.label ?? actorId,
      actorEmail: actor?.email,
      actorRole: typeof row.actorRole === "string" ? row.actorRole : undefined,
      fromStatus: typeof row.fromStatus === "string" ? row.fromStatus : undefined,
      toStatus: typeof row.toStatus === "string" ? row.toStatus : undefined,
      summary: typeof row.summary === "string" ? row.summary : ""
    });
  });

  return { events };
});

const requestSellerPayoutSchema = z.object({
  /** Solo lo usa el admin para pedir en nombre de una tienda. El vendedor va por su claim. */
  sellerId: optionalString
});

const rejectSellerPayoutSchema = z.object({
  payoutId: z.string().min(1),
  reason: optionalString
});

/**
 * Registra la solicitud de liquidacion de una tienda.
 *
 * Antes esto no existia: el boton "Solicitar liquidacion automatica" solo mutaba el estado de
 * React del navegador de la tienda y el efecto que persiste el estado se salia para todo rol que
 * no fuera admin, asi que la solicitud nunca llegaba a Firestore. La tienda veia "requested" en
 * pantalla y el admin no veia nada; la coleccion `payouts` estaba vacia en toda la plataforma.
 *
 * El monto lo calcula el SERVIDOR. No puede venir del navegador: es la cifra que se le va a pagar
 * a la tienda, y las reglas de Firestore no pueden validar un total derivado de walletEntries.
 * Se usa la misma compuerta de elegibilidad que createSettlement (via seller-ledger), para que la
 * tienda pida exactamente lo que el admin puede cerrar; el saldo de la UI (`sellerBalance`) usa
 * otra formula, con una reserva por pedido en curso, y no cuadra con un corte real.
 *
 * Esto NO mueve plata: solo deja constancia de la solicitud. El dinero sigue moviendose unicamente
 * por createSettlement.
 */
export const requestSellerPayout = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  // seller_logistics queda fuera a proposito: es el rol operativo de tienda, sin acceso financiero.
  if (!request.auth || (role !== "seller" && role !== "admin")) {
    throw new HttpsError("permission-denied", "Tu usuario no puede solicitar liquidaciones.");
  }

  const parsed = requestSellerPayoutSchema.safeParse(request.data ?? {});
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Datos de solicitud invalidos.", parsed.error.flatten());
  }

  // El vendedor nunca elige la tienda: sale de su claim.
  const sellerId = role === "admin" ? (parsed.data.sellerId ?? "") : (sellerClaim ?? "");
  if (!sellerId) {
    throw new HttpsError("invalid-argument", role === "admin" ? "Indica la tienda." : "Tu usuario no tiene una tienda asociada.");
  }

  const db = getFirestore();
  const sellerSnap = await db.collection("sellers").doc(sellerId).get();
  if (!sellerSnap.exists) throw new HttpsError("not-found", "No se encontro el perfil de la tienda.");
  const sellerName = String(sellerSnap.data()?.name ?? sellerId);

  // Una solicitud abierta a la vez: si no, cada clic genera una fila nueva y el admin recibe ruido.
  const existingSnap = await db.collection("payouts").where("sellerId", "==", sellerId).get();
  const alreadyOpen = existingSnap.docs.find((doc) => String(doc.data()?.status ?? "") === "requested");
  if (alreadyOpen) {
    throw new HttpsError("failed-precondition", "Ya tienes una solicitud de liquidacion abierta. Espera a que Kentro la procese.");
  }

  // Spec 018: la tienda pide exactamente lo que un corte le pagaria hoy (RF_01).
  const balance = computeSellerBalance(await loadSellerBalanceInput(db, sellerId, new Date().toISOString()));
  if (balance.unreadableEntryIds.length > 0 || balance.availableCop <= 0) {
    throw new HttpsError("failed-precondition", payoutRejectionMessage(balance));
  }
  const includedOrderCount = balance.selection.includedOrderIds.length;
  const blockedCop = balance.codPendingCop + balance.heldCop;

  const now = new Date().toISOString();
  const payoutRef = db.collection("payouts").doc();
  const auditRef = newAuditRef(db);
  const payout = {
    id: payoutRef.id,
    sellerId,
    sellerName,
    amountCop: balance.availableCop,
    blockedCop,
    eligibleOrderCount: includedOrderCount,
    status: "requested" as const,
    requestedBy: request.auth.uid,
    requestedByEmail: typeof request.auth.token.email === "string" ? request.auth.token.email : undefined,
    createdAt: now
  };

  const batch = db.batch();
  batch.set(payoutRef, stripUndefined(payout));
  batch.set(auditRef, {
    id: auditRef.id,
    actorId: request.auth.uid,
    actorRole: role,
    action: "payout.requested",
    entity: "seller",
    entityId: sellerId,
    summary: `${sellerName} solicito liquidacion por ${balance.availableCop} COP (${includedOrderCount} pedidos)${blockedCop !== 0 ? ` · ${balance.codPendingCop} con el domiciliario y ${balance.heldCop} retenidos por pedidos en la calle` : ""}`,
    createdAt: now
  });
  await batch.commit();

  return { payout };
});

/** Cierra una solicitud sin pagarla, para que no quede abierta indefinidamente. */
export const rejectSellerPayout = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Solo un admin puede rechazar solicitudes de liquidacion.");
  }
  const parsed = rejectSellerPayoutSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Datos invalidos.", parsed.error.flatten());
  }

  const db = getFirestore();
  const ref = db.collection("payouts").doc(parsed.data.payoutId);
  const now = new Date().toISOString();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "La solicitud no existe.");
    const current = snap.data() ?? {};
    if (String(current.status ?? "") !== "requested") {
      throw new HttpsError("failed-precondition", "Esta solicitud ya fue procesada.");
    }
    const updated = stripUndefined({ ...current, status: "rejected", rejectedAt: now, rejectedReason: parsed.data.reason });
    transaction.set(ref, updated, { merge: true });
    const auditRef = newAuditRef(db);
    transaction.set(auditRef, {
      id: auditRef.id,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "payout.rejected",
      entity: "seller",
      entityId: String(current.sellerId ?? ""),
      summary: `Solicitud de liquidacion de ${current.sellerName ?? current.sellerId} rechazada${parsed.data.reason ? `: ${parsed.data.reason}` : ""}`,
      createdAt: now
    });
    return { payout: { id: snap.id, ...updated } };
  });
});
