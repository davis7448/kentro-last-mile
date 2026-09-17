/**
 * Verificacion de la spec 013 contra PRODUCCION — T7: la medida real del formulario de pedido
 * manual (DoD 2) y las guias impresas de los dos pedidos de ejemplo (DoD 3).
 *
 * ORDEN DE EJECUCION
 * ------------------
 *   setup -> capture -> cleanup
 *
 *   node scripts/verify-013.js setup                      # crea lo desechable y guarda sus ids
 *   node scripts/verify-013.js capture [--base-url URL]   # SOLO LECTURA: mide y captura
 *   node scripts/verify-013.js cleanup                    # borra lo desechable por id
 *
 * Mismo esqueleto que `verify-005.js`: admin SDK con ADC contra el proyecto kentro-last-mile,
 * entrada por REST (`signInWithPassword`) como la cuenta desechable, Playwright GLOBAL de esta
 * maquina (/usr/lib/node_modules/playwright; no se anade a package.json).
 *
 * QUE CREA `setup`
 * ----------------
 * Una tienda, una cuenta Auth con reclamos `{ role: "seller", sellerId }` (la app resuelve la
 * sesion SOLO por reclamos, como comprobo la 005: no hay coleccion de perfiles que escribir) y DOS
 * pedidos en `ready_to_assign`:
 *   - el "viejo": la observacion de la tienda vive en `normalizedAddress` ("timbre azul...") y no
 *     hay `deliveryNotes`. Es el caso que rompia la guia: el mensajero salia sin direccion.
 *   - el "nuevo": direccion original, una corregida DISTINTA y `deliveryNotes` con indicaciones.
 * Los ids, el email y la contrasena quedan en `.sdd/evidence/013/state.json`.
 *
 * QUE MIDE `capture` (no escribe NADA en Firestore ni en Auth)
 * ------------------------------------------------------------
 * Entra como la tienda en un servidor de la app (`--base-url` o VERIFY_BASE_URL; por defecto
 * http://localhost:3005), despliega a la vez "Crear pedido manual" y "Solicitudes de liquidacion",
 * y a 1280 px y a 390 px mide dentro del navegador:
 *   - RF_01: `document.documentElement.scrollWidth === clientWidth` (sin desplazamiento horizontal);
 *   - RF_04: para cada input/select/textarea/button del formulario, `getBoundingClientRect()`:
 *     `height >= 44` y `right <= window.innerWidth`.
 * Guarda `medidas-escritorio.json`, `medidas-movil.json` y una captura de pagina entera por ancho.
 * Luego, en escritorio, abre cada pedido, pulsa "Imprimir rotulo", captura la ventana emergente y
 * comprueba en su texto los rotulos `Direccion`, `Correccion o nota` e `Indicaciones` segun el
 * pedido (DoD 3). La emergente llama a `window.print()` al cargar: se anula con un init script del
 * contexto para que no bloquee. Pulsar imprimir hace que la APP marque el rotulo como impreso
 * (`markOrdersLabelsPrinted`, escritura del navegador con la sesion de la tienda, no de este guion).
 * El resumen va a `resultado-capture.json`; si algo no esta ok sale con codigo 1, pero deja la
 * evidencia escrita.
 *
 * LIMITES QUE SE RESPETAN
 * -----------------------
 * - Todo lo desechable lleva el prefijo `smoke013-` y cleanup comprueba el prefijo ANTES de cada
 *   borrado: se borra por id guardado, nunca por consultas ni listados.
 * - No se toca ninguna tienda, cuenta ni pedido real. Ningun paso lee colecciones enteras.
 * - `state.json` lleva la contrasena de la cuenta desechable mientras existe; `cleanup` la quita.
 *   `.sdd/evidence/` se versiona: purgar las contrasenas ANTES del commit.
 *
 * LA EJECUCION LA LANZA EL HUMANO U ORQUESTADOR
 * ---------------------------------------------
 * Este guion crea una cuenta y documentos REALES en el proyecto de produccion, al lado de la
 * operacion viva. Ningun subagente lo ejecuta por su cuenta (plan §2.6).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();
const auth = admin.auth();

const SMOKE_PREFIX = "smoke013-";
const WEB_API_KEY = "AIzaSyAXY_lwmuAvXCmix45QrmEG-hiwAWmNI-g";
const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;

const REPO_ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".sdd", "evidence", "013");
const CAPTURE_DIR = path.join(EVIDENCE_DIR, "capturas");
const STATE_FILENAME = "state.json";

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
const VIEWPORT_HEIGHT = 900;
const MIN_CONTROL_HEIGHT = 44;
const DEFAULT_BASE_URL = "http://localhost:3005";

const USAGE = "Uso: node scripts/verify-013.js <setup|capture|cleanup> [--base-url <url>]";

// ---------------------------------------------------------------------------------------------
// Ayudantes sin escrituras en Firestore ni en Auth. Los alcanza tambien `capture`.
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

/** Escribe un archivo de evidencia. La ruta se compone AQUI, junto a la escritura (contrato T7, punto 4). */
function writeEvidence(fileName, value) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, fileName), body);
}

