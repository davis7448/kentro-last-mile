"use client";

/**
 * Spec 029 · T21 — panel "Claves de API de tiendas" del admin (RF_25, RF_26; README de diseno, decisiones 2 y 4).
 *
 * Lista el estado de las claves de cada tienda (tabla en escritorio, tarjetas en movil) y abre la gestion de la
 * clave de escritura de una tienda en un dialogo. Generar/rotar NO se reimplementa aqui: el dialogo monta
 * `StoreWriteKeySection` (T20) con `viewer="admin"`, que es quien tiene la key en claro y solo en su estado.
 *
 * La columna "Lectura" es solo estado (el texto del modelo de vista): este panel nunca lee ni pinta la clave de
 * lectura. Todo texto derivado (resumen, rango de paginas, nombres accesibles) sale de `buildAdminKeysListView`.
 */
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { listFirebaseStoreApiKeys } from "@/lib/firebase/auth";
import { buildAdminKeysListView, type AdminKeyRow } from "@/lib/store-api-keys-view";
import type { StoreApiKeyStatus } from "@/lib/types";
import { StoreWriteKeySection } from "./store-api-write-key";

export type StoreApiKeysAdminPanelProps = {
  /** Nombre del admin, para "Queda registrado que la generaste tu (...)". */
  actorName?: string;
};

const TABLE_NAME = "Claves de API por tienda";
const LOAD_ERROR_TEXT = "No se pudieron consultar las claves de las tiendas.";
const DESKTOP_QUERY = "(min-width: 640px)";

const ROW_BUTTON =
  "focus-ring inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-field px-4 text-sm font-semibold text-fg hover:bg-white/10";
const PAGER_BUTTON =
  "focus-ring inline-flex min-h-11 items-center justify-center gap-1 rounded-full border border-white/10 bg-field px-4 text-sm font-semibold text-fg hover:bg-white/10 disabled:cursor-not-allowed disabled:text-ink-60";

