#!/usr/bin/env node
/**
 * El corte de DANDA del 30-jul quedo marcado como pagado por su neto completo
 * ($8.758.000), pero la transferencia real fue de $6.200.000. La diferencia sigue
 * siendo plata que Kentro le debe a la tienda.
 *
 * El corte esta "reconciled" y no se puede reabrir (por diseño), asi que la deuda se
 * restituye con un asiento de ajuste. Se usa `seller_abono` en POSITIVO (reversa de un
 * pago registrado y no transferido) porque es un tipo liquidable: asi entra solo al
 * proximo corte de la tienda. Un `payout` -como el ajuste historico de sobrepago- no
 * esta en isLiquidationWalletType y quedaria como saldo pendiente eterno.
 *
 * Uso: node scripts/fix-danda-underpaid-settlement.js            (dry-run)
 *      node scripts/fix-danda-underpaid-settlement.js --apply     (escribe)
 */
const admin = require("../functions/node_modules/firebase-admin");
admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const apply = process.argv.includes("--apply");
const now = new Date().toISOString();

const SELLER = "seller-1779315416119";
const SETTLEMENT = "stl-1785434706953-seller-seller-1779315416119";
const TRANSFERRED_COP = 6200000;

(async () => {
  const settlementSnap = await db.collection("settlements").doc(SETTLEMENT).get();
  if (!settlementSnap.exists) throw new Error("corte no encontrado");
  const settlement = settlementSnap.data();
  const netCop = Math.round(Number(settlement.netCop) || 0);
  const unpaidCop = netCop - TRANSFERRED_COP;
  if (unpaidCop <= 0) throw new Error(`nada que ajustar: neto ${netCop} <= transferido ${TRANSFERRED_COP}`);

  const id = `we-danda-underpaid-${SETTLEMENT.slice(-13)}`;
  const existing = await db.collection("walletEntries").doc(id).get();
  if (existing.exists) {
    console.log(JSON.stringify({ apply, yaAplicado: true, id, amountCop: existing.data().amountCop }, null, 2));
    process.exit(0);
  }

  const entry = {
    id,
    ownerType: "seller",
    ownerId: SELLER,
    orderId: "",
    type: "seller_abono",
    amountCop: unpaidCop, // POSITIVO: restituye la deuda con la tienda
    description: `Ajuste: saldo no transferido del corte ${settlement.startDate} a ${settlement.endDate} (neto ${netCop}, transferido ${TRANSFERRED_COP})`,
    createdAt: now
  };
  const auditId = `audit-danda-underpaid-${Date.now()}`;
  const audit = {
    id: auditId,
    actorId: "script:fix-danda-underpaid-settlement",
    actorRole: "admin",
    action: "wallet.settlement_underpayment_adjusted",
    entity: "seller",
    entityId: SELLER,
    summary: `Corte ${SETTLEMENT}: neto ${netCop}, transferido ${TRANSFERRED_COP}; se restituyen ${unpaidCop} como saldo por pagar`,
    createdAt: now
  };

  const pendBefore = (await db.collection("walletEntries").where("ownerType", "==", "seller").where("ownerId", "==", SELLER).get())
    .docs.map((d) => d.data()).filter((e) => !e.settlementId)
    .reduce((sum, e) => sum + Math.round(Number(e.amountCop) || 0), 0);

  if (apply) {
    const batch = db.batch();
    batch.create(db.collection("walletEntries").doc(id), entry);
    batch.set(db.collection("auditEvents").doc(auditId), audit);
    await batch.commit();
  }

  console.log(JSON.stringify({
    apply,
    corte: { id: SETTLEMENT, periodo: `${settlement.startDate} a ${settlement.endDate}`, netoCop: netCop, status: settlement.status },
    transferidoCop: TRANSFERRED_COP,
    saldoNoTransferidoCop: unpaidCop,
    pendienteAntes: pendBefore,
    pendienteDespues: pendBefore + unpaidCop,
    asiento: id
  }, null, 2));
  process.exit(0);
})().catch((error) => { console.error(error.message || error); process.exit(1); });
