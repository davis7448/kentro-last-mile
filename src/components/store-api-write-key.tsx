"use client";

/**
 * Spec 029 · T20 — seccion "Clave de escritura" de una tienda (RF_25, RF_26; README de diseno, decisiones 3-7).
 *
 * Un solo componente para la tienda (dentro de `StoreApiKeyCard`) y para el admin (T21): recibe la tienda
 * y quien mira. Todo texto de estado sale de `buildWriteKeySectionView`; aqui solo se decide como se pinta
 * y que hace cada accion.
 *
 * La key completa vive SOLO en el `useState` de este componente: no va a almacenamiento del navegador, ni a
 * la URL, ni al estado global de la app. "Ya la guarde", recargar o desmontar la pierden, y es a proposito:
 * Kentro solo guarda su huella, asi que una key perdida se rota, no se recupera.
 */
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getFirebaseStoreApiKeyStatus, rotateFirebaseStoreWriteKey } from "@/lib/firebase/auth";
import { buildWriteKeySectionView, type WriteKeyActionId, type WriteKeySectionView, type WriteKeyViewer } from "@/lib/store-api-keys-view";
import type { StoreApiKeyStatus } from "@/lib/types";

export type StoreWriteKeySectionProps = {
  sellerId: string;
  viewer: WriteKeyViewer;
  /** Admin: su nombre, para "Queda registrado que la generaste tu (...)". */
  actorName?: string;
  /** Si quien monta ya tiene el estado (la lista del admin), se pinta sin volver a consultarlo. */
  initialStatus?: StoreApiKeyStatus | null;
  /** Avisa al contenedor cuando el estado cambia (generar/rotar), sin la key. */
  onStatusChange?: (status: StoreApiKeyStatus) => void;
};

type FreshKey = { writeKey: string; previousLast4: string | null };

const LOAD_ERROR_TEXT = "No se pudo consultar la clave de escritura.";
const LOAD_RETRY_LABEL = "Volver a consultar";

const PRIMARY_BUTTON =
  "focus-ring inline-flex items-center justify-center rounded-full bg-acid px-4 text-sm font-semibold text-deep disabled:cursor-not-allowed disabled:bg-field disabled:text-ink-60";
const SECONDARY_BUTTON =
  "focus-ring inline-flex items-center justify-center rounded-full border border-white/10 bg-field px-4 text-sm font-semibold text-fg hover:bg-white/10 disabled:cursor-not-allowed disabled:text-ink-60";
const DESTRUCTIVE_SECONDARY_BUTTON =
  "focus-ring inline-flex items-center justify-center rounded-full border border-white/10 bg-field px-4 text-sm font-semibold text-rust hover:bg-white/10 disabled:cursor-not-allowed disabled:text-ink-60";

function actionClass(id: WriteKeyActionId): string {
  if (id === "generate" || id === "copy" || id === "retry") return PRIMARY_BUTTON;
  if (id === "rotate") return DESTRUCTIVE_SECONDARY_BUTTON;
  return SECONDARY_BUTTON;
}

/** "Manual completo: /api-tiendas" -> rotulo y ruta, para que el enlace se llame como su destino. */
function splitManualLink(text: string): { label: string; href: string } {
  const at = text.lastIndexOf(": ");
  return at < 0 ? { label: "", href: text } : { label: text.slice(0, at + 1), href: text.slice(at + 2) };
}

/**
 * Montado con `key={sellerId}`: cambiar de tienda (el admin recorre varias) descarta todo el estado local,
 * tambien una key en claro de la tienda anterior.
 */
export function StoreWriteKeySection(props: StoreWriteKeySectionProps) {
  return <WriteKeySectionBody key={props.sellerId} {...props} />;
}

