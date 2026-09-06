#!/usr/bin/env node
/**
 * KNT-003316 (onstock-6712730812598), tienda OnStok: quedo "failed" pero SI se entrego
 * y el domiciliario recaudo los 129.900 contraentrega.
 *
 * No sirve scripts/correct-failed-to-delivered.js: ese aborta cuando el pedido ya tiene
 * asientos, y aqui hay dos, uno de ellos ya conciliado:
 *   - we-...-driver-failed-pay  driver_earning +8.000 -> stl-1786630129293-driver-...
 *     (RECONCILED, ya pagado al domiciliario)
 *   - we-...-seller-failed-fee  failed_fee    -12.000 -> SIN liquidar
 *
 * Se aplica el patron de clawback (scripts/clawback-knt561.js): los cortes conciliados
 * NO se tocan y todo se corrige con asientos en el periodo abierto.
 *
 * Estado financiero objetivo = el que habria escrito closeOrder(outcome=delivered):
 *   cod_revenue +129.900 | delivery_fee -12.000 | product_cost -46.000 | driver_earning +8.000
 *
 * Movimientos:
 *   1. se ELIMINA el failed_fee -12.000 (sin liquidar, nunca debio existir),
 *   2. se crean cod_revenue, delivery_fee y product_cost de la entrega (sin liquidar),
 *   3. el pago al domiciliario: el +8.000 conciliado se deja intacto (el monto de
 *      entregado y el de fallido coinciden, 8.000 en settings/global, asi que la plata
 *      pagada es la correcta). Para dejar el pedido con los asientos canonicos y, sobre
 *      todo, para que ENTRE al proximo corte del domiciliario, se crea el
 *      we-...-driver-delivery-pay +8.000 y su compensacion
 *      we-...-correction-reverse-driver-failed-pay -8.000. Netean 0: no se le paga dos
 *      veces, pero el pedido queda en orderIds del corte.
 *
 * Por que importa el paso 3: calculateDriverCashSummary arma el efectivo esperado a
 * partir de los orderIds del corte, que salen de los asientos del domiciliario. El corte
 * conciliado del 13-ago incluyo este pedido con COD 0 (era fallido), asi que NO tiene
 * cashAllocation y los 129.900 que el domiciliario recaudo nunca se le cobraron. Con las
 * dos reversas el pedido reaparece en su proximo corte con cod +129.900 y pago neto 0,
 * es decir 129.900 de efectivo por entregar. Ademas createSettlement solo libera el
 * cod_revenue de la tienda cuando el pedido figura como COD recibido en un corte de
 * driver pagado/conciliado: sin esto, el cobro de OnStok quedaria bloqueado para siempre.
 *
 * Inventario: el pedido no reservo (sin marcador inventoryReserved), no hay nada que mover.
 *
 * Uso:  node scripts/correct-knt003316-to-delivered.js            (dry-run)
 *       node scripts/correct-knt003316-to-delivered.js --apply    (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const apply = process.argv.includes("--apply");
const money = (n) => Math.round(Number(n || 0));
const now = new Date().toISOString();

const OID = "onstock-6712730812598";
const SELLER = "seller-1780762661093"; // OnStok
const DRIVER = "driver-1778271901513";
const NOTE = "Correccion manual: el pedido si fue entregado y el domiciliario recaudo el COD; se habia cerrado como fallido por error.";

function normalizeProductName(value) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Replica de matchCatalogForLine + resolveProductCostLinesForOrder (functions/src/orders.ts).
function matchCatalogForLine(catalog, sellerId, options) {
  const normalizedSku = typeof options.sku === "string" ? options.sku.trim().toUpperCase() : "";
  const normalizedName = normalizeProductName(typeof options.productName === "string" ? options.productName : "");
  const bySku = normalizedSku
    ? catalog.find((item) => item.sellerId === sellerId && item.active !== false && typeof item.sku === "string" && item.sku.trim().toUpperCase() === normalizedSku)
    : undefined;
  const byName = normalizedName
    ? catalog.find((item) => item.sellerId === sellerId && item.active !== false && !item.sku && item.normalizedProductName === normalizedName)
    : undefined;
  return bySku ?? byName ?? null;
}

function resolveProductCostLines(order, catalog) {
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const hasLineItems = lineItems.length > 0;
  const rawLines = hasLineItems ? lineItems : [{ sku: order.sku, productName: order.productName, quantity: order.quantity }];
  const byProduct = new Map();
  for (const line of rawLines) {
    const quantity = Math.max(1, Number(line?.quantity) || 1);
    const product = matchCatalogForLine(catalog, SELLER, { sku: line?.sku, productName: line?.productName });
    if (!product || product.productCostConfigured !== true) continue;
    const existing = byProduct.get(product.id);
    if (existing) existing.quantity += quantity;
    else byProduct.set(product.id, { product, quantity });
  }
  return Array.from(byProduct.values()).map(({ product, quantity }) => ({
    productId: String(product.id),
    productName: String(product.name ?? "Producto"),
    supplierId: typeof product.supplierId === "string" ? product.supplierId : undefined,
    unitCostCop: money(product.productCostCop),
    quantity,
    totalCostCop: Math.max(0, money(product.productCostCop)) * quantity,
  }));
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

(async () => {
  const oSnap = await db.collection("orders").doc(OID).get();
  if (!oSnap.exists) throw new Error("Pedido no existe");
  const o = { id: oSnap.id, ...oSnap.data() };
  if (o.status !== "failed") throw new Error(`status "${o.status}" != failed; revisar`);
  if (String(o.driverId ?? "") !== DRIVER) throw new Error(`driverId "${o.driverId}" != ${DRIVER}; revisar`);

  const wS = await db.collection("walletEntries").where("orderId", "==", OID).get();
  const wallet = wS.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byId = new Map(wallet.map((e) => [e.id, e]));

  // Validar el estado de partida.
  const failedFee = byId.get(`we-${OID}-seller-failed-fee`);
  const failedPay = byId.get(`we-${OID}-driver-failed-pay`);
  if (!failedFee || money(failedFee.amountCop) !== -12000) throw new Error("No se encontro failed_fee -12000 original");
  if (failedFee.settlementId) throw new Error(`el failed_fee ya esta liquidado en ${failedFee.settlementId}; requiere reversa, no borrado`);
  if (!failedPay || money(failedPay.amountCop) !== 8000) throw new Error("No se encontro driver_earning +8000 de fallido original");
  const netNow = money(wallet.reduce((a, e) => a + Number(e.amountCop || 0), 0));

  // Tarifas y costo de producto vivos.
  const [settingsSnap, catalogSnap] = await Promise.all([
    db.doc("settings/global").get(),
    db.collection("productCatalog").where("sellerId", "==", SELLER).get(),
  ]);
  const settings = settingsSnap.data() ?? {};
  const sellerDeliveredFeeCop = money(settings.sellerDeliveredFeeCop) || 12000;
  const driverDeliveredPayCop = money(settings.driverDeliveredPayCop) || 9000;
  const catalog = catalogSnap.docs.map((c) => ({ id: c.id, ...c.data() }));
  const costLines = resolveProductCostLines(o, catalog);
  if (costLines.length === 0) throw new Error("No se pudo resolver el costo de producto; revisar catalogo");

  const hasLineItems = Array.isArray(o.lineItems) && o.lineItems.length > 0;
  const creates = [
    { id: `we-${OID}-cod`, ownerType: "seller", ownerId: SELLER, orderId: OID, type: "cod_revenue", amountCop: money(o.totalCop), description: `Recaudo COD pedido ${o.shopifyOrderId}`, createdAt: now },
    { id: `we-${OID}-seller-delivery-fee`, ownerType: "seller", ownerId: SELLER, orderId: OID, type: "delivery_fee", amountCop: -sellerDeliveredFeeCop, description: `Flete entregado ${o.shopifyOrderId}`, createdAt: now },
    { id: `we-${OID}-driver-delivery-pay`, ownerType: "driver", ownerId: DRIVER, orderId: OID, type: "driver_earning", amountCop: driverDeliveredPayCop, description: `Pago transportista entregado ${o.shopifyOrderId}`, createdAt: now },
    // Compensa el pago de fallido ya conciliado: el domiciliario cobra una sola vez.
    { id: `we-${OID}-correction-reverse-driver-failed-pay`, ownerType: "driver", ownerId: DRIVER, orderId: OID, type: "driver_earning", amountCop: -money(failedPay.amountCop), description: `Correccion: reversa pago fallido (el pedido si se entrego) ${o.shopifyOrderId}`, createdAt: now },
    ...costLines.map((line) => stripUndefined({
      id: hasLineItems ? `we-${OID}-product-cost-${line.productId}` : `we-${OID}-product-cost`,
      ownerType: "seller", ownerId: SELLER, orderId: OID, type: "product_cost",
      amountCop: -line.totalCostCop,
      description: `Costo producto ${o.shopifyOrderId}`,
      supplierId: line.supplierId, productId: line.productId, productName: line.productName,
      createdAt: now,
    })),
  ];
  for (const c of creates) if (byId.has(c.id)) throw new Error(`Ya existe ${c.id}; abortando (idempotencia)`);

  const netAfter = netNow - money(failedFee.amountCop) + creates.reduce((a, c) => a + c.amountCop, 0);
  const sellerNetCop = creates.filter((c) => c.ownerType === "seller").reduce((a, c) => a + c.amountCop, 0) - money(failedFee.amountCop);
  const driverNetNuevoCop = creates.filter((c) => c.ownerType === "driver").reduce((a, c) => a + c.amountCop, 0);

  // La evidencia de "fallido" documenta en realidad una entrega.
  const evidence = Array.isArray(o.evidence) ? o.evidence : [];
  const nextEvidence = evidence.map((e) => {
    if (e.type !== "failed") return e;
    const { reason, failedCategory, ...rest } = e;
    return { ...rest, type: "delivery", note: `Correccion manual: pedido entregado${e.note ? ` (evidencia previa: "${e.note}")` : ""}` };
  });

  const orderPatch = {
    status: "delivered",
    callNote: NOTE,
    evidence: nextEvidence,
    failedReason: FieldValue.delete(),
    failedCategory: FieldValue.delete(),
    failedCategorySource: FieldValue.delete(),
    failedCategoryConfidence: FieldValue.delete(),
    retryDecision: FieldValue.delete(),
    updatedAt: now,
  };

  const auditId = `audit-correct-failed-delivered-${Date.now()}-${OID.slice(-8)}`;
  const audit = {
    id: auditId,
    actorId: "script:correct-knt003316-to-delivered",
    actorRole: "admin",
    action: "order.correct_failed_to_delivered",
    entity: "order",
    entityId: OID,
    fromStatus: "failed",
    toStatus: "delivered",
    summary: `KNT-003316 corregido failed -> delivered sin tocar el corte conciliado del domiciliario: eliminado failed_fee -12000, creados ${creates.length} asientos (COD +${money(o.totalCop)}, flete -${sellerDeliveredFeeCop}, costo producto ${costLines.reduce((a, l) => a - l.totalCostCop, 0)}, pago driver neto ${driverNetNuevoCop})`,
    createdAt: now,
  };

  if (apply) {
    const batch = db.batch();
    batch.delete(db.collection("walletEntries").doc(failedFee.id));
    for (const c of creates) batch.create(db.collection("walletEntries").doc(c.id), c);
    batch.set(db.collection("orders").doc(OID), orderPatch, { merge: true });
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  console.log(JSON.stringify({
    apply,
    order: OID,
    trackingCode: o.trackingCode,
    from: "failed",
    to: "delivered",
    netBefore: netNow,
    netAfter,
    eliminado: { id: failedFee.id, type: failedFee.type, amountCop: money(failedFee.amountCop) },
    creados: creates.map((c) => ({ id: c.id, type: c.type, amountCop: c.amountCop, ownerType: c.ownerType })),
    costoProducto: costLines.map((l) => `${l.productName} x${l.quantity} @ ${l.unitCostCop} = ${l.totalCostCop}`),
    netoSellerCop: sellerNetCop,
    netoDriverNuevoCop: driverNetNuevoCop,
    efectivoQueDeberaEntregarElDriver: money(o.totalCop),
    corteConciliadoIntacto: "stl-1786630129293-driver-driver-1778271901513",
    evidencia: `${nextEvidence.filter((e) => e.type === "delivery").length} evidencia(s) failed -> delivery`,
    auditId,
  }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
