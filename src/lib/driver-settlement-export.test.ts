/**
 * Spec 019 — T5: la pantalla y el Excel del corte salen de la MISMA lista.
 *
 * Mientras se construyeran por separado, que coincidieran era una promesa. Estas pruebas fijan que
 * sea una propiedad: el Excel se deriva de las filas de pantalla, con el mismo rotulo para lo que
 * no se pudo leer y con los importes como numero para que la columna sume la cabecera.
 */
import { describe, expect, it } from "vitest";
import { calculateDriverFinancialSummary } from "./finance";
import {
  NO_AMOUNT_LABEL,
  UNAVAILABLE_ORDER_LABEL,
  buildDriverSettlementDetailGroups,
  buildDriverSettlementExportRows,
  driverSettlementExportColumns,
  flattenDriverSettlementDetail,
  formatDetailCop,
  settlementDetailNotice
} from "./driver-settlement-export";
import { seedState } from "./seed";
import type { AppState, Order, WalletEntry } from "./types";

const DRIVER_ID = "driver-1";

function pay(orderId: string, amountCop: number): WalletEntry {
  return {
    id: `we-${orderId}`,
    ownerType: "driver",
    ownerId: DRIVER_ID,
    orderId,
    settlementId: "stl-1",
    type: "driver_earning",
    amountCop,
    description: "Pago domiciliario",
    createdAt: "2026-09-17T20:00:00.000Z"
  };
}

function order(id: string, trackingCode: string, totalCop: number, status: Order["status"] = "delivered"): Order {
  return {
    id,
    trackingCode,
    shopifyOrderId: `#${id}`,
    sellerId: "seller-danda",
    cityId: "city-cali",
    driverId: DRIVER_ID,
    customerName: "Cliente",
    customerPhone: "+573000000000",
    addressRaw: "Calle 1 #1-1, Cali",
    addressRisk: "accepted",
    status,
    paymentMethod: status === "delivered" ? "cod" : "prepaid",
    fulfillmentMode: "seller_pickup",
    totalCop,
    evidence: [],
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-17T20:00:00.000Z",
    closedAt: "2026-09-17T20:00:00.000Z"
  };
}

/**
 * Tres pedidos, uno por situacion: descargado con recaudo, descargado sin recaudo (visita fallida)
 * y NO descargado pero con importe guardado en el corte.
 */
function buildState(): AppState {
  return {
    ...seedState(),
    orders: [order("ord-1", "KNT-005077", 109900), order("ord-2", "KNT-004764", 0, "failed")],
    wallet: [pay("ord-1", 11000), pay("ord-2", 8000), pay("ord-3", 11000)],
    settlements: [{
      id: "stl-1",
      kind: "driver",
      ownerId: DRIVER_ID,
      ownerName: "Domiciliario",
      startDate: "2026-09-14",
      endDate: "2026-09-17",
      walletEntryIds: ["we-ord-1", "we-ord-2", "we-ord-3"],
      orderIds: ["ord-1", "ord-2", "ord-3"],
      codCop: 199800,
      feesCop: 0,
      driverPayCop: 30000,
      platformMarginCop: 0,
      netCop: -169800,
      status: "pending",
      createdAt: "2026-09-17T23:09:49.616Z",
      cashExpectedCop: 169800,
      cashAllocations: [
        { orderId: "ord-1", expectedCop: 98900, receivedCop: 0, covered: false },
        { orderId: "ord-3", expectedCop: 78900, receivedCop: 0, covered: false }
      ]
    }]
  };
}

const groupsOf = (state: AppState) => buildDriverSettlementDetailGroups(calculateDriverFinancialSummary(state, DRIVER_ID));

