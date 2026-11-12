/**
 * Spec 023, fase A — `GET /orders` y `GET /kpis` leen solo el rango pedido.
 *
 * El oraculo es el propio handler con los cargadores de antes (`loadStoreOrdersFull`,
 * `loadSellerEntriesFull`) puestos en lugar de los dirigidos: misma ruta, mismo calculo, solo cambia
 * de donde salen los datos. RF_11 exige que las dos respuestas sean identicas.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const STORE_API_MODULE = "../../functions/src/store-api";
const RANGE_MODULE = "../../functions/src/store-api-range";

type Data = Record<string, unknown>;
type Filter = [string, string, unknown];

/** Firestore falso de solo lectura: `==`, `in`, `array-contains`, `>=`, `<`. Cuenta documentos leidos. */
class FakeDb {
  docs = new Map<string, Data>();
  queries: Array<{ collection: string; filters: Filter[]; returned: number }> = [];
  docsRead = 0;
  failWalletIn = false;

  seed(collection: string, id: string, data: Data) {
    this.docs.set(`${collection}/${id}`, structuredClone(data));
  }

  readsOf(collection: string) {
    return this.queries.filter((query) => query.collection === collection).reduce((sum, query) => sum + query.returned, 0);
  }

  private snapshot(collection: string, id: string) {
    const data = this.docs.get(`${collection}/${id}`);
    return {
      id,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : structuredClone(data)),
      get: (field: string) => (data === undefined ? undefined : structuredClone(data[field]))
    };
  }

  private matches(data: Data, [field, op, value]: Filter): boolean {
    const actual = data[field];
    if (op === "==") return actual === value;
    if (op === "in") return Array.isArray(value) && value.some((item) => item === actual);
    if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
    // Firestore solo compara valores del mismo tipo: un rango de texto no empareja un numero ni un ausente.
    if (op === ">=") return typeof actual === typeof value && (actual as string) >= (value as string);
    if (op === "<") return typeof actual === typeof value && (actual as string) < (value as string);
    throw new Error(`Operador no soportado por el db falso: ${op}`);
  }

  private query(collection: string, filters: Filter[]): unknown {
    return {
      where: (field: string, op: string, value: unknown) => this.query(collection, [...filters, [field, op, value]]),
      limit: () => this.query(collection, filters),
      get: async () => {
        if (this.failWalletIn && collection === "walletEntries" && filters.some(([, op]) => op === "in")) {
          throw new Error("UNAVAILABLE (simulado)");
        }
        const docs = [...this.docs.keys()]
          .filter((path) => path.startsWith(`${collection}/`))
          .map((path) => path.slice(collection.length + 1))
          .filter((id) => filters.every((filter) => this.matches(this.docs.get(`${collection}/${id}`) as Data, filter)))
          .map((id) => this.snapshot(collection, id));
        this.queries.push({ collection, filters, returned: docs.length });
        this.docsRead += docs.length;
        return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn: (doc: unknown) => void) => docs.forEach(fn) };
      }
    };
  }

  collection(name: string) {
    const base = this.query(name, []) as Record<string, unknown>;
    return {
      ...base,
      id: name,
      doc: (id: string) => ({
        id,
        __collection: name,
        get: async () => {
          this.docsRead += 1;
          return this.snapshot(name, id);
        }
      })
    };
  }

  async getAll(...refs: Array<{ id: string; __collection: string }>) {
    this.docsRead += refs.length;
    return refs.map((ref) => this.snapshot(ref.__collection, ref.id));
  }
}

function makeRequest(path: string, query: Record<string, string>) {
  const headers: Record<string, string> = {};
  const lookup = (name: string) => headers[name.toLowerCase()];
  const search = new URLSearchParams(query).toString();
  return { method: "GET", path, url: `${path}?${search}`, query: { ...query }, headers, get: lookup, header: lookup };
}

function makeResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
    send(body: unknown) {
      response.body = body;
      return response;
    },
    set() {
      return response;
    },
    setHeader() {
      return response;
    },
    end() {
      return response;
    }
  };
  return response;
}

const SELLER = "seller-023";
const OTHER = "seller-023-ajena";
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-11-10T15:00:00.000Z");

