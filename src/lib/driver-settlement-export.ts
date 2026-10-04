/**
 * Presentacion del detalle de un corte de domiciliario: una sola lista de la que beben LA PANTALLA
 * Y EL EXCEL (spec 019, RF_13).
 *
 * Vive fuera de `operations-app.tsx` por dos razones. La primera es que ese archivo no se puede
 * importar desde Vitest (arrastra el SDK de navegador), asi que el generador del Excel era
 * intestable. La segunda es la que de verdad importa: mientras pantalla y Excel se construyan por
 * separado, que coincidan es una promesa que alguien rompera. Construyendo el Excel A PARTIR de las
 * filas de la pantalla, coincidir deja de ser una promesa y pasa a ser una propiedad.
 *
 * El rotulo de un pedido que no se pudo leer vive aqui, en una constante: si viviera en el
 * componente, RF_10 podria cumplirse en pantalla y violarse en la exportacion.
 */
import { statusLabel } from "./order-export";
import type { DriverFinancialSummary, DriverSettlementDetailStatus, DriverSettlementOrderSource } from "./finance";
import type { Settlement } from "./types";

/** Lo que se muestra cuando el pedido no se pudo leer. NUNCA el identificador interno. */
export const UNAVAILABLE_ORDER_LABEL = "Pedido no disponible";
/** Lo que se muestra cuando ni siquiera el corte guardo el importe. NUNCA "$0". */
export const NO_AMOUNT_LABEL = "Sin importe";

export const driverSettlementExportColumns = [
  "corte",
  "guia",
  "shopify",
  "estado_pedido",
  "cod_recaudado",
  "pago_domiciliario",
  "efectivo_esperado",
  "sin_recaudo",
  "no_disponible",
  "estado_corte"
] as const;

export type DriverSettlementDetailRow = {
  settlementId: string;
  settlementLabel: string;
  settlementStatus: Settlement["status"];
  settlementStatusLabel: string;
  orderId: string;
  /** Codigo KNT, o `UNAVAILABLE_ORDER_LABEL`. Jamas el id interno. */
  trackingLabel: string;
  shopifyOrderId: string;
  orderStatusLabel: string;
  codCop: number;
  driverPayCop: number;
  /** `null` cuando no se conoce el importe: la fila va sin cifra, no con cero. */
  expectedCashCop: number | null;
  /** Lo que se pinta a la derecha: la cifra formateada, o `NO_AMOUNT_LABEL`. */
  expectedLabel: string;
  source: DriverSettlementOrderSource;
  unavailable: boolean;
  noCollection: boolean;
};

export type DriverSettlementDetailGroup = {
  settlementId: string;
  label: string;
  status: Settlement["status"];
  rows: DriverSettlementDetailRow[];
  expectedCashCop: number;
  detailCashCop: number;
  detailDeltaCop: number;
  detailStatus: DriverSettlementDetailStatus;
  unavailableOrderCount: number;
  unknownAmountCount: number;
  noCollectionCount: number;
};

export function settlementStatusLabel(status: Settlement["status"]) {
  if (status === "paid") return "pagada";
  if (status === "reconciled") return "conciliada";
  return "pendiente";
}

/** Formato de moneda del detalle. Los importes a favor se muestran en negativo, con signo. */
export function formatDetailCop(amountCop: number) {
  const absolute = Math.abs(Math.round(amountCop)).toLocaleString("es-CO");
  return `${amountCop < 0 ? "-" : ""}$${absolute}`;
}

/**
 * Las filas del detalle, agrupadas por corte. Es lo que pinta el panel y lo que exporta el Excel.
 */
export function buildDriverSettlementDetailGroups(summary: DriverFinancialSummary): DriverSettlementDetailGroup[] {
  return summary.settlementRows.map((settlement) => ({
    settlementId: settlement.settlementId,
    label: settlement.label,
    status: settlement.status,
    expectedCashCop: settlement.expectedCashCop,
    detailCashCop: settlement.detailCashCop,
    detailDeltaCop: settlement.detailDeltaCop,
    detailStatus: settlement.detailStatus,
    unavailableOrderCount: settlement.unavailableOrderCount,
    unknownAmountCount: settlement.unknownAmountCount,
    noCollectionCount: settlement.noCollectionCount,
    rows: settlement.orders.map((order) => {
      const amountKnown = order.amountKnown;
      return {
        settlementId: settlement.settlementId,
        settlementLabel: settlement.label,
        settlementStatus: settlement.status,
        settlementStatusLabel: settlementStatusLabel(settlement.status),
        orderId: order.orderId,
        trackingLabel: order.trackingCode || UNAVAILABLE_ORDER_LABEL,
        shopifyOrderId: order.shopifyOrderId,
        orderStatusLabel: order.status ? statusLabel(order.status) : "",
        codCop: order.totalCop,
        driverPayCop: order.driverPayCop,
        expectedCashCop: amountKnown ? order.expectedCashCop : null,
        expectedLabel: amountKnown ? formatDetailCop(order.expectedCashCop) : NO_AMOUNT_LABEL,
        source: order.source,
        unavailable: order.source !== "order",
        noCollection: order.noCollection
      };
    })
  }));
}

