import crypto from "crypto";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { z } from "zod";

const nullableString = z.string().nullish();
const defaultSkuContains = "ADMA";
const defaultTagContains = "ADMA";
const defaultCityAllowlist = ["Cali", "Santiago de Cali"];
const maxPayloadBytes = 250_000;

const createStoreWebhookConfigSchema = z.object({
  sellerId: z.string().min(1),
  shopDomain: z.string().optional(),
  skuContains: z.string().optional(),
  tagContains: z.string().optional()
});
const addressSchema = z.object({
  name: nullableString,
  phone: nullableString,
  address1: nullableString,
  address2: nullableString,
  city: nullableString,
  province: nullableString,
  country: nullableString
}).passthrough();
const lineItemSchema = z.object({
  name: nullableString,
  title: nullableString,
  variant_title: nullableString,
  sku: nullableString,
  quantity: z.coerce.number().positive().optional(),
  properties: z.array(z.object({ name: nullableString, value: nullableString }).passthrough()).optional()
}).passthrough();
const orderSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: nullableString,
  order_number: z.union([z.string(), z.number()]).nullish(),
  total_price: z.union([z.string(), z.number()]),
  financial_status: nullableString,
  created_at: nullableString,
  tags: z.union([z.string(), z.array(z.string())]).nullish(),
  shop_domain: nullableString,
  shipping_address: addressSchema.nullish(),
  billing_address: addressSchema.nullish(),
  customer: z.object({
    first_name: nullableString,
    last_name: nullableString,
    phone: nullableString
  }).passthrough().nullish(),
  line_items: z.array(lineItemSchema).min(1)
}).passthrough();

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function normalizeFilter(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : fallback;
}

function tagsList(tags: string | string[] | null | undefined) {
  if (Array.isArray(tags)) return tags.map((tag) => tag.trim()).filter(Boolean);
  return String(tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

function matchesOrderFilters(order: z.infer<typeof orderSchema>, skuContains: string, tagContains: string) {
  const skuMatch = (order.line_items ?? []).some((item) => (item.sku ?? "").toUpperCase().includes(skuContains));
  const tagMatch = tagsList(order.tags).some((tag) => tag.toUpperCase() === tagContains || tag.toUpperCase().includes(tagContains));
  return skuMatch || tagMatch;
}

function isAllowedCity(city: string, allowlist: string[]) {
  const normalizedCity = normalizeText(city);
  return allowlist.map(normalizeText).includes(normalizedCity);
}

function summarizeItems(items: z.infer<typeof lineItemSchema>[]) {
  const normalized = items.map((item) => {
    const baseName = item.name?.trim() || item.title?.trim() || "Producto Shopify";
    const variant = item.variant_title?.trim();
    const properties = (item.properties ?? [])
      .map((property) => [property.name?.trim(), property.value?.trim()].filter(Boolean).join(": "))
      .filter(Boolean);
    const nameParts = [baseName];
    if (variant && !baseName.toLowerCase().includes(variant.toLowerCase())) nameParts.push(variant);
    nameParts.push(...properties);
    return {
      name: nameParts.join(" | "),
      sku: item.sku?.trim(),
      quantity: item.quantity ?? 1
    };
  });
  return {
    productName: normalized.map((item) => `${item.name} x${item.quantity}`).join(" + "),
    sku: normalized.map((item) => item.sku).filter(Boolean).join(" + ") || undefined,
    quantity: normalized.reduce((sum, item) => sum + item.quantity, 0)
  };
}

function cleanId(value: string | number) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function webhookUrl(sellerId: string, key: string) {
  return `https://us-central1-kentro-last-mile.cloudfunctions.net/storeOrderWebhook?sellerId=${encodeURIComponent(sellerId)}&key=${encodeURIComponent(key)}`;
}

async function nextTrackingCode(transaction: Transaction) {
  const counterRef = getFirestore().doc("counters/orders");
  const counterSnap = await transaction.get(counterRef);
  const next = Number(counterSnap.data()?.next ?? 1);
  transaction.set(counterRef, { next: next + 1, prefix: "KNT", updatedAt: new Date().toISOString() }, { merge: true });
  return `KNT-${String(next).padStart(6, "0")}`;
}

export const createStoreWebhookConfig = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can create webhook configs.");
  }
  const parsed = createStoreWebhookConfigSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Invalid webhook config data.", parsed.error.flatten());
  const input = parsed.data;
  if (role === "seller" && input.sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Sellers can only create their own webhook config.");
  }

  const db = getFirestore();
  const sellerSnap = await db.collection("sellers").doc(input.sellerId).get();
  if (!sellerSnap.exists) throw new HttpsError("not-found", "Seller not found.");
  const seller = sellerSnap.data() ?? {};
  const now = new Date().toISOString();
  const ref = db.collection("storeWebhookConfigs").doc(input.sellerId);
  const existing = await ref.get();
  const webhookKey = typeof existing.data()?.webhookKey === "string" ? String(existing.data()?.webhookKey) : crypto.randomBytes(24).toString("hex");
  const config = {
    id: ref.id,
    sellerId: input.sellerId,
    sellerName: String(seller.name ?? input.sellerId),
    shopDomain: input.shopDomain?.trim() || String(seller.shopDomain ?? ""),
    webhookKey,
    skuContains: normalizeFilter(input.skuContains, defaultSkuContains),
    tagContains: normalizeFilter(input.tagContains, defaultTagContains),
    cityAllowlist: defaultCityAllowlist,
    status: "active",
    createdAt: typeof existing.data()?.createdAt === "string" ? String(existing.data()?.createdAt) : now,
    updatedAt: now
  };
  await ref.set(config, { merge: true });
  return { config, webhookUrl: webhookUrl(input.sellerId, webhookKey) };
});

