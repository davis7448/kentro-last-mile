"use client";

import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import type { AddressRisk, FailedCategory, FulfillmentMode, InventoryItem, Messenger, Order, OrderAuditEntry, OrderCorrectionKind, OrderCorrectionPlan, OrderStatus, PaymentMethod, PayoutRequest, PickupBatch, Role, Settlement, StoreWebhookConfig, WalletEntry } from "@/lib/types";
import { clearFirebaseLocalCache, getFirebaseClient } from "./client";

export type FirebaseSessionClaims = {
  role: Role | null;
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
};

export async function ensureFirebaseSession(): Promise<User | null> {
  const client = getFirebaseClient();
  if (!client) return null;

  if (client.auth.currentUser) return client.auth.currentUser;
  const credential = await signInAnonymously(client.auth);
  return credential.user;
}

export function subscribeFirebaseUser(onUser: (user: User | null, claims: FirebaseSessionClaims) => void) {
  const client = getFirebaseClient();
  if (!client) return () => undefined;

  return onAuthStateChanged(client.auth, async (user) => {
    if (!user) {
      onUser(null, { role: null });
      return;
    }
    const token = await user.getIdTokenResult();
    const role = typeof token.claims.role === "string" ? (token.claims.role as Role) : null;
    onUser(user, {
      role,
      sellerId: typeof token.claims.sellerId === "string" ? token.claims.sellerId : undefined,
      driverId: typeof token.claims.driverId === "string" ? token.claims.driverId : undefined,
      messengerId: typeof token.claims.messengerId === "string" ? token.claims.messengerId : undefined
    });
  });
}

export async function signInWithFirebaseEmail(email: string, password: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  return signInWithEmailAndPassword(client.auth, email, password);
}

export async function signOutFirebase() {
  const client = getFirebaseClient();
  if (!client) return;
  await signOut(client.auth);
  // Los equipos son compartidos: la cache persistente de Firestore guarda pedidos y ledger en
  // IndexedDB, asi que se borra al salir. `clearFirebaseLocalCache` termina la instancia, por lo
  // que hace falta recargar para levantar una nueva.
  await clearFirebaseLocalCache();
  if (typeof window !== "undefined") window.location.reload();
}

export async function createManagedFirebaseUser(input: {
  email: string;
  password: string;
  name: string;
  role: Role;
  profileId: string;
  leaderDriverId?: string;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createManagedUser");
  const result = await callable(input);
  return result.data as { uid: string };
}

export async function getFirebaseBootstrapStatus() {
  const client = getFirebaseClient();
  if (!client) return { needsBootstrap: true };
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "getBootstrapStatus");
  const result = await callable({});
  return result.data as { needsBootstrap: boolean };
}

/**
 * Indicadores de un periodo agregados en el servidor, sin descargar pedidos.
 *
 * Se usa cuando el rango elegido se sale de la ventana de pedidos que tiene el navegador: en ese
 * caso el calculo local mostraria cifras cortas (solo lo cargado) sin avisar, que es peor que no
 * mostrarlas. `startDate` vacio significa "sin limite inferior".
 */
export type OrderPeriodStats = {
  total: number;
  delivered: number;
  failed: number;
  cancelled: number;
  liquidated: number;
  chargeableFailed: number;
  pickedByDriver: number;
  dispatchable: number;
  closedDispatchable: number;
  openDispatchable: number;
  dispatchRate: number;
  completionRate: number;
  deliveryRate: number;
  returnRate: number;
};

export async function getFirebaseOrderStats(input: { startDate: string; endDate: string; sellerId?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "getOrderStats");
  const result = await callable(input);
  return result.data as OrderPeriodStats;
}

export async function repairFirebaseOwnDriverProfile() {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "repairOwnDriverProfile");
  const result = await callable({});
  return result.data as { driver: { id: string; name: string; phone: string; active: boolean } };
}

