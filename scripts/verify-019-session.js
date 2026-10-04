/**
 * Verificacion de la spec 019 POR EL CANAL DEL CLIENTE (DoD 9 y DoD 10).
 *
 * `scripts/verify-019.js` ya demostro la aritmetica, pero lo hizo con credenciales de admin (ADC) y
 * reproduciendo en node la escalera de `settlementOrderRow`. La auditoria de trazabilidad del
 * 2026-09-19 lo señalo: eso prueba la identidad, no la RUTA. Nunca se ejercio ni una vez lo que de
 * verdad falla en la calle — las reglas de Firestore con rol `driver` y la lectura por id de
 * pedidos fuera de ventana. La regla de oro 7 de `CLAUDE.md` nacio justo de ahi: un solo id ajeno
 * devuelve 403 y tumba el lote entero, y la perdida seria silenciosa.
 *
 * Este guion abre la aplicacion REAL en un navegador, con una sesion de lider logistico creada para
 * la prueba, y lee de la PANTALLA.
 *
 * Es una excepcion consciente a "solo lectura": crea una cuenta Auth desechable `smoke019-driver`
 * con los reclamos del lider (`role: driver`, `driverId`) y la borra en el `finally`. No escribe en
 * Firestore. Patron tomado de `scripts/verify-018.js`.
 *
 * Uso (con la app servida en VERIFY_BASE_URL, por defecto http://localhost:3019):
 *   node scripts/verify-019-session.js detalle
 *   node scripts/verify-019-session.js perf <etiqueta>
 */
const path = require("path");
const crypto = require("crypto");
const admin = require("../functions/node_modules/firebase-admin");

const SETTLEMENT = process.env.VERIFY_SETTLEMENT || "stl-1789686589616-driver-driver-1778271901513";
const DRIVER = process.env.VERIFY_DRIVER || "driver-1778271901513";
const BASE_URL = process.env.VERIFY_BASE_URL || "http://localhost:3019";
const UID = "smoke019-driver";
const RUNS = Number(process.env.PERF_RUNS || 5);
const EVIDENCE = path.join(__dirname, "../.sdd/evidence/019");

/** Los seis del cuadro de DANDA que salian en $0 en la pantalla del domiciliario. */
const RECLAMADOS = ["KNT-005077", "KNT-005058", "KNT-004892", "KNT-005064", "KNT-005054", "KNT-005060"];

const fmt = (value) => `$${Math.round(Number(value) || 0).toLocaleString("es-CO")}`;

function loadPlaywright() {
  return require(require.resolve("playwright", { paths: [process.cwd(), "/usr/lib/node_modules"] }));
}

/** Pasa "$98.900", "-$8.000 a favor" o "Sin importe" a numero (o `null` si no hay cifra). */
function parseCop(text) {
  const clean = (text || "").replace(/\s|a favor/g, "");
  if (!/\$/.test(clean)) return null;
  const negative = clean.startsWith("-");
  const digits = clean.replace(/[^\d]/g, "");
  if (!digits) return null;
  return (negative ? -1 : 1) * Number(digits);
}

