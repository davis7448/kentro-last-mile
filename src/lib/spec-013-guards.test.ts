/**
 * Guardas de fuente de la spec 013 — `specs/013_pedido_manual_entero_y_direccion_en_la_guia.md`.
 *
 * Archivo aparte y por tema (precedente: `spec-005-guards.test.ts`): lo que se guarda aqui no es
 * el comportamiento de un modulo puro —eso vive en `order-address-lines.test.ts`—, sino la FORMA
 * de artefactos que la suite no puede ejecutar: el JSX de la guia impresa y de la tarjeta (T2), y
 * despues el Excel (T3), el servidor y sus otras vias de entrada (T4), los formularios de la tienda
 * (T5), la disposicion del panel (T6) y el guion de medida (T7). Cada tarea ira anadiendo su
 * `describe` aqui, con sus propios extractores si los necesita.
 *
 * Por que guardas y no pruebas de comportamiento: `operations-app.tsx` es el monolito de ~13.000
 * lineas e importa el SDK de Firebase; no se puede montar desde la suite. Lo unico sostenible es la
 * FORMA, y por eso, como en la 005, se afirma sobre BOOLEANOS y listas ya calculadas y nunca con
 * `expect(FUENTE).not.toMatch(...)`: un rojo de esa forma volcaria el monolito entero en la salida.
 *
 * Los ayudantes se copian de la 005 a proposito (no se importan de un archivo de pruebas ajeno):
 * `repoSourceWithoutComments`, `finDelLiteral`/`cierreSeguro`/`funcionesSeguras` (los extractores
 * SEGUROS; `localFunctions` a secas revienta con el monolito, medido en la 005) y un
 * `fragmentoAlrededor` que aqui es por LINEAS, porque su uso es el mensaje de fallo y no aislar una
 * rama de JSX.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fuente del repo sin comentarios: un requisito escrito en un comentario no es una garantia.
 * Los comentarios de bloque se sustituyen por sus saltos de linea, asi los numeros de linea que
 * salen en los mensajes de fallo coinciden con los del archivo real.
 */
function repoSourceWithoutComments(relativeToRepo: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../${relativeToRepo}`, import.meta.url)), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, (comentario) => comentario.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

type LocalFunctions = Map<string, string>;

/** Fin del literal `'...'`, `"..."` o de plantilla que empieza en `i`, saltando los escapes. */
function finDelLiteral(source: string, i: number): number {
  const comilla = source[i];
  for (let j = i + 1; j < source.length; j += 1) {
    if (source[j] === "\\") {
      j += 1;
      continue;
    }
    if (source[j] === comilla) return j;
  }
  return source.length - 1;
}

/** Cierre que empareja la apertura en `apertura`, saltandose lo que haya dentro de los literales. */
function cierreSeguro(source: string, apertura: number): number {
  const abre = source[apertura];
  const cierra = abre === "(" ? ")" : abre === "{" ? "}" : "]";
  let profundidad = 0;
  for (let i = apertura; i < source.length; i += 1) {
    const caracter = source[i];
    if (caracter === '"' || caracter === "'" || caracter === "`") {
      i = finDelLiteral(source, i);
      continue;
    }
    if (caracter === abre) profundidad += 1;
    else if (caracter === cierra) {
      profundidad -= 1;
      if (profundidad === 0) return i;
    }
  }
  throw new Error(`Apertura "${abre}" sin cerrar en la posicion ${apertura}.`);
}

/**
 * Funciones con nombre del archivo (`function x(` y `const x = (async) (...) => {`), TOLERANTE:
 * una funcion que no se pueda delimitar se omite en vez de tumbar la suite.
 */
function funcionesSeguras(source: string): LocalFunctions {
  const funciones: LocalFunctions = new Map();
  const cuerpoDesde = (llave: number): string => source.slice(llave, cierreSeguro(source, llave) + 1);
  for (const match of source.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    try {
      const finParametros = cierreSeguro(source, (match.index ?? 0) + match[0].length - 1);
      const llave = source.indexOf("{", finParametros);
      if (llave >= 0) funciones.set(match[1], cuerpoDesde(llave));
    } catch {
      // Funcion que no se puede delimitar: se omite. Tumbar la suite por una ajena seria peor.
    }
  }
  for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    try {
      const finParametros = cierreSeguro(source, (match.index ?? 0) + match[0].length - 1);
      const flecha = source.slice(finParametros + 1).match(/^\s*=>\s*\{/);
      if (flecha) funciones.set(match[1], cuerpoDesde(finParametros + flecha[0].length));
    } catch {
      // Idem.
    }
  }
  return funciones;
}

/** `nombre(` como llamada: no cuenta `x.nombre(` ni el import. */
function callPattern(name: string): RegExp {
  return new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`);
}

function cuerpoDe(funciones: LocalFunctions, nombre: string): string {
  const cuerpo = funciones.get(nombre);
  if (cuerpo === undefined) throw new Error(`No se encuentra la funcion \`${nombre}\`.`);
  return cuerpo;
}

/** Numero de linea (1-based) de la posicion `i` dentro de `texto`. */
function lineaDe(texto: string, i: number): number {
  return texto.slice(0, i).split("\n").length;
}

/**
 * La linea que contiene la posicion `i`, con la anterior y la siguiente, recortadas. Sirve para
 * que un fallo diga DONDE esta la lectura directa sin volcar el archivo.
 */
function fragmentoAlrededor(texto: string, i: number): string {
  const lineas = texto.split("\n");
  const indice = lineaDe(texto, i) - 1;
  return lineas
    .slice(Math.max(0, indice - 1), indice + 2)
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0)
    .join(" ⏎ ");
}

/*
 * =====================================================================================
 * T2 · RF_05–RF_08, RF_11, RNF_02 — La guia y la tarjeta consumen `orderAddressLines`.
 * =====================================================================================
 *
 * Lo medido en el codigo (plan §1): `printOrderLabels` hace `order.normalizedAddress ??
 * order.addressRaw` (operations-app.tsx:936) y la tarjeta pinta lo mismo junto al `MapPin`
 * (:1851). Es el bug: la casilla "normalizada", que las tiendas usan como observacion, PISA la
 * direccion y el mensajero sale con "timbre azul" y sin direccion.
 *
 * OJO con el nombre: el plan y la tarea dicen `OrderRow`, pero la linea 1851 vive en `OrderCard`
 * (1637–2052). `OrderRow` (1594–1635) es la fila plegada de la lista, que al abrirse monta
 * `<OrderCard>`. Las guardas de la tarjeta van sobre `OrderCard`; a `OrderRow` solo se le exige
 * que no lea la direccion por su cuenta.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA que fijan estas guardas (lo que el coder debe respetar):
 *
 * 1. `operations-app.tsx` importa `orderAddressLines` desde `@/lib/order-address-lines` (o
 *    `../lib/order-address-lines`), en un `import { ... }` con llaves como el resto del archivo.
 * 2. En TODO el archivo sin comentarios no queda `normalizedAddress ??` ni `?? order.addressRaw`.
 *    La comprobacion es la funcion pura `violacionesDeLecturaDirecta`, la misma que se usa en la
 *    mutacion (DoD 4). Medido hoy: ademas de :936 y :1851, la atrapa la semilla del formulario de
 *    revision (`normalizedAddress: order.normalizedAddress ?? ""`, :2257), que T5 elimina entera.
 * 3. `printOrderLabels` llama a `orderAddressLines(` y pinta CADA linea con su rotulo y su texto
 *    pasando por `escapeHtml(` (RNF_01: la guia se sigue escapando como hoy). La primera conserva
 *    la clase `.address`; las demas llevan la clase `.address-extra`, cuya regla CSS en el
 *    `<style>` de la guia recorta a tres lineas con la misma receta que `.product-name`:
 *    `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden`
 *    (caso limite "indicacion muy larga": sin `-webkit-box` y `overflow: hidden` el clamp no
 *    recorta nada).
 * 4. `OrderCard` llama a `orderAddressLines(` y no contiene `order.addressRaw` ni
 *    `order.normalizedAddress`. La `<p>` del `MapPin` pinta la linea `Direccion`; cada linea extra
 *    va en su propia `<p>` con `{<algo>.label}` y su texto, y esa `<p>` no lleva `truncate` en
 *    ningun sitio: la tarjeta muestra la indicacion entera.
 * ---------------------------------------------------------------------------------------------
 */

const MONOLITO = "src/components/operations-app.tsx";
const FUENTE_PANTALLA = repoSourceWithoutComments(MONOLITO);
const FUNCIONES_PANTALLA = funcionesSeguras(FUENTE_PANTALLA);

/** Las dos formas del bug: la nota pisando la direccion, o la direccion como respaldo de otra cosa. */
const LECTURAS_DIRECTAS: ReadonlyArray<{ nombre: string; patron: RegExp }> = [
  { nombre: "normalizedAddress ??", patron: /normalizedAddress\s*\?\?/g },
  { nombre: "?? order.addressRaw", patron: /\?\?\s*order\.addressRaw\b/g }
];

/**
 * Cada sitio de `source` donde se vuelve a leer la direccion por su cuenta, con su linea y su
 * contexto. PURA: la misma funcion decide sobre el archivo real y sobre el mutante (DoD 4).
 */
function violacionesDeLecturaDirecta(source: string): string[] {
  const violaciones: string[] = [];
  for (const { nombre, patron } of LECTURAS_DIRECTAS) {
    for (const match of source.matchAll(patron)) {
      const i = match.index ?? 0;
      violaciones.push(`\`${nombre}\` en la linea ${lineaDe(source, i)}: ${fragmentoAlrededor(source, i)}`);
    }
  }
  return violaciones;
}

/** El contenido del `<style>...</style>` que la guia escribe en la ventana emergente. */
function bloqueStyleDeLaGuia(cuerpo: string): string {
  const match = cuerpo.match(/<style>([\s\S]*?)<\/style>/);
  return match?.[1] ?? "";
}

