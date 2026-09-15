/**
 * T1 · RNF_01 — Prueba de CARACTERIZACION del cobro de hoy.
 *
 * A diferencia de una prueba RED normal, esta DEBE pasar en verde contra el codigo actual: fija
 * con importes literales lo que cobran HOY el servidor (`buildWalletEntries` + `resolveTariffs`,
 * que es exactamente lo que hace `closeOrder` en functions/src/orders.ts) y la app
 * (`entriesForClosedOrder` en src/lib/finance.ts). Las tareas siguientes mueven la regla de cobro
 * a `functions/src/seller-charges.ts`; si alguna cambia un solo peso de una tienda sin comunidad,
 * esta prueba se pone roja. Escrita despues del cambio fijaria el cambio, por eso va primero.
 *
 * Tarifas elegidas DISTINTAS entre si a proposito (ajustes vs zona, y cada campo con su valor),
 * para que un campo leido de donde no toca se note en el importe y no pase por casualidad.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWalletEntries,
  dandaDeliveredFeeCop,
  resolveTariffs
} from "../../functions/src/wallet-entries";
import { entriesForClosedOrder, sellerDeliveredFeeForOrder } from "./finance";
import { emptyState } from "./seed";
import type { AppState, Evidence, FailedCategory, Order, WalletEntry, Zone } from "./types";

// Instante de cierre del servidor (su `now`). Para tiendas normales no influye en ningun importe.
const CLOSED_AT = "2026-09-10T12:00:00.000Z";

// Cortes de fecha de DANDA, y el milisegundo anterior a cada uno.
const DANDA_SELLER_ID = "seller-1779315416119";
const DANDA_DRIVER_ID = "driver-1778271901513";
const DANDA_FEE_CUTOFF = "2026-07-17T05:00:00.000Z";
const BEFORE_DANDA_FEE_CUTOFF = "2026-07-17T04:59:59.999Z";
const DANDA_PAY_CUTOFF = "2026-06-09T05:00:00.000Z";
const BEFORE_DANDA_PAY_CUTOFF = "2026-06-09T04:59:59.999Z";

// Ajustes globales. `sellerFailedFeeCop` en 9.000 reproduce ago-2026: se puso en la pantalla de
// ajustes y se siguio cobrando 12.000 (fijo en wallet-entries.ts y en finance.ts).
const SETTINGS = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 9000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 8000
};

// Zona con TODAS sus tarifas distintas de las globales.
const ZONE: Zone = {
  id: "zone-t1",
  cityId: "city-cali",
  name: "Zona T1",
  polygonLabel: "Zona de caracterizacion",
  active: true,
  sellerDeliveredFeeCop: 14000,
  sellerFailedFeeCop: 11000,
  fulfillmentFeeCop: 2500,
  driverDeliveredPayCop: 9500,
  driverFailedPayCop: 8500
};

type SettingsOverride = Partial<AppState["settings"]>;

function appState(override: SettingsOverride = {}): AppState {
  const base = emptyState();
  return { ...base, zones: [ZONE], settings: { ...base.settings, ...SETTINGS, ...override } };
}

function makeOrder(override: Partial<Order> = {}): Order {
  return {
    id: "ord-t1",
    shopifyOrderId: "KNT-T1",
    sellerId: "seller-normal",
    cityId: "city-cali",
    driverId: "driver-t1",
    customerName: "Cliente T1",
    customerPhone: "+573000000000",
    addressRaw: "Calle 1 # 2-3",
    addressRisk: "accepted",
    status: "delivered",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    totalCop: 85000,
    evidence: [],
    createdAt: "2026-07-01T15:00:00.000Z",
    updatedAt: "2026-07-01T18:00:00.000Z",
    ...override
  };
}

function failedEvidence(index: number, failedCategory?: FailedCategory): Evidence {
  return {
    id: `ev-failed-${index}`,
    type: "failed",
    photoLabel: "Foto",
    note: "No atendio",
    failedCategory,
    createdAt: `2026-07-0${index}T20:00:00.000Z`,
    actorId: "driver-t1"
  };
}

function deliveryEvidence(createdAt: string): Evidence {
  return {
    id: `ev-delivery-${createdAt}`,
    type: "delivery",
    photoLabel: "Foto",
    note: "Entregado",
    createdAt,
    actorId: "driver-t1"
  };
}

/** Fallido con su evidencia, como lo deja el cierre. `failedCategory` undefined = campo ausente. */
function failedOrder(failedCategory: FailedCategory | undefined, override: Partial<Order> = {}): Order {
  return makeOrder({ status: "failed", failedCategory, evidence: [failedEvidence(1, failedCategory)], ...override });
}

/** Lo que importa del asiento para el dinero. Sin descripcion, createdAt ni settlementId. */
type MoneyRow = {
  id: string;
  type: WalletEntry["type"];
  ownerType: WalletEntry["ownerType"];
  ownerId: string;
  amountCop: number;
};

function row(id: string, type: MoneyRow["type"], ownerType: MoneyRow["ownerType"], ownerId: string, amountCop: number): MoneyRow {
  return { id, type, ownerType, ownerId, amountCop };
}

