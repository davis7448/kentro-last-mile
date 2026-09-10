/**
 * Precios de comunidad y cashback del lider. SIN acceso a Firestore.
 *
 * Es el unico sitio donde se decide cuanto gana un lider de comunidad. Vive aparte de
 * `communities.ts` por la misma razon que `wallet-entries.ts` vive aparte de `orders.ts`: la
 * regla de dinero tiene que poder probarse sin red, y tiene que haber UNA sola copia de ella.
 *
 * Dos instantes distintos conviven en un pedido y conviene no confundirlos:
 *  - El precio se CONGELA al crear el pedido (`freezeOrderPricing`).
 *  - El cashback se CAUSA al cerrarlo, leyendo lo que se congelo, nunca la tarifa viva.
 *
 * Todas las funciones que dependen del tiempo reciben el instante por parametro. Es el mismo
 * patron de `dandaDeliveredFeeCop`, y es lo que permite probar los plazos sin simular relojes.
 */

/** Una subida de precio avisa con ocho dias. Una bajada no espera: no perjudica a la tienda. */
export const SCHEDULED_RAISE_NOTICE_DAYS = 8;

/** Conceptos que un lider puede encarecer. Los pagos a la operacion NO estan aqui, a proposito. */
export const COMMUNITY_PRICING_FIELDS = [
  "sellerDeliveredFeeCop",
  "sellerFailedFeeCop",
  "fulfillmentFeeCop"
] as const;

export type CommunityPricingField = (typeof COMMUNITY_PRICING_FIELDS)[number];
export type PricingValues = Record<CommunityPricingField, number>;

type ScheduledChange = {
  field: CommunityPricingField;
  fromCop: number;
  toCop: number;
  effectiveAt: string;
  scheduledBy: string;
  scheduledAt: string;
};

type CommunityLike = {
  id: string;
  pricing?: Partial<Record<CommunityPricingField, number>>;
  scheduled?: Partial<Record<CommunityPricingField, ScheduledChange>>;
};

export type FrozenPricing = {
  communityId: string;
  frozenAt: string;
  sellerDeliveredFeeCop: number;
  baseDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  baseFailedFeeCop: number;
  fulfillmentFeeCop: number;
  baseFulfillmentFeeCop: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cuando entra en vigor un cambio de precio. Subir espera ocho dias desde que se programa; si
 * se reprograma, el plazo se reinicia desde la nueva fecha. Bajar entra en el acto.
 */
export function scheduleEffectiveAt(fromCop: number, toCop: number, nowIso: string): string {
  if (toCop <= fromCop) return nowIso;
  return new Date(Date.parse(nowIso) + SCHEDULED_RAISE_NOTICE_DAYS * DAY_MS).toISOString();
}

/**
 * Precio propio de la comunidad tras aplicar los cambios programados que ya vencieron. No mira
 * la base: solo dice que quiso cobrar el lider. El piso lo pone `resolveCommunityPricing`.
 */
export function applyScheduledChanges(
  community: CommunityLike,
  nowIso: string
): Partial<Record<CommunityPricingField, number>> {
  const now = Date.parse(nowIso);
  const result: Partial<Record<CommunityPricingField, number>> = { ...(community.pricing ?? {}) };
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const change = community.scheduled?.[field];
    if (!change) continue;
    const effective = Date.parse(change.effectiveAt);
    if (Number.isFinite(effective) && Number.isFinite(now) && now >= effective) {
      result[field] = change.toCop;
    }
  }
  return result;
}

/**
 * Precio final por concepto: lo que quiso cobrar el lider, elevado al piso de la base.
 *
 * El clamp es lo que garantiza que Kentro nunca cobre por debajo de su costo y que el cashback
 * no pueda salir negativo, sea cual sea el orden en que cambiaron base y precio (RF_35, RF_36).
 */
