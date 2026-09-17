/**
 * Precios de comunidad y cashback del lider. SIN acceso a Firestore.
 *
 * Es el unico sitio donde se decide cuanto gana un lider de comunidad. Vive aparte de
 * `communities.ts` por la misma razon que `wallet-entries.ts` vive aparte de `orders.ts`: la
 * regla de dinero tiene que poder probarse sin red, y tiene que haber UNA sola copia de ella.
 *
 * Dos instantes distintos conviven en un pedido y cada uno decide una mitad del precio:
 *  - Al CREAR se congela el precio PROPIO del lider (`freezeOrderPricing`, `leader<X>FeeCop`).
 *    Revocar al lider o cambiar su tarifa despues no toca lo que ya entro.
 *  - Al CERRAR se decide la base, con la base DEL CIERRE (`communityChargeAtClose`): se cobra la
 *    mayor entre esa base y el precio congelado del lider, y el cashback es la diferencia.
 *
 * Esto reemplaza, en la base, la garantia de la 001 (RF_22: "el cierre solo lee lo congelado").
 * RF_11 de la 004 lo cambio a proposito: la zona se edita despues de crear y una tienda sin
 * comunidad paga la tarifa del cierre, asi que congelar tambien la base cobraba de menos y
 * convertia una bajada de la base en cashback de un lider que no habia fijado nada (RF_04).
 *
 * Todas las funciones que dependen del tiempo reciben el instante por parametro. Es el mismo
 * patron de `dandaDeliveredFeeCop`, y es lo que permite probar los plazos sin simular relojes.
 */

import { communityBase, resolveTariffs } from "./seller-charges";

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
  /**
   * Quien lidera HOY. Opcional porque en el documento es opcional de verdad: hay comunidades
   * anteriores a la concesion de rol y `planLeaderRevocation` lo BORRA, no lo vacia.
   */
  leaderUid?: string;
  /** `disabled` conserva `leaderUid` y `pricing` intactos: apagar no borra nada (RF_20). */
  status?: "active" | "disabled";
};

/**
 * RF_20: si la comunidad cobra su precio propio, o solo la base.
 *
 * Solo hay UN estado en el que el sobreprecio tiene a quien pagarse: comunidad viva y con lider.
 * Sin lider —o desactivada— el sobreprecio se le cobraria a la tienda para no abonarselo a nadie.
 *
 * Un `status` ausente NO es activo: el lado seguro es cobrar la base, porque equivocarse hacia
 * ese lado no le cobra de mas a nadie.
 *
 * "Sin lider" se decide con el mismo criterio que `community-grant.ts` —un uid que al recortarlo
 * no queda nada no es un lider—: dos criterios distintos para lo mismo es como se llega a cobrar
 * un sobreprecio que el panel del lider no muestra.
 *
 * `linkStatus: "revoked"` no entra aqui a proposito: eso solo cierra la pantalla de alta de
 * tiendas y el lider sigue trabajando.
 */
function chargesOwnPricing(community: CommunityLike | undefined): community is CommunityLike {
  if (!community) return false;
  if (community.status !== "active") return false;
  return (community.leaderUid ?? "").trim() !== "";
}

export type FrozenPricing = {
  communityId: string;
  frozenAt: string;
  /**
   * `2` desde la spec 004: el pedido lleva el precio propio del lider en `leader<X>FeeCop` y la
   * base se decide al cerrar. Ausente = pedido legado (ver `communityChargeAtClose`).
   */
  pricingVersion?: 2;
  /**
   * RF_03: lo que fijo el lider para cada concepto, TAL CUAL, aunque este por debajo de la base
   * (el piso lo pone el cierre). Ausente = el lider no fijo precio, o la comunidad no cobra el
   * suyo (RF_20). Nunca un cero de relleno: un cero se leeria como precio.
   */
  leaderDeliveredFeeCop?: number;
  leaderFailedFeeCop?: number;
  leaderFulfillmentFeeCop?: number;
  // Los seis de referencia (RF_03 MAY): precio final y base AL CREAR. Pantallas y scripts los
  // leen; el cierre de un pedido v2 NO los usa para decidir dinero.
  sellerDeliveredFeeCop: number;
  baseDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  baseFailedFeeCop: number;
  fulfillmentFeeCop: number;
  baseFulfillmentFeeCop: number;
};

type LeaderPricingField = "leaderDeliveredFeeCop" | "leaderFailedFeeCop" | "leaderFulfillmentFeeCop";

