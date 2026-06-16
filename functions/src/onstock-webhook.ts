import crypto from "crypto";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";

const onstockWebhookKey = defineSecret("ONSTOCK_WEBHOOK_KEY");
const onstockSellerId = "seller-1780762661093";
const requiredSkuText = "ADMA";
const maxPayloadBytes = 250_000;

const nullableString = z.string().nullish();
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
  properties: z.array(z.object({
    name: nullableString,
    value: nullableString
  }).passthrough()).optional()
}).passthrough();
const orderSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: nullableString,
  order_number: z.union([z.string(), z.number()]).nullish(),
  total_price: z.union([z.string(), z.number()]),
  financial_status: nullableString,
  created_at: nullableString,
  tags: z.union([z.string(), z.array(z.string())]).nullish(),
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
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isCali(value: string) {
  const city = normalizeText(value);
  return city === "cali" || city === "santiago de cali";
}

function hasRequiredSkuOrTag(order: z.infer<typeof orderSchema>) {
  const skuMatch = order.line_items.some((item) => (item.sku ?? "").toUpperCase().includes(requiredSkuText));
  const tags = Array.isArray(order.tags) ? order.tags : String(order.tags ?? "").split(",");
  const tagMatch = tags.some((tag) => tag.trim().toUpperCase() === requiredSkuText || tag.trim().toUpperCase().includes(requiredSkuText));
  return skuMatch || tagMatch;
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

async function nextTrackingCode(transaction: Transaction) {
  const counterRef = getFirestore().doc("counters/orders");
  const counterSnap = await transaction.get(counterRef);
  const next = Number(counterSnap.data()?.next ?? 1);
  transaction.set(counterRef, {
    next: next + 1,
    prefix: "KNT",
    updatedAt: new Date().toISOString()
  }, { merge: true });
  return `KNT-${String(next).padStart(6, "0")}`;
}

export const onstockOrderWebhook = onRequest(
  { secrets: [onstockWebhookKey] },
  async (request, response) => {
    if (request.method === "GET") {
      response.status(200).json({
        ok: true,
        endpoint: "onstock-order-webhook",
        method: "POST",
        filters: { city: ["Cali", "Santiago de Cali"], skuContains: requiredSkuText, tagContains: requiredSkuText }
      });
      return;
    }
    if (request.method !== "POST") {
      response.set("Allow", "GET, POST");
      response.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    const suppliedKey = String(request.query.key ?? "");
    const expectedKey = process.env.ONSTOCK_WEBHOOK_KEY ?? "";
    if (!suppliedKey || !expectedKey || !safeEqual(suppliedKey, expectedKey)) {
      response.status(401).json({ ok: false, error: "invalid_key" });
      return;
    }

    const db = getFirestore();
    const now = new Date().toISOString();
    const sampleRef = db.collection("onstockWebhookSamples").doc();
    const rawText = request.rawBody.subarray(0, maxPayloadBytes).toString("utf8");
    await sampleRef.set({
      id: sampleRef.id,
      sellerId: onstockSellerId,
      source: "onstock_webhook",
      contentType: String(request.get("content-type") ?? ""),
      userAgent: String(request.get("user-agent") ?? ""),
      contentLength: request.rawBody.length,
      truncated: request.rawBody.length > maxPayloadBytes,
      payload: request.body && typeof request.body === "object" ? request.body : null,
      rawText,
      status: "received",
      createdAt: now
    });

    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) {
      await sampleRef.set({
        status: "rejected",
        reason: "invalid_payload",
        validation: parsed.error.flatten(),
        updatedAt: new Date().toISOString()
      }, { merge: true });
      response.status(202).json({ ok: true, created: false, reason: "invalid_payload", sampleId: sampleRef.id });
      return;
    }

    const incoming = parsed.data;
    const address = incoming.shipping_address ?? incoming.billing_address;
    const city = address?.city?.trim() ?? "";
    if (!hasRequiredSkuOrTag(incoming)) {
      await sampleRef.set({
        status: "ignored",
        reason: "sku_or_tag_filter",
        requiredSkuText,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      response.status(202).json({ ok: true, created: false, reason: "sku_or_tag_filter", sampleId: sampleRef.id });
      return;
    }
    if (!isCali(city)) {
      await sampleRef.set({
        status: "ignored",
        reason: "outside_active_city",
        city,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      response.status(202).json({ ok: true, created: false, reason: "outside_active_city", sampleId: sampleRef.id });
      return;
    }

    const totalCop = Math.round(Number(incoming.total_price));
    const customerName = address?.name?.trim()
      || [incoming.customer?.first_name, incoming.customer?.last_name].filter(Boolean).join(" ").trim();
    const customerPhone = address?.phone?.trim() || incoming.customer?.phone?.trim() || "";
    const addressRaw = [
      address?.address1,
      address?.address2,
      address?.city,
      address?.province,
      address?.country
    ].filter(Boolean).join(", ");
    const missing = [
      !customerName && "customer_name",
      !customerPhone && "customer_phone",
      !addressRaw && "address",
      (!Number.isFinite(totalCop) || totalCop <= 0) && "total_price"
    ].filter(Boolean);
    if (missing.length > 0) {
      await sampleRef.set({
        status: "rejected",
        reason: "missing_required_fields",
        missing,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      response.status(202).json({
        ok: true,
        created: false,
        reason: "missing_required_fields",
        missing,
        sampleId: sampleRef.id
      });
      return;
    }

    const externalId = cleanId(incoming.id);
    const orderRef = db.collection("orders").doc(`onstock-${externalId}`);
    const result = await db.runTransaction(async (transaction) => {
      const [existing, sellerSnap] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(db.collection("sellers").doc(onstockSellerId))
      ]);
      if (existing.exists) {
        return { created: false, order: existing.data() ?? { id: orderRef.id } };
      }
      if (!sellerSnap.exists) throw new Error("OnStock seller profile not found.");

      const seller = sellerSnap.data() ?? {};
      const trackingCode = await nextTrackingCode(transaction);
      const items = summarizeItems(incoming.line_items);
      const order = stripUndefined({
        id: orderRef.id,
        trackingCode,
        shopifyOrderId: incoming.name?.trim()
          || (incoming.order_number ? `#${incoming.order_number}` : `ONSTOCK-${externalId}`),
        shopifyNumericId: String(incoming.id),
        sellerId: onstockSellerId,
        driverId: null,
        cityId: "city-cali",
        customerName,
        customerPhone,
        addressRaw,
        totalCop,
        productName: items.productName,
        sku: items.sku,
        quantity: items.quantity,
        pickupPointName: typeof seller.pickupPointName === "string" && seller.pickupPointName.trim()
          ? seller.pickupPointName.trim()
          : String(seller.name ?? "OnStock"),
        pickupAddress: typeof seller.pickupAddress === "string" ? seller.pickupAddress.trim() : "",
        paymentMethod: incoming.financial_status === "paid" ? "prepaid" : "cod",
        fulfillmentMode: "seller_pickup",
        addressRisk: "review",
        status: "imported",
        evidence: [],
        source: "onstock_webhook",
        webhookSampleId: sampleRef.id,
        createdAt: incoming.created_at ?? now,
        updatedAt: now
      });
      transaction.create(orderRef, order);
      transaction.set(db.collection("auditEvents").doc(`audit-${sampleRef.id}`), {
        id: `audit-${sampleRef.id}`,
        actorId: "onstock-webhook",
        actorRole: "system",
        action: "order.webhook_imported",
        entity: "order",
        entityId: orderRef.id,
        summary: `Pedido ${trackingCode} importado desde webhook OnStock`,
        createdAt: now
      });
      return { created: true, order };
    });

    await sampleRef.set({
      status: result.created ? "order_created" : "duplicate",
      orderId: result.order.id,
      trackingCode: result.order.trackingCode ?? null,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    response.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      duplicate: !result.created,
      sampleId: sampleRef.id,
      orderId: result.order.id,
      trackingCode: result.order.trackingCode ?? null
    });
  }
);
