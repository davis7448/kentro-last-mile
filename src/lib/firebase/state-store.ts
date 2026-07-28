"use client";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as limitTo,
  onSnapshot,
  orderBy,
  query,
  where,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Query
} from "firebase/firestore";
import { emptyState } from "@/lib/seed";
import type { AppState, AuditEvent, City, Driver, InventoryItem, Messenger, Order, PickupBatch, PayoutRequest, ProductCatalogItem, Role, Seller, Settlement, ShopifyInstallRequest, ShopifyStore, ShopifySyncIssue, StoreWebhookConfig, Supplier, WalletEntry, Zone } from "@/lib/types";
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
  "suppliers",
  "productCatalog",
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

// Colecciones que se sirven por listener incremental. Cuando la suscripcion esta
// activa, loadFirestoreState las omite: el snapshot inicial del listener ya trae
// esos documentos y bajarlos otra vez con getDocs duplicaba la descarga al montar.
type WatchedKey =
  | "orders"
  | "inventory"
  | "suppliers"
  | "productCatalog"
  | "shopifyStores"
  | "storeWebhookConfigs"
  | "shopifyInstallRequests"
  | "shopifySyncIssues"
  | "messengers"
  | "pickupBatches"
  | "wallet"
  | "settlements";

type LoadOptions = { skip?: ReadonlySet<WatchedKey> };

// Solo se piden los ultimos 50 eventos: el unico consumidor (AuditBar) pinta 4 filas
// y la coleccion completa ya supera los 7.000 documentos.
const AUDIT_LIMIT = 50;

// shopifySyncIssues es un log append-only de pedidos Shopify rechazados: ya supera
// los 45.000 documentos (~17 MB, el 79% de la descarga inicial) y crece ~20.000 al
// mes, mientras el panel que lo consume solo muestra 5 filas paginadas.
const SYNC_ISSUES_LIMIT = 200;

// Diagnostico de carga, apagado por defecto. Para activarlo en el navegador:
//   localStorage.setItem("kentro-perf", "1")  y recargar.
function perfLog(message: string) {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem("kentro-perf") !== "1") return;
  } catch {
    return;
  }
  console.info(`[Kentro perf] ${message}`);
}

export function canUseFirestoreStore() {
  return getFirebaseClient() !== null;
}

