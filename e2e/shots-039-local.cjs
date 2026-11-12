// Spec 039: capturas de «Recogidos pendientes de mensajero» en modo local (sin Firebase), con
// datos inventados (22 pedidos de DANDA y Kovia en desorden). No toca produccion.
//
//   NEXT_PUBLIC_USE_FIRESTORE=false npx next dev -p 3939
//   PLAYWRIGHT_CORE=<ruta a playwright-core> node e2e/shots-039-local.cjs <carpeta-salida>
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const out = process.argv[2];
const base = "http://localhost:3939/";

const names = ["Edwin García", "Luus Cortes", "Francisco Quintero", "Yuly Mosquera Franco", "Cesar Cartaya", "Rodolfo Viáfara Viveros", "Johana Hurtado", "Albeiro Díaz Cárdenas", "Marta Ruiz", "Óscar Peña", "Lina Torres", "Jhon Mejía", "Sandra Ochoa", "Diana López", "Felipe Arango", "Carolina Vélez", "Andrés Gil", "Paola Rincón", "Kevin Muñoz", "Laura Cifuentes", "Natalia Ríos", "Camilo Rojas"];
const codes = [8465, 8503, 8504, 8384, 8469, 8386, 8391, 8470, 8512, 8399, 8471, 8520, 8388, 8500, 8476, 8392, 8530, 8395, 8481, 8402, 8519, 8460];
const now = new Date().toISOString();
const orders = codes.map((code, index) => ({
  id: `o-${code}`,
  trackingCode: `KNT-${String(code).padStart(6, "0")}`,
  shopifyOrderId: String(5000 + index),
  sellerId: index % 5 === 0 ? "s-kovia" : "s-danda",
  pickupPointName: index % 5 === 0 ? "KOVIA" : "DANDA",
  cityId: "city-cali",
  driverId: "d1",
  customerName: names[index],
  customerPhone: "+573000000000",
  addressRaw: "Calle 1 # 2-3",
  addressRisk: "low",
  status: "picked_up",
  paymentMethod: "cod",
  fulfillmentMode: "seller_stock",
  totalCop: 90000,
  evidence: [],
  lineItems: [],
  createdAt: now,
  updatedAt: now
}));

// Enmienda 1: 12 pedidos ya asignados (en desorden) para «Asignados a mensajero».
const assignedCodes = [8610, 8588, 8602, 8575, 8599, 8581, 8615, 8590, 8577, 8606, 8584, 8612];
const assignedNames = ["Mario Salazar", "Ingrid Patiño", "Tatiana Mora", "Héctor Lozano", "Gloria Ibáñez", "Ramiro Cuesta", "Yesenia Valencia", "Wilson Ortiz", "Daniela Correa", "Esteban Ruiz", "Pilar Gómez", "Sergio Henao"];
orders.push(...assignedCodes.map((code, index) => ({
  ...orders[0],
  id: `a-${code}`,
  trackingCode: `KNT-${String(code).padStart(6, "0")}`,
  shopifyOrderId: String(6000 + index),
  sellerId: index % 4 === 0 ? "s-kovia" : "s-danda",
  pickupPointName: index % 4 === 0 ? "KOVIA" : "DANDA",
  customerName: assignedNames[index],
  messengerId: index % 3 === 0 ? "m2" : "m1",
  status: index % 2 === 0 ? "call_pending" : "in_route",
  callOutcome: "pending"
})));

const state = {
  activeRole: "driver",
  cities: [{ id: "city-cali", name: "Cali", active: true }],
  zones: [], communities: [],
  sellers: [
    { id: "s-danda", name: "DANDA", shopDomain: "danda.myshopify.com", cityId: "city-cali", bankAccount: "" },
    { id: "s-kovia", name: "Kovia", shopDomain: "kovia.myshopify.com", cityId: "city-cali", bankAccount: "" }
  ],
  shopifyStores: [], storeWebhookConfigs: [], shopifyInstallRequests: [], shopifySyncIssues: [],
  drivers: [{ id: "d1", name: "Lider Demo", phone: "+573000000001", active: true }],
  messengers: [
    { id: "m1", leaderDriverId: "d1", name: "Mensajero VD", phone: "+573000000002", active: true, createdAt: now, updatedAt: now },
    { id: "m2", leaderDriverId: "d1", name: "Mensajero Sur", phone: "+573000000003", active: true, createdAt: now, updatedAt: now }
  ],
  pickupBatches: [], suppliers: [], productCatalog: [], inventory: [], orders,
  wallet: [], settlements: [], payouts: [], audit: [], cashSnapshots: [],
  settings: { activeCityId: "city-cali", sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000, driverDeliveredPayCop: 9000, driverFailedPayCop: 9000, pendingReserveCop: 9000, debtBlockDays: 7, failedRateAlertPercent: 30, payoutDays: [] }
};
const session = { id: "u-d1", email: "lider@demo.local", name: "Lider Demo", role: "driver", profileId: "d1" };

