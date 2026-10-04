/**
 * Espejo en el cliente de `functions/src/order-amount.ts` (spec 022).
 *
 * Se duplica a proposito, como `platform-position.ts` duplica la aritmetica del admin: el navegador
 * no puede importar de `functions/`, que se compila aparte. Lo que impide que las dos copias se
 * separen no es la disciplina, es una prueba —`spec-022-guards.test.ts`— que pasa la misma tabla de
 * valores por las dos y compara el resultado.
 *
 * Aqui el rechazo es una cortesia: avisa antes de gastar un viaje al servidor. La ultima palabra la
 * tiene la callable.
 */

/** Por encima de esto, no entra. Tiene que decir lo mismo que el servidor. */
export const MAX_ORDER_TOTAL_COP = 2000000;

/** Por encima de esto, entra pero preguntando. */
export const CONFIRM_ORDER_TOTAL_COP = 500000;

export type OrderAmountCheck =
  | { ok: true; totalCop: number }
  | { ok: false; message: string };

export function formatAmountCop(amountCop: number): string {
  return `$${Math.round(amountCop).toLocaleString("es-CO")}`;
}

/** Misma regla que el servidor: entero de pesos, mayor que cero, dentro del tope. */
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
      message: `El valor del pedido (${formatAmountCop(value)}) supera el maximo permitido de ${formatAmountCop(MAX_ORDER_TOTAL_COP)}. Revisa si sobran digitos.`
    };
  }
  return { ok: true, totalCop: value };
}

/** Cierto cuando el importe es guardable pero merece que quien lo teclea lo confirme. */
export function needsAmountConfirmation(totalCop: number): boolean {
  return Number.isFinite(totalCop) && totalCop > CONFIRM_ORDER_TOTAL_COP && totalCop <= MAX_ORDER_TOTAL_COP;
}
