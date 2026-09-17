/**
 * Posicion de la plataforma, calculada EN EL SERVIDOR.
 *
 * Por que existe: el navegador del admin se suscribia a la coleccion `walletEntries` ENTERA solo
 * para poder derivar estas quince cifras. Medido en produccion eran 10.452 documentos y 3,58 MB —
 * el 68% de toda su carga inicial — de los que unicamente 980 estaban sin liquidar. Y crece ~3.700
 * asientos al mes, asi que el problema no era el tamano de hoy sino que no tenia techo.
 *
 * A diferencia de `getOrderStats`, aqui NO todo se puede resolver con `count()`. Las sumas simples
 * (fees, pago a domiciliarios, saldo por pagar, abonos) si son agregables, pero tres cifras exigen
 * cruzar cada asiento con otra coleccion:
 *  - lo pagado en cortes depende del ESTADO del corte de cada asiento,
 *  - el COD que aun no entro a ningun corte se define por NO pertenecer a un conjunto de pedidos,
 *  - el retenido por proveedor hay que agruparlo por proveedor.
 * Se recorren los asientos, entonces. Leerlos aqui cuesta lecturas de Firestore; bajarlos al
 * telefono costaba megabytes en la red del usuario. El objetivo es lo segundo, no lo primero.
 *
 * La aritmetica vive en `computePlatformPosition`, que es PURA: recibe los documentos y no toca
 * Firestore. Asi es exactamente el mismo codigo que `calculatePlatformPosition` en el cliente y
 * las dos no pueden divergir mientras se prueben contra los mismos casos.
 */
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import type { SettlementDoc, WalletEntryDoc } from "./settlement-math";

export type PlatformPosition = {
  cashCop: number;
  receivedFromDriverCop: number;
  paidToSellersCop: number;
  driverReceivableCop: number;
  driverPendingInSettlementsCop: number;
  driverCodOutsideSettlementsCop: number;
  payableToSellersCop: number;
  withheldForSuppliersCop: number;
  withheldBySupplier: Array<{ supplierId: string; supplierName: string; amountCop: number }>;
  feesCop: number;
  driverPayCop: number;
  profitCop: number;
  assetsCop: number;
  liabilitiesCop: number;
  netCop: number;
};

const SELLER_FEE_TYPES: WalletEntryDoc["type"][] = ["delivery_fee", "failed_fee", "fulfillment_fee"];

/** Espejo exacto de `calculatePlatformPosition` (src/lib/finance.ts). Puro: sin Firestore. */
export function computePlatformPosition(wallet: WalletEntryDoc[], settlements: SettlementDoc[]): PlatformPosition {
  const settlementById = new Map(settlements.map((settlement) => [settlement.id, settlement]));
  const isPaid = (settlementId?: string) => {
    const status = settlementId ? settlementById.get(settlementId)?.status : undefined;
    return status === "paid" || status === "reconciled";
  };
  const sum = (entries: WalletEntryDoc[]) => entries.reduce((total, entry) => total + Math.round(entry.amountCop), 0);

  const sellerEntries = wallet.filter((entry) => entry.ownerType === "seller");
  const driverEarnings = wallet.filter((entry) => entry.ownerType === "driver" && entry.type === "driver_earning");

  // Caja: entra el efectivo del domiciliario, sale el neto de cada corte pagado y los abonos
  // (que se entregan por fuera del corte y luego se netean dentro de el).
  const receivedFromDriverCop = settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + Math.round(Number(settlement.cashReceivedCop) || 0), 0);
  const settlementPayoutsCop = sum(sellerEntries.filter((entry) => isPaid(entry.settlementId)));
  const abonosPaidCop = -sum(sellerEntries.filter((entry) => entry.type === "seller_abono"));
  const paidToSellersCop = settlementPayoutsCop + abonosPaidCop;
  const cashCop = receivedFromDriverCop - paidToSellersCop;

  // Por cobrar al domiciliario: lo pendiente en cortes MAS el COD de pedidos entregados que
  // todavia no entraron a ningun corte.
  const driverPendingInSettlementsCop = settlements
    .filter((settlement) => settlement.kind === "driver")
    .reduce((total, settlement) => total + Math.round(Number(settlement.cashPendingCop) || 0), 0);
  const orderIdsInDriverSettlements = new Set(
    settlements.filter((settlement) => settlement.kind === "driver").flatMap((settlement) => settlement.orderIds ?? [])
  );
  const outsideCod = sum(sellerEntries.filter((entry) =>
    (entry.type === "cod_revenue" || entry.type === "cod_remittance") && entry.orderId && !orderIdsInDriverSettlements.has(entry.orderId)
  ));
  const outsidePay = sum(driverEarnings.filter((entry) => entry.orderId && !orderIdsInDriverSettlements.has(entry.orderId)));
  const driverCodOutsideSettlementsCop = Math.max(0, outsideCod - outsidePay);
  const driverReceivableCop = driverPendingInSettlementsCop + driverCodOutsideSettlementsCop;

  const payableToSellersCop = sum(sellerEntries.filter((entry) => !entry.settlementId));

  // Costo de producto retenido: descontado a la tienda y aun no liquidado al proveedor.
  const withheldEntries = sellerEntries.filter((entry) => entry.type === "product_cost" && !entry.supplierSettlementId);
  const withheldForSuppliersCop = -sum(withheldEntries);
  const bySupplier = new Map<string, { supplierId: string; supplierName: string; amountCop: number }>();
  for (const entry of withheldEntries) {
    const supplierId = entry.supplierId ?? "(sin proveedor)";
    const current = bySupplier.get(supplierId) ?? { supplierId, supplierName: entry.supplierName ?? supplierId, amountCop: 0 };
    current.amountCop += -Math.round(entry.amountCop);
    if (entry.supplierName) current.supplierName = entry.supplierName;
    bySupplier.set(supplierId, current);
  }

  const feesCop = -sum(sellerEntries.filter((entry) => SELLER_FEE_TYPES.includes(entry.type)));
  const driverPayCop = sum(driverEarnings);
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
    withheldBySupplier: [...bySupplier.values()].filter((row) => row.amountCop !== 0).sort((left, right) => right.amountCop - left.amountCop),
    feesCop,
    driverPayCop,
    profitCop,
    assetsCop,
    liabilitiesCop,
    netCop: assetsCop - liabilitiesCop
  };
}

export const getPlatformPosition = onCall({ memory: "512MiB" }, async (request) => {
  if (!request.auth || request.auth.token.role !== "admin") {
    throw new HttpsError("permission-denied", "Solo un administrador puede consultar la posicion de la plataforma.");
  }

  const db = getFirestore();
  const [walletSnapshot, settlementSnapshot] = await Promise.all([
    db.collection("walletEntries").get(),
    db.collection("settlements").get()
  ]);

  const wallet = walletSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as WalletEntryDoc);
  const settlements = settlementSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as SettlementDoc);

  return computePlatformPosition(wallet, settlements);
});
