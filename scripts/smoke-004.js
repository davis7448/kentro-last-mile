/**
 * Smoke en produccion de la spec 004 (DoD 5): un pedido de comunidad REAL, cerrado como fallido
 * cobrable, cobra $12.000 a la tienda y no causa cashback — y despues no queda rastro.
 *
 * PARA QUE EXISTE
 * ---------------
 * La 004 decide la base de comunidad AL CIERRE (RF_11). Ninguna prueba unitaria demuestra que el
 * cierre desplegado, con los ajustes y la comunidad de produccion, cobra lo que dice la spec: solo un
 * pedido cerrado de verdad lo demuestra. Este guion lo hace con la tienda "Prueba" de E-master
 * (`seller-1789149795537`), sin zona, con el sello de comunidad calculado por el MISMO codigo que
 * usan las callables (`createCommunityPricingResolver`, compilado en `functions/lib`), y lo cierra
 * por la callable `closeOrder` con la sesion de un transportista, como en la app (regla de oro 1:
 * este guion no escribe el ciclo de vida del pedido; solo lo crea y lo borra).
 *
 * ORDEN DE USO (plan 004 §7)
 * --------------------------
 *   cd functions && npm run build              # el guion lee functions/lib
 *
 *   node scripts/smoke-004.js count            # ANTES de desplegar. Solo lectura: cuenta los pedidos
 *                                              # de comunidad abiertos y guarda la posicion de la
 *                                              # plataforma y el saldo de "Prueba" (linea base).
 *   ... despliegue firmado por el humano ...
 *   node scripts/smoke-004.js create           # transportista desechable + pedido en ruta
 *   node scripts/smoke-004.js close            # cierre fallido cobrable por la callable
 *   node scripts/smoke-004.js check            # exige failed_fee -12.000 y ningun cashback
 *   node scripts/smoke-004.js cleanup          # comprueba cortes, respalda y borra lo del smoke
 *   node scripts/smoke-004.js compare          # posicion y saldo == los de count, o exit 1
 *
 * POR QUE AQUI SI SE BORRA UN FALLIDO
 * -----------------------------------
 * La regla del proyecto es no borrar nunca un pedido fallido o entregado: sus asientos acaban en
 * cortes de transportista ya conciliados que mezclan varias tiendas, y borrarlos descuadra dinero
 * ajeno. Este es la unica excepcion, y solo por dos razones a la vez:
 *   1. El transportista es DESECHABLE (uid con el prefijo `smoke004-`, creado por `create`): ningun
 *      corte real puede haberlo incluido.
 *   2. `cleanup` comprueba, ANTES de borrar nada, que ningun asiento del pedido tiene `settlementId`
 *      ni `supplierSettlementId`. Si alguno lo tiene, NO borra nada y sale con error: rige la regla
 *      general, se compensa con la correccion administrativa (`correctOrderStatus`, RF_24/RF_25 de
 *      la 001) y se reporta.
 * Ademas solo borra pedidos cuyo id empieza por el prefijo o es el que guardo `create`, y solo
 * transportistas cuyo id empieza por el prefijo. Nada de consultas amplias: pedido por id, asientos
 * por `orderId`, auditoria por `entityId`.
 *
 * ESTADO, EVIDENCIAS Y REANUDACION
 * --------------------------------
 * Cada paso deja lo que sabe en `.sdd/evidence/004/smoke-state.json` y sus evidencias (respuesta del
 * cierre, asientos, respaldo, comparacion) en el mismo directorio. Todos los pasos son idempotentes:
 * si el proceso muere a mitad, se vuelve a ejecutar EL MISMO paso y retoma desde los ids guardados.
 *   - `create` guarda uid y contrasena ANTES de crear el usuario: repetirlo no crea otro transportista
 *     ni otro pedido, reusa los que existan y crea solo lo que falte.
 *   - `close` no vuelve a cerrar un pedido que ya esta fallido.
 *   - `cleanup` borra lo que quede; lo ya borrado no falla.
 * Si el archivo de estado se perdio, los ids salen de la consola de `create` y se pasan a mano:
 *   node scripts/smoke-004.js cleanup --order smoke004-order-<ts> --driver smoke004-<ts>
 * (`close` sin estado necesita la contrasena: `create --order <id> --driver <id>` adopta esos ids y
 * le pone una contrasena nueva al transportista desechable.)
 *
 * El estado guarda la contrasena del transportista desechable mientras existe; `cleanup` la quita al
 * borrarlo. `.sdd/evidence` se versiona: no commitear el estado antes de `cleanup`.
 *
 * `compare` falla si la posicion o el saldo no coinciden. En produccion hay operacion real entre
 * `count` y `compare`: si solo se movio la posicion (y no el saldo de "Prueba"), mirar que cortes se
 * pagaron en ese intervalo antes de culpar al smoke.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..");
const COMPILED_MODULES = ["platform-position.js", "community-order-pricing.js"];
const missingModules = COMPILED_MODULES.filter((file) => !fs.existsSync(path.join(REPO_ROOT, "functions", "lib", file)));
if (missingModules.length > 0) {
  console.error(`Faltan modulos compilados en functions/lib: ${missingModules.join(", ")}.`);
  console.error("Hay que compilar functions antes: cd functions && npm run build");
  process.exit(1);
}

const admin = require("../functions/node_modules/firebase-admin");
const { computePlatformPosition } = require("../functions/lib/platform-position");
const { createCommunityPricingResolver } = require("../functions/lib/community-order-pricing");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const auth = admin.auth();

const SMOKE_PREFIX = "smoke004-";
const STORE_ID = "seller-1789149795537";
const WEB_API_KEY = "AIzaSyAXY_lwmuAvXCmix45QrmEG-hiwAWmNI-g";
const EVIDENCE_DIR = path.join(REPO_ROOT, ".sdd", "evidence", "004");
const STATE_FILE = path.join(EVIDENCE_DIR, "smoke-state.json");
const TERMINAL_STATUSES = new Set(["delivered", "failed", "cancelled", "liquidated"]);
const USAGE = "Uso: node scripts/smoke-004.js <count|create|close|check|cleanup|compare> [--order <id>] [--driver <id>]";

// ---------------------------------------------------------------------------------------------
// Ayudantes sin escrituras en Firestore ni Auth (los alcanzan count y close).
// ---------------------------------------------------------------------------------------------

function fail(message) {
  console.error(message);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} necesita un valor.`);
  return value;
}

function evidencePath(fileName) {
  return path.join(EVIDENCE_DIR, fileName);
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

/** Mezcla `patch` en el estado. Una clave a `undefined` desaparece del archivo. */
function saveState(patch) {
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  writeJson(STATE_FILE, next);
  return next;
}

