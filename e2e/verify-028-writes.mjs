/**
 * Spec 028 — que escribe la app cuando un admin solo ABRE la sesion y no toca nada.
 *
 *   PROD_URL=https://kentro-last-mile.web.app node e2e/verify-028-writes.mjs
 *
 * Deriva del modo produccion de `e2e/verify-023-session.mjs` (rama de la spec 023): entra con una cuenta Auth
 * DESECHABLE con reclamo `admin` (se borra en `finally`), espera sin hacer clic y ABORTA en el navegador todo
 * intento de escritura: el canal `Write` de Firestore y cualquier callable que no sea de lectura.
 *
 * Lo que anade a la 023: por cada peticion abortada decodifica el cuerpo del canal `Write` (WebChannel,
 * `reqN___data__` en form-urlencoded) y registra QUE documento intenta escribir, con que mascara y que campos.
 * Los valores solo se guardan para `settings/global` (son tarifas, no datos de clientes) y fuera del repo.
 *
 * Pasa el saludo del canal Write (no escribe) y aborta todo mensaje que lleve `writes`.
 *
 * NO ESCRIBE NADA en Firestore. Lo unico que toca es Auth (crear y borrar la cuenta desechable).
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const RAW = process.env.VERIFY_RAW_DIR || path.join(os.tmpdir(), "kentro-verify-028");
fs.mkdirSync(RAW, { recursive: true });
const PROD_URL = process.env.PROD_URL;
const IDLE_MS = Number(process.env.IDLE_MS || 45000);
if (!PROD_URL) {
  console.error("uso: PROD_URL=https://kentro-last-mile.web.app node e2e/verify-028-writes.mjs");
  process.exit(2);
}
const admin = require(path.join(ROOT, "functions/node_modules/firebase-admin"));
const { chromium } = require(require.resolve("playwright", { paths: [ROOT, "/usr/lib/node_modules"] }));
admin.initializeApp({ projectId: "kentro-last-mile" });

const READ_CALLABLES = ["getPlatformPosition", "getCashOutstanding", "getBootstrapStatus", "getOrderStats", "getSellerBalance", "getCommunityStats"];

/** Valor de Firestore REST (`{integerValue: "12000"}`) a JS plano, solo para el informe. */
function plain(value) {
  if (!value || typeof value !== "object") return value;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(plain);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, plain(v)]));
  return value;
}

/** Saca las escrituras de un cuerpo del canal Write. Un cuerpo puede traer varios `reqN___data__`. */
function decodeWriteBody(body) {
  const out = [];
  if (!body) return out;
  const params = new URLSearchParams(body);
  for (const [key, raw] of params) {
    if (!/^req\d+___data__$/.test(key)) continue;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      out.push({ undecodable: raw.slice(0, 200) });
      continue;
    }
    if (!message.writes) {
      out.push({ handshake: Object.keys(message), streamToken: Boolean(message.streamToken) });
      continue;
    }
    for (const write of message.writes) {
      const name = write.update?.name ?? write.delete ?? write.transform?.document ?? "?";
      const docPath = String(name).replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, "");
      const fields = write.update ? Object.keys(write.update.fields || {}) : [];
      out.push({
        doc: docPath,
        kind: write.update ? "set" : write.delete ? "delete" : "transform",
        merge: Boolean(write.updateMask),
        mask: write.updateMask?.fieldPaths ?? null,
        fields,
        transforms: (write.updateTransforms || []).map((t) => t.fieldPath),
        values: docPath === "settings/global" ? plain({ mapValue: { fields: write.update?.fields || {} } }) : undefined
      });
    }
  }
  return out;
}

async function observe(url, account) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const blocked = { firestoreWriteRequests: 0, writes: [], callables: [], timeline: [] };
  let loggedInAt = 0;
  await context.route(/firestore\.googleapis\.com\/.*\/Write\//, (route) => {
    const request = route.request();
    blocked.firestoreWriteRequests += 1;
    const decoded = decodeWriteBody(request.postData());
    const at = loggedInAt ? Date.now() - loggedInAt : null;
    blocked.timeline.push({ at, method: request.method(), decoded: decoded.length });
    for (const write of decoded) blocked.writes.push({ at, ...write });
    // El saludo del canal (`{database}` y nada mas) no escribe: sin dejarlo pasar el SDK nunca llega a
    // mandar las escrituras y solo se ve el saludo reintentado con espera exponencial (lo que contaba la
    // 023). Las escrituras necesitan el `streamToken` que devuelve el saludo, asi que viajan SIEMPRE en
    // una peticion posterior, que se aborta. Las GET del canal son la bajada del servidor: no llevan cuerpo.
    const pureHandshake = decoded.length > 0 && decoded.every((write) => write.handshake && write.handshake.length === 1 && write.handshake[0] === "database");
    if (request.method() === "GET" || (request.method() === "POST" && pureHandshake)) {
      blocked.timeline[blocked.timeline.length - 1].passed = true;
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
  await context.route(/cloudfunctions\.net\/([A-Za-z]+)/, (route) => {
    const name = route.request().url().match(/cloudfunctions\.net\/([A-Za-z]+)/)[1];
    if (READ_CALLABLES.includes(name)) return route.continue();
    blocked.callables.push(name);
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => window.localStorage.setItem("kentro-perf", "1"));
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/autoguardado|guardar el estado|inicializar el estado|emit #|base ligera/.test(text)) consoleLines.push(text.slice(0, 300));
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.getByRole("button", { name: "Entrar" }).waitFor({ state: "visible", timeout: 240000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.getByLabel("Email").fill(account.email);
      await page.getByLabel("Contrasena").fill(account.password);
      await page.waitForTimeout(500);
      if ((await page.getByLabel("Email").inputValue()) === account.email && (await page.getByLabel("Contrasena").inputValue()) === account.password) break;
    }
    loggedInAt = Date.now();
    await page.getByRole("button", { name: "Entrar" }).click();
    // Nadie toca nada: solo se espera.
    await page.waitForTimeout(IDLE_MS);
    await page.screenshot({ path: path.join(RAW, "admin-tras-esperar.png") });
  } finally {
    await browser.close();
  }
  return { blocked, consoleLines };
}

const runId = crypto.randomBytes(4).toString("hex");
const account = { uid: `verify028-admin-${runId}`, email: `verify028-${runId}@kentro.invalid`, password: crypto.randomBytes(12).toString("hex") };
const auth = admin.auth();
try {
  await auth.createUser({ uid: account.uid, email: account.email, password: account.password, displayName: "Verify 028 admin (desechable)" });
  await auth.setCustomUserClaims(account.uid, { role: "admin" });
  const run = await observe(PROD_URL, account);
  const byDoc = {};
  for (const write of run.blocked.writes) if (write.doc) byDoc[write.doc] = (byDoc[write.doc] || 0) + 1;
  const report = { at: new Date().toISOString(), url: PROD_URL, idleMs: IDLE_MS, ...run.blocked, byDoc, consoleLines: run.consoleLines };
  fs.writeFileSync(path.join(RAW, "writes-produccion.json"), JSON.stringify(report, null, 2));
  // A la salida estandar va todo menos los valores, que se quedan en RAW.
  console.log(JSON.stringify({ ...report, writes: report.writes.map(({ values, ...rest }) => rest) }, null, 2));
  console.error(`detalle con valores en ${path.join(RAW, "writes-produccion.json")}`);
} finally {
  await auth.deleteUser(account.uid).catch((error) => console.error("No se pudo borrar la cuenta desechable", account.uid, error));
}
process.exit(0);
