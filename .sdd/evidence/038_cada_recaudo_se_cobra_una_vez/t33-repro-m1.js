const L = "/root/kentro-last-mile/.claude/worktrees/strange-cohen-839664/functions/lib/";
const ledger = require(L + "driver-cash-ledger.js");
const { buildCodReceivedSet, codEntriesByOrder } = require(L + "seller-ledger.js");
// D2 entrega o (COD 100k, pago 9k). X2 (D2) pagado t1, ve 100k.
// Correccion: entregado->fallido->entregado con driverId D1 (tienda sin cobrar: COD borrado y recreado; pago de D2 borrado, pago de D1 creado).
const cod = { id: "we-o-cod", ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: "2026-12-04T00:00:00.000Z" };
const payD1 = { id: "we-o-driver-delivery-pay", ownerType: "driver", ownerId: "D1", orderId: "o", type: "driver_earning", amountCop: 9000, createdAt: "2026-12-04T00:00:00.000Z" };
const X2 = { id: "X2", kind: "driver", ownerId: "D2", status: "paid", createdAt: "2026-12-01T00:00:00.000Z", paidAt: "2026-12-01T01:00:00.000Z", orderIds: ["o"],
  cashCharges: [{ orderId: "o", codCop: 100000, driverPayCop: 9000, chargedCop: 91000, codSeenCop: 100000 }],
  cashExpectedCop: 91000, cashReceivedCop: 91000, cashPendingCop: 0, cashAllocations: [{ orderId: "o", expectedCop: 91000, receivedCop: 91000, covered: true }] };
const entries = [cod, payD1];
const deliveredBy = new Map([["o", "D1"]]);
const ctxD2 = { driverId: "D2", settlements: [X2], baseline: null, holds: null };
console.log("pendingDelta D2:", JSON.stringify(ledger.pendingDeltaOrders({ entries, context: ctxD2, deliveredBy })));
const f = ledger.computeDriverCorte({ settlementId: "X2b", orderIds: ["o"], ownEntryIds: [], entries, context: ctxD2, receivedCop: 0, deliveredBy });
console.log("X2b charges", JSON.stringify(f.charges), "expected", f.cashExpectedCop, "creditOut", f.creditOutCop);
const X2b = { id: "X2b", kind: "driver", ownerId: "D2", status: "paid", createdAt: "2026-12-05T00:00:00.000Z", paidAt: "2026-12-05T01:00:00.000Z", orderIds: ["o"],
  cashCharges: f.charges, cashExpectedCop: f.cashExpectedCop, cashReceivedCop: 0, cashPendingCop: 0, cashAllocations: f.allocations };
const c = codEntriesByOrder(entries);
console.log("recibido solo X2:", buildCodReceivedSet([X2], c).has("o"));
console.log("recibido X2 + X2b (devolucion a D2 pagada, D1 sin corte):", buildCodReceivedSet([X2, X2b], c).has("o"));
// sin marca (comportamiento previo a T32)
const X2bOld = { ...X2b, cashCharges: X2b.cashCharges.map(({ codOtherDriver, ...r }) => r) };
console.log("mismo caso sin marca:", buildCodReceivedSet([X2, X2bOld], c).has("o"));
const ctxD1 = { driverId: "D1", settlements: [], baseline: null, holds: null };
const g = ledger.computeDriverCorte({ settlementId: "X1", orderIds: ["o"], ownEntryIds: ["we-o-driver-delivery-pay"], entries, context: ctxD1, receivedCop: 0, deliveredBy });
const X1p = { id: "X1", kind: "driver", ownerId: "D1", status: "pending", createdAt: "2026-12-06T00:00:00.000Z", orderIds: ["o"], cashCharges: g.charges, cashExpectedCop: g.cashExpectedCop, cashReceivedCop: 0, cashPendingCop: g.cashExpectedCop, cashAllocations: g.allocations };
console.log("con X1 de D1 pendiente sin cubrir:", buildCodReceivedSet([X2, X2b, X1p], c).has("o"));
const X1s = { ...X1p, status: "paid", paidAt: "2026-12-06T02:00:00.000Z", cashReceivedCop: g.cashExpectedCop, cashPendingCop: 0, cashAllocations: g.allocations.map(a => ({ ...a, receivedCop: a.expectedCop, covered: true })) };
console.log("con X1 de D1 saldado:", buildCodReceivedSet([X2, X2b, X1s], c).has("o"));
