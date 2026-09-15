/**
 * Puente entre la creacion de un pedido y el precio de su comunidad.
 *
 * Existe para que los SEIS caminos que crean pedidos —pedido manual, webhook de Shopify,
 * importacion de Shopify, OnStock, formulario de contacto y webhook de tienda— llamen todos a
 * la misma funcion. Si uno se queda sin llamarla, el pedido nace sin precio congelado, cobra
 * la base y el lider no cobra: un fallo que no lanza ningun error y que solo se ve al cuadrar
 * un corte. Por eso hay una sola puerta y no seis copias.
 */
import { getFirestore } from "firebase-admin/firestore";
import { freezeOrderPricing, type FrozenPricing } from "./community-pricing";
// Tiendas con tarifa especial fija en codigo: la decision ENTERA —el conjunto y el rechazo— vive en
// `seller-charges.ts` y no se copia aqui (RF_02 y RF_03 de la 004). Su flete depende de la fecha de
// ENTREGA, que al crear el pedido no se conoce, asi que no hay base que congelarles.
import { assertSellerCanJoinCommunity, communityBase, resolveTariffs } from "./seller-charges";

export type OrderPricingStamp = {
  communityId?: string;
  communityPricing?: FrozenPricing;
};

/**
 * Cache por invocacion. Los webhooks que crean pedidos en lote leerian la misma comunidad una
 * vez por pedido; asi la leen una vez por comunidad.
 */
export function createCommunityPricingResolver(db: ReturnType<typeof getFirestore>) {
  const communities = new Map<string, Record<string, unknown> | undefined>();
  let settings: Record<string, unknown> | undefined;

  return async function stampFor(
    seller: Record<string, unknown> | undefined,
    zone: Record<string, unknown> | undefined,
    nowIso: string
  ): Promise<OrderPricingStamp> {
    const sellerId = String(seller?.id ?? "");
    const communityId = typeof seller?.communityId === "string" ? seller.communityId : "";
    if (!communityId) return {};
    // No es un caso a ignorar en silencio: si una tienda con tarifa fija entra en una comunidad,
    // alguien tiene que decidir que tarifa manda antes de cobrar nada. Quien lanza es
    // `seller-charges.ts`, donde vive el conjunto que decide el cobro: aqui solo se pregunta, para
    // que las dos vistas de "tienda con tarifa especial" no puedan divergir.
    assertSellerCanJoinCommunity(sellerId);

    if (!communities.has(communityId)) {
      const snap = await db.collection("communities").doc(communityId).get();
      communities.set(communityId, snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
    }
    const community = communities.get(communityId);
    if (!community) return {};

    if (!settings) {
      const snap = await db.collection("settings").doc("global").get();
      settings = (snap.data() as Record<string, unknown>) ?? {};
    }

    // La base efectiva del pedido (RF_03 de la 004): zona si la hay, ajuste global si no, y
    // pasada por `communityBase` para que lleve el fallido fijo. Asi los `base*` de referencia
    // que se congelan dicen lo que de verdad se cobra (fallido 12.000) y no el ajuste crudo.
    const base = communityBase(resolveTariffs(settings, zone));
    const frozen = freezeOrderPricing(base, { id: communityId, ...(community as object) }, nowIso);
    return frozen ? { communityId, communityPricing: frozen } : { communityId };
  };
}
