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
