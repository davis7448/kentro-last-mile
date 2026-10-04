#!/usr/bin/env node
/**
 * Spec 026 — medicion en produccion. SOLO LECTURA: ningun subcomando escribe en Firestore.
 *
 *   node scripts/verify-026.js baseline      (T1) linea base antes de tocar codigo, con ids
 *   node scripts/verify-026.js query-check   (T2) consultas del cargador con limit(1) (indices) y coste
 *                                            cronometrado de los dos modos -> t2-query-check.txt
 *   node scripts/verify-026.js compare [--deployed]
 *                                            (T18) conciliacion con la posicion (DoD 4) y cambios de grupo
 *                                            contra t1-linea-base-ids.json (DoD 3) -> t18-compare.txt; sale
 *                                            con codigo 1 si no pasa. --deployed usa los callables
 *                                            desplegados con VERIFY_026_ADMIN_EMAIL/VERIFY_026_ADMIN_PASSWORD.
 *
 * Escribe dos evidencias locales (archivos del repo, no Firestore):
 *   .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t1-linea-base.txt
 *   .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t1-linea-base-ids.json
 *     { over30Days, coveredByNetting, rows } — T18 compara contra estos ids (plan 5.3, hallazgo D).
 *
 * Usa ADC con las librerias de functions/node_modules y la logica COMPILADA de functions/lib
 * (buildCodReceivedSet, computeDriverCashSummary, settlementCashReceivedCop,
 * computePlatformPosition): nada de esa aritmetica se copia aqui. Requiere `cd functions && npm run build`.
 *
 * Nota para quien lo edite: la guarda de T1 (src/lib/spec-026-guards.test.ts) prohibe en el fuente
 * los literales de las llamadas de escritura de Firestore, incluidos Map/Set/hash con esos mismos
 * nombres. Por eso se agrupa con objetos planos, `new Map(entries)` y `reduce`.
 */
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

// La suite requiere este archivo para probar evaluateCompare: no inicializar dos veces.
if (admin.apps.length === 0) admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const { buildCodReceivedSet } = require(path.join(__dirname, "../functions/lib/seller-ledger"));
const { computeDriverCashSummary, settlementCashReceivedCop } = require(path.join(__dirname, "../functions/lib/settlement-math"));
const { computePlatformPosition } = require(path.join(__dirname, "../functions/lib/platform-position"));

const EVIDENCE_DIR = path.join(__dirname, "../.sdd/evidence/026_efectivo_que_no_llega_a_un_corte");
const TXT_FILE = path.join(EVIDENCE_DIR, "t1-linea-base.txt");
const IDS_FILE = path.join(EVIDENCE_DIR, "t1-linea-base-ids.json");

/** Cifra de referencia de la spec (medida el 2026-10-02, seccion 1 y enmienda). */
const REFERENCE_NETTING = { settlements: 29, orders: 36, amountCop: 1_151_997 };
/** Compuerta de antiguedad (plan 5.4): filas con mas de 30 dias. */
const OVER_DAYS = 30;
const DAY_MS = 86_400_000;
/** Umbrales de coste (plan 4.3). */
const COST_LIMITS = { summaryDocs: 20_000, fullDocs: 30_000 };
const IN_BATCH = 30;

