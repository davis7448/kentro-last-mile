/**
 * Spec 029 — handler de la Store API con un `db` falso en memoria (T10, T11, T13: un bloque por tarea).
 *
 * Contrato que fijan estas pruebas (T10):
 *
 *   // functions/src/store-api.ts
 *   export async function handleStoreApiRequest(
 *     request: { method: string; path: string; query: Record<string, unknown>; get(name: string): string | undefined;
 *                headers?: Record<string, unknown>; body?: unknown; rawBody?: Buffer },
 *     response: { status(code: number): response; json(body: unknown): unknown; set(name: string, value: string): response },
 *     deps: { db: Firestore; now?: () => Date }
 *   ): Promise<void>;
 *   export const storeApi = onRequest((req, res) => handleStoreApiRequest(req, res, { db: getFirestore() }));
 *
 * Por que en `store-api.ts` y no en `store-api-write.ts`: las rutas viejas (`/resumen`, `/kpis`, `/settlements`,
 * `/orders` sin filtro) bajan la tienda entera (`where("sellerId","==",s)` sola y `collection("settlements").get()`),
 * y la guarda de RNF_05 (T10) prohibe justo eso en `store-api-write.ts`. El handler despacha: rutas viejas en
 * `store-api.ts`; `GET /orders/{id}` y el filtro `shopifyOrderId` (carga dirigida, plan 2.10) en `store-api-write.ts`.
 * `store-api.ts` se puede cargar desde la raiz: Vite resuelve `firebase-admin`/`firebase-functions` desde
 * `functions/node_modules`, y `onRequest` no toca la red al cargar el modulo.
 *
 * El `db` falso implementa solo lo que usa el handler de Firestore Admin: `collection(name)` con `.doc(id)`,
 * `.where(field, op, value)` encadenable (`==`, `in`, `array-contains`), `.limit(n)` y `.get()`; `doc.get()`;
 * `db.getAll(...refs)`. Cualquier otro operador o una escritura lanzan: T10 solo lee. Registra cada lectura para
 * comprobar la carga dirigida (RNF_05) y que un 400 no consulta pedidos.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateWriteKey, last4, writeKeyFingerprint } from "../../functions/src/store-api-auth";

const STORE_API_MODULE = "../../functions/src/store-api";

type Handler = (request: FakeRequest, response: FakeResponse, deps: { db: FakeDb; now?: () => Date }) => Promise<void>;

async function loadHandler(): Promise<Handler> {
  const mod = (await import(STORE_API_MODULE)) as Record<string, unknown>;
  const handler = mod.handleStoreApiRequest;
  if (typeof handler !== "function") {
    throw new Error("functions/src/store-api.ts no exporta handleStoreApiRequest(request, response, { db, now })");
  }
  return handler as Handler;
}

// ---------------------------------------------------------------------------------------------------
// Firestore falso (solo lectura)
// ---------------------------------------------------------------------------------------------------

type Data = Record<string, unknown>;
type Filter = [string, string, unknown];
type ReadLog =
  | { kind: "doc"; collection: string; id: string }
  | { kind: "query"; collection: string; filters: Filter[]; limit?: number };

class FakeDb {
  docs = new Map<string, Data>();
  reads: ReadLog[] = [];

  seed(collection: string, id: string, data: Data) {
    this.docs.set(`${collection}/${id}`, structuredClone(data));
  }

  private snapshot(collection: string, id: string) {
    const data = this.docs.get(`${collection}/${id}`);
    const ref = this.docRef(collection, id);
    return {
      id,
      ref,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : structuredClone(data)),
      get: (field: string) => (data === undefined ? undefined : structuredClone(data[field]))
    };
  }

  private docRef(collection: string, id: string) {
    const refuse = () => {
      throw new Error(`T10 solo lee: escritura en ${collection}/${id}`);
    };
    return {
      id,
      path: `${collection}/${id}`,
      parent: { id: collection },
      __collection: collection,
      get: async () => {
        this.reads.push({ kind: "doc", collection, id });
        return this.snapshot(collection, id);
      },
      set: refuse,
      update: refuse,
      delete: refuse,
      create: refuse
    };
  }

  private matches(data: Data, [field, op, value]: Filter): boolean {
    const actual = data[field];
    if (op === "==") return actual === value;
    if (op === "in") return Array.isArray(value) && value.some((item) => item === actual);
    if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
    throw new Error(`Operador no soportado por el db falso: ${op}`);
  }

  private query(collection: string, filters: Filter[], limitCount?: number): unknown {
    return {
      where: (field: string, op: string, value: unknown) => this.query(collection, [...filters, [field, op, value]], limitCount),
      limit: (count: number) => this.query(collection, filters, count),
      get: async () => {
        this.reads.push({ kind: "query", collection, filters, ...(limitCount === undefined ? {} : { limit: limitCount }) });
        const docs = [...this.docs.entries()]
          .filter(([path]) => path.startsWith(`${collection}/`))
          .map(([path]) => path.slice(collection.length + 1))
          .filter((id) => filters.every((filter) => this.matches(this.docs.get(`${collection}/${id}`) as Data, filter)))
          .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
          .map((id) => this.snapshot(collection, id));
        return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn: (doc: unknown) => void) => docs.forEach(fn) };
      }
    };
  }

  collection(name: string) {
    const base = this.query(name, []) as Record<string, unknown>;
    return { ...base, id: name, doc: (id: string) => this.docRef(name, id) };
  }

  async getAll(...refs: Array<{ id: string; __collection: string }>) {
    return refs.map((ref) => {
      this.reads.push({ kind: "doc", collection: ref.__collection, id: ref.id });
      return this.snapshot(ref.__collection, ref.id);
    });
  }

  runTransaction(): never {
    throw new Error("T10 solo lee: runTransaction");
  }

  batch(): never {
    throw new Error("T10 solo lee: batch");
  }
}

// ---------------------------------------------------------------------------------------------------
// req / res falsos (lo que usa el handler de Express)
// ---------------------------------------------------------------------------------------------------

type FakeRequest = {
  method: string;
  path: string;
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  get(name: string): string | undefined;
  header(name: string): string | undefined;
  body?: unknown;
  rawBody?: Buffer;
};

type FakeResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  send(body: unknown): FakeResponse;
  set(name: string, value: string): FakeResponse;
  setHeader(name: string, value: string): FakeResponse;
  end(): FakeResponse;
};

function makeRequest(options: { method?: string; path: string; query?: Record<string, string>; bearer?: string }): FakeRequest {
  const headers: Record<string, string> = {};
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
  const lookup = (name: string) => headers[name.toLowerCase()];
  const search = new URLSearchParams(options.query ?? {}).toString();
  return {
    method: options.method ?? "GET",
    path: options.path,
    url: `${options.path}${search ? `?${search}` : ""}`,
    query: { ...(options.query ?? {}) },
    headers,
    get: lookup,
    header: lookup
  };
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(body) {
      response.body = body;
      return response;
    },
    send(body) {
      response.body = body;
      return response;
    },
    set(name, value) {
      response.headers[name.toLowerCase()] = value;
      return response;
    },
    setHeader(name, value) {
      response.headers[name.toLowerCase()] = value;
      return response;
    },
    end() {
      return response;
    }
  };
  return response;
}

// ---------------------------------------------------------------------------------------------------
// Fixtures: la tienda del db falso hace de tienda de pruebas (unico sitio, junto con T27, con key de escritura)
// ---------------------------------------------------------------------------------------------------

const NOW = "2026-10-05T15:00:00.000Z";
const SELLER = "seller-test-029";
const OTHER_SELLER = "seller-ajeno";
const READ_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const OTHER_READ_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa9988";
const WRITE_KEY = generateWriteKey();

function seededDb(): FakeDb {
  const db = new FakeDb();
  db.seed("storeApiConfigs", SELLER, {
    id: SELLER,
    sellerId: SELLER,
    sellerName: "Tienda de pruebas 029",
    apiKey: READ_KEY,
    status: "active",
    writeKeyHash: writeKeyFingerprint(WRITE_KEY),
    writeKeyPrefix: "kw_",
    writeKeyLast4: last4(WRITE_KEY)
  });
  db.seed("storeApiConfigs", OTHER_SELLER, {
    id: OTHER_SELLER,
    sellerId: OTHER_SELLER,
    sellerName: "Tienda ajena",
    apiKey: OTHER_READ_KEY,
    status: "active"
  });

  // Dos pedidos propios con el mismo numero de Shopify, uno propio con otro numero, y ajenos.
  db.seed("orders", "o-1", {
    sellerId: SELLER, shopifyOrderId: "1001", trackingCode: "KNT-000001", status: "delivered", paymentMethod: "cod",
    totalCop: 80000, customerName: "Ana Prueba", zoneId: "z1", driverId: "d1",
    createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z"
  });
  db.seed("orders", "o-2", {
    sellerId: SELLER, shopifyOrderId: "1001", trackingCode: "KNT-000002", status: "imported", paymentMethod: "cod",
    totalCop: 50000, customerName: "Ana Prueba", zoneId: "z1", driverId: null,
    createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z"
  });
  db.seed("orders", "o-3", {
    sellerId: SELLER, shopifyOrderId: "1002", trackingCode: "KNT-000003", status: "ready_to_assign", paymentMethod: "prepaid",
    totalCop: 60000, customerName: "Beto Prueba", zoneId: "z1", driverId: null,
    createdAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:00:00.000Z"
  });
  db.seed("orders", "o-x", {
    sellerId: OTHER_SELLER, shopifyOrderId: "1001", trackingCode: "KNT-000099", status: "delivered", paymentMethod: "cod",
    totalCop: 99000, customerName: "Cliente ajeno", zoneId: "z1", driverId: "d1",
    createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z"
  });
  db.seed("orders", "o-y", {
    sellerId: OTHER_SELLER, shopifyOrderId: "7777", trackingCode: "KNT-000098", status: "imported", paymentMethod: "cod",
    totalCop: 10000, customerName: "Cliente ajeno", zoneId: "z1", driverId: null,
    createdAt: "2026-09-03T10:00:00.000Z", updatedAt: "2026-09-03T10:00:00.000Z"
  });

  // Asientos: de la tienda (liquidados y abiertos), de un domiciliario y de la tienda ajena.
  db.seed("walletEntries", "w-1", { ownerType: "seller", ownerId: SELLER, orderId: "o-1", type: "cod_revenue", amountCop: 80000, settlementId: "st-seller-1", createdAt: "2026-09-02T10:00:00.000Z" });
  db.seed("walletEntries", "w-2", { ownerType: "seller", ownerId: SELLER, orderId: "o-1", type: "delivery_fee", amountCop: -13500, settlementId: "st-seller-1", createdAt: "2026-09-02T10:00:00.000Z" });
  db.seed("walletEntries", "w-3", { ownerType: "seller", ownerId: SELLER, orderId: "o-1", type: "product_cost", amountCop: -20000, createdAt: "2026-09-02T10:00:00.000Z" });
  db.seed("walletEntries", "w-4", { ownerType: "driver", ownerId: "d1", orderId: "o-1", type: "delivery_fee", amountCop: 6000, createdAt: "2026-09-02T10:00:00.000Z" });
  db.seed("walletEntries", "w-5", { ownerType: "seller", ownerId: OTHER_SELLER, orderId: "o-x", type: "cod_revenue", amountCop: 99000, createdAt: "2026-09-02T10:00:00.000Z" });

  // Cortes: el de la tienda, uno de domiciliario que cubre su pedido y uno ajeno.
  db.seed("settlements", "st-seller-1", { kind: "seller", ownerId: SELLER, status: "paid", orderIds: ["o-1"], netCop: 66500, createdAt: "2026-09-05T10:00:00.000Z", paidAt: "2026-09-06T10:00:00.000Z" });
  db.seed("settlements", "st-driver-1", { kind: "driver", ownerId: "d1", status: "paid", orderIds: ["o-1", "o-x"], netCop: 0, createdAt: "2026-09-03T10:00:00.000Z" });
  db.seed("settlements", "st-other-1", { kind: "seller", ownerId: OTHER_SELLER, status: "pending", orderIds: ["o-x"], netCop: 99000, createdAt: "2026-09-05T10:00:00.000Z" });

  db.seed("settings", "global", {});
  db.seed("zones", "z1", { id: "z1", name: "Cali" });
  return db;
}

async function call(
  db: FakeDb,
  options: { method?: string; path: string; query?: Record<string, string>; bearer?: string }
): Promise<FakeResponse> {
  const handler = await loadHandler();
  const response = makeResponse();
  await handler(makeRequest(options), response, { db, now: () => new Date(NOW) });
  return response;
}

type OrdersBody = { ok: boolean; total: number; pedidos: Array<Record<string, unknown> & { id: string }> };

function ids(response: FakeResponse): string[] {
  return ((response.body as OrdersBody).pedidos ?? []).map((pedido) => pedido.id).sort();
}

/** Ninguna lectura baja la tienda entera ni una coleccion completa (RNF_05, plan 2.10). */
function expectTargetedReads(db: FakeDb) {
  for (const read of db.reads) {
    if (read.kind !== "query") continue;
    expect(read.filters.length, `consulta sin filtro sobre ${read.collection}`).toBeGreaterThan(0);
    const onlySeller = read.filters.length === 1 && read.filters[0][0] === "sellerId";
    expect(onlySeller, `consulta de ${read.collection} acotada solo por sellerId`).toBe(false);
    const onlyOwner = read.filters.every(([field]) => field === "ownerType" || field === "ownerId");
    expect(onlyOwner, `asientos de la tienda entera en ${read.collection}`).toBe(false);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("T10 · autenticacion de todas las rutas, GET /orders/{id} y filtro shopifyOrderId", () => {
  describe("rutas viejas con resolveStoreCredentials (RF_20, RNF_01)", () => {
    it.each(["/resumen", "/orders"])("%s: una key kw_ por query → 401 { ok:false, error:'invalid_key' } sin code", async (path) => {
      const response = await call(seededDb(), { path, query: { sellerId: SELLER, key: WRITE_KEY } });
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ ok: false, error: "invalid_key" });
    });

    it.each(["/resumen", "/orders"])("%s: con la key de lectura por query → 200 como hoy", async (path) => {
      const response = await call(seededDb(), { path, query: { sellerId: SELLER, key: READ_KEY } });
      expect(response.statusCode).toBe(200);
      expect((response.body as { ok: boolean }).ok).toBe(true);
    });

    it.each(["/resumen", "/orders"])(
      "%s: con la key de escritura por Bearer → 200 y la misma respuesta, por valor, que con la key de lectura",
      async (path) => {
        const withRead = await call(seededDb(), { path, query: { sellerId: SELLER, key: READ_KEY } });
        const withWrite = await call(seededDb(), { path, query: { sellerId: SELLER }, bearer: WRITE_KEY });
        expect(withWrite.statusCode).toBe(200);
        expect(withWrite.body).toEqual(withRead.body);
      }
    );

    it.each(["/resumen", "/orders"])("%s: key de query invalida y Bearer valida → 401 invalid_key como hoy", async (path) => {
      const response = await call(seededDb(), {
        path,
        query: { sellerId: SELLER, key: "clave-que-no-es" },
        bearer: READ_KEY
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ ok: false, error: "invalid_key" });
    });
  });

  describe("RF_02 · GET /orders?shopifyOrderId=", () => {
    it("devuelve solo los pedidos de la tienda de la key con ese numero", async () => {
      const response = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001" } });
      expect(response.statusCode).toBe(200);
      expect(ids(response)).toEqual(["o-1", "o-2"]);
      expect((response.body as OrdersBody).total).toBe(2);
    });

    it("ignora from/to aunque excluyan la fecha del pedido", async () => {
      const response = await call(seededDb(), {
        path: "/orders",
        query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001", from: "2026-10-01", to: "2026-10-02" }
      });
      expect(response.statusCode).toBe(200);
      expect(ids(response)).toEqual(["o-1", "o-2"]);
    });

    it("aplica status: si no coincide, lista vacia", async () => {
      const response = await call(seededDb(), {
        path: "/orders",
        query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001", status: "cancelled" }
      });
      expect(response.statusCode).toBe(200);
      expect(ids(response)).toEqual([]);
    });

    it("aplica status: si coincide, solo los de ese estado", async () => {
      const response = await call(seededDb(), {
        path: "/orders",
        query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001", status: "delivered" }
      });
      expect(ids(response)).toEqual(["o-1"]);
    });

    it("aplica limit: dos pedidos con el mismo numero y limit=1 → uno", async () => {
      const response = await call(seededDb(), {
        path: "/orders",
        query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001", limit: "1" }
      });
      expect(response.statusCode).toBe(200);
      expect((response.body as OrdersBody).pedidos).toHaveLength(1);
      expect((response.body as OrdersBody).total).toBe(1);
    });

    it("el mismo numero en otra tienda no aparece", async () => {
      const response = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001" } });
      expect(ids(response)).not.toContain("o-x");
    });

    it("un numero que solo existe en otra tienda → 200 con lista vacia", async () => {
      const response = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "7777" } });
      expect(response.statusCode).toBe(200);
      expect(ids(response)).toEqual([]);
      expect((response.body as OrdersBody).total).toBe(0);
    });

    it("cada pedido lleva la misma forma que en GET /orders sin filtro", async () => {
      const filtered = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1002" } });
      const full = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY } });
      const fromFull = (full.body as OrdersBody).pedidos.find((pedido) => pedido.id === "o-3");
      expect((filtered.body as OrdersBody).pedidos[0]).toEqual(fromFull);
    });

    it("con la key de escritura por Bearer tambien filtra (RF_20)", async () => {
      const response = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, shopifyOrderId: "1001" }, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(200);
      expect(ids(response)).toEqual(["o-1", "o-2"]);
    });

    it("la consulta va acotada a sellerId + shopifyOrderId: no baja la tienda entera (RNF_05)", async () => {
      const db = seededDb();
      await call(db, { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "1001" } });
      const orderQueries = db.reads.filter((read) => read.kind === "query" && read.collection === "orders");
      expect(orderQueries.length).toBeGreaterThan(0);
      for (const read of orderQueries) {
        if (read.kind !== "query") continue;
        const fields = read.filters.map(([field]) => field).sort();
        expect(fields).toEqual(["sellerId", "shopifyOrderId"]);
        expect(read.filters).toContainEqual(["sellerId", "==", SELLER]);
      }
      expectTargetedReads(db);
    });

    it.each(["10 01", "a".repeat(65), "1001;drop", "ñ1001"])(
      "shopifyOrderId invalido (%s) → 400 con la forma vieja, sin code ni message, y sin consultar pedidos",
      async (value) => {
        const db = seededDb();
        const response = await call(db, { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: value } });
        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({ ok: false, error: "invalid_shopify_order_id" });
        expect(db.reads.filter((read) => read.collection === "orders")).toEqual([]);
      }
    );

    it("shopifyOrderId vacio → 400 invalid_shopify_order_id", async () => {
      const response = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY, shopifyOrderId: "" } });
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ ok: false, error: "invalid_shopify_order_id" });
    });

    it("credenciales malas con shopifyOrderId invalido → 401 (credenciales antes que parametros)", async () => {
      const response = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: "mala", shopifyOrderId: "10 01" } });
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ ok: false, error: "invalid_key" });
    });
  });

  describe("RF_01 / RNF_01 · GET /orders/{id}", () => {
    it("devuelve 200 { ok:true, pedido } igual, por valor, a su elemento de GET /orders", async () => {
      const single = await call(seededDb(), { path: "/orders/o-1", query: { sellerId: SELLER, key: READ_KEY } });
      const list = await call(seededDb(), { path: "/orders", query: { sellerId: SELLER, key: READ_KEY } });
      const fromList = (list.body as OrdersBody).pedidos.find((pedido) => pedido.id === "o-1");
      expect(single.statusCode).toBe(200);
      expect(fromList).toBeDefined();
      expect(single.body).toEqual({ ok: true, pedido: fromList });
    });

    it("el pedido de la fixture no es trivial: tiene movimientos y cortes", async () => {
      const single = await call(seededDb(), { path: "/orders/o-1", query: { sellerId: SELLER, key: READ_KEY } });
      const pago = (single.body as { pedido: { pago: { movimientos: number; settlementIds: string[] } } }).pedido.pago;
      expect(pago.movimientos).toBe(3);
      expect(pago.settlementIds).toEqual(["st-seller-1"]);
    });

    it("con prefijo /storeApi en la ruta responde igual", async () => {
      const plain = await call(seededDb(), { path: "/orders/o-3", query: { sellerId: SELLER, key: READ_KEY } });
      const prefixed = await call(seededDb(), { path: "/storeApi/orders/o-3", query: { sellerId: SELLER, key: READ_KEY } });
      expect(prefixed.statusCode).toBe(200);
      expect(prefixed.body).toEqual(plain.body);
    });

    it("con la key de escritura por Bearer → 200 (RF_20)", async () => {
      const response = await call(seededDb(), { path: "/orders/o-1", query: { sellerId: SELLER }, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(200);
      expect((response.body as { pedido: { id: string } }).pedido.id).toBe("o-1");
    });

    it("una kw_ por query en la ruta nueva → 401 key_in_query con la forma nueva", async () => {
      const response = await call(seededDb(), { path: "/orders/o-1", query: { sellerId: SELLER, key: WRITE_KEY } });
      expect(response.statusCode).toBe(401);
      expect(response.body).toMatchObject({ ok: false, code: "key_in_query" });
    });

    it("pedido de otra tienda y pedido inexistente → 404 order_not_found con cuerpo identico", async () => {
      const foreign = await call(seededDb(), { path: "/orders/o-x", query: { sellerId: SELLER, key: READ_KEY } });
      const missing = await call(seededDb(), { path: "/orders/no-existe", query: { sellerId: SELLER, key: READ_KEY } });
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(foreign.body).toMatchObject({ ok: false, code: "order_not_found" });
      expect(foreign.body).toEqual(missing.body);
      expect(foreign.headers).toEqual(missing.headers);
    });

    it("el 404 de un pedido ajeno no revela nada de el", async () => {
      const foreign = await call(seededDb(), { path: "/orders/o-x", query: { sellerId: SELLER, key: READ_KEY } });
      const text = JSON.stringify(foreign.body);
      for (const leaked of ["o-x", "KNT-000099", "Cliente ajeno", "delivered", OTHER_SELLER]) expect(text).not.toContain(leaked);
    });

    it("parametro desconocido con un pedido inexistente → 400 unknown_parameter (paso 3 antes que el 404)", async () => {
      const response = await call(seededDb(), { path: "/orders/no-existe", query: { sellerId: SELLER, key: READ_KEY, foo: "1" } });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "unknown_parameter" });
    });

    it("la carga es dirigida: no baja la tienda, los asientos de la tienda ni todos los cortes (RNF_05)", async () => {
      const db = seededDb();
      const response = await call(db, { path: "/orders/o-1", query: { sellerId: SELLER, key: READ_KEY } });
      expect(response.statusCode).toBe(200);
      expectTargetedReads(db);
      expect(db.reads).toContainEqual({ kind: "doc", collection: "orders", id: "o-1" });
    });
  });
});

