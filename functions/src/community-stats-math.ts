/**
 * Aritmetica del panel del lider de comunidad. SIN acceso a Firestore.
 *
 * El callable (`community-stats.ts`) solo hace `count()` y `sum()` y le pasa los numeros a
 * este modulo. Se separan por la misma razon que `settlement-math` de `orders`: la raiz del
 * repo no instala firebase-admin, asi que lo que importe firebase-admin no se puede probar.
 *
 * Los tres ejes de fecha NO son intercambiables y por eso viajan rotulados: los pedidos
 * creados se agrupan por su fecha de creacion, los despachados por la de despacho y los
 * cerrados —con el cashback— por la de cierre. Mezclarlos en silencio ya ha desviado cifras
 * en esta plataforma; el rotulo es lo que impide que vuelva a pasar sin que nadie lo note.
 */

export type DateAxis = "created" | "dispatched" | "closed";

export function dateAxisLabel(axis: DateAxis): string {
  switch (axis) {
    case "created":
      return "por fecha de creacion";
    case "dispatched":
      return "por fecha de despacho";
    case "closed":
      return "por fecha de cierre";
  }
}

/** Las cifras que pinta el panel del lider. Cada una declara su eje aqui y en ningun otro sitio. */
export type CommunityMetric = "created" | "dispatched" | "delivered" | "failed" | "cashback";

export type MetricDateSource = {
  /** Eje SEMANTICO, nunca un nombre de columna. Es lo que se rotula. */
  axis: DateAxis;
  collection: "orders" | "walletEntries";
  /** Campo por el que filtra la consulta. Se DERIVA de (eje, coleccion). */
  field: string;
  /** Siempre `dateAxisLabel(axis)`: el rotulo no puede ser un string paralelo. */
  label: string;
};

/**
 * De donde sale cada metrica. Solo eje y coleccion: el campo NO se escribe a mano, se deriva.
 *
 * El cashback es el caso que justifica todo esto. Su eje es el de CIERRE —el asiento nace
 * cuando se cierra el pedido, asi que rotula igual que entregados y fallidos— pero se consulta
 * sobre `walletEntries`, que no tiene `closedAt`: el campo es `createdAt`. Traducir el eje a un
 * nombre de campo sin mirar la coleccion filtraria por un campo inexistente y el causado saldria
 * cero, en silencio y sin error.
 */
const METRIC_SOURCES: Record<CommunityMetric, Pick<MetricDateSource, "axis" | "collection">> = {
  created: { axis: "created", collection: "orders" },
  dispatched: { axis: "dispatched", collection: "orders" },
  delivered: { axis: "closed", collection: "orders" },
  failed: { axis: "closed", collection: "orders" },
  cashback: { axis: "closed", collection: "walletEntries" }
};

export const COMMUNITY_METRICS: readonly CommunityMetric[] = Object.keys(METRIC_SOURCES) as CommunityMetric[];

/** El campo depende de la coleccion, no solo del eje. Ver el comentario de `METRIC_SOURCES`. */
function dateFieldFor(axis: DateAxis, collection: MetricDateSource["collection"]): string {
  if (collection === "walletEntries") return "createdAt";
  switch (axis) {
    case "created":
      return "createdAt";
    case "dispatched":
      return "pickedUpAt";
    case "closed":
      return "closedAt";
  }
}

export function axisForMetric(metric: CommunityMetric): DateAxis {
  return METRIC_SOURCES[metric].axis;
}

export function metricDateSource(metric: CommunityMetric): MetricDateSource {
  const { axis, collection } = METRIC_SOURCES[metric];
  return { axis, collection, field: dateFieldFor(axis, collection), label: dateAxisLabel(axis) };
}

export type RawCommunityAggregates = {
  /** Tiendas adscritas a la comunidad, tengan o no pedidos en el periodo. */
  storeCount: number;
  createdByStore: Record<string, number>;
  dispatchedByStore: Record<string, number>;
  deliveredByStore: Record<string, number>;
  failedByStore: Record<string, number>;
  cashbackAccruedCop: number;
  cashbackPaidCop: number;
  /** Pedidos en los que la tarifa de zona supero el precio del lider y el margen quedo en cero. */
  ordersWithoutCashbackByZoneFloor?: number;
};

export type DeliveryRate = { percent: number | null; denominator: number };

