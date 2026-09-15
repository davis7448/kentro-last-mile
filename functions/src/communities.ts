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
  validateCommunityPriceFloor,
  COMMUNITY_PRICING_FIELDS,
  planLogoChange,
  planScheduledRaiseCancellation,
  scheduleEffectiveAt,
  type LogoWrite
} from "./community-pricing";
import { leaderEmailPrecheck, leaderRollbackPlan } from "./community-leader-create";
import { planLeadershipGrant, planLeadershipRevoke } from "./community-grant";
import { communityBase, resolveTariffs } from "./seller-charges";
import { isRetiredSlugStillValid, normalizeSlug, planSlugChange, validateSlug, type SlugWrite } from "./community-slug";
import {
  planBulkSignupDisable,
  planMassSignupAlertDismissal,
  summarizeBulkSignupDisable,
  type BulkSignupDisableAuthResult,
  type BulkSignupDisableSeller
} from "./community-containment";

const text = z.string().trim().min(1);

/**
 * El actor sale de los RECLAMOS y de ningun otro sitio (RNF_02): nada de leerlo del cuerpo de la
 * peticion ni de un selector de la interfaz, o un retirado volveria a gobernar cambiando de
 * pestana.
 *
 * La posicion se compara contra `"creditor"` LITERAL en vez de hacer un `as CommunityStanding`
 * sobre el token, y la diferencia es la que importa: asi solo el retiro explicito se reconoce, y
 * cualquier otra cosa —basura, ausencia, o un tercer valor que alguien invente manana— cae en
 * `undefined`, que el nucleo lee como `leader`. Con el `as` pasaria sin ruido un `"leader"`
 * escrito a mano en un reclamo, y esa es precisamente la via para devolverse el mando.
 */
export function actorFrom(request: { auth?: { uid: string; token: Record<string, unknown> } | null }): Actor {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesion.");
  return {
    uid: request.auth.uid,
    role: String(request.auth.token.role ?? ""),
    communityId: typeof request.auth.token.communityId === "string" ? request.auth.token.communityId : undefined,
    communityStanding: request.auth.token.communityStanding === "creditor" ? "creditor" : undefined,
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

    // RF_18: quien lidera lo dice el DOCUMENTO, que es el unico sitio donde ese hecho es unico
    // (lo leen `planLeadershipGrant` y `planLeadershipRevoke`). Una comunidad recien creada sin
    // `leaderUid` no tendria lider para ellos, asi que la primera concesion a otra cuenta se
    // veria como un alta limpia y NO degradaria a este: dos lideres vivos.
    //
    // Va entre `authUserCreated` y `roleAssigned` a proposito. Despues de `state.roleAssigned`
    // el alta ya esta completa para `leaderRollbackPlan`, que entonces no borraria nada: un
    // fallo aqui dejaria la comunidad escrita y sin `leaderUid`, que es justo el estado que
    // este `update` existe para evitar.
    await communityRef.update({ leaderUid: uid, leaderGrantedAt: now, updatedAt: now });

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

/* ------------------------------------------------------------------------------------------- *
 * RF_17, RF_05, RF_23: conceder y retirar el mando de una comunidad.
 *
 * Las dos callables son CABLEADO. Quien decide es `community-grant.ts`, que es puro y esta
 * probado desde la raiz; aqui solo se lee el estado, se traduce el plan a escrituras y se
 * deshace lo escrito si algo revienta a mitad.
 * ------------------------------------------------------------------------------------------- */

/** Traduce el marcador a Firestore. El unico punto donde `FieldValue` toca estas operaciones. */
function withDeletions(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).map(([key, value]) => [key, isUnsetField(value) ? FieldValue.delete() : value])
  );
}

/**
 * Lee la cuenta destino y devuelve sus reclamos. Si no existe se contesta `not-found` en vez de
 * dejar salir el `auth/user-not-found` crudo, que en una callable llega al cliente como
 * `internal` y no dice que fue lo que no se encontro.
 */
async function claimsOf(auth: ReturnType<typeof getAuth>, uid: string): Promise<Record<string, unknown>> {
  try {
    const user = await auth.getUser(uid);
    return user.customClaims ?? {};
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") {
      throw new HttpsError("not-found", "Esa cuenta no existe.");
    }
    throw error;
  }
}