export const storeOrderWebhook = onRequest(async (request, response) => {
  if (request.method === "GET") {
    response.status(200).json({ ok: true, endpoint: "store-order-webhook", method: "POST" });
    return;
  }
  if (request.method !== "POST") {
    response.set("Allow", "GET, POST");
    response.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const sellerId = String(request.query.sellerId ?? "").trim();
  const suppliedKey = String(request.query.key ?? "");
  if (!sellerId || !suppliedKey) {
    response.status(401).json({ ok: false, error: "missing_credentials" });
    return;
  }

  const db = getFirestore();
  const configRef = db.collection("storeWebhookConfigs").doc(sellerId);
  const configSnap = await configRef.get();
  const config = configSnap.data() ?? {};
  const expectedKey = String(config.webhookKey ?? "");
  if (!configSnap.exists || config.status !== "active" || !expectedKey || !safeEqual(suppliedKey, expectedKey)) {
    response.status(401).json({ ok: false, error: "invalid_key" });
    return;
  }

  const now = new Date().toISOString();
  const sampleRef = db.collection("storeWebhookSamples").doc();
  const rawText = request.rawBody.subarray(0, maxPayloadBytes).toString("utf8");
  await sampleRef.set({
    id: sampleRef.id,
    sellerId,
    source: "store_order_webhook",
    contentType: String(request.get("content-type") ?? ""),
    userAgent: String(request.get("user-agent") ?? ""),
    topic: String(request.get("x-shopify-topic") ?? ""),
    shopDomain: String(request.get("x-shopify-shop-domain") ?? request.body?.shop_domain ?? config.shopDomain ?? ""),
    contentLength: request.rawBody.length,
    truncated: request.rawBody.length > maxPayloadBytes,
    payload: request.body && typeof request.body === "object" ? request.body : null,
    rawText,
    status: "received",
    createdAt: now
  });

  const parsed = orderSchema.safeParse(request.body);
  if (!parsed.success) {
    await sampleRef.set({ status: "rejected", reason: "invalid_payload", validation: parsed.error.flatten(), updatedAt: new Date().toISOString() }, { merge: true });
    response.status(202).json({ ok: true, created: false, reason: "invalid_payload", sampleId: sampleRef.id });
    return;
  }

  const order = parsed.data;
  const address = order.shipping_address ?? order.billing_address;
  const city = address?.city?.trim() ?? "";
  const skuContains = normalizeFilter(config.skuContains, defaultSkuContains);
  const tagContains = normalizeFilter(config.tagContains, defaultTagContains);
  const cityAllowlist = Array.isArray(config.cityAllowlist) && config.cityAllowlist.length > 0 ? config.cityAllowlist.map(String) : defaultCityAllowlist;
  if (!matchesOrderFilters(order, skuContains, tagContains)) {
    await sampleRef.set({ status: "ignored", reason: "sku_or_tag_filter", skuContains, tagContains, updatedAt: new Date().toISOString() }, { merge: true });
    response.status(202).json({ ok: true, created: false, reason: "sku_or_tag_filter", sampleId: sampleRef.id });
    return;
  }
  if (!isAllowedCity(city, cityAllowlist)) {
    await sampleRef.set({ status: "ignored", reason: "outside_active_city", city, updatedAt: new Date().toISOString() }, { merge: true });
    response.status(202).json({ ok: true, created: false, reason: "outside_active_city", sampleId: sampleRef.id });
    return;
  }

  const totalCop = Math.round(Number(order.total_price));
  const customerName = address?.name?.trim() || [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ").trim();
  const customerPhone = address?.phone?.trim() || order.customer?.phone?.trim() || "";
  const addressRaw = [address?.address1, address?.address2, address?.city, address?.province, address?.country].filter(Boolean).join(", ");
  const missing = [
    !customerName && "customer_name",
    !customerPhone && "customer_phone",
    !addressRaw && "address",
    (!Number.isFinite(totalCop) || totalCop <= 0) && "total_price"
  ].filter(Boolean);
  if (missing.length > 0) {
    await sampleRef.set({ status: "rejected", reason: "missing_required_fields", missing, updatedAt: new Date().toISOString() }, { merge: true });
    response.status(202).json({ ok: true, created: false, reason: "missing_required_fields", missing, sampleId: sampleRef.id });
    return;
  }

  const externalId = cleanId(order.id);
  const orderRef = db.collection("orders").doc(`shopify-${externalId}`);
  const result = await db.runTransaction(async (transaction) => {
    const [existing, sellerSnap] = await Promise.all([transaction.get(orderRef), transaction.get(db.collection("sellers").doc(sellerId))]);
    if (existing.exists) return { created: false, order: existing.data() ?? { id: orderRef.id } };
    if (!sellerSnap.exists) throw new Error("Seller profile not found.");
    const seller = sellerSnap.data() ?? {};
    const trackingCode = await nextTrackingCode(transaction);
    const items = summarizeItems(order.line_items);
    const orderDoc = stripUndefined({
      id: orderRef.id,
      trackingCode,
      shopifyOrderId: order.name?.trim() || (order.order_number ? `#${order.order_number}` : `SHOPIFY-${externalId}`),
      shopifyNumericId: String(order.id),
      shopDomain: String(request.get("x-shopify-shop-domain") ?? order.shop_domain ?? config.shopDomain ?? ""),
      sellerId,
      driverId: null,
      cityId: typeof seller.cityId === "string" ? seller.cityId : "city-cali",
      customerName,
      customerPhone,
      addressRaw,
      totalCop,
      productName: items.productName,
      sku: items.sku,
      quantity: items.quantity,
      pickupPointName: typeof seller.pickupPointName === "string" && seller.pickupPointName.trim() ? seller.pickupPointName.trim() : String(seller.name ?? "Punto de recogida"),
      pickupAddress: typeof seller.pickupAddress === "string" ? seller.pickupAddress.trim() : "",
      paymentMethod: order.financial_status === "paid" ? "prepaid" : "cod",
      fulfillmentMode: "seller_pickup",
      addressRisk: "review",
      status: "imported",
      evidence: [],
      source: "store_order_webhook",
      webhookSampleId: sampleRef.id,
      tags: tagsList(order.tags).join(", "),
      createdAt: order.created_at ?? now,
      updatedAt: now
    });
    transaction.create(orderRef, orderDoc);
    transaction.set(db.collection("auditEvents").doc(`audit-${sampleRef.id}`), {
      id: `audit-${sampleRef.id}`,
      actorId: "store-order-webhook",
      actorRole: "system",
      action: "order.webhook_imported",
      entity: "order",
      entityId: orderRef.id,
      summary: `Pedido ${trackingCode} importado desde webhook Shopify`,
      createdAt: now
    });
    return { created: true, order: orderDoc };
  });

  await Promise.all([
    sampleRef.set({ status: result.created ? "order_created" : "duplicate", orderId: result.order.id, trackingCode: result.order.trackingCode ?? null, updatedAt: new Date().toISOString() }, { merge: true }),
    configRef.set({ lastWebhookAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true })
  ]);
  response.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    duplicate: !result.created,
    sampleId: sampleRef.id,
    orderId: result.order.id,
    trackingCode: result.order.trackingCode ?? null
  });
});
