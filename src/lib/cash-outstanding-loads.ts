/**
 * Spec 026 — cargas de "Efectivo sin llegar" en el cliente (plan 2.1; README decision 11).
 *
 * La carga resumen (`includeReconciliation: false`) se pide una vez por sesion y la comparten la tarjeta
 * "Efectivo vencido" de Operacion y la linea de proveedor de Por pagar. La pestana pide la suya con
 * conciliacion y la deja como compartida con `prime`, para que tarjeta y pestana muestren el mismo
 * momento.
 *
 * La llamada al servidor se inyecta (`fetchReport`): este modulo no importa `auth.ts` ni el SDK.
 */
import type { CashOutstandingReport } from "../../functions/src/cash-outstanding";

export type FetchCashOutstandingReport = (input: { includeReconciliation: boolean }) => Promise<CashOutstandingReport>;

export interface CashOutstandingSummaryCache {
  /** Una peticion por `uid`; `refresh` fuerza otra y la deja como la guardada. */
  get(input: { uid: string; refresh?: boolean }): Promise<CashOutstandingReport>;
  /** Sustituye la carga guardada (la de la pestana, con conciliacion) sin llamar. */
  prime(uid: string, report: CashOutstandingReport): void;
  clear(): void;
}

export function createCashOutstandingSummaryCache(fetchReport: FetchCashOutstandingReport): CashOutstandingSummaryCache {
  // Se guarda la PROMESA, no el informe: dos `get` simultaneos comparten la misma peticion.
  const loads = new Map<string, Promise<CashOutstandingReport>>();

  function load(uid: string): Promise<CashOutstandingReport> {
    const pending = fetchReport({ includeReconciliation: false });
    loads.set(uid, pending);
    pending.catch(() => {
      // Un rechazo no se cachea; solo se olvida si nadie la sustituyo entretanto (refresh o prime).
      if (loads.get(uid) === pending) loads.delete(uid);
    });
    return pending;
  }

  return {
    get({ uid, refresh = false }) {
      const cached = loads.get(uid);
      if (cached && !refresh) return cached;
      return load(uid);
    },
    prime(uid, report) {
      loads.set(uid, Promise.resolve(report));
    },
    clear() {
      loads.clear();
    },
  };
}
