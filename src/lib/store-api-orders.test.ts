/**
 * Spec 029 · T9 — forma de pedido extraida sin cambiar la salida (RF_01, RF_20).
 *
 * `functions/src/store-api-orders.ts` es puro (sin firebase-admin) y recibe, movidas TAL CUAL desde
 * `store-api.ts`, `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` y su ayudante de fecha
 * (`orderDateValue`). Anade `loadTargetedPaymentInputs`: con los asientos y cortes que lee la carga dirigida
 * del plan 2.10 (`walletEntries where orderId == id`, `getAll` de sus `settlementId` y `settlements where
 * orderIds array-contains id`) arma las tres entradas de `buildPaymentInfo`.
 *
 * Contrato que fija esta prueba:
 *   loadTargetedPaymentInputs({ orderId, sellerId, entries, settlements }) => {
 *     sellerEntries: WalletEntryDoc[];              // solo ownerType "seller", ownerId sellerId, orderId orderId
 *     settlementsById: Map<string, SettlementDoc>;  // sin duplicados, clave String(id)
 *     codReceived: Set<string>;                     // buildCodReceivedSet de esos cortes
 *   }
 * `entries` es lo que devuelve la consulta por `orderId` (de cualquier dueno, puede traer basura) y
 * `settlements` la union de las dos lecturas de cortes (puede repetir un corte).
 *
 * 1. Equivalencia: para cada pedido, `buildPaymentInfo` con lo dirigido == con la carga completa de hoy
 *    (todos los asientos de la tienda y TODOS los cortes). Fixtures con cortes ajenos, `cashAllocations`,
 *    pedido parcialmente cubierto, prepago, corte viejo sin `cashAllocations`, corte inexistente y sin asientos.
 *    Supuesto medido en T1 (evidencia t1-linea-base.txt): ningun corte tiene un `cashAllocations[].orderId`
 *    fuera de su `orderIds`; los fixtures lo respetan.
 * 2. Instantanea: la salida de `orderPayload`, `classifyOrder`, `buildPaymentInfo` y `computeKpis` sobre estos
 *    fixtures, capturada ejecutando el codigo ACTUAL de `store-api.ts` (antes de mover) y copiada aqui. Tras
 *    el movimiento tiene que salir identica, campo a campo.
 *
 * `store-api.ts` importa `firebase-admin` y `firebase-functions` a nivel de modulo y en la raiz no esta
 * `firebase-admin`, asi que no se puede cargar aqui: por eso se compara contra valores fijados.
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle con
 * su propio mensaje en vez de tumbar el archivo entero.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodReceivedSet } from "../../functions/src/seller-ledger";

const MODULE = "../../functions/src/store-api-orders";

async function load() {
  return import(MODULE);
}

const SELLER = "seller-a";
const OTHER_SELLER = "seller-b";

const ORDERS: Record<string, any>[] = [
  { id: "o1", sellerId: SELLER, status: "delivered", driverId: "d1", messengerId: "m1", paymentMethod: "cod", totalCop: 89900.4, trackingCode: "KNT-000001", shopifyOrderId: "5551", customerName: "Ana Ruiz", createdAt: "2026-09-10T15:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" },
  { id: "o2", sellerId: SELLER, status: "delivered", driverId: "d1", messengerId: "m1", paymentMethod: "cod", totalCop: 120000, trackingCode: "KNT-000002", shopifyOrderId: 5552, customerName: "Beto", createdAt: "2026-09-11T09:30:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z" },
  { id: "o3", sellerId: SELLER, status: "delivered", driverId: "d2", messengerId: "m2", paymentMethod: "prepaid", totalCop: "45000", trackingCode: "KNT-000003", customerName: "Carla", createdAt: "2026-09-12T08:00:00.000Z" },
  { id: "o4", sellerId: SELLER, status: "imported", updatedAt: "2026-09-13T12:00:00.000Z" },
  { id: "o5", sellerId: SELLER, status: "delivered", driverId: "d1", messengerId: "m3", paymentMethod: "cod", totalCop: 70000, trackingCode: "KNT-000005", createdAt: "2026-09-05T08:00:00.000Z" },
  { id: "o6", sellerId: SELLER, status: "failed", failedCategory: "failed_visit", failedReason: "No estaba", driverId: "d1", messengerId: "m1", paymentMethod: "cod", totalCop: 60000, createdAt: "2026-09-06T08:00:00.000Z" },
  { id: "o7", sellerId: SELLER, status: "failed", failedCategory: "no_coverage", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-07T08:00:00.000Z" },
  { id: "o8", sellerId: SELLER, status: "failed", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-07T09:00:00.000Z" },
  { id: "o9", sellerId: SELLER, status: "picked_up", driverId: "d1", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-08T09:00:00.000Z" },
  { id: "o10", sellerId: SELLER, status: "in_route", driverId: "d1", messengerId: "m1", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-08T10:00:00.000Z" },
  { id: "o11", sellerId: SELLER, status: "ready_to_assign", driverId: null, paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-09T10:00:00.000Z" },
  { id: "o12", sellerId: SELLER, status: "address_risk", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-09T11:00:00.000Z" },
  { id: "o13", sellerId: SELLER, status: "cancelled", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-09T12:00:00.000Z" },
  { id: "o14", sellerId: SELLER, status: "liquidated", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-04T12:00:00.000Z" },
  { id: "o15", sellerId: SELLER, status: "failed", failedCategory: "bad_phone", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-04T13:00:00.000Z" },
  { id: "o16", sellerId: SELLER, status: "failed", failedCategory: "bad_order_or_no_contact", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-04T14:00:00.000Z" },
  { id: "o17", sellerId: SELLER, status: "assigned", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-04T15:00:00.000Z" },
  { id: "o18", sellerId: SELLER, status: "delivered", driverId: "d1", messengerId: "m1", paymentMethod: "cod", totalCop: 99000, createdAt: "2026-09-03T15:00:00.000Z" },
  { id: "o19", sellerId: SELLER, status: "delivered", driverId: "d2", messengerId: "m2", paymentMethod: "prepaid", totalCop: 51000, createdAt: "2026-09-02T15:00:00.000Z" },
  { id: "o20", sellerId: SELLER, status: "failed", failedCategory: "pending_review", driverId: "d2", paymentMethod: "cod", totalCop: 30000, createdAt: "2026-09-02T16:00:00.000Z" }
];

const SETTLEMENTS: Record<string, any>[] = [
  // Corte de domiciliario con cashAllocations: o1 cubierto, o2 parcialmente cubierto, y un pedido ajeno.
  { id: "drv-1", kind: "driver", ownerId: "d1", status: "pending", orderIds: ["o1", "o2", "x-other-1"], cashAllocations: [
    { orderId: "o1", covered: true, receivedCop: 89900 },
    { orderId: "o2", covered: false, receivedCop: 50000 },
    { orderId: "x-other-1", covered: true, receivedCop: 40000 }
  ] },
  // Corte viejo sin cashAllocations, pagado: cuenta como recibido por orderIds.
  { id: "drv-legacy", kind: "driver", ownerId: "d1", status: "paid", orderIds: ["o5", "x-other-2"] },
  // Corte viejo sin cashAllocations pero pendiente: NO cuenta como recibido.
  { id: "drv-pending", kind: "driver", ownerId: "d1", status: "pending", orderIds: ["o6"] },
  // Cortes ajenos (otro domiciliario, otra tienda) que no mencionan pedidos de la tienda.
  { id: "drv-foreign", kind: "driver", ownerId: "d9", status: "reconciled", orderIds: ["x-other-3"], cashAllocations: [{ orderId: "x-other-3", covered: true, receivedCop: 10000 }] },
  { id: "sel-b-paid", kind: "seller", ownerId: OTHER_SELLER, status: "paid", paidAt: "2026-09-20T10:00:00.000Z", orderIds: ["x-other-2"] },
  // Cortes de la tienda.
  { id: "sel-a-pending", kind: "seller", ownerId: SELLER, status: "pending", orderIds: ["o1"] },
  { id: "sel-a-paid", kind: "seller", ownerId: SELLER, status: "paid", paidAt: "2026-09-21T10:00:00.000Z", orderIds: ["o5"] },
  { id: "sel-a-recon", kind: "seller", ownerId: SELLER, status: "reconciled", paidAt: "2026-09-22T10:00:00.000Z", orderIds: ["o18", "o19"] }
];

const ENTRIES: Record<string, any>[] = [
  // o1: COD cubierto, todo en un corte pendiente de la tienda -> en_liquidacion.
  { id: "e1a", ownerType: "seller", ownerId: SELLER, orderId: "o1", type: "cod_revenue", amountCop: 89900, settlementId: "sel-a-pending" },
  { id: "e1b", ownerType: "seller", ownerId: SELLER, orderId: "o1", type: "delivery_fee", amountCop: -13500, settlementId: "sel-a-pending" },
  { id: "e1c", ownerType: "seller", ownerId: SELLER, orderId: "o1", type: "product_cost", amountCop: -30000.6, settlementId: "sel-a-pending" },
  { id: "e1m", ownerType: "seller", ownerId: SELLER, orderId: "o1", type: "platform_margin", amountCop: 5000, settlementId: "sel-a-pending" },
  // Asientos del mismo pedido de OTROS duenos: la consulta por orderId los trae, no cuentan.
  { id: "e1d", ownerType: "driver", ownerId: "d1", orderId: "o1", type: "delivery_fee", amountCop: 8000, settlementId: "drv-1" },
  { id: "e1p", ownerType: "platform", ownerId: "platform", orderId: "o1", type: "platform_margin", amountCop: 5500 },
  // o2: COD parcialmente cubierto, sin cortar -> pendiente_bloqueado_cod.
  { id: "e2a", ownerType: "seller", ownerId: SELLER, orderId: "o2", type: "cod_revenue", amountCop: 120000 },
  { id: "e2b", ownerType: "seller", ownerId: SELLER, orderId: "o2", type: "delivery_fee", amountCop: -12000 },
  { id: "e2c", ownerType: "seller", ownerId: SELLER, orderId: "o2", type: "fulfillment_fee", amountCop: -2500 },
  // o3: prepago sin cortar -> pendiente_habilitado.
  { id: "e3a", ownerType: "seller", ownerId: SELLER, orderId: "o3", type: "delivery_fee", amountCop: -13500 },
  { id: "e3b", ownerType: "seller", ownerId: SELLER, orderId: "o3", type: "product_cost", amountCop: -20000 },
  // o5: COD por corte viejo pagado, en corte pagado de la tienda -> pagado.
  { id: "e5a", ownerType: "seller", ownerId: SELLER, orderId: "o5", type: "cod_remittance", amountCop: 70000, settlementId: "sel-a-paid" },
  { id: "e5b", ownerType: "seller", ownerId: SELLER, orderId: "o5", type: "delivery_fee", amountCop: -13500, settlementId: "sel-a-paid" },
  // o6: fallido cobrable, corte viejo pendiente (no recibido) -> pendiente_bloqueado_cod.
  { id: "e6a", ownerType: "seller", ownerId: SELLER, orderId: "o6", type: "failed_fee", amountCop: -7000 },
  // o18: un asiento en corte conciliado y otro en un corte que no existe -> en_liquidacion, "desconocido".
  { id: "e18a", ownerType: "seller", ownerId: SELLER, orderId: "o18", type: "cod_revenue", amountCop: 99000, settlementId: "sel-a-recon" },
  { id: "e18b", ownerType: "seller", ownerId: SELLER, orderId: "o18", type: "delivery_fee", amountCop: -13500, settlementId: "stl-ghost" },
  // o19: prepago, uno cortado y uno sin cortar -> pendiente_habilitado.
  { id: "e19a", ownerType: "seller", ownerId: SELLER, orderId: "o19", type: "delivery_fee", amountCop: -13500, settlementId: "sel-a-recon" },
  { id: "e19b", ownerType: "seller", ownerId: SELLER, orderId: "o19", type: "product_cost", amountCop: -18000 },
  // Otra tienda con asientos propios (ajenos).
  { id: "eb1", ownerType: "seller", ownerId: OTHER_SELLER, orderId: "x-other-2", type: "cod_revenue", amountCop: 50000, settlementId: "sel-b-paid" },
  // Asiento de OTRA tienda que apunta al pedido o3 (dato raro): no debe entrar.
  { id: "eb3", ownerType: "seller", ownerId: OTHER_SELLER, orderId: "o3", type: "delivery_fee", amountCop: -999, settlementId: "sel-b-paid" }
];

/** Carga completa de hoy (store-api.ts): asientos de la tienda y TODOS los cortes. */
function fullLoad() {
  const sellerEntries = ENTRIES.filter((entry) => entry.ownerType === "seller" && entry.ownerId === SELLER);
  const settlementsById = new Map(SETTLEMENTS.map((settlement) => [String(settlement.id), settlement]));
  return { sellerEntries, settlementsById, codReceived: buildCodReceivedSet(SETTLEMENTS) };
}

