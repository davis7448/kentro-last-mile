#!/usr/bin/env node
/**
 * Spec 038 (RF_13-RF_16) — compensacion historica de un domiciliario.
 *
 * POR DEFECTO NO ESCRIBE: lee produccion (ADC) y previsualiza, pedido a pedido, lo que la foto retuvo (RF_17):
 * cobrado, debido, diferencia y por donde entraria (el corte pendiente que lo absorbe, o el siguiente corte).
 * La regla es la de `functions/lib/driver-cash-ledger.js` (`planDriverCompensation`); compilar antes con
 * `cd functions && npm run build`.
 *
 *   node scripts/compensate-038.js driver-XXXX
 *   node scripts/compensate-038.js driver-XXXX --exclude KNT-005724,KNT-006347 --exclude-reason "por aclarar"
 *   node scripts/compensate-038.js driver-XXXX --exclude ... --apply --approved-by "<nombre>" \
 *     --reason "<motivo>" --fingerprint <huella impresa por la previsualizacion>   # SOLO con aprobacion
 *
 * Aplicar (RF_14) = dentro de una transaccion, volver a leer y a previsualizar con las mismas exclusiones; si la
 * huella no es la aprobada, los datos cambiaron y aborta sin escribir. Si coincide, marca como liberadas esas
 * retenciones (`driverCashHolds/{driverId}`) y crea el registro de auditoria `driverCompensations/{id}` con autor
 * y motivo. NO toca ningun corte: el siguiente corte del domiciliario recoge los pedidos liberados por si solo
 * (RF_07), y un corte pagado o conciliado nunca se reescribe. Aplicar otra vez no libera nada mas (RF_15).
 */
const path = require("path");

const LEDGER_LIB = path.resolve(__dirname, "../functions/lib/driver-cash-ledger.js");
const IO_LIB = path.resolve(__dirname, "../functions/lib/driver-ledger-io.js");
const HOLDS = "driverCashHolds";
const COMPENSATIONS = "driverCompensations";
const DEFAULT_EXCLUDE_REASON = "excluido por el responsable";
/** Limite de valores de un `in` de Firestore. */
const IN_BATCH = 30;

function requireLib(file) {
  try {
    return require(file);
  } catch (error) {
    throw new Error(`No se encontro ${file}. Compila antes: cd functions && npm run build (${error.message})`);
  }
}

function parseArgs(argv) {
  const valueFlags = new Set(["--approved-by", "--reason", "--fingerprint", "--exclude", "--exclude-reason"]);
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  const skip = new Set();
  argv.forEach((arg, index) => {
    if (valueFlags.has(arg)) skip.add(index + 1);
  });
  const exclude = (valueOf("--exclude") ?? "").split(",").map((code) => code.trim()).filter(Boolean);
  return {
    driverId: argv.find((arg, index) => !arg.startsWith("--") && !skip.has(index)) ?? null,
    apply: argv.includes("--apply"),
    approvedBy: valueOf("--approved-by"),
    reason: valueOf("--reason"),
    fingerprint: valueOf("--fingerprint"),
    exclude,
    excludeReason: valueOf("--exclude-reason") ?? DEFAULT_EXCLUDE_REASON
  };
}

/** Codigos de seguimiento -> `Map<orderId, motivo>`. Uno que no es de los pedidos retenidos aborta. */
function resolveExclusions(trackingCodes, orderIdByTracking, reason) {
  const exclude = new Map();
  for (const code of trackingCodes) {
    const orderId = orderIdByTracking.get(code);
    if (!orderId) throw new Error(`--exclude ${code}: no es ninguno de los pedidos retenidos de este domiciliario.`);
    exclude.set(orderId, reason);
  }
  return exclude;
}

