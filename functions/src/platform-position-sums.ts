/**
 * Spec 023, fase B (RF_01): la posicion de la plataforma a partir de SUMAS, sin leer el libro de caja.
 *
 * `computePlatformPosition` recorre todos los asientos (19.400 lecturas en noviembre de 2026, y creciendo).
 * Aqui las quince cifras salen de unas pocas sumas que Firestore calcula con `sum()`/`count()` (una lectura por
 * cada 1.000 entradas de indice) mas los cortes, que son ~110 documentos.
 *
 * Una sola aritmetica: `composePlatformPosition` toma las sumas y da las quince cifras. `sumsFromEntries` es su
 * gemelo en memoria —las mismas definiciones, asiento a asiento— y la prueba
 * `src/lib/spec-023-platform-position-sums.test.ts` exige que `composePlatformPosition(sumsFromEntries(w, s), s)`
 * sea identico a `computePlatformPosition(w, s)`. `loadPositionSums` es la version Firestore de esas sumas, y
 * `scripts/verify-023.js position` la compara contra la lectura completa en produccion.
 *
 * Redondeo: `computePlatformPosition` redondea cada asiento; `sum()` no. Son iguales mientras los importes sean
 * enteros (lo son los 19.463 del 2026-11-10). Si una suma sale con decimales, `loadPositionSums` FALLA en vez de
 * dar una cifra que podria diferir en pesos (RF_04).
 *
 * Asientos sin indicador: "por pagar" es `!settlementId` y "retenido" es `!supplierSettlementId`. Firestore no
 * puede preguntar por un campo ausente, asi que `loadPositionSums` comprueba que
 * `count(total) == count("") + count(> "")` y FALLA si no cuadra: un asiento sin el campo es dinero que la
 * consulta no ve (`scripts/backfill-wallet-settlement-flag.js` lo arregla).
 */
import { AggregateField, type Firestore, type Query } from "firebase-admin/firestore";
import { driverSettlementOrderIds, isReceivableCodEntry, isReceivableDriverPay } from "./driver-receivable";
import type { PlatformPosition } from "./platform-position";
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";
import { NO_SUPPLIER_KEY } from "./supplier-withheld";

export type WithheldSupplierSum = { supplierId: string; supplierName: string; sumCop: number };

export type PositionSums = {
  /** Asientos de tienda en cortes pagados o conciliados. */
  payoutsSumCop: number;
  /** Asientos `seller_abono` (negativos). */
  abonoSumCop: number;
  /** Asientos de tienda sin liquidar. */
  payableSumCop: number;
  /** `product_cost` de tienda sin pagar al proveedor, por proveedor (sumas negativas). */
  withheld: WithheldSupplierSum[];
  /** Cobros a la tienda: flete entregado, flete fallido, fulfillment (negativos). */
  feeSumCop: number;
  /** `driver_earning` de domiciliario. */
  driverPaySumCop: number;
  /** COD de tienda (`cod_revenue` + `cod_remittance`) de pedidos que no estan en ningun corte de domiciliario. */
  codOutsideSumCop: number;
  /** `driver_earning` de pedidos que no estan en ningun corte de domiciliario. */
  payOutsideSumCop: number;
};

const SELLER_FEE_TYPES = ["delivery_fee", "failed_fee", "fulfillment_fee"] as const;
const COD_TYPES = ["cod_revenue", "cod_remittance"] as const;
const IN_BATCH = 30;

const round = (value: unknown) => Math.round(Number(value) || 0);

function paidSettlementIds(settlements: SettlementDoc[]): string[] {
  return settlements.filter((settlement) => settlement.status === "paid" || settlement.status === "reconciled").map((settlement) => String(settlement.id));
}

/** Las quince cifras a partir de las sumas. Mismas formulas que `computePlatformPosition`. */
export function composePlatformPosition(sums: PositionSums, settlements: SettlementDoc[]): PlatformPosition {
  const receivedFromDriverCop = settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + round(settlement.cashReceivedCop), 0);
  const paidToSellersCop = sums.payoutsSumCop - sums.abonoSumCop;
  const cashCop = receivedFromDriverCop - paidToSellersCop;

  const driverPendingInSettlementsCop = settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + round(settlement.cashPendingCop), 0);
  const driverCodOutsideSettlementsCop = Math.max(0, sums.codOutsideSumCop - sums.payOutsideSumCop);
  const driverReceivableCop = driverPendingInSettlementsCop + driverCodOutsideSettlementsCop;

  const payableToSellersCop = sums.payableSumCop;
  const withheldForSuppliersCop = -sums.withheld.reduce((total, row) => total + row.sumCop, 0);
  const withheldBySupplier = sums.withheld
    .map((row) => ({ supplierId: row.supplierId, supplierName: row.supplierName, amountCop: -row.sumCop }))
    .filter((row) => row.amountCop !== 0)
    .sort((left, right) => right.amountCop - left.amountCop);

  const feesCop = -sums.feeSumCop;
  const driverPayCop = sums.driverPaySumCop;
  const profitCop = feesCop - driverPayCop;
  const assetsCop = cashCop + driverReceivableCop;
  const liabilitiesCop = payableToSellersCop + withheldForSuppliersCop;

  return {
    cashCop,
    receivedFromDriverCop,
    paidToSellersCop,
    driverReceivableCop,
    driverPendingInSettlementsCop,
    driverCodOutsideSettlementsCop,
    payableToSellersCop,
    withheldForSuppliersCop,
    withheldBySupplier,
    feesCop,
    driverPayCop,
    profitCop,
    assetsCop,
    liabilitiesCop,
    netCop: assetsCop - liabilitiesCop
  };
}

