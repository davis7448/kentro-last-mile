import crypto from "crypto";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onRequest, type Request } from "firebase-functions/v2/https";

const mercadotiendaWebhookKey = defineSecret("CF7_MERCADOTIENDA_WEBHOOK_KEY");
const mercadotiendaSellerId = "seller-1780688354552";
const maxSampleBytes = 100_000;
const standardFieldNames = new Set([
  "nombre",
  "whatsapp",
  "telefono",
  "direccion",
  "barrio",
  "ciudad",
  "departamento",
  "producto",
  "title",
  "titulo",
  "valor",
  "total",
  "precio",
  "monto",
  "referencia",
  "order_id",
  "pedido"
]);

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function samplePayload(request: Request) {
  const contentType = String(request.get("content-type") ?? "").toLowerCase();
  const rawText = request.rawBody.subarray(0, maxSampleBytes).toString("utf8");

  if (contentType.includes("application/json") && request.body && typeof request.body === "object") {
    return { format: "json", payload: request.body, rawText };
  }
  if (contentType.includes("application/x-www-form-urlencoded") && request.body && typeof request.body === "object") {
    return { format: "urlencoded", payload: request.body, rawText };
  }
  if (contentType.includes("multipart/form-data")) {
    return { format: "multipart", rawText };
  }
  return {
    format: typeof request.body === "object" ? "object" : "raw",
    payload: request.body && typeof request.body === "object" ? request.body : undefined,
    rawText
  };
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join(", ");
  return "";
}

function firstValue(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return "";
}

function parseCop(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
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

function parseProductAndTotal(payload: Record<string, unknown>) {
  const combinedProduct = firstValue(payload, ["NOMBRE", "producto", "title", "titulo"]);
  const explicitTotal = firstValue(payload, ["valor", "total", "precio", "monto"]);
  const priceMatch = combinedProduct.match(/(?:\s*[-\u2013\u2014]\s*)?\$\s*([\d.,]+)\s*$/);
  const baseProduct = priceMatch
    ? combinedProduct.slice(0, priceMatch.index).trim()
    : combinedProduct.trim();
  const totalCop = parseCop(explicitTotal || priceMatch?.[1] || "");

  const variants = Object.entries(payload)
    .filter(([key]) => key !== "NOMBRE" && !standardFieldNames.has(key.toLowerCase()) && !key.startsWith("_"))
    .map(([key, value]) => {
      const normalized = stringValue(value);
      return normalized ? `${key}: ${normalized}` : "";
    })
    .filter(Boolean);

  return {
    productName: [baseProduct, ...variants].filter(Boolean).join(" | "),
    totalCop
  };
}

function parseOrderPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "payload_not_object" } as const;
  }

  const fields = payload as Record<string, unknown>;
  const customerName = firstValue(fields, ["nombre"]);
  const customerPhone = firstValue(fields, ["whatsapp", "telefono"]);
  const city = firstValue(fields, ["ciudad"]);
  const addressParts = [
    firstValue(fields, ["direccion"]),
    firstValue(fields, ["barrio"]),
    city,
    firstValue(fields, ["departamento"])
  ].filter(Boolean);
  const { productName, totalCop } = parseProductAndTotal(fields);
  const missing = [
    !customerName && "nombre",
    !customerPhone && "whatsapp",
    addressParts.length === 0 && "direccion",
    !city && "ciudad",
    !productName && "NOMBRE",
    !totalCop && "valor"
  ].filter(Boolean);

  if (missing.length > 0) {
    return { error: "missing_required_fields", missing } as const;
  }
  if (!isCali(city)) {
    return { error: "outside_active_city", city } as const;
  }

  return {
    order: {
      customerName,
      customerPhone,
      addressRaw: addressParts.join(", "),
      productName,
      totalCop
    }
  } as const;
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

