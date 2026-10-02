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

    it("la URL del canal no se devuelve: todo .value() del secreto va dentro de isOpsChannelConfigured(...)", () => {
      const source = api();
      expect(source).toMatch(/import\s*\{[^}]*\bisOpsChannelConfigured\b[^}]*\}\s*from\s*["']\.\/ops-notify["']/);
      const valueCalls = (source.match(/\.value\(\)/g) ?? []).length;
      const wrapped = (source.match(/isOpsChannelConfigured\(\s*[\w$.]+\.value\(\)\s*\)/g) ?? []).length;
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
