/**
 * Spec 018 — resumen puro de la API de solo lectura para tiendas. Salio de `store-api.ts` para
 * poder probarlo sin `firebase-admin` ni `firebase-functions`.
 */
import type { SellerBalance } from "./seller-balance";
import { SELLER_LIQUIDATION_TYPES, type SettlementDoc, type WalletEntryDoc } from "./seller-ledger";

// Suma de delivery_fee/failed_fee/etc como magnitud positiva de cobro (igual que netChargeCop de la UI).
export function chargeMagnitude(entries: WalletEntryDoc[], types: string[]) {
  return Math.max(0, -entries.filter((e) => types.includes(e.type)).reduce((sum, e) => sum + Number(e.amountCop || 0), 0));
}

export function sumType(entries: WalletEntryDoc[], types: string[]) {
  return Math.round(entries.filter((e) => types.includes(e.type)).reduce((sum, e) => sum + Number(e.amountCop || 0), 0));
}

/**
 * Resumen financiero consolidado de la tienda, autoritativo. Lo pendiente sin cortar sale de
 * `SellerBalance` (spec 018, RF_25): la API dice exactamente lo mismo que la pantalla de la tienda
 * y el cierre del admin. Aqui solo se suma lo que ya entro a cortes.
 */
export function buildStoreSummary(
  sellerEntries: WalletEntryDoc[],
  settlementsById: Map<string, SettlementDoc>,
  balance: SellerBalance,
  sellerSettlements: SettlementDoc[]
) {
  const liq = sellerEntries.filter((e) => SELLER_LIQUIDATION_TYPES.has(e.type));
  let enLiquidacionCop = 0, liquidadoCop = 0;
  for (const entry of liq) {
    if (!entry.settlementId) continue;
    const amount = Number(entry.amountCop || 0);
    const status = String(settlementsById.get(String(entry.settlementId))?.status ?? "");
    if (status === "paid" || status === "reconciled") liquidadoCop += amount;
    else enLiquidacionCop += amount; // corte pendiente
  }
  const disponibleCop = balance.availableCop;
  const retenidoCop = balance.heldCop;
  const bloqueadoCodCop = balance.codPendingCop;
  // Un `seller_abono` NEGATIVO es plata que salio hacia la tienda (un abono real).
  // Uno POSITIVO restituye deuda: es un ajuste, no un pago, y meterlo aqui inflaba
  // el historial de pagos de la tienda por el doble de la diferencia.
  const abonos = sellerEntries
    .filter((e) => e.type === "seller_abono" && Number(e.amountCop || 0) < 0)
    .map((e) => ({ fecha: e.createdAt ?? null, montoCop: Math.round(-Number(e.amountCop || 0)), nota: e.description ?? null }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const totalAbonadoCop = abonos.reduce((sum, a) => sum + a.montoCop, 0);

  const ajustes = sellerEntries
    .filter((e) => e.type === "seller_abono" && Number(e.amountCop || 0) > 0)
    .map((e) => ({ fecha: e.createdAt ?? null, montoCop: Math.round(Number(e.amountCop || 0)), nota: e.description ?? null }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  // Un corte puede haberse cerrado pagando menos de su neto: lo que vale como pago
  // es lo realmente transferido, no el neto del corte.
  const pagosLiquidaciones = sellerSettlements
    .filter((s) => s.status === "paid" || s.status === "reconciled")
    .map((s) => ({
      tipo: "liquidacion" as const,
      fecha: s.paidAt ?? s.reconciledAt ?? s.createdAt ?? null,
      montoCop: Math.round(Number(typeof s.paidAmountCop === "number" ? s.paidAmountCop : s.netCop) || 0),
      referencia: String(s.id),
      nota: s.note ?? null
    }));
  const pagosAbonos = abonos.map((a) => ({ tipo: "abono" as const, fecha: a.fecha, montoCop: a.montoCop, referencia: "abono", nota: a.nota }));
  const pagos = [...pagosLiquidaciones, ...pagosAbonos].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  return {
    saldoPendiente: {
      disponibleCop: Math.round(disponibleCop),
      retenidoCop: Math.round(retenidoCop),
      retenidoPedidos: balance.heldOrderCount,
      enLiquidacionCop: Math.round(enLiquidacionCop),
      bloqueadoCodCop: Math.round(bloqueadoCodCop),
      totalCop: Math.round(disponibleCop + retenidoCop + enLiquidacionCop + bloqueadoCodCop)
    },
    totales: {
      codCop: sumType(liq, ["cod_revenue", "cod_remittance"]),
      cobrosCop: chargeMagnitude(liq, ["delivery_fee", "failed_fee", "fulfillment_fee"]),
      costoProductoCop: chargeMagnitude(liq, ["product_cost"]),
      abonadoCop: totalAbonadoCop,
      liquidadoCop: Math.round(liquidadoCop)
    },
    pagos,
    abonos,
    ajustes,
    significado: {
      disponibleCop: "Saldo que la plataforma ya te puede pagar hoy, en pedidos completos (COD recibido del domiciliario o prepago), neto de abonos y sin la retencion.",
      retenidoCop: "Saldo pagable que queda para el siguiente corte mientras tengas pedidos en la calle que podrian volver como fallidos (se retiene el flete de devolucion). Los pedidos retenidos van enteros.",
      enLiquidacionCop: "Ya incluido en un corte creado pero aun no pagado.",
      bloqueadoCodCop: "Pedidos COD cuyo efectivo todavia no se recibe del domiciliario; se habilita al recibirse.",
      liquidadoCop: "Total neto ya liquidado en cortes pagados/conciliados.",
      abonadoCop: "Total de abonos (pagos parciales) que ya te hemos entregado.",
      ajustes: "Correcciones que reabren saldo a tu favor (por ejemplo, un corte cerrado por menos de lo transferido). No son pagos recibidos."
    }
  };
}
