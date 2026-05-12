"use client";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  serverTimestamp,
  setDoc,
  writeBatch
} from "firebase/firestore";
import { emptyState } from "@/lib/seed";
import type { AppState, AuditEvent, City, Driver, InventoryItem, Order, PayoutRequest, Role, Seller, Settlement, WalletEntry, Zone } from "@/lib/types";
import { getFirebaseClient } from "./client";

const settingsPath = ["settings", "global"] as const;
const collectionNames = [
  "cities",
  "zones",
  "sellers",
  "drivers",
  "inventory",
  "orders",
  "walletEntries",
  "settlements",
  "payouts",
  "auditEvents"
] as const;

export type FirestoreStateContext = {
  role: Role;
  profileId: string;
};

export function canUseFirestoreStore() {
  return getFirebaseClient() !== null;
}

export async function loadFirestoreState(context?: FirestoreStateContext): Promise<AppState | null> {
  const client = getFirebaseClient();
  if (!client) return null;
  const base = emptyState();
  const role = context?.role ?? "admin";
  const [settingsSnapshot, cities, zones, sellers, drivers, inventory, orders, wallet, settlements, payouts, audit] = await Promise.all([
    getDoc(doc(client.db, ...settingsPath)),
    getCollection<City>("cities"),
    getCollection<Zone>("zones"),
    role === "seller" && context ? getOwnDocument<Seller>("sellers", context.profileId) : role === "admin" ? getCollection<Seller>("sellers") : Promise.resolve([]),
    role === "driver" && context ? getOwnDocument<Driver>("drivers", context.profileId) : role === "admin" ? getCollection<Driver>("drivers") : Promise.resolve([]),
    role === "seller" && context ? getCollection<InventoryItem>("inventory", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<InventoryItem>("inventory") : Promise.resolve([]),
    getOrdersForContext(context),
    getWalletForContext(context),
    getSettlementsForContext(context),
    role === "seller" && context ? getCollection<PayoutRequest>("payouts", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<PayoutRequest>("payouts") : Promise.resolve([]),
    role === "admin" ? getCollection<AuditEvent>("auditEvents", true) : Promise.resolve([])
  ]);

  if (
    !settingsSnapshot.exists() &&
    cities.length === 0 &&
    sellers.length === 0 &&
    drivers.length === 0 &&
    orders.length === 0
  ) {
    return null;
  }

  return {
    ...base,
    activeRole: role,
    cities,
    zones,
    sellers,
    drivers,
    inventory,
    orders,
    wallet,
    settlements,
    payouts,
    audit,
    settings: settingsSnapshot.exists() ? { ...base.settings, ...settingsSnapshot.data() } : base.settings
  };
}

export async function saveFirestoreState(state: AppState, context?: FirestoreStateContext): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  const batch = writeBatch(client.db);
  if (context?.role === "seller") {
    writeEntities(batch, "orders", state.orders.filter((order) => order.sellerId === context.profileId));
    writeEntities(batch, "payouts", state.payouts.filter((payout) => payout.sellerId === context.profileId));
    await batch.commit();
    return;
  }
  if (context?.role === "driver") {
    writeEntities(
      batch,
      "orders",
      state.orders.filter((order) => order.driverId === context.profileId || !order.driverId)
    );
    await batch.commit();
    return;
  }

  batch.set(doc(client.db, ...settingsPath), { ...state.settings, updatedAt: serverTimestamp() }, { merge: true });
  writeEntities(batch, "cities", state.cities);
  writeEntities(batch, "zones", state.zones);
  writeEntities(batch, "sellers", state.sellers);
  writeEntities(batch, "drivers", state.drivers);
  writeEntities(batch, "inventory", state.inventory);
  writeEntities(batch, "orders", state.orders);
  writeEntities(batch, "walletEntries", state.wallet);
  writeEntities(batch, "settlements", state.settlements);
  writeEntities(batch, "payouts", state.payouts);
  writeEntities(batch, "auditEvents", state.audit.slice(0, 100));
  await batch.commit();
}

export async function saveFirestoreOrder(order: Order): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "orders", order.id), { ...order, driverId: order.driverId ?? null }, { merge: true });
}

export async function saveFirestoreWalletEntries(entries: WalletEntry[]): Promise<void> {
  const client = getFirebaseClient();
  if (!client || entries.length === 0) return;
  const batch = writeBatch(client.db);
  writeEntities(batch, "walletEntries", entries);
  await batch.commit();
}

