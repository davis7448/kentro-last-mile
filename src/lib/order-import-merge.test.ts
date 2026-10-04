import { describe, expect, it } from "vitest";
import {
  CLOSED_STATUSES,
  existingFactsFrom,
  MANUAL_EDIT_STAMP,
  mergeImportedOrder,
  orderPhase,
  viewAfterMerge,
  type ExistingOrderFacts
} from "../../functions/src/order-import-merge";

/**
 * Nucleo de la spec 017: que se conserva y que se refresca cuando una importacion se encuentra un
 * pedido que YA existe.
 *
 * El 2026-09-15 una reimportacion historica dejo 34 pedidos sin lider: el mensajero del KNT-004747
 * se quedo sin poder subir evidencia ni marcar entregado, y 26 entregas en efectivo salieron del
 * saldo del lider sin un solo error en pantalla. Cada prueba de aqui ata una de las reglas que
 * impiden que vuelva a pasar.
 */

/** Candidato tipico de Shopify: lo que la via construye ANTES de pasar por el nucleo. */
function incomingOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "shopify-1",
    trackingCode: "KNT-000001",
    shopifyOrderId: "#1001",
    sellerId: "seller-1",
    cityId: "city-cali",
    driverId: null,
    customerName: "Cliente Shopify",
    customerPhone: "+573000000000",
    addressRaw: "Calle 1 # 2-3, Cali, Colombia",
    totalCop: 100000,
    productName: "Producto",
    sku: "SKU-1",
    quantity: 1,
    lineItems: [{ sku: "SKU-1", productName: "Producto", quantity: 1 }],
    pickupPointName: "DANDA",
    pickupAddress: "",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    addressRisk: "review",
    status: "imported",
    evidence: [],
    source: "shopify_historical_sync",
    createdAt: "2026-09-10T15:42:31-05:00",
    ...overrides
  };
}

function facts(overrides: Partial<ExistingOrderFacts> = {}): ExistingOrderFacts {
  return { status: "in_route", ...overrides };
}

const NOW = "2026-09-20T10:00:00.000Z";

describe("orderPhase", () => {
  it("sin pedido guardado es creacion", () => {
    expect(orderPhase(null)).toBe("new");
  });

  it("solo `imported` cuenta como sin confirmar", () => {
    expect(orderPhase(facts({ status: "imported" }))).toBe("unconfirmed");
  });

  /**
   * `confirmOrder` (orders.ts) mueve el pedido de `imported` a `address_risk` o a `ready_to_assign`
   * segun el riesgo: llegar a `address_risk` significa que la llamada con el cliente YA ocurrio y
   * que la direccion guardada es la corregida.
   */
  it("`address_risk` ya esta confirmado, asi que es un pedido abierto", () => {
    expect(orderPhase(facts({ status: "address_risk" }))).toBe("open");
  });

  it("un pedido guardado sin estado se trata como abierto, que es lo que mas conserva", () => {
    expect(orderPhase(facts({ status: undefined }))).toBe("open");
  });

  it.each(CLOSED_STATUSES)("%s es un pedido cerrado", (status) => {
    expect(orderPhase(facts({ status }))).toBe("closed");
  });

  it("la marca de edicion manual gana a `imported`", () => {
    expect(orderPhase(facts({ status: "imported", [MANUAL_EDIT_STAMP]: NOW }))).toBe("edited");
  });

  it("la marca sobrevive a la confirmacion: editar y confirmar despues es el flujo normal", () => {
    expect(orderPhase(facts({ status: "ready_to_assign", [MANUAL_EDIT_STAMP]: NOW }))).toBe("edited");
  });

  it("un pedido cerrado sigue cerrado aunque lo hayan editado", () => {
    expect(orderPhase(facts({ status: "delivered", [MANUAL_EDIT_STAMP]: NOW }))).toBe("closed");
  });
});

