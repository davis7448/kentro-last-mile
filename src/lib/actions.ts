"use client";

import { entriesForClosedOrder, sellerBalance } from "./finance";
import {
  applyInventoryMovementsToItems,
  inventoryMovementsForOrder,
  normalizeOrderLines,
  orderOwnsInventoryReservation,
  summarizeOrderLines
} from "./inventory-movements";
import type { AddressRisk, AppState, AuditEvent, FailedCategory, FulfillmentMode, Order, OrderStatus, PaymentMethod, Role } from "./types";

const actorByRole: Record<Role, string> = {
  admin: "admin",
  seller: "seller",
  seller_logistics: "seller_logistics",
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

// Espejo offline de las rutas de inventario del backend. Nunca bloquea por falta de stock:
// un SKU sin ficha simplemente no mueve nada.
function settleInventoryForClosedOrder(state: AppState, order: Order, outcome: "delivered" | "failed", retry: boolean) {
  if (!orderOwnsInventoryReservation(order)) return state;
  if (outcome === "failed" && retry) return state;
  return {
    ...state,
    inventory: applyInventoryMovementsToItems(
      state.inventory,
      order.sellerId,
      inventoryMovementsForOrder(order),
      outcome === "delivered" ? "consume" : "release"
    )
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

export function registerNoAnswerAttempt(state: AppState, orderId: string): AppState {
  const stamp = new Date().toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const attempt = `No contesta ${stamp}`;
  return mutateOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      callNote: order.callNote ? `${order.callNote} | ${attempt}` : attempt,
      updatedAt: new Date().toISOString()
    }),
    attempt
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

// requestPayout / approvePayout se eliminaron a proposito.
//
// requestPayout era una funcion pura: agregaba la solicitud al estado de React y nada mas, y el
// efecto que persiste el estado se salia para todo rol que no fuera admin, asi que la tienda veia
// "requested" en pantalla y el documento nunca llegaba a Firestore. Ahora va por el callable
// requestSellerPayout, que calcula el monto en el servidor.
//
// approvePayout escribia un asiento de wallet `type: "payout"` en negativo. Ese tipo no cuenta
// para los cortes (SELLER_LIQUIDATION_TYPES), asi que bajaba el saldo en pantalla sin estampar
// settlementId en los asientos originales: el siguiente corte los volvia a pagar. Una solicitud
// ahora se cierra sola cuando createSettlement crea el corte real, o con rejectSellerPayout.

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
    quantity?: number;
    lineItems?: Array<{ productName?: string; sku?: string; quantity: number }>;
    addressRisk: AddressRisk;
  }
): AppState {
  const seller = state.sellers.find((item) => item.id === input.sellerId);
  if (!seller) return state;
  const now = new Date().toISOString();
  const orderId = `ord-${Date.now()}`;
  const orderNumber = input.shopifyOrderId?.trim() || `MAN-${String(state.orders.length + 1).padStart(4, "0")}`;
  const addressRisk = input.addressRisk;
  const collapsed = summarizeOrderLines(normalizeOrderLines(input));
  const movements = inventoryMovementsForOrder(collapsed);
  const reservedSomething = movements.some((movement) =>
    state.inventory.some((item) => item.sellerId === seller.id && item.sku?.trim().toUpperCase() === movement.skuKey));
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
    productName: collapsed.productName,
    sku: collapsed.sku,
    quantity: collapsed.quantity,
    lineItems: collapsed.lineItems.length > 0 ? collapsed.lineItems : undefined,
    inventoryReserved: reservedSomething || undefined,
    pickupPointName: seller.pickupPointName || seller.name,
    pickupAddress: seller.pickupAddress || "",
    evidence: [],
    createdAt: now,
    updatedAt: now
  };

  return {
    ...state,
    inventory: applyInventoryMovementsToItems(state.inventory, seller.id, movements, "reserve"),
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