/** Gemelo en memoria de `loadPositionSums`: las mismas sumas, asiento a asiento. Solo para probar. */
export function sumsFromEntries(wallet: WalletEntryDoc[], settlements: SettlementDoc[]): PositionSums {
  const sum = (entries: WalletEntryDoc[]) => entries.reduce((total, entry) => total + round(entry.amountCop), 0);
  const paid = new Set(paidSettlementIds(settlements));
  const inDriverSettlements = driverSettlementOrderIds(settlements);
  const isOutside = (entry: WalletEntryDoc) => Boolean(entry.orderId) && !inDriverSettlements.has(entry.orderId);
  const seller = wallet.filter((entry) => entry.ownerType === "seller");

  const withheldEntries = seller.filter((entry) => entry.type === "product_cost" && !entry.supplierSettlementId);
  const withheld = new Map<string, WithheldSupplierSum>();
  for (const entry of withheldEntries) {
    const supplierId = entry.supplierId ?? NO_SUPPLIER_KEY;
    const row = withheld.get(supplierId) ?? { supplierId, supplierName: entry.supplierName ?? supplierId, sumCop: 0 };
    row.sumCop += round(entry.amountCop);
    if (entry.supplierName) row.supplierName = entry.supplierName;
    withheld.set(supplierId, row);
  }

  return {
    payoutsSumCop: sum(seller.filter((entry) => Boolean(entry.settlementId) && paid.has(String(entry.settlementId)))),
    abonoSumCop: sum(seller.filter((entry) => entry.type === "seller_abono")),
    payableSumCop: sum(seller.filter((entry) => !entry.settlementId)),
    withheld: [...withheld.values()],
    feeSumCop: sum(seller.filter((entry) => (SELLER_FEE_TYPES as readonly string[]).includes(entry.type))),
    driverPaySumCop: sum(wallet.filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning")),
    codOutsideSumCop: sum(wallet.filter((entry) => isReceivableCodEntry(entry) && isOutside(entry))),
    payOutsideSumCop: sum(wallet.filter((entry) => isReceivableDriverPay(entry) && isOutside(entry)))
  };
}

// ---------------------------------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------------------------------

export class PositionSumsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PositionSumsError";
  }
}

type Totals = { sumCop: number; count: number };

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function totals(query: Query, label: string): Promise<Totals> {
  const snap = await query.aggregate({ sumCop: AggregateField.sum("amountCop"), count: AggregateField.count() }).get();
  const data = snap.data();
  const sumCop = Number(data.sumCop ?? 0);
  if (!Number.isInteger(sumCop)) {
    throw new PositionSumsError(`La suma de ${label} tiene decimales (${sumCop}); hay importes no enteros en walletEntries.`);
  }
  return { sumCop, count: Number(data.count ?? 0) };
}

async function sumOf(queries: Array<Promise<Totals>>): Promise<Totals> {
  const parts = await Promise.all(queries);
  return parts.reduce((acc, part) => ({ sumCop: acc.sumCop + part.sumCop, count: acc.count + part.count }), { sumCop: 0, count: 0 });
}

async function countOf(query: Query): Promise<number> {
  const snap = await query.count().get();
  return Number(snap.data().count ?? 0);
}

/**
 * Las sumas de la posicion, calculadas por Firestore. `suppliers` son los proveedores dados de alta (id y
 * nombre); todo asiento retenido de un proveedor que no este en la lista hace fallar la carga.
 *
 * Indices que necesita (todos en `firestore.indexes.json`, spec 023): `walletEntries`
 * (ownerType, settlementId, amountCop), (ownerType, type, amountCop), (ownerType, type, orderId, amountCop),
 * (ownerType, type, supplierSettlementId, amountCop), (ownerType, type, supplierSettlementId, supplierId, amountCop),
 * y para los conteos con desigualdad, sin el campo de suma (uno que acabe en amountCop no les sirve):
 * (ownerType, settlementId), (ownerType, type, supplierSettlementId), (ownerType, type, supplierSettlementId, supplierId).
 */