describe("existingFactsFrom", () => {
  it("un pedido que no existe da `null`, y solo eso significa que no existe", () => {
    expect(existingFactsFrom({ exists: false, data: () => undefined })).toBeNull();
  });

  /**
   * `index.ts` hacia `const existingData = existing.data() ?? {}`. Si ese `{}` llegara como
   * `existing`, no seria `null`: el pedido nuevo se trataria como uno existente y naceria sin
   * estado, sin evidencia y sin lider. Esta prueba fija que `{}` es un pedido que existe.
   */
  it("un pedido que existe sin datos NO es creacion", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: {}, now: NOW });
    expect(merged.phase).not.toBe("new");
  });
});

describe("mergeImportedOrder — creacion (RF_10)", () => {
  it("un pedido nuevo se escribe exactamente como hoy", () => {
    const incoming = incomingOrder();
    const merged = mergeImportedOrder({ incoming, existing: null, now: NOW });
    expect(merged.phase).toBe("new");
    expect(merged.preserved).toEqual([]);
    expect(merged.clear).toEqual([]);
    expect(merged.doc).toEqual({ ...incoming, updatedAt: NOW });
  });

  /**
   * El caso que tumbo el webhook en septiembre: una tienda SIN comunidad deja el sello en
   * `undefined`, y el Admin SDK rechaza el documento entero. El nucleo tiene que quitarlo.
   */
  it("una tienda sin comunidad no arrastra claves sin valor", () => {
    const incoming = incomingOrder({ communityId: undefined, communityPricing: undefined });
    const merged = mergeImportedOrder({ incoming, existing: null, now: NOW });
    expect("communityId" in merged.doc).toBe(false);
    expect("communityPricing" in merged.doc).toBe(false);
  });

  /**
   * No basta con que `driverId` "no estorbe": el campo tiene que ESTAR y valer `null`. Un documento
   * sin el campo no empareja `where("driverId", "==", null)`, asi que el pedido nuevo no aparecria
   * en el pozo de disponibles del lider ni en las cifras — sin error y sin aviso.
   */
  it("el pedido nuevo nace con `driverId: null` presente", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: null, now: NOW });
    expect("driverId" in merged.doc).toBe(true);
    expect(merged.doc.driverId).toBeNull();
  });
});

describe("mergeImportedOrder — ciclo de vida y repesque (RF_11)", () => {
  it("ninguna fase existente reescribe el estado", () => {
    for (const status of ["imported", "in_route", "delivered"]) {
      const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status }), now: NOW });
      expect("status" in merged.doc).toBe(false);
    }
  });

  /**
   * RF_11 pide conservarlos "como ya hace hoy", y hoy hay repesque: `evidence ?? []`,
   * `createdAt ?? order.created_at ?? now`, y el `trackingCode` solo si es un string. Omitirlos
   * siempre dejaria a un pedido sin fecha de creacion sin recibirla nunca, y `normalizeOrder` le
   * pondria la de hoy en cada carga: saltaria al dia de la corrida.
   */
  it.each(["trackingCode", "createdAt", "evidence"])("%s se conserva si ya lo tiene", (field) => {
    const existing = facts({ trackingCode: "KNT-000009", createdAt: "2026-01-01T00:00:00.000Z", evidence: [{ id: "ev-1" }] });
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing, now: NOW });
    expect(field in merged.doc).toBe(false);
  });

  it.each(["trackingCode", "createdAt", "evidence"])("%s se deja pasar si el pedido no lo tiene", (field) => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts(), now: NOW });
    expect(field in merged.doc).toBe(true);
  });
});

