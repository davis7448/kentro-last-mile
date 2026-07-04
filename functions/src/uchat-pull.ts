import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";

const FETCH_CONCURRENCY = 8;
const MAX_IMPORTED_PER_RUN = 500;

/**
 * Perfil por plataforma. Cada whitelabel puede correr sobre un motor distinto
 * (UChat o ChatRace), con otra URL base, otros valores de estado, otros nombres
 * de tags y de custom fields. Aqui se aisla lo especifico de cada una.
 */
type PlatformProfile = {
  engine: "uchat" | "chatrace";
  baseUrl: string;
  confirmedLeadStatuses: Set<string>; // en MAYUSCULAS (solo uchat)
  confirmedTags: Set<string>;
  // Motor chatrace: la senal de confirmado puede ser un custom field (ej. Estado_pedido).
  confirmedFieldName?: string;
  confirmedFieldValues?: Set<string>; // en MAYUSCULAS
  // Motor chatrace: campo que Kentro marca en el contacto para que el flow del
  // bot pueda saltar la subida a Dropi en pedidos de cobertura Kentro.
  markFieldName?: string;
  addressFields: string[];
  referenceFields: string[];
  cityFields: string[];
  departmentFields: string[];
  verified: boolean; // true = estructura confirmada contra la API real
};

// CHATBY: estructura verificada en vivo (token real, motor UChat via app.chatby.io).
const CHATBY_PROFILE: PlatformProfile = {
  engine: "uchat",
  baseUrl: "https://www.uchat.com.au/api",
  // Verificado o Confirmado alcanzan para despachar (imported -> ready_to_assign).
  confirmedLeadStatuses: new Set(["CONFIRMADO", "VERIFICADO"]),
  confirmedTags: new Set(["PED-Confirmado", "PED-Verificado"]),
  addressFields: ["Shopify: Direccion", "Shopify: Dirección", "Direccion", "Dirección"],
  referenceFields: ["Shopify: Referencias", "Referencias"],
  cityFields: ["Shopify: Ciudad", "Ciudad"],
  departmentFields: ["Shopify: Departamento", "Departamento"],
  verified: true
};

// CHATEAPRO: verificado en vivo contra la cuenta de Kovia (flow f242295, mismo
// backend UChat). Diferencias vs ChatBy: NO usa lead_status (vacio); la senal de
// confirmado es el tag "PEDIDO CONFIRMADO" / "Ya confirmado"; los custom fields
// de direccion se llaman distinto (sin prefijo "Shopify:").
const CHATEAPRO_PROFILE: PlatformProfile = {
  engine: "uchat",
  baseUrl: "https://www.uchat.com.au/api",
  confirmedLeadStatuses: new Set<string>(), // Chateapro no usa lead_status
  confirmedTags: new Set(["PEDIDO CONFIRMADO", "Ya confirmado✅", "Ya confirmado"]),
  addressFields: ["Dirección", "Direccion"],
  referenceFields: [], // Kovia no expone un campo de referencias separado
  cityFields: ["Ciudad"],
  departmentFields: ["Departamento/ Provincia", "Departamento/Provincia", "Departamento"],
  verified: true
};

// LUCIDBOT: motor ChatRace (api.chatrace.com, whitelabel via appcontx) en
// panel.lucidbot.co. VERIFICADO en vivo con la cuenta de Senziacol (1118979).
// Auth: header X-ACCESS-TOKEN (no Bearer). Modelo de contactos (no subscribers):
// contact_id == telefono E.164; custom fields y tags via endpoints propios que
// devuelven ARRAYS PLANOS. Los tags no distinguen confirmado de cancelado; la
// senal real es el custom field Estado_pedido (PENDIENTE CONFIRMACION ->
// CONFIRMADO -> GUIA_GENERADA | CANCELADO). Solo CONFIRMADO despacha por Kentro:
// GUIA_GENERADA significa que Dropi ya lo esta enviando (no duplicar).
const LUCIDBOT_PROFILE: PlatformProfile = {
  engine: "chatrace",
  baseUrl: "https://panel.lucidbot.co/api",
  confirmedLeadStatuses: new Set<string>(),
  confirmedTags: new Set<string>(),
  confirmedFieldName: "Estado_pedido",
  confirmedFieldValues: new Set(["CONFIRMADO"]),
  markFieldName: "Logistica_Kentro",
  addressFields: ["Direccion_1"],
  referenceFields: ["Direccion_2", "Barrio"],
  cityFields: ["Ciudad"],
  departmentFields: ["Provincia"],
  verified: true
};

