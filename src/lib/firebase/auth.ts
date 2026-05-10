"use client";

import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import type { AddressRisk, FulfillmentMode, Order, PaymentMethod, Role, WalletEntry } from "@/lib/types";
import { getFirebaseClient } from "./client";

export type FirebaseSessionClaims = {
  role: Role | null;
  sellerId?: string;
  driverId?: string;
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
      driverId: typeof token.claims.driverId === "string" ? token.claims.driverId : undefined
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

export async function setFirebaseUserRole(uid: string, role: Role, profileId?: string) {
  const client = getFirebaseClient();
  if (!client) throw new Error("Firebase no esta configurado.");
  const functions = getFunctions(client.app, "us-central1");
  const callable = httpsCallable(functions, "setUserRole");
  await callable({
    uid,
    role,
    sellerId: role === "seller" ? profileId : undefined,
    driverId: role === "driver" ? profileId : undefined
  });
}
