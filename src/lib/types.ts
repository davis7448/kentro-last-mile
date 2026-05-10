export type Role = "admin" | "seller" | "driver";
export type PaymentMethod = "cod" | "prepaid";
export type FulfillmentMode = "seller_pickup" | "warehouse";
export type AddressRisk = "accepted" | "review" | "rejected";
export type OrderStatus =
  | "imported"
  | "address_risk"
  | "ready_to_assign"
  | "assigned"
  | "call_pending"
  | "scheduled"
  | "pickup_pending"
  | "picked_up"
  | "in_route"
  | "delivered"
  | "failed"
  | "retry_pending"
  | "cancelled"
  | "liquidated";

export type Evidence = {
  id: string;
  type: "delivery" | "failed";
  photoLabel: string;
  photoUrl?: string;
  storagePath?: string;
  note: string;
  reason?: string;
  createdAt: string;
  actorId: string;
};

export type City = { id: string; name: string; active: boolean };
export type Zone = { id: string; cityId: string; name: string; polygonLabel: string };
export type Seller = {
  id: string;
  name: string;
  shopDomain: string;
  cityId: string;
  bankAccount: string;
  debtBlockedAt?: string;
};
export type Driver = { id: string; name: string; phone: string; active: boolean };
export type InventoryItem = {
  id: string;
  sellerId: string;
  sku: string;
  name: string;
  available: number;
  reserved: number;
};

export type Order = {
  id: string;
  shopifyOrderId: string;
  sellerId: string;
  cityId: string;
  zoneId?: string;
  driverId?: string;
  customerName: string;
  customerPhone: string;
  addressRaw: string;
  normalizedAddress?: string;
  geoProvider?: "mapbox" | "google_address_validation";
  lat?: number;
  lng?: number;
  addressRisk: AddressRisk;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  fulfillmentMode: FulfillmentMode;
  totalCop: number;
  productName?: string;
  sku?: string;
  scheduledWindow?: string;
  scheduledDate?: string;
  callOutcome?: "pending" | "confirmed" | "rescheduled";
  callNote?: string;
  rescheduledDate?: string;
  rescheduledWindow?: string;
  failedReason?: string;
  retryDecision?: "pending" | "retry" | "cancel";
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
};

export type WalletEntry = {
  id: string;
  ownerType: "seller" | "driver";
  ownerId: string;
  orderId?: string;
  type:
    | "cod_revenue"
    | "delivery_fee"
    | "failed_fee"
    | "fulfillment_fee"
    | "driver_earning"
    | "cod_remittance"
    | "payout";
  amountCop: number;
  description: string;
  createdAt: string;
};

export type PayoutRequest = {
  id: string;
  sellerId: string;
  amountCop: number;
  status: "requested" | "approved" | "rejected" | "paid";
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  actorId: string;
  actorRole: Role;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  createdAt: string;
};

export type AppState = {
  activeRole: Role;
  cities: City[];
  zones: Zone[];
  sellers: Seller[];
  drivers: Driver[];
  inventory: InventoryItem[];
  orders: Order[];
  wallet: WalletEntry[];
  payouts: PayoutRequest[];
  audit: AuditEvent[];
  settings: {
    activeCityId: string;
    sellerDeliveredFeeCop: number;
    sellerFailedFeeCop: number;
    fulfillmentFeeCop: number;
    driverDeliveredPayCop: number;
    driverFailedPayCop: number;
    pendingReserveCop: number;
    debtBlockDays: number;
    failedRateAlertPercent: number;
    payoutDays: string[];
  };
};