describe("viewAfterMerge", () => {
  it("devuelve el pedido completo aunque el parche omita claves", () => {
    const existingRaw = { id: "shopify-1", status: "in_route", driverId: "driver-1", customerName: "Ruben" };
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ driverId: "driver-1" }), now: NOW });
    const view = viewAfterMerge(existingRaw, merged);
    expect(view.status).toBe("in_route");
    expect(view.driverId).toBe("driver-1");
  });

  /**
   * Lo que la via DEVUELVE viaja al navegador del admin, que lo mete directo en su estado. Si la
   * vista trajera las claves que se acaban de borrar, la pantalla mostraria datos que ya no existen.
   */
  it("no devuelve las claves que se acaban de borrar", () => {
    const existingRaw = { id: "shopify-1", status: "imported", normalizedAddress: "Calle vieja", lat: 3.4 };
    const existing = facts({ status: "imported", normalizedAddress: "Calle vieja", lat: 3.4 });
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing, now: NOW });
    const view = viewAfterMerge(existingRaw, merged);
    for (const key of merged.clear) expect(key in view).toBe(false);
    expect(merged.clear.length).toBeGreaterThan(0);
  });
});

describe("pertenencia — el pedido no cambia de dueno (RF_01, RF_12)", () => {
  const owned = { driverId: "driver-1", messengerId: "messenger-1", pickupBatchId: "pb-1" };

  it.each(["in_route", "delivered", "imported"])("un pedido %s conserva lider, mensajero y lote", (status) => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status, ...owned }), now: NOW });
    expect("driverId" in merged.doc).toBe(false);
    expect("messengerId" in merged.doc).toBe(false);
    expect("pickupBatchId" in merged.doc).toBe(false);
    expect(merged.preserved).toContain("ownership");
  });

  /**
   * La forma exacta del bug del 2026-09-15: `driverId: null` dentro de un `set(merge: true)` no es
   * "no tocar", es "borrar". Conservar tiene que ser omitir la clave, nunca emitir `null`.
   */
  it.each(["imported", "in_route", "delivered"])("en %s, `driverId` nunca sale como null ni undefined", (status) => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status, ...owned }), now: NOW });
    expect(Object.prototype.hasOwnProperty.call(merged.doc, "driverId")).toBe(false);
  });
});

describe("datos del cliente segun la fase (RF_02, RF_03, RF_17, RF_18)", () => {
  const corregido = {
    customerName: "Ruben Heredia",
    customerPhone: "+573186145101",
    addressRaw: "Calle 7 Oeste # 52-35 (corregida)",
    normalizedAddress: "Calle 7 Oeste 52-35, Cali",
    geoProvider: "mapbox"
  };

  it("un pedido sin confirmar y sin editar recibe lo que diga la tienda", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status: "imported", ...corregido }), now: NOW });
    expect(merged.doc.addressRaw).toBe(incomingOrder().addressRaw);
    expect(merged.doc.customerName).toBe("Cliente Shopify");
  });

  it("al refrescar la direccion se descarta la geocodificacion de la anterior", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status: "imported", ...corregido }), now: NOW });
    expect(merged.clear).toEqual(expect.arrayContaining(["normalizedAddress", "geoProvider"]));
    expect("normalizedAddress" in merged.doc).toBe(false);
  });

  it("un pedido ya confirmado conserva la direccion corregida", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status: "ready_to_assign", ...corregido }), now: NOW });
    expect("addressRaw" in merged.doc).toBe(false);
    expect("customerPhone" in merged.doc).toBe(false);
    expect(merged.clear).toEqual([]);
    expect(merged.preserved).toContain("customer");
  });

  /** Un pedido confirmado por el bot al que nadie edito a mano: manda el estado, no quien escribio. */
  it("confirmado por ChatBy sin edicion manual: se conserva igual", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status: "ready_to_assign", confirmedVia: "uchat_pull", ...corregido } as never), now: NOW });
    expect("addressRaw" in merged.doc).toBe(false);
  });

  /** RF_17: el estado dice "sin confirmar", la edicion dice "ya trabajado". Manda la edicion. */
  it("sin confirmar pero editado a mano: se conserva todo y no se borra nada", () => {
    const existing = facts({ status: "imported", [MANUAL_EDIT_STAMP]: "2026-09-16T09:00:00.000Z", ...corregido });
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing, now: NOW });
    expect("addressRaw" in merged.doc).toBe(false);
    expect(merged.clear).toEqual([]);
  });
});