/**
 * Aplica un PARCHE de reclamos sobre los que la cuenta tiene AHORA MISMO, y devuelve los de
 * antes para poder deshacerlo.
 *
 * `setCustomUserClaims` REEMPLAZA: lo que no vaya en la llamada desaparece. Por eso se leen
 * justo antes de escribir y el parche se aplica encima. Esto —y nada mas que esto— es lo que
 * conserva `sellerId`, `driverId` y `messengerId` de la cuenta: el plan ni los nombra, asi que
 * no hay forma de olvidarse de copiarlos.
 *
 * La lectura va aqui dentro, y no se reusa la que hizo el planificador, porque entre una y otra
 * la cuenta pudo cambiar (otra callable, otro administrador): partir de reclamos rancios los
 * revertiria sin que nadie lo pidiera.
 */
async function applyClaimsPatch(
  auth: ReturnType<typeof getAuth>,
  uid: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const current = await claimsOf(auth, uid);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsetField(value)) delete next[key];
    else next[key] = value;
  }
  await auth.setCustomUserClaims(uid, next);
  return current;
}

type UndoStep = { label: string; run: () => Promise<void> };

/**
 * RF_55, aplicado a este camino: lo que se escribio a medias se deshace en ORDEN INVERSO, cada
 * paso en su propio `try` —que falle uno no puede impedir los demas— y el error ORIGINAL sale
 * intacto, porque traducirlo aqui borraria el rastro del real.
 */
async function undoAll(steps: readonly UndoStep[], event: string, reason: string): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (undoError) {
      console.error(event, { step: step.label, reason, error: undoError });
    }
  }
}

/**
 * RF_17: los DOS caminos caben en el mismo esquema, y cada par de campos es excluyente.
 *
 *  - La comunidad: o `communityId` (ya existe) o `name` + `slug` (se crea en el mismo acto).
 *  - La cuenta: o `targetUid` o `targetEmail`.
 *
 * Los cuatro campos son opcionales para Zod y obligatorios de a pares para la callable, que
 * rechaza explicitamente "las dos cosas a la vez" y "ninguna de las dos". Un esquema que
 * aceptara ambas dejaria la ambiguedad viva hasta el momento de escribir: con `communityId` Y
 * `name`, "cual manda" seria una decision del orden de los `if`, y la mitad de las veces se
 * crearia una comunidad que ya existia.
 */
const grantLeadershipSchema = z.object({
  communityId: text.optional(),
  name: text.optional(),
  slug: text.optional(),
  targetUid: text.optional(),
  targetEmail: z.string().trim().email().optional()
});

/** La cuenta destino, ya resuelta: quien administra conoce el correo, casi nunca el uid. */
type GrantTarget = { uid: string; email: string; displayName: string; claims: Record<string, unknown> };

/**
 * RF_17: encuentra la cuenta a la que se le va a conceder el mando, por uid o por correo.
 *
 * El correo existe porque es el caso REAL que dejo el camino cerrado: un administrador intento
 * crear un lider con el correo de una cuenta que ya era tienda, la precomprobacion de RF_55 lo
 * rechazo bien, y despues no habia forma de darle el liderazgo a esa cuenta. Quien administra
 * tiene el correo delante; el uid hay que ir a buscarlo a la consola de Firebase.
 *
 * Se busca en MINUSCULAS porque asi lo guarda Auth: con lo tecleado tal cual, una cuenta que si
 * existe se contestaria como inexistente.
 *
 * Y cuando no hay cuenta, el motivo DICE que hay que crearla primero. Esta callable no crea
 * cuentas a proposito —para eso esta `createCommunityLeader`, que ademas pone contrasena— y un
 * "no existe" a secas deja al administrador sin saber cual de los dos caminos le toca.
 */
