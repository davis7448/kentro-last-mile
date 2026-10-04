/**
 * Spec 026 — fase verify: recorridos E2E por requisito, leyendo de la PANTALLA.
 *
 * Restriccion: las callables `getCashOutstanding` y `updateCashAlertSettings` NO estan desplegadas.
 * Acordado con el responsable:
 *  - app local (`next dev -p 3100`) contra el Firebase de PRODUCCION, solo lectura de datos;
 *  - cuentas Auth desechables (admin y lider con `driverId` del lider real), borradas en `finally`;
 *  - `page.route` intercepta la llamada HTTP a `getCashOutstanding` y responde `{ result }` con el
 *    informe que calcula en node el cargador REAL compilado (`loadCashOutstandingInput` +
 *    `buildCashOutstandingReport`, ADC), con el mismo alcance que el servidor daria al rol:
 *    admin con/sin `includeReconciliation` segun el cuerpo de la peticion; lider con su `driverId`.
 *  - `updateCashAlertSettings` se intercepta SOLO para abortarla y contarla: el dialogo "Plazo y
 *    aviso" se abre, se valida (plazo 0 da error) y se CANCELA. Nunca se guarda.
 * No se escribe nada en Firestore.
 *
 * El cargador se compila al vuelo desde `functions/src` a un directorio temporal: `functions/lib`
 * puede estar desfasado respecto al fuente (lo estaba el 2026-10-02: T21 era posterior al build).
 *
 * Uso: node e2e/verify-026-session.mjs [solo=RF_03,RF_06]
 *   VERIFY_BASE_URL=http://localhost:3100 (si ya hay un next dev levantado, no se arranca otro)
 */
import { createRequire } from "node:module";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PORT = 3100;
const BASE_URL = process.env.VERIFY_BASE_URL || `http://localhost:${PORT}`;
const DRIVER = process.env.VERIFY_DRIVER || "driver-1778271901513";
const EVIDENCE = path.join(ROOT, ".sdd/evidence/026_efectivo_que_no_llega_a_un_corte");
const FN_LIB = path.join(os.tmpdir(), "kentro-verify-026-fnlib");
const MOBILE = { name: "movil-375", viewport: { width: 375, height: 812 } };
const DESKTOP = { name: "escritorio-1280", viewport: { width: 1280, height: 800 } };
const ONLY = (process.argv.find((arg) => arg.startsWith("solo=")) || "").slice(5).split(",").filter(Boolean);

const admin = require(path.join(ROOT, "functions/node_modules/firebase-admin"));
const { chromium } = require(require.resolve("playwright", { paths: [ROOT, "/usr/lib/node_modules"] }));

const fmt = (value) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
const squash = (text) => String(text || "").replace(/\s/g, "");

// ---------------------------------------------------------------------------------------------------
// Informe real, calculado en node
// ---------------------------------------------------------------------------------------------------

function compileLoader() {
  execSync(`npx tsc -p tsconfig.json --outDir ${JSON.stringify(path.join(FN_LIB, "lib"))}`, { cwd: path.join(ROOT, "functions"), stdio: "inherit" });
  // El build vive fuera de functions/: sus `require` de paquetes se resuelven contra functions/node_modules.
  process.env.NODE_PATH = path.join(ROOT, "functions/node_modules");
  require("node:module").Module._initPaths();
  return {
    api: require(path.join(FN_LIB, "lib/cash-outstanding-api.js")),
    core: require(path.join(FN_LIB, "lib/cash-outstanding.js"))
  };
}

async function computeReports({ api, core }, { clockDays = 0, onlyAdmin = false } = {}) {
  const db = admin.firestore();
  // `clockDays` adelanta el reloj del calculo (no los datos): sirve para ver el estado "vencido" cuando
  // produccion esta al dia. Es el mismo cargador y el mismo nucleo; solo cambia `now`.
  const now = new Date(Date.now() + clockDays * 86400000).toISOString();
  const build = async (scope, coverage) => {
    const started = Date.now();
    const input = await api.loadCashOutstandingInput(db, {
      scope,
      coverage,
      // Sin secreto en local: el admin ve "sin canal". El lider no ve ajustes de canal.
      channelConfigured: scope.kind === "admin" ? false : null,
      now
    });
    const report = core.buildCashOutstandingReport(input);
    return { report, ms: Date.now() - started };
  };
  const [summary, full, leader] = await Promise.all([
    build({ kind: "admin", includeReconciliation: false }, "targeted"),
    build({ kind: "admin", includeReconciliation: true }, "full"),
    onlyAdmin ? Promise.resolve(null) : build({ kind: "leader", driverId: DRIVER }, "targeted")
  ]);
  return { summary, full, leader };
}

/** Lo que la tarjeta debe pintar, derivado del informe sin pasar por el modelo de vista. */
function expectedCard(report) {
  const overdue = report.rows.filter((row) => row.isOverdue);
  const groups = [...report.byLeader].sort(
    (a, b) => b.overdueCollectedCop - a.overdueCollectedCop || b.collectedCop - a.collectedCop || String(a.leaderId ?? "").localeCompare(String(b.leaderId ?? ""))
  );
  const top = groups[0] && groups[0].overdueCollectedCop > 0 ? groups[0] : null;
  return {
    overdueCop: overdue.reduce((t, r) => t + r.collectedCop, 0),
    overdueCount: overdue.length,
    topLeaderName: top ? (top.leaderId === null ? "Sin lider" : top.leaderName ?? top.leaderId) : null,
    topLeaderCop: top ? top.overdueCollectedCop : null,
    nettedCount: report.nettedRows.length
  };
}

// ---------------------------------------------------------------------------------------------------
// Infraestructura: next dev, cuentas desechables, sesion
// ---------------------------------------------------------------------------------------------------

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function startNextDev() {
  if (await isUp(BASE_URL)) return null;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(EVIDENCE, "next-dev.log"));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await isUp(BASE_URL)) return child;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("next dev no respondio en 3 minutos");
}

