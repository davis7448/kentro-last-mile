#!/usr/bin/env node
/**
 * Spec 023, fase B — comparacion contra produccion, SOLO LECTURA.
 *
 *   cd functions && npm run build && cd .. && node scripts/verify-023-admin.js
 *
 * Lee el libro de caja entero UNA vez (la referencia, ~19.500 lecturas) y lanza contra Firestore las MISMAS
 * consultas que hace ahora el navegador del admin (`state-store.ts`): lo sin liquidar, los cobros de manejo,
 * los costos sin pagar al proveedor, asientos por pedido, por id y por rango. Para cada pantalla de dinero
 * compara lo que filtraria del libro entero con lo que filtra de "vivo + leido bajo demanda" (RF_03):
 *
 *  - Liquidaciones "Por pagar": lo abierto; los asientos de tienda de los pedidos de domiciliario pendientes;
 *    el saldo de cada tienda (spec 018), entero.
 *  - "Cortes cerrados": por cada pagina de 10 cortes, los asientos del corte y los de sus pedidos. Y la
 *    hipotesis que ahorra la doble lectura: todo asiento `we-{orderId}-...` de un corte es de ese pedido.
 *  - "Resumen del periodo": varios rangos.
 *  - Posicion de la plataforma: las sumas (gemelo en memoria con datos reales) contra la lectura completa, y
 *    las sumas de Firestore si los indices de la spec 023 ya estan desplegados.
 *
 * Sale con codigo 1 si algo no cuadra.
 */
const path = require("path");
const functionsDir = path.join(__dirname, "..", "functions");
const admin = require(path.join(functionsDir, "node_modules", "firebase-admin"));
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const { buildSellerBalanceInput, computeSellerBalance } = require(path.join(functionsDir, "lib", "seller-balance.js"));
const { computePlatformPosition } = require(path.join(functionsDir, "lib", "platform-position.js"));
const { composePlatformPosition, loadPositionSums, sumsFromEntries } = require(path.join(functionsDir, "lib", "platform-position-sums.js"));

const withId = (doc) => ({ id: doc.id, ...doc.data() });
const ids = (entries) => [...new Set(entries.map((entry) => entry.id))].sort();
const sameIds = (a, b) => JSON.stringify(ids(a)) === JSON.stringify(ids(b));
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
const merge = (live, ...extras) => {
  const map = new Map(live.map((entry) => [entry.id, entry]));
  for (const group of extras) for (const entry of group) if (!map.has(entry.id)) map.set(entry.id, entry);
  return [...map.values()];
};

let reads = 0;
async function run(query) {
  const snap = await query.get();
  reads += Math.max(1, snap.size);
  return snap.docs.map(withId);
}
const W = () => db.collection("walletEntries");
const byOrderIds = async (orderIds) => (await Promise.all(chunks([...new Set(orderIds)], 30).map((batch) => run(W().where("orderId", "in", batch))))).flat();
const byIds = async (entryIds) =>
  (await Promise.all(chunks([...new Set(entryIds)], 30).map((batch) => run(W().where(admin.firestore.FieldPath.documentId(), "in", batch))))).flat();