async function resolveGrantTarget(
  auth: ReturnType<typeof getAuth>,
  input: { targetUid?: string; targetEmail?: string }
): Promise<GrantTarget> {
  const uid = (input.targetUid ?? "").trim();
  const email = (input.targetEmail ?? "").trim().toLowerCase();
  if (uid && email) {
    throw new HttpsError("invalid-argument", "Indica la cuenta por uid o por correo, no por las dos cosas.");
  }
  if (!uid && !email) {
    throw new HttpsError("invalid-argument", "Indica a que cuenta se le concede el liderazgo: uid o correo.");
  }

  try {
    const user = uid ? await auth.getUser(uid) : await auth.getUserByEmail(email);
    return {
      uid: user.uid,
      email: (user.email ?? "").toLowerCase(),
      displayName: user.displayName ?? "",
      // Se leen aqui solo para PLANIFICAR. Quien escribe reclamos es `applyClaimsPatch`, que
      // vuelve a leerlos justo antes de escribir: entre una lectura y otra la cuenta pudo
      // cambiar, y partir de reclamos rancios los revertiria sin que nadie lo pidiera.
      claims: user.customClaims ?? {}
    };
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") {
      throw new HttpsError(
        "not-found",
        email
          ? `No hay ninguna cuenta con el correo ${email}. Crea primero la cuenta y despues concedele el liderazgo.`
          : "Esa cuenta no existe."
      );
    }
    throw error;
  }
}

/**
 * RF_04, RF_17, RF_18, RF_19: conceder el liderazgo de una comunidad a una cuenta que YA opera
 * en la plataforma. Traspasar no es otra callable: es el caso en que la comunidad ya tenia
 * lider, y sale del mismo plan.
 *
 * RF_17 pide DOS caminos y aqui estan los dos:
 *
 *  - Sobre una comunidad que ya existe (`communityId`).
 *  - Creandola en el mismo acto (`name` + `slug`), que es el unico camino posible cuando no hay
 *    ninguna comunidad todavia. Antes no estaba, y con cero comunidades el mando no se podia
 *    conceder por ningun lado: `createCommunityLeader` exige abrir una cuenta nueva —y falla,
 *    bien, si el correo ya tiene una— y esto exigia una comunidad previa que nadie podia crear.
 *
 * La comunidad nueva se escribe DENTRO de la misma transaccion que reserva su nombre corto,
 * copiado de `createCommunityLeader`: dos administradores concediendo a la vez no pueden quedarse
 * con el mismo enlace, y una comunidad sin reserva es una comunidad cuyo enlace de alta no
 * existe (la fantasma de RF_55, con agravante). Nace SIN `leaderUid`: se lo pone el
 * `communityUpdate` del plan al final, que es el unico sitio donde se decide quien lidera.
 */
