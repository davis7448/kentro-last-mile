/**
 * El unico sitio donde se decide si el importe de un pedido es posible.
 *
 * Existe por dos pedidos reales. El 2026-08-06 entro uno por $76.506.523.000 y el 2026-09-19 otro
 * por $11.770.047.900 —dos sets de tornillos— que quedo CONTRA ENTREGA y listo para asignar. Desde
 * la spec 019 la cabecera de un corte es "la cifra que se liquida" y su detalle suma exactamente
 * eso: si ese pedido se entrega, el corte le pide al domiciliario once mil setecientos millones en
 * efectivo, y un corte pagado o conciliado ya no se reescribe (constitucion, principio 10).
 *
 * El tope NO es un numero redondo elegido a ojo. Barrido de los 5.103 pedidos de produccion el
 * 2026-09-19: maximo legitimo $239.800, percentil 99,9 $224.775, percentil 99 $179.800, y el mayor
 * prepago real $1.233.000. $2.000.000 deja pasar todo lo real con holgura y rechaza los dos
 * imposibles por un factor de casi seis mil.
 *
 * Puro a proposito: sin firebase, sin zod. Lo usan las callables que aceptan un importe tecleado y
 * lo consulta la pantalla antes de enviar (`src/lib/order-amount.ts` copia las dos cifras y una
 * guarda vigila que no se separen).
 */

/** Por encima de esto, no entra. Subirlo es una decision del responsable, con fecha y motivo. */
export const MAX_ORDER_TOTAL_COP = 2_000_000;

/** Por encima de esto, entra pero preguntando. El 99,99 % de los pedidos esta por debajo. */
export const CONFIRM_ORDER_TOTAL_COP = 500_000;

export type OrderAmountCheck =
  | { ok: true; totalCop: number }
  | { ok: false; message: string };

/** Pesos como los escribe la aplicacion: `$11.770.047.900`. */
export function formatCop(amountCop: number): string {
  return `$${Math.round(amountCop).toLocaleString("es-CO")}`;
}

/**
 * Un importe posible es un entero de pesos, mayor que cero y dentro del tope.
 *
 * No convierte cadenas. `"1.199.900"` puede volverse `1.1999` o `NaN` segun quien lo convierta, y
 * un importe convertido a la ligera es justo el error que esta funcion existe para evitar: quien
 * teclea vuelve a teclear.
 */
export function checkOrderTotalCop(value: unknown): OrderAmountCheck {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: "El valor del pedido tiene que ser un numero en pesos, sin puntos ni comas." };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, message: "El valor del pedido va en pesos enteros, sin decimales." };
  }
  if (value <= 0) {
    return { ok: false, message: "El valor del pedido debe ser mayor a cero." };
  }
  if (value > MAX_ORDER_TOTAL_COP) {
    return {
      ok: false,
      message: `El valor del pedido (${formatCop(value)}) supera el maximo permitido de ${formatCop(MAX_ORDER_TOTAL_COP)}. Revisa si sobran digitos.`
    };
  }
  return { ok: true, totalCop: value };
}

/** Cierto cuando el importe es guardable pero merece que quien lo teclea lo confirme. */
export function needsAmountConfirmation(totalCop: number): boolean {
  return Number.isFinite(totalCop) && totalCop > CONFIRM_ORDER_TOTAL_COP && totalCop <= MAX_ORDER_TOTAL_COP;
}
