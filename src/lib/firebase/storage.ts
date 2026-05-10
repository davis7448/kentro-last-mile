"use client";

import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { getFirebaseClient } from "./client";

function cleanFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
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

  const safeName = cleanFileName(file.name || "evidencia.jpg");
  const path = `evidence/${orderId}/${Date.now()}-${safeName}`;
  const evidenceRef = ref(client.storage, path);
  await uploadBytes(evidenceRef, file, { contentType: file.type || "image/jpeg" });
  const url = await getDownloadURL(evidenceRef);
  return { label: file.name || safeName, path, url };
}
