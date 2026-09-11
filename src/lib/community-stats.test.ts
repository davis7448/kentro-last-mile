import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCommunityStats,
  dateAxisLabel,
  deliveryRate,
  splitActiveStores,
  type RawCommunityAggregates
} from "../../functions/src/community-stats-math";

const raw: RawCommunityAggregates = {
  storeCount: 3,
  createdByStore: { "seller-1": 10, "seller-2": 4, "seller-3": 0 },
  dispatchedByStore: { "seller-1": 9, "seller-2": 3, "seller-3": 0 },
  deliveredByStore: { "seller-1": 7, "seller-2": 2, "seller-3": 0 },
  failedByStore: { "seller-1": 1, "seller-2": 1, "seller-3": 0 },
  cashbackAccruedCop: 21000,
  cashbackPaidCop: 9000,
  ordersWithoutCashbackByZoneFloor: 2
};

describe("T20 · aritmetica del panel del lider", () => {
  it("RF_48: el porcentaje de entrega excluye los abiertos y viaja con su denominador", () => {
    // 9 entregados sobre 11 cerrados (9 entregados + 2 fallidos). Los 14 creados NO son el
    // denominador: mezclar creados con cerrados es la trampa de ejes que ya mordio aqui.
    const rate = deliveryRate({ delivered: 9, failed: 2 });
    expect(rate.denominator).toBe(11);
    expect(rate.percent).toBeCloseTo(81.8, 1);
  });

  it("RF_48: sin pedidos cerrados no se inventa un porcentaje", () => {
    const rate = deliveryRate({ delivered: 0, failed: 0 });
    expect(rate.denominator).toBe(0);
    expect(rate.percent).toBeNull();
  });

  it("RF_47: activa es la tienda con al menos un pedido creado en el periodo", () => {
    const split = splitActiveStores(raw.createdByStore);
    expect(split.active).toEqual(["seller-1", "seller-2"]);
    expect(split.inactive).toEqual(["seller-3"]);
  });

  it("RF_46: cada bloque declara por que fecha agrupa", () => {
    expect(dateAxisLabel("created")).toBe("por fecha de creacion");
    expect(dateAxisLabel("dispatched")).toBe("por fecha de despacho");
    expect(dateAxisLabel("closed")).toBe("por fecha de cierre");
  });

  it("RF_29, RF_30: agrega el total y el desglose por tienda", () => {
    const stats = buildCommunityStats(raw);
    expect(stats.totals.created).toBe(14);
    expect(stats.totals.delivered).toBe(9);
    expect(stats.totals.failed).toBe(2);
    expect(stats.totals.activeStores).toBe(2);
    expect(stats.totals.inactiveStores).toBe(1);
    expect(stats.totals.cashbackAccruedCop).toBe(21000);
    expect(stats.totals.cashbackPendingCop).toBe(12000);
    expect(stats.byStore).toHaveLength(3);
    const first = stats.byStore.find((s) => s.sellerId === "seller-1")!;
    expect(first.created).toBe(10);
    expect(first.delivered).toBe(7);
    expect(first.deliveryRate.denominator).toBe(8);
  });

  it("RF_33: distingue cero real de sin datos", () => {
    const sinTiendas = buildCommunityStats({ ...raw, storeCount: 0, createdByStore: {}, dispatchedByStore: {}, deliveredByStore: {}, failedByStore: {}, cashbackAccruedCop: 0, cashbackPaidCop: 0 });
    expect(sinTiendas.emptiness).toBe("no_stores");

    const sinPedidos = buildCommunityStats({ ...raw, createdByStore: { "seller-1": 0 }, dispatchedByStore: {}, deliveredByStore: {}, failedByStore: {}, cashbackAccruedCop: 0, cashbackPaidCop: 0 });
    expect(sinPedidos.emptiness).toBe("no_orders_in_period");

    expect(buildCommunityStats(raw).emptiness).toBeNull();
  });

  it("RF_29: el markup que se comio el piso de zona se cuenta y no se esconde", () => {
    expect(buildCommunityStats(raw).totals.ordersWithoutCashbackByZoneFloor).toBe(2);
  });
});

