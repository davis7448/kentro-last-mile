import { initializeApp } from "firebase-admin/app";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
export { createManagedUser, getBootstrapStatus, setUserRole } from "./roles";
export { closeOrder, createManualOrder, createSettlement, reconcileInventoryReservations, updateSettlementStatus } from "./orders";
export { shopifyOAuthCallback, shopifyOAuthStart } from "./shopify";

initializeApp();

const db = getFirestore();

const shopifyWebhookSchema = z.object({
  id: z.number(),
  name: z.string(),
  total_price: z.string(),
  financial_status: z.string().optional(),
  shipping_address: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      address1: z.string().optional(),
      address2: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional()
    })
    .optional(),
  line_items: z.array(z.object({ sku: z.string().optional(), quantity: z.number().optional() })).optional()
});

export const shopifyWebhook = onRequest(async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).send("Method not allowed");
    return;
  }

  const parsed = shopifyWebhookSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const order = parsed.data;
  const address = order.shipping_address;
  const city = address?.city ?? "";

  if (city.toLowerCase() !== "cali") {
    response.status(202).json({ ok: true, ignored: true, reason: "outside_active_city" });
    return;
  }

  const docId = `shopify-${order.id}`;
  const orderRef = db.collection("orders").doc(docId);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(orderRef);
    const trackingCode = typeof existing.data()?.trackingCode === "string" ? existing.data()?.trackingCode : await nextTrackingCode(transaction);
    transaction.set(orderRef, {
      id: docId,
      trackingCode,
      shopifyOrderId: order.name,
      shopifyNumericId: order.id,
      cityId: "city-cali",
      customerName: address?.name ?? "Cliente Shopify",
      customerPhone: address?.phone ?? "",
      addressRaw: [address?.address1, address?.address2, address?.city, address?.country].filter(Boolean).join(", "),
      totalCop: Math.round(Number(order.total_price) || 0),
      paymentMethod: order.financial_status === "paid" ? "prepaid" : "cod",
      fulfillmentMode: "seller_pickup",
      addressRisk: "review",
      status: "address_risk",
      source: "shopify_webhook",
      updatedAt: new Date().toISOString()
    }, { merge: true });
  });

  response.json({ ok: true, orderId: docId });
});

async function nextTrackingCode(transaction: Transaction) {
  const counterRef = db.doc("counters/orders");
  const counterSnap = await transaction.get(counterRef);
  const next = Number(counterSnap.data()?.next ?? 1);
  transaction.set(counterRef, { next: next + 1, prefix: "KNT", updatedAt: new Date().toISOString() }, { merge: true });
  return `KNT-${String(next).padStart(6, "0")}`;
}

export const normalizeAddress = onRequest(async (request, response) => {
  const address = String(request.body?.address ?? "");
  const city = String(request.body?.city ?? "Cali");
  const normalized = `${address.trim().replace(/\s+/g, " ")}, ${city}, Colombia`;

  response.json({
    normalized,
    providerPlan: "Mapbox Permanent first, Google Address Validation fallback for low confidence",
    risk: address.length < 12 ? "review" : "accepted"
  });
});
