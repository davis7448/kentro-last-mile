import crypto from "crypto";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { z } from "zod";

const defaultScopes = ["read_orders", "read_fulfillments", "read_products"];
const shopifyApiKey = defineSecret("SHOPIFY_APP_API_KEY");
const shopifyApiSecret = defineSecret("SHOPIFY_APP_API_SECRET");
const shopifyPilotApiKey = defineSecret("SHOPIFY_PILOT_APP_API_KEY");
const shopifyPilotApiSecret = defineSecret("SHOPIFY_PILOT_APP_API_SECRET");
const shopifyU0jxrmApiKey = defineSecret("SHOPIFY_U0JXRM_APP_API_KEY");
const shopifyU0jxrmApiSecret = defineSecret("SHOPIFY_U0JXRM_APP_API_SECRET");
const shopifyN1v0swApiKey = defineSecret("SHOPIFY_N1V0SW_APP_API_KEY");
const shopifyN1v0swApiSecret = defineSecret("SHOPIFY_N1V0SW_APP_API_SECRET");
const nullableString = z.string().nullish();
const shopifyOrderSchema = z.object({
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

const importShopifyOrderSchema = z.object({
  shopDomain: z.string().min(1),
  reference: z.string().min(1),
  sellerId: z.string().optional()
});
const syncShopifyHistoricalOrdersSchema = z.object({
  shopDomain: z.string().min(1),
  sellerId: z.string().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});
const dandaSellerId = "seller-1779315416119";

type ShopifyAppKind = "public" | "pilot" | "u0jxrm" | "n1v0sw";

function config(kind: ShopifyAppKind = "public") {
  const prefix =
    kind === "pilot"
      ? "SHOPIFY_PILOT_APP"
      : kind === "u0jxrm"
        ? "SHOPIFY_U0JXRM_APP"
        : kind === "n1v0sw"
          ? "SHOPIFY_N1V0SW_APP"
          : "SHOPIFY_APP";
  return {
    apiKey: process.env[`${prefix}_API_KEY`] ?? "",
    apiSecret: process.env[`${prefix}_API_SECRET`] ?? "",
    scopes: (process.env.SHOPIFY_APP_SCOPES ?? defaultScopes.join(",")).split(",").map((scope) => scope.trim()).filter(Boolean)
  };
}

function normalizeShop(shop: string) {
  const cleaned = shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(cleaned)) return "";
  return cleaned;
}

function storeIdForShop(shop: string) {
  return shop.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function callbackUrl(request: { get(name: string): string | undefined }) {
  return `https://${request.get("host")}/shopifyOAuthCallback`;
}

function appUrl() {
  return process.env.KENTRO_APP_URL ?? "https://kentro.com.co";
}

function hmacForQuery(query: Record<string, string>, secret: string) {
  const message = Object.entries(query)
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export const shopifyOAuthCallback = onRequest({ secrets: [shopifyApiKey, shopifyApiSecret, shopifyPilotApiKey, shopifyPilotApiSecret, shopifyU0jxrmApiKey, shopifyU0jxrmApiSecret, shopifyN1v0swApiKey, shopifyN1v0swApiSecret] }, async (request, response) => {
  const query = Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key, String(value)]));
  const shop = normalizeShop(query.shop ?? "");
  const state = query.state ?? "";
  const hmac = query.hmac ?? "";
  const code = query.code ?? "";

  if (!shop || !state || !hmac || !code) {
    response.status(400).send("Callback Shopify incompleto.");
    return;
  }

  const db = getFirestore();
  const stateRef = db.collection("shopifyOAuthStates").doc(state);
  const stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    response.status(400).send("Estado OAuth no encontrado o ya usado.");
    return;
  }
  const stateData = stateSnap.data() ?? {};
  if (String(stateData.shopDomain) !== shop || Date.parse(String(stateData.expiresAt)) < Date.now()) {
    response.status(400).send("Estado OAuth vencido o no coincide con la tienda.");
    return;
  }
  const appKind: ShopifyAppKind =
    stateData.appKind === "pilot"
      ? "pilot"
      : stateData.appKind === "u0jxrm"
        ? "u0jxrm"
        : stateData.appKind === "n1v0sw"
          ? "n1v0sw"
          : "public";
  const { apiKey, apiSecret, scopes } = config(appKind);
  if (!apiKey || !apiSecret) {
    response.status(501).send("Shopify App no esta configurada.");
    return;
  }
  if (!timingSafeEqual(hmacForQuery(query, apiSecret), hmac)) {
    response.status(401).send("HMAC Shopify invalido.");
    return;
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code })
  });
  if (!tokenResponse.ok) {
    response.status(502).send("Shopify no entrego access token.");
    return;
  }
  const tokenJson = await tokenResponse.json() as { access_token?: string; scope?: string };
  if (!tokenJson.access_token) {
    response.status(502).send("Respuesta Shopify sin access token.");
    return;
  }

  const webhook = await registerOrdersCreateWebhook(shop, tokenJson.access_token);
  const now = new Date().toISOString();
  const sellerId = String(stateData.sellerId || "unassigned");
  const storeId = storeIdForShop(shop);
  const existingStore = await db.collection("shopifyStores").doc(storeId).get();
  const resolvedSellerId = sellerId === "unassigned" && typeof existingStore.data()?.sellerId === "string" ? String(existingStore.data()?.sellerId) : sellerId;
  const requestSnap = resolvedSellerId !== "unassigned"
    ? await db.collection("shopifyInstallRequests").where("sellerId", "==", resolvedSellerId).where("shopDomain", "==", shop).limit(1).get()
    : null;
  const orderSkuContains = normalizeSkuFilter(requestSnap?.docs[0]?.data()?.orderSkuContains);
  await db.collection("shopifyStores").doc(storeId).set({
    id: storeId,
    sellerId: resolvedSellerId,
    shopDomain: shop,
    status: "connected",
    scopes: tokenJson.scope ? tokenJson.scope.split(",").map((scope) => scope.trim()) : scopes,
    ...(orderSkuContains ? { orderSkuContains } : {}),
    webhookId: webhook.id,
    connectedAt: now,
    updatedAt: now
  }, { merge: true });
  await db.collection("shopifyStoreSecrets").doc(storeId).set({
    id: storeId,
    sellerId: resolvedSellerId,
    shopDomain: shop,
    accessToken: tokenJson.access_token,
    updatedAt: now
  }, { merge: true });
  if (resolvedSellerId !== "unassigned") {
    await db.collection("sellers").doc(resolvedSellerId).set({ shopDomain: shop, updatedAt: now }, { merge: true });
    await Promise.all((requestSnap?.docs ?? []).map((doc) => doc.ref.set({ status: "installed", updatedAt: now }, { merge: true })));
  }
  await stateRef.delete();

  response.redirect(`${appUrl()}/`);
});

