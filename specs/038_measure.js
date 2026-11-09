#!/usr/bin/env node
/**
 * Spec 038 — SOLO LECTURA. Mide, pedido a pedido, cuanto efectivo le cobraron los cortes a cada
 * domiciliario de mas (o de menos) frente a lo que justifican los asientos actuales.
 *
 * No escribe nada: solo hace `get()` sobre settlements, walletEntries y orders. Credenciales ADC,
 * como dice CLAUDE.md ("Verificar datos en vivo").
 *
 *   node specs/038_measure.js                       # todos los domiciliarios, resumen
 *   node specs/038_measure.js driver-1778271901513  # un domiciliario, detalle por pedido
 *   node specs/038_measure.js --json salida.json    # ademas vuelca el detalle en JSON
 *   node specs/038_measure.js driver-X --fixtures src/lib/fixtures
 *       # T6: vuelca, ANONIMIZADOS, los casos reales de la spec como fixtures de prueba (ver abajo)
 *
 * Que mide:
 *  - "cobrado"  = suma de `cashExpectedCop` de los cortes del domiciliario (lo que se le pidio).
 *  - "debido"   = por cada pedido UNICO de sus cortes: COD neto de la tienda (cod_revenue +
 *                 cod_remittance) menos lo que el gana por ese pedido (driver_earning, solo suyos).
 *                 Es lo que el domiciliario debe entregar si cada asiento se cobra una sola vez.
 *  - Por pedido: cuanto aporto cada corte que lo contenia, reconstruido con los asientos que
 *    existian cuando ese corte se calculo por ultima vez (creacion, abonos, pago o conciliacion).
 *    La reconstruccion se valida contra el `cashExpectedCop` guardado; los cortes que no cuadran
 *    se listan aparte.
 *  - Riesgo de `buildCodReceivedSet`: pedidos con asignacion en un corte saldado que despues
 *    recibieron COD nuevo (otra entrega tras una correccion). Hoy deberia dar 0.
 */
const admin = require("../functions/node_modules/firebase-admin");
const fs = require("fs");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const fixturesIdx = args.indexOf("--fixtures");
const fixturesDir = fixturesIdx >= 0 ? args[fixturesIdx + 1] : null;
const valueIdx = new Set([jsonIdx, fixturesIdx].filter((i) => i >= 0).map((i) => i + 1));
const onlyDriver = args.find((a, i) => !a.startsWith("--") && !valueIdx.has(i)) || null;
const path = require("path");

const COD_TYPES = new Set(["cod_revenue", "cod_remittance"]);
const cop = (n) => Math.round(n).toLocaleString("es-CO");
const num = (v) => Number(v || 0);

/** Ultimo instante en que el corte recalculo su efectivo esperado (lo hace en cada abono y al pagar/conciliar). */
function lastComputedAt(s) {
  const times = [s.createdAt, s.paidAt, s.reconciledAt, ...(s.cashReceipts ?? []).map((r) => r.receivedAt)]
    .filter(Boolean)
    .map(String);
  return times.sort().pop() ?? "";
}

