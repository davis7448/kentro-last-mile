/**
 * Spec 026 — cargas de "Efectivo sin llegar" en el cliente (`src/lib/cash-outstanding-loads.ts`).
 *
 * Un bloque `describe("T<n> · ...")` por tarea (plan 5.2): T14 (cache de la carga compartida) y T16
 * (recarga tras guardar ajustes). No editar los bloques de otra tarea.
 *
 * La llamada al servidor se inyecta (plan 2.1): `fetchReport` es un falso, sin `vi.mock` de `auth.ts`.
 *
 * Contrato T14:
 *   createCashOutstandingSummaryCache(fetchReport) -> {
 *     get({ uid, refresh? }): Promise<CashOutstandingReport>   // una peticion por uid; refresh fuerza otra
 *     prime(uid, report): void                                 // la carga con conciliacion sustituye
 *     clear(): void
 *   }
 *   fetchReport siempre se llama con { includeReconciliation: false } (carga resumen).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CashOutstandingReport } from "../../functions/src/cash-outstanding";

type LoadsModule = typeof import("./cash-outstanding-loads");
const loadLoads = (): Promise<LoadsModule> => import("./cash-outstanding-loads");

const repoFile = (relative: string) => readFileSync(resolve(__dirname, "../..", relative), "utf8");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function fakeReport(tag: string): CashOutstandingReport {
  return { generatedAt: tag, mode: "summary" } as unknown as CashOutstandingReport;
}

type FetchInput = { includeReconciliation: boolean };

/** `fetchReport` falso: cuenta llamadas y devuelve un informe distinto en cada una. */
function fakeFetch() {
  const calls: FetchInput[] = [];
  const fetchReport = async (input: FetchInput): Promise<CashOutstandingReport> => {
    calls.push(input);
    return fakeReport(`call-${calls.length}`);
  };
  return { calls, fetchReport };
}

