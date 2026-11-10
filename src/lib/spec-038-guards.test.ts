/**
 * Guardas de fuente de la spec 038 — `specs/038_cada_recaudo_se_cobra_una_vez.md` (T23; RF_05b, RF_09, RF_12).
 *
 * La 038 existe porque habia DOS sitios que decidian cuanto efectivo debia un domiciliario, y uno cobraba dos
 * veces lo que el otro ya habia cobrado. Estas guardas impiden que vuelva a haber una segunda copia:
 *
 * 1. Fuera de `functions/src/driver-cash-ledger.ts`, ningun codigo de produccion mezcla el recaudo de tienda
 *    (`cod_revenue`/`cod_remittance`) con el pago del domiciliario (`driver_earning`) salvo los archivos de la
 *    lista blanca, cada uno con su motivo. Un archivo nuevo que los mezcle falla aqui hasta que alguien decida.
 * 2. La regla vieja (`computeDriverCashSummary`) no existe ni se llama en ninguna parte del codigo vivo.
 * 3. Todo llamador de `buildCodReceivedSet` / `codPartialReceivedCop` (codigo, scripts y el script de medicion)
 *    le pasa el recaudo por pedido. Sin el, un pedido de un corte nuevo nunca sale recibido.
 * 4. El script de medicion y los de la foto y la compensacion usan el modulo compilado, no una copia.
 *
 * Los scripts one-off viejos (`scripts/correct-*.js`, `clawback-*.js`, `fix-*.js`, `audit-*.js`, ...) quedan
 * fuera de 1 a proposito: son historicos, los sustituyo `correctOrderStatus` y no deciden ningun corte nuevo.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");
/** Sin comentarios: una mencion en un comentario no es codigo. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Codigo de produccion: lo que corre en el servidor o en la app. */
function productionFiles(): string[] {
  const list = (dir: string, pattern: RegExp) =>
    readdirSync(resolve(ROOT, dir))
      .filter((name) => pattern.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => `${dir}/${name}`);
  return [
    ...list("functions/src", /\.ts$/),
    ...list("src/lib", /\.ts$/),
    ...list("src/lib/firebase", /\.ts$/),
    ...list("src/components", /\.tsx?$/)
  ];
}

const MIXES_COD_AND_DRIVER_PAY_ALLOWED: Record<string, string> = {
  "functions/src/driver-cash-ledger.ts": "ES la regla: lo que cobra cada corte de domiciliario.",
  "functions/src/driver-receivable.ts": "Posicion de plataforma (por cobrar a la flota, spec 026); no fija la cifra de ningun corte.",
  "functions/src/cash-outstanding-api.ts": "Solo lee: consultas de los asientos que necesita el informe de la 026.",
  "functions/src/order-corrections-plan.ts": "Reescribe los asientos de un pedido corregido; el corte lo recalcula computeDriverCorteSummary.",
  "functions/src/settlement-math.ts": "Tipos de asiento y totales de tienda/proveedor/lider; la rama de domiciliario se retiro en la T22.",
  "functions/src/wallet-entries.ts": "Crea los asientos al cerrar un pedido (cuanta plata genera); no decide cortes.",
  "functions/src/seller-ledger.ts": "Solo nombra driver_earning en un comentario sobre los tipos de tienda.",
  "src/lib/types.ts": "Union de tipos de asiento.",
  "src/lib/seed.ts": "Datos de ejemplo del modo local.",
  "src/lib/order-export.ts": "Rotulos del Excel de la wallet.",
  "src/lib/finance.ts":
    "Pinta los cortes VIEJOS como hoy (los nuevos leen lo guardado, T17) y la posicion del cliente; no escribe ningun corte.",
  "src/components/operations-app.tsx":
    "Rotulos y la previsualizacion del admin antes de cerrar (buildLiquidationOrderAudits); el corte lo calcula el servidor. Pendiente aparte: que esa previsualizacion use la regla nueva."
};