/** Por que no se puede aplicar, o null si se puede. */
function applyRefusal(args) {
  if (!args.apply) return "Previsualizacion: no se escribe nada (anade --apply con aprobacion para aplicar).";
  if (!args.driverId) return "Falta el domiciliario (primer argumento).";
  if (!args.approvedBy) return "Falta --approved-by \"<nombre>\": solo se aplica con aprobacion del responsable.";
  if (!args.reason) return "Falta --reason \"<motivo>\": la auditoria lo exige (RF_14).";
  if (!args.fingerprint) return "Falta --fingerprint: la huella que imprimio la previsualizacion aprobada.";
  return null;
}

/**
 * RF_14. `load(tx)` lee, dentro de la transaccion, el contexto del domiciliario y los asientos de sus pedidos
 * retenidos. Vuelve a previsualizar con las mismas exclusiones y aplica solo si la huella es la aprobada.
 */
async function applyCompensation({ db, driverId, exclude, approval, load }) {
  const { planDriverCompensation, applyCompensationPlan } = requireLib(LEDGER_LIB);
  return db.runTransaction(async (tx) => {
    const { context, entries, deliveredBy } = await load(tx);
    if (!context.holds) throw new Error(`${driverId} no tiene documento de retenciones (${HOLDS}): no hay nada que compensar. Escribe antes la foto.`);
    const plan = planDriverCompensation({ entries, context, exclude, deliveredBy });
    const { holds, audit } = applyCompensationPlan(context.holds, plan, approval);
    tx.set(db.collection(HOLDS).doc(driverId), holds);
    tx.create(db.collection(COMPENSATIONS).doc(approval.compensationId), audit);
    return { totalCop: audit.totalCop, releasedOrderIds: audit.releasedOrderIds };
  });
}

/** Lector de produccion: el contexto (3 lecturas) y los asientos de los pedidos retenidos, con o sin transaccion. */
function productionLoader(db, driverId) {
  const { loadDriverLedgerSnapshot } = requireLib(IO_LIB);
  return async (tx) => {
    const { context } = await loadDriverLedgerSnapshot(db, driverId, tx);
    const heldIds = Array.from(new Set((context.holds?.holds ?? []).map((hold) => hold.orderId)));
    const reads = [];
    for (let start = 0; start < heldIds.length; start += IN_BATCH) {
      const query = db.collection("walletEntries").where("orderId", "in", heldIds.slice(start, start + IN_BATCH));
      reads.push(tx ? tx.get(query) : query.get());
    }
    const entries = (await Promise.all(reads)).flatMap((snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    // RF_01b: quien tiene asignado cada pedido retenido (solo el campo), por la transaccion si la hay.
    const refs = heldIds.map((id) => db.collection("orders").doc(id));
    const snaps = refs.length ? await (tx ? tx.getAll(...refs, { fieldMask: ["driverId"] }) : db.getAll(...refs, { fieldMask: ["driverId"] })) : [];
    const deliveredBy = new Map(snaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.get("driverId") || null]));
    return { context, entries, deliveredBy };
  };
}

/**
 * Antes de escribir la foto no hay `driverCashHolds` en produccion. Para poder previsualizar igual, se arma en
 * memoria con `buildDriverLedgerSnapshot`, exactamente como la escribiria `scripts/snapshot-038-baseline.js`
 * ahora. Solo sirve para ver: aplicar exige la foto escrita.
 */
