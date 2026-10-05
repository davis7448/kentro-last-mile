"use client";

/**
 * Spec 029 · T22 — bloque "Historial del pedido" de la tarjeta de pedido (RF_27, RF_17, RF_24; README del
 * diseno, decisiones 8-16).
 *
 * Se carga bajo demanda al abrir el bloque, nunca en el render: las vistas pintan cientos de tarjetas y una
 * llamada por tarjeta hundiria la pagina. Todo lo que se pinta sale de `buildOrderAuditTrailView`: el
 * componente no etiqueta acciones, no formatea fechas ni lee identidades del evento crudo, porque para la
 * tienda el modelo ya las quito (RF_27).
 */
import { History } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fetchFirebaseOrderAuditTrail } from "@/lib/firebase/auth";
import {
  CHANGE_LABELS,
  buildOrderAuditTrailView,
  type AuditTrailLoad,
  type AuditTrailViewer,
  type OrderAuditEventView
} from "@/lib/order-audit-trail-view";

export type OrderAuditTrailProps = {
  orderId: string;
  /** "store" para la tienda y su logistico (solo pildora de origen); "admin" ve ademas quien. */
  viewer: AuditTrailViewer;
  /** Para pintar el nombre de la ciudad en "Antes/Ahora" (nunca el id). */
  cities?: { id: string; name: string }[];
};

type Viewport = "mobile" | "desktop";

const LIST_NAME = "Cambios del pedido";
const DESKTOP_QUERY = "(min-width: 640px)";

