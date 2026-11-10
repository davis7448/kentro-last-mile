#!/usr/bin/env node
/**
 * Spec 038 — SOLO LECTURA. Mide, pedido a pedido, cuanto efectivo le cobraron los cortes a cada
 * domiciliario de mas (o de menos) frente a lo que justifican los asientos actuales.
 *
 * No escribe nada en Firestore: solo hace `get()` sobre settlements, walletEntries y orders. Credenciales ADC,
 * como dice CLAUDE.md ("Verificar datos en vivo"). La regla NO es una copia: sale de `functions/lib`
 * (`rebuildHistoricalCharges`, `orderOwedByDriver`, RF_05b), asi que hay que compilar antes con
 * `cd functions && npm run build`.
 *
 *   node specs/038_measure.js                       # todos los domiciliarios, resumen
 *   node specs/038_measure.js driver-1778271901513  # un domiciliario, detalle por pedido
 *   node specs/038_measure.js --json salida.json    # ademas vuelca el detalle en JSON (archivo local)
 *   node specs/038_measure.js --check               # T21: falla si un corte viejo no cuadra con lo guardado
 *   node specs/038_measure.js --deploy-check        # T21 (RNF_01): regla vieja vs nueva antes de desplegar
 *   node specs/038_measure.js driver-X --fixtures src/lib/fixtures
 *       # T6: vuelca, ANONIMIZADOS, los casos reales de la spec como fixtures de prueba (ver abajo)
 *
 * Que mide:
 *  - "cobrado"  = suma de `cashExpectedCop` de los cortes del domiciliario (lo que se le pidio).
 *  - "debido"   = por cada pedido UNICO de sus cortes: COD neto de la tienda (cod_revenue +
 *                 cod_remittance) menos lo que el gana por ese pedido (driver_earning, solo suyos).
 *                 Es lo que el domiciliario debe entregar si cada asiento se cobra una sola vez.
 *  - Por pedido: cuanto aporto cada corte que lo contenia. Un corte viejo se reconstruye con la regla de la
 *    foto historica (asignacion guardada si existe; si no, los asientos que existian cuando ese corte se
 *    calculo por ultima vez). Un corte nuevo (con `cashCharges`) aporta lo que guardo. La reconstruccion se
 *    valida contra el `cashExpectedCop` guardado; los cortes que no cuadran se listan aparte.
 *  - Riesgo de `buildCodReceivedSet`: pedidos con asignacion en un corte saldado que despues
 *    recibieron COD nuevo (otra entrega tras una correccion). Hoy deberia dar 0.
 *
 * `--check` falla (codigo de salida 1) si un solo corte viejo no cuadra o si un pedido con asignacion no
 * reconstruye exactamente su cifra. `--deploy-check` (RNF_01) compara, para cada corte pendiente y para el
 * siguiente corte de cada domiciliario, el esperado de la regla vieja con el de la nueva CON las retenciones que
 * escribiria la foto, y el conjunto de "recibidos" viejo con el nuevo; falla si alguna diferencia no es 0 (esa
 * cifra la aprueba el responsable antes de desplegar).
 */
const fs = require("fs");
const path = require("path");

const LIB = path.resolve(__dirname, "../functions/lib");
function requireLib(name) {
  try {
    return require(path.join(LIB, name));
  } catch (error) {
    throw new Error(`No se encontro functions/lib/${name}. Compila antes: cd functions && npm run build (${error.message})`);
  }
}

const COD_TYPES = new Set(["cod_revenue", "cod_remittance"]);
const cop = (n) => Math.round(n).toLocaleString("es-CO");
const num = (v) => Number(v || 0);
const byCreatedAt = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));

function isSettled(s) {
  const received = typeof s.cashReceivedCop === "number" ? s.cashReceivedCop : (s.cashReceipts ?? []).reduce((a, r) => a + num(r.amountCop), 0);
  return (s.status === "paid" || s.status === "reconciled") && num(s.cashPendingCop) === 0 && typeof s.cashExpectedCop === "number" && received >= s.cashExpectedCop;
}