// Ordenado por id: reordenar el push de asientos no mueve un peso y no debe romper la red.
// `+ 0` convierte -0 en 0 (la app hace `-tarifa` y con tarifa 0 da -0; no es dinero distinto).
function moneyOf(entries: ReadonlyArray<Pick<WalletEntry, "id" | "type" | "ownerType" | "ownerId" | "amountCop">>): MoneyRow[] {
  return entries
    .map((entry) => row(entry.id, entry.type, entry.ownerType, entry.ownerId, entry.amountCop + 0))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sorted(rows: MoneyRow[]): MoneyRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Servidor, tal como lo llama closeOrder: tarifas resueltas de ajustes + zona del pedido. */
function server(order: Order, now: string = CLOSED_AT, settings: Record<string, number> = SETTINGS): MoneyRow[] {
  const zone = order.zoneId === ZONE.id ? ZONE : undefined;
  return moneyOf(buildWalletEntries(order, resolveTariffs(settings, zone), now));
}

function app(order: Order, override: SettingsOverride = {}): MoneyRow[] {
  return moneyOf(entriesForClosedOrder(order, appState(override)));
}

// Asientos esperados de ord-t1, por concepto.
const cod = (amount = 85000, sellerId = "seller-normal") => row("we-ord-t1-cod", "cod_revenue", "seller", sellerId, amount);
const deliveryFee = (amount: number, sellerId = "seller-normal") =>
  row("we-ord-t1-seller-delivery-fee", "delivery_fee", "seller", sellerId, amount);
const deliveredPay = (amount: number, driverId = "driver-t1") =>
  row("we-ord-t1-driver-delivery-pay", "driver_earning", "driver", driverId, amount);
const failedFee = (amount: number, suffix = "") => row(`we-ord-t1-seller-failed-fee${suffix}`, "failed_fee", "seller", "seller-normal", amount);
const failedPay = (amount: number, suffix = "") => row(`we-ord-t1-driver-failed-pay${suffix}`, "driver_earning", "driver", "driver-t1", amount);
const fulfillment = (amount: number, sellerId = "seller-normal") =>
  row("we-ord-t1-fulfillment-fee", "fulfillment_fee", "seller", sellerId, amount);

describe("T1 · RNF_01: el cobro de hoy, fijado antes de moverlo", () => {
  describe("resolveTariffs (servidor): zona > ajuste > 0 > valor por defecto", () => {
    it("RNF_01 · con zona, cada tarifa sale de la zona", () => {
      expect(resolveTariffs(SETTINGS, ZONE)).toEqual({
        sellerDeliveredFeeCop: 14000,
        sellerFailedFeeCop: 11000,
        fulfillmentFeeCop: 2500,
        driverDeliveredPayCop: 9500,
        driverFailedPayCop: 8500
      });
    });

    it("RNF_01 · sin zona, cada tarifa sale de los ajustes", () => {
      expect(resolveTariffs(SETTINGS, undefined)).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 9000,
        fulfillmentFeeCop: 2000,
        driverDeliveredPayCop: 9000,
        driverFailedPayCop: 8000
      });
    });

    it("RNF_01 · sin ajustes ni zona, cae a los valores por defecto", () => {
      expect(resolveTariffs({}, undefined)).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 12000,
        fulfillmentFeeCop: 2000,
        driverDeliveredPayCop: 9000,
        driverFailedPayCop: 9000
      });
    });

    it("RNF_01 · un 0, negativo, ausente o no numerico no cuenta y cae al siguiente nivel", () => {
      const settings = { sellerDeliveredFeeCop: 0, fulfillmentFeeCop: 2000, driverDeliveredPayCop: 9000, driverFailedPayCop: 8000 };
      const zone = { sellerDeliveredFeeCop: 0, fulfillmentFeeCop: -500, driverDeliveredPayCop: "no-es-numero", driverFailedPayCop: 8500 };
      expect(resolveTariffs(settings, zone)).toEqual({
        sellerDeliveredFeeCop: 12000, // zona 0, ajuste 0 -> defecto
        sellerFailedFeeCop: 12000, // ausente en los dos -> defecto
        fulfillmentFeeCop: 2000, // zona negativa -> ajuste
        driverDeliveredPayCop: 9000, // zona no numerica -> ajuste
        driverFailedPayCop: 8500 // zona valida gana
      });
    });

    it("RNF_01 · un numero guardado como texto en la zona SI cuenta (Number('9800'))", () => {
      expect(resolveTariffs(SETTINGS, { driverDeliveredPayCop: "9800" }).driverDeliveredPayCop).toBe(9800);
    });
  });

  describe("dandaDeliveredFeeCop (servidor)", () => {
    it("RNF_01 · 12.000 hasta el milisegundo anterior al 2026-07-17T05:00Z", () => {
      expect(dandaDeliveredFeeCop(BEFORE_DANDA_FEE_CUTOFF)).toBe(12000);
    });

    it("RNF_01 · 13.500 desde el 2026-07-17T05:00Z inclusive", () => {
      expect(dandaDeliveredFeeCop(DANDA_FEE_CUTOFF)).toBe(13500);
      expect(dandaDeliveredFeeCop(CLOSED_AT)).toBe(13500);
    });

    it("RNF_01 · una fecha ilegible cobra 12.000", () => {
      expect(dandaDeliveredFeeCop("no-es-fecha")).toBe(12000);
      expect(dandaDeliveredFeeCop("")).toBe(12000);
    });
  });

  describe("tienda normal, entregado", () => {
    it("RNF_01 · sin zona, COD: recaudo = total, flete -12.000, pago transportista 9.000 (servidor)", () => {
      expect(server(makeOrder())).toEqual(sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]));
    });

    it("RNF_01 · sin zona, COD: recaudo = total, flete -12.000, pago transportista 9.000 (app)", () => {
      expect(app(makeOrder())).toEqual(sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]));
    });

    it("RNF_01 · prepagado: sin recaudo COD, el flete y el pago igual (servidor y app)", () => {
      const order = makeOrder({ paymentMethod: "prepaid" });
      const expected = sorted([deliveryFee(-12000), deliveredPay(9000)]);
      expect(server(order)).toEqual(expected);
      expect(app(order)).toEqual(expected);
    });

    it("RNF_01 · con zona: gana la zona, flete -14.000 y pago 9.500 (servidor)", () => {
      expect(server(makeOrder({ zoneId: ZONE.id }))).toEqual(sorted([cod(), deliveryFee(-14000), deliveredPay(9500)]));
    });

    it("RNF_01 · con zona: gana la zona, flete -14.000 y pago 9.500 (app)", () => {
      expect(app(makeOrder({ zoneId: ZONE.id }))).toEqual(sorted([cod(), deliveryFee(-14000), deliveredPay(9500)]));
    });

    it("RNF_01 · la fecha de cierre no mueve el cobro de una tienda normal (servidor)", () => {
      const expected = sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]);
      expect(server(makeOrder(), BEFORE_DANDA_FEE_CUTOFF)).toEqual(expected);
      expect(server(makeOrder(), DANDA_FEE_CUTOFF)).toEqual(expected);
    });
  });

  describe("tienda normal, fallido cobrable", () => {
    it("RNF_01 · failed_visit sin zona: cobro -12.000 aunque los ajustes digan 9.000; pago 8.000 (servidor)", () => {
      expect(server(failedOrder("failed_visit"))).toEqual(sorted([failedFee(-12000), failedPay(8000)]));
    });

    it("RNF_01 · failed_visit sin zona: cobro -12.000 aunque los ajustes digan 9.000; pago 8.000 (app)", () => {
      expect(app(failedOrder("failed_visit"))).toEqual(sorted([failedFee(-12000), failedPay(8000)]));
    });

    it("RNF_01 · failed_visit con zona: cobro -12.000 aunque la zona diga 11.000; pago de zona 8.500 (servidor)", () => {
      expect(server(failedOrder("failed_visit", { zoneId: ZONE.id }))).toEqual(sorted([failedFee(-12000), failedPay(8500)]));
    });

    it("RNF_01 · failed_visit con zona: cobro -12.000 aunque la zona diga 11.000; pago de zona 8.500 (app)", () => {
      expect(app(failedOrder("failed_visit", { zoneId: ZONE.id }))).toEqual(sorted([failedFee(-12000), failedPay(8500)]));
    });

    it("RNF_01 · failedCategory AUSENTE cuenta como cobrable (servidor y app)", () => {
      const order = failedOrder(undefined);
      const expected = sorted([failedFee(-12000), failedPay(8000)]);
      expect(server(order)).toEqual(expected);
      expect(app(order)).toEqual(expected);
    });

    it("RNF_01 · un ajuste de fallido en 0 tampoco cambia nada: sigue -12.000 (servidor y app)", () => {
      const order = failedOrder("failed_visit");
      const expected = sorted([failedFee(-12000), failedPay(8000)]);
      expect(server(order, CLOSED_AT, { ...SETTINGS, sellerFailedFeeCop: 0 })).toEqual(expected);
      expect(app(order, { sellerFailedFeeCop: 0 })).toEqual(expected);
    });
  });

  describe("tienda normal, visitas repetidas", () => {
    const secondVisit = makeOrder({
      status: "failed",
      failedCategory: "failed_visit",
      evidence: [failedEvidence(1, "failed_visit"), failedEvidence(2, "failed_visit")]
    });

    it("RNF_01 · segunda visita fallida: ids con sufijo -2, mismos importes (servidor)", () => {
      expect(server(secondVisit)).toEqual(sorted([failedFee(-12000, "-2"), failedPay(8000, "-2")]));
    });

    it("RNF_01 · segunda visita fallida: ids con sufijo -2, mismos importes (app)", () => {
      expect(app(secondVisit)).toEqual(sorted([failedFee(-12000, "-2"), failedPay(8000, "-2")]));
    });

    it("RNF_01 · una evidencia de fallido SIN categoria (reagenda) no suma intento: sin sufijo (servidor y app)", () => {
      const order = makeOrder({
        status: "failed",
        failedCategory: "failed_visit",
        evidence: [failedEvidence(1, undefined), failedEvidence(2, "failed_visit")]
      });
      const expected = sorted([failedFee(-12000), failedPay(8000)]);
      expect(server(order)).toEqual(expected);
      expect(app(order)).toEqual(expected);
    });
  });

  describe("tienda normal, desde bodega", () => {
    it("RNF_01 · entregado desde bodega sin zona: manejo -2.000 ademas del flete (servidor)", () => {
      expect(server(makeOrder({ fulfillmentMode: "warehouse" }))).toEqual(
        sorted([cod(), deliveryFee(-12000), deliveredPay(9000), fulfillment(-2000)])
      );
    });

    it("RNF_01 · entregado desde bodega sin zona: manejo -2.000 ademas del flete (app)", () => {
      expect(app(makeOrder({ fulfillmentMode: "warehouse" }))).toEqual(
        sorted([cod(), deliveryFee(-12000), deliveredPay(9000), fulfillment(-2000)])
      );
    });

    it("RNF_01 · entregado desde bodega con zona: manejo de zona -2.500 (servidor y app)", () => {
      const order = makeOrder({ fulfillmentMode: "warehouse", zoneId: ZONE.id });
      const expected = sorted([cod(), deliveryFee(-14000), deliveredPay(9500), fulfillment(-2500)]);
      expect(server(order)).toEqual(expected);
      expect(app(order)).toEqual(expected);
    });

    it("RNF_01 · fallido cobrable desde bodega: tambien cobra manejo -2.000 (servidor y app)", () => {
      const order = failedOrder("failed_visit", { fulfillmentMode: "warehouse" });
      const expected = sorted([failedFee(-12000), failedPay(8000), fulfillment(-2000)]);
      expect(server(order)).toEqual(expected);
      expect(app(order)).toEqual(expected);
    });
  });

  describe("tienda normal, fallido NO cobrable", () => {
    // Regla de oro #4: cobrable es failed_visit o ausente; las otras cuatro no generan dinero,
    // ni cobro, ni pago al transportista, ni manejo de bodega.
    const nonChargeable: FailedCategory[] = ["no_coverage", "bad_order_or_no_contact", "bad_phone", "pending_review"];

    it.each(nonChargeable)("RNF_01 · %s: ningun asiento, ni desde bodega (servidor)", (category) => {
      expect(server(failedOrder(category))).toEqual([]);
      expect(server(failedOrder(category, { fulfillmentMode: "warehouse", zoneId: ZONE.id }))).toEqual([]);
    });

    it.each(nonChargeable)("RNF_01 · %s: ningun asiento, ni desde bodega (app)", (category) => {
      expect(app(failedOrder(category))).toEqual([]);
      expect(app(failedOrder(category, { fulfillmentMode: "warehouse", zoneId: ZONE.id }))).toEqual([]);
    });
  });

  describe("DANDA (tarifa especial en codigo)", () => {
    const danda = (override: Partial<Order> = {}) => makeOrder({ sellerId: DANDA_SELLER_ID, ...override });

    it("RNF_01 · entregado ANTES del corte del 17-jul: flete -12.000, pago 10.000 (servidor)", () => {
      expect(server(danda(), BEFORE_DANDA_FEE_CUTOFF)).toEqual(
        sorted([cod(85000, DANDA_SELLER_ID), deliveryFee(-12000, DANDA_SELLER_ID), deliveredPay(10000)])
      );
    });

    it("RNF_01 · entregado DESDE el corte del 17-jul: flete -13.500 (servidor, la fecha es `now`)", () => {
      expect(server(danda(), DANDA_FEE_CUTOFF)).toEqual(
        sorted([cod(85000, DANDA_SELLER_ID), deliveryFee(-13500, DANDA_SELLER_ID), deliveredPay(10000)])
      );
    });

    it("RNF_01 · la zona NO mueve el flete ni el pago de DANDA, pero SI su manejo de bodega (servidor)", () => {
      const order = danda({ zoneId: ZONE.id, fulfillmentMode: "warehouse" });
      expect(server(order, DANDA_FEE_CUTOFF)).toEqual(
        sorted([
          cod(85000, DANDA_SELLER_ID),
          deliveryFee(-13500, DANDA_SELLER_ID),
          deliveredPay(10000),
          fulfillment(-2500, DANDA_SELLER_ID)
        ])
      );
    });

    it("RNF_01 · pago 11.000 con el transportista preferido y recogida desde el 2026-06-09T05:00Z (servidor)", () => {
      const order = danda({ driverId: DANDA_DRIVER_ID, pickedUpAt: DANDA_PAY_CUTOFF });
      expect(server(order, BEFORE_DANDA_FEE_CUTOFF)).toEqual(
        sorted([cod(85000, DANDA_SELLER_ID), deliveryFee(-12000, DANDA_SELLER_ID), deliveredPay(11000, DANDA_DRIVER_ID)])
      );
    });

    it("RNF_01 · pago 10.000 si falta una condicion: recogida anterior, sin recogida u otro transportista (servidor)", () => {
      const pay = (order: Order) => server(order).find((entry) => entry.id === "we-ord-t1-driver-delivery-pay")?.amountCop;
      expect(pay(danda({ driverId: DANDA_DRIVER_ID, pickedUpAt: BEFORE_DANDA_PAY_CUTOFF }))).toBe(10000);
      expect(pay(danda({ driverId: DANDA_DRIVER_ID }))).toBe(10000);
      expect(pay(danda({ driverId: "driver-otro", pickedUpAt: DANDA_PAY_CUTOFF }))).toBe(10000);
    });

    it("RNF_01 · la app toma la fecha del flete de la evidencia de entrega, no de updatedAt", () => {
      const fee = (order: Order) => app(order).find((entry) => entry.id === "we-ord-t1-seller-delivery-fee")?.amountCop;
      // Evidencia antes del corte gana aunque updatedAt sea posterior.
      expect(fee(danda({ evidence: [deliveryEvidence(BEFORE_DANDA_FEE_CUTOFF)], updatedAt: "2026-07-20T00:00:00.000Z" }))).toBe(-12000);
      // Evidencia en el corte, aunque updatedAt sea anterior.
      expect(fee(danda({ evidence: [deliveryEvidence(DANDA_FEE_CUTOFF)], updatedAt: "2026-07-01T00:00:00.000Z" }))).toBe(-13500);
      // Con varias evidencias de entrega manda la ULTIMA.
      expect(fee(danda({ evidence: [deliveryEvidence(BEFORE_DANDA_FEE_CUTOFF), deliveryEvidence(DANDA_FEE_CUTOFF)] }))).toBe(-13500);
    });

    it("RNF_01 · sin evidencia de entrega, la app usa updatedAt (app)", () => {
      const fee = (order: Order) => app(order).find((entry) => entry.id === "we-ord-t1-seller-delivery-fee")?.amountCop;
      expect(fee(danda({ updatedAt: DANDA_FEE_CUTOFF }))).toBe(-13500);
      expect(fee(danda({ updatedAt: BEFORE_DANDA_FEE_CUTOFF }))).toBe(-12000);
    });

    it("RNF_01 · entregado completo en la app: recaudo, flete por evidencia y pago 11.000 (app)", () => {
      const order = danda({ driverId: DANDA_DRIVER_ID, pickedUpAt: DANDA_PAY_CUTOFF, evidence: [deliveryEvidence(DANDA_FEE_CUTOFF)] });
      expect(app(order)).toEqual(
        sorted([cod(85000, DANDA_SELLER_ID), deliveryFee(-13500, DANDA_SELLER_ID), deliveredPay(11000, DANDA_DRIVER_ID)])
      );
    });

    it("RNF_01 · fallido cobrable de DANDA: ningun cobro ni pago, aunque sea el transportista preferido (servidor y app)", () => {
      const order = failedOrder("failed_visit", { sellerId: DANDA_SELLER_ID, driverId: DANDA_DRIVER_ID, pickedUpAt: DANDA_PAY_CUTOFF });
      expect(server(order)).toEqual([]);
      expect(app(order)).toEqual([]);
    });

    it("RNF_01 · fallido cobrable de DANDA desde bodega: solo el manejo -2.000 (servidor y app)", () => {
      const order = failedOrder("failed_visit", { sellerId: DANDA_SELLER_ID, fulfillmentMode: "warehouse" });
      const expected = [fulfillment(-2000, DANDA_SELLER_ID)];
      expect(server(order)).toEqual(expected);
      expect(app(order)).toEqual(expected);
    });
  });

  describe("paridad servidor/app hoy, pedidos SIN comunidad", () => {
    // Mismo pedido, mismos ajustes, sin `communityPricing`: los dos lados producen los mismos
    // asientos, centavo a centavo. En DANDA entregado, `now` del servidor = evidencia de la app.
    // La paridad se afirma SOLO sin comunidad a proposito: la app ignora `communityPricing` y solo
    // escribe dinero en modo local (con Firebase el dinero lo escribe el cierre del servidor), asi
    // que fuera de este caso no hay dos calculos que comparar.
    const cases: Array<[string, Order, string]> = [
      ["entregado COD sin zona", makeOrder(), CLOSED_AT],
      ["entregado COD con zona", makeOrder({ zoneId: ZONE.id }), CLOSED_AT],
      ["fallido cobrable sin zona", failedOrder("failed_visit"), CLOSED_AT],
      ["fallido cobrable con zona", failedOrder("failed_visit", { zoneId: ZONE.id }), CLOSED_AT],
      ["fallido con categoria ausente", failedOrder(undefined), CLOSED_AT],
      ["entregado desde bodega", makeOrder({ fulfillmentMode: "warehouse" }), CLOSED_AT],
      ["fallido desde bodega con zona", failedOrder("failed_visit", { fulfillmentMode: "warehouse", zoneId: ZONE.id }), CLOSED_AT],
      [
        "DANDA entregado tras el corte",
        makeOrder({ sellerId: DANDA_SELLER_ID, driverId: DANDA_DRIVER_ID, pickedUpAt: DANDA_PAY_CUTOFF, evidence: [deliveryEvidence(DANDA_FEE_CUTOFF)] }),
        DANDA_FEE_CUTOFF
      ],
      [
        "DANDA entregado antes del corte",
        makeOrder({ sellerId: DANDA_SELLER_ID, evidence: [deliveryEvidence(BEFORE_DANDA_FEE_CUTOFF)] }),
        BEFORE_DANDA_FEE_CUTOFF
      ]
    ];

    it.each(cases)("RNF_01 · %s: servidor y app generan los mismos asientos", (_label, order, now) => {
      const fromServer = server(order, now);
      expect(fromServer.length).toBeGreaterThan(0);
      expect(app(order)).toEqual(fromServer);
    });

    it("RNF_01 · fallido NO cobrable: los dos lados vacios", () => {
      const order = failedOrder("no_coverage");
      expect(server(order)).toEqual([]);
      expect(app(order)).toEqual([]);
    });
  });
});

