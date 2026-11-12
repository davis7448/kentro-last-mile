const L = "/root/kentro-last-mile/.claude/worktrees/strange-cohen-839664/functions/lib/";
const ledger = require(L + "driver-cash-ledger.js");
const { buildCodReceivedSet, codEntriesByOrder } = require(L + "seller-ledger.js");
// D1 entrega o (COD 100.000, pago 9.000) en t0; corte X (038) conciliado en t2.
const X = { id: "X", kind: "driver", ownerId: "D1", status: "reconciled", createdAt: "2026-12-01T00:00:00.000Z", reconciledAt: "2026-12-02T00:00:00.000Z",
  orderIds: ["o"], walletEntryIds: ["we-o-driver-delivery-pay"],
  cashCharges: [{ orderId: "o", codCop: 100000, driverPayCop: 9000, chargedCop: 91000, codSeenCop: 100000 }],
  cashExpectedCop: 91000, cashReceivedCop: 91000, cashPendingCop: 0,
  cashAllocations: [{ orderId: "o", expectedCop: 91000, receivedCop: 91000, covered: true }] };
// Tras entregado->fallido (t3, COD sin cortar de tienda: se BORRA) y fallido->entregado (t4, se recrea we-o-cod con createdAt t4).
const entries = [
  { id: "we-o-cod", ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-12-04T00:00:00.000Z" },
  { id: "we-o-driver-delivery-pay", ownerType: "driver", ownerId: "D1", orderId: "o", type: "driver_earning", amountCop: 9000, createdAt: "2026-11-30T00:00:00.000Z", settlementId: "X" }
];
const context = { driverId: "D1", settlements: [X], baseline: null, holds: null };
const deliveredBy = new Map([["o", "D1"]]);
console.log("pendingDeltaOrders D1:", JSON.stringify(ledger.pendingDeltaOrders({ entries, context, deliveredBy })));
console.log("recibido o:", buildCodReceivedSet([X], codEntriesByOrder(entries)).has("o"));
// Variante con reversa (tienda ya pagada): la regla de suma cero si lo libera.
const withRev = [...entries.slice(1), { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-11-30T00:00:00.000Z" },
  { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_remittance", amountCop: -100000, createdAt: "2026-12-03T00:00:00.000Z" },
  { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-12-04T00:00:00.000Z" }];
console.log("recibido (con reversa):", buildCodReceivedSet([X], codEntriesByOrder(withRev)).has("o"));
// Cambio de tienda A->B visto solo con los asientos de la tienda B (store-api / saldo de tienda):
const storeB = [{ ownerType: "seller", ownerId: "sB", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-12-03T00:00:01.000Z" }];
const all = [{ ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-11-30T00:00:00.000Z" },
  { ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_remittance", amountCop: -100000, createdAt: "2026-12-03T00:00:00.000Z" }, ...storeB];
console.log("cambio de tienda, todos los asientos (createSettlement):", buildCodReceivedSet([X], codEntriesByOrder(all)).has("o"));
console.log("cambio de tienda, solo asientos de B (store-api/saldo):", buildCodReceivedSet([X], codEntriesByOrder(storeB)).has("o"));
