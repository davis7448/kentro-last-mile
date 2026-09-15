import type {
  BulkSignupDisableFailureReason,
  BulkSignupDisableReport,
  BulkSignupDisableSkipReason
} from "../../functions/src/community-containment";
import type { CommunityStats } from "../../functions/src/community-stats-math";
import type { CommunityLike, CommunityPricingField } from "../../functions/src/community-pricing";
import {
  buildStoreTariffView,
  resolveCommunityPricing,
  scheduleEffectiveAt
} from "../../functions/src/community-pricing";
import { communityBase, resolveTariffs, type SellerFeeValues, type Tariffs } from "../../functions/src/seller-charges";
import { normalizeSlug, validateSlug } from "../../functions/src/community-slug";
import type { Role } from "./types";

/**
 * Etiquetas visibles de cada rol.
 *
 * Existe por una colision de nombres real: `driver` se llama "Lider logistico" en toda la
 * interfaz desde antes de que existiera el lider de comunidad. Escribir "Lider" a secas en
 * cualquiera de los dos hace que el equipo confunda a quien reparte con quien agrupa tiendas.
 */
export function roleLabel(role: Role): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "seller":
      return "Vendedor";
    case "seller_logistics":
      return "Logistico tienda";
    case "driver":
      return "Lider logistico";
    case "messenger":
      return "Mensajero";
    case "community_leader":
      return "Lider de comunidad";
  }
}

/**
 * RF_14, RF_15: que marca se pinta. Con logo del lider, el suyo; sin el, el de la plataforma.
 * Nunca un hueco ni una imagen rota, que es lo que pasa si se confia en que el campo exista.
 */
export type Brand = { kind: "community"; name: string; logoPath: string } | { kind: "platform"; name: string };

export function brandFor(community?: { name?: string; logoPath?: string | null }): Brand {
  const logoPath = typeof community?.logoPath === "string" ? community.logoPath.trim() : "";
  const name = typeof community?.name === "string" ? community.name.trim() : "";
  if (logoPath && name) return { kind: "community", name, logoPath };
  return { kind: "platform", name: "Kentro" };
}

// --- Contencion de un enlace filtrado (RF_41, RF_42) ---------------------------------------

/**
 * RF_42: los rotulos hablan SOLO de accesos y de cuentas. Ni pedidos, ni asientos, ni cortes,
 * ni una sola palabra de borrado: la contencion no borra nada, y decir lo contrario engana
 * igual que un contador mal sumado. El orden de las claves es el del enumerado del nucleo, y
 * es el orden en que se pintan los grupos.
 */
export const BULK_DISABLE_FAILURE_LABELS: Record<BulkSignupDisableFailureReason, string> = {
  no_contact_email: "Sin correo de contacto: no hay acceso que buscar",
  auth_lookup_failed: "No se pudo consultar el acceso",
  no_auth_user: "No existe una cuenta con ese correo",
  auth_update_failed: "El acceso sigue abierto: fallo el cierre",
  not_attempted: "No se llego a intentar"
};

/** Los motivos por los que el filtro dejo una tienda intacta. No son fallos. */
export const BULK_DISABLE_SKIP_LABELS: Record<BulkSignupDisableSkipReason, string> = {
  other_community: "De otra comunidad",
  out_of_range: "Fuera del rango elegido",
  no_join_date: "Sin fecha de ingreso",
  invalid_join_date: "Fecha de ingreso ilegible"
};

/**
 * `none` mientras no conste ni un acceso cerrado —veinte fallos son cero contencion, y un rango
 * que no alcanzo a ninguna tienda tampoco contiene nada—; `partial` en cuanto haya un solo
 * fallo junto a los cierres. Que queden tiendas intactas no lo impide: son las que el filtro
 * dejo fuera a proposito.
 */
export type BulkSignupDisableOutcome = "contained" | "partial" | "none";

export type BulkSignupDisableTally<R extends string> = {
  reason: R;
  label: string;
  count: number;
  sellerIds: string[];
};

export type BulkSignupDisableView = {
  communityId: string;
  fromIso: string;
  toIso: string;
  outcome: BulkSignupDisableOutcome;
  /** Los cuatro repartos, cada uno por su lado. Sin un total: fundirlos ES el fallo. */
  counts: { disabled: number; failed: number; untouched: number; blocked: number };
  disabled: { sellerId: string; authUids: string[] }[];
  failures: BulkSignupDisableTally<BulkSignupDisableFailureReason>[];
  skipped: BulkSignupDisableTally<BulkSignupDisableSkipReason>[];
  blocked: string[];
};

/**
 * Agrupa por motivo recorriendo el ENUMERADO, no el informe: si el orden dependiera de como
 * fueran llegando las respuestas de Auth, la misma operacion se leeria distinta cada vez que se
 * corre. Los motivos que no ocurrieron no salen —un grupo en cero es ruido en una pantalla de
 * emergencia— y dentro de cada grupo las tiendas conservan el orden del informe.
 */
function tallyByReason<R extends string>(
  entries: readonly { sellerId: string; reason: R }[],
  labels: Record<R, string>
): BulkSignupDisableTally<R>[] {
  const reasons = Object.keys(labels) as R[];
  return reasons
    .map((reason) => {
      const sellerIds = entries.filter((entry) => entry.reason === reason).map((entry) => entry.sellerId);
      return { reason, label: labels[reason], count: sellerIds.length, sellerIds };
    })
    .filter((group) => group.count > 0);
}

/**
 * Lo que el administrador LEE despues de una desactivacion en bloque.
 *
 * `summarizeBulkSignupDisable` (T32) ya reparte cada tienda planeada entre desactivadas,
 * fallidas, intactas y selladas, cada una con su motivo de un enumerado cerrado. Eso cierra el
 * fallo mudo en el servidor; esto cierra la otra mitad, que es la unica que alguien mira.
 *
 * El modo de fallo peligroso no es contener de mas, sino de menos: quien lee "18 tiendas
 * desactivadas" da la fuga por contenida y se va. Si las fallidas se sumaran con las cerradas,
 * o las intactas se agruparan en un numero sin motivo, volveria el mismo fallo que T32 acaba de
 * cerrar, ahora en la interfaz y sin que nada se ponga rojo. Por eso el mapeo es una funcion
 * pura y no vive inline en la pantalla: aqui se puede probar.
 */
