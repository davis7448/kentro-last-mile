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

export type CommunityLike = {
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

/** Una escritura declarada, no ejecutada. La callable la traduce al `update`. */
export type LogoWrite = {
  collection: "communities";
  docId: string;
  op: "update";
  data: Record<string, string>;
};

export type LogoChangePlan =
  | {
      ok: false;
      /** Los motivos que nombra RF_16, distinguibles sin leer prosa. */
      reasonCode: "unsupported_format" | "too_large" | "missing_file";
      /** El motivo en castellano, con el limite CONCRETO dentro: RF_16 lo exige. */
      reason: string;
      previousLogoPath: string | null;
      /** El que queda VIGENTE tras la operacion. En un rechazo es, por fuerza, el anterior. */
      effectiveLogoPath: string | null;
      writes: readonly LogoWrite[];
    }
  | {
      ok: true;
      previousLogoPath: string | null;
      effectiveLogoPath: string;
      changed: boolean;
      writes: readonly LogoWrite[];
    };

export type LogoChangeInput = {
  community: { id: string; logoPath?: string };
  file: { logoPath: string; contentType: string; sizeBytes: number };
  nowIso: string;
};

/**
 * RF_16: que pasa exactamente al cambiar el logo, como DATO.
 *
 * Misma forma que `planSlugChange` a proposito: el requisito es el mismo —"rechazarlo indicando
 * el limite concreto y conservar el anterior"— y dos formas distintas para la misma regla es
 * como se desincronizan.
 *
 * Lo que se protege aqui no es un error visible sino su ausencia: un rechazo que ademas borre el
 * logo deja `brandFor` cayendo a la marca de la plataforma (RF_15), o sea la comunidad
 * convertida en Kentro sin que nadie se entere. Por eso el rechazo no ordena escrituras y se
 * puede afirmar sobre el plan entero —tambien contra Storage— que no ordena ninguna.
 *
 * Los limites no se reescriben: salen de `validateLogo`, que es donde estan probados.
 */
export function planLogoChange(input: LogoChangeInput): LogoChangePlan {
  const { community, file, nowIso } = input;
  const previousLogoPath = community.logoPath && community.logoPath.trim() ? community.logoPath : null;
  const reject = (
    reasonCode: "unsupported_format" | "too_large" | "missing_file",
    reason: string
  ): LogoChangePlan => ({
    ok: false,
    reasonCode,
    reason,
    previousLogoPath,
    // El corazon de RF_16: tras el rechazo sigue vigente la marca de siempre.
    effectiveLogoPath: previousLogoPath,
    writes: []
  });

  const nextLogoPath = (file.logoPath ?? "").trim();
  // Ruta en blanco o cero bytes: formulario a medias o subida cortada. Escribirlo perderia la
  // marca igual que un formato malo, y sin que nadie haya elegido nada.
  if (!nextLogoPath || !Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) {
    return reject("missing_file", "No llego ningun archivo de logo. Vuelve a elegir la imagen.");
  }

  const validation = validateLogo({ contentType: file.contentType, sizeBytes: file.sizeBytes });
  if (!validation.ok) {
    // El codigo se deriva de la MISMA comprobacion que el texto, para que no puedan discrepar.
    const formatoAdmitido = LOGO_CONTENT_TYPES.includes(file.contentType);
    return reject(formatoAdmitido ? "too_large" : "unsupported_format", validation.reason);
  }

  if (nextLogoPath === previousLogoPath) {
    return { ok: true, previousLogoPath, effectiveLogoPath: nextLogoPath, changed: false, writes: [] };
  }

  return {
    ok: true,
    previousLogoPath,
    effectiveLogoPath: nextLogoPath,
    changed: true,
    // Solo el logo y la fecha: un lider no toca dinero y este plan no puede ser la puerta por la
    // que se escriba otra cosa.
    writes: [
      { collection: "communities", docId: community.id, op: "update", data: { logoPath: nextLogoPath, updatedAt: nowIso } }
    ]
  };
}

/** Los tres conceptos que paga la tienda. Lo que se le paga a la operacion NO esta aqui. */
export type StoreTariffPrices = Pick<
  PricingValues,
  "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop"
>;

/**
 * Lo que se le cuenta a la tienda de una subida pendiente. `scheduledBy` no viaja: el uid del
 * lider no es asunto de la tienda.
 */
export type StoreTariffRaiseNotice = {
  field: CommunityPricingField;
  fromCop: number;
  toCop: number;
  effectiveAt: string;
};

export type StoreTariffView = {
  communityId: string | null;
  communityName: string | null;
  current: StoreTariffPrices;
  /** Solo lo que aun NO ha entrado en vigor. `null` —no `{}`— si no queda nada pendiente. */
  scheduled: Partial<Record<CommunityPricingField, StoreTariffRaiseNotice>> | null;
};

/**
 * RNF_04: lo que la tienda ve de su tarifa, en cualquier instante y con la MISMA forma tenga
 * comunidad o no.
 *
 * Recibe `base` entera —tal como la devuelve `resolveTariffs`, con los pagos al mensajero
 * dentro— porque es lo que la callable tiene en la mano, y descarta aqui lo que no es de la
 * tienda: antes la rama sin comunidad devolvia `base` tal cual y le filtraba a la tienda el
 * `driverDeliveredPayCop`.
 *
 * `current` sale de `resolveCommunityPricing` y de ningun otro sitio: lo que se muestra y lo
 * que se congela en el pedido tienen que ser el mismo numero.
 *
 * Se anuncia una programada si y solo si existe, su fecha es futura y sube por encima de lo
 * que la tienda paga HOY. Lo vencido ya esta dentro de `current`; y una programada que el piso
 * de RF_35 ya rebaso prometeria un precio que no es. El `fromCop` del anuncio es el vigente y
 * no el guardado al programar: si la base se movio entretanto, el guardado esta rancio.
 */
export function buildStoreTariffView(
  base: Partial<Record<CommunityPricingField, number>>,
  community: (CommunityLike & { name?: string }) | undefined,
  nowIso: string
): StoreTariffView {
  const current = resolveCommunityPricing(base, community, nowIso);
  const now = Date.parse(nowIso);
  const scheduled: Partial<Record<CommunityPricingField, StoreTariffRaiseNotice>> = {};

  for (const field of COMMUNITY_PRICING_FIELDS) {
    const change = community?.scheduled?.[field];
    if (!change) continue;
    const effective = Date.parse(change.effectiveAt);
    if (!Number.isFinite(effective) || !Number.isFinite(now)) continue;
    if (effective <= now) continue;
    const vigente = current[field];
    if (!(change.toCop > vigente)) continue;
    scheduled[field] = {
      field,
      fromCop: vigente,
      toCop: change.toCop,
      effectiveAt: change.effectiveAt
    };
  }

  return {
    communityId: community ? community.id : null,
    communityName: community ? String(community.name ?? "") : null,
    current: {
      sellerDeliveredFeeCop: current.sellerDeliveredFeeCop,
      sellerFailedFeeCop: current.sellerFailedFeeCop,
      fulfillmentFeeCop: current.fulfillmentFeeCop
    },
    scheduled: Object.keys(scheduled).length > 0 ? scheduled : null
  };
}

export type ScheduledRaiseCancellation =
  | { ok: true; field: CommunityPricingField; fromCop: number; toCop: number; effectiveAt: string }
  | { ok: false; reason: string };

/**
 * RF_40: una subida programada se cancela ANTES de su fecha, nunca despues.
 *
 * El precio programado no se escribe nunca en `pricing`: `applyScheduledChanges` lo aplica al
 * leer. Asi que borrar una programada ya vencida no cancela nada — BAJA el precio vigente, de
 * 16.000 de vuelta a 13.000, sin aviso, sin historial y sin que nadie lo pida. Por eso la
 * decision vive aqui, mirando el reloj, y no en el `FieldValue.delete()` de la callable.
 */
export function planScheduledRaiseCancellation(
  community: CommunityLike,
  field: CommunityPricingField,
  nowIso: string
): ScheduledRaiseCancellation {
  const change = community.scheduled?.[field];
  if (!change) {
    return { ok: false, reason: "No hay ninguna subida programada para este concepto." };
  }
  const effective = Date.parse(change.effectiveAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(effective) || !Number.isFinite(now)) {
    return { ok: false, reason: "La subida programada no tiene una fecha valida." };
  }
  if (now >= effective) {
    return {
      ok: false,
      reason: "Es tarde: esa subida ya entro en vigor y cancelarla ahora bajaria el precio vigente."
    };
  }
  return {
    ok: true,
    field,
    fromCop: change.fromCop,
    toCop: change.toCop,
    effectiveAt: change.effectiveAt
  };
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
  /**
   * Desde cuando aplica, cuando NO es el plazo de siempre. Se parametriza en vez de duplicar el
   * constructor porque hay un caso —la elevacion al piso de RF_35— en el que el precio nuevo ya
   * esta rigiendo: pasarlo por `scheduleEffectiveAt` le pondria ocho dias a algo que ya cobra.
   */
  effectiveAt?: string;
}) {
  return {
    field: input.field,
    fromCop: input.fromCop,
    toCop: input.toCop,
    effectiveAt: input.effectiveAt ?? scheduleEffectiveAt(input.fromCop, input.toCop, input.nowIso),
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    createdAt: input.nowIso
  };
}

