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

describe("T2 · query-check: consultas, indices y coste de los dos modos", () => {
  /*
   * T2 (plan 4.3, 5.4, 7): `query-check` lanza cada consulta del cargador con `limit(1)` para que
   * Firestore diga si pide indice, y cronometra la carga completa de los dos modos (resumen e
   * `includeReconciliation`). Las cifras van a `t2-query-check.txt` y de ahi a `docs/rendimiento.md`:
   * evidencia, no estimaciones. Si hace falta un indice se ANADE; ninguno de HEAD puede desaparecer.
   */
  const SCRIPT = "scripts/verify-026.js";
  const EVIDENCE = ".sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t2-query-check.txt";
  const DOC = "docs/rendimiento.md";
  const INDEXES = "firestore.indexes.json";
  const source = () => sourceWithoutComments(SCRIPT);

  /*
   * Cuerpo de la funcion que COMMANDS registra como "query-check". `baseline` (T1) ya cronometra y
   * cita umbrales, asi que buscar en todo el script daria verde sin que query-check exista.
   */
  function queryCheckBody(): string {
    const src = source();
    const name = src.match(/["']query-check["']\s*:\s*([A-Za-z_$][\w$]*)/)?.[1];
    if (!name) return "";
    const start = src.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m"));
    if (start < 0) return "";
    const end = src.indexOf("\n}\n", start);
    return end < 0 ? src.slice(start) : src.slice(start, end + 2);
  }

  function spec026Section(): string {
    const doc = readFileSync(absolute(DOC), "utf8");
    const start = doc.search(/^##+ .*Spec 026/m);
    if (start < 0) return "";
    const rest = doc.slice(start);
    const next = rest.slice(1).search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }

  it("verify-026 registra el subcomando query-check", () => {
    expect(source()).toMatch(/["']query-check["']\s*:/);
  });

  it("query-check lanza las consultas con limit(1)", () => {
    expect(source()).toMatch(/\.limit\(\s*1\s*\)/);
  });

  it("query-check mide los dos modos: resumen e includeReconciliation", () => {
    expect(queryCheckBody()).toMatch(/includeReconciliation/);
    expect(queryCheckBody()).toMatch(/resumen/i);
    expect(queryCheckBody()).toMatch(/conciliaci/i);
  });

  it("query-check cronometra cada carga (ms)", () => {
    expect(queryCheckBody()).toMatch(/performance\.now\(|process\.hrtime|Date\.now\(/);
    expect(queryCheckBody()).toMatch(/\bms\b/);
  });

  it("query-check contrasta con los umbrales de la compuerta 5.4 (20.000 / 30.000 docs, 3 s)", () => {
    expect(queryCheckBody()).toMatch(/20_?000/);
    expect(queryCheckBody()).toMatch(/30_?000/);
    expect(queryCheckBody()).toMatch(/3_?000\b|\b3\s*s\b/);
  });

  it("query-check escribe la evidencia t2-query-check.txt", () => {
    expect(queryCheckBody()).toContain("t2-query-check.txt");
  });

  it("la evidencia t2-query-check.txt existe", () => {
    expect(existsSync(absolute(EVIDENCE))).toBe(true);
  });

  it("la evidencia trae docs y ms de los dos modos", () => {
    const evidence = existsSync(absolute(EVIDENCE)) ? readFileSync(absolute(EVIDENCE), "utf8") : "";
    expect(evidence).toMatch(/resumen/i);
    expect(evidence).toMatch(/conciliaci/i);
    expect(evidence).toMatch(/\d[\d.]*\s*docs/i);
    expect(evidence).toMatch(/\d[\d.]*\s*ms/i);
  });

  it("docs/rendimiento.md tiene la seccion Spec 026", () => {
    expect(spec026Section()).not.toBe("");
  });

  it("la seccion Spec 026 documenta docs y ms de resumen y de conciliacion", () => {
    const section = spec026Section();
    expect(section).toMatch(/resumen/i);
    expect(section).toMatch(/conciliaci/i);
    expect(section).toMatch(/\d[\d.]*\s*docs/i);
    expect(section).toMatch(/\d[\d.]*\s*ms/i);
  });

  it("la seccion Spec 026 cita la evidencia de la que salen las cifras", () => {
    expect(spec026Section()).toContain("t2-query-check.txt");
  });

  it("firestore.indexes.json conserva todo indice y override de HEAD (solo se anade)", async () => {
    const { execSync } = await import("node:child_process");
    const head = JSON.parse(execSync(`git show HEAD:${INDEXES}`, { cwd: absolute(""), encoding: "utf8" }));
    const now = JSON.parse(readFileSync(absolute(INDEXES), "utf8"));
    const keys = (list: unknown[] | undefined) => new Set((list ?? []).map((entry) => JSON.stringify(entry)));
    const nowIndexes = keys(now.indexes);
    const nowOverrides = keys(now.fieldOverrides);
    const missing = [
      ...(head.indexes ?? []).filter((entry: unknown) => !nowIndexes.has(JSON.stringify(entry))),
      ...(head.fieldOverrides ?? []).filter((entry: unknown) => !nowOverrides.has(JSON.stringify(entry))),
    ];
    expect(missing).toEqual([]);
  });
});