function subscribeToViewport(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** "desktop" desde 640px; en el servidor se asume escritorio y el cliente corrige al hidratar. */
function useViewport(): "desktop" | "mobile" {
  return useSyncExternalStore(
    subscribeToViewport,
    () => (window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "mobile"),
    () => "desktop"
  );
}

export function StoreApiKeysAdminPanel({ actorName }: StoreApiKeysAdminPanelProps) {
  const [statuses, setStatuses] = useState<StoreApiKeyStatus[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [managedSellerId, setManagedSellerId] = useState<string | null>(null);
  const searchId = useId();
  const viewport = useViewport();
  // Boton que abrio el dialogo, para devolverle el foco al cerrarlo.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let isCurrent = true;
    listFirebaseStoreApiKeys()
      .then((loaded) => {
        if (isCurrent) setStatuses(loaded);
      })
      .catch(() => {
        if (isCurrent) setLoadFailed(true);
      });
    return () => {
      isCurrent = false;
    };
  }, [loadAttempt]);

  function reload() {
    setStatuses(null);
    setLoadFailed(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  // Generar/rotar refresca solo la fila de esa tienda; la key en claro nunca llega aqui.
  const replaceStatus = useCallback((next: StoreApiKeyStatus) => {
    setStatuses((current) => current?.map((status) => (status.sellerId === next.sellerId ? next : status)) ?? current);
  }, []);

  const closeDialog = useCallback(() => {
    setManagedSellerId(null);
    window.setTimeout(() => openerRef.current?.focus(), 0);
  }, []);

  function openManagement(row: AdminKeyRow, opener: HTMLElement) {
    openerRef.current = opener;
    setManagedSellerId(row.sellerId);
  }

  const view = statuses ? buildAdminKeysListView(statuses, { query, page, viewport }) : null;
  const managed = managedSellerId ? statuses?.find((status) => status.sellerId === managedSellerId) ?? null : null;

  return (
    <section className="grid min-w-0 gap-3 rounded-3xl border border-white/[0.06] bg-panel p-4 sm:p-5" aria-busy={!statuses && !loadFailed}>
      {view && <p className="text-sm font-semibold text-fg">{view.summary}</p>}

      {!statuses && !loadFailed && (
        <div className="grid gap-2" aria-hidden="true">
          <div className="h-11 w-full animate-pulse rounded-full bg-field" />
          <div className="h-12 w-full animate-pulse rounded-2xl bg-field" />
          <div className="h-12 w-full animate-pulse rounded-2xl bg-field" />
        </div>
      )}

      {loadFailed && (
        <div role="alert" className="grid gap-2 rounded-2xl border border-rust/40 bg-rust/[0.08] px-3 py-2 text-sm">
          <p className="font-semibold text-rust">{LOAD_ERROR_TEXT}</p>
          <div>
            <button className={ROW_BUTTON} type="button" onClick={reload}>
              Reintentar
            </button>
          </div>
        </div>
      )}

      {view && (
        <>
          <div className="grid gap-1">
            <label className="text-xs font-semibold text-ink-60" htmlFor={searchId}>
              Buscar tienda
            </label>
            <input
              id={searchId}
              className="focus-ring min-h-11 w-full rounded-full border border-white/10 bg-field px-4 text-sm text-fg placeholder:text-ink-60"
              type="search"
              value={query}
              placeholder="Nombre de la tienda"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </div>

          {view.rows.length === 0 ? (
            <p className="text-sm text-ink-60">Ninguna tienda coincide con la busqueda.</p>
          ) : viewport === "desktop" ? (
            <KeysTable rows={view.rows} onManage={openManagement} />
          ) : (
            <KeysCards rows={view.rows} onManage={openManagement} />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tabular text-xs text-ink-60">{view.rangeText}</p>
            <div className="flex gap-2">
              <button className={PAGER_BUTTON} type="button" disabled={!view.hasPrevious} onClick={() => setPage(view.page - 1)}>
                <ChevronLeft size={16} aria-hidden="true" />
                Anterior
              </button>
              <button className={PAGER_BUTTON} type="button" disabled={!view.hasNext} onClick={() => setPage(view.page + 1)}>
                Siguiente
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}

      {managed && (
        <WriteKeyDialog sellerName={managed.sellerName} onClose={closeDialog}>
          <StoreWriteKeySection
            sellerId={managed.sellerId}
            viewer="admin"
            actorName={actorName}
            initialStatus={managed}
            onStatusChange={replaceStatus}
          />
        </WriteKeyDialog>
      )}
    </section>
  );
}

type RowsProps = { rows: AdminKeyRow[]; onManage: (row: AdminKeyRow, opener: HTMLElement) => void };

function RowAction({ row, onManage }: { row: AdminKeyRow; onManage: RowsProps["onManage"] }) {
  return (
    <button
      className={ROW_BUTTON}
      type="button"
      aria-label={row.action.accessibleName}
      onClick={(event) => onManage(row, event.currentTarget)}
    >
      {row.action.label}
    </button>
  );
}

function WriteCell({ row }: { row: AdminKeyRow }) {
  return (
    <span className="grid">
      <span className={row.writeDetail ? "font-semibold text-acid" : "text-ink-60"}>{row.writeText}</span>
      {row.writeDetail && <span className="tabular text-xs text-ink-60">{row.writeDetail}</span>}
    </span>
  );
}

function GeneratedCell({ row }: { row: AdminKeyRow }) {
  if (!row.generatedText) return <span className="text-ink-60">—</span>;
  return (
    <span className="grid">
      <span className="tabular">{row.generatedText}</span>
      {row.generatedBy && <span className="text-xs text-ink-60">por {row.generatedBy}</span>}
    </span>
  );
}

function KeysTable({ rows, onManage }: RowsProps) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{TABLE_NAME}</caption>
        <thead className="text-xs text-ink-60">
          <tr className="border-b border-white/10">
            <th scope="col" className="py-2 pr-3 font-semibold">Tienda</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Lectura</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Escritura</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Generada</th>
            <th scope="col" className="py-2 font-semibold">
              <span className="sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sellerId} className="border-b border-white/[0.06] last:border-0">
              <th scope="row" className="py-2 pr-3 font-semibold">{row.sellerName}</th>
              <td className="py-2 pr-3 text-ink-70">{row.readText}</td>
              <td className="py-2 pr-3"><WriteCell row={row} /></td>
              <td className="py-2 pr-3"><GeneratedCell row={row} /></td>
              <td className="py-2 text-right"><RowAction row={row} onManage={onManage} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeysCards({ rows, onManage }: RowsProps) {
  return (
    <ul className="grid gap-2" aria-label={TABLE_NAME}>
      {rows.map((row) => (
        <li key={row.sellerId} className="grid gap-2 rounded-2xl bg-field p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 font-semibold">{row.sellerName}</p>
            <RowAction row={row} onManage={onManage} />
          </div>
          <dl className="grid gap-1">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-60">Lectura</dt>
              <dd className="text-ink-70">{row.readText}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-60">Escritura</dt>
              <dd><WriteCell row={row} /></dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-60">Generada</dt>
              <dd><GeneratedCell row={row} /></dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/**
 * Dialogo de gestion de una tienda (`HU_04.admin-recien-generada`): hoja inferior en movil, modal en
 * escritorio. Cerrarlo desmonta la seccion y con ella la key en claro, a proposito (decision 4). Si la seccion
 * abre su propio dialogo (confirmar rotacion), Escape y Tab son de ese dialogo, no de este.
 */
function WriteKeyDialog({ sellerName, onClose, children }: { sellerName: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || event.defaultPrevented || dialog.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea, input, [tabindex]:not([tabindex="-1"])')
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const title = `Clave de escritura de ${sellerName}`;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="grid max-h-[90vh] w-full gap-4 overflow-y-auto rounded-t-3xl border border-white/[0.06] bg-panel p-5 shadow-xl shadow-black/30 sm:max-w-lg sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            className="focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 hover:bg-field"
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
