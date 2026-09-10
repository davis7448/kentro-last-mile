/**
 * Validacion del registro publico por enlace. SIN acceso a Firestore ni a Auth.
 *
 * El alta es AUTOMATICA por decision de negocio: no hay aprobacion humana ni tope de altas.
 * Eso convierte a este archivo en la unica barrera antes de crear una cuenta operativa, asi
 * que su comportamiento se prueba entero y no se le anaden campos "por si acaso": cada campo
 * de mas en un formulario abierto en un movil es una tienda que no se registra.
 */
import { isRetiredSlugStillValid } from "./community-slug";
import { communityAcceptsSignups } from "./community-access";

/** Se avisa al administrador a partir de aqui. NO se bloquea: el negocio lo pidio abierto. */
export const MASS_SIGNUP_ALERT_THRESHOLD = 10;
export const MASS_SIGNUP_WINDOW_MINUTES = 60;

export type SignupInput = {
  email: string;
  password: string;
  responsibleName: string;
  phone: string;
  storeName: string;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseSignupInput(raw: Record<string, unknown>): Parsed<SignupInput> {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const email = text(raw.email).toLowerCase();
  const password = typeof raw.password === "string" ? raw.password : "";
  const responsibleName = text(raw.responsibleName).replace(/\s+/g, " ");
  const storeName = text(raw.storeName).replace(/\s+/g, " ");
  // El telefono llega como lo escribe la gente: con espacios, guiones o parentesis.
  const phone = text(raw.phone).replace(/[^\d+]/g, "");

  if (!EMAIL.test(email)) return { ok: false, reason: "Escribe un correo valido." };
  if (password.length < 6) return { ok: false, reason: "La contrasena necesita al menos 6 caracteres." };
  if (!responsibleName) return { ok: false, reason: "Escribe el nombre del responsable." };
  if (phone.replace(/\D/g, "").length < 7) return { ok: false, reason: "Escribe un telefono de contacto valido." };
  if (!storeName) return { ok: false, reason: "Escribe el nombre de la tienda." };

  // Se construye un objeto nuevo a proposito: lo que llegue de mas en el cuerpo se descarta.
  return { ok: true, value: { email, password, responsibleName, phone, storeName } };
}

type SlugLookup = {
  community: { id: string; status: string; linkStatus?: string };
  /** Presente si el enlace usa un nombre corto que el lider ya cambio. */
  retiredAt?: string;
};

/**
 * Un enlace inexistente y uno revocado devuelven el MISMO resultado a proposito: por la
 * respuesta no se puede deducir si una comunidad existe.
 */
export function resolveSignupSlug(lookup: SlugLookup | undefined, nowIso: string): Parsed<{ communityId: string }> {
  const rejected: Parsed<{ communityId: string }> = {
    ok: false,
    reason: "Ese enlace ya no admite registros. Pide uno vigente a quien te invito."
  };
  if (!lookup) return rejected;
  if (!isRetiredSlugStillValid(lookup.retiredAt, nowIso)) return rejected;
  if (!communityAcceptsSignups(lookup.community)) return rejected;
  return { ok: true, value: { communityId: lookup.community.id } };
}

/**
 * RF_45: o queda todo o no queda nada. Crear el acceso y no la tienda deja un correo
 * ocupado por una cuenta que no puede operar, y la persona no puede ni reintentar.
 */
export function signupRollbackPlan(state: { authUserCreated: boolean; sellerWritten: boolean }): {
  deleteAuthUser: boolean;
  reason: string;
} {
  if (state.authUserCreated && !state.sellerWritten) {
    return {
      deleteAuthUser: true,
      reason: "La tienda no se pudo crear: se borra el acceso para que el correo quede libre."
    };
  }
  return { deleteAuthUser: false, reason: "" };
}

/** RF_13: solo avisa. Devolver `true` no impide ni una sola alta. */
export function shouldRaiseMassSignupAlert(recentSignupIsoDates: string[], nowIso: string): boolean {
  const now = Date.parse(nowIso);
  const windowMs = MASS_SIGNUP_WINDOW_MINUTES * 60_000;
  const inWindow = recentSignupIsoDates.filter((iso) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) && now - at <= windowMs && at <= now;
  });
  return inWindow.length >= MASS_SIGNUP_ALERT_THRESHOLD;
}
