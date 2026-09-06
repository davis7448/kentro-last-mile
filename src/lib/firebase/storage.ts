"use client";

import { type User } from "firebase/auth";
import { type FirebaseStorage, getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { getFirebaseClient } from "./client";

const maxStorageBytes = 7.5 * 1024 * 1024;
/**
 * Por debajo de esto no vale la pena decodificar: la foto ya cabe en unos pocos segundos de 3G.
 *
 * Antes el umbral eran 1.8 MB y era el motivo numero dos de lentitud: una foto de 1.7 MB a 4000px
 * subia INTACTA, y en la red de un domiciliario eso son 15-30 s solo de transferencia. Como efecto
 * lateral util, volver a preparar un archivo ya preparado (~200 KB) sale por aqui sin hacer nada,
 * asi que el camino de la cola offline no comprime dos veces la misma foto.
 */
const skipCompressionBytes = 400 * 1024;
const maxEvidenceSide = 1400;
const jpegQuality = 0.72;

/**
 * Techo duro de la subida.
 *
 * `uploadBytes` (no resumable) reintenta en silencio hasta `maxUploadRetryTime`, que por defecto
 * son DIEZ MINUTOS: en un telefono con mala senal el boton se quedaba en "Subiendo evidencia..."
 * para siempre y el domiciliario cerraba la app antes de ver un error. Con un tope propio la
 * subida falla rapido y cae a la cola offline, que es justo para lo que existe.
 */
const uploadTimeoutMs = 90_000;
/** El refresco del token tambien va a la red y tampoco tenia techo. */
const tokenTimeoutMs = 10_000;

/** Error que `shouldQueueEvidence` reconoce como "encolable" por su `code`. */
function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "storage/canceled" });
}

/**
 * Refresca los claims, pero sin poder colgarse.
 *
 * Esto YA NO va en la ruta caliente. Estaba antes de comprimir y de subir, en cada entrega, y era
 * un round-trip de red bloqueante de hasta 10 s por foto. El refresco forzado solo hace falta
 * cuando acaban de cambiar los claims del usuario (al crearlo), y eso se nota porque las reglas
 * responden `storage/unauthorized`: ahora se refresca ahi, una vez, y se reintenta.
 */
async function refreshIdToken(user: User) {
  try {
    await Promise.race([
      user.getIdToken(true),
      new Promise((_, reject) => setTimeout(() => reject(timeoutError("token-timeout")), tokenTimeoutMs))
    ]);
  } catch {
    await user.getIdToken();
  }
}

function cleanFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

type DecodedImage = { source: CanvasImageSource; width: number; height: number; release: () => void };

/**
 * Decodifica con `createImageBitmap` y, si no se puede, con un `<img>`.
 *
 * El fallback no es teorico: `browserslist` fija Safari/iOS 14 a proposito (ver CLAUDE.md) y ahi
 * `createImageBitmap` NO EXISTE. Al ser un global ausente la llamada lanza de forma sincrona, asi
 * que el `.catch()` que habia no la atrapaba: en esos iPhone toda foto pesada moria antes de subir.
 */
async function decodeImage(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap) return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => resolve(null);
    element.src = url;
  });
  if (!image) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

function tooHeavy(file: File) {
  return file.size > maxStorageBytes;
}

