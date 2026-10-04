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
  // T10, T12 y T14 ya crearon los tres que faltaban; T17 exige en su bloque que existan los cuatro.
  const PENDING_UNTIL_LATER_TASKS = new Set<string>([]);
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

describe("T15 · interfaz del admin: lista y tarjeta", () => {
  /*
   * T15 (RF_02, RF_03, RF_09, RNF_01; README decisiones 2, 3, 4, 5, 11, 12; pantallas HU_01.*).
   *
   * No hay infraestructura de render de componentes en el repo (sin @testing-library ni jsdom), asi que
   * esto son guardas de fuente. El E2E con los nombres accesibles reales de los screen.json lo hace
   * /sdd-verify.
   *
   * Contrato que fija este bloque:
   *  - `src/components/cash-outstanding-admin.tsx` exporta `CashOutstandingOverdueCard` (tarjeta de
   *    Operacion) y `CashOutstandingTab` (pestana de Liquidaciones).
   *  - Una sola cache por sesion de pagina: `const <x> = createCashOutstandingSummaryCache(...)` a nivel
   *    de modulo, alimentada con `getFirebaseCashOutstanding`; se consulta con `.get({ uid ... })`.
   *  - Solo la pestana pide `includeReconciliation: true` (una aparicion en todo el archivo) y deja el
   *    resultado como compartido con `.prime(uid, ...)`. La tarjeta no menciona `includeReconciliation`.
   *  - El filtro "Lider" es un `<select aria-label="Lider">` cuyo `onChange` solo cambia estado.
   *  - `operations-app.tsx` importa los dos componentes, monta la tarjeta en `AdminView` y la pestana en
   *    `LiquidationsPage`, con "Efectivo sin llegar" como segunda pestana tras "Por pagar".
   *  - "Plazo y aviso" es de T16 y no se exige aqui.
   */
  const ADMIN = "src/components/cash-outstanding-admin.tsx";
  const VIEW = "src/lib/cash-outstanding-view.ts";
  const APP = "src/components/operations-app.tsx";
  // Medido el 2026-10-02 al escribir esta guarda (import + lineas 7509 y 8027): `grep -c` = 3.
  const FROZEN_COD_RECEIVED_COUNT = 3;

  const admin = () => (existsSync(absolute(ADMIN)) ? sourceWithoutComments(ADMIN) : "");
  const app = () => sourceWithoutComments(APP);
  /** Lo que se pinta sale del componente y del modelo de vista (titulos y rotulos viven en este). */
  const painted = () => `${admin()}\n${sourceWithoutComments(VIEW)}`;

  /** Cuerpo de una funcion de nivel superior: hasta la siguiente declaracion de nivel superior. */
  function topLevelBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\n(?:export\s+)?(?:type|interface)\s/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  /** Contenido entre llaves equilibradas que empieza en `source[open] === "{"`. */
  function balancedBraces(source: string, open: number): string {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, index);
      }
    }
    return source.slice(open + 1);
  }

  function count(source: string, token: string): number {
    return source.split(token).length - 1;
  }

  describe("el componente", () => {
    it("existe", () => {
      expect(existsSync(absolute(ADMIN))).toBe(true);
    });

    it.each(["CashOutstandingOverdueCard", "CashOutstandingTab"])("exporta %s", (name) => {
      expect(admin()).toMatch(new RegExp(`export\\s+(?:function\\s+${name}\\b|const\\s+${name}\\b)`));
    });

    it("pinta desde buildCashOutstandingView (importado del modelo de vista)", () => {
      expect(admin()).toMatch(/import\s*\{[^}]*\bbuildCashOutstandingView\b[^}]*\}\s*from\s*["'][^"']*cash-outstanding-view["']/);
      expect(admin()).toMatch(/\bbuildCashOutstandingView\s*\(/);
    });

    it("crea UNA cache a nivel de modulo con createCashOutstandingSummaryCache y getFirebaseCashOutstanding", () => {
      expect(admin()).toMatch(/import\s*\{[^}]*\bcreateCashOutstandingSummaryCache\b[^}]*\}\s*from\s*["'][^"']*cash-outstanding-loads["']/);
      expect(admin()).toMatch(/import\s*\{[^}]*\bgetFirebaseCashOutstanding\b[^}]*\}\s*from\s*["'][^"']*firebase\/auth["']/);
      expect(admin()).toMatch(/^(?:export\s+)?const\s+\w+\s*=\s*createCashOutstandingSummaryCache\(/m);
      expect(count(admin(), "createCashOutstandingSummaryCache(")).toBe(1);
      const factoryArgs = admin().match(/createCashOutstandingSummaryCache\(([\s\S]*?)\);/)?.[1] ?? "";
      expect(factoryArgs).toMatch(/\bgetFirebaseCashOutstanding\b/);
    });

    it("lee la carga compartida con .get({ uid ... }) de la sesion", () => {
      expect(admin()).toMatch(/\.get\(\s*\{[^}]*\buid\b/);
    });
  });

  describe("dos cargas: la tarjeta resume, solo la pestana concilia (decision 11)", () => {
    it("includeReconciliation: true aparece una sola vez en el archivo", () => {
      expect(count(admin().replace(/\s+/g, " "), "includeReconciliation: true")).toBe(1);
    });

    it("la pestana pide con conciliacion y hace prime con el uid", () => {
      const tab = topLevelBody(admin(), "CashOutstandingTab");
      expect(tab).not.toBe("");
      expect(tab.replace(/\s+/g, " ")).toMatch(/getFirebaseCashOutstanding\(\s*\{\s*includeReconciliation:\s*true\s*\}\s*\)/);
      expect(tab).toMatch(/\.prime\(\s*[\w.]*uid\b/i);
    });

    it("la tarjeta no pide conciliacion ni llama al callable directamente", () => {
      const card = topLevelBody(admin(), "CashOutstandingOverdueCard");
      expect(card).not.toBe("");
      expect(card).not.toMatch(/includeReconciliation/);
      expect(card).not.toMatch(/\bgetFirebaseCashOutstanding\s*\(/);
    });

    it("el filtro Lider es un select con aria-label y su onChange solo cambia estado (no llama)", () => {
      const source = admin();
      const label = source.search(/aria-label=(?:"Lider"|\{\s*["']Lider["']\s*\})/);
      expect(label, "falta <select aria-label=\"Lider\">").toBeGreaterThanOrEqual(0);
      const selectStart = source.lastIndexOf("<select", label);
      const selectEnd = source.indexOf("</select>", label);
      expect(selectStart).toBeGreaterThanOrEqual(0);
      const select = source.slice(selectStart, selectEnd < 0 ? undefined : selectEnd);
      const onChangeAt = select.indexOf("onChange={");
      expect(onChangeAt, "el select Lider no tiene onChange").toBeGreaterThanOrEqual(0);
      const handler = balancedBraces(select, onChangeAt + "onChange=".length);
      expect(handler).toMatch(/\bset[A-Z]\w*\(/);
      expect(handler).not.toMatch(/getFirebaseCashOutstanding|\.get\(|\.prime\(|fetch|load|refresh|reload|includeReconciliation/i);
    });
  });

  describe("RNF_01 · no recalcula ni baja historico", () => {
    const FORBIDDEN = [
      /\bbuildCodReceivedSet\b/,
      /\bisSellerEntryEligible\b/,
      /\bcomputeDriverCashSummary\b/,
      /\bbuildWalletEntries\b/,
      /\bwalletEntries\b/,
      /\bstate\.settlements\b/,
      /\bstate\.orders\b/,
      /["']firebase\/firestore["']/,
      /\bcollection\(/,
      /\bonSnapshot\(/,
      /\bgetDocs\(/,
    ];

    it.each([ADMIN, VIEW])("%s no usa la materia prima del calculo ni lee Firestore", (file) => {
      expect(existsSync(absolute(file)), `${file} no existe`).toBe(true);
      const source = sourceWithoutComments(file);
      const hits = FORBIDDEN.filter((pattern) => pattern.test(source)).map(String);
      expect(hits).toEqual([]);
    });

    it(`operations-app.tsx: buildCodReceivedSet sigue con ${FROZEN_COD_RECEIVED_COUNT} apariciones (congelado)`, () => {
      const raw = readFileSync(absolute(APP), "utf8");
      expect(raw.match(/\bbuildCodReceivedSet\b/g)?.length ?? 0).toBe(FROZEN_COD_RECEIVED_COUNT);
    });
  });

  describe("montaje en operations-app.tsx", () => {
    it("importa los dos componentes de ./cash-outstanding-admin", () => {
      const imports = [...app().matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/cash-outstanding-admin["']/g)].map((m) => m[1]).join(",");
      expect(imports).toMatch(/\bCashOutstandingOverdueCard\b/);
      expect(imports).toMatch(/\bCashOutstandingTab\b/);
    });

    it("la tarjeta se monta en AdminView (Operacion)", () => {
      expect(topLevelBody(app(), "AdminView")).toMatch(/<CashOutstandingOverdueCard\b/);
    });

    it("la pestana se monta en LiquidationsPage", () => {
      expect(topLevelBody(app(), "LiquidationsPage")).toMatch(/<CashOutstandingTab\b/);
    });

    it("\"Efectivo sin llegar\" es la segunda pestana de Liquidaciones, tras \"Por pagar\"", () => {
      const tabs = app().match(/const\s+LIQUIDATION_TABS\s*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
      const labels = [...tabs.matchAll(/label:\s*["']([^"']+)["']/g)].map((m) => m[1]);
      expect(labels.slice(0, 2)).toEqual(["Por pagar", "Efectivo sin llegar"]);
    });

    it("operations-app no llama al callable por su cuenta (lo hace el componente)", () => {
      expect(app()).not.toMatch(/\bgetFirebaseCashOutstanding\b/);
      expect(app()).not.toMatch(/\bcreateCashOutstandingSummaryCache\b/);
    });
  });

  describe("textos y nombres accesibles del diseno", () => {
    it.each([
      "Efectivo vencido",
      "Ver efectivo sin llegar",
      "Efectivo sin llegar",
      "Actualizar",
      "Reintentar",
      "Todo el efectivo llego",
      "No se pudo calcular el efectivo sin llegar",
      "Calculando el efectivo sin llegar",
      "Cuadre con la posicion de la plataforma",
      "Ver documentos ilegibles",
      "calculado hoy",
    ])("el componente contiene \"%s\"", (text) => {
      expect(admin()).toContain(text);
    });

    it("la tarjeta nombra \"el lider con mas efectivo vencido\" (decision 2)", () => {
      expect(admin()).toMatch(/el lider con mas efectivo vencido/i);
    });

    it.each(["Cubiertos por compensacion", "Cubierto por compensacion", "Cifras incompletas"])(
      "lo pintado (componente + modelo de vista) contiene \"%s\"",
      (text) => {
        expect(painted()).toContain(text);
      }
    );

    it.each([
      "Efectivo vencido",
      "Resumen del efectivo sin llegar",
      "Producto retenido a proveedores",
      "Documentos ilegibles",
      "Efectivo sin llegar por lider",
      "Pedidos cubiertos por compensacion",
      "Lider",
    ])("aria-label=\"%s\" (region, lista, tabla o combobox del screen.json)", (name) => {
      expect(admin()).toMatch(new RegExp(`aria-label=(?:"${name}"|\\{\\s*["']${name}["']\\s*\\})`));
    });

    it.each(["Guia", "Tienda", "Mensajero", "Entregado", "Dias", "Efectivo", "Recaudo", "Lider"])(
      "cabecera de columna <th> \"%s\"",
      (header) => {
        expect(admin()).toMatch(new RegExp(`<th\\b[^>]*>\\s*${header}\\s*</th>`));
      }
    );

    it("tiene role=\"status\" (cargando) y role=\"alert\" (error)", () => {
      expect(admin()).toMatch(/role=["']status["']/);
      expect(admin()).toMatch(/role=["']alert["']/);
    });

    it("las divulgaciones con cifras variables las llevan en aria-describedby (decisiones 3 y 12)", () => {
      expect(admin()).toMatch(/aria-describedby=/);
      expect(admin()).toMatch(/aria-expanded=/);
    });

    it("usa h3 para los grupos de lider y la seccion de compensados", () => {
      expect(admin()).toMatch(/<h3\b/);
    });
  });

  describe("sistema de diseno (docs/design-system.md)", () => {
    it("sin colores literales (hex, rgb, hsl ni clases arbitrarias de color)", () => {
      expect(existsSync(absolute(ADMIN)), `${ADMIN} no existe`).toBe(true);
      const source = admin();
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
      expect(source).not.toMatch(/\[(?:#|rgb|hsl)/);
    });

    it("todo <button> y <select> tiene objetivo tactil >= 44px (focus-ring o min-h-11)", () => {
      const source = admin();
      const controls = [...source.matchAll(/<(button|select)\b/g)];
      expect(controls.length).toBeGreaterThan(0);
      const short = controls
        .map((match) => {
          const start = match.index ?? 0;
          const close = source.indexOf(match[1] === "button" ? "</button>" : "</select>", start);
          const tag = source.slice(start, close < 0 ? start + 800 : Math.min(close, start + 800));
          return { line: source.slice(0, start).split("\n").length, tag };
        })
        .filter(({ tag }) => !/\bfocus-ring\b|\bmin-h-11\b|\bmin-h-\[44px\]|\bh-11\b|\bmin-h-12\b|\bmin-h-14\b/.test(tag))
        .map(({ line }) => `linea ${line}`);
      expect(short).toEqual([]);
    });
  });
});

describe("T16 · interfaz del admin: plazo y proveedor", () => {
  /*
   * T16 (RF_04, RF_08, RNF_01; README decisiones 8, 9 y 11; pantalla HU_01.plazo; spec seccion 9).
   *
   * Guardas de fuente (sin render de componentes en el repo). El E2E con HU_01.plazo es de /sdd-verify.
   * La recarga tras guardar se prueba de verdad en `cash-outstanding-loads.test.ts` (bloque T16).
   *
   * Contrato que fija este bloque:
   *  - `src/lib/cash-outstanding-loads.ts` exporta `reloadAfterCashAlertSave` y sigue sin Firestore ni
   *    materia prima del calculo (RNF_01).
   *  - `src/components/cash-outstanding-admin.tsx` exporta:
   *      `CashAlertSettingsDialog`: dialogo "Plazo y aviso" (role="dialog", aria-modal, aria-labelledby;
   *        Escape cierra; hoja inferior en movil y modal en escritorio). Campos numericos "Plazo en dias"
   *        (min 1, max 120) y "Avisar desde, en pesos" (min 0), enteros (`Number.isInteger`), con
   *        `aria-invalid`. Guarda con `updateFirebaseCashAlertSettings({ overdueDays, notifyMinCop })` y
   *        DESPUES `reloadAfterCashAlertSave({ isTabOpen ... }, { fetchReport: getFirebaseCashOutstanding,
   *        cache: <la cache del modulo>, uid })`. Anuncia "Guardado"; un error se pinta (role="alert").
   *        Muestra el canal: `channelConfigured` -> "Canal de aviso configurado" / "Sin canal: el aviso
   *        solo se ve en la app". Conserva "una vez por pedido" (spec seccion 9). No escribe `settings`.
   *      `CashOutstandingSupplierPendingLine({ uid, supplierId })`: lee la carga resumen compartida con
   *        `.get({ uid })` (sin refresh ni conciliacion) y pinta `supplierPendingLine(report, supplierId)`.
   *  - `CashOutstandingTab` tiene el boton "Plazo y aviso" y monta `<CashAlertSettingsDialog`.
   *  - `operations-app.tsx` importa `CashOutstandingSupplierPendingLine` de `./cash-outstanding-admin` y lo
   *    monta SOLO en `SupplierLiquidationTable` (Por pagar) con `supplierId={row.supplierId}`; no monta el
   *    dialogo; `buildCodReceivedSet` sigue con 3 apariciones.
   */
  const ADMIN = "src/components/cash-outstanding-admin.tsx";
  const LOADS = "src/lib/cash-outstanding-loads.ts";
  const APP = "src/components/operations-app.tsx";
  // Mismo valor que congelo T15 (medido el 2026-10-02): la linea de proveedor no recalcula nada.
  const FROZEN_COD_RECEIVED_COUNT = 3;

  const admin = () => (existsSync(absolute(ADMIN)) ? sourceWithoutComments(ADMIN) : "");
  const app = () => sourceWithoutComments(APP);
  const flat = (text: string) => text.replace(/\s+/g, " ");

  /** Cuerpo de una funcion de nivel superior: hasta la siguiente declaracion de nivel superior. */
  function topLevelBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\n(?:export\s+)?(?:type|interface)\s/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  function count(source: string, token: string): number {
    return source.split(token).length - 1;
  }

  const dialog = () => topLevelBody(admin(), "CashAlertSettingsDialog");
  const supplierLine = () => topLevelBody(admin(), "CashOutstandingSupplierPendingLine");
  const moduleCacheName = () => admin().match(/^(?:export\s+)?const\s+(\w+)\s*=\s*createCashOutstandingSummaryCache\(/m)?.[1] ?? "<sin cache>";

  describe("recarga tras guardar (cash-outstanding-loads.ts)", () => {
    it("exporta reloadAfterCashAlertSave como funcion", () => {
      expect(sourceWithoutComments(LOADS)).toMatch(/export\s+(?:async\s+)?function\s+reloadAfterCashAlertSave\s*\(/);
    });

    it("RNF_01: cash-outstanding-loads.ts no lee Firestore ni usa la materia prima del calculo", () => {
      const FORBIDDEN = [
        /\bbuildCodReceivedSet\b/,
        /\bisSellerEntryEligible\b/,
        /\bcomputeDriverCashSummary\b/,
        /\bbuildWalletEntries\b/,
        /\bwalletEntries\b/,
        /\bstate\.settlements\b/,
        /\bstate\.orders\b/,
        /["']firebase\//,
        /\bcollection\(/,
        /\bonSnapshot\(/,
        /\bgetDocs\(/,
      ];
      const source = sourceWithoutComments(LOADS);
      expect(FORBIDDEN.filter((pattern) => pattern.test(source)).map(String)).toEqual([]);
    });
  });

  describe("dialogo \"Plazo y aviso\" (HU_01.plazo, decision 9)", () => {
    it("exporta CashAlertSettingsDialog", () => {
      expect(admin()).toMatch(/export\s+function\s+CashAlertSettingsDialog\s*\(/);
    });

    it("es un dialogo modal con nombre: role=\"dialog\", aria-modal y aria-labelledby", () => {
      const body = dialog();
      expect(body).toMatch(/role=["']dialog["']/);
      expect(body).toMatch(/aria-modal=(?:["']true["']|\{\s*true\s*\})/);
      expect(body).toMatch(/aria-labelledby=/);
    });

    it("Escape cierra", () => {
      expect(dialog()).toMatch(/["']Escape["']/);
    });

    it("hoja inferior en movil y modal centrado en escritorio", () => {
      const body = dialog();
      expect(body).toMatch(/\bitems-end\b/);
      expect(body).toMatch(/\b(?:sm|md):items-center\b/);
    });

    it.each(["Plazo y aviso", "Plazo en dias", "Avisar desde, en pesos", "Cancelar", "Guardar", "Guardado"])(
      "contiene \"%s\"",
      (text) => {
        expect(dialog()).toContain(text);
      }
    );

    it("boton Cerrar con nombre accesible", () => {
      expect(dialog()).toMatch(/aria-label=(?:"Cerrar"|\{\s*["']Cerrar["']\s*\})/);
    });

    it("conserva el texto visible \"una vez por pedido\" (spec seccion 9; plan 2.4)", () => {
      expect(dialog()).toMatch(/una vez por pedido/);
    });

    it("muestra si hay canal: lee channelConfigured y pinta los dos textos", () => {
      const body = dialog();
      expect(body).toMatch(/\bchannelConfigured\b/);
      expect(body).toContain("Canal de aviso configurado");
      expect(body).toContain("Sin canal: el aviso solo se ve en la app");
    });

    it("plazo: input numerico entre 1 y 120", () => {
      const body = flat(dialog());
      expect(body).toMatch(/type=["']number["']/);
      expect(body).toMatch(/min=(?:\{\s*1\s*\}|["']1["'])/);
      expect(body).toMatch(/max=(?:\{\s*120\s*\}|["']120["'])/);
    });

    it("umbral: input numerico con minimo 0", () => {
      expect(flat(dialog())).toMatch(/min=(?:\{\s*0\s*\}|["']0["'])/);
    });

    it("valida enteros (Number.isInteger) y marca el campo con aria-invalid", () => {
      const body = dialog();
      expect(body).toMatch(/Number\.isInteger\(/);
      expect(body).toMatch(/aria-invalid=/);
    });

    it("pinta el error (role=\"alert\")", () => {
      expect(dialog()).toMatch(/role=["']alert["']/);
    });

    it("guarda con updateFirebaseCashAlertSettings, importado de firebase/auth, con los DOS campos", () => {
      expect(admin()).toMatch(/import\s*\{[^}]*\bupdateFirebaseCashAlertSettings\b[^}]*\}\s*from\s*["'][^"']*firebase\/auth["']/);
      const body = flat(dialog());
      const call = body.match(/updateFirebaseCashAlertSettings\(\s*\{([^}]*)\}\s*\)/)?.[1] ?? "";
      expect(call, "falta updateFirebaseCashAlertSettings({ ... })").not.toBe("");
      expect(call).toMatch(/\boverdueDays\b/);
      expect(call).toMatch(/\bnotifyMinCop\b/);
    });

    it("tras guardar llama a reloadAfterCashAlertSave (importado de cash-outstanding-loads)", () => {
      expect(admin()).toMatch(/import\s*\{[^}]*\breloadAfterCashAlertSave\b[^}]*\}\s*from\s*["'][^"']*cash-outstanding-loads["']/);
      const body = dialog();
      const save = body.indexOf("updateFirebaseCashAlertSettings(");
      const reload = body.indexOf("reloadAfterCashAlertSave(");
      expect(reload, "el dialogo no llama a reloadAfterCashAlertSave").toBeGreaterThanOrEqual(0);
      expect(reload, "la recarga va despues de guardar").toBeGreaterThan(save);
    });

    it("la recarga recibe isTabOpen, la cache del modulo, getFirebaseCashOutstanding y el uid", () => {
      const body = flat(dialog());
      const at = body.indexOf("reloadAfterCashAlertSave(");
      const args = at < 0 ? "" : body.slice(at, at + 400);
      expect(args).toMatch(/\bisTabOpen\b/);
      expect(args).toMatch(new RegExp(`\\bcache:\\s*${moduleCacheName()}\\b`));
      expect(args).toMatch(/\bfetchReport:\s*getFirebaseCashOutstanding\b/);
      expect(args).toMatch(/\buid\b/);
    });

    it("el dialogo no pide la carga por su cuenta ni toca la cache directamente", () => {
      const body = dialog();
      expect(body).not.toMatch(/\bgetFirebaseCashOutstanding\s*\(/);
      expect(body).not.toMatch(/\.prime\(|\.get\(\s*\{/);
      expect(body).not.toMatch(/includeReconciliation/);
    });

    it("no escribe settings directamente (solo por el callable)", () => {
      const source = admin();
      expect(source).not.toMatch(/\b(?:setDoc|updateDoc|addDoc|writeBatch|runTransaction)\s*\(/);
      expect(source).not.toMatch(/["']settings\/cashAlerts["']|["']cashAlerts["']/);
      expect(source).not.toMatch(/["']firebase\/firestore["']/);
    });

    it("includeReconciliation: true sigue apareciendo una sola vez en el archivo (decision 11)", () => {
      expect(count(flat(admin()), "includeReconciliation: true")).toBe(1);
    });

    it("la pestana tiene el boton \"Plazo y aviso\" y monta el dialogo", () => {
      const tab = topLevelBody(admin(), "CashOutstandingTab");
      expect(tab).toMatch(/<button\b[\s\S]*?Plazo y aviso[\s\S]*?<\/button>/);
      expect(tab).toMatch(/<CashAlertSettingsDialog\b/);
    });

    it("todo <input> del archivo tiene objetivo tactil >= 44px (min-h-11, h-11 o focus-ring)", () => {
      const source = admin();
      const inputs = [...source.matchAll(/<input\b/g)];
      expect(inputs.length, "el dialogo no tiene inputs").toBeGreaterThanOrEqual(2);
      const short = inputs
        .map((match) => {
          const start = match.index ?? 0;
          const close = source.indexOf("/>", start);
          const tag = source.slice(start, close < 0 ? start + 800 : close);
          return { line: source.slice(0, start).split("\n").length, tag };
        })
        .filter(({ tag }) => !/\bfocus-ring\b|\bmin-h-11\b|\bmin-h-\[44px\]|\bh-11\b|\bmin-h-12\b|\bh-12\b/.test(tag))
        .map(({ line }) => `linea ${line}`);
      expect(short).toEqual([]);
    });

    it("sin colores literales en el archivo", () => {
      const source = admin();
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
      expect(source).not.toMatch(/\[(?:#|rgb|hsl)/);
    });
  });

  describe("linea de proveedor en Por pagar (decision 8, carga resumen compartida)", () => {
    it("exporta CashOutstandingSupplierPendingLine", () => {
      expect(admin()).toMatch(/export\s+function\s+CashOutstandingSupplierPendingLine\s*\(/);
    });

    it("usa supplierPendingLine del modelo de vista", () => {
      expect(admin()).toMatch(/import\s*\{[^}]*\bsupplierPendingLine\b[^}]*\}\s*from\s*["'][^"']*cash-outstanding-view["']/);
      expect(supplierLine()).toMatch(/\bsupplierPendingLine\(/);
    });

    it("lee la carga compartida del modulo con .get({ uid }) sin refresh", () => {
      const body = flat(supplierLine());
      expect(body).toMatch(new RegExp(`\\b${moduleCacheName()}\\.get\\(\\s*\\{[^}]*\\buid\\b`));
      expect(body).not.toMatch(/\brefresh\b/);
    });

    it("no es una carga nueva: ni conciliacion, ni callable, ni prime", () => {
      const body = supplierLine();
      expect(body).not.toBe("");
      expect(body).not.toMatch(/includeReconciliation/);
      expect(body).not.toMatch(/\bgetFirebaseCashOutstanding\b/);
      expect(body).not.toMatch(/\.prime\(/);
      expect(body).not.toMatch(/\breloadAfterCashAlertSave\b/);
    });
  });

  describe("montaje en operations-app.tsx", () => {
    it("importa CashOutstandingSupplierPendingLine de ./cash-outstanding-admin", () => {
      const imports = [...app().matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/cash-outstanding-admin["']/g)].map((m) => m[1]).join(",");
      expect(imports).toMatch(/\bCashOutstandingSupplierPendingLine\b/);
    });

    it("la linea se monta en la tarjeta de proveedor de Por pagar con supplierId={row.supplierId}", () => {
      const table = flat(topLevelBody(app(), "SupplierLiquidationTable"));
      expect(table).toMatch(/<CashOutstandingSupplierPendingLine\b[^>]*\bsupplierId=\{\s*row\.supplierId\s*\}/);
      expect(table).toMatch(/<CashOutstandingSupplierPendingLine\b[^>]*\buid=\{/);
    });

    it("solo se monta ahi (una aparicion en operations-app)", () => {
      expect(count(app(), "<CashOutstandingSupplierPendingLine")).toBe(1);
    });

    it("operations-app no monta el dialogo ni recalcula la linea por su cuenta", () => {
      const source = app();
      expect(source).not.toMatch(/<CashAlertSettingsDialog\b/);
      expect(source).not.toMatch(/\bsupplierPendingLine\b/);
      expect(source).not.toMatch(/\breloadAfterCashAlertSave\b/);
      expect(source).not.toMatch(/\bupdateFirebaseCashAlertSettings\b/);
      expect(source).not.toMatch(/\bgetFirebaseCashOutstanding\b/);
    });

    it(`buildCodReceivedSet sigue con ${FROZEN_COD_RECEIVED_COUNT} apariciones (congelado)`, () => {
      const raw = readFileSync(absolute(APP), "utf8");
      expect(raw.match(/\bbuildCodReceivedSet\b/g)?.length ?? 0).toBe(FROZEN_COD_RECEIVED_COUNT);
    });
  });
});

describe("T17 · interfaz del lider", () => {
  /*
   * T17 (RF_06, RF_09, RF_01, RNF_01; README decisiones 10, 11 y 12; pantallas HU_02.finanzas,
   * HU_02.al-dia, HU_02.error).
   *
   * Guardas de fuente (no hay render de componentes en el repo); el E2E de HU_02 es de /sdd-verify.
   *
   * Contrato que fija este bloque:
   *  - `src/components/cash-outstanding-leader.tsx` exporta `CashOutstandingLeaderPanel` (sin props
   *    obligatorias: el callable resuelve al lider por `token.driverId`).
   *  - Pinta desde `buildCashOutstandingView(..., { role: "leader", ... })`; la cifra es `outstandingCop`
   *    (neta del pago), no el recaudo.
   *  - Pide con `getFirebaseCashOutstanding()` SIN argumentos (nunca conciliacion), desde un `useEffect` al
   *    montarse y desde "Actualizar" / "Reintentar". Nada a nivel de modulo: no hay cache compartida ni
   *    carga al arrancar la app; el panel solo existe dentro de Finanzas.
   *  - Region y h2 "Efectivo sin llegar a Kentro"; botones de 56px (`min-h-14`/`h-14`) por densidad de calle.
   *  - `operations-app.tsx` lo monta SOLO en `DriverView`, dentro de `view === "finance"`, antes de
   *    `DriverFinancialSummaryPanel`; "Pendiente por entregar" de Operacion se conserva (P6: complementa).
   */
  const LEADER = "src/components/cash-outstanding-leader.tsx";
  const VIEW = "src/lib/cash-outstanding-view.ts";
  const APP = "src/components/operations-app.tsx";
  // Medido el 2026-10-02 (mismo valor que fijaron T15 y T16): `grep -c` = 3.
  const FROZEN_COD_RECEIVED_COUNT = 3;

  const leader = () => (existsSync(absolute(LEADER)) ? sourceWithoutComments(LEADER) : "");
  const app = () => sourceWithoutComments(APP);
  const flat = (text: string) => text.replace(/\s+/g, " ");
  /** Lo que se pinta: componente + modelo de vista (rotulos de lider y "Cifras incompletas" viven en este). */
  const painted = () => `${leader()}\n${sourceWithoutComments(VIEW)}`;

  function topLevelBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\n(?:export\s+)?(?:type|interface)\s/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  /** Contenido entre llaves o parentesis equilibrados desde `source[open]`. */
  function balanced(source: string, open: number): string {
    const opener = source[open];
    const closer = opener === "(" ? ")" : "}";
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === opener) depth += 1;
      if (source[index] === closer) {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, index);
      }
    }
    return source.slice(open + 1);
  }

  function count(source: string, token: string): number {
    return source.split(token).length - 1;
  }

  /** El bloque `{view === "finance" && ( ... )}` de DriverView. */
  function driverFinanceBlock(): string {
    const body = topLevelBody(app(), "DriverView");
    const at = body.search(/view\s*===\s*["']finance["']\s*&&\s*\(/);
    if (at < 0) return "";
    return balanced(body, body.indexOf("(", body.indexOf("&&", at)));
  }

  /** Tag de apertura + contenido de cada `<button>`, con su linea. */
  function buttons(source: string): Array<{ line: number; tag: string }> {
    return [...source.matchAll(/<button\b/g)].map((match) => {
      const start = match.index ?? 0;
      const close = source.indexOf("</button>", start);
      return { line: source.slice(0, start).split("\n").length, tag: source.slice(start, close < 0 ? start + 800 : Math.min(close, start + 800)) };
    });
  }

  describe("el componente", () => {
    it("existe", () => {
      expect(existsSync(absolute(LEADER))).toBe(true);
    });

    it("exporta CashOutstandingLeaderPanel", () => {
      expect(leader()).toMatch(/export\s+(?:function\s+CashOutstandingLeaderPanel\b|const\s+CashOutstandingLeaderPanel\b)/);
    });

    it("pinta desde buildCashOutstandingView con role \"leader\" (y nunca \"admin\")", () => {
      expect(leader()).toMatch(/import\s*\{[^}]*\bbuildCashOutstandingView\b[^}]*\}\s*from\s*["'][^"']*cash-outstanding-view["']/);
      const calls = [...leader().matchAll(/\bbuildCashOutstandingView\s*\(/g)].map((m) => flat(balanced(leader(), (m.index ?? 0) + m[0].length - 1)));
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args).toMatch(/\brole:\s*["']leader["']/);
      expect(leader()).not.toMatch(/\brole:\s*["']admin["']/);
    });

    it("la cifra del panel es outstandingCop (neta del pago), formateada con formatCop", () => {
      expect(leader()).toMatch(/\boutstandingCop\b/);
      expect(leader()).toMatch(/\bformatCop\s*\(/);
    });

    it("al lider no se le pinta nada de proveedor ni de cuadre (decision 8)", () => {
      expect(leader()).not.toMatch(/\bbySupplier\b|\bsupplierWithheld\b|\breconciliation\b|Producto retenido|Cuadre con la posicion/);
    });
  });

  describe("carga: al abrir Finanzas y con Actualizar, sin conciliacion (decision 11)", () => {
    it("importa getFirebaseCashOutstanding de firebase/auth", () => {
      expect(leader()).toMatch(/import\s*\{[^}]*\bgetFirebaseCashOutstanding\b[^}]*\}\s*from\s*["'][^"']*firebase\/auth["']/);
    });

    it("lo llama sin argumentos: getFirebaseCashOutstanding()", () => {
      expect(leader()).toMatch(/\bgetFirebaseCashOutstanding\(\s*\)/);
      const calls = [...leader().matchAll(/\bgetFirebaseCashOutstanding\(([^)]*)\)/g)].map((m) => m[1].trim());
      expect(calls.filter((args) => args !== "")).toEqual([]);
    });

    it("nunca menciona includeReconciliation", () => {
      expect(leader()).not.toMatch(/includeReconciliation/);
    });

    it("no usa la cache compartida del admin (la suya se pide al abrir Finanzas)", () => {
      expect(leader()).not.toMatch(/\bcreateCashOutstandingSummaryCache\b|\.prime\(/);
    });

    it("carga en un useEffect del componente, no a nivel de modulo", () => {
      expect(leader()).toMatch(/\buseEffect\s*\(/);
      const moduleLevel = leader()
        .split("\n")
        .filter((line) => /^(?:export\s+)?(?:const|let|var|void|await)\b[^=]*=?.*\bgetFirebaseCashOutstanding\s*\(/.test(line) || /^(?:void\s+)?getFirebaseCashOutstanding\s*\(/.test(line));
      expect(moduleLevel).toEqual([]);
    });

    it("\"Actualizar\" y \"Reintentar\" son botones con onClick", () => {
      const all = buttons(leader());
      const refresh = all.find(({ tag }) => /aria-label=(?:"Actualizar"|\{\s*["']Actualizar["']\s*\})|>\s*Actualizar\s*$/m.test(tag) || /Actualizar/.test(tag));
      const retry = all.find(({ tag }) => /Reintentar/.test(tag));
      expect(refresh?.tag ?? "", "falta el boton Actualizar").toMatch(/onClick=\{/);
      expect(retry?.tag ?? "", "falta el boton Reintentar").toMatch(/onClick=\{/);
    });
  });

  describe("RNF_01 · no recalcula ni baja historico", () => {
    const FORBIDDEN = [
      /\bbuildCodReceivedSet\b/,
      /\bisSellerEntryEligible\b/,
      /\bcomputeDriverCashSummary\b/,
      /\bcalculateDriverFinancialSummary\b/,
      /\bbuildWalletEntries\b/,
      /\bwalletEntries\b/,
      /\bcashAllocations\b/,
      /\bstate\.settlements\b/,
      /\bstate\.orders\b/,
      /["']firebase\/firestore["']/,
      /\bcollection\(/,
      /\bonSnapshot\(/,
      /\bgetDocs\(/,
      /\bgetDoc\(/,
    ];

    it("cash-outstanding-leader.tsx no usa la materia prima del calculo ni lee Firestore", () => {
      expect(existsSync(absolute(LEADER)), `${LEADER} no existe`).toBe(true);
      const source = leader();
      expect(FORBIDDEN.filter((pattern) => pattern.test(source)).map(String)).toEqual([]);
    });

    it(`operations-app.tsx: buildCodReceivedSet sigue con ${FROZEN_COD_RECEIVED_COUNT} apariciones (congelado)`, () => {
      const raw = readFileSync(absolute(APP), "utf8");
      expect(raw.match(/\bbuildCodReceivedSet\b/g)?.length ?? 0).toBe(FROZEN_COD_RECEIVED_COUNT);
    });
  });

  describe("montaje en operations-app.tsx (solo Finanzas del lider; complementa, no sustituye)", () => {
    it("importa CashOutstandingLeaderPanel de ./cash-outstanding-leader", () => {
      const imports = [...app().matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/cash-outstanding-leader["']/g)].map((m) => m[1]).join(",");
      expect(imports).toMatch(/\bCashOutstandingLeaderPanel\b/);
    });

    it("se monta una sola vez en operations-app", () => {
      expect(count(app(), "<CashOutstandingLeaderPanel")).toBe(1);
    });

    it("se monta dentro de {view === \"finance\" && (...)} de DriverView", () => {
      expect(driverFinanceBlock()).toMatch(/<CashOutstandingLeaderPanel\b/);
    });

    it("va al inicio de Finanzas: antes de DriverFinancialSummaryPanel, que se conserva", () => {
      const block = driverFinanceBlock();
      const panel = block.indexOf("<CashOutstandingLeaderPanel");
      const summary = block.indexOf("<DriverFinancialSummaryPanel");
      expect(summary, "DriverFinancialSummaryPanel desaparecio de Finanzas").toBeGreaterThanOrEqual(0);
      expect(panel).toBeGreaterThanOrEqual(0);
      expect(panel).toBeLessThan(summary);
    });

    it("\"Pendiente por entregar\" sigue en Operacion de DriverView con financialSummary.pendingBalanceCop (P6)", () => {
      const body = topLevelBody(app(), "DriverView");
      expect(body).toContain("Pendiente por entregar");
      expect(body).toMatch(/formatCop\(\s*financialSummary\.pendingBalanceCop\s*\)/);
    });

    it("DriverView no llama hooks despues del return anticipado (if (!driver))", () => {
      const body = topLevelBody(app(), "DriverView");
      const early = body.search(/if\s*\(\s*!driver\s*\)\s*\{/);
      expect(early).toBeGreaterThanOrEqual(0);
      const after = body.slice(early);
      expect(after.match(/\buse(?:State|Effect|Memo|Callback|Ref|Reducer|LayoutEffect|Context)\s*\(/g) ?? []).toEqual([]);
    });

    it("operations-app no llama al callable por su cuenta (lo hace el componente)", () => {
      expect(app()).not.toMatch(/\bgetFirebaseCashOutstanding\b/);
    });
  });

  describe("textos y nombres accesibles del diseno (HU_02.*)", () => {
    it.each([
      "Efectivo sin llegar a Kentro",
      "Kentro tiene todo tu efectivo",
      "Ninguna entrega tuya espera su corte.",
      "No se pudo cargar",
      "Revisa la conexion y vuelve a intentarlo.",
      "No mostramos una cifra a medias.",
      "Reintentar",
      "Actualizar",
      "Que incluye esta cifra",
      "Ver pedidos cubiertos",
      "Por entregar en",
      "llevan mas de",
      "Tu pago por entrega ya esta descontado",
      "pedidos cubiertos en cortes ya saldados: no debes nada por ellos.",
      "Del mas antiguo al mas reciente",
      "Entregado el",
      "Calculando el efectivo sin llegar",
      "calculado hoy",
      "Pendiente por entregar",
    ])("el componente contiene \"%s\"", (text) => {
      expect(flat(leader())).toContain(text);
    });

    it("la nota final le dice que avise al administrador con la guia (decision 10)", () => {
      expect(leader()).toMatch(/avisa al administrador/i);
      expect(leader()).toMatch(/\bguia\b/i);
    });

    it.each(["Cifras incompletas", "Hay datos que no se pudieron leer", "No esta en ningun corte", "pagado con faltante", "Cubierto en el corte del"])(
      "lo pintado (componente + modelo de vista) contiene \"%s\"",
      (text) => {
        expect(painted()).toContain(text);
      }
    );

    it.each(["Efectivo sin llegar a Kentro", "Pedidos con efectivo sin llegar", "Actualizar", "Que incluye esta cifra"])(
      "aria-label=\"%s\" (region, lista y botones de icono del screen.json)",
      (name) => {
        expect(leader()).toMatch(new RegExp(`aria-label=(?:"${name}"|\\{\\s*["']${name}["']\\s*\\})`));
      }
    );

    it("el titulo del panel es un h2 \"Efectivo sin llegar a Kentro\"", () => {
      expect(flat(leader())).toMatch(/<h2\b[^>]*>\s*Efectivo sin llegar a Kentro\s*<\/h2>/);
    });

    it("la region es un <section> con aria-label", () => {
      expect(leader()).toMatch(/<section\b[^>]*aria-label=(?:"Efectivo sin llegar a Kentro"|\{\s*["']Efectivo sin llegar a Kentro["']\s*\})/);
    });

    it("la lista de pedidos es un <ul> u <ol> con aria-label \"Pedidos con efectivo sin llegar\"", () => {
      expect(leader()).toMatch(/<(?:ul|ol)\b[^>]*aria-label=(?:"Pedidos con efectivo sin llegar"|\{\s*["']Pedidos con efectivo sin llegar["']\s*\})/);
    });

    it("role=\"status\" (cargando) y role=\"alert\" nombrado \"No se pudo cargar\" (error)", () => {
      expect(leader()).toMatch(/role=["']status["']/);
      expect(leader()).toMatch(/role=["']alert["'][^>]*(?:aria-label=(?:"No se pudo cargar"|\{\s*["']No se pudo cargar["']\s*\})|aria-labelledby=)|(?:aria-label=(?:"No se pudo cargar"|\{\s*["']No se pudo cargar["']\s*\})|aria-labelledby=)[^>]*role=["']alert["']/);
    });

    it("\"Ver pedidos cubiertos\" es una divulgacion con aria-expanded y nombre fijo", () => {
      const disclosure = buttons(leader()).find(({ tag }) => /Ver pedidos cubiertos/.test(tag));
      expect(disclosure?.tag ?? "", "falta el boton Ver pedidos cubiertos").toMatch(/aria-expanded=/);
    });
  });

  describe("sistema de diseno: densidad de calle (README decision 10)", () => {
    it("sin colores literales (hex, rgb, hsl ni clases arbitrarias de color)", () => {
      expect(existsSync(absolute(LEADER)), `${LEADER} no existe`).toBe(true);
      const source = leader();
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
      expect(source).not.toMatch(/\[(?:#|rgb|hsl)/);
    });

    it("todo <button> mide >= 56px (min-h-14, h-14 o min-h-[56px])", () => {
      const all = buttons(leader());
      expect(all.length).toBeGreaterThan(0);
      const short = all.filter(({ tag }) => !/\bmin-h-14\b|\bh-14\b|\bmin-h-\[56px\]/.test(tag)).map(({ line }) => `linea ${line}`);
      expect(short).toEqual([]);
    });

    it("se queda en tema oscuro: no envuelve en .theme-light (eso es solo del mensajero)", () => {
      expect(leader()).not.toMatch(/theme-light/);
    });
  });
});

describe("T17 · RF_01: la guarda anti-copia mira los cuatro archivos", () => {
  /*
   * Cierre de la guarda de T6 (plan 2.2): la lista fija de cuatro archivos ya no admite pendientes.
   * Los cuatro existen y ninguno contiene la materia prima de la regla de recibido.
   */
  const WATCHED = [
    "functions/src/cash-outstanding.ts",
    "functions/src/cash-outstanding-api.ts",
    "functions/src/cash-overdue-notice.ts",
    "src/lib/cash-outstanding-view.ts",
  ] as const;

  function copies(file: string): string[] {
    const found: string[] = [];
    sourceWithoutComments(file)
      .split("\n")
      .forEach((line, index) => {
        for (const token of ["cashAllocations", "covered"]) {
          if (new RegExp(`\\b${token}\\b`).test(line)) found.push(`${token} (linea ${index + 1})`);
        }
      });
    return found;
  }

  it.each(WATCHED)("%s existe", (file) => {
    expect(existsSync(absolute(file))).toBe(true);
  });

  it.each(WATCHED)("%s: sin copia de la regla de recibido", (file) => {
    expect(copies(file)).toEqual([]);
  });

  it("la guarda de T6 ya no tiene archivos pendientes (lista fija cerrada)", () => {
    const guard = readFileSync(absolute("src/lib/spec-026-guards.test.ts"), "utf8");
    const pending = guard.match(/const\s+PENDING_UNTIL_LATER_TASKS\s*=\s*new\s+Set<string>\(\[([\s\S]*?)\]\)/)?.[1] ?? "missing";
    expect(pending.replace(/\/\/.*$/gm, "").trim()).toBe("");
  });
});

describe("T18 · compare: posicion de la plataforma y linea base (RNF_02, DoD 3 y 4)", () => {
  /*
   * T18 (plan 4.4, 5.3). `node scripts/verify-026.js compare [--deployed]` corre contra produccion y lo
   * lanza una persona; la suite no lo ejecuta contra Firestore. Aqui se ata:
   *
   * 1. Fuente: el subcomando `compare` esta en COMMANDS y reutiliza lo COMPILADO
   *    (`functions/lib/cash-outstanding-api.js` -> `loadCashOutstandingInput` con alcance admin,
   *    `includeReconciliation: true` y `coverage: "full"`; `functions/lib/cash-outstanding.js` ->
   *    `buildCashOutstandingReport`/`reconcileWithPlatformPosition`; `computePlatformPosition`), sin
   *    las reproducciones locales de T1 (`isDriverSettlementCashSettledLocal`, `locationOf`).
   *    Lee `t1-linea-base-ids.json`, escribe `t18-compare.txt` y sale con codigo 1 si no pasa.
   *
   * 2. Contrato de la funcion PURA exportada por el script:
   *
   *    module.exports = { evaluateCompare, ... }   y   main() solo si `require.main === module`
   *    (requerir el script desde la suite no puede lanzar main ni process.exit).
   *
   *    evaluateCompare({
   *      reconciliation: PositionReconciliation | null,          // report.reconciliation
   *      position: { driverReceivableCop: number },              // computePlatformPosition / getPlatformPosition
   *      report: { rows, nettedRows, unreadableOrderIds, unreadableSettlementIds, unreadableEntryIds },
   *      baseline: { generatedAt, over30Days, coveredByNetting, rows },   // t1-linea-base-ids.json
   *      evidence: { receivedOrderIds: string[]; universeOrderIds: string[] }
   *    }) -> {
   *      pass: boolean,                    // === (failures.length === 0)
   *      failures: string[],               // una frase por condicion incumplida
   *      stale:   Array<{ settlementId: string; amountCop: number }>,  // causa settlement_cash_pending_stale
   *      missing: Array<{ settlementId: string; amountCop: number }>,  // causa settlement_cash_pending_missing
   *      changes: Array<{ orderId: string; from: Group; to: Group; reason: Reason | null }>
   *    }
   *    Group  = "rows" | "netted" | "absent"
   *    Reason = "received" | "netted" | "status_corrected" | "unreadable" | "new_order"
   *
   *    Regla de paso (DoD 4): falla si `reconciliation` es null, si `unexplainedCop !== 0`, si
   *    `reconciliation.driverReceivableCop !== position.driverReceivableCop` o si alguno de los tres
   *    `unreadable*` del informe no esta vacio. `stale` y `missing` se listan y NUNCA fallan.
   *
   *    DoD 3: grupo en linea base = "netted" si esta en `coveredByNetting`, "rows" si en `rows`, si no
   *    "absent"; grupo actual = "netted" si esta en `report.nettedRows`, "rows" si en `report.rows`, si
   *    no "absent". Solo los ids con from !== to van a `changes`. Motivo:
   *      - to "absent": "unreadable" si esta en unreadableOrderIds; si no "received" si esta en
   *        receivedOrderIds; si no "status_corrected" si NO esta en universeOrderIds; si no null.
   *      - to "netted": "netted".
   *      - from "absent" -> "rows": "new_order" si su deliveredAt > baseline.generatedAt; si no null.
   *      - from "netted" -> "rows": null (un compensado no puede volver a deberse sin motivo).
   *    Un cambio con reason null falla. Una fila de `nettedRows` con `isOverdue` falla (RF_09).
   */
  const SCRIPT = "scripts/verify-026.js";
  const EVIDENCE = ".sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t18-compare.txt";
  const source = () => sourceWithoutComments(SCRIPT);

  /** Cuerpo de la funcion que COMMANDS registra como "compare" (mismo criterio que T2). */
  function compareBody(): string {
    const src = source();
    const name = src.match(/["']?compare["']?\s*:\s*([A-Za-z_$][\w$]*)/)?.[1];
    if (!name) return "";
    const start = src.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m"));
    if (start < 0) return "";
    const end = src.indexOf("\n}\n", start);
    return end < 0 ? src.slice(start) : src.slice(start, end + 2);
  }

  /** Cuerpo de cualquier funcion de nivel superior del script, por nombre. */
  function functionBody(name: string): string {
    const src = source();
    const start = src.search(new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m"));
    if (start < 0) return "";
    const end = src.indexOf("\n}\n", start);
    return end < 0 ? src.slice(start) : src.slice(start, end + 2);
  }

  /** Cuerpo de compare mas las funciones de nivel superior que llama (helpers propios del subcomando). */
  function compareClosure(): string {
    const body = compareBody();
    const called = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
    const helpers = [...new Set(called)].map(functionBody).filter(Boolean);
    return [body, ...helpers].join("\n");
  }

  type Group = "rows" | "netted" | "absent";
  type Reason = "received" | "netted" | "status_corrected" | "unreadable" | "new_order";
  type Row = { orderId: string; deliveredAt: string; isOverdue: boolean; location: string };
  type CompareInput = {
    reconciliation: {
      driverReceivableCop: number;
      listOutstandingCop: number;
      deltaCop: number;
      causes: Array<{ cause: string; amountCop: number; orderIds: string[]; settlementId?: string }>;
      staleSettlementsCop: number;
      missingPendingSettlementsCop: number;
      unexplainedCop: number;
      unexplainedOrderIds: string[];
    } | null;
    position: { driverReceivableCop: number };
    report: {
      rows: Row[];
      nettedRows: Row[];
      unreadableOrderIds: string[];
      unreadableSettlementIds: string[];
      unreadableEntryIds: string[];
    };
    baseline: {
      generatedAt: string;
      over30Days: Array<{ orderId: string }>;
      coveredByNetting: Array<{ orderId: string }>;
      rows: Array<{ orderId: string }>;
    };
    evidence: { receivedOrderIds: string[]; universeOrderIds: string[] };
  };
  type CompareResult = {
    pass: boolean;
    failures: string[];
    stale: Array<{ settlementId: string; amountCop: number }>;
    missing: Array<{ settlementId: string; amountCop: number }>;
    changes: Array<{ orderId: string; from: Group; to: Group; reason: Reason | null }>;
  };

  async function evaluateCompare(): Promise<(input: CompareInput) => CompareResult> {
    // Sin la guarda, requerir el script lanzaria main() y process.exit(2) dentro de la suite.
    if (!/require\.main\s*===\s*module/.test(source())) {
      throw new Error("verify-026.js debe ejecutar main() solo si require.main === module para poder importarse");
    }
    const { createRequire } = await import("node:module");
    const mod = createRequire(import.meta.url)(absolute(SCRIPT)) as Record<string, unknown>;
    if (typeof mod.evaluateCompare !== "function") throw new Error("verify-026.js no exporta evaluateCompare");
    return mod.evaluateCompare as (input: CompareInput) => CompareResult;
  }

  const BASELINE_AT = "2026-10-02T16:49:33.210Z";
  const row = (orderId: string, extra: Partial<Row> = {}): Row => ({
    orderId,
    deliveredAt: "2026-09-20T10:00:00.000Z",
    isOverdue: false,
    location: "outside_settlement",
    ...extra
  });
  const netted = (orderId: string, extra: Partial<Row> = {}): Row => row(orderId, { location: "covered_by_netting", ...extra });

  /** Escenario sano: misma lista que la linea base, posicion igual, sin residuo ni ilegibles. */
  function healthy(): CompareInput {
    return {
      reconciliation: {
        driverReceivableCop: 500_000,
        listOutstandingCop: 480_000,
        deltaCop: 20_000,
        causes: [{ cause: "outside_negative_net", amountCop: 20_000, orderIds: ["o-neg"] }],
        staleSettlementsCop: 0,
        missingPendingSettlementsCop: 0,
        unexplainedCop: 0,
        unexplainedOrderIds: []
      },
      position: { driverReceivableCop: 500_000 },
      report: {
        rows: [row("o-1"), row("o-2", { location: "in_settlement_open" })],
        nettedRows: [netted("o-n1"), netted("o-n2")],
        unreadableOrderIds: [],
        unreadableSettlementIds: [],
        unreadableEntryIds: []
      },
      baseline: {
        generatedAt: BASELINE_AT,
        over30Days: [{ orderId: "o-n1" }],
        coveredByNetting: [{ orderId: "o-n1" }, { orderId: "o-n2" }],
        rows: [{ orderId: "o-1" }, { orderId: "o-2" }]
      },
      evidence: { receivedOrderIds: [], universeOrderIds: ["o-1", "o-2", "o-n1", "o-n2", "o-neg"] }
    };
  }

  describe("fuente del subcomando", () => {
    it("COMMANDS registra el subcomando compare", () => {
      expect(source()).toMatch(/COMMANDS\s*=\s*\{[^}]*["']?compare["']?\s*:/);
      expect(compareBody()).not.toBe("");
    });

    it("compare usa el cargador compilado loadCashOutstandingInput de functions/lib/cash-outstanding-api", () => {
      expect(source()).toMatch(/require\([^)]*functions\/lib\/cash-outstanding-api["'][^)]*\)/);
      expect(compareClosure()).toMatch(/loadCashOutstandingInput\s*\(/);
    });

    it("compare pide la carga completa del admin con conciliacion (coverage full)", () => {
      const closure = compareClosure();
      expect(closure).toMatch(/includeReconciliation\s*:\s*true/);
      expect(closure).toMatch(/coverage\s*:\s*["']full["']/);
      expect(closure).toMatch(/kind\s*:\s*["']admin["']/);
    });

    it("compare usa el nucleo compilado de functions/lib/cash-outstanding (informe y conciliacion)", () => {
      expect(source()).toMatch(/require\([^)]*functions\/lib\/cash-outstanding["'][^)]*\)/);
      expect(compareClosure()).toMatch(/buildCashOutstandingReport\s*\(|reconcileWithPlatformPosition\s*\(/);
    });

    it("compare obtiene la posicion con computePlatformPosition compilado", () => {
      expect(compareClosure()).toMatch(/computePlatformPosition\s*\(/);
    });

    it("compare no usa las reproducciones locales de T1 (nada se reimplementa)", () => {
      const closure = compareClosure();
      expect(compareBody()).not.toBe("");
      expect(closure).not.toMatch(/isDriverSettlementCashSettledLocal\s*\(/);
      expect(closure).not.toMatch(/\blocationOf\s*\(/);
      expect(closure).not.toMatch(/\bdeliveredAtOf\s*\(/);
    });

    it("compare lee la linea base t1-linea-base-ids.json", () => {
      expect(compareClosure()).toMatch(/IDS_FILE|t1-linea-base-ids\.json/);
    });

    it("compare decide con evaluateCompare y sale con codigo 1 si no pasa", () => {
      const closure = compareClosure();
      expect(closure).toMatch(/evaluateCompare\s*\(/);
      expect(closure).toMatch(/process\.exitCode\s*=\s*1|process\.exit\(\s*1\s*\)/);
    });

    it("compare escribe la evidencia t18-compare.txt", () => {
      expect(compareClosure()).toContain("t18-compare.txt");
    });

    it("compare --deployed usa los callables desplegados getCashOutstanding y getPlatformPosition", () => {
      const closure = compareClosure();
      expect(closure).toContain("--deployed");
      expect(closure).toContain("getCashOutstanding");
      expect(closure).toContain("getPlatformPosition");
    });

    it("compare --deployed sin credenciales falla con un mensaje que nombra las variables", async () => {
      expect(compareBody()).not.toBe("");
      const { spawnSync } = await import("node:child_process");
      const env = { ...process.env };
      delete env.VERIFY_026_ADMIN_EMAIL;
      delete env.VERIFY_026_ADMIN_PASSWORD;
      const result = spawnSync(process.execPath, [absolute(SCRIPT), "compare", "--deployed"], {
        cwd: absolute(""),
        env,
        encoding: "utf8",
        timeout: 20_000
      });
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(2); // 2 = subcomando desconocido
      expect(result.stderr).toContain("VERIFY_026_ADMIN_EMAIL");
      expect(result.stderr).toContain("VERIFY_026_ADMIN_PASSWORD");
    });
  });

  describe("evaluateCompare (puro): regla de paso DoD 4", () => {
    it("se exporta y el escenario sano pasa", async () => {
      const result = (await evaluateCompare())(healthy());
      expect(result.failures).toEqual([]);
      expect(result.pass).toBe(true);
      expect(result.changes).toEqual([]);
    });

    it("unexplainedCop distinto de 0 falla", async () => {
      const input = healthy();
      input.reconciliation!.unexplainedCop = 31_000;
      input.reconciliation!.unexplainedOrderIds = ["o-perdido"];
      const result = (await evaluateCompare())(input);
      expect(result.pass).toBe(false);
      expect(result.failures.join(" ")).toMatch(/unexplained/i);
    });

    it("driverReceivableCop distinto del de la posicion falla aunque el residuo sea 0", async () => {
      const input = healthy();
      input.position.driverReceivableCop = 499_999;
      const result = (await evaluateCompare())(input);
      expect(result.pass).toBe(false);
      expect(result.failures.join(" ")).toMatch(/driverReceivable/i);
    });

    it.each(["unreadableOrderIds", "unreadableSettlementIds", "unreadableEntryIds"] as const)(
      "%s no vacio falla",
      async (key) => {
        const input = healthy();
        input.report[key] = ["x-ilegible"];
        const result = (await evaluateCompare())(input);
        expect(result.pass).toBe(false);
        expect(result.failures.join(" ")).toContain(key);
      }
    );

    it("sin conciliacion (null) falla: no hay nada que comparar", async () => {
      const input = healthy();
      input.reconciliation = null;
      const result = (await evaluateCompare())(input);
      expect(result.pass).toBe(false);
    });

    it("stale y missing se listan por corte y NO fallan", async () => {
      const input = healthy();
      input.reconciliation!.causes.push(
        { cause: "settlement_cash_pending_stale", amountCop: 12_000, orderIds: [], settlementId: "stl-viejo" },
        { cause: "settlement_cash_pending_missing", amountCop: -8_000, orderIds: [], settlementId: "stl-sin-campo" }
      );
      input.reconciliation!.staleSettlementsCop = 12_000;
      input.reconciliation!.missingPendingSettlementsCop = -8_000;
      const result = (await evaluateCompare())(input);
      expect(result.pass).toBe(true);
      expect(result.stale).toEqual([{ settlementId: "stl-viejo", amountCop: 12_000 }]);
      expect(result.missing).toEqual([{ settlementId: "stl-sin-campo", amountCop: -8_000 }]);
    });
  });

  describe("evaluateCompare (puro): linea base DoD 3", () => {
    it("un compensado de la linea base que ahora esta en rows falla sin motivo", async () => {
      const input = healthy();
      input.report.nettedRows = [netted("o-n1")];
      input.report.rows.push(row("o-n2", { location: "settlement_paid_short" }));
      const result = (await evaluateCompare())(input);
      expect(result.pass).toBe(false);
      expect(result.changes).toEqual([{ orderId: "o-n2", from: "netted", to: "rows", reason: null }]);
    });

    it("un compensado vencido falla (RF_09: lo compensado no vence)", async () => {
      const input = healthy();
      input.report.nettedRows = [netted("o-n1", { isOverdue: true }), netted("o-n2")];
      const result = (await evaluateCompare())(input);
      expect(result.pass).toBe(false);
    });

    it("fila que paso a compensada: motivo netted, pasa", async () => {
      const input = healthy();
      input.report.rows = [row("o-2", { location: "in_settlement_open" })];
      input.report.nettedRows.push(netted("o-1"));
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-1", from: "rows", to: "netted", reason: "netted" }]);
      expect(result.pass).toBe(true);
    });

    it("fila que desaparecio por estar recibida ahora: motivo received, pasa", async () => {
      const input = healthy();
      input.report.rows = [row("o-2", { location: "in_settlement_open" })];
      input.evidence.receivedOrderIds = ["o-1"];
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-1", from: "rows", to: "absent", reason: "received" }]);
      expect(result.pass).toBe(true);
    });

    it("compensado que ahora esta recibido (su estado actual): motivo received, pasa", async () => {
      const input = healthy();
      input.report.nettedRows = [netted("o-n1")];
      input.evidence.receivedOrderIds = ["o-n2"];
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-n2", from: "netted", to: "absent", reason: "received" }]);
      expect(result.pass).toBe(true);
    });

    it("fila que salio del universo (corregida de estado): motivo status_corrected, pasa", async () => {
      const input = healthy();
      input.report.rows = [row("o-2", { location: "in_settlement_open" })];
      input.evidence.universeOrderIds = input.evidence.universeOrderIds.filter((id) => id !== "o-1");
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-1", from: "rows", to: "absent", reason: "status_corrected" }]);
      expect(result.pass).toBe(true);
    });

    it("fila ilegible: motivo unreadable (y la regla de paso falla por el ilegible, no por el cambio)", async () => {
      const input = healthy();
      input.report.rows = [row("o-2", { location: "in_settlement_open" })];
      input.report.unreadableOrderIds = ["o-1"];
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-1", from: "rows", to: "absent", reason: "unreadable" }]);
      expect(result.pass).toBe(false);
      expect(result.failures.join(" ")).toContain("unreadableOrderIds");
    });

    it("pedido entregado despues de la linea base: motivo new_order, pasa", async () => {
      const input = healthy();
      input.report.rows.push(row("o-nuevo", { deliveredAt: "2026-10-03T09:00:00.000Z" }));
      input.evidence.universeOrderIds.push("o-nuevo");
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-nuevo", from: "absent", to: "rows", reason: "new_order" }]);
      expect(result.pass).toBe(true);
    });

    it("pedido antiguo que aparece sin estar en la linea base: sin motivo, falla", async () => {
      const input = healthy();
      input.report.rows.push(row("o-aparecido", { deliveredAt: "2026-08-01T09:00:00.000Z" }));
      input.evidence.universeOrderIds.push("o-aparecido");
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-aparecido", from: "absent", to: "rows", reason: null }]);
      expect(result.pass).toBe(false);
      expect(result.failures.join(" ")).toContain("o-aparecido");
    });

    it("fila que desaparece sin estar recibida, legible y en el universo: sin motivo, falla con su id", async () => {
      const input = healthy();
      input.report.rows = [row("o-2", { location: "in_settlement_open" })];
      const result = (await evaluateCompare())(input);
      expect(result.changes).toEqual([{ orderId: "o-1", from: "rows", to: "absent", reason: null }]);
      expect(result.pass).toBe(false);
      expect(result.failures.join(" ")).toContain("o-1");
    });
  });

  describe("evidencia de produccion", () => {
    it("t18-compare.txt existe", () => {
      expect(existsSync(absolute(EVIDENCE))).toBe(true);
    });

    it("t18-compare.txt trae la regla de paso, la lista stale/missing y la tabla de ids con motivo", () => {
      const evidence = existsSync(absolute(EVIDENCE)) ? readFileSync(absolute(EVIDENCE), "utf8") : "";
      expect(evidence).toMatch(/unexplainedCop/);
      expect(evidence).toMatch(/driverReceivableCop/);
      expect(evidence).toMatch(/stale/i);
      expect(evidence).toMatch(/missing/i);
      expect(evidence).toMatch(/t1-linea-base-ids\.json/);
      expect(evidence).toMatch(/\b(PASA|FALLA)\b/);
    });
  });
});

describe("T22 · la tarjeta de Operacion avisa de cifras incompletas (R2-RF_03-1, RF_03)", () => {
  /*
   * Guarda de fuente (no hay render de componentes en el repo). Contrato:
   *  - `CashOutstandingOverdueCard` lee `card.isIncomplete` (o `card?.isIncomplete`) del modelo de vista.
   *  - Pinta el literal "Cifras incompletas" DENTRO de su propio cuerpo: el que ya pinta la pestana
   *    (`IncompleteNotice`) no cuenta, porque el admin no entra a la pestana para enterarse.
   *  - La tarjeta conserva el boton que lleva a la pestana (`onClick={open}`).
   */
  const ADMIN = "src/components/cash-outstanding-admin.tsx";
  const admin = () => (existsSync(absolute(ADMIN)) ? sourceWithoutComments(ADMIN) : "");

  /** Cuerpo de una funcion de nivel superior: hasta la siguiente declaracion de nivel superior. */
  function topLevelBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\n(?:export\s+)?(?:type|interface)\s/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  const cardBody = () => topLevelBody(admin(), "CashOutstandingOverdueCard");

  it("CashOutstandingOverdueCard existe", () => {
    expect(cardBody()).not.toBe("");
  });

  it("lee card.isIncomplete", () => {
    expect(cardBody()).toMatch(/\bcard\??\.isIncomplete\b/);
  });

  it("pinta el literal 'Cifras incompletas' dentro de la tarjeta", () => {
    expect(cardBody()).toContain("Cifras incompletas");
  });

  it("sigue llevando a la pestana (onClick={open})", () => {
    expect(cardBody()).toMatch(/onClick=\{\s*open\s*\}/);
  });
});

describe("T23 · lo retenido a proveedores se ve aunque todo este compensado (R2-RF_08-1, RF_08, RF_09)", () => {
  /*
   * Guarda de fuente sobre `CashOutstandingBody` (src/components/cash-outstanding-admin.tsx). Contrato:
   *  - `<SupplierWithheldCard` se condiciona a `view.showSupplierWithheld`, no a `report.rows.length` ni a
   *    `hasAnyRows` (la decision es del modelo de vista).
   *  - El literal "pueden cobrar todo lo entregado" solo sale bajo `emptyState === "all_clear"`.
   *  - Hay una rama `emptyState === "only_netted"` con su propio texto, que habla de compensacion y NO dice
   *    "pueden cobrar todo".
   */
  const ADMIN = "src/components/cash-outstanding-admin.tsx";
  const admin = () => (existsSync(absolute(ADMIN)) ? sourceWithoutComments(ADMIN) : "");

  function topLevelBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\n(?:export\s+)?(?:type|interface)\s/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  const body = () => topLevelBody(admin(), "CashOutstandingBody");

  /** La expresion `{ ... && <SupplierWithheldCard` en la que se monta la tarjeta. */
  const supplierCondition = (): string => {
    const match = body().match(/\{([^{}]*?)&&\s*<SupplierWithheldCard\b/);
    return match ? match[1] : "";
  };

  it("CashOutstandingBody existe", () => {
    expect(body()).not.toBe("");
  });

  it("la tarjeta de proveedor se condiciona a view.showSupplierWithheld", () => {
    expect(supplierCondition()).toMatch(/\bview\??\.showSupplierWithheld\b/);
  });

  it("la tarjeta de proveedor ya no depende de que haya rows (ni hasAnyRows ni report.rows.length)", () => {
    expect(supplierCondition()).not.toMatch(/hasAnyRows|rows\.length/);
  });

  it("'pueden cobrar todo lo entregado' solo bajo emptyState === \"all_clear\"", () => {
    const source = body();
    const at = source.indexOf("pueden cobrar todo lo entregado");
    expect(at).toBeGreaterThan(-1);
    const before = source.slice(0, at);
    const lastBranch = Math.max(before.lastIndexOf("all_clear"), before.lastIndexOf("only_netted"));
    expect(lastBranch, "no hay rama emptyState antes del literal").toBeGreaterThan(-1);
    expect(before.slice(lastBranch)).toMatch(/^all_clear["']/);
    expect(before).toMatch(/emptyState\s*===\s*["']all_clear["']/);
  });

  it("hay una rama emptyState === \"only_netted\" con texto de compensacion y sin 'pueden cobrar todo'", () => {
    const source = body();
    const at = source.search(/emptyState\s*===\s*["']only_netted["']/);
    expect(at).toBeGreaterThan(-1);
    const rest = source.slice(at + 1);
    const end = rest.search(/emptyState\s*===|<LeaderGroups\b|<NettedSection\b/);
    const branch = end < 0 ? rest : rest.slice(0, end);
    expect(branch).toMatch(/cubierto por compensacion/);
    expect(branch).not.toMatch(/pueden cobrar todo/);
  });
});

describe("T24 · el aviso de la tarjeta dice hacia donde puede estar mal la cifra (R3-RF_03-1, RF_03)", () => {
  /*
   * Guarda de fuente sobre `CashOutstandingOverdueCard`. Contrato:
   *  - Pinta `card.incompleteText` (el texto lo decide el modelo de vista).
   *  - No contiene el literal fijo "la cifra puede ser mayor": con un corte ilegible la cifra puede estar
   *    inflada, no corta.
   */
  const ADMIN = "src/components/cash-outstanding-admin.tsx";
  const admin = () => (existsSync(absolute(ADMIN)) ? sourceWithoutComments(ADMIN) : "");

  function topLevelBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m"));
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\n(?:export\s+)?(?:type|interface)\s/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  const cardBody = () => topLevelBody(admin(), "CashOutstandingOverdueCard");

  it("CashOutstandingOverdueCard existe", () => {
    expect(cardBody()).not.toBe("");
  });

  it("pinta card.incompleteText", () => {
    expect(cardBody()).toMatch(/\{\s*card\??\.incompleteText\s*\}/);
  });

  it("no contiene el literal fijo 'la cifra puede ser mayor'", () => {
    expect(cardBody()).not.toContain("la cifra puede ser mayor");
  });
});
