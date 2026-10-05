/**
 * Spec 029 · T19 — modelo de vista de la clave de escritura de una tienda (RF_25, RF_26).
 *
 * Puro: sin React ni Firebase. Recibe lo que devuelven `getStoreApiKeyStatus` / `listStoreApiKeys` /
 * `rotateStoreWriteKey` y decide que se pinta. Los textos son los del README del diseno
 * (specs/design/029_store_api_confirma_y_corrige_pedidos/README.md, decisiones 2-7).
 *
 * Regla que este modulo garantiza: la key completa solo sale en el estado "fresh" (recien generada o rotada).
 * Fuera de el se pinta que existe, "termina en" + last4, la fecha de generacion y quien la genero; nunca la
 * key, ni enmascarada, ni su prefijo.
 */
import type { StoreApiKeyStatus } from "./types";

export const WRITE_KEY_LINE_LENGTH = 24;
export const ADMIN_KEYS_PAGE_SIZE = { desktop: 6, mobile: 4 } as const;

const FOOTER_TEXT = "Va solo en la cabecera Authorization: Bearer.";
const MANUAL_LINK_TEXT = "Manual completo: /api-tiendas";
const DESCRIPTION_TEXT =
  "Confirma, corrige y cancela pedidos que aun no tienen lider. Kentro solo guarda su huella: la veras completa una sola vez.";
const READ_ONLY_NOTE = "Solo la cuenta principal de la tienda o Kentro pueden generarla.";

// Meses propios y sin punto: `Intl` en es-CO devuelve "oct." y "sept.", y el diseno fija "6 oct 2026".
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
const BOGOTA_TIME_ZONE = "America/Bogota";

const bogotaParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BOGOTA_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

export type BogotaDateParts = { day: number; month: number; year: number; hour: string; minute: string };

/** Partes de una fecha ISO en hora de Bogota, o `null` si la fecha no se puede leer. */
export function bogotaDateParts(iso: string): BogotaDateParts | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(bogotaParts.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
    hour: String(parts.hour).padStart(2, "0"),
    minute: String(parts.minute).padStart(2, "0")
  };
}

/** "6 oct 2026" en hora de Bogota. Cadena vacia si la fecha no se puede leer. */
export function formatBogotaDate(iso: string): string {
  const parts = bogotaDateParts(iso);
  return parts ? `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}` : "";
}

/** "10:42" en hora de Bogota. */
export function formatBogotaTime(iso: string): string {
  const parts = bogotaDateParts(iso);
  return parts ? `${parts.hour}:${parts.minute}` : "";
}

/** "6 oct 2026, 10:42" en hora de Bogota. */
export function formatKeyDateTime(iso: string): string {
  const date = formatBogotaDate(iso);
  return date ? `${date}, ${formatBogotaTime(iso)}` : "";
}

/** La key completa en dos lineas de 24 (decision 4). */
export function splitWriteKey(writeKey: string): [string, string] {
  return [writeKey.slice(0, WRITE_KEY_LINE_LENGTH), writeKey.slice(WRITE_KEY_LINE_LENGTH)];
}

// ---------------------------------------------------------------------------------------------------
// Seccion de escritura (tienda y admin)
// ---------------------------------------------------------------------------------------------------

export type WriteKeyViewer = "admin" | "seller" | "seller_logistics";
export type WriteKeyActionId = "generate" | "rotate" | "copy" | "saved" | "retry";

export type WriteKeySectionInput = {
  viewer: WriteKeyViewer;
  /** `null` mientras se consulta. */
  status: StoreApiKeyStatus | null;
  /** Recien generada o rotada: la unica vez que la key va en claro. */
  fresh?: { writeKey: string; previousLast4: string | null } | null;
  error?: "generate" | "rotate" | null;
  copied?: boolean;
  /** Admin: quien la genero, para "Queda registrado que la generaste tu (...)". */
  actorName?: string;
};