export const grantCommunityLeadership = onCall(async (request) => {
  const actor = actorFrom(request);
  // Por el predicado probado y no por un `role !== "admin"` suelto: conceder el mando es el
  // mismo permiso que crear al lider, y dos caminos para el mismo permiso acaban divergiendo.
  if (!canCreateCommunityLeader(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador concede el liderazgo de una comunidad.");
  }
  const parsed = grantLeadershipSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const input = parsed.data;

  const sobreUnaQueExiste = Boolean(input.communityId);
  const pideCrearla = Boolean(input.name || input.slug);
  if (sobreUnaQueExiste && pideCrearla) {
    throw new HttpsError(
      "invalid-argument",
      "Indica una comunidad que ya existe o los datos de una nueva, no las dos cosas."
    );
  }
  if (!sobreUnaQueExiste && !pideCrearla) {
    throw new HttpsError("invalid-argument", "Indica que comunidad se concede: su id, o su nombre y nombre corto.");
  }
  // Media comunidad nueva no es ninguna: sin nombre corto no hay enlace que reservar, y sin
  // nombre la lista del administrador la pintaria como "Comunidad com-1730000000000".
  if (pideCrearla && !(input.name && input.slug)) {
    throw new HttpsError("invalid-argument", "Una comunidad nueva necesita nombre y nombre corto.");
  }

  const db = getFirestore();
  const auth = getAuth();
  const target = await resolveGrantTarget(auth, input);

  const communityRef = db.collection("communities").doc(input.communityId ?? `com-${Date.now()}`);
  let leaderUidActual: string | undefined;
  let nueva: { name: string; slug: string; slugRef: typeof communityRef } | null = null;
  if (sobreUnaQueExiste) {
    const communitySnap = await communityRef.get();
    if (!communitySnap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
    const community = communitySnap.data() ?? {};
    leaderUidActual = typeof community.leaderUid === "string" ? community.leaderUid : undefined;
  } else {
    // La MISMA regla del enlace que el alta, y del mismo sitio: `validateSlug`. Aceptar aqui un
    // nombre corto que aquel rechaza produciria enlaces de invitacion que no resuelven.
    const slug = validateSlug(input.slug ?? "");
    if (!slug.ok) throw new HttpsError("invalid-argument", slug.reason);
    nueva = { name: input.name ?? "", slug: slug.slug, slugRef: db.collection("communitySlugs").doc(slug.slug) };
  }
  // `const` para que el estrechamiento sobreviva hasta dentro del `try`.
  const creacion = nueva;

  const now = new Date().toISOString();
  const outcome = planLeadershipGrant({
    targetUid: target.uid,
    // Solo lo que el plan lee. La identidad operativa (`sellerId` y compania) no se le pasa a
    // proposito: lo que el plan no puede nombrar, tampoco puede pisarlo.
    targetClaims: {
      role: String(target.claims.role ?? ""),
      communityId: typeof target.claims.communityId === "string" ? target.claims.communityId : undefined,
      communityStanding: target.claims.communityStanding === "creditor" ? "creditor" : undefined
    },
    community: {
      id: communityRef.id,
      leaderUid: leaderUidActual,
      // `false` es lo que hace que el plan devuelva `create_and_grant`. La decision de crear se
      // toma UNA vez, aqui, y se lee de vuelta en `outcome.createCommunity`: duplicarla abajo
      // con otro `if` es como se acaba creando una comunidad que el plan no planeo.
      exists: sobreUnaQueExiste
    },
    nowIso: now
  });

  if (!outcome.ok) {
    // `invalid-input` es un dato mal formado; los otros dos son el estado del sistema diciendo
    // que no, y su motivo NOMBRA la otra comunidad para que el administrador pueda resolverlo.
    throw new HttpsError(outcome.code === "invalid-input" ? "invalid-argument" : "failed-precondition", outcome.reason);
  }
  if (outcome.kind === "noop") {
    return { ok: true, kind: outcome.kind, changed: false, communityId: outcome.communityId, reason: outcome.reason };
  }
  // Lo que pidio el administrador y lo que decidio el plan salen del MISMO `exists`, asi que
  // esto no puede fallar — y por eso mismo se afirma antes de escribir nada: si alguna vez
  // divergieran, el precio seria media comunidad creada o un `update` sobre un documento que no
  // existe, y las dos cosas se arreglan a mano en produccion.
  if (outcome.createCommunity !== (creacion !== null)) {
    throw new HttpsError("internal", "La concesion no supo si habia que crear la comunidad.");
  }

  const undo: UndoStep[] = [];
  try {
    // ORDEN: la comunidad (con su enlace), degradar, promover, y el documento al final.
    //
    // Degradar antes de promover porque el instante intermedio importa: al reves habria un
    // momento con DOS cuentas llevando el sombrero de la misma comunidad (RF_18). El documento
    // va ultimo porque es lo unico que no necesita reversion: si commitea, ya no queda nada que
    // pueda fallar.
    if (creacion) {
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(creacion.slugRef);
        if (existing.exists) throw new HttpsError("already-exists", "Ese nombre corto ya esta en uso.");
        transaction.set(communityRef, {
          id: communityRef.id,
          name: creacion.name,
          slug: creacion.slug,
          // De la cuenta destino, no de un campo tecleado: es la misma cuenta que va a liderar,
          // y dos copias del nombre que pueden discrepar son una copia de mas.
          ...(target.displayName ? { leaderName: target.displayName } : {}),
          ...(target.email ? { leaderEmail: target.email } : {}),
          linkStatus: "active",
          status: "active",
          pricing: {},
          createdAt: now,
          updatedAt: now
        });
        transaction.set(creacion.slugRef, { communityId: communityRef.id });
      });
      // RF_55: en orden inverso al de creacion y el ENLACE antes que la comunidad —es la reserva
      // la que bloquea el reintento con el mismo nombre corto—, igual que en el alta. Los dos
      // `unshift` dejan la pila en `[promote, slug, community]`.
      undo.unshift({
        label: `community:${communityRef.id}`,
        run: async () => {
          await communityRef.delete();
        }
      });
      undo.unshift({
        label: `slug:${creacion.slug}`,
        run: async () => {
          await creacion.slugRef.delete();
        }
      });
    }
    if (outcome.demote) {
      const demote = outcome.demote;
      const previous = await applyClaimsPatch(auth, demote.uid, demote.claimsPatch);
      undo.unshift({
        label: `demote:${demote.uid}`,
        run: () => auth.setCustomUserClaims(demote.uid, previous)
      });
    }
    if (outcome.promote) {
      const promote = outcome.promote;
      const previous = await applyClaimsPatch(auth, promote.uid, promote.claimsPatch);
      undo.unshift({
        label: `promote:${promote.uid}`,
        run: () => auth.setCustomUserClaims(promote.uid, previous)
      });
    }
    if (outcome.communityUpdate) {
      await communityRef.update(withDeletions({ ...outcome.communityUpdate, updatedAt: now }));
    }
  } catch (error) {
    await undoAll(undo, "community_leadership_grant_rollback_failed", outcome.reason);
    throw error;
  }

  return {
    ok: true,
    kind: outcome.kind,
    changed: true,
    communityId: outcome.communityId,
    slug: creacion?.slug ?? "",
    previousLeaderUid: outcome.demote?.uid ?? "",
    reason: outcome.reason
  };
});