/**
 * Lo que leeria Firestore en la carga dirigida del plan 2.10: asientos por `orderId` (de cualquier dueno),
 * `getAll` de los `settlementId` de los asientos de la tienda (un id inexistente no devuelve nada) y cortes con
 * `orderIds array-contains id`. Los cortes pueden venir repetidos entre las dos lecturas.
 */
function simulatedTargetedRead(orderId: string) {
  const entries = ENTRIES.filter((entry) => entry.orderId === orderId);
  const ids = new Set(
    entries
      .filter((entry) => entry.ownerType === "seller" && entry.ownerId === SELLER)
      .map((entry) => entry.settlementId)
      .filter(Boolean)
  );
  const byGetAll = SETTLEMENTS.filter((settlement) => ids.has(settlement.id));
  const byContains = SETTLEMENTS.filter((settlement) => (settlement.orderIds ?? []).includes(orderId));
  return { entries, settlements: [...byGetAll, ...byContains] };
}

describe("T9 · loadTargetedPaymentInputs (carga dirigida, plan 2.10)", () => {
  it("exporta loadTargetedPaymentInputs como funcion", async () => {
    const mod = await load();
    expect(typeof mod.loadTargetedPaymentInputs).toBe("function");
  });

  for (const order of ORDERS) {
    it(`buildPaymentInfo con los cortes dirigidos == con todos los cortes (${order.id})`, async () => {
      const { buildPaymentInfo, loadTargetedPaymentInputs } = await load();
      const full = fullLoad();
      const read = simulatedTargetedRead(String(order.id));
      const targeted = loadTargetedPaymentInputs({ orderId: String(order.id), sellerId: SELLER, ...read });
      expect(buildPaymentInfo(order, targeted.sellerEntries, targeted.settlementsById, targeted.codReceived))
        .toEqual(buildPaymentInfo(order, full.sellerEntries, full.settlementsById, full.codReceived));
    });
  }

  it("solo conserva asientos de la tienda y del pedido pedido (descarta otros duenos, otra tienda y otro pedido)", async () => {
    const { loadTargetedPaymentInputs } = await load();
    const stray = { id: "e-stray", ownerType: "seller", ownerId: SELLER, orderId: "o2", type: "cod_revenue", amountCop: 1 };
    const read = simulatedTargetedRead("o1");
    const targeted = loadTargetedPaymentInputs({ orderId: "o1", sellerId: SELLER, entries: [...read.entries, stray], settlements: read.settlements });
    expect(targeted.sellerEntries.map((entry: { id: string }) => entry.id).sort()).toEqual(["e1a", "e1b", "e1c", "e1m"]);
  });

  it("deduplica los cortes que llegan por las dos lecturas", async () => {
    const { loadTargetedPaymentInputs } = await load();
    const read = simulatedTargetedRead("o1");
    expect(read.settlements.length).toBeGreaterThan(new Set(read.settlements.map((s) => s.id)).size);
    const targeted = loadTargetedPaymentInputs({ orderId: "o1", sellerId: SELLER, ...read });
    expect([...targeted.settlementsById.keys()].sort()).toEqual(["drv-1", "sel-a-pending"]);
  });

  it("COD parcialmente cubierto no cuenta como recibido; cubierto y corte viejo pagado si", async () => {
    const { loadTargetedPaymentInputs } = await load();
    const received = (orderId: string) =>
      loadTargetedPaymentInputs({ orderId, sellerId: SELLER, ...simulatedTargetedRead(orderId) }).codReceived.has(orderId);
    expect({ o1: received("o1"), o2: received("o2"), o5: received("o5"), o6: received("o6") })
      .toEqual({ o1: true, o2: false, o5: true, o6: false });
  });

  it("pedido sin asientos ni cortes devuelve entradas vacias", async () => {
    const { loadTargetedPaymentInputs } = await load();
    const targeted = loadTargetedPaymentInputs({ orderId: "o4", sellerId: SELLER, entries: [], settlements: [] });
    expect({ entries: targeted.sellerEntries.length, settlements: targeted.settlementsById.size, cod: targeted.codReceived.size })
      .toEqual({ entries: 0, settlements: 0, cod: 0 });
  });
});

