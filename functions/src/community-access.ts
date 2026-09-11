/**
 * Quien puede hacer que con una comunidad. SIN acceso a Firestore.
 *
 * Existe como modulo puro por dos razones. La primera es que las reglas de Firestore no se
 * pueden probar con Vitest, asi que si la decision vive solo alli no hay forma barata de
 * comprobarla. La segunda es que estos predicados son una frontera de dinero y de datos
 * personales: un lider que vea una tienda ajena esta viendo el negocio de otro.
 *
 * Las reglas de `firestore.rules` siguen siendo la defensa real —un cliente puede llamar a lo
 * que quiera— y deben decir lo mismo que esto. Aqui esta la version legible y probada.
 */

import { COMMUNITY_PRICING_FIELDS } from "./community-pricing";
import { tariffFields } from "./wallet-entries";

export type Actor = {
  uid: string;
  role: string;
  communityId?: string;
  sellerId?: string;
  driverId?: string;
};

type SellerLike = { id: string; communityId?: string };
type CommunityStatusLike = { status: string; linkStatus?: string };

const isAdmin = (actor: Actor) => actor.role === "admin";
const isLeaderOf = (actor: Actor, communityId: string) =>
  actor.role === "community_leader" && !!communityId && actor.communityId === communityId;

/** RF_50: la figura del lider no se autoproclama; la crea un administrador. */
export function canCreateCommunityLeader(actor: Actor): boolean {
  return isAdmin(actor);
}

/** RF_50, RF_51: activar y desactivar lideres es cosa del administrador. */
export function canSetCommunityLeaderStatus(actor: Actor): boolean {
  return isAdmin(actor);
}

/** RF_05: el enlace lo corta el administrador, no el lider. */
export function canSetCommunityLinkStatus(actor: Actor): boolean {
  return isAdmin(actor);
}

/** RF_51: desactivado no entra. Su comunidad, su historial y su cashback siguen intactos. */
export function leaderCanSignIn(community: { status: string }): boolean {
  return community.status === "active";
}

/** RF_06: hace falta que el enlace este vivo Y que el lider lo este. */
export function communityAcceptsSignups(community: CommunityStatusLike): boolean {
  return community.status === "active" && community.linkStatus === "active";
}

/** RF_18, RF_27: cada lider fija los precios de su comunidad y de ninguna otra. */
export function canEditCommunityPricing(actor: Actor, communityId: string): boolean {
  return isLeaderOf(actor, communityId);
}

/** RF_14, RF_16: la marca la cambia su lider; el administrador tambien, para poder corregir. */
export function canEditCommunityBrand(actor: Actor, communityId: string): boolean {
  return isAdmin(actor) || isLeaderOf(actor, communityId);
}

/** RF_29, RF_52: las cifras de una comunidad son de su lider y del administrador. */
export function canReadCommunityStats(actor: Actor, communityId: string): boolean {
  return isAdmin(actor) || isLeaderOf(actor, communityId);
}

/** RF_52: un lider ve la operacion de las tiendas de SU comunidad. Sin comunidad, no hay vinculo. */
export function canReadSellerOperational(actor: Actor, seller: SellerLike): boolean {
  if (isAdmin(actor)) return true;
  if (actor.role === "seller" || actor.role === "seller_logistics") return actor.sellerId === seller.id;
  if (actor.role === "community_leader") return !!seller.communityId && seller.communityId === actor.communityId;
  return false;
}

/**
 * RF_31: el saldo, la deuda y el recaudo de una tienda NO son del lider, ni siquiera de las
 * suyas. Lo que si es suyo es su propio cashback, y eso no pasa por aqui.
 */
export function canReadSellerFinancials(actor: Actor, seller: SellerLike): boolean {
  if (isAdmin(actor)) return true;
  if (actor.role === "seller") return actor.sellerId === seller.id;
  return false;
}