describe("T14 · cache de la carga compartida", () => {
  it("dos get del mismo uid -> una sola llamada, con includeReconciliation: false", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    const first = await cache.get({ uid: "admin-1" });
    const second = await cache.get({ uid: "admin-1" });

    expect(calls).toEqual([{ includeReconciliation: false }]);
    expect(second).toBe(first);
  });

  it("dos get simultaneos del mismo uid comparten la misma peticion", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    const [first, second] = await Promise.all([cache.get({ uid: "admin-1" }), cache.get({ uid: "admin-1" })]);

    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("otro uid -> otra llamada, con su propio informe", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    const first = await cache.get({ uid: "admin-1" });
    const other = await cache.get({ uid: "admin-2" });

    expect(calls).toEqual([{ includeReconciliation: false }, { includeReconciliation: false }]);
    expect(other).not.toBe(first);
    expect(other.generatedAt).toBe("call-2");
  });

  it("refresh -> otra llamada, y los get siguientes devuelven la nueva", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    await cache.get({ uid: "admin-1" });
    const refreshed = await cache.get({ uid: "admin-1", refresh: true });
    const after = await cache.get({ uid: "admin-1" });

    expect(calls).toEqual([{ includeReconciliation: false }, { includeReconciliation: false }]);
    expect(refreshed.generatedAt).toBe("call-2");
    expect(after).toBe(refreshed);
  });

  it("prime sustituye la carga guardada sin llamar", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    await cache.get({ uid: "admin-1" });
    const withReconciliation = { ...fakeReport("primed"), mode: "with_reconciliation" } as CashOutstandingReport;
    cache.prime("admin-1", withReconciliation);
    const after = await cache.get({ uid: "admin-1" });

    expect(calls).toHaveLength(1);
    expect(after).toBe(withReconciliation);
  });

  it("prime antes de cualquier get: el get no llama", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    const primed = fakeReport("primed");
    cache.prime("admin-1", primed);

    expect(await cache.get({ uid: "admin-1" })).toBe(primed);
    expect(calls).toHaveLength(0);
  });

  it("clear vacia: el siguiente get vuelve a llamar", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const cache = createCashOutstandingSummaryCache(fetchReport);

    await cache.get({ uid: "admin-1" });
    cache.clear();
    const after = await cache.get({ uid: "admin-1" });

    expect(calls).toHaveLength(2);
    expect(after.generatedAt).toBe("call-2");
  });

  it("un rechazo no queda cacheado: el error se propaga y el siguiente get vuelve a llamar", async () => {
    const { createCashOutstandingSummaryCache } = await loadLoads();
    let attempts = 0;
    const fetchReport = async (_input: FetchInput): Promise<CashOutstandingReport> => {
      attempts += 1;
      if (attempts === 1) throw new Error("internal");
      return fakeReport(`call-${attempts}`);
    };
    const cache = createCashOutstandingSummaryCache(fetchReport);

    await expect(cache.get({ uid: "admin-1" })).rejects.toThrow("internal");
    const retried = await cache.get({ uid: "admin-1" });

    expect(attempts).toBe(2);
    expect(retried.generatedAt).toBe("call-2");
  });

  it("cash-outstanding-loads.ts no importa auth.ts (la llamada se inyecta)", () => {
    const source = withoutComments(repoFile("src/lib/cash-outstanding-loads.ts"));
    expect(source).not.toMatch(/from\s+["'][^"']*firebase\/auth["']/);
    expect(source).not.toMatch(/from\s+["']firebase\//);
  });

  it("auth.ts expone getFirebaseCashOutstanding y updateFirebaseCashAlertSettings sobre sus callables", () => {
    const source = withoutComments(repoFile("src/lib/firebase/auth.ts"));
    expect(source).toMatch(/export\s+async\s+function\s+getFirebaseCashOutstanding\s*\(/);
    expect(source).toMatch(/export\s+async\s+function\s+updateFirebaseCashAlertSettings\s*\(/);
    expect(source).toMatch(/httpsCallable\(\s*\w+\s*,\s*["']getCashOutstanding["']\s*\)/);
    expect(source).toMatch(/httpsCallable\(\s*\w+\s*,\s*["']updateCashAlertSettings["']\s*\)/);
  });
});

describe("T16 · recarga tras guardar ajustes", () => {
  /*
   * Contrato T16 (plan 2.1 "Guardar Plazo y aviso"; README decision 9):
   *   reloadAfterCashAlertSave(
   *     { isTabOpen: boolean },
   *     { fetchReport: FetchCashOutstandingReport, cache: CashOutstandingSummaryCache, uid: string }
   *   ): Promise<CashOutstandingReport>
   *
   *   - Pestana abierta: UNA llamada fetchReport({ includeReconciliation: true }), cache.prime(uid, informe)
   *     y devuelve ese informe. No llama a cache.get.
   *   - Pestana cerrada: cache.get({ uid, refresh: true }) y devuelve lo que resuelva. No llama a
   *     fetchReport directamente (la cache usa su propia llamada, siempre resumen) ni a prime.
   *   - El error se propaga (rechaza) y, con la pestana abierta, no se hace prime de nada.
   */
  type CacheCall = { method: "get"; input: { uid: string; refresh?: boolean } } | { method: "prime"; uid: string; report: CashOutstandingReport } | { method: "clear" };

  /** Cache espia: registra cada llamada; `get` devuelve `getResult` (o rechaza con `getError`). */
  function spyCache(options: { getResult?: CashOutstandingReport; getError?: Error } = {}) {
    const calls: CacheCall[] = [];
    const cache = {
      get(input: { uid: string; refresh?: boolean }) {
        calls.push({ method: "get", input });
        if (options.getError) return Promise.reject(options.getError);
        return Promise.resolve(options.getResult ?? fakeReport("from-cache"));
      },
      prime(uid: string, report: CashOutstandingReport) {
        calls.push({ method: "prime", uid, report });
      },
      clear() {
        calls.push({ method: "clear" });
      },
    };
    return { calls, cache };
  }

  it("exporta reloadAfterCashAlertSave", async () => {
    const loads = await loadLoads();
    expect(typeof (loads as Record<string, unknown>).reloadAfterCashAlertSave).toBe("function");
  });

  it("pestana abierta -> fetchReport({ includeReconciliation: true }) una vez", async () => {
    const { reloadAfterCashAlertSave } = await loadLoads();
    const { calls, fetchReport } = fakeFetch();
    const { cache } = spyCache();

    await reloadAfterCashAlertSave({ isTabOpen: true }, { fetchReport, cache, uid: "admin-1" });

    expect(calls).toEqual([{ includeReconciliation: true }]);
  });

  it("pestana abierta -> prime(uid, informe) con el informe recibido, sin cache.get", async () => {
    const { reloadAfterCashAlertSave } = await loadLoads();
    const { fetchReport } = fakeFetch();
    const { calls, cache } = spyCache();

    const report = await reloadAfterCashAlertSave({ isTabOpen: true }, { fetchReport, cache, uid: "admin-1" });

    expect(report.generatedAt).toBe("call-1");
    expect(calls).toEqual([{ method: "prime", uid: "admin-1", report }]);
  });

  it("pestana abierta con la cache real: el get siguiente devuelve la carga con conciliacion sin llamar", async () => {
    const { createCashOutstandingSummaryCache, reloadAfterCashAlertSave } = await loadLoads();
    const summary = fakeFetch();
    const cache = createCashOutstandingSummaryCache(summary.fetchReport);
    await cache.get({ uid: "admin-1" });
    const tab = fakeFetch();

    const report = await reloadAfterCashAlertSave({ isTabOpen: true }, { fetchReport: tab.fetchReport, cache, uid: "admin-1" });
    const shared = await cache.get({ uid: "admin-1" });

    expect(shared).toBe(report);
    expect(summary.calls).toHaveLength(1);
  });

  it("pestana cerrada -> cache.get({ uid, refresh: true }) y devuelve su resultado", async () => {
    const { reloadAfterCashAlertSave } = await loadLoads();
    const { calls: fetchCalls, fetchReport } = fakeFetch();
    const refreshed = fakeReport("refreshed");
    const { calls, cache } = spyCache({ getResult: refreshed });

    const report = await reloadAfterCashAlertSave({ isTabOpen: false }, { fetchReport, cache, uid: "admin-1" });

    expect(report).toBe(refreshed);
    expect(calls).toEqual([{ method: "get", input: { uid: "admin-1", refresh: true } }]);
    expect(fetchCalls).toEqual([]);
  });

  it("pestana cerrada con la cache real: una llamada nueva, resumen, que queda como compartida", async () => {
    const { createCashOutstandingSummaryCache, reloadAfterCashAlertSave } = await loadLoads();
    const summary = fakeFetch();
    const cache = createCashOutstandingSummaryCache(summary.fetchReport);
    await cache.get({ uid: "admin-1" });

    const report = await reloadAfterCashAlertSave({ isTabOpen: false }, { fetchReport: summary.fetchReport, cache, uid: "admin-1" });

    expect(summary.calls).toEqual([{ includeReconciliation: false }, { includeReconciliation: false }]);
    expect(report.generatedAt).toBe("call-2");
    expect(await cache.get({ uid: "admin-1" })).toBe(report);
  });

  it("pestana abierta: el error de fetchReport se propaga y no hay prime", async () => {
    const { reloadAfterCashAlertSave } = await loadLoads();
    const fetchReport = async (_input: FetchInput): Promise<CashOutstandingReport> => {
      throw new Error("internal");
    };
    const { calls, cache } = spyCache();

    await expect(reloadAfterCashAlertSave({ isTabOpen: true }, { fetchReport, cache, uid: "admin-1" })).rejects.toThrow("internal");
    expect(calls).toEqual([]);
  });

  it("pestana cerrada: el error de cache.get se propaga", async () => {
    const { reloadAfterCashAlertSave } = await loadLoads();
    const { fetchReport } = fakeFetch();
    const { cache } = spyCache({ getError: new Error("unavailable") });

    await expect(reloadAfterCashAlertSave({ isTabOpen: false }, { fetchReport, cache, uid: "admin-1" })).rejects.toThrow("unavailable");
  });
});
