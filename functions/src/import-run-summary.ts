/**
 * El resumen de una corrida de reimportacion: cuantos pedidos ya existian y que datos protegidos se
 * conservaron. SIN Firestore — acumula y resume; quien escribe el documento es la via.
 *
 * Existe porque hasta ahora una reimportacion no dejaba ni rastro: la del 2026-09-15 toco 34
 * pedidos ya operados y nadie se entero hasta que un mensajero llamo por telefono.
 *
 * Un resumen POR CORRIDA, nunca uno por pedido: el historial que ve el responsable trae solo los
 * ultimos eventos, y miles de constancias desplazarian todo lo demas.
 */
import type { ImportOrigin, MergeResult, PreservedGroup } from "./order-import-merge";

/**
 * Tope de codigos listados. Un documento de Firestore son 1 MiB y una corrida de un mes puede tocar
 * miles de pedidos. Los RECUENTOS son exactos siempre; lo que se recorta es la lista, y el resumen
 * lo dice (RF_13): un resumen que miente por omision es peor que no tenerlo.
 */
export const MAX_AFFECTED_CODES = 500;

/**
 * La procedencia no cuenta como afectacion y va en su propio recuento. Un pedido nacido por el
 * aviso automatico SIEMPRE llega con una procedencia distinta en una reimportacion por rango, sin
 * que eso sea ninguna novedad: contarla listaria miles de pedidos en cada corrida y el resumen no
 * distinguiria nada (RF_14).
 */
const NOT_AN_AFFECTATION: PreservedGroup = "provenance";

export type RunTally = {
  seen: number;
  created: number;
  existing: number;
  preservedCounts: Partial<Record<PreservedGroup, number>>;
  codes: string[];
  truncated: boolean;
};

export type ImportRunSummary = RunTally & {
  id: string;
  origin: ImportOrigin;
  startedAt: string;
  finishedAt: string;
  range?: { startDate: string; endDate: string };
  sellerId?: string;
  shopDomain?: string;
  affectedTrackingCodes: string[];
};

export function emptyTally(): RunTally {
  return { seen: 0, created: 0, existing: 0, preservedCounts: {}, codes: [], truncated: false };
}

/**
 * Suma un pedido al resumen. Se llama UNA vez por pedido y **fuera de la transaccion**: dentro del
 * callback, Firestore lo reintenta y los recuentos se inflarian sin ningun error.
 *
 * @param order La vista devuelta por la via, de donde sale el codigo de seguimiento (`MergeResult`
 *   no lo lleva: el nucleo no necesita saberlo para decidir).
 */
export function tallyOrder(tally: RunTally, order: { trackingCode?: unknown }, merged: MergeResult): RunTally {
  const next: RunTally = {
    ...tally,
    seen: tally.seen + 1,
    created: tally.created + (merged.phase === "new" ? 1 : 0),
    existing: tally.existing + (merged.phase === "new" ? 0 : 1),
    preservedCounts: { ...tally.preservedCounts },
    codes: [...tally.codes]
  };

  for (const group of merged.preserved) {
    next.preservedCounts[group] = (next.preservedCounts[group] ?? 0) + 1;
  }

  const affected = merged.preserved.filter((group) => group !== NOT_AN_AFFECTATION);
  if (affected.length === 0) return next;

  const code = typeof order.trackingCode === "string" ? order.trackingCode : "";
  if (!code) return next;
  if (next.codes.length >= MAX_AFFECTED_CODES) {
    next.truncated = true;
    return next;
  }
  next.codes.push(code);
  return next;
}

export function summarizeRun(
  tally: RunTally,
  meta: {
    origin: ImportOrigin;
    startedAt: string;
    finishedAt: string;
    range?: { startDate: string; endDate: string };
    sellerId?: string;
    shopDomain?: string;
  }
): ImportRunSummary {
  return {
    ...tally,
    id: `run-${new Date(meta.startedAt).getTime()}-${meta.origin}`,
    ...meta,
    affectedTrackingCodes: tally.codes
  };
}
