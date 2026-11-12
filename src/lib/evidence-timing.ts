/**
 * Medicion de cuanto tarda cada tramo de una evidencia en el TELEFONO del domiciliario.
 *
 * Existe porque los domiciliarios dicen que subir la foto "se volvio lento" y en el servidor no hay
 * nada que lo explique (closeOrder estable, Storage y sus reglas sin cambios): el tiempo se va en
 * algo que solo el telefono ve — decodificar y recomprimir la foto, la red movil, o la espera
 * despues de pulsar. Storage no da latencia por peticion de las subidas del SDK, asi que se mide aqui.
 *
 * Puro: arma el registro y lo acota. Quien escribe es `recordEvidenceTiming` (firebase/), que lo
 * manda sin esperar y sin reintentar: la medicion nunca puede frenar ni tumbar un cierre.
 *
 * Los campos son una lista CERRADA porque `firestore.rules` (match /evidenceTimings) los valida con
 * `hasOnly`: si se agrega uno aqui hay que agregarlo alli, o todas las escrituras fallaran en
 * silencio. `evidence-timing.test.ts` compara las dos listas.
 */

export type EvidenceDecoder = "skipped" | "bitmap" | "img" | "none";
export type EvidenceUploadState = "idle" | "preparing" | "uploading" | "ready" | "error";
export type EvidenceTimingResult = "closed" | "queued" | "upload_error" | "close_error" | "abandoned";

/** Lo que se va llenando durante una evidencia. Todo opcional: cada tramo pone lo suyo. */
export type EvidenceTrace = {
  source?: "form" | "queue";
  outcome?: "delivered" | "failed";
  orderId?: string;
  originalBytes?: number;
  originalType?: string;
  preparedBytes?: number;
  decoder?: EvidenceDecoder;
  width?: number;
  height?: number;
  prepareMs?: number;
  /** Subida a Storage + getDownloadURL, incluido el reintento por token si lo hubo. */
  uploadMs?: number;
  /** Segunda preparacion dentro de uploadEvidenceImage. Deberia ser ~0 (archivo ya chico). */
  reprepareMs?: number;
  /** Veces que se arranco la preparacion+subida para esta foto (1 = sin reintento del submit). */
  attempts?: number;
  /** El primer intento devolvio storage/unauthorized y se refresco el token. */
  tokenRetry?: boolean;
  uploadError?: string;
  /** Desde que se eligio la foto hasta que se pulso confirmar. */
  selectToSubmitMs?: number;
  stateAtSubmit?: EvidenceUploadState;
  /** Lo que el domiciliario espera por la foto DESPUES de pulsar: la parte que se siente. */
  submitWaitMs?: number;
  closeMs?: number;
  closeError?: string;
  result?: EvidenceTimingResult;
};

export type EvidenceTimingEnv = {
  uid: string;
  role: string;
  userAgent?: string;
  online?: boolean;
  connection?: { effectiveType?: unknown; downlink?: unknown; rtt?: unknown; saveData?: unknown } | null;
};

/** Campos que acepta la regla. El orden no importa; el conjunto si. */
export const EVIDENCE_TIMING_FIELDS = [
  "uid",
  "role",
  "source",
  "outcome",
  "orderId",
  "result",
  "originalBytes",
  "originalType",
  "preparedBytes",
  "decoder",
  "width",
  "height",
  "prepareMs",
  "uploadMs",
  "reprepareMs",
  "attempts",
  "tokenRetry",
  "uploadError",
  "selectToSubmitMs",
  "stateAtSubmit",
  "submitWaitMs",
  "closeMs",
  "closeError",
  "userAgent",
  "online",
  "netType",
  "netDownlink",
  "netRtt",
  "netSaveData",
  "clientAt",
  "createdAt",
  "expiresAt"
] as const;

export const EVIDENCE_TIMING_TTL_DAYS = 14;
const maxText = 200;
const maxUserAgent = 300;

function text(value: unknown, max = maxText) {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

/** Entero no negativo y finito; cualquier otra cosa se omite en vez de mentir con un 0. */
function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function decimal(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : undefined;
}

function bool(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

/** El codigo de un error de Firebase si lo trae; si no, el mensaje recortado. */
export function errorTag(error: unknown) {
  if (typeof error === "object" && error) {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code) return code.slice(0, maxText);
    const message = "message" in error ? (error as { message?: unknown }).message : undefined;
    if (typeof message === "string" && message) return message.slice(0, maxText);
  }
  return typeof error === "string" && error ? error.slice(0, maxText) : "unknown";
}

/**
 * El documento a escribir, sin `createdAt`/`expiresAt` (los pone el escritor con tipos de Firestore).
 * Omite las claves vacias: Firestore rechaza `undefined` y la regla no tiene por que verlas.
 */
export function buildEvidenceTimingDoc(trace: EvidenceTrace, env: EvidenceTimingEnv, clientAt: string) {
  const connection = env.connection ?? undefined;
  const doc: Record<string, string | number | boolean | undefined> = {
    uid: env.uid,
    role: env.role,
    source: trace.source === "queue" ? "queue" : "form",
    outcome: trace.outcome === "failed" ? "failed" : "delivered",
    orderId: text(trace.orderId, 120),
    result: text(trace.result, 20) ?? "abandoned",
    originalBytes: count(trace.originalBytes),
    originalType: text(trace.originalType, 60),
    preparedBytes: count(trace.preparedBytes),
    decoder: text(trace.decoder, 10),
    width: count(trace.width),
    height: count(trace.height),
    prepareMs: count(trace.prepareMs),
    uploadMs: count(trace.uploadMs),
    reprepareMs: count(trace.reprepareMs),
    attempts: count(trace.attempts),
    tokenRetry: bool(trace.tokenRetry),
    uploadError: text(trace.uploadError),
    selectToSubmitMs: count(trace.selectToSubmitMs),
    stateAtSubmit: text(trace.stateAtSubmit, 12),
    submitWaitMs: count(trace.submitWaitMs),
    closeMs: count(trace.closeMs),
    closeError: text(trace.closeError),
    userAgent: text(env.userAgent, maxUserAgent),
    online: bool(env.online),
    netType: text(connection?.effectiveType, 10),
    netDownlink: decimal(connection?.downlink),
    netRtt: count(connection?.rtt),
    netSaveData: bool(connection?.saveData),
    clientAt
  };
  return Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean>;
}

/** Milisegundos monotonicos; `performance` existe en todo navegador objetivo, Date es el respaldo. */
export function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
