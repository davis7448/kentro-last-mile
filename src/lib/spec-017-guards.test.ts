/**
 * Guardas de fuente de la spec 017 — `specs/017_reimportar_no_pisa_lo_operado.md`.
 *
 * Lo que se vigila aqui no es el comportamiento de un modulo puro (eso lo cubre
 * `order-import-merge.test.ts`), sino la FORMA de artefactos que la suite no puede ejecutar: quien
 * escribe pedidos, dos guiones que corren contra produccion, las reglas de Firestore y la
 * constitucion. Mismo patron que `spec-005-guards.test.ts` y `spec-013-guards.test.ts`.
 *
 * La regla de oro de estas guardas: **se lee la fuente SIN comentarios**. Un requisito escrito en un
 * comentario no es una garantia.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMPORT_WRITE_EXEMPTIONS } from "../../functions/src/order-import-merge";

function repoSource(relativeToRepo: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativeToRepo}`, import.meta.url)), "utf8");
}

/** Fuente sin comentarios: lo que de verdad ejecuta el runtime. */
function sourceWithoutComments(relativeToRepo: string): string {
  return repoSource(relativeToRepo).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function functionsSources(): Array<{ file: string; source: string }> {
  const dir = fileURLToPath(new URL("../../functions/src", import.meta.url));
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file, source: sourceWithoutComments(`functions/src/${file}`) }));
}

