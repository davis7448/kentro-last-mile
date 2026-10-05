/**
 * Spec 029 · T3 — credenciales de la Store API y key de escritura (puro).
 *
 * `functions/src/store-api-auth.ts` es puro (sin firebase-admin). Ata:
 *  1. `resolveStoreCredentials`: la tabla del plan 2.3, evaluada EN ORDEN (pasos 1-2 de la precedencia de la
 *     decision 12). En lectura la candidata es `queryKey ?? bearer` (como hoy); en escritura cualquier `key`
 *     por query es 401 `key_in_query` antes de comparar nada. Unico 403: `read_only_key`.
 *  2. Formato de la key de escritura (`kw_` + 45 base64url = 48), su huella (sha256 hex) y `last4`.
 *  3. `planWriteKeyChange`: campos `writeKey*` + evento con `entityId = sellerId`, sin la key, sin tocar
 *     `apiKey` ni `status`; `failed-precondition` al generar con key existente o rotar sin key.
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle con
 * su propio mensaje en vez de tumbar el archivo entero.
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = "../../functions/src/store-api-auth";
const SOURCE_PATH = fileURLToPath(new URL("../../functions/src/store-api-auth.ts", import.meta.url));

async function load() {
  return import(MODULE);
}

const SELLER = "seller-test";
const READ_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6c41e"; // 48 hex, como createStoreApiKey
const WRITE_KEY = "kw_" + "Ab3_-xY9".repeat(5) + "Qz7k9"; // 3 + 45 = 48, alfabeto base64url
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function activeConfig(overrides: Record<string, unknown> = {}) {
  return {
    sellerId: SELLER,
    sellerName: "Tienda de prueba",
    status: "active",
    apiKey: READ_KEY,
    writeKeyHash: sha256(WRITE_KEY),
    writeKeyPrefix: "kw_",
    writeKeyLast4: WRITE_KEY.slice(-4),
    writeKeyCreatedAt: "2026-10-01T10:00:00.000Z",
    writeKeyGeneratedBy: { uid: "u-seller", role: "seller" },
    ...overrides
  };
}

type Route = "legacy_read" | "read" | "write";

async function resolve(input: {
  route: Route;
  querySellerId?: string;
  queryKey?: string;
  bearer?: string;
  config?: Record<string, unknown> | null;
  [extra: string]: unknown;
}) {
  const { resolveStoreCredentials } = await load();
  return resolveStoreCredentials({
    querySellerId: SELLER,
    config: activeConfig(),
    ...input
  });
}

function expectReject(result: any, httpStatus: number, code: string) {
  expect(result.ok).toBe(false);
  expect({ httpStatus: result.httpStatus, code: result.code }).toEqual({ httpStatus, code });
}

describe("T3 · formato, huella y last4 de la key de escritura", () => {
  it("generateWriteKey mide 48 y es kw_ + 45 caracteres base64url", async () => {
    const { generateWriteKey } = await load();
    const key = generateWriteKey();
    expect(key).toMatch(/^kw_[A-Za-z0-9_-]{45}$/);
  });

  it("generateWriteKey no repite key entre llamadas", async () => {
    const { generateWriteKey } = await load();
    const keys = new Set(Array.from({ length: 50 }, () => generateWriteKey()));
    expect(keys.size).toBe(50);
  });

  it("writeKeyFingerprint es sha256 en hex (64 caracteres)", async () => {
    const { writeKeyFingerprint } = await load();
    expect(writeKeyFingerprint(WRITE_KEY)).toBe(sha256(WRITE_KEY));
    expect(writeKeyFingerprint(WRITE_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("last4 son los cuatro ultimos caracteres", async () => {
    const { last4 } = await load();
    expect(last4(WRITE_KEY)).toBe(WRITE_KEY.slice(-4));
  });
});

describe("T3 · fila 1: key por query en ruta de escritura → 401 key_in_query, nunca 403", () => {
  it("key de lectura valida por query", async () => {
    expectReject(await resolve({ route: "write", queryKey: READ_KEY }), 401, "key_in_query");
  });

  it("key de escritura valida por query", async () => {
    expectReject(await resolve({ route: "write", queryKey: WRITE_KEY }), 401, "key_in_query");
  });

  it("key invalida por query", async () => {
    expectReject(await resolve({ route: "write", queryKey: "cualquier-cosa" }), 401, "key_in_query");
  });

  it("key por query con Bearer de escritura valida → sigue siendo 401 key_in_query", async () => {
    expectReject(await resolve({ route: "write", queryKey: READ_KEY, bearer: WRITE_KEY }), 401, "key_in_query");
  });

  it("key de lectura por query con Bearer de lectura valida → 401, no 403", async () => {
    const result = await resolve({ route: "write", queryKey: READ_KEY, bearer: READ_KEY });
    expect(result.httpStatus).not.toBe(403);
    expectReject(result, 401, "key_in_query");
  });

  it("gana tambien sin sellerId (fila 1 antes que fila 3)", async () => {
    expectReject(await resolve({ route: "write", querySellerId: "", queryKey: WRITE_KEY }), 401, "key_in_query");
  });

  it("gana tambien con config inactiva o inexistente", async () => {
    expectReject(await resolve({ route: "write", queryKey: WRITE_KEY, config: null }), 401, "key_in_query");
    expectReject(
      await resolve({ route: "write", queryKey: WRITE_KEY, config: activeConfig({ status: "inactive" }) }),
      401,
      "key_in_query"
    );
  });
});

describe("T3 · fila 2: kw_ por query en ruta de lectura", () => {
  it("lectura nueva → 401 key_in_query", async () => {
    expectReject(await resolve({ route: "read", queryKey: WRITE_KEY }), 401, "key_in_query");
  });

  it("lectura nueva: kw_ invalida por query tambien → 401 key_in_query", async () => {
    expectReject(await resolve({ route: "read", queryKey: "kw_no-es-ninguna" }), 401, "key_in_query");
  });

  it("lectura vieja → 401 invalid_key con la forma de hoy { ok:false, error }", async () => {
    const result = await resolve({ route: "legacy_read", queryKey: WRITE_KEY });
    expectReject(result, 401, "invalid_key");
    expect(result.body).toEqual({ ok: false, error: "invalid_key" });
  });
});

describe("T3 · fila 3: sin sellerId o sin candidata → 401 missing_credentials", () => {
  it("lectura nueva sin key ni Bearer", async () => {
    expectReject(await resolve({ route: "read" }), 401, "missing_credentials");
  });

  it("escritura sin Bearer", async () => {
    expectReject(await resolve({ route: "write" }), 401, "missing_credentials");
  });

  it("escritura sin sellerId", async () => {
    expectReject(await resolve({ route: "write", querySellerId: "", bearer: WRITE_KEY }), 401, "missing_credentials");
  });

  it("lectura vieja conserva la forma de hoy { ok:false, error:'missing_credentials' }", async () => {
    const result = await resolve({ route: "legacy_read", querySellerId: "", queryKey: READ_KEY });
    expectReject(result, 401, "missing_credentials");
    expect(result.body).toMatchObject({ ok: false, error: "missing_credentials" });
    expect(result.body).not.toHaveProperty("code");
  });
});

describe("T3 · fila 4: no coincide, config inexistente o inactiva → 401 invalid_key", () => {
  it("lectura nueva: key de query invalida + Bearer de lectura valida → invalid_key (la Bearer no se evalua)", async () => {
    expectReject(await resolve({ route: "read", queryKey: "f".repeat(48), bearer: READ_KEY }), 401, "invalid_key");
  });

  it("lectura nueva: key de query invalida + Bearer de escritura valida → invalid_key", async () => {
    expectReject(await resolve({ route: "read", queryKey: "f".repeat(48), bearer: WRITE_KEY }), 401, "invalid_key");
  });

  it("lectura vieja: key de query invalida + Bearer de lectura valida → invalid_key con forma vieja", async () => {
    const result = await resolve({ route: "legacy_read", queryKey: "f".repeat(48), bearer: READ_KEY });
    expectReject(result, 401, "invalid_key");
    expect(result.body).toEqual({ ok: false, error: "invalid_key" });
  });

  it("lectura vieja: key de query invalida + Bearer de escritura valida → invalid_key con forma vieja", async () => {
    const result = await resolve({ route: "legacy_read", queryKey: "f".repeat(48), bearer: WRITE_KEY });
    expectReject(result, 401, "invalid_key");
    expect(result.body).toEqual({ ok: false, error: "invalid_key" });
  });

  it("escritura: Bearer que no coincide con ninguna", async () => {
    expectReject(await resolve({ route: "write", bearer: "kw_" + "z".repeat(45) }), 401, "invalid_key");
  });

  it("escritura: config inexistente", async () => {
    expectReject(await resolve({ route: "write", bearer: WRITE_KEY, config: null }), 401, "invalid_key");
  });

  it("status inactivo apaga la key de escritura (escritura por Bearer)", async () => {
    expectReject(
      await resolve({ route: "write", bearer: WRITE_KEY, config: activeConfig({ status: "inactive" }) }),
      401,
      "invalid_key"
    );
  });

  it("status inactivo apaga la key de lectura (lectura nueva por query)", async () => {
    expectReject(
      await resolve({ route: "read", queryKey: READ_KEY, config: activeConfig({ status: "inactive" }) }),
      401,
      "invalid_key"
    );
  });

  it("status inactivo en lectura vieja → invalid_key con forma vieja", async () => {
    const result = await resolve({ route: "legacy_read", queryKey: READ_KEY, config: activeConfig({ status: "inactive" }) });
    expectReject(result, 401, "invalid_key");
    expect(result.body).toEqual({ ok: false, error: "invalid_key" });
  });

  it("tienda sin key de escritura: una kw_ por Bearer es invalid_key", async () => {
    const config = activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined, writeKeyPrefix: undefined });
    expectReject(await resolve({ route: "write", bearer: WRITE_KEY, config }), 401, "invalid_key");
  });
});

describe("T3 · fila 5: key de lectura valida", () => {
  it("lectura nueva por query → pasa como key de lectura", async () => {
    const result = await resolve({ route: "read", queryKey: READ_KEY });
    expect(result).toMatchObject({ ok: true, sellerId: SELLER, keyKind: "read" });
  });

  it("lectura vieja por query → pasa", async () => {
    const result = await resolve({ route: "legacy_read", queryKey: READ_KEY });
    expect(result).toMatchObject({ ok: true, sellerId: SELLER, keyKind: "read" });
  });

  it("lectura por Bearer → pasa", async () => {
    const result = await resolve({ route: "read", bearer: READ_KEY });
    expect(result).toMatchObject({ ok: true, keyKind: "read" });
  });

  it("escritura con key de lectura en la cabecera → 403 read_only_key (unico 403)", async () => {
    expectReject(await resolve({ route: "write", bearer: READ_KEY }), 403, "read_only_key");
  });
});

describe("T3 · fila 6: key de escritura valida por Bearer", () => {
  it("escritura por Bearer → pasa con keyKind write y keyLast4", async () => {
    const result = await resolve({ route: "write", bearer: WRITE_KEY });
    expect(result).toMatchObject({ ok: true, sellerId: SELLER, keyKind: "write", keyLast4: WRITE_KEY.slice(-4) });
  });

  it("lectura nueva por Bearer con key de escritura → pasa", async () => {
    const result = await resolve({ route: "read", bearer: WRITE_KEY });
    expect(result).toMatchObject({ ok: true, keyKind: "write" });
  });

  it("lectura vieja por Bearer con key de escritura → pasa (RF_20)", async () => {
    const result = await resolve({ route: "legacy_read", bearer: WRITE_KEY });
    expect(result).toMatchObject({ ok: true, keyKind: "write" });
  });

  it("escritura con key de escritura y config sin key de lectura → pasa", async () => {
    const result = await resolve({ route: "write", bearer: WRITE_KEY, config: activeConfig({ apiKey: undefined }) });
    expect(result).toMatchObject({ ok: true, keyKind: "write" });
  });
});

describe("T3 · precedencia (decision 12): credenciales antes que parametros", () => {
  it("escritura con key en query y un parametro desconocido → 401 key_in_query, no 400", async () => {
    const result = await resolve({ route: "write", queryKey: WRITE_KEY, bearer: WRITE_KEY, unknownQueryParams: ["foo"] });
    expect(result.httpStatus).not.toBe(400);
    expectReject(result, 401, "key_in_query");
  });

  it("escritura con credenciales invalidas y un parametro desconocido → 401, no 400", async () => {
    const result = await resolve({ route: "write", bearer: "kw_" + "z".repeat(45), unknownQueryParams: ["foo"] });
    expect(result.httpStatus).not.toBe(400);
    expectReject(result, 401, "invalid_key");
  });

  it("el modulo de credenciales nunca responde 400 ni unknown_parameter (eso es del paso 3, T8)", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).not.toMatch(/unknown_parameter/);
    expect(source).not.toMatch(/\b400\b/);
  });
});

describe("T3 · comparacion en tiempo constante (guarda de fuente)", () => {
  it("usa crypto.timingSafeEqual y sha256", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).toMatch(/createHash\(\s*["']sha256["']\s*\)/);
  });

  it("no compara keys ni huellas con === / !== directos", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).not.toMatch(/(apiKey|writeKeyHash|candidate\w*|supplied\w*)\s*[!=]==\s*\w/);
  });

  it("es puro: no importa firebase-admin ni firebase-functions", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).not.toMatch(/from\s+["']firebase-(admin|functions)/);
  });
});

describe("T3 · planWriteKeyChange", () => {
  const NOW = "2026-10-05T12:00:00.000Z";
  const ADMIN = { uid: "u-admin", role: "admin" as const };
  const NEW_KEY = "kw_" + "N".repeat(41) + "w9x2";

  async function plan(input: Record<string, unknown>) {
    const { planWriteKeyChange } = await load();
    return planWriteKeyChange({ sellerId: SELLER, actor: ADMIN, now: NOW, writeKey: NEW_KEY, ...input });
  }

  it("generar sin key previa → campos writeKey* con huella, prefijo, last4, fecha y autor", async () => {
    const config = activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined, writeKeyPrefix: undefined, writeKeyCreatedAt: undefined, writeKeyGeneratedBy: undefined });
    const result = await plan({ config, rotate: false });
    expect(result.ok).toBe(true);
    expect(result.fields).toMatchObject({
      writeKeyHash: sha256(NEW_KEY),
      writeKeyPrefix: "kw_",
      writeKeyLast4: "w9x2",
      writeKeyCreatedAt: NOW,
      writeKeyGeneratedBy: { uid: "u-admin", role: "admin" }
    });
    expect(result.fields).not.toHaveProperty("writeKeyRotatedAt");
  });

  it("generar: evento store_api_key.write_generated con entityId = sellerId", async () => {
    const result = await plan({ config: activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined }), rotate: false });
    expect(result.auditEvent).toMatchObject({
      action: "store_api_key.write_generated",
      entityId: SELLER,
      actorId: "u-admin",
      actorRole: "admin",
      createdAt: NOW,
      newLast4: "w9x2"
    });
  });

  it("rotar con key previa → writeKeyRotatedAt = now, evento write_rotated con last4 anterior y nuevo", async () => {
    const result = await plan({ config: activeConfig(), rotate: true });
    expect(result.ok).toBe(true);
    expect(result.fields).toMatchObject({ writeKeyHash: sha256(NEW_KEY), writeKeyLast4: "w9x2", writeKeyRotatedAt: NOW });
    expect(result.auditEvent).toMatchObject({
      action: "store_api_key.write_rotated",
      entityId: SELLER,
      previousLast4: WRITE_KEY.slice(-4),
      newLast4: "w9x2"
    });
    expect(result.previousLast4).toBe(WRITE_KEY.slice(-4));
  });

  it("no toca apiKey ni status (RF_26)", async () => {
    for (const rotate of [false, true]) {
      const config = rotate ? activeConfig() : activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined });
      const result = await plan({ config, rotate });
      expect(result.ok).toBe(true);
      expect(result.fields).not.toHaveProperty("apiKey");
      expect(result.fields).not.toHaveProperty("status");
      expect(Object.keys(result.fields).every((key: string) => key.startsWith("writeKey"))).toBe(true);
    }
  });

  it("el evento ni los campos contienen la key completa", async () => {
    const result = await plan({ config: activeConfig(), rotate: true });
    expect(JSON.stringify(result.auditEvent)).not.toContain(NEW_KEY);
    expect(JSON.stringify(result.auditEvent)).not.toContain(WRITE_KEY);
    expect(JSON.stringify(result.fields)).not.toContain(NEW_KEY);
  });

  it("sin undefined en campos ni evento (Firestore los rechaza)", async () => {
    const result = await plan({ config: activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined }), rotate: false });
    expect(JSON.stringify(result.fields)).toBe(JSON.stringify(result.fields, (_k, v) => (v === undefined ? "UNDEF" : v)));
    expect(JSON.stringify(result.auditEvent)).toBe(JSON.stringify(result.auditEvent, (_k, v) => (v === undefined ? "UNDEF" : v)));
  });

  it("generar con key existente → failed-precondition (doble clic en Generar)", async () => {
    const result = await plan({ config: activeConfig(), rotate: false });
    expect(result).toMatchObject({ ok: false, code: "failed-precondition" });
  });

  it("rotar sin key → failed-precondition", async () => {
    const result = await plan({ config: activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined }), rotate: true });
    expect(result).toMatchObject({ ok: false, code: "failed-precondition" });
  });

  it("rotar con config inexistente → failed-precondition", async () => {
    const result = await plan({ config: null, rotate: true });
    expect(result).toMatchObject({ ok: false, code: "failed-precondition" });
  });

  it("generar con config inexistente → pasa, entityId = sellerId de la entrada", async () => {
    const result = await plan({ config: null, rotate: false });
    expect(result.ok).toBe(true);
    expect(result.auditEvent.entityId).toBe(SELLER);
    expect(result.previousLast4).toBeNull();
  });
});

describe("T17 · toStoreApiKeyStatus: lo que se muestra de las keys (RF_25)", () => {
  /*
   * Contrato (T17). Vive en `functions/src/store-api-keys.ts` (el modulo de las tres callables), porque
   * `store-api-auth.ts` no esta en el alcance de T17. Es pura y el modulo NO puede llamar a `getFirestore()`,
   * `getAuth()` ni `initializeApp()` al cargarse (solo dentro de las callables): la prueba lo importa.
   *
   *   toStoreApiKeyStatus({
   *     sellerId: string,
   *     sellerName?: string,                       // si falta: config.sellerName, y si no, sellerId
   *     config: StoreApiConfigLike | null | undefined,
   *     viewerRole: "admin" | "seller" | "seller_logistics",
   *     adminNames?: Record<string, string>,       // uid → nombre; solo se consulta si viewerRole = "admin"
   *   }) → StoreApiKeyStatus (plan 4.2):
   *     { sellerId, sellerName,
   *       read:  { exists: boolean, status: "active" | "inactive" | "none" },
   *       write: { exists: false } | { exists: true, last4, generatedAt, generatedByLabel },
   *       canManageWrite: boolean }
   *
   * - read.exists = hay `apiKey` (texto no vacio). Sin `apiKey` → status "none"; con ella, "active" si
   *   config.status === "active" y si no "inactive".
   * - write.exists = hay `writeKeyHash` (texto no vacio). generatedAt = writeKeyRotatedAt ?? writeKeyCreatedAt.
   * - generatedByLabel segun `writeKeyGeneratedBy.role` y quien pregunta:
   *     tienda (seller / seller_logistics): role "seller" → "Tu tienda"; role "admin" → "Kentro" (nunca el nombre).
   *     admin: role "seller" → "por la tienda"; role "admin" → "por <nombre>" (adminNames[uid]); si el
   *     nombre no se resolvio, "por <uid>" (mismo respaldo que el historial).
   * - canManageWrite: true para admin y seller, false para seller_logistics.
   */
  const MODULE_KEYS = "../../functions/src/store-api-keys";
  const CREATED = "2026-10-01T10:00:00.000Z";
  const ROTATED = "2026-10-04T08:30:00.000Z";

  async function status(input: Record<string, unknown>) {
    const { toStoreApiKeyStatus } = await import(MODULE_KEYS);
    return toStoreApiKeyStatus({ sellerId: SELLER, viewerRole: "seller", ...input });
  }

  it("write trae exactamente exists, last4, generatedAt y generatedByLabel (sin prefix, rotatedAt, createdAt)", async () => {
    const result = await status({ config: activeConfig({ writeKeyRotatedAt: ROTATED }) });
    expect(Object.keys(result.write).sort()).toEqual(["exists", "generatedAt", "generatedByLabel", "last4"]);
    expect(result.write).toEqual({
      exists: true,
      last4: WRITE_KEY.slice(-4),
      generatedAt: ROTATED,
      generatedByLabel: "Tu tienda"
    });
  });

  it("forma de primer nivel: sellerId, sellerName, read, write, canManageWrite y nada mas", async () => {
    const result = await status({ config: activeConfig() });
    expect(Object.keys(result).sort()).toEqual(["canManageWrite", "read", "sellerId", "sellerName", "write"]);
    expect(result.sellerId).toBe(SELLER);
    expect(result.sellerName).toBe("Tienda de prueba");
  });

  it("sellerName explicito gana a config.sellerName; sin ninguno, el sellerId", async () => {
    expect((await status({ config: activeConfig(), sellerName: "Kovia" })).sellerName).toBe("Kovia");
    expect((await status({ config: null })).sellerName).toBe(SELLER);
  });

  it("generatedAt = fecha de rotacion si la hubo", async () => {
    const result = await status({ config: activeConfig({ writeKeyCreatedAt: CREATED, writeKeyRotatedAt: ROTATED }) });
    expect(result.write.generatedAt).toBe(ROTATED);
  });

  it("generatedAt = fecha de generacion si nunca se roto", async () => {
    const result = await status({ config: activeConfig({ writeKeyCreatedAt: CREATED }) });
    expect(result.write.generatedAt).toBe(CREATED);
  });

  it("sin writeKeyHash → write = { exists: false } y nada mas", async () => {
    const config = activeConfig({ writeKeyHash: undefined, writeKeyLast4: undefined, writeKeyPrefix: undefined, writeKeyCreatedAt: undefined, writeKeyGeneratedBy: undefined });
    expect((await status({ config })).write).toEqual({ exists: false });
  });

  it("config inexistente → read none, write { exists: false }", async () => {
    const result = await status({ config: null });
    expect(result.read).toEqual({ exists: false, status: "none" });
    expect(result.write).toEqual({ exists: false });
  });

  it("read: activa, inactiva y sin key de lectura (config creada al generar la de escritura)", async () => {
    expect((await status({ config: activeConfig() })).read).toEqual({ exists: true, status: "active" });
    expect((await status({ config: activeConfig({ status: "disabled" }) })).read).toEqual({ exists: true, status: "inactive" });
    expect((await status({ config: activeConfig({ apiKey: undefined }) })).read).toEqual({ exists: false, status: "none" });
  });

  describe("generatedByLabel para la tienda (nunca el nombre de un admin)", () => {
    for (const viewerRole of ["seller", "seller_logistics"] as const) {
      it(`${viewerRole}: generada por la tienda → "Tu tienda"`, async () => {
        const result = await status({ viewerRole, config: activeConfig({ writeKeyGeneratedBy: { uid: "u-seller", role: "seller" } }) });
        expect(result.write.generatedByLabel).toBe("Tu tienda");
      });

      it(`${viewerRole}: generada por un admin → "Kentro", aunque se pase su nombre`, async () => {
        const result = await status({
          viewerRole,
          config: activeConfig({ writeKeyGeneratedBy: { uid: "u-admin", role: "admin" } }),
          adminNames: { "u-admin": "Laura Gomez" }
        });
        expect(result.write.generatedByLabel).toBe("Kentro");
        expect(JSON.stringify(result)).not.toContain("Laura");
        expect(JSON.stringify(result)).not.toContain("u-admin");
      });
    }
  });

  describe("generatedByLabel para el admin", () => {
    it('generada por la tienda → "por la tienda"', async () => {
      const result = await status({ viewerRole: "admin", config: activeConfig({ writeKeyGeneratedBy: { uid: "u-seller", role: "seller" } }) });
      expect(result.write.generatedByLabel).toBe("por la tienda");
    });

    it('generada por un admin → "por <nombre del admin>"', async () => {
      const result = await status({
        viewerRole: "admin",
        config: activeConfig({ writeKeyGeneratedBy: { uid: "u-admin", role: "admin" } }),
        adminNames: { "u-admin": "Laura Gomez" }
      });
      expect(result.write.generatedByLabel).toBe("por Laura Gomez");
    });

    it('admin sin nombre resuelto → "por <uid>"', async () => {
      const result = await status({ viewerRole: "admin", config: activeConfig({ writeKeyGeneratedBy: { uid: "u-admin", role: "admin" } }) });
      expect(result.write.generatedByLabel).toBe("por u-admin");
    });
  });

  it("canManageWrite: admin y seller si, seller_logistics no", async () => {
    expect((await status({ viewerRole: "admin", config: activeConfig() })).canManageWrite).toBe(true);
    expect((await status({ viewerRole: "seller", config: activeConfig() })).canManageWrite).toBe(true);
    expect((await status({ viewerRole: "seller_logistics", config: activeConfig() })).canManageWrite).toBe(false);
  });

  it("nunca la key de lectura, la de escritura, la huella ni el prefijo, para ningun rol", async () => {
    for (const viewerRole of ["admin", "seller", "seller_logistics"] as const) {
      const json = JSON.stringify(await status({ viewerRole, config: activeConfig({ writeKeyRotatedAt: ROTATED }), adminNames: {} }));
      expect(json).not.toContain(READ_KEY);
      expect(json).not.toContain(WRITE_KEY);
      expect(json).not.toContain(sha256(WRITE_KEY));
      expect(json).not.toContain("kw_");
      expect(json).not.toMatch(/apiKey|writeKeyHash|writeKeyPrefix|prefix|rotatedAt|createdAt/);
    }
  });

  it("sin undefined en la salida (va por una callable)", async () => {
    const result = await status({ config: activeConfig({ apiKey: undefined, writeKeyHash: undefined }) });
    expect(JSON.stringify(result)).toBe(JSON.stringify(result, (_k, v) => (v === undefined ? "UNDEF" : v)));
  });
});