describe("RNF_01 · ajuste ausente o en 0: la app se alinea con el servidor (T3, a proposito)", () => {
  /*
   * CAMBIO DELIBERADO DE T3. Hasta T2 este era el UNICO caso donde servidor y app diferian: la
   * app resolvia cada tarifa con `zone?.x || settings.x`, asi que un ajuste en 0 sin zona cobraba
   * 0, y uno AUSENTE llegaba como `-undefined` = NaN. El servidor (`resolveTariffs`) ignora el 0 y
   * el ausente y cae a `defaultSettings`. T3 hace que la app use el mismo `resolveTariffs`, asi
   * que aqui cambian SOLO las expectativas de la app (antes: flete 0, manejo 0, pago 0); las del
   * servidor no se tocan.
   *
   * No es un cobro real que cambie: solo afecta al modo local (con Firebase la app no escribe
   * dinero, lo escribe `closeOrder` en el servidor) y en produccion los ajustes estan completos
   * (plan 004 §0), asi que ningun asiento guardado cambia de importe.
   */
  const noZoneSettingsWithZero = (field: keyof typeof SETTINGS) => ({ ...SETTINGS, [field]: 0 });

  it("RNF_01 · flete entregado en 0 sin zona: servidor cobra -12.000 (defecto)", () => {
    expect(server(makeOrder(), CLOSED_AT, noZoneSettingsWithZero("sellerDeliveredFeeCop"))).toEqual(
      sorted([cod(), deliveryFee(-12000), deliveredPay(9000)])
    );
  });

  it("RNF_01 · flete entregado AUSENTE sin zona: servidor cobra -12.000 (defecto)", () => {
    const { sellerDeliveredFeeCop: _omitted, ...withoutDeliveredFee } = SETTINGS;
    expect(server(makeOrder(), CLOSED_AT, withoutDeliveredFee)).toEqual(sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]));
  });

  it("RNF_01 · flete entregado en 0 sin zona: la app cobra -12.000 como el servidor (antes 0)", () => {
    expect(app(makeOrder(), { sellerDeliveredFeeCop: 0 })).toEqual(sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]));
  });

  it("RNF_01 · flete entregado AUSENTE sin zona: la app cobra -12.000 como el servidor (antes NaN)", () => {
    // `Partial<settings>` admite `undefined` (el repo no usa exactOptionalPropertyTypes), asi que
    // no hace falta cast: el spread de `appState` deja el campo en undefined, que es "ausente".
    expect(app(makeOrder(), { sellerDeliveredFeeCop: undefined })).toEqual(sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]));
  });

  it("RNF_01 · sellerDeliveredFeeForOrder con flete en 0 sin zona: 12.000 como el servidor (antes 0)", () => {
    expect(sellerDeliveredFeeForOrder(makeOrder(), appState({ sellerDeliveredFeeCop: 0 }))).toBe(12000);
  });

  it("RNF_01 · manejo de bodega en 0 sin zona: servidor y app -2.000 (antes la app 0)", () => {
    const order = makeOrder({ fulfillmentMode: "warehouse" });
    const expected = sorted([cod(), deliveryFee(-12000), deliveredPay(9000), fulfillment(-2000)]);
    expect(server(order, CLOSED_AT, noZoneSettingsWithZero("fulfillmentFeeCop"))).toEqual(expected);
    expect(app(order, { fulfillmentFeeCop: 0 })).toEqual(expected);
  });

  it("RNF_01 · pago de entregado en 0 sin zona: servidor y app 9.000 del defecto (antes la app 0)", () => {
    const expected = sorted([cod(), deliveryFee(-12000), deliveredPay(9000)]);
    expect(server(makeOrder(), CLOSED_AT, noZoneSettingsWithZero("driverDeliveredPayCop"))).toEqual(expected);
    expect(app(makeOrder(), { driverDeliveredPayCop: 0 })).toEqual(expected);
  });

  it("RNF_01 · con zona completa el 0 del ajuste no importa: los dos lados cobran la zona", () => {
    const order = makeOrder({ zoneId: ZONE.id });
    const expected = sorted([cod(), deliveryFee(-14000), deliveredPay(9500)]);
    expect(server(order, CLOSED_AT, noZoneSettingsWithZero("sellerDeliveredFeeCop"))).toEqual(expected);
    expect(app(order, { sellerDeliveredFeeCop: 0 })).toEqual(expected);
  });
});

