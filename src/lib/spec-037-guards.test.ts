/**
 * Spec 037: guardas de fuente. El filtro de productos del webhook de tienda se decide en un solo
 * sitio (`functions/src/store-webhook-filter.ts`). Estas guardas fallan si alguien vuelve a poner
 * un valor por defecto en otra parte, que es exactamente como se colo el "ADMA" que le descarto a
 * Infinito un mes de pedidos.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const server = read("../../functions/src/store-webhook.ts");

const app = read("../components/operations-app.tsx");
const sliceFn = (source: string, name: string) => {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

describe("spec 037 — tarjeta de la tienda (T3)", () => {
  const card = read("../components/store-webhook-filter-card.tsx");
  const panel = sliceFn(app, "ShopifyConnectionPanel");

  it("RNF_01/RF_04: la tarjeta de la tienda no manda ni muestra ADMA de relleno", () => {
    // La solicitud de app de Shopify (orderSkuContains, "Ej. ADMA") es otra via de entrada, fuera de alcance.
    expect(panel).not.toMatch(/\|\| "ADMA"/);
    expect(panel).not.toMatch(/(skuContains|tagContains): "ADMA"/);
    expect(panel).not.toMatch(/webhookConfig\.(skuContains|tagContains)/);
    expect(panel).toMatch(/<StoreWebhookFilterCard/);
    // R1-RF_03-1: un documento solo de ChatBy (sin clave) no es conexion: la tienda ve "Generar webhook".
    expect(panel).toMatch(/const webhookConfig = hasWebhookConnection\(storeConfig\)/);
    expect(panel).toMatch(/<UchatConfigForm sellerId=\{seller\.id\} config=\{storeConfig\}/);
    expect(card).not.toMatch(/"ADMA"/);
  });

  it("RF_04/RF_07/RF_08: la frase, el contador y la instruccion salen del modulo del filtro", () => {
    expect(card).toMatch(/from "\.\.\/\.\.\/functions\/src\/store-webhook-filter"/);
    for (const fn of ["effectiveFilter(", "describeFilter(", "syncInstruction(", "recentFilterDiscards("]) expect(card).toContain(fn);
    expect(card).toMatch(/role="status"/);
  });

  it("RF_05/RF_09: edicion explicita con dos opciones, vista previa y guardado con filterMode", () => {
    for (const text of ["Cambiar filtro", "Todos mis productos", "Solo productos cuyo SKU contenga...", "SKU contiene", "Guardar filtro", "Cancelar", "Filtro de productos"]) {
      expect(card).toContain(text);
    }
    expect(card).toMatch(/role="radiogroup"/);
    expect(card).toMatch(/filterMode/);
  });

  it("el wrapper de la callable acepta filterMode", () => {
    const auth = read("./firebase/auth.ts");
    expect(auth).toMatch(/createFirebaseStoreWebhookConfig\(input: \{[^}]*filterMode\?: "all" \| "sku"/);
  });
});

describe("spec 037 — lista del admin (T4)", () => {
  const admin = sliceFn(app, "StoreWebhookConfigsPanel");

  it("RF_06: el admin ve la misma frase que la tienda, del mismo modulo", () => {
    expect(admin).toContain("describeFilter(");
    expect(admin).toContain("effectiveFilter(");
    expect(admin).not.toMatch(/\|\| "ADMA"/);
    expect(admin).not.toMatch(/config\.(skuContains|tagContains) \|\|/);
  });

  it("R3-RF_03-1: el admin solo lista conexiones con clave, y el contador cuenta las mismas", () => {
    expect(admin).toMatch(/\.filter\(\(config\) => config\.status === "active" && hasWebhookConnection\(config\)\)/);
    expect(app).toMatch(/summary=\{`\$\{\(state\.storeWebhookConfigs \?\? \[\]\)\.filter\(\(config\) => config\.status === "active" && hasWebhookConnection\(config\)\)\.length\} configurados`\}/);
  });

  it("RF_07: el admin ve los descartados de la semana por tienda", () => {
    expect(admin).toContain("recentFilterDiscards(");
    expect(admin).toContain("descartados esta semana");
  });

  it("Copiar URL lleva el nombre de la tienda en su nombre accesible (fila repetida)", () => {
    expect(admin).toMatch(/aria-label=\{`Copiar URL de \$\{/);
    expect(admin).toMatch(/aria-label=\{`URL del webhook de \$\{/);
  });
});

describe("spec 037 — servidor (T2)", () => {
  it("RNF_01: store-webhook.ts no declara su propio valor por defecto", () => {
    expect(server).not.toMatch(/defaultSkuContains|defaultTagContains/);
    expect(server).not.toMatch(/function normalizeFilter/);
    expect(server).not.toMatch(/"ADMA"/);
  });

  it("RF_01/RF_02: la callable guarda el filtro con resolveFilterOnSave", () => {
    expect(server).toMatch(/import \{[^}]*resolveFilterOnSave[^}]*\} from "\.\/store-webhook-filter"/);
    expect(server).toMatch(/resolveFilterOnSave\(\{\s*existing:/);
    expect(server).toMatch(/filterMode: z\.enum\(\["all", "sku"\]\)\.optional\(\)/);
  });

  it("RF_03: el webhook aplica effectiveFilter", () => {
    expect(server).toMatch(/effectiveFilter\(config\)/);
  });

  it("R1-RF_01-1: la callable decide 'existente' por la clave, no porque exista el documento", () => {
    expect(server).toMatch(/resolveFilterOnSave\(\{\s*existing: existingConnection\(existing\.data\(\)\)/);
    expect(server).not.toMatch(/existing: existing\.exists \?/);
  });

  it("R1-RF_04-1: el servidor toma las ciudades del modulo, sin su propia lista por defecto", () => {
    expect(server).toMatch(/effectiveCityAllowlist\(config\.cityAllowlist\)/);
    expect(server).not.toMatch(/const defaultCityAllowlist/);
  });

  it("RF_07/RNF_03: apunta descartes por pedido y por dia, con poda, solo si la ciudad estaba cubierta", () => {
    const branch = server.slice(server.indexOf("if (!matchesOrderFilters("), server.indexOf("if (!isAllowedCity(city, cityAllowlist)) {\n    await sampleRef"));
    expect(branch).toMatch(/isAllowedCity\(city, cityAllowlist\)/);
    expect(branch).toMatch(/filterDiscards/);
    expect(branch).toMatch(/discardDayKey\(/);
    expect(branch).toMatch(/staleDiscardDays\(/);
    expect(branch).toMatch(/FieldValue\.delete\(\)/);
    expect(branch).toMatch(/reason: "sku_or_tag_filter"/);
  });
});