export async function saveFirestoreInventoryItem(item: InventoryItem): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "inventory", item.id), item, { merge: true });
}

export function subscribeFirestoreState(context: FirestoreStateContext | undefined, onState: (state: AppState) => void) {
  const client = getFirebaseClient();
  if (!client) return () => undefined;
  const orderRef = collection(client.db, "orders");
  const inventoryRef = collection(client.db, "inventory");
  const walletRef = collection(client.db, "walletEntries");
  const settlementRef = collection(client.db, "settlements");
  const targets =
    context?.role === "seller"
      ? [
          query(orderRef, where("sellerId", "==", context.profileId)),
          query(inventoryRef, where("sellerId", "==", context.profileId)),
          query(walletRef, where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId)),
          query(settlementRef, where("kind", "==", "seller"), where("ownerId", "==", context.profileId))
        ]
      : context?.role === "driver"
        ? [
            query(orderRef, where("driverId", "==", context.profileId)),
            query(orderRef, where("driverId", "==", null)),
            query(walletRef, where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId)),
            query(settlementRef, where("kind", "==", "driver"), where("ownerId", "==", context.profileId))
          ]
        : [orderRef, inventoryRef, walletRef, settlementRef];
  const reload = () => {
    void loadFirestoreState(context).then((state) => {
      if (state) onState(state);
    });
  };
  const unsubscribers = targets.map((target) => onSnapshot(target, reload));
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

async function getCollection<T extends { id: string }>(
  name: string,
  ...constraints: Parameters<typeof query>[1][]
): Promise<T[]>;
async function getCollection<T extends { id: string }>(name: string, newestFirst: boolean): Promise<T[]>;
async function getCollection<T extends { id: string }>(
  name: string,
  newestFirstOrConstraint: boolean | Parameters<typeof query>[1] = false,
  ...constraints: Parameters<typeof query>[1][]
): Promise<T[]> {
  const client = getFirebaseClient();
  if (!client) return [];
  const ref = collection(client.db, name);
  const newestFirst = typeof newestFirstOrConstraint === "boolean" ? newestFirstOrConstraint : false;
  const queryConstraints = typeof newestFirstOrConstraint === "boolean" ? constraints : [newestFirstOrConstraint, ...constraints];
  const snapshot = await getDocs(query(ref, ...(newestFirst ? [orderBy("createdAt", "desc"), ...queryConstraints] : queryConstraints)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as T);
}

async function getOwnDocument<T extends { id: string }>(name: string, id: string): Promise<T[]> {
  const client = getFirebaseClient();
  if (!client) return [];
  const snapshot = await getDoc(doc(client.db, name, id));
  return snapshot.exists() ? [({ id: snapshot.id, ...snapshot.data() } as T)] : [];
}

async function getOrdersForContext(context?: FirestoreStateContext): Promise<Order[]> {
  if (context?.role === "seller") return getCollection<Order>("orders", where("sellerId", "==", context.profileId));
  if (context?.role === "driver") {
    const [assigned, free] = await Promise.all([
      getCollection<Order>("orders", where("driverId", "==", context.profileId)),
      getCollection<Order>("orders", where("driverId", "==", null))
    ]);
    return [...assigned, ...free].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return getCollection<Order>("orders");
}

async function getWalletForContext(context?: FirestoreStateContext): Promise<WalletEntry[]> {
  if (context?.role === "seller") {
    return getCollection<WalletEntry>("walletEntries", where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "driver") {
    return getCollection<WalletEntry>("walletEntries", where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId));
  }
  return getCollection<WalletEntry>("walletEntries");
}

async function getSettlementsForContext(context?: FirestoreStateContext): Promise<Settlement[]> {
  if (context?.role === "seller") {
    return getCollection<Settlement>("settlements", where("kind", "==", "seller"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "driver") {
    return getCollection<Settlement>("settlements", where("kind", "==", "driver"), where("ownerId", "==", context.profileId));
  }
  return getCollection<Settlement>("settlements", true);
}

function writeEntities<T extends { id: string }>(
  batch: ReturnType<typeof writeBatch>,
  collectionName: (typeof collectionNames)[number],
  entities: T[]
) {
  const client = getFirebaseClient();
  if (!client) return;
  for (const entity of entities) {
    const payload = collectionName === "orders" ? { ...entity, driverId: (entity as unknown as Order).driverId ?? null } : entity;
    batch.set(doc(client.db, collectionName, entity.id), payload, { merge: true });
  }
}