/**
 * T38 · El eje de fecha REAL, no solo el rotulo (RF_46).
 *
 * Hoy hay dos sitios que deciden por que fecha se agrupa cada cifra y NO estan atados:
 *
 *   1. El rotulo: `dateAxisLabel(axis)` en `community-stats-math.ts`, que el panel del lider
 *      pinta en `operations-app.tsx` (~lineas 4388-4398).
 *   2. La consulta: el helper `onAxis(field)` de `community-stats.ts` (~51-66) y, aparte, el
 *      agregado de cashback sobre `walletEntries` (~88-89).
 *
 * Solo el rotulo esta probado. Nada impide cambiar el campo de la consulta y dejar el rotulo
 * diciendo otra cosa, y en esta plataforma mezclar ejes de fecha YA desvio cifras. T38 hace que
 * las dos mitades salgan de la misma funcion para que no puedan divergir.
 *
 * LA TRAMPA, que es exactamente el bug que esto previene: el eje del cashback es el de CIERRE,
 * pero el campo que se consulta es `walletEntries.createdAt` — el asiento nace al cerrar el
 * pedido, asi que su fecha de creacion ES el instante de cierre. Si el eje se modelara como
 * "nombre de campo", "cierre" se traduciria a `closedAt`, que en `walletEntries` NO EXISTE: la
 * consulta se rompe (o, peor, devuelve cero en silencio). Por eso el eje tiene que ser
 * SEMANTICO y el campo derivarse de el SEGUN LA COLECCION.
 *
 * Contrato que se exige aqui:
 *   - `COMMUNITY_METRICS: readonly CommunityMetric[]` — las cinco cifras del panel.
 *   - `axisForMetric(metric): DateAxis` — el eje semantico ("created" | "dispatched" | "closed").
 *   - `metricDateSource(metric): { axis, collection, field, label }` — lo que la consulta usa Y
 *     lo que la pantalla rotula, de una sola pieza.
 *   - `dateAxisLabel(axis)` NO cambia de firma: la UI ya la llama.
 */

/**
 * Importados como TIPO a proposito: `import type` se borra al transpilar, asi que mientras el
 * contrato no exista no carga nada ni tumba la recoleccion del archivo. Los VALORES entran por
 * import dinamico dentro del describe, por la misma razon que el bloque T29 de
 * `community-signup.test.ts`: un import estatico inexistente se llevaria por delante los siete
 * casos de T20, que no tienen nada que ver con esto.
 */
import type { CommunityMetric, DateAxis, MetricDateSource } from "../../functions/src/community-stats-math";

let COMMUNITY_METRICS: readonly CommunityMetric[];
let axisForMetric: (metric: CommunityMetric) => DateAxis;
let metricDateSource: (metric: CommunityMetric) => MetricDateSource;

/**
 * La tabla de la verdad de RF_46, escrita como `Record<CommunityMetric, ...>` A PROPOSITO: si
 * manana se anade una metrica al panel (devoluciones, reprogramados…) y no se decide su eje,
 * este literal deja de ser exhaustivo y `tsc --noEmit` lo canta antes de que nadie despliegue.
 * El chequeo en tiempo de ejecucion contra `COMMUNITY_METRICS` cubre el otro lado: una metrica
 * declarada en el modulo pero ausente de esta tabla.
 */
const FUENTE_ESPERADA: Record<
  CommunityMetric,
  { axis: DateAxis; collection: MetricDateSource["collection"]; field: string }