function stopNextDev(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* ya parado */
  }
}

const ACCOUNTS = {
  admin: { uid: "smoke026-admin", claims: { role: "admin" } },
  driver: { uid: "smoke026-driver", claims: { role: "driver", driverId: DRIVER } }
};

async function createAccounts() {
  const auth = admin.auth();
  for (const account of Object.values(ACCOUNTS)) {
    account.email = `${account.uid}@example.com`;
    account.password = crypto.randomBytes(24).toString("base64url");
    await auth.deleteUser(account.uid).catch((error) => {
      if (error.code !== "auth/user-not-found") throw error;
    });
    await auth.createUser({ uid: account.uid, email: account.email, password: account.password, displayName: `Verify 026 ${account.claims.role} (desechable)` });
    // Reclamos ANTES de entrar: el token de la primera sesion ya los trae.
    await auth.setCustomUserClaims(account.uid, account.claims);
  }
}

async function deleteAccounts() {
  const auth = admin.auth();
  const leftovers = [];
  for (const account of Object.values(ACCOUNTS)) {
    await auth.deleteUser(account.uid).catch((error) => {
      if (error.code !== "auth/user-not-found") leftovers.push(`${account.uid}: ${error.message}`);
    });
    try {
      await auth.getUser(account.uid);
      leftovers.push(`${account.uid} sigue existiendo`);
    } catch {
      /* borrada */
    }
  }
  return leftovers;
}

async function login(page, account) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 180000 });
  // Hidratacion: el formulario lo pinta React; rellenarlo antes deja los campos vacios.
  await page.getByRole("button", { name: "Entrar" }).waitFor({ state: "visible", timeout: 180000 });
  await page.waitForTimeout(1500);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Contrasena").fill(account.password);
    if (await page.getByLabel("Email").inputValue()) break;
    await page.waitForTimeout(1500);
  }
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Pulsa un boton o enlace por su texto exacto (el riel cambia entre movil y escritorio). */
async function clickByText(page, texts) {
  const clicked = await page.evaluate((labels) => {
    const nodes = [...document.querySelectorAll("button, a")].filter((node) => labels.includes((node.textContent || "").trim()));
    const visible = nodes.find((node) => node.getClientRects().length > 0) || nodes[0];
    if (!visible) return false;
    visible.click();
    return true;
  }, texts);
  if (!clicked) throw new Error(`No se encontro ${texts.join(" / ")}`);
}

// ---------------------------------------------------------------------------------------------------
// Recorridos
// ---------------------------------------------------------------------------------------------------

async function openCard(page) {
  const card = page.locator('section[aria-label="Efectivo vencido"]').first();
  await card.waitFor({ state: "visible", timeout: 180000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('section[aria-label="Efectivo vencido"]');
    return node && !node.querySelector('[role="status"]') && /\$/.test(node.textContent || "");
  }, null, { timeout: 180000 });
  return card;
}