const STATUSES = ["imported", "ready_to_assign", "assigned", "in_route", "delivered", "failed", "liquidated", "cancelled"];
const FAILED = ["failed_visit", "no_coverage", "bad_phone", undefined];

/**
 * Pedidos repartidos del 1 al 20 de noviembre, con los dos formatos de `createdAt` que hay en produccion
 * (`-05:00` y `Z`) y horas pegadas al borde del dia. Por cada pedido: asientos de la tienda (algunos en
 * cortes pagados, otros pendientes, otros sin cortar), uno de domiciliario y uno de plataforma.
 */
function seededDb(options: { extraHistory?: number } = {}) {
  const db = new FakeDb();
  db.seed("storeApiConfigs", SELLER, { id: SELLER, sellerId: SELLER, sellerName: "Tienda 023", apiKey: KEY, status: "active" });
  db.seed("sellers", SELLER, { id: SELLER, name: "Tienda 023" });

  const paidOrderIds: string[] = [];
  const pendingOrderIds: string[] = [];
  const driverCovered: string[] = [];
  let n = 0;
  const addOrder = (sellerId: string, createdAt: string) => {
    n += 1;
    const id = `o-${String(n).padStart(4, "0")}`;
    const status = STATUSES[n % STATUSES.length];
    db.seed("orders", id, {
      id,
      sellerId,
      trackingCode: `KNT-${n}`,
      shopifyOrderId: `#${1000 + n}`,
      status,
      failedCategory: status === "failed" ? FAILED[n % FAILED.length] : undefined,
      driverId: n % 3 === 0 ? null : "driver-1",
      messengerId: n % 4 === 0 ? "messenger-1" : undefined,
      paymentMethod: n % 5 === 0 ? "prepaid" : "cod",
      totalCop: 50_000 + n * 1_000,
      customerName: `Cliente ${n}`,
      createdAt,
      updatedAt: "2026-11-10T12:00:00.000Z"
    });
    const settled = n % 3;
    const settlementId = settled === 0 ? "stl-seller-paid" : settled === 1 ? "stl-seller-pending" : "";
    if (sellerId === SELLER && settled === 0) paidOrderIds.push(id);
    if (sellerId === SELLER && settled === 1) pendingOrderIds.push(id);
    if (n % 2 === 0) driverCovered.push(id);
    db.seed("walletEntries", `${id}-cod`, { orderId: id, ownerType: "seller", ownerId: sellerId, type: "cod_revenue", amountCop: 50_000 + n * 1_000, settlementId, createdAt });
    db.seed("walletEntries", `${id}-fee`, { orderId: id, ownerType: "seller", ownerId: sellerId, type: "delivery_fee", amountCop: -9_000, settlementId, createdAt });
    db.seed("walletEntries", `${id}-margin`, { orderId: id, ownerType: "seller", ownerId: sellerId, type: "platform_margin", amountCop: -1_000, settlementId, createdAt });
    db.seed("walletEntries", `${id}-drv`, { orderId: id, ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 7_000, settlementId: "", createdAt });
    db.seed("walletEntries", `${id}-plat`, { orderId: id, ownerType: "platform", ownerId: "platform", type: "platform_fee", amountCop: 2_000, createdAt });
    return id;
  };

  const times = ["T00:00:00-05:00", "T08:15:00-05:00", "T23:59:59-05:00", "T00:00:00.000Z", "T04:59:59.000Z", "T23:59:59.999Z"];
  for (let day = 1; day <= 20; day += 1) {
    for (const time of times) addOrder(SELLER, `2026-11-${String(day).padStart(2, "0")}${time}`);
    addOrder(OTHER, `2026-11-${String(day).padStart(2, "0")}T10:00:00-05:00`);
  }
  // Historico viejo fuera de cualquier rango de noviembre (RNF_02: duplicarlo no puede cambiar las lecturas).
  for (let index = 0; index < (options.extraHistory ?? 30); index += 1) addOrder(SELLER, `2025-0${1 + (index % 9)}-15T10:00:00-05:00`);

  db.seed("settlements", "stl-seller-paid", { kind: "seller", ownerId: SELLER, status: "paid", orderIds: paidOrderIds, netCop: 1, createdAt: "2026-11-05" });
  db.seed("settlements", "stl-seller-pending", { kind: "seller", ownerId: SELLER, status: "pending", orderIds: pendingOrderIds, netCop: 1, createdAt: "2026-11-08" });
  db.seed("settlements", "stl-driver-alloc", {
    kind: "driver",
    ownerId: "driver-1",
    status: "pending",
    orderIds: driverCovered,
    cashAllocations: driverCovered.map((orderId, index) => ({ orderId, covered: index % 2 === 0, receivedCop: 10_000 }))
  });
  db.seed("settlements", "stl-driver-paid", { kind: "driver", ownerId: "driver-1", status: "paid", orderIds: pendingOrderIds.slice(0, 5) });
  return db;
}

