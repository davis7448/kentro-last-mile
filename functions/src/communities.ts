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
  canCreateCommunityLeader,
  canEditCommunityBrand,
  canEditCommunityPricing,
  canSetCommunityLeaderStatus,
  canSetCommunityLinkStatus,
  canReassignSellerCommunity,
  type Actor
} from "./community-access";
import {
  buildPriceHistoryEntry,
  COMMUNITY_PRICING_FIELDS,
  resolveCommunityPricing,
  scheduleEffectiveAt,
  validateLogo,
  type CommunityPricingField
} from "./community-pricing";
import { resolveTariffs } from "./wallet-entries";
import { isRetiredSlugStillValid, validateSlug } from "./community-slug";

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
  const now = new Date().toISOString();
  const communityRef = db.collection("communities").doc(`com-${Date.now()}`);
  const slugRef = db.collection("communitySlugs").doc(slug.slug);

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
      leaderEmail: input.leaderEmail.toLowerCase(),
      leaderPhone: input.leaderPhone,
      linkStatus: "active",
      status: "active",
      pricing: {},
      createdAt: now,
      updatedAt: now
    });
    transaction.set(slugRef, { communityId: communityRef.id });
  });

  const auth = getAuth();
  const user = await auth.createUser({
    email: input.leaderEmail.toLowerCase(),
    password: input.password,
    displayName: input.leaderName
  });
  await auth.setCustomUserClaims(user.uid, { role: "community_leader", communityId: communityRef.id });

  return { communityId: communityRef.id, slug: slug.slug, uid: user.uid };
});

