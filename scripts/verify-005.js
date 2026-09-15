/**
 * Verificacion de la spec 005 contra PRODUCCION — T1 (reproducir el fallo) y T11 (el recorrido
 * completo con cuentas desechables: DoD 4 y DoD 5).
 *
 * ORDEN DE EJECUCION
 * ------------------
 *   setup -> reproduce -> (T13: desplegar reglas) -> check -> capture -> cleanup
 *
 *   node scripts/verify-005.js setup       # crea lo desechable y guarda sus ids
 *   node scripts/verify-005.js reproduce   # SOLO LECTURA: mide el fallo con las reglas VIEJAS
 *   (T13: la persona responsable despliega firestore.rules y firma el despliegue)
 *   node scripts/verify-005.js check       # SOLO LECTURA: los cinco casos del DoD 4 con las reglas NUEVAS
 *   node scripts/verify-005.js capture     # SOLO LECTURA: capturas del DoD 5 contra un servidor local
 *   node scripts/verify-005.js cleanup     # borra lo desechable y comprueba que no queda nada
 *
 * `reproduce` va ANTES de desplegar las reglas y `check` DESPUES: el primero demuestra que el fallo
 * existia, el segundo que ya no. Ejecutar `check` con las reglas viejas da `tienda_lider: FALLA`, y
 * eso es correcto, no un error del guion.
 *
 * PARA QUE EXISTE: MEDIR ANTES DE ARREGLAR (T1)
 * --------------------------------------------
 * La spec 005 arranca de un hecho ("Brayan E-master entro y no vio su tienda") y de una DEDUCCION
 * que nadie ha comprobado: que la consulta `sellers where communityId == X` se rechaza por la forma
 * de la regla `sellerInMyCommunity`, que decide con exists() + get() sobre el id comodin del match.
 *
 * La deduccion es debil a proposito, y el plan 0 lo dice: hay al menos DOS causas posibles y el
 * codigo de error es el MISMO en las dos.
 *   1. la forma de la regla: el get() sobre el comodin no es evaluable en el modo en que se pide;
 *   2. el limite de accesos a documento: 10 por lectura simple, 20 por consulta, y cada documento
 *      candidato gasta un exists() mas un get().
 * La segunda causa NO deberia alcanzarse con una comunidad de una sola tienda. Por eso `reproduce`
 * no imprime "fallo: si/no": registra el error CRUDO, cuantas tiendas tiene la comunidad y una
 * consulta de control. Sin esas tres cosas, T2 estaria arreglando a ciegas.
 *
 * LOS TRES DESENLACES DE `reproduce` (plan 0, no dos)
 * ---------------------------------------------------
 *   NO_FALLA                  la consulta pasa -> la hipotesis esta REFUTADA. Se para, no se toca
 *                             la regla, y se corrige el plan.
 *   FALLA_PERMISSION_DENIED   compatible con la forma de la regla Y con el limite de accesos. T2
 *                             sirve para las dos (resource.data elimina el get() y el consumo de
 *                             accesos), pero la causa exacta queda anotada en la evidencia.
 *   FALLA_OTRO                otro codigo, u otra cosa: hay que mirar antes de seguir.
 * Si la consulta de CONTROL tampoco pasa, el sospechoso es la sesion y no la regla: no se puede
 * concluir nada, y el desenlace es FALLA_OTRO.
 *
 * LOS CINCO CASOS DE `check` (DoD 4)
 * ----------------------------------
 *   tienda_lider           la tienda-lider lee su tienda por id Y `sellers where communityId == A`
 *                          (>= 1 documento). Es el caso de Brayan, arreglado.
 *   tienda_ajena           la MISMA cuenta lee por id una tienda de la comunidad B: DENEGADA
 *                          (403 / PERMISSION_DENIED). Pasa si deniega: RNF_02, el arreglo no abre
 *                          de mas.
 *   lider_puro             una cuenta `community_leader` sin tienda propia consulta A: PASA.
 *   comunidad_vacia        el lider de C, que no tiene tiendas, consulta C: PASA con 0 documentos y
 *                          sin error (RF_11: "no hay tiendas" no es un fallo).
 *   tienda_sin_comunidad   una tienda sin `communityId` lee su tienda por id: PASA, y la consulta
 *                          de comunidad NO se ejecuta (RNF_01: no hay comunidad que consultar).
 *
 * El ACREEDOR (RF_12) NO se prueba en produccion: montar un acreedor real exige asientos de dinero
 * que ni se crean ni se tocan aqui. Su comportamiento queda cubierto por las pruebas puras de la
 * suite y por la guarda de no regresion sobre `isCommunityLeader`.
 *
 * LAS CAPTURAS DE `capture` (DoD 5)
 * ---------------------------------
 * Entra como la tienda-lider en un servidor de la app (`--base-url` o VERIFY_BASE_URL; por defecto
 * http://localhost:3000, porque la interfaz nueva solo existe en local hasta que se suba el hosting)
 * y guarda .png a dos anchos (escritorio y 390 px): el selector de papel de la cabecera, la pantalla
 * de la tienda y la de la comunidad. Usa el Playwright GLOBAL de esta maquina
 * (/usr/lib/node_modules/playwright); no se anade a package.json (plan §5: dependencias nuevas,
 * ninguna). No escribe en Firestore: solo navega y mira.
 *
 * QUE CREA `setup`, Y POR QUE ESE CASO
 * ------------------------------------
 * Tres comunidades desechables: A (la del lider, con una tienda dentro), B (otra, con una tienda
 * dentro: la "ajena") y C (vacia). Cuatro cuentas Auth:
 *   - la tienda-lider de A, cuya tienda propia esta FUERA de toda comunidad: exactamente el caso de
 *     Brayan, el que rompe al elegir una sola mitad de la carga;
 *   - un lider puro de A (`community_leader`, sin tienda);
 *   - el lider de C (`community_leader`);
 *   - una tienda sin comunidad, con su propia tienda.
 *
 * No se reserva el nombre corto de ninguna comunidad: el enlace publico de registro no entra en
 * esta medicion, y no escribirlo deja una coleccion menos que limpiar.
 *
 * Los pasos son idempotentes: si el proceso muere a mitad, se repite EL MISMO paso y retoma desde
 * los ids guardados en .sdd/evidence/005/verify-state.json. Si ese archivo se pierde, los ids se
 * pasan a mano (ver USAGE).
 *
 * LIMITES QUE SE RESPETAN
 * -----------------------
 * - Todo lo desechable lleva el prefijo `smoke005-`, y cleanup comprueba el prefijo ANTES de cada
 *   borrado: se borra por id guardado, nunca por consultas amplias. La unica consulta de cleanup es
 *   la de VERIFICACION final, por rango de id sobre el prefijo, y solo cuenta: no borra.
 * - No se toca E-master, ni ninguna tienda o comunidad real, ni el registro de dinero de la
 *   plataforma. Ningun paso escribe ni lee esas colecciones.
 * - `reproduce`, `check` y `capture` no escriben NADA en Firestore ni en Auth. Miden y cuentan.
 * - El estado guarda las contrasenas de las cuentas desechables mientras existen; `cleanup` las
 *   quita al borrarlas. `.sdd/evidence/` se versiona: no commitear el estado antes de `cleanup`.
 *
 * LA EJECUCION LA AUTORIZA EL HUMANO
 * ----------------------------------
 * Este guion crea cuentas y documentos REALES en el proyecto de produccion, al lado de la operacion
 * viva. Ningun agente lo ejecuta por su cuenta: ni setup, ni reproduce, ni check, ni capture, ni
 * cleanup. Lo lanza la persona responsable de la plataforma, que es tambien quien firma el
 * despliegue de reglas (plan 7, principio 7 de la constitucion).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const auth = admin.auth();

const SMOKE_PREFIX = "smoke005-";
const PROJECT_ID = "kentro-last-mile";
const WEB_API_KEY = "AIzaSyAXY_lwmuAvXCmix45QrmEG-hiwAWmNI-g";
const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;
const FIRESTORE_REST = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const REPO_ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".sdd", "evidence", "005");
const STATE_FILE = path.join(EVIDENCE_DIR, "verify-state.json");
const REPRODUCE_FILE = path.join(EVIDENCE_DIR, "verify-reproduce.json");
const CHECK_FILE = path.join(EVIDENCE_DIR, "verify-check.json");
const CAPTURE_DIR = path.join(EVIDENCE_DIR, "capturas");

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
const VIEWPORT_HEIGHT = 900;

const USAGE =
  "Uso: node scripts/verify-005.js <setup|reproduce|check|capture|cleanup> " +
  "[--uid <id>] [--community <id>] [--seller-in <id>] [--seller-own <id>] " +
  "[--community-b <id>] [--seller-b <id>] [--community-empty <id>] " +
  "[--leader-uid <id>] [--empty-leader-uid <id>] [--solo-uid <id>] [--seller-solo <id>] " +
  "[--base-url <url>]";

// ---------------------------------------------------------------------------------------------
// Ayudantes sin escrituras en Firestore ni en Auth. Los alcanzan tambien los pasos de solo lectura.
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

/** Una cuenta anidada del estado (`pureLeader`, `emptyLeader`, `soloSeller`), o un objeto vacio. */
function nestedAccount(state, key, uidOverride) {
  const account = state[key] && typeof state[key] === "object" ? state[key] : {};
  if (uidOverride) return { ...account, uid: uidOverride };
  return account;
}

