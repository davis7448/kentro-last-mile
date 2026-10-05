/**
 * Guardas de fuente de la spec 029 — `specs/029_store_api_confirma_y_corrige_pedidos.md`.
 *
 * Un bloque `describe("T<n> · ...")` por tarea (plan 5.2). No editar los bloques de otra tarea.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

/*
 * T18: los envoltorios de cliente se prueban ejecutandolos, no por texto. `vi.mock` se eleva al inicio del
 * archivo; los demas bloques solo leen fuentes, asi que no les afecta. `httpsCallable` registra el nombre
 * pedido y devuelve lo que haya en `t18Callables.responses[nombre]`.
 */
const t18Callables = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; payload: unknown }>,
  responses: {} as Record<string, unknown>
}));

vi.mock("firebase/functions", () => ({
  getFunctions: () => ({}),
  httpsCallable: (_functions: unknown, name: string) => async (payload: unknown) => {
    t18Callables.calls.push({ name, payload });
    return { data: t18Callables.responses[name] };
  }
}));

vi.mock("./firebase/client", () => ({
  getFirebaseClient: () => ({ app: {} }),
  clearFirebaseLocalCache: async () => undefined
}));

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

describe("T15 · historial en confirmar reintento, ajuste, transicion y cierre (RF_16)", () => {
  /*
   * Plan 2.6: las cuatro callables del panel que cambian campos registrados escriben
   * `buildOrderHistoryRecord(...)` con `origin: "panel"` y el `auditEventId` de SU evento, con
   * `transaction.set(` dentro de su `runTransaction(` (mismo commit que el pedido y el auditEvent).
   * Cada cuerpo se extrae por su nombre exportado (`^export const <name> = onCall(` hasta el primer `\n});\n`,
   * mismo patron que T6b); si una callable deja de tener esa forma, la guarda cae en rojo.
   */
  const ORDERS = "functions/src/orders.ts";
  const CALLABLES = ["confirmRetryOrder", "updateOrderAdjustments", "applyOrderTransition", "closeOrder"] as const;

  function exportedCallableBody(source: string, name: string): string | null {
    const start = source.search(new RegExp(`^export const ${name}\\s*=\\s*onCall\\(`, "m"));
    if (start < 0) return null;
    const end = source.indexOf("\n});\n", start);
    return source.slice(start, end < 0 ? undefined : end + 4);
  }

  function bodyOf(name: string): string {
    const body = exportedCallableBody(sourceWithoutComments(ORDERS), name);
    expect(body, `no se encontro export const ${name} = onCall(`).not.toBeNull();
    return body ?? "";
  }

  /** Variables que apuntan a `collection("orderHistory")` dentro del cuerpo. */
  function historyRefVars(body: string): string[] {
    return [...body.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;]*collection\(\s*["']orderHistory["']\s*\)/g)].map((m) => m[1]);
  }

  /** Posiciones de `transaction.set(` cuyo primer argumento es una ref de `orderHistory` (literal o variable). */
  function historyWritesInTransaction(body: string): number[] {
    const vars = historyRefVars(body);
    const positions: number[] = [];
    for (const match of body.matchAll(/\btransaction\.(?:set|create)\(\s*([^,]+),/g)) {
      const target = match[1].trim();
      if (/collection\(\s*["']orderHistory["']\s*\)/.test(target) || vars.includes(target)) positions.push(match.index ?? 0);
    }
    return positions;
  }

  for (const name of CALLABLES) {
    describe(name, () => {
      it("llama a buildOrderHistoryRecord(", () => {
        expect(bodyOf(name)).toContain("buildOrderHistoryRecord(");
      });

      it('escribe en collection("orderHistory") con transaction.set( dentro de su runTransaction(', () => {
        const body = bodyOf(name);
        const txStart = body.indexOf("runTransaction(");
        expect(txStart, `${name} no abre runTransaction(`).toBeGreaterThanOrEqual(0);
        const writes = historyWritesInTransaction(body);
        expect(writes.length, `${name} no hace transaction.set( sobre orderHistory`).toBeGreaterThan(0);
        for (const at of writes) expect(at).toBeGreaterThan(txStart);
      });

      it('pasa origin: "panel"', () => {
        expect(bodyOf(name)).toMatch(/origin:\s*["']panel["']/);
      });

      it("pasa el auditEventId de su propio evento (la ref de newAuditRef)", () => {
        const body = bodyOf(name);
        const auditVars = [...body.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*newAuditRef\(/g)].map((m) => m[1]);
        expect(auditVars.length, `${name} no crea su auditEvent con newAuditRef(`).toBeGreaterThan(0);
        const linked = auditVars.some((v) => new RegExp(`auditEventId:\\s*${v}\\.id\\b`).test(body));
        expect(linked, `${name} no pasa auditEventId: <auditRef>.id`).toBe(true);
      });
    });
  }

  it("orders.ts importa buildOrderHistoryRecord del nucleo", () => {
    expect(sourceWithoutComments(ORDERS)).toMatch(
      /import\s*\{[^}]*\bbuildOrderHistoryRecord\b[^}]*\}\s*from\s*["']\.\/order-seller-actions["']/
    );
  });
});

describe("T16 · historial por nombre: mensajero, recogida y correcciones (RF_16, RF_24)", () => {
  /*
   * Plan 2.6: clasificacion POR NOMBRE de cada `export const X = onCall(`/`onRequest(` de
   * `functions/src/orders.ts` y `functions/src/order-corrections.ts`. Sin detector generico de escrituras
   * y sin tocar `spec-017-guards.test.ts`. Una callable nueva en estos dos archivos sin clasificar pone
   * esta guarda en rojo: hay que decidir en cual de las dos listas va, con su razon.
   *
   * Fuera de esta guarda, por la spec:
   * - las cinco vias de importacion y ChatBy (`shopify.ts`, `index.ts`, `store-webhook.ts`,
   *   `onstock-webhook.ts`, `contact-form.ts`, `uchat-pull.ts`, `uchat-webhook.ts`) viven en otros archivos y
   *   quedan fuera del historial (spec 031); su escritura en `orders` la sigue vigilando la guarda 1 de la 017;
   * - las escrituras directas del cliente bajo `operationalOrderUpdateByAssignee` no son codigo de servidor
   *   (limite conocido de RF_16, spec 032).
   */
  const FILES = ["functions/src/orders.ts", "functions/src/order-corrections.ts"] as const;

  const REGISTRAN_HISTORIAL = [
    "confirmImportedOrder",
    "updateImportedOrder",
    "cancelOrder",
    "confirmRetryOrder",
    "updateOrderAdjustments",
    "applyOrderTransition",
    "closeOrder",
    "assignMessengerToOrders",
    "unassignMessengerFromOrders",
    "createOrUpdatePickupBatch",
    "correctOrderStatus"
  ] as const;

  const EXCLUIDAS_DEL_HISTORIAL: Record<string, string> = {
    createManualOrder: "crea el pedido; RF_16 cubre cambios de un pedido existente",
    classifyFailedOrder: "solo cambia failedCategory, que no es estado ni dato de entrega",
    getOrderAuditTrail: "solo lee",
    createMessengerProfile: "crea un perfil de mensajero; no toca pedidos",
    reconcileInventoryReservations: "recalcula reservas de inventario; lee pedidos, no los escribe",
    createSettlement: "corte financiero: escribe settlements y marca walletEntries, no pedidos",
    updateSettlementStatus: "cambia el estado de un corte y sus asientos, no de un pedido",
    recordDriverCashReceipt: "recibo de efectivo del lider: dinero, no pedidos",
    recordSupplierAbono: "abono a proveedor: dinero, no pedidos",
    recordSellerAbono: "abono a tienda: dinero, no pedidos",
    requestSellerPayout: "solicitud de liquidacion (payouts), no pedidos",
    rejectSellerPayout: "rechazo de liquidacion (payouts), no pedidos"
  };

  const WRITERS_THAT_DELEGATE: Record<string, string> = {
    confirmImportedOrder: "runConfirm(",
    updateImportedOrder: "runDeliveryCorrection(",
    cancelOrder: "runCancel("
  };

  function exportedNames(source: string): string[] {
    return [...source.matchAll(/^export const (\w+)\s*=\s*(?:onCall|onRequest)\(/gm)].map((m) => m[1]);
  }

  function exportedBody(source: string, name: string): string | null {
    const start = source.search(new RegExp(`^export const ${name}\\s*=\\s*(?:onCall|onRequest)\\(`, "m"));
    if (start < 0) return null;
    const end = source.indexOf("\n});\n", start);
    return source.slice(start, end < 0 ? undefined : end + 4);
  }

  function bodyOf(name: string): string {
    for (const file of FILES) {
      const body = exportedBody(sourceWithoutComments(file), name);
      if (body) return body;
    }
    expect.fail(`no se encontro export const ${name} = onCall(/onRequest( en ${FILES.join(" ni ")}`);
    return "";
  }

  const realNames = FILES.flatMap((file) => exportedNames(sourceWithoutComments(file)));
  const excluded = Object.keys(EXCLUIDAS_DEL_HISTORIAL);

  describe("(1) las dos listas cubren exactamente las callables reales", () => {
    it("los exports de los dos archivos son exactamente la union de las listas", () => {
      expect([...realNames].sort()).toEqual([...REGISTRAN_HISTORIAL, ...excluded].sort());
    });

    it("ningun nombre esta en las dos listas ni repetido", () => {
      const all = [...REGISTRAN_HISTORIAL, ...excluded];
      expect(new Set(all).size).toBe(all.length);
      expect(REGISTRAN_HISTORIAL.filter((n) => excluded.includes(n))).toEqual([]);
    });

    it("ningun nombre de las listas deja de existir", () => {
      expect([...REGISTRAN_HISTORIAL, ...excluded].filter((n) => !realNames.includes(n))).toEqual([]);
    });

    it("cada excluida lleva su razon", () => {
      for (const [name, reason] of Object.entries(EXCLUIDAS_DEL_HISTORIAL)) {
        expect(reason.trim().length, `${name} sin razon`).toBeGreaterThan(0);
      }
    });

    it("un nombre real no se repite entre los dos archivos", () => {
      expect(new Set(realNames).size).toBe(realNames.length);
    });
  });

  describe("(2) cada callable de REGISTRAN_HISTORIAL contiene un escritor de historial", () => {
    for (const name of REGISTRAN_HISTORIAL) {
      it(name, () => {
        const writer = WRITERS_THAT_DELEGATE[name] ?? "buildOrderHistoryRecord(";
        expect(bodyOf(name), `${name} no contiene ${writer}`).toContain(writer);
      });
    }
  });

  describe("(3) prueba positiva: mensajero y recogida registran con buildOrderHistoryRecord(", () => {
    for (const name of ["createOrUpdatePickupBatch", "assignMessengerToOrders", "unassignMessengerFromOrders"] as const) {
      it(name, () => {
        expect(REGISTRAN_HISTORIAL as readonly string[]).toContain(name);
        expect(bodyOf(name)).toContain("buildOrderHistoryRecord(");
      });
    }

    it("correctOrderStatus registra con buildOrderHistoryRecord( en su batch", () => {
      const body = bodyOf("correctOrderStatus");
      expect(body).toContain("buildOrderHistoryRecord(");
      expect(body).toMatch(/collection\(\s*["']orderHistory["']\s*\)/);
    });

    it('createOrUpdatePickupBatch escribe un evento con action "order.picked_up"', () => {
      expect(bodyOf("createOrUpdatePickupBatch")).toMatch(/action:\s*["']order\.picked_up["']/);
    });

    it('createOrUpdatePickupBatch crea su evento con newAuditRef( y lo enlaza con auditEventId', () => {
      const body = bodyOf("createOrUpdatePickupBatch");
      const auditVars = [...body.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*newAuditRef\(/g)].map((m) => m[1]);
      expect(auditVars.length, "createOrUpdatePickupBatch no crea su auditEvent con newAuditRef(").toBeGreaterThan(0);
      expect(auditVars.some((v) => new RegExp(`auditEventId:\\s*${v}\\.id\\b`).test(body))).toBe(true);
    });
  });

  describe("(4) RF_24: nadie reconstruye historial desde auditEvents", () => {
    function listTs(dir: string): string[] {
      return readdirSync(absolute(dir)).flatMap((entry) => {
        const rel = `${dir}/${entry}`;
        if (statSync(absolute(rel)).isDirectory()) return listTs(rel);
        return rel.endsWith(".ts") && !rel.endsWith(".test.ts") ? [rel] : [];
      });
    }

    /** Posiciones de lecturas (`.where(`/`.get(`) sobre `collection("auditEvents")`, encadenadas o via variable. */
    function auditEventsReads(source: string): number[] {
      const positions: number[] = [];
      const literal = /collection\(\s*["']auditEvents["']\s*\)/g;
      for (const m of source.matchAll(literal)) {
        const after = source.slice((m.index ?? 0) + m[0].length);
        const chain = after.slice(0, after.search(/;|\n\s*\n|,\s*\n/) >>> 0);
        if (/^\s*\.(?:where|get|orderBy|limit)\(/.test(chain) && /\.(?:where|get)\(/.test(chain)) positions.push(m.index ?? 0);
      }
      const vars = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*\w+\.collection\(\s*["']auditEvents["']\s*\)\s*;/g)];
      for (const v of vars) {
        for (const use of source.matchAll(new RegExp(`\\b${v[1]}\\s*\\.(?:where|get)\\(`, "g"))) positions.push(use.index ?? 0);
      }
      return positions;
    }

    it('getOrderAuditTrail es la unica funcion de functions/src que lee collection("auditEvents") con .where(/.get(', () => {
      const offenders: string[] = [];
      let insideTrail = 0;
      for (const file of listTs("functions/src")) {
        const source = sourceWithoutComments(file);
        const reads = auditEventsReads(source);
        if (reads.length === 0) continue;
        const trail = file === "functions/src/orders.ts" ? exportedBody(source, "getOrderAuditTrail") : null;
        const trailStart = trail ? source.indexOf(trail) : -1;
        for (const at of reads) {
          if (trail && at >= trailStart && at < trailStart + trail.length) insideTrail++;
          else offenders.push(`${file}:${source.slice(0, at).split("\n").length}`);
        }
      }
      expect(offenders).toEqual([]);
      expect(insideTrail, "getOrderAuditTrail deberia leer auditEvents").toBeGreaterThan(0);
    });

    it("getOrderAuditTrail no escribe (ni en orderHistory ni en nada)", () => {
      const body = bodyOf("getOrderAuditTrail");
      for (const call of [...WRITE_CALLS, ".add("]) expect(body, `getOrderAuditTrail contiene ${call}`).not.toContain(call);
    });

    it("scripts/verify-029.js no tiene modo que escriba orderHistory (el cleanup solo borra)", () => {
      const source = sourceWithoutComments("scripts/verify-029.js");
      const refVars = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;]*collection\(\s*["']orderHistory["']\s*\)/g)].map((m) => m[1]);
      const chained = [...source.matchAll(/collection\(\s*["']orderHistory["']\s*\)[^;]*?\.(set|add|update|create)\(/g)].map((m) => m[0]);
      expect(chained, "escritura encadenada sobre orderHistory").toEqual([]);
      const viaBatch = [...source.matchAll(/\.(?:set|update|create)\(\s*([^,)]+)/g)]
        .map((m) => m[1].trim())
        .filter((target) => /collection\(\s*["']orderHistory["']\s*\)/.test(target) || refVars.some((v) => new RegExp(`^${v}\\b`).test(target)));
      expect(viaBatch, "set/update/create con destino orderHistory").toEqual([]);
      for (const v of refVars) expect(source).not.toMatch(new RegExp(`\\b${v}\\s*\\.(?:doc\\([^)]*\\)\\s*\\.)?(?:set|add|update|create)\\(`));
    });
  });
});

describe("T17 · callables de la key de escritura (RF_25, RF_26)", () => {
  /*
   * Plan 2.3: `functions/src/store-api-keys.ts` (nuevo) exporta `rotateStoreWriteKey`, `getStoreApiKeyStatus`
   * y `listStoreApiKeys` como `export const X = onCall(`, cerradas por `\n});\n`, y la pura
   * `toStoreApiKeyStatus` (probada en `store-api-auth.test.ts`). Una sola callable para generar y rotar:
   * `rotateStoreWriteKey({ sellerId, rotate })`; `rotate: false` genera (failed-precondition si ya hay key),
   * `rotate: true` rota (failed-precondition si no la hay). Las precondiciones las decide
   * `planWriteKeyChange` DENTRO de la transaccion; la key se genera ANTES (`generateWriteKey(`) y se
   * devuelve DESPUES del commit.
   */
  const FILE = "functions/src/store-api-keys.ts";
  const CALLABLES = ["rotateStoreWriteKey", "getStoreApiKeyStatus", "listStoreApiKeys"] as const;

  const source = (): string => {
    expect(existsSync(absolute(FILE)), `${FILE} no existe`).toBe(true);
    return sourceWithoutComments(FILE);
  };

  function exportedBody(text: string, name: string): string {
    const start = text.search(new RegExp(`^export const ${name}\\s*=\\s*onCall\\(`, "m"));
    expect(start, `no se encontro export const ${name} = onCall(`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf("\n});\n", start);
    return text.slice(start, end < 0 ? undefined : end + 4);
  }

  /** Texto desde `open` hasta su parentesis de cierre (balanceado; ignora parentesis dentro de cadenas simples). */
  function balancedFrom(text: string, open: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return text.slice(open, i + 1);
      }
    }
    return text.slice(open);
  }

  /** Argumentos de cada llamada de escritura `.set(`/`.update(`/`.create(`/`.add(` del texto, con su posicion. */
  function writeCalls(text: string): { at: number; args: string }[] {
    return [...text.matchAll(/\.(?:set|update|create|add)\(/g)].map((m) => ({
      at: m.index ?? 0,
      args: balancedFrom(text, (m.index ?? 0) + m[0].length - 1)
    }));
  }

  function transactionSpan(body: string): { start: number; end: number; text: string } {
    const call = body.indexOf("runTransaction(");
    expect(call, "rotateStoreWriteKey no usa runTransaction(").toBeGreaterThanOrEqual(0);
    const text = balancedFrom(body, call + "runTransaction".length);
    return { start: call, end: call + "runTransaction".length + text.length, text };
  }

  it("el modulo existe y exporta las tres callables como onCall", () => {
    const text = source();
    for (const name of CALLABLES) expect(text).toMatch(new RegExp(`^export const ${name}\\s*=\\s*onCall\\(`, "m"));
  });

  it("exporta la pura toStoreApiKeyStatus", () => {
    expect(source()).toMatch(/^export function toStoreApiKeyStatus\s*\(/m);
  });

  it("no inicializa Firestore ni Auth al cargarse (solo dentro de las callables)", () => {
    // Solo sentencias de primer nivel (columna 0); un helper `function x() { getAuth()... }` es legitimo.
    expect(source()).not.toMatch(/^(?:export\s+)?(?:(?:const|let|var)\s+\w+\s*=\s*)?(?:getFirestore|getAuth|initializeApp)\s*\(/m);
  });

  it("index.ts reexporta las tres desde ./store-api-keys", () => {
    const index = sourceWithoutComments("functions/src/index.ts");
    const match = index.match(/export\s*\{([^}]*)\}\s*from\s*["']\.\/store-api-keys["']/);
    expect(match, "index.ts no tiene export { ... } from \"./store-api-keys\"").not.toBeNull();
    for (const name of CALLABLES) expect(match?.[1]).toMatch(new RegExp(`\\b${name}\\b`));
  });

  describe("rotateStoreWriteKey", () => {
    const body = () => exportedBody(source(), "rotateStoreWriteKey");

    it("rechaza a quien no sea admin ni seller (seller_logistics → permission-denied)", () => {
      const text = body();
      const guard = text.slice(0, Math.max(0, text.indexOf("runTransaction(")));
      expect(guard).toMatch(/HttpsError\(\s*["']permission-denied["']/);
      expect(guard).toMatch(/role\s*!==\s*["']admin["']/);
      expect(guard).toMatch(/role\s*!==\s*["']seller["']/);
      expect(text, "seller_logistics no puede aparecer en la lista de roles que rotan").not.toContain("seller_logistics");
    });

    it("la tienda solo rota la suya: compara el sellerId pedido con el del token", () => {
      expect(body()).toMatch(/token\.sellerId/);
    });

    it("genera la key con generateWriteKey( ANTES de la transaccion", () => {
      const text = body();
      const generated = text.indexOf("generateWriteKey(");
      expect(generated, "no llama a generateWriteKey(").toBeGreaterThanOrEqual(0);
      expect(generated).toBeLessThan(transactionSpan(text).start);
    });

    it("planWriteKeyChange( se decide DENTRO de la transaccion (precondiciones sobre lo leido en ella)", () => {
      expect(transactionSpan(body()).text).toContain("planWriteKeyChange(");
    });

    it("runTransaction( envuelve la escritura de storeApiConfigs y la de auditEvents", () => {
      const text = body();
      const span = transactionSpan(text);
      expect(text).toMatch(/collection\(\s*["']storeApiConfigs["']\s*\)/);
      expect(text).toMatch(/collection\(\s*["']auditEvents["']\s*\)/);
      const inside = writeCalls(span.text);
      expect(inside.length, "la transaccion deberia escribir config y evento").toBeGreaterThanOrEqual(2);
      expect(inside.some((call) => /\.fields\b/.test(call.args)), "ninguna escritura usa los fields del plan").toBe(true);
      expect(inside.some((call) => /\.auditEvent\b/.test(call.args)), "ninguna escritura usa el auditEvent del plan").toBe(true);
    });

    it("no escribe nada fuera de la transaccion", () => {
      const text = body();
      const span = transactionSpan(text);
      const outside = writeCalls(text).filter((call) => call.at < span.start || call.at >= span.end);
      expect(outside.map((call) => call.args.slice(0, 60))).toEqual([]);
    });

    it("el evento lleva entityId = sellerId (el del plan; si se reescribe, solo con el sellerId)", () => {
      for (const m of body().matchAll(/\bentityId\s*:\s*([^,}\n]+)/g)) {
        expect(m[1].trim()).toMatch(/^(?:input\.|parsed\.data\.|data\.)?sellerId$/);
      }
    });

    it("el return con writeKey esta despues de la transaccion, y ninguno dentro", () => {
      const text = body();
      const span = transactionSpan(text);
      const returns = [...text.matchAll(/return\s*\{[^;]*?\bwriteKey\b/g)].map((m) => m.index ?? 0);
      expect(returns.length, "no hay return { ... writeKey ... }").toBeGreaterThan(0);
      for (const at of returns) expect(at).toBeGreaterThanOrEqual(span.end);
      expect([...span.text.matchAll(/return\s*\{[^;]*?\bwriteKey\b/g)]).toEqual([]);
    });
  });

  it("ningun set/update/create/add del modulo lleva writeKey (solo su huella via fields)", () => {
    const offenders = writeCalls(source()).filter((call) => /\bwriteKey\b/.test(call.args));
    expect(offenders.map((call) => call.args.slice(0, 80))).toEqual([]);
  });

  it("la key nunca va a logs", () => {
    const logs = [...source().matchAll(/\b(?:console|logger)\.\w+\(/g)].map((m) => balancedFrom(source(), (m.index ?? 0) + m[0].length - 1));
    expect(logs.filter((args) => /\bwriteKey\b/.test(args))).toEqual([]);
  });

  describe("las de estado no devuelven secretos", () => {
    for (const name of ["getStoreApiKeyStatus", "listStoreApiKeys"] as const) {
      it(`${name} pasa por toStoreApiKeyStatus( y no menciona apiKey ni writeKeyHash`, () => {
        const text = exportedBody(source(), name);
        expect(text).toContain("toStoreApiKeyStatus(");
        expect(text).not.toMatch(/\b(apiKey|writeKeyHash)\b/);
      });

      it(`${name} no escribe`, () => {
        expect(writeCalls(exportedBody(source(), name))).toEqual([]);
      });
    }

    it("rotateStoreWriteKey tampoco devuelve apiKey ni writeKeyHash", () => {
      const text = exportedBody(source(), "rotateStoreWriteKey");
      for (const m of text.matchAll(/return\s*\{/g)) {
        const ret = text.slice(m.index ?? 0, text.indexOf(";", m.index ?? 0));
        expect(ret).not.toMatch(/\b(apiKey|writeKeyHash)\b/);
      }
    });

    it("listStoreApiKeys es solo de admin", () => {
      const text = exportedBody(source(), "listStoreApiKeys");
      expect(text).toMatch(/role\s*!==\s*["']admin["']/);
      expect(text).toMatch(/HttpsError\(\s*["']permission-denied["']/);
    });

    it("getStoreApiKeyStatus admite seller_logistics de su tienda (compara token.sellerId)", () => {
      const text = exportedBody(source(), "getStoreApiKeyStatus");
      expect(text).toContain("seller_logistics");
      expect(text).toMatch(/token\.sellerId/);
    });
  });

  it("RF_26: createStoreApiKey (key de lectura) no escribe ningun campo writeKey*", () => {
    const store = sourceWithoutComments("functions/src/store-api.ts");
    const start = store.search(/^export const createStoreApiKey\s*=\s*onCall\(/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = store.indexOf("\n});\n", start);
    expect(store.slice(start, end < 0 ? undefined : end)).not.toMatch(/writeKey/);
  });
});

describe("T18 · tipos y envoltorios de cliente (RF_25, RF_27)", () => {
  /*
   * Envoltorios en `src/lib/firebase/auth.ts`:
   * - `fetchFirebaseOrderAuditTrail(orderId)` → `{ events, historySince }`; acepta tambien un array (forma vieja,
   *   transicion functions → hosting) y lo devuelve con `historySince: null`. La normalizacion es pura y
   *   exportada: `normalizeOrderAuditTrailResponse(data)`.
   * - `rotateFirebaseStoreWriteKey({ sellerId, rotate })` → callable `rotateStoreWriteKey`, devuelve su data.
   * - `getFirebaseStoreApiKeyStatus({ sellerId })` → callable `getStoreApiKeyStatus`, devuelve su data.
   * - `listFirebaseStoreApiKeys()` → callable `listStoreApiKeys`, devuelve `.stores` (T17).
   */
  const TYPES = "src/lib/types.ts";
  const APP = "src/components/operations-app.tsx";

  type AuthModule = Record<string, unknown>;
  const loadAuth = async (): Promise<AuthModule> => (await import("./firebase/auth")) as unknown as AuthModule;
  const fn = (mod: AuthModule, name: string) => {
    expect(typeof mod[name], `auth.ts debe exportar ${name}`).toBe("function");
    return mod[name] as (...args: unknown[]) => unknown;
  };

  beforeEach(() => {
    t18Callables.calls.length = 0;
    for (const key of Object.keys(t18Callables.responses)) delete t18Callables.responses[key];
  });

  const SINCE = "2026-10-05T00:00:00.000Z";
  const EVENT = {
    id: "e1",
    createdAt: "2026-10-06T10:00:00.000Z",
    action: "order.confirmed",
    actorId: "",
    summary: "Confirmado",
    actorTag: "api",
    origin: "api"
  };

  it("normalizeOrderAuditTrailResponse: la forma nueva pasa tal cual", async () => {
    const normalize = fn(await loadAuth(), "normalizeOrderAuditTrailResponse");
    expect(normalize({ events: [EVENT], historySince: SINCE })).toEqual({ events: [EVENT], historySince: SINCE });
  });

  it("normalizeOrderAuditTrailResponse: un array (forma vieja) da { events, historySince: null }", async () => {
    const normalize = fn(await loadAuth(), "normalizeOrderAuditTrailResponse");
    expect(normalize([EVENT])).toEqual({ events: [EVENT], historySince: null });
  });

  it("normalizeOrderAuditTrailResponse: sin historySince, sin events o null no rompe", async () => {
    const normalize = fn(await loadAuth(), "normalizeOrderAuditTrailResponse");
    expect(normalize({ events: [EVENT] })).toEqual({ events: [EVENT], historySince: null });
    expect(normalize({ historySince: null })).toEqual({ events: [], historySince: null });
    expect(normalize(null)).toEqual({ events: [], historySince: null });
  });

  it("fetchFirebaseOrderAuditTrail llama a getOrderAuditTrail y devuelve { events, historySince }", async () => {
    const fetchTrail = fn(await loadAuth(), "fetchFirebaseOrderAuditTrail");
    t18Callables.responses.getOrderAuditTrail = { events: [EVENT], historySince: SINCE };
    await expect(fetchTrail("o1")).resolves.toEqual({ events: [EVENT], historySince: SINCE });
    expect(t18Callables.calls).toEqual([{ name: "getOrderAuditTrail", payload: { orderId: "o1" } }]);
  });

  it("fetchFirebaseOrderAuditTrail tolera la respuesta vieja (array)", async () => {
    const fetchTrail = fn(await loadAuth(), "fetchFirebaseOrderAuditTrail");
    t18Callables.responses.getOrderAuditTrail = [EVENT];
    await expect(fetchTrail("o1")).resolves.toEqual({ events: [EVENT], historySince: null });
  });

  it("rotateFirebaseStoreWriteKey llama a rotateStoreWriteKey con { sellerId, rotate } y devuelve su data", async () => {
    const rotate = fn(await loadAuth(), "rotateFirebaseStoreWriteKey");
    const data = { status: { sellerId: "s1" }, writeKey: "kw_x", previousLast4: "abcd" };
    t18Callables.responses.rotateStoreWriteKey = data;
    await expect(rotate({ sellerId: "s1", rotate: true })).resolves.toEqual(data);
    expect(t18Callables.calls).toEqual([{ name: "rotateStoreWriteKey", payload: { sellerId: "s1", rotate: true } }]);
  });

  it("getFirebaseStoreApiKeyStatus llama a getStoreApiKeyStatus con { sellerId } y devuelve el estado", async () => {
    const getStatus = fn(await loadAuth(), "getFirebaseStoreApiKeyStatus");
    const status = {
      sellerId: "s1",
      sellerName: "Tienda",
      read: { exists: false, status: "none" },
      write: { exists: false },
      canManageWrite: true
    };
    t18Callables.responses.getStoreApiKeyStatus = status;
    await expect(getStatus({ sellerId: "s1" })).resolves.toEqual(status);
    expect(t18Callables.calls).toEqual([{ name: "getStoreApiKeyStatus", payload: { sellerId: "s1" } }]);
  });

  it("listFirebaseStoreApiKeys llama a listStoreApiKeys y devuelve .stores", async () => {
    const list = fn(await loadAuth(), "listFirebaseStoreApiKeys");
    const stores = [
      {
        sellerId: "s1",
        sellerName: "Tienda",
        read: { exists: true, status: "active" },
        write: { exists: true, last4: "wxyz", generatedAt: SINCE, generatedByLabel: "por la tienda" },
        canManageWrite: true
      }
    ];
    t18Callables.responses.listStoreApiKeys = { stores };
    await expect(list()).resolves.toEqual(stores);
    expect(t18Callables.calls.map((call) => call.name)).toEqual(["listStoreApiKeys"]);
  });

  // T22 saca el historial a su propio componente: la llamada puede vivir en cualquiera de los dos archivos,
  // pero entre los dos tiene que haber al menos una y todas deben leer `.events`.
  it("operations-app.tsx y order-audit-trail.tsx: todo uso de fetchFirebaseOrderAuditTrail( lee .events", () => {
    const sources = [APP, "src/components/order-audit-trail.tsx"]
      .filter((file) => existsSync(absolute(file)))
      .map((file) => sourceWithoutComments(file));
    const total = sources.reduce((count, source) => count + [...source.matchAll(/fetchFirebaseOrderAuditTrail\(/g)].length, 0);
    expect(total).toBeGreaterThan(0);
    for (const app of sources) for (const use of app.matchAll(/fetchFirebaseOrderAuditTrail\(/g)) {
      const at = use.index ?? 0;
      const lineStart = app.lastIndexOf("\n", at) + 1;
      const statement = app.slice(lineStart, app.indexOf(";", at) + 1);
      const callEnd = app.indexOf(")", at);
      const afterCall = app.slice(callEnd, callEnd + 12);
      // Aceptado: `(await fetch...(id)).events`, `const { events, ... } = await fetch...(id)`, o
      // `const trail = await fetch...(id)` seguido de `trail.events` poco despues.
      const variable = statement.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+fetchFirebaseOrderAuditTrail\(/)?.[1];
      const readsEvents =
        /^\)\)?\??\.events\b/.test(afterCall) ||
        /\{\s*[^}]*\bevents\b[^}]*\}\s*=\s*await\s+fetchFirebaseOrderAuditTrail\(/.test(statement) ||
        (variable !== undefined && new RegExp(`\\b${variable}\\??\\.events\\b`).test(app.slice(at, at + 600)));
      expect(readsEvents, `uso sin .events: ${statement.trim()}`).toBe(true);
    }
  });

  it("types.ts: StoreApiKeyStatus con write { exists, last4?, generatedAt?, generatedByLabel? } y sin secretos", () => {
    const types = sourceWithoutComments(TYPES);
    const start = types.search(/export type StoreApiKeyStatus\b/);
    expect(start, "falta export type StoreApiKeyStatus en types.ts").toBeGreaterThanOrEqual(0);
    const body = types.slice(start, types.indexOf("};", start) + 2);
    const write = body.slice(body.search(/\bwrite\??:/));
    for (const field of ["exists", "last4", "generatedAt", "generatedByLabel"]) {
      expect(write, `write.${field}`).toMatch(new RegExp(`\\b${field}\\??:`));
    }
    for (const forbidden of ["prefix", "rotatedAt", "createdAt", "writeKeyHash", "apiKey", "writeKey"]) {
      expect(body, `StoreApiKeyStatus no lleva ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\??:`));
    }
  });

  it("types.ts: OrderAuditEntry con actorTag?, origin?, changes?, apiKeyLast4? y actorLabel opcional", () => {
    const types = sourceWithoutComments(TYPES);
    const start = types.search(/export type OrderAuditEntry\b/);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = types.slice(start, types.indexOf("};", start) + 2);
    for (const field of ["actorTag", "origin", "changes", "apiKeyLast4", "actorLabel"]) {
      expect(body, `OrderAuditEntry.${field} opcional`).toMatch(new RegExp(`\\b${field}\\?:`));
    }
  });
});

describe("T20 · seccion \"Clave de escritura\" de la tienda (RF_25, RF_26)", () => {
  /*
   * Contrato (README del diseno, decisiones 1, 3-7; pantallas HU_04.tienda-*):
   * - `src/components/store-api-write-key.tsx` exporta un componente de funcion (PascalCase) que pinta el
   *   modelo de vista de T19 (`buildWriteKeySectionView`). Los textos de estado viven en el modelo de vista,
   *   no se reescriben en el componente.
   * - La key fresca vive solo en el estado local del componente: nada de `localStorage`, `sessionStorage`,
   *   IndexedDB, URL ni estado global de la app (`AppState`/`setState`).
   * - Rotar pide confirmacion con un dialogo propio (`role="dialog"` + `aria-modal`, o `<dialog>`), nunca
   *   `window.confirm`. Nombre "Rotar la clave de escritura"; botones "Cerrar", "Rotar ahora" y "Cancelar".
   *   El foco entra en "Cancelar" y Escape cancela.
   * - `StoreApiKeyCard` (operations-app.tsx) se parte en dos `h3`, "Clave de lectura" (boton "Ver clave de
   *   lectura") y "Clave de escritura", y solo MONTA el componente nuevo: ninguna llamada a las callables de la
   *   key de escritura ni al modelo de vista vive en operations-app.tsx.
   */
  const COMPONENT = "src/components/store-api-write-key.tsx";
  const APP = "src/components/operations-app.tsx";

  const componentSource = (): string => {
    expect(existsSync(absolute(COMPONENT)), `${COMPONENT} debe existir`).toBe(true);
    return sourceWithoutComments(COMPONENT);
  };

  const exportedComponentNames = (source: string): string[] => {
    const names = new Set<string>();
    for (const match of source.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/g)) names.add(match[1]);
    for (const match of source.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9]*)\s*[:=]/g)) names.add(match[1]);
    return [...names];
  };

  /** Etiqueta de apertura del elemento cuyo texto contiene `text` (busca el `<tag` anterior mas cercano). */
  const openingTagBefore = (source: string, text: string, tag: string): string | null => {
    const at = source.search(new RegExp(`>\\s*${text}\\s*<`));
    if (at < 0) return null;
    const start = source.lastIndexOf(`<${tag}`, at);
    if (start < 0) return null;
    return source.slice(start, at + 1);
  };

  it("el archivo existe y exporta un componente", () => {
    const source = componentSource();
    expect(exportedComponentNames(source).length, "debe exportar un componente PascalCase").toBeGreaterThan(0);
  });

  it("pinta el modelo de vista de T19 (importa y llama buildWriteKeySectionView)", () => {
    const source = componentSource();
    expect(source).toMatch(
      /import\s*\{[^}]*\bbuildWriteKeySectionView\b[^}]*\}\s*from\s*["'](?:@\/lib|\.\.\/lib)\/store-api-keys-view["']/
    );
    expect(source).toMatch(/\bbuildWriteKeySectionView\s*\(/);
  });

  it("usa los envoltorios de cliente (rotateFirebaseStoreWriteKey, getFirebaseStoreApiKeyStatus)", () => {
    const source = componentSource();
    expect(source).toMatch(/\brotateFirebaseStoreWriteKey\s*\(/);
    expect(source).toMatch(/\bgetFirebaseStoreApiKeyStatus\s*\(/);
    expect(source).toMatch(/from\s*["'](?:@\/lib|\.\.\/lib)\/firebase\/auth["']/);
  });

  it("no reimplementa los textos de estado del modelo de vista", () => {
    const source = componentSource();
    const VIEW_MODEL_TEXTS = [
      "Sin clave de escritura",
      "Copiala ahora",
      "No se pudo rotar la clave",
      "No se pudo generar la clave",
      "Termina en",
      "Generada por",
      "Copiar clave de escritura",
      "Ya la guarde",
      "Generar clave de escritura",
      "Rotar clave de escritura",
      "Reintentar",
      "Va solo en la cabecera",
      "Solo se muestra completa esta vez",
      "sigue activa",
      "Si sales sin copiarla",
      "Solo la cuenta principal",
      "Consultando..."
    ];
    const reimplemented = VIEW_MODEL_TEXTS.filter((text) => source.includes(text));
    expect(reimplemented, "estos textos salen de buildWriteKeySectionView, no del componente").toEqual([]);
    expect(source, "el pill \"Activa\" sale del modelo de vista").not.toMatch(/["'`>]\s*Activa\s*["'`<]/);
    expect(source, "la key se parte con splitWriteKey / keyLines, no a mano").not.toMatch(/\.slice\(\s*0\s*,\s*24\s*\)/);
  });

  it("pinta la pildora como status y el aviso como alert", () => {
    const source = componentSource();
    expect(source).toMatch(/role=["{]["']?status/);
    expect(source).toMatch(/role=["{]["']?alert/);
  });

  it("la key fresca no se persiste: sin localStorage, sessionStorage, IndexedDB ni URL", () => {
    const source = componentSource();
    for (const banned of ["localStorage", "sessionStorage", "indexedDB", "pushState", "replaceState", "searchParams", "location.hash"]) {
      expect(source.includes(banned), `${COMPONENT} no debe usar ${banned}`).toBe(false);
    }
  });

  it("la key fresca no va al estado global de la app (ni AppState, ni setState de props, ni Firestore)", () => {
    const source = componentSource();
    expect(source).not.toMatch(/\bAppState\b/);
    expect(source).not.toMatch(/\bsetState\s*\(/);
    expect(source).not.toMatch(/from\s*["'](?:@\/lib|\.\.\/lib)\/firebase\/state-store["']/);
    expect(source).not.toMatch(/from\s*["']firebase\/firestore["']/);
    expect(source, "la key fresca vive en useState del componente").toMatch(/\buseState\b/);
  });

  it("el dialogo de rotar no usa window.confirm", () => {
    const source = componentSource();
    expect(source).not.toMatch(/\bwindow\.confirm\b/);
    expect(source).not.toMatch(/(^|[^.\w])confirm\s*\(/m);
  });

  it("el dialogo es modal y accesible (role=dialog + aria-modal, o <dialog>) con su nombre", () => {
    const source = componentSource();
    const roleDialog = /role=["{]["']?dialog/.test(source) && /aria-modal/.test(source);
    const nativeDialog = /<dialog[\s>]/.test(source);
    expect(roleDialog || nativeDialog, "role=\"dialog\" con aria-modal, o <dialog>").toBe(true);
    expect(source).toContain("Rotar la clave de escritura");
    expect(source).toMatch(/aria-labelledby|aria-label=["{]["'`]?Rotar la clave de escritura/);
    expect(source).toMatch(/>\s*Rotar ahora\s*</);
    expect(source).toMatch(/aria-label=["{]["'`]?Cerrar/);
  });

  it("el foco inicial del dialogo entra en \"Cancelar\", no en \"Rotar ahora\"", () => {
    const source = componentSource();
    const cancelTag = openingTagBefore(source, "Cancelar", "button");
    expect(cancelTag, "boton \"Cancelar\"").not.toBeNull();
    const refName = cancelTag?.match(/\bref=\{\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1];
    const focusByRef = refName ? new RegExp(`\\b${refName}\\.current\\??\\.focus\\(`).test(source) : false;
    expect(Boolean(cancelTag && /\bautoFocus\b/.test(cancelTag)) || focusByRef, "Cancelar con autoFocus o ref enfocado").toBe(true);

    const rotateTag = openingTagBefore(source, "Rotar ahora", "button");
    expect(rotateTag, "boton \"Rotar ahora\"").not.toBeNull();
    expect(rotateTag ?? "").not.toMatch(/\bautoFocus\b/);
  });

  it("Escape cierra el dialogo", () => {
    const source = componentSource();
    const handlesEscape = /["']Escape["']/.test(source);
    const nativeCancel = /<dialog[\s>]/.test(source) && /\bonCancel\s*=/.test(source);
    expect(handlesEscape || nativeCancel, "manejar la tecla Escape (o onCancel de <dialog>)").toBe(true);
  });

  it("StoreApiKeyCard tiene dos secciones h3: \"Clave de lectura\" y \"Clave de escritura\"", () => {
    const card = topLevelFunctionBody(sourceWithoutComments(APP), "StoreApiKeyCard");
    expect(card, "StoreApiKeyCard sigue en operations-app.tsx").not.toBeNull();
    expect(card).toMatch(/<h3[^>]*>\s*Clave de lectura\s*<\/h3>/);
    expect(card).toMatch(/<h3[^>]*>\s*Clave de escritura\s*<\/h3>/);
    expect(card).toMatch(/Ver clave de lectura/);
    expect(card).not.toMatch(/Ver mi API key/);
  });

  it("StoreApiKeyCard monta el componente nuevo importado de store-api-write-key", () => {
    const app = sourceWithoutComments(APP);
    const names = exportedComponentNames(componentSource());
    const imported = names.filter((name) =>
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'](?:@\\/components|\\.)\\/store-api-write-key["']`).test(app)
    );
    expect(imported.length, "operations-app.tsx importa el componente de store-api-write-key").toBeGreaterThan(0);
    const card = topLevelFunctionBody(app, "StoreApiKeyCard") ?? "";
    expect(imported.some((name) => new RegExp(`<${name}[\\s/>]`).test(card)), "StoreApiKeyCard lo monta").toBe(true);
  });

  it("operations-app.tsx no tiene logica de la key de escritura (solo monta)", () => {
    const app = sourceWithoutComments(APP);
    for (const name of ["rotateFirebaseStoreWriteKey", "getFirebaseStoreApiKeyStatus", "buildWriteKeySectionView", "splitWriteKey"]) {
      expect(app.includes(name), `operations-app.tsx no debe usar ${name}`).toBe(false);
    }
    const card = topLevelFunctionBody(app, "StoreApiKeyCard") ?? "";
    expect(card, "la key fresca no pasa por StoreApiKeyCard").not.toMatch(/\bwriteKey\b/);
  });
});

describe("T21 · panel \"Claves de API de tiendas\" del admin (RF_25, RF_26)", () => {
  /*
   * Contrato (README del diseno, decision 2; pantallas HU_04.admin-*):
   * - `src/components/store-api-keys-admin.tsx` exporta un componente PascalCase que carga la lista con
   *   `listFirebaseStoreApiKeys` y la pinta con `buildAdminKeysListView` (tabla en escritorio, tarjetas en
   *   movil, buscador "Buscar tienda", paginas de 6/4).
   * - Generar/rotar no se reimplementa: el panel monta `StoreWriteKeySection` (T20) con `viewer="admin"`.
   * - La columna/tarjeta "Lectura" es solo estado: el panel nunca lee ni pinta la key de lectura.
   * - Sin `localStorage`/`sessionStorage`/`window.confirm`.
   * - `operations-app.tsx` solo MONTA el panel, y solo en `AdminView`, despues de "Incidencias de
   *   sincronizacion" (y antes de "Solicitudes de instalacion"). Nunca en SellerView ni en las vistas de
   *   lider o mensajero.
   */
  const PANEL = "src/components/store-api-keys-admin.tsx";
  const APP = "src/components/operations-app.tsx";
  const NON_ADMIN_VIEWS = ["SellerView", "CommunityLeaderView", "DriverView", "MessengerView", "FleetMessengerPanel"];

  const panelSource = (): string => {
    expect(existsSync(absolute(PANEL)), `${PANEL} debe existir`).toBe(true);
    return sourceWithoutComments(PANEL);
  };

  const exportedComponentNames = (source: string): string[] => {
    const names = new Set<string>();
    for (const match of source.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/g)) names.add(match[1]);
    for (const match of source.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9]*)\s*[:=]/g)) names.add(match[1]);
    return [...names];
  };

  /** Nombres exportados por el panel que operations-app.tsx importa de store-api-keys-admin. */
  const importedPanelNames = (app: string): string[] =>
    exportedComponentNames(panelSource()).filter((name) =>
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'](?:@\\/components|\\.)\\/store-api-keys-admin["']`).test(app)
    );

  const mountRegex = (name: string): RegExp => new RegExp(`<${name}[\\s/>]`, "g");

  it("el archivo existe y exporta un componente", () => {
    expect(exportedComponentNames(panelSource()).length, "debe exportar un componente PascalCase").toBeGreaterThan(0);
  });

  it("carga la lista con listFirebaseStoreApiKeys (envoltorio de cliente)", () => {
    const source = panelSource();
    expect(source).toMatch(
      /import\s*\{[^}]*\blistFirebaseStoreApiKeys\b[^}]*\}\s*from\s*["'](?:@\/lib|\.\.\/lib)\/firebase\/auth["']/
    );
    expect(source).toMatch(/\blistFirebaseStoreApiKeys\s*\(/);
  });

  it("pinta el modelo de vista de T19 (buildAdminKeysListView)", () => {
    const source = panelSource();
    expect(source).toMatch(
      /import\s*\{[^}]*\bbuildAdminKeysListView\b[^}]*\}\s*from\s*["'](?:@\/lib|\.\.\/lib)\/store-api-keys-view["']/
    );
    expect(source).toMatch(/\bbuildAdminKeysListView\s*\(/);
    expect(source, "el resumen \"N de M tiendas\" sale del modelo de vista").not.toMatch(/tiendas con clave de escritura/);
    expect(source, "el rango de paginas sale del modelo de vista").not.toMatch(/`Tiendas \$\{/);
  });

  it("tabla en escritorio y tarjetas en movil, con buscador \"Buscar tienda\"", () => {
    const source = panelSource();
    expect(source).toMatch(/<table[\s>]/);
    expect(source).toContain("Claves de API por tienda");
    expect(source).toContain("Buscar tienda");
    expect(source, "pide la vista de movil al modelo (4 por pagina)").toMatch(/["']mobile["']/);
  });

  it("los botones por fila llevan el nombre accesible del modelo de vista", () => {
    expect(panelSource()).toMatch(/aria-label=\{[^}]*\baccessibleName\b/);
  });

  it("reutiliza StoreWriteKeySection con viewer=\"admin\" (no reimplementa generar/rotar)", () => {
    const source = panelSource();
    expect(source).toMatch(
      /import\s*\{[^}]*\bStoreWriteKeySection\b[^}]*\}\s*from\s*["'](?:@\/components|\.)\/store-api-write-key["']/
    );
    expect(source).toMatch(/<StoreWriteKeySection[\s/>]/);
    const mount = source.slice(source.search(/<StoreWriteKeySection[\s/>]/));
    expect(mount.slice(0, mount.search(/\/?>/) + 2)).toMatch(/viewer=["{]["']?admin/);
    for (const name of ["rotateFirebaseStoreWriteKey", "getFirebaseStoreApiKeyStatus", "buildWriteKeySectionView", "splitWriteKey"]) {
      expect(source.includes(name), `${PANEL} no debe usar ${name}: eso es de StoreWriteKeySection`).toBe(false);
    }
  });

  it("la columna Lectura solo muestra estado: el panel no lee ni pinta la key de lectura", () => {
    const source = panelSource();
    expect(source).not.toMatch(/\bapiKey\b/);
    expect(source).not.toMatch(/\bcreateFirebaseStoreApiKey\b/);
    expect(source, "la celda de Lectura pinta readText del modelo de vista").toMatch(/\breadText\b/);
    expect(source, "no se lee nada de status.read aparte del modelo de vista").not.toMatch(/\.read\.(?!exists\b|status\b)\w+/);
  });

  it("sin localStorage, sessionStorage ni window.confirm", () => {
    const source = panelSource();
    for (const banned of ["localStorage", "sessionStorage", "indexedDB"]) {
      expect(source.includes(banned), `${PANEL} no debe usar ${banned}`).toBe(false);
    }
    expect(source).not.toMatch(/\bwindow\.confirm\b/);
    expect(source).not.toMatch(/(^|[^.\w])confirm\s*\(/m);
  });

  it("operations-app.tsx importa el panel y lo monta en AdminView, tras \"Incidencias de sincronizacion\"", () => {
    const app = sourceWithoutComments(APP);
    const names = importedPanelNames(app);
    expect(names.length, "operations-app.tsx importa el panel de store-api-keys-admin").toBeGreaterThan(0);
    const adminView = topLevelFunctionBody(app, "AdminView") ?? "";
    expect(adminView, "AdminView sigue en operations-app.tsx").not.toBe("");
    const mountAt = Math.min(...names.map((name) => adminView.search(mountRegex(name))).filter((index) => index >= 0));
    expect(Number.isFinite(mountAt), "AdminView monta el panel").toBe(true);
    const incidents = adminView.indexOf('title="Incidencias de sincronizacion"');
    const installs = adminView.indexOf('title="Solicitudes de instalacion"');
    expect(incidents, "AdminView conserva el panel de Incidencias").toBeGreaterThanOrEqual(0);
    expect(mountAt, "va despues de \"Incidencias de sincronizacion\"").toBeGreaterThan(incidents);
    if (installs > incidents) expect(mountAt, "y antes de \"Solicitudes de instalacion\"").toBeLessThan(installs);
    expect(app + panelSource(), "el panel se titula \"Claves de API de tiendas\"").toContain("Claves de API de tiendas");
  });

  it("el panel se monta SOLO en AdminView (nunca en tienda, lider ni mensajero)", () => {
    const app = sourceWithoutComments(APP);
    const names = importedPanelNames(app);
    const adminView = topLevelFunctionBody(app, "AdminView") ?? "";
    for (const name of names) {
      const total = [...app.matchAll(mountRegex(name))].length;
      const inAdmin = [...adminView.matchAll(mountRegex(name))].length;
      expect(inAdmin, `<${name}> se monta en AdminView`).toBeGreaterThan(0);
      expect(total, `<${name}> no se monta fuera de AdminView`).toBe(inAdmin);
      for (const view of NON_ADMIN_VIEWS) {
        const body = topLevelFunctionBody(app, view) ?? "";
        expect(mountRegex(name).test(body), `${view} no monta <${name}>`).toBe(false);
      }
    }
  });

  it("operations-app.tsx solo monta: no carga la lista ni la pinta", () => {
    const app = sourceWithoutComments(APP);
    for (const name of ["listFirebaseStoreApiKeys", "buildAdminKeysListView", "ADMIN_KEYS_PAGE_SIZE"]) {
      expect(app.includes(name), `operations-app.tsx no debe usar ${name}`).toBe(false);
    }
  });
});

describe("T22 · RF_27 \"Historial del pedido\" con origen y cambios", () => {
  /*
   * `OrderAuditTrail` sale de operations-app.tsx a `src/components/order-audit-trail.tsx` y pinta SOLO lo que da
   * `buildOrderAuditTrailView` (T19): para la tienda el modelo ya no trae identidades, asi que el componente no
   * puede leerlas del evento crudo. Textos ratificados en el README del diseno, decisiones 8-16.
   */
  const COMPONENT = "src/components/order-audit-trail.tsx";
  const APP = "src/components/operations-app.tsx";
  const VIEW_MODEL = "./order-audit-trail-view";
  const README = "specs/design/029_store_api_confirma_y_corrige_pedidos/README.md";

  const componentSource = (): string => {
    expect(existsSync(absolute(COMPONENT)), `${COMPONENT} debe existir`).toBe(true);
    return sourceWithoutComments(COMPONENT);
  };

  /** Etiquetas `| \`order.x\` | **Texto** |` de las tablas del README. */
  const readmeActionLabels = (): Record<string, string> => {
    const labels: Record<string, string> = {};
    for (const match of readFileSync(absolute(README), "utf8").matchAll(/^\s*\|\s*`(order\.[a-z_]+)`\s*\|\s*\*\*([^*]+)\*\*/gm)) {
      labels[match[1]] = match[2].trim();
    }
    return labels;
  };

  it("el archivo existe y exporta OrderAuditTrail", () => {
    expect(componentSource()).toMatch(/export\s+(?:default\s+)?function\s+OrderAuditTrail\s*\(|export\s+const\s+OrderAuditTrail\s*[:=]/);
  });

  it("carga con fetchFirebaseOrderAuditTrail y pinta con buildOrderAuditTrailView", () => {
    const source = componentSource();
    expect(source).toMatch(/import\s*\{[^}]*\bfetchFirebaseOrderAuditTrail\b[^}]*\}\s*from\s*["']@\/lib\/firebase\/auth["']/);
    expect(source).toMatch(/import\s*\{[^}]*\bbuildOrderAuditTrailView\b[^}]*\}\s*from\s*["']@\/lib\/order-audit-trail-view["']/);
    expect(source).toMatch(/\bbuildOrderAuditTrailView\s*\(/);
    expect(source).toMatch(/\bfetchFirebaseOrderAuditTrail\s*\(/);
  });

  it("boton de cabecera con nombre fijo \"Historial del pedido\", aria-expanded y texto derecho aria-hidden", () => {
    const source = componentSource();
    expect(source).toContain("Historial del pedido");
    expect(source).toMatch(/aria-expanded=\{/);
    expect(source, "el texto \"Ocultar\"/\"Ver cambios\" va aria-hidden (decision 8)").toMatch(/aria-hidden/);
    expect(source, "ya no promete \"quien hizo cada accion\" (para la tienda no es cierto)").not.toContain("Ver quien hizo cada accion");
  });

  it("no pinta identidades del evento crudo: actorEmail, actorLabel, actorRole, actorId ni actorTag", () => {
    const source = componentSource();
    for (const field of ["actorEmail", "actorLabel", "actorRole", "actorId", "actorTag", "apiKeyLast4"]) {
      expect(source.includes(field), `${COMPONENT} no debe leer ${field}: sale del modelo de vista`).toBe(false);
    }
  });

  it("acciones, transiciones y fechas salen del modelo de vista (sin etiquetar ni formatear en el componente)", () => {
    const source = componentSource();
    for (const banned of ["auditActionLabel(", "statusLabel(", "formatDateTime(", "toLocaleString(", "toLocaleDateString(", "AUDIT_ACTION_LABELS"]) {
      expect(source.includes(banned), `${COMPONENT} no debe usar ${banned}`).toBe(false);
    }
    for (const viewField of ["actionLabel", "dateText", "transition", "origin", "changes"]) {
      expect(source, `pinta ${viewField} del modelo`).toMatch(new RegExp(`\\.${viewField}\\b`));
    }
  });

  it("sin fecha literal: la de historySince sale del modelo (decision 9)", () => {
    const source = componentSource();
    expect(source).not.toMatch(/\b20\d{2}-\d{2}-\d{2}/);
    expect(source).not.toMatch(/2026/);
    expect(source).not.toMatch(/\b\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\b/i);
  });

  it("estados del bloque desde el modelo: nota, vacio, error con \"Reintentar\" del modelo y role=alert", () => {
    const source = componentSource();
    expect(source.includes("Reintentar"), "\"Reintentar\" no se escribe a mano: es alert.retryLabel").toBe(false);
    expect(source).toMatch(/\bretryLabel\b/);
    expect(source).toMatch(/role=["']alert["']/);
    expect(source).toMatch(/role=["']note["']/);
    expect(source).toMatch(/\.note\b/);
    expect(source).toMatch(/\.empty\b/);
    for (const literal of ["No se pudo cargar el historial", "Sin cambios registrados", "Cargando historial", "Campo por campo desde"]) {
      expect(source.includes(literal), `"${literal}" sale del modelo, no del componente`).toBe(false);
    }
  });

  it("\"Antes\"/\"Ahora\" escritos con las etiquetas del modelo (CHANGE_LABELS)", () => {
    const source = componentSource();
    expect(source).toMatch(/\bCHANGE_LABELS\b/);
  });

  it("operations-app.tsx ya no define OrderAuditTrail, AUDIT_ACTION_LABELS ni auditActionLabel; importa el componente y lo monta", () => {
    const app = sourceWithoutComments(APP);
    expect(app).not.toMatch(/^(?:export\s+)?function\s+OrderAuditTrail\s*\(/m);
    expect(app).not.toMatch(/^(?:export\s+)?const\s+AUDIT_ACTION_LABELS\b/m);
    expect(app).not.toMatch(/^(?:export\s+)?function\s+auditActionLabel\s*\(/m);
    expect(app).toMatch(/import\s*\{[^}]*\bOrderAuditTrail\b[^}]*\}\s*from\s*["'](?:@\/components|\.)\/order-audit-trail["']/);
    expect(app).toMatch(/<OrderAuditTrail[\s/>]/);
  });

  it("AUDIT_ACTION_LABELS (exportado del modelo de vista) coincide con el README en las acciones nuevas y de mensajero", async () => {
    const mod = (await import(VIEW_MODEL)) as { AUDIT_ACTION_LABELS: Record<string, string> };
    const readme = readmeActionLabels();
    for (const action of [
      "order.delivery_corrected",
      "order.address_reviewed",
      "order.picked_up",
      "order.messenger_assigned",
      "order.messenger_unassigned"
    ]) {
      expect(readme[action], `el README ratifica ${action}`).toBeTruthy();
      expect(mod.AUDIT_ACTION_LABELS[action], action).toBe(readme[action]);
    }
  });
});

describe("T23 · el \"?\" de CollapsiblePanel mide 44 px (RF_25, WCAG 2.2 AA)", () => {
  /** Etiqueta `<button ...>` de ayuda de `CollapsiblePanel`: la que lleva `aria-expanded={helpOpen}`. */
  const helpButtonTag = (): string => {
    const source = readFileSync(absolute("src/components/operations-app.tsx"), "utf8");
    const start = source.indexOf("function CollapsiblePanel(");
    expect(start, "no se encuentra `function CollapsiblePanel(`").toBeGreaterThan(-1);
    const end = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, end > start ? end : undefined);
    const tags = [...body.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    const help = tags.filter((tag) => tag.includes("aria-expanded={helpOpen}"));
    expect(help.length, "una sola etiqueta `<button` de ayuda (con `aria-expanded={helpOpen}`) en `CollapsiblePanel`").toBe(1);
    return help[0];
  };

  const classes = (tag: string): string[] => (tag.match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);

  it("el boton de ayuda no lleva `h-8` ni `w-8`", () => {
    const list = classes(helpButtonTag());
    expect(list.includes("h-8") || list.includes("w-8"), `clases: ${list.join(" ")}`).toBe(false);
  });

  it("el boton de ayuda lleva `h-11` y `w-11` (44 px)", () => {
    const list = classes(helpButtonTag());
    expect(list.includes("h-11") && list.includes("w-11"), `clases: ${list.join(" ")}`).toBe(true);
  });

  it("conserva la forma circular (`rounded-full`)", () => {
    expect(classes(helpButtonTag())).toContain("rounded-full");
  });

  it("el contenido del \"?\" no cambia de tamano (texto 16 px: `text-sm` fuera, sin icono escalado)", () => {
    const source = readFileSync(absolute("src/components/operations-app.tsx"), "utf8");
    const start = source.indexOf("function CollapsiblePanel(");
    const tagAt = source.indexOf(helpButtonTag(), start);
    const inner = source.slice(tagAt, source.indexOf("</button>", tagAt));
    expect(/size=\{16\}|text-sm/.test(inner), "el \"?\" conserva su tamano de 16 px").toBe(true);
  });
});

describe("T24 · capture-reads: lecturas reales congeladas antes de desplegar (RF_20, RF_01)", () => {
  /*
   * Contrato (T24, plan 5.3 "Lecturas reales"):
   *  - `COMMANDS` registra `"capture-reads": <fn>`, funcion de primer nivel; no esta en WRITE_MODES. El modo
   *    y toda funcion de primer nivel que alcance (cierre transitivo por nombre) solo hacen GET: hay `fetch(`,
   *    ningun `method:` distinto de "GET" ni literales POST/PATCH/PUT/DELETE, ninguna escritura de Firestore.
   *  - Contra tiendas reales solo la key de lectura: ese cierre no nombra `writeKey*` ni `kw_`; la key viaja
   *    por `Bearer` o por `key=` (como hoy) y nunca a la evidencia.
   *  - Evidencia `t24-reads-antes.json`: `{ captureAt: ISO, range: { from, to }, stores: [{ sellerId, kpis,
   *    orders, settlements, resumen, index }] }` (cada cuerpo, la respuesta JSON con `ok: true`), al menos
   *    tres tiendas, `from <= to < dia de captureAt`, sin ninguna key (48 hex ni `kw_`).
   *  - Funcion pura exportada: `module.exports = { compareReads, IGNORED_RESPONSE_FIELDS, ... }` con el
   *    `require.main === module` de siempre. `compareReads(before, after, { captureAt })` recibe dos objetos
   *    `{ kpis, orders, settlements, resumen, index }` (cuerpos de respuesta; en `settlements.liquidaciones`
   *    cada elemento lleva el `updatedAt` del corte, que la captura anota) y devuelve
   *    `{ ok: boolean, differences: Array<{ resource, path, ... }>, excluded: { orders: n, settlements: n } }`.
   *    `/orders` y `/settlements` comparan por valor solo los elementos con `updatedAt < captureAt` que
   *    conservan ese `updatedAt` en `after`; el resto se excluye de los dos lados y se cuenta. `/kpis` por
   *    valor; `/resumen` solo por claves y tipos (con la razon en un comentario: resume el estado de hoy y
   *    ningun rango lo congela); el indice, valor identico de cada clave de `before`, admitiendo solo claves
   *    nuevas de primer nivel. Tolerancia cero salvo `IGNORED_RESPONSE_FIELDS` (marcas de tiempo de la
   *    propia respuesta).
   */
  const SCRIPT = "scripts/verify-029.js";
  const EVIDENCE = ".sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t24-reads-antes.json";
  const source = () => sourceWithoutComments(SCRIPT);

  function captureReadsName(): string | null {
    const commands = source().match(/const\s+COMMANDS\s*=\s*\{([^}]*)\}/)?.[1] ?? "";
    return commands.match(/["']capture-reads["']\s*:\s*([A-Za-z_$][\w$]*)/)?.[1] ?? null;
  }

  /** Cuerpos del modo y de toda funcion de primer nivel que alcanza por nombre. */
  function captureClosure(): string {
    const root = captureReadsName();
    if (!root) return "";
    const src = source();
    const topLevel = [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]);
    const seen = new Set<string>([root]);
    const queue = [root];
    const bodies: string[] = [];
    while (queue.length) {
      const body = topLevelFunctionBody(src, queue.shift() as string) ?? "";
      bodies.push(body);
      for (const name of topLevel) {
        if (!seen.has(name) && new RegExp(`\\b${name}\\b`).test(body)) {
          seen.add(name);
          queue.push(name);
        }
      }
    }
    return bodies.join("\n");
  }

  type Compare = (before: unknown, after: unknown, options: { captureAt: string }) => {
    ok: boolean;
    differences: Array<{ resource: string; path?: string }>;
    excluded: { orders: number; settlements: number };
  };
  async function loadScript(): Promise<{ compareReads: Compare; IGNORED_RESPONSE_FIELDS: string[] }> {
    const { createRequire } = await import("node:module");
    const mod = createRequire(import.meta.url)(absolute(SCRIPT));
    return mod;
  }

  it("COMMANDS registra capture-reads con una funcion de primer nivel", () => {
    expect(captureReadsName()).not.toBeNull();
    expect(topLevelFunctionBody(source(), captureReadsName() ?? "") ?? "").not.toBe("");
  });

  it("capture-reads no esta en WRITE_MODES", () => {
    const match = source().match(/const\s+WRITE_MODES\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const modes = [...(match?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
    expect(modes).not.toContain("capture-reads");
  });

  it("el modo hace peticiones HTTP con fetch(", () => {
    expect(captureClosure()).toMatch(/\bfetch\(/);
  });

  it("el modo solo hace GET: ningun method distinto de GET ni verbo de escritura", () => {
    const closure = captureClosure();
    expect(closure).not.toBe("");
    for (const method of closure.matchAll(/\bmethod\s*:\s*([^,}\n]+)/g)) {
      expect(method[1].trim(), `method no permitido: ${method[0]}`).toMatch(/^["'`]GET["'`]$/);
    }
    expect(closure).not.toMatch(/["'`](POST|PATCH|PUT|DELETE)["'`]/);
    expect(closure).not.toMatch(/\.(post|patch|put)\(/);
  });

  it.each(WRITE_CALLS)("el modo no escribe en Firestore: %s", (writeCall) => {
    expect(captureClosure()).not.toBe("");
    expect(captureClosure()).not.toContain(writeCall);
  });

  it("contra tiendas reales solo usa la key de lectura: no lee writeKey* ni kw_", () => {
    expect(captureClosure()).not.toBe("");
    expect(captureClosure()).not.toMatch(/writeKey/i);
    expect(captureClosure()).not.toMatch(/kw_/);
  });

  it("lee la key de lectura de storeApiConfigs y la envia por Bearer o por key= (como hoy)", () => {
    expect(captureClosure()).toMatch(/storeApiConfigs/);
    expect(captureClosure()).toMatch(/Bearer|[?&]key=|["']key["']/);
  });

  it("pide /kpis, /orders, /settlements, /resumen y el indice con from/to", () => {
    for (const route of ["kpis", "orders", "settlements", "resumen"]) {
      expect(captureClosure()).toMatch(new RegExp(`/${route}\\b|["'\`]${route}["'\`]`));
    }
    expect(captureClosure()).toMatch(/\bfrom\b/);
    expect(captureClosure()).toMatch(/\bto\b/);
    expect(captureClosure()).toMatch(/captureAt/);
    expect(captureClosure()).toContain("t24-reads-antes.json");
  });

  it("el guion declara IGNORED_RESPONSE_FIELDS como lista explicita", () => {
    expect(source()).toMatch(/const\s+IGNORED_RESPONSE_FIELDS\s*=\s*(?:Object\.freeze\()?\[/);
  });

  it("deja escrita la razon de comparar /resumen solo por forma (ningun rango lo congela)", () => {
    const raw = readFileSync(absolute(SCRIPT), "utf8");
    const comments = [...raw.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n\s*\/\/[^\n]*)*/g)].map((match) => match[0]);
    expect(comments.some((comment) => /resumen/i.test(comment) && /forma/i.test(comment) && /congela/i.test(comment))).toBe(true);
  });

  describe("compareReads (puro, con fixtures)", () => {
    const CAPTURE_AT = "2026-10-05T12:00:00.000Z";
    const order = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ id, updatedAt, status: "delivered", codCop: 50000, ...extra });
    const settlement = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ id, updatedAt, status: "paid", netoCop: 10000, ...extra });
    const snapshot = () => ({
      kpis: { ok: true, tienda: "T", rango: { desde: "2026-09-01", hasta: "2026-09-30" }, kpis: { entregados: 10, fallidos: 2 } },
      orders: { ok: true, tienda: "T", rango: { desde: "2026-09-01", hasta: "2026-09-30" }, total: 2, pedidos: [order("A", "2026-09-10T00:00:00.000Z"), order("B", "2026-09-11T00:00:00.000Z")] },
      settlements: { ok: true, tienda: "T", total: 1, liquidaciones: [settlement("S1", "2026-09-20T00:00:00.000Z")] },
      resumen: { ok: true, tienda: "T", disponibleCop: 1000, retenidoCop: 0, pagos: [{ fecha: "2026-09-01", montoCop: 5 }] },
      index: { ok: true, tienda: "T", endpoints: { "GET /resumen": "x" }, autenticacion: "sellerId y key" }
    });

    it("exporta compareReads y IGNORED_RESPONSE_FIELDS (lista de strings, sin campos de datos)", async () => {
      const mod = await loadScript();
      expect(typeof mod.compareReads).toBe("function");
      expect(Array.isArray(mod.IGNORED_RESPONSE_FIELDS)).toBe(true);
      for (const field of mod.IGNORED_RESPONSE_FIELDS) expect(typeof field).toBe("string");
      for (const dataField of ["kpis", "pedidos", "liquidaciones", "endpoints", "autenticacion", "netoCop", "codCop", "status"]) {
        expect(mod.IGNORED_RESPONSE_FIELDS).not.toContain(dataField);
      }
    });

    it("dos lecturas identicas: ok y sin diferencias", async () => {
      const { compareReads } = await loadScript();
      const result = compareReads(snapshot(), snapshot(), { captureAt: CAPTURE_AT });
      expect(result.differences).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("/kpis por valor: un numero distinto es una diferencia", async () => {
      const { compareReads } = await loadScript();
      const after = snapshot();
      after.kpis.kpis.entregados = 11;
      const result = compareReads(snapshot(), after, { captureAt: CAPTURE_AT });
      expect(result.ok).toBe(false);
      expect(result.differences.some((diff) => diff.resource === "kpis")).toBe(true);
    });

    it("/orders por valor: un pedido con el mismo updatedAt y otro valor es una diferencia", async () => {
      const { compareReads } = await loadScript();
      const after = snapshot();
      after.orders.pedidos[0] = order("A", "2026-09-10T00:00:00.000Z", { codCop: 49000 });
      const result = compareReads(snapshot(), after, { captureAt: CAPTURE_AT });
      expect(result.ok).toBe(false);
      expect(result.differences.some((diff) => diff.resource === "orders")).toBe(true);
    });

    it("/orders: el pedido movido entre medias (otro updatedAt) se excluye y se cuenta", async () => {
      const { compareReads } = await loadScript();
      const after = snapshot();
      after.orders.pedidos[1] = order("B", "2026-10-06T08:00:00.000Z", { status: "failed", codCop: 0 });
      const result = compareReads(snapshot(), after, { captureAt: CAPTURE_AT });
      expect(result.differences).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.excluded.orders).toBe(1);
    });

    it("/orders: un pedido con updatedAt >= captureAt no se compara y se cuenta", async () => {
      const { compareReads } = await loadScript();
      const before = snapshot();
      before.orders.pedidos.push(order("C", "2026-10-05T12:30:00.000Z"));
      const after = snapshot();
      after.orders.pedidos.push(order("C", "2026-10-05T12:30:00.000Z", { codCop: 1 }));
      const result = compareReads(before, after, { captureAt: CAPTURE_AT });
      expect(result.differences).toEqual([]);
      expect(result.excluded.orders).toBe(1);
    });

    it("/settlements: corte con el mismo updatedAt y otro valor es diferencia; uno movido se excluye y cuenta", async () => {
      const { compareReads } = await loadScript();
      const changed = snapshot();
      changed.settlements.liquidaciones[0] = settlement("S1", "2026-09-20T00:00:00.000Z", { netoCop: 9999 });
      expect(compareReads(snapshot(), changed, { captureAt: CAPTURE_AT }).differences.some((diff) => diff.resource === "settlements")).toBe(true);

      const moved = snapshot();
      moved.settlements.liquidaciones[0] = settlement("S1", "2026-10-07T00:00:00.000Z", { status: "reconciled" });
      const result = compareReads(snapshot(), moved, { captureAt: CAPTURE_AT });
      expect(result.differences).toEqual([]);
      expect(result.excluded.settlements).toBe(1);
    });

    it("/resumen solo por forma: otros valores con las mismas claves y tipos no son diferencia", async () => {
      const { compareReads } = await loadScript();
      const after = snapshot();
      after.resumen.disponibleCop = 777777;
      after.resumen.retenidoCop = 12;
      const result = compareReads(snapshot(), after, { captureAt: CAPTURE_AT });
      expect(result.differences).toEqual([]);
    });

    it("/resumen: una clave que falta o cambia de tipo es diferencia", async () => {
      const { compareReads } = await loadScript();
      const missing = snapshot() as Record<string, any>;
      delete missing.resumen.retenidoCop;
      expect(compareReads(snapshot(), missing, { captureAt: CAPTURE_AT }).differences.some((diff) => diff.resource === "resumen")).toBe(true);

      const retyped = snapshot() as Record<string, any>;
      retyped.resumen.disponibleCop = "1000";
      expect(compareReads(snapshot(), retyped, { captureAt: CAPTURE_AT }).differences.some((diff) => diff.resource === "resumen")).toBe(true);
    });

    it("indice: una clave nueva de primer nivel se admite", async () => {
      const { compareReads } = await loadScript();
      const after = snapshot() as Record<string, any>;
      after.index.writeEndpoints = { "PATCH /orders/{id}": "nuevo" };
      after.index.errorCodes = ["key_in_query"];
      const result = compareReads(snapshot(), after, { captureAt: CAPTURE_AT });
      expect(result.differences).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("indice: anadir dentro de una clave actual es diferencia", async () => {
      const { compareReads } = await loadScript();
      const after = snapshot() as Record<string, any>;
      after.index.endpoints = { ...after.index.endpoints, "PATCH /orders/{id}": "nuevo" };
      const result = compareReads(snapshot(), after, { captureAt: CAPTURE_AT });
      expect(result.ok).toBe(false);
      expect(result.differences.some((diff) => diff.resource === "index")).toBe(true);
    });

    it("indice: una clave actual con otro valor o que desaparece es diferencia", async () => {
      const { compareReads } = await loadScript();
      const changed = snapshot() as Record<string, any>;
      changed.index.autenticacion = "solo Bearer";
      expect(compareReads(snapshot(), changed, { captureAt: CAPTURE_AT }).differences.some((diff) => diff.resource === "index")).toBe(true);

      const removed = snapshot() as Record<string, any>;
      delete removed.index.autenticacion;
      expect(compareReads(snapshot(), removed, { captureAt: CAPTURE_AT }).differences.some((diff) => diff.resource === "index")).toBe(true);
    });

    it("solo se ignoran los campos de IGNORED_RESPONSE_FIELDS (si hay alguno)", async () => {
      const { compareReads, IGNORED_RESPONSE_FIELDS } = await loadScript();
      for (const field of IGNORED_RESPONSE_FIELDS) {
        const before = snapshot() as Record<string, any>;
        const after = snapshot() as Record<string, any>;
        before.kpis[field] = "2026-10-05T12:00:00.000Z";
        after.kpis[field] = "2026-10-08T09:00:00.000Z";
        expect(compareReads(before, after, { captureAt: CAPTURE_AT }).differences, field).toEqual([]);
      }
      const after = snapshot() as Record<string, any>;
      after.kpis.campoNoDeclarado = 1;
      expect(compareReads(snapshot(), after, { captureAt: CAPTURE_AT }).ok).toBe(false);
    });
  });

  describe("evidencia t24-reads-antes.json", () => {
    const evidenceRaw = () => (existsSync(absolute(EVIDENCE)) ? readFileSync(absolute(EVIDENCE), "utf8") : "");

    it("la captura existe y es JSON valido", () => {
      expect(existsSync(absolute(EVIDENCE))).toBe(true);
      expect(() => JSON.parse(evidenceRaw())).not.toThrow();
    });

    it("no contiene ninguna key (48 hex ni kw_)", () => {
      expect(evidenceRaw()).not.toBe("");
      expect(evidenceRaw()).not.toMatch(/(?<![0-9a-f])[0-9a-f]{48}(?![0-9a-f])/i);
      expect(evidenceRaw()).not.toMatch(/kw_/);
    });

    it("from <= to < dia de captureAt (rangos cerrados del pasado)", () => {
      const data = JSON.parse(evidenceRaw() || "{}");
      expect(typeof data.captureAt).toBe("string");
      expect(Number.isNaN(Date.parse(data.captureAt))).toBe(false);
      const captureDay = String(data.captureAt).slice(0, 10);
      expect(data.range?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(data.range?.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(data.range.from <= data.range.to).toBe(true);
      expect(data.range.to < captureDay).toBe(true);
    });

    // Los pedidos y cortes reales llevan nombre, telefono y direccion de clientes: al repo solo va su huella
    // (id, updatedAt y hash del elemento canonico), y la comparacion de T27 huellea igual el "despues".
    it("pedidos y liquidaciones se guardan como huella (id, updatedAt, hash), sin datos de clientes", () => {
      const data = JSON.parse(evidenceRaw() || "{}");
      for (const store of (data.stores ?? []) as Array<Record<string, any>>) {
        for (const item of [...(store.orders?.pedidos ?? []), ...(store.settlements?.liquidaciones ?? [])]) {
          expect(Object.keys(item).sort()).toEqual(["hash", "id", "updatedAt"]);
          expect(item.hash).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    });

    // Se capturan todas las tiendas reales con key de lectura activa: el 2026-10-05 son dos (Kovia y DANDA;
    // ONEP no tiene key), y crearle una a una tienda real solo para la prueba seria escribir en produccion.
    it("al menos dos tiendas reales, cada una con sus cinco lecturas sin error", () => {
      const data = JSON.parse(evidenceRaw() || "{}");
      const stores: Array<Record<string, any>> = data.stores ?? [];
      expect(stores.length).toBeGreaterThanOrEqual(2);
      for (const store of stores) {
        expect(store.sellerId).not.toBe("seller-test-029");
        for (const resource of ["kpis", "orders", "settlements", "resumen", "index"]) {
          expect(store[resource]?.ok, `${store.sellerId} ${resource}`).toBe(true);
        }
      }
    });
  });
});

describe("T25 · salvaguardas de scripts/verify-029.js y modo kovia-replay (plan 5.3 (a)-(d), RF_11, RF_16)", () => {
  /*
   * Contrato (T25; el guion NO se ejecuta contra produccion en esta tarea, lo hace `run-all` en T27):
   *
   * Constantes de primer nivel, cada literal UNA sola vez en el fuente sin comentarios (el resto las usa por
   * nombre; `CAPTURE_TEST_SELLER` pasa a ser `= TEST_SELLER_ID`, y el prefijo de idempotencia/limite se arma
   * como `${TEST_SELLER_ID}__`):
   *   TEST_SELLER_ID = "seller-test-029"            TEST_SHOP_DOMAIN = "kentro-test-029.myshopify.com"
   *   TEST_DRIVER_ID = "driver-test-029"            TEST_ORDER_NUMBER_PREFIX = "TEST-029-"
   *   TEST_EXTERNAL_ID_PREFIX = "test-029-"         SHOPIFY_TEST_ID_MIN = 9029000000000
   *   SHOPIFY_TEST_ID_MAX = 9029000000999
   *   SHOPIFY_WEBHOOK_URL (contiene "/shopifyWebhook") y STORE_ORDER_WEBHOOK_URL (contiene "/storeOrderWebhook"):
   *   unicos sitios con esos nombres de funcion; todo envio usa la constante.
   *
   * Funciones de primer nivel (`function`/`async function`), exportadas en `module.exports` junto a lo de T24:
   *   assertNotExists(path, deps?)       path "coleccion/id"; deps.db (por defecto el `db` del guion); lee con
   *                                      `db.doc(path).get()` y LANZA si existe. No escribe.
   *   recordCreated(kind, id, options?)  sincrona; anade { kind, id, at } a `entries` de options.file (por defecto
   *                                      EV/t27-registro.json; el archivo es `{ "entries": [...] }`). `kind` es una
   *                                      clave de SAFE_DELETE_RULES; `id` un texto de id. LANZA (sin tocar el archivo)
   *                                      si kind no tiene regla, si id no es texto, tiene espacios, empieza por
   *                                      `kw_`, contiene 48 hex seguidos o contiene un valor pasado a rememberSecret.
   *   rememberSecret(value)              registra en memoria un secreto (contrasena, key, secreto de Shopify o de
   *                                      webhook) para que recordCreated lo rechace. No lo escribe en ninguna parte.
   *   safeDelete(collection, id, deps?)  deps = { db, auth, registro } (registro = { entries: [{ kind, id }] });
   *                                      unico sitio con `.delete(`/`deleteUser(`; lee el documento (o el usuario) y
   *                                      comprueba su pertenencia con SAFE_DELETE_RULES[collection]; si no
   *                                      pertenece LANZA sin borrar; coleccion sin regla LANZA sin leer ni borrar.
   *   SAFE_DELETE_RULES                  objeto con una regla por cada fila de la tabla 5.3 (c): orders,
   *                                      orderHistory, walletEntries, auditEvents, inventory, productCatalog,
   *                                      sellers, storeApiConfigs, storeApiIdempotency, storeApiRateLimits,
   *                                      shopifyStores, importRuns, storeWebhookSamples, shopifySyncIssues,
   *                                      authUsers (usuarios de Auth) y storeWebhookConfigs (config de webhook).
   *
   * Modo `kovia-replay`: en WRITE_MODES y en COMMANDS -> funcion de primer nivel. Lee el fixture
   * `029-kovia-order.json`; crea el `shopifyStores` de prueba (shopDomain TEST_SHOP_DOMAIN, sellerId
   * TEST_SELLER_ID); `assertNotExists(` antes del replay 1; `assertIsTestOrder(` (el pedido existente es el del
   * replay 1: sellerId == TEST_SELLER_ID) antes del replay 2; firma con `createHmac(` y la cabecera
   * `x-shopify-hmac-sha256`; anota con `recordCreated(` antes de crear nada. El secreto de Shopify vive solo en
   * memoria: ninguna variable cuyo nombre contenga "secret" llega a console.*, fs.write* o fs.append*,
   * process.stdout.write ni recordCreated.
   *
   * Con WRITE_MODES ya no vacia, la guarda de T1 "sin modos de escritura no hay llamadas de escritura" deja de
   * morder; la sustituye aqui: toda llamada de escritura de Firestore vive en el cierre de un modo de
   * WRITE_MODES o en safeDelete, y ningun modo de solo lectura alcanza una funcion que escriba.
   */
  const SCRIPT = "scripts/verify-029.js";
  const FIXTURE = "src/lib/fixtures/029-kovia-order.json";
  const source = () => sourceWithoutComments(SCRIPT);
  const READ_ONLY_MODES = ["baseline", "query-check", "capture-reads"];
  const TABLE_COLLECTIONS = [
    "orders", "orderHistory", "walletEntries", "auditEvents", "inventory", "productCatalog", "sellers",
    "storeApiConfigs", "storeApiIdempotency", "storeApiRateLimits", "shopifyStores", "importRuns",
    "storeWebhookSamples", "shopifySyncIssues", "authUsers", "storeWebhookConfigs"
  ];
  const ID_MIN = 9029000000000;
  const ID_MAX = 9029000000999;
  const TEST_SELLER = "seller-test-029";
  const TEST_DOMAIN = "kentro-test-029.myshopify.com";

  const writeModes = (): string[] => {
    const match = source().match(/const\s+WRITE_MODES\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/);
    return [...(match?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
  };
  const commandFn = (mode: string): string | null => {
    const commands = source().match(/const\s+COMMANDS\s*=\s*\{([^}]*)\}/)?.[1] ?? "";
    const escaped = mode.replace(/[-]/g, "\\-");
    return commands.match(new RegExp(`["']${escaped}["']\\s*:\\s*([A-Za-z_$][\\w$]*)`))?.[1] ?? null;
  };
  const topLevelNames = (src: string) => [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  /** Rango [inicio, fin) de cada funcion de primer nivel. */
  const topLevelRanges = (src: string) =>
    topLevelNames(src).map((name) => {
      const body = topLevelFunctionBody(src, name) ?? "";
      const start = src.indexOf(body);
      return { name, start, end: start + body.length, body };
    });
  const enclosing = (src: string, index: number) => topLevelRanges(src).find((r) => index >= r.start && index < r.end) ?? null;
  /** Nombres de las funciones de primer nivel alcanzables por nombre desde `root`. */
  const closureNames = (root: string): string[] => {
    const src = source();
    const names = topLevelNames(src);
    const seen = new Set<string>([root]);
    const queue = [root];
    while (queue.length) {
      const body = topLevelFunctionBody(src, queue.shift() as string) ?? "";
      for (const name of names) {
        if (!seen.has(name) && new RegExp(`\\b${name}\\b`).test(body)) {
          seen.add(name);
          queue.push(name);
        }
      }
    }
    return [...seen];
  };
  const closureBody = (root: string) => closureNames(root).map((name) => topLevelFunctionBody(source(), name) ?? "").join("\n");
  const indexesOf = (text: string, needle: string) => {
    const found: number[] = [];
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) found.push(i);
    return found;
  };
  /** Texto de los argumentos de la llamada cuyo `(` esta en `open`, con parentesis equilibrados. */
  const callArgs = (text: string, open: number) => {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    return text.slice(open + 1);
  };
  /** Quita el texto de los literales y deja las expresiones `${...}` de las plantillas. */
  const withoutStringText = (text: string) =>
    text
      .replace(/`(?:[^`\\]|\\.)*`/g, (tpl) => [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join(" "))
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

  const koviaFn = () => commandFn("kovia-replay");

  async function loadScript(): Promise<Record<string, any>> {
    const { createRequire } = await import("node:module");
    return createRequire(import.meta.url)(absolute(SCRIPT));
  }

  describe("modo kovia-replay y WRITE_MODES", () => {
    it("kovia-replay esta en WRITE_MODES y COMMANDS lo registra con una funcion de primer nivel", () => {
      expect(writeModes()).toContain("kovia-replay");
      expect(koviaFn()).not.toBeNull();
      expect(topLevelFunctionBody(source(), koviaFn() ?? "") ?? "").not.toBe("");
    });

    it("los modos de solo lectura siguen fuera de WRITE_MODES", () => {
      for (const mode of READ_ONLY_MODES) expect(writeModes()).not.toContain(mode);
    });

    it.each(WRITE_CALLS)("ningun modo de solo lectura alcanza una funcion que escriba: %s", (writeCall) => {
      for (const mode of READ_ONLY_MODES) {
        const fn = commandFn(mode);
        expect(fn, `COMMANDS no registra ${mode}`).not.toBeNull();
        expect(closureBody(fn as string), `${mode} alcanza ${writeCall}`).not.toContain(writeCall);
      }
    });

    it("toda llamada de escritura de Firestore esta en el cierre de un modo de WRITE_MODES o en safeDelete (sustituye a la guarda de T1)", () => {
      const src = source();
      const allowed = new Set<string>(["safeDelete"]);
      for (const mode of writeModes()) {
        const fn = commandFn(mode);
        if (fn) for (const name of closureNames(fn)) allowed.add(name);
      }
      const offenders: string[] = [];
      for (const call of [...WRITE_CALLS, ".add("]) {
        for (const index of indexesOf(src, call)) {
          const owner = enclosing(src, index);
          if (!owner || !allowed.has(owner.name)) offenders.push(`${call} en ${owner?.name ?? "nivel superior"}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("lee el fixture 029-kovia-order.json", () => {
      expect(closureBody(koviaFn() ?? "__none__")).toContain("029-kovia-order.json");
    });

    it("kovia-replay solo escribe con sellerId TEST_SELLER_ID y con el dominio TEST_SHOP_DOMAIN", () => {
      const body = closureBody(koviaFn() ?? "__none__");
      const sellerIds = [...body.matchAll(/\bsellerId\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
      expect(sellerIds.length, "kovia-replay no declara sellerId de lo que crea").toBeGreaterThan(0);
      for (const value of sellerIds) expect(value).toBe("TEST_SELLER_ID");
      const domains = [...body.matchAll(/\bshopDomain\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
      expect(domains.length, "kovia-replay no crea el shopifyStores de prueba").toBeGreaterThan(0);
      for (const value of domains) expect(value).toBe("TEST_SHOP_DOMAIN");
      expect(body).toMatch(/collection\(\s*["']shopifyStores["']\s*\)/);
    });

    it("firma con createHmac y la cabecera x-shopify-hmac-sha256, y manda el dominio sintetico", () => {
      const body = closureBody(koviaFn() ?? "__none__");
      expect(body).toMatch(/createHmac\(\s*["']sha256["']/);
      expect(body).toMatch(/x-shopify-hmac-sha256/i);
      expect(body).toMatch(/["']x-shopify-shop-domain["']\s*:\s*TEST_SHOP_DOMAIN/i);
    });

    it("anota con recordCreated( antes de la primera escritura y del primer envio", () => {
      const body = topLevelFunctionBody(source(), koviaFn() ?? "__none__") ?? "";
      const firstRecord = body.indexOf("recordCreated(");
      expect(firstRecord, "kovia-replay no llama a recordCreated(").toBeGreaterThanOrEqual(0);
      for (const marker of [".set(", ".create(", "SHOPIFY_WEBHOOK_URL"]) {
        const at = body.indexOf(marker);
        if (at >= 0) expect(firstRecord, `recordCreated despues de ${marker}`).toBeLessThan(at);
      }
    });
  });

  describe("(a) comprobacion previa antes de cada envio", () => {
    it("declara SHOPIFY_WEBHOOK_URL y STORE_ORDER_WEBHOOK_URL, unicos sitios con esos nombres de funcion", () => {
      const src = source();
      expect(src).toMatch(/const\s+SHOPIFY_WEBHOOK_URL\s*=\s*[^;]*shopifyWebhook/);
      expect(src).toMatch(/const\s+STORE_ORDER_WEBHOOK_URL\s*=\s*[^;]*storeOrderWebhook/);
      expect(indexesOf(src, "shopifyWebhook").length).toBe(1);
      expect(indexesOf(src, "storeOrderWebhook").length).toBe(1);
    });

    it("kovia-replay envia al shopifyWebhook dos veces (replay 1 y replay 2)", () => {
      const body = topLevelFunctionBody(source(), koviaFn() ?? "__none__") ?? "";
      expect(indexesOf(body, "SHOPIFY_WEBHOOK_URL").length).toBeGreaterThanOrEqual(2);
    });

    it("cada envio va precedido, en la misma funcion, de assertNotExists( (el primero) o assertIsTestOrder( (los siguientes)", () => {
      const src = source();
      const offenders: string[] = [];
      for (const constant of ["SHOPIFY_WEBHOOK_URL", "STORE_ORDER_WEBHOOK_URL"]) {
        const declaration = src.search(new RegExp(`const\\s+${constant}\\s*=`));
        for (const index of indexesOf(src, constant)) {
          if (index >= declaration && index < declaration + 40) continue;
          const owner = enclosing(src, index);
          if (!owner) {
            offenders.push(`${constant} fuera de una funcion de primer nivel`);
            continue;
          }
          const sendsBefore = indexesOf(owner.body, constant).filter((i) => owner.start + i < index);
          const since = sendsBefore.length ? sendsBefore[sendsBefore.length - 1] : 0;
          const window = owner.body.slice(since, index - owner.start);
          const ok = sendsBefore.length === 0 ? window.includes("assertNotExists(") : /assertNotExists\(|assertIsTestOrder\(/.test(window);
          if (!ok) offenders.push(`${constant} en ${owner.name} sin comprobacion previa`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("kovia-replay comprueba que el pedido no existe sobre orders/shopify-<id sintetico>", () => {
      const body = topLevelFunctionBody(source(), koviaFn() ?? "__none__") ?? "";
      expect(body).toMatch(/assertNotExists\(\s*`orders\/shopify-\$\{/);
    });

    it("assertNotExists lanza si el documento existe y no escribe (db falso)", async () => {
      const mod = await loadScript();
      expect(typeof mod.assertNotExists).toBe("function");
      const fake = fakeDb({ "orders/shopify-9029000000001": { sellerId: TEST_SELLER } });
      await expect((async () => mod.assertNotExists("orders/shopify-9029000000001", { db: fake.db }))()).rejects.toThrow();
      await expect((async () => mod.assertNotExists("orders/shopify-9029000000002", { db: fake.db }))()).resolves.not.toThrow();
      expect(fake.deleted).toEqual([]);
    });
  });

  describe("(b) solo ids sinteticos", () => {
    const CONSTANTS: Array<[string, string]> = [
      ["TEST_SELLER_ID", `"seller-test-029"`],
      ["TEST_SHOP_DOMAIN", `"kentro-test-029.myshopify.com"`],
      ["TEST_DRIVER_ID", `"driver-test-029"`],
      ["TEST_ORDER_NUMBER_PREFIX", `"TEST-029-"`],
      ["TEST_EXTERNAL_ID_PREFIX", `"test-029-"`],
      ["SHOPIFY_TEST_ID_MIN", "9029000000000"],
      ["SHOPIFY_TEST_ID_MAX", "9029000000999"]
    ];

    it.each(CONSTANTS)("declara %s = %s", (name, value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^"|"$/g, "[\"']");
      expect(source()).toMatch(new RegExp(`^const\\s+${name}\\s*=\\s*${escaped}\\s*;`, "m"));
    });

    it.each(["seller-test-029", "driver-test-029", "kentro-test-029.myshopify.com", "TEST-029-", "test-029-"])(
      "el literal %s aparece una sola vez (en su constante)",
      (literal) => {
        expect(indexesOf(source(), literal).length).toBe(1);
      }
    );

    it("ningun otro dominio myshopify.com en el guion", () => {
      expect(indexesOf(source(), "myshopify.com").length).toBe(1);
    });

    it("todo literal numerico de 10+ digitos esta en el rango reservado", () => {
      const outside = [...source().matchAll(/(?<![\w.])\d{10,}(?![\w.])/g)].map((m) => Number(m[0])).filter((n) => n < ID_MIN || n > ID_MAX);
      expect(outside).toEqual([]);
    });

    it("ningun id de pedido de Shopify escrito a mano (shopify-<digitos>)", () => {
      expect(source()).not.toMatch(/["'`]shopify-\d/);
    });

    it("el fixture usa las mismas constantes: dominio sintetico, TEST-029- y rango reservado", () => {
      expect(existsSync(absolute(FIXTURE)), `falta ${FIXTURE}`).toBe(true);
      const text = readFileSync(absolute(FIXTURE), "utf8");
      const f = JSON.parse(text) as { shopDomain: string; shopifyPayload: { id: number; name: string }; order: { sellerId: string } };
      expect(f.shopDomain).toBe(TEST_DOMAIN);
      expect(f.shopifyPayload.name.startsWith("TEST-029-")).toBe(true);
      expect(f.shopifyPayload.id >= ID_MIN && f.shopifyPayload.id <= ID_MAX).toBe(true);
      expect(f.order.sellerId).toBe(TEST_SELLER);
    });
  });

  describe("(c) limpieza solo con safeDelete y prueba de pertenencia", () => {
    it("ningun .delete(, deleteUser(, deleteUsers( ni recursiveDelete( fuera de safeDelete", () => {
      const src = source();
      expect(topLevelFunctionBody(src, "safeDelete"), "falta function safeDelete").not.toBeNull();
      const offenders: string[] = [];
      for (const call of [".delete(", "deleteUser(", "deleteUsers(", "recursiveDelete("]) {
        for (const index of indexesOf(src, call)) {
          const owner = enclosing(src, index);
          if (owner?.name !== "safeDelete") offenders.push(`${call} en ${owner?.name ?? "nivel superior"}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("SAFE_DELETE_RULES tiene una regla por cada coleccion de la tabla 5.3 (c) y ninguna mas", async () => {
      const mod = await loadScript();
      expect(mod.SAFE_DELETE_RULES).toBeTruthy();
      expect(Object.keys(mod.SAFE_DELETE_RULES).sort()).toEqual([...TABLE_COLLECTIONS].sort());
      for (const name of TABLE_COLLECTIONS) expect(typeof mod.SAFE_DELETE_RULES[name], name).toBe("function");
    });

    const registro = {
      entries: [
        { kind: "orders", id: "shopify-9029000000001" },
        { kind: "importRuns", id: "run-test-1" },
        { kind: "authUsers", id: "uidTest029Seller000000000001" }
      ]
    };
    const seed = () => ({
      "orders/shopify-9029000000001": { sellerId: TEST_SELLER },
      "orders/shopify-real-1": { sellerId: "kovia" },
      "orderHistory/h-test": { sellerId: TEST_SELLER, orderId: "shopify-9029000000001" },
      "orderHistory/h-real": { sellerId: "kovia", orderId: "shopify-real-1" },
      "walletEntries/w-test": { orderId: "shopify-9029000000001" },
      "walletEntries/w-real": { orderId: "shopify-real-1" },
      "auditEvents/a-order": { entityId: "shopify-9029000000001" },
      "auditEvents/a-seller": { entityId: TEST_SELLER },
      "auditEvents/a-real": { entityId: "shopify-real-1" },
      "inventory/i-test": { sellerId: TEST_SELLER },
      "inventory/i-real": { sellerId: "kovia" },
      "productCatalog/p-test": { sellerId: TEST_SELLER },
      "productCatalog/p-real": { sellerId: "kovia" },
      [`sellers/${TEST_SELLER}`]: { name: "Tienda de pruebas 029" },
      "sellers/kovia": { name: "Kovia" },
      [`storeApiConfigs/${TEST_SELLER}`]: { sellerId: TEST_SELLER },
      "storeApiConfigs/kovia": { sellerId: "kovia" },
      [`storeApiIdempotency/${TEST_SELLER}__k1`]: {},
      "storeApiIdempotency/kovia__k1": {},
      [`storeApiRateLimits/${TEST_SELLER}__202610051500`]: {},
      "storeApiRateLimits/seller-test-0299__202610051500": {},
      "shopifyStores/st-test": { shopDomain: TEST_DOMAIN, sellerId: TEST_SELLER },
      "shopifyStores/st-real": { shopDomain: "kovia-real.myshopify.com", sellerId: "kovia" },
      "importRuns/run-test-1": { sellerId: TEST_SELLER },
      "importRuns/run-real": { sellerId: TEST_SELLER },
      "storeWebhookSamples/s-test": { sellerId: TEST_SELLER },
      "storeWebhookSamples/s-real": { sellerId: "kovia" },
      "shopifySyncIssues/x-test": { sellerId: TEST_SELLER },
      "shopifySyncIssues/x-real": { sellerId: "kovia" },
      [`storeWebhookConfigs/${TEST_SELLER}`]: { sellerId: TEST_SELLER },
      "storeWebhookConfigs/kovia": { sellerId: "kovia" },
      "settlements/c-test": { sellerId: TEST_SELLER }
    });

    const CASES: Array<[string, string, string]> = [
      ["orders", "shopify-9029000000001", "shopify-real-1"],
      ["orderHistory", "h-test", "h-real"],
      ["walletEntries", "w-test", "w-real"],
      ["auditEvents", "a-order", "a-real"],
      ["auditEvents", "a-seller", "a-real"],
      ["inventory", "i-test", "i-real"],
      ["productCatalog", "p-test", "p-real"],
      ["sellers", TEST_SELLER, "kovia"],
      ["storeApiConfigs", TEST_SELLER, "kovia"],
      ["storeApiIdempotency", `${TEST_SELLER}__k1`, "kovia__k1"],
      ["storeApiRateLimits", `${TEST_SELLER}__202610051500`, "seller-test-0299__202610051500"],
      ["shopifyStores", "st-test", "st-real"],
      ["importRuns", "run-test-1", "run-real"],
      ["storeWebhookSamples", "s-test", "s-real"],
      ["shopifySyncIssues", "x-test", "x-real"],
      ["storeWebhookConfigs", TEST_SELLER, "kovia"]
    ];

    it.each(CASES)("%s: borra lo de prueba (%s) y se niega con lo ajeno (%s) sin borrarlo", async (collection, ownId, foreignId) => {
      const mod = await loadScript();
      expect(typeof mod.safeDelete).toBe("function");
      const fake = fakeDb(seed());
      const deps = { db: fake.db, auth: fakeAuth().auth, registro };
      await expect((async () => mod.safeDelete(collection, foreignId, deps))()).rejects.toThrow();
      expect(fake.deleted).toEqual([]);
      await mod.safeDelete(collection, ownId, deps);
      expect(fake.deleted).toEqual([`${collection}/${ownId}`]);
    });

    it("usuarios de Auth: solo borra un uid del registro", async () => {
      const mod = await loadScript();
      const auth = fakeAuth();
      const deps = { db: fakeDb(seed()).db, auth: auth.auth, registro };
      await expect((async () => mod.safeDelete("authUsers", "uidRealDeUnaTiendaDeVerdad01", deps))()).rejects.toThrow();
      expect(auth.deleted).toEqual([]);
      await mod.safeDelete("authUsers", "uidTest029Seller000000000001", deps);
      expect(auth.deleted).toEqual(["uidTest029Seller000000000001"]);
    });

    it.each(["settlements", "users", "drivers", "pickupBatches", "cities", "settings"])(
      "una coleccion sin regla (%s) lanza sin leer ni borrar",
      async (collection) => {
        expect(typeof (await loadScript()).safeDelete).toBe("function");
        const mod = await loadScript();
        const fake = fakeDb(seed());
        await expect((async () => mod.safeDelete(collection, "c-test", { db: fake.db, auth: fakeAuth().auth, registro }))()).rejects.toThrow();
        expect(fake.deleted).toEqual([]);
        expect(fake.reads.filter((path) => path.startsWith(`${collection}/`))).toEqual([]);
      }
    );
  });

  describe("(d) el registro no lleva secretos y el secreto de Shopify no sale del proceso", () => {
    async function tempFile(): Promise<string> {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      return join(mkdtempSync(join(tmpdir(), "t25-registro-")), "t27-registro.json");
    }

    it("recordCreated anade { kind, id, at } a entries del archivo indicado", async () => {
      const mod = await loadScript();
      expect(typeof mod.recordCreated).toBe("function");
      const file = await tempFile();
      mod.recordCreated("orders", "shopify-9029000000001", { file });
      mod.recordCreated("shopifyStores", TEST_DOMAIN, { file });
      mod.recordCreated("authUsers", "uidTest029Seller000000000001", { file });
      const saved = JSON.parse(readFileSync(file, "utf8")) as { entries: Array<{ kind: string; id: string; at: string }> };
      expect(saved.entries.map(({ kind, id }) => ({ kind, id }))).toEqual([
        { kind: "orders", id: "shopify-9029000000001" },
        { kind: "shopifyStores", id: TEST_DOMAIN },
        { kind: "authUsers", id: "uidTest029Seller000000000001" }
      ]);
      for (const entry of saved.entries) expect(typeof entry.at).toBe("string");
    });

    const SECRET_SHAPED: Array<[string, unknown]> = [
      ["key de escritura kw_", "kw_0123456789abcdef0123456789abcdef0123456789abcdef"],
      ["key de lectura (48 hex)", "0123456789abcdef0123456789abcdef0123456789abcdef"],
      ["48 hex dentro de un id", "seller-test-029__0123456789abcdef0123456789abcdef0123456789abcdef"],
      ["texto con espacios (contrasena)", "una contrasena con espacios"],
      ["no es texto", { password: "x" }],
      ["vacio", ""]
    ];

    it.each(SECRET_SHAPED)("recordCreated rechaza %s y no toca el archivo", async (_label, value) => {
      expect(typeof (await loadScript()).recordCreated).toBe("function");
      const mod = await loadScript();
      const file = await tempFile();
      expect(() => mod.recordCreated("orders", value, { file })).toThrow();
      expect(existsSync(file)).toBe(false);
    });

    it("recordCreated rechaza un kind sin regla de limpieza", async () => {
      expect(typeof (await loadScript()).recordCreated).toBe("function");
      const mod = await loadScript();
      const file = await tempFile();
      expect(() => mod.recordCreated("settlements", "c-test", { file })).toThrow();
      expect(existsSync(file)).toBe(false);
    });

    it("recordCreated rechaza un valor registrado con rememberSecret (o que lo contiene)", async () => {
      const mod = await loadScript();
      expect(typeof mod.rememberSecret).toBe("function");
      const password = "Zq8vN2pLr5Tx9WbK3mYc";
      mod.rememberSecret(password);
      const file = await tempFile();
      expect(() => mod.recordCreated("authUsers", password, { file })).toThrow();
      expect(() => mod.recordCreated("importRuns", `run-${password}`, { file })).toThrow();
      expect(existsSync(file)).toBe(false);
    });

    it("ninguna variable de secreto llega a console.*, fs.write*/append*, process.stdout.write ni recordCreated", () => {
      const src = source();
      const offenders: string[] = [];
      for (const match of src.matchAll(/(?:console\.\w+|fs\.(?:write\w*|append\w*)|process\.stdout\.write|recordCreated)\s*\(/g)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        const args = withoutStringText(callArgs(src, open));
        if (/[A-Za-z_$]*secret[\w$]*/i.test(args)) offenders.push(`${match[0]}${callArgs(src, open).slice(0, 80)}`);
      }
      expect(offenders).toEqual([]);
    });

    it("el secreto de Shopify solo se usa para firmar: createHmac( dentro de kovia-replay", () => {
      const body = closureBody(koviaFn() ?? "__none__");
      expect(body).toMatch(/createHmac\(\s*["']sha256["']\s*,\s*[A-Za-z_$][\w$.]*[Ss]ecret[\w$]*\s*\)/);
    });
  });

  function fakeDb(docs: Record<string, Record<string, unknown>>) {
    const deleted: string[] = [];
    const reads: string[] = [];
    const ref = (path: string) => {
      const [collection, ...rest] = path.split("/");
      const id = rest.join("/");
      return {
        id,
        path,
        parent: { id: collection },
        get: async () => {
          reads.push(path);
          const data = docs[path];
          return { exists: data !== undefined, id, ref: ref(path), data: () => (data === undefined ? undefined : { ...data }) };
        },
        delete: async () => {
          deleted.push(path);
          delete docs[path];
        }
      };
    };
    const db = {
      doc: (path: string) => ref(path),
      collection: (collection: string) => ({ doc: (id: string) => ref(`${collection}/${id}`) })
    };
    return { db, deleted, reads };
  }

  function fakeAuth() {
    const deleted: string[] = [];
    const auth = {
      getUser: async (uid: string) => ({ uid }),
      deleteUser: async (uid: string) => {
        deleted.push(uid);
      }
    };
    return { auth, deleted };
  }
});

describe("T26 · manual de la API en /api-tiendas (RF_17, RNF_01, RNF_02, DoD 5)", () => {
  const PAGE = "src/app/api-tiendas/page.tsx";
  const REQUEST_MODULE = "../../functions/src/store-api-request";

  function page(): string {
    return sourceWithoutComments(PAGE);
  }

  function importsFromRequestModule(source: string, name: string): boolean {
    return new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*store-api-request["']`).test(source);
  }

  it("menciona cada code del catalogo STORE_API_ERROR_HTTP (o lo importa del catalogo)", async () => {
    const { STORE_API_ERROR_HTTP } = (await import(REQUEST_MODULE)) as { STORE_API_ERROR_HTTP: Record<string, number> };
    const source = page();
    if (importsFromRequestModule(source, "STORE_API_ERROR_HTTP")) return;
    const missing = Object.keys(STORE_API_ERROR_HTTP).filter((code) => !source.includes(code));
    expect(missing).toEqual([]);
  });

  it("documenta la precedencia de errores (cada code de STORE_API_PRECEDENCE, o importa la tabla)", async () => {
    const { STORE_API_PRECEDENCE } = (await import(REQUEST_MODULE)) as {
      STORE_API_PRECEDENCE: ReadonlyArray<{ codes: readonly string[] }>;
    };
    const source = page();
    if (importsFromRequestModule(source, "STORE_API_PRECEDENCE")) return;
    expect(source).toMatch(/precedencia/i);
    const missing = STORE_API_PRECEDENCE.flatMap((row) => row.codes).filter((code) => !source.includes(code));
    expect(missing).toEqual([]);
  });

  it.each([
    ["POST", "/confirm"],
    ["PATCH", ""],
    ["POST", "/cancel"],
    ["GET", ""],
    ["GET", "/history"]
  ])("documenta %s /orders/{id}%s", (method, suffix) => {
    const tail = suffix || "(?![/\\w])";
    const route = new RegExp(`\\b${method}\\b[^\\n]{0,120}?/orders/\\{\\w+\\}${tail}`);
    expect(page()).toMatch(route);
  });

  it("documenta Authorization: Bearer, historySince e Idempotency-Key", () => {
    const source = page();
    expect(source).toContain("Authorization: Bearer");
    expect(source).toContain("historySince");
    expect(source).toContain("Idempotency-Key");
  });

  it("documenta el limite de escrituras por minuto con la cifra del catalogo (o la importa)", async () => {
    const { STORE_API_WRITES_PER_MINUTE } = (await import(REQUEST_MODULE)) as { STORE_API_WRITES_PER_MINUTE: number };
    const source = page();
    if (importsFromRequestModule(source, "STORE_API_WRITES_PER_MINUTE")) {
      expect(source).toMatch(/\{\s*STORE_API_WRITES_PER_MINUTE\s*\}/);
      return;
    }
    expect(source).toMatch(new RegExp(`\\b${STORE_API_WRITES_PER_MINUTE}\\b[^\\n]{0,80}minuto`));
  });

  it("dice que el historial no incluye importaciones ni ChatBy", () => {
    const source = page();
    const window = /no incluye[\s\S]{0,400}/i.exec(source)?.[0] ?? "";
    expect(window).toMatch(/importaci/i);
    expect(window).toMatch(/ChatBy/);
  });

  it("explica que el # de Shopify va codificado: shopifyOrderId=%23", () => {
    expect(page()).toContain("shopifyOrderId=%23");
  });

  it("lista juntos los estados editables imported, address_risk y ready_to_assign", () => {
    const source = page();
    const at = source.indexOf("address_risk");
    expect(at).toBeGreaterThanOrEqual(0);
    const window = source.slice(Math.max(0, at - 300), at + 300);
    expect(window).toContain("imported");
    expect(window).toContain("ready_to_assign");
  });

  it("ya no dice \"Ver mi API key\": el boton es \"Ver clave de lectura\" (nota de T20)", () => {
    const source = page();
    expect(source).not.toContain("Ver mi API key");
    expect(source).toContain("Ver clave de lectura");
  });
});

describe("T27 · despliegue, recorrido real en un solo proceso y limpieza (RF_01, RF_11, RF_20, RF_27, RF_16, RNF_05, DoD 3)", () => {
  /*
   * Contrato (T27, plan 5.3 y 10; el guion NO se ejecuta contra produccion en esta tarea: el despliegue y
   * `run-all` los lanza la sesion principal con aprobacion humana). Todo sobre `scripts/verify-029.js`:
   *
   * WRITE_MODES incluye "set-history-since", "run-all" y "cleanup"; COMMANDS los registra con funciones de
   * primer nivel (`cleanup` se llama exactamente `cleanup`: la guarda de T7 lo excluye por ese nombre).
   *
   *   set-history-since   escribe `settings/storeApi` con `.create(` (nunca `.set(`/`.update(`), campo
   *                       `historySince` = `new Date(...)...`, sin literal de fecha.
   *   run-all             UNA funcion: nada que cree antes de su `try {`; `cleanup(` dentro de su `finally {`; sin
   *                       fork/spawn/exec de otro proceso. Su cierre (funciones alcanzadas por nombre) contiene:
   *                       createStoreApiKey, rotateStoreWriteKey, createManualOrder (con `addressRisk: "review"`),
   *                       getOrderAuditTrail, STORE_ORDER_WEBHOOK_URL, `koviaReplay({ ... writeKey ... })`,
   *                       `rememberSecret(` de la key de escritura, el pedido "con lider" (`status: "assigned"`,
   *                       `driverId: TEST_DRIVER_ID`, texto "fuera del canal del cliente"), los CA_01-CA_12, la siembra
   *                       de "order.transition" y "order.messenger_reassigned", p95 con umbral 2000 ms, y las tres
   *                       funciones de comparacion de primer nivel:
   *     compareRealStoreReads   tiendas reales contra t24-reads-antes.json con `compareReads(`; solo GET; no nombra
   *                             writeKey.
   *     compareReadWriteKeys    tienda de pruebas: /resumen, /kpis, /orders y /settlements con readKey y writeKey en
   *                             llamadas consecutivas (solo GET), por valor (`canonicalJson(` o `valueDifferences(`).
   *     compareOrdersById       GET /orders/{id} contra su elemento de GET /orders (20 pedidos reales): solo GET, con
   *                             readKey, sin writeKey, por valor.
   *   Escrituras: toda `.set(`/`.create(`/`.update(`/`.add(`/`batch(`/`runTransaction(`/`createUser(` de una funcion
   *   del cierre de run-all (salvo safeDelete) va precedida en la misma funcion de `recordCreated(` o
   *   `assertIsTestOrder(`. En funciones del cierre que escriben (no solo-lectura), todo `sellerId:` vale
   *   TEST_SELLER_ID (sin abreviatura `{ sellerId }`) y todo `driverId:` vale TEST_DRIVER_ID.
   *   Usuarios: `setCustomUserClaims(uid, { role: "<literal>", ... })` con role en seller | seller_logistics (con
   *   `sellerId: TEST_SELLER_ID`) | admin (sin sellerId, como mucho una llamada); cada `createUser(` precedido de
   *   `recordCreated("authUsers"`. Sin "drivers" ni "pickupBatches" en los modos que escriben.
   *   Siembra de RF_27: la funcion que escribe `collection("auditEvents")` solo toca esa coleccion, anota con
   *   `recordCreated("auditEvents"` y su `entityId:` es una variable comprobada antes con `assertIsTestOrder(`.
   *   El `imported` entra por STORE_ORDER_WEBHOOK_URL desde una funcion que antes llama a
   *   `assertNotExists(\`orders/shopify-${...}\`)` y a `recordCreated("orders"`, usa TEST_EXTERNAL_ID_PREFIX y no
   *   menciona createManualOrder.
   *   cleanup: lee el registro con `readRegistro(` (y "--from-registro" existe en el guion); su cierre solo escribe
   *   via safeDelete, nombra entre comillas las 16 clases de la tabla 5.3 (c), consulta por `orderId`/`entityId`, usa
   *   TEST_SELLER_DOC_PREFIX, imprime con console.* y lanza (`throw`) si queda algo.
   *   Secretos: ningun identificador writeKey/readKey/webhookKey/password/idToken en args de console.*, fs.write* o
   *   append*, process.stdout.write, recordCreated ni JSON.stringify, ni interpolado en una plantilla `${}`; quien
   *   escribe t27-smoke.txt comprueba `kw_` y 48 hex antes.
   * Evidencia (tras run-all; se salta mientras no exista): t27-smoke.txt y t27-registro.json, sin keys.
   */
  const SCRIPT = "scripts/verify-029.js";
  const EV = ".sdd/evidence/029_store_api_confirma_y_corrige_pedidos";
  const SMOKE = `${EV}/t27-smoke.txt`;
  const REGISTRO = `${EV}/t27-registro.json`;
  const source = () => sourceWithoutComments(SCRIPT);
  const NEW_MODES = ["set-history-since", "run-all", "cleanup"];
  const READ_ONLY_MODES = ["baseline", "query-check", "capture-reads"];
  const CLEANUP_KINDS = [
    "orders", "auditEvents", "orderHistory", "walletEntries", "storeWebhookSamples", "shopifySyncIssues",
    "storeApiIdempotency", "storeApiRateLimits", "importRuns", "storeWebhookConfigs", "shopifyStores", "inventory",
    "productCatalog", "storeApiConfigs", "authUsers", "sellers"
  ];
  const SECRET_IDENT = /\b[A-Za-z_$]*(?:writeKey|readKey|webhookKey|password|idToken)[\w$]*/i;

  const writeModes = (): string[] => {
    const match = source().match(/const\s+WRITE_MODES\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/);
    return [...(match?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
  };
  const commandFn = (mode: string): string | null => {
    const commands = source().match(/const\s+COMMANDS\s*=\s*\{([^}]*)\}/)?.[1] ?? "";
    return commands.match(new RegExp(`["']${mode.replace(/-/g, "\\-")}["']\\s*:\\s*([A-Za-z_$][\\w$]*)`))?.[1] ?? null;
  };
  const topLevelNames = (src: string) => [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const bodyOf = (name: string) => topLevelFunctionBody(source(), name) ?? "";
  const closureNames = (root: string | null): string[] => {
    if (!root || !topLevelFunctionBody(source(), root)) return [];
    const names = topLevelNames(source());
    const seen = new Set<string>([root]);
    const queue = [root];
    while (queue.length) {
      const body = bodyOf(queue.shift() as string);
      for (const name of names) {
        if (!seen.has(name) && new RegExp(`\\b${name}\\b`).test(body)) {
          seen.add(name);
          queue.push(name);
        }
      }
    }
    return [...seen];
  };
  const closureBody = (root: string | null) => closureNames(root).map(bodyOf).join("\n");
  const runAllFn = () => commandFn("run-all");
  const runAllClosure = () => closureBody(runAllFn());
  /** Quita `createHmac(...).update(` / `createHash(...).update(`: no son escrituras de Firestore. */
  const withoutHashUpdates = (text: string) => text.replace(/create(?:Hmac|Hash)\([^)]*\)\s*\.update\(/g, "createHashChain(");
  const OWN_WRITE = /\.(?:set|create|update|add|delete)\(|\bbatch\(|runTransaction\(|createUser\(|setCustomUserClaims\(|deleteUser\(/;
  const writesOwn = (body: string) => {
    if (OWN_WRITE.test(withoutHashUpdates(body))) return true;
    return [...body.matchAll(/\bmethod\s*:\s*([^,}\n]+)/g)].some((m) => !/^["'`]GET["'`]$/.test(m[1].trim()));
  };
  const isReadOnlyFn = (name: string) => !closureNames(name).some((n) => writesOwn(bodyOf(n)));
  const callArgs = (text: string, open: number) => {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    return text.slice(open + 1);
  };
  const withoutStringText = (text: string) =>
    text
      .replace(/`(?:[^`\\]|\\.)*`/g, (tpl) => [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join(" "))
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  /** Texto del bloque `{ ... }` que abre en `open` (llaves equilibradas). */
  const block = (text: string, open: number) => {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    return text.slice(open + 1);
  };
  const writingFunctionsOfRunAll = () => closureNames(runAllFn()).filter((name) => name !== "safeDelete" && !isReadOnlyFn(name));

  describe("modos y registro en COMMANDS", () => {
    it.each(NEW_MODES)("%s esta en WRITE_MODES y COMMANDS lo registra con una funcion de primer nivel", (mode) => {
      expect(writeModes()).toContain(mode);
      const fn = commandFn(mode);
      expect(fn, `COMMANDS no registra ${mode}`).not.toBeNull();
      expect(bodyOf(fn ?? "__none__")).not.toBe("");
    });

    it("el modo cleanup es la funcion `cleanup` (la guarda de T7 la exime por ese nombre)", () => {
      expect(commandFn("cleanup")).toBe("cleanup");
    });

    it("los modos de solo lectura siguen fuera de WRITE_MODES", () => {
      for (const mode of READ_ONLY_MODES) expect(writeModes()).not.toContain(mode);
    });
  });

  describe("set-history-since (plan 2.4)", () => {
    const body = () => closureBody(commandFn("set-history-since"));

    it("escribe settings/storeApi con .create( (falla si ya existe)", () => {
      expect(body()).not.toBe("");
      expect(body()).toMatch(/["']settings["']/);
      expect(body()).toMatch(/["']storeApi["']|settings\/storeApi/);
      expect(body()).toContain(".create(");
      expect(body()).toContain("historySince");
    });

    it("no usa .set( ni .update( (no se puede mover hacia adelante por error)", () => {
      expect(body()).not.toBe("");
      expect(withoutHashUpdates(body())).not.toMatch(/\.(?:set|update)\(/);
    });

    it("el valor es la hora real (new Date), sin literal de fecha", () => {
      expect(body()).toMatch(/new Date\(/);
      expect(body()).not.toMatch(/["'`]20\d\d-\d\d/);
    });
  });

  describe("run-all: un solo proceso con cleanup en finally", () => {
    it("su funcion tiene try { ... } finally { cleanup(...) }", () => {
      const body = bodyOf(runAllFn() ?? "__none__");
      expect(body).not.toBe("");
      const finallyAt = body.search(/\bfinally\s*\{/);
      expect(finallyAt, "run-all no tiene finally").toBeGreaterThanOrEqual(0);
      const finallyBlock = block(body, body.indexOf("{", finallyAt));
      expect(finallyBlock).toMatch(/\bcleanup\(/);
      expect(body.search(/\btry\s*\{/)).toBeGreaterThanOrEqual(0);
      expect(body.search(/\btry\s*\{/)).toBeLessThan(finallyAt);
    });

    it("antes de su try { no crea nada (ni anota, ni escribe, ni llama a nada que escriba)", () => {
      const body = bodyOf(runAllFn() ?? "__none__");
      const tryAt = body.search(/\btry\s*\{/);
      expect(tryAt).toBeGreaterThanOrEqual(0);
      const head = body.slice(0, tryAt);
      expect(head).not.toContain("recordCreated(");
      expect(writesOwn(head)).toBe(false);
      for (const name of topLevelNames(source())) {
        if (name !== runAllFn() && new RegExp(`\\b${name}\\(`).test(head)) {
          expect(isReadOnlyFn(name), `run-all llama a ${name} (que escribe) antes de su try`).toBe(true);
        }
      }
    });

    it("no lanza otros procesos (fork/spawn/exec ni node de nuevo)", () => {
      const closure = runAllClosure();
      expect(closure).not.toBe("");
      expect(closure).not.toMatch(/\b(?:fork|spawn|spawnSync|exec|execSync)\(/);
      expect(closure).not.toMatch(/process\.execPath/);
      expect(closure).not.toMatch(/execFileSync\(\s*["']node["']/);
    });

    it.each([
      ["la key de lectura de la tienda de pruebas", "createStoreApiKey"],
      ["la key de escritura con la callable", "rotateStoreWriteKey"],
      ["el alta manual (address_risk e inventario)", "createManualOrder"],
      ["el historial con sesion real (RF_27)", "getOrderAuditTrail"],
      ["el imported por el webhook de tienda", "STORE_ORDER_WEBHOOK_URL"],
      ["la comparacion con la captura de T24", "t24-reads-antes.json"],
      ["la evidencia del smoke", "t27-smoke.txt"]
    ])("el cierre de run-all incluye %s (%s)", (_label, needle) => {
      expect(runAllClosure()).toContain(needle);
    });

    it("pasa la key de escritura a koviaReplay en memoria y la registra con rememberSecret", () => {
      const closure = runAllClosure();
      expect(closure).toMatch(/koviaReplay\(\s*\{[^}]*writeKey/);
      const remembered = [...closure.matchAll(/rememberSecret\(/g)].map((m) => callArgs(closure, (m.index ?? 0) + "rememberSecret".length));
      expect(remembered.some((args) => /writeKey/i.test(args)), "ningun rememberSecret( de la key de escritura").toBe(true);
    });

    it("el alta manual en revision lleva addressRisk: \"review\"", () => {
      expect(runAllClosure()).toMatch(/addressRisk\s*:\s*["']review["']/);
    });

    it("recorre los CA_01-CA_12 del anexo A", () => {
      const closure = runAllClosure();
      for (let n = 1; n <= 12; n += 1) expect(closure).toContain(`CA_${String(n).padStart(2, "0")}`);
    });

    it("mide p95 con umbral de 2 s", () => {
      expect(runAllClosure()).toMatch(/p95/i);
      expect(runAllClosure()).toMatch(/\b2000\b/);
    });
  });

  describe("la key de escritura (y los demas secretos) solo en variables del proceso", () => {
    it("ningun secreto en args de console.*, fs.write*/append*, process.stdout.write, recordCreated ni JSON.stringify", () => {
      const src = source();
      const offenders: string[] = [];
      for (const match of src.matchAll(/(?:console\.\w+|fs\.(?:write\w*|append\w*)|process\.stdout\.write|recordCreated|JSON\.stringify)\s*\(/g)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        const args = withoutStringText(callArgs(src, open));
        if (SECRET_IDENT.test(args)) offenders.push(`${match[0]}${callArgs(src, open).slice(0, 80)}`);
      }
      expect(offenders).toEqual([]);
    });

    it("ningun secreto interpolado en una plantilla ${...}", () => {
      const offenders = [...source().matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).filter((expr) => SECRET_IDENT.test(expr));
      expect(offenders).toEqual([]);
    });

    it("quien escribe t27-smoke.txt comprueba antes que no lleva kw_ ni 48 hex", () => {
      const src = source();
      const constant = src.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*t27-smoke\.txt/)?.[1];
      expect(constant, "falta la constante con la ruta de t27-smoke.txt").toBeTruthy();
      const writers = topLevelNames(src).filter((name) => new RegExp(`fs\\.(?:write|append)\\w*\\(\\s*${constant}\\b`).test(bodyOf(name)));
      expect(writers.length, "nadie escribe t27-smoke.txt").toBeGreaterThan(0);
      for (const name of writers) {
        const closure = closureBody(name);
        expect(closure, `${name} no comprueba kw_`).toContain("kw_");
        expect(closure, `${name} no comprueba 48 hex`).toMatch(/\{48\}/);
      }
    });
  });

  describe("solo ids de prueba en lo que escribe", () => {
    it("toda escritura del cierre de run-all va precedida, en su funcion, de recordCreated( o assertIsTestOrder(", () => {
      const offenders: string[] = [];
      for (const name of closureNames(runAllFn())) {
        if (name === "safeDelete") continue;
        const body = withoutHashUpdates(bodyOf(name));
        for (const match of body.matchAll(/\.(?:set|create|update|add)\(|\bbatch\(|runTransaction\(|createUser\(/g)) {
          const before = body.slice(0, match.index ?? 0);
          if (!/recordCreated\(|assertIsTestOrder\(/.test(before)) offenders.push(`${match[0]} en ${name}`);
        }
      }
      expect(runAllClosure()).not.toBe("");
      expect(offenders).toEqual([]);
    });

    it("en las funciones del cierre que escriben, todo sellerId: es TEST_SELLER_ID (sin abreviatura)", () => {
      const names = writingFunctionsOfRunAll();
      expect(names.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const name of names) {
        const body = bodyOf(name);
        for (const m of body.matchAll(/\bsellerId\s*:\s*([^,}\n]+)/g)) if (m[1].trim() !== "TEST_SELLER_ID") offenders.push(`${name}: sellerId: ${m[1].trim()}`);
        if (/[{,]\s*sellerId\s*[,}]/.test(body)) offenders.push(`${name}: { sellerId } abreviado`);
      }
      expect(offenders).toEqual([]);
    });

    it("el unico driverId que escribe es TEST_DRIVER_ID, y prepara el pedido con lider (status assigned)", () => {
      const offenders: string[] = [];
      for (const name of writingFunctionsOfRunAll()) {
        for (const m of bodyOf(name).matchAll(/\bdriverId\s*:\s*([^,}\n]+)/g)) if (m[1].trim() !== "TEST_DRIVER_ID") offenders.push(`${name}: driverId: ${m[1].trim()}`);
      }
      expect(offenders).toEqual([]);
      expect(runAllClosure()).toMatch(/driverId\s*:\s*TEST_DRIVER_ID/);
      expect(runAllClosure()).toMatch(/status\s*:\s*["']assigned["']/);
    });

    it("declara en la evidencia el paso del driverId como fuera del canal del cliente", () => {
      expect(runAllClosure()).toMatch(/fuera del canal del cliente/i);
    });

    it("el imported entra por STORE_ORDER_WEBHOOK_URL tras assertNotExists(orders/shopify-...) y recordCreated(\"orders\", sin createManualOrder", () => {
      const senders = closureNames(runAllFn()).filter((name) => bodyOf(name).includes("STORE_ORDER_WEBHOOK_URL"));
      expect(senders.length, "run-all no envia al storeOrderWebhook").toBeGreaterThan(0);
      for (const name of senders) {
        const body = bodyOf(name);
        const send = body.indexOf("STORE_ORDER_WEBHOOK_URL");
        const before = body.slice(0, send);
        expect(before, `${name}: falta assertNotExists(orders/shopify-...)`).toMatch(/assertNotExists\(\s*`orders\/shopify-\$\{/);
        expect(before, `${name}: falta recordCreated("orders"`).toMatch(/recordCreated\(\s*["']orders["']/);
        expect(body, `${name}: el id externo no usa TEST_EXTERNAL_ID_PREFIX`).toContain("TEST_EXTERNAL_ID_PREFIX");
        expect(body, `${name}: no debe crear el imported con createManualOrder`).not.toContain("createManualOrder");
      }
    });
  });

  describe("usuarios desechables: solo de la tienda de pruebas y como mucho un admin", () => {
    const claimCalls = () => {
      const src = source();
      return [...src.matchAll(/setCustomUserClaims\(/g)].map((m) => callArgs(src, (m.index ?? 0) + "setCustomUserClaims".length));
    };

    it("crea usuarios seller y seller_logistics con sellerId: TEST_SELLER_ID", () => {
      const calls = claimCalls();
      const roleOf = (args: string) => args.match(/\brole\s*:\s*["']([^"']+)["']/)?.[1] ?? null;
      expect(calls.map(roleOf)).toEqual(expect.arrayContaining(["seller", "seller_logistics"]));
      for (const args of calls) {
        const role = roleOf(args);
        expect(role, `claims sin role literal: ${args.slice(0, 80)}`).not.toBeNull();
        expect(["seller", "seller_logistics", "admin"]).toContain(role);
        if (role === "admin") expect(args).not.toMatch(/sellerId/);
        else expect(args).toMatch(/\bsellerId\s*:\s*TEST_SELLER_ID\b/);
      }
    });

    it("como mucho un admin desechable", () => {
      const admins = claimCalls().filter((args) => /\brole\s*:\s*["']admin["']/.test(args));
      expect(admins.length).toBeLessThanOrEqual(1);
    });

    it("cada createUser( va precedido, en su funcion, de recordCreated(\"authUsers\"", () => {
      const src = source();
      const owners = topLevelNames(src).filter((name) => bodyOf(name).includes("createUser("));
      expect(owners.length, "el guion no crea usuarios").toBeGreaterThan(0);
      for (const name of owners) {
        const body = bodyOf(name);
        for (const m of body.matchAll(/createUser\(/g)) {
          expect(body.slice(0, m.index ?? 0), `${name}: createUser sin recordCreated("authUsers" antes`).toMatch(/recordCreated\(\s*["']authUsers["']/);
        }
      }
    });

    it("ningun modo que escribe toca drivers ni pickupBatches", () => {
      for (const mode of writeModes()) {
        const closure = closureBody(commandFn(mode));
        expect(closure, mode).not.toMatch(/["']drivers["']|["']pickupBatches["']/);
      }
    });
  });

  describe("RF_27: siembra de auditEvents historicos solo sobre pedidos de prueba", () => {
    const seeders = () =>
      closureNames(runAllFn()).filter((name) => {
        const body = bodyOf(name);
        return /collection\(\s*["']auditEvents["']\s*\)/.test(body) && /\.(?:set|create|add)\(/.test(body);
      });

    it("siembra order.transition (permitida) y order.messenger_reassigned (fuera de la lista)", () => {
      expect(runAllClosure()).toContain("order.transition");
      expect(runAllClosure()).toContain("order.messenger_reassigned");
    });

    it("la funcion de siembra existe, solo escribe auditEvents y anota con recordCreated(\"auditEvents\"", () => {
      expect(seeders().length, "nadie siembra auditEvents").toBeGreaterThan(0);
      for (const name of seeders()) {
        const body = bodyOf(name);
        const collections = [...body.matchAll(/collection\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
        expect(new Set(collections), name).toEqual(new Set(["auditEvents"]));
        expect(body).toMatch(/recordCreated\(\s*["']auditEvents["']/);
      }
    });

    it("el entityId sembrado es un pedido comprobado antes con assertIsTestOrder(", () => {
      expect(seeders().length).toBeGreaterThan(0);
      for (const name of seeders()) {
        const body = bodyOf(name);
        const entityIds = [...body.matchAll(/\bentityId\s*:\s*([^,}\n]+)/g)];
        expect(entityIds.length, `${name} no declara entityId`).toBeGreaterThan(0);
        for (const m of entityIds) {
          const expr = m[1].trim();
          expect(expr, `${name}: entityId literal`).toMatch(/^[A-Za-z_$][\w$.]*$/);
          const checks = [...body.slice(0, m.index ?? 0).matchAll(/assertIsTestOrder\(/g)].map((c) => callArgs(body, (c.index ?? 0) + "assertIsTestOrder".length));
          expect(checks.some((args) => new RegExp(`\\b${expr.replace(/[.$]/g, "\\$&")}\\b`).test(args)), `${name}: ${expr} sin assertIsTestOrder antes`).toBe(true);
        }
      }
    });

    it("comprueba con la sesion de tienda que el permitido llega sin identidades y con \"Kentro\"", () => {
      const closure = runAllClosure();
      for (const field of ["actorId", "actorLabel", "actorEmail", "actorRole"]) expect(closure).toContain(field);
      expect(closure).toMatch(/["']Kentro["']/);
    });
  });

  describe("comparaciones de lectura (RF_20, RF_01, nota 13)", () => {
    const methodsAreGet = (closure: string) => [...closure.matchAll(/\bmethod\s*:\s*([^,}\n]+)/g)].every((m) => /^["'`]GET["'`]$/.test(m[1].trim()));

    it.each(["compareRealStoreReads", "compareReadWriteKeys", "compareOrdersById"])("%s es de primer nivel, solo GET, sin escrituras, y run-all la llama", (name) => {
      expect(bodyOf(name), `falta function ${name}`).not.toBe("");
      const closure = closureBody(name);
      expect(closure).toMatch(/\bfetch\(|storeApiGet\(/);
      expect(methodsAreGet(closure)).toBe(true);
      expect(closure).not.toMatch(/["'`](POST|PATCH|PUT|DELETE)["'`]/);
      expect(isReadOnlyFn(name)).toBe(true);
      expect(closureNames(runAllFn())).toContain(name);
    });

    it("compareRealStoreReads: contra t24-reads-antes.json con compareReads(, sin key de escritura", () => {
      const closure = closureBody("compareRealStoreReads");
      expect(closure).toContain("t24-reads-antes.json");
      expect(closure).toContain("compareReads(");
      expect(closure).toMatch(/excluded/);
      expect(closure).not.toMatch(/writeKey/i);
    });

    it("compareReadWriteKeys: tienda de pruebas, cuatro recursos con key de lectura y de escritura, por valor", () => {
      const body = bodyOf("compareReadWriteKeys");
      expect(body).toContain("TEST_SELLER_ID");
      expect(body).toMatch(/readKey/);
      expect(body).toMatch(/writeKey/);
      for (const route of ["resumen", "kpis", "orders", "settlements"]) expect(body).toMatch(new RegExp(`/${route}\\b`));
      expect(closureBody("compareReadWriteKeys")).toMatch(/canonicalJson\(|valueDifferences\(/);
    });

    it("compareOrdersById: 20 pedidos reales, GET /orders/{id} contra GET /orders con key de lectura, por valor", () => {
      const closure = closureBody("compareOrdersById");
      expect(closure).toMatch(/readKey/);
      expect(closure).not.toMatch(/writeKey/i);
      expect(closure).toMatch(/\/orders\/\$\{/);
      expect(closure).toMatch(/\b20\b/);
      expect(closure).toMatch(/canonicalJson\(|valueDifferences\(/);
    });
  });

  describe("cleanup (finally y --from-registro)", () => {
    const closure = () => closureBody("cleanup");

    it("existe --from-registro y cleanup lee el registro con readRegistro(", () => {
      expect(source()).toContain("--from-registro");
      expect(closure()).toContain("readRegistro(");
    });

    it("solo borra mediante safeDelete: fuera de safeDelete su cierre no escribe", () => {
      expect(closure()).toContain("safeDelete(");
      const others = closureNames("cleanup").filter((name) => name !== "safeDelete").map(bodyOf).join("\n");
      expect(withoutHashUpdates(others)).not.toMatch(OWN_WRITE);
    });

    it.each(CLEANUP_KINDS)("recorre %s", (kind) => {
      expect(closure()).toMatch(new RegExp(`["']${kind}["']`));
    });

    it("busca por orderId y entityId de los pedidos de prueba y por el prefijo seller-test-029__", () => {
      expect(closure()).toMatch(/["']orderId["']/);
      expect(closure()).toMatch(/["']entityId["']/);
      expect(closure()).toContain("TEST_SELLER_DOC_PREFIX");
    });

    it("imprime recuento por coleccion y lanza si queda algo", () => {
      expect(closure()).toMatch(/console\.\w+\(/);
      expect(closure()).toMatch(/throw\s+new\s+Error/);
    });
  });

  describe("evidencia (se escribe al ejecutar run-all en produccion; mientras no exista, se salta)", () => {
    const hasSmoke = existsSync(absolute(SMOKE));
    const hasRegistro = existsSync(absolute(REGISTRO));

    it.skipIf(!hasSmoke)("t27-smoke.txt recoge CA, driverId, kovia-replay, RF_27, compare-reads, GET /orders/{id}, p95 y cleanup", () => {
      const text = readFileSync(absolute(SMOKE), "utf8");
      for (let n = 1; n <= 12; n += 1) expect(text).toContain(`CA_${String(n).padStart(2, "0")}`);
      for (const needle of ["fuera del canal del cliente", "replay 1", "PATCH", "replay 2", "RF_11", "RF_27", "compare-reads", "excluidos", "GET /orders/{id}", "p95", "cleanup"]) {
        expect(text).toContain(needle);
      }
    });

    it.skipIf(!hasSmoke)("t27-smoke.txt no contiene keys (kw_ ni 48 hex)", () => {
      const text = readFileSync(absolute(SMOKE), "utf8");
      expect(text).not.toMatch(/kw_/);
      expect(text).not.toMatch(/[0-9a-f]{48}/i);
    });

    it.skipIf(!hasRegistro)("t27-registro.json solo lleva ids de clases con regla de limpieza y ninguna key", async () => {
      const text = readFileSync(absolute(REGISTRO), "utf8");
      expect(text).not.toMatch(/kw_/);
      expect(text).not.toMatch(/[0-9a-f]{48}/i);
      const parsed = JSON.parse(text) as { entries: Array<{ kind: string; id: string }> };
      expect(Array.isArray(parsed.entries)).toBe(true);
      for (const entry of parsed.entries) expect(CLEANUP_KINDS).toContain(entry.kind);
    });
  });
});
