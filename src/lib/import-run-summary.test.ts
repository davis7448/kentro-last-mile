import { describe, expect, it } from "vitest";
import {
  emptyTally,
  MAX_AFFECTED_CODES,
  summarizeRun,
  tallyOrder
} from "../../functions/src/import-run-summary";
import type { MergeResult, PreservedGroup } from "../../functions/src/order-import-merge";

/**
 * El resumen de corrida (spec 017, RF_13 y RF_14). Lo que se le exige es que **no mienta**: los
 * recuentos exactos siempre, y un numero distinto de cero que signifique algo.
 */

function merged(phase: MergeResult["phase"], preserved: PreservedGroup[] = []): MergeResult {
  return { doc: {}, clear: [], phase, preserved };
}

describe("tallyOrder", () => {
  it("separa los pedidos creados de los que ya existian", () => {
    let tally = emptyTally();
    tally = tallyOrder(tally, { trackingCode: "KNT-1" }, merged("new"));
    tally = tallyOrder(tally, { trackingCode: "KNT-2" }, merged("open", ["ownership"]));
    tally = tallyOrder(tally, { trackingCode: "KNT-3" }, merged("closed", ["frozen_catalog"]));
    expect(tally.seen).toBe(3);
    expect(tally.created).toBe(1);
    expect(tally.existing).toBe(2);
  });

  it("cuenta cada grupo conservado", () => {
    let tally = emptyTally();
    tally = tallyOrder(tally, { trackingCode: "KNT-1" }, merged("open", ["ownership", "customer"]));
    tally = tallyOrder(tally, { trackingCode: "KNT-2" }, merged("open", ["ownership"]));
    expect(tally.preservedCounts.ownership).toBe(2);
    expect(tally.preservedCounts.customer).toBe(1);
  });

  /** Si sumara, una corrida sin novedades saldria con los contadores en cero y la lista llena. */
  it("un pedido que ya existia pero al que no se iba a pisar nada no es una afectacion", () => {
    const tally = tallyOrder(emptyTally(), { trackingCode: "KNT-1" }, merged("open"));
    expect(tally.existing).toBe(1);
    expect(tally.codes).toEqual([]);
  });

  /**
   * La procedencia SIEMPRE difiere en una reimportacion por rango sobre un pedido nacido por
   * webhook, que es la via normal de las tiendas grandes. Si contara como afectacion, cada corrida
   * listaria miles de pedidos y el resumen no distinguiria nada.
   */
  it("la procedencia se cuenta aparte y no mete al pedido en la lista de afectados", () => {
    const tally = tallyOrder(emptyTally(), { trackingCode: "KNT-1" }, merged("open", ["provenance"]));
    expect(tally.preservedCounts.provenance).toBe(1);
    expect(tally.codes).toEqual([]);
  });

  it("pero si ademas se salvo otra cosa, el pedido si entra en la lista", () => {
    const tally = tallyOrder(emptyTally(), { trackingCode: "KNT-1" }, merged("open", ["provenance", "ownership"]));
    expect(tally.codes).toEqual(["KNT-1"]);
  });

  it("los recuentos siguen siendo exactos cuando la lista se recorta", () => {
    let tally = emptyTally();
    for (let index = 0; index < MAX_AFFECTED_CODES + 25; index += 1) {
      tally = tallyOrder(tally, { trackingCode: `KNT-${index}` }, merged("open", ["ownership"]));
    }
    expect(tally.preservedCounts.ownership).toBe(MAX_AFFECTED_CODES + 25);
    expect(tally.codes).toHaveLength(MAX_AFFECTED_CODES);
    expect(tally.truncated).toBe(true);
  });

  it("un pedido sin codigo de seguimiento no rompe el recuento", () => {
    const tally = tallyOrder(emptyTally(), {}, merged("open", ["ownership"]));
    expect(tally.preservedCounts.ownership).toBe(1);
    expect(tally.codes).toEqual([]);
  });
});

describe("summarizeRun", () => {
  it("lleva el rango, la tienda y los codigos afectados", () => {
    const tally = tallyOrder(emptyTally(), { trackingCode: "KNT-004747" }, merged("open", ["ownership"]));
    const summary = summarizeRun(tally, {
      origin: "shopify_historical_sync",
      startedAt: "2026-09-20T10:00:00.000Z",
      finishedAt: "2026-09-20T10:04:00.000Z",
      range: { startDate: "2026-09-10", endDate: "2026-09-15" },
      sellerId: "seller-1",
      shopDomain: "u0jxrm-tk.myshopify.com"
    });
    expect(summary.affectedTrackingCodes).toEqual(["KNT-004747"]);
    expect(summary.origin).toBe("shopify_historical_sync");
    expect(summary.range?.startDate).toBe("2026-09-10");
    expect(summary.id).toContain("shopify_historical_sync");
  });

  it("una corrida sin novedades sale en cero", () => {
    const summary = summarizeRun(emptyTally(), {
      origin: "shopify_historical_sync",
      startedAt: "2026-09-20T10:00:00.000Z",
      finishedAt: "2026-09-20T10:00:10.000Z"
    });
    expect(summary.affectedTrackingCodes).toEqual([]);
    expect(summary.preservedCounts).toEqual({});
    expect(summary.truncated).toBe(false);
  });
});
