/**
 * Spec 029 · T8 — peticion, errores y limite de la Store API (puro).
 *
 * `functions/src/store-api-request.ts` es puro (sin firebase-admin). Ata:
 *  1. `routeStoreApiRequest` (paso 0 de la precedencia, decision 12): rutas nuevas bajo `orders/{id}` con su
 *     `Allow`, 404 `route_not_found` y 405 `method_not_allowed`; las rutas viejas siguen solo `GET` con su 405
 *     de hoy (forma `{ ok: false, error }`) y sin validacion de parametros (RF_20).
 *  2. `validateQueryParameters` (paso 3): 400 `unknown_parameter` nombrando cada parametro (RF_03).
 *  3. `isValidShopifyOrderId` (plan 2.10).
 *  4. `parseConfirmBody` (decision 13) y `parseWriteBody` (plan 4.4): 400 `invalid_json` / `invalid_body` en el
 *     paso 3; los errores de campo se CALCULAN aqui y se devuelven sin responder (el 422 sale en el paso 6).
 *  5. `buildFieldError`, catalogo `code` → HTTP congelado, `buildErrorBody`, `STORE_API_PRECEDENCE`.
 *  6. `bodyHash` canonico, `STORE_API_WRITES_PER_MINUTE` y `rateWindow` (RNF_04).
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle con
 * su propio mensaje en vez de tumbar el archivo entero.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

const MODULE = "../../functions/src/store-api-request";
const AUTH_MODULE = "../../functions/src/store-api-auth";

async function load() {
  return import(MODULE);
}

const SELLER = "seller-test";
const READ_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6c41e";
const WRITE_KEY = "kw_" + "Ab3_-xY9".repeat(5) + "Qz7k9";
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const CONFIG = {
  sellerId: SELLER,
  status: "active",
  apiKey: READ_KEY,
  writeKeyHash: sha256(WRITE_KEY),
  writeKeyLast4: WRITE_KEY.slice(-4)
};

const NEW_ROUTES = [
  { method: "GET", path: "/orders/o-1", route: "order_read", access: "read" },
  { method: "GET", path: "/orders/o-1/history", route: "order_history", access: "read" },
  { method: "POST", path: "/orders/o-1/confirm", route: "order_confirm", access: "write" },
  { method: "PATCH", path: "/orders/o-1", route: "order_patch", access: "write" },
  { method: "POST", path: "/orders/o-1/cancel", route: "order_cancel", access: "write" }
] as const;

const json = (value: unknown) => JSON.stringify(value);

/**
 * La secuencia de los pasos 0-3 de la decision 12, tal como la encadenara el handler (T10/T11): la primera
 * que falla responde.
 */
async function pipeline(req: { method: string; path: string; query: Record<string, unknown>; bearer?: string }) {
  const { routeStoreApiRequest, validateQueryParameters } = await load();
  const { resolveStoreCredentials } = await import(AUTH_MODULE);
  const match = routeStoreApiRequest({ method: req.method, path: req.path });
  if (!match.ok) return { step: 0, httpStatus: match.httpStatus, code: match.code };
  const credentials = resolveStoreCredentials({
    route: match.access,
    querySellerId: req.query.sellerId,
    queryKey: req.query.key,
    bearer: req.bearer,
    config: CONFIG
  });
  if (!credentials.ok) return { step: 2, httpStatus: credentials.httpStatus, code: credentials.code };
  const params = validateQueryParameters(match, req.query);
  if (!params.ok) return { step: 3, httpStatus: params.httpStatus, code: params.code };
  return { step: 4, httpStatus: 200, code: null };
}

function problemsOf(result: any): Array<{ field: string; code: string }> {
  expect(result.ok).toBe(true);
  return (result.fieldProblems as Array<{ field: string; code: string }>).map(({ field, code }) => ({ field, code }));
}

function sortProblems<T extends { field: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.field.localeCompare(b.field));
}

