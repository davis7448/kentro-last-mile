import { getAuth } from "firebase-admin/auth";
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
const optionalUrl = z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional());

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

const confirmImportedOrderSchema = z.object({
  orderId: z.string().min(1)
});

const confirmRetryOrderSchema = z.object({
  orderId: z.string().min(1)
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
  zoneId: optionalString,
  paymentMethod: z.enum(["cod", "prepaid"]),
  fulfillmentMode: z.enum(["seller_pickup", "warehouse"]),
  totalCop: z.number().positive(),
  productName: optionalString,
  sku: optionalString,
  quantity: z.number().positive().optional()
});

const updateOrderAdjustmentsSchema = z.object({
  orderId: z.string().min(1),
  totalCop: z.number().positive(),
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
  orderIds: z.array(z.string().min(1)).min(1)
});

const assignMessengerSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1),
  messengerId: z.string().min(1)
});

const defaultSettings = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 9000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 9000
};

const tariffFields = [
  "sellerDeliveredFeeCop",
  "sellerFailedFeeCop",
  "fulfillmentFeeCop",
  "driverDeliveredPayCop",
  "driverFailedPayCop"
] as const;

const dandaSellerIds = new Set(["seller-1779315416119"]);

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

type SettlementOrderDoc = {
  paymentMethod?: "cod" | "prepaid";
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
      pickupPointName: typeof sellerData.pickupPointName === "string" && sellerData.pickupPointName.trim() ? sellerData.pickupPointName.trim() : String(sellerData.name ?? "Punto de recogida"),
      pickupAddress: typeof sellerData.pickupAddress === "string" ? sellerData.pickupAddress.trim() : "",
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

export const confirmImportedOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
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
    if (role === "seller" && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only confirm their own orders.");
    }
    if (current.status !== "imported") {
      throw new HttpsError("failed-precondition", "Only imported orders can be confirmed.");
    }
    const updated = {
      ...current,
      addressRisk: "accepted",
      status: "ready_to_assign",
      updatedAt: now
    };
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(db.collection("auditEvents").doc(`audit-${Date.now()}`), {
      id: `audit-${Date.now()}`,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.seller_confirmed",
      entity: "order",
      entityId: snap.id,
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} confirmado por ${role === "seller" ? "vendedor" : "admin"}`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
});

export const updateImportedOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
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
    if (role === "seller" && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only edit their own orders.");
    }
    if (current.status !== "imported") {
      throw new HttpsError("failed-precondition", "Only imported orders pending confirmation can be edited.");
    }
    const updated = stripUndefined({
      ...current,
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim(),
      addressRaw: input.addressRaw.trim(),
      normalizedAddress: input.normalizedAddress?.trim(),
      zoneId: input.zoneId?.trim(),
      paymentMethod: input.paymentMethod,
      fulfillmentMode: input.fulfillmentMode,
      totalCop: input.totalCop,
      productName: input.productName?.trim(),
      sku: input.sku?.trim(),
      quantity: input.quantity,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(db.collection("auditEvents").doc(`audit-${Date.now()}`), {
      id: `audit-${Date.now()}`,
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
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can confirm retries.");
  }

  const parsed = confirmRetryOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid retry confirmation data.", parsed.error.flatten());
  }

  const db = getFirestore();
  const orderRef = db.collection("orders").doc(parsed.data.orderId);
  const auditRef = db.collection("auditEvents").doc(`audit-${Date.now()}`);
  const now = new Date().toISOString();

  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    const sellerId = String(current.sellerId ?? "");
    if (role === "seller" && sellerId !== sellerClaim) {
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
      summary: `Reintento confirmado para ${current.trackingCode ?? current.shopifyOrderId ?? snap.id}`,
      createdAt: now
    });
    return { id: snap.id, ...updated };
  });

  return { order };
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
  const auditId = `audit-${Date.now()}`;
  const order = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const current = snap.data() ?? {};
    if (["delivered", "failed", "cancelled", "liquidated"].includes(String(current.status))) {
      throw new HttpsError("failed-precondition", "Closed, cancelled or liquidated orders cannot be adjusted from this form.");
    }
    const updated = stripUndefined({
      ...current,
      totalCop: input.totalCop,
      productName: input.productName?.trim(),
      sku: input.sku?.trim(),
      quantity: input.quantity,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(db.collection("auditEvents").doc(auditId), {
      id: auditId,
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
    const orderRefs = parsed.data.orderIds.map((orderId) => db.collection("orders").doc(orderId));
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
    const refs = parsed.data.orderIds.map((orderId) => db.collection("orders").doc(orderId));
    const snaps = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const orders = snaps.map((snap) => ({ snap, data: snap.data() ?? {} }));
    const invalid = orders.find(({ snap, data }) => !snap.exists || String(data.driverId ?? "") !== driverClaim || !["picked_up", "scheduled", "call_pending", "in_route"].includes(String(data.status ?? "")));
    if (invalid) throw new HttpsError("failed-precondition", "Only picked up or active orders assigned to this leader can be assigned to a messenger.");

    const updatedOrders = orders.map(({ snap, data }) => {
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
      return updated;
    });
    return { orders: updatedOrders };
  });
});

export const cancelOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
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
    if (role === "seller" && sellerId !== sellerClaim) {
      throw new HttpsError("permission-denied", "Sellers can only cancel their own orders.");
    }
    if (closedStatuses.has(status)) {
      throw new HttpsError("failed-precondition", "Closed orders cannot be cancelled.");
    }
    if (role === "seller" && collectedStatuses.has(status)) {
      throw new HttpsError("failed-precondition", "This order was already collected. Only an admin can cancel it.");
    }

    const inventoryQuery = typeof current.sku === "string" && sellerId
      ? db.collection("inventory").where("sellerId", "==", sellerId).where("sku", "==", current.sku).limit(1)
      : null;
    const inventorySnap = inventoryQuery ? await transaction.get(inventoryQuery) : null;
    if (inventorySnap && !inventorySnap.empty && status !== "imported") {
      const inventoryDoc = inventorySnap.docs[0];
      const inventory = inventoryDoc.data();
      const reserved = Number(inventory.reserved) || 0;
      transaction.set(inventoryDoc.ref, { reserved: Math.max(0, reserved - 1), updatedAt: now }, { merge: true });
    }

    const updated = stripUndefined({
      ...current,
      status: "cancelled",
      driverId: current.driverId ?? null,
      callNote: parsed.data.reason?.trim() || current.callNote,
      updatedAt: now
    });
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(db.collection("auditEvents").doc(`audit-${Date.now()}`), {
      id: `audit-${Date.now()}`,
      actorId: request.auth?.uid,
      actorRole: role,
      action: "order.cancelled",
      entity: "order",
      entityId: snap.id,
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} anulado por ${role === "seller" ? "vendedor" : "admin"}`,
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
  const unsettledEntryDocs = entriesSnap.docs
    .filter((entry) => {
      const data = entry.data();
      const entryDate = String(data.createdAt ?? "").slice(0, 10);
      return !data.settlementId && entryDate >= input.startDate && entryDate <= input.endDate;
    });

  let candidateDocs = unsettledEntryDocs;
  if (input.kind === "seller") {
    const paidDriverSettlementsSnap = await db
      .collection("settlements")
      .where("kind", "==", "driver")
      .get();
    const codReceivedOrderIds = new Set<string>();
    for (const settlementDoc of paidDriverSettlementsSnap.docs) {
      const settlement = settlementDoc.data() as SettlementDoc;
      if (settlement.status !== "paid" && settlement.status !== "reconciled") continue;
      for (const orderId of settlement.orderIds ?? []) {
        codReceivedOrderIds.add(orderId);
      }
    }

    const orderIds = Array.from(new Set(unsettledEntryDocs.map((entry) => String(entry.data().orderId ?? "")).filter(Boolean)));
    const orderSnaps = await Promise.all(orderIds.map((orderId) => db.collection("orders").doc(orderId).get()));
    const ordersById = new Map(orderSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() as SettlementOrderDoc]));
    candidateDocs = unsettledEntryDocs.filter((entry) => {
      const orderId = String(entry.data().orderId ?? "");
      const order = ordersById.get(orderId);
      if (!order) return false;
      if (order.paymentMethod === "prepaid") return true;
      return order.paymentMethod === "cod" && codReceivedOrderIds.has(orderId);
    });
  }

  const candidateRefs = candidateDocs.map((entry) => entry.ref);

  if (candidateRefs.length === 0) {
    if (input.kind === "seller" && unsettledEntryDocs.length > 0) {
      throw new HttpsError("failed-precondition", "No hay pedidos habilitados para pagar a esta tienda. Primero marca recibido el dinero del domiciliario.");
    }
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
  const feesCop = Math.max(0, -entries
    .filter((entry) => entry.ownerType === "seller" && ["delivery_fee", "failed_fee", "fulfillment_fee"].includes(entry.type))
    .reduce((sum, entry) => sum + Number(entry.amountCop), 0));
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
  const values = dandaSellerIds.has(String(order.sellerId ?? ""))
    ? {
        ...defaultSettings,
        ...settings,
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 0,
        driverDeliveredPayCop: 10000,
        driverFailedPayCop: 0
      }
    : { ...defaultSettings, ...settings };
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
    if (Number(values.sellerFailedFeeCop) > 0) {
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
    }
    if (Number(values.driverFailedPayCop) > 0) {
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