/**
 * T2 · RF_01, RF_02, RNF_03 — `functions/src/seller-charges.ts`, la UNICA copia de "cuanto cobra
 * Kentro a una tienda por un pedido".
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO QUE ESTE BLOQUE FIJA (plan 004 §2, §3.1, §3.2):
 *
 *   export const defaultSettings, tariffFields            // movidos de wallet-entries.ts, mismos valores
 *   export type Tariffs = Record<TariffField, number>;
 *   export type SellerChargeOrder = { sellerId?: string; driverId?: string | null; pickedUpAt?: string };
 *   export const SELLER_FAILED_FEE_FIXED_COP = 12000;
 *   export function resolveTariffs(settings, zone?): Tariffs;              // zona >0 > ajuste >0 > defecto
 *   export function dandaDeliveredFeeCop(deliveredAtIso: string): number;  // 12.000 / 13.500
 *   export function resolveSellerCharges(order, tariffs, deliveredAtIso): Tariffs;
 *   export function communityBase(tariffs): { sellerDeliveredFeeCop; sellerFailedFeeCop; fulfillmentFeeCop };
 *
 * `wallet-entries.ts` REEXPORTA lo movido (el mismo objeto funcion, no una copia) y deja de
 * definir el fijo del fallido y el conjunto DANDA.
 *
 * ---------------------------------------------------------------------------------------------
 * POR QUE LA CARGA ES DIFERIDA: en fase RED el modulo no existe. Con un `import` estatico el
 * archivo entero no se recoge y caeria tambien el bloque T1, que es la red de RNF_01. Con
 * `await import` dentro de cada `it()` cada caso falla por separado y T1 sigue en verde.
 */
type SellerChargesModule = typeof import("../../functions/src/seller-charges");
type WalletEntriesModule = typeof import("../../functions/src/wallet-entries");
const loadSellerCharges = async (): Promise<SellerChargesModule> => import("../../functions/src/seller-charges");
const loadWalletEntries = async (): Promise<WalletEntriesModule> => import("../../functions/src/wallet-entries");