describe("T8 · paso 0: routeStoreApiRequest", () => {
  it.each(NEW_ROUTES)("$method $path → ruta nueva $route ($access)", async ({ method, path, route, access }) => {
    const { routeStoreApiRequest } = await load();
    const match = routeStoreApiRequest({ method, path });
    expect(match).toMatchObject({ ok: true, kind: "new", route, access, orderId: "o-1" });
  });

  it("acepta el prefijo /storeApi y la barra final, como hoy", async () => {
    const { routeStoreApiRequest } = await load();
    expect(routeStoreApiRequest({ method: "POST", path: "/storeApi/orders/o-9/confirm/" })).toMatchObject({
      ok: true,
      route: "order_confirm",
      orderId: "o-9"
    });
  });

  it.each([
    { method: "DELETE", path: "/orders/o-1", allow: "GET, PATCH" },
    { method: "POST", path: "/orders/o-1", allow: "GET, PATCH" },
    { method: "POST", path: "/orders/o-1/history", allow: "GET" },
    { method: "GET", path: "/orders/o-1/confirm", allow: "POST" },
    { method: "PATCH", path: "/orders/o-1/cancel", allow: "POST" }
  ])("$method $path → 405 method_not_allowed con Allow: $allow y cuerpo nuevo", async ({ method, path, allow }) => {
    const { routeStoreApiRequest } = await load();
    const match = routeStoreApiRequest({ method, path });
    expect(match).toMatchObject({ ok: false, httpStatus: 405, code: "method_not_allowed", allow });
    expect(match.body).toMatchObject({ ok: false, code: "method_not_allowed" });
    expect(typeof match.body.message).toBe("string");
  });

  it.each(["/orders/o-1/foo", "/orders/o-1/confirm/extra", "/orders/o-1/history/x"])(
    "%s (bajo orders/{id}) → 404 route_not_found con cuerpo nuevo",
    async (path) => {
      const { routeStoreApiRequest } = await load();
      const match = routeStoreApiRequest({ method: "POST", path });
      expect(match).toMatchObject({ ok: false, httpStatus: 404, code: "route_not_found" });
      expect(match.body).toMatchObject({ ok: false, code: "route_not_found" });
    }
  );

  it.each(["/", "/resumen", "/kpis", "/orders", "/settlements", "/desconocida"])(
    "GET %s → ruta vieja (legacy_read), su 404 unknown_resource lo sigue decidiendo el handler",
    async (path) => {
      const { routeStoreApiRequest } = await load();
      expect(routeStoreApiRequest({ method: "GET", path })).toMatchObject({ ok: true, kind: "legacy", access: "legacy_read" });
    }
  );

  it.each(["/orders", "/resumen", "/desconocida"])("POST %s → el 405 de hoy, forma vieja y Allow: GET", async (path) => {
    const { routeStoreApiRequest } = await load();
    const match = routeStoreApiRequest({ method: "POST", path });
    expect(match).toMatchObject({ ok: false, httpStatus: 405, allow: "GET" });
    expect(match.body).toEqual({ ok: false, error: "method_not_allowed" });
  });
});

describe("T8 · paso 3: parametros de consulta (RF_03)", () => {
  it.each(NEW_ROUTES)("$method $path con dos parametros desconocidos → 400 nombrando cada uno", async ({ method, path }) => {
    const { routeStoreApiRequest, validateQueryParameters } = await load();
    const match = routeStoreApiRequest({ method, path });
    const result = validateQueryParameters(match, { sellerId: SELLER, foo: "1", bar: "2" });
    expect(result).toMatchObject({ ok: false, httpStatus: 400, code: "unknown_parameter" });
    expect(result.body).toMatchObject({ ok: false, code: "unknown_parameter" });
    expect(result.body.message).toContain("foo");
    expect(result.body.message).toContain("bar");
    expect(sortProblems(result.body.fields.map(({ field, code }: any) => ({ field, code })))).toEqual([
      { field: "bar", code: "not_allowed" },
      { field: "foo", code: "not_allowed" }
    ]);
  });

  it.each(NEW_ROUTES)("$method $path solo con sellerId → pasa", async ({ method, path }) => {
    const { routeStoreApiRequest, validateQueryParameters } = await load();
    const match = routeStoreApiRequest({ method, path });
    expect(validateQueryParameters(match, { sellerId: SELLER })).toEqual({ ok: true });
  });

  it.each(NEW_ROUTES.filter((route) => route.access === "read"))(
    "$method $path (lectura) admite key por query como hoy",
    async ({ method, path }) => {
      const { routeStoreApiRequest, validateQueryParameters } = await load();
      const match = routeStoreApiRequest({ method, path });
      expect(validateQueryParameters(match, { sellerId: SELLER, key: READ_KEY })).toEqual({ ok: true });
    }
  );

  it.each(["/orders", "/resumen", "/kpis", "/settlements"])("ruta vieja GET %s: sin validacion de parametros", async (path) => {
    const { routeStoreApiRequest, validateQueryParameters } = await load();
    const match = routeStoreApiRequest({ method: "GET", path });
    expect(validateQueryParameters(match, { sellerId: SELLER, key: READ_KEY, foo: "1", zzz: "" })).toEqual({ ok: true });
  });
});

