import type { AppState, Evidence, Order } from "./types";

export type DriverHistoryStatusFilter = "all" | "delivered" | "failed";

export type DriverHistoryFilters = {
  search: string;
  status: DriverHistoryStatusFilter;
  messengerId: string;
  sellerId: string;
  startDate: string;
  endDate: string;
};

export function latestClosingEvidence(order: Order): Evidence | undefined {
  return [...order.evidence].reverse().find((item) => item.type === "delivery" || item.type === "failed");
}

export function orderClosedAt(order: Order) {
  return latestClosingEvidence(order)?.createdAt ?? order.updatedAt;
}

export function isDriverActiveOrder(order: Order, driverId: string) {
  return order.driverId === driverId && !["delivered", "failed", "cancelled", "liquidated"].includes(order.status);
}

export function driverFleetClosedOrders(state: AppState, driverId: string) {
  const messengerIds = new Set(
    state.messengers
      .filter((messenger) => messenger.leaderDriverId === driverId)
      .map((messenger) => messenger.id)
  );

  return state.orders
    .filter((order) =>
      (order.status === "delivered" || order.status === "failed") &&
      (order.driverId === driverId || Boolean(order.messengerId && messengerIds.has(order.messengerId)))
    )
    .sort((left, right) => String(orderClosedAt(right)).localeCompare(String(orderClosedAt(left))));
}

export function filterDriverHistoryOrders(orders: Order[], filters: DriverHistoryFilters) {
  const query = filters.search.trim().toLowerCase();
  return orders.filter((order) => {
    const closedDate = orderClosedAt(order).slice(0, 10);
    if (filters.status !== "all" && order.status !== filters.status) return false;
    if (filters.messengerId !== "all" && (order.messengerId ?? "none") !== filters.messengerId) return false;
    if (filters.sellerId !== "all" && order.sellerId !== filters.sellerId) return false;
    if (filters.startDate && closedDate && closedDate < filters.startDate) return false;
    if (filters.endDate && closedDate && closedDate > filters.endDate) return false;
    if (!query) return true;
    return [
      order.trackingCode,
      order.shopifyOrderId,
      order.id,
      order.customerName,
      order.customerPhone
    ].filter(Boolean).some((entry) => String(entry).toLowerCase().includes(query));
  });
}
