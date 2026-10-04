"use client";

/**
 * Spec 026 — "Efectivo sin llegar a Kentro" para el lider (T17; README de diseno, decisiones 10, 11 y 12;
 * pantallas HU_02.finanzas, HU_02.al-dia y HU_02.error).
 *
 * Panel al inicio de Finanzas de DriverView. Complementa a "Pendiente por entregar" de Operacion, no lo
 * sustituye (P6). La cifra es `outstandingCop`: lo que el lider tiene que entregar, ya descontado su pago.
 *
 * Carga (decision 11): sin suscripcion ni cache compartida. Se pide al montarse (abrir Finanzas) y con
 * "Actualizar" / "Reintentar", siempre sin conciliacion; el callable resuelve al lider por su token.
 * Todo lo que se pinta sale del informe y de `buildCashOutstandingView`: aqui no se suma nada.
 */
import { AlertTriangle, Check, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CashOutstandingReport, CashOutstandingRow, CashSettlementLocation } from "../../functions/src/cash-outstanding";
import { getFirebaseCashOutstanding } from "@/lib/firebase/auth";
import { buildCashOutstandingView, cashLocationLabel, formatBogotaDay, type CashOutstandingViewRow } from "@/lib/cash-outstanding-view";
import { formatCop } from "@/lib/finance";

type LeaderLoad =
  | { status: "loading"; report: CashOutstandingReport | null }
  | { status: "ready"; report: CashOutstandingReport }
  | { status: "error" };