// =====================================================================================================
// T11 · rutas de escritura
// =====================================================================================================
/*
 * Contrato que fijan estas pruebas (T11):
 *
 *   // functions/src/store-api-write.ts
 *   export function mapRejectionToResponse(
 *     rejection: SellerActionRejection,
 *     options?: { activeCities?: Array<{ id: string; name: string } & Record<string, unknown>> }
 *   ): StoreApiReply;   // { httpStatus, body }, puro
 *     - order_not_found → 404, cuerpo === buildErrorBody("order_not_found") (el mismo del GET).
 *     - order_cancelled / address_review_pending / status_changed → 409 con `status`.
 *     - order_not_editable → 409 con `status` y `hasLeader`.
 *     - field_not_allowed / validation_failed → 422, cuerpo === buildFieldError(fields).body.
 *     - no_fields → 422.
 *     - out_of_coverage → 422 con `fields: [{ field: "cityId", code: "out_of_coverage", message }]` y, si se
 *       pasan, `activeCities` reducidas a `{ id, name }` y ordenadas por `name`; sin `options.activeCities`
 *       la clave no aparece.
 *     - panel_precondition (imposible con politica api) → 500 internal_error, sin filtrar el mensaje del panel.
 *
 *   // functions/src/store-api.ts
 *   deps de handleStoreApiRequest: { db; now?: () => Date; deleteField?: () => unknown }
 *     `deleteField` es OPCIONAL: en produccion vale `() => FieldValue.delete()` (lo cablea `storeApi`, o el
 *     handler por defecto); las pruebas inyectan un centinela y comprueban que el ejecutor lo recibe (RF_23:
 *     corregir `addressRaw` borra `normalizedAddress`, `lat`, `lng`).
 *   El cuerpo se lee de `request.rawBody` (Buffer, como en Cloud Functions) con parseConfirmBody/parseWriteBody.
 *   El handler llama al ejecutor con `policy: "api"`, actor `{ kind: "api", sellerId, keyLast4 }` y, en PATCH y
 *   cancelar, los `fieldProblems` de parseWriteBody. Exito: 200 `{ ok: true, changed, pedido }`, con `pedido`
 *   igual, por valor, a lo que devuelve `GET /orders/{id}` justo despues.
 *
 * Pares de precedencia de la nota 8 que dependen de tasa o idempotencia — PENDIENTES PARA T12 (no existen
 * hasta entonces; se escriben en el bloque T12):
 *   - parametro desconocido + limite superado → 400 unknown_parameter (no 429);
 *   - limite superado + Idempotency-Key ya usada → 429;
 *   - Idempotency-Key reutilizada con otro cuerpo + pedido inexistente → 422 idempotency_key_reused (no 404).
 * El cuarto par de la nota 8 (pedido ajeno `in_route` → 404, nunca 409) SI esta aqui.
 */

