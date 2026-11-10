#!/usr/bin/env node
/**
 * Spec 023, fase A — comparacion contra produccion, SOLO LECTURA.
 *
 *   cd functions && npm run build && cd .. && node scripts/verify-023.js compare
 *
 * Corre el handler compilado de la Store API (`functions/lib/store-api.js`) contra Firestore de
 * produccion dos veces por caso: con los cargadores dirigidos (lo nuevo) y con los de antes
 * (`loadStoreOrdersFull` / `loadSellerEntriesFull`, puestos en su lugar). Compara la respuesta
 * entera (RF_11) y cuenta los documentos que lee cada una (RNF_04). No pasa por la autenticacion de la
 * API: el `db` envuelto responde la config de la tienda con una key de prueba que no sale de este proceso.
 *
 * Los casos son las consultas que las integraciones hacen de verdad (logs de `storeapi` del 2026-11-10).
 */
const path = require("path");
const crypto = require("crypto");

const functionsDir = path.join(__dirname, "..", "functions");
const admin = require(path.join(functionsDir, "node_modules", "firebase-admin"));
admin.initializeApp({ projectId: "kentro-last-mile" });
const realDb = admin.firestore();

const range = require(path.join(functionsDir, "lib", "store-api-range.js"));
const { handleStoreApiRequest } = require(path.join(functionsDir, "lib", "store-api.js"));

const targeted = {
  loadStoreOrdersInRange: range.loadStoreOrdersInRange,
  loadSellerEntriesForOrders: range.loadSellerEntriesForOrders
};
function useLoaders(kind) {
  if (kind === "full") {
    range.loadStoreOrdersInRange = (db, sellerId) => range.loadStoreOrdersFull(db, sellerId);
    range.loadSellerEntriesForOrders = (db, sellerId) => range.loadSellerEntriesFull(db, sellerId);
  } else {
    Object.assign(range, targeted);
  }
}

const TEST_KEY = crypto.randomBytes(24).toString("hex");

/** Envuelve el db real: cuenta documentos leidos y sustituye la config de la API por una con TEST_KEY. */
function countingDb(sellerId, sellerName) {
  const counter = { docs: 0, queries: 0 };
  const wrapQuery = (query) =>
    new Proxy(query, {
      get(target, prop) {
        if (prop === "where" || prop === "limit" || prop === "orderBy" || prop === "select") {
          return (...args) => wrapQuery(target[prop](...args));
        }
        if (prop === "get") {
          return async () => {
            const snap = await target.get();
            counter.queries += 1;
            counter.docs += Math.max(snap.size, 1);
            return snap;
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  const db = {
    collection(name) {
      const collection = realDb.collection(name);
      const wrapped = wrapQuery(collection);
      return new Proxy(wrapped, {
        get(target, prop) {
          if (prop === "doc") {
            return (id) => {
              const ref = collection.doc(id);
              if (name === "storeApiConfigs" && id === sellerId) {
                return { id, get: async () => ({ id, exists: true, data: () => ({ sellerId, sellerName, apiKey: TEST_KEY, status: "active" }), get: () => undefined }) };
              }
              return new Proxy(ref, {
                get(refTarget, refProp) {
                  if (refProp === "get") {
                    return async () => {
                      counter.docs += 1;
                      return refTarget.get();
                    };
                  }
                  const value = refTarget[refProp];
                  return typeof value === "function" ? value.bind(refTarget) : value;
                }
              });
            };
          }
          return target[prop];
        }
      });
    },
    async getAll(...refs) {
      counter.docs += refs.length;
      return realDb.getAll(...refs);
    }
  };
  return { db, counter };
}

function response() {
  const res = { statusCode: 0, body: undefined };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  res.send = res.json;
  res.set = () => res;
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}

async function run(kind, sellerId, sellerName, resource, query) {
  useLoaders(kind);
  const { db, counter } = countingDb(sellerId, sellerName);
  const res = response();
  const fullQuery = { sellerId, key: TEST_KEY, ...query };
  const lookup = () => undefined;
  const started = Date.now();
  await handleStoreApiRequest({ method: "GET", path: `/${resource}`, url: `/${resource}`, query: fullQuery, headers: {}, get: lookup, header: lookup }, res, { db });
  return { res, counter, ms: Date.now() - started };
}

const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const CASES = [
  ["seller-1779315416119", "DANDA", "orders", { limit: "1000", from: today, to: today }],
  ["seller-1779315416119", "DANDA", "orders", { limit: "1000", from: "2026-10-14", to: "2026-10-14" }],
  ["seller-1779315416119", "DANDA", "orders", { limit: "1000", from: "2026-11-03", to: "2026-11-09" }],
  ["seller-1779315416119", "DANDA", "kpis", { from: "2026-11-01", to: today }],
  ["seller-1778271867877", "Kovia", "orders", { limit: "1000", from: today, to: today }],
  ["seller-1778271867877", "Kovia", "orders", { limit: "1000", from: "2026-09-26", to: today }],
  ["seller-1778271867877", "Kovia", "orders", { limit: "300" }],
  ["seller-1791232545779", "Infinito", "orders", { limit: "1000", from: "2026-11-07", to: today }]
];

/** Quita lo que depende de la hora de la llamada y no del dato. */
function stable(body) {
  return JSON.stringify(body, (key, value) => (key === "generadoEn" || key === "now" ? undefined : value));
}

(async () => {
  if (process.argv[2] !== "compare") {
    console.error("uso: node scripts/verify-023.js compare");
    process.exit(2);
  }
  let failures = 0;
  const rows = [];
  for (const [sellerId, name, resource, query] of CASES) {
    const before = await run("full", sellerId, name, resource, query);
    const after = await run("targeted", sellerId, name, resource, query);
    const same = before.res.statusCode === after.res.statusCode && stable(before.res.body) === stable(after.res.body);
    if (!same) failures += 1;
    const total = after.res.body && typeof after.res.body === "object" ? after.res.body.total ?? "-" : "-";
    rows.push({
      tienda: name,
      ruta: `/${resource}?${new URLSearchParams(query)}`,
      http: `${before.res.statusCode}/${after.res.statusCode}`,
      pedidos: total,
      lecturasAntes: before.counter.docs,
      lecturasDespues: after.counter.docs,
      msAntes: before.ms,
      msDespues: after.ms,
      identica: same ? "si" : "NO"
    });
  }
  console.table(rows);
  console.log(JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  if (failures > 0) {
    console.error(`${failures} caso(s) con respuesta distinta`);
    process.exit(1);
  }
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