export const mercadotiendaContactFormWebhook = onRequest(
  { secrets: [mercadotiendaWebhookKey] },
  async (request, response) => {
    if (request.method === "GET") {
      response.status(200).json({ ok: true, endpoint: "mercadotienda-contact-form-7", method: "POST" });
      return;
    }
    if (request.method !== "POST") {
      response.set("Allow", "GET, POST");
      response.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    const suppliedKey = String(request.query.key ?? "");
    const expectedKey = process.env.CF7_MERCADOTIENDA_WEBHOOK_KEY ?? "";
    if (!suppliedKey || !expectedKey || !safeEqual(suppliedKey, expectedKey)) {
      response.status(401).json({ ok: false, error: "invalid_key" });
      return;
    }

    const now = new Date().toISOString();
    const db = getFirestore();
    const sampleRef = db.collection("contactFormWebhookSamples").doc();
    const sample = samplePayload(request);
    await sampleRef.set({
      id: sampleRef.id,
      sellerId: mercadotiendaSellerId,
      source: "contact_form_7",
      contentType: String(request.get("content-type") ?? ""),
      userAgent: String(request.get("user-agent") ?? ""),
      contentLength: request.rawBody.length,
      truncated: request.rawBody.length > maxSampleBytes,
      ...sample,
      status: "received",
      createdAt: now
    });

    const parsed = parseOrderPayload(sample.payload);
    if ("error" in parsed) {
      await sampleRef.set({
        status: "rejected",
        error: parsed.error,
        missing: "missing" in parsed ? parsed.missing : [],
        rejectedCity: "city" in parsed ? parsed.city : null,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      response.status(202).json({
        ok: true,
        received: true,
        created: false,
        sampleId: sampleRef.id,
        error: parsed.error,
        missing: "missing" in parsed ? parsed.missing : [],
        city: "city" in parsed ? parsed.city : undefined
      });
      return;
    }

    const sellerRef = db.collection("sellers").doc(mercadotiendaSellerId);
    const orderRef = db.collection("orders").doc(`cf7-${sampleRef.id}`);
    const order = await db.runTransaction(async (transaction) => {
      const sellerSnap = await transaction.get(sellerRef);
      if (!sellerSnap.exists) throw new Error("Mercadotienda seller profile not found.");
      const seller = sellerSnap.data() ?? {};
      const trackingCode = await nextTrackingCode(transaction);
      const orderDoc = {
        id: orderRef.id,
        trackingCode,
        shopifyOrderId: `MT-${sampleRef.id.slice(0, 8).toUpperCase()}`,
        sellerId: mercadotiendaSellerId,
        driverId: null,
        cityId: typeof seller.cityId === "string" ? seller.cityId : "city-cali",
        customerName: parsed.order.customerName,
        customerPhone: parsed.order.customerPhone,
        addressRaw: parsed.order.addressRaw,
        totalCop: parsed.order.totalCop,
        productName: parsed.order.productName,
        pickupPointName: typeof seller.pickupPointName === "string" && seller.pickupPointName.trim()
          ? seller.pickupPointName.trim()
          : String(seller.name ?? "Punto de recogida"),
        pickupAddress: typeof seller.pickupAddress === "string" ? seller.pickupAddress.trim() : "",
        paymentMethod: "cod",
        fulfillmentMode: "seller_pickup",
        addressRisk: "review",
        status: "imported",
        evidence: [],
        source: "contact_form_7_webhook",
        webhookSampleId: sampleRef.id,
        createdAt: now,
        updatedAt: now
      };
      transaction.create(orderRef, orderDoc);
      transaction.set(db.collection("auditEvents").doc(`audit-${sampleRef.id}`), {
        id: `audit-${sampleRef.id}`,
        actorId: "contact-form-7",
        actorRole: "system",
        action: "order.webhook_imported",
        entity: "order",
        entityId: orderRef.id,
        summary: `Pedido ${trackingCode} importado desde Contact Form 7`,
        createdAt: now
      });
      return orderDoc;
    });

    await sampleRef.set({
      status: "order_created",
      orderId: order.id,
      trackingCode: order.trackingCode,
      parsedOrder: parsed.order,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    response.status(201).json({
      ok: true,
      received: true,
      created: true,
      sampleId: sampleRef.id,
      orderId: order.id,
      trackingCode: order.trackingCode
    });
  }
);