// Salida del codigo ACTUAL de functions/src/store-api.ts (capturada antes de mover, ver cabecera).
// Nota: costoProductoCop de o1 sale 30000.6 porque chargeMagnitude no redondea; es el comportamiento de hoy.
const EXPECTED_SNAPSHOT: Record<string, any> = {"pedidos":{"o1":{"id":"o1","trackingCode":"KNT-000001","shopifyOrderId":"5551","status":"delivered","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":89900,"customerName":"Ana Ruiz","createdAt":"2026-09-10T15:00:00.000Z","updatedAt":"2026-09-11T10:00:00.000Z","fecha":"2026-09-10","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":true,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"en_liquidacion","pagado":false,"habilitadoParaPago":true,"netoCop":46399,"desglose":{"codCop":89900,"fleteCop":13500,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":30000.6},"movimientos":3,"movimientosSinLiquidar":0,"settlementIds":["sel-a-pending"],"settlements":[{"id":"sel-a-pending","status":"pending","paidAt":null}]}},"o2":{"id":"o2","trackingCode":"KNT-000002","shopifyOrderId":5552,"status":"delivered","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":120000,"customerName":"Beto","createdAt":"2026-09-11T09:30:00.000Z","updatedAt":"2026-09-12T10:00:00.000Z","fecha":"2026-09-11","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":true,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"pendiente_bloqueado_cod","pagado":false,"habilitadoParaPago":false,"netoCop":105500,"desglose":{"codCop":120000,"fleteCop":12000,"failedFeeCop":0,"fulfillmentCop":2500,"costoProductoCop":0},"movimientos":3,"movimientosSinLiquidar":3,"settlementIds":[],"settlements":[]}},"o3":{"id":"o3","trackingCode":"KNT-000003","shopifyOrderId":null,"status":"delivered","failedCategory":null,"failedReason":null,"paymentMethod":"prepaid","totalCop":45000,"customerName":"Carla","createdAt":"2026-09-12T08:00:00.000Z","updatedAt":null,"fecha":"2026-09-12","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":true,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"pendiente_habilitado","pagado":false,"habilitadoParaPago":true,"netoCop":-33500,"desglose":{"codCop":0,"fleteCop":13500,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":20000},"movimientos":2,"movimientosSinLiquidar":2,"settlementIds":[],"settlements":[]}},"o4":{"id":"o4","trackingCode":null,"shopifyOrderId":null,"status":"imported","failedCategory":null,"failedReason":null,"paymentMethod":null,"totalCop":0,"customerName":null,"createdAt":null,"updatedAt":"2026-09-13T12:00:00.000Z","fecha":"2026-09-13","operacion":{"takenByDriver":false,"dispatchable":false,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":false},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o5":{"id":"o5","trackingCode":"KNT-000005","shopifyOrderId":null,"status":"delivered","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":70000,"customerName":null,"createdAt":"2026-09-05T08:00:00.000Z","updatedAt":null,"fecha":"2026-09-05","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":true,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"pagado","pagado":true,"habilitadoParaPago":true,"netoCop":56500,"desglose":{"codCop":70000,"fleteCop":13500,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":2,"movimientosSinLiquidar":0,"settlementIds":["sel-a-paid"],"settlements":[{"id":"sel-a-paid","status":"paid","paidAt":"2026-09-21T10:00:00.000Z"}]}},"o6":{"id":"o6","trackingCode":null,"shopifyOrderId":null,"status":"failed","failedCategory":"failed_visit","failedReason":"No estaba","paymentMethod":"cod","totalCop":60000,"customerName":null,"createdAt":"2026-09-06T08:00:00.000Z","updatedAt":null,"fecha":"2026-09-06","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":false,"failed":true,"chargeableFailed":true,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"pendiente_bloqueado_cod","pagado":false,"habilitadoParaPago":false,"netoCop":-7000,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":7000,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":1,"movimientosSinLiquidar":1,"settlementIds":[],"settlements":[]}},"o7":{"id":"o7","trackingCode":null,"shopifyOrderId":null,"status":"failed","failedCategory":"no_coverage","failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-07T08:00:00.000Z","updatedAt":null,"fecha":"2026-09-07","operacion":{"takenByDriver":true,"dispatchable":false,"delivered":false,"failed":true,"chargeableFailed":false,"noCoverageFailed":true,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o8":{"id":"o8","trackingCode":null,"shopifyOrderId":null,"status":"failed","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-07T09:00:00.000Z","updatedAt":null,"fecha":"2026-09-07","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":false,"failed":true,"chargeableFailed":true,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o9":{"id":"o9","trackingCode":null,"shopifyOrderId":null,"status":"picked_up","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":null,"fecha":"2026-09-08","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":false},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o10":{"id":"o10","trackingCode":null,"shopifyOrderId":null,"status":"in_route","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-08T10:00:00.000Z","updatedAt":null,"fecha":"2026-09-08","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":false},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o11":{"id":"o11","trackingCode":null,"shopifyOrderId":null,"status":"ready_to_assign","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-09T10:00:00.000Z","updatedAt":null,"fecha":"2026-09-09","operacion":{"takenByDriver":false,"dispatchable":false,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":false},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o12":{"id":"o12","trackingCode":null,"shopifyOrderId":null,"status":"address_risk","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-09T11:00:00.000Z","updatedAt":null,"fecha":"2026-09-09","operacion":{"takenByDriver":false,"dispatchable":false,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":false},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o13":{"id":"o13","trackingCode":null,"shopifyOrderId":null,"status":"cancelled","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-09T12:00:00.000Z","updatedAt":null,"fecha":"2026-09-09","operacion":{"takenByDriver":false,"dispatchable":false,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o14":{"id":"o14","trackingCode":null,"shopifyOrderId":null,"status":"liquidated","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-04T12:00:00.000Z","updatedAt":null,"fecha":"2026-09-04","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o15":{"id":"o15","trackingCode":null,"shopifyOrderId":null,"status":"failed","failedCategory":"bad_phone","failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-04T13:00:00.000Z","updatedAt":null,"fecha":"2026-09-04","operacion":{"takenByDriver":true,"dispatchable":false,"delivered":false,"failed":true,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":true,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o16":{"id":"o16","trackingCode":null,"shopifyOrderId":null,"status":"failed","failedCategory":"bad_order_or_no_contact","failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-04T14:00:00.000Z","updatedAt":null,"fecha":"2026-09-04","operacion":{"takenByDriver":true,"dispatchable":false,"delivered":false,"failed":true,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":true,"badPhoneFailed":false,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o17":{"id":"o17","trackingCode":null,"shopifyOrderId":null,"status":"assigned","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-04T15:00:00.000Z","updatedAt":null,"fecha":"2026-09-04","operacion":{"takenByDriver":false,"dispatchable":false,"delivered":false,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":false},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}},"o18":{"id":"o18","trackingCode":null,"shopifyOrderId":null,"status":"delivered","failedCategory":null,"failedReason":null,"paymentMethod":"cod","totalCop":99000,"customerName":null,"createdAt":"2026-09-03T15:00:00.000Z","updatedAt":null,"fecha":"2026-09-03","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":true,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"en_liquidacion","pagado":false,"habilitadoParaPago":false,"netoCop":85500,"desglose":{"codCop":99000,"fleteCop":13500,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":2,"movimientosSinLiquidar":0,"settlementIds":["sel-a-recon","stl-ghost"],"settlements":[{"id":"sel-a-recon","status":"reconciled","paidAt":"2026-09-22T10:00:00.000Z"},{"id":"stl-ghost","status":"desconocido","paidAt":null}]}},"o19":{"id":"o19","trackingCode":null,"shopifyOrderId":null,"status":"delivered","failedCategory":null,"failedReason":null,"paymentMethod":"prepaid","totalCop":51000,"customerName":null,"createdAt":"2026-09-02T15:00:00.000Z","updatedAt":null,"fecha":"2026-09-02","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":true,"failed":false,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"pendiente_habilitado","pagado":false,"habilitadoParaPago":true,"netoCop":-31500,"desglose":{"codCop":0,"fleteCop":13500,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":18000},"movimientos":2,"movimientosSinLiquidar":1,"settlementIds":["sel-a-recon"],"settlements":[{"id":"sel-a-recon","status":"reconciled","paidAt":"2026-09-22T10:00:00.000Z"}]}},"o20":{"id":"o20","trackingCode":null,"shopifyOrderId":null,"status":"failed","failedCategory":"pending_review","failedReason":null,"paymentMethod":"cod","totalCop":30000,"customerName":null,"createdAt":"2026-09-02T16:00:00.000Z","updatedAt":null,"fecha":"2026-09-02","operacion":{"takenByDriver":true,"dispatchable":true,"delivered":false,"failed":true,"chargeableFailed":false,"noCoverageFailed":false,"badOrderFailed":false,"badPhoneFailed":false,"closed":true},"pago":{"estado":"sin_movimientos","pagado":false,"habilitadoParaPago":false,"netoCop":0,"desglose":{"codCop":0,"fleteCop":0,"failedFeeCop":0,"fulfillmentCop":0,"costoProductoCop":0},"movimientos":0,"movimientosSinLiquidar":0,"settlementIds":[],"settlements":[]}}},"kpis":{"totalPedidos":20,"embudo":{"pendienteConfirmar":2,"listoSinLider":1,"asignadoPendienteRecoger":1,"recogidoSinMensajero":1,"enGestionORuta":1,"entregados":6,"fallidos":6,"cancelados":1,"liquidados":1},"indicadores":{"tomadosPorDomiciliario":15,"despachables":12,"abiertosDespachables":3,"porcentajeDespacho":80,"porcentajeTerminacion":75,"porcentajeEntrega":50,"porcentajeDevolucion":17},"fallidosPorCategoria":{"fallidoConVisita":2,"sinCobertura":1,"pedidoMaloNoContesta":1,"sinTelefonoLineaInactiva":1},"formulas":{"tomadosPorDomiciliario":"pedidos con domiciliario asignado en estado llamada/agendado/recogido/en ruta/reintento/entregado/fallido/liquidado","despachables":"tomados por domiciliario menos fallidos sin cobertura, pedido malo/no contesta y sin telefono/linea inactiva","porcentajeDespacho":"despachables / tomados por domiciliario","porcentajeTerminacion":"(entregados + fallidos con visita + liquidados) / despachables","porcentajeEntrega":"entregados / despachables","porcentajeDevolucion":"fallidos con visita / despachables"}},"fechas":["2026-09-10","2026-09-11","2026-09-12","2026-09-13","2026-09-05","2026-09-06","2026-09-07","2026-09-07","2026-09-08","2026-09-08","2026-09-09","2026-09-09","2026-09-09","2026-09-04","2026-09-04","2026-09-04","2026-09-04","2026-09-03","2026-09-02","2026-09-02"]};

describe("T9 · instantanea de /orders identica antes y despues de mover", () => {
  for (const order of ORDERS) {
    it(`orderPayload, classifyOrder y buildPaymentInfo sin cambios (${order.id})`, async () => {
      const { orderPayload, classifyOrder, buildPaymentInfo } = await load();
      const full = fullLoad();
      const actual = {
        ...orderPayload(order),
        operacion: classifyOrder(order),
        pago: buildPaymentInfo(order, full.sellerEntries, full.settlementsById, full.codReceived)
      };
      const expected = EXPECTED_SNAPSHOT.pedidos[String(order.id)];
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
      for (const key of Object.keys(expected)) expect({ [key]: actual[key as keyof typeof actual] }).toEqual({ [key]: expected[key] });
    });
  }

  it("computeKpis sobre todos los pedidos sin cambios", async () => {
    const { computeKpis } = await load();
    expect(computeKpis(ORDERS)).toEqual(EXPECTED_SNAPSHOT.kpis);
  });

  it("orderDateValue sigue usando createdAt || updatedAt recortado a dia", async () => {
    const { orderDateValue } = await load();
    expect(ORDERS.map((order) => orderDateValue(order))).toEqual(EXPECTED_SNAPSHOT.fechas);
  });

  it("store-api.ts importa la forma de pedido de store-api-orders y ya no la define", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../functions/src/store-api.ts"), "utf8");
    expect(source).toMatch(/from\s+"\.\/store-api-orders"/);
    for (const name of ["orderPayload", "classifyOrder", "buildPaymentInfo", "computeKpis", "orderDateValue"]) {
      expect({ name, defined: new RegExp(`function\\s+${name}\\s*\\(`).test(source) }).toEqual({ name, defined: false });
    }
  });
});