const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  chatby: CHATBY_PROFILE,
  chateapro: CHATEAPRO_PROFILE,
  lucidbot: LUCIDBOT_PROFILE
};

function resolveProfile(platform: unknown): PlatformProfile {
  const key = String(platform ?? "chatby").trim().toLowerCase();
  return PLATFORM_PROFILES[key] ?? CHATBY_PROFILE;
}

const setStoreUchatConfigSchema = z.object({
  sellerId: z.string().min(1),
  apiToken: z.string().optional(), // vacio o ausente = limpiar/deshabilitar
  baseUrl: z.string().url().optional(),
  platform: z.enum(["chatby", "chateapro", "lucidbot"]).optional(),
  // Token de integracion de Dropi (header dropi-integration-key). Solo aplica a
  // tiendas LucidBot: permite consultar/ajustar sus ordenes en Dropi.
  dropiApiToken: z.string().optional(),
  enabled: z.boolean().optional()
});

/**
 * Telefono -> user_id de UChat (canal WhatsApp Cloud usa E.164 sin '+').
 * Numeros colombianos: 10 digitos -> se antepone 57.
 */
function phoneToUserId(phone: unknown) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `57${digits}`;
  return digits;
}

function isConfirmedSubscriber(info: any, profile: PlatformProfile) {
  if (!info || typeof info !== "object") return false;
  if (profile.confirmedLeadStatuses.has(String(info.lead_status ?? "").trim().toUpperCase())) return true;
  if (profile.confirmedFieldName && profile.confirmedFieldValues) {
    const value = pickUserField(info, [profile.confirmedFieldName]).trim().toUpperCase();
    if (value && profile.confirmedFieldValues.has(value)) return true;
  }
  const tags = Array.isArray(info.tags) ? info.tags : [];
  return tags.some((tag: any) => profile.confirmedTags.has(String(tag?.name ?? "")));
}

