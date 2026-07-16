#!/usr/bin/env node
/**
 * Auditoría de integridad financiera de Kentro. SOLO LECTURA (no escribe nada).
 * Cruza orders × walletEntries × settlements × sellers/drivers buscando anomalías.
 *
 * Filtra falsos positivos conocidos:
 *  - platform_margin: su orderId es el id del settlement (por diseño); se excluye de
 *    "entry sin pedido" y de la suma al comparar netCop del settlement.
 *  - Correcciones que netean a 0 por pedido (reversas cod_remittance / correction-*).
 *  - Pagos legítimos por visita fallida ("Pago transportista fallido").
 *
 * Uso:  node scripts/audit-financial-integrity.js
 *       node scripts/audit-financial-integrity.js --full   (muestra todas las filas, no solo muestra)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const money = (n) => Math.round(Number(n || 0));
const full = process.argv.includes("--full");
const cut = (arr) => (full ? arr : arr.slice(0, 10));
const LIQ_TYPES = ["cod_revenue", "cod_remittance", "delivery_fee", "failed_fee", "fulfillment_fee", "product_cost", "driver_earning", "seller_abono"];

(async () => {
  const [ordersS, walletS, settlS, sellersS, driversS] = await Promise.all([
    db.collection("orders").get(),
    db.collection("walletEntries").get(),
    db.collection("settlements").get(),
    db.collection("sellers").get(),
    db.collection("drivers").get(),
  ]);
  const orders = new Map(ordersS.docs.map((d) => [d.id, d.data()]));
  const wallet = walletS.docs.map((d) => ({ id: d.id, ...d.data() }));
  const settlements = new Map(settlS.docs.map((d) => [d.id, d.data()]));
  const sellerIds = new Set(sellersS.docs.map((d) => d.id));
  const driverIds = new Set(driversS.docs.map((d) => d.id));
  const entryIds = new Set(wallet.map((e) => e.id));

  const byOrder = new Map();
  for (const e of wallet) { if (!e.orderId || !orders.has(e.orderId)) continue; (byOrder.get(e.orderId) ?? byOrder.set(e.orderId, []).get(e.orderId)).push(e); }
  const netType = (es, types) => money(es.filter((e) => types.includes(e.type)).reduce((a, e) => a + Number(e.amountCop || 0), 0));

  // codReceived según backend (createSettlement): cashAllocations covered, o settlement paid/reconciled.
  const codReceived = new Set();
  for (const [, s] of settlements) {
    if (s.kind !== "driver") continue;
    if (Array.isArray(s.cashAllocations) && s.cashAllocations.length > 0) { for (const a of s.cashAllocations) if (a.covered && a.orderId) codReceived.add(a.orderId); continue; }
    if (s.status === "paid" || s.status === "reconciled" || s.cashPendingCop === 0) for (const oid of s.orderIds ?? []) codReceived.add(oid);
  }

  const f = {};

  // 1) settlementId huérfano
  f.orphanSettlementId = cut(wallet.filter((e) => e.settlementId && !settlements.has(e.settlementId)).map((e) => ({ id: e.id, settlementId: e.settlementId })));
  f.orphanSupplierSettlementId = cut(wallet.filter((e) => e.supplierSettlementId && !settlements.has(e.supplierSettlementId)).map((e) => ({ id: e.id })));

  // 2) referencias a entidades inexistentes (platform_margin/abono/cash_shortage usan settlement/‑ como orderId)
  f.entryMissingOrder = cut(wallet.filter((e) => e.orderId && !orders.has(e.orderId) && !["platform_margin", "cash_shortage", "seller_abono"].includes(e.type) && !String(e.id).startsWith("we-abono")).map((e) => ({ id: e.id, type: e.type, orderId: e.orderId })));
  f.sellerEntryMissingSeller = cut(wallet.filter((e) => e.ownerType === "seller" && !sellerIds.has(e.ownerId)).map((e) => ({ id: e.id, ownerId: e.ownerId })));
  f.driverEntryMissingDriver = cut(wallet.filter((e) => e.ownerType === "driver" && e.ownerId !== "unassigned" && !driverIds.has(e.ownerId)).map((e) => ({ id: e.id, ownerId: e.ownerId })));

  // 3) mismatch status <-> wallet (por NETO, tolera correcciones que netean a 0)
  const failedUncorrected = [], deliveredReversed = [], deliveredMissing = [];
  for (const [oid, es] of byOrder) {
    const o = orders.get(oid);
    const nCod = netType(es, ["cod_revenue", "cod_remittance"]);
    const nFee = netType(es, ["delivery_fee"]);
    const hasDeliveredDriverPay = es.some((e) => e.type === "driver_earning" && /entregado/i.test(e.description || "") && Number(e.amountCop) > 0);
    const hasDeliveredDriverReversal = es.some((e) => e.type === "driver_earning" && /correccion|reversa/i.test(e.description || "") && Number(e.amountCop) < 0);
    if (o.status === "failed") {
      // fallido con COD positivo, flete cobrado, o pago driver de ENTREGADO no reversado
      if (nCod !== 0 || nFee < 0 || (hasDeliveredDriverPay && !hasDeliveredDriverReversal)) {
        failedUncorrected.push({ tc: o.trackingCode, netCod: nCod, netFee: nFee, deliveredPayUnreversed: hasDeliveredDriverPay && !hasDeliveredDriverReversal });
      }
    }
    if (o.status === "delivered") {
      const hasCod = es.some((e) => e.type === "cod_revenue" && Number(e.amountCop) > 0);
      if (o.paymentMethod === "cod" && hasCod && nCod === 0) deliveredReversed.push({ tc: o.trackingCode });
      if (o.paymentMethod === "cod" && !hasCod) deliveredMissing.push({ tc: o.trackingCode, issue: "delivered COD sin cod_revenue" });
    }
  }
  f.failedWithDeliveredFinancials = cut(failedUncorrected);
  f.deliveredButReversedToZero = cut(deliveredReversed);
  f.deliveredMissingCod = cut(deliveredMissing);

  // 4) FUGA COD: cod_revenue de tienda liquidado pero COD no recibido, y el pedido NO está reversado
  f.sellerPaidCodNotReceived = cut(wallet.filter((e) => e.ownerType === "seller" && e.type === "cod_revenue" && e.settlementId && Number(e.amountCop) > 0).filter((e) => {
    const o = orders.get(e.orderId); if (!o || o.paymentMethod !== "cod") return false;
    const es = byOrder.get(e.orderId) ?? []; const nCod = netType(es, ["cod_revenue", "cod_remittance"]);
    return nCod > 0 && !codReceived.has(e.orderId);
  }).map((e) => ({ id: e.id, tc: orders.get(e.orderId)?.trackingCode, amountCop: money(e.amountCop) })));

  // 5) netCop del settlement vs suma real (excluye platform_margin)
  const netMismatch = [];
  for (const [sid, s] of settlements) {
    if (s.kind === "supplier") continue;
    const es = wallet.filter((e) => e.settlementId === sid && e.type !== "platform_margin");
    const sum = money(es.reduce((a, e) => a + Number(e.amountCop || 0), 0));
    const stored = s.kind === "driver" ? money(s.netCop) : money(s.netCop);
    if (s.kind === "seller" && Math.abs(sum - stored) > 1) netMismatch.push({ sid, storedNet: stored, realSum: sum, diff: sum - stored });
  }
  f.sellerSettlementNetMismatch = cut(netMismatch);

  // 6) driver settlement paid/reconciled con efectivo pendiente
  f.driverSettlementCashInconsistent = cut([...settlements.entries()].filter(([, s]) => s.kind === "driver" && (s.status === "paid" || s.status === "reconciled") && money(s.cashPendingCop) > 0).map(([sid, s]) => ({ sid, status: s.status, cashPendingCop: money(s.cashPendingCop) })));

  // 7) settlement.walletEntryIds inexistentes
  f.settlementBrokenEntryRefs = cut([...settlements.entries()].map(([sid, s]) => ({ sid, missing: (s.walletEntryIds ?? []).filter((id) => !entryIds.has(id)) })).filter((r) => r.missing.length > 0));

  const counts = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.length]));
  const totalIssues = Object.values(counts).reduce((a, n) => a + n, 0);
  console.log(JSON.stringify({ totals: { orders: orders.size, wallet: wallet.length, settlements: settlements.size }, totalIssues, counts, findings: f }, null, 2));
  if (totalIssues === 0) console.log("\n✅ Sin anomalías financieras.");
})().catch((e) => { console.error(e.message || e); process.exit(1); });
