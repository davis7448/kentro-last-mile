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
const onlyDriver = args.find((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1)) || null;

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

(async () => {
  const [settlementSnap, sellerEntrySnap, driverEntrySnap, orderSnap] = await Promise.all([
    db.collection("settlements").where("kind", "==", "driver").get(),
    db.collection("walletEntries").where("ownerType", "==", "seller").get(),
    db.collection("walletEntries").where("ownerType", "==", "driver").get(),
    db.collection("orders").select("trackingCode", "status", "driverId").get()
  ]);
  const orders = new Map(orderSnap.docs.map((d) => [d.id, d.data()]));
  const codEntriesByOrder = new Map();
  for (const doc of sellerEntrySnap.docs) {
    const e = doc.data();
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
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), report, riskRows }, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
