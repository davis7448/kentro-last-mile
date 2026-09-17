#!/usr/bin/env node
/**
 * Spec 018 — medicion en produccion. SOLO LECTURA: ningun subcomando escribe en Firestore.
 *
 *   node scripts/verify-018.js baseline      (T1)  linea base antes de tocar codigo
 *   node scripts/verify-018.js query-check   (T5)  la consulta de candidatos no pide indice
 *   node scripts/verify-018.js compare       (T13) servidor acotado == colecciones enteras, al peso
 *   node scripts/verify-018.js perf <etiqueta> (T1/T13) tiempo hasta la cifra de la tarjeta heroe (RNF_04)
 *   node scripts/verify-018.js e2e           (verify) recorridos de HU_01 y HU_02 contra VERIFY_BASE_URL
 *
 * `perf` es la UNICA excepcion a "solo lectura": crea una cuenta Auth desechable `smoke018-tienda`
 * con reclamos { role: "seller", sellerId: <Bella Mujer> } y la BORRA en `finally`, pase lo que pase.
 * No escribe en Firestore ni guarda la contrasena en ningun archivo.
 *
 * Usa ADC con las librerias de functions/node_modules. `compare` y `query-check` necesitan
 * `functions/lib` compilado (cd functions && npm run build).
 */
