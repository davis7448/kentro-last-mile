import crypto from "node:crypto";

/**
 * Credenciales de la Store API y key de escritura (spec 029, plan 2.3). PURO: solo `node:crypto`, sin
 * firebase-admin ni firebase-functions, para que el handler viejo, las rutas nuevas y la callable de
 * generar/rotar compartan la misma regla sin copiarla.
 *
 * Tres piezas:
 *  1. Formato de la key de escritura (`kw_` + 45 base64url = 48), su huella (sha256 hex) y `last4`. En
 *     `storeApiConfigs` se guarda solo la huella y `last4`; la key completa existe solo en la respuesta
 *     de la callable.
 *  2. `resolveStoreCredentials`: la tabla de 2.3, evaluada EN ORDEN (pasos 1-2 de la precedencia de la
 *     decision 12). La primera fila que aplica decide. Este modulo nunca mira parametros de consulta ni
 *     el cuerpo: eso es el paso 3 y va despues, en otro modulo; por eso unas credenciales malas con un
 *     parametro desconocido dan 401 y no un error de parametros.
 *  3. `planWriteKeyChange`: que campos escribe generar/rotar y que evento de auditoria lo acompana. La
 *     transaccion que los confirma juntos vive en la callable.
 *
 * Comparaciones: SIEMPRE en tiempo constante (`timingSafeEqual` sobre huellas sha256, que miden 32 bytes
 * siempre) y SIEMPRE las dos (lectura y escritura), para no filtrar por tiempo cual de las dos es. Nada de
 * `===` sobre keys o huellas: hay una guarda de fuente en la prueba que lo vigila.
 */

export const WRITE_KEY_PREFIX = "kw_";
const WRITE_KEY_BODY_LENGTH = 45;
const WRITE_KEY_PATTERN = /^kw_[A-Za-z0-9_-]{45}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Key de escritura nueva. 34 bytes aleatorios en base64url dan 46 caracteres; se recortan a 45, que siguen
 * siendo 270 bits de entropia: por eso basta un sha256 rapido como huella, sin pepper ni secreto aparte.
 */
export function generateWriteKey(): string {
  const body = crypto.randomBytes(34).toString("base64url").slice(0, WRITE_KEY_BODY_LENGTH);
  return `${WRITE_KEY_PREFIX}${body}`;
}

