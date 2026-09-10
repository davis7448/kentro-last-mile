/**
 * Nombre corto del enlace de una comunidad. SIN acceso a Firestore.
 *
 * El slug es la unica puerta de entrada de una tienda referida, asi que su validacion no puede
 * vivir dentro del callable: se prueba aparte. La reserva atomica (que dos comunidades no se
 * queden con el mismo) es cosa de `communities.ts`; aqui solo esta la forma.
 */

/** Un slug retirado sigue abriendo el registro este tiempo, para no romper enlaces repartidos. */
export const RETIRED_SLUG_GRACE_DAYS = 30;

/**
 * Palabras que no puede tomar una comunidad porque son rutas de la plataforma o se confunden
 * con ellas. Se comparan ya normalizadas.
 */
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "registro",
  "register",
  "signup",
  "login",
  "logout",
  "kentro",
  "privacy",
  "static",
  "_next"
]);

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function normalizeSlug(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export type SlugValidation = { ok: true; slug: string } | { ok: false; reason: string };

export function validateSlug(value: string): SlugValidation {
  const slug = normalizeSlug(value);
  if (!slug) return { ok: false, reason: "Escribe un nombre corto para tu enlace." };
  if (slug.length < 3) return { ok: false, reason: "El nombre corto necesita al menos 3 caracteres." };
  if (slug.length > 32) return { ok: false, reason: "El nombre corto admite como maximo 32 caracteres." };
  if (!SLUG_SHAPE.test(slug)) {
    return { ok: false, reason: "Usa solo letras, numeros y guiones, sin empezar ni terminar en guion." };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "Ese nombre corto esta reservado por la plataforma." };
  return { ok: true, slug };
}

/**
 * `retiredAt` ausente significa que el slug es el vigente: vale siempre. Con fecha, vale
 * mientras no hayan pasado los dias de gracia. El instante llega por parametro para que las
 * pruebas no tengan que simular el reloj.
 */
export function isRetiredSlugStillValid(retiredAt: string | undefined, nowIso: string): boolean {
  if (!retiredAt) return true;
  const retired = Date.parse(retiredAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(retired) || !Number.isFinite(now)) return false;
  return now - retired <= RETIRED_SLUG_GRACE_DAYS * 24 * 60 * 60 * 1000;
}
