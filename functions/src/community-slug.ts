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

/** Una escritura declarada, no ejecutada. La callable la traduce a la transaccion. */
export type SlugWrite = {
  collection: "communities" | "communitySlugs";
  docId: string;
  /** `set` reemplaza el documento entero (y con el, un `retiredAt` viejo); `merge` lo respeta. */
  op: "set" | "merge" | "update";
  data: Record<string, string>;
};

export type SlugChangePlan =
  | {
      ok: false;
      /** Los tres motivos que nombra RF_04, distinguibles sin leer prosa. */
      reasonCode: "invalid" | "reserved" | "taken";
      reason: string;
      previousSlug: string | null;
      /** El que queda VIGENTE tras la operacion. En un rechazo es, por fuerza, el anterior. */
      effectiveSlug: string | null;
      writes: readonly SlugWrite[];
    }
  | {
      ok: true;
      previousSlug: string | null;
      effectiveSlug: string;
      changed: boolean;
      writes: readonly SlugWrite[];
    };

export type SlugChangeInput = {
  community: { id: string; slug?: string };
  /** Lo que el lider escribio, en crudo: normalizar es cosa del plan. */
  requestedSlug: string;
  /**
   * De quien es HOY el documento `communitySlugs/{slug normalizado}`, vigente o retirado.
   * `null`/ausente = libre. Lo lee la callable dentro de la transaccion y lo pasa aqui.
   */
  takenByCommunityId?: string | null;
  nowIso: string;
};

/**
 * `_next` normaliza a `next`, asi que mirar solo el normalizado dejaria entrar la ruta de la
 * plataforma escrita tal cual. Se comparan las dos formas.
 */
function isReservedSlug(requested: string, normalized: string): boolean {
  return RESERVED_SLUGS.has(normalized) || RESERVED_SLUGS.has((requested ?? "").trim().toLowerCase());
}

/**
 * RF_04: que pasa exactamente al cambiar el nombre corto, como DATO.
 *
 * El requisito tiene dos mitades y la segunda es la que cuesta dinero: "...MUST rechazarlo,
 * explicar el motivo y MUST conservar el anterior". El enlace de registro es la unica puerta de
 * entrada de una tienda referida y el lider lo reparte impreso; un intento fallido de renombrar
 * que ademas se lleve el vigente mata esas altas en silencio.
 *
 * Por eso el rechazo no es un `throw` sino un plan sin escrituras: asi se puede afirmar sobre la
 * estructura ENTERA que no ordena nada, y la afirmacion sigue valiendo cuando alguien amplie el
 * plan manana. La callable solo traduce `writes`.
 *
 * Dos casos que la comprobacion vieja (`if (existe el documento) ya esta en uso`) hacia mal:
 *  - Volver a tu propio slug retirado: el documento existe treinta dias (RF_03), pero es TUYO.
 *  - Pedir el que ya tienes: no es un cambio, y tratarlo como tal retiraria el vigente contra si
 *    mismo, arrancando una cuenta atras de 30 dias sobre el unico enlace bueno que hay.
 */
export function planSlugChange(input: SlugChangeInput): SlugChangePlan {
  const { community, requestedSlug, takenByCommunityId, nowIso } = input;
  const previousSlug = community.slug && community.slug.trim() ? community.slug : null;
  const reject = (reasonCode: "invalid" | "reserved" | "taken", reason: string): SlugChangePlan => ({
    ok: false,
    reasonCode,
    reason,
    previousSlug,
    // El corazon de RF_04: tras el rechazo sigue vigente el de siempre, y nunca el pedido.
    effectiveSlug: previousSlug,
    writes: []
  });

  const normalized = normalizeSlug(requestedSlug);
  if (isReservedSlug(requestedSlug, normalized)) {
    return reject("reserved", "Ese nombre corto esta reservado por la plataforma. Elige otro.");
  }
  const validation = validateSlug(requestedSlug);
  if (!validation.ok) return reject("invalid", validation.reason);
  if (takenByCommunityId && takenByCommunityId !== community.id) {
    return reject("taken", "Ese nombre corto ya lo esta usando otra comunidad. Prueba con otro.");
  }

  const next = validation.slug;
  if (next === previousSlug) {
    return { ok: true, previousSlug, effectiveSlug: next, changed: false, writes: [] };
  }

  const writes: SlugWrite[] = [];
  if (previousSlug) {
    // RF_03: el anterior se RETIRA con fecha, no se borra. `merge` para no perder lo que ya tenga.
    writes.push({
      collection: "communitySlugs",
      docId: previousSlug,
      op: "merge",
      data: { communityId: community.id, retiredAt: nowIso }
    });
  }
  // `set` y no `merge`: recuperar un slug propio ya retirado tiene que quitarle el `retiredAt`, o
  // el enlace recien recuperado caducaria a los 30 dias de recuperarlo.
  writes.push({ collection: "communitySlugs", docId: next, op: "set", data: { communityId: community.id } });
  writes.push({ collection: "communities", docId: community.id, op: "update", data: { slug: next, updatedAt: nowIso } });

  return { ok: true, previousSlug, effectiveSlug: next, changed: true, writes };
}
