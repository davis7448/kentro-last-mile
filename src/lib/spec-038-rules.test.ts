/**
 * Spec 038 · T18 (RF_05b, RF_17): la foto historica (`driverLedgerBaselines`) y las retenciones
 * (`driverCashHolds`) deciden cuanto se le cobra a un domiciliario. Solo las escribe el servidor (Admin SDK,
 * que ignora las reglas): desde un cliente nadie, tampoco el admin, porque un cliente con estado viejo podria
 * liberar una retencion sin aprobacion. Las lee solo el admin, para auditarlas.
 *
 * Prueba de fuente: el emulador de reglas no esta en el arnes de pruebas de este repo.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rules = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");
const withoutComments = rules.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Cuerpo de `match /<collection>/{...} { ... }`, sin comentarios; null si no existe. */
function matchBody(collection: string): string | null {
  const start = withoutComments.search(new RegExp(`match /${collection}/\\{[^}]+\\}\\s*\\{`));
  if (start < 0) return null;
  const open = withoutComments.indexOf("{", withoutComments.indexOf("}", start) + 1);
  let depth = 0;
  for (let index = open; index < withoutComments.length; index += 1) {
    if (withoutComments[index] === "{") depth += 1;
    if (withoutComments[index] === "}") depth -= 1;
    if (depth === 0) return withoutComments.slice(open + 1, index);
  }
  return null;
}

const allows = (body: string) =>
  [...body.matchAll(/allow\s+([a-z,\s]+):\s*if\s+([^;]+);/g)].map((match) => ({
    ops: match[1].split(",").map((op) => op.trim()),
    condition: match[2].trim()
  }));

describe("spec 038 · T18 · reglas de la foto historica y las retenciones", () => {
  for (const collection of ["driverLedgerBaselines", "driverCashHolds"]) {
    describe(collection, () => {
      it("tiene su propio match (no depende del comodin final)", () => {
        expect(matchBody(collection)).not.toBeNull();
      });

      it("lectura solo con isAdmin()", () => {
        const reads = allows(matchBody(collection) ?? "").filter((rule) => rule.ops.includes("read") || rule.ops.includes("get") || rule.ops.includes("list"));
        expect(reads).toEqual([{ ops: ["read"], condition: "isAdmin()" }]);
      });

      it("escritura de nadie desde cliente: allow write: if false, y ninguna otra", () => {
        const writes = allows(matchBody(collection) ?? "").filter((rule) => rule.ops.some((op) => op !== "read"));
        expect(writes).toEqual([{ ops: ["write"], condition: "false" }]);
      });
    });
  }

  it("isAdmin() sigue siendo la del rol admin del token", () => {
    expect(withoutComments).toMatch(/function isAdmin\(\)\s*\{\s*return role\(\) == "admin";\s*\}/);
  });
});
