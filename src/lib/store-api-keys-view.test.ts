/**
 * Spec 029 · T19 — modelo de vista de la clave de escritura (`src/lib/store-api-keys-view.ts`).
 *
 * Puro: recibe lo que devuelven `getStoreApiKeyStatus` / `listStoreApiKeys` / `rotateStoreWriteKey` (tipos de
 * `src/lib/types.ts`) y decide lo que se pinta. Ninguna prueba toca Firebase.
 *
 * Contrato (README del diseno, decisiones 2-7; plan seccion 9, fila `store-api-keys-view.ts`):
 *
 *   WRITE_KEY_LINE_LENGTH = 24
 *   ADMIN_KEYS_PAGE_SIZE = { desktop: 6, mobile: 4 }
 *   splitWriteKey(writeKey: string) -> [string, string]            // dos lineas de 24
 *   formatKeyDateTime(iso: string) -> string                        // "6 oct 2026, 10:42" (hora de Bogota)
 *
 *   buildWriteKeySectionView(input: {
 *     viewer: "admin" | "seller" | "seller_logistics";
 *     status: StoreApiKeyStatus | null;                 // null = cargando
 *     fresh?: { writeKey: string; previousLast4: string | null } | null;  // recien generada/rotada
 *     error?: "generate" | "rotate" | null;
 *     copied?: boolean;                                  // "Copiada" tras copiar
 *     actorName?: string;                                // admin: quien la genero ("Laura Gomez")
 *   }) -> {
 *     state: "loading" | "none" | "fresh" | "active" | "error";
 *     pill: { text: string; tone: "muted" | "acid" } | null;   // role=status
 *     description: string | null;
 *     rows: { label: string; value: string }[];                // activa: Termina en / Generada / Generada por
 *     keyLines: [string, string] | null;                       // solo en "fresh"
 *     alert: { title: string; lines: string[] } | null;        // role=alert ("Copiala ahora" o el error)
 *     mutedNote: string | null;                                // "Si sales sin copiarla..."
 *     copyStatus: string | null;                               // "Copiada"
 *     actions: { id: "generate" | "rotate" | "copy" | "saved" | "retry"; label: string; disabled?: boolean }[];
 *     readOnlyNote: string | null;                             // logistico
 *     footer: string;                                          // "Va solo en la cabecera Authorization: Bearer."
 *     manualLink: string;                                      // "Manual completo: /api-tiendas"
 *   }
 *
 *   buildAdminKeysListView(statuses: StoreApiKeyStatus[], options: {
 *     query: string; page: number /* 1-based *\/; viewport: "desktop" | "mobile";
 *   }) -> {
 *     summary: string;                 // "3 de 14 tiendas con clave de escritura" (sobre el total, sin filtro)
 *     rows: { sellerId; sellerName; readText; writeText; writeDetail: string | null; generatedBy: string | null;
 *             action: { id: "generate" | "rotate"; label: "Generar" | "Rotar"; accessibleName: string } }[];
 *     page: number; pageCount: number; rangeText: string; // "Tiendas 1 a 6 de 14"
 *     hasPrevious: boolean; hasNext: boolean;
 *   }
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle con su
 * propio mensaje en vez de tumbar el archivo entero.
 */
import { describe, expect, it } from "vitest";
import type { StoreApiKeyStatus } from "./types";

type ViewModule = typeof import("./store-api-keys-view");
const loadView = (): Promise<ViewModule> => import("./store-api-keys-view");

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

/** Formato real: `kw_` + 45 base64url = 48 (functions/src/store-api-auth.ts). Termina en "c41e". */
const WRITE_KEY = "kw_c1a7e4b20d58c6e91a0f27b4d3e18c5a6902f7d4bc41e"; // kw_ + 45, como generateWriteKey
/** 2026-10-06 10:42 en Bogota (UTC-5). */
const GENERATED_AT = "2026-10-06T15:42:00.000Z";
const GENERATED_TEXT = "6 oct 2026, 10:42";