/** RF_51: desactivar corta el acceso y NO toca comunidad, historial ni cashback pendiente. */
export const setCommunityLeaderStatus = onCall(async (request) => {
  const actor = actorFrom(request);
  if (!canSetCommunityLeaderStatus(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador activa o desactiva lideres.");
  }
  const parsed = z.object({ communityId: text, status: z.enum(["active", "disabled"]) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const db = getFirestore();
  await db.collection("communities").doc(parsed.data.communityId).update({
    status: parsed.data.status,
    updatedAt: new Date().toISOString()
  });
  return { ok: true };
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
  const next = validateSlug(parsed.data.slug);
  if (!next.ok) throw new HttpsError("invalid-argument", next.reason);

  const db = getFirestore();
  const now = new Date().toISOString();
  const communityRef = db.collection("communities").doc(parsed.data.communityId);
  const nextSlugRef = db.collection("communitySlugs").doc(next.slug);

  await db.runTransaction(async (transaction) => {
    const [communitySnap, nextSnap] = await Promise.all([transaction.get(communityRef), transaction.get(nextSlugRef)]);
    if (!communitySnap.exists) throw new HttpsError("not-found", "La comunidad no existe.");
    const current = String(communitySnap.data()?.slug ?? "");
    if (current === next.slug) return;
    if (nextSnap.exists) throw new HttpsError("already-exists", "Ese nombre corto ya esta en uso.");
    if (current) {
      transaction.set(
        db.collection("communitySlugs").doc(current),
        { communityId: communityRef.id, retiredAt: now },
        { merge: true }
      );
    }
    transaction.set(nextSlugRef, { communityId: communityRef.id });
    transaction.update(communityRef, { slug: next.slug, updatedAt: now });
  });
  return { slug: next.slug };
});

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
  // Una sola definicion de los limites, la que esta probada.
  const logo = validateLogo({ contentType: parsed.data.contentType, sizeBytes: parsed.data.sizeBytes });
  if (!logo.ok) throw new HttpsError("invalid-argument", logo.reason);
  await getFirestore().collection("communities").doc(parsed.data.communityId).update({
    logoPath: parsed.data.logoPath,
    updatedAt: new Date().toISOString()
  });
  return { ok: true };
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
  await getFirestore().collection("communities").doc(parsed.data.communityId).update({
    [`scheduled.${parsed.data.field}`]: FieldValue.delete(),
    updatedAt: new Date().toISOString()
  });
  return { ok: true };
});

/**
 * RF_35: cuando el administrador sube una base por encima del precio de alguna comunidad,
 * esos precios suben solos hasta el nuevo piso y su cashback de ese concepto queda en cero.
 * Se hace aqui y no al leer, para que el aviso salga una sola vez y la funcion pura siga pura.
 */
export const raiseCommunityPricesToFloor = onCall(async (request) => {
  const actor = actorFrom(request);
  if (actor.role !== "admin") throw new HttpsError("permission-denied", "Solo un administrador.");
  const parsed = z
    .object({ field: z.enum(COMMUNITY_PRICING_FIELDS), floorCop: z.number().int().nonnegative() })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const { field, floorCop } = parsed.data;

  const db = getFirestore();
  const now = new Date().toISOString();
  const snap = await db.collection("communities").get();
  const raised: string[] = [];
  for (const doc of snap.docs) {
    const current = Number(doc.data()?.pricing?.[field as CommunityPricingField]);
    if (!Number.isFinite(current) || current >= floorCop) continue;
    await doc.ref.update({
      [`pricing.${field}`]: floorCop,
      [`floorRaisedAt.${field}`]: now,
      updatedAt: now
    });
    await doc.ref.collection("priceHistory").doc().set({
      field,
      fromCop: current,
      toCop: floorCop,
      effectiveAt: now,
      actorUid: actor.uid,
      actorRole: actor.role,
      createdAt: now,
      note: "Elevacion automatica al nuevo piso de Kentro."
    });
    raised.push(doc.id);
  }
  return { raised };
});

/** RF_53: el aviso de captacion masiva se descarta sin desactivar a nadie. */
export const dismissMassSignupAlert = onCall(async (request) => {
  const actor = actorFrom(request);
  if (actor.role !== "admin") throw new HttpsError("permission-denied", "Solo un administrador.");
  const parsed = z.object({ communityId: text }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  await getFirestore().collection("communities").doc(parsed.data.communityId).update({
    massSignupAlertDismissedAt: new Date().toISOString()
  });
  return { ok: true };
});

/**
 * RF_41, RF_42: sin tope automatico de altas, esta es la unica contencion ante un enlace
 * filtrado. Desactiva accesos; NO borra pedidos ni historial de dinero.
 */
export const disableCommunitySignupsInRange = onCall(async (request) => {
  const actor = actorFrom(request);
  if (actor.role !== "admin") throw new HttpsError("permission-denied", "Solo un administrador.");
  const parsed = z
    .object({ communityId: text, fromIso: text, toIso: text })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const { communityId, fromIso, toIso } = parsed.data;

  const db = getFirestore();
  const auth = getAuth();
  const snap = await db
    .collection("sellers")
    .where("communityId", "==", communityId)
    .where("communityJoinedAt", ">=", fromIso)
    .where("communityJoinedAt", "<=", toIso)
    .get();

  const disabled: string[] = [];
  for (const doc of snap.docs) {
    await doc.ref.update({ debtBlockedAt: new Date().toISOString() });
    const users = await auth.getUsers([{ email: String(doc.data()?.contactEmail ?? "") }]).catch(() => null);
    for (const user of users?.users ?? []) await auth.updateUser(user.uid, { disabled: true });
    disabled.push(doc.id);
  }
  return { disabled };
});

/** RF_11: cambiar de comunidad no lo decide ni la tienda ni el lider. */
export const reassignSellerCommunity = onCall(async (request) => {
  const actor = actorFrom(request);
  if (!canReassignSellerCommunity(actor)) {
    throw new HttpsError("permission-denied", "Solo un administrador reasigna tiendas.");
  }
  const parsed = z.object({ sellerId: text, communityId: z.string().trim().optional() }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError("invalid-argument", "Datos invalidos.");
  const now = new Date().toISOString();
  await getFirestore().collection("sellers").doc(parsed.data.sellerId).update({
    communityId: parsed.data.communityId || FieldValue.delete(),
    communityJoinedAt: parsed.data.communityId ? now : FieldValue.delete()
  });
  // El cashback ya causado se queda con el lider que lo causo: no se toca ningun asiento.
  return { ok: true };
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
  if (!communityId) {
    return { communityId: null, current: base, scheduled: null };
  }

  const communitySnap = await db.collection("communities").doc(communityId).get();
  const community = communitySnap.data() ?? {};
  const current = resolveCommunityPricing(base, { id: communityId, ...community }, now);
  // Solo lo que aun no ha entrado en vigor: lo vencido ya esta dentro de `current`.
  const scheduled = Object.fromEntries(
    COMMUNITY_PRICING_FIELDS.map((field) => [field, community.scheduled?.[field] ?? null]).filter(
      ([, change]) => change && String((change as { effectiveAt?: string }).effectiveAt ?? "") > now
    )
  );

  return {
    communityId,
    communityName: String(community.name ?? ""),
    current,
    scheduled: Object.keys(scheduled).length > 0 ? scheduled : null
  };
});