function loadState() {
  const stateFile = path.join(EVIDENCE_DIR, STATE_FILENAME);
  if (!fs.existsSync(stateFile)) return {};
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

/** Mezcla `patch` en el estado. Una clave a `undefined` desaparece del archivo. */
function saveState(patch) {
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, STATE_FILENAME), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function statePath() {
  return path.relative(REPO_ROOT, path.join(EVIDENCE_DIR, STATE_FILENAME));
}

async function findAuthUser(uid) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") return null;
    throw error;
  }
}

/**
 * Entra por REST como la cuenta desechable (signInWithPassword). `capture` lo hace ANTES de abrir
 * el navegador: si la cuenta o la contrasena del estado no valen, falla aqui con un mensaje claro
 * y no tras un minuto de espera a un selector que nunca aparece.
 */
async function signIn(email, password) {
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

// ---------------------------------------------------------------------------------------------
// setup — una tienda, una cuenta y dos pedidos. Idempotente: repite el paso y reusa los ids.
// ---------------------------------------------------------------------------------------------

/**
 * La cuenta Auth desechable. Lo decidido se guarda ANTES de crear: si el proceso muere justo
 * despues del alta, la reanudacion reusa el mismo uid y la misma contrasena.
 */
async function ensureAuthAccount(input) {
  const { known, defaultUid, sellerId } = input;
  const uid = known.uid || defaultUid;
  if (!uid.startsWith(SMOKE_PREFIX)) fail(`Me niego a tocar la cuenta ${uid}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const sameAccount = known.uid === uid;
  const email = sameAccount && known.email ? known.email : `${uid}@example.com`;
  const knownPassword = sameAccount ? known.password : undefined;
  const password = knownPassword || crypto.randomBytes(24).toString("base64url");

  saveState({ uid, email, password });

  const existing = await findAuthUser(uid);
  if (!existing) {
    await auth.createUser({ uid, email, password, displayName: "Verify 013 tienda (desechable)" });
    console.log(`Usuario Auth creado: ${uid} <${email}>`);
  } else if (!knownPassword) {
    await auth.updateUser(uid, { password });
    console.log(`Usuario Auth ${uid} adoptado con contrasena nueva.`);
  } else {
    console.log(`Usuario Auth ${uid} ya existia; se reusa.`);
  }

  const claims = { role: "seller", sellerId };
  await auth.setCustomUserClaims(uid, claims);
  console.log(`Reclamos de ${uid}: ${JSON.stringify(claims)}`);
  return { uid, email, password, claims };
}

/** Tienda desechable, con ciudad para que la pantalla de la tienda sea la normal y no la de perfil pendiente. */
async function ensureSeller(input) {
  const { sellerId, now } = input;
  if (!sellerId.startsWith(SMOKE_PREFIX)) fail(`Me niego a tocar la tienda ${sellerId}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const ref = db.collection("sellers").doc(sellerId);
  const snapshot = await ref.get();
  if (snapshot.exists) {
    console.log(`sellers/${sellerId} ya existia; se reusa.`);
    return sellerId;
  }
  await ref.create({
    id: sellerId,
    name: "Verify 013 - tienda desechable",
    shopDomain: "",
    cityId: "city-cali",
    bankAccount: "",
    onboardingComplete: true,
    createdAt: now,
    updatedAt: now
  });
  console.log(`sellers/${sellerId} creada.`);
  return sellerId;
}

/** Un pedido desechable en `ready_to_assign`. `extra` trae las lineas de direccion propias de cada caso. */
async function ensureOrder(input) {
  const { orderId, sellerId, index, now, extra } = input;
  if (!orderId.startsWith(SMOKE_PREFIX)) fail(`Me niego a tocar el pedido ${orderId}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const ref = db.collection("orders").doc(orderId);
  const snapshot = await ref.get();
  if (snapshot.exists) {
    console.log(`orders/${orderId} ya existia; se reusa.`);
    return orderId;
  }
  await ref.create({
    id: orderId,
    shopifyOrderId: `MAN-SMOKE013-${index}`,
    trackingCode: `SMK013-${index}`,
    sellerId,
    cityId: "city-cali",
    customerName: `Cliente de prueba ${index}`,
    customerPhone: "3000000000",
    addressRisk: "accepted",
    status: "ready_to_assign",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    totalCop: 50000,
    productName: "Producto de prueba",
    quantity: 1,
    evidence: [],
    createdAt: now,
    updatedAt: now,
    ...extra
  });
  console.log(`orders/${orderId} creado (${extra.deliveryNotes ? "con deliveryNotes" : "observacion en normalizedAddress"}).`);
  return orderId;
}

async function stepSetup() {
  const state = loadState();
  const runId = state.runId || String(Date.now());
  const now = new Date().toISOString();

  const sellerId = await ensureSeller({ sellerId: state.sellerId || `${SMOKE_PREFIX}tienda-${runId}`, now });
  const account = await ensureAuthAccount({
    known: { uid: state.uid, email: state.email, password: state.password },
    defaultUid: `${SMOKE_PREFIX}user-${runId}`,
    sellerId
  });

  // El pedido "viejo": la observacion de la tienda esta en `normalizedAddress` y no hay indicaciones.
  const oldOrderId = await ensureOrder({
    orderId: state.oldOrderId || `${SMOKE_PREFIX}pedido-viejo-${runId}`,
    sellerId,
    index: 1,
    now,
    extra: {
      addressRaw: "Calle 5 # 38-25 apto 301",
      normalizedAddress: "timbre azul, preguntar por Marta"
    }
  });
  // El pedido "nuevo": direccion, corregida distinta e indicaciones en su campo.
  const newOrderId = await ensureOrder({
    orderId: state.newOrderId || `${SMOKE_PREFIX}pedido-nuevo-${runId}`,
    sellerId,
    index: 2,
    now,
    extra: {
      addressRaw: "Carrera 66 # 9-32",
      normalizedAddress: "Carrera 66 # 9-32, Cali, Colombia",
      deliveryNotes: "Local al fondo, preguntar por Marta"
    }
  });

  saveState({
    runId,
    sellerId,
    uid: account.uid,
    email: account.email,
    password: account.password,
    claims: account.claims,
    oldOrderId,
    newOrderId,
    oldTrackingCode: "SMK013-1",
    newTrackingCode: "SMK013-2",
    setupAt: state.setupAt || now
  });
  console.log(`Estado guardado en ${statePath()}. Sigue con: node scripts/verify-013.js capture --base-url ${DEFAULT_BASE_URL}`);
  console.log("Recuerda: ese archivo lleva la contrasena de la cuenta desechable hasta el cleanup.");
}

// ---------------------------------------------------------------------------------------------
// capture — SOLO LECTURA. Entra como la tienda, mide el formulario a dos anchos y captura las
// guias impresas. Playwright es el GLOBAL de la maquina: no esta en package.json.
// ---------------------------------------------------------------------------------------------

function loadPlaywright() {
  const playwrightPath = require.resolve("playwright", { paths: [process.cwd(), "/usr/lib/node_modules"] });
  return require(playwrightPath);
}

function baseUrl() {
  return argValue("--base-url") || process.env.VERIFY_BASE_URL || DEFAULT_BASE_URL;
}

/** Despliega un panel por el texto de su boton; si ya esta abierto no lo toca. Devuelve si existe. */
async function openPanel(page, title) {
  const toggle = page.getByRole("button", { name: title }).first();
  if ((await toggle.count()) === 0) {
    console.log(`  panel "${title}": no existe en esta pantalla; se anota y se sigue.`);
    return false;
  }
  await toggle.scrollIntoViewIfNeeded();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return true;
}

/**
 * La medida de un ancho: RF_01 (sin desplazamiento horizontal) y RF_04 (cada control del
 * formulario mide 44 px de alto y cabe en la ventana). Corre INLINE dentro del navegador: las
 * guardas de la suite no siguen funciones pasadas por referencia.
 */
async function captureAtWidth(page, width, label) {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.waitForTimeout(500);
  const hasManualPanel = await openPanel(page, "Crear pedido manual");
  const hasPayoutPanel = await openPanel(page, "Solicitudes de liquidacion");
  await page.waitForTimeout(500);

  const medidas = await page.evaluate((minHeight) => {
    const botones = Array.from(document.querySelectorAll("button"));
    const boton = botones.find((item) => (item.textContent || "").includes("Crear pedido manual"));
    const seccion = boton ? boton.closest("section") : null;
    const form = seccion ? seccion.querySelector("form") : null;
    const controles = form
      ? Array.from(form.querySelectorAll("input,select,textarea,button")).map((el) => {
          const r = el.getBoundingClientRect();
          const rotulo =
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("name") ||
            (el.textContent || "").trim().slice(0, 40) ||
            el.tagName.toLowerCase();
          return {
            rotulo,
            tag: el.tagName.toLowerCase(),
            height: r.height,
            right: r.right,
            alto44: r.height >= minHeight,
            dentro: r.right <= window.innerWidth
          };
        })
      : [];
    return {
      formularioEncontrado: Boolean(form),
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      sinDesbordamiento: document.documentElement.scrollWidth === document.documentElement.clientWidth,
      controles
    };
  }, MIN_CONTROL_HEIGHT);

  const controlesMal = medidas.controles.filter((control) => !(control.alto44 && control.dentro));
  const ok = medidas.formularioEncontrado && medidas.sinDesbordamiento && controlesMal.length === 0;
  const resultado = {
    medidoEn: new Date().toISOString(),
    ancho: width,
    umbralAltoPx: MIN_CONTROL_HEIGHT,
    panelesDesplegados: { manual: hasManualPanel, liquidacion: hasPayoutPanel },
    ok,
    controlesMal,
    ...medidas
  };
  writeEvidence(width === MOBILE_WIDTH ? "medidas-movil.json" : "medidas-escritorio.json", resultado);
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${label}-formulario.png`), fullPage: true });

  console.log(`  ${label} (${width}px): ${ok ? "OK" : "FALLA"} — scrollWidth ${medidas.scrollWidth} / clientWidth ${medidas.clientWidth}, controles ${medidas.controles.length}, fuera de norma ${controlesMal.length}`);
  for (const control of controlesMal) {
    console.log(`    <${control.tag}> "${control.rotulo}": alto ${control.height.toFixed(1)}px, borde derecho ${control.right.toFixed(1)}px`);
  }
  return ok;
}

