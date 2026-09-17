import { describe, expect, it } from "vitest";
import {
  buildSellerBalanceInput,
  computeSellerBalance,
  payoutRejectionMessage,
  selectPayableOrders,
  selectSettlementEntries,
  type SellerBalanceInput
} from "../../functions/src/seller-balance";
import { resolveTariffs } from "../../functions/src/wallet-entries";

/**
 * Spec 018 · T4. La seleccion por pedidos completos y las cuatro cifras del saldo de una tienda.
 * Todo con documentos planos, sin red: es la misma regla que usan la pantalla de la tienda, el
 * cierre del admin, la solicitud de liquidacion, el corte y la API para tiendas.
 */

const NOW = "2026-09-16T12:00:00.000Z";
const SELLER = "seller-x";
let seq = 0;

function entry(over: Record<string, unknown>) {
  seq += 1;
  return {
    id: `we-${seq}`,
    ownerType: "seller",
    ownerId: SELLER,
    orderId: "",
    type: "cod_revenue",
    amountCop: 0,
    settlementId: "",
    createdAt: `2026-09-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    ...over
  };
}

/** Un pedido prepago entregado con un neto dado: cobro + flete, en dos asientos. */
function paidOrder(orderId: string, netCop: number, createdAt: string) {
  return [
    entry({ orderId, type: "cod_revenue", amountCop: netCop + 12000, createdAt }),
    entry({ orderId, type: "delivery_fee", amountCop: -12000, createdAt })
  ];
}

function order(id: string, over: Record<string, unknown> = {}) {
  return { id, sellerId: SELLER, status: "delivered", paymentMethod: "prepaid", fulfillmentMode: "seller", shopifyOrderId: id, evidence: [], ...over };
}

function streetOrder(id: string, over: Record<string, unknown> = {}) {
  return order(id, { status: "picked_up", pickedUpAt: "2026-09-15T10:00:00.000Z", paymentMethod: "cod", ...over });
}

function input(over: Partial<SellerBalanceInput> & { orders?: Record<string, unknown>[] } = {}): SellerBalanceInput {
  const { orders = [], ...rest } = over;
  return {
    openEntries: [],
    ordersById: new Map(orders.map((o) => [String(o.id), o])),
    streetCandidates: orders.filter((o) => o.status !== "delivered") as never,
    codReceived: new Set(),
    chargedFulfillmentOrderIds: new Set(),
    settings: {},
    zonesById: new Map(),
    now: NOW,
    ...rest
  };
}

describe("spec 018 · RF_12 · selectPayableOrders: pedidos completos del mas antiguo al mas nuevo", () => {
  it("tope 50.000 con pedidos de 30, 30 y 10 mil: entra solo el primero y el resto queda entero", () => {
    const entries = [
      ...paidOrder("o-a", 30000, "2026-09-01T00:00:00.000Z"),
      ...paidOrder("o-b", 30000, "2026-09-02T00:00:00.000Z"),
      ...paidOrder("o-c", 10000, "2026-09-03T00:00:00.000Z")
    ];
    const selection = selectPayableOrders(entries, 50000);
    expect(selection.totalCop).toBe(30000);
    expect(selection.includedOrderIds).toEqual(["o-a"]);
    expect(selection.heldOrderIds).toEqual(["o-b", "o-c"]);
    expect(selection.entryIds).toHaveLength(2);
  });

  it("la antiguedad sale del asiento mas viejo del pedido, no del orden de llegada", () => {
    const entries = [...paidOrder("o-nuevo", 30000, "2026-09-10T00:00:00.000Z"), ...paidOrder("o-viejo", 30000, "2026-09-01T00:00:00.000Z")];
    expect(selectPayableOrders(entries, 30000).includedOrderIds).toEqual(["o-viejo"]);
  });

  it("abonos, 4x1000 y pedidos con neto cero o negativo entran siempre", () => {
    const entries = [
      entry({ type: "seller_abono", amountCop: -20000 }),
      entry({ type: "gmf_tax", amountCop: -80 }),
      entry({ orderId: "o-fallido", type: "failed_fee", amountCop: -12000 }),
      ...paidOrder("o-a", 50000, "2026-09-01T00:00:00.000Z")
    ];
    const selection = selectPayableOrders(entries, 20000);
    expect(selection.includedOrderIds).toContain("o-fallido");
    expect(selection.includedOrderIds).toContain("o-a");
    expect(selection.totalCop).toBe(-20000 - 80 - 12000 + 50000);
  });

  it("ningun pedido queda partido: todos sus asientos entran o ninguno", () => {
    const entries = [...paidOrder("o-a", 30000, "2026-09-01T00:00:00.000Z"), ...paidOrder("o-b", 30000, "2026-09-02T00:00:00.000Z")];
    const selection = selectPayableOrders(entries, 45000);
    const byOrder = new Map<string, number>();
    for (const e of entries) if (selection.entryIds.includes(e.id)) byOrder.set(e.orderId, (byOrder.get(e.orderId) ?? 0) + 1);
    expect([...byOrder.values()].every((count) => count === 2)).toBe(true);
  });
});

describe("spec 018 · RF_14 / RF_15 / RF_23 / RF_24 · selectSettlementEntries, la unica regla del tope", () => {
  const candidates = [...paidOrder("o-a", 40000, "2026-09-01T00:00:00.000Z"), ...paidOrder("o-b", 30000, "2026-09-02T00:00:00.000Z")];

  it("sin retencion se toma todo", () => {
    const result = selectSettlementEntries({ payableCop: 70000, retentionTheoreticalCop: 0 }, candidates);
    expect(result.ok).toBe(true);
    expect(result.selection.totalCop).toBe(70000);
  });

  it("RF_15: con pagable cero o negativo no se retiene nada", () => {
    const result = selectSettlementEntries({ payableCop: -26500, retentionTheoreticalCop: 12000 }, candidates);
    expect(result.ok).toBe(true);
    expect(result.selection.totalCop).toBe(70000);
  });

  it("RF_23: un corte con rango usa el tope de la tienda entera; lo pagable de fuera cubre la retencion", () => {
    const soloA = paidOrder("o-a", 40000, "2026-09-01T00:00:00.000Z");
    const result = selectSettlementEntries({ payableCop: 100000, retentionTheoreticalCop: 24000 }, soloA);
    expect(result.ok).toBe(true);
    expect(result.selection.totalCop).toBe(40000);
  });

  it("RF_24: si ningun pedido positivo cabe, el corte no se crea", () => {
    const result = selectSettlementEntries({ payableCop: 70000, retentionTheoreticalCop: 60000 }, candidates);
    expect(result.ok).toBe(false);
  });

  it("RF_14 / RF_24: abonos que se comen los pedidos que caben no dejan a la tienda debiendo", () => {
    const entries = [entry({ type: "seller_abono", amountCop: -500000 })];
    for (let i = 0; i < 6; i += 1) entries.push(...paidOrder(`o-${i}`, 100000, `2026-09-0${i + 1}T00:00:00.000Z`));
    const result = selectSettlementEntries({ payableCop: 100000, retentionTheoreticalCop: 150000 }, entries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_by_retention");
  });
});

describe("spec 018 · T14 · hallazgos de la revision adversarial", () => {
  it("R1-RF_02-1: una restitucion positiva sin pedido compite por el tope; no se salta la retencion", () => {
    const orders = [order("o-cod", { paymentMethod: "cod" }), streetOrder("o-1"), streetOrder("o-2"), streetOrder("o-3")];
    const openEntries = [
      entry({ id: "we-unpaid-stl-1", type: "seller_abono", amountCop: 100000 }),
      ...paidOrder("o-cod", 50000, "2026-09-01T00:00:00.000Z")
    ];
    const balance = computeSellerBalance(input({ orders, openEntries }));
    expect(balance.payableCop).toBe(100000);
    expect(balance.retentionTheoreticalCop).toBe(36000);
    expect(balance.availableCop).toBe(0);
    expect(balance.heldCop).toBe(100000);
    expect(balance.totalUnsettledCop).toBe(balance.availableCop + balance.codPendingCop + balance.heldCop);
  });

  it("R1-RF_02-1: una restitucion que cabe entera si entra", () => {
    const orders = [streetOrder("o-1")];
    const balance = computeSellerBalance(input({ orders, openEntries: [entry({ type: "seller_abono", amountCop: 100000 })] }));
    expect(balance.availableCop).toBe(0);
    const bigger = computeSellerBalance(input({ orders: [...orders, order("o-a")], openEntries: [entry({ type: "seller_abono", amountCop: 100000, createdAt: "2026-08-01T00:00:00.000Z" }), ...paidOrder("o-a", 50000, "2026-09-01T00:00:00.000Z")] }));
    expect(bigger.availableCop).toBe(100000);
  });

  it("R1-RF_24-1: un corte que ya seria negativo sin retencion no se rechaza por la retencion", () => {
    const soloFallidos = [entry({ orderId: "o-f1", type: "failed_fee", amountCop: -12000 }), entry({ orderId: "o-f2", type: "failed_fee", amountCop: -12000 })];
    const result = selectSettlementEntries({ payableCop: 100000, retentionTheoreticalCop: 12000 }, soloFallidos);
    expect(result.ok).toBe(true);
    expect(result.selection.totalCop).toBe(-24000);
  });
});

describe("spec 018 · T15 · hallazgos de la ronda 2", () => {
  it("R2-RF_23-1: con retencion, un corte que ya seria negativo respeta el tope y no liquida pedidos que no caben", () => {
    const entries = [
      entry({ type: "seller_abono", amountCop: -100000 }),
      ...paidOrder("o-a", 30000, "2026-09-01T00:00:00.000Z"),
      ...paidOrder("o-b", 30000, "2026-09-02T00:00:00.000Z")
    ];
    const result = selectSettlementEntries({ payableCop: 50000, retentionTheoreticalCop: 100000 }, entries);
    expect(result.ok).toBe(true);
    expect(result.selection.includedOrderIds).toEqual(["o-a"]);
    expect(result.selection.heldOrderIds).toEqual(["o-b"]);
    expect(result.selection.totalCop).toBe(-70000);
  });

  it("R2-RF_08-1: una restitucion retenida cuenta como unidad retenida tambien cuando no hay corte posible", () => {
    const orders = [streetOrder("o-1"), streetOrder("o-2")];
    const balance = computeSellerBalance(input({ orders, openEntries: [entry({ type: "seller_abono", amountCop: 100000 })] }));
    expect(balance.availableCop).toBe(0);
    expect(balance.heldCop).toBe(100000);
    expect(balance.heldOrderCount).toBe(1);
  });
});

describe("spec 018 · RF_02 / RF_05 / RF_08 · computeSellerBalance", () => {
  it("separa disponible, efectivo con el domiciliario y retenido, y el total cuadra", () => {
    const orders = [
      order("o-a"),
      order("o-b", { paymentMethod: "cod" }),
      order("o-c", { paymentMethod: "cod" }),
      streetOrder("o-calle-1"),
      streetOrder("o-calle-2")
    ];
    const openEntries = [
      ...paidOrder("o-a", 40000, "2026-09-01T00:00:00.000Z"),
      ...paidOrder("o-b", 30000, "2026-09-02T00:00:00.000Z"),
      ...paidOrder("o-c", 50000, "2026-09-03T00:00:00.000Z")
    ];
    const balance = computeSellerBalance(input({ orders, openEntries, codReceived: new Set(["o-b"]) }));
    expect(balance.totalUnsettledCop).toBe(120000);
    expect(balance.codPendingCop).toBe(50000);
    expect(balance.codPendingOrderCount).toBe(1);
    expect(balance.payableCop).toBe(70000);
    expect(balance.streetOrderCount).toBe(2);
    expect(balance.retentionTheoreticalCop).toBe(24000);
    expect(balance.availableCop).toBe(40000);
    expect(balance.heldCop).toBe(30000);
    expect(balance.heldOrderCount).toBe(1);
    expect(balance.totalUnsettledCop).toBe(balance.availableCop + balance.codPendingCop + balance.heldCop);
  });

  it("RF_03: los abonos restan del disponible", () => {
    const openEntries = [...paidOrder("o-a", 40000, "2026-09-01T00:00:00.000Z"), entry({ type: "seller_abono", amountCop: -15000 })];
    const balance = computeSellerBalance(input({ orders: [order("o-a")], openEntries }));
    expect(balance.availableCop).toBe(25000);
  });

  it("RF_14: retencion mayor que lo pagable → disponible 0, todo retenido, sin deuda", () => {
    const orders = [order("o-a"), streetOrder("o-1"), streetOrder("o-2"), streetOrder("o-3"), streetOrder("o-4")];
    const openEntries = paidOrder("o-a", 40000, "2026-09-01T00:00:00.000Z");
    const balance = computeSellerBalance(input({ orders, openEntries }));
    expect(balance.availableCop).toBe(0);
    expect(balance.heldCop).toBe(40000);
    expect(balance.heldOrderCount).toBe(1);
  });

  it("RF_14: el ejemplo del analisis (abonos grandes) deja disponible 0 y retenido = pagable", () => {
    const orders = Array.from({ length: 6 }, (_, i) => order(`o-${i}`));
    for (let i = 0; i < 13; i += 1) orders.push(streetOrder(`o-calle-${i}`));
    const openEntries = [entry({ type: "seller_abono", amountCop: -500000 })];
    for (let i = 0; i < 6; i += 1) openEntries.push(...paidOrder(`o-${i}`, 100000, `2026-09-0${i + 1}T00:00:00.000Z`));
    const balance = computeSellerBalance(input({ orders, openEntries }));
    expect(balance.payableCop).toBe(100000);
    expect(balance.retentionTheoreticalCop).toBe(156000);
    expect(balance.availableCop).toBe(0);
    expect(balance.heldCop).toBe(100000);
    expect(balance.totalUnsettledCop).toBe(balance.availableCop + balance.codPendingCop + balance.heldCop);
  });

  it("RF_15: una tienda que ya debe (ADMA) muestra su deuda y no retiene", () => {
    const orders = [order("o-fallido", { status: "failed", paymentMethod: "cod" }), streetOrder("o-calle")];
    const openEntries = [entry({ orderId: "o-fallido", type: "failed_fee", amountCop: -26500 })];
    const balance = computeSellerBalance(input({ orders, openEntries }));
    expect(balance.availableCop).toBe(-26500);
    expect(balance.heldCop).toBe(0);
  });

  it("RF_05: el efectivo con el domiciliario puede ser negativo", () => {
    const orders = [order("o-caro", { paymentMethod: "cod" })];
    const openEntries = [entry({ orderId: "o-caro", type: "cod_revenue", amountCop: 5000 }), entry({ orderId: "o-caro", type: "delivery_fee", amountCop: -12000 })];
    const balance = computeSellerBalance(input({ orders, openEntries }));
    expect(balance.codPendingCop).toBe(-7000);
    expect(balance.totalUnsettledCop).toBe(balance.availableCop + balance.codPendingCop + balance.heldCop);
  });

  it("los tipos que el corte no liquida no entran al total", () => {
    const balance = computeSellerBalance(input({ openEntries: [entry({ type: "cash_shortage", amountCop: -9000 }), entry({ type: "payout", amountCop: 9000 })] }));
    expect(balance.totalUnsettledCop).toBe(0);
    expect(balance.unreadableEntryIds).toEqual([]);
  });

  it("RF_22: un asiento cuyo pedido no existe, o sin pedido y que no es abono, queda listado como ilegible", () => {
    const perdido = entry({ orderId: "o-borrado", type: "delivery_fee", amountCop: -12000 });
    const huerfano = entry({ orderId: "", type: "delivery_fee", amountCop: -12000 });
    const balance = computeSellerBalance(input({ openEntries: [perdido, huerfano] }));
    expect(balance.unreadableEntryIds).toEqual([perdido.id, huerfano.id]);
  });

  it("los manejos ya cobrados no se retienen otra vez", () => {
    const orders = [order("o-a"), streetOrder("o-bodega", { fulfillmentMode: "warehouse", status: "retry_pending" })];
    const openEntries = paidOrder("o-a", 100000, "2026-09-01T00:00:00.000Z");
    const without = computeSellerBalance(input({ orders, openEntries }));
    const withCharged = computeSellerBalance(input({ orders, openEntries, chargedFulfillmentOrderIds: new Set(["o-bodega"]) }));
    expect(without.retentionTheoreticalCop).toBe(14000);
    expect(withCharged.retentionTheoreticalCop).toBe(12000);
  });

  it("la tarifa de la zona del pedido llega a la retencion", () => {
    const zonesById = new Map([["z-1", { sellerFailedFeeCop: 7000 }]]);
    const orders = [order("o-a"), streetOrder("o-calle", { zoneId: "z-1" })];
    const balance = computeSellerBalance(input({ orders, openEntries: paidOrder("o-a", 100000, "2026-09-01T00:00:00.000Z"), zonesById }));
    // El fijo de fallido gana a la zona, igual que en el cierre.
    expect(balance.retentionTheoreticalCop).toBe(resolveTariffs({}, undefined).sellerFailedFeeCop);
  });
});

describe("spec 018 · RF_12 / RF_13 · DoD 4: dos cortes encadenados", () => {
  it("la tienda cobra lo mismo que en un solo corte con todo cerrado, sin pedidos partidos", () => {
    const openEntries = [
      ...paidOrder("o-a", 40000, "2026-09-01T00:00:00.000Z"),
      ...paidOrder("o-b", 30000, "2026-09-02T00:00:00.000Z"),
      ...paidOrder("o-c", 20000, "2026-09-03T00:00:00.000Z")
    ];
    const orders = [order("o-a"), order("o-b"), order("o-c"), streetOrder("o-d"), streetOrder("o-e")];

    const first = computeSellerBalance(input({ orders, openEntries }));
    const cut1 = selectSettlementEntries(first, openEntries);
    expect(cut1.ok).toBe(true);
    expect(cut1.selection.totalCop).toBe(40000);
    const settled1 = new Set(cut1.selection.entryIds);

    const delivered = [order("o-a"), order("o-b"), order("o-c"), order("o-d"), order("o-e")];
    const remaining = [
      ...openEntries.filter((e) => !settled1.has(e.id)),
      ...paidOrder("o-d", 25000, "2026-09-16T00:00:00.000Z"),
      ...paidOrder("o-e", 25000, "2026-09-16T00:00:00.000Z")
    ];
    const second = computeSellerBalance(input({ orders: delivered, openEntries: remaining }));
    const cut2 = selectSettlementEntries(second, remaining);
    expect(cut2.ok).toBe(true);
    expect(cut2.selection.totalCop).toBe(100000);

    expect(cut1.selection.totalCop + cut2.selection.totalCop).toBe(140000);
    const settled2 = new Set(cut2.selection.entryIds);
    const cut1Orders = new Set(openEntries.filter((e) => settled1.has(e.id)).map((e) => e.orderId));
    const cut2Orders = new Set(remaining.filter((e) => settled2.has(e.id)).map((e) => e.orderId));
    expect([...cut1Orders].some((id) => cut2Orders.has(id))).toBe(false);
  });
});

describe("spec 018 · buildSellerBalanceInput", () => {
  it("toma solo lo abierto de la tienda, los candidatos en la calle y los manejos ya cobrados", () => {
    const wallet = [
      entry({ orderId: "o-a", amountCop: 10000 }),
      entry({ orderId: "o-a", amountCop: 10000, settlementId: "stl-1" }),
      entry({ ownerId: "otra", orderId: "o-z", amountCop: 10000 }),
      entry({ ownerType: "driver", orderId: "o-a", amountCop: 9000 }),
      entry({ id: "we-o-bodega-fulfillment-fee", orderId: "o-bodega", type: "fulfillment_fee", amountCop: -2000, settlementId: "stl-0" })
    ];
    const orders = [order("o-a"), streetOrder("o-bodega", { fulfillmentMode: "warehouse", status: "retry_pending" }), streetOrder("o-ajeno", { sellerId: "otra" }), order("o-cerrado", { status: "cancelled" })];
    const settlements = [{ kind: "driver", status: "paid", orderIds: ["o-a"] }];
    const built = buildSellerBalanceInput({ sellerId: SELLER, wallet, orders, settlements, settings: {}, zones: [{ id: "z-1" }], now: NOW });
    expect(built.openEntries.map((e) => e.orderId)).toEqual(["o-a"]);
    expect(built.streetCandidates.map((o) => o.id)).toEqual(["o-bodega"]);
    expect(built.codReceived.has("o-a")).toBe(true);
    expect(built.chargedFulfillmentOrderIds.has("o-bodega")).toBe(true);
    expect(built.zonesById.has("z-1")).toBe(true);
  });
});

describe("spec 018 · RF_16 / RF_24 · payoutRejectionMessage", () => {
  const base = computeSellerBalance(input());

  it("solo retencion", () => {
    const message = payoutRejectionMessage({ ...base, availableCop: 0, heldCop: 40000, heldOrderCount: 1, streetOrderCount: 4 });
    expect(message).toMatch(/retenid/i);
    expect(message).toMatch(/4 pedidos en la calle/);
    expect(message).not.toMatch(/domiciliario/);
  });

  it("solo efectivo con el domiciliario", () => {
    const message = payoutRejectionMessage({ ...base, availableCop: 0, codPendingCop: 50000, codPendingOrderCount: 2 });
    expect(message).toMatch(/domiciliario/);
    expect(message).not.toMatch(/retenid/i);
  });

  it("ambos", () => {
    const message = payoutRejectionMessage({ ...base, availableCop: 0, heldCop: 40000, heldOrderCount: 1, streetOrderCount: 4, codPendingCop: 50000, codPendingOrderCount: 2 });
    expect(message).toMatch(/retenid/i);
    expect(message).toMatch(/domiciliario/);
  });

  it("sin saldo", () => {
    expect(payoutRejectionMessage(base)).toMatch(/No tienes saldo pendiente/);
  });
});