function subscribeToViewport(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** "desktop" desde 640px; en el servidor se asume escritorio y el cliente corrige al hidratar. */
function useViewport(): Viewport {
  return useSyncExternalStore(
    subscribeToViewport,
    () => (window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "mobile"),
    () => "desktop"
  );
}

const PILL_BASE = "inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold";
const PILL_TONE: Record<OrderAuditEventView["origin"]["tone"], string> = {
  info: "border-info/50 text-info",
  muted: "border-ink-60/70 text-ink-70"
};

function OriginPill({ origin }: { origin: OrderAuditEventView["origin"] }) {
  return <span className={`${PILL_BASE} ${PILL_TONE[origin.tone]}`}>{origin.text}</span>;
}

function EventChanges({ changes, viewport }: { changes: OrderAuditEventView["changes"]; viewport: Viewport }) {
  if (changes.length === 0) return null;
  if (viewport === "desktop") {
    return (
      <table className="mt-1 w-full text-left text-xs">
        <thead className="text-ink-60">
          <tr>
            <th scope="col" className="py-1 pr-3 font-semibold">Campo</th>
            <th scope="col" className="py-1 pr-3 font-semibold">{CHANGE_LABELS.before}</th>
            <th scope="col" className="py-1 font-semibold">{CHANGE_LABELS.after}</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.label} className="border-t border-white/10 align-top">
              <th scope="row" className="py-1 pr-3 font-semibold text-ink-70">{change.label}</th>
              <td className="tabular py-1 pr-3 text-ink-60">{change.before}</td>
              <td className="tabular py-1 text-fg">{change.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <dl className="mt-1 grid gap-1.5 text-xs">
      {changes.map((change) => (
        <div key={change.label} className="grid gap-0.5">
          <dt className="font-semibold text-ink-70">{change.label}</dt>
          <dd className="tabular text-ink-60">{CHANGE_LABELS.before}: {change.before}</dd>
          <dd className="tabular text-fg">{CHANGE_LABELS.after}: {change.after}</dd>
        </div>
      ))}
    </dl>
  );
}

function EventWho({ who }: { who: OrderAuditEventView["who"] }) {
  if (!who) return null;
  return (
    <div className="grid gap-0.5 text-xs">
      <p className="text-fg">{who.line}</p>
      {who.keyLine && <p className="tabular text-ink-60">{who.keyLine}</p>}
    </div>
  );
}

function AuditEvent({ event, viewport }: { event: OrderAuditEventView; viewport: Viewport }) {
  const actionId = useId();
  const change = (
    <div className="grid gap-0.5">
      <p id={actionId} className="text-sm font-semibold text-fg">{event.actionLabel}</p>
      {event.transition && <p className="text-xs text-ink-60">{event.transition}</p>}
      {event.summary && <p className="text-xs text-ink-60">{event.summary}</p>}
      <EventChanges changes={event.changes} viewport={viewport} />
    </div>
  );

  if (viewport === "desktop") {
    return (
      <li
        aria-labelledby={actionId}
        className={`grid gap-3 border-t border-white/10 pt-2 ${event.who ? "grid-cols-[9rem_5rem_14rem_1fr]" : "grid-cols-[9rem_5rem_1fr]"}`}
      >
        <p className="tabular text-xs text-ink-70">{event.dateText}</p>
        <OriginPill origin={event.origin} />
        {event.who && <EventWho who={event.who} />}
        {change}
      </li>
    );
  }
  return (
    <li aria-labelledby={actionId} className="grid gap-1 border-l-2 border-white/10 pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="tabular text-xs font-semibold text-ink-70">{event.dateText}</p>
        <OriginPill origin={event.origin} />
      </div>
      <EventWho who={event.who} />
      {change}
    </li>
  );
}

export function OrderAuditTrail({ orderId, viewer, cities }: OrderAuditTrailProps) {
  const viewport = useViewport();
  const [isOpen, setIsOpen] = useState(false);
  const [load, setLoad] = useState<AuditTrailLoad | null>(null);
  const loadingRef = useRef(false);
  const alertTitleId = useId();
  const emptyTitleId = useId();

  const fetchTrail = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoad({ status: "loading" });
    try {
      const { events, historySince } = await fetchFirebaseOrderAuditTrail(orderId);
      setLoad({ status: "loaded", trail: { events, historySince } });
    } catch (loadError) {
      console.error("[OrderAuditTrail]", loadError);
      setLoad({ status: "error" });
    } finally {
      loadingRef.current = false;
    }
  }, [orderId]);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    // Una carga fallida se repite con "Reintentar", no al volver a abrir; una buena no se repite.
    if (next && load === null) void fetchTrail();
  };

  const cityNames = useMemo(
    () => (isOpen && cities ? Object.fromEntries(cities.map((city) => [city.id, city.name])) : undefined),
    [isOpen, cities]
  );
  const view = isOpen && load ? buildOrderAuditTrailView({ viewer, viewport, load, cityNames }) : null;

  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 bg-panel p-3">
      <button
        className="focus-ring flex min-h-11 items-center justify-between gap-2 text-left text-sm font-semibold"
        type="button"
        aria-expanded={isOpen}
        onClick={toggle}
      >
        <span className="inline-flex items-center gap-2"><History size={16} aria-hidden="true" /> Historial del pedido</span>
        <span aria-hidden="true" className="text-xs font-semibold text-ink-60">{isOpen ? "Ocultar" : "Ver cambios"}</span>
      </button>

      {view && (
        <div className="grid gap-3">
          {view.statusText && <p role="status" className="text-xs text-ink-60">{view.statusText}</p>}

          {view.alert && (
            <div role="alert" aria-labelledby={alertTitleId} className="grid gap-2 rounded-2xl border border-rust/40 bg-rust/10 p-3">
              <p id={alertTitleId} className="text-sm font-semibold text-rust">{view.alert.title}</p>
              <p className="text-xs text-ink-70">{view.alert.body}</p>
              <button
                className="focus-ring inline-flex min-h-11 w-fit items-center justify-center rounded-full bg-acid px-4 text-sm font-semibold text-deep"
                type="button"
                onClick={() => void fetchTrail()}
              >
                {view.alert.retryLabel}
              </button>
            </div>
          )}

          {view.note && (
            <div role="note" aria-label={view.note.name} className="grid gap-1 rounded-2xl border border-info/30 bg-info/10 p-3 text-xs">
              <p className="font-semibold text-fg">{view.note.title}</p>
              <p className="text-ink-70">{view.note.body}</p>
            </div>
          )}

          {view.empty && (
            <div role="status" aria-labelledby={emptyTitleId} className="grid gap-0.5 text-xs">
              <p id={emptyTitleId} className="font-semibold text-fg">{view.empty.title}</p>
              <p className="text-ink-60">{view.empty.body}</p>
            </div>
          )}

          {view.events.length > 0 && (
            <ol aria-label={LIST_NAME} className="grid gap-2">
              {view.events.map((event) => (
                <AuditEvent key={event.id} event={event} viewport={viewport} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
