/**
 * Spec 038 — lecturas del libro de efectivo de un domiciliario (RF_04b, RF_05b, RNF_04).
 *
 * La regla vive en `driver-cash-ledger.ts`, que es puro. Este modulo es la unica pieza que sabe de
 * Firestore: lee el contexto que la regla necesita (los cortes del domiciliario, su foto historica y sus
 * retenciones) en tres lecturas, y compara dos lecturas del contexto para detectar recalculos cruzados.
 *
 * No importa `firebase-functions`: lanza errores propios con un `code`, y cada callable los traduce a
 * `HttpsError("failed-precondition", ...)`.
 */
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type {
  DriverCashCharge,
  DriverCashHolds,
  DriverLedgerBaseline,
  DriverLedgerContext,
  DriverLedgerSettlement
} from "./driver-cash-ledger";

export const DRIVER_LEDGER_BASELINES = "driverLedgerBaselines";
export const DRIVER_CASH_HOLDS = "driverCashHolds";

/** Otro corte pendiente del domiciliario cambio entre la lectura de fuera y la de dentro de la transaccion. */
export class CrossedRecalcError extends Error {
  readonly code = "recalculo_cruzado";
  constructor(readonly settlementIds: string[]) {
    super(
      `Otro corte del domiciliario cambio mientras se recalculaba este (${settlementIds.join(", ")}). ` +
        "No se guardo nada: vuelve a intentarlo."
    );
    this.name = "CrossedRecalcError";
  }
}

/** El domiciliario tiene cortes anteriores a la 038 y no hay foto historica: no se puede calcular. */
export class MissingBaselineError extends Error {
  readonly code = "sin_foto_historica";
  constructor(readonly driverId: string) {
    super(
      `El domiciliario ${driverId} tiene cortes anteriores a la regla nueva y no tiene foto historica ` +
        `(${DRIVER_LEDGER_BASELINES}/${driverId}). Hay que escribirla antes de calcular sus cortes.`
    );
    this.name = "MissingBaselineError";
  }
}

type Readable = { get(): Promise<unknown> };

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  const asDate = (value as { toDate?: () => Date }).toDate?.();
  return asDate ? asDate.toISOString() : String(value);
}

function toLedgerSettlement(id: string, data: Record<string, unknown>, updateTime: unknown): DriverLedgerSettlement {
  const settlement: DriverLedgerSettlement = {
    id,
    status: String(data.status ?? ""),
    orderIds: Array.isArray(data.orderIds) ? data.orderIds.map(String) : []
  };
  if (Array.isArray(data.cashCharges)) settlement.cashCharges = data.cashCharges as DriverCashCharge[];
  if (typeof data.creditInCop === "number") settlement.creditInCop = data.creditInCop;
  if (typeof data.creditOutCop === "number") settlement.creditOutCop = data.creditOutCop;
  const iso = toIso(updateTime);
  if (iso) settlement.updateTime = iso;
  return settlement;
}

/**
 * El contexto de calculo de un domiciliario: sus cortes (`kind == driver && ownerId == driverId`, con su
 * `updateTime`), su foto historica y sus retenciones. Tres lecturas (RNF_04). Con `tx`, lee dentro de la
 * transaccion. Un domiciliario con cortes viejos (sin `cashCharges`) y sin foto lanza `MissingBaselineError`:
 * calcular sin ella cobraria otra vez lo que esos cortes ya cobraron.
 */
export async function loadDriverLedgerContext(db: Firestore, driverId: string, tx?: Transaction): Promise<DriverLedgerContext> {
  const read = <T>(target: Readable): Promise<T> => (tx ? (tx.get(target as never) as Promise<T>) : (target.get() as Promise<T>));
  const settlementsQuery = db.collection("settlements").where("kind", "==", "driver").where("ownerId", "==", driverId);
  const [settlementSnap, baselineSnap, holdsSnap] = await Promise.all([
    read<{ docs: Array<{ id: string; data: () => Record<string, unknown>; updateTime?: unknown }> }>(settlementsQuery),
    read<{ exists: boolean; data: () => unknown }>(db.collection(DRIVER_LEDGER_BASELINES).doc(driverId)),
    read<{ exists: boolean; data: () => unknown }>(db.collection(DRIVER_CASH_HOLDS).doc(driverId))
  ]);
  const settlements = settlementSnap.docs.map((doc) => toLedgerSettlement(doc.id, doc.data() ?? {}, doc.updateTime));
  const baseline = baselineSnap.exists ? (baselineSnap.data() as DriverLedgerBaseline) : null;
  const holds = holdsSnap.exists ? (holdsSnap.data() as DriverCashHolds) : null;
  if (!baseline && settlements.some((settlement) => !Array.isArray(settlement.cashCharges))) {
    throw new MissingBaselineError(driverId);
  }
  return { driverId, settlements, baseline, holds };
}

/**
 * RF_04b. `before` es el contexto que la callable leyo al empezar, FUERA de la transaccion; `after`, el que
 * leyo DENTRO. Si algun otro corte pendiente del domiciliario (en cualquiera de las dos lecturas) aparecio,
 * desaparecio, cambio de estado o se reescribio, lanza `CrossedRecalcError` y el llamador no escribe nada.
 * Un reintento automatico de Firestore no lo enmascara: `before` no se vuelve a leer. Los cortes cerrados no
 * cuentan: su registro no cambia (RF_04).
 */
export function assertNoCrossedRecalc(before: DriverLedgerContext, after: DriverLedgerContext, selfId: string): void {
  const index = (context: DriverLedgerContext) => new Map(context.settlements.map((settlement) => [settlement.id, settlement]));
  const beforeById = index(before);
  const afterById = index(after);
  const watched = new Set<string>();
  for (const settlement of [...before.settlements, ...after.settlements]) {
    if (settlement.id !== selfId && settlement.status === "pending") watched.add(settlement.id);
  }
  const crossed = Array.from(watched).filter((id) => {
    const previous = beforeById.get(id);
    const current = afterById.get(id);
    return !previous || !current || previous.status !== current.status || previous.updateTime !== current.updateTime;
  });
  if (crossed.length > 0) throw new CrossedRecalcError(crossed.sort());
}