export type WriteKeySectionView = {
  state: "loading" | "none" | "fresh" | "active" | "error";
  pill: { text: string; tone: "muted" | "acid" } | null;
  description: string | null;
  rows: { label: string; value: string }[];
  keyLines: [string, string] | null;
  alert: { title: string; lines: string[] } | null;
  mutedNote: string | null;
  copyStatus: string | null;
  actions: { id: WriteKeyActionId; label: string; disabled?: boolean }[];
  readOnlyNote: string | null;
  footer: string;
  manualLink: string;
};

type ActiveWrite = Extract<StoreApiKeyStatus["write"], { exists: true }>;

function activeWrite(status: StoreApiKeyStatus | null): ActiveWrite | null {
  return status?.write.exists ? status.write : null;
}

function statusPill(write: ActiveWrite | null): WriteKeySectionView["pill"] {
  return write ? { text: "Activa", tone: "acid" } : { text: "Sin clave de escritura", tone: "muted" };
}

// El servidor ya antepone "por" al texto que da al admin ("por la tienda", "por <nombre>"); el rotulo
// "Generada por" y la celda del panel lo ponen, asi que se quita aqui para no repetirlo.
function withoutLeadingPor(label: string): string {
  return label.startsWith("por ") ? label.slice(4) : label;
}

function activeRows(write: ActiveWrite | null): WriteKeySectionView["rows"] {
  if (!write) return [];
  return [
    { label: "Termina en", value: write.last4 },
    { label: "Generada", value: formatKeyDateTime(write.generatedAt) },
    { label: "Generada por", value: withoutLeadingPor(write.generatedByLabel) }
  ];
}

function freshAlertLines(input: WriteKeySectionInput, previousLast4: string | null): string[] {
  const isAdmin = input.viewer === "admin";
  const lines = [
    isAdmin
      ? "Es la unica vez que se muestra completa: Kentro guarda solo su huella. Entregala a la tienda por un canal seguro."
      : "Solo se muestra completa esta vez: Kentro guarda su huella, no la clave."
  ];
  if (previousLast4) lines.push(`La clave que terminaba en ${previousLast4} ya no funciona.`);
  if (isAdmin) {
    const write = activeWrite(input.status);
    const time = write ? formatBogotaTime(write.generatedAt) : "";
    const who = input.actorName ? `la generaste tu (${input.actorName})` : "la generaste tu";
    lines.push(`Queda registrado que ${who}${time ? `, hoy a las ${time}` : ""}.`);
    if (input.status) lines.push(`La clave de lectura de ${input.status.sellerName} no cambia.`);
  }
  return lines;
}

function errorAlert(kind: "generate" | "rotate", write: ActiveWrite | null): { title: string; lines: string[] } {
  if (kind === "generate") return { title: "No se pudo generar la clave", lines: ["No se creo ninguna."] };
  const lines = write ? [`La que termina en ${write.last4} sigue activa.`] : [];
  lines.push("No se genero ninguna clave nueva.");
  return { title: "No se pudo rotar la clave", lines };
}

export function buildWriteKeySectionView(input: WriteKeySectionInput): WriteKeySectionView {
  const { status, viewer } = input;
  const isLogistics = viewer === "seller_logistics";
  // Mientras se consulta solo se sabe el rol; con estado, manda lo que dice el servidor.
  const canManage = !isLogistics && (status ? status.canManageWrite : true);
  const write = activeWrite(status);

  const base: WriteKeySectionView = {
    state: "loading",
    pill: null,
    description: null,
    rows: [],
    keyLines: null,
    alert: null,
    mutedNote: null,
    copyStatus: null,
    actions: [],
    readOnlyNote: canManage ? null : READ_ONLY_NOTE,
    footer: FOOTER_TEXT,
    manualLink: MANUAL_LINK_TEXT
  };

  if (!status) {
    return { ...base, actions: canManage ? [{ id: "generate", label: "Consultando...", disabled: true }] : [] };
  }

  if (input.fresh && canManage) {
    return {
      ...base,
      state: "fresh",
      pill: statusPill(write),
      keyLines: splitWriteKey(input.fresh.writeKey),
      alert: { title: "Copiala ahora", lines: freshAlertLines(input, input.fresh.previousLast4) },
      mutedNote:
        viewer === "admin"
          ? "Si cierras sin copiarla, tendras que rotarla."
          : "Si sales sin copiarla, tendras que generar otra.",
      copyStatus: input.copied ? "Copiada" : null,
      actions: [
        { id: "copy", label: "Copiar clave de escritura" },
        { id: "saved", label: "Ya la guarde" }
      ]
    };
  }

  // Debajo del error se sigue viendo el estado real (decision 6).
  const real = {
    pill: statusPill(write),
    rows: activeRows(write),
    description: write ? null : DESCRIPTION_TEXT
  };

  if (input.error && canManage) {
    return {
      ...base,
      ...real,
      state: "error",
      alert: errorAlert(input.error, write),
      actions: [{ id: "retry", label: "Reintentar" }]
    };
  }

  if (write) {
    return {
      ...base,
      ...real,
      state: "active",
      actions: canManage ? [{ id: "rotate", label: "Rotar clave de escritura" }] : []
    };
  }

  return {
    ...base,
    ...real,
    state: "none",
    actions: canManage ? [{ id: "generate", label: "Generar clave de escritura" }] : []
  };
}