/** Recaudo de tienda y pago propio del domiciliario, por pedido (lo que necesita la reconstruccion). */
function entriesByOrderFor(entries, driverId) {
  const codByOrder = new Map();
  const payByOrder = new Map();
  for (const e of entries) {
    if (!e.orderId) continue;
    if (e.ownerType === "seller" && COD_TYPES.has(e.type)) codByOrder.set(e.orderId, [...(codByOrder.get(e.orderId) ?? []), e]);
    if (e.ownerType === "driver" && e.ownerId === driverId && e.type === "driver_earning") payByOrder.set(e.orderId, [...(payByOrder.get(e.orderId) ?? []), e]);
  }
  return { codByOrder, payByOrder };
}

/** La medicion de un domiciliario. `entries`: asientos de tienda y de domiciliarios (de cualquiera). */
function measureDriver({ driverId, cortes, entries, orders }) {
  const { rebuildHistoricalCharges, orderOwedByDriver } = requireLib("driver-cash-ledger.js");
  const { codByOrder, payByOrder } = entriesByOrderFor(entries, driverId);
  const sorted = [...cortes].sort(byCreatedAt);
  let chargedTotal = 0;
  const perOrder = new Map();
  const unverifiable = [];
  const allocationMismatches = [];
  const riskRows = [];
  for (const s of sorted) {
    chargedTotal += num(s.cashExpectedCop);
    let contrib;
    if (Array.isArray(s.cashCharges)) {
      contrib = s.cashCharges.map((c) => ({ orderId: String(c.orderId), cop: num(c.chargedCop) }));
    } else {
      const rows = rebuildHistoricalCharges(s, codByOrder, payByOrder);
      contrib = rows.map((r) => ({ orderId: r.orderId, cop: r.chargedCop }));
      const reconstructed = Math.max(0, rows.reduce((a, r) => a + r.chargedCop, 0));
      if (Math.abs(reconstructed - num(s.cashExpectedCop)) > 1) {
        unverifiable.push({ id: s.id, createdAt: s.createdAt, status: s.status, storedCop: num(s.cashExpectedCop), reconstructedCop: reconstructed });
      }
      const rowByOrder = new Map(rows.map((r) => [r.orderId, r]));
      const inCorte = new Set((s.orderIds ?? []).map(String));
      for (const a of s.cashAllocations ?? []) {
        if (!a.orderId || !inCorte.has(String(a.orderId))) continue;
        const row = rowByOrder.get(String(a.orderId));
        if (!row || row.source !== "allocation" || row.chargedCop !== num(a.expectedCop)) {
          allocationMismatches.push({ settlementId: s.id, orderId: String(a.orderId), storedCop: num(a.expectedCop), rebuiltCop: row ? row.chargedCop : null });
        }
      }
    }
    for (const c of contrib) {
      const row = perOrder.get(c.orderId) ?? { contributions: [] };
      row.contributions.push({ settlementId: s.id, createdAt: s.createdAt, status: s.status, cop: c.cop });
      perOrder.set(c.orderId, row);
    }
    if (isSettled(s) && Array.isArray(s.cashAllocations)) {
      const closedAt = String(s.reconciledAt || s.paidAt || "");
      for (const a of s.cashAllocations) {
        const later = (codByOrder.get(a.orderId) ?? []).filter((e) => closedAt && String(e.createdAt ?? "") > closedAt && num(e.amountCop) > 0);
        if (later.length > 0) riskRows.push({ driverId, settlementId: s.id, orderId: a.orderId, laterCodCop: later.reduce((t, e) => t + num(e.amountCop), 0) });
      }
    }
  }

  const owed = orderOwedByDriver(entries, driverId);
  let dueTotal = 0;
  const rows = [];
  for (const [orderId, row] of perOrder) {
    const due = owed.get(orderId)?.owedCop ?? 0;
    dueTotal += due;
    const chargedForOrder = row.contributions.reduce((a, c) => a + c.cop, 0);
    const excess = chargedForOrder - due;
    if (Math.abs(excess) >= 1) {
      rows.push({ orderId, trackingCode: orders.get(orderId)?.trackingCode ?? "?", status: orders.get(orderId)?.status ?? "?", dueCop: due, chargedCop: chargedForOrder, excessCop: excess, contributions: row.contributions });
    }
  }
  rows.sort((a, b) => b.excessCop - a.excessCop);
  return {
    driverId, cortes: sorted.length, orders: perOrder.size, chargedTotal, dueTotal, diff: chargedTotal - dueTotal,
    perOrderExcess: rows.reduce((a, r) => a + r.excessCop, 0), rows, unverifiable, allocationMismatches, riskRows
  };
}