export async function loadFirestoreState(context?: FirestoreStateContext, options?: LoadOptions): Promise<AppState | null> {
  const client = getFirebaseClient();
  if (!client) return null;
  const base = emptyState();
  const role = context?.role ?? "admin";
  const skip = options?.skip;
  const skipped = <T,>(key: WatchedKey, load: () => Promise<T[]>): Promise<T[]> => (skip?.has(key) ? Promise.resolve([]) : load());
  // seller_logistics ve lo operativo de su tienda igual que el vendedor, pero sin datos financieros.
  const storeRole = role === "seller" || role === "seller_logistics";
  const [settingsSnapshot, cities, zones, sellers, shopifyStores, storeWebhookConfigs, shopifyInstallRequests, shopifySyncIssues, drivers, messengers, pickupBatches, suppliers, productCatalog, inventory, orders, wallet, settlements, payouts, audit] = await Promise.all([
    getDoc(doc(client.db, ...settingsPath)),
    getCollection<City>("cities"),
    getCollection<Zone>("zones"),
    storeRole && context ? getOwnDocument<Seller>("sellers", context.profileId) : role === "admin" ? getCollection<Seller>("sellers") : Promise.resolve([]),
    skipped("shopifyStores", () => storeRole && context ? getCollection<ShopifyStore>("shopifyStores", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifyStore>("shopifyStores") : Promise.resolve([])),
    skipped("storeWebhookConfigs", () => storeRole && context ? getCollection<StoreWebhookConfig>("storeWebhookConfigs", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<StoreWebhookConfig>("storeWebhookConfigs") : Promise.resolve([])),
    skipped("shopifyInstallRequests", () => storeRole && context ? getCollection<ShopifyInstallRequest>("shopifyInstallRequests", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifyInstallRequest>("shopifyInstallRequests") : Promise.resolve([])),
    skipped("shopifySyncIssues", () => storeRole && context ? getCollection<ShopifySyncIssue>("shopifySyncIssues", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifySyncIssue>("shopifySyncIssues", true, SYNC_ISSUES_LIMIT) : Promise.resolve([])),
    role === "driver" && context ? getOwnDocument<Driver>("drivers", context.profileId) : role === "admin" ? getCollection<Driver>("drivers") : Promise.resolve([]),
    skipped("messengers", () => role === "messenger" && context ? getOwnDocument<Messenger>("messengers", context.profileId) : role === "driver" && context ? getCollection<Messenger>("messengers", where("leaderDriverId", "==", context.profileId)) : role === "admin" ? getCollection<Messenger>("messengers") : Promise.resolve([])),
    skipped("pickupBatches", () => role === "driver" && context ? getCollection<PickupBatch>("pickupBatches", where("driverId", "==", context.profileId)) : role === "admin" ? getCollection<PickupBatch>("pickupBatches") : Promise.resolve([])),
    skipped("suppliers", () => role === "admin" ? getCollection<Supplier>("suppliers") : Promise.resolve([])),
    skipped("productCatalog", () => storeRole && context ? getCollection<ProductCatalogItem>("productCatalog", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ProductCatalogItem>("productCatalog") : Promise.resolve([])),
    skipped("inventory", () => storeRole && context ? getCollection<InventoryItem>("inventory", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<InventoryItem>("inventory") : Promise.resolve([])),
    skipped("orders", () => getOrdersForContext(context)),
    skipped("wallet", () => getWalletForContext(context)),
    skipped("settlements", () => getSettlementsForContext(context)),
    role === "seller" && context ? getCollection<PayoutRequest>("payouts", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<PayoutRequest>("payouts") : Promise.resolve([]),
    role === "admin" ? getCollection<AuditEvent>("auditEvents", true, AUDIT_LIMIT) : Promise.resolve([])
  ]);

  const resolvedSellers =
    sellers.length > 0 || role !== "driver"
      ? sellers
      : sellerReferencesFromOrders(orders ?? []);

  // Deteccion de "base vacia" (bootstrap). Sigue siendo valida con skip activo: las
  // colecciones que decide (settings, cities, sellers, drivers) nunca se omiten.
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
    suppliers: suppliers ?? [],
    productCatalog: productCatalog ?? [],
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
    writeEntities(batch, "payouts", state.payouts.filter((payout) => payout.sellerId === context.profileId));
    await batch.commit();
    return;
  }
  if (context?.role === "driver") {
    return;
  }
  if (context?.role === "messenger") {
    return;
  }
  if (context?.role === "seller_logistics") {
    // El logistico de tienda no persiste estado global; sus acciones van por callables.
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
  writeEntities(batch, "suppliers", state.suppliers);
  writeEntities(batch, "productCatalog", state.productCatalog);
  writeEntities(batch, "inventory", state.inventory);
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

export async function saveFirestoreSettlement(settlement: Settlement): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "settlements", settlement.id), sanitizeFirestoreValue(settlement), { merge: true });
}

export async function saveFirestoreInventoryItem(item: InventoryItem): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "inventory", item.id), item, { merge: true });
}

export async function saveFirestoreSupplier(supplier: Supplier): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "suppliers", supplier.id), sanitizeFirestoreValue(supplier), { merge: true });
}

export async function saveFirestoreProductCatalogItem(item: ProductCatalogItem): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "productCatalog", item.id), sanitizeFirestoreValue(item), { merge: true });
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