describe("spec 038 · T23 · una sola regla para el efectivo de un corte", () => {
  it("fuera de la lista blanca ningun archivo de produccion mezcla recaudo de tienda con pago del domiciliario", () => {
    const offenders = productionFiles().filter((file) => {
      const source = code(file);
      return /["']cod_(revenue|remittance)["']/.test(source) && /["']driver_earning["']/.test(source) && !(file in MIXES_COD_AND_DRIVER_PAY_ALLOWED);
    });
    expect(offenders).toEqual([]);
  });

  it("la lista blanca no tiene entradas muertas (cada archivo existe y de verdad los mezcla, o se quita)", () => {
    const files = new Set(productionFiles());
    const stale = Object.keys(MIXES_COD_AND_DRIVER_PAY_ALLOWED).filter((file) => {
      if (!files.has(file)) return true;
      const source = read(file);
      return !(/["']?cod_(revenue|remittance)["']?/.test(source) && /driver_earning/.test(source));
    });
    expect(stale).toEqual([]);
  });

  it("la regla vieja no existe: settlement-math no la exporta y nadie la llama", () => {
    expect(code("functions/src/settlement-math.ts")).not.toMatch(/function\s+computeDriverCashSummary\b/);
    const callers = [...productionFiles(), "scripts/verify-026.js", "scripts/verify-027.js", "specs/038_measure.js", "scripts/snapshot-038-baseline.js", "scripts/compensate-038.js"]
      .filter((file) => /\bcomputeDriverCashSummary\s*\(/.test(code(file)));
    expect(callers).toEqual([]);
  });

  it("settlementTotals ya no calcula cortes de domiciliario", () => {
    const source = code("functions/src/settlement-math.ts");
    const body = source.slice(source.indexOf("export function settlementTotals("));
    expect(body).toMatch(/throw new Error\([^)]*buildDriverSettlementFields/);
    expect(body.slice(0, body.indexOf("\n}\n"))).not.toMatch(/kind === "driver" \?/);
  });
});

/** Las llamadas `name(...)` de un fuente, con los parentesis balanceados. */
function callsOf(source: string, name: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`\\b${name}\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s+$/.test(before)) continue; // la definicion
    let depth = 0;
    let index = match.index + name.length;
    const start = index + 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      if (source[index] === ")") depth -= 1;
      if (depth === 0) break;
    }
    calls.push(source.slice(start, index));
  }
  return calls;
}

/** ¿La lista de argumentos tiene una coma al nivel superior? (dos argumentos o mas). */
function hasSecondArgument(args: string): boolean {
  let depth = 0;
  for (const char of args) {
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) return true;
  }
  return false;
}

describe("spec 038 · T23 · todo llamador de recibido pasa el recaudo por pedido (RF_11)", () => {
  const files = [...productionFiles(), "scripts/verify-026.js", "scripts/verify-027.js", "specs/038_measure.js"];

  it("buildCodReceivedSet y codPartialReceivedCop siempre con su segundo argumento", () => {
    const bare = files.flatMap((file) =>
      ["buildCodReceivedSet", "codPartialReceivedCop"].flatMap((name) =>
        callsOf(code(file), name)
          .filter((args) => !hasSecondArgument(args))
          .map((args) => `${file}: ${name}(${args})`)
      )
    );
    expect(bare).toEqual([]);
  });

  it("el detector de llamadas encuentra las de verdad (no pasa en blanco por un fallo del propio detector)", () => {
    expect(callsOf("const a = buildCodReceivedSet(xs, f(y));", "buildCodReceivedSet")).toEqual(["xs, f(y)"]);
    expect(hasSecondArgument("xs, f(y)")).toBe(true);
    expect(hasSecondArgument("xs.map((s) => g(s, 1))")).toBe(false);
    expect(callsOf("export function buildCodReceivedSet(settlements: X[]) {}", "buildCodReceivedSet")).toEqual([]);
    expect(files.reduce((total, file) => total + callsOf(code(file), "buildCodReceivedSet").length, 0)).toBeGreaterThanOrEqual(10);
  });
});

describe("spec 038 · T23 · los scripts usan el modulo compilado (RF_05b)", () => {
  it("la medicion importa la regla de functions/lib y no lleva su copia de la reconstruccion", () => {
    const source = code("specs/038_measure.js");
    expect(source).toMatch(/requireLib\("driver-cash-ledger\.js"\)/);
    expect(source).toMatch(/\brebuildHistoricalCharges\(/);
    expect(source).toMatch(/\borderOwedByDriver\(/);
    // La copia vieja reconstruia a mano con min(0, ...) y su propio `lastComputedAt`.
    expect(source).not.toMatch(/function\s+lastComputedAt\b/);
    expect(source).not.toMatch(/Math\.min\(0,\s*rebuilt\)/);
  });

  it("la regla vieja de la medicion es solo una referencia rotulada para comparar (RNF_01)", () => {
    const raw = read("specs/038_measure.js");
    expect(raw).toMatch(/REGLA VIEJA, SOLO COMO REFERENCIA DE COMPARACION/);
    expect((code("specs/038_measure.js").match(/\blegacyExpectedCop\(/g) ?? []).length).toBe(3); // definicion + 2 usos en --deploy-check
  });

  it("la foto y la compensacion cargan la regla de functions/lib", () => {
    expect(code("scripts/snapshot-038-baseline.js")).toMatch(/functions\/lib\/driver-cash-ledger\.js/);
    expect(code("scripts/snapshot-038-baseline.js")).toMatch(/buildDriverLedgerSnapshot\(/);
    expect(code("scripts/compensate-038.js")).toMatch(/functions\/lib\/driver-cash-ledger\.js/);
    expect(code("scripts/compensate-038.js")).toMatch(/planDriverCompensation\(/);
  });
});
