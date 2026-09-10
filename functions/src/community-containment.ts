/**
 * Contencion de un enlace de registro filtrado. SIN acceso a Firestore ni a Auth.
 *
 * El alta por enlace es automatica y sin tope (ver `community-signup-validate.ts`), asi que
 * cuando un enlace se difunde donde no debia el dano ya esta hecho cuando alguien se entera:
 * lo unico que queda es cerrar en bloque lo que entro por ahi. RF_41 es ese remedio y este
 * modulo es su nucleo, aparte de la callable, por la misma razon que
 * `order-corrections-plan.ts`: si el plan es puro, lo que se previsualiza y lo que se escribe
 * no pueden divergir, y una operacion que toca decenas de cuentas de golpe no se ensaya en
 * produccion.
 *
 * Devuelve `untouched` porque el modo de fallo peligroso aqui no es desactivar de mas, sino
 * de menos: un administrador que ve "18 tiendas desactivadas" da por contenida la fuga, y las
 * que se cayeron del filtro —sin fecha de ingreso, con la fecha escrita en otro huso, de otra
 * comunidad— siguen operando sin que nadie las cuente. Cada entrada sale por un lado o por el
 * otro, con el motivo, y ninguna desaparece en silencio.
 *
 * RF_42 acota el alcance a la tienda y a su acceso: el historial de dinero de esas cuentas se
 * queda donde esta. Por eso el plan no sabe nombrar ninguna otra coleccion.
 */

/** Los campos que escribe `community-signup.ts` al crear la tienda por enlace. */
export type BulkSignupDisableSeller = {
  id: string;
  communityId?: string;
  communityJoinedAt?: string;
  contactEmail?: string;
  debtBlockedAt?: string;
};

export type BulkSignupDisableSkipReason =
  | "other_community"
  | "out_of_range"
  | "no_join_date"
  | "invalid_join_date";

export type BulkSignupDisableAction = {
  sellerId: string;
  /** `null` cuando la tienda no tiene correo: su acceso no se puede ni buscar. */
  contactEmail: string | null;
  disableAuthUser: true;
  alreadyBlocked: boolean;
  sellerUpdate: { debtBlockedAt: string };
};

export type BulkSignupDisablePlan = {
  communityId: string;
  fromIso: string;
  toIso: string;
  collectionsTouched: readonly ["sellers", "authUsers"];
  disable: BulkSignupDisableAction[];
  untouched: { sellerId: string; reason: BulkSignupDisableSkipReason }[];
};

/** RF_42: el alcance entero del remedio, declarado para poder auditarlo. */
const COLLECTIONS_TOUCHED = ["sellers", "authUsers"] as const;

export function planBulkSignupDisable(input: {
  sellers: BulkSignupDisableSeller[];
  communityId: string;
  fromIso: string;
  toIso: string;
  nowIso: string;
}): BulkSignupDisablePlan {
  const { sellers, communityId, fromIso, toIso, nowIso } = input;

  // Instantes, no cadenas: la misma fecha escrita en hora de Cali o sin milisegundos ordena
  // distinto como texto, y de que huso uses no puede depender a quien alcanza la contencion.
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  // Un rango invertido o ilegible no alcanza a nadie: se prefiere no contener a contener mal.
  const rangeIsUsable = Number.isFinite(from) && Number.isFinite(to) && from <= to;

  const disable: BulkSignupDisableAction[] = [];
  const untouched: { sellerId: string; reason: BulkSignupDisableSkipReason }[] = [];
  const skip = (sellerId: string, reason: BulkSignupDisableSkipReason) => {
    untouched.push({ sellerId, reason });
  };

  for (const seller of sellers) {
    if (!seller.communityId || seller.communityId !== communityId) {
      skip(seller.id, "other_community");
      continue;
    }
    if (!seller.communityJoinedAt) {
      // Sin fecha de ingreso no se sabe por que enlace entro, y no se desactiva a ciegas.
      skip(seller.id, "no_join_date");
      continue;
    }
    const joinedAt = Date.parse(seller.communityJoinedAt);
    if (!Number.isFinite(joinedAt)) {
      skip(seller.id, "invalid_join_date");
      continue;
    }
    if (!rangeIsUsable || joinedAt < from || joinedAt > to) {
      skip(seller.id, "out_of_range");
      continue;
    }

    const contactEmail = seller.contactEmail?.trim();
    disable.push({
      sellerId: seller.id,
      contactEmail: contactEmail ? contactEmail : null,
      disableAuthUser: true,
      // El remedio se corre mas de una vez: una pasada anterior pudo sellar la tienda y dejar
      // vivo el acceso. Se vuelve a incluir, pero conservando el sello con el que se bloqueo.
      alreadyBlocked: Boolean(seller.debtBlockedAt),
      sellerUpdate: { debtBlockedAt: seller.debtBlockedAt ?? nowIso }
    });
  }

  return {
    communityId,
    fromIso,
    toIso,
    collectionsTouched: COLLECTIONS_TOUCHED,
    disable,
    untouched
  };
}

/**
 * Lo que Auth contesto por cada tienda planeada, EN CRUDO y sin interpretar.
 *
 * La distincion entre los cuatro casos es el remedio a un fallo mudo real: la callable hacia
 * `auth.getUsers([...]).catch(() => null)` y luego iteraba `users?.users ?? []`. Si la busqueda
 * lanzaba, o si el correo no correspondia a ningun usuario, la cuenta de Auth SEGUIA VIVA y aun
 * asi el `sellerId` se empujaba a `disabled`. El administrador leia "18 tiendas desactivadas",
 * daba por contenida la fuga, y habia cuentas que seguian entrando — y esta es la unica
 * contencion que la spec reconoce ante un enlace filtrado (RF_41).
 */