/**
 * RF_41: la contencion de un enlace filtrado la dispara el administrador, no el lider.
 *
 * Es SU enlace el que se filtro y son SUS tiendas las que entraron, asi que el lider es quien
 * mas incentivo tiene para tapar el rastro: cerrar en bloque decenas de accesos se queda del
 * lado del administrador, igual que revocar el enlace (RF_05), que tampoco es suyo.
 *
 * `communityId` entra en la firma y no concede nada —un administrador la desactiva sea cual
 * sea, tambien una que no conoce—. Esta para que interfaz, servidor y reglas hablen del mismo
 * par actor/comunidad, como en `canReadCommunityStats`. Y la aridad es la que es a proposito:
 * RF_42 dice que el historial de dinero de esas cuentas no se toca, asi que la decision no
 * puede llegar a depender de que las tiendas "no deban nada".
 */
export function canBulkDisableCommunitySignups(actor: Actor, communityId: string): boolean {
  // Se nombra para dejar constancia de que se recibe y se descarta, no por descuido.
  void communityId;
  return isAdmin(actor);
}

/** RF_11: cambiar de comunidad no lo decide ni la tienda ni el lider. */
export function canReassignSellerCommunity(actor: Actor): boolean {
  return isAdmin(actor);
}

/** RF_12: el alta manual sigue existiendo y no adscribe a ninguna comunidad. */
export function communityIdForAdminCreatedSeller(): string | undefined {
  return undefined;
}

/**
 * Los campos entran como `unknown` porque el llamador pasa `sellerDoc.data() ?? {}` tal cual:
 * Firestore no garantiza el tipo de nada. El resto del backend ya lee estos campos como
 * `typeof x === "string" ? x.trim() : ""` (orders.ts:346, index.ts:188, shopify.ts:717,
 * store-webhook.ts:311), asi que la frontera se defiende aqui.
 */
export type SellerOperationalData = {
  onboardingComplete?: unknown;
  cityId?: unknown;
  pickupAddress?: unknown;
  bankAccount?: unknown;
};

/**
 * Un dato operativo esta puesto solo si es texto y queda algo tras `trim()`.
 *
 * OJO, unica divergencia deliberada con el `!valor` que habia en `createManualOrder`: `!" "` es
 * `false`, asi que un punto de recogida de un solo espacio contaba como puesto y el pedido se
 * creaba — pero `orders.ts` lo escribe con `.trim()`, o sea `""`, y el domiciliario se quedaba
 * sin direccion de recogida sin que nada lo avisara. Una cadena en blanco no es un dato.
 */
const operationalValuePresent = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

/**
 * RF_44: que le falta a una tienda para poder crear pedidos, en el orden en que se le piden.
 *
 * Devuelve QUE falta y no solo si falta, porque el mismo dato le sirve a la interfaz para
 * senalar donde completarlo. Si el onboarding no esta abierto no falta nada: no es que los
 * datos esten, es que a esa tienda no se le exigen.
 */
export function missingOperationalData(seller: SellerOperationalData): string[] {
  // Se compara contra `false` EXPLICITO a proposito: las tiendas que ya existian no tienen el
  // campo, y tratarlas como incompletas dejaria a toda la plataforma sin poder crear pedidos.
  if (seller.onboardingComplete !== false) return [];
  const faltan: string[] = [];
  if (!operationalValuePresent(seller.cityId)) faltan.push("ciudad");
  if (!operationalValuePresent(seller.pickupAddress)) faltan.push("punto de recogida");
  if (!operationalValuePresent(seller.bankAccount)) faltan.push("cuenta bancaria");
  return faltan;
}

/**
 * RF_44: el texto que ve la tienda cuando el pedido se veta, o `null` si se puede crear.
 *
 * El veto lo abre el onboarding, no la lista: con el onboarding abierto y los tres datos
 * puestos —estado incoherente— se sigue vetando, con el generico de relleno. El `HttpsError`
 * lo construye la callable; aqui solo esta la decision y el texto.
 */
export function operationalDataBlockMessage(seller: SellerOperationalData): string | null {
  if (seller.onboardingComplete !== false) return null;
  const faltan = missingOperationalData(seller);
  return `Completa los datos de tu tienda antes de crear pedidos: ${faltan.join(", ") || "datos pendientes"}.`;
}

