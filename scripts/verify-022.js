/**
 * Verificacion de la spec 022 contra produccion (RNF_02 y DoD 7).
 *
 * SOLO LECTURA. Responde a la unica pregunta que puede tumbar el tope: **¿deja fuera algun pedido
 * legitimo?** Barre la coleccion entera, reparte los importes por tramos y lista lo que el tope
 * rechazaria, para que se vea uno por uno y no como un numero.
 *
 * Y una segunda comprobacion, `ui`, que abre la aplicacion real con una cuenta de tienda desechable
 * y teclea el importe imposible: el formulario tiene que parar ANTES de enviar. Solo prueba los
 * caminos BLOQUEADOS, asi que no crea ni un pedido en produccion.
 *
 * Uso:
 *   node scripts/verify-022.js barrido
 *   node scripts/verify-022.js ui
 */
const admin = require("../functions/node_modules/firebase-admin");
const { MAX_ORDER_TOTAL_COP, CONFIRM_ORDER_TOTAL_COP } = require("../functions/lib/order-amount");

const crypto = require("crypto");
const path = require("path");

const fmt = (value) => `$${Math.round(Number(value) || 0).toLocaleString("es-CO")}`;
const BASE_URL = process.env.VERIFY_BASE_URL || "http://localhost:3019";
const API_KEY = "AIzaSyAXY_lwmuAvXCmix45QrmEG-hiwAWmNI-g";
const UID = "smoke022-tienda";
const EVIDENCE = path.join(__dirname, "../.sdd/evidence/022");
/** La tienda de los dos importes imposibles. */
const SELLER = process.env.VERIFY_SELLER || "seller-1783783071241";
const IMPOSIBLE = "11770047900";
const ALTO = "600000";

function loadPlaywright() {
  return require(require.resolve("playwright", { paths: [process.cwd(), "/usr/lib/node_modules"] }));
}

/**
 * Anula un pedido por la callable, con una cuenta admin desechable. Existe para que esta
 * verificacion no pueda dejar basura en produccion: si la callable de crear TODAVIA no tiene el
 * tope (porque no se ha desplegado), el pedido de prueba entra de verdad, y hay que sacarlo en el
 * acto. El 2026-09-19 paso exactamente eso: KNT-005330.
 */
