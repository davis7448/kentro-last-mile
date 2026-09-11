"use client";

import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import type { BulkSignupDisableReport } from "../../../functions/src/community-containment";
import { validateLogo } from "../../../functions/src/community-pricing";
import type { AddressRisk, FailedCategory, FulfillmentMode, InventoryItem, Messenger, Order, OrderAuditEntry, OrderCorrectionKind, OrderCorrectionPlan, OrderStatus, PaymentMethod, PayoutRequest, PickupBatch, Role, Settlement, StoreWebhookConfig, WalletEntry } from "@/lib/types";
import { clearFirebaseLocalCache, getFirebaseClient } from "./client";

export type FirebaseSessionClaims = {
  role: Role | null;
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
  /** Comunidad del lider de comunidad. Nada que ver con driverId (lider logistico). */
  communityId?: string;
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
      messengerId: typeof token.claims.messengerId === "string" ? token.claims.messengerId : undefined,
      communityId: typeof token.claims.communityId === "string" ? token.claims.communityId : undefined
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
  // `community_leader` (RF_49): el callable ya lo acepta desde T8. Faltaba aqui, y era lo unico
  // que impedia cortar el cashback de una comunidad desde la pantalla de liquidaciones.
  kind: "seller" | "driver" | "supplier" | "community_leader";
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

// --- Lider de comunidad -------------------------------------------------------------------

/**
 * Cifras de una comunidad. Se piden al servidor SIEMPRE, incluso para un periodo corto: el
 * lider no descarga pedidos, ni uno. Ver `functions/src/community-stats.ts`.
 */
export async function fetchCommunityStats(input: { communityId: string; startDate: string; endDate: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "getCommunityStats");
  const result = await callable(input);
  return result.data as { raw: Record<string, unknown>; stats: Record<string, unknown>; sellerNames: Record<string, string> };
}

export async function scheduleCommunityPrice(input: { communityId: string; field: string; amountCop: number }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "scheduleCommunityPrice");
  return (await callable(input)).data;
}

export async function cancelScheduledCommunityPrice(input: { communityId: string; field: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "cancelScheduledCommunityPrice");
  return (await callable(input)).data;
}

/**
 * RF_14, RF_16: el logo de la comunidad. Sube el archivo y registra la marca resultante.
 *
 * Dos pasos y en este orden: primero Storage (el objeto tiene que existir antes de que nadie lo
 * apunte) y despues la callable, que es quien decide. Si la callable rechaza, en Storage queda un
 * archivo huerfano al que no apunta nada y la comunidad conserva su logo anterior — que es justo
 * lo que pide RF_16. Al reves (escribir primero y subir despues) un fallo de subida dejaria la
 * marca apuntando a un objeto inexistente, o sea la pantalla de registro con la imagen rota.
 *
 * El rechazo NO se atrapa: sube tal cual con su mensaje, porque el limite concreto ("El logo
 * supera 512 KB") es la mitad util del requisito. Un `catch` que lo convierta en "no se pudo"
 * deja al lider sin saber que cambiar.
 *
 * Los limites se comprueban aqui ANTES de gastar la subida, con la MISMA funcion probada que usa
 * el servidor (`validateLogo`): no hay dos definiciones del tope que puedan discrepar, y el
 * servidor sigue validando por su cuenta porque esto es un cliente y miente cuando quiere.
 */
export async function setCommunityLogo(input: { communityId: string; file: File }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  if (!client.auth.currentUser) throw new Error("Debes iniciar sesion para cambiar el logo.");

  const contentType = input.file.type;
  const sizeBytes = input.file.size;
  const check = validateLogo({ contentType, sizeBytes });
  if (!check.ok) throw new Error(check.reason);

  // El nombre sale del tipo ya validado y de un instante, no del archivo del usuario: asi la ruta
  // no puede traer espacios, acentos ni barras, y la regla de Storage —que reparte permisos por
  // `communities/{communityId}/...`— ve siempre la comunidad correcta en el segmento.
  const extension = contentType.slice("image/".length).replace("+xml", "");
  const path = `communities/${input.communityId}/logo-${Date.now()}.${extension}`;
  const logoRef = ref(client.storage, path);
  const task = uploadBytesResumable(logoRef, input.file, { contentType });
  await new Promise<void>((resolve, reject) => {
    // Techo duro, por el mismo motivo que en `uploadEvidenceImage`: sin el, el SDK reintenta en
    // silencio hasta diez minutos y el boton se queda "Subiendo..." para siempre.
    const timer = setTimeout(() => {
      task.cancel();
      reject(new Error("La subida del logo tardo demasiado. Reintenta cuando tengas mejor senal."));
    }, 60_000);
    task.on(
      "state_changed",
      null,
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });

  // Se guarda la URL de descarga y no la ruta cruda porque es lo que se PINTA: la pantalla de
  // registro hace `<img src={marca.logoPath}>` (src/app/registro/[slug]/signup-form.tsx) y una
  // ruta de Storage ahi es una imagen rota. `planLogoChange` trata el valor como una cadena
  // opaca, asi que la decision de que forma tiene vive aqui, donde se consume.
  const logoPath = await getDownloadURL(logoRef);
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "setCommunityLogo");
  return (await callable({ communityId: input.communityId, logoPath, contentType, sizeBytes })).data as {
    ok: boolean;
    changed: boolean;
    logoPath: string;
  };
}