const STORE_API_WRITE_MODULE = "../../functions/src/store-api-write";
const REQUEST_MODULE = "../../functions/src/store-api-request";
const DELETE_SENTINEL = Object.freeze({ __fieldValue: "delete" });

type Reply = { httpStatus: number; body: Record<string, unknown> };
type MapRejection = (rejection: Record<string, unknown>, options?: { activeCities?: Array<Record<string, unknown>> }) => Reply;

async function loadMapRejection(): Promise<MapRejection> {
  const mod = (await import(STORE_API_WRITE_MODULE)) as Record<string, unknown>;
  if (typeof mod.mapRejectionToResponse !== "function") {
    throw new Error("functions/src/store-api-write.ts no exporta mapRejectionToResponse(rejection, { activeCities })");
  }
  return mod.mapRejectionToResponse as MapRejection;
}

async function loadRequestModule() {
  return (await import(REQUEST_MODULE)) as {
    buildErrorBody: (code: string, extras?: Record<string, unknown>) => Record<string, unknown>;
    buildFieldError: (problems: Array<{ field: string; code: string }>) => Reply & { code: string };
  };
}

// ---------------------------------------------------------------------------------------------------
// Firestore falso con transacciones (lee como el de T10; escribe SOLO dentro de runTransaction)
// ---------------------------------------------------------------------------------------------------

