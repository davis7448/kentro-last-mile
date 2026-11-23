import type { Order } from "./types";

export const adminPrintableOrderStatuses = new Set<Order["status"]>([
  "address_risk",
  "ready_to_assign",
  "assigned",
  "call_pending",
  "scheduled",
  "pickup_pending",
  "picked_up",
  "in_route",
  "retry_pending"
]);

export const sellerPrintableOrderStatuses = new Set<Order["status"]>([
  "ready_to_assign",
  "assigned"
]);

export function canPrintSellerLabel(order: Order, sellerId?: string) {
  return Boolean(
    sellerId &&
    order.sellerId === sellerId &&
    sellerPrintableOrderStatuses.has(order.status) &&
    !order.pickedUpAt &&
    !order.pickupBatchId &&
    !order.messengerId
  );
}

export function canPrintAdminWarehouseLabel(order: Order) {
  return order.fulfillmentMode === "warehouse" && adminPrintableOrderStatuses.has(order.status);
}

export function canPrintAdminLabel(order: Order) {
  return Boolean(order.labelPrintedAt) || adminPrintableOrderStatuses.has(order.status);
}

export function shouldShowUnprintedLabelBadge(order: Order, role: "admin" | "seller", sellerId?: string) {
  if (order.labelPrintedAt) return false;
  return role === "admin" ? adminPrintableOrderStatuses.has(order.status) : canPrintSellerLabel(order, sellerId);
}

/**
 * Por que este pedido no puede entrar a una recogida, o `null` si puede. Es el aviso temprano del
 * modal de escaneo; la regla que manda es la del servidor (functions/src/pickup-label-gate.ts).
 */
export function pickupLabelBlockReason(order: Pick<Order, "labelPrintedAt" | "trackingCode" | "shopifyOrderId">): string | null {
  if (order.labelPrintedAt) return null;
  return `${order.trackingCode ?? order.shopifyOrderId} no tiene rotulo impreso. La tienda o el administrador debe imprimirlo en Kentro antes de recogerlo.`;
}