const inRange = async (start, end) => {
  let query = W();
  if (start) query = query.where("createdAt", ">=", start);
  const next = new Date(`${end}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  query = query.where("createdAt", "<", next.toISOString().slice(0, 10));
  return run(query);
};
const isEntryInRange = (entry, start, end) => {
  const date = String(entry.createdAt).slice(0, 10);
  return (!start || date >= start) && (!end || date <= end);
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ comprobacion: name, resultado: ok ? "igual" : "DISTINTO", detalle: detail });
}

(async () => {
  // Referencia: todo, como lo bajaba antes el admin.
  const [fullWallet, settlements, orders, settingsSnap, zones, suppliers] = await Promise.all([
    W().get().then((snap) => snap.docs.map(withId)),
    db.collection("settlements").get().then((snap) => snap.docs.map(withId)),
    db.collection("orders").get().then((snap) => snap.docs.map(withId)),
    db.collection("settings").doc("global").get(),
    db.collection("zones").get().then((snap) => snap.docs.map(withId)),
    db.collection("suppliers").get().then((snap) => snap.docs.map(withId))
  ]);
  const sellers = await db.collection("sellers").get().then((snap) => snap.docs.map(withId));

  // Lo que baja ahora el admin al abrir.
  reads = 0;
  const [unsettled, fulfillment] = await Promise.all([run(W().where("settlementId", "==", "")), run(W().where("type", "==", "fulfillment_fee"))]);
  const adminLive = merge(unsettled, fulfillment);
  const openingReads = reads;

  // --- Por pagar
  reads = 0;
  const supplierPending = await run(W().where("type", "==", "product_cost").where("supplierSettlementId", "==", ""));
  const liveWallet = merge(adminLive, supplierPending);
  const isOpen = (entry) => !entry.settlementId || (entry.type === "product_cost" && !entry.supplierSettlementId);
  check("Por pagar: asientos abiertos", sameIds(liveWallet.filter(isOpen), fullWallet.filter(isOpen)), `${fullWallet.filter(isOpen).length} asientos`);

  const driverOrders = [...new Set(adminLive.filter((entry) => entry.ownerType === "driver" && !entry.settlementId && entry.orderId).map((entry) => entry.orderId))];
  const relatedWallet = merge(liveWallet, await byOrderIds(driverOrders));
  const relatedOf = (source) => source.filter((entry) => entry.ownerType === "seller" && entry.orderId && driverOrders.includes(entry.orderId));
  check("Por pagar: asientos de tienda de los pedidos de domiciliario pendientes", sameIds(relatedOf(relatedWallet), relatedOf(fullWallet)), `${driverOrders.length} pedidos`);

  const now = new Date().toISOString();
  const settings = settingsSnap.data() || {};
  let balanceDiffs = 0;
  for (const seller of sellers) {
    const input = (source) => buildSellerBalanceInput({ sellerId: seller.id, wallet: source, orders, settlements, settings, zones, now });
    const normalized = (source) => {
      const balance = computeSellerBalance(input(source));
      return JSON.stringify({ ...balance, selection: { ...balance.selection, entryIds: [...balance.selection.entryIds].sort() } });
    };
    if (normalized(liveWallet) !== normalized(fullWallet)) balanceDiffs += 1;
  }
  check("Por pagar: saldo de cada tienda (spec 018)", balanceDiffs === 0, `${sellers.length} tiendas, ${balanceDiffs} distintas`);
  const payableReads = reads;

  // --- Cortes cerrados, pagina a pagina (mismo orden que la pantalla)
  reads = 0;
  const sorted = [...settlements].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  let pageDiffs = 0;
  let prefixViolations = 0;
  const fullById = new Map(fullWallet.map((entry) => [entry.id, entry]));
  const pageReads = [];
  for (const page of chunks(sorted, 10)) {
    const before = reads;
    const entryIds = new Set();
    const orderIds = new Set();
    for (const settlement of page) {
      const own = (settlement.orderIds || []).filter(Boolean);
      own.forEach((id) => orderIds.add(id));
      for (const id of settlement.walletEntryIds || []) {
        const prefixed = own.find((orderId) => id.startsWith(`we-${orderId}-`));
        if (!prefixed) entryIds.add(id);
        else if (fullById.has(id) && fullById.get(id).orderId !== prefixed) prefixViolations += 1;
      }
    }
    const fetchedById = await byIds([...entryIds]);
    for (const entry of fetchedById) if (entry.orderId) orderIds.add(entry.orderId);
    const supplement = merge(adminLive, fetchedById, await byOrderIds([...orderIds]));
    for (const settlement of page) {
      const setIds = new Set(settlement.walletEntryIds || []);
      const ofSettlement = (source) => source.filter((entry) => setIds.has(entry.id));
      const settlementOrders = (settlement.orderIds || []).length > 0 ? settlement.orderIds : [...new Set(ofSettlement(fullWallet).map((entry) => entry.orderId).filter(Boolean))];
      const ofOrders = (source) => source.filter((entry) => entry.orderId && settlementOrders.includes(entry.orderId));
      if (!sameIds(ofSettlement(supplement), ofSettlement(fullWallet)) || !sameIds(ofOrders(supplement), ofOrders(fullWallet))) pageDiffs += 1;
    }
    pageReads.push(reads - before);
  }
  check("Cortes cerrados: asientos de cada corte y de sus pedidos", pageDiffs === 0, `${settlements.length} cortes en ${pageReads.length} paginas, ${pageDiffs} distintos`);
  check("Cortes cerrados: los asientos we-{pedido}-... son de ese pedido", prefixViolations === 0, `${prefixViolations} excepciones`);

  // --- Resumen del periodo
  reads = 0;
  const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 5 * 3600 * 1000 - 6 * 86400000).toISOString().slice(0, 10);
  let rangeDiffs = 0;
  const ranges = [[weekAgo, today], ["2026-10-01", "2026-10-31"], [today, today], ["2026-09-15", "2026-09-15"]];
  for (const [start, end] of ranges) {
    const merged = merge(liveWallet, await inRange(start, end));
    if (!sameIds(merged.filter((entry) => isEntryInRange(entry, start, end)), fullWallet.filter((entry) => isEntryInRange(entry, start, end)))) rangeDiffs += 1;
  }
  check("Resumen del periodo: asientos del rango", rangeDiffs === 0, `${ranges.length} rangos`);
  const periodWeekReads = reads;

  // --- Posicion de la plataforma
  const reference = computePlatformPosition(fullWallet, settlements);
  const twin = composePlatformPosition(sumsFromEntries(fullWallet, settlements), settlements);
  check("Posicion: sumas (gemelo en memoria) contra lectura completa", JSON.stringify(twin) === JSON.stringify(reference));
  let aggregateNote = "";
  reads = 0;
  try {
    const sums = await loadPositionSums(db, settlements, suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name })));
    const viaFirestore = composePlatformPosition(sums, settlements);
    const money = (position) => JSON.stringify({ ...position, withheldBySupplier: position.withheldBySupplier.map(({ supplierId, amountCop }) => ({ supplierId, amountCop })) });
    check("Posicion: sumas de Firestore contra lectura completa (cifras de dinero)", money(viaFirestore) === money(reference));
    const names = (position) => position.withheldBySupplier.map((row) => `${row.supplierId}=${row.supplierName}`).join(", ");
    aggregateNote = `nombres de proveedor: antes [${names(reference)}], ahora [${names(viaFirestore)}]`;
  } catch (error) {
    aggregateNote = `sumas de Firestore no disponibles: ${String(error.message || error).slice(0, 160)}`;
    results.push({ comprobacion: "Posicion: sumas de Firestore", resultado: "PENDIENTE", detalle: aggregateNote });
  }

  console.table(results);
  const summary = {
    at: new Date().toISOString(),
    libroEntero: fullWallet.length,
    lecturas: {
      abrirLaAppAntes: fullWallet.length,
      abrirLaAppAhora: openingReads,
      liquidacionesPorPagar: payableReads,
      cortesCerradosPorPagina: pageReads,
      periodoCuatroRangos: periodWeekReads
    },
    posicion: aggregateNote,
    results
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(results.some((row) => row.resultado === "DISTINTO") ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
