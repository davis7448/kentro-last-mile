/**
 * Guardas de fuente de la spec 029 — `specs/029_store_api_confirma_y_corrige_pedidos.md`.
 *
 * Un bloque `describe("T<n> · ...")` por tarea (plan 5.2). No editar los bloques de otra tarea.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

describe("T2 · query-check: consultas exactas e indices", () => {
  /*
   * T2 (plan 2.10, 6): `query-check` lanza con `limit(1)` en produccion cada consulta nueva de la carga
   * dirigida e historial, ANTES de escribir los handlers, para que Firestore diga si pide indice. Junto a
   * `array-contains` repite el recuento de cortes con `cashAllocations[].orderId` fuera de `orderIds`
   * (esperado 0): es lo que hace suficiente esa consulta. Solo lee: no entra en WRITE_MODES y su cuerpo
   * no escribe en Firestore. Si alguna pide indice se ANADE a firestore.indexes.json; nada de HEAD se quita.
   *
   * Contrato: `COMMANDS` registra `"query-check": <fn>`; `<fn>` es una funcion de primer nivel
   * (`async function <fn>(`) y escribe `t2-query-check.txt`, con una linea por consulta que diga
   * `indice: no` o `indice: si` y la linea `cashAllocations fuera de orderIds: <n>`.
   */
  const SCRIPT = "scripts/verify-029.js";
  const EVIDENCE = ".sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t2-query-check.txt";
  const INDEXES = "firestore.indexes.json";
  const source = () => sourceWithoutComments(SCRIPT);
  const evidence = () => (existsSync(absolute(EVIDENCE)) ? readFileSync(absolute(EVIDENCE), "utf8") : "");

  function queryCheckName(): string | null {
    const commands = source().match(/const\s+COMMANDS\s*=\s*\{([^}]*)\}/)?.[1] ?? "";
    return commands.match(/["']query-check["']\s*:\s*([A-Za-z_$][\w$]*)/)?.[1] ?? null;
  }

  function queryCheckBody(): string {
    const name = queryCheckName();
    return name ? topLevelFunctionBody(source(), name) ?? "" : "";
  }

  it("COMMANDS registra query-check con una funcion de primer nivel", () => {
    expect(queryCheckName()).not.toBeNull();
    expect(queryCheckBody()).not.toBe("");
  });

  it("query-check no esta en WRITE_MODES", () => {
    const match = source().match(/const\s+WRITE_MODES\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const modes = [...(match?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
    expect(modes).not.toContain("query-check");
  });

  it.each(WRITE_CALLS)("el cuerpo de query-check no escribe en Firestore: %s", (writeCall) => {
    expect(queryCheckBody()).not.toBe("");
    expect(queryCheckBody()).not.toContain(writeCall);
  });

  it("lanza las consultas con limit(1)", () => {
    expect(queryCheckBody()).toMatch(/\.limit\(\s*1\s*\)/);
  });

  it("lee un pedido por id (orders/{id})", () => {
    expect(queryCheckBody()).toMatch(/collection\(\s*["']orders["']\s*\)\s*\.doc\(|doc\(\s*[`"']orders\//);
  });

  it("orders por sellerId + shopifyOrderId (dos igualdades, sin `in`: T1 midio solo texto)", () => {
    expect(queryCheckBody()).toMatch(/where\(\s*["']sellerId["']\s*,\s*["']==["']/);
    expect(queryCheckBody()).toMatch(/where\(\s*["']shopifyOrderId["']\s*,\s*["']==["']/);
    expect(queryCheckBody()).not.toMatch(/where\(\s*["']shopifyOrderId["']\s*,\s*["']in["']/);
  });

  it("walletEntries por orderId", () => {
    expect(queryCheckBody()).toMatch(/collection\(\s*["']walletEntries["']\s*\)/);
    expect(queryCheckBody()).toMatch(/where\(\s*["']orderId["']\s*,\s*["']==["']/);
  });

  it("settlements por orderIds array-contains", () => {
    expect(queryCheckBody()).toMatch(/collection\(\s*["']settlements["']\s*\)/);
    expect(queryCheckBody()).toMatch(/where\(\s*["']orderIds["']\s*,\s*["']array-contains["']/);
  });

  it("orderHistory por orderId (orden en memoria, sin orderBy: plan 2.5)", () => {
    expect(queryCheckBody()).toMatch(/collection\(\s*["']orderHistory["']\s*\)/);
    expect(queryCheckBody()).not.toMatch(/\.orderBy\(/);
  });

  it("auditEvents por entityId (lo que une getOrderAuditTrail)", () => {
    expect(queryCheckBody()).toMatch(/collection\(\s*["']auditEvents["']\s*\)/);
    expect(queryCheckBody()).toMatch(/where\(\s*["']entityId["']\s*,\s*["']==["']/);
  });

  it("cities por active", () => {
    expect(queryCheckBody()).toMatch(/collection\(\s*["']cities["']\s*\)/);
    expect(queryCheckBody()).toMatch(/where\(\s*["']active["']\s*,\s*["']==["']/);
  });

  it("registra si Firestore pide indice (FAILED_PRECONDITION / requires an index)", () => {
    expect(queryCheckBody()).toMatch(/FAILED_PRECONDITION|requires an index|code\s*===?\s*9\b/);
  });

  it("repite el recuento de cashAllocations fuera de orderIds", () => {
    expect(queryCheckBody()).toMatch(/cashAllocations/);
    expect(queryCheckBody()).toContain("cashAllocations fuera de orderIds");
  });

  it("escribe la evidencia t2-query-check.txt", () => {
    expect(queryCheckBody()).toContain("t2-query-check.txt");
  });

  it("la evidencia existe", () => {
    expect(existsSync(absolute(EVIDENCE))).toBe(true);
  });

  it("la evidencia nombra cada consulta con su veredicto de indice", () => {
    for (const collection of ["orders", "walletEntries", "settlements", "orderHistory", "auditEvents", "cities"]) {
      expect(evidence()).toMatch(new RegExp(`${collection}[^\\n]*indice:\\s*(si|no)`));
    }
  });

  it("la evidencia no trae errores y lleva el recuento de cashAllocations", () => {
    expect(evidence()).not.toBe("");
    expect(evidence()).not.toMatch(/^\s*error\b|\bError:|FAILED_PRECONDITION|PERMISSION_DENIED/im);
    expect(evidence()).toMatch(/cashAllocations fuera de orderIds:\s*\d+/);
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

describe("T6b · RF_19 anti-copia", () => {
  /**
   * Las tres callables del panel delegan en el ejecutor de T6 (politica `panel`) y no conservan su propia
   * copia de la regla. El cuerpo de cada una se extrae por su nombre exportado: desde
   * `^export const <name> = onCall(` hasta el primer `\n});\n` (cierre en columna 0). Si una callable deja
   * de tener esa forma, la guarda cae en rojo por no encontrarla; no pasa en silencio.
   */
  const ORDERS = "functions/src/orders.ts";
  const NUCLEO = "functions/src/order-seller-actions.ts";

  function exportedCallableBody(source: string, name: string): string | null {
    const start = source.search(new RegExp(`^export const ${name}\\s*=\\s*onCall\\(`, "m"));
    if (start < 0) return null;
    const end = source.indexOf("\n});\n", start);
    return source.slice(start, end < 0 ? undefined : end + 4);
  }

  const CALLABLES = [
    { name: "confirmImportedOrder", runner: "runConfirm" },
    { name: "updateImportedOrder", runner: "runDeliveryCorrection" },
    { name: "cancelOrder", runner: "runCancel" },
  ] as const;

  const FORBIDDEN = [/status:\s*"ready_to_assign"/, /status:\s*"cancelled"/, /addressRisk:\s*"accepted"/, /\[MANUAL_EDIT_STAMP\]/];

  for (const { name, runner } of CALLABLES) {
    it(`${name} llama a ${runner}(`, () => {
      const body = exportedCallableBody(sourceWithoutComments(ORDERS), name);
      expect(body, `no se encontro export const ${name} = onCall(`).not.toBeNull();
      expect(body).toContain(`${runner}(`);
    });

    it(`${name} no conserva su propio parche (estado, addressRisk, sello)`, () => {
      const body = exportedCallableBody(sourceWithoutComments(ORDERS), name) ?? "";
      expect(body).not.toBe("");
      for (const pattern of FORBIDDEN) expect(body).not.toMatch(pattern);
    });
  }

  it("orders.ts importa los tres ejecutores de order-seller-actions-run", () => {
    const source = sourceWithoutComments(ORDERS);
    for (const runner of ["runConfirm", "runDeliveryCorrection", "runCancel"]) {
      expect(source).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${runner}\\b[^}]*\\}\\s*from\\s*["']\\./order-seller-actions-run["']`));
    }
  });

  it("updateImportedOrder traduce producto y extras: resolveEditedOrderLines( y panelExtras", () => {
    const body = exportedCallableBody(sourceWithoutComments(ORDERS), "updateImportedOrder") ?? "";
    expect(body).toContain("resolveEditedOrderLines(");
    expect(body).toContain("panelExtras");
  });

  it("cancelOrder ya no tiene su lista literal de estados cerrados", () => {
    const body = exportedCallableBody(sourceWithoutComments(ORDERS), "cancelOrder") ?? "";
    expect(body).not.toBe("");
    expect(body).not.toMatch(/"delivered",\s*"failed",\s*"cancelled",\s*"liquidated"/);
  });

  it("el parche de cancelar del nucleo conserva driverId ?? null sobre el pedido leido", () => {
    const source = sourceWithoutComments(NUCLEO);
    const start = source.search(/^export function planCancel\s*\(/m);
    expect(start, "no se encontro export function planCancel(").toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end < 0 ? undefined : end + 2);
    expect(body).toMatch(/driverId:\s*(?:current|order)\.driverId\s*\?\?\s*null/);
  });
});

describe("T7 · reglas: historial e idempotencia cerrados, settings/storeApi fuera del cliente", () => {
  /**
   * Se lee `firestore.rules` como texto sin comentarios. Un bloque `match /<coleccion>/{...} {` se extrae
   * contando llaves desde su apertura. Las fuentes se barren recursivamente (sin `node_modules` ni archivos
   * de prueba `*.test.*` / `*.spec.*`).
   */
  const RULES = "firestore.rules";
  const VERIFY = "scripts/verify-029.js";
  const SOURCE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/;
  const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

  function rulesSource(): string {
    return readFileSync(absolute(RULES), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
      .replace(/\/\/.*$/gm, "");
  }

  function matchBlock(rules: string, collection: string): string | null {
    const start = rules.search(new RegExp(`match\\s+/${collection}/\\{[^}]+\\}\\s*\\{`));
    if (start < 0) return null;
    let depth = 0;
    for (let i = rules.indexOf("{", rules.indexOf("}", start)); i < rules.length; i++) {
      if (rules[i] === "{") depth++;
      else if (rules[i] === "}" && --depth === 0) return rules.slice(start, i + 1);
    }
    return rules.slice(start);
  }

  function sourceFiles(dir: string): string[] {
    if (!existsSync(absolute(dir))) return [];
    const out: string[] = [];
    for (const entry of readdirSync(absolute(dir))) {
      if (entry === "node_modules") continue;
      const rel = `${dir}/${entry}`;
      if (statSync(absolute(rel)).isDirectory()) out.push(...sourceFiles(rel));
      else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(rel);
    }
    return out;
  }

  for (const collection of ["orderHistory", "storeApiIdempotency", "storeApiRateLimits"]) {
    it(`match /${collection}/{...} existe con allow read, write: if false y nada mas`, () => {
      const block = matchBlock(rulesSource(), collection);
      expect(block, `no hay bloque match /${collection}/{...} en firestore.rules`).not.toBeNull();
      expect(block).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;/);
      const allows = block!.match(/allow\s+[^;]*;/g) ?? [];
      expect(allows, `allow en ${collection}`).toHaveLength(1);
    });
  }

  it('settings: un unico allow write con isAdmin() && settingId != "storeApi"; lectura sin cambios', () => {
    const block = matchBlock(rulesSource(), "settings");
    expect(block, "no hay bloque match /settings/{settingId}").not.toBeNull();
    expect(block).toMatch(/allow\s+read\s*:\s*if\s+signedIn\(\)\s*;/);
    const writes = block!.match(/allow\s+[^;:]*\b(?:write|create|update|delete)\b[^;]*;/g) ?? [];
    expect(writes, "reglas de escritura en settings").toHaveLength(1);
    expect(writes[0]).toMatch(/^allow\s+write\s*:/);
    expect(writes[0]).toContain("isAdmin()");
    expect(writes[0]).toMatch(/settingId\s*!=\s*["']storeApi["']/);
    expect(writes[0]).not.toMatch(/\|\|/);
  });

  it("ninguna fuente de src/ ni functions/src/ asocia un literal de fecha a historySince", () => {
    const DATE_LITERAL = /["'`]\d{4}-\d{2}-\d{2}|new Date\(\s*\d|Date\.UTC\(\s*\d/;
    const offenders: string[] = [];
    for (const file of [...sourceFiles("src"), ...sourceFiles("functions/src")]) {
      const lines = sourceWithoutComments(file).split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("historySince")) return;
        const around = lines.slice(Math.max(0, index - 2), index + 3).join("\n");
        if (DATE_LITERAL.test(around)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("nadie hace delete/update sobre orderHistory salvo el cleanup de scripts/verify-029.js", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("src"), ...sourceFiles("functions/src"), ...sourceFiles("scripts")]) {
      let source = sourceWithoutComments(file);
      if (file === VERIFY) {
        const cleanup = topLevelFunctionBody(source, "cleanup");
        if (cleanup) source = source.replace(cleanup, "");
      }
      if (!source.includes("orderHistory")) continue;
      if (/["'`]orderHistory["'`][^;]{0,300}?\.(?:delete|update)\(/.test(source)) offenders.push(`${file}: cadena directa`);
      const refs = [...source.matchAll(/(?:const|let|var)\s+(\w+)[^=;]*=\s*[^;]*["'`]orderHistory["'`]/g)].map((m) => m[1]);
      for (const ref of refs) {
        const use = new RegExp(`\\b${ref}\\s*\\.\\s*(?:delete|update)\\(|\\.(?:delete|update)\\(\\s*${ref}\\b`);
        if (use.test(source)) offenders.push(`${file}: via ${ref}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("T8 · limite unico, contenido de entrega en el nucleo y parseWriteBody sin 422", () => {
  /*
   * Contrato (plan 2.9, 4.4; tarea T8): el limite de tasa vive solo en `STORE_API_WRITES_PER_MINUTE`
   * (`functions/src/store-api-request.ts`); ese modulo no repite las reglas de contenido de los datos de entrega
   * (las toma de `validateDeliveryInput`, T5) ni el maximo del motivo (`CANCEL_REASON_MAX_LENGTH`), y
   * `parseWriteBody` calcula errores de campo pero nunca responde un 422: lo responde el nucleo en el paso 6.
   */
  const REQUEST = "functions/src/store-api-request.ts";
  const request = () => sourceWithoutComments(REQUEST);

  function functionsSources(dir = "functions/src"): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(absolute(dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(absolute(rel)).isDirectory()) out.push(...functionsSources(rel));
      else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(rel);
    }
    return out;
  }

  /** Cuerpo de `[export] function name(` hasta su `}` de columna 0. */
  function exportedFunctionBody(source: string, name: string): string | null {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[<(]`, "m"));
    if (start < 0) return null;
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end < 0 ? undefined : end + 2);
  }

  it("store-api-request.ts existe", () => {
    expect(existsSync(absolute(REQUEST))).toBe(true);
  });

  it("declara `export const STORE_API_WRITES_PER_MINUTE = 120` y la cifra no aparece otra vez en el modulo", () => {
    const source = request();
    expect(source).toMatch(/export\s+const\s+STORE_API_WRITES_PER_MINUTE\s*=\s*120\s*;/);
    expect(source.match(/\b120\b/g) ?? []).toHaveLength(1);
  });

  it("ningun otro archivo de functions/src declara el limite", () => {
    const offenders = functionsSources()
      .filter((file) => file !== REQUEST)
      .filter((file) => /STORE_API_WRITES_PER_MINUTE\s*=/.test(sourceWithoutComments(file)));
    expect(offenders).toEqual([]);
  });

  it("quien toca la tasa (storeApiRateLimits / rate_limited) no escribe la cifra: importa la constante", () => {
    const offenders: string[] = [];
    for (const file of functionsSources()) {
      if (file === REQUEST) continue;
      const source = sourceWithoutComments(file);
      if (!/storeApiRateLimits|rate_limited|rateWindow/.test(source)) continue;
      if (/\b120\b/.test(source)) offenders.push(`${file}: literal 120`);
      if (!/\bSTORE_API_WRITES_PER_MINUTE\b/.test(source)) offenders.push(`${file}: sin STORE_API_WRITES_PER_MINUTE`);
    }
    expect(offenders).toEqual([]);
  });

  it("importa validateDeliveryInput y CANCEL_REASON_MAX_LENGTH de ./order-seller-actions", () => {
    const imports = [...request().matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/order-seller-actions["']/g)]
      .map((match) => match[1])
      .join(",");
    expect(imports).toMatch(/\bvalidateDeliveryInput\b/);
    expect(imports).toMatch(/\bCANCEL_REASON_MAX_LENGTH\b/);
    expect(request()).toMatch(/\bvalidateDeliveryInput\s*\(/);
  });

  it.each([
    ["patron de telefono de 10 digitos", /\\d\{10\}/],
    ["prefijo +57 en una expresion regular", /\\\+57/],
    ["patron E.164", /\[1-9\]\\d\{7,14\}/],
    ["patron de cityId", /\[a-z0-9-\]\{1,64\}/],
    ["separadores de telefono", /\[\\s\\-\.\(\)\]/]
  ])("no repite reglas de contenido: %s", (_label, pattern) => {
    expect(request()).not.toMatch(pattern);
  });

  it.each([
    ["maximo de direccion (300)", /\b300\b/],
    ["maximo del motivo escrito a mano (500 junto a reason/length)", /(?:reason|length)[^\n;]{0,60}\b500\b|\b500\b[^\n;]{0,60}(?:reason|length)/]
  ])("no repite limites de contenido fuera de los textos: %s", (_label, pattern) => {
    // Fuera de los textos: un mensaje en espanol puede nombrar el limite sin ser una regla.
    const codeOnly = request().replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
    expect(codeOnly).not.toMatch(pattern);
  });

  it("parseWriteBody existe y nunca devuelve un 422 ni construye el error de campo", () => {
    const body = exportedFunctionBody(request(), "parseWriteBody");
    expect(body).not.toBeNull();
    expect(body).not.toMatch(/\b422\b/);
    expect(body).not.toContain("buildFieldError(");
    expect(body).not.toMatch(/["'`](?:validation_failed|field_not_allowed|no_fields)["'`]/);
  });

  it("store-api-request.ts es puro: sin firebase-admin ni firebase-functions", () => {
    expect(request()).not.toMatch(/from\s+["']firebase-(?:admin|functions)/);
  });
});

describe("T10 · RNF_05", () => {
  /*
   * Carga dirigida (plan 2.10, 5.2): `functions/src/store-api-write.ts` (rutas nuevas y filtro `shopifyOrderId`) nunca
   * baja la tienda entera ni todos los cortes. Cada sentencia que filtra por `sellerId` lleva un segundo `.where(`.
   * Y `store-api.ts` ya no compara keys por su cuenta: la unica regla de credenciales es `resolveStoreCredentials`
   * (T3), la unica con comparaciones en tiempo constante.
   */
  const WRITE_MODULE = "functions/src/store-api-write.ts";
  const LEGACY_MODULE = "functions/src/store-api.ts";
  const AUTH_MODULE = "functions/src/store-api-auth.ts";
  const SELLER_FILTER = /\.where\(\s*["'`]sellerId["'`]\s*,\s*["'`]==["'`]/;

  it("store-api-write.ts existe", () => {
    expect(existsSync(absolute(WRITE_MODULE))).toBe(true);
  });

  it("store-api-write.ts no filtra por sellerId sin un segundo filtro en la misma consulta", () => {
    const source = existsSync(absolute(WRITE_MODULE)) ? sourceWithoutComments(WRITE_MODULE) : "";
    const statements = source.split(";").filter((statement) => SELLER_FILTER.test(statement));
    for (const statement of statements) {
      const whereCount = (statement.match(/\.where\(/g) ?? []).length;
      expect(whereCount, statement.trim()).toBeGreaterThanOrEqual(2);
    }
  });

  it("store-api-write.ts no lee la coleccion settlements entera", () => {
    const source = existsSync(absolute(WRITE_MODULE)) ? sourceWithoutComments(WRITE_MODULE) : "";
    expect(source).not.toMatch(/collection\(\s*["'`]settlements["'`]\s*\)\s*\.get\(\s*\)/);
  });

  it("store-api.ts no conserva una comparacion de key propia", () => {
    const source = sourceWithoutComments(LEGACY_MODULE);
    expect(source).not.toMatch(/\bsafeEqual\(/);
    expect(source).not.toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(/function\s+safeEqual\b/);
  });

  it("store-api.ts resuelve credenciales con resolveStoreCredentials", () => {
    const source = sourceWithoutComments(LEGACY_MODULE);
    expect(source).toMatch(/import\s*\{[^}]*\bresolveStoreCredentials\b[^}]*\}\s*from\s*["']\.\/store-api-auth["']/);
    expect(source).toMatch(/resolveStoreCredentials\(/);
  });

  it("entre los modulos store-api*.ts, solo store-api-auth.ts compara en tiempo constante", () => {
    const dir = absolute("functions/src");
    const modules = readdirSync(dir).filter((name) => /^store-api.*\.ts$/.test(name));
    for (const name of modules) {
      const source = sourceWithoutComments(`functions/src/${name}`);
      const compares = /\bsafeEqual\(|timingSafeEqual\(/.test(source);
      expect(compares, name).toBe(`functions/src/${name}` === AUTH_MODULE);
    }
  });
});

describe("T11 · rutas de escritura: delegan en el ejecutor y no escriben pedidos", () => {
  /*
   * RF_19, regla de oro 1 (plan 2.2): las rutas `POST /confirm`, `PATCH` y `POST /cancel` de la Store API son
   * adaptadores. Traducen la peticion al ejecutor (`runConfirm` / `runDeliveryCorrection` / `runCancel` de
   * `order-seller-actions-run.ts`) y su rechazo a HTTP (`mapRejectionToResponse`). No escriben en `orders`, ni
   * conservan copia del parche (nota 10 de la pasada final: la anti-copia de T6b tambien cubre este modulo).
   *
   * Los handlers viven en `functions/src/store-api-write.ts`; `store-api.ts` solo despacha. `store-api.ts`
   * cablea el borrado de campos de produccion (`FieldValue.delete()`) que el ejecutor recibe por `deps`.
   */
  const WRITE_MODULE = "functions/src/store-api-write.ts";
  const LEGACY_MODULE = "functions/src/store-api.ts";
  const RUNNERS = ["runConfirm", "runDeliveryCorrection", "runCancel"] as const;
  const FORBIDDEN = [/status:\s*"ready_to_assign"/, /status:\s*"cancelled"/, /addressRisk:\s*"accepted"/, /\[MANUAL_EDIT_STAMP\]/];
  const ORDER_WRITE = /\.(?:set|update|create|delete)\(/;

  const writeSource = () => sourceWithoutComments(WRITE_MODULE);

  it("store-api-write.ts importa los tres ejecutores de order-seller-actions-run", () => {
    for (const runner of RUNNERS) {
      expect(writeSource()).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${runner}\\b[^}]*\\}\\s*from\\s*["']\\./order-seller-actions-run["']`));
    }
  });

  it.each(RUNNERS)("store-api-write.ts llama a %s(", (runner) => {
    expect(writeSource()).toContain(`${runner}(`);
  });

  it("store-api-write.ts llama a los ejecutores con politica api", () => {
    expect(writeSource()).toMatch(/policy:\s*"api"/);
  });

  it("store-api-write.ts exporta mapRejectionToResponse", () => {
    expect(writeSource()).toMatch(/export\s+function\s+mapRejectionToResponse\s*\(/);
  });

  it.each(FORBIDDEN.map((pattern) => [String(pattern), pattern] as const))(
    "store-api-write.ts no conserva copia del parche: %s",
    (_label, pattern) => {
      expect(writeSource()).not.toMatch(pattern);
    }
  );

  it.each([WRITE_MODULE, LEGACY_MODULE])("%s no escribe en orders (ninguna sentencia con collection(\"orders\") y una escritura)", (file) => {
    const statements = sourceWithoutComments(file).split(";").filter((statement) => /collection\(\s*["'`]orders["'`]\s*\)/.test(statement));
    for (const statement of statements) expect(statement.trim()).not.toMatch(ORDER_WRITE);
  });

  it("store-api-write.ts no abre transacciones ni lotes propios sobre pedidos", () => {
    const source = writeSource();
    expect(source).not.toMatch(/\.batch\(/);
    const transactional = source.split(";").filter((statement) => /runTransaction\(/.test(statement));
    for (const statement of transactional) expect(statement).not.toMatch(/["'`]orders["'`]/);
  });

  it("store-api-write.ts no importa el sello ni los planificadores puros (decide el nucleo, escribe el ejecutor)", () => {
    const source = writeSource();
    expect(source).not.toMatch(/\bMANUAL_EDIT_STAMP\b/);
    expect(source).not.toMatch(/\bplan(?:Confirm|DeliveryCorrection|Cancel)\(/);
  });

  it("store-api.ts cablea FieldValue.delete() como deleteField de produccion", () => {
    const source = sourceWithoutComments(LEGACY_MODULE);
    expect(source).toMatch(/FieldValue\.delete\(\)/);
    expect(source).toMatch(/\bdeleteField\b/);
  });
});

describe("T14 · getOrderAuditTrail no resuelve identidades para la tienda", () => {
  /*
   * RF_27 (plan 2.7): para `seller` / `seller_logistics` la identidad no se oculta despues de resolverla:
   * no se resuelve. La llamada a `resolveAuditActors(` de la callable vive en una rama que excluye a los roles
   * de tienda (un `if (!esTienda)`, un `else` de un `if (esTienda)` o un ternario `esTienda ? ... : resolver`).
   * La callable devuelve `{ events, historySince }` (directo o via `buildAuditTrailResponse(`) y lee
   * `orderHistory` para unir por `auditEventId`. Las plantillas `summary:` de las acciones de la lista permitida
   * no interpolan variables de actor.
   */
  const ORDERS = "functions/src/orders.ts";

  function callableBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*onCall\\(`, "m"));
    if (start < 0) throw new Error(`no se encontro export const ${name} = onCall(`);
    const end = source.indexOf("\n});\n", start);
    return source.slice(start, end < 0 ? undefined : end + 4);
  }

  /** Cabecera del bloque `{` sin cerrar que contiene la posicion `at` (texto entre el `;`/`{`/`}` previo y la llave). */
  function enclosingHeaders(body: string, at: number): string[] {
    const headers: string[] = [];
    let depth = 0;
    for (let index = at - 1; index >= 0; index -= 1) {
      const char = body[index];
      if (char === "}") depth += 1;
      else if (char === "{") {
        if (depth === 0) {
          const before = body.slice(0, index);
          const cut = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"));
          headers.push(before.slice(cut + 1).trim());
          // Para un `else`, la cabecera del `if` hermano.
          if (/^else$/.test(headers[headers.length - 1])) {
            const ifStart = before.slice(0, cut + 1);
            let ifDepth = 0;
            for (let back = ifStart.length - 1; back >= 0; back -= 1) {
              if (ifStart[back] === "}") ifDepth += 1;
              else if (ifStart[back] === "{") {
                ifDepth -= 1;
                if (ifDepth === 0) {
                  const head = ifStart.slice(0, back);
                  const headCut = Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
                  headers.push(`else-of: ${head.slice(headCut + 1).trim()}`);
                  break;
                }
              }
            }
          }
        } else depth -= 1;
      }
    }
    return headers;
  }

  const STORE_REF = /seller|store|tienda/i;

  function isExcludingStoreBranch(body: string, at: number): boolean {
    const statementStart = Math.max(body.lastIndexOf(";", at), body.lastIndexOf("{", at), body.lastIndexOf("}", at));
    const statement = body.slice(statementStart + 1, at);
    // Ternario: `esTienda ? <sin resolver> : resolveAuditActors(`
    const ternary = statement.match(/(?:[^=!<>]=(?!=)|\breturn\b)\s*([^?]*)\?[^:]*:\s*(?:await\s*)?$/);
    if (ternary && STORE_REF.test(ternary[1]) && !/^\s*\(?\s*!/.test(ternary[1])) return true;
    for (const header of enclosingHeaders(body, at)) {
      if (header.startsWith("else-of: ")) {
        const condition = header.slice("else-of: ".length);
        if (/^if\s*\(/.test(condition) && STORE_REF.test(condition) && !/^if\s*\(\s*!/.test(condition)) return true;
        continue;
      }
      if (/^if\s*\(/.test(header) && STORE_REF.test(header)) {
        const condition = header.replace(/^if\s*\(/, "").replace(/\)\s*$/, "");
        if (/^\s*!/.test(condition) || /!==\s*["'`]seller/.test(condition)) return true;
      }
    }
    return false;
  }

  it.each([
    ["if (!esTienda)", "x = 1;\n  if (!isStoreRole(role)) {\n    actors = await resolveAuditActors(ids);\n  }\n", true],
    ["else de if (esTienda)", "x = 1;\n  if (isStoreRole(role)) {\n    a = 1;\n  } else {\n    actors = await resolveAuditActors(ids);\n  }\n", true],
    ["ternario esTienda ? : resolver", "x = 1;\n  const actors = isStoreRole(role) ? undefined : await resolveAuditActors(ids);\n", true],
    ["if (role !== seller && ...)", "x = 1;\n  if (role !== \"seller\" && role !== \"seller_logistics\") {\n    actors = await resolveAuditActors(ids);\n  }\n", true],
    ["sin rama", "x = 1;\n  const actors = await resolveAuditActors(ids);\n", false],
    ["if (esTienda) positivo", "x = 1;\n  if (isStoreRole(role)) {\n    actors = await resolveAuditActors(ids);\n  }\n", false],
    ["ternario negado", "x = 1;\n  const actors = !isStoreRole(role) ? undefined : await resolveAuditActors(ids);\n", false]
  ] as const)("el detector de rama clasifica el caso: %s", (_label, snippet, expected) => {
    expect(isExcludingStoreBranch(snippet, snippet.indexOf("resolveAuditActors("))).toBe(expected);
  });

  it("la callable llama a resolveAuditActors una sola vez", () => {
    const body = callableBody(sourceWithoutComments(ORDERS), "getOrderAuditTrail");
    expect(body.match(/resolveAuditActors\(/g) ?? []).toHaveLength(1);
  });

  it("la llamada a resolveAuditActors esta en la rama que excluye a seller y seller_logistics", () => {
    const body = callableBody(sourceWithoutComments(ORDERS), "getOrderAuditTrail");
    const at = body.indexOf("resolveAuditActors(");
    expect(at).toBeGreaterThan(-1);
    expect(isExcludingStoreBranch(body, at)).toBe(true);
  });

  it("la callable no llama a getUsers( por su cuenta", () => {
    const body = callableBody(sourceWithoutComments(ORDERS), "getOrderAuditTrail");
    expect(body).not.toMatch(/getUsers\(/);
  });

  it("la callable lee orderHistory para unir por auditEventId", () => {
    const body = callableBody(sourceWithoutComments(ORDERS), "getOrderAuditTrail");
    expect(body).toMatch(/collection\(\s*["'`]orderHistory["'`]\s*\)/);
  });

  it("la callable devuelve { events, historySince }", () => {
    const body = callableBody(sourceWithoutComments(ORDERS), "getOrderAuditTrail");
    const direct = /return\s*\{\s*events\s*,\s*historySince\s*\}/.test(body);
    const viaBuilder = /return\s+buildAuditTrailResponse\(/.test(body);
    expect(direct || viaBuilder).toBe(true);
    expect(body).not.toMatch(/return\s*\{\s*events\s*\}\s*;/);
  });

  describe("plantillas summary: de la lista permitida sin variables de actor", () => {
    const ALLOWED = [
      "order.seller_confirmed", "order.imported_updated", "order.cancelled", "order.retry_confirmed", "order.transition",
      "order.delivered", "order.failed", "order.retry_scheduled", "order.webhook_imported", "order.manual_created",
      "order.confirmed_uchat", "order.failed_classified", "order.delivery_corrected", "order.address_reviewed", "order.picked_up"
    ];
    const ACTOR_VARS = /\b(actorId|uid|messengerId|driverId|email|displayName|messengerName|driverName|userName|fullName|leaderName)\b/;

    function functionsSources(): Array<[string, string]> {
      const dir = absolute("functions/src");
      return readdirSync(dir)
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => [`functions/src/${file}`, sourceWithoutComments(`functions/src/${file}`)] as [string, string]);
    }

    /** Objeto literal `{ ... }` que contiene la posicion `at`. */
    function enclosingObject(source: string, at: number): string {
      let depth = 0;
      let open = -1;
      for (let index = at; index >= 0; index -= 1) {
        if (source[index] === "}") depth += 1;
        else if (source[index] === "{") {
          if (depth === 0) { open = index; break; }
          depth -= 1;
        }
      }
      if (open < 0) return "";
      depth = 0;
      for (let index = open; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(open, index + 1);
        }
      }
      return source.slice(open);
    }

    /** Expresion del `summary:` hasta la siguiente propiedad o el cierre del objeto. */
    function summaryExpression(objectText: string): string | null {
      const start = objectText.search(/\bsummary\s*:/);
      if (start < 0) return null;
      const rest = objectText.slice(start);
      const end = rest.slice(1).search(/,\s*\n\s*[A-Za-z_$][\w$]*\??\s*:|\n\s*\}/);
      return end < 0 ? rest : rest.slice(0, end + 1);
    }

    function templates(): Array<{ file: string; action: string; summary: string }> {
      const found: Array<{ file: string; action: string; summary: string }> = [];
      for (const [file, source] of functionsSources()) {
        const actionProp = /\baction\s*:[^\n]*/g;
        for (const match of source.matchAll(actionProp)) {
          const actions = ALLOWED.filter((action) => match[0].includes(`"${action}"`));
          if (actions.length === 0) continue;
          const summary = summaryExpression(enclosingObject(source, match.index ?? 0));
          if (summary) for (const action of actions) found.push({ file, action, summary });
        }
      }
      return found;
    }

    it("encuentra plantillas de la lista permitida (la guarda no es vacia)", () => {
      expect(templates().length).toBeGreaterThanOrEqual(5);
    });

    it("ninguna plantilla summary: de la lista permitida interpola variables de actor", () => {
      const offenders = templates().filter((template) => ACTOR_VARS.test(template.summary));
      expect(offenders).toEqual([]);
    });
  });
});