describe("T8 · precedencia de los pasos 0-3 (decision 12)", () => {
  it.each(NEW_ROUTES.filter((route) => route.access === "write"))(
    "$method $path con key en query y un parametro desconocido → 401 key_in_query (el paso 3 no llega)",
    async ({ method, path }) => {
      const result = await pipeline({ method, path, query: { sellerId: SELLER, key: WRITE_KEY, foo: "1" }, bearer: WRITE_KEY });
      expect(result).toEqual({ step: 2, httpStatus: 401, code: "key_in_query" });
    }
  );

  it("ruta desconocida bajo orders/{id} con key en query → 404 route_not_found (el paso 0 gana)", async () => {
    const result = await pipeline({ method: "POST", path: "/orders/o-1/foo", query: { sellerId: SELLER, key: WRITE_KEY } });
    expect(result).toEqual({ step: 0, httpStatus: 404, code: "route_not_found" });
  });

  it("metodo no admitido en una ruta de escritura con key en query → 405 (el paso 0 gana)", async () => {
    const result = await pipeline({ method: "GET", path: "/orders/o-1/confirm", query: { sellerId: SELLER, key: WRITE_KEY } });
    expect(result).toEqual({ step: 0, httpStatus: 405, code: "method_not_allowed" });
  });

  it("escritura con Bearer valida y un parametro desconocido → 400 unknown_parameter", async () => {
    const result = await pipeline({ method: "PATCH", path: "/orders/o-1", query: { sellerId: SELLER, foo: "1" }, bearer: WRITE_KEY });
    expect(result).toEqual({ step: 3, httpStatus: 400, code: "unknown_parameter" });
  });

  it("escritura con Bearer valida y sin parametros extra → sigue al paso 4", async () => {
    const result = await pipeline({ method: "POST", path: "/orders/o-1/cancel", query: { sellerId: SELLER }, bearer: WRITE_KEY });
    expect(result).toEqual({ step: 4, httpStatus: 200, code: null });
  });
});

describe("T8 · validador de shopifyOrderId (plan 2.10)", () => {
  it.each(["1001", "#1001", "KOV-1001", "a.b_c-1", "x".repeat(64)])("%s es valido", async (value) => {
    const { isValidShopifyOrderId } = await load();
    expect(isValidShopifyOrderId(value)).toBe(true);
  });

  it.each([
    ["vacio", ""],
    ["65 caracteres", "1".repeat(65)],
    ["con espacios", "10 01"],
    ["con /", "10/01"],
    ["no texto", 1001],
    ["undefined", undefined]
  ])("%s es invalido", async (_label, value) => {
    const { isValidShopifyOrderId } = await load();
    expect(isValidShopifyOrderId(value)).toBe(false);
  });
});