/** Concepto de la tienda -> campo congelado del precio del lider. */
const LEADER_FIELD: Record<CommunityPricingField, LeaderPricingField> = {
  sellerDeliveredFeeCop: "leaderDeliveredFeeCop",
  sellerFailedFeeCop: "leaderFailedFeeCop",
  fulfillmentFeeCop: "leaderFulfillmentFeeCop"
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
  // La comprobacion del lider va AQUI, antes del piso y de las programadas, y no al final sobre
  // los valores ya resueltos. El caso que lo obliga: una comunidad huerfana con `pricing` en
  // 11.000 —por DEBAJO de la base de 12.000— y una subida programada ya vencida a 18.000. Una
  // guarda puesta despues del bucle, o puesta solo sobre `community.pricing`, deja pasar los
  // 18.000 de la programada: la tienda seguiria pagando 6.000 de mas por pedido y ese sobreprecio
  // no lo cobraria nadie. Sin lider, esto tiene que dar EXACTAMENTE lo mismo que no tener
  // comunidad.
  //
  // Y no puede vivir dentro de `applyScheduledChanges`: esa funcion dice que quiso cobrar el
  // lider, y de ella dependen el `fromCop` del historial (RF_39) y la elevacion al piso (RF_35).
  const own = chargesOwnPricing(community) ? applyScheduledChanges(community, nowIso) : {};
  const values = {} as PricingValues;
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const floor = Number(base[field]) || 0;
    const wanted = Number(own[field]);
    values[field] = Number.isFinite(wanted) && wanted > floor ? wanted : floor;
  }
  return values;
}

/**
 * Congela en el pedido, al crearlo, el precio PROPIO vigente del lider (RF_03) y, como
 * referencia, el precio final y la base de ese instante. Devuelve `undefined` si la tienda no
 * pertenece a ninguna comunidad: ese pedido se rige por la tarifa viva de siempre y no genera
 * cashback, que es exactamente lo que debe pasar para no mover el dinero ya existente.
 *
 * El precio del lider se guarda sin elevarlo al piso: un fallido de 11.000 bajo una base de
 * 12.000 queda en 11.000, porque si la base del cierre baja a 10.000 lo justo es cobrar 11.000 y
 * no los 12.000 que habria dejado un piso aplicado aqui.
 */
export function freezeOrderPricing(
  base: Partial<Record<CommunityPricingField, number>>,
  community: CommunityLike | undefined,
  nowIso: string
): FrozenPricing | undefined {
  if (!community) return undefined;
  const final = resolveCommunityPricing(base, community, nowIso);
  // RF_20: sin lider o desactivada no hay precio propio que congelar. Mismo criterio que el
  // resolutor, para que referencia y precio del lider no puedan contarse historias distintas.
  const own = chargesOwnPricing(community) ? applyScheduledChanges(community, nowIso) : {};
  const leaderPrices: Partial<Record<LeaderPricingField, number>> = {};
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const wanted = own[field];
    // Construccion condicional: un concepto sin precio queda AUSENTE, no `undefined` explicito.
    if (typeof wanted === "number" && Number.isFinite(wanted)) leaderPrices[LEADER_FIELD[field]] = wanted;
  }
  return {
    communityId: community.id,
    frozenAt: nowIso,
    pricingVersion: 2,
    ...leaderPrices,
    sellerDeliveredFeeCop: final.sellerDeliveredFeeCop,
    baseDeliveredFeeCop: Number(base.sellerDeliveredFeeCop) || 0,
    sellerFailedFeeCop: final.sellerFailedFeeCop,
    baseFailedFeeCop: Number(base.sellerFailedFeeCop) || 0,
    fulfillmentFeeCop: final.fulfillmentFeeCop,
    baseFulfillmentFeeCop: Number(base.fulfillmentFeeCop) || 0
  };
}

