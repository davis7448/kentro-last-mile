/**
 * Spec 028: que tiene que escribir el autoguardado del admin, dado lo ultimo que llego del servidor y el
 * estado actual. Puro (sin Firestore ni React) para poder probarlo sin navegador.
 *
 * Por que existe: el autoguardado escribia `settings/global` con las tarifas de FABRICA al entrar, antes
 * de recibir nada del servidor. Ademas reescribia `settings` entero ante cualquier cambio local, porque se
 * comparaba por referencia un objeto que `withoutLegacyDemo` rehace en cada emision. Medido el 2026-11-10:
 * 4 pagos de 9.000 al domiciliario en vez de 8.000, cada uno en un hueco entre dos de esas escrituras.
 */
import type { AppState } from "./types";

// Colecciones que el autoguardado del admin persiste, en orden de escritura. `payouts` NO esta: los
// gestiona el servidor (requestSellerPayout, rejectSellerPayout, createSettlement), y reescribirlos desde el
// estado del admin pisaria una solicitud creada entre la carga y el guardado.
export const AUTOSAVED_COLLECTIONS = [
  "cities",
  "zones",
  "sellers",
  "shopifyStores",
  "storeWebhookConfigs",
  "shopifyInstallRequests",
  "drivers",
  "messengers",
  "pickupBatches",
  "suppliers",
  "productCatalog",
  "inventory"
] as const;

export type AutosavedCollection = (typeof AUTOSAVED_COLLECTIONS)[number];

/** Lo ultimo que llego del servidor, con las mismas referencias que entrego la suscripcion. */
export type AutosaveBaseline = Pick<AppState, AutosavedCollection | "settings">;

export type AutosavePlan = {
  /** Solo los campos de `settings` que cambiaron. `null` si no hay que tocar `settings/global`. */
  settings: Partial<AppState["settings"]> | null;
  /** Por coleccion, solo las entidades nuevas o cambiadas. Las colecciones sin cambios no aparecen. */
  entities: Array<{ collection: AutosavedCollection; items: Array<{ id: string }> }>;
  /** Total de escrituras del lote (para el tope de 500 de `writeBatch`). */
  writeCount: number;
};

const EMPTY_PLAN: AutosavePlan = { settings: null, entities: [], writeCount: 0 };

/** `updatedAt` lo pone el servidor con `serverTimestamp()`: no es un ajuste del admin. */
const IGNORED_SETTINGS_FIELDS = new Set(["updatedAt"]);

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function planAutosave(baseline: AutosaveBaseline | null, state: AutosaveBaseline): AutosavePlan {
  // Sin nada del servidor no hay contra que comparar, y escribir "todo" es justo lo que sembraba las
  // tarifas de fabrica (RF_01, RF_03, RF_07, RF_08). Sin linea base no se escribe nada.
  if (!baseline) return EMPTY_PLAN;

  const settingsDiff: Record<string, unknown> = {};
  const current = state.settings as Record<string, unknown>;
  const previous = baseline.settings as Record<string, unknown>;
  for (const key of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    if (IGNORED_SETTINGS_FIELDS.has(key)) continue;
    // Un campo que el estado ya no trae no se borra: el autoguardado nunca borro, y una tarifa ausente en
    // memoria no significa que el admin la quiera quitar.
    if (!(key in current)) continue;
    if (!sameValue(current[key], previous[key])) settingsDiff[key] = current[key];
  }
  const settings = Object.keys(settingsDiff).length > 0 ? (settingsDiff as Partial<AppState["settings"]>) : null;

  const entities: AutosavePlan["entities"] = [];
  for (const collection of AUTOSAVED_COLLECTIONS) {
    const now = state[collection] as Array<{ id: string }>;
    const before = baseline[collection] as Array<{ id: string }> | undefined;
    if (now === before) continue;
    const previousById = new Map((before ?? []).map((item) => [item.id, item]));
    // Por referencia, entidad a entidad. Al editar una zona, el resto conserva su referencia, asi que solo
    // se escribe esa: antes se reescribian todas con lo que el navegador tuviera en memoria, que puede ser
    // anterior a un cambio hecho desde otra sesion.
    const items = now.filter((item) => previousById.get(item.id) !== item);
    if (items.length > 0) entities.push({ collection, items });
  }

  const writeCount = (settings ? 1 : 0) + entities.reduce((total, entry) => total + entry.items.length, 0);
  return writeCount === 0 ? EMPTY_PLAN : { settings, entities, writeCount };
}