export function CashOutstandingLeaderPanel() {
  const [load, setLoad] = useState<LeaderLoad>({ status: "loading", report: null });
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isNettedOpen, setIsNettedOpen] = useState(false);
  const [pages, setPages] = useState(1);
  const requestRef = useRef(0);
  const aliveRef = useRef(true);
  const errorHeadingId = useId();
  const helpId = useId();
  const nettedTextId = useId();
  const nettedListId = useId();

  const reload = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoad((current) => ({ status: "loading", report: current.status === "error" ? null : current.report }));
    try {
      const report = await getFirebaseCashOutstanding();
      // Solo la ultima peticion manda: una respuesta vieja no pisa la pantalla.
      if (requestId !== requestRef.current || !aliveRef.current) return;
      setLoad({ status: "ready", report });
    } catch {
      if (requestId !== requestRef.current || !aliveRef.current) return;
      // Sin cifra parcial: el error borra lo anterior (README, estado Error).
      setLoad({ status: "error" });
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  const report = load.status === "error" ? null : load.report;
  const view = useMemo(() => (report ? buildCashOutstandingView(report, { viewport: "mobile", role: "leader" }) : null), [report]);
  const isLoading = load.status === "loading";

  // Primera pagina del modelo de vista; "Ver mas" amplia por paginas sobre las mismas filas del informe.
  const pageSize = view?.groups[0]?.pageSize ?? 6;
  const rows = useMemo(() => {
    if (!report || !view) return [];
    const firstPage = view.groups.flatMap((group) => group.visibleRows);
    if (pages <= 1) return firstPage;
    return [...report.rows].sort(byDeliveredAt).slice(0, pageSize * pages).map(toDisplayRow);
  }, [report, view, pages, pageSize]);
  const remainingCount = report ? Math.max(0, report.rows.length - rows.length) : 0;

  return (
    <section aria-label="Efectivo sin llegar a Kentro" className="grid min-w-0 gap-4 rounded-3xl border border-white/[0.06] bg-panel p-4 text-[15px] shadow-xl shadow-black/30 sm:p-5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">Efectivo sin llegar a Kentro</h2>
          {report && load.status !== "error" && <p className="text-sm text-ink-60">{calculatedAtLabel(report.generatedAt)}</p>}
        </div>
        {load.status !== "error" && (
          <div className="flex shrink-0 items-center gap-2">
            {view && view.summary.orderCount > 0 && (
              <button
                className="focus-ring inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/10 text-fg hover:bg-field"
                type="button"
                aria-label="Que incluye esta cifra"
                aria-expanded={isHelpOpen}
                aria-controls={helpId}
                onClick={() => setIsHelpOpen((current) => !current)}
              >
                <span aria-hidden="true" className="text-lg font-bold">?</span>
              </button>
            )}
            <button
              className="focus-ring inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/10 text-fg hover:bg-field disabled:cursor-not-allowed disabled:opacity-50"
              type="button" aria-label="Actualizar" disabled={isLoading} onClick={() => void reload()}>
              <RefreshCw size={20} aria-hidden="true" className={isLoading ? "animate-spin" : ""} />
            </button>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="grid gap-3" role="status" aria-label="Calculando el efectivo sin llegar">
          <p className="text-sm text-ink-60">Calculando el efectivo sin llegar</p>
          {!report && (
            <>
              <div className="h-10 w-44 animate-pulse rounded-2xl bg-field" />
              <div className="h-20 animate-pulse rounded-2xl bg-field" />
              <div className="h-20 animate-pulse rounded-2xl bg-field" />
            </>
          )}
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" aria-labelledby={errorHeadingId} className="grid gap-3 rounded-3xl border border-rust/30 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rust/15 text-rust" aria-hidden="true">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id={errorHeadingId} className="text-base font-bold">No se pudo cargar</h3>
              <p className="text-[15px] text-ink-70">Revisa la conexion y vuelve a intentarlo.</p>
              <p className="mt-1 text-sm text-ink-60">No mostramos una cifra a medias.</p>
            </div>
          </div>
          <button className="focus-ring min-h-14 w-full rounded-full bg-acid px-5 text-base font-semibold text-deep" type="button" onClick={() => void reload()}>
            Reintentar
          </button>
        </div>
      )}

      {report && view && (
        <>
          {view.incomplete && (
            <div className="grid gap-1 rounded-2xl border border-rust/30 p-3">
              <p className="text-[15px] font-bold text-rust">{view.incomplete.title}</p>
              <p className="text-sm text-ink-70">{view.incomplete.text}</p>
            </div>
          )}

          {view.summary.orderCount === 0 ? (
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5 text-acid" aria-hidden="true">
                <Check size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-base font-bold">Kentro tiene todo tu efectivo</p>
                <p className="text-[15px] text-ink-60">Ninguna entrega tuya espera su corte.</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-1">
              <p className="tabular text-3xl font-extrabold leading-none">{formatCop(view.summary.outstandingCop)}</p>
              <p className="text-[15px] text-ink-70">Por entregar en {pluralize(view.summary.orderCount, "pedido", "pedidos")}</p>
              {view.summary.overdueCount > 0 && (
                <p className="text-[15px] font-semibold text-rust">
                  {view.summary.overdueCount === 1
                    ? `1 lleva mas de ${report.settings.overdueDays} dias`
                    : `${view.summary.overdueCount} llevan mas de ${report.settings.overdueDays} dias`}
                </p>
              )}
              <p className="text-sm text-ink-60">Tu pago por entrega ya esta descontado</p>
            </div>
          )}

          {isHelpOpen && view.summary.orderCount > 0 && (
            <div id={helpId} className="grid gap-1 rounded-2xl bg-field p-3 text-sm text-ink-70">
              <p>
                Es el efectivo de tus contraentregas que aun no llega a Kentro en un corte, ya descontado tu pago por entrega.
              </p>
              <p>
                No coincide con Pendiente por entregar de Operacion: aquella cifra suma los cortes abiertos por su saldo guardado y el
                total del pedido.
              </p>
            </div>
          )}

          {view.netted && (
            <div className="grid gap-2 border-t border-white/[0.06] pt-3">
              <p id={nettedTextId} className="text-[15px] text-ink-70">
                {view.netted.count === 1
                  ? "1 pedido cubierto en un corte ya saldado: no debes nada por el."
                  : `${view.netted.count} pedidos cubiertos en cortes ya saldados: no debes nada por ellos.`}
              </p>
              <button
                className="focus-ring inline-flex min-h-14 w-full items-center justify-between gap-2 rounded-full border border-white/10 px-5 text-base font-semibold hover:bg-field"
                type="button"
                aria-expanded={isNettedOpen}
                aria-controls={nettedListId}
                aria-describedby={nettedTextId}
                onClick={() => setIsNettedOpen((current) => !current)}
              >
                Ver pedidos cubiertos
                <ChevronDown size={18} aria-hidden="true" className={`text-ink-60 transition-transform ${isNettedOpen ? "rotate-180" : ""}`} />
              </button>
              {isNettedOpen && (
                <ul id={nettedListId} aria-label="Pedidos cubiertos" className="grid gap-2">
                  {report.nettedRows.map((row) => (
                    <LeaderRow key={row.orderId} row={toDisplayRow(row)} />
                  ))}
                </ul>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm text-ink-60">Del mas antiguo al mas reciente</p>
              <ul aria-label="Pedidos con efectivo sin llegar" className="grid gap-2">
                {rows.map((row) => (
                  <LeaderRow key={row.orderId} row={row} />
                ))}
              </ul>
              {remainingCount > 0 && (
                <button
                  className="focus-ring min-h-14 w-full rounded-full border border-white/10 px-5 text-base font-semibold hover:bg-field"
                  type="button"
                  onClick={() => setPages((current) => current + 1)}
                >
                  {remainingCount === 1 ? "Ver el pedido restante" : `Ver ${Math.min(remainingCount, pageSize)} pedidos mas`}
                </button>
              )}
              <p className="text-sm text-ink-60">
                Si ya entregaste ese efectivo y el pedido sigue aqui, avisa al administrador con la guia del pedido.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Fila (tarjeta de calle)
// ---------------------------------------------------------------------------------------------------

const LOCATION_PILL: Record<CashSettlementLocation, string> = {
  outside_settlement: "border border-rust/60 text-rust",
  in_settlement_open: "bg-info/15 text-info",
  settlement_paid_short: "bg-rust/15 text-rust",
  covered_by_netting: "border border-ink-60/70 text-ink-70",
};

function LeaderRow({ row }: { row: CashOutstandingViewRow }) {
  const isNetted = row.location === "covered_by_netting";
  const people = [row.sellerName, row.messengerName].filter(Boolean).join(" · ");
  return (
    <li className="grid min-w-0 gap-1 rounded-2xl bg-field px-4 py-3">
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-base font-semibold">{row.trackingCode}</span>
        <span className={`tabular shrink-0 text-base font-bold ${isNetted ? "text-ink-70" : ""}`}>{formatCop(row.outstandingCop)}</span>
      </span>
      {people && <span className="block min-w-0 truncate text-sm text-ink-60">{people}</span>}
      <span className="text-sm text-ink-70">
        Entregado el {row.deliveredLabel} ·{" "}
        <span className={isNetted ? "text-ink-60" : row.isOverdue ? "font-bold text-rust" : ""}>hace {pluralize(row.ageDays, "dia", "dias")}</span>
      </span>
      <span>
        <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${LOCATION_PILL[row.location]}`}>
          {isNetted && <Check size={12} aria-hidden="true" />}
          {row.locationLabel}
        </span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------
// Ayudantes de presentacion (sin cifras: solo rotulos y fechas)
// ---------------------------------------------------------------------------------------------------

function byDeliveredAt(a: CashOutstandingRow, b: CashOutstandingRow): number {
  return a.deliveredAt < b.deliveredAt ? -1 : a.deliveredAt > b.deliveredAt ? 1 : 0;
}

function toDisplayRow(row: CashOutstandingRow): CashOutstandingViewRow {
  const deliveredAtApprox = row.deliveredAtSource === "updatedAt";
  const day = formatBogotaDay(row.deliveredAt);
  return { ...row, locationLabel: cashLocationLabel(row, "leader"), deliveredAtApprox, deliveredLabel: deliveredAtApprox ? `${day} aprox.` : day };
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