/** Minusculas y espacios colapsados: la unica igualdad que se usa para buscar en la guia. */
function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Busca un fragmento en el texto de la guia sin distinguir mayusculas ni saltos de linea. Los
 * rotulos (`.key`) se pintan con `text-transform: uppercase`, asi que `innerText` devuelve
 * "DIRECCION" aunque el HTML diga "Direccion": comparar en sensible a mayusculas daba un falso
 * negativo con la guia correcta (medido en la primera corrida real del 2026-09-15).
 */
function contieneFragmento(texto, fragmento) {
  return normalizeText(texto).includes(normalizeText(fragmento));
}

/**
 * La guia impresa de un pedido: abre su fila por el codigo de guia, pulsa "Imprimir rotulo",
 * captura la ventana emergente y comprueba los rotulos de direccion en su texto.
 */
async function captureLabel(page, context, input) {
  const { trackingCode, label, expected } = input;
  const row = page.getByRole("button", { name: trackingCode }).first();
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.scrollIntoViewIfNeeded();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();

  const card = row.locator("xpath=..");
  const printButton = card.getByRole("button", { name: /Imprimir rotulo|Reimprimir rotulo/ }).first();
  await printButton.waitFor({ state: "visible", timeout: 15000 });

  const [popup] = await Promise.all([context.waitForEvent("page", { timeout: 30000 }), printButton.click()]);
  await popup.waitForLoadState();
  // El contenido llega por document.write DESPUES de generar el QR: se espera a la etiqueta.
  await popup.locator("article.label").first().waitFor({ state: "attached", timeout: 30000 });
  const text = await popup.innerText("body");

  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await popup.screenshot({ path: path.join(CAPTURE_DIR, `guia-${label}.png`), fullPage: true });
  writeEvidence(`guia-${label}.txt`, text);
  await popup.close();

  const checks = expected.map((rule) => {
    const present = rule.fragments.every((fragment) => contieneFragmento(text, fragment));
    return { rotulo: rule.label, fragmentos: rule.fragments, debeEstar: rule.present, esta: present, ok: present === rule.present };
  });
  const ok = checks.every((check) => check.ok);
  console.log(`  guia ${label} (${trackingCode}): ${ok ? "OK" : "FALLA"}`);
  for (const check of checks) {
    const fragmentos = check.fragmentos.map((fragment) => JSON.stringify(fragment)).join(" + ");
    console.log(`    ${check.ok ? "ok " : "MAL"} ${check.debeEstar ? "contiene" : "no contiene"} ${fragmentos}`);
  }
  return { ok, checks };
}