export async function createManualFirebaseOrder(input: {
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
  addressRisk: Extract<AddressRisk, "accepted" | "review">;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createManualOrder");
  const result = await callable(input);
  return result.data as { order: Order };
}

export type OrderTransitionPatch = {
  status?: string;
  addressRisk?: AddressRisk;
  driverId?: string | null;
  geoProvider?: "mapbox" | "google_address_validation";
  normalizedAddress?: string;
  callOutcome?: "pending" | "confirmed" | "rescheduled";
  callNote?: string;
  scheduledDate?: string;
  scheduledWindow?: string;
  rescheduledDate?: string;
  rescheduledWindow?: string;
  pickupBatchId?: string;
  pickedUpAt?: string;
};

export async function applyFirebaseOrderTransition(input: { orderId: string; expectedStatus: string; patch: OrderTransitionPatch }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "applyOrderTransition");
  const result = await callable(input);
  return result.data as { ok: boolean; order: Order };
}

export async function requestFirebaseSellerPayout(sellerId?: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "requestSellerPayout");
  const result = await callable(sellerId ? { sellerId } : {});
  return (result.data as { payout: PayoutRequest }).payout;
}

export async function rejectFirebaseSellerPayout(input: { payoutId: string; reason?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "rejectSellerPayout");
  const result = await callable(input);
  return (result.data as { payout: PayoutRequest }).payout;
}

export async function fetchFirebaseOrderAuditTrail(orderId: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "getOrderAuditTrail");
  const result = await callable({ orderId });
  return (result.data as { events: OrderAuditEntry[] }).events;
}

export async function confirmFirebaseImportedOrder(orderId: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "confirmImportedOrder");
  const result = await callable({ orderId });
  return result.data as { order: Order };
}

export async function confirmFirebaseRetryOrder(orderId: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "confirmRetryOrder");
  const result = await callable({ orderId });
  return result.data as { order: Order };
}

export async function updateFirebaseImportedOrder(input: {
  orderId: string;
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
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "updateImportedOrder");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { order: Order };
}

export async function updateFirebaseOrderAdjustments(input: {
  orderId: string;
  totalCop: number;
  productName?: string;
  sku?: string;
  quantity?: number;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "updateOrderAdjustments");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { order: Order };
}

export async function createFirebaseMessengerProfile(input: { messengerId?: string; name: string; phone?: string; leaderDriverId?: string; email?: string; password?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createMessengerProfile");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { messenger: Messenger; authUid?: string; existingUser?: boolean };
}

export async function createFirebasePickupBatch(input: { orderIds: string[] }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createOrUpdatePickupBatch");
  const result = await callable(input);
  return result.data as { pickupBatch: PickupBatch };
}

export async function assignFirebaseMessengerToOrders(input: { orderIds: string[]; messengerId: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "assignMessengerToOrders");
  const result = await callable(input);
  return result.data as { orders: Order[] };
}

export async function unassignFirebaseMessengerFromOrders(input: { orderIds: string[] }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "unassignMessengerFromOrders");
  const result = await callable(input);
  return result.data as { orders: Order[] };
}

export async function recordFirebaseSupplierAbono(input: { supplierId: string; amountCop: number; note?: string; chargeGmf?: boolean }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "recordSupplierAbono");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as {
    settlement: Settlement;
    appliedCop: number;
    requestedCop: number;
    unappliedCop: number;
    remainingCop: number;
    orders: number;
    /** Parte del abono que quedo aplicada a un pedido partido (pago parcial). */
    partialCop: number;
  };
}

export async function classifyFirebaseFailedOrder(input: { orderId: string; failedCategory: FailedCategory }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "classifyFailedOrder");
  const result = await callable(input);
  return result.data as { order: Order; walletEntries: WalletEntry[] };
}

export async function cancelFirebaseOrder(input: { orderId: string; reason?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "cancelOrder");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { order: Order };
}

/**
 * Corrige el estado de un pedido ya cerrado (fallido -> entregado, entregado -> fallido,
 * anulado -> operativo, fallido -> nueva visita) junto con todas sus consecuencias
 * financieras. Sustituye a los scripts one-off que se corrian a mano contra produccion.
 *
 * Con `dryRun: true` devuelve el plan sin escribir nada; para aplicarlo hay que reenviar el
 * `planHash` de esa previsualizacion. Si algo cambio entre medias, el servidor lo rechaza en
 * vez de escribir un plan que el admin nunca vio.
 */