/** Ids del smoke: los argumentos mandan sobre el estado (reanudar sin archivo de estado). */
function smokeIds() {
  const state = loadState();
  return {
    state,
    orderId: argValue("--order") || state.orderId,
    driverId: argValue("--driver") || state.driverId
  };
}

function docData(snapshot) {
  return { id: snapshot.id, ...snapshot.data() };
}

function hasValue(value) {
  return Boolean(value) && String(value).trim() !== "";
}

function cop(value) {
  const amount = Math.round(Number(value) || 0);
  return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString("es-CO")}`;
}

/**
 * Pedidos de comunidad que no estan cerrados. `communityId > ""` usa el indice de campo unico y
 * deja fuera los pedidos sin comunidad (la inmensa mayoria), asi que no baja la coleccion entera.
 */
async function openCommunityOrders() {
  const snapshot = await db.collection("orders").where("communityId", ">", "").select("status", "communityId").get();
  const open = snapshot.docs.filter((doc) => !TERMINAL_STATUSES.has(String(doc.get("status"))));
  const byStatus = {};
  for (const doc of open) {
    const status = String(doc.get("status"));
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return { total: open.length, withCommunity: snapshot.size, byStatus, orderIds: open.map((doc) => doc.id) };
}

/**
 * Las cifras que el smoke no puede mover: la posicion de la plataforma (misma funcion que la
 * callable `getPlatformPosition`, sobre las colecciones completas) y el saldo de la tienda Prueba.
 */
async function platformFigures() {
  const [walletSnap, settlementsSnap] = await Promise.all([
    db.collection("walletEntries").get(),
    db.collection("settlements").get()
  ]);
  const wallet = walletSnap.docs.map(docData);
  const settlements = settlementsSnap.docs.map(docData);
  const position = computePlatformPosition(wallet, settlements);
  const storeBalanceCop = wallet
    .filter((entry) => entry.ownerType === "seller" && entry.ownerId === STORE_ID)
    .reduce((total, entry) => total + Math.round(Number(entry.amountCop) || 0), 0);
  return { walletEntryCount: wallet.length, settlementCount: settlements.length, position, storeBalanceCop };
}

/** Diferencias cifra a cifra entre dos resultados de `platformFigures`. */
function diffFigures(before, after) {
  const differences = [];
  const figureNames = new Set([...Object.keys(before.position || {}), ...Object.keys(after.position || {})]);
  for (const name of figureNames) {
    const was = before.position ? before.position[name] : undefined;
    const now = after.position ? after.position[name] : undefined;
    if (JSON.stringify(was) !== JSON.stringify(now)) differences.push({ figure: `position.${name}`, before: was, after: now });
  }
  if (before.storeBalanceCop !== after.storeBalanceCop) {
    differences.push({ figure: `saldo ${STORE_ID}`, before: before.storeBalanceCop, after: after.storeBalanceCop });
  }
  return differences;
}

async function findAuthUser(uid) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") return null;
    throw error;
  }
}

async function entriesOf(orderId) {
  const snapshot = await db.collection("walletEntries").where("orderId", "==", orderId).get();
  return snapshot.docs;
}

async function signInAsDriver(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const payload = await response.json();
  if (!response.ok || !payload.idToken) {
    fail(`signInWithPassword fallo (${response.status}): ${JSON.stringify(payload.error || payload)}`);
  }
  return payload.idToken;
}

/** Protocolo de callable por HTTP: `{ data }` de entrada, `{ result }` o `{ error }` de salida. */
async function callCloseOrder(idToken, data) {
  const url = "https://us-central1-kentro-last-mile.cloudfunctions.net/closeOrder";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data })
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail(`closeOrder respondio ${response.status} sin JSON: ${text.slice(0, 500)}`);
  }
  if (!response.ok || payload.error) {
    fail(`closeOrder fallo (${response.status}): ${JSON.stringify(payload.error || payload)}`);
  }
  return payload.result;
}

// ---------------------------------------------------------------------------------------------
// count — solo lectura, ANTES de desplegar.
// ---------------------------------------------------------------------------------------------

async function stepCount() {
  const state = loadState();
  const started = hasValue(state.orderId) || hasValue(state.driverId);
  if (started && !state.comparedAt) {
    fail(
      "El smoke en curso aun no paso por compare. Un count ahora fijaria como linea base cifras con el " +
        "pedido del smoke dentro. Termina el ciclo (cleanup, compare) antes de volver a contar."
    );
  }
  if (started) {
    writeJson(evidencePath(`smoke-state-archivado-${fileTimestamp()}.json`), state);
  }

  const openOrders = await openCommunityOrders();
  const before = await platformFigures();
  const countedAt = new Date().toISOString();
  writeJson(STATE_FILE, { countedAt, openCommunityOrders: openOrders, before, updatedAt: countedAt });

  console.log(`Pedidos de comunidad abiertos: ${openOrders.total} (de ${openOrders.withCommunity} con communityId).`);
  for (const [status, total] of Object.entries(openOrders.byStatus)) console.log(`  ${status}: ${total}`);
  console.log(`Saldo de la tienda Prueba (${STORE_ID}): ${cop(before.storeBalanceCop)}`);
  console.log(`Posicion de la plataforma (${before.walletEntryCount} asientos, ${before.settlementCount} cortes):`);
  for (const [name, value] of Object.entries(before.position)) console.log(`  ${name}: ${cop(value)}`);
  console.log(`Linea base guardada en ${path.relative(REPO_ROOT, STATE_FILE)}.`);
}

// ---------------------------------------------------------------------------------------------
// create — transportista desechable y pedido de la tienda Prueba, en ruta y sin zona.
// ---------------------------------------------------------------------------------------------

async function ensureSmokeDriver(state, runId, now) {
  const adopted = argValue("--driver");
  const driverId = adopted || state.driverId || `${SMOKE_PREFIX}${runId}`;
  if (!driverId.startsWith(SMOKE_PREFIX)) fail(`El transportista ${driverId} no lleva el prefijo ${SMOKE_PREFIX}.`);
  const email = state.driverId === driverId && state.driverEmail ? state.driverEmail : `${driverId}@kentro.invalid`;
  const knownPassword = state.driverId === driverId ? state.driverPassword : undefined;
  const password = knownPassword || crypto.randomBytes(24).toString("base64url");

  // Se guarda ANTES de crear: si el proceso muere entre createUser y aqui, la reanudacion reusa
  // el mismo uid y la misma contrasena en vez de dejar un usuario huerfano con clave desconocida.
  saveState({ runId, driverId, driverEmail: email, driverPassword: password });

  const existing = await findAuthUser(driverId);
  if (!existing) {
    await auth.createUser({ uid: driverId, email, password, displayName: "Smoke 004 (desechable)" });
    console.log(`Usuario Auth creado: ${driverId} <${email}>`);
  } else if (!knownPassword) {
    // Adoptado sin estado: la contrasena original se perdio con el archivo.
    await auth.updateUser(driverId, { password });
    console.log(`Usuario Auth ${driverId} adoptado con contrasena nueva.`);
  } else {
    console.log(`Usuario Auth ${driverId} ya existia; se reusa.`);
  }
  await auth.setCustomUserClaims(driverId, { role: "driver", driverId });

  const driverRef = db.collection("drivers").doc(driverId);
  const driverSnap = await driverRef.get();
  if (!driverSnap.exists) {
    await driverRef.set({
      id: driverId,
      name: "Smoke 004 (desechable)",
      phone: "",
      active: true,
      email,
      createdAt: now,
      updatedAt: now
    });
    console.log(`Documento drivers/${driverId} creado.`);
  }
  return driverId;
}

async function ensureSmokeOrder({ state, runId, driverId, seller, pricingStamp, now }) {
  const orderId = argValue("--order") || state.orderId || `${SMOKE_PREFIX}order-${runId}`;
  if (!orderId.startsWith(SMOKE_PREFIX)) fail(`El pedido ${orderId} no lleva el prefijo ${SMOKE_PREFIX}.`);
  const orderRef = db.collection("orders").doc(orderId);
  const existing = await orderRef.get();
  if (existing.exists) {
    saveState({ orderId });
    console.log(`El pedido ${orderId} ya existia (estado ${existing.get("status")}); no se crea otro.`);
    return orderId;
  }

  saveState({ orderId });
  // Misma forma que createManualOrder, sin zona y ya en ruta con el transportista desechable. No
  // pasa por el contador de guias: el smoke no debe consumir un KNT real.
  await orderRef.create({
    id: orderId,
    trackingCode: `SMOKE004-${runId}`,
    shopifyOrderId: `${SMOKE_PREFIX}${runId}`,
    sellerId: STORE_ID,
    cityId: hasValue(seller.cityId) ? String(seller.cityId) : "city-cali",
    driverId,
    customerName: "Smoke 004 (prueba, no despachar)",
    customerPhone: "",
    addressRaw: "Prueba del smoke 004 - no despachar",
    addressRisk: "accepted",
    status: "in_route",
    paymentMethod: "prepaid",
    fulfillmentMode: "seller_pickup",
    totalCop: 1000,
    pickupPointName: hasValue(seller.pickupPointName) ? String(seller.pickupPointName).trim() : String(seller.name || "Punto de recogida"),
    pickupAddress: hasValue(seller.pickupAddress) ? String(seller.pickupAddress).trim() : "",
    evidence: [],
    communityId: pricingStamp.communityId,
    communityPricing: pricingStamp.communityPricing,
    createdAt: now,
    updatedAt: now
  });
  console.log(`Pedido ${orderId} creado en ruta para ${driverId}.`);
  return orderId;
}

async function stepCreate() {
  const state = loadState();
  const adopting = Boolean(argValue("--order") || argValue("--driver"));
  if (!state.before && !adopting) fail("No hay linea base: ejecuta `count` ANTES de desplegar y luego `create`.");
  if (!state.before) console.warn("Aviso: sin linea base de count; compare no podra ejecutarse.");
  if (state.cleanedAt && !adopting) {
    fail("Este smoke ya se limpio. Para repetirlo: compare, y despues un count nuevo ANTES de create.");
  }

  const sellerSnap = await db.collection("sellers").doc(STORE_ID).get();
  if (!sellerSnap.exists) fail(`No existe sellers/${STORE_ID}.`);
  const seller = docData(sellerSnap);
  if (!/prueba/i.test(String(seller.name || ""))) console.warn(`Aviso: la tienda ${STORE_ID} se llama "${seller.name}".`);

  // El sello se calcula ANTES de crear nada: si la tienda no esta en una comunidad con precio
  // congelable, el smoke no probaria RF_11 y no debe dejar ni un transportista creado.
  const now = new Date().toISOString();
  const pricingStamp = await createCommunityPricingResolver(db)(seller, undefined, now);
  const frozen = pricingStamp.communityPricing;
  if (!hasValue(pricingStamp.communityId) || !frozen || frozen.pricingVersion !== 2) {
    fail(`La tienda ${STORE_ID} no produce un sello de comunidad v2: ${JSON.stringify(pricingStamp)}`);
  }

  const runId = state.runId || String(Date.now());
  const driverId = await ensureSmokeDriver(state, runId, now);
  const orderId = await ensureSmokeOrder({ state: loadState(), runId, driverId, seller, pricingStamp, now });
  saveState({ createdAt: state.createdAt || now, communityId: pricingStamp.communityId });

  console.log(`Comunidad ${pricingStamp.communityId}: fallido congelado ${cop(frozen.sellerFailedFeeCop)} (base ${cop(frozen.baseFailedFeeCop)}).`);
  console.log(`Ids para reanudar: --order ${orderId} --driver ${driverId}`);
}

// ---------------------------------------------------------------------------------------------
// close — solo la callable, con la sesion del transportista. Nada de escrituras directas.
// ---------------------------------------------------------------------------------------------

async function stepClose() {
  const { state, orderId, driverId } = smokeIds();
  if (!orderId || !driverId) fail(`Faltan ids del smoke. ${USAGE}`);
  if (state.driverId !== driverId || !state.driverPassword) {
    fail(`No tengo la contrasena de ${driverId}. Ejecuta: create --order ${orderId} --driver ${driverId}`);
  }

  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) fail(`No existe orders/${orderId}.`);
  const order = orderSnap.data();
  if (order.driverId !== driverId) fail(`El pedido ${orderId} esta asignado a ${order.driverId}, no a ${driverId}.`);
  if (order.status === "failed") {
    console.log(`El pedido ${orderId} ya esta fallido; no se cierra de nuevo. Sigue con check.`);
    return;
  }

  const idToken = await signInAsDriver(state.driverEmail || `${driverId}@kentro.invalid`, state.driverPassword);
  const result = await callCloseOrder(idToken, {
    orderId,
    outcome: "failed",
    failedCategory: "failed_visit",
    note: "Smoke 004: fallido cobrable de prueba (se borra en cleanup).",
    photoLabel: "smoke-004-sin-foto",
    reason: "Cliente no recibe"
  });
  const closedAt = new Date().toISOString();
  writeJson(evidencePath("smoke-close.json"), { closedAt, orderId, driverId, result });
  saveState({ closedAt });

  const walletEntries = result && Array.isArray(result.walletEntries) ? result.walletEntries : [];
  console.log(`closeOrder OK: ${orderId} -> ${result && result.order ? result.order.status : "?"}.`);
  for (const entry of walletEntries) console.log(`  ${entry.type} ${entry.ownerType}/${entry.ownerId}: ${cop(entry.amountCop)}`);
}

// ---------------------------------------------------------------------------------------------
// check — failed_fee de -12.000 a la tienda y ningun community_cashback.
// ---------------------------------------------------------------------------------------------

async function stepCheck() {
  const { orderId } = smokeIds();
  if (!orderId) fail(`Falta el id del pedido. ${USAGE}`);

  const [orderSnap, entryDocs] = await Promise.all([db.collection("orders").doc(orderId).get(), entriesOf(orderId)]);
  const order = orderSnap.exists ? docData(orderSnap) : null;
  const entries = entryDocs.map(docData);
  const sellerId = order ? order.sellerId : STORE_ID;
  const failedFees = entries.filter((entry) => entry.type === "failed_fee" && entry.ownerType === "seller" && entry.ownerId === sellerId);
  const cashbacks = entries.filter((entry) => entry.type === "community_cashback");

  const problems = [];
  if (!order) problems.push(`No existe orders/${orderId}.`);
  else {
    if (order.status !== "failed") problems.push(`El pedido esta en ${order.status}, no en failed.`);
    if (!hasValue(order.communityId)) problems.push("El pedido no lleva communityId: no prueba la base de comunidad.");
  }
  if (failedFees.length !== 1) problems.push(`Se esperaba un failed_fee de la tienda y hay ${failedFees.length}.`);
  else if (failedFees[0].amountCop !== -12000) problems.push(`El failed_fee es ${cop(failedFees[0].amountCop)}, no -$12.000.`);
  if (cashbacks.length > 0) problems.push(`Hay ${cashbacks.length} asiento(s) community_cashback; se esperaba ninguno.`);

  const checkedAt = new Date().toISOString();
  const ok = problems.length === 0;
  writeJson(evidencePath("smoke-check.json"), { checkedAt, orderId, ok, problems, order, walletEntries: entries });

  for (const entry of entries) console.log(`  ${entry.type} ${entry.ownerType}/${entry.ownerId}: ${cop(entry.amountCop)}`);
  if (!ok) {
    for (const problem of problems) console.error(`FALLA: ${problem}`);
    process.exit(1);
  }
  saveState({ checkedAt });
  console.log("OK: failed_fee de -$12.000 a la tienda y ningun cashback. Evidencia en smoke-check.json.");
}

// ---------------------------------------------------------------------------------------------
// cleanup — comprobar cortes, respaldar y borrar SOLO lo del smoke.
// ---------------------------------------------------------------------------------------------

async function stepCleanup() {
  const { state, orderId, driverId } = smokeIds();
  if (!orderId && !driverId) fail(`No hay ids del smoke que limpiar. ${USAGE}`);
  if (orderId && !(orderId.startsWith(SMOKE_PREFIX) || orderId === state.orderId)) {
    fail(`Me niego a borrar ${orderId}: no lleva el prefijo ${SMOKE_PREFIX} ni es el pedido que creo create.`);
  }
  if (driverId && !driverId.startsWith(SMOKE_PREFIX)) {
    fail(`Me niego a borrar el transportista ${driverId}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  }

  const orderRef = orderId ? db.collection("orders").doc(orderId) : null;
  const driverRef = driverId ? db.collection("drivers").doc(driverId) : null;
  const [orderSnap, entryDocs, auditSnap, driverSnap, authUser] = await Promise.all([
    orderRef ? orderRef.get() : null,
    orderId ? entriesOf(orderId) : [],
    orderId ? db.collection("auditEvents").where("entityId", "==", orderId).get() : null,
    driverRef ? driverRef.get() : null,
    driverId ? findAuthUser(driverId) : null
  ]);
  const order = orderSnap && orderSnap.exists ? docData(orderSnap) : null;
  const entries = entryDocs.map(docData);
  const auditEvents = auditSnap ? auditSnap.docs.map(docData) : [];
  const driver = driverSnap && driverSnap.exists ? docData(driverSnap) : null;

  // Un pedido que no es del smoke no se toca aunque el id cuadre: su transportista delata de quien es.
  if (order && (order.sellerId !== STORE_ID || !String(order.driverId || "").startsWith(SMOKE_PREFIX))) {
    fail(`Me niego a borrar ${orderId}: es de ${order.sellerId} con transportista ${order.driverId}.`);
  }

  // La comprobacion que hace aceptable borrar un fallido: ningun asiento en ningun corte.
  const settled = entries.filter((entry) => hasValue(entry.settlementId) || hasValue(entry.supplierSettlementId));
  if (settled.length > 0) {
    console.error(`NO SE BORRA NADA: ${settled.length} asiento(s) del pedido ${orderId} ya estan en un corte:`);
    for (const entry of settled) {
      console.error(`  ${entry.id} (${entry.type}) settlementId=${entry.settlementId || "-"} supplierSettlementId=${entry.supplierSettlementId || "-"}`);
    }
    console.error("Rige la regla general: compensar con la correccion administrativa (RF_24/RF_25 de la 001) y reportarlo.");
    process.exitCode = 1;
    return;
  }

  if (!order && entries.length === 0 && auditEvents.length === 0 && !driver && !authUser) {
    saveState({ cleanedAt: state.cleanedAt || new Date().toISOString(), driverPassword: undefined });
    console.log("Nada que borrar: el smoke ya estaba limpio.");
    return;
  }

  const backupFile = evidencePath(`smoke-backup-${fileTimestamp()}.json`);
  writeJson(backupFile, {
    backedUpAt: new Date().toISOString(),
    orderId,
    driverId,
    order,
    walletEntries: entries,
    auditEvents,
    driver,
    authUser: authUser ? { uid: authUser.uid, email: authUser.email, customClaims: authUser.customClaims || null } : null
  });
  console.log(`Respaldo en ${path.relative(REPO_ROOT, backupFile)}.`);

  const batch = db.batch();
  for (const doc of entryDocs) batch.delete(doc.ref);
  if (auditSnap) for (const doc of auditSnap.docs) batch.delete(doc.ref);
  if (order) batch.delete(orderRef);
  if (driver && driverId.startsWith(SMOKE_PREFIX)) batch.delete(driverRef);
  await batch.commit();
  if (authUser && driverId.startsWith(SMOKE_PREFIX)) await auth.deleteUser(driverId);

  saveState({ cleanedAt: new Date().toISOString(), backupFile: path.relative(REPO_ROOT, backupFile), driverPassword: undefined });
  console.log(
    `Borrado: pedido ${order ? 1 : 0}, asientos ${entries.length}, auditoria ${auditEvents.length}, ` +
      `drivers ${driver ? 1 : 0}, usuario Auth ${authUser ? 1 : 0}. Sigue con compare.`
  );
}

