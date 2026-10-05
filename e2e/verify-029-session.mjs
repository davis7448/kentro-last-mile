/**
 * Spec 029 — fase verify: recorridos E2E contra la app DESPLEGADA (https://kentro-last-mile.web.app).
 *
 * Todo existe en produccion: no se levanta next dev ni se interceptan callables, salvo los estados de
 * error/vacio que se fuerzan con `page.route` (y quedan marcados como FORZADA en la evidencia).
 *
 * Datos: SOLO la tienda de pruebas `seller-test-029` (constantes de scripts/verify-029.js). Lo creado se anota
 * con `recordCreated` en un registro PROPIO (EV/verify-registro.json) antes de crearlo. La limpieza reutiliza el
 * `cleanup --from-registro` de verify-029.js; como ese modo lee t27-registro.json, se aparta el registro de T27,
 * se pone el de esta sesion, se limpia y se RESTAURA el de T27 en un finally (tambien ante SIGINT).
 *
 * Secretos (contrasenas, tokens, keys) solo en memoria. Las capturas tapan el campo de la clave con `mask`, y
 * cada trace.zip se reescribe sustituyendo los secretos conocidos y todo lo que tenga forma de key o de JWT;
 * al final se comprueba que ningun archivo de evidencia contiene un secreto.
 *
 * Uso: node e2e/verify-029-session.mjs [solo=RF_26,RF_27]
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const BASE_URL = process.env.VERIFY_BASE_URL || "https://kentro-last-mile.web.app";
const EVIDENCE = path.join(ROOT, ".sdd/evidence/029_store_api_confirma_y_corrige_pedidos");
const REGISTRO = path.join(EVIDENCE, "verify-registro.json");
const T27_REGISTRO = path.join(EVIDENCE, "t27-registro.json");
const MOBILE = { name: "movil-375", viewport: { width: 375, height: 812 } };
const DESKTOP = { name: "escritorio-1280", viewport: { width: 1280, height: 800 } };
const ONLY = (process.argv.find((arg) => arg.startsWith("solo=")) || "").slice(5).split(",").filter(Boolean);
const FUNCTIONS = "https://us-central1-kentro-last-mile.cloudfunctions.net";
const SELLER_NAME = "Tienda de pruebas test-029";

const v029 = require(path.join(ROOT, "scripts/verify-029.js"));
const { TEST_SELLER_ID, TEST_ORDER_NUMBER_PREFIX, TEST_EXTERNAL_ID_PREFIX, recordCreated, rememberSecret } = v029;
const admin = require(path.join(ROOT, "functions/node_modules/firebase-admin"));
const db = admin.firestore();
const { chromium } = require(require.resolve("playwright", { paths: [ROOT, "/usr/lib/node_modules"] }));

const SECRETS = [];
const secret = (value) => {
  if (typeof value === "string" && value.length >= 6 && !SECRETS.includes(value)) {
    SECRETS.push(value);
    rememberSecret(value);
  }
  return value;
};
const squash = (text) => String(text || "").replace(/\s/g, "");
const record = (kind, id) => recordCreated(kind, id, { file: REGISTRO });

// ---------------------------------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------------------------------

function webApiKey() {
  const match = fs.readFileSync(path.join(ROOT, "src/lib/firebase/client.ts"), "utf8").match(/AIza[0-9A-Za-z_-]{35}/);
  if (!match) throw new Error("no se encontro la web API key");
  return match[0];
}

async function signIn(account) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`signIn ${response.status}`);
  secret(body.refreshToken);
  return secret(body.idToken);
}

async function callable(name, account, data) {
  const token = await signIn(account);
  const response = await fetch(`${FUNCTIONS}/${name}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || !body || !("result" in body)) throw new Error(`${name} respondio ${response.status} (${body?.error?.status || "?"})`);
  return body.result;
}

const ACCOUNTS = {};

async function createAccount(kind) {
  const uid = `t029v${kind.replace(/_/g, "")}${crypto.randomBytes(5).toString("hex")}`;
  const account = { uid, kind, email: `${uid}@verify-029.example.com`, password: secret(crypto.randomBytes(24).toString("base64url")) };
  record("authUsers", uid);
  await admin.auth().createUser({ uid, email: account.email, password: account.password, displayName: `Prueba 029 ${kind}` });
  const claims = kind === "admin" ? { role: "admin" } : { role: kind, sellerId: TEST_SELLER_ID };
  await admin.auth().setCustomUserClaims(uid, claims);
  ACCOUNTS[kind] = account;
}

async function preflight() {
  for (const [collection, id] of [["sellers", TEST_SELLER_ID], ["storeApiConfigs", TEST_SELLER_ID]]) {
    if ((await db.collection(collection).doc(id).get()).exists) throw new Error(`${collection}/${id} ya existe; no se crea nada`);
  }
  if (!(await db.collection("orders").where("sellerId", "==", TEST_SELLER_ID).limit(1).get()).empty) throw new Error("ya hay pedidos de la tienda de pruebas");
  if (fs.existsSync(REGISTRO) && JSON.parse(fs.readFileSync(REGISTRO, "utf8")).entries?.length) {
    // Registro de una corrida anterior: comprobar que sus usuarios ya no existen y apartarlo (no se borra).
    const previous = JSON.parse(fs.readFileSync(REGISTRO, "utf8")).entries.filter((e) => e.kind === "authUsers");
    for (const entry of previous) {
      const alive = await admin.auth().getUser(entry.id).then(() => true, () => false);
      if (alive) throw new Error("verify-registro.json tiene usuarios sin limpiar: corre la limpieza antes de repetir");
    }
    fs.renameSync(REGISTRO, REGISTRO.replace(/\.json$/, `-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  }
}

async function setupStore() {
  const now = new Date().toISOString();
  record("sellers", TEST_SELLER_ID);
  await db.collection("sellers").doc(TEST_SELLER_ID).create({
    id: TEST_SELLER_ID,
    name: SELLER_NAME,
    cityId: "city-cali",
    bankAccount: "Cuenta sintetica 029",
    pickupPointName: "Punto sintetico 029",
    pickupAddress: "Calle 1 # 1-01, Cali",
    createdAt: now,
    updatedAt: now
  });
  await createAccount("seller");
  await createAccount("seller_logistics");
  await createAccount("admin");
  // "Sin clave" del diseno = hay lectura, no hay escritura: se crea la de lectura (no se muestra nunca).
  record("storeApiConfigs", TEST_SELLER_ID);
  const created = await callable("createStoreApiKey", ACCOUNTS.seller, { sellerId: TEST_SELLER_ID });
  secret(created?.config?.apiKey);
}

/** Devuelve la tienda de pruebas a "sin clave de escritura" (solo su documento de storeApiConfigs). */
async function resetWriteKey() {
  const ref = db.collection("storeApiConfigs").doc(TEST_SELLER_ID);
  const snap = await ref.get();
  if (!snap.exists || (snap.get("sellerId") ?? snap.id) !== TEST_SELLER_ID) throw new Error("resetWriteKey: no es la config de la tienda de pruebas");
  const fields = Object.keys(snap.data()).filter((key) => key.startsWith("writeKey"));
  if (fields.length === 0) return;
  await ref.update(Object.fromEntries(fields.map((key) => [key, admin.firestore.FieldValue.delete()])));
}

