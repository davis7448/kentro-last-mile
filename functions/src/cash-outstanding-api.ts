/**
 * Spec 026 · T12 — callable `getCashOutstanding` y su cargador (RF_06, RF_07, RNF_01, RNF_02; plan 2.1,
 * 2.7, 4.3).
 *
 * Este archivo solo LEE y delega:
 *  - el alcance lo decide `resolveCashOutstandingScope` (puro, en `cash-outstanding-schemas.ts`);
 *  - lo leido pasa por los parsers Zod, que separan lo ilegible por id en vez de sumarlo como 0;
 *  - el informe lo calcula `buildCashOutstandingReport` (puro, en `cash-outstanding.ts`).
 *
 * Las consultas son EXACTAMENTE las que `query-check` (scripts/verify-026.js, `loadLikeTheLoader`)
 * ejecuto y cronometro contra produccion; la guarda de T12 compara las formas en ambos sentidos. Sin
 * ventana de fecha ni `limit` (RF_07): una contraentrega vieja sin llegar es justo lo que se busca.
 *
 * Dos coberturas (plan 2.1):
 *  - resumen (`targeted`): asientos de los pedidos no recibidos, por `orderId in` en lotes de 30.
 *  - con conciliacion (`full`, solo admin): los asientos por cobrar enteros, porque la conciliacion
 *    con la posicion de plataforma los necesita todos.
 *
 * La url del canal de aviso nunca sale de aqui: solo se informa si hay canal (`channelConfigured`).
 */
import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { buildCashOutstandingReport, type CashOutstandingInput, type CashOutstandingOrder } from "./cash-outstanding";
import {
  buildCashAlertAuditDoc,
  buildCashAlertSettingsDoc,
  cashAlertSettingsSchema,
  parseCashOutstandingOrders,
  parseDriverSettlements,
  parseWalletEntries,
  readCashAlertSettings,
  resolveCashOutstandingScope,
  type CashAlertSettings,
  type CashOutstandingAuth,
  type CashOutstandingCoverage,
  type CashOutstandingOrder as ParsedCashOutstandingOrder,
  type CashOutstandingScope
} from "./cash-outstanding-schemas";
import {
  buildNoticeDocs,
  buildRunDoc,
  composeOverdueNotice,
  selectNoticeCandidates,
  type CashOverdueNoticeDoc,
  type CashOverdueRunDoc,
  type NoticeReportInput
} from "./cash-overdue-notice";
import { isReceivableCodEntry, isReceivableDriverPay } from "./driver-receivable";
import { isOpsChannelConfigured, sendOpsNotice, type OpsNoticeResult } from "./ops-notify";
import { buildCodReceivedSet } from "./seller-ledger";
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";

const opsNoticeWebhookUrl = defineSecret("OPS_NOTICE_WEBHOOK_URL");

/** Limite de valores de un `in` de Firestore; el mismo lote que midio query-check. */
const ORDER_ID_IN_BATCH = 30;

/** Los mismos campos que `QC_ORDER_FIELDS` de query-check: lo que el nucleo necesita del pedido. */
const ORDER_FIELDS = [
  "trackingCode",
  "sellerId",
  "driverId",
  "messengerId",
  "status",
  "paymentMethod",
  "totalCop",
  "closedAt",
  "updatedAt",
  "createdAt",
  "evidence"
];

type RawDoc = { id: string } & Record<string, unknown>;

export interface LoadCashOutstandingOptions {
  scope: CashOutstandingScope;
  coverage: CashOutstandingCoverage;
  channelConfigured: boolean | null;
  now: string;
}

async function readDocs(query: Query): Promise<RawDoc[]> {
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function readNames(query: Query): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const doc of (await query.get()).docs) {
    const name = doc.get("name");
    if (typeof name === "string" && name.trim()) names.set(doc.id, name);
  }
  return names;
}

function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/** El esquema deja pasar evidencias como registros sueltos; el nucleo solo mira `type` y `createdAt`. */
function toCoreOrder(order: ParsedCashOutstandingOrder): CashOutstandingOrder {
  const updatedAt = (order as Record<string, unknown>).updatedAt;
  return {
    id: order.id,
    trackingCode: order.trackingCode,
    sellerId: order.sellerId,
    driverId: order.driverId,
    messengerId: order.messengerId,
    status: order.status,
    paymentMethod: order.paymentMethod ?? "",
    totalCop: order.totalCop,
    closedAt: order.closedAt,
    updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    evidence: order.evidence.map((item) => ({
      type: typeof item.type === "string" ? item.type : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : ""
    }))
  };
}

/** Costo de producto de tienda; el nucleo descarta lo ya liquidado al proveedor. */
function isSellerProductCost(entry: WalletEntryDoc): boolean {
  return entry.ownerType === "seller" && entry.type === "product_cost";
}

