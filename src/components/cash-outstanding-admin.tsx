"use client";

/**
 * Spec 026 — "Efectivo sin llegar" para el admin (T15; README de diseno, decisiones 2-5, 11 y 12).
 *
 * Dos piezas y una sola cache por sesion de pagina:
 *  - `CashOutstandingOverdueCard`: tarjeta "Efectivo vencido" de Operacion. Lee la carga resumen
 *    compartida (`.get`), nunca pide conciliacion.
 *  - `CashOutstandingTab`: pestana de Liquidaciones. Es la UNICA que pide la carga con conciliacion y,
 *    al llegar, la deja como compartida (`.prime`) para que tarjeta y pestana muestren el mismo momento.
 *
 * Todo lo que se pinta sale de `buildCashOutstandingView` (cifras, rotulos, grupos, plegado inicial,
 * cuadre). Aqui no se suma ni se recalcula nada: el componente solo elige que mostrar. El filtro
 * "Lider" cambia estado y el modelo de vista filtra sobre la misma carga, sin otra llamada.
 */
import { AlertTriangle, Check, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CashOutstandingReport,
  CashOutstandingRow,
  CashSettlementLocation,
  PositionReconciliation,
  ReconciliationCause,
} from "../../functions/src/cash-outstanding";
import { getFirebaseCashOutstanding } from "@/lib/firebase/auth";
import { createCashOutstandingSummaryCache } from "@/lib/cash-outstanding-loads";
import {
  NO_LEADER_FILTER,
  buildCashOutstandingView,
  cashLocationLabel,
  formatBogotaDay,
  type CashOutstandingView,
  type CashOutstandingViewGroup,
  type CashOutstandingViewNetted,
  type CashOutstandingViewRow,
  type CashViewport,
} from "@/lib/cash-outstanding-view";
import { formatCop } from "@/lib/finance";

// Una por sesion de pagina (README decision 11): la comparten la tarjeta de Operacion y la pestana.
const cashOutstandingCache = createCashOutstandingSummaryCache(getFirebaseCashOutstanding);

// "Ver efectivo sin llegar" navega a Liquidaciones, que se monta despues: esta marca le dice que abra
// la pestana. La limpia la propia pestana al montarse (idempotente frente al doble render de React).
let cashTabRequested = false;

export function requestCashOutstandingTab(): void {
  cashTabRequested = true;
}

export function isCashOutstandingTabRequested(): boolean {
  return cashTabRequested;
}

// ---------------------------------------------------------------------------------------------------
// Tarjeta de Operacion (RF_03, decision 2)
// ---------------------------------------------------------------------------------------------------

type CardLoad = { status: "loading" } | { status: "ready"; report: CashOutstandingReport } | { status: "error" };