async function setupHistoryOrder() {
  const result = await callable("createManualOrder", ACCOUNTS.seller, {
    sellerId: TEST_SELLER_ID,
    customerName: "Cliente Sintetico 029",
    customerPhone: "300 029 0022",
    addressRaw: "Carrera 10 # 20-30, Barrio Sintetico, Cali",
    paymentMethod: "cod",
    fulfillmentMode: "seller_pickup",
    totalCop: 75000,
    lineItems: [{ productName: "Producto sintetico 029", sku: `${TEST_ORDER_NUMBER_PREFIX}SKU-SIN-FICHA`, quantity: 1 }],
    addressRisk: "accepted"
  });
  const order = result.order;
  if (!order?.id) throw new Error("createManualOrder no devolvio el pedido");
  record("orders", order.id);
  const rotated = await callable("rotateStoreWriteKey", ACCOUNTS.seller, { sellerId: TEST_SELLER_ID, rotate: true });
  const writeKey = secret(rotated.writeKey);
  const patch = await fetch(`${FUNCTIONS}/storeApi/orders/${encodeURIComponent(order.id)}?sellerId=${TEST_SELLER_ID}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + writeKey, "Content-Type": "application/json", "Idempotency-Key": `${TEST_EXTERNAL_ID_PREFIX}verify-${Date.now()}` },
    body: JSON.stringify({ customerName: "Cliente Sintetico Corregido", addressRaw: "Calle 7 # 30-15, Barrio Sintetico, Cali" })
  });
  const body = await patch.json().catch(() => null);
  if (patch.status !== 200) throw new Error(`PATCH respondio ${patch.status} (${body?.code || "?"})`);
  const historySince = (await db.collection("settings").doc("storeApi").get()).get("historySince");
  return { orderId: order.id, trackingCode: order.trackingCode, last4: rotated.status?.write?.last4, historySince, patchChanged: body?.changed };
}

// ---------------------------------------------------------------------------------------------------
// Limpieza con el registro propio (swap controlado del registro de T27)
// ---------------------------------------------------------------------------------------------------

let t27Original = null;
function restoreT27() {
  if (t27Original !== null) {
    fs.writeFileSync(T27_REGISTRO, t27Original);
    t27Original = null;
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreT27();
    process.exit(130);
  });
}

function cleanupSession() {
  if (!fs.existsSync(REGISTRO)) return { ok: true, lines: ["cleanup: sin registro, nada creado"] };
  t27Original = fs.readFileSync(T27_REGISTRO, "utf8");
  let output = "";
  let ok = true;
  try {
    fs.writeFileSync(T27_REGISTRO, fs.readFileSync(REGISTRO, "utf8"));
    output = execFileSync("node", [path.join(ROOT, "scripts/verify-029.js"), "cleanup", "--from-registro"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    ok = false;
    output = `${error.stdout || ""}\n${error.stderr || ""}`;
  } finally {
    restoreT27();
  }
  // verify-029 `cleanup` lanza (exit 1) si queda algo; sin error = cero en todas las colecciones.
  const lines = output.split("\n").filter((line) => /cleanup/.test(line));
  if (ok) lines.push("cleanup: sin error del modo cleanup -> cero en todas las colecciones");
  return { ok, lines };
}

// ---------------------------------------------------------------------------------------------------
// Navegador
// ---------------------------------------------------------------------------------------------------

async function login(page, account) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("button", { name: "Entrar" }).waitFor({ state: "visible", timeout: 120000 });
  await page.waitForTimeout(1500);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Contrasena").fill(account.password);
    if (await page.getByLabel("Email").inputValue()) break;
    await page.waitForTimeout(1500);
  }
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Entrar"]'), null, { timeout: 120000 });
  await page.waitForTimeout(2000);
}

async function clickByText(page, texts) {
  await page.waitForFunction((labels) => [...document.querySelectorAll("button, a")].some((n) => labels.includes((n.textContent || "").trim()) && n.getClientRects().length > 0), texts, { timeout: 120000 });
  await page.evaluate((labels) => {
    const nodes = [...document.querySelectorAll("button, a")].filter((n) => labels.includes((n.textContent || "").trim()));
    (nodes.find((n) => n.getClientRects().length > 0) || nodes[0]).click();
  }, texts);
}

async function openIntegrations(page) {
  await clickByText(page, ["Integraciones", "Tiendas"]);
  await page.waitForTimeout(800);
}

async function expandPanel(page, titleRegex) {
  const toggle = page.locator("button[aria-expanded]").filter({ hasText: titleRegex }).first();
  await toggle.waitFor({ timeout: 60000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return toggle;
}

/** T23: todos los "?" de ayuda visibles en Integraciones miden al menos 44x44. */
async function measureHelp(page, check, allowNone = false) {
  const boxes = [];
  for (const button of await page.locator('button[aria-label^="Que es"]').all()) {
    if (!(await button.isVisible())) continue;
    const box = await button.boundingBox();
    boxes.push({ name: await button.getAttribute("aria-label"), w: Math.round(box.width), h: Math.round(box.height) });
  }
  const small = boxes.filter((b) => b.w < 44 || b.h < 44);
  // Los paneles de Integraciones del admin no llevan ayuda "?": ahi solo se deja constancia de que no hay.
  if (allowNone && boxes.length === 0) {
    check('T23: Integraciones del admin no tiene botones "?" (sus paneles no llevan ayuda)', true);
    return boxes;
  }
  check(`T23: ${boxes.length} botones "?" en Integraciones, todos >= 44x44 (${boxes.map((b) => `${b.name.replace("Que es ", "")} ${b.w}x${b.h}`).join("; ")})`, boxes.length > 0 && small.length === 0);
  return boxes;
}

function writeSection(page) {
  return page.locator("section", { has: page.getByRole("heading", { name: "Clave de escritura", level: 3, exact: true }) }).last();
}

async function waitWriteState(scope, texts) {
  await scope.getByRole("status").filter({ hasText: new RegExp(`^(${texts.join("|")})$`) }).first().waitFor({ timeout: 60000 });
}

/** Lee la clave recien generada del campo, la guarda como secreto y comprueba la forma. */
async function readFreshKey(scope, check) {
  const field = scope.getByLabel("Clave de escritura", { exact: true });
  await field.waitFor({ timeout: 60000 });
  const value = await field.inputValue();
  const lines = value.split("\n");
  const key = secret(lines.join(""));
  // generateWriteKey: "kw_" + 45 caracteres base64url (functions/src/store-api-auth.ts).
  check("la clave sale completa en dos lineas de 24 caracteres (kw_ + 45 base64url)", lines.length === 2 && lines.every((l) => l.length === 24) && /^kw_[A-Za-z0-9_-]{45}$/.test(key));
  return { key, field };
}

const maskKey = (page) => [page.getByLabel("Clave de escritura", { exact: true })];

// ---------------------------------------------------------------------------------------------------
// Recorridos
// ---------------------------------------------------------------------------------------------------

const KEY_FLOWS = [
  {
    rf: "RF_26",
    variant: "tienda",
    titulo: "HU_04 tienda: sin clave -> Generar -> recien generada -> Ya la guarde -> activa -> Rotar (dialogo) -> error forzado -> Reintentar",
    role: "seller",
    before: resetWriteKey,
    async run({ page, check, shot, force, unforce }) {
      await openIntegrations(page);
      await measureHelp(page, check);
      await expandPanel(page, /^Clave de API/);
      const section = writeSection(page);
      await waitWriteState(section, ["Sin clave de escritura"]);
      check('sin clave: pildora "Sin clave de escritura" y boton "Generar clave de escritura"', await section.getByRole("button", { name: "Generar clave de escritura" }).isVisible());
      check("sin clave: texto de la decision 3", squash(await section.textContent()).includes(squash("Confirma, corrige y cancela pedidos que aun no tienen lider.")));
      await section.scrollIntoViewIfNeeded();
      await shot("sin-clave");

      await section.getByRole("button", { name: "Generar clave de escritura" }).click();
      await section.getByRole("alert").filter({ hasText: "Copiala ahora" }).waitFor({ timeout: 60000 });
      const first = await readFreshKey(section, check);
      check('aviso "Solo se muestra completa esta vez" y "Si sales sin copiarla..."', squash(await section.textContent()).includes(squash("Solo se muestra completa esta vez")) && squash(await section.textContent()).includes(squash("Si sales sin copiarla, tendras que generar otra.")));
      check('el foco queda en "Copiar clave de escritura"', (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Copiar clave de escritura");
      await section.getByRole("button", { name: "Copiar clave de escritura" }).click();
      await page.waitForTimeout(400);
      check('"Copiar" anuncia "Copiada"', (await section.getByRole("status").filter({ hasText: /^Copiada$/ }).count()) === 1);
      await shot("recien-generada", maskKey(page));

      await section.getByRole("button", { name: "Ya la guarde" }).click();
      await waitWriteState(section, ["Activa"]);
      const last4 = first.key.slice(-4);
      const activeText = squash(await section.textContent());
      check(`activa: "Termina en ${last4}" y "Generada por Tu tienda"`, activeText.includes(squash(`Termina en${last4}`)) && activeText.includes("GeneradaporTutienda"));
      const leaked = await page.evaluate((k) => document.documentElement.outerHTML.includes(k) || JSON.stringify({ ...localStorage }).includes(k) || JSON.stringify({ ...sessionStorage }).includes(k), first.key);
      check("tras 'Ya la guarde' la clave no esta en el DOM ni en localStorage/sessionStorage", !leaked);
      await shot("activa");

      const rotate = section.getByRole("button", { name: "Rotar clave de escritura" });
      await rotate.click();
      const dialog = page.getByRole("dialog", { name: "Rotar la clave de escritura" });
      await dialog.waitFor({ timeout: 15000 });
      check('dialogo "Rotar la clave de escritura": el foco entra en "Cancelar"', (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Cancelar");
      check(`el dialogo nombra la clave que termina en ${last4}`, squash(await dialog.textContent()).includes(squash(`La clave que termina en ${last4} deja de funcionar`)));
      await shot("rotar");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check("Escape cierra el dialogo y el foco vuelve a Rotar", (await page.getByRole("dialog").count()) === 0 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Rotar clave de escritura");

      await force("rotateStoreWriteKey");
      await rotate.click();
      await dialog.getByRole("button", { name: "Rotar ahora" }).click();
      const alert = section.getByRole("alert").filter({ hasText: "No se pudo rotar la clave" });
      await alert.waitFor({ timeout: 30000 });
      check(`error: "La que termina en ${last4} sigue activa. No se genero ninguna clave nueva." y "Reintentar"`, squash(await alert.textContent()).includes(squash(`termina en ${last4} sigue activa`)) && squash(await alert.textContent()).includes(squash("No se genero ninguna clave nueva.")) && (await section.getByRole("button", { name: "Reintentar" }).isVisible()));
      const stored = (await db.collection("storeApiConfigs").doc(TEST_SELLER_ID).get()).get("writeKeyLast4");
      check(`con el fallo la clave guardada sigue siendo la misma (writeKeyLast4=${stored})`, stored === last4);
      await shot("error");
      await unforce("rotateStoreWriteKey");

      await section.getByRole("button", { name: "Reintentar" }).click();
      await section.getByRole("alert").filter({ hasText: "Copiala ahora" }).waitFor({ timeout: 60000 });
      const second = await readFreshKey(section, check);
      check(`tras rotar: "La clave que terminaba en ${last4} ya no funciona."`, squash(await section.textContent()).includes(squash(`La clave que terminaba en ${last4} ya no funciona.`)));
      check("la clave rotada es distinta", second.key !== first.key);
      await shot("rotada-recien-generada", maskKey(page));
      await section.getByRole("button", { name: "Ya la guarde" }).click();
      await waitWriteState(section, ["Activa"]);
      await shot("final");
    }
  },
  {
    rf: "RF_26",
    variant: "logistico",
    titulo: "HU_04 seller_logistics: ve el estado de la clave de escritura sin botones",
    role: "seller_logistics",
    async run({ page, check, shot }) {
      await openIntegrations(page);
      await measureHelp(page, check);
      await expandPanel(page, /^Clave de API/);
      const section = writeSection(page);
      await waitWriteState(section, ["Activa", "Sin clave de escritura"]);
      const buttons = await section.getByRole("button").allTextContents();
      check(`la seccion de escritura no tiene botones (encontrados: ${buttons.join(", ") || "ninguno"})`, buttons.length === 0);
      check('dice "Solo la cuenta principal de la tienda o Kentro pueden generarla."', squash(await section.textContent()).includes(squash("Solo la cuenta principal de la tienda o Kentro pueden generarla.")));
      await section.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_25",
    variant: "admin",
    titulo: 'HU_04 admin: panel "Claves de API de tiendas", buscar, generar desde la fila -> recien generada',
    role: "admin",
    before: resetWriteKey,
    async run({ page, check, shot, vp }) {
      await openIntegrations(page);
      await measureHelp(page, check, true);
      await expandPanel(page, /^Claves de API de tiendas/);
      const search = page.getByLabel("Buscar tienda");
      await search.waitFor({ timeout: 90000 });
      const panel = page.locator("section", { has: search }).last();
      check("resumen \"N de M tiendas con clave de escritura\"", /\d+ de \d+ tiendas con clave de escritura/.test(await panel.textContent()));
      await search.fill("test-029");
      await page.waitForTimeout(300);
      const isDesktop = vp.viewport.width >= 640;
      const list = isDesktop ? panel.locator("table") : panel.locator('ul[aria-label="Claves de API por tienda"]');
      check(`${isDesktop ? "escritorio: tabla" : "movil: tarjetas"} "Claves de API por tienda"`, (await list.count()) === 1);
      const rowButton = page.getByRole("button", { name: `Generar clave de escritura de ${SELLER_NAME}` });
      check('buscar "test-029" deja la fila de la tienda de pruebas con "Generar"', (await rowButton.count()) === 1);
      await shot("lista");
      await rowButton.click();
      const dialog = page.getByRole("dialog", { name: `Clave de escritura de ${SELLER_NAME}` });
      await dialog.waitFor({ timeout: 15000 });
      await waitWriteState(dialog, ["Sin clave de escritura"]);
      await dialog.getByRole("button", { name: "Generar clave de escritura" }).click();
      await dialog.getByRole("alert").filter({ hasText: "Copiala ahora" }).waitFor({ timeout: 60000 });
      const fresh = await readFreshKey(dialog, check);
      const text = squash(await dialog.textContent());
      check('aviso de admin: "Entregala a la tienda por un canal seguro" y "Queda registrado que la generaste tu"', text.includes(squash("Entregala a la tienda por un canal seguro.")) && text.includes(squash("Queda registrado que la generaste tu")));
      check('aviso mudo "Si cierras sin copiarla, tendras que rotarla."', text.includes(squash("Si cierras sin copiarla, tendras que rotarla.")));
      await shot("recien-generada", maskKey(page));
      await dialog.getByRole("button", { name: "Ya la guarde" }).click();
      await waitWriteState(dialog, ["Activa"]);
      await dialog.getByRole("button", { name: "Cerrar" }).click();
      await page.waitForTimeout(400);
      const rowText = await list.textContent();
      check(`la fila pasa a "Activa · termina en ${fresh.key.slice(-4)}"`, squash(rowText).includes(squash(`termina en ${fresh.key.slice(-4)}`)));
      check('"Generada" no duplica la preposicion ("por por ...")', !/por por/.test(rowText));
      check(`la fila ofrece ahora "Rotar clave de escritura de ${SELLER_NAME}"`, (await page.getByRole("button", { name: `Rotar clave de escritura de ${SELLER_NAME}` }).count()) === 1);
      await shot("final");
    }
  }
];

async function openTrail(page, ctx) {
  const search = page.getByPlaceholder("Buscar por KNT, # Shopify, cliente, telefono, SKU");
  await search.first().waitFor({ timeout: 120000 });
  await search.first().fill(ctx.history.trackingCode);
  // La lista pinta el pedido como fila plegada: el historial vive en la tarjeta, que se abre con un clic.
  const row = page.getByRole("button").filter({ hasText: ctx.history.trackingCode }).first();
  await row.waitFor({ timeout: 120000 });
  await row.click();
  const trail = page.getByRole("button", { name: "Historial del pedido" }).first();
  await trail.waitFor({ timeout: 120000 });
  await trail.scrollIntoViewIfNeeded();
  await trail.click();
  return page.locator("div", { has: trail }).last();
}

const HISTORY_FLOWS = [
  {
    rf: "RF_27",
    variant: "tienda",
    titulo: "HU_05 tienda: pildoras Tu tienda/API, Antes/Ahora, nota de alcance, sin identidades",
    role: "seller",
    async run({ page, check, shot, ctx }) {
      const block = await openTrail(page, ctx);
      await block.getByRole("list", { name: "Cambios del pedido" }).waitFor({ timeout: 60000 });
      const text = await block.textContent();
      const note = block.getByRole("note", { name: "Que incluye el historial" });
      check('nota de alcance "Que incluye el historial" con "Campo por campo desde el ..."', (await note.count()) === 1 && /Campo por campo desde el/.test(await note.textContent()));
      check('evento "Datos de entrega corregidos" con pildora "API"', /Datos de entrega corregidos/.test(text) && /API/.test(text));
      check('evento "Creado a mano" con pildora "Tu tienda"', /Creado a mano/.test(text) && /Tu tienda/.test(text));
      check('"Antes" y "Ahora" escritos, con "Cliente" corregido', /Antes/.test(text) && /Ahora/.test(text) && /Cliente Sintetico Corregido/.test(text));
      const ids = Object.values(ACCOUNTS).flatMap((a) => [a.uid, a.email]);
      check("sin identidades: ni uid, ni correo, ni rol, ni nombre de usuario", !ids.some((id) => text.includes(id)) && !/· (seller|admin)|Prueba 029|Clave de escritura de/.test(text));
      await block.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_27",
    variant: "admin",
    titulo: "HU_05 admin: linea de quien, Panel/API, 'Clave de escritura de <tienda>'",
    role: "admin",
    async run({ page, check, shot, ctx, vp }) {
      const block = await openTrail(page, ctx);
      await block.getByRole("list", { name: "Cambios del pedido" }).waitFor({ timeout: 60000 });
      const text = await block.textContent();
      check('pildoras "API" y "Panel"', /API/.test(text) && /Panel/.test(text));
      check(`linea de quien de la API: "Clave de escritura de ${SELLER_NAME}"`, text.includes(`Clave de escritura de ${SELLER_NAME}`));
      check(`"termina en ${ctx.history.last4}" (que clave era)`, text.includes(`termina en ${ctx.history.last4}`));
      check("linea de quien del panel con correo y rol (seller)", text.includes(ACCOUNTS.seller.email) && /· seller/.test(text));
      if (vp.viewport.width >= 640) check("escritorio: mini tabla Campo/Antes/Ahora", (await block.locator("table").count()) > 0);
      await block.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_17",
    variant: "vacio",
    titulo: "HU_05 vacio (forzado con page.route): nota de alcance y 'Sin cambios registrados'",
    role: "seller",
    async run({ page, check, shot, ctx, force }) {
      await force("getOrderAuditTrail", { result: { events: [], historySince: ctx.history.historySince } });
      const block = await openTrail(page, ctx);
      await block.getByText("Sin cambios registrados").waitFor({ timeout: 60000 });
      check('vacio: nota "Que incluye el historial" y status "Sin cambios registrados ... desde el ..."', (await block.getByRole("note", { name: "Que incluye el historial" }).count()) === 1 && /no tiene cambios desde el/.test(await block.textContent()));
      await block.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_17",
    variant: "error",
    titulo: "HU_05 error (forzado con page.route): alerta y Reintentar, sin nota",
    role: "seller",
    async run({ page, check, shot, ctx, force, unforce }) {
      await force("getOrderAuditTrail");
      const block = await openTrail(page, ctx);
      const alert = block.getByRole("alert");
      await alert.waitFor({ timeout: 60000 });
      check('error: "No se pudo cargar el historial", "El pedido no ha cambiado por esto." y "Reintentar"', /No se pudo cargar el historial/.test(await alert.textContent()) && /El pedido no ha cambiado por esto/.test(await alert.textContent()));
      check("error: sin nota de alcance ni eventos", (await block.getByRole("note").count()) === 0 && (await block.getByRole("list", { name: "Cambios del pedido" }).count()) === 0);
      await block.scrollIntoViewIfNeeded();
      await shot("error");
      await unforce("getOrderAuditTrail");
      await alert.getByRole("button", { name: "Reintentar" }).click();
      await block.getByRole("list", { name: "Cambios del pedido" }).waitFor({ timeout: 60000 });
      check("Reintentar vuelve a pedir y pinta los eventos", true);
      await shot("final");
    }
  }
];

// ---------------------------------------------------------------------------------------------------
// axe
// ---------------------------------------------------------------------------------------------------

const AXE_SOURCE = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const IMPACTS = ["critical", "serious", "moderate", "minor"];

async function axeScan(page, label) {
  if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ path: AXE_SOURCE });
  const result = await page.evaluate(async () => {
    const scope = [];
    for (const h of document.querySelectorAll("h3")) if (h.textContent.trim() === "Clave de escritura" && h.closest("section")) scope.push(h.closest("section"));
    for (const d of document.querySelectorAll('[role="dialog"]')) scope.push(d);
    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").trim();
      if (/^Historial del pedido/.test(t) && b.parentElement) scope.push(b.parentElement);
      if (/^Claves de API de tiendas/.test(t) && b.closest("section")) scope.push(b.closest("section"));
    }
    for (const b of document.querySelectorAll('button[aria-label^="Que es"]')) scope.push(b);
    const run = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      resultTypes: ["violations"]
    });
    const resolve = (target) => {
      try {
        return document.querySelector(target[target.length - 1]);
      } catch {
        return null;
      }
    };
    return {
      containers029: scope.length,
      violations: run.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => {
          const el = resolve(n.target);
          return { target: n.target.join(" "), impact: n.impact, scope: el && scope.some((c) => c.contains(el)) ? "029" : "app", html: n.html.slice(0, 160) };
        })
      }))
    };
  });
  return { label, ...result };
}

function axeTally(scans) {
  const seen = new Map();
  for (const scan of scans) for (const v of scan.violations) for (const n of v.nodes) {
    const key = `${v.id}|${n.target}`;
    if (!seen.has(key)) seen.set(key, { rule: v.id, impact: n.impact || v.impact, scope: n.scope, target: n.target, help: v.help, states: [] });
    seen.get(key).states.push(scan.label);
  }
  const items = [...seen.values()];
  return { items, count: (scope, impact) => items.filter((i) => i.scope === scope && i.impact === impact).length };
}

function writeGlobalAxe(outcomes) {
  const all = outcomes.flatMap((o) => o.axeScans.map((s) => ({ ...s, label: `${o.folderRel}/${s.label}` })));
  const { items, count } = axeTally(all);
  const lines = [
    `# Spec 029 — accesibilidad con axe-core (${new Date().toISOString()}) contra ${BASE_URL}`,
    `  ${all.length} estados en ${outcomes.length} recorridos. Reglas wcag2a/aa, 21a/aa, 22aa y best-practice.`,
    '  "029" = nodo dentro de la seccion Clave de escritura, el panel Claves de API de tiendas, un dialogo, el',
    '  bloque Historial del pedido o un boton "?" de ayuda. Nodos unicos por regla + selector.',
    "",
    `    ${"".padEnd(10)}${IMPACTS.map((i) => i.padStart(10)).join("")}`,
    `    ${"029".padEnd(10)}${IMPACTS.map((i) => String(count("029", i)).padStart(10)).join("")}`,
    `    ${"resto app".padEnd(10)}${IMPACTS.map((i) => String(count("app", i)).padStart(10)).join("")}`,
    "",
    "## Por regla"
  ];
  const byRule = {};
  for (const item of items) {
    const key = `${item.scope} ${item.rule} [${item.impact}]`;
    byRule[key] = (byRule[key] || 0) + 1;
  }
  for (const [key, value] of Object.entries(byRule).sort()) lines.push(`  ${key}: ${value} nodos`);
  lines.push("", "## Detalle");
  for (const item of items.sort((a, b) => a.scope.localeCompare(b.scope) || IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact))) {
    lines.push(`  [${item.scope}] [${item.impact}] ${item.rule} — ${item.target} — ${item.help} (${[...new Set(item.states)].slice(0, 3).join(", ")})`);
  }
  fs.writeFileSync(path.join(EVIDENCE, "a11y-axe.txt"), lines.join("\n"));
  return { byRule, count };
}

