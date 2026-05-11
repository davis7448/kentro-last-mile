"use client";

import {
  AlertTriangle,
  Bike,
  Boxes,
  Check,
  ClipboardList,
  CreditCard,
  ExternalLink,
  FileDown,
  Image as ImageIcon,
  LogOut,
  MapPin,
  PackageCheck,
  Phone,
  Route,
  ShieldCheck,
  Store,
  Truck,
  Wallet,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createManualFirebaseOrder,
  createFirebaseSettlement,
  createManagedFirebaseUser,
  closeFirebaseOrder,
  getFirebaseBootstrapStatus,
  signInWithFirebaseEmail,
  signOutFirebase,
  subscribeFirebaseUser,
  updateFirebaseSettlementStatus
} from "@/lib/firebase/auth";
import { firebaseEnabled } from "@/lib/firebase/client";
import { canUseFirestoreStore, loadFirestoreState, saveFirestoreOrder, saveFirestoreState, saveFirestoreWalletEntries, subscribeFirestoreState } from "@/lib/firebase/state-store";
import { uploadEvidenceImage } from "@/lib/firebase/storage";
import {
  advanceOrder,
  approvePayout,
  assignOrder,
  claimOrder,
  closeDelivered,
  closeFailed,
  confirmDeliveryWindow,
  createManualOrder,
  requestPayout,
  rescheduleCustomerCall,
  resolveAddress
} from "@/lib/actions";
import { entriesForClosedOrder, formatCop, sellerBalance, weeklyFailedRate } from "@/lib/finance";
import { getSellerShopifyConnection } from "@/lib/shopify/connection";
import { emptyState } from "@/lib/seed";
import type { AppState, Evidence, Order, Role, Seller, Settlement, WalletEntry } from "@/lib/types";

const storageKey = "ultima-milla-mvp-state";
const sessionKey = "kentro-session";
const accountsKey = "kentro-accounts";

type LocalAccount = {
  id: string;
  email: string;
  password: string;
  name: string;
  role: Role;
  profileId: string;
};
type Session = Omit<LocalAccount, "password">;
type AppView = "operations" | "wallet" | "liquidations";

function readAccounts(): LocalAccount[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(accountsKey);
  return raw ? (JSON.parse(raw) as LocalAccount[]) : [];
}

function writeAccounts(accounts: LocalAccount[]) {
  window.localStorage.setItem(accountsKey, JSON.stringify(accounts));
}

