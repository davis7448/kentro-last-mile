"use client";

import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { getFirebaseClient } from "./client";

const maxStorageBytes = 7.5 * 1024 * 1024;
const compressionTargetBytes = 1.8 * 1024 * 1024;
const maxEvidenceSide = 1800;

function cleanFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

export async function prepareEvidenceImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("La evidencia debe ser una imagen.");
  }
  if (file.size <= compressionTargetBytes) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    if (file.size > maxStorageBytes) {
      throw new Error("La imagen es muy pesada. Toma una foto en menor resolucion o envia una captura comprimida.");
    }
    return file;
  }

  const scale = Math.min(1, maxEvidenceSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    if (file.size > maxStorageBytes) throw new Error("No se pudo comprimir la imagen. Intenta con una foto mas liviana.");
    return file;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
  if (!blob) {
    if (file.size > maxStorageBytes) throw new Error("No se pudo comprimir la imagen. Intenta con una foto mas liviana.");
    return file;
  }
  if (blob.size > maxStorageBytes) {
    throw new Error("La imagen sigue siendo muy pesada. Toma una foto en menor resolucion.");
  }
  const baseName = cleanFileName(file.name || "evidencia.jpg").replace(/\.[^.]+$/, "");
  return new File([blob], `${baseName || "evidencia"}.jpg`, { type: "image/jpeg" });
}

export async function uploadEvidenceImage(orderId: string, file: File) {
  const client = getFirebaseClient();
  if (!client) {
    throw new Error("Storage no esta disponible en modo local.");
  }
  const user = client.auth.currentUser;
  if (!user) {
    throw new Error("Debes iniciar sesion para subir evidencia.");
  }

  await user.getIdToken(true);

  const uploadFile = await prepareEvidenceImage(file);
  if (uploadFile.size > maxStorageBytes) {
    throw new Error("La imagen supera el limite permitido. Toma una foto en menor resolucion.");
  }

  const safeName = cleanFileName(uploadFile.name || file.name || "evidencia.jpg");
  const path = `evidence/${orderId}/${Date.now()}-${safeName}`;
  const evidenceRef = ref(client.storage, path);
  await uploadBytes(evidenceRef, uploadFile, { contentType: uploadFile.type || "image/jpeg" });
  const url = await getDownloadURL(evidenceRef);
  return { label: file.name || safeName, path, url };
}
