/**
 * Spec 019 — T13: leer de uno en uno de verdad, no de palabra (RF_06, DoD 5).
 *
 * Hasta ahora la unica red bajo `getDocumentsOneByOne` era una guarda de fuente que comprobaba que
 * el nombre aparecia en el cuerpo de `pinOrders`. Vaciar el `try/catch` o cambiar el `Promise.all`
 * por un bucle sin captura habria dejado la suite entera en verde — y el fallo no se ve: la regla
 * de oro 7 nacio de que un solo id ajeno devuelve 403, tumba el lote de 30 y el saldo del lider
 * baja sin un aviso.
 */
import { describe, expect, it, vi } from "vitest";
import { readEachById } from "./read-each-by-id";

type Doc = { id: string; value: number };

describe("spec 019 · T13 · readEachById (RF_06, RF_07, DoD 5)", () => {
  it("DoD 5 · un id que falla NO se lleva por delante a los demas", async () => {
    const errores: string[] = [];
    const found = await readEachById<Doc>(
      ["uno", "ajeno", "dos"],
      async (id) => {
        if (id === "ajeno") throw new Error("Missing or insufficient permissions.");
        return { id, value: 1 };
      },
      { onError: (id) => errores.push(id) }
    );

    expect(found.map((doc) => doc.id).sort()).toEqual(["dos", "uno"]);
    expect(errores).toEqual(["ajeno"]);
  });

  it("DoD 5 · un id inexistente no es un error: simplemente no viene", async () => {
    const onError = vi.fn();
    const found = await readEachById<Doc>(
      ["uno", "borrado"],
      async (id) => (id === "borrado" ? null : { id, value: 1 }),
      { onError }
    );

    expect(found.map((doc) => doc.id)).toEqual(["uno"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("RF_07 · cada id se pide una sola vez, aunque venga repetido", async () => {
    const pedidos: string[] = [];
    await readEachById<Doc>(["uno", "uno", "", "dos"], async (id) => {
      pedidos.push(id);
      return { id, value: 1 };
    });

    expect(pedidos).toEqual(["uno", "dos"]);
  });

  it("lee en tandas: nunca abre mas de `chunkSize` lecturas a la vez", async () => {
    // 185 `getDoc` simultaneos desde un movil en la red de un domiciliario es territorio no medido.
    let enVuelo = 0;
    let maximo = 0;
    const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`);
    await readEachById<Doc>(
      ids,
      async (id) => {
        enVuelo += 1;
        maximo = Math.max(maximo, enVuelo);
        await new Promise((resolve) => setTimeout(resolve, 1));
        enVuelo -= 1;
        return { id, value: 1 };
      },
      { chunkSize: 10 }
    );

    expect(maximo).toBeLessThanOrEqual(10);
    expect(maximo).toBeGreaterThan(1);
  });

  it("sin ids no toca la red", async () => {
    const readOne = vi.fn();
    expect(await readEachById<Doc>([], readOne)).toEqual([]);
    expect(await readEachById<Doc>(["", ""], readOne)).toEqual([]);
    expect(readOne).not.toHaveBeenCalled();
  });
});