// ---------------------------------------------------------------------------------------------
// compare — la posicion y el saldo vuelven a las cifras de count, o exit 1.
// ---------------------------------------------------------------------------------------------

async function stepCompare() {
  const state = loadState();
  if (!state.before) fail("No hay cifras de count en el estado: no hay contra que comparar.");
  if (!state.cleanedAt) console.warn("Aviso: cleanup no consta como hecho; la comparacion puede incluir el smoke.");

  const after = await platformFigures();
  const openOrders = await openCommunityOrders();
  const differences = diffFigures(state.before, after);
  const comparedAt = new Date().toISOString();
  writeJson(evidencePath("smoke-compare.json"), {
    comparedAt,
    countedAt: state.countedAt,
    before: state.before,
    after,
    differences,
    openCommunityOrders: { before: state.openCommunityOrders ? state.openCommunityOrders.total : null, after: openOrders.total }
  });
  saveState({ comparedAt, compareOk: differences.length === 0 });

  console.log(`Saldo tienda Prueba: antes ${cop(state.before.storeBalanceCop)} / despues ${cop(after.storeBalanceCop)}`);
  for (const [name, value] of Object.entries(after.position)) {
    const was = state.before.position ? state.before.position[name] : undefined;
    console.log(`  ${name}: antes ${cop(was)} / despues ${cop(value)}${JSON.stringify(was) === JSON.stringify(value) ? "" : "   <-- DIFIERE"}`);
  }
  console.log(`Asientos: ${state.before.walletEntryCount} -> ${after.walletEntryCount}; cortes: ${state.before.settlementCount} -> ${after.settlementCount}.`);
  console.log(`Pedidos de comunidad abiertos ahora: ${openOrders.total}.`);
  if (differences.length > 0) {
    console.error(`FALLA: ${differences.length} cifra(s) no vuelven a las de count. Detalle en smoke-compare.json.`);
    process.exit(1);
  }
  console.log("OK: la posicion de la plataforma y el saldo de Prueba son los de antes del smoke.");
}

const STEPS = {
  count: stepCount,
  create: stepCreate,
  close: stepClose,
  check: stepCheck,
  cleanup: stepCleanup,
  compare: stepCompare
};

const requestedStep = process.argv[2];
if (!Object.prototype.hasOwnProperty.call(STEPS, requestedStep)) {
  console.error(USAGE);
  process.exit(1);
}

STEPS[requestedStep]()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(`El paso ${requestedStep} fallo:`, error);
    process.exit(1);
  });