describe("T8 · cuerpo de confirmar (decision 13)", () => {
  it.each([
    ["sin cuerpo (undefined)", undefined],
    ["cuerpo vacio", ""],
    ["{}", json({})]
  ])("%s → pasa el paso 3 sin expectedStatus", async (_label, raw) => {
    const { parseConfirmBody } = await load();
    const result = parseConfirmBody(raw);
    expect(result.ok).toBe(true);
    expect(result.expectedStatus).toBeUndefined();
  });

  it("{ expectedStatus: 'imported' } → pasa con expectedStatus", async () => {
    const { parseConfirmBody } = await load();
    expect(parseConfirmBody(json({ expectedStatus: "imported" }))).toEqual({ ok: true, expectedStatus: "imported" });
  });

  it("acepta el cuerpo crudo como Buffer (rawBody de la funcion)", async () => {
    const { parseConfirmBody } = await load();
    expect(parseConfirmBody(Buffer.from(json({ expectedStatus: "imported" })))).toEqual({ ok: true, expectedStatus: "imported" });
  });

  it.each([
    ["{ expectedStatus: 'imported', foo: 1 }", json({ expectedStatus: "imported", foo: 1 })],
    ["{ expectedStatus: 5 }", json({ expectedStatus: 5 })],
    ["{ expectedStatus: null }", json({ expectedStatus: null })],
    ["un array", json([])],
    ["un numero", "5"]
  ])("%s → 400 invalid_body", async (_label, raw) => {
    const { parseConfirmBody } = await load();
    const result = parseConfirmBody(raw);
    expect(result).toMatchObject({ ok: false, httpStatus: 400, code: "invalid_body" });
    expect(result.body).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("JSON roto → 400 invalid_json", async () => {
    const { parseConfirmBody } = await load();
    expect(parseConfirmBody("{expectedStatus:")).toMatchObject({ ok: false, httpStatus: 400, code: "invalid_json" });
  });
});

describe("T8 · parseWriteBody: forma (paso 3)", () => {
  it.each(["order_patch", "order_cancel"])("%s: cuerpo que no es JSON → 400 invalid_json", async (route) => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody(route, "{no es json");
    expect(result).toMatchObject({ ok: false, httpStatus: 400, code: "invalid_json" });
    expect(result.body).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it.each([
    ["order_patch", "un array", json([{ customerName: "Ana" }])],
    ["order_cancel", "un array", json([])],
    ["order_patch", "un numero", "5"],
    ["order_patch", "un texto", json("hola")],
    ["order_cancel", "null", "null"]
  ])("%s: %s → 400 invalid_body", async (route, _label, raw) => {
    const { parseWriteBody } = await load();
    expect(parseWriteBody(route, raw)).toMatchObject({ ok: false, httpStatus: 400, code: "invalid_body" });
  });

  it("PATCH: expectedStatus que no es texto → 400 invalid_body (forma, no campo)", async () => {
    const { parseWriteBody } = await load();
    expect(parseWriteBody("order_patch", json({ expectedStatus: 5, customerName: "Ana" }))).toMatchObject({
      ok: false,
      httpStatus: 400,
      code: "invalid_body"
    });
  });

  it("parseWriteBody nunca devuelve un 422 (el 422 lo responde el nucleo en el paso 6)", async () => {
    const { parseWriteBody } = await load();
    const bodies = [
      "{x",
      json([]),
      json({}),
      json({ totalCop: 1, sku: "A" }),
      json({ customerName: "", customerPhone: "12" }),
      json({ customerName: 5 }),
      json({ reason: "" })
    ];
    for (const route of ["order_patch", "order_cancel"]) {
      for (const raw of bodies) {
        const result = parseWriteBody(route, raw);
        expect(result.httpStatus === undefined || result.httpStatus === 400).toBe(true);
      }
    }
  });
});

describe("T8 · parseWriteBody PATCH: errores de campo calculados sin responder", () => {
  it("{ expectedStatus } no cuenta como campo: sin fieldProblems e input vacio (el nucleo dara no_fields)", async () => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody("order_patch", json({ expectedStatus: "imported" }));
    expect(result).toEqual({ ok: true, input: {}, expectedStatus: "imported", fieldProblems: [] });
  });

  it("sin cuerpo → ok con input vacio y sin problemas", async () => {
    const { parseWriteBody } = await load();
    expect(parseWriteBody("order_patch", undefined)).toEqual({ ok: true, input: {}, expectedStatus: undefined, fieldProblems: [] });
  });

  it("campos validos pasan a input tal cual, sin expectedStatus", async () => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody(
      "order_patch",
      json({ customerPhone: "300 123 4567", addressRaw: "Cra 1 # 2-3", expectedStatus: "address_risk" })
    );
    expect(result).toEqual({
      ok: true,
      input: { customerPhone: "300 123 4567", addressRaw: "Cra 1 # 2-3" },
      expectedStatus: "address_risk",
      fieldProblems: []
    });
  });

  it("totalCop y sku → dos not_allowed, fuera de input", async () => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody("order_patch", json({ totalCop: 50000, sku: "A-1", customerName: "Ana" }));
    expect(sortProblems(problemsOf(result))).toEqual([
      { field: "sku", code: "not_allowed" },
      { field: "totalCop", code: "not_allowed" }
    ]);
    expect(result.input).toEqual({ customerName: "Ana" });
  });

  it.each(["status", "driverId", "paymentMethod", "productName", "quantity", "lineItems"])(
    "%s → not_allowed",
    async (field) => {
      const { parseWriteBody } = await load();
      expect(problemsOf(parseWriteBody("order_patch", json({ [field]: "x" })))).toEqual([{ field, code: "not_allowed" }]);
    }
  );

  it("totalCop y customerName vacio → los dos, cada uno con su motivo", async () => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody("order_patch", json({ totalCop: 1, customerName: "" }));
    expect(sortProblems(problemsOf(result))).toEqual([
      { field: "customerName", code: "empty" },
      { field: "totalCop", code: "not_allowed" }
    ]);
  });

  it("customerName vacio y telefono invalido → empty e invalid_phone", async () => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody("order_patch", json({ customerName: "  ", customerPhone: "12345" }));
    expect(sortProblems(problemsOf(result))).toEqual([
      { field: "customerName", code: "empty" },
      { field: "customerPhone", code: "invalid_phone" }
    ]);
  });

  it.each([
    ["customerName", 5],
    ["customerPhone", 3001234567],
    ["addressRaw", { calle: 1 }],
    ["deliveryNotes", true],
    ["cityId", ["cali"]]
  ])("%s con tipo incorrecto → un solo invalid_type", async (field, value) => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_patch", json({ [field]: value })))).toEqual([{ field, code: "invalid_type" }]);
  });

  it("deliveryNotes: null es un tipo valido y borra: sin problemas y con null en input", async () => {
    const { parseWriteBody } = await load();
    const result = parseWriteBody("order_patch", json({ deliveryNotes: null }));
    expect(result).toEqual({ ok: true, input: { deliveryNotes: null }, expectedStatus: undefined, fieldProblems: [] });
  });

  it.each(["customerName", "customerPhone", "addressRaw", "cityId"])(
    "%s: null es un tipo valido (no invalid_type) y da empty en el contenido",
    async (field) => {
      const { parseWriteBody } = await load();
      expect(problemsOf(parseWriteBody("order_patch", json({ [field]: null })))).toEqual([{ field, code: "empty" }]);
    }
  );

  it("too_long del contenido sale del nucleo (addressRaw de 301)", async () => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_patch", json({ addressRaw: "x".repeat(301) })))).toEqual([
      { field: "addressRaw", code: "too_long" }
    ]);
  });
});

