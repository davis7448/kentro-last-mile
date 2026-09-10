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
  axes: Record<string, DateAxis>;
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
    axes: { created: "created", dispatched: "dispatched", delivered: "closed", failed: "closed", cashback: "closed" },
    emptiness
  };
}
