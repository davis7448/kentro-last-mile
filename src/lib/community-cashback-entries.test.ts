import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCommunityStats,
  type RawCommunityAggregates
} from "../../functions/src/community-stats-math";
import { buildWalletEntries } from "../../functions/src/wallet-entries";
import { communityCashbackPaidCop } from "./community-view";
import type { OrderCommunityPricing } from "./types";

const NOW = "2026-09-10T12:00:00.000Z";
const TARIFFS = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 9000
};

const frozen = (over: Partial<OrderCommunityPricing> = {}): OrderCommunityPricing => ({
  communityId: "com-1",
  frozenAt: "2026-09-01T00:00:00.000Z",
  sellerDeliveredFeeCop: 15000,
  baseDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 14000,
  baseFailedFeeCop: 12000,
  fulfillmentFeeCop: 2500,
  baseFulfillmentFeeCop: 2000,
  ...over
});

function order(over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    shopifyOrderId: "KNT001",
    sellerId: "seller-x",
    driverId: "driver-1",
    status: "delivered",
    paymentMethod: "cod",
    fulfillmentMode: "seller",
    totalCop: 100000,
    evidence: [],
    ...over
  };
}

const find = (entries: ReturnType<typeof buildWalletEntries>, id: string) => entries.find((e) => e.id === id);
const cashbacks = (entries: ReturnType<typeof buildWalletEntries>) =>
  entries.filter((e) => e.type === "community_cashback");

