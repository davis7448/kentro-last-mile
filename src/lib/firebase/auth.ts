"use client";

import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import type { AddressRisk, FulfillmentMode, InventoryItem, Messenger, Order, PaymentMethod, PickupBatch, Role, Settlement, WalletEntry } from "@/lib/types";
import { getFirebaseClient } from "./client";

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
  addressRisk: Extract<AddressRisk, "accepted" | "review">;
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "createManualOrder");
  const result = await callable(input);
  return result.data as { order: Order };
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

export async function cancelFirebaseOrder(input: { orderId: string; reason?: string }) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "cancelOrder");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { order: Order };
}

export async function closeFirebaseOrder(input: {
  orderId: string;
  outcome: "delivered" | "failed";
  note: string;
  photoLabel: string;
  photoUrl?: string;
  storagePath?: string;
  reason?: string;
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

export async function createFirebaseSettlement(input: {
  kind: "seller" | "driver";
  ownerId: string;
  startDate: string;
  endDate: string;
  note?: string;
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
}) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "updateSettlementStatus");
  const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = await callable(payload);
  return result.data as { settlement: Settlement };
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
  return result.data as { imported: number; existing: number; skippedOutsideCali: number; fetched: number; orders: Order[] };
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