async function fetchSubscriber(baseUrl: string, token: string, userId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/subscriber/get-info-by-user-id?user_id=${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const json = await response.json().catch(() => null);
    return json && typeof json === "object" ? (json as any).data ?? null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Motor ChatRace (LucidBot): auth X-ACCESS-TOKEN, contactos, arrays planos.
// Nota: ChatRace responde HTTP 200 casi siempre; el error real viene en el body
// como {"error":{...}}, por eso se valida el contenido y no el status.
// ---------------------------------------------------------------------------

async function chatraceRequest(baseUrl: string, token: string, path: string, init?: { method?: string; form?: Record<string, string>; json?: Record<string, unknown> }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "X-ACCESS-TOKEN": token,
        Accept: "application/json",
        ...(init?.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(init?.json ? { "Content-Type": "application/json" } : {})
      },
      body: init?.form ? new URLSearchParams(init.form).toString() : init?.json ? JSON.stringify(init.json) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    const json = JSON.parse(text.trim());
    if (json && typeof json === "object" && !Array.isArray(json) && json.error) return null;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function chatraceArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

type ChatraceFieldCache = Map<string, Map<string, string>>; // sellerId -> (fieldName -> fieldId)

async function resolveChatraceFieldId(
  secret: { token: string; baseUrl: string },
  sellerId: string,
  cache: ChatraceFieldCache,
  fieldName: string,
  createIfMissing: boolean
) {
  let bySeller = cache.get(sellerId);
  if (!bySeller) {
    bySeller = new Map();
    cache.set(sellerId, bySeller);
  }
  const cached = bySeller.get(fieldName);
  if (cached) return cached;
  const found = await chatraceRequest(secret.baseUrl, secret.token, `/accounts/custom_fields/name/${encodeURIComponent(fieldName)}`);
  const foundData = found && typeof found === "object" ? (found as any).data ?? found : null;
  const foundId = foundData && !Array.isArray(foundData) ? String(foundData.id ?? "") : Array.isArray(foundData) && foundData[0] ? String(foundData[0].id ?? "") : "";
  if (foundId) {
    bySeller.set(fieldName, foundId);
    return foundId;
  }
  if (!createIfMissing) return "";
  const created = await chatraceRequest(secret.baseUrl, secret.token, "/accounts/custom_fields", { method: "POST", json: { name: fieldName, type: 0 } });
  const createdData = created && typeof created === "object" ? (created as any).data ?? created : null;
  const createdId = createdData ? String((createdData as any).id ?? "") : "";
  if (createdId) bySeller.set(fieldName, createdId);
  return createdId;
}

/**
 * Busca el contacto de un pedido en ChatRace y lo normaliza a la misma forma
 * que devuelve UChat ({name, lead_status, tags[], user_fields[]}) para reusar
 * isConfirmedSubscriber/buildSyncPatch sin duplicar logica.
 * Lookup: directo por telefono E.164 (contact_id == telefono); si no existe,
 * fallback por custom field shopify_order_id.
 */
async function fetchChatraceInfo(
  secret: { token: string; baseUrl: string },
  sellerId: string,
  cache: ChatraceFieldCache,
  order: Record<string, any>
) {
  let contact: any = null;
  const phoneId = phoneToUserId(order.customerPhone);
  if (phoneId) {
    contact = await chatraceRequest(secret.baseUrl, secret.token, `/contacts/${encodeURIComponent(phoneId)}`);
  }
  if (!contact || !contact.id) {
    const shopifyNumeric = String(order.shopifyNumericId ?? "").replace(/\D/g, "");
    if (shopifyNumeric) {
      const fieldId = await resolveChatraceFieldId(secret, sellerId, cache, "shopify_order_id", false);
      if (fieldId) {
        const found = await chatraceRequest(secret.baseUrl, secret.token, `/contacts/find_by_custom_field?field_id=${encodeURIComponent(fieldId)}&value=${encodeURIComponent(shopifyNumeric)}`);
        const list = chatraceArray(found);
        if (list.length > 0) contact = list[0];
      }
    }
  }
  if (!contact || !contact.id) return null;
  const contactId = String(contact.id);
  const [fields, tags] = await Promise.all([
    chatraceRequest(secret.baseUrl, secret.token, `/contacts/${encodeURIComponent(contactId)}/custom_fields`),
    chatraceRequest(secret.baseUrl, secret.token, `/contacts/${encodeURIComponent(contactId)}/tags`)
  ]);
  const userFields = chatraceArray(fields).map((field: any) => ({ id: String(field.id ?? ""), name: String(field.name ?? ""), value: field.value }));
  return {
    contactId,
    info: {
      name: String(contact.full_name ?? contact.first_name ?? "").trim(),
      lead_status: "",
      tags: chatraceArray(tags).map((tag: any) => ({ name: String(tag.name ?? tag) })),
      user_fields: userFields
    }
  };
}

/**
 * Marca el contacto como cobertura Kentro (markFieldName = "SI") para que el
 * flow del bot pueda saltar la subida a Dropi y evitar el pedido duplicado.
 * Idempotente: solo escribe si el campo no esta ya en SI.
 */
async function ensureChatraceKentroMark(
  secret: { token: string; baseUrl: string },
  sellerId: string,
  cache: ChatraceFieldCache,
  profile: PlatformProfile,
  contactId: string,
  userFields: Array<{ name: string; value: any }>
) {
  if (!profile.markFieldName) return;
  const current = userFields.find((field) => field.name === profile.markFieldName);
  if (String(current?.value ?? "").trim().toUpperCase() === "SI") return;
  const fieldId = await resolveChatraceFieldId(secret, sellerId, cache, profile.markFieldName, true);
  if (!fieldId) return;
  await chatraceRequest(secret.baseUrl, secret.token, `/contacts/${encodeURIComponent(contactId)}/custom_fields/${encodeURIComponent(fieldId)}`, {
    method: "POST",
    form: { value: "SI" }
  });
}

/**
 * Marca en TIEMPO REAL (desde el webhook de pedidos) el contacto de LucidBot
 * como cobertura Kentro, sin esperar al ciclo del pull. Si el contacto aun no
 * existe en el bot (carrera con la creacion), no pasa nada: el pull lo marcara.
 * Nunca lanza: un fallo aqui no debe romper la creacion del pedido.
 */
export async function markChatraceContactForSeller(sellerId: string, phone: unknown) {
  try {
    const db = getFirestore();
    const secretSnap = await db.collection("storeUchatSecrets").doc(sellerId).get();
    const data = secretSnap.data();
    if (!data || data.enabled !== true) return false;
    const profile = resolveProfile(data.platform);
    if (profile.engine !== "chatrace" || !profile.markFieldName) return false;
    const token = String(data.apiToken ?? "").trim();
    if (!token) return false;
    const secret = { token, baseUrl: String(data.baseUrl ?? profile.baseUrl) || profile.baseUrl };
    const phoneId = phoneToUserId(phone);
    if (!phoneId) return false;
    const contact = await chatraceRequest(secret.baseUrl, secret.token, `/contacts/${encodeURIComponent(phoneId)}`);
    if (!contact || !contact.id) return false;
    const cache: ChatraceFieldCache = new Map();
    await ensureChatraceKentroMark(secret, sellerId, cache, profile, String(contact.id), []);
    return true;
  } catch {
    return false;
  }
}

function pickUserField(info: any, names: string[]) {
  const fields = Array.isArray(info?.user_fields) ? info.user_fields : [];
  for (const name of names) {
    const found = fields.find((field: any) => String(field?.name ?? "") === name);
    const value = found ? String(found.value ?? "").trim() : "";
    if (value && value !== "-") return value;
  }
  return "";
}

/**
 * Construye la direccion desde los custom fields de Chateapro/Chatby (por si el
 * cliente corrigio datos en el bot). Devuelve null si no hay direccion util.
 */
function buildSyncPatch(info: any, profile: PlatformProfile) {
  const direccion = pickUserField(info, profile.addressFields);
  const referencias = pickUserField(info, profile.referenceFields);
  const ciudad = pickUserField(info, profile.cityFields);
  const departamento = pickUserField(info, profile.departmentFields);
  const name = String(info?.name ?? "").trim();
  const patch: Record<string, string> = {};
  if (direccion) {
    patch.addressRaw = [direccion, referencias, ciudad, departamento, "Colombia"].filter((value) => value && value !== "-").join(", ");
  }
  if (name) patch.customerName = name;
  return Object.keys(patch).length > 0 ? patch : null;
}

async function confirmOrderIfPending(orderId: string, now: string, info: any, profile: PlatformProfile) {
  const db = getFirestore();
  const orderRef = db.collection("orders").doc(orderId);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) return false;
    const current = snap.data() ?? {};
    if (current.status !== "imported") return false; // idempotente / anti-clobber
    const syncPatch = buildSyncPatch(info, profile) ?? {};
    const addressChanged = typeof syncPatch.addressRaw === "string" && syncPatch.addressRaw !== String(current.addressRaw ?? "");
    transaction.set(orderRef, { ...current, ...syncPatch, addressRisk: "accepted", status: "ready_to_assign", confirmedVia: "uchat_pull", updatedAt: now }, { merge: true });
    const auditId = `audit-${Date.now()}-${orderId}`;
    transaction.set(db.collection("auditEvents").doc(auditId), {
      id: auditId,
      actorId: "uchat-pull",
      actorRole: "system",
      action: "order.confirmed_uchat",
      entity: "order",
      entityId: snap.id,
      summary: `Pedido ${current.trackingCode ?? current.shopifyOrderId ?? snap.id} confirmado por Chateapro/Chatby (pull API)${addressChanged ? " · direccion sincronizada" : ""}`,
      createdAt: now
    });
    return true;
  });
}

