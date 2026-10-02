/**
 * Spec 026 · esquemas de frontera de "efectivo que no llega a un corte" (RF_04, plan 2.8).
 *
 * Puro: sin firebase-admin. Lo usan el callable `getCashOutstanding`, el aviso programado y la pantalla
 * de ajustes, y se prueba sin emulador.
 *
 * Regla de lectura: lo ilegible se SEPARA por id (`unreadable*Ids`) en vez de tumbar el calculo o
 * sumarse como 0 en silencio. Excepcion deliberada: un corte sin `cashPendingCop` es legible, porque
 * `buildSettlement` los crea asi y la posicion de plataforma lo trata como 0.
 *
 * Toda escritura pasa por `stripUndefined` (el de `wallet-entries`, no una copia): Firestore rechaza el
 * documento entero si encuentra un `undefined`.
 */
import { z } from "zod";
import { stripUndefined } from "./wallet-entries";

// ---------------------------------------------------------------------------------------------------
// Entrada del callable
// ---------------------------------------------------------------------------------------------------

/** `{}` = modo resumen. `.strict()`: el alcance del lider sale del token, nunca de la entrada. */
export const cashOutstandingInputSchema = z
  .object({
    includeReconciliation: z.boolean().default(false)
  })
  .strict();

export type CashOutstandingInput = z.infer<typeof cashOutstandingInputSchema>;

// ---------------------------------------------------------------------------------------------------
// Ajustes de alerta (settings/cashAlerts)
// ---------------------------------------------------------------------------------------------------

export interface CashAlertSettings {
  overdueDays: number;
  notifyMinCop: number;
}

export const DEFAULT_CASH_ALERT_SETTINGS: Readonly<CashAlertSettings> = Object.freeze({
  overdueDays: 7,
  notifyMinCop: 20_000
});

export const cashAlertSettingsSchema = z
  .object({
    overdueDays: z.number().int().min(1).max(120).default(DEFAULT_CASH_ALERT_SETTINGS.overdueDays),
    notifyMinCop: z.number().int().finite().min(0).default(DEFAULT_CASH_ALERT_SETTINGS.notifyMinCop)
  })
  .strict();

/** Metadatos que la escritura anade al documento y que la lectura tolera y descarta. */
const STORED_METADATA_KEYS = ["updatedAt", "updatedBy"] as const;

export interface CashAlertSettingsRead {
  settings: CashAlertSettings;
  settingsInvalid: boolean;
}

function defaultSettings(): CashAlertSettings {
  return { overdueDays: DEFAULT_CASH_ALERT_SETTINGS.overdueDays, notifyMinCop: DEFAULT_CASH_ALERT_SETTINGS.notifyMinCop };
}

/**
 * Lee `settings/cashAlerts` sin lanzar nunca. Ausente → defectos. Ilegible → defectos y
 * `settingsInvalid: true`, para que la pantalla lo diga en vez de ocultarlo.
 */
export function readCashAlertSettings(raw: unknown): CashAlertSettingsRead {
  if (raw === undefined || raw === null) {
    return { settings: defaultSettings(), settingsInvalid: false };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: defaultSettings(), settingsInvalid: true };
  }
  const candidate: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of STORED_METADATA_KEYS) delete candidate[key];
  const parsed = cashAlertSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    return { settings: defaultSettings(), settingsInvalid: true };
  }
  return { settings: { overdueDays: parsed.data.overdueDays, notifyMinCop: parsed.data.notifyMinCop }, settingsInvalid: false };
}

// ---------------------------------------------------------------------------------------------------
// Documentos leidos de Firestore
// ---------------------------------------------------------------------------------------------------

const finiteNumber = z.number().finite();

export const cashOutstandingOrderSchema = z
  .object({
    id: z.string().min(1),
    trackingCode: z.string().optional(),
    sellerId: z.string().min(1),
    driverId: z.string().nullable().optional().transform((value) => value ?? null),
    messengerId: z.string().nullable().optional().transform((value) => value ?? null),
    status: z.string(),
    paymentMethod: z.string().optional(),
    totalCop: finiteNumber,
    closedAt: z.string().optional(),
    evidence: z.array(z.record(z.unknown())).optional().transform((value) => value ?? [])
  })
  .passthrough();

export type CashOutstandingOrder = z.infer<typeof cashOutstandingOrderSchema>;

/** Corte de domiciliario. Los campos de efectivo son opcionales: ausente = 0 para el pendiente. */
export const driverSettlementSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().optional(),
    ownerId: z.string().optional(),
    status: z.enum(["pending", "paid", "reconciled"]),
    orderIds: z.array(z.string()),
    createdAt: z.string().optional(),
    cashExpectedCop: finiteNumber.optional(),
    cashReceivedCop: finiteNumber.optional(),
    cashPendingCop: finiteNumber.optional()
  })
  .passthrough();

export type DriverSettlementRecord = z.infer<typeof driverSettlementSchema>;

export const cashWalletEntrySchema = z
  .object({
    id: z.string(),
    orderId: z.string().min(1),
    amountCop: finiteNumber
  })
  .passthrough();

export type CashWalletEntry = z.infer<typeof cashWalletEntrySchema>;

function itemId(item: unknown): string {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return "";
}

/** Separa legibles de ilegibles conservando el orden de entrada. */
function partitionByReadability<T>(items: readonly unknown[], schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  const readable: T[] = [];
  const unreadableIds: string[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) readable.push(parsed.data);
    else unreadableIds.push(itemId(item));
  }
  return { readable, unreadableIds };
}