function makeStatus(over: Partial<StoreApiKeyStatus> = {}): StoreApiKeyStatus {
  return {
    sellerId: "seller-kovia",
    sellerName: "Kovia",
    canManageWrite: true,
    read: { exists: true, status: "active" },
    write: { exists: true, last4: "c41e", generatedAt: GENERATED_AT, generatedByLabel: "Tu tienda" },
    ...over,
  };
}

const withoutWrite = (over: Partial<StoreApiKeyStatus> = {}) => makeStatus({ write: { exists: false }, ...over });

function allText(value: unknown): string {
  return JSON.stringify(value);
}

function actionLabels(view: { actions: { label: string }[] }): string[] {
  return view.actions.map((action) => action.label);
}

// ---------------------------------------------------------------------------------------------------
// Key en dos lineas
// ---------------------------------------------------------------------------------------------------

describe("T19 · splitWriteKey: la clave completa en dos lineas de 24 (decision 4)", () => {
  it("parte la key real de 48 caracteres en dos lineas de 24", async () => {
    const { splitWriteKey, WRITE_KEY_LINE_LENGTH } = await loadView();
    const lines = splitWriteKey(WRITE_KEY);
    expect(WRITE_KEY_LINE_LENGTH).toBe(24);
    expect(lines).toEqual([WRITE_KEY.slice(0, 24), WRITE_KEY.slice(24)]);
    expect(lines.map((line) => line.length)).toEqual([24, 24]);
  });

  it("las dos lineas unidas son exactamente la key (no se pierde ni se anade nada)", async () => {
    const { splitWriteKey } = await loadView();
    expect(splitWriteKey(WRITE_KEY).join("")).toBe(WRITE_KEY);
  });
});

describe("T19 · formatKeyDateTime: fecha de generacion en hora de Bogota", () => {
  it("pinta \"6 oct 2026, 10:42\" como en HU_04.tienda-activa", async () => {
    const { formatKeyDateTime } = await loadView();
    expect(formatKeyDateTime(GENERATED_AT)).toBe(GENERATED_TEXT);
  });
});

// ---------------------------------------------------------------------------------------------------
// Estados de la seccion de escritura (decision 3)
// ---------------------------------------------------------------------------------------------------

describe("T19 · seccion de escritura · sin clave (HU_04.tienda-sin-clave)", () => {
  it("pildora muted \"Sin clave de escritura\" y la unica accion es \"Generar clave de escritura\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: withoutWrite() });
    expect(view.state).toBe("none");
    expect(view.pill).toEqual({ text: "Sin clave de escritura", tone: "muted" });
    expect(actionLabels(view)).toEqual(["Generar clave de escritura"]);
    expect(view.actions[0]?.id).toBe("generate");
  });

  it("explica que la clave se ve completa una sola vez", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: withoutWrite() });
    expect(view.description).toBe(
      "Confirma, corrige y cancela pedidos que aun no tienen lider. Kentro solo guarda su huella: la veras completa una sola vez."
    );
    expect(view.rows).toEqual([]);
    expect(view.keyLines).toBeNull();
  });
});