const path = require("path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

admin.initializeApp({ projectId: "kentro-last-mile" });
const db = admin.firestore();

const TERMINAL = new Set(["delivered", "failed", "cancelled", "liquidated"]);
const LIQUIDATION = new Set(["cod_revenue", "cod_remittance", "delivery_fee", "failed_fee", "fulfillment_fee", "product_cost", "seller_abono", "gmf_tax"]);
const STREET_CANDIDATE_STATUSES = ["address_risk", "ready_to_assign", "assigned", "call_pending", "scheduled", "pickup_pending", "picked_up", "in_route", "retry_pending"];
const SPEC_STORES = ["Bella Mujer", "DANDA", "Kovia", "Nambu", "ADMA COMERCIAL"];

const docs = (snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
const cop = (value) => Math.round(value).toLocaleString("es-CO");

/** Definicion del CLIENTE antes de la spec (receivedDriverOrderIds, operations-app.tsx:7417). */
function clientCodReceived(settlements, wallet) {
  const ids = new Set();
  const cashToReturn = (orderId) => {
    const cod = wallet.filter((e) => e.ownerType === "seller" && e.orderId === orderId && (e.type === "cod_revenue" || e.type === "cod_remittance")).reduce((s, e) => s + Number(e.amountCop || 0), 0);
    const pay = wallet.filter((e) => e.ownerType === "driver" && e.orderId === orderId && e.type === "driver_earning").reduce((s, e) => s + Number(e.amountCop || 0), 0);
    return Math.max(0, cod - pay);
  };
  for (const s of settlements) {
    if (s.kind !== "driver") continue;
    if (Array.isArray(s.cashAllocations) && s.cashAllocations.length > 0) {
      for (const a of s.cashAllocations) if (a.covered && a.orderId) ids.add(a.orderId);
      continue;
    }
    if (s.status === "paid" || s.status === "reconciled" || s.cashPendingCop === 0) {
      for (const id of s.orderIds ?? []) ids.add(id);
      continue;
    }
    let remaining = (s.cashReceipts ?? []).reduce((sum, r) => sum + Number(r.amountCop || 0), 0);
    if (remaining <= 0) continue;
    for (const id of [...(s.orderIds ?? [])].sort()) {
      const required = cashToReturn(id);
      if (required <= 0) { ids.add(id); continue; }
      if (remaining < required) break;
      remaining -= required;
      ids.add(id);
    }
  }
  return ids;
}

/** Definicion del CORTE (createSettlement, orders.ts:1258): la que la spec adopta. */
function settlementCodReceived(settlements) {
  const ids = new Set();
  for (const s of settlements) {
    if (s.kind !== "driver") continue;
    if (Array.isArray(s.cashAllocations) && s.cashAllocations.length > 0) {
      for (const a of s.cashAllocations) if (a.covered && a.orderId) ids.add(a.orderId);
      continue;
    }
    if (s.status === "paid" || s.status === "reconciled") for (const id of s.orderIds ?? []) ids.add(id);
  }
  return ids;
}

function eligible(entry, ordersById, codReceived) {
  if (entry.type === "seller_abono" || entry.type === "gmf_tax") return true;
  if (!entry.orderId) return false;
  const order = ordersById.get(entry.orderId);
  if (!order) return false;
  if (order.paymentMethod === "prepaid") return true;
  if (order.status !== "delivered" && order.status !== "liquidated") return true;
  return codReceived.has(entry.orderId);
}

async function loadAll() {
  const [sellers, wallet, settlements, openOrders] = await Promise.all([
    db.collection("sellers").get().then(docs),
    db.collection("walletEntries").where("ownerType", "in", ["seller", "driver"]).get().then(docs),
    db.collection("settlements").get().then(docs),
    db.collection("orders").where("status", "not-in", [...TERMINAL]).get().then(docs)
  ]);
  const referenced = [...new Set(wallet.filter((e) => e.ownerType === "seller" && !e.settlementId && e.orderId).map((e) => e.orderId))];
  const ordersById = new Map();
  for (let i = 0; i < referenced.length; i += 300) {
    const snaps = await db.getAll(...referenced.slice(i, i + 300).map((id) => db.collection("orders").doc(id)));
    for (const snap of snaps) if (snap.exists) ordersById.set(snap.id, { id: snap.id, ...snap.data() });
  }
  for (const order of openOrders) ordersById.set(order.id, order);
  return { sellers, wallet, settlements, openOrders, ordersById };
}

async function baseline() {
  const { sellers, wallet, settlements, openOrders, ordersById } = await loadAll();
  const before = clientCodReceived(settlements, wallet);
  const after = settlementCodReceived(settlements);
  const lines = [`# Spec 018 — T1 linea base (${new Date().toISOString()})`, ""];

  lines.push("## 1. Cierre pendiente por tienda: definicion del cliente (hoy) vs la del corte (spec)");
  let storeDiffs = 0;
  for (const seller of sellers) {
    const open = wallet.filter((e) => e.ownerType === "seller" && e.ownerId === seller.id && !e.settlementId);
    if (!open.length) continue;
    const sum = (codReceived) => open.filter((e) => eligible(e, ordersById, codReceived)).reduce((s, e) => s + Number(e.amountCop || 0), 0);
    const b = sum(before), a = sum(after);
    if (b !== a) storeDiffs += 1;
    lines.push(`- ${seller.name}: hoy ${cop(b)} · con la definicion unica ${cop(a)} · diferencia ${cop(a - b)}`);
  }

  lines.push("", "## 2. Pendiente por proveedor (product_cost sin corte de proveedor)");
  let supplierDiffs = 0;
  const bySupplier = new Map();
  for (const e of wallet) {
    if (e.ownerType !== "seller" || e.type !== "product_cost" || e.supplierSettlementId) continue;
    const key = e.supplierName || e.supplierId || "(sin proveedor)";
    const row = bySupplier.get(key) ?? { before: 0, after: 0 };
    const ok = (codReceived) => Boolean(e.settlementId) || eligible(e, ordersById, codReceived);
    if (ok(before)) row.before += -Number(e.amountCop || 0);
    if (ok(after)) row.after += -Number(e.amountCop || 0);
    bySupplier.set(key, row);
  }
  for (const [name, row] of bySupplier) {
    if (row.before !== row.after) supplierDiffs += 1;
    lines.push(`- ${name}: hoy ${cop(row.before)} · con la definicion unica ${cop(row.after)} · diferencia ${cop(row.after - row.before)}`);
  }

  lines.push("", "## 3. Asientos abiertos de tienda que no se pueden atribuir (RF_22)");
  const openSeller = wallet.filter((e) => e.ownerType === "seller" && !e.settlementId);
  const unreadable = openSeller.filter((e) => LIQUIDATION.has(e.type) && !(e.type === "seller_abono" || e.type === "gmf_tax") && (!e.orderId || !ordersById.has(e.orderId)));
  lines.push(`- liquidables sin pedido o con pedido inexistente: ${unreadable.length}`);
  for (const e of unreadable) lines.push(`  - ${e.id} · ${e.type} · ${cop(Number(e.amountCop || 0))} · pedido ${e.orderId || "(vacio)"}`);
  const nonLiquidation = openSeller.filter((e) => !LIQUIDATION.has(e.type));
  lines.push(`- de tipos no liquidables: ${nonLiquidation.length}`);
  for (const e of nonLiquidation) lines.push(`  - ${e.id} · ${e.type} · ${cop(Number(e.amountCop || 0))}`);

  lines.push("", "## 4. Pedidos abiertos reabiertos con marca de recogida (retendran)");
  const reopened = openOrders.filter((o) => o.pickedUpAt && o.status !== "picked_up" && o.status !== "in_route");
  const sellerName = new Map(sellers.map((s) => [s.id, s.name]));
  for (const o of reopened) lines.push(`- ${o.trackingCode ?? o.id} · ${sellerName.get(o.sellerId) ?? o.sellerId} · ${o.status} · recogido ${o.pickedUpAt}`);
  lines.push(`- total: ${reopened.length}`);

  lines.push("", "## Compuerta");
  lines.push(`- tiendas con cifra distinta: ${storeDiffs}`);
  lines.push(`- proveedores con cifra distinta: ${supplierDiffs}`);
  lines.push(`- asientos ilegibles: ${unreadable.length}`);
  console.log(lines.join("\n"));
}

async function queryCheck() {
  const sellers = docs(await db.collection("sellers").get());
  const out = [`# Spec 018 — T5 query-check (${new Date().toISOString()})`];
  for (const seller of sellers) {
    const started = Date.now();
    const snap = await db.collection("orders").where("sellerId", "==", seller.id).where("status", "in", STREET_CANDIDATE_STATUSES).get();
    out.push(`- ${seller.name}: ${snap.size} candidatos en ${Date.now() - started} ms`);
  }
  out.push("Sin error de indice.");
  console.log(out.join("\n"));
}

async function compare() {
  const { buildSellerBalanceInput, computeSellerBalance } = require(path.join(__dirname, "../functions/lib/seller-balance.js"));
  const { loadSellerBalanceInput } = require(path.join(__dirname, "../functions/lib/seller-balance-api.js"));
  const [sellers, wallet, settlements, openOrders, settingsSnap, zones] = await Promise.all([
    db.collection("sellers").get().then(docs),
    db.collection("walletEntries").get().then(docs),
    db.collection("settlements").get().then(docs),
    db.collection("orders").where("status", "not-in", [...TERMINAL]).get().then(docs),
    db.collection("settings").doc("global").get(),
    db.collection("zones").get().then(docs)
  ]);
  const referenced = [...new Set(wallet.filter((e) => e.orderId).map((e) => e.orderId))];
  const ordersById = new Map(openOrders.map((o) => [o.id, o]));
  for (let i = 0; i < referenced.length; i += 300) {
    const snaps = await db.getAll(...referenced.slice(i, i + 300).map((id) => db.collection("orders").doc(id)));
    for (const snap of snaps) if (snap.exists) ordersById.set(snap.id, { id: snap.id, ...snap.data() });
  }
  const now = new Date().toISOString();
  const out = [`# Spec 018 — T13 compare (${now})`, ""];
  let mismatches = 0;
  for (const name of SPEC_STORES) {
    const seller = sellers.find((s) => s.name === name);
    if (!seller) { out.push(`- ${name}: no existe`); mismatches += 1; continue; }
    let lecturas = 0;
    const counting = new Proxy(db, {
      get(target, prop) { const v = target[prop]; return typeof v === "function" ? v.bind(target) : v; }
    });
    const serverInput = await loadSellerBalanceInput(counting, seller.id, now);
    const server = computeSellerBalance(serverInput);
    const adminInput = buildSellerBalanceInput({ sellerId: seller.id, wallet, orders: [...ordersById.values()], settlements, settings: settingsSnap.data() ?? {}, zones, now });
    const adminSide = computeSellerBalance(adminInput);
    const keys = ["totalUnsettledCop", "payableCop", "codPendingCop", "retentionTheoreticalCop", "availableCop", "heldCop", "streetOrderCount", "heldOrderCount"];
    const diff = keys.filter((k) => server[k] !== adminSide[k]);
    const invariant = server.unreadableEntryIds.length > 0 || server.totalUnsettledCop === server.availableCop + server.codPendingCop + server.heldCop;
    if (diff.length || !invariant) mismatches += 1;
    lecturas = serverInput.openEntries.length + serverInput.streetCandidates.length + serverInput.ordersById.size;
    out.push(`- ${name}: disponible ${cop(server.availableCop)} · efectivo con domiciliario ${cop(server.codPendingCop)} · retenido ${cop(server.heldCop)} (${server.heldOrderCount} pedidos; ${server.streetOrderCount} en la calle, teorica ${cop(server.retentionTheoreticalCop)}) · total ${cop(server.totalUnsettledCop)} · ilegibles ${server.unreadableEntryIds.length}`);
    out.push(`  - servidor == admin: ${diff.length ? "NO (" + diff.join(", ") + ")" : "si, al peso"} · invariante: ${invariant ? "cuadra" : "NO cuadra"} · documentos leidos (sin cortes ni ajustes): ~${lecturas}`);
  }
  const driverSettlements = settlements.filter((s) => s.kind === "driver").length;
  out.push("", `Cortes de domiciliario leidos por llamada: ${driverSettlements}`);
  out.push(`Resultado: ${mismatches === 0 ? "COINCIDEN" : mismatches + " tiendas con diferencias"}`);
  console.log(out.join("\n"));
}


const crypto = require("crypto");
const PERF_UID = "smoke018-tienda";
const PERF_URL = process.env.VERIFY_BASE_URL || "https://kentro-last-mile.web.app";
const PERF_RUNS = Number(process.env.PERF_RUNS || 5);

function loadPlaywright() {
  const playwrightPath = require.resolve("playwright", { paths: [process.cwd(), "/usr/lib/node_modules"] });
  return require(playwrightPath);
}

/** Una carga en frio: contexto nuevo, entrar y cronometrar hasta que la tarjeta heroe muestra pesos. */
async function perfRun(browser, viewport, email, password) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await page.goto(PERF_URL, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Contrasena").fill(password);
    const started = Date.now();
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForFunction(() => {
      // La tarjeta heroe es la .glass-acid que habla de liquidar (hay otras vacias en los controles).
      return [...document.querySelectorAll(".glass-acid")].some((card) => /liquidar/i.test(card.textContent || "") && /\$\s?-?[\d.]+/.test(card.textContent || ""));
    }, null, { timeout: 90000 });
    return Date.now() - started;
  } catch (error) {
    await page.screenshot({ path: path.join(__dirname, "../.sdd/evidence/018/perf-fallo.png"), fullPage: true }).catch(() => {});
    const cards = await page.evaluate(() => [...document.querySelectorAll(".glass-acid")].map((n) => (n.textContent || "").slice(0, 120))).catch(() => []);
    console.error("glass-acid:", JSON.stringify(cards));
    throw error;
  } finally {
    await context.close();
  }
}

async function perf() {
  const label = process.argv[3] || "sin-etiqueta";
  const auth = admin.auth();
  const sellers = docs(await db.collection("sellers").where("name", "==", "Bella Mujer").get());
  if (sellers.length !== 1) throw new Error(`Esperaba una tienda Bella Mujer, hay ${sellers.length}.`);
  const email = `${PERF_UID}@example.com`;
  const password = crypto.randomBytes(24).toString("base64url");
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const out = [`# Spec 018 — perf "${label}" (${new Date().toISOString()}) sobre ${PERF_URL}, tienda Bella Mujer`];
  try {
    try { await auth.deleteUser(PERF_UID); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await auth.createUser({ uid: PERF_UID, email, password, displayName: "Verify 018 tienda (desechable)" });
    await auth.setCustomUserClaims(PERF_UID, { role: "seller", sellerId: sellers[0].id });
    for (const [name, viewport] of [["movil 390x844", { width: 390, height: 844 }], ["escritorio 1280x800", { width: 1280, height: 800 }]]) {
      const times = [];
      for (let i = 0; i < PERF_RUNS; i += 1) times.push(await perfRun(browser, viewport, email, password));
      out.push(`- ${name}: mediana ${median(times)} ms · corridas ${times.join(", ")} ms`);
    }
  } finally {
    await browser.close();
    await auth.deleteUser(PERF_UID).catch((error) => { if (error.code !== "auth/user-not-found") throw error; });
    try { await auth.getUser(PERF_UID); out.push("- ERROR: la cuenta desechable sigue existiendo"); } catch { out.push("- cuenta desechable borrada"); }
  }
  console.log(out.join("\n"));
}

/**
 * E2E (fase verify): un recorrido por historia con interfaz.
 *  - HU_01 (RF_18, RF_19): la tienda ve el disponible y su desglose.
 *  - HU_02 (RF_20): el admin ve la MISMA cifra en el cierre pendiente.
 * La cifra esperada sale del cargador del servidor (functions/lib), igual que la callable.
 * Cuentas desechables `smoke018-tienda` y `smoke018-admin`, borradas en `finally`.
 */
async function e2e() {
  const fs = require("fs");
  const baseUrl = process.env.VERIFY_BASE_URL || "http://localhost:3018";
  const evidence = path.join(__dirname, "../.sdd/evidence/018");
  const { computeSellerBalance } = require(path.join(__dirname, "../functions/lib/seller-balance.js"));
  const { loadSellerBalanceInput } = require(path.join(__dirname, "../functions/lib/seller-balance-api.js"));
  const auth = admin.auth();
  const sellers = docs(await db.collection("sellers").where("name", "==", "Bella Mujer").get());
  if (sellers.length !== 1) throw new Error("Bella Mujer no es unica");
  const expected = computeSellerBalance(await loadSellerBalanceInput(db, sellers[0].id, new Date().toISOString()));
  const fmt = (v) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v).replace(/\s/g, " ");
  const norm = (t) => String(t || "").replace(/\s/g, " ");
  const accounts = [
    { uid: "smoke018-tienda", claims: { role: "seller", sellerId: sellers[0].id } },
    { uid: "smoke018-admin", claims: { role: "admin" } }
  ].map((a) => ({ ...a, email: `${a.uid}@example.com`, password: crypto.randomBytes(24).toString("base64url") }));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const results = { baseUrl, esperado: { disponible: fmt(expected.availableCop), efectivo: fmt(expected.codPendingCop), retenido: fmt(expected.heldCop), total: fmt(expected.totalUnsettledCop) }, recorridos: [] };

  async function journey(folder, viewport, account, steps) {
    const dir = path.join(evidence, folder);
    fs.mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("response", (res) => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`); });
    const record = { folder, viewport: `${viewport.width}x${viewport.height}`, ok: false, checks: [] };
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.getByLabel("Email").fill(account.email);
      await page.getByLabel("Contrasena").fill(account.password);
      await page.getByRole("button", { name: "Entrar" }).click();
      await steps(page, record);
      record.ok = record.checks.every((c) => c.ok);
    } catch (error) {
      record.error = String(error && error.message ? error.message : error);
    } finally {
      await page.screenshot({ path: path.join(dir, `final-${viewport.width}.png`), fullPage: true }).catch(() => {});
      await context.tracing.stop({ path: path.join(dir, `trace-${viewport.width}.zip`) }).catch(() => {});
      fs.writeFileSync(path.join(dir, `consola-${viewport.width}.txt`), consoleErrors.join("\n") + "\n");
      fs.writeFileSync(path.join(dir, `red-fallida-${viewport.width}.txt`), failedRequests.join("\n") + "\n");
      record.consoleErrors = consoleErrors.length;
      record.failedRequests = failedRequests;
      await context.close();
    }
    results.recorridos.push(record);
    console.log(`${record.ok ? "PASA" : "FALLA"} ${folder} ${record.viewport}${record.error ? " · " + record.error : ""}`);
    for (const c of record.checks) console.log(`   ${c.ok ? "ok " : "MAL"} ${c.what}`);
    console.log(`   consola: ${consoleErrors.length} errores · red >=400: ${failedRequests.length}`);
  }

  try {
    for (const a of accounts) {
      try { await auth.deleteUser(a.uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
      await auth.createUser({ uid: a.uid, email: a.email, password: a.password, displayName: "Verify 018 (desechable)" });
      await auth.setCustomUserClaims(a.uid, a.claims);
    }
    const [store, adminAccount] = accounts;

    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      await journey("HU_01-RF_18-RF_19", viewport, store, async (page, record) => {
        await page.waitForFunction(() => [...document.querySelectorAll(".glass-acid")].some((c) => /Disponible para liquidar/.test(c.textContent || "") && /\$/.test(c.textContent || "")), null, { timeout: 90000 });
        const hero = norm(await page.evaluate(() => [...document.querySelectorAll(".glass-acid")].map((c) => c.textContent).find((t) => /Disponible para liquidar/.test(t || ""))));
        record.checks.push({ what: `RF_18 tarjeta heroe muestra ${fmt(expected.availableCop)}`, ok: hero.includes(fmt(expected.availableCop)) });
        record.checks.push({ what: "RF_18 sin 'Lo pendiente de hoy'", ok: !hero.includes("Lo pendiente de hoy") });
        await page.getByRole("button", { name: /Solicitudes de liquidacion/ }).first().click();
        await page.getByText("Total sin cortar").first().waitFor({ state: "visible", timeout: 30000 });
        const body = norm(await page.locator("body").innerText());
        for (const [label, value] of [["Disponible para liquidar", expected.availableCop], ["Efectivo aun con el domiciliario", expected.codPendingCop], ["Retenido", expected.heldCop], ["Total sin cortar", expected.totalUnsettledCop]]) {
          record.checks.push({ what: `RF_19 panel: ${label} ${fmt(value)}`, ok: body.includes(label) && body.includes(fmt(value)) });
        }
        record.checks.push({ what: "RF_07 el panel no muestra 'Reserva'", ok: !/Reserva:/.test(body) });
      });
    }

    await journey("HU_02-RF_20", { width: 1280, height: 800 }, adminAccount, async (page, record) => {
      await page.getByRole("button", { name: /Liquidaciones|Cortes/ }).first().waitFor({ state: "visible", timeout: 90000 });
      await page.getByRole("button", { name: /Liquidaciones|Cortes/ }).first().click();
      await page.getByText("Tiendas disponibles para pagar").first().waitFor({ state: "visible", timeout: 120000 });
      // Los pedidos viejos de los asientos sin cortar llegan despues del primer pintado (rescate por
      // id): se mide cuanto tarda la fila en mostrar la cifra, con un maximo de 90 s.
      const startedWaiting = Date.now();
      const target = fmt(expected.availableCop);
      await page.waitForFunction((name) => {
        const nodes = [...document.querySelectorAll("span,td,div")].filter((n) => (n.textContent || "").trim() === name);
        const row = nodes.map((n) => n.closest("tr, li, [role=row], .grid")).find(Boolean);
        return Boolean(row && /[1-9]/.test((row.textContent || "").replace(/Bella Mujer/, "").split("Neto")[0]));
      }, "Bella Mujer", { timeout: 90000 }).catch(() => {});
      record.rowWaitMs = Date.now() - startedWaiting;
      const rowText = norm(await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("span,td,div")].filter((n) => (n.textContent || "").trim() === "Bella Mujer");
        const row = nodes.map((n) => n.closest("tr, li, [role=row], .grid")).find(Boolean);
        return row ? row.textContent : "";
      }));
      record.checks.push({ what: `RF_20 fila Bella Mujer del cierre muestra ${fmt(expected.availableCop)} (igual que la tienda)`, ok: rowText.includes(fmt(expected.availableCop)) });
      record.rowText = rowText.slice(0, 300);
    });
  } finally {
    await browser.close();
    for (const a of accounts) await auth.deleteUser(a.uid).catch((error) => { if (error.code !== "auth/user-not-found") throw error; });
    results.cuentasBorradas = true;
    fs.writeFileSync(path.join(evidence, "e2e-resultado.json"), JSON.stringify(results, null, 2) + "\n");
  }
  if (!results.recorridos.every((r) => r.ok)) process.exitCode = 1;
}

const command = process.argv[2];
const run = { baseline, "query-check": queryCheck, compare, perf, e2e }[command];
if (!run) {
  console.error("Uso: node scripts/verify-018.js baseline|query-check|compare|perf <etiqueta>");
  process.exit(2);
}
run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
