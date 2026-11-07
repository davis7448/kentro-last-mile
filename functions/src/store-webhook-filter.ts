/**
 * Spec 037: la unica regla del filtro de productos del webhook de tienda.
 *
 * Puro (sin firebase-admin): lo usan `store-webhook.ts` en el servidor y la pantalla de la
 * tienda y del admin, para que la frase que se muestra sea la del filtro que se aplica.
 *
 * Por que existe: hasta el 2026-11-06 toda conexion nueva heredaba el filtro "ADMA", pensado
 * para la comunidad ADMA. Infinito conecto su Shopify y se le descartaron 3.608 avisos
 * (153 pedidos de Cali) en un mes sin que la pantalla lo dijera. Desde esta spec una conexion
 * NUEVA acepta todo salvo que la tienda pida un filtro; las existentes no cambian.
 */

export const ALL_PRODUCTS = "*";
/** Valor que aplica una conexion antigua sin filtro guardado. No es el defecto de las nuevas. */
export const LEGACY_DEFAULT = "ADMA";
/** Dias que cuenta el aviso de descartados, incluido hoy. */
export const DISCARD_WINDOW_DAYS = 7;

export type ProductFilter = { skuContains: string; tagContains: string };
export type FilterMode = "all" | "sku";
export type FilterDiscards = Record<string, Record<string, true>>;

type StoredFilter = { skuContains?: unknown; tagContains?: unknown };

/** Ciudades que aplica el servidor cuando la conexion no guarda las suyas. */
export const DEFAULT_CITY_ALLOWLIST: readonly string[] = ["Cali", "Santiago de Cali"];

/**
 * Las ciudades que el webhook aplica de verdad: las guardadas si son una lista no vacia, si no Cali.
 * La usan el servidor y la frase de la pantalla, para que no puedan decir cosas distintas.
 */
export function effectiveCityAllowlist(value: unknown): string[] {
  return Array.isArray(value) && value.length > 0 ? value.map(String) : [...DEFAULT_CITY_ALLOWLIST];
}

/**
 * Si el documento de `storeWebhookConfigs` es una conexion de webhook ya hecha. Lo decide la clave, no
 * que exista el documento: `setStoreUchatConfig` crea ese mismo documento sin `webhookKey` al guardar el
 * token de ChatBy, y tratarlo como existente hacia nacer la conexion con el filtro antiguo (revision
 * adversarial ronda 1, R1-RF_01-1).
 */
export function hasWebhookConnection(doc: object | null | undefined): boolean {
  const key = (doc as { webhookKey?: unknown } | null | undefined)?.webhookKey;
  return typeof key === "string" && key.trim() !== "";
}

/** El `existing` que espera `resolveFilterOnSave`: el documento si ya era conexion, si no `null`. */
export function existingConnection(doc: object | null | undefined): StoredFilter | null {
  return doc && hasWebhookConnection(doc) ? (doc as StoredFilter) : null;
}

function normalizeInput(value: string): string {
  const trimmed = value.trim().toUpperCase();
  return trimmed || ALL_PRODUCTS;
}

function normalizeStored(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : LEGACY_DEFAULT;
}

/**
 * Que claves de filtro escribir al crear o regenerar una conexion. Un objeto sin claves significa
 * "no tocar": regenerar sin pedir un filtro conserva el que habia, incluida su ausencia (RF_02/RF_03).
 */