/** Quien firma una elevacion al piso. No es un humano y el historial no puede fingir que lo sea. */
export const FLOOR_RAISE_ACTOR_UID = "system:floor";
export const FLOOR_RAISE_ACTOR_ROLE = "system";

export type FloorPriceHistoryEntry = ReturnType<typeof buildPriceHistoryEntry>;

/** Todo lo que hay que escribir en UNA comunidad. Si no hay nada, la comunidad no sale del plan. */
export type CommunityFloorRaise = {
  communityId: string;
  /** Conceptos elevados, en el orden de `COMMUNITY_PRICING_FIELDS`. */
  fields: CommunityPricingField[];
  /** Rutas con punto listas para `update()`: `pricing.X`, `floorRaisedAt.X`, `updatedAt`. */
  communityUpdate: Record<string, string | number>;
  /** Rutas a borrar (`scheduled.X`). El trigger las traduce a `FieldValue.delete()`. */
  deleteFields: string[];
  /** RF_39: una por concepto elevado. Subcoleccion `priceHistory`. */
  historyEntries: FloorPriceHistoryEntry[];
};

export type FloorRaisePlan = {
  /** Conceptos cuya base SUBIO. Vacio => no se escribe absolutamente nada. */
  raisedFields: CommunityPricingField[];
  communities: CommunityFloorRaise[];
};

