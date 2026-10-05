#!/usr/bin/env node
/**
 * Spec 029 — medicion en produccion (`specs/029_store_api_confirma_y_corrige_pedidos.md`).
 *
 *   node scripts/verify-029.js baseline      (T1) linea base SOLO LECTURA -> t1-linea-base.txt
 *   node scripts/verify-029.js query-check   (T2) consultas nuevas con limit(1), SOLO LECTURA -> t2-query-check.txt
 *   node scripts/verify-029.js capture-reads (T24) GET de la Store API de las tiendas reales con su key de
 *                                            LECTURA, rango cerrado del pasado -> t24-reads-antes.json (huellas)
 *
 *   kovia-replay                             (T25) ESCRIBE en produccion, solo sobre la tienda de pruebas. Lo
 *                                            ejecuta `run-all` (T27) pasandole la key de escritura en memoria;
 *                                            lanzado a mano desde la linea de comandos aborta antes de escribir.
 *
 * Los modos que escriben (T25 `kovia-replay`, T27 `set-history-since`/`run-all`/`cleanup`) se declaran en
 * WRITE_MODES. La guarda de T25 (src/lib/spec-029-guards.test.ts) exige que toda llamada de escritura de
 * Firestore viva en el cierre de uno de esos modos o en `safeDelete`, y que ningun modo de solo lectura
 * alcance una funcion que escriba. Fuera de esos cierres no hay literales de llamada de escritura, incluidos
 * Map/Set con esos mismos nombres: por eso se agrupa con objetos planos y `reduce`.
 *
 * Salvaguardas de todo lo que escribe (plan 5.3 (a)-(d)): ids sinteticos declarados UNA vez (abajo);
 * `assertNotExists` justo antes de cada envio por webhook; `recordCreated` anota en el registro (solo ids)
 * ANTES de crear nada; `safeDelete` es el unico sitio que borra y comprueba la pertenencia con
 * SAFE_DELETE_RULES. Los secretos (keys, contrasenas, secreto de Shopify) viven solo en memoria.
 *
 * Escribe una evidencia local (archivo del repo, no Firestore):
 *   .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t1-linea-base.txt
 *
 * Compuertas de T1 (specs/029_tasks.md):
 *   - shopifyOrderId mixto (texto y numero) -> T10 consulta con `in [texto, numero]`.
 *   - cortes con cashAllocations[].orderId fuera de orderIds > 0 -> parar T9/T10 (plan 2.10).
 *   - ChatBy (uchat-pull.ts / uchat-webhook.ts) confirmando fuera de transaccion -> reportar antes de T6.
 *   - auditEvents historicos de la lista permitida (plan 2.7) cuyo summary nombra a alguien -> reportar
 *     antes de T14.
 *
 * Usa ADC con las librerias de functions/node_modules. storeApiConfigs se lee para saber si hay key, nunca
 * para mostrarla: la key solo se toca con Boolean / typeof.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

if (admin.apps.length === 0) admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

/** Modos que escriben en Firestore. `baseline`, `query-check` y `capture-reads` nunca. */
const WRITE_MODES = ["kovia-replay", "set-history-since", "run-all", "cleanup"];

// Ids sinteticos de la verificacion (plan 5.3 (b)). Cada literal aparece UNA sola vez en el guion: el resto
// los usa por nombre, y la guarda de T25 lo comprueba.
const TEST_SELLER_ID = "seller-test-029";
const TEST_SHOP_DOMAIN = "kentro-test-029.myshopify.com";
const TEST_DRIVER_ID = "driver-test-029";
const TEST_ORDER_NUMBER_PREFIX = "TEST-029-";
const TEST_EXTERNAL_ID_PREFIX = "test-029-";
// Rango reservado de ids numericos de Shopify, muy por encima de los ids reales de las tiendas.
const SHOPIFY_TEST_ID_MIN = 9029000000000;
const SHOPIFY_TEST_ID_MAX = 9029000000999;
/** Prefijo de los documentos de idempotencia y de limite de tasa de la tienda de pruebas (plan 2.8, 2.9). */
const TEST_SELLER_DOC_PREFIX = `${TEST_SELLER_ID}__`;

const FUNCTIONS_BASE_URL = "https://us-central1-kentro-last-mile.cloudfunctions.net";
const SHOPIFY_WEBHOOK_URL = `${FUNCTIONS_BASE_URL}/shopifyWebhook`;
const STORE_ORDER_WEBHOOK_URL = `${FUNCTIONS_BASE_URL}/storeOrderWebhook`;

const EVIDENCE_DIR = path.join(__dirname, "../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos");
const BASELINE_FILE = path.join(EVIDENCE_DIR, "t1-linea-base.txt");
const QUERY_CHECK_FILE = path.join(EVIDENCE_DIR, "t2-query-check.txt");

/** Los tres estados en los que la tienda puede corregir un pedido (spec 029). */
const EDITABLE_STATUSES = ["imported", "address_risk", "ready_to_assign"];

/** Lista permitida de acciones cuyo summary se ensena a la tienda (plan 2.7). */
const SUMMARY_ALLOWED_ACTIONS = [
  "order.seller_confirmed",
  "order.imported_updated",
  "order.cancelled",
  "order.retry_confirmed",
  "order.transition",
  "order.delivered",
  "order.failed",
  "order.retry_scheduled",
  "order.webhook_imported",
  "order.manual_created",
  "order.confirmed_uchat",
  "order.failed_classified",
  "order.delivery_corrected",
  "order.address_reviewed",
  "order.picked_up"
];

const UCHAT_SOURCES = ["functions/src/uchat-pull.ts", "functions/src/uchat-webhook.ts"];
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MIN_NAME_LENGTH = 4;

