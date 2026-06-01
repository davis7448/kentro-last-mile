import { initializeApp } from "firebase-admin/app";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import crypto from "crypto";
import { z } from "zod";
export { createManagedUser, getBootstrapStatus, repairOwnDriverProfile, setUserRole } from "./roles";
export { assignMessengerToOrders, cancelOrder, closeOrder, confirmImportedOrder, confirmRetryOrder, createManualOrder, createMessengerProfile, createOrUpdatePickupBatch, createSettlement, reconcileInventoryReservations, updateImportedOrder, updateOrderAdjustments, updateSettlementStatus } from "./orders";
export { importShopifyOrder, shopifyComplianceWebhook, shopifyCustomersDataRequest, shopifyCustomersRedact, shopifyOAuthCallback, shopifyOAuthStart, shopifyPilotOAuthStart, shopifyShopRedact, shopifyTenantOAuthStart, syncShopifyHistoricalOrders } from "./shopify";

initializeApp();

const db = getFirestore();
const shopifyApiSecret = defineSecret("SHOPIFY_APP_API_SECRET");
const shopifyPilotApiSecret = defineSecret("SHOPIFY_PILOT_APP_API_SECRET");
const shopifyU0jxrmApiSecret = defineSecret("SHOPIFY_U0JXRM_APP_API_SECRET");
const shopifyN1v0swApiSecret = defineSecret("SHOPIFY_N1V0SW_APP_API_SECRET");
const nullableString = z.string().nullish();
const dandaSellerId = "seller-1779315416119";

const shopifyWebhookSchema = z.object({
  id: z.number(),
  name: z.string(),
  order_number: z.number().optional(),
  total_price: nullableString,
  financial_status: nullableString,
  created_at: nullableString,
  shipping_address: z
    .object({
      name: nullableString,
      phone: nullableString,
      address1: nullableString,
      address2: nullableString,
      city: nullableString,
      country: nullableString
    })
    .optional(),
  line_items: z.array(z.object({
    name: nullableString,
    title: nullableString,
    variant_title: nullableString,
    sku: nullableString,
    quantity: z.number().optional(),
    properties: z.array(z.object({ name: nullableString, value: nullableString })).optional()
  })).optional()
});

export const shopifyWebhook = onRequest({ secrets: [shopifyApiSecret, shopifyPilotApiSecret, shopifyU0jxrmApiSecret, shopifyN1v0swApiSecret] }, async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).send("Method not allowed");
    return;
  }

  const shopifySecret = process.env.SHOPIFY_APP_API_SECRET ?? "";
  const shopifyPilotSecret = process.env.SHOPIFY_PILOT_APP_API_SECRET ?? "";
  const shopifyU0jxrmSecret = process.env.SHOPIFY_U0JXRM_APP_API_SECRET ?? "";
  const shopifyN1v0swSecret = process.env.SHOPIFY_N1V0SW_APP_API_SECRET ?? "";
  const hmac = String(request.get("x-shopify-hmac-sha256") ?? "");
  const shopDomain = String(request.get("x-shopify-shop-domain") ?? "").toLowerCase();
  const hmacBuffer = Buffer.from(hmac, "utf8");
  const isValidHmac = [shopifySecret, shopifyPilotSecret, shopifyU0jxrmSecret, shopifyN1v0swSecret].filter(Boolean).some((secret) => {
    const digest = crypto.createHmac("sha256", secret).update(request.rawBody).digest("base64");
    const digestBuffer = Buffer.from(digest, "utf8");
    return hmac && digestBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(digestBuffer, hmacBuffer);
  });
  if (!isValidHmac) {
    response.status(401).json({ ok: false, error: "invalid_hmac" });
    return;
  }

  const storeSnap = shopDomain
    ? await db.collection("shopifyStores").where("shopDomain", "==", shopDomain).where("status", "==", "connected").limit(1).get()
    : null;
  if (!storeSnap || storeSnap.empty) {
    response.status(202).json({ ok: true, ignored: true, reason: "store_not_connected" });
    return;
  }
  const store = storeSnap.docs[0].data();
  const sellerId = String(store.sellerId ?? "");
  if (!sellerId) {
    response.status(202).json({ ok: true, ignored: true, reason: "seller_not_found" });
    return;
  }
  await storeSnap.docs[0].ref.set({ lastWebhookReceivedAt: new Date().toISOString() }, { merge: true });

  const parsed = shopifyWebhookSchema.safeParse(request.body);
  if (!parsed.success) {
    await recordShopifySyncIssue({
      sellerId,
      shopDomain,
      reference: String(request.body?.name ?? request.body?.id ?? "unknown"),
      reason: "Payload Shopify no pudo validarse en webhook automatico.",
      detail: JSON.stringify(parsed.error.flatten())
    });
    console.error("shopify_webhook_invalid_payload", { shopDomain, error: parsed.error.flatten() });
    response.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const order = parsed.data;
  const address = order.shipping_address;
  const addressRaw = [address?.address1, address?.address2, address?.city, address?.country].filter(Boolean).join(", ");

  if (!isCaliAddress(address)) {
    await recordShopifySyncIssue({
      sellerId,
      shopDomain,
      reference: order.name,
      reason: "Pedido Shopify recibido fuera de Cali o sin ciudad reconocible.",
      detail: `Direccion recibida: ${addressRaw || "sin direccion"}`
    });
    response.status(202).json({ ok: true, ignored: true, reason: "outside_active_city" });
    return;
  }

  const docId = `shopify-${order.id}`;
  const orderRef = db.collection("orders").doc(docId);
  await db.runTransaction(async (transaction) => {
    const [existing, sellerSnap] = await Promise.all([transaction.get(orderRef), transaction.get(db.collection("sellers").doc(sellerId))]);
    const seller = sellerSnap.data() ?? {};
    const trackingCode = typeof existing.data()?.trackingCode === "string" ? existing.data()?.trackingCode : await nextTrackingCode(transaction);
    const items = summarizeShopifyLineItems(order.line_items ?? [], shopDomain);
    transaction.set(orderRef, {
      id: docId,
      trackingCode,
      shopifyOrderId: order.name,
      shopifyNumericId: order.id,
      shopDomain,
      sellerId,
      driverId: existing.data()?.driverId ?? null,
      cityId: "city-cali",
      customerName: address?.name ?? "Cliente Shopify",
      customerPhone: address?.phone ?? "",
      addressRaw,
      totalCop: Math.round(Number(order.total_price) || 0),
      productName: items.productName,
      sku: items.sku,
      quantity: items.quantity,
      pickupPointName: typeof seller.pickupPointName === "string" && seller.pickupPointName.trim() ? seller.pickupPointName.trim() : String(seller.name ?? "Punto de recogida"),
      pickupAddress: typeof seller.pickupAddress === "string" ? seller.pickupAddress.trim() : "",
      paymentMethod: order.financial_status === "paid" ? "prepaid" : "cod",
      fulfillmentMode: "seller_pickup",
      addressRisk: sellerId === dandaSellerId ? "accepted" : "review",
      status: sellerId === dandaSellerId ? "ready_to_assign" : "imported",
      evidence: existing.data()?.evidence ?? [],
      source: "shopify_webhook",
      createdAt: existing.data()?.createdAt ?? order.created_at ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true });
  });

  await storeSnap.docs[0].ref.set({ lastWebhookAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true });

  response.json({ ok: true, orderId: docId });
});