describe("T8 · parseWriteBody cancelar: motivo", () => {
  it("sin motivo → reason required", async () => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_cancel", json({})))).toEqual([{ field: "reason", code: "required" }]);
  });

  it("sin cuerpo → reason required", async () => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_cancel", undefined))).toEqual([{ field: "reason", code: "required" }]);
  });

  it("motivo solo espacios → empty", async () => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_cancel", json({ reason: "   " })))).toEqual([{ field: "reason", code: "empty" }]);
  });

  it.each([1, 500])("motivo de %i caracteres pasa", async (length) => {
    const { parseWriteBody } = await load();
    const reason = "m".repeat(length);
    expect(parseWriteBody("order_cancel", json({ reason, expectedStatus: "imported" }))).toEqual({
      ok: true,
      input: { reason },
      expectedStatus: "imported",
      fieldProblems: []
    });
  });

  it("motivo de 501 caracteres → too_long", async () => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_cancel", json({ reason: "m".repeat(501) })))).toEqual([
      { field: "reason", code: "too_long" }
    ]);
  });

  it("motivo que no es texto → invalid_type", async () => {
    const { parseWriteBody } = await load();
    expect(problemsOf(parseWriteBody("order_cancel", json({ reason: 7 })))).toEqual([{ field: "reason", code: "invalid_type" }]);
  });

  it("clave extra en cancelar → not_allowed, junto al motivo que falta", async () => {
    const { parseWriteBody } = await load();
    expect(sortProblems(problemsOf(parseWriteBody("order_cancel", json({ customerName: "Ana" }))))).toEqual([
      { field: "customerName", code: "not_allowed" },
      { field: "reason", code: "required" }
    ]);
  });
});

