import { describe, expect, it } from "vitest";
import { CODE128_PATTERNS, code128BSymbols, encodeCode128B, renderCode128Svg } from "./barcode";

const STOP_PATTERN = "2331112";

/** Decodifica los anchos de vuelta a valores de simbolo, sin usar la logica del encoder. */
function decodeSymbols(widths: number[]) {
  const stop = widths.slice(-STOP_PATTERN.length).join("");
  expect(stop).toBe(STOP_PATTERN);
  const body = widths.slice(0, -STOP_PATTERN.length);
  expect(body.length % 6).toBe(0);
  const symbols: number[] = [];
  for (let index = 0; index < body.length; index += 6) {
    const pattern = body.slice(index, index + 6).join("");
    const value = CODE128_PATTERNS.indexOf(pattern);
    expect(value, `patron desconocido ${pattern}`).toBeGreaterThanOrEqual(0);
    symbols.push(value);
  }
  return symbols;
}

/** Reconstruye el texto original, verificando start y checksum por separado. */
function decodeCode128B(widths: number[]) {
  const symbols = decodeSymbols(widths);
  expect(symbols[0]).toBe(104);
  const data = symbols.slice(1, -1);
  const checksum = symbols[symbols.length - 1];
  const expectedChecksum = data.reduce((total, symbol, index) => total + symbol * (index + 1), 104) % 103;
  expect(checksum).toBe(expectedChecksum);
  return data.map((symbol) => String.fromCharCode(symbol + 32)).join("");
}

describe("tabla Code128", () => {
  it("tiene 107 patrones unicos", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it("todos los simbolos miden 11 modulos salvo el stop, que mide 13", () => {
    const moduleCount = (pattern: string) => [...pattern].reduce((total, digit) => total + Number(digit), 0);
    for (const pattern of CODE128_PATTERNS.slice(0, 106)) {
      expect(pattern).toHaveLength(6);
      expect(moduleCount(pattern)).toBe(11);
    }
    expect(CODE128_PATTERNS[106]).toBe(STOP_PATTERN);
    expect(moduleCount(STOP_PATTERN)).toBe(13);
  });

  it("no usa anchos fuera del rango 1..4", () => {
    for (const pattern of CODE128_PATTERNS) {
      for (const digit of pattern) expect(Number(digit)).toBeGreaterThanOrEqual(1);
      for (const digit of pattern) expect(Number(digit)).toBeLessThanOrEqual(4);
    }
  });
});

describe("code128BSymbols", () => {
  it("calcula el checksum de un caso a mano", () => {
    // "A" -> valor 33; checksum = (104 + 33 * 1) % 103 = 34
    expect(code128BSymbols("A")).toEqual([104, 33, 34, 106]);
  });

  it("pondera cada caracter por su posicion", () => {
    // "KNT-003259": K=43 N=46 T=52 -=13 0=16 0=16 3=19 2=18 5=21 9=25
    const data = [43, 46, 52, 13, 16, 16, 19, 18, 21, 25];
    const checksum = data.reduce((total, symbol, index) => total + symbol * (index + 1), 104) % 103;
    expect(code128BSymbols("KNT-003259")).toEqual([104, ...data, checksum, 106]);
  });

  it("rechaza caracteres fuera del subset B", () => {
    expect(() => code128BSymbols("KNTÑ")).toThrow(/subset B/);
    expect(() => code128BSymbols("KNT\n")).toThrow(/subset B/);
    expect(() => code128BSymbols("")).toThrow(/vacio/);
  });
});

describe("encodeCode128B", () => {
  it("hace round-trip de los codigos de pedido", () => {
    for (const code of ["KNT-003259", "KNT-000001", "A", "1234567890", "#1042-shopify"]) {
      expect(decodeCode128B(encodeCode128B(code))).toBe(code);
    }
  });

  it("usa 11 * (n + 2) + 13 modulos", () => {
    const code = "KNT-003259";
    const total = encodeCode128B(code).reduce((sum, width) => sum + width, 0);
    expect(total).toBe(11 * (code.length + 2) + 13);
    expect(total).toBe(145);
  });

  it("empieza y termina en barra", () => {
    const widths = encodeCode128B("KNT-003259");
    expect(widths.length % 2).toBe(1);
    expect(CODE128_PATTERNS[104].startsWith(String(widths[0]))).toBe(true);
  });
});

describe("renderCode128Svg", () => {
  const svg = renderCode128Svg("KNT-003259");

  it("cabe en el ancho util del rotulo de 100mm", () => {
    // 145 modulos + 2 zonas mudas de 10, a 0.5mm = 82.5mm; el util del rotulo son ~87mm.
    expect(svg).toContain('width="82.5mm"');
    expect(svg).toContain('height="13mm"');
    expect(svg).toContain('viewBox="0 0 165 26"');
  });

  it("deja zona muda a ambos lados", () => {
    const positions = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="(\d+)"/g)]
      .map((match) => ({ x: Number(match[1]), width: Number(match[2]) }));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0].x).toBe(10);
    const last = positions[positions.length - 1];
    expect(165 - (last.x + last.width)).toBe(10);
  });

  it("escapa el valor del aria-label para poder inyectarlo en HTML crudo", () => {
    const quoted = renderCode128Svg('A"B');
    const label = quoted.match(/aria-label="([^"]*)"/)?.[1];
    expect(label).toBe("A&quot;B");
  });

  it("respeta las opciones de tamano", () => {
    const wide = renderCode128Svg("A", { moduleMm: 1, heightMm: 20, quietModules: 0 });
    expect(wide).toContain('width="46mm"'); // 11 * (1 + 2) + 13 = 46 modulos, sin zona muda
    expect(wide).toContain('height="20mm"');
    expect(wide).toContain('<rect x="0"');
  });

  it("propaga el error si el valor no es codificable", () => {
    expect(() => renderCode128Svg("KNTÑ")).toThrow(/subset B/);
  });
});