/** Aplana los grupos. Util para el Excel, que no tiene jerarquia. */
export function flattenDriverSettlementDetail(groups: DriverSettlementDetailGroup[]): DriverSettlementDetailRow[] {
  return groups.flatMap((group) => group.rows);
}

/**
 * El Excel se construye DESDE las filas de la pantalla, nunca en paralelo.
 * Los importes conocidos salen como NUMERO para que la columna se pueda sumar y de la cabecera;
 * los desconocidos llevan exactamente el mismo rotulo que en pantalla.
 */
export function buildDriverSettlementExportRows(rows: DriverSettlementDetailRow[]): Record<string, string | number>[] {
  return rows.map((row) => ({
    corte: row.settlementLabel,
    guia: row.trackingLabel,
    shopify: row.shopifyOrderId,
    estado_pedido: row.orderStatusLabel,
    cod_recaudado: row.codCop,
    pago_domiciliario: row.driverPayCop,
    efectivo_esperado: row.expectedCashCop === null ? NO_AMOUNT_LABEL : row.expectedCashCop,
    sin_recaudo: row.noCollection ? "si" : "",
    no_disponible: row.unavailable ? "si" : "",
    estado_corte: row.settlementStatusLabel
  }));
}

/**
 * Por que el detalle de un corte no esta completo, si no lo esta. Vive aqui y no en el componente
 * porque `operations-app.tsx` no se puede importar desde Vitest, y este desenlace ya se entrego una
 * vez sin nadie que lo leyera.
 *
 * `budget` es el caso limite que la spec llama "el detalle queda incompleto a proposito": el tope de
 * lecturas de la carga de pagina se agoto, asi que las filas que faltaban se resolvieron con el
 * importe que guarda el propio corte. La suma cuadra —esos importes son los de la cabecera— pero
 * cuadra por construccion, no porque se haya comprobado contra el pedido vivo. Presentarla como
 * "coincide con el corte" seria exactamente lo que RF_08 prohibe.
 */
export type SettlementDetailNoticeState =
  | { kind: "loading"; pendingCount: number }
  | { kind: "incomplete"; unknownAmountCount: number }
  | { kind: "budget"; skippedCount: number }
  | { kind: "adjusted"; detailCashCop: number; detailDeltaCop: number; expectedCashCop: number }
  | { kind: "balanced"; detailCashCop: number };

/**
 * El orden de las ramas es el que importa:
 *
 * 1. `loading` — todavia estan llegando; cualquier otra lectura seria prematura.
 * 2. `incomplete` — una fila SIN importe es peor que cualquier otra cosa: la suma es parcial.
 * 3. `budget` — hay filas sin bajar. Gana sobre `adjusted` porque con pedidos sin leer la
 *    diferencia contra la cabecera no se puede atribuir a una correccion posterior: lo unico
 *    honesto es decir que faltan pedidos por mirar.
 * 4. `adjusted` / `balanced` — ya en `detailStatus`, calculado por `resolveDetailStatus`.
 */
export function settlementDetailNotice(
  group: DriverSettlementDetailGroup,
  { loading, skippedByBudget }: { loading: boolean; skippedByBudget: number }
): SettlementDetailNoticeState {
  if (loading) return { kind: "loading", pendingCount: group.unavailableOrderCount };
  if (group.detailStatus === "incomplete") return { kind: "incomplete", unknownAmountCount: group.unknownAmountCount };
  if (skippedByBudget > 0) return { kind: "budget", skippedCount: skippedByBudget };
  if (group.detailStatus === "adjusted") {
    return {
      kind: "adjusted",
      detailCashCop: group.detailCashCop,
      detailDeltaCop: group.detailDeltaCop,
      expectedCashCop: group.expectedCashCop
    };
  }
  return { kind: "balanced", detailCashCop: group.detailCashCop };
}