export function subscribeFirestoreState(
  context: FirestoreStateContext | undefined,
  onState: (state: AppState) => void,
  onEmpty?: () => void
) {
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
  const supplierRef = collection(client.db, "suppliers");
  const productCatalogRef = collection(client.db, "productCatalog");
  const targets: Array<{ key: WatchedKey; target: Query<DocumentData, DocumentData> }> =
    context?.role === "seller_logistics"
      ? [
          { key: "orders", target: query(orderRef, where("sellerId", "==", context.profileId)) },
          { key: "inventory", target: query(inventoryRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyStores", target: query(shopifyStoreRef, where("sellerId", "==", context.profileId)) },
          { key: "storeWebhookConfigs", target: query(storeWebhookConfigRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyInstallRequests", target: query(shopifyInstallRequestRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifySyncIssues", target: query(shopifySyncIssueRef, where("sellerId", "==", context.profileId), orderBy("createdAt", "desc"), limitTo(SYNC_ISSUES_LIMIT)) },
          { key: "productCatalog", target: query(productCatalogRef, where("sellerId", "==", context.profileId)) }
        ]
      : context?.role === "seller"
      ? [
          { key: "orders", target: query(orderRef, where("sellerId", "==", context.profileId)) },
          { key: "inventory", target: query(inventoryRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyStores", target: query(shopifyStoreRef, where("sellerId", "==", context.profileId)) },
          { key: "storeWebhookConfigs", target: query(storeWebhookConfigRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyInstallRequests", target: query(shopifyInstallRequestRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifySyncIssues", target: query(shopifySyncIssueRef, where("sellerId", "==", context.profileId), orderBy("createdAt", "desc"), limitTo(SYNC_ISSUES_LIMIT)) },
          { key: "productCatalog", target: query(productCatalogRef, where("sellerId", "==", context.profileId)) },
          { key: "wallet", target: query(walletRef, where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId)) },
          { key: "settlements", target: query(settlementRef, where("kind", "==", "seller"), where("ownerId", "==", context.profileId)) }
        ]
      : context?.role === "driver"
        ? [
          { key: "orders", target: query(orderRef, where("driverId", "==", context.profileId)) },
          { key: "orders", target: query(orderRef, where("driverId", "==", null), where("status", "==", "ready_to_assign")) },
          { key: "messengers", target: query(messengerRef, where("leaderDriverId", "==", context.profileId)) },
          { key: "pickupBatches", target: query(pickupBatchRef, where("driverId", "==", context.profileId)) },
          { key: "wallet", target: query(walletRef, where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId)) },
          { key: "settlements", target: query(settlementRef, where("kind", "==", "driver"), where("ownerId", "==", context.profileId)) }
        ]
        : context?.role === "messenger"
          ? [
              { key: "orders", target: query(orderRef, where("messengerId", "==", context.profileId)) },
              { key: "messengers", target: query(messengerRef, where("__name__", "==", context.profileId)) }
            ]
          : [
              { key: "orders", target: orderRef },
              { key: "inventory", target: inventoryRef },
              { key: "suppliers", target: supplierRef },
              { key: "productCatalog", target: productCatalogRef },
              { key: "shopifyStores", target: shopifyStoreRef },
              { key: "storeWebhookConfigs", target: storeWebhookConfigRef },
              { key: "shopifyInstallRequests", target: shopifyInstallRequestRef },
              { key: "shopifySyncIssues", target: query(shopifySyncIssueRef, orderBy("createdAt", "desc"), limitTo(SYNC_ISSUES_LIMIT)) },
              { key: "messengers", target: messengerRef },
              { key: "pickupBatches", target: pickupBatchRef },
              { key: "wallet", target: walletRef },
              { key: "settlements", target: settlementRef }
            ];

  // Antes cada snapshot disparaba una recarga COMPLETA del estado (19 lecturas de
  // colecciones enteras), asi que una sola escritura ajena costaba megabytes. Ahora
  // cada listener mantiene su propia cache de documentos y solo aplica los docChanges;
  // el estado se rearma uniendo esas caches sobre la base que trae loadFirestoreState.
  // La union por clave es necesaria porque un mismo key puede tener varias queries
  // (el rol driver observa "orders" con dos consultas distintas).
  const watchedKeys = new Set<WatchedKey>(targets.map((entry) => entry.key));
  const caches: Array<Map<string, Record<string, unknown>>> = targets.map(() => new Map());
  let baseState: AppState | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const collect = (key: WatchedKey) => {
    const merged = new Map<string, Record<string, unknown>>();
    targets.forEach((entry, index) => {
      if (entry.key !== key) return;
      for (const [id, value] of caches[index]) merged.set(id, value);
    });
    return Array.from(merged.values());
  };

  // Una clave solo pasa a servirse desde las caches cuando TODOS sus listeners
  // entregaron su primer snapshot; hasta entonces se respeta lo que trajo la carga
  // inicial. Asi el primer pintado no espera a los streams (que son mas lentos que
  // getDocs) y aun asi las escrituras posteriores se aplican de forma incremental.
  const keyIsLive = (key: WatchedKey) => targets.every((entry, index) => entry.key !== key || firstSeen[index]);

  // Solo se rearman las claves que cambiaron desde el ultimo emit. Rearmar "orders"
  // implica normalizar y ordenar miles de documentos, y hacerlo en cada snapshot
  // (12 al montar) multiplicaba ese trabajo y los renders del arbol completo.
  const dirty = new Set<WatchedKey>();
  const assembled = new Map<WatchedKey, unknown[]>();
  let emitCount = 0;

  const emit = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (stopped || !baseState) return;
    const next = { ...baseState } as AppState;
    for (const key of watchedKeys) {
      if (!keyIsLive(key)) continue;
      if (dirty.has(key) || !assembled.has(key)) {
        const rows = collect(key);
        assembled.set(
          key,
          key === "orders"
            // ISO 8601 ordena bien con comparacion directa; localeCompare (Intl) es
            // un orden de magnitud mas lento y aqui se ejecuta miles de veces.
            ? (rows as unknown as Order[]).map(normalizeOrder).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
            : rows
        );
        dirty.delete(key);
      }
      (next as unknown as Record<string, unknown>)[key] = assembled.get(key)!;
    }
    // El lider logistico no lee la coleccion de tiendas: sus nombres se derivan de los
    // pedidos. Como los pedidos ahora llegan por listener (no por loadFirestoreState),
    // la sintesis debe rehacerse aqui o el driver se queda sin nombres de tienda.
    if (context?.role === "driver" && next.sellers.length === 0 && next.orders.length > 0) {
      next.sellers = sellerReferencesFromOrders(next.orders);
    }
    const paintedAt = Date.now();
    onState(next);
    // React renderiza de forma sincrona dentro de setState, asi que este delta
    // aproxima el coste de render del arbol completo.
    perfLog(`emit #${++emitCount} render ${Date.now() - paintedAt} ms`);
  };

  // Los snapshots llegan en rafaga (al montar, uno por listener) y cada emit provoca
  // un render del arbol completo. Se agrupan con debounce de cola + tope de espera,
  // para que la rafaga inicial produzca UN solo render en vez de uno por listener.
  const DEBOUNCE_MS = 250;
  const MAX_WAIT_MS = 1000;
  let burstStartedAt = 0;
  const scheduleEmit = () => {
    if (stopped) return;
    const now = Date.now();
    if (!burstStartedAt) burstStartedAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - burstStartedAt)));
    timer = setTimeout(() => {
      burstStartedAt = 0;
      emit();
    }, wait);
  };

  const firstSeen: boolean[] = targets.map(() => false);
  const startedAt = Date.now();

  const unsubscribers = targets.map((entry, index) =>
    onSnapshot(
      entry.target,
      (snapshot) => {
        if (stopped) return;
        const cache = caches[index];
        const changes = snapshot.docChanges();
        if (changes.length === 0 && firstSeen[index]) return;
        for (const change of changes) {
          if (change.type === "removed") cache.delete(change.doc.id);
          else cache.set(change.doc.id, { id: change.doc.id, ...change.doc.data() });
        }
        if (!firstSeen[index]) {
          firstSeen[index] = true;
          perfLog(`${entry.key} listo en ${Date.now() - startedAt} ms (${cache.size} docs)`);
        }
        dirty.add(entry.key);
        scheduleEmit();
      },
      (error) => {
        console.warn("No se pudo sincronizar una coleccion de Live.", error.message);
      }
    )
  );

  // Carga inicial SIN las colecciones observadas: esas ya las trae el snapshot inicial
  // del listener, y bajarlas tambien con getDocs duplicaba los bytes (medido: ~9,4 MB
  // y 75 s en la red del usuario). El estado se pinta en cuanto llega esta base ligera
  // y cada coleccion pesada aparece cuando su listener entrega (ver keyIsLive).
  void loadFirestoreState(context, { skip: watchedKeys })
    .then((state) => {
      if (stopped) return;
      if (!state) {
        onEmpty?.();
        return;
      }
      baseState = state;
      perfLog(`base ligera lista en ${Date.now() - startedAt} ms`);
      emit();
    })
    .catch((error) => console.warn("No se pudo cargar el estado base.", error));

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

async function getCollection<T extends { id: string }>(
  name: string,
  ...constraints: Parameters<typeof query>[1][]
): Promise<T[]>;
async function getCollection<T extends { id: string }>(name: string, newestFirst: boolean, max?: number): Promise<T[]>;
async function getCollection<T extends { id: string }>(
  name: string,
  newestFirstOrConstraint: boolean | Parameters<typeof query>[1] = false,
  ...rest: Array<Parameters<typeof query>[1] | number | undefined>
): Promise<T[]> {
  const client = getFirebaseClient();
  if (!client) return [];
  const ref = collection(client.db, name);
  const newestFirst = typeof newestFirstOrConstraint === "boolean" ? newestFirstOrConstraint : false;
  const max = typeof rest[0] === "number" ? rest[0] : undefined;
  const extra = (typeof rest[0] === "number" ? rest.slice(1) : rest) as Parameters<typeof query>[1][];
  const queryConstraints = typeof newestFirstOrConstraint === "boolean" ? extra : [newestFirstOrConstraint, ...extra];
  const snapshot = await getDocs(query(
    ref,
    ...(newestFirst ? [orderBy("createdAt", "desc")] : []),
    ...queryConstraints,
    ...(typeof max === "number" ? [limitTo(max)] : [])
  ));
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

function sellerReferencesFromOrders(orders: Order[]): Seller[] {
  const sellers = new Map<string, Seller>();
  for (const order of orders) {
    if (!order.sellerId || sellers.has(order.sellerId)) continue;
    sellers.set(order.sellerId, {
      id: order.sellerId,
      name: order.pickupPointName || order.sellerId,
      shopDomain: "",
      cityId: order.cityId,
      bankAccount: "",
      pickupPointName: order.pickupPointName,
      pickupAddress: order.pickupAddress
    });
  }
  return Array.from(sellers.values());
}

async function getOrdersForContext(context?: FirestoreStateContext): Promise<Order[]> {
  if (context?.role === "seller" || context?.role === "seller_logistics") return getCollection<Order>("orders", where("sellerId", "==", context.profileId));
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
  if (context?.role === "messenger" || context?.role === "seller_logistics") return Promise.resolve([]);
  return getCollection<WalletEntry>("walletEntries");
}

async function getSettlementsForContext(context?: FirestoreStateContext): Promise<Settlement[]> {
  if (context?.role === "seller") {
    return getCollection<Settlement>("settlements", where("kind", "==", "seller"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "driver") {
    return getCollection<Settlement>("settlements", where("kind", "==", "driver"), where("ownerId", "==", context.profileId));
  }
  if (context?.role === "messenger" || context?.role === "seller_logistics") return Promise.resolve([]);
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
