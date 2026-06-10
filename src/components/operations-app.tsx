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
  Image as ImageIcon,
  LogOut,
  MapPin,
  PackageCheck,
  Phone,
  Printer,
  QrCode,
  Route,
  ShieldCheck,
  Store,
  Truck,
  Wallet,
  X
} from "lucide-react";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelFirebaseOrder,
  assignFirebaseMessengerToOrders,
  createManualFirebaseOrder,
  createFirebaseMessengerProfile,
  createFirebasePickupBatch,
  createFirebaseSettlement,
  createManagedFirebaseUser,
  closeFirebaseOrder,
  confirmFirebaseImportedOrder,
  confirmFirebaseRetryOrder,
  getFirebaseBootstrapStatus,
  importFirebaseShopifyOrder,
  reconcileFirebaseInventoryReservations,
  repairFirebaseOwnDriverProfile,
  signInWithFirebaseEmail,
  signOutFirebase,
  syncFirebaseShopifyHistoricalOrders,
  subscribeFirebaseUser,
  updateFirebaseImportedOrder,
  updateFirebaseOrderAdjustments,
  updateFirebaseSettlementStatus
} from "@/lib/firebase/auth";
import { firebaseEnabled } from "@/lib/firebase/client";
import { canUseFirestoreStore, loadFirestoreState, saveFirestoreInventoryItem, saveFirestoreOrder, saveFirestoreOrderLabelPrint, saveFirestoreShopifyInstallRequest, saveFirestoreState, saveFirestoreWalletEntries, saveFirestoreZone, subscribeFirestoreState } from "@/lib/firebase/state-store";
import { prepareEvidenceImage, uploadEvidenceImage } from "@/lib/firebase/storage";
import {
  advanceOrder,
  approvePayout,
  assignOrder,
  closeDelivered,
  closeFailed,
  confirmDeliveryWindow,
  createManualOrder,
  requestPayout,
  rescheduleCustomerCall,
  resolveAddress
} from "@/lib/actions";
import { entriesForClosedOrder, formatCop, sellerBalance, weeklyFailedRate } from "@/lib/finance";
import { getSellerShopifyConnection, normalizeShopifyDomain } from "@/lib/shopify/connection";
import { emptyState } from "@/lib/seed";
import type { AppState, Driver, Evidence, FulfillmentMode, InventoryItem, Messenger, Order, PaymentMethod, Role, Seller, Settlement, ShopifyInstallRequest, ShopifyStore, ShopifySyncIssue, WalletEntry } from "@/lib/types";

const storageKey = "ultima-milla-mvp-state";
const sessionKey = "kentro-session";
const accountsKey = "kentro-accounts";
const evidenceQueueKey = "kentro-evidence-queue";
const printableOrderStatuses = new Set<Order["status"]>([
  "address_risk",
  "ready_to_assign",
  "assigned",
  "call_pending",
  "scheduled",
  "pickup_pending",
  "picked_up",
  "in_route",
  "retry_pending"
]);

type LocalAccount = {
  id: string;
  email: string;
  password: string;
  name: string;
  role: Role;
  profileId: string;
};

type Session = Omit<LocalAccount, "password">;
type AppView = "operations" | "wallet" | "liquidations" | "inventory";
type QueuedEvidence = {
  id: string;
  orderId: string;
  outcome: "delivered" | "failed";
  note: string;
  reason?: string;
  scheduledDate?: string;
  scheduledWindow?: string;
  fileName: string;
  fileType: string;
  dataUrl: string;
  createdAt: string;
  error?: string;
};

function readAccounts(): LocalAccount[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(accountsKey);
  return raw ? (JSON.parse(raw) as LocalAccount[]) : [];
}

function writeAccounts(accounts: LocalAccount[]) {
  window.localStorage.setItem(accountsKey, JSON.stringify(accounts));
}

function readEvidenceQueue(): QueuedEvidence[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(evidenceQueueKey);
  return raw ? (JSON.parse(raw) as QueuedEvidence[]) : [];
}

function writeEvidenceQueue(items: QueuedEvidence[]) {
  window.localStorage.setItem(evidenceQueueKey, JSON.stringify(items));
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("No se pudo guardar la foto en cola."));
    reader.readAsDataURL(file);
  });
}

async function enqueueEvidence(input: Omit<QueuedEvidence, "id" | "dataUrl" | "fileName" | "fileType" | "createdAt"> & { file: File }) {
  const queuedFile = await prepareEvidenceImage(input.file);
  const dataUrl = await fileToDataUrl(queuedFile);
  const item: QueuedEvidence = {
    id: `qe-${input.orderId}-${Date.now()}`,
    orderId: input.orderId,
    outcome: input.outcome,
    note: input.note,
    reason: input.reason,
    scheduledDate: input.scheduledDate,
    scheduledWindow: input.scheduledWindow,
    fileName: queuedFile.name || input.file.name || "evidencia.jpg",
    fileType: queuedFile.type || input.file.type || "image/jpeg",
    dataUrl,
    createdAt: new Date().toISOString()
  };
  writeEvidenceQueue([item, ...readEvidenceQueue().filter((queued) => queued.id !== item.id)]);
  return item;
}

function dataUrlToFile(dataUrl: string, fileName: string, fileType: string) {
  const [header, body] = dataUrl.split(",");
  const mime = header.match(/data:(.*);base64/)?.[1] || fileType || "image/jpeg";
  const binary = window.atob(body ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], fileName, { type: mime });
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
  account: { name: string; email: string; password: string; role: Role; leaderDriverId?: string }
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

  const profileId = `${account.role}-${Date.now()}`;
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
  account: { name: string; email: string; password: string; role: Role; leaderDriverId?: string }
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

function useAppState(session: Session | null) {
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

    const context = session ? { role: session.role, profileId: session.profileId } : undefined;
    if (session && canUseFirestoreStore()) {
      setRemoteEnabled(true);
      void loadFirestoreState(context)
        .then((remoteState) => {
          if (remoteState) {
            const cleanState = withoutLegacyDemo(remoteState);
            setState(cleanState);
            if (cleanState !== remoteState) void saveFirestoreState(cleanState, context);
          } else void saveFirestoreState(state, context);
          setHydrated(true);
        })
        .catch(() => hydrateLocal());

      return subscribeFirestoreState(context, (remoteState) => {
        applyingRemote.current = true;
        setState(withoutLegacyDemo(remoteState));
      });
    }

    hydrateLocal();
    return undefined;
  }, [session?.id, session?.profileId, session?.role]);

  useEffect(() => {
    if (!hydrated) return;
    if (applyingRemote.current) {
      applyingRemote.current = false;
      return;
    }
    if (remoteEnabled) {
      const context = session ? { role: session.role, profileId: session.profileId } : undefined;
      void saveFirestoreState(state, context);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }, [hydrated, remoteEnabled, session, state]);

  return { state, setState, remoteEnabled };
}