// ---------------------------------------------------------------------------------------------------
// Redaccion de secretos en la evidencia
// ---------------------------------------------------------------------------------------------------

const REDACT_PY = `
import sys, json, re, zipfile, os, shutil
secrets = [s.encode() for s in json.loads(sys.stdin.read())]
pats = [re.compile(rb'kw_[A-Za-z0-9_-]{45}'), re.compile(rb'(?<![0-9a-f])[0-9a-f]{48}(?![0-9a-f])'),
        re.compile(rb'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'),
        re.compile(rb'("refresh_?[Tt]oken"\\s*:\\s*")[^"]+')]
total = 0
for path in sys.argv[1:]:
    tmp = path + '.tmp'
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            for s in secrets:
                if s in data:
                    total += data.count(s); data = data.replace(s, b'[secreto]')
            for i, p in enumerate(pats):
                data, n = p.subn((lambda m: m.group(1) + b'[secreto]') if i == 3 else b'[secreto]', data)
                total += n
            zout.writestr(info, data)
    shutil.move(tmp, path)
print(total)
`;

function redactZip(zipPath) {
  return Number(execFileSync("python3", ["-c", REDACT_PY, zipPath], { input: JSON.stringify(SECRETS), encoding: "utf8" }).trim());
}

function redactText(text) {
  let out = SECRETS.reduce((acc, s) => acc.split(s).join("[secreto]"), text);
  return out.replace(/kw_[A-Za-z0-9_-]{45}/g, "[secreto]").replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[secreto]");
}

