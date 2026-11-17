/**
 * Guarda de fuente: un pedido de Shopify con `shipping_address: null` NO es un payload invalido.
 *
 * Tienda Mora (DANDA) mando cuatro en un mes (#113612, #126729, #132879, #133902): pedidos del
 * formulario cuya direccion solo viene en note_attributes. El esquema usaba `.optional()`, que
 * admite el campo ausente pero no `null`, asi que el webhook respondia 400; Shopify reintenta 9
 * veces en 4 horas y lo cuenta como fallo de entrega, el mismo mecanismo con el que dejo a GlowMi
 * sin suscripcion nueve dias (2026-11-08 a 2026-11-17).
 *
 * Los dos esquemas (webhook e importacion/sincronizacion) son copias: se vigilan los dos.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const shippingAddressRule = (source: string, schemaName: string) => {
  const start = source.indexOf(`const ${schemaName} = z.object({`);
  expect(start, `no encuentro ${schemaName}`).toBeGreaterThan(-1);
  const field = source.indexOf("shipping_address: z", start);
  const end = source.indexOf("line_items:", field);
  // Sin comentarios: el porque de la regla menciona `optional` y no debe contar como codigo.
  return source.slice(field, end).replace(/\/\/.*$/gm, "");
};

describe("Shopify: shipping_address puede venir en null", () => {
  it.each([
    ["functions/src/index.ts", "shopifyWebhookSchema"],
    ["functions/src/shopify.ts", "shopifyOrderSchema"]
  ])("%s — %s acepta null", (file, schemaName) => {
    const rule = shippingAddressRule(read(`../../${file}`), schemaName);
    expect(rule).toContain(".nullish()");
    expect(rule).not.toContain(".optional()");
  });
});