/** Una tarifa ausente en los ajustes es un piso de cero, no un cambio inexistente. */
function tariffFromSettings(settings: Record<string, unknown>, field: CommunityPricingField): number {
  const value = Number(settings[field]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * RF_35: que comunidades hay que elevar cuando el administrador sube una tarifa base, que
 * conceptos y con que historial. PURO: recibe el documento de ajustes entero —antes y despues—,
 * las comunidades y el instante, y devuelve exactamente lo que se va a escribir. El trigger que
 * lo llama traduce; no decide ni calcula.
 *
 * Tres cosas se deciden aqui, y ninguna es cableado:
 *
 *  - **Que es una tarifa.** `settings/app` guarda decenas de campos que no lo son y el trigger
 *    salta con todos ellos. Sin este filtro, cada guardado de ajustes reescribiria todas las
 *    comunidades y llenaria el historial de cambios de precio que nunca ocurrieron.
 *  - **Contra que se compara.** Contra el precio VIGENTE (`applyScheduledChanges`), no contra el
 *    literal de `pricing`: una programada vencida en 14.000 se quedaria intacta bajo un piso de
 *    15.000 y el `fromCop` del historial mentiria. Mismo criterio que T39 para el aviso.
 *  - **Solo estrictamente por debajo.** Igual al piso no entra: escribir un cambio que no cambia
 *    nada rompe la idempotencia del reintento —Firestore repite el mismo evento— y repetiria el
 *    aviso al lider.
 *
 * Las programadas que el piso nuevo ya rebasa se borran en el mismo movimiento que las deja sin
 * sentido. Una subida que la tienda nunca vio (T39 decidio no anunciarla) puede revivir sola si
 * la base vuelve a bajar, y entonces se aplicaria sin los ocho dias de aviso de RF_28.
 */
export function planFloorRaise(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  communities: CommunityLike[];
  nowIso: string;
}): FloorRaisePlan {
  const { before, after, communities, nowIso } = input;

  const raisedFields: CommunityPricingField[] = [];
  const floors = {} as Record<CommunityPricingField, number>;
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const floor = tariffFromSettings(after, field);
    if (floor <= tariffFromSettings(before, field)) continue;
    raisedFields.push(field);
    floors[field] = floor;
  }
  if (raisedFields.length === 0) return { raisedFields: [], communities: [] };

  const changes: CommunityFloorRaise[] = [];
  for (const community of communities) {
    const current = applyScheduledChanges(community, nowIso);
    const fields: CommunityPricingField[] = [];
    const communityUpdate: Record<string, string | number> = {};
    const deleteFields: string[] = [];
    const historyEntries: FloorPriceHistoryEntry[] = [];

    for (const field of raisedFields) {
      const floor = floors[field];
      const currentCop = Number(current[field]);
      // Sin precio propio no hay nada que elevar: esa comunidad ya cobra la base (RF_20).
      if (!Number.isFinite(currentCop) || currentCop >= floor) continue;

      fields.push(field);
      communityUpdate[`pricing.${field}`] = floor;
      // El aviso al lider de RF_35. Lo escribe el trigger de `settings/app` y nadie mas.
      communityUpdate[`floorRaisedAt.${field}`] = nowIso;
      historyEntries.push(
        buildPriceHistoryEntry({
          field,
          fromCop: currentCop,
          toCop: floor,
          nowIso,
          actorUid: FLOOR_RAISE_ACTOR_UID,
          actorRole: FLOOR_RAISE_ACTOR_ROLE,
          // RF_40: el piso rige desde YA. Ocho dias de plazo son ocho dias cobrando por debajo
          // del costo de Kentro, que es justo lo que la exencion de RF_40 evita.
          effectiveAt: nowIso
        })
      );

      const scheduled = community.scheduled?.[field];
      if (scheduled && Number(scheduled.toCop) <= floor) deleteFields.push(`scheduled.${field}`);
    }

    if (fields.length === 0) continue;
    communityUpdate.updatedAt = nowIso;
    changes.push({ communityId: community.id, fields, communityUpdate, deleteFields, historyEntries });
  }

  return { raisedFields, communities: changes };
}