/**
 * Guarda el API token de ChatBy/UChat de una tienda en una coleccion sin acceso
 * de cliente (solo functions). El estado (habilitado/configurado) se refleja en
 * storeWebhookConfigs para la UI, sin exponer el token.
 */
export const setStoreUchatConfig = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Only admins and sellers can set the ChatBy config.");
  }
  const parsed = setStoreUchatConfigSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Invalid ChatBy config data.", parsed.error.flatten());
  const input = parsed.data;
  if (role === "seller" && input.sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Sellers can only set their own ChatBy config.");
  }

  const db = getFirestore();
  const sellerSnap = await db.collection("sellers").doc(input.sellerId).get();
  if (!sellerSnap.exists) throw new HttpsError("not-found", "Seller not found.");
  const seller = sellerSnap.data() ?? {};
  const now = new Date().toISOString();
  const secretRef = db.collection("storeUchatSecrets").doc(input.sellerId);
  const existingSecret = await secretRef.get();
  const platform = input.platform ?? (existingSecret.data()?.platform as string | undefined) ?? "chatby";
  const profile = resolveProfile(platform);
  // apiToken ausente = conservar el actual; presente (incluso "") = reemplazar/limpiar.
  const apiToken = input.apiToken !== undefined ? input.apiToken.trim() : String(existingSecret.data()?.apiToken ?? "");
  const dropiApiToken = input.dropiApiToken !== undefined ? input.dropiApiToken.trim() : String(existingSecret.data()?.dropiApiToken ?? "");
  const baseUrl = (input.baseUrl ?? existingSecret.data()?.baseUrl ?? profile.baseUrl).trim() || profile.baseUrl;
  const configured = apiToken.length > 0;
  const enabled = configured && input.enabled !== false;
  const dropiConfigured = dropiApiToken.length > 0;

  await secretRef.set({
    sellerId: input.sellerId,
    apiToken, // solo legible por functions (admin SDK); reglas niegan al cliente
    dropiApiToken,
    baseUrl,
    platform,
    enabled,
    updatedAt: now
  }, { merge: true });

  // Estado no-secreto para la UI.
  const configRef = db.collection("storeWebhookConfigs").doc(input.sellerId);
  const existing = await configRef.get();
  await configRef.set({
    id: configRef.id,
    sellerId: input.sellerId,
    sellerName: String(seller.name ?? input.sellerId),
    status: existing.exists ? existing.data()?.status ?? "active" : "active",
    uchatConfirmEnabled: enabled,
    uchatConfigured: configured,
    uchatPlatform: platform,
    uchatDropiConfigured: dropiConfigured,
    createdAt: existing.exists ? existing.data()?.createdAt ?? now : now,
    updatedAt: now
  }, { merge: true });

  return { ok: true, configured, enabled, platform, dropiConfigured };
});