/**
 * RF_11: mover una tienda de comunidad, o sacarla de la suya sin ponerle otra.
 *
 * Un destino vacio es una operacion legitima —desadscribir— y por eso la clave se OMITE en vez de
 * viajar vacia: el serializador de las callables convierte `undefined` en `null`, y el esquema del
 * servidor espera `string | ausente`. Mandar `null` haria fallar la desadscripcion por
 * "invalid-argument", que es un error incomprensible para lo que el administrador acaba de pedir.
 */
export async function reassignSellerCommunity(input: { sellerId: string; communityId?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const destino = typeof input.communityId === "string" ? input.communityId.trim() : "";
  const payload: { sellerId: string; communityId?: string } = { sellerId: input.sellerId };
  if (destino) payload.communityId = destino;
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "reassignSellerCommunity");
  return (await callable(payload)).data as {
    ok: boolean;
    changed: boolean;
    previousCommunityId: string | null;
  };
}

export async function setCommunitySlug(input: { communityId: string; slug: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "setCommunitySlug");
  return (await callable(input)).data as { slug: string };
}

export async function createCommunityLeader(input: {
  name: string; slug: string; leaderName: string; leaderEmail: string; leaderPhone: string; password: string;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "createCommunityLeader");
  return (await callable(input)).data as { communityId: string; slug: string; uid: string };
}

export async function setCommunityLinkStatus(input: { communityId: string; linkStatus: "active" | "revoked" }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "setCommunityLinkStatus");
  return (await callable(input)).data;
}

export async function setCommunityLeaderStatus(input: { communityId: string; status: "active" | "disabled" }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "setCommunityLeaderStatus");
  return (await callable(input)).data;
}

/**
 * RF_41, RF_42: la contencion de un enlace filtrado. Cierra accesos de las tiendas que entraron
 * por el en un rango; NO borra pedidos ni historial de dinero.
 *
 * Devuelve el informe ENTERO —lo cerrado, lo fallido con su motivo, lo intacto con el suyo— y
 * no el viejo `{ disabled: string[] }`: la lista de desactivadas a secas es exactamente lo que
 * hacia leer como exito una operacion en la que no se cerro ni un acceso.
 */
export async function disableCommunitySignupsInRange(input: { communityId: string; fromIso: string; toIso: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "disableCommunitySignupsInRange");
  return (await callable(input)).data as BulkSignupDisableReport;
}

export async function dismissMassSignupAlert(input: { communityId: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "dismissMassSignupAlert");
  return (await callable(input)).data;
}

/** Publica: sin sesion. Solo devuelve la marca del enlace, para pintar la pantalla. */
export async function fetchCommunityBySlug(slug: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "getCommunityBySlug");
  return (await callable({ slug })).data as { acceptsSignups: boolean; name?: string; logoPath?: string | null };
}

/** Publica: sin sesion. Crea la tienda ya operativa y adscrita a la comunidad del enlace. */
export async function registerSellerBySlug(input: {
  slug: string; email: string; password: string; responsibleName: string; phone: string; storeName: string;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "registerSellerBySlug");
  return (await callable(input)).data as { sellerId: string; communityId: string };
}

/** RNF_04: la tarifa vigente de la propia tienda y la subida programada, si la hay. */
export async function fetchMyStoreTariff() {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const callable = httpsCallable(getFunctions(client.app, "us-central1"), "getMyStoreTariff");
  // Espejo exacto de `StoreTariffView` (functions/src/community-pricing.ts). Es un `as`, no una
  // validacion: si miente, `tsc` no se entera y el error sale en pantalla. Mentia en dos sitios
  // — `communityName` llega `null` (no ausente) para una tienda sin comunidad, y `scheduled` ya
  // no es el documento crudo sino el aviso de cuatro claves que arma `buildStoreTariffView`.
  return (await callable({})).data as {
    communityId: string | null;
    communityName: string | null;
    current: Record<string, number>;
    scheduled: Record<string, { field: string; fromCop: number; toCop: number; effectiveAt: string }> | null;
  };
}
