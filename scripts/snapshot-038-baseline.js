#!/usr/bin/env node
/**
 * Spec 038 (RF_05b, RF_17) — foto historica y retenciones de cada domiciliario.
 *
 * POR DEFECTO NO ESCRIBE: lee produccion (ADC) e imprime lo que escribiria. La regla es la de
 * `functions/lib/driver-cash-ledger.js` (`buildDriverLedgerSnapshot`): compilar antes con
 * `cd functions && npm run build`. Asi el script no lleva su propia copia del calculo.
 *
 *   node scripts/snapshot-038-baseline.js                     # en seco, todos los domiciliarios
 *   node scripts/snapshot-038-baseline.js driver-XXXX         # en seco, uno, con el detalle por pedido
 *   node scripts/snapshot-038-baseline.js --write --approved-by "<nombre>" \
 *     --expect-total 686200 --expect-orders 16                # escribe (SOLO con aprobacion del responsable)
 *
 * Con `--write`, las cifras esperadas son las que la medicion de ese mismo dia imprime
 * (`node specs/038_measure.js`): si las retenciones no suman exactamente eso, aborta sin escribir. Escribe con
 * `create`, en un lote: si ya hay una foto de algun domiciliario, el lote entero falla y no se escribe nada.
 * La foto se escribe una vez; despues, nadie reconstruye, se lee.
 *
 * Documentos: `driverLedgerBaselines/{driverId}` y `driverCashHolds/{driverId}`, uno de cada por domiciliario
 * con cortes de domiciliario (los que no tienen cortes viejos no los necesitan, pero se escriben igual para que
 * el estado sea uniforme). Las reglas impiden escribirlos desde un cliente (T18).
 */
const path = require("path");

const LEDGER_LIB = path.resolve(__dirname, "../functions/lib/driver-cash-ledger.js");
const COD_TYPES = ["cod_revenue", "cod_remittance"];
const BASELINES = "driverLedgerBaselines";
const HOLDS = "driverCashHolds";
/** Firestore admite 500 escrituras por lote; dos por domiciliario. */
const MAX_DRIVERS_PER_BATCH = 200;

function loadLedger() {
  try {
    return require(LEDGER_LIB);
  } catch (error) {
    throw new Error(`No se encontro ${LEDGER_LIB}. Compila antes: cd functions && npm run build (${error.message})`);
  }
}