/**
 * Cada 2 h: por cada tienda con token habilitado (segun su plataforma
 * ChatBy/Chateapro), revisa sus pedidos en 'imported' y pasa a 'ready_to_assign'
 * (sincronizando direccion) los que esten marcados como Verificado o Confirmado.
 */
export const pullUchatConfirmations = onSchedule(
  { schedule: "every 2 hours", timeoutSeconds: 300, memory: "256MiB" },
  async () => {
    const db = getFirestore();
    const secretsSnap = await db.collection("storeUchatSecrets").where("enabled", "==", true).get();
    if (secretsSnap.empty) return;

    const secretsBySeller = new Map<string, { token: string; baseUrl: string; profile: PlatformProfile }>();
    for (const doc of secretsSnap.docs) {
      const data = doc.data() ?? {};
      const token = String(data.apiToken ?? "").trim();
      if (!token) continue;
      const profile = resolveProfile(data.platform);
      secretsBySeller.set(doc.id, { token, baseUrl: String(data.baseUrl ?? profile.baseUrl) || profile.baseUrl, profile });
    }
    if (secretsBySeller.size === 0) return;

    // Un solo query (single-field) trae todos los pendientes de todas las tiendas.
    const importedSnap = await db.collection("orders").where("status", "==", "imported").limit(MAX_IMPORTED_PER_RUN).get();
    const pending = importedSnap.docs.filter((doc) => secretsBySeller.has(String(doc.data().sellerId ?? "")));

    const now = new Date().toISOString();
    const confirmedBySeller = new Map<string, number>();
    const chatraceFieldCache: ChatraceFieldCache = new Map();
    const processedOrderIds = new Set<string>();
    let checked = 0;

    for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
      const batch = pending.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(batch.map(async (doc) => {
        const order = doc.data() ?? {};
        const sellerId = String(order.sellerId ?? "");
        const secret = secretsBySeller.get(sellerId);
        if (!secret) return;

        let info: any = null;
        if (secret.profile.engine === "chatrace") {
          processedOrderIds.add(doc.id);
          const result = await fetchChatraceInfo(secret, sellerId, chatraceFieldCache, order);
          if (!result) return;
          checked += 1;
          info = result.info;
          // Marca preventiva SIEMPRE (confirmado o no): el flow del bot la usa
          // para saltar la subida a Dropi en pedidos de cobertura Kentro.
          await ensureChatraceKentroMark(secret, sellerId, chatraceFieldCache, secret.profile, result.contactId, info.user_fields);
        } else {
          const userId = phoneToUserId(order.customerPhone);
          if (!userId) return;
          checked += 1;
          info = await fetchSubscriber(secret.baseUrl, secret.token, userId);
        }

        if (!isConfirmedSubscriber(info, secret.profile)) return;
        const didConfirm = await confirmOrderIfPending(doc.id, now, info, secret.profile);
        if (didConfirm) confirmedBySeller.set(sellerId, (confirmedBySeller.get(sellerId) ?? 0) + 1);
      }));
    }

    // Barrido de marcado anti-Dropi (solo chatrace): pedidos RECIENTES de la
    // tienda aunque ya no esten en imported (confirmados manual, creados a
    // mano, o cuyo contacto se creo en el bot despues del webhook). Garantiza
    // que Logistica_Kentro=SI quede puesta mientras el pedido sigue vivo.
    const MARK_SKIP_STATUSES = new Set(["cancelled", "delivered", "liquidated", "failed"]);
    const markCutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    let marked = 0;
    for (const [sellerId, secret] of secretsBySeller) {
      if (secret.profile.engine !== "chatrace" || !secret.profile.markFieldName) continue;
      const recentSnap = await db.collection("orders").where("sellerId", "==", sellerId).where("createdAt", ">=", markCutoff).limit(200).get();
      const toMark = recentSnap.docs.filter((doc) => !processedOrderIds.has(doc.id) && !MARK_SKIP_STATUSES.has(String(doc.data().status ?? "")));
      for (let i = 0; i < toMark.length; i += FETCH_CONCURRENCY) {
        await Promise.all(toMark.slice(i, i + FETCH_CONCURRENCY).map(async (doc) => {
          const result = await fetchChatraceInfo(secret, sellerId, chatraceFieldCache, doc.data() ?? {});
          if (!result) return;
          const current = result.info.user_fields.find((field: any) => field.name === secret.profile.markFieldName);
          if (String(current?.value ?? "").trim().toUpperCase() === "SI") return;
          await ensureChatraceKentroMark(secret, sellerId, chatraceFieldCache, secret.profile, result.contactId, result.info.user_fields);
          marked += 1;
        }));
      }
    }

    // Marca de ultimo pull por tienda (para la UI).
    await Promise.all([...secretsBySeller.keys()].map((sellerId) =>
      db.collection("storeWebhookConfigs").doc(sellerId).set({
        lastUchatPullAt: now,
        lastUchatPullConfirmed: confirmedBySeller.get(sellerId) ?? 0,
        updatedAt: now
      }, { merge: true })
    ));

    const totalConfirmed = [...confirmedBySeller.values()].reduce((sum, value) => sum + value, 0);
    console.log(`[uchat-pull] tiendas=${secretsBySeller.size} pendientes=${pending.length} consultados=${checked} confirmados=${totalConfirmed} marcados=${marked}`);
  }
);
