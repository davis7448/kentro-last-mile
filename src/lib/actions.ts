"use client";

import { entriesForClosedOrder, sellerBalance } from "./finance";
import type { AddressRisk, AppState, AuditEvent, FailedCategory, FulfillmentMode, Order, OrderStatus, PaymentMethod, Role } from "./types";

const actorByRole: Record<Role, string> = {
  admin: "admin",
  seller: "seller",
  driver: "driver",
  messenger: "messenger"
};

function audit(state: AppState, action: string, entity: string, entityId: string, summary: string): AuditEvent {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    actorId: actorByRole[state.activeRole],
    actorRole: state.activeRole,
    action,
    entity,
    entityId,
    summary,
    createdAt: new Date().toISOString()
  };
}

function nextLocalTrackingCode(state: AppState) {
  const next = state.orders.reduce((max, order) => {
    const match = order.trackingCode?.match(/KNT-(?:CALI-)?(\d+)/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  return `KNT-${String(next).padStart(6, "0")}`;
}

function reserveInventoryForOrder(state: AppState, sellerId: string, sku?: string) {
  if (!sku) return { state, ok: true };
  const item = state.inventory.find((entry) => entry.sellerId === sellerId && entry.sku === sku);
  if (!item) return { state, ok: true };
  if (item.available - item.reserved <= 0) return { state, ok: false };
  return {
    ok: true,
    state: {
      ...state,
      inventory: state.inventory.map((entry) => entry.id === item.id ? { ...entry, reserved: entry.reserved + 1 } : entry)
    }
  };
}

function settleInventoryForClosedOrder(state: AppState, order: Order, outcome: "delivered" | "failed", retry: boolean) {
  if (!order.sku) return state;
  const item = state.inventory.find((entry) => entry.sellerId === order.sellerId && entry.sku === order.sku);
  if (!item) return state;
  return {
    ...state,
    inventory: state.inventory.map((entry) => {
      if (entry.id !== item.id) return entry;
      if (outcome === "delivered") {
        return { ...entry, available: Math.max(0, entry.available - 1), reserved: Math.max(0, entry.reserved - 1) };
      }
      return retry ? entry : { ...entry, reserved: Math.max(0, entry.reserved - 1) };
    })
  };
}

function mutateOrder(state: AppState, orderId: string, updater: (order: Order) => Order, summary: string): AppState {
  return {
    ...state,
    orders: state.orders.map((order) => (order.id === orderId ? updater(order) : order)),
    audit: [audit(state, "order.update", "order", orderId, summary), ...state.audit]
  };
}

type CloseEvidenceInput = {
  note?: string;
  photoLabel?: string;
  photoUrl?: string;
  storagePath?: string;
};

type FailedEvidenceInput = CloseEvidenceInput & {
  reason?: string;
  failedCategory?: FailedCategory;
  scheduledDate?: string;
  scheduledWindow?: string;
};

export function setRole(state: AppState, role: Role): AppState {
  return { ...state, activeRole: role };
}

export function assignOrder(state: AppState, orderId: string, driverId: string): AppState {
  return mutateOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      driverId,
      status: order.addressRisk === "review" ? "address_risk" : "assigned",
      updatedAt: new Date().toISOString()
    }),
    `Pedido bloqueado para transportista ${driverId}`
  );
}

export function claimOrder(state: AppState, orderId: string, driverId: string): AppState {
  return assignOrder(state, orderId, driverId);
}

export function advanceOrder(state: AppState, orderId: string, status: OrderStatus): AppState {
  return mutateOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      status,
      callOutcome: status === "call_pending" ? "pending" : order.callOutcome,
      updatedAt: new Date().toISOString()
    }),
    `Estado cambiado a ${status}`
  );
}

export function confirmDeliveryWindow(state: AppState, orderId: string, scheduledDate: string, scheduledWindow: string): AppState {
  return mutateOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      status: "scheduled",
      scheduledDate,
      scheduledWindow,
      callOutcome: "confirmed",
      updatedAt: new Date().toISOString()
    }),
    `Entrega agendada para ${scheduledDate} ${scheduledWindow}`
  );
}

export function rescheduleCustomerCall(state: AppState, orderId: string, rescheduledDate: string, rescheduledWindow: string): AppState {
  const note = `Reprogramado para ${rescheduledDate} ${rescheduledWindow}`;
  return mutateOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      status: "call_pending",
      callOutcome: "rescheduled",
      callNote: note,
      rescheduledDate,
      rescheduledWindow,
      updatedAt: new Date().toISOString()
    }),
    note
  );
}