function parseArgs(argv) {
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  const valueFlags = new Set(["--approved-by", "--expect-total", "--expect-orders"]);
  const skip = new Set();
  argv.forEach((arg, index) => {
    if (valueFlags.has(arg)) skip.add(index + 1);
  });
  const toNumber = (value) => (value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
  return {
    write: argv.includes("--write"),
    approvedBy: valueOf("--approved-by"),
    expectTotalCop: toNumber(valueOf("--expect-total")),
    expectOrders: toNumber(valueOf("--expect-orders")),
    driverId: argv.find((arg, index) => !arg.startsWith("--") && !skip.has(index)) ?? null
  };
}

/** Un plan por domiciliario con cortes de domiciliario: su foto, sus retenciones y el total retenido. */
function planSnapshots({ settlements, entries, now, createdBy, driverId = null, deliveredBy }) {
  const { buildDriverLedgerSnapshot } = loadLedger();
  const byDriver = new Map();
  for (const settlement of settlements) {
    if (settlement.kind !== "driver" || !settlement.ownerId) continue;
    if (driverId && settlement.ownerId !== driverId) continue;
    byDriver.set(settlement.ownerId, [...(byDriver.get(settlement.ownerId) ?? []), settlement]);
  }
  return Array.from(byDriver.keys())
    .sort()
    .map((id) => {
      const own = byDriver.get(id);
      // RF_01b: el recaudo de un pedido que tiene otro domiciliario no se le cuenta a este.
      const snapshot = buildDriverLedgerSnapshot({ driverId: id, settlements: own, entries, now, createdBy, deliveredBy });
      return { driverId: id, baseline: snapshot.baseline, holds: snapshot.holds, totalHoldCop: snapshot.totalHoldCop, settlementCount: own.length };
    });
}

/** Por que no se puede escribir, o null si se puede. */
function writeRefusal(plans, args) {
  if (!args.write) return "En seco: no se escribe nada (anade --write con aprobacion para escribir).";
  if (!args.approvedBy) return "Falta --approved-by \"<nombre>\": la foto solo se escribe con aprobacion del responsable.";
  if (args.expectTotalCop === null || args.expectOrders === null) {
    return "Faltan --expect-total y --expect-orders: las cifras que la medicion de hoy imprime (node specs/038_measure.js).";
  }
  const totalCop = plans.reduce((sum, plan) => sum + plan.totalHoldCop, 0);
  const orders = plans.reduce((sum, plan) => sum + plan.holds.holds.length, 0);
  if (totalCop !== args.expectTotalCop || orders !== args.expectOrders) {
    return `Las retenciones no coinciden con la medicion: ${orders} pedidos / $${totalCop} frente a ${args.expectOrders} / $${args.expectTotalCop} esperados. No se escribe nada.`;
  }
  return null;
}

/** Escribe con `create` (falla si el documento ya existe). Devuelve cuantos documentos escribio. */
async function writeSnapshots(db, plans) {
  let written = 0;
  for (let start = 0; start < plans.length; start += MAX_DRIVERS_PER_BATCH) {
    const batch = db.batch();
    for (const plan of plans.slice(start, start + MAX_DRIVERS_PER_BATCH)) {
      batch.create(db.collection(BASELINES).doc(plan.driverId), plan.baseline);
      batch.create(db.collection(HOLDS).doc(plan.driverId), plan.holds);
      written += 2;
    }
    await batch.commit();
  }
  return written;
}

const cop = (value) => `$${Math.round(value).toLocaleString("es-CO")}`;

async function readProduction(db) {
  const docs = (snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const [settlements, cod, pay, orders] = await Promise.all([
    db.collection("settlements").where("kind", "==", "driver").get().then(docs),
    db.collection("walletEntries").where("ownerType", "==", "seller").where("type", "in", COD_TYPES).get().then(docs),
    db.collection("walletEntries").where("ownerType", "==", "driver").where("type", "==", "driver_earning").get().then(docs),
    // RF_01b: quien tiene asignado cada pedido (solo el campo).
    db.collection("orders").select("driverId").get()
  ]);
  const deliveredBy = new Map(orders.docs.map((doc) => [doc.id, doc.get("driverId") || null]));
  return { settlements, entries: [...cod, ...pay], deliveredBy };
}

async function trackingCodes(db, orderIds) {
  if (orderIds.length === 0) return new Map();
  const snaps = await db.getAll(...orderIds.map((id) => db.collection("orders").doc(id)));
  return new Map(snaps.map((snap) => [snap.id, snap.exists ? snap.get("trackingCode") ?? snap.id : `${snap.id} (no existe)`]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const db = admin.firestore();

  const now = new Date().toISOString();
  const { settlements, entries, deliveredBy } = await readProduction(db);
  const plans = planSnapshots({ settlements, entries, now, createdBy: args.approvedBy ?? "dry-run", driverId: args.driverId, deliveredBy });
  const heldIds = plans.flatMap((plan) => plan.holds.holds.map((hold) => hold.orderId));
  const tracking = await trackingCodes(db, Array.from(new Set(heldIds)));

  console.log(`Spec 038 · foto historica · ${now}`);
  console.log(`Cortes de domiciliario leidos: ${settlements.length}; asientos: ${entries.length}\n`);
  for (const plan of plans) {
    const baselineRows = Object.values(plan.baseline.settlements).reduce((sum, rows) => sum + rows.length, 0);
    const photographed = Object.keys(plan.baseline.settlements).length;
    console.log(
      `${plan.driverId}: ${plan.settlementCount} cortes (${photographed} en la foto, ${baselineRows} filas) · ` +
      `${plan.holds.holds.length} retenciones · ${cop(plan.totalHoldCop)}`
    );
    if (plan.holds.holds.length > 0 && (args.driverId || plan.totalHoldCop !== 0)) {
      for (const hold of [...plan.holds.holds].sort((left, right) => right.holdCop - left.holdCop)) {
        console.log(`    ${String(tracking.get(hold.orderId) ?? hold.orderId).padEnd(14)} ${cop(hold.holdCop).padStart(10)}`);
      }
    }
  }
  const totalCop = plans.reduce((sum, plan) => sum + plan.totalHoldCop, 0);
  const totalOrders = heldIds.length;
  console.log(`\nTotal: ${plans.length} domiciliarios · ${totalOrders} retenciones · ${cop(totalCop)}`);
  console.log(`Para escribir (solo con aprobacion): --write --approved-by "<nombre>" --expect-total ${totalCop} --expect-orders ${totalOrders}`);

  const refusal = writeRefusal(plans, args);
  if (refusal) {
    console.log(`\n${refusal}`);
    if (args.write) process.exitCode = 1;
    return;
  }
  const written = await writeSnapshots(db, plans);
  console.log(`\nEscritos ${written} documentos (${BASELINES} y ${HOLDS}), aprobado por ${args.approvedBy}.`);
}

module.exports = { parseArgs, planSnapshots, writeRefusal, writeSnapshots };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
