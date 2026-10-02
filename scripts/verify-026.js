#!/usr/bin/env node
/**
 * Spec 026 — medicion en produccion. SOLO LECTURA: ningun subcomando escribe en Firestore.
 *
 *   node scripts/verify-026.js baseline   (T1) linea base antes de tocar codigo, con ids
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

admin.initializeApp({ projectId: "kentro-last-mile" });
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

const COMMANDS = { "baseline": baseline };

async function main() {
  const command = process.argv[2];
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Uso: node scripts/verify-026.js <${Object.keys(COMMANDS).join("|")}>`);
    process.exit(2);
  }
  await run();
}

main().catch((error) => {
  console.error("[verify-026]", error);
  process.exit(1);
});
