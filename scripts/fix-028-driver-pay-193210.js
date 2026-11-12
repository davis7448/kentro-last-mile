/**
 * Spec 028, P2: corrige el pago al domiciliario del pedido #193210 (shopify-7820453413153) de 9.000 a 8.000
 * y recalcula SU corte pendiente. Aprobado por el responsable el 2026-11-10 ("Solo el corte pendiente").
 *
 * El 9.000 salio de `settings/global` mientras tenia la tarifa de fabrica que escribe el autoguardado del
 * admin (spec 028). La regla 10 de la constitucion permite recalcular un corte PENDIENTE; los conciliados
 * no se tocan (los otros 3 pagos de 9.000 se dejan, por decision del responsable).
 *
 * El recalculo es el mismo del planificador de correcciones (`order-corrections-plan.ts`):
 * `computeDriverCashSummary` sobre todos los asientos, con el asiento corregido, y el faltante de recaudo
 * del corte movido con el.
 *
 *   node scripts/fix-028-driver-pay-193210.js          # en seco: solo imprime
 *   node scripts/fix-028-driver-pay-193210.js --apply  # escribe, con precondiciones de lastUpdateTime
 */
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const admin = require(path.join(ROOT, "functions/node_modules/firebase-admin"));
const { computeDriverCashSummary, settlementCashReceivedCop } = require(path.join(ROOT, "functions/lib/settlement-math.js"));

const ENTRY_ID = "we-shopify-7820453413153-driver-delivery-pay";
const SETTLEMENT_ID = "stl-1794233484852-driver-driver-1778271901513";
const FROM_COP = 9000;
const TO_COP = 8000;
const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

(async () => {
  const entryRef = db.collection("walletEntries").doc(ENTRY_ID);
  const settlementRef = db.collection("settlements").doc(SETTLEMENT_ID);
  const shortageRef = db.collection("walletEntries").doc(`we-${SETTLEMENT_ID}-cash-shortage`);
  const [entrySnap, settlementSnap, shortageSnap] = await Promise.all([entryRef.get(), settlementRef.get(), shortageRef.get()]);
  const entry = entrySnap.data();
  const settlement = settlementSnap.data();
  if (!entry || entry.amountCop !== FROM_COP || entry.type !== "driver_earning" || entry.settlementId !== SETTLEMENT_ID) {
    throw new Error(`El asiento no es el esperado: ${JSON.stringify(entry)}`);
  }
  if (!settlement || settlement.kind !== "driver" || settlement.status !== "pending") {
    throw new Error(`El corte no esta pendiente: ${settlement && settlement.status}`);
  }

  const [sellerSnap, driverSnap, leaderSnap] = await Promise.all(
    ["seller", "driver", "community_leader"].map((ownerType) => db.collection("walletEntries").where("ownerType", "==", ownerType).get())
  );
  const driverEntries = driverSnap.docs.map((doc) => (doc.id === ENTRY_ID ? { ...doc.data(), amountCop: TO_COP } : doc.data()));
  const orderIds = Array.from(new Set(driverSnap.docs.map((doc) => doc.data()).filter((e) => e.settlementId === SETTLEMENT_ID).map((e) => e.orderId).filter(Boolean)));
  const sameOrders = JSON.stringify([...orderIds].sort()) === JSON.stringify([...(settlement.orderIds || [])].sort());
  const orderSnaps = await Promise.all(orderIds.map((id) => db.collection("orders").doc(id).get()));
  const inputs = {
    sellerEntries: sellerSnap.docs.map((doc) => doc.data()),
    driverEntries,
    leaderEntries: leaderSnap.docs.map((doc) => doc.data()),
    orderMeta: new Map(orderSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()]))
  };
  const receivedCop = settlementCashReceivedCop(settlement);
  const summary = computeDriverCashSummary(inputs, orderIds, receivedCop);
  // Control: el mismo calculo SIN la correccion tiene que reproducir lo guardado.
  const control = computeDriverCashSummary({ ...inputs, driverEntries: driverSnap.docs.map((doc) => doc.data()) }, orderIds, receivedCop);
  const pendingCop = Math.max(0, summary.expectedCop - receivedCop);
  const excessCop = Math.max(0, receivedCop - summary.expectedCop);
  const patch = {
    codCop: summary.codCop,
    feesCop: summary.feesCop,
    driverPayCop: summary.driverPayCop,
    platformMarginCop: summary.platformMarginCop,
    netCop: summary.driverPayCop - summary.codCop,
    cashExpectedCop: summary.expectedCop,
    cashPendingCop: pendingCop,
    cashExcessCop: excessCop,
    cashReceiptStatus: summary.expectedCop === 0 || pendingCop === 0 ? "complete" : receivedCop > 0 ? "partial" : "none",
    cashAllocations: summary.allocations
  };
  const pick = (s) => ({ driverPayCop: s.driverPayCop, netCop: s.netCop, cashExpectedCop: s.cashExpectedCop, cashReceivedCop: s.cashReceivedCop ?? receivedCop, cashPendingCop: s.cashPendingCop, cashReceiptStatus: s.cashReceiptStatus });
  console.log(JSON.stringify({
    apply: APPLY,
    ordenesIgualesAlCorte: sameOrders,
    controlReproduceLoGuardado: { driverPayCop: control.driverPayCop === settlement.driverPayCop, cashExpectedCop: control.expectedCop === settlement.cashExpectedCop },
    antes: pick(settlement),
    despues: pick({ ...patch, cashReceivedCop: receivedCop }),
    faltante: shortageSnap.exists ? { antes: shortageSnap.data().amountCop, despues: pendingCop === 0 ? 0 : -pendingCop } : "no existe (no se crea)"
  }, null, 2));
  if (!sameOrders) throw new Error("Los pedidos del corte no coinciden con sus asientos: no se sigue.");
  if (control.expectedCop !== settlement.cashExpectedCop || control.driverPayCop !== settlement.driverPayCop) {
    throw new Error("El calculo sin corregir no reproduce el corte guardado: no se sigue.");
  }
  if (!APPLY) return;

  const now = new Date().toISOString();
  const batch = db.batch();
  batch.update(entryRef, { amountCop: TO_COP, correctedFromCop: FROM_COP, correctedAt: now, correctionNote: "Spec 028: tarifa de fabrica escrita por el autoguardado del admin" }, { lastUpdateTime: entrySnap.updateTime });
  batch.update(settlementRef, patch, { lastUpdateTime: settlementSnap.updateTime });
  if (shortageSnap.exists) batch.update(shortageRef, { amountCop: pendingCop === 0 ? 0 : -pendingCop }, { lastUpdateTime: shortageSnap.updateTime });
  const auditRef = db.collection("audit").doc();
  batch.set(auditRef, {
    id: auditRef.id,
    actorId: "script:fix-028-driver-pay-193210",
    actorRole: "admin",
    action: "wallet.driver_pay_corrected",
    entity: "settlement",
    entityId: SETTLEMENT_ID,
    summary: `Pago domiciliario #193210 ${FROM_COP} -> ${TO_COP} (spec 028, aprobado por el responsable); corte pendiente recalculado`,
    createdAt: now
  });
  await batch.commit();
  console.log("aplicado", now, "auditoria", auditRef.id);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