type TxRef = { id: string; path: string; collectionName: string; parent: { id: string }; get(): Promise<unknown>; set(): never; update(): never; create(): never; delete(): never };
type TxQuery = { kind: "query"; collectionName: string; filters: Filter[] };
type WriteCall = { op: "set" | "update" | "create" | "delete"; collection: string; id: string; data?: Data; merge?: boolean };

class TxFakeDb {
  docs = new Map<string, Data>();
  writes: WriteCall[] = [];
  transactions = 0;
  /** Si es true, la consulta de ciudades activas (fuera de la transaccion) falla. */
  failCitiesQuery = false;
  private autoId = 0;

  seed(collection: string, id: string, data: Data) {
    this.docs.set(`${collection}/${id}`, structuredClone(data));
  }

  read(collection: string, id: string): Data | undefined {
    const data = this.docs.get(`${collection}/${id}`);
    return data === undefined ? undefined : structuredClone(data);
  }

  all(collection: string): Array<Data & { __id: string }> {
    return [...this.docs.entries()]
      .filter(([path]) => path.startsWith(`${collection}/`))
      .map(([path, data]) => ({ ...structuredClone(data), __id: path.slice(collection.length + 1) }));
  }

  snapshot(collection: string, id: string) {
    const data = this.docs.get(`${collection}/${id}`);
    return {
      id,
      ref: this.ref(collection, id),
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : structuredClone(data)),
      get: (field: string) => (data === undefined ? undefined : structuredClone(data[field]))
    };
  }

  ref(collection: string, id?: string): TxRef {
    const docId = id ?? `${collection}-auto-${++this.autoId}`;
    const refuse = (): never => {
      throw new Error(`Escritura fuera de transaccion en ${collection}/${docId}: las escrituras van por el ejecutor`);
    };
    return {
      id: docId,
      path: `${collection}/${docId}`,
      collectionName: collection,
      parent: { id: collection },
      get: async () => this.snapshot(collection, docId),
      set: refuse,
      update: refuse,
      create: refuse,
      delete: refuse
    };
  }

  matches(data: Data, [field, op, value]: Filter): boolean {
    const actual = data[field];
    if (op === "==") return actual === value;
    if (op === "in") return Array.isArray(value) && value.some((item) => item === actual);
    if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
    throw new Error(`Operador no soportado por el db falso: ${op}`);
  }

  runQuery(collection: string, filters: Filter[], limitCount?: number) {
    const docs = [...this.docs.keys()]
      .filter((path) => path.startsWith(`${collection}/`))
      .map((path) => path.slice(collection.length + 1))
      .filter((id) => filters.every((filter) => this.matches(this.docs.get(`${collection}/${id}`) as Data, filter)))
      .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
      .map((id) => this.snapshot(collection, id));
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn: (doc: unknown) => void) => docs.forEach(fn) };
  }

  query(collection: string, filters: Filter[], limitCount?: number): unknown {
    return {
      kind: "query",
      collectionName: collection,
      filters,
      where: (field: string, op: string, value: unknown) => this.query(collection, [...filters, [field, op, value]], limitCount),
      limit: (count: number) => this.query(collection, filters, count),
      get: async () => {
        if (collection === "cities" && this.failCitiesQuery) throw new Error("cities no disponible");
        return this.runQuery(collection, filters, limitCount);
      }
    };
  }

  collection(name: string) {
    const base = this.query(name, []) as Record<string, unknown>;
    return { ...base, id: name, doc: (id?: string) => this.ref(name, id) };
  }

  async getAll(...refs: TxRef[]) {
    return refs.map((ref) => this.snapshot(ref.collectionName, ref.id));
  }

  async runTransaction<T>(fn: (tx: TxFake) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const tx = new TxFake(this);
    const result = await fn(tx);
    tx.commit();
    return result;
  }

  batch(): never {
    throw new Error("Las escrituras de pedidos van por el ejecutor, no por batch");
  }
}

function applyTxFields(base: Data, patch: Data): Data {
  const next: Data = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === DELETE_SENTINEL) delete next[key];
    else next[key] = structuredClone(value);
  }
  return next;
}

class TxFake {
  private pending: Array<() => void> = [];
  private calls: WriteCall[] = [];

  constructor(private db: TxFakeDb) {}

  async get(target: TxRef | TxQuery) {
    if (this.calls.length > 0) throw new Error("Firestore: las lecturas de una transaccion van antes que las escrituras");
    if ((target as TxQuery).kind === "query") {
      const query = target as TxQuery;
      return this.db.runQuery(query.collectionName, query.filters);
    }
    const ref = target as TxRef;
    return this.db.snapshot(ref.collectionName, ref.id);
  }

  private record(call: WriteCall, apply: () => void) {
    this.calls.push(call);
    this.pending.push(apply);
    return this;
  }

  set(ref: TxRef, data: Data, options?: { merge?: boolean }) {
    const merge = options?.merge === true;
    return this.record({ op: "set", collection: ref.collectionName, id: ref.id, data: { ...data }, merge }, () => {
      const base = merge ? (this.db.docs.get(ref.path) ?? {}) : {};
      this.db.docs.set(ref.path, applyTxFields(base, data));
    });
  }