> = {
  created: { axis: "created", collection: "orders", field: "createdAt" },
  dispatched: { axis: "dispatched", collection: "orders", field: "pickedUpAt" },
  delivered: { axis: "closed", collection: "orders", field: "closedAt" },
  failed: { axis: "closed", collection: "orders", field: "closedAt" },
  // El unico que no vive en `orders`. Ver "LA TRAMPA" arriba.
  cashback: { axis: "closed", collection: "walletEntries", field: "createdAt" }
};

const METRICAS_ESPERADAS = Object.keys(FUENTE_ESPERADA).sort();

describe("T38 · el eje de fecha que se consulta, no el que se rotula", () => {
  // Dentro del describe y con `beforeEach` (no `beforeAll`, no raiz del archivo) para que,
  // mientras el contrato no exista, estos casos salgan FALLIDOS uno a uno sin manchar los
  // siete de T20. Un caso omitido no se distingue de un caso que nadie escribio.
  beforeEach(async () => {
    const modulo = await import("../../functions/src/community-stats-math");
    COMMUNITY_METRICS = modulo.COMMUNITY_METRICS;
    axisForMetric = modulo.axisForMetric;
    metricDateSource = modulo.metricDateSource;
  });

  it("RF_46: los pedidos creados se agrupan por el eje de creacion, que es orders.createdAt", () => {
    expect(axisForMetric("created")).toBe("created");
    expect(metricDateSource("created")).toMatchObject({
      axis: "created",
      collection: "orders",
      field: "createdAt"
    });
  });

  it("RF_46: los despachados se agrupan por el eje de despacho, que es orders.pickedUpAt", () => {
    expect(axisForMetric("dispatched")).toBe("dispatched");
    expect(metricDateSource("dispatched")).toMatchObject({
      axis: "dispatched",
      collection: "orders",
      field: "pickedUpAt"
    });
  });

  it("RF_46: entregados y fallidos comparten el eje de cierre, que es orders.closedAt", () => {
    for (const metric of ["delivered", "failed"] as const) {
      expect(axisForMetric(metric)).toBe("closed");
      expect(metricDateSource(metric)).toMatchObject({
        axis: "closed",
        collection: "orders",
        field: "closedAt"
      });
    }
  });

  it("RF_46: el cashback va por el eje de CIERRE pero se consulta por walletEntries.createdAt", () => {
    // El asiento de cashback nace al cerrar el pedido: su `createdAt` ES el instante de cierre.
    // Semanticamente, por tanto, el eje es "closed" — el mismo que entregados y fallidos, y por
    // eso rotula igual. Pero el CAMPO es otro, porque la coleccion es otra: `walletEntries` no
    // tiene `closedAt`. Traducir el eje a un nombre de campo sin mirar la coleccion es
    // exactamente el fallo que T38 previene: la consulta filtraria por un campo inexistente.
    const fuente = metricDateSource("cashback");
    expect(axisForMetric("cashback")).toBe("closed");
    expect(fuente.axis).toBe("closed");
    expect(fuente.collection).toBe("walletEntries");
    expect(fuente.field).toBe("createdAt");
    expect(fuente.field).not.toBe("closedAt");
  });

  it("RF_46: mismo eje y mismo rotulo que los entregados, pero campo y coleccion distintos", () => {
    // El corolario de la trampa, aislado: dos metricas del MISMO eje no tienen por que
    // consultarse por el mismo campo. Si alguien "simplifica" haciendo campo == eje, o iguala
    // los dos campos, esto se pone rojo.
    const entregados = metricDateSource("delivered");
    const cashback = metricDateSource("cashback");
    expect(cashback.axis).toBe(entregados.axis);
    expect(cashback.label).toBe(entregados.label);
    expect(cashback.collection).not.toBe(entregados.collection);
    expect(cashback.field).not.toBe(entregados.field);
  });

  it("RF_46: el rotulo de cada metrica sale del mismo eje que se consulta, en las cinco", () => {
    // ESTA es la razon de ser de T38: ata las dos mitades. Si alguien cambia el campo de la
    // consulta sin tocar el rotulo (o al reves), aqui revienta.
    for (const metric of COMMUNITY_METRICS) {
      const fuente = metricDateSource(metric);
      expect(fuente.axis).toBe(axisForMetric(metric));
      expect(fuente.label).toBe(dateAxisLabel(fuente.axis));
      expect(fuente.label).toBe(dateAxisLabel(axisForMetric(metric)));
    }
    // Y el rotulo dice de verdad lo que la consulta hace, palabra por palabra.
    expect(metricDateSource("created").label).toBe("por fecha de creacion");
    expect(metricDateSource("dispatched").label).toBe("por fecha de despacho");
    expect(metricDateSource("delivered").label).toBe("por fecha de cierre");
    expect(metricDateSource("failed").label).toBe("por fecha de cierre");
    expect(metricDateSource("cashback").label).toBe("por fecha de cierre");
  });

  it("RF_46: el eje es semantico y nunca un nombre de campo", () => {
    // Si un dia `axisForMetric` devolviera "closedAt" en vez de "closed", el rotulo se rompe y
    // el campo del cashback se rompe con el. El eje no puede parecerse a una columna.
    for (const metric of COMMUNITY_METRICS) {
      const axis = axisForMetric(metric);
      expect(["created", "dispatched", "closed"]).toContain(axis);
      expect(axis).not.toMatch(/At$/);
      expect(dateAxisLabel(axis)).toMatch(/^por fecha de /);
    }
  });

  it("RF_46: cada metrica declara su fuente y ninguna se queda sin eje", () => {
    // Exhaustividad en tiempo de ejecucion: el modulo no puede declarar una metrica que esta
    // tabla no contemple, ni esta tabla una que el modulo no conozca.
    expect([...COMMUNITY_METRICS].sort()).toEqual(METRICAS_ESPERADAS);
    for (const metric of COMMUNITY_METRICS) {
      const esperada = FUENTE_ESPERADA[metric];
      expect(esperada).toBeDefined();
      const fuente = metricDateSource(metric);
      expect(fuente.axis).toBe(esperada.axis);
      expect(fuente.collection).toBe(esperada.collection);
      expect(fuente.field).toBe(esperada.field);
      expect(fuente.field.length).toBeGreaterThan(0);
    }
  });

  it("RF_46: solo el cashback sale de walletEntries; los contadores salen de orders", () => {
    // El reparto de fuentes que documenta la cabecera de `community-stats.ts` no es un detalle:
    // contar entregas sobre asientos pierde las de cashback cero y duplica las reversas.
    const porColeccion = COMMUNITY_METRICS.filter((metric) => metricDateSource(metric).collection === "walletEntries");
    expect(porColeccion).toEqual(["cashback"]);
  });

  it("RF_46: los ejes que publica buildCommunityStats son los que decide axisForMetric", () => {
    // `stats.axes` es lo que viaja al cliente. Si se deja a mano, puede contradecir la consulta:
    // tiene que salir de la misma funcion.
    const axes = buildCommunityStats(raw).axes;
    expect(Object.keys(axes).sort()).toEqual(METRICAS_ESPERADAS);
    for (const metric of COMMUNITY_METRICS) {
      expect(axes[metric]).toBe(axisForMetric(metric));
    }
  });

  it("RF_46: dateAxisLabel sigue respondiendo a los tres ejes tal cual la llama el panel", () => {
    // No-regresion de la UI: `operations-app.tsx` (~4388-4398) invoca `dateAxisLabel("created")`,
    // `("dispatched")` y `("closed")` directamente. T38 no puede cambiarle la firma.
    expect(dateAxisLabel("created")).toBe("por fecha de creacion");
    expect(dateAxisLabel("dispatched")).toBe("por fecha de despacho");
    expect(dateAxisLabel("closed")).toBe("por fecha de cierre");
  });
});