export const shopifyOAuthStart = onRequest({ secrets: [shopifyApiKey, shopifyApiSecret] }, async (request, response) => {
  const requestedSellerId = String(request.query.sellerId ?? "unassigned").trim() || "unassigned";
  const shop = normalizeShop(String(request.query.shop ?? ""));
  const { apiKey, apiSecret, scopes } = config();

  if (!shop) {
    response.status(400).send("Falta dominio Shopify valido.");
    return;
  }

  if (!apiKey || !apiSecret) {
    response.status(501).send("Shopify App no esta configurada. Define SHOPIFY_APP_API_KEY y SHOPIFY_APP_API_SECRET en Functions.");
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const sellerId = await resolveSellerIdForInstall(shop, requestedSellerId);
  await getFirestore().collection("shopifyOAuthStates").doc(state).set({
    id: state,
    appKind: "public",
    sellerId,
    shopDomain: shop,
    scopes,
    createdAt: now.toISOString(),
    expiresAt
  });

  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes.join(","),
    redirect_uri: callbackUrl(request),
    state
  });
  response.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
});

export const shopifyPilotOAuthStart = onRequest({ secrets: [shopifyPilotApiKey, shopifyPilotApiSecret] }, async (request, response) => {
  const requestedSellerId = String(request.query.sellerId ?? "unassigned").trim() || "unassigned";
  const shop = normalizeShop(String(request.query.shop ?? ""));
  const { apiKey, apiSecret, scopes } = config("pilot");

  if (!shop) {
    response.status(400).send("Falta dominio Shopify valido.");
    return;
  }

  if (!apiKey || !apiSecret) {
    response.status(501).send("Shopify Pilot App no esta configurada. Define SHOPIFY_PILOT_APP_API_KEY y SHOPIFY_PILOT_APP_API_SECRET en Functions.");
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const sellerId = await resolveSellerIdForInstall(shop, requestedSellerId);
  await getFirestore().collection("shopifyOAuthStates").doc(state).set({
    id: state,
    appKind: "pilot",
    sellerId,
    shopDomain: shop,
    scopes,
    createdAt: now.toISOString(),
    expiresAt
  });

  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes.join(","),
    redirect_uri: callbackUrl(request),
    state
  });
  response.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
});