const cop = (value) => `$${Math.round(value).toLocaleString("es-CO")}`;
const num = (value) => Number(value) || 0;
const sumBy = (items, pick) => items.reduce((total, item) => total + num(pick(item)), 0);
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
const groupBy = (items, keyOf) =>
  items.reduce((acc, item) => {
    const key = keyOf(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
const countBy = (items, keyOf) =>
  items.reduce((acc, item) => {
    const key = keyOf(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
const ageDaysOf = (iso, nowMs) => (iso ? Math.floor((nowMs - Date.parse(iso)) / DAY_MS) : null);

/** Lectura contada: cada consulta suma sus documentos al presupuesto que se reporta. */
function createReader() {
  const log = [];
  async function read(label, query) {
    const started = Date.now();
    const snap = await query.get();
    log.push({ label, docs: snap.size, ms: Date.now() - started });
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  return { read, log };
}

/**
 * Criterio "saldado en total" de la spec 026 (plan 2.9). Reproduccion LOCAL y provisional: T4 crea
 * `isDriverSettlementCashSettled` en functions/src/settlement-math.ts y este script debe pasar a
 * importarlo de functions/lib en cuanto exista (T18 ya lo hace). Mismo predicado, letra por letra.
 */
function isDriverSettlementCashSettledLocal(settlement) {
  return (
    settlement.kind === "driver" &&
    (settlement.status === "paid" || settlement.status === "reconciled") &&
    (settlement.cashPendingCop ?? 0) === 0 &&
    typeof settlement.cashExpectedCop === "number" &&
    settlementCashReceivedCop(settlement) >= settlement.cashExpectedCop
  );
}

/** Precedencia de `location` (plan 2.9), sobre los cortes de domiciliario que contienen al pedido. */
function locationOf(containing) {
  if (containing.some((s) => s.status === "pending")) return "in_settlement_open";
  if (containing.some(isDriverSettlementCashSettledLocal)) return "covered_by_netting";
  if (containing.some((s) => s.status === "paid" || s.status === "reconciled")) return "settlement_paid_short";
  return "outside_settlement";
}

/** Fecha de entrega (plan 2.3): closedAt -> ultima evidencia delivery -> cod_revenue -> updatedAt. */
function deliveredAtOf(order, codEntries) {
  if (order.closedAt) return { at: String(order.closedAt), source: "closedAt" };
  const deliveries = (Array.isArray(order.evidence) ? order.evidence : [])
    .filter((item) => item && item.type === "delivery" && item.createdAt)
    .map((item) => String(item.createdAt))
    .sort();
  if (deliveries.length > 0) return { at: deliveries[deliveries.length - 1], source: "evidence" };
  const codDates = codEntries.filter((entry) => entry.type === "cod_revenue" && entry.createdAt).map((entry) => String(entry.createdAt)).sort();
  if (codDates.length > 0) return { at: codDates[0], source: "cod_entry" };
  return { at: String(order.updatedAt ?? ""), source: "updatedAt" };
}

function ageBand(days) {
  if (days === null) return "sin fecha";
  if (days <= 7) return "7 dias o menos";
  if (days <= 30) return "8 a 30 dias";
  if (days <= 60) return "31 a 60 dias";
  return "Mas de 60 dias";
}
const AGE_BANDS = ["7 dias o menos", "8 a 30 dias", "31 a 60 dias", "Mas de 60 dias", "sin fecha"];

function ageTable(rows, lines) {
  const byBand = groupBy(rows, (row) => ageBand(row.ageDays));
  lines.push("  | Antiguedad | Pedidos | Recaudo | Efectivo esperado |");
  for (const band of AGE_BANDS) {
    const items = byBand[band] || [];
    if (items.length === 0 && band === "sin fecha") continue;
    lines.push(`  | ${band} | ${items.length} | ${cop(sumBy(items, (r) => r.collectedCop))} | ${cop(sumBy(items, (r) => r.expectedCashCop))} |`);
  }
  lines.push(`  | Total | ${rows.length} | ${cop(sumBy(rows, (r) => r.collectedCop))} | ${cop(sumBy(rows, (r) => r.expectedCashCop))} |`);
}

async function baseline() {
  const now = new Date();
  const nowMs = now.getTime();
  const reader = createReader();
  const lines = [];
  const say = (text = "") => lines.push(text);

  // ---- Lecturas del modo resumen y del modo con conciliacion (plan 4.3) ----
  const ORDER_FIELDS = ["trackingCode", "sellerId", "driverId", "messengerId", "status", "paymentMethod", "totalCop", "closedAt", "updatedAt", "createdAt", "evidence"];
  const orders = await reader.read(
    "orders cod delivered|liquidated (select)",
    db.collection("orders").where("paymentMethod", "==", "cod").where("status", "in", ["delivered", "liquidated"]).select(...ORDER_FIELDS)
  );
  const settlements = await reader.read("settlements kind==driver", db.collection("settlements").where("kind", "==", "driver"));
  const receivableEntries = await reader.read(
    "walletEntries cod_revenue|cod_remittance|driver_earning (full)",
    db.collection("walletEntries").where("type", "in", ["cod_revenue", "cod_remittance", "driver_earning"])
  );

  const received = buildCodReceivedSet(settlements);
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const candidates = orders.filter((order) => !received.has(order.id));

  // Modo resumen: asientos por pedido, solo de los no recibidos, por lotes de 30 (plan 4.3 paso 4).
  const targetedStart = Date.now();
  const targetedBatches = await Promise.all(
    chunks(candidates.map((order) => order.id), IN_BATCH).map((ids, index) =>
      reader.read(`walletEntries orderId in (lote ${index + 1})`, db.collection("walletEntries").where("orderId", "in", ids))
    )
  );
  const targetedMs = Date.now() - targetedStart;
  const targetedEntries = targetedBatches.flat();
  const productCostOfCandidates = targetedEntries.filter((entry) => entry.type === "product_cost" && entry.ownerType === "seller");
  const [productCostTotal, sellers, drivers, messengers] = await Promise.all([
    db.collection("walletEntries").where("type", "==", "product_cost").count().get().then((snap) => snap.data().count),
    reader.read("sellers (nombres)", db.collection("sellers").select("name")),
    reader.read("drivers (nombres)", db.collection("drivers").select("name")),
    reader.read("messengers (nombres)", db.collection("messengers").select("name"))
  ]);
  const nameOf = new Map([...sellers, ...drivers, ...messengers].map((doc) => [doc.id, doc.name || doc.id]));

  const sellerEntries = receivableEntries.filter((entry) => entry.ownerType === "seller" && (entry.type === "cod_revenue" || entry.type === "cod_remittance"));
  const driverEntries = receivableEntries.filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning");
  const codByOrder = groupBy(sellerEntries, (entry) => String(entry.orderId ?? ""));
  const payByOrder = groupBy(driverEntries, (entry) => String(entry.orderId ?? ""));
  const settlementsByOrder = settlements.reduce((acc, settlement) => {
    for (const orderId of new Set(settlement.orderIds ?? [])) (acc[orderId] ||= []).push(settlement);
    return acc;
  }, {});

  // ---- Filas: contraentregas entregadas sin efectivo recibido ----
  const allRows = candidates.map((order) => {
    const codEntries = codByOrder[order.id] || [];
    const hasCod = codEntries.length > 0;
    const collectedCop = hasCod ? sumBy(codEntries, (e) => e.amountCop) : num(order.totalCop);
    const driverPayCop = sumBy(payByOrder[order.id] || [], (e) => e.amountCop);
    const containing = settlementsByOrder[order.id] || [];
    const delivered = deliveredAtOf(order, codEntries);
    return {
      orderId: order.id,
      trackingCode: order.trackingCode || order.id,
      sellerId: order.sellerId || null,
      leaderId: order.driverId || null,
      leaderName: order.driverId ? nameOf.get(order.driverId) || order.driverId : null,
      status: order.status,
      deliveredAt: delivered.at,
      deliveredAtSource: delivered.source,
      ageDays: ageDaysOf(delivered.at, nowMs),
      updatedAgeDays: ageDaysOf(order.updatedAt, nowMs),
      collectedCop,
      collectedSource: hasCod ? "wallet" : "order_total",
      driverPayCop,
      expectedCashCop: Math.max(0, collectedCop - driverPayCop),
      location: locationOf(containing),
      settlementIds: containing.map((s) => s.id)
    };
  });
  const rows = allRows.filter((row) => row.location !== "covered_by_netting");
  const nettedRows = allRows.filter((row) => row.location === "covered_by_netting");

  // ---- Compensacion: misma metrica que la spec (cortes pagados/conciliados con recibido == esperado y
  // pendiente 0; asignaciones covered:false), y el criterio del plan 2.9 sobre el universo ----
  const specNettingSettlements = settlements.filter(
    (s) =>
      (s.status === "paid" || s.status === "reconciled") &&
      typeof s.cashExpectedCop === "number" &&
      settlementCashReceivedCop(s) === s.cashExpectedCop &&
      num(s.cashPendingCop) === 0
  );
  const specUncovered = specNettingSettlements.flatMap((s) =>
    (Array.isArray(s.cashAllocations) ? s.cashAllocations : []).filter((a) => !a.covered).map((a) => ({ settlementId: s.id, ...a }))
  );
  const specUncoveredOrderIds = Array.from(new Set(specUncovered.map((a) => String(a.orderId))));
  const specSettlementsWithUncovered = new Set(specUncovered.map((a) => a.settlementId));
  const specMetrics = {
    allocationExpectedCop: sumBy(specUncovered, (a) => a.expectedCop),
    allocationReceivedCop: sumBy(specUncovered, (a) => a.receivedCop),
    allocationPendingCop: sumBy(specUncovered, (a) => num(a.expectedCop) - num(a.receivedCop)),
    collectedCop: specUncoveredOrderIds.reduce((total, id) => total + sumBy(codByOrder[id] || [], (e) => e.amountCop), 0),
    expectedFromWalletCop: specUncoveredOrderIds.reduce(
      (total, id) => total + Math.max(0, sumBy(codByOrder[id] || [], (e) => e.amountCop) - sumBy(payByOrder[id] || [], (e) => e.amountCop)),
      0
    )
  };
  const UNIT_LABELS = {
    allocationExpectedCop: "efectivo esperado por pedido (cashAllocations.expectedCop)",
    allocationPendingCop: "pendiente sin asignar por pedido (expectedCop - receivedCop de la asignacion)",
    collectedCop: "recaudo (cod_revenue + cod_remittance)",
    expectedFromWalletCop: "efectivo esperado recalculado de los asientos (cod - pago)"
  };
  const unitMatches = Object.keys(UNIT_LABELS).filter((key) => Math.round(specMetrics[key]) === REFERENCE_NETTING.amountCop);

  const plan29Settlements = settlements.filter(isDriverSettlementCashSettledLocal);
  const nettedSettlementIds = new Set(nettedRows.flatMap((row) => row.settlementIds.filter((id) => plan29Settlements.some((s) => s.id === id))));
  const excessSettlements = plan29Settlements.filter((s) => settlementCashReceivedCop(s) > s.cashExpectedCop);
  const nettedExcess = [...nettedSettlementIds].filter((id) => excessSettlements.some((s) => s.id === id));

  // ---- Cortes: pendiente ausente y pendiente distinto del recalculado (plan 4.4, hallazgo B) ----
  const orderMeta = new Map(orders.map((order) => [order.id, { paymentMethod: order.paymentMethod, status: order.status, createdAt: order.createdAt, trackingCode: order.trackingCode }]));
  const cashInputs = { sellerEntries, driverEntries, orderMeta };
  const settlementChecks = settlements.map((s) => {
    const receivedCop = settlementCashReceivedCop(s);
    const summary = computeDriverCashSummary(cashInputs, s.orderIds ?? [], receivedCop);
    const recalculatedPendingCop = Math.max(0, summary.expectedCop - receivedCop);
    const hasField = typeof s.cashPendingCop === "number";
    return {
      id: s.id,
      ownerName: s.ownerName,
      status: s.status,
      createdAt: s.createdAt,
      storedPendingCop: hasField ? s.cashPendingCop : null,
      recalculatedPendingCop,
      hasField
    };
  });
  const missingPending = settlementChecks.filter((c) => !c.hasField);
  const stalePending = settlementChecks.filter((c) => c.hasField && Math.round(c.storedPendingCop) !== Math.round(c.recalculatedPendingCop));

  // ---- Otros conteos del plan 5.3 ----
  const driverEntriesWithoutSettlement = driverEntries.filter((entry) => !entry.settlementId);
  const position = computePlatformPosition(receivableEntries, settlements);

  // ---- Coste de lectura de los dos modos (plan 4.3) ----
  const docsOf = (prefix) => reader.log.filter((item) => item.label.startsWith(prefix)).reduce((total, item) => total + item.docs, 0);
  const msOf = (prefix) => reader.log.filter((item) => item.label.startsWith(prefix)).reduce((total, item) => total + item.ms, 0);
  const commonDocs = docsOf("orders") + docsOf("settlements") + docsOf("sellers") + docsOf("drivers") + docsOf("messengers");
  const summaryDocs = commonDocs + targetedEntries.length;
  const fullDocs = commonDocs + receivableEntries.length + productCostOfCandidates.length;

  // ---- Evidencia legible ----
  say(`Spec 026 · T1 · linea base contra produccion (SOLO LECTURA)`);
  say(`Generado: ${now.toISOString()}  ·  comando: node scripts/verify-026.js baseline`);
  say(`Logica: functions/lib (buildCodReceivedSet, computeDriverCashSummary, settlementCashReceivedCop, computePlatformPosition);`);
  say(`        isDriverSettlementCashSettled reproducido localmente hasta que T4 lo cree (plan 2.9).`);
  say();
  say(`1. Universo`);
  say(`  Contraentregas delivered|liquidated: ${orders.length} (${Object.entries(countBy(orders, (o) => o.status)).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  say(`  Recibidas segun buildCodReceivedSet: ${orders.length - candidates.length}`);
  say(`  Sin efectivo recibido (rows + nettedRows): ${allRows.length}, recaudo ${cop(sumBy(allRows, (r) => r.collectedCop))}`);
  say(`    rows (efectivo que falta): ${rows.length}, recaudo ${cop(sumBy(rows, (r) => r.collectedCop))}, esperado ${cop(sumBy(rows, (r) => r.expectedCashCop))}`);
  say(`    nettedRows (cubiertos por compensacion): ${nettedRows.length}, recaudo ${cop(sumBy(nettedRows, (r) => r.collectedCop))}, esperado ${cop(sumBy(nettedRows, (r) => r.expectedCashCop))}`);
  say(`  Por ubicacion: ${Object.entries(countBy(allRows, (r) => r.location)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  say(`  Recaudo por ubicacion: ${Object.entries(groupBy(allRows, (r) => r.location)).map(([k, v]) => `${k} ${cop(sumBy(v, (r) => r.collectedCop))}`).join(", ")}`);
  say(`  Fuente del recaudo: ${Object.entries(countBy(allRows, (r) => r.collectedSource)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  say(`  Neto <= 0 (recaudo <= pago del domiciliario): ${allRows.filter((r) => r.collectedCop - r.driverPayCop <= 0).length}`);
  say();
  say(`2. Fuente de deliveredAt (plan 2.3)`);
  say(`  ${Object.entries(countBy(allRows, (r) => r.deliveredAtSource)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  say();
  say(`3. Antiguedad desde la entrega (deliveredAt)`);
  say(`  Todos los no recibidos (comparable con la tabla de la spec: 153 / $14.557.721):`);
  ageTable(allRows, lines);
  say(`  Solo rows (sin los cubiertos por compensacion):`);
  ageTable(rows, lines);
  say();
  const rowsOver30 = rows.filter((r) => r.ageDays !== null && r.ageDays > OVER_DAYS);
  const rowsOver30ByUpdated = rows.filter((r) => r.updatedAgeDays !== null && r.updatedAgeDays > OVER_DAYS);
  const allOver30 = allRows.filter((r) => r.ageDays !== null && r.ageDays > OVER_DAYS);
  say(`4. Compuerta: filas de mas de ${OVER_DAYS} dias (plan 5.4)`);
  say(`  No recibidos > ${OVER_DAYS} dias por deliveredAt: ${allOver30.length} (${cop(sumBy(allOver30, (r) => r.collectedCop))} recaudo); de ellos covered_by_netting ${allOver30.filter((r) => r.location === "covered_by_netting").length}`);
  say(`  rows > ${OVER_DAYS} dias por deliveredAt: ${rowsOver30.length} (${cop(sumBy(rowsOver30, (r) => r.collectedCop))})`);
  say(`  rows > ${OVER_DAYS} dias por updatedAt: ${rowsOver30ByUpdated.length} (${cop(sumBy(rowsOver30ByUpdated, (r) => r.collectedCop))})`);
  say(`  Lideres de los no recibidos > ${OVER_DAYS} dias: ${Object.entries(countBy(allOver30, (r) => r.leaderName || "(sin lider)")).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  say(`  COMPUERTA >30 dias (rows por updatedAt): ${rowsOver30ByUpdated.length === 0 ? "CUMPLE (0 filas)" : `REPORTAR ANTES DE T7 (${rowsOver30ByUpdated.length} filas)`}`);
  for (const row of rowsOver30ByUpdated) {
    say(`    ${row.trackingCode} ${row.orderId} · ${row.location} · entrega ${row.deliveredAt.slice(0, 10)} (${row.deliveredAtSource}) · ${row.ageDays} d · updatedAt ${row.updatedAgeDays} d · ${row.leaderName || "-"} · ${cop(row.collectedCop)}`);
  }
  say();
  say(`5. Cubiertos por compensacion`);
  say(`  a) Misma metrica que la spec (cortes paid|reconciled con recibido == esperado y cashPendingCop 0;`);
  say(`     asignaciones covered:false):`);
  say(`     cortes que cumplen: ${specNettingSettlements.length}; con alguna asignacion sin cubrir: ${specSettlementsWithUncovered.size}`);
  say(`     pedidos sin cubrir: ${specUncoveredOrderIds.length} (asignaciones ${specUncovered.length})`);
  for (const key of Object.keys(UNIT_LABELS)) say(`     ${UNIT_LABELS[key]}: ${cop(specMetrics[key])}`);
  say(`     UNIDAD de ${cop(REFERENCE_NETTING.amountCop)}: ${unitMatches.length > 0 ? unitMatches.map((key) => UNIT_LABELS[key]).join(" = ") : "NINGUNA de las metricas coincide hoy"}`);
  const sameAsSpec =
    specSettlementsWithUncovered.size === REFERENCE_NETTING.settlements &&
    specUncoveredOrderIds.length === REFERENCE_NETTING.orders &&
    unitMatches.length > 0;
  say(`     COMPUERTA 29 / 36 / $1.151.997: ${sameAsSpec ? "CUMPLE" : `DIFIERE (hoy ${specSettlementsWithUncovered.size} / ${specUncoveredOrderIds.length}) — REPORTAR ANTES DE T7`}`);
  say(`  b) Criterio del plan 2.9 (isDriverSettlementCashSettled, >=) sobre el universo no recibido:`);
  say(`     cortes saldados en total: ${plan29Settlements.length}; con excedente (recibido > esperado): ${excessSettlements.length}`);
  say(`     cortes que contienen algun pedido covered_by_netting: ${nettedSettlementIds.size} (con excedente: ${nettedExcess.length})`);
  say(`     pedidos covered_by_netting: ${nettedRows.length}; recaudo ${cop(sumBy(nettedRows, (r) => r.collectedCop))}; esperado ${cop(sumBy(nettedRows, (r) => r.expectedCashCop))}`);
  const onlyInSpec = specUncoveredOrderIds.filter((id) => !nettedRows.some((r) => r.orderId === id));
  const onlyInPlan = nettedRows.filter((r) => !specUncoveredOrderIds.includes(r.orderId)).map((r) => r.orderId);
  say(`     diferencia de conjuntos a) vs b): solo en a) ${onlyInSpec.length}${onlyInSpec.length ? ` [${onlyInSpec.join(", ")}]` : ""}; solo en b) ${onlyInPlan.length}${onlyInPlan.length ? ` [${onlyInPlan.join(", ")}]` : ""}`);
  for (const id of onlyInSpec) {
    const order = ordersById.get(id);
    say(`       ${id}: ${!order ? "no esta en el universo cod delivered|liquidated" : received.has(id) ? "recibido por otro corte (buildCodReceivedSet)" : "otra ubicacion por precedencia"}`);
  }
  for (const id of onlyInPlan) {
    const row = nettedRows.find((r) => r.orderId === id);
    // computeDriverCashSummary solo asigna a pedidos con efectivo esperado > 0: uno con neto <= 0 no
    // tiene asignacion, asi que no esta en a) pero tampoco en buildCodReceivedSet.
    const reason = row.expectedCashCop === 0 ? "efectivo esperado 0 (neto <= 0): sin asignacion en cashAllocations, nunca 'covered'" : "con asignacion cubierta en otro corte o sin asignacion";
    say(`       ${id}: recaudo ${cop(row.collectedCop)}, esperado ${cop(row.expectedCashCop)} — ${reason}`);
  }
  say();
  say(`6. Cortes de domiciliario (${settlements.length}; ${Object.entries(countBy(settlements, (s) => s.status)).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  say(`  Sin cashPendingCop (hallazgo B): ${missingPending.length}; recalculado ${cop(sumBy(missingPending, (c) => c.recalculatedPendingCop))}`);
  for (const c of missingPending) say(`    ${c.id} · ${c.status} · ${c.ownerName || "-"} · ${String(c.createdAt || "").slice(0, 10)} · recalculado ${cop(c.recalculatedPendingCop)}`);
  say(`  Con cashPendingCop distinto del recalculado (computeDriverCashSummary): ${stalePending.length}; guardado ${cop(sumBy(stalePending, (c) => c.storedPendingCop))} vs recalculado ${cop(sumBy(stalePending, (c) => c.recalculatedPendingCop))}`);
  for (const c of stalePending) say(`    ${c.id} · ${c.status} · ${c.ownerName || "-"} · guardado ${cop(c.storedPendingCop)} · recalculado ${cop(c.recalculatedPendingCop)}`);
  say(`  Asientos driver_earning sin settlementId: ${driverEntriesWithoutSettlement.length} (${cop(sumBy(driverEntriesWithoutSettlement, (e) => e.amountCop))})`);
  say(`  driverReceivableCop de la posicion (computePlatformPosition con los mismos asientos): ${cop(position.driverReceivableCop)}`);
  say(`    efectivo esperado de rows: ${cop(sumBy(rows, (r) => r.expectedCashCop))} (la conciliacion por causas es T9/T18)`);
  say();
  say(`7. Coste de lectura (plan 4.3; T2 cronometra la carga completa)`);
  for (const item of reader.log) say(`  ${item.label}: ${item.docs} docs, ${item.ms} ms`);
  say(`  product_cost (count() de la coleccion, no descargado): ${productCostTotal}; de los no recibidos: ${productCostOfCandidates.length}`);
  say(`  Modo resumen (targeted): ${summaryDocs} docs (orders + settlements + nombres + asientos por orderId en ${targetedBatches.length} lotes, ${targetedMs} ms en paralelo)`);
  say(`  Modo con conciliacion (full): ${fullDocs} docs (orders + settlements + nombres + cod/driver_earning enteros ${receivableEntries.length} + product_cost de los no recibidos)`);
  say(`  Lectura secuencial medida: orders ${msOf("orders")} ms, settlements ${msOf("settlements")} ms, asientos full ${msOf("walletEntries cod")} ms`);
  say(`  COMPUERTA coste: resumen ${summaryDocs <= COST_LIMITS.summaryDocs ? "CUMPLE" : "SUPERA"} (<= ${COST_LIMITS.summaryDocs} docs); con conciliacion ${fullDocs <= COST_LIMITS.fullDocs ? "CUMPLE" : "SUPERA"} (<= ${COST_LIMITS.fullDocs} docs); los 3 s los mide T2`);
  say();
  say(`Ids en t1-linea-base-ids.json: over30Days ${allOver30.length}, coveredByNetting ${nettedRows.length}, rows ${rows.length}`);

  const idRecord = (row) => ({
    orderId: row.orderId,
    trackingCode: row.trackingCode,
    location: row.location,
    leaderId: row.leaderId,
    deliveredAt: row.deliveredAt,
    deliveredAtSource: row.deliveredAtSource,
    ageDays: row.ageDays,
    updatedAgeDays: row.updatedAgeDays,
    collectedCop: row.collectedCop,
    expectedCashCop: row.expectedCashCop,
    settlementIds: row.settlementIds
  });
  const idsPayload = {
    generatedAt: now.toISOString(),
    over30Days: allOver30.map(idRecord),
    coveredByNetting: nettedRows.map(idRecord),
    rows: rows.map(idRecord)
  };

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(TXT_FILE, `${lines.join("\n")}\n`);
  fs.writeFileSync(IDS_FILE, `${JSON.stringify(idsPayload, null, 2)}\n`);
  console.log(lines.join("\n"));
  console.log(`\nEvidencias: ${path.relative(process.cwd(), TXT_FILE)}, ${path.relative(process.cwd(), IDS_FILE)}`);
}

/**
 * Lanza una consulta con limit(1) y dice si Firestore exige indice. Un indice que falta llega como
 * FAILED_PRECONDITION (codigo 9) con el enlace de creacion en el mensaje; cualquier otro error se relanza.
 */
async function probeQuery(label, query) {
  const started = Date.now();
  try {
    const snap = await query.limit(1).get();
    return { label, needsIndex: false, docs: snap.size, ms: Date.now() - started, link: null };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const isMissingIndex = (error && (error.code === 9 || error.code === "failed-precondition")) || /FAILED_PRECONDITION/.test(message);
    if (!isMissingIndex) throw error;
    const link = (message.match(/https:\/\/console\.firebase\.google\.com\S+/) || [null])[0];
    return { label, needsIndex: true, docs: 0, ms: Date.now() - started, link };
  }
}

/** Descarga contada (docs y ms) de una consulta completa, sin limite. */
async function timedRead(log, label, query) {
  const started = Date.now();
  const snap = await query.get();
  log.push({ label, docs: snap.size, ms: Date.now() - started });
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

const QC_ORDER_FIELDS = ["trackingCode", "sellerId", "driverId", "messengerId", "status", "paymentMethod", "totalCop", "closedAt", "updatedAt", "createdAt", "evidence"];
const qcCodOrders = () => db.collection("orders").where("paymentMethod", "==", "cod").where("status", "in", ["delivered", "liquidated"]);
const qcNames = (collection) => db.collection(collection).select("name");

/**
 * Una carga completa como la hara el cargador (plan 4.3), cronometrada de punta a punta.
 * scope: { kind: "admin", includeReconciliation } | { kind: "leader", driverId } (siempre resumen).
 */
async function loadLikeTheLoader(scope) {
  const log = [];
  const isLeader = scope.kind === "leader";
  const ordersQuery = isLeader ? qcCodOrders().where("driverId", "==", scope.driverId) : qcCodOrders();
  const settlementsQuery = isLeader
    ? db.collection("settlements").where("kind", "==", "driver").where("ownerId", "==", scope.driverId)
    : db.collection("settlements").where("kind", "==", "driver");
  const nameCollections = isLeader ? ["sellers", "messengers"] : ["sellers", "drivers", "messengers", "suppliers"];
  const [orders, settlements] = await Promise.all([
    timedRead(log, "orders", ordersQuery.select(...QC_ORDER_FIELDS)),
    timedRead(log, "settlements", settlementsQuery),
    db.collection("settings").doc("cashAlerts").get().then((snap) => log.push({ label: "settings/cashAlerts", docs: snap.exists ? 1 : 0, ms: 0 })),
    ...nameCollections.map((collection) => timedRead(log, `${collection} (nombres)`, qcNames(collection)))
  ]);
  const received = buildCodReceivedSet(settlements);
  const candidateIds = orders.filter((order) => !received.has(order.id)).map((order) => order.id);
  const isFull = scope.kind === "admin" && scope.includeReconciliation;
  const lots = chunks(candidateIds, IN_BATCH);
  if (isFull) {
    await Promise.all([
      timedRead(log, "walletEntries seller cod_revenue|cod_remittance", db.collection("walletEntries").where("ownerType", "==", "seller").where("type", "in", ["cod_revenue", "cod_remittance"])),
      timedRead(log, "walletEntries driver driver_earning", db.collection("walletEntries").where("ownerType", "==", "driver").where("type", "==", "driver_earning")),
      ...lots.map((ids, index) =>
        timedRead(log, `walletEntries product_cost orderId in (lote ${index + 1})`, db.collection("walletEntries").where("type", "==", "product_cost").where("orderId", "in", ids))
      )
    ]);
  } else {
    await Promise.all(
      lots.map((ids, index) => timedRead(log, `walletEntries orderId in (lote ${index + 1})`, db.collection("walletEntries").where("orderId", "in", ids)))
    );
  }
  return { docs: log.reduce((total, item) => total + item.docs, 0), candidates: candidateIds.length, lots: lots.length, log };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Detalle de una carga: docs por consulta; de los lotes en paralelo, la suma de docs y el mas lento. */
function describeLoad(say, name, stat, list) {
  say(`  Modo ${name}: ${stat.docs} docs, mediana ${stat.msMedian} ms, maximo ${stat.msMax} ms (rondas: ${stat.msAll.join(" / ")} ms)`);
  const last = list[list.length - 1];
  say(`    candidatos no recibidos ${last.candidates}, lotes de ${IN_BATCH}: ${last.lots}`);
  const grouped = last.log.reduce((acc, item) => {
    const key = item.label.replace(/ \(lote \d+\)$/, " (lotes)");
    acc[key] = acc[key] || { docs: 0, ms: 0, n: 0 };
    acc[key].docs += item.docs;
    acc[key].ms = Math.max(acc[key].ms, item.ms);
    acc[key].n += 1;
    return acc;
  }, {});
  for (const [label, value] of Object.entries(grouped)) {
    say(`    ${label}: ${value.docs} docs, ${value.ms} ms${value.n > 1 ? ` (el mas lento de ${value.n}, en paralelo)` : ""}`);
  }
}

async function queryCheck() {
  const now = new Date();
  const lines = [];
  const say = (text = "") => lines.push(text);
  const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "t2-query-check.txt");
  /** Umbrales de la compuerta (plan 4.3 / 5.4). */
  const LIMITS = { summaryDocs: 20_000, fullDocs: 30_000, ms: 3_000 };
  const RUNS = 3;

  // Datos reales para parametrizar las consultas: el lider con mas contraentregas y un lote de ids no recibidos.
  const drivers = (await db.collection("drivers").select("name").get()).docs;
  const leaderCounts = await Promise.all(
    drivers.map(async (doc) => ({
      id: doc.id,
      name: doc.get("name") || doc.id,
      count: (await qcCodOrders().where("driverId", "==", doc.id).count().get()).data().count
    }))
  );
  const leader = leaderCounts.sort((a, b) => b.count - a.count)[0];
  const driverSettlements = (await db.collection("settlements").where("kind", "==", "driver").get()).docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const receivedNow = buildCodReceivedSet(driverSettlements);
  const sampleIds = (await qcCodOrders().select().get()).docs.map((doc) => doc.id).filter((id) => !receivedNow.has(id)).slice(0, IN_BATCH);

  // ---- 1. Cada consulta del cargador con limit(1): pide indice? ----
  const probes = [
    ["ambos", "orders paymentMethod==cod, status in [delivered, liquidated] (select) - admin", qcCodOrders().select(...QC_ORDER_FIELDS)],
    ["ambos", "orders paymentMethod==cod, status in [...], driverId==<lider> (select) - lider", qcCodOrders().where("driverId", "==", leader.id).select(...QC_ORDER_FIELDS)],
    ["ambos", "settlements kind==driver - admin", db.collection("settlements").where("kind", "==", "driver")],
    ["ambos", "settlements kind==driver, ownerId==<lider> - lider", db.collection("settlements").where("kind", "==", "driver").where("ownerId", "==", leader.id)],
    ["ambos", "sellers (select name)", qcNames("sellers")],
    ["ambos", "drivers (select name)", qcNames("drivers")],
    ["ambos", "messengers (select name)", qcNames("messengers")],
    ["ambos", "suppliers (select name)", qcNames("suppliers")],
    ["resumen", `walletEntries orderId in [${sampleIds.length} ids no recibidos]`, db.collection("walletEntries").where("orderId", "in", sampleIds)],
    ["conciliacion", "walletEntries ownerType==seller, type in [cod_revenue, cod_remittance]", db.collection("walletEntries").where("ownerType", "==", "seller").where("type", "in", ["cod_revenue", "cod_remittance"])],
    ["conciliacion", "walletEntries ownerType==driver, type==driver_earning", db.collection("walletEntries").where("ownerType", "==", "driver").where("type", "==", "driver_earning")],
    ["conciliacion", `walletEntries type==product_cost, orderId in [${sampleIds.length} ids no recibidos]`, db.collection("walletEntries").where("type", "==", "product_cost").where("orderId", "in", sampleIds)],
    ["conciliacion", "walletEntries type in [cod_revenue, cod_remittance, driver_earning] (forma usada en T1)", db.collection("walletEntries").where("type", "in", ["cod_revenue", "cod_remittance", "driver_earning"])]
  ];
  const probeResults = [];
  for (const [mode, label, query] of probes) probeResults.push({ mode, ...(await probeQuery(label, query)) });
  const missingIndexes = probeResults.filter((probe) => probe.needsIndex);

  // ---- 2. Carga completa de cada modo, intercalada (resumen, conciliacion, lider) RUNS veces ----
  const runs = { resumen: [], conciliacion: [], lider: [] };
  const timedLoad = async (scope) => {
    const started = Date.now();
    const load = await loadLikeTheLoader(scope);
    return { ...load, ms: Date.now() - started };
  };
  if (missingIndexes.length === 0) {
    for (let round = 0; round < RUNS; round += 1) {
      runs.resumen.push(await timedLoad({ kind: "admin", includeReconciliation: false }));
      runs.conciliacion.push(await timedLoad({ kind: "admin", includeReconciliation: true }));
      runs.lider.push(await timedLoad({ kind: "leader", driverId: leader.id }));
    }
  }
  const stats = (list) =>
    list.length === 0
      ? { docs: 0, msMedian: 0, msMax: 0, msAll: [] }
      : { docs: list[list.length - 1].docs, msMedian: median(list.map((run) => run.ms)), msMax: Math.max(...list.map((run) => run.ms)), msAll: list.map((run) => run.ms) };
  const summary = stats(runs.resumen);
  const reconciliation = stats(runs.conciliacion);
  const leaderStats = stats(runs.lider);
  const summaryOk = summary.docs <= LIMITS.summaryDocs && summary.msMedian <= LIMITS.ms;
  const reconciliationOk = reconciliation.docs <= LIMITS.fullDocs && reconciliation.msMedian <= LIMITS.ms;
  const leaderOk = leaderStats.docs <= LIMITS.summaryDocs && leaderStats.msMedian <= LIMITS.ms;

  // ---- Evidencia ----
  say(`Spec 026 · T2 · query-check contra produccion (SOLO LECTURA)`);
  say(`Generado: ${now.toISOString()}  ·  comando: node scripts/verify-026.js query-check`);
  say(`Lider usado para las consultas de alcance lider: ${leader.name} (${leader.id}, ${leader.count} contraentregas entregadas)`);
  say(`Lote de prueba de orderId in: ${sampleIds.length} ids no recibidos (buildCodReceivedSet de functions/lib)`);
  say();
  say(`1. Consultas del cargador con limit(1) (plan 4.3); si Firestore exige indice responde FAILED_PRECONDITION`);
  for (const probe of probeResults) {
    say(`  [${probe.mode}] ${probe.label}: ${probe.needsIndex ? "PIDE INDICE" : "OK sin indice nuevo"} (${probe.docs} docs, ${probe.ms} ms)`);
    if (probe.link) say(`      ${probe.link}`);
  }
  say(`  Indices que faltan: ${missingIndexes.length === 0 ? "ninguno (firestore.indexes.json no se toca, plan 7)" : `${missingIndexes.length}; cargas completas NO cronometradas hasta desplegarlos`}`);
  say();
  say(`2. Carga completa de cada modo, de punta a punta, ${RUNS} rondas intercaladas (cronometro Date.now, ms por ronda)`);
  if (missingIndexes.length === 0) {
    describeLoad(say, "resumen (admin, includeReconciliation: false)", summary, runs.resumen);
    describeLoad(say, "con conciliacion (admin, includeReconciliation: true)", reconciliation, runs.conciliacion);
    describeLoad(say, `resumen del lider (${leader.name})`, leaderStats, runs.lider);
  }
  say();
  say(`3. Compuerta de coste (plan 4.3 / 5.4; veredicto sobre la mediana)`);
  say(`  resumen: ${summary.docs} docs (umbral ${LIMITS.summaryDocs}), ${summary.msMedian} ms (umbral ${LIMITS.ms} ms) -> ${summaryOk ? "CUMPLE" : "SUPERA: Fase 2 (cola materializada) antes de T12"}`);
  say(`  con conciliacion: ${reconciliation.docs} docs (umbral ${LIMITS.fullDocs}), ${reconciliation.msMedian} ms (umbral ${LIMITS.ms} ms) -> ${reconciliationOk ? "CUMPLE" : "SUPERA: conciliacion diaria guardada, decision del responsable antes de T12"}`);
  say(`  resumen del lider: ${leaderStats.docs} docs, ${leaderStats.msMedian} ms -> ${leaderOk ? "CUMPLE" : "SUPERA"}`);
  say(`  indices: ${missingIndexes.length === 0 ? "CUMPLE (ninguno nuevo)" : "ANADIR a firestore.indexes.json y desplegar indices ANTES de functions (plan 8)"}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nEvidencia: ${path.relative(process.cwd(), EVIDENCE_FILE)}`);
}

// ---------------------------------------------------------------------------------------------------
// T18 — compare: posicion de la plataforma y linea base (RNF_02, DoD 3 y 4; plan 4.4, 5.3)
// ---------------------------------------------------------------------------------------------------

const COMPARE_FILE = path.join(EVIDENCE_DIR, "t18-compare.txt");
const CALLABLE_BASE_URL = "https://us-central1-kentro-last-mile.cloudfunctions.net";
const CREDENTIAL_VARS = ["VERIFY_026_ADMIN_EMAIL", "VERIFY_026_ADMIN_PASSWORD"];
const UNREADABLE_KEYS = ["unreadableOrderIds", "unreadableSettlementIds", "unreadableEntryIds"];

/** Grupo de un id en la linea base (t1-linea-base-ids.json) o en el informe actual. */
function groupOf(orderId, nettedIds, rowIds) {
  if (nettedIds.has(orderId)) return "netted";
  if (rowIds.has(orderId)) return "rows";
  return "absent";
}

/**
 * Motivo comprobado de un cambio de grupo (plan 5.3). null = sin motivo, y eso hace fallar.
 * `current` es la fila actual (para la fecha de entrega de un pedido nuevo).
 */
function reasonOf(change, context) {
  const { orderId, from, to } = change;
  if (to === "netted") return "netted";
  if (to === "absent") {
    if (context.unreadable.has(orderId)) return "unreadable";
    if (context.received.has(orderId)) return "received";
    if (!context.universe.has(orderId)) return "status_corrected";
    return null;
  }
  // to === "rows"
  if (from === "absent") {
    const deliveredMs = Date.parse(String(change.current?.deliveredAt ?? ""));
    return Number.isFinite(deliveredMs) && deliveredMs > context.baselineMs ? "new_order" : null;
  }
  // netted -> rows: un compensado no vuelve a deberse sin motivo.
  return null;
}

/**
 * Regla de paso de T18. PURA: sin Firestore ni red. Ver el contrato en el bloque T18 de
 * src/lib/spec-026-guards.test.ts.
 */
function evaluateCompare(input) {
  const { reconciliation, position, report, baseline, evidence } = input;
  const failures = [];

  // ---- DoD 4: conciliacion con la posicion ----
  if (!reconciliation) {
    failures.push("Sin conciliacion (reconciliation null): el informe no se pidio con includeReconciliation/coverage full.");
  } else {
    if (reconciliation.unexplainedCop !== 0) {
      const ids = reconciliation.unexplainedOrderIds ?? [];
      failures.push(`unexplainedCop = ${reconciliation.unexplainedCop} (debe ser 0)${ids.length ? `; pedidos: ${ids.join(", ")}` : ""}.`);
    }
    if (reconciliation.driverReceivableCop !== position.driverReceivableCop) {
      failures.push(
        `driverReceivableCop de la conciliacion (${reconciliation.driverReceivableCop}) distinto del de la posicion (${position.driverReceivableCop}).`
      );
    }
  }
  for (const key of UNREADABLE_KEYS) {
    const ids = report[key] ?? [];
    if (ids.length > 0) failures.push(`${key} no esta vacio (${ids.length}): ${ids.join(", ")}.`);
  }

  // stale y missing se listan por corte y no fallan.
  const causes = reconciliation ? reconciliation.causes : [];
  const bySettlement = (cause) =>
    causes.filter((item) => item.cause === cause).map((item) => ({ settlementId: String(item.settlementId ?? ""), amountCop: item.amountCop }));
  const stale = bySettlement("settlement_cash_pending_stale");
  const missing = bySettlement("settlement_cash_pending_missing");

  // ---- RF_09: lo compensado no vence ----
  const overdueNetted = report.nettedRows.filter((row) => row.isOverdue);
  if (overdueNetted.length > 0) {
    failures.push(`Compensados marcados como vencidos (RF_09): ${overdueNetted.map((row) => row.orderId).join(", ")}.`);
  }

  // ---- DoD 3: cambios de grupo contra la linea base ----
  const baselineNetted = new Set(baseline.coveredByNetting.map((item) => item.orderId));
  const baselineRows = new Set(baseline.rows.map((item) => item.orderId));
  const currentNetted = new Set(report.nettedRows.map((row) => row.orderId));
  const currentRows = new Set(report.rows.map((row) => row.orderId));
  const currentById = new Map([...report.rows, ...report.nettedRows].map((row) => [row.orderId, row]));
  const context = {
    unreadable: new Set(report.unreadableOrderIds ?? []),
    received: new Set(evidence.receivedOrderIds),
    universe: new Set(evidence.universeOrderIds),
    baselineMs: Date.parse(baseline.generatedAt)
  };
  const allIds = [...new Set([...baselineRows, ...baselineNetted, ...currentRows, ...currentNetted])];
  const changes = allIds
    .map((orderId) => ({
      orderId,
      from: groupOf(orderId, baselineNetted, baselineRows),
      to: groupOf(orderId, currentNetted, currentRows),
      current: currentById.get(orderId)
    }))
    .filter((change) => change.from !== change.to)
    .map((change) => ({ orderId: change.orderId, from: change.from, to: change.to, reason: reasonOf(change, context) }));
  const unexplainedChanges = changes.filter((change) => change.reason === null);
  if (unexplainedChanges.length > 0) {
    failures.push(
      `Cambios de grupo sin motivo contra t1-linea-base-ids.json: ${unexplainedChanges.map((c) => `${c.orderId} (${c.from} -> ${c.to})`).join(", ")}.`
    );
  }

  return { pass: failures.length === 0, failures, stale, missing, changes };
}

function readBaselineIds() {
  if (!fs.existsSync(IDS_FILE)) {
    throw new Error(`Falta la linea base ${path.relative(process.cwd(), IDS_FILE)}: correr antes "baseline" (T1).`);
  }
  return JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
}

/** Universo (contraentregas entregadas) y recibidos segun la regla compilada, para dar motivo a los cambios. */
function evidenceFrom(orderIds, settlements) {
  return { universeOrderIds: orderIds, receivedOrderIds: [...buildCodReceivedSet(settlements)] };
}

/**
 * Modo local: el mismo cargador y el mismo nucleo que el callable getCashOutstanding (compilados), y
 * la posicion con las MISMAS lecturas que el callable getPlatformPosition (que no exporta cargador:
 * las colecciones walletEntries y settlements enteras) pasadas a computePlatformPosition.
 */
async function loadCompareLocal() {
  const { loadCashOutstandingInput } = require(path.join(__dirname, "../functions/lib/cash-outstanding-api"));
  const { buildCashOutstandingReport } = require(path.join(__dirname, "../functions/lib/cash-outstanding"));
  const input = await loadCashOutstandingInput(db, {
    scope: { kind: "admin", includeReconciliation: true },
    coverage: "full",
    channelConfigured: null,
    now: new Date().toISOString()
  });
  const report = buildCashOutstandingReport(input);
  const [walletSnapshot, settlementSnapshot] = await Promise.all([db.collection("walletEntries").get(), db.collection("settlements").get()]);
  const position = computePlatformPosition(
    walletSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    settlementSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  );
  return {
    source: "local (functions/lib compilado + ADC, solo lectura)",
    report,
    position,
    evidence: evidenceFrom(input.orders.map((order) => order.id), input.settlements),
    readCounts: `walletEntries ${walletSnapshot.size}, settlements ${settlementSnapshot.size} (posicion); pedidos del universo ${input.orders.length}`
  };
}

/** API key web publica del cliente (src/lib/firebase/client.ts), sin copiarla aqui. */
function webApiKey() {
  const client = fs.readFileSync(path.join(__dirname, "../src/lib/firebase/client.ts"), "utf8");
  const key = (client.match(/apiKey:\s*"([^"]+)"/) || [])[1];
  if (!key) throw new Error("No se encontro apiKey en src/lib/firebase/client.ts");
  return key;
}

async function callCallable(name, idToken, data) {
  const response = await fetch(`${CALLABLE_BASE_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(`${name} respondio ${response.status}: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result;
}

/**
 * Modo --deployed: sesion real de admin y los callables desplegados getCashOutstanding y
 * getPlatformPosition. El universo y los recibidos (solo para dar motivo a los cambios) se leen por ADC.
 */
async function loadCompareDeployed(credentials) {
  const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password, returnSecureToken: true })
  }).then((response) => response.json());
  if (!signIn.idToken) throw new Error(`signInWithPassword fallo: ${JSON.stringify(signIn.error ?? signIn)}`);
  const [report, position, orderSnapshot, settlementSnapshot] = await Promise.all([
    callCallable("getCashOutstanding", signIn.idToken, { includeReconciliation: true }),
    callCallable("getPlatformPosition", signIn.idToken, null),
    db.collection("orders").where("paymentMethod", "==", "cod").where("status", "in", ["delivered", "liquidated"]).select().get(),
    db.collection("settlements").where("kind", "==", "driver").get()
  ]);
  return {
    source: `desplegado (callables getCashOutstanding y getPlatformPosition con sesion de ${credentials.email})`,
    report,
    position,
    evidence: evidenceFrom(
      orderSnapshot.docs.map((doc) => doc.id),
      settlementSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    ),
    readCounts: `pedidos del universo ${orderSnapshot.size}, cortes de domiciliario ${settlementSnapshot.size} (ADC, solo para motivos)`
  };
}

function renderCompare(loaded, baseline, result, isDeployed) {
  const { report, position } = loaded;
  const reconciliation = report.reconciliation;
  const lines = [];
  const say = (text = "") => lines.push(text);
  say(`Spec 026 · T18 · compare contra produccion (SOLO LECTURA)`);
  say(`Generado: ${new Date().toISOString()}  ·  comando: node scripts/verify-026.js compare${isDeployed ? " --deployed" : ""}`);
  say(`Fuente: ${loaded.source}`);
  say(`Lecturas: ${loaded.readCounts}`);
  say(`Linea base: t1-linea-base-ids.json (generada ${baseline.generatedAt}; rows ${baseline.rows.length}, coveredByNetting ${baseline.coveredByNetting.length}, over30Days ${baseline.over30Days.length})`);
  say();
  say(`VEREDICTO: ${result.pass ? "PASA" : "FALLA"}`);
  for (const failure of result.failures) say(`  - ${failure}`);
  say();
  say(`1. Regla de paso (DoD 4, plan 4.4)`);
  say(`  driverReceivableCop posicion (computePlatformPosition / getPlatformPosition): ${cop(position.driverReceivableCop)} (${position.driverReceivableCop})`);
  if (reconciliation) {
    say(`  driverReceivableCop conciliacion: ${cop(reconciliation.driverReceivableCop)} (${reconciliation.driverReceivableCop}) -> ${reconciliation.driverReceivableCop === position.driverReceivableCop ? "IGUAL" : "DISTINTO"}`);
    say(`  listOutstandingCop (lista): ${cop(reconciliation.listOutstandingCop)}; deltaCop: ${cop(reconciliation.deltaCop)}`);
    say(`  unexplainedCop: ${reconciliation.unexplainedCop}${reconciliation.unexplainedOrderIds.length ? ` (pedidos: ${reconciliation.unexplainedOrderIds.join(", ")})` : ""}`);
    say(`  Causas (suma por tipo):`);
    const byCause = reconciliation.causes.reduce((acc, item) => {
      acc[item.cause] = acc[item.cause] || { amountCop: 0, n: 0 };
      acc[item.cause].amountCop += item.amountCop;
      acc[item.cause].n += 1;
      return acc;
    }, {});
    for (const [cause, value] of Object.entries(byCause)) say(`    ${cause}: ${cop(value.amountCop)} (${value.n} partidas)`);
  } else {
    say(`  conciliacion: null`);
  }
  for (const key of UNREADABLE_KEYS) say(`  ${key}: ${(report[key] ?? []).length}`);
  say();
  say(`2. Cortes con pendiente guardado viejo o ausente (se reportan, NO fallan)`);
  say(`  stale (settlement_cash_pending_stale): ${result.stale.length}; total ${cop(reconciliation ? reconciliation.staleSettlementsCop : 0)}`);
  for (const item of result.stale) say(`    ${item.settlementId}: ${cop(item.amountCop)}`);
  say(`  missing (settlement_cash_pending_missing): ${result.missing.length}; total ${cop(reconciliation ? reconciliation.missingPendingSettlementsCop : 0)}`);
  for (const item of result.missing) say(`    ${item.settlementId}: ${cop(item.amountCop)}`);
  say();
  say(`3. Lista actual`);
  say(`  rows: ${report.rows.length}; nettedRows: ${report.nettedRows.length} (vencidos entre los compensados: ${report.nettedRows.filter((row) => row.isOverdue).length})`);
  say();
  say(`4. Cambios de grupo contra t1-linea-base-ids.json (DoD 3): ${result.changes.length}`);
  const countsByReason = countBy(result.changes, (change) => String(change.reason));
  say(`  por motivo: ${Object.entries(countsByReason).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  say(`  | Pedido | Seguimiento | De | A | Motivo |`);
  const trackingOf = new Map(
    [...baseline.rows, ...baseline.coveredByNetting, ...report.rows, ...report.nettedRows].map((item) => [item.orderId, item.trackingCode || ""])
  );
  for (const change of result.changes) {
    say(`  | ${change.orderId} | ${trackingOf.get(change.orderId) || "-"} | ${change.from} | ${change.to} | ${change.reason ?? "SIN MOTIVO"} |`);
  }
  return lines;
}

async function compare() {
  const isDeployed = process.argv.includes("--deployed");
  let credentials = null;
  if (isDeployed) {
    // Antes de tocar la red: sin las dos variables no hay sesion de admin que probar.
    const absent = CREDENTIAL_VARS.filter((name) => !process.env[name]);
    if (absent.length > 0) {
      console.error(`compare --deployed necesita ${CREDENTIAL_VARS.join(" y ")} (faltan: ${absent.join(", ")}).`);
      process.exitCode = 1;
      return;
    }
    credentials = { email: process.env.VERIFY_026_ADMIN_EMAIL, password: process.env.VERIFY_026_ADMIN_PASSWORD };
  }

  const baseline = readBaselineIds();
  const loaded = isDeployed ? await loadCompareDeployed(credentials) : await loadCompareLocal();
  const result = evaluateCompare({
    reconciliation: loaded.report.reconciliation,
    position: loaded.position,
    report: loaded.report,
    baseline,
    evidence: loaded.evidence
  });

  const lines = renderCompare(loaded, baseline, result, isDeployed);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(COMPARE_FILE, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nEvidencia: ${path.relative(process.cwd(), path.join(EVIDENCE_DIR, "t18-compare.txt"))}`);
  if (!result.pass) process.exitCode = 1;
}

const COMMANDS = { "baseline": baseline, "query-check": queryCheck, "compare": compare };

async function main() {
  const command = process.argv[2];
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Uso: node scripts/verify-026.js <${Object.keys(COMMANDS).join("|")}> [--deployed]`);
    process.exit(2);
  }
  await run();
}

module.exports = { evaluateCompare };

if (require.main === module) {
  main().catch((error) => {
    console.error("[verify-026]", error);
    process.exit(1);
  });
}
