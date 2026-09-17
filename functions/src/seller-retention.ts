/**
 * Spec 018 — cuanto se le retiene a una tienda por un pedido que esta en la calle.
 *
 * Mientras la mercancia esta con el domiciliario, el pedido puede volver como visita fallida y
 * cobrarle a la tienda el flete de devolucion (y el manejo, si sale de bodega). Pagarle a la tienda
 * esa parte antes de saber como termina el pedido es pagar un dinero que quiza haya que cobrarle
 * despues. Antes se retenia un valor fijo (9.000 por cada pedido sin cerrar, incluso los que ni se
 * habian confirmado), que no se parecia a ninguna tarifa real.
 *
 * NO hay tarifa aqui. La retencion pregunta a `buildWalletEntries` —la unica fuente de verdad del
 * dinero de un pedido (principio 9)— que le cobraria a la tienda si el pedido fallara AHORA en
 * visita cobrable. Asi el fijo general, el cero de DANDA y el precio congelado del lider de
 * comunidad salen del mismo camino que el cierre, y no pueden divergir.
 *
 * Puro: sin Firestore. Lo importan el servidor y la app.
 */
import type { Tariffs } from "./seller-charges";
import { buildWalletEntries } from "./wallet-entries";

export type RetentionOrder = {
  id: string;
  sellerId: string;
  status: string;
  pickedUpAt?: string;
  fulfillmentMode?: string;
  zoneId?: string;
  driverId?: string | null;
  shopifyOrderId?: string;
  communityPricing?: unknown;
  evidence?: unknown[];
};

const CLOSED_STATUSES = new Set(["delivered", "failed", "cancelled", "liquidated"]);
/** Estados que por definicion implican mercancia recogida. */
const COLLECTED_STATUSES = new Set(["picked_up", "in_route"]);
const RETAINED_CHARGE_TYPES = new Set(["failed_fee", "fulfillment_fee"]);

/**
 * RF_09 / RF_10 / RF_11. Un pedido esta en la calle si su mercancia ya salio con el domiciliario
 * y todavia no se cerro. Un reabierto que vuelve a "listo para asignar" o a "pendiente de nueva
 * visita" conserva `pickedUpAt`: sigue reteniendo. Uno que nunca se recogio puede anularse sin
 * cobro y no retiene.
 */
export function isOrderOnTheStreet(order: Pick<RetentionOrder, "status" | "pickedUpAt">): boolean {
  const status = String(order.status ?? "");
  if (CLOSED_STATUSES.has(status)) return false;
  if (COLLECTED_STATUSES.has(status)) return true;
  return typeof order.pickedUpAt === "string" && order.pickedUpAt.trim() !== "";
}

/**
 * RF_06 / RF_07. Pesos que se le cobrarian a la tienda si este pedido fallara ahora en visita
 * cobrable. `fulfillmentAlreadyCharged` = ya existe el asiento de manejo del pedido (id fijo): el
 * cierre no lo volveria a crear, asi que tampoco se retiene.
 */
export function retentionForOrder(
  order: RetentionOrder,
  tariffs: Tariffs,
  now: string,
  options: { fulfillmentAlreadyCharged?: boolean } = {}
): number {
  if (!isOrderOnTheStreet(order)) return 0;
  const failedNow = {
    ...order,
    status: "failed",
    failedCategory: "failed_visit",
    evidence: [...(Array.isArray(order.evidence) ? order.evidence : []), { type: "failed", failedCategory: "failed_visit" }]
  };
  const charged = buildWalletEntries(failedNow, tariffs, now, [])
    .filter((entry) => entry.ownerType === "seller" && RETAINED_CHARGE_TYPES.has(String(entry.type)))
    .filter((entry) => !(options.fulfillmentAlreadyCharged && entry.type === "fulfillment_fee"))
    .reduce((sum, entry) => sum + Number(entry.amountCop), 0);
  return Math.max(0, -charged);
}