export function resolveFilterOnSave(args: {
  existing: StoredFilter | null;
  input: { filterMode?: FilterMode; skuContains?: string; tagContains?: string };
}): Partial<ProductFilter> {
  const { existing, input } = args;
  if (input.filterMode === "all") return { skuContains: ALL_PRODUCTS, tagContains: ALL_PRODUCTS };

  // Solo `filterMode` es un pedido de filtro. Los campos sueltos sin modo son el relleno ADMA que mandaba
  // la pantalla anterior al regenerar; una pestana vieja no puede volver a cerrar una conexion abierta
  // (revision adversarial ronda 2, R2-RF_02-1).
  const hasTag = typeof input.tagContains === "string";
  if (input.filterMode === "sku") {
    const sku = normalizeInput(input.skuContains ?? input.tagContains ?? "");
    const tag = hasTag ? normalizeInput(input.tagContains ?? "") : sku;
    // RF_09: si cualquiera de los dos queda vacio, la conexion acepta todo; se guarda sin ambiguedad.
    if (sku === ALL_PRODUCTS || tag === ALL_PRODUCTS) return { skuContains: ALL_PRODUCTS, tagContains: ALL_PRODUCTS };
    return { skuContains: sku, tagContains: tag };
  }

  if (existing === null) return { skuContains: ALL_PRODUCTS, tagContains: ALL_PRODUCTS };
  return {};
}

/** El filtro que el servidor aplica de verdad a una conexion guardada. */
export function effectiveFilter(config: StoredFilter): ProductFilter {
  return { skuContains: normalizeStored(config.skuContains), tagContains: normalizeStored(config.tagContains) };
}

/** Un pedido entra si cumple SKU o etiqueta: con uno de los dos en "*" entra todo. */
export function acceptsAllProducts(filter: ProductFilter): boolean {
  return filter.skuContains === ALL_PRODUCTS || filter.tagContains === ALL_PRODUCTS;
}

function uniqueCities(cities: string[]): string[] {
  const seen = new Map<string, string>();
  for (const city of cities) {
    const label = city.trim();
    if (!label) continue;
    // "Santiago de Cali" es Cali: no se nombra dos veces.
    const key = label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^santiago de /, "");
    if (!seen.has(key)) seen.set(key, label.replace(/^Santiago de /i, ""));
  }
  return [...seen.values()];
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "la ciudad cubierta";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** La frase que la pantalla muestra (RF_04, RF_06). */
export function describeFilter(filter: ProductFilter, cities: unknown): string {
  if (acceptsAllProducts(filter)) {
    return `Entran todos tus productos. Solo se descartan pedidos fuera de ${joinList(uniqueCities(effectiveCityAllowlist(cities)))}.`;
  }
  return `Solo entran pedidos con un producto cuyo SKU contenga ${filter.skuContains} o con la etiqueta ${filter.tagContains}. Los demas se descartan.`;
}

/** Como traer un pedido viejo segun el filtro (RF_08). */
export function syncInstruction(filter: ProductFilter): string {
  if (acceptsAllProducts(filter)) return "Para traer un pedido viejo, abrelo en Shopify y guardalo.";
  return `Para traer un pedido viejo, agrega la etiqueta ${filter.tagContains} en Shopify y guardalo.`;
}

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Dia calendario en Bogota (UTC-5 todo el ano, sin horario de verano). */
export function discardDayKey(now: Date): string {
  return new Date(now.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

function windowDays(now: Date): Set<string> {
  const days = new Set<string>();
  for (let offset = 0; offset < DISCARD_WINDOW_DAYS; offset += 1) days.add(discardDayKey(new Date(now.getTime() - offset * DAY_MS)));
  return days;
}

/** Pedidos distintos descartados por el filtro de productos en los ultimos 7 dias (RF_07). */
export function recentFilterDiscards(discards: FilterDiscards | undefined, now: Date): number {
  if (!discards) return 0;
  const days = windowDays(now);
  const orders = new Set<string>();
  for (const [day, ids] of Object.entries(discards)) {
    if (!days.has(day) || !ids || typeof ids !== "object") continue;
    for (const id of Object.keys(ids)) orders.add(id);
  }
  return orders.size;
}

/** Dias guardados que ya cayeron fuera de la ventana: el servidor los borra al escribir. */
export function staleDiscardDays(discards: FilterDiscards | undefined, now: Date): string[] {
  if (!discards) return [];
  const days = windowDays(now);
  return Object.keys(discards).filter((day) => DAY_KEY.test(day) && !days.has(day));
}