export function parseCashOutstandingOrders(items: readonly unknown[]): { orders: CashOutstandingOrder[]; unreadableOrderIds: string[] } {
  const { readable, unreadableIds } = partitionByReadability(items, cashOutstandingOrderSchema);
  return { orders: readable, unreadableOrderIds: unreadableIds };
}

export function parseDriverSettlements(items: readonly unknown[]): { settlements: DriverSettlementRecord[]; unreadableSettlementIds: string[] } {
  const { readable, unreadableIds } = partitionByReadability(items, driverSettlementSchema);
  return { settlements: readable, unreadableSettlementIds: unreadableIds };
}

export function parseWalletEntries(items: readonly unknown[]): { entries: CashWalletEntry[]; unreadableEntryIds: string[] } {
  const { readable, unreadableIds } = partitionByReadability(items, cashWalletEntrySchema);
  return { entries: readable, unreadableEntryIds: unreadableIds };
}

// ---------------------------------------------------------------------------------------------------
// Constructores de escritura
// ---------------------------------------------------------------------------------------------------

export interface CashAlertSettingsDocInput {
  settings: CashAlertSettings;
  actorId: string | undefined;
  now: string;
}

export function buildCashAlertSettingsDoc(input: CashAlertSettingsDocInput) {
  return stripUndefined({
    overdueDays: input.settings.overdueDays,
    notifyMinCop: input.settings.notifyMinCop,
    updatedAt: input.now,
    updatedBy: input.actorId
  });
}

export interface CashAlertAuditDocInput {
  id: string;
  actorId: string | undefined;
  actorRole: string | undefined;
  previous: CashAlertSettings | null | undefined;
  next: CashAlertSettings;
  now: string;
}

function describeSettings(settings: CashAlertSettings): string {
  return `${settings.overdueDays} dias / $${settings.notifyMinCop.toLocaleString("es-CO")}`;
}

/** Evento de `auditEvents`. `before`/`after` son planos (copias), asi que el `stripUndefined` superficial basta. */
export function buildCashAlertAuditDoc(input: CashAlertAuditDocInput) {
  const before = input.previous ? { overdueDays: input.previous.overdueDays, notifyMinCop: input.previous.notifyMinCop } : null;
  const after = { overdueDays: input.next.overdueDays, notifyMinCop: input.next.notifyMinCop };
  const summary = before
    ? `Ajustes de alerta de efectivo: ${describeSettings(before)} -> ${describeSettings(after)}`
    : `Ajustes de alerta de efectivo: ${describeSettings(after)}`;
  return stripUndefined({
    id: input.id,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: "cash_alert_settings.updated",
    entity: "settings",
    entityId: "cashAlerts",
    summary,
    before,
    after,
    createdAt: input.now
  });
}

// ---------------------------------------------------------------------------------------------------
// Alcance por rol (RF_06, plan 2.7)
// ---------------------------------------------------------------------------------------------------

/** Mismo tipo que `CashOutstandingScope` del nucleo; se repite aqui para no importar el nucleo. */
export type CashOutstandingScope = { kind: "admin"; includeReconciliation: boolean } | { kind: "leader"; driverId: string };

export type CashOutstandingCoverage = "full" | "targeted";

/** Lo que trae `request.auth`, sin depender del SDK de functions. */
export type CashOutstandingAuth = { uid?: string; token?: Record<string, unknown> } | null | undefined;

export type CashOutstandingScopeResolution =
  | { ok: true; scope: CashOutstandingScope; coverage: CashOutstandingCoverage }
  | { ok: false; code: "permission-denied" | "invalid-argument"; message: string };

const SCOPE_DENIED = "Tu usuario no puede consultar el efectivo pendiente.";

/**
 * Decide el alcance de `getCashOutstanding` sin lanzar nunca (el callable traduce el codigo a
 * `HttpsError`). Primero el rol, despues la entrada: un rol sin permiso no se entera de si su entrada
 * era valida. El lider sale del claim `token.driverId`, nunca de `data` (el esquema es `.strict()`), y
 * siempre recibe el resumen: la conciliacion es solo del admin.
 */
export function resolveCashOutstandingScope(auth: CashOutstandingAuth, data: unknown): CashOutstandingScopeResolution {
  const token = auth && typeof auth.token === "object" && auth.token !== null ? auth.token : undefined;
  const role = token?.role;
  const driverClaim = token?.driverId;
  const isAdmin = role === "admin";
  const isLeader = role === "driver" && typeof driverClaim === "string" && driverClaim !== "";
  if (!isAdmin && !isLeader) {
    return { ok: false, code: "permission-denied", message: SCOPE_DENIED };
  }

  // Un httpsCallable sin argumentos manda null, y el esquema estricto rechaza null.
  const parsed = cashOutstandingInputSchema.safeParse(data === null || data === undefined ? {} : data);
  if (!parsed.success) {
    return { ok: false, code: "invalid-argument", message: "Entrada invalida: solo se admite includeReconciliation (si/no)." };
  }

  if (isAdmin) {
    const includeReconciliation = parsed.data.includeReconciliation;
    return {
      ok: true,
      scope: { kind: "admin", includeReconciliation },
      coverage: includeReconciliation ? "full" : "targeted"
    };
  }
  return { ok: true, scope: { kind: "leader", driverId: driverClaim as string }, coverage: "targeted" };
}