export const shopifyTenantOAuthStart = onRequest({ secrets: [shopifyU0jxrmApiKey, shopifyU0jxrmApiSecret, shopifyN1v0swApiKey, shopifyN1v0swApiSecret] }, async (request, response) => {
  const requestedSellerId = String(request.query.sellerId ?? "unassigned").trim() || "unassigned";
  const shop = normalizeShop(String(request.query.shop ?? ""));
  const appKind = tenantAppKindForShop(shop);
  if (!shop || !appKind) {
    response.status(400).send("Falta dominio Shopify valido o no hay app piloto asignada para esta tienda.");
    return;
  }

  const { apiKey, apiSecret, scopes } = config(appKind);
  if (!apiKey || !apiSecret) {
    response.status(501).send("Shopify Tenant App no esta configurada en Functions.");
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const sellerId = await resolveSellerIdForInstall(shop, requestedSellerId);
  await getFirestore().collection("shopifyOAuthStates").doc(state).set({
    id: state,
    appKind,
    sellerId,
    shopDomain: shop,
    scopes,
    createdAt: now.toISOString(),
    expiresAt
  });

  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes.join(","),
    redirect_uri: callbackUrl(request),
    state
  });
  response.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
});

function tenantAppKindForShop(shop: string): Extract<ShopifyAppKind, "u0jxrm" | "n1v0sw"> | null {
  if (shop === "u0jxrm-tk.myshopify.com") return "u0jxrm";
  if (shop === "n1v0sw-vz.myshopify.com") return "n1v0sw";
  return null;
}

async function resolveSellerIdForInstall(shop: string, requestedSellerId: string) {
  if (requestedSellerId && requestedSellerId !== "unassigned") return requestedSellerId;
  const snap = await getFirestore()
    .collection("shopifyInstallRequests")
    .where("shopDomain", "==", shop)
    .where("status", "in", ["requested", "link_ready"])
    .limit(1)
    .get();
  const sellerId = snap.docs[0]?.data()?.sellerId;
  return typeof sellerId === "string" && sellerId ? sellerId : "unassigned";
}

