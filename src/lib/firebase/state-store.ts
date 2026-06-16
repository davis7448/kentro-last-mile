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
  updateDoc,
  writeBatch
} from "firebase/firestore";
import { emptyState } from "@/lib/seed";
import type { AppState, AuditEvent, City, Driver, InventoryItem, Messenger, Order, PickupBatch, PayoutRequest, Role, Seller, Settlement, ShopifyInstallRequest, ShopifyStore, ShopifySyncIssue, StoreWebhookConfig, WalletEntry, Zone } from "@/lib/types";
import { getFirebaseClient } from "./client";

const settingsPath = ["settings", "global"] as const;
const collectionNames = [
  "cities",
  "zones",
  "sellers",
  "shopifyStores",
  "storeWebhookConfigs",
  "shopifyInstallRequests",
  "shopifySyncIssues",
  "drivers",
  "messengers",
  "pickupBatches",
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
  const [settingsSnapshot, cities, zones, sellers, shopifyStores, storeWebhookConfigs, shopifyInstallRequests, shopifySyncIssues, drivers, messengers, pickupBatches, inventory, orders, wallet, settlements, payouts, audit] = await Promise.all([
    getDoc(doc(client.db, ...settingsPath)),
    getCollection<City>("cities"),
    getCollection<Zone>("zones"),
    role === "seller" && context ? getOwnDocument<Seller>("sellers", context.profileId) : role === "admin" ? getCollection<Seller>("sellers") : Promise.resolve([]),
    role === "seller" && context ? getCollection<ShopifyStore>("shopifyStores", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifyStore>("shopifyStores") : Promise.resolve([]),
    role === "seller" && context ? getCollection<StoreWebhookConfig>("storeWebhookConfigs", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<StoreWebhookConfig>("storeWebhookConfigs") : Promise.resolve([]),
    role === "seller" && context ? getCollection<ShopifyInstallRequest>("shopifyInstallRequests", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifyInstallRequest>("shopifyInstallRequests") : Promise.resolve([]),
    role === "seller" && context ? getCollection<ShopifySyncIssue>("shopifySyncIssues", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifySyncIssue>("shopifySyncIssues", true) : Promise.resolve([]),
    role === "driver" && context ? getOwnDocument<Driver>("drivers", context.profileId) : role === "admin" ? getCollection<Driver>("drivers") : Promise.resolve([]),
    role === "messenger" && context ? getOwnDocument<Messenger>("messengers", context.profileId) : role === "driver" && context ? getCollection<Messenger>("messengers", where("leaderDriverId", "==", context.profileId)) : role === "admin" ? getCollection<Messenger>("messengers") : Promise.resolve([]),
    role === "driver" && context ? getCollection<PickupBatch>("pickupBatches", where("driverId", "==", context.profileId)) : role === "admin" ? getCollection<PickupBatch>("pickupBatches") : Promise.resolve([]),
    role === "seller" && context ? getCollection<InventoryItem>("inventory", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<InventoryItem>("inventory") : Promise.resolve([]),
    getOrdersForContext(context),
    getWalletForContext(context),
    getSettlementsForContext(context),
    role === "seller" && context ? getCollection<PayoutRequest>("payouts", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<PayoutRequest>("payouts") : Promise.resolve([]),
    role === "admin" ? getCollection<AuditEvent>("auditEvents", true) : Promise.resolve([])
  ]);

  const resolvedSellers =
    sellers.length > 0 || role !== "driver"
      ? sellers
      : await getDocumentsByIds<Seller>("sellers", Array.from(new Set((orders ?? []).map((order) => order.sellerId).filter(Boolean))));

  if (
    !settingsSnapshot.exists() &&
    cities.length === 0 &&
    sellers.length === 0 &&
    drivers.length === 0 &&
    messengers.length === 0 &&
    orders.length === 0
  ) {
    return null;
  }

  return {
    ...base,
    activeRole: role,
    cities: cities ?? [],
    zones: zones ?? [],
    sellers: resolvedSellers ?? [],
    shopifyStores: shopifyStores ?? [],
    storeWebhookConfigs: storeWebhookConfigs ?? [],
    shopifyInstallRequests: shopifyInstallRequests ?? [],
    shopifySyncIssues: shopifySyncIssues ?? [],
    drivers: drivers ?? [],
    messengers: messengers ?? [],
    pickupBatches: pickupBatches ?? [],
    inventory: inventory ?? [],
    orders: (orders ?? []).map(normalizeOrder),
    wallet: wallet ?? [],
    settlements: settlements ?? [],
    payouts: payouts ?? [],
    audit: audit ?? [],
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
      state.orders.filter((order) => order.driverId === context.profileId || (!order.driverId && order.status === "ready_to_assign"))
    );
    await batch.commit();
    return;
  }
  if (context?.role === "messenger") {
    writeEntities(batch, "orders", state.orders.filter((order) => order.messengerId === context.profileId));
    await batch.commit();
    return;
  }

  batch.set(doc(client.db, ...settingsPath), { ...state.settings, updatedAt: serverTimestamp() }, { merge: true });
  writeEntities(batch, "cities", state.cities);
  writeEntities(batch, "zones", state.zones);
  writeEntities(batch, "sellers", state.sellers);
  writeEntities(batch, "shopifyStores", state.shopifyStores);
  writeEntities(batch, "storeWebhookConfigs", state.storeWebhookConfigs);
  writeEntities(batch, "shopifyInstallRequests", state.shopifyInstallRequests);
  writeEntities(batch, "drivers", state.drivers);
  writeEntities(batch, "messengers", state.messengers);
  writeEntities(batch, "pickupBatches", state.pickupBatches);
  writeEntities(batch, "inventory", state.inventory);
  writeEntities(batch, "orders", state.orders);
  writeEntities(batch, "walletEntries", state.wallet);
  writeEntities(batch, "settlements", state.settlements);
  writeEntities(batch, "payouts", state.payouts);
  await batch.commit();
}

export async function saveFirestoreOrder(order: Order): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "orders", order.id), sanitizeFirestoreValue({ ...order, driverId: order.driverId ?? null, messengerId: order.messengerId ?? null }), { merge: true });
}

export async function saveFirestoreOrderLabelPrint(order: Pick<Order, "id" | "labelPrintedAt" | "labelPrintedBy" | "labelPrintCount" | "updatedAt">): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await updateDoc(doc(client.db, "orders", order.id), {
    labelPrintedAt: order.labelPrintedAt,
    labelPrintedBy: order.labelPrintedBy ?? "",
    labelPrintCount: order.labelPrintCount ?? 1,
    updatedAt: order.updatedAt
  });
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

export async function saveFirestoreZone(zone: Zone): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "zones", zone.id), zone, { merge: true });
}