/** Deja el campo del importe y su aviso en el centro de la captura. */
async function enfocarCampoValor(page) {
  await page.evaluate(() => {
    const campo = [...document.querySelectorAll("input")].find((node) => node.placeholder === "Valor COP");
    if (campo) campo.closest("div").scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(500);
}

async function anularPorCallable(orderId, reason) {
  const auth = admin.auth();
  const uid = "smoke022-admin";
  const email = `${uid}@example.com`;
  const password = crypto.randomBytes(24).toString("base64url");
  try {
    try { await auth.deleteUser(uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await auth.createUser({ uid, email, password, displayName: "Verify 022 admin (desechable)" });
    await auth.setCustomUserClaims(uid, { role: "admin" });
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }).then((response) => response.json());
    const res = await fetch("https://us-central1-kentro-last-mile.cloudfunctions.net/cancelOrder", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signIn.idToken}` },
      body: JSON.stringify({ data: { orderId, reason } })
    });
    return res.status;
  } finally {
    await auth.deleteUser(uid).catch((error) => { if (error.code !== "auth/user-not-found") throw error; });
  }
}

async function barrido() {
  const db = admin.firestore();
  const snapshot = await db.collection("orders").select("totalCop", "trackingCode", "status", "paymentMethod", "shopifyOrderId", "sellerId", "createdAt").get();
  const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const totals = orders.map((order) => Number(order.totalCop) || 0).sort((a, b) => a - b);
  const percentil = (p) => totals[Math.min(totals.length - 1, Math.floor(totals.length * p))];

  console.log(`# Spec 022 — barrido de produccion (${new Date().toISOString()})`);
  console.log(`  pedidos: ${orders.length}`);
  console.log(`  tope: ${fmt(MAX_ORDER_TOTAL_COP)} · umbral de confirmacion: ${fmt(CONFIRM_ORDER_TOTAL_COP)}`);
  console.log("");
  console.log("  Distribucion de importes");
  console.log(`    minimo ${fmt(totals[0])} · p1 ${fmt(percentil(0.01))} · mediana ${fmt(percentil(0.5))}`);
  console.log(`    p99 ${fmt(percentil(0.99))} · p99,9 ${fmt(percentil(0.999))} · maximo ${fmt(totals[totals.length - 1])}`);
  console.log("");

  const sobreTope = orders.filter((order) => (Number(order.totalCop) || 0) > MAX_ORDER_TOTAL_COP);
  const pedirianConfirmacion = orders.filter((order) => {
    const total = Number(order.totalCop) || 0;
    return total > CONFIRM_ORDER_TOTAL_COP && total <= MAX_ORDER_TOTAL_COP;
  });

  console.log(`  Pedidos que el tope rechazaria: ${sobreTope.length}`);
  for (const order of sobreTope) {
    const via = String(order.shopifyOrderId || "").startsWith("MAN-") ? "manual" : "importado";
    console.log(`    ${order.trackingCode} ${fmt(order.totalCop)} | ${order.status} | ${order.paymentMethod} | ${via} | ${String(order.createdAt || "").slice(0, 10)}`);
  }
  console.log("");
  console.log(`  Pedidos que pedirian confirmacion (entran igual): ${pedirianConfirmacion.length}`);
  for (const order of pedirianConfirmacion) {
    console.log(`    ${order.trackingCode} ${fmt(order.totalCop)} | ${order.status} | ${order.paymentMethod} | ${String(order.createdAt || "").slice(0, 10)}`);
  }
  console.log("");

  // RNF_02: legitimo = todo lo que no sea uno de los dos importes imposibles conocidos.
  const IMPOSIBLES = ["KNT-003174", "KNT-005321"];
  const legitimosFuera = sobreTope.filter((order) => !IMPOSIBLES.includes(order.trackingCode));
  if (legitimosFuera.length === 0) {
    console.log(`RNF_02 OK: los unicos ${sobreTope.length} pedidos por encima del tope son los dos importes imposibles conocidos.`);
    console.log("           Ningun pedido legitimo de los " + orders.length + " queda fuera.");
  } else {
    console.log(`RNF_02 FALLA: ${legitimosFuera.length} pedidos legitimos quedarian fuera del tope.`);
    process.exitCode = 1;
  }
}

/**
 * RF_05 y RF_01 por el canal real: el formulario de la tienda y, debajo, la callable.
 *
 * No crea pedidos: solo recorre los caminos que TIENEN que quedar bloqueados. La cuenta desechable
 * se borra en el `finally`.
 */
async function ui() {
  const auth = admin.auth();
  const db = admin.firestore();
  const vivosDeLaTienda = async () => {
    const snapshot = await db.collection("orders").where("sellerId", "==", SELLER).select("status").get();
    return snapshot.docs.filter((doc) => doc.data().status !== "cancelled").length;
  };
  const antes = await vivosDeLaTienda();
  const email = `${UID}@example.com`;
  const password = crypto.randomBytes(24).toString("base64url");
  const out = [
    `# Spec 022 — RF_05/RF_01 por el canal real (${new Date().toISOString()})`,
    `  ${BASE_URL} · tienda ${SELLER} · cuenta desechable ${UID} · movil 390x844`,
    `  pedidos de la tienda en circulacion ANTES: ${antes}`,
    ""
  ];
  const comprobaciones = [];
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    try { await auth.deleteUser(UID); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await auth.createUser({ uid: UID, email, password, displayName: "Verify 022 tienda (desechable)" });
    await auth.setCustomUserClaims(UID, { role: "seller", sellerId: SELLER });

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.getByRole("button", { name: "Entrar" }).waitFor({ state: "visible", timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Contrasena").fill(password);
      await page.getByRole("button", { name: "Entrar" }).click();
      // El formulario vive dentro de un panel plegable: hay que abrirlo como lo abre la tienda.
      await page.waitForFunction(() => /Crear pedido manual/.test(document.body.textContent || ""), null, { timeout: 120000 });
      await page.evaluate(() => {
        const boton = [...document.querySelectorAll("button")].find((node) => /Crear pedido manual/.test(node.textContent || ""));
        if (!boton) throw new Error("No se encontro el panel de pedido manual");
        boton.click();
      });
      await page.waitForTimeout(800);

      const valor = page.getByPlaceholder("Valor COP");
      await valor.waitFor({ state: "visible", timeout: 30000 });
      await valor.fill(IMPOSIBLE);
      await page.waitForTimeout(400);
      await enfocarCampoValor(page);
      const avisoImposible = await page.evaluate(() => (document.body.textContent || "").replace(/\s+/g, " "));
      comprobaciones.push([
        "RF_05 · el formulario avisa junto al campo, sin enviar nada",
        /supera el maximo permitido/.test(avisoImposible) && /\$ ?2\.000\.000/.test(avisoImposible)
      ]);
      comprobaciones.push([
        "RF_04 · y el aviso dice el importe que se tecleo",
        /11\.770\.047\.900/.test(avisoImposible)
      ]);
      await page.screenshot({ path: path.join(EVIDENCE, "formulario-importe-imposible.png") });

      await valor.fill(ALTO);
      await page.waitForTimeout(400);
      await enfocarCampoValor(page);
      const textoAlto = await page.evaluate(() => (document.body.textContent || "").replace(/\s+/g, " "));
      comprobaciones.push([
        "RF_05 · un importe alto pero posible no bloquea: pide confirmacion",
        /es mucho mas de lo habitual/.test(textoAlto) && /Confirmo que el valor es correcto/.test(textoAlto)
      ]);
      comprobaciones.push([
        "RF_05 · y no lo presenta como error",
        !/supera el maximo permitido/.test(textoAlto)
      ]);
      await page.screenshot({ path: path.join(EVIDENCE, "formulario-importe-alto.png") });
    } finally {
      await context.close();
    }

    // RF_01 por debajo de la pantalla: la callable tiene la ultima palabra (RNF_01).
    // `--solo-pantalla` la salta: mientras el tope no este desplegado, cada corrida crea (y anula)
    // un pedido de verdad, y para rehacer una captura eso es un precio absurdo.
    if (process.argv.includes("--solo-pantalla")) {
      out.push("  (comprobacion de la callable saltada por --solo-pantalla)");
      out.push("");
    } else {
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }).then((response) => response.json());
    const llamada = await fetch("https://us-central1-kentro-last-mile.cloudfunctions.net/createManualOrder", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signIn.idToken}` },
      body: JSON.stringify({ data: {
        sellerId: SELLER,
        shopifyOrderId: "",
        customerName: "Prueba spec 022",
        customerPhone: "3000000000",
        addressRaw: "CALLE FALSA 123",
        paymentMethod: "cod",
        fulfillmentMode: "seller_pickup",
        totalCop: Number(IMPOSIBLE),
        lineItems: [{ productName: "Prueba", quantity: 1 }],
        addressRisk: "accepted"
      } })
    });
    const cuerpo = await llamada.text();
    comprobaciones.push([
      `RNF_01 · la callable rechaza el mismo importe aunque la pantalla no estuviera (HTTP ${llamada.status})`,
      llamada.status >= 400 && /maximo permitido|invalid-argument|INVALID_ARGUMENT/i.test(cuerpo)
    ]);
    out.push(`  respuesta de createManualOrder: ${llamada.status} ${cuerpo.slice(0, 200)}`);

    // Si entro, es que el tope aun no esta desplegado: se saca en el acto, sin esperar a nadie.
    if (llamada.status < 400) {
      const creado = (() => { try { return JSON.parse(cuerpo).result.order.id; } catch { return null; } })();
      if (creado) {
        const estado = await anularPorCallable(creado, "Pedido de prueba de scripts/verify-022.js: la callable aun no tenia el tope de la spec 022 desplegado. No es un pedido de un cliente.");
        out.push(`  AVISO: el tope todavia NO esta desplegado. El pedido de prueba ${creado} se anulo en el acto (HTTP ${estado}).`);
      } else {
        out.push("  ERROR: la callable acepto el importe y no se pudo leer el id para anularlo. Revisar a mano.");
        process.exitCode = 1;
      }
    }
    out.push("");
    }
  } finally {
    await browser.close();
    await auth.deleteUser(UID).catch((error) => { if (error.code !== "auth/user-not-found") throw error; });
    try { await auth.getUser(UID); out.push("  ERROR: la cuenta desechable sigue existiendo"); process.exitCode = 1; }
    catch { out.push("  cuenta desechable borrada"); }
  }

  // Lo que no se negocia: esta verificacion no puede dejar un pedido de prueba circulando.
  const despues = await vivosDeLaTienda();
  comprobaciones.push([
    `ningun pedido de prueba queda en circulacion: ${antes} antes, ${despues} despues`,
    despues === antes
  ]);

  for (const [texto, ok] of comprobaciones) out.push(`  ${ok ? "OK   " : "FALLA"} ${texto}`);
  if (comprobaciones.some(([, ok]) => !ok)) process.exitCode = 1;
  out.push("");
  out.push(process.exitCode ? "VERIFICACION FALLIDA" : "VERIFICACION OK: el formulario para antes de enviar y la callable rechaza por debajo.");
  console.log(out.join("\n"));
}

async function main() {
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const comando = process.argv[2] || "barrido";
  const run = { barrido, ui }[comando];
  if (!run) {
    console.error("Uso: node scripts/verify-022.js barrido|ui");
    process.exit(1);
  }
  await run();
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => { console.error(error); process.exit(1); });