/**
 * Lo que la plataforma le debe HOY al lider de esta comunidad por lo ya causado: sus asientos de
 * cashback que todavia no entraron en ningun corte.
 *
 * Tres detalles que no se pueden tocar:
 *
 *  - El filtro por `type` va EN MEMORIA. El indice de `firestore.indexes.json` cubre las tres
 *    igualdades (`ownerType`, `ownerId`, `settlementId`) pero no `type`; anadirlo a la consulta
 *    la dejaria sin indice, y una consulta sin indice falla EN DURO. El retiro entero se caeria.
 *  - Se suma en NETO: las reversas restan, que es justo lo que debe pasar. Una cuenta a la que
 *    se le revirtio lo que se le habia abonado no esta saldada, y el plan lo sabe.
 *  - `Number(...)` crudo, SIN `|| 0`. Un asiento corrupto produce `NaN`, y `estaSaldado` lee el
 *    `NaN` como "no saldado" y conserva el vinculo. Leerlo como cero apagaria un cobro por un
 *    dato ilegible, y sin dejar rastro de que existia.
 */
async function pendingCommunityCashbackCop(
  db: ReturnType<typeof getFirestore>,
  communityId: string
): Promise<number> {
  const snap = await db
    .collection("walletEntries")
    .where("ownerType", "==", "community_leader")
    .where("ownerId", "==", communityId)
    .where("settlementId", "==", "")
    .get();

  let pendingCop = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.type !== "community_cashback") continue;
    pendingCop += Number(data.amountCop);
  }
  return pendingCop;
}

const revokeLeadershipSchema = z.object({ communityId: text, targetUid: text });

/**
 * RF_05, RF_22, RF_23: retirar el mando. Deja de liderar, no deja de trabajar —el parche no
 * nombra su `role` ni su identidad operativa— y si todavia se le debe algo CONSERVA el vinculo
 * de acreedor, que es lo unico por lo que la plataforma sabe a quien pagarle lo ya causado.
 * Quien apaga ese vinculo es el cierre que termina de pagarlo, no un segundo retiro.
 */