export async function saveFirestoreShopifyInstallRequest(request: ShopifyInstallRequest): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "shopifyInstallRequests", request.id), request, { merge: true });
}

export function subscribeFirestoreState(context: FirestoreStateContext | undefined, onState: (state: AppState) => void) {
  const client = getFirebaseClient();
  if (!client) return () => undefined;
  const orderRef = collection(client.db, "orders");
  const inventoryRef = collection(client.db, "inventory");
  const shopifyStoreRef = collection(client.db, "shopifyStores");
  const storeWebhookConfigRef = collection(client.db, "storeWebhookConfigs");
  const shopifyInstallRequestRef = collection(client.db, "shopifyInstallRequests");
  const shopifySyncIssueRef = collection(client.db, "shopifySyncIssues");
  const walletRef = collection(client.db, "walletEntries");
  const settlementRef = collection(client.db, "settlements");
  const messengerRef = collection(client.db, "messengers");
  const pickupBatchRef = collection(client.db, "pickupBatches");
  const targets =
    context?.role === "seller"
      ? [
          query(orderRef, where("sellerId", "==", context.profileId)),
          query(inventoryRef, where("sellerId", "==", context.profileId)),
          query(shopifyStoreRef, where("sellerId", "==", context.profileId)),
          query(storeWebhookConfigRef, where("sellerId", "==", context.profileId)),
          query(shopifyInstallRequestRef, where("sellerId", "==", context.profileId)),
          query(shopifySyncIssueRef, where("sellerId", "==", context.profileId)),
          query(walletRef, where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId)),
          query(settlementRef, where("kind", "==", "seller"), where("ownerId", "==", context.profileId))
        ]
      : context?.role === "driver"
        ? [
          query(orderRef, where("driverId", "==", context.profileId)),
          query(orderRef, where("driverId", "==", null), where("status", "==", "ready_to_assign")),
          query(messengerRef, where("leaderDriverId", "==", context.profileId)),
          query(pickupBatchRef, where("driverId", "==", context.profileId)),
          query(walletRef, where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId)),
          query(settlementRef, where("kind", "==", "driver"), where("ownerId", "==", context.profileId))
        ]
        : context?.role === "messenger"
          ? [
              query(orderRef, where("messengerId", "==", context.profileId)),
              query(messengerRef, where("__name__", "==", context.profileId))
            ]
          : [orderRef, inventoryRef, shopifyStoreRef, storeWebhookConfigRef, shopifyInstallRequestRef, shopifySyncIssueRef, messengerRef, pickupBatchRef, walletRef, settlementRef];
  const reload = () => {
    void loadFirestoreState(context).then((state) => {
      if (state) onState(state);
    });
  };
  const unsubscribers = targets.map((target) =>
    onSnapshot(target, reload, (error) => {
      console.warn("No se pudo sincronizar una coleccion de Live.", error.message);
    })
  );
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