function createLocalUser(
  state: AppState,
  account: { name: string; email: string; password: string; role: Role }
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
    activeRole: account.role,
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
  account: { name: string; email: string; password: string; role: Role }
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
      profileId: localResult.account.profileId
    });
    const firebaseAccount = {
      ...localResult.account,
      id: created.uid
    };
    writeAccounts([firebaseAccount, ...readAccounts()]);
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
  const containsOldDemo = state.audit.some((event) => event.action === "seed" || event.entityId === "demo");
  return containsOldDemo ? emptyState() : state;
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
  return role === "admin" ? "Admin" : role === "seller" ? "Vendedor" : "Transportista";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
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
  if (order.status === "delivered") return "bg-mint text-white";
  if (order.status === "failed" || order.addressRisk === "review") return "bg-rust text-white";
  if (order.status === "retry_pending") return "bg-lime text-ink";
  if (order.status === "in_route" || order.status === "picked_up") return "bg-sky text-white";
  return "bg-field text-ink";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
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
          <button className="focus-ring rounded-md bg-ink px-4 py-2 font-semibold text-white disabled:opacity-50" type="submit" disabled={submitting}>
            {needsBootstrap ? "Crear administrador" : "Entrar"}
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
        <button
          className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${activeView === "wallet" ? "bg-ink text-white" : "hover:bg-field"}`}
          type="button"
          onClick={() => onChange("wallet")}
        >
          Wallet
        </button>
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
  const defaultDriver = state.drivers.find((item) => item.active) ?? state.drivers[0];
  const canDriverClaim = state.activeRole === "driver" && !order.driverId && !["delivered", "failed", "cancelled"].includes(order.status);
  const nextStep = getNextOrderStep(order);
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

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{order.shopifyOrderId}</h3>
            <span className={`rounded px-2 py-1 text-xs font-semibold ${statusTone(order)}`}>{statusLabel(order.status)}</span>
            {order.addressRisk === "review" && (
              <span className="rounded bg-rust/10 px-2 py-1 text-xs font-semibold text-rust">direccion en riesgo</span>
            )}
          </div>
          <p className="truncate text-sm text-black/70">{seller?.name} · {order.customerName}</p>
        </div>
        <p className="shrink-0 text-right text-sm font-bold">{formatCop(order.totalCop)}</p>
      </div>

      <div className="grid gap-1 text-xs text-black/70">
        <p className="flex min-w-0 gap-2"><MapPin className="shrink-0" size={14} /> <span className="truncate">{order.normalizedAddress ?? order.addressRaw}</span></p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1"><Phone size={14} /> {order.customerPhone}</span>
          <span className="inline-flex items-center gap-1"><Truck size={14} /> {driver?.name ?? "Sin transportista"}</span>
          <span>{order.paymentMethod.toUpperCase()}</span>
          <span>{order.fulfillmentMode === "warehouse" ? "Bodega" : "Recogida vendedor"}</span>
        </div>
        {(order.productName || order.sku) && <p className="flex min-w-0 gap-2"><Boxes className="shrink-0" size={14} /> <span className="truncate">{order.productName ?? order.sku}{order.productName && order.sku ? ` · ${order.sku}` : ""}</span></p>}
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
          {canDriverClaim && (
            <PrimaryActionButton onClick={() => actorProfileId && commitOrderState(claimOrder(state, order.id, actorProfileId))}>
              Tomar pedido libre
            </PrimaryActionButton>
          )}
          {state.activeRole === "admin" && order.addressRisk === "review" && (
            <PrimaryActionButton onClick={() => commitOrderState(resolveAddress(state, order.id))}>
              Aceptar direccion y dejar listo para asignar
            </PrimaryActionButton>
          )}
          {state.activeRole === "admin" && !order.driverId && defaultDriver && (
            <PrimaryActionButton onClick={() => commitOrderState(assignOrder(state, order.id, defaultDriver.id))}>
              Asignar a {defaultDriver.name}
            </PrimaryActionButton>
          )}
          {state.activeRole !== "seller" && order.driverId && nextStep && (
            <PrimaryActionButton onClick={() => commitOrderState(advanceOrder(state, order.id, nextStep.status))}>
              {nextStep.label}
            </PrimaryActionButton>
          )}
          {state.activeRole !== "seller" && order.driverId && order.status === "call_pending" && (
            <CallOutcomeControls state={state} order={order} onCommit={commitOrderState} />
          )}
          {state.activeRole !== "seller" && order.driverId && ["scheduled", "picked_up", "in_route"].includes(order.status) && (
            <CloseOrderControls state={state} order={order} onCommit={commitOrderState} onServerCommit={commitClosedOrder} />
          )}
        </div>
      )}
    </Card>
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
        <a className="focus-ring inline-flex items-center justify-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold text-ink hover:bg-field" href={item.photoUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={15} />
          Ver foto completa
        </a>
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
        void uploadEvidenceImage(order.id, file)
          .then(async (evidence) => {
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
          })
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo subir la evidencia."))
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
  const canSubmit = Boolean(file && note.trim() && reason && (!isVisitRescheduled || (scheduledDate && scheduledWindow)));

  return (
    <form
      className="grid gap-2 rounded-md border border-rust/20 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file || !canSubmit) return;
        setSubmitting(true);
        setError(null);
        void uploadEvidenceImage(order.id, file)
          .then(async (evidence) => {
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
          })
          .catch((uploadError: unknown) => setError(uploadError instanceof Error ? uploadError.message : "No se pudo subir la evidencia."))
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
          <label className="grid gap-1 text-xs font-semibold text-black/60">
            Fecha de nueva visita
            <input className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} required />
          </label>
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
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Fecha de entrega
          <input className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Franja de entrega
          <select className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink" value={scheduledWindow} onChange={(event) => setScheduledWindow(event.target.value)}>
            <option value="">Seleccionar franja</option>
            <option value="8:00 AM - 11:00 AM">8:00 AM - 11:00 AM</option>
            <option value="11:00 AM - 2:00 PM">11:00 AM - 2:00 PM</option>
            <option value="2:00 PM - 5:00 PM">2:00 PM - 5:00 PM</option>
            <option value="5:00 PM - 8:00 PM">5:00 PM - 8:00 PM</option>
          </select>
        </label>
        <button
          className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          type="button"
          disabled={!scheduledDate || !scheduledWindow}
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
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Fecha para volver a llamar
          <input
            className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink"
            type="date"
            value={rescheduledDate}
            onChange={(event) => setRescheduledDate(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Franja para volver a llamar
          <select
            className="focus-ring rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal text-ink"
            value={rescheduledWindow}
            onChange={(event) => setRescheduledWindow(event.target.value)}
          >
            <option value="">Seleccionar franja</option>
            <option value="8:00 AM - 11:00 AM">8:00 AM - 11:00 AM</option>
            <option value="11:00 AM - 2:00 PM">11:00 AM - 2:00 PM</option>
            <option value="2:00 PM - 5:00 PM">2:00 PM - 5:00 PM</option>
            <option value="5:00 PM - 8:00 PM">5:00 PM - 8:00 PM</option>
          </select>
        </label>
          <button
            className="focus-ring rounded-md border border-rust/30 bg-white px-3 py-2 text-sm font-semibold text-rust disabled:opacity-50"
            type="button"
            disabled={!rescheduledDate || !rescheduledWindow}
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

function AdminView({ state, setState, onNavigate }: { state: AppState; setState: (state: AppState) => void; onNavigate: (view: AppView) => void }) {
  const pending = state.orders.filter((order) => !["delivered", "failed", "cancelled"].includes(order.status));
  const failed = state.orders.filter((order) => order.status === "failed");
  const review = state.orders.filter((order) => order.addressRisk === "review");
  const callRescheduled = state.orders.filter((order) => order.callOutcome === "rescheduled");
  const deliveryScheduled = state.orders.filter((order) => order.status === "scheduled");
  const sellerBalances = state.sellers.map((seller) => ({ seller, balance: sellerBalance(state, seller.id) }));
  const alerts = [
    ...review.map((order) => `Direccion en revision ${order.shopifyOrderId}`),
    ...failed.filter((order) => order.retryDecision === "pending").map((order) => `Reintento pendiente ${order.shopifyOrderId}`),
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
      <div className="grid gap-3 md:grid-cols-4">
        <Metric icon={<ClipboardList size={20} />} label="Pedidos activos" value={String(pending.length)} />
        <Metric icon={<AlertTriangle size={20} />} label="Alertas" value={String(alerts.length)} />
        <Metric icon={<Wallet size={20} />} label="Wallet disponible" value={formatCop(sellerBalances.reduce((sum, item) => sum + item.balance.availableCop, 0))} />
        <Metric icon={<Boxes size={20} />} label="SKU bodega" value={String(state.inventory.length)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <section className="grid gap-3">
          <h2 className="text-base font-bold">Operacion en vivo</h2>
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
          <div className="grid gap-2 md:grid-cols-2">
            {state.orders.length === 0 && (
              <EmptyRoleState title="Sin pedidos" message="Los pedidos reales apareceran cuando conectemos Shopify y entren webhooks de tiendas autorizadas." />
            )}
            {state.orders.map((order) => <OrderCard key={order.id} order={order} state={state} setState={setState} />)}
          </div>
        </section>

        <aside className="grid content-start gap-4">
          <Card>
            <h2 className="mb-3 font-bold">Alertas internas</h2>
            <div className="grid gap-2">
              {alerts.map((alert) => (
                <p key={alert} className="rounded-md bg-rust/10 px-3 py-2 text-sm text-rust">{alert}</p>
              ))}
            </div>
          </Card>
          <ManualOrderPanel state={state} setState={setState} />
          <Card>
            <h2 className="mb-3 font-bold">Transportistas</h2>
            <div className="grid gap-2">
              {state.drivers.map((driver) => {
                const rate = weeklyFailedRate(state, driver.id);
                return (
                  <div key={driver.id} className="rounded-md border border-black/10 p-3">
                    <p className="font-semibold">{driver.name}</p>
                    <p className="text-sm text-black/60">Fallidos 7 dias: {rate.rate}% ({rate.failed}/{rate.total})</p>
                  </div>
                );
              })}
            </div>
          </Card>
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
  const sellerZones = state.zones.filter((zone) => zone.cityId === (selectedSeller?.cityId ?? state.settings.activeCityId));
  const sellerInventory = state.inventory.filter((item) => item.sellerId === sellerId);
  const selectedProduct = sellerInventory.find((item) => item.id === productId);

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
            } catch {
              setMessage("No se pudo guardar el pedido en Live. Intenta nuevamente.");
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
        <input className="focus-ring rounded-md border border-black/10 px-3 py-2 text-sm" placeholder="Numero de pedido opcional" value={shopifyOrderId} onChange={(event) => setShopifyOrderId(event.target.value)} />
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
              {sellerInventory.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>
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
        {selectedProduct && (
          <p className="rounded-md bg-field px-3 py-2 text-xs text-black/60">
            Disponible: {selectedProduct.available} · Reservado: {selectedProduct.reserved}
          </p>
        )}
        <button className="focus-ring rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={state.sellers.length === 0 || submittingOrder}>
          Crear pedido
        </button>
      </form>
      {message && <p className="mt-2 rounded-md bg-field px-3 py-2 text-sm text-black/70">{message}</p>}
    </Card>
  );
}

function AdminUsersPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("seller");
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
          void createUserFromAdmin(state, { name, email, password, role })
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
          <option value="driver">Transportista</option>
          <option value="admin">Administrador</option>
        </select>
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

function WalletPanel({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  return (
    <Card>
      <h2 className="mb-3 font-bold">Wallets vendedores</h2>
      <div className="grid gap-3">
        {state.sellers.length === 0 && <p className="text-sm text-black/60">No hay vendedores registrados todavia.</p>}
        {state.sellers.map((seller) => {
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
        })}
      </div>
      {state.payouts.length > 0 && (
        <div className="mt-4 grid gap-2">
          <h3 className="text-sm font-bold">Solicitudes</h3>
          {state.payouts.map((payout) => (
            <div key={payout.id} className="flex items-center justify-between rounded-md bg-field p-2 text-sm">
              <span>{formatCop(payout.amountCop)} · {payout.status}</span>
              {state.activeRole === "admin" && payout.status === "requested" && (
                <button className="font-semibold text-mint" onClick={() => setState(approvePayout(state, payout.id))}>Pagar</button>
              )}
            </div>
          ))}
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
      <div className="grid gap-2">
        {entries.length === 0 && <p className="text-sm text-black/60">No hay movimientos registrados todavia.</p>}
        {entries.map((entry) => (
          <WalletEntryRow key={entry.id} entry={entry} state={state} showOwner={!ownerId} />
        ))}
      </div>
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
  orders: number;
  codCop: number;
  feesCop: number;
  earningsCop: number;
  netCop: number;
  status: "pendiente" | "conciliada";
};

function dateValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isEntryInRange(entry: WalletEntry, startDate: string, endDate: string) {
  const entryDate = entry.createdAt.slice(0, 10);
  return (!startDate || entryDate >= startDate) && (!endDate || entryDate <= endDate);
}

function uniqueOrderCount(entries: WalletEntry[]) {
  return new Set(entries.map((entry) => entry.orderId).filter(Boolean)).size;
}

function buildLiquidationRows(state: AppState, entries: WalletEntry[]): LiquidationRow[] {
  const sellerRows = state.sellers.map((seller) => {
    const ownEntries = entries.filter((entry) => entry.ownerType === "seller" && entry.ownerId === seller.id);
    const codCop = ownEntries.filter((entry) => entry.type === "cod_revenue").reduce((sum, entry) => sum + entry.amountCop, 0);
    const feesCop = Math.abs(ownEntries.filter((entry) => entry.amountCop < 0).reduce((sum, entry) => sum + entry.amountCop, 0));
    const netCop = ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0);
    return {
      id: seller.id,
      name: seller.name,
      role: "seller" as const,
      walletEntryIds: ownEntries.map((entry) => entry.id),
      orders: uniqueOrderCount(ownEntries),
      codCop,
      feesCop,
      earningsCop: 0,
      netCop,
      status: netCop === 0 ? "conciliada" as const : "pendiente" as const
    };
  });

  const driverRows = state.drivers.map((driver) => {
    const ownEntries = entries.filter((entry) => entry.ownerType === "driver" && entry.ownerId === driver.id);
    const earningsCop = ownEntries.filter((entry) => entry.type === "driver_earning").reduce((sum, entry) => sum + entry.amountCop, 0);
    const netCop = ownEntries.reduce((sum, entry) => sum + entry.amountCop, 0);
    return {
      id: driver.id,
      name: driver.name,
      role: "driver" as const,
      walletEntryIds: ownEntries.map((entry) => entry.id),
      orders: uniqueOrderCount(ownEntries),
      codCop: 0,
      feesCop: 0,
      earningsCop,
      netCop,
      status: netCop === 0 ? "conciliada" as const : "pendiente" as const
    };
  });

  return [...sellerRows, ...driverRows].filter((row) => row.orders > 0 || row.netCop !== 0);
}

function csvValue(value: string | number) {
  const text = String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function downloadLiquidationsCsv(rows: LiquidationRow[], startDate: string, endDate: string) {
  const totalSellerFees = rows.filter((row) => row.role === "seller").reduce((sum, row) => sum + row.feesCop, 0);
  const totalDriverPay = rows.filter((row) => row.role === "driver").reduce((sum, row) => sum + row.earningsCop, 0);
  const platformMargin = totalSellerFees - totalDriverPay;
  const header = ["tipo", "nombre", "ordenes", "cod", "fees", "ganancias", "neto", "estado"];
  const body = rows.map((row) => [
    row.role === "seller" ? "vendedor" : "transportista",
    row.name,
    row.orders,
    row.codCop,
    row.feesCop,
    row.earningsCop,
    row.netCop,
    row.status
  ]);
  const summary = [
    [],
    ["resumen", "margen plataforma estimado", "", "", totalSellerFees, totalDriverPay, platformMargin, ""]
  ];
  const csv = [header, ...body, ...summary].map((line) => line.map(csvValue).join(",")).join("\n");
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
  const rows = buildLiquidationRows(state, entries);
  const rangeRows = buildLiquidationRows(state, rangeEntries);
  const sellerRows = rows.filter((row) => row.role === "seller");
  const driverRows = rows.filter((row) => row.role === "driver");
  const closedSettlements = [...state.settlements].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const totalCod = rangeRows.filter((row) => row.role === "seller").reduce((sum, row) => sum + row.codCop, 0);
  const totalSellerFees = rangeRows.filter((row) => row.role === "seller").reduce((sum, row) => sum + row.feesCop, 0);
  const totalDriverPay = rangeRows.filter((row) => row.role === "driver").reduce((sum, row) => sum + row.earningsCop, 0);
  const platformMargin = totalSellerFees - totalDriverPay;
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
      .then(({ settlement, walletEntries }) => mergeSettlement(settlement, walletEntries))
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
          onClick={() => downloadLiquidationsCsv(rows, startDate, endDate)}
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
        <Metric icon={<Wallet size={20} />} label="Fees vendedores" value={formatCop(totalSellerFees)} />
        <Metric icon={<Truck size={20} />} label="Pago transportistas" value={formatCop(totalDriverPay)} />
        <Metric icon={<ShieldCheck size={20} />} label="Margen plataforma" value={formatCop(platformMargin)} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Metric icon={<AlertTriangle size={20} />} label="Pendiente por conciliar" value={formatCop(totalPending)} />
        <Card>
          <h2 className="font-bold">Lectura del margen</h2>
          <p className="mt-2 text-sm text-black/60">
            Margen estimado del rango = fees cobrados a vendedores menos pagos a transportistas. Incluye movimientos pendientes y ya liquidados; no incluye otros costos operativos externos.
          </p>
        </Card>
      </div>

      <LiquidationTable title="Vendedores pendientes" rows={sellerRows} emptyMessage="No hay movimientos de vendedores sin liquidar en este rango." busyId={busyId} onClose={closeRow} />
      <LiquidationTable title="Transportistas pendientes" rows={driverRows} emptyMessage="No hay movimientos de transportistas sin liquidar en este rango." busyId={busyId} onClose={closeRow} />
      <SettlementsTable settlements={closedSettlements} busyId={busyId} onChangeStatus={changeStatus} />
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
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
                <th className="py-2 pr-3 font-semibold">Cuenta</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">COD</th>
                <th className="py-2 pr-3 font-semibold">Fees</th>
                <th className="py-2 pr-3 font-semibold">Ganancias</th>
                <th className="py-2 pr-3 font-semibold">Margen</th>
                <th className="py-2 pr-3 font-semibold">Neto</th>
                <th className="py-2 font-semibold">Estado</th>
                <th className="py-2 text-right font-semibold">Accion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.role}-${row.id}`} className="border-b border-black/5 last:border-0">
                  <td className="py-3 pr-3 font-semibold">{row.name}</td>
                  <td className="py-3 pr-3">{row.orders}</td>
                  <td className="py-3 pr-3">{formatCop(row.codCop)}</td>
                  <td className="py-3 pr-3">{formatCop(row.feesCop)}</td>
                  <td className="py-3 pr-3">{formatCop(row.earningsCop)}</td>
                  <td className={`py-3 pr-3 font-bold ${row.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(row.netCop)}</td>
                  <td className="py-3">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${row.status === "pendiente" ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <button
                      className="focus-ring rounded-md bg-ink px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                      type="button"
                      disabled={busyId === `${row.role}-${row.id}`}
                      onClick={() => onClose(row)}
                    >
                      {busyId === `${row.role}-${row.id}` ? "Cerrando..." : "Cerrar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

function SettlementsTable({
  settlements,
  busyId,
  onChangeStatus
}: {
  settlements: Settlement[];
  busyId: string | null;
  onChangeStatus: (settlement: Settlement, status: "paid" | "reconciled") => void;
}) {
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
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-normal text-black/50">
                <th className="py-2 pr-3 font-semibold">Cuenta</th>
                <th className="py-2 pr-3 font-semibold">Rango</th>
                <th className="py-2 pr-3 font-semibold">Ordenes</th>
                <th className="py-2 pr-3 font-semibold">COD</th>
                <th className="py-2 pr-3 font-semibold">Fees</th>
                <th className="py-2 pr-3 font-semibold">Pago driver</th>
                <th className="py-2 pr-3 font-semibold">Neto</th>
                <th className="py-2 pr-3 font-semibold">Estado</th>
                <th className="py-2 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((settlement) => (
                <tr key={settlement.id} className="border-b border-black/5 last:border-0">
                  <td className="py-3 pr-3">
                    <p className="font-semibold">{settlement.ownerName}</p>
                    <p className="text-xs text-black/50">{settlement.kind === "seller" ? "Vendedor" : "Transportista"}</p>
                  </td>
                  <td className="py-3 pr-3">{settlement.startDate} a {settlement.endDate}</td>
                  <td className="py-3 pr-3">{settlement.orderIds.length}</td>
                  <td className="py-3 pr-3">{formatCop(settlement.codCop)}</td>
                  <td className="py-3 pr-3">{formatCop(settlement.feesCop)}</td>
                  <td className="py-3 pr-3">{formatCop(settlement.driverPayCop)}</td>
                  <td className={`py-3 pr-3 font-bold ${settlement.platformMarginCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(settlement.platformMarginCop)}</td>
                  <td className={`py-3 pr-3 font-bold ${settlement.netCop < 0 ? "text-rust" : "text-mint"}`}>{formatCop(settlement.netCop)}</td>
                  <td className="py-3 pr-3">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${settlement.status === "pending" ? "bg-rust/10 text-rust" : "bg-mint/10 text-mint"}`}>
                      {settlementStatusLabel(settlement.status)}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-2">
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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

function SellerView({ state, setState, session }: { state: AppState; setState: (state: AppState) => void; session: Session }) {
  const seller = state.sellers.find((item) => item.id === session.profileId);
  if (!seller) {
    return (
      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
        <EmptyRoleState title="Perfil de vendedor pendiente" message="Tu cuenta existe, pero falta crear el perfil de vendedor. Un administrador puede completarlo o puedes registrarte nuevamente como vendedor." />
      </main>
    );
  }
  const orders = state.orders.filter((order) => order.sellerId === seller.id);
  const callRescheduled = orders.filter((order) => order.callOutcome === "rescheduled");
  const deliveryScheduled = orders.filter((order) => order.status === "scheduled");
  const shopify = getSellerShopifyConnection(seller.id, seller.shopDomain);
  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5">
      <h2 className="text-xl font-bold">Dashboard vendedor</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Store size={20} />} label="Tienda conectada" value={seller.shopDomain || "Pendiente"} />
        <Metric icon={<ClipboardList size={20} />} label="Pedidos" value={String(orders.length)} />
        <Metric icon={<CreditCard size={20} />} label="Cuenta" value={seller.bankAccount} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <section className="grid gap-3">
          <h2 className="font-bold">Pedidos del vendedor</h2>
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
          {orders.length === 0 && <EmptyRoleState title="Sin pedidos" message="Cuando conectes Shopify, tus pedidos de la ciudad activa apareceran aqui." />}
          {orders.map((order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={session.profileId} compact={order.status === "delivered"} />)}
        </section>
        <aside className="grid content-start gap-4">
          <ManualOrderPanel state={state} setState={setState} lockedSellerId={seller.id} />
          <Card>
            <h2 className="mb-3 font-bold">Conexion Shopify</h2>
            <div className="rounded-md border border-black/10 p-3">
              <p className="font-semibold">{shopify.shopDomain || "Tienda Shopify pendiente"}</p>
              <p className="mt-1 text-sm text-black/60">Estado: pendiente de credenciales OAuth</p>
              <p className="mt-2 text-xs text-black/50">Scopes: {shopify.requiredScopes.join(", ")}</p>
              <button
                className="focus-ring mt-3 rounded-md border border-black/10 px-3 py-2 text-sm font-semibold text-black/60"
                type="button"
                title="Pendiente de configurar Shopify App"
                disabled
              >
                Conectar tienda
              </button>
            </div>
          </Card>
          <WalletPanel state={state} setState={setState} />
          <InventoryPanel state={state} seller={seller} />
        </aside>
      </div>
    </main>
  );
}

function InventoryPanel({ state, seller }: { state: AppState; seller: Seller }) {
  return (
    <Card>
      <h2 className="mb-3 font-bold">Inventario en bodega</h2>
      <div className="grid gap-2">
        {state.inventory.filter((item) => item.sellerId === seller.id).length === 0 && (
          <p className="text-sm text-black/60">No hay inventario en bodega registrado.</p>
        )}
        {state.inventory.filter((item) => item.sellerId === seller.id).map((item) => (
          <div key={item.id} className="flex items-center justify-between rounded-md border border-black/10 p-3">
            <div>
              <p className="font-semibold">{item.name}</p>
              <p className="text-sm text-black/60">{item.sku}</p>
            </div>
            <p className="text-right text-sm"><b>{item.available}</b> disp.<br />{item.reserved} res.</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function DriverView({ state, setState, session }: { state: AppState; setState: (state: AppState) => void; session: Session }) {
  const driver = state.drivers.find((item) => item.id === session.profileId);
  if (!driver) {
    return (
      <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
        <EmptyRoleState title="Perfil de transportista pendiente" message="Tu cuenta existe, pero falta crear el perfil de transportista. Un administrador puede completarlo o puedes registrarte nuevamente como transportista." />
      </main>
    );
  }
  const assigned = state.orders.filter((order) => order.driverId === driver.id && !["delivered", "failed", "cancelled"].includes(order.status));
  const free = state.orders.filter((order) => !order.driverId && !["delivered", "failed", "cancelled"].includes(order.status));
  const callRescheduled = assigned.filter((order) => order.callOutcome === "rescheduled");
  const deliveryScheduled = assigned.filter((order) => order.status === "scheduled");
  const rate = weeklyFailedRate(state, driver.id);

  return (
    <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
      <h2 className="text-xl font-bold">Dashboard transportista</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Metric icon={<Bike size={20} />} label="Transportista" value={driver.name} />
        <Metric icon={<Route size={20} />} label="Ruta activa" value={String(assigned.length)} />
        <Metric icon={<AlertTriangle size={20} />} label="Fallidos semana" value={`${rate.rate}%`} />
      </div>
      <section className="grid gap-3">
        <h2 className="font-bold">Mi ruta</h2>
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
        {assigned.length === 0 && <Card><p className="text-sm text-black/60">No tienes pedidos asignados.</p></Card>}
        {assigned.map((order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />)}
      </section>
      <section className="grid gap-3">
        <h2 className="font-bold">Pedidos libres</h2>
        {free.length === 0 && <Card><p className="text-sm text-black/60">No hay pedidos libres disponibles.</p></Card>}
        {free.map((order) => <OrderCard key={order.id} order={order} state={state} setState={setState} actorProfileId={driver.id} />)}
      </section>
    </main>
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
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const { state, setState, remoteEnabled } = useAppState(session);

  useEffect(() => {
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
    if (activeView === "wallet") return <WalletPage state={state} session={session} />;
    if (activeView === "liquidations" && session.role === "admin") return <LiquidationsPage state={state} setState={setState} />;
    if (session.role === "seller") return <SellerView state={state} setState={setState} session={session} />;
    if (session.role === "driver") return <DriverView state={state} setState={setState} session={session} />;
    return <AdminView state={state} setState={setState} onNavigate={setActiveView} />;
  }, [activeView, session, state, setState]);

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