describe("T19 · seccion de escritura · activa (HU_04.tienda-activa, RF_25)", () => {
  it("pildora \"Activa\" de contorno acido y la accion \"Rotar clave de escritura\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: makeStatus() });
    expect(view.state).toBe("active");
    expect(view.pill).toEqual({ text: "Activa", tone: "acid" });
    expect(actionLabels(view)).toEqual(["Rotar clave de escritura"]);
    expect(view.actions[0]?.id).toBe("rotate");
  });

  it("tres filas: \"Termina en\" + last4, \"Generada\" + fecha y \"Generada por\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: makeStatus() });
    expect(view.rows).toEqual([
      { label: "Termina en", value: "c41e" },
      { label: "Generada", value: GENERATED_TEXT },
      { label: "Generada por", value: "Tu tienda" },
    ]);
  });

  it("\"Generada por\" pasa tal cual lo que decide el servidor (\"Kentro\" a la tienda, \"por Laura Gomez\" al admin)", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const byKentro = buildWriteKeySectionView({
      viewer: "seller",
      status: makeStatus({ write: { exists: true, last4: "c41e", generatedAt: GENERATED_AT, generatedByLabel: "Kentro" } }),
    });
    const forAdmin = buildWriteKeySectionView({
      viewer: "admin",
      status: makeStatus({ write: { exists: true, last4: "0b93", generatedAt: GENERATED_AT, generatedByLabel: "por Laura Gomez" } }),
    });
    expect(byKentro.rows.find((row) => row.label === "Generada por")?.value).toBe("Kentro");
    expect(forAdmin.rows.find((row) => row.label === "Generada por")?.value).toBe("por Laura Gomez");
  });

  it("no contiene el prefijo kw_ como dato ni una fecha de rotacion", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const text = allText(buildWriteKeySectionView({ viewer: "seller", status: makeStatus() }));
    expect(text).not.toContain("kw_");
    expect(text.toLowerCase()).not.toContain("rotada");
    expect(text).not.toContain("Prefijo");
    // La unica fecha que se pinta es la de generacion.
    expect(text.match(/\d{1,2} [a-z]{3}\.? \d{4}/g)).toEqual(["6 oct 2026"]);
  });

  it("despues de \"Ya la guarde\" la seccion activa nunca contiene la key ni sus mitades", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const text = allText(buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), fresh: null }));
    expect(text).not.toContain(WRITE_KEY);
    expect(text).not.toContain(WRITE_KEY.slice(0, 24));
    expect(text).not.toContain(WRITE_KEY.slice(24));
  });

  it("no pinta la clave enmascarada con asteriscos", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const text = allText(buildWriteKeySectionView({ viewer: "seller", status: makeStatus() }));
    expect(text).not.toMatch(/\*{3,}|•{3,}/);
  });
});

describe("T19 · seccion de escritura · recien generada (HU_04.tienda-recien-generada, decision 4)", () => {
  it("aviso \"Copiala ahora\", key en dos lineas de 24 y acciones Copiar / Ya la guarde", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({
      viewer: "seller",
      status: makeStatus(),
      fresh: { writeKey: WRITE_KEY, previousLast4: null },
    });
    expect(view.state).toBe("fresh");
    expect(view.alert?.title).toBe("Copiala ahora");
    expect(view.alert?.lines).toContain("Solo se muestra completa esta vez: Kentro guarda su huella, no la clave.");
    expect(view.keyLines).toEqual([WRITE_KEY.slice(0, 24), WRITE_KEY.slice(24)]);
    expect(view.actions.map((action) => [action.id, action.label])).toEqual([
      ["copy", "Copiar clave de escritura"],
      ["saved", "Ya la guarde"],
    ]);
  });

  it("aviso mudo de la tienda: \"Si sales sin copiarla, tendras que generar otra.\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), fresh: { writeKey: WRITE_KEY, previousLast4: null } });
    expect(view.mutedNote).toBe("Si sales sin copiarla, tendras que generar otra.");
  });

  it("si fue una rotacion suma \"La clave que terminaba en c41e ya no funciona.\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const rotated = buildWriteKeySectionView({
      viewer: "seller",
      status: makeStatus({ write: { exists: true, last4: "9a01", generatedAt: GENERATED_AT, generatedByLabel: "Tu tienda" } }),
      fresh: { writeKey: WRITE_KEY, previousLast4: "c41e" },
    });
    const first = buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), fresh: { writeKey: WRITE_KEY, previousLast4: null } });
    expect(rotated.alert?.lines).toContain("La clave que terminaba en c41e ya no funciona.");
    expect(allText(first)).not.toContain("ya no funciona");
  });

  it("\"Copiar\" anuncia \"Copiada\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const before = buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), fresh: { writeKey: WRITE_KEY, previousLast4: null } });
    const after = buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), fresh: { writeKey: WRITE_KEY, previousLast4: null }, copied: true });
    expect(before.copyStatus).toBeNull();
    expect(after.copyStatus).toBe("Copiada");
  });

  it("admin (HU_04.admin-recien-generada): textos del dialogo, quien la genero y la lectura no cambia", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({
      viewer: "admin",
      status: makeStatus({ sellerName: "Bella Mujer", write: { exists: true, last4: "6a2f", generatedAt: GENERATED_AT, generatedByLabel: "por Laura Gomez" } }),
      fresh: { writeKey: WRITE_KEY, previousLast4: null },
      actorName: "Laura Gomez",
    });
    expect(view.alert?.title).toBe("Copiala ahora");
    expect(view.alert?.lines).toContain(
      "Es la unica vez que se muestra completa: Kentro guarda solo su huella. Entregala a la tienda por un canal seguro."
    );
    expect(view.mutedNote).toBe("Si cierras sin copiarla, tendras que rotarla.");
    const text = allText(view);
    expect(text).toContain("Queda registrado que la generaste tu (Laura Gomez)");
    expect(text).toContain("La clave de lectura de Bella Mujer no cambia.");
  });
});