async function derivedContext(db, driverId) {
  const { buildDriverLedgerSnapshot } = requireLib(LEDGER_LIB);
  const docs = (snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const [settlements, cod, pay, orders] = await Promise.all([
    db.collection("settlements").where("kind", "==", "driver").where("ownerId", "==", driverId).get().then(docs),
    db.collection("walletEntries").where("ownerType", "==", "seller").where("type", "in", ["cod_revenue", "cod_remittance"]).get().then(docs),
    db.collection("walletEntries").where("ownerType", "==", "driver").where("type", "==", "driver_earning").get().then(docs),
    db.collection("orders").select("driverId").get()
  ]);
  const entries = [...cod, ...pay];
  const deliveredBy = new Map(orders.docs.map((doc) => [doc.id, doc.get("driverId") || null]));
  const { context } = buildDriverLedgerSnapshot({ driverId, settlements, entries, now: new Date().toISOString(), createdBy: "derived-preview", deliveredBy });
  return { context, entries, deliveredBy };
}

const cop = (value) => `$${Math.round(value).toLocaleString("es-CO")}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.driverId) throw new Error("Uso: node scripts/compensate-038.js <driverId> [--exclude KNT-...,KNT-...] [--apply ...]");
  const admin = require("../functions/node_modules/firebase-admin");
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const db = admin.firestore();
  const { planDriverCompensation } = requireLib(LEDGER_LIB);

  const load = productionLoader(db, args.driverId);
  let loaded = null;
  try {
    loaded = await load(null);
  } catch (error) {
    if (!error || error.code !== "sin_foto_historica") throw error;
  }
  // Sin foto escrita: se previsualiza con la que se escribiria ahora, y no se puede aplicar.
  const derived = !loaded || !loaded.context.holds;
  if (derived) loaded = await derivedContext(db, args.driverId);
  const { context, entries, deliveredBy } = loaded;
  const heldIds = context.holds.holds.map((hold) => hold.orderId);
  const snaps = heldIds.length ? await db.getAll(...heldIds.map((id) => db.collection("orders").doc(id))) : [];
  const trackingById = new Map(snaps.map((snap) => [snap.id, snap.exists ? snap.get("trackingCode") ?? snap.id : snap.id]));
  const orderIdByTracking = new Map(Array.from(trackingById.entries()).map(([id, code]) => [code, id]));
  const exclude = resolveExclusions(args.exclude, orderIdByTracking, args.excludeReason);
  const plan = planDriverCompensation({ entries, context, exclude, deliveredBy });

  console.log(`Spec 038 · compensacion de ${args.driverId} · ${new Date().toISOString()}`);
  if (derived) console.log("AVISO: la foto aun no esta escrita; las retenciones se derivan en memoria como las escribiria el script de la foto ahora. Solo previsualizacion.");
  console.log("");
  console.log("pedido         |    cobrado |     debido | diferencia | entra por            | estado");
  for (const row of [...plan.rows].sort((left, right) => right.releaseCop - left.releaseCop)) {
    console.log([
      String(trackingById.get(row.orderId) ?? row.orderId).padEnd(14),
      cop(row.chargedCop).padStart(10),
      cop(row.owedCop).padStart(10),
      cop(row.releaseCop).padStart(10),
      row.entersVia.padEnd(20),
      row.excluded ? `PENDIENTE (${row.excludedReason})` : "a compensar"
    ].join(" | "));
  }
  console.log(`\nA compensar: ${cop(plan.totalCop)} (positivo = a favor del domiciliario) · excluido y pendiente: ${cop(plan.excludedCop)}`);
  console.log(`Huella: ${plan.fingerprint}`);
  const excludeFlag = args.exclude.length ? ` --exclude ${args.exclude.join(",")} --exclude-reason "${args.excludeReason}"` : "";
  console.log(`Para aplicar (solo con aprobacion): ${args.driverId}${excludeFlag} --apply --approved-by "<nombre>" --reason "<motivo>" --fingerprint ${plan.fingerprint}`);

  const refusal = derived && args.apply
    ? "No se aplica: la foto historica no esta escrita. Primero scripts/snapshot-038-baseline.js --write (con aprobacion)."
    : applyRefusal(args);
  if (refusal) {
    console.log(`\n${refusal}`);
    if (args.apply) process.exitCode = 1;
    return;
  }
  const at = new Date().toISOString();
  const compensationId = `cmp-038-${args.driverId}-${at.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const result = await applyCompensation({
    db,
    driverId: args.driverId,
    exclude,
    approval: { approvedBy: args.approvedBy, reason: args.reason, at, compensationId, expectedFingerprint: args.fingerprint },
    load
  });
  console.log(`\nAplicada ${compensationId}: ${result.releasedOrderIds.length} retenciones liberadas, ${cop(result.totalCop)}. Ningun corte tocado.`);
}

module.exports = { parseArgs, resolveExclusions, applyRefusal, applyCompensation };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