  update(ref: TxRef, data: Data) {
    return this.record({ op: "update", collection: ref.collectionName, id: ref.id, data: { ...data } }, () => {
      const current = this.db.docs.get(ref.path);
      if (!current) throw new Error(`update sobre documento inexistente ${ref.path}`);
      this.db.docs.set(ref.path, applyTxFields(current, data));
    });
  }

  create(ref: TxRef, data: Data) {
    return this.record({ op: "create", collection: ref.collectionName, id: ref.id, data: { ...data } }, () => {
      if (this.db.docs.has(ref.path)) throw new Error(`create sobre documento existente ${ref.path}`);
      this.db.docs.set(ref.path, applyTxFields({}, data));
    });
  }

  delete(ref: TxRef) {
    return this.record({ op: "delete", collection: ref.collectionName, id: ref.id }, () => {
      this.db.docs.delete(ref.path);
    });
  }

  commit() {
    for (const apply of this.pending) apply();
    this.db.writes.push(...this.calls);
  }
}

/** La tienda de pruebas de T10 mas pedidos en cada estado que importa a T11 y las ciudades. */
function writeDb(): TxFakeDb {
  const source = seededDb();
  const db = new TxFakeDb();
  for (const [path, data] of source.docs) {
    const [collection, id] = path.split("/");
    db.seed(collection, id, data);
  }
  const base = { sellerId: SELLER, paymentMethod: "cod", totalCop: 45000, zoneId: "z1", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z" };
  db.seed("orders", "w-imported", {
    ...base, trackingCode: "KNT-001001", shopifyOrderId: "2001", status: "imported", driverId: null, addressRisk: "review",
    customerName: "Carla Prueba", customerPhone: "3001234567", addressRaw: "Calle 1 # 2-3", deliveryNotes: "Porteria",
    cityId: "c-cali", normalizedAddress: "CL 1 2 3, Cali", lat: 3.45, lng: -76.53
  });
  db.seed("orders", "w-ready", {
    ...base, trackingCode: "KNT-001002", shopifyOrderId: "2002", status: "ready_to_assign", driverId: null,
    customerName: "Dario Prueba", customerPhone: "3001234568", addressRaw: "Calle 4 # 5-6", cityId: "c-cali"
  });
  db.seed("orders", "w-in-route", {
    ...base, trackingCode: "KNT-001003", shopifyOrderId: "2003", status: "in_route", driverId: "d1",
    customerName: "Elena Prueba", customerPhone: "3001234569", addressRaw: "Calle 7 # 8-9", cityId: "c-cali"
  });
  db.seed("orders", "w-cancelled", {
    ...base, trackingCode: "KNT-001004", shopifyOrderId: "2004", status: "cancelled", driverId: null,
    customerName: "Fabio Prueba", customerPhone: "3001234570", addressRaw: "Calle 10 # 11-12", cityId: "c-cali", callNote: "Ya anulado"
  });
  db.seed("orders", "w-foreign-route", {
    ...base, sellerId: OTHER_SELLER, trackingCode: "KNT-009003", shopifyOrderId: "9003", status: "in_route", driverId: "d1",
    customerName: "Cliente ajeno en ruta", customerPhone: "3009999999", addressRaw: "Calle ajena", cityId: "c-cali"
  });
  db.seed("orders", "w-foreign-imported", {
    ...base, sellerId: OTHER_SELLER, trackingCode: "KNT-009004", shopifyOrderId: "9004", status: "imported", driverId: null,
    customerName: "Cliente ajeno importado", customerPhone: "3009999998", addressRaw: "Calle ajena 2", cityId: "c-cali"
  });
  // Ciudades: los ids no siguen el orden de los nombres, a proposito.
  db.seed("cities", "c-pal", { id: "c-pal", name: "Palmira", active: false });
  db.seed("cities", "c-med", { id: "c-med", name: "Medellin", active: true });
  db.seed("cities", "c-cali", { id: "c-cali", name: "Cali", active: true });
  db.seed("cities", "c-bog", { id: "c-bog", name: "Bogota", active: true });
  return db;
}

const ORDER_COLLECTIONS = ["orders", "auditEvents", "orderHistory"];

function guardedWrites(db: TxFakeDb): WriteCall[] {
  return db.writes.filter((write) => ORDER_COLLECTIONS.includes(write.collection));
}

type WriteOptions = {
  method: string;
  path: string;
  query?: Record<string, string>;
  bearer?: string;
  /** Objeto → JSON; texto → tal cual (para JSON roto); undefined → sin cuerpo. */
  body?: unknown;
};

function makeWriteRequest(options: WriteOptions): FakeRequest {
  const request = makeRequest({ method: options.method, path: options.path, query: options.query, bearer: options.bearer });
  if (options.body !== undefined) {
    const text = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    request.rawBody = Buffer.from(text, "utf8");
    request.headers["content-type"] = "application/json";
    try {
      request.body = JSON.parse(text);
    } catch {
      request.body = text;
    }
  }
  return request;
}

async function write(db: TxFakeDb, options: WriteOptions): Promise<FakeResponse> {
  const handler = (await loadHandler()) as unknown as (
    request: FakeRequest,
    response: FakeResponse,
    deps: { db: TxFakeDb; now?: () => Date; deleteField?: () => unknown }
  ) => Promise<void>;
  const response = makeResponse();
  await handler(makeWriteRequest(options), response, { db, now: () => new Date(NOW), deleteField: () => DELETE_SENTINEL });
  return response;
}

const OWN = { sellerId: SELLER };

async function readBack(db: TxFakeDb, orderId: string): Promise<FakeResponse> {
  return write(db, { method: "GET", path: `/orders/${orderId}`, query: { sellerId: SELLER, key: READ_KEY } });
}

describe("T11 · rutas de escritura", () => {
  describe("mapRejectionToResponse (RNF_02, RF_10)", () => {
    it("order_not_found → 404 con el mismo cuerpo que el GET de un pedido ajeno", async () => {
      const map = await loadMapRejection();
      const { buildErrorBody } = await loadRequestModule();
      const reply = map({ code: "order_not_found" });
      expect(reply.httpStatus).toBe(404);
      expect(reply.body).toEqual(buildErrorBody("order_not_found"));
    });

    it.each([
      [{ code: "order_cancelled", status: "cancelled" }, { status: "cancelled" }],
      [{ code: "address_review_pending", status: "address_risk" }, { status: "address_risk" }],
      [{ code: "status_changed", status: "ready_to_assign" }, { status: "ready_to_assign" }],
      [{ code: "order_not_editable", status: "in_route", hasLeader: true }, { status: "in_route", hasLeader: true }],
      [{ code: "order_not_editable", status: "delivered", hasLeader: false }, { status: "delivered", hasLeader: false }]
    ])("%o → 409 con status (y hasLeader si es order_not_editable)", async (rejection, extras) => {
      const map = await loadMapRejection();
      const { buildErrorBody } = await loadRequestModule();
      const reply = map(rejection);
      expect(reply.httpStatus).toBe(409);
      expect(reply.body).toEqual(buildErrorBody(rejection.code, extras));
    });

    it.each([
      ["validation_failed", [{ field: "customerPhone", code: "invalid_phone" }, { field: "addressRaw", code: "empty" }]],
      ["field_not_allowed", [{ field: "totalCop", code: "not_allowed" }, { field: "customerName", code: "too_long" }]]
    ])("%s → 422 con todos los campos, igual que buildFieldError", async (code, fields) => {
      const map = await loadMapRejection();
      const { buildFieldError } = await loadRequestModule();
      const reply = map({ code, fields });
      expect(reply.httpStatus).toBe(422);
      expect(reply.body).toEqual(buildFieldError(fields).body);
      expect(reply.body.code).toBe(code);
    });

    it("no_fields → 422 no_fields", async () => {
      const map = await loadMapRejection();
      const { buildErrorBody } = await loadRequestModule();
      const reply = map({ code: "no_fields" });
      expect(reply.httpStatus).toBe(422);
      expect(reply.body).toEqual(buildErrorBody("no_fields"));
    });

    it("out_of_coverage → 422 con el campo cityId y activeCities {id, name} ordenadas por nombre", async () => {
      const map = await loadMapRejection();
      const reply = map(
        { code: "out_of_coverage", field: "cityId" },
        {
          activeCities: [
            { id: "c-med", name: "Medellin", active: true },
            { id: "c-cali", name: "Cali", active: true },
            { id: "c-bog", name: "Bogota", active: true }
          ]
        }
      );
      expect(reply.httpStatus).toBe(422);
      expect(reply.body).toMatchObject({ ok: false, code: "out_of_coverage" });
      expect(reply.body.fields).toEqual([expect.objectContaining({ field: "cityId", code: "out_of_coverage" })]);
      expect(reply.body.activeCities).toEqual([
        { id: "c-bog", name: "Bogota" },
        { id: "c-cali", name: "Cali" },
        { id: "c-med", name: "Medellin" }
      ]);
    });

    it("out_of_coverage sin la lista (su lectura fallo) → 422 igual, sin la clave activeCities", async () => {
      const map = await loadMapRejection();
      const reply = map({ code: "out_of_coverage", field: "cityId" });
      expect(reply.httpStatus).toBe(422);
      expect(reply.body.code).toBe("out_of_coverage");
      expect("activeCities" in reply.body).toBe(false);
    });

    it("las demas respuestas nunca llevan activeCities aunque se pasen", async () => {
      const map = await loadMapRejection();
      const reply = map({ code: "no_fields" }, { activeCities: [{ id: "c-cali", name: "Cali" }] });
      expect("activeCities" in reply.body).toBe(false);
    });

    it("panel_precondition (imposible con politica api) → 500 internal_error sin el mensaje del panel", async () => {
      const map = await loadMapRejection();
      const reply = map({ code: "panel_precondition", message: "Only imported orders can be confirmed.", httpsCode: "failed-precondition" });
      expect(reply.httpStatus).toBe(500);
      expect(reply.body.code).toBe("internal_error");
      expect(JSON.stringify(reply.body)).not.toContain("Only imported");
    });
  });

  describe("credenciales y forma del cuerpo (pasos 1-3)", () => {
    it("key de lectura por Bearer en una escritura → 403 read_only_key, sin escribir", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: READ_KEY });
      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ ok: false, code: "read_only_key" });
      expect(guardedWrites(db)).toEqual([]);
    });

    it("key en query en una escritura, con un parametro desconocido → 401 key_in_query", async () => {
      const response = await write(writeDb(), {
        method: "PATCH",
        path: "/orders/w-imported",
        query: { sellerId: SELLER, key: WRITE_KEY, foo: "1" },
        body: { customerName: "X" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).toMatchObject({ ok: false, code: "key_in_query" });
    });

    it("las rutas de escritura ya no responden route_not_found", async () => {
      for (const [method, path] of [["POST", "/orders/w-ready/confirm"], ["PATCH", "/orders/w-ready"], ["POST", "/orders/w-cancelled/cancel"]]) {
        const response = await write(writeDb(), { method, path, query: OWN, bearer: WRITE_KEY, body: method === "POST" && path.endsWith("cancel") ? { reason: "Cliente desistio" } : method === "PATCH" ? { customerName: "Dario Prueba" } : undefined });
        expect((response.body as { code?: string }).code, `${method} ${path}`).not.toBe("route_not_found");
        expect(response.statusCode, `${method} ${path}`).toBe(200);
      }
    });

    it("parametro desconocido sobre un pedido inexistente → 400 unknown_parameter (antes que el 404)", async () => {
      const response = await write(writeDb(), {
        method: "POST",
        path: "/orders/no-existe/confirm",
        query: { sellerId: SELLER, foo: "1" },
        bearer: WRITE_KEY
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "unknown_parameter" });
    });

    it("confirmar con una clave extra sobre un pedido inexistente → 400 invalid_body (antes que el 404)", async () => {
      const response = await write(writeDb(), {
        method: "POST",
        path: "/orders/no-existe/confirm",
        query: OWN,
        bearer: WRITE_KEY,
        body: { expectedStatus: "imported", customerName: "X" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "invalid_body" });
    });

    it("PATCH con JSON roto sobre un pedido ajeno → 400 invalid_json (antes que el 404)", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-foreign-imported", query: OWN, bearer: WRITE_KEY, body: "{\"customerName\": " });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "invalid_json" });
      expect(guardedWrites(db)).toEqual([]);
    });

    it("cancelar con un cuerpo que no es objeto sobre un pedido inexistente → 400 invalid_body", async () => {
      const response = await write(writeDb(), { method: "POST", path: "/orders/no-existe/cancel", query: OWN, bearer: WRITE_KEY, body: "[1,2]" });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "invalid_body" });
    });
  });

  describe("404 frente a 409 frente a 422 (pasos 4-6, RNF_01)", () => {
    it("PATCH con un campo invalido sobre un pedido de otra tienda → 404 (no 422)", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-foreign-imported", query: OWN, bearer: WRITE_KEY, body: { customerPhone: "12" } });
      expect(response.statusCode).toBe(404);
      expect(response.body).toMatchObject({ ok: false, code: "order_not_found" });
      expect(guardedWrites(db)).toEqual([]);
    });

    it("PATCH con un campo invalido sobre un pedido propio in_route → 409 order_not_editable (no 422)", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-in-route", query: OWN, bearer: WRITE_KEY, body: { customerPhone: "12" } });
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ ok: false, code: "order_not_editable", status: "in_route", hasLeader: true });
      expect(guardedWrites(db)).toEqual([]);
    });

    it.each([
      ["POST", "/orders/w-foreign-route/confirm", undefined],
      ["PATCH", "/orders/w-foreign-route", { customerName: "Otro nombre" }],
      ["POST", "/orders/w-foreign-route/cancel", { reason: "Cliente desistio" }]
    ])("%s %s: pedido ajeno in_route → 404 identico al de un inexistente, sin revelar su estado", async (method, path, body) => {
      const db = writeDb();
      const foreign = await write(db, { method, path, query: OWN, bearer: WRITE_KEY, body });
      const missing = await write(db, { method, path: path.replace("w-foreign-route", "no-existe"), query: OWN, bearer: WRITE_KEY, body });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toMatchObject({ ok: false, code: "order_not_found" });
      expect(foreign.body).toEqual(missing.body);
      const text = JSON.stringify(foreign.body);
      for (const leaked of ["in_route", "hasLeader", "KNT-009003", "Cliente ajeno en ruta", OTHER_SELLER]) expect(text).not.toContain(leaked);
      expect(guardedWrites(db)).toEqual([]);
    });

    it("PATCH con un telefono invalido sobre un pedido propio editable → 422 validation_failed con el campo", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { customerPhone: "12" } });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ ok: false, code: "validation_failed" });
      expect((response.body as { fields: Array<{ field: string; code: string }> }).fields).toEqual([
        expect.objectContaining({ field: "customerPhone", code: "invalid_phone" })
      ]);
      expect(guardedWrites(db)).toEqual([]);
    });

    it("PATCH con un campo no permitido y otro invalido → 422 field_not_allowed con los dos, sin aplicar nada", async () => {
      const db = writeDb();
      const before = db.read("orders", "w-imported");
      const response = await write(db, {
        method: "PATCH",
        path: "/orders/w-imported",
        query: OWN,
        bearer: WRITE_KEY,
        body: { totalCop: 1, customerName: "", deliveryNotes: "Nueva nota" }
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ ok: false, code: "field_not_allowed" });
      const fields = (response.body as { fields: Array<{ field: string }> }).fields.map((item) => item.field).sort();
      expect(fields).toEqual(["customerName", "totalCop"]);
      expect(db.read("orders", "w-imported")).toEqual(before);
    });

    it("cancelar sin motivo un pedido propio editable → 422 validation_failed (reason required)", async () => {
      const response = await write(writeDb(), { method: "POST", path: "/orders/w-imported/cancel", query: OWN, bearer: WRITE_KEY, body: {} });
      expect(response.statusCode).toBe(422);
      expect((response.body as { fields: Array<{ field: string; code: string }> }).fields).toEqual([
        expect.objectContaining({ field: "reason", code: "required" })
      ]);
    });

    it("confirmar un address_risk → 409 address_review_pending con status", async () => {
      const db = writeDb();
      db.seed("orders", "w-risk", { ...db.read("orders", "w-imported"), status: "address_risk", trackingCode: "KNT-001005" });
      const response = await write(db, { method: "POST", path: "/orders/w-risk/confirm", query: OWN, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ ok: false, code: "address_review_pending", status: "address_risk" });
    });

    it("confirmar un cancelado → 409 order_cancelled", async () => {
      const response = await write(writeDb(), { method: "POST", path: "/orders/w-cancelled/confirm", query: OWN, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ ok: false, code: "order_cancelled", status: "cancelled" });
    });

    it("confirmar con expectedStatus distinto sobre un imported → 409 status_changed", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, body: { expectedStatus: "ready_to_assign" } });
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ ok: false, code: "status_changed", status: "imported" });
      expect(guardedWrites(db)).toEqual([]);
    });
  });

  describe("RF_10 · ciudad sin cobertura", () => {
    it("PATCH a una ciudad desactivada → 422 out_of_coverage con activeCities activas ordenadas por nombre", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { cityId: "c-pal" } });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ ok: false, code: "out_of_coverage" });
      expect((response.body as { activeCities: unknown }).activeCities).toEqual([
        { id: "c-bog", name: "Bogota" },
        { id: "c-cali", name: "Cali" },
        { id: "c-med", name: "Medellin" }
      ]);
      expect(guardedWrites(db)).toEqual([]);
    });

    it("la misma ciudad que ya tiene el pedido, desactivada → 422 out_of_coverage (no changed:false)", async () => {
      const db = writeDb();
      db.seed("cities", "c-cali", { id: "c-cali", name: "Cali", active: false });
      const response = await write(db, { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { cityId: "c-cali" } });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ ok: false, code: "out_of_coverage" });
    });

    it("si la lectura de ciudades activas falla, responde 422 igual y sin activeCities", async () => {
      const db = writeDb();
      db.failCitiesQuery = true;
      const response = await write(db, { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { cityId: "c-pal" } });
      expect(response.statusCode).toBe(422);
      expect((response.body as { code: string }).code).toBe("out_of_coverage");
      expect("activeCities" in (response.body as object)).toBe(false);
    });
  });

  describe("aplicar: { ok, changed, pedido } con la forma de GET /orders/{id} (RF_04, RF_07, RF_13, RF_19)", () => {
    it("confirmar un imported sin lider → 200 changed:true y pedido igual al GET posterior", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, body: { expectedStatus: "imported" } });
      expect(response.statusCode).toBe(200);
      const after = await readBack(db, "w-imported");
      expect(response.body).toEqual({ ok: true, changed: true, pedido: (after.body as { pedido: unknown }).pedido });
      expect(db.read("orders", "w-imported")).toMatchObject({ status: "ready_to_assign", addressRisk: "accepted", confirmedVia: "api" });
    });

    it("confirmar sin cuerpo tambien aplica", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(200);
      expect((response.body as { changed: boolean }).changed).toBe(true);
    });

    it("lo escrito pasa por el ejecutor con politica api y el actor de la key (evento e historial con keyLast4)", async () => {
      const db = writeDb();
      await write(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY });
      expect(db.transactions).toBeGreaterThan(0);
      const events = db.all("auditEvents");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ origin: "api", actorRole: "store_api", apiKeyLast4: last4(WRITE_KEY), entityId: "w-imported", action: "order.seller_confirmed", createdAt: NOW });
      const history = db.all("orderHistory");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ origin: "api", actor: { kind: "api", keyLast4: last4(WRITE_KEY) }, orderId: "w-imported", sellerId: SELLER });
      expect(JSON.stringify([...events, ...history])).not.toContain(WRITE_KEY);
    });

    it("PATCH de datos de entrega → 200 changed:true, sello de edicion manual y pedido igual al GET posterior", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { customerName: "Carla Corregida", deliveryNotes: null } });
      expect(response.statusCode).toBe(200);
      const after = await readBack(db, "w-imported");
      expect(response.body).toEqual({ ok: true, changed: true, pedido: (after.body as { pedido: unknown }).pedido });
      const stored = db.read("orders", "w-imported") as Data;
      expect(stored).toMatchObject({ customerName: "Carla Corregida", manuallyEditedAt: NOW, status: "imported" });
      expect("deliveryNotes" in stored && stored.deliveryNotes !== null && stored.deliveryNotes !== undefined).toBe(false);
    });

    it("PATCH de addressRaw borra lo derivado de la direccion con el deleteField inyectado (RF_23)", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { addressRaw: "Carrera 50 # 10-20" } });
      expect(response.statusCode).toBe(200);
      const stored = db.read("orders", "w-imported") as Data;
      expect(stored.addressRaw).toBe("Carrera 50 # 10-20");
      for (const key of ["normalizedAddress", "lat", "lng"]) expect(key in stored, key).toBe(false);
      expect(JSON.stringify(stored)).not.toContain("__fieldValue");
    });

    it("cancelar un editable con motivo → 200 changed:true, cancelled con el motivo como nota", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-ready/cancel", query: OWN, bearer: WRITE_KEY, body: { reason: "Cliente desistio" } });
      expect(response.statusCode).toBe(200);
      const after = await readBack(db, "w-ready");
      expect(response.body).toEqual({ ok: true, changed: true, pedido: (after.body as { pedido: unknown }).pedido });
      expect(db.read("orders", "w-ready")).toMatchObject({ status: "cancelled", callNote: "Cliente desistio", closedAt: NOW });
    });
  });

  describe("no-op: 200 changed:false sin escribir (RF_05, RF_15)", () => {
    it("confirmar un ready_to_assign → changed:false, aunque expectedStatus no coincida", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-ready/confirm", query: OWN, bearer: WRITE_KEY, body: { expectedStatus: "imported" } });
      expect(response.statusCode).toBe(200);
      const after = await readBack(db, "w-ready");
      expect(response.body).toEqual({ ok: true, changed: false, pedido: (after.body as { pedido: unknown }).pedido });
      expect(guardedWrites(db)).toEqual([]);
    });

    it("cancelar un cancelado (con motivo valido) → changed:false", async () => {
      const db = writeDb();
      const response = await write(db, { method: "POST", path: "/orders/w-cancelled/cancel", query: OWN, bearer: WRITE_KEY, body: { reason: "Otra vez" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ ok: true, changed: false });
      expect(db.read("orders", "w-cancelled")).toMatchObject({ callNote: "Ya anulado" });
      expect(guardedWrites(db)).toEqual([]);
    });

    it("PATCH con los valores que ya tiene → changed:false", async () => {
      const db = writeDb();
      const response = await write(db, { method: "PATCH", path: "/orders/w-ready", query: OWN, bearer: WRITE_KEY, body: { customerName: "  Dario Prueba  ", cityId: "c-cali" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ ok: true, changed: false });
      expect((response.body as { pedido: { id: string } }).pedido.id).toBe("w-ready");
      expect(guardedWrites(db)).toEqual([]);
    });
  });
});