// ---------------------------------------------------------------------------------------------------
// Lista del admin (decision 2)
// ---------------------------------------------------------------------------------------------------

export type AdminKeysListOptions = { query: string; page: number; viewport: "desktop" | "mobile" };

export type AdminKeyRow = {
  sellerId: string;
  sellerName: string;
  readText: string;
  writeText: string;
  writeDetail: string | null;
  /** Fecha de generacion para la columna "Generada"; `null` sin clave. */
  generatedText: string | null;
  generatedBy: string | null;
  action: { id: "generate" | "rotate"; label: "Generar" | "Rotar"; accessibleName: string };
};

export type AdminKeysListView = {
  summary: string;
  rows: AdminKeyRow[];
  page: number;
  pageCount: number;
  rangeText: string;
  hasPrevious: boolean;
  hasNext: boolean;
};

/** Minusculas y sin tildes: "bélla" encuentra "Bella Mujer". */
function normalizeForSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function readText(read: StoreApiKeyStatus["read"]): string {
  if (!read.exists || read.status === "none") return "Sin clave";
  return read.status === "active" ? "Activa" : "Inactiva";
}

function adminRow(status: StoreApiKeyStatus): AdminKeyRow {
  const write = activeWrite(status);
  const action: AdminKeyRow["action"] = write
    ? { id: "rotate", label: "Rotar", accessibleName: `Rotar clave de escritura de ${status.sellerName}` }
    : { id: "generate", label: "Generar", accessibleName: `Generar clave de escritura de ${status.sellerName}` };
  return {
    sellerId: status.sellerId,
    sellerName: status.sellerName,
    readText: readText(status.read),
    writeText: write ? "Activa" : "Sin clave",
    writeDetail: write ? `termina en ${write.last4}` : null,
    generatedText: write ? formatKeyDateTime(write.generatedAt) : null,
    generatedBy: write ? withoutLeadingPor(write.generatedByLabel) : null,
    action
  };
}

export function buildAdminKeysListView(statuses: StoreApiKeyStatus[], options: AdminKeysListOptions): AdminKeysListView {
  const withWrite = statuses.filter((status) => status.write.exists).length;
  const query = normalizeForSearch(options.query);
  const filtered = query ? statuses.filter((status) => normalizeForSearch(status.sellerName).includes(query)) : statuses;

  const pageSize = ADMIN_KEYS_PAGE_SIZE[options.viewport];
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requested = Number.isFinite(options.page) ? Math.trunc(options.page) : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const start = (page - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  return {
    summary: `${withWrite} de ${statuses.length} tiendas con clave de escritura`,
    rows: pageItems.map(adminRow),
    page,
    pageCount,
    rangeText:
      filtered.length === 0
        ? `Tiendas 0 de 0`
        : `Tiendas ${start + 1} a ${start + pageItems.length} de ${filtered.length}`,
    hasPrevious: page > 1,
    hasNext: page < pageCount
  };
}