export type BulkSignupDisableAuthResult =
  /** `uids` son los accesos que `updateUser` cerro de verdad, no los que se encontraron. */
  | { kind: "disabled"; uids: string[] }
  /** `getUsers` respondio, y ningun usuario corresponde a ese correo. */
  | { kind: "not_found" }
  /** `getUsers` lanzo: no se sabe siquiera si hay cuenta que cerrar. */
  | { kind: "lookup_error" }
  /** `updateUser` lanzo: la cuenta existe y sigue abierta. */
  | { kind: "update_error" };

/**
 * Enumerado CERRADO, sin texto libre a proposito: el informe se barre con expresiones
 * regulares (RF_42) y el mensaje de una excepcion de Firebase podria nombrar cualquier cosa.
 */
export type BulkSignupDisableFailureReason =
  | "no_contact_email"
  | "auth_lookup_failed"
  | "no_auth_user"
  | "auth_update_failed"
  | "not_attempted";

export type BulkSignupDisableReport = {
  communityId: string;
  fromIso: string;
  toIso: string;
  collectionsTouched: readonly ["sellers", "authUsers"];
  /** Solo las que constan con al menos un acceso efectivamente cerrado. */
  disabled: { sellerId: string; authUids: string[] }[];
  failed: { sellerId: string; reason: BulkSignupDisableFailureReason }[];
  untouched: { sellerId: string; reason: BulkSignupDisableSkipReason }[];
  /** Las tiendas selladas en su documento: escritura propia, no depende de Auth. */
  blocked: string[];
};

/**
 * Reparte lo planeado entre lo que quedo contenido y lo que no.
 *
 * El veredicto NO lo pone quien llama: la callable entrega lo que Auth contesto y aqui se
 * decide. Por eso se itera el PLAN y no las respuestas — un resultado sobre una tienda que el
 * filtro dejo intacta se ignora (contener de mas es tan grave como contener de menos), y una
 * planeada sin respuesta no se da por buena.
 */
export function summarizeBulkSignupDisable(input: {
  plan: BulkSignupDisablePlan;
  authResults: { sellerId: string; result: BulkSignupDisableAuthResult }[];
}): BulkSignupDisableReport {
  const { plan, authResults } = input;

  const bySeller = new Map<string, BulkSignupDisableAuthResult>();
  // Si una tienda se intento mas de una vez, manda el ultimo intento: es el estado final.
  for (const entry of authResults) bySeller.set(entry.sellerId, entry.result);

  const disabled: { sellerId: string; authUids: string[] }[] = [];
  const failed: { sellerId: string; reason: BulkSignupDisableFailureReason }[] = [];
  const blocked: string[] = [];

  for (const action of plan.disable) {
    blocked.push(action.sellerId);

    if (action.contactEmail === null) {
      // Sin correo su acceso no se puede ni buscar. Aunque quien llame afirme un cierre, aqui
      // no se acepta: es el candado contra volver a inventar desactivaciones.
      failed.push({ sellerId: action.sellerId, reason: "no_contact_email" });
      continue;
    }

    const result = bySeller.get(action.sellerId);
    if (!result) {
      failed.push({ sellerId: action.sellerId, reason: "not_attempted" });
      continue;
    }

    if (result.kind === "lookup_error") {
      failed.push({ sellerId: action.sellerId, reason: "auth_lookup_failed" });
      continue;
    }
    if (result.kind === "update_error") {
      failed.push({ sellerId: action.sellerId, reason: "auth_update_failed" });
      continue;
    }
    if (result.kind === "not_found" || result.uids.length === 0) {
      // Cero accesos cerrados es cero contencion, se llame como se llame la respuesta.
      failed.push({ sellerId: action.sellerId, reason: "no_auth_user" });
      continue;
    }

    disabled.push({ sellerId: action.sellerId, authUids: [...result.uids] });
  }

  return {
    communityId: plan.communityId,
    fromIso: plan.fromIso,
    toIso: plan.toIso,
    collectionsTouched: COLLECTIONS_TOUCHED,
    disabled,
    failed,
    // Se arrastra literal: T31 existe para que ninguna tienda desaparezca en silencio.
    untouched: plan.untouched,
    blocked
  };
}

/**
 * RF_53: descartar el aviso de captacion masiva.
 *
 * Es un plan aparte y no un modo del anterior porque un lider que capta tiendas en un evento
 * dispara el aviso sin hacer nada malo: descartarlo no puede costarle los accesos de sus
 * tiendas. Este plan ni siquiera sabe nombrar la desactivacion.
 */
export type MassSignupAlertDismissalPlan = {
  communityId: string;
  collectionsTouched: readonly ["communities"];
  communityUpdate: { massSignupAlertDismissedAt: string };
};

const DISMISSAL_COLLECTIONS_TOUCHED = ["communities"] as const;

export function planMassSignupAlertDismissal(input: {
  communityId: string;
  nowIso: string;
}): MassSignupAlertDismissalPlan {
  return {
    communityId: input.communityId,
    collectionsTouched: DISMISSAL_COLLECTIONS_TOUCHED,
    communityUpdate: { massSignupAlertDismissedAt: input.nowIso }
  };
}
