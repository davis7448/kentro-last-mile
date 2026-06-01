import type { AppState, Order, WalletEntry } from "./types";

const dandaSellerIds = new Set(["seller-1779315416119"]);

type Tariffs = {
  sellerDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  fulfillmentFeeCop: number;
  driverDeliveredPayCop: number;
  driverFailedPayCop: number;
};

function applySellerTariffOverrides(order: Order, tariffs: Tariffs): Tariffs {
  if (!dandaSellerIds.has(order.sellerId)) return tariffs;
  return {
    ...tariffs,
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 0,
    driverDeliveredPayCop: 10000,
    driverFailedPayCop: 0
  };
}

export function formatCop(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(value);
}

export function entriesForClosedOrder(order: Order, state: AppState): WalletEntry[] {
  const now = new Date().toISOString();
  const entries: WalletEntry[] = [];
  const zone = order.zoneId ? state.zones.find((item) => item.id === order.zoneId) : undefined;
  const tariffs = applySellerTariffOverrides(order, {
    sellerDeliveredFeeCop: zone?.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop,
    sellerFailedFeeCop: zone?.sellerFailedFeeCop || state.settings.sellerFailedFeeCop,
    fulfillmentFeeCop: zone?.fulfillmentFeeCop || state.settings.fulfillmentFeeCop,
    driverDeliveredPayCop: zone?.driverDeliveredPayCop || state.settings.driverDeliveredPayCop,
    driverFailedPayCop: zone?.driverFailedPayCop || state.settings.driverFailedPayCop
  });

  if (order.status === "delivered" && order.paymentMethod === "cod") {
    entries.push({
      id: `we-${order.id}-cod`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "cod_revenue",
      amountCop: order.totalCop,
      description: `Recaudo COD pedido ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  if (order.status === "delivered") {
    entries.push({
      id: `we-${order.id}-seller-delivery-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "delivery_fee",
      amountCop: -tariffs.sellerDeliveredFeeCop,
      description: `Flete entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
    entries.push({
      id: `we-${order.id}-driver-delivery-pay`,
      ownerType: "driver",
      ownerId: order.driverId ?? "unassigned",
      orderId: order.id,
      type: "driver_earning",
      amountCop: tariffs.driverDeliveredPayCop,
      description: `Pago transportista entregado ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  if (order.status === "failed") {
    if (tariffs.sellerFailedFeeCop > 0) {
      entries.push({
        id: `we-${order.id}-seller-failed-fee`,
        ownerType: "seller",
        ownerId: order.sellerId,
        orderId: order.id,
        type: "failed_fee",
        amountCop: -tariffs.sellerFailedFeeCop,
        description: `Cobro fallido ${order.shopifyOrderId}`,
        createdAt: now
      });
    }
    if (tariffs.driverFailedPayCop > 0) {
      entries.push({
        id: `we-${order.id}-driver-failed-pay`,
        ownerType: "driver",
        ownerId: order.driverId ?? "unassigned",
        orderId: order.id,
        type: "driver_earning",
        amountCop: tariffs.driverFailedPayCop,
        description: `Pago transportista fallido ${order.shopifyOrderId}`,
        createdAt: now
      });
    }
  }

  if (order.fulfillmentMode === "warehouse" && (order.status === "delivered" || order.status === "failed")) {
    entries.push({
      id: `we-${order.id}-fulfillment-fee`,
      ownerType: "seller",
      ownerId: order.sellerId,
      orderId: order.id,
      type: "fulfillment_fee",
      amountCop: -tariffs.fulfillmentFeeCop,
      description: `Fulfillment desde bodega ${order.shopifyOrderId}`,
      createdAt: now
    });
  }

  return entries;
}

export function sellerBalance(state: AppState, sellerId: string) {
  const ledgerCop = state.wallet
    .filter((entry) => entry.ownerType === "seller" && entry.ownerId === sellerId)
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const pendingOrders = state.orders.filter(
    (order) =>
      order.sellerId === sellerId &&
      !["delivered", "failed", "cancelled", "liquidated"].includes(order.status)
  ).length;
  const reservedCop = pendingOrders * state.settings.pendingReserveCop;
  return { ledgerCop, pendingOrders, reservedCop, availableCop: Math.max(0, ledgerCop - reservedCop) };
}

export function weeklyFailedRate(state: AppState, driverId: string) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const closed = state.orders.filter((order) => {
    const closedStatus = order.status === "delivered" || order.status === "failed";
    return order.driverId === driverId && closedStatus && new Date(order.updatedAt).getTime() >= weekAgo;
  });
  const failed = closed.filter((order) => order.status === "failed").length;
  return { total: closed.length, failed, rate: closed.length === 0 ? 0 : Math.round((failed / closed.length) * 100) };
}
