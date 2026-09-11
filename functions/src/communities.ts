/**
 * Callables de administracion de comunidades.
 *
 * Aqui solo hay cableado: permisos, validacion con Zod, transacciones y auditoria. Toda la
 * decision vive en modulos puros —`community-access`, `community-pricing`, `community-slug`—
 * porque la raiz del repo no instala firebase-admin y lo que importe firebase-admin no se
 * puede probar con Vitest.
 *
 * Regla que gobierna este archivo: un lider de comunidad nunca toca dinero de la operacion
 * (pagos al lider logistico, al mensajero o costo de producto). Solo encarece lo que su
 * propia tienda le paga a el.
 */
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  canBulkDisableCommunitySignups,
  canCreateCommunityLeader,
  canEditCommunityBrand,
  canEditCommunityPricing,
  canSetCommunityLeaderStatus,
  canSetCommunityLinkStatus,
  canReassignSellerCommunity,
  isUnsetField,
  planLeaderStatusChange,
  planSellerReassignment,
  type Actor
} from "./community-access";
import {
  buildPriceHistoryEntry,
  buildStoreTariffView,
  COMMUNITY_PRICING_FIELDS,
  planLogoChange,
  planScheduledRaiseCancellation,
  scheduleEffectiveAt,
  type LogoWrite
} from "./community-pricing";
import { leaderEmailPrecheck, leaderRollbackPlan } from "./community-leader-create";
import { resolveTariffs } from "./wallet-entries";
import { isRetiredSlugStillValid, normalizeSlug, planSlugChange, validateSlug, type SlugWrite } from "./community-slug";
import {
  planBulkSignupDisable,
  planMassSignupAlertDismissal,
  summarizeBulkSignupDisable,
  type BulkSignupDisableAuthResult,
  type BulkSignupDisableSeller
} from "./community-containment";

const text = z.string().trim().min(1);

function actorFrom(request: { auth?: { uid: string; token: Record<string, unknown> } | null }): Actor {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesion.");
  return {
    uid: request.auth.uid,
    role: String(request.auth.token.role ?? ""),
    communityId: typeof request.auth.token.communityId === "string" ? request.auth.token.communityId : undefined,
    sellerId: typeof request.auth.token.sellerId === "string" ? request.auth.token.sellerId : undefined
  };
}

const createLeaderSchema = z.object({
  name: text,
  slug: text,
  leaderName: text,
  leaderEmail: z.string().trim().email(),
  leaderPhone: text,
  password: z.string().min(6)
});