/** Comprueba que ningun archivo de evidencia de esta sesion contiene un secreto conocido. */
function scanEvidence(folders) {
  const SCAN_PY = `
import sys, json, zipfile
secrets = [s.encode() for s in json.loads(sys.stdin.read())]
hits = []
for path in sys.argv[1:]:
    if path.endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                d = z.read(n)
                if any(s in d for s in secrets): hits.append(path + ':' + n)
    else:
        d = open(path, 'rb').read()
        if any(s in d for s in secrets): hits.append(path)
print(json.dumps(hits))
`;
  const files = folders.flatMap((f) => fs.readdirSync(f).filter((n) => !n.endsWith(".png")).map((n) => path.join(f, n)));
  files.push(path.join(EVIDENCE, "a11y-axe.txt"), path.join(EVIDENCE, "verify-e2e.txt"), REGISTRO);
  const existing = files.filter((f) => fs.existsSync(f));
  return JSON.parse(execFileSync("python3", ["-c", SCAN_PY, ...existing], { input: JSON.stringify(SECRETS), encoding: "utf8" }));
}

// ---------------------------------------------------------------------------------------------------
// Ejecucion de un recorrido
// ---------------------------------------------------------------------------------------------------

const EXPECTED = [/getSellerBalance/, /^ABORTED-contemplado/, /^FORZADA/];

