/**
 * Leer documentos por id DE UNO EN UNO, sin que uno malo se lleve a los demas.
 *
 * Vive aqui, sin firebase, por una razon concreta: mientras el bucle estuvo dentro de
 * `state-store.ts` la suite no podia ejecutarlo (ese modulo arrastra el SDK del navegador) y lo
 * unico que lo vigilaba era una guarda que comprobaba que el nombre de la funcion aparecia en el
 * codigo. Vaciar el `try/catch` habria dejado las pruebas en verde.
 *
 * Lo que esta funcion protege es la regla de oro 7 de `CLAUDE.md`, aprendida contra produccion:
 * `where(documentId(), "in", [...])` pasa las reglas para un domiciliario mientras TODOS los ids
 * sean suyos, pero **un solo id ajeno o inexistente devuelve 403 y tumba el lote entero**. Como los
 * ids salen de asientos de wallet y del detalle de un corte, basta con que un pedido se haya
 * borrado o reasignado para perder hasta 30 rescates de golpe — y esos pedidos son los que
 * sostienen el saldo del lider, asi que se veria menos dinero del que se debe, sin un solo aviso.
 */

/** Tamaño de tanda por defecto. Ni todo de golpe ni de uno en uno secuencial. */
export const READ_CHUNK_SIZE = 30;

export type ReadEachOptions = {
  /** Lecturas simultaneas como maximo. El detalle de un corte puede pedir 185 ids. */
  chunkSize?: number;
  /** Que hacer con el id que fallo. No se traga el error: se registra. */
  onError?: (id: string, error: unknown) => void;
};

/**
 * Pide cada id por separado y devuelve solo los que existen.
 *
 * - Un id que rechaza (403, red) se registra por `onError` y no afecta al resto.
 * - Un id que no existe (`null`) simplemente no viene: no es un error.
 * - Los ids repetidos o vacios no gastan lectura.
 */
export async function readEachById<T>(
  ids: string[],
  readOne: (id: string) => Promise<T | null>,
  { chunkSize = READ_CHUNK_SIZE, onError }: ReadEachOptions = {}
): Promise<T[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return [];

  const found: T[] = [];
  for (let start = 0; start < unique.length; start += chunkSize) {
    const chunk = unique.slice(start, start + chunkSize);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const document = await readOne(id);
          if (document) found.push(document);
        } catch (error) {
          onError?.(id, error);
        }
      })
    );
  }
  return found;
}