describe("T19 · seccion de escritura · error (HU_04.tienda-error, decision 6)", () => {
  it("error al rotar: alerta con la verdad y \"Reintentar\"; debajo sigue el estado real", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), error: "rotate" });
    expect(view.state).toBe("error");
    expect(view.alert).toEqual({
      title: "No se pudo rotar la clave",
      lines: ["La que termina en c41e sigue activa.", "No se genero ninguna clave nueva."],
    });
    expect(view.actions.map((action) => [action.id, action.label])).toEqual([["retry", "Reintentar"]]);
    expect(view.pill).toEqual({ text: "Activa", tone: "acid" });
    expect(view.rows.find((row) => row.label === "Termina en")?.value).toBe("c41e");
    expect(view.keyLines).toBeNull();
  });

  it("error al generar la primera: \"No se pudo generar la clave. No se creo ninguna.\"", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: withoutWrite(), error: "generate" });
    expect(view.state).toBe("error");
    expect(view.alert).toEqual({ title: "No se pudo generar la clave", lines: ["No se creo ninguna."] });
    expect(actionLabels(view)).toEqual(["Reintentar"]);
    expect(view.pill).toEqual({ text: "Sin clave de escritura", tone: "muted" });
  });
});

describe("T19 · seccion de escritura · cargando (decision 3)", () => {
  it("sin estado todavia: boton deshabilitado \"Consultando...\", sin pildora ni filas", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ viewer: "seller", status: null });
    expect(view.state).toBe("loading");
    expect(view.pill).toBeNull();
    expect(view.rows).toEqual([]);
    expect(view.actions).toEqual([expect.objectContaining({ label: "Consultando...", disabled: true })]);
  });
});

describe("T19 · seccion de escritura · logistico sin botones (decision 7)", () => {
  const logistics = { viewer: "seller_logistics" as const };

  it("activa: ve el estado pero ningun boton, y la linea de quien puede generarla", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const view = buildWriteKeySectionView({ ...logistics, status: makeStatus({ canManageWrite: false }) });
    expect(view.state).toBe("active");
    expect(view.pill?.text).toBe("Activa");
    expect(view.actions).toEqual([]);
    expect(view.readOnlyNote).toBe("Solo la cuenta principal de la tienda o Kentro pueden generarla.");
  });

  it("sin clave y cargando: tampoco hay botones", async () => {
    const { buildWriteKeySectionView } = await loadView();
    expect(buildWriteKeySectionView({ ...logistics, status: withoutWrite({ canManageWrite: false }) }).actions).toEqual([]);
    expect(buildWriteKeySectionView({ ...logistics, status: null }).actions).toEqual([]);
  });

  it("la cuenta principal no lleva la linea de solo lectura", async () => {
    const { buildWriteKeySectionView } = await loadView();
    expect(buildWriteKeySectionView({ viewer: "seller", status: makeStatus() }).readOnlyNote).toBeNull();
  });
});