async function runOne(browser, recorrido, vp, ctx) {
  const folderRel = path.join(recorrido.rf, `${vp.name}-${recorrido.variant}`);
  const folder = path.join(EVIDENCE, folderRel);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const context = await browser.newContext({ viewport: vp.viewport });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const consola = [];
  const red = [];
  const results = [];
  const forced = new Set();
  const check = (text, ok) => results.push([text, Boolean(ok)]);
  const force = async (name, okBody) => {
    forced.add(name);
    await context.route(new RegExp(`/${name}(\\?|$)`), async (route) => {
      const request = route.request();
      const cors = {
        "access-control-allow-origin": request.headers().origin || "*",
        "access-control-allow-headers": "authorization, content-type, firebase-instance-id-token, x-firebase-appcheck, x-firebase-gmpid, x-client-version, x-firebase-client",
        "access-control-allow-methods": "POST, OPTIONS"
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (okBody) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(okBody) });
      return route.fulfill({ status: 500, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ error: { status: "INTERNAL", message: "fallo forzado por verify-029-session" } }) });
    });
  };
  const unforce = async (name) => {
    await context.unroute(new RegExp(`/${name}(\\?|$)`));
    forced.delete(name);
  };
  const page = await context.newPage();
  page.on("console", (m) => consola.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consola.push(`[pageerror] ${e.message}`));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const isForced = [...forced].some((name) => response.url().includes(`/${name}`));
    red.push(`${isForced ? "FORZADA " : ""}${response.status()} ${response.request().method()} ${response.url().slice(0, 200)}`);
  });
  page.on("requestfailed", (request) => {
    const teardown = request.failure()?.errorText === "net::ERR_ABORTED" && /firestore\.googleapis\.com\/.*\/channel/.test(request.url());
    red.push(`${teardown ? "ABORTED-contemplado" : "FAILED"} ${request.failure()?.errorText} ${request.method()} ${request.url().slice(0, 200)}`);
  });
  let n = 0;
  const axeScans = [];
  let lastShot = null;
  const shot = async (label, mask = []) => {
    n += 1;
    lastShot = path.join(folder, `${String(n).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: lastShot, mask, maskColor: "#ff00aa" });
    try {
      axeScans.push(await axeScan(page, label));
    } catch (error) {
      check(`axe pudo analizar "${label}" (${String(error).slice(0, 100)})`, false);
    }
  };
  let fatal = null;
  try {
    if (recorrido.before) await recorrido.before();
    await login(page, ACCOUNTS[recorrido.role]);
    await recorrido.run({ page, check, shot, force, unforce, ctx, vp });
  } catch (error) {
    fatal = String(error?.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error);
    await page.screenshot({ path: path.join(folder, "fallo.png"), fullPage: true }).catch(() => {});
  } finally {
    await context.tracing.stop({ path: path.join(folder, "trace.zip") }).catch(() => {});
    await context.close();
  }
  if (lastShot) fs.copyFileSync(lastShot, path.join(folder, "screenshot.png"));
  const redacted = fs.existsSync(path.join(folder, "trace.zip")) ? redactZip(path.join(folder, "trace.zip")) : 0;
  const expected = (line) => EXPECTED.some((p) => p.test(line));
  const unexpectedNet = red.filter((l) => !expected(l));
  const consoleErrors = consola.filter((l) => /^\[(error|pageerror)\]/.test(l));
  const forcedRun = red.some((l) => l.startsWith("FORZADA"));
  const unexpectedConsole = consoleErrors.filter((l) => !(/Failed to load resource/.test(l) && unexpectedNet.length === 0) && !(forcedRun && /\[OrderAuditTrail\]|INTERNAL|fallo forzado/.test(l)));
  fs.writeFileSync(path.join(folder, "console.txt"), redactText([`# errores de consola: ${consoleErrors.length} (no contemplados: ${unexpectedConsole.length})`, ...consoleErrors, "", "# consola completa", ...consola].join("\n")));
  fs.writeFileSync(path.join(folder, "failed-requests.txt"), redactText([`# 4xx/5xx y fallidas: ${red.length} (no contempladas: ${unexpectedNet.length}; FORZADA = provocada con page.route)`, ...red].join("\n")));
  fs.writeFileSync(path.join(folder, "axe.json"), JSON.stringify(axeScans, null, 1));
  const ok = !fatal && results.every(([, pass]) => pass) && unexpectedConsole.length === 0 && unexpectedNet.length === 0;
  return { recorrido, vp, results, fatal, consoleErrors, unexpectedConsole, red, unexpectedNet, ok, folder, folderRel, axeScans, redacted };
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const out = [`# Spec 029 — verify E2E contra la app desplegada (${new Date().toISOString()})`, `  ${BASE_URL} · solo datos de ${TEST_SELLER_ID}`, ""];
  const outcomes = [];
  let setupError = null;
  let cleanupResult = null;
  const ctx = {};
  await preflight();
  try {
    await setupStore();
    const browser = await chromium.launch();
    try {
      const wanted = (r) => !ONLY.length || ONLY.includes(r.rf);
      for (const recorrido of KEY_FLOWS.filter(wanted)) {
        for (const vp of [MOBILE, DESKTOP]) {
          const o = await runOne(browser, recorrido, vp, ctx);
          outcomes.push(o);
          console.log(`${o.ok ? "PASA " : "FALLA"} ${o.folderRel}`);
        }
      }
      if (HISTORY_FLOWS.some(wanted)) {
        ctx.history = await setupHistoryOrder();
        out.push(`  Pedido de prueba ${ctx.history.trackingCode} (${ctx.history.orderId}) · PATCH por Store API changed=${ctx.history.patchChanged} · clave termina en ${ctx.history.last4}`, "");
        for (const recorrido of HISTORY_FLOWS.filter(wanted)) {
          for (const vp of [MOBILE, DESKTOP]) {
            const o = await runOne(browser, recorrido, vp, ctx);
            outcomes.push(o);
            console.log(`${o.ok ? "PASA " : "FALLA"} ${o.folderRel}`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    setupError = error;
    out.push(`ABORTADO: ${redactText(String(error?.message || error))}`);
  } finally {
    cleanupResult = cleanupSession();
  }
  for (const o of outcomes) {
    out.push(`## ${o.folderRel} — ${o.ok ? "PASA" : "FALLA"}`, `  ${o.recorrido.titulo}`);
    for (const [text, pass] of o.results) out.push(`  ${pass ? "OK   " : "FALLA"} ${text}`);
    if (o.fatal) out.push(`  FALLA el recorrido: ${redactText(o.fatal).slice(0, 400)}`);
    out.push(`  consola: ${o.consoleErrors.length} errores (no contemplados ${o.unexpectedConsole.length}) · red 4xx/5xx/fallidas: ${o.red.length} (no contempladas ${o.unexpectedNet.length}) · secretos tapados en trace: ${o.redacted}`);
    for (const line of [...o.unexpectedConsole, ...o.unexpectedNet].slice(0, 6)) out.push(`     ${redactText(line).slice(0, 220)}`);
    out.push("");
  }
  const axe = writeGlobalAxe(outcomes);
  out.push("## Limpieza", ...cleanupResult.lines.map((l) => `  ${l}`));
  const t27Same = fs.readFileSync(T27_REGISTRO, "utf8") === execFileSync("git", ["show", "HEAD:.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-registro.json"], { cwd: ROOT, encoding: "utf8" });
  out.push(`  t27-registro.json restaurado e igual a HEAD: ${t27Same ? "si" : "NO"}`, "");
  const cleanOk = cleanupResult.ok && cleanupResult.lines.every((l) => !/quedan=[1-9]/.test(l));
  const leaks = scanEvidence(outcomes.map((o) => o.folder));
  out.push(`Secretos en la evidencia: ${leaks.length === 0 ? "ninguno" : leaks.join(", ")}`);
  const allOk = !setupError && outcomes.length > 0 && outcomes.every((o) => o.ok) && cleanOk && t27Same && leaks.length === 0;
  out.push(allOk ? "VERIFY OK" : "VERIFY FALLIDA");
  const text = redactText(out.join("\n"));
  fs.writeFileSync(path.join(EVIDENCE, "verify-e2e.txt"), text);
  console.log(text);
  console.log(JSON.stringify(axe.byRule));
  process.exitCode = allOk ? 0 : 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  restoreT27();
  console.error(redactText(String(error?.stack || error)));
  process.exit(1);
});
