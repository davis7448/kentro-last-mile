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