export function buildBulkSignupDisableView(report: BulkSignupDisableReport): BulkSignupDisableView {
  const outcome: BulkSignupDisableOutcome =
    report.disabled.length === 0 ? "none" : report.failed.length > 0 ? "partial" : "contained";

  return {
    communityId: report.communityId,
    fromIso: report.fromIso,
    toIso: report.toIso,
    outcome,
    counts: {
      disabled: report.disabled.length,
      failed: report.failed.length,
      untouched: report.untouched.length,
      blocked: report.blocked.length
    },
    // Una tienda puede tener mas de una cuenta con su correo. El informe las devuelve en crudo
    // (T32) y esta vista no es quien para reducirlas a un numero.
    disabled: report.disabled.map((entry) => ({ sellerId: entry.sellerId, authUids: [...entry.authUids] })),
    failures: tallyByReason(report.failed, BULK_DISABLE_FAILURE_LABELS),
    skipped: tallyByReason(report.untouched, BULK_DISABLE_SKIP_LABELS),
    blocked: [...report.blocked]
  };
}

// --- La comunidad que todavia no tiene tiendas (RF_32) ---------------------------------------

/**
 * RF_32: la RUTA de invitacion de una comunidad, o `null` si todavia no hay slug que repartir.
 *
 * Ruta y no URL a proposito: el origen lo pone la pantalla, que es quien vive en el navegador.
 * Asi esto se puede probar sin `window`, y una funcion de dominio no queda atada a que exista.
 *
 * El `null` es el punto entero de la funcion. La plantilla que habia en el JSX interpolaba el
 * slug tal cual, asi que una comunidad recien creada producia una ruta con un hueco dentro:
 * copiable, mandable por WhatsApp y abrible, y llevaba a una pantalla de registro que no
 * resuelve ninguna comunidad. El lider no tenia forma de enterarse de que repartia una ruta
 * rota. Y es justo la comunidad SIN TIENDAS —la que describe RF_32— la que mas probablemente no
 * tiene slug aun, porque nunca ha captado a nadie por el enlace. Se recorta ademas porque un
 * espacio al final se escapa a `%20` al pegarlo y deja de resolver la comunidad: el mismo
 * enlace roto con otra cara.
 */
export function communityInvitePath(community: { slug?: string | null }): string | null {
  const slug = typeof community?.slug === "string" ? community.slug.trim() : "";
  return slug.length > 0 ? `/registro/${slug}` : null;
}

export type EmptyCommunityView = {
  hasStores: boolean;
  totals: CommunityStats["totals"];
  invitePath: string | null;
};

/**
 * RF_32: lo que ve un lider cuya comunidad todavia no tiene tiendas.
 *
 * Las cifras en cero Y el enlace, juntos y decididos en el mismo sitio: el panel no puede
 * quedarse en blanco, y el enlace es lo unico accionable que tiene un lider sin tiendas. Los
 * totales se pasan tal cual salen de `buildCommunityStats` —la vista no reinterpreta un cero ni
 * lo esconde por serlo, que es justo como un panel acaba en blanco—, y que falte el enlace no
 * puede llevarse las cifras por delante: sin slug se pintan igual, solo que sin nada que
 * repartir.
 */
export function buildEmptyCommunityView(
  community: { slug?: string | null },
  stats: CommunityStats
): EmptyCommunityView {
  return {
    hasStores: stats.emptiness !== "no_stores",
    totals: stats.totals,
    invitePath: communityInvitePath(community)
  };
}

// --- El cashback que ya se pago (RF_49) -------------------------------------------------------

/**
 * RF_49: cuanto cashback de esta comunidad esta YA PAGADO, sumando los cortes del propio lider.
 *
 * Se calcula en cliente por una razon concreta: lo pagado no se puede agregar en servidor sin
 * denormalizar el estado del corte en cada asiento de wallet, y duplicar ese dato es justo la
 * clase de dependencia fragil que acaba divergiendo. Los cortes del lider, en cambio, ya los
 * descarga el rol para pintar su propia pantalla, asi que la cifra sale de datos que estan a mano.
 *
 * Causado y pagado son DOS cifras distintas y ninguna sustituye a la otra: lo causado es lo que la
 * comunidad ha generado; lo pagado es lo que ya salio de caja. Mientras el corte siga `pending`,
 * el cashback esta causado y PENDIENTE, y por eso no suma aqui — contarlo como pagado le diria al
 * lider que ya cobro un dinero que todavia se le debe.
 *
 * `netCop` ausente, nulo o ilegible cuenta como 0 y nunca produce `NaN`: un solo asiento sucio
 * contaminaria el total entero y la pantalla mostraria "NaN" donde deberia ir una cifra de dinero.
 * Un string numerico si cuenta, via `Number(...)`, que es lo que hace el codigo de hoy.
 */
export function communityCashbackPaidCop(
  settlements: { kind: string; ownerId: string; status: string; netCop: number }[],
  communityId: string
): number {
  return settlements
    .filter((item) => item.kind === "community_leader" && item.ownerId === communityId)
    .filter((item) => item.status === "paid" || item.status === "reconciled")
    .reduce((total, item) => total + (Number(item.netCop) || 0), 0);
}

// --- El corte de cashback que hay que girarle al lider (RF_49) --------------------------------

/** Lo que necesita una fila de liquidacion de lider para pintarse y para viajar al callable. */
export type CommunityLeaderLiquidationRow = {
  communityId: string;
  communityName: string;
  leaderName: string;
  /** Los asientos que ese corte va a sellar. Sin ellos el corte se crea y no sella nada. */
  walletEntryIds: string[];
  orderIds: string[];
  orders: number;
  /** Neto: las reversas restan y el resultado NO se recorta a cero. */
  cashbackCop: number;
};

type CommunityLeaderEntryLike = {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  amountCop: number;
  orderId?: string;
  settlementId?: string;
};

type CommunityCatalogEntry = { id: string; name: string; leaderName?: string };