describe("T8 · buildFieldError: el 422 del paso 6", () => {
  it("con algun not_allowed → field_not_allowed de primer nivel y todos los campos", async () => {
    const { buildFieldError } = await load();
    const result = buildFieldError([
      { field: "totalCop", code: "not_allowed" },
      { field: "customerName", code: "empty" }
    ]);
    expect(result).toMatchObject({ httpStatus: 422, code: "field_not_allowed" });
    expect(result.body).toMatchObject({ ok: false, code: "field_not_allowed" });
    expect(typeof result.body.message).toBe("string");
    expect(sortProblems(result.body.fields.map(({ field, code }: any) => ({ field, code })))).toEqual([
      { field: "customerName", code: "empty" },
      { field: "totalCop", code: "not_allowed" }
    ]);
    for (const item of result.body.fields) expect(item.message.length).toBeGreaterThan(0);
  });

  it("totalCop y sku → field_not_allowed", async () => {
    const { buildFieldError } = await load();
    expect(
      buildFieldError([
        { field: "totalCop", code: "not_allowed" },
        { field: "sku", code: "not_allowed" }
      ]).code
    ).toBe("field_not_allowed");
  });

  it("sin not_allowed → validation_failed con los dos campos", async () => {
    const { buildFieldError } = await load();
    const result = buildFieldError([
      { field: "customerName", code: "empty" },
      { field: "customerPhone", code: "invalid_phone" }
    ]);
    expect(result).toMatchObject({ httpStatus: 422, code: "validation_failed" });
    expect(result.body.fields).toHaveLength(2);
  });

  it("tipo incorrecto → validation_failed con invalid_type", async () => {
    const { parseWriteBody, buildFieldError } = await load();
    const parsed = parseWriteBody("order_patch", json({ customerName: 5 }));
    const result = buildFieldError(parsed.fieldProblems);
    expect(result.code).toBe("validation_failed");
    expect(result.body.fields.map(({ field, code }: any) => ({ field, code }))).toEqual([
      { field: "customerName", code: "invalid_type" }
    ]);
  });
});

