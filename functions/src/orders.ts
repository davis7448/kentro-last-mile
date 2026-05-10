import { getFirestore } from "firebase-admin/firestore";
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

const closeOrderSchema = z.object({
  orderId: z.string().min(1),
  outcome: z.enum(["delivered", "failed"]),
  note: z.string().min(1),
  photoLabel: z.string().min(1),
  photoUrl: z.string().url().optional(),
  storagePath: z.string().min(1).optional(),
  reason: z.string().optional(),
  scheduledDate: z.string().optional(),
  scheduledWindow: z.string().optional()
});

const defaultSettings = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 9000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 8000,
  driverFailedPayCop: 8000
};

type WalletEntryDoc = {
  id: string;
  ownerType: "seller" | "driver";
  ownerId: string;
  orderId: string;
  type: "cod_revenue" | "delivery_fee" | "failed_fee" | "fulfillment_fee" | "driver_earning";
  amountCop: number;
  description: string;
  createdAt: string;
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
  const now = new Date().toISOString();
  const orderId = `ord-${Date.now()}`;
  const requestedNumber = input.shopifyOrderId?.trim();
  const orderNumber = requestedNumber || `MAN-${orderId.slice(-6)}`;
  const order = stripUndefined({
    id: orderId,
    shopifyOrderId: orderNumber.startsWith("#") || orderNumber.startsWith("MAN-") ? orderNumber : `#${orderNumber}`,
    sellerId: input.sellerId,
    cityId: typeof sellerData.cityId === "string" ? sellerData.cityId : "city-bog",
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

  await db.collection("orders").doc(order.id).set(order);
  const auditId = `audit-${Date.now()}`;
  await db.collection("auditEvents").doc(auditId).set({
    id: auditId,
    actorId: request.auth.uid,
    actorRole: role,
    action: "order.manual_created",
    entity: "order",
    entityId: order.id,
    summary: `Pedido manual ${order.shopifyOrderId} creado`,
    createdAt: now
  });

  return { order };
});

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

    const walletEntries = isVisitRescheduled ? [] : buildWalletEntries(nextOrder, settingsSnap.data() ?? {}, now);
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