export async function correctFirebaseOrderStatus(input: {
  orderId: string;
  expectedStatus: "delivered" | "failed" | "cancelled";
  kind: OrderCorrectionKind;
  reason: string;
  dryRun: boolean;
  expectedPlanHash?: string;
  driverId?: string;
  failedCategory?: FailedCategory;
  failedReason?: string;
  targetStatus?: OrderStatus;
  scheduledDate?: string;
  scheduledWindow?: string;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "correctOrderStatus");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as {
    dryRun: boolean;
    applied: boolean;
    planHash: string;
    plan: OrderCorrectionPlan;
    order?: Order;
    walletEntries?: WalletEntry[];
    deletedWalletEntryIds?: string[];
    settlements?: Settlement[];
  };
}

export async function closeFirebaseOrder(input: {
  orderId: string;
  outcome: "delivered" | "failed";
  note: string;
  photoLabel: string;
  photoUrl?: string;
  storagePath?: string;
  reason?: string;
  failedCategory?: FailedCategory;
  scheduledDate?: string;
  scheduledWindow?: string;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "closeOrder");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { order: Order; walletEntries: WalletEntry[] };
}

export async function createFirebaseStoreWebhookConfig(input: { sellerId: string; shopDomain?: string; skuContains?: string; tagContains?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createStoreWebhookConfig");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { config: StoreWebhookConfig; webhookUrl: string };
}

export async function setFirebaseStoreUchatConfig(input: { sellerId: string; apiToken?: string; baseUrl?: string; platform?: "chatby" | "chateapro" | "lucidbot"; dropiApiToken?: string; enabled?: boolean }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "setStoreUchatConfig");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { ok: boolean; configured: boolean; enabled: boolean; platform: "chatby" | "chateapro" | "lucidbot"; dropiConfigured: boolean };
}

export async function createFirebaseSettlement(input: {
  kind: "seller" | "driver" | "supplier";
  ownerId: string;
  startDate: string;
  endDate: string;
  walletEntryIds?: string[];
  note?: string;
  /** Si en ESTE giro se cobro el 4x1000. Sin valor, se hereda de la marca de la cuenta. */
  chargeGmf?: boolean;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createSettlement");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { settlement: Settlement; walletEntries: WalletEntry[] };
}

export async function updateFirebaseSettlementStatus(input: {
  settlementId: string;
  status: "paid" | "reconciled";
  note?: string;
  /** Monto realmente transferido. Si es menor al neto, el saldo queda como abono pendiente. */
  paidAmountCop?: number;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "updateSettlementStatus");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { settlement: Settlement };
}

export async function recordFirebaseDriverCashReceipt(input: {
  settlementId: string;
  receivedNowCop: number;
  note?: string;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "recordDriverCashReceipt");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { settlement: Settlement; walletEntries: WalletEntry[] };
}

export async function createFirebaseStoreApiKey(input: {
  sellerId: string;
  rotate?: boolean;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createStoreApiKey");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as {
    config: { sellerId: string; sellerName: string; apiKey: string; status: string };
    usage: { kpis: string; orders: string; settlements: string };
  };
}

export async function recordFirebaseSellerAbono(input: {
  sellerId: string;
  amountCop: number;
  note?: string;
  chargeGmf?: boolean;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "recordSellerAbono");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { walletEntry: WalletEntry; gmfEntry: WalletEntry | null; gmfCop: number; netOwedBeforeCop: number; amountCop: number };
}

export async function reconcileFirebaseInventoryReservations() {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "reconcileInventoryReservations");
  const result = await callable({});
  return result.data as { inventory: InventoryItem[] };
}

export async function importFirebaseShopifyOrder(input: { shopDomain: string; reference: string; sellerId?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "importShopifyOrder");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { order: Order };
}

export async function syncFirebaseShopifyHistoricalOrders(input: { shopDomain: string; sellerId?: string; startDate: string; endDate: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "syncShopifyHistoricalOrders");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { imported: number; existing: number; skippedOutsideCali: number; skippedSkuFilter: number; fetched: number; orders: Order[] };
}

export async function setFirebaseUserRole(uid: string, role: Role, profileId?: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "setUserRole");
  await callable({
    uid,
    role,
    sellerId: role === "seller" ? profileId : undefined,
    driverId: role === "driver" ? profileId : undefined,
    messengerId: role === "messenger" ? profileId : undefined
  });
}