/** RF_50: la figura del lider la crea un administrador. Nadie se da de alta como lider. */
export const createCommunityLeader = onCall(async (request) => {
  const actor = actorFrom(request);
  if (!canCreateCommunityLeader(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador crea lideres de comunidad.");
  }
  const parsed = createLeaderSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos de lider invalidos.", parsed.error.flatten());
  const input = parsed.data;

  const slug = validateSlug(input.slug);
  if (!slug.ok) throw new HttpsError("invalid-argument", slug.reason);

  const db = getFirestore();
  const auth = getAuth();
  const email = input.leaderEmail.toLowerCase();

  // RF_55, comprobacion previa: el fallo mas probable de esta callable es que el correo ya
  // tenga cuenta. Mirarlo ANTES de escribir nada evita el caso comun de comunidad fantasma.
  // `getUserByEmail` lanza `auth/user-not-found` cuando NO hay cuenta —ese es el caso bueno—;
  // cualquier otro codigo se propaga, porque tragarselo convertiria un fallo de Auth en un
  // "adelante" y volveriamos a escribir a ciegas.
  let existingUser: { uid: string } | undefined;
  try {
    existingUser = await auth.getUserByEmail(email);
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
  }
  const precheck = leaderEmailPrecheck(existingUser);
  if (!precheck.ok) throw new HttpsError(precheck.code, precheck.reason);

  const now = new Date().toISOString();
  const communityRef = db.collection("communities").doc(`com-${Date.now()}`);
  const slugRef = db.collection("communitySlugs").doc(slug.slug);

  // RF_55: o queda todo o no queda nada. Cada bandera se marca DESPUES de que su escritura
  // confirme; marcarla antes haria que el plan intentara borrar lo que no existe y —peor— que
  // no borrara lo que si.
  const state = { communityWritten: false, authUserCreated: false, roleAssigned: false };
  let uid = "";
  try {
    // El slug se reserva en la transaccion: dos administradores creando a la vez no pueden
    // quedarse con el mismo enlace.
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(slugRef);
      if (existing.exists) throw new HttpsError("already-exists", "Ese nombre corto ya esta en uso.");
      transaction.set(communityRef, {
        id: communityRef.id,
        name: input.name,
        slug: slug.slug,
        leaderName: input.leaderName,
        leaderEmail: email,
        leaderPhone: input.leaderPhone,
        linkStatus: "active",
        status: "active",
        pricing: {},
        createdAt: now,
        updatedAt: now
      });
      transaction.set(slugRef, { communityId: communityRef.id });
    });
    state.communityWritten = true;

    const user = await auth.createUser({
      email,
      password: input.password,
      displayName: input.leaderName
    });
    uid = user.uid;
    state.authUserCreated = true;

    await auth.setCustomUserClaims(uid, { role: "community_leader", communityId: communityRef.id });
    state.roleAssigned = true;
  } catch (error) {
    const plan = leaderRollbackPlan(state);
    // Orden inverso al de creacion, y el ENLACE antes que la comunidad: es la reserva la que
    // bloquea el reintento con el mismo nombre corto. Cada borrado va en su propio try: que
    // falle uno no puede impedir los demas, o la limpieza se queda a medias otra vez.
    if (plan.deleteAuthUser) {
      try {
        await auth.deleteUser(uid);
      } catch (cleanupError) {
        console.error("community_leader_rollback_auth_failed", { reason: plan.reason, uid, error: cleanupError });
      }
    }
    if (plan.deleteSlug) {
      try {
        await slugRef.delete();
      } catch (cleanupError) {
        console.error("community_leader_rollback_slug_failed", {
          reason: plan.reason,
          slug: slug.slug,
          error: cleanupError
        });
      }
    }
    if (plan.deleteCommunity) {
      try {
        await communityRef.delete();
      } catch (cleanupError) {
        console.error("community_leader_rollback_community_failed", {
          reason: plan.reason,
          communityId: communityRef.id,
          error: cleanupError
        });
      }
    }
    // El error ORIGINAL sale intacto: traducir el fallo aqui borraria el rastro del real.
    throw error;
  }

  return { communityId: communityRef.id, slug: slug.slug, uid };
});

