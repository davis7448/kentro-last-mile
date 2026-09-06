import type { FailedCategory } from "@/lib/types";

/**
 * Cola de evidencias que no se pudieron subir por falta de senal.
 *
 * Vivia dentro de `operations-app.tsx` y guardaba la foto en base64 DENTRO del mismo array de
 * metadatos. El panel de la cola esta montado siempre en las vistas de domiciliario y de lider
 * logistico y reintenta cada 30 s, asi que el telefono hacia `JSON.parse` de varios MB de base64
 * cada medio minuto, en el hilo principal, mientras el usuario intentaba subir la siguiente foto.
 * Ademas todo compartia una sola clave: al pasarse de los ~5 MB de `localStorage` reventaba la
 * escritura entera y la foto se perdia en silencio.
 *
 * Ahora el indice guarda solo metadatos (unos cientos de bytes por item) y cada foto va en su
 * propia clave, que solo se lee en el momento de reintentar la subida.
 *
 * No se usa IndexedDB a proposito: `firebase/client.ts` deja a `driver`/`messenger` sin cache
 * persistente porque IndexedDB bajo presion colgaba `getIdToken()`. No hay que devolverle esa carga.
 */
export type QueuedEvidence = {
  id: string;
  orderId: string;
  outcome: "delivered" | "failed";
  note: string;
  reason?: string;
  failedCategory?: FailedCategory;
  scheduledDate?: string;
  scheduledWindow?: string;
  fileName: string;
  fileType: string;
  createdAt: string;
  error?: string;
};

const queueKey = "kentro-evidence-queue";
const photoKeyPrefix = "kentro-evidence-photo-";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function photoKey(id: string) {
  return `${photoKeyPrefix}${id}`;
}

function isQuotaError(error: unknown) {
  return error instanceof Error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

/** Formato anterior: la foto en base64 vivia DENTRO del item del indice. */
type LegacyQueuedEvidence = QueuedEvidence & { dataUrl?: string };

/**
 * Migra los items que quedaron guardados con el formato viejo.
 *
 * Sin esto, el domiciliario que tenga una evidencia en cola el dia del despliegue la pierde: el
 * codigo nuevo busca la foto en su clave propia, no la encuentra y descarta el item. Se ejecuta al
 * leer, que es el unico momento en que se sabe que hay algo viejo.
 */
function migrateLegacyItems(store: Storage, items: LegacyQueuedEvidence[]): QueuedEvidence[] {
  if (!items.some((item) => typeof item.dataUrl === "string" && item.dataUrl)) {
    return items as QueuedEvidence[];
  }
  const migrated = items.map(({ dataUrl, ...item }) => {
    if (dataUrl && !store.getItem(photoKey(item.id))) {
      try {
        store.setItem(photoKey(item.id), dataUrl);
      } catch {
        // Sin espacio para moverla: se conserva el item igual, el reintento avisara del fallo.
      }
    }
    return item;
  });
  store.setItem(queueKey, JSON.stringify(migrated));
  return migrated;
}

export function readEvidenceQueue(): QueuedEvidence[] {
  const store = storage();
  if (!store) return [];
  const raw = store.getItem(queueKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return migrateLegacyItems(store, parsed as LegacyQueuedEvidence[]);
  } catch {
    // Un indice corrupto no puede dejar la app sin cola para siempre.
    store.removeItem(queueKey);
    return [];
  }
}

export function writeEvidenceQueue(items: QueuedEvidence[]) {
  const store = storage();
  if (!store) return;
  store.setItem(queueKey, JSON.stringify(items));
  pruneOrphanPhotos(items);
}

/** Borra fotos cuyo item ya no esta en el indice: sin esto la cuota se llena de basura invisible. */
export function pruneOrphanPhotos(items: QueuedEvidence[] = readEvidenceQueue()) {
  const store = storage();
  if (!store) return;
  const alive = new Set(items.map((item) => photoKey(item.id)));
  const orphans: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key && key.startsWith(photoKeyPrefix) && !alive.has(key)) orphans.push(key);
  }
  orphans.forEach((key) => store.removeItem(key));
}

export function readQueuedPhoto(id: string): string | null {
  return storage()?.getItem(photoKey(id)) ?? null;
}

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("No se pudo guardar la foto en cola."));
    reader.readAsDataURL(file);
  });
}

/**
 * Reconstruye el File a partir del dataURL.
 *
 * `fetch` sobre `data:` lo resuelve el navegador de una sola pieza. Antes se hacia con `atob` y un
 * bucle byte a byte: ~2,4 millones de iteraciones sincronas por foto, en el hilo principal.
 */
export async function queuedEvidenceToFile(item: QueuedEvidence, dataUrl: string): Promise<File> {
  const type = dataUrl.match(/^data:([^;,]+)[;,]/)?.[1] || item.fileType || "image/jpeg";
  try {
    const blob = await fetch(dataUrl).then((response) => response.blob());
    return new File([blob], item.fileName, { type });
  } catch {
    const body = dataUrl.split(",")[1] ?? "";
    const binary = window.atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], item.fileName, { type });
  }
}

export type EnqueueEvidenceInput = Omit<QueuedEvidence, "id" | "fileName" | "fileType" | "createdAt" | "error"> & {
  /** Ya preparado por `prepareEvidenceImage`: aqui NO se vuelve a comprimir. */
  file: File;
};

export async function enqueueEvidence(input: EnqueueEvidenceInput): Promise<QueuedEvidence> {
  const store = storage();
  if (!store) throw new Error("No se pudo guardar la evidencia en cola.");
  const dataUrl = await fileToDataUrl(input.file);
  const item: QueuedEvidence = {
    id: `qe-${input.orderId}-${Date.now()}`,
    orderId: input.orderId,
    outcome: input.outcome,
    note: input.note,
    reason: input.reason,
    failedCategory: input.failedCategory,
    scheduledDate: input.scheduledDate,
    scheduledWindow: input.scheduledWindow,
    fileName: input.file.name || "evidencia.jpg",
    fileType: input.file.type || "image/jpeg",
    createdAt: new Date().toISOString()
  };

  const queue = [item, ...readEvidenceQueue().filter((queued) => queued.id !== item.id)];
  try {
    store.setItem(photoKey(item.id), dataUrl);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    // La foto de hoy vale mas que la mas vieja de la cola, que probablemente ya se reintento en vano.
    const oldest = queue[queue.length - 1];
    if (!oldest || oldest.id === item.id) {
      throw new Error("No hay espacio en el dispositivo para guardar la foto. Libera espacio e intenta de nuevo.");
    }
    store.removeItem(photoKey(oldest.id));
    writeEvidenceQueue(queue.filter((queued) => queued.id !== oldest.id));
    try {
      store.setItem(photoKey(item.id), dataUrl);
    } catch {
      throw new Error("No hay espacio en el dispositivo para guardar la foto. Libera espacio e intenta de nuevo.");
    }
  }

  writeEvidenceQueue([item, ...readEvidenceQueue().filter((queued) => queued.id !== item.id)]);
  return item;
}

export function removeQueuedEvidence(id: string): QueuedEvidence[] {
  const remaining = readEvidenceQueue().filter((item) => item.id !== id);
  storage()?.removeItem(photoKey(id));
  writeEvidenceQueue(remaining);
  return remaining;
}

export function markQueuedEvidenceError(id: string, message: string): QueuedEvidence[] {
  const next = readEvidenceQueue().map((item) => (item.id === id ? { ...item, error: message } : item));
  writeEvidenceQueue(next);
  return next;
}