function isCaliAddress(address?: { city?: string | null; address1?: string | null; address2?: string | null; country?: string | null }) {
  const text = [address?.city, address?.address1, address?.address2]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\bcali\b/.test(text) || text.includes("santiago de cali");
}

async function recordShopifySyncIssue(input: { sellerId: string; shopDomain: string; reference: string; reason: string; detail: string }) {
  const now = new Date().toISOString();
  const id = `ssi-${input.shopDomain}-${input.reference}`.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  await db.collection("shopifySyncIssues").doc(id).set({
    id,
    sellerId: input.sellerId,
    shopDomain: input.shopDomain,
    reference: input.reference,
    reason: input.reason,
    detail: input.detail.slice(0, 1500),
    status: "open",
    createdAt: now,
    updatedAt: now
  }, { merge: true });
}

function summarizeShopifyLineItems(items: Array<{ name?: string | null; title?: string | null; variant_title?: string | null; sku?: string | null; quantity?: number; properties?: Array<{ name?: string | null; value?: string | null }> }>, shopDomain: string) {
  const normalized = items.filter((item) => !isShippingLineItem(item)).map((item) => {
    const offer = operationalOfferForShopifyItem(shopDomain, item.sku);
    const variant = item.variant_title?.trim();
    const properties = (item.properties ?? [])
      .map((property) => [property.name?.trim(), property.value?.trim()].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(", ");
    const nameParts = [item.name?.trim() || item.title?.trim() || "Producto Shopify"];
    if (offer?.label && !nameParts[0].toLowerCase().includes(offer.label.toLowerCase())) nameParts.push(offer.label);
    if (variant && !nameParts[0].toLowerCase().includes(variant.toLowerCase())) nameParts.push(variant);
    if (properties) nameParts.push(properties);
    const name = nameParts.join(" · ");
    const sku = item.sku?.trim();
    const shopifyQuantity = item.quantity && item.quantity > 0 ? item.quantity : 1;
    const quantity = shopifyQuantity * (offer?.unitsPerSoldUnit ?? 1);
    return { name, sku, quantity };
  });
  if (normalized.length === 0) {
    return { productName: "Producto Shopify", sku: undefined, quantity: undefined };
  }
  return {
    productName: normalized.map((item) => `${item.name} x${item.quantity}`).join(" + "),
    sku: normalized.map((item) => item.sku).filter(Boolean).join(" + ") || undefined,
    quantity: normalized.reduce((sum, item) => sum + item.quantity, 0)
  };
}

function isShippingLineItem(item: { name?: string | null; title?: string | null; sku?: string | null }) {
  const text = [item.name, item.title, item.sku].filter(Boolean).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\benvio\b/.test(text) && /\bprioritario\b/.test(text);
}

function operationalOfferForShopifyItem(shopDomain: string, sku?: string | null) {
  if (shopDomain !== "p9g0sm-uv.myshopify.com") return null;
  const normalizedSku = sku?.trim();
  const koviaOffers: Record<string, { label: string; unitsPerSoldUnit: number }> = {
    "93070000": { label: "OFERTA 2 X 1", unitsPerSoldUnit: 2 },
    "94030000": { label: "OFERTA 2 X 1", unitsPerSoldUnit: 2 }
  };
  return normalizedSku ? koviaOffers[normalizedSku] ?? null : null;
}

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
