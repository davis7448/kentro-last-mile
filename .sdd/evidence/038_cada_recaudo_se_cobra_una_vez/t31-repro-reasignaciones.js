const L = "/root/kentro-last-mile/.claude/worktrees/strange-cohen-839664/functions/lib/";
const ledger = require(L + "driver-cash-ledger.js");
const { buildCodReceivedSet, codEntriesByOrder } = require(L + "seller-ledger.js");
const cod = (at) => ({ id: "we-o-cod", ownerType: "seller", ownerId: "sA", orderId: "o", type: "cod_revenue", amountCop: 100000, createdAt: at });
const pay = (d, at) => ({ id: "we-o-driver-delivery-pay", ownerType: "driver", ownerId: d, orderId: "o", type: "driver_earning", amountCop: 9000, createdAt: at });
function mk(id, d, entries, settlements, deliveredBy, own, createdAt, paid) {
  const ctx = { driverId: d, settlements: settlements.filter(s => s.ownerId === d), baseline: null, holds: null };
  const f = ledger.computeDriverCorte({ settlementId: id, orderIds: ["o"], ownEntryIds: own, entries, context: ctx, receivedCop: paid ? 1e9 : 0, deliveredBy });
  const exp = f.cashExpectedCop;
  return { id, kind: "driver", ownerId: d, status: paid ? "paid" : "pending", createdAt, ...(paid ? { paidAt: createdAt } : {}), orderIds: ["o"], walletEntryIds: own,
    cashCharges: f.charges, cashExpectedCop: exp, cashReceivedCop: paid ? exp : 0, cashPendingCop: paid ? 0 : exp, creditInCop: f.creditInCop, creditOutCop: f.creditOutCop,
    cashAllocations: f.allocations.map(a => paid ? { ...a, receivedCop: a.expectedCop, covered: true } : a) };
}
const rec = (S, E) => buildCodReceivedSet(S, codEntriesByOrder(E)).has("o");
const delta = (d, E, S, dB) => JSON.stringify(ledger.pendingDeltaOrders({ entries: E, context: { driverId: d, settlements: S.filter(s => s.ownerId === d), baseline: null, holds: null }, deliveredBy: dB }));
// Cadena D1 -> D2 -> D1
let E = [cod("t1"), pay("D1", "t1")];
const X1 = mk("X1", "D1", E, [], new Map([["o", "D1"]]), ["we-o-driver-delivery-pay"], "2026-12-01T00:00:00.000Z", true);
// pasa a D2 (borra y recrea): pago de D1 borrado, pago de D2 nuevo
E = [cod("t2"), pay("D2", "t2")];
let dB = new Map([["o", "D2"]]);
console.log("tras pasar a D2, sin cortes nuevos:", rec([X1], E), "delta D1", delta("D1", E, [X1], dB));
const X1b = mk("X1b", "D1", E, [X1], dB, [], "2026-12-02T00:00:00.000Z", true);
console.log("X1b", JSON.stringify(X1b.cashCharges), "recibido:", rec([X1, X1b], E), "delta D2", delta("D2", E, [X1, X1b], dB));
// vuelve a D1 sin corte de D2
E = [cod("t3"), pay("D1", "t3")];
dB = new Map([["o", "D1"]]);
console.log("vuelve a D1 (X1b saldado marcado):", rec([X1, X1b], E), "delta D1", delta("D1", E, [X1, X1b], dB));
const X1c = mk("X1c", "D1", E, [X1, X1b], dB, ["we-o-driver-delivery-pay"], "2026-12-03T00:00:00.000Z", false);
console.log("X1c pendiente", JSON.stringify(X1c.cashCharges), "recibido:", rec([X1, X1b, X1c], E));
const X1cp = mk("X1c", "D1", E, [X1, X1b], dB, ["we-o-driver-delivery-pay"], "2026-12-03T00:00:00.000Z", true);
console.log("X1c pagado:", rec([X1, X1b, X1cp], E));
// Variante: X1b pendiente cuando vuelve a D1 (sin recalcular)
const X1bp = mk("X1b", "D1", [cod("t2"), pay("D2", "t2")], [X1], new Map([["o", "D2"]]), [], "2026-12-02T00:00:00.000Z", false);
console.log("X1b pendiente marcado, vuelve a D1:", rec([X1, X1bp], E), "delta D1 (excluye pendientes):", delta("D1", E, [X1, X1bp], dB));
// D2 con corte X2 saldado y luego vuelve a D1 sin corte nuevo de nadie
E = [cod("t2"), pay("D2", "t2")]; dB = new Map([["o", "D2"]]);
const X2 = mk("X2", "D2", E, [], dB, ["we-o-driver-delivery-pay"], "2026-12-02T12:00:00.000Z", true);
E = [cod("t3"), pay("D1", "t3")]; dB = new Map([["o", "D1"]]);
console.log("X1 + X1b + X2 saldados, vuelve a D1 sin cortes:", rec([X1, X1b, X2], E), "delta D1", delta("D1", E, [X1, X1b, X2], dB), "delta D2", delta("D2", E, [X1, X1b, X2], dB));
