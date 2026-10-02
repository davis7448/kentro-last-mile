/**
 * Guardas de fuente de la spec 026 — `specs/026_efectivo_que_no_llega_a_un_corte.md`.
 *
 * Un bloque `describe("T<n> · ...")` por tarea (plan 5.2). No editar los bloques de otra tarea.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function absolute(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

function sourceWithoutComments(relativePath: string): string {
  const raw = readFileSync(absolute(relativePath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("T1 · verify-026 es de solo lectura", () => {
  /*
   * `scripts/verify-026.js` corre contra produccion y lo lanza una persona; la suite no lo ejecuta.
   * Esta guarda es su unica comprobacion automatica: que no pueda escribir nada y que el modo
   * `baseline` deje las dos evidencias que T7 y T18 necesitan (plan 5.3, 5.4).
   */
  const SCRIPT = "scripts/verify-026.js";
  const source = () => sourceWithoutComments(SCRIPT);

  it("el script existe", () => {
    expect(existsSync(absolute(SCRIPT))).toBe(true);
  });

  it.each([".set(", ".update(", ".delete(", ".create(", "batch(", "runTransaction("])(
    "no contiene ninguna escritura a Firestore: %s",
    (writeCall) => {
      expect(source()).not.toContain(writeCall);
    }
  );

  it("usa firebase-admin de functions/node_modules contra kentro-last-mile", () => {
    expect(source()).toMatch(/require\([^)]*functions\/node_modules\/firebase-admin["']\)?\)/);
    expect(source()).toMatch(/projectId:\s*["']kentro-last-mile["']/);
  });

  it("tiene el subcomando baseline", () => {
    expect(source()).toMatch(/["']baseline["']/);
  });

  it("baseline escribe las dos evidencias de T1", () => {
    expect(source()).toContain("t1-linea-base.txt");
    expect(source()).toContain("t1-linea-base-ids.json");
    expect(source()).toContain("026_efectivo_que_no_llega_a_un_corte");
  });

  it("el archivo de ids lleva over30Days, coveredByNetting y rows (hallazgo D)", () => {
    expect(source()).toMatch(/over30Days/);
    expect(source()).toMatch(/coveredByNetting/);
    expect(source()).toMatch(/\brows\b/);
  });

  it("mide los cortes de domiciliario sin cashPendingCop y con pendiente distinto del recalculado (hallazgo B)", () => {
    expect(source()).toMatch(/cashPendingCop/);
    expect(source()).toMatch(/computeDriverCashSummary/);
  });

  it("contrasta la compensacion con la cifra de referencia 29 / 36 / $1.151.997 (compuerta 5.4)", () => {
    expect(source()).toMatch(/\b29\b/);
    expect(source()).toMatch(/\b36\b/);
    expect(source()).toMatch(/1_?151_?997/);
  });

  it("mide la antiguedad por updatedAt para la compuerta de >30 dias", () => {
    expect(source()).toMatch(/updatedAt/);
    expect(source()).toMatch(/\b30\b/);
  });
});