async function openCashTab(page) {
  const card = await openCard(page);
  const button = card.getByRole("button", { name: "Ver efectivo sin llegar" });
  if ((await button.count()) > 0) {
    await button.click();
  } else {
    // Con todo al dia la tarjeta no ofrece el boton: se llega por el riel y la pestana.
    await clickByText(page, ["Liquidaciones", "Cortes"]);
    await page.getByRole("tab", { name: "Efectivo sin llegar" }).click();
  }
  await page.getByRole("heading", { name: "Efectivo sin llegar", exact: true }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Calculando el efectivo sin llegar"]'), null, { timeout: 180000 });
  await page.waitForTimeout(500);
}

const RECORRIDOS = [
  {
    rf: "RF_03",
    titulo: "HU_01 · tarjeta \"Efectivo vencido\" en Operacion (total vencido, lider, compensados fuera)",
    role: "admin",
    viewports: [MOBILE, DESKTOP],
    async run({ page, reports, check, shot }) {
      const card = await openCard(page);
      const exp = expectedCard(reports.summary.report);
      const text = squash(await card.textContent());
      if (exp.overdueCop <= 0) {
        check(`sin vencidos: la tarjeta queda en una linea "Efectivo vencido: ${fmt(0)} · al dia"`, text.includes(squash(`Efectivo vencido: ${fmt(0)} · al dia`)));
        check("sin vencidos no hay boton ni lider destacado", (await card.getByRole("button").count()) === 0 && !/lidercon/i.test(text));
      } else {
        check(`muestra el vencido ${fmt(exp.overdueCop)}`, text.includes(squash(fmt(exp.overdueCop))));
        check(`dice ${exp.overdueCount} contraentregas sin su efectivo`, text.includes(squash(`${exp.overdueCount} contraentrega`)));
        check(`nombra al lider con mas vencido: ${exp.topLeaderName}, ${fmt(exp.topLeaderCop)}`, text.includes(squash(`${exp.topLeaderName}, ${fmt(exp.topLeaderCop)}`)));
        check("el boton \"Ver efectivo sin llegar\" esta visible", await card.getByRole("button", { name: "Ver efectivo sin llegar" }).isVisible());
      }
      check(`aparta los compensados: "No cuenta ${exp.nettedCount} cubiertos por compensacion"`, exp.nettedCount === 0 || text.includes(squash(`No cuenta ${exp.nettedCount} cubiertos por compensacion`)));
      await card.scrollIntoViewIfNeeded();
      await shot("final");
      if (exp.overdueCop > 0) {
        await card.getByRole("button", { name: "Ver efectivo sin llegar" }).click();
        await page.getByRole("tab", { name: "Efectivo sin llegar", selected: true }).waitFor({ timeout: 30000 });
        check("\"Ver efectivo sin llegar\" abre Liquidaciones en la pestana \"Efectivo sin llegar\"", true);
        await page.waitForFunction(() => !document.querySelector('[aria-label="Calculando el efectivo sin llegar"]'), null, { timeout: 180000 });
        const franja = squash(await page.locator('section[aria-label="Resumen del efectivo sin llegar"]').textContent());
        check(`la pestana pinta el mismo vencido que la tarjeta (${fmt(exp.overdueCop)})`, franja.includes(squash(fmt(exp.overdueCop))));
        await shot("pestana-abierta");
      }
    }
  },
  {
    rf: "RF_03",
    variant: "reloj-10d",
    clockDays: 10,
    titulo: "HU_01 · tarjeta \"Efectivo vencido\" con el reloj del calculo +10 dias (estado vencido con datos reales)",
    role: "admin",
    viewports: [MOBILE, DESKTOP],
    get run() {
      return RECORRIDOS[0].run;
    }
  },
  {
    rf: "RF_02",
    titulo: "HU_01 · pestana \"Efectivo sin llegar\": franja, grupos por lider, cuadre sin filtro y oculto con filtro",
    role: "admin",
    viewports: [MOBILE, DESKTOP],
    async run({ page, reports, check, shot, vp }) {
      await openCashTab(page);
      const report = reports.full.report;
      const rows = report.rows;
      const collected = rows.reduce((t, r) => t + r.collectedCop, 0);
      const overdue = rows.filter((r) => r.isOverdue).reduce((t, r) => t + r.collectedCop, 0);
      const franja = page.locator('section[aria-label="Resumen del efectivo sin llegar"]');
      const franjaText = squash(await franja.textContent());
      check(`franja "Sin llegar" ${fmt(collected)} en ${rows.length} pedidos`, franjaText.includes(squash(`Sin llegar${fmt(collected)}${rows.length} pedido`)));
      check(`franja "Vencido, mas de ${report.settings.overdueDays} dias" ${fmt(overdue)}`, franjaText.includes(squash(`Vencido, mas de ${report.settings.overdueDays} dias${fmt(overdue)}`)));
      check("franja separa \"fuera de todo corte\" y \"en un corte, sin cubrir\"", /fueradetodocorte/i.test(franjaText) && /enuncorte/i.test(franjaText));
      const groups = page.locator('[aria-label="Efectivo sin llegar por lider"] h3 button');
      const groupCount = await groups.count();
      check(`un grupo por lider: ${groupCount} en pantalla, ${report.byLeader.length} en el informe`, groupCount === report.byLeader.length);
      const groupTitles = await groups.evaluateAll((nodes) => nodes.map((n) => (n.querySelector("span span") || n).textContent.trim()));
      const expectedTitles = report.byLeader.map((g) => (g.leaderId === null ? "Sin lider" : g.leaderName ?? g.leaderId));
      check(`los grupos son los lideres del informe (${groupTitles.join(", ").slice(0, 120)})`, expectedTitles.every((t) => groupTitles.includes(t)));
      // Decision de diseno: se despliega solo el primer grupo CON vencidos. Sin vencidos, todos
      // empiezan plegados y se despliega a mano.
      const anyOverdue = report.byLeader.some((g) => g.overdueCollectedCop > 0);
      const firstExpanded = (await groups.first().getAttribute("aria-expanded")) === "true";
      check(`plegado inicial: el primer grupo ${anyOverdue ? "con vencidos esta desplegado" : "esta plegado (no hay vencidos)"}`, firstExpanded === anyOverdue);
      if (!firstExpanded) await groups.first().click();
      await page.waitForTimeout(300);
      const firstRowVisible = vp.viewport.width >= 768
        ? await page.locator('table[aria-label="Efectivo sin llegar por lider"] tbody tr').nth(1).isVisible()
        : await page.locator('[aria-label="Efectivo sin llegar por lider"] li li').first().isVisible();
      check("al desplegar el grupo se ven sus pedidos", firstRowVisible);
      const cuadre = page.getByRole("button", { name: "Cuadre con la posicion de la plataforma" });
      check("el cuadre se muestra sin filtro", await cuadre.isVisible());
      const recon = report.reconciliation;
      const cuadreText = squash(await page.locator("section", { has: cuadre }).last().textContent());
      check(`cuadre: por cobrar ${fmt(recon.driverReceivableCop)} · sin explicar ${fmt(recon.unexplainedCop)}`, cuadreText.includes(squash(`Por cobrar al domiciliario ${fmt(recon.driverReceivableCop)}`)) && cuadreText.includes(squash(`sin explicar ${fmt(recon.unexplainedCop)}`)));
      await page.getByRole("heading", { name: "Efectivo sin llegar", exact: true }).scrollIntoViewIfNeeded();
      await shot("sin-filtro");
      const leaderGroup = report.byLeader.find((g) => g.leaderId !== null) || report.byLeader[0];
      const select = page.getByRole("combobox", { name: "Lider" });
      await select.selectOption(leaderGroup.leaderId ?? "__sin_lider__");
      await page.waitForTimeout(400);
      check(`con filtro de lider (${leaderGroup.leaderName}) el cuadre se oculta`, (await cuadre.count()) === 0);
      check("con filtro queda un solo grupo", (await groups.count()) === 1);
      await select.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_09",
    titulo: "HU_01 · \"Cubiertos por compensacion\" aparte, con todos sus pedidos y fuera del vencido",
    role: "admin",
    viewports: [MOBILE, DESKTOP],
    async run({ page, reports, check, shot }) {
      await openCashTab(page);
      const report = reports.full.report;
      const netted = report.nettedRows;
      const nettedCop = netted.reduce((t, r) => t + r.collectedCop, 0);
      const settlements = new Set(netted.flatMap((r) => r.settlements.filter((s) => s.cashSettled).map((s) => s.id)));
      check(`la franja avisa "Aparte, al final: ${netted.length} cubiertos por compensacion"`, await page.getByText(`Aparte, al final: ${netted.length} cubiertos por compensacion`).isVisible());
      const toggle = page.getByRole("button", { name: "Cubiertos por compensacion", exact: true });
      await toggle.scrollIntoViewIfNeeded();
      const section = page.locator("section", { has: toggle }).last();
      const sectionText = squash(await section.textContent());
      check(`resumen: ${netted.length} pedidos · ${fmt(nettedCop)} · ${settlements.size} cortes saldados`, sectionText.includes(squash(`${netted.length} pedidos · ${fmt(nettedCop)}`)) && sectionText.includes(squash(`${settlements.size} cortes saldados`)));
      check("explica que no cuentan como vencidos ni avisan", /Nocuentancomovencidosniavisan/.test(sectionText));
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const list = page.locator('[aria-label="Pedidos cubiertos por compensacion"]');
      for (let guard = 0; guard < 20; guard += 1) {
        const more = section.getByRole("button", { name: /^Ver (los \d+ pedidos restantes|el pedido restante)$/ });
        if ((await more.count()) === 0) break;
        await more.first().click();
        await page.waitForTimeout(200);
      }
      const shownCodes = await list.evaluate((node) =>
        node.tagName === "TABLE"
          ? [...node.querySelectorAll("tbody tr td:first-child button")].map((b) => b.textContent.trim())
          : [...node.querySelectorAll(":scope > li > button > span:first-child > span:first-child")].map((s) => s.textContent.trim())
      );
      check(`se listan los ${netted.length} pedidos (en pantalla: ${shownCodes.length})`, shownCodes.length === netted.length);
      check("son exactamente las guias del informe", netted.every((r) => shownCodes.includes(r.trackingCode)));
      check(`el informe trae 37 compensados (DoD 3 del responsable): ${netted.length}`, netted.length === 37);
      const pills = await list.getByText("Cubierto por compensacion").count();
      check(`cada fila lleva la pildora "Cubierto por compensacion" (${pills})`, pills === netted.length);
      check("ningun compensado esta en la lista de vencidos del informe", netted.every((r) => !r.isOverdue) && !report.rows.some((r) => netted.some((n) => n.orderId === r.orderId)));
      await toggle.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_04",
    titulo: "HU_01 · dialogo \"Plazo y aviso\": abre, valida plazo 0 y se cancela sin guardar",
    role: "admin",
    viewports: [MOBILE, DESKTOP],
    async run({ page, reports, check, shot, calls }) {
      await openCashTab(page);
      await page.getByRole("button", { name: "Plazo y aviso" }).click();
      const dialog = page.getByRole("dialog", { name: "Plazo y aviso" });
      await dialog.waitFor({ timeout: 15000 });
      await shot("dialogo-abierto");
      const days = dialog.getByLabel("Plazo en dias");
      check(`abre con el plazo vigente (${reports.full.report.settings.overdueDays})`, (await days.inputValue()) === String(reports.full.report.settings.overdueDays));
      check(`abre con el umbral vigente (${reports.full.report.settings.notifyMinCop})`, (await dialog.getByLabel("Avisar desde, en pesos").inputValue()) === String(reports.full.report.settings.notifyMinCop));
      check("dice si hay canal de aviso", await dialog.getByText(/Sin canal: el aviso solo se ve en la app|Canal de aviso configurado/).isVisible());
      await days.fill("0");
      await dialog.getByRole("button", { name: "Guardar" }).click();
      await page.waitForTimeout(300);
      check("plazo 0 muestra el error \"Escribe un numero entero de dias entre 1 y 120.\"", await dialog.getByText("Escribe un numero entero de dias entre 1 y 120.").isVisible());
      check("el campo queda aria-invalid", (await days.getAttribute("aria-invalid")) === "true");
      check("no se llamo a updateCashAlertSettings", calls.update === 0);
      await shot("error-plazo-0");
      await dialog.getByRole("button", { name: "Cancelar" }).click();
      await page.waitForTimeout(300);
      check("Cancelar cierra el dialogo", (await page.getByRole("dialog").count()) === 0);
      check("tras cancelar sigue sin llamarse updateCashAlertSettings", calls.update === 0);
      await shot("final");
    }
  },
  {
    rf: "RF_08",
    titulo: "HU_01 · \"No se puede pagar todavia\" por proveedor en Por pagar y producto retenido en la pestana",
    role: "admin",
    viewports: [DESKTOP, MOBILE],
    async run({ page, reports, check, shot }) {
      await openCard(page);
      await clickByText(page, ["Liquidaciones", "Cortes"]);
      await page.getByRole("tab", { name: "Por pagar" }).waitFor({ timeout: 60000 });
      const report = reports.summary.report;
      const withheld = report.bySupplier.filter((s) => s.amountCop > 0);
      const lines = page.getByText(/^No se puede pagar todavia:/);
      try {
        await lines.first().waitFor({ timeout: 120000 });
      } catch {
        /* se evalua abajo */
      }
      const texts = await lines.allTextContents();
      check(`hay lineas "No se puede pagar todavia" en Por pagar (${texts.length}; proveedores con retenido en el informe: ${withheld.length})`, texts.length > 0);
      const matched = texts.map((text) => withheld.find((s) => squash(text).includes(squash(`No se puede pagar todavia: ${fmt(s.amountCop)}`))));
      check("cada linea pinta el importe de un proveedor del informe", matched.every(Boolean));
      const mismatch = [];
      for (let index = 0; index < texts.length; index += 1) {
        const row = page.locator("tr", { has: lines.nth(index) });
        const name = squash(await row.locator("td").first().textContent());
        if (matched[index] && !name.startsWith(squash(matched[index].supplierName))) mismatch.push(`${matched[index].supplierName} vs ${name.slice(0, 40)}`);
      }
      check(`la linea esta bajo el proveedor que le corresponde${mismatch.length ? ` (${mismatch.join("; ")})` : ""}`, mismatch.length === 0);
      for (const supplier of withheld.filter((s) => s.nettedAmountCop > 0)) {
        const shown = texts.find((t) => squash(t).includes(squash(fmt(supplier.amountCop))));
        if (shown) check(`${supplier.supplierName}: dice cuanto es de compensados (${fmt(supplier.nettedAmountCop)})`, squash(shown).includes(squash(`incluye ${fmt(supplier.nettedAmountCop)} de pedidos cubiertos por compensacion`)));
      }
      if (texts.length > 0) await lines.first().scrollIntoViewIfNeeded();
      await shot("por-pagar");
      await page.getByRole("tab", { name: "Efectivo sin llegar" }).click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Calculando el efectivo sin llegar"]'), null, { timeout: 180000 });
      const card = page.locator('section[aria-label="Producto retenido a proveedores"]');
      await card.waitFor({ timeout: 30000 });
      const toggle = card.getByRole("button", { name: "Producto retenido a proveedores" });
      if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const top = reports.full.report.bySupplier[0];
      const cardText = squash(await card.textContent());
      check(`la pestana muestra el producto retenido: ${top.supplierName} ${fmt(top.amountCop)}`, cardText.includes(squash(top.supplierName)) && cardText.includes(squash(fmt(top.amountCop))));
      await card.scrollIntoViewIfNeeded();
      await shot("final");
    }
  },
  {
    rf: "RF_06",
    titulo: "HU_02 · el lider ve su efectivo sin llegar en Finanzas y \"Pendiente por entregar\" sigue",
    role: "driver",
    viewports: [MOBILE, DESKTOP],
    async run({ page, reports, check, shot }) {
      const report = reports.leader.report;
      await page.waitForFunction(() => /Pendiente por entregar/.test(document.body.textContent || "") && /\$\s?[\d.]+/.test(document.body.textContent || ""), null, { timeout: 180000 });
      // La cifra se completa por pasos (suscripcion + rescate por id): se lee cuando deja de moverse.
      const readPending = async () => {
        let last = null;
        let stable = 0;
        for (let i = 0; i < 90 && stable < 4; i += 1) {
          const value = squash(await page.locator("div", { has: page.getByText("Pendiente por entregar", { exact: true }) }).last().textContent());
          stable = value === last ? stable + 1 : 0;
          last = value;
          await page.waitForTimeout(1000);
        }
        return last;
      };
      const pendingBefore = await readPending();
      check(`Operacion muestra "Pendiente por entregar" (${pendingBefore.replace("Pendienteporentregar", "")})`, /Pendienteporentregar\$/.test(pendingBefore));
      await clickByText(page, ["Finanzas"]);
      const panel = page.locator('section[aria-label="Efectivo sin llegar a Kentro"]');
      await panel.waitFor({ timeout: 60000 });
      await page.waitForFunction(() => {
        const node = document.querySelector('section[aria-label="Efectivo sin llegar a Kentro"]');
        return node && !node.querySelector('[aria-label="Calculando el efectivo sin llegar"]');
      }, null, { timeout: 180000 });
      const outstanding = report.rows.reduce((t, r) => t + r.outstandingCop, 0);
      const text = squash(await panel.textContent());
      if (report.rows.length === 0) {
        check("sin pedidos: \"Kentro tiene todo tu efectivo\"", text.includes("Kentrotienetodotuefectivo"));
      } else {
        check(`muestra su cifra ${fmt(outstanding)} por entregar en ${report.rows.length} pedidos`, text.includes(squash(`${fmt(outstanding)}Por entregar en ${report.rows.length} pedido`)));
        const overdue = report.rows.filter((r) => r.isOverdue).length;
        if (overdue > 0) check(`avisa de ${overdue} con mas de ${report.settings.overdueDays} dias`, text.includes(squash(`mas de ${report.settings.overdueDays} dias`)));
      }
      check("solo trae sus pedidos (todas las filas del informe son de su driverId)", [...report.rows, ...report.nettedRows].every((r) => r.leaderId === DRIVER));
      check("el informe del lider no trae conciliacion ni proveedores", report.reconciliation === null && report.bySupplier.length === 0);
      if (report.nettedRows.length > 0) check(`aparta ${report.nettedRows.length} cubiertos en cortes saldados`, text.includes(squash(`${report.nettedRows.length} pedido`)) && /cubiert/.test(text));
      await panel.scrollIntoViewIfNeeded();
      await shot("finanzas");
      await clickByText(page, ["Operacion"]);
      await page.getByText("Pendiente por entregar", { exact: true }).waitFor({ timeout: 60000 });
      const pendingAfter = await readPending();
      check(`"Pendiente por entregar" sigue en Operacion con la misma cifra (antes ${pendingBefore.replace("Pendienteporentregar", "")}, despues ${pendingAfter.replace("Pendienteporentregar", "")})`, pendingAfter === pendingBefore);
      await shot("final");
    }
  }
];

// ---------------------------------------------------------------------------------------------------
// Accesibilidad: axe-core sobre cada estado recorrido
// ---------------------------------------------------------------------------------------------------

const AXE_SOURCE = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const IMPACTS = ["critical", "serious", "moderate", "minor"];

/**
 * Corre axe sobre el documento entero (WCAG 2.0/2.1/2.2 A y AA + buenas practicas) y clasifica cada
 * nodo: `026` si cae dentro de un contenedor de los componentes `cash-outstanding-*` (tarjeta, pestana,
 * dialogo "Plazo y aviso", panel del lider, linea de proveedor), `app` si no. Asi se ve a la vez lo que
 * introduce la spec y lo que ya traia la app, sin mezclarlos.
 */
async function axeScan(page, label) {
  if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ path: AXE_SOURCE });
  const result = await page.evaluate(async () => {
    const containers = () => {
      const found = [
        ...document.querySelectorAll('section[aria-label="Efectivo vencido"], section[aria-label="Efectivo sin llegar a Kentro"]')
      ];
      const tabHeading = [...document.querySelectorAll("h2")].find((node) => node.textContent.trim() === "Efectivo sin llegar");
      if (tabHeading && tabHeading.closest("section[aria-labelledby]")) found.push(tabHeading.closest("section[aria-labelledby]"));
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (/Plazo y aviso/.test(dialog.textContent || "")) found.push(dialog.parentElement || dialog);
      }
      for (const line of document.querySelectorAll("p")) {
        if (/^No se puede pagar todavia:/.test(line.textContent.trim())) found.push(line);
      }
      return found;
    };
    const scope = containers();
    const run = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      resultTypes: ["violations", "incomplete"]
    });
    // "incomplete" = axe no pudo decidir (tipico: contraste sobre fondos con degradado o vidrio). No es
    // violacion, pero un humano tiene que mirarlo: se cuenta por regla dentro de la 026.
    const incomplete026 = {};
    for (const item of run.incomplete) {
      for (const node of item.nodes) {
        let element = null;
        try {
          element = document.querySelector(node.target[node.target.length - 1]);
        } catch {
          element = null;
        }
        if (element && scope.some((container) => container.contains(element))) incomplete026[item.id] = (incomplete026[item.id] || 0) + 1;
      }
    }
    const resolve = (target) => {
      try {
        return document.querySelector(Array.isArray(target) ? target[target.length - 1] : target);
      } catch {
        return null;
      }
    };
    return {
      containers026: scope.length,
      incomplete026,
      violations: run.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        tags: violation.tags.filter((tag) => /^wcag|best-practice/.test(tag)),
        nodes: violation.nodes.map((node) => {
          const element = resolve(node.target);
          return {
            target: node.target.join(" "),
            impact: node.impact,
            scope: element && scope.some((container) => container.contains(element)) ? "026" : "app",
            html: node.html.slice(0, 200),
            summary: (node.failureSummary || "").slice(0, 300)
          };
        })
      }))
    };
  });
  return { label, url: page.url(), ...result };
}

