import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOrdersWithoutLabel, hasPrintedLabel, pickupLabelBlockMessage } from "../../functions/src/pickup-label-gate";
import { pickupLabelBlockReason } from "./order-labels";

const printed = { id: "o1", trackingCode: "KNT-000001", labelPrintedAt: "2026-11-18T10:00:00.000Z" };
const unprinted = { id: "o2", trackingCode: "KNT-008860" };

describe("la recogida exige rotulo impreso", () => {
  it("solo cuenta como impreso un sello de fecha no vacio", () => {
    expect(hasPrintedLabel(printed)).toBe(true);
    expect(hasPrintedLabel({ ...unprinted, labelPrintedAt: undefined })).toBe(false);
    expect(hasPrintedLabel({ labelPrintedAt: "" })).toBe(false);
    expect(hasPrintedLabel({ labelPrintedAt: null })).toBe(false);
  });

  it("deja pasar un lote entero con rotulo", () => {
    expect(pickupLabelBlockMessage([printed, { ...printed, id: "o3" }])).toBeNull();
  });

  it("un solo pedido sin rotulo bloquea el lote y dice cual es", () => {
    expect(findOrdersWithoutLabel([printed, unprinted])).toEqual([unprinted]);
    const message = pickupLabelBlockMessage([printed, unprinted]);
    expect(message).toContain("KNT-008860");
    expect(message).not.toContain("KNT-000001");
  });

  it("nombra por numero de Shopify o id cuando no hay codigo KNT", () => {
    expect(pickupLabelBlockMessage([{ id: "o9", shopifyOrderId: "#5501" }])).toContain("#5501");
    expect(pickupLabelBlockMessage([{ id: "o9" }])).toContain("o9");
  });

  it("recorta la lista en lotes grandes sin perder la cuenta", () => {
    const many = Array.from({ length: 24 }, (_, index) => ({ id: `o${index}`, trackingCode: `KNT-${index}` }));
    const message = pickupLabelBlockMessage(many) ?? "";
    expect(message).toContain("24 pedidos");
    expect(message).toContain("y 14 mas");
  });

  it("el aviso del modal coincide con la regla del servidor", () => {
    expect(pickupLabelBlockReason({ trackingCode: "KNT-1", shopifyOrderId: "#1", labelPrintedAt: "2026-11-18T10:00:00.000Z" })).toBeNull();
    expect(pickupLabelBlockReason({ trackingCode: "KNT-008860", shopifyOrderId: "#1" })).toContain("KNT-008860");
  });
});

// Guarda de fuente: las dos vias por las que un pedido sale a la calle tienen que pasar por la regla.
describe("las dos vias de recogida usan la regla", () => {
  const source = readFileSync(join(__dirname, "../../functions/src/orders.ts"), "utf8");
  const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));

  it("createOrUpdatePickupBatch la comprueba antes de escribir", () => {
    const body = section("export const createOrUpdatePickupBatch", "\nexport const ");
    expect(body.indexOf("pickupLabelBlockMessage(")).toBeGreaterThan(-1);
    expect(body.indexOf("pickupLabelBlockMessage(")).toBeLessThan(body.indexOf("transaction.set("));
  });

  it("applyOrderTransition la comprueba antes de escribir", () => {
    const body = section("export const applyOrderTransition", "\nexport const ");
    expect(body.indexOf("pickupLabelBlockMessage(")).toBeGreaterThan(-1);
    expect(body.indexOf("pickupLabelBlockMessage(")).toBeLessThan(body.indexOf("transaction.set("));
  });
});