describe("T19 · seccion de escritura · pie fijo en todos los estados (decision 3, RNF_01)", () => {
  it("cada estado lleva \"Va solo en la cabecera Authorization: Bearer.\" y el enlace al manual", async () => {
    const { buildWriteKeySectionView } = await loadView();
    const views = [
      buildWriteKeySectionView({ viewer: "seller", status: null }),
      buildWriteKeySectionView({ viewer: "seller", status: withoutWrite() }),
      buildWriteKeySectionView({ viewer: "seller", status: makeStatus() }),
      buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), fresh: { writeKey: WRITE_KEY, previousLast4: null } }),
      buildWriteKeySectionView({ viewer: "seller", status: makeStatus(), error: "rotate" }),
      buildWriteKeySectionView({ viewer: "seller_logistics", status: makeStatus({ canManageWrite: false }) }),
    ];
    for (const view of views) {
      expect(view.footer).toBe("Va solo en la cabecera Authorization: Bearer.");
      expect(view.manualLink).toBe("Manual completo: /api-tiendas");
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Lista del admin (decision 2)
// ---------------------------------------------------------------------------------------------------

const STORE_NAMES = [
  "Kovia", "ONEP", "DANDA", "Bella Mujer", "Senziacol", "E-master", "Tienda 7",
  "Tienda 8", "Tienda 9", "Tienda 10", "Tienda 11", "Tienda 12", "Tienda 13", "Tienda 14",
];
const WITH_WRITE: Record<string, { last4: string; by: string }> = {
  Kovia: { last4: "c41e", by: "por la tienda" },
  ONEP: { last4: "0b93", by: "por Laura Gomez" },
  DANDA: { last4: "5e07", by: "por la tienda" },
};

function adminStatuses(): StoreApiKeyStatus[] {
  return STORE_NAMES.map((name) => {
    const write = WITH_WRITE[name];
    return makeStatus({
      sellerId: `seller-${name.toLowerCase().replace(/\s+/g, "-")}`,
      sellerName: name,
      read: name === "E-master" ? { exists: false, status: "none" } : { exists: true, status: "active" },
      write: write ? { exists: true, last4: write.last4, generatedAt: GENERATED_AT, generatedByLabel: write.by } : { exists: false },
    });
  });
}

describe("T19 · lista del admin · resumen y filas (HU_04.admin-lista)", () => {
  it("resumen \"3 de 14 tiendas con clave de escritura\"", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "", page: 1, viewport: "desktop" });
    expect(view.summary).toBe("3 de 14 tiendas con clave de escritura");
  });

  it("fila con clave: Escritura \"Activa\", \"termina en c41e\", quien, y boton \"Rotar\" con nombre completo", async () => {
    const { buildAdminKeysListView } = await loadView();
    const kovia = buildAdminKeysListView(adminStatuses(), { query: "", page: 1, viewport: "desktop" }).rows[0];
    expect(kovia).toMatchObject({
      sellerName: "Kovia",
      readText: "Activa",
      writeText: "Activa",
      writeDetail: "termina en c41e",
      generatedBy: "por la tienda",
      action: { id: "rotate", label: "Rotar", accessibleName: "Rotar clave de escritura de Kovia" },
    });
  });

  it("fila sin clave: \"Sin clave\" y boton \"Generar\" con nombre completo", async () => {
    const { buildAdminKeysListView } = await loadView();
    const rows = buildAdminKeysListView(adminStatuses(), { query: "", page: 1, viewport: "desktop" }).rows;
    const bella = rows.find((row) => row.sellerName === "Bella Mujer");
    expect(bella).toMatchObject({
      readText: "Activa",
      writeText: "Sin clave",
      writeDetail: null,
      action: { id: "generate", label: "Generar", accessibleName: "Generar clave de escritura de Bella Mujer" },
    });
    expect(rows.find((row) => row.sellerName === "E-master")?.readText).toBe("Sin clave");
  });

  it("la lista nunca lleva una key ni el prefijo kw_", async () => {
    const { buildAdminKeysListView } = await loadView();
    const text = allText(buildAdminKeysListView(adminStatuses(), { query: "", page: 1, viewport: "desktop" }));
    expect(text).not.toContain("kw_");
  });
});