export function resolveAddress(state: AppState, orderId: string): AppState {
  return mutateOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      addressRisk: "accepted",
      status: order.driverId ? "assigned" : "ready_to_assign",
      geoProvider: order.geoProvider ?? "mapbox",
      normalizedAddress: order.normalizedAddress ?? `${order.addressRaw}, Cali, Colombia`,
      updatedAt: new Date().toISOString()
    }),
    "Direccion aceptada desde cola de revision"
  );
}

export function closeDelivered(state: AppState, orderId: string, input: CloseEvidenceInput = {}): AppState {
  const now = new Date().toISOString();
  const nextOrders = state.orders.map((order) =>
    order.id === orderId
      ? {
          ...order,
          status: "delivered" as const,
          evidence: [
            ...order.evidence,
            {
              id: `ev-${Date.now()}`,
              type: "delivery" as const,
              photoLabel: input.photoLabel ?? "entrega.jpg",
              photoUrl: input.photoUrl,
              storagePath: input.storagePath,
              note: input.note?.trim() || "Entrega confirmada con evidencia fotografica.",
              actorId: actorByRole[state.activeRole],
              createdAt: now
            }
          ],
          updatedAt: now
        }
      : order
  );
  const closed = nextOrders.find((order) => order.id === orderId);
  if (!closed) return state;
  const inventoryState = settleInventoryForClosedOrder({ ...state, orders: nextOrders }, closed, "delivered", false);
  return {
    ...inventoryState,
    orders: nextOrders,
    wallet: [...entriesForClosedOrder(closed, inventoryState), ...state.wallet],
    audit: [audit(state, "order.delivered", "order", orderId, "Pedido entregado y wallet actualizada"), ...state.audit]
  };
}

export function closeFailed(state: AppState, orderId: string, input: FailedEvidenceInput = {}): AppState {
  const now = new Date().toISOString();
  const reason = input.reason?.trim() || "Cliente no recibe";
  const isVisitRescheduled = reason === "Cliente reagenda visita";
  const failedCategory = isVisitRescheduled ? undefined : input.failedCategory ?? "failed_visit";
  const nextOrders = state.orders.map((order) =>
    order.id === orderId
      ? {
          ...order,
          status: isVisitRescheduled ? ("retry_pending" as const) : ("failed" as const),
          failedReason: reason,
          failedCategory,
          failedCategorySource: isVisitRescheduled ? order.failedCategorySource : ("driver" as const),
          retryDecision: isVisitRescheduled ? ("retry" as const) : ("pending" as const),
          scheduledDate: input.scheduledDate ?? order.scheduledDate,
          scheduledWindow: input.scheduledWindow ?? order.scheduledWindow,
          evidence: [
            ...order.evidence,
            {
              id: `ev-${Date.now()}`,
              type: "failed" as const,
              photoLabel: input.photoLabel ?? "fallido.jpg",
              photoUrl: input.photoUrl,
              storagePath: input.storagePath,
              note: input.note?.trim() || "Novedad de entrega registrada.",
              reason,
              failedCategory,
              actorId: actorByRole[state.activeRole],
              createdAt: now
            }
          ],
          updatedAt: now
        }
      : order
  );
  const closed = nextOrders.find((order) => order.id === orderId);
  if (!closed) return state;
  const inventoryState = settleInventoryForClosedOrder({ ...state, orders: nextOrders }, closed, "failed", isVisitRescheduled);
  return {
    ...inventoryState,
    orders: nextOrders,
    wallet: [...entriesForClosedOrder(closed, inventoryState), ...state.wallet],
    audit: [
      audit(
        state,
        isVisitRescheduled ? "order.retry_scheduled" : "order.failed",
        "order",
        orderId,
        isVisitRescheduled ? "Visita reagendada por el cliente" : "Pedido fallido, cobros y alerta de reintento generados"
      ),
      ...state.audit
    ]
  };
}