/** Pesos en formato es-CO (`$12.000`), el mismo patron que `copText` de community-view. */
function copText(value: number): string {
  const amount = Number.isFinite(value) ? Math.round(value) : 0;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("es-CO")}`;
}

/**
 * RF_05, RF_12 de la 004: el minimo que un lider puede fijar para un concepto.
 *
 * `base` es la base REAL sin zona (`communityBase(resolveTariffs(settings/global))`), con el
 * fallido fijo dentro: no el ajuste crudo, que en produccion dice 9.000 mientras se cobra 12.000.
 * Sin zona porque RF_05 no exige superar la base de ninguna zona: en un pedido con zona mas cara
 * el cierre cobra esa base (RF_11) y el mensaje lo avisa, para que el lider no descubra el menor
 * cashback al ver el corte.
 *
 * Igual a la base es valido. Pura: no muta `base`.
 */
export function validateCommunityPriceFloor(
  field: CommunityPricingField,
  amountCop: number,
  base: Partial<Record<CommunityPricingField, number>>
): { ok: true } | { ok: false; floorCop: number; reason: string } {
  const floorCop = Number(base[field]) || 0;
  if (amountCop >= floorCop) return { ok: true };
  return {
    ok: false,
    floorCop,
    reason:
      `El minimo para este concepto es ${copText(floorCop)} (lo que Kentro cobra en un pedido sin zona). ` +
      "En pedidos con zona la base puede ser mayor: ahi se cobra la base y ese pedido deja menos o cero cashback."
  };
}

export type CashbackBreakdown = {
  deliveredCop: number;
  failedCop: number;
  fulfillmentCop: number;
  totalCop: number;
};

export type CommunityChargeAtClose = {
  /** Lo que paga la tienda por concepto: nunca menos que `base`. */
  charged: PricingValues;
  /** La base DEL CIERRE con la que se decidio. */
  base: PricingValues;
  /** `charged - base` por concepto. Lo que se abona al lider. */
  cashback: CashbackBreakdown;
};

/** Concepto de la tienda -> campo del desglose de cashback. */
const CASHBACK_FIELD: Record<CommunityPricingField, "deliveredCop" | "failedCop" | "fulfillmentCop"> = {
  sellerDeliveredFeeCop: "deliveredCop",
  sellerFailedFeeCop: "failedCop",
  fulfillmentFeeCop: "fulfillmentCop"
};

/**
 * RF_11, RF_04, RF_06: cuanto paga la tienda y cuanto gana el lider al CERRAR un pedido de
 * comunidad. Recibe lo congelado y la base del cierre, y nada mas: ni la comunidad ni la tienda
 * (RF_12), asi que revocar al lider despues de crear no puede tocar su precio.
 *
 * Por concepto: se cobra el precio del lider si supera la base del cierre, y si no la base. El
 * cashback es la diferencia, >= 0 por construccion.
 *
 * Pedido LEGADO (sin `pricingVersion`): su `seller<X>` se toma como precio del lider y su base
 * guardada se ignora. Asi un legado cerrado con la base de siempre da el mismo cashback que
 * antes, y uno que guardo una base vieja mas baja (el fallido de 9.000) cobra la base real sin
 * intervencion manual.
 *
 * Pura: no muta `frozen` ni `base`; una correccion que vuelva a cerrar lee lo mismo.
 */
export function communityChargeAtClose(frozen: FrozenPricing, base: PricingValues): CommunityChargeAtClose {
  const isV2 = frozen.pricingVersion === 2;
  const charged = {} as PricingValues;
  const closeBase = {} as PricingValues;
  const cashback: CashbackBreakdown = { deliveredCop: 0, failedCop: 0, fulfillmentCop: 0, totalCop: 0 };
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const floor = Number(base[field]) || 0;
    const leader = isV2 ? frozen[LEADER_FIELD[field]] : frozen[field];
    const price = typeof leader === "number" && Number.isFinite(leader) && leader > floor ? leader : floor;
    closeBase[field] = floor;
    charged[field] = price;
    cashback[CASHBACK_FIELD[field]] = price - floor;
  }
  cashback.totalCop = cashback.deliveredCop + cashback.failedCop + cashback.fulfillmentCop;
  return { charged, base: closeBase, cashback };
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
  /**
   * RF_14: la marca del lider tambien en el panel de sus tiendas. Viaja por aqui y no leyendo el
   * documento de la comunidad, porque las reglas se lo niegan a la tienda — y hacen bien: ese
   * documento lleva el correo y el telefono del lider.
   */
  logoPath: string | null;
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
  community: (CommunityLike & { name?: string; logoPath?: string }) | undefined,
  nowIso: string
): StoreTariffView {
  const current = resolveCommunityPricing(base, community, nowIso);
  const now = Date.parse(nowIso);
  const scheduled: Partial<Record<CommunityPricingField, StoreTariffRaiseNotice>> = {};

  // RF_20: una comunidad sin lider —o desactivada— no puede anunciar una subida. Su precio propio
  // ya no se cobra, asi que la fecha prometida no traeria ningun cambio: seria avisarle a la
  // tienda de un cobro que no va a existir. No basta con que `current` caiga a la base, porque el
  // aviso se calcula contra `change.toCop`, que sigue por encima.
  const cobraPropio = chargesOwnPricing(community);
  for (const field of COMMUNITY_PRICING_FIELDS) {
    const change = cobraPropio ? community.scheduled?.[field] : undefined;
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
    logoPath: community && typeof community.logoPath === "string" && community.logoPath.trim() ? community.logoPath : null,
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

/**
 * RF_13 de la 004: que conceptos subieron de base al guardar los ajustes, y hasta donde.
 *
 * Recibe los ajustes CRUDOS (`settings/global` antes y despues), no tarifas ya resueltas, a
 * proposito: la base que se compara es la de RF_01, `communityBase(resolveTariffs(ajustes))`, la
 * misma que cobra el cierre. Antes se comparaba el ajuste crudo, y en produccion el fallido del
 * ajuste dice 9.000 mientras se cobra el fijo de 12.000: subir el ajuste a 11.000 elevaba a los
 * lideres a un piso que no era el de nadie, con aviso e historial de una subida que no ocurrio.
 * Resolviendo aqui dentro, ningun llamador puede olvidarse de hacerlo.
 *
 * Lo mismo cubre dos casos mas sin reglas propias: un campo que no es tarifa (textos, plazos)
 * no mueve la base, y un concepto ausente que se guarda con su valor por defecto tampoco.
 *
 * Solo sube lo que sube estrictamente: una base que baja no toca a nadie.
 */
export function raisedCommunityFloors(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Partial<PricingValues> {
  const baseBefore = communityBase(resolveTariffs(before));
  const baseAfter = communityBase(resolveTariffs(after));
  const floors: Partial<PricingValues> = {};
  for (const field of COMMUNITY_PRICING_FIELDS) {
    if (baseAfter[field] > baseBefore[field]) floors[field] = baseAfter[field];
  }
  return floors;
}

/**
 * RF_13, RF_14 de la 004 (y RF_35 de la 001): que comunidades elevar a unos pisos dados, que
 * conceptos y con que historial. PURO. No sabe de donde salen los pisos: el trigger se los pide a
 * `raisedCommunityFloors`, y la pasada unica de RF_14 le pasa la base real entera, sin "antes".
 *
 * Solo mira los conceptos presentes en `floors`, en el orden de `COMMUNITY_PRICING_FIELDS`.
 *
 * Dos criterios, heredados de T47 sin cambios:
 *
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
export function planRaiseToFloors(input: {
  floors: Partial<PricingValues>;
  communities: CommunityLike[];
  nowIso: string;
}): CommunityFloorRaise[] {
  const { floors, communities, nowIso } = input;
  const targetFields = COMMUNITY_PRICING_FIELDS.filter((field) => typeof floors[field] === "number");

  const changes: CommunityFloorRaise[] = [];
  for (const community of communities) {
    const current = applyScheduledChanges(community, nowIso);
    const fields: CommunityPricingField[] = [];
    const communityUpdate: Record<string, string | number> = {};
    const deleteFields: string[] = [];
    const historyEntries: FloorPriceHistoryEntry[] = [];

    for (const field of targetFields) {
      const floor = Number(floors[field]);
      const currentCop = Number(current[field]);
      // Sin precio propio no hay nada que elevar: esa comunidad ya cobra la base (RF_20).
      if (!Number.isFinite(currentCop) || currentCop >= floor) continue;

      fields.push(field);
      communityUpdate[`pricing.${field}`] = floor;
      // El aviso al lider (spec 004 §6): esta marca mas la entrada de historial de abajo.
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

  return changes;
}

/**
 * RF_13: el plan entero de un guardado de ajustes. Es la composicion de las dos mitades:
 * `raisedCommunityFloors` decide que conceptos subieron de base REAL —no de ajuste crudo— y
 * `planRaiseToFloors` que comunidades hay que elevar. El trigger de `settings/global` lo llama
 * tal cual, y lo llama tambien con `communities: []` como corte barato antes de leer Firestore.
 *
 * Si ninguna base sube (un guardado de textos, el fallido del ajuste que el fijo de 12.000
 * ignora), el plan sale vacio y no se escribe absolutamente nada.
 */
export function planFloorRaise(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  communities: CommunityLike[];
  nowIso: string;
}): FloorRaisePlan {
  const { before, after, communities, nowIso } = input;
  const floors = raisedCommunityFloors(before, after);
  const raisedFields = COMMUNITY_PRICING_FIELDS.filter((field) => typeof floors[field] === "number");
  if (raisedFields.length === 0) return { raisedFields: [], communities: [] };
  return { raisedFields, communities: planRaiseToFloors({ floors, communities, nowIso }) };
}
