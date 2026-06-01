export type Role = "admin" | "seller" | "driver" | "messenger";
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
export type Zone = {
  id: string;
  cityId: string;
  name: string;
  polygonLabel: string;
  active?: boolean;
  sellerDeliveredFeeCop?: number;
  sellerFailedFeeCop?: number;
  fulfillmentFeeCop?: number;
  driverDeliveredPayCop?: number;
  driverFailedPayCop?: number;
};
export type Seller = {
  id: string;
  name: string;
  shopDomain: string;
  cityId: string;
  bankAccount: string;
  pickupPointName?: string;
  pickupAddress?: string;
  pickupContactName?: string;
  pickupContactPhone?: string;
  pickupNotes?: string;
  debtBlockedAt?: string;
};
export type ShopifyStore = {
  id: string;
  sellerId: string;
  shopDomain: string;
  status: "connected" | "error";
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
  lastWebhookAt?: string;
  errorMessage?: string;
};
export type ShopifyInstallRequest = {
  id: string;
  sellerId: string;
  sellerName: string;
  shopDomain: string;
  status: "requested" | "link_ready" | "installed" | "cancelled";
  installLink?: string;
  requestedAt: string;
  updatedAt: string;
  fulfilledAt?: string;
};
export type ShopifySyncIssue = {
  id: string;
  sellerId: string;
  shopDomain: string;
  reference: string;
  status: "open" | "resolved";
  reason: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  orderId?: string;
};
export type Driver = { id: string; name: string; phone: string; active: boolean };
export type Messenger = {
  id: string;
  leaderDriverId: string;
  name: string;
  phone: string;
  email?: string;
  authUid?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
export type PickupBatch = {
  id: string;
  driverId: string;
  pickupPointKey: string;
  pickupPointName: string;
  pickupAddress: string;
  orderIds: string[];
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};
export type InventoryItem = {
  id: string;
  sellerId: string;
  sku: string;
  name: string;
  available: number;
  reserved: number;
  minStock?: number;
  location?: string;
};

export type Order = {
  id: string;
  trackingCode?: string;
  shopifyOrderId: string;
  sellerId: string;
  cityId: string;
  zoneId?: string;
  driverId?: string;
  messengerId?: string;
  pickupBatchId?: string;
  pickupPointName?: string;
  pickupAddress?: string;
  pickedUpAt?: string;
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
  quantity?: number;
  labelPrintedAt?: string;
  labelPrintedBy?: string;
  labelPrintCount?: number;
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
  ownerType: "seller" | "driver" | "admin";
  ownerId: string;
  orderId?: string;
  settlementId?: string;
  type:
    | "cod_revenue"
    | "delivery_fee"
    | "failed_fee"
    | "fulfillment_fee"
    | "driver_earning"
    | "platform_margin"
    | "cod_remittance"
    | "payout";
  amountCop: number;
  description: string;
  createdAt: string;
};

export type Settlement = {
  id: string;
  kind: "seller" | "driver";
  ownerId: string;
  ownerName: string;
  startDate: string;
  endDate: string;
  walletEntryIds: string[];
  orderIds: string[];
  codCop: number;
  feesCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  netCop: number;
  status: "pending" | "paid" | "reconciled";
  createdAt: string;
  paidAt?: string;
  reconciledAt?: string;
  note?: string;
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
  shopifyStores: ShopifyStore[];
  shopifyInstallRequests: ShopifyInstallRequest[];
  shopifySyncIssues: ShopifySyncIssue[];
  drivers: Driver[];
  messengers: Messenger[];
  pickupBatches: PickupBatch[];
  inventory: InventoryItem[];
  orders: Order[];
  wallet: WalletEntry[];
  settlements: Settlement[];
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