/** `--check`: lo que no cuadra, una linea por problema. Vacio = en verde. */
function checkFailures(reports) {
  const failures = [];
  for (const r of reports) {
    for (const u of r.unverifiable) failures.push(`${r.driverId}: corte ${u.id} guardado ${cop(u.storedCop)} reconstruido ${cop(u.reconstructedCop)}`);
    for (const m of r.allocationMismatches) failures.push(`${r.driverId}: corte ${m.settlementId} pedido ${m.orderId} asignacion ${cop(m.storedCop)} reconstruido ${m.rebuiltCop === null ? "sin fila" : cop(m.rebuiltCop)}`);
  }
  return failures;
}

/**
 * REGLA VIEJA, SOLO COMO REFERENCIA DE COMPARACION (RNF_01). Es el `expectedCop` de `computeDriverCashSummary`,
 * retirada de functions/ en la T22 de la spec 038: el recaudo de TODOS los pedidos del corte menos TODO su pago
 * (de cualquier domiciliario), con max(0, ...) al total. Sirve para decir cuanto cambia un corte al desplegar; no
 * cobra nada ni se usa en ninguna otra parte.
 */
function legacyExpectedCop(oldInputs, orderIds) {
  const ids = new Set(orderIds);
  const sumOf = (list, keep) => list.filter((e) => ids.has(String(e.orderId ?? "")) && keep(e)).reduce((a, e) => a + num(e.amountCop), 0);
  const codCop = sumOf(oldInputs.sellerEntries, (e) => COD_TYPES.has(e.type));
  const payCop = sumOf(oldInputs.driverEntries, (e) => e.type === "driver_earning");
  return ids.size === 0 ? 0 : Math.max(0, codCop - payCop);
}

/**
 * `--deploy-check` de un domiciliario (RNF_01). Regla vieja = `legacyExpectedCop`, tal cual la llamaba
 * `loadDriverCashInputs` (todos los asientos de tienda y de domiciliarios). Regla nueva = la del corte, con el
 * contexto que dejaria la foto escrita AHORA (`buildDriverLedgerSnapshot`). Devuelve tambien los cortes
 * pendientes ya recalculados con la regla nueva, para comparar los "recibidos".
 */