describe("T19 · lista del admin · paginas de 6 (escritorio) y 4 (movil)", () => {
  it("tamanos de pagina declarados", async () => {
    const { ADMIN_KEYS_PAGE_SIZE } = await loadView();
    expect(ADMIN_KEYS_PAGE_SIZE).toEqual({ desktop: 6, mobile: 4 });
  });

  it("escritorio: pagina 1 de 3, \"Tiendas 1 a 6 de 14\", sin Anterior y con Siguiente", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "", page: 1, viewport: "desktop" });
    expect(view.rows.map((row) => row.sellerName)).toEqual(STORE_NAMES.slice(0, 6));
    expect(view.page).toBe(1);
    expect(view.pageCount).toBe(3);
    expect(view.rangeText).toBe("Tiendas 1 a 6 de 14");
    expect(view.hasPrevious).toBe(false);
    expect(view.hasNext).toBe(true);
  });

  it("escritorio: ultima pagina con las 2 que sobran", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "", page: 3, viewport: "desktop" });
    expect(view.rows.map((row) => row.sellerName)).toEqual(STORE_NAMES.slice(12));
    expect(view.rangeText).toBe("Tiendas 13 a 14 de 14");
    expect(view.hasPrevious).toBe(true);
    expect(view.hasNext).toBe(false);
  });

  it("movil: 4 por pagina, 4 paginas", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "", page: 2, viewport: "mobile" });
    expect(view.rows.map((row) => row.sellerName)).toEqual(STORE_NAMES.slice(4, 8));
    expect(view.pageCount).toBe(4);
    expect(view.rangeText).toBe("Tiendas 5 a 8 de 14");
  });

  it("una pagina fuera de rango se ajusta a la ultima valida", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "", page: 9, viewport: "desktop" });
    expect(view.page).toBe(3);
    expect(view.rows).toHaveLength(2);
  });
});

describe("T19 · lista del admin · busqueda \"Buscar tienda\"", () => {
  it("filtra por nombre sin distinguir mayusculas ni tildes", async () => {
    const { buildAdminKeysListView } = await loadView();
    const upper = buildAdminKeysListView(adminStatuses(), { query: "BELLA", page: 1, viewport: "desktop" });
    const accented = buildAdminKeysListView(adminStatuses(), { query: "bélla", page: 1, viewport: "desktop" });
    expect(upper.rows.map((row) => row.sellerName)).toEqual(["Bella Mujer"]);
    expect(accented.rows.map((row) => row.sellerName)).toEqual(["Bella Mujer"]);
  });

  it("la paginacion cuenta sobre lo filtrado; el resumen sigue sobre el total", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "tienda", page: 1, viewport: "mobile" });
    expect(view.rows.map((row) => row.sellerName)).toEqual(["Tienda 7", "Tienda 8", "Tienda 9", "Tienda 10"]);
    expect(view.pageCount).toBe(2);
    expect(view.rangeText).toBe("Tiendas 1 a 4 de 8");
    expect(view.summary).toBe("3 de 14 tiendas con clave de escritura");
  });

  it("consulta vacia o solo espacios no filtra", async () => {
    const { buildAdminKeysListView } = await loadView();
    const view = buildAdminKeysListView(adminStatuses(), { query: "   ", page: 1, viewport: "desktop" });
    expect(view.rangeText).toBe("Tiendas 1 a 6 de 14");
  });
});