async function call(db: FakeDb, resource: string, query: Record<string, string>, loaders: "targeted" | "full") {
  vi.resetModules();
  if (loaders === "full") {
    vi.doMock(RANGE_MODULE, async () => {
      const actual = (await vi.importActual(RANGE_MODULE)) as Record<string, unknown>;
      return {
        ...actual,
        loadStoreOrdersInRange: (database: unknown, sellerId: string) => (actual.loadStoreOrdersFull as (d: unknown, s: string) => unknown)(database, sellerId),
        loadSellerEntriesForOrders: (database: unknown, sellerId: string) => (actual.loadSellerEntriesFull as (d: unknown, s: string) => unknown)(database, sellerId)
      };
    });
  } else {
    vi.doUnmock(RANGE_MODULE);
  }
  const mod = (await import(STORE_API_MODULE)) as { handleStoreApiRequest: (req: unknown, res: unknown, deps: unknown) => Promise<void> };
  const response = makeResponse();
  await mod.handleStoreApiRequest(makeRequest(`/${resource}`, { sellerId: SELLER, key: KEY, ...query }), response, { db, now: () => NOW });
  return response;
}

afterEach(() => {
  vi.doUnmock(RANGE_MODULE);
  vi.resetModules();
});

const RANGES: Array<[string, Record<string, string>]> = [
  ["un dia", { from: "2026-11-10", to: "2026-11-10" }],
  ["varios dias", { from: "2026-11-03", to: "2026-11-09" }],
  ["solo desde", { from: "2026-11-18" }],
  ["solo hasta", { to: "2026-11-02" }],
  ["dia sin pedidos", { from: "2026-12-01", to: "2026-12-01" }],
  ["con estado", { from: "2026-11-01", to: "2026-11-20", status: "delivered" }],
  ["con limite", { from: "2026-11-01", to: "2026-11-20", limit: "7" }],
  ["fecha no ISO (cae a la carga completa)", { from: "2026-11-5", to: "2026-11-10" }],
  ["fin de mes", { from: "2026-11-30", to: "2026-12-01" }],
  ["sin rango", { limit: "300" }]
];

describe("023/RF_11 — la respuesta es identica a la de la carga completa", () => {
  for (const [label, query] of RANGES) {
    it(`/orders, ${label}`, async () => {
      const targeted = await call(seededDb(), "orders", query, "targeted");
      const full = await call(seededDb(), "orders", query, "full");
      expect(targeted.statusCode).toBe(200);
      expect(full.statusCode).toBe(200);
      expect(targeted.body).toEqual(full.body);
    });
    it(`/kpis, ${label}`, async () => {
      const targeted = await call(seededDb(), "kpis", query, "targeted");
      const full = await call(seededDb(), "kpis", query, "full");
      expect(targeted.statusCode).toBe(200);
      expect(targeted.body).toEqual(full.body);
    });
  }

  it("el control funciona: la respuesta de un dia trae pedidos con pagos de los tres tipos", async () => {
    const response = await call(seededDb(), "orders", { from: "2026-11-10", to: "2026-11-10" }, "targeted");
    const body = response.body as { total: number; pedidos: Array<{ pago: Record<string, unknown> }> };
    expect(body.total).toBe(6);
    const shapes = new Set(body.pedidos.map((order) => JSON.stringify(order.pago)));
    expect(shapes.size).toBeGreaterThan(2);
  });

  it("el control funciona: el oraculo de verdad lee la tienda entera", async () => {
    const db = seededDb();
    await call(db, "orders", { from: "2026-11-10", to: "2026-11-10" }, "full");
    expect(db.readsOf("orders")).toBe(20 * 6 + 30);
    expect(db.queries.some((query) => query.collection === "walletEntries" && query.filters.some(([field]) => field === "ownerId"))).toBe(true);
  });
});