async function stepCapture() {
  const state = loadState();
  if (!state.email || !state.password || !state.oldOrderId || !state.newOrderId) {
    fail(`Falta el estado de setup en ${statePath()}. Ejecuta primero: node scripts/verify-013.js setup`);
  }
  const url = baseUrl();
  await signIn(state.email, state.password);
  console.log(`Cuenta ${state.email}: entra por REST. Abriendo ${url}...`);

  const { chromium } = loadPlaywright();
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: DESKTOP_WIDTH, height: VIEWPORT_HEIGHT } });
  // La guia llama a window.print() al cargar; sin dialogo que abrir, la emergente no se bloquea.
  await context.addInitScript(() => {
    window.print = () => {};
  });
  const page = await context.newPage();

  const resultado = { movil: false, escritorio: false, guiaViejo: false, guiaNuevo: false };
  try {
    // `networkidle` y una pausa, no `domcontentloaded`: con el DOM listo pero React sin hidratar,
    // el `fill` no llega al estado del componente y el clic envia el formulario de forma nativa
    // (leccion de la 005, medida el 2026-09-15).
    await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.getByLabel("Email").fill(state.email);
    await page.getByLabel("Contrasena").fill(state.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.getByRole("button", { name: "Crear pedido manual" }).first().waitFor({ state: "visible", timeout: 60000 });
    await page.waitForTimeout(1500);

    console.log("Medida del formulario (RF_01, RF_04) con los dos paneles desplegados (RF_02):");
    resultado.escritorio = await captureAtWidth(page, DESKTOP_WIDTH, "escritorio");
    resultado.movil = await captureAtWidth(page, MOBILE_WIDTH, "movil");

    await page.setViewportSize({ width: DESKTOP_WIDTH, height: VIEWPORT_HEIGHT });
    await page.waitForTimeout(500);
    console.log("Guias impresas (DoD 3):");
    const viejo = await captureLabel(page, context, {
      trackingCode: state.oldTrackingCode || "SMK013-1",
      label: "viejo",
      expected: [
        { label: "Direccion", fragments: ["Direccion", "Calle 5 # 38-25 apto 301"], present: true },
        { label: "Correccion o nota", fragments: ["Correccion o nota", "timbre azul"], present: true },
        { label: "Indicaciones", fragments: ["Indicaciones"], present: false }
      ]
    });
    const nuevo = await captureLabel(page, context, {
      trackingCode: state.newTrackingCode || "SMK013-2",
      label: "nuevo",
      expected: [
        { label: "Direccion", fragments: ["Direccion", "Carrera 66 # 9-32"], present: true },
        { label: "Correccion o nota", fragments: ["Correccion o nota", "Carrera 66 # 9-32, Cali, Colombia"], present: true },
        { label: "Indicaciones", fragments: ["Indicaciones", "Local al fondo"], present: true }
      ]
    });
    resultado.guiaViejo = viejo.ok;
    resultado.guiaNuevo = nuevo.ok;
    writeEvidence("resultado-capture.json", { capturadoEn: new Date().toISOString(), baseUrl: url, ...resultado, guias: { viejo: viejo.checks, nuevo: nuevo.checks } });
  } catch (error) {
    // La evidencia parcial se queda escrita; el resumen dice hasta donde llego.
    writeEvidence("resultado-capture.json", { capturadoEn: new Date().toISOString(), baseUrl: url, ...resultado, error: String(error && error.stack ? error.stack : error) });
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }

  saveState({ capturedAt: new Date().toISOString(), captureBaseUrl: url, captureResult: resultado });
  const allOk = Object.values(resultado).every(Boolean);
  console.log(`RESULTADO: ${allOk ? "PASA" : "FALLA"} ${JSON.stringify(resultado)}`);
  console.log(`Evidencia en ${path.relative(REPO_ROOT, EVIDENCE_DIR)}/ y capturas en ${path.relative(REPO_ROOT, CAPTURE_DIR)}/.`);
  if (!allOk) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------
// cleanup — borra SOLO lo del prefijo, por id guardado. Idempotente.
// ---------------------------------------------------------------------------------------------

async function deleteIfSmoke(collectionName, id) {
  if (!id) return 0;
  if (!id.startsWith(SMOKE_PREFIX)) fail(`Me niego a borrar ${collectionName}/${id}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const ref = db.collection(collectionName).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return 0;
  await ref.delete();
  console.log(`Borrado ${collectionName}/${id}.`);
  return 1;
}

async function deleteAuthIfSmoke(uid) {
  if (!uid) return 0;
  if (!uid.startsWith(SMOKE_PREFIX)) fail(`Me niego a borrar la cuenta ${uid}: no lleva el prefijo ${SMOKE_PREFIX}.`);
  const existing = await findAuthUser(uid);
  if (!existing) return 0;
  await auth.deleteUser(uid);
  console.log(`Borrado el usuario Auth ${uid}.`);
  return 1;
}

async function stepCleanup() {
  const state = loadState();
  const { uid, sellerId, oldOrderId, newOrderId } = state;
  if (![uid, sellerId, oldOrderId, newOrderId].some(Boolean)) {
    fail(`No hay ids de lo desechable en ${statePath()}. ${USAGE}`);
  }
  for (const id of [uid, sellerId, oldOrderId, newOrderId]) {
    if (id && !id.startsWith(SMOKE_PREFIX)) fail(`El estado trae el id ${id} sin el prefijo ${SMOKE_PREFIX}: no se borra nada.`);
  }

  const orders = (await deleteIfSmoke("orders", oldOrderId)) + (await deleteIfSmoke("orders", newOrderId));
  const sellers = await deleteIfSmoke("sellers", sellerId);
  const accounts = await deleteAuthIfSmoke(uid);

  // La contrasena sale del archivo en cuanto la cuenta deja de existir: `.sdd/evidence/` se versiona.
  saveState({ cleanedAt: new Date().toISOString(), password: undefined });
  console.log(`Borrado: pedidos ${orders}, tiendas ${sellers}, cuentas Auth ${accounts}. Repetir este paso no falla: lo ya borrado cuenta cero.`);
}

const STEPS = {
  setup: stepSetup,
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