/**
 * Marcador de "quitar este campo del documento".
 *
 * Existe porque estos planes son puros y `FieldValue.delete()` viene de firebase-admin, que
 * este modulo no importa. La callable lo traduce en el ultimo momento (`communities.ts`), y esa
 * traduccion es el unico punto donde `FieldValue` toca la operacion.
 *
 * Se llama `unset` y no `delete` a proposito: lo que protege el dinero en estos planes es un
 * barrido que busca verbos de destruccion sobre la estructura ENTERA —claves y valores—, y un
 * marcador legitimo llamado "delete" obligaria a apagar justo esa comprobacion.
 */
export const UNSET_FIELD = { kind: "unset" } as const;

export type UnsetField = typeof UNSET_FIELD;

/**
 * Solo el marcador, y por identidad. Un `""`, un `undefined` o cualquier objeto parecido dicen
 * que no: si la guarda se ablandara, la callable quitaria del documento un campo que le pidieron
 * escribir.
 */
export function isUnsetField(value: unknown): boolean {
  return value === UNSET_FIELD;
}

/** Un identificador puesto es el texto recortado; lo demas es "sin comunidad". */
const communityIdOrNull = (value: string | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

type ReassignmentSeller = { id: string; communityId?: string };

export type SellerReassignmentPlan = {
  sellerId: string;
  previousCommunityId: string | null;
  nextCommunityId: string | null;
  changed: boolean;
  sellerUpdate: Partial<{
    communityId: string | UnsetField;
    communityJoinedAt: string | UnsetField;
  }>;
  collectionsTouched: readonly ["sellers"];
};

/**
 * RF_11: que se escribe al mover una tienda de comunidad. Y, sobre todo, que NO.
 *
 * El alcance declarado es `sellers` y nada mas: el cashback ya causado se queda con el lider que
 * lo causo. Al ser un plan puro y completo, lo que la operacion puede tocar se puede afirmar
 * sobre la estructura entera, cosa que un `update({...})` en linea no permite.
 *
 * Sin cambio real de comunidad no se escribe NADA, y eso no es idempotencia decorativa:
 * `communityJoinedAt` es el eje por el que la contencion de un enlace filtrado elige a quien
 * cerrar (RF_41, `where("communityJoinedAt", ">=", fromIso)`). Un doble clic del administrador
 * sobre la comunidad que la tienda ya tiene le moveria la fecha a hoy y la sacaria del rango de
 * la limpieza, en silencio. Por eso tambien se compara recortado: la callable valida con
 * `z.string().trim()`, y si las dos capas discreparan un espacio de mas contaria como cambio.
 */
export function planSellerReassignment(
  seller: ReassignmentSeller,
  communityId: string | undefined,
  nowIso: string
): SellerReassignmentPlan {
  const previousCommunityId = communityIdOrNull(seller.communityId);
  const nextCommunityId = communityIdOrNull(communityId);
  const changed = previousCommunityId !== nextCommunityId;
  const sellerUpdate: SellerReassignmentPlan["sellerUpdate"] = {};
  if (changed) {
    // Sin destino se quitan los DOS campos: un `""` en `communityId` haria que la tienda
    // pareciera adscrita a una comunidad de nombre vacio.
    sellerUpdate.communityId = nextCommunityId ?? UNSET_FIELD;
    sellerUpdate.communityJoinedAt = nextCommunityId === null ? UNSET_FIELD : nowIso;
  }
  return {
    sellerId: seller.id,
    previousCommunityId,
    nextCommunityId,
    changed,
    sellerUpdate,
    collectionsTouched: ["sellers"]
  };
}

type LeaderStatusCommunity = { id: string; status?: string };

export type LeaderStatusPlan = {
  communityId: string;
  previousStatus: string | null;
  nextStatus: string;
  changed: boolean;
  communityUpdate: Partial<{ status: string; updatedAt: string }>;
  collectionsTouched: readonly ["communities"];
};

/**
 * RF_51: desactivar a un lider corta su acceso y no toca nada mas.
 *
 * Su comunidad, su precio vigente, su historial y su cashback pendiente siguen donde estaban:
 * la desactivacion corta el acceso, no la deuda que la plataforma tiene con el. Sus tiendas
 * tampoco se rozan, por eso `sellers` no esta en el alcance ni para desadscribirlas.
 *
 * Una comunidad anterior a RF_51 no tiene el campo `status`. "Sin campo" no es "ya desactivada"
 * —eso dejaria a su lider fuera sin que nadie lo hubiera decidido— ni un no-cambio al
 * desactivar, que dejaria el acceso abierto: se escribe, y el previo se declara nulo.
 *
 * Repetir el mismo estado no reescribe `updatedAt`: ese sello es lo unico con lo que se audita
 * cuando se corto el acceso, y moverlo sin cambiar nada hace que el rastro mienta.
 */
export function planLeaderStatusChange(
  community: LeaderStatusCommunity,
  status: "active" | "disabled",
  nowIso: string
): LeaderStatusPlan {
  const current = typeof community.status === "string" ? community.status.trim() : "";
  const previousStatus = current.length > 0 ? current : null;
  const changed = previousStatus !== status;
  const communityUpdate: LeaderStatusPlan["communityUpdate"] = {};
  if (changed) {
    communityUpdate.status = status;
    communityUpdate.updatedAt = nowIso;
  }
  return {
    communityId: community.id,
    previousStatus,
    nextStatus: status,
    changed,
    communityUpdate,
    collectionsTouched: ["communities"]
  };
}

/**
 * RF_27: quien fija cada concepto de dinero de un pedido. Y, sobre todo, quien NO.
 *
 * Un lider encarece lo suyo —lo que le cobra a SUS tiendas— y ahi termina su mano. Si pudiera
 * mover el pago al lider logistico o al mensajero, se estaria subiendo el cashback a costa de
 * otro: el margen que se ahorra en el reparto no sale de su tienda, sale del bolsillo de quien
 * lleva la caja. Y `product_cost` ni siquiera es una tarifa negociable: es el asiento que sale
 * del catalogo, costo del item por unidad de Shopify por cantidad real de Shopify (regla de oro
 * #2). Entra en esta lista justamente para que nadie lo trate como un precio mas.
 *
 * Por concepto y no por lista, porque una lista contesta "que campos hay" y aqui la pregunta es
 * "quien puede tocar este", que hay que responder tambien para el concepto que alguien anada
 * manana. `TARIFF_CONCEPTS` se DERIVA de `tariffFields` (wallet-entries.ts, la unica fuente de
 * verdad sobre cuanta plata genera un pedido) en vez de copiarse: un campo de pago nuevo alli
 * entra aqui solo, y el `Record<TariffConcept, ...>` de quien consuma el tipo deja de compilar
 * hasta que alguien decida si el lider lo toca o no. Hoy la frontera existe solo por omision
 * —`COMMUNITY_PRICING_FIELDS` tiene tres campos y `tariffFields` tiene cinco—, y una omision no
 * impide nada: ampliar el `z.enum` de `communities.ts` a los cinco es un cambio de una linea que
 * hasta parece una mejora.
 */
export const TARIFF_CONCEPTS = [...tariffFields, "product_cost"] as const;

export type TariffConcept = (typeof TARIFF_CONCEPTS)[number];

/**
 * RF_27: el veto es "esto no lo toca el lider", no "esto no se toca". El administrador si ajusta
 * lo que la plataforma le paga a su propia operacion; lo contrario la dejaria sin poder subirle
 * el pago a un mensajero.
 *
 * Para los tres conceptos que si son suyos contesta exactamente lo mismo que
 * `canEditCommunityPricing`, a proposito: si las dos preguntas divergieran, la pantalla acabaria
 * ofreciendo un control que el servidor rechaza, o al reves. La aridad es la que es —quien, que
 * comunidad, que concepto— para que condicionar el veto al volumen de la comunidad o a "cuanto
 * lleva ganado el lider" obligue a cambiar la firma y pasar por aqui.
 */
export function canEditTariffConcept(
  actor: Actor,
  communityId: string,
  concept: TariffConcept
): boolean {
  if (isAdmin(actor)) return true;
  const leaderConcept = (COMMUNITY_PRICING_FIELDS as readonly string[]).includes(concept);
  return leaderConcept && canEditCommunityPricing(actor, communityId);
}
