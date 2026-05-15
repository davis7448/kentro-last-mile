import { getFirestore, type QuerySnapshot, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

const manualOrderSchema = z.object({
  sellerId: z.string().min(1),
  shopifyOrderId: z.string().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  addressRaw: z.string().min(1),
  normalizedAddress: z.string().optional(),
  zoneId: z.string().optional(),
  paymentMethod: z.enum(["cod", "prepaid"]),
  fulfillmentMode: z.enum(["seller_pickup", "warehouse"]),
  totalCop: z.number().positive(),
  productName: z.string().optional(),
  sku: z.string().optional(),
  addressRisk: z.enum(["accepted", "review"])
});

const optionalString = z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional());
const optionalUrl = z.preprocess((value) => (value === null ? undefined : value), z.string().url().optional());

const closeOrderSchema = z.object({
  orderId: z.string().min(1),
  outcome: z.enum(["delivered", "failed"]),
  note: z.string().min(1),
  photoLabel: z.string().min(1),
  photoUrl: optionalUrl,
  storagePath: optionalString,
  reason: optionalString,
  scheduledDate: optionalString,
  scheduledWindow: optionalString
});

const settlementSchema = z.object({
  kind: z.enum(["seller", "driver"]),
  ownerId: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  note: optionalString
});

const settlementStatusSchema = z.object({
  settlementId: z.string().min(1),
  status: z.enum(["paid", "reconciled"]),
  note: optionalString
});

const defaultSettings = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 9000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 8000,
  driverFailedPayCop: 8000
};

const tariffFields = [
  "sellerDeliveredFeeCop",
  "sellerFailedFeeCop",
  "fulfillmentFeeCop",
  "driverDeliveredPayCop",
  "driverFailedPayCop"
] as const;

type WalletEntryDoc = {
  id: string;
  ownerType: "seller" | "driver" | "admin";
  ownerId: string;
  orderId: string;
  type: "cod_revenue" | "delivery_fee" | "failed_fee" | "fulfillment_fee" | "driver_earning" | "platform_margin";
  amountCop: number;
  description: string;
  createdAt: string;
  settlementId?: string;
};

type SettlementDoc = {
  id: string;
  kind: "seller" | "driver";
  ownerId: string;
  ownerName: string;
  startDate: string;
  endDate: string;
  walletEntryIds: string[];
  orderIds: string[];
  codCop: number;
  feesCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  netCop: number;
  status: "pending" | "paid" | "reconciled";
  createdAt: string;
  paidAt?: string;
  reconciledAt?: string;
  note?: string;
};

