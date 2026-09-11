import type {
  BulkSignupDisableFailureReason,
  BulkSignupDisableReport,
  BulkSignupDisableSkipReason
} from "../../functions/src/community-containment";
import type { CommunityStats } from "../../functions/src/community-stats-math";
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

/** Los tres conceptos que una comunidad puede tener a precio propio. */
type AdminCommunityPricing = {
  sellerDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  fulfillmentFeeCop: number;
};

/**
 * Una fila de la tarjeta de comunidades del admin.
 *
 * Deliberadamente NO lleva `linkStatus` ni `status`: son estado del documento, no cifras
 * derivadas, y la pantalla los lee de `community` directamente. Meterlos aqui obligaria a esta
 * funcion a conocer el ciclo de vida del enlace para no ganar nada.
 */
export type AdminCommunityRow = {
  communityId: string;
  name: string;
  leaderName: string;
  stores: number;
  pricing: AdminCommunityPricing;
  /**
   * Cashback CAUSADO: todo lo que la comunidad ha generado, este cortado o no.
   * No confundir con lo pagado (`communityCashbackPaidCop`), que es lo que ya salio de caja.
   */
  cashbackAccruedCop: number;
};

type AdminCommunityLike = {
  id: string;
  name: string;
  leaderName?: string;
  pricing?: { sellerDeliveredFeeCop?: number; sellerFailedFeeCop?: number; fulfillmentFeeCop?: number };
};

type AdminSellerLike = { id: string; communityId?: string };

type AdminCashbackEntryLike = {
  ownerType: string;
  ownerId: string;
  type: string;
  amountCop: number;
  settlementId?: string;
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
 * Precio vigente de un concepto: el propio de la comunidad si lo tiene, y si no el global.
 *
 * `??` y no `||`, y no es un detalle de estilo: una comunidad con un concepto a 0 —envio gratis
 * en fallidos, por ejemplo— es un precio decidido, no un hueco. Con `||` se pintaria el precio
 * global y el admin cobraria de mas creyendo que ve el precio real.
 */
function communityPriceOr(own: number | undefined, fallback: number): number {
  return typeof own === "number" && Number.isFinite(own) ? own : fallback;
}

/**
 * RF_34: lo que el administrador ve de cada comunidad — quien la lidera, cuantas tiendas tiene,
 * a que precios cobra hoy y cuanto cashback ha causado.
 *
 * Reglas que no son evidentes y que estan atadas en `community-view.test.ts`:
 *
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
 */
export function buildAdminCommunityList(input: {
  communities: AdminCommunityLike[];
  sellers: AdminSellerLike[];
  entries: AdminCashbackEntryLike[];
  settings: AdminCommunityPricing;
}): AdminCommunityRow[] {
  const { communities, sellers, entries, settings } = input;

  // Un recorrido por coleccion en vez de un filtro por comunidad: con el catalogo entero y la
  // wallet completa del admin, lo segundo es cuadratico.
  const storesByCommunity = new Map<string, number>();
  for (const seller of sellers) {
    const communityId = nonEmptyText(seller?.communityId, "");
    if (!communityId) continue;
    storesByCommunity.set(communityId, (storesByCommunity.get(communityId) ?? 0) + 1);
  }

  const accruedByCommunity = new Map<string, number>();
  for (const entry of entries) {
    if (entry?.ownerType !== "community_leader") continue;
    if (entry.type !== "community_cashback") continue;
    const communityId = nonEmptyText(entry.ownerId, "");
    if (!communityId) continue;
    accruedByCommunity.set(
      communityId,
      (accruedByCommunity.get(communityId) ?? 0) + numericCopOrZero(entry.amountCop)
    );
  }

  return communities.map((community) => ({
    communityId: community.id,
    name: nonEmptyText(community.name, `Comunidad ${community.id}`),
    leaderName: nonEmptyText(community.leaderName, "Lider sin registrar"),
    stores: storesByCommunity.get(community.id) ?? 0,
    pricing: {
      sellerDeliveredFeeCop: communityPriceOr(
        community.pricing?.sellerDeliveredFeeCop,
        settings.sellerDeliveredFeeCop
      ),
      sellerFailedFeeCop: communityPriceOr(
        community.pricing?.sellerFailedFeeCop,
        settings.sellerFailedFeeCop
      ),
      fulfillmentFeeCop: communityPriceOr(
        community.pricing?.fulfillmentFeeCop,
        settings.fulfillmentFeeCop
      )
    },
    cashbackAccruedCop: accruedByCommunity.get(community.id) ?? 0
  }));
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
