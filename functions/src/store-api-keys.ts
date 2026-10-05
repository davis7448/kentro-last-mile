import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { generateWriteKey, planWriteKeyChange, type StoreApiConfigLike } from "./store-api-auth";
import { stripUndefined } from "./wallet-entries";

/**
 * Callables de la key de escritura de la Store API (spec 029, plan 2.3 y 4.2).
 *
 * - `rotateStoreWriteKey`: genera (`rotate: false`) o rota (`rotate: true`). La key se genera ANTES de la
 *   transaccion, la transaccion confirma a la vez la huella y el evento de auditoria (o nada), y la key se
 *   devuelve SOLO despues del commit. La key existe en memoria y en la respuesta; nunca en Firestore, en
 *   logs ni en la auditoria (alli solo van la huella y `last4`, que decide `planWriteKeyChange`).
 * - `getStoreApiKeyStatus` / `listStoreApiKeys`: lo que muestra RF_25, sin secretos, via la pura
 *   `toStoreApiKeyStatus`.
 *
 * Este modulo no toca Firestore ni Auth al cargarse: la prueba de `toStoreApiKeyStatus` lo importa.
 */

export type StoreApiKeyViewerRole = "admin" | "seller" | "seller_logistics";

export type StoreApiKeyStatus = {
  sellerId: string;
  sellerName: string;
  read: { exists: boolean; status: "active" | "inactive" | "none" };
  write:
    | { exists: false }
    | { exists: true; last4: string; generatedAt: string; generatedByLabel: string };
  canManageWrite: boolean;
};

export type ToStoreApiKeyStatusInput = {
  sellerId: string;
  sellerName?: string;
  config: StoreApiConfigLike | null | undefined;
  viewerRole: StoreApiKeyViewerRole;
  /** uid → nombre; solo se usa cuando pregunta un admin. */
  adminNames?: Record<string, string>;
};

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function generatedByOf(config: StoreApiConfigLike | null | undefined): { uid: string; role: string } | null {
  const raw = config?.writeKeyGeneratedBy;
  if (!raw || typeof raw !== "object") return null;
  const { uid, role } = raw as { uid?: unknown; role?: unknown };
  return { uid: typeof uid === "string" ? uid : "", role: typeof role === "string" ? role : "" };
}

/**
 * "Generada por" segun quien pregunta (decision 3 del diseno): la tienda nunca ve el nombre de un admin,
 * solo "Kentro"; el admin ve "por la tienda" o "por <nombre>", con el uid como respaldo (como el historial).
 */
function generatedByLabel(
  generatedBy: { uid: string; role: string } | null,
  viewerRole: StoreApiKeyViewerRole,
  adminNames: Record<string, string> | undefined
): string {
  const isStoreGenerated = generatedBy?.role === "seller";
  if (viewerRole !== "admin") return isStoreGenerated ? "Tu tienda" : "Kentro";
  if (isStoreGenerated) return "por la tienda";
  const uid = generatedBy?.uid ?? "";
  return `por ${adminNames?.[uid] ?? (uid || "Kentro")}`;
}

/** Lo que se muestra de las keys de una tienda (plan 4.2). Puro; nunca la key, la huella ni el prefijo. */
export function toStoreApiKeyStatus(input: ToStoreApiKeyStatusInput): StoreApiKeyStatus {
  const { sellerId, config, viewerRole, adminNames } = input;
  const sellerName = nonEmptyText(input.sellerName) ?? nonEmptyText(config?.sellerName) ?? sellerId;

  const hasReadKey = nonEmptyText(config?.apiKey) !== null;
  const read: StoreApiKeyStatus["read"] = hasReadKey
    ? { exists: true, status: config?.status === "active" ? "active" : "inactive" }
    : { exists: false, status: "none" };

  const hasWriteKey = nonEmptyText(config?.writeKeyHash) !== null;
  const write: StoreApiKeyStatus["write"] = hasWriteKey
    ? {
        exists: true,
        last4: nonEmptyText(config?.writeKeyLast4) ?? "",
        generatedAt: nonEmptyText(config?.writeKeyRotatedAt) ?? nonEmptyText(config?.writeKeyCreatedAt) ?? "",
        generatedByLabel: generatedByLabel(generatedByOf(config), viewerRole, adminNames)
      }
    : { exists: false };

  return { sellerId, sellerName, read, write, canManageWrite: viewerRole !== "seller_logistics" };
}

/** uids de admin que generaron alguna de estas keys (los unicos nombres que hay que resolver). */
function adminGeneratorIds(configs: (StoreApiConfigLike | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const config of configs) {
    const generatedBy = generatedByOf(config);
    if (generatedBy?.role === "admin" && generatedBy.uid) ids.add(generatedBy.uid);
  }
  return [...ids];
}

/**
 * Nombres de admin con el Admin SDK, como `resolveAuditActors` del historial: lotes de 100, un fallo de
 * Auth no tumba la respuesta (cae al uid en `toStoreApiKeyStatus`).
 */
async function resolveAdminNames(uids: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (let index = 0; index < uids.length; index += 100) {
    const chunk = uids.slice(index, index + 100);
    try {
      const result = await getAuth().getUsers(chunk.map((uid) => ({ uid })));
      for (const user of result.users) names[user.uid] = user.displayName ?? user.email ?? user.uid;
    } catch {
      // Sin nombre se muestra el uid; no es motivo para negar el estado de las keys.
    }
  }
  return names;
}