// =========================================================================================================
// T12 · idempotencia y limite de tasa en el handler (RNF_03, RNF_04; pares de la nota 8 de T11)
// =========================================================================================================
/*
 * Contrato (ademas de los de store-api-request.test.ts y order-seller-actions-run.test.ts):
 *  - Cabecera `Idempotency-Key` (request.get("idempotency-key")); se valida en el paso 3 con validateIdempotencyKey.
 *  - Paso 3a, solo escrituras: transaccion corta sobre storeApiRateLimits/{sellerId}__{YYYYMMDDHHmm} con `count`
 *    (+1 por escritura); count > STORE_API_WRITES_PER_MINUTE → 429 rate_limited con cabecera Retry-After (segundos
 *    hasta el minuto siguiente, >= 1). Las lecturas no cuentan.
 *  - Paso 3b: atajo fuera de la transaccion sobre storeApiIdempotency/{sellerId}__{sha256(key)} (replay/conflict).
 *  - El ejecutor guarda { status, body } construido con la MISMA funcion que da la respuesta, incluido `pedido`.
 *  - Un replay devuelve el status y el cuerpo guardados, tal cual, sin tocar orders/auditEvents/orderHistory.
 */
describe("T12 · idempotencia y limite de tasa en el handler (RNF_03, RNF_04)", () => {
  const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const BUCKET = "202610051500"; // NOW = 2026-10-05T15:00:00.000Z
  const RATE_ID = `${SELLER}__${BUCKET}`;

  async function writeWithKey(db: TxFakeDb, options: WriteOptions & { idempotencyKey?: string }): Promise<FakeResponse> {
    const handler = (await loadHandler()) as unknown as (
      request: FakeRequest,
      response: FakeResponse,
      deps: { db: TxFakeDb; now?: () => Date; deleteField?: () => unknown }
    ) => Promise<void>;
    const request = makeWriteRequest(options);
    if (options.idempotencyKey !== undefined) request.headers["idempotency-key"] = options.idempotencyKey;
    const response = makeResponse();
    await handler(request, response, { db, now: () => new Date(NOW), deleteField: () => DELETE_SENTINEL });
    return response;
  }

  function idempotencyRecords(db: TxFakeDb) {
    return db.all("storeApiIdempotency");
  }

  describe("pares de precedencia de la nota 8 de T11", () => {
    it("parametro desconocido + limite superado → 400 unknown_parameter (no 429)", async () => {
      const db = writeDb();
      db.seed("storeApiRateLimits", RATE_ID, { count: 500 });
      const response = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: { ...OWN, foo: "1" }, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "unknown_parameter" });
    });

    it("limite superado + Idempotency-Key ya usada → 429 (no el replay)", async () => {
      const db = writeDb();
      const options = { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, idempotencyKey: "k-usada" };
      const first = await writeWithKey(db, options);
      expect(first.statusCode).toBe(200);
      db.seed("storeApiRateLimits", RATE_ID, { count: 500 });
      const second = await writeWithKey(db, options);
      expect(second.statusCode).toBe(429);
      expect(second.body).toMatchObject({ ok: false, code: "rate_limited" });
    });

    it("Idempotency-Key reutilizada con otro cuerpo + pedido inexistente → 422 idempotency_key_reused (no 404)", async () => {
      const db = writeDb();
      const first = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, idempotencyKey: "k-reuso" });
      expect(first.statusCode).toBe(200);
      const second = await writeWithKey(db, { method: "PATCH", path: "/orders/no-existe", query: OWN, bearer: WRITE_KEY, body: { customerName: "X" }, idempotencyKey: "k-reuso" });
      expect(second.statusCode).toBe(422);
      expect(second.body).toMatchObject({ ok: false, code: "idempotency_key_reused" });
    });
  });

  describe("replay de punta a punta", () => {
    it("PATCH aplicado y repetido con la misma key y cuerpo → la misma respuesta, una sola escritura", async () => {
      const db = writeDb();
      const options = { method: "PATCH", path: "/orders/w-imported", query: OWN, bearer: WRITE_KEY, body: { customerName: "Carla Corregida" }, idempotencyKey: "k-replay" };
      const first = await writeWithKey(db, options);
      expect(first.statusCode).toBe(200);
      expect(first.body).toMatchObject({ ok: true, changed: true });
      const ordersAfterFirst = db.read("orders", "w-imported");
      const second = await writeWithKey(db, options);
      expect(second.statusCode).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(db.read("orders", "w-imported")).toEqual(ordersAfterFirst);
      expect(guardedWrites(db).filter((w) => w.collection === "orders")).toHaveLength(1);
      expect(db.all("auditEvents")).toHaveLength(1);
      expect(db.all("orderHistory")).toHaveLength(1);
    });

    it("el registro: id `{sellerId}__{sha256(key)}`, sin la key en claro, con el cuerpo 200 completo (incluido pedido)", async () => {
      const db = writeDb();
      const key = "k-forma-registro";
      const response = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, idempotencyKey: key });
      expect(response.statusCode).toBe(200);
      const records = idempotencyRecords(db);
      expect(records).toHaveLength(1);
      expect(records[0].__id).toBe(`${SELLER}__${sha(key)}`);
      expect(records[0]).toMatchObject({ status: 200, body: response.body, method: "POST", path: "/orders/w-imported/confirm", createdAt: NOW });
      expect(JSON.stringify(records[0])).not.toContain(key);
      expect(JSON.stringify(records[0])).not.toContain(WRITE_KEY);
    });

    it("un 409 se repite igual aunque el pedido ya no lo provocaria (RNF_03: mismo 409 durante 24 h)", async () => {
      const db = writeDb();
      const options = { method: "PATCH", path: "/orders/w-in-route", query: OWN, bearer: WRITE_KEY, body: { customerName: "Otra" }, idempotencyKey: "k-409" };
      const first = await writeWithKey(db, options);
      expect(first.statusCode).toBe(409);
      db.seed("orders", "w-in-route", { ...(db.read("orders", "w-in-route") as Data), status: "imported", driverId: null });
      const second = await writeWithKey(db, options);
      expect(second.statusCode).toBe(409);
      expect(second.body).toEqual(first.body);
      expect(guardedWrites(db)).toEqual([]);
    });
  });

  describe("que no se guarda", () => {
    it("404 de un pedido ajeno con key → sin registro; 400 de cuerpo con key → sin registro", async () => {
      const db = writeDb();
      const notFound = await writeWithKey(db, { method: "PATCH", path: "/orders/w-foreign-imported", query: OWN, bearer: WRITE_KEY, body: { customerName: "X" }, idempotencyKey: "k-404" });
      expect(notFound.statusCode).toBe(404);
      const badBody = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, body: { otra: 1 }, idempotencyKey: "k-400" });
      expect(badBody.statusCode).toBe(400);
      expect(idempotencyRecords(db)).toEqual([]);
    });
  });

  describe("formato de la cabecera (paso 3)", () => {
    it.each([["vacia", ""], ["256 caracteres", "k".repeat(256)]])("Idempotency-Key %s → 400 invalid_idempotency_key, sin escribir", async (_name, key) => {
      const db = writeDb();
      const response = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY, idempotencyKey: key });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ ok: false, code: "invalid_idempotency_key" });
      expect(guardedWrites(db)).toEqual([]);
      expect(db.read("orders", "w-imported")).toMatchObject({ status: "imported" });
    });
  });

  describe("limite de tasa (RNF_04)", () => {
    it("cada escritura cuenta en storeApiRateLimits/{sellerId}__{YYYYMMDDHHmm}", async () => {
      const db = writeDb();
      await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY });
      await writeWithKey(db, { method: "POST", path: "/orders/w-ready/confirm", query: OWN, bearer: WRITE_KEY });
      const rate = db.all("storeApiRateLimits");
      expect(rate).toHaveLength(1);
      expect(rate[0].__id).toBe(RATE_ID);
      expect(rate[0].count).toBe(2);
    });

    it("la escritura 121 del minuto → 429 rate_limited con Retry-After >= 1, nunca 403, sin tocar el pedido", async () => {
      const db = writeDb();
      db.seed("storeApiRateLimits", RATE_ID, { count: 120 });
      const response = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(429);
      expect(response.statusCode).not.toBe(403);
      expect(response.body).toMatchObject({ ok: false, code: "rate_limited" });
      expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(response.headers["retry-after"]).toBe("60");
      expect(guardedWrites(db)).toEqual([]);
      expect(db.read("orders", "w-imported")).toMatchObject({ status: "imported" });
    });

    it("la escritura 120 todavia pasa", async () => {
      const db = writeDb();
      db.seed("storeApiRateLimits", RATE_ID, { count: 119 });
      const response = await writeWithKey(db, { method: "POST", path: "/orders/w-imported/confirm", query: OWN, bearer: WRITE_KEY });
      expect(response.statusCode).toBe(200);
    });

    it("las lecturas no cuentan ni se limitan", async () => {
      const db = writeDb();
      db.seed("storeApiRateLimits", RATE_ID, { count: 500 });
      const response = await readBack(db, "w-imported");
      expect(response.statusCode).toBe(200);
      expect(db.read("storeApiRateLimits", RATE_ID)).toEqual({ count: 500 });
    });
  });
});