export const importShopifyOrder = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can import Shopify orders.");
  }

  const parsed = importShopifyOrderSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid Shopify import data.", parsed.error.flatten());
  }

  const shop = normalizeShop(parsed.data.shopDomain);
  if (!shop) throw new HttpsError("invalid-argument", "Invalid Shopify store domain.");

  const db = getFirestore();
  const storeSnap = await db.collection("shopifyStores").where("shopDomain", "==", shop).where("status", "==", "connected").limit(1).get();
  if (storeSnap.empty) throw new HttpsError("not-found", "Shopify store is not connected.");
  const storeDoc = storeSnap.docs[0];
  const store = storeDoc.data();
  const storeSellerId = String(store.sellerId ?? "");
  const targetSellerId = role === "admin" ? String(parsed.data.sellerId || storeSellerId || "") : String(sellerClaim || "");
  if (!targetSellerId || targetSellerId === "unassigned") {
    throw new HttpsError("failed-precondition", "Assign this Shopify store to a seller before importing orders.");
  }
  if (role === "seller" && storeSellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Sellers can only import orders from their connected stores.");
  }

  const secretSnap = await db.collection("shopifyStoreSecrets").doc(storeDoc.id).get();
  const accessToken = String(secretSnap.data()?.accessToken ?? "");
  if (!accessToken) {
    await recordShopifySyncIssue(db, {
      sellerId: targetSellerId,
      shopDomain: shop,
      reference: parsed.data.reference,
      reason: "La tienda Shopify no tiene token de conexion activo.",
      detail: "Reconecta la tienda o revisa la instalacion de la app."
    });
    throw new HttpsError("failed-precondition", "Shopify store token is missing.");
  }

  const existingOrder = await findExistingImportedOrder(db, targetSellerId, shop, parsed.data.reference);
  if (existingOrder) {
    await resolveShopifySyncIssue(db, targetSellerId, shop, parsed.data.reference, String(existingOrder.id));
    return { order: existingOrder };
  }

  const shopifyOrder = await fetchShopifyOrder(shop, accessToken, parsed.data.reference);
  if (!shopifyOrder) {
    console.warn("Shopify order import not found", { shop, reference: parsed.data.reference, sellerId: targetSellerId });
    await recordShopifySyncIssue(db, {
      sellerId: targetSellerId,
      shopDomain: shop,
      reference: parsed.data.reference,
      reason: "Shopify no devolvio el pedido con esa referencia.",
      detail: "Revisa que este en la tienda seleccionada y usa el numero exacto, el # del pedido o la URL del pedido."
    });
    throw new HttpsError("not-found", "No encontre ese pedido en Shopify. Revisa que este en la tienda seleccionada y prueba con el numero exacto, el # del pedido o la URL del pedido.");
  }
  if (!isCaliShopifyOrder(shopifyOrder)) {
    const address = shopifyOrder.shipping_address;
    const addressRaw = [address?.address1, address?.address2, address?.city, address?.country].filter(Boolean).join(", ");
    await recordShopifySyncIssue(db, {
      sellerId: targetSellerId,
      shopDomain: shop,
      reference: parsed.data.reference,
      reason: "Pedido Shopify fuera de Cali.",
      detail: `Direccion recibida: ${addressRaw || "sin direccion"}`
    });
    throw new HttpsError("failed-precondition", "Este pedido no pertenece a Cali y no se importo a la operacion.");
  }
  const orderSkuContains = normalizeSkuFilter(store.orderSkuContains);
  if (!shopifyOrderMatchesSkuFilter(shopifyOrder, orderSkuContains)) {
    await recordShopifySyncIssue(db, {
      sellerId: targetSellerId,
      shopDomain: shop,
      reference: parsed.data.reference,
      reason: `Pedido Shopify excluido por filtro de SKU.`,
      detail: `La tienda solo sincroniza pedidos con al menos un SKU que contenga "${orderSkuContains}".`
    });
    throw new HttpsError("failed-precondition", `Este pedido no contiene "${orderSkuContains}" en ningún SKU y no se importó.`);
  }
  const order = await upsertShopifyOrder(shopifyOrder, targetSellerId, shop);
  await resolveShopifySyncIssue(db, targetSellerId, shop, parsed.data.reference, order.id);
  await storeDoc.ref.set({ sellerId: targetSellerId, lastManualImportAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true });
  return { order };
});

