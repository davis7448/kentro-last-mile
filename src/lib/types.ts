/**
 * OJO con los dos "lideres": `driver` es el lider LOGISTICO (recoge y reparte) y
 * `community_leader` es el lider de COMUNIDAD (agrupa tiendas y cobra cashback). No tienen
 * ninguna relacion. En pantalla nunca se escribe "lider" a secas: ver `roleLabel`.
 */
export type Role = "admin" | "seller" | "seller_logistics" | "driver" | "messenger" | "community_leader";
export type PaymentMethod = "cod" | "prepaid";
export type FulfillmentMode = "seller_pickup" | "warehouse";
export type AddressRisk = "accepted" | "review" | "rejected";
export type FailedCategory = "failed_visit" | "no_coverage" | "bad_order_or_no_contact" | "bad_phone" | "pending_review";
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

export type OrderLineItem = {
  sku?: string;
  productName?: string;
  quantity: number;
};

export type Evidence = {
  id: string;
  type: "delivery" | "failed";
  photoLabel: string;
  photoUrl?: string;
  storagePath?: string;
  note: string;
  reason?: string;
  failedCategory?: FailedCategory;
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
export type CommunityPricingFields = {
  sellerDeliveredFeeCop?: number;
  sellerFailedFeeCop?: number;
  fulfillmentFeeCop?: number;
};

/** Subida de precio programada. Las subidas esperan ocho dias; las bajadas entran ya. */
export type ScheduledPriceChange = {
  field: keyof CommunityPricingFields;
  fromCop: number;
  toCop: number;
  effectiveAt: string;
  scheduledBy: string;
  scheduledAt: string;
};

export type CommunityPriceHistoryEntry = {
  field: keyof CommunityPricingFields;
  fromCop: number;
  toCop: number;
  effectiveAt: string;
  actorUid: string;
  actorRole: Role;
  createdAt: string;
};

export type Community = {
  id: string;
  /** Nombre visible. No es unico: dos comunidades pueden llamarse igual. */
  name: string;
  /** Nombre corto del enlace. Este SI es unico. */
  slug: string;
  leaderName: string;
  leaderEmail: string;
  leaderPhone: string;
  /** URL publica del logo. La pantalla de registro se pinta SIN sesion y no puede firmar. */
  logoPath?: string;
  linkStatus: "active" | "revoked";
  status: "active" | "disabled";
  pricing: CommunityPricingFields;
  /** Una programada como mucho por concepto: la segunda reemplaza a la primera. */
  scheduled?: Partial<Record<keyof CommunityPricingFields, ScheduledPriceChange>>;
  massSignupAlertAt?: string;
  massSignupAlertDismissedAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** communitySlugs/{slug}. `retiredAt` presente = slug viejo, valido 30 dias mas. */
export type CommunitySlugDoc = {
  communityId: string;
  retiredAt?: string;
};

/**
 * Precio congelado en el pedido al crearlo. Se guardan final Y base por concepto: el cashback
 * es la resta de dos numeros que cambian por separado, y con los dos se puede auditar de donde
 * salio. Ausente = pedido sin comunidad, que cobra la tarifa viva y no genera cashback.
 */
export type OrderCommunityPricing = {
  communityId: string;
  frozenAt: string;
  sellerDeliveredFeeCop: number;
  baseDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  baseFailedFeeCop: number;
  fulfillmentFeeCop: number;
  baseFulfillmentFeeCop: number;
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
  /**
   * Cobra en efectivo: sus pagos no pasan por el banco, asi que no generan 4x1000.
   * Va como marca por cuenta y no fijo en codigo, porque la forma de pago cambia.
   */
  paysInCash?: boolean;
  /** Comunidad a la que pertenece. Permanente salvo reasignacion de un administrador. */
  communityId?: string;
  communityJoinedAt?: string;
  /** Por que enlace entro. Se conserva aunque el lider cambie su nombre corto. */
  communitySignupSlug?: string;
  /** Ciudad, punto de recogida y cuenta bancaria completos: sin esto no puede crear pedidos. */
  onboardingComplete?: boolean;
};
export type ShopifyStore = {
  id: string;
  sellerId: string;
  shopDomain: string;
  status: "connected" | "error";
  scopes: string[];
  orderSkuContains?: string;
  orderTagContains?: string;
  connectedAt: string;
  updatedAt: string;
  lastWebhookAt?: string;
  errorMessage?: string;
};
export type StoreWebhookConfig = {
  id: string;
  sellerId: string;
  sellerName: string;
  shopDomain?: string;
  webhookKey: string;
  skuContains?: string;
  tagContains?: string;
  cityAllowlist: string[];
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastWebhookAt?: string;
  lastUchatConfirmAt?: string;
  uchatConfirmEnabled?: boolean;
  uchatConfigured?: boolean;
  uchatPlatform?: "chatby" | "chateapro" | "lucidbot";
  uchatDropiConfigured?: boolean;
  lastUchatPullAt?: string;
  lastUchatPullConfirmed?: number;
};
export type ShopifyInstallRequest = {
  id: string;
  sellerId: string;
  sellerName: string;
  shopDomain: string;
  status: "requested" | "link_ready" | "installed" | "cancelled";
  installLink?: string;
  observation?: string;
  orderSkuContains?: string;
  orderTagContains?: string;
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
export type Driver = { id: string; name: string; phone: string; active: boolean; paysInCash?: boolean };
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
export type Supplier = {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  notes?: string;
  active: boolean;
  paysInCash?: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ProductCatalogItem = {
  id: string;
  sellerId: string;
  supplierId: string;
  sku?: string;
  name: string;
  normalizedProductName?: string;
  productCostCop: number;
  productCostConfigured: boolean;
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
  productId?: string;
  supplierId?: string;
  productCostCop?: number;
  productCostConfigured?: boolean;
  available: number;
  reserved: number;
  minStock?: number;
  location?: string;
};

export type Order = {
  id: string;
  /** Como se confirmo el pedido: a mano desde la app o automaticamente por el bot de
   *  ChatBy. Las rutas de UChat ya lo escribian en Firestore sin declararlo aqui. */
  confirmedVia?: "manual" | "uchat" | "uchat_pull";
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
  productId?: string;
  productName?: string;
  sku?: string;
  quantity?: number;
  lineItems?: OrderLineItem[];
  /** Marcador: este pedido reservo inventario y por tanto debe liberarlo al cerrarse. */
  inventoryReserved?: boolean;
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
  failedCategory?: FailedCategory;
  failedCategorySource?: "driver" | "auto_reclassification" | "manual";
  failedCategoryConfidence?: number;
  retryDecision?: "pending" | "retry" | "cancel";
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
  /** Instante del cierre. Es el eje de fecha del dinero; se escribe en TODA transicion terminal. */
  closedAt?: string;
  /** Denormalizado al crear: sin el no se pueden agregar las cifras de una comunidad. */
  communityId?: string;
  communityPricing?: OrderCommunityPricing;
};

export type WalletEntry = {
  id: string;
  ownerType: "seller" | "driver" | "admin" | "community_leader";
  ownerId: string;
  orderId?: string;
  settlementId?: string;
  type:
    | "cod_revenue"
    | "delivery_fee"
    | "failed_fee"
    | "fulfillment_fee"
    | "product_cost"
    | "driver_earning"
    | "platform_margin"
    | "cod_remittance"
    | "payout"
    | "seller_abono"
    | "cash_shortage"
    /** Gravamen a los movimientos financieros (4x1000) sobre lo que sale por transferencia. */
    | "gmf_tax"
    /** Margen del lider de comunidad: precio que cobra a su tienda menos la base de Kentro. */
    | "community_cashback";
  amountCop: number;
  description: string;
  supplierSettlementId?: string;
  supplierId?: string;
  supplierName?: string;
  productId?: string;
  productName?: string;
  createdAt: string;
};

export type CashReceipt = {
  id?: string;
  amountCop: number;
  receivedAt?: string;
  createdAt?: string;
  note?: string;
};

export type Settlement = {
  id: string;
  kind: "seller" | "driver" | "supplier" | "community_leader";
  ownerId: string;
  ownerName: string;
  startDate: string;
  endDate: string;
  walletEntryIds: string[];
  orderIds: string[];
  codCop: number;
  feesCop: number;
  productCostCop?: number;
  driverPayCop: number;
  platformMarginCop: number;
  netCop: number;
  status: "pending" | "paid" | "reconciled";
  createdAt: string;
  paidAt?: string;
  reconciledAt?: string;
  note?: string;
  cashExpectedCop?: number;
  cashReceivedCop?: number;
  cashReceiptStatus?: "none" | "partial" | "complete";
  cashPendingCop?: number;
  /** Efectivo entregado por encima de lo esperado (queda a favor del domiciliario). */
  cashExcessCop?: number;
  /** Monto realmente transferido cuando el corte se pago por menos del neto. */
  paidAmountCop?: number;
  /** 4x1000 retenido en este corte. 0 si la cuenta cobra en efectivo. */
  gmfCop?: number;
  cashReceipts?: CashReceipt[];
  cashAllocations?: Array<{
    orderId?: string;
    expectedCop?: number;
    receivedCop?: number;
    covered?: boolean;
    amountCop?: number;
  }>;
};

export type PayoutRequest = {
  id: string;
  sellerId: string;
  sellerName?: string;
  /** Neto liquidable calculado por el servidor con la misma regla que createSettlement. */
  amountCop: number;
  /** Saldo retenido porque el COD de esos pedidos aun no entra de la flota. */
  blockedCop?: number;
  eligibleOrderCount?: number;
  status: "requested" | "approved" | "rejected" | "paid";
  requestedBy?: string;
  requestedByEmail?: string;
  /** Corte que la cerro. Una solicitud solo se paga creando la liquidacion real. */
  settlementId?: string;
  paidAt?: string;
  rejectedAt?: string;
  rejectedReason?: string;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  actorId: string;
  actorRole: Role;
  action: string;
  entity: string;
  entityId: string;
  /** Solo en eventos nuevos: los historicos solo tienen el cambio dentro de `summary`. */
  fromStatus?: string;
  toStatus?: string;
  summary: string;
  createdAt: string;
};

/** Una fila del historial de un pedido, tal como la devuelve el callable
 *  `getOrderAuditTrail`: igual que `AuditEvent` pero con el actor ya resuelto a nombre y
 *  correo (traducir el uid exige Admin SDK, el cliente no puede hacerlo). */
export type OrderAuditEntry = {
  id: string;
  createdAt: string;
  action: string;
  actorId: string;
  actorLabel: string;
  actorEmail?: string;
  actorRole?: string;
  fromStatus?: string;
  toStatus?: string;
  summary: string;
};

/** Las cuatro correcciones administrativas de estado que admite el callable
 *  `correctOrderStatus`. Cada una exige un estado de partida concreto; la matriz completa
 *  vive en functions/src/order-corrections-plan.ts. */
export type OrderCorrectionKind =
  | "failed_to_delivered"
  | "delivered_to_failed"
  | "cancelled_to_operational"
  | "failed_to_retry_pending";

export type OrderCorrectionNote = { code: string; message: string };

export type OrderCorrectionSettlementPreview = {
  id: string;
  kind: "seller" | "driver" | "supplier";
  ownerName: string;
  before: { walletEntryCount: number; orderCount: number; netCop: number; cashExpectedCop?: number; cashPendingCop?: number };
  after: { walletEntryCount: number; orderCount: number; netCop: number; cashExpectedCop?: number; cashPendingCop?: number };
  relatedEntryPatches: Array<{ id: string; amountCop: number; reason: string }>;
};

/** Consecuencias completas de una correccion, calculadas en el servidor ANTES de escribir.
 *  El mismo objeto se devuelve en la previsualizacion y en la aplicacion, porque el
 *  planificador es puro: lo que el admin aprueba es literalmente lo que se escribe.
 *  `blockers` no vacio significa que la correccion no puede aplicarse. */
export type OrderCorrectionPlan = {
  kind: OrderCorrectionKind;
  orderId: string;
  trackingCode: string;
  fromStatus: string;
  toStatus: string;
  orderPatchPreview: Record<string, string>;
  /** Numero de visita fallida que quedara registrada; decide el sufijo `-N` de los asientos. */
  failedAttempt?: number;
  entriesToDelete: WalletEntry[];
  entriesToCreate: WalletEntry[];
  entriesToCompensate: Array<{ sourceId: string; frozenSettlementId: string; entry: WalletEntry }>;
  entriesToKeep: WalletEntry[];
  settlementsToRecalculate: OrderCorrectionSettlementPreview[];
  frozenSettlements: Array<{ id: string; kind: string; status: string; ownerName: string }>;
  inventory: { kind: string; movements: Array<{ skuKey: string; quantity: number }> };
  financials: {
    sellerNetBeforeCop: number;
    sellerNetAfterCop: number;
    sellerDeltaCop: number;
    driverNetBeforeCop: number;
    driverNetAfterCop: number;
    driverDeltaCop: number;
  };
  warnings: OrderCorrectionNote[];
  blockers: OrderCorrectionNote[];
  auditAction: string;
  auditSummary: string;
};

/** Saldo real de las cuentas de la operacion en un momento dado, para contrastarlo
 *  contra el saldo teorico y detectar desfases a tiempo. */
export type CashSnapshot = {
  id: string;
  balanceCop: number;
  expectedCop: number;
  differenceCop: number;
  note?: string;
  createdAt: string;
  createdBy: string;
};

export type AppState = {
  activeRole: Role;
  cities: City[];
  zones: Zone[];
  sellers: Seller[];
  /** Comunidades. Solo las carga el admin (todas) y el lider (la suya). */
  communities: Community[];
  shopifyStores: ShopifyStore[];
  storeWebhookConfigs: StoreWebhookConfig[];
  shopifyInstallRequests: ShopifyInstallRequest[];
  shopifySyncIssues: ShopifySyncIssue[];
  drivers: Driver[];
  messengers: Messenger[];
  pickupBatches: PickupBatch[];
  suppliers: Supplier[];
  productCatalog: ProductCatalogItem[];
  inventory: InventoryItem[];
  orders: Order[];
  wallet: WalletEntry[];
  settlements: Settlement[];
  payouts: PayoutRequest[];
  audit: AuditEvent[];
  cashSnapshots: CashSnapshot[];
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