describe("T8 · catalogo de codigos (RNF_02: se agregan, no se renombran)", () => {
  const FROZEN: Record<string, number> = {
    route_not_found: 404,
    unknown_parameter: 400,
    invalid_shopify_order_id: 400,
    invalid_idempotency_key: 400,
    invalid_json: 400,
    invalid_body: 400,
    missing_credentials: 401,
    invalid_key: 401,
    key_in_query: 401,
    read_only_key: 403,
    order_not_found: 404,
    method_not_allowed: 405,
    status_changed: 409,
    order_cancelled: 409,
    address_review_pending: 409,
    order_not_editable: 409,
    validation_failed: 422,
    field_not_allowed: 422,
    out_of_coverage: 422,
    no_fields: 422,
    idempotency_key_reused: 422,
    rate_limited: 429,
    history_not_ready: 503,
    internal_error: 500
  };

  it("el catalogo code → HTTP es exactamente el congelado", async () => {
    const { STORE_API_ERROR_HTTP } = await load();
    expect({ ...STORE_API_ERROR_HTTP }).toEqual(FROZEN);
  });

  it("el catalogo esta congelado en tiempo de ejecucion", async () => {
    const { STORE_API_ERROR_HTTP } = await load();
    expect(Object.isFrozen(STORE_API_ERROR_HTTP)).toBe(true);
  });

  it("read_only_key es el unico 403", async () => {
    const { STORE_API_ERROR_HTTP } = await load();
    expect(Object.entries(STORE_API_ERROR_HTTP).filter(([, http]) => http === 403)).toEqual([["read_only_key", 403]]);
  });

  it.each(Object.keys(FROZEN))("buildErrorBody(%s) → { ok: false, code, message } con mensaje en espanol", async (code) => {
    const { buildErrorBody } = await load();
    const body = buildErrorBody(code);
    expect(body).toEqual({ ok: false, code, message: expect.any(String) });
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("buildErrorBody anade los extras y omite los undefined", async () => {
    const { buildErrorBody } = await load();
    const body = buildErrorBody("order_not_editable", { status: "in_route", hasLeader: true, fields: undefined });
    expect(body).toEqual({ ok: false, code: "order_not_editable", message: expect.any(String), status: "in_route", hasLeader: true });
    expect("fields" in body).toBe(false);
  });
});

describe("T8 · tabla de precedencia (plan 2.1)", () => {
  it("STORE_API_PRECEDENCE ordena los codigos como la decision 12", async () => {
    const { STORE_API_PRECEDENCE } = await load();
    const firstStep = (code: string) =>
      (STORE_API_PRECEDENCE as Array<{ step: string; codes: string[] }>).findIndex((row) => row.codes.includes(code));
    const order = [
      "route_not_found",
      "key_in_query",
      "read_only_key",
      "unknown_parameter",
      "rate_limited",
      "idempotency_key_reused",
      "order_not_found",
      "order_not_editable",
      "validation_failed",
      "status_changed"
    ];
    const indexes = order.map(firstStep);
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("los pasos son 0, 1, 2, 3, 3a, 3b, 4, 5, 6, 7, 8, 9 en ese orden", async () => {
    const { STORE_API_PRECEDENCE } = await load();
    expect((STORE_API_PRECEDENCE as Array<{ step: string }>).map((row) => row.step)).toEqual([
      "0", "1", "2", "3", "3a", "3b", "4", "5", "6", "7", "8", "9"
    ]);
  });
});

describe("T8 · bodyHash canonico", () => {
  it("igual con las claves en otro orden, tambien anidadas", async () => {
    const { bodyHash } = await load();
    const a = bodyHash("PATCH", "/orders/o-1", { customerName: "Ana", extra: { b: 1, a: [1, { y: 2, x: 1 }] } });
    const b = bodyHash("PATCH", "/orders/o-1", { extra: { a: [1, { x: 1, y: 2 }], b: 1 }, customerName: "Ana" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cambia si cambia un valor, el metodo o la ruta", async () => {
    const { bodyHash } = await load();
    const base = bodyHash("POST", "/orders/o-1/cancel", { reason: "x" });
    expect(bodyHash("POST", "/orders/o-1/cancel", { reason: "y" })).not.toBe(base);
    expect(bodyHash("PATCH", "/orders/o-1/cancel", { reason: "x" })).not.toBe(base);
    expect(bodyHash("POST", "/orders/o-2/cancel", { reason: "x" })).not.toBe(base);
  });

  it("el orden de un array si cuenta", async () => {
    const { bodyHash } = await load();
    expect(bodyHash("POST", "/p", { list: [1, 2] })).not.toBe(bodyHash("POST", "/p", { list: [2, 1] }));
  });
});

describe("T8 · limite de tasa (RNF_04)", () => {
  it("STORE_API_WRITES_PER_MINUTE es 120 (la spec pide al menos 60)", async () => {
    const { STORE_API_WRITES_PER_MINUTE } = await load();
    expect(STORE_API_WRITES_PER_MINUTE).toBe(120);
    expect(STORE_API_WRITES_PER_MINUTE).toBeGreaterThanOrEqual(60);
  });

  it.each([
    ["2026-10-05T14:03:00.000Z", "202610051403", 60],
    ["2026-10-05T14:03:30.000Z", "202610051403", 30],
    ["2026-10-05T14:03:59.500Z", "202610051403", 1],
    ["2026-10-05T14:03:59.999Z", "202610051403", 1],
    ["2026-12-31T23:59:58.200Z", "202612312359", 2]
  ])("rateWindow(%s) → bucket %s, Retry-After %i", async (iso, bucketId, retryAfterSeconds) => {
    const { rateWindow } = await load();
    expect(rateWindow(new Date(iso))).toEqual({ bucketId, retryAfterSeconds });
  });

  it("Retry-After nunca baja de 1", async () => {
    const { rateWindow } = await load();
    for (let ms = 0; ms < 60_000; ms += 250) {
      expect(rateWindow(new Date(Date.UTC(2026, 9, 5, 14, 3, 0, 0) + ms)).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});
