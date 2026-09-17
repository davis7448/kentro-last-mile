"use client";

import {
  collection,
  doc,
  documentId,
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
import { selectUnsettledWalletEntries } from "@/lib/finance";
import { mergeCommunitySellers, type LoadReport } from "../load-status";
import { emptyState } from "@/lib/seed";
import type { AppState, AuditEvent, CashSnapshot, City, Community, Driver, InventoryItem, Messenger, Order, PickupBatch, PayoutRequest, ProductCatalogItem, Role, Seller, Settlement, ShopifyInstallRequest, ShopifyStore, ShopifySyncIssue, StoreWebhookConfig, Supplier, WalletEntry, Zone } from "@/lib/types";
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
  /** Comunidad que lidera esta cuenta, si lidera alguna. Liderar NO es un rol: viaja aparte, asi
   *  que una misma cuenta puede ser tienda (o domiciliario, o mensajero) y ademas lider, y con
   *  solo `role` no habria forma de distinguirla de una tienda cualquiera — su rama de vendedor
   *  ganaria siempre y sus cortes de comunidad no se pedirian jamas: el cashback PAGADO saldria
   *  en cero, que no parece un error sino un dato.
   *
   *  Sale SIEMPRE del reclamo del token, nunca de lo que este mostrando la interfaz: quien
   *  decide que se descarga es el permiso, no la pantalla.
   *
   *  Para un lider PURO `profileId` ya ES el id de la comunidad, asi que este campo puede venir
   *  vacio; para una cuenta con dos papeles `profileId` es el del papel operativo y el vinculo
   *  solo llega por aqui. De ahi el `communityId ?? profileId` de las consultas de cortes. */
  communityId?: string;
  /** Fecha (YYYY-MM-DD) desde la que se traen los pedidos ya cerrados. Los activos NO se
   *  acotan nunca: son la operacion del dia y tienen que estar completos siempre. */
  historyStart?: string;
};

// Un pedido abierto siempre viaja al cliente; uno cerrado solo si cae en la ventana o si algo
// lo necesita explicitamente (liquidaciones, busqueda). Juntas cubren OrderStatus completo.
const ACTIVE_ORDER_STATUSES = [
  "imported",
  "address_risk",
  "ready_to_assign",
  "assigned",
  "call_pending",
  "scheduled",
  "pickup_pending",
  "picked_up",
  "in_route",
  "retry_pending"
] as const;

const CLOSED_ORDER_STATUSES = ["delivered", "failed", "cancelled", "liquidated"] as const;

/** `createdAt` se guarda como ISO en UTC y la ventana llega como fecha local. Se ancla al inicio
 *  del dia UTC, que en Colombia (UTC-5) abre la ventana 5 horas antes: se trae de mas, nunca de
 *  menos. El filtro fino lo hace la UI. */
function historyStartBoundary(historyStart?: string) {
  return historyStart ? `${historyStart}T00:00:00.000Z` : "";
}

// Tope de valores por consulta `in` en Firestore.
const IN_QUERY_LIMIT = 30;

// Tope defensivo de pedidos traidos por id fuera de la ventana. Hoy liquidaciones necesita ~420.
const MAX_PINNED_ORDERS = 800;

// Tope duro de Firestore por writeBatch.
const BATCH_WRITE_LIMIT = 500;

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
  | "settlements"
  | "payouts";

// `onReport` es ADITIVO a proposito: la firma publica de `loadFirestoreState` no se toca (tiene
// otros llamadores) y el valor devuelto tampoco, porque `AppState | null` no puede cargar con "y
// ademas falto la mitad de comunidad" sin obligar a cada llamador a desenvolver un par. Un parte
// que se entrega por callback ademas describe bien lo que es: una carga que SI resolvio, pero
// degradada. Quien no lo pase se comporta exactamente como antes.
type LoadOptions = { skip?: ReadonlySet<WatchedKey>; onReport?: (report: LoadReport) => void };

/** Una consulta observada por la suscripcion. Varias entradas pueden compartir `key` (el rol
 *  driver observa "orders" con dos consultas distintas) y el estado se rearma uniendolas. */
type TargetEntry = { key: WatchedKey; target: Query<DocumentData, DocumentData> };

// Solo se piden los ultimos 50 eventos: el unico consumidor (AuditBar) pinta 4 filas
// y la coleccion completa ya supera los 7.000 documentos.
const AUDIT_LIMIT = 50;

// shopifySyncIssues es un log append-only de pedidos Shopify rechazados: ya supera
// los 45.000 documentos (~17 MB, el 79% de la descarga inicial) y crece ~20.000 al
// mes, mientras el panel que lo consume solo muestra 5 filas paginadas.
const SYNC_ISSUES_LIMIT = 200;