export function resolveCommunityPricing(
  base: Partial<Record<CommunityPricingField, number>>,
  community: CommunityLike | undefined,
  nowIso: string
): PricingValues {
  const own = community ? applyScheduledChanges(community, nowIso) : {};
  const values = {} as PricingValues;
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const floor = Number(base[field]) || 0;
    const wanted = Number(own[field]);
    values[field] = Number.isFinite(wanted) && wanted > floor ? wanted : floor;
  }
  return values;
}

/**
 * Congela precio y base en el pedido, al crearlo. Devuelve `undefined` si la tienda no
 * pertenece a ninguna comunidad: ese pedido se rige por la tarifa viva de siempre y no genera
 * cashback, que es exactamente lo que debe pasar para no mover el dinero ya existente.
 */
export function freezeOrderPricing(
  base: Partial<Record<CommunityPricingField, number>>,
  community: CommunityLike | undefined,
  nowIso: string
): FrozenPricing | undefined {
  if (!community) return undefined;
  const final = resolveCommunityPricing(base, community, nowIso);
  return {
    communityId: community.id,
    frozenAt: nowIso,
    sellerDeliveredFeeCop: final.sellerDeliveredFeeCop,
    baseDeliveredFeeCop: Number(base.sellerDeliveredFeeCop) || 0,
    sellerFailedFeeCop: final.sellerFailedFeeCop,
    baseFailedFeeCop: Number(base.sellerFailedFeeCop) || 0,
    fulfillmentFeeCop: final.fulfillmentFeeCop,
    baseFulfillmentFeeCop: Number(base.fulfillmentFeeCop) || 0
  };
}

export type CashbackBreakdown = {
  deliveredCop: number;
  failedCop: number;
  fulfillmentCop: number;
  totalCop: number;
};

/** Cashback por concepto a partir de lo congelado. Nunca negativo: el piso ya actuo al congelar. */
export function cashbackForFrozenPricing(frozen: FrozenPricing | undefined): CashbackBreakdown {
  if (!frozen) return { deliveredCop: 0, failedCop: 0, fulfillmentCop: 0, totalCop: 0 };
  const delivered = Math.max(0, frozen.sellerDeliveredFeeCop - frozen.baseDeliveredFeeCop);
  const failed = Math.max(0, frozen.sellerFailedFeeCop - frozen.baseFailedFeeCop);
  const fulfillment = Math.max(0, frozen.fulfillmentFeeCop - frozen.baseFulfillmentFeeCop);
  return {
    deliveredCop: delivered,
    failedCop: failed,
    fulfillmentCop: fulfillment,
    totalCop: delivered + failed + fulfillment
  };
}

/**
 * RF_16: limites del logo del lider. Un archivo enorme o de formato raro deja la pantalla de
 * registro con la imagen rota, y esa pantalla es la primera impresion de la comunidad.
 */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export function validateLogo(file: { contentType: string; sizeBytes: number }): { ok: true } | { ok: false; reason: string } {
  if (!LOGO_CONTENT_TYPES.includes(file.contentType)) {
    return { ok: false, reason: `Formato no admitido. Usa ${LOGO_CONTENT_TYPES.join(", ")}.` };
  }
  if (file.sizeBytes > LOGO_MAX_BYTES) {
    return { ok: false, reason: `El logo supera ${Math.round(LOGO_MAX_BYTES / 1024)} KB.` };
  }
  return { ok: true };
}

/**
 * RF_39: la entrada de historial de un cambio de precio. Se construye aparte para que quede
 * probada: es el unico rastro de quien subio un precio y desde cuando, y tiene que sobrevivir
 * a que el lider se desactive.
 */
export function buildPriceHistoryEntry(input: {
  field: CommunityPricingField;
  fromCop: number;
  toCop: number;
  nowIso: string;
  actorUid: string;
  actorRole: string;
}) {
  return {
    field: input.field,
    fromCop: input.fromCop,
    toCop: input.toCop,
    effectiveAt: scheduleEffectiveAt(input.fromCop, input.toCop, input.nowIso),
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    createdAt: input.nowIso
  };
}