async function withDisposableDriver(fn) {
  const auth = admin.auth();
  const email = `${UID}@example.com`;
  const password = crypto.randomBytes(24).toString("base64url");
  try {
    try { await auth.deleteUser(UID); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await auth.createUser({ uid: UID, email, password, displayName: "Verify 019 lider (desechable)" });
    await auth.setCustomUserClaims(UID, { role: "driver", driverId: DRIVER });
    return await fn({ email, password });
  } finally {
    await auth.deleteUser(UID).catch((error) => { if (error.code !== "auth/user-not-found") throw error; });
    try {
      await auth.getUser(UID);
      console.error("ERROR: la cuenta desechable sigue existiendo");
      process.exitCode = 1;
    } catch { /* borrada, que es lo que se quiere */ }
  }
}

async function login(browser, viewport, email, password, options = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  const started = await loginOn(page, email, password, options);
  return { context, page, consoleLines, started };
}

/** Entra en la aplicacion sobre una pagina ya creada. Devuelve el instante del clic en "Entrar". */
async function loginOn(page, email, password, { perf = false, url = BASE_URL } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  if (perf) await page.evaluate(() => window.localStorage.setItem("kentro-perf", "1"));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  // El formulario lo pinta React despues de hidratar: rellenarlo antes deja los campos vacios y
  // el navegador se queda en "Please fill out this field".
  await page.getByRole("button", { name: "Entrar" }).waitFor({ state: "visible", timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contrasena").fill(password);
  if (!(await page.getByLabel("Email").inputValue())) {
    await page.waitForTimeout(1500);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Contrasena").fill(password);
  }
  const started = Date.now();
  await page.getByRole("button", { name: "Entrar" }).click();
  return started;
}

/**
 * Primer pintado del lider: la vista de operacion con su cifra de cabecera. Es el momento que
 * protege RNF_01 — a partir de aqui el detalle se completa, pero la pantalla ya sirve.
 */
async function waitForFirstPaint(page) {
  await page.waitForFunction(() => {
    const text = document.body.textContent || "";
    return /Pendiente por entregar/.test(text) && /\$\s?[\d.]+/.test(text);
  }, null, { timeout: 120000 });
}

/** El panel financiero vive detras de "Finanzas" en el riel lateral. */
async function waitForFinancialPanel(page) {
  await waitForFirstPaint(page);
  await page.evaluate(() => {
    const node = [...document.querySelectorAll("button, a")].find((item) => (item.textContent || "").trim() === "Finanzas");
    if (!node) throw new Error("No se encontro el acceso a Finanzas en el riel");
    node.click();
  });
  await page.waitForFunction(() => {
    const text = document.body.textContent || "";
    return /Cortes/.test(text) && /Dinero entregado/.test(text) && /\$\s?[\d.]+/.test(text);
  }, null, { timeout: 120000 });
}

/**
 * Entra (si hace falta), va a Finanzas, abre el corte y espera a que el detalle termine de llegar.
 * El rescate por id va bajo demanda, asi que "terminado" es que el aviso deje de decir que se esta
 * completando.
 */
async function abrirDetalle(page, { email, password, expectedCashCop, yaDentro = false }) {
  if (!yaDentro) await loginOn(page, email, password);
  await waitForFinancialPanel(page);
  // La pantalla escribe "$ 14.167.490" con espacio: se compara sin espacios en blanco.
  const header = fmt(expectedCashCop).replace(/\s/g, "");
  await page.waitForFunction(
    (needle) => (document.body.textContent || "").replace(/\s/g, "").includes(needle),
    header,
    { timeout: 120000 }
  );
  await page.evaluate((needle) => {
    const card = [...document.querySelectorAll("button")].find(
      (node) => (node.textContent || "").replace(/\s/g, "").includes(needle)
    );
    if (!card) throw new Error("No se encontro la tarjeta del corte");
    card.click();
  }, header);
  // El rescate por id va bajo demanda: se espera a que el aviso deje de decir "Completando".
  await page.waitForFunction(() => !/Completando el detalle/.test(document.body.textContent || ""), null, { timeout: 180000 });
  await page.waitForTimeout(1500);
}

/** Las filas del detalle expandido, tal y como las ve el domiciliario. */
async function leerDetalle(page) {
  const detail = await page.evaluate(() => {
    const expanded = [...document.querySelectorAll("button[aria-expanded='true']")][0];
    const panel = expanded ? expanded.parentElement : null;
    if (!panel) return null;
    const rows = [...panel.querySelectorAll(":scope > div > div")].filter((node) => node.querySelector("span"));
    return {
      notice: (panel.querySelector("p[role='status']") || {}).textContent || "",
      rows: rows.map((node) => {
        const spans = [...node.querySelectorAll("span")];
        return {
          label: (spans[0] || {}).textContent || "",
          amount: (spans[1] || {}).textContent || "",
          // Segunda linea ENTERA: "COD $X · pago $Y" mas las pildoras ("Sin recaudo",
          // "Importe del corte"). Tomar solo `spans[2]` se dejaba las pildoras fuera.
          detail: (node.children[1] || {}).textContent || ""
        };
      })
    };
  });
  if (!detail) throw new Error("No se pudo leer el detalle expandido");
  return detail;
}

async function detalle() {
  const db = admin.firestore();
  const snapshot = await db.collection("settlements").doc(SETTLEMENT).get();
  if (!snapshot.exists) throw new Error(`No existe el corte ${SETTLEMENT}`);
  const settlement = snapshot.data();
  const expectedCashCop = Number(settlement.cashExpectedCop) || 0;
  const orderCount = (settlement.orderIds || []).length;

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const out = [
    `# Spec 019 — DoD 9: el detalle leido de la PANTALLA, con sesion de lider logistico`,
    `  ${new Date().toISOString()} · ${BASE_URL} · corte ${SETTLEMENT}`,
    `  cuenta desechable ${UID} con reclamos { role: "driver", driverId: "${DRIVER}" }`,
    ""
  ];
  try {
    await withDisposableDriver(async ({ email, password }) => {
      const { context, page, consoleLines } = await login(browser, { width: 1280, height: 900 }, email, password);
      try {
        await abrirDetalle(page, { email, password, expectedCashCop, yaDentro: true });
        const detail = await leerDetalle(page);

        const rows = detail.rows;
        const amounts = rows.map((row) => parseCop(row.amount));
        const sum = amounts.reduce((total, value) => total + (value || 0), 0);
        // Una fila en $0 solo es honesta si de verdad no movio dinero: sin recaudo y sin pago. La
        // que la spec persigue es la que sale en cero porque el pedido no estaba descargado.
        const ceros = rows.filter((row, index) => amounts[index] === 0);
        const cerosMentira = ceros.filter((row) => !/COD\s*\$\s*0(?!\d).*pago\s*\$\s*0(?!\d)/.test(row.detail.replace(/\s+/g, " ")));
        const internos = rows.filter((row) => /^ord-|^[a-zA-Z0-9]{20}$/.test(row.label.trim()));
        const sinImporte = rows.filter((row, index) => amounts[index] === null);
        const reclamados = RECLAMADOS.map((code) => {
          const row = rows.find((item) => item.label.trim() === code);
          return { code, amount: row ? parseCop(row.amount) : null };
        });

        out.push(`  Filas en pantalla:                ${rows.length}   (el corte tiene ${orderCount} pedidos)`);
        out.push(`  Cabecera (cashExpectedCop):       ${fmt(expectedCashCop)}`);
        out.push(`  Suma de las filas de PANTALLA:    ${fmt(sum)}`);
        out.push(`  Diferencia:                       ${fmt(sum - expectedCashCop)}`);
        out.push(`  Aviso del detalle:                ${detail.notice.trim().slice(0, 120)}`);
        out.push(`  Filas en $0:                      ${ceros.length} (de ellas, sin COD ni pago: ${ceros.length - cerosMentira.length})`);
        for (const row of cerosMentira) out.push(`    EN CERO SIN MOTIVO: ${row.label.trim()} · ${row.detail.trim().slice(0, 80)}`);
        out.push(`  Filas sin importe:                ${sinImporte.length}`);
        out.push(`  Filas con identificador interno:  ${internos.length}`);
        out.push("");
        out.push("  Los seis pedidos reclamados el 2026-09-19:");
        for (const item of reclamados) out.push(`    ${item.code}  ${item.amount === null ? "NO APARECE" : fmt(item.amount)}`);
        out.push(`    suma: ${fmt(reclamados.reduce((total, item) => total + (item.amount || 0), 0))}`);
        out.push("");

        const errores = [];
        if (rows.length !== orderCount) errores.push(`la pantalla pinta ${rows.length} filas y el corte tiene ${orderCount}`);
        if (sum !== expectedCashCop) errores.push(`la suma de pantalla (${fmt(sum)}) no es la cabecera (${fmt(expectedCashCop)})`);
        if (cerosMentira.length > 0) errores.push(`${cerosMentira.length} filas en $0 con dinero detras`);
        if (internos.length > 0) errores.push(`${internos.length} filas con identificador interno`);
        if (reclamados.some((item) => !item.amount)) errores.push("algun pedido reclamado sigue sin importe");

        // Regla de oro 7: lo que no puede pasar es que un id del corte sea denegado. Un id que NO es
        // un pedido (el asiento `cash_shortage` lleva el id del corte en `orderId`) tambien se
        // deniega, pero no roba ninguna fila: se anota aparte.
        const denegadas = consoleLines.filter((line) => /permission|insufficient|PERMISSION_DENIED/i.test(line));
        const orderIds = new Set(settlement.orderIds || []);
        const denegadasDelCorte = denegadas.filter((line) => [...orderIds].some((id) => line.includes(id)));
        out.push(`  Lecturas denegadas por las reglas: ${denegadas.length} (de pedidos del corte: ${denegadasDelCorte.length})`);
        for (const line of denegadas.slice(0, 5)) out.push(`    ${line.slice(0, 200)}`);
        if (denegadasDelCorte.length > 0) errores.push(`${denegadasDelCorte.length} pedidos del corte denegados por las reglas`);

        await page.screenshot({ path: path.join(EVIDENCE, "t11-detalle-1280.png"), fullPage: false });
        out.push("");
        out.push(errores.length === 0
          ? "VERIFICACION OK: el detalle de la PANTALLA suma la cabecera con una sesion real de lider logistico."
          : `VERIFICACION FALLIDA: ${errores.join("; ")}`);
        if (errores.length > 0) process.exitCode = 1;
      } catch (error) {
        await page.screenshot({ path: path.join(EVIDENCE, "t11-detalle-fallo.png"), fullPage: true }).catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
  }
  console.log(out.join("\n"));
}

/**
 * DoD 10 / RNF_01: el rescate NO retrasa el primer pintado.
 *
 * Se cronometra desde pulsar "Entrar" hasta que el panel financiero del lider muestra su primera
 * cifra, que es el momento que la spec protege. Mediana de `RUNS` cargas en frio (contexto nuevo por
 * carga). Con `kentro-perf` activo se recogen ademas las lineas del instrumento para dejar por
 * escrito cuantas lecturas se dispararon ANTES de expandir un corte.
 */
async function perf() {
  const label = process.argv[3] || "sin-etiqueta";
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const out = [
    `# Spec 019 — perf "${label}" (${new Date().toISOString()}) sobre ${BASE_URL}`,
    `  Lider logistico ${DRIVER} · cuenta desechable · mediana de ${RUNS} cargas en frio`,
    ""
  ];
  try {
    await withDisposableDriver(async ({ email, password }) => {
      for (const [name, viewport] of [["movil 390x844", { width: 390, height: 844 }], ["escritorio 1280x800", { width: 1280, height: 800 }]]) {
        const times = [];
        let pinLines = [];
        for (let index = 0; index < RUNS; index += 1) {
          const { context, page, consoleLines, started } = await login(browser, viewport, email, password, { perf: true });
          try {
            await waitForFinancialPanel(page);
            times.push(Date.now() - started);
            // RNF_01: antes del primer pintado no puede haberse disparado ningun rescate por id.
            pinLines = consoleLines.filter((line) => /Kentro perf/.test(line) && /fijados|tope de rescate/.test(line));
          } finally {
            await context.close();
          }
        }
        out.push(`- ${name}: mediana ${median(times)} ms · corridas ${times.join(", ")} ms`);
        out.push(`  rescates por id antes del primer pintado: ${pinLines.length}${pinLines.length ? ` (${pinLines.join(" | ")})` : ""}`);
      }
    });
  } finally {
    await browser.close();
  }
  console.log(out.join("\n"));
}

/**
 * DoD 10, comparacion honesta: A/B INTERCALADO.
 *
 * Medir el "antes" y el "despues" en tandas separadas dio +17 % en movil en una ronda y +16 % en
 * escritorio en la siguiente: la varianza de una maquina compartida es mayor que el efecto que se
 * quiere medir. Alternando carga a carga, cualquier deriva (red, CPU, Firestore) cae sobre las dos
 * ramas por igual y la comparacion vuelve a significar algo.
 *
 * Uso: VERIFY_BASE_URL=<despues> VERIFY_BASE_URL_B=<antes> node scripts/verify-019-session.js ab
 */
async function ab() {
  const urlB = process.env.VERIFY_BASE_URL_B;
  if (!urlB) throw new Error("Falta VERIFY_BASE_URL_B (la linea base)");
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const out = [
    `# Spec 019 — DoD 10 / RNF_01: A/B intercalado (${new Date().toISOString()})`,
    `  despues ${BASE_URL} · antes ${urlB} · lider ${DRIVER} · ${RUNS} pares por viewport`,
    `  Se cronometra desde pulsar "Entrar" hasta que la vista del lider muestra su cifra de cabecera.`,
    ""
  ];
  try {
    await withDisposableDriver(async ({ email, password }) => {
      for (const [name, viewport] of [["movil 390x844", { width: 390, height: 844 }], ["escritorio 1280x800", { width: 1280, height: 800 }]]) {
        const times = { despues: [], antes: [] };
        let pinLines = 0;
        for (let index = 0; index < RUNS; index += 1) {
          for (const [rama, url] of [["despues", BASE_URL], ["antes", urlB]]) {
            // Una carga lenta de mas no invalida la tanda: se reintenta y se descarta la fallida.
            // Con 28 cargas por corrida, un solo tropiezo tiraba la medicion entera.
            let intentos = 0;
            for (;;) {
              const { context, page, consoleLines, started } = await login(browser, viewport, email, password, { perf: true, url });
              try {
                await waitForFirstPaint(page);
                times[rama].push(Date.now() - started);
                if (rama === "despues") {
                  pinLines += consoleLines.filter((line) => /Kentro perf/.test(line) && /fijados|tope de rescate/.test(line)).length;
                }
                break;
              } catch (error) {
                intentos += 1;
                const visible = await page.evaluate(() => (document.body.textContent || "").slice(0, 300)).catch(() => "");
                console.error(`[ab] fallo ${rama} (${url}) intento ${intentos}: ${visible.replace(/\s+/g, " ").slice(0, 200)}`);
                console.error(`[ab] consola: ${consoleLines.slice(-4).join(" | ").slice(0, 400)}`);
                if (intentos >= 3) throw error;
              } finally {
                await context.close();
              }
            }
          }
        }
        const antes = median(times.antes);
        const despues = median(times.despues);
        const delta = ((despues - antes) / antes) * 100;
        out.push(`- ${name}: antes ${antes} ms · despues ${despues} ms · ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} %`);
        out.push(`    antes:   ${times.antes.join(", ")} ms`);
        out.push(`    despues: ${times.despues.join(", ")} ms`);
        out.push(`    rescates por id antes del primer pintado: ${pinLines}`);
        if (Math.abs(delta) > 10) process.exitCode = 1;
      }
    });
  } finally {
    await browser.close();
  }
  out.push("");
  out.push(process.exitCode ? "FUERA DEL MARGEN: alguna mediana se pasa del +/-10 % de la spec." : "DENTRO DEL MARGEN: ninguna mediana se pasa del +/-10 % y el primer pintado no dispara rescates.");
  console.log(out.join("\n"));
}

/**
 * Fase `verify`: un recorrido por historia de usuario, con traza, consola y red.
 *
 * Cada recorrido entra con su propia sesion y llega hasta donde llega el domiciliario: Finanzas ->
 * abrir el corte -> leer el detalle. Lo que cambia es lo que se mira al final.
 */
const HISTORIAS = [
  {
    id: "HU_01-RF_01-RF_03",
    titulo: "HU_01 · el detalle suma exactamente lo que dice la cabecera",
    comprobar: ({ rows, amounts, expectedCashCop, notice }) => {
      const suma = amounts.reduce((total, value) => total + (value || 0), 0);
      return [
        [`filas pintadas: ${rows.length}`, rows.length > 0],
        [`suma del detalle ${fmt(suma)} == cabecera ${fmt(expectedCashCop)}`, suma === expectedCashCop],
        [`el aviso lo dice: "${notice.trim().slice(0, 60)}"`, /coincide con el corte/.test(notice)]
      ];
    }
  },
  {
    id: "HU_02-RF_09-RF_10",
    titulo: "HU_02 · cada pedido con su KNT y su valor, por antiguo que sea",
    comprobar: ({ rows, amounts }) => {
      const conKnt = rows.filter((row) => /^KNT-\d+/.test(row.label.trim()));
      const internos = rows.filter((row) => /^shopify-|^ord-/.test(row.label.trim()));
      const sinImporte = amounts.filter((value) => value === null);
      // Los seis de DANDA son de fuera de la ventana de descarga: si salen, salen los antiguos.
      const antiguos = RECLAMADOS.map((code) => rows.find((row) => row.label.trim() === code));
      return [
        [`filas con codigo KNT: ${conKnt.length} de ${rows.length}`, conKnt.length === rows.length],
        [`filas con identificador interno: ${internos.length}`, internos.length === 0],
        [`filas sin importe: ${sinImporte.length}`, sinImporte.length === 0],
        [`los seis pedidos antiguos reclamados aparecen con importe`, antiguos.every((row) => row && /\$/.test(row.amount))]
      ];
    }
  },
  {
    id: "HU_03-RF_02-RF_04",
    titulo: "HU_03 · las visitas sin cobro y lo que se paga por ellas",
    // La captura tiene que enseñar una de esas filas, no el principio de la lista.
    enfoque: "Sin recaudo",
    comprobar: ({ rows, amounts }) => {
      const sinRecaudo = rows.filter((row) => /Sin recaudo/.test(row.detail));
      const aFavor = sinRecaudo.filter((row) => /a favor/.test(row.amount));
      const suma = sinRecaudo.reduce((total, row) => total + (parseCop(row.amount) || 0), 0);
      return [
        [`visitas sin recaudo marcadas con pildora: ${sinRecaudo.length}`, sinRecaudo.length > 0],
        [`su importe va a favor del domiciliario y lo dice con palabras: ${aFavor.length} de ${sinRecaudo.length}`, aFavor.length === sinRecaudo.length],
        [`suman ${fmt(suma)} (negativo: bajan lo que debe entregar)`, suma < 0],
        [`ninguna de ellas se aplasta a cero con dinero detras`, sinRecaudo.every((row) => (parseCop(row.amount) || 0) !== 0 || /COD\s*\$\s*0(?!\d).*pago\s*\$\s*0(?!\d)/.test(row.detail.replace(/\s+/g, " ")))],
        [`el total del detalle no se mueve: ${fmt(amounts.reduce((t, v) => t + (v || 0), 0))}`, true]
      ];
    }
  }
];

async function e2e() {
  const fs = require("fs");
  const db = admin.firestore();
  const snapshot = await db.collection("settlements").doc(SETTLEMENT).get();
  if (!snapshot.exists) throw new Error(`No existe el corte ${SETTLEMENT}`);
  const expectedCashCop = Number(snapshot.data().cashExpectedCop) || 0;

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const resumen = [`# Spec 019 — verificacion funcional por historia de usuario (${new Date().toISOString()})`, `  ${BASE_URL} · corte ${SETTLEMENT} · movil 390x844 · sesion de lider logistico desechable`, ""];
  try {
    await withDisposableDriver(async ({ email, password }) => {
      for (const historia of HISTORIAS) {
        const carpeta = path.join(EVIDENCE, historia.id);
        fs.mkdirSync(carpeta, { recursive: true });
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const consola = [];
        const red = [];
        let page;
        try {
          page = await context.newPage();
          page.on("console", (message) => consola.push(`[${message.type()}] ${message.text()}`));
          page.on("response", (response) => {
            if (response.status() >= 400) red.push(`${response.status()} ${response.url().slice(0, 200)}`);
          });
          await abrirDetalle(page, { email, password, expectedCashCop });
          const detalle = await leerDetalle(page);
          const amounts = detalle.rows.map((row) => parseCop(row.amount));
          const comprobaciones = historia.comprobar({ ...detalle, amounts, expectedCashCop });
          const fallos = comprobaciones.filter(([, ok]) => !ok);
          // La captura tiene que ENSEÑAR el detalle: en un movil queda muy por debajo del pliegue,
          // y una captura de pagina entera con 185 filas no se puede mirar.
          await page.evaluate((enfoque) => {
            if (enfoque) {
              const fila = [...document.querySelectorAll("span")].find((node) => (node.textContent || "").trim() === enfoque);
              if (fila) {
                fila.closest("div.grid").scrollIntoView({ block: "center" });
                return;
              }
            }
            const abierto = document.querySelector("button[aria-expanded='true']");
            if (abierto) abierto.scrollIntoView({ block: "start" });
          }, historia.enfoque || null);
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(carpeta, "pantalla.png"), fullPage: false });
          resumen.push(`## ${historia.titulo}`);
          for (const [texto, ok] of comprobaciones) resumen.push(`  ${ok ? "OK  " : "FALLA"} ${texto}`);
          // La spec contempla la lectura denegada (§5, "lectura fallida por red o permiso"). La
          // unica que aparece es un id que NO es un pedido: el asiento `cash_shortage` del lider
          // lleva el id del corte en `orderId` y la otra via del rescate lo pide. No roba ninguna
          // fila —el detalle sale completo— pero se deja anotada, no escondida.
          // Dos denegaciones estan contempladas y ninguna es de esta spec:
          //  - el id del corte pedido como si fuera un pedido (asiento `cash_shortage`),
          //  - `getSellerBalance`, la llamada vacia con la que la pantalla de entrada despierta la
          //    callable (spec 018, T18): sin sesion de tienda responde 403 por diseño.
          const esperada = (linea) => linea.includes(SETTLEMENT) || linea.includes("getSellerBalance");
          const erroresConsola = consola.filter((line) => /^\[error\]/.test(line));
          // El "Failed to load resource" de consola no nombra la url; si TODAS las peticiones
          // fallidas estan contempladas, sus ecos en consola tambien lo estan.
          const redInesperadaPrevia = red.filter((line) => !esperada(line));
          const erroresInesperados = erroresConsola.filter(
            (line) => !esperada(line) && !(/Failed to load resource/.test(line) && redInesperadaPrevia.length === 0)
          );
          const redInesperada = red.filter((line) => !esperada(line));
          resumen.push(`  errores de consola: ${erroresConsola.length} (inesperados: ${erroresInesperados.length}) · peticiones 4xx/5xx: ${red.length} (inesperadas: ${redInesperada.length})`);
          for (const linea of erroresInesperados.slice(0, 3)) resumen.push(`       ${linea.slice(0, 180)}`);
          for (const linea of redInesperada.slice(0, 3)) resumen.push(`       ${linea.slice(0, 180)}`);
          if (erroresInesperados.length > 0 || redInesperada.length > 0) process.exitCode = 1;
          resumen.push("");
          fs.writeFileSync(path.join(carpeta, "consola.txt"), consola.join("\n") || "(sin mensajes)");
          fs.writeFileSync(path.join(carpeta, "red.txt"), red.join("\n") || "(ninguna peticion 4xx/5xx)");
          if (fallos.length > 0) process.exitCode = 1;
        } catch (error) {
          resumen.push(`## ${historia.titulo}`, `  FALLA el recorrido: ${String(error).slice(0, 200)}`, "");
          if (page) await page.screenshot({ path: path.join(carpeta, "fallo.png"), fullPage: true }).catch(() => {});
          process.exitCode = 1;
        } finally {
          await context.tracing.stop({ path: path.join(carpeta, "trace.zip") });
          await context.close();
        }
      }
    });
  } finally {
    await browser.close();
  }
  resumen.push(process.exitCode ? "VERIFICACION FUNCIONAL FALLIDA" : "VERIFICACION FUNCIONAL OK: los tres recorridos completos, sin errores de consola ni peticiones fallidas.");
  const texto = resumen.join("\n");
  require("fs").writeFileSync(path.join(EVIDENCE, "verify-e2e.txt"), texto);
  console.log(texto);
}

async function main() {
  admin.initializeApp({ projectId: "kentro-last-mile" });
  const command = process.argv[2];
  const run = { detalle, perf, ab, e2e }[command];
  if (!run) {
    console.error("Uso: node scripts/verify-019-session.js detalle|perf <etiqueta>|ab|e2e");
    process.exit(1);
  }
  await run();
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