/** Huella que se guarda en `storeApiConfigs.writeKeyHash`: sha256 de la key completa, en hex. */
export function writeKeyFingerprint(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

export function last4(key: string): string {
  return key.slice(-4);
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/**
 * La key de lectura se guarda en claro (como hoy). Se comparan sus sha256, no las cadenas: asi los dos
 * buffers miden siempre 32 bytes y `timingSafeEqual` no tiene que cortocircuitar por largo distinto.
 */
function matchesReadKey(offered: string, storedReadKey: unknown): boolean {
  const hasStored = typeof storedReadKey === "string" && storedReadKey.length > 0;
  // Se compara aunque no haya key guardada (contra si misma), para que el tiempo no diga si existe.
  const reference = hasStored ? (storedReadKey as string) : offered;
  const isEqual = crypto.timingSafeEqual(digest(offered), digest(reference));
  return hasStored && isEqual;
}

/** La de escritura solo existe como huella: se compara sha256(ofrecida) con la huella guardada. */
function matchesWriteKey(offered: string, storedFingerprint: unknown): boolean {
  const offeredDigest = digest(offered);
  const hasStored = typeof storedFingerprint === "string" && FINGERPRINT_PATTERN.test(storedFingerprint);
  const reference = hasStored ? Buffer.from(storedFingerprint as string, "hex") : offeredDigest;
  const isEqual = crypto.timingSafeEqual(offeredDigest, reference);
  return hasStored && isEqual;
}

// ---------------------------------------------------------------------------------------------------------
// Resolucion de credenciales (tabla 2.3)
// ---------------------------------------------------------------------------------------------------------

/**
 * - `legacy_read`: rutas de lectura que ya existian (`/kpis`, `/orders`, `/settlements`...). Sus errores
 *   conservan la forma de hoy `{ ok:false, error }` (RF_20).
 * - `read`: rutas de lectura nuevas. Errores `{ ok:false, code, message }`.
 * - `write`: rutas de escritura. La key solo vale por cabecera.
 */
export type StoreApiRoute = "legacy_read" | "read" | "write";

export type StoreApiKeyKind = "read" | "write";

export type StoreCredentialErrorCode = "missing_credentials" | "invalid_key" | "key_in_query" | "read_only_key";

/** Lo que importa de `storeApiConfigs/{sellerId}`; `null` si el documento no existe. */
export type StoreApiConfigLike = {
  status?: unknown;
  apiKey?: unknown;
  writeKeyHash?: unknown;
  writeKeyLast4?: unknown;
  [field: string]: unknown;
};

export type ResolveStoreCredentialsInput = {
  route: StoreApiRoute;
  /** `sellerId` de la query, tal cual llega (se recorta aqui). */
  querySellerId?: unknown;
  /** `key` de la query; `undefined`/`null` si no vino. */
  queryKey?: unknown;
  /** Token de `Authorization: Bearer <token>` ya sin el prefijo; `undefined`/`null` si no vino. */
  bearer?: unknown;
  config: StoreApiConfigLike | null | undefined;
};

export type StoreCredentialsAccepted = {
  ok: true;
  sellerId: string;
  keyKind: StoreApiKeyKind;
  keyLast4: string;
};

export type StoreCredentialsRejected = {
  ok: false;
  httpStatus: 401 | 403;
  code: StoreCredentialErrorCode;
  /** Cuerpo listo para responder: forma vieja en `legacy_read`, forma nueva en el resto. */
  body: Record<string, unknown>;
};

export type StoreCredentialsResult = StoreCredentialsAccepted | StoreCredentialsRejected;

const ERROR_MESSAGES: Record<StoreCredentialErrorCode, string> = {
  missing_credentials: "Faltan credenciales: envia sellerId y la clave en la cabecera Authorization: Bearer <clave>.",
  invalid_key: "La clave no es valida para esta tienda, o la tienda tiene la API desactivada.",
  key_in_query:
    "La clave de escritura no puede ir en la URL. Enviala en la cabecera Authorization: Bearer <clave>.",
  read_only_key: "Esta clave solo permite consultar. Para confirmar o corregir pedidos usa la clave de escritura."
};

// Pista que hoy acompana al missing_credentials de las rutas viejas; se conserva tal cual (RF_20).
const LEGACY_MISSING_CREDENTIALS_HINT = "sellerId y key (query) o Authorization: Bearer <key>";

function reject(route: StoreApiRoute, httpStatus: 401 | 403, code: StoreCredentialErrorCode): StoreCredentialsRejected {
  if (route === "legacy_read") {
    const body: Record<string, unknown> =
      code === "missing_credentials"
        ? { ok: false, error: code, hint: LEGACY_MISSING_CREDENTIALS_HINT }
        : { ok: false, error: code };
    return { ok: false, httpStatus, code, body };
  }
  return { ok: false, httpStatus, code, body: { ok: false, code, message: ERROR_MESSAGES[code] } };
}

function isPresent(value: unknown): boolean {
  return typeof value === "string";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function resolveStoreCredentials(input: ResolveStoreCredentialsInput): StoreCredentialsResult {
  const { route, config } = input;
  const hasQueryKey = isPresent(input.queryKey);

  // Fila 1 (paso 1 de la decision 12): en escritura, cualquier key por query es 401, sin comparar nada,
  // antes que el sellerId, la config o los parametros. Nunca 403: el problema es el sitio, no la key.
  if (route === "write" && hasQueryKey) {
    return reject(route, 401, "key_in_query");
  }

  // En lectura, como hoy: si viene key por query es la unica que se evalua y la Bearer se ignora.
  const fromQuery = route !== "write" && hasQueryKey;
  const offered = fromQuery ? asText(input.queryKey) : asText(input.bearer);

  // Fila 2: una kw_ por query en lectura. La vieja responde su invalid_key de siempre; la nueva nombra el
  // sitio prohibido. Barato y sin comparar: el prefijo basta.
  if (fromQuery && offered.startsWith(WRITE_KEY_PREFIX)) {
    return route === "legacy_read" ? reject(route, 401, "invalid_key") : reject(route, 401, "key_in_query");
  }

  // Fila 3.
  const sellerId = asText(input.querySellerId).trim();
  if (!sellerId || !offered) {
    return reject(route, 401, "missing_credentials");
  }

  // Las dos comparaciones se hacen siempre, haya config o no, antes de decidir nada.
  const isReadKey = matchesReadKey(offered, config?.apiKey);
  const isWriteKey = matchesWriteKey(offered, config?.writeKeyHash);

  // Fila 4: desactivar la tienda apaga las dos keys (la de escritura no tiene status propio).
  const isActive = Boolean(config) && config?.status === "active";
  if (!isActive || (!isReadKey && !isWriteKey)) {
    return reject(route, 401, "invalid_key");
  }

  // Fila 5: key de lectura valida. En escritura solo puede haber llegado por cabecera (la de query ya
  // salio en la fila 1): es el unico 403.
  if (isReadKey) {
    if (route === "write") return reject(route, 403, "read_only_key");
    return { ok: true, sellerId, keyKind: "read", keyLast4: last4(offered) };
  }

  // Fila 6: key de escritura valida por Bearer; vale tambien para leer (RF_20).
  const storedLast4 = asText(config?.writeKeyLast4);
  return { ok: true, sellerId, keyKind: "write", keyLast4: storedLast4 || last4(offered) };
}

// ---------------------------------------------------------------------------------------------------------
// Generar y rotar la key de escritura
// ---------------------------------------------------------------------------------------------------------

export type WriteKeyActor = { uid: string; role: "admin" | "seller" };

export type PlanWriteKeyChangeInput = {
  sellerId: string;
  /** `storeApiConfigs/{sellerId}` leida dentro de la transaccion; `null` si no existe. */
  config: StoreApiConfigLike | null | undefined;
  rotate: boolean;
  actor: WriteKeyActor;
  now: string;
  /** Generada antes de la transaccion con `generateWriteKey`; no sale de aqui en campos ni evento. */
  writeKey: string;
};

export type WriteKeyFieldsPatch = {
  writeKeyHash: string;
  writeKeyPrefix: "kw_";
  writeKeyLast4: string;
  writeKeyGeneratedBy: WriteKeyActor;
  writeKeyCreatedAt?: string;
  writeKeyRotatedAt?: string;
};

export type WriteKeyAuditEvent = {
  action: "store_api_key.write_generated" | "store_api_key.write_rotated";
  entity: "seller";
  entityId: string;
  actorId: string;
  actorRole: string;
  previousLast4: string | null;
  newLast4: string;
  summary: string;
  createdAt: string;
};

export type PlanWriteKeyChangeResult =
  | {
      ok: true;
      fields: WriteKeyFieldsPatch;
      auditEvent: WriteKeyAuditEvent;
      previousLast4: string | null;
      newLast4: string;
    }
  | { ok: false; code: "failed-precondition"; message: string };

/**
 * Que se escribe al generar o rotar. Solo campos `writeKey*`: la key de lectura (`apiKey`) y el `status`
 * de la tienda no se tocan (RF_26). El evento lleva `entityId = sellerId`, los `last4` anterior y nuevo y
 * nunca la key. Las precondiciones se evaluan sobre la config leida dentro de la transaccion: generar con
 * una key ya existente (doble clic en "Generar") o rotar sin key son `failed-precondition` y no cambian nada.
 */
export function planWriteKeyChange(input: PlanWriteKeyChangeInput): PlanWriteKeyChangeResult {
  const { sellerId, config, rotate, actor, now, writeKey } = input;
  if (!WRITE_KEY_PATTERN.test(writeKey)) {
    throw new Error("planWriteKeyChange: la key de escritura no tiene el formato kw_ + 45 base64url.");
  }

  const hasWriteKey = Boolean(config) && typeof config?.writeKeyHash === "string" && config.writeKeyHash.length > 0;
  if (!rotate && hasWriteKey) {
    return {
      ok: false,
      code: "failed-precondition",
      message: "Esta tienda ya tiene una clave de escritura. Para cambiarla, rotala."
    };
  }
  if (rotate && !hasWriteKey) {
    return {
      ok: false,
      code: "failed-precondition",
      message: "Esta tienda no tiene clave de escritura que rotar. Generala primero."
    };
  }

  const previousLast4 = hasWriteKey && typeof config?.writeKeyLast4 === "string" ? config.writeKeyLast4 : null;
  const newLast4 = last4(writeKey);

  const fields: WriteKeyFieldsPatch = {
    writeKeyHash: writeKeyFingerprint(writeKey),
    writeKeyPrefix: "kw_",
    writeKeyLast4: newLast4,
    writeKeyGeneratedBy: { uid: actor.uid, role: actor.role }
  };
  // La fecha de la primera generacion se conserva al rotar; la de rotacion solo existe si se roto.
  if (rotate) fields.writeKeyRotatedAt = now;
  else fields.writeKeyCreatedAt = now;

  const auditEvent: WriteKeyAuditEvent = {
    action: rotate ? "store_api_key.write_rotated" : "store_api_key.write_generated",
    entity: "seller",
    entityId: sellerId,
    actorId: actor.uid,
    actorRole: actor.role,
    previousLast4,
    newLast4,
    summary: rotate
      ? `Clave de escritura de la Store API rotada: la que terminaba en ${previousLast4 ?? "?"} deja de valer; la nueva termina en ${newLast4}`
      : `Clave de escritura de la Store API generada (termina en ${newLast4})`,
    createdAt: now
  };

  return { ok: true, fields, auditEvent, previousLast4, newLast4 };
}