/** Fuente de un archivo de functions/src, SIN comentarios: la guarda mira codigo, no prosa. */
function sourceWithoutComments(relativeToFunctionsSrc: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../functions/src/${relativeToFunctionsSrc}`, import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("T2 · RF_01, RF_02, RNF_03: seller-charges.ts, la unica copia del cobro a la tienda", () => {
  // Tarifas ya resueltas, TODAS distintas entre si, para que un campo tomado de donde no toca se note.
  const TARIFFS = {
    sellerDeliveredFeeCop: 14000,
    sellerFailedFeeCop: 9000,
    fulfillmentFeeCop: 2500,
    driverDeliveredPayCop: 9500,
    driverFailedPayCop: 8500
  };

  // Datos de PRODUCCION medidos el 2026-09-11 (plan 004 §0): `settings/global` y las tres zonas.
  const PROD_SETTINGS = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 9000,
    fulfillmentFeeCop: 2000,
    driverDeliveredPayCop: 8000,
    driverFailedPayCop: 8000
  };
  const PROD_ZONE = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 12000,
    fulfillmentFeeCop: 2500,
    driverDeliveredPayCop: 8000,
    driverFailedPayCop: 8000
  };

  describe("contrato movido desde wallet-entries.ts", () => {
    it("RF_02 · defaultSettings conserva los valores de hoy", async () => {
      const { defaultSettings } = await loadSellerCharges();
      expect(defaultSettings).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 12000,
        fulfillmentFeeCop: 2000,
        driverDeliveredPayCop: 9000,
        driverFailedPayCop: 9000
      });
    });

    it("RF_02 · tariffFields conserva los cinco campos, en el mismo orden", async () => {
      const { tariffFields } = await loadSellerCharges();
      expect([...tariffFields]).toEqual([
        "sellerDeliveredFeeCop",
        "sellerFailedFeeCop",
        "fulfillmentFeeCop",
        "driverDeliveredPayCop",
        "driverFailedPayCop"
      ]);
    });

    it("RF_01 · SELLER_FAILED_FEE_FIXED_COP es 12.000", async () => {
      const { SELLER_FAILED_FEE_FIXED_COP } = await loadSellerCharges();
      expect(SELLER_FAILED_FEE_FIXED_COP).toBe(12000);
    });

    it("RF_02 · resolveTariffs se comporta igual que hoy: zona > ajuste > defecto", async () => {
      const { resolveTariffs } = await loadSellerCharges();
      expect(resolveTariffs(PROD_SETTINGS, { fulfillmentFeeCop: 2500, sellerDeliveredFeeCop: 0 })).toEqual({
        sellerDeliveredFeeCop: 12000, // zona 0 -> ajuste
        sellerFailedFeeCop: 9000, // la base cruda; el fijo NO vive aqui sino en resolveSellerCharges
        fulfillmentFeeCop: 2500, // zona > 0 gana
        driverDeliveredPayCop: 8000,
        driverFailedPayCop: 8000
      });
      expect(resolveTariffs({}, undefined)).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 12000,
        fulfillmentFeeCop: 2000,
        driverDeliveredPayCop: 9000,
        driverFailedPayCop: 9000
      });
    });

    it("RF_02 · dandaDeliveredFeeCop: 12.000 antes del 2026-07-17T05:00Z, 13.500 desde", async () => {
      const { dandaDeliveredFeeCop: fee } = await loadSellerCharges();
      expect(fee(BEFORE_DANDA_FEE_CUTOFF)).toBe(12000);
      expect(fee(DANDA_FEE_CUTOFF)).toBe(13500);
      expect(fee("no-es-fecha")).toBe(12000);
    });
  });

  describe("resolveSellerCharges: tienda normal", () => {
    it("RF_01 · devuelve las tarifas con el fallido fijo en 12.000 aunque la tarifa diga 9.000", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      expect(resolveSellerCharges({ sellerId: "seller-normal", driverId: "driver-t1" }, TARIFFS, CLOSED_AT)).toEqual({
        ...TARIFFS,
        sellerFailedFeeCop: 12000
      });
    });

    it("RF_01 · el fallido sigue en 12.000 aunque la tarifa lo traiga en 0", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      expect(resolveSellerCharges({ sellerId: "seller-normal" }, { ...TARIFFS, sellerFailedFeeCop: 0 }, CLOSED_AT)).toEqual({
        ...TARIFFS,
        sellerFailedFeeCop: 12000
      });
    });

    it("RF_01 · la fecha, el transportista y la recogida no mueven el cobro de una tienda normal", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      const expected = { ...TARIFFS, sellerFailedFeeCop: 12000 };
      expect(resolveSellerCharges({ sellerId: "seller-normal" }, TARIFFS, BEFORE_DANDA_FEE_CUTOFF)).toEqual(expected);
      expect(resolveSellerCharges({ sellerId: "seller-normal" }, TARIFFS, "")).toEqual(expected);
      expect(
        resolveSellerCharges({ sellerId: "seller-normal", driverId: DANDA_DRIVER_ID, pickedUpAt: DANDA_PAY_CUTOFF }, TARIFFS, CLOSED_AT)
      ).toEqual(expected);
      expect(resolveSellerCharges({ driverId: null }, TARIFFS, CLOSED_AT)).toEqual(expected);
    });

    it("RF_01 · no muta las tarifas que recibe", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      const tariffs = { ...TARIFFS };
      resolveSellerCharges({ sellerId: "seller-normal" }, tariffs, CLOSED_AT);
      expect(tariffs).toEqual(TARIFFS);
    });
  });

  describe("resolveSellerCharges: DANDA", () => {
    it("RF_01 · DANDA antes del corte del 17-jul: flete 12.000, fallido 0, pago 10.000, pago fallido 0; manejo de la tarifa", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      expect(resolveSellerCharges({ sellerId: DANDA_SELLER_ID, driverId: "driver-otro" }, TARIFFS, BEFORE_DANDA_FEE_CUTOFF)).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 0,
        fulfillmentFeeCop: 2500,
        driverDeliveredPayCop: 10000,
        driverFailedPayCop: 0
      });
    });

    it("RF_01 · DANDA desde el corte del 17-jul: flete 13.500", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      expect(resolveSellerCharges({ sellerId: DANDA_SELLER_ID }, TARIFFS, DANDA_FEE_CUTOFF).sellerDeliveredFeeCop).toBe(13500);
    });

    it("RF_01 · DANDA paga 11.000 con el transportista preferido y recogida desde el 2026-06-09T05:00Z", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      expect(
        resolveSellerCharges({ sellerId: DANDA_SELLER_ID, driverId: DANDA_DRIVER_ID, pickedUpAt: DANDA_PAY_CUTOFF }, TARIFFS, DANDA_FEE_CUTOFF)
      ).toEqual({
        sellerDeliveredFeeCop: 13500,
        sellerFailedFeeCop: 0,
        fulfillmentFeeCop: 2500,
        driverDeliveredPayCop: 11000,
        driverFailedPayCop: 0
      });
    });

    it("RF_01 · DANDA paga 10.000 si falta una condicion: recogida anterior, sin recogida, otro transportista o sin transportista", async () => {
      const { resolveSellerCharges } = await loadSellerCharges();
      const pay = (order: { driverId?: string | null; pickedUpAt?: string }) =>
        resolveSellerCharges({ sellerId: DANDA_SELLER_ID, ...order }, TARIFFS, CLOSED_AT).driverDeliveredPayCop;
      expect(pay({ driverId: DANDA_DRIVER_ID, pickedUpAt: BEFORE_DANDA_PAY_CUTOFF })).toBe(10000);
      expect(pay({ driverId: DANDA_DRIVER_ID })).toBe(10000);
      expect(pay({ driverId: DANDA_DRIVER_ID, pickedUpAt: "no-es-fecha" })).toBe(10000);
      expect(pay({ driverId: "driver-otro", pickedUpAt: DANDA_PAY_CUTOFF })).toBe(10000);
      expect(pay({ driverId: null, pickedUpAt: DANDA_PAY_CUTOFF })).toBe(10000);
    });
  });

  describe("communityBase: la base de una comunidad", () => {
    it("RF_01 · ajustes de produccion SIN zona: 12.000 / 12.000 / 2.000 (el fallido NO es el 9.000 del ajuste)", async () => {
      const { communityBase, resolveTariffs } = await loadSellerCharges();
      expect(communityBase(resolveTariffs(PROD_SETTINGS))).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 12000,
        fulfillmentFeeCop: 2000
      });
    });

    it("RF_01 · ajustes de produccion CON la zona de produccion: 12.000 / 12.000 / 2.500", async () => {
      const { communityBase, resolveTariffs } = await loadSellerCharges();
      expect(communityBase(resolveTariffs(PROD_SETTINGS, PROD_ZONE))).toEqual({
        sellerDeliveredFeeCop: 12000,
        sellerFailedFeeCop: 12000,
        fulfillmentFeeCop: 2500
      });
    });

    it("RF_01 · solo los tres conceptos de la tienda: ningun pago al transportista", async () => {
      const { communityBase } = await loadSellerCharges();
      expect(Object.keys(communityBase(TARIFFS)).sort()).toEqual(["fulfillmentFeeCop", "sellerDeliveredFeeCop", "sellerFailedFeeCop"]);
    });

    // Tarifas variadas: fallido por encima, por debajo y en 0; manejo alto; todas distintas.
    const tariffCases: Array<[string, typeof TARIFFS]> = [
      ["tarifas de caracterizacion", TARIFFS],
      ["fallido por encima del fijo", { ...TARIFFS, sellerFailedFeeCop: 15000 }],
      ["fallido en 0", { ...TARIFFS, sellerFailedFeeCop: 0 }],
      ["manejo y flete altos", { ...TARIFFS, sellerDeliveredFeeCop: 18000, fulfillmentFeeCop: 4000 }],
      ["produccion sin zona", { ...PROD_SETTINGS }]
    ];

    it.each(tariffCases)("RF_02 · %s: communityBase == cobro de resolveSellerCharges a una tienda normal", async (_label, tariffs) => {
      const { communityBase, resolveSellerCharges } = await loadSellerCharges();
      for (const deliveredAt of ["", BEFORE_DANDA_FEE_CUTOFF, DANDA_FEE_CUTOFF, CLOSED_AT]) {
        const charges = resolveSellerCharges({ sellerId: "" }, tariffs, deliveredAt);
        expect(communityBase(tariffs)).toEqual({
          sellerDeliveredFeeCop: charges.sellerDeliveredFeeCop,
          sellerFailedFeeCop: charges.sellerFailedFeeCop,
          fulfillmentFeeCop: charges.fulfillmentFeeCop
        });
      }
    });
  });

  describe("una sola copia: wallet-entries reexporta, no copia", () => {
    it("RF_02 · resolveTariffs de wallet-entries ES la de seller-charges (mismo objeto funcion)", async () => {
      const [sellerCharges, walletEntries] = await Promise.all([loadSellerCharges(), loadWalletEntries()]);
      expect(walletEntries.resolveTariffs).toBe(sellerCharges.resolveTariffs);
    });

    it("RF_02 · dandaDeliveredFeeCop de wallet-entries ES la de seller-charges", async () => {
      const [sellerCharges, walletEntries] = await Promise.all([loadSellerCharges(), loadWalletEntries()]);
      expect(walletEntries.dandaDeliveredFeeCop).toBe(sellerCharges.dandaDeliveredFeeCop);
    });

    it("RF_02 · defaultSettings de wallet-entries ES el de seller-charges", async () => {
      const [sellerCharges, walletEntries] = await Promise.all([loadSellerCharges(), loadWalletEntries()]);
      expect(walletEntries.defaultSettings).toBe(sellerCharges.defaultSettings);
    });

    it("RF_02 · tariffFields de wallet-entries ES el de seller-charges", async () => {
      const [sellerCharges, walletEntries] = await Promise.all([loadSellerCharges(), loadWalletEntries()]);
      expect(walletEntries.tariffFields).toBe(sellerCharges.tariffFields);
    });
  });

  describe("guardas de fuente", () => {
    it("RNF_03 · seller-charges.ts es puro: ninguna sentencia import, export-from ni require (lo importa tambien la app)", () => {
      const source = sourceWithoutComments("seller-charges.ts");
      expect(source).not.toMatch(/^\s*import[\s{*"']/m);
      expect(source).not.toMatch(/\bimport\s*\(/);
      expect(source).not.toMatch(/\bexport\s[^;]*\bfrom\s*["']/);
      expect(source).not.toMatch(/\brequire\s*\(/);
    });

    it("RF_02 · wallet-entries.ts ya no define el fallido fijo `sellerFailedFeeCop: 12000`", () => {
      expect(sourceWithoutComments("wallet-entries.ts")).not.toMatch(/sellerFailedFeeCop\s*:\s*12000\b/);
    });

    it("RF_02 · wallet-entries.ts ya no define el conjunto DANDA (dandaSellerIds ni el id de la tienda)", () => {
      const source = sourceWithoutComments("wallet-entries.ts");
      expect(source).not.toMatch(/\bdandaSellerIds\b/);
      expect(source).not.toContain(`"${DANDA_SELLER_ID}"`);
    });

    it("RF_02 · wallet-entries.ts importa de ./seller-charges", () => {
      expect(sourceWithoutComments("wallet-entries.ts")).toMatch(/\bfrom\s*["']\.\/seller-charges["']/);
    });
  });
});

/**
 * T3 · RF_02 — La app deja de tener su copia del cobro a la tienda.
 *
 * `src/lib/finance.ts` tenia su propia `applySellerTariffOverrides` con el fijo del fallido y las
 * constantes DANDA. T3 la borra y hace que `entriesForClosedOrder` / `sellerDeliveredFeeForOrder`
 * usen `resolveTariffs` + `resolveSellerCharges` de `functions/src/seller-charges`.
 *
 * LISTA CERRADA a proposito: la guarda recorre SOLO los archivos que calculan dinero de un cierre.
 * NO incluye `src/lib/seed.ts` (datos de demostracion, no regla), `src/components/operations-app.tsx`
 * ni los `scripts/correct-*.js` historicos, que usan el id de DANDA para otra cosa.
 * T6 la amplia a `functions/src/community-order-pricing.ts` (el sello del pedido de comunidad), que
 * tenia su propio `SELLERS_WITH_HARDCODED_TARIFFS` con el id de DANDA escrito a mano.
 */
const SINGLE_COPY_GUARDED_FILES = [
  "src/lib/finance.ts",
  "functions/src/wallet-entries.ts",
  "functions/src/community-order-pricing.ts"
] as const;

/** Fuente de un archivo relativo a la raiz del repo, SIN comentarios: la guarda mira codigo, no prosa. */
function repoSourceWithoutComments(relativeToRepo: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../${relativeToRepo}`, import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Nombres de valor (no `type`) importados por `import { ... } from "<specifier>"`. */
function namedValueImports(source: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`\\bimport\\s+(?!type\\b)\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`, "g");
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    for (const specifierPart of match[1].split(",")) {
      const part = specifierPart.trim();
      if (!part || part.startsWith("type ")) continue;
      names.push(part.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

describe("T3 · RF_02: la app usa la misma regla que el servidor", () => {
  describe.each(SINGLE_COPY_GUARDED_FILES)("guarda de una sola copia: %s", (file) => {
    it("RF_02 · no define el fallido fijo `sellerFailedFeeCop: 12000`", () => {
      expect(repoSourceWithoutComments(file)).not.toMatch(/sellerFailedFeeCop\s*:\s*12000\b/);
    });

    it("RF_02 · no contiene el id de la tienda DANDA", () => {
      expect(repoSourceWithoutComments(file)).not.toContain(`"${DANDA_SELLER_ID}"`);
    });

    it("RF_02 · no contiene el id del transportista preferido de DANDA", () => {
      expect(repoSourceWithoutComments(file)).not.toContain(`"${DANDA_DRIVER_ID}"`);
    });

    it("RF_02 · no contiene las fechas de corte de DANDA", () => {
      const source = repoSourceWithoutComments(file);
      expect(source).not.toContain(DANDA_PAY_CUTOFF);
      expect(source).not.toContain(DANDA_FEE_CUTOFF);
    });

    it("RF_02 · no define una funcion `applySellerTariffOverrides`", () => {
      expect(repoSourceWithoutComments(file)).not.toMatch(/\bapplySellerTariffOverrides\b/);
    });
  });

  it("RF_02 · finance.ts importa resolveSellerCharges y resolveTariffs de ../../functions/src/seller-charges", () => {
    const imported = namedValueImports(repoSourceWithoutComments("src/lib/finance.ts"), "../../functions/src/seller-charges");
    expect(imported).toEqual(expect.arrayContaining(["resolveSellerCharges", "resolveTariffs"]));
  });
});

/**
 * T6 · RF_02, RF_03, RF_10 — Las tres entradas de comunidad usan la base REAL.
 *
 * Tres sitios leian la base de una comunidad por su cuenta, sin el fallido fijo:
 *  - `scheduleCommunityPrice` (communities.ts): el minimo del lider era el ajuste crudo
 *    `Number(settingsSnap.data()?.[field])` (fallido 9.000 en produccion).
 *  - `getMyStoreTariff` (communities.ts): "Tu tarifa" partia de `resolveTariffs` sin el fijo.
 *  - el sello del pedido (community-order-pricing.ts): `resolveTariffs(settings, zone)` y su propio
 *    conjunto de tiendas con tarifa especial.
 * Las tres pasan por `communityBase` y el conjunto sale de `./seller-charges`.
 *
 * Guardas de FUENTE (sin comentarios): esas callables leen Firestore y no son probables en unidad
 * desde la raiz. La funcion pura del minimo se prueba en `community-pricing.test.ts` (T6).
 */

/** Cuerpo de `export const <name> = ...` hasta la siguiente declaracion exportada de primer nivel. */
function exportedBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\bexport\\s+(?:const|function|async\\s+function)\\s+${name}\\b`));
  if (start < 0) throw new Error(`No se encuentra la exportacion ${name}.`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^export\s/m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/**
 * Primeros argumentos de cada llamada a `callee(` en `body`: el texto hasta la primera coma al
 * nivel 0 de parentesis.
 */
function firstArguments(body: string, callee: string): string[] {
  const args: string[] = [];
  const pattern = new RegExp(`\\b${callee}\\s*\\(`, "g");
  for (const match of body.matchAll(pattern)) {
    let depth = 0;
    let i = (match.index ?? 0) + match[0].length;
    let arg = "";
    for (; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth -= 1;
      }
      if (ch === "," && depth === 0) break;
      arg += ch;
    }
    args.push(arg.trim());
  }
  return args;
}

/** El argumento es `communityBase(...)` en linea, o un identificador asignado desde `communityBase(`. */
function comesFromCommunityBase(body: string, arg: string): boolean {
  if (/^communityBase\s*\(/.test(arg)) return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return false;
  return new RegExp(`\\b(?:const|let)\\s+${arg}\\s*(?::[^=]+)?=\\s*communityBase\\s*\\(`).test(body);
}

/** Lectura cruda de un concepto del ajuste: `settings[field]`, `settingsSnap.data()?.[field]`, ... */
const RAW_SETTINGS_FIELD_READ = /\bsettings\w*(?:\.data\(\))?\s*(?:\?\.)?\s*\[\s*field\s*\]/;

describe("T6 · RF_02, RF_03, RF_10: las tres entradas usan la base real", () => {
  describe("communities.ts: scheduleCommunityPrice (RF_05 via RF_02)", () => {
    it("RF_02 · communities.ts importa communityBase de ./seller-charges", () => {
      expect(namedValueImports(sourceWithoutComments("communities.ts"), "./seller-charges")).toContain("communityBase");
    });

    it("RF_02 · communities.ts importa validateCommunityPriceFloor de ./community-pricing", () => {
      expect(namedValueImports(sourceWithoutComments("communities.ts"), "./community-pricing")).toContain(
        "validateCommunityPriceFloor"
      );
    });

    it("RF_02 · scheduleCommunityPrice llama a communityBase( y a validateCommunityPriceFloor(", () => {
      const body = exportedBody(sourceWithoutComments("communities.ts"), "scheduleCommunityPrice");
      expect(body).toMatch(/\bcommunityBase\s*\(/);
      expect(body).toMatch(/\bvalidateCommunityPriceFloor\s*\(/);
    });

    it("RF_02 · scheduleCommunityPrice rechaza con el `reason` de la funcion pura, no con un mensaje propio", () => {
      const body = exportedBody(sourceWithoutComments("communities.ts"), "scheduleCommunityPrice");
      expect(body).toMatch(/\.reason\b/);
      expect(body).not.toContain("El minimo para este concepto es ${floor}.");
    });

    it("RF_02 · communities.ts NO lee el ajuste crudo `Number(settingsSnap.data()?.[field])`", () => {
      expect(sourceWithoutComments("communities.ts")).not.toContain("Number(settingsSnap.data()?.[field])");
    });

    it("RF_02 · communities.ts NO usa ninguna lectura cruda `settings...[field]` como minimo", () => {
      expect(sourceWithoutComments("communities.ts")).not.toMatch(RAW_SETTINGS_FIELD_READ);
    });
  });

  describe("communities.ts: getMyStoreTariff (RF_10)", () => {
    it("RF_10 · getMyStoreTariff llama a communityBase(", () => {
      const body = exportedBody(sourceWithoutComments("communities.ts"), "getMyStoreTariff");
      expect(body).toMatch(/\bcommunityBase\s*\(/);
    });

    it("RF_10 · toda llamada a buildStoreTariffView recibe como base el resultado de communityBase(", () => {
      const body = exportedBody(sourceWithoutComments("communities.ts"), "getMyStoreTariff");
      const bases = firstArguments(body, "buildStoreTariffView");
      expect(bases.length).toBeGreaterThan(0);
      for (const base of bases) {
        expect(comesFromCommunityBase(body, base), `buildStoreTariffView(${base}, ...)`).toBe(true);
      }
    });
  });

  describe("community-order-pricing.ts: el sello del pedido (RF_03)", () => {
    it("RF_03 · community-order-pricing.ts importa communityBase de ./seller-charges", () => {
      expect(namedValueImports(sourceWithoutComments("community-order-pricing.ts"), "./seller-charges")).toContain(
        "communityBase"
      );
    });

    it("RF_03 · toda llamada a freezeOrderPricing recibe como base el resultado de communityBase(", () => {
      const body = sourceWithoutComments("community-order-pricing.ts");
      const bases = firstArguments(body, "freezeOrderPricing");
      expect(bases.length).toBeGreaterThan(0);
      for (const base of bases) {
        expect(comesFromCommunityBase(body, base), `freezeOrderPricing(${base}, ...)`).toBe(true);
      }
    });

    it("RF_02 · community-order-pricing.ts NO define su propio conjunto de tiendas con tarifa especial", () => {
      const source = sourceWithoutComments("community-order-pricing.ts");
      expect(source).not.toMatch(/\bSELLERS_WITH_HARDCODED_TARIFFS\s*=\s*new\s+Set\b/);
      expect(source).not.toContain(`"${DANDA_SELLER_ID}"`);
    });

    /*
     * REEMPLAZADA POR T13. Antes exigia que el sello consultara `<X>.has(sellerId)` con un conjunto
     * importado de ./seller-charges. T13 muda la decision ENTERA —conjunto y rechazo— a
     * `assertSellerCanJoinCommunity` en ./seller-charges, asi que ya no queda ningun `.has(sellerId)`
     * en el sello y la guarda vieja fallaba por su propio `expect(consulted.length).toBeGreaterThan(0)`.
     *
     * La nueva afirma lo equivalente con el diseno actual (el sello importa esa funcion de
     * ./seller-charges y la llama SOBRE sellerId, que es donde vive ahora la decision) y CONSERVA la
     * exigencia vieja: si volviera a aparecer un `<X>.has(sellerId)`, X tendria que venir tambien de
     * ./seller-charges. Nada se debilita. Lo que la auditoria encontro insuficiente —que el rechazo
     * se degradara a `return {}` sin poner nada en rojo— no lo cubre esta guarda de fuente sino las
     * pruebas de COMPORTAMIENTO del bloque T13, mas sus guardas contra el retorno silencioso.
     */
    it("RF_02 · la decision sobre la tienda con tarifa especial se importa de ./seller-charges", () => {
      const source = sourceWithoutComments("community-order-pricing.ts");
      const imported = namedValueImports(source, "./seller-charges");
      expect(imported).toContain("assertSellerCanJoinCommunity");
      expect(firstArguments(source, "assertSellerCanJoinCommunity")).toContain("sellerId");
      const consulted = [...source.matchAll(/\b([A-Za-z_$][\w$]*)\.has\(\s*sellerId\s*\)/g)].map((m) => m[1]);
      for (const name of consulted) {
        expect(imported, `${name}.has(sellerId)`).toContain(name);
      }
    });
  });
});

/**
 * T11 · RF_11, RNF_01 — Guion del smoke en produccion (DoD 5).
 *
 * El guion NO se ejecuta en la suite: `count` corre antes de desplegar y el resto tras el despliegue
 * firmado por el humano. Por eso sus pruebas son GUARDAS DE FUENTE sobre `scripts/smoke-004.js`
 * (sin comentarios).
 *
 * CONTRATO que fijan estas guardas para localizar cada paso: cada uno se implementa en una funcion
 * con nombre `<paso>`, `step<Paso>`, `run<Paso>`, `cmd<Paso>` o `<paso>Step` (declaracion `function`
 * o `const x = async (...) => { ... }`). Las guardas siguen las llamadas a funciones LOCALES del
 * archivo, asi que el paso puede delegar en ayudantes: lo que cuenta es lo que alcanza. En `count`
 * y `close`, evitar `new Map().set(` (la guarda de solo lectura no distingue un Map de Firestore).
 */
const SMOKE_SCRIPT = "scripts/smoke-004.js";
const SMOKE_STEPS = ["count", "create", "close", "check", "cleanup", "compare"] as const;
const SMOKE_STORE_ID = "seller-1789149795537";

type LocalFunctions = Map<string, string>;

/** Posicion del cierre que empareja la apertura en `openIndex` (`(`/`)` o `{`/`}`). */
function matchingClose(source: string, openIndex: number): number {
  const open = source[openIndex];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Apertura "${open}" sin cerrar en la posicion ${openIndex}.`);
}

/** Funciones con nombre del archivo: `function x(` y `const x = (async) (...) => {` / `function`. */
function localFunctions(source: string): LocalFunctions {
  const functions: LocalFunctions = new Map();
  const bodyAt = (braceIndex: number): string => source.slice(braceIndex, matchingClose(source, braceIndex) + 1);
  for (const match of source.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paramsEnd = matchingClose(source, (match.index ?? 0) + match[0].length - 1);
    const brace = source.indexOf("{", paramsEnd);
    if (brace >= 0) functions.set(match[1], bodyAt(brace));
  }
  for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    const paramsEnd = matchingClose(source, (match.index ?? 0) + match[0].length - 1);
    const arrow = source.slice(paramsEnd + 1).match(/^\s*=>\s*\{/);
    if (arrow) functions.set(match[1], bodyAt(paramsEnd + arrow[0].length));
  }
  return functions;
}

function callPattern(name: string): RegExp {
  return new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`);
}

/** Nombres de funciones locales llamadas en `text`. */
function localCallees(text: string, functions: LocalFunctions): string[] {
  return [...functions.keys()].filter((name) => callPattern(name).test(text));
}

/** `text` mas el cuerpo de toda funcion local que alcanza, transitivamente. */
function reachable(text: string, functions: LocalFunctions, visited: Set<string> = new Set()): string {
  let out = text;
  for (const name of localCallees(text, functions)) {
    if (visited.has(name)) continue;
    visited.add(name);
    out += `\n${reachable(functions.get(name) ?? "", functions, visited)}`;
  }
  return out;
}

/**
 * Primera posicion de `body` donde se alcanza `pattern`: la aparicion directa o la llamada a una
 * funcion local que lo alcanza. -1 si no se alcanza.
 */
function firstReach(body: string, pattern: RegExp, functions: LocalFunctions, self: string): number {
  const positions: number[] = [];
  const direct = body.search(pattern);
  if (direct >= 0) positions.push(direct);
  for (const name of localCallees(body, functions)) {
    if (name === self) continue;
    if (pattern.test(reachable(functions.get(name) ?? "", functions, new Set([self, name])))) {
      positions.push(body.search(callPattern(name)));
    }
  }
  return positions.length ? Math.min(...positions) : -1;
}

function smokeScript(): { source: string; functions: LocalFunctions } {
  const source = repoSourceWithoutComments(SMOKE_SCRIPT);
  return { source, functions: localFunctions(source) };
}

/** Nombre y cuerpo de la funcion que implementa `step` (ver el contrato arriba). */
function smokeStep(step: string, functions: LocalFunctions): { name: string; body: string } {
  const cap = step[0].toUpperCase() + step.slice(1);
  for (const name of [step, `step${cap}`, `run${cap}`, `cmd${cap}`, `${step}Step`]) {
    const body = functions.get(name);
    if (body !== undefined) return { name, body };
  }
  throw new Error(`No se encuentra la funcion del paso "${step}" en ${SMOKE_SCRIPT}.`);
}

/** Todo lo que alcanza el paso, incluidos sus ayudantes locales. */
function smokeStepReach(step: string): string {
  const { functions } = smokeScript();
  const { name, body } = smokeStep(step, functions);
  return reachable(body, functions, new Set([name]));
}

/** El literal de la tienda Prueba y toda constante que lo contiene. */
function storeTokens(source: string): string[] {
  const named = source.matchAll(new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*["']${SMOKE_STORE_ID}["']`, "g"));
  return [SMOKE_STORE_ID, ...[...named].map((m) => m[1])];
}

/** La constante `*PREFIX* = "..."` del transportista desechable: [nombre, valor]. */
function smokePrefix(source: string): [string, string] {
  const match = source.match(/\bconst\s+([A-Za-z_$][\w$]*PREFIX[\w$]*)\s*=\s*["']([^"']+)["']/i);
  if (!match) throw new Error("No hay constante de prefijo `const *PREFIX* = \"...\"`.");
  return [match[1], match[2]];
}

const FIRESTORE_DELETE = /\.delete\s*\(|\bdeleteUser\s*\(|\brecursiveDelete\b/;
const FIRESTORE_WRITE = /\.(?:set|update|delete|add|create)\s*\(|\bbatch\s*\(|\brunTransaction\s*\(/;
const SETTLED_CHECK = /\bsettlementId\b/;
const FILE_WRITE = /\bwriteFile(?:Sync)?\s*\(/;
const NONZERO_EXIT = /process\.exit\s*\(\s*[1-9]|process\.exitCode\s*=\s*[1-9]/;
const EARLY_STOP = /\breturn\b|\bthrow\b|process\.exit(?:Code)?\b/;
const PLATFORM_POSITION_REQUIRE = /require\(\s*["']\.\.\/functions\/lib\/platform-position["']\s*\)/;

describe("T11 · RF_11, RNF_01: guion del smoke en produccion (DoD 5)", () => {
  describe("forma del guion", () => {
    it("DoD 5 · usa firebase-admin de functions/node_modules contra el proyecto kentro-last-mile", () => {
      const { source } = smokeScript();
      expect(source).toMatch(/require\(\s*["']\.\.\/functions\/node_modules\/firebase-admin["']\s*\)/);
      expect(source).toMatch(/initializeApp\(\s*\{\s*projectId\s*:\s*["']kentro-last-mile["']/);
    });

    it.each(SMOKE_STEPS)("DoD 5 · el paso `%s` es una rama del argumento con su funcion", (step) => {
      const { source, functions } = smokeScript();
      expect(source).toMatch(/process\.argv/);
      expect(source).toMatch(new RegExp(`["'\`]${step}["'\`]|\\b${step}\\s*:|[{,]\\s*${step}\\s*[,}]`));
      expect(() => smokeStep(step, functions)).not.toThrow();
    });

    it("caso limite (smoke interrumpido) · acepta --order y --driver para retomar desde los ids", () => {
      const { source } = smokeScript();
      expect(source).toContain("--order");
      expect(source).toContain("--driver");
    });
  });

  describe("count: solo lectura, antes de desplegar", () => {
    it("DoD 5 · count no escribe en Firestore ni Auth (.set( .update( .delete( .add( lotes, transacciones)", () => {
      const reach = smokeStepReach("count");
      expect(reach).not.toMatch(FIRESTORE_WRITE);
      expect(reach).not.toMatch(/\bcreateUser\s*\(|\bdeleteUser\s*\(/);
    });

    it("DoD 5 · count cuenta pedidos con communityId", () => {
      expect(smokeStepReach("count")).toMatch(/\bcommunityId\b/);
    });

    it("DoD 5 · count guarda en archivo la posicion (computePlatformPosition) y el saldo de la tienda Prueba", () => {
      const { source } = smokeScript();
      const reach = smokeStepReach("count");
      expect(reach).toMatch(/\bcomputePlatformPosition\s*\(/);
      expect(reach).toMatch(FILE_WRITE);
      expect(storeTokens(source).some((token) => reach.includes(token)), `count usa ${SMOKE_STORE_ID}`).toBe(true);
    });
  });

  describe("create y close", () => {
    it("DoD 5 · el transportista desechable lleva un prefijo fijo \"smoke...\" que usa create (Auth + drivers)", () => {
      const { source } = smokeScript();
      const [prefixName, prefixValue] = smokePrefix(source);
      expect(prefixValue).toMatch(/smoke/i);
      const reach = smokeStepReach("create");
      expect(reach).toContain(prefixName);
      expect(reach).toMatch(/\bcreateUser\s*\(/);
      expect(reach).toMatch(/collection\(\s*["']drivers["']\s*\)/);
    });

    it("DoD 5 · create hace el pedido de la tienda Prueba en orders", () => {
      const { source } = smokeScript();
      const reach = smokeStepReach("create");
      expect(storeTokens(source).some((token) => reach.includes(token)), `create usa ${SMOKE_STORE_ID}`).toBe(true);
      expect(reach).toMatch(/collection\(\s*["']orders["']\s*\)/);
    });

    it("DoD 5 · close cierra como fallido cobrable: outcome \"failed\" y failedCategory \"failed_visit\"", () => {
      const reach = smokeStepReach("close");
      expect(reach).toMatch(/\boutcome\s*:\s*["']failed["']/);
      expect(reach).toMatch(/\bfailedCategory\s*:\s*["']failed_visit["']/);
    });

    it("DoD 5 · close llama la callable closeOrder con sesion REST signInWithPassword", () => {
      const reach = smokeStepReach("close");
      expect(reach).toContain("closeOrder");
      expect(reach).toContain("signInWithPassword");
    });

    it("regla de oro 1 · close no escribe el pedido directamente en Firestore (solo la callable)", () => {
      expect(smokeStepReach("close")).not.toMatch(FIRESTORE_WRITE);
    });
  });

  describe("check", () => {
    it("DoD 5 · check exige failed_fee de -12000 para la tienda", () => {
      const reach = smokeStepReach("check");
      expect(reach).toMatch(/["']failed_fee["']/);
      expect(reach).toMatch(/-\s*12_?000\b/);
    });

    it("DoD 5 · check exige la ausencia de community_cashback y falla si no se cumple", () => {
      const reach = smokeStepReach("check");
      expect(reach).toMatch(/["']community_cashback["']/);
      expect(reach).toMatch(new RegExp(`${NONZERO_EXIT.source}|\\bthrow\\b`));
    });

    it("DoD 5 · check guarda los asientos como evidencia en archivo", () => {
      expect(smokeStepReach("check")).toMatch(FILE_WRITE);
    });
  });

  describe("cleanup: comprobar cortes, respaldar, borrar solo lo del smoke", () => {
    it("caso limite (pedido fallido en produccion) · cleanup comprueba settlementId ANTES de la primera eliminacion", () => {
      const { functions } = smokeScript();
      const { name, body } = smokeStep("cleanup", functions);
      const check = firstReach(body, SETTLED_CHECK, functions, name);
      const firstDelete = firstReach(body, FIRESTORE_DELETE, functions, name);
      expect(check, "cleanup alcanza settlementId").toBeGreaterThanOrEqual(0);
      expect(firstDelete, "cleanup alcanza una eliminacion").toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(firstDelete);
    });

    it("caso limite (pedido fallido en produccion) · cleanup comprueba tambien supplierSettlementId antes de borrar", () => {
      const { functions } = smokeScript();
      const { name, body } = smokeStep("cleanup", functions);
      const check = firstReach(body, /\bsupplierSettlementId\b/, functions, name);
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(firstReach(body, FIRESTORE_DELETE, functions, name));
    });

    it("caso limite (pedido fallido en produccion) · si hay un asiento cortado, una ruta sale sin borrar nada", () => {
      const { functions } = smokeScript();
      const { name, body } = smokeStep("cleanup", functions);
      const check = firstReach(body, SETTLED_CHECK, functions, name);
      const firstDelete = firstReach(body, FIRESTORE_DELETE, functions, name);
      expect(check).toBeGreaterThanOrEqual(0);
      expect(firstDelete).toBeGreaterThan(check);
      const region = body.slice(check, firstDelete);
      const stopsInRegion = EARLY_STOP.test(region);
      const stopsInHelper = localCallees(region, functions)
        .filter((callee) => callee !== name)
        .some((callee) => /\bthrow\b|process\.exit/.test(functions.get(callee) ?? ""));
      expect(stopsInRegion || stopsInHelper, "return/throw/process.exit entre la comprobacion y el primer borrado").toBe(true);
    });

    it("DoD 5 · cleanup respalda en archivo ANTES de la primera eliminacion", () => {
      const { functions } = smokeScript();
      const { name, body } = smokeStep("cleanup", functions);
      const backup = firstReach(body, FILE_WRITE, functions, name);
      expect(backup, "cleanup escribe un respaldo").toBeGreaterThanOrEqual(0);
      expect(backup).toBeLessThan(firstReach(body, FIRESTORE_DELETE, functions, name));
    });

    it("DoD 5 · cleanup borra pedido, walletEntries, auditEvents y el transportista (drivers + Auth)", () => {
      const reach = smokeStepReach("cleanup");
      expect(reach).toMatch(/collection\(\s*["']orders["']\s*\)/);
      expect(reach).toMatch(/collection\(\s*["']walletEntries["']\s*\)/);
      expect(reach).toMatch(/collection\(\s*["']auditEvents["']\s*\)/);
      expect(reach).toMatch(/collection\(\s*["']drivers["']\s*\)/);
      expect(reach).toMatch(/\bdeleteUser\s*\(/);
    });

    it("DoD 5 · cleanup solo toca transportistas con el prefijo del smoke (startsWith(<PREFIX>))", () => {
      const { source } = smokeScript();
      const [prefixName] = smokePrefix(source);
      expect(smokeStepReach("cleanup")).toMatch(new RegExp(`\\.startsWith\\(\\s*${prefixName}\\s*\\)`));
    });

    it("DoD 5 · cleanup no borra por consultas amplias: toda .where( filtra por orderId/entityId/documentId", () => {
      const reach = smokeStepReach("cleanup");
      expect(reach).not.toMatch(/\blistDocuments\s*\(|\brecursiveDelete\b/);
      expect(reach).not.toMatch(/collection\(\s*["'][^"']+["']\s*\)\s*\.(?:get|stream|limit)\s*\(/);
      const whereFields = [...reach.matchAll(/\.where\(\s*([^,]+),/g)].map((m) => m[1].trim());
      for (const field of whereFields) {
        expect(field, `.where(${field}, ...)`).toMatch(/^["'](?:orderId|entityId)["']$|FieldPath\.documentId\(\)$/);
      }
    });
  });

  describe("compare: vuelve a las cifras de count o falla", () => {
    it("DoD 5 · toma computePlatformPosition de ../functions/lib/platform-position", () => {
      const { source } = smokeScript();
      const destructured = new RegExp(`\\{[^}]*\\bcomputePlatformPosition\\b[^}]*\\}\\s*=\\s*${PLATFORM_POSITION_REQUIRE.source}`);
      const member = new RegExp(`${PLATFORM_POSITION_REQUIRE.source}\\s*\\.\\s*computePlatformPosition\\b`);
      expect(destructured.test(source) || member.test(source)).toBe(true);
    });

    it("DoD 5 · compare recalcula la posicion y el saldo de la tienda Prueba y lee lo guardado por count", () => {
      const { source } = smokeScript();
      const reach = smokeStepReach("compare");
      expect(reach).toMatch(/\bcomputePlatformPosition\s*\(/);
      expect(reach).toMatch(/\breadFileSync\s*\(/);
      expect(storeTokens(source).some((token) => reach.includes(token)), `compare usa ${SMOKE_STORE_ID}`).toBe(true);
    });

    it("DoD 5 · compare sale con codigo distinto de 0 si no coincide (process.exit(1) / process.exitCode = 1)", () => {
      expect(smokeStepReach("compare")).toMatch(NONZERO_EXIT);
    });
  });
});

/**
 * T13 · RF_01, RF_03 — La proteccion de DANDA, atada a una prueba de COMPORTAMIENTO.
 *
 * El caso limite de la spec 004 dice que una tienda con tarifa especial en codigo ya no puede
 * entrar en una comunidad y que esa proteccion "MUST mantenerse: esta spec no la relaja". Hasta
 * ahora la unica red era la guarda de fuente de T6: exige que el sello consulte `<X>.has(sellerId)`
 * con un conjunto importado de `./seller-charges`. La auditoria encontro el agujero: cambiar el
 * `throw` por un `return {}` deja esa guarda EN VERDE y el pedido de una tienda con tarifa fija
 * nace con precio de comunidad sin que nada avise — el fallo que no lanza y solo se ve al cuadrar
 * un corte.
 *
 * CONTRATO que fija este bloque:
 *
 *   export function assertSellerCanJoinCommunity(sellerId: string): void;  // LANZA si tiene tarifa
 *                                                                         // especial en codigo
 *
 * en `functions/src/seller-charges.ts` (que sigue siendo puro, RNF_03), y el sello la LLAMA en vez
 * de llevar el `throw` escrito a mano. Asi el rechazo se puede probar sin Firestore, y la tercera
 * prueba ata las DOS vistas de "tienda con tarifa especial" —la que decide el cobro y la que decide
 * el ingreso a una comunidad— al MISMO conjunto: no pueden divergir.
 *
 * Carga diferida por caso (como T2/T6): en fase RED la exportacion no existe todavia, y con un
 * `import` estatico caerian tambien los bloques T1..T11 de este archivo.
 */
const ASSERT_NAME = "assertSellerCanJoinCommunity";
const NORMAL_SELLER_ID = "seller-1789149795537"; // la tienda "Prueba", sin tarifa especial

type AssertSellerCanJoinCommunity = (sellerId: string) => void;

/** La funcion pura nueva, con un fallo legible mientras no exista. */
async function loadAssert(): Promise<AssertSellerCanJoinCommunity> {
  const module = (await loadSellerCharges()) as SellerChargesModule & {
    [ASSERT_NAME]?: AssertSellerCanJoinCommunity;
  };
  const assertCanJoin = module[ASSERT_NAME];
  expect(
    typeof assertCanJoin,
    `functions/src/seller-charges.ts todavia no exporta ${ASSERT_NAME} (T13)`
  ).toBe("function");
  return assertCanJoin as AssertSellerCanJoinCommunity;
}

/** Todo conjunto de ids exportado por seller-charges (hoy `dandaSellerIds`; vale otro nombre). */
async function loadHardcodedTariffSellerIds(): Promise<string[]> {
  const module = (await loadSellerCharges()) as Record<string, unknown>;
  const ids = new Set<string>();
  for (const value of Object.values(module)) {
    if (!(value instanceof Set)) continue;
    for (const member of value) if (typeof member === "string") ids.add(member);
  }
  expect([...ids], "seller-charges no exporta ningun conjunto de tiendas con tarifa especial").not.toEqual([]);
  return [...ids];
}

/** La sentencia que contiene la posicion `index` (de `;`/`{`/`}` anterior hasta el `;` siguiente). */
function statementContaining(source: string, index: number): string {
  const start = Math.max(source.lastIndexOf(";", index), source.lastIndexOf("{", index), source.lastIndexOf("}", index));
  const end = source.indexOf(";", index);
  return source.slice(start + 1, end < 0 ? source.length : end + 1);
}

/** Cuerpo de cada `if` cuya CONDICION menciona `sellerId` (bloque `{...}` o sentencia suelta). */
function sellerIdBranchBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/\bif\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingClose(source, open);
    if (!/\bsellerId\b/.test(source.slice(open, close + 1))) continue;
    const rest = source.slice(close + 1);
    const brace = rest.match(/^\s*\{/);
    if (brace) {
      const braceIndex = close + 1 + brace[0].length - 1;
      bodies.push(source.slice(braceIndex, matchingClose(source, braceIndex) + 1));
      continue;
    }
    const end = rest.indexOf(";");
    bodies.push(end < 0 ? rest : rest.slice(0, end + 1));
  }
  return bodies;
}

describe("T13 · RF_01, RF_03: una tienda con tarifa especial en codigo no puede entrar en una comunidad", () => {
  const TARIFFS = {
    sellerDeliveredFeeCop: 14000,
    sellerFailedFeeCop: 9000,
    fulfillmentFeeCop: 2500,
    driverDeliveredPayCop: 9500,
    driverFailedPayCop: 8500
  };

  it("RF_03 · lanza para la tienda DANDA, y el mensaje nombra el id y dice que no puede pertenecer a una comunidad", async () => {
    const assertCanJoin = await loadAssert();
    // Sin fijar la frase entera: lo que no puede perderse es el id (para saber QUE tienda) y que
    // se hable de la comunidad (para saber POR QUE se rechazo).
    expect(() => assertCanJoin(DANDA_SELLER_ID)).toThrowError(new RegExp(DANDA_SELLER_ID));
    expect(() => assertCanJoin(DANDA_SELLER_ID)).toThrowError(/comunidad/i);
  });

  it("RF_03 · NO lanza para una tienda normal ni para cadena vacia", async () => {
    const assertCanJoin = await loadAssert();
    expect(() => assertCanJoin(NORMAL_SELLER_ID)).not.toThrow();
    expect(() => assertCanJoin("")).not.toThrow();
  });

  it("RF_01/RF_03 · para todo id del conjunto: lanza Y su cobro por fallido es 0 (las dos vistas no pueden divergir)", async () => {
    const [assertCanJoin, { resolveSellerCharges }, ids] = await Promise.all([
      loadAssert(),
      loadSellerCharges(),
      loadHardcodedTariffSellerIds()
    ]);
    expect(ids).toContain(DANDA_SELLER_ID);
    for (const sellerId of ids) {
      expect(() => assertCanJoin(sellerId), `${ASSERT_NAME}("${sellerId}")`).toThrow();
      expect(resolveSellerCharges({ sellerId }, TARIFFS, CLOSED_AT).sellerFailedFeeCop, `cobro por fallido de ${sellerId}`).toBe(0);
    }
  });

  it("RF_01/RF_03 · la conversa: una tienda que NO esta en el conjunto entra en una comunidad y paga el fallido fijo", async () => {
    const [assertCanJoin, { resolveSellerCharges }, ids] = await Promise.all([
      loadAssert(),
      loadSellerCharges(),
      loadHardcodedTariffSellerIds()
    ]);
    expect(ids).not.toContain(NORMAL_SELLER_ID);
    expect(() => assertCanJoin(NORMAL_SELLER_ID)).not.toThrow();
    expect(resolveSellerCharges({ sellerId: NORMAL_SELLER_ID }, TARIFFS, CLOSED_AT).sellerFailedFeeCop).toBe(12000);
  });

  describe("guarda de fuente: el sello no puede degradar el rechazo a un retorno silencioso", () => {
    it("RF_03 · community-order-pricing.ts llama a assertSellerCanJoinCommunity(sellerId)", () => {
      const source = sourceWithoutComments("community-order-pricing.ts");
      expect(source).toMatch(new RegExp(`\\b${ASSERT_NAME}\\s*\\(`));
      expect(firstArguments(source, ASSERT_NAME)).toContain("sellerId");
      expect(namedValueImports(source, "./seller-charges")).toContain(ASSERT_NAME);
    });

    it("RF_03 · la sentencia que rechaza no contiene un `return` que sustituya al rechazo", () => {
      // Redactada para que un `throw` DENTRO de la funcion pura la satisfaga: aqui no se exige
      // ningun `throw` escrito en el sello, solo que la llamada no se haya convertido en una
      // salida silenciosa (`return {}`).
      const source = sourceWithoutComments("community-order-pricing.ts");
      const call = source.search(new RegExp(`\\b${ASSERT_NAME}\\s*\\(`));
      expect(call, `${ASSERT_NAME}( no aparece en community-order-pricing.ts`).toBeGreaterThanOrEqual(0);
      const statement = statementContaining(source, call);
      expect(statement).toMatch(new RegExp(`\\b${ASSERT_NAME}\\s*\\(`));
      expect(statement, "la llamada que rechaza no puede formar parte de un return").not.toMatch(/\breturn\b/);
    });

    it("RF_03 · ninguna rama que decide sobre la tienda (`sellerId` en la condicion) sale con un `return`", () => {
      const source = sourceWithoutComments("community-order-pricing.ts");
      for (const body of sellerIdBranchBodies(source)) {
        expect(body, `rama sobre sellerId: ${body.trim()}`).not.toMatch(/\breturn\b/);
      }
    });
  });
});
