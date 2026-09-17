/**
 * Code128 subset B: codificacion + render a SVG (string).
 *
 * Por que un encoder propio y no jsbarcode/bwip-js: el rotulo se arma como un string de HTML que se
 * inyecta con `popup.document.write` (ver `printOrderLabels`), y esas librerias pintan sobre un nodo
 * del DOM o un canvas — habria que crear elementos sueltos y serializarlos. Aqui la salida ya es el
 * string que hace falta, y ademas se controla el ancho de modulo en milimetros, que es lo que decide
 * si la pistola lee o no sobre papel termico.
 *
 * Subset B cubre ASCII 32..126, o sea letras, digitos y el guion de los codigos `KNT-003259`.
 */

/** Anchos de barra/espacio de cada simbolo Code128, en modulos. Indice = valor del simbolo. */
export const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112"
];

const START_B = 104;
const STOP = 106;

/** Primer y ultimo caracter que admite el subset B. */
const MIN_CHAR_CODE = 32;
const MAX_CHAR_CODE = 126;

/** Valores de simbolo de `value` en subset B. Lanza si algun caracter no es codificable. */
export function code128BSymbols(value: string): number[] {
  if (!value) throw new Error("Code128: el valor esta vacio.");
  const data = [...value].map((char) => {
    const charCode = char.charCodeAt(0);
    if (char.length !== 1 || charCode < MIN_CHAR_CODE || charCode > MAX_CHAR_CODE) {
      throw new Error(`Code128: caracter no codificable en subset B: ${JSON.stringify(char)}.`);
    }
    return charCode - MIN_CHAR_CODE;
  });
  const checksum = data.reduce((total, symbol, index) => total + symbol * (index + 1), START_B) % 103;
  return [START_B, ...data, checksum, STOP];
}

/**
 * Anchos en modulos de la secuencia completa, alternando barra/espacio y empezando por barra
 * (indice par = barra). No incluye zonas mudas: eso lo agrega el render.
 */
export function encodeCode128B(value: string): number[] {
  return code128BSymbols(value)
    .flatMap((symbol) => [...CODE128_PATTERNS[symbol]].map((width) => Number(width)));
}

export type Code128SvgOptions = {
  /** Ancho del modulo mas fino, en mm. 0.5mm = 4 puntos en una termica de 203dpi. */
  moduleMm?: number;
  /** Alto de las barras, en mm. */
  heightMm?: number;
  /** Zona muda a cada lado, en modulos. El estandar pide 10 como minimo. */
  quietModules?: number;
};

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** SVG (string) del codigo de barras, listo para inyectar en el HTML del rotulo. */
export function renderCode128Svg(value: string, options: Code128SvgOptions = {}): string {
  const moduleMm = options.moduleMm ?? 0.5;
  const heightMm = options.heightMm ?? 13;
  const quietModules = options.quietModules ?? 10;
  const widths = encodeCode128B(value);
  const symbolModules = widths.reduce((total, width) => total + width, 0);
  const totalModules = symbolModules + quietModules * 2;
  const heightModules = heightMm / moduleMm;

  const bars: string[] = [];
  let cursor = quietModules;
  widths.forEach((width, index) => {
    if (index % 2 === 0) bars.push(`<rect x="${cursor}" y="0" width="${width}" height="${heightModules}" />`);
    cursor += width;
  });

  const widthMm = totalModules * moduleMm;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(value)}"`,
    ` width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${totalModules} ${heightModules}"`,
    ` preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">`,
    bars.join(""),
    `</svg>`
  ].join("");
}
