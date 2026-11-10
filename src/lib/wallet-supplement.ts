/**
 * Spec 023, fase B: las pantallas de dinero del admin ya no tienen el libro de caja entero en `state.wallet`.
 * Tienen lo SIN liquidar en vivo (la suscripcion) y piden lo historico que necesitan. Este modulo es la parte
 * pura de eso: como se unen las dos fuentes y que hay que pedir para cada pantalla. Sin React ni Firestore,
 * para poder probarlo.
 *
 * La regla que sostiene todo: **lo que esta pendiente sale SOLO de lo vivo**. Un asiento leido bajo demanda
 * puede quedarse viejo (se liquido despues de leerlo), y si se mezclara con lo pendiente apareceria como
 * "por pagar" algo ya pagado. Por eso:
 *  - al unir, la copia viva gana siempre (`mergePreferringLive`);
 *  - lo leido bajo demanda solo alimenta sumas POR PEDIDO o POR CORTE, que no dependen de si el asiento esta
 *    liquidado (cuanto COD tuvo un pedido, cuanto se le pago al domiciliario por el);
 *  - lo que solo importa por EXISTIR (el cobro de manejo de un pedido de bodega) se marca como cobrado, igual
 *    que hace el servidor en `seller-balance-api.ts` (`asChargedOutsideLive`).
 */
import type { Settlement, WalletEntry } from "./types";

export type SupplementStatus = "loading" | "ready" | "failed";

/** Union por id; si un asiento esta en las dos, gana la copia viva. */
export function mergePreferringLive(live: readonly WalletEntry[], ...extras: ReadonlyArray<readonly WalletEntry[]>): WalletEntry[] {
  const merged = new Map<string, WalletEntry>();
  for (const group of extras) for (const entry of group) merged.set(entry.id, entry);
  for (const entry of live) merged.set(entry.id, entry);
  return [...merged.values()];
}

/**
 * Asientos leidos bajo demanda que NO estan entre los vivos: si no estan vivos es que ya no estan sin
 * liquidar, asi que se marcan como liquidados para que ninguna cuenta de "pendiente" los cuente. Mismo
 * criterio que el servidor con los cobros de manejo (`settlementId: "charged"`).
 */
export function asChargedOutsideLive(live: readonly WalletEntry[], fetched: readonly WalletEntry[]): WalletEntry[] {
  const liveIds = new Set(live.map((entry) => entry.id));
  return fetched.filter((entry) => !liveIds.has(entry.id)).map((entry) => (entry.settlementId ? entry : { ...entry, settlementId: "charged" }));
}

/** Pedidos de los asientos de domiciliario sin liquidar: sus filas de "Domiciliarios por cortar" necesitan los asientos de tienda de esos pedidos, liquidados o no. */
export function driverPendingOrderIds(live: readonly WalletEntry[]): string[] {
  return [...new Set(live.filter((entry) => entry.ownerType === "driver" && !entry.settlementId && entry.orderId).map((entry) => String(entry.orderId)))].sort();
}

/**
 * Lo que hay que leer para pintar unos cortes cerrados: todos los asientos de sus pedidos (de cualquier dueno),
 * y por id solo los asientos del corte que NO son de uno de esos pedidos (abonos, 4x1000, pagos). Los asientos
 * de un pedido se llaman `we-{orderId}-...`, asi que ya vienen con la lectura por pedido y pedirlos tambien por
 * id costaria el doble. Un corte viejo sin `orderIds` pide todos sus asientos por id (y sus pedidos se sacan
 * de ellos).
 */
export function settlementSupplementIds(settlements: readonly Settlement[]): { entryIds: string[]; orderIds: string[] } {
  const entryIds = new Set<string>();
  const orderIds = new Set<string>();
  for (const settlement of settlements) {
    const own = (settlement.orderIds ?? []).filter(Boolean);
    for (const id of own) orderIds.add(id);
    const prefixes = own.map((orderId) => `we-${orderId}-`);
    for (const id of settlement.walletEntryIds ?? []) {
      if (id && !prefixes.some((prefix) => id.startsWith(prefix))) entryIds.add(id);
    }
  }
  return { entryIds: [...entryIds].sort(), orderIds: [...orderIds].sort() };
}

/** Pedidos que nombran unos asientos (para cortes viejos sin `orderIds`). */
export function orderIdsOfEntries(entries: readonly WalletEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.orderId).filter(Boolean) as string[])].sort();
}

/**
 * Firma de los cortes: cuando cambia (se cierra, se paga o se corrige uno), lo leido bajo demanda puede haber
 * cambiado y se vuelve a pedir.
 */
export function settlementsSignature(settlements: readonly Settlement[]): string {
  return settlements
    .map((settlement) => `${settlement.id}:${settlement.status}:${(settlement as { updatedAt?: string }).updatedAt ?? ""}:${settlement.walletEntryIds?.length ?? 0}`)
    .sort()
    .join("|");
}

/** El estado conjunto de varias lecturas: lista solo si todas lo estan; fallida si alguna fallo. */
export function combineStatus(...statuses: SupplementStatus[]): SupplementStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("loading")) return "loading";
  return "ready";
}