const rotateStoreWriteKeySchema = z.object({
  sellerId: z.string().min(1),
  rotate: z.boolean()
});

const storeApiKeyStatusSchema = z.object({
  sellerId: z.string().min(1)
});

export const rotateStoreWriteKey = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller")) {
    throw new HttpsError("permission-denied", "Solo un admin o la tienda pueden generar o rotar la clave de escritura.");
  }
  const parsed = rotateStoreWriteKeySchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.", parsed.error.flatten());
  const input = parsed.data;
  if (role === "seller" && input.sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Una tienda solo puede gestionar su propia clave.");
  }
  const actor = { uid: request.auth.uid, role: role as "admin" | "seller" };

  const db = getFirestore();
  const sellerSnap = await db.collection("sellers").doc(input.sellerId).get();
  if (!sellerSnap.exists) throw new HttpsError("not-found", "Tienda no encontrada.");
  const sellerName = String(sellerSnap.data()?.name ?? input.sellerId);

  // Se genera antes de la transaccion; si el commit falla, se descarta y nunca sale del servidor.
  const writeKey = generateWriteKey();
  const configRef = db.collection("storeApiConfigs").doc(input.sellerId);
  const auditRef = db.collection("auditEvents").doc();

  const committed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(configRef);
    const current = snap.exists ? (snap.data() as StoreApiConfigLike) : null;
    const now = new Date().toISOString();
    const plan = planWriteKeyChange({ sellerId: input.sellerId, config: current, rotate: input.rotate, actor, now, writeKey });
    if (!plan.ok) throw new HttpsError("failed-precondition", plan.message);

    // Config inexistente (tienda sin key de lectura): se crea activa y sin key de lectura (plan 2.3).
    const base = current
      ? { updatedAt: now }
      : { id: input.sellerId, sellerId: input.sellerId, sellerName, status: "active", createdAt: now, updatedAt: now };
    tx.set(configRef, stripUndefined({ ...base, ...plan.fields }), { merge: true });
    tx.set(auditRef, stripUndefined({ id: auditRef.id, ...plan.auditEvent }));

    const after: StoreApiConfigLike = { ...(current ?? {}), ...base, ...plan.fields };
    return { after, previousLast4: plan.previousLast4 };
  });

  const adminNames = role === "admin" ? await resolveAdminNames(adminGeneratorIds([committed.after])) : undefined;
  const status = toStoreApiKeyStatus({ sellerId: input.sellerId, sellerName, config: committed.after, viewerRole: role, adminNames });
  return { status, writeKey, previousLast4: committed.previousLast4 };
});

export const getStoreApiKeyStatus = onCall(async (request) => {
  const role = request.auth?.token.role;
  const sellerClaim = typeof request.auth?.token.sellerId === "string" ? request.auth.token.sellerId : undefined;
  if (!request.auth || (role !== "admin" && role !== "seller" && role !== "seller_logistics")) {
    throw new HttpsError("permission-denied", "No tienes acceso a las claves de esta tienda.");
  }
  const parsed = storeApiKeyStatusSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.", parsed.error.flatten());
  const { sellerId } = parsed.data;
  if (role !== "admin" && sellerId !== sellerClaim) {
    throw new HttpsError("permission-denied", "Solo puedes ver las claves de tu tienda.");
  }

  const db = getFirestore();
  const [sellerSnap, configSnap] = await Promise.all([
    db.collection("sellers").doc(sellerId).get(),
    db.collection("storeApiConfigs").doc(sellerId).get()
  ]);
  if (!sellerSnap.exists) throw new HttpsError("not-found", "Tienda no encontrada.");
  const config = configSnap.exists ? (configSnap.data() as StoreApiConfigLike) : null;
  const sellerName = typeof sellerSnap.data()?.name === "string" ? String(sellerSnap.data()?.name) : undefined;
  const adminNames = role === "admin" ? await resolveAdminNames(adminGeneratorIds([config])) : undefined;
  return toStoreApiKeyStatus({ sellerId, sellerName, config, viewerRole: role, adminNames });
});

export const listStoreApiKeys = onCall(async (request) => {
  const role = request.auth?.token.role;
  if (!request.auth || role !== "admin") {
    throw new HttpsError("permission-denied", "Solo un admin puede ver las claves de todas las tiendas.");
  }

  const db = getFirestore();
  const [sellersSnap, configsSnap] = await Promise.all([
    db.collection("sellers").get(),
    db.collection("storeApiConfigs").get()
  ]);
  const configs = new Map<string, StoreApiConfigLike>(
    configsSnap.docs.map((doc) => [doc.id, doc.data() as StoreApiConfigLike])
  );

  const adminNames = await resolveAdminNames(adminGeneratorIds([...configs.values()]));
  const stores = sellersSnap.docs.map((doc) => {
    const name = doc.data()?.name;
    return toStoreApiKeyStatus({
      sellerId: doc.id,
      sellerName: typeof name === "string" ? name : undefined,
      config: configs.get(doc.id) ?? null,
      viewerRole: "admin",
      adminNames
    });
  });
  stores.sort((a, b) => a.sellerName.localeCompare(b.sellerName, "es"));
  return { stores };
});