const countBy = (items, keyOf) =>
  items.reduce((acc, item) => {
    const key = keyOf(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
const groupBy = (items, keyOf) =>
  items.reduce((acc, item) => {
    const key = keyOf(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
const sortedEntries = (record) => Object.entries(record).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const hasValue = (value) => value !== undefined && value !== null && value !== "";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lectura contada: cada consulta suma sus documentos al presupuesto que se reporta. */
function createReader() {
  const log = [];
  async function read(label, query) {
    const started = Date.now();
    const snap = await query.get();
    log.push({ label, docs: snap.size, ms: Date.now() - started });
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  return { read, log };
}

/** Tipo guardado de shopifyOrderId: texto / numero / ausente / otro. */
function shopifyIdKind(value) {
  if (value === undefined || value === null || value === "") return "ausente";
  if (typeof value === "string") return "texto";
  if (typeof value === "number") return "numero";
  return `otro (${typeof value})`;
}

/** Clasificacion de una tienda segun los tipos presentes entre sus pedidos con shopifyOrderId. */
function storeShopifyClass(kinds) {
  const present = ["texto", "numero"].filter((kind) => (kinds[kind] || 0) > 0);
  const others = Object.keys(kinds).filter((kind) => kind.startsWith("otro"));
  if (others.length > 0) return "mixto";
  if (present.length === 2) return "mixto";
  if (present.length === 1) return present[0];
  return "sin shopifyOrderId";
}

/**
 * Comprueba en el fuente (sin comentarios) que cada escritura `status: "ready_to_assign"` cae dentro del
 * callback de una transaccion de Firestore y se hace con el objeto `transaction`.
 */
function confirmsInsideTransaction(relativePath) {
  const raw = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const transactionStarts = [...source.matchAll(/runTransaction\s*\(/g)].map((match) => match.index + match[0].length - 1);
  const writes = [...source.matchAll(/status:\s*["']ready_to_assign["']/g)].map((match) => match.index);
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const results = writes.map((writeIndex) => {
    const opener = transactionStarts.filter((start) => start < writeIndex).pop();
    let depth = 0;
    if (opener !== undefined) {
      for (let cursor = opener; cursor < writeIndex; cursor += 1) {
        if (source[cursor] === "(") depth += 1;
        else if (source[cursor] === ")") depth -= 1;
      }
    }
    // La escritura va por el objeto de la transaccion en la misma linea o en la siguiente sentencia
    // (uchat-webhook.ts arma `updated` y lo escribe en la linea de abajo).
    const lineStart = source.lastIndexOf("\n", writeIndex) + 1;
    const usesTransactionObject = /\btransaction\.\w+\s*\(/.test(source.slice(lineStart, writeIndex + 300));
    return { line: lineOf(writeIndex), insideTransaction: opener !== undefined && depth > 0, usesTransactionObject };
  });
  return { relativePath, transactions: transactionStarts.length, writes: results, ok: results.length > 0 && results.every((item) => item.insideTransaction && item.usesTransactionObject) };
}

/** Identidades de Kentro conocidas: ids, correos y nombres de personas (usuarios, lideres, mensajeros). */
async function loadIdentities(reader, storeNames) {
  const [drivers, messengers] = await Promise.all([
    reader.read("drivers (nombres)", db.collection("drivers").select("name", "email")),
    reader.read("messengers (nombres)", db.collection("messengers").select("name", "email"))
  ]);
  const authUsers = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    authUsers.push(...page.users.map((user) => ({ id: user.uid, name: user.displayName, email: user.email })));
    pageToken = page.pageToken;
  } while (pageToken);
  reader.log.push({ label: "auth listUsers", docs: authUsers.length, ms: 0 });
  const people = [...drivers, ...messengers, ...authUsers];
  const ids = [...new Set(people.map((person) => person.id).filter((id) => typeof id === "string" && id.length >= 8))];
  // Una cuenta de tienda se llama como la tienda ("OnStok"): ese nombre no es una persona de Kentro y la
  // tienda ya lo ve en sus propios summaries ("importado desde webhook OnStok").
  const isStoreName = (name) => storeNames.includes(name.toLowerCase());
  const allNames = [...new Set(people.map((person) => String(person.name ?? "").trim()).filter((name) => name.length >= MIN_NAME_LENGTH))];
  const names = allNames.filter((name) => !isStoreName(name));
  return { ids, names, storeNamesSkipped: allNames.length - names.length, people: people.length };
}

/** Por que un summary nombra a alguien, o null. */
function identityInSummary(summary, identities, extraIds) {
  if (!summary) return null;
  if (EMAIL_PATTERN.test(summary)) return "correo";
  const ids = [...identities.ids, ...extraIds];
  const id = ids.find((candidate) => summary.includes(candidate));
  if (id) return "id de persona";
  const name = identities.names.find((candidate) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(candidate)}($|[^\\p{L}])`, "iu").test(summary));
  if (name) return "nombre de persona";
  return null;
}

const normalizeSummary = (summary) => String(summary ?? "").replace(/[0-9A-Za-z_-]*\d[0-9A-Za-z_-]*/g, "#");

async function baseline() {
  const now = new Date();
  const reader = createReader();
  const lines = [];
  const say = (text = "") => lines.push(text);

  const [orders, cities, auditEvents, storeConfigs, settlements, sellers] = await Promise.all([
    reader.read("orders (select)", db.collection("orders").select("sellerId", "shopifyOrderId", "status", "driverId", "messengerId")),
    reader.read("cities", db.collection("cities")),
    reader.read("auditEvents (select)", db.collection("auditEvents").select("action", "actorRole", "actorId", "summary", "entityId", "createdAt")),
    reader.read("storeApiConfigs", db.collection("storeApiConfigs")),
    reader.read("settlements (select)", db.collection("settlements").select("kind", "status", "ownerId", "orderIds", "cashAllocations")),
    reader.read("sellers (nombres)", db.collection("sellers").select("name"))
  ]);
  const sellerName = sellers.reduce((acc, seller) => ({ ...acc, [seller.id]: seller.name || seller.id }), {});
  const identities = await loadIdentities(reader, Object.values(sellerName).map((name) => String(name).trim().toLowerCase()));
  const labelOf = (sellerId) => `${sellerName[sellerId] ?? "?"} (${sellerId})`;

  say("# Spec 029 — T1 linea base (solo lectura)");
  say(`Generado: ${now.toISOString()} · proyecto kentro-last-mile`);
  say("");

  // ---- 1. shopifyOrderId por tienda ----
  say("## 1. Tipo guardado de shopifyOrderId por tienda (sellerId)");
  const ordersBySeller = groupBy(orders, (order) => String(order.sellerId ?? "(sin sellerId)"));
  const storeClasses = {};
  for (const [sellerId, sellerOrders] of sortedEntries(ordersBySeller)) {
    const kinds = countBy(sellerOrders, (order) => shopifyIdKind(order.shopifyOrderId));
    const klass = storeShopifyClass(kinds);
    storeClasses[sellerId] = klass;
    const numericText = sellerOrders.filter((order) => typeof order.shopifyOrderId === "string" && /^\d+$/.test(order.shopifyOrderId)).length;
    const detail = sortedEntries(kinds).map(([kind, count]) => `${kind}=${count}`).join(", ");
    say(`- ${labelOf(sellerId)}: ${klass} · ${detail} · texto solo-digitos=${numericText}`);
  }
  const globalKinds = countBy(orders.filter((order) => hasValue(order.shopifyOrderId)), (order) => shopifyIdKind(order.shopifyOrderId));
  const mixedStores = Object.entries(storeClasses).filter(([, klass]) => klass === "mixto").map(([sellerId]) => sellerId);
  const globalMixed = Object.keys(globalKinds).length > 1;
  say(`Global (con shopifyOrderId): ${sortedEntries(globalKinds).map(([kind, count]) => `${kind}=${count}`).join(", ") || "ninguno"}`);
  say(`Tiendas mixto: ${mixedStores.length}${mixedStores.length ? ` (${mixedStores.map(labelOf).join(", ")})` : ""} · global mixto: ${globalMixed ? "si" : "no"}`);
  say("");

  // ---- 2. Pedidos por estado con / sin driverId ----
  say("## 2. Pedidos por estado, con / sin driverId (lider) y messengerId");
  const byStatus = groupBy(orders, (order) => String(order.status ?? "(sin status)"));
  for (const [status, statusOrders] of sortedEntries(byStatus)) {
    const withDriver = statusOrders.filter((order) => hasValue(order.driverId)).length;
    const withMessenger = statusOrders.filter((order) => hasValue(order.messengerId)).length;
    const mark = EDITABLE_STATUSES.includes(status) ? " [editable]" : "";
    say(`- ${status}${mark}: ${statusOrders.length} · con driverId=${withDriver} · sin driverId=${statusOrders.length - withDriver} · con messengerId=${withMessenger}`);
  }
  say("Editables por tienda:");
  for (const status of EDITABLE_STATUSES) {
    const statusOrders = byStatus[status] ?? [];
    const perSeller = groupBy(statusOrders, (order) => String(order.sellerId ?? "(sin sellerId)"));
    say(`  ${status}: ${statusOrders.length}`);
    for (const [sellerId, sellerOrders] of sortedEntries(perSeller)) {
      const withDriver = sellerOrders.filter((order) => hasValue(order.driverId)).length;
      say(`    - ${labelOf(sellerId)}: ${sellerOrders.length} (con driverId=${withDriver}, sin driverId=${sellerOrders.length - withDriver})`);
    }
  }
  const riskWithLeader = (byStatus["address_risk"] ?? []).filter((order) => hasValue(order.driverId));
  say(`address_risk con lider (driverId): ${riskWithLeader.length}${riskWithLeader.length ? ` -> ${riskWithLeader.map((order) => order.id).join(", ")}` : ""}`);
  say("");

  // ---- 3. cities ----
  say("## 3. cities");
  const activeCities = cities.filter((city) => city.active === true);
  for (const city of cities) say(`- ${city.id}: ${city.name ?? "?"} · active=${city.active === true}`);
  say(`cities activas: ${activeCities.length} de ${cities.length} (${activeCities.map((city) => city.name ?? city.id).join(", ")})`);
  say("");

  // ---- 4. auditEvents por action y actorRole ----
  say("## 4. auditEvents por action y por presencia de actorRole");
  say(`Total auditEvents: ${auditEvents.length}`);
  const byAction = groupBy(auditEvents, (event) => String(event.action ?? "(sin action)"));
  for (const [action, events] of sortedEntries(byAction)) {
    const withRole = events.filter((event) => hasValue(event.actorRole)).length;
    const roles = sortedEntries(countBy(events.filter((event) => hasValue(event.actorRole)), (event) => String(event.actorRole)))
      .map(([role, count]) => `${role}=${count}`)
      .join(", ");
    const allowed = SUMMARY_ALLOWED_ACTIONS.includes(action) ? " [lista permitida]" : "";
    say(`- ${action}${allowed}: ${events.length} · con actorRole=${withRole} · sin actorRole=${events.length - withRole}${roles ? ` · ${roles}` : ""}`);
  }
  say("");

  // ---- 4b. summary con identidad en la lista permitida (compuerta T14) ----
  say("## 4b. summary de la lista permitida (plan 2.7) que nombra a alguien");
  const actorIds = [...new Set(auditEvents.map((event) => event.actorId).filter((id) => typeof id === "string" && id.length >= 8 && !id.startsWith("uchat")))];
  const allowedEvents = auditEvents.filter((event) => SUMMARY_ALLOWED_ACTIONS.includes(String(event.action)));
  const flagged = allowedEvents
    .map((event) => ({ event, reason: identityInSummary(String(event.summary ?? ""), identities, actorIds) }))
    .filter((item) => item.reason !== null);
  say(`Identidades comparadas: ${identities.people} personas (auth + drivers + messengers), ${identities.names.length} nombres (${identities.storeNamesSkipped} descartados por ser el nombre de una tienda), ${identities.ids.length + actorIds.length} ids, mas patron de correo`);
  say(`Eventos de la lista permitida: ${allowedEvents.length} · con identidad en summary: ${flagged.length}`);
  for (const { event, reason } of flagged) say(`  - ${event.id} · ${event.action} · ${reason} · ${event.createdAt ?? ""} · "${event.summary}"`);
  say("Plantillas de summary de la lista permitida (cifras e ids como #):");
  const templates = countBy(allowedEvents, (event) => `${event.action} | ${normalizeSummary(event.summary)}`);
  for (const [template, count] of sortedEntries(templates)) say(`  ${count} · ${template.length > 220 ? `${template.slice(0, 220)}...` : template}`);
  say("");

  // ---- 5. storeApiConfigs (sin keys) ----
  say("## 5. storeApiConfigs (solo presencia y status; la key no se imprime)");
  for (const config of storeConfigs) {
    const hasKey = Boolean(config.apiKey);
    const keyType = typeof config.apiKey;
    say(`- ${config.id}: sellerId=${config.sellerId ?? "?"} (${config.sellerName ?? sellerName[config.sellerId] ?? "?"}) · status=${config.status ?? "(sin status)"} · key presente=${hasKey ? "si" : "no"} (${keyType}) · actualizado=${config.updatedAt ?? "?"}`);
  }
  say(`storeApiConfigs: ${storeConfigs.length}`);
  say("");

  // ---- 6. cashAllocations fuera de orderIds (plan 2.10) ----
  say("## 6. settlements con algun cashAllocations[].orderId fuera de su orderIds (plan 2.10, esperado 0)");
  const withAllocations = settlements.filter((settlement) => Array.isArray(settlement.cashAllocations) && settlement.cashAllocations.length > 0);
  const outside = settlements
    .map((settlement) => {
      const members = Array.isArray(settlement.orderIds) ? settlement.orderIds.map(String) : [];
      const allocations = Array.isArray(settlement.cashAllocations) ? settlement.cashAllocations : [];
      const strays = allocations.map((allocation) => allocation && allocation.orderId).filter((orderId) => hasValue(orderId) && !members.includes(String(orderId)));
      return { id: settlement.id, kind: settlement.kind, status: settlement.status, strays: [...new Set(strays.map(String))] };
    })
    .filter((item) => item.strays.length > 0);
  say(`Cortes: ${settlements.length} · con cashAllocations: ${withAllocations.length}`);
  say(`cashAllocations fuera de orderIds: ${outside.length}`);
  for (const item of outside) say(`  - ${item.id} (${item.kind}/${item.status}): ${item.strays.join(", ")}`);
  say("");

  // ---- 7. ChatBy confirma dentro de una transaccion ----
  say("## 7. ChatBy confirma dentro de una transaccion de Firestore (comprobacion en codigo)");
  const uchatChecks = UCHAT_SOURCES.map(confirmsInsideTransaction);
  for (const check of uchatChecks) {
    const name = path.basename(check.relativePath);
    const detail = check.writes.map((write) => `linea ${write.line}: dentro=${write.insideTransaction ? "si" : "no"}, via transaction=${write.usesTransactionObject ? "si" : "no"}`).join("; ");
    say(`- ${name}: transacciones=${check.transactions} · escrituras ready_to_assign=${check.writes.length} · ${detail || "ninguna"} -> ${check.ok ? "OK" : "FALLA"}`);
  }
  say("");

  // ---- Compuertas ----
  const chatbyOutside = uchatChecks.filter((check) => !check.ok).map((check) => path.basename(check.relativePath));
  say("## Compuertas de T1");
  say(`- shopifyOrderId mixto: ${mixedStores.length > 0 || globalMixed ? "SI -> T10 consulta con in [texto, numero]" : "no -> igualdad simple"}`);
  say(`- cashAllocations fuera de orderIds > 0: ${outside.length > 0 ? `SI (${outside.length}) -> parar T9/T10` : "no"}`);
  say(`- ChatBy sin transaccion: ${chatbyOutside.length > 0 ? `SI (${chatbyOutside.join(", ")}) -> reportar antes de T6` : "no"}`);
  say(`- accion historica con identidad en summary dentro de la lista permitida: ${flagged.length > 0 ? `SI (${flagged.length}) -> reportar antes de T14` : "no"}`);
  say("");

  say("## Lecturas");
  for (const entry of reader.log) say(`- ${entry.label}: ${entry.docs} docs · ${entry.ms} ms`);
  say(`Total documentos leidos: ${reader.log.reduce((total, entry) => total + entry.docs, 0)}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_FILE, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nEvidencia: ${path.relative(process.cwd(), BASELINE_FILE)}`);
}

async function queryCheck() {
  // Firestore pide un indice compuesto: gRPC 9 FAILED_PRECONDITION con "requires an index".
  const needsIndex = (problem) => {
    const message = String(problem && problem.message ? problem.message : "");
    return Boolean(problem) && (problem.code === 9 || /FAILED_PRECONDITION/.test(message) || /requires an index/.test(message));
  };
  // Enlace de creacion del indice que propone Firestore, si viene en el mensaje.
  const indexLink = (problem) => {
    const match = String(problem && problem.message ? problem.message : "").match(/https:\/\/console\.firebase\.google\.com\S+/);
    return match ? match[0] : "(sin enlace)";
  };
  const now = new Date();
  const lines = [];
  const say = (text = "") => lines.push(text);

  // Un pedido real con sellerId y shopifyOrderId para que las consultas apunten a datos existentes.
  const candidates = await db.collection("orders").where("status", "==", "delivered").limit(50).get();
  const sample = candidates.docs.find((doc) => hasValue(doc.get("sellerId")) && hasValue(doc.get("shopifyOrderId"))) ?? candidates.docs[0];
  if (!sample) throw new Error("query-check: no hay pedido de muestra");
  const orderId = sample.id;
  const sellerId = sample.get("sellerId");
  const shopifyOrderId = sample.get("shopifyOrderId");

  const checks = [
    { collection: "orders", label: "orders/{id} (lectura por id)", run: () => db.collection("orders").doc(orderId).get() },
    {
      collection: "orders",
      label: "orders where sellerId == + shopifyOrderId ==",
      run: () => db.collection("orders").where("sellerId", "==", sellerId).where("shopifyOrderId", "==", shopifyOrderId).limit(1).get()
    },
    { collection: "walletEntries", label: "walletEntries where orderId ==", run: () => db.collection("walletEntries").where("orderId", "==", orderId).limit(1).get() },
    { collection: "settlements", label: "settlements where orderIds array-contains", run: () => db.collection("settlements").where("orderIds", "array-contains", orderId).limit(1).get() },
    { collection: "orderHistory", label: "orderHistory where orderId == (sin orden: se ordena en memoria)", run: () => db.collection("orderHistory").where("orderId", "==", orderId).limit(1).get() },
    { collection: "auditEvents", label: "auditEvents where entityId ==", run: () => db.collection("auditEvents").where("entityId", "==", orderId).limit(1).get() },
    { collection: "cities", label: "cities where active ==", run: () => db.collection("cities").where("active", "==", true).limit(1).get() }
  ];

  say("# Spec 029 — T2 query-check (solo lectura, limit(1))");
  say(`Generado: ${now.toISOString()} · proyecto kentro-last-mile`);
  say(`Pedido de muestra: ${orderId} · sellerId=${sellerId} · shopifyOrderId=${shopifyOrderId} (${typeof shopifyOrderId})`);
  say("");
  say("## Consultas");
  const pending = [];
  for (const check of checks) {
    const started = Date.now();
    try {
      const result = await check.run();
      const docs = typeof result.size === "number" ? result.size : result.exists ? 1 : 0;
      say(`- ${check.label}: ${check.collection} · docs=${docs} · ${Date.now() - started} ms · indice: no`);
    } catch (problem) {
      if (!needsIndex(problem)) throw problem;
      pending.push(check.label);
      say(`- ${check.label}: ${check.collection} · indice: si -> anadir a firestore.indexes.json · ${indexLink(problem)}`);
    }
  }
  say("");

  // Plan 2.10: array-contains sobre orderIds solo basta si ningun corte asigna efectivo fuera de su orderIds.
  say("## cashAllocations fuera de orderIds (plan 2.10, esperado 0)");
  const settlements = (await db.collection("settlements").select("orderIds", "cashAllocations").get()).docs;
  const outside = settlements.filter((doc) => {
    const members = (Array.isArray(doc.get("orderIds")) ? doc.get("orderIds") : []).map(String);
    const allocations = Array.isArray(doc.get("cashAllocations")) ? doc.get("cashAllocations") : [];
    return allocations.some((allocation) => allocation && hasValue(allocation.orderId) && !members.includes(String(allocation.orderId)));
  });
  say(`Cortes: ${settlements.length}`);
  say(`cashAllocations fuera de orderIds: ${outside.length}`);
  for (const doc of outside) say(`  - ${doc.id}`);
  say("");

  say("## Compuerta de T2");
  say(`- consultas que piden indice: ${pending.length > 0 ? `${pending.length} (${pending.join("; ")})` : "ninguna"}`);
  say(`- cashAllocations fuera de orderIds > 0: ${outside.length > 0 ? `SI (${outside.length}) -> parar T9/T10` : "no"}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(QUERY_CHECK_FILE, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nEvidencia: ${path.relative(process.cwd(), QUERY_CHECK_FILE)} (t2-query-check.txt)`);
}

// ---------------------------------------------------------------------------------------------------------
// T24 · capture-reads y compareReads (plan 5.3 "Lecturas reales")
// ---------------------------------------------------------------------------------------------------------

/**
 * Campos que se ignoran al comparar: SOLO marcas de tiempo de la propia respuesta (no datos). Hoy ninguna
 * respuesta de lectura de la Store API lleva una (ni `/kpis`, ni `/orders`, ni `/settlements`, ni `/resumen`,
 * ni el indice), asi que la lista esta vacia y la tolerancia es cero en todo lo que se compara por valor. Si
 * una respuesta llega a incluir su propia hora de generacion, se anade aqui por nombre y en ningun otro sitio.
 */
const IGNORED_RESPONSE_FIELDS = Object.freeze([]);

/** Tiendas que se prefieren para la captura (por nombre, sin distinguir mayusculas). */
const CAPTURE_PREFERRED_STORES = ["kovia", "onep", "danda"];
const CAPTURE_TEST_SELLER = TEST_SELLER_ID;
// Se capturan TODAS las tiendas reales con key de lectura activa: son las unicas que usan la API hoy (el
// 2026-10-05, Kovia y DANDA; ONEP no tiene key). Con menos de dos la comparacion no prueba nada.
const CAPTURE_MIN_STORES = 2;
const CAPTURE_RANGE_DAYS = 30;
const STORE_API_BASE_URL = `${FUNCTIONS_BASE_URL}/storeApi`;

/** JSON con las claves de todo objeto ordenadas: la misma entrada da siempre el mismo texto. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Huella de un pedido o corte: los reales llevan nombre, telefono y direccion de clientes, asi que al repo
 * solo va `{ id, updatedAt, hash }` (sha256 hex del JSON canonico del elemento entero). T27 huellea igual el
 * "despues" y `compareReads` compara la huella por valor: cualquier campo distinto cambia el hash.
 */
function fingerprintItem(item) {
  const source = item && typeof item === "object" ? item : {};
  return {
    id: source.id ?? null,
    updatedAt: source.updatedAt ?? null,
    hash: crypto.hash("sha256", canonicalJson(source))
  };
}

/** Copia de las lecturas de una tienda con `orders.pedidos` y `settlements.liquidaciones` como huellas. */
function fingerprintCapture(store) {
  const copy = { ...store };
  if (store.orders && Array.isArray(store.orders.pedidos)) {
    copy.orders = { ...store.orders, pedidos: store.orders.pedidos.map(fingerprintItem) };
  }
  if (store.settlements && Array.isArray(store.settlements.liquidaciones)) {
    copy.settlements = { ...store.settlements, liquidaciones: store.settlements.liquidaciones.map(fingerprintItem) };
  }
  return copy;
}

const typeTag = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const isPlainObject = (value) => typeTag(value) === "object";

/** Cuerpo sin los campos ignorados de primer nivel (marcas de tiempo de la respuesta). */
function withoutIgnoredFields(body) {
  if (!isPlainObject(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([key]) => !IGNORED_RESPONSE_FIELDS.includes(key)));
}

/** Diferencias por valor, recorriendo objetos y arrays (cero tolerancia). */
function valueDifferences(resource, pathSoFar, before, after) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const childPath = pathSoFar ? `${pathSoFar}.${key}` : key;
      if (!(key in after)) return [{ resource, path: childPath, kind: "missing" }];
      if (!(key in before)) return [{ resource, path: childPath, kind: "added" }];
      return valueDifferences(resource, childPath, before[key], after[key]);
    });
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ resource, path: pathSoFar, kind: "length", before: before.length, after: after.length }];
    return before.flatMap((item, index) => valueDifferences(resource, `${pathSoFar}[${index}]`, item, after[index]));
  }
  if (canonicalJson(before) === canonicalJson(after)) return [];
  return [{ resource, path: pathSoFar, kind: "value", before, after }];
}

/** Diferencias de forma: mismas claves y mismos tipos; los arrays solo como "array" (su largo es estado). */
function shapeDifferences(resource, pathSoFar, before, after) {
  if (typeTag(before) !== typeTag(after)) return [{ resource, path: pathSoFar, kind: "type", before: typeTag(before), after: typeTag(after) }];
  if (!isPlainObject(before)) return [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    const childPath = pathSoFar ? `${pathSoFar}.${key}` : key;
    if (!(key in after)) return [{ resource, path: childPath, kind: "missing" }];
    if (!(key in before)) return [{ resource, path: childPath, kind: "added" }];
    return shapeDifferences(resource, childPath, before[key], after[key]);
  });
}

/**
 * Lista de pedidos o cortes: se compara por id y por valor solo lo que tenia `updatedAt < captureAt` en la
 * captura y conserva ese mismo `updatedAt` despues. Lo demas (movido entre medias, o escrito despues de la
 * captura) se excluye de los dos lados y se cuenta. El sobre de la respuesta se compara por valor salvo
 * `total`, que es el largo de la lista y ya queda cubierto, elemento a elemento, por la comparacion por id.
 */
function compareListResource(resource, listKey, before, after, captureAt) {
  const beforeBody = withoutIgnoredFields(before) ?? {};
  const afterBody = withoutIgnoredFields(after) ?? {};
  const envelope = (body) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== listKey && key !== "total"));
  const differences = valueDifferences(resource, "", envelope(beforeBody), envelope(afterBody));
  const beforeItems = Array.isArray(beforeBody[listKey]) ? beforeBody[listKey] : [];
  const afterItems = Array.isArray(afterBody[listKey]) ? afterBody[listKey] : [];
  const afterById = Object.fromEntries(afterItems.map((item) => [String(item.id), item]));
  const beforeIds = beforeItems.map((item) => String(item.id));
  const captureMs = Date.parse(captureAt);
  const settledBefore = (item) => typeof item.updatedAt === "string" && Date.parse(item.updatedAt) < captureMs;
  const excludedIds = [];
  for (const item of beforeItems) {
    const id = String(item.id);
    const counterpart = afterById[id];
    if (!settledBefore(item)) {
      excludedIds.push(id);
      continue;
    }
    if (!counterpart) {
      differences.push({ resource, path: `${listKey}[id=${id}]`, kind: "missing" });
      continue;
    }
    if (counterpart.updatedAt !== item.updatedAt) {
      excludedIds.push(id);
      continue;
    }
    differences.push(...valueDifferences(resource, `${listKey}[id=${id}]`, item, counterpart));
  }
  // Un elemento que aparece despues: si se escribio tras la captura se excluye; si dice ser anterior, no
  // deberia faltar en una lectura del pasado y es una diferencia.
  for (const item of afterItems) {
    const id = String(item.id);
    if (beforeIds.includes(id)) continue;
    if (settledBefore(item)) differences.push({ resource, path: `${listKey}[id=${id}]`, kind: "added" });
    else excludedIds.push(id);
  }
  return { differences, excluded: new Set(excludedIds).size };
}

/**
 * Compara dos lecturas `{ kpis, orders, settlements, resumen, index }` de una misma tienda (T24 captura el
 * "antes"; T27, en `run-all`, el "despues" con los mismos rangos y huelleado con fingerprintCapture).
 * Tolerancia cero salvo IGNORED_RESPONSE_FIELDS:
 *  - `/kpis`: por valor, entero.
 *  - `/orders` y `/settlements`: por valor solo los elementos estables (ver compareListResource).
 *  - `/resumen`: SOLO por forma (claves y tipos). Resume el saldo de la tienda al dia de HOY (pendiente,
 *    retenido, pagos recibidos hasta ahora) y no acepta rango: ningun rango lo congela, asi que entre la
 *    captura y la comparacion sus valores cambian por la operacion normal sin que nada este roto.
 *  - indice: cada clave de primer nivel del "antes" con valor identico; solo se admiten claves NUEVAS de
 *    primer nivel (RF_20: lo de la spec 029 va en claves nuevas).
 */
function compareReads(before, after, options) {
  const captureAt = String(options && options.captureAt);
  const left = before || {};
  const right = after || {};
  const differences = [];
  differences.push(...valueDifferences("kpis", "", withoutIgnoredFields(left.kpis), withoutIgnoredFields(right.kpis)));
  const orders = compareListResource("orders", "pedidos", left.orders, right.orders, captureAt);
  const settlements = compareListResource("settlements", "liquidaciones", left.settlements, right.settlements, captureAt);
  differences.push(...orders.differences, ...settlements.differences);
  differences.push(...shapeDifferences("resumen", "", withoutIgnoredFields(left.resumen), withoutIgnoredFields(right.resumen)));
  const indexBefore = withoutIgnoredFields(left.index) ?? {};
  const indexAfter = withoutIgnoredFields(right.index) ?? {};
  for (const key of Object.keys(indexBefore).sort()) {
    if (!(key in indexAfter)) differences.push({ resource: "index", path: key, kind: "missing" });
    else differences.push(...valueDifferences("index", key, indexBefore[key], indexAfter[key]));
  }
  return { ok: differences.length === 0, differences, excluded: { orders: orders.excluded, settlements: settlements.excluded } };
}

/** Dia calendario YYYY-MM-DD en America/Bogota, desplazado `offsetDays` dias. */
function bogotaDay(date, offsetDays) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const shifted = new Date(`${today}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Tiendas reales con key de lectura activa: prioriza Kovia, ONEP y DANDA; nunca la tienda de pruebas. Solo
 * se toma la key de lectura (por desestructuracion) y no sale de memoria.
 */
async function loadCaptureStores() {
  const snap = await db.collection("storeApiConfigs").get();
  const candidates = snap.docs
    .map((doc) => {
      const { apiKey: readKey, sellerId, sellerName, status } = doc.data();
      return { sellerId: String(sellerId ?? doc.id), sellerName: String(sellerName ?? sellerId ?? doc.id), status, readKey };
    })
    .filter((store) => store.sellerId !== CAPTURE_TEST_SELLER && store.status === "active" && typeof store.readKey === "string" && store.readKey.length > 0);
  const rank = (store) => {
    const position = CAPTURE_PREFERRED_STORES.indexOf(store.sellerName.trim().toLowerCase());
    return position < 0 ? CAPTURE_PREFERRED_STORES.length : position;
  };
  candidates.sort((left, right) => rank(left) - rank(right) || left.sellerName.localeCompare(right.sellerName));
  if (candidates.length < CAPTURE_MIN_STORES) {
    throw new Error(`capture-reads: hacen falta ${CAPTURE_MIN_STORES} tiendas reales con key de lectura activa y hay ${candidates.length} (${candidates.map((store) => store.sellerName).join(", ") || "ninguna"})`);
  }
  return candidates;
}

/** GET a la Store API de produccion con la key de lectura en la cabecera (nunca en la URL ni en logs). */
async function storeApiGet(store, route, query) {
  const params = new URLSearchParams({ sellerId: store.sellerId, ...query });
  const url = `${STORE_API_BASE_URL}${route}?${params.toString()}`;
  const response = await fetch(url, { method: "GET", headers: { Authorization: "Bearer " + store.readKey, Accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) {
    throw new Error(`capture-reads: GET ${route} de ${store.sellerName} respondio ${response.status} (${body && body.error ? body.error : "sin cuerpo JSON"})`);
  }
  return body;
}

/** Anota en cada liquidacion la hora de la ultima escritura de `settlements/{id}` (solo lectura). */
async function annotateSettlementsUpdatedAt(settlementsBody) {
  const items = Array.isArray(settlementsBody.liquidaciones) ? settlementsBody.liquidaciones : [];
  if (items.length === 0) return settlementsBody;
  const snaps = await db.getAll(...items.map((item) => db.collection("settlements").doc(String(item.id))));
  // `updateTime` de Firestore y no el campo `updatedAt`: cambia con CUALQUIER escritura del corte, tambien
  // con las que no tocan ese campo, asi que un corte movido entre medias nunca pasa por estable.
  const updatedAtById = Object.fromEntries(snaps.map((snap) => [snap.id, snap.exists && snap.updateTime ? snap.updateTime.toDate().toISOString() : null]));
  return { ...settlementsBody, liquidaciones: items.map((item) => ({ ...item, updatedAt: updatedAtById[String(item.id)] ?? null })) };
}

async function captureReads() {
  const captureAt = new Date().toISOString();
  // Rango cerrado del pasado: termina AYER (America/Bogota), asi ningun pedido nuevo cae dentro.
  const range = { from: bogotaDay(new Date(captureAt), -CAPTURE_RANGE_DAYS), to: bogotaDay(new Date(captureAt), -1) };
  if (!(range.from <= range.to && range.to < captureAt.slice(0, 10))) throw new Error(`capture-reads: rango invalido ${range.from}..${range.to}`);
  const stores = await loadCaptureStores();
  const captured = [];
  for (const store of stores) {
    const kpis = await storeApiGet(store, "/kpis", { from: range.from, to: range.to });
    const orders = await storeApiGet(store, "/orders", { from: range.from, to: range.to });
    const settlements = await annotateSettlementsUpdatedAt(await storeApiGet(store, "/settlements", { from: range.from, to: range.to }));
    const resumen = await storeApiGet(store, "/resumen", {});
    const index = await storeApiGet(store, "/", {});
    captured.push(fingerprintCapture({ sellerId: store.sellerId, sellerName: store.sellerName, kpis, orders, settlements, resumen, index }));
    console.log(`- ${store.sellerName} (${store.sellerId}): pedidos=${orders.total} · liquidaciones=${settlements.total}`);
  }
  const evidenceFile = path.join(EVIDENCE_DIR, "t24-reads-antes.json");
  const text = `${JSON.stringify({ captureAt, range, stores: captured }, null, 2)}\n`;
  // La key de lectura son 48 hex: si algo con esa forma llegara al texto, no se guarda. (La de escritura
  // ni se lee en este modo, asi que no puede llegar.)
  if (/(?<![0-9a-f])[0-9a-f]{48}(?![0-9a-f])/i.test(text)) throw new Error("capture-reads: la evidencia contiene algo con forma de key de lectura; no se guarda");
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(evidenceFile, text);
  console.log(`captureAt=${captureAt} · rango ${range.from}..${range.to} · tiendas=${captured.length}`);
  console.log(`Evidencia: ${path.relative(process.cwd(), evidenceFile)}`);
}

// ---------------------------------------------------------------------------------------------------------
// T25 · salvaguardas de todo lo que escribe (plan 5.3 (a)-(d)) y modo kovia-replay (RF_11 con la forma de Kovia)
// ---------------------------------------------------------------------------------------------------------

/** Registro sin secretos de lo creado por la verificacion: lo lee `cleanup --from-registro` (T27). */
const REGISTRO_FILE = path.join(EVIDENCE_DIR, "t27-registro.json");
const KOVIA_PATCH = Object.freeze({
  customerName: "Cliente Sintetico Corregido",
  // Con separadores (los admite la validacion): un literal de 10 digitos seguidos no cabe en el guion.
  customerPhone: "300 029 0099",
  addressRaw: "Carrera 80 # 2-10, Barrio Sintetico, Cali"
});
/** Nombre en Secret Manager del secreto con el que `shopifyWebhook` valida la firma. Es un nombre, no el valor. */
const SHOPIFY_SECRET_NAME = "SHOPIFY_APP_API_SECRET";
/** Campo que deja una edicion manual (MANUAL_EDIT_STAMP de functions/src/order-import-merge.ts). */
const MANUAL_EDIT_FIELD = "manuallyEditedAt";

/** Valores que nunca pueden llegar al registro (ver rememberSecret). Solo en memoria. */
const rememberedValues = [];

const registroIdsOf = (registro, kind) =>
  (registro && Array.isArray(registro.entries) ? registro.entries : [])
    .filter((entry) => entry && entry.kind === kind && typeof entry.id === "string")
    .map((entry) => entry.id);
/** Un pedido es de prueba si el guion lo anoto en el registro antes de crearlo. */
const isRegisteredTestOrder = (orderId, context) => typeof orderId === "string" && registroIdsOf(context.registro, "orders").includes(orderId);
const hasTestSeller = (doc) => Boolean(doc.data) && doc.data.sellerId === TEST_SELLER_ID;

/**
 * Tabla 5.3 (c): cuando un documento (o usuario) pertenece a la prueba. Una por coleccion; una coleccion sin
 * regla no se puede borrar. `doc` es `{ id, data }`; `context.registro` es el registro de lo creado. Claves sin
 * comillas a proposito: la guarda de T7 busca el nombre de la coleccion del historial entre comillas.
 */
const SAFE_DELETE_RULES = Object.freeze({
  orders: (doc) => hasTestSeller(doc),
  orderHistory: (doc) => hasTestSeller(doc),
  walletEntries: (doc, context) => Boolean(doc.data) && isRegisteredTestOrder(doc.data.orderId, context),
  auditEvents: (doc, context) => Boolean(doc.data) && (doc.data.entityId === TEST_SELLER_ID || isRegisteredTestOrder(doc.data.entityId, context)),
  inventory: (doc) => hasTestSeller(doc),
  productCatalog: (doc) => hasTestSeller(doc),
  sellers: (doc) => doc.id === TEST_SELLER_ID,
  storeApiConfigs: (doc) => doc.id === TEST_SELLER_ID,
  storeApiIdempotency: (doc) => doc.id.startsWith(TEST_SELLER_DOC_PREFIX),
  storeApiRateLimits: (doc) => doc.id.startsWith(TEST_SELLER_DOC_PREFIX),
  shopifyStores: (doc) => Boolean(doc.data) && doc.data.shopDomain === TEST_SHOP_DOMAIN && doc.data.sellerId === TEST_SELLER_ID,
  importRuns: (doc, context) => registroIdsOf(context.registro, "importRuns").includes(doc.id),
  storeWebhookSamples: (doc, context) => hasTestSeller(doc) || isRegisteredTestOrder(doc.data && doc.data.orderId, context),
  shopifySyncIssues: (doc, context) => hasTestSeller(doc) || isRegisteredTestOrder(doc.data && doc.data.orderId, context),
  authUsers: (doc, context) => registroIdsOf(context.registro, "authUsers").includes(doc.id),
  storeWebhookConfigs: (doc) => doc.id === TEST_SELLER_ID
});

/** Lee el registro de lo creado (`{ entries: [...] }`); vacio si aun no existe. */
function readRegistro(file) {
  const target = file || REGISTRO_FILE;
  if (!fs.existsSync(target)) return { entries: [] };
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  return { ...parsed, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

/**
 * Registra en memoria un valor secreto (contrasena, key, secreto de Shopify o de webhook) para que
 * recordCreated lo rechace si alguien intenta anotarlo. No lo escribe en ninguna parte.
 */
function rememberSecret(value) {
  if (typeof value === "string" && value.length > 0) rememberedValues.push(value);
}

/**
 * Anota `{ kind, id, at }` en el registro ANTES de crear algo, para que un fallo no deje nada sin anotar.
 * Solo acepta ids: rechaza (sin tocar el archivo) un kind sin regla de limpieza, lo que no sea texto, texto con
 * espacios, la forma de una key (`kw_`, 48 hex) y cualquier valor pasado a rememberSecret. El mensaje de error
 * no repite el valor, porque podria ser justo lo que no debe salir.
 */
function recordCreated(kind, id, options) {
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(SAFE_DELETE_RULES, kind)) {
    throw new Error(`recordCreated: "${String(kind)}" no tiene regla de limpieza en SAFE_DELETE_RULES`);
  }
  const rejected =
    typeof id !== "string" ||
    id.length === 0 ||
    /\s/.test(id) ||
    id.startsWith("kw_") ||
    /[0-9a-f]{48}/i.test(id) ||
    rememberedValues.some((value) => id.includes(value));
  if (rejected) throw new Error(`recordCreated: valor rechazado para ${kind} (solo se anotan ids)`);
  const file = (options && options.file) || REGISTRO_FILE;
  const registro = readRegistro(file);
  registro.entries.push({ kind, id, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(registro, null, 2)}\n`);
}

/** Salvaguarda (a): lee el documento que un envio crearia y aborta si ya existe. No escribe. */
async function assertNotExists(docPath, deps) {
  const database = (deps && deps.db) || db;
  if (typeof docPath !== "string" || docPath.split("/").length !== 2) throw new Error(`assertNotExists: ruta invalida ${docPath}`);
  const snap = await database.doc(docPath).get();
  if (snap.exists) throw new Error(`assertNotExists: ${docPath} ya existe; no se envia nada`);
}

/** Antes de un reenvio: el pedido que existe es el de la prueba (tienda de pruebas). Si no, aborta. No escribe. */
async function assertIsTestOrder(docPath, deps) {
  const database = (deps && deps.db) || db;
  const snap = await database.doc(docPath).get();
  const data = snap.exists ? snap.data() || {} : null;
  if (!data || data.sellerId !== TEST_SELLER_ID) throw new Error(`assertIsTestOrder: ${docPath} no es un pedido de la tienda de pruebas; no se envia nada`);
  return data;
}

/**
 * Salvaguarda (c): UNICO sitio del guion que borra. Lee el documento (o el usuario de Auth) y comprueba su
 * pertenencia con SAFE_DELETE_RULES[collection]; si no pertenece, LANZA sin borrar. Una coleccion sin regla
 * lanza sin leer. Lo que ya no existe no se borra ni falla (la limpieza se puede repetir).
 */
async function safeDelete(collection, id, deps) {
  const rule = typeof collection === "string" && Object.prototype.hasOwnProperty.call(SAFE_DELETE_RULES, collection) ? SAFE_DELETE_RULES[collection] : null;
  if (!rule) throw new Error(`safeDelete: la coleccion ${String(collection)} no tiene regla de pertenencia; no se borra`);
  if (typeof id !== "string" || id.length === 0 || id.includes("/")) throw new Error(`safeDelete: id invalido en ${collection}`);
  const options = deps || {};
  const context = { registro: options.registro || readRegistro() };

  if (collection === "authUsers") {
    if (!rule({ id, data: null }, context)) throw new Error(`safeDelete: el usuario ${id} no esta en el registro; no se borra`);
    const auth = options.auth || admin.auth();
    let user;
    try {
      user = await auth.getUser(id);
    } catch (error) {
      if (error && error.code === "auth/user-not-found") return { collection, id, deleted: false, missing: true };
      throw error;
    }
    if (!user || !rule({ id: user.uid, data: null }, context)) throw new Error(`safeDelete: el usuario ${id} no pertenece a la prueba; no se borra`);
    await auth.deleteUser(user.uid);
    return { collection, id, deleted: true };
  }

  const database = options.db || db;
  const ref = database.collection(collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { collection, id, deleted: false, missing: true };
  if (!rule({ id, data: snap.data() || {} }, context)) throw new Error(`safeDelete: ${collection}/${id} no pertenece a la prueba; no se borra`);
  await ref.delete();
  return { collection, id, deleted: true };
}

/** Fixture con la forma de un pedido real de Kovia y datos sinteticos; aborta si algo se sale de lo sintetico. */
function loadKoviaFixture() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/lib/fixtures/029-kovia-order.json"), "utf8"));
  const payload = fixture.shopifyPayload || {};
  const inRange = Number.isSafeInteger(payload.id) && payload.id >= SHOPIFY_TEST_ID_MIN && payload.id <= SHOPIFY_TEST_ID_MAX;
  if (!inRange) throw new Error("kovia-replay: el id de Shopify del fixture esta fuera del rango reservado");
  if (typeof payload.name !== "string" || !payload.name.startsWith(TEST_ORDER_NUMBER_PREFIX)) throw new Error("kovia-replay: el numero de pedido del fixture no es sintetico");
  if (fixture.shopDomain !== TEST_SHOP_DOMAIN) throw new Error("kovia-replay: el dominio del fixture no es el sintetico");
  return fixture;
}

/** El secreto con el que `shopifyWebhook` valida la firma, leido de Secret Manager SOLO a memoria. */
function readShopifySecret() {
  const { execFileSync } = require("child_process");
  const shopifySecret = execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${SHOPIFY_SECRET_NAME}`, "--project=kentro-last-mile"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  if (!shopifySecret) throw new Error("kovia-replay: Secret Manager no devolvio la firma de Shopify");
  return shopifySecret;
}

/** Firma HMAC-SHA256 en base64 del cuerpo exacto, como la valida `shopifyWebhook`. */
function signShopifyBody(rawBody, shopifySecret) {
  return crypto.createHmac("sha256", shopifySecret).update(rawBody, "utf8").digest("base64");
}

/** POST firmado al webhook de Shopify con el dominio sintetico. La URL la pone quien comprueba antes. */
async function postShopifyWebhook(url, rawBody, signature) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-shop-domain": TEST_SHOP_DOMAIN,
      "x-shopify-topic": "orders/create"
    },
    body: rawBody
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** PATCH /orders/{id} de la Store API con la key de escritura de la tienda de pruebas (solo cabecera). */
async function patchTestOrder(orderId, writeKey, input) {
  const params = new URLSearchParams({ sellerId: TEST_SELLER_ID });
  const response = await fetch(`${STORE_API_BASE_URL}/orders/${encodeURIComponent(orderId)}?${params.toString()}`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + writeKey,
      "Content-Type": "application/json",
      "Idempotency-Key": `${TEST_EXTERNAL_ID_PREFIX}kovia-patch-${Date.now()}`
    },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/**
 * RF_11 con la forma de Kovia, en produccion y SOLO sobre la tienda de pruebas (plan 5.3 "RF_11 con la forma
 * de Kovia" (b)). Lo llama `run-all` (T27) con `{ writeKey }` en memoria; sin ella aborta antes de escribir.
 * Secuencia: crea el `shopifyStores` de prueba -> replay 1 (crea el pedido) -> PATCH por API (corrige cliente y
 * direccion) -> replay 2 (mismo payload) -> comprueba que cliente y direccion corregidos se conservan, que el
 * estado no cambia y que el pedido lleva la marca de edicion (fase `edited`). Todo lo que crea queda en el
 * registro y lo borra el `cleanup` general. El secreto de Shopify solo se usa para firmar.
 */
async function koviaReplay(context) {
  const run = context || {};
  if (typeof run.writeKey !== "string" || run.writeKey.length === 0) {
    throw new Error("kovia-replay corre dentro de run-all (T27): necesita la key de escritura de la tienda de pruebas en memoria");
  }
  rememberSecret(run.writeKey);
  const fixture = loadKoviaFixture();
  const payload = fixture.shopifyPayload;
  const orderId = `shopify-${payload.id}`;
  const sellerSnap = await db.collection("sellers").doc(TEST_SELLER_ID).get();
  if (!sellerSnap.exists) throw new Error("kovia-replay: falta la tienda de pruebas (la crea el setup de run-all)");
  await assertNotExists(`shopifyStores/${TEST_SHOP_DOMAIN}`);
  const sameDomain = await db.collection("shopifyStores").where("shopDomain", "==", TEST_SHOP_DOMAIN).limit(1).get();
  if (!sameDomain.empty) throw new Error("kovia-replay: ya hay una tienda de Shopify con el dominio de prueba");
  await assertNotExists(`orders/shopify-${payload.id}`);

  recordCreated("shopifyStores", TEST_SHOP_DOMAIN);
  recordCreated("orders", orderId);
  const now = new Date().toISOString();
  await db.collection("shopifyStores").doc(TEST_SHOP_DOMAIN).set({
    id: TEST_SHOP_DOMAIN,
    shopDomain: TEST_SHOP_DOMAIN,
    sellerId: TEST_SELLER_ID,
    status: "connected",
    connectedAt: now,
    updatedAt: now
  });

  const rawBody = JSON.stringify(payload);
  const shopifySecret = readShopifySecret();
  rememberSecret(shopifySecret);
  const signature = signShopifyBody(rawBody, shopifySecret);

  // Replay 1: el pedido no debe existir justo antes de enviar.
  await assertNotExists(`orders/shopify-${payload.id}`);
  const first = await postShopifyWebhook(SHOPIFY_WEBHOOK_URL, rawBody, signature);
  if (first.status !== 200 || !first.body || first.body.ok !== true || first.body.orderId !== orderId) {
    throw new Error(`kovia-replay: el replay 1 respondio ${first.status} (${first.body && first.body.reason ? first.body.reason : "sin orderId"})`);
  }
  const created = await assertIsTestOrder(`orders/${orderId}`);
  const statusBefore = created.status;

  const patched = await patchTestOrder(orderId, run.writeKey, { expectedStatus: statusBefore, ...KOVIA_PATCH });
  if (patched.status !== 200 || !patched.body || patched.body.ok !== true) {
    throw new Error(`kovia-replay: el PATCH respondio ${patched.status} (${patched.body && patched.body.code ? patched.body.code : "sin codigo"})`);
  }

  // Replay 2: el pedido que existe tiene que ser el que creo el replay 1.
  await assertIsTestOrder(`orders/${orderId}`);
  const second = await postShopifyWebhook(SHOPIFY_WEBHOOK_URL, rawBody, signature);
  if (second.status !== 200 || !second.body || second.body.ok !== true) {
    throw new Error(`kovia-replay: el replay 2 respondio ${second.status}`);
  }

  const after = await assertIsTestOrder(`orders/${orderId}`);
  const checks = {
    customerName: after.customerName === KOVIA_PATCH.customerName,
    customerPhone: String(after.customerPhone ?? "").replace(/\D/g, "") === KOVIA_PATCH.customerPhone.replace(/\D/g, ""),
    addressRaw: after.addressRaw === KOVIA_PATCH.addressRaw,
    status: after.status === statusBefore,
    edited: typeof after[MANUAL_EDIT_FIELD] === "string" && after[MANUAL_EDIT_FIELD].length > 0
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(`kovia-replay ${orderId}: ${ok ? "OK" : "FALLA"} · ${Object.entries(checks).map(([name, passed]) => `${name}=${passed ? "si" : "no"}`).join(" · ")}`);
  if (!ok) throw new Error("kovia-replay: RF_11 no se cumple tras el replay 2");
  return { orderId, statusBefore, checks };
}

// ---------------------------------------------------------------------------------------------------------
// T27 · set-history-since, run-all y cleanup (plan 2.4, 5.3 y 10). Ninguno se ejecuta sin aprobacion humana.
// ---------------------------------------------------------------------------------------------------------

const IDENTITY_SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const TEST_CITY_ID = "city-cali";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const orderRoute = (orderId, suffix) => `/orders/${encodeURIComponent(orderId)}${suffix || ""}`;
const codeOf = (reply) => (reply && reply.body && typeof reply.body.code === "string" ? reply.body.code : "");

/** Plan 2.4: `settings/storeApi.historySince` con la hora real, UNA vez y con create (falla si ya existe). */
async function setHistorySince() {
  const historySince = new Date().toISOString();
  await db.collection("settings").doc("storeApi").create({ historySince });
  console.log(`settings/storeApi.historySince = ${historySince}`);
}

/** La web API key publica del cliente (no es secreta); se lee del fuente para no repetirla. */
function readWebApiKey() {
  const text = fs.readFileSync(path.join(__dirname, "../src/lib/firebase/client.ts"), "utf8");
  const match = text.match(/AIza[0-9A-Za-z_-]{35}/);
  if (!match) throw new Error("run-all: no se encontro la web API key en src/lib/firebase/client.ts");
  return match[0];
}

/** signInWithPassword por REST (createCustomToken no funciona con ADC). Devuelve el token solo a memoria. */
async function signInTestUser(email, pass) {
  const signInBody = { email, password: pass, returnSecureToken: true };
  const response = await fetch(IDENTITY_SIGN_IN_URL + "?key=" + encodeURIComponent(readWebApiKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signInBody)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body.idToken !== "string") throw new Error(`run-all: el inicio de sesion de prueba respondio ${response.status}`);
  return body.idToken;
}

/** Usuario desechable de la tienda de pruebas (o el admin desechable). Anota el uid ANTES de crearlo. */
async function createTestUser(kind) {
  const uid = `t029${kind.replace(/_/g, "")}${crypto.randomBytes(6).toString("hex")}`;
  const email = `${uid}@verify-029.example.com`;
  const pass = crypto.randomBytes(24).toString("base64url");
  rememberSecret(pass);
  recordCreated("authUsers", uid);
  await admin.auth().createUser({ uid, email, password: pass, displayName: "Prueba 029" });
  if (kind === "seller") await admin.auth().setCustomUserClaims(uid, { role: "seller", sellerId: TEST_SELLER_ID });
  else if (kind === "seller_logistics") await admin.auth().setCustomUserClaims(uid, { role: "seller_logistics", sellerId: TEST_SELLER_ID });
  else if (kind === "admin") await admin.auth().setCustomUserClaims(uid, { role: "admin" });
  else throw new Error(`run-all: rol de prueba no previsto ${kind}`);
  const token = await signInTestUser(email, pass);
  rememberSecret(token);
  return { uid, kind, idToken: token };
}

/** Callable por HTTP con la sesion de prueba (canal del cliente). */
async function callCallable(name, session, data) {
  const started = Date.now();
  const response = await fetch(FUNCTIONS_BASE_URL + "/" + name, {
    method: "POST",
    headers: { Authorization: "Bearer " + session.idToken, "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
  const body = await response.json().catch(() => null);
  return {
    status: response.status,
    ms: Date.now() - started,
    result: body && Object.prototype.hasOwnProperty.call(body, "result") ? body.result : null,
    error: body && body.error ? body.error : null
  };
}

async function requireCallable(name, session, data) {
  const reply = await callCallable(name, session, data);
  if (reply.status !== 200 || reply.error) {
    throw new Error(`run-all: ${name} (${session.kind}) respondio ${reply.status} (${reply.error && reply.error.status ? reply.error.status : "sin estado"})`);
  }
  return reply.result || {};
}

/** Escritura en la Store API, SIEMPRE con sellerId de la tienda de pruebas. La key va por cabecera salvo CA_11. */
async function storeApiWrite(run, request) {
  const query = request.keyInQuery ? { sellerId: TEST_SELLER_ID, key: request.key } : { sellerId: TEST_SELLER_ID };
  const headers = { "Content-Type": "application/json" };
  if (request.key && !request.keyInQuery) headers.Authorization = "Bearer " + request.key;
  if (request.idempotencyKey) headers["Idempotency-Key"] = request.idempotencyKey;
  const started = Date.now();
  const response = await fetch(STORE_API_BASE_URL + request.route + "?" + new URLSearchParams(query).toString(), {
    method: request.method,
    headers,
    body: JSON.stringify(request.body || {})
  });
  const ms = Date.now() - started;
  if (request.measure !== false) run.writeMs.push(ms);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, retryAfter: response.headers.get("retry-after"), ms };
}

/** GET a la Store API con la key indicada (lectura o escritura) por cabecera. Solo GET. */
async function storeApiGetWithKey(sellerId, key, route, query) {
  const params = new URLSearchParams({ ...(query || {}), sellerId: sellerId });
  const started = Date.now();
  const response = await fetch(STORE_API_BASE_URL + route + "?" + params.toString(), {
    method: "GET",
    headers: { Authorization: "Bearer " + key, Accept: "application/json" }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, ms: Date.now() - started };
}

/** Lectura (Admin SDK) de un pedido para comprobar que "nada cambia". */
async function readTestOrder(orderId) {
  const snap = await db.collection("orders").doc(orderId).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return { data, text: canonicalJson(data) };
}

async function countHistory(orderId) {
  const historySnap = await db.collection("orderHistory").where("orderId", "==", orderId).get();
  return historySnap.size;
}

async function readInventoryReserved(inventoryId) {
  const snap = await db.collection("inventory").doc(inventoryId).get();
  return snap.exists ? Number(snap.get("reserved")) || 0 : null;
}

/** El `imported` entra como entran los reales de esa via: por el webhook de tienda, con id externo de prueba. */
async function sendImportedOrder(run, label) {
  const externalId = `${TEST_EXTERNAL_ID_PREFIX}${label}-${run.tag}`;
  const orderId = `shopify-${externalId}`;
  await assertNotExists(`orders/shopify-${externalId}`);
  recordCreated("orders", orderId);
  const payload = {
    id: externalId,
    name: `#${TEST_ORDER_NUMBER_PREFIX}${label}-${run.tag}`,
    total_price: "89000",
    financial_status: "pending",
    tags: "ADMA",
    shipping_address: {
      name: "Cliente Sintetico 029",
      phone: "300 029 0011",
      address1: "Calle 5 # 40-20",
      address2: "Barrio Sintetico",
      city: "Cali",
      province: "Valle del Cauca",
      country: "Colombia"
    },
    line_items: [{ name: "Producto sintetico 029", sku: `${TEST_ORDER_NUMBER_PREFIX}SKU-WEBHOOK`, quantity: 1 }]
  };
  const query = new URLSearchParams({ sellerId: TEST_SELLER_ID, key: run.webhookKey });
  const response = await fetch(STORE_ORDER_WEBHOOK_URL + "?" + query.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 201 || !body || body.orderId !== orderId) {
    throw new Error(`run-all: el webhook de tienda respondio ${response.status} (${body && body.reason ? body.reason : "sin pedido"})`);
  }
  await assertIsTestOrder(`orders/${orderId}`);
  return { id: orderId, shopifyOrderId: payload.name };
}

/**
 * Alta manual con la sesion `seller` (la via que hoy produce `address_risk`). El id lo decide el servidor, asi
 * que se anota en cuanto vuelve; si el proceso cae justo antes, el cleanup lo encuentra por sellerId.
 */
async function createTestManualOrder(run, options) {
  const result = await requireCallable("createManualOrder", run.sessions.seller, {
    sellerId: TEST_SELLER_ID,
    customerName: "Cliente Sintetico 029",
    customerPhone: "300 029 0022",
    addressRaw: "Carrera 10 # 20-30, Barrio Sintetico, Cali",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    totalCop: 75000,
    lineItems: [{ productName: "Producto sintetico 029", sku: options.sku, quantity: 1 }],
    addressRisk: options.addressRisk
  });
  const orderId = result.order && typeof result.order.id === "string" ? result.order.id : "";
  if (!orderId) throw new Error("run-all: createManualOrder no devolvio el pedido");
  recordCreated("orders", orderId);
  await assertIsTestOrder(`orders/${orderId}`);
  return orderId;
}

/** Pedido "con lider": Admin SDK, fuera del canal del cliente (no hay usuarios de lider de prueba). */
async function prepareLeaderOrder(orderId) {
  await assertIsTestOrder(`orders/${orderId}`);
  await db.collection("orders").doc(orderId).update({ status: "assigned", driverId: TEST_DRIVER_ID, updatedAt: new Date().toISOString() });
}

/** RF_27: dos eventos con la forma de antes de la spec (sin origin ni orderHistory) sobre un pedido de prueba. */
async function seedHistoricalAuditEvents(run, orderId) {
  await assertIsTestOrder(`orders/${orderId}`);
  const createdAt = new Date(Date.now() - 60 * 1000).toISOString();
  const allowedId = `${TEST_EXTERNAL_ID_PREFIX}audit-transition-${run.tag}`;
  const hiddenId = `${TEST_EXTERNAL_ID_PREFIX}audit-reassigned-${run.tag}`;
  recordCreated("auditEvents", allowedId);
  await db.collection("auditEvents").doc(allowedId).create({
    id: allowedId,
    actorId: run.sessions.admin.uid,
    actorRole: "admin",
    action: "order.transition",
    entity: "order",
    entityId: orderId,
    fromStatus: "ready_to_assign",
    toStatus: "assigned",
    summary: "Estado del pedido: ready_to_assign -> assigned",
    createdAt
  });
  recordCreated("auditEvents", hiddenId);
  await db.collection("auditEvents").doc(hiddenId).create({
    id: hiddenId,
    actorId: TEST_DRIVER_ID,
    actorRole: "driver",
    action: "order.messenger_reassigned",
    entity: "order",
    entityId: orderId,
    summary: "Mensajero reasignado a Mensajero Sintetico 029",
    createdAt
  });
  return { allowedId, hiddenId };
}

function checkCa(run, label, ok, detail) {
  run.smoke.push(`${label} ${ok ? "OK" : "FALLA"} · ${detail}`);
  if (!ok) run.failures.push(label);
}

/** RF_27 con sesion real: tienda (seller y seller_logistics) sin identidades y con "Kentro"; admin ve los dos. */
async function checkAuditTrail(run, orderId, seeded) {
  const identityFields = ["actorId", "actorLabel", "actorEmail", "actorRole"];
  const storeView = async (session) => {
    const trail = await requireCallable("getOrderAuditTrail", session, { orderId });
    const events = Array.isArray(trail.events) ? trail.events : [];
    const allowed = events.find((event) => event.id === seeded.allowedId);
    return Boolean(allowed) && identityFields.every((field) => !(field in allowed)) && allowed.actorTag === "Kentro" && !events.some((event) => event.id === seeded.hiddenId);
  };
  const sellerOk = await storeView(run.sessions.seller);
  const logisticsOk = await storeView(run.sessions.seller_logistics);
  const adminTrail = await requireCallable("getOrderAuditTrail", run.sessions.admin, { orderId });
  const adminEvents = Array.isArray(adminTrail.events) ? adminTrail.events : [];
  const adminOk = [seeded.allowedId, seeded.hiddenId].every((id) => adminEvents.some((event) => event.id === id));
  checkCa(run, "RF_27", sellerOk && logisticsOk && adminOk, `tienda (seller ${sellerOk ? "si" : "no"}, seller_logistics ${logisticsOk ? "si" : "no"}): order.transition sin actorId/actorLabel/actorEmail/actorRole y con etiqueta "Kentro", order.messenger_reassigned ausente · admin ve los dos: ${adminOk ? "si" : "no"}`);
}

/** Setup: tienda, inventario y catalogo, usuarios, webhook de tienda, key de lectura y de escritura (memoria). */
async function setupTestStore(run) {
  const now = new Date().toISOString();
  recordCreated("sellers", TEST_SELLER_ID);
  await db.collection("sellers").doc(TEST_SELLER_ID).create({
    id: TEST_SELLER_ID,
    name: "Tienda de pruebas 029",
    shopDomain: TEST_SHOP_DOMAIN,
    cityId: TEST_CITY_ID,
    bankAccount: "Cuenta sintetica 029",
    pickupPointName: "Punto sintetico 029",
    pickupAddress: "Calle 1 # 1-01, Cali",
    createdAt: now,
    updatedAt: now
  });
  recordCreated("inventory", run.inventoryId);
  await db.collection("inventory").doc(run.inventoryId).create({
    id: run.inventoryId,
    sellerId: TEST_SELLER_ID,
    sku: run.inventorySku,
    name: "Producto sintetico 029",
    available: 10,
    reserved: 0,
    createdAt: now,
    updatedAt: now
  });
  const catalogId = `${TEST_SELLER_DOC_PREFIX}catalogo`;
  recordCreated("productCatalog", catalogId);
  await db.collection("productCatalog").doc(catalogId).create({
    id: catalogId,
    sellerId: TEST_SELLER_ID,
    supplierId: "proveedor-sintetico-029",
    sku: run.inventorySku,
    name: "Producto sintetico 029",
    productCostCop: 20000,
    productCostConfigured: true,
    active: true,
    createdAt: now,
    updatedAt: now
  });

  run.sessions.seller = await createTestUser("seller");
  run.sessions.seller_logistics = await createTestUser("seller_logistics");
  run.sessions.admin = await createTestUser("admin");

  recordCreated("storeWebhookConfigs", TEST_SELLER_ID);
  const webhook = await requireCallable("createStoreWebhookConfig", run.sessions.seller, { sellerId: TEST_SELLER_ID, skuContains: "*", tagContains: "*" });
  const { config: { webhookKey } = {} } = webhook;
  if (typeof webhookKey !== "string" || webhookKey.length === 0) throw new Error("run-all: createStoreWebhookConfig no devolvio la clave del webhook");
  rememberSecret(webhookKey);
  run.webhookKey = webhookKey;

  recordCreated("storeApiConfigs", TEST_SELLER_ID);
  const created = await requireCallable("createStoreApiKey", run.sessions.seller, { sellerId: TEST_SELLER_ID });
  const { config: { apiKey: readKey } = {} } = created;
  if (typeof readKey !== "string" || !/^[0-9a-f]{48}$/.test(readKey)) throw new Error("run-all: createStoreApiKey no devolvio una key de lectura");
  rememberSecret(readKey);
  run.readKey = readKey;

  const generated = await requireCallable("rotateStoreWriteKey", run.sessions.seller, { sellerId: TEST_SELLER_ID, rotate: false });
  const { writeKey } = generated;
  if (typeof writeKey !== "string" || !writeKey.startsWith("kw_") || writeKey.length !== 48) throw new Error("run-all: rotateStoreWriteKey no devolvio una key de escritura");
  rememberSecret(writeKey);
  run.writeKey = writeKey;
  run.smoke.push("setup: tienda de pruebas con inventario y catalogo, usuarios seller / seller_logistics / admin desechables, webhook de tienda de prueba, key de lectura (createStoreApiKey) y key de escritura (rotateStoreWriteKey, solo en memoria)");
}

/** Pedidos de prueba: imported por webhook, address_risk y "con lider" por alta manual, y uno con inventario. */
async function createTestOrders(run) {
  const imported = await sendImportedOrder(run, "a");
  const risk = await createTestManualOrder(run, { addressRisk: "review", sku: `${TEST_ORDER_NUMBER_PREFIX}SKU-SIN-FICHA` });
  const leader = await createTestManualOrder(run, { addressRisk: "accepted", sku: `${TEST_ORDER_NUMBER_PREFIX}SKU-SIN-FICHA` });
  await prepareLeaderOrder(leader);
  run.smoke.push(`pedido con lider ${leader}: status assigned y driverId sintetico puestos con el Admin SDK (paso fuera del canal del cliente)`);
  const withInventory = await createTestManualOrder(run, { addressRisk: "accepted", sku: run.inventorySku });
  run.smoke.push(`pedidos de prueba: imported ${imported.id} (webhook de tienda), address_risk ${risk}, con lider ${leader}, con inventario ${withInventory}`);
  return { imported, risk, leader, withInventory };
}

/** Anexo A, CA_01-CA_11, uno a uno y por el canal del cliente (Store API con la key de la tienda de pruebas). */
async function runAcceptanceCriteria(run, orders) {
  const imported = orders.imported.id;
  const write = (method, orderId, suffix, body, extra) =>
    storeApiWrite(run, { method, route: orderRoute(orderId, suffix), key: run.writeKey, body, ...(extra || {}) });

  // CA_01: buscar por numero; inexistente = 200 con lista vacia (RF_02); y GET /orders/{id}.
  const found = await storeApiGetWithKey(TEST_SELLER_ID, run.readKey, "/orders", { shopifyOrderId: orders.imported.shopifyOrderId });
  const missing = await storeApiGetWithKey(TEST_SELLER_ID, run.readKey, "/orders", { shopifyOrderId: `#${TEST_ORDER_NUMBER_PREFIX}no-existe-${run.tag}` });
  const byId = await storeApiGetWithKey(TEST_SELLER_ID, run.readKey, orderRoute(imported), {});
  run.readByIdMs.push(byId.ms);
  const foundList = found.body && Array.isArray(found.body.pedidos) ? found.body.pedidos : [];
  const missingList = missing.body && Array.isArray(missing.body.pedidos) ? missing.body.pedidos : null;
  const byIdOk = byId.status === 200 && Boolean(byId.body && byId.body.pedido) && byId.body.pedido.id === imported;
  checkCa(run, "CA_01", found.status === 200 && foundList.length === 1 && foundList[0].id === imported && missing.status === 200 && Array.isArray(missingList) && missingList.length === 0 && byIdOk,
    `GET /orders?shopifyOrderId= -> ${found.status} (${foundList.length} pedido) · numero inexistente -> ${missing.status} con ${missingList ? missingList.length : "?"} pedidos · GET /orders/{id} -> ${byId.status}`);

  // CA_05 en imported: los cinco datos de entrega, y el cambio en /history.
  const correction = { customerName: "Cliente Sintetico Corregido", customerPhone: "300 029 0033", addressRaw: "Calle 7 # 30-15, Barrio Sintetico, Cali", deliveryNotes: "Porteria sintetica", cityId: TEST_CITY_ID };
  const patched = await write("PATCH", imported, "", correction);
  const afterPatch = await readTestOrder(imported);
  const history = await storeApiGetWithKey(TEST_SELLER_ID, run.writeKey, orderRoute(imported, "/history"), {});
  const records = history.body && Array.isArray(history.body.registros) ? history.body.registros : [];
  const saved = ["customerName", "addressRaw", "deliveryNotes"].every((field) => afterPatch.data[field] === correction[field]);
  checkCa(run, "CA_05", patched.status === 200 && Boolean(patched.body) && patched.body.changed === true && saved && records.some((record) => record.origin === "api"),
    `PATCH en imported -> ${patched.status} · guardado=${saved ? "si" : "no"} · /history ${history.status} con ${records.length} registros`);

  // CA_06: campos que no se tocan.
  const beforeForbidden = await readTestOrder(imported);
  const forbidden = await write("PATCH", imported, "", { totalCop: 1, productName: "Otro producto" });
  const forbiddenFields = forbidden.body && Array.isArray(forbidden.body.fields) ? forbidden.body.fields.map((item) => item.field) : [];
  const afterForbidden = await readTestOrder(imported);
  checkCa(run, "CA_06", forbidden.status === 422 && codeOf(forbidden) === "field_not_allowed" && forbiddenFields.includes("totalCop") && forbiddenFields.includes("productName") && afterForbidden.text === beforeForbidden.text,
    `PATCH con totalCop y productName -> ${forbidden.status} ${codeOf(forbidden)} (${forbiddenFields.join(", ")}) · sin cambios=${afterForbidden.text === beforeForbidden.text ? "si" : "no"}`);

  // CA_09: ciudad fuera de cobertura.
  const outside = await write("PATCH", imported, "", { cityId: `${TEST_EXTERNAL_ID_PREFIX}ciudad-inexistente` });
  const cities = outside.body && Array.isArray(outside.body.activeCities) ? outside.body.activeCities : [];
  const afterOutside = await readTestOrder(imported);
  checkCa(run, "CA_09", outside.status === 422 && codeOf(outside) === "out_of_coverage" && cities.length > 0 && afterOutside.text === beforeForbidden.text,
    `ciudad inexistente -> ${outside.status} ${codeOf(outside)} · ciudades activas en la respuesta: ${cities.length}`);

  // CA_10: idempotencia.
  const idempotencyKey = `${TEST_EXTERNAL_ID_PREFIX}idem-${run.tag}`;
  const historyBefore = await countHistory(imported);
  const first = await write("PATCH", imported, "", { deliveryNotes: "Porteria sintetica 2" }, { idempotencyKey });
  const historyAfterFirst = await countHistory(imported);
  const repeated = await write("PATCH", imported, "", { deliveryNotes: "Porteria sintetica 2" }, { idempotencyKey });
  const historyAfterRepeat = await countHistory(imported);
  const beforeReuse = await readTestOrder(imported);
  const reused = await write("PATCH", imported, "", { deliveryNotes: "Otra porteria" }, { idempotencyKey });
  const afterReuse = await readTestOrder(imported);
  checkCa(run, "CA_10", first.status === 200 && repeated.status === first.status && canonicalJson(repeated.body) === canonicalJson(first.body) && historyAfterFirst === historyBefore + 1 && historyAfterRepeat === historyAfterFirst && reused.status === 422 && codeOf(reused) === "idempotency_key_reused" && afterReuse.text === beforeReuse.text,
    `misma Idempotency-Key y cuerpo -> ${first.status} y ${repeated.status} identicos, historial +${historyAfterRepeat - historyBefore} · otro cuerpo -> ${reused.status} ${codeOf(reused)}`);

  // CA_02 (y la repeticion de CA_07): confirmar un imported sin lider; repetir es exito sin cambios.
  const confirmed = await write("POST", imported, "/confirm", { expectedStatus: "imported" });
  const again = await write("POST", imported, "/confirm", { expectedStatus: "imported" });
  const confirmedStatus = confirmed.body && confirmed.body.pedido ? confirmed.body.pedido.status : "?";
  const againUnchanged = again.status === 200 && Boolean(again.body) && again.body.changed === false;
  checkCa(run, "CA_02", confirmed.status === 200 && confirmed.body.changed === true && confirmedStatus === "ready_to_assign",
    `confirmar imported -> ${confirmed.status} estado ${confirmedStatus} · repetir -> ${again.status} sin cambios=${againUnchanged ? "si" : "no"}`);

  // CA_05 tambien en ready_to_assign sin lider.
  const readyPatch = await write("PATCH", imported, "", { customerName: "Cliente Sintetico Listo" });
  checkCa(run, "CA_05", readyPatch.status === 200 && Boolean(readyPatch.body) && readyPatch.body.changed === true, `PATCH en ready_to_assign sin lider -> ${readyPatch.status}`);

  // CA_03: confirmar un address_risk se rechaza y nada cambia.
  const beforeRisk = await readTestOrder(orders.risk);
  const riskConfirm = await write("POST", orders.risk, "/confirm", {});
  const afterRisk = await readTestOrder(orders.risk);
  checkCa(run, "CA_03", riskConfirm.status === 409 && codeOf(riskConfirm) === "address_review_pending" && afterRisk.text === beforeRisk.text,
    `confirmar address_risk -> ${riskConfirm.status} ${codeOf(riskConfirm)} · sin cambios=${afterRisk.text === beforeRisk.text ? "si" : "no"}`);

  // CA_04: corregir la direccion de un address_risk sin lider -> imported; despues confirmar funciona.
  const riskPatch = await write("PATCH", orders.risk, "", { addressRaw: "Calle 9 # 8-07, Barrio Sintetico, Cali" });
  const riskStatus = riskPatch.body && riskPatch.body.pedido ? riskPatch.body.pedido.status : "?";
  const riskConfirmed = await write("POST", orders.risk, "/confirm", { expectedStatus: "imported" });
  const riskConfirmedStatus = riskConfirmed.body && riskConfirmed.body.pedido ? riskConfirmed.body.pedido.status : "?";
  checkCa(run, "CA_04", riskPatch.status === 200 && riskStatus === "imported" && riskConfirmed.status === 200 && riskConfirmedStatus === "ready_to_assign",
    `PATCH direccion en address_risk -> ${riskPatch.status} estado ${riskStatus} · confirmar -> ${riskConfirmed.status} estado ${riskConfirmedStatus}`);

  // CA_07: pedido con lider.
  const beforeLeader = await readTestOrder(orders.leader);
  const leaderPatch = await write("PATCH", orders.leader, "", { customerName: "No deberia cambiar" });
  const leaderCancel = await write("POST", orders.leader, "/cancel", { reason: "No deberia cancelarse" });
  const leaderConfirm = await write("POST", orders.leader, "/confirm", {});
  const afterLeader = await readTestOrder(orders.leader);
  const leaderUnchanged = afterLeader.text === beforeLeader.text;
  const leaderConfirmNoop = leaderConfirm.status === 200 && Boolean(leaderConfirm.body) && leaderConfirm.body.changed === false;
  checkCa(run, "CA_07", leaderPatch.status === 409 && codeOf(leaderPatch) === "order_not_editable" && leaderCancel.status === 409 && codeOf(leaderCancel) === "order_not_editable" && leaderConfirmNoop && leaderUnchanged && againUnchanged,
    `con lider: PATCH -> ${leaderPatch.status} ${codeOf(leaderPatch)} · cancelar -> ${leaderCancel.status} ${codeOf(leaderCancel)} · confirmar -> ${leaderConfirm.status} sin cambios=${leaderConfirmNoop ? "si" : "no"} · pedido intacto=${leaderUnchanged ? "si" : "no"} · reconfirmar ready_to_assign sin cambios=${againUnchanged ? "si" : "no"}`);

  // CA_08: cancelar con motivo; sin motivo o >500 se rechaza; libera el inventario reservado (RF_13).
  const reservedBefore = await readInventoryReserved(run.inventoryId);
  const noReason = await write("POST", orders.withInventory, "/cancel", {});
  const longReason = await write("POST", orders.withInventory, "/cancel", { reason: "x".repeat(501) });
  const cancelled = await write("POST", orders.withInventory, "/cancel", { reason: "Cancelado en la verificacion 029" });
  const cancelledStatus = cancelled.body && cancelled.body.pedido ? cancelled.body.pedido.status : "?";
  const reservedAfter = await readInventoryReserved(run.inventoryId);
  const cancelAgain = await write("POST", orders.withInventory, "/cancel", { reason: "Cancelado en la verificacion 029" });
  const confirmCancelled = await write("POST", orders.withInventory, "/confirm", {});
  const cancelAgainNoop = cancelAgain.status === 200 && Boolean(cancelAgain.body) && cancelAgain.body.changed === false;
  checkCa(run, "CA_08", noReason.status === 422 && codeOf(noReason) === "validation_failed" && longReason.status === 422 && codeOf(longReason) === "validation_failed" && cancelled.status === 200 && cancelledStatus === "cancelled" && reservedAfter === reservedBefore - 1 && cancelAgainNoop && confirmCancelled.status === 409 && codeOf(confirmCancelled) === "order_cancelled",
    `sin motivo -> ${noReason.status} ${codeOf(noReason)} · 501 caracteres -> ${longReason.status} ${codeOf(longReason)} · con motivo -> ${cancelled.status} ${cancelledStatus} · inventario reservado ${reservedBefore} -> ${reservedAfter} · repetir -> ${cancelAgain.status} · confirmar cancelado -> ${confirmCancelled.status} ${codeOf(confirmCancelled)}`);

  // CA_11: claves. La "tienda ajena" se prueba con un id INEXISTENTE (mismo 404), nunca con un pedido real.
  const noKey = await storeApiWrite(run, { method: "POST", route: orderRoute(imported, "/confirm"), body: {} });
  const withRead = await storeApiWrite(run, { method: "POST", route: orderRoute(imported, "/confirm"), key: run.readKey, body: {} });
  const inQuery = await storeApiWrite(run, { method: "POST", route: orderRoute(imported, "/confirm"), key: run.writeKey, keyInQuery: true, body: {} });
  const retired = run.writeKey;
  const rotated = await requireCallable("rotateStoreWriteKey", run.sessions.admin, { sellerId: TEST_SELLER_ID, rotate: true });
  const { writeKey } = rotated;
  if (typeof writeKey !== "string" || !writeKey.startsWith("kw_")) throw new Error("run-all: la rotacion no devolvio una key de escritura");
  rememberSecret(writeKey);
  run.writeKey = writeKey;
  const withRetired = await storeApiWrite(run, { method: "POST", route: orderRoute(imported, "/confirm"), key: retired, body: {} });
  const foreignId = `${TEST_EXTERNAL_ID_PREFIX}ajeno-${run.tag}`;
  await assertNotExists(`orders/${foreignId}`);
  const foreign = await write("PATCH", foreignId, "", { customerName: "Nadie" });
  checkCa(run, "CA_11", noKey.status === 401 && codeOf(noKey) === "missing_credentials" && withRead.status === 403 && codeOf(withRead) === "read_only_key" && inQuery.status === 401 && codeOf(inQuery) === "key_in_query" && withRetired.status === 401 && codeOf(withRetired) === "invalid_key" && foreign.status === 404 && codeOf(foreign) === "order_not_found",
    `sin clave -> ${noKey.status} ${codeOf(noKey)} · de lectura -> ${withRead.status} ${codeOf(withRead)} · en la URL -> ${inQuery.status} ${codeOf(inQuery)} · la anterior tras rotar (admin) -> ${withRetired.status} ${codeOf(withRetired)} · pedido de otra tienda (id inexistente) -> ${foreign.status} ${codeOf(foreign)}`);
}

/** CA_12: historial con fecha y origen, y 429 con Retry-After pasadas las 120 escrituras del minuto. */
async function runCaLimit(run, orderId) {
  const history = await storeApiGetWithKey(TEST_SELLER_ID, run.writeKey, orderRoute(orderId, "/history"), {});
  const records = history.body && Array.isArray(history.body.registros) ? history.body.registros : [];
  const historyOk = history.status === 200 && records.filter((record) => record.origin === "api").length >= 3 && records.every((record) => typeof record.at === "string" && typeof record.origin === "string");
  // Ventana fija por minuto: se empieza al principio de un minuto para que la rafaga caiga en una sola.
  const second = new Date().getUTCSeconds();
  if (second > 15) await sleep((61 - second) * 1000);
  let limited = null;
  let sent = 0;
  while (!limited && sent < 140) {
    const burst = await Promise.all(Array.from({ length: 10 }, () => storeApiWrite(run, { method: "POST", route: orderRoute(orderId, "/confirm"), key: run.writeKey, body: {}, measure: false })));
    sent += burst.length;
    limited = burst.find((reply) => reply.status === 429) || null;
  }
  const retryAfter = limited ? Number(limited.retryAfter) : NaN;
  checkCa(run, "CA_12", historyOk && Boolean(limited) && codeOf(limited) === "rate_limited" && retryAfter >= 1,
    `/history ${history.status}: ${records.length} registros con fecha y origen · rafaga de ${sent} confirmaciones -> ${limited ? `429 ${codeOf(limited)} Retry-After=${retryAfter}` : "sin 429"}`);
  // Se espera a la ventana siguiente para que las escrituras de despues no choquen con el limite.
  await sleep(((Number.isFinite(retryAfter) ? Math.min(retryAfter, 60) : 60) + 2) * 1000);
}

/** Nota 13: en la tienda de pruebas, key de lectura y de escritura en llamadas consecutivas, por valor. Solo GET. */
async function compareReadWriteKeys(readKey, writeKey) {
  const range = { from: bogotaDay(new Date(), -30), to: bogotaDay(new Date(), 0) };
  const resources = [["/resumen", {}], ["/kpis", range], ["/orders", range], ["/settlements", range]];
  const results = [];
  for (const [route, query] of resources) {
    const withRead = await storeApiGetWithKey(TEST_SELLER_ID, readKey, route, query);
    const withWrite = await storeApiGetWithKey(TEST_SELLER_ID, writeKey, route, query);
    const differences = withRead.status === withWrite.status ? valueDifferences(route, "", withRead.body, withWrite.body) : [{ resource: route, path: "", kind: "status" }];
    results.push({ route, status: withRead.status, differences: differences.length });
  }
  return results;
}

/** compare-reads (RF_20): tiendas reales con SU key de lectura contra t24-reads-antes.json. Solo GET. */
async function compareRealStoreReads() {
  const capture = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "t24-reads-antes.json"), "utf8"));
  const stores = await loadCaptureStores();
  const range = { from: capture.range.from, to: capture.range.to };
  const results = [];
  for (const before of capture.stores) {
    const store = stores.find((candidate) => candidate.sellerId === before.sellerId);
    if (!store) {
      results.push({ sellerName: before.sellerName, differences: 1, paths: ["sin key de lectura activa"], excluded: { orders: 0, settlements: 0 } });
      continue;
    }
    const kpis = await storeApiGet(store, "/kpis", range);
    const orders = await storeApiGet(store, "/orders", range);
    const settlements = await annotateSettlementsUpdatedAt(await storeApiGet(store, "/settlements", range));
    const resumen = await storeApiGet(store, "/resumen", {});
    const index = await storeApiGet(store, "/", {});
    const after = fingerprintCapture({ sellerId: store.sellerId, sellerName: store.sellerName, kpis, orders, settlements, resumen, index });
    const comparison = compareReads(before, after, { captureAt: capture.captureAt });
    results.push({
      sellerName: store.sellerName,
      differences: comparison.differences.length,
      paths: comparison.differences.slice(0, 5).map((item) => `${item.resource}:${item.path}:${item.kind}`),
      excluded: comparison.excluded
    });
  }
  return results;
}

/** RF_01: GET /orders/{id} contra su elemento de GET /orders sobre 20 pedidos reales, key de lectura, solo GET. */
async function compareOrdersById() {
  const stores = await loadCaptureStores();
  const range = { from: bogotaDay(new Date(), -30), to: bogotaDay(new Date(), -1) };
  const lists = [];
  for (const store of stores) {
    const list = await storeApiGetWithKey(store.sellerId, store.readKey, "/orders", range);
    lists.push({ store, pedidos: list.body && Array.isArray(list.body.pedidos) ? list.body.pedidos : [] });
  }
  const sample = [];
  for (let position = 0; sample.length < 20 && lists.some((entry) => position < entry.pedidos.length); position += 1) {
    for (const entry of lists) if (sample.length < 20 && position < entry.pedidos.length) sample.push({ store: entry.store, item: entry.pedidos[position] });
  }
  const ms = [];
  const mismatches = [];
  let moved = 0;
  for (const { store, item } of sample) {
    const reply = await storeApiGetWithKey(store.sellerId, store.readKey, `/orders/${encodeURIComponent(item.id)}`, {});
    ms.push(reply.ms);
    const pedido = reply.body && reply.body.pedido ? reply.body.pedido : null;
    if (reply.status === 200 && pedido && pedido.updatedAt !== item.updatedAt) {
      moved += 1;
      continue;
    }
    if (reply.status !== 200 || canonicalJson(pedido) !== canonicalJson(item)) mismatches.push(`${store.sellerName}:${item.id}:${reply.status}`);
  }
  return { compared: sample.length, moved, mismatches, ms, stores: stores.map((store) => store.sellerName) };
}

function p95Of(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Sustituye cualquier secreto recordado antes de que el texto salga de memoria. */
function redactSecrets(text) {
  return rememberedValues.reduce((result, value) => result.split(value).join("[secreto]"), text);
}

/** Escribe t27-smoke.txt solo si no lleva nada con forma de key (kw_ o 48 hex). */
function writeSmoke(lines) {
  const SMOKE_FILE = path.join(EVIDENCE_DIR, "t27-smoke.txt");
  const text = redactSecrets(`${lines.join("\n")}\n`);
  if (/kw_/.test(text) || /[0-9a-f]{48}/i.test(text)) throw new Error("run-all: la evidencia contiene algo con forma de key (kw_ o 48 hex); no se guarda");
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(SMOKE_FILE, text);
  console.log(text);
  return SMOKE_FILE;
}

function newRunContext() {
  return {
    tag: crypto.randomBytes(3).toString("hex"),
    inventorySku: `${TEST_ORDER_NUMBER_PREFIX}SKU-INV`,
    inventoryId: `${TEST_SELLER_DOC_PREFIX}inventario`,
    smoke: [],
    failures: [],
    writeMs: [],
    readByIdMs: [],
    sessions: {}
  };
}

/** Solo lectura: nada de una corrida anterior, historySince puesto, captura de T24 y ciudad activa. */
async function preflightRunAll() {
  if (readRegistro().entries.length > 0) {
    throw new Error("run-all: t27-registro.json ya tiene entradas; limpia con el modo de limpieza --from-registro y aparta el registro antes de repetir");
  }
  for (const [collection, id] of [["sellers", TEST_SELLER_ID], ["storeApiConfigs", TEST_SELLER_ID], ["storeWebhookConfigs", TEST_SELLER_ID], ["shopifyStores", TEST_SHOP_DOMAIN]]) {
    if ((await db.collection(collection).doc(id).get()).exists) throw new Error(`run-all: ${collection}/${id} ya existe; no se crea nada`);
  }
  if (!(await db.collection("orders").where("sellerId", "==", TEST_SELLER_ID).limit(1).get()).empty) throw new Error("run-all: ya hay pedidos de la tienda de pruebas");
  const settingsSnap = await db.collection("settings").doc("storeApi").get();
  if (!settingsSnap.exists || typeof settingsSnap.get("historySince") !== "string") throw new Error("run-all: falta settings/storeApi.historySince (corre antes set-history-since)");
  const city = await db.collection("cities").doc(TEST_CITY_ID).get();
  if (!city.exists || city.get("active") !== true) throw new Error("run-all: la ciudad de prueba no esta activa");
  if (!fs.existsSync(path.join(EVIDENCE_DIR, "t24-reads-antes.json"))) throw new Error("run-all: falta la captura de T24");
}

/**
 * run-all (T27): todo en UN proceso, con `cleanup` en el finally. La key de escritura solo vive en `run`.
 * Orden: setup -> pedidos -> CA_01..CA_11 -> CA_12 (limite al final, y espera la ventana) -> kovia-replay ->
 * RF_27 -> compare-reads (prueba lectura/escritura y tiendas reales) -> GET /orders/{id} en reales -> p95.
 */
async function runAll() {
  await preflightRunAll();
  const run = newRunContext();
  const P95_LIMIT_MS = 2000;
  let failure = null;
  try {
    run.smoke.push("# Spec 029 — T27 recorrido real (run-all) sobre la tienda de pruebas", `Inicio: ${new Date().toISOString()}`, "");
    await setupTestStore(run);
    const orders = await createTestOrders(run);
    await runAcceptanceCriteria(run, orders);
    await runCaLimit(run, orders.imported.id);

    const replay = await koviaReplay({ writeKey: run.writeKey });
    const replayOk = Object.values(replay.checks).every(Boolean);
    run.smoke.push(`kovia-replay ${replay.orderId}: replay 1 (crea) -> PATCH por API (corrige cliente y direccion) -> replay 2 (reimporta) · RF_11 ${replayOk ? "OK" : "FALLA"} · ${Object.entries(replay.checks).map(([name, passed]) => `${name}=${passed ? "si" : "no"}`).join(" · ")}`);
    if (!replayOk) run.failures.push("RF_11");

    const seeded = await seedHistoricalAuditEvents(run, orders.risk);
    await checkAuditTrail(run, orders.risk, seeded);

    const keyComparison = await compareReadWriteKeys(run.readKey, run.writeKey);
    const keysOk = keyComparison.every((item) => item.status === 200 && item.differences === 0);
    run.smoke.push(`compare-reads tienda de pruebas (key de lectura y de escritura, consecutivas): ${keysOk ? "OK" : "FALLA"} · ${keyComparison.map((item) => `${item.route} ${item.status} dif=${item.differences}`).join(" · ")}`);
    if (!keysOk) run.failures.push("compare-reads prueba");

    const realReads = await compareRealStoreReads();
    for (const item of realReads) {
      run.smoke.push(`compare-reads ${item.sellerName}: diferencias=${item.differences}${item.paths.length ? ` (${item.paths.join("; ")})` : ""} · excluidos por updatedAt: pedidos=${item.excluded.orders}, cortes=${item.excluded.settlements}`);
    }
    if (!realReads.every((item) => item.differences === 0)) run.failures.push("compare-reads reales");

    const byId = await compareOrdersById();
    const byIdOk = byId.compared === 20 && byId.mismatches.length === 0;
    run.smoke.push(`GET /orders/{id} contra GET /orders: ${byId.compared} pedidos reales (${byId.stores.join(", ")}) · distintos=${byId.mismatches.length}${byId.mismatches.length ? ` (${byId.mismatches.join("; ")})` : ""} · movidos entre medias=${byId.moved} · ${byIdOk ? "OK" : "FALLA"}`);
    if (!byIdOk) run.failures.push("GET /orders/{id}");

    const writeP95 = p95Of(run.writeMs);
    const readP95 = p95Of([...run.readByIdMs, ...byId.ms]);
    const p95Ok = writeP95 !== null && readP95 !== null && writeP95 < P95_LIMIT_MS && readP95 < P95_LIMIT_MS;
    run.smoke.push(`p95 escrituras=${writeP95} ms (${run.writeMs.length}) · p95 GET /orders/{id}=${readP95} ms · umbral ${P95_LIMIT_MS} ms · ${p95Ok ? "OK" : "FALLA"}`);
    if (!p95Ok) run.failures.push("p95");
  } catch (error) {
    failure = error;
    run.smoke.push(`ABORTADO: ${error && error.message ? error.message : String(error)}`);
  } finally {
    try {
      const report = await cleanup({ fromRunAll: true });
      run.smoke.push(...report);
    } catch (problem) {
      failure = failure || problem;
      run.smoke.push(`cleanup FALLA: ${problem && problem.message ? problem.message : String(problem)}`);
    }
    const failedLabels = [...run.failures, failure ? "abortado" : ""].filter(Boolean);
    run.smoke.push("", `RESULTADO: ${failedLabels.length ? `FALLA (${failedLabels.join(", ")})` : "OK"}`);
    writeSmoke(run.smoke);
  }
  if (failure) throw failure;
  if (run.failures.length > 0) throw new Error(`run-all: fallan ${run.failures.join(", ")}`);
}

/** Lo que queda de la prueba, por clase de la tabla 5.3 (c). Solo lee. */
async function collectCleanupTargets(registro) {
  const docIds = (snap) => snap.docs.map((doc) => doc.id);
  const unique = (list) => [...new Set(list)];
  const bySeller = docIds(await db.collection("orders").where("sellerId", "==", TEST_SELLER_ID).get());
  const orderIds = [];
  const foreign = [];
  for (const id of unique([...registroIdsOf(registro, "orders"), ...bySeller])) {
    const snap = await db.collection("orders").doc(id).get();
    if (snap.exists && snap.get("sellerId") !== TEST_SELLER_ID) foreign.push(id);
    else orderIds.push(id);
  }
  const byField = async (collection, field, value) => docIds(await db.collection(collection).where(field, "==", value).get());
  const perOrder = async (collection, field) => {
    const found = [];
    for (const id of orderIds) found.push(...(await byField(collection, field, id)));
    return found;
  };
  const byPrefix = async (collection) => {
    const documentId = admin.firestore.FieldPath.documentId();
    return docIds(await db.collection(collection).where(documentId, ">=", TEST_SELLER_DOC_PREFIX).where(documentId, "<", `${TEST_SELLER_DOC_PREFIX}`).get());
  };
  const existing = async (collection, ids) => {
    const found = [];
    for (const id of ids) if ((await db.collection(collection).doc(id).get()).exists) found.push(id);
    return found;
  };
  const authUsers = [];
  for (const uid of registroIdsOf(registro, "authUsers")) {
    try {
      await admin.auth().getUser(uid);
      authUsers.push(uid);
    } catch (error) {
      if (!error || error.code !== "auth/user-not-found") throw error;
    }
  }
  const targets = {
    "orderHistory": unique([...(await perOrder("orderHistory", "orderId")), ...(await byField("orderHistory", "sellerId", TEST_SELLER_ID))]),
    "walletEntries": unique(await perOrder("walletEntries", "orderId")),
    "auditEvents": unique([...(await perOrder("auditEvents", "entityId")), ...(await byField("auditEvents", "entityId", TEST_SELLER_ID)), ...(await existing("auditEvents", registroIdsOf(registro, "auditEvents")))]),
    "storeWebhookSamples": unique([...(await byField("storeWebhookSamples", "sellerId", TEST_SELLER_ID)), ...(await perOrder("storeWebhookSamples", "orderId"))]),
    "shopifySyncIssues": unique([...(await byField("shopifySyncIssues", "sellerId", TEST_SELLER_ID)), ...(await perOrder("shopifySyncIssues", "orderId"))]),
    "storeApiIdempotency": await byPrefix("storeApiIdempotency"),
    "storeApiRateLimits": await byPrefix("storeApiRateLimits"),
    "importRuns": await existing("importRuns", registroIdsOf(registro, "importRuns")),
    "orders": await existing("orders", orderIds),
    "storeWebhookConfigs": await existing("storeWebhookConfigs", [TEST_SELLER_ID]),
    "shopifyStores": unique([...(await existing("shopifyStores", [TEST_SHOP_DOMAIN])), ...(await byField("shopifyStores", "shopDomain", TEST_SHOP_DOMAIN))]),
    "inventory": await byField("inventory", "sellerId", TEST_SELLER_ID),
    "productCatalog": await byField("productCatalog", "sellerId", TEST_SELLER_ID),
    "storeApiConfigs": await existing("storeApiConfigs", [TEST_SELLER_ID]),
    "authUsers": authUsers,
    "sellers": await existing("sellers", [TEST_SELLER_ID])
  };
  return { targets, orderIds, foreign };
}

/**
 * cleanup (finally de run-all, o `cleanup --from-registro` si el proceso se cayo): lee el registro, busca lo de
 * la prueba por orderId/entityId, sellerId y el prefijo de documentos, y borra SOLO con safeDelete (que
 * comprueba la pertenencia de cada documento). Imprime el recuento por coleccion y lanza si queda algo.
 */
async function cleanup(options) {
  const opts = options || {};
  if (!opts.fromRunAll && !process.argv.includes("--from-registro")) {
    throw new Error("cleanup: se lanza como `cleanup --from-registro` (o desde el finally de run-all)");
  }
  const registro = readRegistro();
  const first = await collectCleanupTargets(registro);
  // Los pedidos hallados por el sellerId de prueba cuentan como de la prueba para sus asientos y eventos.
  const effective = { ...registro, entries: [...registro.entries, ...first.orderIds.map((id) => ({ kind: "orders", id }))] };
  const kinds = [
    "orderHistory", "walletEntries", "auditEvents", "storeWebhookSamples", "shopifySyncIssues", "storeApiIdempotency",
    "storeApiRateLimits", "importRuns", "orders", "storeWebhookConfigs", "shopifyStores", "inventory", "productCatalog",
    "storeApiConfigs", "authUsers", "sellers"
  ];
  const removed = {};
  for (const kind of kinds) {
    removed[kind] = 0;
    for (const id of first.targets[kind]) {
      const result = await safeDelete(kind, id, { registro: effective });
      if (result.deleted) removed[kind] += 1;
    }
  }
  const second = await collectCleanupTargets(effective);
  const lines = kinds.map((kind) => `cleanup ${kind}: borrados=${removed[kind]} · quedan=${second.targets[kind].length}`);
  if (first.foreign.length > 0) lines.push(`cleanup: ${first.foreign.length} id(s) del registro son de otra tienda y NO se tocaron`);
  for (const line of lines) console.log(line);
  const remaining = kinds.filter((kind) => second.targets[kind].length > 0);
  if (remaining.length > 0 || first.foreign.length > 0) {
    throw new Error(`cleanup: queda algo (${remaining.join(", ") || "ids ajenos en el registro"})`);
  }
  lines.push("cleanup: cero en todas las colecciones");
  return lines;
}

const COMMANDS = { "baseline": baseline, "query-check": queryCheck, "capture-reads": captureReads, "kovia-replay": koviaReplay, "set-history-since": setHistorySince, "run-all": runAll, "cleanup": cleanup };

async function main() {
  const command = process.argv[2];
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Uso: node scripts/verify-029.js <${Object.keys(COMMANDS).join("|")}>`);
    process.exit(2);
  }
  if (WRITE_MODES.includes(command)) console.error(`[verify-029] el modo ${command} escribe en Firestore`);
  await run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[verify-029]", error);
    process.exit(1);
  });
}

module.exports = {
  compareReads,
  IGNORED_RESPONSE_FIELDS,
  fingerprintItem,
  fingerprintCapture,
  canonicalJson,
  TEST_SELLER_ID,
  TEST_SHOP_DOMAIN,
  TEST_DRIVER_ID,
  TEST_ORDER_NUMBER_PREFIX,
  TEST_EXTERNAL_ID_PREFIX,
  SHOPIFY_TEST_ID_MIN,
  SHOPIFY_TEST_ID_MAX,
  SAFE_DELETE_RULES,
  assertNotExists,
  assertIsTestOrder,
  recordCreated,
  rememberSecret,
  safeDelete,
  koviaReplay
};
