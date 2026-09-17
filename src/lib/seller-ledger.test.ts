import { describe, expect, it } from "vitest";
// La logica vive en el backend (unica fuente de verdad para la elegibilidad de pago). Se importa
// desde functions/ en vez de duplicarla aqui: es la cifra que se le paga a una tienda y ya estaba
// triplicada entre la UI, store-api.ts y createSettlement.
import { buildCodReceivedSet, isSellerEntryEligible, isWithinSettlementRange, summarizeSellerPayable } from "../../functions/src/seller-ledger";

const orders = new Map<string, Record<string, unknown>>([
  ["o-prepago", { paymentMethod: "prepaid", status: "delivered" }],
  ["o-cod-cobrado", { paymentMethod: "cod", status: "delivered" }],
  ["o-cod-pendiente", { paymentMethod: "cod", status: "delivered" }],
  ["o-fallido", { paymentMethod: "cod", status: "failed" }]
]);

describe("buildCodReceivedSet", () => {
  it("toma cashAllocations como fuente autoritativa y solo cuenta las cubiertas", () => {
    const set = buildCodReceivedSet([
      { kind: "driver", cashAllocations: [{ orderId: "o-1", covered: true }, { orderId: "o-2", covered: false }] }
    ]);
    expect(set.has("o-1")).toBe(true);
    expect(set.has("o-2")).toBe(false);
  });

  it("cae al estado del corte cuando no hay cashAllocations", () => {
    const set = buildCodReceivedSet([{ kind: "driver", status: "paid", orderIds: ["o-3"] }]);
    expect(set.has("o-3")).toBe(true);
  });

  it("ignora los cortes que no son de domiciliario", () => {
    const set = buildCodReceivedSet([{ kind: "seller", status: "paid", orderIds: ["o-4"] }]);
    expect(set.size).toBe(0);
  });
});

describe("summarizeSellerPayable", () => {
  const codReceived = new Set(["o-cod-cobrado"]);

  it("separa lo liquidable de lo retenido por COD sin recaudar", () => {
    const summary = summarizeSellerPayable(
      [
        { type: "cod_revenue", orderId: "o-prepago", amountCop: 100_000 },
        { type: "cod_revenue", orderId: "o-cod-cobrado", amountCop: 50_000 },
        { type: "cod_revenue", orderId: "o-cod-pendiente", amountCop: 70_000 },
        { type: "delivery_fee", orderId: "o-cod-pendiente", amountCop: -12_000 }
      ],
      orders,
      codReceived
    );
    expect(summary.eligibleCop).toBe(150_000);
    expect(summary.blockedCop).toBe(58_000);
    expect(summary.eligibleOrderCount).toBe(2);
    expect(summary.blockedOrderIds).toEqual(["o-cod-pendiente"]);
  });

  it("no cobra espera al fallido: no tiene COD por recaudar", () => {
    const summary = summarizeSellerPayable(
      [{ type: "failed_fee", orderId: "o-fallido", amountCop: -12_000 }],
      orders,
      codReceived
    );
    expect(summary.eligibleCop).toBe(-12_000);
    expect(summary.blockedCop).toBe(0);
  });

  it("los abonos a tienda siempre entran, sin pedido asociado", () => {
    const summary = summarizeSellerPayable(
      [{ type: "seller_abono", amountCop: -30_000 }],
      orders,
      codReceived
    );
    expect(summary.eligibleCop).toBe(-30_000);
  });

  it("excluye lo ya liquidado y los tipos que no cuentan para el corte", () => {
    const summary = summarizeSellerPayable(
      [
        { type: "cod_revenue", orderId: "o-prepago", amountCop: 100_000, settlementId: "stl-1" },
        { type: "driver_earning", orderId: "o-prepago", amountCop: 9_000 },
        { type: "platform_margin", orderId: "o-prepago", amountCop: 3_000 }
      ],
      orders,
      codReceived
    );
    expect(summary.eligibleCop).toBe(0);
    expect(summary.blockedCop).toBe(0);
  });

  it("reproduce el caso auditado de OnStok (19-ago-2026)", () => {
    // 2.180.800 sin liquidar = 2.108.900 liquidables + 71.900 retenidos por KNT-003392,
    // un entregado COD cuyo efectivo aun no entra de la flota.
    const summary = summarizeSellerPayable(
      [
        { type: "cod_revenue", orderId: "o-prepago", amountCop: 2_108_900 },
        { type: "cod_revenue", orderId: "o-cod-pendiente", amountCop: 71_900 }
      ],
      orders,
      codReceived
    );
    expect(summary.eligibleCop).toBe(2_108_900);
    expect(summary.blockedCop).toBe(71_900);
    expect(summary.eligibleCop + summary.blockedCop).toBe(2_180_800);
  });
});

describe("isWithinSettlementRange", () => {
  it("con rango abierto toma todo lo pendiente, por antiguo que sea", () => {
    // El movimiento pendiente mas antiguo en produccion es de 2026-05-30 y la pantalla venia con
    // un rango por defecto de 7 dias, asi que ni se veia ni entraba al corte.
    expect(isWithinSettlementRange("2026-05-30", "", "")).toBe(true);
    expect(isWithinSettlementRange("2026-08-21", "", "")).toBe(true);
  });

  it("con solo un extremo abierto acota por el otro", () => {
    expect(isWithinSettlementRange("2026-05-30", "", "2026-06-30")).toBe(true);
    expect(isWithinSettlementRange("2026-07-01", "", "2026-06-30")).toBe(false);
    expect(isWithinSettlementRange("2026-07-01", "2026-06-30", "")).toBe(true);
    expect(isWithinSettlementRange("2026-05-30", "2026-06-30", "")).toBe(false);
  });

  it("conserva el filtro cuando el llamante manda las dos fechas", () => {
    expect(isWithinSettlementRange("2026-06-15", "2026-06-01", "2026-06-30")).toBe(true);
    expect(isWithinSettlementRange("2026-05-31", "2026-06-01", "2026-06-30")).toBe(false);
    expect(isWithinSettlementRange("2026-07-01", "2026-06-01", "2026-06-30")).toBe(false);
  });
});

describe("consecuencia de revertir un pedido entregado a fallido", () => {
  // Contraintuitivo pero correcto: al dejar de ser "delivered", el pedido ya no espera COD,
  // asi que la reversa Y el recaudo original sin liquidar se vuelven elegibles a la vez y
  // netean en el mismo corte. Es lo que hace que un clawback no deje saldo colgado.
  it("libera de golpe el recaudo original y su reversa", () => {
    const revertido = new Map<string, Record<string, unknown>>([["o-revertido", { paymentMethod: "cod", status: "failed" }]]);
    const codReceived = new Set<string>(); // el COD nunca entro de la flota
    const asientos = [
      { type: "cod_revenue", orderId: "o-revertido", amountCop: 89900 },
      { type: "cod_remittance", orderId: "o-revertido", amountCop: -89900 }
    ];
    for (const asiento of asientos) {
      expect(isSellerEntryEligible(asiento as never, revertido as never, codReceived)).toBe(true);
    }
    // Mientras seguia entregado, ese mismo recaudo estaba retenido esperando el efectivo.
    const entregado = new Map<string, Record<string, unknown>>([["o-revertido", { paymentMethod: "cod", status: "delivered" }]]);
    expect(isSellerEntryEligible(asientos[0] as never, entregado as never, codReceived)).toBe(false);
  });
});
