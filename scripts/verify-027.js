#!/usr/bin/env node
/**
 * Spec 027 (RF_04, RNF_01): SOLO LECTURA. Que pedidos pasan a "recibidos" con la regla nueva y cuanto
 * dinero de tiendas y proveedores se libera. Compila antes: `cd functions && npm run build`.
 *
 * La regla vieja se copia aqui SOLO como linea base de comparacion; la nueva se importa de functions/lib.
 */
const admin = require("../functions/node_modules/firebase-admin");
const { buildCodReceivedSet, SELLER_LIQUIDATION_TYPES } = require("../functions/lib/seller-ledger.js");
const { computeSellerBalance } = require("../functions/lib/seller-balance.js");
const { loadSellerBalanceInput } = require("../functions/lib/seller-balance-api.js");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

function oldRule(settlements) {
  const set = new Set();
  for (const s of settlements) {
    if (s.kind !== "driver") continue;
    if (Array.isArray(s.cashAllocations) && s.cashAllocations.length > 0) {
      for (const a of s.cashAllocations) if (a.covered && a.orderId) set.add(String(a.orderId));
      continue;
    }
    if (s.status === "paid" || s.status === "reconciled") for (const id of s.orderIds ?? []) set.add(String(id));
  }
  return set;
}

(async () => {
  const [settlementSnap, sellerSnap, sellerEntrySnap] = await Promise.all([
    db.collection("settlements").get(),
    db.collection("sellers").get(),
    db.collection("walletEntries").where("ownerType", "==", "seller").get()
  ]);
  const settlements = settlementSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const sellerName = new Map(sellerSnap.docs.map((d) => [d.id, d.data().name]));
  const before = oldRule(settlements);
  const after = buildCodReceivedSet(settlements);
  const released = [...after].filter((id) => !before.has(id));
  const lost = [...before].filter((id) => !after.has(id));
  console.log(`Pedidos que pasan a recibidos: ${released.length}. Pedidos que dejan de estarlo: ${lost.length} (debe ser 0)`);

  const releasedSet = new Set(released);
  const bySeller = new Map();
  const bySupplier = new Map();
  for (const doc of sellerEntrySnap.docs) {
    const e = doc.data();
    if (!releasedSet.has(String(e.orderId))) continue;
    if (e.type === "product_cost" && !e.supplierSettlementId && e.supplierId) {
      const k = e.supplierName || e.supplierId;
      bySupplier.set(k, (bySupplier.get(k) ?? 0) - Number(e.amountCop || 0));
    }
    if (e.settlementId || !SELLER_LIQUIDATION_TYPES.has(e.type)) continue;
    const k = e.ownerId;
    const row = bySeller.get(k) ?? { pedidos: new Set(), cop: 0 };
    row.pedidos.add(String(e.orderId));
    row.cop += Number(e.amountCop || 0);
    bySeller.set(k, row);
  }
  console.log("\nLiberado por tienda (saldo sin cortar que deja de estar bloqueado):");
  for (const [id, row] of [...bySeller].sort((a, b) => b[1].cop - a[1].cop)) {
    console.log(`  ${sellerName.get(id) ?? id}: ${row.pedidos.size} pedidos, $${row.cop.toLocaleString("es-CO")}`);
  }
  console.log("\nProducto pendiente de pagar al proveedor que deja de estar retenido:");
  for (const [k, cop] of [...bySupplier].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: $${cop.toLocaleString("es-CO")}`);

  // Saldo de DANDA con la regla nueva (el que vera la API de tiendas tras desplegar).
  const danda = "seller-1779315416119";
  const balance = computeSellerBalance(await loadSellerBalanceInput(db, danda, new Date().toISOString()));
  console.log(`\nDANDA con la regla nueva: disponible $${balance.availableCop.toLocaleString("es-CO")}, retenido $${balance.heldCop.toLocaleString("es-CO")}, bloqueado COD $${balance.codPendingCop.toLocaleString("es-CO")} (${balance.codPendingOrderCount} pedidos)`);

  // RNF_01: la posicion de plataforma no depende de esta regla (no la importa); se comprueba por fuente.
  const fs = require("fs");
  const position = fs.readFileSync(require("path").join(__dirname, "../functions/src/platform-position.ts"), "utf8");
  console.log(`\nRNF_01: platform-position.ts usa la regla de recibido: ${/buildCodReceivedSet|seller-ledger/.test(position) ? "SI (revisar)" : "no (la posicion no cambia)"}`);
  process.exit(0);
})();