function isSettled(s) {
  const received = typeof s.cashReceivedCop === "number" ? s.cashReceivedCop : (s.cashReceipts ?? []).reduce((a, r) => a + num(r.amountCop), 0);
  return (s.status === "paid" || s.status === "reconciled") && num(s.cashPendingCop) === 0 && typeof s.cashExpectedCop === "number" && received >= s.cashExpectedCop;
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

(async () => {
  const [settlementSnap, sellerEntrySnap, driverEntrySnap, orderSnap] = await Promise.all([
    db.collection("settlements").where("kind", "==", "driver").get(),
    db.collection("walletEntries").where("ownerType", "==", "seller").get(),
    db.collection("walletEntries").where("ownerType", "==", "driver").get(),
    db.collection("orders").select("trackingCode", "status", "driverId", "createdAt", "paymentMethod").get()
  ]);
  const orders = new Map(orderSnap.docs.map((d) => [d.id, d.data()]));
  const codEntriesByOrder = new Map();
  const sellerEntriesByOrder = new Map(); // todos los asientos de tienda, para los fixtures
  for (const doc of sellerEntrySnap.docs) {
    const e = doc.data();
    if (e.orderId) {
      const all = sellerEntriesByOrder.get(e.orderId) ?? [];
      all.push({ id: doc.id, ...e });
      sellerEntriesByOrder.set(e.orderId, all);
    }
    if (!COD_TYPES.has(e.type) || !e.orderId) continue;
    const list = codEntriesByOrder.get(e.orderId) ?? [];
    list.push({ id: doc.id, ...e });
    codEntriesByOrder.set(e.orderId, list);
  }
  const payByDriverOrder = new Map(); // `${driver}|${order}` -> asientos driver_earning
  for (const doc of driverEntrySnap.docs) {
    const e = doc.data();
    if (e.type !== "driver_earning" || !e.orderId) continue;
    const key = `${e.ownerId}|${e.orderId}`;
    const list = payByDriverOrder.get(key) ?? [];
    list.push({ id: doc.id, ...e });
    payByDriverOrder.set(key, list);
  }
  const settlementsByDriver = new Map();
  for (const doc of settlementSnap.docs) {
    const s = { id: doc.id, ...doc.data() };
    const list = settlementsByDriver.get(s.ownerId) ?? [];
    list.push(s);
    settlementsByDriver.set(s.ownerId, list);
  }

  const sum = (list, until) => (list ?? []).filter((e) => !until || String(e.createdAt ?? "") <= until).reduce((a, e) => a + num(e.amountCop), 0);
  const report = [];
  const riskRows = [];
  for (const [driverId, cortes] of settlementsByDriver) {
    if (onlyDriver && driverId !== onlyDriver) continue;
    cortes.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    let chargedTotal = 0;
    const perOrder = new Map();
    const unverifiable = [];
    for (const s of cortes) {
      chargedTotal += num(s.cashExpectedCop);
      const until = lastComputedAt(s);
      const ids = Array.from(new Set(s.orderIds ?? []));
      // Lo cobrado por pedido sale de la asignacion GUARDADA en el corte cuando existe: es el registro
      // de lo que se le pidio. Reconstruir desde asientos falla cuando una correccion los borro despues
      // (KNT-004540, KNT-007828: el COD de la tienda se elimino porque su corte de tienda seguia
      // pendiente). Sin asignacion (pedido sin efectivo neto, cortes viejos) se reconstruye.
      // Si el corte tiene asignaciones, un pedido que no figura en ellas no aporto efectivo: como
      // mucho resto el pago del domiciliario (por eso min(0, ...)). KNT-000056 en el corte del
      // 2026-05-29 es el caso: un script anterior al planificador recalculo ese corte ya conciliado
      // tras corregir el pedido, y su asignacion desaparecio.
      const allocationByOrder = new Map((s.cashAllocations ?? []).filter((a) => a.orderId).map((a) => [String(a.orderId), num(a.expectedCop)]));
      const hasAllocations = allocationByOrder.size > 0;
      const contrib = ids.map((orderId) => {
        if (allocationByOrder.has(orderId)) return { orderId, cop: allocationByOrder.get(orderId) };
        const rebuilt = sum(codEntriesByOrder.get(orderId), until) - sum(payByDriverOrder.get(`${driverId}|${orderId}`), until);
        return { orderId, cop: hasAllocations ? Math.min(0, rebuilt) : rebuilt };
      });
      const reconstructed = Math.max(0, contrib.reduce((a, c) => a + c.cop, 0));
      if (Math.abs(reconstructed - num(s.cashExpectedCop)) > 1) {
        unverifiable.push({ id: s.id, createdAt: s.createdAt, status: s.status, storedCop: num(s.cashExpectedCop), reconstructedCop: reconstructed });
      }
      for (const c of contrib) {
        const row = perOrder.get(c.orderId) ?? { contributions: [] };
        row.contributions.push({ settlementId: s.id, createdAt: s.createdAt, status: s.status, cop: c.cop });
        perOrder.set(c.orderId, row);
      }
      if (isSettled(s) && Array.isArray(s.cashAllocations)) {
        const closedAt = String(s.reconciledAt || s.paidAt || "");
        for (const a of s.cashAllocations) {
          const later = (codEntriesByOrder.get(a.orderId) ?? []).filter((e) => closedAt && String(e.createdAt ?? "") > closedAt && num(e.amountCop) > 0);
          if (later.length > 0) riskRows.push({ driverId, settlementId: s.id, orderId: a.orderId, laterCodCop: sum(later) });
        }
      }
    }

    let dueTotal = 0;
    const rows = [];
    for (const [orderId, row] of perOrder) {
      const due = sum(codEntriesByOrder.get(orderId)) - sum(payByDriverOrder.get(`${driverId}|${orderId}`));
      dueTotal += due;
      const chargedForOrder = row.contributions.reduce((a, c) => a + c.cop, 0);
      const excess = chargedForOrder - due;
      if (Math.abs(excess) >= 1) {
        rows.push({ orderId, trackingCode: orders.get(orderId)?.trackingCode ?? "?", status: orders.get(orderId)?.status ?? "?", dueCop: due, chargedCop: chargedForOrder, excessCop: excess, contributions: row.contributions });
      }
    }
    rows.sort((a, b) => b.excessCop - a.excessCop);
    report.push({ driverId, cortes: cortes.length, orders: perOrder.size, chargedTotal, dueTotal, diff: chargedTotal - dueTotal, perOrderExcess: rows.reduce((a, r) => a + r.excessCop, 0), rows, unverifiable });
  }

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
  if (fixturesDir) {
    if (!onlyDriver) throw new Error("--fixtures necesita el id del domiciliario");
    writeFixtures({ fixturesDir, driverId: onlyDriver, report, orders, settlementsByDriver, sellerEntriesByOrder, payByDriverOrder });
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), report, riskRows }, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