function deployCheckDriver({ driverId, cortes, entries, orderMeta, now }) {
  const ledger = requireLib("driver-cash-ledger.js");
  const { settlementCashReceivedCop } = requireLib("settlement-math.js");
  const { isLiquidationWalletType } = requireLib("wallet-entries.js");
  const { context } = ledger.buildDriverLedgerSnapshot({ driverId, settlements: cortes, entries, now, createdBy: "deploy-check" });
  const oldInputs = {
    sellerEntries: entries.filter((e) => e.ownerType === "seller"),
    driverEntries: entries.filter((e) => e.ownerType === "driver"),
    orderMeta
  };
  const newEntries = entries.filter((e) => e.ownerType === "seller" || (e.ownerType === "driver" && e.ownerId === driverId));

  const pending = [];
  const simulatedCortes = [];
  for (const corte of [...cortes].sort(byCreatedAt)) {
    if (corte.status !== "pending" || Array.isArray(corte.cashCharges)) continue;
    const orderIds = Array.from(new Set((corte.orderIds ?? []).map(String)));
    const receivedCop = settlementCashReceivedCop(corte);
    const oldCop = legacyExpectedCop(oldInputs, orderIds);
    const fields = ledger.buildDriverSettlementFields({
      settlementId: corte.id, orderIds, ownEntryIds: (corte.walletEntryIds ?? []).map(String), entries: newEntries, context, receivedCop, orderMeta
    });
    pending.push({ settlementId: corte.id, oldCop, newCop: fields.cashExpectedCop, deltaCop: fields.cashExpectedCop - oldCop });
    simulatedCortes.push({ ...corte, ...fields });
  }

  const ownUnsettled = entries.filter((e) => e.ownerType === "driver" && e.ownerId === driverId && !e.settlementId && e.orderId && isLiquidationWalletType(String(e.type ?? "")));
  const oldOrderIds = Array.from(new Set(ownUnsettled.map((e) => String(e.orderId))));
  const oldCop = legacyExpectedCop(oldInputs, oldOrderIds);
  const newOrderIds = ledger.driverCorteOrderIdsAtCreation(ownUnsettled, newEntries, context);
  const newCop = newOrderIds.length
    ? ledger.computeDriverCorte({ settlementId: "deploy-check-next", orderIds: newOrderIds, ownEntryIds: ownUnsettled.map((e) => String(e.id)), entries: newEntries, context, orderMeta }).cashExpectedCop
    : 0;
  return { pending, next: { oldOrderIds, newOrderIds, oldCop, newCop, deltaCop: newCop - oldCop }, simulatedCortes };
}

/** "Recibidos" de hoy (regla vieja) frente a los de despues de desplegar, con los pendientes ya recalculados. */
function receivedDiff({ settlements, simulated, entries }) {
  const { buildCodReceivedSet, codEntriesByOrder } = requireLib("seller-ledger.js");
  const before = buildCodReceivedSet(settlements);
  const replaced = new Map(simulated.map((s) => [s.id, s]));
  const after = buildCodReceivedSet(settlements.map((s) => replaced.get(s.id) ?? s), codEntriesByOrder(entries));
  return {
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort()
  };
}

/**
 * T6 de la spec 038: fixtures ANONIMIZADOS para las pruebas de casos reales (RNF_03, RF_05b).
 *
 * Solo se copian ids, tracking, estados, montos, tipos y fechas: nada de nombres, telefonos, direcciones,
 * descripciones ni notas. Los ids de tienda y de domiciliario se quedan porque son la evidencia (no
 * identifican a una persona fuera de la plataforma). Se escriben:
 *  - un archivo por cada caso de RNF_03 (038-knt-003259.json, ...);
 *  - 038-driver-16.json con todos los pedidos de la tabla de §1 y el corte con KNT-000056.
 * Cada fixture trae los cortes del domiciliario que contienen esos pedidos, recortados a esos pedidos
 * (orderIds; las asignaciones van enteras); el corte de KNT-000056 va entero para poder cuadrar su total.
 */
const FIXTURE_CASES = ["KNT-003259", "KNT-004540", "KNT-002682", "KNT-002965"];
const WHOLE_CORTE_TRACKING = "KNT-000056";

function anonEntry(e) {
  const out = { id: e.id, ownerType: e.ownerType, ownerId: e.ownerId, orderId: e.orderId, type: e.type, amountCop: num(e.amountCop), description: "", createdAt: String(e.createdAt ?? "") };
  if (e.settlementId) out.settlementId = e.settlementId;
  return out;
}

