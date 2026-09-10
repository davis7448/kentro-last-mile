/**
 * Registro publico de tiendas por el enlace de un lider de comunidad.
 *
 * Estas dos callables se invocan SIN sesion: son la unica superficie de la plataforma abierta
 * a cualquiera. Por eso todo lo que deciden vive en `community-signup-validate`, que se prueba
 * entero, y aqui solo queda la escritura.
 *
 * El alta es automatica por decision de negocio: no hay aprobacion ni tope. La contencion es
 * posterior —revocar el enlace y desactivar en bloque— y esta en `communities.ts`.
 */
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { normalizeSlug } from "./community-slug";
import {
  MASS_SIGNUP_WINDOW_MINUTES,
  parseSignupInput,
  resolveSignupSlug,
  shouldRaiseMassSignupAlert,
  signupRollbackPlan
} from "./community-signup-validate";

type SlugLookup = {
  community: { id: string; status: string; linkStatus?: string };
  retiredAt?: string;
};

async function lookupSlug(slugRaw: string): Promise<SlugLookup | undefined> {
  const slug = normalizeSlug(slugRaw);
  if (!slug) return undefined;
  const db = getFirestore();
  const slugSnap = await db.collection("communitySlugs").doc(slug).get();
  if (!slugSnap.exists) return undefined;
  const communityId = String(slugSnap.data()?.communityId ?? "");
  if (!communityId) return undefined;
  const communitySnap = await db.collection("communities").doc(communityId).get();
  if (!communitySnap.exists) return undefined;
  const data = communitySnap.data() ?? {};
  return {
    community: {
      id: communityId,
      status: String(data.status ?? ""),
      linkStatus: String(data.linkStatus ?? "")
    },
    retiredAt: typeof slugSnap.data()?.retiredAt === "string" ? String(slugSnap.data()?.retiredAt) : undefined
  };
}

/**
 * RF_14, RF_15: lo que necesita la pantalla publica para pintarse con la marca del lider.
 * Devuelve el minimo indispensable: ni precios, ni tiendas, ni cifras. Un enlace inexistente y
 * uno revocado responden igual, para que por la respuesta no se pueda deducir que existe.
 */
export const getCommunityBySlug = onCall(async (request) => {
  const parsed = z.object({ slug: z.string().trim().min(1) }).safeParse(request.data);
  if (!parsed.success) return { acceptsSignups: false };

  const now = new Date().toISOString();
  const lookup = await lookupSlug(parsed.data.slug);
  const resolved = resolveSignupSlug(lookup, now);
  if (!resolved.ok) return { acceptsSignups: false };

  const snap = await getFirestore().collection("communities").doc(resolved.value.communityId).get();
  const data = snap.data() ?? {};
  return {
    acceptsSignups: true,
    name: String(data.name ?? ""),
    logoPath: typeof data.logoPath === "string" ? data.logoPath : null
  };
});

/**
 * RF_07, RF_08, RF_10, RF_43, RF_45.
 *
 * El orden importa y es deliberado: primero se resuelve el enlace (si falla no se toca nada),
 * luego se crea el acceso, luego la tienda. Si la tienda falla, se BORRA el acceso: dejarlo
 * ocuparia el correo con una cuenta que no puede operar y la persona no podria ni reintentar.
 */
export const registerSellerBySlug = onCall(async (request) => {
  const slugParsed = z.object({ slug: z.string().trim().min(1) }).safeParse(request.data);
  if (!slugParsed.success) throw new HttpsError("invalid-argument", "Falta el enlace de invitacion.");

  const input = parseSignupInput((request.data ?? {}) as Record<string, unknown>);
  if (!input.ok) throw new HttpsError("invalid-argument", input.reason);

  const now = new Date().toISOString();
  const lookup = await lookupSlug(slugParsed.data.slug);
  const resolved = resolveSignupSlug(lookup, now);
  if (!resolved.ok) throw new HttpsError("failed-precondition", resolved.reason);
  const communityId = resolved.value.communityId;

  const db = getFirestore();
  const auth = getAuth();

  // RF_10: si el correo ya existe se rechaza sin tocar la cuenta existente y sin decir a que
  // comunidad pertenece.
  let user;
  try {
    user = await auth.createUser({
      email: input.value.email,
      password: input.value.password,
      displayName: input.value.responsibleName
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Ese correo ya tiene una cuenta. Inicia sesion.");
    }
    throw error;
  }

  const sellerId = `seller-${Date.now()}`;
  let sellerWritten = false;
  try {
    const settingsSnap = await db.collection("settings").doc("app").get();
    const activeCityId = String(settingsSnap.data()?.activeCityId ?? "city-cali");
    await db.collection("sellers").doc(sellerId).set({
      id: sellerId,
      name: input.value.storeName,
      shopDomain: "",
      cityId: activeCityId,
      bankAccount: "",
      email: input.value.email,
      contactEmail: input.value.email,
      contactName: input.value.responsibleName,
      contactPhone: input.value.phone,
      communityId,
      communityJoinedAt: now,
      communitySignupSlug: normalizeSlug(slugParsed.data.slug),
      // RF_44: entra y se mueve por la app, pero no crea pedidos hasta completar ciudad,
      // punto de recogida y cuenta bancaria.
      onboardingComplete: false,
      createdAt: now,
      updatedAt: now
    });
    sellerWritten = true;
    await auth.setCustomUserClaims(user.uid, { role: "seller", sellerId });
  } catch (error) {
    const rollback = signupRollbackPlan({ authUserCreated: true, sellerWritten });
    if (rollback.deleteAuthUser) await auth.deleteUser(user.uid).catch(() => undefined);
    throw error instanceof HttpsError ? error : new HttpsError("internal", "No se pudo completar el registro.");
  }

  // RF_13: el aviso NO bloquea. Se levanta despues de crear la cuenta, a proposito.
  const windowStart = new Date(Date.parse(now) - MASS_SIGNUP_WINDOW_MINUTES * 60_000).toISOString();
  const recentSnap = await db
    .collection("sellers")
    .where("communityId", "==", communityId)
    .where("communityJoinedAt", ">=", windowStart)
    .get();
  const recent = recentSnap.docs.map((doc) => String(doc.data()?.communityJoinedAt ?? ""));
  if (shouldRaiseMassSignupAlert(recent, now)) {
    await db.collection("communities").doc(communityId).set(
      { massSignupAlertAt: now, massSignupAlertDismissedAt: null },
      { merge: true }
    );
  }

  return { sellerId, communityId };
});