/** Un texto que se pueda leer, o el respaldo. Nunca un hueco en una tabla de dinero. */
function nonEmptyText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : fallback;
}

/** Un importe sucio vale 0 y jamas NaN: un solo asiento roto pinta "NaN" donde va la plata. */
function copOrZero(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * RF_49: las filas de "cashback pendiente por girar" de la pantalla de liquidaciones.
 *
 * Va aparte de `LiquidationRow` (operations-app.tsx) a proposito: aquel tipo lleva un
 * `role: "seller" | "driver"` que gobierna una quincena de ramas de render y de acciones, y
 * ensancharlo para meter una tercera figura obligaria a revisarlas todas. El precedente es
 * `buildSupplierLiquidationRows`, que hizo lo mismo con los proveedores.
 *
 * Reglas que no son evidentes y que estan atadas en `community-view.test.ts`:
 *
 * - El filtro mira `ownerType` Y `type`. `ownerId` no es unico entre colecciones: una tienda y
 *   una comunidad pueden compartir id, y filtrar solo por el le giraria al lider el saldo de una
 *   tienda entera.
 * - Entra solo lo que NO tiene `settlementId`. Un asiento ya cortado que vuelve a entrar le
 *   cuesta a la plataforma el mismo cashback dos veces.
 * - La suma es NETA. `correctOrderStatus` compensa un cashback ya causado con un asiento
 *   negativo en el periodo abierto; sumar solo los positivos paga un pedido que acabo fallido. Y
 *   no se recorta a cero: un neto negativo es un descuento del proximo giro, que es lo que es.
 * - La fila existe si hay ASIENTOS pendientes, no si el neto es positivo. Con un neto de cero
 *   exacto (un cashback y su reversa) hay que cortar igual: si no, ese par queda pendiente para
 *   siempre y muerde el neto del mes siguiente.
 * - Una comunidad que no esta en el catalogo produce fila igual, con nombres de respaldo. El
 *   catalogo llega recortado por rol, y perder la fila seria bajar un saldo en silencio, que es
 *   justo la regla 5 del proyecto.
 * - El orden sale del catalogo (las huerfanas detras, por id), nunca del orden en que Firestore
 *   entregue los asientos: si las filas bailan entre renders, se marca pagado el corte de otra
 *   comunidad.
 */
export function buildCommunityLeaderLiquidationRows(
  communities: CommunityCatalogEntry[],
  entries: CommunityLeaderEntryLike[]
): CommunityLeaderLiquidationRow[] {
  const pendingByCommunity = new Map<string, CommunityLeaderEntryLike[]>();
  for (const entry of entries) {
    if (entry?.ownerType !== "community_leader") continue;
    if (entry.type !== "community_cashback") continue;
    if (nonEmptyText(entry.settlementId, "") !== "") continue;
    const communityId = nonEmptyText(entry.ownerId, "");
    if (!communityId) continue;
    const bucket = pendingByCommunity.get(communityId);
    if (bucket) bucket.push(entry);
    else pendingByCommunity.set(communityId, [entry]);
  }

  const known = new Set(communities.map((community) => community.id));
  const orphanIds = [...pendingByCommunity.keys()].filter((id) => !known.has(id)).sort();

  const buildRow = (
    communityId: string,
    catalog: CommunityCatalogEntry | undefined
  ): CommunityLeaderLiquidationRow => {
    const own = pendingByCommunity.get(communityId) ?? [];
    const orderIds: string[] = [];
    const seenOrders = new Set<string>();
    for (const entry of own) {
      const orderId = nonEmptyText(entry.orderId, "");
      // Los ajustes manuales de cashback no cuelgan de ningun pedido: un "" en la lista viaja al
      // callable y deja el corte apuntando a un pedido que no existe.
      if (!orderId || seenOrders.has(orderId)) continue;
      seenOrders.add(orderId);
      orderIds.push(orderId);
    }
    return {
      communityId,
      communityName: nonEmptyText(catalog?.name, `Comunidad ${communityId}`),
      leaderName: nonEmptyText(catalog?.leaderName, "Lider sin registrar"),
      walletEntryIds: own.map((entry) => entry.id),
      orderIds,
      orders: orderIds.length,
      cashbackCop: own.reduce((total, entry) => total + copOrZero(entry.amountCop), 0)
    };
  };

  return [
    ...communities
      .filter((community) => pendingByCommunity.has(community.id))
      .map((community) => buildRow(community.id, community)),
    ...orphanIds.map((communityId) => buildRow(communityId, undefined))
  ];
}

// --- La lista de comunidades del administrador (RF_34) ----------------------------------------

/**
 * RF_12: lo que la fila NO puede decir con una cifra. La base del panel es la de los ajustes, sin
 * zona; en un pedido con zona el cierre cobra la base de la zona si es mayor, y ese pedido deja
 * menos cashback o ninguno. Se muestra junto a los precios en vez de calcular una base por zona:
 * casi ningun pedido lleva zona, y el panel no descarga pedidos ni zonas (RNF_02).
 */
export const ZONE_BASE_NOTICE =
  "En pedidos con zona la base puede ser mayor que la mostrada: en ese caso se cobra la base y el cashback de ese pedido es menor o cero.";

/** De donde sale lo que se cobra en un concepto: la base de Kentro o el precio propio del lider. */
export type AdminPriceSource = "base" | "leader";

/**
 * Un concepto tal y como se le cobraria HOY a un pedido sin zona de la comunidad (RF_07).
 *
 * `upcoming` va aparte y nunca dentro de `chargedCop` ni de `marginCop` (RF_15): la subida de
 * manana no se cobra hoy, y sumarla le haria creer al admin que la comunidad ya deja ese margen.
 */
export type AdminConceptPrice = {
  /** Lo que cobra el cierre: el precio del lider con las programadas vencidas, llevado al piso. */
  chargedCop: number;
  /** La base de RF_01: `communityBase(resolveTariffs(settings))`, sin zona. */
  baseCop: number;
  /** `chargedCop - baseCop`. No sale negativo: el piso de `resolveCommunityPricing` lo impide. */
  marginCop: number;
  source: AdminPriceSource;
  /** La subida programada que aun no entra en vigor, o `null` si no queda ninguna. */
  upcoming: { toCop: number; effectiveAt: string } | null;
};

/**
 * RF_08: por que la comunidad cobra SOLO la base aunque tenga precios guardados. Es `null` cuando
 * cobra su precio propio, aunque algun concepto salga a la base por el piso o por no tenerlo: ese
 * caso ya lo cuenta el rotulo "base" y no tiene otro motivo que inventar.
 */
export type AdminBaseOnlyReason = "no_leader" | "disabled";

/**
 * Una fila de la tarjeta de comunidades del admin.
 *
 * NO lleva `linkStatus` ni `status` crudos: son estado del documento y la pantalla los lee de
 * `community`. Lo que si lleva es `baseOnlyReason`, que se DERIVA del estado para explicar por que
 * no se cobra el precio guardado: decidirlo en el JSX abriria un segundo criterio de "sin lider"
 * que divergiria del que usa el cobro.
 */
export type AdminCommunityRow = {
  communityId: string;
  name: string;
  leaderName: string;
  stores: number;
  pricing: Record<CommunityPricingField, AdminConceptPrice>;
  baseOnlyReason: AdminBaseOnlyReason | null;
  /**
   * Cashback CAUSADO: todo lo que la comunidad ha generado, este cortado o no.
   * No confundir con lo pagado (`communityCashbackPaidCop`), que es lo que ya salio de caja.
   */
  cashbackAccruedCop: number;
  /**
   * RF_13: cuanto de `cashbackAccruedCop` lo genero la tienda del PROPIO lider. Cifra aparte y
   * NUNCA restada del total (ver el comentario de `buildAdminCommunityList`). Siempre presente,
   * en cero si no aplica.
   */
  leaderStoreCashbackAccruedCop: number;
};

/**
 * Se apoya en `CommunityLike` —`pricing`, `scheduled`, `leaderUid`, `status`— para que la fila
 * reciba EXACTAMENTE lo que lee `resolveCommunityPricing`: con una forma propia, un campo que el
 * cobro mira y el panel no seria justo el hueco por el que ambos divergen.
 */
type AdminCommunityLike = CommunityLike & {
  name: string;
  leaderName?: string;
  /**
   * CUAL de las tiendas es la del lider. Entra como dato porque este nucleo es puro: no lee
   * reclamos de autenticacion. Quien arma el input lo saca del documento de la comunidad.
   */
  leaderSellerId?: string;
};

type AdminSellerLike = { id: string; communityId?: string };

type AdminCashbackEntryLike = {
  ownerType: string;
  ownerId: string;
  type: string;
  amountCop: number;
  settlementId?: string;
  /** Que tienda lo genero. Puede faltar en asientos antiguos: ver la regla de imputacion. */
  sellerId?: string;
};

/**
 * Un importe cuenta solo si YA es un numero utilizable. Un `"1500"` que viene de un documento mal
 * escrito no se coacciona: sumarlo daria por buena una cifra que nadie escribio como plata, y el
 * siguiente string ("1.500", "1500 COP") sumaria 0 sin avisar. Lo que no sea numero finito vale 0,
 * que es lo unico que no envenena un total entero con `NaN`.
 */
function numericCopOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * RF_08: el MISMO criterio que `chargesOwnPricing` (community-pricing.ts), dicho con su motivo.
 * Un estado ausente no es activo —el lado seguro, igual que en el cobro— y un uid que al
 * recortarlo no deja nada no es un lider. Si el panel recortara distinto que el cobro, la
 * comunidad cobraria la base sin que la fila dijera por que.
 */
function baseOnlyReasonOf(community: CommunityLike): AdminBaseOnlyReason | null {
  if (community.status !== "active") return "disabled";
  if (nonEmptyText(community.leaderUid, "") === "") return "no_leader";
  return null;
}

/**
 * Los tres conceptos de una comunidad como se cobran hoy (RF_07, RF_08, RF_09, RF_15).
 *
 * `chargedCop` sale de `resolveCommunityPricing`, la funcion con la que se congela el pedido, y la
 * subida pendiente de `buildStoreTariffView`, la que ya se la anuncia a la tienda: futura, de una
 * comunidad que cobra su precio propio y por encima de lo que se cobra hoy. Recalcular aqui
 * cualquiera de las dos seria una segunda copia de la regla, y el admin veria una subida que la
 * tienda no ve (o al reves).
 */
function conceptPrices(
  base: SellerFeeValues,
  community: AdminCommunityLike,
  nowIso: string
): Record<CommunityPricingField, AdminConceptPrice> {
  const charged = resolveCommunityPricing(base, community, nowIso);
  const pending = buildStoreTariffView(base, community, nowIso).scheduled;

  const priceOf = (field: CommunityPricingField): AdminConceptPrice => {
    const baseCop = base[field];
    const chargedCop = charged[field];
    const marginCop = chargedCop - baseCop;
    const raise = pending?.[field];
    return {
      chargedCop,
      baseCop,
      marginCop,
      source: marginCop > 0 ? "leader" : "base",
      upcoming: raise ? { toCop: raise.toCop, effectiveAt: raise.effectiveAt } : null
    };
  };

  return {
    sellerDeliveredFeeCop: priceOf("sellerDeliveredFeeCop"),
    sellerFailedFeeCop: priceOf("sellerFailedFeeCop"),
    fulfillmentFeeCop: priceOf("fulfillmentFeeCop")
  };
}

/**
 * RF_34, y desde la spec 004 RF_07/RF_08/RF_09/RF_15: lo que el administrador ve de cada
 * comunidad — quien la lidera, cuantas tiendas tiene, que cobra HOY por cada concepto y cuanto
 * cashback ha causado.
 *
 * Reglas que no son evidentes y que estan atadas en `community-view.test.ts`:
 *
 * - **Se pinta lo que se COBRA, no lo que esta guardado (RF_07).** Antes cada concepto era "el
 *   precio propio si lo hay, y si no el ajuste global". Asi E-master, sin precio propio, ensenaba
 *   "Fallido $9.000" —el ajuste crudo— mientras el cierre cobraba el fijo: nadie cobraba 9.000 y
 *   con ese numero se decidian precios. Ahora la base es `communityBase(resolveTariffs(settings))`
 *   y el precio `resolveCommunityPricing(...)`, las MISMAS funciones del cobro. Ni copia del fijo
 *   del fallido ni piso propio aqui: panel y cobro no pueden divergir porque son la misma cuenta.
 * - **La base es la de los ajustes, SIN zona (RNF_02).** La firma no recibe zonas ni pedidos: el
 *   admin no descarga nada nuevo para pintar la fila. Lo que cambia con zona lo cuenta
 *   `ZONE_BASE_NOTICE` (RF_12), no una cifra.
 * - **El margen es `cobrado - base`, y el rotulo sale de el (RF_08, RF_09).** Un precio guardado
 *   por debajo de la base, igual a ella, a cero o ausente se cobra a la base: rotulo "base" y
 *   margen 0. `baseOnlyReason` solo dice algo cuando el motivo es el estado de la comunidad.
 * - **Una subida pendiente va aparte (RF_15)**, nunca sumada al precio ni al margen de hoy. Una ya
 *   vencida, en cambio, esta dentro de `chargedCop`: es lo que se cobra.
 * - `nowIso` entra por parametro: el nucleo no inventa el reloj, y las programadas dependen de el.
 * - **Sale una fila por comunidad del catalogo, siempre.** Una recien creada, sin tiendas y sin un
 *   solo asiento, se pinta con ceros. Si desapareciera de la lista por no tener movimiento, el
 *   admin no podria ni ver su enlace ni corregirle los precios: justo la comunidad que mas lo
 *   necesita. Y aqui no hay fila huerfana (a diferencia de `buildCommunityLeaderLiquidationRows`):
 *   el admin descarga el catalogo entero, asi que un `ownerId` que no este en el es un id muerto,
 *   no una comunidad que falte.
 * - **El causado suma TODOS los asientos, con `settlementId` o sin el.** Es la diferencia con las
 *   filas de liquidacion, que solo miran lo pendiente por girar. Filtrar por pendiente aqui dejaria
 *   la cifra en cero en cuanto se hiciera el primer corte, y las comunidades mas productivas —las
 *   que ya cobraron— se leerian como si no generaran nada.
 * - La suma es NETA: `correctOrderStatus` compensa un cashback ya causado con un asiento negativo,
 *   y sumar en valor absoluto haria que una entrega revertida pareciera generar el doble.
 * - El filtro mira `ownerType` Y `type`. `ownerId` no es unico entre colecciones, y la wallet del
 *   lider tambien lleva pagos de corte: sumarlo todo infla la cifra con la que se deciden precios.
 * - El orden es el del catalogo, nunca el orden en que Firestore entregue asientos o tiendas.
 * - **RF_13: la tienda del propio lider sale APARTE, nunca restada.** Que un lider tenga tienda en
 *   la comunidad que lidera es normal —suele ser el primer vendedor—, y los cortes le cobran ese
 *   cashback como a cualquier otra tienda. Restarlo de `cashbackAccruedCop` para que "no contamine"
 *   descuadraria el panel con la caja: el total dejaria de coincidir con lo que se gira. Por eso
 *   RF_14 se mantiene intacto —la tienda del lider cuenta como una tienda mas en `stores` y su
 *   cashback suma al total— y RF_13 se satisface con una SEGUNDA cifra,
 *   `leaderStoreCashbackAccruedCop`, que responde "cuanto de esto vuelve al bolsillo de quien fija
 *   el precio". Dos numeros, no uno.
 * - **El campo existe siempre, con cero cuando no aplica.** Un `undefined` es un hueco que nadie
 *   audita: quien lee la fila no puede distinguir "no genero nada" de "nadie lo calculo".
 * - **Un asiento sin `sellerId` suma al total y NO se imputa al lider.** Los asientos antiguos no
 *   llevan tienda; atribuirlos al lider por defecto seria inventarse una cifra, y justo la cifra
 *   con la que se le audita. Sin dato, no hay imputacion.
 * - **La tienda del lider tiene que estar en SU comunidad.** Un lider puede vender en otra
 *   comunidad (pasa): ese cashback no es suyo como lider, y su cifra aqui es cero.
 */
export function buildAdminCommunityList(input: {
  communities: AdminCommunityLike[];
  sellers: AdminSellerLike[];
  entries: AdminCashbackEntryLike[];
  /** La tarifa global ENTERA (`state.settings`): de ella sale la base, sin zona. */
  settings: Partial<Tariffs>;
  nowIso: string;
}): AdminCommunityRow[] {
  const { communities, sellers, entries, settings, nowIso } = input;

  // Una sola base para todas las filas: no depende de la comunidad, solo de los ajustes.
  const base = communityBase(resolveTariffs(settings));

  // Un recorrido por coleccion en vez de un filtro por comunidad: con el catalogo entero y la
  // wallet completa del admin, lo segundo es cuadratico.
  const storesByCommunity = new Map<string, number>();
  for (const seller of sellers) {
    const communityId = nonEmptyText(seller?.communityId, "");
    if (!communityId) continue;
    storesByCommunity.set(communityId, (storesByCommunity.get(communityId) ?? 0) + 1);
  }

  // De que comunidad es cada tienda. Hace falta para no imputarle al lider el cashback que su
  // tienda genero en una comunidad que NO lidera.
  const communityBySeller = new Map<string, string>();
  for (const seller of sellers) {
    const sellerId = nonEmptyText(seller?.id, "");
    const communityId = nonEmptyText(seller?.communityId, "");
    if (sellerId && communityId) communityBySeller.set(sellerId, communityId);
  }

  // La tienda del lider de cada comunidad, solo si vive DENTRO de ella.
  const leaderStoreByCommunity = new Map<string, string>();
  for (const community of communities) {
    const leaderSellerId = nonEmptyText(community?.leaderSellerId, "");
    if (!leaderSellerId) continue;
    if (communityBySeller.get(leaderSellerId) !== community.id) continue;
    leaderStoreByCommunity.set(community.id, leaderSellerId);
  }

  const accruedByCommunity = new Map<string, number>();
  const leaderStoreAccruedByCommunity = new Map<string, number>();
  for (const entry of entries) {
    if (entry?.ownerType !== "community_leader") continue;
    if (entry.type !== "community_cashback") continue;
    const communityId = nonEmptyText(entry.ownerId, "");
    if (!communityId) continue;
    const amountCop = numericCopOrZero(entry.amountCop);
    accruedByCommunity.set(communityId, (accruedByCommunity.get(communityId) ?? 0) + amountCop);

    // El desglose se SUMA aparte sobre el mismo asiento; nunca se descuenta del total de arriba.
    const sellerId = nonEmptyText(entry.sellerId, "");
    if (!sellerId) continue;
    if (leaderStoreByCommunity.get(communityId) !== sellerId) continue;
    leaderStoreAccruedByCommunity.set(
      communityId,
      (leaderStoreAccruedByCommunity.get(communityId) ?? 0) + amountCop
    );
  }

  return communities.map((community) => ({
    communityId: community.id,
    name: nonEmptyText(community.name, `Comunidad ${community.id}`),
    leaderName: nonEmptyText(community.leaderName, "Lider sin registrar"),
    stores: storesByCommunity.get(community.id) ?? 0,
    pricing: conceptPrices(base, community, nowIso),
    baseOnlyReason: baseOnlyReasonOf(community),
    cashbackAccruedCop: accruedByCommunity.get(community.id) ?? 0,
    leaderStoreCashbackAccruedCop: leaderStoreAccruedByCommunity.get(community.id) ?? 0
  }));
}

// --- El lider que se cambia el precio a su propia tienda (RF_24) ------------------------------

/** Los tres conceptos, con el mismo rotulo que ya lee la tienda en "Tu tarifa". */
const LEADER_PRICING_LABELS: Record<CommunityPricingField, string> = {
  sellerDeliveredFeeCop: "Flete por entrega",
  sellerFailedFeeCop: "Cobro por fallido",
  fulfillmentFeeCop: "Manejo desde bodega"
};

/** Pesos con separador de miles. Un aviso que dice "15000" se lee mal justo cuando importa. */
function copText(value: number): string {
  const amount = Number.isFinite(value) ? Math.round(value) : 0;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("es-CO")}`;
}

export type LeaderPriceChangeNotice = {
  field: CommunityPricingField;
  fromCop: number;
  toCop: number;
  isRaise: boolean;
  /** RF_24: si el que cambia el precio se lo cambia (tambien) a si mismo. */
  affectsLeaderOwnStore: boolean;
  /** El mismo plazo que para cualquier otro cambio. Sin excepcion. */
  effectiveAt: string;
  /** El aviso al administrador. `null` cuando el lider no tiene tienda en su comunidad. */
  adminAlert: string | null;
};

/**
 * RF_24: que se marca y que se le avisa al administrador cuando un lider mueve un precio de su
 * comunidad teniendo tienda dentro de ella.
 *
 * Tres decisiones que no son evidentes y que estan atadas en `community-view.test.ts`:
 *
 * - **La fecha de vigencia sale de `scheduleEffectiveAt` y de ningun otro sitio.** Ni siquiera en
 *   el caso en que la UNICA tienda afectada es la del propio lider: el atajo tentador ahi es "que
 *   entre ya, nadie mas se entera", y es falso dos veces —el plazo de RF_28 es del precio, no de a
 *   quien le duela, y manana esa comunidad puede tener tiendas ajenas pagando un precio que subio
 *   sin aviso—. Reimplementar el plazo aqui crearia una segunda copia de la regla que divergiria.
 * - **El aviso NO depende del sentido del cambio.** Una bajada tambien se avisa: el conflicto de
 *   interes es que quien decide el precio es parte interesada, y eso existe igual bajando. Ademas
 *   una bajada entra en el acto, asi que es el caso en el que el admin tiene MENOS margen.
 * - **Sin tienda del lider en la comunidad no se fabrica un aviso.** Un aviso que salta siempre es
 *   un aviso que el admin aprende a ignorar, y entonces tampoco vera el que si importa.
 */
export function buildLeaderPriceChangeNotice(input: {
  communityId: string;
  leaderSellerId?: string;
  sellers: { id: string; communityId?: string }[];
  field: CommunityPricingField;
  fromCop: number;
  toCop: number;
  nowIso: string;
}): LeaderPriceChangeNotice {
  const { communityId, field, fromCop, toCop, nowIso } = input;

  const leaderSellerId = nonEmptyText(input.leaderSellerId, "");
  const community = nonEmptyText(communityId, "");
  // La tienda del lider cuenta solo si esta en la comunidad cuyo precio se esta moviendo: un
  // lider puede vender en otra comunidad, y ahi el cambio no le toca el bolsillo.
  const affectsLeaderOwnStore =
    leaderSellerId !== "" &&
    community !== "" &&
    (input.sellers ?? []).some(
      (seller) =>
        nonEmptyText(seller?.id, "") === leaderSellerId &&
        nonEmptyText(seller?.communityId, "") === community
    );

  const isRaise = toCop > fromCop;
  const effectiveAt = scheduleEffectiveAt(fromCop, toCop, nowIso);

  const adminAlert = affectsLeaderOwnStore
    ? `Conflicto de interes: el lider de la comunidad ${community} ${isRaise ? "sube" : "baja"} ` +
      `"${LEADER_PRICING_LABELS[field]}" de ${copText(fromCop)} a ${copText(toCop)} y su propia ` +
      `tienda (${leaderSellerId}) esta en esa comunidad. Rige desde ${effectiveAt}.`
    : null;

  return { field, fromCop, toCop, isRaise, affectsLeaderOwnStore, effectiveAt, adminAlert };
}

// --- El alta de un lider de comunidad, antes de llamar al servidor (RF_50, RF_02, RF_04) ------

/** Los seis campos del formulario de alta, tal y como los espera `createCommunityLeader`. */
export type CommunityLeaderFormInput = {
  name: string;
  slug: string;
  leaderName: string;
  leaderEmail: string;
  leaderPhone: string;
  password: string;
};

/**
 * En el rechazo viaja el CAMPO, no solo la prosa: RF_04 pide explicar el motivo, y un mensaje
 * suelto encima del formulario obliga a adivinar cual de los seis campos hay que tocar.
 */
export type CommunityLeaderFormResult =
  | { ok: true; value: CommunityLeaderFormInput }
  | { ok: false; field: keyof CommunityLeaderFormInput; reason: string };

/**
 * Los nombres cortos ya tomados, tal y como los tiene la pantalla (crudos: el catalogo guarda
 * el normalizado, pero quien llame no tiene por que saberlo). Se comparan normalizados.
 */
export type CommunityLeaderFormOptions = { takenSlugs?: readonly string[] };

/**
 * Forma de correo. Existe para adelantar el veredicto de `z.string().email()` del servidor, no
 * para ser mas lista que el: un correo que el backend acepta y esta pantalla rechaza es un alta
 * bloqueada sin motivo. Pide algo antes de la arroba, un dominio sin espacios y al menos un
 * punto con extension detras, que es lo que distingue los cuatro casos que fallan de verdad
 * ("marta", "marta@", "@andes.co", "marta andes@x.co").
 */
const LEADER_EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;.]+(?:\.[^\s@,;.]+)+$/;

/** El minimo del servidor, ni uno mas. Vive aqui con nombre para que se vea que esta pegado. */
const LEADER_PASSWORD_MIN = 6;

/**
 * RF_50, RF_02, RF_04: decide si lo tecleado en el alta de un lider de comunidad puede viajar.
 *
 * Existe porque `createCommunityLeader` crea comunidad, reserva de slug y cuenta de Auth en una
 * sola llamada: lo que devuelve cuando algo no cuadra es un `invalid-argument` generico o un
 * `already-exists` sin campo, y el administrador se queda mirando seis casillas sin saber cual
 * corregir. Aqui el error sale CON el campo.
 *
 * Reglas que no son evidentes y que estan atadas en `community-view.test.ts`:
 *
 * - **El orden de comprobacion es el del formulario** (nombre, nombre corto, lider, correo,
 *   telefono, contrasena) y con varios campos mal se senala el primero. Sin un orden fijado,
 *   "que campo se senala" queda al azar del implementador y cambia al reordenar el codigo.
 * - **El motivo del nombre corto es, letra a letra, el de `validateSlug`.** La regla del slug
 *   vive en UN solo sitio (`functions/src/community-slug.ts`, ya probado): reimplementarla aqui
 *   con otra prosa produce dos criterios que divergen en cuanto alguien toque uno.
 * - **El choque con un slug ya tomado se compara NORMALIZADO.** "Comunidad Andes" y
 *   "comunidad-andes" son el mismo enlace; comparar lo tecleado deja pasar el duplicado hasta la
 *   transaccion del servidor, que es justo lo que esto evita.
 * - **`value` sale como lo normaliza el servidor**: recortado, con el slug que devuelve
 *   `validateSlug` y el correo en minusculas. Si la pantalla enviara lo tecleado, el enlace que
 *   se le ensena al lider no seria el suyo y entraria con un correo distinto del que se le dijo.
 * - **La contrasena no se toca: ni `trim`.** Los espacios son parte de la clave, y recortarla
 *   aqui crearia la cuenta con una contrasena distinta de la que el administrador apunto.
 * - **El minimo de contrasena es exactamente el del servidor (6).** Ser mas estricto tambien es
 *   un fallo: bloquea altas que el backend acepta.
 * - No inventa valores por defecto: lo que entra vacio sale rechazado, y nunca deduce el nombre
 *   corto del nombre de la comunidad.
 */
export function validateCommunityLeaderForm(
  input: CommunityLeaderFormInput,
  options?: CommunityLeaderFormOptions
): CommunityLeaderFormResult {
  const reject = (
    field: keyof CommunityLeaderFormInput,
    reason: string
  ): CommunityLeaderFormResult => ({ ok: false, field, reason });

  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name) return reject("name", "Escribe el nombre de la comunidad.");

  const slug = validateSlug(typeof input?.slug === "string" ? input.slug : "");
  if (!slug.ok) return reject("slug", slug.reason);
  const taken = new Set((options?.takenSlugs ?? []).map((value) => normalizeSlug(value)));
  if (taken.has(slug.slug)) {
    return reject("slug", `El nombre corto "${slug.slug}" ya esta en uso por otra comunidad. Elige otro.`);
  }

  const leaderName = typeof input?.leaderName === "string" ? input.leaderName.trim() : "";
  if (!leaderName) return reject("leaderName", "Escribe el nombre del lider.");

  const leaderEmail = typeof input?.leaderEmail === "string" ? input.leaderEmail.trim().toLowerCase() : "";
  if (!leaderEmail) return reject("leaderEmail", "Escribe el correo con el que entrara el lider.");
  if (!LEADER_EMAIL_SHAPE.test(leaderEmail)) {
    return reject("leaderEmail", "Ese correo no tiene forma de correo. Revisa la arroba y el dominio.");
  }

  const leaderPhone = typeof input?.leaderPhone === "string" ? input.leaderPhone.trim() : "";
  if (!leaderPhone) return reject("leaderPhone", "Escribe el telefono del lider.");

  const password = typeof input?.password === "string" ? input.password : "";
  if (password.length < LEADER_PASSWORD_MIN) {
    return reject("password", `La contrasena temporal necesita al menos ${LEADER_PASSWORD_MIN} caracteres.`);
  }

  return { ok: true, value: { name, slug: slug.slug, leaderName, leaderEmail, leaderPhone, password } };
}

/**
 * RF_50: si no hay ninguna comunidad, el panel que las crea se abre solo.
 *
 * El formulario de alta vive FUERA de `AdminCommunitiesPanel` para que no desaparezca cuando no
 * hay comunidades — pero el desplegable que lo contiene arranca cerrado, y se tragaba esa misma
 * intencion: con cero comunidades, un administrador veia una linea plegada ("Comunidades · 0 con
 * enlace propio") indistinguible de una seccion sin nada que hacer. El sitio donde se crea la
 * primera comunidad no puede estar escondido justo cuando no hay ninguna.
 *
 * Mismo patron que ya usan "Incidencias de sincronizacion" y "Solicitudes de instalacion": el
 * panel se abre cuando requiere accion. Aqui lo que la requiere es la ausencia.
 *
 * Una cuenta que no es un numero finito se trata como cero a proposito: abrir de mas cuesta un
 * clic; abrir de menos esconde la unica via de crear la primera comunidad.
 */
export function shouldOpenCommunitiesPanel(communityCount: number): boolean {
  return !Number.isFinite(communityCount) || communityCount <= 0;
}

// --- La OTRA mitad de RF_17: darle el liderazgo a una cuenta que ya existe --------------------

/** Los tres campos de la concesion. Ni contrasena ni telefono: la cuenta ya existe. */
export type CommunityGrantFormInput = { name: string; slug: string; targetEmail: string };

/** Igual que en el alta: en el rechazo viaja el CAMPO, no solo la prosa (RF_04). */
export type CommunityGrantFormResult =
  | { ok: true; value: CommunityGrantFormInput }
  | { ok: false; field: keyof CommunityGrantFormInput; reason: string };

/**
 * RF_17: decide si lo tecleado en la concesion de liderazgo puede viajar a
 * `grantCommunityLeadership`.
 *
 * Existe porque RF_17 pide DOS caminos y solo se construyo uno. El caso real: un administrador
 * intento crear un lider con el correo de una cuenta que YA existe y es una tienda; la
 * precomprobacion de RF_55 lo rechazo limpiamente —bien— pero no habia ninguna forma de darle el
 * liderazgo a esa cuenta. `grantCommunityLeadership` estaba desplegada, sin envoltorio, sin
 * pantalla y exigiendo que la comunidad ya existiera: con cero comunidades el camino estaba
 * cerrado por los dos lados.
 *
 * Es hermano de `validateCommunityLeaderForm` y no una variante suya con campos opcionales:
 * aquel exige los seis, y pasarle esto lo rechazaria por `leaderName` sin que nada este mal.
 * Ablandar aquel para que sirviera a los dos usos convertiria seis campos obligatorios en seis
 * campos "depende", que es como se cuela un alta sin contrasena.
 *
 * Lo que comparte es lo que NO puede divergir:
 *
 * - **La regla del nombre corto es `validateSlug`, letra a letra.** Vive en un solo sitio
 *   (`functions/src/community-slug.ts`, ya probado) y aqui no se reimplementa ni se reescribe su
 *   prosa: dos criterios con dos redacciones divergen en cuanto alguien toque uno.
 * - **El choque con un slug tomado se compara NORMALIZADO** ("Comunidad Andes" y
 *   "comunidad-andes" son el mismo enlace), con el mismo `CommunityLeaderFormOptions`.
 * - **La forma del correo es la misma** (`LEADER_EMAIL_SHAPE`): un correo que el servidor acepta
 *   y esta pantalla rechaza es una concesion bloqueada sin motivo.
 * - **`value` sale NORMALIZADO**: recortado, el slug como lo devuelve `validateSlug` y el correo
 *   en minusculas. La cuenta se busca en Auth por ese correo, y Auth guarda el correo en
 *   minusculas: mandar lo tecleado haria fallar la busqueda de una cuenta que si existe.
 * - **El orden de senalado es el del formulario** (nombre, nombre corto, correo) y con varios
 *   campos mal se senala el primero. Sin un orden fijado, cual se senala cambia al reordenar el
 *   codigo.
 * - No inventa valores por defecto ni deduce el nombre corto del nombre de la comunidad.
 */
export function validateCommunityGrantForm(
  input: CommunityGrantFormInput,
  options?: CommunityLeaderFormOptions
): CommunityGrantFormResult {
  const reject = (
    field: keyof CommunityGrantFormInput,
    reason: string
  ): CommunityGrantFormResult => ({ ok: false, field, reason });

  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name) return reject("name", "Escribe el nombre de la comunidad.");

  const slug = validateSlug(typeof input?.slug === "string" ? input.slug : "");
  if (!slug.ok) return reject("slug", slug.reason);
  const taken = new Set((options?.takenSlugs ?? []).map((value) => normalizeSlug(value)));
  if (taken.has(slug.slug)) {
    return reject("slug", `El nombre corto "${slug.slug}" ya esta en uso por otra comunidad. Elige otro.`);
  }

  const targetEmail = typeof input?.targetEmail === "string" ? input.targetEmail.trim().toLowerCase() : "";
  if (!targetEmail) return reject("targetEmail", "Escribe el correo de la cuenta que va a liderar.");
  if (!LEADER_EMAIL_SHAPE.test(targetEmail)) {
    return reject("targetEmail", "Ese correo no tiene forma de correo. Revisa la arroba y el dominio.");
  }

  return { ok: true, value: { name, slug: slug.slug, targetEmail } };
}

/**
 * RF_14: el distintivo de comunidad que ve una TIENDA en su propio panel.
 *
 * RF_14 pide la marca del lider en dos sitios —la pantalla de registro del enlace y **el panel de
 * las tiendas de su comunidad**— y solo se habia construido el primero.
 *
 * Se alimenta de lo que la tienda ya puede saber: la respuesta de su propia consulta de tarifa. El
 * documento de la comunidad **no** lo puede leer, y las reglas hacen bien en negarlo, porque lleva
 * el correo y el telefono del lider.
 *
 * A diferencia de `brandFor`, **sin logo NO cae a la marca de la plataforma**: pertenecer a una
 * comunidad es un hecho que hay que ensenar, y el nombre basta para decirlo. Caer a "Kentro" le
 * esconderia a la tienda a que comunidad pertenece, que es justo lo que este distintivo existe
 * para decir.
 */
export type CommunityBadge = { kind: "community"; name: string; logoPath: string | null };

export function communityBadgeFor(tariff: {
  communityId: string | null;
  communityName: string | null;
  logoPath?: string | null;
}): CommunityBadge | null {
  const name = typeof tariff.communityName === "string" ? tariff.communityName.trim() : "";
  if (!tariff.communityId || !name) return null;
  const logoPath = typeof tariff.logoPath === "string" && tariff.logoPath.trim() ? tariff.logoPath.trim() : null;
  return { kind: "community", name, logoPath };
}