describe("revision de direccion (RF_04)", () => {
  it.each(["accepted", "rejected"])("un veredicto %s no vuelve a 'review'", (addressRisk) => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ addressRisk }), now: NOW });
    expect("addressRisk" in merged.doc).toBe(false);
    expect(merged.preserved).toContain("address_review");
  });

  it("una direccion todavia sin revisar deja pasar lo entrante", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ addressRisk: "review" }), now: NOW });
    expect(merged.doc.addressRisk).toBe("review");
  });
});

describe("sello de comunidad (RF_05, RF_06, RF_07)", () => {
  const sellado = { communityId: "com-1", communityPricing: { deliveryFeeCop: 9000, frozenAt: "2026-08-01T00:00:00.000Z" } };
  const entrante = { communityId: "com-2", communityPricing: { deliveryFeeCop: 12000, frozenAt: NOW } };

  it("un pedido con sello congela el suyo", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(entrante), existing: facts(sellado), now: NOW });
    expect("communityId" in merged.doc).toBe(false);
    expect("communityPricing" in merged.doc).toBe(false);
    expect(merged.preserved).toContain("community_stamp");
  });

  it("un pedido abierto sin sello si lo recibe", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(entrante), existing: facts({ status: "in_route" }), now: NOW });
    expect(merged.doc.communityId).toBe("com-2");
  });

  /** Su dinero ya se calculo sin comunidad: sellarlo ahora cambiaria lo que se le debe a un lider. */
  it("un pedido cerrado sin sello NO se sella", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(entrante), existing: facts({ status: "delivered" }), now: NOW });
    expect("communityId" in merged.doc).toBe(false);
  });

  /**
   * El sello lleva dentro la fecha en que se calculo, y las vias lo recalculan en cada corrida. Si
   * se comparara entero, TODOS los pedidos con sello contarian como afectados siempre y el resumen
   * dejaria de distinguir nada.
   */
  it("dos sellos con la misma tarifa y distinta fecha no cuentan como cambio", () => {
    const incoming = incomingOrder({ communityId: "com-1", communityPricing: { deliveryFeeCop: 9000, frozenAt: NOW } });
    const merged = mergeImportedOrder({ incoming, existing: facts(sellado), now: NOW });
    expect(merged.preserved).not.toContain("community_stamp");
  });
});

describe("catalogo (RF_08, RF_09, RF_17)", () => {
  const otroCatalogo = { lineItems: [{ sku: "SKU-9", productName: "Otro", quantity: 3 }], totalCop: 250000, quantity: 3, productId: "prod-9" };

  it("un pedido abierto recibe el catalogo nuevo de la tienda", () => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(otroCatalogo), existing: facts({ status: "in_route", totalCop: 100000 }), now: NOW });
    expect(merged.doc.totalCop).toBe(250000);
    expect(merged.doc.lineItems).toBeDefined();
  });

  it.each(["lineItems", "productName", "sku", "quantity", "totalCop", "productId"])(
    "un pedido entregado congela %s",
    (field) => {
      const merged = mergeImportedOrder({ incoming: incomingOrder(otroCatalogo), existing: facts({ status: "delivered", totalCop: 100000 }), now: NOW });
      expect(field in merged.doc).toBe(false);
    }
  );

  /** El valor total es editable a mano en un pedido sin confirmar, y es dinero. */
  it("un pedido editado a mano congela su catalogo aunque no este cerrado", () => {
    const existing = facts({ status: "imported", totalCop: 90000, [MANUAL_EDIT_STAMP]: "2026-09-16T09:00:00.000Z" });
    const merged = mergeImportedOrder({ incoming: incomingOrder(otroCatalogo), existing, now: NOW });
    expect("totalCop" in merged.doc).toBe(false);
    expect(merged.preserved).toContain("frozen_catalog");
  });

  it("un pedido que se cierra entre dos corridas: la frontera es el estado al escribir", () => {
    const abierto = mergeImportedOrder({ incoming: incomingOrder(otroCatalogo), existing: facts({ status: "in_route" }), now: NOW });
    const cerrado = mergeImportedOrder({ incoming: incomingOrder(otroCatalogo), existing: facts({ status: "delivered" }), now: NOW });
    expect("totalCop" in abierto.doc).toBe(true);
    expect("totalCop" in cerrado.doc).toBe(false);
  });
});