export const revokeCommunityLeadership = onCall(async (request) => {
  const actor = actorFrom(request);
  // El mismo predicado con el que se activa o desactiva a un lider: tambien `isAdmin`.
  if (!canSetCommunityLeaderStatus(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador retira el liderazgo de una comunidad.");
  }
  const parsed = revokeLeadershipSchema.safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const { communityId, targetUid } = parsed.data;

  const db = getFirestore();
  const auth = getAuth();
  const communityRef = db.collection("communities").doc(communityId);
  const communitySnap = await communityRef.get();
  if (!communitySnap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
  const community = communitySnap.data() ?? {};
  const targetClaims = await claimsOf(auth, targetUid);

  const now = new Date().toISOString();
  const outcome = planLeadershipRevoke({
    targetUid,
    targetClaims: {
      role: String(targetClaims.role ?? ""),
      communityId: typeof targetClaims.communityId === "string" ? targetClaims.communityId : undefined,
      communityStanding: targetClaims.communityStanding === "creditor" ? "creditor" : undefined
    },
    community: {
      id: communitySnap.id,
      leaderUid: typeof community.leaderUid === "string" ? community.leaderUid : undefined
    },
    // La cifra, no un booleano: quien decide si eso cuenta como saldado es el plan, en un solo
    // sitio y con la misma regla que usa el cierre del acreedor.
    pendingCashbackCop: await pendingCommunityCashbackCop(db, communityId),
    nowIso: now
  });

  if (!outcome.ok) {
    throw new HttpsError(outcome.code === "invalid-input" ? "invalid-argument" : "failed-precondition", outcome.reason);
  }
  if (outcome.kind === "noop") {
    return { ok: true, kind: outcome.kind, changed: false, communityId: outcome.communityId, reason: outcome.reason };
  }

  const undo: UndoStep[] = [];
  try {
    // ORDEN: primero los reclamos, el documento al final. Igual que en la concesion, el instante
    // intermedio es el que manda: el poder se ejerce con los RECLAMOS (RNF_02), asi que quitarlos
    // primero retira el mando de verdad antes de anunciarlo en el documento. Y el documento, al
    // ir ultimo, no necesita reversion.
    if (outcome.revoke) {
      const revoke = outcome.revoke;
      const previous = await applyClaimsPatch(auth, revoke.uid, revoke.claimsPatch);
      undo.unshift({
        label: `revoke:${revoke.uid}`,
        run: () => auth.setCustomUserClaims(revoke.uid, previous)
      });
    }
    if (outcome.communityUpdate) {
      // `leaderUid: UNSET_FIELD` sale del documento: seguir acreedor no es seguir liderando.
      await communityRef.update(withDeletions({ ...outcome.communityUpdate, updatedAt: now }));
    }
  } catch (error) {
    await undoAll(undo, "community_leadership_revoke_rollback_failed", outcome.reason);
    throw error;
  }

  return {
    ok: true,
    kind: outcome.kind,
    changed: true,
    communityId: outcome.communityId,
    keptAsCreditor: outcome.kind === "revoke_keep_creditor",
    reason: outcome.reason
  };
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
 * El piso que se valida aqui es la base REAL sin zona (RF_05 de la 004):
 * `communityBase(resolveTariffs(settings/global))`, con el fallido fijo dentro. No el ajuste
 * crudo, que en produccion dice 9.000 mientras se cobra 12.000. La decision y su mensaje viven en
 * `validateCommunityPriceFloor`, que es donde estan probados. El piso de cada pedido lo pone el
 * cierre con la base de su zona (RF_11): si la zona es mas cara, se cobra esa base y el pedido deja
 * menos o cero cashback, y el mensaje de rechazo ya lo avisa (RF_12).
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
  const base = communityBase(resolveTariffs(settingsSnap.data() ?? {}));
  const verdict = validateCommunityPriceFloor(field, amountCop, base);
  if (!verdict.ok) throw new HttpsError("invalid-argument", verdict.reason);
  const floor = base[field];

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
    // Por el mismo traductor que el retiro del liderazgo: dos copias de esta conversion acaban
    // diciendo cosas distintas, y la que se equivoque PERSISTIRA un marcador en vez de borrar
    // el campo.
    await ref.update(withDeletions(plan.sellerUpdate));
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
  // RF_10 de la 004: "Tu tarifa" parte de la base REAL (con el fallido fijo), la misma que cobra
  // el cierre; no del ajuste crudo, que le mostraba a la tienda un fallido que no se le cobra.
  const base = communityBase(resolveTariffs(settingsSnap.data() ?? {}, undefined));
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
