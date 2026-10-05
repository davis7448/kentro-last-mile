/**
 * Guardas de fuente de la spec 029 — `specs/029_store_api_confirma_y_corrige_pedidos.md`.
 *
 * Un bloque `describe("T<n> · ...")` por tarea (plan 5.2). No editar los bloques de otra tarea.
 */
import { existsSync, readFileSync } from "node:fs";
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