export function CashOutstandingOverdueCard({ uid, onOpen }: { uid: string; onOpen: () => void }) {
  const [load, setLoad] = useState<CardLoad>({ status: "loading" });
  const requestRef = useRef(0);

  const read = useCallback(
    (refresh: boolean) => {
      const requestId = ++requestRef.current;
      setLoad({ status: "loading" });
      cashOutstandingCache
        .get({ uid, refresh })
        .then((report) => {
          if (requestId === requestRef.current) setLoad({ status: "ready", report });
        })
        .catch(() => {
          if (requestId === requestRef.current) setLoad({ status: "error" });
        });
    },
    [uid]
  );

  useEffect(() => {
    read(false);
    return () => {
      requestRef.current += 1;
    };
  }, [read]);

  // La tarjeta es la flota entera: el filtro y el viewport no cambian `card`.
  const card = useMemo(
    () => (load.status === "ready" ? buildCashOutstandingView(load.report, { viewport: "mobile", role: "admin" }).card : null),
    [load]
  );
  const overdueDays = load.status === "ready" ? load.report.settings.overdueDays : null;

  const open = () => {
    requestCashOutstandingTab();
    onOpen();
  };

  if (card?.isAllClear) {
    return (
      <section aria-label="Efectivo vencido" className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-3xl border border-white/[0.06] bg-panel px-4 py-3">
        <p className="tabular text-sm text-ink-60">{card.allClearText}</p>
        {card.nettedText && <p className="text-xs text-ink-60">{card.nettedText}</p>}
      </section>
    );
  }

  return (
    <section aria-label="Efectivo vencido" className="min-w-0 rounded-3xl border border-rust/20 bg-panel p-4 shadow-xl shadow-black/30 sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rust/15 text-rust" aria-hidden="true">
          <AlertTriangle size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold">Efectivo vencido</h3>
          <p className="text-xs text-ink-60">
            {overdueDays !== null ? `Mas de ${overdueDays} dias sin que el efectivo llegue` : "Contraentregas cuyo efectivo no llega"}
          </p>
        </div>
      </div>

      {load.status === "loading" && (
        <div className="mt-3 grid gap-2" role="status" aria-label="Calculando el efectivo vencido">
          <div className="h-8 w-40 animate-pulse rounded-2xl bg-field" />
          <div className="h-4 w-56 animate-pulse rounded-2xl bg-field" />
          <span className="sr-only">Calculando el efectivo vencido</span>
        </div>
      )}

      {load.status === "error" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-rust">No se pudo calcular el efectivo vencido.</p>
          <button className="focus-ring rounded-full border border-white/10 px-4 text-sm font-semibold hover:bg-field" type="button" onClick={() => read(true)}>
            Reintentar
          </button>
        </div>
      )}

      {card && (
        <div className="mt-3 grid gap-1">
          <p className="tabular text-3xl font-extrabold tracking-tight text-rust">{formatCop(card.overdueCop)}</p>
          <p className="text-sm text-ink-70">{pluralize(card.overdueCount, "contraentrega sin su efectivo", "contraentregas sin su efectivo")}</p>
          {card.topLeader && (
            <p className="text-sm text-ink-70">
              El lider con mas efectivo vencido: <span className="tabular font-semibold text-fg">{card.topLeader.text}</span>
            </p>
          )}
          {card.oldestOverdueDays !== null && (
            <p className="text-sm text-ink-60">El mas antiguo lleva {pluralize(card.oldestOverdueDays, "dia", "dias")}</p>
          )}
          {card.nettedText && <p className="text-xs text-ink-60">{card.nettedText}</p>}
          <button
            className="focus-ring mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-acid px-4 text-sm font-semibold text-deep sm:w-fit"
            type="button"
            onClick={open}
          >
            Ver efectivo sin llegar
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pestana "Efectivo sin llegar" (RF_02, RF_09; decisiones 3, 4, 5, 12)
// ---------------------------------------------------------------------------------------------------

type TabLoad =
  | { status: "loading"; report: CashOutstandingReport | null }
  | { status: "ready"; report: CashOutstandingReport }
  | { status: "error"; code: string | null; message: string };

export function CashOutstandingTab({ uid }: { uid: string }) {
  const [load, setLoad] = useState<TabLoad>({ status: "loading", report: null });
  const [leaderFilter, setLeaderFilter] = useState("");
  const viewport = useCashViewport();
  const requestRef = useRef(0);
  const aliveRef = useRef(true);
  const headingId = useId();
  const errorHeadingId = useId();

  const reload = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoad((current) => ({ status: "loading", report: current.status === "error" ? null : current.report }));
    try {
      const report = await getFirebaseCashOutstanding({ includeReconciliation: true });
      // Solo la ultima peticion manda: una respuesta vieja no pisa ni la pantalla ni la carga compartida.
      if (requestId !== requestRef.current) return;
      cashOutstandingCache.prime(uid, report);
      if (aliveRef.current) setLoad({ status: "ready", report });
    } catch (error) {
      if (requestId !== requestRef.current || !aliveRef.current) return;
      setLoad({ status: "error", ...describeError(error) });
    }
  }, [uid]);

  useEffect(() => {
    aliveRef.current = true;
    cashTabRequested = false;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  const report = load.status === "error" ? null : load.report;
  const view = useMemo(
    () => (report ? buildCashOutstandingView(report, { viewport, role: "admin", leaderFilter: leaderFilter || null }) : null),
    [report, viewport, leaderFilter]
  );
  // Solo para nombrar guias en el cuadre: no se suma nada.
  const trackingById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of [...(report?.rows ?? []), ...(report?.nettedRows ?? [])]) map.set(row.orderId, row.trackingCode);
    return map;
  }, [report]);

  const isLoading = load.status === "loading";

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={headingId}>
      <div className="flex min-w-0 flex-col gap-3 rounded-3xl border border-white/[0.06] bg-panel p-4 sm:p-5 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-bold">Efectivo sin llegar</h2>
          <p className="text-sm text-ink-60">
            Contraentregas entregadas que Kentro aun no recibe en un corte
            {report && <> · {calculatedAtLabel(report.generatedAt)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {load.status !== "error" && (
            <button
              className="focus-ring inline-flex items-center gap-2 rounded-full border border-white/10 px-4 text-sm font-semibold hover:bg-field disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={isLoading}
              onClick={() => void reload()}
            >
              <RefreshCw size={16} aria-hidden="true" className={isLoading ? "animate-spin" : ""} />
              Actualizar
            </button>
          )}
          {/* T16: aqui va el boton "Plazo y aviso" con su dialogo. */}
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-3" role="status" aria-label="Calculando el efectivo sin llegar">
          <p className="text-sm text-ink-60">Calculando el efectivo sin llegar</p>
          {!report && (
            <>
              <div className="h-24 animate-pulse rounded-3xl bg-panel" />
              <div className="h-16 animate-pulse rounded-3xl bg-panel" />
              <div className="h-16 animate-pulse rounded-3xl bg-panel" />
            </>
          )}
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" aria-labelledby={errorHeadingId} className="grid gap-2 rounded-3xl border border-rust/30 bg-panel p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rust/15 text-rust" aria-hidden="true">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id={errorHeadingId} className="text-base font-bold">No se pudo calcular el efectivo sin llegar</h3>
              <p className="text-sm text-ink-70">{load.message}</p>
              <p className="mt-1 text-sm text-ink-60">
                No mostramos cifras a medias: un total incompleto haria pensar que se debe menos de lo que se debe.
              </p>
              {load.code && <p className="mt-1 text-xs text-ink-60">Codigo: {load.code}</p>}
            </div>
          </div>
          <button
            className="focus-ring mt-2 w-full rounded-full bg-acid px-4 text-sm font-semibold text-deep sm:w-fit"
            type="button"
            onClick={() => void reload()}
          >
            Reintentar
          </button>
        </div>
      )}

      {report && view && (
        <CashOutstandingBody
          report={report}
          view={view}
          viewport={viewport}
          leaderFilter={leaderFilter}
          trackingById={trackingById}
          leaderSelect={
            <label className="grid min-w-0 gap-1 text-xs font-semibold text-ink-60 sm:w-64">
              Lider
              <select
                aria-label="Lider"
                className="focus-ring w-full min-w-0 rounded-full border border-white/10 bg-panel px-3 text-sm font-normal text-fg"
                value={leaderFilter}
                onChange={(event) => setLeaderFilter(event.target.value)}
              >
                <option value="">Todos los lideres</option>
                {report.byLeader.map((group) => (
                  <option key={group.leaderId ?? NO_LEADER_FILTER} value={group.leaderId ?? NO_LEADER_FILTER}>
                    {group.leaderId === null ? "Sin lider" : (group.leaderName ?? group.leaderId)}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      )}
    </section>
  );
}

function CashOutstandingBody({
  report,
  view,
  viewport,
  leaderFilter,
  trackingById,
  leaderSelect,
}: {
  report: CashOutstandingReport;
  view: CashOutstandingView;
  viewport: CashViewport;
  leaderFilter: string;
  trackingById: Map<string, string>;
  leaderSelect: React.ReactNode;
}) {
  const hasRows = view.groups.length > 0;
  const hasAnyRows = report.rows.length > 0;
  return (
    <>
      {view.incomplete && <IncompleteNotice incomplete={view.incomplete} />}

      {hasAnyRows && (
        <section aria-label="Resumen del efectivo sin llegar" className="grid min-w-0 gap-3 rounded-3xl border border-white/[0.06] bg-panel p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:divide-x md:divide-white/[0.06]">
            <SummaryFigure label="Sin llegar" value={formatCop(view.summary.collectedCop)} detail={pluralize(view.summary.orderCount, "pedido", "pedidos")} />
            <SummaryFigure
              label={`Vencido, mas de ${report.settings.overdueDays} dias`}
              value={formatCop(view.summary.overdueCop)}
              detail={pluralize(view.summary.overdueCount, "pedido", "pedidos")}
              tone={view.summary.overdueCop > 0 ? "rust" : "default"}
            />
            {viewport === "desktop" && (
              <>
                <SummaryFigure label="Fuera de todo corte" value={formatCop(view.summary.outsideSettlementCop)} />
                <SummaryFigure label="En un corte, sin cubrir" value={formatCop(view.summary.inUnsettledSettlementCop)} />
              </>
            )}
          </div>
          {viewport === "mobile" && (
            <p className="tabular text-xs text-ink-60">
              {formatCop(view.summary.outsideSettlementCop)} fuera de todo corte · {formatCop(view.summary.inUnsettledSettlementCop)} en un corte sin cubrir
            </p>
          )}
          {view.summary.nettedCount > 0 && (
            <p className="text-xs text-ink-60">Aparte, al final: {view.summary.nettedCount} cubiertos por compensacion</p>
          )}
          {leaderSelect}
        </section>
      )}

      {hasAnyRows && report.bySupplier.length > 0 && <SupplierWithheldCard report={report} viewport={viewport} />}

      {view.reconciliation && <ReconciliationDisclosure reconciliation={view.reconciliation} trackingById={trackingById} />}

      {!hasRows && (
        <section className="grid gap-1 rounded-3xl border border-white/[0.06] bg-panel p-5">
          {leaderFilter === "" ? (
            <>
              <h3 className="flex items-center gap-2 text-base font-bold">
                <Check size={18} aria-hidden="true" className="text-mint" />
                Todo el efectivo llego
              </h3>
              <p className="text-sm text-ink-60">
                Ninguna contraentrega entregada espera su efectivo. Las tiendas y los proveedores pueden cobrar todo lo entregado.
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-60">Este lider no tiene efectivo sin llegar.</p>
          )}
        </section>
      )}

      {hasRows && <LeaderGroups groups={view.groups} rows={report.rows} viewport={viewport} />}

      {view.netted && <NettedSection netted={view.netted} rows={report.nettedRows} leaderFilter={leaderFilter} viewport={viewport} />}
    </>
  );
}

function SummaryFigure({ label, value, detail, tone = "default" }: { label: string; value: string; detail?: string; tone?: "default" | "rust" }) {
  return (
    <div className="min-w-0 md:px-4 md:first:pl-0">
      <p className="text-xs text-ink-60">{label}</p>
      <p className={`tabular break-words text-xl font-extrabold tracking-tight sm:text-2xl ${tone === "rust" ? "text-rust" : ""}`}>{value}</p>
      {detail && <p className="text-xs text-ink-60">{detail}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Documentos ilegibles
// ---------------------------------------------------------------------------------------------------

const DOCUMENT_KIND_LABEL = { pedido: "Pedido", corte: "Corte", asiento: "Asiento" } as const;

function IncompleteNotice({ incomplete }: { incomplete: NonNullable<CashOutstandingView["incomplete"]> }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section aria-label="Documentos ilegibles" className="grid gap-2 rounded-3xl border border-rust/30 bg-panel p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rust/15 text-rust" aria-hidden="true">
          <AlertTriangle size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold">{incomplete.title}</h3>
          <p className="text-sm text-ink-70">{incomplete.text}</p>
        </div>
      </div>
      {incomplete.documents.length > 0 && (
        <>
          <button
            className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/10 px-4 text-sm font-semibold hover:bg-field sm:w-fit"
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronRight size={16} aria-hidden="true" className={`transition-transform ${open ? "rotate-90" : ""}`} />
            Ver documentos ilegibles
          </button>
          {open && (
            <ul id={listId} className="grid gap-1 text-sm">
              {incomplete.documents.map((document) => (
                <li key={`${document.kind}-${document.id}`} className="min-w-0 break-all rounded-2xl bg-field px-3 py-2">
                  <span className="font-semibold">{DOCUMENT_KIND_LABEL[document.kind]}</span> <span className="text-ink-70">{document.id}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Producto retenido a proveedores (decision 8; la linea de "Por pagar" es de T16)
// ---------------------------------------------------------------------------------------------------

function SupplierWithheldCard({ report, viewport }: { report: CashOutstandingReport; viewport: CashViewport }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const isOpen = viewport === "desktop" || open;
  // El informe ya llega ordenado por importe descendente.
  const suppliers = showAll ? report.bySupplier : report.bySupplier.slice(0, 2);
  return (
    <section aria-label="Producto retenido a proveedores" className="grid min-w-0 gap-2 rounded-3xl border border-white/[0.06] bg-panel p-4 sm:p-5">
      {viewport === "mobile" ? (
        <button
          className="focus-ring flex w-full items-center gap-2 rounded-2xl text-left text-sm font-bold"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight size={16} aria-hidden="true" className={`shrink-0 text-ink-60 transition-transform ${open ? "rotate-90" : ""}`} />
          Producto retenido a proveedores
        </button>
      ) : (
        <h3 className="text-sm font-bold">Producto retenido a proveedores</h3>
      )}
      {isOpen && (
        <div id={listId} className="grid gap-2">
          <ul className="grid gap-1">
            {suppliers.map((supplier) => (
              <li key={supplier.supplierId} className="flex min-w-0 items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-ink-70">{supplier.supplierName}</span>
                <span className="tabular shrink-0 font-semibold">{formatCop(supplier.amountCop)}</span>
              </li>
            ))}
          </ul>
          {report.bySupplier.length > 2 && (
            <button
              className="focus-ring w-full rounded-full border border-white/10 px-4 text-sm font-semibold hover:bg-field sm:w-fit"
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? "Ver solo los dos mayores" : `Ver los ${report.bySupplier.length} proveedores`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Cuadre con la posicion (decision 3)
// ---------------------------------------------------------------------------------------------------

const CAUSE_LABEL: Record<ReconciliationCause, string> = {
  outside_orders_outside_universe: "Por cobrar de pedidos que no estan en la lista",
  outside_unreadable_orders: "Pedidos ilegibles",
  outside_order_total_without_cod: "Sin asientos de recaudo; se usa el total del pedido",
  outside_negative_net: "Pedidos cuyo pago supera el recaudo",
  outside_aggregate_clamp: "Saldo agregado negativo llevado a cero",
  settlement_cash_pending_stale: "Corte con pendiente guardado desactualizado",
  settlement_cash_pending_missing: "Corte sin pendiente guardado",
  settlement_orders_received: "Pedidos del corte ya recibidos",
  settlement_orders_covered_by_netting: "Pedidos cubiertos por compensacion",
  settlement_orders_outside_universe: "Pedidos del corte que no estan en la lista",
  settlement_unreadable_orders: "Pedidos ilegibles del corte",
  settlement_orders_attributed_elsewhere: "Pedidos atribuidos a otro corte",
  settlement_order_total_without_cod: "Pedidos del corte sin asientos de recaudo",
  settlement_negative_net: "Pedidos del corte cuyo pago supera el recaudo",
  settlement_expected_clamp: "Efectivo esperado del corte llevado a cero",
  settlement_excess_received: "Efectivo recibido de mas en el corte",
  settlement_cash_received: "Efectivo ya recibido en el corte",
  settlement_allocation_over_expected: "Reparto por encima de lo esperado",
};

// Se listan aparte: un pendiente guardado viejo o ausente es para revisar, no hace fallar el cuadre.
const REVIEW_CAUSES = new Set<ReconciliationCause>(["settlement_cash_pending_stale", "settlement_cash_pending_missing"]);
const MAX_REFS = 8;

function ReconciliationDisclosure({ reconciliation, trackingById }: { reconciliation: PositionReconciliation; trackingById: Map<string, string> }) {
  const isBalanced = reconciliation.unexplainedCop === 0;
  // Si algo queda sin explicar, se abre sola; el usuario puede plegarla despues.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? !isBalanced;
  const summaryId = useId();
  const panelId = useId();
  const causes = reconciliation.causes.filter((item) => !REVIEW_CAUSES.has(item.cause));
  const review = reconciliation.causes.filter((item) => REVIEW_CAUSES.has(item.cause));
  return (
    <section className="grid min-w-0 gap-2 rounded-3xl border border-white/[0.06] bg-panel p-3 sm:p-4">
      <button
        className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-2xl text-left"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={summaryId}
        onClick={() => setOpenOverride(!open)}
      >
        <ChevronRight size={16} aria-hidden="true" className={`shrink-0 text-ink-60 transition-transform ${open ? "rotate-90" : ""}`} />
        {isBalanced ? (
          <Check size={16} aria-hidden="true" className="shrink-0 text-mint" />
        ) : (
          <AlertTriangle size={16} aria-hidden="true" className="shrink-0 text-rust" />
        )}
        <span className="min-w-0 text-sm font-bold">Cuadre con la posicion de la plataforma</span>
      </button>
      <p id={summaryId} className="tabular pl-7 text-xs text-ink-60">
        Por cobrar al domiciliario {formatCop(reconciliation.driverReceivableCop)} · lista neta del pago {formatCop(reconciliation.listOutstandingCop)} ·{" "}
        <span className={isBalanced ? "" : "font-semibold text-rust"}>sin explicar {formatCop(reconciliation.unexplainedCop)}</span>
      </p>
      {open && (
        <div id={panelId} className="grid gap-3 border-t border-white/[0.06] pt-3">
          {causes.length === 0 ? (
            <p className="text-sm text-ink-60">Sin diferencias que explicar.</p>
          ) : (
            <ul className="grid gap-2">
              {causes.map((item, index) => (
                <CauseItem key={`${item.cause}-${item.settlementId ?? ""}-${index}`} item={item} trackingById={trackingById} />
              ))}
            </ul>
          )}
          {!isBalanced && reconciliation.unexplainedOrderIds.length > 0 && (
            <p className="text-sm text-rust">Sin explicar: {refsText(reconciliation.unexplainedOrderIds, trackingById)}</p>
          )}
          {review.length > 0 && (
            <div className="grid gap-2">
              <h4 className="text-sm font-bold">Cortes para revisar</h4>
              <ul className="grid gap-2">
                {review.map((item, index) => (
                  <CauseItem key={`${item.cause}-${item.settlementId ?? ""}-${index}`} item={item} trackingById={trackingById} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CauseItem({ item, trackingById }: { item: PositionReconciliation["causes"][number]; trackingById: Map<string, string> }) {
  return (
    <li className="grid min-w-0 gap-0.5 rounded-2xl bg-field px-3 py-2 text-sm">
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0 text-ink-70">{CAUSE_LABEL[item.cause]}</span>
        <span className="tabular shrink-0 font-semibold">{formatCop(item.amountCop)}</span>
      </span>
      {(item.settlementId || item.orderIds.length > 0) && (
        <span className="min-w-0 break-words text-xs text-ink-60">
          {item.settlementId && <>Corte {item.settlementId}{item.orderIds.length > 0 ? " · " : ""}</>}
          {item.orderIds.length > 0 && refsText(item.orderIds, trackingById)}
        </span>
      )}
    </li>
  );
}

function refsText(orderIds: string[], trackingById: Map<string, string>): string {
  const shown = orderIds.slice(0, MAX_REFS).map((id) => trackingById.get(id) ?? id);
  const rest = orderIds.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} y ${rest} mas` : shown.join(", ");
}

// ---------------------------------------------------------------------------------------------------
// Grupos por lider (decision 4)
// ---------------------------------------------------------------------------------------------------

function groupKey(group: CashOutstandingViewGroup): string {
  return group.leaderId ?? NO_LEADER_FILTER;
}

/**
 * Filas de un grupo ya paginado mas las paginas extra que pidio el usuario. La primera pagina es la
 * del modelo de vista; las siguientes salen de las filas del informe (ya en `deliveredAt` asc) con los
 * mismos rotulos (`cashLocationLabel`, `formatBogotaDay`). No suma nada.
 */
function withExtraPages(firstPage: CashOutstandingViewRow[], source: CashOutstandingRow[], pageSize: number, pages: number): CashOutstandingViewRow[] {
  if (pages <= 1) return firstPage;
  const extra = source.slice(firstPage.length, pageSize * pages).map(toDisplayRow);
  return [...firstPage, ...extra];
}

function toDisplayRow(row: CashOutstandingRow): CashOutstandingViewRow {
  const deliveredAtApprox = row.deliveredAtSource === "updatedAt";
  const day = formatBogotaDay(row.deliveredAt);
  return { ...row, locationLabel: cashLocationLabel(row, "admin"), deliveredAtApprox, deliveredLabel: deliveredAtApprox ? `${day} aprox.` : day };
}

function LeaderGroups({ groups, rows, viewport }: { groups: CashOutstandingViewGroup[]; rows: CashOutstandingRow[]; viewport: CashViewport }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const toggle = (group: CashOutstandingViewGroup) => setExpanded((current) => ({ ...current, [groupKey(group)]: !(current[groupKey(group)] ?? group.expanded) }));
  const more = (group: CashOutstandingViewGroup) => setPages((current) => ({ ...current, [groupKey(group)]: (current[groupKey(group)] ?? 1) + 1 }));

  const groupState = (group: CashOutstandingViewGroup) => {
    const key = groupKey(group);
    const isOpen = expanded[key] ?? group.expanded;
    const pageCount = pages[key] ?? 1;
    const source = rows.filter((row) => (row.leaderId ?? NO_LEADER_FILTER) === key);
    const shown = isOpen ? withExtraPages(group.visibleRows, source, group.pageSize, pageCount) : [];
    const remaining = Math.max(0, group.remainingCount - (shown.length - group.visibleRows.length));
    return { isOpen, shown, remaining };
  };

  if (viewport === "desktop") {
    return (
      <div className="min-w-0 overflow-x-auto rounded-3xl border border-white/[0.06] bg-panel">
        <table aria-label="Efectivo sin llegar por lider" className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-xs text-ink-60">
            <tr className="border-b border-white/[0.06]">
              <th scope="col" className="px-4 py-3 font-semibold">Guia</th>
              <th scope="col" className="px-3 py-3 font-semibold">Tienda</th>
              <th scope="col" className="px-3 py-3 font-semibold">Mensajero</th>
              <th scope="col" className="px-3 py-3 font-semibold">Entregado</th>
              <th scope="col" className="px-3 py-3 text-right font-semibold">Dias</th>
              <th scope="col" className="px-3 py-3 font-semibold">Efectivo</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Recaudo</th>
            </tr>
          </thead>
          {groups.map((group) => {
            const { isOpen, shown, remaining } = groupState(group);
            return (
              <tbody key={groupKey(group)} className="border-b border-white/[0.06] last:border-b-0">
                <tr>
                  <td colSpan={7} className="px-2 py-1">
                    <GroupHeader group={group} isOpen={isOpen} onToggle={() => toggle(group)} />
                  </td>
                </tr>
                {shown.map((row) => (
                  <DesktopRow key={row.orderId} row={row} secondColumn={row.sellerName} thirdColumn={row.messengerName ?? "Sin mensajero"} />
                ))}
                {isOpen && remaining > 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-2">
                      <MoreButton remaining={remaining} onClick={() => more(group)} />
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    );
  }

  return (
    <ul aria-label="Efectivo sin llegar por lider" className="grid gap-3">
      {groups.map((group) => {
        const { isOpen, shown, remaining } = groupState(group);
        return (
          <li key={groupKey(group)} className="min-w-0 rounded-3xl border border-white/[0.06] bg-panel p-2">
            <GroupHeader group={group} isOpen={isOpen} onToggle={() => toggle(group)} />
            {isOpen && (
              <div className="grid gap-2 px-1 pb-1 pt-2">
                <ul className="grid gap-2">
                  {shown.map((row) => (
                    <MobileRow key={row.orderId} row={row} secondary={`${row.sellerName} · ${row.messengerName ?? "Sin mensajero"} · ${row.deliveredLabel}`} />
                  ))}
                </ul>
                {remaining > 0 && <MoreButton remaining={remaining} onClick={() => more(group)} />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GroupHeader({ group, isOpen, onToggle }: { group: CashOutstandingViewGroup; isOpen: boolean; onToggle: () => void }) {
  const since = group.visibleRows[0]?.deliveredLabel;
  const isNoLeader = group.leaderId === null;
  return (
    <h3>
      <button
        className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-2xl px-2 py-2 text-left"
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <ChevronRight size={16} aria-hidden="true" className={`shrink-0 text-ink-60 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{group.title}</span>
          <span className="block text-xs text-ink-60">
            {pluralize(group.orderCount, "pedido", "pedidos")}
            {isNoLeader ? (
              <> · <span className="text-rust">{group.note}</span></>
            ) : (
              since && <> · desde el {since}</>
            )}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="tabular block text-sm font-bold">{formatCop(group.collectedCop)}</span>
          {group.overdueCount > 0 ? (
            <span className="tabular block text-xs text-rust">
              {pluralize(group.overdueCount, "vencido", "vencidos")} · {formatCop(group.overdueCop)}
            </span>
          ) : (
            <span className="block text-xs text-ink-60">{isNoLeader ? "sin vencidos" : group.note}</span>
          )}
        </span>
      </button>
    </h3>
  );
}

function MoreButton({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  return (
    <button className="focus-ring w-full rounded-full border border-white/10 px-4 text-sm font-semibold hover:bg-field sm:w-fit" type="button" onClick={onClick}>
      {remaining === 1 ? "Ver el pedido restante" : `Ver los ${remaining} pedidos restantes`}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------
// Filas y detalle (decisiones 5, 6 y 7)
// ---------------------------------------------------------------------------------------------------

const LOCATION_PILL: Record<CashSettlementLocation, string> = {
  outside_settlement: "border border-rust/60 text-rust",
  in_settlement_open: "bg-info/15 text-info",
  settlement_paid_short: "bg-rust/15 text-rust",
  covered_by_netting: "border border-ink-60/70 text-ink-70",
};

function LocationPill({ row }: { row: CashOutstandingViewRow }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${LOCATION_PILL[row.location]}`}>
      {row.location === "covered_by_netting" && <Check size={12} aria-hidden="true" />}
      {row.locationLabel}
    </span>
  );
}

function daysClass(row: CashOutstandingViewRow): string {
  if (row.location === "covered_by_netting") return "text-ink-60";
  return row.isOverdue ? "font-bold text-rust" : "text-fg";
}

function DesktopRow({ row, secondColumn, thirdColumn }: { row: CashOutstandingViewRow; secondColumn: string; thirdColumn: string }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const isNetted = row.location === "covered_by_netting";
  return (
    <>
      <tr className="border-t border-white/[0.06]">
        <td className="px-2 py-1">
          <button
            className="focus-ring inline-flex items-center gap-1.5 rounded-full px-2 text-sm font-semibold hover:bg-field"
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronRight size={14} aria-hidden="true" className={`text-ink-60 transition-transform ${open ? "rotate-90" : ""}`} />
            {row.trackingCode}
          </button>
        </td>
        <td className="max-w-40 truncate px-3 py-2 text-ink-70">{secondColumn}</td>
        <td className="max-w-40 truncate px-3 py-2 text-ink-70">{thirdColumn}</td>
        <td className="tabular whitespace-nowrap px-3 py-2">
          {formatBogotaDay(row.deliveredAt)}
          {row.deliveredAtApprox && <span className="ml-1 text-xs text-ink-60">aprox.</span>}
        </td>
        <td className={`tabular px-3 py-2 text-right ${daysClass(row)}`}>{row.ageDays}</td>
        <td className="px-3 py-2"><LocationPill row={row} /></td>
        <td className={`tabular px-4 py-2 text-right font-semibold ${isNetted ? "text-ink-70" : ""}`}>{formatCop(row.collectedCop)}</td>
      </tr>
      {open && (
        <tr id={detailId}>
          <td colSpan={7} className="px-4 pb-3">
            <RowDetail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

function MobileRow({ row, secondary }: { row: CashOutstandingViewRow; secondary: string }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const isNetted = row.location === "covered_by_netting";
  return (
    <li className="min-w-0 rounded-2xl bg-field">
      <button
        className="focus-ring grid w-full min-w-0 gap-1 rounded-2xl px-3 py-2.5 text-left"
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{row.trackingCode}</span>
          <span className={`tabular shrink-0 text-sm font-bold ${isNetted ? "text-ink-70" : ""}`}>{formatCop(row.collectedCop)}</span>
        </span>
        <span className="block min-w-0 truncate text-xs text-ink-60">{secondary}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className={`tabular text-xs ${daysClass(row)}`}>{pluralize(row.ageDays, "dia", "dias")}</span>
          <LocationPill row={row} />
        </span>
      </button>
      {open && (
        <div id={detailId} className="px-3 pb-3">
          <RowDetail row={row} />
        </div>
      )}
    </li>
  );
}

const SETTLEMENT_STATUS_LABEL = { pending: "abierto", paid: "pagado", reconciled: "conciliado" } as const;

const DELIVERED_SOURCE_LABEL: Record<CashOutstandingRow["deliveredAtSource"], string> = {
  closedAt: "cierre del pedido",
  evidence: "evidencia de entrega",
  cod_entry: "asiento de recaudo",
  updatedAt: "ultima actualizacion del pedido (aproximada)",
};

function RowDetail({ row }: { row: CashOutstandingViewRow }) {
  // Todas las cifras vienen tal cual de la fila del informe.
  const amounts: Array<[string, number]> = [
    ["Recaudo", row.collectedCop],
    ["Pago al domiciliario", row.driverPayCop],
    ["Efectivo esperado", row.expectedCashCop],
    ["Recibido", row.receivedCop],
    ["Pendiente", row.outstandingCop],
  ];
  return (
    <div className="grid gap-2 rounded-2xl border border-white/[0.06] bg-panel p-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
        {amounts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-ink-60">{label}</dt>
            <dd className="tabular font-semibold">{formatCop(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ink-60">Fecha de entrega: {DELIVERED_SOURCE_LABEL[row.deliveredAtSource]}.</p>
      {row.collectedSource === "order_total" && <p className="text-xs text-ink-60">Sin asientos de recaudo; se usa el total del pedido.</p>}
      {row.expectedCashCop === 0 && <p className="text-xs text-ink-60">Sin efectivo esperado: su pago supera el recaudo.</p>}
      {row.settlements.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-xs font-semibold text-ink-60">Cortes que lo contienen</p>
          <ul className="grid gap-1">
            {row.settlements.map((settlement) => (
              <li key={settlement.id} className="min-w-0 break-words text-xs text-ink-70">
                Corte del {formatBogotaDay(settlement.createdAt)} · {SETTLEMENT_STATUS_LABEL[settlement.status]}
                {settlement.cashSettled ? " · saldado en total" : ""} <span className="text-ink-60">({settlement.id})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-ink-60">No esta en ningun corte.</p>
      )}
      {row.supplierWithheld.length > 0 && (
        <div className="grid gap-1">
          <p className="text-xs font-semibold text-ink-60">Producto retenido</p>
          <ul className="grid gap-1">
            {row.supplierWithheld.map((supplier) => (
              <li key={supplier.supplierId} className="flex min-w-0 justify-between gap-3 text-xs text-ink-70">
                <span className="min-w-0 truncate">{supplier.supplierName}</span>
                <span className="tabular shrink-0">{formatCop(supplier.amountCop)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Cubiertos por compensacion (decision 12)
// ---------------------------------------------------------------------------------------------------

function NettedSection({
  netted,
  rows,
  leaderFilter,
  viewport,
}: {
  netted: CashOutstandingViewNetted;
  rows: CashOutstandingRow[];
  leaderFilter: string;
  viewport: CashViewport;
}) {
  const [open, setOpen] = useState(netted.expanded);
  const [pageCount, setPageCount] = useState(1);
  const summaryId = useId();
  const panelId = useId();
  // Mismo filtro que aplico el modelo de vista, para seguir paginando sobre las mismas filas.
  const source = leaderFilter === "" ? rows : rows.filter((row) => (row.leaderId ?? NO_LEADER_FILTER) === leaderFilter);
  const shown = withExtraPages(netted.visibleRows, source, netted.pageSize, pageCount);
  const remaining = Math.max(0, netted.remainingCount - (shown.length - netted.visibleRows.length));
  return (
    <section className="grid min-w-0 gap-2 rounded-3xl border border-ink-60/30 bg-ink p-3 sm:p-4">
      <h3>
        <button
          className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-2xl text-left text-sm font-bold"
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={summaryId}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight size={16} aria-hidden="true" className={`shrink-0 text-ink-60 transition-transform ${open ? "rotate-90" : ""}`} />
          {netted.title}
        </button>
      </h3>
      <p id={summaryId} className="tabular pl-7 text-xs text-ink-60">
        {pluralize(netted.count, "pedido", "pedidos")} · {formatCop(netted.collectedCop)} · {pluralize(netted.settlementCount, "corte saldado", "cortes saldados")}
      </p>
      <div className="pl-7">
        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${LOCATION_PILL.covered_by_netting}`}>
          <Check size={12} aria-hidden="true" />
          Cubierto por compensacion
        </span>
      </div>
      <p className="pl-7 text-xs text-ink-60">
        El lider entrego todo lo que debia en estos cortes. La regla por pedido no los marca como recibidos; se corrige en la spec 027. No cuentan
        como vencidos ni avisan.
      </p>
      {open && (
        <div id={panelId} className="grid gap-2 pt-1">
          {viewport === "desktop" ? (
            <div className="min-w-0 overflow-x-auto rounded-2xl border border-white/[0.06] bg-panel">
              <table aria-label="Pedidos cubiertos por compensacion" className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs text-ink-60">
                  <tr className="border-b border-white/[0.06]">
                    <th scope="col" className="px-4 py-3 font-semibold">Guia</th>
                    <th scope="col" className="px-3 py-3 font-semibold">Lider</th>
                    <th scope="col" className="px-3 py-3 font-semibold">Tienda</th>
                    <th scope="col" className="px-3 py-3 font-semibold">Entregado</th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">Dias</th>
                    <th scope="col" className="px-3 py-3 font-semibold">Efectivo</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Recaudo</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <DesktopRow key={row.orderId} row={row} secondColumn={row.leaderName ?? "Sin lider"} thirdColumn={row.sellerName} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul aria-label="Pedidos cubiertos por compensacion" className="grid gap-2">
              {shown.map((row) => (
                <MobileRow key={row.orderId} row={row} secondary={`${row.leaderName ?? "Sin lider"} · ${row.sellerName} · ${row.deliveredLabel}`} />
              ))}
            </ul>
          )}
          {remaining > 0 && <MoreButton remaining={remaining} onClick={() => setPageCount((current) => current + 1)} />}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Utilidades de presentacion
// ---------------------------------------------------------------------------------------------------

/** Movil hasta 767px (tarjetas por fila, 6 por pagina); escritorio desde 768px (tabla, 25). */
function useCashViewport(): CashViewport {
  const [viewport, setViewport] = useState<CashViewport>("mobile");
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setViewport(query.matches ? "desktop" : "mobile");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return viewport;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Bogota es UTC-5 todo el ano (sin horario de verano), igual que en el modelo de vista.
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

function calculatedAtLabel(generatedAt: string): string {
  const time = Date.parse(generatedAt);
  if (!Number.isFinite(time)) return "";
  const bogota = new Date(time - BOGOTA_OFFSET_MS);
  const clock = `${String(bogota.getUTCHours()).padStart(2, "0")}:${String(bogota.getUTCMinutes()).padStart(2, "0")}`;
  const day = formatBogotaDay(generatedAt);
  return day === formatBogotaDay(new Date().toISOString()) ? `calculado hoy ${clock}` : `calculado el ${day} a las ${clock}`;
}

function describeError(error: unknown): { code: string | null; message: string } {
  const rawCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
  const code = typeof rawCode === "string" ? rawCode.replace(/^functions\//, "") : null;
  if (code === "deadline-exceeded") return { code, message: "El servidor no respondio a tiempo." };
  const message = error instanceof Error && error.message ? error.message : "El servidor no devolvio el calculo.";
  return { code, message };
}
