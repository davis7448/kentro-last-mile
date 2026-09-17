/**
 * Spec 013 · T1 · RF_05, RF_06, RF_07, RF_09, RF_11, RNF_02.
 *
 * EL FALLO QUE ESTA SPEC EXISTE PARA ELIMINAR: la guia impresa (y la tarjeta en pantalla) mostraba
 * la "direccion normalizada" EN LUGAR DE la original cuando existia. Como las tiendas usaban esa
 * casilla para dejar observaciones ("timbre azul", "preguntar por Marta"), el mensajero salia con un
 * rotulo que decia "timbre azul" y ninguna direccion. Y como el mensajero, al resolver, conserva lo que
 * ya hubiera en esa casilla, hoy hay pedidos en los que NO se puede saber si ese texto es una
 * correccion o una nota: no se adivina, se muestra tal cual, rotulado "Correccion o nota" (RF_07/RF_11).
 *
 * Este modulo es la UNICA fuente de las lineas de direccion (RNF_02): la guia, la tarjeta, la vista
 * del mensajero y el Excel pintan lo que el devuelve, en este orden y con estos rotulos.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO QUE ESTA PRUEBA FIJA (`src/lib/order-address-lines.ts`, plan 013 §2.1):
 *
 *   export type AddressLineLabel = "Direccion" | "Correccion o nota" | "Indicaciones";
 *   export type AddressLine = { label: AddressLineLabel; text: string };
 *   export const SIN_DIRECCION = "SIN DIRECCION";
 *
 *   export function sameAddressText(left: string | undefined, right: string | undefined): boolean;
 *   export function orderAddressLines(
 *     order: Pick<Order, "addressRaw" | "normalizedAddress" | "deliveryNotes">
 *   ): AddressLine[];
 *
 * Reglas de `orderAddressLines`, en orden:
 *
 *   1. `Direccion`: `addressRaw` recortado; si queda vacio, `SIN_DIRECCION` (RF_05). Nunca se
 *      rellena con otra cosa: la corregida NO sube a ocupar el sitio de la original.
 *   2. `Correccion o nota`: `normalizedAddress` recortado, solo si no esta vacio y NO es
 *      `sameAddressText` con la original (RF_07, RF_11). No se intenta adivinar que es.
 *   3. `Indicaciones`: `deliveryNotes` recortado, solo si no esta vacio (RF_06, RF_09).
 *
 * `sameAddressText` (RF_07, "igual significa"): iguales tras quitar tildes (NFD + quitar `\p{M}`),
 * ignorar mayusculas, colapsar cualquier secuencia de espacios a uno y recortar. La puntuacion NO se
 * toca: "Cra 5 #10-20" y "Carrera 5 # 10 - 20" son distintas (caso limite 4 de la spec).
 *
 * ---------------------------------------------------------------------------------------------
 * POR QUE LA CARGA ES DIFERIDA: en fase RED el modulo no existe. Con un `import` estatico el archivo
 * entero no se recoge y el fallo es uno solo, "no se pudo cargar"; con `await import` dentro de cada
 * `it()` cada caso falla por separado y el rojo dice QUE caso falta. La ruta va en una constante y no
 * como literal dentro del `import()` a proposito: un especificador literal a un modulo inexistente
 * hace que `tsc --noEmit` falle con TS2307 en todo el repo, y el rojo tiene que estar en las pruebas,
 * no en el compilador. Vitest resuelve igual el especificador relativo respecto a este archivo.
 */

import { describe, expect, it } from "vitest";

/** Espejo local del contrato: si el modulo se aparta de esta forma, los fixtures no compilan. */
type AddressLineLabel = "Direccion" | "Correccion o nota" | "Indicaciones";
type AddressLine = { label: AddressLineLabel; text: string };

/**
 * Solo las tres claves que la funcion mira (`Pick<Order, ...>`): no hace falta un `Order` entero, y
 * `deliveryNotes` todavia no existe en `types.ts` (lo gana en esta misma tarea, plan §2.2).
 */
type AddressInput = {
  addressRaw: string;
  normalizedAddress?: string;
  deliveryNotes?: string;
};

