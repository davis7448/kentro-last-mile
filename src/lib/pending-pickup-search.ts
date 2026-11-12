import type { Order } from "./types";

// Spec 039: busqueda y orden de la tarjeta «Recogidos pendientes de mensajero».
// Todo trabaja sobre los pedidos ya cargados en el navegador: cero lecturas nuevas.

type SearchableOrder = Pick<Order, "id" | "trackingCode" | "shopifyOrderId" | "customerName" | "pickupPointName" | "sellerId">;

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Numero del KNT (`KNT-008465` -> 8465), o null si el pedido no tiene KNT reconocible. */
export function trackingNumber(trackingCode?: string): number | null {
  const match = trackingCode?.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** RF_04: KNT ascendente; los que no tienen KNT al final, por numero de Shopify. */
export function sortPendingPickup<T extends SearchableOrder>(orders: T[]): T[] {
  return [...orders].sort((left, right) => {
    const leftNumber = trackingNumber(left.trackingCode);
    const rightNumber = trackingNumber(right.trackingCode);
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber - rightNumber;
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    const leftShopify = Number(left.shopifyOrderId);
    const rightShopify = Number(right.shopifyOrderId);
    if (Number.isFinite(leftShopify) && Number.isFinite(rightShopify) && leftShopify !== rightShopify) return leftShopify - rightShopify;
    return compareText(String(left.shopifyOrderId ?? ""), String(right.shopifyOrderId ?? "")) || compareText(left.id, right.id);
  });
}

/** RF_02 y RF_03: busca en toda la lista por KNT, Shopify, cliente, punto de recogida y tienda. */
export function filterPendingPickup<T extends SearchableOrder>(orders: T[], query: string, sellerNameById: ReadonlyMap<string, string> = new Map()): T[] {
  const needle = normalizeText(query);
  if (!needle) return orders;
  const digitsOnly = /^\d+$/.test(needle) ? Number(needle) : null;
  return orders.filter((order) => {
    if (digitsOnly !== null && trackingNumber(order.trackingCode) === digitsOnly) return true;
    return [
      order.trackingCode,
      order.shopifyOrderId,
      order.customerName,
      order.pickupPointName,
      sellerNameById.get(order.sellerId)
    ].some((entry) => entry && normalizeText(String(entry)).includes(needle));
  });
}
