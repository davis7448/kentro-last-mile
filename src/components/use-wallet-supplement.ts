"use client";

/**
 * Spec 023, fase B: lecturas bajo demanda de la wallet para las pantallas de dinero del admin.
 *
 * Contrato comun de los hooks: `status` solo es `ready` cuando TODO lo pedido llego; mientras tanto
 * `loading`, y si una lectura falla, `failed` con su mensaje. La pantalla no pinta una cifra de dinero
 * sin `ready` (RF_04). La parte pura (como se unen y que se pide) vive en `@/lib/wallet-supplement`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WalletEntry } from "@/lib/types";
import type { SupplementStatus } from "@/lib/wallet-supplement";

export type WalletSupplement = {
  status: SupplementStatus;
  entries: WalletEntry[];
  error: string | null;
  retry: () => void;
};

const READY_EMPTY: WalletSupplement = { status: "ready", entries: [], error: null, retry: () => undefined };

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Asientos agrupados por una clave (id de pedido o id de asiento) con cache: al ampliar la lista solo se piden
 * las claves nuevas. `refreshKey` vacia la cache (p. ej. cuando cambian los cortes).
 */
function useKeyedEntries(
  keys: readonly string[] | null,
  refreshKey: string,
  load: (missing: string[]) => Promise<WalletEntry[]>,
  keyOf: (entry: WalletEntry) => string | undefined
): WalletSupplement {
  // Una "generacion" por refreshKey: su cache y lo que tiene en vuelo. Al cambiar la clave se descarta
  // entera, y una respuesta tardia de la generacion vieja no entra en la nueva.
  const generation = useRef<{ refreshKey: string; cache: Map<string, WalletEntry[]>; inflight: Set<string> }>({
    refreshKey,
    cache: new Map(),
    inflight: new Set()
  });
  if (generation.current.refreshKey !== refreshKey) {
    generation.current = { refreshKey, cache: new Map(), inflight: new Set() };
  }
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const keyList = useMemo(() => (keys ? [...new Set(keys.filter(Boolean))].sort() : null), [keys]);
  const signature = keyList ? keyList.join(",") : null;

  useEffect(() => {
    if (!keyList) return;
    const current = generation.current;
    // Lo que ya esta en cache o ya se esta pidiendo no se vuelve a pedir: cada lectura cuesta.
    const missing = keyList.filter((key) => !current.cache.has(key) && !current.inflight.has(key));
    if (missing.length === 0) return;
    for (const key of missing) current.inflight.add(key);
    setError(null);
    void load(missing)
      .then((entries) => {
        if (generation.current !== current) return;
        const grouped = new Map<string, WalletEntry[]>(missing.map((key) => [key, []]));
        for (const entry of entries) {
          const key = keyOf(entry);
          if (key && grouped.has(key)) grouped.get(key)!.push(entry);
        }
        for (const [key, group] of grouped) current.cache.set(key, group);
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setError(messageOf(reason, "No se pudieron leer los movimientos."));
      })
      .finally(() => {
        for (const key of missing) current.inflight.delete(key);
        if (generation.current === current) setVersion((value) => value + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, refreshKey, token]);

  const retry = useCallback(() => {
    setError(null);
    setToken((value) => value + 1);
  }, []);

  return useMemo(() => {
    if (!keyList) return READY_EMPTY;
    const { cache } = generation.current;
    const complete = keyList.every((key) => cache.has(key));
    return {
      status: complete ? "ready" : error ? "failed" : "loading",
      entries: complete ? keyList.flatMap((key) => cache.get(key) ?? []) : [],
      error: complete ? null : error,
      retry
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, refreshKey, version, error, retry]);
}

/** Todos los asientos (de cualquier dueno) de estos pedidos. `null` = no hace falta nada. */
export function useEntriesByOrderIds(
  orderIds: readonly string[] | null,
  refreshKey: string,
  load: (orderIds: string[]) => Promise<WalletEntry[]>
): WalletSupplement {
  return useKeyedEntries(orderIds, refreshKey, load, (entry) => entry.orderId);
}

/** Asientos por id. Un id inexistente cuenta como leido (vacio), no como pendiente. */
export function useEntriesByIds(
  entryIds: readonly string[] | null,
  refreshKey: string,
  load: (entryIds: string[]) => Promise<WalletEntry[]>
): WalletSupplement {
  return useKeyedEntries(entryIds, refreshKey, load, (entry) => entry.id);
}

/** Una lectura de una vez, identificada por `key` (`null` = no hace falta). Se repite si cambia la clave. */
export function useWalletRead(key: string | null, load: () => Promise<WalletEntry[]>): WalletSupplement {
  const [result, setResult] = useState<{ key: string; entries: WalletEntry[] } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    setError(null);
    void load()
      .then((entries) => {
        if (!cancelled) setResult({ key, entries });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError({ key, message: messageOf(reason, "No se pudieron leer los movimientos.") });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);
  const retry = useCallback(() => setToken((value) => value + 1), []);
  if (key === null) return READY_EMPTY;
  if (error?.key === key) return { status: "failed", entries: [], error: error.message, retry };
  if (result?.key === key) return { status: "ready", entries: result.entries, error: null, retry };
  return { status: "loading", entries: [], error: null, retry };
}

/** Una suscripcion en vivo mientras `active`. */
export function useWalletSubscription(
  active: boolean,
  subscribe: (onEntries: (entries: WalletEntry[]) => void, onError: (error: Error) => void) => () => void
): WalletSupplement {
  const [entries, setEntries] = useState<WalletEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!active) return;
    setEntries(null);
    setError(null);
    return subscribe(
      (next) => setEntries(next),
      (reason) => setError(messageOf(reason, "Se perdio la conexion con los movimientos."))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, token]);
  const retry = useCallback(() => setToken((value) => value + 1), []);
  if (!active) return READY_EMPTY;
  if (error) return { status: "failed", entries: [], error, retry };
  if (!entries) return { status: "loading", entries: [], error: null, retry };
  return { status: "ready", entries, error: null, retry };
}