/** RF_51: desactivar corta el acceso y NO toca comunidad, historial ni cashback pendiente. */
export const setCommunityLeaderStatus = onCall(async (request) => {
  const actor = actorFrom(request);
  if (!canSetCommunityLeaderStatus(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador activa o desactiva lideres.");
  }
  const parsed = z.object({ communityId: text, status: z.enum(["active", "disabled"]) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const ref = getFirestore().collection("communities").doc(parsed.data.communityId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
  const data = snap.data() ?? {};
  // La decision —y sobre todo el alcance— vive en el plan puro: asi se puede afirmar sobre la
  // operacion ENTERA que no alcanza al cashback pendiente ni al historial de precios.
  const plan = planLeaderStatusChange(
    { id: snap.id, status: typeof data.status === "string" ? data.status : undefined },
    parsed.data.status,
    new Date().toISOString()
  );
  if (plan.changed) await ref.update(plan.communityUpdate);
  return { ok: true, changed: plan.changed, previousStatus: plan.previousStatus };
});

/** RF_05, RF_06: revocar impide altas nuevas y no altera a las tiendas ya registradas. */
export const setCommunityLinkStatus = onCall(async (request) => {
  const actor = actorFrom(request);
  if (!canSetCommunityLinkStatus(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador revoca enlaces.");
  }
  const parsed = z.object({ communityId: text, linkStatus: z.enum(["active", "revoked"]) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  await getFirestore().collection("communities").doc(parsed.data.communityId).update({
    linkStatus: parsed.data.linkStatus,
    updatedAt: new Date().toISOString()
  });
  return { ok: true };
});

/**
 * Traduce el plan a la transaccion y nada mas: aqui no se decide que se escribe ni sobre que.
 * `merge` respeta lo que ya tenga el documento (retirar el slug viejo); `set` lo reemplaza
 * entero, que es lo que le quita el `retiredAt` a un slug propio recuperado.
 */
function applySlugWrites(
  db: ReturnType<typeof getFirestore>,
  transaction: FirebaseFirestore.Transaction,
  writes: readonly SlugWrite[]
): void {
  for (const write of writes) {
    const ref = db.collection(write.collection).doc(write.docId);
    if (write.op === "set") transaction.set(ref, write.data);
    else if (write.op === "merge") transaction.set(ref, write.data, { merge: true });
    else transaction.update(ref, write.data);
  }
}

/**
 * RF_03: cambiar el nombre corto no rompe los enlaces repartidos. El anterior se marca como
 * retirado y sigue admitiendo altas treinta dias.
 */
export const setCommunitySlug = onCall(async (request) => {
  const actor = actorFrom(request);
  const parsed = z.object({ communityId: text, slug: text }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  if (!canEditCommunityBrand(actor, parsed.data.communityId)) {
    throw new HttpsError("permission-denied", "No puedes cambiar el enlace de esta comunidad.");
  }
  const db = getFirestore();
  const now = new Date().toISOString();
  const communityRef = db.collection("communities").doc(parsed.data.communityId);
  // Solo para poder LEER de quien es el nombre pedido. Si no normaliza a nada no hay documento
  // que consultar y el plan lo rechaza igual: `doc("")` seria un error de Firestore, no un juicio.
  const normalized = normalizeSlug(parsed.data.slug);
  const nextSlugRef = normalized ? db.collection("communitySlugs").doc(normalized) : null;

  let effectiveSlug = "";
  let changed = false;
  await db.runTransaction(async (transaction) => {
    const [communitySnap, nextSnap] = await Promise.all([
      transaction.get(communityRef),
      nextSlugRef ? transaction.get(nextSlugRef) : Promise.resolve(null)
    ]);
    if (!communitySnap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
    const current = communitySnap.data()?.slug;
    const owner = nextSnap?.exists ? nextSnap.data()?.communityId : null;

    // Quien decide es el plan, y decide con DATOS: de quien es el documento, no si existe. Un
    // slug retirado sobrevive 30 dias (RF_03), asi que "existe" no significa "es de otro" — y
    // rechazar por eso le impedia al lider volver a su propio enlace anterior.
    const plan = planSlugChange({
      community: { id: communityRef.id, slug: typeof current === "string" ? current : undefined },
      requestedSlug: parsed.data.slug,
      takenByCommunityId: typeof owner === "string" ? owner : null,
      nowIso: now
    });
    // RF_04: se sale ANTES de tocar nada, y el nombre corto anterior sigue vigente. Que eso sea
    // cierto no depende ya de donde este este `throw`: el plan rechazado no trae escrituras.
    if (!plan.ok) {
      throw new HttpsError(plan.reasonCode === "taken" ? "already-exists" : "invalid-argument", plan.reason);
    }
    applySlugWrites(db, transaction, plan.writes);
    effectiveSlug = plan.effectiveSlug;
    changed = plan.changed;
  });
  return { slug: effectiveSlug, changed };
});

/** Traduce el plan del logo. Un solo campo de destino, y ninguna decision aqui. */
async function applyLogoWrites(
  db: ReturnType<typeof getFirestore>,
  writes: readonly LogoWrite[]
): Promise<void> {
  for (const write of writes) {
    await db.collection(write.collection).doc(write.docId).update(write.data);
  }
}

/** RF_16: un logo fuera de formato o de tamano se rechaza y se conserva el anterior. */
export const setCommunityLogo = onCall(async (request) => {
  const actor = actorFrom(request);
  const parsed = z
    .object({
      communityId: text,
      logoPath: text,
      contentType: text,
      sizeBytes: z.number().int().positive()
    })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  if (!canEditCommunityBrand(actor, parsed.data.communityId)) {
    throw new HttpsError("permission-denied", "No puedes cambiar la marca de esta comunidad.");
  }
  const db = getFirestore();
  const ref = db.collection("communities").doc(parsed.data.communityId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
  const currentLogoPath = snap.data()?.logoPath;

  // Una sola definicion de los limites y de que se escribe, la que esta probada.
  const plan = planLogoChange({
    community: { id: ref.id, logoPath: typeof currentLogoPath === "string" ? currentLogoPath : undefined },
    file: {
      logoPath: parsed.data.logoPath,
      contentType: parsed.data.contentType,
      sizeBytes: parsed.data.sizeBytes
    },
    nowIso: new Date().toISOString()
  });
  // RF_16: el rechazo no llega a Firestore, y ya no por donde este el `throw` sino porque el plan
  // rechazado viene sin escrituras. El logo anterior —y con el la marca de RF_14— se queda.
  if (!plan.ok) throw new HttpsError("invalid-argument", plan.reason);
  await applyLogoWrites(db, plan.writes);
  return { ok: true, changed: plan.changed, logoPath: plan.effectiveLogoPath };
});

const priceSchema = z.object({
  communityId: text,
  field: z.enum(COMMUNITY_PRICING_FIELDS),
  amountCop: z.number().int().nonnegative()
});

/**
 * RF_18, RF_19, RF_28, RF_38, RF_39, RF_54.
 *
 * El piso que se valida aqui es la base GLOBAL, que es la unica cifra estable en el momento de
 * programar. El piso real de cada pedido es la base efectiva de su zona y actua al congelar:
 * si la zona es mas cara, ese pedido no genera cashback y el panel lo cuenta aparte, para que
 * el lider vea por que no cobro en vez de ver menos dinero sin explicacion.
 */
export const scheduleCommunityPrice = onCall(async (request) => {
  const actor = actorFrom(request);
  const parsed = priceSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos de precio invalidos.");
  const { communityId, field, amountCop } = parsed.data;
  if (!canEditCommunityPricing(actor, communityId)) {
    throw new HttpsError("permission-denied", "Solo el lider fija los precios de su comunidad.");
  }

  const db = getFirestore();
  const now = new Date().toISOString();
  const settingsSnap = await db.collection("settings").doc("global").get();
  const floor = Number(settingsSnap.data()?.[field]) || 0;
  if (amountCop < floor) {
    throw new HttpsError("invalid-argument", `El minimo para este concepto es ${floor}.`);
  }

  const communityRef = db.collection("communities").doc(communityId);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(communityRef);
    if (!snap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
    const data = snap.data() ?? {};
    const currentCop = Number(data.pricing?.[field]) || floor;
    const effectiveAt = scheduleEffectiveAt(currentCop, amountCop, now);

    if (effectiveAt === now) {
      // Bajada: entra ya. No hay nada que programar.
      transaction.update(communityRef, {
        [`pricing.${field}`]: amountCop,
        [`scheduled.${field}`]: FieldValue.delete(),
        updatedAt: now
      });
    } else {
      // Subida: se programa y reemplaza cualquier otra del mismo concepto (RF_54).
      transaction.update(communityRef, {
        [`scheduled.${field}`]: {
          field,
          fromCop: currentCop,
          toCop: amountCop,
          effectiveAt,
          scheduledBy: actor.uid,
          scheduledAt: now
        },
        updatedAt: now
      });
    }

    transaction.set(
      communityRef.collection("priceHistory").doc(),
      buildPriceHistoryEntry({ field, fromCop: currentCop, toCop: amountCop, nowIso: now, actorUid: actor.uid, actorRole: actor.role })
    );
  });

  return { field, amountCop };
});

/** RF_40: una subida programada se puede cancelar antes de que entre en vigor. */
export const cancelScheduledCommunityPrice = onCall(async (request) => {
  const actor = actorFrom(request);
  const parsed = z.object({ communityId: text, field: z.enum(COMMUNITY_PRICING_FIELDS) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  if (!canEditCommunityPricing(actor, parsed.data.communityId)) {
    throw new HttpsError("permission-denied", "Solo el lider cambia los precios de su comunidad.");
  }
  const { communityId, field } = parsed.data;
  const ref = getFirestore().collection("communities").doc(communityId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
  const now = new Date().toISOString();
  // El reloj lo mira el planificador. Borrar sin mirarlo no cancelaba nada pasada la fecha:
  // bajaba el precio vigente en silencio, porque la programada nunca se escribe en `pricing`.
  const plan = planScheduledRaiseCancellation({ id: communityId, ...snap.data() }, field, now);
  if (!plan.ok) throw new HttpsError("failed-precondition", plan.reason);

  await ref.update({
    [`scheduled.${plan.field}`]: FieldValue.delete(),
    updatedAt: now
  });
  return { ok: true };
});

/**
 * RF_35 lo hace ahora `onSettingsFloorRaise` (`community-floor-trigger.ts`), sobre el plan puro
 * `planFloorRaise`. Aqui vivia `raiseCommunityPricesToFloor`, una callable que hacia lo mismo y
 * a la que no llamaba nadie —ni el cliente ni el servidor—: la tarifa base la escribe el
 * navegador directo a `settings/app`, asi que una elevacion que hay que invocar a mano no se
 * invoca nunca. Se retira porque duplicaba el criterio de piso, y dos copias de esa regla acaban
 * diciendo cosas distintas: la vieja comparaba contra el `pricing` LITERAL y no contra el precio
 * vigente, asi que una subida programada ya vencida le dejaba un `fromCop` rancio en el
 * historial; tampoco quitaba las programadas que el piso nuevo deja sin sentido, que es como una
 * subida revivia sola sin los ocho dias de aviso de RF_28.
 *
 * El historial que ESCRIBIO no se reescribe ni se corrige. Sus entradas llevan una `note` y van
 * firmadas con el uid del administrador que la invoco, mientras que las del trigger firman
 * `system:floor`; esa diferencia es exacta y hay que conservarla, porque cuenta lo que de verdad
 * paso: entonces la elevacion la lanzo una persona. Un historial de precios que se reescribe
 * para que quede uniforme deja de ser historial.
 */

/** RF_53: el aviso de captacion masiva se descarta sin desactivar a nadie. */
export const dismissMassSignupAlert = onCall(async (request) => {
  const actor = actorFrom(request);
  if (actor.role !== "admin") throw new HttpsError("permission-denied", "Solo un administrador.");
  const parsed = z.object({ communityId: text }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const plan = planMassSignupAlertDismissal({
    communityId: parsed.data.communityId,
    nowIso: new Date().toISOString()
  });
  await getFirestore().collection("communities").doc(plan.communityId).update(plan.communityUpdate);
  return { ok: true };
});

/** Solo los campos que el nucleo puro necesita: nada de volcar el documento entero. */
function containmentSellerFrom(doc: {
  id: string;
  data: () => Record<string, unknown> | undefined;
}): BulkSignupDisableSeller {
  const data = doc.data() ?? {};
  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return {
    id: doc.id,
    communityId: str(data.communityId),
    communityJoinedAt: str(data.communityJoinedAt),
    contactEmail: str(data.contactEmail),
    debtBlockedAt: str(data.debtBlockedAt)
  };
}

/**
 * Cierra el acceso de una tienda y contesta EN CRUDO que paso, sin interpretarlo.
 *
 * Lo que sustituye es un `.catch(() => null)` que se tragaba el fallo de la busqueda: si
 * `getUsers` lanzaba o no habia usuario, la cuenta de Auth seguia viva y la tienda se
 * reportaba igual como desactivada. Aqui cada desenlace tiene nombre y `uids` acumula solo
 * los accesos que `updateUser` cerro de verdad.
 */
async function disableAuthAccess(
  auth: ReturnType<typeof getAuth>,
  email: string
): Promise<BulkSignupDisableAuthResult> {
  let users: Awaited<ReturnType<typeof auth.getUsers>>;
  try {
    users = await auth.getUsers([{ email }]);
  } catch {
    return { kind: "lookup_error" };
  }
  if (users.users.length === 0) return { kind: "not_found" };

  const uids: string[] = [];
  for (const user of users.users) {
    try {
      await auth.updateUser(user.uid, { disabled: true });
    } catch {
      // Buscar por correo devuelve como mucho una cuenta, asi que esto es el caso entero:
      // la cuenta existe y sigue abierta. Un cierre parcial no se reporta como cierre.
      return { kind: "update_error" };
    }
    uids.push(user.uid);
  }
  return { kind: "disabled", uids };
}

/**
 * RF_41, RF_42: sin tope automatico de altas, esta es la unica contencion ante un enlace
 * filtrado. Desactiva accesos; NO borra pedidos ni historial de dinero.
 *
 * La decision entera vive en `community-containment.ts` y aqui solo queda leer, ejecutar y
 * pasar por el nucleo lo que Auth conteste. Dos motivos, los dos por fallos de esta callable:
 *
 * 1. El instante se toma UNA vez. Antes se llamaba a `new Date()` dentro del bucle, asi que
 *    cada tienda quedaba sellada con un milisegundo distinto y la misma operacion no tenia
 *    fecha con la que auditarse.
 * 2. Quien decide quien quedo desactivado es el informe, no este bucle. El sello del documento
 *    va SIEMPRE —es escritura propia—, pero un bloqueo escrito no es un acceso cerrado.
 */
export const disableCommunitySignupsInRange = onCall(async (request) => {
  const actor = actorFrom(request);
  const parsed = z
    .object({ communityId: text, fromIso: text, toIso: text })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const { communityId, fromIso, toIso } = parsed.data;
  // Por el predicado probado y no por un `role !== "admin"` suelto: la interfaz decide con este
  // mismo, y dos caminos distintos para el mismo permiso acaban diciendo cosas distintas.
  if (!canBulkDisableCommunitySignups(actor, communityId)) {
    throw new HttpsError("permission-denied", "Solo un administrador.");
  }

  const db = getFirestore();
  const auth = getAuth();
  const snap = await db
    .collection("sellers")
    .where("communityId", "==", communityId)
    .where("communityJoinedAt", ">=", fromIso)
    .where("communityJoinedAt", "<=", toIso)
    .get();

  const plan = planBulkSignupDisable({
    sellers: snap.docs.map(containmentSellerFrom),
    communityId,
    fromIso,
    toIso,
    nowIso: new Date().toISOString()
  });

  const authResults: { sellerId: string; result: BulkSignupDisableAuthResult }[] = [];
  for (const action of plan.disable) {
    await db.collection("sellers").doc(action.sellerId).update(action.sellerUpdate);
    // Sin correo el acceso no se puede ni buscar: no se intenta, y el informe lo cuenta fallido.
    if (action.contactEmail === null) continue;
    authResults.push({
      sellerId: action.sellerId,
      result: await disableAuthAccess(auth, action.contactEmail)
    });
  }

  return summarizeBulkSignupDisable({ plan, authResults });
});

/** RF_11: cambiar de comunidad no lo decide ni la tienda ni el lider. */
export const reassignSellerCommunity = onCall(async (request) => {
  const actor = actorFrom(request);
  if (!canReassignSellerCommunity(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador reasigna tiendas.");
  }
  const parsed = z.object({ sellerId: text, communityId: z.string().trim().optional() }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const ref = getFirestore().collection("sellers").doc(parsed.data.sellerId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La tienda no existe.");
  const data = snap.data() ?? {};
  // El cashback ya causado se queda con el lider que lo causo. Eso ya no es un comentario:
  // el plan declara su alcance completo (`sellers`) y esta probado sobre la estructura entera.
  const plan = planSellerReassignment(
    { id: snap.id, communityId: typeof data.communityId === "string" ? data.communityId : undefined },
    parsed.data.communityId,
    new Date().toISOString()
  );
  if (plan.changed) {
    // La unica traduccion del marcador, y el unico punto donde `FieldValue` toca esta operacion.
    await ref.update(
      Object.fromEntries(
        Object.entries(plan.sellerUpdate).map(([key, value]) => [key, isUnsetField(value) ? FieldValue.delete() : value])
      )
    );
  }
  return { ok: true, changed: plan.changed, previousCommunityId: plan.previousCommunityId };
});

/** Reexportado para que `community-signup` no duplique la regla de vigencia del slug. */
export { isRetiredSlugStillValid };

/**
 * RNF_04: la tienda consulta su tarifa cuando quiera, y ve la subida programada con su fecha.
 *
 * Va por callable y no por lectura directa porque las reglas no le dejan leer la comunidad
 * —ahi estan tambien los datos del lider y su cashback—, pero su propio precio SI es suyo.
 * Ninguna tienda debe descubrir su tarifa al recibir el cobro.
 */
export const getMyStoreTariff = onCall(async (request) => {
  const actor = actorFrom(request);
  if (actor.role !== "seller" && actor.role !== "seller_logistics") {
    throw new HttpsError("permission-denied", "Solo una tienda consulta su propia tarifa.");
  }
  if (!actor.sellerId) throw new HttpsError("failed-precondition", "Tu cuenta no tiene tienda asociada.");

  const db = getFirestore();
  const now = new Date().toISOString();
  const [sellerSnap, settingsSnap] = await Promise.all([
    db.collection("sellers").doc(actor.sellerId).get(),
    db.collection("settings").doc("global").get()
  ]);
  const base = resolveTariffs(settingsSnap.data() ?? {}, undefined);
  const communityId = typeof sellerSnap.data()?.communityId === "string" ? String(sellerSnap.data()?.communityId) : "";
  // Sin comunidad tambien pasa por la funcion pura: la respuesta tiene que tener la MISMA forma
  // con comunidad y sin ella. Devolver `base` tal cual le filtraba a la tienda lo que se le paga
  // al mensajero, que no es tarifa de nadie.
  if (!communityId) {
    return buildStoreTariffView(base, undefined, now);
  }

  const communitySnap = await db.collection("communities").doc(communityId).get();
  const community = communitySnap.data() ?? {};
  return buildStoreTariffView(base, { id: communityId, ...community }, now);
});