type OrderAddressLines = (order: AddressInput) => AddressLine[];
type SameAddressText = (left: string | undefined, right: string | undefined) => boolean;

type Modulo = {
  orderAddressLines: OrderAddressLines;
  sameAddressText: SameAddressText;
  SIN_DIRECCION: string;
};

const RUTA_MODULO = "./order-address-lines";

const cargar = async (): Promise<Modulo> => {
  const modulo = (await import(RUTA_MODULO)) as unknown as Partial<Modulo>;
  if (typeof modulo.orderAddressLines !== "function") {
    throw new Error("src/lib/order-address-lines.ts todavia no exporta orderAddressLines (T1).");
  }
  if (typeof modulo.sameAddressText !== "function") {
    throw new Error("src/lib/order-address-lines.ts todavia no exporta sameAddressText (T1).");
  }
  if (typeof modulo.SIN_DIRECCION !== "string") {
    throw new Error("src/lib/order-address-lines.ts todavia no exporta la constante SIN_DIRECCION (T1).");
  }
  return modulo as Modulo;
};

/** Texto literal que la spec exige ver en la guia (RF_05); la constante exportada debe valer esto. */
const SIN_DIRECCION_LITERAL = "SIN DIRECCION";

/**
 * Pedido viejo REAL, el caso de todos los pedidos manuales de hoy (caso limite 1 de la spec): la
 * tienda escribio la direccion en la original y una observacion en "normalizada" porque no habia otra
 * casilla. Sin `deliveryNotes`, porque el campo no existia.
 */
const PEDIDO_VIEJO: Readonly<AddressInput> = Object.freeze({
  addressRaw: "Calle 5 # 38-25 apto 301",
  normalizedAddress: "timbre azul, preguntar por Marta"
});

const soloRotulos = (lineas: AddressLine[]): AddressLineLabel[] => lineas.map((linea) => linea.label);

describe("T1 · RF_05: la guia lleva siempre una linea 'Direccion' con la original", () => {
  it("RF_05 · la primera linea es 'Direccion' con `addressRaw` tal como lo escribio la tienda", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "Cra 5 # 10-20, Cali" });
    expect(lineas[0]).toEqual({ label: "Direccion", text: "Cra 5 # 10-20, Cali" });
  });

  it("RF_05 · la direccion original sale recortada de espacios a los lados, sin tocar el interior", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "   Cra 5 # 10-20, Cali  " });
    expect(lineas[0]).toEqual({ label: "Direccion", text: "Cra 5 # 10-20, Cali" });
  });

  it("RF_05 · sin corregida ni indicaciones, la guia tiene UNA sola linea", async () => {
    const { orderAddressLines } = await cargar();
    expect(orderAddressLines({ addressRaw: "Cra 5 # 10-20, Cali" })).toHaveLength(1);
  });

  it("RF_05 · original vacia: la linea 'Direccion' dice SIN DIRECCION (constante exportada), nunca queda en blanco", async () => {
    const { orderAddressLines, SIN_DIRECCION } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "" });
    expect(lineas).toEqual([{ label: "Direccion", text: SIN_DIRECCION }]);
  });

  it("RF_05 · la constante SIN_DIRECCION vale exactamente el literal 'SIN DIRECCION' que la spec exige ver", async () => {
    const { SIN_DIRECCION } = await cargar();
    expect(SIN_DIRECCION).toBe(SIN_DIRECCION_LITERAL);
  });

  it("RF_05 · original de solo espacios cuenta como vacia: 'SIN DIRECCION' con el literal", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "   \t  " });
    expect(lineas[0]).toEqual({ label: "Direccion", text: SIN_DIRECCION_LITERAL });
  });

  it("RF_05 · original vacia y corregida presente: 'SIN DIRECCION' arriba y la corregida DEBAJO, nunca en su lugar", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "", normalizedAddress: "Cra 5 # 10-20, Cali" });
    expect(lineas).toEqual([
      { label: "Direccion", text: SIN_DIRECCION_LITERAL },
      { label: "Correccion o nota", text: "Cra 5 # 10-20, Cali" }
    ]);
  });
});