describe("procedencia y condiciones de entrega (RF_15, RF_16)", () => {
  /** En el incidente, 34 pedidos nacidos por webhook pasaron a declararse reimportados. */
  it.each(["imported", "in_route", "delivered"])("en %s se conserva por donde entro el pedido", (status) => {
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing: facts({ status, source: "shopify_webhook" }), now: NOW });
    expect("source" in merged.doc).toBe(false);
    expect(merged.preserved).toContain("provenance");
  });

  it("las condiciones de entrega se conservan en cuanto el pedido sale de 'sin confirmar'", () => {
    const existing = facts({ status: "in_route", paymentMethod: "prepaid", pickupPointName: "OTRO" });
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing, now: NOW });
    expect("paymentMethod" in merged.doc).toBe(false);
    expect("pickupPointName" in merged.doc).toBe(false);
    expect(merged.preserved).toContain("delivery_terms");
  });

  it("un pedido sin confirmar si las refresca", () => {
    const existing = facts({ status: "imported", paymentMethod: "prepaid" });
    const merged = mergeImportedOrder({ incoming: incomingOrder(), existing, now: NOW });
    expect(merged.doc.paymentMethod).toBe("cod");
  });
});

describe("lo conservado que se reporta (RF_14)", () => {
  it("un entrante identico al guardado no reporta nada", () => {
    const incoming = incomingOrder();
    const existing = facts({
      status: "in_route",
      // Identico de verdad: la importacion siempre trae `driverId: null` y `addressRisk: "review"`,
      // asi que un pedido sin lider y sin revisar es el unico caso en que nada se iba a pisar.
      driverId: null,
      addressRisk: "review",
      customerName: incoming.customerName as string,
      customerPhone: incoming.customerPhone as string,
      addressRaw: incoming.addressRaw as string,
      source: incoming.source as string,
      paymentMethod: incoming.paymentMethod as string,
      pickupPointName: incoming.pickupPointName as string,
      pickupAddress: incoming.pickupAddress as string,
      fulfillmentMode: incoming.fulfillmentMode as string
    });
    const merged = mergeImportedOrder({ incoming, existing, now: NOW });
    expect(merged.preserved).toEqual([]);
  });

  /**
   * El caso limite de la spec pide que la segunda corrida no cambie ningun DATO, no que no reporte
   * nada: un pedido con lider reporta `ownership` en cada corrida, y con razon — la importacion
   * sigue trayendo `driverId: null`, asi que en cada pasada hay un lider que se salva.
   */
  it("dos corridas seguidas no cambian ningun valor del pedido", () => {
    const incoming = incomingOrder();
    const existing = facts({ status: "in_route", driverId: "driver-1" });
    const primera = mergeImportedOrder({ incoming, existing, now: NOW });
    const trasPrimera = { ...existing, ...primera.doc } as ExistingOrderFacts;
    const segunda = mergeImportedOrder({ incoming, existing: trasPrimera, now: "2026-09-20T11:00:00.000Z" });
    const { updatedAt: _a, ...valoresPrimera } = { ...trasPrimera } as Record<string, unknown>;
    const { updatedAt: _b, ...valoresSegunda } = { ...trasPrimera, ...segunda.doc } as Record<string, unknown>;
    expect(valoresSegunda).toEqual(valoresPrimera);
    expect(segunda.preserved).toEqual(primera.preserved);
  });
});
