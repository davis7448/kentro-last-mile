"use client";

import { addDoc, collection, serverTimestamp, Timestamp } from "firebase/firestore";
import { buildEvidenceTimingDoc, EVIDENCE_TIMING_TTL_DAYS, type EvidenceTrace } from "@/lib/evidence-timing";
import { getFirebaseClient } from "./client";

type NetworkInformationLike = { effectiveType?: unknown; downlink?: unknown; rtt?: unknown; saveData?: unknown };

/**
 * Escribe la medicion de una evidencia en `evidenceTimings` y se olvida.
 *
 * Sin `await` en quien la llama y sin reintento propio: si falla, se pierde ESE registro y nada
 * mas. Sin senal, el SDK la deja en su cola persistente y la manda al volver la red, que es justo
 * lo que se quiere (el registro de una foto que se fue a la cola offline tambien cuenta).
 * El documento caduca solo por la politica TTL sobre `expiresAt`; nadie lo lee desde el cliente.
 */
export function recordEvidenceTiming(trace: EvidenceTrace) {
  try {
    const client = getFirebaseClient();
    const user = client?.auth.currentUser;
    if (!client || !user) return;
    void user
      .getIdTokenResult()
      .then((token) => {
        const role = typeof token.claims.role === "string" ? token.claims.role : "";
        if (role !== "driver" && role !== "messenger") return;
        const connection = typeof navigator !== "undefined"
          ? (navigator as Navigator & { connection?: NetworkInformationLike }).connection ?? null
          : null;
        const doc = buildEvidenceTimingDoc(
          trace,
          {
            uid: user.uid,
            role,
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
            online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
            connection
          },
          new Date().toISOString()
        );
        const expiresAt = Timestamp.fromMillis(Date.now() + EVIDENCE_TIMING_TTL_DAYS * 24 * 60 * 60 * 1000);
        return addDoc(collection(client.db, "evidenceTimings"), { ...doc, createdAt: serverTimestamp(), expiresAt });
      })
      .catch((error: unknown) => {
        // Medicion, no operacion: se avisa en consola y se sigue.
        console.warn("[evidence-timing] no se pudo registrar", error);
      });
  } catch (error) {
    console.warn("[evidence-timing] no se pudo registrar", error);
  }
}