export const syncShopifyHistoricalOrders = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can sync Shopify orders.");
  }

  const parsed = syncShopifyHistoricalOrdersSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid Shopify historical sync data.", parsed.error.flatten());
  }
  const { startDate, endDate } = parsed.data;
  if (startDate > endDate) throw new HttpsError("invalid-argument", "Start date must be before end date.");

  const shop = normalizeShop(parsed.data.shopDomain);
  if (!shop) throw new HttpsError("invalid-argument", "Invalid Shopify store domain.");

  const db = getFirestore();
  const storeSnap = await db.collection("shopifyStores").where("shopDomain", "==", shop).where("status", "==", "connected").limit(1).get();
  if (storeSnap.empty) throw new HttpsError("not-found", "Shopify store is not connected.");
  const storeDoc = storeSnap.docs[0];
  const store = storeDoc.data();
  const storeSellerId = String(store.sellerId ?? "");
  const targetSellerId = role === "admin" ? String(parsed.data.sellerId || storeSellerId || "") : String(sellerClaim || "");
  if (!targetSellerId || targetSellerId === "unassigned") {
    throw new HttpsError("failed-precondition", "Assign this Shopify store to a seller before syncing orders.");
  }
  if (role === "seller" && storeSellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Sellers can only sync orders from their connected stores.");
  }

  const secretSnap = await db.collection("shopifyStoreSecrets").doc(storeDoc.id).get();
  const accessToken = String(secretSnap.data()?.accessToken ?? "");
  if (!accessToken) throw new HttpsError("failed-precondition", "Shopify store token is missing.");

  const fetched = await fetchShopifyOrdersByDateRange(shop, accessToken, startDate, endDate);
  let imported = 0;
  let skippedOutsideCali = 0;
  let skippedSkuFilter = 0;
  let existing = 0;
  const orderSkuContains = normalizeSkuFilter(store.orderSkuContains);
  const orders: Array<Record<string, unknown>> = [];
  for (const shopifyOrder of fetched) {
    if (!isCaliShopifyOrder(shopifyOrder)) {
      skippedOutsideCali++;
      continue;
    }
    if (!shopifyOrderMatchesSkuFilter(shopifyOrder, orderSkuContains)) {
      skippedSkuFilter++;
      continue;
    }
    const before = await db.collection("orders").doc(`shopify-${shopifyOrder.id}`).get();
    const order = await upsertShopifyOrder(shopifyOrder, targetSellerId, shop, "shopify_historical_sync");
    if (before.exists) existing++;
    else imported++;
    orders.push(order);
  }
  await storeDoc.ref.set({ sellerId: targetSellerId, lastHistoricalSyncAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true });
  return { imported, existing, skippedOutsideCali, skippedSkuFilter, fetched: fetched.length, orders };
});

async function recordShopifySyncIssue(db: FirebaseFirestore.Firestore, input: { sellerId: string; shopDomain: string; reference: string; reason: string; detail?: string }) {
  const now = new Date().toISOString();
  const id = `ssi-${input.sellerId}-${input.shopDomain}-${input.reference}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140);
  await db.collection("shopifySyncIssues").doc(id).set({
    id,
    sellerId: input.sellerId,
    shopDomain: input.shopDomain,
    reference: input.reference,
    status: "open",
    reason: input.reason,
    detail: input.detail,
    createdAt: now,
    updatedAt: now
  }, { merge: true });
}

async function resolveShopifySyncIssue(db: FirebaseFirestore.Firestore, sellerId: string, shopDomain: string, reference: string, orderId: string) {
  const id = `ssi-${sellerId}-${shopDomain}-${reference}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140);
  const ref = db.collection("shopifySyncIssues").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const now = new Date().toISOString();
  await ref.set({ status: "resolved", orderId, resolvedAt: now, updatedAt: now }, { merge: true });
}

