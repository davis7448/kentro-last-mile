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
import { resolveTariffs } from "./wallet-entries";

/** Tiendas con tarifa especial fija en codigo. Su flete depende de la fecha de ENTREGA, que al
 *  crear el pedido no se conoce, asi que no se les congela nada: siguen por el camino de siempre. */
const SELLERS_WITH_HARDCODED_TARIFFS = new Set(["seller-1779315416119"]);

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
    if (SELLERS_WITH_HARDCODED_TARIFFS.has(sellerId)) {
      // No es un caso a ignorar en silencio: si una tienda con tarifa fija entra en una
      // comunidad, alguien tiene que decidir que tarifa manda antes de cobrar nada.
      throw new Error(
        `La tienda ${sellerId} tiene tarifa especial en codigo y no puede pertenecer a una comunidad.`
      );
    }

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

    // La base efectiva del pedido: zona si la hay, ajuste global si no. Es el piso real.
    const base = resolveTariffs(settings, zone);
    const frozen = freezeOrderPricing(base, { id: communityId, ...(community as object) }, nowIso);
    return frozen ? { communityId, communityPricing: frozen } : { communityId };
  };
}