/** Cuenta nodos por impacto y por ambito; un nodo se cuenta una vez aunque salga en varios estados. */
function axeTally(scans) {
  const seen = new Map();
  for (const scan of scans) {
    for (const violation of scan.violations) {
      for (const node of violation.nodes) {
        const key = `${violation.id}|${node.target}`;
        if (!seen.has(key)) seen.set(key, { rule: violation.id, impact: node.impact || violation.impact, scope: node.scope, target: node.target, help: violation.help, states: [] });
        seen.get(key).states.push(scan.label);
      }
    }
  }
  const items = [...seen.values()];
  const count = (scope, impact) => items.filter((item) => item.scope === scope && item.impact === impact).length;
  return { items, count };
}

function axeSummary(scans, title) {
  const { items, count } = axeTally(scans);
  const lines = [
    `# axe-core 4.13 · ${title}`,
    `  estados analizados: ${scans.map((scan) => `${scan.label} (${scan.containers026} contenedores 026)`).join(", ") || "ninguno"}`,
    `  nodos unicos con violacion (regla + selector), por impacto:`,
    `    ${"".padEnd(10)}${IMPACTS.map((impact) => impact.padStart(10)).join("")}`,
    `    ${"026".padEnd(10)}${IMPACTS.map((impact) => String(count("026", impact)).padStart(10)).join("")}`,
    `    ${"resto app".padEnd(10)}${IMPACTS.map((impact) => String(count("app", impact)).padStart(10)).join("")}`,
    ""
  ];
  for (const scope of ["026", "app"]) {
    lines.push(scope === "026" ? "## Dentro de los componentes de la 026" : "## Resto de la app");
    const list = items.filter((item) => item.scope === scope).sort((a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || a.rule.localeCompare(b.rule));
    if (list.length === 0) lines.push("  (ninguna)");
    for (const item of list) lines.push(`  [${item.impact}] ${item.rule} — ${item.target} — ${item.help} (estados: ${[...new Set(item.states)].join(", ")})`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Total global: cada recorrido con sus cifras y, al final, los nodos critical/serious unicos. */
function writeGlobalAxe(outcomes) {
  const all = outcomes.flatMap((o) => o.axeScans.map((scan) => ({ ...scan, label: `${o.recorrido.rf}/${o.vp.name}${o.recorrido.variant ? `-${o.recorrido.variant}` : ""}/${scan.label}` })));
  const { items, count } = axeTally(all);
  const lines = [
    `# Spec 026 — accesibilidad con axe-core 4.13 (${new Date().toISOString()})`,
    `  ${all.length} estados analizados en ${outcomes.length} recorridos (movil 375 y escritorio 1280).`,
    "  Reglas: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa y best-practice, sobre el documento entero.",
    "  \"026\" = nodo dentro de un componente cash-outstanding-* (tarjeta, pestana, dialogo Plazo y aviso,",
    "  panel del lider, linea de proveedor). \"resto app\" = todo lo demas. Nodos unicos por regla + selector.",
    "",
    `    ${"".padEnd(10)}${IMPACTS.map((impact) => impact.padStart(10)).join("")}`,
    `    ${"026".padEnd(10)}${IMPACTS.map((impact) => String(count("026", impact)).padStart(10)).join("")}`,
    `    ${"resto app".padEnd(10)}${IMPACTS.map((impact) => String(count("app", impact)).padStart(10)).join("")}`,
    "",
    "## Por recorrido (026 crit/ser/mod/min · resto crit/ser/mod/min)"
  ];
  for (const o of outcomes) {
    const tally = axeTally(o.axeScans);
    const row = (scope) => IMPACTS.map((impact) => tally.count(scope, impact)).join("/");
    lines.push(`  ${o.recorrido.rf} ${o.vp.name}${o.recorrido.variant ? ` (${o.recorrido.variant})` : ""}: 026 ${row("026")} · resto ${row("app")}`);
  }
  for (const scope of ["026", "app"]) {
    lines.push("", scope === "026" ? "## critical / serious dentro de la 026" : "## critical / serious en el resto de la app");
    const list = items.filter((item) => item.scope === scope && (item.impact === "critical" || item.impact === "serious"));
    if (list.length === 0) lines.push("  (ninguna)");
    for (const item of list.sort((a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || a.rule.localeCompare(b.rule))) {
      const states = [...new Set(item.states)];
      lines.push(`  [${item.impact}] ${item.rule} — ${item.target} — ${item.help} (${states.length} estados; p.ej. ${states.slice(0, 2).join(", ")})`);
    }
  }
  const incomplete = {};
  for (const scan of all) for (const [rule, value] of Object.entries(scan.incomplete026 || {})) incomplete[rule] = (incomplete[rule] || 0) + value;
  lines.push("", "## Sin decidir por axe dentro de la 026 (incomplete; nodos sumados sobre todos los estados, revisar a mano)");
  if (Object.keys(incomplete).length === 0) lines.push("  (ninguno)");
  for (const [rule, value] of Object.entries(incomplete)) lines.push(`  ${rule}: ${value}`);
  lines.push("", "## moderate / minor dentro de la 026");
  const minor026 = items.filter((item) => item.scope === "026" && (item.impact === "moderate" || item.impact === "minor"));
  if (minor026.length === 0) lines.push("  (ninguna)");
  for (const item of minor026) lines.push(`  [${item.impact}] ${item.rule} — ${item.target} — ${item.help}`);
  fs.writeFileSync(path.join(EVIDENCE, "a11y-axe.txt"), lines.join("\n"));
}

// Contemplados: `getSellerBalance` (la pantalla de entrada la despierta sin sesion de tienda: 403 por
// diseno, spec 018 T18) y el aborto deliberado de `updateCashAlertSettings` (nunca debe ocurrir).
const EXPECTED = [/getSellerBalance/, /^ABORTED-contemplado/];

async function runOne(browser, recorrido, vp, reports) {
  const folder = path.join(EVIDENCE, recorrido.rf, recorrido.variant ? `${vp.name}-${recorrido.variant}` : vp.name);
  fs.mkdirSync(folder, { recursive: true });
  const account = ACCOUNTS[recorrido.role];
  const context = await browser.newContext({ viewport: vp.viewport });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const consola = [];
  const red = [];
  const results = [];
  const calls = { get: [], update: 0, unauthenticated: 0 };
  const check = (text, ok) => results.push([text, Boolean(ok)]);
  await context.route(/cloudfunctions\.net\/(getCashOutstanding|updateCashAlertSettings)/, async (route) => {
    const request = route.request();
    const cors = {
      "access-control-allow-origin": request.headers().origin || "*",
      "access-control-allow-headers": "authorization, content-type, firebase-instance-id-token, x-firebase-appcheck, x-firebase-gmpid, x-client-version, x-firebase-client",
      "access-control-allow-methods": "POST, OPTIONS"
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (/updateCashAlertSettings/.test(request.url())) {
      calls.update += 1;
      return route.abort("blockedbyclient");
    }
    if (!/^Bearer \S+/.test(request.headers().authorization || "")) calls.unauthenticated += 1;
    const data = (JSON.parse(request.postData() || "{}").data) || {};
    const report = recorrido.role === "driver" ? reports.leader.report : data.includeReconciliation ? reports.full.report : reports.summary.report;
    calls.get.push(recorrido.role === "driver" ? "leader" : data.includeReconciliation ? "admin+conciliacion" : "admin-resumen");
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ result: report }) });
  });
  const page = await context.newPage();
  page.on("console", (message) => consola.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consola.push(`[pageerror] ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) red.push(`${response.status()} ${response.request().method()} ${response.url().slice(0, 220)}`);
  });
  page.on("requestfailed", (request) => {
    if (/updateCashAlertSettings/.test(request.url())) return;
    // ERR_ABORTED de un canal largo de Firestore (Listen/Write) es el navegador cortando el long-poll
    // al cerrar el contexto, no una respuesta de error: se anota, pero como contemplado.
    const teardown = request.failure()?.errorText === "net::ERR_ABORTED" && /firestore\.googleapis\.com\/.*\/channel/.test(request.url());
    red.push(`${teardown ? "ABORTED-contemplado" : "FAILED"} ${request.failure()?.errorText} ${request.method()} ${request.url().slice(0, 200)}`);
  });
  let n = 0;
  const axeScans = [];
  const shot = async (label) => {
    n += 1;
    await page.screenshot({ path: path.join(folder, `${String(n).padStart(2, "0")}-${label}.png`), fullPage: false });
    // Cada estado que se fotografia se pasa tambien por axe: es el mismo estado que vera un humano.
    try {
      axeScans.push(await axeScan(page, label));
    } catch (error) {
      // Un fallo de axe no tumba el recorrido funcional, pero queda anotado como estado sin analizar.
      check(`axe pudo analizar el estado "${label}" (${String(error).slice(0, 120)})`, false);
    }
  };
  let fatal = null;
  try {
    await login(page, account);
    await recorrido.run({ page, reports, check, shot, calls, vp });
    check(`la callable se llamo con sesion (Bearer) y alcance del rol: ${[...new Set(calls.get)].join(", ") || "ninguna"}`, calls.get.length > 0 && calls.unauthenticated === 0);
  } catch (error) {
    fatal = String(error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error);
    await page.screenshot({ path: path.join(folder, "fallo.png"), fullPage: true }).catch(() => {});
  } finally {
    await context.tracing.stop({ path: path.join(folder, "trace.zip") }).catch(() => {});
    await context.close();
  }
  const expected = (line) => EXPECTED.some((pattern) => pattern.test(line));
  const unexpectedNet = red.filter((line) => !expected(line));
  // "Failed to load resource" no nombra la url: si toda la red fallida esta contemplada, su eco tambien.
  const consoleErrors = consola.filter((line) => /^\[(error|pageerror)\]/.test(line));
  const unexpectedConsole = consoleErrors.filter((line) => !expected(line) && !(/Failed to load resource/.test(line) && unexpectedNet.length === 0));
  fs.writeFileSync(path.join(folder, "console-errors.txt"), [
    `# errores de consola: ${consoleErrors.length} (no contemplados: ${unexpectedConsole.length})`,
    ...consoleErrors,
    "",
    "# consola completa",
    ...consola
  ].join("\n"));
  fs.writeFileSync(path.join(folder, "network-failures.txt"), [`# 4xx/5xx y fallidas: ${red.length} (no contempladas: ${unexpectedNet.length})`, ...red].join("\n"));
  fs.writeFileSync(path.join(folder, "axe.json"), JSON.stringify(axeScans, null, 1));
  fs.writeFileSync(path.join(folder, "axe-summary.txt"), axeSummary(axeScans, `${recorrido.rf} · ${vp.name}${recorrido.variant ? ` (${recorrido.variant})` : ""}`));
  const ok = !fatal && results.every(([, pass]) => pass) && unexpectedConsole.length === 0 && unexpectedNet.length === 0;
  return { recorrido, vp, results, fatal, consoleErrors, unexpectedConsole, red, unexpectedNet, ok, folder, axeScans };
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const nextEnvPath = path.join(ROOT, "next-env.d.ts");
  const nextEnvBefore = fs.readFileSync(nextEnvPath, "utf8");
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const loader = compileLoader();
  const out = [`# Spec 026 — verify E2E por requisito (${new Date().toISOString()})`, `  ${BASE_URL} · Firebase de produccion, solo lectura · lider ${DRIVER}`, ""];
  let devServer = null;
  let leftovers = [];
  const outcomes = [];
  try {
    const reports = await computeReports(loader);
    const { summary, full, leader } = reports;
    out.push(`  Informe admin resumen: ${summary.report.rows.length} filas, ${summary.report.nettedRows.length} compensados (${summary.ms} ms)`);
    out.push(`  Informe admin con conciliacion: ${full.report.rows.length} filas, ${full.report.nettedRows.length} compensados, sin explicar ${fmt(full.report.reconciliation?.unexplainedCop ?? NaN)} (${full.ms} ms)`);
    out.push(`  Informe lider: ${leader.report.rows.length} filas, ${leader.report.nettedRows.length} compensados (${leader.ms} ms)`);
    out.push("");
    fs.writeFileSync(path.join(EVIDENCE, "verify-informes.json"), JSON.stringify({ summary: summary.report, full: full.report, leader: leader.report }, null, 1));
    devServer = await startNextDev();
    await createAccounts();
    const browser = await chromium.launch();
    const shifted = {};
    try {
      for (const recorrido of RECORRIDOS) {
        if (ONLY.length && !ONLY.includes(recorrido.rf)) continue;
        if (recorrido.clockDays && !shifted[recorrido.clockDays]) {
          shifted[recorrido.clockDays] = await computeReports(loader, { clockDays: recorrido.clockDays, onlyAdmin: true });
          const r = shifted[recorrido.clockDays].summary.report;
          out.push(`  Informe admin con reloj +${recorrido.clockDays} dias: ${r.rows.filter((x) => x.isOverdue).length} vencidos, ${fmt(r.totals.overdueCollectedCop)} brutos, ${r.nettedRows.length} compensados`);
        }
        for (const vp of recorrido.viewports) {
          const outcome = await runOne(browser, recorrido, vp, recorrido.clockDays ? shifted[recorrido.clockDays] : reports);
          outcomes.push(outcome);
          console.log(`${outcome.ok ? "PASA " : "FALLA"} ${recorrido.rf} ${vp.name} ${recorrido.variant || ""}`);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    leftovers = await deleteAccounts();
    stopNextDev(devServer);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (fs.readFileSync(nextEnvPath, "utf8") !== nextEnvBefore) fs.writeFileSync(nextEnvPath, nextEnvBefore);
  }
  for (const o of outcomes) {
    out.push(`## ${o.recorrido.rf} · ${o.vp.name}${o.recorrido.variant ? ` (${o.recorrido.variant})` : ""} —${o.ok ? "PASA" : "FALLA"}`);
    out.push(`  ${o.recorrido.titulo}`);
    for (const [text, pass] of o.results) out.push(`  ${pass ? "OK   " : "FALLA"} ${text}`);
    if (o.fatal) out.push(`  FALLA el recorrido: ${o.fatal.slice(0, 400)}`);
    out.push(`  consola: ${o.consoleErrors.length} errores (no contemplados ${o.unexpectedConsole.length}) · red 4xx/5xx: ${o.red.length} (no contempladas ${o.unexpectedNet.length})`);
    for (const line of o.unexpectedConsole.slice(0, 4)) out.push(`     ${line.slice(0, 220)}`);
    for (const line of o.unexpectedNet.slice(0, 4)) out.push(`     ${line.slice(0, 220)}`);
    out.push(`  evidencia: ${path.relative(ROOT, o.folder)}`);
    out.push("");
  }
  writeGlobalAxe(outcomes);
  out.push(leftovers.length ? `ERROR: cuentas desechables sin borrar: ${leftovers.join("; ")}` : "Cuentas desechables borradas (smoke026-admin, smoke026-driver).");
  const allOk = outcomes.length > 0 && outcomes.every((o) => o.ok) && leftovers.length === 0;
  out.push(allOk ? "VERIFY OK: todos los recorridos completos, sin errores de consola ni red no contemplados." : "VERIFY FALLIDA");
  const text = out.join("\n");
  fs.writeFileSync(path.join(EVIDENCE, ONLY.length ? `verify-e2e-${ONLY.join("-")}.txt` : "verify-e2e.txt"), text);
  console.log(text);
  process.exitCode = allOk ? 0 : 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