function WriteKeySectionBody({ sellerId, viewer, actorName, initialStatus = null, onStatusChange }: StoreWriteKeySectionProps) {
  const [status, setStatus] = useState<StoreApiKeyStatus | null>(initialStatus?.sellerId === sellerId ? initialStatus : null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [fresh, setFresh] = useState<FreshKey | null>(null);
  const [failure, setFailure] = useState<"generate" | "rotate" | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isRotateDialogOpen, setIsRotateDialogOpen] = useState(false);

  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const rotateButtonRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const keyFieldRef = useRef<HTMLTextAreaElement>(null);
  const keyFieldId = useId();
  const onStatusChangeRef = useRef(onStatusChange);
  // Solo la primera carga puede ahorrarse la consulta; "Volver a consultar" siempre pregunta al servidor.
  const hasInitialStatusRef = useRef(initialStatus?.sellerId === sellerId);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (loadAttempt === 0 && hasInitialStatusRef.current) return;
    let isCurrent = true;
    getFirebaseStoreApiKeyStatus({ sellerId })
      .then((loaded) => {
        if (isCurrent) setStatus(loaded);
      })
      .catch(() => {
        if (isCurrent) setLoadFailed(true);
      });
    return () => {
      isCurrent = false;
    };
  }, [sellerId, loadAttempt]);

  function reload() {
    setStatus(null);
    setLoadFailed(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  // Al aparecer la key, el foco va a "Copiar": el boton que la abrio (Generar o Rotar) ya no existe.
  useEffect(() => {
    if (fresh) copyButtonRef.current?.focus();
  }, [fresh]);

  const issueKey = useCallback(
    async (rotate: boolean) => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await rotateFirebaseStoreWriteKey({ sellerId, rotate });
        if (!aliveRef.current) return;
        setStatus(result.status);
        setCopied(false);
        setFresh({ writeKey: result.writeKey, previousLast4: result.previousLast4 });
        onStatusChangeRef.current?.(result.status);
      } catch {
        // El modelo de vista dice la verdad que importa ("sigue activa" / "no se creo ninguna"): rotar es
        // todo o nada en servidor, asi que el estado que ya se tenia sigue siendo el real.
        if (aliveRef.current) setFailure(rotate ? "rotate" : "generate");
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [sellerId]
  );

  const copyKey = useCallback(async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.writeKey);
      if (aliveRef.current) setCopied(true);
    } catch {
      // Sin portapapeles (permiso o contexto no seguro): se deja seleccionada para copiarla a mano.
      keyFieldRef.current?.focus();
      keyFieldRef.current?.select();
    }
  }, [fresh]);

  const view: WriteKeySectionView = buildWriteKeySectionView({
    viewer,
    status,
    fresh,
    error: failure,
    copied,
    actorName
  });

  function runAction(id: WriteKeyActionId) {
    if (id === "generate") void issueKey(false);
    else if (id === "rotate") setIsRotateDialogOpen(true);
    else if (id === "copy") void copyKey();
    else if (id === "saved") {
      setFresh(null);
      setCopied(false);
      rootRef.current?.focus();
    } else if (id === "retry") void issueKey(failure === "rotate");
  }

  const closeRotateDialog = useCallback(() => {
    setIsRotateDialogOpen(false);
    // El foco vuelve al boton que abrio el dialogo.
    window.setTimeout(() => rotateButtonRef.current?.focus(), 0);
  }, []);

  const rotateNow = useCallback(() => {
    setIsRotateDialogOpen(false);
    void issueKey(true);
  }, [issueKey]);

  const activeLast4 = status?.write.exists ? status.write.last4 : null;
  const manual = splitManualLink(view.manualLink);
  const isLoading = view.state === "loading";
  const isFresh = view.state === "fresh";

  return (
    <div ref={rootRef} tabIndex={-1} className="grid gap-3 outline-none" aria-busy={busy || isLoading}>
      {isLoading && !loadFailed && (
        <div className="grid gap-2" aria-hidden="true">
          <div className="h-7 w-32 animate-pulse rounded-full bg-field" />
          <div className="h-4 w-48 animate-pulse rounded-full bg-field" />
          <div className="h-4 w-40 animate-pulse rounded-full bg-field" />
        </div>
      )}

      {loadFailed && (
        <div role="alert" className="grid gap-2 rounded-2xl border border-rust/40 bg-rust/[0.08] px-3 py-2 text-sm">
          <p className="font-semibold text-rust">{LOAD_ERROR_TEXT}</p>
          <div>
            <button className={SECONDARY_BUTTON} type="button" onClick={reload}>
              {LOAD_RETRY_LABEL}
            </button>
          </div>
        </div>
      )}

      {view.pill && (
        <div>
          <span
            role="status"
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${
              view.pill.tone === "acid" ? "border-acid/70 text-acid" : "border-ink-60/70 text-ink-70"
            }`}
          >
            {view.pill.text}
          </span>
        </div>
      )}

      {view.description && <p className="text-sm text-ink-60">{view.description}</p>}

      {view.alert && (
        <div
          role="alert"
          className={`grid gap-1 rounded-2xl border px-3 py-2 text-sm ${
            isFresh ? "border-acid/70 bg-acid/[0.08]" : "border-rust/40 bg-rust/[0.08]"
          }`}
        >
          <p className={`font-bold ${isFresh ? "text-acid" : "text-rust"}`}>{view.alert.title}</p>
          {view.alert.lines.map((line) => (
            <p key={line} className="text-fg">
              {line}
            </p>
          ))}
        </div>
      )}

      {view.keyLines && (
        <div className="grid gap-1">
          <label className="text-xs font-semibold text-ink-60" htmlFor={keyFieldId}>
            Clave de escritura
          </label>
          <textarea
            ref={keyFieldRef}
            id={keyFieldId}
            className="focus-ring tabular w-full resize-none overflow-hidden rounded-2xl border border-white/10 bg-field px-3 py-2 text-sm text-fg"
            readOnly
            rows={2}
            wrap="off"
            spellCheck={false}
            value={view.keyLines.join("\n")}
          />
        </div>
      )}

      {view.rows.length > 0 && (
        <dl className="grid gap-1 text-sm">
          {view.rows.map((row) => (
            <div key={row.label} className="flex min-w-0 flex-wrap gap-x-2">
              <dt className="text-ink-60">{row.label}</dt>
              <dd className="tabular min-w-0 font-semibold text-fg">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {view.actions.length > 0 && !loadFailed && (
        <div className="flex flex-wrap gap-2">
          {view.actions.map((action) => (
            <button
              key={action.id}
              ref={action.id === "rotate" ? rotateButtonRef : action.id === "copy" ? copyButtonRef : undefined}
              className={actionClass(action.id)}
              type="button"
              disabled={action.disabled || busy}
              onClick={() => runAction(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {isFresh && (
        <p role="status" className="text-xs font-semibold text-acid">
          {view.copyStatus ?? ""}
        </p>
      )}

      {view.mutedNote && <p className="text-xs text-ink-60">{view.mutedNote}</p>}
      {view.readOnlyNote && <p className="text-xs text-ink-60">{view.readOnlyNote}</p>}

      <div className="grid gap-1 border-t border-white/10 pt-3 text-xs text-ink-60">
        <p>{view.footer}</p>
        <p>
          {manual.label}{" "}
          <a className="font-semibold text-fg underline" href={manual.href} target="_blank" rel="noreferrer">
            {manual.href}
          </a>
        </p>
      </div>

      {isRotateDialogOpen && (
        <RotateWriteKeyDialog last4={activeLast4} onCancel={closeRotateDialog} onRotate={rotateNow} />
      )}
    </div>
  );
}

/**
 * Confirmacion de rotacion (decision 5): hoja inferior en movil, modal centrado en escritorio. Sustituye a
 * `window.confirm`. El foco entra en "Cancelar", no en la accion destructiva; Escape y "Cerrar" cancelan; Tab
 * no sale del dialogo.
 */
function RotateWriteKeyDialog({ last4, onCancel, onRotate }: { last4: string | null; onCancel: () => void; onRotate: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // El padre pasa `onCancel` estable, pero por ref no se reengancha el teclado ni se roba el foco al re-render.
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    cancelButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
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

  const subject = last4 ? `La clave que termina en ${last4}` : "La clave actual";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="grid w-full gap-4 rounded-t-3xl border border-white/[0.06] bg-panel p-5 shadow-xl shadow-black/30 sm:max-w-md sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-bold">
            Rotar la clave de escritura
          </h2>
          <button
            className="focus-ring inline-flex items-center justify-center rounded-full border border-white/10 px-3 hover:bg-field"
            type="button"
            aria-label="Cerrar"
            onClick={onCancel}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm text-ink-70">
          {subject} deja de funcionar en el acto: tus integraciones reciben 401 hasta que pongas la nueva. La clave de
          lectura no cambia.
        </p>
        <div className="grid gap-2 sm:flex sm:flex-row-reverse">
          <button
            className="focus-ring inline-flex items-center justify-center rounded-full bg-rust px-4 text-sm font-semibold text-deep"
            type="button"
            onClick={onRotate}
          >
            Rotar ahora
          </button>
          <button ref={cancelButtonRef} className={SECONDARY_BUTTON} type="button" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