describe("T6 · asiento de cashback", () => {
  it("RF_22: un pedido entregado cobra el precio congelado, no la tarifa viva", () => {
    const entries = buildWalletEntries(order({ communityPricing: frozen() }), TARIFFS, NOW);
    expect(find(entries, "we-ord-1-seller-delivery-fee")?.amountCop).toBe(-15000);
  });

  it("RF_22: causa el cashback del lider como final menos base", () => {
    const entries = buildWalletEntries(order({ communityPricing: frozen() }), TARIFFS, NOW);
    const entry = find(entries, "we-ord-1-community-cashback-delivered");
    expect(entry?.ownerType).toBe("community_leader");
    expect(entry?.ownerId).toBe("com-1");
    expect(entry?.amountCop).toBe(3000);
    expect(entry?.createdAt).toBe(NOW);
  });

  it("RF_22: el flete de fallido congelado NO lo pisa la linea de los 12.000", () => {
    // Esta prueba existe por wallet-entries.ts:156, que fija sellerFailedFeeCop despues del
    // spread y ya anulo en silencio un cambio de tarifa en ago-2026.
    const entries = buildWalletEntries(
      order({ status: "failed", failedCategory: "failed_visit", communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    expect(find(entries, "we-ord-1-seller-failed-fee")?.amountCop).toBe(-14000);
    expect(find(entries, "we-ord-1-community-cashback-failed")?.amountCop).toBe(2000);
  });

  it("RF_22: el manejo desde bodega tambien genera cashback", () => {
    const entries = buildWalletEntries(
      order({ fulfillmentMode: "warehouse", communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    expect(find(entries, "we-ord-1-fulfillment-fee")?.amountCop).toBe(-2500);
    expect(find(entries, "we-ord-1-community-cashback-fulfillment")?.amountCop).toBe(500);
  });

  it("RF_23: un cashback de cero no emite asiento", () => {
    const sinMargen = frozen({ sellerDeliveredFeeCop: 12000, fulfillmentFeeCop: 2000, sellerFailedFeeCop: 12000 });
    const entries = buildWalletEntries(order({ communityPricing: sinMargen }), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(0);
  });

  it("RF_23: un pedido anulado no causa cashback", () => {
    const entries = buildWalletEntries(order({ status: "cancelled", communityPricing: frozen() }), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(0);
  });

  it("RF_23: un fallido no cobrable no causa cashback", () => {
    const entries = buildWalletEntries(
      order({ status: "failed", failedCategory: "no_coverage", communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    expect(cashbacks(entries)).toHaveLength(0);
  });

  it("RNF_02: un pedido SIN comunidad produce exactamente los mismos asientos que antes", () => {
    // La garantia de que esta funcionalidad no mueve el dinero que ya existe.
    const entries = buildWalletEntries(order(), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(0);
    expect(find(entries, "we-ord-1-seller-delivery-fee")?.amountCop).toBe(-12000);
    expect(find(entries, "we-ord-1-cod")?.amountCop).toBe(100000);
    expect(find(entries, "we-ord-1-driver-delivery-pay")?.amountCop).toBe(9000);
  });
});

/**
 * T42 · RNF_01 — cuantos documentos baja el navegador del lider segun el volumen.
 *
 * La spec pide comparar la cuenta con 100 y con 10.000 pedidos en el periodo y que sea la MISMA.
 * No hace falta produccion para medirlo: los asientos son deterministas y `buildWalletEntries` es
 * puro, asi que se puede contar exactamente lo que devolveria la consulta del rol.
 *
 * T42 no ACOTA la suscripcion de wallet del lider: la ELIMINA. `CommunityLeaderView` no lee
 * `state.wallet` en ningun punto — el cashback causado llega agregado del servidor
 * (`getCommunityStats`) y el pagado sale de `state.settlements` via `communityCashbackPaidCop`,
 * como fija la ultima prueba de este archivo. Bajar un asiento por pedido para no leerlo es puro
 * peso, asi que la cuenta correcta no es "menos": es CERO, con 100 pedidos y con 10.000.
 */
const LEADER_ID = "com-1";

/**
 * ESPEJO A MANO de los targets de wallet de `subscribeFirestoreState`. Es una copia, no el
 * codigo real: este archivo NO puede importar `state-store.ts` porque arrastra el SDK de
 * Firebase y la suite corre en Node sin navegador ni credenciales.
 *
 * Que sea una copia es exactamente el riesgo que tiene esta prueba, asi que no se queda sola:
 * el bloque siguiente lee `state-store.ts` COMO TEXTO y comprueba que el espejo sigue diciendo
 * la verdad. Si alguien devuelve la suscripcion, falla ahi aunque aqui nadie toque nada.
 */
type WalletTarget = { ownerType: string; ownerId: string; settlementId?: string } | null;

const WALLET_SUBSCRIPTION: Record<"seller" | "driver" | "community_leader", WalletTarget> = {
  seller: { ownerType: "seller", ownerId: "seller-x", settlementId: "" },
  driver: { ownerType: "driver", ownerId: "driver-1" },
  // T42: sin target. La consulta no existe, no es que devuelva pocos documentos.
  community_leader: null
};

/** Lo que baja el navegador de un rol sobre un periodo de `n` pedidos con cashback. */
function walletDocsFor(role: keyof typeof WALLET_SUBSCRIPTION, n: number): number {
  const target = WALLET_SUBSCRIPTION[role];
  // Sin consulta no hay documentos. Esta es la linea que hace cero la cuenta del lider.
  if (!target) return 0;
  let docs = 0;
  for (let i = 0; i < n; i += 1) {
    // Mezcla deliberadamente conservadora: 8 de cada 10 entregados, 2 fallidos cobrables.
    // Cuantos menos asientos por pedido, mas favorable es la cuenta al codigo.
    const status = i % 10 < 8 ? "delivered" : "failed";
    const entries = buildWalletEntries(
      order({ id: `ord-${i}`, status, failedCategory: status === "failed" ? "failed_visit" : undefined, communityPricing: frozen() }),
      TARIFFS,
      NOW
    );
    docs += entries.filter(
      (e) =>
        e.ownerType === target.ownerType &&
        e.ownerId === target.ownerId &&
        (target.settlementId === undefined || e.settlementId === target.settlementId)
    ).length;
  }
  return docs;
}

describe("T42 · RNF_01: la carga del lider frente al volumen", () => {
  it("RNF_01: la cuenta de documentos de wallet es la MISMA con 100 y con 10.000 pedidos", () => {
    const con100 = walletDocsFor("community_leader", 100);
    const con10k = walletDocsFor("community_leader", 10_000);

    // Lo que exige RNF_01, literal: que el volumen no mueva la cuenta.
    expect(con10k).toBe(con100);
    // Y la cifra concreta es cero, porque la consulta se elimino en vez de acotarse.
    expect(con100).toBe(0);
    expect(con10k).toBe(0);
  });

  it("RNF_01: el mismo periodo SI mueve la cuenta de un rol que aun baja su wallet", () => {
    // Control negativo. Sin el, la prueba de arriba tambien pasaria con un espejo roto que
    // devolviera cero para todo el mundo, y no estaria midiendo nada.
    // Cifras medidas: por pedido entregado la tienda tiene 2 asientos (recaudo + flete) y por
    // fallido cobrable 1; con la mezcla 80/20 son 180 por cada 100 pedidos. El domiciliario, 1.
    expect(walletDocsFor("seller", 100)).toBe(180);
    expect(walletDocsFor("seller", 10_000)).toBe(18_000);
    expect(walletDocsFor("driver", 100)).toBe(100);
    expect(walletDocsFor("driver", 10_000)).toBe(10_000);
  });

  it("RNF_01: eliminar la suscripcion no borra el dinero, solo deja de bajarlo", () => {
    // El asiento de cashback se sigue causando exactamente igual (eso es RNF_02). Lo que cambia
    // es quien lo lee: el servidor al agregar, no el navegador del lider documento a documento.
    const entries = buildWalletEntries(order({ communityPricing: frozen() }), TARIFFS, NOW);
    expect(cashbacks(entries)).toHaveLength(1);
    expect(find(entries, "we-ord-1-community-cashback-delivered")?.ownerId).toBe(LEADER_ID);
    expect(walletDocsFor("community_leader", 1)).toBe(0);
  });

  it("RNF_01: tampoco la acota el filtro por corte, porque no queda consulta que acotar", () => {
    // `seller` filtra `settlementId == ""`; al lider ya no le queda ningun filtro que aplicar.
    // Se deja escrito para que nadie "arregle" RNF_01 anadiendo ese where: todo asiento nace sin
    // liquidar, asi que dentro de un periodo abierto la cuenta seguiria creciendo uno a uno.
    const conFiltroDeCorte = (n: number) => {
      let docs = 0;
      for (let i = 0; i < n; i += 1) {
        const entries = buildWalletEntries(order({ id: `ord-${i}`, communityPricing: frozen() }), TARIFFS, NOW);
        docs += entries.filter(
          (e) => e.ownerType === "community_leader" && e.ownerId === LEADER_ID && e.settlementId === ""
        ).length;
      }
      return docs;
    };
    expect(conFiltroDeCorte(100)).toBe(100);
    expect(conFiltroDeCorte(10_000)).toBe(10_000);
    // Es decir: acotar por corte NO cumple RNF_01. Solo lo cumple no consultar.
    expect(walletDocsFor("community_leader", 10_000)).toBe(0);
  });
});

/**
 * T42 · RNF_01 — lo que ata el espejo de arriba al codigo real.
 *
 * `state-store.ts` no se puede importar (SDK de Firebase), asi que se lee COMO TEXTO. Es una
 * comprobacion de fuente, con lo que eso implica: si alguien reescribe el bloque con otra forma
 * sintactica, esta prueba se pone roja sin que nada este mal. Se acepta a proposito — RNF_01 es
 * un presupuesto de carga, y un falso rojo que obliga a mirar la consulta es barato comparado
 * con el fallo real, que es silencioso: la app funciona, solo baja megabytes de mas.
 *
 * Cada `expect` negativo (no contiene X) va acompanado de uno positivo sobre otro rol, para que
 * un extractor roto no deje pasar la prueba en vacio.
 */
const STATE_STORE_SOURCE = readFileSync(fileURLToPath(new URL("./firebase/state-store.ts", import.meta.url)), "utf8");

/** El trozo de `subscribeFirestoreState` que decide que consulta `rol`, hasta el rol siguiente. */
function ramaDeSuscripcion(rol: string, rolSiguiente: string): string {
  const inicioFuncion = STATE_STORE_SOURCE.indexOf("export function subscribeFirestoreState");
  expect(inicioFuncion, "subscribeFirestoreState cambio de nombre; actualizar esta prueba").toBeGreaterThan(-1);
  const inicio = STATE_STORE_SOURCE.indexOf(`role === "${rol}"`, inicioFuncion);
  const fin = STATE_STORE_SOURCE.indexOf(`role === "${rolSiguiente}"`, inicio);
  expect(inicio, `no se encontro la rama de ${rol} en subscribeFirestoreState`).toBeGreaterThan(-1);
  expect(fin, `no se encontro la rama de ${rolSiguiente} en subscribeFirestoreState`).toBeGreaterThan(inicio);
  return STATE_STORE_SOURCE.slice(inicio, fin);
}

describe("T42 · RNF_01: la consulta de wallet del lider no existe en el codigo", () => {
  it("RNF_01: la suscripcion del lider no abre ningun target de wallet", () => {
    const lider = ramaDeSuscripcion("community_leader", "driver");
    expect(lider).not.toContain('key: "wallet"');
    // Positivo de control sobre el mismo extractor: el domiciliario SI sigue bajando la suya.
    expect(ramaDeSuscripcion("driver", "messenger")).toContain('key: "wallet"');
  });

  it("RNF_01: la suscripcion del lider sigue sin abrir pedidos y conserva sus cortes", () => {
    // El otro medio presupuesto del rol. `settlements` es lo que alimenta el cashback PAGADO,
    // asi que quitarlo por error al quitar la wallet dejaria la cifra en cero en silencio.
    const lider = ramaDeSuscripcion("community_leader", "driver");
    expect(lider).not.toContain('key: "orders"');
    expect(lider).not.toContain("orderTargets(");
    expect(lider).toContain('key: "settlements"');
  });

  it("RNF_01: la carga inicial dice lo mismo que el listener, no la coleccion entera", () => {
    /**
     * La trampa documentada del proyecto: la carga inicial y la suscripcion son dos sitios y hay
     * que tocar los dos. Hoy `getWalletForContext` NO tiene rama de `community_leader` y cae al
     * fallback `getCollection("walletEntries")` — la coleccion ENTERA — pese al comentario que la
     * llama "espejo exacto". Queda tapado porque la suscripcion mete `wallet` en `skip`; al
     * quitarla, sin esta rama el primer pintado pediria la coleccion completa y las reglas
     * responderian 403.
     */
    const inicio = STATE_STORE_SOURCE.indexOf("async function getWalletForContext");
    expect(inicio, "getWalletForContext cambio de nombre; actualizar esta prueba").toBeGreaterThan(-1);
    const cuerpo = STATE_STORE_SOURCE.slice(inicio, STATE_STORE_SOURCE.indexOf("\n}", inicio));

    const posicionLider = cuerpo.indexOf("community_leader");
    expect(posicionLider, "getWalletForContext no tiene rama de community_leader").toBeGreaterThan(-1);
    // Lo que devuelva esa rama tiene que ser vacio, no una consulta.
    expect(cuerpo.slice(posicionLider, posicionLider + 200)).toMatch(
      /return\s+(Promise\.resolve\(\s*\[\]\s*\)|\[\])/
    );
    // Positivo de control: la tienda sigue teniendo su consulta acotada en el mismo cuerpo.
    expect(cuerpo).toContain('where("ownerType", "==", "seller")');
  });
});

/**
 * T42 · RNF_01 — de donde salen de verdad las dos cifras de cashback del panel.
 *
 * Esto es lo que justifica que la suscripcion de wallet sobre: ninguna de las dos cifras que
 * pinta `CommunityLeaderView` se deriva de `state.wallet`.
 *   - CAUSADO: llega agregado del servidor (`getCommunityStats` -> `cashbackAccruedCop`).
 *   - PAGADO: sale de `state.settlements` via `communityCashbackPaidCop`.
 * Y el PENDIENTE es la resta de las dos, que tampoco necesita un solo asiento.
 */
describe("T42 · RNF_01: las cifras del panel no salen de la wallet del navegador", () => {
  const corte = (over: Partial<{ kind: string; ownerId: string; status: string; netCop: number }> = {}) => ({
    kind: "community_leader",
    ownerId: LEADER_ID,
    status: "paid",
    netCop: 0,
    ...over
  });

  const agregadoDelServidor = (cashbackAccruedCop: number): RawCommunityAggregates => ({
    storeCount: 2,
    createdByStore: { "seller-x": 6, "seller-y": 4 },
    dispatchedByStore: { "seller-x": 6, "seller-y": 4 },
    deliveredByStore: { "seller-x": 5, "seller-y": 3 },
    failedByStore: { "seller-x": 1, "seller-y": 1 },
    cashbackAccruedCop,
    // Lo rellena el cliente con los cortes, no el servidor: ver el efecto de CommunityStatsView.
    cashbackPaidCop: 0
  });

  it("RNF_01: el causado viene del agregado del servidor y el pagado de los cortes", () => {
    // 10 pedidos cerrados con 3.000 de margen cada uno = 30.000 causados, agregados en Firestore.
    const raw = agregadoDelServidor(30_000);
    const pagado = communityCashbackPaidCop(
      [corte({ status: "paid", netCop: 18_000 }), corte({ status: "pending", netCop: 12_000 })],
      LEADER_ID
    );
    const stats = buildCommunityStats({ ...raw, cashbackPaidCop: pagado });

    expect(stats.totals.cashbackAccruedCop).toBe(30_000);
    expect(stats.totals.cashbackPaidCop).toBe(18_000);
    expect(stats.totals.cashbackPendingCop).toBe(12_000);
  });

  it("RNF_01: las tres cifras salen igual con 10.000 pedidos detras y cero asientos bajados", () => {
    // Mismo panel, volumen cien veces mayor: el causado sigue siendo UN numero del servidor y el
    // pagado UN corte. La cuenta de documentos de wallet del navegador no se mueve de cero.
    const causado = 3000 * 8000 + 2000 * 2000; // 8.000 entregados + 2.000 fallidos cobrables.
    const stats = buildCommunityStats({
      ...agregadoDelServidor(causado),
      cashbackPaidCop: communityCashbackPaidCop([corte({ status: "reconciled", netCop: 4_000_000 })], LEADER_ID)
    });

    expect(stats.totals.cashbackAccruedCop).toBe(28_000_000);
    expect(stats.totals.cashbackPaidCop).toBe(4_000_000);
    expect(stats.totals.cashbackPendingCop).toBe(24_000_000);
    expect(walletDocsFor("community_leader", 10_000)).toBe(0);
  });

  it("RNF_01: un lider sin cortes muestra pagado cero, no una cifra ausente", () => {
    // Caso limite del primer dia: hay causado (el servidor agrega) y todavia no hay ningun corte.
    // Sin asientos en el navegador, el pagado tiene que ser 0 y el pendiente todo lo causado.
    const stats = buildCommunityStats({
      ...agregadoDelServidor(9000),
      cashbackPaidCop: communityCashbackPaidCop([], LEADER_ID)
    });
    expect(stats.totals.cashbackPaidCop).toBe(0);
    expect(stats.totals.cashbackPendingCop).toBe(9000);
  });

  it("RNF_01: los cortes de otra comunidad no entran en el pagado de esta", () => {
    // El listener de `settlements` ya filtra por `ownerId`, pero la cifra no depende de eso:
    // la formula vuelve a filtrar, asi que un corte ajeno colado en `state` no la contamina.
    const pagado = communityCashbackPaidCop(
      [corte({ status: "paid", netCop: 7000 }), corte({ ownerId: "com-2", status: "paid", netCop: 500_000 })],
      LEADER_ID
    );
    expect(pagado).toBe(7000);
  });
});