describe("T1 · RF_07 + RF_11: el pedido viejo real, con la nota de la tienda en 'normalizada'", () => {
  it("RF_07 · RF_11 · pedido viejo: exactamente dos lineas, 'Direccion' y 'Correccion o nota'", async () => {
    const { orderAddressLines } = await cargar();
    expect(orderAddressLines(PEDIDO_VIEJO)).toEqual([
      { label: "Direccion", text: "Calle 5 # 38-25 apto 301" },
      { label: "Correccion o nota", text: "timbre azul, preguntar por Marta" }
    ]);
  });

  it("RF_11 · la nota vieja se muestra TAL CUAL, sin borrarla ni moverla a 'Indicaciones'", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines(PEDIDO_VIEJO);
    expect(soloRotulos(lineas)).not.toContain("Indicaciones");
    expect(lineas.find((linea) => linea.label === "Correccion o nota")?.text).toBe(
      "timbre azul, preguntar por Marta"
    );
  });

  it("RF_07 · la corregida sale recortada de espacios a los lados", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Calle 5 # 38-25 apto 301",
      normalizedAddress: "  timbre azul  "
    });
    expect(lineas[1]).toEqual({ label: "Correccion o nota", text: "timbre azul" });
  });

  it("RF_07 · corregida de solo espacios no produce linea", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "Calle 5 # 38-25 apto 301", normalizedAddress: "   " });
    expect(soloRotulos(lineas)).toEqual(["Direccion"]);
  });
});

describe("T1 · RF_07: 'igual' a la original no se repite (tildes, mayusculas, espacios)", () => {
  it("RF_07 · corregida identica a la original: una sola linea", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Cra 5 # 10-20, Cali",
      normalizedAddress: "Cra 5 # 10-20, Cali"
    });
    expect(soloRotulos(lineas)).toEqual(["Direccion"]);
  });

  it("RF_07 · corregida igual salvo mayusculas y tildes ('CRA 5 # 10-20, CALÍ'): una sola linea", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Cra 5 # 10-20, Cali",
      normalizedAddress: "CRA 5 # 10-20, CALÍ"
    });
    expect(soloRotulos(lineas)).toEqual(["Direccion"]);
  });

  it("RF_07 · corregida igual salvo espacios dobles y espacios a los lados: una sola linea", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Cra 5 # 10-20, Cali",
      normalizedAddress: "  Cra  5   #  10-20,   Cali "
    });
    expect(soloRotulos(lineas)).toEqual(["Direccion"]);
  });

  it("RF_07 · la linea 'Direccion' conserva la ORIGINAL cuando la corregida 'igual' se omite (no la version normalizada)", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Cra 5 # 10-20, Calí",
      normalizedAddress: "cra 5 # 10-20, cali"
    });
    expect(lineas).toEqual([{ label: "Direccion", text: "Cra 5 # 10-20, Calí" }]);
  });

  it("RF_07 · corregida distinta SOLO en puntuacion ('Cra 5 #10-20' vs 'Carrera 5 # 10 - 20'): dos lineas", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Cra 5 #10-20",
      normalizedAddress: "Carrera 5 # 10 - 20"
    });
    expect(lineas).toEqual([
      { label: "Direccion", text: "Cra 5 #10-20" },
      { label: "Correccion o nota", text: "Carrera 5 # 10 - 20" }
    ]);
  });
});

