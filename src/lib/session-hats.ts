import type { Role } from "./types";

/**
 * Que sombreros lleva una cuenta, cual se abre primero, y si hay que ensenarle un selector.
 *
 * Spec 003: liderar una comunidad **no es un papel**, es una atribucion aparte que viaja en el
 * reclamo `communityId`. Por eso una misma cuenta puede ser tienda y lider a la vez, y por eso la
 * decision de que ensenarle no sale del `role` sino de la combinacion de los dos.
 *
 * **El sombrero es estado de interfaz y no viaja al servidor** (RNF_02). El servidor decide por lo
 * que la cuenta *es*: tiene `sellerId`, luego puede leer el saldo de esa tienda, lleve el sombrero
 * que lleve. Lo que la pantalla de comunidad hace es **no ensenarselo**, que es una regla de
 * presentacion (RF_09) y no de autorizacion. Si el servidor obedeciera al selector, la autorizacion
 * estaria en manos del cliente — justo lo que la constitucion prohibe.
 *
 * Puro sobre los reclamos, sin efectos: por eso cambiar de sombrero no exige volver a entrar
 * (RF_10). No hay nada que recargar porque no hay nada que traer.
 */
export type Hat = "operational" | "community";

export type SessionClaims = {
  role: Role;
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
  communityId?: string;
  communityStanding?: "leader" | "creditor";
};

const hasCommunityLink = (claims: SessionClaims) => (claims.communityId ?? "").trim() !== "";

export const HAT_ORDER: readonly Hat[] = ["operational", "community"];

/**
 * El sombrero de comunidad lo da el **vinculo**, no la posicion.
 *
 * Un acreedor ya no gobierna, pero se le sigue debiendo y tiene que poder llegar a la pantalla
 * donde lo cobra (RF_22). Filtrar por `communityStanding === "leader"` le escondería el cobro
 * justo al retirarle el papel, que es el fallo que RF_11 y RF_22 existen para impedir.
 *
 * Y lo da tambien el propio rol `community_leader`, no solo el vinculo: un reclamo degradado que
 * hubiera perdido el `communityId` se quedaria con cero sombreros y la pantalla sin nada que pintar.
 */
export function availableHats(claims: SessionClaims): readonly Hat[] {
  const hats: Hat[] = [];
  if (claims.role !== "community_leader") hats.push("operational");
  if (hasCommunityLink(claims) || claims.role === "community_leader") hats.push("community");
  return hats;
}

/**
 * Se abre el operativo cuando existe: para una tienda que ademas lidera, su negocio diario es la
 * tienda. Liderar es lo que hace de vez en cuando.
 */
export function defaultHat(claims: SessionClaims): Hat {
  return availableHats(claims).includes("operational") ? "operational" : "community";
}

/** RF_11: quien no elige no debe decidir nada. Un solo sombrero, ningun selector. */
export function shouldShowHatSelector(claims: SessionClaims): boolean {
  return availableHats(claims).length > 1;
}
