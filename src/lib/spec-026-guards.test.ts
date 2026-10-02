/**
 * Guardas de fuente de la spec 026 — `specs/026_efectivo_que_no_llega_a_un_corte.md`.
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

describe("T1 · verify-026 es de solo lectura", () => {
  /*
   * `scripts/verify-026.js` corre contra produccion y lo lanza una persona; la suite no lo ejecuta.
   * Esta guarda es su unica comprobacion automatica: que no pueda escribir nada y que el modo
   * `baseline` deje las dos evidencias que T7 y T18 necesitan (plan 5.3, 5.4).
   */
  const SCRIPT = "scripts/verify-026.js";
  const source = () => sourceWithoutComments(SCRIPT);

  it("el script existe", () => {
    expect(existsSync(absolute(SCRIPT))).toBe(true);
  });

  it.each([".set(", ".update(", ".delete(", ".create(", "batch(", "runTransaction("])(
    "no contiene ninguna escritura a Firestore: %s",
    (writeCall) => {
      expect(source()).not.toContain(writeCall);
    }
  );

  it("usa firebase-admin de functions/node_modules contra kentro-last-mile", () => {
    expect(source()).toMatch(/require\([^)]*functions\/node_modules\/firebase-admin["']\)?\)/);
    expect(source()).toMatch(/projectId:\s*["']kentro-last-mile["']/);
  });

  it("tiene el subcomando baseline", () => {
    expect(source()).toMatch(/["']baseline["']/);
  });

  it("baseline escribe las dos evidencias de T1", () => {
    expect(source()).toContain("t1-linea-base.txt");
    expect(source()).toContain("t1-linea-base-ids.json");
    expect(source()).toContain("026_efectivo_que_no_llega_a_un_corte");
  });

  it("el archivo de ids lleva over30Days, coveredByNetting y rows (hallazgo D)", () => {
    expect(source()).toMatch(/over30Days/);
    expect(source()).toMatch(/coveredByNetting/);
    expect(source()).toMatch(/\brows\b/);
  });

  it("mide los cortes de domiciliario sin cashPendingCop y con pendiente distinto del recalculado (hallazgo B)", () => {
    expect(source()).toMatch(/cashPendingCop/);
    expect(source()).toMatch(/computeDriverCashSummary/);
  });

  it("contrasta la compensacion con la cifra de referencia 29 / 36 / $1.151.997 (compuerta 5.4)", () => {
    expect(source()).toMatch(/\b29\b/);
    expect(source()).toMatch(/\b36\b/);
    expect(source()).toMatch(/1_?151_?997/);
  });

  it("mide la antiguedad por updatedAt para la compuerta de >30 dias", () => {
    expect(source()).toMatch(/updatedAt/);
    expect(source()).toMatch(/\b30\b/);
  });
});

describe("T2 · query-check: consultas, indices y coste de los dos modos", () => {
  /*
   * T2 (plan 4.3, 5.4, 7): `query-check` lanza cada consulta del cargador con `limit(1)` para que
   * Firestore diga si pide indice, y cronometra la carga completa de los dos modos (resumen e
   * `includeReconciliation`). Las cifras van a `t2-query-check.txt` y de ahi a `docs/rendimiento.md`:
   * evidencia, no estimaciones. Si hace falta un indice se ANADE; ninguno de HEAD puede desaparecer.
   */
  const SCRIPT = "scripts/verify-026.js";
  const EVIDENCE = ".sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t2-query-check.txt";
  const DOC = "docs/rendimiento.md";
  const INDEXES = "firestore.indexes.json";
  const source = () => sourceWithoutComments(SCRIPT);

  /*
   * Cuerpo de la funcion que COMMANDS registra como "query-check". `baseline` (T1) ya cronometra y
   * cita umbrales, asi que buscar en todo el script daria verde sin que query-check exista.
   */
  function queryCheckBody(): string {
    const src = source();
    const name = src.match(/["']query-check["']\s*:\s*([A-Za-z_$][\w$]*)/)?.[1];
    if (!name) return "";
    const start = src.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m"));
    if (start < 0) return "";
    const end = src.indexOf("\n}\n", start);
    return end < 0 ? src.slice(start) : src.slice(start, end + 2);
  }

  function spec026Section(): string {
    const doc = readFileSync(absolute(DOC), "utf8");
    const start = doc.search(/^##+ .*Spec 026/m);
    if (start < 0) return "";
    const rest = doc.slice(start);
    const next = rest.slice(1).search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }

  it("verify-026 registra el subcomando query-check", () => {
    expect(source()).toMatch(/["']query-check["']\s*:/);
  });

  it("query-check lanza las consultas con limit(1)", () => {
    expect(source()).toMatch(/\.limit\(\s*1\s*\)/);
  });

  it("query-check mide los dos modos: resumen e includeReconciliation", () => {
    expect(queryCheckBody()).toMatch(/includeReconciliation/);
    expect(queryCheckBody()).toMatch(/resumen/i);
    expect(queryCheckBody()).toMatch(/conciliaci/i);
  });

  it("query-check cronometra cada carga (ms)", () => {
    expect(queryCheckBody()).toMatch(/performance\.now\(|process\.hrtime|Date\.now\(/);
    expect(queryCheckBody()).toMatch(/\bms\b/);
  });

  it("query-check contrasta con los umbrales de la compuerta 5.4 (20.000 / 30.000 docs, 3 s)", () => {
    expect(queryCheckBody()).toMatch(/20_?000/);
    expect(queryCheckBody()).toMatch(/30_?000/);
    expect(queryCheckBody()).toMatch(/3_?000\b|\b3\s*s\b/);
  });

  it("query-check escribe la evidencia t2-query-check.txt", () => {
    expect(queryCheckBody()).toContain("t2-query-check.txt");
  });

  it("la evidencia t2-query-check.txt existe", () => {
    expect(existsSync(absolute(EVIDENCE))).toBe(true);
  });

  it("la evidencia trae docs y ms de los dos modos", () => {
    const evidence = existsSync(absolute(EVIDENCE)) ? readFileSync(absolute(EVIDENCE), "utf8") : "";
    expect(evidence).toMatch(/resumen/i);
    expect(evidence).toMatch(/conciliaci/i);
    expect(evidence).toMatch(/\d[\d.]*\s*docs/i);
    expect(evidence).toMatch(/\d[\d.]*\s*ms/i);
  });

  it("docs/rendimiento.md tiene la seccion Spec 026", () => {
    expect(spec026Section()).not.toBe("");
  });

  it("la seccion Spec 026 documenta docs y ms de resumen y de conciliacion", () => {
    const section = spec026Section();
    expect(section).toMatch(/resumen/i);
    expect(section).toMatch(/conciliaci/i);
    expect(section).toMatch(/\d[\d.]*\s*docs/i);
    expect(section).toMatch(/\d[\d.]*\s*ms/i);
  });

  it("la seccion Spec 026 cita la evidencia de la que salen las cifras", () => {
    expect(spec026Section()).toContain("t2-query-check.txt");
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

describe("T6 · RF_01: la regla de recibido no se copia", () => {
  /*
   * RF_01 (plan 2.2): la lista usa LA regla de "recibido" de la liquidacion de tienda
   * (`buildCodReceivedSet`, `functions/src/seller-ledger.ts`) importandola. Ningun archivo de la 026
   * puede leer `cashAllocations` ni `covered`, que es la materia prima de esa regla: si aparecen, hay
   * una segunda copia esperando divergir.
   *
   * Lista FIJA de cuatro archivos. Los que todavia no existen se nombran aqui como pendientes (los
   * crean T10, T12 y T14); T17 exige que existan los cuatro.
   */
  const CORE = "functions/src/cash-outstanding.ts";
  const WATCHED = [
    CORE,
    "functions/src/cash-outstanding-api.ts",
    "functions/src/cash-overdue-notice.ts",
    "src/lib/cash-outstanding-view.ts",
  ] as const;
  const PENDING_UNTIL_LATER_TASKS = new Set<string>([
    "functions/src/cash-outstanding-api.ts", // T12
    "functions/src/cash-overdue-notice.ts", // T10
    "src/lib/cash-outstanding-view.ts", // T14
  ]);
  const FORBIDDEN = ["cashAllocations", "covered"] as const;

  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  }

  /** Apariciones de la materia prima de la regla, fuera de comentarios: `"<token> (linea N)"`. */
  function findReceivedRuleCopies(source: string): string[] {
    const found: string[] = [];
    stripComments(source)
      .split("\n")
      .forEach((line, index) => {
        for (const token of FORBIDDEN) {
          if (new RegExp(`\\b${token}\\b`).test(line)) found.push(`${token} (linea ${index + 1})`);
        }
      });
    return found;
  }

  function receivedRuleBody(): string {
    const ledger = readFileSync(absolute("functions/src/seller-ledger.ts"), "utf8");
    const match = ledger.match(/export function buildCodReceivedSet\([\s\S]*?\n}\n/);
    if (!match) throw new Error("no se encontro buildCodReceivedSet en seller-ledger.ts");
    return match[0];
  }

  it("el nucleo existe", () => {
    expect(existsSync(absolute(CORE))).toBe(true);
  });

  it("el nucleo importa buildCodReceivedSet y codPartialReceivedCop de ./seller-ledger", () => {
    const source = sourceWithoutComments(CORE);
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/seller-ledger["']/g)].map((match) => match[1]).join(",");
    expect(imports).toMatch(/\bbuildCodReceivedSet\b/);
    expect(imports).toMatch(/\bcodPartialReceivedCop\b/);
  });

  it("el nucleo llama a buildCodReceivedSet (no solo lo importa)", () => {
    const source = sourceWithoutComments(CORE).replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/g, "");
    expect(source).toMatch(/\bbuildCodReceivedSet\s*\(/);
  });

  it("el nucleo no define su propia funcion de recibido", () => {
    const source = sourceWithoutComments(CORE);
    expect(source).not.toMatch(/function\s+buildCodReceivedSet\b/);
    expect(source).not.toMatch(/function\s+codPartialReceivedCop\b/);
  });

  it("en el nucleo la unica comparacion de estado de corte es 'pending' (el saldado lo decide isDriverSettlementCashSettled)", () => {
    const source = sourceWithoutComments(CORE);
    expect(source).not.toMatch(/[!=]==?\s*["'](paid|reconciled)["']/);
    expect(source).not.toMatch(/["'](paid|reconciled)["']\s*[!=]==?/);
    expect(source).toMatch(/\bisDriverSettlementCashSettled\b/);
  });

  it.each(WATCHED)("%s: sin copia de la regla (o pendiente de su tarea, nombrado)", (file) => {
    if (!existsSync(absolute(file))) {
      expect(PENDING_UNTIL_LATER_TASKS.has(file), `${file} falta y no es de una tarea posterior`).toBe(true);
      return;
    }
    expect(findReceivedRuleCopies(readFileSync(absolute(file), "utf8"))).toEqual([]);
  });

  it("mutacion: el nucleo con el cuerpo de buildCodReceivedSet pegado es detectado", () => {
    const mutated = `${readFileSync(absolute(CORE), "utf8")}\n${receivedRuleBody().replace("export function buildCodReceivedSet", "function receivedCopy")}`;
    const copies = findReceivedRuleCopies(mutated);
    expect(copies.some((hit) => hit.startsWith("cashAllocations"))).toBe(true);
    expect(copies.some((hit) => hit.startsWith("covered"))).toBe(true);
  });

  it("mutacion de control: el mismo cuerpo dentro de un comentario no se cuenta", () => {
    const commented = `${readFileSync(absolute(CORE), "utf8")}\n/*\n${receivedRuleBody()}\n*/\n`;
    expect(findReceivedRuleCopies(commented)).toEqual([]);
  });

  it("la guarda no confunde covered_by_netting con covered", () => {
    expect(findReceivedRuleCopies(`const location = "covered_by_netting";`)).toEqual([]);
  });
});

describe("T12 · alcance, cargador y callable", () => {
  /*
   * T12 (plan 2.1, 2.7, 4.3; RF_06, RF_07, RNF_01, RNF_02).
   *
   * Contrato de `resolveCashOutstandingScope(auth, data)` en `functions/src/cash-outstanding-schemas.ts`
   * (puro: no lanza, devuelve un resultado que el callable traduce a `HttpsError`):
   *
   *   auth: { uid?: string; token?: Record<string, unknown> } | null | undefined   (request.auth)
   *   data: unknown                                                              (request.data, crudo)
   *   -> { ok: true; scope: CashOutstandingScope; coverage: "full" | "targeted" }
   *    | { ok: false; code: "permission-denied" | "invalid-argument"; message: string }
   *
   * - Primero el rol, despues la entrada: un rol sin permiso es `permission-denied` aunque la entrada
   *   tambien sea invalida.
   * - `data` null/undefined se normaliza a `{}` ANTES de `cashOutstandingInputSchema` (que es `.strict()`
   *   y rechaza `null`): un `httpsCallable` sin argumentos manda `null`.
   * - admin -> `{ kind: "admin", includeReconciliation }`; `coverage: "full"` solo si includeReconciliation.
   * - driver con `token.driverId` string no vacio -> `{ kind: "leader", driverId }`, SIEMPRE `targeted`
   *   aunque pida conciliacion (resumen, no se le deniega).
   * - driver sin claim, seller, seller_logistics, messenger, sin sesion -> `permission-denied`.
   * - entrada que no cumple el esquema (p. ej. `driverId` en `data`) -> `invalid-argument`.
   */
  type Scope = { kind: "admin"; includeReconciliation: boolean } | { kind: "leader"; driverId: string };
  type ScopeResolution =
    | { ok: true; scope: Scope; coverage: "full" | "targeted" }
    | { ok: false; code: "permission-denied" | "invalid-argument"; message: string };
  type ScopeAuth = { uid?: string; token?: Record<string, unknown> } | null | undefined;
  type Resolver = (auth: ScopeAuth, data: unknown) => ScopeResolution;

  const SCHEMAS = "functions/src/cash-outstanding-schemas.ts";
  const API = "functions/src/cash-outstanding-api.ts";
  const INDEX = "functions/src/index.ts";
  const SCRIPT = "scripts/verify-026.js";

  async function resolver(): Promise<Resolver> {
    const mod = (await import("../../functions/src/cash-outstanding-schemas")) as unknown as Record<string, unknown>;
    const fn = mod.resolveCashOutstandingScope;
    if (typeof fn !== "function") throw new Error("resolveCashOutstandingScope no esta exportada en cash-outstanding-schemas.ts");
    return fn as Resolver;
  }

  const admin = { uid: "u-admin", token: { role: "admin" } };
  const leader = { uid: "u-lider", token: { role: "driver", driverId: "driver-1" } };

  describe("resolveCashOutstandingScope (puro)", () => {
    it("se exporta desde cash-outstanding-schemas.ts", async () => {
      expect(typeof (await resolver())).toBe("function");
    });

    it("admin sin conciliacion: resumen, targeted", async () => {
      expect((await resolver())(admin, { includeReconciliation: false })).toEqual({
        ok: true,
        scope: { kind: "admin", includeReconciliation: false },
        coverage: "targeted",
      });
    });

    it("admin con conciliacion: full", async () => {
      expect((await resolver())(admin, { includeReconciliation: true })).toEqual({
        ok: true,
        scope: { kind: "admin", includeReconciliation: true },
        coverage: "full",
      });
    });

    it.each([
      ["{}", {}],
      ["null", null],
      ["undefined", undefined],
    ])("admin con data %s: se normaliza a {} y queda en resumen", async (_label, data) => {
      expect((await resolver())(admin, data)).toEqual({
        ok: true,
        scope: { kind: "admin", includeReconciliation: false },
        coverage: "targeted",
      });
    });

    it("lider con claim driverId: alcance de su id, resumen", async () => {
      expect((await resolver())(leader, {})).toEqual({
        ok: true,
        scope: { kind: "leader", driverId: "driver-1" },
        coverage: "targeted",
      });
    });

    it("lider que pide conciliacion recibe resumen (no se deniega, no se le da full)", async () => {
      const result = (await resolver())(leader, { includeReconciliation: true });
      expect(result).toEqual({ ok: true, scope: { kind: "leader", driverId: "driver-1" }, coverage: "targeted" });
    });

    it("lider con data null: resumen", async () => {
      expect((await resolver())(leader, null)).toEqual({
        ok: true,
        scope: { kind: "leader", driverId: "driver-1" },
        coverage: "targeted",
      });
    });

    it.each([
      ["driver sin claim", { uid: "u", token: { role: "driver" } }],
      ["driver con claim vacio", { uid: "u", token: { role: "driver", driverId: "" } }],
      ["driver con claim no string", { uid: "u", token: { role: "driver", driverId: 42 } }],
      ["seller", { uid: "u", token: { role: "seller", sellerId: "s-1" } }],
      ["seller_logistics", { uid: "u", token: { role: "seller_logistics", sellerId: "s-1" } }],
      ["messenger aunque traiga driverId", { uid: "u", token: { role: "messenger", driverId: "driver-1" } }],
      ["sin rol", { uid: "u", token: {} }],
      ["sin token", { uid: "u" }],
      ["sin sesion (null)", null],
      ["sin sesion (undefined)", undefined],
    ])("%s -> permission-denied", async (_label, auth) => {
      const result = (await resolver())(auth as ScopeAuth, {});
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.code).toBe("permission-denied");
    });

    it("el rol se decide antes que la entrada: seller con entrada invalida -> permission-denied", async () => {
      const result = (await resolver())({ uid: "u", token: { role: "seller" } }, { driverId: "driver-1" });
      expect(result.ok ? null : result.code).toBe("permission-denied");
    });

    it("el lider no puede pedir el alcance de otro: driverId en data -> invalid-argument (.strict)", async () => {
      const result = (await resolver())(leader, { driverId: "driver-otro" });
      expect(result.ok ? null : result.code).toBe("invalid-argument");
    });

    it("admin con includeReconciliation no booleano -> invalid-argument", async () => {
      const result = (await resolver())(admin, { includeReconciliation: "si" });
      expect(result.ok ? null : result.code).toBe("invalid-argument");
    });

    it("admin con data que no es objeto -> invalid-argument", async () => {
      const result = (await resolver())(admin, "todo");
      expect(result.ok ? null : result.code).toBe("invalid-argument");
    });

    it("no lanza nunca (devuelve resultado)", async () => {
      const resolve = await resolver();
      expect(() => resolve(undefined, undefined)).not.toThrow();
      expect(() => resolve(admin, Symbol("x"))).not.toThrow();
    });
  });

  describe("guardas de fuente del cargador y del callable", () => {
    const api = () => (existsSync(absolute(API)) ? sourceWithoutComments(API) : "");

    /** Cuerpo de `[export] [async] function <name>(` hasta el primer `\n}\n`. */
    function functionBody(source: string, name: string): string {
      const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
      if (start < 0) return "";
      const end = source.indexOf("\n}\n", start);
      return end < 0 ? source.slice(start) : source.slice(start, end + 2);
    }

    /** Cuerpo de `export const <name> = onCall(` hasta el primer `\n});\n`. */
    function callableBody(source: string, name: string): string {
      const start = source.search(new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*onCall\\(`, "m"));
      if (start < 0) return "";
      const end = source.indexOf("\n});\n", start);
      return end < 0 ? source.slice(start) : source.slice(start, end + 4);
    }

    /** `where("campo", "op", <valor>)` normalizado: literales de cadena y arrays de cadenas se conservan; el resto es `*`. */
    function whereShapes(source: string): Set<string> {
      const shapes = new Set<string>();
      for (const match of source.matchAll(/\.where\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*([^)]*?)\)/g)) {
        const raw = match[3].trim();
        let value = "*";
        if (/^["'][^"']*["']$/.test(raw)) value = raw.slice(1, -1);
        else if (/^\[\s*(["'][^"']*["']\s*,?\s*)+\]$/.test(raw)) {
          value = JSON.stringify([...raw.matchAll(/["']([^"']*)["']/g)].map((item) => item[1]));
        }
        shapes.add(`${match[1]} ${match[2]} ${value}`);
      }
      return shapes;
    }

    function loaderOfQueryCheck(): string {
      const script = sourceWithoutComments(SCRIPT);
      const helpers = script.slice(script.indexOf("const QC_ORDER_FIELDS"), script.indexOf("async function loadLikeTheLoader"));
      return `${helpers}\n${functionBody(script, "loadLikeTheLoader")}`;
    }

    function orderFieldsOfQueryCheck(): string[] {
      const line = sourceWithoutComments(SCRIPT).match(/const QC_ORDER_FIELDS\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
      return [...line.matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
    }

    it("cash-outstanding-api.ts existe", () => {
      expect(existsSync(absolute(API))).toBe(true);
    });

    it("index.ts exporta getCashOutstanding desde ./cash-outstanding-api", () => {
      const index = sourceWithoutComments(INDEX);
      expect(index).toMatch(/export\s*\{[^}]*\bgetCashOutstanding\b[^}]*\}\s*from\s*["']\.\/cash-outstanding-api["']/);
    });

    it("getCashOutstanding es un onCall v2 exportado", () => {
      expect(api()).toMatch(/import\s*\{[^}]*\bonCall\b[^}]*\}\s*from\s*["']firebase-functions\/v2\/https["']/);
      expect(callableBody(api(), "getCashOutstanding")).not.toBe("");
    });

    it("loadCashOutstandingInput existe en el api", () => {
      expect(functionBody(api(), "loadCashOutstandingInput")).not.toBe("");
    });

    it("el callable resuelve el alcance con resolveCashOutstandingScope(request.auth, request.data) y traduce el codigo a HttpsError", () => {
      const body = callableBody(api(), "getCashOutstanding");
      expect(api()).toMatch(/import\s*\{[^}]*\bresolveCashOutstandingScope\b[^}]*\}\s*from\s*["']\.\/cash-outstanding-schemas["']/);
      expect(body).toMatch(/resolveCashOutstandingScope\(\s*request\.auth\s*,\s*request\.data\s*\)/);
      expect(body).toMatch(/new\s+HttpsError\(/);
    });

    it("el alcance sale SOLO del resolvedor: el callable no lee token.driverId ni parsea la entrada por su cuenta", () => {
      const body = callableBody(api(), "getCashOutstanding");
      expect(body).not.toBe("");
      expect(body).not.toMatch(/token\.driverId|token\[["']driverId["']\]/);
      expect(body).not.toMatch(/cashOutstandingInputSchema/);
      expect(body).not.toMatch(/request\.data\??\.(includeReconciliation|driverId)/);
    });

    it("el informe sale de buildCashOutstandingReport importado de ./cash-outstanding", () => {
      expect(api()).toMatch(/import\s*\{[^}]*\bbuildCashOutstandingReport\b[^}]*\}\s*from\s*["']\.\/cash-outstanding["']/);
      expect(api().replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/g, "")).toMatch(/\bbuildCashOutstandingReport\s*\(/);
    });

    it("no copia la regla: no define buildCodReceivedSet/isSellerEntryEligible/buildCashOutstandingReport y, si usa la regla, la importa de ./seller-ledger", () => {
      const source = api();
      expect(source).not.toBe("");
      expect(source).not.toMatch(/function\s+(buildCodReceivedSet|codPartialReceivedCop|isSellerEntryEligible|buildCashOutstandingReport|isDriverSettlementCashSettled)\b/);
      if (/\bbuildCodReceivedSet\b/.test(source)) {
        expect(source).toMatch(/import\s*\{[^}]*\bbuildCodReceivedSet\b[^}]*\}\s*from\s*["']\.\/seller-ledger["']/);
      }
    });

    it.each(["parseCashOutstandingOrders", "parseDriverSettlements", "parseWalletEntries", "readCashAlertSettings"])(
      "el cargador pasa lo leido por %s (Zod; lo ilegible por id, no 0 en silencio)",
      (parser) => {
        expect(api()).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${parser}\\b[^}]*\\}\\s*from\\s*["']\\./cash-outstanding-schemas["']`));
        expect(functionBody(api(), "loadCashOutstandingInput")).toMatch(new RegExp(`\\b${parser}\\(`));
      }
    );

    it("el cargador entrega al nucleo unreadableOrderIds, unreadableSettlementIds y unreadableEntryIds", () => {
      const loader = functionBody(api(), "loadCashOutstandingInput");
      expect(loader).toMatch(/unreadableOrderIds/);
      expect(loader).toMatch(/unreadableSettlementIds/);
      expect(loader).toMatch(/unreadableEntryIds/);
    });

    it("RF_07: sin ventana de fecha ni limit (sin .limit, orderBy, startAt/After, endAt/Before ni where de fecha)", () => {
      const source = api();
      expect(source).not.toBe("");
      expect(source).not.toMatch(/\.limit\(|\.limitToLast\(|\.orderBy\(|\.startAt\(|\.startAfter\(|\.endAt\(|\.endBefore\(|\.offset\(/);
      expect(source).not.toMatch(/\.where\(\s*["'](createdAt|updatedAt|closedAt|deliveredAt|date)["']/);
      expect(source).not.toMatch(/getWindowedOrders|orderTargets/);
    });

    it("las consultas del cargador son las mismas que query-check ejecuto en produccion (en ambos sentidos)", () => {
      const fromApi = whereShapes(api());
      const fromScript = whereShapes(loaderOfQueryCheck());
      expect(fromScript.size).toBeGreaterThan(0);
      expect([...fromApi].filter((shape) => !fromScript.has(shape)).sort()).toEqual([]);
      expect([...fromScript].filter((shape) => !fromApi.has(shape)).sort()).toEqual([]);
    });

    it("los pedidos se leen con select de los mismos campos que query-check", () => {
      const source = api();
      expect(source).toMatch(/\.select\(/);
      const fields = orderFieldsOfQueryCheck();
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.filter((field) => !new RegExp(`["']${field}["']`).test(source))).toEqual([]);
    });

    it.each(["sellers", "drivers", "messengers", "suppliers"])("los nombres de %s se leen con select(\"name\")", (collection) => {
      expect(api()).toMatch(new RegExp(`collection\\(\\s*["']${collection}["']\\s*\\)\\s*\\.select\\(\\s*["']name["']\\s*\\)`));
    });

    it("lee los ajustes de settings/cashAlerts", () => {
      expect(api()).toMatch(/collection\(\s*["']settings["']\s*\)\s*\.doc\(\s*["']cashAlerts["']\s*\)|doc\(\s*["']settings\/cashAlerts["']\s*\)/);
    });

    it("los lotes de orderId in son de 30 (limite de Firestore, igual que query-check)", () => {
      expect(api()).toMatch(/\b30\b/);
    });

    it("el modo con conciliacion (coverage full) solo se alcanza por el resolvedor: ningun 'full' literal fuera del tipo", () => {
      const source = api();
      expect(source).not.toBe("");
      const fullLiterals = source.split("\n").filter((line) => /["']full["']/.test(line));
      expect(fullLiterals.filter((line) => !/===?\s*["']full["']|["']full["']\s*===?|["']full["']\s*\|/.test(line))).toEqual([]);
      expect(source).not.toMatch(/includeReconciliation\s*:\s*true/);
    });

    it("el secreto del canal es OPS_NOTICE_WEBHOOK_URL y el callable lo declara en secrets", () => {
      expect(api()).toMatch(/defineSecret\(\s*["']OPS_NOTICE_WEBHOOK_URL["']\s*\)/);
      expect(callableBody(api(), "getCashOutstanding")).toMatch(/onCall\(\s*\{[^}]*\bsecrets\s*:/);
    });

    // Cambio T13 (2026-10-02, opcion (a) del coordinador): antes contaba los `.value()` de TODO el archivo;
    // `notifyOverdueCash` (T13) necesita la url real para enviar. La intencion de esta guarda es que
    // `getCashOutstanding` no devuelva la url, asi que cuenta solo dentro de su cuerpo. La programada
    // tiene su guarda equivalente en el bloque T13.
    it("la URL del canal no se devuelve: todo .value() del secreto en getCashOutstanding va dentro de isOpsChannelConfigured(...)", () => {
      const source = api();
      expect(source).toMatch(/import\s*\{[^}]*\bisOpsChannelConfigured\b[^}]*\}\s*from\s*["']\.\/ops-notify["']/);
      const body = callableBody(source, "getCashOutstanding");
      const valueCalls = (body.match(/\.value\(\)/g) ?? []).length;
      const wrapped = (body.match(/isOpsChannelConfigured\(\s*[\w$.]+\.value\(\)\s*\)/g) ?? []).length;
      expect(valueCalls).toBeGreaterThan(0);
      expect(valueCalls).toBe(wrapped);
    });

    it("getCashOutstanding y el cargador no escriben (si algun dia escriben, por stripUndefined)", () => {
      const reading = `${callableBody(api(), "getCashOutstanding")}\n${functionBody(api(), "loadCashOutstandingInput")}`;
      expect(reading.trim()).not.toBe("");
      // Solo escrituras de Firestore: `Map.set`/`Set.add` del cargador no cuentan.
      const writes = reading.match(/\b(?:doc|collection)\([^)]*\)\s*\.(?:set|update|create|add|delete)\(|\.(?:batch|bulkWriter|runTransaction)\(/g) ?? [];
      if (writes.length > 0) expect(reading).toMatch(/stripUndefined\(|build\w+Doc\(/);
      expect(writes).toEqual([]);
    });

    it("RNF_01: el api no importa el SDK de cliente ni codigo de src/", () => {
      const source = api();
      expect(source).not.toBe("");
      expect(source).not.toMatch(/from\s*["']firebase\/(firestore|app|auth)["']/);
      expect(source).not.toMatch(/from\s*["'](\.\.\/)+src\//);
    });
  });
});

describe("T13 · escrituras sin undefined y aviso tras envio", () => {
  /*
   * T13 (plan 2.4, 2.6, 2.8, 8; spec RF_04, RF_05 y seccion 9). Archivos: `functions/src/cash-outstanding-api.ts`
   * y `functions/src/index.ts`.
   *
   * Contrato (exportado de `cash-outstanding-api.ts`):
   *
   * 1. `resolveCashAlertSettingsUpdate(auth, data)` — PURO, no lanza:
   *      -> { ok: true; settings: { overdueDays; notifyMinCop } }
   *       | { ok: false; code: "permission-denied" | "invalid-argument"; message: string }
   *    Primero el rol (solo `token.role === "admin"`), despues la entrada con `cashAlertSettingsSchema`.
   *    Los DOS campos son obligatorios: el esquema tiene defectos, y un `{ overdueDays }` suelto pisaria
   *    en silencio el umbral configurado con el defecto. `null`/`undefined`/`{}` -> invalid-argument.
   *
   * 2. `runOverdueNotice(deps)` — la orquestacion de la programada, con la E/S inyectada:
   *      deps = {
   *        runId: string; now: string;
   *        channelUrl: string | undefined | null;                       // el secreto, tal cual
   *        loadReport(): Promise<{ rows; nettedRows; settings; isIncomplete }>;   // modo resumen
   *        loadNotifiedOrderIds(orderIds: string[]): Promise<ReadonlySet<string>>; // cashOverdueNotices
   *        send(text: string, url: string): Promise<OpsNoticeResult>;   // prod: sendOpsNotice
   *        markNotified(docs: CashOverdueNoticeDoc[]): Promise<void>;   // cashOverdueNotices/{orderId}
   *        writeRun(doc: CashOverdueRunDoc): Promise<void>;             // cashOverdueRuns/{runId}
   *      }
   *      -> Promise<CashOverdueRunDoc>   (el mismo documento que se paso a writeRun)
   *    - candidatas = selectNoticeCandidates({ rows, settings }, notificados): nunca `nettedRows`;
   *    - sin canal (isOpsChannelConfigured(channelUrl) falso) -> no envia, no marca, run
   *      `skipped_no_channel` con los ids que se habrian avisado;
   *    - con canal y sin candidatas -> `nothing_to_send`, no envia;
   *    - UN envio con composeOverdueNotice(candidatas, { isIncomplete, now }).text;
   *    - envio ok -> marca TODAS las candidatas (aunque el texto se recorte) con exactamente
   *      buildNoticeDocs({ candidates, runId, now }), y despues escribe el run `sent`;
   *    - envio fallido -> no marca, run `send_failed` (httpStatus si http_error; `error` con el motivo);
   *    - marcado que lanza -> run `mark_failed` con el mensaje en `error`, y la promesa RESUELVE;
   *    - todo run sale de buildRunDoc (sin undefined) y nunca contiene la url del canal.
   *
   * 3. `updateCashAlertSettings` (onCall) y `notifyOverdueCash` (onSchedule 08:00 America/Bogota,
   *    secrets [OPS_NOTICE_WEBHOOK_URL]) exportados desde index.ts.
   *
   * Nota de acoplamiento: la guarda de T12 exige que todo `.where(` del api coincida con query-check y que
   * todo `.value()` del secreto vaya envuelto en isOpsChannelConfigured. Leer las marcas por id
   * (`db.getAll`), no por `where`.
   */
  const API = "functions/src/cash-outstanding-api.ts";
  const INDEX = "functions/src/index.ts";

  type Settings = { overdueDays: number; notifyMinCop: number };
  type Resolution =
    | { ok: true; settings: Settings }
    | { ok: false; code: "permission-denied" | "invalid-argument"; message: string };
  type Auth = { uid?: string; token?: Record<string, unknown> } | null | undefined;
  type SendResult =
    | { ok: true; httpStatus: number }
    | { ok: false; reason: "no_channel" }
    | { ok: false; reason: "http_error"; httpStatus: number }
    | { ok: false; reason: "network_error"; error: string }
    | { ok: false; reason: "timeout"; error: string };
  type Row = import("../../functions/src/cash-outstanding").CashOutstandingRow;
  type NoticeDoc = { id: string; data: Record<string, unknown> };
  type RunDoc = { id: string; status: string; orderIds: string[]; truncated: boolean; error?: string; httpStatus?: number } & Record<string, unknown>;
  type Deps = {
    runId: string;
    now: string;
    channelUrl: string | undefined | null;
    loadReport: () => Promise<{ rows: Row[]; nettedRows: Row[]; settings: Settings; isIncomplete: boolean }>;
    loadNotifiedOrderIds: (orderIds: string[]) => Promise<ReadonlySet<string>>;
    send: (text: string, url: string) => Promise<SendResult>;
    markNotified: (docs: NoticeDoc[]) => Promise<void>;
    writeRun: (doc: RunDoc) => Promise<void>;
  };

  async function apiModule(): Promise<Record<string, unknown>> {
    return (await import("../../functions/src/cash-outstanding-api")) as unknown as Record<string, unknown>;
  }

  async function resolveUpdate(): Promise<(auth: Auth, data: unknown) => Resolution> {
    const fn = (await apiModule()).resolveCashAlertSettingsUpdate;
    if (typeof fn !== "function") throw new Error("resolveCashAlertSettingsUpdate no esta exportada en cash-outstanding-api.ts");
    return fn as (auth: Auth, data: unknown) => Resolution;
  }

  async function runner(): Promise<(deps: Deps) => Promise<RunDoc>> {
    const fn = (await apiModule()).runOverdueNotice;
    if (typeof fn !== "function") throw new Error("runOverdueNotice no esta exportada en cash-outstanding-api.ts");
    return fn as (deps: Deps) => Promise<RunDoc>;
  }

  const admin = { uid: "u-admin", token: { role: "admin" } };

  describe("resolveCashAlertSettingsUpdate (puro): solo admin, entrada completa y validada", () => {
    it("admin con plazo y umbral validos -> ok con esos ajustes", async () => {
      const resolve = await resolveUpdate();
      expect(resolve(admin, { overdueDays: 10, notifyMinCop: 50_000 })).toEqual({ ok: true, settings: { overdueDays: 10, notifyMinCop: 50_000 } });
    });

    it("umbral 0 es valido (avisar todo lo vencido)", async () => {
      const resolve = await resolveUpdate();
      expect(resolve(admin, { overdueDays: 7, notifyMinCop: 0 })).toEqual({ ok: true, settings: { overdueDays: 7, notifyMinCop: 0 } });
    });

    it.each([
      ["lider", { uid: "u-l", token: { role: "driver", driverId: "driver-1" } }],
      ["tienda", { uid: "u-s", token: { role: "seller" } }],
      ["logistico de tienda", { uid: "u-sl", token: { role: "seller_logistics" } }],
      ["mensajero", { uid: "u-m", token: { role: "messenger" } }],
      ["sin rol", { uid: "u-x", token: {} }],
      ["sin sesion", null]
    ])("%s -> permission-denied", async (_label, auth) => {
      const resolve = await resolveUpdate();
      const result = resolve(auth as Auth, { overdueDays: 10, notifyMinCop: 50_000 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("permission-denied");
    });

    it("un rol sin permiso es permission-denied aunque la entrada tambien sea invalida (primero el rol)", async () => {
      const resolve = await resolveUpdate();
      const result = resolve({ uid: "u-s", token: { role: "seller" } }, { overdueDays: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("permission-denied");
    });

    it.each([
      ["plazo 0", { overdueDays: 0, notifyMinCop: 20_000 }],
      ["plazo fraccionario", { overdueDays: 7.5, notifyMinCop: 20_000 }],
      ["plazo como texto", { overdueDays: "7", notifyMinCop: 20_000 }],
      ["umbral negativo", { overdueDays: 7, notifyMinCop: -1 }],
      ["clave de mas", { overdueDays: 7, notifyMinCop: 20_000, driverId: "driver-1" }],
      ["falta el umbral (no se pisa con el defecto)", { overdueDays: 10 }],
      ["falta el plazo (no se pisa con el defecto)", { notifyMinCop: 50_000 }],
      ["objeto vacio", {}],
      ["null", null],
      ["undefined", undefined]
    ])("admin con %s -> invalid-argument", async (_label, data) => {
      const resolve = await resolveUpdate();
      const result = resolve(admin, data);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid-argument");
    });
  });

  describe("runOverdueNotice (orquestacion con E/S inyectada)", () => {
    const NOW = "2026-10-02T13:00:00.000Z";
    const RUN_ID = "run-2026-10-02";
    const URL = "https://hooks.example.test/webhook/SECRET-TOKEN-123";
    const SETTINGS = { overdueDays: 7, notifyMinCop: 20_000 };

    function row(orderId: string, overrides: Partial<Row> = {}): Row {
      return {
        orderId,
        trackingCode: `KNT-${orderId}`,
        sellerId: "seller-1",
        sellerName: "Tienda Uno",
        leaderId: "leader-1",
        leaderName: "Lider Uno",
        messengerId: "messenger-1",
        messengerName: "Mensajero Uno",
        deliveredAt: "2026-09-10T15:00:00.000Z",
        deliveredAtSource: "closedAt",
        ageDays: 22,
        isOverdue: true,
        collectedCop: 95_000,
        collectedSource: "wallet",
        driverPayCop: 9_000,
        expectedCashCop: 86_000,
        receivedCop: 0,
        outstandingCop: 86_000,
        location: "outside_settlement",
        settlements: [],
        attributedSettlementId: null,
        supplierWithheld: [],
        ...overrides
      } as Row;
    }

    type Harness = Deps & { calls: string[]; sent: Array<{ text: string; url: string }>; marked: NoticeDoc[][]; runs: RunDoc[]; notifiedAsked: string[][] };

    function harness(options: {
      rows?: Row[];
      nettedRows?: Row[];
      isIncomplete?: boolean;
      notified?: string[];
      channelUrl?: string | null;
      sendResult?: SendResult;
      markError?: Error;
    }): Harness {
      const calls: string[] = [];
      const sent: Array<{ text: string; url: string }> = [];
      const marked: NoticeDoc[][] = [];
      const runs: RunDoc[] = [];
      const notifiedAsked: string[][] = [];
      return {
        calls,
        sent,
        marked,
        runs,
        notifiedAsked,
        runId: RUN_ID,
        now: NOW,
        channelUrl: options.channelUrl === undefined ? URL : options.channelUrl,
        loadReport: async () => {
          calls.push("loadReport");
          return { rows: options.rows ?? [], nettedRows: options.nettedRows ?? [], settings: SETTINGS, isIncomplete: options.isIncomplete ?? false };
        },
        loadNotifiedOrderIds: async (orderIds) => {
          calls.push("loadNotified");
          notifiedAsked.push([...orderIds]);
          return new Set(options.notified ?? []);
        },
        send: async (text, url) => {
          calls.push("send");
          sent.push({ text, url });
          return options.sendResult ?? { ok: true, httpStatus: 204 };
        },
        markNotified: async (docs) => {
          calls.push("mark");
          if (options.markError) throw options.markError;
          marked.push(docs);
        },
        writeRun: async (doc) => {
          calls.push("run");
          runs.push(doc);
        }
      };
    }

    function undefinedPaths(value: unknown, path = "$"): string[] {
      if (value === undefined) return [path];
      if (value === null || typeof value !== "object") return [];
      if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`));
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`));
    }

    const notice = () => import("../../functions/src/cash-overdue-notice");

    it("envio ok: un solo mensaje con el texto de composeOverdueNotice, a la url del canal", async () => {
      const run = await runner();
      const { composeOverdueNotice, selectNoticeCandidates } = await notice();
      const rows = [row("a"), row("b", { leaderId: "leader-2", leaderName: "Lider Dos", deliveredAt: "2026-09-01T15:00:00.000Z" })];
      const h = harness({ rows, isIncomplete: true });
      await run(h);
      const candidates = selectNoticeCandidates({ rows, settings: SETTINGS }, new Set());
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].url).toBe(URL);
      expect(h.sent[0].text).toBe(composeOverdueNotice(candidates, { isIncomplete: true, now: NOW })?.text);
    });

    it("envio ok: marca con exactamente buildNoticeDocs de las candidatas y DESPUES del envio; el run va al final", async () => {
      const run = await runner();
      const { buildNoticeDocs, selectNoticeCandidates } = await notice();
      const rows = [row("a"), row("b")];
      const h = harness({ rows });
      await run(h);
      const candidates = selectNoticeCandidates({ rows, settings: SETTINGS }, new Set());
      expect(h.marked).toEqual([buildNoticeDocs({ candidates, runId: RUN_ID, now: NOW })]);
      expect(h.calls.filter((call) => call === "send" || call === "mark" || call === "run")).toEqual(["send", "mark", "run"]);
    });

    it("envio ok: el run es `sent`, sale de buildRunDoc, se devuelve y no lleva undefined", async () => {
      const run = await runner();
      const { composeOverdueNotice, selectNoticeCandidates } = await notice();
      const rows = [row("a"), row("b", { leaderId: "leader-2", outstandingCop: 40_000 })];
      const h = harness({ rows });
      const result = await run(h);
      const candidates = selectNoticeCandidates({ rows, settings: SETTINGS }, new Set());
      const composed = composeOverdueNotice(candidates, { isIncomplete: false, now: NOW });
      expect(h.runs).toHaveLength(1);
      expect(result).toEqual(h.runs[0]);
      expect(h.runs[0]).toMatchObject({
        id: RUN_ID,
        createdAt: NOW,
        status: "sent",
        channelConfigured: true,
        isIncomplete: false,
        orderIds: candidates.map((item) => item.orderId),
        orderCount: 2,
        leaderCount: composed?.groups.length,
        totalCop: composed?.totalCop,
        truncated: false
      });
      expect(undefinedPaths(h.runs[0])).toEqual([]);
    });

    it("texto recortado: marca TODAS las candidatas, no solo las que caben en el mensaje (primera corrida con todo el atraso)", async () => {
      const run = await runner();
      const rows = Array.from({ length: 200 }, (_, index) =>
        row(`o${String(index).padStart(3, "0")}`, { ageDays: 8 + index, leaderId: `leader-${index % 7}`, deliveredAt: `2026-0${1 + (index % 8)}-1${index % 10}T15:00:00.000Z` })
      );
      const h = harness({ rows });
      const result = await run(h);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].text.length).toBeLessThanOrEqual(2_000);
      expect(result.truncated).toBe(true);
      expect(h.marked).toHaveLength(1);
      expect(h.marked[0].map((doc) => doc.id).sort()).toEqual(rows.map((item) => item.orderId).sort());
      expect(result.orderIds).toHaveLength(200);
    });

    it("excluye los ya avisados en cashOverdueNotices: ni se envian ni se vuelven a marcar", async () => {
      const run = await runner();
      const h = harness({ rows: [row("a"), row("ya-avisado")], notified: ["ya-avisado"] });
      const result = await run(h);
      expect(h.marked.flat().map((doc) => doc.id)).toEqual(["a"]);
      expect(result.orderIds).toEqual(["a"]);
      expect(h.sent[0].text).not.toContain("KNT-ya-avisado");
    });

    it("todos ya avisados -> nothing_to_send, sin envio ni marca", async () => {
      const run = await runner();
      const h = harness({ rows: [row("a")], notified: ["a"] });
      const result = await run(h);
      expect(h.sent).toEqual([]);
      expect(h.marked).toEqual([]);
      expect(result.status).toBe("nothing_to_send");
      expect(h.runs.map((doc) => doc.status)).toEqual(["nothing_to_send"]);
    });

    it("RF_09: los cubiertos por compensacion (nettedRows) nunca se envian ni se marcan, aunque esten vencidos y sobre el umbral", async () => {
      const run = await runner();
      const netted = row("compensado", { location: "covered_by_netting", ageDays: 90, outstandingCop: 500_000 });
      const h = harness({ rows: [row("a")], nettedRows: [netted] });
      const result = await run(h);
      expect(h.sent[0].text).not.toContain("KNT-compensado");
      expect(h.marked.flat().map((doc) => doc.id)).toEqual(["a"]);
      expect(result.orderIds).toEqual(["a"]);
    });

    it("solo nettedRows y nada en rows -> nothing_to_send", async () => {
      const run = await runner();
      const h = harness({ rows: [], nettedRows: [row("compensado", { location: "covered_by_netting" })] });
      const result = await run(h);
      expect(h.sent).toEqual([]);
      expect(result.status).toBe("nothing_to_send");
    });

    it("bajo el umbral o no vencido no es candidato", async () => {
      const run = await runner();
      const h = harness({ rows: [row("debajo", { outstandingCop: 19_999 }), row("reciente", { isOverdue: false, ageDays: 3 }), row("justo", { outstandingCop: 20_000 })] });
      const result = await run(h);
      expect(result.orderIds).toEqual(["justo"]);
    });

    it.each([
      ["sin secreto", undefined as unknown as null],
      ["vacio", ""],
      ["espacios", "   "],
      ["none", "none"],
      ["null", null]
    ])("sin canal (%s) -> skipped_no_channel: no envia y NO marca, pero deja el run con lo que se habria avisado", async (_label, channelUrl) => {
      const run = await runner();
      const h = harness({ rows: [row("a"), row("b")], channelUrl: channelUrl ?? null });
      const result = await run(h);
      expect(h.sent).toEqual([]);
      expect(h.marked).toEqual([]);
      expect(h.calls).not.toContain("mark");
      expect(result.status).toBe("skipped_no_channel");
      expect(result.channelConfigured).toBe(false);
      expect([...result.orderIds].sort()).toEqual(["a", "b"]);
      expect(h.runs).toHaveLength(1);
    });

    it("envio fallido por http -> send_failed con httpStatus, sin marcar", async () => {
      const run = await runner();
      const h = harness({ rows: [row("a")], sendResult: { ok: false, reason: "http_error", httpStatus: 500 } });
      const result = await run(h);
      expect(h.calls).not.toContain("mark");
      expect(result.status).toBe("send_failed");
      expect(result.httpStatus).toBe(500);
      expect(h.runs.map((doc) => doc.status)).toEqual(["send_failed"]);
    });

    it.each([
      ["network_error", { ok: false, reason: "network_error", error: "fetch failed" } as SendResult],
      ["timeout", { ok: false, reason: "timeout", error: "sin respuesta en 10000 ms" } as SendResult]
    ])("envio fallido por %s -> send_failed con el motivo en error, sin marcar", async (reason, sendResult) => {
      const run = await runner();
      const h = harness({ rows: [row("a")], sendResult });
      const result = await run(h);
      expect(h.calls).not.toContain("mark");
      expect(result.status).toBe("send_failed");
      expect(result.error).toContain(reason);
      expect(undefinedPaths(result)).toEqual([]);
    });

    it("al menos una vez: si el marcado falla, run mark_failed con el error y la promesa resuelve (se repetira)", async () => {
      const run = await runner();
      const h = harness({ rows: [row("a")], markError: new Error("DEADLINE_EXCEEDED al escribir marcas") });
      const result = await run(h);
      expect(h.sent).toHaveLength(1);
      expect(result.status).toBe("mark_failed");
      expect(result.error).toContain("DEADLINE_EXCEEDED");
      expect(result.orderIds).toEqual(["a"]);
      expect(h.runs.map((doc) => doc.status)).toEqual(["mark_failed"]);
    });

    it("ningun run contiene la url del canal (lleva el token en la ruta)", async () => {
      const run = await runner();
      const outcomes: SendResult[] = [
        { ok: true, httpStatus: 200 },
        { ok: false, reason: "http_error", httpStatus: 403 },
        { ok: false, reason: "network_error", error: "fetch failed" },
        { ok: false, reason: "timeout", error: "timeout" }
      ];
      for (const sendResult of outcomes) {
        const h = harness({ rows: [row("a")], sendResult });
        await run(h);
        expect(JSON.stringify(h.runs)).not.toContain("SECRET-TOKEN-123");
        expect(JSON.stringify(h.runs)).not.toContain("hooks.example.test");
      }
    });
  });

  describe("guardas de fuente", () => {
    const api = () => (existsSync(absolute(API)) ? sourceWithoutComments(API) : "");

    function functionBody(source: string, name: string): string {
      const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
      if (start < 0) return "";
      const end = source.indexOf("\n}\n", start);
      return end < 0 ? source.slice(start) : source.slice(start, end + 2);
    }

    /** `export const <name> = <factory>(` hasta el primer `\n});\n` o `\n);\n`. */
    function exportedCall(source: string, name: string, factory: string): string {
      const start = source.search(new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*${factory}\\(`, "m"));
      if (start < 0) return "";
      const rest = source.slice(start);
      const ends = [rest.indexOf("\n});\n"), rest.indexOf("\n);\n")].filter((index) => index >= 0);
      return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends) + 4);
    }

    const callable = () => exportedCall(api(), "updateCashAlertSettings", "onCall");
    const scheduled = () => exportedCall(api(), "notifyOverdueCash", "onSchedule");
    const importsFrom = (name: string, from: string) =>
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${from.replace(/[./]/g, "\\$&")}["']`);

    it("index.ts exporta updateCashAlertSettings y notifyOverdueCash desde ./cash-outstanding-api", () => {
      const index = sourceWithoutComments(INDEX);
      expect(index).toMatch(/export\s*\{[^}]*\bupdateCashAlertSettings\b[^}]*\}\s*from\s*["']\.\/cash-outstanding-api["']/);
      expect(index).toMatch(/export\s*\{[^}]*\bnotifyOverdueCash\b[^}]*\}\s*from\s*["']\.\/cash-outstanding-api["']/);
    });

    it("updateCashAlertSettings es un onCall v2 exportado", () => {
      expect(callable()).not.toBe("");
    });

    it("el permiso y la validacion salen de resolveCashAlertSettingsUpdate(request.auth, request.data), que usa cashAlertSettingsSchema", () => {
      expect(callable()).toMatch(/resolveCashAlertSettingsUpdate\(\s*request\.auth\s*,\s*request\.data\s*\)/);
      expect(callable()).toMatch(/new\s+HttpsError\(/);
      expect(callable()).not.toMatch(/cashAlertSettingsSchema|request\.data\??\.(overdueDays|notifyMinCop)/);
      expect(api()).toMatch(importsFrom("cashAlertSettingsSchema", "./cash-outstanding-schemas"));
      expect(functionBody(api(), "resolveCashAlertSettingsUpdate")).toMatch(/cashAlertSettingsSchema/);
      expect(functionBody(api(), "resolveCashAlertSettingsUpdate")).toMatch(/["']admin["']/);
    });

    it("escribe settings/cashAlerts con buildCashAlertSettingsDoc y la auditoria en auditEvents con buildCashAlertAuditDoc", () => {
      const body = callable();
      expect(api()).toMatch(importsFrom("buildCashAlertSettingsDoc", "./cash-outstanding-schemas"));
      expect(api()).toMatch(importsFrom("buildCashAlertAuditDoc", "./cash-outstanding-schemas"));
      expect(body).toMatch(/collection\(\s*["']settings["']\s*\)\s*\.doc\(\s*["']cashAlerts["']\s*\)|doc\(\s*["']settings\/cashAlerts["']\s*\)/);
      expect(body).toMatch(/collection\(\s*["']auditEvents["']\s*\)/);
      expect(body).toMatch(/buildCashAlertSettingsDoc\(/);
      expect(body).toMatch(/buildCashAlertAuditDoc\(/);
      expect(api()).not.toMatch(/auditLogs/);
    });

    it("ajuste y auditoria se escriben juntos (batch o transaccion), con el valor previo leido por readCashAlertSettings", () => {
      const body = callable();
      expect(body).toMatch(/\.batch\(\)|runTransaction\(/);
      expect(body).toMatch(/readCashAlertSettings\(/);
    });

    it("el callable devuelve los ajustes guardados ({ settings })", () => {
      expect(callable()).toMatch(/return\s*\{\s*settings\b/);
    });

    it("notifyOverdueCash es un onSchedule v2 diario a las 08:00 en America/Bogota", () => {
      expect(api()).toMatch(importsFrom("onSchedule", "firebase-functions/v2/scheduler"));
      const body = scheduled();
      expect(body).not.toBe("");
      expect(body).toMatch(/schedule\s*:\s*["'](every day 08:00|0 8 \* \* \*)["']/);
      expect(body).toMatch(/timeZone\s*:\s*["']America\/Bogota["']/);
    });

    it("notifyOverdueCash declara el secreto del canal en secrets", () => {
      const secretVar = api().match(/const\s+(\w+)\s*=\s*defineSecret\(\s*["']OPS_NOTICE_WEBHOOK_URL["']\s*\)/)?.[1] ?? "";
      expect(secretVar).not.toBe("");
      expect(scheduled()).toMatch(new RegExp(`secrets\\s*:\\s*\\[[^\\]]*\\b${secretVar}\\b`));
    });

    it("la programada delega en runOverdueNotice y envia con sendOpsNotice", () => {
      expect(scheduled()).toMatch(/runOverdueNotice\(/);
      expect(api()).toMatch(importsFrom("sendOpsNotice", "./ops-notify"));
      expect(scheduled()).toMatch(/sendOpsNotice\(/);
    });

    it("modo resumen, sin conciliacion: alcance admin con includeReconciliation false y cobertura targeted", () => {
      const body = scheduled();
      expect(body).toMatch(/loadCashOutstandingInput\(/);
      expect(body).toMatch(/buildCashOutstandingReport\(/);
      expect(body).toMatch(/kind\s*:\s*["']admin["']/);
      expect(body).toMatch(/includeReconciliation\s*:\s*false/);
      expect(body).toMatch(/coverage\s*:\s*["']targeted["']/);
      expect(body).not.toMatch(/includeReconciliation\s*:\s*true|["']full["']|with_reconciliation/);
    });

    it("las marcas viven en cashOverdueNotices y las corridas en cashOverdueRuns", () => {
      expect(scheduled()).toMatch(/collection\(\s*["']cashOverdueNotices["']\s*\)/);
      expect(scheduled()).toMatch(/collection\(\s*["']cashOverdueRuns["']\s*\)/);
    });

    it("candidatas solo de rows: el api no lee nettedRows y usa selectNoticeCandidates/composeOverdueNotice/buildNoticeDocs/buildRunDoc", () => {
      const source = api();
      expect(source).not.toBe("");
      expect(source).not.toMatch(/\bnettedRows\b/);
      for (const name of ["selectNoticeCandidates", "composeOverdueNotice", "buildNoticeDocs", "buildRunDoc"]) {
        expect(source).toMatch(importsFrom(name, "./cash-overdue-notice"));
        expect(functionBody(source, "runOverdueNotice")).toMatch(new RegExp(`\\b${name}\\(`));
      }
    });

    it("marca tras .ok: en runOverdueNotice el primer markNotified( va despues de comprobar .ok", () => {
      const body = functionBody(api(), "runOverdueNotice");
      const okAt = body.search(/\.ok\b/);
      const markAt = body.search(/\bmarkNotified\(/);
      expect(okAt).toBeGreaterThanOrEqual(0);
      expect(markAt).toBeGreaterThan(okAt);
    });

    it("ninguna escritura de Firestore del api lleva un objeto literal: todo pasa por build*Doc/stripUndefined", () => {
      const source = api();
      expect(source).not.toBe("");
      // `ref.set({...})`, `batch.set(ref, {...})`, `.update({...})`, `.create({...})`, `.add({...})`.
      const literalWrites = source.match(/\.(?:set|update|create|add)\(\s*(?:[\w$.()"'`/-]+\s*,\s*)?\{/g) ?? [];
      expect(literalWrites).toEqual([]);
      expect(`${callable()}\n${scheduled()}\n${functionBody(source, "runOverdueNotice")}`).toMatch(/build\w+Doc\(|stripUndefined\(/);
    });

    it("sin catch vacio ni errores tragados en silencio", () => {
      const source = api();
      expect(scheduled()).not.toBe("");
      expect(callable()).not.toBe("");
      expect(source).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
      expect(source).not.toMatch(/\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/);
    });

    it("la url del secreto en notifyOverdueCash solo va como channelUrl/argumento a runOverdueNotice/sendOpsNotice: nunca a un return ni a un doc", () => {
      const source = api();
      const body = scheduled();
      expect(body).not.toBe("");
      const secretVar = source.match(/const\s+(\w+)\s*=\s*defineSecret\(\s*["']OPS_NOTICE_WEBHOOK_URL["']\s*\)/)?.[1] ?? "";
      expect(secretVar).not.toBe("");
      const valueCall = new RegExp(`\\b${secretVar}\\.value\\(\\)`, "g");
      // Cada `.value()` del secreto, en una de estas formas exactas y en ningun otro sitio.
      const allowed = new RegExp(
        `channelUrl\\s*:\\s*${secretVar}\\.value\\(\\)|sendOpsNotice\\([^;]*?\\b${secretVar}\\.value\\(\\)|runOverdueNotice\\([^;]*?\\b${secretVar}\\.value\\(\\)`,
        "g"
      );
      const total = (body.match(valueCall) ?? []).length;
      const permitted = (body.match(allowed) ?? []).length;
      expect(total).toBeGreaterThan(0);
      expect(permitted).toBe(total);
      expect(body).not.toMatch(new RegExp(`return[^;]*\\b${secretVar}\\.value\\(\\)`));
      expect(body).not.toMatch(new RegExp(`\\.(?:set|update|create|add)\\([^;]*\\b${secretVar}\\.value\\(\\)`));
      expect(body).not.toMatch(new RegExp(`console\\.\\w+\\([^;]*\\b${secretVar}\\.value\\(\\)`));
      // Fuera de las dos funciones exportadas no se lee el secreto.
      const outside = source.replace(body, "").replace(callableBody(source), "");
      expect((outside.match(valueCall) ?? []).length).toBe(0);
    });

    function callableBody(source: string): string {
      return exportedCall(source, "getCashOutstanding", "onCall");
    }

    it("las marcas se leen por id (getAll), no por where: la forma de consultas de T12 no cambia", () => {
      expect(scheduled()).toMatch(/\.getAll\(/);
      expect(scheduled()).not.toMatch(/\.where\(/);
    });
  });
});