async function shoot(width, height, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: width < 500 ? 2 : 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(([s, sess]) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("ultima-milla-mvp-state", s);
      localStorage.setItem("kentro-session", sess);
      sessionStorage.setItem("seeded", "1");
    }
  }, [JSON.stringify(state), JSON.stringify(session)]);
  await page.goto(base, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Despacho" }).first().click().catch(async () => { await page.getByText("Despacho", { exact: true }).first().click(); });
  await page.waitForTimeout(1500);
  if (process.env.PEEK === "1") { console.log((await page.locator("body").innerText()).slice(0, 1500)); console.log(errors); await page.screenshot({ path: `${out}/peek-${label}.png` }); }
  const heading = page.getByRole("heading", { name: "Recogidos pendientes de mensajero" });
  await heading.waitFor({ timeout: 60000 });
  const panel = heading.locator("xpath=../..");
  await panel.scrollIntoViewIfNeeded();

  // 1. Sin buscar: orden por KNT.
  await panel.screenshot({ path: `${out}/039-${label}-1-orden.png` });
  const firstCodes = await panel.locator("label span.font-semibold").allTextContents();

  // 2. Marcar uno, buscar otro: la seleccion sigue y se avisa de lo oculto.
  await panel.getByText("KNT-008384").click();
  await panel.getByPlaceholder("KNT, cliente o tienda").fill("garcia");
  await panel.screenshot({ path: `${out}/039-${label}-2-busqueda.png` });
  const afterSearch = await panel.locator("label span.font-semibold").allTextContents();

  // 3. Buscar por tienda y seleccionar los que coinciden.
  await panel.getByPlaceholder("KNT, cliente o tienda").fill("kovia");
  await panel.getByRole("button", { name: /que coinciden/ }).click();
  await panel.screenshot({ path: `${out}/039-${label}-3-tienda.png` });
  const assignLabel = await panel.getByRole("button", { name: /Asignar seleccionados/ }).textContent();

  // 4. Sin resultados.
  await panel.getByPlaceholder("KNT, cliente o tienda").fill("zzz");
  await panel.screenshot({ path: `${out}/039-${label}-4-vacio.png` });

  // 5. Asignar: sale todo lo marcado (1 + 5 de Kovia = 6) aunque la busqueda no muestre ninguno.
  await panel.getByRole("button", { name: /Asignar seleccionados/ }).click();
  await panel.getByPlaceholder("KNT, cliente o tienda").fill("");
  const remaining = await panel.locator("label span.font-semibold").count();
  const totalLabel = await panel.getByRole("button", { name: /Asignar toda la recogida/ }).textContent();
  await panel.screenshot({ path: `${out}/039-${label}-5-asignado.png` });

  console.log(JSON.stringify({ label, firstCodes, afterSearch, assignLabel, totalLabel, remainingOnPage: remaining, errors }, null, 1));
  await browser.close();
}

async function shootReassign(width, height, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: width < 500 ? 2 : 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(([s, sess]) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("ultima-milla-mvp-state", s);
      localStorage.setItem("kentro-session", sess);
      sessionStorage.setItem("seeded", "1");
    }
  }, [JSON.stringify(state), JSON.stringify(session)]);
  await page.goto(base, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Despacho" }).first().click().catch(async () => { await page.getByText("Despacho", { exact: true }).first().click(); });
  const heading = page.getByRole("heading", { name: "Asignados a mensajero" });
  await heading.waitFor({ timeout: 60000 });
  const panel = heading.locator("xpath=../..");
  await panel.scrollIntoViewIfNeeded();
  const codesOf = () => panel.locator("label span.font-semibold").allTextContents();

  await panel.screenshot({ path: `${out}/039-e1-${label}-1-orden.png` });
  const firstCodes = await codesOf();

  // Marcar uno, buscar por mensajero: la seleccion sigue y se cuenta lo oculto.
  await panel.getByText("KNT-008575").click();
  await panel.getByPlaceholder("KNT, cliente, tienda o mensajero").fill("sur");
  await panel.screenshot({ path: `${out}/039-e1-${label}-2-mensajero.png` });
  const bySur = await codesOf();

  // Buscar por cifras y seleccionar el que coincide.
  await panel.getByPlaceholder("KNT, cliente, tienda o mensajero").fill("8612");
  await panel.getByRole("button", { name: /coincide/ }).click();
  const reassignLabel = await panel.getByRole("button", { name: /Reasignar seleccionados/ }).textContent();
  const returnLabel = await panel.getByRole("button", { name: /Devolver a pendientes/ }).textContent();
  await panel.screenshot({ path: `${out}/039-e1-${label}-3-seleccion.png` });

  // Devolver a pendientes: salen los 2 marcados aunque solo se vea uno.
  await panel.getByRole("button", { name: /Devolver a pendientes/ }).click();
  await panel.getByPlaceholder("KNT, cliente, tienda o mensajero").fill("");
  await page.waitForTimeout(500);
  const recogidos = page.getByRole("heading", { name: "Recogidos pendientes de mensajero" }).locator("xpath=../..");
  const totalPending = await recogidos.getByRole("button", { name: /Asignar toda la recogida/ }).textContent();
  await panel.screenshot({ path: `${out}/039-e1-${label}-4-devueltos.png` });

  console.log(JSON.stringify({ label, firstCodes, bySur, reassignLabel, returnLabel, totalPendingAfterReturn: totalPending, errors }, null, 1));
  await browser.close();
}

(async () => {
  if (process.env.ONLY !== "e1") {
    await shoot(375, 812, "movil");
    await shoot(1280, 900, "escritorio");
  }
  await shootReassign(375, 812, "movil");
  await shootReassign(1280, 900, "escritorio");
})().catch((error) => { console.error(error); process.exit(1); });