// Historial de cuadres de caja: basta con los ultimos para ver la tendencia del desfase.
const CASH_SNAPSHOT_LIMIT = 60;

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
  // Hermano de `storeRole` para el otro eje: liderar una comunidad viaja APARTE del rol, asi que
  // una cuenta puede ser tienda (o domiciliario) y ademas lider. Todo lo que depende del vinculo
  // —la comunidad propia, sus tiendas y sus cortes— se decide con esto y no con `role`, que para
  // una cuenta con dos papeles diria "seller" y se llevaria por delante la mitad de la pantalla.
  // Para un lider PURO `profileId` ES el id de la comunidad; para una cuenta doble es el de la
  // tienda y el vinculo llega aparte.
  const communityId = context ? context.communityId ?? (role === "community_leader" ? context.profileId : "") : "";
  const [settingsSnapshot, cities, zones, communities, sellers, shopifyStores, storeWebhookConfigs, shopifyInstallRequests, shopifySyncIssues, drivers, messengers, pickupBatches, suppliers, productCatalog, inventory, orders, wallet, settlements, payouts, audit, cashSnapshots] = await Promise.all([
    getDoc(doc(client.db, ...settingsPath)),
    getCollection<City>("cities"),
    getCollection<Zone>("zones"),
    role === "admin"
      ? getCollection<Community>("communities")
      // Por el VINCULO, no por el rol: sin el documento de la comunidad no hay precios congelados
      // ni sobreprecio que pintar, y una cuenta que vende y ademas lidera se quedaria sin la cifra
      // de la que sale todo lo demas de su pantalla de comunidad.
      : communityId
        ? getOwnDocument<Community>("communities", communityId)
        : Promise.resolve([]),
    role === "admin"
      ? getCollection<Seller>("sellers")
      // Las dos cosas a la vez, no una o la otra: sin la tienda propia el vendedor-lider pierde su
      // tienda (y con ella su saldo); sin las de la comunidad, el desglose por tienda sale vacio. Y
      // si su tienda no pertenece a su propia comunidad, elegir una rama pierde una de las dos
      // seguro. Cada mitad se pide solo si aplica, asi que ningun rol pide de mas.
      //
      // Y las dos mitades NO se piden igual, que es el nucleo de esta entrada:
      //
      // - la tienda propia va DESNUDA: si falla, tiene que fallar la carga entera. Tragarse su
      //   fallo dejaria la pantalla de una tienda sin tienda y sin error, y eso se leeria como un
      //   problema de configuracion de la cuenta ("Perfil de vendedor pendiente");
      // - las de la comunidad van ENVUELTAS: medido contra produccion (plan §0) esa consulta
      //   devuelve 403 para una tienda-lider, y dentro de un `Promise.all` el rechazo sube hasta
      //   el `Promise.all` general de 21 consultas y deja la pantalla sin tienda, sin ciudades y
      //   sin ajustes. Degradada, lo unico que falta es la mitad que fallo.
      //
      // `mergeCommunitySellers` devuelve ademas un parte que dice si falto la mitad de comunidad
      // —lo que distingue "no hay tiendas" de "no se pudo saber", y explica que el lider se quede
      // sin enlace de invitacion—. Ese parte SALE del modulo por `options.onReport`: calcularlo y
      // tirarlo (que es lo que hacia el `.sellers` de aqui) degradaba en silencio, y un silencio
      // asi no se puede distinguir de una comunidad que de verdad no tiene tiendas.
      //
      // De la mitad de comunidad se piden solo las tiendas de SU comunidad: pedir la coleccion
      // entera seria un 403 seguro. Toda esta explicacion vive aqui arriba y no junto a cada mitad
      // a proposito: una guarda de fuente (`state-store-targets.test.ts`) exige que la union sea
      // visible en una ventana de 260 caracteres alrededor de la consulta, y los comentarios
      // intercalados empujaban el `Promise.all(` fuera de esa ventana.
      : Promise.all([
          storeRole && context ? getOwnDocument<Seller>("sellers", context.profileId) : Promise.resolve<Seller[]>([]),
          communityId
            ? getCollection<Seller>("sellers", where("communityId", "==", communityId)).catch(() => ({ failed: true as const }))
            : Promise.resolve<Seller[]>([])
        ]).then(([propias, deLaComunidad]) => {
          const union = mergeCommunitySellers({ own: propias, community: deLaComunidad });
          options?.onReport?.(union.report);
          return union.sellers;
        }),
    skipped("shopifyStores", () => storeRole && context ? getCollection<ShopifyStore>("shopifyStores", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifyStore>("shopifyStores") : Promise.resolve([])),
    skipped("storeWebhookConfigs", () => storeRole && context ? getCollection<StoreWebhookConfig>("storeWebhookConfigs", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<StoreWebhookConfig>("storeWebhookConfigs") : Promise.resolve([])),
    skipped("shopifyInstallRequests", () => storeRole && context ? getCollection<ShopifyInstallRequest>("shopifyInstallRequests", where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifyInstallRequest>("shopifyInstallRequests") : Promise.resolve([])),
    // La rama de tienda llevaba la consulta SIN limite mientras la de admin si lo tenia. Hoy no se
    // ejecuta (la suscripcion observa esta clave, asi que llega en `skip`), pero pediria 19.321
    // documentos / 7,28 MB el dia que alguien la saque de los targets, para un panel de 5 filas.
    skipped("shopifySyncIssues", () => storeRole && context ? getCollection<ShopifySyncIssue>("shopifySyncIssues", true, SYNC_ISSUES_LIMIT, where("sellerId", "==", context.profileId)) : role === "admin" ? getCollection<ShopifySyncIssue>("shopifySyncIssues", true, SYNC_ISSUES_LIMIT) : Promise.resolve([])),
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
    role === "admin" ? getCollection<AuditEvent>("auditEvents", true, AUDIT_LIMIT) : Promise.resolve([]),
    role === "admin" ? getCollection<CashSnapshot>("cashSnapshots", true, CASH_SNAPSHOT_LIMIT) : Promise.resolve([])
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
    communities,
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
    cashSnapshots: cashSnapshots ?? [],
    settings: settingsSnapshot.exists() ? { ...base.settings, ...settingsSnapshot.data() } : base.settings
  };
}

// Colecciones que el autoguardado del admin persiste, en orden de escritura. `payouts` NO esta:
// los gestiona el servidor (requestSellerPayout, rejectSellerPayout, createSettlement) y
// reescribirlos desde el estado del admin pisaria una solicitud creada entre carga y guardado.
const AUTOSAVED_COLLECTIONS = [
  "cities",
  "zones",
  "sellers",
  "shopifyStores",
  "storeWebhookConfigs",
  "shopifyInstallRequests",
  "drivers",
  "messengers",
  "pickupBatches",
  "suppliers",
  "productCatalog",
  "inventory"
] as const;

// Ultimo estado que vino del servidor. El autoguardado compara contra esto para escribir solo lo
// que el admin cambio de verdad: antes reescribia las 12 colecciones enteras en CADA setState
// (331 operaciones hoy, con pickupBatches creciendo sin techo) y el writeBatch se corta en 500.
let lastRemoteCollections: Partial<Record<(typeof AUTOSAVED_COLLECTIONS)[number] | "settings", unknown>> | null = null;

function rememberRemoteCollections(state: AppState) {
  const snapshot: Record<string, unknown> = { settings: state.settings };
  for (const name of AUTOSAVED_COLLECTIONS) snapshot[name] = state[name];
  lastRemoteCollections = snapshot;
}

export async function saveFirestoreState(state: AppState, context?: FirestoreStateContext): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  // El vendedor no persiste nada desde el cliente. Aqui vivia una rama que escribia sus payouts,
  // pero nunca se llamaba (el efecto que guarda el estado se sale para todo rol que no sea admin),
  // y hoy las solicitudes van por el callable requestSellerPayout con el monto calculado en el
  // servidor. Reactivar una escritura financiera desde el navegador seria un retroceso.
  if (context?.role === "seller") {
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

  // Sin referencia previa (arranque en frio o base vacia) se escribe todo; con ella, solo lo que
  // cambio. La comparacion es por identidad de array, que se conserva entre emisiones: el emit
  // solo rearma las claves marcadas como sucias.
  const baseline = lastRemoteCollections;
  const changed = AUTOSAVED_COLLECTIONS.filter((name) => !baseline || state[name] !== baseline[name]);
  const settingsChanged = !baseline || state.settings !== baseline.settings;
  if (!settingsChanged && changed.length === 0) return;

  const pendingWrites = changed.reduce((total, name) => total + state[name].length, 0) + (settingsChanged ? 1 : 0);
  if (pendingWrites > BATCH_WRITE_LIMIT) {
    throw new Error(`El guardado supera el limite de ${BATCH_WRITE_LIMIT} operaciones por lote (${pendingWrites}).`);
  }

  const batch = writeBatch(client.db);
  if (settingsChanged) {
    batch.set(doc(client.db, ...settingsPath), { ...state.settings, updatedAt: serverTimestamp() }, { merge: true });
  }
  // El tipo del array se pierde al iterar la union de colecciones; `writeEntities` solo usa
  // `entity.id`, que todas comparten.
  for (const name of changed) writeEntities(batch, name, state[name] as Array<{ id: string }>);
  await batch.commit();
  perfLog(`autoguardado: ${pendingWrites} escrituras (${changed.join(", ") || "solo settings"})`);
  rememberRemoteCollections(state);
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

/** Deja `settlementId` (y `supplierSettlementId` en costos de producto) presente y vacio en los
 *  asientos que nacen sin liquidar: Firestore no puede filtrar por campo AUSENTE, y de ese filtro
 *  depende que la app traiga solo lo pendiente en vez de la coleccion entera. Espeja
 *  `withOpenSettlementFlags` de functions/src/orders.ts. */
function withOpenSettlementFlags(entry: WalletEntry): WalletEntry {
  const normalized: WalletEntry = { ...entry, settlementId: entry.settlementId ?? "" };
  if (normalized.type === "product_cost") {
    normalized.supplierSettlementId = normalized.supplierSettlementId ?? "";
  }
  return normalized;
}

export async function saveFirestoreWalletEntries(entries: WalletEntry[]): Promise<void> {
  const client = getFirebaseClient();
  if (!client || entries.length === 0) return;
  const batch = writeBatch(client.db);
  writeEntities(batch, "walletEntries", entries.map(withOpenSettlementFlags));
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

/**
 * Marca de forma de pago de una cuenta. Se escribe con `merge` y un solo campo a proposito: el
 * resto del documento (tarifas, datos de recogida, bancarios) no debe viajar en una operacion
 * que solo cambia como se le paga.
 */
export async function saveFirestorePaysInCash(
  collectionName: "sellers" | "drivers" | "suppliers",
  id: string,
  paysInCash: boolean
): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, collectionName, id), { paysInCash }, { merge: true });
}

/** Registra el saldo real de las cuentas de la operacion. Nunca se edita ni se borra
 *  (las reglas lo impiden): el historico de desfases solo sirve si es inmutable. */
export async function saveFirestoreCashSnapshot(snapshot: CashSnapshot): Promise<void> {
  const client = getFirebaseClient();
  if (!client) return;
  await setDoc(doc(client.db, "cashSnapshots", snapshot.id), sanitizeFirestoreValue(snapshot));
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

/**
 * `onState` entrega el estado Y el parte de como fue la carga base: quien pinta necesita saber si
 * lo que no ve es que no hay nada o que no se pudo leer. `onError` es el canal del fallo DURO — la
 * carga base que ni siquiera resolvio—; sin el, la pantalla se queda esperando para siempre un
 * estado que no va a llegar y acaba culpando a la configuracion de la cuenta.
 *
 * Los dos ultimos son opcionales para que los llamadores que solo quieran el estado sigan
 * compilando sin tocarlos.
 */
export function subscribeFirestoreState(
  context: FirestoreStateContext | undefined,
  onState: (state: AppState, report: LoadReport) => void,
  onEmpty?: () => void,
  onError?: (error: unknown) => void
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
  const payoutRef = collection(client.db, "payouts");
  // Dos consultas por rol en vez de la coleccion entera: los activos siempre completos, los
  // cerrados solo dentro de la ventana. El admin bajaba 3.495 pedidos (~5,3 MB) en cada sesion
  // para trabajar sobre 240 activos.
  const orderTargets = (scope: Parameters<typeof query>[1] | null) => {
    const scoped = scope ? [scope] : [];
    const boundary = historyStartBoundary(context?.historyStart);
    return [
      { key: "orders" as const, target: query(orderRef, ...scoped, where("status", "in", [...ACTIVE_ORDER_STATUSES])) },
      {
        key: "orders" as const,
        target: boundary
          ? query(orderRef, ...scoped, where("status", "in", [...CLOSED_ORDER_STATUSES]), where("createdAt", ">=", boundary))
          : query(orderRef, ...scoped, where("status", "in", [...CLOSED_ORDER_STATUSES]))
      }
    ];
  };

  // Liderar una comunidad NO es un rol: viaja aparte del `role`, en `context.communityId`. Por eso
  // lo que se observa es una SUMA — los objetivos del papel operativo mas los del vinculo — y no
  // una rama mas de la cadena de ternarios: como rama, la comunidad solo ganaria cuando el rol
  // fuese `community_leader`, y para un vendedor que ademas lidera gana siempre la de vendedor.
  const targets: Array<TargetEntry> = [...roleTargets(), ...communityTargets()];

  /**
   * Lo que aporta el vinculo con la comunidad: UN objetivo, los cortes del lider. De ahi sale el
   * cashback PAGADO (`state.settlements`), asi que sin esta consulta la cifra cae a cero sin que
   * nada falle ni avise.
   *
   * Ni pedidos ni asientos de wallet, a proposito: eso es lo que mantiene la descarga de una
   * cuenta con dos papeles en "como mucho la suma". La suscripcion de wallet del lider crecia un
   * documento por pedido cerrado de su comunidad (10.000 documentos con 10.000 pedidos) y se
   * elimino entera; volver a abrirla aqui por la puerta de atras seria el mismo fallo.
   */
  function communityTargets(): TargetEntry[] {
    // Para un lider PURO `profileId` ES el id de la comunidad; para una cuenta con dos papeles es
    // el del papel operativo y el vinculo llega aparte. Sin el `??`, un lider puro se quedaria
    // sin sus propios cortes.
    const ownerId = context?.communityId ?? (context?.role === "community_leader" ? context.profileId : "");
    if (!ownerId) return [];
    return [{ key: "settlements", target: query(settlementRef, where("kind", "==", "community_leader"), where("ownerId", "==", ownerId)) }];
  }

  /** Lo que baja el papel operativo de la cuenta. Ninguna rama mira el vinculo con la comunidad:
   *  sumar la comunidad no puede quitarle nada a la tienda ni al domiciliario, que en esa misma
   *  pantalla tienen sus propias cifras de dinero. */
  function roleTargets(): TargetEntry[] {
    return context?.role === "driver"
      ? [
          // El lider bajaba 4.127 pedidos (~6,9 MB) — el 95% de la coleccion entera — en un movil
          // y SIN cache persistente, asi que los repetia enteros en cada apertura. Con la misma
          // particion que ya usaban admin y tienda son ~289 (~0,5 MB). Lo que queda fuera de la
          // ventana y hace falta para el saldo se trae por id: ver pinDriverOrders.
          ...orderTargets(where("driverId", "==", context.profileId)),
          { key: "orders", target: query(orderRef, where("driverId", "==", null), where("status", "==", "ready_to_assign")) },
          { key: "messengers", target: query(messengerRef, where("leaderDriverId", "==", context.profileId)) },
          { key: "pickupBatches", target: query(pickupBatchRef, where("driverId", "==", context.profileId)) },
          // Sin recortar: calculateDriverFinancialSummary desglosa cada corte cerrado pedido a
          // pedido leyendo sus asientos driver_earning, que ya tienen settlementId.
          { key: "wallet", target: query(walletRef, where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId)) },
          { key: "settlements", target: query(settlementRef, where("kind", "==", "driver"), where("ownerId", "==", context.profileId)) }
        ]
      : context?.role === "seller_logistics"
      ? [
          ...orderTargets(where("sellerId", "==", context.profileId)),
          { key: "inventory", target: query(inventoryRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyStores", target: query(shopifyStoreRef, where("sellerId", "==", context.profileId)) },
          { key: "storeWebhookConfigs", target: query(storeWebhookConfigRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyInstallRequests", target: query(shopifyInstallRequestRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifySyncIssues", target: query(shopifySyncIssueRef, where("sellerId", "==", context.profileId), orderBy("createdAt", "desc"), limitTo(SYNC_ISSUES_LIMIT)) },
          { key: "productCatalog", target: query(productCatalogRef, where("sellerId", "==", context.profileId)) }
        ]
      : context?.role === "seller"
      ? [
          ...orderTargets(where("sellerId", "==", context.profileId)),
          { key: "inventory", target: query(inventoryRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyStores", target: query(shopifyStoreRef, where("sellerId", "==", context.profileId)) },
          { key: "storeWebhookConfigs", target: query(storeWebhookConfigRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifyInstallRequests", target: query(shopifyInstallRequestRef, where("sellerId", "==", context.profileId)) },
          { key: "shopifySyncIssues", target: query(shopifySyncIssueRef, where("sellerId", "==", context.profileId), orderBy("createdAt", "desc"), limitTo(SYNC_ISSUES_LIMIT)) },
          { key: "productCatalog", target: query(productCatalogRef, where("sellerId", "==", context.profileId)) },
          { key: "wallet", target: query(walletRef, where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId), where("settlementId", "==", "")) },
          { key: "settlements", target: query(settlementRef, where("kind", "==", "seller"), where("ownerId", "==", context.profileId)) },
          { key: "payouts", target: query(payoutRef, where("sellerId", "==", context.profileId)) }
        ]
      : context?.role === "community_leader"
        ? /**
           * Quien SOLO lidera no tiene papel operativo: cero objetivos aqui. Sus cortes se los da
           * `communityTargets`, que para un lider puro toma la comunidad de `profileId`.
           *
           * Esta rama tiene que seguir existiendo aunque devuelva vacio: sin ella un lider puro
           * cae en la rama por defecto, que es la del ADMIN — colecciones enteras y un 403 con la
           * pantalla en blanco.
           *
           * Espejo de getOrdersForContext y de getWalletForContext: CERO pedidos y CERO asientos
           * de wallet. Aqui hubo una suscripcion a sus asientos `community_cashback` sin ventana
           * ni limite: uno por pedido cerrado de su comunidad, 10.000 documentos y 2,67 MB con
           * 10.000 pedidos, creciendo para siempre. No se acoto, se ELIMINO, porque
           * `CommunityLeaderView` no lee `state.wallet` en ningun punto: el cashback CAUSADO
           * llega agregado del servidor (`getCommunityStats` -> `cashbackAccruedCop`) y el PAGADO
           * sale de los `settlements` via `communityCashbackPaidCop`. Acotar por corte tampoco
           * habria servido: todo asiento nace sin liquidar, asi que dentro del periodo abierto la
           * cuenta seguiria subiendo uno a uno.
           */
          []
      : context?.role === "messenger"
          ? [
              // Mismo motivo que el lider: el mensajero con mas ruta bajaba sus 896 pedidos
              // historicos para trabajar sobre los de hoy.
              ...orderTargets(where("messengerId", "==", context.profileId)),
              { key: "messengers", target: query(messengerRef, where("__name__", "==", context.profileId)) }
            ]
          : [
              ...orderTargets(null),
              { key: "inventory", target: inventoryRef },
              { key: "suppliers", target: supplierRef },
              { key: "productCatalog", target: productCatalogRef },
              { key: "shopifyStores", target: shopifyStoreRef },
              { key: "storeWebhookConfigs", target: storeWebhookConfigRef },
              { key: "shopifyInstallRequests", target: shopifyInstallRequestRef },
              { key: "shopifySyncIssues", target: query(shopifySyncIssueRef, orderBy("createdAt", "desc"), limitTo(SYNC_ISSUES_LIMIT)) },
              { key: "messengers", target: messengerRef },
              { key: "pickupBatches", target: pickupBatchRef },
              // El admin SI necesita el ledger completo: calculatePlatformPosition deriva caja,
              // activos, pasivos y utilidad de los movimientos YA liquidados (lo pagado en cortes
              // cerrados, los abonos, los fees historicos), y receivedDriverOrderIds tiene un
              // fallback que lee asientos de cortes aun no cerrados. Recortarlo a lo pendiente
              // daba cifras mal. El coste queda amortizado por la cache persistente: se baja una
              // vez por dispositivo y despues solo llegan los cambios.
              { key: "wallet", target: walletRef },
              { key: "settlements", target: settlementRef },
              // Sin esto una solicitud de liquidacion nueva no le aparece al admin hasta que
              // recargue: exactamente el sintoma que este flujo venia a arreglar.
              { key: "payouts", target: payoutRef }
            ];
  }

  // Antes cada snapshot disparaba una recarga COMPLETA del estado (19 lecturas de
  // colecciones enteras), asi que una sola escritura ajena costaba megabytes. Ahora
  // cada listener mantiene su propia cache de documentos y solo aplica los docChanges;
  // el estado se rearma uniendo esas caches sobre la base que trae loadFirestoreState.
  // La union por clave es necesaria porque un mismo key puede tener varias queries
  // (el rol driver observa "orders" con dos consultas distintas).
  const watchedKeys = new Set<WatchedKey>(targets.map((entry) => entry.key));
  const caches: Array<Map<string, Record<string, unknown>>> = targets.map(() => new Map());
  let baseState: AppState | null = null;
  // El parte de la ULTIMA carga base. Arranca sin incidencias porque hasta que la carga conteste no
  // consta que falte nada: dar por rota la mitad de comunidad antes de pedirla seria inventarse un
  // fallo. Cada emision lo reenvia tal cual, asi que el aviso no depende de cuando se pinte.
  let baseReport: LoadReport = { issues: [] };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Pedidos traidos por id que caen FUERA de la ventana: los que necesita liquidaciones (un
  // movimiento sin liquidar de mayo apunta a un pedido de mayo) y los que devuelve la busqueda
  // en servidor. Sin esto, acotar la ventana perderia informacion en vez de solo diferirla.
  const pinnedOrders = new Map<string, Record<string, unknown>>();
  const pinnedRequested = new Set<string>();

  const collect = (key: WatchedKey) => {
    const merged = new Map<string, Record<string, unknown>>();
    targets.forEach((entry, index) => {
      if (entry.key !== key) return;
      for (const [id, value] of caches[index]) merged.set(id, value);
    });
    if (key === "orders") {
      for (const [id, value] of pinnedOrders) if (!merged.has(id)) merged.set(id, value);
    }
    return Array.from(merged.values());
  };

  /** Trae por id los pedidos que faltan y los deja fijados. Idempotente: cada id se pide una
   *  sola vez por sesion, aunque el pedido no exista. */
  const pinOrders = async (orderIds: string[]) => {
    const known = new Set<string>();
    targets.forEach((entry, index) => {
      if (entry.key !== "orders") return;
      for (const id of caches[index].keys()) known.add(id);
    });
    const missing = orderIds
      .filter((id) => id && !known.has(id) && !pinnedRequested.has(id))
      .slice(0, MAX_PINNED_ORDERS);
    if (missing.length === 0) return;
    for (const id of missing) pinnedRequested.add(id);
    // El admin va por lotes; el lider y el mensajero de uno en uno, para que un id borrado o
    // reasignado no tumbe el lote entero y les baje el saldo sin avisar. Ver getDocumentsOneByOne.
    const fetched = context?.role === "admin"
      ? await getDocumentsByIds<Order>("orders", missing)
      : await getDocumentsOneByOne<Order>("orders", missing);
    if (stopped || fetched.length === 0) return;
    for (const order of fetched) pinnedOrders.set(order.id, order as unknown as Record<string, unknown>);
    perfLog(`pedidos fijados fuera de ventana: ${fetched.length} (acumulado ${pinnedOrders.size})`);
    dirty.add("orders");
    scheduleEmit();
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
    // El pedido detras de cada movimiento sin liquidar puede ser muy anterior a la ventana. Se
    // piden por id, una sola vez, en cuanto la wallet esta viva.
    //
    // Vale para el admin (liquidaciones) y para el LIDER: `calculateDriverFinancialSummary` deriva
    // su "Pendiente por entregar" de los pedidos entregados en efectivo que aun no entraron en
    // ningun corte, y esos son justo los que pueden quedar fuera de la ventana. Sin esto, acotar
    // la descarga le bajaria el saldo en silencio, que es un error financiero y no cosmetico.
    // Su wallet se sigue suscribiendo sin recorte, asi que la semilla esta completa.
    if ((context?.role === "admin" || context?.role === "driver") && watchedKeys.has("wallet") && keyIsLive("wallet")) {
      const openOrderIds = selectUnsettledWalletEntries(next.wallet)
        .map((entry) => entry.orderId)
        .filter((orderId): orderId is string => Boolean(orderId));
      if (openOrderIds.length > 0) {
        void pinOrders(Array.from(new Set(openOrderIds))).catch((error) =>
          console.warn("No se pudieron traer los pedidos de liquidacion.", error)
        );
      }
    }

    // Referencia para el autoguardado: a partir de aqui solo se escribe lo que el admin cambie
    // sobre este estado, no las 12 colecciones enteras.
    rememberRemoteCollections(next);

    const paintedAt = Date.now();
    onState(next, baseReport);
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
  void loadFirestoreState(context, {
    skip: watchedKeys,
    // El parte llega ANTES de que la carga resuelva (se emite al unir las dos mitades), asi que se
    // guarda para que la primera emision ya lo lleve.
    onReport: (report) => {
      baseReport = report;
    }
  })
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
    .catch((error) => {
      // La consola NO es un canal: nadie la mira y la pantalla no se entera. Se sigue registrando
      // para el diagnostico, pero el fallo tiene que SALIR de aqui o la tienda se queda mirando un
      // esqueleto eterno mientras se le dice que su cuenta esta mal configurada.
      console.warn("No se pudo cargar el estado base.", error);
      if (stopped) return;
      onError?.(error);
    });

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
async function getCollection<T extends { id: string }>(
  name: string,
  newestFirst: boolean,
  max?: number,
  ...constraints: Parameters<typeof query>[1][]
): Promise<T[]>;
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

/**
 * Busca pedidos en el servidor por guia, numero de Shopify o telefono.
 *
 * El cliente ya no tiene todo el historial en memoria, asi que la busqueda no puede resolverse
 * solo con lo cargado: un pedido entregado hace tres meses debe seguir siendo encontrable. Se
 * consulta por igualdad exacta en los tres campos con los que la operacion identifica un pedido
 * (los indices de campo unico son automaticos en Firestore). Las tiendas solo pueden consultar lo
 * suyo, asi que la consulta lleva `sellerId` y respeta las reglas.
 */
export async function findFirestoreOrders(term: string, context?: FirestoreStateContext): Promise<Order[]> {
  const client = getFirebaseClient();
  const trimmed = term.trim();
  if (!client || trimmed.length < 3) return [];

  const scoped = context?.role === "seller" || context?.role === "seller_logistics"
    ? [where("sellerId", "==", context.profileId)]
    : context?.role === "driver"
      ? [where("driverId", "==", context.profileId)]
      : context?.role === "messenger"
        ? [where("messengerId", "==", context.profileId)]
        : [];

  const upper = trimmed.toUpperCase();
  const digits = trimmed.replace(/[^\d]/g, "");
  const shopifyVariants = Array.from(new Set([trimmed, upper, upper.startsWith("#") ? upper : `#${upper}`]));

  const lookups: Array<Promise<Order[]>> = [
    getCollection<Order>("orders", ...scoped, where("trackingCode", "==", upper)),
    getCollection<Order>("orders", ...scoped, where("shopifyOrderId", "in", shopifyVariants.slice(0, IN_QUERY_LIMIT)))
  ];
  if (digits.length >= 7) {
    lookups.push(getCollection<Order>("orders", ...scoped, where("customerPhone", "==", digits)));
    lookups.push(getCollection<Order>("orders", ...scoped, where("customerPhone", "==", trimmed)));
  }

  // Una consulta puede fallar por indice ausente o por reglas; el resto sigue sirviendo.
  const results = await Promise.all(
    lookups.map((lookup) => lookup.catch(() => [] as Order[]))
  );
  return mergeById(...results).map(normalizeOrder);
}

/** Trae pedidos por id, sin pasar por la ventana de descarga. Lo usa el detalle de una
 *  liquidacion cerrada: sus pedidos suelen ser muy anteriores al historial cargado, y sin ellos
 *  el desglose por pedido y el margen de la fila salen incompletos. Solo admin (la consulta no
 *  lleva `sellerId`, asi que solo sus reglas la admiten). */
export async function fetchOrdersByIds(orderIds: string[]): Promise<Order[]> {
  const orders = await getDocumentsByIds<Order>("orders", orderIds);
  return orders.map(normalizeOrder);
}

/** Historial completo de movimientos de una cuenta, paginado desde el mas reciente. El estado
 *  solo trae lo pendiente; esto es para la vista de wallet, que si mira hacia atras. */
export async function fetchWalletHistoryPage(
  ownerType: WalletEntry["ownerType"],
  ownerId: string,
  max: number
): Promise<WalletEntry[]> {
  if (!getFirebaseClient() || !ownerId) return [];
  return getCollection<WalletEntry>(
    "walletEntries",
    true,
    max,
    where("ownerType", "==", ownerType),
    where("ownerId", "==", ownerId)
  );
}

async function getOwnDocument<T extends { id: string }>(name: string, id: string): Promise<T[]> {
  const client = getFirebaseClient();
  if (!client) return [];
  const snapshot = await getDoc(doc(client.db, name, id));
  return snapshot.exists() ? [({ id: snapshot.id, ...snapshot.data() } as T)] : [];
}

/** Trae documentos por id en lotes de 30 con `documentId() in`. Uno por `getDoc` costaba una
 *  peticion por documento: para los ~420 pedidos que necesita liquidaciones eran 420 idas y
 *  vueltas, y asi son 14 consultas. */
async function getDocumentsByIds<T extends { id: string }>(name: string, ids: string[]): Promise<T[]> {
  const client = getFirebaseClient();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!client || unique.length === 0) return [];

  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += IN_QUERY_LIMIT) {
    chunks.push(unique.slice(index, index + IN_QUERY_LIMIT));
  }
  const groups = await Promise.all(
    chunks.map((chunk) =>
      getDocs(query(collection(client.db, name), where(documentId(), "in", chunk)))
        .then((snapshot) => snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as T))
        // Un lote que falle (permisos, indice) no puede tumbar al resto.
        .catch(() => [] as T[])
    )
  );
  return mergeById(...groups);
}

/**
 * Igual que `getDocumentsByIds`, pero leyendo documento a documento.
 *
 * NO es porque las reglas prohiban el lote: se comprobo contra produccion con una sesion real de
 * domiciliario y `where(documentId(), "in", [...])` devuelve 200 mientras TODOS los ids del lote
 * sean legibles. El problema es lo que pasa cuando uno no lo es:
 *
 *   lote de 5 pedidos propios          -> 200
 *   lote de 4 propios + 1 ajeno        -> 403  (cae el lote ENTERO)
 *   lote de 4 propios + 1 inexistente  -> 403  (cae el lote ENTERO)
 *
 * Y los ids de esta via salen de los asientos de wallet, asi que basta con que un pedido se haya
 * borrado o reasignado a otro domiciliario para tumbar hasta 30 rescates de golpe. Como
 * `getDocumentsByIds` ademas se traga el error con `.catch(() => [])`, la perdida seria SILENCIOSA,
 * y estos son justo los pedidos que sostienen el saldo pendiente del lider: se veria menos dinero
 * del que realmente se debe, sin un solo aviso.
 *
 * Leyendo de uno en uno, un id malo se queda en un id malo. Y el fallo se registra, no se traga.
 */
async function getDocumentsOneByOne<T extends { id: string }>(name: string, ids: string[]): Promise<T[]> {
  const client = getFirebaseClient();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!client || unique.length === 0) return [];

  const found: T[] = [];
  await Promise.all(
    unique.map(async (id) => {
      try {
        const snapshot = await getDoc(doc(client.db, name, id));
        if (snapshot.exists()) found.push({ id: snapshot.id, ...snapshot.data() } as T);
      } catch (error) {
        console.warn(`No se pudo leer ${name}/${id}; puede faltar informacion en el saldo.`, error);
      }
    })
  );
  return found;
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

// Espejo de orderTargets para la carga inicial (solo se usa cuando la suscripcion no cubre
// "orders", p.ej. en una llamada suelta a loadFirestoreState).
async function getWindowedOrders(context: FirestoreStateContext, scope?: Parameters<typeof query>[1]): Promise<Order[]> {
  const scoped = scope ? [scope] : [];
  const boundary = historyStartBoundary(context.historyStart);
  const [active, closed] = await Promise.all([
    getCollection<Order>("orders", ...scoped, where("status", "in", [...ACTIVE_ORDER_STATUSES])),
    boundary
      ? getCollection<Order>("orders", ...scoped, where("status", "in", [...CLOSED_ORDER_STATUSES]), where("createdAt", ">=", boundary))
      : getCollection<Order>("orders", ...scoped, where("status", "in", [...CLOSED_ORDER_STATUSES]))
  ]);
  return mergeById(active, closed);
}

function mergeById<T extends { id: string }>(...groups: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

async function getOrdersForContext(context?: FirestoreStateContext): Promise<Order[]> {
  /**
   * El lider de COMUNIDAD no descarga ni un pedido, nunca. Sus cifras se agregan en el
   * servidor (`getCommunityStats`) y su rol ni siquiera puede leer la coleccion: las reglas lo
   * prohiben. Si algun dia alguien le abre aqui una consulta, el rol sale del presupuesto de
   * carga de la plataforma el mismo dia — con veinte tiendas son decenas de miles de
   * documentos para pintar seis numeros.
   */
  if (context?.role === "community_leader") return [];
  if (context?.role === "seller" || context?.role === "seller_logistics") return getWindowedOrders(context, where("sellerId", "==", context.profileId));
  if (context?.role === "driver") {
    const [assigned, free] = await Promise.all([
      getWindowedOrders(context, where("driverId", "==", context.profileId)),
      getCollection<Order>("orders", where("driverId", "==", null), where("status", "==", "ready_to_assign"))
    ]);
    // ISO 8601 ordena bien con comparacion directa; localeCompare (Intl) es un orden de magnitud
    // mas lento y aqui se ejecuta sobre cientos de pedidos.
    return mergeById(assigned, free).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }
  if (context?.role === "messenger") return getWindowedOrders(context, where("messengerId", "==", context.profileId));
  return context ? getWindowedOrders(context) : getCollection<Order>("orders");
}

// Espejo exacto de los targets de wallet en subscribeFirestoreState.
async function getWalletForContext(context?: FirestoreStateContext): Promise<WalletEntry[]> {
  if (context?.role === "seller") {
    return getCollection<WalletEntry>("walletEntries", where("ownerType", "==", "seller"), where("ownerId", "==", context.profileId), where("settlementId", "==", ""));
  }
  if (context?.role === "driver") {
    return getCollection<WalletEntry>("walletEntries", where("ownerType", "==", "driver"), where("ownerId", "==", context.profileId));
  }
  // El lider de comunidad va aqui desde T42: su suscripcion de wallet se elimino, asi que esta
  // funcion dejo de estar tapada por `skip` y sin esta rama caeria al `getCollection` final —
  // la coleccion ENTERA — que ademas le devolverian las reglas como 403.
  if (context?.role === "messenger" || context?.role === "seller_logistics" || context?.role === "community_leader") return Promise.resolve([]);
  return getCollection<WalletEntry>("walletEntries");
}

/**
 * Espejo obligado de los objetivos de `subscribeFirestoreState`: este es el primer pintado y
 * aquella el listener, y si divergen la pantalla cambia de cifra sola sin que nada falle.
 *
 * UNION, no eleccion. Los cortes del papel operativo y, si la cuenta ademas lidera, los de su
 * comunidad. Antes esto eran tres `if` con retorno anticipado y el de vendedor ganaba siempre:
 * para un vendedor-lider, el cashback PAGADO —que sale de `state.settlements`— salia en cero, y
 * un cero asi no se ve como un error sino como un dato.
 */
async function getSettlementsForContext(context?: FirestoreStateContext): Promise<Settlement[]> {
  const operativos =
    context?.role === "seller"
      ? getCollection<Settlement>("settlements", where("kind", "==", "seller"), where("ownerId", "==", context.profileId))
      : context?.role === "driver"
        ? getCollection<Settlement>("settlements", where("kind", "==", "driver"), where("ownerId", "==", context.profileId))
        : context?.role === "messenger" || context?.role === "seller_logistics" || context?.role === "community_leader"
          ? Promise.resolve<Settlement[]>([])
          : getCollection<Settlement>("settlements", true);
  // Para un lider PURO `profileId` ES el id de la comunidad; para una cuenta con dos papeles es
  // el del papel operativo y el vinculo llega aparte.
  const ownerId = context?.communityId ?? (context?.role === "community_leader" ? context.profileId : "");
  const deLaComunidad = ownerId
    ? getCollection<Settlement>("settlements", where("kind", "==", "community_leader"), where("ownerId", "==", ownerId))
    : Promise.resolve<Settlement[]>([]);
  const [delRol, delVinculo] = await Promise.all([operativos, deLaComunidad]);
  return mergeById(delRol, delVinculo);
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