/** Ids de lo desechable: los argumentos mandan sobre el estado, para reanudar sin archivo. */
function smokeIds() {
  const state = loadState();
  return {
    state,
    uid: argValue("--uid") || state.uid,
    communityId: argValue("--community") || state.communityId,
    communitySellerId: argValue("--seller-in") || state.communitySellerId,
    ownSellerId: argValue("--seller-own") || state.ownSellerId,
    otherCommunityId: argValue("--community-b") || state.otherCommunityId,
    otherSellerId: argValue("--seller-b") || state.otherSellerId,
    emptyCommunityId: argValue("--community-empty") || state.emptyCommunityId,
    soloSellerId: argValue("--seller-solo") || state.soloSellerId,
    pureLeader: nestedAccount(state, "pureLeader", argValue("--leader-uid")),
    emptyLeader: nestedAccount(state, "emptyLeader", argValue("--empty-leader-uid")),
    soloSeller: nestedAccount(state, "soloSeller", argValue("--solo-uid"))
  };
}

function statePath() {
  return path.relative(REPO_ROOT, STATE_FILE);
}

async function findAuthUser(uid) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// setup — tres comunidades, cuatro tiendas y cuatro cuentas. Idempotente.
// ---------------------------------------------------------------------------------------------

/**
 * Una cuenta Auth desechable. `known` es lo que el estado ya sabe de ella (uid/email/password);
 * `persist` guarda lo decidido ANTES de crear: si el proceso muere justo despues de dar de alta la
 * cuenta, la reanudacion reusa el mismo uid y la misma contrasena en vez de dejar una cuenta
 * inaccesible.
 */