export async function prepareEvidenceImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("La evidencia debe ser una imagen.");
  }
  if (file.size <= skipCompressionBytes) return file;

  const decoded = await decodeImage(file);
  if (!decoded) {
    if (tooHeavy(file)) {
      throw new Error("La imagen es muy pesada. Toma una foto en menor resolucion o envia una captura comprimida.");
    }
    return file;
  }

  const scale = Math.min(1, maxEvidenceSide / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    decoded.release();
    if (tooHeavy(file)) throw new Error("No se pudo comprimir la imagen. Intenta con una foto mas liviana.");
    return file;
  }
  context.drawImage(decoded.source, 0, 0, width, height);
  decoded.release();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", jpegQuality));
  if (!blob) {
    if (tooHeavy(file)) throw new Error("No se pudo comprimir la imagen. Intenta con una foto mas liviana.");
    return file;
  }
  // Un PNG pequeno o un JPEG ya optimizado pueden ENGORDAR al recodificar. Si pasa, se sube el original.
  if (blob.size >= file.size) {
    if (tooHeavy(file)) {
      throw new Error("La imagen sigue siendo muy pesada. Toma una foto en menor resolucion.");
    }
    return file;
  }
  if (blob.size > maxStorageBytes) {
    throw new Error("La imagen sigue siendo muy pesada. Toma una foto en menor resolucion.");
  }
  const baseName = cleanFileName(file.name || "evidencia.jpg").replace(/\.[^.]+$/, "");
  return new File([blob], `${baseName || "evidencia"}.jpg`, { type: "image/jpeg" });
}

export type UploadEvidenceOptions = {
  /** Progreso 0-100 para que el boton muestre avance real en vez de un rotulo fijo. */
  onProgress?: (percent: number) => void;
  /** Aborta la subida en vuelo cuando el usuario reemplaza la foto. */
  signal?: AbortSignal;
};

function isUnauthorized(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "storage/unauthorized";
}

async function runUpload(storage: FirebaseStorage, path: string, uploadFile: File, options: UploadEvidenceOptions) {
  // Comprobado ANTES de crear la tarea: si no, se sube igual un archivo que ya nadie quiere.
  if (options.signal?.aborted) throw timeoutError("Subida cancelada.");

  const evidenceRef = ref(storage, path);
  // Resumable, no `uploadBytes`: es la unica variante que expone progreso y `cancel()`, y sin
  // cancelacion no hay forma de imponer el tope de tiempo ni de abortar al cambiar de foto.
  const task = uploadBytesResumable(evidenceRef, uploadFile, { contentType: uploadFile.type || "image/jpeg" });
  options.onProgress?.(0);

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    function onAbort() {
      settle(() => {
        task.cancel();
        reject(timeoutError("Subida cancelada."));
      });
    }
    timer = setTimeout(() => {
      settle(() => {
        task.cancel();
        reject(timeoutError("La subida tardo demasiado. Se guardo en el dispositivo y se reintentara cuando haya senal."));
      });
    }, uploadTimeoutMs);
    options.signal?.addEventListener("abort", onAbort);
    task.on(
      "state_changed",
      (snapshot) => {
        if (!snapshot.totalBytes) return;
        options.onProgress?.(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
      },
      (error) => settle(() => reject(error)),
      () => settle(resolve)
    );
  });

  return getDownloadURL(evidenceRef);
}

export async function uploadEvidenceImage(orderId: string, file: File, options: UploadEvidenceOptions = {}) {
  const client = getFirebaseClient();
  if (!client) {
    throw new Error("Storage no esta disponible en modo local.");
  }
  const user = client.auth.currentUser;
  if (!user) {
    throw new Error("Debes iniciar sesion para subir evidencia.");
  }

  const uploadFile = await prepareEvidenceImage(file);
  if (uploadFile.size > maxStorageBytes) {
    throw new Error("La imagen supera el limite permitido. Toma una foto en menor resolucion.");
  }

  const safeName = cleanFileName(uploadFile.name || file.name || "evidencia.jpg");
  const evidencePath = () => `evidence/${orderId}/${Date.now()}-${safeName}`;

  let path = evidencePath();
  let url: string;
  try {
    url = await runUpload(client.storage, path, uploadFile, options);
  } catch (error) {
    // Unica razon por la que el token viejo importa: las reglas leen `request.auth.token.role` y
    // el claim puede acabar de asignarse. Se refresca aqui, una vez, en vez de en cada entrega.
    if (!isUnauthorized(error) || options.signal?.aborted) throw error;
    await refreshIdToken(user);
    path = evidencePath();
    url = await runUpload(client.storage, path, uploadFile, options);
  }
  return { label: file.name || safeName, path, url };
}