export async function loadPositionSums(
  db: Firestore,
  settlements: SettlementDoc[],
  suppliers: Array<{ id: string; name?: string }>
): Promise<PositionSums> {
  const wallet = db.collection("walletEntries");
  const seller = wallet.where("ownerType", "==", "seller");
  const productCost = seller.where("type", "==", "product_cost");
  const paidIds = paidSettlementIds(settlements);
  const driverOrderIds = [...driverSettlementOrderIds(settlements)].filter(Boolean);

  // Asientos sin indicador: dinero que las consultas por "" no verian.
  const [sellerTotal, sellerOpen, sellerClosed, pcTotal, pcOpen, pcClosed] = await Promise.all([
    countOf(seller),
    countOf(seller.where("settlementId", "==", "")),
    countOf(seller.where("settlementId", ">", "")),
    countOf(productCost),
    countOf(productCost.where("supplierSettlementId", "==", "")),
    countOf(productCost.where("supplierSettlementId", ">", ""))
  ]);
  if (sellerTotal !== sellerOpen + sellerClosed) {
    throw new PositionSumsError(`${sellerTotal - sellerOpen - sellerClosed} asiento(s) de tienda sin settlementId: correr scripts/backfill-wallet-settlement-flag.js.`);
  }
  if (pcTotal !== pcOpen + pcClosed) {
    throw new PositionSumsError(`${pcTotal - pcOpen - pcClosed} costo(s) de producto sin supplierSettlementId: correr scripts/backfill-wallet-settlement-flag.js.`);
  }

  const withheldOpen = productCost.where("supplierSettlementId", "==", "");
  const knownSupplierIds = suppliers.map((supplier) => supplier.id);
  const [payouts, abono, payable, fees, driverPay, withheldTotal, ...supplierTotals] = await Promise.all([
    sumOf(chunks(paidIds, IN_BATCH).map((batch) => totals(seller.where("settlementId", "in", batch), "cortes pagados"))),
    totals(seller.where("type", "==", "seller_abono"), "abonos"),
    totals(seller.where("settlementId", "==", ""), "por pagar"),
    totals(seller.where("type", "in", [...SELLER_FEE_TYPES]), "cobros"),
    totals(wallet.where("ownerType", "==", "driver").where("type", "==", "driver_earning"), "pago a domiciliarios"),
    totals(withheldOpen, "retenido"),
    ...knownSupplierIds.map((supplierId) => totals(withheldOpen.where("supplierId", "==", supplierId), `retenido de ${supplierId}`))
  ]);

  // Retenido de un supplierId que no esta dado de alta: `not-in` excluye los asientos SIN supplierId, asi que lo
  // que devuelva son proveedores desconocidos, no "(sin proveedor)".
  // `not-in` admite hasta 10 valores. Con mas proveedores no se puede preguntar asi; el total sigue siendo exacto,
  // solo que un proveedor desconocido saldria dentro de "(sin proveedor)".
  if (knownSupplierIds.length > 0 && knownSupplierIds.length <= 10) {
    const unknown = await countOf(withheldOpen.where("supplierId", "not-in", knownSupplierIds));
    if (unknown > 0) throw new PositionSumsError(`${unknown} costo(s) retenido(s) de un proveedor que no esta en suppliers.`);
  }
  const knownSum = supplierTotals.reduce((total, part) => total + part.sumCop, 0);
  const withheld: WithheldSupplierSum[] = suppliers.map((supplier, index) => ({
    supplierId: supplier.id,
    supplierName: supplier.name || supplier.id,
    sumCop: supplierTotals[index].sumCop
  }));
  const noSupplierSum = withheldTotal.sumCop - knownSum;
  if (noSupplierSum !== 0) withheld.push({ supplierId: NO_SUPPLIER_KEY, supplierName: NO_SUPPLIER_KEY, sumCop: noSupplierSum });

  // COD y pago fuera de cortes de domiciliario = total con pedido - lo de pedidos que si estan en un corte.
  const insideBatches = chunks(driverOrderIds, IN_BATCH);
  const outside = async (ownerType: string, type: string) => {
    const base = wallet.where("ownerType", "==", ownerType).where("type", "==", type);
    const [all, inside] = await Promise.all([
      totals(base.where("orderId", ">", ""), `${type} con pedido`),
      sumOf(insideBatches.map((batch) => totals(base.where("orderId", "in", batch), `${type} en cortes`)))
    ]);
    return all.sumCop - inside.sumCop;
  };
  const [codRevenueOutside, codRemittanceOutside, payOutside] = await Promise.all([
    outside("seller", COD_TYPES[0]),
    outside("seller", COD_TYPES[1]),
    outside("driver", "driver_earning")
  ]);

  return {
    payoutsSumCop: payouts.sumCop,
    abonoSumCop: abono.sumCop,
    payableSumCop: payable.sumCop,
    withheld,
    feeSumCop: fees.sumCop,
    driverPaySumCop: driverPay.sumCop,
    codOutsideSumCop: codRevenueOutside + codRemittanceOutside,
    payOutsideSumCop: payOutside
  };
}