function anonSettlement(s, keepOrderIds) {
  const keep = keepOrderIds ? new Set(keepOrderIds) : null;
  const ids = Array.from(new Set(s.orderIds ?? [])).filter((id) => !keep || keep.has(id));
  const out = {
    id: s.id, kind: "driver", ownerId: s.ownerId, ownerName: "", status: s.status,
    startDate: s.startDate ?? "", endDate: s.endDate ?? "", createdAt: String(s.createdAt ?? ""),
    orderIds: ids, walletEntryIds: [], codCop: 0, feesCop: 0, driverPayCop: 0, platformMarginCop: 0, netCop: 0,
    trimmed: Boolean(keep)
  };
  if (s.paidAt) out.paidAt = String(s.paidAt);
  if (s.reconciledAt) out.reconciledAt = String(s.reconciledAt);
  if (typeof s.cashExpectedCop === "number") out.cashExpectedCop = s.cashExpectedCop;
  if (Array.isArray(s.cashReceipts)) out.cashReceipts = s.cashReceipts.map((r) => ({ amountCop: num(r.amountCop), receivedAt: String(r.receivedAt ?? "") }));
  if (Array.isArray(s.cashAllocations)) {
    // Se guardan TODAS las asignaciones aunque el corte este recortado: si el corte tenia asignaciones y el
    // pedido no figura, la reconstruccion aplica min(0, ...) (RF_05), y eso depende de que existan.
    out.cashAllocations = s.cashAllocations
      .map((a) => ({ orderId: String(a.orderId), expectedCop: num(a.expectedCop), receivedCop: num(a.receivedCop), covered: Boolean(a.covered) }));
  }
  return out;
}