/** Asientos sin nombre de proveedor toman el del catalogo de proveedores. */
function withSupplierName(entry: WalletEntryDoc, suppliers: Map<string, string>): WalletEntryDoc {
  if (entry.supplierName || !entry.supplierId) return entry;
  const supplierName = suppliers.get(entry.supplierId);
  return supplierName ? { ...entry, supplierName } : entry;
}

/**
 * Carga lo que el nucleo necesita para `scope` (plan 4.3). Solo lecturas.
 * Pasos: pedidos COD entregados (+ `driverId` del lider) con `select`; cortes de domiciliario; descarte
 * de los recibidos; asientos segun la cobertura; nombres, ajustes y canal.
 */
export async function loadCashOutstandingInput(db: Firestore, options: LoadCashOutstandingOptions): Promise<CashOutstandingInput> {
  const { scope, coverage } = options;
  const isLeader = scope.kind === "leader";
  const isFull = coverage === "full" && scope.kind === "admin";

  const codOrders = db.collection("orders").where("paymentMethod", "==", "cod").where("status", "in", ["delivered", "liquidated"]);
  const ordersQuery = scope.kind === "leader" ? codOrders.where("driverId", "==", scope.driverId) : codOrders;
  const settlementsQuery =
    scope.kind === "leader"
      ? db.collection("settlements").where("kind", "==", "driver").where("ownerId", "==", scope.driverId)
      : db.collection("settlements").where("kind", "==", "driver");

  const [rawOrders, rawSettlements, settingsSnap, sellers, messengers, leaders, suppliers] = await Promise.all([
    readDocs(ordersQuery.select(...ORDER_FIELDS)),
    readDocs(settlementsQuery),
    db.collection("settings").doc("cashAlerts").get(),
    readNames(db.collection("sellers").select("name")),
    readNames(db.collection("messengers").select("name")),
    isLeader ? Promise.resolve(new Map<string, string>()) : readNames(db.collection("drivers").select("name")),
    isLeader ? Promise.resolve(new Map<string, string>()) : readNames(db.collection("suppliers").select("name"))
  ]);

  const { orders: parsedOrders, unreadableOrderIds } = parseCashOutstandingOrders(rawOrders);
  const { settlements: parsedSettlements, unreadableSettlementIds } = parseDriverSettlements(rawSettlements);
  // El esquema es passthrough: el documento entero sigue ahi, validado en lo que el calculo usa.
  const settlements = parsedSettlements as unknown as SettlementDoc[];
  const orders = parsedOrders.map(toCoreOrder);

  // Paso 3: la regla de recibido (importada, RF_01) acota que asientos hace falta leer en resumen.
  const received = buildCodReceivedSet(settlements);
  const candidateIds = orders.filter((order) => !received.has(order.id)).map((order) => order.id);
  const batches = inBatches(candidateIds, ORDER_ID_IN_BATCH);

  let rawEntries: RawDoc[];
  if (isFull) {
    const reads = await Promise.all([
      readDocs(db.collection("walletEntries").where("ownerType", "==", "seller").where("type", "in", ["cod_revenue", "cod_remittance"])),
      readDocs(db.collection("walletEntries").where("ownerType", "==", "driver").where("type", "==", "driver_earning")),
      ...batches.map((ids) => readDocs(db.collection("walletEntries").where("type", "==", "product_cost").where("orderId", "in", ids)))
    ]);
    rawEntries = reads.flat();
  } else {
    const reads = await Promise.all(batches.map((ids) => readDocs(db.collection("walletEntries").where("orderId", "in", ids))));
    rawEntries = reads.flat();
  }

  const { entries: parsedEntries, unreadableEntryIds } = parseWalletEntries(rawEntries);
  const entries = parsedEntries as unknown as WalletEntryDoc[];
  const receivableEntries = entries.filter((entry) => isReceivableCodEntry(entry) || isReceivableDriverPay(entry));
  // RF_08: el retenido por proveedor es solo del admin.
  const productCostEntries = isLeader
    ? []
    : entries.filter(isSellerProductCost).map((entry) => withSupplierName(entry, suppliers));

  if (isLeader) {
    // El lider solo necesita su propio nombre: un documento, no la coleccion.
    const ownSnap = await db.collection("drivers").doc(scope.driverId).get();
    const ownName = ownSnap.get("name");
    if (typeof ownName === "string" && ownName.trim()) leaders.set(scope.driverId, ownName);
  }

  const { settings, settingsInvalid } = readCashAlertSettings(settingsSnap.exists ? settingsSnap.data() : undefined);

  return {
    orders,
    settlements,
    receivableEntries,
    coverage,
    productCostEntries,
    names: { sellers, leaders, messengers },
    settings,
    settingsInvalid,
    channelConfigured: options.channelConfigured,
    scope,
    now: options.now,
    unreadableOrderIds,
    unreadableSettlementIds,
    unreadableEntryIds
  };
}

