/**
 * Gravamen a los movimientos financieros ("4x1000"): 0,4% de lo que sale por transferencia.
 *
 * ESPEJO DE `src/lib/finance.ts`. El backend no puede importar del cliente (paquetes y tsconfig
 * distintos), asi que la formula vive dos veces. `src/lib/gmf.test.ts` compara las dos copias
 * valor por valor para que no puedan separarse en silencio: si alguien cambia una y no la otra,
 * la prueba falla.
 *
 * Solo grava dinero que SALE del banco:
 *  - Cuenta marcada `paysInCash`: no hay transferencia, no hay gravamen.
 *  - Neto cero o negativo: no sale plata (en domiciliarios el neto negativo significa que es el
 *    mensajero quien debe entregar efectivo).
 */
export const GMF_RATE = 0.004;

export function gmfForPayout(payableCop: number, paysInCash = false): number {
  if (paysInCash) return 0;
  if (!Number.isFinite(payableCop) || payableCop <= 0) return 0;
  return Math.round(payableCop * GMF_RATE);
}