async function ensureAuthAccount(input) {
  const { known, defaultUid, displayName, persist } = input;
  const uid = (known && known.uid) || defaultUid;
  if (!uid.startsWith(SMOKE_PREFIX)) fail(`Me niego a tocar la cuenta ${uid}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const sameAccount = Boolean(known && known.uid === uid);
  const email = sameAccount && known.email ? known.email : `${uid}@kentro.invalid`;
  const knownPassword = sameAccount ? known.password : undefined;
  const password = knownPassword || crypto.randomBytes(24).toString("base64url");

  persist({ uid, email, password });

  const existing = await findAuthUser(uid);
  if (!existing) {
    await auth.createUser({ uid, email, password, displayName });
    console.log(`Usuario Auth creado: ${uid} <${email}>`);
  } else if (!knownPassword) {
    // Adoptada sin estado: la contrasena original se perdio con el archivo.
    await auth.updateUser(uid, { password });
    console.log(`Usuario Auth ${uid} adoptado con contrasena nueva.`);
  } else {
    console.log(`Usuario Auth ${uid} ya existia; se reusa.`);
  }
  return { uid, email, password };
}

async function ensureCommunity(input) {
  const { communityId, name, leaderUid, now } = input;
  if (!communityId.startsWith(SMOKE_PREFIX)) {
    fail(`Me niego a tocar la comunidad ${communityId}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  }
  const ref = db.collection("communities").doc(communityId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    await ref.create({
      id: communityId,
      name,
      slug: communityId,
      leaderName: "Verify 005",
      leaderEmail: `${communityId}@kentro.invalid`,
      leaderPhone: "",
      linkStatus: "active",
      status: "active",
      leaderUid,
      leaderGrantedAt: now,
      pricing: {},
      createdAt: now,
      updatedAt: now
    });
    console.log(`communities/${communityId} creada: activa y con leaderUid "${leaderUid}".`);
    return communityId;
  }
  if (snapshot.get("leaderUid") !== leaderUid) {
    await ref.update({ leaderUid, leaderGrantedAt: now, updatedAt: now });
    console.log(`communities/${communityId} ya existia; se le repone leaderUid "${leaderUid}".`);
  } else {
    console.log(`communities/${communityId} ya existia; se reusa.`);
  }
  return communityId;
}

/**
 * Tienda desechable. Sin ciudad y sin onboarding a proposito: asi no puede crear pedidos ni entrar
 * en la operacion real ni por accidente. `communityId` vacio = fuera de toda comunidad.
 */