function writeFixtures({ fixturesDir, driverId, report, orders, settlementsByDriver, sellerEntriesByOrder, payByDriverOrder }) {
  const row = report.find((r) => r.driverId === driverId);
  if (!row) throw new Error(`sin cortes para ${driverId}`);
  const byTracking = new Map(Array.from(orders.entries()).map(([id, o]) => [o.trackingCode, id]));
  const cortes = settlementsByDriver.get(driverId) ?? [];
  const build = (name, orderIds, wholeCorteIds = []) => {
    const ids = new Set(orderIds);
    const whole = new Set(wholeCorteIds);
    const settlements = cortes
      .filter((s) => (s.orderIds ?? []).some((id) => ids.has(id)) || whole.has(s.id))
      .map((s) => anonSettlement(s, whole.has(s.id) ? null : orderIds));
    const allIds = new Set(settlements.flatMap((s) => s.orderIds));
    const entries = [];
    for (const id of allIds) {
      for (const e of sellerEntriesByOrder.get(id) ?? []) entries.push(anonEntry(e));
      for (const e of payByDriverOrder.get(`${driverId}|${id}`) ?? []) entries.push(anonEntry(e));
    }
    const fixtureOrders = Array.from(allIds).sort().map((id) => {
      const o = orders.get(id) ?? {};
      return { id, trackingCode: o.trackingCode ?? "?", status: o.status ?? "?", createdAt: String(o.createdAt ?? ""), paymentMethod: o.paymentMethod ?? "" };
    });
    const expected = row.rows.filter((r) => ids.has(r.orderId)).map((r) => ({ orderId: r.orderId, trackingCode: r.trackingCode, chargedCop: r.chargedCop, dueCop: r.dueCop, excessCop: r.excessCop }));
    const file = path.join(fixturesDir, name);
    const payload = {
      source: "specs/038_measure.js --fixtures (solo lectura, anonimizado)",
      generatedAt: new Date().toISOString(),
      driverId,
      expected,
      orders: fixtureOrders,
      settlements: settlements.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      entries: entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    console.log(`fixture ${file}: ${fixtureOrders.length} pedidos, ${payload.settlements.length} cortes, ${entries.length} asientos`);
  };
  for (const tracking of FIXTURE_CASES) {
    const id = byTracking.get(tracking);
    if (!id) throw new Error(`no existe ${tracking}`);
    build(`038-${tracking.toLowerCase()}.json`, [id]);
  }
  const sixteen = row.rows.map((r) => r.orderId);
  const knt56 = byTracking.get(WHOLE_CORTE_TRACKING);
  const corte56 = cortes.filter((s) => (s.orderIds ?? []).includes(knt56) && Array.isArray(s.cashAllocations) && !s.cashAllocations.some((a) => a.orderId === knt56));
  build("038-driver-16.json", sixteen, corte56.map((s) => s.id));
}

async function main() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
  const fixturesIdx = args.indexOf("--fixtures");
  const fixturesDir = fixturesIdx >= 0 ? args[fixturesIdx + 1] : null;
  const valueIdx = new Set([jsonIdx, fixturesIdx].filter((i) => i >= 0).map((i) => i + 1));
  const onlyDriver = args.find((a, i) => !a.startsWith("--") && !valueIdx.has(i)) || null;
  const runCheck = args.includes("--check");
  const runDeployCheck = args.includes("--deploy-check");

  const admin = require("../functions/node_modules/firebase-admin");
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const db = admin.firestore();

  const [settlementSnap, sellerEntrySnap, driverEntrySnap, orderSnap] = await Promise.all([
    db.collection("settlements").where("kind", "==", "driver").get(),
    db.collection("walletEntries").where("ownerType", "==", "seller").get(),
    db.collection("walletEntries").where("ownerType", "==", "driver").get(),
    db.collection("orders").select("trackingCode", "status", "driverId", "createdAt", "paymentMethod").get()
  ]);
  const orders = new Map(orderSnap.docs.map((d) => [d.id, d.data()]));
  const sellerEntries = sellerEntrySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const driverEntries = driverEntrySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const entries = [...sellerEntries, ...driverEntries];
  const sellerEntriesByOrder = new Map(); // todos los asientos de tienda, para los fixtures
  for (const e of sellerEntries) if (e.orderId) sellerEntriesByOrder.set(e.orderId, [...(sellerEntriesByOrder.get(e.orderId) ?? []), e]);
  const payByDriverOrder = new Map(); // `${driver}|${order}` -> asientos driver_earning, para los fixtures
  for (const e of driverEntries) {
    if (e.type !== "driver_earning" || !e.orderId) continue;
    const key = `${e.ownerId}|${e.orderId}`;
    payByDriverOrder.set(key, [...(payByDriverOrder.get(key) ?? []), e]);
  }
  const allSettlements = settlementSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const settlementsByDriver = new Map();
  for (const s of allSettlements) settlementsByDriver.set(s.ownerId, [...(settlementsByDriver.get(s.ownerId) ?? []), s]);

  const report = [];
  for (const [driverId, cortes] of settlementsByDriver) {
    if (onlyDriver && driverId !== onlyDriver) continue;
    report.push(measureDriver({ driverId, cortes, entries, orders }));
  }
  const riskRows = report.flatMap((r) => r.riskRows);

  report.sort((a, b) => b.diff - a.diff);
  console.log("domiciliario | cortes | pedidos | cobrado | debido | diferencia | suma por pedido | cortes sin cuadrar");
  for (const r of report) {
    console.log([r.driverId, r.cortes, r.orders, cop(r.chargedTotal), cop(r.dueTotal), cop(r.diff), cop(r.perOrderExcess), r.unverifiable.length].join(" | "));
  }
  if (onlyDriver) {
    for (const r of report) {
      console.log(`\n== ${r.driverId}: pedidos con cobro distinto de lo debido (${r.rows.length}) ==`);
      for (const row of r.rows) {
        const parts = row.contributions.map((c) => `${String(c.createdAt).slice(0, 10)} ${c.status} ${cop(c.cop)}`).join("; ");
        console.log(`${row.trackingCode} (${row.orderId}) [${row.status}] debido ${cop(row.dueCop)} cobrado ${cop(row.chargedCop)} exceso ${cop(row.excessCop)} :: ${parts}`);
      }
      if (r.unverifiable.length) {
        console.log(`\n-- cortes cuya reconstruccion no cuadra con lo guardado (${r.unverifiable.length}) --`);
        for (const u of r.unverifiable) console.log(`${u.id} ${String(u.createdAt).slice(0, 10)} ${u.status} guardado ${cop(u.storedCop)} reconstruido ${cop(u.reconstructedCop)}`);
      }
    }
  }
  console.log(`\nRiesgo buildCodReceivedSet (COD nuevo tras corte saldado): ${riskRows.length} pedido(s)`);
  for (const row of riskRows) console.log(`  ${row.driverId} ${row.settlementId} ${row.orderId} ${cop(row.laterCodCop)}`);

  let failed = false;
  if (runCheck) {
    const failures = checkFailures(report);
    const cortesChecked = report.reduce((a, r) => a + r.cortes, 0);
    console.log(`\n--check: ${cortesChecked} cortes, ${failures.length} problema(s)`);
    for (const line of failures) console.log(`  ${line}`);
    console.log(failures.length === 0 ? "--check EN VERDE" : "--check FALLA");
    failed = failed || failures.length > 0;
  }

  if (runDeployCheck) {
    const now = new Date().toISOString();
    const orderMeta = new Map(Array.from(orders.entries()).map(([id, o]) => [id, { createdAt: o.createdAt, trackingCode: o.trackingCode }]));
    const simulated = [];
    let totalDelta = 0;
    console.log(`\n--deploy-check (RNF_01), ${now}: esperado regla vieja -> regla nueva con las retenciones de la foto`);
    for (const [driverId, cortes] of settlementsByDriver) {
      if (onlyDriver && driverId !== onlyDriver) continue;
      const check = deployCheckDriver({ driverId, cortes, entries, orderMeta, now });
      simulated.push(...check.simulatedCortes);
      for (const p of check.pending) {
        console.log(`  ${driverId} pendiente ${p.settlementId}: ${cop(p.oldCop)} -> ${cop(p.newCop)} (diferencia ${cop(p.deltaCop)})`);
        totalDelta += Math.abs(p.deltaCop);
      }
      const n = check.next;
      const newOnly = n.newOrderIds.filter((id) => !n.oldOrderIds.includes(id)).map((id) => orders.get(id)?.trackingCode ?? id);
      const oldOnly = n.oldOrderIds.filter((id) => !n.newOrderIds.includes(id)).map((id) => orders.get(id)?.trackingCode ?? id);
      console.log(`  ${driverId} siguiente corte: ${n.oldOrderIds.length} -> ${n.newOrderIds.length} pedidos, ${cop(n.oldCop)} -> ${cop(n.newCop)} (diferencia ${cop(n.deltaCop)})` +
        (newOnly.length ? ` · solo con la nueva: ${newOnly.join(", ")}` : "") + (oldOnly.length ? ` · solo con la vieja: ${oldOnly.join(", ")}` : ""));
      totalDelta += Math.abs(n.deltaCop);
    }
    const scope = onlyDriver ? allSettlements.filter((s) => s.ownerId === onlyDriver) : allSettlements;
    const diff = receivedDiff({ settlements: scope, simulated, entries });
    const label = (ids) => ids.map((id) => orders.get(id)?.trackingCode ?? id).join(", ");
    console.log(`  recibidos: ${diff.added.length} pasan a recibido${diff.added.length ? ` (${label(diff.added)})` : ""}, ${diff.removed.length} dejan de estarlo${diff.removed.length ? ` (${label(diff.removed)})` : ""}`);
    const ok = totalDelta === 0 && diff.added.length === 0 && diff.removed.length === 0;
    console.log(ok ? "--deploy-check EN VERDE: desplegar no cambia ningun esperado ni ningun recibido" : "--deploy-check CON DIFERENCIAS: la cifra la aprueba el responsable antes de desplegar");
    failed = failed || !ok;
  }

  if (fixturesDir) {
    if (!onlyDriver) throw new Error("--fixtures necesita el id del domiciliario");
    writeFixtures({ fixturesDir, driverId: onlyDriver, report, orders, settlementsByDriver, sellerEntriesByOrder, payByDriverOrder });
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), report, riskRows }, null, 2));
  return failed ? 1 : 0;
}

module.exports = { measureDriver, checkFailures, deployCheckDriver, receivedDiff };

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