export const createManualOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can create orders.");
  }

  const parsed = manualOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid order data.", parsed.error.flatten());
  }

  const input = parsed.data;
  if (role === "seller" && input.sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Sellers can only create their own orders.");
  }

  const db = getFirestore();
  const seller = await db.collection("sellers").doc(input.sellerId).get();
  if (!seller.exists) {
    throw new HttpsError("not-found", "Seller profile not found.");
  }

  const sellerData = seller.data() ?? {};
  const requestedNumber = input.shopifyOrderId?.trim();
  const formattedRequestedNumber = requestedNumber && (requestedNumber.startsWith("#") || requestedNumber.startsWith("MAN-")) ? requestedNumber : requestedNumber ? `#${requestedNumber}` : undefined;
  if (formattedRequestedNumber) {
    const duplicate = await db.collection("orders").where("sellerId", "==", input.sellerId).where("shopifyOrderId", "==", formattedRequestedNumber).limit(1).get();
    if (!duplicate.empty) {
      throw new HttpsError("already-exists", "An order with this seller reference already exists.");
    }
  }

  const now = new Date().toISOString();
  const auditRef = db.collection("auditEvents").doc(`audit-${Date.now()}`);
  const order = await db.runTransaction(async (transaction) => {
    const inventorySnap = input.sku?.trim()
      ? await transaction.get(db.collection("inventory").where("sellerId", "==", input.sellerId).where("sku", "==", input.sku.trim()).limit(1))
      : null;
    const nextTracking = await nextTrackingCode(transaction);
    const trackingCode = nextTracking.code;
    const orderId = `ord-${trackingCode.toLowerCase()}`;
    const orderNumber = formattedRequestedNumber || `MAN-${trackingCode}`;
    const inventoryDoc = inventorySnap && !inventorySnap.empty ? inventorySnap.docs[0] : null;
    if (inventoryDoc) {
      const inventory = inventoryDoc.data();
      const available = Number(inventory.available) || 0;
      const reserved = Number(inventory.reserved) || 0;
      if (available - reserved <= 0) {
        throw new HttpsError("failed-precondition", "Product is out of stock.");
      }
      transaction.set(inventoryDoc.ref, { reserved: reserved + 1, updatedAt: now }, { merge: true });
    }
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
      addressRisk: input.addressRisk,
      status: input.addressRisk === "review" ? "address_risk" : "ready_to_assign",
      paymentMethod: input.paymentMethod,
      fulfillmentMode: input.fulfillmentMode,
      totalCop: input.totalCop,
      productName: input.productName?.trim() || undefined,
      sku: input.sku?.trim() || undefined,
      evidence: [],
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
      summary: `Pedido manual ${orderDoc.trackingCode} creado`,
      createdAt: now
    });
    return orderDoc;
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

  ordersSnap.docs.forEach((doc) => {
    const order = doc.data();
    const sellerId = typeof order.sellerId === "string" ? order.sellerId : "";
    const sku = typeof order.sku === "string" ? order.sku.trim().toUpperCase() : "";
    const status = typeof order.status === "string" ? order.status : "";
    if (!sellerId || !sku || closedStatuses.has(status)) return;
    const key = `${sellerId}::${sku}`;
    reservedByItem.set(key, (reservedByItem.get(key) ?? 0) + 1);
  });

  const now = new Date().toISOString();
  const batch = db.batch();
  const inventory = inventorySnap.docs.map((doc) => {
    const item = doc.data();
    const sellerId = typeof item.sellerId === "string" ? item.sellerId : "";
    const sku = typeof item.sku === "string" ? item.sku.trim().toUpperCase() : "";
    const reserved = reservedByItem.get(`${sellerId}::${sku}`) ?? 0;
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

export const closeOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const driverClaim = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : undefined;
  if (!request.auth || (role !== "admin" && role !== "driver")) {
    throw new HttpsError("permission-denied", "Only admins and assigned drivers can close orders.");
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
  const auditRef = db.collection("auditEvents").doc(`audit-${Date.now()}`);
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
    if (!["scheduled", "picked_up", "in_route"].includes(String(order.status))) {
      throw new HttpsError("failed-precondition", "Only scheduled, picked up or in route orders can be closed.");
    }
    if (input.storagePath && !input.storagePath.startsWith(`evidence/${input.orderId}/`)) {
      throw new HttpsError("invalid-argument", "Evidence storagePath does not match the order.");
    }

    const zoneId = typeof order.zoneId === "string" ? order.zoneId : undefined;
    const inventoryQuery = typeof order.sku === "string" && typeof order.sellerId === "string"
      ? db.collection("inventory").where("sellerId", "==", order.sellerId).where("sku", "==", order.sku).limit(1)
      : null;
    const [zoneSnap, inventorySnap] = await Promise.all([
      zoneId ? transaction.get(db.collection("zones").doc(zoneId)) : Promise.resolve(null),
      inventoryQuery ? transaction.get(inventoryQuery) : Promise.resolve(null)
    ]);

    const nextStatus = input.outcome === "delivered" ? "delivered" : isVisitRescheduled ? "retry_pending" : "failed";
    const evidence = {
      id: `ev-${Date.now()}`,
      type: input.outcome === "delivered" ? "delivery" : "failed",
      photoLabel: input.photoLabel,
      photoUrl: input.photoUrl,
      storagePath: input.storagePath,
      note: input.note.trim(),
      reason: input.outcome === "failed" ? input.reason?.trim() || "Cliente no recibe" : undefined,
      actorId: request.auth?.uid ?? "unknown",
      createdAt: now
    };
    const nextOrder = stripUndefined({
      ...order,
      status: nextStatus,
      failedReason: input.outcome === "failed" ? evidence.reason : order.failedReason,
      retryDecision: isVisitRescheduled ? "retry" : input.outcome === "failed" ? "pending" : order.retryDecision,
      scheduledDate: isVisitRescheduled ? input.scheduledDate : order.scheduledDate,
      scheduledWindow: isVisitRescheduled ? input.scheduledWindow : order.scheduledWindow,
      evidence: [...(Array.isArray(order.evidence) ? order.evidence : []), stripUndefined(evidence)],
      updatedAt: now
    });

    transaction.set(orderRef, nextOrder, { merge: true });

    settleInventoryForOrder(transaction, inventorySnap, input.outcome, isVisitRescheduled, now);
    const walletEntries = isVisitRescheduled ? [] : buildWalletEntries(nextOrder, resolveTariffs(settingsSnap.data() ?? {}, zoneSnap?.data()), now);
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
  if (input.startDate > input.endDate) {
    throw new HttpsError("invalid-argument", "startDate must be before endDate.");
  }

  const db = getFirestore();
  const ownerRef = db.collection(input.kind === "seller" ? "sellers" : "drivers").doc(input.ownerId);
  const entriesSnap = await db
    .collection("walletEntries")
    .where("ownerType", "==", input.kind)
    .where("ownerId", "==", input.ownerId)
    .get();
  const candidateRefs = entriesSnap.docs
    .filter((entry) => {
      const data = entry.data();
      const entryDate = String(data.createdAt ?? "").slice(0, 10);
      return !data.settlementId && entryDate >= input.startDate && entryDate <= input.endDate;
    })
    .map((entry) => entry.ref);

  if (candidateRefs.length === 0) {
    throw new HttpsError("failed-precondition", "There are no unsettled wallet movements for this account and date range.");
  }

  const settlementRef = db.collection("settlements").doc(`stl-${Date.now()}-${input.kind}-${input.ownerId}`);
  const auditRef = db.collection("auditEvents").doc(`audit-${Date.now()}`);
  const now = new Date().toISOString();

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
        return !entry.settlementId && entryDate >= input.startDate && entryDate <= input.endDate;
      });
    const entries = unsettledSnaps.map((snap) => ({ id: snap.id, ...snap.data() }) as WalletEntryDoc);

    if (entries.length === 0) {
      throw new HttpsError("failed-precondition", "The wallet movements were already settled.");
    }

    const settlement = buildSettlement(
      settlementRef.id,
      input.kind,
      input.ownerId,
      String(ownerSnap.data()?.name ?? input.ownerId),
      input.startDate,
      input.endDate,
      entries,
      now,
      input.note
    );

    const platformEntry = buildPlatformWalletEntry(settlement, now);

    transaction.set(settlementRef, settlement);
    for (const snap of unsettledSnaps) {
      transaction.set(snap.ref, { settlementId: settlement.id }, { merge: true });
    }
    if (platformEntry) {
      transaction.set(db.collection("walletEntries").doc(platformEntry.id), platformEntry, { merge: true });
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

    return { settlement, walletEntries: [...entries.map((entry) => ({ ...entry, settlementId: settlement.id })), ...(platformEntry ? [platformEntry] : [])] };
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
  const auditRef = db.collection("auditEvents").doc(`audit-${Date.now()}`);
  const now = new Date().toISOString();

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

    const nextSettlement = stripUndefined({
      ...settlement,
      status: input.status,
      paidAt: input.status === "paid" ? now : settlement.paidAt,
      reconciledAt: input.status === "reconciled" ? now : settlement.reconciledAt,
      note: input.note?.trim() || settlement.note
    });

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

function buildSettlement(
  id: string,
  kind: "seller" | "driver",
  ownerId: string,
  ownerName: string,
  startDate: string,
  endDate: string,
  entries: WalletEntryDoc[],
  now: string,
  note?: string
): SettlementDoc {
  const codCop = entries.filter((entry) => entry.type === "cod_revenue").reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  const feesCop = Math.abs(entries.filter((entry) => entry.ownerType === "seller" && entry.amountCop < 0).reduce((sum, entry) => sum + Number(entry.amountCop), 0));
  const driverPayCop = entries.filter((entry) => entry.type === "driver_earning").reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  const netCop = entries.reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  return stripUndefined({
    id,
    kind,
    ownerId,
    ownerName,
    startDate,
    endDate,
    walletEntryIds: entries.map((entry) => entry.id),
    orderIds: Array.from(new Set(entries.map((entry) => entry.orderId).filter(Boolean))),
    codCop,
    feesCop,
    driverPayCop,
    platformMarginCop: kind === "seller" ? feesCop : -driverPayCop,
    netCop,
    status: "pending",
    createdAt: now,
    note: note?.trim() || undefined
  });
}

function buildPlatformWalletEntry(settlement: SettlementDoc, now: string): WalletEntryDoc | null {
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

function resolveTariffs(settings: Record<string, any>, zone?: Record<string, any>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of tariffFields) {
    const zoneValue = Number(zone?.[field]);
    const settingValue = Number(settings[field]);
    const fallbackValue = Number(defaultSettings[field]);
    values[field] = Number.isFinite(zoneValue) && zoneValue > 0 ? zoneValue : Number.isFinite(settingValue) && settingValue > 0 ? settingValue : fallbackValue;
  }
  return values;
}

function settleInventoryForOrder(
  transaction: Transaction,
  inventorySnap: QuerySnapshot | null,
  outcome: "delivered" | "failed",
  retry: boolean,
  now: string
) {
  if (!inventorySnap || inventorySnap.empty) return;
  const inventoryDoc = inventorySnap.docs[0];
  const inventory = inventoryDoc.data();
  const available = Number(inventory.available) || 0;
  const reserved = Number(inventory.reserved) || 0;
  if (outcome === "delivered") {
    transaction.set(inventoryDoc.ref, { available: Math.max(0, available - 1), reserved: Math.max(0, reserved - 1), updatedAt: now }, { merge: true });
    return;
  }
  if (!retry) {
    transaction.set(inventoryDoc.ref, { reserved: Math.max(0, reserved - 1), updatedAt: now }, { merge: true });
  }
}

function buildWalletEntries(order: Record<string, any>, settings: Record<string, any>, now: string): WalletEntryDoc[] {
  const values = { ...defaultSettings, ...settings };
  const entries: WalletEntryDoc[] = [];

  if (order.status === "delivered" && order.paymentMethod === "cod") {
    entries.push({
      id: `we-${order.id}-cod`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "cod_revenue",
      amountCop: Number(order.totalCop) || 0,
      description: `Recaudo COD pedido ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  if (order.status === "delivered") {
    entries.push({
      id: `we-${order.id}-seller-delivery-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "delivery_fee",
      amountCop: -Number(values.sellerDeliveredFeeCop),
      description: `Flete entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
    entries.push({
      id: `we-${order.id}-driver-delivery-pay`,
      ownerType: "driver",
      ownerId: order.driverId ?? "unassigned",
      orderId: order.id,
      type: "driver_earning",
      amountCop: Number(values.driverDeliveredPayCop),
      description: `Pago transportista entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  if (order.status === "failed") {
    entries.push({
      id: `we-${order.id}-seller-failed-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "failed_fee",
      amountCop: -Number(values.sellerFailedFeeCop),
      description: `Cobro fallido ${order.shopifyOrderId}`,
      createdAt: now
    });
    entries.push({
      id: `we-${order.id}-driver-failed-pay`,
      ownerType: "driver",
      ownerId: order.driverId ?? "unassigned",
      orderId: order.id,
      type: "driver_earning",
      amountCop: Number(values.driverFailedPayCop),
      description: `Pago transportista fallido ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  if (order.fulfillmentMode === "warehouse" && (order.status === "delivered" || order.status === "failed")) {
    entries.push({
      id: `we-${order.id}-fulfillment-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "fulfillment_fee",
      amountCop: -Number(values.fulfillmentFeeCop),
      description: `Fulfillment desde bodega ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  return entries;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
