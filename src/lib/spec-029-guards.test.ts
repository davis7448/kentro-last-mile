/**
 * Guardas de fuente de la spec 029 — `specs/029_store_api_confirma_y_corrige_pedidos.md`.
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

/** Cuerpo de una funcion de primer nivel (`function name(` o `async function name(`) hasta su `}` de columna 0. */
function topLevelFunctionBody(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m"));
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end + 2);
}

const WRITE_CALLS = [".set(", ".update(", ".delete(", ".create(", "batch(", "runTransaction("];

describe("T1 · verify-029 baseline es de solo lectura", () => {
  /*
   * `scripts/verify-029.js` corre contra produccion y lo lanza una persona; la suite no lo ejecuta.
   * Contrato (T1): el guion declara `const WRITE_MODES = [...]` con los nombres de los modos que escriben
   * (T25 `kovia-replay`, T27 `set-history-since`/`run-all`/`cleanup`). `baseline` nunca esta en esa lista ni
   * su cuerpo (`async function baseline(`) escribe. Mientras la lista este vacia, como en T1, el fuente no
   * contiene ninguna llamada de escritura a Firestore.
   */
  const SCRIPT = "scripts/verify-029.js";
  const EVIDENCE = ".sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t1-linea-base.txt";
  const source = () => sourceWithoutComments(SCRIPT);
  const declaredWriteModes = (): string[] | null => {
    const match = source().match(/const\s+WRITE_MODES\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/);
    if (!match) return null;
    return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
  };

  it("el script existe", () => {
    expect(existsSync(absolute(SCRIPT))).toBe(true);
  });

  it("usa firebase-admin de functions/node_modules contra kentro-last-mile", () => {
    expect(source()).toMatch(/require\([^)]*functions\/node_modules\/firebase-admin["']\)?\)/);
    expect(source()).toMatch(/projectId:\s*["']kentro-last-mile["']/);
  });

  it("tiene el subcomando baseline, implementado en `async function baseline(`", () => {
    expect(source()).toMatch(/["']baseline["']/);
    expect(topLevelFunctionBody(source(), "baseline")).not.toBeNull();
  });

  it("declara WRITE_MODES y baseline no esta entre ellos", () => {
    const modes = declaredWriteModes();
    expect(modes).not.toBeNull();
    expect(modes).not.toContain("baseline");
  });

  it.each(WRITE_CALLS)("el cuerpo de baseline no escribe en Firestore: %s", (writeCall) => {
    expect(topLevelFunctionBody(source(), "baseline") ?? "").not.toContain(writeCall);
  });

  it.each(WRITE_CALLS)("sin modos de escritura declarados, el guion no contiene %s", (writeCall) => {
    const modes = declaredWriteModes();
    expect(modes).not.toBeNull();
    if (modes && modes.length === 0) expect(source()).not.toContain(writeCall);
  });

  it("baseline escribe su evidencia en t1-linea-base.txt de la spec 029", () => {
    expect(source()).toContain("029_store_api_confirma_y_corrige_pedidos");
    expect(source()).toContain("t1-linea-base.txt");
  });

  it("mide el tipo de shopifyOrderId por tienda (texto / numero / mixto)", () => {
    expect(source()).toMatch(/shopifyOrderId/);
    expect(source()).toMatch(/typeof\b/);
    expect(source()).toMatch(/mixto/);
    expect(source()).toMatch(/sellerId/);
  });

  it("cuenta pedidos por estado con y sin driverId en los tres estados editables", () => {
    for (const status of ["imported", "address_risk", "ready_to_assign"]) {
      expect(source()).toContain(`"${status}"`);
    }
    expect(source()).toMatch(/driverId/);
  });

  it("mide las ciudades activas de `cities`", () => {
    expect(source()).toMatch(/collection\(\s*["']cities["']\s*\)/);
    expect(source()).toMatch(/\bactive\b/);
  });

  it("agrupa auditEvents por action y por presencia de actorRole", () => {
    expect(source()).toMatch(/collection\(\s*["']auditEvents["']\s*\)/);
    expect(source()).toMatch(/\.action\b/);
    expect(source()).toMatch(/actorRole/);
  });

  it("lee storeApiConfigs sin imprimir la key: apiKey solo como presencia (Boolean / typeof)", () => {
    expect(source()).toMatch(/collection\(\s*["']storeApiConfigs["']\s*\)/);
    const uses = [...source().matchAll(/[\w$.?\]\[]*\.apiKey\b/g)];
    for (const use of uses) {
      const before = source().slice(Math.max(0, (use.index ?? 0) - 8), use.index);
      expect(before, `uso de apiKey no permitido: ...${before}${use[0]}`).toMatch(/(Boolean\(|typeof\s)$/);
    }
    expect(source()).not.toMatch(/\$\{[^}]*apiKey[^}]*\}/);
  });

  it("cuenta los cortes con algun cashAllocations[].orderId fuera de su orderIds (plan 2.10)", () => {
    expect(source()).toMatch(/collection\(\s*["']settlements["']\s*\)/);
    expect(source()).toMatch(/cashAllocations/);
    expect(source()).toMatch(/orderIds/);
    expect(source()).toContain("cashAllocations fuera de orderIds");
  });

  it("comprueba en codigo que uchat-pull.ts y uchat-webhook.ts confirman dentro de runTransaction", () => {
    expect(source()).toContain("uchat-pull.ts");
    expect(source()).toContain("uchat-webhook.ts");
    expect(source()).toMatch(/runTransaction/);
  });

  it("la evidencia existe y lleva el recuento de cashAllocations y todas las medidas", () => {
    expect(existsSync(absolute(EVIDENCE))).toBe(true);
    const evidence = readFileSync(absolute(EVIDENCE), "utf8");
    expect(evidence).toMatch(/cashAllocations fuera de orderIds:\s*\d+/);
    for (const section of ["shopifyOrderId", "address_risk", "cities", "auditEvents", "actorRole", "storeApiConfigs", "uchat-pull.ts", "uchat-webhook.ts"]) {
      expect(evidence).toContain(section);
    }
  });
});
