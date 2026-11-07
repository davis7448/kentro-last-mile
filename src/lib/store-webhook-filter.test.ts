/**
 * Spec 037: la regla del filtro de productos del webhook de tienda vive en un solo modulo puro
 * (`functions/src/store-webhook-filter.ts`), que usan el servidor y la pantalla.
 *
 * Origen: Infinito conecto su Shopify el 2026-10-05 y el filtro "ADMA" por defecto le descarto
 * 3.608 avisos (153 pedidos de Cali) en un mes, sin que la pantalla lo dijera.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_PRODUCTS,
  LEGACY_DEFAULT,
  acceptsAllProducts,
  describeFilter,
  discardDayKey,
  effectiveCityAllowlist,
  effectiveFilter,
  existingConnection,
  hasWebhookConnection,
  recentFilterDiscards,
  resolveFilterOnSave,
  staleDiscardDays,
  syncInstruction
} from "../../functions/src/store-webhook-filter";

describe("resolveFilterOnSave", () => {
  it("RF_01: una conexion nueva sin filtro acepta todos los productos", () => {
    expect(resolveFilterOnSave({ existing: null, input: {} })).toEqual({ skuContains: "*", tagContains: "*" });
  });

  it("RF_02: regenerar una conexion existente sin tocar el filtro no escribe ninguna clave", () => {
    expect(resolveFilterOnSave({ existing: { skuContains: "*", tagContains: "*" }, input: {} })).toEqual({});
    expect(resolveFilterOnSave({ existing: { skuContains: "NAMBU", tagContains: "NAMBU" }, input: {} })).toEqual({});
  });

  it("RF_03: una conexion antigua sin campos sigue sin campos (y por tanto filtrando ADMA)", () => {
    const saved = resolveFilterOnSave({ existing: {}, input: {} });
    expect(saved).toEqual({});
    expect(effectiveFilter({ ...saved })).toEqual({ skuContains: "ADMA", tagContains: "ADMA" });
  });
});

describe("existingConnection (R1-RF_01-1, R1-RF_02-1, R1-RF_03-1)", () => {
  // setStoreUchatConfig crea storeWebhookConfigs/{sellerId} SIN webhookKey al guardar el token de ChatBy.
  // Ese documento nunca fue una conexion de webhook: generarla despues es una conexion nueva y acepta todo.
  const uchatOnly = { id: "s1", sellerId: "s1", status: "active", uchatConfigured: true, createdAt: "2026-11-01T00:00:00Z" };

  it("un documento sin webhookKey (solo ChatBy) no es una conexion existente", () => {
    expect(existingConnection(uchatOnly)).toBeNull();
    expect(existingConnection({ ...uchatOnly, webhookKey: "" })).toBeNull();
    expect(existingConnection({ ...uchatOnly, webhookKey: "   " })).toBeNull();
    expect(existingConnection(undefined)).toBeNull();
    expect(existingConnection(null)).toBeNull();
  });

  it("RF_01: generar el webhook sobre un documento solo de ChatBy guarda todos los productos", () => {
    expect(resolveFilterOnSave({ existing: existingConnection(uchatOnly), input: {} })).toEqual({ skuContains: "*", tagContains: "*" });
  });

  it("RF_02/RF_03: con webhookKey es existente y regenerar no toca el filtro (ni su ausencia)", () => {
    const legacy = { ...uchatOnly, webhookKey: "abc123" };
    expect(existingConnection(legacy)).toBe(legacy);
    expect(resolveFilterOnSave({ existing: existingConnection(legacy), input: {} })).toEqual({});
    const open = { ...legacy, skuContains: "*", tagContains: "*" };
    expect(resolveFilterOnSave({ existing: existingConnection(open), input: {} })).toEqual({});
  });

  it("hasWebhookConnection: la pantalla solo muestra la tarjeta si hay clave", () => {
    expect(hasWebhookConnection(uchatOnly)).toBe(false);
    expect(hasWebhookConnection({ ...uchatOnly, webhookKey: "abc123" })).toBe(true);
  });
});

describe("effectiveCityAllowlist (R1-RF_04-1)", () => {
  it("sin lista o con lista vacia aplica Cali / Santiago de Cali, igual que el servidor", () => {
    expect(effectiveCityAllowlist(undefined)).toEqual(["Cali", "Santiago de Cali"]);
    expect(effectiveCityAllowlist([])).toEqual(["Cali", "Santiago de Cali"]);
    expect(effectiveCityAllowlist("Cali")).toEqual(["Cali", "Santiago de Cali"]);
    expect(effectiveCityAllowlist(["Jamundi"])).toEqual(["Jamundi"]);
  });

  it("RF_04: la frase de todo aceptado no rompe sin cityAllowlist y nombra la ciudad que aplica el servidor", () => {
    const all = { skuContains: "*", tagContains: "*" };
    expect(describeFilter(all, undefined)).toBe("Entran todos tus productos. Solo se descartan pedidos fuera de Cali.");
    expect(describeFilter(all, [])).toBe("Entran todos tus productos. Solo se descartan pedidos fuera de Cali.");
  });
});

describe("resolveFilterOnSave: filtro pedido a proposito", () => {
  it("modo todos: guarda * aunque llegue texto", () => {
    expect(resolveFilterOnSave({ existing: { skuContains: "ADMA" }, input: { filterMode: "all", skuContains: "ADMA" } }))
      .toEqual({ skuContains: "*", tagContains: "*" });
  });

  it("modo SKU: mayusculas, recorta, y la etiqueta toma el mismo valor", () => {
    expect(resolveFilterOnSave({ existing: null, input: { filterMode: "sku", skuContains: "  adma " } }))
      .toEqual({ skuContains: "ADMA", tagContains: "ADMA" });
  });

  it("respeta una etiqueta distinta si se manda explicitamente", () => {
    expect(resolveFilterOnSave({ existing: null, input: { filterMode: "sku", skuContains: "kv", tagContains: "kentro" } }))
      .toEqual({ skuContains: "KV", tagContains: "KENTRO" });
  });

  it("R2-RF_02-1: sin filterMode, skuContains/tagContains sueltos no son un pedido de filtro", () => {
    // La pantalla anterior al despliegue mandaba siempre ADMA de relleno al regenerar. Una pestana vieja
    // no puede volver a poner ADMA sobre una conexion abierta.
    const oldBundle = { skuContains: "ADMA", tagContains: "ADMA" };
    expect(resolveFilterOnSave({ existing: existingConnection({ webhookKey: "k", skuContains: "*", tagContains: "*" }), input: oldBundle })).toEqual({});
    expect(resolveFilterOnSave({ existing: { skuContains: "*", tagContains: "*" }, input: oldBundle })).toEqual({});
    // Conexion nueva desde una pestana vieja: nace aceptando todo, como cualquier conexion nueva.
    expect(resolveFilterOnSave({ existing: null, input: oldBundle })).toEqual({ skuContains: "*", tagContains: "*" });
  });

  it("RF_09: un filtro vacio o solo con espacios vale todos los productos", () => {
    expect(resolveFilterOnSave({ existing: { skuContains: "ADMA" }, input: { filterMode: "sku", skuContains: "   " } }))
      .toEqual({ skuContains: "*", tagContains: "*" });
    expect(resolveFilterOnSave({ existing: null, input: { skuContains: "" } })).toEqual({ skuContains: "*", tagContains: "*" });
  });
});

describe("effectiveFilter y acceptsAllProducts", () => {
  it("campo ausente, vacio o no texto = ADMA (valor antiguo)", () => {
    expect(effectiveFilter({})).toEqual({ skuContains: LEGACY_DEFAULT, tagContains: LEGACY_DEFAULT });
    expect(effectiveFilter({ skuContains: "", tagContains: 3 })).toEqual({ skuContains: "ADMA", tagContains: "ADMA" });
  });

  it("normaliza a mayusculas", () => {
    expect(effectiveFilter({ skuContains: "adma", tagContains: " kv " })).toEqual({ skuContains: "ADMA", tagContains: "KV" });
  });

  it("acepta todo si SKU o etiqueta es * (la conexion mixta de Bella Mujer acepta todo)", () => {
    expect(acceptsAllProducts(effectiveFilter({ skuContains: "*", tagContains: "*" }))).toBe(true);
    expect(acceptsAllProducts(effectiveFilter({ skuContains: "*", tagContains: "ADMA" }))).toBe(true);
    expect(acceptsAllProducts(effectiveFilter({ skuContains: "ADMA", tagContains: "ADMA" }))).toBe(false);
    expect(acceptsAllProducts(effectiveFilter({}))).toBe(false);
    expect(ALL_PRODUCTS).toBe("*");
  });
});

describe("describeFilter y syncInstruction (RF_04, RF_08)", () => {
  it("todo aceptado: dice que entra todo y nombra las ciudades", () => {
    expect(describeFilter({ skuContains: "*", tagContains: "*" }, ["Cali", "Santiago de Cali"]))
      .toBe("Entran todos tus productos. Solo se descartan pedidos fuera de Cali.");
    expect(describeFilter({ skuContains: "*", tagContains: "*" }, ["Cali", "Jamundi"]))
      .toBe("Entran todos tus productos. Solo se descartan pedidos fuera de Cali y Jamundi.");
  });

  it("con filtro: dice que se descarta el resto", () => {
    expect(describeFilter({ skuContains: "ADMA", tagContains: "ADMA" }, ["Cali"]))
      .toBe("Solo entran pedidos con un producto cuyo SKU contenga ADMA o con la etiqueta ADMA. Los demas se descartan.");
  });

  it("instruccion para un pedido viejo segun el filtro", () => {
    expect(syncInstruction({ skuContains: "*", tagContains: "*" })).toBe("Para traer un pedido viejo, abrelo en Shopify y guardalo.");
    expect(syncInstruction({ skuContains: "ADMA", tagContains: "ADMA" })).toBe("Para traer un pedido viejo, agrega la etiqueta ADMA en Shopify y guardalo.");
  });
});

describe("descartes de los ultimos 7 dias (RF_07)", () => {
  it("el dia se cuenta en hora de Bogota (UTC-5)", () => {
    expect(discardDayKey(new Date("2026-11-07T04:59:00Z"))).toBe("2026-11-06");
    expect(discardDayKey(new Date("2026-11-07T05:00:00Z"))).toBe("2026-11-07");
  });

  it("suma pedidos distintos de los dias dentro de la ventana y descarta los viejos", () => {
    const now = new Date("2026-11-06T15:00:00Z");
    const discards = {
      "2026-11-06": { a: true as const, b: true as const },
      "2026-10-31": { c: true as const },
      "2026-10-30": { d: true as const },
      "basura": { e: true as const }
    };
    expect(recentFilterDiscards(discards, now)).toBe(3);
    expect(recentFilterDiscards(undefined, now)).toBe(0);
  });

  it("un pedido descartado en dos dias cuenta una vez", () => {
    const now = new Date("2026-11-06T15:00:00Z");
    expect(recentFilterDiscards({ "2026-11-05": { a: true }, "2026-11-06": { a: true } }, now)).toBe(1);
  });

  it("staleDiscardDays devuelve los dias fuera de la ventana para podarlos", () => {
    const now = new Date("2026-11-06T15:00:00Z");
    expect(staleDiscardDays({ "2026-11-06": { a: true }, "2026-10-30": { b: true }, "2026-10-01": { c: true } }, now).sort())
      .toEqual(["2026-10-01", "2026-10-30"]);
    expect(staleDiscardDays(undefined, now)).toEqual([]);
  });
});