/** Declaraciones de la regla `selector { ... }` dentro de un bloque CSS, o "" si no existe. */
function reglaCss(css: string, selector: string): string {
  const match = css.match(new RegExp(`(?:^|[\\s},])${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

/** El `<p ...>...</p>` que contiene la posicion `i` de `jsx`, o "" si no esta dentro de una `<p`. */
function parrafoQueContiene(jsx: string, i: number): string {
  const inicio = jsx.lastIndexOf("<p", i);
  if (inicio < 0) return "";
  const fin = jsx.indexOf("</p>", i);
  return jsx.slice(inicio, fin < 0 ? jsx.length : fin + "</p>".length);
}

/** Posiciones de cada `{x.label}` / `x.label` en `jsx`. */
function referenciasAlRotulo(jsx: string): number[] {
  return [...jsx.matchAll(/\b[\w$]+\.label\b/g)].map((match) => match.index ?? 0);
}

describe("T2 — la guia y la tarjeta consumen orderAddressLines (RF_05–RF_08, RF_11, RNF_02)", () => {
  it("el extractor trae `printOrderLabels`, `OrderCard` y `OrderRow`, y no se pasa de largo", () => {
    // Guarda del propio extractor: si alguna vez se desbordara, los cuerpos arrastrarian funciones
    // vecinas y las guardas de abajo se pondrian verdes con codigo que no es de estas superficies.
    const guia = cuerpoDe(FUNCIONES_PANTALLA, "printOrderLabels");
    expect(guia, "el cuerpo de la guia abre la ventana emergente").toContain("popup.document.write");
    expect(guia, "y lleva su hoja de estilos").toContain("<style>");
    expect(
      /function\s+markOrdersLabelsPrinted\s*\(/.test(guia),
      "el cuerpo de `printOrderLabels` se desborda hasta `markOrdersLabelsPrinted`: el recorte no es de fiar"
    ).toBe(false);

    const tarjeta = cuerpoDe(FUNCIONES_PANTALLA, "OrderCard");
    expect(tarjeta, "el cuerpo de la tarjeta pinta el icono de direccion").toContain("<MapPin");
    expect(tarjeta, "y llega hasta el boton de detalle").toContain("Ver detalle");
    expect(
      /function\s+auditActionLabel\s*\(/.test(tarjeta),
      "el cuerpo de `OrderCard` se desborda hasta `auditActionLabel`: el recorte no es de fiar"
    ).toBe(false);

    const fila = cuerpoDe(FUNCIONES_PANTALLA, "OrderRow");
    expect(fila, "la fila plegada sigue montando la tarjeta").toContain("<OrderCard");
    expect(/function\s+OrderCard\s*\(/.test(fila), "el cuerpo de `OrderRow` se desborda hasta `OrderCard`").toBe(false);
  });

  it("RF_08, RNF_02 · la pantalla importa `orderAddressLines` del modulo puro", () => {
    // Positiva de control: la forma de import que se acepta es la que ya usa el archivo.
    expect(
      /import\s*\{[^}]*\bresolveAddress\b[^}]*\}\s*from\s*["']@\/lib\/actions["']/.test(FUENTE_PANTALLA),
      "el import de `resolveAddress` desde `@/lib/actions` sigue ahi (es la forma de import que se espera)"
    ).toBe(true);
    const importaElModulo =
      /import\s*\{[^}]*\borderAddressLines\b[^}]*\}\s*from\s*["'](?:@\/lib|\.\.\/lib)\/order-address-lines["']/.test(FUENTE_PANTALLA);
    expect(
      importaElModulo,
      "la pantalla no importa `orderAddressLines` de `@/lib/order-address-lines`: la guia y la tarjeta no tienen de donde sacar las lineas"
    ).toBe(true);
  });

  it("RNF_02 · en todo el archivo no queda ninguna lectura directa (`normalizedAddress ??`, `?? order.addressRaw`)", () => {
    // Positiva de control: el archivo se leyo y sigue nombrando la direccion (el modulo la recibe
    // en el pedido; lo que se prohibe es sustituirla, no mencionarla).
    expect(FUENTE_PANTALLA.length, "el monolito no esta vacio").toBeGreaterThan(0);
    expect(/\baddressRaw\b/.test(FUENTE_PANTALLA), "el archivo sigue nombrando `addressRaw`").toBe(true);
    const violaciones = violacionesDeLecturaDirecta(FUENTE_PANTALLA);
    expect(
      violaciones,
      "la pantalla vuelve a leer la direccion por su cuenta: en cada sitio de la lista la nota de la tienda pisa la direccion, o la direccion hace de respaldo de otra cosa"
    ).toEqual([]);
  });

  it("RF_05–RF_07 · la guia recorre `orderAddressLines(` y pinta rotulo y texto de cada linea, escapados", () => {
    const guia = cuerpoDe(FUNCIONES_PANTALLA, "printOrderLabels");
    // Positivas de control (RNF_01): la guia conserva lo que no cambia.
    expect(guia, "la primera linea conserva la clase `.address`").toContain('class="address"');
    expect(guia, "la guia sigue pintando al cliente").toContain("Cliente");
    expect(guia, "y sigue escapando lo que escribe").toContain("escapeHtml(");
    expect(
      callPattern("orderAddressLines").test(guia),
      "`printOrderLabels` no llama a `orderAddressLines(`: sigue decidiendo por su cuenta que direccion imprime"
    ).toBe(true);
    expect(/\.label\b/.test(guia), "la guia no pinta el rotulo (`.label`) de cada linea (RF_06, RF_07: lineas ROTULADAS)").toBe(true);
    expect(/\.text\b/.test(guia), "la guia no pinta el texto (`.text`) de cada linea").toBe(true);
    // Lo que sale del modulo es texto de la tienda o del mensajero y va a `document.write`: pasa
    // por `escapeHtml` como todo lo demas. Una interpolacion cruda `${x.text}` es un agujero.
    expect(
      /\$\{\s*[\w$]+\.(?:text|label)\s*\}/.test(guia),
      "la guia interpola `${x.text}` o `${x.label}` sin `escapeHtml(`: texto de la tienda directo a `document.write`"
    ).toBe(false);
  });

  it("caso limite 'indicacion muy larga' · las lineas extra llevan `.address-extra` recortada a tres lineas en el <style> de la guia", () => {
    const guia = cuerpoDe(FUNCIONES_PANTALLA, "printOrderLabels");
    expect(guia, "la guia no usa la clase `address-extra` para las lineas que van debajo de la direccion").toContain("address-extra");
    const css = bloqueStyleDeLaGuia(guia);
    // Positiva de control: el bloque de estilos se extrajo y es el de la guia.
    expect(reglaCss(css, ".product-name"), "la regla `.product-name` sigue en el <style> de la guia").toContain("-webkit-line-clamp");
    const regla = reglaCss(css, ".address-extra");
    expect(regla.length, "no hay regla `.address-extra { ... }` en el <style> de la guia").toBeGreaterThan(0);
    expect(/-webkit-line-clamp\s*:\s*3\b/.test(regla), "`.address-extra` no recorta a tres lineas (`-webkit-line-clamp: 3`)").toBe(true);
    expect(/display\s*:\s*-webkit-box\b/.test(regla), "`.address-extra` sin `display: -webkit-box`: el clamp no recorta nada").toBe(true);
    expect(/-webkit-box-orient\s*:\s*vertical\b/.test(regla), "`.address-extra` sin `-webkit-box-orient: vertical`: el clamp no recorta nada").toBe(true);
    expect(/overflow\s*:\s*hidden\b/.test(regla), "`.address-extra` sin `overflow: hidden`: lo recortado se sigue viendo").toBe(true);
  });

  it("RF_08 · la tarjeta (`OrderCard`) recorre `orderAddressLines(` y no lee la direccion por su cuenta; `OrderRow` tampoco", () => {
    const tarjeta = cuerpoDe(FUNCIONES_PANTALLA, "OrderCard");
    expect(tarjeta, "la tarjeta sigue pintando el icono de direccion").toContain("<MapPin");
    expect(
      callPattern("orderAddressLines").test(tarjeta),
      "`OrderCard` no llama a `orderAddressLines(`: la tarjeta sigue decidiendo por su cuenta que direccion muestra"
    ).toBe(true);
    const lecturaDirecta = tarjeta.match(/\border\.(?:addressRaw|normalizedAddress)\b/);
    expect(
      lecturaDirecta ? fragmentoAlrededor(tarjeta, lecturaDirecta.index ?? 0) : "",
      "`OrderCard` lee `order.addressRaw` u `order.normalizedAddress` directamente (RNF_02: las lineas salen SOLO del modulo)"
    ).toBe("");
    const fila = cuerpoDe(FUNCIONES_PANTALLA, "OrderRow");
    expect(/\border\.(?:addressRaw|normalizedAddress)\b/.test(fila), "`OrderRow` lee la direccion por su cuenta").toBe(false);
  });

  it("RF_06, RF_07, RF_11 · la tarjeta pinta el rotulo de cada linea extra en su propia <p> sin `truncate`, y la <p> del MapPin ya no lleva la nota", () => {
    const tarjeta = cuerpoDe(FUNCIONES_PANTALLA, "OrderCard");
    const mapPin = tarjeta.indexOf("<MapPin");
    expect(mapPin, "la tarjeta sigue pintando el icono de direccion").toBeGreaterThan(-1);
    const parrafoPrimario = parrafoQueContiene(tarjeta, mapPin);
    expect(parrafoPrimario.length, "el `<MapPin` va dentro de una `<p>`").toBeGreaterThan(0);
    expect(
      /normalizedAddress|addressRaw/.test(parrafoPrimario),
      `la <p> del MapPin sigue leyendo la direccion por su cuenta: ${parrafoPrimario.trim()}`
    ).toBe(false);

    const rotulos = referenciasAlRotulo(tarjeta);
    expect(
      rotulos.length,
      "la tarjeta no pinta ningun `x.label`: las lineas 'Correccion o nota' e 'Indicaciones' no salen rotuladas (RF_06, RF_07) y el pedido viejo pierde su nota (RF_11)"
    ).toBeGreaterThan(0);
    const truncados = rotulos
      .map((i) => parrafoQueContiene(tarjeta, i))
      .filter((parrafo) => parrafo.length === 0 || /\btruncate\b/.test(parrafo));
    expect(
      truncados.map((parrafo) => parrafo.trim().slice(0, 160)),
      "cada `x.label` va en su propia `<p>` y esa `<p>` no lleva `truncate`: la tarjeta muestra la indicacion ENTERA (caso limite 'indicacion muy larga')"
    ).toEqual([]);
  });

  it("DoD 4 · mutacion: devolver `order.normalizedAddress ?? order.addressRaw` a la guia hace fallar la MISMA guarda", () => {
    const guia = cuerpoDe(FUNCIONES_PANTALLA, "printOrderLabels");
    // Positiva de control: hay algo que mutar. Sin la llamada, el mutante seria igual al original.
    expect(
      callPattern("orderAddressLines").test(guia),
      "`printOrderLabels` no llama a `orderAddressLines(`: no hay llamada que mutar"
    ).toBe(true);
    expect(violacionesDeLecturaDirecta(guia), "la guia real no tiene lecturas directas").toEqual([]);
    const mutante = guia.replace(callPattern("orderAddressLines"), "order.normalizedAddress ?? order.addressRaw");
    expect(mutante, "la mutacion cambio algo").not.toBe(guia);
    const violaciones = violacionesDeLecturaDirecta(mutante);
    expect(violaciones.length, "la guarda NO detecta la lectura directa reintroducida: no sirve para RNF_02").toBeGreaterThan(0);
    expect(violaciones[0]).toContain("normalizedAddress ??");
  });

  it("DoD 4 · la guarda se conoce a si misma: cero violaciones en una fuente limpia, una por cada forma del bug", () => {
    // Prueba de la funcion de guarda en si, independiente del estado del monolito: si alguien la
    // afloja (p. ej. quitando un patron), esto cae aunque la pantalla este en verde.
    const limpia = 'const lines = orderAddressLines(order);\nconst address = lines[0].text;\nconst seed = order.normalizedAddress ?? "";';
    expect(violacionesDeLecturaDirecta(limpia).length, "una fuente con `?? \"\"` de semilla tambien cuenta: el patron es literal").toBe(1);
    const bug = "const a = order.normalizedAddress ?? order.addressRaw;\nconst b = order.deliveryNotes ?? order.addressRaw;";
    const violaciones = violacionesDeLecturaDirecta(bug);
    expect(violaciones.length).toBe(3);
    expect(violaciones[0]).toContain("linea 1");
    expect(violaciones[2]).toContain("linea 2");
  });
});

/*
 * =====================================================================================
 * T3 · RF_08, RNF_02 — El Excel consume `orderAddressLines`.
 * =====================================================================================
 *
 * Lo medido en el codigo (plan §1): `buildOrderExportRows` hace `direccion_original:
 * order.addressRaw` y `direccion_normalizada: order.normalizedAddress` (order-export.ts:163-164).
 * No es el bug de la guia (aqui no se pisa nada), pero es una COPIA de la regla: la corregida
 * "igual" salia duplicada y la original vacia salia vacia, y RNF_02 prohibe que cada superficie
 * decida por su cuenta. El comportamiento (valores de las celdas, columna `indicaciones` al final)
 * se prueba en `order-export.test.ts`; aqui solo la FORMA.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA (lo que el coder debe respetar):
 *
 * 1. `order-export.ts` importa `orderAddressLines` desde `./order-address-lines`, en un
 *    `import { ... }` con llaves como el resto del archivo.
 * 2. En TODO el archivo sin comentarios no queda `order.addressRaw` ni `order.normalizedAddress`
 *    (`pedido_json: JSON.stringify(order)` no cuenta: no lee el campo).
 * 3. Llama a `orderAddressLines(`.
 * 4. Contiene el literal `"indicaciones"` (la columna nueva de RF_12).
 * ---------------------------------------------------------------------------------------------
 */

const EXCEL = "src/lib/order-export.ts";
const FUENTE_EXCEL = repoSourceWithoutComments(EXCEL);

describe("T3 — el Excel consume orderAddressLines (RF_08, RNF_02)", () => {
  it("RF_08, RNF_02 · `order-export.ts` importa `orderAddressLines` desde `./order-address-lines`", () => {
    // Positiva de control: el archivo se leyo y su import con llaves de siempre sigue ahi.
    expect(FUENTE_EXCEL.length, "order-export.ts no esta vacio").toBeGreaterThan(0);
    expect(
      /import\s*\{[^}]*\bisChargeableFailedOrder\b[^}]*\}\s*from\s*["']\.\/finance["']/.test(FUENTE_EXCEL),
      "el import de `isChargeableFailedOrder` desde `./finance` sigue ahi (es la forma de import que se espera)"
    ).toBe(true);
    expect(
      /import\s*\{[^}]*\borderAddressLines\b[^}]*\}\s*from\s*["']\.\/order-address-lines["']/.test(FUENTE_EXCEL),
      "el Excel no importa `orderAddressLines` de `./order-address-lines`: no tiene de donde sacar las lineas"
    ).toBe(true);
  });

  it("RNF_02 · en todo el archivo no queda `order.addressRaw` ni `order.normalizedAddress`", () => {
    // Positiva de control: el archivo sigue exportando las dos columnas de direccion. Sobre BOOLEANOS,
    // como todo el archivo: un `toContain` sobre la fuente vuelca el archivo entero al fallar.
    expect(FUENTE_EXCEL.includes("direccion_original"), "la columna `direccion_original` sigue existiendo").toBe(true);
    expect(FUENTE_EXCEL.includes("direccion_normalizada"), "la columna `direccion_normalizada` sigue existiendo").toBe(true);
    const lecturasDirectas = [...FUENTE_EXCEL.matchAll(/\border\.(?:addressRaw|normalizedAddress)\b/g)]
      .map((match) => `linea ${lineaDe(FUENTE_EXCEL, match.index ?? 0)}: ${fragmentoAlrededor(FUENTE_EXCEL, match.index ?? 0)}`);
    expect(
      lecturasDirectas,
      "el Excel lee `order.addressRaw` u `order.normalizedAddress` directamente: una copia de la regla que RNF_02 prohibe"
    ).toEqual([]);
  });

  it("RF_08 · el Excel llama a `orderAddressLines(`", () => {
    expect(
      callPattern("orderAddressLines").test(FUENTE_EXCEL),
      "`order-export.ts` no llama a `orderAddressLines(`: las celdas de direccion no salen del modulo"
    ).toBe(true);
  });

  it("RF_12 · el Excel contiene el literal `\"indicaciones\"`", () => {
    expect(
      FUENTE_EXCEL.includes('"indicaciones"'),
      "no aparece la columna `\"indicaciones\"` en `order-export.ts`"
    ).toBe(true);
  });
});

/*
 * =====================================================================================
 * T4 · RF_09, RF_10, RF_11, RF_13, RNF_01 — El servidor y los wrappers aceptan `deliveryNotes`;
 * las otras vias de entrada no lo tocan.
 * =====================================================================================
 *
 * Lo medido en el codigo (plan §1 y §2.4): `manualOrderSchema` (orders.ts:52) y
 * `updateImportedOrderSchema` (:164) no conocen `deliveryNotes`; `createManualOrder` escribe
 * `normalizedAddress: input.normalizedAddress?.trim() || undefined` (:327) y `updateImportedOrder`
 * `normalizedAddress: input.normalizedAddress?.trim()` (:494) con `transaction.set(orderRef, updated,
 * { merge: true })` (:507). Los wrappers de `auth.ts` (:152, :247) y el `createManualOrder` local de
 * `actions.ts` (:284) tampoco lo aceptan. Zod no es estricto: un cliente nuevo que mande
 * `deliveryNotes` a este servidor lo pierde EN SILENCIO, por eso la guarda es de forma y por linea.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA (lo que el coder debe respetar):
 *
 * 1. `manualOrderSchema` gana `deliveryNotes: optionalText` y `updateImportedOrderSchema` gana
 *    `deliveryNotes: optionalString` (cada schema con el helper que ya usa para lo opcional).
 * 2. El callable `createManualOrder` escribe `deliveryNotes: input.deliveryNotes?.trim() || undefined`
 *    (pasa por `stripUndefined`, como todo el documento). El callable `updateImportedOrder` escribe
 *    exactamente lo mismo, Y CONSERVA tal cual `normalizedAddress: input.normalizedAddress?.trim()`
 *    (sin `|| undefined`) y `transaction.set(orderRef, updated, { merge: true })`.
 *
 *    Por que se guarda lo que NO cambia (RF_11, "la tienda edita un pedido viejo"): T5 quita del
 *    formulario la casilla "normalizada", asi que el cliente deja de enviar `normalizedAddress`. En
 *    el servidor `input.normalizedAddress?.trim()` da `undefined`, `stripUndefined` QUITA la clave
 *    del objeto `updated`, y `set(..., { merge: true })` no pisa un campo que no viene: la direccion
 *    corregida por el mensajero sobrevive a la edicion. Cambiar cualquiera de las tres piezas
 *    (`|| ""`, un `set` sin `merge`, un `update` con `FieldValue.delete()`) borraria la corregida en
 *    cada edicion, sin error y sin aviso.
 * 3. RF_13: `index.ts` (webhook Shopify), `store-webhook.ts`, `onstock-webhook.ts` y
 *    `contact-form.ts` no contienen `deliveryNotes`. Las indicaciones son de la tienda al crear o
 *    editar a mano; ninguna via automatica las inventa.
 * 4. `createManualFirebaseOrder` y `updateFirebaseImportedOrder` (`auth.ts`) aceptan
 *    `deliveryNotes?: string` en su tipo de input.
 * 5. `createManualOrder` (`actions.ts`) acepta `deliveryNotes?: string` y escribe
 *    `deliveryNotes: input.deliveryNotes?.trim() || undefined` (el comportamiento se prueba en
 *    `actions.test.ts`; aqui la forma, para que el servidor y el estado local no diverjan).
 *
 * RNF_01: todo lo que aqui se pide es ADITIVO; las positivas de control fijan lo que no cambia.
 * ---------------------------------------------------------------------------------------------
 */

const SERVIDOR = "functions/src/orders.ts";
const FUENTE_SERVIDOR = repoSourceWithoutComments(SERVIDOR);
const AUTH = "src/lib/firebase/auth.ts";
const FUENTE_AUTH = repoSourceWithoutComments(AUTH);
const ACCIONES = "src/lib/actions.ts";
const FUENTE_ACCIONES = repoSourceWithoutComments(ACCIONES);

/** Las vias de entrada automaticas que RF_13 deja fuera de las indicaciones. */
const OTRAS_VIAS = ["functions/src/index.ts", "functions/src/store-webhook.ts", "functions/src/onstock-webhook.ts", "functions/src/contact-form.ts"] as const;

/**
 * El bloque que abre justo al final de `ancla` (el ultimo caracter de `ancla` es `(`, `{` o `[`) y
 * cierra con `cierreSeguro`, o "" si el ancla no esta. Sirve para lo que `funcionesSeguras` no ve:
 * `const x = z.object({`, `export const x = onCall(`, y la lista de parametros de una `function`.
 */
function bloqueDesde(source: string, ancla: string): string {
  const inicio = source.indexOf(ancla);
  if (inicio < 0) return "";
  const apertura = inicio + ancla.length - 1;
  return source.slice(inicio, cierreSeguro(source, apertura) + 1);
}

/** `nombre: valor` como propiedad de un objeto o de un tipo (tolerante a espacios). */
function propiedad(nombre: string, valor: string): RegExp {
  const escapar = (texto: string) => texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapar(nombre)}\\s*:\\s*${escapar(valor)}`);
}

/** `nombre?: string` dentro de un tipo de input. */
function propiedadOpcional(nombre: string): RegExp {
  return new RegExp(`\\b${nombre}\\?\\s*:\\s*string\\b`);
}

describe("T4 — el servidor y los wrappers aceptan deliveryNotes; las otras vias no lo tocan (RF_09, RF_10, RF_11, RF_13)", () => {
  const schemaManual = bloqueDesde(FUENTE_SERVIDOR, "const manualOrderSchema = z.object({");
  const schemaEdicion = bloqueDesde(FUENTE_SERVIDOR, "const updateImportedOrderSchema = z.object({");
  const callableCrear = bloqueDesde(FUENTE_SERVIDOR, "export const createManualOrder = onCall(");
  const callableEditar = bloqueDesde(FUENTE_SERVIDOR, "export const updateImportedOrder = onCall(");

  it("el extractor trae los dos schemas y los dos callables, y no se pasa de largo", () => {
    // Guarda del propio extractor: un bloque vacio o desbordado pondria en verde lo de abajo con
    // codigo que no es de estas piezas.
    expect(schemaManual.length, "no se encuentra `const manualOrderSchema = z.object({`").toBeGreaterThan(0);
    expect(propiedad("addressRaw", 'requiredText("La direccion")').test(schemaManual), "el schema manual conserva `addressRaw: requiredText(...)`").toBe(true);
    expect(/\bupdateImportedOrderSchema\b/.test(schemaManual), "el schema manual se desborda hasta `updateImportedOrderSchema`").toBe(false);

    expect(schemaEdicion.length, "no se encuentra `const updateImportedOrderSchema = z.object({`").toBeGreaterThan(0);
    expect(propiedad("orderId", "z.string().min(1)").test(schemaEdicion), "el schema de edicion conserva `orderId`").toBe(true);
    expect(/\bupdateOrderAdjustmentsSchema\b/.test(schemaEdicion), "el schema de edicion se desborda hasta `updateOrderAdjustmentsSchema`").toBe(false);

    expect(callableCrear.length, "no se encuentra `export const createManualOrder = onCall(`").toBeGreaterThan(0);
    expect(callableCrear.includes('action: "order.manual_created"'), "el callable de creacion llega hasta su auditoria").toBe(true);
    expect(/\bconfirmImportedOrder\b/.test(callableCrear), "el callable de creacion se desborda hasta `confirmImportedOrder`").toBe(false);

    expect(callableEditar.length, "no se encuentra `export const updateImportedOrder = onCall(`").toBeGreaterThan(0);
    expect(callableEditar.includes('action: "order.imported_updated"'), "el callable de edicion llega hasta su auditoria").toBe(true);
    expect(/\bconfirmRetryOrder\b/.test(callableEditar), "el callable de edicion se desborda hasta `confirmRetryOrder`").toBe(false);
  });

  it("RF_09 · `manualOrderSchema` acepta `deliveryNotes: optionalText`", () => {
    // Positiva de control: el helper de opcionales del schema manual es `optionalText`.
    expect(propiedad("normalizedAddress", "optionalText").test(schemaManual), "`normalizedAddress: optionalText` sigue en el schema manual").toBe(true);
    expect(
      propiedad("deliveryNotes", "optionalText").test(schemaManual),
      "`manualOrderSchema` no tiene `deliveryNotes: optionalText`: zod no es estricto y las indicaciones de la tienda se pierden en silencio al crear"
    ).toBe(true);
  });

  it("RF_09, RF_10 · `updateImportedOrderSchema` acepta `deliveryNotes: optionalString`", () => {
    // Positiva de control: el helper de opcionales del schema de edicion es `optionalString`.
    expect(propiedad("normalizedAddress", "optionalString").test(schemaEdicion), "`normalizedAddress: optionalString` sigue en el schema de edicion").toBe(true);
    expect(
      propiedad("deliveryNotes", "optionalString").test(schemaEdicion),
      "`updateImportedOrderSchema` no tiene `deliveryNotes: optionalString`: las indicaciones se pierden en silencio al editar"
    ).toBe(true);
  });

  it("RF_09 · el callable `createManualOrder` escribe `deliveryNotes: input.deliveryNotes?.trim() || undefined`", () => {
    // Positivas de control (RNF_01): el documento sigue pasando por `stripUndefined` y la
    // direccion se sigue escribiendo como hoy.
    expect(callableCrear.includes("stripUndefined({"), "el documento del pedido manual sigue pasando por `stripUndefined`").toBe(true);
    expect(propiedad("addressRaw", "input.addressRaw.trim()").test(callableCrear), "`addressRaw: input.addressRaw.trim()` sigue ahi").toBe(true);
    expect(
      propiedad("deliveryNotes", "input.deliveryNotes?.trim() || undefined").test(callableCrear),
      "`createManualOrder` no escribe `deliveryNotes: input.deliveryNotes?.trim() || undefined` en el documento"
    ).toBe(true);
  });

  it("RF_09, RF_11 · el callable `updateImportedOrder` escribe `deliveryNotes` igual y conserva `normalizedAddress` y el `merge: true`", () => {
    expect(
      propiedad("deliveryNotes", "input.deliveryNotes?.trim() || undefined").test(callableEditar),
      "`updateImportedOrder` no escribe `deliveryNotes: input.deliveryNotes?.trim() || undefined`"
    ).toBe(true);
    // RF_11: las tres piezas que juntas conservan la direccion corregida cuando el cliente ya no
    // envia `normalizedAddress` (T5): `?.trim()` da undefined -> `stripUndefined` quita la clave ->
    // `merge: true` no pisa lo que no viene. Ver el contrato de forma, punto 2.
    expect(callableEditar.includes("stripUndefined({"), "`updated` sigue pasando por `stripUndefined`: sin el, la clave `normalizedAddress: undefined` llegaria a Firestore").toBe(true);
    const lineaNormalizada = callableEditar.match(/\bnormalizedAddress\s*:\s*[^,\n]*/);
    expect(
      lineaNormalizada?.[0].trim() ?? "",
      "`normalizedAddress: input.normalizedAddress?.trim()` debe quedar EXACTAMENTE asi (sin `|| undefined` ni `|| \"\"`): un `\"\"` pisaria la corregida en cada edicion"
    ).toBe("normalizedAddress: input.normalizedAddress?.trim()");
    expect(
      /transaction\.set\(\s*orderRef\s*,\s*updated\s*,\s*\{\s*merge:\s*true\s*\}\s*\)/.test(callableEditar),
      "`transaction.set(orderRef, updated, { merge: true })` debe seguir ahi: sin `merge` la edicion borra la direccion corregida por el mensajero (RF_11)"
    ).toBe(true);
  });

  it("RF_13 · las otras vias de entrada (webhook Shopify, tienda, OnStock, formulario) no contienen `deliveryNotes`", () => {
    for (const via of OTRAS_VIAS) {
      const fuente = repoSourceWithoutComments(via);
      // Positiva de control: cada via se leyo y construye la direccion del pedido.
      expect(fuente.length, `${via} no esta vacio`).toBeGreaterThan(0);
      expect(/\baddressRaw\b/.test(fuente), `${via} sigue escribiendo \`addressRaw\``).toBe(true);
      const donde = fuente.match(/\bdeliveryNotes\b/);
      expect(
        donde ? `${via} linea ${lineaDe(fuente, donde.index ?? 0)}: ${fragmentoAlrededor(fuente, donde.index ?? 0)}` : "",
        `${via} escribe \`deliveryNotes\`: las indicaciones son de la tienda al crear o editar a mano, ninguna via automatica las inventa (RF_13)`
      ).toBe("");
    }
  });

  it("RF_09 · los wrappers `createManualFirebaseOrder` y `updateFirebaseImportedOrder` aceptan `deliveryNotes?: string`", () => {
    const crear = bloqueDesde(FUENTE_AUTH, "export async function createManualFirebaseOrder(");
    const editar = bloqueDesde(FUENTE_AUTH, "export async function updateFirebaseImportedOrder(");
    // Positivas de control: los dos tipos de input se extrajeron y siguen llevando la direccion.
    expect(propiedad("addressRaw", "string").test(crear), "el input de `createManualFirebaseOrder` conserva `addressRaw: string`").toBe(true);
    expect(propiedad("addressRaw", "string").test(editar), "el input de `updateFirebaseImportedOrder` conserva `addressRaw: string`").toBe(true);
    expect(
      propiedadOpcional("deliveryNotes").test(crear),
      "el tipo de input de `createManualFirebaseOrder` no acepta `deliveryNotes?: string`: el formulario de T5 no podria enviarlo sin `any`"
    ).toBe(true);
    expect(
      propiedadOpcional("deliveryNotes").test(editar),
      "el tipo de input de `updateFirebaseImportedOrder` no acepta `deliveryNotes?: string`"
    ).toBe(true);
  });

  it("RF_09 · el `createManualOrder` local (`actions.ts`) acepta `deliveryNotes?: string` y lo escribe recortado", () => {
    const parametros = bloqueDesde(FUENTE_ACCIONES, "export function createManualOrder(");
    expect(propiedad("addressRaw", "string").test(parametros), "el input local conserva `addressRaw: string`").toBe(true);
    expect(
      propiedadOpcional("deliveryNotes").test(parametros),
      "el tipo de input de `createManualOrder` (actions.ts) no acepta `deliveryNotes?: string`"
    ).toBe(true);
    const cuerpo = cuerpoDe(funcionesSeguras(FUENTE_ACCIONES), "createManualOrder");
    expect(propiedad("normalizedAddress", "input.normalizedAddress?.trim() || undefined").test(cuerpo), "el cuerpo local sigue escribiendo `normalizedAddress` como hoy").toBe(true);
    expect(
      propiedad("deliveryNotes", "input.deliveryNotes?.trim() || undefined").test(cuerpo),
      "`createManualOrder` (actions.ts) no escribe `deliveryNotes: input.deliveryNotes?.trim() || undefined`: el estado local divergiria del servidor"
    ).toBe(true);
  });
});

/*
 * =====================================================================================
 * T5 · RF_09, RF_10 — La tienda escribe indicaciones y deja de ver "normalizada".
 * =====================================================================================
 *
 * Lo medido en el codigo (plan §2.5): `ManualOrderPanel` (operations-app.tsx:5746) tiene el estado
 * `[normalizedAddress, setNormalizedAddress]` (:5760), la casilla `placeholder="Direccion normalizada
 * opcional"` (:5951), lo envia en shorthand dentro de `const input = {` (:5888) y lo resetea tras crear
 * (:5907). `ImportedOrderReviewForm` (:2265) lo siembra con `normalizedAddress: order.normalizedAddress
 * || ""` (:2271), lo pinta en otra casilla "normalizada" (:2365) y lo envia DOS veces a
 * `updateFirebaseImportedOrder` como `normalizedAddress: form.normalizedAddress || undefined` (:2299,
 * :2330). Es la raiz del bug de la guia: la tienda usa esa casilla como observacion y la nota pisa la
 * direccion. RF_10 la retira para todos (tambien el admin); RF_09 mete en su lugar las indicaciones.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA (lo que el coder debe respetar):
 *
 * 1. En NINGUNO de los dos cuerpos queda `normalizada` (ni placeholder ni texto), ni
 *    `setNormalizedAddress`, ni `form.normalizedAddress`, ni `normalizedAddress:`. Los dos siguen
 *    nombrando `addressRaw`: la direccion no se toca.
 * 2. Los dos cuerpos contienen `deliveryNotes` y un `<textarea` cuyo `placeholder` o `aria-label`
 *    contiene `Indicaciones para el mensajero`; ese `<textarea` NO lleva `required` (es opcional).
 * 3. `ManualOrderPanel`: el objeto `const input = { ... }` que se envia contiene `deliveryNotes` y no
 *    contiene `normalizedAddress` (tampoco en shorthand); el reset tras crear llama a
 *    `setDeliveryNotes("")`.
 * 4. `ImportedOrderReviewForm`: la semilla `useState({ ... })` lleva `deliveryNotes: order.deliveryNotes`
 *    con `?? ""` o `|| ""`; las DOS llamadas a `updateFirebaseImportedOrder({ ... })` envian
 *    `deliveryNotes: form.deliveryNotes || undefined` (se acepta `.trim()` o `?.trim()` antes del `||`) y ya no
 *    envian `normalizedAddress` (RF_11: el servidor conserva la corregida porque no le llega la clave;
 *    ver el contrato de T4, punto 2).
 * 5. RNF_02 sigue: `violacionesDeLecturaDirecta(FUENTE_PANTALLA)` vacio. Quitar la semilla de :2271
 *    quita una lectura directa, pero no vale reintroducirla en otra forma.
 * ---------------------------------------------------------------------------------------------
 */

/** Cada bloque que abre justo al final de `ancla`, en orden de aparicion (cf. `bloqueDesde`, que da el primero). */
function bloquesDesde(source: string, ancla: string): string[] {
  const bloques: string[] = [];
  let desde = 0;
  for (;;) {
    const inicio = source.indexOf(ancla, desde);
    if (inicio < 0) return bloques;
    const apertura = inicio + ancla.length - 1;
    const fin = cierreSeguro(source, apertura);
    bloques.push(source.slice(inicio, fin + 1));
    desde = fin + 1;
  }
}

/**
 * La etiqueta de apertura JSX que empieza en `inicio` (`<textarea ... />` o `<textarea ...>`), saltando
 * los `{...}` de los atributos (un `onChange={(e) => ...}` lleva un `>` dentro) y los literales.
 */
function etiquetaJsxDesde(jsx: string, inicio: number): string {
  for (let i = inicio + 1; i < jsx.length; i += 1) {
    const caracter = jsx[i];
    if (caracter === "{") {
      i = cierreSeguro(jsx, i);
      continue;
    }
    if (caracter === '"' || caracter === "'" || caracter === "`") {
      i = finDelLiteral(jsx, i);
      continue;
    }
    if (caracter === ">") return jsx.slice(inicio, i + 1);
  }
  return jsx.slice(inicio);
}

/** Todas las etiquetas `<textarea ...>` de un cuerpo JSX. */
function etiquetasTextarea(jsx: string): string[] {
  return [...jsx.matchAll(/<textarea\b/g)].map((match) => etiquetaJsxDesde(jsx, match.index ?? 0));
}

/** El `<textarea` de indicaciones: su placeholder o aria-label contiene el rotulo de RF_09. */
function esTextareaDeIndicaciones(etiqueta: string): boolean {
  return /\b(?:placeholder|aria-label)\s*=\s*(?:"[^"]*Indicaciones para el mensajero[^"]*"|\{[^}]*Indicaciones para el mensajero[^}]*\})/.test(etiqueta);
}

/** Linea REAL del monolito para la posicion `i` de un `cuerpo` extraido de el. */
function lineaRealDe(cuerpo: string, i: number): number {
  const desplazamiento = FUENTE_PANTALLA.indexOf(cuerpo);
  return lineaDe(FUENTE_PANTALLA, (desplazamiento < 0 ? 0 : desplazamiento) + i);
}

/** Los restos de la casilla "normalizada" que RF_10 retira del formulario, con su linea real. */
const RESTOS_DE_NORMALIZADA: ReadonlyArray<{ nombre: string; patron: RegExp }> = [
  { nombre: "normalizada", patron: /normalizada/g },
  { nombre: "setNormalizedAddress", patron: /\bsetNormalizedAddress\b/g },
  { nombre: "form.normalizedAddress", patron: /\bform\.normalizedAddress\b/g },
  { nombre: "normalizedAddress:", patron: /\bnormalizedAddress\s*:/g }
];

function restosDeNormalizada(cuerpo: string): string[] {
  const restos: string[] = [];
  for (const { nombre, patron } of RESTOS_DE_NORMALIZADA) {
    for (const match of cuerpo.matchAll(patron)) {
      const i = match.index ?? 0;
      restos.push(`\`${nombre}\` en la linea ${lineaRealDe(cuerpo, i)}: ${fragmentoAlrededor(cuerpo, i)}`);
    }
  }
  return restos;
}

describe("T5 — la tienda escribe indicaciones y deja de ver 'normalizada' (RF_09, RF_10)", () => {
  const panelManual = cuerpoDe(FUNCIONES_PANTALLA, "ManualOrderPanel");
  const revision = cuerpoDe(FUNCIONES_PANTALLA, "ImportedOrderReviewForm");
  const formularios: ReadonlyArray<{ nombre: string; cuerpo: string }> = [
    { nombre: "ManualOrderPanel", cuerpo: panelManual },
    { nombre: "ImportedOrderReviewForm", cuerpo: revision }
  ];

  it("el extractor trae `ManualOrderPanel` e `ImportedOrderReviewForm`, y no se pasa de largo", () => {
    // Guarda del propio extractor: un cuerpo desbordado arrastraria al vecino y las guardas de abajo
    // juzgarian codigo que no es de estos formularios.
    expect(panelManual.includes("Crear pedido"), "el cuerpo de `ManualOrderPanel` llega hasta el boton 'Crear pedido'").toBe(true);
    expect(
      /function\s+SellerPickupPointsPanel\s*\(/.test(panelManual),
      "el cuerpo de `ManualOrderPanel` se desborda hasta `SellerPickupPointsPanel`: el recorte no es de fiar"
    ).toBe(false);

    expect(revision.includes("Revisar antes de liberar"), "el cuerpo de `ImportedOrderReviewForm` pinta 'Revisar antes de liberar'").toBe(true);
    expect(revision.includes("updateFirebaseImportedOrder("), "y llama al wrapper de edicion").toBe(true);
    expect(
      /function\s+EvidenceItem\s*\(/.test(revision),
      "el cuerpo de `ImportedOrderReviewForm` se desborda hasta `EvidenceItem`: el recorte no es de fiar"
    ).toBe(false);
  });

  it("RF_10 · en ninguno de los dos formularios queda la casilla 'normalizada' (ni estado, ni semilla, ni envio); la direccion sigue", () => {
    for (const { nombre, cuerpo } of formularios) {
      // Positiva de control: el formulario sigue nombrando la direccion; lo que se retira es la nota.
      expect(/\baddressRaw\b/.test(cuerpo), `\`${nombre}\` sigue nombrando \`addressRaw\``).toBe(true);
      expect(
        restosDeNormalizada(cuerpo),
        `\`${nombre}\` conserva la casilla "normalizada" que RF_10 retira: la tienda la sigue usando como observacion y la nota pisa la direccion`
      ).toEqual([]);
    }
  });

  it("RF_09 · los dos formularios tienen `deliveryNotes` y un <textarea> 'Indicaciones para el mensajero' que no es `required`", () => {
    for (const { nombre, cuerpo } of formularios) {
      expect(/\bdeliveryNotes\b/.test(cuerpo), `\`${nombre}\` no nombra \`deliveryNotes\`: no hay donde escribir las indicaciones`).toBe(true);
      const indicaciones = etiquetasTextarea(cuerpo).filter(esTextareaDeIndicaciones);
      expect(
        indicaciones.length,
        `\`${nombre}\` no tiene un <textarea> con placeholder o aria-label "Indicaciones para el mensajero" (RF_09)`
      ).toBe(1);
      expect(
        /\srequired\b/.test(indicaciones[0] ?? ""),
        `el <textarea> de indicaciones de \`${nombre}\` lleva \`required\`: las indicaciones son opcionales`
      ).toBe(false);
    }
  });

  it("RF_09 · `ManualOrderPanel` envia `deliveryNotes` (y no `normalizedAddress`) en `input`, y lo resetea tras crear", () => {
    const input = bloqueDesde(panelManual, "const input = {");
    // Positiva de control: el objeto enviado se extrajo y sigue llevando la direccion.
    expect(input.length, "no se encuentra `const input = {` en `ManualOrderPanel`").toBeGreaterThan(0);
    expect(/\baddressRaw\b/.test(input), "el `input` de `ManualOrderPanel` sigue llevando `addressRaw`").toBe(true);
    expect(/\bdeliveryNotes\b/.test(input), "el `input` que `ManualOrderPanel` envia a `createManualFirebaseOrder` no lleva `deliveryNotes`").toBe(true);
    const sobrante = input.match(/\bnormalizedAddress\b/);
    expect(
      sobrante ? fragmentoAlrededor(input, sobrante.index ?? 0) : "",
      "el `input` de `ManualOrderPanel` sigue enviando `normalizedAddress` (RF_10: la tienda ya no la escribe)"
    ).toBe("");
    expect(
      /\bsetDeliveryNotes\(\s*""\s*\)/.test(panelManual),
      "tras crear el pedido `ManualOrderPanel` no llama a `setDeliveryNotes(\"\")`: las indicaciones del pedido anterior se quedan en el siguiente"
    ).toBe(true);
  });

  it("RF_09 · `ImportedOrderReviewForm` siembra `deliveryNotes` del pedido y lo envia en las dos llamadas a `updateFirebaseImportedOrder`", () => {
    const semilla = bloqueDesde(revision, "const [form, setForm] = useState({");
    expect(semilla.length, "no se encuentra `const [form, setForm] = useState({` en `ImportedOrderReviewForm`").toBeGreaterThan(0);
    expect(propiedad("addressRaw", "order.addressRaw").test(semilla), "la semilla sigue llevando `addressRaw: order.addressRaw`").toBe(true);
    expect(
      /\bdeliveryNotes\s*:\s*order\.deliveryNotes\s*(?:\?\?|\|\|)\s*""/.test(semilla),
      "la semilla del formulario no lleva `deliveryNotes: order.deliveryNotes ?? \"\"` (o `|| \"\"`): al editar un pedido viejo se perderian sus indicaciones"
    ).toBe(true);

    const llamadas = bloquesDesde(revision, "updateFirebaseImportedOrder({");
    // Positiva de control: guardar y confirmar son dos llamadas, y las dos siguen enviando la direccion.
    expect(llamadas.length, "`ImportedOrderReviewForm` llama dos veces a `updateFirebaseImportedOrder({` (guardar y confirmar)").toBe(2);
    llamadas.forEach((llamada, indice) => {
      const cual = indice === 0 ? "guardar" : "confirmar";
      expect(propiedad("addressRaw", "form.addressRaw").test(llamada), `la llamada de ${cual} sigue enviando \`addressRaw: form.addressRaw\``).toBe(true);
      expect(
        /\bdeliveryNotes\s*:\s*form\.deliveryNotes(?:\??\.trim\(\))?\s*\|\|\s*undefined\b/.test(llamada),
        `la llamada de ${cual} no envia \`deliveryNotes: form.deliveryNotes || undefined\`: las indicaciones no llegan al servidor`
      ).toBe(true);
      const sobrante = llamada.match(/\bnormalizedAddress\b/);
      expect(
        sobrante ? fragmentoAlrededor(llamada, sobrante.index ?? 0) : "",
        `la llamada de ${cual} sigue enviando \`normalizedAddress\` (RF_10; y RF_11 depende de que la clave NO viaje)`
      ).toBe("");
    });
  });

  it("RNF_02 · quitar la semilla no reintroduce ninguna lectura directa en el archivo", () => {
    // Regresion, no requisito nuevo: hoy ya esta en verde (T2). Se repite aqui porque T5 es la
    // tarea que toca la semilla `normalizedAddress: order.normalizedAddress || ""` (:2271) y podria
    // sustituirla por un `??` en otra forma. Positiva de control: el archivo se leyo.
    expect(/\baddressRaw\b/.test(FUENTE_PANTALLA), "el archivo sigue nombrando `addressRaw`").toBe(true);
    expect(
      violacionesDeLecturaDirecta(FUENTE_PANTALLA),
      "la pantalla vuelve a tener `normalizedAddress ??` o `?? order.addressRaw` (RNF_02)"
    ).toEqual([]);
  });
});

/*
 * =====================================================================================
 * T6 · RF_01–RF_04, RNF_03, RNF_04 — El formulario cabe: fila entera al desplegar, filas que
 * se apilan, controles de 44 px.
 * =====================================================================================
 *
 * Lo medido en el codigo (plan §2.6): `CollapsiblePanel` (operations-app.tsx:1098) no conoce
 * `spanWhenOpen` y su `<section className={flush ? ... : ...}>` (:1127) nunca ocupa la fila entera;
 * el panel `title="Crear pedido manual"` (:11588) vive en `<div className="grid gap-3 lg:grid-cols-3">`
 * (:11586), asi que desplegado se queda en UN tercio y el formulario sale recortado. En
 * `ManualOrderPanel` (:5746) el `<form className="grid gap-2">` (:5851) no lleva `min-w-0`; la fila de
 * producto es `sm:grid-cols-[2fr_1fr_auto_auto]` (:5995), sus tres inputs no llevan `w-full min-w-0` y
 * el de cantidad lleva `w-20` (:6010); y de los 17 controles ninguno mide 44 px (`py-2 text-sm` da
 * ~38 px; "Quitar" y el envio llevan `min-h-10`, que son 40).
 *
 * RNF_04: no hay navegador en vitest. Estas son GUARDAS DE FUENTE sobre las clases de adaptacion; la
 * medida real (scrollWidth === clientWidth y `height >= 44` a 390 y 1280 px) la hace
 * `scripts/verify-013.js` (T7). Es la unica excepcion declarada al principio 4, y el ultimo `it` de este
 * bloque la deja referenciada desde la suite.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA (lo que el coder debe respetar):
 *
 * 1. `CollapsiblePanel` declara `spanWhenOpen` en la desestructuracion de sus props y `spanWhenOpen?:
 *    boolean` en el tipo. Su etiqueta de apertura `<section` contiene el literal `lg:col-span-full`
 *    condicionado a `open && spanWhenOpen` (o `spanWhenOpen && open`). Se conserva `aria-expanded={open}`.
 * 2. En la fila de paneles de la tienda, la UNICA etiqueta `<CollapsiblePanel` con
 *    `title="Crear pedido manual"` lleva `spanWhenOpen` (a secas o `={true}`), y su contenedor inmediato
 *    sigue siendo `<div className="grid gap-3 lg:grid-cols-3">`: los otros dos paneles no cambian de fila.
 * 3. En el cuerpo de `ManualOrderPanel`, CADA etiqueta de apertura `<input`, `<select`, `<textarea` y
 *    `<button` lleva `min-h-11` (sin prefijo de breakpoint) en su `className`; se acepta un `min-h-N`
 *    mayor (los `<textarea` ya llevan `min-h-20`). Hay al menos 10.
 * 4. En `ManualOrderPanel` ninguna clase `grid-cols-[...]` contiene `fr` fuera de un `minmax(0,...)`;
 *    no queda `w-20`; la fila de producto usa EXACTAMENTE
 *    `sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_auto]`, y todos los `<input` dentro de
 *    `lines.map(` llevan `w-full` y `min-w-0`.
 * 5. El `<form` de `ManualOrderPanel` lleva `min-w-0` en su `className`.
 * ---------------------------------------------------------------------------------------------
 */

/** El valor del atributo `className` de una etiqueta JSX de apertura: literal `"..."` o expresion `{...}` entera. */
function claseDe(etiqueta: string): string {
  const match = etiqueta.match(/\bclassName\s*=\s*/);
  if (!match) return "";
  const inicio = (match.index ?? 0) + match[0].length;
  const apertura = etiqueta[inicio];
  if (apertura === '"' || apertura === "'" || apertura === "`") return etiqueta.slice(inicio + 1, finDelLiteral(etiqueta, inicio));
  if (apertura === "{") return etiqueta.slice(inicio + 1, cierreSeguro(etiqueta, inicio));
  return "";
}

/** `clase` como utilidad SUELTA (no `sm:clase`, no `clase-x`, no `-clase`). */
function utilidad(clase: string): RegExp {
  return new RegExp(`(?<![:\\w-])${clase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

/**
 * `min-h-N` suelto con N >= 11 (escala numerica de Tailwind: 4 px por unidad, 11 = 44 px). Se acepta
 * mas de 11 porque los dos `<textarea` ya llevan `min-h-20` (80 px) y exigir el literal `min-h-11`
 * obligaria a dejar las dos clases juntas. No se aceptan valores arbitrarios (`min-h-[...]`).
 */
function llevaAlturaMinima(clase: string, minimo = 11): boolean {
  return [...clase.matchAll(/(?<![:\w-])min-h-(\d+)(?![\w-])/g)].some((match) => Number(match[1]) >= minimo);
}

/** Cada etiqueta de apertura de los controles de formulario (`<input`, `<select`, `<textarea`, `<button`) de un cuerpo JSX, con su posicion. */
function etiquetasDeControl(jsx: string): Array<{ etiqueta: string; i: number }> {
  return [...jsx.matchAll(/<(?:input|select|textarea|button)\b/g)].map((match) => ({
    etiqueta: etiquetaJsxDesde(jsx, match.index ?? 0),
    i: match.index ?? 0
  }));
}

/** Nombre corto de un control para el mensaje de fallo: `<input Cliente>`, `<button Quitar>`, `<select zoneId>`. */
function rotuloDeControl(etiqueta: string, jsx: string, i: number): string {
  const nombre = etiqueta.match(/^<(\w+)/)?.[1] ?? "?";
  const pista =
    etiqueta.match(/\b(?:placeholder|aria-label)="([^"]*)"/)?.[1] ??
    etiqueta.match(/\bvalue=\{([^}]*)\}/)?.[1] ??
    jsx.slice(i + etiqueta.length).match(/^\s*([^\s<{][^<{\n]*)/)?.[1]?.trim() ??
    etiqueta.match(/\btype="([^"]*)"/)?.[1] ??
    "";
  return `<${nombre}${pista ? ` ${pista}` : ""}>`;
}

/** Cada `grid-cols-[...]` de `jsx` cuyo contenido, quitados los `minmax(0,...)`, todavia usa `fr`. */
function gridColsConFrSuelto(jsx: string): Array<{ clase: string; i: number }> {
  return [...jsx.matchAll(/grid-cols-\[([^\]]*)\]/g)]
    // `(?![A-Za-z])` y no `\b`: en `2fr_1fr` el `_` es caracter de palabra y `\b` no corta.
    .filter((match) => /\dfr(?![A-Za-z])/.test(match[1].replace(/minmax\(0,[^)]*\)/g, "")))
    .map((match) => ({ clase: match[0], i: match.index ?? 0 }));
}

/** Archivo del repo tal cual (para specs y planes en markdown, donde los comentarios no son codigo). */
function archivoDelRepo(relativeToRepo: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativeToRepo}`, import.meta.url)), "utf8");
}

describe("T6 — el formulario cabe: fila entera al desplegar, filas que se apilan, controles de 44 px (RF_01–RF_04, RNF_03, RNF_04)", () => {
  const panelPlegable = cuerpoDe(FUNCIONES_PANTALLA, "CollapsiblePanel");
  const parametrosPlegable = bloqueDesde(FUENTE_PANTALLA, "function CollapsiblePanel(");
  const [desestructuracionPlegable = "", tipoPlegable = ""] = bloquesDesde(parametrosPlegable, "{");
  const panelManual = cuerpoDe(FUNCIONES_PANTALLA, "ManualOrderPanel");

  /** La unica etiqueta `<CollapsiblePanel ... title="Crear pedido manual" ...>` del archivo y su `<div` contenedor. */
  const titulosManual = [...FUENTE_PANTALLA.matchAll(/title="Crear pedido manual"/g)].map((match) => match.index ?? 0);
  const inicioPanelManual = titulosManual.length > 0 ? FUENTE_PANTALLA.lastIndexOf("<CollapsiblePanel", titulosManual[0]) : -1;
  const etiquetaPanelManual = inicioPanelManual >= 0 ? etiquetaJsxDesde(FUENTE_PANTALLA, inicioPanelManual) : "";
  const inicioContenedor = inicioPanelManual >= 0 ? FUENTE_PANTALLA.lastIndexOf("<div", inicioPanelManual) : -1;
  const etiquetaContenedor = inicioContenedor >= 0 ? etiquetaJsxDesde(FUENTE_PANTALLA, inicioContenedor) : "";

  it("el extractor trae `CollapsiblePanel` (props y cuerpo), `ManualOrderPanel` y la fila de paneles de la tienda, y no se pasa de largo", () => {
    // Guarda del propio extractor: un cuerpo desbordado o unas props mal partidas pondrian en verde
    // lo de abajo con codigo que no es de estas piezas.
    expect(panelPlegable.includes("aria-expanded={open}"), "el cuerpo de `CollapsiblePanel` lleva el boton con `aria-expanded={open}`").toBe(true);
    expect(/function\s+Card\s*\(/.test(panelPlegable), "el cuerpo de `CollapsiblePanel` se desborda hasta `Card`: el recorte no es de fiar").toBe(false);
    expect(parametrosPlegable.length, "no se encuentra `function CollapsiblePanel(`").toBeGreaterThan(0);
    expect(/\bhideWhenEmpty\s*=\s*false\b/.test(desestructuracionPlegable), "la desestructuracion de props conserva `hideWhenEmpty = false`").toBe(true);
    expect(/\bhideWhenEmpty\?\s*:\s*boolean\b/.test(tipoPlegable), "el tipo de props conserva `hideWhenEmpty?: boolean`").toBe(true);

    expect(panelManual.includes("Crear pedido"), "el cuerpo de `ManualOrderPanel` llega hasta el boton 'Crear pedido'").toBe(true);
    expect(/function\s+SellerPickupPointsPanel\s*\(/.test(panelManual), "el cuerpo de `ManualOrderPanel` se desborda hasta `SellerPickupPointsPanel`").toBe(false);

    expect(titulosManual.length, "hay UNA sola etiqueta con `title=\"Crear pedido manual\"` en el archivo").toBe(1);
    expect(etiquetaPanelManual.startsWith("<CollapsiblePanel"), "la etiqueta extraida es un `<CollapsiblePanel`").toBe(true);
    expect(etiquetaPanelManual.includes('title="Crear pedido manual"'), "y es la del pedido manual (la etiqueta se cerro antes del titulo: el extractor no es de fiar)").toBe(true);
    expect(etiquetaContenedor.startsWith("<div"), "el contenedor inmediato del panel es un `<div`").toBe(true);
  });

  it("RF_02 · `CollapsiblePanel` declara la prop `spanWhenOpen` (en la desestructuracion y como `spanWhenOpen?: boolean` en el tipo)", () => {
    expect(
      /\bspanWhenOpen\b/.test(desestructuracionPlegable),
      "`CollapsiblePanel` no desestructura `spanWhenOpen` en sus props: el panel no tiene forma de pedir la fila entera"
    ).toBe(true);
    expect(
      /\bspanWhenOpen\?\s*:\s*boolean\b/.test(tipoPlegable),
      "el tipo de props de `CollapsiblePanel` no declara `spanWhenOpen?: boolean`"
    ).toBe(true);
  });

  it("RF_02 · la `<section>` de `CollapsiblePanel` lleva `lg:col-span-full` condicionado a `open && spanWhenOpen`, y conserva `aria-expanded={open}`", () => {
    // Positiva de control: el estado `open` sigue mandando en el boton de plegar.
    expect(panelPlegable.includes("aria-expanded={open}"), "`aria-expanded={open}` sigue en el boton del panel").toBe(true);
    const inicioSection = panelPlegable.indexOf("<section");
    expect(inicioSection, "`CollapsiblePanel` sigue pintando una `<section`").toBeGreaterThan(-1);
    const section = etiquetaJsxDesde(panelPlegable, inicioSection);
    const clase = claseDe(section);
    expect(
      clase.includes("lg:col-span-full"),
      "la `<section` de `CollapsiblePanel` no contiene `lg:col-span-full`: desplegado, el formulario sigue en un tercio de la fila"
    ).toBe(true);
    expect(
      /\bopen\s*&&\s*spanWhenOpen\b|\bspanWhenOpen\s*&&\s*open\b/.test(clase),
      "`lg:col-span-full` no depende de `open && spanWhenOpen` (RF_02: plegado vuelve a su tercio; solo lo pide quien activa la prop)"
    ).toBe(true);
  });

  it("RF_02 · el `<CollapsiblePanel title=\"Crear pedido manual\">` lleva `spanWhenOpen` y su contenedor sigue siendo `grid gap-3 lg:grid-cols-3`", () => {
    // Positiva de control: la fila de tres no se rompe para los otros dos paneles (plan §2.6).
    expect(
      claseDe(etiquetaContenedor),
      "el contenedor inmediato del panel ya no es `grid gap-3 lg:grid-cols-3`: la fila cambia para los tres paneles y no solo para el desplegado"
    ).toBe("grid gap-3 lg:grid-cols-3");
    expect(
      /\sspanWhenOpen(?:\s*=\s*\{\s*true\s*\})?(?=[\s/>])/.test(etiquetaPanelManual),
      `el panel "Crear pedido manual" (linea ${lineaDe(FUENTE_PANTALLA, inicioPanelManual)}) no lleva \`spanWhenOpen\`: desplegado no ocupa la fila entera`
    ).toBe(true);
  });

  it("RF_04 · cada `<input`, `<select`, `<textarea` y `<button` de `ManualOrderPanel` lleva `min-h-11` (44 px)", () => {
    const controles = etiquetasDeControl(panelManual);
    // Positiva de control: el formulario se leyo entero y tiene sus controles.
    expect(controles.length, "`ManualOrderPanel` tiene al menos 10 controles de formulario").toBeGreaterThanOrEqual(10);
    const bajos = controles
      .filter(({ etiqueta }) => !llevaAlturaMinima(claseDe(etiqueta)))
      .map(({ etiqueta, i }) => `linea ${lineaRealDe(panelManual, i)}: ${rotuloDeControl(etiqueta, panelManual, i)}`);
    expect(
      bajos,
      "controles de `ManualOrderPanel` sin `min-h-11` (o mayor) (RF_04: 44 px minimo; checklist del sistema de diseno)"
    ).toEqual([]);
  });

  it("RF_03 · en `ManualOrderPanel` ninguna `grid-cols-[...]` usa `fr` fuera de `minmax(0,...)` y no queda `w-20`", () => {
    // Positiva de control: el formulario sigue teniendo filas de varias columnas que adaptar.
    expect(/grid-cols-\[/.test(panelManual), "`ManualOrderPanel` sigue teniendo alguna `grid-cols-[...]`").toBe(true);
    const sueltos = gridColsConFrSuelto(panelManual).map(({ clase, i }) => `linea ${lineaRealDe(panelManual, i)}: \`${clase}\``);
    expect(
      sueltos,
      "columnas `fr` sin `minmax(0,...)`: su minimo es `auto` y el contenido las ensancha mas alla del panel (RF_03: en telefono se apilan, no desbordan)"
    ).toEqual([]);
    const anchoFijo = panelManual.match(utilidad("w-20"));
    expect(
      anchoFijo ? `linea ${lineaRealDe(panelManual, anchoFijo.index ?? 0)}: ${fragmentoAlrededor(panelManual, anchoFijo.index ?? 0)}` : "",
      "queda un `w-20` en `ManualOrderPanel`: la columna de cantidad ya mide 5rem, el ancho fijo sobra y desborda"
    ).toBe("");
  });

  it("RF_03 · la fila de producto es `sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_auto]` y sus `<input` llevan `w-full min-w-0`", () => {
    const filaProducto = bloqueDesde(panelManual, "lines.map(");
    // Positiva de control: el bloque extraido es la fila de producto entera.
    expect(filaProducto.includes('placeholder="Cant."'), "el bloque `lines.map(` contiene el input de cantidad").toBe(true);
    expect(filaProducto.includes("Quitar"), "y llega hasta el boton 'Quitar'").toBe(true);
    expect(
      filaProducto.includes("sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_auto]"),
      "la fila de producto no usa exactamente `sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_auto]` (plan §2.6)"
    ).toBe(true);
    const inputs = etiquetasDeControl(filaProducto).filter(({ etiqueta }) => etiqueta.startsWith("<input"));
    expect(inputs.length, "la fila de producto tiene tres `<input` (producto, SKU, cantidad)").toBe(3);
    const estrechos = inputs
      .filter(({ etiqueta }) => !(utilidad("w-full").test(claseDe(etiqueta)) && utilidad("min-w-0").test(claseDe(etiqueta))))
      .map(({ etiqueta, i }) => `linea ${lineaRealDe(panelManual, panelManual.indexOf(filaProducto) + i)}: ${rotuloDeControl(etiqueta, filaProducto, i)}`);
    expect(estrechos, "inputs de la fila de producto sin `w-full min-w-0`: no encogen con su columna y desbordan en telefono").toEqual([]);
  });

  it("RF_01, RNF_03 · el `<form` de `ManualOrderPanel` lleva `min-w-0`", () => {
    const inicioForm = panelManual.indexOf("<form");
    expect(inicioForm, "`ManualOrderPanel` sigue pintando un `<form`").toBeGreaterThan(-1);
    const form = etiquetaJsxDesde(panelManual, inicioForm);
    // Positiva de control: el formulario sigue siendo una rejilla.
    expect(utilidad("grid").test(claseDe(form)), "el `<form` conserva `grid`").toBe(true);
    expect(
      utilidad("min-w-0").test(claseDe(form)),
      `el \`<form\` (linea ${lineaRealDe(panelManual, inicioForm)}) no lleva \`min-w-0\`: un hijo de rejilla sin minimo cero se ensancha con su contenido y recorta el formulario (RF_01; checklist: \`min-w-0\` en contenedores con contenido variable)`
    ).toBe(true);
  });

  it("RNF_04 · declaracion: la medida real a 390 y 1280 px la hace `scripts/verify-013.js` (T7), referenciado en el plan", () => {
    // Estas guardas prueban CLASES, no pixeles. La unica excepcion al principio 4 es la medida con
    // Playwright que describe el plan (§2.6, DoD 2); aqui solo se deja atada desde la suite.
    const plan = archivoDelRepo("specs/013_plan.md");
    expect(plan.includes("verify-013.js"), "`specs/013_plan.md` no menciona `verify-013.js`: la medida de RF_01/RF_04 quedaria sin guion").toBe(true);
    expect(/scrollWidth\s*===\s*clientWidth/.test(plan), "el plan fija el criterio de 'sin recortar' como `scrollWidth === clientWidth`").toBe(true);
    expect(/height\s*>=\s*44/.test(plan), "el plan fija el criterio de 44 px como `height >= 44`").toBe(true);
  });
});

/*
 * =====================================================================================
 * T7 · RF_01, RF_02, RF_04, DoD 2 y 3 — `scripts/verify-013.js` mide de verdad y no toca nada
 * fuera de lo suyo.
 * =====================================================================================
 *
 * Como `verify-005.js` (T1 y T11 de la 005), el guion NO se ejecuta en la suite: crea cuentas y
 * pedidos REALES en produccion con el admin SDK y entra por REST. Lo lanza el orquestador, nunca un
 * subagente (plan §2.6). Lo unico que la suite puede sostener es su FORMA, leida sin comentarios.
 *
 * Mientras el guion no exista, cada `it` falla con un mensaje claro (`existsSync`), no con una
 * excepcion de `readFileSync`: asi el rojo dice "falta el guion" y no "ENOENT".
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA que fijan estas guardas (lo que el coder debe respetar):
 *
 * 1. Dispatcher con EXACTAMENTE tres pasos, `setup`, `capture` y `cleanup`, elegidos por
 *    `process.argv`. Dos formas validas: un mapa `const STEPS = { setup: stepSetup, capture: ...,
 *    cleanup: ... }` (el guion de la 005) o un `switch` con `case "setup":` etc. Sin `reproduce` ni
 *    `check`: aqui no hay hipotesis que refutar.
 * 2. Cada paso vive en una funcion local `<paso>`, `step<Paso>`, `run<Paso>`, `cmd<Paso>` o
 *    `<paso>Step`. Las guardas siguen las llamadas a funciones LOCALES, asi que un paso puede delegar
 *    en ayudantes; pero una funcion pasada por referencia (`page.evaluate(medir)`) NO se sigue: lo
 *    que mide dentro del navegador va inline o los literales quedan en el mismo archivo (se buscan en
 *    la fuente entera).
 * 3. Prefijo en una constante `const *PREFIX* = "smoke013-"`. Toda funcion local que llame a
 *    `createUser(` o nombre la coleccion `"orders"` menciona esa constante (construye el id con ella
 *    o lo comprueba con `.startsWith(PREFIX)` antes de escribir). Todo `.doc(` con literal o
 *    plantilla lleva el prefijo dentro.
 * 4. Evidencia: constantes `EVIDENCE_DIR` (raiz `.sdd/evidence/013`, como literal o como
 *    `path.join(REPO_ROOT, ".sdd", "evidence", "013")`) y `CAPTURE_DIR` colgando de ella. Cada
 *    `writeFileSync(` y cada `screenshot(` lleva `EVIDENCE_DIR`/`CAPTURE_DIR` en la misma linea o en
 *    los 200 caracteres anteriores: un `writeJson(filePath)` generico que reciba la ruta ya hecha
 *    NO pasa; la ruta se compone junto a la escritura.
 * 5. `capture` no escribe en Firestore ni en Auth: sin `.set(`, `.update(`, `.delete(`, `.add(`,
 *    `batch(`, `runTransaction(`, `createUser(`, `deleteUser(` en nada que alcance. Evitar
 *    `new Map().set(` y `array.add(`: la guarda no distingue un Map de un documento.
 * 6. Sin `createCustomToken` (ADC sin signBlob, CLAUDE.md) ni `firebase deploy`: entra con
 *    `signInWithPassword` (REST) como la cuenta desechable, y `page.goto` espera `networkidle`.
 * ---------------------------------------------------------------------------------------------
 */

const GUION_MEDIDA = "scripts/verify-013.js";
const PASOS_MEDIDA = ["setup", "capture", "cleanup"] as const;
const ESCRITURA_FIRESTORE = /\.(?:set|update|delete|add|create)\s*\(|\bbatch\s*\(|\brunTransaction\s*\(|\bcreateUser\s*\(|\bdeleteUser\s*\(/;
const BORRADO_FIRESTORE = /\.delete\s*\(|\bdeleteUser\s*\(|\brecursiveDelete\b/;
const RAIZ_EVIDENCIA_013 = /\.sdd\/evidence\/013\b|["']\.sdd["']\s*,\s*["']evidence["']\s*,\s*["']013["']/;
const RAIZ_EVIDENCIA_005 = /\.sdd\/evidence\/005\b|["']\.sdd["']\s*,\s*["']evidence["']\s*,\s*["']005["']/;

type GuionDeMedida = { existe: boolean; fuente: string; funciones: LocalFunctions };

/** El guion sin comentarios, o vacio si no existe: cada guarda afirma primero sobre `existe`. */
function guionDeMedida(): GuionDeMedida {
  const existe = existsSync(fileURLToPath(new URL(`../../${GUION_MEDIDA}`, import.meta.url)));
  if (!existe) return { existe, fuente: "", funciones: new Map() };
  const fuente = repoSourceWithoutComments(GUION_MEDIDA);
  return { existe, fuente, funciones: funcionesSeguras(fuente) };
}

/** Nombre y cuerpo de la funcion del paso (punto 2 del contrato), o `null`. */
function funcionDelPaso(paso: string, funciones: LocalFunctions): { nombre: string; cuerpo: string } | null {
  const cap = paso[0].toUpperCase() + paso.slice(1);
  for (const nombre of [paso, `step${cap}`, `run${cap}`, `cmd${cap}`, `${paso}Step`]) {
    const cuerpo = funciones.get(nombre);
    if (cuerpo !== undefined) return { nombre, cuerpo };
  }
  return null;
}

/** `texto` mas el cuerpo de toda funcion local que alcanza, transitivamente. */
function alcanceDe(texto: string, funciones: LocalFunctions, visitadas: Set<string>): string {
  let salida = texto;
  for (const nombre of funciones.keys()) {
    if (visitadas.has(nombre) || !callPattern(nombre).test(texto)) continue;
    visitadas.add(nombre);
    salida += `\n${alcanceDe(funciones.get(nombre) ?? "", funciones, visitadas)}`;
  }
  return salida;
}

/** Todo lo que alcanza el paso, incluidos sus ayudantes locales; "" si el paso no existe. */
function alcanceDelPaso(paso: string, guion: GuionDeMedida): string {
  const funcion = funcionDelPaso(paso, guion.funciones);
  return funcion ? alcanceDe(funcion.cuerpo, guion.funciones, new Set([funcion.nombre])) : "";
}

/**
 * Los pasos que el dispatcher acepta (punto 1 del contrato): las claves del objeto literal que
 * contiene `setup:`, o los `case "..."` del `switch`. Lista vacia si no hay dispatcher.
 */
function pasosDelDispatcher(fuente: string): string[] {
  const casos = [...fuente.matchAll(/\bcase\s+["']([A-Za-z_]+)["']\s*:/g)].map((m) => m[1]);
  if (casos.length > 0) return [...new Set(casos)];
  for (const match of fuente.matchAll(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{/g)) {
    const apertura = (match.index ?? 0) + match[0].length - 1;
    let objeto = "";
    try {
      objeto = fuente.slice(apertura, cierreSeguro(fuente, apertura) + 1);
    } catch {
      continue;
    }
    const claves = [...objeto.matchAll(/(?:^\{|[{,])\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
    if (claves.includes("setup")) return [...new Set(claves)];
  }
  return [];
}

/** `[nombre, valor]` de la constante `const *PREFIX* = "..."`, o `null`. */
function prefijoDesechable(fuente: string): [string, string] | null {
  const match = fuente.match(/\bconst\s+([A-Za-z_$][\w$]*PREFIX[\w$]*)\s*=\s*["']([^"']+)["']/i);
  return match ? [match[1], match[2]] : null;
}

/** Nombres de las funciones locales cuyo cuerpo cumple `patron`. */
function funcionesQueContienen(funciones: LocalFunctions, patron: RegExp): string[] {
  return [...funciones.entries()].filter(([, cuerpo]) => patron.test(cuerpo)).map(([nombre]) => nombre);
}

/**
 * Lineas de cada `llamada(` sin una constante de evidencia (`EVIDENCE_DIR`/`CAPTURE_DIR`) en la
 * misma linea ni en los 200 caracteres anteriores (punto 4 del contrato).
 */
function escriturasFueraDeLaEvidencia(fuente: string, llamada: RegExp): number[] {
  const lineas: number[] = [];
  for (const match of fuente.matchAll(new RegExp(llamada.source, "g"))) {
    const i = match.index ?? 0;
    const inicioLinea = fuente.lastIndexOf("\n", i) + 1;
    const finLinea = fuente.indexOf("\n", i);
    const ventana = fuente.slice(Math.min(inicioLinea, Math.max(0, i - 200)), finLinea < 0 ? fuente.length : finLinea);
    if (!/\b(?:EVIDENCE_DIR|CAPTURE_DIR)\b/.test(ventana)) lineas.push(lineaDe(fuente, i));
  }
  return lineas;
}

describe("T7 — scripts/verify-013.js mide de verdad y no toca nada fuera de lo suyo (RF_01, RF_02, RF_04, DoD 2 y 3)", () => {
  const guion = guionDeMedida();
  const FALTA_EL_GUION = `no existe ${GUION_MEDIDA}: T7 todavia no tiene guion de medida (plan §2.6, DoD 2)`;

  describe("forma del guion", () => {
    it("DoD 2 · existe, es CommonJS con firebase-admin de functions/node_modules y elige el paso por process.argv", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(
        /require\(\s*["']\.\.\/functions\/node_modules\/firebase-admin["']\s*\)/.test(guion.fuente),
        "no carga firebase-admin desde ../functions/node_modules (mismo esqueleto que verify-005.js)"
      ).toBe(true);
      expect(/initializeApp\(\s*\{\s*projectId\s*:\s*["']kentro-last-mile["']/.test(guion.fuente), "no inicializa contra el proyecto kentro-last-mile").toBe(true);
      expect(/process\.argv/.test(guion.fuente), "no lee el paso de process.argv").toBe(true);
    });

    it("DoD 2 · el dispatcher tiene exactamente los pasos setup, capture y cleanup (ni reproduce ni check)", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const pasos = pasosDelDispatcher(guion.fuente).sort();
      expect(pasos, "pasos del dispatcher (mapa `{ setup: ..., capture: ..., cleanup: ... }` o `case \"setup\":` etc.)").toEqual([...PASOS_MEDIDA].sort());
    });

    it.each(PASOS_MEDIDA)("DoD 2 · el paso `%s` tiene su funcion local (<paso>, step<Paso>, run<Paso>, cmd<Paso> o <paso>Step)", (paso) => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(funcionDelPaso(paso, guion.funciones) !== null, `no hay funcion local para el paso ${paso}`).toBe(true);
    });
  });

  describe("todo lo desechable lleva el prefijo smoke013-", () => {
    it("DoD 2 · hay una constante `const *PREFIX* = \"smoke013-\"` y setup la usa al crear cuenta, tienda y pedidos", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const prefijo = prefijoDesechable(guion.fuente);
      expect(prefijo?.[1] ?? "", "valor de la constante de prefijo `const *PREFIX* = \"...\"`").toBe("smoke013-");
      const alcance = alcanceDelPaso("setup", guion);
      // Positiva de control: setup CREA algo; un setup vacio cumpliria el prefijo sin crear nada.
      expect(/\bcreateUser\s*\(/.test(alcance), "setup no crea la cuenta desechable en Auth (createUser)").toBe(true);
      expect(/["']sellers["']/.test(alcance), "setup no crea la tienda desechable (coleccion sellers)").toBe(true);
      expect(/["']orders["']/.test(alcance), "setup no crea los pedidos desechables (coleccion orders)").toBe(true);
      expect(alcance.includes(prefijo?.[0] ?? " "), "setup no usa la constante de prefijo").toBe(true);
    });

    it("DoD 2 · toda funcion que llama a createUser( o escribe en orders menciona el prefijo, y todo .doc( con literal lo lleva", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const nombrePrefijo = prefijoDesechable(guion.fuente)?.[0] ?? " ";
      const creadoras = funcionesQueContienen(guion.funciones, /\bcreateUser\s*\(|["']orders["']/);
      // Positiva de control: hay funciones que crean.
      expect(creadoras.length, "ninguna funcion local llama a createUser( ni nombra orders").toBeGreaterThan(0);
      const sinPrefijo = creadoras.filter((nombre) => !cuerpoDe(guion.funciones, nombre).includes(nombrePrefijo));
      expect(sinPrefijo, "funciones que crean cuenta o pedidos sin mencionar la constante de prefijo (id construido con ella o `.startsWith(PREFIX)`)").toEqual([]);
      const docsSinPrefijo = [...guion.fuente.matchAll(/\.doc\(\s*([`"'][^)]*)\)/g)]
        .filter((m) => !m[1].includes("smoke013-") && !m[1].includes(nombrePrefijo))
        .map((m) => `linea ${lineaDe(guion.fuente, m.index ?? 0)}`);
      expect(docsSinPrefijo, ".doc( con literal o plantilla sin el prefijo smoke013-").toEqual([]);
    });

    it("DoD 2 · cleanup borra, comprueba el prefijo antes (.startsWith(PREFIX)) y no borra por consultas amplias", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const nombrePrefijo = prefijoDesechable(guion.fuente)?.[0] ?? " ";
      const alcance = alcanceDelPaso("cleanup", guion);
      // Positiva de control: cleanup alcanza una eliminacion de verdad.
      expect(BORRADO_FIRESTORE.test(alcance), "cleanup no alcanza ninguna eliminacion (.delete( / deleteUser()").toBe(true);
      expect(new RegExp(`\\.startsWith\\(\\s*${nombrePrefijo}\\s*\\)`).test(alcance), "cleanup no comprueba `.startsWith(PREFIX)` antes de borrar").toBe(true);
      expect(/\blistDocuments\s*\(|\brecursiveDelete\b/.test(alcance), "cleanup usa listDocuments/recursiveDelete (borrado amplio)").toBe(false);
      expect(/collection\(\s*["'][^"']+["']\s*\)\s*\.(?:get|stream|limit)\s*\(/.test(alcance), "cleanup lee una coleccion entera").toBe(false);
    });
  });

  describe("evidencia solo bajo .sdd/evidence/013", () => {
    it("DoD 2 · nombra .sdd/evidence/013 (EVIDENCE_DIR y CAPTURE_DIR) y nunca .sdd/evidence/005", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(RAIZ_EVIDENCIA_013.test(guion.fuente), "no nombra la raiz .sdd/evidence/013 (literal o path.join(..., \".sdd\", \"evidence\", \"013\"))").toBe(true);
      expect(/\bconst\s+EVIDENCE_DIR\s*=/.test(guion.fuente), "falta `const EVIDENCE_DIR = ...`").toBe(true);
      expect(/\bconst\s+CAPTURE_DIR\s*=\s*path\.join\(\s*EVIDENCE_DIR\b/.test(guion.fuente), "falta `const CAPTURE_DIR = path.join(EVIDENCE_DIR, ...)`").toBe(true);
      expect(RAIZ_EVIDENCIA_005.test(guion.fuente), "nombra .sdd/evidence/005: pisaria la evidencia de otra spec").toBe(false);
    });

    it("DoD 2 · cada writeFileSync( y cada screenshot( compone su ruta con EVIDENCE_DIR/CAPTURE_DIR (misma linea o 200 caracteres antes)", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      // Positiva de control: el guion escribe archivos y capturas; sin esto las negativas pasarian en vacio.
      expect(/\bwriteFileSync\s*\(/.test(guion.fuente), "el guion no escribe ningun archivo (writeFileSync)").toBe(true);
      expect(/\.screenshot\s*\(/.test(guion.fuente), "el guion no toma ninguna captura (.screenshot()").toBe(true);
      expect(escriturasFueraDeLaEvidencia(guion.fuente, /\bwriteFileSync\s*\(/), "lineas con writeFileSync( sin EVIDENCE_DIR/CAPTURE_DIR cerca").toEqual([]);
      expect(escriturasFueraDeLaEvidencia(guion.fuente, /\.screenshot\s*\(/), "lineas con .screenshot( sin CAPTURE_DIR cerca").toEqual([]);
    });
  });

  describe("capture: mide RF_01, RF_02 y RF_04 a dos anchos", () => {
    it("RF_01, RF_04 · fija el viewport a 390 y a 1280 px", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const alcance = alcanceDelPaso("capture", guion);
      expect(/\bsetViewportSize\s*\(/.test(alcance), "capture no alcanza setViewportSize(").toBe(true);
      expect(/\b390\b/.test(guion.fuente), "falta el ancho 390 (telefono)").toBe(true);
      expect(/\b1280\b/.test(guion.fuente), "falta el ancho 1280 (escritorio)").toBe(true);
    });

    it("RF_01 · mide que no hay desplazamiento horizontal: scrollWidth contra clientWidth del documento", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(/\bevaluate\s*\(/.test(alcanceDelPaso("capture", guion)), "capture no alcanza page.evaluate(").toBe(true);
      expect(/\bscrollWidth\b/.test(guion.fuente), "no lee scrollWidth").toBe(true);
      expect(/\bclientWidth\b/.test(guion.fuente), "no lee clientWidth").toBe(true);
      expect(/\bscrollWidth\b[^\n;]*\bclientWidth\b|\bclientWidth\b[^\n;]*\bscrollWidth\b/.test(guion.fuente), "no compara scrollWidth con clientWidth en la misma expresion").toBe(true);
    });

    it("RF_04 · mide cada control con getBoundingClientRect(): altura >= 44 y borde derecho <= innerWidth", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(/\bgetBoundingClientRect\s*\(/.test(guion.fuente), "no usa getBoundingClientRect(").toBe(true);
      expect(/\b44\b/.test(guion.fuente), "falta el umbral 44 (px)").toBe(true);
      expect(/\binnerWidth\b/.test(guion.fuente), "no compara con innerWidth").toBe(true);
    });

    it("DoD 2 · guarda medidas-movil.json y medidas-escritorio.json", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(guion.fuente.includes("medidas-movil.json"), "no escribe medidas-movil.json").toBe(true);
      expect(guion.fuente.includes("medidas-escritorio.json"), "no escribe medidas-escritorio.json").toBe(true);
    });

    it("RF_02 · despliega los dos paneles a la vez: 'Crear pedido manual' y 'Solicitudes de liquidacion'", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const alcance = alcanceDelPaso("capture", guion);
      expect(alcance.includes('"Crear pedido manual"'), "capture no pulsa el panel \"Crear pedido manual\"").toBe(true);
      expect(alcance.includes('"Solicitudes de liquidacion"'), "capture no pulsa el panel \"Solicitudes de liquidacion\"").toBe(true);
    });
  });

  describe("capture: la guia impresa de los dos pedidos (DoD 3)", () => {
    it("DoD 3 · pulsa 'Imprimir rotulo' y captura la ventana emergente con waitForEvent(\"page\")", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const alcance = alcanceDelPaso("capture", guion);
      expect(/waitForEvent\(\s*["']page["']\s*[,)]/.test(alcance), "capture no espera la ventana emergente con waitForEvent(\"page\")").toBe(true);
      expect(/Imprimir rotulo|Reimprimir rotulo/.test(alcance), "capture no pulsa \"Imprimir rotulo\" (o \"Reimprimir rotulo\")").toBe(true);
    });

    it("DoD 3 · comprueba en el texto de la emergente los tres rotulos: Direccion, Correccion o nota, Indicaciones", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const alcance = alcanceDelPaso("capture", guion);
      const faltan = ["Direccion", "Correccion o nota", "Indicaciones"].filter((rotulo) => !alcance.includes(rotulo));
      expect(faltan, "rotulos de la guia que capture no comprueba").toEqual([]);
    });
  });

  describe("setup: los dos pedidos de ejemplo", () => {
    it("DoD 3 · uno 'viejo' con la observacion en normalizedAddress (timbre azul) y otro con deliveryNotes", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const alcance = alcanceDelPaso("setup", guion);
      expect(/\bnormalizedAddress\s*:/.test(alcance), "setup no escribe normalizedAddress: en el pedido viejo").toBe(true);
      expect(alcance.includes("timbre azul"), "el pedido viejo no lleva la observacion 'timbre azul'").toBe(true);
      expect(/\bdeliveryNotes\s*:/.test(alcance), "setup no escribe deliveryNotes: en el pedido nuevo").toBe(true);
    });
  });

  describe("seguridad: entra por REST, capture no escribe, nada se despliega", () => {
    it("DoD 2 · entra con signInWithPassword (REST); sin createCustomToken ni firebase deploy", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(guion.fuente.includes("signInWithPassword"), "no entra con signInWithPassword").toBe(true);
      expect(guion.fuente.includes("createCustomToken"), "usa createCustomToken (no funciona con ADC, CLAUDE.md)").toBe(false);
      expect(/firebase\s+deploy/.test(guion.fuente), "contiene `firebase deploy`").toBe(false);
    });

    it("DoD 2 · capture no escribe en Firestore ni en Auth (.set( .update( .delete( .add( lotes, createUser)", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      const alcance = alcanceDelPaso("capture", guion);
      // Positiva de control emparejada: el recorte no esta vacio y alcanza el navegador.
      expect(/\bsetViewportSize\s*\(/.test(alcance), "el cuerpo alcanzado por capture no llega al navegador (setViewportSize)").toBe(true);
      const escritura = alcance.match(ESCRITURA_FIRESTORE);
      expect(escritura ? `linea ${lineaDe(alcance, escritura.index ?? 0)} del alcance: \`${escritura[0]}\`` : "", "capture alcanza una escritura").toBe("");
    });

    it("DoD 2 · el login espera networkidle antes de rellenar (leccion de la 005: rellenar antes de hidratar falla)", () => {
      expect(guion.existe, FALTA_EL_GUION).toBe(true);
      expect(alcanceDelPaso("capture", guion).includes("networkidle"), "capture no espera networkidle").toBe(true);
    });
  });
});
