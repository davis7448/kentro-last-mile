import crypto from "crypto";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";

const maxPayloadBytes = 250_000;

// Cuerpo flexible: cada tienda puede mapear en UChat el identificador que tenga.
// Se resuelve por prioridad; todos opcionales.
const confirmSchema = z.object({
  orderId: z.union([z.string(), z.number()]).nullish(),
  shopifyNumericId: z.union([z.string(), z.number()]).nullish(),
  shopifyId: z.union([z.string(), z.number()]).nullish(),
  shopifyOrderId: z.union([z.string(), z.number()]).nullish(),
  orderName: z.union([z.string(), z.number()]).nullish(),
  orderNumber: z.union([z.string(), z.number()]).nullish(),
  order_number: z.union([z.string(), z.number()]).nullish(),
  trackingCode: z.union([z.string(), z.number()]).nullish(),
  tracking: z.union([z.string(), z.number()]).nullish(),
  guia: z.union([z.string(), z.number()]).nullish(),
  phone: z.union([z.string(), z.number()]).nullish(),
  customerPhone: z.union([z.string(), z.number()]).nullish(),
  telefono: z.union([z.string(), z.number()]).nullish(),
  sellerId: z.string().nullish()
}).passthrough();

const STATUS_LABEL: Record<string, string> = {
  imported: "Pendiente confirmacion",
  address_risk: "Revision de direccion",
  ready_to_assign: "Listo para asignar",
  assigned: "Asignado",
  call_pending: "Llamada pendiente",
  scheduled: "Agendado",
  pickup_pending: "Pendiente de recogida",
  picked_up: "Recogido",
  in_route: "En ruta",
  delivered: "Entregado",
  failed: "Fallido",
  retry_pending: "Reintento pendiente",
  cancelled: "Cancelado",
  liquidated: "Liquidado"
};

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function cleanId(value: string | number) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
}

function firstNonEmpty(...values: Array<string | number | null | undefined>) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