async function ensureSeller(input) {
  const { sellerId, name, communityId, now } = input;
  if (!sellerId.startsWith(SMOKE_PREFIX)) fail(`Me niego a tocar la tienda ${sellerId}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const ref = db.collection("sellers").doc(sellerId);
  const snapshot = await ref.get();
  if (snapshot.exists) {
    console.log(`sellers/${sellerId} ya existia; se reusa.`);
    return sellerId;
  }
  const document = {
    id: sellerId,
    name,
    shopDomain: "",
    cityId: "",
    bankAccount: "",
    onboardingComplete: false,
    createdAt: now,
    updatedAt: now
  };
  if (communityId) {
    document.communityId = communityId;
    document.communityJoinedAt = now;
  }
  await ref.create(document);
  console.log(`sellers/${sellerId} creada${communityId ? ` dentro de ${communityId}` : " fuera de toda comunidad"}.`);
  return sellerId;
}

async function stepSetup() {
  const state = loadState();
  const runId = state.runId || String(Date.now());
  const now = new Date().toISOString();

  // --- Las cuatro cuentas Auth. Una llamada por cuenta: cleanup borra por id guardado, y un bucle
  // escondería cuantas hay.
  const leaderAccount = await ensureAuthAccount({
    known: { uid: state.uid, email: state.email, password: state.password },
    defaultUid: `${SMOKE_PREFIX}${runId}`,
    displayName: "Verify 005 tienda-lider (desechable)",
    persist: (account) => saveState(account)
  });
  const pureLeaderAccount = await ensureAuthAccount({
    known: nestedAccount(loadState(), "pureLeader"),
    defaultUid: `${SMOKE_PREFIX}leader-${runId}`,
    displayName: "Verify 005 lider puro (desechable)",
    persist: (account) => saveState({ pureLeader: account })
  });
  const emptyLeaderAccount = await ensureAuthAccount({
    known: nestedAccount(loadState(), "emptyLeader"),
    defaultUid: `${SMOKE_PREFIX}leader-empty-${runId}`,
    displayName: "Verify 005 lider de comunidad vacia (desechable)",
    persist: (account) => saveState({ emptyLeader: account })
  });
  const soloSellerAccount = await ensureAuthAccount({
    known: nestedAccount(loadState(), "soloSeller"),
    defaultUid: `${SMOKE_PREFIX}solo-${runId}`,
    displayName: "Verify 005 tienda sin comunidad (desechable)",
    persist: (account) => saveState({ soloSeller: account })
  });

  // --- Las tres comunidades: A (del lider), B (ajena, con tienda) y C (vacia).
  const communityId = await ensureCommunity({
    communityId: loadState().communityId || `${SMOKE_PREFIX}com-${runId}`,
    name: "Verify 005 A - la del lider (desechable)",
    leaderUid: leaderAccount.uid,
    now
  });
  const otherCommunityId = await ensureCommunity({
    communityId: loadState().otherCommunityId || `${SMOKE_PREFIX}com-b-${runId}`,
    name: "Verify 005 B - ajena, con una tienda (desechable)",
    leaderUid: "",
    now
  });
  const emptyCommunityId = await ensureCommunity({
    communityId: loadState().emptyCommunityId || `${SMOKE_PREFIX}com-empty-${runId}`,
    name: "Verify 005 C - vacia (desechable)",
    leaderUid: emptyLeaderAccount.uid,
    now
  });

  // --- Las cuatro tiendas: dentro de A, propia del lider FUERA, dentro de B, y la de la tienda sola.
  const communitySellerId = await ensureSeller({
    sellerId: loadState().communitySellerId || `${SMOKE_PREFIX}seller-in-${runId}`,
    name: "Verify 005 - tienda DENTRO de la comunidad A (desechable)",
    communityId,
    now
  });
  const ownSellerId = await ensureSeller({
    sellerId: loadState().ownSellerId || `${SMOKE_PREFIX}seller-own-${runId}`,
    name: "Verify 005 - tienda del lider, FUERA de toda comunidad (desechable)",
    communityId: "",
    now
  });
  const otherSellerId = await ensureSeller({
    sellerId: loadState().otherSellerId || `${SMOKE_PREFIX}seller-b-${runId}`,
    name: "Verify 005 - tienda DENTRO de la comunidad B, ajena al lider (desechable)",
    communityId: otherCommunityId,
    now
  });
  const soloSellerId = await ensureSeller({
    sellerId: loadState().soloSellerId || `${SMOKE_PREFIX}seller-solo-${runId}`,
    name: "Verify 005 - tienda sin comunidad (desechable)",
    communityId: "",
    now
  });

  // --- Los reclamos. El caso de Brayan, exactamente: la cuenta es tienda (la de FUERA) y ademas
  // lidera la comunidad A. `communityStanding: "leader"` es lo que la regla exige para no tratarla
  // como acreedora; los lideres puros lo llevan por la misma razon.
  const leaderClaims = { role: "seller", sellerId: ownSellerId, communityId, communityStanding: "leader" };
  await auth.setCustomUserClaims(leaderAccount.uid, leaderClaims);
  console.log(`Reclamos de ${leaderAccount.uid}: ${JSON.stringify(leaderClaims)}`);

  const pureLeaderClaims = { role: "community_leader", communityId, communityStanding: "leader" };
  await auth.setCustomUserClaims(pureLeaderAccount.uid, pureLeaderClaims);
  console.log(`Reclamos de ${pureLeaderAccount.uid}: ${JSON.stringify(pureLeaderClaims)}`);

  const emptyLeaderClaims = { role: "community_leader", communityId: emptyCommunityId, communityStanding: "leader" };
  await auth.setCustomUserClaims(emptyLeaderAccount.uid, emptyLeaderClaims);
  console.log(`Reclamos de ${emptyLeaderAccount.uid}: ${JSON.stringify(emptyLeaderClaims)}`);

  const soloSellerClaims = { role: "seller", sellerId: soloSellerId };
  await auth.setCustomUserClaims(soloSellerAccount.uid, soloSellerClaims);
  console.log(`Reclamos de ${soloSellerAccount.uid}: ${JSON.stringify(soloSellerClaims)}`);

  saveState({
    runId,
    communityId,
    communitySellerId,
    ownSellerId,
    otherCommunityId,
    otherSellerId,
    emptyCommunityId,
    soloSellerId,
    claims: leaderClaims,
    pureLeader: { ...pureLeaderAccount, claims: pureLeaderClaims },
    emptyLeader: { ...emptyLeaderAccount, claims: emptyLeaderClaims },
    soloSeller: { ...soloSellerAccount, claims: soloSellerClaims },
    setupAt: state.setupAt || now
  });
  console.log(`Estado guardado en ${statePath()}. Sigue con: node scripts/verify-005.js reproduce`);
  console.log("Recuerda: ese archivo lleva las contrasenas de las cuentas desechables hasta el cleanup.");
}

// ---------------------------------------------------------------------------------------------
// Lecturas por REST como una cuenta desechable. Las comparten `reproduce` y `check`.
// ---------------------------------------------------------------------------------------------

async function signInDisposable(email, password) {
  const response = await fetch(SIGN_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const payload = await response.json();
  if (!response.ok || !payload.idToken) {
    fail(`signInWithPassword fallo con ${response.status}: ${JSON.stringify(payload.error || payload)}`);
  }
  return payload.idToken;
}

/** El error que trae una respuesta REST de Firestore, venga suelto o dentro del array de runQuery. */
function restError(payload) {
  if (payload && payload.error) return payload.error;
  if (Array.isArray(payload)) {
    for (const row of payload) {
      if (row && row.error) return row.error;
    }
  }
  return null;
}

function restDocumentCount(payload) {
  if (Array.isArray(payload)) return payload.filter((row) => row && row.document).length;
  if (payload && payload.name) return 1;
  return 0;
}

/**
 * Una lectura hecha COMO la cuenta desechable, por la API REST y no por el SDK admin: el admin
 * ignora las reglas, y las reglas son justo lo que se esta midiendo.
 *
 * Devuelve el error CRUDO y completo —code, status y message tal cual—, no un booleano: con dos
 * causas posibles que dan el mismo codigo, un si/no no distingue nada.
 */
async function restRead(idToken, label, url, body) {
  const options = {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const failure = restError(payload);
  const passed = response.ok && !failure;
  return {
    label,
    passed,
    httpStatus: response.status,
    code: failure ? failure.code : null,
    status: failure ? failure.status : null,
    message: failure ? failure.message : null,
    documentCount: passed ? restDocumentCount(payload) : null,
    raw: text.slice(0, 4000)
  };
}

/** El cuerpo de `runQuery` que hace la carga inicial: `sellers where communityId == X`. */
function communityStoresQuery(communityId) {
  return {
    structuredQuery: {
      from: [{ collectionId: "sellers" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "communityId" },
          op: "EQUAL",
          value: { stringValue: communityId }
        }
      }
    }
  };
}

function describeRead(read) {
  if (read.passed) return `  ${read.label}: PASA, ${read.documentCount} documentos`;
  return `  ${read.label}: FALLA http=${read.httpStatus} code=${read.code} status=${read.status} message=${read.message}`;
}

// ---------------------------------------------------------------------------------------------
// reproduce — SOLO LECTURA. Entra por REST como la cuenta desechable y mide las dos consultas de
// la carga inicial (state-store.ts:182-193) mas una de control.
// ---------------------------------------------------------------------------------------------

/** Los tres desenlaces del plan 0. El control manda: sin sesion sana no se concluye nada. */
function reproduceOutcome(communityStores, control) {
  if (communityStores.passed) return "NO_FALLA";
  if (!control.passed) return "FALLA_OTRO";
  if (communityStores.httpStatus === 403 || communityStores.status === "PERMISSION_DENIED") {
    return "FALLA_PERMISSION_DENIED";
  }
  return "FALLA_OTRO";
}

function outcomeReport(input) {
  const { outcome, communitySellerCount, control } = input;
  if (outcome === "NO_FALLA") {
    return [
      "La consulta de las tiendas de la comunidad PASA con la regla de hoy.",
      "La hipotesis del plan queda REFUTADA: el 403 no viene de la forma de sellerInMyCommunity.",
      "Hay que PARAR, no tocar la regla y corregir el plan: la tienda desaparece por otra razon."
    ];
  }
  if (outcome === "FALLA_PERMISSION_DENIED") {
    return [
      "La consulta se rechaza por permisos. Esto es compatible con las DOS causas del plan 0, que",
      "dan el mismo codigo: la forma de la regla (get sobre el comodin) y el limite de accesos a",
      "documento (10 por lectura simple, 20 por consulta; cada candidato gasta un exists y un get).",
      `Esta comunidad tiene ${communitySellerCount} tienda(s): con una sola tienda el limite de accesos NO`,
      "deberia alcanzarse, y eso DEBILITA la deduccion de que la causa sea la forma de la regla.",
      "T2 sirve para las dos causas —resource.data quita el get y el consumo de accesos—, pero la",
      "causa exacta no queda demostrada aqui: hay que anotarla en la spec como no concluyente."
    ];
  }
  if (!control.passed) {
    return [
      "La consulta de CONTROL tampoco pasa, y esa esta abierta a cualquier sesion iniciada.",
      "El sospechoso es la sesion, no la regla: no se puede concluir nada sobre sellerInMyCommunity.",
      "Hay que mirar la sesion desechable y sus reclamos ANTES de seguir con T2."
    ];
  }
  return [
    "La consulta falla con un codigo que no es de permisos. No es ninguno de los dos casos previstos.",
    "Hay que mirar que es —indice que falta, otra regla, error de la peticion— ANTES de seguir con T2."
  ];
}

async function stepReproduce() {
  const { state, communityId, ownSellerId } = smokeIds();
  if (!state.email || !state.password || !communityId || !ownSellerId) {
    fail(`Falta el estado de setup en ${statePath()}. Ejecuta primero: node scripts/verify-005.js setup`);
  }

  const idToken = await signInDisposable(state.email, state.password);

  // (a) La tienda propia por id: lo que hace `getOwnDocument` en la carga inicial.
  const ownStore = await restRead(idToken, "tienda propia por id", `${FIRESTORE_REST}/sellers/${ownSellerId}`);

  // (b) Las tiendas de su comunidad: la mitad que se sospecha rechazada.
  const communityStores = await restRead(
    idToken,
    "sellers where communityId == la suya",
    `${FIRESTORE_REST}:runQuery`,
    communityStoresQuery(communityId)
  );

  // Consulta de control: `cities` esta abierta a cualquier sesion iniciada. Si esta tambien falla,
  // el problema es la sesion y no la regla, y la medicion no concluye nada.
  const control = await restRead(idToken, "control: cities, abierta a cualquier sesion", `${FIRESTORE_REST}:runQuery`, {
    structuredQuery: { from: [{ collectionId: "cities" }], limit: 1 }
  });

  // Cuantas tiendas tiene de verdad la comunidad, leido con el SDK admin, que no pasa por reglas:
  // es el numero que separa las dos causas posibles del plan 0.
  const communitySnapshot = await db.collection("sellers").where("communityId", "==", communityId).get();
  const communitySellerCount = communitySnapshot.size;

  const outcome = reproduceOutcome(communityStores, control);
  const report = outcomeReport({ outcome, communitySellerCount, control });
  const reproducedAt = new Date().toISOString();
  writeJson(REPRODUCE_FILE, {
    reproducedAt,
    uid: state.uid,
    claims: state.claims || null,
    communityId,
    ownSellerId,
    communitySellerCount,
    outcome,
    report,
    ownStore,
    communityStores,
    control
  });
  saveState({ reproducedAt, outcome });

  console.log(`Cuenta ${state.uid}: tienda propia ${ownSellerId}, comunidad ${communityId}.`);
  console.log("Lecturas como esa cuenta, por REST:");
  console.log(describeRead(ownStore));
  console.log(describeRead(communityStores));
  console.log(describeRead(control));
  console.log(`Tiendas de la comunidad segun el SDK admin: ${communitySellerCount}`);
  console.log(`DESENLACE: ${outcome}`);
  for (const line of report) console.log(`  ${line}`);
  console.log(`Evidencia completa en ${path.relative(REPO_ROOT, REPRODUCE_FILE)}.`);
}

// ---------------------------------------------------------------------------------------------
// check — SOLO LECTURA. Los cinco casos del DoD 4, por REST, con las reglas de T13 desplegadas.
// ---------------------------------------------------------------------------------------------

/** Una negativa de permisos, que es lo que `tienda_ajena` ESPERA. */
function isDenied(read) {
  return !read.passed && (read.httpStatus === 403 || read.status === "PERMISSION_DENIED");
}

function checkCase(name, passed, expectation, reads) {
  return { name, passed, expectation, reads };
}

function describeCase(result) {
  return `${result.passed ? "PASA" : "FALLA"}  ${result.name}: ${result.expectation}`;
}

async function stepCheck() {
  const ids = smokeIds();
  const { state, communityId, ownSellerId, otherSellerId, emptyCommunityId, soloSellerId } = ids;
  const { pureLeader, emptyLeader, soloSeller } = ids;
  const missing = [];
  if (!state.email || !state.password || !ownSellerId || !communityId) missing.push("tienda-lider");
  if (!otherSellerId) missing.push("tienda de la comunidad B");
  if (!pureLeader.email || !pureLeader.password) missing.push("lider puro");
  if (!emptyLeader.email || !emptyLeader.password || !emptyCommunityId) missing.push("lider de la comunidad vacia");
  if (!soloSeller.email || !soloSeller.password || !soloSellerId) missing.push("tienda sin comunidad");
  if (missing.length > 0) {
    fail(`Falta en ${statePath()}: ${missing.join(", ")}. Ejecuta primero: node scripts/verify-005.js setup`);
  }

  const results = [];

  // tienda_lider — RF_01, RF_05: las dos mitades de la carga, como Brayan.
  const leaderToken = await signInDisposable(state.email, state.password);
  const leaderOwnStore = await restRead(leaderToken, "tienda_lider: tienda propia por id", `${FIRESTORE_REST}/sellers/${ownSellerId}`);
  const leaderCommunityStores = await restRead(
    leaderToken,
    "tienda_lider: sellers where communityId == A",
    `${FIRESTORE_REST}:runQuery`,
    communityStoresQuery(communityId)
  );
  results.push(
    checkCase(
      "tienda_lider",
      leaderOwnStore.passed && leaderCommunityStores.passed && leaderCommunityStores.documentCount >= 1,
      "lee su tienda por id y la consulta de su comunidad devuelve al menos una tienda",
      { ownStore: leaderOwnStore, communityStores: leaderCommunityStores }
    )
  );

  // tienda_ajena — RNF_02: la misma cuenta NO puede leer una tienda de otra comunidad.
  const foreignStore = await restRead(leaderToken, "tienda_ajena: tienda de B por id", `${FIRESTORE_REST}/sellers/${otherSellerId}`);
  results.push(
    checkCase(
      "tienda_ajena",
      isDenied(foreignStore),
      "la tienda de la comunidad B se le DENIEGA (403 / PERMISSION_DENIED)",
      { foreignStore }
    )
  );

  // lider_puro — RF_05: `community_leader` sin tienda propia, la consulta de comunidad pasa.
  const pureToken = await signInDisposable(pureLeader.email, pureLeader.password);
  const pureCommunityStores = await restRead(
    pureToken,
    "lider_puro: sellers where communityId == A",
    `${FIRESTORE_REST}:runQuery`,
    communityStoresQuery(communityId)
  );
  results.push(
    checkCase(
      "lider_puro",
      pureCommunityStores.passed && pureCommunityStores.documentCount >= 1,
      "la consulta de su comunidad pasa y devuelve al menos una tienda",
      { communityStores: pureCommunityStores }
    )
  );

  // comunidad_vacia — RF_11: cero tiendas NO es un error.
  const emptyToken = await signInDisposable(emptyLeader.email, emptyLeader.password);
  const emptyCommunityStores = await restRead(
    emptyToken,
    "comunidad_vacia: sellers where communityId == C",
    `${FIRESTORE_REST}:runQuery`,
    communityStoresQuery(emptyCommunityId)
  );
  results.push(
    checkCase(
      "comunidad_vacia",
      emptyCommunityStores.passed && emptyCommunityStores.documentCount === 0,
      "la consulta de su comunidad pasa con 0 documentos y sin error",
      { communityStores: emptyCommunityStores }
    )
  );

  // tienda_sin_comunidad — RNF_01: sin communityId no hay consulta de comunidad que hacer.
  const soloToken = await signInDisposable(soloSeller.email, soloSeller.password);
  const soloOwnStore = await restRead(soloToken, "tienda_sin_comunidad: tienda propia por id", `${FIRESTORE_REST}/sellers/${soloSellerId}`);
  results.push(
    checkCase(
      "tienda_sin_comunidad",
      soloOwnStore.passed,
      "lee su tienda por id; la consulta de comunidad no se ejecuta porque no tiene communityId",
      { ownStore: soloOwnStore, communityStores: "no ejecutada: la cuenta no tiene communityId" }
    )
  );

  const allPassed = results.every((result) => result.passed);
  const checkedAt = new Date().toISOString();
  writeJson(CHECK_FILE, {
    checkedAt,
    allPassed,
    accounts: {
      storeLeader: { uid: state.uid, claims: state.claims || null },
      pureLeader: { uid: pureLeader.uid, claims: pureLeader.claims || null },
      emptyLeader: { uid: emptyLeader.uid, claims: emptyLeader.claims || null },
      soloSeller: { uid: soloSeller.uid, claims: soloSeller.claims || null }
    },
    ids: { communityId, ownSellerId, otherSellerId, emptyCommunityId, soloSellerId },
    results
  });
  saveState({ checkedAt, checkPassed: allPassed });

  console.log("Los cinco casos del DoD 4, por REST y con las reglas desplegadas:");
  for (const result of results) console.log(`  ${describeCase(result)}`);
  console.log(`RESULTADO: ${allPassed ? "PASA" : "FALLA"} (${results.filter((r) => r.passed).length}/${results.length})`);
  console.log(`Evidencia completa en ${path.relative(REPO_ROOT, CHECK_FILE)}.`);
  if (!allPassed) {
    console.log("Si `tienda_lider` FALLA y las reglas de T13 aun no estan desplegadas, es lo esperado: check va DESPUES de T13.");
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------
// capture — SOLO LECTURA. Entra como la tienda-lider en un servidor de la app y guarda las capturas
// del DoD 5 a dos anchos. Playwright es el GLOBAL de la maquina: no esta en package.json.
// ---------------------------------------------------------------------------------------------

function loadPlaywright() {
  const playwrightPath = require.resolve("playwright", { paths: [process.cwd(), "/usr/lib/node_modules"] });
  return require(playwrightPath);
}

function baseUrl() {
  return argValue("--base-url") || process.env.VERIFY_BASE_URL || "http://localhost:3000";
}

/** Los .png de un ancho: el selector de papel, la pantalla de la tienda y la de la comunidad. */
async function captureAtWidth(page, width, label) {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  const hatPicker = page.getByRole("group", { name: "Papel activo" });
  await hatPicker.waitFor({ state: "visible", timeout: 60000 });

  await page.getByRole("button", { name: "Tienda" }).click();
  await page.waitForTimeout(1500);
  await hatPicker.screenshot({ path: path.join(CAPTURE_DIR, `${label}-selector-de-papel.png`) });
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${label}-pantalla-tienda.png`), fullPage: true });

  await page.getByRole("button", { name: "Comunidad" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${label}-pantalla-comunidad.png`), fullPage: true });
  console.log(`Capturas a ${width}px guardadas con el prefijo ${label}.`);
}

async function stepCapture() {
  const { state } = smokeIds();
  if (!state.email || !state.password) {
    fail(`Falta la cuenta tienda-lider en ${statePath()}. Ejecuta primero: node scripts/verify-005.js setup`);
  }
  const url = baseUrl();
  const { chromium } = loadPlaywright();
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: DESKTOP_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  try {
    console.log(`Abriendo ${url} como ${state.email}...`);
    // `networkidle` y una pausa, no `domcontentloaded`: con el DOM listo pero React sin hidratar,
    // el `fill` no llega al estado del componente y el clic envia el formulario de forma NATIVA —
    // la pagina se recarga y vuelve vacia, sin error ni "Entrando...". Medido el 2026-09-15: con
    // `domcontentloaded` el selector no aparecia en 60 s; con esto, en 5 s.
    await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.getByLabel("Email").fill(state.email);
    await page.getByLabel("Contrasena").fill(state.password);
    await page.getByRole("button", { name: "Entrar" }).click();

    await captureAtWidth(page, DESKTOP_WIDTH, "escritorio");
    await captureAtWidth(page, MOBILE_WIDTH, "movil");
  } finally {
    await context.close();
    await browser.close();
  }

  saveState({ capturedAt: new Date().toISOString(), captureBaseUrl: url });
  console.log(`Capturas en ${path.relative(REPO_ROOT, CAPTURE_DIR)}/.`);
}

// ---------------------------------------------------------------------------------------------
// cleanup — borra SOLO lo del prefijo, por id guardado, y comprueba al final que no queda nada.
// Idempotente.
// ---------------------------------------------------------------------------------------------

async function deleteIfSmoke(collectionName, id) {
  if (!id) return 0;
  if (!id.startsWith(SMOKE_PREFIX)) {
    fail(`Me niego a borrar ${collectionName}/${id}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  }
  const ref = db.collection(collectionName).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return 0;
  await ref.delete();
  console.log(`Borrado ${collectionName}/${id}.`);
  return 1;
}

