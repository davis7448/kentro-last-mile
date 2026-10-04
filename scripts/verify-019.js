/**
 * Verificacion de la spec 019 contra produccion (DoD 9).
 *
 * SOLO LECTURA. No escribe nada, no crea usuarios, no borra nada.
 *
 * Comprueba lo unico que las pruebas no pueden: que con los datos REALES el detalle de un corte
 * suma exactamente lo que dice su cabecera, y que los seis pedidos que el domiciliario reclamo el
 * 2026-09-19 salen con su importe y no en cero.
 *
 * Reproduce en node la escalera de `settlementOrderRow` (src/lib/finance.ts) para poder afirmar la
 * misma identidad que la app, sin navegador: el detalle se calcula desde los pedidos y la wallet, y
 * se compara contra `cashExpectedCop`, que lo escribio el servidor.
 *
 * Uso:
 *   node scripts/verify-019.js
 *   node scripts/verify-019.js --settlement stl-XXXX --driver driver-YYYY
 */
const admin = require("../functions/node_modules/firebase-admin");

const DEFAULT_SETTLEMENT = "stl-1789686589616-driver-driver-1778271901513";
const DEFAULT_DRIVER = "driver-1778271901513";

/** Los seis del cuadro de DANDA que salian en $0 en la pantalla del domiciliario. */
const RECLAMADOS = ["KNT-005077", "KNT-005058", "KNT-004892", "KNT-005064", "KNT-005054", "KNT-005060"];

const fmt = (value) => `$${Math.round(Number(value) || 0).toLocaleString("es-CO")}`;

function argOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Mismo criterio que `orderCollectedCodCop`: solo entregados/liquidados en efectivo recaudan. */
function collectedCodCop(order) {
  if (!order || order.paymentMethod !== "cod") return 0;
  if (order.status !== "delivered" && order.status !== "liquidated") return 0;
  return Math.max(0, Number(order.totalCop) || 0);
}

async function main() {
  const settlementId = argOf("--settlement", DEFAULT_SETTLEMENT);
  const driverId = argOf("--driver", DEFAULT_DRIVER);

  admin.initializeApp({ projectId: "kentro-last-mile" });
  const db = admin.firestore();

  const snap = await db.doc(`settlements/${settlementId}`).get();
  if (!snap.exists) {
    console.error(`No existe el corte ${settlementId}`);
    process.exit(1);
  }
  const settlement = snap.data();
  const orderIds = Array.from(new Set(settlement.orderIds || []));

  const paySnap = await db.collection("walletEntries").where("ownerType", "==", "driver").where("ownerId", "==", driverId).get();
  const payByOrder = new Map();
  paySnap.docs.map((doc) => doc.data()).filter((entry) => entry.type === "driver_earning").forEach((entry) => {
    payByOrder.set(entry.orderId, (payByOrder.get(entry.orderId) || 0) + (Number(entry.amountCop) || 0));
  });

  const allocationByOrder = new Map();
  const hasAllocations = Array.isArray(settlement.cashAllocations);
  if (hasAllocations) {
    for (const allocation of settlement.cashAllocations) {
      if (allocation && allocation.orderId && Number.isFinite(Number(allocation.expectedCop))) {
        allocationByOrder.set(allocation.orderId, Number(allocation.expectedCop));
      }
    }
  }

  const rows = [];
  for (const orderId of orderIds) {
    const doc = await db.doc(`orders/${orderId}`).get();
    const order = doc.exists ? doc.data() : undefined;
    const pay = payByOrder.get(orderId) || 0;
    if (order) {
      const cod = collectedCodCop(order);
      rows.push({ orderId, trackingCode: order.trackingCode || "", cod, pay, expected: cod - pay, source: "order", known: true });
      continue;
    }
    if (!hasAllocations) {
      rows.push({ orderId, trackingCode: "", cod: 0, pay, expected: 0, source: "unknown", known: false });
      continue;
    }
    const allocated = allocationByOrder.has(orderId) ? allocationByOrder.get(orderId) : -pay;
    rows.push({ orderId, trackingCode: "", cod: allocated + pay, pay, expected: allocated, source: "settlement", known: true });
  }

  const detail = rows.filter((row) => row.known).reduce((sum, row) => sum + row.expected, 0);
  const cabecera = Number(settlement.cashExpectedCop) || 0;
  const sinRecaudo = rows.filter((row) => row.known && row.cod === 0);
  const sinImporte = rows.filter((row) => !row.known);

  console.log(`Corte ${settlementId}`);
  console.log(`  periodo ${settlement.startDate} a ${settlement.endDate} · estado ${settlement.status}`);
  console.log(`  pedidos: ${orderIds.length}   filas del detalle: ${rows.length}`);
  console.log("");
  console.log(`  Cabecera (cashExpectedCop, del servidor): ${fmt(cabecera)}`);
  console.log(`  Suma del detalle:                         ${fmt(detail)}`);
  console.log(`  Diferencia:                               ${fmt(detail - cabecera)}`);
  console.log("");
  console.log(`  Visitas sin recaudo: ${sinRecaudo.length}, a favor ${fmt(sinRecaudo.reduce((sum, row) => sum + row.expected, 0))}`);
  console.log(`  Filas sin importe conocido: ${sinImporte.length}`);
  console.log(`  Filas resueltas desde el corte (pedido no legible): ${rows.filter((row) => row.source === "settlement").length}`);
  console.log("");

  console.log("  Los seis pedidos reclamados el 2026-09-19:");
  let reclamadoTotal = 0;
  let faltan = 0;
  for (const code of RECLAMADOS) {
    const row = rows.find((item) => item.trackingCode === code);
    if (!row) {
      console.log(`    ${code}  NO APARECE EN EL CORTE`);
      faltan += 1;
      continue;
    }
    reclamadoTotal += row.expected;
    const marca = row.expected === 0 ? "  <-- EN CERO" : "";
    console.log(`    ${code}  COD ${fmt(row.cod)}  pago ${fmt(row.pay)}  efectivo ${fmt(row.expected)}${marca}`);
  }
  console.log(`    suma: ${fmt(reclamadoTotal)}`);
  console.log("");

  const enCero = rows.filter((row) => row.known && row.expected === 0 && row.cod > 0);
  const problemas = [];
  if (detail !== cabecera) problemas.push(`el detalle no cuadra con la cabecera (${fmt(detail - cabecera)})`);
  if (sinImporte.length > 0) problemas.push(`${sinImporte.length} filas sin importe conocido`);
  if (enCero.length > 0) problemas.push(`${enCero.length} filas con recaudo pero efectivo en cero`);
  if (faltan > 0) problemas.push(`${faltan} de los pedidos reclamados no estan en el corte`);
  if (rows.some((row) => row.known && row.trackingCode === "" && row.source === "order")) problemas.push("hay pedidos legibles sin codigo de seguimiento");

  if (problemas.length === 0) {
    console.log("VERIFICACION OK: el detalle suma la cabecera y ninguna fila con recaudo sale en cero.");
    process.exit(0);
  }
  console.log("VERIFICACION CON HALLAZGOS:");
  problemas.forEach((problema) => console.log(`  - ${problema}`));
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
