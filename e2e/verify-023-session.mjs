/**
 * Spec 023, fase B — A/B leyendo de la PANTALLA del admin, contra el Firebase de PRODUCCION.
 *
 *   node e2e/verify-023-session.mjs <dir-antes> <dir-despues>
 *
 * Levanta `next dev` en cada carpeta, de una en una (la maquina no da para dos a la vez), entra con una cuenta
 * Auth DESECHABLE con reclamo `admin` (se borra en `finally`) y lee el texto de Liquidaciones: cabecera, "Por
 * pagar" con todos los paneles desplegados, "Cortes cerrados" (pagina 1) y "Resumen del periodo". RF_03 exige
 * que el texto de las dos versiones sea el mismo. Ademas registra, con `kentro-perf`, cuantos asientos de
 * wallet baja la app al abrir.
 *
 * NO ESCRIBE NADA: el canal `Write` de Firestore se aborta en el navegador, y cualquier callable que no sea de
 * lectura tambien. Se cuentan los intentos (el autoguardado del admin puede intentar escribir al entrar: ver la
 * memoria "autoguardado-admin-pisa-tarifas").
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const EVIDENCE = path.join(ROOT, ".sdd/evidence/023");
const [, , BEFORE_DIR, AFTER_DIR] = process.argv;
if (!BEFORE_DIR || !AFTER_DIR) {
  console.error("uso: node e2e/verify-023-session.mjs <dir-antes> <dir-despues>");
  process.exit(2);
}
const admin = require(path.join(ROOT, "functions/node_modules/firebase-admin"));
const { chromium } = require(require.resolve("playwright", { paths: [ROOT, "/usr/lib/node_modules"] }));
admin.initializeApp({ projectId: "kentro-last-mile" });

const READ_CALLABLES = ["getPlatformPosition", "getCashOutstanding", "getBootstrapStatus", "getOrderStats", "getSellerBalance", "getCommunityStats"];

async function isUp(url) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function startNextDev(dir, port, label) {
  const child = spawn("npx", ["next", "dev", "-p", String(port)], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" } });
  const log = fs.createWriteStream(path.join(EVIDENCE, `next-dev-${label}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`next dev (${label}) no respondio en 4 minutos`);
}

function stop(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* ya parado */
  }
}

const normalize = (text) =>
  String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Calculada a las/.test(line) && !/Actualizar$/.test(line))
    .join("\n");

async function readScreens(url, account) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const blocked = { firestoreWrites: 0, callables: [] };
  await context.route(/firestore\.googleapis\.com\/.*\/Write\//, (route) => {
    blocked.firestoreWrites += 1;
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
  const perf = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/wallet listo|base ligera|listo en/.test(text)) perf.push(text);
  });
  const screens = {};
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.getByRole("button", { name: "Entrar" }).waitFor({ state: "visible", timeout: 240000 });
    await page.waitForTimeout(1500);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Contrasena").fill(account.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.getByRole("button", { name: /Liquidaciones|Cortes/ }).first().waitFor({ timeout: 240000 });
    await page.waitForTimeout(8000);
    await page.getByRole("button", { name: /Liquidaciones|Cortes/ }).first().click();
    await page.getByRole("tab", { name: "Por pagar" }).waitFor({ timeout: 120000 });
    // Que termine de cargar lo pedido (la version nueva muestra "Cargando ..." mientras tanto).
    await page.waitForFunction(() => !/Cargando lo pendiente/.test(document.body.innerText), null, { timeout: 180000 });
    await page.waitForTimeout(4000);
    for (let round = 0; round < 3; round += 1) {
      const closed = page.locator('main button[aria-expanded="false"]');
      const count = await closed.count();
      for (let index = count - 1; index >= 0; index -= 1) await closed.nth(index).click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }
    await page.waitForFunction(() => !/Calculando la posicion/.test(document.body.innerText), null, { timeout: 120000 }).catch(() => undefined);
    screens.payable = normalize(await page.locator("main").innerText());

    await page.getByRole("tab", { name: "Cortes cerrados" }).click();
    await page.waitForFunction(() => !/Cargando los movimientos de los cortes/.test(document.body.innerText), null, { timeout: 180000 });
    await page.waitForTimeout(3000);
    screens.closed = normalize(await page.locator("main").innerText());

    await page.getByRole("tab", { name: "Resumen del periodo" }).click();
    await page.waitForFunction(() => !/Cargando los movimientos del periodo/.test(document.body.innerText), null, { timeout: 180000 });
    await page.waitForTimeout(3000);
    screens.period = normalize(await page.locator("main").innerText());
    await page.screenshot({ path: path.join(EVIDENCE, `liquidaciones-periodo-${account.label}.png`), fullPage: false });
  } finally {
    await browser.close();
  }
  return { screens, perf, blocked };
}

const runId = crypto.randomBytes(4).toString("hex");
const account = { uid: `verify023-admin-${runId}`, email: `verify023-${runId}@kentro.invalid`, password: crypto.randomBytes(12).toString("hex") };
const auth = admin.auth();

const report = { at: new Date().toISOString(), runs: {} };
try {
  await auth.createUser({ uid: account.uid, email: account.email, password: account.password, displayName: "Verify 023 admin (desechable)" });
  await auth.setCustomUserClaims(account.uid, { role: "admin" });
  for (const [label, dir, port] of [["antes", BEFORE_DIR, 3124], ["despues", AFTER_DIR, 3123]]) {
    const server = await startNextDev(dir, port, label);
    try {
      report.runs[label] = await readScreens(server.url, { ...account, label });
    } finally {
      stop(server.child);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
} finally {
  await auth.deleteUser(account.uid).catch((error) => console.error("No se pudo borrar la cuenta desechable", account.uid, error));
}

const before = report.runs.antes.screens;
const after = report.runs.despues.screens;
const diff = (a, b) => {
  const left = a.split("\n");
  const right = b.split("\n");
  const out = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) out.push({ linea: index + 1, antes: left[index], despues: right[index] });
    if (out.length >= 15) break;
  }
  return out;
};
report.comparacion = Object.fromEntries(["payable", "closed", "period"].map((key) => [key, before[key] === after[key] ? "igual" : diff(before[key], after[key])]));
for (const label of ["antes", "despues"]) {
  for (const key of ["payable", "closed", "period"]) fs.writeFileSync(path.join(EVIDENCE, `pantalla-${key}-${label}.txt`), report.runs[label].screens[key] ?? "");
  delete report.runs[label].screens;
}
fs.writeFileSync(path.join(EVIDENCE, "phase-b-session.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(Object.values(report.comparacion).every((value) => value === "igual") ? 0 : 1);
