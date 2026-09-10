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

/** RF_11: cambiar de comunidad no lo decide ni la tienda ni el lider. */
export function canReassignSellerCommunity(actor: Actor): boolean {
  return isAdmin(actor);
}

/** RF_12: el alta manual sigue existiendo y no adscribe a ninguna comunidad. */
export function communityIdForAdminCreatedSeller(): string | undefined {
  return undefined;
}
