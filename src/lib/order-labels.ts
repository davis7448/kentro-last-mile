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