// Ultimos 10 digitos: tolera +57, espacios, guiones, prefijos de pais.
function phoneSuffix(value: string) {
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function orderNameVariants(value: string) {
  const trimmed = value.trim();
  const variants = new Set<string>();
  variants.add(trimmed);
  const withoutHash = trimmed.replace(/^#/, "");
  variants.add(withoutHash);
  variants.add(`#${withoutHash}`);
  return [...variants].filter(Boolean);
}

/**
 * Extrae la credencial (sellerId + key) de query string o header Authorization Bearer.
 * Formatos de Bearer aceptados: "sellerId:key" o solo "key" (con sellerId en query/body).
 */
function readCredentials(request: any, bodySellerId: string) {
  let sellerId = String(request.query.sellerId ?? "").trim() || bodySellerId;
  let key = String(request.query.key ?? "").trim();
  const authHeader = String(request.get("authorization") ?? "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.includes(":")) {
      const [rawSeller, rawKey] = token.split(":");
      if (!sellerId) sellerId = rawSeller.trim();
      if (!key) key = rawKey.trim();
    } else if (!key) {
      key = token;
    }
  }
  return { sellerId, key };
}

async function resolveOrderSnap(sellerId: string, input: z.infer<typeof confirmSchema>) {
  const orders = getFirestore().collection("orders");

  // 1. Id de documento Kentro (shopify-<numeric> o el interno).
  const orderId = firstNonEmpty(input.orderId);
  if (orderId) {
    const snap = await orders.doc(orderId).get();
    if (snap.exists) return snap;
  }

  // 2. Id numerico de Shopify -> doc id determinista.
  const numeric = firstNonEmpty(input.shopifyNumericId, input.shopifyId);
  if (numeric) {
    const snap = await orders.doc(`shopify-${cleanId(numeric)}`).get();
    if (snap.exists) return snap;
  }

  // 3. Nombre / numero de pedido de Shopify (#1234, 1234) acotado a la tienda.
  const name = firstNonEmpty(input.shopifyOrderId, input.orderName, input.orderNumber, input.order_number);
  if (name) {
    for (const variant of orderNameVariants(name)) {
      const query = await orders.where("sellerId", "==", sellerId).where("shopifyOrderId", "==", variant).limit(1).get();
      if (!query.empty) return query.docs[0];
    }
  }

  // 4. Guia / tracking KNT (single-field, se valida sellerId en memoria).
  const tracking = firstNonEmpty(input.trackingCode, input.tracking, input.guia);
  if (tracking) {
    const query = await orders.where("trackingCode", "==", tracking.toUpperCase()).limit(3).get();
    const match = query.docs.find((doc) => String(doc.data().sellerId ?? "") === sellerId);
    if (match) return match;
  }

  // 5. Telefono: match por ultimos 10 digitos sobre los pedidos recientes de la tienda.
  const phone = firstNonEmpty(input.phone, input.customerPhone, input.telefono);
  if (phone) {
    const target = phoneSuffix(phone);
    if (target) {
      const recent = await orders.where("sellerId", "==", sellerId).orderBy("createdAt", "desc").limit(200).get();
      const matches = recent.docs.filter((doc) => phoneSuffix(String(doc.data().customerPhone ?? "")) === target);
      // Preferimos el pendiente de confirmacion mas reciente; si no, el mas reciente.
      const pending = matches.find((doc) => String(doc.data().status ?? "") === "imported");
      if (pending) return pending;
      if (matches.length > 0) return matches[0];
    }
  }

  return null;
}

export const uchatConfirmWebhook = onRequest(async (request, response) => {
  if (request.method === "GET") {
    response.status(200).json({
      ok: true,
      endpoint: "uchat-confirm-webhook",
      method: "POST",
      auth: "?sellerId=<id>&key=<webhookKey>  o  Authorization: Bearer <key>",
      body: "JSON con uno de: shopifyOrderId | shopifyNumericId | orderId | trackingCode | phone",
      effect: "Pedido en 'imported' (Pendiente confirmacion) -> 'ready_to_assign' (Listo para asignar)"
    });
    return;
  }
  if (request.method !== "POST") {
    response.set("Allow", "GET, POST");
    response.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const parsed = confirmSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({ ok: false, error: "invalid_payload", validation: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const { sellerId, key } = readCredentials(request, firstNonEmpty(input.sellerId));
  if (!sellerId || !key) {
    response.status(401).json({ ok: false, error: "missing_credentials" });
    return;
  }

  const db = getFirestore();
  const configRef = db.collection("storeWebhookConfigs").doc(sellerId);
  const configSnap = await configRef.get();
  const config = configSnap.data() ?? {};
  const expectedKey = String(config.webhookKey ?? "");
  if (!configSnap.exists || config.status !== "active" || !expectedKey || !safeEqual(key, expectedKey)) {
    response.status(401).json({ ok: false, error: "invalid_key" });
    return;
  }

  const now = new Date().toISOString();
  const sampleRef = db.collection("uchatWebhookSamples").doc();
  const rawText = request.rawBody.subarray(0, maxPayloadBytes).toString("utf8");
  await sampleRef.set({
    id: sampleRef.id,
    sellerId,
    source: "uchat_confirm_webhook",
    contentType: String(request.get("content-type") ?? ""),
    userAgent: String(request.get("user-agent") ?? ""),
    payload: request.body && typeof request.body === "object" ? request.body : null,
    rawText,
    status: "received",
    createdAt: now
  });

  const hasIdentifier = firstNonEmpty(
    input.orderId, input.shopifyNumericId, input.shopifyId, input.shopifyOrderId,
    input.orderName, input.orderNumber, input.order_number,
    input.trackingCode, input.tracking, input.guia,
    input.phone, input.customerPhone, input.telefono
  );
  if (!hasIdentifier) {
    await sampleRef.set({ status: "rejected", reason: "missing_identifier", updatedAt: new Date().toISOString() }, { merge: true });
    response.status(400).json({ ok: false, matched: false, error: "missing_identifier", sampleId: sampleRef.id });
    return;
  }

  const found = await resolveOrderSnap(sellerId, input);
  if (!found) {
    await sampleRef.set({ status: "not_found", reason: "order_not_found", updatedAt: new Date().toISOString() }, { merge: true });
    response.status(200).json({ ok: false, matched: false, reason: "order_not_found", sampleId: sampleRef.id });
    return;
  }

  const orderRef = found.ref;
  // Transaccion con optimistic-concurrency: solo transiciona si sigue en 'imported'.
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) return { matched: false as const, reason: "order_not_found" as const };
    const current = snap.data() ?? {};
    if (String(current.sellerId ?? "") !== sellerId) {
      return { matched: false as const, reason: "seller_mismatch" as const };
    }
    if (current.status !== "imported") {
      // Idempotente: ya confirmado o mas avanzado.
      return {
        matched: true as const,
        transitioned: false as const,
        alreadyConfirmed: true as const,
        order: { id: snap.id, ...current }
      };
    }
    const updated = { ...current, addressRisk: "accepted", status: "ready_to_assign", confirmedVia: "uchat", updatedAt: now };
    transaction.set(orderRef, updated, { merge: true });
    transaction.set(db.collection("auditEvents").doc(`audit-${sampleRef.id}`), {
      id: `audit-${sampleRef.id}`,
      actorId: "uchat-confirm-webhook",
      actorRole: "system",
      action: "order.confirmed_uchat",
      entity: "order",
      entityId: snap.id,
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} confirmado por UChat/ChatBy`,
      createdAt: now
    });
    return { matched: true as const, transitioned: true as const, alreadyConfirmed: false as const, order: { id: snap.id, ...updated } };
  });

  if (!result.matched) {
    await sampleRef.set({ status: "not_found", reason: result.reason, updatedAt: new Date().toISOString() }, { merge: true });
    response.status(200).json({ ok: false, matched: false, reason: result.reason, sampleId: sampleRef.id });
    return;
  }

  const order = result.order as Record<string, any>;
  const status = String(order.status ?? "");
  await Promise.all([
    sampleRef.set({
      status: result.transitioned ? "confirmed" : "already_confirmed",
      orderId: order.id,
      trackingCode: order.trackingCode ?? null,
      updatedAt: new Date().toISOString()
    }, { merge: true }),
    configRef.set({ lastUchatConfirmAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true })
  ]);

  response.status(200).json({
    ok: true,
    matched: true,
    transitioned: result.transitioned,
    alreadyConfirmed: result.alreadyConfirmed,
    status,
    statusLabel: STATUS_LABEL[status] ?? status,
    orderId: order.id,
    trackingCode: order.trackingCode ?? null,
    shopifyOrderId: order.shopifyOrderId ?? null,
    customerName: order.customerName ?? null,
    sampleId: sampleRef.id
  });
});
