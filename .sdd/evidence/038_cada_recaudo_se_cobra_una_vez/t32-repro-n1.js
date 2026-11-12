const L = "/root/kentro-last-mile/.claude/worktrees/strange-cohen-839664/functions/lib/";
const ledger = require(L + "driver-cash-ledger.js");
const sl = require(L + "seller-ledger.js");
const { buildCodReceivedSet, codEntriesByOrder, codOrdersToComplete } = sl;
// Caso A: D1 visita fallida (pago 5.000) dia 1; D2 entrega (COD 100.000, pago 9.000) dia 2.
// Corte de D2 (creado dia 2, saldado) ve 100.000. Corte de D1 creado dia 3 (incluye el pedido por su pago de visita).
const entries = [
  { id: "we-o-driver-visit-pay", ownerType: "driver", ownerId: "D1", orderId: "o", type: "driver_earning", amountCop: 5000, createdAt: "2026-12-01T10:00:00.000Z" },
  { id: "we-o-cod", ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-12-02T10:00:00.000Z" },
  { id: "we-o-driver-delivery-pay", ownerType: "driver", ownerId: "D2", orderId: "o", type: "driver_earning", amountCop: 9000, createdAt: "2026-12-02T10:00:00.000Z" },
];
const deliveredBy = new Map([["o", "D2"]]);
function corte(id, driverId, createdAt, ownIds) {
  const context = { driverId, settlements: [], baseline: null, holds: null };
  const f = ledger.computeDriverCorte({ settlementId: id, orderIds: ["o"], ownEntryIds: ownIds, entries, context, receivedCop: 1e9, deliveredBy });
  return { id, kind: "driver", ownerId: driverId, status: "paid", createdAt, paidAt: createdAt, orderIds: ["o"], walletEntryIds: ownIds,
    cashCharges: f.charges, cashExpectedCop: f.cashExpectedCop, cashReceivedCop: f.cashExpectedCop, cashPendingCop: 0, cashAllocations: f.allocations };
}
const X2 = corte("X2", "D2", "2026-12-02T20:00:00.000Z", ["we-o-driver-delivery-pay"]);
const X1 = corte("X1", "D1", "2026-12-03T20:00:00.000Z", ["we-o-driver-visit-pay"]);
console.log("X2 charges", JSON.stringify(X2.cashCharges));
console.log("X1 charges", JSON.stringify(X1.cashCharges));
const cod = codEntriesByOrder(entries);
console.log("recibido (solo X2):", buildCodReceivedSet([X2], cod).has("o"));
console.log("recibido (X2 + X1 posterior):", buildCodReceivedSet([X2, X1], cod).has("o"));
console.log("codOrdersToComplete:", codOrdersToComplete([X2, X1], cod));
console.log("pendingDeltaOrders D2:", JSON.stringify(ledger.pendingDeltaOrders({ entries, context: { driverId: "D2", settlements: [X2], baseline: null, holds: null }, deliveredBy })));
console.log("pendingDeltaOrders D1:", JSON.stringify(ledger.pendingDeltaOrders({ entries, context: { driverId: "D1", settlements: [X1], baseline: null, holds: null }, deliveredBy })));
// Orden inverso: X1 creado antes de la entrega
const X1b = { ...X1, createdAt: "2026-12-01T20:00:00.000Z", paidAt: "2026-12-01T20:00:00.000Z" };
console.log("recibido (X1 antes de X2):", buildCodReceivedSet([X2, X1b], cod).has("o"));