describe("spec 019 · T5 · presentacion del detalle del corte (RF_10, RF_13)", () => {
  it("agrupa una fila por pedido del corte", () => {
    const groups = groupsOf(buildState());
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
  });

  it("RF_10 · el pedido que no se pudo leer lleva rotulo, no el identificador interno", () => {
    const row = groupsOf(buildState())[0].rows.find((item) => item.orderId === "ord-3")!;
    expect(row.trackingLabel).toBe(UNAVAILABLE_ORDER_LABEL);
    expect(row.trackingLabel).not.toContain("ord-3");
    expect(row.unavailable).toBe(true);
    // Aunque no se pueda leer el pedido, su importe SI se conoce: lo guardo el corte.
    expect(row.expectedCashCop).toBe(78900);
  });

  it("la visita sin recaudo se marca y su importe va a favor del domiciliario", () => {
    const row = groupsOf(buildState())[0].rows.find((item) => item.orderId === "ord-2")!;
    expect(row.noCollection).toBe(true);
    expect(row.expectedCashCop).toBe(-8000);
    expect(row.expectedLabel).toBe("-$8.000");
  });

  it("una fila sin importe se rotula, nunca como $0", () => {
    const state = buildState();
    delete state.settlements[0].cashAllocations;
    const row = groupsOf(state)[0].rows.find((item) => item.orderId === "ord-3")!;
    expect(row.expectedCashCop).toBeNull();
    expect(row.expectedLabel).toBe(NO_AMOUNT_LABEL);
    expect(row.expectedLabel).not.toContain("0");
  });

  it("RF_13 · el Excel sale de las mismas filas que la pantalla, una a una", () => {
    const groups = groupsOf(buildState());
    const rows = flattenDriverSettlementDetail(groups);
    const exported = buildDriverSettlementExportRows(rows);

    expect(exported).toHaveLength(rows.length);
    rows.forEach((row, index) => {
      expect(exported[index].guia).toBe(row.trackingLabel);
      expect(exported[index].efectivo_esperado).toBe(row.expectedCashCop === null ? NO_AMOUNT_LABEL : row.expectedCashCop);
      expect(exported[index].corte).toBe(row.settlementLabel);
    });
  });

  it("RF_13 · los importes viajan como NUMERO, asi que la columna suma la cabecera", () => {
    const groups = groupsOf(buildState());
    const exported = buildDriverSettlementExportRows(flattenDriverSettlementDetail(groups));

    const total = exported.reduce((sum, row) => sum + (typeof row.efectivo_esperado === "number" ? row.efectivo_esperado : 0), 0);
    expect(total).toBe(groups[0].expectedCashCop);
    expect(total).toBe(169800);
    expect(exported.some((row) => row.efectivo_esperado === -8000)).toBe(true);
  });

  it("RF_13 · el Excel usa el mismo rotulo de no disponible que la pantalla", () => {
    const state = buildState();
    delete state.settlements[0].cashAllocations;
    const exported = buildDriverSettlementExportRows(flattenDriverSettlementDetail(groupsOf(state)));
    const sinPedido = exported.find((row) => row.guia === UNAVAILABLE_ORDER_LABEL)!;

    expect(sinPedido).toBeDefined();
    expect(sinPedido.efectivo_esperado).toBe(NO_AMOUNT_LABEL);
    expect(sinPedido.no_disponible).toBe("si");
  });

  it("las columnas declaradas cubren todas las claves que emite el Excel", () => {
    const exported = buildDriverSettlementExportRows(flattenDriverSettlementDetail(groupsOf(buildState())));
    for (const row of exported) {
      expect(Object.keys(row).sort()).toEqual([...driverSettlementExportColumns].sort());
    }
  });

  it("formatDetailCop conserva el signo de los importes a favor", () => {
    expect(formatDetailCop(98900)).toBe("$98.900");
    expect(formatDetailCop(-8000)).toBe("-$8.000");
    expect(formatDetailCop(0)).toBe("$0");
  });
});

/**
 * Spec 019 — T12: el aviso del detalle, incluido el desenlace que faltaba.
 *
 * `pinOrders` devuelve `skippedByBudget` desde T6, pero nadie lo leia: con el tope de la carga de
 * pagina agotado, las filas no rescatadas caian a su importe guardado en el corte, la resta daba
 * cero y el detalle se presentaba como "coincide con el corte". El caso limite de la spec dice lo
 * contrario: queda incompleto A PROPOSITO y hay que avisarlo (RF_08, RF_11).
 */
describe("spec 019 · T12 · el aviso dice por que el detalle no esta completo (RF_08, RF_11)", () => {
  const group = () => groupsOf(buildState())[0];

  it("sin nada pendiente, el detalle coincide con el corte", () => {
    const notice = settlementDetailNotice(group(), { loading: false, skippedByBudget: 0 });

    expect(notice.kind).toBe("balanced");
  });

  it("RF_08 · mientras llegan pedidos, el aviso es que se esta completando", () => {
    const notice = settlementDetailNotice(group(), { loading: true, skippedByBudget: 0 });

    expect(notice.kind).toBe("loading");
  });

  it("RF_11 · una fila sin importe gana sobre el tope: incompleto de verdad, no a proposito", () => {
    const state = buildState();
    delete state.settlements[0].cashAllocations;
    const notice = settlementDetailNotice(groupsOf(state)[0], { loading: false, skippedByBudget: 3 });

    expect(notice.kind).toBe("incomplete");
  });

  it("RF_11 · con el tope agotado el detalle NO se presenta como coincidente", () => {
    const notice = settlementDetailNotice(group(), { loading: false, skippedByBudget: 4 });

    expect(notice.kind).toBe("budget");
    expect(notice.kind === "budget" && notice.skippedCount).toBe(4);
  });

  it("RF_11 · el tope gana sobre el ajuste posterior: con filas sin bajar, la diferencia no es fiable", () => {
    const base = group();
    const adjusted = { ...base, detailDeltaCop: 12000, detailStatus: "adjusted" as const };

    expect(settlementDetailNotice(adjusted, { loading: false, skippedByBudget: 0 }).kind).toBe("adjusted");
    expect(settlementDetailNotice(adjusted, { loading: false, skippedByBudget: 1 }).kind).toBe("budget");
  });
});
