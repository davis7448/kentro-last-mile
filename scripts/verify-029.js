#!/usr/bin/env node
/**
 * Spec 029 — medicion en produccion (`specs/029_store_api_confirma_y_corrige_pedidos.md`).
 *
 *   node scripts/verify-029.js baseline      (T1) linea base SOLO LECTURA -> t1-linea-base.txt
 *   node scripts/verify-029.js query-check   (T2) consultas nuevas con limit(1), SOLO LECTURA -> t2-query-check.txt
 *
 * Los modos que escriben (T25 `kovia-replay`, T27 `set-history-since`/`run-all`/`cleanup`) se declaran en
 * WRITE_MODES cuando existan. Mientras la lista este vacia, la guarda de T1 (src/lib/spec-029-guards.test.ts)
 * prohibe en el fuente sin comentarios cualquier literal de llamada de escritura de Firestore, incluidos
 * Map/Set con esos mismos nombres: por eso se agrupa con objetos planos y `reduce`.
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
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

if (admin.apps.length === 0) admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

/** Modos que escriben en Firestore. `baseline` nunca. */
const WRITE_MODES = [];

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

const COMMANDS = { "baseline": baseline, "query-check": queryCheck };

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