describe("T1 · RF_07: sameAddressText, la regla de igualdad en directo", () => {
  it("RF_07 · undefined y cadena vacia son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText(undefined, "")).toBe(true);
  });

  it("RF_07 · dos undefined son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText(undefined, undefined)).toBe(true);
  });

  it("RF_07 · cadena vacia y solo espacios son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("", "   ")).toBe(true);
  });

  it("RF_07 · undefined frente a un texto con contenido NO son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText(undefined, "Cra 5 # 10-20")).toBe(false);
  });

  it("RF_07 · con tildes y mayusculas distintas son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("Cra 5 # 10-20, Cali", "CRA 5 # 10-20, CALÍ")).toBe(true);
  });

  it("RF_07 · con tildes en las dos, en letras distintas (Calí vs Cáli), son iguales: se quitan todas", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("Calí", "Cáli")).toBe(true);
  });

  it("RF_07 · con espacios dobles, tabulador y espacios a los lados son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("Cra 5 # 10-20, Cali", "  Cra  5 \t # 10-20,   Cali  ")).toBe(true);
  });

  it("RF_07 · la eñe cae con las tildes: 'Peñon' y 'Penon' son iguales (consecuencia de NFD + quitar \\p{M}, plan 2.1)", async () => {
    const { sameAddressText } = await cargar();
    // NFD descompone la ñ en n + virgulilla combinante, que es \p{M}. El plan fija ese algoritmo,
    // asi que la eñe colapsa con la n. Se deja escrito para que nadie lo descubra por sorpresa:
    // si el equipo decide que la eñe no es una tilde, este es el unico caso que hay que voltear.
    expect(sameAddressText("Barrio El Peñon", "Barrio El Penon")).toBe(true);
  });

  it("RF_07 · distintas solo en puntuacion NO son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("Cra 5 #10-20", "Carrera 5 # 10 - 20")).toBe(false);
  });

  it("RF_07 · un solo caracter de puntuacion de diferencia ('Cra 5 # 10-20' vs 'Cra 5 # 10 20') NO son iguales", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("Cra 5 # 10-20", "Cra 5 # 10 20")).toBe(false);
  });

  it("RF_07 · es simetrica: el orden de los argumentos no cambia la respuesta", async () => {
    const { sameAddressText } = await cargar();
    expect(sameAddressText("CRA 5, CALÍ", "cra 5, cali")).toBe(sameAddressText("cra 5, cali", "CRA 5, CALÍ"));
    expect(sameAddressText("Cra 5 #10-20", "Carrera 5")).toBe(sameAddressText("Carrera 5", "Cra 5 #10-20"));
  });
});

describe("T1 · RF_06 + RF_09: las indicaciones tienen su linea propia, al final", () => {
  it("RF_06 · con `deliveryNotes` no vacio, la ultima linea es 'Indicaciones' con el texto", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Cra 5 # 10-20, Cali",
      deliveryNotes: "timbre azul, preguntar por Marta"
    });
    expect(lineas).toEqual([
      { label: "Direccion", text: "Cra 5 # 10-20, Cali" },
      { label: "Indicaciones", text: "timbre azul, preguntar por Marta" }
    ]);
  });

  it("RF_06 · las indicaciones salen recortadas de espacios a los lados", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "Cra 5 # 10-20, Cali", deliveryNotes: "  timbre azul \n" });
    expect(lineas[lineas.length - 1]).toEqual({ label: "Indicaciones", text: "timbre azul" });
  });

  it("RF_06 · `deliveryNotes` de solo espacios no produce linea", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "Cra 5 # 10-20, Cali", deliveryNotes: "   " });
    expect(soloRotulos(lineas)).toEqual(["Direccion"]);
  });

  it("RF_09 · `deliveryNotes` ausente (pedidos de Shopify, webhook, OnStock) no produce linea", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "Cra 5 # 10-20, Cali" });
    expect(soloRotulos(lineas)).not.toContain("Indicaciones");
  });

  it("RF_06 · las indicaciones NUNCA ocupan la linea 'Direccion', ni con la original vacia", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "", deliveryNotes: "timbre azul" });
    expect(lineas).toEqual([
      { label: "Direccion", text: SIN_DIRECCION_LITERAL },
      { label: "Indicaciones", text: "timbre azul" }
    ]);
  });

  it("RF_06 · las indicaciones se muestran aunque coincidan con la direccion: no se comparan con nada", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({ addressRaw: "Cra 5 # 10-20, Cali", deliveryNotes: "cra 5 # 10-20, cali" });
    expect(soloRotulos(lineas)).toEqual(["Direccion", "Indicaciones"]);
  });
});