// 512 MiB por CPU (arranque en frio), como el resto de callables de lectura pesada.
export const getCashOutstanding = onCall({ memory: "512MiB", secrets: [opsNoticeWebhookUrl] }, async (request) => {
  const resolution = resolveCashOutstandingScope(request.auth, request.data);
  if (!resolution.ok) {
    throw new HttpsError(resolution.code, resolution.message);
  }
  const { scope, coverage } = resolution;
  // Solo si hay canal, nunca la url (lleva el token en la ruta). El lider no ve ajustes de canal.
  const channelConfigured = scope.kind === "admin" ? isOpsChannelConfigured(opsNoticeWebhookUrl.value()) : null;

  try {
    const input = await loadCashOutstandingInput(getFirestore(), {
      scope,
      coverage,
      channelConfigured,
      now: new Date().toISOString()
    });
    return buildCashOutstandingReport(input);
  } catch (error) {
    console.error("[getCashOutstanding]", error);
    throw new HttpsError("internal", "No se pudo calcular el efectivo pendiente.");
  }
});

// ---------------------------------------------------------------------------------------------------
// T13 — ajustes de alerta (RF_04) y aviso diario de efectivo vencido (RF_05)
// ---------------------------------------------------------------------------------------------------

export type CashAlertSettingsUpdateResolution =
  | { ok: true; settings: CashAlertSettings }
  | { ok: false; code: "permission-denied" | "invalid-argument"; message: string };

const SETTINGS_DENIED = "Solo un administrador puede cambiar los ajustes de alerta de efectivo.";
const SETTINGS_INVALID = "Entrada invalida: se requieren overdueDays (entero de 1 a 120) y notifyMinCop (entero >= 0).";

/**
 * Permiso y validacion de `updateCashAlertSettings`, sin lanzar nunca. Primero el rol, despues la
 * entrada. Los dos campos son obligatorios aunque el esquema tenga defectos: un `{ overdueDays }`
 * suelto pisaria en silencio el umbral configurado con el defecto.
 */
export function resolveCashAlertSettingsUpdate(auth: CashOutstandingAuth, data: unknown): CashAlertSettingsUpdateResolution {
  const token = auth && typeof auth.token === "object" && auth.token !== null ? auth.token : undefined;
  if (token?.role !== "admin") {
    return { ok: false, code: "permission-denied", message: SETTINGS_DENIED };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("overdueDays" in data) || !("notifyMinCop" in data)) {
    return { ok: false, code: "invalid-argument", message: SETTINGS_INVALID };
  }
  const parsed = cashAlertSettingsSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, code: "invalid-argument", message: SETTINGS_INVALID };
  }
  return { ok: true, settings: { overdueDays: parsed.data.overdueDays, notifyMinCop: parsed.data.notifyMinCop } };
}

export const updateCashAlertSettings = onCall(async (request) => {
  const resolution = resolveCashAlertSettingsUpdate(request.auth, request.data);
  if (!resolution.ok) {
    throw new HttpsError(resolution.code, resolution.message);
  }
  const { settings } = resolution;
  const db = getFirestore();
  const now = new Date().toISOString();
  const settingsRef = db.collection("settings").doc("cashAlerts");

  try {
    const previousSnap = await settingsRef.get();
    const previousRead = readCashAlertSettings(previousSnap.exists ? previousSnap.data() : undefined);
    // Un documento ilegible no tiene un "antes" fiable: la auditoria lo deja en null.
    const previous = previousSnap.exists && !previousRead.settingsInvalid ? previousRead.settings : null;
    const auditRef = db.collection("auditEvents").doc();
    const role = request.auth?.token.role;
    const actorRole = typeof role === "string" ? role : undefined;

    const batch = db.batch();
    batch.set(settingsRef, buildCashAlertSettingsDoc({ settings, actorId: request.auth?.uid, now }));
    batch.set(auditRef, buildCashAlertAuditDoc({ id: auditRef.id, actorId: request.auth?.uid, actorRole, previous, next: settings, now }));
    await batch.commit();
  } catch (error) {
    console.error("[updateCashAlertSettings]", error);
    throw new HttpsError("internal", "No se pudieron guardar los ajustes de alerta.");
  }
  return { settings };
});

export interface OverdueNoticeReport extends NoticeReportInput {
  isIncomplete: boolean;
}

export interface RunOverdueNoticeDeps {
  runId: string;
  now: string;
  /** El secreto tal cual; nunca se copia a ningun documento. */
  channelUrl: string | undefined | null;
  loadReport(): Promise<OverdueNoticeReport>;
  loadNotifiedOrderIds(orderIds: string[]): Promise<ReadonlySet<string>>;
  send(text: string, url: string): Promise<OpsNoticeResult>;
  markNotified(docs: CashOverdueNoticeDoc[]): Promise<void>;
  writeRun(doc: CashOverdueRunDoc): Promise<void>;
}

