"use client";

import {
  AlertTriangle,
  Bike,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CreditCard,
  ExternalLink,
  FileDown,
  History,
  Image as ImageIcon,
  LogOut,
  MapPin,
  PackageCheck,
  Phone,
  Printer,
  QrCode,
  Route,
  Settings,
  ShieldCheck,
  Store,
  Truck,
  Wallet,
  Wrench,
  X
} from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { renderCode128Svg } from "@/lib/barcode";
import { ORDER_RANGE_PRESETS } from "@/lib/date-ranges";
import type { OrderPeriodStats } from "@/lib/firebase/auth";
import {
  cancelFirebaseOrder,
  correctFirebaseOrderStatus,
  classifyFirebaseFailedOrder,
  assignFirebaseMessengerToOrders,
  unassignFirebaseMessengerFromOrders,
  createFirebaseStoreApiKey,
  createFirebaseStoreWebhookConfig,
  setFirebaseStoreUchatConfig,
  createManualFirebaseOrder,
  createFirebaseMessengerProfile,
  createFirebasePickupBatch,
  applyFirebaseOrderTransition,
  type OrderTransitionPatch,
  createFirebaseSettlement,
  createManagedFirebaseUser,
  closeFirebaseOrder,
  confirmFirebaseImportedOrder,
  confirmFirebaseRetryOrder,
  fetchFirebaseOrderAuditTrail,
  rejectFirebaseSellerPayout,
  requestFirebaseSellerPayout,
  getFirebaseBootstrapStatus,
  importFirebaseShopifyOrder,
  reconcileFirebaseInventoryReservations,
  recordFirebaseDriverCashReceipt,
  recordFirebaseSellerAbono,
  recordFirebaseSupplierAbono,
  repairFirebaseOwnDriverProfile,
  signInWithFirebaseEmail,
  signOutFirebase,
  syncFirebaseShopifyHistoricalOrders,
  subscribeFirebaseUser,
  updateFirebaseImportedOrder,
  updateFirebaseOrderAdjustments,
  updateFirebaseSettlementStatus
} from "@/lib/firebase/auth";
import { createCommunityLeader, disableCommunitySignupsInRange, dismissMassSignupAlert, fetchCommunityStats, fetchMyStoreTariff, getFirebaseOrderStats, reassignSellerCommunity, setCommunityLeaderStatus, setCommunityLinkStatus, setCommunityLogo } from "@/lib/firebase/auth";
import { BULK_DISABLE_FAILURE_LABELS, BULK_DISABLE_SKIP_LABELS, brandFor, roleLabel, buildAdminCommunityList, buildBulkSignupDisableView, buildCommunityLeaderLiquidationRows, buildEmptyCommunityView, communityCashbackPaidCop, communityInvitePath, validateCommunityLeaderForm, type BulkSignupDisableOutcome, type CommunityLeaderFormInput, type BulkSignupDisableView, type CommunityLeaderLiquidationRow } from "@/lib/community-view";
import { canBulkDisableCommunitySignups, canEditCommunityBrand, canReassignSellerCommunity, type Actor } from "../../functions/src/community-access";
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from "../../functions/src/community-pricing";
import { buildCommunityStats, metricDateSource, type CommunityStats, type RawCommunityAggregates } from "../../functions/src/community-stats-math";
import { firebaseEnabled } from "@/lib/firebase/client";
import { canUseFirestoreStore, fetchOrdersByIds, fetchWalletHistoryPage, findFirestoreOrders, loadFirestoreState, saveFirestoreCashSnapshot, saveFirestoreInventoryItem, saveFirestoreOrder, saveFirestoreOrderLabelPrint, saveFirestorePaysInCash, saveFirestoreProductCatalogItem, saveFirestoreShopifyInstallRequest, saveFirestoreState, saveFirestoreSupplier, saveFirestoreWalletEntries, saveFirestoreZone, subscribeFirestoreState } from "@/lib/firebase/state-store";
import { prepareEvidenceImage, uploadEvidenceImage } from "@/lib/firebase/storage";
import { enqueueEvidence, markQueuedEvidenceError, pruneOrphanPhotos, queuedEvidenceToFile, readEvidenceQueue, readQueuedPhoto, removeQueuedEvidence, type QueuedEvidence } from "@/lib/evidence-queue";
import {
  advanceOrder,
  assignOrder,
  closeDelivered,
  closeFailed,
  confirmDeliveryWindow,
  createManualOrder,
  registerNoAnswerAttempt,
  rescheduleCustomerCall,
  resolveAddress
} from "@/lib/actions";
import { calculateDriverFinancialSummary, calculateDriverSettlementFinancials, driverCashReceiptRows, calculatePlatformPosition, entriesForClosedOrder, formatCop, isChargeableFailedOrder, gmfForPayout, isOrderEligibleForSellerSettlement, mergeWalletEntries, netAfterGmf, normalizeProductName, selectOpenWalletEntries, sellerAbonoRows, sellerBalance, summarizeWalletPeriod, sellerDeliveredFeeForOrder, weeklyFailedRate } from "@/lib/finance";
import type { DriverFinancialSummary, SellerAbonoRow } from "@/lib/finance";
import { recomputeInventoryReservations } from "@/lib/inventory-movements";
import { driverFleetClosedOrders, filterDriverHistoryOrders, isDriverActiveOrder, latestClosingEvidence, orderClosedAt, type DriverHistoryFilters } from "@/lib/driver-history";
import { adminPrintableOrderStatuses, canPrintAdminLabel, canPrintAdminWarehouseLabel, canPrintSellerLabel, shouldShowUnprintedLabelBadge } from "@/lib/order-labels";
import { buildOrderExportRows, downloadOrdersXlsx, downloadRowsXlsx, downloadWalletXlsx, orderExportColumns } from "@/lib/order-export";
import { buildMissingProductCostEntries, buildUnassociatedProductRows } from "@/lib/product-catalog";
import { getSellerShopifyConnection, normalizeShopifyDomain } from "@/lib/shopify/connection";
import { emptyState } from "@/lib/seed";
import type { AppState, CashSnapshot, Community, Driver, Evidence, FailedCategory, FulfillmentMode, InventoryItem, Messenger, Order, OrderAuditEntry, OrderCorrectionKind, OrderCorrectionPlan, PaymentMethod, PayoutRequest, ProductCatalogItem, Role, Seller, Settlement, ShopifyInstallRequest, ShopifyStore, ShopifySyncIssue, StoreWebhookConfig, Supplier, WalletEntry } from "@/lib/types";

const storageKey = "ultima-milla-mvp-state";
const sessionKey = "kentro-session";
const accountsKey = "kentro-accounts";
const failedCategoryOptions: Array<{ value: FailedCategory; label: string; hint: string }> = [
  { value: "failed_visit", label: "Fallido real con visita", hint: "Genera cobro a tienda y pago al domiciliario." },
  { value: "no_coverage", label: "Sin cobertura", hint: "No genera cobro ni pago; queda para remonte por plataforma." },
  { value: "bad_order_or_no_contact", label: "Pedido malo / no contesta", hint: "No genera cobro ni pago; queda para gestion del vendedor." },
  { value: "bad_phone", label: "Pedido sin telefono / linea inactiva", hint: "No genera cobro ni pago; el numero no existe o la linea esta inactiva." },
  { value: "pending_review", label: "Pendiente revisar", hint: "No genera cobro ni pago hasta clasificarlo." }
];

function failedCategoryLabel(category?: FailedCategory) {
  return failedCategoryOptions.find((option) => option.value === (category ?? "failed_visit"))?.label ?? "Fallido real con visita";
}

function failedCategoryHint(category?: FailedCategory) {
  return failedCategoryOptions.find((option) => option.value === category)?.hint ?? "";
}

type FailedCategoryFilter = "all" | FailedCategory;

function normalizedFailedCategory(order: Order): FailedCategory {
  return order.failedCategory ?? "failed_visit";
}

const failedCategoryFilterOptions: Array<{ value: FailedCategoryFilter; label: string; helper: string }> = [
  { value: "all", label: "Todos", helper: "Total fallidos del rango." },
  { value: "failed_visit", label: "Con visita", helper: "Cobrable; puede requerir reintento." },
  { value: "no_coverage", label: "Sin cobertura", helper: "Se manda por transportadora." },
  { value: "bad_order_or_no_contact", label: "No contesta / pedido malo", helper: "Volver a contactar o corregir datos." },
  { value: "bad_phone", label: "Sin telefono / linea inactiva", helper: "Numero inexistente o linea inactiva." },
  { value: "pending_review", label: "Pendiente revisar", helper: "Falta clasificar." }
];

function filterByFailedCategory(orders: Order[], category: FailedCategoryFilter) {
  if (category === "all") return orders;
  return orders.filter((order) => normalizedFailedCategory(order) === category);
}

function FailedCategoryFilters({ orders, value, onChange }: { orders: Order[]; value: FailedCategoryFilter; onChange: (value: FailedCategoryFilter) => void }) {
  const counts = failedCategoryFilterOptions.reduce<Record<FailedCategoryFilter, number>>((acc, option) => {
    acc[option.value] = option.value === "all" ? orders.length : orders.filter((order) => normalizedFailedCategory(order) === option.value).length;
    return acc;
  }, {} as Record<FailedCategoryFilter, number>);

  return (
    <div className="grid gap-2">
      <div className="grid gap-2 md:grid-cols-5">
        {failedCategoryFilterOptions.map((option) => (
          <button
            key={option.value}
            className={`focus-ring grid min-h-20 content-between rounded-2xl border px-3 py-2 text-left text-sm ${value === option.value ? "border-white/20 bg-acid text-deep" : "border-white/10 bg-panel text-fg"}`}
            type="button"
            onClick={() => onChange(option.value)}
          >
            <span className="font-semibold">{option.label}</span>
            <span className={`text-2xl font-bold ${value === option.value ? "text-deep" : "text-fg"}`}>{counts[option.value]}</span>
            <span className={`text-xs ${value === option.value ? "text-deep/70" : "text-ink-60"}`}>{option.helper}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type LocalAccount = {
  id: string;
  email: string;
  password: string;
  name: string;
  role: Role;
  profileId: string;
};

type Session = Omit<LocalAccount, "password">;
// El lider logistico tenia SEIS secciones dentro de "operations" mientras el riel mostraba dos
// entradas. Ahora cada momento de su jornada es un destino propio.
type AppView = "operations" | "wallet" | "liquidations" | "inventory" | "dispatch" | "finance" | "history" | "integrations" | "settings";
function readAccounts(): LocalAccount[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(accountsKey);
  return raw ? (JSON.parse(raw) as LocalAccount[]) : [];
}

function writeAccounts(accounts: LocalAccount[]) {
  window.localStorage.setItem(accountsKey, JSON.stringify(accounts));
}

function readableError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function shouldQueueEvidence(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = readableError(error, "").toLowerCase();
  return !navigator.onLine
    || code === "storage/retry-limit-exceeded"
    || code === "storage/canceled"
    || code === "storage/server-file-wrong-size"
    || message.includes("network")
    || message.includes("fetch")
    || message.includes("offline")
    || message.includes("timeout");
}

function createLocalUser(
  state: AppState,
  account: { name: string; email: string; password: string; role: Role; leaderDriverId?: string; linkedSellerId?: string }
): { state: AppState; account: LocalAccount; error: string | null } {
  const email = account.email.trim().toLowerCase();
  const accounts = readAccounts();
  if (accounts.some((item) => item.email === email)) {
    return { state, account: accounts[0], error: "Ya existe una cuenta con ese email." };
  }
  if (!account.name.trim()) {
    return { state, account: accounts[0], error: "El nombre es obligatorio." };
  }
  if (account.password.length < 6) {
    return { state, account: accounts[0], error: "La contrasena debe tener al menos 6 caracteres." };
  }
  if (account.role === "seller_logistics" && !account.linkedSellerId) {
    return { state, account: accounts[0], error: "El logistico de tienda debe vincularse a una tienda existente." };
  }

  // Vendedor y logistico de tienda pueden apuntar a un seller existente; el resto genera un perfil nuevo.
  const profileId =
    (account.role === "seller" || account.role === "seller_logistics") && account.linkedSellerId
      ? account.linkedSellerId
      : `${account.role}-${Date.now()}`;
  const localId = `user-${Date.now()}`;
  const nextAccount: LocalAccount = {
    id: localId,
    email,
    password: account.password,
    name: account.name.trim(),
    role: account.role,
    profileId
  };

  const now = new Date().toISOString();
  const nextState: AppState = {
    ...state,
    activeRole: state.activeRole,
    sellers:
      account.role === "seller"
        ? [
            {
              id: profileId,
              name: account.name.trim(),
              shopDomain: "",
              cityId: state.settings.activeCityId,
              bankAccount: ""
            },
            ...state.sellers
          ]
        : state.sellers,
    drivers:
      account.role === "driver"
        ? [
            {
              id: profileId,
              name: account.name.trim(),
              phone: "",
              active: true
            },
            ...state.drivers
          ]
        : state.drivers,
    messengers:
      account.role === "messenger"
        ? [
            {
              id: profileId,
              leaderDriverId: account.leaderDriverId || state.drivers[0]?.id || "",
              name: account.name.trim(),
              phone: "",
              active: true,
              createdAt: now,
              updatedAt: now
            },
            ...state.messengers
          ]
        : state.messengers,
    audit: [
      {
        id: `audit-${Date.now()}`,
        actorId: nextAccount.id,
        actorRole: account.role,
        action: "auth.user_created",
        entity: "user",
        entityId: nextAccount.id,
        summary: `Cuenta ${roleLabel(account.role)} creada`,
        createdAt: now
      },
      ...state.audit
    ]
  };

  return { state: nextState, account: nextAccount, error: null };
}

async function createUserFromAdmin(
  state: AppState,
  account: { name: string; email: string; password: string; role: Role; leaderDriverId?: string; linkedSellerId?: string }
): Promise<{ state: AppState; account: LocalAccount; error: string | null }> {
  if (!firebaseEnabled()) {
    const result = createLocalUser(state, account);
    if (!result.error) writeAccounts([result.account, ...readAccounts()]);
    return result;
  }

  const localResult = createLocalUser(state, account);
  if (localResult.error) return localResult;

  try {
    const created = await createManagedFirebaseUser({
      email: account.email.trim().toLowerCase(),
      password: account.password,
      name: account.name.trim(),
      role: account.role,
      profileId: localResult.account.profileId,
      leaderDriverId: account.leaderDriverId
    });
    const firebaseAccount = {
      ...localResult.account,
      id: created.uid
    };
    writeAccounts([firebaseAccount, ...readAccounts()]);
    await saveFirestoreState({
      ...localResult.state,
      activeRole: state.activeRole
    });
    return {
      ...localResult,
      account: firebaseAccount,
      state: {
        ...localResult.state,
        audit: localResult.state.audit.map((event, index) =>
          index === 0 ? { ...event, actorId: created.uid, entityId: created.uid } : event
        )
      }
    };
  } catch (error) {
    return {
      state,
      account: localResult.account,
      error: error instanceof Error ? error.message : "No se pudo crear usuario en Firebase."
    };
  }
}

function withoutLegacyDemo(state: AppState) {
  const base = emptyState();
  const safeState = {
    ...base,
    ...state,
    cities: state.cities ?? base.cities,
    zones: state.zones ?? base.zones,
    sellers: state.sellers ?? base.sellers,
    shopifyStores: state.shopifyStores ?? base.shopifyStores,
    shopifyInstallRequests: state.shopifyInstallRequests ?? base.shopifyInstallRequests,
    shopifySyncIssues: state.shopifySyncIssues ?? base.shopifySyncIssues,
    drivers: state.drivers ?? base.drivers,
    messengers: state.messengers ?? base.messengers,
    pickupBatches: state.pickupBatches ?? base.pickupBatches,
    suppliers: state.suppliers ?? base.suppliers,
    productCatalog: state.productCatalog ?? base.productCatalog,
    inventory: state.inventory ?? base.inventory,
    orders: state.orders ?? base.orders,
    wallet: state.wallet ?? base.wallet,
    settlements: state.settlements ?? base.settlements,
    payouts: state.payouts ?? base.payouts,
    audit: state.audit ?? base.audit,
    settings: { ...base.settings, ...(state.settings ?? {}) }
  };
  const containsOldDemo = safeState.audit.some((event) => event.action === "seed" || event.entityId === "demo");
  return containsOldDemo ? emptyState() : safeState;
}

function normalizeSellerReference(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") || trimmed.startsWith("MAN-") ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

function shopifyRequestId(sellerId: string, shopDomain: string) {
  return `sir-${sellerId}-${shopDomain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

// Ventana por defecto de pedidos cerrados: los ultimos 7 dias, igual que el filtro de fecha.
const defaultOrderStartDate = dateValue(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));

function useAppState(session: Session | null, historyStart?: string) {
  const [state, setState] = useState<AppState>(() => emptyState());
  const [hydrated, setHydrated] = useState(false);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const applyingRemote = useRef(false);

  useEffect(() => {
    const hydrateLocal = () => {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        setState(withoutLegacyDemo(JSON.parse(raw) as AppState));
      }
      setRemoteEnabled(false);
      setHydrated(true);
    };

    const context = session ? { role: session.role, profileId: session.profileId, historyStart } : undefined;
    if (session && canUseFirestoreStore()) {
      setRemoteEnabled(true);
      // La suscripcion es ahora la unica fuente: hace la carga inicial (omitiendo las
      // colecciones que ella misma observa) y luego aplica cambios incrementales. Antes
      // se llamaba tambien a loadFirestoreState aqui, lo que descargaba todo dos veces.
      return subscribeFirestoreState(
        context,
        (remoteState) => {
          applyingRemote.current = true;
          setState(withoutLegacyDemo(remoteState));
          setHydrated(true);
        },
        () => {
          void saveFirestoreState(state, context).catch((error) => console.error("No se pudo inicializar el estado remoto.", error));
          setHydrated(true);
        }
      );
    }

    hydrateLocal();
    return undefined;
  }, [session?.id, session?.profileId, session?.role, historyStart]);

  useEffect(() => {
    if (!hydrated) return;
    if (applyingRemote.current) {
      applyingRemote.current = false;
      return;
    }
    if (remoteEnabled) {
      if (session?.role !== "admin") return;
      const context = session ? { role: session.role, profileId: session.profileId } : undefined;
      void saveFirestoreState(state, context).catch((error) => console.error("No se pudo guardar el estado remoto.", error));
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }, [hydrated, remoteEnabled, session, state]);

  return { state, setState, remoteEnabled, hydrated };
}

/** Esqueleto de la primera carga. Antes la app pintaba el panel VACIO y se llenaba de golpe
 *  cuando llegaba el primer snapshot, lo que se leia como "no hay pedidos" durante un segundo. */
/** Cierra un dialogo con Escape. No habia ningun manejador de teclado en toda la app: un
 *  modal solo se podia cerrar apuntando al boton, lo que en un movil con una mano es peor. */
function useEscapeToClose(onClose: (() => void) | undefined) {
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

function AppSkeleton() {
  return (
    <div className="mx-auto grid max-w-7xl gap-4 px-4 py-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando la operacion...</span>
      <div className="h-8 w-64 animate-pulse rounded-full bg-white/5" />
      <div className="grid gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-24 animate-pulse rounded-3xl border border-white/10 bg-panel" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-3xl border border-white/10 bg-panel" />
    </div>
  );
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    imported: "Pendiente confirmacion",
    address_risk: "Direccion por revisar",
    ready_to_assign: "Listo para asignar",
    assigned: "Asignado",
    call_pending: "Llamada pendiente",
    scheduled: "Llamada registrada",
    picked_up: "Recogido",
    in_route: "En ruta",
    delivered: "Entregado",
    failed: "Fallido",
    retry_pending: "Visita reprogramada",
    cancelled: "Cancelado"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

// Sello de caucho: borde y tinta del color del estado, no una pastilla rellena. Asi el estado
// se lee sin que el color inunde la fila, y sigue distinguiendose en escala de grises.
function statusTone(order: Order) {
  if (order.status === "delivered") return "bg-acid/10 text-acid";
  if (order.status === "failed" || order.addressRisk === "review") return "bg-rust/10 text-rust";
  if (order.status === "in_route" || order.status === "picked_up") return "bg-info/10 text-info";
  return "bg-white/5 text-ink-60";
}

const orderStatusOptions: Array<{ value: "all" | Order["status"]; label: string }> = [
  { value: "all", label: "Todos los estados" },
  { value: "imported", label: "Pendiente confirmar" },
  { value: "ready_to_assign", label: "Confirmados" },
  { value: "assigned", label: "Asignados" },
  { value: "call_pending", label: "Llamada pendiente" },
  { value: "scheduled", label: "Agendados" },
  { value: "picked_up", label: "Recogidos" },
  { value: "in_route", label: "En transito" },
  { value: "delivered", label: "Entregados" },
  { value: "failed", label: "Fallidos" },
  { value: "cancelled", label: "Anulados" }
];

function dateValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function orderDateValue(order: Order) {
  return (order.createdAt || order.updatedAt || "").slice(0, 10);
}

// ISO 8601 ordena bien con comparacion directa; localeCompare (Intl) es un orden de magnitud
// mas lento y aqui se ejecuta miles de veces por render. Mismo criterio que state-store.ts.
function compareOrdersByCreatedAtDesc(left: Order, right: Order) {
  const a = String(left.createdAt || left.updatedAt);
  const b = String(right.createdAt || right.updatedAt);
  return a < b ? 1 : a > b ? -1 : 0;
}

// La espera de una recogida se cuenta desde que el pedido quedo listo, no desde que se importo:
// un pedido de hace un mes confirmado ayer no lleva un mes esperando. En el cliente no hay
// eventos de auditoria, asi que el ultimo cambio (`updatedAt`) es la mejor marca disponible
// —mientras espera recogida lo unico que lo toca es imprimir el rotulo—.
function compareOrdersByPickupWaitAsc(left: Order, right: Order) {
  const a = String(left.updatedAt || left.createdAt);
  const b = String(right.updatedAt || right.createdAt);
  return a < b ? -1 : a > b ? 1 : 0;
}

function filterOrdersByRangeStatus(orders: Order[], startDate: string, endDate: string, status: string, search: string) {
  return orders
    .filter((order) => {
      const date = orderDateValue(order);
      if (startDate && date && date < startDate) return false;
      if (endDate && date && date > endDate) return false;
      if (status !== "all" && order.status !== status) return false;
      return orderSearchMatches(order, search);
    })
    .sort(compareOrdersByCreatedAtDesc);
}


/**
 * Fila de atajos de periodo. `onSelect` entrega las DOS fechas juntas: moverlas por separado
 * dispararia dos veces el filtrado y, en la vista de pedidos, dos re-suscripciones a Firestore.
 */
function DateRangePresets({ startDate, endDate, onSelect }: { startDate: string; endDate: string; onSelect: (startDate: string, endDate: string) => void }) {
  const presets = useMemo(() => ORDER_RANGE_PRESETS.map((preset) => ({ ...preset, range: preset.resolve() })), []);
  const active = presets.find((preset) => preset.range.startDate === startDate && preset.range.endDate === endDate);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((preset) => {
          const isActive = active?.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              title={preset.hint}
              aria-pressed={isActive}
              onClick={() => onSelect(preset.range.startDate, preset.range.endDate)}
              className={`focus-ring rounded-full border px-4 text-xs font-semibold transition ${isActive ? "border-acid/40 bg-acid/15 text-acid" : "border-white/10 text-ink-60 hover:bg-field"}`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-60">
        {active
          ? `${active.hint} ${active.range.startDate ? `Del ${active.range.startDate}` : "Desde el primer pedido"} al ${active.range.endDate}.`
          : "Periodos ya cerrados. La semana en curso queda fuera porque todavia tiene pedidos en ruta."}
      </p>
    </div>
  );
}

function OrderFilters({
  startDate,
  endDate,
  status,
  sellers = [],
  sellerFilter,
  historyStart,
  onStartDate,
  onEndDate,
  onStatus,
  onSeller,
  onSelectRange
}: {
  startDate: string;
  endDate: string;
  status: string;
  sellers?: Seller[];
  sellerFilter?: string;
  /** Fecha desde la que el navegador tiene descargados los pedidos ya cerrados. */
  historyStart?: string;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  onStatus: (value: string) => void;
  onSeller?: (value: string) => void;
  /**
   * Atajo de periodo. Se pasa aparte de los dos setters porque en la vista de pedidos ademas
   * hay que ensanchar la ventana de descarga en el mismo gesto: "Acumulado" manda `startDate`
   * vacio y el ensanchado automatico, que compara fechas, no se dispara con una cadena vacia.
   */
  onSelectRange?: (startDate: string, endDate: string) => void;
}) {
  const selectRange = onSelectRange ?? ((start: string, end: string) => { onStartDate(start); onEndDate(end); });
  return (
    <Card>
      <div className="mb-3">
        <DateRangePresets startDate={startDate} endDate={endDate} onSelect={selectRange} />
      </div>
      <div className={`grid gap-2 ${onSeller ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Desde
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={startDate} onChange={(event) => onStartDate(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Hasta
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={endDate} onChange={(event) => onEndDate(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Estado
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={status} onChange={(event) => onStatus(event.target.value)}>
            {orderStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {onSeller && (
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Vendedor
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={sellerFilter ?? "all"} onChange={(event) => onSeller(event.target.value)}>
              <option value="all">Todos los vendedores</option>
              {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {historyStart && (
        <p className="mt-2 text-xs text-ink-60">
          Los pedidos abiertos siempre estan completos. Los cerrados se descargan desde el {historyStart}; si eliges una fecha anterior se amplia sola.
        </p>
      )}
    </Card>
  );
}

/**
 * Calculo del embudo operativo. Vive fuera del componente porque la franja de indicadores de
 * la tienda necesita cuatro de estas cifras: duplicar la matematica seria garantizar que un dia
 * el porcentaje de la franja y el del panel dejen de coincidir.
 *
 * Los buckets del embudo son EXCLUYENTES entre si (de ahi la cadena de else-if) y por eso suman
 * el total filtrado. Las tasas de abajo son lecturas transversales del mismo rango.
 */
function computeLogisticsKpis(orders: Order[], state: AppState) {
  const inOperationStatuses = new Set(["call_pending", "scheduled", "in_route", "retry_pending"]);
  const pickedByDriverStatuses = new Set(["call_pending", "scheduled", "picked_up", "in_route", "retry_pending", "delivered", "failed", "liquidated"]);
  let pendingConfirm = 0;
  let readyWithoutLeader = 0;
  let assignedPendingPickup = 0;
  let pickedWithoutMessenger = 0;
  let inOperation = 0;
  let delivered = 0;
  let failed = 0;
  let chargeableFailed = 0;
  let noCoverageFailed = 0;
  let badOrderFailed = 0;
  let badPhoneFailed = 0;
  let cancelled = 0;
  let liquidated = 0;
  let pickedByDriver = 0;
  let storeCodCop = 0;

  for (const order of orders) {
    const status = order.status;
    if (status === "imported" || status === "address_risk") pendingConfirm++;
    else if (status === "ready_to_assign" && !order.driverId) readyWithoutLeader++;
    else if (status === "assigned") assignedPendingPickup++;
    else if (status === "picked_up" && !order.messengerId) pickedWithoutMessenger++;
    else if (inOperationStatuses.has(status) || (status === "picked_up" && Boolean(order.messengerId))) inOperation++;
    else if (status === "delivered") delivered++;
    else if (status === "failed") failed++;
    else if (status === "cancelled") cancelled++;
    else if (status === "liquidated") liquidated++;

    if (status === "failed") {
      if (order.failedCategory === "no_coverage") noCoverageFailed++;
      else if (order.failedCategory === "bad_order_or_no_contact") badOrderFailed++;
      else if (order.failedCategory === "bad_phone") badPhoneFailed++;
    }
    if (isChargeableFailedOrder(order)) chargeableFailed++;
    if (order.driverId && pickedByDriverStatuses.has(status)) pickedByDriver++;
    if (order.paymentMethod === "cod" && (status === "delivered" || status === "liquidated")) {
      storeCodCop += Math.max(0, order.totalCop - sellerDeliveredFeeForOrder(order, state));
    }
  }

  const dispatchable = Math.max(0, pickedByDriver - noCoverageFailed - badOrderFailed - badPhoneFailed);
  const closedDispatchable = delivered + chargeableFailed + liquidated;
  return {
    total: orders.length,
    pendingConfirm,
    readyWithoutLeader,
    assignedPendingPickup,
    pickedWithoutMessenger,
    inOperation,
    delivered,
    failed,
    chargeableFailed,
    cancelled,
    liquidated,
    pickedByDriver,
    funnelTotal: pendingConfirm + readyWithoutLeader + assignedPendingPickup + pickedWithoutMessenger + inOperation + delivered + failed + cancelled + liquidated,
    dispatchable,
    dispatchRate: pickedByDriver > 0 ? Math.round((dispatchable / pickedByDriver) * 100) : 0,
    closedDispatchable,
    openDispatchable: Math.max(0, dispatchable - closedDispatchable),
    completionRate: dispatchable > 0 ? Math.round((closedDispatchable / dispatchable) * 100) : 0,
    storeCodCop,
    deliveryRate: dispatchable > 0 ? Math.round((delivered / dispatchable) * 100) : 0,
    returnRate: dispatchable > 0 ? Math.round((chargeableFailed / dispatchable) * 100) : 0
  };
}

function LogisticsKpis({ orders, state, hideFinance = false, periodStats = null, showStrip = true }: { orders: Order[]; state: AppState; hideFinance?: boolean; periodStats?: OrderPeriodStats | null; showStrip?: boolean }) {
  // `sellerDeliveredFeeForOrder` solo lee zonas y tarifas globales; ambas mantienen identidad
  // entre emisiones salvo que cambien de verdad, asi que el memo se sostiene.
  const kpis = useMemo(() => computeLogisticsKpis(orders, state), [orders, state.zones, state.settings]);

  const {
    total,
    pendingConfirm,
    readyWithoutLeader,
    assignedPendingPickup,
    pickedWithoutMessenger,
    inOperation,
    delivered,
    failed,
    chargeableFailed,
    cancelled,
    liquidated,
    funnelTotal,
    storeCodCop
  } = kpis;
  // Cuando el rango pedido se sale de la ventana descargada, las lecturas transversales vienen
  // agregadas del servidor: calcularlas sobre los pedidos que hay en memoria daria cifras cortas
  // sin avisar, que en indicadores de gestion es peor que no mostrarlas.
  const readings = periodStats ?? kpis;
  const { dispatchRate, completionRate, deliveryRate, returnRate } = readings;
  const readingsPickedByDriver = readings.pickedByDriver;
  const readingsDispatchable = readings.dispatchable;
  const readingsOpenDispatchable = readings.openDispatchable;
  return (
    <div className="grid gap-3">
      {/* Cuatro cifras visibles; las diecinueve tarjetas del detalle, plegadas.
          Estaban TODAS abiertas: en tienda eso eran 23 bloques de numeros (con la franja de la
          cabecera) antes de llegar al primer pedido. El embudo se consulta cuando algo no cuadra,
          no en cada visita. */}
      {showStrip && (
        <div className="grid grid-cols-2 divide-x divide-y divide-white/[0.06] overflow-hidden rounded-3xl border border-white/[0.06] bg-panel sm:grid-cols-4 sm:divide-y-0">
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Total pedidos</p>
            <p className="tabular text-xl font-bold">{total}</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Abiertos despachables</p>
            <p className={`tabular text-xl font-bold ${readingsOpenDispatchable > 0 ? "text-info" : ""}`}>{readingsOpenDispatchable}</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">% entrega</p>
            <p className="tabular text-xl font-bold text-mint">{deliveryRate}%</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">% terminacion</p>
            <p className="tabular text-xl font-bold">{completionRate}%</p>
          </div>
        </div>
      )}
      <CollapsiblePanel
        title="Embudo e indicadores"
        summary={`${total} pedidos · ${readingsDispatchable} despachables · ${deliveryRate}% entrega`}
        help="% despacho = despachables / tomados por lider. % terminacion = entregados, fallidos con visita y liquidados / despachables. Abiertos despachables = despachables menos cerrados. Despachables = tomados por lider menos sin cobertura y pedido malo/no contesta. % devolucion = fallidos con visita / despachables."
      >
        <div className="grid gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-bold uppercase text-ink-60">Embudo operativo</h2>
          <p className="text-xs text-ink-60">Estas tarjetas son excluyentes y deben sumar el total filtrado.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <Metric icon={<ClipboardList size={20} />} label="Total filtrado" value={String(total)} />
          <Metric icon={<AlertTriangle size={20} />} label="Pendiente confirmar" value={String(pendingConfirm)} />
          <Metric icon={<Check size={20} />} label="Listo sin lider" value={String(readyWithoutLeader)} />
          <Metric icon={<Truck size={20} />} label="Asignado pendiente recoger" value={String(assignedPendingPickup)} />
          <Metric icon={<QrCode size={20} />} label="Recogido sin mensajero" value={String(pickedWithoutMessenger)} />
          <Metric icon={<Route size={20} />} label="En gestion/ruta" value={String(inOperation)} />
          <Metric icon={<PackageCheck size={20} />} label="Entregados" value={String(delivered)} />
          <Metric icon={<X size={20} />} label="Fallidos" value={String(failed)} />
          <Metric icon={<AlertTriangle size={20} />} label="Fallido con visita" value={String(chargeableFailed)} />
          <Metric icon={<ShieldCheck size={20} />} label="Cancelados" value={String(cancelled)} />
          {liquidated > 0 && <Metric icon={<CreditCard size={20} />} label="Liquidados" value={String(liquidated)} />}
        </div>
        {funnelTotal !== total && (
          <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">
            Revision: el embudo suma {funnelTotal} y el total filtrado es {total}. Hay estados no clasificados.
          </p>
        )}
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-bold uppercase text-ink-60">Indicadores</h2>
          <p className="text-xs text-ink-60">Estas metricas no se suman; son lecturas transversales del mismo rango.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <Metric icon={<QrCode size={20} />} label="Tomados por lider" value={String(readingsPickedByDriver)} />
          <Metric icon={<Route size={20} />} label="% despacho" value={`${dispatchRate}%`} />
          <Metric icon={<Check size={20} />} label="% terminacion" value={`${completionRate}%`} />
          <Metric icon={<AlertTriangle size={20} />} label="Abiertos despachables" value={String(readingsOpenDispatchable)} />
          <Metric icon={<Route size={20} />} label="Despachables" value={String(readingsDispatchable)} />
          <Metric icon={<ShieldCheck size={20} />} label="% entrega" value={`${deliveryRate}%`} />
          <Metric icon={<X size={20} />} label="% devolucion" value={`${returnRate}%`} />
          {!hideFinance && !periodStats && <Metric icon={<Wallet size={20} />} label="Recaudo tienda rango" value={formatCop(storeCodCop)} />}
        </div>
        {periodStats && (
          <p className="rounded-2xl bg-info/10 px-3 py-2 text-xs font-semibold text-info">
            Indicadores calculados en el servidor sobre el periodo completo, sin descargar los pedidos.
            El embudo de arriba y el recaudo solo cuentan los pedidos que el navegador tiene cargados.
          </p>
        )}
       </div>
      </CollapsiblePanel>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function orderLookupUrl(order: Order) {
  const code = order.trackingCode ?? order.shopifyOrderId;
  const origin = typeof window !== "undefined" ? window.location.origin : "https://kentro.com.co";
  return `${origin}/?order=${encodeURIComponent(code)}`;
}

async function printOrderLabels(orders: Order[], state: AppState, title = "Rotulos Kentro") {
  if (orders.length === 0) return false;
  const popup = window.open("", "_blank", "width=900,height=700");
  if (!popup) return false;
  const labels = await Promise.all(orders.map(async (order) => {
    const seller = state.sellers.find((item) => item.id === order.sellerId);
    const zone = state.zones.find((item) => item.id === order.zoneId);
    const code = order.trackingCode ?? order.shopifyOrderId;
    const address = order.normalizedAddress ?? order.addressRaw;
    const codText = order.paymentMethod === "cod" ? `COBRAR ${formatCop(order.totalCop)}` : "PAGADO";
    const lookupUrl = orderLookupUrl(order);
    // QRCode se carga aqui: solo hace falta al imprimir un rotulo, no al arrancar la app.
    const { default: QRCode } = await import("qrcode");
    const qrDataUrl = await QRCode.toDataURL(lookupUrl, { errorCorrectionLevel: "M", margin: 1, width: 180 });
    // El map corre dentro de un Promise.all: si un codigo raro no fuera codificable en Code128,
    // el throw tumbaria la impresion del lote entero. Sin barras, pero con QR, mejor que sin rotulo.
    let barcodeSvg = "";
    try {
      barcodeSvg = renderCode128Svg(code);
    } catch {
      barcodeSvg = "";
    }
    return `
      <article class="label">
        <div class="top">
          <div>
            <p class="eyebrow">KENTRO</p>
            <h1>${escapeHtml(code)}</h1>
          </div>
          <div class="pay">${escapeHtml(codText)}</div>
        </div>
        <section class="scan">
          <img src="${qrDataUrl}" alt="QR ${escapeHtml(code)}" />
          <div>
            <p class="key">Escanear para abrir pedido</p>
            <p class="value">${escapeHtml(code)}</p>
            <p class="small">Camara: QR &middot; Despacho: pistola</p>
          </div>
        </section>
        <section class="barcode">
          ${barcodeSvg}
          <p class="barcode-code">${escapeHtml(code)}</p>
        </section>
        <section class="grid">
          <div>
            <p class="key">Cliente</p>
            <p class="value">${escapeHtml(order.customerName)}</p>
            <p>${escapeHtml(order.customerPhone)}</p>
          </div>
          <div>
            <p class="key">Vendedor</p>
            <p class="value">${escapeHtml(seller?.name ?? order.sellerId)}</p>
            <p>${order.fulfillmentMode === "warehouse" ? "Producto en bodega" : "Recogida vendedor"}</p>
          </div>
        </section>
        <section>
          <p class="key">Direccion</p>
          <p class="address">${escapeHtml(address)}</p>
        </section>
        <section class="product-grid">
          <div class="product-block">
            <p class="key">Producto</p>
            <p class="product-name">${escapeHtml(order.productName ?? "Producto")}</p>
            <p class="sku">${order.sku ? `SKU ${escapeHtml(order.sku)}` : "Sin SKU"}</p>
          </div>
          <div class="qty-block">
            <p class="key">Cantidad</p>
            <p class="qty">${escapeHtml(order.quantity ?? 1)}</p>
            <p>${escapeHtml(zone?.name ?? "Sin zona")}</p>
          </div>
        </section>
        <footer>
          <span>Ref ${escapeHtml(order.shopifyOrderId)}</span>
          <span>${escapeHtml(statusLabel(order.status))}</span>
        </footer>
      </article>
    `;
  }));
  popup.document.open();
  popup.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          @page { size: 100mm 150mm; margin: 4mm; }
          * { box-sizing: border-box; }
          body { margin: 0; background: #fff; color: #111; font-family: Arial, Helvetica, sans-serif; }
          .toolbar { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #ddd; }
          .toolbar button { border: 0; border-radius: 6px; background: #111; color: #fff; padding: 10px 14px; font-weight: 700; cursor: pointer; }
          .sheet { display: block; padding: 5mm; }
          .label { page-break-after: always; break-after: page; overflow: hidden; border: 2px solid #111; border-radius: 7px; padding: 8px; height: 140mm; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto; gap: 6px; align-content: start; }
          .top, .grid, .product-grid, footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
          .scan { display: grid; grid-template-columns: 22mm minmax(0, 1fr); gap: 8px; align-items: center; border: 2px solid #111; border-radius: 7px; padding: 6px; }
          .scan img { width: 22mm; height: 22mm; image-rendering: pixelated; }
          .barcode { display: grid; justify-items: center; gap: 1px; border: 2px solid #111; border-radius: 7px; padding: 5px 4px; }
          .barcode svg { display: block; }
          .barcode-code { font-family: "Courier New", monospace; font-size: 13px; font-weight: 700; letter-spacing: 2px; }
          .eyebrow, .key { margin: 0 0 2px; color: #555; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
          h1 { margin: 0; font-size: 30px; line-height: 1; }
          p { margin: 0; font-size: 11px; line-height: 1.2; }
          .value { font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
          .small { margin-top: 3px; font-size: 7.5px; line-height: 1.1; overflow-wrap: anywhere; color: #555; }
          .address { max-height: 28mm; overflow: hidden; font-size: 15px; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
          .pay { border: 2px solid #111; border-radius: 6px; padding: 6px; font-size: 14px; font-weight: 900; text-align: center; }
          .product-grid { min-height: 0; grid-template-columns: minmax(0, 1fr) 22mm; }
          .product-block { min-width: 0; min-height: 0; overflow: hidden; }
          .product-name { display: -webkit-box; max-height: 30mm; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 5; font-size: 13px; font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
          .sku { margin-top: 3px; font-size: 9px; line-height: 1.1; overflow-wrap: anywhere; }
          .qty-block { text-align: right; }
          .qty { font-size: 25px; font-weight: 900; line-height: 1; text-align: right; }
          footer { border-top: 1px solid #111; padding-top: 6px; font-size: 10px; font-weight: 700; }
          @media print {
            .toolbar { display: none; }
            .sheet { padding: 0; }
            .label:last-child { page-break-after: auto; break-after: auto; }
          }
        </style>
      </head>
      <body>
        <div class="toolbar">
          <strong>${escapeHtml(title)} · ${orders.length} pedido${orders.length === 1 ? "" : "s"}</strong>
          <button onclick="window.print()">Imprimir</button>
        </div>
        <main class="sheet">${labels.join("")}</main>
        <script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));</script>
      </body>
    </html>
  `);
  popup.document.close();
  popup.focus();
  return true;
}

function markOrdersLabelsPrinted(state: AppState, orders: Order[], actorId?: string) {
  const printedAt = new Date().toISOString();
  const ids = new Set(orders.map((order) => order.id));
  const nextOrders = state.orders.map((order) =>
    ids.has(order.id)
      ? {
          ...order,
          labelPrintedAt: printedAt,
          labelPrintedBy: actorId,
          labelPrintCount: (order.labelPrintCount ?? 0) + 1,
          updatedAt: printedAt
        }
      : order
  );
  const updated = nextOrders.filter((order) => ids.has(order.id));
  void Promise.all(updated.map((order) => saveFirestoreOrderLabelPrint(order)));
  return { ...state, orders: nextOrders };
}

/**
 * Panel plegable. Reduce lo que se pinta EN REPOSO sin quitar nada de lo que se puede hacer.
 *
 * Tres reglas:
 *  - `hideWhenEmpty` con `count` en 0: no se pinta. Habia 80 estados vacios declarados y solo 2
 *    paneles que se ocultaban; los otros 78 gastaban una tarjeta a ancho completo para decir
 *    "no hay nada". Que este vacio ya lo dice el cero de la franja de indicadores.
 *  - `defaultOpen`: se abre solo si tiene TRABAJO ESPERANDO. Un dia tranquilo y uno con 80
 *    pedidos sin asignar no deben verse igual.
 *  - `help`: la prosa que explica el panel se lee la primera vez y estorba para siempre. Va tras
 *    un icono, no en un parrafo permanente.
 */
function CollapsiblePanel({
  title,
  summary,
  help,
  count,
  defaultOpen = false,
  hideWhenEmpty = false,
  tone = "default",
  action,
  flush = false,
  children
}: {
  title: string;
  summary?: string;
  help?: string;
  count?: number;
  defaultOpen?: boolean;
  hideWhenEmpty?: boolean;
  tone?: "default" | "acid" | "rust";
  action?: React.ReactNode;
  /** El hijo ya trae su propia tarjeta: se pinta suelto debajo, sin marco ni relleno extra. */
  flush?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [helpOpen, setHelpOpen] = useState(false);
  if (hideWhenEmpty && (count ?? 0) === 0) return null;
  const toneClass = tone === "acid" ? "text-acid" : tone === "rust" ? "text-rust" : "text-ink-60";
  return (
    <section className={flush ? "grid min-w-0 gap-2" : "min-w-0 rounded-3xl border border-white/[0.06] bg-panel"}>
      <div className={`flex items-center gap-2 p-3 sm:p-4 ${flush ? "rounded-3xl border border-white/[0.06] bg-panel" : ""}`}>
        <button
          className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl text-left"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight className={`shrink-0 text-ink-60 transition-transform ${open ? "rotate-90" : ""}`} size={16} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold">{title}</span>
            {summary && <span className={`block truncate text-xs ${toneClass}`}>{summary}</span>}
          </span>
        </button>
        {help && (
          <button
            className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-60 hover:bg-white/10 hover:text-fg"
            type="button"
            aria-label={`Que es ${title}`}
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((current) => !current)}
          >
            <span className="text-sm font-bold">?</span>
          </button>
        )}
        {action}
      </div>
      {helpOpen && help && (
        <p className="border-t border-white/[0.06] px-4 py-2.5 text-xs leading-relaxed text-ink-60">{help}</p>
      )}
      {open && (flush ? children : <div className="border-t border-white/[0.06] p-3 sm:p-4">{children}</div>)}
    </section>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  // En oscuro la tarjeta se separa por TONO y sombra, no por filete: un borde marcado la
  // devuelve al aspecto de caja. El borde queda al 6%, solo para definir el canto.
  // `min-w-0`: sin esto, una tabla ancha dentro de la tarjeta empuja al contenedor en vez de
  // scrollear dentro de su propio `overflow-x-auto`. Los hijos de grid y flex traen
  // `min-width: auto` por defecto, asi que crecen con su contenido. Es lo que hacia que la pagina
  // de liquidaciones midiera 824px en un telefono de 390, tapado por el `overflow-x: hidden`
  // de `body`: no se veia un scroll horizontal, se veia contenido cortado y ya.
  return <section className={`min-w-0 rounded-3xl border border-white/[0.06] bg-panel p-5 shadow-[0_8px_32px_rgba(0,0,0,0.30)] ${className}`}>{children}</section>;
}

function SectionHeader({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-base font-bold">{title}</h2>
        {description && <p className="text-sm text-ink-60">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone = "default"
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "mint" | "rust";
}) {
  const toneClass = tone === "rust" ? "text-rust" : tone === "mint" ? "text-mint" : "text-fg";
  return (
    <div className="rounded-2xl border border-white/10 bg-field px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-ink-60">
        {icon}
        <p className="text-xs font-semibold uppercase tracking-normal">{label}</p>
      </div>
      <p className={`text-lg font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  disabled = false
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-panel text-fg transition hover:bg-field disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ToolbarButton({
  children,
  onClick,
  active = false
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold transition ${
        active ? "bg-acid text-deep" : "border border-white/10 bg-panel hover:bg-field"
      }`}
    >
      {children}
    </button>
  );
}

function Metric({ icon, label, value, className = "" }: { icon: React.ReactNode; label: string; value: string; className?: string }) {
  return (
    // En una rejilla de tres columnas a 390px cada tarjeta mide ~100px: el icono se comia 44
    // y el resto salia truncado ("Movimien... 2..."). Por debajo de sm el icono desaparece y
    // el rotulo puede envolver; a partir de sm vuelve la version horizontal con icono.
    <Card className={`p-3 sm:p-5 ${className}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-field text-acid sm:flex">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium leading-tight text-ink-60 sm:text-[13px]">{label}</p>
          <p className="tabular break-words text-base font-bold leading-tight tracking-tight sm:truncate sm:text-2xl">{value}</p>
        </div>
      </div>
    </Card>
  );
}

function usePaginatedItems<T>(items: T[], pageSize = 8) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  return {
    page: safePage,
    setPage,
    totalPages,
    visibleItems: items.slice(safePage * pageSize, safePage * pageSize + pageSize)
  };
}

function PaginationControls({
  page,
  totalPages,
  totalItems,
  onPageChange
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  if (totalItems === 0 || totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
      <p className="text-xs text-ink-60">{totalItems} registros · pagina {page + 1} de {totalPages}</p>
      <div className="flex items-center gap-2">
        <IconButton title="Pagina anterior" disabled={page === 0} onClick={() => onPageChange(Math.max(0, page - 1))}>
          <ChevronLeft size={16} />
        </IconButton>
        <IconButton title="Pagina siguiente" disabled={page >= totalPages - 1} onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}

function PaginatedList<T>({
  items,
  pageSize = 8,
  className = "grid gap-2",
  empty,
  children
}: {
  items: T[];
  pageSize?: number;
  className?: string;
  empty: React.ReactNode;
  children: (item: T) => React.ReactNode;
}) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(items, pageSize);
  return (
    <>
      {items.length === 0 ? empty : (
        <div className={className}>
          {visibleItems.map(children)}
        </div>
      )}
      <PaginationControls page={page} totalPages={totalPages} totalItems={items.length} onPageChange={setPage} />
    </>
  );
}

function AuthScreen({
  onSubmit,
  needsBootstrap
}: {
  onSubmit: (account: { name: string; email: string; password: string }) => Promise<string | null>;
  needsBootstrap: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = Boolean(email.trim() && password && (!needsBootstrap || name.trim()));

  return (
    <main className="grid min-h-screen place-items-center px-4 py-8">
      <section className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-5 shadow-panel">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-acid text-deep">
            <Route size={23} />
          </div>
          <div>
            <h1 className="text-xl font-bold">Kentro</h1>
            <p className="text-sm text-ink-60">{needsBootstrap ? "Crear primer administrador" : "Inicio de sesion"}</p>
          </div>
        </div>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting) return;
            if (!canSubmit) {
              setError(needsBootstrap ? "Completa nombre, email y contrasena." : "Completa email y contrasena.");
              return;
            }
            setSubmitting(true);
            void onSubmit({ name, email, password })
              .then((result) => setError(result))
              .finally(() => setSubmitting(false));
          }}
        >
          {needsBootstrap && (
            <label className="grid gap-1 text-sm font-semibold">
              Nombre
              <input className="focus-ring rounded-full border border-white/10 px-3 py-2 font-normal" value={name} onChange={(event) => setName(event.target.value)} onInput={(event) => setName(event.currentTarget.value)} required />
            </label>
          )}
          <label className="grid gap-1 text-sm font-semibold">
            Email
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 font-normal" type="email" value={email} onChange={(event) => setEmail(event.target.value)} onInput={(event) => setEmail(event.currentTarget.value)} required />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Contrasena
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 font-normal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onInput={(event) => setPassword(event.currentTarget.value)} required minLength={6} />
          </label>
          {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
          <button
            aria-label={needsBootstrap ? "Crear administrador" : "Entrar"}
            className="focus-ring min-h-11 w-full rounded-full bg-acid px-4 py-2 font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Entrando..." : needsBootstrap ? "Crear administrador" : "Entrar"}
          </button>
          {!needsBootstrap && (
            <p className="text-xs text-ink-60">Las cuentas de vendedores, lideres logisticos y mensajeros las crea un administrador.</p>
          )}
        </form>
      </section>
    </main>
  );
}

function Header({ session, remoteEnabled, onSignOut }: { session: Session; remoteEnabled: boolean; onSignOut: () => void }) {
  return (
    <header className="glass sticky top-0 z-20 border-x-0 border-t-0">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
        {/* El logo vive en el riel en escritorio; aqui solo aparece en telefono, donde no hay riel. */}
        <div className="flex items-center gap-3">
          <div className="glass-acid flex h-10 w-10 items-center justify-center rounded-full md:hidden">
            <Route size={20} />
          </div>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight text-fg">Kentro</h1>
            <p className="hidden text-sm text-ink-60 sm:block">Centro operativo de ultima milla</p>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="glass hidden items-center rounded-full px-3 py-1.5 text-xs font-medium text-ink-60 sm:inline-flex">
            {session.name} · {roleLabel(session.role)}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${remoteEnabled ? "bg-acid/10 text-acid" : "bg-white/5 text-ink-60"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${remoteEnabled ? "bg-acid" : "bg-ink-60"}`} />
            {remoteEnabled ? "En vivo" : "Local"}
          </span>
          <IconButton title="Cerrar sesion" onClick={onSignOut}><LogOut size={17} /></IconButton>
        </div>
      </div>
    </header>
  );
}

/** Navegacion principal. UN solo componente para los cinco roles: lo que cambia entre ellos es
 *  que pestanas aparecen, nunca la forma. En escritorio es un riel fijo a la izquierda (libera
 *  altura y deja de desplazarse con el contenido); en telefono baja a la zona del pulgar, que es
 *  donde el mensajero puede alcanzarla con una mano. */
/**
 * `short` es la etiqueta de la barra inferior del telefono. Con seis destinos a 390px quedan
 * ~62px por boton y "Integraciones" mide unos 72px a 11px: como los `flex-1` no encogen por
 * debajo de su contenido, la barra desbordaria a lo ancho. En el riel de escritorio cabe entera.
 */
const NAV_ITEMS: Array<{ view: AppView; label: string; short?: string; icon: React.ReactNode; roles: Role[] }> = [
  { view: "operations", label: "Operacion", icon: <Route size={20} />, roles: ["admin", "seller", "seller_logistics", "driver", "messenger"] },
  { view: "dispatch", label: "Despacho", icon: <PackageCheck size={20} />, roles: ["driver"] },
  { view: "finance", label: "Finanzas", icon: <CreditCard size={20} />, roles: ["driver"] },
  { view: "wallet", label: "Wallet", icon: <Wallet size={20} />, roles: ["admin", "seller", "driver"] },
  { view: "history", label: "Historico", icon: <History size={20} />, roles: ["driver"] },
  { view: "inventory", label: "Inventario", icon: <Boxes size={20} />, roles: ["admin", "seller", "seller_logistics"] },
  { view: "integrations", label: "Integraciones", short: "Tiendas", icon: <Store size={20} />, roles: ["admin", "seller", "seller_logistics"] },
  { view: "liquidations", label: "Liquidaciones", short: "Cortes", icon: <CreditCard size={20} />, roles: ["admin"] },
  { view: "settings", label: "Ajustes", icon: <Settings size={20} />, roles: ["admin"] }
];

function ViewTabs({ activeView, onChange, role }: { activeView: AppView; onChange: (view: AppView) => void; role: Role }) {
  const items = NAV_ITEMS.filter((item) => item.roles.includes(role));
  return (
    <>
      {/* Escritorio: riel fijo. */}
      <nav aria-label="Secciones" className="fixed inset-y-0 left-0 z-30 hidden w-[84px] flex-col items-center gap-1 border-r border-white/10 bg-ink/70 py-4 backdrop-blur md:flex">
        <div className="glass-acid mb-4 flex h-10 w-10 items-center justify-center rounded-full" aria-hidden="true">
          <Route size={20} />
        </div>
        {items.map((item) => {
          const active = activeView === item.view;
          return (
            <button
              key={item.view}
              className={`focus-ring flex w-[68px] flex-col items-center gap-1 rounded-2xl px-1 py-2.5 text-[11px] font-semibold transition-colors ${active ? "bg-acid text-deep" : "text-ink-60 hover:bg-white/10 hover:text-fg"}`}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onChange(item.view)}
            >
              {item.icon}
              <span className="leading-tight">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Telefono: barra inferior en la zona del pulgar. */}
      <nav aria-label="Secciones" className="glass fixed inset-x-0 bottom-0 z-30 flex border-x-0 border-b-0 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 md:hidden">
        {items.map((item) => {
          const active = activeView === item.view;
          return (
            <button
              key={item.view}
              className={`focus-ring flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-0.5 text-[11px] font-semibold transition-colors ${active ? "bg-acid text-deep" : "text-ink-60"}`}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              onClick={() => onChange(item.view)}
            >
              {item.icon}
              <span className="w-full truncate text-center leading-tight">{item.short ?? item.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

const ORDER_TRANSITION_FIELDS = ["status", "addressRisk", "driverId", "geoProvider", "normalizedAddress", "callOutcome", "callNote", "scheduledDate", "scheduledWindow", "rescheduledDate", "rescheduledWindow", "pickupBatchId", "pickedUpAt"] as const;

// Diferencia solo los campos operativos que cambiaron, para enviar un patch acotado al callable
// del servidor (que valida la transicion) en vez de reescribir el pedido completo desde el cliente.
function orderTransitionPatch(before: Order, after: Order): OrderTransitionPatch {
  const patch: Record<string, unknown> = {};
  for (const key of ORDER_TRANSITION_FIELDS) {
    const nextValue = (after as Record<string, unknown>)[key];
    if (nextValue !== (before as Record<string, unknown>)[key] && nextValue !== undefined) {
      patch[key] = nextValue;
    }
  }
  return patch as OrderTransitionPatch;
}

/** Iniciales del cliente para el avatar de la fila. */
function customerInitials(name: string) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * Fila compacta de pedido. La tienda recorre listas largas para MIRAR, no para actuar: una
 * tarjeta completa por pedido convierte 20 pedidos en 20 pantallazos. Aqui cada pedido es una
 * linea -cliente, guia, estado, valor- y al pulsar se despliega la tarjeta entera, con todas
 * sus acciones intactas. Divulgacion progresiva a nivel de lista.
 */
function OrderRow({ order, state, setState, actorProfileId }: { order: Order; state: AppState; setState: (state: AppState) => void; actorProfileId?: string }) {
  const [open, setOpen] = useState(false);
  const seller = state.sellers.find((item) => item.id === order.sellerId);
  return (
    <div className={`rounded-2xl border transition-colors ${open ? "border-white/10 bg-panel" : "border-transparent hover:bg-white/[0.03]"}`}>
      <button
        className="focus-ring grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-bold text-ink-70">
          {customerInitials(order.customerName)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{order.customerName || "Sin nombre"}</span>
          <span className="tabular block truncate text-xs text-ink-60">{order.trackingCode ?? order.shopifyOrderId}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium sm:inline-flex ${statusTone(order)}`}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
            {statusLabel(order.status)}
          </span>
          <span className="tabular text-sm font-bold">{formatCop(order.totalCop)}</span>
          <ChevronRight className={`text-ink-60 transition-transform ${open ? "rotate-90" : ""}`} size={15} />
        </span>
      </button>
      {/* Estado en su propia linea cuando no cabe al lado del valor. */}
      <div className="px-3 pb-2 sm:hidden">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(order)}`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
          {statusLabel(order.status)}
        </span>
      </div>
      {open && (
        <div className="p-2 pt-0">
          <OrderCard order={order} state={state} setState={setState} actorProfileId={actorProfileId} />
        </div>
      )}
    </div>
  );
}

function OrderCard({
  order,
  state,
  setState,
  actorProfileId,
  compact = false
}: {
  order: Order;
  state: AppState;
  setState: (state: AppState) => void;
  actorProfileId?: string;
  compact?: boolean;
}) {
  const seller = state.sellers.find((item) => item.id === order.sellerId);
  const driver = state.drivers.find((item) => item.id === order.driverId);
  const messenger = state.messengers.find((item) => item.id === order.messengerId);
  const defaultDriver = state.drivers.find((item) => item.active) ?? state.drivers[0];
  const nextStep = getNextOrderStep(order);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionPlan, setCorrectionPlan] = useState<OrderCorrectionPlan | null>(null);
  const [correctionPlanHash, setCorrectionPlanHash] = useState("");
  const [correctionPlanBusy, setCorrectionPlanBusy] = useState(false);
  const [correctionApplyBusy, setCorrectionApplyBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const closedForCancel = ["delivered", "failed", "cancelled", "liquidated"].includes(order.status);
  const collectedForSellerCancel = ["call_pending", "scheduled", "pickup_pending", "picked_up", "in_route", "retry_pending"].includes(order.status);
  const waitingForMessengerAssignment = state.activeRole === "driver" && order.status === "picked_up" && !order.messengerId;
  const canConfirmImported = order.status === "imported" && (
    state.activeRole === "admin" ||
    state.activeRole === "seller" ||
    Boolean(actorProfileId && order.sellerId === actorProfileId)
  );
  const canCancelOrder =
    !closedForCancel &&
    (state.activeRole === "admin" || (state.activeRole === "seller" && actorProfileId === order.sellerId && !collectedForSellerCancel));
  const canAdjustOrder = state.activeRole === "admin" && !closedForCancel;
  const canConfirmRetry =
    order.status === "failed" &&
    (state.activeRole === "admin" || (state.activeRole === "seller" && actorProfileId === order.sellerId));
  const canPrintLabel =
    state.activeRole === "admin"
      ? canPrintAdminLabel(order)
      : state.activeRole === "seller" || actorProfileId
        ? canPrintSellerLabel(order, actorProfileId)
        : false;
  const showUnprintedBadge = shouldShowUnprintedLabelBadge(order, state.activeRole === "seller" ? "seller" : "admin", actorProfileId);
  const commitOrderState = (nextState: AppState) => {
    setState(nextState);
    const updatedOrder = nextState.orders.find((item) => item.id === order.id);
    if (!updatedOrder) return;
    if (firebaseEnabled()) {
      // Las transiciones operativas van por un callable del servidor que valida el estado real
      // (optimistic concurrency) y audita. Asi el cliente ya no puede "pisar" un pedido con
      // estado viejo en cache. La UI se actualiza optimista; si el servidor rechaza, se registra.
      const patch = orderTransitionPatch(order, updatedOrder);
      if (Object.keys(patch).length === 0) return;
      void applyFirebaseOrderTransition({ orderId: order.id, expectedStatus: order.status, patch }).catch((error) => {
        console.error("No se pudo aplicar la transicion del pedido (posible estado desactualizado).", error);
      });
      return;
    }
    // Modo local (sin Firebase): persistencia directa.
    void saveFirestoreOrder(updatedOrder);
    if (updatedOrder.status === "delivered" || updatedOrder.status === "failed") {
      void saveFirestoreWalletEntries(entriesForClosedOrder(updatedOrder, nextState));
    }
  };
  const commitClosedOrder = (updatedOrder: Order, walletEntries: WalletEntry[]) => {
    setState({
      ...state,
      orders: state.orders.map((item) => (item.id === updatedOrder.id ? updatedOrder : item)),
      wallet: [...walletEntries, ...state.wallet.filter((entry) => !walletEntries.some((nextEntry) => nextEntry.id === entry.id))]
    });
  };
  // Complemento EXACTO de `closedForCancel` menos `liquidated`: la correccion solo tiene
  // sentido sobre los estados que ese gate apaga. Son gates opuestos a proposito; no los
  // unifiques, o arreglar uno rompe el otro.
  const canCorrectOrder = state.activeRole === "admin" && ["delivered", "failed", "cancelled"].includes(order.status);
  const correctionExpectedStatus = order.status as "delivered" | "failed" | "cancelled";
  const closeCorrection = () => {
    setCorrectionOpen(false);
    setCorrectionPlan(null);
    setCorrectionPlanHash("");
    setCorrectionError("");
  };
  const requestCorrectionPlan = async (input: CorrectionFormInput) => {
    setCorrectionPlanBusy(true);
    setCorrectionError("");
    try {
      const result = await correctFirebaseOrderStatus({ ...input, orderId: order.id, expectedStatus: correctionExpectedStatus, dryRun: true });
      setCorrectionPlan(result.plan);
      setCorrectionPlanHash(result.planHash);
    } catch (reason) {
      setCorrectionError(reason instanceof Error ? reason.message : "No se pudo calcular la correccion.");
    } finally {
      setCorrectionPlanBusy(false);
    }
  };
  const applyCorrection = async (input: CorrectionFormInput) => {
    setCorrectionApplyBusy(true);
    setCorrectionError("");
    try {
      const result = await correctFirebaseOrderStatus({
        ...input,
        orderId: order.id,
        expectedStatus: correctionExpectedStatus,
        dryRun: false,
        expectedPlanHash: correctionPlanHash
      });
      // mergeWalletEntries no sabe borrar: hay que filtrar los eliminados ANTES de mezclar,
      // o los asientos revertidos siguen sumando en la wallet hasta el proximo refresco.
      const deleted = new Set(result.deletedWalletEntryIds ?? []);
      const nextSettlements = result.settlements ?? [];
      setState({
        ...state,
        orders: result.order ? state.orders.map((item) => (item.id === result.order!.id ? result.order! : item)) : state.orders,
        wallet: mergeWalletEntries(state.wallet.filter((entry) => !deleted.has(entry.id)), result.walletEntries ?? []),
        settlements: state.settlements.map((item) => nextSettlements.find((next) => next.id === item.id) ?? item)
      });
      closeCorrection();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "No se pudo aplicar la correccion.";
      // El plan caduco: los datos cambiaron entre previsualizar y confirmar. Se vuelve a la
      // fase de configuracion en vez de dejar al admin confirmando algo que ya no aplica.
      if (message.includes("plan_stale")) {
        setCorrectionPlan(null);
        setCorrectionPlanHash("");
        setCorrectionError("Los datos cambiaron desde la previsualizacion. Vuelve a previsualizar.");
      } else {
        setCorrectionError(message);
      }
    } finally {
      setCorrectionApplyBusy(false);
    }
  };
  const cancelOrderFromCard = async () => {
    const code = order.trackingCode ?? order.shopifyOrderId;
    if (!window.confirm(`Anular pedido ${code}? El pedido dejara de aparecer en la operacion logistica.`)) return;
    setCancelBusy(true);
    setCancelError("");
    try {
      const result = await cancelFirebaseOrder({ orderId: order.id, reason: `Anulado desde ${roleLabel(state.activeRole)}` });
      setState({
        ...state,
        orders: state.orders.map((item) => (item.id === result.order.id ? result.order : item))
      });
    } catch (reason) {
      setCancelError(reason instanceof Error ? reason.message : "No se pudo anular el pedido.");
    } finally {
      setCancelBusy(false);
    }
  };
  const confirmImported = async () => {
    const result = await confirmFirebaseImportedOrder(order.id);
    setState({
      ...state,
      orders: state.orders.map((item) => (item.id === result.order.id ? result.order : item))
    });
  };
  const confirmRetry = async () => {
    if (firebaseEnabled()) {
      const result = await confirmFirebaseRetryOrder(order.id);
      setState({
        ...state,
        orders: state.orders.map((item) => (item.id === result.order.id ? result.order : item))
      });
      return;
    }
    const now = new Date().toISOString();
    const updatedOrder: Order = {
      ...order,
      status: order.addressRisk === "review" ? "address_risk" : "ready_to_assign",
      driverId: undefined,
      messengerId: undefined,
      pickupBatchId: undefined,
      callOutcome: "pending",
      retryDecision: "retry",
      updatedAt: now
    };
    setState({
      ...state,
      orders: state.orders.map((item) => (item.id === order.id ? updatedOrder : item))
    });
  };

    // El lider recorre 108 pedidos: en la lista solo va lo que necesita para decidir, y el resto
  // se despliega. Antes la tarjeta pintaba 24 campos con el mismo peso visual.
  const [showDetail, setShowDetail] = useState(false);

return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{order.trackingCode ?? order.shopifyOrderId}</h3>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(order)}`}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />{statusLabel(order.status)}</span>
            {order.labelPrintedAt ? (
              <span className="rounded bg-mint/10 px-2 py-1 text-xs font-semibold text-mint">rotulo impreso</span>
            ) : (
              showUnprintedBadge && <span className="rounded bg-rust/10 px-2 py-1 text-xs font-semibold text-rust">sin rotulo</span>
            )}
            {order.addressRisk === "review" && (
              <span className="rounded bg-rust/10 px-2 py-1 text-xs font-semibold text-rust">direccion en riesgo</span>
            )}
          </div>
          <p className="truncate text-sm text-ink-70">{seller?.name} · {order.customerName}</p>
        </div>
        <p className="shrink-0 text-right text-sm font-bold"><span className="tabular">{formatCop(order.totalCop)}</span></p>
      </div>

      <div className="grid gap-1 text-xs text-ink-70">
        {/* PRIMARIO: lo que hace falta para decidir sobre este pedido de un vistazo. */}
        <p className="flex min-w-0 gap-2"><MapPin className="shrink-0" size={14} /> <span className="truncate">{order.normalizedAddress ?? order.addressRaw}</span></p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1"><Truck size={14} /> {messenger ? messenger.name : driver?.name ?? "Sin asignar"}</span>
          <a className="focus-ring inline-flex items-center gap-1 rounded-full text-acid" href={`tel:${order.customerPhone}`}><Phone size={14} /> {order.customerPhone}</a>
        </div>

        <button
          className="focus-ring mt-0.5 inline-flex w-fit items-center gap-1 rounded-full text-[11px] font-semibold text-ink-60 transition-colors hover:text-fg"
          type="button"
          aria-expanded={showDetail}
          onClick={() => setShowDetail((current) => !current)}
        >
          {showDetail ? "Ocultar detalle" : "Ver detalle"}
          <ChevronRight className={`transition-transform ${showDetail ? "rotate-90" : ""}`} size={13} />
        </button>

        {/* SECUNDARIO: util cuando ya elegiste el pedido, ruido mientras lo buscas. */}
        {showDetail && (
          <div className="grid gap-1 border-t border-white/[0.06] pt-1.5">
            <p className="text-[11px] text-ink-60">Ref {order.shopifyOrderId} · Creado {formatDateTime(order.createdAt)}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <span>{order.paymentMethod.toUpperCase()}</span>
              <span>{order.fulfillmentMode === "warehouse" ? "Bodega" : "Recogida vendedor"}</span>
              {messenger && driver && <span>Lider: {driver.name}</span>}
            </div>
            {(order.pickupPointName || order.pickupAddress) && (
              <p className="flex gap-2"><Store size={14} /> Recoge en: {[order.pickupPointName, order.pickupAddress].filter(Boolean).join(" · ")}</p>
            )}
        {(order.productName || order.sku || order.quantity) && (
          <div className="flex min-w-0 flex-wrap gap-2">
            <Boxes className="shrink-0" size={14} />
            {order.lineItems && order.lineItems.length > 1 ? (
              // Multi-linea: un chip por producto en vez del string colapsado, que se trunca.
              order.lineItems.map((line, index) => (
                <span key={`${line.sku ?? line.productName ?? "linea"}-${index}`} className="rounded bg-panel px-2 py-0.5 font-semibold text-fg">
                  {line.productName ?? "Producto"} ×{line.quantity}
                </span>
              ))
            ) : (
              <>
                {order.productName && <span className="font-semibold text-fg">{order.productName}</span>}
                {order.sku && <span>SKU {order.sku}</span>}
                {order.quantity && <span className="rounded bg-panel px-2 py-0.5 font-semibold text-fg">Cant. {order.quantity}</span>}
              </>
            )}
          </div>
        )}
            {(order.scheduledDate || order.scheduledWindow) && (
              <p className="flex gap-2"><ClipboardList size={14} /> Entrega: {[order.scheduledDate, order.scheduledWindow].filter(Boolean).join(" · ")}</p>
            )}
          </div>
        )}
        {order.callOutcome === "rescheduled" && order.rescheduledDate && (
          <p className="rounded-2xl bg-rust/10 px-2 py-1 text-rust">Llamada reprogramada: {order.rescheduledDate}{order.rescheduledWindow ? ` · ${order.rescheduledWindow}` : ""}</p>
        )}
        {order.evidence.length > 0 && <EvidenceSummary evidence={order.evidence} />}
      </div>

      {!compact && (
        <div className="grid gap-2">
          {canPrintLabel && (
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold"
              type="button"
              onClick={async () => {
                const printed = await printOrderLabels([order], state, `Rotulo ${order.trackingCode ?? order.shopifyOrderId}`);
                if (printed) setState(markOrdersLabelsPrinted(state, [order], state.activeRole === "admin" ? "admin" : actorProfileId));
              }}
            >
              <Printer size={16} />
              {order.labelPrintedAt ? "Reimprimir rotulo" : "Imprimir rotulo"}
            </button>
          )}
          {canConfirmImported && (
            <ImportedOrderReviewForm order={order} state={state} setState={setState} onConfirm={() => void confirmImported()} />
          )}
          {canAdjustOrder && (
            <AdminOrderAdjustmentForm order={order} state={state} setState={setState} />
          )}
          {canConfirmRetry && (
            <PrimaryActionButton onClick={() => void confirmRetry()}>
              Confirmar nuevo reintento
            </PrimaryActionButton>
          )}
          {state.activeRole === "admin" && order.status !== "imported" && order.addressRisk === "review" && (
            <PrimaryActionButton onClick={() => commitOrderState(resolveAddress(state, order.id))}>
              Aceptar direccion y dejar listo para asignar
            </PrimaryActionButton>
          )}
          {state.activeRole === "admin" && order.status === "ready_to_assign" && !order.driverId && defaultDriver && (
            <PrimaryActionButton onClick={() => commitOrderState(assignOrder(state, order.id, defaultDriver.id))}>
              Asignar a {defaultDriver.name}
            </PrimaryActionButton>
          )}
          {state.activeRole === "admin" && order.status === "failed" && order.failedCategory === "pending_review" && (
            <PendingFailedClassification
              order={order}
              onClassified={(updated, entries) => {
                setState({
                  ...state,
                  orders: state.orders.map((item) => (item.id === updated.id ? updated : item)),
                  wallet: [...state.wallet.filter((entry) => !entries.some((added) => added.id === entry.id)), ...entries]
                });
              }}
            />
          )}
          {waitingForMessengerAssignment && (
            <PrimaryActionButton onClick={() => commitOrderState(advanceOrder(state, order.id, "call_pending"))}>
              Lo entrego yo
            </PrimaryActionButton>
          )}
          {state.activeRole !== "seller" && order.driverId && nextStep && !waitingForMessengerAssignment && (
            <PrimaryActionButton onClick={() => commitOrderState(advanceOrder(state, order.id, nextStep.status))}>
              {nextStep.label}
            </PrimaryActionButton>
          )}
          {state.activeRole !== "seller" && order.driverId && order.status === "call_pending" && (
            <CallOutcomeControls state={state} order={order} onCommit={commitOrderState} />
          )}
          {state.activeRole !== "seller" && order.driverId && ["call_pending", "scheduled", "picked_up", "in_route"].includes(order.status) && !waitingForMessengerAssignment && (
            <CloseOrderControls state={state} order={order} onCommit={commitOrderState} onServerCommit={commitClosedOrder} />
          )}
          {canCancelOrder && (
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-rust/20 bg-rust/10 px-3 py-2 text-sm font-semibold text-rust disabled:opacity-50"
              type="button"
              disabled={cancelBusy}
              onClick={() => void cancelOrderFromCard()}
            >
              <X size={16} />
              {cancelBusy ? "Anulando..." : "Anular pedido"}
            </button>
          )}
          {cancelError && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{cancelError}</p>}
          {canCorrectOrder && (
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-ink-70"
              type="button"
              onClick={() => setCorrectionOpen(true)}
            >
              <Wrench size={16} />
              Corregir estado
            </button>
          )}
        </div>
      )}
      {/* Montado solo al abrir: la vista pinta cientos de tarjetas y el plan se pide bajo demanda. */}
      {correctionOpen && (
        <AdminOrderCorrectionModal
          order={order}
          drivers={state.drivers}
          plan={correctionPlan}
          planBusy={correctionPlanBusy}
          applyBusy={correctionApplyBusy}
          error={correctionError}
          onRequestPlan={(input) => void requestCorrectionPlan(input)}
          onApply={(input) => void applyCorrection(input)}
          onDiscardPlan={() => {
            setCorrectionPlan(null);
            setCorrectionPlanHash("");
          }}
          onClose={closeCorrection}
        />
      )}
      {/* Fuera del gate `!compact`: las tarjetas compactas son las de pedidos entregados, que
          son precisamente las que se auditan despues del hecho. */}
      <OrderAuditTrail orderId={order.id} />
    </Card>
  );
}

// Etiquetas de las acciones de auditoria. El backend construye algunas dinamicamente
// (order.delivered / order.failed / order.retry_scheduled), asi que cualquier accion que no
// este aqui cae al nombre crudo en vez de quedar en blanco.
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "order.webhook_imported": "Importado por webhook",
  "order.manual_created": "Creado a mano",
  "order.imported_updated": "Editado antes de confirmar",
  "order.seller_confirmed": "Confirmado",
  "order.confirmed_uchat": "Confirmado por el bot",
  "order.transition": "Cambio de estado",
  "order.adjusted": "Ajustado",
  "order.cancelled": "Anulado",
  "order.delivered": "Entregado",
  "order.failed": "Fallido",
  "order.retry_scheduled": "Visita reagendada",
  "order.retry_confirmed": "Reintento confirmado",
  "order.failed_classified": "Fallido clasificado",
  "order.messenger_reassigned": "Mensajero reasignado",
  "order.messenger_unassigned": "Mensajero retirado",
  "order.correct_failed_to_delivered": "Corregido a entregado",
  "order.correct_delivered_to_failed": "Corregido a fallido",
  "order.correct_cancelled_to_operational": "Reactivado tras anulacion",
  "order.reopened_for_retry": "Reabierto para nueva visita",
  // Escritas por los scripts one-off que la correccion desde la UI reemplaza. Sin estas
  // etiquetas el historial de KNT-003316 / KNT-003259 / KNT-003595 sale con el nombre crudo.
  "order.correct_cancelled_to_delivered": "Corregido a entregado (script)",
  "order.correct_delivered_to_chargeable_failed": "Corregido a fallido con cobro (script)",
  "order.clawback_delivered_financials": "Reversa de entrega (script)",
  "order.correct_retry_to_failed": "Reintento cerrado como fallido (script)"
};

function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * Historial de auditoria de un pedido: quien hizo cada accion y cuando.
 *
 * Se carga bajo demanda al abrir el bloque, nunca en el render: las vistas pintan cientos de
 * tarjetas y una llamada por tarjeta hundiria la pagina.
 */
function OrderAuditTrail({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<OrderAuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || events !== null || loading) return;
    setLoading(true);
    setError("");
    try {
      setEvents(await fetchFirebaseOrderAuditTrail(orderId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el historial.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-3">
      <button
        className="focus-ring flex items-center justify-between gap-2 text-left text-sm font-semibold"
        type="button"
        onClick={() => void toggle()}
      >
        <span className="inline-flex items-center gap-2"><History size={16} /> Historial del pedido</span>
        <span className="text-xs font-semibold text-ink-60">{open ? "Ocultar" : "Ver quien hizo cada accion"}</span>
      </button>

      {open && (
        <div className="grid gap-2">
          {loading && <p className="text-xs text-ink-60">Cargando historial...</p>}
          {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{error}</p>}
          {!loading && !error && events?.length === 0 && (
            <p className="text-xs text-ink-60">Este pedido no tiene eventos de auditoria registrados.</p>
          )}
          {!loading && !error && events && events.length > 0 && (
            <ol className="grid gap-2">
              {events.map((event) => (
                <li key={event.id} className="grid gap-0.5 border-l-2 border-white/10 pl-3">
                  <p className="text-xs font-semibold text-ink-60">{formatDateTime(event.createdAt)}</p>
                  <p className="text-sm font-semibold">
                    {auditActionLabel(event.action)}
                    {event.fromStatus && event.toStatus && (
                      <span className="font-normal text-ink-60"> · {statusLabel(event.fromStatus)} → {statusLabel(event.toStatus)}</span>
                    )}
                  </p>
                  <p className="text-xs text-ink-70">
                    {event.actorLabel}
                    {event.actorEmail && event.actorEmail !== event.actorLabel && ` (${event.actorEmail})`}
                    {event.actorRole && ` · ${event.actorRole}`}
                  </p>
                  {/* Los eventos historicos no tienen fromStatus/toStatus: el summary es lo unico que los describe. */}
                  {!event.fromStatus && event.summary && <p className="text-xs text-ink-60">{event.summary}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function AdminOrderAdjustmentForm({ order, state, setState }: { order: Order; state: AppState; setState: (state: AppState) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [totalCop, setTotalCop] = useState(String(order.totalCop));
  const [productName, setProductName] = useState(order.productName ?? "");
  const [sku, setSku] = useState(order.sku ?? "");
  const [quantity, setQuantity] = useState(String(order.quantity ?? 1));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const isDirty = Number(totalCop) !== order.totalCop || productName !== (order.productName ?? "") || sku !== (order.sku ?? "") || Number(quantity) !== (order.quantity ?? 1);

  async function saveAdjustments() {
    const amount = Number(totalCop);
    const units = Number(quantity);
    if (amount <= 0 || units <= 0) {
      setMessage("Recaudo y cantidad deben ser mayores a cero.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await updateFirebaseOrderAdjustments({
        orderId: order.id,
        totalCop: amount,
        productName: productName.trim() || undefined,
        sku: sku.trim() || undefined,
        quantity: units
      });
      setState({ ...state, orders: state.orders.map((item) => (item.id === result.order.id ? result.order : item)) });
      setMessage("Recaudo y cantidad actualizados.");
      setExpanded(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar el pedido.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-field p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold">Ajuste admin</p>
          <p className="text-xs text-ink-60">Modifica producto, recaudo y cantidad antes del cierre operativo.</p>
        </div>
        <button className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-xs font-semibold" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Ocultar" : "Editar producto/recaudo"}
        </button>
      </div>
      {expanded && (
        <div className="grid gap-2">
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
            placeholder="Producto"
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
              placeholder="SKU"
              value={sku}
              onChange={(event) => setSku(event.target.value)}
            />
            <input
              className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
              inputMode="numeric"
              placeholder="Recaudo COP"
              value={totalCop}
              onChange={(event) => setTotalCop(event.target.value.replace(/[^\d]/g, ""))}
            />
            <input
              className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
              inputMode="numeric"
              placeholder="Cantidad"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.replace(/[^\d]/g, ""))}
            />
            <button
              className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
              type="button"
              disabled={busy || !isDirty}
              onClick={() => void saveAdjustments()}
            >
              {busy ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      )}
      {message && <p className="rounded-2xl bg-panel px-3 py-2 text-xs font-semibold text-ink-60">{message}</p>}
    </div>
  );
}

function EvidenceSummary({ evidence }: { evidence: Evidence[] }) {
  const latest = evidence.at(-1);
  const [expanded, setExpanded] = useState(false);
  const visibleEvidence = expanded ? [...evidence].reverse() : latest ? [latest] : [];
  if (!latest) return null;

  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-field p-2 text-xs text-fg">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-bold">
          <ImageIcon size={15} />
          <span>Novedades y evidencias</span>
        </div>
        {evidence.length > 1 && (
          <button className="focus-ring rounded px-2 py-1 font-semibold text-ink-60 hover:bg-panel" type="button" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Ver ultima" : `Ver ${evidence.length}`}
          </button>
        )}
      </div>
      <div className="grid gap-2">
        {visibleEvidence.map((item) => (
          <EvidenceItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function ImportedOrderReviewForm({ order, state, setState, onConfirm }: { order: Order; state: AppState; setState: (state: AppState) => void; onConfirm: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    addressRaw: order.addressRaw,
    normalizedAddress: order.normalizedAddress ?? "",
    zoneId: order.zoneId ?? "",
    paymentMethod: order.paymentMethod,
    fulfillmentMode: order.fulfillmentMode,
    totalCop: String(order.totalCop),
    productName: order.productName ?? "",
    sku: order.sku ?? "",
    quantity: String(order.quantity ?? 1)
  });
  const [busy, setBusy] = useState<"save" | "confirm" | null>(null);
  const [message, setMessage] = useState("");

  const update = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const canSave = Boolean(form.customerName.trim() && form.customerPhone.trim() && form.addressRaw.trim() && Number(form.totalCop) > 0);

  async function saveChanges() {
    if (!canSave) {
      setMessage("Completa cliente, telefono, direccion y valor antes de guardar.");
      return;
    }
    setBusy("save");
    setMessage("");
    try {
      const result = await updateFirebaseImportedOrder({
        orderId: order.id,
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        addressRaw: form.addressRaw,
        normalizedAddress: form.normalizedAddress || undefined,
        zoneId: form.zoneId || undefined,
        paymentMethod: form.paymentMethod as PaymentMethod,
        fulfillmentMode: form.fulfillmentMode as FulfillmentMode,
        totalCop: Number(form.totalCop),
        productName: form.productName || undefined,
        sku: form.sku || undefined,
        quantity: Number(form.quantity) > 0 ? Number(form.quantity) : undefined
      });
      setState({ ...state, orders: state.orders.map((item) => (item.id === result.order.id ? result.order : item)) });
      setMessage("Cambios guardados.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar el pedido.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmAfterSave() {
    if (!canSave) {
      setMessage("Completa cliente, telefono, direccion y valor antes de confirmar.");
      return;
    }
    setBusy("confirm");
    setMessage("");
    try {
      const result = await updateFirebaseImportedOrder({
        orderId: order.id,
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        addressRaw: form.addressRaw,
        normalizedAddress: form.normalizedAddress || undefined,
        zoneId: form.zoneId || undefined,
        paymentMethod: form.paymentMethod as PaymentMethod,
        fulfillmentMode: form.fulfillmentMode as FulfillmentMode,
        totalCop: Number(form.totalCop),
        productName: form.productName || undefined,
        sku: form.sku || undefined,
        quantity: Number(form.quantity) > 0 ? Number(form.quantity) : undefined
      });
      setState({ ...state, orders: state.orders.map((item) => (item.id === result.order.id ? result.order : item)) });
      onConfirm();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo confirmar el pedido.");
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-2 rounded-2xl border border-lime/40 bg-lime/10 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold">Revisar antes de liberar</p>
          <p className="text-xs text-ink-60">Este pedido aun no aparece para lideres logisticos.</p>
        </div>
        <button className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-xs font-semibold" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Ocultar edicion" : "Editar datos"}
        </button>
      </div>
      {expanded && (
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Cliente" value={form.customerName} onChange={(event) => update("customerName", event.target.value)} />
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Telefono" value={form.customerPhone} onChange={(event) => update("customerPhone", event.target.value)} />
          </div>
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Direccion" value={form.addressRaw} onChange={(event) => update("addressRaw", event.target.value)} />
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Direccion normalizada opcional" value={form.normalizedAddress} onChange={(event) => update("normalizedAddress", event.target.value)} />
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={form.zoneId} onChange={(event) => update("zoneId", event.target.value)}>
              <option value="">Sin zona asignada</option>
              {state.zones.filter((zone) => zone.active !== false).map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.name}</option>
              ))}
            </select>
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" inputMode="numeric" placeholder="Valor" value={form.totalCop} onChange={(event) => update("totalCop", event.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={form.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value)}>
              <option value="cod">Contraentrega</option>
              <option value="prepaid">Pagado</option>
            </select>
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={form.fulfillmentMode} onChange={(event) => update("fulfillmentMode", event.target.value)}>
              <option value="seller_pickup">Recogida vendedor</option>
              <option value="warehouse">Bodega</option>
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Producto" value={form.productName} onChange={(event) => update("productName", event.target.value)} />
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="SKU" value={form.sku} onChange={(event) => update("sku", event.target.value)} />
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" inputMode="numeric" placeholder="Cantidad" value={form.quantity} onChange={(event) => update("quantity", event.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <button className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold disabled:opacity-50" type="button" disabled={busy === "save"} onClick={() => void saveChanges()}>
            {busy === "save" ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      )}
      {message && <p className="rounded-2xl bg-panel px-3 py-2 text-xs text-ink-60">{message}</p>}
      <PrimaryActionButton onClick={() => void confirmAfterSave()}>
        {busy === "confirm" ? "Confirmando..." : "Confirmar pedido y liberar a operacion"}
      </PrimaryActionButton>
    </div>
  );
}

function EvidenceItem({ item }: { item: Evidence }) {
  return (
    <div className="grid gap-2 rounded-2xl bg-panel p-2">
      <div className="flex items-start gap-2">
        {item.photoUrl ? (
          <a className="focus-ring block h-16 w-16 shrink-0 overflow-hidden rounded-full border border-white/10 bg-field" href={item.photoUrl} target="_blank" rel="noreferrer" title="Ver evidencia">
            <img className="h-full w-full object-cover" src={item.photoUrl} alt={`Evidencia ${item.photoLabel}`} loading="lazy" decoding="async" width={64} height={64} />
          </a>
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-field text-ink-60">
            <ImageIcon size={20} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-1 font-bold ${item.type === "delivery" ? "bg-acid/15 text-acid" : "bg-rust/10 text-rust"}`}>
              {item.type === "delivery" ? "Entrega" : "Novedad"}
            </span>
            {item.reason && <span className="rounded bg-field px-2 py-1 font-semibold">{item.reason}</span>}
            {item.failedCategory && <span className="rounded bg-field px-2 py-1 font-semibold">{failedCategoryLabel(item.failedCategory)}</span>}
          </div>
          <p className="mt-1 font-semibold text-ink-70">{item.photoLabel}</p>
          <p className="text-ink-60">{formatDateTime(item.createdAt)}</p>
        </div>
      </div>
      <div className="rounded-2xl border border-white/10 px-2 py-1.5">
        <p className="font-bold text-ink-60">Observacion</p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-snug text-fg">{item.note}</p>
      </div>
      {item.photoUrl ? (
        <div className="flex flex-wrap gap-2">
          <a className="focus-ring inline-flex items-center justify-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm font-semibold text-fg hover:bg-field" href={item.photoUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={15} />
            Ver imagen
          </a>
          <a className="focus-ring inline-flex items-center justify-center gap-2 rounded-full border border-white/10 px-3 py-2 text-sm font-semibold text-fg hover:bg-field" href={item.photoUrl} download={item.photoLabel} target="_blank" rel="noreferrer">
            <FileDown size={15} />
            Descargar imagen
          </a>
        </div>
      ) : (
        <p className="rounded-2xl bg-rust/10 px-2 py-1 text-rust">Esta evidencia no tiene foto cargada. Aplica para registros anteriores al nuevo flujo.</p>
      )}
    </div>
  );
}

const deliveryWindows = [
  "8:00 AM - 11:00 AM",
  "11:00 AM - 2:00 PM",
  "2:00 PM - 5:00 PM",
  "5:00 PM - 8:00 PM"
];

function quickDate(offsetDays: number) {
  return dateValue(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));
}

function isDateInputComplete(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function DateChoiceField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <label className="grid gap-1 text-xs font-semibold text-ink-60">
        {label}
        <input
          className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
          inputMode="numeric"
          pattern="\d{4}-\d{2}-\d{2}"
          placeholder="AAAA-MM-DD"
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^\d-]/g, "").slice(0, 10))}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className="focus-ring rounded-full border border-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-field" type="button" onClick={() => onChange(quickDate(0))}>Hoy</button>
        <button className="focus-ring rounded-full border border-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-field" type="button" onClick={() => onChange(quickDate(1))}>Manana</button>
        <button className="focus-ring rounded-full border border-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-field" type="button" onClick={() => onChange(quickDate(2))}>Pasado manana</button>
      </div>
    </div>
  );
}

function CloseOrderControls({
  state,
  order,
  onCommit,
  onServerCommit
}: {
  state: AppState;
  order: Order;
  onCommit: (state: AppState) => void;
  onServerCommit: (order: Order, walletEntries: WalletEntry[]) => void;
}) {
  const [mode, setMode] = useState<"delivered" | "failed" | null>(null);

  return (
    <div className="grid gap-2 border-t border-white/10 pt-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${mode === "delivered" ? "bg-acid text-deep" : "border border-mint/40 bg-panel text-fg"}`}
          type="button"
          onClick={() => setMode(mode === "delivered" ? null : "delivered")}
        >
          Cerrar entregado
        </button>
        <button
          className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${mode === "failed" ? "bg-rust text-on-danger" : "border border-rust/30 bg-panel text-rust"}`}
          type="button"
          onClick={() => setMode(mode === "failed" ? null : "failed")}
        >
          Reportar novedad
        </button>
      </div>
      {mode === "delivered" && <DeliveredEvidenceForm state={state} order={order} onCommit={onCommit} onServerCommit={onServerCommit} />}
      {mode === "failed" && <FailedEvidenceForm state={state} order={order} onCommit={onCommit} onServerCommit={onServerCommit} />}
    </div>
  );
}

function EvidenceQueuePanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [items, setItems] = useState<QueuedEvidence[]>([]);
  const [syncingId, setSyncingId] = useState("");
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  // El efecto de abajo se monta una sola vez (y debe: registra un listener y un intervalo), asi
  // que captura la PRIMERA instancia de processQueue. Sin estas referencias esa closure escribiria
  // con el `state` del primer render -- vacio -- y el reintento periodico borraba de la pantalla
  // los pedidos del domiciliario. La guarda de reentrada tenia el mismo problema: veia syncingId
  // siempre en "" y podia subir dos veces el mismo item.
  const stateRef = useRef(state);
  stateRef.current = state;
  const syncingRef = useRef("");

  const refresh = () => setItems(readEvidenceQueue());

  useEffect(() => {
    refresh();
    // Fotos que quedaron sin item por un cierre a medias: ocupan cuota y no las ve nadie.
    pruneOrphanPhotos();
    const onOnline = () => void processQueue();
    window.addEventListener("online", onOnline);
    const timer = window.setInterval(() => {
      if (navigator.onLine) void processQueue();
    }, 30000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
    };
  }, []);

  async function processQueue() {
    const queued = readEvidenceQueue();
    if (queued.length === 0 || syncingRef.current) return;
    // El mas antiguo primero: enqueueEvidence inserta al principio.
    const item = queued[queued.length - 1];
    syncingRef.current = item.id;
    setSyncingId(item.id);
    try {
      const dataUrl = readQueuedPhoto(item.id);
      if (!dataUrl) {
        // Foto perdida (limpieza del navegador): el item sin ella no sirve para nada.
        setItems(removeQueuedEvidence(item.id));
        return;
      }
      const file = await queuedEvidenceToFile(item, dataUrl);
      const evidence = await uploadEvidenceImage(item.orderId, file, { onProgress: setSyncProgress });
      const result = await closeFirebaseOrder({
        orderId: item.orderId,
        outcome: item.outcome,
        note: item.note,
        photoLabel: evidence.label,
        photoUrl: evidence.url,
        storagePath: evidence.path,
        reason: item.reason,
        failedCategory: item.failedCategory,
        scheduledDate: item.scheduledDate,
        scheduledWindow: item.scheduledWindow
      });
      const remaining = removeQueuedEvidence(item.id);
      const current = stateRef.current;
      setState({
        ...current,
        orders: current.orders.map((order) => (order.id === result.order.id ? result.order : order)),
        wallet: [...result.walletEntries, ...current.wallet.filter((entry) => !result.walletEntries.some((nextEntry) => nextEntry.id === entry.id))]
      });
      setItems(remaining);
    } catch (error) {
      setItems(markQueuedEvidenceError(item.id, readableError(error, "No se pudo sincronizar.")));
    } finally {
      syncingRef.current = "";
      setSyncingId("");
      setSyncProgress(null);
    }
  }

  if (items.length === 0) return null;
  return (
    <Card className="grid gap-2 border-rust/20">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-bold">Evidencias pendientes</h2>
          <p className="text-sm text-ink-60">Se guardaron en este dispositivo por baja senal y se subiran cuando haya conexion.</p>
        </div>
        <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={Boolean(syncingId)} onClick={() => void processQueue()}>
          {syncingId ? `Reintentando${syncProgress === null ? "..." : ` ${syncProgress}%`}` : "Reintentar"}
        </button>
      </div>
      {items.map((item) => (
        <div key={item.id} className="rounded-2xl border border-white/10 p-2 text-sm">
          <p className="font-semibold">{item.orderId} · {item.outcome === "delivered" ? "Entrega" : "Novedad"}</p>
          <p className="text-xs text-ink-60">{item.fileName} · {formatDateTime(item.createdAt)}</p>
          {item.error && <p className="text-xs font-semibold text-rust">{item.error}</p>}
        </div>
      ))}
    </Card>
  );
}
type EvidenceUploadStatus = "idle" | "preparing" | "uploading" | "ready" | "error";

/**
 * Comprime y sube la foto MIENTRAS el usuario escribe la observacion.
 *
 * Antes todo arrancaba en el submit y en serie: refresco de token, compresion, subida,
 * `getDownloadURL` y la callable, con el boton bloqueado de punta a punta. El domiciliario tarda
 * entre 20 y 60 s en llenar el motivo y la observacion, y ese tiempo estaba muerto. Ahora al elegir
 * la foto se prepara y se sube; al confirmar solo queda esperar la callable.
 *
 * Efecto lateral asumido: si el usuario elige foto y abandona el formulario, queda un JPEG (~200 KB)
 * huerfano en `evidence/{orderId}/`; `closeOrder` solo registra el que se le pasa. Reemplazar la
 * foto SI aborta la subida anterior, que es el caso frecuente (repetir la toma).
 */
function useEvidenceUpload(orderId: string) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<EvidenceUploadStatus>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const preparedRef = useRef<File | null>(null);
  const uploadRef = useRef<Promise<Awaited<ReturnType<typeof uploadEvidenceImage>>> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<string | null>(null);
  const failedRef = useRef(false);

  const discard = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    uploadRef.current = null;
    preparedRef.current = null;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    failedRef.current = false;
  };

  // Sin esto, salir de la tarjeta con una foto cargada filtra el objectURL en cada pedido.
  useEffect(() => () => discard(), []);

  const start = (nextFile: File) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("preparing");
    setProgress(null);
    failedRef.current = false;
    const task = (async () => {
      const prepared = await prepareEvidenceImage(nextFile);
      preparedRef.current = prepared;
      if (controller.signal.aborted) throw new Error("Subida cancelada.");
      setStatus("uploading");
      const evidence = await uploadEvidenceImage(orderId, prepared, {
        onProgress: (percent) => {
          if (!controller.signal.aborted) setProgress(percent);
        },
        signal: controller.signal
      });
      if (!controller.signal.aborted) setStatus("ready");
      return evidence;
    })();
    // La promesa se consume en el submit; aqui solo se marca el estado para el rotulo.
    task.catch(() => {
      if (controller.signal.aborted) return;
      failedRef.current = true;
      setStatus("error");
    });
    uploadRef.current = task;
    return task;
  };

  const selectFile = (nextFile: File | null) => {
    discard();
    setFile(nextFile);
    if (!nextFile) {
      setPreviewUrl(null);
      setStatus("idle");
      setProgress(null);
      return;
    }
    // El preview sale ANTES de comprimir: el domiciliario ve que la foto quedo bien de inmediato.
    const url = URL.createObjectURL(nextFile);
    previewRef.current = url;
    setPreviewUrl(url);
    void start(nextFile);
  };

  /**
   * Lo que espera el submit: la subida en curso, o una nueva si la anterior fallo.
   *
   * El reintento importa: el adelanto puede haber fallado por un bache de senal mientras el
   * usuario escribia. Mandarlo a la cola sin volver a intentarlo aplazaria media hora un cierre
   * que ahora mismo si pasa.
   */
  const ready = () => {
    if (!file) return Promise.reject(new Error("Falta la foto de evidencia."));
    if (!uploadRef.current || failedRef.current) return start(file);
    return uploadRef.current;
  };

  const reset = () => {
    discard();
    setFile(null);
    setPreviewUrl(null);
    setStatus("idle");
    setProgress(null);
  };

  return { file, previewUrl, status, progress, selectFile, ready, reset, preparedFile: preparedRef };
}

function evidenceStatusLabel(status: EvidenceUploadStatus, progress: number | null) {
  if (status === "preparing") return "Preparando foto...";
  if (status === "uploading") return `Subiendo ${progress ?? 0}%`;
  if (status === "ready") return "Foto lista";
  if (status === "error") return "Se subira al confirmar";
  return "";
}

function submitLabel(status: EvidenceUploadStatus, progress: number | null, fallback: string) {
  if (status === "uploading") return `Subiendo evidencia ${progress ?? 0}%`;
  if (status === "preparing") return "Preparando foto...";
  // Con la foto ya arriba lo unico que falta es el cierre en el servidor: decirlo evita el
  // "100%" clavado que hacia pensar que la app estaba colgada.
  return fallback;
}

function EvidenceInput({
  file,
  previewUrl,
  statusLabel,
  note,
  disabled,
  onFileChange,
  onNoteChange
}: {
  file: File | null;
  previewUrl: string | null;
  statusLabel: string;
  note: string;
  disabled: boolean;
  onFileChange: (file: File | null) => void;
  onNoteChange: (note: string) => void;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <div className="grid gap-2">
        <span className="text-xs font-semibold text-ink-60">Foto de evidencia</span>
        {/* `capture="environment"` abre la camara trasera directo, sin pasar por el selector de
            apps. La galeria queda en la entrada secundaria para la foto tomada momentos antes. */}
        <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={(event) => onFileChange(event.target.files?.[0] ?? null)} />
        <input ref={galleryRef} className="hidden" type="file" accept="image/*" onChange={(event) => onFileChange(event.target.files?.[0] ?? null)} />
        <div className="flex items-center gap-2">
          {previewUrl && (
            <img className="h-16 w-16 shrink-0 rounded-2xl object-cover" src={previewUrl} alt="Vista previa de la evidencia" width={64} height={64} />
          )}
          <div className="grid flex-1 gap-1">
            <button
              className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
              type="button"
              disabled={disabled}
              onClick={() => cameraRef.current?.click()}
            >
              {file ? "Repetir foto" : "Tomar foto"}
            </button>
            <button
              className="focus-ring rounded-full px-3 py-1 text-xs font-semibold text-ink-60 underline disabled:cursor-not-allowed"
              type="button"
              disabled={disabled}
              onClick={() => galleryRef.current?.click()}
            >
              Elegir de galeria
            </button>
          </div>
        </div>
        {file && <span className="text-xs text-ink-60">{file.name}{statusLabel && ` · ${statusLabel}`}</span>}
      </div>
      <label className="grid gap-1 text-xs font-semibold text-ink-60">
        Observacion
        <textarea
          className="focus-ring min-h-20 rounded-2xl border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          required
          placeholder="Describe que se valido en la entrega."
        />
      </label>
    </>
  );
}

function DeliveredEvidenceForm({
  state,
  order,
  onCommit,
  onServerCommit
}: {
  state: AppState;
  order: Order;
  onCommit: (state: AppState) => void;
  onServerCommit: (order: Order, walletEntries: WalletEntry[]) => void;
}) {
  const upload = useEvidenceUpload(order.id);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { file } = upload;

  return (
    <form
      className="grid gap-2 rounded-2xl border border-mint/30 bg-panel p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file || !note.trim()) return;
        setSubmitting(true);
        setError(null);
        void (async () => {
          let evidence: Awaited<ReturnType<typeof uploadEvidenceImage>>;
          try {
            evidence = await upload.ready();
          } catch (uploadError) {
            if (firebaseEnabled() && shouldQueueEvidence(uploadError)) {
              // Ya comprimida: encolar el original volveria a decodificar la foto entera.
              await enqueueEvidence({ orderId: order.id, outcome: "delivered", note, file: upload.preparedFile.current ?? file });
              setError("No hubo senal suficiente. La evidencia quedo en cola y se reintentara automaticamente.");
              return;
            }
            setError(readableError(uploadError, "No se pudo subir la evidencia."));
            return;
          }

          try {
            const payload = {
              note,
              photoLabel: evidence.label,
              photoUrl: evidence.url,
              storagePath: evidence.path
            };
            if (firebaseEnabled()) {
              const result = await closeFirebaseOrder({ orderId: order.id, outcome: "delivered", ...payload });
              onServerCommit(result.order, result.walletEntries);
            } else {
              onCommit(closeDelivered(state, order.id, payload));
            }
          } catch (closeError) {
            setError(readableError(closeError, "La evidencia subio, pero no se pudo cerrar el pedido."));
          }
        })()
          .catch((queueError: unknown) => setError(readableError(queueError, "No se pudo guardar la evidencia en cola.")))
          .finally(() => setSubmitting(false));
      }}
    >
      <div>
        <h3 className="text-sm font-bold">Confirmar entrega</h3>
        <p className="text-xs text-ink-60">Carga la foto y deja la observacion antes de cerrar el pedido.</p>
      </div>
      <EvidenceInput
        file={file}
        previewUrl={upload.previewUrl}
        statusLabel={evidenceStatusLabel(upload.status, upload.progress)}
        note={note}
        disabled={submitting}
        onFileChange={upload.selectFile}
        onNoteChange={setNote}
      />
      {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
      <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="submit" disabled={!file || !note.trim() || submitting}>
        {submitting ? submitLabel(upload.status, upload.progress, "Cerrando pedido...") : "Confirmar entregado"}
      </button>
    </form>
  );
}

function FailedEvidenceForm({
  state,
  order,
  onCommit,
  onServerCommit
}: {
  state: AppState;
  order: Order;
  onCommit: (state: AppState) => void;
  onServerCommit: (order: Order, walletEntries: WalletEntry[]) => void;
}) {
  const upload = useEvidenceUpload(order.id);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [failedCategory, setFailedCategory] = useState<FailedCategory | "">("");
  const [scheduledDate, setScheduledDate] = useState(order.scheduledDate ?? "");
  const [scheduledWindow, setScheduledWindow] = useState(order.scheduledWindow ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { file } = upload;
  const isVisitRescheduled = reason === "Cliente reagenda visita";
  const selectedFailedCategory = failedCategory || undefined;
  const canSubmit = Boolean(file && note.trim() && reason && (isVisitRescheduled || selectedFailedCategory) && (!isVisitRescheduled || (isDateInputComplete(scheduledDate) && scheduledWindow)));

  return (
    <form
      className="grid gap-2 rounded-2xl border border-rust/20 bg-panel p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file || !canSubmit) return;
        setSubmitting(true);
        setError(null);
        void (async () => {
          let evidence: Awaited<ReturnType<typeof uploadEvidenceImage>>;
          try {
            evidence = await upload.ready();
          } catch (uploadError) {
            if (firebaseEnabled() && shouldQueueEvidence(uploadError)) {
              await enqueueEvidence({
                orderId: order.id,
                outcome: "failed",
                note,
                reason,
                failedCategory: isVisitRescheduled ? undefined : selectedFailedCategory,
                scheduledDate: isVisitRescheduled ? scheduledDate : undefined,
                scheduledWindow: isVisitRescheduled ? scheduledWindow : undefined,
                file: upload.preparedFile.current ?? file
              });
              setError("No hubo senal suficiente. La evidencia quedo en cola y se reintentara automaticamente.");
              return;
            }
            setError(readableError(uploadError, "No se pudo subir la evidencia."));
            return;
          }

          try {
            const payload = {
              reason,
              failedCategory: isVisitRescheduled ? undefined : selectedFailedCategory,
              note,
              photoLabel: evidence.label,
              photoUrl: evidence.url,
              storagePath: evidence.path,
              scheduledDate: isVisitRescheduled ? scheduledDate : undefined,
              scheduledWindow: isVisitRescheduled ? scheduledWindow : undefined
            };
            if (firebaseEnabled()) {
              const result = await closeFirebaseOrder({ orderId: order.id, outcome: "failed", ...payload });
              onServerCommit(result.order, result.walletEntries);
            } else {
              onCommit(closeFailed(state, order.id, payload));
            }
          } catch (closeError) {
            setError(readableError(closeError, "La evidencia subio, pero no se pudo cerrar el pedido."));
          }
        })()
          .catch((queueError: unknown) => setError(readableError(queueError, "No se pudo guardar la evidencia en cola.")))
          .finally(() => setSubmitting(false));
      }}
    >
      <div>
        <h3 className="text-sm font-bold text-rust">Reportar novedad de entrega</h3>
        <p className="text-xs text-ink-60">Selecciona el motivo, carga evidencia y deja una observacion clara.</p>
      </div>
      <label className="grid gap-1 text-xs font-semibold text-ink-60">
        Motivo
        <select className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg" value={reason} onChange={(event) => setReason(event.target.value)} required>
          <option value="">Seleccionar motivo</option>
          <option value="Cliente no recibe">Cliente no recibe</option>
          <option value="Cliente no responde">Cliente no responde</option>
          <option value="Direccion incorrecta">Direccion incorrecta</option>
          <option value="Cliente reagenda visita">Cliente reagenda visita</option>
          <option value="Otro">Otro</option>
        </select>
      </label>
      {!isVisitRescheduled && (
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Clasificacion
          <select className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg" value={failedCategory} onChange={(event) => setFailedCategory(event.target.value as FailedCategory | "")} required>
            <option value="">Seleccionar clasificacion</option>
            {failedCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {selectedFailedCategory && <span className="text-xs text-ink-60">{failedCategoryHint(selectedFailedCategory)}</span>}
        </label>
      )}
      {isVisitRescheduled && (
        <div className="grid gap-2 rounded-2xl bg-field p-3">
          <p className="text-xs font-semibold text-ink-60">Nueva visita de entrega</p>
          <DateChoiceField label="Fecha de nueva visita" value={scheduledDate} onChange={setScheduledDate} />
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Franja de nueva visita
            <select className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg" value={scheduledWindow} onChange={(event) => setScheduledWindow(event.target.value)} required>
              <option value="">Seleccionar franja</option>
              {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
            </select>
          </label>
        </div>
      )}
      <EvidenceInput
        file={file}
        previewUrl={upload.previewUrl}
        statusLabel={evidenceStatusLabel(upload.status, upload.progress)}
        note={note}
        disabled={submitting}
        onFileChange={upload.selectFile}
        onNoteChange={setNote}
      />
      {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
      <button className="focus-ring rounded-full bg-rust px-3 py-2 text-sm font-semibold text-on-danger disabled:opacity-50" type="submit" disabled={!canSubmit || submitting}>
        {submitting ? submitLabel(upload.status, upload.progress, "Cerrando pedido...") : isVisitRescheduled ? "Guardar visita reagendada" : "Marcar como fallido"}
      </button>
    </form>
  );
}

function PrimaryActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep" type="button" onClick={onClick}>
      {children}
    </button>
  );
}

// Un fallido "Pendiente revisar" no genera cobro hasta clasificarlo, y hasta ahora no
// existia forma de hacerlo desde la app: el callable estaba desplegado pero sin UI, asi
// que esos pedidos quedaban sin cobrar indefinidamente.
function PendingFailedClassification({ order, onClassified }: { order: Order; onClassified: (order: Order, entries: WalletEntry[]) => void }) {
  const [category, setCategory] = useState<FailedCategory>("failed_visit");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function classify() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await classifyFirebaseFailedOrder({ orderId: order.id, failedCategory: category });
      onClassified(result.order, result.walletEntries ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo clasificar el fallido.");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-2xl border border-rust/20 bg-rust/5 p-3">
      <div>
        <h3 className="text-sm font-bold text-rust">Fallido pendiente de clasificar</h3>
        <p className="text-xs text-ink-60">Sin clasificar no se cobra a la tienda ni se paga al domiciliario.</p>
      </div>
      <select
        className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm"
        value={category}
        onChange={(event) => setCategory(event.target.value as FailedCategory)}
      >
        {failedCategoryOptions
          .filter((option) => option.value !== "pending_review")
          .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <p className="text-xs text-ink-60">{failedCategoryHint(category)}</p>
      {message && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{message}</p>}
      <button
        className="focus-ring min-h-10 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
        type="button"
        disabled={busy}
        onClick={() => void classify()}
      >
        {busy ? "Clasificando..." : "Confirmar clasificacion"}
      </button>
    </div>
  );
}

/** Nombres legibles de los tipos de asiento. Solo se usan en la previsualizacion de una
 *  correccion: en el resto de la app los movimientos se agrupan, no se listan uno a uno. */
const correctionEntryLabels: Record<string, string> = {
  cod_revenue: "Recaudo COD",
  cod_remittance: "Reversa de recaudo",
  delivery_fee: "Flete de entrega",
  failed_fee: "Cobro por fallido",
  fulfillment_fee: "Fulfillment desde bodega",
  product_cost: "Costo de producto",
  driver_earning: "Pago al domiciliario",
  platform_margin: "Margen de plataforma",
  cash_shortage: "Faltante de recaudo",
  seller_abono: "Abono a la tienda",
  gmf_tax: "4x1000",
  community_cashback: "Cashback lider de comunidad"
};

function correctionEntryLabel(type: string) {
  return correctionEntryLabels[type] ?? type.replaceAll("_", " ");
}

/** Estados operativos a los que puede volver un pedido anulado. Debe coincidir con
 *  OPERATIONAL_TARGET_STATUSES del backend (functions/src/orders.ts); si divergen, el
 *  callable rechaza la opcion con un error de validacion. */
const correctionTargetStatuses: Array<Order["status"]> = [
  "address_risk",
  "ready_to_assign",
  "assigned",
  "call_pending",
  "scheduled",
  "picked_up",
  "in_route",
  "retry_pending"
];

type CorrectionFormInput = {
  kind: OrderCorrectionKind;
  reason: string;
  driverId?: string;
  failedCategory?: FailedCategory;
  targetStatus?: Order["status"];
  scheduledDate?: string;
  scheduledWindow?: string;
};

function CorrectionEntryRow({ entry, note }: { entry: WalletEntry; note?: string }) {
  return (
    <div className="grid gap-0.5 border-b border-white/5 py-1.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-words text-xs text-ink-60">{correctionEntryLabel(entry.type)}</span>
        <span className={`tabular shrink-0 text-sm font-bold ${entry.amountCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(entry.amountCop)}</span>
      </div>
      <span className="break-all text-[11px] text-ink-70">{note ?? entry.id}</span>
    </div>
  );
}

function CorrectionEntryGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 rounded-2xl border border-white/10 p-3">
      <p className="text-xs font-bold uppercase text-ink-60">{title}</p>
      {hint && <p className="text-[11px] text-ink-70">{hint}</p>}
      {children}
    </div>
  );
}

/**
 * Corrige el estado de un pedido ya cerrado. Presentacional puro, como los demas modales:
 * recibe el plan y los indicadores de carga, y avisa al padre; el callable lo llama OrderCard.
 *
 * Dos fases a proposito. La primera configura, la segunda muestra lo que va a pasar con la
 * plata ANTES de tocarla. Esto reemplaza al `--apply` de los scripts que se corrian a mano:
 * el plan lo calcula el servidor con el mismo codigo que despues escribe, asi que lo que se
 * ve aqui es literalmente lo que se guarda.
 */
function AdminOrderCorrectionModal({
  order,
  drivers,
  plan,
  planBusy,
  applyBusy,
  error,
  onRequestPlan,
  onApply,
  onDiscardPlan,
  onClose
}: {
  order: Order;
  drivers: Driver[];
  plan: OrderCorrectionPlan | null;
  planBusy: boolean;
  applyBusy: boolean;
  error?: string | null;
  onRequestPlan: (input: CorrectionFormInput) => void;
  onApply: (input: CorrectionFormInput) => void;
  onDiscardPlan: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const failedKinds = order.status === "failed";
  const [kind, setKind] = useState<OrderCorrectionKind>(
    order.status === "failed" ? "failed_to_delivered" : order.status === "delivered" ? "delivered_to_failed" : "cancelled_to_operational"
  );
  const [reason, setReason] = useState("");
  const [driverId, setDriverId] = useState(order.driverId ?? "");
  const [failedCategory, setFailedCategory] = useState<FailedCategory>("failed_visit");
  const [targetStatus, setTargetStatus] = useState<Order["status"]>("ready_to_assign");
  const [scheduledDate, setScheduledDate] = useState(order.scheduledDate ?? "");
  const [scheduledWindow, setScheduledWindow] = useState(order.scheduledWindow ?? "");
  const [understood, setUnderstood] = useState(false);

  const needsDriver = kind === "failed_to_delivered";
  const needsSchedule = kind === "failed_to_retry_pending";
  const form: CorrectionFormInput = {
    kind,
    reason: reason.trim(),
    driverId: needsDriver || kind === "cancelled_to_operational" ? driverId || undefined : undefined,
    failedCategory: kind === "delivered_to_failed" ? failedCategory : undefined,
    targetStatus: kind === "cancelled_to_operational" ? targetStatus : undefined,
    scheduledDate: needsSchedule ? scheduledDate : undefined,
    scheduledWindow: needsSchedule ? scheduledWindow : undefined
  };
  const canPreview =
    reason.trim().length >= 10 &&
    (!needsDriver || Boolean(driverId)) &&
    (!needsSchedule || (isDateInputComplete(scheduledDate) && Boolean(scheduledWindow)));

  // Cualquier cambio en el formulario invalida el plan: aplicar uno que ya no corresponde a
  // lo que hay en pantalla es exactamente el fallo que la huella del servidor evita.
  function updateForm(apply: () => void) {
    apply();
    setUnderstood(false);
    if (plan) onDiscardPlan();
  }

  const blocked = Boolean(plan && plan.blockers.length > 0);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 px-4 py-6">
      <div className="grid max-h-[85vh] w-full max-w-2xl gap-4 overflow-y-auto rounded-lg bg-panel p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-bold">Corregir estado del pedido</h2>
            <p className="break-words text-sm text-ink-60">
              {order.trackingCode ?? order.shopifyOrderId} · hoy {statusLabel(order.status)}
            </p>
          </div>
          <IconButton title="Cerrar" onClick={onClose}><X size={16} /></IconButton>
        </div>

        {/* --- Fase 1: que correccion --- */}
        <div className="grid gap-3 rounded-2xl bg-field p-3">
          {failedKinds && (
            <div className="grid gap-2">
              <p className="text-xs font-bold uppercase text-ink-60">Que paso realmente</p>
              {([
                { value: "failed_to_delivered" as const, label: "Si se entrego", hint: "Cobra la entrega y el recaudo; revierte el cobro del fallido." },
                { value: "failed_to_retry_pending" as const, label: "Reabrir para nueva visita", hint: "No mueve dinero: la visita perdida se hizo y se cobra igual." }
              ]).map((option) => (
                <label
                  key={option.value}
                  className={`grid cursor-pointer gap-0.5 rounded-2xl border p-3 text-sm ${kind === option.value ? "border-acid/40 bg-acid/5" : "border-white/10"}`}
                >
                  <span className="flex items-center gap-2 font-semibold">
                    <input
                      type="radio"
                      name="correction-kind"
                      className="accent-acid"
                      checked={kind === option.value}
                      onChange={() => updateForm(() => setKind(option.value))}
                    />
                    {option.label}
                  </span>
                  <span className="pl-6 text-xs text-ink-60">{option.hint}</span>
                </label>
              ))}
            </div>
          )}

          {needsDriver && (
            <label className="grid gap-1 text-xs font-semibold text-ink-60">
              Quien hizo la entrega
              <select
                className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                value={driverId}
                onChange={(event) => updateForm(() => setDriverId(event.target.value))}
              >
                <option value="">Seleccionar domiciliario</option>
                {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
              </select>
            </label>
          )}

          {kind === "delivered_to_failed" && (
            <label className="grid gap-1 text-xs font-semibold text-ink-60">
              Motivo del fallido
              <select
                className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                value={failedCategory}
                onChange={(event) => updateForm(() => setFailedCategory(event.target.value as FailedCategory))}
              >
                {failedCategoryOptions
                  .filter((option) => option.value !== "pending_review")
                  .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className="font-normal text-ink-60">{failedCategoryHint(failedCategory)}</span>
            </label>
          )}

          {kind === "cancelled_to_operational" && (
            <>
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Volver a
                <select
                  className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                  value={targetStatus}
                  onChange={(event) => updateForm(() => setTargetStatus(event.target.value as Order["status"]))}
                >
                  {correctionTargetStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Domiciliario (opcional)
                <select
                  className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                  value={driverId}
                  onChange={(event) => updateForm(() => setDriverId(event.target.value))}
                >
                  <option value="">Sin asignar</option>
                  {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                </select>
              </label>
              <p className="rounded-2xl bg-panel px-3 py-2 text-xs text-ink-60">
                Para registrar una entrega que si ocurrio: pasalo a &quot;En ruta&quot; y cierralo con evidencia
                desde la tarjeta. Asi queda la foto y la firma, no una correccion a mano.
              </p>
            </>
          )}

          {needsSchedule && (
            <div className="grid gap-2">
              <DateChoiceField label="Fecha de nueva visita" value={scheduledDate} onChange={(value) => updateForm(() => setScheduledDate(value))} />
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Franja de nueva visita
                <select
                  className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                  value={scheduledWindow}
                  onChange={(event) => updateForm(() => setScheduledWindow(event.target.value))}
                >
                  <option value="">Seleccionar franja</option>
                  {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
                </select>
              </label>
            </div>
          )}

          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Motivo de la correccion (queda en la auditoria)
            <textarea
              className="focus-ring min-h-20 rounded-2xl border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
              placeholder="Minimo 10 caracteres. Explica que paso, para que se entienda dentro de seis meses."
              value={reason}
              onChange={(event) => updateForm(() => setReason(event.target.value))}
            />
          </label>
        </div>

        {/* --- Fase 2: que va a pasar --- */}
        {plan && (
          <div className="grid gap-3">
            <div className="rounded-2xl bg-field p-3 text-sm">
              <DetailLine label="Estado" value={`${statusLabel(plan.fromStatus)} → ${statusLabel(plan.toStatus)}`} />
              <DetailLine
                label="Neto de la tienda"
                value={`${formatCop(plan.financials.sellerNetBeforeCop)} → ${formatCop(plan.financials.sellerNetAfterCop)}`}
                tone={plan.financials.sellerDeltaCop < 0 ? "rust" : plan.financials.sellerDeltaCop > 0 ? "mint" : "ink"}
              />
              <DetailLine
                label="Neto del domiciliario"
                value={`${formatCop(plan.financials.driverNetBeforeCop)} → ${formatCop(plan.financials.driverNetAfterCop)}`}
                tone={plan.financials.driverDeltaCop < 0 ? "rust" : plan.financials.driverDeltaCop > 0 ? "mint" : "ink"}
              />
              {plan.failedAttempt !== undefined && plan.failedAttempt > 1 && (
                <DetailLine label="Queda como visita numero" value={plan.failedAttempt} />
              )}
            </div>

            {plan.entriesToDelete.length > 0 && (
              <CorrectionEntryGroup title="Se eliminan" hint="Asientos que no estaban liquidados y dejan de aplicar.">
                {plan.entriesToDelete.map((entry) => <CorrectionEntryRow key={entry.id} entry={entry} />)}
              </CorrectionEntryGroup>
            )}
            {plan.entriesToCreate.length > 0 && (
              <CorrectionEntryGroup title="Se crean">
                {plan.entriesToCreate.map((entry) => (
                  <CorrectionEntryRow key={entry.id} entry={entry} note={entry.settlementId ? `${entry.id} · entra al corte ${entry.settlementId}` : entry.id} />
                ))}
              </CorrectionEntryGroup>
            )}
            {plan.entriesToCompensate.length > 0 && (
              <CorrectionEntryGroup
                title="Se compensan sin tocar el corte"
                hint="El corte original ya se pago o se concilio; la diferencia se netea en el proximo."
              >
                {plan.entriesToCompensate.map((item) => (
                  <CorrectionEntryRow key={item.entry.id} entry={item.entry} note={`revierte ${item.sourceId} · corte ${item.frozenSettlementId}`} />
                ))}
              </CorrectionEntryGroup>
            )}
            {plan.settlementsToRecalculate.length > 0 && (
              <CorrectionEntryGroup title="Cortes que se recalculan" hint="Estan pendientes de pago, asi que se ajustan en sitio.">
                {plan.settlementsToRecalculate.map((settlement) => (
                  <div key={settlement.id} className="grid gap-0.5 border-b border-white/5 py-1.5 last:border-0">
                    <span className="break-words text-xs font-semibold">{settlement.ownerName}</span>
                    <span className="break-all text-[11px] text-ink-70">{settlement.id}</span>
                    <span className="tabular text-xs text-ink-60">
                      {settlement.before.walletEntryCount} → {settlement.after.walletEntryCount} asiento(s) ·
                      efectivo esperado {formatCop(settlement.before.cashExpectedCop ?? 0)} → {formatCop(settlement.after.cashExpectedCop ?? 0)}
                    </span>
                  </div>
                ))}
              </CorrectionEntryGroup>
            )}
            {plan.inventory.kind !== "none" && plan.inventory.movements.length > 0 && (
              <CorrectionEntryGroup title="Inventario">
                {plan.inventory.movements.map((movement) => (
                  <div key={movement.skuKey} className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5 text-xs last:border-0">
                    <span className="break-all text-ink-60">{movement.skuKey}</span>
                    <span className="tabular font-bold">
                      {plan.inventory.kind === "restore_available" ? "+" : plan.inventory.kind === "reserve" ? "reserva " : "-"}
                      {movement.quantity}
                    </span>
                  </div>
                ))}
              </CorrectionEntryGroup>
            )}

            {plan.warnings.map((note) => (
              <div key={note.code} className="rounded-2xl border border-rust/20 bg-rust/5 p-3">
                <p className="text-xs font-semibold text-rust">{note.message}</p>
              </div>
            ))}
            {plan.blockers.map((note) => (
              <div key={note.code} className="grid gap-1 rounded-2xl border border-rust/20 bg-rust/5 p-3">
                <h3 className="text-sm font-bold text-rust">No se puede aplicar</h3>
                <p className="text-xs text-ink-60">{note.message}</p>
              </div>
            ))}

            {!blocked && (
              <label className="flex cursor-pointer items-start gap-2 text-xs font-semibold">
                <input type="checkbox" className="mt-0.5 accent-acid" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
                Entiendo que esto mueve dinero real y queda registrado en la auditoria del pedido.
              </label>
            )}
          </div>
        )}

        {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <button className="focus-ring min-h-10 rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={onClose}>
            Cancelar
          </button>
          {plan ? (
            <button
              className="focus-ring min-h-10 rounded-full bg-rust px-3 py-2 text-sm font-semibold text-on-danger disabled:opacity-50"
              type="button"
              disabled={applyBusy || blocked || !understood}
              onClick={() => onApply(form)}
            >
              {applyBusy ? "Aplicando..." : "Aplicar correccion"}
            </button>
          ) : (
            <button
              className="focus-ring min-h-10 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
              type="button"
              disabled={planBusy || !canPreview}
              onClick={() => onRequestPlan(form)}
            >
              {planBusy ? "Calculando..." : "Previsualizar cambios"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CallOutcomeControls({
  state,
  order,
  onCommit
}: {
  state: AppState;
  order: Order;
  onCommit: (state: AppState) => void;
}) {
  const [scheduledWindow, setScheduledWindow] = useState(order.scheduledWindow ?? "");
  const [scheduledDate, setScheduledDate] = useState(order.scheduledDate ?? "");
  const [rescheduledDate, setRescheduledDate] = useState(order.rescheduledDate ?? "");
  const [rescheduledWindow, setRescheduledWindow] = useState(order.rescheduledWindow ?? "");
  const [mode, setMode] = useState<"confirm" | "reschedule" | null>(null);
  const canConfirm = isDateInputComplete(scheduledDate) && Boolean(scheduledWindow);
  const canReschedule = isDateInputComplete(rescheduledDate) && Boolean(rescheduledWindow);
  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-field p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <button
          className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${mode === "confirm" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
          type="button"
          onClick={() => setMode(mode === "confirm" ? null : "confirm")}
        >
          Confirmar asignacion para entrega
        </button>
        <button
          className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${mode === "reschedule" ? "bg-rust text-on-danger" : "border border-rust/30 bg-panel text-rust"}`}
          type="button"
          onClick={() => setMode(mode === "reschedule" ? null : "reschedule")}
        >
          Reprogramar llamada
        </button>
        <button
          className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg"
          type="button"
          onClick={() => onCommit(registerNoAnswerAttempt(state, order.id))}
        >
          No contesta
        </button>
      </div>
      <p className="text-xs text-ink-60">
        &quot;No contesta&quot; registra el intento y el pedido sigue en llamada pendiente. Si el numero es malo o la linea esta inactiva, usa &quot;Reportar novedad&quot; para clasificarlo.
      </p>
      {mode === "confirm" && (
        <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-3">
        <div>
          <h3 className="text-sm font-bold">Confirmar asignacion para entrega</h3>
          <p className="text-xs text-ink-60">Usa estos campos cuando el cliente ya eligio cuando recibir el pedido.</p>
        </div>
        <DateChoiceField label="Fecha de entrega" value={scheduledDate} onChange={setScheduledDate} />
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Franja de entrega
          <select className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg" value={scheduledWindow} onChange={(event) => setScheduledWindow(event.target.value)}>
            <option value="">Seleccionar franja</option>
            {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
          </select>
        </label>
        {!canConfirm && <p className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">Selecciona fecha y franja para habilitar la confirmacion.</p>}
        <button
          className="focus-ring min-h-11 w-full rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
          type="button"
          disabled={!canConfirm}
          onClick={() => onCommit(confirmDeliveryWindow(state, order.id, scheduledDate, scheduledWindow))}
        >
          Cliente confirma fecha y franja
        </button>
      </div>
      )}
      {mode === "reschedule" && (
        <div className="grid gap-2 rounded-2xl border border-rust/20 bg-panel p-3">
        <div>
          <h3 className="text-sm font-bold text-rust">Reprogramar llamada</h3>
          <p className="text-xs text-ink-60">Usa estos campos si no se pudo cerrar la entrega y hay que volver a llamar.</p>
        </div>
        <DateChoiceField label="Fecha para volver a llamar" value={rescheduledDate} onChange={setRescheduledDate} />
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Franja para volver a llamar
          <select
            className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
            value={rescheduledWindow}
            onChange={(event) => setRescheduledWindow(event.target.value)}
          >
            <option value="">Seleccionar franja</option>
            {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
          </select>
        </label>
          {!canReschedule && <p className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">Selecciona fecha y franja para reprogramar la llamada.</p>}
          <button
            className="focus-ring min-h-11 w-full rounded-full border border-rust/30 bg-panel px-3 py-2 text-sm font-semibold text-rust disabled:opacity-50"
            type="button"
            disabled={!canReschedule}
            onClick={() => onCommit(rescheduleCustomerCall(state, order.id, rescheduledDate, rescheduledWindow))}
          >
            Reprogramar llamada
          </button>
      </div>
      )}
    </div>
  );
}

function getNextOrderStep(order: Order): { status: Order["status"]; label: string } | null {
  if (!order.driverId) return null;
  if (order.status === "assigned") return { status: "call_pending", label: "Registrar llamada al cliente" };
  if (order.status === "scheduled") return { status: "picked_up", label: "Confirmar que el pedido fue recogido" };
  if (order.status === "picked_up") return { status: "in_route", label: "Iniciar ruta de entrega" };
  if (order.status === "retry_pending") return { status: "in_route", label: "Iniciar nueva visita" };
  return null;
}

function orderSearchMatches(order: Order, value: string) {
  const queryText = value.trim().toLowerCase();
  if (!queryText) return true;
  return [
    order.trackingCode,
    order.shopifyOrderId,
    order.id,
    order.customerName,
    order.customerPhone,
    order.sku,
    order.productName
  ].filter(Boolean).some((entry) => String(entry).toLowerCase().includes(queryText));
}

function extractOrderCode(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get("order")?.trim() || value.trim();
  } catch {
    return value.trim();
  }
}

function OrderLookupBar({ value, onChange, searchingHistory = false }: { value: string; onChange: (value: string) => void; searchingHistory?: boolean }) {
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopScanRef = useRef(false);

  function stopQrScan() {
    stopScanRef.current = true;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }

  async function scanQr() {
    setMessage("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Este navegador no permite abrir la camara. Escribe o pega el codigo KNT.");
      return;
    }
    try {
      stopScanRef.current = false;
      setScanning(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      const video = videoRef.current;
      if (!video) {
        setMessage("No se pudo mostrar la camara. Escribe o pega el codigo KNT.");
        stopQrScan();
        return;
      }
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        setMessage("No se pudo preparar el lector QR. Escribe o pega el codigo KNT.");
        return;
      }
      // El lector solo se carga cuando alguien abre la camara. Se resuelve ANTES del bucle: el
      // modulo queda cacheado, pero esperarlo en cada fotograma seria trabajo por gusto.
      const { default: jsQR } = await import("jsqr");
      const startedAt = Date.now();
      const scan = async (): Promise<string | null> => {
        if (stopScanRef.current) return null;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width > 0 && height > 0) {
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);
          const image = context.getImageData(0, 0, width, height);
          const code = jsQR(image.data, width, height);
          if (code?.data) return code.data;
        }
        if (Date.now() - startedAt > 12000) return null;
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        return scan();
      };
      const raw = await scan();
      if (raw) {
        onChange(extractOrderCode(raw));
        stopQrScan();
      }
      else setMessage("No se detecto QR. Acerca la camara al rotulo o escribe el codigo.");
    } catch {
      setMessage("No se pudo abrir la camara. Escribe o pega el codigo KNT.");
    } finally {
      if (!stopScanRef.current) stopQrScan();
    }
  }

  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="focus-ring min-h-10 flex-1 rounded-full border border-white/10 px-3 py-2 text-sm"
          placeholder="Buscar por KNT, # Shopify, cliente, telefono, SKU"
          value={value}
          onChange={(event) => onChange(extractOrderCode(event.target.value))}
        />
        <button className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep" type="button" onClick={() => void scanQr()}>
          <QrCode size={16} />
          Escanear QR
        </button>
        {value && (
          <button className="focus-ring min-h-10 rounded-full border border-white/10 px-3 py-2 text-sm font-semibold" type="button" onClick={() => onChange("")}>
            Limpiar
          </button>
        )}
      </div>
      {searchingHistory && <p className="text-xs text-ink-60">Buscando tambien en el historial...</p>}
      {scanning && (
        <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-2 text-fg">
          <div className="relative overflow-hidden rounded bg-black">
            <video ref={videoRef} className="h-64 w-full object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-lime" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold">Apunta la camara al QR del rotulo.</p>
            <button className="focus-ring rounded-full bg-panel px-3 py-2 text-xs font-semibold text-fg" type="button" onClick={stopQrScan}>
              Cerrar
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-xs font-semibold text-rust">{message}</p>}
    </div>
  );
}

function PickupScanModal({ state, driver, onClose, onCommit }: { state: AppState; driver: Driver; onClose: () => void; onCommit: (orders: Order[]) => void | Promise<void> }) {
  const eligibleOrders = state.orders.filter((order) =>
    (order.status === "ready_to_assign" && !order.driverId) ||
    (order.status === "assigned" && order.driverId === driver.id)
  );
  const [code, setCode] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [committing, setCommitting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopScanRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const selectedIdsRef = useRef<string[]>([]);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const selectedOrders = selectedIds.map((id) => eligibleOrders.find((order) => order.id === id)).filter(Boolean) as Order[];

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  // La pistola de codigo de barras es un teclado: escribe el codigo y manda Enter. Si el input no
  // tiene el foco, los caracteres se pierden, asi que se enfoca al abrir y se devuelve tras cada lectura.
  useEffect(() => {
    codeInputRef.current?.focus();
  }, []);

  function focusCodeInput() {
    codeInputRef.current?.focus();
  }

  function findEligibleOrder(value: string) {
    const normalizedValue = value.toLowerCase();
    return (
      eligibleOrders.find((item) =>
        [item.trackingCode, item.shopifyOrderId, item.id].filter(Boolean).some((entry) => String(entry).toLowerCase() === normalizedValue)
      ) ?? eligibleOrders.find((item) => orderSearchMatches(item, value))
    );
  }

  function addCode(rawValue: string) {
    const value = extractOrderCode(rawValue);
    focusCodeInput();
    if (!value) {
      setMessage("Escanea o escribe un codigo antes de agregar.");
      return;
    }
    const order = findEligibleOrder(value);
    if (!order) {
      setCode("");
      setMessage(`No encontre pedido disponible para ${value}.`);
      return;
    }
    if (selectedIdsRef.current.includes(order.id)) {
      setCode("");
      setMessage(`${order.trackingCode ?? order.shopifyOrderId} ya esta en la recogida.`);
      return;
    }
    setSelectedIds((current) => {
      if (current.includes(order.id)) return current;
      return [order.id, ...current];
    });
    selectedIdsRef.current = [order.id, ...selectedIdsRef.current];
    setCode("");
    setMessage(`${order.trackingCode ?? order.shopifyOrderId} agregado.`);
  }

  function stopQrScan() {
    stopScanRef.current = true;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }

  async function scanQr() {
    setMessage("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Este navegador no permite abrir la camara. Escribe o pega el codigo KNT.");
      return;
    }
    try {
      stopScanRef.current = false;
      setScanning(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      const video = videoRef.current;
      if (!video) {
        setMessage("No se pudo mostrar la camara.");
        stopQrScan();
        return;
      }
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        setMessage("No se pudo preparar el lector QR.");
        stopQrScan();
        return;
      }
      const { default: jsQR } = await import("jsqr");
      const scan = async (): Promise<void> => {
        if (stopScanRef.current) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width > 0 && height > 0) {
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);
          const image = context.getImageData(0, 0, width, height);
          const qr = jsQR(image.data, width, height);
          if (qr?.data) {
            const value = extractOrderCode(qr.data);
            const now = Date.now();
            const last = lastScanRef.current;
            if (value && (!last || last.value !== value || now - last.at > 1800)) {
              lastScanRef.current = { value, at: now };
              addCode(value);
            }
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        return scan();
      };
      await scan();
    } catch {
      setMessage("No se pudo abrir la camara.");
    } finally {
      if (!stopScanRef.current) stopQrScan();
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="grid max-h-[92vh] w-full max-w-2xl gap-3 overflow-auto rounded-lg bg-panel p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Recogida por escaneo</h2>
            <p className="text-sm text-ink-60">Deja la camara abierta y pistolea los rotulos de corrido. Se agregan a esta recogida y luego el lider decide a que mensajero asignarlos.</p>
          </div>
          <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold" type="button" onClick={() => { stopQrScan(); onClose(); }}>
            Cerrar
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            ref={codeInputRef}
            className="focus-ring min-h-10 rounded-full border border-white/10 px-3 py-2 text-sm"
            placeholder="Pistolea el rotulo, o escribe KNT / # Shopify"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addCode(code);
            }}
          />
          <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold" type="button" onClick={() => addCode(code)}>
            Agregar
          </button>
          <button
            className="focus-ring inline-flex items-center justify-center gap-2 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={scanning}
            onClick={() => void scanQr()}
          >
            <QrCode size={16} />
            {scanning ? "Escaneando" : "Escanear"}
          </button>
        </div>
        {scanning && (
          <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-2 text-fg">
            <div className="relative overflow-hidden rounded bg-black">
              <video ref={videoRef} className="h-64 w-full object-cover" muted playsInline />
              <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-lime" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Pistolea varios rotulos sin cerrar esta ventana.</p>
              <button className="focus-ring rounded-full bg-panel px-3 py-2 text-xs font-semibold text-fg" type="button" onClick={stopQrScan}>
                Cerrar camara
              </button>
            </div>
          </div>
        )}
        {message && <p className="rounded-2xl bg-field px-3 py-2 text-xs font-semibold text-ink-70">{message}</p>}
        <div className="grid gap-2">
          <p className="text-sm font-bold">Escaneados ({selectedOrders.length})</p>
          {selectedOrders.length === 0 && <p className="rounded-2xl bg-field px-3 py-2 text-sm text-ink-60">Aun no hay pedidos escaneados.</p>}
          {selectedOrders.map((order) => (
            <div key={order.id} className="flex items-start justify-between gap-3 rounded-2xl border border-white/10 p-3 text-sm">
              <div>
                <p className="font-semibold">{order.trackingCode ?? order.shopifyOrderId}</p>
                <p className="text-xs text-ink-60">{order.customerName} · {order.productName ?? order.sku}</p>
              </div>
              <button className="text-xs font-semibold text-rust" type="button" onClick={() => setSelectedIds((current) => current.filter((id) => id !== order.id))}>
                Quitar
              </button>
            </div>
          ))}
        </div>
        <button
          className="focus-ring min-h-11 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
          type="button"
          disabled={selectedOrders.length === 0 || committing}
          onClick={() => {
            setCommitting(true);
            void Promise.resolve(onCommit(selectedOrders))
              .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "No se pudo confirmar la recogida."))
              .finally(() => setCommitting(false));
          }}
        >
          {committing ? "Confirmando..." : "Terminar recogida y dejar pendiente de mensajero"}
        </button>
      </div>
    </div>
  );
}




/**
 * Tarifa vigente de la tienda, y la subida que su lider de comunidad haya programado.
 *
 * RF_28 exige que una subida se vea ANTES de aplicarse, con su fecha. Sin esta tarjeta, la
 * tienda se enteraria del precio nuevo al recibir el cobro, que es justo lo que la spec prohibe.
 */
function StoreTariffCard() {
  const [tariff, setTariff] = useState<Awaited<ReturnType<typeof fetchMyStoreTariff>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMyStoreTariff()
      .then((data) => {
        if (!cancelled) setTariff(data);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudo cargar tu tarifa.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <Card><p className="text-sm text-ink-60">Cargando tu tarifa...</p></Card>;
  if (error) return <Card><p className="text-sm text-ink-60">{error}</p></Card>;
  if (!tariff) return null;

  const labels: Record<string, string> = {
    sellerDeliveredFeeCop: "Flete por entrega",
    sellerFailedFeeCop: "Cobro por fallido",
    fulfillmentFeeCop: "Manejo desde bodega"
  };

  return (
    <Card>
      <p className="text-sm font-semibold">Tu tarifa</p>
      {tariff.communityName && <p className="mt-1 text-xs text-ink-60">Comunidad: {tariff.communityName}</p>}
      <div className="mt-3 space-y-2">
        {Object.entries(labels).map(([field, label]) => {
          const upcoming = tariff.scheduled?.[field];
          return (
            <div key={field} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm text-ink-60">{label}</span>
              <span className="tabular text-sm font-semibold">{formatCop(tariff.current[field] ?? 0)}</span>
              {upcoming && (
                <span className="w-full text-xs text-acid">
                  Sube a {formatCop(upcoming.toCop)} el {upcoming.effectiveAt.slice(0, 10)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}


/**
 * Los limites del dia en hora de Cali, en instantes UTC.
 *
 * El rango se elige con dos `input type="date"`, que dan un dia suelto sin huso. Mandarlo tal
 * cual desplazaria la contencion cinco horas: una tienda que entro a las 8 de la noche quedo
 * grabada con la fecha del dia siguiente en UTC. Se normaliza aqui, y ademas asi los dos
 * extremos viajan en `Z`, que es como estan escritas las fechas de ingreso contra las que el
 * servidor las compara.
 */
const caliDayStartIso = (date: string) => new Date(`${date}T00:00:00.000-05:00`).toISOString();
const caliDayEndIso = (date: string) => new Date(`${date}T23:59:59.999-05:00`).toISOString();

/** Como se titula el desenlace. `partial` y `none` NO se pintan como un exito. */
const BULK_DISABLE_OUTCOME_COPY: Record<BulkSignupDisableOutcome, { title: string; tone: string }> = {
  contained: { title: "Contencion completa: todos los accesos alcanzados quedaron cerrados", tone: "text-acid" },
  partial: { title: "Contencion parcial: quedan accesos abiertos", tone: "text-rust" },
  none: { title: "Ningun acceso quedo cerrado", tone: "text-rust" }
};

/**
 * Los cuatro repartos del informe, cada uno con su rotulo. El orden es el de la lectura: que
 * se cerro, que fallo, que quedo fuera del filtro y a cuantas alcanzo la operacion.
 *
 * No hay una quinta casilla con un total, y no es un olvido: "3 cerradas y 17 fallidas" NO es
 * "20 procesadas". Sumarlas es exactamente el fallo mudo que T32 cerro en el servidor, y desde
 * una pantalla se vuelve a abrir sin que nada se ponga rojo.
 */
const BULK_DISABLE_COUNT_COPY = [
  { key: "disabled", title: "Accesos cerrados", hint: "constan cerrados en la cuenta" },
  { key: "failed", title: "Fallidas", hint: "su acceso SIGUE abierto" },
  { key: "untouched", title: "Intactas", hint: "el filtro las dejo fuera" },
  { key: "blocked", title: "Alcanzadas", hint: "selladas en su ficha por el rango" }
] as const;

/**
 * El informe de una contencion, tal cual lo devolvio el servidor.
 *
 * Se pinta entero: los cuatro recuentos por separado, cada motivo con su rotulo y las tiendas
 * de cada grupo por su nombre, para que el administrador pueda ir a por las que quedaron
 * abiertas. Sin redondear y sin agrupar dos motivos bajo un mismo texto — el reparto lo hace
 * `buildBulkSignupDisableView`, que esta probado, y aqui no se recalcula nada.
 */
function BulkSignupDisableReportCard({
  view,
  sellerName
}: {
  view: BulkSignupDisableView;
  sellerName: (sellerId: string) => string;
}) {
  const outcome = BULK_DISABLE_OUTCOME_COPY[view.outcome];
  const nothingReached = view.counts.blocked === 0;

  return (
    <div className="mt-3 grid gap-3 rounded-2xl bg-panel p-3">
      <div>
        <p className={`text-sm font-semibold ${outcome.tone}`}>{outcome.title}</p>
        <p className="mt-1 text-xs text-ink-60">
          Rango consultado: {formatDateTime(view.fromIso)} — {formatDateTime(view.toIso)}
        </p>
      </div>

      {/* Los cuatro recuentos, cada uno por su lado. Aqui no se suma nada. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BULK_DISABLE_COUNT_COPY.map((count) => (
          <div key={count.key} className="rounded-2xl bg-field p-3">
            <p className={`tabular text-lg font-bold ${count.key === "failed" && view.counts.failed > 0 ? "text-rust" : ""}`}>
              {view.counts[count.key]}
            </p>
            <p className="text-xs font-semibold">{count.title}</p>
            <p className="text-xs text-ink-60">{count.hint}</p>
          </div>
        ))}
      </div>

      {nothingReached && (
        <p className="text-xs text-ink-60">
          El rango elegido no alcanzo a ninguna tienda de esta comunidad: no habia acceso que cerrar.
          Comprueba las fechas en las que estuvo circulando el enlace.
        </p>
      )}

      {view.disabled.length > 0 && (
        <div>
          <p className="text-xs font-semibold">Accesos cerrados</p>
          <ul className="mt-1 grid gap-1">
            {view.disabled.map((entry) => (
              <li key={entry.sellerId} className="text-xs text-ink-60">
                {sellerName(entry.sellerId)} · {entry.authUids.length === 1 ? "1 cuenta" : `${entry.authUids.length} cuentas`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.failures.map((group) => (
        <div key={group.reason}>
          <p className="text-xs font-semibold text-rust">
            {group.label} · <span className="tabular">{group.count}</span>
          </p>
          <ul className="mt-1 grid gap-1">
            {group.sellerIds.map((sellerId) => (
              <li key={sellerId} className="text-xs text-ink-60">{sellerName(sellerId)}</li>
            ))}
          </ul>
        </div>
      ))}

      {view.skipped.map((group) => (
        <div key={group.reason}>
          <p className="text-xs font-semibold">
            {group.label} · <span className="tabular">{group.count}</span>
          </p>
          <ul className="mt-1 grid gap-1">
            {group.sellerIds.map((sellerId) => (
              <li key={sellerId} className="text-xs text-ink-60">{sellerName(sellerId)}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * RF_14, RF_16: subir el logo de una comunidad.
 *
 * Quien lo ve lo decide `canEditCommunityBrand`, IMPORTADO del mismo modulo que usa la callable
 * (`functions/src/community-access.ts`) y no reescrito aqui como un `role === "admin"` suelto:
 * dos copias de un permiso acaban diciendo cosas distintas, y la que se ve en pantalla es la que
 * el usuario cree que manda. Por eso el permiso se comprueba DENTRO y el llamador solo pone el
 * control donde toca.
 *
 * Sale tambien cuando la comunidad no tiene logo todavia —si solo apareciera donde ya hay uno,
 * una comunidad recien creada no podria cargar el primero nunca— y sigue saliendo despues de un
 * rechazo, para poder reintentar.
 *
 * RF_16: si el logo nuevo no vale, se pinta el error CON EL LOGO ANTERIOR todavia puesto. Eso no
 * es un adorno: el estado local solo se mueve en el exito, asi que un rechazo no puede dejar a la
 * comunidad sin marca (que es como se convierte en Kentro sin que nadie se entere).
 */
function CommunityLogoControl({
  actor,
  community
}: {
  actor: Actor;
  community: { id: string; name?: string; logoPath?: string };
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!canEditCommunityBrand(actor, community.id)) return null;

  // La marca que se pinta: la recien subida si la hubo y, si no, la que ya tenia la comunidad.
  // `brandFor` es quien decide (RF_15), y ante un rechazo `uploaded` sigue nulo: el anterior.
  const brand = brandFor({ name: community.name, logoPath: uploaded ?? community.logoPath });

  const subir = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const result = await setCommunityLogo({ communityId: community.id, file });
      setUploaded(result.logoPath);
      setDone(true);
    } catch (cause) {
      // El mensaje llega TAL CUAL del servidor ("El logo supera 512 KB", "Formato no admitido...")
      // porque el limite concreto es la mitad util del aviso: sin el no se sabe que cambiar.
      setError(cause instanceof Error ? cause.message : "No se pudo cambiar el logo.");
    } finally {
      setBusy(false);
      // Permite volver a elegir EL MISMO archivo despues de un rechazo: sin esto, el `change` no
      // se dispara la segunda vez y el control parece muerto.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="mt-3 rounded-2xl bg-field p-3">
      <p className="text-sm font-semibold">Logo de la comunidad</p>
      <p className="mt-1 text-xs text-ink-60">
        Es la marca que ve quien abre el enlace de invitacion. PNG, JPG, WEBP o SVG, hasta{" "}
        {Math.round(LOGO_MAX_BYTES / 1024)} KB.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {brand.kind === "community" ? (
          // <img> y no next/image, igual que en la pantalla de registro: la URL la aporta el lider
          // y no esta en el dominio permitido de next/image, que la rechazaria en produccion.
          <img
            src={brand.logoPath}
            alt={`Logo de ${brand.name}`}
            className="h-12 w-12 shrink-0 rounded-2xl bg-panel object-contain"
          />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-panel text-center text-[10px] leading-tight text-ink-60">
            Sin logo
          </span>
        )}
        <input
          ref={fileRef}
          className="hidden"
          type="file"
          accept={LOGO_CONTENT_TYPES.join(",")}
          onChange={(event) => void subir(event.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="focus-ring rounded-full bg-acid px-4 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60"
        >
          {busy ? "Subiendo logo..." : brand.kind === "community" ? "Cambiar logo" : "Subir logo"}
        </button>
      </div>
      {error && (
        // RF_16: el error se pinta al lado del logo de siempre, que arriba sigue en pantalla.
        <p className="mt-3 rounded-2xl border border-rust/20 bg-rust/10 p-3 text-xs text-rust">
          {error} El logo anterior sigue puesto.
        </p>
      )}
      {done && !error && <p className="mt-3 text-xs text-ink-60">Logo actualizado.</p>}
    </div>
  );
}

/**
 * RF_11: a que comunidad pertenece una tienda.
 *
 * Solo el administrador (`canReassignSellerCommunity`, importado). Y es a proposito que NO se
 * agrupe con el control del logo, aunque caigan en la misma pantalla: el lider gobierna su marca
 * (RF_14) y no gobierna a que comunidad pertenece una tienda — ni la suya, que es justo quien
 * mas motivo tendria para retenerla, ni la del vecino para llevarsela. Pintar los dos bajo la
 * misma condicion le daria al lider un control que el servidor le va a negar.
 *
 * La confirmacion es explicita y dice lo que de verdad cambia: el cashback YA CAUSADO se queda
 * con el lider que lo genero (eso lo garantiza `planSellerReassignment`, no esta pantalla); lo
 * que se mueve es la tarifa de los pedidos FUTUROS de esa tienda.
 */
function SellerCommunityReassignPanel({ actor, state }: { actor: Actor; state: AppState }) {
  const [sellerId, setSellerId] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!canReassignSellerCommunity(actor)) return null;

  const seller = state.sellers.find((item) => item.id === sellerId);
  const communityName = (id?: string) =>
    id ? state.communities.find((item) => item.id === id)?.name ?? id : "sin comunidad";

  // Sin `useEffect` de sincronizacion: el destino se coloca al elegir tienda, que es el unico
  // momento en que cambia el dato de origen. Un efecto aqui solo anadiria un aviso de
  // `exhaustive-deps` y un render de mas para llegar al mismo sitio.
  const elegirTienda = (id: string) => {
    setSellerId(id);
    setTarget(state.sellers.find((item) => item.id === id)?.communityId ?? "");
    setError(null);
    setMessage(null);
  };

  const reasignar = async () => {
    if (!seller) return;
    const destino = communityName(target || undefined);
    const confirmado = window.confirm(
      `Mover la tienda ${seller.name} de ${communityName(seller.communityId)} a ${destino}?\n\n` +
        "El cashback que ya causo se queda con el lider que lo genero y no se mueve. Lo que cambia " +
        "es el precio de sus PEDIDOS FUTUROS: pasan a la tarifa de la comunidad de destino."
    );
    if (!confirmado) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await reassignSellerCommunity({ sellerId: seller.id, communityId: target || undefined });
      setMessage(
        result.changed
          ? `${seller.name} quedo en ${destino}.`
          : `${seller.name} ya estaba en ${destino}: no se cambio nada.`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo reasignar la tienda.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-white/10 p-3">
      <p className="text-sm font-semibold">Comunidad de una tienda</p>
      <p className="mt-1 text-xs text-ink-60">
        Ni la tienda ni el lider cambian esto por su cuenta. Dejar el destino en blanco la deja sin
        comunidad.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Tienda
          <select
            className="focus-ring w-full min-w-0 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
            value={sellerId}
            onChange={(event) => elegirTienda(event.target.value)}
          >
            <option value="">Selecciona la tienda</option>
            {[...state.sellers]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Comunidad de destino
          <select
            className="focus-ring w-full min-w-0 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            disabled={!seller}
          >
            <option value="">Sin comunidad</option>
            {state.communities.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {seller && (
        <p className="mt-2 text-xs text-ink-60">
          Hoy pertenece a <span className="font-semibold text-fg">{communityName(seller.communityId)}</span>.
        </p>
      )}
      <button
        type="button"
        disabled={!seller || busy}
        onClick={() => void reasignar()}
        className="focus-ring mt-3 rounded-full bg-field px-4 py-2 text-xs font-semibold disabled:opacity-50"
      >
        {busy ? "Reasignando..." : "Reasignar tienda"}
      </button>
      {error && (
        <p className="mt-3 rounded-2xl border border-rust/20 bg-rust/10 p-3 text-xs text-rust">{error}</p>
      )}
      {message && !error && <p className="mt-3 rounded-2xl bg-field p-3 text-xs text-ink-70">{message}</p>}
    </div>
  );
}

/** Los seis campos vacios. Un solo sitio: el formulario se limpia tras crear y al descartar. */
const COMMUNITY_LEADER_FORM_EMPTY: CommunityLeaderFormInput = {
  name: "",
  slug: "",
  leaderName: "",
  leaderEmail: "",
  leaderPhone: "",
  password: ""
};

/**
 * RF_50: el alta de un lider de comunidad, que hasta ahora no tenia pantalla.
 *
 * `createCommunityLeader` llevaba desplegada y con envoltorio desde el principio, pero nada la
 * llamaba: las comunidades solo podian nacer desde la consola de Firebase o un script. Esto es
 * lo unico que crea la figura, y por eso vive aqui y NO en el alta de usuarios de mas abajo: un
 * lider necesita comunidad, enlace reservado y cuenta de Auth en la misma operacion.
 *
 * Va como componente propio y hermano de `AdminCommunitiesPanel`, no dentro de el, por dos
 * razones concretas: sus `useState` no pueden quedar detras del `return` anticipado de aquel
 * panel (`react-hooks/rules-of-hooks` es error en este repo por un fallo que solo reventaba en
 * movil), y sobre todo porque aquel `return` se dispara cuando NO hay ni una comunidad — o sea,
 * el formulario se esconderia justo en el momento en que hace falta crear la primera.
 *
 * El veredicto no se improvisa aqui: lo da `validateCommunityLeaderForm`, que esta probado y usa
 * el mismo `validateSlug` que el servidor. La pantalla solo decide donde se pinta el motivo —en
 * el campo senalado, que es lo que pide RF_04— y envia lo NORMALIZADO (`res.value`), nunca lo
 * tecleado: el enlace que se ensena despues tiene que ser el que quedo guardado.
 */
function CreateCommunityLeaderForm({ communities }: { communities: Community[] }) {
  const [form, setForm] = useState<CommunityLeaderFormInput>(COMMUNITY_LEADER_FORM_EMPTY);
  const [invalid, setInvalid] = useState<{ field: keyof CommunityLeaderFormInput; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ communityId: string; slug: string } | null>(null);

  // Los nombres cortos ya tomados, para cazar el choque antes de la transaccion: el servidor lo
  // rechaza con un `already-exists` que no dice que campo hay que corregir.
  const takenSlugs = communities.flatMap((community) => (community.slug ? [community.slug] : []));

  const escribir = (field: keyof CommunityLeaderFormInput, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    // El motivo deja de ser cierto en cuanto se toca el campo que senalaba.
    setInvalid((current) => (current && current.field === field ? null : current));
  };

  const crear = async () => {
    setError(null);
    const veredicto = validateCommunityLeaderForm(form, { takenSlugs });
    if (!veredicto.ok) {
      setInvalid({ field: veredicto.field, reason: veredicto.reason });
      return;
    }
    setInvalid(null);
    setBusy(true);
    try {
      // Lo normalizado y no lo tecleado: el slug ya paso por `validateSlug` y el correo por
      // minusculas, que es exactamente con lo que el servidor va a crear la cuenta.
      const result = await createCommunityLeader(veredicto.value);
      setCreated({ communityId: result.communityId, slug: result.slug });
      setForm(COMMUNITY_LEADER_FORM_EMPTY);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo crear el lider de comunidad.");
    } finally {
      setBusy(false);
    }
  };

  const invitePath = created ? communityInvitePath({ slug: created.slug }) : null;
  const inviteUrl =
    invitePath && typeof window !== "undefined" ? `${window.location.origin}${invitePath}` : invitePath ?? "";

  const campo = (
    field: keyof CommunityLeaderFormInput,
    label: string,
    options?: { type?: string; placeholder?: string; hint?: string }
  ) => {
    const fallado = invalid?.field === field;
    return (
      <label className="grid gap-1 text-xs font-semibold text-ink-60">
        {label}
        <input
          type={options?.type ?? "text"}
          value={form[field]}
          placeholder={options?.placeholder}
          aria-invalid={fallado}
          onChange={(event) => escribir(field, event.target.value)}
          className={`focus-ring rounded-full border bg-panel px-3 py-2 text-sm font-normal text-fg ${
            fallado ? "border-rust/40" : "border-white/10"
          }`}
        />
        {fallado ? (
          <span className="px-1 text-xs font-normal text-rust">{invalid?.reason}</span>
        ) : options?.hint ? (
          <span className="px-1 text-xs font-normal text-ink-60">{options.hint}</span>
        ) : null}
      </label>
    );
  };

  return (
    <Card>
      <h2 className="font-bold">Crear lider de comunidad</h2>
      <p className="mt-1 text-sm text-ink-60">
        Crea la comunidad, reserva su enlace de invitacion y abre la cuenta del lider en una sola
        operacion. Las tiendas que se registren por ese enlace quedan adscritas a el.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {campo("name", "Nombre de la comunidad", { placeholder: "Comunidad Andes" })}
        {campo("slug", "Nombre corto del enlace", {
          placeholder: "comunidad-andes",
          hint: "Se guarda en minusculas y con guiones."
        })}
        {campo("leaderName", "Nombre del lider", { placeholder: "Marta Ruiz" })}
        {campo("leaderEmail", "Correo del lider", { type: "email", placeholder: "marta@andes.co" })}
        {campo("leaderPhone", "Telefono del lider", { type: "tel", placeholder: "+57 300 111 2233" })}
        {campo("password", "Contrasena temporal", {
          type: "password",
          hint: "Minimo 6 caracteres. El lider la cambia despues."
        })}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => void crear()}
        className="focus-ring mt-4 rounded-full bg-acid px-4 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60"
      >
        {busy ? "Creando la comunidad..." : "Crear lider de comunidad"}
      </button>

      {busy && (
        <p className="mt-3 text-xs text-ink-60" aria-live="polite">
          Se estan creando la comunidad, la reserva del enlace y la cuenta. No cierres la pantalla.
        </p>
      )}

      {error && !busy && (
        <p className="mt-3 rounded-2xl border border-rust/20 bg-rust/10 p-3 text-xs text-rust">{error}</p>
      )}

      {/*
        El enlace es lo primero que el lider necesita, y sin verlo aqui habria que ir a buscarlo a
        la lista. `communityInvitePath` decide si existe: una comunidad sin nombre corto no puede
        pintar una ruta con un hueco dentro, que se copia y se reparte igual sin resolver nada.
      */}
      {created && !busy && !error && (
        <div className="mt-3 rounded-2xl border border-white/10 bg-field p-3">
          <p className="text-sm font-semibold">Lider creado</p>
          {inviteUrl ? (
            <>
              <p className="mt-1 break-all text-xs text-ink-70">{inviteUrl}</p>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(inviteUrl)}
                className="focus-ring mt-2 rounded-full bg-panel px-4 py-2 text-xs font-semibold hover:bg-white/10"
              >
                Copiar enlace de invitacion
              </button>
            </>
          ) : (
            <p className="mt-1 text-xs text-ink-60">La comunidad quedo creada pero todavia sin enlace.</p>
          )}
        </div>
      )}

      {!created && !busy && !error && !invalid && (
        <p className="mt-3 text-xs text-ink-60">Todavia no has creado ningun lider en esta sesion.</p>
      )}
    </Card>
  );
}

/**
 * Comunidades, para el administrador.
 *
 * Muestra lo que hace falta para gobernarlas sin abrir la consola de Firebase: quien las lidera,
 * que precio cobran hoy, si su enlace admite altas y si alguna disparo el aviso de captacion
 * masiva. El aviso se descarta sin desactivar a nadie: un lider que capta en un evento lo
 * levanta sin hacer nada malo.
 *
 * Y aqui vive la contencion de un enlace filtrado (RF_41), que la spec declara el unico remedio
 * cuando el enlace acaba donde no debia: elegir el rango en el que se filtro y cerrar de golpe
 * el acceso de las tiendas que entraron por ahi. Solo el administrador la ve
 * (`canBulkDisableCommunitySignups`), la misma decision que toma la callable por su cuenta.
 */
function AdminCommunitiesPanel({ state, session }: { state: AppState; session: Session }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Una contencion a la vez: es una emergencia, no una tarea de fondo.
  const [containmentFor, setContainmentFor] = useState<string | null>(null);
  const [containmentFrom, setContainmentFrom] = useState("");
  const [containmentTo, setContainmentTo] = useState("");
  const [containmentBusy, setContainmentBusy] = useState(false);
  const [containmentError, setContainmentError] = useState<string | null>(null);
  const [containment, setContainment] = useState<BulkSignupDisableView | null>(null);

  const actor: Actor = { uid: session.id, role: session.role };

  /**
   * Las cifras de cada comunidad las decide el nucleo (RF_34), no este JSX: antes las tiendas y
   * los tres precios se derivaban inline dentro del render y no habia donde probarlos.
   *
   * OJO con `state.wallet`: de ahi sale `cashbackAccruedCop`, y es justo la coleccion que
   * `docs/rendimiento.md` marca como PENDIENTE DE RECORTAR para el administrador (10.452 asientos,
   * 3,58 MB, el 68% de su carga). Si alguien acota esa suscripcion a una ventana de fechas, esta
   * cifra BAJA EN SILENCIO —no falla, no avisa: muestra menos cashback del que la comunidad
   * genero— porque lo causado incluye asientos tan viejos como la comunidad. Es la regla 5 del
   * CLAUDE.md. Quien acote la wallet tiene que rescatar estos asientos por id o agregarlos en
   * servidor, como se hizo con `getPlatformPosition`.
   *
   * El hook va ANTES del `return` anticipado de mas abajo. `react-hooks/rules-of-hooks` es error
   * en este repo por un fallo que llego a produccion: un `useMemo` tras un return solo reventaba
   * (React #310) en el primer render sin cache, o sea solo en movil.
   */
  const communityRows = useMemo(() => {
    const rows = buildAdminCommunityList({
      communities: state.communities,
      sellers: state.sellers,
      entries: state.wallet,
      settings: state.settings
    });
    // `linkStatus` y `status` no viajan en la fila: son estado del documento, no cifras
    // derivadas, y la tarjeta los sigue leyendo de `community`. Por eso se emparejan aqui.
    const byId = new Map(state.communities.map((community) => [community.id, community]));
    return rows.flatMap((row) => {
      const community = byId.get(row.communityId);
      return community ? [{ row, community }] : [];
    });
  }, [state.communities, state.sellers, state.wallet, state.settings]);

  // El informe viene con ids: sin nombre, el administrador no sabe a por cual ir.
  const sellerName = (sellerId: string) =>
    state.sellers.find((seller) => seller.id === sellerId)?.name ?? sellerId;

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  };

  const openContainment = (communityId: string) => {
    setContainment(null);
    setContainmentError(null);
    setContainmentFrom("");
    setContainmentTo("");
    setContainmentFor(containmentFor === communityId ? null : communityId);
  };

  const runContainment = async (community: Community) => {
    if (!containmentFrom || !containmentTo) {
      setContainmentError("Elige el rango de fechas en el que estuvo circulando el enlace.");
      return;
    }
    const fromIso = caliDayStartIso(containmentFrom);
    const toIso = caliDayEndIso(containmentTo);
    // Cuantas alcanza, segun lo que ya hay en pantalla. Es una estimacion y se dice como tal:
    // quien manda es el informe que devuelve el servidor.
    const alcanzadas = state.sellers.filter(
      (seller) =>
        seller.communityId === community.id &&
        !!seller.communityJoinedAt &&
        seller.communityJoinedAt >= fromIso &&
        seller.communityJoinedAt <= toIso
    ).length;
    const confirmado = window.confirm(
      `Cerrar el acceso de las tiendas que entraron por el enlace de ${community.name} entre ${containmentFrom} y ${containmentTo}?\n\n` +
        `Aqui se ven ${alcanzadas} tiendas en ese rango. Sus pedidos y su historial de dinero quedan intactos: ` +
        "solo se cierra el acceso, y reabrirlo despues es cuenta por cuenta."
    );
    if (!confirmado) return;

    setContainmentBusy(true);
    setContainmentError(null);
    setContainment(null);
    try {
      const report = await disableCommunitySignupsInRange({ communityId: community.id, fromIso, toIso });
      setContainment(buildBulkSignupDisableView(report));
    } catch (cause) {
      setContainmentError(cause instanceof Error ? cause.message : "No se pudo completar la contencion.");
    } finally {
      setContainmentBusy(false);
    }
  };

  if (state.communities.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-60">
          No hay comunidades todavia. Al crear un lider de comunidad se genera su enlace de
          invitacion y las tiendas que entren por el quedan adscritas a el.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      {error && <p className="mb-3 rounded-2xl bg-field p-3 text-sm text-red-300">{error}</p>}
      <PaginatedList items={communityRows} pageSize={8} empty={<p className="text-sm text-ink-60">Sin comunidades.</p>}>
        {({ row, community }) => {
          const pendingAlert =
            community.massSignupAlertAt &&
            (!community.massSignupAlertDismissedAt || community.massSignupAlertDismissedAt < community.massSignupAlertAt);
          // Lo PAGADO sale de los cortes del lider (RF_49) y no de la wallet, asi que se calcula
          // donde ya estaba y no se duplica dentro de `buildAdminCommunityList`.
          const cashbackPaidCop = communityCashbackPaidCop(state.settlements, community.id);
          // RF_41: la contencion la dispara el administrador, no el lider — ni el de esta comunidad,
          // que es justo quien mas motivos tendria para querer tapar una fuga de su propio enlace.
          const puedeContener = canBulkDisableCommunitySignups(actor, community.id);
          const contencionAbierta = containmentFor === community.id;
          // La ruta la decide el nucleo (RF_27, T41) y no una interpolacion: una comunidad sin
          // slug pintaba "/registro/" a secas, que parece un enlace y no resuelve nada.
          const invitePath = communityInvitePath(community);
          return (
            <div key={community.id} className="rounded-2xl border border-white/10 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{row.name}</p>
                <span className="text-xs text-ink-60">{invitePath ?? "Sin enlace todavia"}</span>
              </div>
              <p className="mt-1 text-sm text-ink-60">
                {row.leaderName} · {row.stores} tiendas ·{" "}
                {community.linkStatus === "active" ? "enlace activo" : "enlace revocado"} ·{" "}
                {community.status === "active" ? "lider activo" : "lider desactivado"}
              </p>
              <p className="mt-1 text-xs text-ink-60">
                Entrega {formatCop(row.pricing.sellerDeliveredFeeCop)} ·
                Fallido {formatCop(row.pricing.sellerFailedFeeCop)} ·
                Manejo {formatCop(row.pricing.fulfillmentFeeCop)}
              </p>
              {/*
                Dos cifras distintas y rotuladas, nunca una sola: lo CAUSADO es lo que la comunidad
                ha generado desde que existe (este cortado o no) y lo PAGADO es lo que ya salio de
                caja. Fundirlas le diria al admin que ya giro un dinero que todavia debe.
              */}
              <p className="mt-1 text-xs text-ink-60">
                Cashback causado <span className="tabular font-semibold text-fg">{formatCop(row.cashbackAccruedCop)}</span> ·
                pagado <span className="tabular font-semibold text-fg">{formatCop(cashbackPaidCop)}</span>
              </p>
              {pendingAlert && (
                <p className="mt-2 rounded-2xl bg-field p-3 text-xs">
                  Captacion masiva detectada. Ninguna alta se bloqueo.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy === community.id}
                  onClick={() => act(community.id, () => setCommunityLinkStatus({
                    communityId: community.id,
                    linkStatus: community.linkStatus === "active" ? "revoked" : "active"
                  }))}
                  className="rounded-full bg-field px-4 py-2 text-xs font-semibold disabled:opacity-60"
                >
                  {community.linkStatus === "active" ? "Revocar enlace" : "Reactivar enlace"}
                </button>
                <button
                  type="button"
                  disabled={busy === community.id}
                  onClick={() => act(community.id, () => setCommunityLeaderStatus({
                    communityId: community.id,
                    status: community.status === "active" ? "disabled" : "active"
                  }))}
                  className="rounded-full bg-field px-4 py-2 text-xs font-semibold disabled:opacity-60"
                >
                  {community.status === "active" ? "Desactivar lider" : "Reactivar lider"}
                </button>
                {pendingAlert && (
                  <button
                    type="button"
                    disabled={busy === community.id}
                    onClick={() => act(community.id, () => dismissMassSignupAlert({ communityId: community.id }))}
                    className="rounded-full bg-field px-4 py-2 text-xs font-semibold disabled:opacity-60"
                  >
                    Descartar aviso
                  </button>
                )}
                {puedeContener && (
                  <button
                    type="button"
                    onClick={() => openContainment(community.id)}
                    className="focus-ring rounded-full bg-field px-4 py-2 text-xs font-semibold text-rust hover:bg-white/10"
                  >
                    {contencionAbierta ? "Cerrar el control" : "Contener enlace filtrado"}
                  </button>
                )}
              </div>

              {/* RF_41: el control solo existe para quien puede ejecutarlo. */}
              {puedeContener && contencionAbierta && (
                <div className="mt-3 rounded-2xl bg-field p-3">
                  <p className="text-sm font-semibold">Contener el enlace filtrado</p>
                  <p className="mt-1 text-xs text-ink-60">
                    Cierra de una vez el acceso de las tiendas que entraron por este enlace dentro del
                    rango que elijas. Sus pedidos y su historial de dinero quedan intactos; reabrir el
                    acceso despues es cuenta por cuenta.
                  </p>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="grid gap-1 text-xs font-semibold text-ink-60">
                      Desde
                      <input
                        type="date"
                        value={containmentFrom}
                        onChange={(event) => setContainmentFrom(event.target.value)}
                        className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold text-ink-60">
                      Hasta
                      <input
                        type="date"
                        value={containmentTo}
                        onChange={(event) => setContainmentTo(event.target.value)}
                        className="focus-ring rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-normal text-fg"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={containmentBusy}
                      onClick={() => void runContainment(community)}
                      className="focus-ring rounded-full border border-rust/30 bg-panel px-4 py-2 text-xs font-semibold text-rust disabled:opacity-50"
                    >
                      {containmentBusy ? "Cerrando accesos..." : "Cerrar los accesos del rango"}
                    </button>
                  </div>
                  {containmentError && (
                    <p className="mt-3 rounded-2xl border border-rust/20 bg-rust/10 p-3 text-xs text-rust">
                      {containmentError}
                    </p>
                  )}
                  {containmentBusy && (
                    <p className="mt-3 text-xs text-ink-60">
                      Cerrando los accesos uno a uno. No cierres la pantalla: el informe con lo que
                      quedo cerrado y lo que no llega al terminar.
                    </p>
                  )}
                  {containment && !containmentBusy && (
                    <BulkSignupDisableReportCard view={containment} sellerName={sellerName} />
                  )}
                </div>
              )}
            </div>
          );
        }}
      </PaginatedList>
    </Card>
  );
}


/**
 * Panel del lider de comunidad.
 *
 * No pinta ni un pedido, y no es una limitacion sino el diseno: sus cifras llegan agregadas del
 * servidor (`getCommunityStats`) y su rol no puede leer la coleccion de pedidos. Lo que ve es
 * el desempeno de sus tiendas y su propio cashback.
 *
 * Los tres ejes de fecha van ROTULADOS en cada bloque. Mezclarlos en silencio ya desvio cifras
 * en esta plataforma, y aqui conviven de forma natural: los pedidos creados se cuentan por su
 * fecha de creacion y las entregas y el dinero por la de cierre.
 */
function CommunityLeaderView({
  state,
  session,
  startDate,
  endDate,
  onStartDate,
  onEndDate
}: {
  state: AppState;
  session: { role: Role; profileId: string };
  startDate: string;
  endDate: string;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
}) {
  const [stats, setStats] = useState<CommunityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const communityId = session.profileId;
  const [sellerNames, setSellerNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCommunityStats({ communityId, startDate, endDate })
      .then((data) => {
        if (cancelled) return;
        setSellerNames(data.sellerNames ?? {});
        // Lo PAGADO no se puede agregar en servidor sin denormalizar un campo en cada asiento,
        // asi que se completa aqui con los cortes que este rol ya descarga. La regla vive en el
        // nucleo, no inline: dos copias de la misma formula de dinero acaban divergiendo.
        const paidCop = communityCashbackPaidCop(state.settlements, communityId);
        const raw = { ...(data.raw as unknown as RawCommunityAggregates), cashbackPaidCop: paidCop };
        setStats(buildCommunityStats(raw));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudieron cargar las cifras.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [communityId, startDate, endDate, state.settlements]);

  // La ruta la decide el nucleo (RF_32) y el origen lo pone la pantalla, que es quien vive en el
  // navegador. Sin slug no hay ruta: antes esto interpolaba el slug dentro de la plantilla y una
  // comunidad que aun no tenia ninguno repartia un enlace con un hueco dentro, copiable y
  // abrible, que no resolvia ninguna comunidad.
  const invitePath = communityInvitePath({ slug: communitySlug(state, communityId) });
  const inviteUrl = invitePath && typeof window !== "undefined" ? `${window.location.origin}${invitePath}` : "";

  if (loading) {
    return (
      <div className="space-y-4">
        <Card><p className="text-sm text-ink-60">Cargando las cifras de tu comunidad...</p></Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <p className="text-sm font-semibold">No se pudieron cargar tus cifras</p>
        <p className="mt-1 text-sm text-ink-60">{error}</p>
      </Card>
    );
  }

  if (!stats || stats.emptiness === "no_stores") {
    // Comunidad vacia: en vez de una pantalla en blanco, las cifras en cero y el enlace para
    // llenarla (RF_32). Las dos cosas salen juntas de la misma funcion pura para que no puedan
    // separarse: sin slug se pintan los ceros igual, solo que sin enlace que repartir.
    const empty = buildEmptyCommunityView(
      { slug: communitySlug(state, communityId) },
      stats ?? buildCommunityStats(EMPTY_COMMUNITY_AGGREGATES)
    );
    return (
      <Card>
        <p className="text-base font-semibold">Todavia no tienes tiendas</p>
        <p className="mt-1 text-sm text-ink-60">
          Comparte tu enlace de invitacion: quien se registre por el entra directo a tu comunidad.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric icon={<Boxes size={20} />} label="Pedidos creados" value={String(empty.totals.created)} />
          <Metric icon={<Truck size={20} />} label="Despachados" value={String(empty.totals.dispatched)} />
          <Metric icon={<Check size={20} />} label="Entregados" value={String(empty.totals.delivered)} />
          <Metric icon={<X size={20} />} label="Fallidos" value={String(empty.totals.failed)} />
        </div>
        {/* Sin ruta no hay enlace: `inviteUrl` queda vacio y aqui no se pinta nada. */}
        {inviteUrl && <p className="mt-3 break-all rounded-2xl bg-field p-3 text-sm text-acid">{inviteUrl}</p>}
      </Card>
    );
  }

  const money = (value: number) => formatCop(value);
  const rate = stats.totals.deliveryRate;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-60">
            Desde
            <input type="date" value={startDate} onChange={(event) => onStartDate(event.target.value)} className="mt-1 block rounded-xl bg-field px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-ink-60">
            Hasta
            <input type="date" value={endDate} onChange={(event) => onEndDate(event.target.value)} className="mt-1 block rounded-xl bg-field px-3 py-2 text-sm" />
          </label>
        </div>
        {inviteUrl && (
          <p className="mt-4 break-all text-xs text-ink-60">
            Tu enlace de invitacion: <span className="text-acid">{inviteUrl}</span>
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric icon={<Boxes size={20} />} label={`Pedidos creados (${metricDateSource("created").label})`} value={String(stats.totals.created)} />
        <Metric icon={<Truck size={20} />} label={`Despachados (${metricDateSource("dispatched").label})`} value={String(stats.totals.dispatched)} />
        <Metric icon={<Check size={20} />} label={`Entregados (${metricDateSource("delivered").label})`} value={String(stats.totals.delivered)} />
        <Metric icon={<X size={20} />} label={`Fallidos (${metricDateSource("failed").label})`} value={String(stats.totals.failed)} />
      </div>

      <Card>
        <p className="text-sm font-semibold">Tu cashback</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-ink-60">Causado ({metricDateSource("cashback").label})</p>
            <p className="tabular text-2xl font-bold">{money(stats.totals.cashbackAccruedCop)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-60">Ya pagado</p>
            <p className="tabular text-2xl font-bold">{money(stats.totals.cashbackPaidCop)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-60">Pendiente</p>
            <p className="tabular text-2xl font-bold text-acid">{money(stats.totals.cashbackPendingCop)}</p>
          </div>
        </div>
        {stats.totals.ordersWithoutCashbackByZoneFloor > 0 && (
          // Que el cero tenga explicacion: si no, el lider cree que la plataforma le roba.
          <p className="mt-3 rounded-2xl bg-field p-3 text-xs text-ink-60">
            {stats.totals.ordersWithoutCashbackByZoneFloor} pedidos no generaron cashback porque la
            tarifa de su zona supera el precio que fijaste.
          </p>
        )}
      </Card>

      <Card>
        <p className="text-sm font-semibold">
          Entrega: {rate.percent === null ? "sin pedidos cerrados" : `${rate.percent.toFixed(1)}%`}
          {rate.denominator > 0 && <span className="ml-2 text-xs font-normal text-ink-60">sobre {rate.denominator} cerrados</span>}
        </p>
        <p className="mt-1 text-xs text-ink-60">
          {stats.totals.activeStores} tiendas activas · {stats.totals.inactiveStores} sin pedidos en el periodo
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">Como va cada tienda</p>
        {stats.emptiness === "no_orders_in_period" ? (
          <p className="mt-2 text-sm text-ink-60">Tus tiendas no movieron pedidos en este periodo.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs text-ink-60">
                <tr>
                  <th className="py-2">Tienda</th>
                  <th className="py-2">Creados</th>
                  <th className="py-2">Despachados</th>
                  <th className="py-2">Entregados</th>
                  <th className="py-2">Fallidos</th>
                  <th className="py-2">% entrega</th>
                </tr>
              </thead>
              <tbody>
                {stats.byStore.map((row) => (
                  <tr key={row.sellerId} className="border-t border-white/[0.06]">
                    <td className="py-2">{sellerNames[row.sellerId] ?? row.sellerId}</td>
                    <td className="tabular py-2">{row.created}</td>
                    <td className="tabular py-2">{row.dispatched}</td>
                    <td className="tabular py-2">{row.delivered}</td>
                    <td className="tabular py-2">{row.failed}</td>
                    <td className="tabular py-2">
                      {row.deliveryRate.percent === null ? "—" : `${row.deliveryRate.percent.toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * El nombre corto con el que se registran las tiendas de una comunidad. Solo lo conoce quien ya
 * entro por el enlace: se lee de las tiendas captadas.
 *
 * Devuelve `undefined` cuando todavia no hay ninguna, y ahi esta el cambio: antes caia al id de
 * la comunidad, que NO es un slug y no resuelve nada en `/registro/[slug]`. Repartir esa ruta es
 * el mismo fallo que repartir una con un hueco dentro, solo que con mejor aspecto. Sin slug, no
 * hay enlace que dar (RF_32).
 */
function communitySlug(state: AppState, communityId: string): string | undefined {
  const seller = state.sellers.find((item) => item.communityId === communityId);
  return seller?.communitySignupSlug;
}

/**
 * Cifras en cero de verdad, para cuando el panel del lider no tiene ni respuesta del servidor.
 * RF_32 pide ceros y enlace, no una pantalla en blanco, y los ceros salen del mismo nucleo que
 * los calcula siempre en vez de escribirse a mano aqui.
 */
const EMPTY_COMMUNITY_AGGREGATES: RawCommunityAggregates = {
  storeCount: 0,
  createdByStore: {},
  dispatchedByStore: {},
  deliveredByStore: {},
  failedByStore: {},
  cashbackAccruedCop: 0,
  cashbackPaidCop: 0,
  ordersWithoutCashbackByZoneFloor: 0
};

function AdminView({ state, setState, session, onNavigate, orderSearch, onOrderSearchChange, startDate, endDate, statusFilter, sellerFilter, historyStart, searchingHistory, onStartDate, onEndDate, onStatusFilter, onSellerFilter, onSelectRange, periodStats = null, periodStatsError = null, view = "operations" }: { state: AppState; setState: (state: AppState) => void; session: Session; onNavigate: (view: AppView) => void; orderSearch: string; onOrderSearchChange: (value: string) => void; startDate: string; endDate: string; statusFilter: string; sellerFilter: string; historyStart?: string; searchingHistory?: boolean; onStartDate: (value: string) => void; onEndDate: (value: string) => void; onStatusFilter: (value: string) => void; onSellerFilter: (value: string) => void; onSelectRange: (startDate: string, endDate: string) => void; periodStats?: OrderPeriodStats | null; periodStatsError?: string | null; view?: AppView }) {
  const [adminOrderTab, setAdminOrderTab] = useState<"operation" | "failed">("operation");
  const [adminFailedCategoryFilter, setAdminFailedCategoryFilter] = useState<FailedCategoryFilter>("all");
  // Antes esto eran ~14 recorridos completos de `state.orders` en cada render (con dos
  // `filterOrdersByRangeStatus`, que ademas copian y ordenan). Con el arbol re-renderizandose
  // entero en cada emision del listener, era el mayor coste de pintado del panel.
  const {
    sellerFilteredOrders,
    rangeOrders,
    pending,
    failed,
    review,
    callRescheduled,
    deliveryScheduled,
    warehouseLabelOrders,
    pendingWarehouseLabelOrders,
    unprintedOrders,
    pickupReadyOrders,
    failedOrders,
    operationOrders,
    visibleOperationOrders,
    visibleFailedBaseOrders
  } = useMemo(() => {
    const sellerScoped = sellerFilter === "all" ? state.orders : state.orders.filter((order) => order.sellerId === sellerFilter);

    const closedStatuses = new Set(["delivered", "failed", "cancelled"]);
    const inRange: Order[] = [];
    const pendingOrders: Order[] = [];
    const failedInRange: Order[] = [];
    const reviewOrders: Order[] = [];
    const rescheduledOrders: Order[] = [];
    const scheduledOrders: Order[] = [];
    const unprinted: Order[] = [];
    const pickupReady: Order[] = [];
    const failedAll: Order[] = [];
    const operationAll: Order[] = [];

    for (const order of sellerScoped) {
      const date = orderDateValue(order);
      const withinRange = (!startDate || !date || date >= startDate) && (!endDate || !date || date <= endDate);
      if (withinRange) {
        inRange.push(order);
        if (!closedStatuses.has(order.status)) pendingOrders.push(order);
        if (order.status === "failed") failedInRange.push(order);
        if (order.addressRisk === "review") reviewOrders.push(order);
        if (order.callOutcome === "rescheduled") rescheduledOrders.push(order);
        if (order.status === "scheduled") scheduledOrders.push(order);
      }
      if (adminPrintableOrderStatuses.has(order.status) && !order.labelPrintedAt) unprinted.push(order);
      if ((order.status === "ready_to_assign" && !order.driverId) || order.status === "assigned") pickupReady.push(order);
      if (order.status === "failed") failedAll.push(order);
      else operationAll.push(order);
    }
    inRange.sort(compareOrdersByCreatedAtDesc);

    const warehouseLabels = state.orders.filter(canPrintAdminWarehouseLabel);

    return {
      sellerFilteredOrders: sellerScoped,
      rangeOrders: inRange,
      pending: pendingOrders,
      failed: failedInRange,
      review: reviewOrders,
      callRescheduled: rescheduledOrders,
      deliveryScheduled: scheduledOrders,
      warehouseLabelOrders: warehouseLabels,
      pendingWarehouseLabelOrders: warehouseLabels.filter((order) => !order.labelPrintedAt),
      unprintedOrders: unprinted,
      pickupReadyOrders: pickupReady,
      failedOrders: failedAll,
      operationOrders: operationAll,
      visibleOperationOrders: filterOrdersByRangeStatus(operationAll, startDate, endDate, statusFilter, orderSearch),
      visibleFailedBaseOrders: filterOrdersByRangeStatus(failedAll, startDate, endDate, statusFilter, orderSearch)
    };
  }, [state.orders, sellerFilter, startDate, endDate, statusFilter, orderSearch]);

  const pendingShopifyRequests = useMemo(
    () => (state.shopifyInstallRequests ?? []).filter((request) => request.status === "requested"),
    [state.shopifyInstallRequests]
  );
  const visibleOrders = useMemo(
    () => (adminOrderTab === "failed" ? filterByFailedCategory(visibleFailedBaseOrders, adminFailedCategoryFilter) : visibleOperationOrders),
    [adminOrderTab, adminFailedCategoryFilter, visibleFailedBaseOrders, visibleOperationOrders]
  );
  const reprintableVisibleOrders = useMemo(() => visibleOrders.filter((order) => Boolean(order.labelPrintedAt)), [visibleOrders]);
  const exportableFailedOrders = useMemo(
    () => filterByFailedCategory(visibleFailedBaseOrders, adminFailedCategoryFilter),
    [visibleFailedBaseOrders, adminFailedCategoryFilter]
  );
  const adminExcelFilename = `pedidos-admin-${sellerFilter === "all" ? "todos" : sellerFilter}-${startDate || "inicio"}-${endDate || "hoy"}.xlsx`;
  const alerts = [
    ...review.map((order) => `Direccion en revision ${order.shopifyOrderId}`),
    ...failed.filter((order) => order.retryDecision === "pending").map((order) => `Reintento pendiente ${order.shopifyOrderId}`),
    ...pendingShopifyRequests.map((request) => `Solicitud Shopify ${request.shopDomain}`),
    ...state.sellers.filter((seller) => seller.debtBlockedAt).map((seller) => `${seller.name} bloqueado por deuda`)
  ];

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-bold">{ADMIN_VIEW_TITLES[view]?.title ?? "Operacion"}</h2>
          <p className="text-sm text-ink-60">{ADMIN_VIEW_TITLES[view]?.hint ?? ""}</p>
        </div>
        {view === "operations" && (
          <button
            className="focus-ring inline-flex items-center justify-center gap-2 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep"
            type="button"
            onClick={() => onNavigate("liquidations")}
          >
            <CreditCard size={16} />
            Ver liquidaciones
          </button>
        )}
      </div>

      {view === "integrations" && (
        <div className="grid content-start gap-3">
          <CollapsiblePanel flush title="Tiendas Shopify" summary={`${(state.shopifyStores ?? []).length} conectadas`}>
            <ShopifyStoresAdminPanel state={state} setState={setState} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Incidencias de sincronizacion" count={(state.shopifySyncIssues ?? []).length} summary={`${(state.shopifySyncIssues ?? []).length} sin resolver`} tone={(state.shopifySyncIssues ?? []).length > 0 ? "rust" : "default"} defaultOpen={(state.shopifySyncIssues ?? []).length > 0}>
            <ShopifySyncIssuesPanel issues={state.shopifySyncIssues ?? []} sellers={state.sellers} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Solicitudes de instalacion" count={state.shopifyInstallRequests?.filter((request) => request.status === "requested").length ?? 0} summary={`${state.shopifyInstallRequests?.filter((request) => request.status === "requested").length ?? 0} pendientes`} tone={(state.shopifyInstallRequests?.filter((request) => request.status === "requested").length ?? 0) > 0 ? "acid" : "default"} defaultOpen={(state.shopifyInstallRequests?.filter((request) => request.status === "requested").length ?? 0) > 0}>
            <ShopifyInstallRequestsPanel state={state} setState={setState} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Importar un pedido de Shopify" summary="Traer un pedido puntual por numero">
            <ShopifyImportOrderPanel
              stores={state.shopifyStores ?? []}
              sellers={state.sellers}
              onImported={(order) => setState({ ...state, orders: [order, ...state.orders.filter((item) => item.id !== order.id)] })}
            />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Webhooks de tienda" summary={`${(state.storeWebhookConfigs ?? []).length} configurados`}>
            <StoreWebhookConfigsPanel configs={state.storeWebhookConfigs ?? []} sellers={state.sellers} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Confirmacion por UChat" summary="Confirmacion automatica por WhatsApp">
            <UchatConfigsAdminPanel configs={state.storeWebhookConfigs ?? []} sellers={state.sellers} />
          </CollapsiblePanel>
        </div>
      )}

      {view === "settings" && (
        <div className="grid content-start gap-3">
          <CollapsiblePanel flush title="Forma de pago y 4x1000" summary={`${[...state.sellers, ...state.drivers, ...state.suppliers].filter((item) => item.paysInCash).length} cuentas en efectivo`}>
            <PaymentMethodPanel state={state} setState={setState} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Zonas y tarifas" summary={`${state.zones.length} zonas`}>
            <ZonesTariffsPanel state={state} setState={setState} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Puntos de recogida" summary="Direcciones de recogida por tienda">
            <SellerPickupPointsPanel state={state} setState={setState} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Usuarios" summary="Altas, roles y accesos">
            <AdminUsersPanel state={state} setState={setState} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Comunidades" summary={`${state.communities.length} con enlace propio`}>
            {/*
              El alta va FUERA de `AdminCommunitiesPanel` a proposito: aquel panel se corta con un
              `return` anticipado cuando no hay ni una comunidad, y ahi dentro el formulario
              desapareceria justo en el momento en que hace falta crear la primera.
            */}
            <CreateCommunityLeaderForm communities={state.communities} />
            <AdminCommunitiesPanel state={state} session={session} />
            {/*
              RF_11: mover una tienda de comunidad. El componente existia desde T46 y se quedo sin
              montar — definido, tipado, con su predicado importado, y en ninguna pantalla. Ni el
              lint (deliberadamente estrecho) ni `tsc` marcan una funcion de modulo sin usar, asi
              que el unico guarda es la prueba de `community-view.test.ts` que cruza componentes
              definidos contra componentes montados.
            */}
            <SellerCommunityReassignPanel actor={{ uid: session.id, role: session.role }} state={state} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Lideres logisticos" summary={`${state.drivers.length} activos`}>
          <Card>
            <PaginatedList items={state.drivers} pageSize={8} empty={<p className="text-sm text-ink-60">No hay lideres logisticos registrados.</p>}>
              {(driver) => {
                const rate = weeklyFailedRate(state, driver.id);
                return (
                  <div key={driver.id} className="rounded-2xl border border-white/10 p-3">
                    <p className="font-semibold">{driver.name}</p>
                    <p className="text-sm text-ink-60">Fallidos 7 dias: {rate.rate}% ({rate.failed}/{rate.total})</p>
                  </div>
                );
              }}
            </PaginatedList>
          </Card>
          </CollapsiblePanel>
        </div>
      )}

      {view === "operations" && (
      <>
      <LogisticsKpis orders={rangeOrders} state={state} periodStats={periodStats} />
      <div className="grid gap-3 lg:grid-cols-2">
        <AdminOperationalSummary
          title="Pedidos sin imprimir"
          orders={unprintedOrders}
          sellers={state.sellers}
          icon={<Printer size={18} />}
          empty="No hay pedidos pendientes de rotulo."
          actionLabel={`Imprimir pendientes (${unprintedOrders.length})`}
          onAction={async () => {
            const printed = await printOrderLabels(unprintedOrders, state, "Rotulos pendientes");
            if (printed) setState(markOrdersLabelsPrinted(state, unprintedOrders, "admin"));
          }}
        />
        <AdminOperationalSummary
          title="Pendientes recogida domiciliario"
          orders={pickupReadyOrders}
          sellers={state.sellers}
          icon={<Truck size={18} />}
          empty="No hay pedidos esperando recogida."
          helper="Incluye listos sin lider y asignados a lider que aun no han sido recogidos."
          actionLabel={`Exportar pendientes (${pickupReadyOrders.length})`}
          actionIcon={<FileDown size={16} />}
          onAction={() => downloadOrdersXlsx(
            // Del mas antiguo al mas reciente: la cola vieja es lo que hay que desatascar,
            // asi que abre el archivo en vez de quedar sepultada al final.
            [...pickupReadyOrders].sort(compareOrdersByPickupWaitAsc),
            state,
            `pendientes-recoger-${new Date().toISOString().slice(0, 10)}.xlsx`
          )}
        />
      </div>

      {/* Con la fila compacta la lista ya no cabe en una columna de 640px desperdiciando la
          mitad de la pantalla: los dos paneles laterales suben a una banda propia y la lista
          ocupa todo el ancho. Mismo criterio que en tienda. */}
      <div className="grid gap-3 lg:grid-cols-2">
        <CollapsiblePanel
          title="Alertas internas"
          count={alerts.length}
          summary={`${alerts.length} direcciones en revision`}
          tone={alerts.length > 0 ? "rust" : "default"}
          hideWhenEmpty
        >
          <PaginatedList items={alerts} pageSize={8} empty={<p className="text-sm text-ink-60">No hay alertas internas.</p>}>
            {(alert) => <p key={alert} className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{alert}</p>}
          </PaginatedList>
        </CollapsiblePanel>
        <CollapsiblePanel flush title="Crear pedido" summary="Alta manual de un pedido">
          <ManualOrderPanel state={state} setState={setState} />
        </CollapsiblePanel>
      </div>

      <div className="grid gap-4">
        <section className="grid content-start gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-base font-bold">Operacion en vivo</h2>
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold disabled:opacity-50"
              type="button"
              disabled={pendingWarehouseLabelOrders.length === 0}
              onClick={async () => {
                const printed = await printOrderLabels(pendingWarehouseLabelOrders, state, "Rotulos bodega pendientes");
                if (printed) setState(markOrdersLabelsPrinted(state, pendingWarehouseLabelOrders, "admin"));
              }}
            >
              <Printer size={16} />
              Rotulos pendientes ({pendingWarehouseLabelOrders.length})
            </button>
          </div>
          <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} searchingHistory={searchingHistory} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <button
                className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${adminOrderTab === "operation" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
                type="button"
                onClick={() => setAdminOrderTab("operation")}
              >
                Operacion ({operationOrders.length})
              </button>
              <button
                className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${adminOrderTab === "failed" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
                type="button"
                onClick={() => setAdminOrderTab("failed")}
              >
                Fallidos / reintento ({failedOrders.length})
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
                type="button"
                disabled={visibleOrders.length === 0}
                onClick={() => void downloadOrdersXlsx(visibleOrders, state, adminExcelFilename)}
              >
                <FileDown size={16} />
                Descargar Excel visibles ({visibleOrders.length})
              </button>
              <button
                className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
                type="button"
                disabled={exportableFailedOrders.length === 0}
                onClick={() => downloadFailedOrdersCsv(exportableFailedOrders, state, startDate, endDate, sellerFilter)}
              >
                <FileDown size={16} />
                Descargar fallidos visibles ({exportableFailedOrders.length})
              </button>
            </div>
          </div>
          <OrderFilters startDate={startDate} endDate={endDate} status={statusFilter} sellers={state.sellers} sellerFilter={sellerFilter} historyStart={historyStart} onStartDate={onStartDate} onEndDate={onEndDate} onStatus={onStatusFilter} onSeller={onSellerFilter} onSelectRange={onSelectRange} />
          {adminOrderTab === "failed" && (
            <FailedCategoryFilters orders={visibleFailedBaseOrders} value={adminFailedCategoryFilter} onChange={setAdminFailedCategoryFilter} />
          )}
          <button
            className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
            type="button"
            disabled={reprintableVisibleOrders.length === 0}
            onClick={async () => {
              const printed = await printOrderLabels(reprintableVisibleOrders, state, "Reimpresion de rotulos");
              if (printed) setState(markOrdersLabelsPrinted(state, reprintableVisibleOrders, "admin"));
            }}
          >
            <Printer size={16} />
            Reimprimir rotulos visibles ({reprintableVisibleOrders.length})
          </button>
          {(callRescheduled.length > 0 || deliveryScheduled.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {callRescheduled.length > 0 && (
                <span className="rounded-2xl bg-rust/10 px-3 py-2 text-sm font-semibold text-rust">
                  {callRescheduled.length} llamadas reprogramadas
                </span>
              )}
              {deliveryScheduled.length > 0 && (
                <span className="rounded-2xl bg-field px-3 py-2 text-sm font-semibold">
                  {deliveryScheduled.length} entregas agendadas
                </span>
              )}
            </div>
          )}
          <PaginatedList
            items={visibleOrders}
            pageSize={12}
            className="grid content-start gap-2"
            empty={<EmptyRoleState title={adminOrderTab === "failed" ? "Sin fallidos pendientes" : "Sin pedidos"} message={adminOrderTab === "failed" ? "Los pedidos fallidos apareceran aqui para confirmar si van a nuevo reintento." : "Los pedidos reales apareceran cuando conectemos Shopify y entren webhooks de tiendas autorizadas."} />}
          >
            {(order) => <OrderRow key={order.id} order={order} state={state} setState={setState} />}
          </PaginatedList>
        </section>

      </div>
      </>
      )}
    </main>
  );
}

type ManualOrderLineDraft = {
  key: string;
  productName: string;
  sku: string;
  quantity: string;
  /** El SKU lo puso una sugerencia; editarlo a mano lo congela. */
  skuAuto: boolean;
};

function emptyManualLine(key: string): ManualOrderLineDraft {
  return { key, productName: "", sku: "", quantity: "1", skuAuto: false };
}

function ManualOrderPanel({
  state,
  setState,
  lockedSellerId
}: {
  state: AppState;
  setState: (state: AppState) => void;
  lockedSellerId?: string;
}) {
  const [sellerId, setSellerId] = useState(lockedSellerId ?? state.sellers[0]?.id ?? "");
  const [shopifyOrderId, setShopifyOrderId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [addressRaw, setAddressRaw] = useState("");
  const [normalizedAddress, setNormalizedAddress] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cod" | "prepaid">("cod");
  const [fulfillmentMode, setFulfillmentMode] = useState<"seller_pickup" | "warehouse">("seller_pickup");
  const [totalCop, setTotalCop] = useState("");
  const [lines, setLines] = useState<ManualOrderLineDraft[]>([emptyManualLine("line-0")]);
  const [addressRisk, setAddressRisk] = useState<"accepted" | "review">("accepted");
  const [message, setMessage] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const lineKeySeq = useRef(1);
  const productListId = useId();

  useEffect(() => {
    if (lockedSellerId && sellerId !== lockedSellerId) setSellerId(lockedSellerId);
    else if (!sellerId && state.sellers[0]) setSellerId(state.sellers[0].id);
  }, [lockedSellerId, sellerId, state.sellers]);

  const selectedSeller = state.sellers.find((seller) => seller.id === sellerId);
  const sellerZones = state.zones.filter((zone) => zone.cityId === (selectedSeller?.cityId ?? state.settings.activeCityId) && zone.active !== false);
  const selectedZone = sellerZones.find((zone) => zone.id === zoneId);
  const normalizedSellerReference = normalizeSellerReference(shopifyOrderId);
  const duplicateSellerReference = normalizedSellerReference
    ? state.orders.find((order) => order.sellerId === sellerId && normalizeSellerReference(order.shopifyOrderId) === normalizedSellerReference)
    : undefined;

  // Sugerencias: catalogo (manda en el nombre, es quien resuelve el costo) + inventario
  // (aporta el stock libre). Escribir algo que no este aqui sigue siendo valido.
  const productSuggestions = useMemo(() => {
    const byKey = new Map<string, { value: string; sku?: string; freeStock?: number }>();
    const keyOf = (sku?: string, name?: string) =>
      sku?.trim() ? `sku:${sku.trim().toUpperCase()}` : `name:${normalizeProductName(name)}`;
    for (const item of state.productCatalog) {
      if (item.sellerId !== sellerId || item.active === false) continue;
      byKey.set(keyOf(item.sku, item.name), { value: item.name, sku: item.sku });
    }
    for (const item of state.inventory) {
      if (item.sellerId !== sellerId) continue;
      const key = keyOf(item.sku, item.name);
      const previous = byKey.get(key);
      byKey.set(key, {
        value: previous?.value ?? item.name,
        sku: previous?.sku ?? item.sku,
        freeStock: item.available - item.reserved
      });
    }
    return Array.from(byKey.values()).sort((left, right) => left.value.localeCompare(right.value));
  }, [sellerId, state.productCatalog, state.inventory]);

  const updateLine = (key: string, patch: Partial<ManualOrderLineDraft>) => {
    setLines((current) => current.map((line) => {
      if (line.key !== key) return line;
      const next = { ...line, ...patch };
      if (patch.productName !== undefined) {
        // Elegir una opcion del datalist llega como un change normal: si el nombre coincide
        // exactamente con una sugerencia, rellenamos el SKU. Editarlo a mano lo congela.
        const match = productSuggestions.find((suggestion) => normalizeProductName(suggestion.value) === normalizeProductName(patch.productName));
        if (match?.sku && (!line.sku || line.skuAuto)) return { ...next, sku: match.sku, skuAuto: true };
      }
      if (patch.sku !== undefined) next.skuAuto = false;
      return next;
    }));
  };
  const addLine = () => {
    setLines((current) => [...current, emptyManualLine(`line-${lineKeySeq.current++}`)]);
  };
  const removeLine = (key: string) => {
    setLines((current) => (current.length === 1 ? current : current.filter((line) => line.key !== key)));
  };
  const resetLines = () => {
    setLines([emptyManualLine(`line-${lineKeySeq.current++}`)]);
  };

  const filledLines = lines.filter((line) => line.productName.trim() || line.sku.trim());
  const incompleteLine = filledLines.some((line) => !line.productName.trim());
  const invalidQuantity = filledLines.some((line) => {
    const quantity = Number(line.quantity);
    return !Number.isInteger(quantity) || quantity < 1 || quantity > 999;
  });
  // Sobre-reserva: se avisa, nunca se bloquea.
  const stockWarnings = filledLines.flatMap((line) => {
    const item = state.inventory.find((entry) => entry.sellerId === sellerId && entry.sku && line.sku.trim() && entry.sku.trim().toUpperCase() === line.sku.trim().toUpperCase());
    if (!item) return [];
    const free = item.available - item.reserved;
    const quantity = Number(line.quantity) || 1;
    return quantity > free ? [`${item.name}: stock libre ${free}, pediras ${quantity}. El pedido se crea igual.`] : [];
  });

  return (
    <Card>
      <h2 className="mb-3 font-bold">Crear pedido</h2>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            const amount = Number(totalCop.replace(/[^\d]/g, ""));
            if (!sellerId) {
              setMessage("Crea primero un vendedor.");
              return;
            }
            if (!amount || amount <= 0) {
              setMessage("El valor del pedido debe ser mayor a cero.");
              return;
            }
            if (duplicateSellerReference) {
              setMessage(`Ya existe un pedido con la referencia ${normalizedSellerReference}. Usa otra referencia para evitar duplicados.`);
              return;
            }
            if (incompleteLine) {
              setMessage("Completa el nombre del producto de cada linea.");
              return;
            }
            if (invalidQuantity) {
              setMessage("La cantidad de cada linea debe ser un numero entre 1 y 999.");
              return;
            }
            setSubmittingOrder(true);
            const lineItems = filledLines.map((line) => ({
              productName: line.productName.trim() || undefined,
              sku: line.sku.trim() || undefined,
              quantity: Number(line.quantity) || 1
            }));
            const input = {
                sellerId,
                shopifyOrderId,
                customerName,
                customerPhone,
                addressRaw,
                normalizedAddress,
                zoneId,
                paymentMethod,
                fulfillmentMode,
                totalCop: amount,
                lineItems: lineItems.length > 0 ? lineItems : undefined,
                addressRisk
              };
            try {
              if (firebaseEnabled()) {
                const result = await createManualFirebaseOrder(input);
                setState({ ...state, orders: [result.order, ...state.orders] });
              } else {
                setState(createManualOrder(state, input));
              }
              setShopifyOrderId("");
              setCustomerName("");
              setCustomerPhone("");
              setAddressRaw("");
              setNormalizedAddress("");
              setZoneId("");
              setTotalCop("");
              resetLines();
              setAddressRisk("accepted");
              setMessage("Pedido creado.");
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : "";
              const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
              if (code.includes("already-exists") || message.toLowerCase().includes("already-exists") || message.toLowerCase().includes("already exists")) {
                setMessage(`Ya existe un pedido con la referencia ${normalizedSellerReference || shopifyOrderId}. No se creo duplicado ni se reservo inventario adicional.`);
              } else {
                setMessage("No se pudo guardar el pedido en Live. Intenta nuevamente.");
              }
            } finally {
              setSubmittingOrder(false);
            }
          })();
        }}
      >
        {lockedSellerId ? (
          <div className="rounded-2xl border border-white/10 bg-field px-3 py-2 text-sm font-semibold">
            {selectedSeller?.name ?? "Vendedor"}
          </div>
        ) : (
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)} required>
            <option value="">Vendedor</option>
            {state.sellers.map((seller) => (
              <option key={seller.id} value={seller.id}>{seller.name}</option>
            ))}
          </select>
        )}
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Referencia vendedor opcional
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" placeholder="Ej: QA-P1-DUP-001" value={shopifyOrderId} onChange={(event) => setShopifyOrderId(event.target.value)} />
        </label>
        {duplicateSellerReference && (
          <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">
            Ya existe la referencia {normalizedSellerReference}. No se puede crear otro pedido con la misma referencia.
          </p>
        )}
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Cliente" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Telefono" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} required />
        <textarea className="focus-ring min-h-20 rounded-2xl border border-white/10 px-3 py-2 text-sm" placeholder="Direccion original" value={addressRaw} onChange={(event) => setAddressRaw(event.target.value)} required />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Direccion normalizada opcional" value={normalizedAddress} onChange={(event) => setNormalizedAddress(event.target.value)} />
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
            <option value="">Zona sin asignar</option>
            {sellerZones.map((zone) => (
              <option key={zone.id} value={zone.id}>{zone.name}</option>
            ))}
          </select>
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={addressRisk} onChange={(event) => setAddressRisk(event.target.value as "accepted" | "review")}>
            <option value="accepted">Direccion aceptada</option>
            <option value="review">Revisar direccion</option>
          </select>
        </div>
        {selectedZone && (
          <p className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">
            {sellerId === "seller-1779315416119"
              ? `Tarifa DANDA: cobro entregado ${formatCop(13500)} para pedidos creados desde 17/07/2026 · pago domiciliario sin cambios · fallido ${formatCop(0)}`
              : `Tarifa zona ${selectedZone.name}: vendedor entregado ${formatCop(selectedZone.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop)} · lider logistico entregado ${formatCop(selectedZone.driverDeliveredPayCop || state.settings.driverDeliveredPayCop)}`}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as "cod" | "prepaid")}>
            <option value="cod">Contraentrega</option>
            <option value="prepaid">Pagado</option>
          </select>
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={fulfillmentMode} onChange={(event) => setFulfillmentMode(event.target.value as "seller_pickup" | "warehouse")}>
            <option value="seller_pickup">Recogida vendedor</option>
            <option value="warehouse">Bodega</option>
          </select>
        </div>
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Valor COP" inputMode="numeric" value={totalCop} onChange={(event) => setTotalCop(event.target.value)} required />
        <div className="grid gap-2 rounded-2xl border border-white/10 p-2">
          <p className="text-xs font-semibold text-ink-60">Productos</p>
          <datalist id={productListId}>
            {productSuggestions.map((suggestion) => (
              <option
                key={`${suggestion.sku ?? ""}-${suggestion.value}`}
                value={suggestion.value}
                label={[suggestion.sku, suggestion.freeStock !== undefined ? `${suggestion.freeStock} libres` : null].filter(Boolean).join(" · ")}
              />
            ))}
          </datalist>
          {lines.map((line) => (
            <div key={line.key} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto_auto]">
              <input
                className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
                placeholder="Producto"
                list={productListId}
                value={line.productName}
                onChange={(event) => updateLine(line.key, { productName: event.target.value })}
              />
              <input
                className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
                placeholder="SKU opcional"
                value={line.sku}
                onChange={(event) => updateLine(line.key, { sku: event.target.value })}
              />
              <input
                className="focus-ring w-20 rounded-full border border-white/10 px-3 py-2 text-sm"
                placeholder="Cant."
                inputMode="numeric"
                value={line.quantity}
                onChange={(event) => updateLine(line.key, { quantity: event.target.value.replace(/[^\d]/g, "") })}
              />
              <button
                className="focus-ring min-h-10 rounded-full border border-white/10 px-3 py-2 text-xs font-semibold disabled:opacity-40"
                type="button"
                onClick={() => removeLine(line.key)}
                disabled={lines.length === 1}
              >
                Quitar
              </button>
            </div>
          ))}
          {lines.length < 20 && (
            <button className="focus-ring justify-self-start rounded-full border border-white/10 px-3 py-2 text-xs font-semibold" type="button" onClick={addLine}>
              Agregar producto
            </button>
          )}
        </div>
        {stockWarnings.map((warning) => (
          <p key={warning} className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">{warning}</p>
        ))}
        <button className="focus-ring min-h-10 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="submit" disabled={state.sellers.length === 0 || submittingOrder || Boolean(duplicateSellerReference)}>
          {submittingOrder ? "Creando pedido..." : "Crear pedido"}
        </button>
      </form>
      {message && <p className="mt-2 rounded-2xl bg-field px-3 py-2 text-sm text-ink-70">{message}</p>}
    </Card>
  );
}

function SellerPickupPointsPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [sellerId, setSellerId] = useState(state.sellers[0]?.id ?? "");
  const seller = state.sellers.find((item) => item.id === sellerId);
  const [name, setName] = useState(seller?.pickupPointName ?? seller?.name ?? "");
  const [address, setAddress] = useState(seller?.pickupAddress ?? "");
  const [contact, setContact] = useState(seller?.pickupContactName ?? "");
  const [phone, setPhone] = useState(seller?.pickupContactPhone ?? "");
  const [notes, setNotes] = useState(seller?.pickupNotes ?? "");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const current = state.sellers.find((item) => item.id === sellerId);
    setName(current?.pickupPointName ?? current?.name ?? "");
    setAddress(current?.pickupAddress ?? "");
    setContact(current?.pickupContactName ?? "");
    setPhone(current?.pickupContactPhone ?? "");
    setNotes(current?.pickupNotes ?? "");
  }, [sellerId, state.sellers]);

  async function savePickupPoint() {
    if (!seller) return;
    const nextSeller = {
      ...seller,
      pickupPointName: name.trim() || seller.name,
      pickupAddress: address.trim(),
      pickupContactName: contact.trim(),
      pickupContactPhone: phone.trim(),
      pickupNotes: notes.trim()
    };
    const nextState = { ...state, sellers: state.sellers.map((item) => item.id === seller.id ? nextSeller : item) };
    setState(nextState);
    await saveFirestoreState(nextState);
    setMessage("Punto de recogida actualizado.");
  }

  return (
    <Card className="grid gap-2">
      <div>
        <h2 className="font-bold">Puntos de recogida</h2>
        <p className="text-sm text-ink-60">Direccion que vera el lider y el mensajero para agrupar rutas.</p>
      </div>
      <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
        {state.sellers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Nombre del punto" value={name} onChange={(event) => setName(event.target.value)} />
      <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Direccion de recogida" value={address} onChange={(event) => setAddress(event.target.value)} />
      <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Contacto" value={contact} onChange={(event) => setContact(event.target.value)} />
      <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Telefono contacto" value={phone} onChange={(event) => setPhone(event.target.value)} />
      <textarea className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Notas de recogida" value={notes} onChange={(event) => setNotes(event.target.value)} />
      <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={!seller} onClick={() => void savePickupPoint()}>
        Guardar punto
      </button>
      {message && <p className="rounded-2xl bg-field px-3 py-2 text-xs font-semibold text-ink-70">{message}</p>}
    </Card>
  );
}

function AdminUsersPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("seller");
  const [leaderDriverId, setLeaderDriverId] = useState("");
  const [linkSellerId, setLinkSellerId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const accounts = readAccounts();
  const sellersForLink = [...state.sellers].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Card>
      <h2 className="mb-3 font-bold">Usuarios y accesos</h2>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitting(true);
          void createUserFromAdmin(state, { name, email, password, role, leaderDriverId, linkedSellerId: linkSellerId || undefined })
            .then((result) => {
              if (result.error) {
                setMessage(result.error);
                return;
              }
              setState(result.state);
              setName("");
              setEmail("");
              setPassword("");
              setRole("seller");
              setLeaderDriverId("");
              setLinkSellerId("");
          setMessage(`Cuenta ${roleLabel(result.account.role)} lista para ${result.account.email}`);
            })
            .finally(() => setSubmitting(false));
        }}
      >
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Nombre" value={name} onChange={(event) => setName(event.target.value)} required />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Contrasena temporal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} />
        {/*
          Aqui NO va "Lider de comunidad", y no es un olvido: esta alta solo crea una cuenta con
          un rol. Un lider de comunidad necesita ademas su comunidad y la reserva de su enlace,
          y eso solo lo hace `createCommunityLeader` en una sola operacion (formulario "Crear
          lider de comunidad", en Comunidades). Anadirlo a esta lista por simetria crearia un
          lider sin comunidad: entraria a un panel que le pide un `communityId` que no existe.
        */}
        <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={role} onChange={(event) => { setRole(event.target.value as Role); setLinkSellerId(""); }}>
          <option value="seller">Vendedor</option>
          <option value="seller_logistics">Logistico de tienda (sin finanzas)</option>
          <option value="driver">Lider logistico</option>
          <option value="messenger">Mensajero</option>
          <option value="admin">Administrador</option>
        </select>
        {(role === "seller" || role === "seller_logistics") && (
          <label className="grid gap-1 text-xs text-ink-60">
            {role === "seller_logistics" ? "Tienda a la que pertenece (obligatorio)" : "Vincular a tienda existente (opcional)"}
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={linkSellerId} onChange={(event) => setLinkSellerId(event.target.value)} required={role === "seller_logistics"}>
              <option value="">{role === "seller_logistics" ? "Selecciona la tienda" : "Crear vendedor nuevo"}</option>
              {sellersForLink.map((seller) => <option key={seller.id} value={seller.id}>{seller.name} ({seller.id})</option>)}
            </select>
          </label>
        )}
        {role === "messenger" && (
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={leaderDriverId} onChange={(event) => setLeaderDriverId(event.target.value)} required>
            <option value="">Selecciona lider logistico</option>
            {state.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
          </select>
        )}
        <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="submit" disabled={submitting}>Crear usuario</button>
      </form>
      {message && <p className="mt-2 rounded-2xl bg-field px-3 py-2 text-sm text-ink-70">{message}</p>}
      <div className="mt-4 grid gap-2">
        <h3 className="text-sm font-bold">Cuentas locales</h3>
        {accounts.length === 0 && <p className="text-sm text-ink-60">No hay cuentas creadas.</p>}
        {accounts.map((account) => (
          <div key={account.id} className="rounded-2xl border border-white/10 p-2 text-sm">
            <p className="font-semibold">{account.name}</p>
            <p className="text-ink-60">{account.email} · {roleLabel(account.role)}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function copInputValue(value: number | undefined, fallback: number) {
  return String(value ?? fallback);
}

function parseCopInput(value: string, fallback: number) {
  const parsed = Number(value.replace(/[^\d]/g, ""));
  return parsed > 0 ? parsed : fallback;
}

/**
 * Quien cobra en efectivo no genera 4x1000, porque no hay transferencia que gravar. Es una marca
 * por cuenta y no una lista fija en el codigo: la forma de pago cambia, y cuando cambie no debe
 * hacer falta un despliegue para que las liquidaciones dejen de descontar de mas.
 */
function PaymentMethodPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cuentas: Array<{ key: string; collection: "sellers" | "drivers" | "suppliers"; id: string; name: string; group: string; paysInCash: boolean }> = [
    ...state.sellers.map((item) => ({ key: `s-${item.id}`, collection: "sellers" as const, id: item.id, name: item.name, group: "Tiendas", paysInCash: Boolean(item.paysInCash) })),
    ...state.drivers.map((item) => ({ key: `d-${item.id}`, collection: "drivers" as const, id: item.id, name: item.name, group: "Domiciliarios", paysInCash: Boolean(item.paysInCash) })),
    ...state.suppliers.map((item) => ({ key: `p-${item.id}`, collection: "suppliers" as const, id: item.id, name: item.name, group: "Proveedores", paysInCash: Boolean(item.paysInCash) }))
  ];
  const enEfectivo = cuentas.filter((cuenta) => cuenta.paysInCash).length;

  const alternar = async (cuenta: (typeof cuentas)[number]) => {
    const siguiente = !cuenta.paysInCash;
    setSaving(cuenta.key);
    setError(null);
    try {
      if (firebaseEnabled()) await saveFirestorePaysInCash(cuenta.collection, cuenta.id, siguiente);
      setState({
        ...state,
        sellers: cuenta.collection === "sellers" ? state.sellers.map((item) => (item.id === cuenta.id ? { ...item, paysInCash: siguiente } : item)) : state.sellers,
        drivers: cuenta.collection === "drivers" ? state.drivers.map((item) => (item.id === cuenta.id ? { ...item, paysInCash: siguiente } : item)) : state.drivers,
        suppliers: cuenta.collection === "suppliers" ? state.suppliers.map((item) => (item.id === cuenta.id ? { ...item, paysInCash: siguiente } : item)) : state.suppliers
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la forma de pago.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <div className="mb-3">
        <h2 className="font-bold">Forma de pago y 4x1000</h2>
        <p className="text-sm text-ink-60">
          A quien se le paga por transferencia se le retiene el 4x1000 (0,4%) al cerrar el corte.
          Marca &quot;efectivo&quot; en las cuentas que cobran en mano: esas no llevan retencion.
          {enEfectivo > 0 && ` Hoy hay ${enEfectivo} en efectivo.`}
        </p>
      </div>
      {error && <p className="mb-3 rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
      <div className="grid gap-3">
        {["Tiendas", "Domiciliarios", "Proveedores"].map((grupo) => {
          const items = cuentas.filter((cuenta) => cuenta.group === grupo);
          if (items.length === 0) return null;
          return (
            <div key={grupo} className="grid gap-2">
              <p className="text-xs font-semibold uppercase text-ink-60">{grupo}</p>
              {items.map((cuenta) => (
                <div key={cuenta.key} className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 px-3 py-2">
                  <span className="min-w-0 truncate text-sm font-semibold">{cuenta.name}</span>
                  <button
                    className={`focus-ring shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${cuenta.paysInCash ? "bg-acid text-deep" : "border border-white/10 text-ink-60 hover:bg-field"}`}
                    type="button"
                    disabled={saving === cuenta.key}
                    aria-pressed={cuenta.paysInCash}
                    onClick={() => void alternar(cuenta)}
                  >
                    {saving === cuenta.key ? "Guardando..." : cuenta.paysInCash ? "Efectivo · sin 4x1000" : "Transferencia · 4x1000"}
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ZonesTariffsPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [polygonLabel, setPolygonLabel] = useState("");
  const [sellerDeliveredFeeCop, setSellerDeliveredFeeCop] = useState(String(state.settings.sellerDeliveredFeeCop));
  const [sellerFailedFeeCop, setSellerFailedFeeCop] = useState(String(state.settings.sellerFailedFeeCop));
  const [driverDeliveredPayCop, setDriverDeliveredPayCop] = useState(String(state.settings.driverDeliveredPayCop));
  const [driverFailedPayCop, setDriverFailedPayCop] = useState(String(state.settings.driverFailedPayCop));
  const [fulfillmentFeeCop, setFulfillmentFeeCop] = useState(String(state.settings.fulfillmentFeeCop));
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activeCity = state.cities.find((city) => city.id === state.settings.activeCityId) ?? state.cities[0];
  const zones = state.zones.filter((zone) => zone.cityId === (activeCity?.id ?? state.settings.activeCityId));

  const resetForm = () => {
    setEditingZoneId(null);
    setName("");
    setPolygonLabel("");
    setSellerDeliveredFeeCop(String(state.settings.sellerDeliveredFeeCop));
    setSellerFailedFeeCop(String(state.settings.sellerFailedFeeCop));
    setDriverDeliveredPayCop(String(state.settings.driverDeliveredPayCop));
    setDriverFailedPayCop(String(state.settings.driverFailedPayCop));
    setFulfillmentFeeCop(String(state.settings.fulfillmentFeeCop));
  };

  const upsertZone = () => {
    if (!name.trim() && !editingZoneId) return;
    const zoneId = editingZoneId ?? undefined;
    const existing = zoneId ? state.zones.find((zone) => zone.id === zoneId) : undefined;
    const zone = {
      id: existing?.id ?? `zone-${Date.now()}`,
      cityId: existing?.cityId ?? activeCity?.id ?? state.settings.activeCityId,
      name: (name.trim() || existing?.name || "Zona").trim(),
      polygonLabel: (polygonLabel.trim() || existing?.polygonLabel || "Sin referencia").trim(),
      active: existing?.active ?? true,
      sellerDeliveredFeeCop: parseCopInput(sellerDeliveredFeeCop, state.settings.sellerDeliveredFeeCop),
      sellerFailedFeeCop: parseCopInput(sellerFailedFeeCop, state.settings.sellerFailedFeeCop),
      driverDeliveredPayCop: parseCopInput(driverDeliveredPayCop, state.settings.driverDeliveredPayCop),
      driverFailedPayCop: parseCopInput(driverFailedPayCop, state.settings.driverFailedPayCop),
      fulfillmentFeeCop: parseCopInput(fulfillmentFeeCop, state.settings.fulfillmentFeeCop)
    };
    const nextState = {
      ...state,
      zones: existing ? state.zones.map((item) => item.id === existing.id ? zone : item) : [zone, ...state.zones]
    };
    const commit = () => {
      setState(nextState);
      setMessage(existing ? `Zona ${zone.name} actualizada.` : `Zona ${zone.name} creada.`);
      resetForm();
    };
    setSaving(true);
    if (firebaseEnabled()) {
      void saveFirestoreZone(zone)
        .then(commit)
        .catch(() => setMessage("No se pudo guardar la zona en Live. Intenta nuevamente."))
        .finally(() => setSaving(false));
      return;
    }
    commit();
    setSaving(false);
  };

  const loadZone = (zoneId: string) => {
    const zone = state.zones.find((item) => item.id === zoneId);
    if (!zone) return;
    setEditingZoneId(zone.id);
    setName(zone.name);
    setPolygonLabel(zone.polygonLabel);
    setSellerDeliveredFeeCop(copInputValue(zone.sellerDeliveredFeeCop, state.settings.sellerDeliveredFeeCop));
    setSellerFailedFeeCop(copInputValue(zone.sellerFailedFeeCop, state.settings.sellerFailedFeeCop));
    setDriverDeliveredPayCop(copInputValue(zone.driverDeliveredPayCop, state.settings.driverDeliveredPayCop));
    setDriverFailedPayCop(copInputValue(zone.driverFailedPayCop, state.settings.driverFailedPayCop));
    setFulfillmentFeeCop(copInputValue(zone.fulfillmentFeeCop, state.settings.fulfillmentFeeCop));
    setMessage(`Editando ${zone.name}.`);
  };

  const toggleZone = (zoneId: string) => {
    const zone = state.zones.find((item) => item.id === zoneId);
    if (!zone) return;
    const nextZone = { ...zone, active: zone.active === false };
    const nextState = {
      ...state,
      zones: state.zones.map((item) => item.id === zoneId ? nextZone : item)
    };
    const commit = () => {
      setState(nextState);
      setMessage(`${zone.name} ${zone.active === false ? "activada" : "desactivada"}.`);
    };
    setSaving(true);
    if (firebaseEnabled()) {
      void saveFirestoreZone(nextZone)
        .then(commit)
        .catch(() => setMessage("No se pudo guardar el estado de la zona en Live. Intenta nuevamente."))
        .finally(() => setSaving(false));
      return;
    }
    commit();
    setSaving(false);
  };

  return (
    <Card>
      <h2 className="mb-3 font-bold">Zonas y tarifas</h2>
      <div className="grid gap-2">
        {editingZoneId && <p className="rounded-2xl bg-field px-3 py-2 text-sm font-semibold">Editando zona seleccionada</p>}
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Nombre de zona
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" placeholder="Ej. Sur Cali" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Barrios o referencia
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" placeholder="Ej. Ciudad Jardin, Valle del Lili, Caney" value={polygonLabel} onChange={(event) => setPolygonLabel(event.target.value)} />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Cobro al vendedor por entrega
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={sellerDeliveredFeeCop} onChange={(event) => setSellerDeliveredFeeCop(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Cobro al vendedor por fallido
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={sellerFailedFeeCop} onChange={(event) => setSellerFailedFeeCop(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Pago al lider logistico por entrega
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={driverDeliveredPayCop} onChange={(event) => setDriverDeliveredPayCop(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Pago al lider logistico por fallido
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={driverFailedPayCop} onChange={(event) => setDriverFailedPayCop(event.target.value)} />
          </label>
        </div>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Cobro adicional por bodega / fulfillment
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={fulfillmentFeeCop} onChange={(event) => setFulfillmentFeeCop(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={saving} onClick={() => upsertZone()}>
            {saving ? "Guardando..." : editingZoneId ? "Guardar cambios" : "Crear zona"}
          </button>
          {editingZoneId && (
            <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={resetForm}>
              Cancelar
            </button>
          )}
        </div>
      </div>
      {message && <p className="mt-2 rounded-2xl bg-field px-3 py-2 text-sm text-ink-70">{message}</p>}
      <div className="mt-4 grid gap-2">
        {zones.length === 0 && <p className="text-sm text-ink-60">No hay zonas creadas.</p>}
        {zones.map((zone) => (
          <div key={zone.id} className="rounded-2xl border border-white/10 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{zone.name}</p>
                <p className="text-ink-60">{zone.polygonLabel}</p>
              </div>
              <span className={`rounded-2xl px-2 py-1 text-xs font-semibold ${zone.active === false ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                {zone.active === false ? "inactiva" : "activa"}
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-60">
              Vendedor <span className="tabular">{formatCop(zone.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop)}</span> / <span className="tabular">{formatCop(zone.sellerFailedFeeCop || state.settings.sellerFailedFeeCop)}</span> · Driver <span className="tabular">{formatCop(zone.driverDeliveredPayCop || state.settings.driverDeliveredPayCop)}</span> / <span className="tabular">{formatCop(zone.driverFailedPayCop || state.settings.driverFailedPayCop)}</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="focus-ring rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-field disabled:opacity-50" type="button" disabled={saving} onClick={() => loadZone(zone.id)}>Editar</button>
              <button className="focus-ring rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-field disabled:opacity-50" type="button" disabled={saving} onClick={() => toggleZone(zone.id)}>{zone.active === false ? "Activar" : "Desactivar"}</button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AdminInventoryPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState(state.sellers[0]?.id ?? "");
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [available, setAvailable] = useState("");
  const [reserved, setReserved] = useState("0");
  const [minStock, setMinStock] = useState("0");
  const [location, setLocation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lowStock = state.inventory.filter((item) => item.available - item.reserved <= (item.minStock ?? 0));

  useEffect(() => {
    if (!sellerId && state.sellers[0]) setSellerId(state.sellers[0].id);
  }, [sellerId, state.sellers]);

  const reset = () => {
    setEditingId(null);
    setSellerId(state.sellers[0]?.id ?? "");
    setSku("");
    setName("");
    setAvailable("");
    setReserved("0");
    setMinStock("0");
    setLocation("");
  };

  const load = (item: InventoryItem) => {
    setEditingId(item.id);
    setSellerId(item.sellerId);
    setSku(item.sku);
    setName(item.name);
    setAvailable(String(item.available));
    setReserved(String(item.reserved));
    setMinStock(String(item.minStock ?? 0));
    setLocation(item.location ?? "");
    setMessage(`Editando ${item.name}.`);
  };

  const save = () => {
    if (!sellerId || !sku.trim() || !name.trim()) {
      setMessage("Selecciona vendedor, SKU y nombre.");
      return;
    }
    const currentAvailable = parseCopInput(available, 0);
    const currentReserved = editingId ? Math.max(0, Number(reserved.replace(/[^\d]/g, "")) || 0) : 0;
    const item: InventoryItem = {
      id: editingId ?? `inv-${Date.now()}`,
      sellerId,
      sku: sku.trim().toUpperCase(),
      name: name.trim(),
      available: currentAvailable,
      reserved: Math.min(currentReserved, currentAvailable),
      minStock: Math.max(0, Number(minStock.replace(/[^\d]/g, "")) || 0),
      location: location.trim() || undefined
    };
    const duplicate = state.inventory.find((entry) => entry.id !== item.id && entry.sellerId === item.sellerId && entry.sku === item.sku);
    if (duplicate) {
      setMessage("Ya existe ese SKU para el vendedor.");
      return;
    }
    setSaving(true);
    const nextState = {
      ...state,
      inventory: editingId ? state.inventory.map((entry) => entry.id === editingId ? item : entry) : [item, ...state.inventory]
    };
    const commit = () => {
      setState(nextState);
      setMessage(editingId ? `${item.name} actualizado.` : `${item.name} creado.`);
      reset();
    };
    if (firebaseEnabled()) {
      void saveFirestoreInventoryItem(item)
        .then(commit)
        .catch(() => setMessage("No se pudo guardar el producto en Live. Intenta nuevamente."))
        .finally(() => setSaving(false));
      return;
    }
    commit();
    setSaving(false);
  };

  return (
    <Card>
      <h2 className="mb-3 font-bold">Inventario admin</h2>
      {lowStock.length > 0 && (
        <div className="mb-3 grid gap-2">
          {lowStock.map((item) => (
            <p key={item.id} className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">
              Bajo stock: {item.name} · {item.available - item.reserved} disponibles
            </p>
          ))}
        </div>
      )}
      <div className="grid gap-2">
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Vendedor
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
            <option value="">Seleccionar vendedor</option>
            {state.sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            SKU
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={sku} onChange={(event) => setSku(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Producto
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Stock fisico total
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={available} onChange={(event) => setAvailable(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Reservado por pedidos abiertos
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg disabled:bg-field disabled:text-ink-60" disabled={!editingId} inputMode="numeric" value={editingId ? reserved : "0"} onChange={(event) => setReserved(event.target.value)} />
            <span className="text-[11px] font-normal text-ink-60">{editingId ? "Solo ajustar para corregir reservas reales." : "Al crear producto inicia en 0; los pedidos lo aumentan automaticamente."}</span>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Minimo alerta
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" inputMode="numeric" value={minStock} onChange={(event) => setMinStock(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Ubicacion bodega
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={location} onChange={(event) => setLocation(event.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={saving} onClick={save}>{saving ? "Guardando..." : editingId ? "Guardar producto" : "Crear producto"}</button>
          {editingId && <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={reset}>Cancelar</button>}
        </div>
      </div>
      {message && <p className="mt-2 rounded-2xl bg-field px-3 py-2 text-sm text-ink-70">{message}</p>}
      <div className="mt-4">
        <PaginatedList items={state.inventory} pageSize={10} empty={<p className="text-sm text-ink-60">No hay productos registrados.</p>}>
          {(item) => {
          const seller = state.sellers.find((entry) => entry.id === item.sellerId);
          const free = item.available - item.reserved;
          return (
            <div key={item.id} className="rounded-2xl border border-white/10 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{item.name}</p>
                  <p className="text-ink-60">{item.sku} · {seller?.name ?? item.sellerId}</p>
                  {item.location && <p className="text-xs text-ink-60">Ubicacion: {item.location}</p>}
                </div>
                <p className={`text-right font-bold ${free <= (item.minStock ?? 0) ? "text-rust" : "text-mint"}`}>{free} disponibles</p>
              </div>
              <p className="mt-2 text-xs text-ink-60">Stock fisico {item.available} · Reservado por pedidos {item.reserved} · Minimo {item.minStock ?? 0}</p>
              <button className="focus-ring mt-2 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-field" type="button" onClick={() => load(item)}>Editar</button>
            </div>
          );
        }}
        </PaginatedList>
      </div>
    </Card>
  );
}

function reconcileInventoryReservationsLocal(state: AppState): AppState {
  return { ...state, inventory: recomputeInventoryReservations(state.inventory, state.orders) };
}

function SupplierProductAdminPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [supplierName, setSupplierName] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [sellerId, setSellerId] = useState(state.sellers[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState(state.suppliers[0]?.id ?? "");
  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [cost, setCost] = useState("");
  const [costConfigured, setCostConfigured] = useState(true);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const detectedProducts = useMemo(() => buildUnassociatedProductRows(state), [state]);

  useEffect(() => {
    if (!sellerId && state.sellers[0]) setSellerId(state.sellers[0].id);
    if (!supplierId && state.suppliers[0]) setSupplierId(state.suppliers[0].id);
  }, [sellerId, supplierId, state.sellers, state.suppliers]);

  const saveSupplier = () => {
    if (!supplierName.trim()) {
      setMessage("Escribe el nombre del proveedor.");
      return;
    }
    const now = new Date().toISOString();
    const supplier: Supplier = {
      id: `sup-${Date.now()}`,
      name: supplierName.trim(),
      phone: supplierPhone.trim() || undefined,
      active: true,
      createdAt: now,
      updatedAt: now
    };
    const nextState = { ...state, suppliers: [supplier, ...state.suppliers] };
    setSaving(true);
    const commit = () => {
      setState(nextState);
      setSupplierName("");
      setSupplierPhone("");
      setSupplierId(supplier.id);
      setMessage(`Proveedor ${supplier.name} creado.`);
    };
    if (firebaseEnabled()) {
      void saveFirestoreSupplier(supplier).then(commit).catch(() => setMessage("No se pudo guardar el proveedor en Live.")).finally(() => setSaving(false));
      return;
    }
    commit();
    setSaving(false);
  };

  const resetProduct = () => {
    setEditingProductId(null);
    setProductName("");
    setSku("");
    setCost("");
    setCostConfigured(true);
  };

  const loadProduct = (product: ProductCatalogItem) => {
    setEditingProductId(product.id);
    setSellerId(product.sellerId);
    setSupplierId(product.supplierId);
    setProductName(product.name);
    setSku(product.sku ?? "");
    setCost(String(product.productCostCop));
    setCostConfigured(product.productCostConfigured);
    setMessage(`Editando ${product.name}.`);
  };

  const saveProduct = () => {
    if (!sellerId || !supplierId || !productName.trim()) {
      setMessage("Selecciona tienda, proveedor y nombre de producto.");
      return;
    }
    const now = new Date().toISOString();
    const item: ProductCatalogItem = {
      id: editingProductId ?? `prd-${Date.now()}`,
      sellerId,
      supplierId,
      sku: sku.trim() ? sku.trim().toUpperCase() : undefined,
      name: productName.trim(),
      normalizedProductName: normalizeProductName(productName),
      productCostCop: costConfigured ? parseCopInput(cost, 0) : 0,
      productCostConfigured: costConfigured,
      active: true,
      createdAt: state.productCatalog.find((product) => product.id === editingProductId)?.createdAt ?? now,
      updatedAt: now
    };
    const duplicate = state.productCatalog.find((product) =>
      product.id !== item.id &&
      product.sellerId === item.sellerId &&
      ((item.sku && product.sku === item.sku) || (!item.sku && product.normalizedProductName === item.normalizedProductName))
    );
    if (duplicate) {
      setMessage("Ya existe una asociacion para ese producto en esta tienda.");
      return;
    }
    const productCostEntries = buildMissingProductCostEntries(state, item);
    const nextState = {
      ...state,
      productCatalog: editingProductId ? state.productCatalog.map((product) => product.id === item.id ? item : product) : [item, ...state.productCatalog],
      wallet: [...productCostEntries, ...state.wallet]
    };
    setSaving(true);
    const combinedSkuWarning = item.sku?.includes(" + ") ? " Ojo: ese parece un SKU combinado; el costo se cobra por SKU individual — asocia cada SKU por separado." : "";
    const commit = () => {
      setState(nextState);
      setMessage(`${item.name} guardado.${productCostEntries.length > 0 ? ` Se agrego costo producto a ${productCostEntries.length} pedido(s) sin liquidar.` : ""}${combinedSkuWarning}`);
      resetProduct();
    };
    if (firebaseEnabled()) {
      void saveFirestoreProductCatalogItem(item)
        .then(() => saveFirestoreWalletEntries(productCostEntries))
        .then(commit)
        .catch(() => setMessage("No se pudo guardar el producto en Live."))
        .finally(() => setSaving(false));
      return;
    }
    commit();
    setSaving(false);
  };

  return (
    <Card>
      <h2 className="mb-3 font-bold">Productos y proveedores</h2>
      <div className="mb-4 rounded-2xl border border-rust/20 bg-rust/5 p-3">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Productos sin asociar</p>
            <p className="text-sm text-ink-60">Detectados desde pedidos sincronizados.</p>
          </div>
          <span className="rounded-2xl bg-panel px-2 py-1 text-xs font-semibold text-rust">{detectedProducts.length} pendientes</span>
        </div>
        <PaginatedList items={detectedProducts} pageSize={8} empty={<p className="text-sm text-ink-60">No hay productos pendientes por asociar.</p>}>
          {(row) => (
            <div key={row.key} className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-panel p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">{row.productName}</p>
                <p className="text-ink-60">{row.sellerName} · {row.sku || "Sin SKU"} · {row.orderCount} pedidos · {row.quantity} unidades</p>
                <p className="text-xs text-ink-60">Ultimo pedido: {new Date(row.lastOrderAt).toLocaleDateString("es-CO")}</p>
                {row.sources.length > 0 && <p className="text-xs text-ink-60">Aparece en: {row.sources.join(" · ")}</p>}
              </div>
              <button className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep" type="button" onClick={() => {
                setEditingProductId(null);
                setSellerId(row.sellerId);
                setProductName(row.productName);
                setSku(row.sku ?? "");
                setCost("");
                setCostConfigured(true);
              }}>
                Asociar
              </button>
            </div>
          )}
        </PaginatedList>
      </div>
      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="grid content-start gap-2">
          <p className="text-sm font-semibold">Proveedor</p>
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Nombre proveedor" value={supplierName} onChange={(event) => setSupplierName(event.target.value)} />
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Telefono" value={supplierPhone} onChange={(event) => setSupplierPhone(event.target.value)} />
          <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={saving} onClick={saveSupplier}>Crear proveedor</button>
          <PaginatedList items={state.suppliers} pageSize={8} empty={<p className="text-sm text-ink-60">No hay proveedores creados.</p>}>
            {(supplier) => (
              <div key={supplier.id} className="rounded-2xl border border-white/10 p-2 text-sm">
                <p className="font-semibold">{supplier.name}</p>
                {supplier.phone && <p className="text-ink-60">{supplier.phone}</p>}
              </div>
            )}
          </PaginatedList>
        </div>
        <div className="grid content-start gap-2">
          <p className="text-sm font-semibold">Catalogo producto</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
              <option value="">Tienda</option>
              {state.sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
            </select>
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">Proveedor</option>
              {state.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Producto" value={productName} onChange={(event) => setProductName(event.target.value)} />
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="SKU opcional" value={sku} onChange={(event) => setSku(event.target.value)} />
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" inputMode="numeric" placeholder="Costo producto COP" value={cost} onChange={(event) => setCost(event.target.value)} />
            <label className="flex items-center gap-2 rounded-2xl border border-white/10 px-3 py-2 text-sm">
              <input type="checkbox" checked={costConfigured} onChange={(event) => setCostConfigured(event.target.checked)} />
              Costo configurado
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={saving} onClick={saveProduct}>{editingProductId ? "Guardar producto" : "Crear producto"}</button>
            {editingProductId && <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={resetProduct}>Cancelar</button>}
          </div>
          <PaginatedList items={state.productCatalog} pageSize={8} empty={<p className="text-sm text-ink-60">No hay productos de catalogo.</p>}>
            {(product) => {
              const seller = state.sellers.find((item) => item.id === product.sellerId);
              const supplier = state.suppliers.find((item) => item.id === product.supplierId);
              return (
                <div key={product.id} className="rounded-2xl border border-white/10 p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{product.name}</p>
                      <p className="text-ink-60">{seller?.name ?? product.sellerId} · {supplier?.name ?? product.supplierId}</p>
                      <p className="text-xs text-ink-60">{product.sku || "Sin SKU"} · {product.productCostConfigured ? `Costo ${formatCop(product.productCostCop)}` : "Costo no configurado"}</p>
                    </div>
                    <button className="focus-ring rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-field" type="button" onClick={() => loadProduct(product)}>Editar</button>
                  </div>
                </div>
              );
            }}
          </PaginatedList>
        </div>
      </div>
      {message && <p className="mt-3 rounded-2xl bg-field px-3 py-2 text-sm text-ink-70">{message}</p>}
    </Card>
  );
}

function InventoryPage({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const totalAvailable = state.inventory.reduce((sum, item) => sum + item.available, 0);
  const totalReserved = state.inventory.reduce((sum, item) => sum + item.reserved, 0);
  const lowStock = state.inventory.filter((item) => item.available - item.reserved <= (item.minStock ?? 0)).length;
  const [reconciling, setReconciling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reconcile = () => {
    setReconciling(true);
    if (firebaseEnabled()) {
      void reconcileFirebaseInventoryReservations()
        .then((result) => {
          setState({ ...state, inventory: result.inventory });
          setMessage("Reservas recalculadas desde los pedidos abiertos.");
        })
        .catch(() => setMessage("No se pudieron recalcular las reservas en Live."))
        .finally(() => setReconciling(false));
      return;
    }
    setState(reconcileInventoryReservationsLocal(state));
    setMessage("Reservas recalculadas desde los pedidos abiertos.");
    setReconciling(false);
  };

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Inventario</h2>
          <p className="text-sm text-ink-60">Control de stock, reservas y ubicaciones de bodega.</p>
        </div>
        <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field disabled:opacity-50" disabled={reconciling} type="button" onClick={reconcile}>
          {reconciling ? "Recalculando..." : "Recalcular reservas"}
        </button>
      </div>
      {message && <p className="rounded-2xl bg-field px-3 py-2 text-sm text-ink-70">{message}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Boxes size={20} />} label="Stock total" value={String(totalAvailable)} />
        <Metric icon={<ClipboardList size={20} />} label="Reservado" value={String(totalReserved)} />
        <Metric icon={<AlertTriangle size={20} />} label="Bajo stock" value={String(lowStock)} />
      </div>
      <SupplierProductAdminPanel state={state} setState={setState} />
      <AdminInventoryPanel state={state} setState={setState} />
    </main>
  );
}

const PAYOUT_STATUS_LABELS: Record<string, string> = {
  requested: "Solicitada",
  approved: "Aprobada",
  paid: "Pagada",
  rejected: "Rechazada"
};

/** Boton de la tienda para pedir su liquidacion. Antes era una funcion pura que no guardaba nada. */
function SellerPayoutRequest({ sellerId, payouts }: { sellerId: string; payouts: PayoutRequest[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const open = payouts.find((payout) => payout.sellerId === sellerId && payout.status === "requested");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await requestFirebaseSellerPayout();
      setDone(true);
    } catch (requestError) {
      // El callable rechaza con motivo (sin saldo liquidable, solicitud ya abierta...). Antes
      // este caso era un no-op silencioso: la tienda pulsaba y no pasaba nada en pantalla.
      setError(requestError instanceof Error ? requestError.message : "No se pudo enviar la solicitud.");
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <p className="mt-3 rounded-2xl bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
        Liquidacion solicitada por <span className="tabular">{formatCop(open.amountCop)}</span> el {formatDateTime(open.createdAt)}. Kentro la esta procesando.
      </p>
    );
  }

  return (
    <div className="mt-3 grid gap-2">
      <button
        className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
        type="button"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? "Enviando..." : "Solicitar liquidacion"}
      </button>
      {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{error}</p>}
      {done && !error && <p className="text-xs font-semibold text-mint">Solicitud enviada.</p>}
    </div>
  );
}

/** Fila de solicitud en el panel del admin. */
function AdminPayoutRow({ payout, sellers }: { payout: PayoutRequest; sellers: Seller[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sellerName = payout.sellerName ?? sellers.find((seller) => seller.id === payout.sellerId)?.name ?? payout.sellerId;

  const reject = async () => {
    const reason = window.prompt(`Motivo para rechazar la solicitud de ${sellerName}:`);
    if (reason === null) return;
    setBusy(true);
    setError("");
    try {
      await rejectFirebaseSellerPayout({ payoutId: payout.id, reason: reason.trim() || undefined });
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : "No se pudo rechazar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-1 rounded-2xl bg-field p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{sellerName} · <span className="tabular">{formatCop(payout.amountCop)}</span></span>
        <span className="text-xs font-semibold text-ink-60">{PAYOUT_STATUS_LABELS[payout.status] ?? payout.status}</span>
      </div>
      <p className="text-xs text-ink-60">
        {formatDateTime(payout.createdAt)}
        {payout.requestedByEmail && ` · ${payout.requestedByEmail}`}
        {typeof payout.eligibleOrderCount === "number" && ` · ${payout.eligibleOrderCount} pedidos`}
      </p>
      {/* Explica por que el monto no es todo el saldo de la tienda. */}
      {Boolean(payout.blockedCop) && (
        <p className="text-xs text-ink-60"><span className="tabular">{formatCop(payout.blockedCop ?? 0)}</span> retenidos: el COD de esos pedidos aun no entra de la flota.</p>
      )}
      {payout.status === "requested" && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {/* El pago real se hace creando el corte en Liquidaciones: es lo unico que estampa
              settlementId en los asientos. La solicitud se cierra sola cuando eso pasa. */}
          <span className="font-semibold text-ink-60">Se cierra al crear el corte en Liquidaciones.</span>
          <button className="font-semibold text-rust disabled:opacity-50" type="button" disabled={busy} onClick={() => void reject()}>
            {busy ? "..." : "Rechazar"}
          </button>
        </div>
      )}
      {payout.status === "rejected" && payout.rejectedReason && (
        <p className="text-xs text-ink-60">Motivo: {payout.rejectedReason}</p>
      )}
      {error && <p className="text-xs font-semibold text-rust">{error}</p>}
    </div>
  );
}

function WalletPanel({ state }: { state: AppState }) {
  const pendingPayouts = state.payouts.filter((payout) => payout.status === "requested");
  const otherPayouts = state.payouts.filter((payout) => payout.status !== "requested");
  return (
    <Card>
      <h2 className="mb-3 font-bold">Wallets vendedores</h2>
      <PaginatedList items={state.sellers} pageSize={8} className="grid gap-3" empty={<p className="text-sm text-ink-60">No hay vendedores registrados todavia.</p>}>
        {(seller) => {
          const balance = sellerBalance(state, seller.id);
          return (
            <div key={seller.id} className="rounded-2xl border border-white/10 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{seller.name}</p>
                  <p className="text-sm text-ink-60">Reserva: <span className="tabular">{formatCop(balance.reservedCop)}</span> · {balance.pendingOrders} pendientes</p>
                </div>
                <p className="text-right font-bold"><span className="tabular">{formatCop(balance.availableCop)}</span></p>
              </div>
              {state.activeRole === "seller" && <SellerPayoutRequest sellerId={seller.id} payouts={state.payouts} />}
              {state.activeRole === "seller" && <StoreTariffCard />}
            </div>
          );
        }}
      </PaginatedList>

      {state.activeRole === "admin" && (
        <div className="mt-4">
          <h3 className="text-sm font-bold">Solicitudes de liquidacion</h3>
          {/* Sin vacio explicito el admin no sabe que este flujo existe: antes la seccion entera
              estaba detras de `payouts.length > 0` y nunca se veia. */}
          {pendingPayouts.length === 0 && (
            <p className="mt-2 text-xs text-ink-60">No hay solicitudes pendientes.</p>
          )}
          {pendingPayouts.length > 0 && (
            <PaginatedList items={pendingPayouts} pageSize={8} className="mt-2 grid gap-2" empty={null}>
              {(payout) => <AdminPayoutRow key={payout.id} payout={payout} sellers={state.sellers} />}
            </PaginatedList>
          )}
          {otherPayouts.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-ink-60">Historico ({otherPayouts.length})</summary>
              <PaginatedList items={otherPayouts} pageSize={8} className="mt-2 grid gap-2" empty={null}>
                {(payout) => <AdminPayoutRow key={payout.id} payout={payout} sellers={state.sellers} />}
              </PaginatedList>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function DashboardWalletCard({ state, ownerType, ownerId, title, collapsible = false, pendingOnly = false }: { state: AppState; ownerType: WalletEntry["ownerType"]; ownerId: string; title: string; collapsible?: boolean; pendingOnly?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  const entries = state.wallet
    .filter((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId)
    // ISO 8601 ordena bien comparando directamente; localeCompare (Intl) es un orden de magnitud
    // mas lento y aqui recorre el ledger completo en cada render.
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const balance = entries.reduce((sum, entry) => sum + entry.amountCop, 0);
  const income = entries.filter((entry) => entry.amountCop > 0).reduce((sum, entry) => sum + entry.amountCop, 0);
  const charges = Math.abs(entries.filter((entry) => entry.amountCop < 0).reduce((sum, entry) => sum + entry.amountCop, 0));

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">{title}</h2>
          <p className="text-sm text-ink-60">{entries.length} movimiento{entries.length === 1 ? "" : "s"} {pendingOnly ? "sin liquidar" : "registrados como referencia contable"}.</p>
        </div>
        <div className="text-right">
          <p className={`text-lg font-bold ${balance < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(balance)}</span></p>
          {collapsible && (
            <button className="focus-ring mt-1 rounded-full border border-white/10 px-2 py-1 text-xs font-semibold text-ink-60 hover:bg-field" type="button" onClick={() => setOpen((current) => !current)}>
              {open ? "Ocultar" : "Ver detalle"}
            </button>
          )}
        </div>
      </div>
      {open && (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-2xl bg-field px-3 py-2">
              <p className="text-xs font-semibold text-ink-60">Entradas</p>
              <p className="font-bold"><span className="tabular">{formatCop(income)}</span></p>
            </div>
            <div className="rounded-2xl bg-field px-3 py-2">
              <p className="text-xs font-semibold text-ink-60">Descuentos</p>
              <p className="font-bold"><span className="tabular">{formatCop(charges)}</span></p>
            </div>
          </div>
          <PaginatedList items={entries.slice(0, 5)} pageSize={8} empty={<p className="text-sm text-ink-60">Aun no hay movimientos de wallet para este usuario.</p>}>
            {(entry) => <WalletEntryRow key={entry.id} entry={entry} state={state} showOwner={false} />}
          </PaginatedList>
        </>
      )}
      {!open && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-2xl bg-field px-3 py-2">
            <p className="text-xs font-semibold text-ink-60">Entradas</p>
            <p className="font-bold"><span className="tabular">{formatCop(income)}</span></p>
          </div>
          <div className="rounded-2xl bg-field px-3 py-2">
            <p className="text-xs font-semibold text-ink-60">Descuentos</p>
            <p className="font-bold"><span className="tabular">{formatCop(charges)}</span></p>
          </div>
        </div>
      )}
    </Card>
  );
}

function WalletHistoryPanel({
  state,
  ownerType,
  ownerId,
  title,
  entriesOverride
}: {
  state: AppState;
  ownerType?: WalletEntry["ownerType"];
  ownerId?: string;
  title: string;
  entriesOverride?: WalletEntry[];
}) {
  const entries = (entriesOverride ?? state.wallet.filter((entry) => (!ownerType || entry.ownerType === ownerType) && (!ownerId || entry.ownerId === ownerId))).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const balance = entries.reduce((sum, entry) => sum + entry.amountCop, 0);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">{title}</h2>
          <p className="text-sm text-ink-60">{entries.length} movimientos</p>
        </div>
        <p className={`text-right font-bold ${balance < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(balance)}</span></p>
      </div>
      <PaginatedList items={entries} pageSize={10} empty={<p className="text-sm text-ink-60">No hay movimientos registrados todavia.</p>}>
        {(entry) => <WalletEntryRow key={entry.id} entry={entry} state={state} showOwner={!ownerId} />}
      </PaginatedList>
    </Card>
  );
}

function WalletEntryRow({ entry, state, showOwner }: { entry: WalletEntry; state: AppState; showOwner: boolean }) {
  const order = state.orders.find((item) => item.id === entry.orderId);
  const owner =
    entry.ownerType === "seller"
      ? state.sellers.find((seller) => seller.id === entry.ownerId)?.name
      : entry.ownerType === "driver"
        ? state.drivers.find((driver) => driver.id === entry.ownerId)?.name
        : "Plataforma";
  return (
    <div className="rounded-2xl border border-white/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{entry.description}</p>
          <p className="text-ink-60">
            {new Date(entry.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}
            {order ? ` · Pedido ${order.shopifyOrderId}` : ""}
            {showOwner ? ` · ${owner ?? entry.ownerId}` : ""}
          </p>
        </div>
        <p className={`font-bold ${entry.amountCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(entry.amountCop)}</span></p>
      </div>
    </div>
  );
}

// Cuantos movimientos historicos se piden de golpe. Ninguna cuenta necesita ver mas de un
// tiron: la mas grande de la operacion acumula ~5.000 y se paginan de 500 en 500.
const WALLET_HISTORY_PAGE_SIZE = 500;

function WalletPage({ state, session }: { state: AppState; session: Session }) {
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  // El estado global solo trae los movimientos PENDIENTES de liquidar; el historial cerrado se
  // pide aqui cuando alguien lo pide de verdad. Antes bajar la wallet completa costaba 8.027
  // documentos en cada sesion para una pantalla que casi nadie abre.
  const [historyEntries, setHistoryEntries] = useState<WalletEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoadedFor, setHistoryLoadedFor] = useState<string | null>(null);

  const scopedOwner = useMemo((): { ownerType: WalletEntry["ownerType"]; ownerId: string } | null => {
    if (session.role === "seller") return { ownerType: "seller", ownerId: session.profileId };
    if (session.role === "driver") return { ownerType: "driver", ownerId: session.profileId };
    if (ownerFilter === "all") return null;
    const [ownerType, ownerId] = ownerFilter.split(":");
    return { ownerType: ownerType as WalletEntry["ownerType"], ownerId };
  }, [session.role, session.profileId, ownerFilter]);

  const scopeKey = scopedOwner ? `${scopedOwner.ownerType}:${scopedOwner.ownerId}` : "";

  const loadHistory = () => {
    if (!scopedOwner || loadingHistory) return;
    setLoadingHistory(true);
    setHistoryError(null);
    void fetchWalletHistoryPage(scopedOwner.ownerType, scopedOwner.ownerId, WALLET_HISTORY_PAGE_SIZE)
      .then((entries) => {
        setHistoryEntries(entries);
        setHistoryLoadedFor(scopeKey);
      })
      .catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "No se pudo cargar el historial."))
      .finally(() => setLoadingHistory(false));
  };

  const walletSource = useMemo(() => {
    const relevantHistory = historyLoadedFor === scopeKey ? historyEntries : [];
    if (relevantHistory.length === 0) return state.wallet;
    const known = new Set(state.wallet.map((entry) => entry.id));
    return [...state.wallet, ...relevantHistory.filter((entry) => !known.has(entry.id))];
  }, [state.wallet, historyEntries, historyLoadedFor, scopeKey]);

  const visibleEntries = useMemo(() => walletSource
    .filter((entry) => {
      if (session.role === "seller") return entry.ownerType === "seller" && entry.ownerId === session.profileId;
      if (session.role === "driver") return entry.ownerType === "driver" && entry.ownerId === session.profileId;
      if (ownerFilter !== "all" && `${entry.ownerType}:${entry.ownerId}` !== ownerFilter) return false;
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      return true;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    [walletSource, session.role, session.profileId, ownerFilter, typeFilter]);

  const balance = visibleEntries.reduce((sum, entry) => sum + entry.amountCop, 0);
  const ownerOptions = [
    { value: "admin:platform", label: "Admin · Plataforma" },
    ...state.sellers.map((seller) => ({ value: `seller:${seller.id}`, label: `Vendedor · ${seller.name}` })),
    ...state.drivers.map((driver) => ({ value: `driver:${driver.id}`, label: `Transportista · ${driver.name}` }))
  ];
  const movementTypes = Array.from(new Set(walletSource.map((entry) => entry.type))).sort();
  const historyLoaded = historyLoadedFor === scopeKey;

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-bold">Wallet</h2>
          <p className="text-sm text-ink-60">Historial de movimientos, saldos y cargos por pedido.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
            type="button"
            disabled={visibleEntries.length === 0}
            onClick={() => void downloadWalletXlsx(visibleEntries, state, `wallet-${session.role === "admin" ? "todos" : session.profileId}-${new Date().toISOString().slice(0, 10)}.xlsx`)}
          >
            <FileDown size={16} />
            Descargar wallet Excel ({visibleEntries.length})
          </button>
          <div className="grid gap-1 rounded-2xl border border-white/10 bg-panel px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-normal text-ink-60">Balance visible</span>
            <span className={`text-xl font-bold ${balance < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(balance)}</span></span>
          </div>
        </div>
      </div>

      <Card>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-60">
            {historyLoaded
              ? `Mostrando lo pendiente mas los ultimos ${WALLET_HISTORY_PAGE_SIZE} movimientos del historial.`
              : "Por defecto se muestran solo los movimientos pendientes de liquidar. El historial cerrado se carga aparte para no descargarlo en cada sesion."}
          </p>
          <button
            className="focus-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
            type="button"
            disabled={!scopedOwner || loadingHistory || historyLoaded}
            title={scopedOwner ? undefined : "Elige una cuenta para ver su historial"}
            onClick={loadHistory}
          >
            <History size={16} />
            {loadingHistory ? "Cargando historial..." : historyLoaded ? "Historial cargado" : "Ver historial completo"}
          </button>
        </div>
        {historyError && <p className="mt-2 rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{historyError}</p>}
      </Card>

      {session.role === "admin" && (
        <Card>
          <div className="grid gap-2 md:grid-cols-2">
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="all">Todos los usuarios</option>
              {ownerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">Todos los tipos</option>
              {movementTypes.map((type) => (
                <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
              ))}
            </select>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:gap-3">
        <Metric className="col-span-2 sm:col-span-1" icon={<Wallet size={20} />} label="Movimientos" value={String(visibleEntries.length)} />
        <Metric icon={<CreditCard size={20} />} label="Entradas" value={formatCop(visibleEntries.filter((entry) => entry.amountCop > 0).reduce((sum, entry) => sum + entry.amountCop, 0))} />
        <Metric icon={<AlertTriangle size={20} />} label="Descuentos" value={formatCop(Math.abs(visibleEntries.filter((entry) => entry.amountCop < 0).reduce((sum, entry) => sum + entry.amountCop, 0)))} />
      </div>

      <WalletHistoryPanel state={{ ...state, wallet: walletSource }} title="Historial de movimientos" ownerType={session.role === "seller" ? "seller" : session.role === "driver" ? "driver" : undefined} ownerId={session.role === "admin" ? undefined : session.profileId} entriesOverride={visibleEntries} />
    </main>
  );
}

type LiquidationRow = {
  id: string;
  name: string;
  role: "seller" | "driver";
  walletEntryIds: string[];
  orderIds: string[];
  orderDetails: LiquidationOrderAudit[];
  orders: number;
  deliveredOrders: number;
  failedOrders: number;
  chargeableFailedOrders: number;
  nonChargeableFailedOrders: number;
  codCop: number;
  feesCop: number;
  deliveryFeeCop: number;
  failedFeeCop: number;
  fulfillmentCop: number;
  productCostCop: number;
  earningsCop: number;
  deliveredPayCop: number;
  failedPayCop: number;
  // Cobro bruto a la tienda, separado del margen: mezclarlos hacia parecer que quedaba
  // mucho mas dinero del que hay (el margen real es ~2.000 por pedido, no el flete entero).
  grossFeesCop: number;
  platformMarginCop: number;
  cashToReturnCop: number;
  abonoCop: number;
  /** Cada abono con su fecha y su nota: el total solo no dice por donde salio la plata. */
  abonoRows: SellerAbonoRow[];
  /** 4x1000 de esos abonos. Va dentro del neto pero no salia en ninguna linea del detalle. */
  abonoGmfCop: number;
  receivableCop: number;
  /** Cobra en efectivo: no se le retiene 4x1000 porque no hay transferencia. */
  paysInCash: boolean;
  /** 4x1000 que se le retendra al pagar. */
  gmfCop: number;
  /** Lo que de verdad se gira: `receivableCop` menos el 4x1000. */
  payoutCop: number;
  netCop: number;
  status: "pendiente" | "conciliada";
};

type LiquidationOrderAudit = {
  orderId: string;
  trackingCode: string;
  shopifyOrderId: string;
  sellerId: string;
  sellerName: string;
  driverId: string;
  driverName: string;
  status: Order["status"];
  failedCategory?: FailedCategory;
  chargeableFailed: boolean;
  paymentMethod: PaymentMethod;
  codCop: number;
  deliveryFeeCop: number;
  failedFeeCop: number;
  fulfillmentCop: number;
  productCostCop: number;
  storeChargeCop: number;
  driverDeliveredPayCop: number;
  driverFailedPayCop: number;
  driverPayCop: number;
  platformMarginCop: number;
  sellerNetCop: number;
  sellerWalletEntryIds: string[];
  driverWalletEntryIds: string[];
  sellerSettlementIds: string[];
  driverSettlementIds: string[];
  codReceived: boolean;
  sellerEligible: boolean;
  reason: string;
};

function isEntryInRange(entry: WalletEntry, startDate: string, endDate: string) {
  const entryDate = entry.createdAt.slice(0, 10);
  return (!startDate || entryDate >= startDate) && (!endDate || entryDate <= endDate);
}

function uniqueOrderCount(entries: WalletEntry[]) {
  return new Set(entries.map((entry) => entry.orderId).filter(Boolean)).size;
}

function countClosedOrders(state: AppState, orderIds: string[]) {
  const orderIdSet = new Set(orderIds);
  const orders = state.orders.filter((order) => orderIdSet.has(order.id));
  return {
    delivered: orders.filter((order) => order.status === "delivered").length,
    failed: orders.filter((order) => order.status === "failed").length,
    chargeableFailed: orders.filter(isChargeableFailedOrder).length,
    nonChargeableFailed: orders.filter((order) => order.status === "failed" && !isChargeableFailedOrder(order)).length
  };
}

function getRelatedSellerEntries(wallet: WalletEntry[], orderIds: string[]) {
  const orderIdSet = new Set(orderIds);
  return wallet.filter((entry) => entry.ownerType === "seller" && entry.orderId && orderIdSet.has(entry.orderId));
}

function getRelatedDriverEntries(wallet: WalletEntry[], orderIds: string[]) {
  const orderIdSet = new Set(orderIds);
  return wallet.filter((entry) => entry.ownerType === "driver" && entry.orderId && orderIdSet.has(entry.orderId));
}

function netAmountCop(entries: WalletEntry[], types: WalletEntry["type"][]) {
  return entries.filter((entry) => types.includes(entry.type)).reduce((sum, entry) => sum + entry.amountCop, 0);
}

function netChargeCop(entries: WalletEntry[], types: WalletEntry["type"][]) {
  const net = entries.filter((entry) => types.includes(entry.type)).reduce((sum, entry) => sum + entry.amountCop, 0);
  return Math.max(0, -net);
}

function orderCashToReturnCop(state: AppState, orderId: string) {
  const sellerEntries = state.wallet.filter((entry) => entry.ownerType === "seller" && entry.orderId === orderId);
  const driverEntries = state.wallet.filter((entry) => entry.ownerType === "driver" && entry.orderId === orderId);
  const codCop = netAmountCop(sellerEntries, ["cod_revenue", "cod_remittance"]);
  const driverPayCop = netAmountCop(driverEntries, ["driver_earning"]);
  return Math.max(0, codCop - driverPayCop);
}

function receivedDriverOrderIds(state: AppState) {
  const orderIds = new Set<string>();
  for (const settlement of state.settlements) {
    if (settlement.kind !== "driver") continue;

    // Fuente autoritativa: cashAllocations, igual que createSettlement en el backend.
    // Sin esto, la pantalla marcaba como elegibles pedidos (p.ej. fallidos) que el backend
    // no liquida, mostrando un saldo por pagar menor al que realmente se cerraba y dejando
    // residuales negativos atascados.
    if (Array.isArray(settlement.cashAllocations) && settlement.cashAllocations.length > 0) {
      for (const allocation of settlement.cashAllocations) {
        if (allocation.covered && allocation.orderId) orderIds.add(allocation.orderId);
      }
      continue;
    }

    if (settlement.status === "paid" || settlement.status === "reconciled" || settlement.cashPendingCop === 0) {
      for (const orderId of settlement.orderIds) orderIds.add(orderId);
      continue;
    }

    // Fallback legacy: settlements sin cashAllocations (datos viejos); reparto por efectivo recibido.
    const receivedCop = (settlement.cashReceipts ?? []).reduce((sum, receipt) => sum + receipt.amountCop, 0);
    if (receivedCop <= 0) continue;

    let remainingCop = receivedCop;
    const sortedOrderIds = [...settlement.orderIds].sort((leftId, rightId) => {
      const left = state.orders.find((order) => order.id === leftId);
      const right = state.orders.find((order) => order.id === rightId);
      return (left?.trackingCode ?? leftId).localeCompare(right?.trackingCode ?? rightId);
    });

    for (const orderId of sortedOrderIds) {
      const requiredCop = orderCashToReturnCop(state, orderId);
      if (requiredCop <= 0) {
        orderIds.add(orderId);
        continue;
      }
      if (remainingCop < requiredCop) break;
      remainingCop -= requiredCop;
      orderIds.add(orderId);
    }
  }
  return orderIds;
}

function buildLiquidationOrderAudits(state: AppState, entries: WalletEntry[] = state.wallet): LiquidationOrderAudit[] {
  const orderIds = new Set(entries.map((entry) => entry.orderId).filter(Boolean) as string[]);
  const codReceivedOrderIds = receivedDriverOrderIds(state);
  // Indices por id: antes esta funcion escaneaba TODOS los movimientos por cada pedido
  // (O(pedidos x movimientos) = ~14M iteraciones, ~600 ms por llamada). Con los indices
  // es O(pedidos + movimientos) y baja a milisegundos.
  const entriesByOrder = new Map<string, WalletEntry[]>();
  for (const entry of entries) {
    if (!entry.orderId) continue;
    const bucket = entriesByOrder.get(entry.orderId);
    if (bucket) bucket.push(entry);
    else entriesByOrder.set(entry.orderId, [entry]);
  }
  const sellerById = new Map(state.sellers.map((item) => [item.id, item]));
  const driverById = new Map(state.drivers.map((item) => [item.id, item]));
  return state.orders
    .flatMap((order): LiquidationOrderAudit[] => {
      const seller = sellerById.get(order.sellerId);
      const driver = order.driverId ? driverById.get(order.driverId) : undefined;
      const allOrderEntries = entriesByOrder.get(order.id) ?? [];
      const hasFinancialEntries = allOrderEntries.some((entry) =>
        ["cod_revenue", "delivery_fee", "failed_fee", "fulfillment_fee", "product_cost", "driver_earning"].includes(entry.type)
      );
      if (!orderIds.has(order.id) || (!hasFinancialEntries && order.status !== "delivered" && order.status !== "failed" && order.status !== "liquidated")) {
        return [];
      }
      const sellerEntries = allOrderEntries.filter((entry) => entry.ownerType === "seller");
      const driverEntries = allOrderEntries.filter((entry) => entry.ownerType === "driver");
      const codCop = netAmountCop(sellerEntries, ["cod_revenue", "cod_remittance"]);
      const deliveryFeeCop = netChargeCop(sellerEntries, ["delivery_fee"]);
      const failedFeeCop = netChargeCop(sellerEntries, ["failed_fee"]);
      const fulfillmentCop = netChargeCop(sellerEntries, ["fulfillment_fee"]);
      const productCostCop = netChargeCop(sellerEntries, ["product_cost"]);
      const storeChargeCop = deliveryFeeCop + failedFeeCop + fulfillmentCop + productCostCop;
      const driverDeliveredPayCop = driverEntries
        .filter((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("entregado"))
        .reduce((sum, entry) => sum + entry.amountCop, 0);
      const driverFailedPayCop = driverEntries
        .filter((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("fallido"))
        .reduce((sum, entry) => sum + entry.amountCop, 0);
      const driverPayCop = netAmountCop(driverEntries, ["driver_earning"]);
      const codReceived = order.paymentMethod === "prepaid" || codReceivedOrderIds.has(order.id);
      const sellerEligible = isOrderEligibleForSellerSettlement(order, codReceivedOrderIds);
      return [{
        orderId: order.id,
        trackingCode: order.trackingCode ?? order.id,
        shopifyOrderId: order.shopifyOrderId,
        sellerId: order.sellerId,
        sellerName: seller?.name ?? order.sellerId,
        driverId: order.driverId ?? "unassigned",
        driverName: driver?.name ?? "Sin domiciliario",
        status: order.status,
        failedCategory: order.failedCategory,
        chargeableFailed: isChargeableFailedOrder(order),
        paymentMethod: order.paymentMethod,
        codCop,
        deliveryFeeCop,
        failedFeeCop,
        fulfillmentCop,
        productCostCop,
        storeChargeCop,
        driverDeliveredPayCop,
        driverFailedPayCop,
        driverPayCop,
        platformMarginCop: deliveryFeeCop + failedFeeCop + fulfillmentCop - driverPayCop,
        sellerNetCop: codCop - storeChargeCop,
        sellerWalletEntryIds: sellerEntries.map((entry) => entry.id),
        driverWalletEntryIds: driverEntries.map((entry) => entry.id),
        sellerSettlementIds: Array.from(new Set(sellerEntries.map((entry) => entry.settlementId).filter(Boolean) as string[])),
        driverSettlementIds: Array.from(new Set(driverEntries.map((entry) => entry.settlementId).filter(Boolean) as string[])),
        codReceived,
        sellerEligible,
        reason: sellerEligible
          ? order.status === "failed" ? "Habilitado para tienda (fallido, sin COD por recaudar)" : "Habilitado para tienda"
          : "Pendiente marcar dinero recibido del domiciliario"
      }];
    })
    .sort((left, right) => left.sellerName.localeCompare(right.sellerName) || left.trackingCode.localeCompare(right.trackingCode));
}

function auditsForOrderIds(audits: LiquidationOrderAudit[], orderIds: string[]) {
  const orderIdSet = new Set(orderIds);
  return audits.filter((audit) => orderIdSet.has(audit.orderId));
}

function isSellerEntryEligible(entry: WalletEntry, auditByOrderId: Map<string, LiquidationOrderAudit>) {
  if (entry.ownerType !== "seller") return true;
  // Los abonos a tienda no dependen de un pedido: siempre reducen el saldo por pagar.
  // Ni los abonos ni el 4x1000 cuelgan de un pedido: no pasan por la compuerta de COD recibido.
  if (entry.type === "seller_abono" || entry.type === "gmf_tax") return true;
  if (!entry.orderId) return false;
  return auditByOrderId.get(entry.orderId)?.sellerEligible ?? false;
}

function buildLiquidationRows(state: AppState, entries: WalletEntry[], relatedWallet: WalletEntry[] = state.wallet, audits: LiquidationOrderAudit[] = buildLiquidationOrderAudits(state, relatedWallet)): LiquidationRow[] {
  const sellerRows = state.sellers.map((seller) => {
    const ownEntries = entries.filter((entry) => entry.ownerType === "seller" && entry.ownerId === seller.id);
    const orderIds = Array.from(new Set(ownEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
    const orderDetails = auditsForOrderIds(audits, orderIds);
    const closedCounts = countClosedOrders(state, orderIds);
    const codCop = ownEntries.filter((entry) => entry.type === "cod_revenue").reduce((sum, entry) => sum + entry.amountCop, 0);
    const deliveryFeeCop = netChargeCop(ownEntries, ["delivery_fee"]);
    const failedFeeCop = netChargeCop(ownEntries, ["failed_fee"]);
    const fulfillmentCop = netChargeCop(ownEntries, ["fulfillment_fee"]);
    const productCostCop = netChargeCop(ownEntries, ["product_cost"]);
    const feesCop = deliveryFeeCop + failedFeeCop + fulfillmentCop;
    const abonoCop = -ownEntries.filter((entry) => entry.type === "seller_abono").reduce((sum, entry) => sum + entry.amountCop, 0);
    const netCop = ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0);
    return {
      id: seller.id,
      name: seller.name,
      role: "seller" as const,
      walletEntryIds: ownEntries.map((entry) => entry.id),
      orderIds,
      orderDetails,
      orders: uniqueOrderCount(ownEntries),
      deliveredOrders: closedCounts.delivered,
      failedOrders: closedCounts.failed,
      chargeableFailedOrders: closedCounts.chargeableFailed,
      nonChargeableFailedOrders: closedCounts.nonChargeableFailed,
      codCop,
      feesCop,
      deliveryFeeCop,
      failedFeeCop,
      fulfillmentCop,
      productCostCop,
      earningsCop: 0,
      deliveredPayCop: 0,
      failedPayCop: 0,
      grossFeesCop: feesCop,
      // Margen real de los pedidos de esta tienda: lo cobrado menos lo pagado al
      // domiciliario por esos mismos pedidos. Antes se ponia feesCop (el cobro bruto).
      platformMarginCop: feesCop - orderDetails.reduce((sum, audit) => sum + audit.driverPayCop, 0),
      cashToReturnCop: 0,
      abonoCop,
      abonoRows: sellerAbonoRows(ownEntries),
      abonoGmfCop: netChargeCop(ownEntries, ["gmf_tax"]),
      receivableCop: Math.max(0, netCop),
      paysInCash: Boolean(seller.paysInCash),
      gmfCop: gmfForPayout(Math.max(0, netCop), seller.paysInCash),
      payoutCop: netAfterGmf(Math.max(0, netCop), seller.paysInCash),
      netCop,
      status: netCop === 0 ? "conciliada" as const : "pendiente" as const
    };
  });

  const driverRows = state.drivers.map((driver) => {
    const ownEntries = entries.filter((entry) => entry.ownerType === "driver" && entry.ownerId === driver.id);
    const orderIds = Array.from(new Set(ownEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
    const orderDetails = auditsForOrderIds(audits, orderIds);
    const closedCounts = countClosedOrders(state, orderIds);
    const relatedSellerEntries = getRelatedSellerEntries(relatedWallet, orderIds);
    const codCop = relatedSellerEntries.filter((entry) => entry.type === "cod_revenue").reduce((sum, entry) => sum + entry.amountCop, 0);
    const deliveryFeeCop = netChargeCop(relatedSellerEntries, ["delivery_fee"]);
    const failedFeeCop = netChargeCop(relatedSellerEntries, ["failed_fee"]);
    const fulfillmentCop = netChargeCop(relatedSellerEntries, ["fulfillment_fee"]);
    const productCostCop = netChargeCop(relatedSellerEntries, ["product_cost"]);
    const feesCop = deliveryFeeCop + failedFeeCop + fulfillmentCop;
    const deliveredPayCop = ownEntries.filter((entry) => entry.description.toLowerCase().includes("entregado")).reduce((sum, entry) => sum + entry.amountCop, 0);
    const failedPayCop = ownEntries.filter((entry) => entry.description.toLowerCase().includes("fallido")).reduce((sum, entry) => sum + entry.amountCop, 0);
    const earningsCop = ownEntries.filter((entry) => entry.type === "driver_earning").reduce((sum, entry) => sum + entry.amountCop, 0);
    const netCop = earningsCop - codCop;
    return {
      id: driver.id,
      name: driver.name,
      role: "driver" as const,
      walletEntryIds: ownEntries.map((entry) => entry.id),
      orderIds,
      orderDetails,
      orders: uniqueOrderCount(ownEntries),
      deliveredOrders: closedCounts.delivered,
      failedOrders: closedCounts.failed,
      chargeableFailedOrders: closedCounts.chargeableFailed,
      nonChargeableFailedOrders: closedCounts.nonChargeableFailed,
      codCop,
      feesCop,
      deliveryFeeCop,
      failedFeeCop,
      fulfillmentCop,
      productCostCop,
      earningsCop,
      deliveredPayCop,
      failedPayCop,
      grossFeesCop: feesCop,
      platformMarginCop: feesCop - earningsCop,
      cashToReturnCop: Math.max(0, codCop - earningsCop),
      abonoCop: 0,
      abonoRows: [],
      abonoGmfCop: 0,
      receivableCop: Math.max(0, earningsCop - codCop),
      paysInCash: Boolean(driver.paysInCash),
      gmfCop: gmfForPayout(Math.max(0, earningsCop - codCop), driver.paysInCash),
      payoutCop: netAfterGmf(Math.max(0, earningsCop - codCop), driver.paysInCash),
      netCop,
      status: netCop === 0 ? "conciliada" as const : "pendiente" as const
    };
  });

  return [...sellerRows, ...driverRows].filter((row) => row.orders > 0 || row.netCop !== 0);
}

type StoreLiquidationRow = {
  sellerId: string;
  sellerName: string;
  shopDomain: string;
  orders: number;
  deliveredOrders: number;
  failedOrders: number;
  codCop: number;
  deliveryFeeCop: number;
  failedFeeCop: number;
  fulfillmentCop: number;
  productCostCop: number;
  totalChargedCop: number;
  sellerBalanceCop: number;
  connectedStores: number;
};

type SupplierLiquidationRow = {
  supplierId: string;
  supplierName: string;
  walletEntryIds: string[];
  orderIds: string[];
  sellers: string[];
  orders: number;
  productCostCop: number;
  paysInCash: boolean;
  gmfCop: number;
  payoutCop: number;
  entries: WalletEntry[];
};

function buildStoreLiquidationRows(state: AppState, entries: WalletEntry[]): StoreLiquidationRow[] {
  return state.sellers
    .map((seller) => {
      const ownEntries = entries.filter((entry) => entry.ownerType === "seller" && entry.ownerId === seller.id);
      const orderIds = Array.from(new Set(ownEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
      const closedCounts = countClosedOrders(state, orderIds);
      const deliveryFeeCop = netChargeCop(ownEntries, ["delivery_fee"]);
      const failedFeeCop = netChargeCop(ownEntries, ["failed_fee"]);
      const fulfillmentCop = netChargeCop(ownEntries, ["fulfillment_fee"]);
      const productCostCop = netChargeCop(ownEntries, ["product_cost"]);
      const connectedStores = (state.shopifyStores ?? []).filter((store) => store.sellerId === seller.id).length;
      return {
        sellerId: seller.id,
        sellerName: seller.name,
        shopDomain: seller.shopDomain || (state.shopifyStores ?? []).find((store) => store.sellerId === seller.id)?.shopDomain || "Sin tienda conectada",
        orders: uniqueOrderCount(ownEntries),
        deliveredOrders: closedCounts.delivered,
        failedOrders: closedCounts.failed,
        codCop: ownEntries.filter((entry) => entry.type === "cod_revenue").reduce((sum, entry) => sum + entry.amountCop, 0),
        deliveryFeeCop,
        failedFeeCop,
        fulfillmentCop,
        productCostCop,
        totalChargedCop: deliveryFeeCop + failedFeeCop + fulfillmentCop + productCostCop,
        sellerBalanceCop: ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0),
        connectedStores
      };
    })
    .filter((row) => row.orders > 0 || row.sellerBalanceCop !== 0)
    .sort((left, right) => right.orders - left.orders || left.sellerName.localeCompare(right.sellerName));
}

function buildSupplierLiquidationRows(state: AppState, entries: WalletEntry[]): SupplierLiquidationRow[] {
  const sellerNameById = new Map(state.sellers.map((seller) => [seller.id, seller.name]));
  return state.suppliers
    .map((supplier) => {
      const ownEntries = entries.filter((entry) =>
        entry.ownerType === "seller" &&
        entry.type === "product_cost" &&
        entry.supplierId === supplier.id &&
        !entry.supplierSettlementId
      );
      const orderIds = Array.from(new Set(ownEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
      const sellerIds = Array.from(new Set(ownEntries.map((entry) => entry.ownerId).filter(Boolean)));
      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        walletEntryIds: ownEntries.map((entry) => entry.id),
        orderIds,
        sellers: sellerIds.map((sellerId) => sellerNameById.get(sellerId) ?? sellerId).sort((left, right) => left.localeCompare(right)),
        orders: orderIds.length,
        productCostCop: Math.max(0, -ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0)),
        paysInCash: Boolean(supplier.paysInCash),
        gmfCop: gmfForPayout(Math.max(0, -ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0)), supplier.paysInCash),
        payoutCop: netAfterGmf(Math.max(0, -ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0)), supplier.paysInCash),
        entries: ownEntries
      };
    })
    .filter((row) => row.productCostCop > 0)
    .sort((left, right) => right.productCostCop - left.productCostCop || left.supplierName.localeCompare(right.supplierName));
}

function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function downloadFailedOrdersCsv(orders: Order[], state: AppState, startDate: string, endDate: string, sellerFilter: string) {
  const rows = buildOrderExportRows(orders, state).map((row) => orderExportColumns.map((column) => row[column]));
  const header = [...orderExportColumns];
  const csv = [header, ...rows].map((line) => line.map(csvValue).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fallidos-${sellerFilter === "all" ? "todos" : sellerFilter}-${startDate || "inicio"}-${endDate || "hoy"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function paymentMethodLabel(method: PaymentMethod) {
  return method === "cod" ? "Contraentrega" : "Pagado";
}

const driverHistoryExportColumns = [
  "guia_knt",
  "referencia_shopify",
  "tienda",
  "cliente",
  "estado",
  "mensajero",
  "fecha_cierre",
  "metodo_pago",
  "valor_cod",
  "categoria_fallido",
  "motivo",
  "evidencia",
  "ultima_nota",
  "cerrado_por",
  "id_pedido"
] as const;

async function downloadDriverHistoryXlsx(orders: Order[], state: AppState, driverId: string, startDate: string, endDate: string) {
  const rows = orders.map((order) => {
    const seller = state.sellers.find((item) => item.id === order.sellerId);
    const messenger = state.messengers.find((item) => item.id === order.messengerId);
    const closingEvidence = latestClosingEvidence(order);
    return {
      guia_knt: order.trackingCode ?? order.id,
      referencia_shopify: order.shopifyOrderId,
      tienda: seller?.name ?? knownSellerName(order.sellerId),
      cliente: order.customerName,
      estado: statusLabel(order.status),
      mensajero: messenger?.name ?? (order.messengerId ? order.messengerId : "Lider logistico"),
      fecha_cierre: orderClosedAt(order),
      metodo_pago: paymentMethodLabel(order.paymentMethod),
      valor_cod: order.paymentMethod === "cod" ? order.totalCop : 0,
      categoria_fallido: order.status === "failed" ? failedCategoryLabel(order.failedCategory) : "",
      motivo: order.failedReason ?? closingEvidence?.reason ?? "",
      evidencia: closingEvidence?.photoUrl ?? closingEvidence?.photoLabel ?? "",
      ultima_nota: closingEvidence?.note ?? "",
      cerrado_por: closingEvidence?.actorId ?? "",
      id_pedido: order.id
    };
  });
  await downloadRowsXlsx("Historico flota", driverHistoryExportColumns, rows, `historico-flota-${driverId}-${startDate || "inicio"}-${endDate || "hoy"}.xlsx`);
}

function downloadLiquidationsCsv(rows: LiquidationRow[], storeRows: StoreLiquidationRow[], orderAudits: LiquidationOrderAudit[], blockedAudits: LiquidationOrderAudit[], startDate: string, endDate: string) {
  const totalSellerFees = orderAudits.reduce((sum, audit) => sum + audit.deliveryFeeCop + audit.failedFeeCop + audit.fulfillmentCop, 0);
  const totalDriverPay = orderAudits.reduce((sum, audit) => sum + audit.driverPayCop, 0);
  const platformMargin = totalSellerFees - totalDriverPay;
  const header = ["tipo", "nombre", "ordenes", "entregados", "fallidos", "cod_recaudado", "cobro_entrega_tienda", "cobro_fallido_tienda", "fulfillment", "costo_producto", "cargos_operativos", "pago_entregados_domiciliario", "pago_fallidos_domiciliario", "total_pago_domiciliario", "margen_operativo_plataforma", "debe_entregar", "saldo_a_recibir", "forma_pago", "gmf_4x1000", "a_girar", "neto", "estado"];
  const body = rows.map((row) => [
    row.role === "seller" ? "vendedor" : "transportista",
    row.name,
    row.orders,
    row.deliveredOrders,
    row.failedOrders,
    row.codCop,
    row.deliveryFeeCop,
    row.failedFeeCop,
    row.fulfillmentCop,
    row.productCostCop,
    row.feesCop,
    row.deliveredPayCop,
    row.failedPayCop,
    row.earningsCop,
    row.platformMarginCop,
    row.cashToReturnCop,
    row.receivableCop,
    row.paysInCash ? "efectivo" : "transferencia",
    row.gmfCop,
    row.payoutCop,
    row.netCop,
    row.status
  ]);
  const summary = [
    [],
    ["resumen", "margen operativo plataforma", "", "", "", "", "", "", "", "", totalSellerFees, "", "", totalDriverPay, platformMargin, "", "", "", "", "", "", ""]
  ];
  const storeHeader = ["tienda", "vendedor", "dominio", "ordenes", "entregados", "fallidos", "cod_recaudado", "cobro_entrega_tienda", "cobro_fallido_tienda", "fulfillment", "costo_producto", "total_descontado_tienda", "saldo_a_pagar_tienda", "tiendas_conectadas"];
  const storeBody = storeRows.map((row) => [
    row.sellerName,
    row.sellerId,
    row.shopDomain,
    row.orders,
    row.deliveredOrders,
    row.failedOrders,
    row.codCop,
    row.deliveryFeeCop,
    row.failedFeeCop,
    row.fulfillmentCop,
    row.productCostCop,
    row.totalChargedCop,
    row.sellerBalanceCop,
    row.connectedStores
  ]);
  const orderHeader = ["guia", "shopify", "pedido_id", "tienda", "domiciliario", "estado", "metodo_pago", "cod", "cobro_entrega_tienda", "cobro_fallido_tienda", "fulfillment", "costo_producto", "total_descontado_tienda", "pago_entregado_domiciliario", "pago_fallido_domiciliario", "total_pago_domiciliario", "margen_operativo_plataforma", "a_pagar_tienda", "cod_recibido_domiciliario", "tienda_habilitada", "nota"];
  const orderBody = orderAudits.map((audit) => [
    audit.trackingCode,
    audit.shopifyOrderId,
    audit.orderId,
    audit.sellerName,
    audit.driverName,
    statusLabel(audit.status),
    audit.paymentMethod,
    audit.codCop,
    audit.deliveryFeeCop,
    audit.failedFeeCop,
    audit.fulfillmentCop,
    audit.productCostCop,
    audit.storeChargeCop,
    audit.driverDeliveredPayCop,
    audit.driverFailedPayCop,
    audit.driverPayCop,
    audit.platformMarginCop,
    audit.sellerNetCop,
    audit.codReceived ? "si" : "no",
    audit.sellerEligible ? "si" : "no",
    audit.reason
  ]);
  const blockedBody = blockedAudits.map((audit) => [
    audit.trackingCode,
    audit.shopifyOrderId,
    audit.orderId,
    audit.sellerName,
    audit.driverName,
    statusLabel(audit.status),
    audit.paymentMethod,
    audit.codCop,
    audit.deliveryFeeCop,
    audit.failedFeeCop,
    audit.fulfillmentCop,
    audit.productCostCop,
    audit.storeChargeCop,
    audit.driverDeliveredPayCop,
    audit.driverFailedPayCop,
    audit.driverPayCop,
    audit.platformMarginCop,
    audit.sellerNetCop,
    audit.codReceived ? "si" : "no",
    audit.sellerEligible ? "si" : "no",
    audit.reason
  ]);
  const csv = [
    header,
    ...body,
    ...summary,
    [],
    ["registro por tienda"],
    storeHeader,
    ...storeBody,
    [],
    ["auditoria por pedido"],
    orderHeader,
    ...orderBody,
    [],
    ["pedidos cod no habilitados para tienda"],
    orderHeader,
    ...blockedBody
  ].map((line) => line.map(csvValue).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `liquidaciones-${startDate || "inicio"}-${endDate || "hoy"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const LIQUIDATION_TABS = [
  { id: "payable" as const, label: "Por pagar" },
  { id: "closed" as const, label: "Cortes cerrados" },
  { id: "period" as const, label: "Resumen del periodo" }
];
type LiquidationTab = (typeof LIQUIDATION_TABS)[number]["id"];

function LiquidationsPage({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [liqTab, setLiqTab] = useState<LiquidationTab>("payable");
  const today = dateValue(new Date());
  const weekAgo = dateValue(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cashReceiptTarget, setCashReceiptTarget] = useState<{ settlement: Settlement; pendingCop: number } | null>(null);
  const [abonoTarget, setAbonoTarget] = useState<{ sellerId: string; sellerName: string; receivableCop: number } | null>(null);
  // Confirmacion antes de cerrar: un corte no se deshace y antes salia con un solo clic.
  const [payTarget, setPayTarget] = useState<{ row: LiquidationRow; chargeGmf: boolean } | null>(null);
  // Cobro al domiciliario: la plata entra, no sale. Va por su propio modal porque el de pago
  // (SettlementConfirmModal) muestra "saldo a pagar" y 4x1000, y en este caso ambos son cero.
  const [collectTarget, setCollectTarget] = useState<LiquidationRow | null>(null);
  const [paySupplierTarget, setPaySupplierTarget] = useState<SupplierLiquidationRow | null>(null);
  // Cashback del lider de comunidad (RF_49). Va por su propia fila y su propio estado: meterlo en
  // `LiquidationRow` obligaria a ensanchar su `role: "seller" | "driver"`, que gobierna una
  // quincena de ramas de render y de acciones. Mismo precedente que los proveedores.
  const [payCommunityLeaderTarget, setPayCommunityLeaderTarget] = useState<CommunityLeaderLiquidationRow | null>(null);
  // Confirmacion de exito: un corte con neto cero no cambia ninguna cifra de la pantalla, asi que
  // sin este mensaje el admin no tiene forma de saber que se hizo algo.
  const [communityLeaderMessage, setCommunityLeaderMessage] = useState<string | null>(null);
  // LO PENDIENTE POR LIQUIDAR NO SE FILTRA POR FECHA. Antes todo colgaba de `rangeEntries`, con
  // un rango por defecto de 7 dias: cualquier movimiento sin liquidar mas viejo quedaba invisible
  // en las filas Y fuera del corte, porque el rango tambien viajaba al callable. Un corte es el
  // total de lo que se debe, no lo que se debe de esta semana.
  //
  // "Abierto" incluye dos pendientes independientes: lo no liquidado con la tienda/domiciliario
  // (`!settlementId`) y lo no pagado al proveedor (`!supplierSettlementId`). Un product_cost puede
  // estar ya liquidado con la tienda y seguir pendiente con el proveedor, asi que el segundo caso
  // no se puede derivar del primero.
  const { rows, sellerRows, driverRows, storeRows, supplierRows, communityLeaderRows, blockedSellerAudits, openAudits } = useMemo(() => {
    const openEntries = selectOpenWalletEntries(state.wallet);
    const audits = buildLiquidationOrderAudits(state, openEntries);
    const auditByOrderId = new Map(audits.map((audit) => [audit.orderId, audit]));

    const pendingEntries = openEntries.filter((entry) => !entry.settlementId);
    const eligiblePendingSellerEntries = pendingEntries.filter(
      (entry) => entry.ownerType === "seller" && isSellerEntryEligible(entry, auditByOrderId)
    );
    // Un costo de producto ya liquidado con la tienda paso la compuerta de COD en ese corte, asi
    // que sigue habilitado para el proveedor sin necesidad de releer el pedido (que puede ser muy
    // anterior a la ventana de descarga). Solo se vuelve a evaluar lo que aun no paso por corte.
    const supplierPendingEntries = openEntries.filter(
      (entry) =>
        entry.ownerType === "seller" &&
        entry.type === "product_cost" &&
        !entry.supplierSettlementId &&
        (Boolean(entry.settlementId) || isSellerEntryEligible(entry, auditByOrderId))
    );

    const driverLiquidationRows = buildLiquidationRows(state, pendingEntries.filter((entry) => entry.ownerType === "driver"), state.wallet, audits).filter((row) => row.role === "driver");
    const sellerLiquidationRows = buildLiquidationRows(state, eligiblePendingSellerEntries, state.wallet, audits).filter((row) => row.role === "seller");
    const pendingSellerOrderIds = new Set(pendingEntries.filter((entry) => entry.ownerType === "seller").map((entry) => entry.orderId).filter(Boolean) as string[]);

    return {
      rows: [...sellerLiquidationRows, ...driverLiquidationRows],
      sellerRows: sellerLiquidationRows,
      driverRows: driverLiquidationRows,
      storeRows: buildStoreLiquidationRows(state, eligiblePendingSellerEntries),
      supplierRows: buildSupplierLiquidationRows(state, supplierPendingEntries),
      // El cashback del lider no pasa por la compuerta de COD de las tiendas: es margen ya
      // causado al cerrar el pedido, no plata que haya que esperar del domiciliario. Se le pasan
      // los asientos abiertos tal cual porque el constructor ya descarta lo que tiene
      // `settlementId`; volver a filtrarlo aqui solo daria dos sitios donde equivocarse.
      communityLeaderRows: buildCommunityLeaderLiquidationRows(state.communities, openEntries),
      blockedSellerAudits: audits.filter((audit) => pendingSellerOrderIds.has(audit.orderId) && audit.paymentMethod === "cod" && !audit.sellerEligible),
      openAudits: audits
    };
    // Dependencias por PORCION, no `state` entero. `state` cambia de identidad en cada emision
    // de Firestore (tambien por colecciones que esto no mira: inventario, catalogo, auditoria...)
    // y cada recalculo cuesta ~169 ms medidos. Con el ledger completo cargado eso encadenaba
    // recalculos hasta congelar la pestana.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.wallet, state.orders, state.sellers, state.drivers, state.settlements, state.suppliers, state.communities, state.shopifyStores, state.zones, state.settings]);

  // El rango de fechas SOLO alimenta el resumen del periodo; no toca lo pendiente.
  //
  // Se calcula desde los asientos, no desde `state.orders`: los pedidos se descargan por ventana,
  // asi que derivarlo de ellos hacia que "Ver todo" mostrara solo el tramo cuyos pedidos seguian
  // en memoria. Tampoco se aplica aqui la compuerta de elegibilidad de pago: esto es "cuanto se
  // movio en el periodo", no "cuanto se puede pagar hoy" (eso son las filas de arriba).
  const { periodSummary, rangeStoreRows } = useMemo(() => {
    const rangeEntries = state.wallet.filter((entry) => isEntryInRange(entry, startDate, endDate));
    const ordersById = new Map(state.orders.map((order) => [order.id, order]));
    return {
      periodSummary: summarizeWalletPeriod(rangeEntries, ordersById),
      rangeStoreRows: buildStoreLiquidationRows(state, rangeEntries.filter((entry) => entry.ownerType === "seller"))
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.wallet, state.orders, state.sellers, state.shopifyStores, startDate, endDate]);

  const closedSettlements = useMemo(
    () => [...state.settlements].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    [state.settlements]
  );

  const totalCod = periodSummary.codCop;
  const totalSellerFees = periodSummary.sellerFeesCop;
  const totalDriverPay = periodSummary.driverPayCop;
  const totalDeliveredOrders = periodSummary.deliveredOrders;
  const totalFailedOrders = periodSummary.failedOrders;
  const totalDeliveryFees = periodSummary.deliveryFeeCop;
  const totalFailedFees = periodSummary.failedFeeCop;
  const totalFulfillmentFees = periodSummary.fulfillmentCop;
  const totalDeliveredPay = periodSummary.deliveredPayCop;
  const totalFailedPay = periodSummary.failedPayCop;
  const totalDriverCashToReturn = driverRows.reduce((sum, row) => sum + row.cashToReturnCop, 0);
  // Los totales de cabecera son lo que SALE de la cuenta, ya con el 4x1000 descontado: es la
  // cifra con la que se compara el extracto del banco.
  const totalDriverReceivable = driverRows.reduce((sum, row) => sum + row.payoutCop, 0);
  const totalSellerPayable = sellerRows.reduce((sum, row) => sum + row.payoutCop, 0);
  const totalSupplierPayable = supplierRows.reduce((sum, row) => sum + row.payoutCop, 0);
  // NETO, sin recortar a cero: una reversa de cashback resta, y un total negativo significa que
  // los lideres deben mas de lo que se les debe. Taparlo con un Math.max mostraria plata que no
  // hay que girar.
  const totalCommunityLeaderPayable = communityLeaderRows.reduce((sum, row) => sum + row.cashbackCop, 0);
  const totalBlockedSellerPayable = blockedSellerAudits.reduce((sum, audit) => sum + Math.max(0, audit.sellerNetCop), 0);
  const platformMargin = periodSummary.platformMarginCop;
  const totalPending = rows.reduce((sum, row) => sum + Math.abs(row.netCop), 0);

  const mergeSettlement = (settlement: Settlement, walletEntries: WalletEntry[]) => {
    setState({
      ...state,
      settlements: [settlement, ...state.settlements.filter((item) => item.id !== settlement.id)],
      wallet: mergeWalletEntries(state.wallet, walletEntries)
    });
  };

  const updateSettlement = (settlement: Settlement) => {
    setState({
      ...state,
      settlements: state.settlements.map((item) => item.id === settlement.id ? settlement : item)
    });
  };

  const registerDriverCashReceipt = async (settlement: Settlement, amountCop: number, note?: string) => {
    const { settlement: updatedSettlement, walletEntries } = await recordFirebaseDriverCashReceipt({
      settlementId: settlement.id,
      receivedNowCop: amountCop,
      // El backend rechaza note: "" (min 1 caracter); solo se envia si hay texto.
      note: note?.trim() || undefined
    });
    mergeSettlement(updatedSettlement, walletEntries);
  };

  const registerSellerAbono = async (sellerId: string, amountCop: number, note: string | undefined, chargeGmf: boolean) => {
    const { walletEntry, gmfEntry } = await recordFirebaseSellerAbono({
      sellerId,
      amountCop,
      note: note?.trim() || undefined,
      chargeGmf
    });
    // El asiento del 4x1000 llega suelto (sin corte) para que el siguiente lo barra.
    const nuevos = gmfEntry ? [walletEntry, gmfEntry] : [walletEntry];
    setState({ ...state, wallet: mergeWalletEntries(state.wallet, nuevos) });
  };

  const closeRow = (row: LiquidationRow, chargeGmf?: boolean, note?: string) => {
    // Rango abierto a proposito: el corte tiene que llevarse TODO lo pendiente de la cuenta, que es
    // exactamente lo que muestra la fila. Mandar el rango de la pantalla dejaba fuera lo anterior
    // (y ademas recortaba el dia en curso, porque endDate es fecha local y createdAt es UTC).
    setBusyId(`${row.role}-${row.id}`);
    setError(null);
    void createFirebaseSettlement({ kind: row.role, ownerId: row.id, startDate: "", endDate: "", chargeGmf, note })
      .then(async ({ settlement, walletEntries }) => {
        if (row.role === "driver" && row.cashToReturnCop > 0) {
          mergeSettlement(settlement, walletEntries);
          setCashReceiptTarget({ settlement, pendingCop: row.cashToReturnCop });
          return;
        }
        const { settlement: paidSettlement } = await updateFirebaseSettlementStatus({ settlementId: settlement.id, status: "paid" });
        mergeSettlement(paidSettlement, walletEntries);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo cerrar la liquidacion."))
      .finally(() => setBusyId(null));
  };

  /**
   * Cobro al domiciliario que quedo debiendo efectivo.
   *
   * Crea el corte y registra el recaudo seguido, para que el admin escriba el valor UNA vez y
   * antes de nada irreversible. Admite parciales: `recordDriverCashReceipt` acumula recibos y solo
   * pasa el corte a `paid` cuando no queda pendiente.
   */
  const collectFromDriver = (row: LiquidationRow, amountCop: number, note?: string) => {
    setBusyId(`${row.role}-${row.id}`);
    setError(null);
    // chargeGmf: false — el 4x1000 grava la plata que sale del banco, y aqui esta entrando.
    void createFirebaseSettlement({ kind: "driver", ownerId: row.id, startDate: "", endDate: "", chargeGmf: false, note })
      .then(async ({ settlement, walletEntries }) => {
        try {
          const receipt = await recordFirebaseDriverCashReceipt({
            settlementId: settlement.id,
            receivedNowCop: amountCop,
            // El backend rechaza note: "" (min 1 caracter); solo se envia si hay texto.
            note: note?.trim() || undefined
          });
          // Un solo merge con los asientos de los dos pasos: `mergeSettlement` parte del `state` del
          // closure, asi que encadenar dos llamadas dejaria fuera los asientos del corte.
          mergeSettlement(receipt.settlement, [...walletEntries, ...receipt.walletEntries]);
          setCollectTarget(null);
        } catch (reason: unknown) {
          // El corte ya existe: se recupera desde "Cerrados" con "Registrar recaudo".
          mergeSettlement(settlement, walletEntries);
          setCollectTarget(null);
          const detalle = reason instanceof Error ? reason.message : "error desconocido";
          setError(`El corte se creo pero no se pudo registrar el recaudo (${detalle}). Registralo desde la pestana Cerrados.`);
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo cerrar el corte del domiciliario."))
      .finally(() => setBusyId(null));
  };

  const closeSupplierRow = (row: SupplierLiquidationRow, chargeGmf?: boolean, note?: string) => {
    if (row.walletEntryIds.length === 0) {
      setError("No hay movimientos pendientes para este proveedor.");
      return;
    }
    setBusyId(`supplier-${row.supplierId}`);
    setError(null);
    // Los ids explicitos ya acotan el corte; el rango va abierto igual que en closeRow.
    void createFirebaseSettlement({
      kind: "supplier",
      ownerId: row.supplierId,
      startDate: "",
      endDate: "",
      walletEntryIds: row.walletEntryIds,
      chargeGmf,
      note
    })
      .then(async ({ settlement, walletEntries }) => {
        const { settlement: paidSettlement } = await updateFirebaseSettlementStatus({ settlementId: settlement.id, status: "paid" });
        mergeSettlement(paidSettlement, walletEntries);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo pagar al proveedor."))
      .finally(() => setBusyId(null));
  };

  /**
   * Corte del cashback pendiente de una comunidad (RF_49).
   *
   * Los ids de asiento viajan explicitos, como en el proveedor: son exactamente los que pinta la
   * fila, asi que lo que se sella es lo que se vio. El rango va abierto porque un corte es todo lo
   * que se debe, no lo de esta semana.
   */
  const closeCommunityLeaderRow = (row: CommunityLeaderLiquidationRow, chargeGmf?: boolean, note?: string) => {
    if (row.walletEntryIds.length === 0) {
      setError("No hay cashback pendiente para esta comunidad.");
      return;
    }
    setBusyId(`community_leader-${row.communityId}`);
    setError(null);
    setCommunityLeaderMessage(null);
    void createFirebaseSettlement({
      kind: "community_leader",
      ownerId: row.communityId,
      startDate: "",
      endDate: "",
      walletEntryIds: row.walletEntryIds,
      chargeGmf,
      note
    })
      .then(async ({ settlement, walletEntries }) => {
        // Solo se marca pagado lo que de verdad sale del banco. Con neto cero (un cashback y su
        // reversa que se netean) o negativo no hay giro, pero el corte se crea igual para que esos
        // asientos dejen de estar pendientes; queda como pendiente en "Cortes cerrados".
        if (row.cashbackCop <= 0) {
          mergeSettlement(settlement, walletEntries);
          setCommunityLeaderMessage(`Corte creado para ${row.communityName} sin giro (neto ${formatCop(row.cashbackCop)}). Queda pendiente en Cortes cerrados.`);
          return;
        }
        const { settlement: paidSettlement } = await updateFirebaseSettlementStatus({ settlementId: settlement.id, status: "paid" });
        mergeSettlement(paidSettlement, walletEntries);
        setCommunityLeaderMessage(`Cashback girado a ${row.leaderName} (${row.communityName}): ${formatCop(paidSettlement.netCop)}.`);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo girar el cashback del lider."))
      .finally(() => setBusyId(null));
  };

  const changeStatus = (settlement: Settlement, status: "paid" | "reconciled", paidAmountCop?: number) => {
    setBusyId(`${settlement.id}-${status}`);
    setError(null);
    void updateFirebaseSettlementStatus({ settlementId: settlement.id, status, paidAmountCop })
      .then(({ settlement: updatedSettlement }) => updateSettlement(updatedSettlement))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo actualizar la liquidacion."))
      .finally(() => setBusyId(null));
  };

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5">
      {cashReceiptTarget && (
        <DriverCashReceiptModal
          settlement={cashReceiptTarget.settlement}
          pendingCop={cashReceiptTarget.pendingCop}
          busy={busyId === `${cashReceiptTarget.settlement.id}-cash`}
          error={error}
          onClose={() => setCashReceiptTarget(null)}
          onSave={(amountCop, note) => {
            const target = cashReceiptTarget.settlement;
            setBusyId(`${target.id}-cash`);
            setError(null);
            void registerDriverCashReceipt(target, amountCop, note)
              .then(() => setCashReceiptTarget(null))
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo registrar el recaudo."))
              .finally(() => setBusyId(null));
          }}
        />
      )}
      {collectTarget && (
        <DriverCashCollectModal
          driverName={collectTarget.name}
          cashToReturnCop={collectTarget.cashToReturnCop}
          orders={collectTarget.orders}
          busy={busyId === `${collectTarget.role}-${collectTarget.id}`}
          error={error}
          onCancel={() => setCollectTarget(null)}
          onConfirm={(amountCop, note) => collectFromDriver(collectTarget, amountCop, note)}
        />
      )}
      {abonoTarget && (
        <SellerAbonoModal
          sellerName={abonoTarget.sellerName}
          receivableCop={abonoTarget.receivableCop}
          paysInCash={Boolean(state.sellers.find((item) => item.id === abonoTarget.sellerId)?.paysInCash)}
          busy={busyId === `abono-${abonoTarget.sellerId}`}
          error={error}
          onClose={() => setAbonoTarget(null)}
          onSave={(amountCop, note, chargeGmf) => {
            const target = abonoTarget;
            setBusyId(`abono-${target.sellerId}`);
            setError(null);
            void registerSellerAbono(target.sellerId, amountCop, note, chargeGmf)
              .then(() => setAbonoTarget(null))
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo registrar el abono."))
              .finally(() => setBusyId(null));
          }}
        />
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-bold">Liquidaciones</h2>
          <p className="text-sm text-ink-60">Total pendiente por liquidar, acumulado y sin filtrar por fecha.</p>
        </div>
        <button
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
          type="button"
          disabled={rows.length === 0}
          onClick={() => downloadLiquidationsCsv(rows, storeRows, openAudits, blockedSellerAudits, startDate, endDate)}
        >
          <FileDown size={16} />
          Exportar CSV
        </button>
      </div>

      {payTarget && (
        <SettlementConfirmModal
          title={payTarget.row.role === "seller" ? "Pagar a la tienda" : "Cerrar corte del domiciliario"}
          accountName={payTarget.row.name}
          receivableCop={payTarget.row.receivableCop}
          paysInCash={payTarget.row.paysInCash}
          initialChargeGmf={payTarget.chargeGmf}
          allowGmfToggle={payTarget.row.receivableCop > 0}
          busy={busyId === `${payTarget.row.role}-${payTarget.row.id}`}
          error={error}
          confirmLabel={payTarget.row.role === "seller" ? "Pagar tienda" : "Cerrar corte"}
          onCancel={() => setPayTarget(null)}
          onConfirm={(chargeGmf, note) => {
            const target = payTarget;
            setPayTarget(null);
            closeRow(target.row, chargeGmf, note);
          }}
        />
      )}
      {paySupplierTarget && (
        <SettlementConfirmModal
          title="Pagar al proveedor"
          accountName={paySupplierTarget.supplierName}
          receivableCop={paySupplierTarget.productCostCop}
          paysInCash={paySupplierTarget.paysInCash}
          busy={busyId === `supplier-${paySupplierTarget.supplierId}`}
          error={error}
          confirmLabel="Pagar proveedor"
          onCancel={() => setPaySupplierTarget(null)}
          onConfirm={(chargeGmf, note) => {
            const target = paySupplierTarget;
            setPaySupplierTarget(null);
            closeSupplierRow(target, chargeGmf, note);
          }}
        />
      )}
      {payCommunityLeaderTarget && (
        <SettlementConfirmModal
          title="Girar cashback al lider"
          accountName={`${payCommunityLeaderTarget.leaderName} · ${payCommunityLeaderTarget.communityName}`}
          receivableCop={payCommunityLeaderTarget.cashbackCop}
          // La comunidad no tiene ficha de pago en efectivo: el cashback se gira por banco.
          paysInCash={false}
          // Con neto cero o negativo no sale plata, y el 4x1000 solo grava lo que sale.
          allowGmfToggle={payCommunityLeaderTarget.cashbackCop > 0}
          busy={busyId === `community_leader-${payCommunityLeaderTarget.communityId}`}
          error={error}
          confirmLabel={payCommunityLeaderTarget.cashbackCop > 0 ? "Girar cashback" : "Cerrar corte"}
          onCancel={() => setPayCommunityLeaderTarget(null)}
          onConfirm={(chargeGmf, note) => {
            const target = payCommunityLeaderTarget;
            setPayCommunityLeaderTarget(null);
            closeCommunityLeaderRow(target, chargeGmf, note);
          }}
        />
      )}

      {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}

      {/* Cifra heroe: la pregunta que trae a alguien a esta pantalla es cuanto dinero hay sin
          conciliar. Antes era una tarjeta mas entre nueve, a media pagina de scroll. */}
      <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
        <div className="glass-acid flex min-w-[240px] flex-col justify-center rounded-3xl p-5">
          <p className="text-xs font-semibold uppercase text-deep/70">Pendiente total por conciliar</p>
          <p className="tabular mt-1 text-3xl font-extrabold text-deep">{formatCop(totalPending)}</p>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-white/[0.06] overflow-hidden rounded-3xl border border-white/[0.06] bg-panel sm:grid-cols-5 sm:divide-y-0">
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Tiendas por pagar</p>
            <p className="tabular text-lg font-bold">{formatCop(totalSellerPayable)}</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Proveedores</p>
            <p className="tabular text-lg font-bold">{formatCop(totalSupplierPayable)}</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Cashback lideres</p>
            <p className={`tabular text-lg font-bold ${totalCommunityLeaderPayable < 0 ? "text-rust" : ""}`}>{formatCop(totalCommunityLeaderPayable)}</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Domiciliarios deben entregar</p>
            <p className={`tabular text-lg font-bold ${totalDriverCashToReturn > 0 ? "text-rust" : ""}`}>{formatCop(totalDriverCashToReturn)}</p>
          </div>
          <div className="p-3">
            <p className="text-[11px] leading-tight text-ink-60">Bloqueado por COD</p>
            <p className={`tabular text-lg font-bold ${totalBlockedSellerPayable > 0 ? "text-rust" : ""}`}>{formatCop(totalBlockedSellerPayable)}</p>
          </div>
        </div>
      </div>

      {/* Tres destinos en vez de una pagina de siete tablas seguidas: lo que hay que pagar hoy,
          lo que ya se cerro, y las cifras de un rango de fechas. Son tres preguntas distintas y
          antes se respondian todas a base de scroll. */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Secciones de liquidaciones">
        {LIQUIDATION_TABS.map((tab) => {
          const active = liqTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={`focus-ring rounded-full border px-4 text-sm font-semibold transition ${active ? "border-acid/40 bg-acid text-deep" : "border-white/10 text-ink-60 hover:bg-field"}`}
              type="button"
              onClick={() => setLiqTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {liqTab === "payable" && (
        <>
          {/* Lo accionable arriba y abierto; lo de consulta, plegado. Antes las dos tarjetas
              grandes de posicion y conciliacion abrian la pantalla y empujaban las tablas de
              pago fuera de la vista. */}
          <CollapsiblePanel flush title="Posicion de la plataforma" summary="Caja, activos, pasivos y utilidad acumulada">
            <PlatformPositionCard state={state} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Conciliacion de caja" summary="Efectivo recibido contra lo esperado">
            <CashReconciliationCard state={state} setState={setState} />
          </CollapsiblePanel>
          <Metric icon={<CreditCard size={20} />} label="Saldo a pagar domiciliarios" value={formatCop(totalDriverReceivable)} />
          <LiquidationTable
            title="Tiendas disponibles para pagar"
            rows={sellerRows}
            emptyMessage="No hay tiendas habilitadas para pagar. Para COD, primero marca recibido el dinero del domiciliario."
            busyId={busyId}
            onClose={(row, chargeGmf) => setPayTarget({ row, chargeGmf: chargeGmf ?? !row.paysInCash })}
            onAbono={(row) => setAbonoTarget({ sellerId: row.id, sellerName: row.name, receivableCop: row.receivableCop })}
          />
          <SupplierLiquidationTable rows={supplierRows} busyId={busyId} onClose={(row) => setPaySupplierTarget(row)} />
          <CommunityLeaderLiquidationTable
            rows={communityLeaderRows}
            totalCop={totalCommunityLeaderPayable}
            busyId={busyId}
            message={communityLeaderMessage}
            onDismissMessage={() => setCommunityLeaderMessage(null)}
            onClose={(row) => setPayCommunityLeaderTarget(row)}
          />
          {/* El domiciliario que debe efectivo NOS paga: eso va por el modal de cobro. El que tiene
              saldo a favor si es un giro, y ahi el modal de pago (con 4x1000) es el correcto. */}
          <LiquidationTable
            title="Domiciliarios por cortar"
            rows={driverRows}
            emptyMessage="No hay movimientos de domiciliarios sin liquidar."
            busyId={busyId}
            onClose={(row, chargeGmf) => row.cashToReturnCop > 0
              ? setCollectTarget(row)
              : setPayTarget({ row, chargeGmf: chargeGmf ?? !row.paysInCash })}
          />
          <CollapsiblePanel flush title="Pedidos COD no habilitados" count={blockedSellerAudits.length} summary={`${blockedSellerAudits.length} esperando que se marque el dinero recibido`} tone={blockedSellerAudits.length > 0 ? "rust" : "default"} hideWhenEmpty>
            <BlockedSellerOrdersTable audits={blockedSellerAudits} />
          </CollapsiblePanel>
          <CollapsiblePanel flush title="Registro por tienda" summary={`${storeRows.length} tiendas · consulta antes de cerrar`}>
            <StoreLiquidationTable rows={storeRows} />
          </CollapsiblePanel>
        </>
      )}

      {liqTab === "closed" && (
        <SettlementsTable
          state={state}
          settlements={closedSettlements}
          busyId={busyId}
          actionError={error}
          onChangeStatus={changeStatus}
          onRecordCash={(settlement, pendingCop) => setCashReceiptTarget({ settlement, pendingCop })}
        />
      )}

      {liqTab === "period" && (
        <>
          <Card>
            <div className="mb-3">
              <p className="text-sm text-ink-60">
                Solo esta seccion depende de las fechas. Lo pendiente por liquidar es el total acumulado, sin recortar por rango.
              </p>
            </div>
            <div className="mb-3">
              <DateRangePresets startDate={startDate} endDate={endDate} onSelect={(start, end) => { setStartDate(start); setEndDate(end); }} />
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Desde
                <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Hasta
                <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </label>
              <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={() => { setStartDate(""); setEndDate(today); }}>
                Ver todo
              </button>
            </div>
          </Card>

          <div className="grid gap-3 md:grid-cols-4">
            <Metric icon={<CreditCard size={20} />} label="COD recibido" value={formatCop(totalCod)} />
            <Metric icon={<Wallet size={20} />} label="Cobros operativos tiendas" value={formatCop(totalSellerFees)} />
            <Metric icon={<Truck size={20} />} label="Pago domiciliarios" value={formatCop(totalDriverPay)} />
            <Metric icon={<ShieldCheck size={20} />} label="Margen operativo plataforma" value={formatCop(platformMargin)} />
          </div>

          <Card>
            <div className="mb-3">
              <h2 className="font-bold">Resumen completo del periodo</h2>
              <p className="text-sm text-ink-60">Desglose de lo que se cobra a tiendas, lo que se paga a domiciliarios y lo que queda como comision de plataforma.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl bg-field p-3">
                <p className="text-xs font-semibold uppercase text-ink-60">Pedidos</p>
                <p className="mt-1 text-sm text-ink-70">Entregados: <b>{totalDeliveredOrders}</b></p>
                <p className="text-sm text-ink-70">Fallidos: <b>{totalFailedOrders}</b></p>
                <p className="text-sm text-ink-70">Total cerrados: <b>{totalDeliveredOrders + totalFailedOrders}</b></p>
              </div>
              <div className="rounded-2xl bg-field p-3">
                <p className="text-xs font-semibold uppercase text-ink-60">Cobrado a tiendas</p>
                <p className="mt-1 text-sm text-ink-70">Entregas: <b><span className="tabular">{formatCop(totalDeliveryFees)}</span></b></p>
                <p className="text-sm text-ink-70">Fallidos: <b><span className="tabular">{formatCop(totalFailedFees)}</span></b></p>
                <p className="text-sm text-ink-70">Fulfillment: <b><span className="tabular">{formatCop(totalFulfillmentFees)}</span></b></p>
                <p className="text-sm text-ink-70">Total cobrado: <b><span className="tabular">{formatCop(totalSellerFees)}</span></b></p>
              </div>
              <div className="rounded-2xl bg-field p-3">
                <p className="text-xs font-semibold uppercase text-ink-60">Pagado a domiciliarios</p>
                <p className="mt-1 text-sm text-ink-70">Entregas: <b><span className="tabular">{formatCop(totalDeliveredPay)}</span></b></p>
                <p className="text-sm text-ink-70">Fallidos: <b><span className="tabular">{formatCop(totalFailedPay)}</span></b></p>
                <p className="text-sm text-ink-70">Total pagado: <b><span className="tabular">{formatCop(totalDriverPay)}</span></b></p>
                <p className={`text-sm font-bold ${platformMargin < 0 ? "text-rust" : "text-mint"}`}>Margen operativo plataforma: <span className="tabular">{formatCop(platformMargin)}</span></p>
              </div>
            </div>
            <p className="mt-3 rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">
              Margen operativo del periodo = cobros operativos a tiendas menos pago del domiciliario. En transportistas, el saldo neto compara COD recaudado contra pago del domiciliario: si el COD es mayor, debe entregar la diferencia; si el pago es mayor, queda saldo a recibir.
            </p>
          </Card>

          <StoreLiquidationSummary rows={rangeStoreRows} />
        </>
      )}
    </main>
  );
}

function LiquidationTable({
  title,
  rows,
  emptyMessage,
  busyId,
  onClose,
  onAbono
}: {
  title: string;
  rows: LiquidationRow[];
  emptyMessage: string;
  busyId: string | null;
  onClose: (row: LiquidationRow, chargeGmf?: boolean) => void;
  onAbono?: (row: LiquidationRow) => void;
}) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(rows, 10);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Override por fila del 4x1000: sin entrada manda la marca de la cuenta. */
  const [gmfOverrides, setGmfOverrides] = useState<Record<string, boolean>>({});
  // La misma tabla sirve para tiendas y para flota. "Debe entregar" solo aplica a flota: en la
  // tabla de tiendas salia un guion en todas las filas, ocupando una columna para no decir nada.
  const esFlota = rows.some((row) => row.role === "driver");
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-bold">{title}</h2>
        <span className="text-sm text-ink-60">{rows.length} cuentas</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-60">{emptyMessage}</p>
      ) : (
        <>
        {/* Movil: una tarjeta por cuenta. La tabla mide 1.183px y en un telefono de 390 se
            recortaba en la quinta columna: el 4x1000, el neto y el boton de pagar quedaban
            fuera de alcance, asi que no se podia liquidar desde el telefono. */}
        <div className="grid gap-2 md:hidden">
          {visibleItems.map((row) => {
            const rowKey = `${row.role}-${row.id}`;
            const cobra = gmfOverrides[row.id] ?? !row.paysInCash;
            const gmfCop = cobra ? gmfForPayout(row.receivableCop) : 0;
            const expanded = expandedId === rowKey;
            const actionLabel = row.role === "seller" ? "Pagar tienda" : row.cashToReturnCop > 0 ? "Marcar dinero recibido" : "Marcar pago realizado";
            return (
              <div key={rowKey} className="grid gap-2 rounded-2xl border border-white/10 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-bold">{row.name}</span>
                  <span className="shrink-0 text-xs text-ink-60">{row.orders} pedidos · {row.deliveredOrders}/{row.failedOrders}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-ink-60">Saldo a recibir</span>
                  <span className="tabular text-right font-semibold text-mint">{formatCop(row.receivableCop)}</span>
                  <span className="text-ink-60">Neto</span>
                  <span className={`tabular text-right font-semibold ${row.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.netCop)}</span>
                  {row.role === "driver" && row.cashToReturnCop > 0 && (
                    <>
                      <span className="text-ink-60">Debe entregar</span>
                      <span className="tabular text-right font-semibold text-rust">{formatCop(row.cashToReturnCop)}</span>
                    </>
                  )}
                </div>
                <button
                  className={`focus-ring flex items-center justify-between gap-2 rounded-2xl px-3 py-2 text-sm font-semibold transition ${cobra ? "bg-rust/10 text-rust" : "bg-field text-ink-60"}`}
                  type="button"
                  aria-pressed={cobra}
                  onClick={() => setGmfOverrides((current) => ({ ...current, [row.id]: !cobra }))}
                >
                  <span>4x1000</span>
                  <span className="tabular">{cobra ? `-${formatCop(gmfCop)}` : "efectivo"}</span>
                </button>
                <div className="flex items-center justify-between gap-2 rounded-2xl bg-acid/10 px-3 py-2">
                  <span className="text-sm font-semibold text-acid">A girar</span>
                  <span className="tabular text-lg font-bold text-acid">{formatCop(row.receivableCop - gmfCop)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="focus-ring flex-1 rounded-full border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : rowKey)}
                  >
                    {expanded ? "Ocultar" : "Detalle"}
                  </button>
                  {onAbono && row.role === "seller" && row.receivableCop > 0 && (
                    <button
                      className="focus-ring flex-1 rounded-full border border-white/20 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      type="button"
                      disabled={busyId === `abono-${row.id}`}
                      onClick={() => onAbono(row)}
                    >
                      {busyId === `abono-${row.id}` ? "Guardando..." : "Abonar"}
                    </button>
                  )}
                  <button
                    className="focus-ring w-full rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
                    type="button"
                    disabled={busyId === rowKey}
                    onClick={() => onClose(row, cobra)}
                  >
                    {busyId === rowKey ? "Guardando..." : actionLabel}
                  </button>
                </div>
                {/* El mismo detalle que en escritorio: antes aqui solo iba la tabla por pedido, y
                    como los abonos no cuelgan de un pedido en el telefono eran invisibles. */}
                {expanded && (
                  <div className="rounded-2xl bg-field/60 p-2">
                    <LiquidationRowDetail row={row} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
                {/* Ocho columnas, no catorce. COD recaudado, cobros operativos, pago domiciliario
                    y margen real estaban ADEMAS en el detalle desplegable de cada fila: aqui solo
                    servian para partir las cabeceras en dos lineas y dejar cada columna en 86px. */}
                <th className="py-2 pr-3 font-semibold">Cuenta</th>
                <th className="py-2 pr-3 font-semibold">Pedidos</th>
                {esFlota && <th className="py-2 pr-3 font-semibold">Debe entregar</th>}
                <th className="py-2 pr-3 font-semibold">Saldo a recibir</th>
                <th className="py-2 pr-3 font-semibold">4x1000</th>
                <th className="py-2 pr-3 font-semibold">Neto</th>
                <th className="py-2 pr-3 font-semibold">A girar</th>
                <th className="py-2 font-semibold">Estado</th>
                <th className="py-2 text-right font-semibold">Accion</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((row) => {
                const cobra = gmfOverrides[row.id] ?? !row.paysInCash;
                const gmfCop = cobra ? gmfForPayout(row.receivableCop) : 0;
                const rowKey = `${row.role}-${row.id}`;
                const expanded = expandedId === rowKey;
                const actionLabel = row.role === "seller" ? "Pagar tienda" : row.cashToReturnCop > 0 ? "Marcar dinero recibido" : "Marcar pago realizado";
                return (
                  <Fragment key={rowKey}>
                    <tr key={rowKey} className="border-b border-white/5 last:border-0">
                      <td className="py-3 pr-3 font-semibold">{row.name}</td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <span className="tabular">{row.orders}</span>
                        <span className="text-ink-60"> · {row.deliveredOrders}/{row.failedOrders}</span>
                      </td>
                      {esFlota && <td className="py-3 pr-3 font-bold text-rust"><span className="tabular">{formatCop(row.cashToReturnCop)}</span></td>}
                      <td className="py-3 pr-3 font-bold text-mint"><span className="tabular">{formatCop(row.receivableCop)}</span></td>
                      {/* Interruptor por transaccion: la marca de la cuenta es solo el valor por
                          defecto. Quien paga sabe en el momento si ese giro concreto sale por banco
                          o en efectivo, y aqui ve cambiar el "A girar" antes de pulsar. */}
                      <td className="py-3 pr-3">
                        <button
                          className={`focus-ring rounded-full px-2 py-1 text-xs font-semibold transition ${cobra ? "bg-rust/10 text-rust hover:bg-rust/20" : "bg-field text-ink-60 hover:bg-white/10"}`}
                          type="button"
                          aria-pressed={cobra}
                          title={cobra ? "Se cobra 4x1000. Pulsa si este pago sale en efectivo." : "Sin 4x1000 (efectivo). Pulsa si este pago sale por transferencia."}
                          onClick={() => setGmfOverrides((current) => ({ ...current, [row.id]: !cobra }))}
                        >
                          {cobra ? <span className="tabular">-{formatCop(gmfCop)}</span> : "efectivo"}
                        </button>
                      </td>
                      <td className={`py-3 pr-3 font-bold ${row.netCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(row.netCop)}</span></td>
                      <td className="py-3 pr-3 font-bold text-acid"><span className="tabular">{formatCop(row.receivableCop - gmfCop)}</span></td>
                      <td className="py-3">
                        <span className={`rounded-2xl px-2 py-1 text-xs font-semibold ${row.status === "pendiente" ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                            type="button"
                            onClick={() => setExpandedId(expanded ? null : rowKey)}
                          >
                            {expanded ? "Ocultar" : "Detalle"}
                          </button>
                          {onAbono && row.role === "seller" && row.receivableCop > 0 && (
                            <button
                              className="focus-ring rounded-full border border-white/20 px-3 py-2 text-xs font-semibold text-fg hover:bg-field disabled:opacity-50"
                              type="button"
                              disabled={busyId === `abono-${row.id}`}
                              onClick={() => onAbono(row)}
                            >
                              {busyId === `abono-${row.id}` ? "Guardando..." : "Abonar"}
                            </button>
                          )}
                          <button
                            className="focus-ring whitespace-nowrap rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
                            type="button"
                            disabled={busyId === rowKey}
                            onClick={() => onClose(row, cobra)}
                          >
                            {busyId === rowKey ? "Guardando..." : actionLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${rowKey}-detail`} className="border-b border-white/5">
                        <td colSpan={esFlota ? 9 : 8} className="bg-field/60 px-3 py-3">
                          <LiquidationRowDetail row={row} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <PaginationControls page={page} totalPages={totalPages} totalItems={rows.length} onPageChange={setPage} />
        </div>
        </>
      )}
    </Card>
  );
}

function DriverCashReceiptModal({
  settlement,
  pendingCop,
  busy,
  error,
  onClose,
  onSave
}: {
  settlement: Settlement;
  pendingCop: number;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (amountCop: number, note?: string) => void;
}) {
  useEscapeToClose(onClose);
  const [amount, setAmount] = useState(String(Math.max(0, pendingCop)));
  const [note, setNote] = useState("");
  const amountCop = Number(amount || 0);
  const validAmount = Number.isFinite(amountCop) && amountCop > 0 && amountCop <= pendingCop;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 px-4 py-6">
      <div className="grid w-full max-w-md gap-4 rounded-lg bg-panel p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold">Registrar recaudo del domiciliario</h2>
            <p className="text-sm text-ink-60">{settlement.ownerName} · {settlement.startDate} a {settlement.endDate}</p>
          </div>
          <IconButton title="Cerrar" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="rounded-2xl bg-field p-3">
          <DetailLine label="Pendiente actual" value={formatCop(pendingCop)} tone="rust" />
          <DetailLine label="Ordenes del corte" value={settlement.orderIds.length} />
        </div>
        <label className="grid gap-1 text-sm font-semibold">
          Valor recibido
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 font-normal"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Nota
          <textarea
            className="focus-ring min-h-20 rounded-2xl border border-white/10 px-3 py-2 font-normal"
            placeholder="Opcional"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {!validAmount && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">Ingresa un valor mayor a cero y menor o igual al pendiente.</p>}
        {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={busy || !validAmount}
            onClick={() => onSave(amountCop, note)}
          >
            {busy ? "Guardando..." : amountCop === pendingCop ? "Registrar y cerrar" : "Registrar abono"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Cobro al domiciliario que quedo debiendo efectivo.
 *
 * La contraparte de SettlementConfirmModal, no una variante suya: aqui el dinero ENTRA. Cuando el
 * mensajero debe, `buildLiquidationRows` deja `receivableCop` en cero y todo el importe en
 * `cashToReturnCop`, asi que el modal de pago mostraba "saldo a pagar $0 / a girar $0" y una casilla
 * de 4x1000 (que solo grava lo que sale del banco) para lo que en realidad es un cobro. Ademas el
 * valor recibido no siempre es el total, y no habia donde escribirlo antes de crear el corte.
 */
function DriverCashCollectModal({
  driverName,
  cashToReturnCop,
  orders,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  driverName: string;
  cashToReturnCop: number;
  orders: number;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (amountCop: number, note?: string) => void;
}) {
  useEscapeToClose(onCancel);
  const [amount, setAmount] = useState(String(Math.max(0, cashToReturnCop)));
  const [note, setNote] = useState("");
  const amountCop = Number(amount || 0);
  const validAmount = Number.isFinite(amountCop) && amountCop > 0 && amountCop <= cashToReturnCop;
  const pendingCop = Math.max(0, cashToReturnCop - (validAmount ? amountCop : 0));

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 px-4 py-6">
      <div className="grid max-h-full w-full max-w-md gap-4 overflow-y-auto rounded-lg bg-panel p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-bold">Recibir dinero del domiciliario</h2>
            <p className="truncate text-sm text-ink-60">{driverName}</p>
          </div>
          <IconButton title="Cancelar" onClick={onCancel}><X size={16} /></IconButton>
        </div>

        <div className="grid gap-1 rounded-2xl bg-field p-3">
          <DetailLine label="Debe entregar" value={formatCop(cashToReturnCop)} tone="rust" />
          <DetailLine label="Pedidos del corte" value={orders} />
        </div>

        <label className="grid gap-1 text-sm font-semibold">
          Valor recibido
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 font-normal"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>

        <div className="flex items-center justify-between rounded-2xl bg-field px-3 py-2">
          <span className="text-sm font-bold">Quedara pendiente</span>
          <span className={`tabular text-lg font-extrabold ${pendingCop > 0 ? "text-rust" : "text-acid"}`}>{formatCop(pendingCop)}</span>
        </div>

        <label className="grid gap-1 text-sm font-semibold">
          Observaciones (opcional)
          <textarea
            className="focus-ring min-h-20 rounded-2xl border border-white/10 px-3 py-2 text-sm font-normal"
            value={note}
            placeholder="Ej: entrega parcial, queda debiendo el resto para manana"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        {!validAmount && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">Ingresa un valor mayor a cero y menor o igual a lo que debe entregar.</p>}
        {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <button className="focus-ring rounded-full border border-white/10 px-4 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="focus-ring rounded-full bg-acid px-4 py-2 text-sm font-bold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={busy || !validAmount}
            onClick={() => onConfirm(amountCop, note.trim() || undefined)}
          >
            {busy ? "Guardando..." : pendingCop === 0 ? "Registrar y cerrar" : "Registrar abono"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmacion antes de cerrar un corte.
 *
 * Un corte es irreversible y hasta ahora se disparaba con un solo clic desde una fila de tabla.
 * Aqui se ven las tres cifras que importan antes de confirmar, se decide el 4x1000 de ESTE giro
 * y se puede dejar constancia por escrito: si marcas efectivo en una cuenta que normalmente cobra
 * por transferencia (o al reves), el importe lo refleja pero sin la nota nadie sabe por que.
 */
function SettlementConfirmModal({
  title,
  accountName,
  receivableCop,
  paysInCash,
  initialChargeGmf,
  allowGmfToggle = true,
  busy,
  error,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string;
  accountName: string;
  receivableCop: number;
  paysInCash: boolean;
  /** Valor inicial del 4x1000. Sin el, manda la ficha de la cuenta. */
  initialChargeGmf?: boolean;
  allowGmfToggle?: boolean;
  busy: boolean;
  error?: string | null;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (chargeGmf: boolean, note?: string) => void;
}) {
  useEscapeToClose(onCancel);
  const [chargeGmf, setChargeGmf] = useState(initialChargeGmf ?? !paysInCash);
  const [note, setNote] = useState("");
  const gmfCop = chargeGmf ? gmfForPayout(receivableCop) : 0;
  const distinto = paysInCash === chargeGmf;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 px-4 py-6">
      <div className="grid max-h-full w-full max-w-md gap-4 overflow-y-auto rounded-lg bg-panel p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-bold">{title}</h2>
            <p className="truncate text-sm text-ink-60">{accountName}</p>
          </div>
          <IconButton title="Cancelar" onClick={onCancel}><X size={16} /></IconButton>
        </div>

        <div className="grid gap-1 rounded-2xl bg-field p-3">
          <DetailLine label="Saldo a pagar" value={formatCop(receivableCop)} tone="mint" />
          <DetailLine label="4x1000" value={chargeGmf ? `-${formatCop(gmfCop)}` : "no aplica"} tone={chargeGmf ? "rust" : undefined} />
          <div className="mt-1 flex items-center justify-between border-t border-white/10 pt-2">
            <span className="text-sm font-bold">A girar</span>
            <span className="tabular text-lg font-extrabold text-acid">{formatCop(receivableCop - gmfCop)}</span>
          </div>
        </div>

        {allowGmfToggle && (
          <div className="grid gap-2 rounded-2xl border border-white/10 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input className="focus-ring h-4 w-4" type="checkbox" checked={chargeGmf} onChange={(event) => setChargeGmf(event.target.checked)} />
              Se cobro 4x1000 en este pago
            </label>
            <p className="text-xs text-ink-60">
              {distinto
                ? `Distinto de la ficha de la cuenta, que dice ${paysInCash ? "efectivo" : "transferencia"}. Deja una observacion explicando por que.`
                : `Coincide con la ficha de la cuenta (${paysInCash ? "efectivo" : "transferencia"}).`}
            </p>
          </div>
        )}

        <label className="grid gap-1 text-sm font-semibold">
          Observaciones (opcional)
          <textarea
            className="focus-ring min-h-20 rounded-2xl border border-white/10 px-3 py-2 text-sm font-normal"
            value={note}
            placeholder="Ej: pagado en efectivo en bodega, recibe Juan"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <button className="focus-ring rounded-full border border-white/10 px-4 text-sm font-semibold hover:bg-field" type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="focus-ring rounded-full bg-acid px-4 text-sm font-bold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={busy}
            onClick={() => onConfirm(chargeGmf, note.trim() || undefined)}
          >
            {busy ? "Cerrando..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function SellerAbonoModal({
  sellerName,
  receivableCop,
  paysInCash = false,
  busy,
  error,
  onClose,
  onSave
}: {
  sellerName: string;
  receivableCop: number;
  paysInCash?: boolean;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (amountCop: number, note: string | undefined, chargeGmf: boolean) => void;
}) {
  useEscapeToClose(onClose);
  const [amount, setAmount] = useState(String(Math.max(0, receivableCop)));
  const [note, setNote] = useState("");
  // Se hereda la forma de pago de la cuenta, pero ESTE abono puede salir de otra forma: quien
  // paga lo decide en el momento, no antes.
  const [chargeGmf, setChargeGmf] = useState(!paysInCash);
  const amountCop = Number(amount || 0);
  const validAmount = Number.isFinite(amountCop) && amountCop > 0 && amountCop <= receivableCop;
  const remainingCop = validAmount ? receivableCop - amountCop : receivableCop;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 px-4 py-6">
      <div className="grid w-full max-w-md gap-4 rounded-lg bg-panel p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold">Registrar abono a tienda</h2>
            <p className="text-sm text-ink-60">{sellerName}</p>
          </div>
          <IconButton title="Cerrar" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="rounded-2xl bg-field p-3">
          <DetailLine label="Saldo por pagar" value={formatCop(receivableCop)} tone="mint" />
          <DetailLine label="Quedará pendiente" value={formatCop(Math.max(0, remainingCop))} tone={remainingCop > 0 ? "rust" : "mint"} />
        </div>
        <div className="grid gap-2 rounded-2xl border border-white/10 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input className="focus-ring h-4 w-4" type="checkbox" checked={chargeGmf} onChange={(event) => setChargeGmf(event.target.checked)} />
            Se cobro 4x1000 en este abono
          </label>
          <p className="text-xs text-ink-60">
            {chargeGmf
              ? `Se descontaran ${formatCop(gmfForPayout(validAmount ? amountCop : 0))} adicionales del saldo de la tienda.`
              : "Pago en efectivo: no se descuenta gravamen."}
            {paysInCash === chargeGmf ? " Distinto de lo marcado en la ficha de la cuenta." : ""}
          </p>
        </div>
        <label className="grid gap-1 text-sm font-semibold">
          Valor a abonar
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 font-normal"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Nota
          <textarea
            className="focus-ring min-h-20 rounded-2xl border border-white/10 px-3 py-2 font-normal"
            placeholder="Opcional"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {!validAmount && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">Ingresa un valor mayor a cero y menor o igual al saldo por pagar.</p>}
        {error && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={busy || !validAmount}
            onClick={() => onSave(amountCop, note.trim() || undefined, chargeGmf)}
          >
            {busy ? "Guardando..." : "Registrar abono"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailLine({ label, value, tone }: { label: string; value: string | number; tone?: "mint" | "rust" | "ink" }) {
  const toneClass = tone === "mint" ? "text-mint" : tone === "rust" ? "text-rust" : "text-fg";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5 last:border-0">
      <span className="text-ink-60">{label}</span>
      <span className={`tabular font-bold ${toneClass}`}>{value}</span>
    </div>
  );
}

/**
 * Los abonos de la tienda, uno por uno. Un `seller_abono` se guarda con `orderId: ""`, asi que no
 * aparece en ninguna fila de la tabla por pedido: sin esta tabla el unico rastro era el total de
 * "Abonos ya pagados", y una tienda recibe varios abonos en la misma semana.
 */
function SellerAbonoTable({ rows, totalCop, gmfCop }: { rows: SellerAbonoRow[]; totalCop: number; gmfCop: number }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold">Abonos ya pagados</h3>
        <span className="text-xs font-semibold text-ink-60">
          {rows.length} abono{rows.length === 1 ? "" : "s"} · <span className="tabular">{formatCop(totalCop)}</span>
        </span>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-panel">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
              <th className="py-2 pl-3 pr-3 font-semibold">Fecha</th>
              <th className="py-2 pr-3 text-right font-semibold">Valor</th>
              <th className="py-2 pr-3 font-semibold">Nota</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((abono) => (
              <tr key={abono.id} className="border-b border-white/5 last:border-0">
                <td className="py-3 pl-3 pr-3 whitespace-nowrap">{new Date(abono.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</td>
                <td className="py-3 pr-3 text-right font-bold text-rust"><span className="tabular">{formatCop(abono.amountCop)}</span></td>
                <td className="py-3 pr-3 text-ink-70">{abono.note || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {gmfCop > 0 && (
        <p className="text-xs text-ink-60">
          4x1000 de los abonos: <span className="tabular font-semibold text-rust">{formatCop(gmfCop)}</span>. Se descuenta aparte y tambien lo barre el siguiente corte.
        </p>
      )}
    </>
  );
}

function LiquidationRowDetail({ row }: { row: LiquidationRow }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">Pedidos incluidos</p>
          <DetailLine label="Total pedidos" value={row.orders} />
          <DetailLine label="Entregados" value={row.deliveredOrders} tone="mint" />
          <DetailLine label="Fallidos" value={row.failedOrders} tone="rust" />
          <DetailLine label="Fallidos cobrables" value={row.chargeableFailedOrders} tone="rust" />
          <DetailLine label="Fallidos no cobrables" value={row.nonChargeableFailedOrders} />
        </div>
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">Cobros a tienda</p>
          <DetailLine label="COD recaudado" value={formatCop(row.codCop)} />
          <DetailLine label="Cobro por entregas" value={formatCop(row.deliveryFeeCop)} />
          <DetailLine label="Cobro por fallidos" value={formatCop(row.failedFeeCop)} />
          <DetailLine label="Fulfillment" value={formatCop(row.fulfillmentCop)} />
          <DetailLine label="Costo producto" value={formatCop(row.productCostCop)} />
          <DetailLine label="Cargos operativos" value={formatCop(row.feesCop)} tone="mint" />
        </div>
        {row.role === "driver" ? (
          <div className="rounded-2xl bg-panel p-3">
            <p className="mb-2 text-xs font-bold uppercase text-ink-60">Pago domiciliario</p>
            <DetailLine label="Pago por entregados" value={formatCop(row.deliveredPayCop)} />
            <DetailLine label="Pago por fallidos" value={formatCop(row.failedPayCop)} />
            <DetailLine label="Total pago" value={formatCop(row.earningsCop)} tone="rust" />
            <DetailLine label="Debe entregar" value={formatCop(row.cashToReturnCop)} tone="rust" />
            <DetailLine label="Saldo a recibir" value={formatCop(row.receivableCop)} tone="mint" />
          </div>
        ) : (
          <div className="rounded-2xl bg-panel p-3">
            <p className="mb-2 text-xs font-bold uppercase text-ink-60">Liquidacion tienda</p>
            <DetailLine label="COD a favor de tienda" value={formatCop(row.codCop)} tone="mint" />
            <DetailLine label="Cobros descontados" value={formatCop(row.feesCop + row.productCostCop)} tone="rust" />
            {row.abonoCop > 0 && <DetailLine label="Abonos ya pagados" value={formatCop(row.abonoCop)} tone="rust" />}
            {row.abonoGmfCop > 0 && <DetailLine label="4x1000 de abonos" value={formatCop(row.abonoGmfCop)} tone="rust" />}
            <DetailLine label="A pagar a tienda" value={formatCop(row.receivableCop)} tone="mint" />
          </div>
        )}
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">Resultado</p>
          <DetailLine label="Margen operativo" value={formatCop(row.platformMarginCop)} tone={row.platformMarginCop < 0 ? "rust" : "mint"} />
          <DetailLine label={row.role === "seller" ? "A pagar a tienda" : "Neto domiciliario"} value={formatCop(row.netCop)} tone={row.netCop < 0 ? "rust" : "mint"} />
          <p className="mt-2 rounded-2xl bg-field px-2 py-1.5 text-xs text-ink-60">
            {row.role === "seller"
              ? "A pagar a tienda = COD ya recibido menos cobros operativos y costo de producto."
              : "Neto domiciliario = pago domiciliario menos COD recaudado. Si es negativo, debe entregar dinero."}
          </p>
        </div>
      </div>
      <LiquidationOrderAuditTable audits={row.orderDetails} compact />
      {row.abonoRows.length > 0 && <SellerAbonoTable rows={row.abonoRows} totalCop={row.abonoCop} gmfCop={row.abonoGmfCop} />}
    </div>
  );
}

const liquidationAuditExportColumns = [
  "guia", "shopify", "tienda", "domiciliario", "estado", "fallido_cobrable",
  "cod_recaudado", "cobro_entrega", "cobro_fallido", "fulfillment", "costo_producto", "cobros_operativos",
  "pago_entregado_domiciliario", "pago_fallido_domiciliario", "pago_domiciliario", "comision_plataforma",
  "a_pagar_tienda", "habilitado_tienda", "nota"
] as const;

function buildLiquidationAuditExportRows(audits: LiquidationOrderAudit[]) {
  return audits.map((audit) => ({
    guia: audit.trackingCode,
    shopify: audit.shopifyOrderId,
    tienda: audit.sellerName,
    domiciliario: audit.driverName,
    estado: statusLabel(audit.status),
    fallido_cobrable: audit.status === "failed" ? (audit.chargeableFailed ? "si" : "no") : "",
    cod_recaudado: audit.codCop,
    cobro_entrega: audit.deliveryFeeCop,
    cobro_fallido: audit.failedFeeCop,
    fulfillment: audit.fulfillmentCop,
    costo_producto: audit.productCostCop,
    cobros_operativos: audit.storeChargeCop,
    pago_entregado_domiciliario: audit.driverDeliveredPayCop,
    pago_fallido_domiciliario: audit.driverFailedPayCop,
    pago_domiciliario: audit.driverPayCop,
    comision_plataforma: audit.platformMarginCop,
    a_pagar_tienda: audit.sellerNetCop,
    habilitado_tienda: audit.sellerEligible ? "si" : "no",
    nota: audit.reason
  }));
}

/**
 * Tabla de auditoria por pedido. Pagina POR DENTRO a proposito: de sus tres usos, dos le pasaban
 * la lista entera y con el historico cargado eso son ~1.900 filas de 12 columnas, unas 23.000
 * celdas de golpe. `paginate={false}` es para quien ya recorta antes de llamar.
 */
function LiquidationOrderAuditTable({ audits, compact = false, paginate = true }: { audits: LiquidationOrderAudit[]; compact?: boolean; paginate?: boolean }) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(audits, 25);
  const rows = paginate ? visibleItems : audits;
  if (audits.length === 0) {
    return <p className="rounded-2xl bg-panel px-3 py-2 text-sm text-ink-60">No hay pedidos detallados para esta liquidacion.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-2xl bg-panel">
      <table className={`w-full border-collapse text-sm ${compact ? "min-w-[1020px]" : "min-w-[1122px]"}`}>
        <thead>
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
            <th className="py-2 pl-3 pr-3 font-semibold">Guia</th>
            <th className="py-2 pr-3 font-semibold">Shopify</th>
            <th className="py-2 pr-3 font-semibold">Tienda</th>
            <th className="py-2 pr-3 font-semibold">Domiciliario</th>
            <th className="py-2 pr-3 font-semibold">Estado</th>
            <th className="py-2 pr-3 font-semibold">Fallido</th>
            <th className="py-2 pr-3 font-semibold">COD</th>
            <th className="py-2 pr-3 font-semibold">Cobros operativos</th>
            <th className="py-2 pr-3 font-semibold">Pago domiciliario</th>
            <th className="py-2 pr-3 font-semibold">Comision</th>
            <th className="py-2 pr-3 font-semibold">A pagar tienda</th>
            <th className="py-2 pr-3 font-semibold">Habilitado tienda</th>
            <th className="py-2 pr-3 font-semibold">Nota</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((audit) => (
            <tr key={audit.orderId} className="border-b border-white/5 last:border-0">
              <td className="py-3 pl-3 pr-3 font-semibold">{audit.trackingCode}</td>
              <td className="py-3 pr-3">{audit.shopifyOrderId}</td>
              <td className="py-3 pr-3">{audit.sellerName}</td>
              <td className="py-3 pr-3">{audit.driverName}</td>
              <td className="py-3 pr-3">{statusLabel(audit.status)}</td>
              <td className="py-3 pr-3">
                {audit.status === "failed" ? (
                  <>
                    <p className="font-semibold">{failedCategoryLabel(audit.failedCategory)}</p>
                    <p className="text-xs text-ink-60">{audit.chargeableFailed ? "Cobrable" : "No cobrable"}</p>
                  </>
                ) : "-"}
              </td>
              <td className="py-3 pr-3"><span className="tabular">{formatCop(audit.codCop)}</span></td>
              <td className="py-3 pr-3">
                <p className="font-semibold"><span className="tabular">{formatCop(audit.storeChargeCop)}</span></p>
                <p className="text-xs text-ink-60">Ent <span className="tabular">{formatCop(audit.deliveryFeeCop)}</span> · Fall <span className="tabular">{formatCop(audit.failedFeeCop)}</span> · Ful <span className="tabular">{formatCop(audit.fulfillmentCop)}</span> · Prod <span className="tabular">{formatCop(audit.productCostCop)}</span></p>
              </td>
              <td className="py-3 pr-3">
                <p className="font-semibold"><span className="tabular">{formatCop(audit.driverPayCop)}</span></p>
                <p className="text-xs text-ink-60">Ent <span className="tabular">{formatCop(audit.driverDeliveredPayCop)}</span> · Fall <span className="tabular">{formatCop(audit.driverFailedPayCop)}</span></p>
              </td>
              <td className={`py-3 pr-3 font-bold ${audit.platformMarginCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(audit.platformMarginCop)}</span></td>
              <td className={`py-3 pr-3 font-bold ${audit.sellerNetCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(audit.sellerNetCop)}</span></td>
              <td className="py-3 pr-3">
                <span className={`rounded-2xl px-2 py-1 text-xs font-semibold ${audit.sellerEligible ? "bg-mint/10 text-mint" : "bg-rust/10 text-rust"}`}>
                  {audit.sellerEligible ? "Si" : "No"}
                </span>
              </td>
              <td className="py-3 pr-3 text-ink-60">{audit.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {paginate && totalPages > 1 && (
        <PaginationControls page={page} totalPages={totalPages} totalItems={audits.length} onPageChange={setPage} />
      )}
    </div>
  );
}

function BlockedSellerOrdersTable({ audits }: { audits: LiquidationOrderAudit[] }) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(audits, 10);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">Pedidos COD no habilitados para tienda</h2>
          <p className="text-sm text-ink-60">Estos pedidos tienen movimientos de tienda pendientes, pero aun falta marcar recibido el dinero del domiciliario.</p>
        </div>
        <span className="shrink-0 text-sm text-ink-60">{audits.length} pedidos</span>
      </div>
      {audits.length === 0 ? (
        <p className="text-sm text-ink-60">No hay pedidos COD bloqueados en este rango.</p>
      ) : (
        <>
          <LiquidationOrderAuditTable audits={visibleItems} paginate={false} />
          <PaginationControls page={page} totalPages={totalPages} totalItems={audits.length} onPageChange={setPage} />
        </>
      )}
    </Card>
  );
}

function StoreLiquidationSummary({ rows }: { rows: StoreLiquidationRow[] }) {
  const activeStores = rows.length;
  const orders = rows.reduce((sum, row) => sum + row.orders, 0);
  const charged = rows.reduce((sum, row) => sum + row.totalChargedCop, 0);
  const balance = rows.reduce((sum, row) => sum + row.sellerBalanceCop, 0);
  return (
    <div className="grid gap-3 md:grid-cols-4">
      <Metric icon={<Store size={20} />} label="Tiendas con movimiento" value={String(activeStores)} />
      <Metric icon={<PackageCheck size={20} />} label="Pedidos por tienda" value={String(orders)} />
      <Metric icon={<Wallet size={20} />} label="Cobrado a tiendas" value={formatCop(charged)} />
      <Metric icon={<CreditCard size={20} />} label="Saldo tiendas" value={formatCop(balance)} />
    </div>
  );
}

function StoreLiquidationTable({ rows }: { rows: StoreLiquidationRow[] }) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(rows, 10);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">Registro por tienda</h2>
          <p className="text-sm text-ink-60">Control por vendedor/tienda para revisar recaudo, cobros y saldo antes de cerrar liquidaciones.</p>
        </div>
        <span className="shrink-0 text-sm text-ink-60">{rows.length} tiendas</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-60">No hay movimientos de tiendas sin liquidar en este rango.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[918px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
                <th className="py-2 pr-3 font-semibold">Tienda</th>
                <th className="py-2 pr-3 font-semibold">Dominio</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">Ent/Fall</th>
                <th className="py-2 pr-3 font-semibold">COD recaudado</th>
                <th className="py-2 pr-3 font-semibold">Cobro entrega</th>
                <th className="py-2 pr-3 font-semibold">Cobro fallido</th>
                <th className="py-2 pr-3 font-semibold">Fulfillment</th>
                <th className="py-2 pr-3 font-semibold">Producto</th>
                <th className="py-2 pr-3 font-semibold">Total descontado</th>
                <th className="py-2 pr-3 font-semibold">A pagar tienda</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((row) => (
                <tr key={row.sellerId} className="border-b border-white/5 last:border-0">
                  <td className="py-3 pr-3">
                    <p className="font-semibold">{row.sellerName}</p>
                    <p className="text-xs text-ink-60">{row.connectedStores} conexion{row.connectedStores === 1 ? "" : "es"}</p>
                  </td>
                  <td className="py-3 pr-3">{row.shopDomain}</td>
                  <td className="py-3 pr-3">{row.orders}</td>
                  <td className="py-3 pr-3">{row.deliveredOrders}/{row.failedOrders}</td>
                  <td className="py-3 pr-3"><span className="tabular">{formatCop(row.codCop)}</span></td>
                  <td className="py-3 pr-3"><span className="tabular">{formatCop(row.deliveryFeeCop)}</span></td>
                  <td className="py-3 pr-3"><span className="tabular">{formatCop(row.failedFeeCop)}</span></td>
                  <td className="py-3 pr-3"><span className="tabular">{formatCop(row.fulfillmentCop)}</span></td>
                  <td className="py-3 pr-3"><span className="tabular">{formatCop(row.productCostCop)}</span></td>
                  <td className="py-3 pr-3 font-bold"><span className="tabular">{formatCop(row.totalChargedCop)}</span></td>
                  <td className={`py-3 pr-3 font-bold ${row.sellerBalanceCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(row.sellerBalanceCop)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationControls page={page} totalPages={totalPages} totalItems={rows.length} onPageChange={setPage} />
        </div>
      )}
    </Card>
  );
}

// Abono parcial a proveedor. Se liquidan pedidos COMPLETOS del mas antiguo al mas nuevo
// hasta donde alcance el monto: asi el saldo pendiente siempre refleja lo que falta pagar
// de verdad, en vez de quedar marcado como pagado por mas de lo transferido.
function SupplierAbonoModal({
  row,
  onClose,
  onDone
}: {
  row: SupplierLiquidationRow;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  useEscapeToClose(onClose);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Igual que en tiendas: la marca de la cuenta es el valor por defecto, este abono concreto
  // puede salir de otra forma.
  const [chargeGmf, setChargeGmf] = useState(!row.paysInCash);
  const [message, setMessage] = useState("");
  const amountCop = Number(amount.replace(/[^\d]/g, ""));
  const canSubmit = amountCop > 0 && amountCop <= row.productCostCop && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await recordFirebaseSupplierAbono({ chargeGmf, supplierId: row.supplierId, amountCop, note: note.trim() || undefined });
      const extra = result.partialCop > 0
        ? ` Incluye un abono parcial de ${formatCop(result.partialCop)} a un pedido, que queda con el resto pendiente.`
        : "";
      onDone(`Abono de ${formatCop(result.appliedCop)} a ${row.supplierName} (${result.orders} pedidos completos). Quedan ${formatCop(result.remainingCop)}.${extra}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo registrar el abono.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true">
      <Card className="grid w-full max-w-md gap-3">
        <div>
          <h2 className="font-bold">Abonar a {row.supplierName}</h2>
          <p className="text-sm text-ink-60">Saldo pendiente: <b><span className="tabular">{formatCop(row.productCostCop)}</span></b> en {row.orders} pedidos.</p>
        </div>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Monto transferido
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg"
            inputMode="numeric"
            placeholder="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Nota (opcional)
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg"
            placeholder="Ej: transferencia Bancolombia 3-ago"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="grid gap-2 rounded-2xl border border-white/10 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input className="focus-ring h-4 w-4" type="checkbox" checked={chargeGmf} onChange={(event) => setChargeGmf(event.target.checked)} />
            Se cobro 4x1000 en este abono
          </label>
          <p className="text-xs text-ink-60">
            {chargeGmf
              ? `Se registrara ${formatCop(gmfForPayout(amountCop > 0 ? amountCop : 0))} de gravamen contra la plataforma.`
              : "Pago en efectivo: no se registra gravamen."}
          </p>
        </div>
        {amountCop > row.productCostCop && (
          <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">El monto supera el saldo pendiente.</p>
        )}
        <p className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">
          Se liquidan pedidos completos, del mas antiguo al mas nuevo. Si el monto no alcanza a cubrir uno entero, ese
          sobrante queda sin aplicar y se te informa.
        </p>
        {message && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{message}</p>}
        <div className="flex justify-end gap-2">
          <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold" type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? "Registrando..." : "Registrar abono"}
          </button>
        </div>
      </Card>
    </div>
  );
}

/**
 * RF_49: el corte con el que el cashback del lider pasa de causado a pagado.
 *
 * Se pinta como los proveedores y no como una fila mas de `LiquidationRow`, porque el `role` de
 * aquella gobierna una quincena de ramas de render y de acciones que aqui no aplican.
 *
 * Tres casos que NO se esconden, y por que: una fila en cero (reversas que netean) hay que poder
 * cortarla igual, o sus asientos siguen pendientes para siempre; un neto negativo se muestra
 * negativo en vez de recortarse a cero; y una comunidad cuyos asientos ya no casan con ninguna
 * comunidad viva sale con nombre de respaldo. Esconder cualquiera de las tres seria bajar un
 * saldo en silencio.
 */
function CommunityLeaderLiquidationTable({
  rows,
  totalCop,
  busyId,
  message,
  onDismissMessage,
  onClose
}: {
  rows: CommunityLeaderLiquidationRow[];
  totalCop: number;
  busyId: string | null;
  message: string | null;
  onDismissMessage: () => void;
  onClose: (row: CommunityLeaderLiquidationRow) => void;
}) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(rows, 10);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">Cashback de lideres pendiente de girar</h2>
          <p className="text-sm text-ink-60">Causado por los pedidos de cada comunidad y todavia sin cortar.</p>
        </div>
        <span className="shrink-0 text-sm font-bold text-mint tabular">{formatCop(totalCop)}</span>
      </div>
      {message && (
        <button
          type="button"
          onClick={onDismissMessage}
          className="mb-3 w-full rounded-2xl bg-mint/10 px-3 py-2 text-left text-sm font-semibold text-fg"
        >
          {message}
        </button>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-60">Ninguna comunidad tiene cashback pendiente en este rango.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
                <th className="py-2 pr-3 font-semibold">Comunidad</th>
                <th className="py-2 pr-3 font-semibold">Lider</th>
                <th className="py-2 pr-3 font-semibold">Pedidos</th>
                <th className="py-2 pr-3 font-semibold">Movimientos</th>
                <th className="py-2 pr-3 font-semibold">Cashback</th>
                <th className="py-2 text-right font-semibold">Accion</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((row) => (
                <tr key={row.communityId} className="border-b border-white/5 last:border-0">
                  <td className="py-3 pr-3 font-semibold">{row.communityName}</td>
                  <td className="py-3 pr-3">{row.leaderName}</td>
                  <td className="py-3 pr-3">{row.orders}</td>
                  <td className="py-3 pr-3">{row.walletEntryIds.length}</td>
                  <td className={`py-3 pr-3 font-bold ${row.cashbackCop < 0 ? "text-rust" : "text-mint"}`}>
                    <span className="tabular">{formatCop(row.cashbackCop)}</span>
                  </td>
                  <td className="py-3 text-right">
                    <button
                      className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:cursor-not-allowed disabled:bg-field disabled:text-ink-60"
                      type="button"
                      disabled={busyId === `community_leader-${row.communityId}`}
                      onClick={() => onClose(row)}
                    >
                      {busyId === `community_leader-${row.communityId}`
                        ? "Guardando..."
                        : row.cashbackCop > 0
                          ? "Girar cashback"
                          : "Cerrar corte"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationControls page={page} totalPages={totalPages} totalItems={rows.length} onPageChange={setPage} />
        </div>
      )}
    </Card>
  );
}

function SupplierLiquidationTable({
  rows,
  busyId,
  onClose
}: {
  rows: SupplierLiquidationRow[];
  busyId: string | null;
  onClose: (row: SupplierLiquidationRow, chargeGmf?: boolean) => void;
}) {
  const [abonoRow, setAbonoRow] = useState<SupplierLiquidationRow | null>(null);
  const [abonoMessage, setAbonoMessage] = useState("");
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(rows, 10);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">Proveedores disponibles para pagar</h2>
          <p className="text-sm text-ink-60">Costos de producto habilitados por pedidos prepaid o COD ya recaudado.</p>
        </div>
        <span className="shrink-0 text-sm text-ink-60">{rows.length} proveedores</span>
      </div>
      {abonoMessage && <p className="mb-3 rounded-2xl bg-mint/10 px-3 py-2 text-sm font-semibold text-fg">{abonoMessage}</p>}
      {abonoRow && (
        <SupplierAbonoModal
          row={abonoRow}
          onClose={() => setAbonoRow(null)}
          onDone={(message) => {
            setAbonoMessage(message);
            setAbonoRow(null);
          }}
        />
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-60">No hay proveedores habilitados para pagar en este rango.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[782px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
                <th className="py-2 pr-3 font-semibold">Proveedor</th>
                <th className="py-2 pr-3 font-semibold">Tiendas</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">Movimientos</th>
                <th className="py-2 pr-3 font-semibold">Costo producto</th>
                <th className="py-2 text-right font-semibold">Accion</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((row) => {
                const expanded = expandedId === row.supplierId;
                return (
                  <Fragment key={row.supplierId}>
                    <tr className="border-b border-white/5 last:border-0">
                      <td className="py-3 pr-3 font-semibold">{row.supplierName}</td>
                      <td className="py-3 pr-3">{row.sellers.length > 0 ? row.sellers.join(", ") : "-"}</td>
                      <td className="py-3 pr-3">{row.orders}</td>
                      <td className="py-3 pr-3">{row.walletEntryIds.length}</td>
                      <td className="py-3 pr-3 font-bold text-mint"><span className="tabular">{formatCop(row.productCostCop)}</span></td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                            type="button"
                            onClick={() => setExpandedId(expanded ? null : row.supplierId)}
                          >
                            {expanded ? "Ocultar" : "Detalle"}
                          </button>
                          <button
                            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                            type="button"
                            onClick={() => setAbonoRow(row)}
                          >
                            Abonar
                          </button>
                          <button
                            className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
                            type="button"
                            disabled={busyId === `supplier-${row.supplierId}`}
                            onClick={() => onClose(row)}
                          >
                            {busyId === `supplier-${row.supplierId}` ? "Guardando..." : "Pagar todo"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-white/5">
                        <td colSpan={6} className="bg-field/60 px-3 py-3">
                          <SupplierLiquidationDetail row={row} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <PaginationControls page={page} totalPages={totalPages} totalItems={rows.length} onPageChange={setPage} />
        </div>
      )}
    </Card>
  );
}

function SupplierLiquidationDetail({ row }: { row: SupplierLiquidationRow }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-panel">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
            <th className="py-2 pl-3 pr-3 font-semibold">Orden</th>
            <th className="py-2 pr-3 font-semibold">Tienda</th>
            <th className="py-2 pr-3 font-semibold">Producto</th>
            <th className="py-2 pr-3 font-semibold">Fecha</th>
            <th className="py-2 pr-3 font-semibold">Valor</th>
          </tr>
        </thead>
        <tbody>
          {row.entries.map((entry) => (
            <tr key={entry.id} className="border-b border-white/5 last:border-0">
              <td className="py-3 pl-3 pr-3 font-semibold">{entry.orderId ?? "-"}</td>
              <td className="py-3 pr-3">{entry.ownerId}</td>
              <td className="py-3 pr-3">{entry.productName ?? entry.description}</td>
              <td className="py-3 pr-3">{entry.createdAt.slice(0, 10)}</td>
              <td className="py-3 pr-3 font-bold text-mint"><span className="tabular">{formatCop(Math.max(0, -entry.amountCop))}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function settlementStatusLabel(status: Settlement["status"]) {
  if (status === "paid") return "pagada";
  if (status === "reconciled") return "conciliada";
  return "pendiente";
}

function settlementKindLabel(kind: Settlement["kind"]) {
  if (kind === "seller") return "Vendedor";
  if (kind === "supplier") return "Proveedor";
  return "Transportista";
}

// Foto acumulada de la plataforma (no filtrada por rango). Existe porque la tabla de
// liquidaciones mostraba el cobro bruto como si fuera margen y hacia parecer que quedaba
// mucho mas dinero del que hay.
function PlatformPositionCard({ state }: { state: AppState }) {
  const position = useMemo(() => calculatePlatformPosition(state), [state]);
  const tone = (value: number) => (value < 0 ? "text-rust" : "text-mint");
  return (
    <Card>
      <div className="mb-3">
        <h2 className="font-bold">Resultado de la plataforma</h2>
        <p className="text-sm text-ink-60">
          Posicion acumulada de toda la operacion (no depende del rango de fechas). La utilidad es lo cobrado a tiendas
          menos lo pagado a domiciliarios; el costo de producto retenido no es utilidad.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl bg-field p-3">
          <p className="text-xs font-semibold uppercase text-ink-60">Caja y por cobrar</p>
          <p className="mt-1 text-sm text-ink-70">Caja actual: <b><span className="tabular">{formatCop(position.cashCop)}</span></b></p>
          <p className="text-xs text-ink-60">recibido del domiciliario <span className="tabular">{formatCop(position.receivedFromDriverCop)}</span> · pagado a tiendas <span className="tabular">{formatCop(position.paidToSellersCop)}</span></p>
          <p className="mt-2 text-sm text-ink-70">Por cobrar al domiciliario: <b><span className="tabular">{formatCop(position.driverReceivableCop)}</span></b></p>
          <p className="text-xs text-ink-60">en cortes <span className="tabular">{formatCop(position.driverPendingInSettlementsCop)}</span> · COD sin corte <span className="tabular">{formatCop(position.driverCodOutsideSettlementsCop)}</span></p>
        </div>
        <div className="rounded-2xl bg-field p-3">
          <p className="text-xs font-semibold uppercase text-ink-60">Obligaciones</p>
          <p className="mt-1 text-sm text-ink-70">Por pagar a tiendas: <b><span className="tabular">{formatCop(position.payableToSellersCop)}</span></b></p>
          <p className="mt-2 text-sm text-ink-70">Retenido para proveedores: <b><span className="tabular">{formatCop(position.withheldForSuppliersCop)}</span></b></p>
          {position.withheldBySupplier.map((supplier) => (
            <p key={supplier.supplierId} className="text-xs text-ink-60">{supplier.supplierName}: <span className="tabular">{formatCop(supplier.amountCop)}</span></p>
          ))}
        </div>
        <div className="rounded-2xl bg-field p-3">
          <p className="text-xs font-semibold uppercase text-ink-60">Utilidad</p>
          <p className="mt-1 text-sm text-ink-70">Cobros a tiendas: <b><span className="tabular">{formatCop(position.feesCop)}</span></b></p>
          <p className="text-sm text-ink-70">Pago a domiciliarios: <b><span className="tabular">{formatCop(position.driverPayCop)}</span></b></p>
          <p className={`mt-1 text-sm font-bold ${tone(position.profitCop)}`}>Utilidad acumulada: <span className="tabular">{formatCop(position.profitCop)}</span></p>
          <p className={`mt-2 text-sm font-bold ${tone(position.netCop)}`}>Activos - obligaciones: <span className="tabular">{formatCop(position.netCop)}</span></p>
          <p className="text-xs text-ink-60">deberia parecerse a la utilidad; la diferencia son ajustes y correcciones</p>
        </div>
      </div>
    </Card>
  );
}

// Cuadre de caja: contrasta el saldo REAL de las cuentas de la operacion contra el
// teorico. Existe porque un desfase de $8,8M tardo tres meses en detectarse: la
// plataforma sabia cuanto debia haber, pero nadie comparaba contra el banco.
function CashReconciliationCard({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const position = useMemo(() => calculatePlatformPosition(state), [state]);
  const [balance, setBalance] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const snapshots = [...(state.cashSnapshots ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const last = snapshots[0];
  const balanceCop = Number(balance.replace(/[^\d]/g, ""));
  const previewDifference = balanceCop > 0 ? balanceCop - position.cashCop : null;

  async function submit() {
    if (balanceCop <= 0 || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const snapshot: CashSnapshot = {
        id: `cash-${Date.now()}`,
        balanceCop,
        expectedCop: position.cashCop,
        differenceCop: balanceCop - position.cashCop,
        note: note.trim() || undefined,
        createdAt: new Date().toISOString(),
        createdBy: state.activeRole
      };
      if (firebaseEnabled()) await saveFirestoreCashSnapshot(snapshot);
      setState({ ...state, cashSnapshots: [snapshot, ...(state.cashSnapshots ?? [])] });
      setBalance("");
      setNote("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar el cuadre.");
    } finally {
      setBusy(false);
    }
  }

  const coverageCop = position.cashCop + position.driverReceivableCop - position.payableToSellersCop - position.withheldForSuppliersCop;

  return (
    <Card>
      <div className="mb-3">
        <h2 className="font-bold">Cuadre de caja</h2>
        <p className="text-sm text-ink-60">
          Registra el saldo real de las cuentas de la operacion y compara contra lo que deberia haber. Hazlo semanal:
          asi un desfase se ve en dias, no en meses.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl bg-field p-3">
          <p className="text-xs font-semibold uppercase text-ink-60">Deberia haber</p>
          <p className="mt-1 text-lg font-bold"><span className="tabular">{formatCop(position.cashCop)}</span></p>
          <p className="text-xs text-ink-60">recibido del domiciliario menos pagado a tiendas</p>
        </div>
        <div className="rounded-2xl bg-field p-3">
          <p className="text-xs font-semibold uppercase text-ink-60">Ultimo cuadre</p>
          {last ? (
            <>
              <p className="mt-1 text-lg font-bold"><span className="tabular">{formatCop(last.balanceCop)}</span></p>
              <p className={`text-xs font-semibold ${last.differenceCop < 0 ? "text-rust" : "text-mint"}`}>
                desfase <span className="tabular">{formatCop(last.differenceCop)}</span> · {last.createdAt.slice(0, 10)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-ink-60">Aun no has registrado ninguno.</p>
          )}
        </div>
        <div className={`rounded-2xl p-3 ${coverageCop < 0 ? "bg-rust/10" : "bg-mint/10"}`}>
          <p className="text-xs font-semibold uppercase text-ink-60">Cobertura</p>
          <p className={`mt-1 text-lg font-bold ${coverageCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(coverageCop)}</span></p>
          <p className="text-xs text-ink-60">
            {coverageCop < 0 ? "No alcanza para pagarle a tiendas y proveedores" : "Alcanza para cubrir lo que debes"}
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
          inputMode="numeric"
          placeholder="Saldo real de las cuentas"
          value={balance}
          onChange={(event) => setBalance(event.target.value)}
        />
        <input
          className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
          placeholder="Nota (opcional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
          type="button"
          disabled={balanceCop <= 0 || busy}
          onClick={() => void submit()}
        >
          {busy ? "Guardando..." : "Registrar cuadre"}
        </button>
      </div>
      {previewDifference !== null && (
        <p className={`mt-2 text-sm font-semibold ${previewDifference < 0 ? "text-rust" : "text-mint"}`}>
          Desfase: <span className="tabular">{formatCop(previewDifference)}</span> {previewDifference < 0 ? "(falta plata)" : "(sobra plata)"}
        </p>
      )}
      {message && <p className="mt-2 rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{message}</p>}
      {snapshots.length > 1 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase text-ink-60">
                <th className="py-2 pr-3 font-semibold">Fecha</th>
                <th className="py-2 pr-3 font-semibold">Real</th>
                <th className="py-2 pr-3 font-semibold">Teorico</th>
                <th className="py-2 pr-3 font-semibold">Desfase</th>
                <th className="py-2 font-semibold">Nota</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.slice(0, 10).map((snapshot) => (
                <tr key={snapshot.id} className="border-b border-white/5 last:border-0">
                  <td className="py-2 pr-3">{snapshot.createdAt.slice(0, 10)}</td>
                  <td className="py-2 pr-3"><span className="tabular">{formatCop(snapshot.balanceCop)}</span></td>
                  <td className="py-2 pr-3"><span className="tabular">{formatCop(snapshot.expectedCop)}</span></td>
                  <td className={`py-2 pr-3 font-bold ${snapshot.differenceCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(snapshot.differenceCop)}</span></td>
                  <td className="py-2 text-xs text-ink-60">{snapshot.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function settlementFinancialView(state: AppState, settlement: Settlement) {
  // Set, no `includes`: esto es una busqueda lineal dentro de otra sobre el ledger entero (10.452
  // asientos por ~162 ids de media, con cortes de hasta 1.352). Las diez filas visibles costaban
  // 53 ms medidos, y un movil de gama media va entre tres y seis veces mas lento.
  const settlementEntryIds = new Set(settlement.walletEntryIds);
  const settlementEntries = state.wallet.filter((entry) => settlementEntryIds.has(entry.id));
  const sumEntries = (types: WalletEntry["type"][]) => settlementEntries
    .filter((entry) => types.includes(entry.type))
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const orderIds = settlement.orderIds.length > 0
    ? settlement.orderIds
    : Array.from(new Set(settlementEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
  if (settlement.kind === "driver") {
    const driverView = calculateDriverSettlementFinancials(state.wallet, settlement);
    return { ...driverView, productCostCop: 0, gmfCop: 0, advancesCop: 0, grossPayableCop: driverView.netCop };
  }
  if (settlement.kind === "supplier") {
    const productCostCop = typeof settlement.productCostCop === "number"
      ? settlement.productCostCop
      : Math.max(0, -sumEntries(["product_cost"]));
    return {
      codCop: 0,
      feesCop: 0,
      driverPayCop: 0,
      platformMarginCop: 0,
      cashToReturnCop: 0,
      receivableCop: productCostCop,
      netCop: productCostCop,
      productCostCop,
      gmfCop: 0,
      advancesCop: 0,
      grossPayableCop: productCostCop
    };
  }
  const netCop = settlement.netCop;
  // El neto de un corte de tienda es lo que FALTA por girar, no lo que valio el corte: si durante
  // la semana ya se le abono a la tienda, cierra en $0 aunque hayan sido 200 pedidos. Los abonos
  // se separan aparte para poder mostrar el bruto al lado del neto. Se leen de los asientos
  // (el admin baja la coleccion completa); si no estuvieran cargados, se derivan del documento.
  const hasEntries = settlementEntries.length > 0;
  const productCostCop = hasEntries ? -sumEntries(["product_cost"]) : Math.round(Number(settlement.productCostCop) || 0);
  const gmfCop = hasEntries ? -sumEntries(["gmf_tax"]) : Math.round(Number(settlement.gmfCop) || 0);
  const advancesCop = hasEntries
    ? -sumEntries(["seller_abono", "payout"])
    : settlement.codCop - settlement.feesCop - productCostCop - gmfCop - netCop;
  // En un corte de tienda solo hay asientos de la tienda, asi que el driverPayCop guardado
  // es 0 y el platformMarginCop del documento quedo igual al cobro bruto. El margen real de
  // esos pedidos se recalcula desde los asientos del domiciliario para no inflar la cifra.
  const settlementOrderIdSet = new Set(orderIds);
  const driverPayCop = state.wallet
    .filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning" && entry.orderId && settlementOrderIdSet.has(entry.orderId))
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  return {
    codCop: settlement.codCop,
    feesCop: settlement.feesCop,
    driverPayCop,
    platformMarginCop: settlement.feesCop - driverPayCop,
    cashToReturnCop: 0,
    receivableCop: Math.max(0, netCop),
    netCop,
    productCostCop,
    gmfCop,
    advancesCop,
    grossPayableCop: netCop + advancesCop
  };
}

// `audits` se recibe ya calculado: sin el, buildLiquidationRows lo reconstruye por
// defecto y esta funcion se llama una vez por fila de la tabla, disparando una
// auditoria completa O(pedidos x movimientos) por cada corte visible.
function settlementLiquidationRow(state: AppState, settlement: Settlement, audits: LiquidationOrderAudit[]): LiquidationRow | null {
  const entryIds = new Set(settlement.walletEntryIds);
  const settlementEntries = state.wallet.filter((entry) => entryIds.has(entry.id));
  const rows = buildLiquidationRows(state, settlementEntries, state.wallet, audits);
  return rows.find((row) => row.role === settlement.kind && row.id === settlement.ownerId) ?? null;
}

function driverCashReceiptTotal(settlement: Settlement) {
  return (settlement.cashReceipts ?? []).reduce((sum, receipt) => sum + Math.max(0, Number(receipt.amountCop) || 0), 0);
}

function driverCashReceivedCop(settlement: Settlement) {
  return typeof settlement.cashReceivedCop === "number"
    ? Math.max(0, Number(settlement.cashReceivedCop) || 0)
    : driverCashReceiptTotal(settlement);
}

function driverCashPendingCop(state: AppState, settlement: Settlement) {
  if (settlement.kind !== "driver") return 0;
  const view = settlementFinancialView(state, settlement);
  const expectedCop = typeof settlement.cashExpectedCop === "number"
    ? Math.max(0, Number(settlement.cashExpectedCop) || 0)
    : view.cashToReturnCop;
  const calculatedPendingCop = Math.max(0, expectedCop - driverCashReceivedCop(settlement));
  const explicitPendingCop = typeof settlement.cashPendingCop === "number"
    ? Math.max(0, Number(settlement.cashPendingCop) || 0)
    : 0;
  return Math.max(explicitPendingCop, calculatedPendingCop);
}

/** Cierra un corte por el monto realmente transferido. La diferencia no se pierde:
 *  queda como saldo a favor de la tienda para el siguiente corte. */
function PartialSettlementPaymentModal({
  settlement,
  netCop,
  onClose,
  onConfirm
}: {
  settlement: Settlement;
  netCop: number;
  onClose: () => void;
  onConfirm: (paidAmountCop: number) => void;
}) {
  useEscapeToClose(onClose);
  const [amount, setAmount] = useState("");
  const paidAmountCop = Number(amount.replace(/[^\d]/g, ""));
  const canSubmit = paidAmountCop > 0 && paidAmountCop <= netCop;
  const remainingCop = Math.max(0, netCop - paidAmountCop);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true">
      <Card className="grid w-full max-w-md gap-3">
        <div>
          <h2 className="font-bold">Pago parcial a {settlement.ownerName}</h2>
          <p className="text-sm text-ink-60">Neto del corte: <b><span className="tabular">{formatCop(netCop)}</span></b>.</p>
        </div>
        <label className="grid gap-1 text-sm">
          <span className="font-semibold">Monto transferido</span>
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
          />
        </label>
        {paidAmountCop > 0 && (
          <p className="text-sm text-ink-60">
            Quedan <b><span className="tabular">{formatCop(remainingCop)}</span></b> como saldo a favor de {settlement.ownerName} para el proximo corte.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
            type="button"
            disabled={!canSubmit}
            onClick={() => onConfirm(paidAmountCop)}
          >
            Registrar pago
          </button>
        </div>
      </Card>
    </div>
  );
}

function SettlementsTable({
  state,
  settlements,
  busyId,
  actionError,
  onChangeStatus,
  onRecordCash
}: {
  state: AppState;
  settlements: Settlement[];
  busyId: string | null;
  actionError: string | null;
  onChangeStatus: (settlement: Settlement, status: "paid" | "reconciled", paidAmountCop?: number) => void;
  onRecordCash: (settlement: Settlement, pendingCop: number) => void;
}) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(settlements, 10);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [partialTarget, setPartialTarget] = useState<Settlement | null>(null);

  // Los pedidos de un corte cerrado suelen ser muy anteriores a la ventana de descarga, asi que
  // no estan en `state.orders`. Sin ellos el desglose por pedido sale vacio y el margen de la
  // fila queda corto. Se piden al abrir la fila: es el unico momento en que se miran, y son ~130
  // pedidos en 5 consultas por lote.
  const [detailOrders, setDetailOrders] = useState<Record<string, Order>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const requestedSettlementIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!expandedId || requestedSettlementIds.current.has(expandedId)) return;
    const settlement = settlements.find((item) => item.id === expandedId);
    if (!settlement) return;
    const known = new Set(state.orders.map((order) => order.id));
    const missing = (settlement.orderIds ?? []).filter((orderId) => orderId && !known.has(orderId));
    requestedSettlementIds.current.add(expandedId);
    if (missing.length === 0) return;
    let cancelled = false;
    setLoadingDetail(true);
    void fetchOrdersByIds(missing)
      .then((orders) => {
        if (cancelled) return;
        setDetailOrders((current) => {
          const next = { ...current };
          for (const order of orders) next[order.id] = order;
          return next;
        });
      })
      .catch((error: unknown) => console.warn("No se pudieron cargar los pedidos del corte.", error))
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedId, settlements, state.orders]);

  // Estado con los pedidos del corte abierto anadidos, para que los calculos de la tabla sigan
  // leyendo un unico `state` en vez de ramificarse.
  const stateWithDetail = useMemo(() => {
    const extra = Object.values(detailOrders);
    if (extra.length === 0) return state;
    const known = new Set(state.orders.map((order) => order.id));
    const merged = extra.filter((order) => !known.has(order.id));
    return merged.length === 0 ? state : { ...state, orders: [...state.orders, ...merged] };
  }, [state, detailOrders]);

  // Una sola auditoria para toda la tabla: antes cada fila reconstruia la suya.
  const audits = useMemo(() => buildLiquidationOrderAudits(stateWithDetail, stateWithDetail.wallet), [stateWithDetail]);

  // Las diez filas visibles cuestan ~98 ms medidos entre las dos derivaciones. Estaban dentro del
  // JSX, asi que se repetian en CADA render: al desplegar un modal, al escribir en un campo, o al
  // llegar cualquier emision de Firestore. Aqui se recalculan solo si cambian los datos.
  const rowViews = useMemo(
    () => new Map(visibleItems.map((settlement) => [
      settlement.id,
      {
        view: settlementFinancialView(stateWithDetail, settlement),
        detailRow: settlementLiquidationRow(stateWithDetail, settlement, audits)
      }
    ])),
    [visibleItems, stateWithDetail, audits]
  );
  return (
    <Card>
      {partialTarget && (
        <PartialSettlementPaymentModal
          settlement={partialTarget}
          netCop={Math.abs(settlementFinancialView(stateWithDetail, partialTarget).netCop)}
          onClose={() => setPartialTarget(null)}
          onConfirm={(paidAmountCop) => {
            setPartialTarget(null);
            onChangeStatus(partialTarget, "paid", paidAmountCop);
          }}
        />
      )}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold">Liquidaciones cerradas</h2>
          <p className="text-sm text-ink-60">Cortes guardados en Firestore con trazabilidad de estado.</p>
        </div>
        <span className="text-sm text-ink-60">{settlements.length} cortes</span>
      </div>
      {actionError && <p className="mb-3 rounded-2xl bg-rust/10 px-3 py-2 text-sm text-rust">{actionError}</p>}
      {settlements.length === 0 ? (
        <p className="text-sm text-ink-60">Todavia no hay liquidaciones cerradas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
                <th className="py-2 pr-3 font-semibold">Cuenta</th>
                <th className="py-2 pr-3 font-semibold">Rango</th>
                {/* Igual que en la tabla de pagos: COD, cobros, pago domiciliario y margen ya
                    viven en el detalle de cada corte; aqui solo estrechaban las columnas. */}
                <th className="py-2 pr-3 font-semibold">Pedidos</th>
                <th className="py-2 pr-3 font-semibold">Efectivo</th>
                <th className="py-2 pr-3 font-semibold">Neto</th>
                <th className="py-2 pr-3 font-semibold">Estado</th>
                <th className="py-2 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((settlement) => {
                const cached = rowViews.get(settlement.id);
                const view = cached?.view ?? settlementFinancialView(stateWithDetail, settlement);
                const detailRow = cached?.detailRow ?? settlementLiquidationRow(stateWithDetail, settlement, audits);
                const expanded = expandedId === settlement.id;
                const receiptTotal = driverCashReceivedCop(settlement);
                const cashPendingCop = driverCashPendingCop(stateWithDetail, settlement);
                const displayCashToReturnCop = settlement.kind === "driver" && (receiptTotal > 0 || typeof settlement.cashPendingCop === "number" || typeof settlement.cashExpectedCop === "number")
                  ? cashPendingCop
                  : view.cashToReturnCop;
                return (
                  <Fragment key={settlement.id}>
                    <tr className="border-b border-white/5 last:border-0">
                      <td className="py-3 pr-3">
                        <p className="font-semibold">{settlement.ownerName}</p>
                        <p className="text-xs text-ink-60">{settlementKindLabel(settlement.kind)}</p>
                      </td>
                      <td className="py-3 pr-3">{settlement.startDate} a {settlement.endDate}</td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <span className="tabular">{settlement.orderIds.length}</span>
                        {detailRow && <span className="text-ink-60"> · {detailRow.deliveredOrders}/{detailRow.failedOrders}</span>}
                      </td>
                      {/* Recibido contra esperado en una sola celda: por separado ninguno de los
                          dos numeros dice nada. */}
                      <td className="py-3 pr-3 whitespace-nowrap">
                        {settlement.kind === "driver" ? (
                          <>
                            <span className="tabular font-bold text-mint">{formatCop(receiptTotal)}</span>
                            <span className="tabular text-ink-60"> / {formatCop(displayCashToReturnCop)}</span>
                          </>
                        ) : "-"}
                      </td>
                      {/* Un corte de tienda ya abonado durante la semana cierra en $0: sin el
                          bruto debajo, la fila parece vacia y hay que abrir el detalle para saber
                          cuanto valio. */}
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <span className={`tabular font-bold ${view.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(view.netCop)}</span>
                        {view.advancesCop > 0 && (
                          <p className="text-xs font-semibold text-ink-60">
                            bruto <span className="tabular">{formatCop(view.grossPayableCop)}</span> · abonado <span className="tabular">{formatCop(view.advancesCop)}</span>
                          </p>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <span className={`rounded-2xl px-2 py-1 text-xs font-semibold ${settlement.status === "pending" ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                          {settlementStatusLabel(settlement.status)}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                            type="button"
                            onClick={() => setExpandedId(expanded ? null : settlement.id)}
                          >
                            {expanded ? "Ocultar" : "Detalle"}
                          </button>
                          {settlement.kind === "driver" && cashPendingCop > 0 && (
                            <button
                              className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
                              type="button"
                              disabled={busyId === `${settlement.id}-cash`}
                              onClick={() => onRecordCash(settlement, cashPendingCop)}
                            >
                              Registrar recaudo <span className="tabular">{formatCop(cashPendingCop)}</span>
                            </button>
                          )}
                          {settlement.status === "pending" && !(settlement.kind === "driver" && cashPendingCop > 0) && (
                            <>
                              <button
                                className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
                                type="button"
                                disabled={busyId === `${settlement.id}-paid`}
                                onClick={() => onChangeStatus(settlement, "paid")}
                              >
                                {busyId === `${settlement.id}-paid` ? "Guardando..." : "Marcar pagada"}
                              </button>
                              {settlement.kind !== "driver" && (
                                <button
                                  className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-field disabled:opacity-50"
                                  type="button"
                                  disabled={busyId === `${settlement.id}-paid`}
                                  onClick={() => setPartialTarget(settlement)}
                                >
                                  Pago parcial
                                </button>
                              )}
                            </>
                          )}
                          {settlement.status === "paid" && !(settlement.kind === "driver" && cashPendingCop > 0) && (
                            <button
                              className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
                              type="button"
                              disabled={busyId === `${settlement.id}-reconciled`}
                              onClick={() => onChangeStatus(settlement, "reconciled")}
                            >
                              {busyId === `${settlement.id}-reconciled` ? "Guardando..." : "Conciliar"}
                            </button>
                          )}
                        </div>
                        {settlement.kind === "driver" && cashPendingCop > 0 && settlement.status === "paid" && (
                          <p className="mt-2 text-xs font-semibold text-rust">Registra el recaudo pendiente antes de conciliar.</p>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-white/5">
                        <td colSpan={7} className="bg-field/60 px-3 py-3">
                          {loadingDetail ? <p className="text-sm text-ink-60">Cargando pedidos del corte...</p> : <ClosedSettlementDetail state={stateWithDetail} settlement={settlement} detailRow={detailRow} />}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <PaginationControls page={page} totalPages={totalPages} totalItems={settlements.length} onPageChange={setPage} />
        </div>
      )}
    </Card>
  );
}

function walletEntryTypeLabel(type: WalletEntry["type"]) {
  const labels: Record<WalletEntry["type"], string> = {
    cod_revenue: "COD recaudado",
    delivery_fee: "Cobro entrega tienda",
    failed_fee: "Cobro fallido tienda",
    fulfillment_fee: "Fulfillment",
    product_cost: "Costo producto",
    driver_earning: "Pago domiciliario",
    platform_margin: "Margen operativo plataforma",
    cod_remittance: "Remesa COD",
    payout: "Pago",
    seller_abono: "Abono a tienda",
    cash_shortage: "Faltante efectivo",
    gmf_tax: "4x1000",
    community_cashback: "Cashback lider de comunidad"
  };
  return labels[type] ?? type;
}

function ClosedSettlementDetail({ state, settlement, detailRow }: { state: AppState; settlement: Settlement; detailRow: LiquidationRow | null }) {
  // Todo esto barre el ledger entero, y antes vivia suelto en el cuerpo del componente: se repetia
  // en CADA render, incluida cada tecla escrita dentro del detalle abierto. Con `includes` sobre
  // arrays de hasta 1.352 ids ademas era cuadratico; los Set lo dejan lineal.
  const { settlementEntries, orderIds, audits } = useMemo(() => {
    const entryIds = new Set(settlement.walletEntryIds);
    // ISO 8601 ordena bien con comparacion directa; localeCompare (Intl) es un orden de magnitud
    // mas lento y aqui recorre miles de asientos.
    const entries = state.wallet
      .filter((entry) => entryIds.has(entry.id))
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0));
    const ids = settlement.orderIds.length > 0
      ? settlement.orderIds
      : Array.from(new Set(entries.map((entry) => entry.orderId).filter(Boolean) as string[]));
    const idSet = new Set(ids);
    const related = state.wallet.filter((entry) => entry.orderId && idSet.has(entry.orderId));
    return {
      settlementEntries: entries,
      orderIds: ids,
      audits: buildLiquidationOrderAudits(state, related).filter((audit) => idSet.has(audit.orderId))
    };
  }, [state, settlement]);
  const title = settlement.kind === "seller" ? "Detalle de pago a tienda" : "Detalle de corte del domiciliario";
  const view = settlementFinancialView(state, settlement);
  const receiptTotal = driverCashReceivedCop(settlement);
  const cashPendingCop = driverCashPendingCop(state, settlement);
  // Abonos de efectivo del domiciliario, uno por uno. Antes el admin solo veia el total: la nota
  // de cada recaudo se perdia porque `recordDriverCashReceipt` pisa la nota del corte con la del
  // ultimo abono, y 20 de los 26 cortes tienen mas de uno.
  const expectedCashCop = typeof settlement.cashExpectedCop === "number"
    ? Math.max(0, Number(settlement.cashExpectedCop) || 0)
    : view.cashToReturnCop;
  const receiptRows = settlement.kind === "driver"
    ? driverCashReceiptRows(settlement, expectedCashCop, receiptTotal)
    : [];
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">{title}</p>
          <DetailLine label="Cuenta" value={settlement.ownerName} />
          <DetailLine label="Estado" value={settlementStatusLabel(settlement.status)} tone={settlement.status === "pending" ? "rust" : "mint"} />
          <DetailLine label="Creada" value={new Date(settlement.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })} />
          {settlement.paidAt && <DetailLine label="Pagada" value={new Date(settlement.paidAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })} tone="mint" />}
          {settlement.reconciledAt && <DetailLine label="Conciliada" value={new Date(settlement.reconciledAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })} tone="mint" />}
        </div>
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">Valores calculados</p>
          <DetailLine label="COD" value={formatCop(view.codCop)} />
          <DetailLine label="Cobros operativos" value={formatCop(view.feesCop)} />
          {view.productCostCop !== 0 && <DetailLine label="Costo producto" value={formatCop(view.productCostCop)} />}
          {view.gmfCop > 0 && <DetailLine label="4x1000" value={formatCop(view.gmfCop)} />}
          <DetailLine label="Pago domiciliario" value={formatCop(view.driverPayCop)} />
          <DetailLine label="Margen operativo" value={formatCop(view.platformMarginCop)} tone={view.platformMarginCop < 0 ? "rust" : "mint"} />
          {/* Sin estas dos lineas el detalle tampoco cuadraba: el COD y los cobros no explican
              un neto en cero cuando la plata ya se giro por abonos. */}
          {view.advancesCop > 0 && (
            <>
              <DetailLine label="Neto antes de abonos" value={formatCop(view.grossPayableCop)} />
              <DetailLine label="Abonos ya girados" value={formatCop(view.advancesCop)} tone="mint" />
            </>
          )}
          <DetailLine label="Neto" value={formatCop(view.netCop)} tone={view.netCop < 0 ? "rust" : "mint"} />
          {settlement.kind === "driver" && (
            <>
              <DetailLine label="Efectivo esperado" value={formatCop(view.cashToReturnCop)} tone="rust" />
              <DetailLine label="Efectivo recibido" value={formatCop(receiptTotal)} tone="mint" />
              <DetailLine label="Pendiente efectivo" value={formatCop(cashPendingCop)} tone={cashPendingCop > 0 ? "rust" : "mint"} />
              {Number(settlement.cashExcessCop || 0) > 0 && (
                <DetailLine label="Excedente entregado" value={formatCop(Number(settlement.cashExcessCop))} tone="mint" />
              )}
            </>
          )}
          {typeof settlement.paidAmountCop === "number" && (
            <DetailLine label="Pagado realmente" value={formatCop(settlement.paidAmountCop)} tone="mint" />
          )}
        </div>
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">Pedidos</p>
          <DetailLine label="Total pedidos" value={orderIds.length} />
          <DetailLine label="Entregados" value={detailRow?.deliveredOrders ?? audits.filter((audit) => audit.status === "delivered").length} tone="mint" />
          <DetailLine label="Fallidos" value={detailRow?.failedOrders ?? audits.filter((audit) => audit.status === "failed").length} tone="rust" />
          <DetailLine label="Movimientos wallet" value={settlementEntries.length} />
        </div>
        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs font-bold uppercase text-ink-60">Nota del corte</p>
          <p className="text-sm text-ink-70">{settlement.note || "Sin nota registrada."}</p>
          {settlement.kind === "driver" && receiptRows.length > 0 && (
            // Al registrar un recaudo se pisa la nota del corte con la de ese abono, asi que esta
            // solo refleja el ultimo. Las de todos estan abajo.
            <p className="mt-2 text-xs text-ink-60">La nota de cada recaudo esta en &quot;Recaudos recibidos&quot;.</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold">Detalle por pedido</h3>
        <button
          className="focus-ring inline-flex min-h-9 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
          type="button"
          disabled={audits.length === 0}
          onClick={() => void downloadRowsXlsx("Liquidacion", liquidationAuditExportColumns, buildLiquidationAuditExportRows(audits), `liquidacion-${settlement.ownerName.replace(/[^a-z0-9]+/gi, "-")}-${settlement.id}.xlsx`)}
        >
          <FileDown size={16} />
          Descargar Excel ({audits.length})
        </button>
      </div>
      <LiquidationOrderAuditTable audits={audits} />

      {settlement.kind === "driver" && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold">Recaudos recibidos</h3>
            <span className="text-xs font-semibold text-ink-60">
              {receiptRows.length} abono{receiptRows.length === 1 ? "" : "s"} · <span className="tabular">{formatCop(receiptTotal)}</span>
            </span>
          </div>
          <div className="overflow-x-auto rounded-2xl bg-panel">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
                  <th className="py-2 pl-3 pr-3 font-semibold">Fecha</th>
                  <th className="py-2 pr-3 text-right font-semibold">Valor</th>
                  <th className="py-2 pr-3 text-right font-semibold">Pendiente despues</th>
                  <th className="py-2 pr-3 font-semibold">Nota</th>
                </tr>
              </thead>
              <tbody>
                {receiptRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 pl-3 pr-3 text-sm text-ink-60">Todavia no se ha registrado ningun recaudo de este corte.</td>
                  </tr>
                ) : (
                  receiptRows.map((receipt) => (
                    <tr key={receipt.id} className="border-b border-white/5 last:border-0">
                      <td className="py-3 pl-3 pr-3">{new Date(receipt.receivedAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</td>
                      <td className="py-3 pr-3 text-right font-bold text-mint"><span className="tabular">{formatCop(receipt.amountCop)}</span></td>
                      <td className={`py-3 pr-3 text-right font-semibold ${receipt.pendingAfterCop > 0 ? "text-rust" : "text-ink-60"}`}><span className="tabular">{formatCop(receipt.pendingAfterCop)}</span></td>
                      <td className="py-3 pr-3 text-ink-70">{receipt.note || (receipt.synthetic ? "Registro historico sin detalle" : "-")}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="overflow-x-auto rounded-2xl bg-panel">
        <table className="w-full min-w-[833px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-normal text-ink-60">
              <th className="py-2 pl-3 pr-3 font-semibold">Movimiento</th>
              <th className="py-2 pr-3 font-semibold">Pedido</th>
              <th className="py-2 pr-3 font-semibold">Tipo</th>
              <th className="py-2 pr-3 font-semibold">Fecha</th>
              <th className="py-2 pr-3 text-right font-semibold">Valor</th>
            </tr>
          </thead>
          <tbody>
            {settlementEntries.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 pl-3 pr-3 text-sm text-ink-60">No hay movimientos de wallet cargados para este corte.</td>
              </tr>
            ) : (
              settlementEntries.map((entry) => {
                const order = state.orders.find((item) => item.id === entry.orderId);
                return (
                  <tr key={entry.id} className="border-b border-white/5 last:border-0">
                    <td className="py-3 pl-3 pr-3">
                      <p className="font-semibold">{entry.description}</p>
                      <p className="text-xs text-ink-60">{entry.id}</p>
                    </td>
                    <td className="py-3 pr-3">
                      <p className="font-semibold">{order?.trackingCode ?? entry.orderId ?? "-"}</p>
                      <p className="text-xs text-ink-60">{order?.shopifyOrderId ?? ""}</p>
                    </td>
                    <td className="py-3 pr-3">{walletEntryTypeLabel(entry.type)}</td>
                    <td className="py-3 pr-3">{new Date(entry.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td className={`py-3 pr-3 text-right font-bold ${entry.amountCop < 0 ? "text-rust" : "text-mint"}`}><span className="tabular">{formatCop(entry.amountCop)}</span></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyRoleState({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <h2 className="font-bold">{title}</h2>
      <p className="mt-2 text-sm text-ink-60">{message}</p>
    </Card>
  );
}

function ShopifyInstallRequestsPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const requests = [...(state.shopifyInstallRequests ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const [links, setLinks] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  async function saveLink(request: ShopifyInstallRequest) {
    const installLink = (links[request.id] ?? request.installLink ?? "").trim();
    if (!installLink.startsWith("https://")) {
      setMessage("Pega un enlace de instalacion valido generado por Shopify.");
      return;
    }
    const now = new Date().toISOString();
    const updated: ShopifyInstallRequest = {
      ...request,
      installLink,
      status: "link_ready",
      updatedAt: now,
      fulfilledAt: now
    };
    const nextState = {
      ...state,
      shopifyInstallRequests: (state.shopifyInstallRequests ?? []).map((item) => (item.id === request.id ? updated : item))
    };
    setState(nextState);
    await saveFirestoreShopifyInstallRequest(updated);
    setMessage(`Enlace publicado para ${request.shopDomain}.`);
  }

  async function cancelRequest(request: ShopifyInstallRequest) {
    const updated: ShopifyInstallRequest = { ...request, status: "cancelled", updatedAt: new Date().toISOString() };
    const nextState = {
      ...state,
      shopifyInstallRequests: (state.shopifyInstallRequests ?? []).map((item) => (item.id === request.id ? updated : item))
    };
    setState(nextState);
    await saveFirestoreShopifyInstallRequest(updated);
  }

  return (
    <Card>
      <h2 className="mb-3 font-bold">Solicitudes Shopify</h2>
      {message && <p className="mb-3 rounded-2xl bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">{message}</p>}
      <PaginatedList items={requests} pageSize={8} empty={<p className="text-sm text-ink-60">No hay solicitudes pendientes.</p>}>
        {(request) => {
            const mailBody = [
              `Tienda: ${request.shopDomain}`,
              `Vendedor: ${request.sellerName}`,
              request.orderSkuContains ? `Filtro: SKU contiene ${request.orderSkuContains}` : "",
              request.observation ? `Observacion: ${request.observation}` : "",
              "",
              "Genera el enlace en Shopify Dev Dashboard > Kentro Pilot > Distribution > Custom distribution y pegalo en Kentro."
            ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
            return (
              <div key={request.id} className="rounded-2xl border border-white/10 p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{request.shopDomain}</p>
                    <p className="text-xs text-ink-60">{request.sellerName} · {request.status === "link_ready" ? "enlace listo" : request.status === "cancelled" ? "cancelada" : "pendiente"}</p>
                    {request.orderSkuContains && <p className="mt-1 text-xs font-semibold text-ink-60">Filtro: SKU contiene {request.orderSkuContains}</p>}
                    {request.observation && <p className="mt-1 text-xs text-ink-60">Observacion: {request.observation}</p>}
                  </div>
                  <a className="focus-ring rounded-full bg-field px-2 py-1 text-xs font-semibold" href={`mailto:?subject=${encodeURIComponent(`Solicitud Shopify ${request.shopDomain}`)}&body=${encodeURIComponent(mailBody)}`}>
                    Email
                  </a>
                </div>
                {request.status === "installed" ? (
                  <span className="mt-3 inline-flex min-h-9 items-center justify-center rounded-2xl bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
                    Instalada
                  </span>
                ) : request.status !== "cancelled" && (
                  <div className="mt-3 grid gap-2">
                    <input
                      className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs"
                      placeholder="Pegar install link generado por Shopify"
                      value={links[request.id] ?? request.installLink ?? ""}
                      onChange={(event) => setLinks((current) => ({ ...current, [request.id]: event.target.value }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep" type="button" onClick={() => void saveLink(request)}>
                        Publicar enlace
                      </button>
                      {request.installLink && (
                        <a className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold" href={request.installLink} target="_blank" rel="noreferrer">
                          Abrir
                        </a>
                      )}
                      <button className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold text-ink-60" type="button" onClick={() => void cancelRequest(request)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          }}
      </PaginatedList>
    </Card>
  );
}

function ShopifyStoresAdminPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const stores = [...(state.shopifyStores ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const [message, setMessage] = useState("");

  async function assignStore(store: ShopifyStore, sellerId: string) {
    if (!sellerId) return;
    const seller = state.sellers.find((item) => item.id === sellerId);
    const now = new Date().toISOString();
    const updated = { ...store, sellerId, updatedAt: now };
    const updatedRequests = (state.shopifyInstallRequests ?? []).map((request) =>
      request.shopDomain === store.shopDomain && request.sellerId === sellerId ? { ...request, status: "installed" as const, updatedAt: now } : request
    );
    const nextState = {
      ...state,
      shopifyStores: (state.shopifyStores ?? []).map((item) => (item.id === store.id ? updated : item)),
      shopifyInstallRequests: updatedRequests,
      sellers: seller ? state.sellers.map((item) => (item.id === seller.id ? { ...item, shopDomain: store.shopDomain } : item)) : state.sellers
    };
    setState(nextState);
    await saveFirestoreState(nextState);
    setMessage(`${store.shopDomain} asignada a ${seller?.name ?? sellerId}.`);
  }

  return (
    <Card>
      <h2 className="mb-3 font-bold">Tiendas Shopify</h2>
      {message && <p className="mb-3 rounded-2xl bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">{message}</p>}
      <PaginatedList items={stores} pageSize={8} empty={<p className="text-sm text-ink-60">Todavia no hay tiendas conectadas.</p>}>
        {(store) => {
            const seller = state.sellers.find((item) => item.id === store.sellerId);
            return (
              <div key={store.id} className="rounded-2xl border border-white/10 p-3 text-sm">
                <p className="font-semibold">{store.shopDomain}</p>
                <p className="text-xs text-ink-60">
                  {seller ? `Vendedor: ${seller.name}` : "Sin vendedor asignado"} · {store.lastWebhookAt ? `Ultimo webhook: ${formatDateTime(store.lastWebhookAt)}` : "Sin webhooks recibidos"}
                </p>
                {store.orderSkuContains && <p className="mt-1 text-xs font-semibold text-ink-60">Filtro activo: SKU contiene {store.orderSkuContains}</p>}
                <div className="mt-2 grid gap-2">
                  <select
                    className="focus-ring rounded-full border border-white/10 px-3 py-2 text-xs"
                    value={seller?.id ?? ""}
                    onChange={(event) => void assignStore(store, event.target.value)}
                  >
                    <option value="">Asignar vendedor</option>
                    {state.sellers.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          }}
      </PaginatedList>
    </Card>
  );
}

function UchatConfigForm({ sellerId, config }: { sellerId: string; config?: StoreWebhookConfig }) {
  const [token, setToken] = useState("");
  const [dropiToken, setDropiToken] = useState("");
  const [platform, setPlatform] = useState<"chatby" | "chateapro" | "lucidbot">(config?.uchatPlatform ?? "chatby");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const configured = Boolean(config?.uchatConfigured);
  const enabled = Boolean(config?.uchatConfirmEnabled);
  const dropiConfigured = Boolean(config?.uchatDropiConfigured);

  async function save(nextEnabled: boolean, clear = false) {
    setBusy(true);
    setMessage("");
    try {
      const res = await setFirebaseStoreUchatConfig({
        sellerId,
        apiToken: clear ? "" : token.trim() ? token.trim() : undefined,
        dropiApiToken: clear ? "" : dropiToken.trim() ? dropiToken.trim() : undefined,
        platform,
        enabled: nextEnabled
      });
      setToken("");
      setDropiToken("");
      setMessage(res.configured ? (res.enabled ? "Token guardado y confirmacion activa." : "Token guardado (pausado).") : "Token eliminado.");
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-fg">Confirmacion por API Chateapro / Chatby</p>
        <span className={`rounded-2xl px-2 py-1 text-xs font-semibold ${configured ? (enabled ? "bg-acid text-deep" : "bg-field text-ink-60") : "bg-field text-ink-60"}`}>
          {configured ? (enabled ? "Activo" : "Pausado") : "Sin token"}
        </span>
      </div>
      <label className="grid gap-1 text-xs text-ink-60">
        Plataforma
        <select
          className="rounded-2xl border border-white/10 bg-field px-3 py-2 text-xs text-fg"
          value={platform}
          onChange={(event) => setPlatform(event.target.value as "chatby" | "chateapro" | "lucidbot")}
        >
          <option value="chatby">Chatby (verificado)</option>
          <option value="chateapro">Chateapro (verificado)</option>
          <option value="lucidbot">LucidBot (verificado)</option>
        </select>
      </label>
      <input
        className="rounded-2xl border border-white/10 bg-field px-3 py-2 text-xs text-fg"
        type="password"
        placeholder={configured ? "Token configurado — pega uno nuevo para reemplazar" : "Pega el API token de Chateapro / Chatby / LucidBot"}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      {platform === "lucidbot" && (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-fg">Sincronizacion Dropi ↔ LucidBot</p>
            <span className={`rounded-2xl px-2 py-1 text-xs font-semibold ${dropiConfigured ? "bg-acid text-deep" : "bg-field text-ink-60"}`}>
              {dropiConfigured ? "Token Dropi configurado" : "Sin token Dropi"}
            </span>
          </div>
          <input
            className="rounded-2xl border border-white/10 bg-field px-3 py-2 text-xs text-fg"
            type="password"
            placeholder={dropiConfigured ? "Token Dropi configurado — pega uno nuevo para reemplazar" : "Pega el token de integracion de Dropi (dropi-integration-key)"}
            value={dropiToken}
            onChange={(event) => setDropiToken(event.target.value)}
          />
          <p className="text-xs text-ink-60">Se genera en Dropi → Integraciones. Permite a Kentro consultar y ajustar los pedidos que LucidBot sube a Dropi (auditoria de duplicados).</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={busy || (!token.trim() && !dropiToken.trim() && !configured)} onClick={() => void save(true)}>
          {busy ? "Guardando..." : configured ? "Actualizar token" : "Guardar token"}
        </button>
        {configured && (
          <button className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold" type="button" disabled={busy} onClick={() => void save(!enabled)}>
            {enabled ? "Pausar" : "Reactivar"}
          </button>
        )}
        {configured && (
          <button className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold text-red-600" type="button" disabled={busy} onClick={() => void save(false, true)}>
            Quitar token
          </button>
        )}
        <span className="rounded-2xl bg-field px-3 py-2 text-xs font-semibold text-ink-60">
          {config?.lastUchatPullAt ? `Ultimo chequeo: ${formatDateTime(config.lastUchatPullAt)}` : "Sin chequeos aun"}
        </span>
      </div>
      <p className="text-xs text-ink-60">Kentro consulta la API de Chateapro / Chatby cada ~2 h y pasa a &quot;Listo para asignar&quot; los pedidos marcados como Verificado o Confirmado (sincronizando direccion). El token se guarda del lado servidor, no se muestra.</p>
      {message && <p className="text-xs font-semibold text-fg">{message}</p>}
    </div>
  );
}

function UchatConfigsAdminPanel({ configs, sellers }: { configs: StoreWebhookConfig[]; sellers: Seller[] }) {
  const orderedSellers = [...sellers].sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? "")));
  return (
    <Card>
      <h2 className="mb-3 font-bold">Confirmacion por API (Chateapro / Chatby)</h2>
      <PaginatedList items={orderedSellers} pageSize={8} empty={<p className="text-sm text-ink-60">No hay tiendas.</p>}>
        {(seller) => {
          const config = configs.find((item) => item.sellerId === seller.id);
          return (
            <div key={seller.id} className="grid gap-2 rounded-2xl border border-white/10 p-3 text-sm">
              <p className="font-semibold">{seller.name}</p>
              <UchatConfigForm sellerId={seller.id} config={config} />
            </div>
          );
        }}
      </PaginatedList>
    </Card>
  );
}

function StoreWebhookConfigsPanel({ configs, sellers }: { configs: StoreWebhookConfig[]; sellers: Seller[] }) {
  const activeConfigs = [...configs].filter((config) => config.status === "active").sort((left, right) => left.sellerName.localeCompare(right.sellerName));
  return (
    <Card>
      <h2 className="mb-3 font-bold">Webhooks Shopify por tienda</h2>
      <PaginatedList items={activeConfigs} pageSize={8} empty={<p className="text-sm text-ink-60">No hay webhooks generados.</p>}>
        {(config) => {
          const seller = sellers.find((item) => item.id === config.sellerId);
          const url = `https://us-central1-kentro-last-mile.cloudfunctions.net/storeOrderWebhook?sellerId=${encodeURIComponent(config.sellerId)}&key=${encodeURIComponent(config.webhookKey)}`;
          return (
            <div key={config.id} className="grid gap-2 rounded-2xl border border-white/10 p-3 text-sm">
              <div>
                <p className="font-semibold">{seller?.name ?? config.sellerName}</p>
                <p className="text-xs text-ink-60">{config.shopDomain || "Sin dominio"} · {config.lastWebhookAt ? `Ultimo webhook: ${formatDateTime(config.lastWebhookAt)}` : "Sin webhooks recibidos"}</p>
              </div>
              <input className="rounded-2xl border border-white/10 bg-field px-3 py-2 text-xs" readOnly value={url} />
              <div className="flex flex-wrap gap-2">
                <button className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold" type="button" onClick={() => void navigator.clipboard?.writeText(url)}>
                  Copiar URL
                </button>
                <span className="rounded-2xl bg-field px-3 py-2 text-xs font-semibold">SKU {config.skuContains || "ADMA"}</span>
                <span className="rounded-2xl bg-field px-3 py-2 text-xs font-semibold">Etiqueta {config.tagContains || "ADMA"}</span>
              </div>
              <p className="text-xs text-ink-60">Configurar esta URL en Order creation y Order update. Para pedidos viejos, agregar etiqueta {config.tagContains || "ADMA"} en Shopify.</p>
            </div>
          );
        }}
      </PaginatedList>
    </Card>
  );
}

function ShopifyImportOrderPanel({ stores, sellers, lockedSellerId, onImported }: { stores: ShopifyStore[]; sellers: Seller[]; lockedSellerId?: string; onImported: (order: Order) => void }) {
  const visibleStores = lockedSellerId ? stores.filter((store) => store.sellerId === lockedSellerId) : stores;
  const [shopDomain, setShopDomain] = useState(visibleStores[0]?.shopDomain ?? "");
  const [sellerId, setSellerId] = useState(lockedSellerId ?? visibleStores.find((store) => store.sellerId !== "unassigned")?.sellerId ?? "");
  const [reference, setReference] = useState("");
  const [syncStartDate, setSyncStartDate] = useState(dateValue(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)));
  const [syncEndDate, setSyncEndDate] = useState(dateValue(new Date()));
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selectedStore = visibleStores.find((store) => store.shopDomain === shopDomain);
  const canImport = Boolean(shopDomain && reference.trim() && (lockedSellerId || sellerId || (selectedStore?.sellerId && selectedStore.sellerId !== "unassigned")));

  async function importOrder() {
    if (!canImport) return;
    setBusy(true);
    setMessage("");
    try {
      const assignedSellerId = selectedStore?.sellerId && selectedStore.sellerId !== "unassigned" ? selectedStore.sellerId : undefined;
      const resolvedSellerId = (lockedSellerId ?? sellerId) || assignedSellerId;
      const result = await importFirebaseShopifyOrder({ shopDomain, reference, sellerId: resolvedSellerId });
      onImported(result.order);
      setReference("");
      setMessage(`Pedido ${result.order.trackingCode ?? result.order.shopifyOrderId} importado.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo importar el pedido.");
    } finally {
      setBusy(false);
    }
  }

  async function syncHistorical() {
    if (!shopDomain || !syncStartDate || !syncEndDate) return;
    setSyncBusy(true);
    setMessage("");
    try {
      const assignedSellerId = selectedStore?.sellerId && selectedStore.sellerId !== "unassigned" ? selectedStore.sellerId : undefined;
      const resolvedSellerId = (lockedSellerId ?? sellerId) || assignedSellerId;
      const result = await syncFirebaseShopifyHistoricalOrders({ shopDomain, sellerId: resolvedSellerId, startDate: syncStartDate, endDate: syncEndDate });
      result.orders.forEach(onImported);
      setMessage(`Historico sincronizado: ${result.imported} nuevos, ${result.existing} ya existian, ${result.skippedOutsideCali} fuera de Cali, ${result.skippedSkuFilter ?? 0} sin SKU/etiqueta requerida.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo sincronizar el historico.");
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-bold">Importar pedido Shopify</h2>
      {visibleStores.length === 0 ? (
        <p className="text-sm text-ink-60">Primero conecta y asigna una tienda Shopify.</p>
      ) : (
        <div className="grid gap-2">
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={shopDomain} onChange={(event) => setShopDomain(event.target.value)}>
            {visibleStores.map((store) => (
              <option key={store.id} value={store.shopDomain}>{store.shopDomain}</option>
            ))}
          </select>
          {!lockedSellerId && (
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
              <option value="">Usar vendedor asignado</option>
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>{seller.name}</option>
              ))}
            </select>
          )}
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm"
            placeholder="Numero Shopify, ej: #1024"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          {message && <p className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">{message}</p>}
          <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={!canImport || busy} onClick={() => void importOrder()}>
            {busy ? "Importando..." : "Importar pedido"}
          </button>
          <div className="mt-2 grid gap-2 rounded-2xl border border-white/10 p-3">
            <p className="text-sm font-bold">Sincronizar historicos</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Desde
                <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={syncStartDate} onChange={(event) => setSyncStartDate(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-60">
                Hasta
                <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={syncEndDate} onChange={(event) => setSyncEndDate(event.target.value)} />
              </label>
            </div>
            <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold hover:bg-field disabled:opacity-50" type="button" disabled={!shopDomain || syncBusy} onClick={() => void syncHistorical()}>
              {syncBusy ? "Sincronizando..." : "Sincronizar rango"}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ShopifySyncIssuesPanel({ issues, sellers }: { issues: ShopifySyncIssue[]; sellers: Seller[] }) {
  const [page, setPage] = useState(0);
  const pageSize = 5;
  const openIssues = [...issues]
    .filter((issue) => issue.status !== "resolved")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const totalPages = Math.max(1, Math.ceil(openIssues.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const visibleIssues = openIssues.slice(safePage * pageSize, safePage * pageSize + pageSize);
  if (openIssues.length === 0) return null;

  return (
    <Card>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-bold">Pedidos Shopify no sincronizados</h2>
          <p className="text-xs text-ink-60">{openIssues.length} mas recientes · pagina {safePage + 1} de {totalPages}</p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton title="Pagina anterior" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton title="Pagina siguiente" disabled={safePage >= totalPages - 1} onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
      </div>
      <div className="grid gap-2">
        {visibleIssues.map((issue) => {
          const seller = sellers.find((item) => item.id === issue.sellerId);
          return (
            <div key={issue.id} className="rounded-2xl border border-rust/20 bg-rust/10 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{issue.reference}</p>
                  <p className="text-xs text-ink-60">{seller?.name ?? issue.sellerId} · {issue.shopDomain}</p>
                </div>
                <span className="shrink-0 rounded bg-panel px-2 py-1 text-xs font-semibold text-rust">Pendiente</span>
              </div>
              <p className="mt-2 text-xs text-rust">{issue.reason}</p>
              {issue.detail && <p className="mt-1 text-xs text-ink-60">{issue.detail}</p>}
              <p className="mt-2 text-xs text-ink-60">{formatDateTime(issue.updatedAt)}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function StoreApiKeyCard({ sellerId }: { sellerId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [usage, setUsage] = useState<{ kpis: string; orders: string; settlements: string } | null>(null);

  async function fetchKey(rotate: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await createFirebaseStoreApiKey({ sellerId, ...(rotate ? { rotate: true } : {}) });
      setApiKey(result.config.apiKey);
      setUsage(result.usage);
      setMessage(rotate ? "API key rotada. La key anterior dejo de funcionar; actualiza tus integraciones." : "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo obtener la API key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-bold">API de tienda</h2>
          <p className="text-xs text-ink-60">Consulta por API (solo lectura) tus pedidos, KPIs operativos y liquidaciones. La key solo ve los datos de tu tienda, sin importar como esta conectada (Shopify, webhook o manual).</p>
        </div>
        <button
          className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
          type="button"
          disabled={busy}
          onClick={() => void fetchKey(false)}
        >
          {busy ? "Consultando..." : apiKey ? "Actualizar" : "Ver mi API key"}
        </button>
      </div>
      {apiKey && (
        <div className="mt-3 grid gap-2">
          <input className="rounded-2xl border border-white/10 bg-field px-3 py-2 text-xs text-fg" readOnly value={apiKey} />
          <div className="flex flex-wrap gap-2">
            <button className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold hover:bg-white/10" type="button" onClick={() => void navigator.clipboard?.writeText(apiKey)}>
              Copiar API key
            </button>
            {usage && (
              <button className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold hover:bg-white/10" type="button" onClick={() => void navigator.clipboard?.writeText(usage.orders)}>
                Copiar URL de pedidos
              </button>
            )}
            <button
              className="focus-ring rounded-full bg-field px-3 py-2 text-xs font-semibold text-rust hover:bg-white/10"
              type="button"
              disabled={busy}
              onClick={() => { if (window.confirm("¿Rotar la API key? La key actual dejara de funcionar inmediatamente.")) void fetchKey(true); }}
            >
              Rotar key
            </button>
          </div>
          <div className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">
            <p className="font-semibold text-fg">Endpoints</p>
            <p>GET /storeApi/kpis — KPIs operativos (mismas formulas del dashboard).</p>
            <p>GET /storeApi/orders — pedidos con clasificacion operativa y estado de pago.</p>
            <p>GET /storeApi/settlements — liquidaciones: que pedidos ya se pagaron y cuales no.</p>
            <p className="mt-1">
              Manual completo: <a className="font-semibold text-fg underline" href="/api-tiendas" target="_blank" rel="noreferrer">kentro-last-mile.web.app/api-tiendas</a>
            </p>
          </div>
        </div>
      )}
      {message && <p className="mt-3 rounded-2xl bg-field px-3 py-2 text-xs font-semibold text-ink-70">{message}</p>}
    </Card>
  );
}

function ShopifyConnectionPanel({ seller, stores, requests, state, setState }: { seller: Seller; stores: ShopifyStore[]; requests: ShopifyInstallRequest[]; state: AppState; setState: (state: AppState) => void }) {
  const [shop, setShop] = useState("");
  const [observation, setObservation] = useState("");
  const [orderSkuContains, setOrderSkuContains] = useState("");
  const [message, setMessage] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  const primaryStore = stores[0];
  const webhookConfig = (state.storeWebhookConfigs ?? []).find((config) => config.sellerId === seller.id && config.status === "active");
  const webhookUrl = webhookConfig ? `https://us-central1-kentro-last-mile.cloudfunctions.net/storeOrderWebhook?sellerId=${encodeURIComponent(webhookConfig.sellerId)}&key=${encodeURIComponent(webhookConfig.webhookKey)}` : "";
  const shopify = getSellerShopifyConnection(seller.id, seller.shopDomain, primaryStore);
  const normalizedShop = shop.trim() ? normalizeShopifyDomain(shop) : "";
  const alreadyConnected = normalizedShop ? stores.some((store) => store.shopDomain === normalizedShop) : false;
  const existingRequest = normalizedShop ? requests.find((request) => request.shopDomain === normalizedShop && request.status !== "cancelled") : undefined;
  const canRequest = Boolean(normalizedShop && !alreadyConnected && !existingRequest?.installLink);
  const requested = requests.filter((request) => request.status !== "cancelled");

  async function requestInstallLink() {
    if (!normalizedShop || alreadyConnected) return;
    const now = new Date().toISOString();
    const request: ShopifyInstallRequest = {
      id: shopifyRequestId(seller.id, normalizedShop),
      sellerId: seller.id,
      sellerName: seller.name,
      shopDomain: normalizedShop,
      status: "requested",
      ...(observation.trim() ? { observation: observation.trim() } : {}),
      ...(orderSkuContains.trim() ? { orderSkuContains: orderSkuContains.trim().toUpperCase() } : {}),
      requestedAt: existingRequest?.requestedAt ?? now,
      updatedAt: now
    };
    const nextState = {
      ...state,
      shopifyInstallRequests: [request, ...(state.shopifyInstallRequests ?? []).filter((item) => item.id !== request.id)]
    };
    setState(nextState);
    await saveFirestoreShopifyInstallRequest(request);
    setMessage("Solicitud enviada. Kentro generara el enlace privado de instalacion y aparecera aqui.");
  }

  async function createWebhookConfig() {
    setWebhookBusy(true);
    setMessage("");
    try {
      const result = await createFirebaseStoreWebhookConfig({
        sellerId: seller.id,
        shopDomain: normalizedShop || seller.shopDomain || undefined,
        skuContains: orderSkuContains.trim() || "ADMA",
        tagContains: "ADMA"
      });
      setState({
        ...state,
        storeWebhookConfigs: [result.config, ...(state.storeWebhookConfigs ?? []).filter((item) => item.id !== result.config.id)]
      });
      setMessage("Webhook generado. Configura Order creation y Order update con la misma URL.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo generar el webhook.");
    } finally {
      setWebhookBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-bold">Conexion Shopify</h2>
      <div className="grid gap-3 rounded-2xl border border-white/10 p-3">
        <div className="grid gap-2 rounded-2xl bg-field p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-semibold">Webhook de sincronizacion</p>
              <p className="text-xs text-ink-60">Configura la misma URL en Shopify para Order creation y Order update.</p>
            </div>
            <button
              className="focus-ring rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed"
              type="button"
              disabled={webhookBusy}
              onClick={() => void createWebhookConfig()}
            >
              {webhookConfig ? "Actualizar webhook" : webhookBusy ? "Generando..." : "Generar webhook"}
            </button>
          </div>
          {webhookConfig && (
            <div className="grid gap-2">
              <input className="rounded-2xl border border-white/10 bg-panel px-3 py-2 text-xs text-fg" readOnly value={webhookUrl} />
              <div className="flex flex-wrap gap-2">
                <button className="focus-ring rounded-full bg-panel px-3 py-2 text-xs font-semibold" type="button" onClick={() => void navigator.clipboard?.writeText(webhookUrl)}>
                  Copiar URL
                </button>
                <span className="rounded-2xl bg-panel px-3 py-2 text-xs font-semibold text-ink-60">SKU contiene {webhookConfig.skuContains || "ADMA"}</span>
                <span className="rounded-2xl bg-panel px-3 py-2 text-xs font-semibold text-ink-60">Etiqueta {webhookConfig.tagContains || "ADMA"}</span>
              </div>
              <div className="rounded-2xl bg-panel px-3 py-2 text-xs text-ink-60">
                <p className="font-semibold text-fg">Instrucciones Shopify</p>
                <p>1. Crear webhook Order creation con esta URL.</p>
                <p>2. Crear webhook Order update con esta misma URL.</p>
                <p>3. Para sincronizar un pedido viejo, agrega la etiqueta ADMA al pedido en Shopify y guarda.</p>
              </div>
            </div>
          )}
          <UchatConfigForm sellerId={seller.id} config={webhookConfig} />
        </div>
        <div>
          <p className="font-semibold">{stores.length > 0 ? `${stores.length} tienda${stores.length === 1 ? "" : "s"} conectada${stores.length === 1 ? "" : "s"}` : "Tiendas Shopify pendientes"}</p>
          <p className="mt-1 text-sm text-ink-60">Estado: {stores.length > 0 ? "con conexion activa" : shopify.status === "error" ? "requiere revision" : "requiere enlace privado"}</p>
          <p className="mt-2 text-xs text-ink-60">Scopes: {shopify.requiredScopes.join(", ")}</p>
        </div>
        {stores.length > 0 && (
          <div className="grid gap-2">
            {stores.map((store) => (
              <div key={store.id} className="rounded-2xl bg-field px-3 py-2 text-sm">
                <p className="font-semibold">{store.shopDomain}</p>
                <p className="text-xs text-ink-60">Conectada: {formatDateTime(store.connectedAt)}</p>
              </div>
            ))}
          </div>
        )}
        {requested.length > 0 && (
          <div className="grid gap-2">
            {requested.map((request) => (
              <div key={request.id} className="rounded-2xl bg-field px-3 py-2 text-sm">
                <p className="font-semibold">{request.shopDomain}</p>
                <p className="text-xs text-ink-60">
                  {request.status === "installed" ? "Instalada y conectada" : request.installLink ? "Enlace listo para instalar" : "Solicitud pendiente de enlace privado"}
                </p>
                {request.orderSkuContains && <p className="mt-1 text-xs font-semibold text-ink-60">Filtro: SKU contiene {request.orderSkuContains}</p>}
                {request.observation && <p className="mt-1 text-xs text-ink-60">Observacion: {request.observation}</p>}
                {request.status === "installed" ? (
                  <span className="mt-2 inline-flex min-h-9 items-center justify-center rounded-2xl bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
                    Instalada
                  </span>
                ) : request.installLink ? (
                  <a className="focus-ring mt-2 inline-flex min-h-9 items-center justify-center rounded-full bg-acid px-3 py-2 text-xs font-semibold text-deep" href={request.installLink} target="_blank" rel="noreferrer">
                    Instalar app
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Solicitar conexion Shopify
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg"
            placeholder="mitienda.myshopify.com"
            value={shop}
            onChange={(event) => setShop(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Sincronizar solo si el SKU contiene (opcional)
          <input
            className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal uppercase text-fg"
            placeholder="Ej. ADMA"
            value={orderSkuContains}
            onChange={(event) => setOrderSkuContains(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Observacion (opcional)
          <textarea
            className="focus-ring min-h-20 rounded-2xl border border-white/10 px-3 py-2 text-sm font-normal text-fg"
            placeholder="Condiciones especiales para esta conexion"
            value={observation}
            onChange={(event) => setObservation(event.target.value)}
          />
        </label>
        {normalizedShop && <p className="rounded-2xl bg-field px-3 py-2 text-xs text-ink-60">{alreadyConnected ? "Esta tienda ya esta conectada." : existingRequest?.installLink ? "El enlace privado ya esta disponible arriba." : existingRequest ? "Ya existe una solicitud pendiente para esta tienda." : `Se solicitara enlace para: ${normalizedShop}`}</p>}
        {message && <p className="rounded-2xl bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">{message}</p>}
        <button
          className={`focus-ring inline-flex min-h-10 items-center justify-center rounded-full px-3 py-2 text-sm font-semibold ${canRequest ? "bg-acid text-deep" : "bg-field text-ink-60"}`}
          type="button"
          disabled={!canRequest}
          onClick={() => void requestInstallLink()}
        >
          Solicitar enlace privado
        </button>
      </div>
    </Card>
  );
}

/**
 * La vista de admin apilaba TRECE paneles en una columna lateral: Shopify, webhooks, UChat,
 * importacion, incidencias, solicitudes, puntos de recogida, lideres, zonas, wallets, usuarios...
 * Todo junto con la operacion del dia. Se reparte en destinos como ya se hizo en tienda: cada
 * pantalla responde a UNA pregunta.
 */
const ADMIN_VIEW_TITLES: Partial<Record<AppView, { title: string; hint: string }>> = {
  operations: { title: "Operacion", hint: "Pedidos del dia y alertas" },
  integrations: { title: "Integraciones", hint: "Shopify, webhooks, UChat e incidencias" },
  settings: { title: "Ajustes", hint: "Zonas, tarifas, recogidas, lideres y usuarios" }
};

const SELLER_VIEW_TITLES: Partial<Record<AppView, { title: string; hint: string }>> = {
  operations: { title: "Pedidos", hint: "Operacion del dia" },
  integrations: { title: "Integraciones", hint: "Shopify, API y sincronizacion" },
  inventory: { title: "Inventario", hint: "Existencias y reservas" }
};

function SellerView({ state, setState, session, orderSearch, onOrderSearchChange, startDate, endDate, statusFilter, historyStart, searchingHistory, view, onStartDate, onEndDate, onStatusFilter, onSelectRange, periodStats = null, periodStatsError = null, hideFinance = false }: { state: AppState; setState: (state: AppState) => void; session: Session; orderSearch: string; onOrderSearchChange: (value: string) => void; startDate: string; endDate: string; statusFilter: string; historyStart?: string; searchingHistory?: boolean; view: AppView; onStartDate: (value: string) => void; onEndDate: (value: string) => void; onStatusFilter: (value: string) => void; onSelectRange: (startDate: string, endDate: string) => void; periodStats?: OrderPeriodStats | null; periodStatsError?: string | null; hideFinance?: boolean }) {
  const seller = state.sellers.find((item) => item.id === session.profileId);
  const [sellerOrderTab, setSellerOrderTab] = useState<"operation" | "failed">("operation");
  const [sellerFailedCategoryFilter, setSellerFailedCategoryFilter] = useState<FailedCategoryFilter>("all");
  const [printingSellerLabels, setPrintingSellerLabels] = useState(false);
  const sellerId = seller?.id ?? "";
  // Los derivados van ANTES del early return: los hooks no pueden ejecutarse condicionalmente.
  // Una sola pasada sobre los pedidos de la tienda en vez de ocho recorridos por render.
  const {
    orders,
    rangeOrders,
    failedOrders,
    operationOrders,
    visibleOperationOrders,
    visibleFailedBaseOrders,
    callRescheduled,
    deliveryScheduled,
    sellerLabelOrders,
    pendingSellerLabelOrders
  } = useMemo(() => {
    const sellerOrders: Order[] = [];
    const inRange: Order[] = [];
    const failedAll: Order[] = [];
    const operationAll: Order[] = [];
    const rescheduled: Order[] = [];
    const scheduled: Order[] = [];
    const labelOrders: Order[] = [];
    const pendingLabelOrders: Order[] = [];

    for (const order of state.orders) {
      if (order.sellerId !== sellerId) continue;
      sellerOrders.push(order);
      const date = orderDateValue(order);
      if ((!startDate || !date || date >= startDate) && (!endDate || !date || date <= endDate)) inRange.push(order);
      if (order.status === "failed") failedAll.push(order);
      else operationAll.push(order);
      if (order.callOutcome === "rescheduled") rescheduled.push(order);
      if (order.status === "scheduled") scheduled.push(order);
      if (canPrintSellerLabel(order, sellerId)) {
        labelOrders.push(order);
        if (!order.labelPrintedAt) pendingLabelOrders.push(order);
      }
    }
    inRange.sort(compareOrdersByCreatedAtDesc);

    return {
      orders: sellerOrders,
      rangeOrders: inRange,
      failedOrders: failedAll,
      operationOrders: operationAll,
      visibleOperationOrders: filterOrdersByRangeStatus(operationAll, startDate, endDate, statusFilter, orderSearch),
      visibleFailedBaseOrders: filterOrdersByRangeStatus(failedAll, startDate, endDate, statusFilter, orderSearch),
      callRescheduled: rescheduled,
      deliveryScheduled: scheduled,
      sellerLabelOrders: labelOrders,
      pendingSellerLabelOrders: pendingLabelOrders
    };
  }, [state.orders, sellerId, startDate, endDate, statusFilter, orderSearch]);

  const shopifyStores = useMemo(() => (state.shopifyStores ?? []).filter((store) => store.sellerId === sellerId), [state.shopifyStores, sellerId]);
  const shopifyInstallRequests = useMemo(() => (state.shopifyInstallRequests ?? []).filter((request) => request.sellerId === sellerId), [state.shopifyInstallRequests, sellerId]);
  const visibleOrders = useMemo(
    () => (sellerOrderTab === "failed" ? filterByFailedCategory(visibleFailedBaseOrders, sellerFailedCategoryFilter) : visibleOperationOrders),
    [sellerOrderTab, sellerFailedCategoryFilter, visibleFailedBaseOrders, visibleOperationOrders]
  );
  // Mismo calculo que el panel del embudo: una sola fuente, para que la franja y el panel no
  // puedan desincronizarse.
  //
  // OJO: va aqui arriba, con el resto de derivados, y NO junto a su uso mas abajo. Debajo del
  // `if (!seller)` este hook solo se ejecutaria en los renders con tienda cargada: el primer
  // render de una sesion fria sale por el early return y el segundo ya ejecuta un hook mas, que
  // es el React #310 que tumbaba la app entera en moviles sin cache.
  const localKpis = useMemo(() => computeLogisticsKpis(rangeOrders, state), [rangeOrders, state]);
  // Mismas cuatro cifras, pero del periodo completo cuando el rango se sale de lo descargado.
  const sellerKpis = periodStats ?? localKpis;

  if (!seller) {
    return (
      <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5">
        <EmptyRoleState title={hideFinance ? "Perfil de tienda pendiente" : "Perfil de vendedor pendiente"} message="Tu cuenta existe, pero falta vincularla a una tienda. Un administrador debe asignar tu usuario al sellerId correcto." />
      </main>
    );
  }
  const sellerExcelFilename = `pedidos-vendedor-${seller.id}-${startDate || "inicio"}-${endDate || "hoy"}.xlsx`;
  // Senales de "hay trabajo esperando": deciden que panel se abre solo. Un dia tranquilo y uno
  // con solicitudes abiertas o pedidos rechazados no deben verse igual.
  const pendingPayouts = state.payouts.filter((payout) => payout.sellerId === seller.id && payout.status === "requested").length;
  const pendingShopifyRequests = shopifyInstallRequests.filter((request) => request.status === "requested").length;
  const sellerSyncIssues = (state.shopifySyncIssues ?? []).filter((issue) => issue.sellerId === seller.id);
  return (
    <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5 md:px-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{SELLER_VIEW_TITLES[view]?.title ?? "Pedidos"}</h2>
        <p className="text-sm text-ink-60">{seller.name}{SELLER_VIEW_TITLES[view] ? ` · ${SELLER_VIEW_TITLES[view]!.hint}` : ""}</p>
      </div>

      {view === "operations" && (
        <>
          {/* Cifra heroe: lo primero que pregunta una tienda es cuanto le deben. Antes vivia
              dentro de una lista paginada, tres bloques mas abajo. */}
          <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
            {!hideFinance && (
              <div className="glass-acid flex min-w-[240px] flex-col justify-center rounded-3xl p-4">
                <p className="text-[12px] font-semibold opacity-70">Saldo pendiente por liquidar</p>
                <p className="tabular mt-0.5 text-[28px] font-extrabold leading-none">{formatCop(Math.max(0, sellerBalance(state, seller.id).ledgerCop))}</p>
                <p className="mt-1.5 text-[11px] leading-snug opacity-70">Lo pendiente de hoy, no el acumulado.</p>
              </div>
            )}
            {/* Los cuatro INDICADORES, no el reparto por estado: dicen como va la operacion, no
                cuantos hay en cada casilla. El reparto completo esta en el panel de abajo. */}
            <div className="grid grid-cols-2 divide-x divide-y divide-white/[0.06] overflow-hidden rounded-3xl border border-white/[0.06] bg-panel sm:grid-cols-4 sm:divide-y-0">
              <div className="p-3">
                <p className="text-[11px] leading-tight text-ink-60">Total pedidos</p>
                <p className="tabular text-xl font-bold">{sellerKpis.total}</p>
              </div>
              <div className="p-3">
                <p className="text-[11px] leading-tight text-ink-60">Abiertos despachables</p>
                <p className={`tabular text-xl font-bold ${sellerKpis.openDispatchable > 0 ? "text-info" : ""}`}>{sellerKpis.openDispatchable}</p>
              </div>
              <div className="p-3">
                <p className="text-[11px] leading-tight text-ink-60">% entrega</p>
                <p className="tabular text-xl font-bold text-mint">{sellerKpis.deliveryRate}%</p>
              </div>
              <div className="p-3">
                <p className="text-[11px] leading-tight text-ink-60">% terminacion</p>
                <p className="tabular text-xl font-bold">{sellerKpis.completionRate}%</p>
              </div>
            </div>
          </div>
          {/* Las 19 metricas del embudo siguen disponibles, dejan de ocupar media pantalla. */}
          <CollapsiblePanel
            title="Embudo operativo completo"
            summary="Reparto por estado, tasas de despacho y entrega"
            help="Las tarjetas del embudo son excluyentes y suman el total filtrado. Los indicadores de abajo son lecturas transversales del mismo rango, no se suman."
          >
            <LogisticsKpis orders={rangeOrders} state={state} hideFinance={hideFinance} periodStats={periodStats} showStrip={false} />
          </CollapsiblePanel>
        </>
      )}
      {view === "operations" && (
      <>
        <section className="grid content-start gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-bold">Pedidos del vendedor</h2>
            <div className="flex flex-wrap gap-2">
              <button
                className="focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 text-ink-60 hover:text-fg disabled:opacity-40"
                type="button"
                title={`Descargar reporte Excel (${visibleOrders.length})`}
                aria-label={`Descargar reporte Excel de ${visibleOrders.length} pedidos`}
                disabled={visibleOrders.length === 0}
                onClick={() => void downloadOrdersXlsx(visibleOrders, state, sellerExcelFilename)}
              >
                <FileDown size={17} />
              </button>
              <button
                className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-acid px-4 text-sm font-semibold text-deep disabled:opacity-40"
                type="button"
                disabled={pendingSellerLabelOrders.length === 0 || printingSellerLabels}
                onClick={async () => {
                  setPrintingSellerLabels(true);
                  try {
                    const printed = await printOrderLabels(pendingSellerLabelOrders, state, "Rotulos vendedor pendientes");
                    if (printed) setState(markOrdersLabelsPrinted(state, pendingSellerLabelOrders, seller.id));
                  } finally {
                    setPrintingSellerLabels(false);
                  }
                }}
              >
                <Printer size={16} />
                {printingSellerLabels ? "Generando..." : `Imprimir pendientes (${pendingSellerLabelOrders.length})`}
              </button>
            </div>
          </div>
          <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} searchingHistory={searchingHistory} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <button
                className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${sellerOrderTab === "operation" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
                type="button"
                onClick={() => setSellerOrderTab("operation")}
              >
                Operacion ({operationOrders.length})
              </button>
              <button
                className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${sellerOrderTab === "failed" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
                type="button"
                onClick={() => setSellerOrderTab("failed")}
              >
                Fallidos / reintento ({failedOrders.length})
              </button>
            </div>
          </div>
          <OrderFilters startDate={startDate} endDate={endDate} status={statusFilter} historyStart={historyStart} onStartDate={onStartDate} onEndDate={onEndDate} onStatus={onStatusFilter} onSelectRange={onSelectRange} />
          {sellerOrderTab === "failed" && (
            <FailedCategoryFilters orders={visibleFailedBaseOrders} value={sellerFailedCategoryFilter} onChange={setSellerFailedCategoryFilter} />
          )}
          {(callRescheduled.length > 0 || deliveryScheduled.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {callRescheduled.length > 0 && (
                <span className="rounded-2xl bg-rust/10 px-3 py-2 text-sm font-semibold text-rust">{callRescheduled.length} llamadas reprogramadas</span>
              )}
              {deliveryScheduled.length > 0 && (
                <span className="rounded-2xl bg-field px-3 py-2 text-sm font-semibold">{deliveryScheduled.length} entregas agendadas</span>
              )}
            </div>
          )}
          {/* Filas dentro de una sola tarjeta y separadas por filete, como la referencia: una
              lista se lee de un vistazo, veinte tarjetas sueltas no. */}
          <div className="rounded-3xl border border-white/[0.06] bg-panel p-1.5">
            <PaginatedList
              className="grid divide-y divide-white/[0.05]"
              items={visibleOrders}
              pageSize={10}
              empty={<div className="p-4"><EmptyRoleState title={sellerOrderTab === "failed" ? "Sin fallidos pendientes" : "Sin pedidos"} message={sellerOrderTab === "failed" ? "Los pedidos fallidos apareceran aqui para que confirmes si van a nuevo reintento." : "Cuando conectes Shopify, tus pedidos de la ciudad activa apareceran aqui."} /></div>}
            >
              {(order) => <OrderRow key={order.id} order={order} state={state} setState={setState} actorProfileId={session.profileId} />}
            </PaginatedList>
          </div>
        </section>
      {/* Los paneles secundarios bajan a una fila de tres: plegados son una linea cada uno,
          asi que no necesitan una columna propia y la lista gana todo el ancho. */}
      <div className="grid gap-3 lg:grid-cols-3">
          <CollapsiblePanel
            title="Crear pedido manual"
            summary="Para ventas fuera de Shopify"
            help="Registra un pedido que no entro por la tienda conectada. Queda igual que uno importado: se le asigna lider, mensajero y entra en la liquidacion."
          >
            <ManualOrderPanel state={state} setState={setState} lockedSellerId={seller.id} />
          </CollapsiblePanel>
          {!hideFinance && (
            <CollapsiblePanel
              title="Solicitudes de liquidacion"
              summary={pendingPayouts > 0 ? `${pendingPayouts} en curso` : "Sin solicitudes abiertas"}
              tone={pendingPayouts > 0 ? "acid" : "default"}
              defaultOpen={pendingPayouts > 0}
              help="Aqui pides que Kentro te transfiera el saldo pendiente. La solicitud se cierra cuando el corte se crea de verdad."
            >
              <WalletPanel state={state} />
            </CollapsiblePanel>
          )}
          {!hideFinance && (
            <CollapsiblePanel title="Movimientos recientes" summary="Referencia contable">
              <DashboardWalletCard state={state} ownerType="seller" ownerId={seller.id} title="Wallet del vendedor" pendingOnly />
            </CollapsiblePanel>
          )}
      </div>
      </>
      )}

      {/* Configuracion: se toca al montar la tienda y casi nunca mas. Estaba debajo de los
          pedidos que se consultan a diario. */}
      {view === "integrations" && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="grid content-start gap-3">
            <CollapsiblePanel
              title="Conexion con Shopify"
              summary={shopifyStores.length > 0 ? `${shopifyStores.length} tienda${shopifyStores.length === 1 ? "" : "s"} conectada${shopifyStores.length === 1 ? "" : "s"}` : "Sin conectar"}
              tone={shopifyStores.length > 0 ? "acid" : "rust"}
              defaultOpen={shopifyStores.length === 0 || pendingShopifyRequests > 0}
              help="Con la tienda conectada, cada pedido de Shopify entra solo a Kentro. Sin conexion hay que importarlos a mano."
            >
              <ShopifyConnectionPanel seller={seller} stores={shopifyStores} requests={shopifyInstallRequests} state={state} setState={setState} />
            </CollapsiblePanel>
            <CollapsiblePanel
              title="Clave de API"
              summary="Consulta de pedidos desde tus sistemas"
              help="Una clave de solo lectura para consultar tus pedidos y saldos desde fuera de Kentro."
            >
              <StoreApiKeyCard sellerId={seller.id} />
            </CollapsiblePanel>
          </div>
          <div className="grid content-start gap-3">
            <CollapsiblePanel
              title="Importar pedido"
              summary="Traer uno concreto de Shopify"
              help="Trae un pedido puntual que no haya entrado solo, buscandolo por su numero de Shopify."
            >
              <ShopifyImportOrderPanel
                stores={shopifyStores}
                sellers={[seller]}
                lockedSellerId={seller.id}
                onImported={(order) => setState({ ...state, orders: [order, ...state.orders.filter((item) => item.id !== order.id)] })}
              />
            </CollapsiblePanel>
            {/* Se oculta del todo cuando no hay incidencias: un panel vacio no informa, ocupa. */}
            <CollapsiblePanel
              title="Incidencias de sincronizacion"
              summary={`${sellerSyncIssues.length} pedido${sellerSyncIssues.length === 1 ? "" : "s"} rechazado${sellerSyncIssues.length === 1 ? "" : "s"}`}
              tone="rust"
              count={sellerSyncIssues.length}
              hideWhenEmpty
              defaultOpen
              help="Pedidos de Shopify que Kentro no pudo aceptar, casi siempre por estar fuera de cobertura."
            >
              <ShopifySyncIssuesPanel issues={sellerSyncIssues} sellers={[seller]} />
            </CollapsiblePanel>
          </div>
        </div>
      )}

      {view === "inventory" && <InventoryPanel state={state} seller={seller} />}
    </main>
  );
}

function InventoryPanel({ state, seller }: { state: AppState; seller: Seller }) {
  const sellerInventory = state.inventory.filter((item) => item.sellerId === seller.id);
  return (
    <Card>
      <h2 className="mb-3 font-bold">Inventario en bodega</h2>
      <PaginatedList items={sellerInventory} pageSize={8} empty={<p className="text-sm text-ink-60">No hay inventario en bodega registrado.</p>}>
        {(item) => (
          <div key={item.id} className="flex items-center justify-between rounded-2xl border border-white/10 p-3">
            <div>
              <p className="font-semibold">{item.name}</p>
              <p className="text-sm text-ink-60">{item.sku}</p>
              {item.location && <p className="text-xs text-ink-60">{item.location}</p>}
            </div>
            <p className={`text-right text-sm ${item.available - item.reserved <= (item.minStock ?? 0) ? "text-rust" : ""}`}>
              <b>{item.available - item.reserved}</b> libres<br />{item.reserved} res.
            </p>
          </div>
        )}
      </PaginatedList>
    </Card>
  );
}

const DRIVER_VIEW_TITLES: Partial<Record<AppView, { title: string; hint: string }>> = {
  operations: { title: "Operacion de la flota", hint: "Pedidos activos, reprogramados y fallidos." },
  dispatch: { title: "Despacho", hint: "Recogidas del dia y asignacion a mensajeros." },
  finance: { title: "Finanzas", hint: "Efectivo por entregar, cortes y abonos." },
  history: { title: "Historico", hint: "Pedidos cerrados y lectura de la flota." }
};

function DriverView({ state, setState, session, orderSearch, onOrderSearchChange, view, historyStart, onWidenHistory }: { state: AppState; setState: (state: AppState) => void; session: Session; orderSearch: string; onOrderSearchChange: (value: string) => void; view: AppView; historyStart?: string; onWidenHistory?: (startDate: string) => void }) {
  const driver = state.drivers.find((item) => item.id === session.profileId);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [operationTab, setOperationTab] = useState<"all" | "rescheduled" | "failed">("all");
  const [readySellerFilter, setReadySellerFilter] = useState("all");
  const [readyPickupFilter, setReadyPickupFilter] = useState("all");
  const [assignmentMessage, setAssignmentMessage] = useState("");
  const [repairingProfile, setRepairingProfile] = useState(false);
  const [repairMessage, setRepairMessage] = useState("");
  useEffect(() => {
    if (driver || !firebaseEnabled() || repairingProfile) return;
    setRepairingProfile(true);
    void repairFirebaseOwnDriverProfile()
      .then((result) => {
        setState({ ...state, drivers: [result.driver, ...state.drivers.filter((item) => item.id !== result.driver.id)] });
        setRepairMessage("Perfil de lider logistico reparado. Si no carga en unos segundos, recarga la pagina.");
      })
      .catch((error: unknown) => setRepairMessage(error instanceof Error ? error.message : "No se pudo reparar el perfil."))
      .finally(() => setRepairingProfile(false));
  }, [driver, repairingProfile, setState, state]);
  const driverId = driver?.id ?? "";
  // Doce recorridos completos de `state.orders` por render, en el rol que mas pedidos acumula
  // (3.265 hoy). Una sola pasada memoizada. Los hooks van antes del early return.
  const {
    assigned,
    pickupPending,
    unassignedReady,
    readyPickupOptions,
    pendingMessenger,
    messengerReassignable,
    rescheduledPending,
    failedOrders,
    callRescheduled,
    deliveryScheduled
  } = useMemo(() => {
    const reassignableStatuses = new Set(["picked_up", "call_pending", "scheduled", "in_route", "retry_pending"]);
    const active: Order[] = [];
    const pickup: Order[] = [];
    const ready: Order[] = [];
    const awaitingMessenger: Order[] = [];
    const reassignable: Order[] = [];
    const rescheduled: Order[] = [];
    const failedAll: Order[] = [];
    const withRescheduledCall: Order[] = [];
    const scheduled: Order[] = [];
    const pickupKeys = new Set<string>();

    for (const order of state.orders) {
      if (order.status === "ready_to_assign" && !order.driverId) {
        ready.push(order);
        pickupKeys.add(`${order.pickupPointName || "Punto de recogida"}|${order.pickupAddress || ""}`);
      }
      if (order.driverId === driverId && order.status === "failed") failedAll.push(order);
      if (!isDriverActiveOrder(order, driverId)) continue;
      active.push(order);
      if (order.status === "assigned") pickup.push(order);
      if (order.status === "picked_up" && !order.messengerId) awaitingMessenger.push(order);
      if (order.messengerId && reassignableStatuses.has(order.status)) reassignable.push(order);
      if (order.status === "retry_pending" || order.callOutcome === "rescheduled") rescheduled.push(order);
      if (order.callOutcome === "rescheduled") withRescheduledCall.push(order);
      if (order.status === "scheduled") scheduled.push(order);
    }

    return {
      assigned: active,
      pickupPending: pickup,
      unassignedReady: ready,
      // Lista corta (puntos de recogida): aqui localeCompare si vale la pena, ordena bien los acentos.
      readyPickupOptions: Array.from(pickupKeys).sort((left, right) => left.localeCompare(right)),
      pendingMessenger: awaitingMessenger,
      messengerReassignable: reassignable,
      rescheduledPending: rescheduled,
      failedOrders: failedAll,
      callRescheduled: withRescheduledCall,
      deliveryScheduled: scheduled
    };
  }, [state.orders, driverId]);

  const readySellerOptions = useMemo(() => {
    const sellerIds = new Set(unassignedReady.map((order) => order.sellerId));
    return state.sellers.filter((seller) => sellerIds.has(seller.id));
  }, [state.sellers, unassignedReady]);
  const visiblePickupPending = useMemo(() => pickupPending.filter((order) => orderSearchMatches(order, orderSearch)), [pickupPending, orderSearch]);
  const visibleUnassignedReady = useMemo(() => unassignedReady.filter((order) => {
    const pickupKey = `${order.pickupPointName || "Punto de recogida"}|${order.pickupAddress || ""}`;
    return orderSearchMatches(order, orderSearch)
      && (readySellerFilter === "all" || order.sellerId === readySellerFilter)
      && (readyPickupFilter === "all" || pickupKey === readyPickupFilter);
  }), [unassignedReady, orderSearch, readySellerFilter, readyPickupFilter]);
  const operationOrders = operationTab === "failed" ? failedOrders : operationTab === "rescheduled" ? rescheduledPending : assigned;
  const visibleAssigned = useMemo(() => operationOrders.filter((order) => orderSearchMatches(order, orderSearch)), [operationOrders, orderSearch]);
  const visibleFailedOrders = useMemo(() => failedOrders.filter((order) => orderSearchMatches(order, orderSearch)), [failedOrders, orderSearch]);
  const messengers = useMemo(() => state.messengers.filter((messenger) => messenger.leaderDriverId === driverId && messenger.active), [state.messengers, driverId]);
  const rate = useMemo(() => weeklyFailedRate(state, driverId), [state, driverId]);
  const financialSummary = useMemo(() => calculateDriverFinancialSummary(state, driverId), [state, driverId]);

  if (!driver) {
    return (
      <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-5 md:px-6">
        <EmptyRoleState title="Perfil de lider logistico pendiente" message={repairingProfile ? "Estamos reparando la asociacion de tu usuario con el perfil logistico." : repairMessage || "Tu cuenta existe, pero falta asociarla al perfil de lider logistico."} />
      </main>
    );
  }

  const commitPickup = async (orders: Order[]) => {
    if (firebaseEnabled()) {
      const result = await createFirebasePickupBatch({ orderIds: orders.map((order) => order.id) });
      const pickedIds = new Set(result.pickupBatch.orderIds);
      const now = new Date().toISOString();
      setState({
        ...state,
        pickupBatches: [result.pickupBatch, ...state.pickupBatches.filter((batch) => batch.id !== result.pickupBatch.id)],
        orders: state.orders.map((order) =>
          pickedIds.has(order.id)
            ? { ...order, driverId: driver.id, pickupBatchId: result.pickupBatch.id, status: "picked_up", pickedUpAt: now, updatedAt: now }
            : order
        )
      });
    } else {
      const now = new Date().toISOString();
      const selectedIds = new Set(orders.map((order) => order.id));
      const batchId = `pb-${Date.now()}`;
      const nextOrders = state.orders.map((order) =>
        selectedIds.has(order.id)
          ? { ...order, driverId: driver.id, pickupBatchId: batchId, pickedUpAt: now, status: "picked_up" as const, updatedAt: now }
          : order
      );
      const updatedOrders = nextOrders.filter((order) => selectedIds.has(order.id));
      setState({
        ...state,
        pickupBatches: [{
          id: batchId,
          driverId: driver.id,
          pickupPointKey: "local",
          pickupPointName: orders[0]?.pickupPointName ?? "Punto de recogida",
          pickupAddress: orders[0]?.pickupAddress ?? "",
          orderIds: orders.map((order) => order.id),
          status: "closed",
          createdAt: now,
          updatedAt: now,
          closedAt: now
        }, ...state.pickupBatches],
        orders: nextOrders
      });
      void Promise.all(updatedOrders.map((order) => saveFirestoreOrder(order)));
    }
    setPickupOpen(false);
  };

  return (
    <main className="mx-auto grid max-w-6xl gap-5 px-4 py-5">
      {pickupOpen && <PickupScanModal state={state} driver={driver} onClose={() => setPickupOpen(false)} onCommit={commitPickup} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold">{DRIVER_VIEW_TITLES[view]?.title ?? "Operacion de la flota"}</h2>
          <p className="text-sm text-ink-60">{DRIVER_VIEW_TITLES[view]?.hint ?? `${driver.name} · ${remoteEnabledLabel(financialSummary.pendingBalanceCop)}`}</p>
        </div>
        <button
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep"
          type="button"
          onClick={() => setPickupOpen(true)}
        >
          <QrCode size={16} />
          Recoger con scanner
        </button>
      </div>
      {/* Franja de indicadores: una sola superficie con separadores en vez de tres tarjetas
          sueltas, y el saldo pendiente como cifra heroe en acido. Solo en Operacion: es el
          resumen del dia, no un encabezado que repetir en las cuatro pantallas. */}
      {view === "operations" && (
      <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
        <div className="grid divide-y divide-white/[0.06] rounded-3xl border border-white/[0.06] bg-panel sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="flex items-center gap-3 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5 text-acid"><Bike size={18} /></span>
            <div className="min-w-0">
              <p className="text-[13px] text-ink-60">Lider logistico</p>
              <p className="truncate text-lg font-bold">{driver.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5 text-acid"><Route size={18} /></span>
            <div className="min-w-0">
              <p className="text-[13px] text-ink-60">Pedidos flota</p>
              <p className="tabular text-lg font-bold">{assigned.length}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5 ${rate.rate > 15 ? "text-rust" : "text-acid"}`}><AlertTriangle size={18} /></span>
            <div className="min-w-0">
              <p className="text-[13px] text-ink-60">Fallidos semana</p>
              <p className={`tabular text-lg font-bold ${rate.rate > 15 ? "text-rust" : ""}`}>{rate.rate}%</p>
            </div>
          </div>
        </div>
        <div className="glass-acid flex min-w-[240px] flex-col justify-center rounded-3xl p-5">
          <p className="text-[13px] font-semibold opacity-70">Pendiente por entregar</p>
          <p className="tabular mt-1 text-3xl font-extrabold leading-none">{formatCop(financialSummary.pendingBalanceCop)}</p>
        </div>
      </div>
      )}
      {view === "finance" && (
      <section id="finanzas" className="scroll-mt-32 grid gap-3">
        <SectionHeader title="Resumen financiero" description="Saldo total abierto, abonos y cortes del domiciliario." />
        <DriverFinancialSummaryPanel summary={financialSummary} />
        <DashboardWalletCard state={state} ownerType="driver" ownerId={driver.id} title="Wallet del lider logistico" collapsible />
      </section>
      )}
      {view === "operations" && (
      <section id="operacion" className="scroll-mt-32 grid gap-3">
        <SectionHeader title="Operacion de la flota" description="Pedidos activos, reprogramados y fallidos para seguimiento diario." />
        <EvidenceQueuePanel state={state} setState={setState} />
        <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <button
              className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${operationTab === "all" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
              type="button"
              onClick={() => setOperationTab("all")}
            >
              Todos ({assigned.length})
            </button>
            <button
              className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${operationTab === "rescheduled" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
              type="button"
              onClick={() => setOperationTab("rescheduled")}
            >
              Reprogramados pendientes ({rescheduledPending.length})
            </button>
            <button
              className={`focus-ring rounded-full px-3 py-2 text-sm font-semibold ${operationTab === "failed" ? "bg-acid text-deep" : "border border-white/10 bg-panel text-fg"}`}
              type="button"
              onClick={() => setOperationTab("failed")}
            >
              Fallidos / reintento ({failedOrders.length})
            </button>
          </div>
          <button
            className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold text-fg disabled:opacity-50"
            type="button"
            disabled={visibleFailedOrders.length === 0}
            onClick={() => void downloadOrdersXlsx(visibleFailedOrders, state, `fallidos-flota-${driver.id}-${new Date().toISOString().slice(0, 10)}.xlsx`)}
          >
            <FileDown size={16} />
            Descargar fallidos ({visibleFailedOrders.length})
          </button>
        </div>
        {/* El tab de fallidos ya no es el historico completo: sale de la ventana descargada. Los
            otros dos tabs son pedidos en curso, que siempre estan completos. */}
        {operationTab === "failed" && historyStart && (
          <p className="text-xs text-ink-60">Fallidos desde el {historyStart}. El historico completo esta en la pestana Historico.</p>
        )}
        {(callRescheduled.length > 0 || deliveryScheduled.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {callRescheduled.length > 0 && (
              <span className="rounded-2xl bg-rust/10 px-3 py-2 text-sm font-semibold text-rust">{callRescheduled.length} llamadas reprogramadas</span>
            )}
            {deliveryScheduled.length > 0 && (
              <span className="rounded-2xl bg-field px-3 py-2 text-sm font-semibold">{deliveryScheduled.length} entregas agendadas</span>
            )}
          </div>
        )}
        <PaginatedList
          items={visibleAssigned}
          pageSize={8}
          empty={<Card><p className="text-sm text-ink-60">{operationTab === "failed" ? "No hay fallidos para exportar." : operationTab === "rescheduled" ? "No hay reprogramados pendientes." : "No tienes pedidos asignados."}</p></Card>}
        >
          {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />}
        </PaginatedList>
      </section>
      )}
      {view === "dispatch" && (
      <>
      <section id="recogidas" className="scroll-mt-32 grid gap-3">
        <SectionHeader title="Recogidas" description="Pedidos por recoger y pedidos listos para tomar por scanner." />
        <OrderGroupHeader
          title="Pendientes de recogida"
          orders={visiblePickupPending}
          sellers={state.sellers}
          emptyHint="No tienes pedidos asignados para recoger."
        />
        <PaginatedList items={visiblePickupPending} pageSize={8} empty={null}>
          {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />}
        </PaginatedList>
      </section>
      <section className="grid gap-3">
        <OrderGroupHeader
          title="Listos sin lider"
          orders={visibleUnassignedReady}
          sellers={state.sellers}
          emptyHint="No hay pedidos confirmados sin lider."
          helper="Se pueden tomar con scanner o digitando el KNT."
        />
        <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Tienda
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={readySellerFilter} onChange={(event) => setReadySellerFilter(event.target.value)}>
              <option value="all">Todas las tiendas</option>
              {readySellerOptions.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-ink-60">
            Punto de recogida
            <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={readyPickupFilter} onChange={(event) => setReadyPickupFilter(event.target.value)}>
              <option value="all">Todos los puntos</option>
              {readyPickupOptions.map((key) => {
                const [name, address] = key.split("|");
                return <option key={key} value={key}>{[name, address].filter(Boolean).join(" - ")}</option>;
              })}
            </select>
          </label>
        </div>
        <PaginatedList items={visibleUnassignedReady} pageSize={8} empty={<Card><p className="text-sm text-ink-60">No hay pedidos listos sin lider.</p></Card>}>
          {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />}
        </PaginatedList>
      </section>
      <section id="mensajeros" className="scroll-mt-32 grid content-start gap-3">
        <SectionHeader title="Mensajeros" description="Creacion, accesos y asignacion de pedidos recogidos." />
        <FleetMessengerPanel state={state} setState={setState} driver={driver} />
        <AssignPickedUpOrdersPanel
          orders={pendingMessenger}
          messengers={messengers}
          onAssigned={(orders) => {
            setState({ ...state, orders: state.orders.map((item) => orders.find((order) => order.id === item.id) ?? item) });
            setAssignmentMessage(`${orders.length} pedido(s) asignados a mensajero.`);
          }}
        />
        <ReassignMessengerOrdersPanel
          orders={messengerReassignable}
          messengers={messengers}
          onUpdated={(orders, summary) => {
            setState({ ...state, orders: state.orders.map((item) => orders.find((order) => order.id === item.id) ?? item) });
            setAssignmentMessage(summary);
          }}
        />
        {assignmentMessage && <p className="rounded-2xl bg-field px-3 py-2 text-sm font-semibold text-ink-70">{assignmentMessage}</p>}
      </section>
      </>
      )}
      {view === "history" && (
      <section id="historico" className="scroll-mt-32 grid content-start gap-3">
        <SectionHeader title="Historico" description="Fuente de verdad de pedidos entregados y fallidos." />
        <DriverHistoryPanel state={state} driver={driver} historyStart={historyStart} onWidenHistory={onWidenHistory} />
      </section>
      )}
      {view === "history" && (
      <section id="reportes" className="scroll-mt-32 grid gap-3">
        <SectionHeader title="Reportes" description="Lectura compacta de la flota y los mensajeros." />
        <FleetReportsPanel state={state} driver={driver} financialSummary={financialSummary} historyStart={historyStart} />
      </section>
      )}
    </main>
  );
}

function remoteEnabledLabel(pendingBalanceCop: number) {
  return pendingBalanceCop > 0 ? "saldo pendiente activo" : "sin saldo pendiente";
}

function OrderGroupHeader({ title, orders, sellers, emptyHint, helper }: { title: string; orders: Order[]; sellers: Seller[]; emptyHint: string; helper?: string }) {
  const sellerCounts = orders.reduce<Array<{ sellerId: string; name: string; count: number }>>((acc, order) => {
    const seller = sellers.find((item) => item.id === order.sellerId);
    const name = seller?.name ?? order.pickupPointName ?? knownSellerName(order.sellerId);
    const existing = acc.find((item) => item.sellerId === order.sellerId);
    if (existing) existing.count += 1;
    else acc.push({ sellerId: order.sellerId, name, count: 1 });
    return acc;
  }, []);

  return (
    <div className="grid gap-2 rounded-2xl bg-field px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{title}</h2>
        <span className="rounded bg-panel px-2 py-1 text-xs font-semibold">{orders.length} pedido{orders.length === 1 ? "" : "s"}</span>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-ink-60">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {sellerCounts.map((seller) => (
            <span key={seller.sellerId} className="rounded bg-panel px-2 py-1 text-xs font-semibold text-ink-70">
              {seller.name}: {seller.count}
            </span>
          ))}
        </div>
      )}
      {helper && <p className="text-xs text-ink-60">{helper}</p>}
    </div>
  );
}

function AdminOperationalSummary({
  title,
  orders,
  sellers,
  icon,
  empty,
  helper,
  actionLabel,
  actionIcon,
  onAction
}: {
  title: string;
  orders: Order[];
  sellers: Seller[];
  icon: React.ReactNode;
  empty: string;
  helper?: string;
  actionLabel?: string;
  /** El boton no siempre imprime: tambien exporta. Por defecto queda la impresora. */
  actionIcon?: React.ReactNode;
  onAction?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const sellerCounts = orders.reduce<Array<{ sellerId: string; name: string; count: number }>>((acc, order) => {
    const seller = sellers.find((item) => item.id === order.sellerId);
    const name = seller?.name ?? order.pickupPointName ?? knownSellerName(order.sellerId);
    const existing = acc.find((item) => item.sellerId === order.sellerId);
    if (existing) existing.count += 1;
    else acc.push({ sellerId: order.sellerId, name, count: 1 });
    return acc;
  }, []);

  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-2xl bg-field p-2 text-fg">{icon}</span>
          <div>
            <h2 className="font-bold">{title}</h2>
            {helper && <p className="text-xs text-ink-60">{helper}</p>}
          </div>
        </div>
        <span className="rounded bg-field px-2 py-1 text-xs font-semibold text-fg">{orders.length} pedido{orders.length === 1 ? "" : "s"}</span>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-ink-60">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {sellerCounts.map((seller) => (
            <span key={seller.sellerId} className="rounded bg-field px-2 py-1 text-xs font-semibold text-ink-70">
              {seller.name}: {seller.count}
            </span>
          ))}
        </div>
      )}
      {actionLabel && onAction && (
        <button
          className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold disabled:opacity-50"
          type="button"
          disabled={orders.length === 0 || busy}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onAction()).finally(() => setBusy(false));
          }}
        >
          {actionIcon ?? <Printer size={16} />}
          {busy ? "Procesando..." : actionLabel}
        </button>
      )}
    </Card>
  );
}

function knownSellerName(sellerId: string) {
  const known: Record<string, string> = {
    "seller-1779315416119": "Danda"
  };
  return known[sellerId] ?? sellerId;
}

function FleetMessengerPanel({ state, setState, driver }: { state: AppState; setState: (state: AppState) => void; driver: Driver }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const messengers = state.messengers.filter((messenger) => messenger.leaderDriverId === driver.id);

  async function createMessenger() {
    if (!name.trim() || !email.trim() || password.length < 6) return;
    setBusy(true);
    setMessage("");
    try {
      const now = new Date().toISOString();
      let messenger: Messenger;
      if (firebaseEnabled()) {
        const result = await createFirebaseMessengerProfile({ name, phone, email, password, leaderDriverId: driver.id });
        messenger = result.messenger;
      } else {
        messenger = { id: `messenger-${Date.now()}`, leaderDriverId: driver.id, name: name.trim(), phone: phone.trim(), email: email.trim(), active: true, createdAt: now, updatedAt: now };
      }
      setState({ ...state, messengers: [messenger, ...state.messengers.filter((item) => item.id !== messenger.id)] });
      setName("");
      setPhone("");
      setEmail("");
      setPassword("");
      setMessage(`Mensajero creado. Puede entrar con ${messenger.email ?? email.trim()} en kentro.com.co.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el mensajero.");
    } finally {
      setBusy(false);
    }
  }

  async function createAccessForMessenger(messenger: Messenger) {
    const nextEmail = window.prompt(`Correo de acceso para ${messenger.name}`, messenger.email ?? "");
    if (!nextEmail) return;
    const nextPassword = window.prompt("Contrasena temporal, minimo 6 caracteres");
    if (!nextPassword || nextPassword.length < 6) {
      setMessage("La contrasena debe tener minimo 6 caracteres.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await createFirebaseMessengerProfile({
        messengerId: messenger.id,
        name: messenger.name,
        phone: messenger.phone,
        email: nextEmail,
        password: nextPassword,
        leaderDriverId: driver.id
      });
      setState({ ...state, messengers: state.messengers.map((item) => (item.id === messenger.id ? result.messenger : item)) });
      setMessage(`${messenger.name} ya puede entrar con ${nextEmail.trim().toLowerCase()} en kentro.com.co.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el acceso del mensajero.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="grid gap-3">
      <div>
        <h2 className="font-bold">Mensajeros de la flota</h2>
        <p className="text-sm text-ink-60">El lider reparte pedidos recogidos entre estos mensajeros. La wallet sigue a nombre del lider.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Nombre mensajero" value={name} onChange={(event) => setName(event.target.value)} />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Telefono" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Correo de acceso" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm" placeholder="Contrasena temporal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed sm:col-span-2" type="button" disabled={busy || !name.trim() || !email.trim() || password.length < 6} onClick={() => void createMessenger()}>
          Crear
        </button>
      </div>
      {message && <p className="rounded-2xl bg-field px-3 py-2 text-xs font-semibold text-ink-70">{message}</p>}
      <div className="grid gap-2 md:grid-cols-3">
        {messengers.map((messenger) => (
          <div key={messenger.id} className="rounded-2xl border border-white/10 p-3 text-sm">
            <p className="font-semibold">{messenger.name}</p>
            <p className="text-ink-60">{messenger.phone || "Sin telefono"}</p>
            <p className="text-xs text-ink-60">{messenger.email ? `Acceso: ${messenger.email}` : "Sin acceso de login"}</p>
            {!messenger.email && (
              <button className="focus-ring mt-2 rounded-full border border-white/10 px-3 py-2 text-xs font-semibold disabled:opacity-50" type="button" disabled={busy} onClick={() => void createAccessForMessenger(messenger)}>
                Crear acceso
              </button>
            )}
          </div>
        ))}
        {messengers.length === 0 && <p className="text-sm text-ink-60">Aun no hay mensajeros para esta flota.</p>}
      </div>
    </Card>
  );
}

const driverSettlementExportColumns = [
  "corte", "guia", "shopify", "estado_pedido", "cod_recaudado", "pago_domiciliario", "efectivo_esperado", "estado_corte"
] as const;

function buildDriverSettlementExportRows(summary: DriverFinancialSummary) {
  const rows: Record<string, string | number>[] = [];
  for (const settlement of summary.settlementRows) {
    for (const order of settlement.orders) {
      rows.push({
        corte: settlement.label,
        guia: order.trackingCode,
        shopify: order.shopifyOrderId,
        estado_pedido: order.status ? statusLabel(order.status) : "",
        cod_recaudado: order.totalCop,
        pago_domiciliario: order.driverPayCop,
        efectivo_esperado: order.expectedCashCop,
        estado_corte: settlementStatusLabel(settlement.status)
      });
    }
  }
  return rows;
}

function DriverFinancialSummaryPanel({ summary }: { summary: DriverFinancialSummary }) {
  const [unsettledOpen, setUnsettledOpen] = useState(false);
  const [expandedSettlement, setExpandedSettlement] = useState<string | null>(null);
  const unsettledPage = usePaginatedItems(summary.unsettledOrders, 8);
  // Antes se pintaban los 24 cortes y los 71 abonos enteros: 95 filas de golpe en un telefono.
  const settlementPage = usePaginatedItems(summary.settlementRows, 6);
  const receiptPage = usePaginatedItems(summary.receiptRows, 6);
  const settlementExportRows = buildDriverSettlementExportRows(summary);

  return (
    <Card className="grid gap-5 p-5">
      <div className="grid gap-4 md:grid-cols-4">
        <StatTile icon={<Wallet size={16} />} label="Dinero entregado" value={formatCop(summary.receivedCop)} tone="mint" />
        <StatTile icon={<AlertTriangle size={16} />} label="Cortes incompletos" value={formatCop(summary.incompleteSettlementsCop)} tone={summary.incompleteSettlementsCop > 0 ? "rust" : "default"} />
        <StatTile icon={<PackageCheck size={16} />} label="Pendiente sin cortar" value={formatCop(summary.unsettledCashCop)} tone={summary.unsettledCashCop > 0 ? "rust" : "default"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Lista de tarjetas, no tabla: seis columnas no caben en un telefono, y la tabla
            obligaba a desplazarse en horizontal para leer el pendiente, que es lo que importa. */}
        <div className="rounded-2xl border border-white/10">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h3 className="text-sm font-bold">Cortes</h3>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-ink-60">{summary.settlementRows.length} corte{summary.settlementRows.length === 1 ? "" : "s"}</span>
              <button
                className="focus-ring inline-flex min-h-8 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-2.5 py-1.5 text-xs font-semibold text-fg disabled:opacity-50"
                type="button"
                disabled={settlementExportRows.length === 0}
                onClick={() => void downloadRowsXlsx("Cortes", driverSettlementExportColumns, settlementExportRows, `cortes-domiciliario-${new Date().toISOString().slice(0, 10)}.xlsx`)}
              >
                <FileDown size={14} />
                Excel
              </button>
            </div>
          </div>
          <div className="grid gap-2 px-3 pb-3">
            {settlementPage.visibleItems.length === 0 && (
              <p className="px-1 py-2 text-sm text-ink-60">Todavia no hay cortes para este domiciliario.</p>
            )}
            {settlementPage.visibleItems.map((row) => {
              const isOpen = expandedSettlement === row.settlementId;
              return (
                <div key={row.settlementId} className="rounded-2xl border border-white/[0.06] bg-field/50">
                  <button
                    className="focus-ring grid w-full gap-2 rounded-2xl p-3 text-left"
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setExpandedSettlement((current) => (current === row.settlementId ? null : row.settlementId))}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{row.label}</p>
                        <p className="text-xs text-ink-60">{row.orderCount} ordenes · {settlementStatusLabel(row.status)}</p>
                      </div>
                      <ChevronRight className={`shrink-0 text-ink-60 transition-transform ${isOpen ? "rotate-90" : ""}`} size={16} />
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                      <span className="text-ink-60">Esperado <span className="tabular font-semibold text-fg">{formatCop(row.expectedCashCop)}</span></span>
                      <span className="text-ink-60">Recibido <span className="tabular font-semibold text-fg">{formatCop(row.receivedCop)}</span></span>
                      <span className={`tabular font-bold ${row.pendingCop > 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.pendingCop)} pendiente</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="grid gap-1.5 border-t border-white/[0.06] px-3 py-2.5">
                      {row.orders.length === 0 ? (
                        <p className="text-xs text-ink-60">Sin pedidos asociados a este corte.</p>
                      ) : (
                        row.orders.map((order) => (
                          <div key={order.orderId} className="flex items-center justify-between gap-3 text-xs">
                            <span className="min-w-0 truncate font-semibold">{order.trackingCode}</span>
                            <span className="tabular shrink-0 text-ink-60">{formatCop(order.expectedCashCop)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <PaginationControls page={settlementPage.page} totalPages={settlementPage.totalPages} totalItems={summary.settlementRows.length} onPageChange={settlementPage.setPage} />
          </div>
        </div>

        {/* La nota del abono es la informacion mas util y era la columna que se cortaba. Aqui va
            a linea completa, y el valor manda visualmente sobre la fecha y el corte. */}
        <div className="rounded-2xl border border-white/10">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <h3 className="text-sm font-bold">Abonos</h3>
            <span className="text-xs font-semibold text-ink-60">{summary.receiptRows.length} abono{summary.receiptRows.length === 1 ? "" : "s"}</span>
          </div>
          <div className="grid gap-2 px-3 pb-3">
            {receiptPage.visibleItems.length === 0 && (
              <p className="px-1 py-2 text-sm text-ink-60">No hay abonos registrados.</p>
            )}
            {receiptPage.visibleItems.map((row) => (
              <div key={row.id} className="grid gap-1 rounded-2xl border border-white/[0.06] bg-field/50 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="tabular text-base font-bold text-mint">{formatCop(row.amountCop)}</span>
                  <span className="shrink-0 text-xs text-ink-60">{new Date(row.receivedAt).toLocaleDateString("es-CO")}</span>
                </div>
                <p className="text-xs leading-relaxed text-ink-70">{row.note || (row.synthetic ? "Registro historico sin detalle" : "Sin nota")}</p>
                <p className="text-[11px] text-ink-60">Corte {row.settlementLabel}</p>
              </div>
            ))}
            <PaginationControls page={receiptPage.page} totalPages={receiptPage.totalPages} totalItems={summary.receiptRows.length} onPageChange={receiptPage.setPage} />
          </div>
        </div>
      </div>

      {summary.unsettledOrders.length > 0 && (
        <div className="rounded-2xl border border-white/10">
          <button
            className="focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-field"
            type="button"
            onClick={() => setUnsettledOpen((current) => !current)}
          >
            <span>
              <span className="block text-sm font-bold">Pedidos COD entregados sin corte</span>
              <span className="block text-xs font-semibold text-ink-60">{summary.unsettledOrders.length} pedido{summary.unsettledOrders.length === 1 ? "" : "s"} · <span className="tabular">{formatCop(summary.unsettledCashCop)}</span></span>
            </span>
            <span className="rounded-2xl border border-white/10 bg-panel px-2 py-1 text-xs font-semibold text-ink-60">{unsettledOpen ? "Ocultar" : "Ver listado"}</span>
          </button>
          {unsettledOpen && (
            <div className="grid gap-2 border-t border-white/10 p-3">
              {unsettledPage.visibleItems.map((row) => (
                <div key={row.orderId} className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-field/50 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{row.trackingCode || row.shopifyOrderId}</p>
                    <p className="text-[11px] text-ink-60">COD <span className="tabular">{formatCop(row.totalCop)}</span> · pago <span className="tabular">{formatCop(row.driverPayCop)}</span></p>
                  </div>
                  <span className="tabular shrink-0 text-sm font-bold text-rust">{formatCop(row.expectedCashCop)}</span>
                </div>
              ))}
              <PaginationControls page={unsettledPage.page} totalPages={unsettledPage.totalPages} totalItems={summary.unsettledOrders.length} onPageChange={unsettledPage.setPage} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DriverHistoryPanel({ state, driver, historyStart, onWidenHistory }: { state: AppState; driver: Driver; historyStart?: string; onWidenHistory?: (startDate: string) => void }) {
  const allHistory = useMemo(() => driverFleetClosedOrders(state, driver.id), [state, driver.id]);
  const [filters, setFilters] = useState<DriverHistoryFilters>({
    search: "",
    status: "all",
    messengerId: "all",
    sellerId: "all",
    startDate: "",
    endDate: ""
  });
  const [expandedId, setExpandedId] = useState("");
  const messengers = state.messengers.filter((messenger) => messenger.leaderDriverId === driver.id);
  const sellers = state.sellers.filter((seller) => allHistory.some((order) => order.sellerId === seller.id));
  const filtered = useMemo(() => filterDriverHistoryOrders(allHistory, filters), [allHistory, filters]);
  const page = usePaginatedItems(filtered, 10);

  // Pedir hacia atras NO puede quedarse en filtrar lo que ya hay en memoria: los pedidos cerrados
  // se descargan por ventana, asi que elegir una fecha anterior tiene que ensanchar la descarga.
  //
  // El margen de 30 dias no es prudencia vaga: este panel filtra por fecha de CIERRE
  // (`orderClosedAt`, que es la evidencia o `updatedAt`) mientras la ventana de descarga corta por
  // `createdAt`. No son el mismo eje — un pedido creado el 28 de julio y cerrado el 3 de agosto
  // entra en "desde el 1 de agosto" pero se habria quedado fuera de la descarga.
  const HISTORY_WINDOW_MARGIN_DAYS = 30;
  useEffect(() => {
    if (!onWidenHistory || !filters.startDate || !historyStart) return;
    if (filters.startDate >= historyStart) return;
    const widened = dateValue(new Date(new Date(`${filters.startDate}T00:00:00.000Z`).getTime() - HISTORY_WINDOW_MARGIN_DAYS * 24 * 60 * 60 * 1000));
    const timer = setTimeout(() => onWidenHistory(widened), 600);
    return () => clearTimeout(timer);
  }, [filters.startDate, historyStart, onWidenHistory]);

  const setFilter = <K extends keyof DriverHistoryFilters>(key: K, value: DriverHistoryFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <Card className="grid gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-bold">Historico de auditoria</h2>
          <p className="text-sm text-ink-60">Pedidos entregados y fallidos de la flota del lider logistico.</p>
        </div>
        <button
          className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-panel px-3 py-2 text-sm font-semibold disabled:opacity-50"
          type="button"
          disabled={filtered.length === 0}
          onClick={() => void downloadDriverHistoryXlsx(filtered, state, driver.id, filters.startDate, filters.endDate)}
        >
          <FileDown size={16} />
          Descargar Excel ({filtered.length})
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-6">
        <label className="grid gap-1 text-xs font-semibold text-ink-60 md:col-span-2">
          Buscar
          <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" placeholder="KNT, Shopify o cliente" value={filters.search} onChange={(event) => setFilter("search", event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Estado
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={filters.status} onChange={(event) => setFilter("status", event.target.value as DriverHistoryFilters["status"])}>
            <option value="all">Todos</option>
            <option value="delivered">Entregado</option>
            <option value="failed">Fallido</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Mensajero
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={filters.messengerId} onChange={(event) => setFilter("messengerId", event.target.value)}>
            <option value="all">Todos</option>
            <option value="none">Lider logistico</option>
            {messengers.map((messenger) => <option key={messenger.id} value={messenger.id}>{messenger.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink-60">
          Tienda
          <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" value={filters.sellerId} onChange={(event) => setFilter("sellerId", event.target.value)}>
            <option value="all">Todas</option>
            {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:col-span-6">
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-ink-60">
            Desde cierre
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={filters.startDate} onChange={(event) => setFilter("startDate", event.target.value)} />
          </label>
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-ink-60">
            Hasta cierre
            <input className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-normal text-fg" type="date" value={filters.endDate} onChange={(event) => setFilter("endDate", event.target.value)} />
          </label>
        </div>
      </div>

      {historyStart && (
        <p className="text-xs text-ink-60">
          Los pedidos en curso siempre estan completos. Los cerrados se descargan desde el {historyStart}; si eliges una fecha de cierre anterior se amplia sola.
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[833px] text-left text-sm">
          <thead className="text-xs uppercase text-ink-60">
            <tr>
              <th className="py-2 pl-3 pr-3">Pedido</th>
              <th className="py-2 pr-3">Tienda</th>
              <th className="py-2 pr-3">Cliente</th>
              <th className="py-2 pr-3">Estado</th>
              <th className="py-2 pr-3">Mensajero</th>
              <th className="py-2 pr-3">Cierre</th>
              <th className="py-2 pr-3">Pago</th>
              <th className="py-2 pr-3">COD</th>
              <th className="py-2 pr-3">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {page.visibleItems.map((order) => {
              const seller = state.sellers.find((item) => item.id === order.sellerId);
              const messenger = state.messengers.find((item) => item.id === order.messengerId);
              const closingEvidence = latestClosingEvidence(order);
              const expanded = expandedId === order.id;
              return (
                <Fragment key={order.id}>
                  <tr className="border-t border-white/10">
                    <td className="py-3 pl-3 pr-3 font-semibold">
                      <span className="block">{order.trackingCode ?? order.id}</span>
                      <span className="block text-xs font-normal text-ink-60">{order.shopifyOrderId}</span>
                    </td>
                    <td className="py-2 pr-3">{seller?.name ?? knownSellerName(order.sellerId)}</td>
                    <td className="py-2 pr-3">{order.customerName}</td>
                    <td className="py-2 pr-3"><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(order)}`}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />{statusLabel(order.status)}</span></td>
                    <td className="py-2 pr-3">{messenger?.name ?? "Lider logistico"}</td>
                    <td className="py-2 pr-3">{formatDateTime(orderClosedAt(order))}</td>
                    <td className="py-2 pr-3">{paymentMethodLabel(order.paymentMethod)}</td>
                    <td className="py-2 pr-3">{order.paymentMethod === "cod" ? formatCop(order.totalCop) : "-"}</td>
                    <td className="py-2 pr-3">
                      <button className="focus-ring rounded-full border border-white/10 px-2 py-1 text-xs font-semibold hover:bg-field" type="button" onClick={() => setExpandedId(expanded ? "" : order.id)}>
                        {expanded ? "Ocultar" : "Ver"}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-t border-white/10 bg-field/70">
                      <td className="px-3 py-3" colSpan={9}>
                        <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
                          <div className="grid gap-2 text-sm">
                            <p><span className="font-semibold">Categoria fallido:</span> {order.status === "failed" ? failedCategoryLabel(order.failedCategory) : "-"}</p>
                            <p><span className="font-semibold">Motivo:</span> {order.failedReason ?? closingEvidence?.reason ?? "-"}</p>
                            <p><span className="font-semibold">Ultima nota:</span> {closingEvidence?.note ?? "-"}</p>
                            <p><span className="font-semibold">Cerrado por:</span> {closingEvidence?.actorId ?? "-"}</p>
                          </div>
                          <div className="grid gap-2">
                            {order.evidence.length === 0 ? (
                              <p className="rounded-2xl bg-panel px-3 py-2 text-sm text-ink-60">Sin evidencias registradas.</p>
                            ) : (
                              <EvidenceSummary evidence={order.evidence} />
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="px-3 py-3 text-sm text-ink-60">No hay pedidos cerrados para los filtros seleccionados.</p>}
      </div>
      <PaginationControls page={page.page} totalPages={page.totalPages} totalItems={filtered.length} onPageChange={page.setPage} />
    </Card>
  );
}

function FleetReportsPanel({ state, driver, financialSummary, historyStart }: { state: AppState; driver: Driver; financialSummary: DriverFinancialSummary; historyStart?: string }) {
  const orders = state.orders.filter((order) => order.driverId === driver.id);
  const messengers = state.messengers.filter((messenger) => messenger.leaderDriverId === driver.id);
  const closed = orders.filter((order) => order.status === "delivered" || order.status === "failed");
  const codCollected = orders.filter((order) => order.status === "delivered" && order.paymentMethod === "cod").reduce((sum, order) => sum + order.totalCop, 0);
  const rows = messengers.map((messenger) => {
    const own = orders.filter((order) => order.messengerId === messenger.id);
    const delivered = own.filter((order) => order.status === "delivered").length;
    const failed = own.filter((order) => order.status === "failed").length;
    const inHand = own.filter((order) => !["delivered", "failed", "cancelled"].includes(order.status)).length;
    const cod = own.filter((order) => order.status === "delivered" && order.paymentMethod === "cod").reduce((sum, order) => sum + order.totalCop, 0);
    return { messenger, total: own.length, delivered, failed, inHand, cod };
  });

  return (
    <Card className="grid gap-3">
      <div>
        <h2 className="font-bold">Reporte de flota</h2>
        <p className="text-sm text-ink-60">El saldo financiero usa cortes, abonos y pedidos COD entregados todavia sin corte.</p>
        {/* Los conteos de pedidos salen de lo descargado, que ya no es todo el historico; el saldo
            NO, porque se deriva de cortes y asientos, que siguen completos. Decirlo evita leer
            "Pedidos flota" como un acumulado de toda la vida. */}
        {historyStart && (
          <p className="mt-1 text-xs text-ink-60">Los conteos de pedidos cubren desde el {historyStart}. Las cifras de dinero son totales y no dependen de esa fecha.</p>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <StatTile icon={<PackageCheck size={16} />} label="Pedidos flota" value={String(orders.length)} />
        <StatTile icon={<Check size={16} />} label="Cerrados" value={String(closed.length)} />
        <StatTile icon={<CreditCard size={16} />} label="Saldo pendiente real" value={formatCop(financialSummary.pendingBalanceCop)} tone={financialSummary.pendingBalanceCop > 0 ? "rust" : "mint"} />
        <StatTile icon={<Wallet size={16} />} label="Dinero entregado" value={formatCop(financialSummary.receivedCop)} tone="mint" />
        <StatTile icon={<AlertTriangle size={16} />} label="Pendiente sin cortar" value={formatCop(financialSummary.unsettledCashCop)} tone={financialSummary.unsettledCashCop > 0 ? "rust" : "default"} />
        <StatTile icon={<ClipboardList size={16} />} label="Cortes incompletos" value={formatCop(financialSummary.incompleteSettlementsCop)} tone={financialSummary.incompleteSettlementsCop > 0 ? "rust" : "default"} />
      </div>
      <p className="text-xs text-ink-60">Recaudo COD de la flota{historyStart ? ` desde el ${historyStart}` : " (historico)"}: <span className="tabular">{formatCop(codCollected)}</span>.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="text-xs uppercase text-ink-60">
            <tr>
              <th className="py-2 pr-3">Mensajero</th>
              <th className="py-2 pr-3">Asignados</th>
              <th className="py-2 pr-3">En poder</th>
              <th className="py-2 pr-3">Entregados</th>
              <th className="py-2 pr-3">Fallidos</th>
              <th className="py-2 pr-3">Recaudo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.messenger.id} className="border-t border-white/10">
                <td className="py-2 pr-3 font-semibold">{row.messenger.name}</td>
                <td className="py-2 pr-3">{row.total}</td>
                <td className="py-2 pr-3">{row.inHand}</td>
                <td className="py-2 pr-3">{row.delivered}</td>
                <td className="py-2 pr-3">{row.failed}</td>
                <td className="py-2 pr-3"><span className="tabular">{formatCop(row.cod)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-3 text-sm text-ink-60">Crea mensajeros para ver reportes por persona.</p>}
      </div>
    </Card>
  );
}

function AssignPickedUpOrdersPanel({ orders, messengers, onAssigned }: { orders: Order[]; messengers: Messenger[]; onAssigned: (orders: Order[]) => void }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [messengerId, setMessengerId] = useState("");
  const [message, setMessage] = useState("");
  const selectedOrders = orders.filter((order) => selectedIds.includes(order.id));
  const canAssign = messengerId && selectedOrders.length > 0;

  useEffect(() => {
    if (!messengerId && messengers[0]) setMessengerId(messengers[0].id);
  }, [messengerId, messengers]);

  async function assignSelected(targetOrders: Order[]) {
    if (!messengerId || targetOrders.length === 0) return;
    setMessage("");
    try {
      if (firebaseEnabled()) {
        const result = await assignFirebaseMessengerToOrders({ orderIds: targetOrders.map((order) => order.id), messengerId });
        onAssigned(result.orders);
      } else {
        const now = new Date().toISOString();
        onAssigned(targetOrders.map((order) => ({ ...order, messengerId, status: "call_pending", callOutcome: "pending", updatedAt: now })));
      }
      setSelectedIds([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo asignar mensajero.");
    }
  }

  return (
    <Card className="grid gap-3">
      <div>
        <h2 className="font-bold">Recogidos pendientes de mensajero</h2>
        <p className="text-sm text-ink-60">La recogida confirma custodia de la flota. El lider decide si asigna todo o solo una parte.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={messengerId} onChange={(event) => setMessengerId(event.target.value)}>
          {messengers.length === 0 && <option value="">Sin mensajeros</option>}
          {messengers.map((messenger) => <option key={messenger.id} value={messenger.id}>{messenger.name}</option>)}
        </select>
        <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold disabled:opacity-50" type="button" disabled={!messengerId || orders.length === 0} onClick={() => void assignSelected(orders)}>
          Asignar toda la recogida
        </button>
        <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={!canAssign} onClick={() => void assignSelected(selectedOrders)}>
          Asignar seleccionados
        </button>
      </div>
      {message && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{message}</p>}
      <PaginatedList items={orders} pageSize={8} empty={<p className="text-sm text-ink-60">No hay pedidos recogidos pendientes de asignar.</p>}>
        {(order) => (
          <label key={order.id} className="flex items-start gap-3 rounded-2xl border border-white/10 p-3 text-sm">
            <input type="checkbox" checked={selectedIds.includes(order.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [order.id, ...current] : current.filter((id) => id !== order.id))} />
            <span>
              <span className="block font-semibold">{order.trackingCode ?? order.shopifyOrderId}</span>
              <span className="block text-xs text-ink-60">{order.customerName} · {order.pickupPointName ?? "Punto de recogida"}</span>
            </span>
          </label>
        )}
      </PaginatedList>
    </Card>
  );
}

function ReassignMessengerOrdersPanel({ orders, messengers, onUpdated }: { orders: Order[]; messengers: Messenger[]; onUpdated: (orders: Order[], summary: string) => void }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [messengerId, setMessengerId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedOrders = orders.filter((order) => selectedIds.includes(order.id));

  useEffect(() => {
    if (!messengerId && messengers[0]) setMessengerId(messengers[0].id);
  }, [messengerId, messengers]);

  async function reassignSelected() {
    if (!messengerId || selectedOrders.length === 0 || busy) return;
    setMessage("");
    setBusy(true);
    try {
      if (firebaseEnabled()) {
        const result = await assignFirebaseMessengerToOrders({ orderIds: selectedOrders.map((order) => order.id), messengerId });
        onUpdated(result.orders, `${result.orders.length} pedido(s) reasignados de mensajero.`);
      } else {
        const now = new Date().toISOString();
        onUpdated(selectedOrders.map((order) => ({ ...order, messengerId, updatedAt: now })), `${selectedOrders.length} pedido(s) reasignados de mensajero.`);
      }
      setSelectedIds([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo reasignar el mensajero.");
    } finally {
      setBusy(false);
    }
  }

  async function unassignSelected() {
    if (selectedOrders.length === 0 || busy) return;
    setMessage("");
    setBusy(true);
    try {
      if (firebaseEnabled()) {
        const result = await unassignFirebaseMessengerFromOrders({ orderIds: selectedOrders.map((order) => order.id) });
        onUpdated(result.orders, `${result.orders.length} pedido(s) devueltos a pendiente de mensajero.`);
      } else {
        const now = new Date().toISOString();
        onUpdated(selectedOrders.map((order) => ({ ...order, messengerId: undefined, status: "picked_up" as const, callOutcome: undefined, updatedAt: now })), `${selectedOrders.length} pedido(s) devueltos a pendiente de mensajero.`);
      }
      setSelectedIds([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo quitar el mensajero.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="grid gap-3">
      <div>
        <h2 className="font-bold">Asignados a mensajero</h2>
        <p className="text-sm text-ink-60">Reasigna pedidos activos a otro mensajero o devuelvelos al listado de pendientes. Los pedidos entregados o fallidos no se pueden mover.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <select className="focus-ring w-full min-w-0 rounded-full border border-white/10 px-3 py-2 text-sm" value={messengerId} onChange={(event) => setMessengerId(event.target.value)}>
          {messengers.length === 0 && <option value="">Sin mensajeros</option>}
          {messengers.map((messenger) => <option key={messenger.id} value={messenger.id}>{messenger.name}</option>)}
        </select>
        <button className="focus-ring rounded-full bg-acid px-3 py-2 text-sm font-semibold text-deep disabled:bg-field disabled:text-ink-60 disabled:cursor-not-allowed" type="button" disabled={!messengerId || selectedOrders.length === 0 || busy} onClick={() => void reassignSelected()}>
          Reasignar seleccionados
        </button>
        <button className="focus-ring rounded-full border border-white/10 px-3 py-2 text-sm font-semibold disabled:opacity-50" type="button" disabled={selectedOrders.length === 0 || busy} onClick={() => void unassignSelected()}>
          Devolver a pendientes
        </button>
      </div>
      {message && <p className="rounded-2xl bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{message}</p>}
      <PaginatedList items={orders} pageSize={8} empty={<p className="text-sm text-ink-60">No hay pedidos activos asignados a mensajeros.</p>}>
        {(order) => {
          const messenger = messengers.find((item) => item.id === order.messengerId);
          return (
            <label key={order.id} className="flex items-start gap-3 rounded-2xl border border-white/10 p-3 text-sm">
              <input type="checkbox" checked={selectedIds.includes(order.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [order.id, ...current] : current.filter((id) => id !== order.id))} />
              <span>
                <span className="block font-semibold">{order.trackingCode ?? order.shopifyOrderId}</span>
                <span className="block text-xs text-ink-60">{order.customerName} · {messenger?.name ?? order.messengerId} · {statusLabel(order.status)}</span>
              </span>
            </label>
          );
        }}
      </PaginatedList>
    </Card>
  );
}

function MessengerView({ state, setState, session, orderSearch, onOrderSearchChange, historyStart }: { state: AppState; setState: (state: AppState) => void; session: Session; orderSearch: string; onOrderSearchChange: (value: string) => void; historyStart?: string }) {
  const messenger = state.messengers.find((item) => item.id === session.profileId);
  const messengerId = messenger?.id ?? "";
  // Antes eran cuatro recorridos completos de `state.orders` por render, en el rol que corre en
  // telefonos de gama baja. Los hooks van antes del early return: no pueden ser condicionales.
  const { orders, delivered, failed } = useMemo(() => {
    const closedStatuses = new Set(["delivered", "failed", "cancelled"]);
    const activeOrders: Order[] = [];
    let deliveredCount = 0;
    let failedCount = 0;
    for (const order of state.orders) {
      if (order.messengerId !== messengerId) continue;
      if (!closedStatuses.has(order.status)) activeOrders.push(order);
      if (order.status === "delivered") deliveredCount++;
      else if (order.status === "failed") failedCount++;
    }
    return { orders: activeOrders, delivered: deliveredCount, failed: failedCount };
  }, [state.orders, messengerId]);
  const visible = useMemo(() => orders.filter((order) => orderSearchMatches(order, orderSearch)), [orders, orderSearch]);

  if (!messenger) {
    return (
      <main className="theme-light min-h-screen px-4 py-5">
        <div className="mx-auto max-w-3xl">
          <EmptyRoleState title="Perfil de mensajero pendiente" message="Tu cuenta existe, pero falta asociarla a un mensajero de la flota." />
        </div>
      </main>
    );
  }

  return (
    // TEMA CLARO. El mensajero trabaja en la calle bajo sol directo: un tema oscuro ahi no se
    // lee. `.theme-light` redefine los canales de color para todo el subarbol, asi que la
    // tarjeta de pedido y las evidencias -que comparte con los demas roles- se adaptan solas.
    // Ancho contenido a max-w-3xl: es una vista de telefono, no un panel de escritorio.
    <main className="theme-light min-h-screen">
      <div className="mx-auto grid max-w-3xl content-start gap-4 px-4 py-5">
      <div>
        <h2 className="text-2xl font-bold">Mi ruta</h2>
        <p className="text-sm text-ink-60">{messenger.name} · {orders.length} pedido{orders.length === 1 ? "" : "s"} por entregar</p>
      </div>

      {/* Franja compacta: tres cifras en una superficie, no tres tarjetas. En la calle lo que
          importa es cuantos faltan, no el desglose. */}
      <div className="grid grid-cols-3 divide-x divide-fg/[0.08] overflow-hidden rounded-3xl border border-fg/[0.08] bg-panel">
        <div className="p-3 text-center">
          <p className="text-[11px] font-medium leading-tight text-ink-60">Activos</p>
          <p className="tabular text-2xl font-bold">{orders.length}</p>
        </div>
        <div className="p-3 text-center">
          <p className="text-[11px] font-medium leading-tight text-ink-60">Entregados</p>
          <p className="tabular text-2xl font-bold text-mint">{delivered}</p>
        </div>
        <div className="p-3 text-center">
          <p className="text-[11px] font-medium leading-tight text-ink-60">Fallidos</p>
          <p className={`tabular text-2xl font-bold ${failed > 0 ? "text-rust" : ""}`}>{failed}</p>
        </div>
      </div>
      {/* "Activos" siempre esta completo; los dos cerrados salen de la ventana descargada, asi que
          dejarlos sin fecha los haria leer como un acumulado de toda la vida, que es lo que eran. */}
      {historyStart && (
        <p className="-mt-1 text-center text-[11px] text-ink-60">Entregados y fallidos desde el {historyStart}.</p>
      )}

      <EvidenceQueuePanel state={state} setState={setState} />
      <section className="grid gap-3">
        <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} />
        <GroupedOrdersByPickup orders={visible} state={state} setState={setState} actorProfileId={messenger.id} />
      </section>
      </div>
    </main>
  );
}

function GroupedOrdersByPickup({ orders, state, setState, actorProfileId }: { orders: Order[]; state: AppState; setState: (state: AppState) => void; actorProfileId: string }) {
  const groups = orders.reduce<Array<{ key: string; name: string; address: string; orders: Order[] }>>((acc, order) => {
    const name = order.pickupPointName || state.sellers.find((seller) => seller.id === order.sellerId)?.name || "Punto de recogida";
    const address = order.pickupAddress || state.sellers.find((seller) => seller.id === order.sellerId)?.pickupAddress || "";
    const key = `${name}|${address}`;
    const existing = acc.find((group) => group.key === key);
    if (existing) existing.orders.push(order);
    else acc.push({ key, name, address, orders: [order] });
    return acc;
  }, []);

  if (groups.length === 0) return <Card><p className="text-sm text-ink-60">No hay pedidos asignados.</p></Card>;
  return (
    <div className="grid gap-3">
      {groups.map((group) => (
        <section key={group.key} className="grid gap-2">
          <div className="rounded-2xl bg-field px-3 py-2">
            <p className="font-semibold">{group.name}</p>
            <p className="text-sm text-ink-60">{group.address || "Direccion de recogida pendiente"}</p>
          </div>
          <PaginatedList items={group.orders} pageSize={8} empty={<p />}>
            {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={actorProfileId} />}
          </PaginatedList>
        </section>
      ))}
    </div>
  );
}

function AuditBar({ state }: { state: AppState }) {
  const latest = state.audit.slice(0, 4);
  return (
    <div className="border-t border-white/10 bg-panel">
      <div className="mx-auto grid max-w-7xl gap-2 px-4 py-3 md:grid-cols-4">
        {latest.map((event) => (
          <p key={event.id} className="truncate text-xs text-ink-60">
            <ShieldCheck className="mr-1 inline" size={13} /> {event.summary}
          </p>
        ))}
      </div>
    </div>
  );
}

export function OperationsApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [activeView, setActiveView] = useState<AppView>("operations");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderStartDate, setOrderStartDate] = useState(defaultOrderStartDate);
  const [orderEndDate, setOrderEndDate] = useState(dateValue(new Date()));
  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [orderSellerFilter, setOrderSellerFilter] = useState("all");
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  // Ventana de descarga de pedidos CERRADOS. Solo se ensancha: si el usuario elige una fecha
  // anterior se rehace la suscripcion, pero si vuelve a acortar el rango no se toca (lo ya
  // descargado no estorba y re-suscribir en cada cambio de fecha seria peor que el problema).
  const [historyStart, setHistoryStart] = useState(defaultOrderStartDate);
  const { state, setState, remoteEnabled, hydrated } = useAppState(session, historyStart);

  // Un cambio MANUAL de fecha si ensancha la ventana: ahi el usuario quiere ver los pedidos.
  // Los atajos de periodo no, porque sus cifras las calcula el servidor y bajar el historico
  // entero para pintar cuatro numeros es justo lo que no escala.
  const [windowFollowsRange, setWindowFollowsRange] = useState(true);
  useEffect(() => {
    if (!windowFollowsRange || !orderStartDate || historyStart === "" || orderStartDate >= historyStart) return;
    const timer = setTimeout(() => setHistoryStart(orderStartDate), 600);
    return () => clearTimeout(timer);
  }, [windowFollowsRange, orderStartDate, historyStart]);

  // Ensanchado directo de la ventana, sin pasar por el rango de la tabla. Lo usa el historico del
  // lider, que filtra por fecha de CIERRE y por tanto no puede compartir `orderStartDate`.
  // Igual que arriba: solo ensancha. Una cadena vacia significa "sin limite inferior", que es el
  // limite MAS ancho, no el mas estrecho.
  const widenHistoryWindow = useCallback((startDate: string) => {
    setHistoryStart((current) => {
      if (current === "") return current;
      return startDate === "" || startDate < current ? startDate : current;
    });
  }, []);

  const setOrderStartDateManual = useCallback((value: string) => {
    setWindowFollowsRange(true);
    setOrderStartDate(value);
  }, []);
  const setOrderEndDateManual = useCallback((value: string) => {
    setWindowFollowsRange(true);
    setOrderEndDate(value);
  }, []);

  // Los atajos de periodo mueven las dos fechas Y, si hace falta, ensanchan la ventana de
  // descarga en el mismo gesto. El ensanchado automatico de arriba compara fechas, asi que no
  // sirve para "Acumulado": manda `startDate` vacio y una cadena vacia no es "mas antigua" que
  // ninguna fecha. Aqui la cadena vacia significa lo que significa en la consulta de Firestore,
  // que es "sin limite inferior" — o sea el limite MAS ancho, no el mas estrecho.
  const applyOrderRange = useCallback((start: string, end: string) => {
    setWindowFollowsRange(false);
    setOrderStartDate(start);
    setOrderEndDate(end);
  }, []);

  // El rango pedido se sale de lo que el navegador tiene descargado: hay que preguntarle al
  // servidor en vez de calcular sobre datos incompletos.
  const rangeExceedsWindow = historyStart !== "" && (orderStartDate === "" || orderStartDate < historyStart);
  const [periodStats, setPeriodStats] = useState<OrderPeriodStats | null>(null);
  const [periodStatsError, setPeriodStatsError] = useState<string | null>(null);
  const sessionRole = session?.role;
  const canQueryStats = sessionRole === "admin" || sessionRole === "seller" || sessionRole === "seller_logistics";
  useEffect(() => {
    if (!rangeExceedsWindow || !canQueryStats || !firebaseEnabled()) {
      setPeriodStats(null);
      setPeriodStatsError(null);
      return;
    }
    let cancelled = false;
    setPeriodStatsError(null);
    const timer = setTimeout(() => {
      getFirebaseOrderStats({
        startDate: orderStartDate,
        endDate: orderEndDate,
        sellerId: sessionRole === "admin" && orderSellerFilter !== "all" ? orderSellerFilter : undefined
      })
        .then((stats) => { if (!cancelled) setPeriodStats(stats); })
        .catch((error: unknown) => {
          if (cancelled) return;
          setPeriodStats(null);
          setPeriodStatsError(error instanceof Error ? error.message : "No se pudieron calcular los indicadores del periodo.");
        });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rangeExceedsWindow, canQueryStats, orderStartDate, orderEndDate, orderSellerFilter, sessionRole]);

  // Busqueda en el servidor: el navegador ya no tiene todo el historial, asi que un pedido
  // anterior a la ventana se busca en Firestore y se suma a lo que ya esta cargado. La busqueda
  // encuentra MAS que antes, no menos: antes solo alcanzaba lo que hubiera en memoria.
  const [foundOrders, setFoundOrders] = useState<Order[]>([]);
  const [searchingServer, setSearchingServer] = useState(false);

  useEffect(() => {
    const term = orderSearch.trim();
    // Solo los roles con ventana lo necesitan: driver y mensajero siguen con todos sus pedidos
    // cargados, asi que consultar el servidor no aportaria nada.
    const windowedRole = session?.role === "admin" || session?.role === "seller" || session?.role === "seller_logistics";
    if (!session || !windowedRole || !firebaseEnabled() || term.length < 3) {
      setFoundOrders([]);
      return;
    }
    const timer = setTimeout(() => {
      setSearchingServer(true);
      void findFirestoreOrders(term, { role: session.role, profileId: session.profileId })
        .then(setFoundOrders)
        .catch((error: unknown) => console.warn("No se pudo buscar en el historial.", error))
        .finally(() => setSearchingServer(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [orderSearch, session?.role, session?.profileId, session]);

  // Estado con los pedidos encontrados en el servidor fusionados. Se pasa a las vistas en vez de
  // `state` para que la busqueda alcance el historial completo sin tocar la suscripcion.
  const viewState = useMemo(() => {
    if (foundOrders.length === 0) return state;
    const known = new Set(state.orders.map((order) => order.id));
    const extra = foundOrders.filter((order) => !known.has(order.id));
    if (extra.length === 0) return state;
    return { ...state, orders: [...extra, ...state.orders] };
  }, [state, foundOrders]);

  useEffect(() => {
    const orderParam = new URLSearchParams(window.location.search).get("order")?.trim() ?? "";
    setOrderSearch(orderParam);

    if (firebaseEnabled()) {
      void getFirebaseBootstrapStatus()
        .then((status) => setNeedsBootstrap(status.needsBootstrap))
        .catch(() => setNeedsBootstrap(false));
    } else {
      setNeedsBootstrap(readAccounts().length === 0);
    }

    if (firebaseEnabled()) {
      return subscribeFirebaseUser((user, claims) => {
        if (!user || !claims.role) {
          setSession(null);
          return;
        }
        const accounts = readAccounts();
        const account = accounts.find((item) => item.id === user.uid || item.email === user.email);
        const profileId =
          claims.role === "seller" || claims.role === "seller_logistics"
            ? claims.sellerId ?? account?.profileId ?? `seller-${user.uid}`
            : claims.role === "driver"
              ? claims.driverId ?? account?.profileId ?? `driver-${user.uid}`
              : claims.role === "messenger"
                ? claims.messengerId ?? account?.profileId ?? `messenger-${user.uid}`
                : claims.role === "community_leader"
                  // Para este rol, el "perfil" es su comunidad: es lo que filtra sus tiendas,
                  // sus cortes y sus cifras.
                  ? claims.communityId ?? account?.profileId ?? `com-${user.uid}`
                  : account?.profileId ?? `admin-${user.uid}`;
        setSession({
          id: user.uid,
          email: user.email ?? account?.email ?? "",
          name: account?.name ?? user.displayName ?? user.email ?? roleLabel(claims.role),
          role: claims.role,
          profileId
        });
        const activeRole = claims.role;
        setState((current) => ({ ...current, activeRole }));
      });
    }

    const raw = window.localStorage.getItem(sessionKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Session;
      setSession(parsed);
      setState((current) => ({ ...current, activeRole: parsed.role }));
    }
    return undefined;
  }, [setState]);

  function commitSession(nextSession: Session) {
    window.localStorage.setItem(sessionKey, JSON.stringify(nextSession));
    setSession(nextSession);
  }

  async function handleAuth(account: { name: string; email: string; password: string }) {
    const email = account.email.trim().toLowerCase();
    const accounts = readAccounts();

    if (needsBootstrap) {
      const result = firebaseEnabled()
        ? await createUserFromAdmin(state, { ...account, role: "admin" })
        : createLocalUser(state, { ...account, role: "admin" });
      if (result.error) return result.error;
      setState(result.state);
      setNeedsBootstrap(false);
      commitSession({
        id: result.account.id,
        email: result.account.email,
        name: result.account.name,
        role: result.account.role,
        profileId: result.account.profileId
      });
      if (firebaseEnabled()) {
        await signInWithFirebaseEmail(email, account.password);
      }
      return null;
    }

    if (firebaseEnabled()) {
      try {
        await signInWithFirebaseEmail(email, account.password);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "No se pudo iniciar sesion.";
      }
    }

    const found = accounts.find((item) => item.email === email && item.password === account.password);
    if (!found) return "Credenciales invalidas o cuenta no creada por un administrador.";
    commitSession({
      id: found.id,
      email: found.email,
      name: found.name,
      role: found.role,
      profileId: found.profileId
    });
    setState({ ...state, activeRole: found.role });
    return null;
  }

  function signOut() {
    window.localStorage.removeItem(sessionKey);
    setSession(null);
    setActiveView("operations");
    void signOutFirebase();
  }

  const view = useMemo(() => {
    if (!session) return null;
    if (activeView === "wallet" && session.role !== "messenger" && session.role !== "seller_logistics") {
      // El admin ve ademas el saldo por tienda y las solicitudes de pago: complementa el historial
      // de movimientos de WalletPage, no lo repite. Antes vivia sepultado en la columna lateral de
      // Operacion, que es el ultimo sitio donde alguien lo buscaria.
      return session.role === "admin" ? (
        <div className="grid gap-4">
          <WalletPage state={viewState} session={session} />
          <div className="mx-auto w-full max-w-7xl px-4 pb-5">
            <WalletPanel state={viewState} />
          </div>
        </div>
      ) : (
        <WalletPage state={viewState} session={session} />
      );
    }
    // Los destinos "dispatch", "finance" e "historico" son exclusivos del lider: los resuelve
    // DriverView mas abajo. Sin esta guarda, otro rol que llegara con esa vista veria su panel.
    if (activeView === "liquidations" && session.role === "admin") return <LiquidationsPage state={viewState} setState={setState} />;
    if (activeView === "inventory" && session.role === "admin") return <InventoryPage state={viewState} setState={setState} />;
    if (session.role === "seller" || session.role === "seller_logistics") return <SellerView state={viewState} setState={setState} session={session} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} startDate={orderStartDate} endDate={orderEndDate} statusFilter={orderStatusFilter} historyStart={historyStart} searchingHistory={searchingServer} view={activeView} onStartDate={setOrderStartDateManual} onEndDate={setOrderEndDateManual} onStatusFilter={setOrderStatusFilter} onSelectRange={applyOrderRange} periodStats={periodStats} periodStatsError={periodStatsError} hideFinance={session.role === "seller_logistics"} />;
    if (session.role === "driver") return <DriverView state={viewState} setState={setState} session={session} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} view={activeView} historyStart={historyStart} onWidenHistory={widenHistoryWindow} />;
    if (session.role === "community_leader") return <CommunityLeaderView state={viewState} session={session} startDate={orderStartDate} endDate={orderEndDate} onStartDate={setOrderStartDateManual} onEndDate={setOrderEndDateManual} />;
    if (session.role === "messenger") return <MessengerView state={viewState} setState={setState} session={session} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} historyStart={historyStart} />;
    return <AdminView view={activeView} state={viewState} setState={setState} session={session} onNavigate={setActiveView} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} startDate={orderStartDate} endDate={orderEndDate} statusFilter={orderStatusFilter} sellerFilter={orderSellerFilter} historyStart={historyStart} searchingHistory={searchingServer} onStartDate={setOrderStartDateManual} onEndDate={setOrderEndDateManual} onStatusFilter={setOrderStatusFilter} onSellerFilter={setOrderSellerFilter} onSelectRange={applyOrderRange} periodStats={periodStats} periodStatsError={periodStatsError} />;
  }, [activeView, applyOrderRange, historyStart, orderEndDate, orderSearch, orderSellerFilter, orderStartDate, orderStatusFilter, periodStats, periodStatsError, searchingServer, session, setOrderEndDateManual, setOrderStartDateManual, viewState, setState, widenHistoryWindow]);

  if (!session) return <AuthScreen onSubmit={handleAuth} needsBootstrap={needsBootstrap} />;

  return (
    <div className="bloom-field min-h-screen">
      <ViewTabs activeView={activeView} onChange={setActiveView} role={session.role} />
      {/* pb-24 en movil deja libre la barra inferior; md:pl-[84px] deja sitio al riel. */}
      <div className="min-w-0 pb-24 md:pb-0 md:pl-[84px]">
        <Header session={session} remoteEnabled={remoteEnabled} onSignOut={signOut} />
        {hydrated ? view : <AppSkeleton />}
        <AuditBar state={state} />
      </div>
    </div>
  );
}