function roleLabel(role: Role) {
  return role === "admin" ? "Admin" : role === "seller" ? "Vendedor" : role === "driver" ? "Lider logistico" : "Mensajero";
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

function statusTone(order: Order) {
  if (order.status === "imported") return "bg-lime text-ink";
  if (order.status === "delivered") return "bg-mint text-white";
  if (order.status === "failed" || order.addressRisk === "review") return "bg-rust text-white";
  if (order.status === "retry_pending") return "bg-lime text-ink";
  if (order.status === "in_route" || order.status === "picked_up") return "bg-sky text-white";
  return "bg-field text-ink";
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

function filterOrdersByRangeStatus(orders: Order[], startDate: string, endDate: string, status: string, search: string) {
  return [...orders]
    .filter((order) => {
      const date = orderDateValue(order);
      if (startDate && date && date < startDate) return false;
      if (endDate && date && date > endDate) return false;
      if (status !== "all" && order.status !== status) return false;
      return orderSearchMatches(order, search);
    })
    .sort((left, right) => String(right.createdAt || right.updatedAt).localeCompare(String(left.createdAt || left.updatedAt)));
}

function OrderFilters({
  startDate,
  endDate,
  status,
  sellers = [],
  sellerFilter,
  onStartDate,
  onEndDate,
  onStatus,
  onSeller
}: {
  startDate: string;
  endDate: string;
  status: string;
  sellers?: Seller[];
  sellerFilter?: string;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  onStatus: (value: string) => void;
  onSeller?: (value: string) => void;
}) {
  return (
    <Card>
      <div className={`grid gap-2 ${onSeller ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Desde
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" type="date" value={startDate} onChange={(event) => onStartDate(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Hasta
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" type="date" value={endDate} onChange={(event) => onEndDate(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Estado
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" value={status} onChange={(event) => onStatus(event.target.value)}>
            {orderStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {onSeller && (
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Vendedor
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" value={sellerFilter ?? "all"} onChange={(event) => onSeller(event.target.value)}>
              <option value="all">Todos los vendedores</option>
              {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
            </select>
          </label>
        )}
      </div>
    </Card>
  );
}

function LogisticsKpis({ orders }: { orders: Order[] }) {
  const total = orders.length;
  const pendingConfirm = orders.filter((order) => order.status === "imported" || order.status === "address_risk").length;
  const readyWithoutLeader = orders.filter((order) => order.status === "ready_to_assign" && !order.driverId).length;
  const assignedPendingPickup = orders.filter((order) => order.status === "assigned").length;
  const pickedWithoutMessenger = orders.filter((order) => order.status === "picked_up" && !order.messengerId).length;
  const inOperation = orders.filter((order) => ["call_pending", "scheduled", "in_route", "retry_pending"].includes(order.status) || (order.status === "picked_up" && Boolean(order.messengerId))).length;
  const delivered = orders.filter((order) => order.status === "delivered").length;
  const failed = orders.filter((order) => order.status === "failed").length;
  const cancelled = orders.filter((order) => order.status === "cancelled").length;
  const liquidated = orders.filter((order) => order.status === "liquidated").length;
  const funnelTotal = pendingConfirm + readyWithoutLeader + assignedPendingPickup + pickedWithoutMessenger + inOperation + delivered + failed + cancelled + liquidated;
  const pickedByDriver = orders.filter((order) => order.driverId && ["call_pending", "scheduled", "picked_up", "in_route", "retry_pending", "delivered", "failed"].includes(order.status)).length;
  const codCop = orders.filter((order) => order.paymentMethod === "cod" && order.status !== "cancelled").reduce((sum, order) => sum + order.totalCop, 0);
  const deliveryRate = pickedByDriver > 0 ? Math.round((delivered / pickedByDriver) * 100) : 0;
  const completionRate = pickedByDriver > 0 ? Math.round(((delivered + failed) / pickedByDriver) * 100) : 0;
  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-bold uppercase text-black/50">Embudo operativo</h2>
        <p className="text-xs text-black/50">Estas tarjetas son excluyentes y deben sumar el total filtrado.</p>
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
        <Metric icon={<ShieldCheck size={20} />} label="Cancelados" value={String(cancelled)} />
        {liquidated > 0 && <Metric icon={<CreditCard size={20} />} label="Liquidados" value={String(liquidated)} />}
      </div>
      {funnelTotal !== total && (
        <p className="rounded-md bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">
          Revision: el embudo suma {funnelTotal} y el total filtrado es {total}. Hay estados no clasificados.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-bold uppercase text-black/50">Indicadores</h2>
        <p className="text-xs text-black/50">Estas metricas no se suman; son lecturas transversales del mismo rango.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric icon={<QrCode size={20} />} label="Tomados por lider" value={String(pickedByDriver)} />
        <Metric icon={<ShieldCheck size={20} />} label="Entrega sobre tomados" value={`${deliveryRate}%`} />
        <Metric icon={<Route size={20} />} label="% finalizacion operacion" value={`${completionRate}%`} />
        <Metric icon={<Wallet size={20} />} label="Recaudo COD rango" value={formatCop(codCop)} />
      </div>
      <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/60">
        Entrega sobre tomados = entregados / tomados por lider. Finalizacion = entregados + fallidos / tomados por lider. No considera pedidos no despachados.
      </p>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function canPrintSellerLabel(order: Order, sellerId?: string) {
  return Boolean(sellerId && order.sellerId === sellerId && printableOrderStatuses.has(order.status));
}

function canPrintAdminWarehouseLabel(order: Order) {
  return order.fulfillmentMode === "warehouse" && printableOrderStatuses.has(order.status);
}

function canPrintAdminLabel(order: Order) {
  return Boolean(order.labelPrintedAt) || printableOrderStatuses.has(order.status);
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
  if (orders.length === 0) return;
  const popup = window.open("", "_blank", "width=900,height=700");
  if (!popup) return;
  const labels = await Promise.all(orders.map(async (order) => {
    const seller = state.sellers.find((item) => item.id === order.sellerId);
    const zone = state.zones.find((item) => item.id === order.zoneId);
    const code = order.trackingCode ?? order.shopifyOrderId;
    const address = order.normalizedAddress ?? order.addressRaw;
    const codText = order.paymentMethod === "cod" ? `COBRAR ${formatCop(order.totalCop)}` : "PAGADO";
    const lookupUrl = orderLookupUrl(order);
    const qrDataUrl = await QRCode.toDataURL(lookupUrl, { errorCorrectionLevel: "M", margin: 1, width: 180 });
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
            <p class="small">${escapeHtml(lookupUrl)}</p>
          </div>
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
          .label { page-break-after: always; break-after: page; overflow: hidden; border: 2px solid #111; border-radius: 7px; padding: 8px; height: 140mm; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto auto; gap: 6px; align-content: start; }
          .top, .grid, .product-grid, footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
          .scan { display: grid; grid-template-columns: 27mm minmax(0, 1fr); gap: 8px; align-items: center; border: 2px solid #111; border-radius: 7px; padding: 6px; }
          .scan img { width: 27mm; height: 27mm; image-rendering: pixelated; }
          .eyebrow, .key { margin: 0 0 2px; color: #555; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
          h1 { margin: 0; font-size: 30px; line-height: 1; }
          p { margin: 0; font-size: 11px; line-height: 1.2; }
          .value { font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
          .small { margin-top: 3px; font-size: 7.5px; line-height: 1.1; overflow-wrap: anywhere; color: #555; }
          .address { max-height: 32mm; overflow: hidden; font-size: 15px; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
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

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-black/10 bg-white p-4 shadow-panel ${className}`}>{children}</section>;
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
      onClick={onClick}
      disabled={disabled}
      className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-md border border-black/10 bg-white text-ink transition hover:bg-field disabled:cursor-not-allowed disabled:opacity-40"
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
      className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold transition ${
        active ? "bg-ink text-white" : "border border-black/10 bg-white hover:bg-field"
      }`}
    >
      {children}
    </button>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-field text-mint">{icon}</div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-normal text-black/50">{label}</p>
          <p className="text-xl font-bold">{value}</p>
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
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-black/10 pt-3">
      <p className="text-xs text-black/50">{totalItems} registros · pagina {page + 1} de {totalPages}</p>
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
      <section className="w-full max-w-md rounded-lg border border-black/10 bg-white p-5 shadow-panel">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-ink text-lime">
            <Route size={23} />
          </div>
          <div>
            <h1 className="text-xl font-bold">Kentro</h1>
            <p className="text-sm text-black/60">{needsBootstrap ? "Crear primer administrador" : "Inicio de sesion"}</p>
          </div>
        </div>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || submitting) return;
            setSubmitting(true);
            void onSubmit({ name, email, password })
              .then((result) => setError(result))
              .finally(() => setSubmitting(false));
          }}
        >
          {needsBootstrap && (
            <label className="grid gap-1 text-sm font-semibold">
              Nombre
              <input className="focus-ring rounded-md border border-black/10 px-3 py-2 font-normal" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
          )}
          <label className="grid gap-1 text-sm font-semibold">
            Email
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 font-normal" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Contrasena
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 font-normal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} />
          </label>
          {error && <p className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
          <button
            aria-label={needsBootstrap ? "Crear administrador" : "Entrar"}
            className="focus-ring min-h-11 w-full rounded-md bg-ink px-4 py-2 font-semibold text-white disabled:opacity-50"
            type="submit"
            disabled={!canSubmit || submitting}
          >
            {submitting ? "Entrando..." : needsBootstrap ? "Crear administrador" : "Entrar"}
          </button>
          {!needsBootstrap && (
            <p className="text-xs text-black/50">Las cuentas de vendedores y transportistas las crea un administrador.</p>
          )}
        </form>
      </section>
    </main>
  );
}

function Header({ session, remoteEnabled, onSignOut }: { session: Session; remoteEnabled: boolean; onSignOut: () => void }) {
  return (
    <header className="sticky top-0 z-20 border-b border-black/10 bg-[#f7f8f4]/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-lime">
            <Route size={22} />
          </div>
          <div>
            <h1 className="text-lg font-bold">Kentro</h1>
            <p className="text-sm text-black/60">Centro operativo de ultima milla</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold text-black/60">
            {session.name} · {roleLabel(session.role)}
          </span>
          <span className="rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold text-black/60">
            {remoteEnabled ? "Live" : "Local"}
          </span>
          <IconButton title="Cerrar sesion" onClick={onSignOut}><LogOut size={17} /></IconButton>
        </div>
      </div>
    </header>
  );
}

function ViewTabs({ activeView, onChange, role }: { activeView: AppView; onChange: (view: AppView) => void; role: Role }) {
  return (
    <nav className="border-b border-black/10 bg-white">
      <div className="mx-auto flex max-w-7xl gap-2 px-4 py-2">
        <button
          className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${activeView === "operations" ? "bg-ink text-white" : "hover:bg-field"}`}
          type="button"
          onClick={() => onChange("operations")}
        >
          Operacion
        </button>
        {role !== "messenger" && (
          <button
            className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${activeView === "wallet" ? "bg-ink text-white" : "hover:bg-field"}`}
            type="button"
            onClick={() => onChange("wallet")}
          >
            Wallet
          </button>
        )}
        {role === "admin" && (
          <button
            className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${activeView === "inventory" ? "bg-ink text-white" : "hover:bg-field"}`}
            type="button"
            onClick={() => onChange("inventory")}
          >
            Inventario
          </button>
        )}
        {role === "admin" && (
          <button
            className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${activeView === "liquidations" ? "bg-ink text-white" : "hover:bg-field"}`}
            type="button"
            onClick={() => onChange("liquidations")}
          >
            Liquidaciones
          </button>
        )}
      </div>
    </nav>
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
  const showUnprintedBadge = !order.labelPrintedAt && printableOrderStatuses.has(order.status);
  const commitOrderState = (nextState: AppState) => {
    setState(nextState);
    const updatedOrder = nextState.orders.find((item) => item.id === order.id);
    if (updatedOrder) {
      void saveFirestoreOrder(updatedOrder);
      if (updatedOrder.status === "delivered" || updatedOrder.status === "failed") {
        void saveFirestoreWalletEntries(entriesForClosedOrder(updatedOrder, nextState));
      }
    }
  };
  const commitClosedOrder = (updatedOrder: Order, walletEntries: WalletEntry[]) => {
    setState({
      ...state,
      orders: state.orders.map((item) => (item.id === updatedOrder.id ? updatedOrder : item)),
      wallet: [...walletEntries, ...state.wallet.filter((entry) => !walletEntries.some((nextEntry) => nextEntry.id === entry.id))]
    });
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

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{order.trackingCode ?? order.shopifyOrderId}</h3>
            <span className={`rounded px-2 py-1 text-xs font-semibold ${statusTone(order)}`}>{statusLabel(order.status)}</span>
            {order.labelPrintedAt ? (
              <span className="rounded bg-mint/10 px-2 py-1 text-xs font-semibold text-mint">rotulo impreso</span>
            ) : (
              showUnprintedBadge && <span className="rounded bg-rust/10 px-2 py-1 text-xs font-semibold text-rust">sin rotulo</span>
            )}
            {order.addressRisk === "review" && (
              <span className="rounded bg-rust/10 px-2 py-1 text-xs font-semibold text-rust">direccion en riesgo</span>
            )}
          </div>
          <p className="truncate text-sm text-black/70">{seller?.name} · {order.customerName}{order.trackingCode ? ` · Ref ${order.shopifyOrderId}` : ""}</p>
          <p className="text-xs font-semibold text-black/50">Creado: {formatDateTime(order.createdAt)}</p>
        </div>
        <p className="shrink-0 text-right text-sm font-bold">{formatCop(order.totalCop)}</p>
      </div>

      <div className="grid gap-1 text-xs text-black/70">
        <p className="flex min-w-0 gap-2"><MapPin className="shrink-0" size={14} /> <span className="truncate">{order.normalizedAddress ?? order.addressRaw}</span></p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1"><Phone size={14} /> {order.customerPhone}</span>
          <span className="inline-flex items-center gap-1"><Truck size={14} /> {driver?.name ?? "Sin lider"}</span>
          {messenger && <span>Mensajero: {messenger.name}</span>}
          <span>{order.paymentMethod.toUpperCase()}</span>
          <span>{order.fulfillmentMode === "warehouse" ? "Bodega" : "Recogida vendedor"}</span>
        </div>
        {(order.pickupPointName || order.pickupAddress) && (
          <p className="flex gap-2"><Store size={14} /> Recoge en: {[order.pickupPointName, order.pickupAddress].filter(Boolean).join(" · ")}</p>
        )}
        {(order.productName || order.sku || order.quantity) && (
          <div className="flex min-w-0 flex-wrap gap-2">
            <Boxes className="shrink-0" size={14} />
            {order.productName && <span className="font-semibold text-ink">{order.productName}</span>}
            {order.sku && <span>SKU {order.sku}</span>}
            {order.quantity && <span className="rounded bg-white px-2 py-0.5 font-semibold text-ink">Cant. {order.quantity}</span>}
          </div>
        )}
        {(order.scheduledDate || order.scheduledWindow) && (
          <p className="flex gap-2"><ClipboardList size={14} /> Entrega: {[order.scheduledDate, order.scheduledWindow].filter(Boolean).join(" · ")}</p>
        )}
        {order.callOutcome === "rescheduled" && order.rescheduledDate && (
          <p className="rounded-md bg-rust/10 px-2 py-1 text-rust">Llamada reprogramada: {order.rescheduledDate}{order.rescheduledWindow ? ` · ${order.rescheduledWindow}` : ""}</p>
        )}
        {order.evidence.length > 0 && <EvidenceSummary evidence={order.evidence} />}
      </div>

      {!compact && (
        <div className="grid gap-2">
          {canPrintLabel && (
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold"
              type="button"
              onClick={async () => {
                await printOrderLabels([order], state, `Rotulo ${order.trackingCode ?? order.shopifyOrderId}`);
                setState(markOrdersLabelsPrinted(state, [order], state.activeRole === "admin" ? "admin" : actorProfileId));
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
          {state.activeRole !== "seller" && order.driverId && ["scheduled", "picked_up", "in_route"].includes(order.status) && !waitingForMessengerAssignment && (
            <CloseOrderControls state={state} order={order} onCommit={commitOrderState} onServerCommit={commitClosedOrder} />
          )}
          {canCancelOrder && (
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-rust/20 bg-rust/10 px-3 py-2 text-sm font-semibold text-rust disabled:opacity-50"
              type="button"
              disabled={cancelBusy}
              onClick={() => void cancelOrderFromCard()}
            >
              <X size={16} />
              {cancelBusy ? "Anulando..." : "Anular pedido"}
            </button>
          )}
          {cancelError && <p className="rounded-md bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{cancelError}</p>}
        </div>
      )}
    </Card>
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
    <div className="grid gap-2 rounded-md border border-black/10 bg-field p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold">Ajuste admin</p>
          <p className="text-xs text-black/60">Modifica producto, recaudo y cantidad antes del cierre operativo.</p>
        </div>
        <button className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Ocultar" : "Editar producto/recaudo"}
        </button>
      </div>
      {expanded && (
        <div className="grid gap-2">
          <input
            className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
            placeholder="Producto"
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
              placeholder="SKU"
              value={sku}
              onChange={(event) => setSku(event.target.value)}
            />
            <input
              className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
              inputMode="numeric"
              placeholder="Recaudo COP"
              value={totalCop}
              onChange={(event) => setTotalCop(event.target.value.replace(/[^\d]/g, ""))}
            />
            <input
              className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
              inputMode="numeric"
              placeholder="Cantidad"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.replace(/[^\d]/g, ""))}
            />
            <button
              className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              type="button"
              disabled={busy || !isDirty}
              onClick={() => void saveAdjustments()}
            >
              {busy ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      )}
      {message && <p className="rounded-md bg-white px-3 py-2 text-xs font-semibold text-black/60">{message}</p>}
    </div>
  );
}

function EvidenceSummary({ evidence }: { evidence: Evidence[] }) {
  const latest = evidence.at(-1);
  const [expanded, setExpanded] = useState(false);
  const visibleEvidence = expanded ? [...evidence].reverse() : latest ? [latest] : [];
  if (!latest) return null;

  return (
    <div className="grid gap-2 rounded-md border border-black/10 bg-field p-2 text-xs text-ink">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-bold">
          <ImageIcon size={15} />
          <span>Novedades y evidencias</span>
        </div>
        {evidence.length > 1 && (
          <button className="focus-ring rounded px-2 py-1 font-semibold text-black/60 hover:bg-white" type="button" onClick={() => setExpanded(!expanded)}>
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
    <div className="grid gap-2 rounded-md border border-lime/40 bg-lime/10 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold">Revisar antes de liberar</p>
          <p className="text-xs text-black/60">Este pedido aun no aparece para transportistas.</p>
        </div>
        <button className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Ocultar edicion" : "Editar datos"}
        </button>
      </div>
      {expanded && (
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Cliente" value={form.customerName} onChange={(event) => update("customerName", event.target.value)} />
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Telefono" value={form.customerPhone} onChange={(event) => update("customerPhone", event.target.value)} />
          </div>
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Direccion" value={form.addressRaw} onChange={(event) => update("addressRaw", event.target.value)} />
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Direccion normalizada opcional" value={form.normalizedAddress} onChange={(event) => update("normalizedAddress", event.target.value)} />
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={form.zoneId} onChange={(event) => update("zoneId", event.target.value)}>
              <option value="">Sin zona asignada</option>
              {state.zones.filter((zone) => zone.active !== false).map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.name}</option>
              ))}
            </select>
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" inputMode="numeric" placeholder="Valor" value={form.totalCop} onChange={(event) => update("totalCop", event.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={form.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value)}>
              <option value="cod">Contraentrega</option>
              <option value="prepaid">Pagado</option>
            </select>
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={form.fulfillmentMode} onChange={(event) => update("fulfillmentMode", event.target.value)}>
              <option value="seller_pickup">Recogida vendedor</option>
              <option value="warehouse">Bodega</option>
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Producto" value={form.productName} onChange={(event) => update("productName", event.target.value)} />
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="SKU" value={form.sku} onChange={(event) => update("sku", event.target.value)} />
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" inputMode="numeric" placeholder="Cantidad" value={form.quantity} onChange={(event) => update("quantity", event.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <button className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" type="button" disabled={busy === "save"} onClick={() => void saveChanges()}>
            {busy === "save" ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      )}
      {message && <p className="rounded-md bg-white px-3 py-2 text-xs text-black/60">{message}</p>}
      <PrimaryActionButton onClick={() => void confirmAfterSave()}>
        {busy === "confirm" ? "Confirmando..." : "Confirmar pedido y liberar a operacion"}
      </PrimaryActionButton>
    </div>
  );
}

function EvidenceItem({ item }: { item: Evidence }) {
  return (
    <div className="grid gap-2 rounded-md bg-white p-2">
      <div className="flex items-start gap-2">
        {item.photoUrl ? (
          <a className="focus-ring block h-16 w-16 shrink-0 overflow-hidden rounded-md border border-black/10 bg-field" href={item.photoUrl} target="_blank" rel="noreferrer" title="Ver evidencia">
            <img className="h-full w-full object-cover" src={item.photoUrl} alt={`Evidencia ${item.photoLabel}`} />
          </a>
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-black/10 bg-field text-black/40">
            <ImageIcon size={20} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-1 font-bold ${item.type === "delivery" ? "bg-mint/15 text-ink" : "bg-rust/10 text-rust"}`}>
              {item.type === "delivery" ? "Entrega" : "Novedad"}
            </span>
            {item.reason && <span className="rounded bg-field px-2 py-1 font-semibold">{item.reason}</span>}
          </div>
          <p className="mt-1 font-semibold text-black/70">{item.photoLabel}</p>
          <p className="text-black/50">{formatDateTime(item.createdAt)}</p>
        </div>
      </div>
      <div className="rounded-md border border-black/10 px-2 py-1.5">
        <p className="font-bold text-black/50">Observacion</p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-snug text-ink">{item.note}</p>
      </div>
      {item.photoUrl ? (
        <div className="flex flex-wrap gap-2">
          <a className="focus-ring inline-flex items-center justify-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold text-ink hover:bg-field" href={item.photoUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={15} />
            Ver imagen
          </a>
          <a className="focus-ring inline-flex items-center justify-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold text-ink hover:bg-field" href={item.photoUrl} download={item.photoLabel} target="_blank" rel="noreferrer">
            <FileDown size={15} />
            Descargar imagen
          </a>
        </div>
      ) : (
        <p className="rounded-md bg-rust/10 px-2 py-1 text-rust">Esta evidencia no tiene foto cargada. Aplica para registros anteriores al nuevo flujo.</p>
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
      <label className="grid gap-1 text-xs font-semibold text-black/60">
        {label}
        <input
          className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink"
          inputMode="numeric"
          pattern="\d{4}-\d{2}-\d{2}"
          placeholder="AAAA-MM-DD"
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^\d-]/g, "").slice(0, 10))}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className="focus-ring rounded-md border border-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-field" type="button" onClick={() => onChange(quickDate(0))}>Hoy</button>
        <button className="focus-ring rounded-md border border-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-field" type="button" onClick={() => onChange(quickDate(1))}>Manana</button>
        <button className="focus-ring rounded-md border border-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-field" type="button" onClick={() => onChange(quickDate(2))}>Pasado manana</button>
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
    <div className="grid gap-2 border-t border-black/10 pt-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${mode === "delivered" ? "bg-mint text-white" : "border border-mint/40 bg-white text-ink"}`}
          type="button"
          onClick={() => setMode(mode === "delivered" ? null : "delivered")}
        >
          Cerrar entregado
        </button>
        <button
          className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${mode === "failed" ? "bg-rust text-white" : "border border-rust/30 bg-white text-rust"}`}
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

  const refresh = () => setItems(readEvidenceQueue());

  useEffect(() => {
    refresh();
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
    if (queued.length === 0 || syncingId) return;
    const item = queued[queued.length - 1];
    setSyncingId(item.id);
    try {
      const file = dataUrlToFile(item.dataUrl, item.fileName, item.fileType);
      const evidence = await uploadEvidenceImage(item.orderId, file);
      const result = await closeFirebaseOrder({
        orderId: item.orderId,
        outcome: item.outcome,
        note: item.note,
        photoLabel: evidence.label,
        photoUrl: evidence.url,
        storagePath: evidence.path,
        reason: item.reason,
        scheduledDate: item.scheduledDate,
        scheduledWindow: item.scheduledWindow
      });
      const remaining = readEvidenceQueue().filter((queuedItem) => queuedItem.id !== item.id);
      writeEvidenceQueue(remaining);
      setState({
        ...state,
        orders: state.orders.map((order) => (order.id === result.order.id ? result.order : order)),
        wallet: [...result.walletEntries, ...state.wallet.filter((entry) => !result.walletEntries.some((nextEntry) => nextEntry.id === entry.id))]
      });
      setItems(remaining);
    } catch (error) {
      const failed = readEvidenceQueue().map((queuedItem) => queuedItem.id === item.id ? { ...queuedItem, error: error instanceof Error ? error.message : "No se pudo sincronizar." } : queuedItem);
      writeEvidenceQueue(failed);
      setItems(failed);
    } finally {
      setSyncingId("");
    }
  }

  if (items.length === 0) return null;
  return (
    <Card className="grid gap-2 border-rust/20">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-bold">Evidencias pendientes</h2>
          <p className="text-sm text-black/60">Se guardaron en este dispositivo por baja senal y se subiran cuando haya conexion.</p>
        </div>
        <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={Boolean(syncingId)} onClick={() => void processQueue()}>
          {syncingId ? "Reintentando..." : "Reintentar"}
        </button>
      </div>
      {items.map((item) => (
        <div key={item.id} className="rounded-md border border-black/10 p-2 text-sm">
          <p className="font-semibold">{item.orderId} · {item.outcome === "delivered" ? "Entrega" : "Novedad"}</p>
          <p className="text-xs text-black/60">{item.fileName} · {formatDateTime(item.createdAt)}</p>
          {item.error && <p className="text-xs font-semibold text-rust">{item.error}</p>}
        </div>
      ))}
    </Card>
  );
}

function EvidenceInput({
  file,
  note,
  onFileChange,
  onNoteChange
}: {
  file: File | null;
  note: string;
  onFileChange: (file: File | null) => void;
  onNoteChange: (note: string) => void;
}) {
  return (
    <>
      <label className="grid gap-1 text-xs font-semibold text-black/60">
        Foto de evidencia
        <input
          className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink"
          type="file"
          accept="image/*"
          required
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        />
        {file && <span className="text-black/50">{file.name}</span>}
      </label>
      <label className="grid gap-1 text-xs font-semibold text-black/60">
        Observacion
        <textarea
          className="focus-ring min-h-20 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink"
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
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid gap-2 rounded-md border border-mint/30 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file || !note.trim()) return;
        setSubmitting(true);
        setError(null);
        void (async () => {
          let evidence: Awaited<ReturnType<typeof uploadEvidenceImage>>;
          try {
            evidence = await uploadEvidenceImage(order.id, file);
          } catch (uploadError) {
            if (firebaseEnabled() && shouldQueueEvidence(uploadError)) {
              await enqueueEvidence({ orderId: order.id, outcome: "delivered", note, file });
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
        <p className="text-xs text-black/60">Carga la foto y deja la observacion antes de cerrar el pedido.</p>
      </div>
      <EvidenceInput file={file} note={note} onFileChange={setFile} onNoteChange={setNote} />
      {error && <p className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
      <button className="focus-ring rounded-md bg-mint px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={!file || !note.trim() || submitting}>
        {submitting ? "Subiendo evidencia..." : "Confirmar entregado"}
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
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [scheduledDate, setScheduledDate] = useState(order.scheduledDate ?? "");
  const [scheduledWindow, setScheduledWindow] = useState(order.scheduledWindow ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isVisitRescheduled = reason === "Cliente reagenda visita";
  const canSubmit = Boolean(file && note.trim() && reason && (!isVisitRescheduled || (isDateInputComplete(scheduledDate) && scheduledWindow)));

  return (
    <form
      className="grid gap-2 rounded-md border border-rust/20 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file || !canSubmit) return;
        setSubmitting(true);
        setError(null);
        void (async () => {
          let evidence: Awaited<ReturnType<typeof uploadEvidenceImage>>;
          try {
            evidence = await uploadEvidenceImage(order.id, file);
          } catch (uploadError) {
            if (firebaseEnabled() && shouldQueueEvidence(uploadError)) {
              await enqueueEvidence({
                orderId: order.id,
                outcome: "failed",
                note,
                reason,
                scheduledDate: isVisitRescheduled ? scheduledDate : undefined,
                scheduledWindow: isVisitRescheduled ? scheduledWindow : undefined,
                file
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
        <p className="text-xs text-black/60">Selecciona el motivo, carga evidencia y deja una observacion clara.</p>
      </div>
      <label className="grid gap-1 text-xs font-semibold text-black/60">
        Motivo
        <select className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink" value={reason} onChange={(event) => setReason(event.target.value)} required>
          <option value="">Seleccionar motivo</option>
          <option value="Cliente no recibe">Cliente no recibe</option>
          <option value="Cliente no responde">Cliente no responde</option>
          <option value="Direccion incorrecta">Direccion incorrecta</option>
          <option value="Cliente reagenda visita">Cliente reagenda visita</option>
          <option value="Otro">Otro</option>
        </select>
      </label>
      {isVisitRescheduled && (
        <div className="grid gap-2 rounded-md bg-field p-3">
          <p className="text-xs font-semibold text-black/60">Nueva visita de entrega</p>
          <DateChoiceField label="Fecha de nueva visita" value={scheduledDate} onChange={setScheduledDate} />
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Franja de nueva visita
            <select className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink" value={scheduledWindow} onChange={(event) => setScheduledWindow(event.target.value)} required>
              <option value="">Seleccionar franja</option>
              {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
            </select>
          </label>
        </div>
      )}
      <EvidenceInput file={file} note={note} onFileChange={setFile} onNoteChange={setNote} />
      {error && <p className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}
      <button className="focus-ring rounded-md bg-rust px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={!canSubmit || submitting}>
        {submitting ? "Subiendo evidencia..." : isVisitRescheduled ? "Guardar visita reagendada" : "Marcar como fallido"}
      </button>
    </form>
  );
}

function PrimaryActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white" type="button" onClick={onClick}>
      {children}
    </button>
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
    <div className="grid gap-2 rounded-md border border-black/10 bg-field p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${mode === "confirm" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
          type="button"
          onClick={() => setMode(mode === "confirm" ? null : "confirm")}
        >
          Cliente confirma entrega
        </button>
        <button
          className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${mode === "reschedule" ? "bg-rust text-white" : "border border-rust/30 bg-white text-rust"}`}
          type="button"
          onClick={() => setMode(mode === "reschedule" ? null : "reschedule")}
        >
          Reprogramar llamada
        </button>
      </div>
      {mode === "confirm" && (
        <div className="grid gap-2 rounded-md border border-black/10 bg-white p-3">
        <div>
          <h3 className="text-sm font-bold">Cliente confirma entrega</h3>
          <p className="text-xs text-black/60">Usa estos campos cuando el cliente ya eligio cuando recibir el pedido.</p>
        </div>
        <DateChoiceField label="Fecha de entrega" value={scheduledDate} onChange={setScheduledDate} />
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Franja de entrega
          <select className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink" value={scheduledWindow} onChange={(event) => setScheduledWindow(event.target.value)}>
            <option value="">Seleccionar franja</option>
            {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
          </select>
        </label>
        {!canConfirm && <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">Selecciona fecha y franja para habilitar la confirmacion.</p>}
        <button
          className="focus-ring min-h-11 w-full rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          type="button"
          disabled={!canConfirm}
          onClick={() => onCommit(confirmDeliveryWindow(state, order.id, scheduledDate, scheduledWindow))}
        >
          Cliente confirma fecha y franja
        </button>
      </div>
      )}
      {mode === "reschedule" && (
        <div className="grid gap-2 rounded-md border border-rust/20 bg-white p-3">
        <div>
          <h3 className="text-sm font-bold text-rust">Reprogramar llamada</h3>
          <p className="text-xs text-black/60">Usa estos campos si no se pudo cerrar la entrega y hay que volver a llamar.</p>
        </div>
        <DateChoiceField label="Fecha para volver a llamar" value={rescheduledDate} onChange={setRescheduledDate} />
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Franja para volver a llamar
          <select
            className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink"
            value={rescheduledWindow}
            onChange={(event) => setRescheduledWindow(event.target.value)}
          >
            <option value="">Seleccionar franja</option>
            {deliveryWindows.map((window) => <option key={window} value={window}>{window}</option>)}
          </select>
        </label>
          {!canReschedule && <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">Selecciona fecha y franja para reprogramar la llamada.</p>}
          <button
            className="focus-ring min-h-11 w-full rounded-md border border-rust/30 bg-white px-3 py-2 text-sm font-semibold text-rust disabled:opacity-50"
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

function OrderLookupBar({ value, onChange }: { value: string; onChange: (value: string) => void }) {
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
    <div className="grid gap-2 rounded-md border border-black/10 bg-white p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="focus-ring min-h-10 flex-1 rounded-md border border-black/10 px-3 py-2 text-sm"
          placeholder="Buscar por KNT, # Shopify, cliente, telefono, SKU"
          value={value}
          onChange={(event) => onChange(extractOrderCode(event.target.value))}
        />
        <button className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white" type="button" onClick={() => void scanQr()}>
          <QrCode size={16} />
          Escanear QR
        </button>
        {value && (
          <button className="focus-ring min-h-10 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold" type="button" onClick={() => onChange("")}>
            Limpiar
          </button>
        )}
      </div>
      {scanning && (
        <div className="grid gap-2 rounded-md border border-black/10 bg-ink p-2 text-white">
          <div className="relative overflow-hidden rounded bg-black">
            <video ref={videoRef} className="h-64 w-full object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-lime" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold">Apunta la camara al QR del rotulo.</p>
            <button className="focus-ring rounded-md bg-white px-3 py-2 text-xs font-semibold text-ink" type="button" onClick={stopQrScan}>
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
  const selectedOrders = selectedIds.map((id) => eligibleOrders.find((order) => order.id === id)).filter(Boolean) as Order[];

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

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
    if (!value) {
      setMessage("Escanea o escribe un codigo antes de agregar.");
      return;
    }
    const order = findEligibleOrder(value);
    if (!order) {
      setMessage(`No encontre pedido disponible para ${value}.`);
      return;
    }
    if (selectedIdsRef.current.includes(order.id)) {
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
      <div className="grid max-h-[92vh] w-full max-w-2xl gap-3 overflow-auto rounded-lg bg-white p-4 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Recogida por escaneo</h2>
            <p className="text-sm text-black/60">Deja la camara abierta y pistolea los rotulos de corrido. Se agregan a esta recogida y luego el lider decide a que mensajero asignarlos.</p>
          </div>
          <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold" type="button" onClick={() => { stopQrScan(); onClose(); }}>
            Cerrar
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            className="focus-ring min-h-10 rounded-md border border-black/10 px-3 py-2 text-sm"
            placeholder="KNT, # Shopify o QR"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addCode(code);
            }}
          />
          <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold" type="button" onClick={() => addCode(code)}>
            Agregar
          </button>
          <button
            className="focus-ring inline-flex items-center justify-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            type="button"
            disabled={scanning}
            onClick={() => void scanQr()}
          >
            <QrCode size={16} />
            {scanning ? "Escaneando" : "Escanear"}
          </button>
        </div>
        {scanning && (
          <div className="grid gap-2 rounded-md border border-black/10 bg-ink p-2 text-white">
            <div className="relative overflow-hidden rounded bg-black">
              <video ref={videoRef} className="h-64 w-full object-cover" muted playsInline />
              <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-lime" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Pistolea varios rotulos sin cerrar esta ventana.</p>
              <button className="focus-ring rounded-md bg-white px-3 py-2 text-xs font-semibold text-ink" type="button" onClick={stopQrScan}>
                Cerrar camara
              </button>
            </div>
          </div>
        )}
        {message && <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/70">{message}</p>}
        <div className="grid gap-2">
          <p className="text-sm font-bold">Escaneados ({selectedOrders.length})</p>
          {selectedOrders.length === 0 && <p className="rounded-md bg-field px-3 py-2 text-sm text-black/60">Aun no hay pedidos escaneados.</p>}
          {selectedOrders.map((order) => (
            <div key={order.id} className="flex items-start justify-between gap-3 rounded-md border border-black/10 p-3 text-sm">
              <div>
                <p className="font-semibold">{order.trackingCode ?? order.shopifyOrderId}</p>
                <p className="text-xs text-black/60">{order.customerName} · {order.productName ?? order.sku}</p>
              </div>
              <button className="text-xs font-semibold text-rust" type="button" onClick={() => setSelectedIds((current) => current.filter((id) => id !== order.id))}>
                Quitar
              </button>
            </div>
          ))}
        </div>
        <button
          className="focus-ring min-h-11 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
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

function AdminView({ state, setState, onNavigate, orderSearch, onOrderSearchChange, startDate, endDate, statusFilter, sellerFilter, onStartDate, onEndDate, onStatusFilter, onSellerFilter }: { state: AppState; setState: (state: AppState) => void; onNavigate: (view: AppView) => void; orderSearch: string; onOrderSearchChange: (value: string) => void; startDate: string; endDate: string; statusFilter: string; sellerFilter: string; onStartDate: (value: string) => void; onEndDate: (value: string) => void; onStatusFilter: (value: string) => void; onSellerFilter: (value: string) => void }) {
  const [adminOrderTab, setAdminOrderTab] = useState<"operation" | "failed">("operation");
  const sellerFilteredOrders = sellerFilter === "all" ? state.orders : state.orders.filter((order) => order.sellerId === sellerFilter);
  const rangeOrders = filterOrdersByRangeStatus(sellerFilteredOrders, startDate, endDate, "all", "");
  const pending = rangeOrders.filter((order) => !["delivered", "failed", "cancelled"].includes(order.status));
  const failed = rangeOrders.filter((order) => order.status === "failed");
  const review = rangeOrders.filter((order) => order.addressRisk === "review");
  const callRescheduled = rangeOrders.filter((order) => order.callOutcome === "rescheduled");
  const deliveryScheduled = rangeOrders.filter((order) => order.status === "scheduled");
  const sellerBalances = state.sellers.map((seller) => ({ seller, balance: sellerBalance(state, seller.id) }));
  const pendingShopifyRequests = (state.shopifyInstallRequests ?? []).filter((request) => request.status === "requested");
  const warehouseLabelOrders = state.orders.filter(canPrintAdminWarehouseLabel);
  const pendingWarehouseLabelOrders = warehouseLabelOrders.filter((order) => !order.labelPrintedAt);
  const unprintedOrders = sellerFilteredOrders.filter((order) => printableOrderStatuses.has(order.status) && !order.labelPrintedAt);
  const pickupReadyOrders = sellerFilteredOrders.filter((order) =>
    (order.status === "ready_to_assign" && !order.driverId) ||
    order.status === "assigned"
  );
  const failedOrders = sellerFilteredOrders.filter((order) => order.status === "failed");
  const operationOrders = sellerFilteredOrders.filter((order) => order.status !== "failed");
  const tabOrders = adminOrderTab === "failed" ? failedOrders : operationOrders;
  const visibleOrders = filterOrdersByRangeStatus(tabOrders, startDate, endDate, statusFilter, orderSearch);
  const reprintableVisibleOrders = visibleOrders.filter((order) => Boolean(order.labelPrintedAt));
  const exportableFailedOrders = filterOrdersByRangeStatus(failedOrders, startDate, endDate, statusFilter, orderSearch);
  const alerts = [
    ...review.map((order) => `Direccion en revision ${order.shopifyOrderId}`),
    ...failed.filter((order) => order.retryDecision === "pending").map((order) => `Reintento pendiente ${order.shopifyOrderId}`),
    ...pendingShopifyRequests.map((request) => `Solicitud Shopify ${request.shopDomain}`),
    ...state.sellers.filter((seller) => seller.debtBlockedAt).map((seller) => `${seller.name} bloqueado por deuda`)
  ];

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h2 className="text-xl font-bold">Dashboard administrador</h2>
        <button
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white"
          type="button"
          onClick={() => onNavigate("liquidations")}
        >
          <CreditCard size={16} />
          Ver liquidaciones
        </button>
      </div>
      <LogisticsKpis orders={rangeOrders} />
      <div className="grid gap-3 lg:grid-cols-2">
        <AdminOperationalSummary
          title="Pedidos sin imprimir"
          orders={unprintedOrders}
          sellers={state.sellers}
          icon={<Printer size={18} />}
          empty="No hay pedidos pendientes de rotulo."
          actionLabel={`Imprimir pendientes (${unprintedOrders.length})`}
          onAction={async () => {
            await printOrderLabels(unprintedOrders, state, "Rotulos pendientes");
            setState(markOrdersLabelsPrinted(state, unprintedOrders, "admin"));
          }}
        />
        <AdminOperationalSummary
          title="Pendientes recogida domiciliario"
          orders={pickupReadyOrders}
          sellers={state.sellers}
          icon={<Truck size={18} />}
          empty="No hay pedidos esperando recogida."
          helper="Incluye listos sin lider y asignados a lider que aun no han sido recogidos."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <section className="grid content-start gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-base font-bold">Operacion en vivo</h2>
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
              type="button"
              disabled={pendingWarehouseLabelOrders.length === 0}
              onClick={async () => {
                await printOrderLabels(pendingWarehouseLabelOrders, state, "Rotulos bodega pendientes");
                setState(markOrdersLabelsPrinted(state, pendingWarehouseLabelOrders, "admin"));
              }}
            >
              <Printer size={16} />
              Rotulos pendientes ({pendingWarehouseLabelOrders.length})
            </button>
          </div>
          <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <button
                className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${adminOrderTab === "operation" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
                type="button"
                onClick={() => setAdminOrderTab("operation")}
              >
                Operacion ({operationOrders.length})
              </button>
              <button
                className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${adminOrderTab === "failed" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
                type="button"
                onClick={() => setAdminOrderTab("failed")}
              >
                Fallidos / reintento ({failedOrders.length})
              </button>
            </div>
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
              type="button"
              disabled={exportableFailedOrders.length === 0}
              onClick={() => downloadFailedOrdersCsv(exportableFailedOrders, state, startDate, endDate, sellerFilter)}
            >
              <FileDown size={16} />
              Descargar fallidos ({exportableFailedOrders.length})
            </button>
          </div>
          <OrderFilters startDate={startDate} endDate={endDate} status={statusFilter} sellers={state.sellers} sellerFilter={sellerFilter} onStartDate={onStartDate} onEndDate={onEndDate} onStatus={onStatusFilter} onSeller={onSellerFilter} />
          <button
            className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
            type="button"
            disabled={reprintableVisibleOrders.length === 0}
            onClick={async () => {
              await printOrderLabels(reprintableVisibleOrders, state, "Reimpresion de rotulos");
              setState(markOrdersLabelsPrinted(state, reprintableVisibleOrders, "admin"));
            }}
          >
            <Printer size={16} />
            Reimprimir rotulos visibles ({reprintableVisibleOrders.length})
          </button>
          {(callRescheduled.length > 0 || deliveryScheduled.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {callRescheduled.length > 0 && (
                <span className="rounded-md bg-rust/10 px-3 py-2 text-sm font-semibold text-rust">
                  {callRescheduled.length} llamadas reprogramadas
                </span>
              )}
              {deliveryScheduled.length > 0 && (
                <span className="rounded-md bg-field px-3 py-2 text-sm font-semibold">
                  {deliveryScheduled.length} entregas agendadas
                </span>
              )}
            </div>
          )}
          <PaginatedList
            items={visibleOrders}
            pageSize={12}
            className="grid content-start gap-2 md:grid-cols-2"
            empty={<EmptyRoleState title={adminOrderTab === "failed" ? "Sin fallidos pendientes" : "Sin pedidos"} message={adminOrderTab === "failed" ? "Los pedidos fallidos apareceran aqui para confirmar si van a nuevo reintento." : "Los pedidos reales apareceran cuando conectemos Shopify y entren webhooks de tiendas autorizadas."} />}
          >
            {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} />}
          </PaginatedList>
        </section>

        <aside className="grid content-start gap-4">
          <Card>
            <h2 className="mb-3 font-bold">Alertas internas</h2>
            <PaginatedList items={alerts} pageSize={5} empty={<p className="text-sm text-black/60">No hay alertas internas.</p>}>
              {(alert) => <p key={alert} className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">{alert}</p>}
            </PaginatedList>
          </Card>
          <ManualOrderPanel state={state} setState={setState} />
          <ShopifyStoresAdminPanel state={state} setState={setState} />
          <ShopifyImportOrderPanel
            stores={state.shopifyStores ?? []}
            sellers={state.sellers}
            onImported={(order) => setState({ ...state, orders: [order, ...state.orders.filter((item) => item.id !== order.id)] })}
          />
          <ShopifySyncIssuesPanel issues={state.shopifySyncIssues ?? []} sellers={state.sellers} />
          <ShopifyInstallRequestsPanel state={state} setState={setState} />
          <SellerPickupPointsPanel state={state} setState={setState} />
          <Card>
            <h2 className="mb-3 font-bold">Lideres logisticos</h2>
            <PaginatedList items={state.drivers} pageSize={6} empty={<p className="text-sm text-black/60">No hay transportistas registrados.</p>}>
              {(driver) => {
                const rate = weeklyFailedRate(state, driver.id);
                return (
                  <div key={driver.id} className="rounded-md border border-black/10 p-3">
                    <p className="font-semibold">{driver.name}</p>
                    <p className="text-sm text-black/60">Fallidos 7 dias: {rate.rate}% ({rate.failed}/{rate.total})</p>
                  </div>
                );
              }}
            </PaginatedList>
          </Card>
          <ZonesTariffsPanel state={state} setState={setState} />
          <WalletPanel state={state} setState={setState} />
          <AdminUsersPanel state={state} setState={setState} />
        </aside>
      </div>
    </main>
  );
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
  const [productId, setProductId] = useState("");
  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [addressRisk, setAddressRisk] = useState<"accepted" | "review">("accepted");
  const [message, setMessage] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);

  useEffect(() => {
    if (lockedSellerId && sellerId !== lockedSellerId) setSellerId(lockedSellerId);
    else if (!sellerId && state.sellers[0]) setSellerId(state.sellers[0].id);
  }, [lockedSellerId, sellerId, state.sellers]);

  const selectedSeller = state.sellers.find((seller) => seller.id === sellerId);
  const sellerZones = state.zones.filter((zone) => zone.cityId === (selectedSeller?.cityId ?? state.settings.activeCityId) && zone.active !== false);
  const selectedZone = sellerZones.find((zone) => zone.id === zoneId);
  const sellerInventory = state.inventory.filter((item) => item.sellerId === sellerId);
  const availableSellerInventory = sellerInventory.filter((item) => item.available - item.reserved > 0);
  const selectedProduct = sellerInventory.find((item) => item.id === productId);
  const normalizedSellerReference = normalizeSellerReference(shopifyOrderId);
  const duplicateSellerReference = normalizedSellerReference
    ? state.orders.find((order) => order.sellerId === sellerId && normalizeSellerReference(order.shopifyOrderId) === normalizedSellerReference)
    : undefined;

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
            setSubmittingOrder(true);
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
                productName: selectedProduct?.name ?? productName,
                sku: selectedProduct?.sku ?? sku,
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
              setProductId("");
              setProductName("");
              setSku("");
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
          <div className="rounded-md border border-black/10 bg-field px-3 py-2 text-sm font-semibold">
            {selectedSeller?.name ?? "Vendedor"}
          </div>
        ) : (
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)} required>
            <option value="">Vendedor</option>
            {state.sellers.map((seller) => (
              <option key={seller.id} value={seller.id}>{seller.name}</option>
            ))}
          </select>
        )}
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Referencia vendedor opcional
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" placeholder="Ej: QA-P1-DUP-001" value={shopifyOrderId} onChange={(event) => setShopifyOrderId(event.target.value)} />
        </label>
        {duplicateSellerReference && (
          <p className="rounded-md bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">
            Ya existe la referencia {normalizedSellerReference}. No se puede crear otro pedido con la misma referencia.
          </p>
        )}
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Cliente" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Telefono" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} required />
        <textarea className="focus-ring min-h-20 rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Direccion original" value={addressRaw} onChange={(event) => setAddressRaw(event.target.value)} required />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Direccion normalizada opcional" value={normalizedAddress} onChange={(event) => setNormalizedAddress(event.target.value)} />
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
            <option value="">Zona sin asignar</option>
            {sellerZones.map((zone) => (
              <option key={zone.id} value={zone.id}>{zone.name}</option>
            ))}
          </select>
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={addressRisk} onChange={(event) => setAddressRisk(event.target.value as "accepted" | "review")}>
            <option value="accepted">Direccion aceptada</option>
            <option value="review">Revisar direccion</option>
          </select>
        </div>
        {selectedZone && (
          <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">
            {sellerId === "seller-1779315416119"
              ? `Tarifa DANDA: cobro entregado ${formatCop(12000)} · pago domiciliario actual ${formatCop(11000)} para recogidos desde 09/06/2026 · fallido ${formatCop(0)}`
              : `Tarifa zona ${selectedZone.name}: vendedor entregado ${formatCop(selectedZone.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop)} · transportista entregado ${formatCop(selectedZone.driverDeliveredPayCop || state.settings.driverDeliveredPayCop)}`}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as "cod" | "prepaid")}>
            <option value="cod">Contraentrega</option>
            <option value="prepaid">Pagado</option>
          </select>
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={fulfillmentMode} onChange={(event) => setFulfillmentMode(event.target.value as "seller_pickup" | "warehouse")}>
            <option value="seller_pickup">Recogida vendedor</option>
            <option value="warehouse">Bodega</option>
          </select>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Valor COP" inputMode="numeric" value={totalCop} onChange={(event) => setTotalCop(event.target.value)} required />
          {sellerInventory.length > 0 ? (
            <select
              className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">Producto opcional</option>
              {availableSellerInventory.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.sku} · {item.available - item.reserved} libres</option>
              ))}
            </select>
          ) : (
            <input
              className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
              placeholder="Producto"
              value={productName}
              onChange={(event) => setProductName(event.target.value)}
            />
          )}
        </div>
        {sellerInventory.length === 0 && (
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="SKU opcional" value={sku} onChange={(event) => setSku(event.target.value)} />
        )}
        {sellerInventory.length > 0 && availableSellerInventory.length === 0 && (
          <p className="rounded-md bg-rust/10 px-3 py-2 text-xs text-rust">No hay productos con stock libre para este vendedor.</p>
        )}
        {selectedProduct && (
          <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">
            Libre: {selectedProduct.available - selectedProduct.reserved} · Stock: {selectedProduct.available} · Reservado: {selectedProduct.reserved}
          </p>
        )}
        <button className="focus-ring min-h-10 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={state.sellers.length === 0 || submittingOrder || Boolean(duplicateSellerReference)}>
          {submittingOrder ? "Creando pedido..." : "Crear pedido"}
        </button>
      </form>
      {message && <p className="mt-2 rounded-md bg-field px-3 py-2 text-sm text-black/70">{message}</p>}
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
        <p className="text-sm text-black/60">Direccion que vera el lider y el mensajero para agrupar rutas.</p>
      </div>
      <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
        {state.sellers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Nombre del punto" value={name} onChange={(event) => setName(event.target.value)} />
      <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Direccion de recogida" value={address} onChange={(event) => setAddress(event.target.value)} />
      <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Contacto" value={contact} onChange={(event) => setContact(event.target.value)} />
      <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Telefono contacto" value={phone} onChange={(event) => setPhone(event.target.value)} />
      <textarea className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Notas de recogida" value={notes} onChange={(event) => setNotes(event.target.value)} />
      <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!seller} onClick={() => void savePickupPoint()}>
        Guardar punto
      </button>
      {message && <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/70">{message}</p>}
    </Card>
  );
}

function AdminUsersPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("seller");
  const [leaderDriverId, setLeaderDriverId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const accounts = readAccounts();

  return (
    <Card>
      <h2 className="mb-3 font-bold">Usuarios y accesos</h2>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitting(true);
          void createUserFromAdmin(state, { name, email, password, role, leaderDriverId })
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
          setMessage(`Cuenta ${roleLabel(result.account.role)} lista para ${result.account.email}`);
            })
            .finally(() => setSubmitting(false));
        }}
      >
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Nombre" value={name} onChange={(event) => setName(event.target.value)} required />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Contrasena temporal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} />
        <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={role} onChange={(event) => setRole(event.target.value as Role)}>
          <option value="seller">Vendedor</option>
          <option value="driver">Lider logistico</option>
          <option value="messenger">Mensajero</option>
          <option value="admin">Administrador</option>
        </select>
        {role === "messenger" && (
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={leaderDriverId} onChange={(event) => setLeaderDriverId(event.target.value)} required>
            <option value="">Selecciona lider logistico</option>
            {state.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
          </select>
        )}
        <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={submitting}>Crear usuario</button>
      </form>
      {message && <p className="mt-2 rounded-md bg-field px-3 py-2 text-sm text-black/70">{message}</p>}
      <div className="mt-4 grid gap-2">
        <h3 className="text-sm font-bold">Cuentas locales</h3>
        {accounts.length === 0 && <p className="text-sm text-black/60">No hay cuentas creadas.</p>}
        {accounts.map((account) => (
          <div key={account.id} className="rounded-md border border-black/10 p-2 text-sm">
            <p className="font-semibold">{account.name}</p>
            <p className="text-black/60">{account.email} · {roleLabel(account.role)}</p>
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
        {editingZoneId && <p className="rounded-md bg-field px-3 py-2 text-sm font-semibold">Editando zona seleccionada</p>}
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Nombre de zona
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" placeholder="Ej. Sur Cali" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Barrios o referencia
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" placeholder="Ej. Ciudad Jardin, Valle del Lili, Caney" value={polygonLabel} onChange={(event) => setPolygonLabel(event.target.value)} />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Cobro al vendedor por entrega
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={sellerDeliveredFeeCop} onChange={(event) => setSellerDeliveredFeeCop(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Cobro al vendedor por fallido
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={sellerFailedFeeCop} onChange={(event) => setSellerFailedFeeCop(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Pago al transportista por entrega
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={driverDeliveredPayCop} onChange={(event) => setDriverDeliveredPayCop(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Pago al transportista por fallido
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={driverFailedPayCop} onChange={(event) => setDriverFailedPayCop(event.target.value)} />
          </label>
        </div>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Cobro adicional por bodega / fulfillment
          <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={fulfillmentFeeCop} onChange={(event) => setFulfillmentFeeCop(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={saving} onClick={() => upsertZone()}>
            {saving ? "Guardando..." : editingZoneId ? "Guardar cambios" : "Crear zona"}
          </button>
          {editingZoneId && (
            <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={resetForm}>
              Cancelar
            </button>
          )}
        </div>
      </div>
      {message && <p className="mt-2 rounded-md bg-field px-3 py-2 text-sm text-black/70">{message}</p>}
      <div className="mt-4 grid gap-2">
        {zones.length === 0 && <p className="text-sm text-black/60">No hay zonas creadas.</p>}
        {zones.map((zone) => (
          <div key={zone.id} className="rounded-md border border-black/10 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{zone.name}</p>
                <p className="text-black/60">{zone.polygonLabel}</p>
              </div>
              <span className={`rounded-md px-2 py-1 text-xs font-semibold ${zone.active === false ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                {zone.active === false ? "inactiva" : "activa"}
              </span>
            </div>
            <p className="mt-2 text-xs text-black/60">
              Vendedor {formatCop(zone.sellerDeliveredFeeCop || state.settings.sellerDeliveredFeeCop)} / {formatCop(zone.sellerFailedFeeCop || state.settings.sellerFailedFeeCop)} · Driver {formatCop(zone.driverDeliveredPayCop || state.settings.driverDeliveredPayCop)} / {formatCop(zone.driverFailedPayCop || state.settings.driverFailedPayCop)}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="focus-ring rounded-md border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-field disabled:opacity-50" type="button" disabled={saving} onClick={() => loadZone(zone.id)}>Editar</button>
              <button className="focus-ring rounded-md border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-field disabled:opacity-50" type="button" disabled={saving} onClick={() => toggleZone(zone.id)}>{zone.active === false ? "Activar" : "Desactivar"}</button>
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
            <p key={item.id} className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">
              Bajo stock: {item.name} · {item.available - item.reserved} disponibles
            </p>
          ))}
        </div>
      )}
      <div className="grid gap-2">
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Vendedor
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
            <option value="">Seleccionar vendedor</option>
            {state.sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select>
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            SKU
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" value={sku} onChange={(event) => setSku(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Producto
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Stock fisico total
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={available} onChange={(event) => setAvailable(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Reservado por pedidos abiertos
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink disabled:bg-field disabled:text-black/50" disabled={!editingId} inputMode="numeric" value={editingId ? reserved : "0"} onChange={(event) => setReserved(event.target.value)} />
            <span className="text-[11px] font-normal text-black/50">{editingId ? "Solo ajustar para corregir reservas reales." : "Al crear producto inicia en 0; los pedidos lo aumentan automaticamente."}</span>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Minimo alerta
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" inputMode="numeric" value={minStock} onChange={(event) => setMinStock(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Ubicacion bodega
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" value={location} onChange={(event) => setLocation(event.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={saving} onClick={save}>{saving ? "Guardando..." : editingId ? "Guardar producto" : "Crear producto"}</button>
          {editingId && <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={reset}>Cancelar</button>}
        </div>
      </div>
      {message && <p className="mt-2 rounded-md bg-field px-3 py-2 text-sm text-black/70">{message}</p>}
      <div className="mt-4">
        <PaginatedList items={state.inventory} pageSize={10} empty={<p className="text-sm text-black/60">No hay productos registrados.</p>}>
          {(item) => {
          const seller = state.sellers.find((entry) => entry.id === item.sellerId);
          const free = item.available - item.reserved;
          return (
            <div key={item.id} className="rounded-md border border-black/10 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{item.name}</p>
                  <p className="text-black/60">{item.sku} · {seller?.name ?? item.sellerId}</p>
                  {item.location && <p className="text-xs text-black/50">Ubicacion: {item.location}</p>}
                </div>
                <p className={`text-right font-bold ${free <= (item.minStock ?? 0) ? "text-rust" : "text-mint"}`}>{free} disponibles</p>
              </div>
              <p className="mt-2 text-xs text-black/60">Stock fisico {item.available} · Reservado por pedidos {item.reserved} · Minimo {item.minStock ?? 0}</p>
              <button className="focus-ring mt-2 rounded-md border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-field" type="button" onClick={() => load(item)}>Editar</button>
            </div>
          );
        }}
        </PaginatedList>
      </div>
    </Card>
  );
}

function reconcileInventoryReservationsLocal(state: AppState): AppState {
  const closedStatuses = new Set(["delivered", "failed", "cancelled", "liquidated"]);
  const reservedByItem = new Map<string, number>();
  state.orders.forEach((order) => {
    if (!order.sku || closedStatuses.has(order.status)) return;
    const key = `${order.sellerId}::${order.sku.trim().toUpperCase()}`;
    reservedByItem.set(key, (reservedByItem.get(key) ?? 0) + 1);
  });
  return {
    ...state,
    inventory: state.inventory.map((item) => ({
      ...item,
      reserved: reservedByItem.get(`${item.sellerId}::${item.sku.trim().toUpperCase()}`) ?? 0
    }))
  };
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
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Inventario</h2>
          <p className="text-sm text-black/60">Control de stock, reservas y ubicaciones de bodega.</p>
        </div>
        <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-field disabled:opacity-50" disabled={reconciling} type="button" onClick={reconcile}>
          {reconciling ? "Recalculando..." : "Recalcular reservas"}
        </button>
      </div>
      {message && <p className="rounded-md bg-field px-3 py-2 text-sm text-black/70">{message}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Boxes size={20} />} label="Stock total" value={String(totalAvailable)} />
        <Metric icon={<ClipboardList size={20} />} label="Reservado" value={String(totalReserved)} />
        <Metric icon={<AlertTriangle size={20} />} label="Bajo stock" value={String(lowStock)} />
      </div>
      <AdminInventoryPanel state={state} setState={setState} />
    </main>
  );
}

function WalletPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  return (
    <Card>
      <h2 className="mb-3 font-bold">Wallets vendedores</h2>
      <PaginatedList items={state.sellers} pageSize={6} className="grid gap-3" empty={<p className="text-sm text-black/60">No hay vendedores registrados todavia.</p>}>
        {(seller) => {
          const balance = sellerBalance(state, seller.id);
          return (
            <div key={seller.id} className="rounded-md border border-black/10 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{seller.name}</p>
                  <p className="text-sm text-black/60">Reserva: {formatCop(balance.reservedCop)} · {balance.pendingOrders} pendientes</p>
                </div>
                <p className="text-right font-bold">{formatCop(balance.availableCop)}</p>
              </div>
              {state.activeRole === "seller" && (
                <button className="focus-ring mt-3 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white" onClick={() => setState(requestPayout(state, seller.id))}>
                  Solicitar liquidacion automatica
                </button>
              )}
            </div>
          );
        }}
      </PaginatedList>
      {state.payouts.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-bold">Solicitudes</h3>
          <PaginatedList items={state.payouts} pageSize={5} className="mt-2 grid gap-2" empty={null}>
            {(payout) => (
              <div key={payout.id} className="flex items-center justify-between rounded-md bg-field p-2 text-sm">
                <span>{formatCop(payout.amountCop)} · {payout.status}</span>
                {state.activeRole === "admin" && payout.status === "requested" && (
                  <button className="font-semibold text-mint" onClick={() => setState(approvePayout(state, payout.id))}>Pagar</button>
                )}
              </div>
            )}
          </PaginatedList>
        </div>
      )}
    </Card>
  );
}

function DashboardWalletCard({ state, ownerType, ownerId, title }: { state: AppState; ownerType: WalletEntry["ownerType"]; ownerId: string; title: string }) {
  const entries = state.wallet
    .filter((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const balance = entries.reduce((sum, entry) => sum + entry.amountCop, 0);
  const income = entries.filter((entry) => entry.amountCop > 0).reduce((sum, entry) => sum + entry.amountCop, 0);
  const charges = Math.abs(entries.filter((entry) => entry.amountCop < 0).reduce((sum, entry) => sum + entry.amountCop, 0));

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">{title}</h2>
          <p className="text-sm text-black/60">{entries.length} movimientos registrados</p>
        </div>
        <p className={`text-right text-lg font-bold ${balance < 0 ? "text-rust" : "text-mint"}`}>{formatCop(balance)}</p>
      </div>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-md bg-field px-3 py-2">
          <p className="text-xs font-semibold text-black/50">Entradas</p>
          <p className="font-bold">{formatCop(income)}</p>
        </div>
        <div className="rounded-md bg-field px-3 py-2">
          <p className="text-xs font-semibold text-black/50">Descuentos</p>
          <p className="font-bold">{formatCop(charges)}</p>
        </div>
      </div>
      <PaginatedList items={entries.slice(0, 5)} pageSize={5} empty={<p className="text-sm text-black/60">Aun no hay movimientos de wallet para este usuario.</p>}>
        {(entry) => <WalletEntryRow key={entry.id} entry={entry} state={state} showOwner={false} />}
      </PaginatedList>
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
  const entries = (entriesOverride ?? state.wallet.filter((entry) => (!ownerType || entry.ownerType === ownerType) && (!ownerId || entry.ownerId === ownerId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const balance = entries.reduce((sum, entry) => sum + entry.amountCop, 0);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold">{title}</h2>
          <p className="text-sm text-black/60">{entries.length} movimientos</p>
        </div>
        <p className={`text-right font-bold ${balance < 0 ? "text-rust" : "text-mint"}`}>{formatCop(balance)}</p>
      </div>
      <PaginatedList items={entries} pageSize={10} empty={<p className="text-sm text-black/60">No hay movimientos registrados todavia.</p>}>
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
    <div className="rounded-md border border-black/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{entry.description}</p>
          <p className="text-black/60">
            {new Date(entry.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}
            {order ? ` · Pedido ${order.shopifyOrderId}` : ""}
            {showOwner ? ` · ${owner ?? entry.ownerId}` : ""}
          </p>
        </div>
        <p className={`font-bold ${entry.amountCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(entry.amountCop)}</p>
      </div>
    </div>
  );
}

function WalletPage({ state, session }: { state: AppState; session: Session }) {
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const visibleEntries = state.wallet
    .filter((entry) => {
      if (session.role === "seller") return entry.ownerType === "seller" && entry.ownerId === session.profileId;
      if (session.role === "driver") return entry.ownerType === "driver" && entry.ownerId === session.profileId;
      if (ownerFilter !== "all" && `${entry.ownerType}:${entry.ownerId}` !== ownerFilter) return false;
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const balance = visibleEntries.reduce((sum, entry) => sum + entry.amountCop, 0);
  const ownerOptions = [
    { value: "admin:platform", label: "Admin · Plataforma" },
    ...state.sellers.map((seller) => ({ value: `seller:${seller.id}`, label: `Vendedor · ${seller.name}` })),
    ...state.drivers.map((driver) => ({ value: `driver:${driver.id}`, label: `Transportista · ${driver.name}` }))
  ];
  const movementTypes = Array.from(new Set(state.wallet.map((entry) => entry.type))).sort();

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-bold">Wallet</h2>
          <p className="text-sm text-black/60">Historial de movimientos, saldos y cargos por pedido.</p>
        </div>
        <div className="grid gap-1 rounded-md border border-black/10 bg-white px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-normal text-black/50">Balance visible</span>
          <span className={`text-xl font-bold ${balance < 0 ? "text-rust" : "text-mint"}`}>{formatCop(balance)}</span>
        </div>
      </div>

      {session.role === "admin" && (
        <Card>
          <div className="grid gap-2 md:grid-cols-2">
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="all">Todos los usuarios</option>
              {ownerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">Todos los tipos</option>
              {movementTypes.map((type) => (
                <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
              ))}
            </select>
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Wallet size={20} />} label="Movimientos" value={String(visibleEntries.length)} />
        <Metric icon={<CreditCard size={20} />} label="Entradas" value={formatCop(visibleEntries.filter((entry) => entry.amountCop > 0).reduce((sum, entry) => sum + entry.amountCop, 0))} />
        <Metric icon={<AlertTriangle size={20} />} label="Descuentos" value={formatCop(Math.abs(visibleEntries.filter((entry) => entry.amountCop < 0).reduce((sum, entry) => sum + entry.amountCop, 0)))} />
      </div>

      <WalletHistoryPanel state={state} title="Historial de movimientos" ownerType={session.role === "seller" ? "seller" : session.role === "driver" ? "driver" : undefined} ownerId={session.role === "admin" ? undefined : session.profileId} entriesOverride={visibleEntries} />
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
  codCop: number;
  feesCop: number;
  deliveryFeeCop: number;
  failedFeeCop: number;
  fulfillmentCop: number;
  earningsCop: number;
  deliveredPayCop: number;
  failedPayCop: number;
  platformMarginCop: number;
  cashToReturnCop: number;
  receivableCop: number;
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
  paymentMethod: PaymentMethod;
  codCop: number;
  deliveryFeeCop: number;
  failedFeeCop: number;
  fulfillmentCop: number;
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
    failed: orders.filter((order) => order.status === "failed").length
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

function entriesForOrder(wallet: WalletEntry[], orderId: string) {
  return wallet.filter((entry) => entry.orderId === orderId);
}

function netAmountCop(entries: WalletEntry[], types: WalletEntry["type"][]) {
  return entries.filter((entry) => types.includes(entry.type)).reduce((sum, entry) => sum + entry.amountCop, 0);
}

function netChargeCop(entries: WalletEntry[], types: WalletEntry["type"][]) {
  const net = entries.filter((entry) => types.includes(entry.type)).reduce((sum, entry) => sum + entry.amountCop, 0);
  return Math.max(0, -net);
}

function receivedDriverOrderIds(settlements: Settlement[]) {
  const orderIds = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver") continue;
    if (settlement.status !== "paid" && settlement.status !== "reconciled") continue;
    for (const orderId of settlement.orderIds) orderIds.add(orderId);
  }
  return orderIds;
}

function buildLiquidationOrderAudits(state: AppState, entries: WalletEntry[] = state.wallet): LiquidationOrderAudit[] {
  const orderIds = new Set(entries.map((entry) => entry.orderId).filter(Boolean) as string[]);
  const codReceivedOrderIds = receivedDriverOrderIds(state.settlements);
  return state.orders
    .filter((order) => orderIds.has(order.id) && (order.status === "delivered" || order.status === "failed"))
    .map((order) => {
      const seller = state.sellers.find((item) => item.id === order.sellerId);
      const driver = state.drivers.find((item) => item.id === order.driverId);
      const allOrderEntries = entriesForOrder(entries, order.id);
      const sellerEntries = allOrderEntries.filter((entry) => entry.ownerType === "seller");
      const driverEntries = allOrderEntries.filter((entry) => entry.ownerType === "driver");
      const codCop = netAmountCop(sellerEntries, ["cod_revenue"]);
      const deliveryFeeCop = netChargeCop(sellerEntries, ["delivery_fee"]);
      const failedFeeCop = netChargeCop(sellerEntries, ["failed_fee"]);
      const fulfillmentCop = netChargeCop(sellerEntries, ["fulfillment_fee"]);
      const storeChargeCop = deliveryFeeCop + failedFeeCop + fulfillmentCop;
      const driverDeliveredPayCop = driverEntries
        .filter((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("entregado"))
        .reduce((sum, entry) => sum + entry.amountCop, 0);
      const driverFailedPayCop = driverEntries
        .filter((entry) => entry.type === "driver_earning" && entry.description.toLowerCase().includes("fallido"))
        .reduce((sum, entry) => sum + entry.amountCop, 0);
      const driverPayCop = netAmountCop(driverEntries, ["driver_earning"]);
      const codReceived = order.paymentMethod === "prepaid" || codReceivedOrderIds.has(order.id);
      const sellerEligible = order.paymentMethod === "prepaid" || codReceived;
      return {
        orderId: order.id,
        trackingCode: order.trackingCode ?? order.id,
        shopifyOrderId: order.shopifyOrderId,
        sellerId: order.sellerId,
        sellerName: seller?.name ?? order.sellerId,
        driverId: order.driverId ?? "unassigned",
        driverName: driver?.name ?? "Sin domiciliario",
        status: order.status,
        paymentMethod: order.paymentMethod,
        codCop,
        deliveryFeeCop,
        failedFeeCop,
        fulfillmentCop,
        storeChargeCop,
        driverDeliveredPayCop,
        driverFailedPayCop,
        driverPayCop,
        platformMarginCop: storeChargeCop - driverPayCop,
        sellerNetCop: codCop - storeChargeCop,
        sellerWalletEntryIds: sellerEntries.map((entry) => entry.id),
        driverWalletEntryIds: driverEntries.map((entry) => entry.id),
        sellerSettlementIds: Array.from(new Set(sellerEntries.map((entry) => entry.settlementId).filter(Boolean) as string[])),
        driverSettlementIds: Array.from(new Set(driverEntries.map((entry) => entry.settlementId).filter(Boolean) as string[])),
        codReceived,
        sellerEligible,
        reason: sellerEligible ? "Habilitado para tienda" : "Pendiente marcar dinero recibido del domiciliario"
      };
    })
    .sort((left, right) => left.sellerName.localeCompare(right.sellerName) || left.trackingCode.localeCompare(right.trackingCode));
}

function auditsForOrderIds(audits: LiquidationOrderAudit[], orderIds: string[]) {
  const orderIdSet = new Set(orderIds);
  return audits.filter((audit) => orderIdSet.has(audit.orderId));
}

function isSellerEntryEligible(entry: WalletEntry, auditByOrderId: Map<string, LiquidationOrderAudit>) {
  if (entry.ownerType !== "seller") return true;
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
    const feesCop = deliveryFeeCop + failedFeeCop + fulfillmentCop;
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
      codCop,
      feesCop,
      deliveryFeeCop,
      failedFeeCop,
      fulfillmentCop,
      earningsCop: 0,
      deliveredPayCop: 0,
      failedPayCop: 0,
      platformMarginCop: feesCop,
      cashToReturnCop: 0,
      receivableCop: Math.max(0, netCop),
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
      codCop,
      feesCop,
      deliveryFeeCop,
      failedFeeCop,
      fulfillmentCop,
      earningsCop,
      deliveredPayCop,
      failedPayCop,
      platformMarginCop: feesCop - earningsCop,
      cashToReturnCop: Math.max(0, codCop - earningsCop),
      receivableCop: Math.max(0, earningsCop - codCop),
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
  totalChargedCop: number;
  sellerBalanceCop: number;
  connectedStores: number;
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
        totalChargedCop: deliveryFeeCop + failedFeeCop + fulfillmentCop,
        sellerBalanceCop: ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0),
        connectedStores
      };
    })
    .filter((row) => row.orders > 0 || row.sellerBalanceCop !== 0)
    .sort((left, right) => right.orders - left.orders || left.sellerName.localeCompare(right.sellerName));
}

function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function downloadFailedOrdersCsv(orders: Order[], state: AppState, startDate: string, endDate: string, sellerFilter: string) {
  const header = [
    "numero_guia",
    "numero_shopify",
    "id_pedido",
    "vendedor",
    "dominio_tienda",
    "ciudad",
    "zona",
    "estado",
    "motivo_fallido",
    "decision_reintento",
    "cliente",
    "telefono",
    "direccion_original",
    "direccion_normalizada",
    "lat",
    "lng",
    "metodo_pago",
    "modo_fulfillment",
    "valor_total_cop",
    "producto",
    "sku",
    "cantidad",
    "lider_logistico",
    "mensajero",
    "punto_recogida",
    "direccion_recogida",
    "fecha_programada",
    "ventana_programada",
    "resultado_llamada",
    "nota_llamada",
    "fecha_reprogramada",
    "ventana_reprogramada",
    "rotulo_impreso_en",
    "rotulo_impreso_por",
    "veces_impreso",
    "recogido_en",
    "creado_en",
    "actualizado_en",
    "cantidad_evidencias",
    "evidencia_tipo",
    "evidencia_motivo",
    "evidencia_nota",
    "evidencia_archivo",
    "evidencia_link_foto",
    "evidencia_creada_en",
    "todos_links_evidencia",
    "todas_notas_evidencia",
    "pedido_json",
    "evidencias_json"
  ];
  const rows = orders.map((order) => {
    const seller = state.sellers.find((item) => item.id === order.sellerId);
    const city = state.cities.find((item) => item.id === order.cityId);
    const zone = state.zones.find((item) => item.id === order.zoneId);
    const driver = state.drivers.find((item) => item.id === order.driverId);
    const messenger = state.messengers.find((item) => item.id === order.messengerId);
    const latestEvidence = [...order.evidence].reverse().find((item) => item.type === "failed") ?? order.evidence.at(-1);
    return [
      order.trackingCode,
      order.shopifyOrderId,
      order.id,
      seller?.name,
      seller?.shopDomain,
      city?.name ?? order.cityId,
      zone?.name ?? order.zoneId,
      statusLabel(order.status),
      order.failedReason,
      order.retryDecision,
      order.customerName,
      order.customerPhone,
      order.addressRaw,
      order.normalizedAddress,
      order.lat,
      order.lng,
      order.paymentMethod,
      order.fulfillmentMode,
      order.totalCop,
      order.productName,
      order.sku,
      order.quantity,
      driver?.name,
      messenger?.name,
      order.pickupPointName,
      order.pickupAddress,
      order.scheduledDate,
      order.scheduledWindow,
      order.callOutcome,
      order.callNote,
      order.rescheduledDate,
      order.rescheduledWindow,
      order.labelPrintedAt,
      order.labelPrintedBy,
      order.labelPrintCount,
      order.pickedUpAt,
      order.createdAt,
      order.updatedAt,
      order.evidence.length,
      latestEvidence?.type,
      latestEvidence?.reason,
      latestEvidence?.note,
      latestEvidence?.photoLabel,
      latestEvidence?.photoUrl,
      latestEvidence?.createdAt,
      order.evidence.map((item) => item.photoUrl).filter(Boolean).join(" | "),
      order.evidence.map((item) => [item.createdAt, item.reason, item.note].filter(Boolean).join(" - ")).join(" | "),
      JSON.stringify(order),
      JSON.stringify(order.evidence)
    ];
  });
  const csv = [header, ...rows].map((line) => line.map(csvValue).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fallidos-${sellerFilter === "all" ? "todos" : sellerFilter}-${startDate || "inicio"}-${endDate || "hoy"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadLiquidationsCsv(rows: LiquidationRow[], storeRows: StoreLiquidationRow[], orderAudits: LiquidationOrderAudit[], blockedAudits: LiquidationOrderAudit[], startDate: string, endDate: string) {
  const totalSellerFees = rows.filter((row) => row.role === "seller").reduce((sum, row) => sum + row.feesCop, 0);
  const totalDriverPay = rows.filter((row) => row.role === "driver").reduce((sum, row) => sum + row.earningsCop, 0);
  const platformMargin = totalSellerFees - totalDriverPay;
  const header = ["tipo", "nombre", "ordenes", "entregados", "fallidos", "cod_recaudado", "cobro_entrega_tienda", "cobro_fallido_tienda", "fulfillment", "total_cobrado_tienda", "pago_entregados_domiciliario", "pago_fallidos_domiciliario", "total_pago_domiciliario", "margen_plataforma", "debe_entregar", "saldo_a_recibir", "neto", "estado"];
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
    row.feesCop,
    row.deliveredPayCop,
    row.failedPayCop,
    row.earningsCop,
    row.platformMarginCop,
    row.cashToReturnCop,
    row.receivableCop,
    row.netCop,
    row.status
  ]);
  const summary = [
    [],
    ["resumen", "margen plataforma estimado", "", "", "", "", "", "", "", totalSellerFees, "", "", totalDriverPay, platformMargin, "", "", "", ""]
  ];
  const storeHeader = ["tienda", "vendedor", "dominio", "ordenes", "entregados", "fallidos", "cod_recaudado", "cobro_entrega_tienda", "cobro_fallido_tienda", "fulfillment", "total_cobrado_tienda", "saldo_a_pagar_tienda", "tiendas_conectadas"];
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
    row.totalChargedCop,
    row.sellerBalanceCop,
    row.connectedStores
  ]);
  const orderHeader = ["guia", "shopify", "pedido_id", "tienda", "domiciliario", "estado", "metodo_pago", "cod", "cobro_entrega_tienda", "cobro_fallido_tienda", "fulfillment", "total_cobrado_tienda", "pago_entregado_domiciliario", "pago_fallido_domiciliario", "total_pago_domiciliario", "comision_plataforma", "a_pagar_tienda", "cod_recibido_domiciliario", "tienda_habilitada", "nota"];
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

function LiquidationsPage({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const today = dateValue(new Date());
  const weekAgo = dateValue(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rangeEntries = state.wallet.filter((entry) => isEntryInRange(entry, startDate, endDate));
  const entries = rangeEntries.filter((entry) => !entry.settlementId);
  const rangeAudits = buildLiquidationOrderAudits(state, rangeEntries);
  const auditByOrderId = new Map(rangeAudits.map((audit) => [audit.orderId, audit]));
  const eligibleSellerEntries = entries.filter((entry) => isSellerEntryEligible(entry, auditByOrderId));
  const eligibleRangeSellerEntries = rangeEntries.filter((entry) => isSellerEntryEligible(entry, auditByOrderId));
  const driverRows = buildLiquidationRows(state, entries.filter((entry) => entry.ownerType === "driver"), state.wallet, rangeAudits).filter((row) => row.role === "driver");
  const sellerRows = buildLiquidationRows(state, eligibleSellerEntries.filter((entry) => entry.ownerType === "seller"), state.wallet, rangeAudits).filter((row) => row.role === "seller");
  const rows = [...sellerRows, ...driverRows];
  const storeRows = buildStoreLiquidationRows(state, eligibleSellerEntries.filter((entry) => entry.ownerType === "seller"));
  const rangeStoreRows = buildStoreLiquidationRows(state, eligibleRangeSellerEntries.filter((entry) => entry.ownerType === "seller"));
  const pendingSellerOrderIds = new Set(entries.filter((entry) => entry.ownerType === "seller").map((entry) => entry.orderId).filter(Boolean) as string[]);
  const blockedSellerAudits = rangeAudits.filter((audit) => pendingSellerOrderIds.has(audit.orderId) && audit.paymentMethod === "cod" && !audit.sellerEligible);
  const pendingEntryIds = new Set(entries.map((entry) => entry.id));
  const pendingAudits = rangeAudits.filter((audit) => {
    return [...audit.sellerWalletEntryIds, ...audit.driverWalletEntryIds].some((entryId) => pendingEntryIds.has(entryId));
  });
  const closedSettlements = [...state.settlements].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const totalCod = rangeAudits.reduce((sum, audit) => sum + audit.codCop, 0);
  const totalSellerFees = rangeAudits.reduce((sum, audit) => sum + audit.storeChargeCop, 0);
  const rangeDriverEarnings = rangeEntries.filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning");
  const totalDriverPay = rangeDriverEarnings.filter((entry) => entry.amountCop > 0).reduce((sum, entry) => sum + entry.amountCop, 0);
  const totalDriverAdjustments = rangeDriverEarnings.filter((entry) => entry.amountCop < 0).reduce((sum, entry) => sum + entry.amountCop, 0);
  const totalDriverAdjustmentCredit = Math.abs(totalDriverAdjustments);
  const totalDriverCost = totalDriverPay + totalDriverAdjustments;
  const totalDeliveredOrders = rangeAudits.filter((audit) => audit.status === "delivered").length;
  const totalFailedOrders = rangeAudits.filter((audit) => audit.status === "failed").length;
  const totalDeliveryFees = rangeAudits.reduce((sum, audit) => sum + audit.deliveryFeeCop, 0);
  const totalFailedFees = rangeAudits.reduce((sum, audit) => sum + audit.failedFeeCop, 0);
  const totalFulfillmentFees = rangeAudits.reduce((sum, audit) => sum + audit.fulfillmentCop, 0);
  const totalDeliveredPay = rangeDriverEarnings
    .filter((entry) => entry.amountCop > 0 && entry.description.toLowerCase().includes("entregado"))
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const totalFailedPay = rangeDriverEarnings
    .filter((entry) => entry.amountCop > 0 && entry.description.toLowerCase().includes("fallido"))
    .reduce((sum, entry) => sum + entry.amountCop, 0);
  const totalDriverCashToReturn = rows.filter((row) => row.role === "driver").reduce((sum, row) => sum + row.cashToReturnCop, 0);
  const totalDriverReceivable = rows.filter((row) => row.role === "driver").reduce((sum, row) => sum + row.receivableCop, 0);
  const platformMargin = totalSellerFees - totalDriverCost;
  const totalPending = rows.reduce((sum, row) => sum + Math.abs(row.netCop), 0);

  const mergeSettlement = (settlement: Settlement, walletEntries: WalletEntry[]) => {
    const knownIds = new Set(state.wallet.map((entry) => entry.id));
    const newEntries = walletEntries.filter((entry) => !knownIds.has(entry.id));
    setState({
      ...state,
      settlements: [settlement, ...state.settlements.filter((item) => item.id !== settlement.id)],
      wallet: [...newEntries, ...state.wallet.map((entry) => walletEntries.find((item) => item.id === entry.id) ?? entry)]
    });
  };

  const updateSettlement = (settlement: Settlement) => {
    setState({
      ...state,
      settlements: state.settlements.map((item) => item.id === settlement.id ? settlement : item)
    });
  };

  const closeRow = (row: LiquidationRow) => {
    if (!startDate || !endDate) {
      setError("Selecciona un rango de fechas antes de cerrar la liquidacion.");
      return;
    }
    setBusyId(`${row.role}-${row.id}`);
    setError(null);
    void createFirebaseSettlement({ kind: row.role, ownerId: row.id, startDate, endDate })
      .then(async ({ settlement, walletEntries }) => {
        const { settlement: paidSettlement } = await updateFirebaseSettlementStatus({ settlementId: settlement.id, status: "paid" });
        mergeSettlement(paidSettlement, walletEntries);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo cerrar la liquidacion."))
      .finally(() => setBusyId(null));
  };

  const changeStatus = (settlement: Settlement, status: "paid" | "reconciled") => {
    setBusyId(`${settlement.id}-${status}`);
    setError(null);
    void updateFirebaseSettlementStatus({ settlementId: settlement.id, status })
      .then(({ settlement: updatedSettlement }) => updateSettlement(updatedSettlement))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo actualizar la liquidacion."))
      .finally(() => setBusyId(null));
  };

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-bold">Liquidaciones</h2>
          <p className="text-sm text-black/60">Cierre financiero por rango de fechas basado en movimientos de wallet.</p>
        </div>
        <button
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          type="button"
          disabled={rows.length === 0}
          onClick={() => downloadLiquidationsCsv(rows, storeRows, pendingAudits, blockedSellerAudits, startDate, endDate)}
        >
          <FileDown size={16} />
          Exportar CSV
        </button>
      </div>

      <Card>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Desde
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Hasta
            <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-field" type="button" onClick={() => { setStartDate(""); setEndDate(today); }}>
            Ver todo
          </button>
        </div>
      </Card>

      {error && <p className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">{error}</p>}

      <div className="grid gap-3 md:grid-cols-4">
        <Metric icon={<CreditCard size={20} />} label="COD recibido" value={formatCop(totalCod)} />
        <Metric icon={<Wallet size={20} />} label="Fee cobrado tiendas" value={formatCop(totalSellerFees)} />
        <Metric icon={<Truck size={20} />} label="Pago transportistas" value={formatCop(totalDriverPay)} />
        <Metric icon={<ShieldCheck size={20} />} label="Margen plataforma" value={formatCop(platformMargin)} />
      </div>

      <Card>
        <div className="mb-3">
          <h2 className="font-bold">Resumen completo del rango</h2>
          <p className="text-sm text-black/60">Desglose de lo que se cobra a tiendas, lo que se paga a domiciliarios y lo que queda como comision de plataforma.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md bg-field p-3">
            <p className="text-xs font-semibold uppercase text-black/50">Pedidos</p>
            <p className="mt-1 text-sm text-black/70">Entregados: <b>{totalDeliveredOrders}</b></p>
            <p className="text-sm text-black/70">Fallidos: <b>{totalFailedOrders}</b></p>
            <p className="text-sm text-black/70">Total cerrados: <b>{totalDeliveredOrders + totalFailedOrders}</b></p>
          </div>
          <div className="rounded-md bg-field p-3">
            <p className="text-xs font-semibold uppercase text-black/50">Cobrado a tiendas</p>
            <p className="mt-1 text-sm text-black/70">Entregas: <b>{formatCop(totalDeliveryFees)}</b></p>
            <p className="text-sm text-black/70">Fallidos: <b>{formatCop(totalFailedFees)}</b></p>
            <p className="text-sm text-black/70">Fulfillment: <b>{formatCop(totalFulfillmentFees)}</b></p>
            <p className="text-sm text-black/70">Total cobrado: <b>{formatCop(totalSellerFees)}</b></p>
          </div>
          <div className="rounded-md bg-field p-3">
            <p className="text-xs font-semibold uppercase text-black/50">Pagado a domiciliarios</p>
            <p className="mt-1 text-sm text-black/70">Entregas: <b>{formatCop(totalDeliveredPay)}</b></p>
            <p className="text-sm text-black/70">Fallidos: <b>{formatCop(totalFailedPay)}</b></p>
            <p className="text-sm text-black/70">Total pagado: <b>{formatCop(totalDriverPay)}</b></p>
            {totalDriverAdjustmentCredit > 0 && <p className="text-sm text-black/70">Ajustes/reversas a favor: <b>{formatCop(totalDriverAdjustmentCredit)}</b></p>}
            <p className="text-sm text-black/70">Costo neto para margen: <b>{formatCop(Math.max(0, totalDriverCost))}</b></p>
            <p className={`text-sm font-bold ${platformMargin < 0 ? "text-rust" : "text-mint"}`}>Comision plataforma: {formatCop(platformMargin)}</p>
          </div>
        </div>
      </Card>

      <StoreLiquidationSummary rows={rangeStoreRows} />

      <div className="grid gap-3 md:grid-cols-2">
        <Metric icon={<AlertTriangle size={20} />} label="Domiciliarios deben entregar" value={formatCop(totalDriverCashToReturn)} />
        <Metric icon={<CreditCard size={20} />} label="Saldo a pagar domiciliarios" value={formatCop(totalDriverReceivable)} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Metric icon={<AlertTriangle size={20} />} label="Pendiente total por conciliar" value={formatCop(totalPending)} />
        <Card>
          <h2 className="font-bold">Lectura del margen</h2>
          <p className="mt-2 text-sm text-black/60">
            Margen estimado del rango = fee cobrado a tiendas menos pago del domiciliario. En transportistas, el saldo neto compara COD recaudado contra pago del domiciliario: si el COD es mayor, debe entregar la diferencia; si el pago es mayor, queda saldo a recibir.
          </p>
        </Card>
      </div>

      <StoreLiquidationTable rows={storeRows} />
      <LiquidationTable title="Tiendas disponibles para pagar" rows={sellerRows} emptyMessage="No hay tiendas habilitadas para pagar en este rango. Para COD, primero marca recibido el dinero del domiciliario." busyId={busyId} onClose={closeRow} />
      <BlockedSellerOrdersTable audits={blockedSellerAudits} />
      <LiquidationTable title="Domiciliarios por cortar" rows={driverRows} emptyMessage="No hay movimientos de domiciliarios sin liquidar en este rango." busyId={busyId} onClose={closeRow} />
      <SettlementsTable state={state} settlements={closedSettlements} busyId={busyId} onChangeStatus={changeStatus} />
    </main>
  );
}

function LiquidationTable({
  title,
  rows,
  emptyMessage,
  busyId,
  onClose
}: {
  title: string;
  rows: LiquidationRow[];
  emptyMessage: string;
  busyId: string | null;
  onClose: (row: LiquidationRow) => void;
}) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(rows, 10);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-bold">{title}</h2>
        <span className="text-sm text-black/60">{rows.length} cuentas</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-black/60">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
                <th className="py-2 pr-3 font-semibold">Cuenta</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">Ent/Fall</th>
                <th className="py-2 pr-3 font-semibold">COD recaudado</th>
                <th className="py-2 pr-3 font-semibold">Cobrado tienda</th>
                <th className="py-2 pr-3 font-semibold">Pago domiciliario</th>
                <th className="py-2 pr-3 font-semibold">Margen</th>
                <th className="py-2 pr-3 font-semibold">Debe entregar</th>
                <th className="py-2 pr-3 font-semibold">Saldo a recibir</th>
                <th className="py-2 pr-3 font-semibold">Neto</th>
                <th className="py-2 font-semibold">Estado</th>
                <th className="py-2 text-right font-semibold">Accion</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((row) => {
                const rowKey = `${row.role}-${row.id}`;
                const expanded = expandedId === rowKey;
                const actionLabel = row.role === "seller" ? "Pagar tienda" : row.cashToReturnCop > 0 ? "Marcar dinero recibido" : "Marcar pago realizado";
                return (
                  <Fragment key={rowKey}>
                    <tr key={rowKey} className="border-b border-black/5 last:border-0">
                      <td className="py-3 pr-3 font-semibold">{row.name}</td>
                      <td className="py-3 pr-3">{row.orders}</td>
                      <td className="py-3 pr-3">{row.deliveredOrders}/{row.failedOrders}</td>
                      <td className="py-3 pr-3">{formatCop(row.codCop)}</td>
                      <td className="py-3 pr-3">{formatCop(row.feesCop)}</td>
                      <td className="py-3 pr-3">{formatCop(row.earningsCop)}</td>
                      <td className={`py-3 pr-3 font-bold ${row.platformMarginCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.platformMarginCop)}</td>
                      <td className="py-3 pr-3 font-bold text-rust">{row.role === "driver" ? formatCop(row.cashToReturnCop) : "-"}</td>
                      <td className="py-3 pr-3 font-bold text-mint">{formatCop(row.receivableCop)}</td>
                      <td className={`py-3 pr-3 font-bold ${row.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.netCop)}</td>
                      <td className="py-3">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${row.status === "pendiente" ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="focus-ring rounded-md border border-black/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                            type="button"
                            onClick={() => setExpandedId(expanded ? null : rowKey)}
                          >
                            {expanded ? "Ocultar" : "Detalle"}
                          </button>
                          <button
                            className="focus-ring rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                            type="button"
                            disabled={busyId === rowKey}
                            onClick={() => onClose(row)}
                          >
                            {busyId === rowKey ? "Guardando..." : actionLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${rowKey}-detail`} className="border-b border-black/5">
                        <td colSpan={12} className="bg-field/60 px-3 py-3">
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
      )}
    </Card>
  );
}

function DetailLine({ label, value, tone }: { label: string; value: string | number; tone?: "mint" | "rust" | "ink" }) {
  const toneClass = tone === "mint" ? "text-mint" : tone === "rust" ? "text-rust" : "text-ink";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-black/5 py-1.5 last:border-0">
      <span className="text-black/60">{label}</span>
      <span className={`font-bold ${toneClass}`}>{value}</span>
    </div>
  );
}

function LiquidationRowDetail({ row }: { row: LiquidationRow }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">Pedidos incluidos</p>
          <DetailLine label="Total pedidos" value={row.orders} />
          <DetailLine label="Entregados" value={row.deliveredOrders} tone="mint" />
          <DetailLine label="Fallidos" value={row.failedOrders} tone="rust" />
        </div>
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">Cobros a tienda</p>
          <DetailLine label="COD recaudado" value={formatCop(row.codCop)} />
          <DetailLine label="Cobro por entregas" value={formatCop(row.deliveryFeeCop)} />
          <DetailLine label="Cobro por fallidos" value={formatCop(row.failedFeeCop)} />
          <DetailLine label="Fulfillment" value={formatCop(row.fulfillmentCop)} />
          <DetailLine label="Total cobrado" value={formatCop(row.feesCop)} tone="mint" />
        </div>
        {row.role === "driver" ? (
          <div className="rounded-md bg-white p-3">
            <p className="mb-2 text-xs font-bold uppercase text-black/50">Pago domiciliario</p>
            <DetailLine label="Pago por entregados" value={formatCop(row.deliveredPayCop)} />
            <DetailLine label="Pago por fallidos" value={formatCop(row.failedPayCop)} />
            <DetailLine label="Total pago" value={formatCop(row.earningsCop)} tone="rust" />
            <DetailLine label="Debe entregar" value={formatCop(row.cashToReturnCop)} tone="rust" />
            <DetailLine label="Saldo a recibir" value={formatCop(row.receivableCop)} tone="mint" />
          </div>
        ) : (
          <div className="rounded-md bg-white p-3">
            <p className="mb-2 text-xs font-bold uppercase text-black/50">Liquidacion tienda</p>
            <DetailLine label="COD a favor de tienda" value={formatCop(row.codCop)} tone="mint" />
            <DetailLine label="Cobros descontados" value={formatCop(row.feesCop)} tone="rust" />
            <DetailLine label="A pagar a tienda" value={formatCop(row.receivableCop)} tone="mint" />
          </div>
        )}
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">Resultado</p>
          <DetailLine label="Comision plataforma" value={formatCop(row.platformMarginCop)} tone={row.platformMarginCop < 0 ? "rust" : "mint"} />
          <DetailLine label={row.role === "seller" ? "A pagar a tienda" : "Neto domiciliario"} value={formatCop(row.netCop)} tone={row.netCop < 0 ? "rust" : "mint"} />
          <p className="mt-2 rounded-md bg-field px-2 py-1.5 text-xs text-black/60">
            {row.role === "seller"
              ? "A pagar a tienda = COD ya recibido menos cobros de transporte, fallidos y fulfillment."
              : "Neto domiciliario = pago domiciliario menos COD recaudado. Si es negativo, debe entregar dinero."}
          </p>
        </div>
      </div>
      <LiquidationOrderAuditTable audits={row.orderDetails} compact />
    </div>
  );
}

function LiquidationOrderAuditTable({ audits, compact = false }: { audits: LiquidationOrderAudit[]; compact?: boolean }) {
  if (audits.length === 0) {
    return <p className="rounded-md bg-white px-3 py-2 text-sm text-black/60">No hay pedidos detallados para esta liquidacion.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md bg-white">
      <table className={`w-full border-collapse text-sm ${compact ? "min-w-[1200px]" : "min-w-[1320px]"}`}>
        <thead>
          <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
            <th className="py-2 pl-3 pr-3 font-semibold">Guia</th>
            <th className="py-2 pr-3 font-semibold">Shopify</th>
            <th className="py-2 pr-3 font-semibold">Tienda</th>
            <th className="py-2 pr-3 font-semibold">Domiciliario</th>
            <th className="py-2 pr-3 font-semibold">Estado</th>
            <th className="py-2 pr-3 font-semibold">COD</th>
            <th className="py-2 pr-3 font-semibold">Cobro tienda</th>
            <th className="py-2 pr-3 font-semibold">Pago domiciliario</th>
            <th className="py-2 pr-3 font-semibold">Comision</th>
            <th className="py-2 pr-3 font-semibold">A pagar tienda</th>
            <th className="py-2 pr-3 font-semibold">Habilitado tienda</th>
            <th className="py-2 pr-3 font-semibold">Nota</th>
          </tr>
        </thead>
        <tbody>
          {audits.map((audit) => (
            <tr key={audit.orderId} className="border-b border-black/5 last:border-0">
              <td className="py-3 pl-3 pr-3 font-semibold">{audit.trackingCode}</td>
              <td className="py-3 pr-3">{audit.shopifyOrderId}</td>
              <td className="py-3 pr-3">{audit.sellerName}</td>
              <td className="py-3 pr-3">{audit.driverName}</td>
              <td className="py-3 pr-3">{statusLabel(audit.status)}</td>
              <td className="py-3 pr-3">{formatCop(audit.codCop)}</td>
              <td className="py-3 pr-3">
                <p className="font-semibold">{formatCop(audit.storeChargeCop)}</p>
                <p className="text-xs text-black/50">Ent {formatCop(audit.deliveryFeeCop)} · Fall {formatCop(audit.failedFeeCop)} · Ful {formatCop(audit.fulfillmentCop)}</p>
              </td>
              <td className="py-3 pr-3">
                <p className="font-semibold">{formatCop(audit.driverPayCop)}</p>
                <p className="text-xs text-black/50">Ent {formatCop(audit.driverDeliveredPayCop)} · Fall {formatCop(audit.driverFailedPayCop)}</p>
              </td>
              <td className={`py-3 pr-3 font-bold ${audit.platformMarginCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(audit.platformMarginCop)}</td>
              <td className={`py-3 pr-3 font-bold ${audit.sellerNetCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(audit.sellerNetCop)}</td>
              <td className="py-3 pr-3">
                <span className={`rounded-md px-2 py-1 text-xs font-semibold ${audit.sellerEligible ? "bg-mint/10 text-mint" : "bg-rust/10 text-rust"}`}>
                  {audit.sellerEligible ? "Si" : "No"}
                </span>
              </td>
              <td className="py-3 pr-3 text-black/60">{audit.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
          <p className="text-sm text-black/60">Estos pedidos tienen movimientos de tienda pendientes, pero aun falta marcar recibido el dinero del domiciliario.</p>
        </div>
        <span className="shrink-0 text-sm text-black/60">{audits.length} pedidos</span>
      </div>
      {audits.length === 0 ? (
        <p className="text-sm text-black/60">No hay pedidos COD bloqueados en este rango.</p>
      ) : (
        <>
          <LiquidationOrderAuditTable audits={visibleItems} />
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
          <p className="text-sm text-black/60">Control por vendedor/tienda para revisar recaudo, cobros y saldo antes de cerrar liquidaciones.</p>
        </div>
        <span className="shrink-0 text-sm text-black/60">{rows.length} tiendas</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-black/60">No hay movimientos de tiendas sin liquidar en este rango.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
                <th className="py-2 pr-3 font-semibold">Tienda</th>
                <th className="py-2 pr-3 font-semibold">Dominio</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">Ent/Fall</th>
                <th className="py-2 pr-3 font-semibold">COD recaudado</th>
                <th className="py-2 pr-3 font-semibold">Cobro entrega</th>
                <th className="py-2 pr-3 font-semibold">Cobro fallido</th>
                <th className="py-2 pr-3 font-semibold">Fulfillment</th>
                <th className="py-2 pr-3 font-semibold">Total cobrado</th>
                <th className="py-2 pr-3 font-semibold">A pagar tienda</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((row) => (
                <tr key={row.sellerId} className="border-b border-black/5 last:border-0">
                  <td className="py-3 pr-3">
                    <p className="font-semibold">{row.sellerName}</p>
                    <p className="text-xs text-black/50">{row.connectedStores} conexion{row.connectedStores === 1 ? "" : "es"}</p>
                  </td>
                  <td className="py-3 pr-3">{row.shopDomain}</td>
                  <td className="py-3 pr-3">{row.orders}</td>
                  <td className="py-3 pr-3">{row.deliveredOrders}/{row.failedOrders}</td>
                  <td className="py-3 pr-3">{formatCop(row.codCop)}</td>
                  <td className="py-3 pr-3">{formatCop(row.deliveryFeeCop)}</td>
                  <td className="py-3 pr-3">{formatCop(row.failedFeeCop)}</td>
                  <td className="py-3 pr-3">{formatCop(row.fulfillmentCop)}</td>
                  <td className="py-3 pr-3 font-bold">{formatCop(row.totalChargedCop)}</td>
                  <td className={`py-3 pr-3 font-bold ${row.sellerBalanceCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.sellerBalanceCop)}</td>
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

function settlementStatusLabel(status: Settlement["status"]) {
  if (status === "paid") return "pagada";
  if (status === "reconciled") return "conciliada";
  return "pendiente";
}

function settlementFinancialView(state: AppState, settlement: Settlement) {
  const settlementEntries = state.wallet.filter((entry) => settlement.walletEntryIds.includes(entry.id));
  const orderIds = settlement.orderIds.length > 0
    ? settlement.orderIds
    : Array.from(new Set(settlementEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
  if (settlement.kind === "driver") {
    const relatedSellerEntries = getRelatedSellerEntries(state.wallet, orderIds);
    const codCop = settlement.codCop || relatedSellerEntries.filter((entry) => entry.type === "cod_revenue").reduce((sum, entry) => sum + entry.amountCop, 0);
    const feesCop = settlement.feesCop || netChargeCop(relatedSellerEntries, ["delivery_fee", "failed_fee", "fulfillment_fee"]);
    const driverPayCop = settlement.driverPayCop || settlementEntries.filter((entry) => entry.type === "driver_earning").reduce((sum, entry) => sum + entry.amountCop, 0);
    const netCop = driverPayCop - codCop;
    return {
      codCop,
      feesCop,
      driverPayCop,
      platformMarginCop: feesCop - driverPayCop,
      cashToReturnCop: Math.max(0, codCop - driverPayCop),
      receivableCop: Math.max(0, driverPayCop - codCop),
      netCop
    };
  }
  const netCop = settlement.netCop;
  return {
    codCop: settlement.codCop,
    feesCop: settlement.feesCop,
    driverPayCop: settlement.driverPayCop,
    platformMarginCop: settlement.platformMarginCop,
    cashToReturnCop: 0,
    receivableCop: Math.max(0, netCop),
    netCop
  };
}

function settlementLiquidationRow(state: AppState, settlement: Settlement): LiquidationRow | null {
  const settlementEntries = state.wallet.filter((entry) => settlement.walletEntryIds.includes(entry.id));
  const rows = buildLiquidationRows(state, settlementEntries, state.wallet);
  return rows.find((row) => row.role === settlement.kind && row.id === settlement.ownerId) ?? null;
}

function SettlementsTable({
  state,
  settlements,
  busyId,
  onChangeStatus
}: {
  state: AppState;
  settlements: Settlement[];
  busyId: string | null;
  onChangeStatus: (settlement: Settlement, status: "paid" | "reconciled") => void;
}) {
  const { page, setPage, totalPages, visibleItems } = usePaginatedItems(settlements, 10);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold">Liquidaciones cerradas</h2>
          <p className="text-sm text-black/60">Cortes guardados en Firestore con trazabilidad de estado.</p>
        </div>
        <span className="text-sm text-black/60">{settlements.length} cortes</span>
      </div>
      {settlements.length === 0 ? (
        <p className="text-sm text-black/60">Todavia no hay liquidaciones cerradas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
                <th className="py-2 pr-3 font-semibold">Cuenta</th>
                <th className="py-2 pr-3 font-semibold">Rango</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">Ent/Fall</th>
                <th className="py-2 pr-3 font-semibold">COD recaudado</th>
                <th className="py-2 pr-3 font-semibold">Cobrado tienda</th>
                <th className="py-2 pr-3 font-semibold">Pago domiciliario</th>
                <th className="py-2 pr-3 font-semibold">Margen</th>
                <th className="py-2 pr-3 font-semibold">Debe entregar</th>
                <th className="py-2 pr-3 font-semibold">Saldo a recibir</th>
                <th className="py-2 pr-3 font-semibold">Neto</th>
                <th className="py-2 pr-3 font-semibold">Estado</th>
                <th className="py-2 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((settlement) => {
                const view = settlementFinancialView(state, settlement);
                const detailRow = settlementLiquidationRow(state, settlement);
                const expanded = expandedId === settlement.id;
                return (
                  <Fragment key={settlement.id}>
                    <tr className="border-b border-black/5 last:border-0">
                      <td className="py-3 pr-3">
                        <p className="font-semibold">{settlement.ownerName}</p>
                        <p className="text-xs text-black/50">{settlement.kind === "seller" ? "Vendedor" : "Transportista"}</p>
                      </td>
                      <td className="py-3 pr-3">{settlement.startDate} a {settlement.endDate}</td>
                      <td className="py-3 pr-3">{settlement.orderIds.length}</td>
                      <td className="py-3 pr-3">{detailRow ? `${detailRow.deliveredOrders}/${detailRow.failedOrders}` : "-"}</td>
                      <td className="py-3 pr-3">{formatCop(view.codCop)}</td>
                      <td className="py-3 pr-3">{formatCop(view.feesCop)}</td>
                      <td className="py-3 pr-3">{formatCop(view.driverPayCop)}</td>
                      <td className={`py-3 pr-3 font-bold ${view.platformMarginCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(view.platformMarginCop)}</td>
                      <td className="py-3 pr-3 font-bold text-rust">{settlement.kind === "driver" ? formatCop(view.cashToReturnCop) : "-"}</td>
                      <td className="py-3 pr-3 font-bold text-mint">{formatCop(view.receivableCop)}</td>
                      <td className={`py-3 pr-3 font-bold ${view.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(view.netCop)}</td>
                      <td className="py-3 pr-3">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${settlement.status === "pending" ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                          {settlementStatusLabel(settlement.status)}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="focus-ring rounded-md border border-black/10 px-3 py-2 text-xs font-semibold hover:bg-field"
                            type="button"
                            onClick={() => setExpandedId(expanded ? null : settlement.id)}
                          >
                            {expanded ? "Ocultar" : "Detalle"}
                          </button>
                          {settlement.status === "pending" && (
                            <button
                              className="focus-ring rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                              type="button"
                              disabled={busyId === `${settlement.id}-paid`}
                              onClick={() => onChangeStatus(settlement, "paid")}
                            >
                              {busyId === `${settlement.id}-paid` ? "Guardando..." : "Marcar pagada"}
                            </button>
                          )}
                          {settlement.status === "paid" && (
                            <button
                              className="focus-ring rounded-md bg-mint px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                              type="button"
                              disabled={busyId === `${settlement.id}-reconciled`}
                              onClick={() => onChangeStatus(settlement, "reconciled")}
                            >
                              {busyId === `${settlement.id}-reconciled` ? "Guardando..." : "Conciliar"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-black/5">
                        <td colSpan={13} className="bg-field/60 px-3 py-3">
                          <ClosedSettlementDetail state={state} settlement={settlement} detailRow={detailRow} />
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
    driver_earning: "Pago domiciliario",
    platform_margin: "Comision plataforma",
    cod_remittance: "Remesa COD",
    payout: "Pago"
  };
  return labels[type] ?? type;
}

function ClosedSettlementDetail({ state, settlement, detailRow }: { state: AppState; settlement: Settlement; detailRow: LiquidationRow | null }) {
  const settlementEntries = state.wallet
    .filter((entry) => settlement.walletEntryIds.includes(entry.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const orderIds = settlement.orderIds.length > 0
    ? settlement.orderIds
    : Array.from(new Set(settlementEntries.map((entry) => entry.orderId).filter(Boolean) as string[]));
  const relatedOrderEntries = state.wallet.filter((entry) => entry.orderId && orderIds.includes(entry.orderId));
  const audits = buildLiquidationOrderAudits(state, relatedOrderEntries).filter((audit) => orderIds.includes(audit.orderId));
  const title = settlement.kind === "seller" ? "Detalle de pago a tienda" : "Detalle de corte del domiciliario";
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">{title}</p>
          <DetailLine label="Cuenta" value={settlement.ownerName} />
          <DetailLine label="Estado" value={settlementStatusLabel(settlement.status)} tone={settlement.status === "pending" ? "rust" : "mint"} />
          <DetailLine label="Creada" value={new Date(settlement.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })} />
          {settlement.paidAt && <DetailLine label="Pagada" value={new Date(settlement.paidAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })} tone="mint" />}
          {settlement.reconciledAt && <DetailLine label="Conciliada" value={new Date(settlement.reconciledAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })} tone="mint" />}
        </div>
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">Valores guardados</p>
          <DetailLine label="COD" value={formatCop(settlement.codCop)} />
          <DetailLine label="Cobrado tienda" value={formatCop(settlement.feesCop)} />
          <DetailLine label="Pago domiciliario" value={formatCop(settlement.driverPayCop)} />
          <DetailLine label="Comision plataforma" value={formatCop(settlement.platformMarginCop)} tone={settlement.platformMarginCop < 0 ? "rust" : "mint"} />
          <DetailLine label="Neto" value={formatCop(settlement.netCop)} tone={settlement.netCop < 0 ? "rust" : "mint"} />
        </div>
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">Pedidos</p>
          <DetailLine label="Total pedidos" value={orderIds.length} />
          <DetailLine label="Entregados" value={detailRow?.deliveredOrders ?? audits.filter((audit) => audit.status === "delivered").length} tone="mint" />
          <DetailLine label="Fallidos" value={detailRow?.failedOrders ?? audits.filter((audit) => audit.status === "failed").length} tone="rust" />
          <DetailLine label="Movimientos wallet" value={settlementEntries.length} />
        </div>
        <div className="rounded-md bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase text-black/50">Nota</p>
          <p className="text-sm text-black/70">{settlement.note || "Sin nota registrada."}</p>
        </div>
      </div>

      <ClosedSettlementOrderTable state={state} settlement={settlement} entries={settlementEntries} />

      <div className="overflow-x-auto rounded-md bg-white">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
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
                <td colSpan={5} className="py-3 pl-3 pr-3 text-sm text-black/60">No hay movimientos de wallet cargados para este corte.</td>
              </tr>
            ) : (
              settlementEntries.map((entry) => {
                const order = state.orders.find((item) => item.id === entry.orderId);
                return (
                  <tr key={entry.id} className="border-b border-black/5 last:border-0">
                    <td className="py-3 pl-3 pr-3">
                      <p className="font-semibold">{entry.description}</p>
                      <p className="text-xs text-black/50">{entry.id}</p>
                    </td>
                    <td className="py-3 pr-3">
                      <p className="font-semibold">{order?.trackingCode ?? entry.orderId ?? "-"}</p>
                      <p className="text-xs text-black/50">{order?.shopifyOrderId ?? ""}</p>
                    </td>
                    <td className="py-3 pr-3">{walletEntryTypeLabel(entry.type)}</td>
                    <td className="py-3 pr-3">{new Date(entry.createdAt).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td className={`py-3 pr-3 text-right font-bold ${entry.amountCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(entry.amountCop)}</td>
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

function closedSettlementOrderLabel(order: Order | undefined, entries: WalletEntry[]) {
  const text = entries.map((entry) => `${entry.type} ${entry.description}`.toLowerCase()).join(" ");
  if (text.includes("correccion") || text.includes("reversa")) return "Correccion";
  if (text.includes("fallido")) return "Fallido";
  if (text.includes("entregado")) return "Entregado";
  return order ? statusLabel(order.status) : "Movimiento";
}

function ClosedSettlementOrderTable({ state, settlement, entries }: { state: AppState; settlement: Settlement; entries: WalletEntry[] }) {
  const orderIds = Array.from(new Set(entries.map((entry) => entry.orderId).filter(Boolean) as string[]));
  const rows = orderIds.map((orderId) => {
    const order = state.orders.find((item) => item.id === orderId);
    const ownEntries = entries.filter((entry) => entry.orderId === orderId);
    const codCop = netAmountCop(ownEntries, ["cod_revenue"]);
    const deliveryFeeCop = netChargeCop(ownEntries, ["delivery_fee"]);
    const failedFeeCop = netChargeCop(ownEntries, ["failed_fee"]);
    const fulfillmentCop = netChargeCop(ownEntries, ["fulfillment_fee"]);
    const storeChargeCop = deliveryFeeCop + failedFeeCop + fulfillmentCop;
    const driverPayCop = netAmountCop(ownEntries, ["driver_earning"]);
    const netCop = ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0);
    return {
      orderId,
      trackingCode: order?.trackingCode ?? orderId,
      shopifyOrderId: order?.shopifyOrderId ?? "",
      movementLabel: closedSettlementOrderLabel(order, ownEntries),
      codCop,
      deliveryFeeCop,
      failedFeeCop,
      fulfillmentCop,
      storeChargeCop,
      driverPayCop,
      netCop,
      entriesCount: ownEntries.length
    };
  });

  if (rows.length === 0) {
    return <p className="rounded-md bg-white px-3 py-2 text-sm text-black/60">Este corte no tiene pedidos asociados.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md bg-white">
      <table className="w-full min-w-[1120px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
            <th className="py-2 pl-3 pr-3 font-semibold">Guia</th>
            <th className="py-2 pr-3 font-semibold">Shopify</th>
            <th className="py-2 pr-3 font-semibold">Movimiento pagado</th>
            <th className="py-2 pr-3 font-semibold">COD</th>
            <th className="py-2 pr-3 font-semibold">Cobro entrega</th>
            <th className="py-2 pr-3 font-semibold">Cobro fallido</th>
            <th className="py-2 pr-3 font-semibold">Fulfillment</th>
            <th className="py-2 pr-3 font-semibold">Pago domiciliario</th>
            <th className="py-2 pr-3 font-semibold">{settlement.kind === "seller" ? "A pagar tienda" : "Neto corte"}</th>
            <th className="py-2 pr-3 font-semibold">Movs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.orderId} className="border-b border-black/5 last:border-0">
              <td className="py-3 pl-3 pr-3 font-semibold">{row.trackingCode}</td>
              <td className="py-3 pr-3">{row.shopifyOrderId}</td>
              <td className="py-3 pr-3">{row.movementLabel}</td>
              <td className="py-3 pr-3">{formatCop(row.codCop)}</td>
              <td className="py-3 pr-3">{formatCop(row.deliveryFeeCop)}</td>
              <td className="py-3 pr-3">{formatCop(row.failedFeeCop)}</td>
              <td className="py-3 pr-3">{formatCop(row.fulfillmentCop)}</td>
              <td className="py-3 pr-3">{formatCop(row.driverPayCop)}</td>
              <td className={`py-3 pr-3 font-bold ${row.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.netCop)}</td>
              <td className="py-3 pr-3">{row.entriesCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRoleState({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <h2 className="font-bold">{title}</h2>
      <p className="mt-2 text-sm text-black/60">{message}</p>
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
      {message && <p className="mb-3 rounded-md bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">{message}</p>}
      <PaginatedList items={requests} pageSize={5} empty={<p className="text-sm text-black/60">No hay solicitudes pendientes.</p>}>
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
              <div key={request.id} className="rounded-md border border-black/10 p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{request.shopDomain}</p>
                    <p className="text-xs text-black/50">{request.sellerName} · {request.status === "link_ready" ? "enlace listo" : request.status === "cancelled" ? "cancelada" : "pendiente"}</p>
                    {request.orderSkuContains && <p className="mt-1 text-xs font-semibold text-black/60">Filtro: SKU contiene {request.orderSkuContains}</p>}
                    {request.observation && <p className="mt-1 text-xs text-black/60">Observacion: {request.observation}</p>}
                  </div>
                  <a className="focus-ring rounded-md bg-field px-2 py-1 text-xs font-semibold" href={`mailto:?subject=${encodeURIComponent(`Solicitud Shopify ${request.shopDomain}`)}&body=${encodeURIComponent(mailBody)}`}>
                    Email
                  </a>
                </div>
                {request.status === "installed" ? (
                  <span className="mt-3 inline-flex min-h-9 items-center justify-center rounded-md bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
                    Instalada
                  </span>
                ) : request.status !== "cancelled" && (
                  <div className="mt-3 grid gap-2">
                    <input
                      className="focus-ring rounded-md border border-black/10 px-3 py-2 text-xs"
                      placeholder="Pegar install link generado por Shopify"
                      value={links[request.id] ?? request.installLink ?? ""}
                      onChange={(event) => setLinks((current) => ({ ...current, [request.id]: event.target.value }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button className="focus-ring rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white" type="button" onClick={() => void saveLink(request)}>
                        Publicar enlace
                      </button>
                      {request.installLink && (
                        <a className="focus-ring rounded-md bg-field px-3 py-2 text-xs font-semibold" href={request.installLink} target="_blank" rel="noreferrer">
                          Abrir
                        </a>
                      )}
                      <button className="focus-ring rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/60" type="button" onClick={() => void cancelRequest(request)}>
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
      {message && <p className="mb-3 rounded-md bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">{message}</p>}
      <PaginatedList items={stores} pageSize={5} empty={<p className="text-sm text-black/60">Todavia no hay tiendas conectadas.</p>}>
        {(store) => {
            const seller = state.sellers.find((item) => item.id === store.sellerId);
            return (
              <div key={store.id} className="rounded-md border border-black/10 p-3 text-sm">
                <p className="font-semibold">{store.shopDomain}</p>
                <p className="text-xs text-black/50">
                  {seller ? `Vendedor: ${seller.name}` : "Sin vendedor asignado"} · {store.lastWebhookAt ? `Ultimo webhook: ${formatDateTime(store.lastWebhookAt)}` : "Sin webhooks recibidos"}
                </p>
                {store.orderSkuContains && <p className="mt-1 text-xs font-semibold text-black/60">Filtro activo: SKU contiene {store.orderSkuContains}</p>}
                <div className="mt-2 grid gap-2">
                  <select
                    className="focus-ring rounded-md border border-black/10 px-3 py-2 text-xs"
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
      setMessage(`Historico sincronizado: ${result.imported} nuevos, ${result.existing} ya existian, ${result.skippedOutsideCali} fuera de Cali.`);
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
        <p className="text-sm text-black/60">Primero conecta y asigna una tienda Shopify.</p>
      ) : (
        <div className="grid gap-2">
          <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={shopDomain} onChange={(event) => setShopDomain(event.target.value)}>
            {visibleStores.map((store) => (
              <option key={store.id} value={store.shopDomain}>{store.shopDomain}</option>
            ))}
          </select>
          {!lockedSellerId && (
            <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
              <option value="">Usar vendedor asignado</option>
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>{seller.name}</option>
              ))}
            </select>
          )}
          <input
            className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm"
            placeholder="Numero Shopify, ej: #1024"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          {message && <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">{message}</p>}
          <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!canImport || busy} onClick={() => void importOrder()}>
            {busy ? "Importando..." : "Importar pedido"}
          </button>
          <div className="mt-2 grid gap-2 rounded-md border border-black/10 p-3">
            <p className="text-sm font-bold">Sincronizar historicos</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-semibold text-black/60">
                Desde
                <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" type="date" value={syncStartDate} onChange={(event) => setSyncStartDate(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-black/60">
                Hasta
                <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink" type="date" value={syncEndDate} onChange={(event) => setSyncEndDate(event.target.value)} />
              </label>
            </div>
            <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-field disabled:opacity-50" type="button" disabled={!shopDomain || syncBusy} onClick={() => void syncHistorical()}>
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
          <p className="text-xs text-black/50">{openIssues.length} pendientes · pagina {safePage + 1} de {totalPages}</p>
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
            <div key={issue.id} className="rounded-md border border-rust/20 bg-rust/10 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{issue.reference}</p>
                  <p className="text-xs text-black/60">{seller?.name ?? issue.sellerId} · {issue.shopDomain}</p>
                </div>
                <span className="shrink-0 rounded bg-white px-2 py-1 text-xs font-semibold text-rust">Pendiente</span>
              </div>
              <p className="mt-2 text-xs text-rust">{issue.reason}</p>
              {issue.detail && <p className="mt-1 text-xs text-black/50">{issue.detail}</p>}
              <p className="mt-2 text-xs text-black/40">{formatDateTime(issue.updatedAt)}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ShopifyConnectionPanel({ seller, stores, requests, state, setState }: { seller: Seller; stores: ShopifyStore[]; requests: ShopifyInstallRequest[]; state: AppState; setState: (state: AppState) => void }) {
  const [shop, setShop] = useState("");
  const [observation, setObservation] = useState("");
  const [orderSkuContains, setOrderSkuContains] = useState("");
  const [message, setMessage] = useState("");
  const primaryStore = stores[0];
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

  return (
    <Card>
      <h2 className="mb-3 font-bold">Conexion Shopify</h2>
      <div className="grid gap-3 rounded-md border border-black/10 p-3">
        <div>
          <p className="font-semibold">{stores.length > 0 ? `${stores.length} tienda${stores.length === 1 ? "" : "s"} conectada${stores.length === 1 ? "" : "s"}` : "Tiendas Shopify pendientes"}</p>
          <p className="mt-1 text-sm text-black/60">Estado: {stores.length > 0 ? "con conexion activa" : shopify.status === "error" ? "requiere revision" : "requiere enlace privado"}</p>
          <p className="mt-2 text-xs text-black/50">Scopes: {shopify.requiredScopes.join(", ")}</p>
        </div>
        {stores.length > 0 && (
          <div className="grid gap-2">
            {stores.map((store) => (
              <div key={store.id} className="rounded-md bg-field px-3 py-2 text-sm">
                <p className="font-semibold">{store.shopDomain}</p>
                <p className="text-xs text-black/50">Conectada: {formatDateTime(store.connectedAt)}</p>
              </div>
            ))}
          </div>
        )}
        {requested.length > 0 && (
          <div className="grid gap-2">
            {requested.map((request) => (
              <div key={request.id} className="rounded-md bg-field px-3 py-2 text-sm">
                <p className="font-semibold">{request.shopDomain}</p>
                <p className="text-xs text-black/50">
                  {request.status === "installed" ? "Instalada y conectada" : request.installLink ? "Enlace listo para instalar" : "Solicitud pendiente de enlace privado"}
                </p>
                {request.orderSkuContains && <p className="mt-1 text-xs font-semibold text-black/60">Filtro: SKU contiene {request.orderSkuContains}</p>}
                {request.observation && <p className="mt-1 text-xs text-black/60">Observacion: {request.observation}</p>}
                {request.status === "installed" ? (
                  <span className="mt-2 inline-flex min-h-9 items-center justify-center rounded-md bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
                    Instalada
                  </span>
                ) : request.installLink ? (
                  <a className="focus-ring mt-2 inline-flex min-h-9 items-center justify-center rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white" href={request.installLink} target="_blank" rel="noreferrer">
                    Instalar app
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Solicitar conexion Shopify
          <input
            className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink"
            placeholder="mitienda.myshopify.com"
            value={shop}
            onChange={(event) => setShop(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Sincronizar solo si el SKU contiene (opcional)
          <input
            className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-normal uppercase text-ink"
            placeholder="Ej. ADMA"
            value={orderSkuContains}
            onChange={(event) => setOrderSkuContains(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Observacion (opcional)
          <textarea
            className="focus-ring min-h-20 rounded-md border border-black/10 px-3 py-2 text-sm font-normal text-ink"
            placeholder="Condiciones especiales para esta conexion"
            value={observation}
            onChange={(event) => setObservation(event.target.value)}
          />
        </label>
        {normalizedShop && <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">{alreadyConnected ? "Esta tienda ya esta conectada." : existingRequest?.installLink ? "El enlace privado ya esta disponible arriba." : existingRequest ? "Ya existe una solicitud pendiente para esta tienda." : `Se solicitara enlace para: ${normalizedShop}`}</p>}
        {message && <p className="rounded-md bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">{message}</p>}
        <button
          className={`focus-ring inline-flex min-h-10 items-center justify-center rounded-md px-3 py-2 text-sm font-semibold ${canRequest ? "bg-ink text-white" : "bg-field text-black/40"}`}
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

function SellerView({ state, setState, session, orderSearch, onOrderSearchChange, startDate, endDate, statusFilter, onStartDate, onEndDate, onStatusFilter }: { state: AppState; setState: (state: AppState) => void; session: Session; orderSearch: string; onOrderSearchChange: (value: string) => void; startDate: string; endDate: string; statusFilter: string; onStartDate: (value: string) => void; onEndDate: (value: string) => void; onStatusFilter: (value: string) => void }) {
  const seller = state.sellers.find((item) => item.id === session.profileId);
  const [sellerOrderTab, setSellerOrderTab] = useState<"operation" | "failed">("operation");
  if (!seller) {
    return (
      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
        <EmptyRoleState title="Perfil de vendedor pendiente" message="Tu cuenta existe, pero falta crear el perfil de vendedor. Un administrador puede completarlo o puedes registrarte nuevamente como vendedor." />
      </main>
    );
  }
  const orders = state.orders.filter((order) => order.sellerId === seller.id);
  const rangeOrders = filterOrdersByRangeStatus(orders, startDate, endDate, "all", "");
  const failedOrders = orders.filter((order) => order.status === "failed");
  const operationOrders = orders.filter((order) => order.status !== "failed");
  const tabOrders = sellerOrderTab === "failed" ? failedOrders : operationOrders;
  const visibleOrders = filterOrdersByRangeStatus(tabOrders, startDate, endDate, statusFilter, orderSearch);
  const callRescheduled = orders.filter((order) => order.callOutcome === "rescheduled");
  const deliveryScheduled = orders.filter((order) => order.status === "scheduled");
  const shopifyStores = (state.shopifyStores ?? []).filter((store) => store.sellerId === seller.id);
  const shopifyInstallRequests = (state.shopifyInstallRequests ?? []).filter((request) => request.sellerId === seller.id);
  const sellerLabelOrders = orders.filter((order) => canPrintSellerLabel(order, seller.id));
  const pendingSellerLabelOrders = sellerLabelOrders.filter((order) => !order.labelPrintedAt);
  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
      <h2 className="text-xl font-bold">Dashboard vendedor</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Metric icon={<Store size={20} />} label="Tiendas conectadas" value={String(shopifyStores.length)} />
        <Metric icon={<ClipboardList size={20} />} label="Pedidos" value={String(orders.length)} />
      </div>
      <LogisticsKpis orders={rangeOrders} />
      <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <section className="grid content-start gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-bold">Pedidos del vendedor</h2>
            <button
              className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
              type="button"
              disabled={pendingSellerLabelOrders.length === 0}
              onClick={async () => {
                await printOrderLabels(pendingSellerLabelOrders, state, "Rotulos vendedor pendientes");
                setState(markOrdersLabelsPrinted(state, pendingSellerLabelOrders, seller.id));
              }}
            >
              <Printer size={16} />
              Imprimir pendientes ({pendingSellerLabelOrders.length})
            </button>
          </div>
          <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} />
          <div className="flex flex-wrap gap-2">
            <button
              className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${sellerOrderTab === "operation" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
              type="button"
              onClick={() => setSellerOrderTab("operation")}
            >
              Operacion ({operationOrders.length})
            </button>
            <button
              className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${sellerOrderTab === "failed" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
              type="button"
              onClick={() => setSellerOrderTab("failed")}
            >
              Fallidos / reintento ({failedOrders.length})
            </button>
          </div>
          <OrderFilters startDate={startDate} endDate={endDate} status={statusFilter} onStartDate={onStartDate} onEndDate={onEndDate} onStatus={onStatusFilter} />
          {(callRescheduled.length > 0 || deliveryScheduled.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {callRescheduled.length > 0 && (
                <span className="rounded-md bg-rust/10 px-3 py-2 text-sm font-semibold text-rust">{callRescheduled.length} llamadas reprogramadas</span>
              )}
              {deliveryScheduled.length > 0 && (
                <span className="rounded-md bg-field px-3 py-2 text-sm font-semibold">{deliveryScheduled.length} entregas agendadas</span>
              )}
            </div>
          )}
          <PaginatedList items={visibleOrders} pageSize={10} empty={<EmptyRoleState title={sellerOrderTab === "failed" ? "Sin fallidos pendientes" : "Sin pedidos"} message={sellerOrderTab === "failed" ? "Los pedidos fallidos apareceran aqui para que confirmes si van a nuevo reintento." : "Cuando conectes Shopify, tus pedidos de la ciudad activa apareceran aqui."} />}>
            {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={session.profileId} compact={order.status === "delivered"} />}
          </PaginatedList>
        </section>
        <aside className="grid content-start gap-4">
          <ManualOrderPanel state={state} setState={setState} lockedSellerId={seller.id} />
          <ShopifyConnectionPanel seller={seller} stores={shopifyStores} requests={shopifyInstallRequests} state={state} setState={setState} />
          <ShopifyImportOrderPanel
            stores={shopifyStores}
            sellers={[seller]}
            lockedSellerId={seller.id}
            onImported={(order) => setState({ ...state, orders: [order, ...state.orders.filter((item) => item.id !== order.id)] })}
          />
          <ShopifySyncIssuesPanel issues={(state.shopifySyncIssues ?? []).filter((issue) => issue.sellerId === seller.id)} sellers={[seller]} />
          <DashboardWalletCard state={state} ownerType="seller" ownerId={seller.id} title="Wallet del vendedor" />
          <WalletPanel state={state} setState={setState} />
          <InventoryPanel state={state} seller={seller} />
        </aside>
      </div>
    </main>
  );
}

function InventoryPanel({ state, seller }: { state: AppState; seller: Seller }) {
  const sellerInventory = state.inventory.filter((item) => item.sellerId === seller.id);
  return (
    <Card>
      <h2 className="mb-3 font-bold">Inventario en bodega</h2>
      <PaginatedList items={sellerInventory} pageSize={6} empty={<p className="text-sm text-black/60">No hay inventario en bodega registrado.</p>}>
        {(item) => (
          <div key={item.id} className="flex items-center justify-between rounded-md border border-black/10 p-3">
            <div>
              <p className="font-semibold">{item.name}</p>
              <p className="text-sm text-black/60">{item.sku}</p>
              {item.location && <p className="text-xs text-black/50">{item.location}</p>}
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

function DriverView({ state, setState, session, orderSearch, onOrderSearchChange }: { state: AppState; setState: (state: AppState) => void; session: Session; orderSearch: string; onOrderSearchChange: (value: string) => void }) {
  const driver = state.drivers.find((item) => item.id === session.profileId);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [operationTab, setOperationTab] = useState<"all" | "rescheduled" | "failed">("all");
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
  if (!driver) {
    return (
      <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
        <EmptyRoleState title="Perfil de lider logistico pendiente" message={repairingProfile ? "Estamos reparando la asociacion de tu usuario con el perfil logistico." : repairMessage || "Tu cuenta existe, pero falta asociarla al perfil de lider logistico."} />
      </main>
    );
  }
  const assigned = state.orders.filter((order) => order.driverId === driver.id && !["delivered", "failed", "cancelled"].includes(order.status));
  const pickupPending = assigned.filter((order) => order.status === "assigned");
  const unassignedReady = state.orders.filter((order) => order.status === "ready_to_assign" && !order.driverId);
  const visiblePickupPending = pickupPending.filter((order) => orderSearchMatches(order, orderSearch));
  const visibleUnassignedReady = unassignedReady.filter((order) => orderSearchMatches(order, orderSearch));
  const pendingMessenger = assigned.filter((order) => order.status === "picked_up" && !order.messengerId);
  const messengerAssigned = assigned.filter((order) => order.messengerId);
  const rescheduledPending = assigned.filter((order) => order.status === "retry_pending" || order.callOutcome === "rescheduled");
  const failedOrders = state.orders.filter((order) => order.driverId === driver.id && order.status === "failed");
  const operationOrders = operationTab === "failed" ? failedOrders : operationTab === "rescheduled" ? rescheduledPending : assigned;
  const visibleAssigned = operationOrders.filter((order) => orderSearchMatches(order, orderSearch));
  const visibleFailedOrders = failedOrders.filter((order) => orderSearchMatches(order, orderSearch));
  const callRescheduled = assigned.filter((order) => order.callOutcome === "rescheduled");
  const deliveryScheduled = assigned.filter((order) => order.status === "scheduled");
  const rate = weeklyFailedRate(state, driver.id);
  const messengers = state.messengers.filter((messenger) => messenger.leaderDriverId === driver.id && messenger.active);

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
    <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
      {pickupOpen && <PickupScanModal state={state} driver={driver} onClose={() => setPickupOpen(false)} onCommit={commitPickup} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-bold">Dashboard transportista</h2>
        <button
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white"
          type="button"
          onClick={() => setPickupOpen(true)}
        >
          <QrCode size={16} />
          Recoger con scanner
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Bike size={20} />} label="Lider logistico" value={driver.name} />
        <Metric icon={<Route size={20} />} label="Pedidos flota" value={String(assigned.length)} />
        <Metric icon={<AlertTriangle size={20} />} label="Fallidos semana" value={`${rate.rate}%`} />
      </div>
      <DashboardWalletCard state={state} ownerType="driver" ownerId={driver.id} title="Wallet del lider logistico" />
      <EvidenceQueuePanel state={state} setState={setState} />
      <FleetMessengerPanel state={state} setState={setState} driver={driver} />
      <FleetReportsPanel state={state} driver={driver} />
      <AssignPickedUpOrdersPanel
        orders={pendingMessenger}
        messengers={messengers}
        onAssigned={(orders) => {
          setState({ ...state, orders: state.orders.map((item) => orders.find((order) => order.id === item.id) ?? item) });
          setAssignmentMessage(`${orders.length} pedido(s) asignados a mensajero.`);
        }}
      />
      {assignmentMessage && <p className="rounded-md bg-field px-3 py-2 text-sm font-semibold text-black/70">{assignmentMessage}</p>}
      <section className="grid gap-3">
        <h2 className="font-bold">Operacion de la flota</h2>
        <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <button
              className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${operationTab === "all" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
              type="button"
              onClick={() => setOperationTab("all")}
            >
              Todos ({assigned.length})
            </button>
            <button
              className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${operationTab === "rescheduled" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
              type="button"
              onClick={() => setOperationTab("rescheduled")}
            >
              Reprogramados pendientes ({rescheduledPending.length})
            </button>
            <button
              className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${operationTab === "failed" ? "bg-ink text-white" : "border border-black/10 bg-white text-ink"}`}
              type="button"
              onClick={() => setOperationTab("failed")}
            >
              Fallidos / reintento ({failedOrders.length})
            </button>
          </div>
          <button
            className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
            type="button"
            disabled={visibleFailedOrders.length === 0}
            onClick={() => downloadFailedOrdersCsv(visibleFailedOrders, state, "", "", driver.id)}
          >
            <FileDown size={16} />
            Descargar fallidos ({visibleFailedOrders.length})
          </button>
        </div>
        {(callRescheduled.length > 0 || deliveryScheduled.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {callRescheduled.length > 0 && (
              <span className="rounded-md bg-rust/10 px-3 py-2 text-sm font-semibold text-rust">{callRescheduled.length} llamadas reprogramadas</span>
            )}
            {deliveryScheduled.length > 0 && (
              <span className="rounded-md bg-field px-3 py-2 text-sm font-semibold">{deliveryScheduled.length} entregas agendadas</span>
            )}
          </div>
        )}
        <PaginatedList
          items={visibleAssigned}
          pageSize={8}
          empty={<Card><p className="text-sm text-black/60">{operationTab === "failed" ? "No hay fallidos para exportar." : operationTab === "rescheduled" ? "No hay reprogramados pendientes." : "No tienes pedidos asignados."}</p></Card>}
        >
          {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />}
        </PaginatedList>
      </section>
      <section className="grid gap-3">
        <OrderGroupHeader
          title="Pendientes de recogida"
          orders={visiblePickupPending}
          sellers={state.sellers}
          emptyHint="No tienes pedidos asignados para recoger."
        />
        <PaginatedList items={visiblePickupPending} pageSize={8} empty={<Card><p className="text-sm text-black/60">No hay pedidos pendientes de recogida.</p></Card>}>
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
        <PaginatedList items={visibleUnassignedReady} pageSize={8} empty={<Card><p className="text-sm text-black/60">No hay pedidos listos sin lider.</p></Card>}>
          {(order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />}
        </PaginatedList>
      </section>
    </main>
  );
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
    <div className="grid gap-2 rounded-md bg-field px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{title}</h2>
        <span className="rounded bg-white px-2 py-1 text-xs font-semibold">{orders.length} pedido{orders.length === 1 ? "" : "s"}</span>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-black/60">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {sellerCounts.map((seller) => (
            <span key={seller.sellerId} className="rounded bg-white px-2 py-1 text-xs font-semibold text-black/70">
              {seller.name}: {seller.count}
            </span>
          ))}
        </div>
      )}
      {helper && <p className="text-xs text-black/50">{helper}</p>}
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
  onAction
}: {
  title: string;
  orders: Order[];
  sellers: Seller[];
  icon: React.ReactNode;
  empty: string;
  helper?: string;
  actionLabel?: string;
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
          <span className="rounded-md bg-field p-2 text-ink">{icon}</span>
          <div>
            <h2 className="font-bold">{title}</h2>
            {helper && <p className="text-xs text-black/50">{helper}</p>}
          </div>
        </div>
        <span className="rounded bg-ink px-2 py-1 text-xs font-semibold text-white">{orders.length} pedido{orders.length === 1 ? "" : "s"}</span>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-black/60">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {sellerCounts.map((seller) => (
            <span key={seller.sellerId} className="rounded bg-field px-2 py-1 text-xs font-semibold text-black/70">
              {seller.name}: {seller.count}
            </span>
          ))}
        </div>
      )}
      {actionLabel && onAction && (
        <button
          className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
          type="button"
          disabled={orders.length === 0 || busy}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onAction()).finally(() => setBusy(false));
          }}
        >
          <Printer size={16} />
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
        <p className="text-sm text-black/60">El lider reparte pedidos recogidos entre estos mensajeros. La wallet sigue a nombre del lider.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Nombre mensajero" value={name} onChange={(event) => setName(event.target.value)} />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Telefono" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Correo de acceso" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Contrasena temporal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2" type="button" disabled={busy || !name.trim() || !email.trim() || password.length < 6} onClick={() => void createMessenger()}>
          Crear
        </button>
      </div>
      {message && <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/70">{message}</p>}
      <div className="grid gap-2 md:grid-cols-3">
        {messengers.map((messenger) => (
          <div key={messenger.id} className="rounded-md border border-black/10 p-3 text-sm">
            <p className="font-semibold">{messenger.name}</p>
            <p className="text-black/60">{messenger.phone || "Sin telefono"}</p>
            <p className="text-xs text-black/50">{messenger.email ? `Acceso: ${messenger.email}` : "Sin acceso de login"}</p>
            {!messenger.email && (
              <button className="focus-ring mt-2 rounded-md border border-black/10 px-3 py-2 text-xs font-semibold disabled:opacity-50" type="button" disabled={busy} onClick={() => void createAccessForMessenger(messenger)}>
                Crear acceso
              </button>
            )}
          </div>
        ))}
        {messengers.length === 0 && <p className="text-sm text-black/60">Aun no hay mensajeros para esta flota.</p>}
      </div>
    </Card>
  );
}

function FleetReportsPanel({ state, driver }: { state: AppState; driver: Driver }) {
  const orders = state.orders.filter((order) => order.driverId === driver.id);
  const messengers = state.messengers.filter((messenger) => messenger.leaderDriverId === driver.id);
  const closed = orders.filter((order) => order.status === "delivered" || order.status === "failed");
  const codCollected = orders.filter((order) => order.status === "delivered" && order.paymentMethod === "cod").reduce((sum, order) => sum + order.totalCop, 0);
  const leaderPay = state.wallet.filter((entry) => entry.ownerType === "driver" && entry.ownerId === driver.id && entry.type === "driver_earning").reduce((sum, entry) => sum + entry.amountCop, 0);
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
        <p className="text-sm text-black/60">El neto a entregar es recaudo COD menos pago registrado al lider logistico.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric icon={<PackageCheck size={20} />} label="Pedidos flota" value={String(orders.length)} />
        <Metric icon={<Check size={20} />} label="Cerrados" value={String(closed.length)} />
        <Metric icon={<Wallet size={20} />} label="Recaudo COD" value={formatCop(codCollected)} />
        <Metric icon={<CreditCard size={20} />} label="Neto a entregar" value={formatCop(codCollected - leaderPay)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="text-xs uppercase text-black/50">
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
              <tr key={row.messenger.id} className="border-t border-black/10">
                <td className="py-2 pr-3 font-semibold">{row.messenger.name}</td>
                <td className="py-2 pr-3">{row.total}</td>
                <td className="py-2 pr-3">{row.inHand}</td>
                <td className="py-2 pr-3">{row.delivered}</td>
                <td className="py-2 pr-3">{row.failed}</td>
                <td className="py-2 pr-3">{formatCop(row.cod)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-3 text-sm text-black/60">Crea mensajeros para ver reportes por persona.</p>}
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
        <p className="text-sm text-black/60">La recogida confirma custodia de la flota. El lider decide si asigna todo o solo una parte.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <select className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" value={messengerId} onChange={(event) => setMessengerId(event.target.value)}>
          {messengers.length === 0 && <option value="">Sin mensajeros</option>}
          {messengers.map((messenger) => <option key={messenger.id} value={messenger.id}>{messenger.name}</option>)}
        </select>
        <button className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm font-semibold disabled:opacity-50" type="button" disabled={!messengerId || orders.length === 0} onClick={() => void assignSelected(orders)}>
          Asignar toda la recogida
        </button>
        <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" disabled={!canAssign} onClick={() => void assignSelected(selectedOrders)}>
          Asignar seleccionados
        </button>
      </div>
      {message && <p className="rounded-md bg-rust/10 px-3 py-2 text-xs font-semibold text-rust">{message}</p>}
      <PaginatedList items={orders} pageSize={6} empty={<p className="text-sm text-black/60">No hay pedidos recogidos pendientes de asignar.</p>}>
        {(order) => (
          <label key={order.id} className="flex items-start gap-3 rounded-md border border-black/10 p-3 text-sm">
            <input type="checkbox" checked={selectedIds.includes(order.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [order.id, ...current] : current.filter((id) => id !== order.id))} />
            <span>
              <span className="block font-semibold">{order.trackingCode ?? order.shopifyOrderId}</span>
              <span className="block text-xs text-black/60">{order.customerName} · {order.pickupPointName ?? "Punto de recogida"}</span>
            </span>
          </label>
        )}
      </PaginatedList>
    </Card>
  );
}

function MessengerView({ state, setState, session, orderSearch, onOrderSearchChange }: { state: AppState; setState: (state: AppState) => void; session: Session; orderSearch: string; onOrderSearchChange: (value: string) => void }) {
  const messenger = state.messengers.find((item) => item.id === session.profileId);
  if (!messenger) {
    return (
      <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
        <EmptyRoleState title="Perfil de mensajero pendiente" message="Tu cuenta existe, pero falta asociarla a un mensajero de la flota." />
      </main>
    );
  }
  const orders = state.orders.filter((order) => order.messengerId === messenger.id && !["delivered", "failed", "cancelled"].includes(order.status));
  const visible = orders.filter((order) => orderSearchMatches(order, orderSearch));
  const delivered = state.orders.filter((order) => order.messengerId === messenger.id && order.status === "delivered").length;
  const failed = state.orders.filter((order) => order.messengerId === messenger.id && order.status === "failed").length;

  return (
    <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
      <div>
        <h2 className="text-xl font-bold">Ruta mensajero</h2>
        <p className="text-sm text-black/60">Solo ves pedidos asignados a tu usuario. La wallet la gestiona el lider logistico.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Bike size={20} />} label="Mensajero" value={messenger.name} />
        <Metric icon={<Route size={20} />} label="Activos" value={String(orders.length)} />
        <Metric icon={<Check size={20} />} label="Entregados/Fallidos" value={`${delivered}/${failed}`} />
      </div>
      <EvidenceQueuePanel state={state} setState={setState} />
      <section className="grid gap-3">
        <OrderLookupBar value={orderSearch} onChange={onOrderSearchChange} />
        <GroupedOrdersByPickup orders={visible} state={state} setState={setState} actorProfileId={messenger.id} />
      </section>
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

  if (groups.length === 0) return <Card><p className="text-sm text-black/60">No hay pedidos asignados.</p></Card>;
  return (
    <div className="grid gap-3">
      {groups.map((group) => (
        <section key={group.key} className="grid gap-2">
          <div className="rounded-md bg-field px-3 py-2">
            <p className="font-semibold">{group.name}</p>
            <p className="text-sm text-black/60">{group.address || "Direccion de recogida pendiente"}</p>
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
    <div className="border-t border-black/10 bg-white">
      <div className="mx-auto grid max-w-7xl gap-2 px-4 py-3 md:grid-cols-4">
        {latest.map((event) => (
          <p key={event.id} className="truncate text-xs text-black/60">
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
  const [orderStartDate, setOrderStartDate] = useState(dateValue(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)));
  const [orderEndDate, setOrderEndDate] = useState(dateValue(new Date()));
  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [orderSellerFilter, setOrderSellerFilter] = useState("all");
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const { state, setState, remoteEnabled } = useAppState(session);

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
          claims.role === "seller"
            ? claims.sellerId ?? account?.profileId ?? `seller-${user.uid}`
            : claims.role === "driver"
              ? claims.driverId ?? account?.profileId ?? `driver-${user.uid}`
              : claims.role === "messenger"
                ? claims.messengerId ?? account?.profileId ?? `messenger-${user.uid}`
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
    if (activeView === "wallet" && session.role !== "messenger") return <WalletPage state={state} session={session} />;
    if (activeView === "liquidations" && session.role === "admin") return <LiquidationsPage state={state} setState={setState} />;
    if (activeView === "inventory" && session.role === "admin") return <InventoryPage state={state} setState={setState} />;
    if (session.role === "seller") return <SellerView state={state} setState={setState} session={session} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} startDate={orderStartDate} endDate={orderEndDate} statusFilter={orderStatusFilter} onStartDate={setOrderStartDate} onEndDate={setOrderEndDate} onStatusFilter={setOrderStatusFilter} />;
    if (session.role === "driver") return <DriverView state={state} setState={setState} session={session} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} />;
    if (session.role === "messenger") return <MessengerView state={state} setState={setState} session={session} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} />;
    return <AdminView state={state} setState={setState} onNavigate={setActiveView} orderSearch={orderSearch} onOrderSearchChange={setOrderSearch} startDate={orderStartDate} endDate={orderEndDate} statusFilter={orderStatusFilter} sellerFilter={orderSellerFilter} onStartDate={setOrderStartDate} onEndDate={setOrderEndDate} onStatusFilter={setOrderStatusFilter} onSellerFilter={setOrderSellerFilter} />;
  }, [activeView, orderEndDate, orderSearch, orderSellerFilter, orderStartDate, orderStatusFilter, session, state, setState]);

  if (!session) return <AuthScreen onSubmit={handleAuth} needsBootstrap={needsBootstrap} />;

  return (
    <div className="min-h-screen">
      <Header session={session} remoteEnabled={remoteEnabled} onSignOut={signOut} />
      <ViewTabs activeView={activeView} onChange={setActiveView} role={session.role} />
      {view}
      <AuditBar state={state} />
    </div>
  );
}