function describeSendFailure(result: Exclude<OpsNoticeResult, { ok: true }>): string {
  if (result.reason === "network_error" || result.reason === "timeout") return `${result.reason}: ${result.error}`;
  return result.reason;
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * Orquestacion del aviso diario con la E/S inyectada. Candidatas solo de `rows` (los compensados van
 * aparte y nunca se avisan). Se marca DESPUES de un envio correcto, y se marcan todas las candidatas
 * aunque el texto se recorte: "al menos una vez" (si el marcado falla, se repetira en la siguiente corrida).
 */
export async function runOverdueNotice(deps: RunOverdueNoticeDeps): Promise<CashOverdueRunDoc> {
  const report = await deps.loadReport();
  const reportInput: NoticeReportInput = { rows: report.rows, settings: report.settings };
  const eligibleIds = selectNoticeCandidates(reportInput, new Set<string>()).map((row) => row.orderId);
  const notified = await deps.loadNotifiedOrderIds(eligibleIds);
  const candidates = selectNoticeCandidates(reportInput, notified);
  const composed = composeOverdueNotice(candidates, { isIncomplete: report.isIncomplete, now: deps.now });
  const channelConfigured = isOpsChannelConfigured(deps.channelUrl);

  const runBase = {
    runId: deps.runId,
    now: deps.now,
    channelConfigured,
    isIncomplete: report.isIncomplete,
    orderIds: candidates.map((row) => row.orderId),
    leaderCount: composed?.groups.length ?? 0,
    totalCop: composed?.totalCop ?? 0,
    truncated: composed?.truncated ?? false
  };
  const finish = async (run: CashOverdueRunDoc): Promise<CashOverdueRunDoc> => {
    await deps.writeRun(run);
    return run;
  };

  if (!channelConfigured) {
    return finish(buildRunDoc({ ...runBase, status: "skipped_no_channel" }));
  }
  if (!composed) {
    return finish(buildRunDoc({ ...runBase, status: "nothing_to_send" }));
  }

  const result = await deps.send(composed.text, deps.channelUrl as string);
  if (!result.ok) {
    return finish(
      buildRunDoc({
        ...runBase,
        status: "send_failed",
        error: describeSendFailure(result),
        httpStatus: result.reason === "http_error" ? result.httpStatus : undefined
      })
    );
  }

  try {
    await deps.markNotified(buildNoticeDocs({ candidates, runId: deps.runId, now: deps.now }));
  } catch (error) {
    console.error("[runOverdueNotice] marcado fallido tras envio", error);
    return finish(buildRunDoc({ ...runBase, status: "mark_failed", error: describeThrown(error) }));
  }
  return finish(buildRunDoc({ ...runBase, status: "sent" }));
}

/** Lecturas por id con `getAll` y escrituras por lote: holgados bajo los limites de Firestore. */
const NOTICE_READ_BATCH = 300;
const NOTICE_WRITE_BATCH = 400;

export const notifyOverdueCash = onSchedule(
  { schedule: "every day 08:00", timeZone: "America/Bogota", secrets: [opsNoticeWebhookUrl], memory: "512MiB", timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const now = new Date().toISOString();
    const notices = db.collection("cashOverdueNotices");

    try {
      const run = await runOverdueNotice({
        runId: now.replace(/[:.]/g, "-"),
        now,
        channelUrl: opsNoticeWebhookUrl.value(),
        loadReport: async () => {
          const input = await loadCashOutstandingInput(db, {
            scope: { kind: "admin", includeReconciliation: false },
            coverage: "targeted",
            channelConfigured: null,
            now
          });
          return buildCashOutstandingReport(input);
        },
        loadNotifiedOrderIds: async (orderIds) => {
          const notified = new Set<string>();
          for (const ids of inBatches(orderIds, NOTICE_READ_BATCH)) {
            const snaps = await db.getAll(...ids.map((id) => notices.doc(id)));
            for (const snap of snaps) {
              if (snap.exists) notified.add(snap.id);
            }
          }
          return notified;
        },
        send: (text, url) => sendOpsNotice(text, { url }),
        markNotified: async (docs) => {
          for (const chunk of inBatches(docs, NOTICE_WRITE_BATCH)) {
            const batch = db.batch();
            for (const doc of chunk) batch.set(notices.doc(doc.id), doc.data);
            await batch.commit();
          }
        },
        writeRun: async (doc) => {
          await db.collection("cashOverdueRuns").doc(doc.id).set(doc);
        }
      });
      console.log(`[notifyOverdueCash] ${run.status}: ${run.orderCount} pedidos`);
    } catch (error) {
      console.error("[notifyOverdueCash]", error);
      throw error;
    }
  }
);
