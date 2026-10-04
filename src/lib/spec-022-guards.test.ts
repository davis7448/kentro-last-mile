/**
 * Guardas de fuente de la spec 022 — `specs/022_ningun_pedido_vale_mil_millones.md`.
 *
 * La regla del importe se prueba de verdad en `order-amount.test.ts`. Aqui se guarda que NADIE la
 * esquive: las tres callables que aceptan un importe tecleado tienen que declararlo con el esquema
 * comun, y la pantalla tiene que usar las mismas dos cifras que el servidor.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_ORDER_TOTAL_COP,
  MAX_ORDER_TOTAL_COP,
  checkOrderTotalCop,
  needsAmountConfirmation
} from "../../functions/src/order-amount";
import {
  checkOrderTotalCop as clientCheckOrderTotalCop,
  needsAmountConfirmation as clientNeedsAmountConfirmation
} from "./order-amount";

function source(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const ORDERS = source("functions/src/orders.ts");
const OPERATIONS = source("src/components/operations-app.tsx");

describe("spec 022 · ningun importe tecleado esquiva la regla (RF_01, RF_03)", () => {
  it("RF_03 · las tres callables declaran el importe con el esquema comun", () => {
    // Crear a mano, editar un importado, ajustar lo que se cobra en la calle.
    expect((ORDERS.match(/totalCop: orderTotalCopSchema/g) ?? []).length).toBe(3);
  });

  it("RF_03 · y ninguna vuelve a declarar el suyo", () => {
    // `z.number().positive()` es exactamente lo que dejaba pasar $11.770.047.900.
    expect(/totalCop:\s*z\.number\(\)/.test(ORDERS)).toBe(false);
  });

  it("RF_03 · el esquema comun no reimplementa la regla: la llama", () => {
    expect(ORDERS.includes('from "./order-amount"')).toBe(true);
    expect(ORDERS.includes("checkOrderTotalCop(value)")).toBe(true);
  });

  it("RNF_01 · la ultima palabra es del servidor, no de la pantalla", () => {
    // El aviso del formulario es una cortesia; el rechazo vive en la callable.
    expect(ORDERS.includes("orderTotalCopSchema")).toBe(true);
  });
});

describe("spec 022 · la pantalla avisa con las MISMAS cifras (RF_05)", () => {
  it("RF_05 · el formulario conoce el tope y el umbral de confirmacion", () => {
    expect(OPERATIONS.includes("MAX_ORDER_TOTAL_COP")).toBe(true);
    expect(OPERATIONS.includes("CONFIRM_ORDER_TOTAL_COP")).toBe(true);
  });

  it("RF_05 · y no los escribe a mano: salen del mismo modulo", () => {
    expect(/from "@\/lib\/order-amount"/.test(OPERATIONS)).toBe(true);
    expect(OPERATIONS.includes("2_000_000")).toBe(false);
    expect(OPERATIONS.includes("2000000")).toBe(false);
  });

  it("el espejo del cliente no puede separarse del servidor", () => {
    const espejo = source("src/lib/order-amount.ts");
    expect(espejo.includes(`export const MAX_ORDER_TOTAL_COP = ${MAX_ORDER_TOTAL_COP}`)).toBe(true);
    expect(espejo.includes(`export const CONFIRM_ORDER_TOTAL_COP = ${CONFIRM_ORDER_TOTAL_COP}`)).toBe(true);
  });

  it("las dos implementaciones dan el MISMO veredicto, valor por valor", () => {
    // Lo que impide que las copias se separen no es la disciplina: es esta tabla.
    const casos: unknown[] = [
      1, 40000, 89900, 224775, 239800, 500000, 500001, 1233000, MAX_ORDER_TOTAL_COP,
      MAX_ORDER_TOTAL_COP + 1, 11770047900, 76506523000,
      0, -1, 89900.5, Number.NaN, Number.POSITIVE_INFINITY, "89900", null, undefined
    ];
    for (const caso of casos) {
      const servidor = checkOrderTotalCop(caso);
      const cliente = clientCheckOrderTotalCop(caso);
      expect({ caso, ...cliente }).toEqual({ caso, ...servidor });
      if (typeof caso === "number") {
        expect(clientNeedsAmountConfirmation(caso)).toBe(needsAmountConfirmation(caso));
      }
    }
  });
});