function normalizeOrder(order: Order): Order {
  return {
    ...order,
    driverId: order.driverId ?? undefined,
    messengerId: order.messengerId ?? undefined,
    pickupBatchId: order.pickupBatchId ?? undefined,
    evidence: Array.isArray(order.evidence) ? order.evidence : [],
    createdAt: order.createdAt ?? new Date().toISOString(),
    updatedAt: order.updatedAt ?? order.createdAt ?? new Date().toISOString()
  };
}

async function getOwnDocument<T extends { id: string }>(name: string, id: string): Promise<T[]> {
  const client = getFirebaseClient();
  if (!client) return [];
  const snapshot = await getDoc(doc(client.db, name, id));
  return snapshot.exists() ? [({ id: snapshot.id, ...snapshot.data() } as T)] : [];
}

async function getDocumentsByIds<T extends { id: string }>(name: string, ids: string[]): Promise<T[]> {
  const client = getFirebaseClient();
  if (!client || ids.length === 0) return [];
  const docs = await Promise.all(ids.map((id) => getDoc(doc(client.db, name, id)).catch(() => null)));
  return docs
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot?.exists()))
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }) as T);
}

async function getOrdersForContext(context?: FirestoreStateContext): Promise<Order[]> {
  if (context?.role === "seller") return getCollection<Order>("orders", where("sellerId", "==", context.profileId));
  if (context?.role === "driver") {
    const [assigned, free] = await Promise.all([
      getCollection<Order>("orders", where("driverId", "==", context.profileId)),
      getCollection<Order>("orders", where("driverId", "==", null), where("status", "==", "ready_to_assign"))
    ]);
    return [...assigned, ...free].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (context?.role === "messenger") return getCollection<Order>("orders", where("messengerId", "==", context.profileId));
  return getCollection<Order>("orders");
}

async function getWalletForContext(context?: FirestoreStateContext): Promise<WalletEntry[]> {
  if (context?.role === "seller") {
    return getCollection<WalletEntry>("walletEntries", where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "driver") {
    return getCollection<WalletEntry>("walletEntries", where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "messenger") return Promise.resolve([]);
  return getCollection<WalletEntry>("walletEntries");
}

async function getSettlementsForContext(context?: FirestoreStateContext): Promise<Settlement[]> {
  if (context?.role === "seller") {
    return getCollection<Settlement>("settlements", where("kind", "==", "seller"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "driver") {
    return getCollection<Settlement>("settlements", where("kind", "==", "driver"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "messenger") return Promise.resolve([]);
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
    const payload = collectionName === "orders" ? { ...entity, driverId: (entity as unknown as Order).driverId ?? null, messengerId: (entity as unknown as Order).messengerId ?? null } : entity;
    batch.set(doc(client.db, collectionName, entity.id), sanitizeFirestoreValue(payload), { merge: true });
  }
}

function sanitizeFirestoreValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => sanitizeFirestoreValue(item)) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, sanitizeFirestoreValue(item)])
    ) as T;
  }
  return value;
}