describe("T1 · RF_05 + RF_06 + RF_07: las tres lineas, en orden exacto", () => {
  it("RF_05 · RF_06 · RF_07 · direccion, corregida distinta e indicaciones: tres lineas en este orden", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Calle 5 # 38-25 apto 301",
      normalizedAddress: "Calle 5 # 38-25, torre 2 apto 301",
      deliveryNotes: "timbre azul, preguntar por Marta"
    });
    expect(lineas).toEqual([
      { label: "Direccion", text: "Calle 5 # 38-25 apto 301" },
      { label: "Correccion o nota", text: "Calle 5 # 38-25, torre 2 apto 301" },
      { label: "Indicaciones", text: "timbre azul, preguntar por Marta" }
    ]);
  });

  it("RF_05 · RF_06 · RF_07 · los rotulos van en orden ['Direccion','Correccion o nota','Indicaciones']", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Calle 5 # 38-25 apto 301",
      normalizedAddress: "Calle 5 # 38-25, torre 2 apto 301",
      deliveryNotes: "timbre azul"
    });
    expect(soloRotulos(lineas)).toEqual(["Direccion", "Correccion o nota", "Indicaciones"]);
  });

  it("RF_07 · con corregida 'igual' e indicaciones: dos lineas, 'Direccion' e 'Indicaciones'", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "Calle 5 # 38-25 apto 301",
      normalizedAddress: "CALLE 5 # 38-25 APTO 301",
      deliveryNotes: "timbre azul"
    });
    expect(soloRotulos(lineas)).toEqual(["Direccion", "Indicaciones"]);
  });

  it("RF_05 · original vacia, corregida e indicaciones: 'SIN DIRECCION' y las otras dos debajo", async () => {
    const { orderAddressLines } = await cargar();
    const lineas = orderAddressLines({
      addressRaw: "  ",
      normalizedAddress: "Cra 5 # 10-20, Cali",
      deliveryNotes: "timbre azul"
    });
    expect(lineas).toEqual([
      { label: "Direccion", text: SIN_DIRECCION_LITERAL },
      { label: "Correccion o nota", text: "Cra 5 # 10-20, Cali" },
      { label: "Indicaciones", text: "timbre azul" }
    ]);
  });
});

describe("T1 · RNF_02: una sola funcion PURA para las cuatro superficies", () => {
  it("RNF_02 · no muta el pedido de entrada: acepta un objeto congelado y lo deja intacto", async () => {
    const { orderAddressLines } = await cargar();
    const pedido: Readonly<AddressInput> = Object.freeze({
      addressRaw: "  Calle 5 # 38-25 apto 301 ",
      normalizedAddress: " timbre azul ",
      deliveryNotes: " preguntar por Marta "
    });
    const copia = { ...pedido };
    expect(() => orderAddressLines(pedido)).not.toThrow();
    expect(pedido).toEqual(copia);
  });

  it("RNF_02 · devuelve un array NUEVO en cada llamada: mutar el resultado no afecta al siguiente", async () => {
    const { orderAddressLines } = await cargar();
    const primera = orderAddressLines(PEDIDO_VIEJO);
    primera.pop();
    primera[0] = { label: "Direccion", text: "pisado" };
    const segunda = orderAddressLines(PEDIDO_VIEJO);
    expect(segunda).not.toBe(primera);
    expect(segunda).toEqual([
      { label: "Direccion", text: "Calle 5 # 38-25 apto 301" },
      { label: "Correccion o nota", text: "timbre azul, preguntar por Marta" }
    ]);
  });

  it("RNF_02 · es determinista: la misma entrada da el mismo resultado dos veces", async () => {
    const { orderAddressLines } = await cargar();
    expect(orderAddressLines(PEDIDO_VIEJO)).toEqual(orderAddressLines(PEDIDO_VIEJO));
  });

  it("RNF_02 · cada linea trae solo `label` y `text`: no se cuela nada mas del pedido a las superficies", async () => {
    const { orderAddressLines } = await cargar();
    for (const linea of orderAddressLines(PEDIDO_VIEJO)) {
      expect(Object.keys(linea).sort()).toEqual(["label", "text"]);
    }
  });
});
