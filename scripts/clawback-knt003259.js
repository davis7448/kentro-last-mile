#!/usr/bin/env node
/**
 * KNT-003259 (shopify-6751318507633), tienda DANDA: quedo "delivered" pero la entrega
 * nunca ocurrio. Sus cuatro asientos de entregado ya estan LIQUIDADOS Y CONCILIADOS:
 *   - cod_revenue    +89.900  -> stl-1787060088036-seller-... (reconciled, pagado a DANDA)
 *   - delivery_fee   -13.500  -> mismo corte de tienda (reconciled)
 *   - product_cost        -0  -> mismo corte de tienda (sin monto, nada que reversar)
 *   - driver_earning +11.000  -> stl-1786735151867-driver-... (reconciled)
 *   y el corte del domiciliario ya registro 78.900 de efectivo entregado por este pedido
 *   (cashAllocations: expected 78.900 / received 78.900 / covered).
 *
 * Por eso NO sirve scripts/correct-delivered-to-failed.js, que aborta cuando el corte
 * no esta "pending". Se aplica el patron de clawback de scripts/clawback-knt561.js:
 * los cortes conciliados NO se tocan y se publican asientos compensatorios en el
 * periodo abierto, que se netean en el proximo corte de cada uno.
 *
 * En DANDA un fallido genera 0 asientos (buildWalletEntries: sellerFailedFeeCop 0 y
 * driverFailedPayCop 0), asi que el estado financiero correcto de este pedido es neto 0:
 *   - cod_remittance -89.900  (reversa COD)              SIN liquidar
 *   - delivery_fee   +13.500  (reversa flete)            SIN liquidar  -> neto tienda -76.400
 *   - driver_earning -11.000  (reversa pago entregado)   SIN liquidar
 *
 * Efecto: DANDA queda con -76.400 de saldo pendiente (se recupera netandolo en su
 * proximo corte). Para el domiciliario, calculateDriverCashSummary cuenta cod_remittance
 * dentro del COD del pedido, asi que en su proximo corte netCop = driverPay - cod =
 * (-11.000) - (-89.900) = +78.900: se le devuelve el efectivo que entrego por una venta
 * que no existio y se le descuenta el pago de la entrega.
 *
 * Ademas pasa el pedido a failed con categoria bad_order_or_no_contact y reetiqueta la
 * evidencia "delivery" -> "failed". Idempotente: aborta si ya existen las reversas.
 *
 * Uso:  node scripts/clawback-knt003259.js            (dry-run)
 *       node scripts/clawback-knt003259.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const apply = process.argv.includes("--apply");
const money = (n) => Math.round(Number(n || 0));
const now = new Date().toISOString();

const OID = "shopify-6751318507633";
const SELLER = "seller-1779315416119"; // DANDA
const DRIVER = "driver-1778271901513";
const FAILED_CATEGORY = "bad_order_or_no_contact";
const FAILED_REASON = "Correccion manual: pedido mal tomado / sin contacto; se cerro como entregado por error";

(async () => {
  const oSnap = await db.collection("orders").doc(OID).get();
  if (!oSnap.exists) throw new Error("Pedido no existe");
  const o = oSnap.data();
  if (o.status !== "delivered") throw new Error(`status "${o.status}" != delivered; revisar`);

  const wS = await db.collection("walletEntries").where("orderId", "==", OID).get();
  const wallet = wS.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byId = new Map(wallet.map((e) => [e.id, e]));

  // Validar los originales de entregado antes de reversar nada.
  const cod = byId.get(`we-${OID}-cod`);
  const fee = byId.get(`we-${OID}-seller-delivery-fee`);
  const drv = byId.get(`we-${OID}-driver-delivery-pay`);
  if (!cod || money(cod.amountCop) !== 89900) throw new Error("No se encontro cod_revenue +89900 original");
  if (!fee || money(fee.amountCop) !== -13500) throw new Error("No se encontro delivery_fee -13500 original");
  if (!drv || money(drv.amountCop) !== 11000) throw new Error("No se encontro driver_earning +11000 original");
  const productCost = wallet.filter((e) => e.type === "product_cost").reduce((a, e) => a + money(e.amountCop), 0);
  if (productCost !== 0) throw new Error(`product_cost ${productCost} != 0; este script no sabe reversarlo`);
  const netNow = money(wallet.reduce((a, e) => a + Number(e.amountCop || 0), 0));

  const reversals = [
    { id: `we-${OID}-correction-reverse-cod`, ownerType: "seller", ownerId: SELLER, orderId: OID, type: "cod_remittance", amountCop: -89900, description: `Correccion: reversa recaudo COD (fallido no cobrable Danda) ${o.shopifyOrderId}`, createdAt: now },
    { id: `we-${OID}-correction-reverse-delivery-fee`, ownerType: "seller", ownerId: SELLER, orderId: OID, type: "delivery_fee", amountCop: 13500, description: `Correccion: reversa flete entregado (fallido Danda) ${o.shopifyOrderId}`, createdAt: now },
    { id: `we-${OID}-correction-reverse-driver-pay`, ownerType: "driver", ownerId: DRIVER, orderId: OID, type: "driver_earning", amountCop: -11000, description: `Correccion: reversa pago transportista (fallido Danda) ${o.shopifyOrderId}`, createdAt: now },
  ];
  for (const r of reversals) if (byId.has(r.id)) throw new Error(`Ya existe reversa ${r.id}; abortando (idempotencia)`);

  const netAfter = netNow + reversals.reduce((a, r) => a + r.amountCop, 0);
  const sellerClawbackCop = reversals.filter((r) => r.ownerType === "seller").reduce((a, r) => a + r.amountCop, 0); // -76400

  // La evidencia de "entrega" documenta en realidad un fallido.
  const evidence = Array.isArray(o.evidence) ? o.evidence : [];
  const nextEvidence = evidence.map((e) =>
    e.type === "delivery"
      ? { ...e, type: "failed", reason: FAILED_REASON, failedCategory: FAILED_CATEGORY, note: `Correccion manual: pedido NO entregado${e.note ? ` (evidencia previa: "${e.note}")` : ""}` }
      : e
  );

  const orderPatch = {
    status: "failed",
    failedReason: FAILED_REASON,
    failedCategory: FAILED_CATEGORY,
    failedCategorySource: "admin",
    retryDecision: "pending",
    evidence: nextEvidence,
    updatedAt: now,
  };

  const auditId = `audit-clawback-${Date.now()}-${OID.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:clawback-knt003259",
    actorRole: "admin",
    action: "order.clawback_delivered_financials",
    entity: "order",
    entityId: OID,
    fromStatus: "delivered",
    toStatus: "failed",
    summary: `KNT-003259 corregido delivered -> failed (${FAILED_CATEGORY}); financieros de entregado reversados sin tocar los cortes conciliados: clawback tienda ${sellerClawbackCop}, reversa driver -11000`,
    createdAt: now,
  };

  if (apply) {
    const batch = db.batch();
    for (const r of reversals) batch.create(db.collection("walletEntries").doc(r.id), r);
    batch.set(db.collection("orders").doc(OID), orderPatch, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  console.log(JSON.stringify({
    apply,
    order: OID,
    trackingCode: o.trackingCode,
    from: "delivered",
    to: `failed (${FAILED_CATEGORY})`,
    netBefore: netNow,
    netAfter,
    sellerClawbackCop,
    driverReversalCop: -11000,
    cortesConciliadosIntactos: ["stl-1787060088036-seller-seller-1779315416119", "stl-1786735151867-driver-driver-1778271901513"],
    reversals: reversals.map((r) => ({ id: r.id, type: r.type, amountCop: r.amountCop, ownerId: r.ownerId })),
    evidencia: `${nextEvidence.filter((e) => e.type === "failed").length} evidencia(s) delivery -> failed`,
    auditId,
  }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