async function findExistingImportedOrder(db: FirebaseFirestore.Firestore, sellerId: string, shopDomain: string, reference: string) {
  const cleaned = cleanShopifyOrderReference(reference);
  const numeric = cleaned.replace(/^#/, "").trim();
  const candidates = Array.from(new Set([cleaned, cleaned.toUpperCase(), numeric, `#${numeric}`].filter(Boolean)));
  for (const value of candidates) {
    const snap = await db.collection("orders")
      .where("sellerId", "==", sellerId)
      .where("shopDomain", "==", shopDomain)
      .where("trackingCode", "==", value)
      .limit(1)
      .get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  for (const value of candidates) {
    const snap = await db.collection("orders")
      .where("sellerId", "==", sellerId)
      .where("shopDomain", "==", shopDomain)
      .where("shopifyOrderId", "==", value)
      .limit(1)
      .get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  if (/^\d{8,}$/.test(numeric)) {
    const snap = await db.collection("orders")
      .where("sellerId", "==", sellerId)
      .where("shopDomain", "==", shopDomain)
      .where("shopifyNumericId", "==", Number(numeric))
      .limit(1)
      .get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  return null;
}

async function registerOrdersCreateWebhook(shop: string, accessToken: string): Promise<{ id?: string | number }> {
  const address = "https://us-central1-kentro-last-mile.cloudfunctions.net/shopifyWebhook";
  const listResponse = await fetch(`https://${shop}/admin/api/2026-01/webhooks.json?topic=orders/create`, {
    headers: { "X-Shopify-Access-Token": accessToken }
  });
  if (listResponse.ok) {
    const current = await listResponse.json() as { webhooks?: Array<{ id?: string | number; address?: string }> };
    const existing = current.webhooks?.find((webhook) => webhook.address === address);
    if (existing) return { id: existing.id };
  }

  const createResponse = await fetch(`https://${shop}/admin/api/2026-01/webhooks.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({
      webhook: {
        topic: "orders/create",
        address,
        format: "json"
      }
    })
  });
  if (!createResponse.ok) {
    throw new Error("No se pudo registrar webhook orders/create.");
  }
  const created = await createResponse.json() as { webhook?: { id?: string | number } };
  return { id: created.webhook?.id };
}

async function fetchShopifyOrder(shop: string, accessToken: string, reference: string) {
  const cleaned = cleanShopifyOrderReference(reference);
  const numeric = cleaned.replace(/^#/, "").trim();
  const headers = { "X-Shopify-Access-Token": accessToken };
  if (/^\d{8,}$/.test(numeric)) {
    const direct = await fetch(`https://${shop}/admin/api/2026-04/orders/${numeric}.json`, { headers });
    if (direct.ok) {
      const json = await direct.json() as { order?: unknown };
      const parsed = shopifyOrderSchema.safeParse(json.order);
      if (parsed.success) return parsed.data;
    }
  }

  const names = Array.from(new Set([cleaned, cleaned.startsWith("#") ? cleaned : `#${cleaned}`, numeric, `#${numeric}`].filter(Boolean)));
  for (const name of names) {
    const search = await fetch(`https://${shop}/admin/api/2026-04/orders.json?status=any&limit=1&name=${encodeURIComponent(name)}`, { headers });
    if (!search.ok) continue;
    const json = await search.json() as { orders?: unknown[] };
    const parsed = shopifyOrderSchema.safeParse(json.orders?.[0]);
    if (parsed.success) return parsed.data;
  }

  if (/^\d+$/.test(numeric)) {
    const recent = await fetch(`https://${shop}/admin/api/2026-04/orders.json?status=any&limit=250&fields=id,name,order_number,total_price,financial_status,created_at,shipping_address,line_items`, { headers });
    if (recent.ok) {
      const json = await recent.json() as { orders?: unknown[] };
      for (const candidate of json.orders ?? []) {
        const parsed = shopifyOrderSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const order = parsed.data;
        const orderNumber = order.order_number ? String(order.order_number) : "";
        const orderName = order.name.replace(/^#/, "");
        if (orderNumber === numeric || orderName === numeric || order.name === cleaned || order.name === `#${numeric}` || order.name.endsWith(numeric)) {
          return order;
        }
      }
    }
  }
  return null;
}

async function fetchShopifyOrdersByDateRange(shop: string, accessToken: string, startDate: string, endDate: string) {
  const headers = { "X-Shopify-Access-Token": accessToken };
  const orders: z.infer<typeof shopifyOrderSchema>[] = [];
  const fields = "id,name,order_number,total_price,financial_status,created_at,shipping_address,line_items";
  let url = `https://${shop}/admin/api/2026-04/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(`${startDate}T00:00:00-05:00`)}&created_at_max=${encodeURIComponent(`${endDate}T23:59:59-05:00`)}&fields=${encodeURIComponent(fields)}`;
  for (let page = 0; page < 8 && url; page++) {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new HttpsError("unavailable", "Shopify did not return historical orders.");
    const json = await response.json() as { orders?: unknown[] };
    for (const candidate of json.orders ?? []) {
      const parsed = shopifyOrderSchema.safeParse(candidate);
      if (parsed.success) orders.push(parsed.data);
    }
    url = nextShopifyPageUrl(response.headers.get("link") ?? "", shop);
  }
  return orders;
}

function nextShopifyPageUrl(linkHeader: string, shop: string) {
  const next = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  const match = next?.match(/<([^>]+)>/);
  if (!match?.[1]) return "";
  const parsed = new URL(match[1]);
  if (parsed.hostname !== shop) return "";
  return parsed.toString();
}

function isCaliShopifyOrder(order: z.infer<typeof shopifyOrderSchema>) {
  const address = order.shipping_address;
  const text = [address?.city, address?.address1, address?.address2]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\bcali\b/.test(text) || text.includes("santiago de cali");
}

function normalizeSkuFilter(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function shopifyOrderMatchesSkuFilter(order: z.infer<typeof shopifyOrderSchema>, filter: string) {
  if (!filter) return true;
  return (order.line_items ?? []).some((item) =>
    !isShippingLineItem(item) && (item.sku ?? "").toUpperCase().includes(filter)
  );
}

function cleanShopifyOrderReference(reference: string) {
  const trimmed = reference.trim();
  const urlOrderId = trimmed.match(/\/orders\/(\d+)/i)?.[1];
  if (urlOrderId) return urlOrderId;
  const queryName = trimmed.match(/[?&](?:name|order|reference)=([^&]+)/i)?.[1];
  if (queryName) return decodeURIComponent(queryName).trim();
  return trimmed;
}

async function upsertShopifyOrder(order: z.infer<typeof shopifyOrderSchema>, sellerId: string, shopDomain: string, source = "shopify_manual_import") {
  const db = getFirestore();
  const now = new Date().toISOString();
  const docId = `shopify-${order.id}`;
  const orderRef = db.collection("orders").doc(docId);
  return db.runTransaction(async (transaction) => {
    const [existing, sellerSnap] = await Promise.all([transaction.get(orderRef), transaction.get(db.collection("sellers").doc(sellerId))]);
    const seller = sellerSnap.data() ?? {};
    const trackingCode = typeof existing.data()?.trackingCode === "string" ? String(existing.data()?.trackingCode) : await nextTrackingCode(transaction);
    const items = summarizeShopifyLineItems(order.line_items ?? [], shopDomain);
    const address = order.shipping_address;
    const orderDoc = stripUndefined({
      id: docId,
      trackingCode,
      shopifyOrderId: order.name,
      shopifyNumericId: order.id,
      shopDomain,
      sellerId,
      driverId: null,
      cityId: "city-cali",
      customerName: address?.name ?? "Cliente Shopify",
      customerPhone: address?.phone ?? "",
      addressRaw: [address?.address1, address?.address2, address?.city, address?.country].filter(Boolean).join(", "),
      totalCop: Math.round(Number(order.total_price) || 0),
      productName: items.productName,
      sku: items.sku,
      quantity: items.quantity,
      pickupPointName: typeof seller.pickupPointName === "string" && seller.pickupPointName.trim() ? seller.pickupPointName.trim() : String(seller.name ?? "Punto de recogida"),
      pickupAddress: typeof seller.pickupAddress === "string" ? seller.pickupAddress.trim() : "",
      paymentMethod: order.financial_status === "paid" ? "prepaid" : "cod",
      fulfillmentMode: "seller_pickup",
      addressRisk: sellerId === dandaSellerId ? "accepted" : "review",
      status: existing.exists ? existing.data()?.status : sellerId === dandaSellerId ? "ready_to_assign" : "imported",
      evidence: existing.data()?.evidence ?? [],
      source,
      createdAt: existing.data()?.createdAt ?? order.created_at ?? now,
      updatedAt: now
    });
    transaction.set(orderRef, orderDoc, { merge: true });
    return orderDoc;
  });
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
  const db = getFirestore();
  const counterRef = db.doc("counters/orders");
  const counterSnap = await transaction.get(counterRef);
  const next = Number(counterSnap.data()?.next ?? 1);
  transaction.set(counterRef, { next: next + 1, prefix: "KNT", updatedAt: new Date().toISOString() }, { merge: true });
  return `KNT-${String(next).padStart(6, "0")}`;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function verifyWebhookHmac(request: { get(name: string): string | undefined; rawBody: Buffer }, secret: string) {
  const hmac = String(request.get("x-shopify-hmac-sha256") ?? "");
  if (!hmac || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(request.rawBody).digest("base64");
  return timingSafeEqual(digest, hmac);
}

async function recordComplianceWebhook(topic: string, payload: Record<string, unknown>) {
  const shopDomain = normalizeShop(String(payload.shop_domain ?? ""));
  await getFirestore().collection("shopifyComplianceEvents").doc(`sce-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`).set({
    topic,
    shopDomain: shopDomain || undefined,
    payload,
    createdAt: new Date().toISOString()
  });
}

export const shopifyCustomersDataRequest = onRequest({ secrets: [shopifyApiSecret] }, async (request, response) => {
  const { apiSecret } = config();
  if (request.method !== "POST" || !verifyWebhookHmac(request, apiSecret)) {
    response.status(401).send("Unauthorized");
    return;
  }
  await recordComplianceWebhook("customers/data_request", request.body ?? {});
  response.status(200).send("OK");
});

export const shopifyComplianceWebhook = onRequest({ secrets: [shopifyApiSecret, shopifyPilotApiSecret, shopifyU0jxrmApiSecret, shopifyN1v0swApiSecret] }, async (request, response) => {
  const secrets = [config().apiSecret, config("pilot").apiSecret, config("u0jxrm").apiSecret, config("n1v0sw").apiSecret];
  if (request.method !== "POST" || !secrets.some((secret) => verifyWebhookHmac(request, secret))) {
    response.status(401).send("Unauthorized");
    return;
  }

  const topic = String(request.get("x-shopify-topic") ?? "compliance/unknown");
  const payload = request.body ?? {};
  if (topic === "shop/redact") {
    const shopDomain = normalizeShop(String(payload.shop_domain ?? ""));
    const storeId = shopDomain ? storeIdForShop(shopDomain) : "";
    if (storeId) {
      await Promise.all([
        getFirestore().collection("shopifyStores").doc(storeId).set({ status: "error", errorMessage: "Shop redacted by Shopify", updatedAt: new Date().toISOString() }, { merge: true }),
        getFirestore().collection("shopifyStoreSecrets").doc(storeId).delete()
      ]);
    }
  }
  await recordComplianceWebhook(topic, payload);
  response.status(200).send("OK");
});

export const shopifyCustomersRedact = onRequest({ secrets: [shopifyApiSecret] }, async (request, response) => {
  const { apiSecret } = config();
  if (request.method !== "POST" || !verifyWebhookHmac(request, apiSecret)) {
    response.status(401).send("Unauthorized");
    return;
  }
  await recordComplianceWebhook("customers/redact", request.body ?? {});
  response.status(200).send("OK");
});

export const shopifyShopRedact = onRequest({ secrets: [shopifyApiSecret] }, async (request, response) => {
  const { apiSecret } = config();
  if (request.method !== "POST" || !verifyWebhookHmac(request, apiSecret)) {
    response.status(401).send("Unauthorized");
    return;
  }
  const payload = request.body ?? {};
  const shopDomain = normalizeShop(String(payload.shop_domain ?? ""));
  const storeId = shopDomain ? storeIdForShop(shopDomain) : "";
  if (storeId) {
    await Promise.all([
      getFirestore().collection("shopifyStores").doc(storeId).set({ status: "error", errorMessage: "Shop redacted by Shopify", updatedAt: new Date().toISOString() }, { merge: true }),
      getFirestore().collection("shopifyStoreSecrets").doc(storeId).delete()
    ]);
  }
  await recordComplianceWebhook("shop/redact", payload);
  response.status(200).send("OK");
});