export function requestPayout(state: AppState, sellerId: string): AppState {
  const balance = sellerBalance(state, sellerId);
  if (balance.availableCop <= 0) return state;
  return {
    ...state,
    payouts: [
      {
        id: `pay-${Date.now()}`,
        sellerId,
        amountCop: balance.availableCop,
        status: "requested",
        createdAt: new Date().toISOString()
      },
      ...state.payouts
    ],
    audit: [
      audit(state, "payout.request", "seller", sellerId, `Solicitud automatica por ${balance.availableCop} COP`),
      ...state.audit
    ]
  };
}

export function approvePayout(state: AppState, payoutId: string): AppState {
  const payout = state.payouts.find((item) => item.id === payoutId);
  if (!payout) return state;
  return {
    ...state,
    payouts: state.payouts.map((item) => (item.id === payoutId ? { ...item, status: "paid" } : item)),
    wallet: [
      {
        id: `we-${payoutId}`,
        ownerType: "seller",
        ownerId: payout.sellerId,
        type: "payout",
        amountCop: -payout.amountCop,
        description: `Liquidacion pagada ${payoutId}`,
        createdAt: new Date().toISOString()
      },
      ...state.wallet
    ],
    audit: [audit(state, "payout.paid", "payout", payoutId, "Liquidacion marcada como pagada"), ...state.audit]
  };
}

export function createManualOrder(
  state: AppState,
  input: {
    sellerId: string;
    shopifyOrderId?: string;
    customerName: string;
    customerPhone: string;
    addressRaw: string;
    normalizedAddress?: string;
    zoneId?: string;
    paymentMethod: PaymentMethod;
    fulfillmentMode: FulfillmentMode;
    totalCop: number;
    productName?: string;
    sku?: string;
    addressRisk: AddressRisk;
  }
): AppState {
  const seller = state.sellers.find((item) => item.id === input.sellerId);
  if (!seller) return state;
  const now = new Date().toISOString();
  const orderId = `ord-${Date.now()}`;
  const orderNumber = input.shopifyOrderId?.trim() || `MAN-${String(state.orders.length + 1).padStart(4, "0")}`;
  const addressRisk = input.addressRisk;
  const selectedSku = input.sku?.trim() || undefined;
  const reservation = reserveInventoryForOrder(state, seller.id, selectedSku);
  if (!reservation.ok) return state;
  const order: Order = {
    id: orderId,
    trackingCode: nextLocalTrackingCode(state),
    shopifyOrderId: orderNumber.startsWith("#") || orderNumber.startsWith("MAN-") ? orderNumber : `#${orderNumber}`,
    sellerId: seller.id,
    cityId: seller.cityId || state.settings.activeCityId,
    zoneId: input.zoneId || undefined,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone.trim(),
    addressRaw: input.addressRaw.trim(),
    normalizedAddress: input.normalizedAddress?.trim() || undefined,
    addressRisk,
    status: addressRisk === "review" ? "address_risk" : "ready_to_assign",
    paymentMethod: input.paymentMethod,
    fulfillmentMode: input.fulfillmentMode,
    totalCop: input.totalCop,
    productName: input.productName?.trim() || undefined,
    sku: selectedSku,
    pickupPointName: seller.pickupPointName || seller.name,
    pickupAddress: seller.pickupAddress || "",
    evidence: [],
    createdAt: now,
    updatedAt: now
  };

  return {
    ...reservation.state,
    orders: [order, ...state.orders],
    audit: [audit(state, "order.manual_created", "order", order.id, `Pedido manual ${order.shopifyOrderId} creado`), ...state.audit]
  };
}

export function addShopifyOrder(state: AppState): AppState {
  const nextNumber = 3000 + state.orders.length;
  const seller = state.sellers[0];
  if (!seller) return state;
  const order: Order = {
    id: `ord-${Date.now()}`,
    trackingCode: nextLocalTrackingCode(state),
    shopifyOrderId: `#${nextNumber}`,
    sellerId: seller.id,
    cityId: state.settings.activeCityId,
    zoneId: "zone-center",
    customerName: "Cliente sincronizado",
    customerPhone: "+57 300 000 0000",
    addressRaw: "Av 6N # 25N-18, Cali",
    normalizedAddress: "Avenida 6N #25N-18, Cali, Colombia",
    geoProvider: "mapbox",
    addressRisk: "accepted",
    status: "ready_to_assign",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    totalCop: 129000,
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return {
    ...state,
    orders: [order, ...state.orders],
    audit: [audit(state, "shopify.webhook", "order", order.id, "Pedido importado por webhook simulado"), ...state.audit]
  };
}
