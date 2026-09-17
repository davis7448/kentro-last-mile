/**
 * RF_55: crear un lider de comunidad es TODO o NADA.
 *
 * El alta del lider (`createCommunityLeader`, en `communities.ts`) escribe en dos sistemas que
 * no comparten transaccion: primero Firestore —la comunidad Y la reserva del nombre corto, en
 * una sola transaccion— y despues Auth —la cuenta y su rol—. Entre medias puede reventar, y
 * cada mitad que sobrevive sola hace dano por su cuenta:
 *
 *   - Comunidad sin cuenta: queda una COMUNIDAD FANTASMA con el enlace reservado. El reintento
 *     con el mismo nombre corto responde "ese nombre corto ya esta en uso" senalando a la
 *     basura que dejo el intento anterior, asi que el administrador se queda sin salida.
 *   - Cuenta sin rol: la persona INICIA SESION y la app no sabe que es. Y el correo queda
 *     ocupado, asi que tampoco se puede reintentar.
 *
 * Este modulo es el hermano de `signupRollbackPlan` (RF_45) para este camino, que va al reves:
 * alli Auth iba primero, aqui Firestore. Solo DESCRIBE lo que hay que deshacer; quien borra es
 * la callable. Por eso no importa `firebase-admin` ni `firebase-functions`: asi se puede probar
 * la aritmetica entera con Vitest desde la raiz del repo.
 */

export type LeaderCreationState = {
  /** La transaccion commiteo: hay comunidad Y hay enlace reservado. Las dos o ninguna. */
  communityWritten: boolean;
  /** `auth.createUser` devolvio un uid. */
  authUserCreated: boolean;
  /** `auth.setCustomUserClaims` termino: la cuenta ya tiene `role` y `communityId`. */
  roleAssigned: boolean;
};

export type LeaderRollbackPlan = {
  deleteCommunity: boolean;
  /** Va SIEMPRE emparejado con `deleteCommunity`: ver la nota de abajo. */
  deleteSlug: boolean;
  deleteAuthUser: boolean;
  /** Acaba en los registros. No vacia exactamente cuando se borra algo. */
  reason: string;
};

/**
 * `deleteSlug` no es una decision aparte: la comunidad y su reserva de nombre corto se
 * escriben en la misma transaccion, asi que se deshacen juntas. Borrar `communities` y dejar
 * el documento de `communitySlugs` es la MITAD del fallo original —el reintento vuelve a
 * chocar con "ya esta en uso", ahora contra una reserva que no apunta a ninguna comunidad—.
 *
 * El estado incoherente (cuenta creada sin comunidad escrita) no se da con el orden actual,
 * pero se limpia igual: si alguien invierte los pasos, el plan no puede responder "no hay nada
 * que hacer" ante una cuenta huerfana.
 */
export function leaderRollbackPlan(state: LeaderCreationState): LeaderRollbackPlan {
  const altaCompleta = state.communityWritten && state.authUserCreated && state.roleAssigned;
  const deleteCommunity = state.communityWritten && !altaCompleta;
  const deleteSlug = deleteCommunity;
  const deleteAuthUser = state.authUserCreated && !altaCompleta;

  return { deleteCommunity, deleteSlug, deleteAuthUser, reason: rollbackReason(state, { deleteCommunity, deleteAuthUser }) };
}

function rollbackReason(
  state: LeaderCreationState,
  borrado: { deleteCommunity: boolean; deleteAuthUser: boolean }
): string {
  if (borrado.deleteCommunity && borrado.deleteAuthUser) {
    return state.roleAssigned
      ? "El alta del lider quedo a medias: se borran la cuenta, el enlace y la comunidad."
      : "La cuenta del lider quedo sin rol: se borran la cuenta, el enlace y la comunidad para poder reintentar.";
  }
  if (borrado.deleteCommunity) {
    return "La cuenta del lider no se pudo crear: se borran la comunidad y su enlace para que el nombre corto quede libre.";
  }
  if (borrado.deleteAuthUser) {
    return "La comunidad no quedo escrita: se borra la cuenta para que el correo quede libre.";
  }
  return "";
}

export type LeaderEmailPrecheck = { ok: true } | { ok: false; code: "already-exists"; reason: string };

/**
 * La comprobacion previa (SHOULD de RF_55): se mira si el correo ya tiene cuenta ANTES de
 * escribir nada, porque `auth/email-already-exists` es el fallo mas probable de esta callable
 * y asi ni siquiera se llega a la transaccion.
 *
 * NO sustituye a la reversion: dos administradores a la vez pasan los dos la comprobacion con
 * el mismo correo, y a uno le revienta `createUser` con la transaccion ya commiteada.
 *
 * Devuelve una DESCRIPCION, no un `HttpsError`: la callable lo construye con `code` y `reason`.
 * Y el motivo se REDACTA aqui, sin el uid ni ningun otro dato de la cuenta ajena, que quien
 * pregunta no tiene por que conocer.
 */
export function leaderEmailPrecheck(existing: { uid: string } | undefined): LeaderEmailPrecheck {
  if (!existing) return { ok: true };
  return {
    ok: false,
    code: "already-exists",
    reason: "Ese correo ya tiene una cuenta. Usa otro correo para el lider."
  };
}
