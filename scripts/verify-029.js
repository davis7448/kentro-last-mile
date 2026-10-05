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
const WRITE_MODES = ["kovia-replay"];

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

const COMMANDS = { "baseline": baseline, "query-check": queryCheck, "capture-reads": captureReads, "kovia-replay": koviaReplay };

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