async function deleteAuthIfSmoke(uid) {
  if (!uid) return 0;
  if (!uid.startsWith(SMOKE_PREFIX)) {
    fail(`Me niego a borrar la cuenta ${uid}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  }
  const existing = await findAuthUser(uid);
  if (!existing) return 0;
  await auth.deleteUser(uid);
  console.log(`Borrado el usuario Auth ${uid}.`);
  return 1;
}

/** Cuantos documentos de la coleccion siguen llevando el prefijo: rango por id, solo cuenta. */
async function countSmokeDocuments(collectionName) {
  const snapshot = await db
    .collection(collectionName)
    .where(admin.firestore.FieldPath.documentId(), ">=", SMOKE_PREFIX)
    .where(admin.firestore.FieldPath.documentId(), "<", SMOKE_PREFIX + "\uf8ff")
    .get();
  return snapshot.size;
}

/** Cuantas cuentas Auth siguen teniendo un email con el prefijo (los emails son `<uid>@kentro.invalid`). */
async function countSmokeAuthUsers() {
  let count = 0;
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    count += page.users.filter((user) => typeof user.email === "string" && user.email.startsWith(SMOKE_PREFIX)).length;
    pageToken = page.pageToken;
  } while (pageToken);
  return count;
}

/** La verificacion final: va DESPUES de los borrados, si no contaria lo que esta a punto de irse. */
async function reportLeftovers() {
  const communities = await countSmokeDocuments("communities");
  const sellers = await countSmokeDocuments("sellers");
  const accounts = await countSmokeAuthUsers();
  const remaining = communities + sellers + accounts;
  if (remaining === 0) {
    console.log(`LIMPIO: no queda ningun documento ni cuenta con el prefijo ${SMOKE_PREFIX}.`);
  } else {
    console.log(`QUEDAN ${remaining} con el prefijo ${SMOKE_PREFIX}: comunidades ${communities}, tiendas ${sellers}, cuentas Auth ${accounts}.`);
    console.log("Pasa sus ids a mano con los flags de USAGE, o repite el paso si el estado los tiene.");
    process.exitCode = 1;
  }
  return remaining;
}

async function stepCleanup() {
  const ids = smokeIds();
  const { uid, communityId, communitySellerId, ownSellerId } = ids;
  const { otherCommunityId, otherSellerId, emptyCommunityId, soloSellerId } = ids;
  const { pureLeader, emptyLeader, soloSeller } = ids;
  const anyId = [uid, communityId, communitySellerId, ownSellerId, otherCommunityId, otherSellerId, emptyCommunityId, soloSellerId, pureLeader.uid, emptyLeader.uid, soloSeller.uid].some(Boolean);
  if (!anyId) {
    fail(`No hay ids de lo desechable en ${statePath()}. ${USAGE}`);
  }

  const communityA = await deleteIfSmoke("communities", communityId);
  const communityB = await deleteIfSmoke("communities", otherCommunityId);
  const communityC = await deleteIfSmoke("communities", emptyCommunityId);
  const sellerInside = await deleteIfSmoke("sellers", communitySellerId);
  const sellerOutside = await deleteIfSmoke("sellers", ownSellerId);
  const sellerOther = await deleteIfSmoke("sellers", otherSellerId);
  const sellerSolo = await deleteIfSmoke("sellers", soloSellerId);
  const leaderAccount = await deleteAuthIfSmoke(uid);
  const pureLeaderAccount = await deleteAuthIfSmoke(pureLeader.uid);
  const emptyLeaderAccount = await deleteAuthIfSmoke(emptyLeader.uid);
  const soloSellerAccount = await deleteAuthIfSmoke(soloSeller.uid);

  // Las contrasenas salen del archivo en cuanto las cuentas dejan de existir: `.sdd/evidence/` se
  // versiona.
  saveState({
    cleanedAt: new Date().toISOString(),
    password: undefined,
    pureLeader: { ...pureLeader, password: undefined },
    emptyLeader: { ...emptyLeader, password: undefined },
    soloSeller: { ...soloSeller, password: undefined }
  });
  console.log(
    `Borrado: comunidades ${communityA + communityB + communityC}, ` +
      `tiendas ${sellerInside + sellerOutside + sellerOther + sellerSolo}, ` +
      `cuentas Auth ${leaderAccount + pureLeaderAccount + emptyLeaderAccount + soloSellerAccount}. ` +
      "Repetir este paso no falla: lo ya borrado cuenta cero."
  );

  await reportLeftovers();
}

const STEPS = {
  setup: stepSetup,
  reproduce: stepReproduce,
  check: stepCheck,
  capture: stepCapture,
  cleanup: stepCleanup
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