describe("023/RF_09 — solo se leen los pedidos del rango", () => {
  it("un dia lee los 6 pedidos de ese dia, no los de la tienda entera", async () => {
    const db = seededDb();
    await call(db, "orders", { from: "2026-11-10", to: "2026-11-10" }, "targeted");
    expect(db.readsOf("orders")).toBe(6);
    const orderQuery = db.queries.find((query) => query.collection === "orders");
    expect(orderQuery?.filters).toEqual([
      ["sellerId", "==", SELLER],
      ["createdAt", ">=", "2026-11-10"],
      ["createdAt", "<", "2026-11-11"]
    ]);
  });

  it("/kpis de un dia tampoco lee la tienda entera", async () => {
    const db = seededDb();
    await call(db, "kpis", { from: "2026-11-10", to: "2026-11-10" }, "targeted");
    expect(db.readsOf("orders")).toBe(6);
  });

  it("sin rango, /orders sigue leyendo la tienda entera, como antes", async () => {
    const db = seededDb();
    await call(db, "orders", {}, "targeted");
    expect(db.readsOf("orders")).toBe(20 * 6 + 30);
  });

  it("sin rango, los asientos tambien salen de la consulta de la tienda (por lotes leeria mas)", async () => {
    const db = seededDb();
    await call(db, "orders", { limit: "300" }, "targeted");
    expect(db.queries.some((query) => query.collection === "walletEntries" && query.filters.some(([, op]) => op === "in"))).toBe(false);
  });
});

describe("023/RF_10 — solo se leen los asientos de los pedidos devueltos", () => {
  it("no consulta los asientos de la tienda entera", async () => {
    const db = seededDb();
    await call(db, "orders", { from: "2026-11-10", to: "2026-11-10" }, "targeted");
    const walletQueries = db.queries.filter((query) => query.collection === "walletEntries");
    expect(walletQueries.every((query) => query.filters.length === 1 && query.filters[0][0] === "orderId" && query.filters[0][1] === "in")).toBe(true);
    // 6 pedidos x 5 asientos de todos los duenos.
    expect(db.readsOf("walletEntries")).toBe(30);
  });

  it("con limite, pide solo los asientos de los pedidos que devuelve", async () => {
    const db = seededDb();
    await call(db, "orders", { from: "2026-11-01", to: "2026-11-20", limit: "7" }, "targeted");
    expect(db.readsOf("walletEntries")).toBe(7 * 5);
  });

  it("pide los ids en lotes de 30 como mucho", async () => {
    const db = seededDb();
    await call(db, "orders", { from: "2026-11-01", to: "2026-11-20" }, "targeted");
    const batches = db.queries.filter((query) => query.collection === "walletEntries").map((query) => (query.filters[0][2] as string[]).length);
    expect(Math.max(...batches)).toBeLessThanOrEqual(30);
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(120);
  });
});

describe("023/RF_12 — un lote de asientos que falla no da un pago incompleto", () => {
  it("la peticion falla en vez de responder 200", async () => {
    const db = seededDb();
    db.failWalletIn = true;
    const response = makeResponse();
    vi.resetModules();
    const mod = (await import(STORE_API_MODULE)) as { handleStoreApiRequest: (req: unknown, res: unknown, deps: unknown) => Promise<void> };
    await expect(
      mod.handleStoreApiRequest(makeRequest("/orders", { sellerId: SELLER, key: KEY, from: "2026-11-10", to: "2026-11-10" }), response, { db, now: () => NOW })
    ).rejects.toThrow();
    expect(response.statusCode).not.toBe(200);
    expect(response.body).toBeUndefined();
  });
});

describe("023/RNF_02 — duplicar el historico no cambia lo que lee un dia", () => {
  it("las lecturas de un dia son las mismas con 30 o con 3.000 pedidos viejos", async () => {
    const small = seededDb({ extraHistory: 30 });
    const big = seededDb({ extraHistory: 3_000 });
    await call(small, "orders", { from: "2026-11-10", to: "2026-11-10" }, "targeted");
    await call(big, "orders", { from: "2026-11-10", to: "2026-11-10" }, "targeted");
    expect(big.docsRead).toBe(small.docsRead);
  });
});
