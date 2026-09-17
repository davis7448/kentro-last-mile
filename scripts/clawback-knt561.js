#!/usr/bin/env node
/**
 * KNT-000561 (shopify-7863297769622), tienda DANDA: quedó en "failed" pero con financieros
 * completos de ENTREGADO ya liquidados (COD +89.900 y flete -12.000 en settlement de tienda
 * RECONCILIADO; pago driver "entregado" +11.000 en settlement de driver PENDING). Un fallido
 * Danda debe netear a $0. Esta corrección reversa los financieros (clawback), mismo patrón
 * que KNT-000262:
 *   - cod_remittance -89.900  (reversa COD)          SIN liquidar
 *   - delivery_fee   +12.000  (reversa flete)        SIN liquidar   -> neto tienda -77.900
 *   - driver_earning -11.000  (reversa pago driver)  asignado al settlement driver PENDING
 * No toca los settlements reconciliados. El -77.900 queda como saldo pendiente de DANDA
 * (se recupera netándolo en su próximo corte). Idempotente: aborta si ya existen las reversas.
 *
 * Uso:  node scripts/clawback-knt561.js           (dry-run)
 *       node scripts/clawback-knt561.js --apply
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const money = (n) => Math.round(Number(n || 0));
const now = new Date().toISOString();

const OID = "shopify-7863297769622";
const SELLER = "seller-1779315416119";
const DRIVER = "driver-1778271901513";
const DRIVER_SETTLEMENT = "stl-1781929513446-driver-driver-1778271901513";

(async () => {
  const oSnap = await db.collection("orders").doc(OID).get();
  if (!oSnap.exists) throw new Error("Pedido no existe");
  const o = oSnap.data();
  if (o.status !== "failed") throw new Error(`status "${o.status}" != failed; revisar`);

  const wS = await db.collection("walletEntries").where("orderId", "==", OID).get();
  const wallet = wS.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byId = new Map(wallet.map((e) => [e.id, e]));

  // Validar que existan los originales de entregado y que no haya reversas previas.
  const cod = byId.get(`we-${OID}-cod`);
  const fee = byId.get(`we-${OID}-seller-delivery-fee`);
  const drv = byId.get(`we-${OID}-driver-delivery-pay`);
  if (!cod || money(cod.amountCop) !== 89900) throw new Error("No se encontró cod_revenue +89900 original");
  if (!fee || money(fee.amountCop) !== -12000) throw new Error("No se encontró delivery_fee -12000 original");
  if (!drv || money(drv.amountCop) !== 11000) throw new Error("No se encontró driver_earning +11000 original");
  const netNow = money(wallet.reduce((a, e) => a + Number(e.amountCop || 0), 0));

  const reversals = [
    { id: `we-${OID}-correction-reverse-cod`, ownerType: "seller", ownerId: SELLER, orderId: OID, type: "cod_remittance", amountCop: -89900, description: "Correccion: reversa recaudo COD (fallido no cobrable Danda) #47970", createdAt: now },
    { id: `we-${OID}-correction-reverse-delivery-fee`, ownerType: "seller", ownerId: SELLER, orderId: OID, type: "delivery_fee", amountCop: 12000, description: "Correccion: reversa flete entregado (fallido Danda) #47970", createdAt: now },
    { id: `we-${OID}-correction-reverse-driver-pay`, ownerType: "driver", ownerId: DRIVER, orderId: OID, type: "driver_earning", amountCop: -11000, description: "Correccion: reversa pago transportista (fallido Danda) #47970", createdAt: now, settlementId: DRIVER_SETTLEMENT },
  ];
  for (const r of reversals) if (byId.has(r.id)) throw new Error(`Ya existe reversa ${r.id}; abortando (idempotencia)`);

  const netAfter = netNow + reversals.reduce((a, r) => a + r.amountCop, 0);
  const sellerClawbackCop = reversals.filter((r) => r.ownerType === "seller").reduce((a, r) => a + r.amountCop, 0); // -77900

  const auditId = `audit-clawback-${Date.now()}-${OID.slice(-8)}`;
  if (apply) {
    const batch = db.batch();
    for (const r of reversals) batch.set(db.collection("walletEntries").doc(r.id), r);
    // dejar constancia en el pedido
    batch.set(db.collection("orders").doc(OID), { failedReason: "Fallido; financieros de entregado reversados (clawback)", updatedAt: now }, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), {
      id: auditId, actorId: "script:clawback-knt561", actorRole: "admin",
      action: "order.clawback_delivered_financials", entity: "order", entityId: OID,
      summary: `KNT-000561 fallido: reversados financieros de entregado; clawback tienda ${sellerClawbackCop}, reversa driver -11000`,
      createdAt: now,
    });
    await batch.commit();
  }

  console.log(JSON.stringify({
    apply, order: OID,
    netBefore: netNow, netAfter,
    sellerClawbackCop, driverReversalCop: -11000,
    reversals: reversals.map((r) => ({ id: r.id, type: r.type, amountCop: r.amountCop, settlementId: r.settlementId ?? null })),
    auditId,
  }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