/**
 * Entregados sobre CERRADOS, nunca sobre creados: un pedido aun abierto no ha fallado, y
 * meterlo en el denominador hunde el porcentaje sin motivo. Sin cerrados no hay porcentaje
 * que dar, y devolver 0 seria mentir: se devuelve null.
 */
export function deliveryRate(counts: { delivered: number; failed: number }): DeliveryRate {
  const denominator = counts.delivered + counts.failed;
  if (denominator <= 0) return { percent: null, denominator: 0 };
  return { percent: (counts.delivered / denominator) * 100, denominator };
}

/** RF_47: activa = con al menos un pedido creado en el periodo consultado. */
export function splitActiveStores(createdByStore: Record<string, number>): {
  active: string[];
  inactive: string[];
} {
  const active: string[] = [];
  const inactive: string[] = [];
  for (const sellerId of Object.keys(createdByStore).sort()) {
    if ((createdByStore[sellerId] ?? 0) > 0) active.push(sellerId);
    else inactive.push(sellerId);
  }
  return { active, inactive };
}

export type CommunityStoreStats = {
  sellerId: string;
  created: number;
  dispatched: number;
  delivered: number;
  failed: number;
  deliveryRate: DeliveryRate;
};

export type CommunityStats = {
  totals: {
    created: number;
    dispatched: number;
    delivered: number;
    failed: number;
    deliveryRate: DeliveryRate;
    activeStores: number;
    inactiveStores: number;
    cashbackAccruedCop: number;
    cashbackPaidCop: number;
    cashbackPendingCop: number;
    ordersWithoutCashbackByZoneFloor: number;
  };
  byStore: CommunityStoreStats[];
  axes: Record<CommunityMetric, DateAxis>;
  /**
   * Por que esta vacio esto. `null` significa que hay datos de verdad; el resto distingue
   * "todavia no tienes tiendas" de "tus tiendas no movieron nada en este periodo". Un cero
   * sin explicacion hace que el lider crea que la plataforma esta rota.
   */
  emptiness: "no_stores" | "no_orders_in_period" | null;
};

const sum = (record: Record<string, number>) => Object.values(record).reduce((total, value) => total + (value || 0), 0);

export function buildCommunityStats(raw: RawCommunityAggregates): CommunityStats {
  const sellerIds = Array.from(
    new Set([
      ...Object.keys(raw.createdByStore),
      ...Object.keys(raw.dispatchedByStore),
      ...Object.keys(raw.deliveredByStore),
      ...Object.keys(raw.failedByStore)
    ])
  ).sort();

  const byStore: CommunityStoreStats[] = sellerIds.map((sellerId) => {
    const delivered = raw.deliveredByStore[sellerId] ?? 0;
    const failed = raw.failedByStore[sellerId] ?? 0;
    return {
      sellerId,
      created: raw.createdByStore[sellerId] ?? 0,
      dispatched: raw.dispatchedByStore[sellerId] ?? 0,
      delivered,
      failed,
      deliveryRate: deliveryRate({ delivered, failed })
    };
  });

  const { active, inactive } = splitActiveStores(
    Object.fromEntries(sellerIds.map((sellerId) => [sellerId, raw.createdByStore[sellerId] ?? 0]))
  );
  const created = sum(raw.createdByStore);
  const delivered = sum(raw.deliveredByStore);
  const failed = sum(raw.failedByStore);

  const emptiness = raw.storeCount === 0 ? "no_stores" : created === 0 ? "no_orders_in_period" : null;

  return {
    totals: {
      created,
      dispatched: sum(raw.dispatchedByStore),
      delivered,
      failed,
      deliveryRate: deliveryRate({ delivered, failed }),
      activeStores: active.length,
      inactiveStores: raw.storeCount - active.length >= 0 ? raw.storeCount - active.length : inactive.length,
      cashbackAccruedCop: raw.cashbackAccruedCop,
      cashbackPaidCop: raw.cashbackPaidCop,
      cashbackPendingCop: raw.cashbackAccruedCop - raw.cashbackPaidCop,
      ordersWithoutCashbackByZoneFloor: raw.ordersWithoutCashbackByZoneFloor ?? 0
    },
    byStore,
    // Derivado, no escrito a mano: lo que viaja al cliente es lo mismo que decide la consulta.
    axes: Object.fromEntries(COMMUNITY_METRICS.map((metric) => [metric, axisForMetric(metric)])) as Record<
      CommunityMetric,
      DateAxis
    >,
    emptiness
  };
}