/** Posicion del cierre que empareja la apertura en `openIndex`. */
function matchingClose(source: string, openIndex: number): number {
  const open = source[openIndex];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Apertura "${open}" sin cerrar en ${openIndex}.`);
}

/**
 * Los cuatro verbos con los que se escribe un documento, atados a una referencia de `orders`.
 *
 * Mirar solo `.set(` no vale: tres vias escriben con `transaction.create(`, y una guarda que solo
 * buscara `.set(` las daria por buenas por un `.set(` ajeno del mismo archivo. Y se ata a la
 * REFERENCIA, no al archivo: `store-api.ts` lee pedidos y escribe en otras colecciones, asi que una
 * heuristica por archivo lo marcaria y dejaria la suite en rojo sin que nadie haya hecho nada mal.
 */
function writesOrders(source: string): boolean {
  const refNames = new Set<string>();
  for (const match of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*collection\(\s*["']orders["']\s*\)(?:\s*\.doc\([^)]*\))?/g)) {
    refNames.add(match[1]);
  }
  if (/(?:transaction|batch|db)?\.?(?:set|create|update)\(\s*[^,)]*collection\(\s*["']orders["']\s*\)/.test(source)) return true;
  // Una referencia tambien puede venir de una consulta: `const orderRef = found.ref` en
  // uchat-webhook.ts. Lo que la delata es que el archivo consulte `orders` y escriba por una ref.
  if (/collection\(\s*["']orders["']\s*\)/.test(source)) {
    for (const match of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.ref\b/g)) refNames.add(match[1]);
  }
  for (const name of refNames) {
    if (new RegExp(`\\.(?:set|create|update)\\(\\s*${name}\\b`).test(source)) return true;
    if (new RegExp(`${name}\\.(?:set|create|update)\\(`).test(source)) return true;
  }
  return false;
}

/** Las cinco vias por las que un pedido entra desde fuera. */
const IMPORT_ROUTES = [
  "functions/src/shopify.ts",
  "functions/src/index.ts",
  "functions/src/store-webhook.ts",
  "functions/src/onstock-webhook.ts",
  "functions/src/contact-form.ts"
];

describe("guarda 1 — nadie escribe pedidos por su cuenta (RNF_01, RNF_02)", () => {
  it("todo archivo que escriba en `orders` pasa por el nucleo o esta exento", () => {
    const infractores = functionsSources()
      .filter(({ file }) => !(file in IMPORT_WRITE_EXEMPTIONS))
      .filter(({ file }) => file !== "order-import-merge.ts")
      .filter(({ source }) => writesOrders(source))
      .filter(({ source }) => !source.includes("order-import-merge"))
      .map(({ file }) => file);
    expect(infractores).toEqual([]);
  });

  /**
   * No basta con que el archivo IMPORTE el nucleo: una via que lo importara y siguiera escribiendo
   * su propio candidato saldria verde y la guarda no garantizaria nada.
   */
  it.each(IMPORT_ROUTES)("%s escribe lo que devuelve el nucleo", (route) => {
    const source = sourceWithoutComments(route);
    expect(source).toMatch(/mergeImportedOrder\(/);
    expect(source).toMatch(/merged\.doc|\.\.\.merged\.doc/);
  });

  /**
   * El `existing` que decide la fase sale de `existingFactsFrom`, nunca de un `.data() ?? {}`: ese
   * `?? {}` convertiria un pedido nuevo en uno existente vacio, y naceria sin estado ni lider.
   * Excepcion declarada: `contact-form.ts`, cuyo id es nuevo siempre y pasa `null` de verdad.
   */
  it.each(IMPORT_ROUTES.filter((route) => !route.includes("contact-form")))(
    "%s deriva el pedido guardado con existingFactsFrom",
    (route) => {
      const source = sourceWithoutComments(route);
      expect(source).toMatch(/existingFactsFrom\(/);
      expect(source).not.toMatch(/existing:\s*[A-Za-z_$][\w$]*\.data\(\)\s*\?\?\s*\{\}/);
    }
  );
});

describe("guarda 2 — el pedido nuevo nace con su lider vacio (RF_10)", () => {
  /**
   * Es la guarda al reves de lo que parece natural, y es deliberada: lo que hay que impedir no es
   * que exista el literal, sino que un pedido nazca SIN el campo. Un documento sin `driverId` no
   * empareja `where("driverId", "==", null)`, asi que no aparece en el pozo del lider ni en las
   * cifras — sin error y sin aviso.
   */
  it.each(IMPORT_ROUTES)("%s conserva su `driverId: null` de creacion", (route) => {
    expect(sourceWithoutComments(route)).toMatch(/driverId:\s*null/);
  });
});

describe("guarda 3 — las exenciones estan declaradas donde vive la regla (RNF_01)", () => {
  it("son cuatro, con su razon, y en el modulo", () => {
    expect(Object.keys(IMPORT_WRITE_EXEMPTIONS).sort()).toEqual([
      "order-corrections.ts",
      "orders.ts",
      "uchat-pull.ts",
      "uchat-webhook.ts"
    ]);
    for (const [file, reason] of Object.entries(IMPORT_WRITE_EXEMPTIONS)) {
      expect(reason.length, `${file} sin razon escrita`).toBeGreaterThan(40);
    }
  });

  it("cada exento existe de verdad y escribe pedidos", () => {
    const sources = new Map(functionsSources().map(({ file, source }) => [file, source]));
    for (const file of Object.keys(IMPORT_WRITE_EXEMPTIONS)) {
      const source = sources.get(file);
      expect(source, `${file} no existe`).toBeDefined();
      expect(writesOrders(source ?? ""), `${file} ya no escribe pedidos: sobra la exencion`).toBe(true);
    }
  });
});

describe("guarda 4 — el resumen de corrida es admin-only (RF_13)", () => {
  it("firestore.rules lo declara", () => {
    const rules = repoSource("firestore.rules");
    const start = rules.indexOf("match /importRuns/");
    const block = rules.slice(start, rules.indexOf("match ", start + 1));
    expect(block).toContain("allow read: if isAdmin();");
    expect(block).toContain("allow write: if false;");
  });
});

describe("guarda 5 — la regla esta en la constitucion (RNF_03)", () => {
  it("con el incidente que la motivo", () => {
    const constitution = repoSource("docs/constitution.md");
    expect(constitution).toMatch(/34 pedidos sin\s*\n?\s*\*\*lider\*\*|34 pedidos/);
    expect(constitution).toContain("2026-09-15");
    expect(constitution).toContain("order-import-merge.ts");
  });
});

describe("guarda 6 — el resumen se acumula fuera de la transaccion (RF_13)", () => {
  it("shopify.ts escribe el documento de importRuns", () => {
    expect(sourceWithoutComments("functions/src/shopify.ts")).toMatch(/collection\(\s*["']importRuns["']\s*\)/);
  });

  /**
   * Dentro del callback de `runTransaction`, Firestore lo reintenta y los recuentos se inflan sin
   * ningun error: en septiembre el webhook acumulo unos 2.000 reintentos. Es la unica parte de
   * RF_13 que puede fallar en silencio.
   */
  it("la llamada al acumulador no vive dentro de runTransaction", () => {
    const source = sourceWithoutComments("functions/src/shopify.ts");
    for (const match of source.matchAll(/runTransaction\(/g)) {
      const open = source.indexOf("{", match.index ?? 0);
      const body = source.slice(open, matchingClose(source, open) + 1);
      expect(body).not.toMatch(/tallyOrder\(|summarizeRun\(/);
    }
  });
});

describe("guarda 7 — las dos ediciones manuales sellan (RF_17)", () => {
  it("usando la constante del nucleo, no un literal", () => {
    const source = sourceWithoutComments("functions/src/orders.ts");
    expect(source).toMatch(/import\s*\{[^}]*MANUAL_EDIT_STAMP[^}]*\}\s*from\s*["']\.\/order-import-merge["']/);
    // Una por cada edicion manual: `updateImportedOrder` y `updateOrderAdjustments`.
    expect(source.match(/\[MANUAL_EDIT_STAMP\]:/g) ?? []).toHaveLength(2);
    expect(source).not.toMatch(/manuallyEditedAt/);
  });

  /**
   * `TERMINAL_STATUS` y la lista en linea de `updateOrderAdjustments` salen ya del nucleo. Esa
   * segunda es la que mas importa: decide si el admin puede ajustar producto y **recaudo**, asi que
   * si divergiera se podria mover el dinero de un pedido ya cerrado (principio 10).
   *
   * Las dos copias de `closedStatuses` que quedan (anulacion e inventario) se dejaron a proposito:
   * gobiernan otro ciclo y unificarlas seria refactor fuera del alcance de esta spec. La guarda fija
   * ese numero para que nadie anada una tercera sin decidirlo.
   */
  it("y la lista de estados cerrados sale del nucleo donde importa", () => {
    const source = sourceWithoutComments("functions/src/orders.ts");
    expect(source).toMatch(/new Set<string>\(CLOSED_STATUSES\)/);
    const literales = source.match(/\["delivered", "failed", "cancelled", "liquidated"\]/g) ?? [];
    expect(literales).toHaveLength(2);
    for (const match of source.matchAll(/(\w+)\s*=\s*new Set\(\["delivered"/g)) {
      expect(match[1]).toBe("closedStatuses");
    }
  });
});

describe("guarda 8 — las vias aplican lo que el nucleo manda borrar (RF_18)", () => {
  /**
   * Sin esto el nucleo nombraria las claves, nadie las borraria, y RF_18 quedaria en verde y sin
   * efecto ninguno en produccion: la peor forma de cumplir un requisito.
   */
  it.each(["functions/src/shopify.ts", "functions/src/index.ts"])("%s borra las claves de `clear`", (route) => {
    const source = sourceWithoutComments(route);
    expect(source).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+merged\.clear\s*\)/);
    expect(source).toMatch(/FieldValue\.delete\(\)/);
  });
});

describe("guarda 9 — el relleno no duplica la decision (RF_19)", () => {
  /**
   * Los 30+ guiones de `scripts/` replican su logica en JS, y ninguna otra guarda mira esa carpeta:
   * sin esta, el duplicado pasaria en verde y la prueba de `ordersToStamp` no garantizaria nada.
   */
  it("carga el modulo compilado en vez de reimplementarlo", () => {
    const source = sourceWithoutComments("scripts/backfill-manual-edit-stamp.js");
    expect(source).toMatch(/require\(["']\.\.\/functions\/lib\/manual-edit-backfill["']\)/);
    expect(source).not.toMatch(/order\.imported_updated/);
  });
});

describe("guarda 10 — el guion de verificacion tiene la forma que declara T15 (DoD 4)", () => {
  /**
   * Corre contra produccion y lo lanza una persona, asi que la suite no lo ejecuta: sin esta guarda
   * seria el unico artefacto de la spec sin ninguna comprobacion.
   */
  const source = () => sourceWithoutComments("scripts/verify-017.js");

  it("exige la copia antes de comparar o restaurar", () => {
    expect(source()).toMatch(/function requireBackup/);
    expect(source().match(/requireBackup\(/g) ?? []).toHaveLength(3);
  });

  it("no reutiliza el restaurador que omite los pedidos que ya existen", () => {
    expect(source()).not.toMatch(/restore-orders-from-backup/);
  });

  it("usa firebase-admin de functions/node_modules", () => {
    expect(source()).toMatch(/require\(["']\.\.\/functions\/node_modules\/firebase-admin["']\)/);
  });
});
