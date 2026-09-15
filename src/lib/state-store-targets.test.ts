/**
 * T14 · RF_15, RF_16, RNF_03 — que baja el navegador de una cuenta con los DOS papeles.
 *
 * Liderar una comunidad no es un rol: viaja aparte del `role`. Por eso una misma cuenta puede ser
 * tienda (o domiciliario, o mensajero) y ademas lider. `state-store.ts` decide que se descarga en
 * CINCO sitios y los cinco ramifican por `context.role` con retornos anticipados, asi que para un
 * vendedor-lider gana siempre la rama de vendedor y la de comunidad no llega a ejecutarse nunca.
 *
 * Eso NO falla ni avisa: la app arranca, pinta, y el "pagado" del lider sale en cero porque sale
 * de `state.settlements` y los cortes `kind: "community_leader"` no se pidieron. Es exactamente el
 * fallo del principio 8 de la constitucion, el que ya costo $1.135.720 en silencio, y ademas la
 * divergencia carga-inicial/listener que el CLAUDE.md avisa: la suscripcion y la carga inicial son
 * dos sitios distintos y hay que tocar los dos.
 *
 * ## Por que esto se prueba leyendo la FUENTE
 *
 * `state-store.ts` importa el SDK de Firebase, asi que no se puede importar desde una prueba (el
 * entorno de Vitest es `node`). Se lee COMO TEXTO, igual que el bloque `T42 · RNF_01` de
 * `community-cashback-entries.test.ts`, con lo que eso implica: si alguien reescribe un bloque con
 * otra forma sintactica, estas pruebas se ponen rojas sin que nada este mal. Se acepta a proposito
 * — un falso rojo que obliga a mirar la consulta es barato comparado con el fallo real, que es
 * mudo. Cada `expect` negativo lleva al lado un POSITIVO sobre el mismo extractor, para que un
 * extractor roto (una funcion renombrada, un bloque movido) no deje pasar la prueba en vacio.
 *
 * Si un dia los descriptores de objetivos por rol salen a un modulo puro, estas guardas de fuente
 * se sustituyen por pruebas de verdad sobre ese modulo. Esa es la propuesta, no esta tarea.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FUENTE = readFileSync(fileURLToPath(new URL("./firebase/state-store.ts", import.meta.url)), "utf8");

/** La consulta de los cortes del lider: de ahi sale el cashback PAGADO. Es LA cifra de dinero. */
const CORTES_DE_COMUNIDAD = /where\(\s*"kind",\s*"==",\s*"community_leader"\s*\)/;

/** Los cortes del vendedor: la cifra de dinero del otro papel de la misma cuenta. */
const CORTES_DE_VENDEDOR = /where\(\s*"kind",\s*"==",\s*"seller"\s*\)/;

/**
 * "Se juntan las dos", en cualquiera de las formas que este repo ya usa. Lo contrario —elegir una
 * y devolverla— es el retorno anticipado que se lleva por delante la mitad del dinero.
 */
const UNION = /mergeById\(|Promise\.all\(|\.concat\(|\.\.\./;

function cuerpoDeFuncion(firma: string): string {
  const inicio = FUENTE.indexOf(firma);
  expect(inicio, `no se encontro "${firma}" en state-store.ts; cambio de nombre, actualizar esta prueba`).toBeGreaterThan(-1);
  const fin = FUENTE.indexOf("\n}", inicio);
  expect(fin, `no se encontro el cierre de "${firma}"`).toBeGreaterThan(inicio);
  return FUENTE.slice(inicio, fin);
}

/** El bloque de `subscribeFirestoreState` que decide QUE consultas se abren. */
function bloqueDeObjetivos(): string {
  const cuerpo = cuerpoDeFuncion("export function subscribeFirestoreState");
  const inicio = cuerpo.indexOf("const targets");
  const fin = cuerpo.indexOf("const watchedKeys");
  expect(inicio, "no se encontro la declaracion de `targets` en subscribeFirestoreState").toBeGreaterThan(-1);
  expect(fin, "no se encontro el final del bloque de objetivos (const watchedKeys)").toBeGreaterThan(inicio);
  return cuerpo.slice(inicio, fin);
}

/** El `Promise.all` de `loadFirestoreState`: el PRIMER pintado, el otro sitio de la divergencia. */
function bloqueDeCargaInicial(): string {
  const cuerpo = cuerpoDeFuncion("export async function loadFirestoreState");
  const inicio = cuerpo.indexOf("await Promise.all([");
  const fin = cuerpo.indexOf("\n  ]);", inicio);
  expect(inicio, "no se encontro el Promise.all de loadFirestoreState").toBeGreaterThan(-1);
  expect(fin, "no se encontro el cierre del Promise.all de loadFirestoreState").toBeGreaterThan(inicio);
  return cuerpo.slice(inicio, fin);
}

function bloqueDelContexto(): string {
  const inicio = FUENTE.indexOf("export type FirestoreStateContext = {");
  expect(inicio, "FirestoreStateContext cambio de nombre; actualizar esta prueba").toBeGreaterThan(-1);
  const fin = FUENTE.indexOf("};", inicio);
  expect(fin, "no se encontro el cierre de FirestoreStateContext").toBeGreaterThan(inicio);
  return FUENTE.slice(inicio, fin);
}

/**
 * El nombre del campo por el que viaja el vinculo con la comunidad. Sin el, `state-store.ts` no
 * tiene forma de saber que la cuenta lidera: `role` dice "seller" y nada mas.
 */
function campoDelVinculo(): string {
  const encontrado = bloqueDelContexto().match(/^\s*(\w*(?:community|comunidad)\w*)\??\s*:/im);
  expect(
    encontrado?.[1],
    "FirestoreStateContext no lleva el vinculo con la comunidad: con solo `role` y `profileId` no hay manera de distinguir un vendedor de un vendedor que ademas lidera"
  ).toBeTruthy();
  return encontrado?.[1] ?? "";
}

function ventana(bloque: string, patron: RegExp, antes: number, despues: number): string {
  const encontrado = bloque.match(patron);
  const indice = encontrado?.index ?? -1;
  expect(indice, `no se encontro ${String(patron)} en el bloque`).toBeGreaterThan(-1);
  return bloque.slice(Math.max(0, indice - antes), indice + despues);
}

function anteriorA(bloque: string, patron: RegExp, antes: number): string {
  const encontrado = bloque.match(patron);
  const indice = encontrado?.index ?? -1;
  expect(indice, `no se encontro ${String(patron)} en el bloque`).toBeGreaterThan(-1);
  return bloque.slice(Math.max(0, indice - antes), indice);
}

/* ------------------------------------------------------------------------------------------ */

describe("T14 · RNF_03: el sombrero no llega hasta aqui", () => {
  /**
   * El caso mas facil de escribir y de los mas valiosos. Si el sombrero entrara en la decision de
   * descarga pasarian dos cosas, las dos malas: cambiar de sombrero volveria a suscribir (adios al
   * "cero documentos leidos" de RNF_03) y la decision de QUE datos se traen quedaria en manos de
   * la interfaz, que es justo lo que RNF_02 prohibe.
   */
  it("RNF_03: `state-store.ts` no menciona el sombrero por ningun lado", () => {
    expect(FUENTE, "el sombrero es estado de interfaz: si aparece aqui, cambiarlo dispara descarga").not.toMatch(/\bhats?\b/i);
    expect(FUENTE).not.toMatch(/sombrero/i);
    expect(FUENTE).not.toMatch(/session-hats/);
    expect(FUENTE).not.toMatch(/activeHat|selectedHat|currentHat|hatActivo/i);
    // Positivo de control del mismo extractor: el fichero SI se leyo y SI decide por el contexto.
    expect(FUENTE).toContain("FirestoreStateContext");
    expect(FUENTE).toContain("context?.role");
  });

  it("RNF_03: el contexto de descarga tampoco lleva el sombrero activo", () => {
    const contexto = bloqueDelContexto();
    expect(contexto, "si el sombrero viaja en el contexto, cada cambio rehace las suscripciones").not.toMatch(/\bhat\b/i);
    // Positivo de control: el bloque extraido es de verdad el tipo del contexto.
    expect(contexto).toContain("role: Role;");
    expect(contexto).toContain("profileId: string;");
  });

  it("RF_22: la descarga de los cortes no se filtra por la posicion, solo por el vinculo", () => {
    // A un acreedor se le sigue debiendo. Filtrar por `communityStanding === "leader"` le esconderia
    // el cobro justo el dia que se le retira el papel: cifra a cero, en silencio, otra vez.
    expect(FUENTE).not.toMatch(/communityStanding/);
    expect(FUENTE).not.toMatch(/"creditor"/);
    // Positivo de control: los cortes de comunidad SI se nombran en el fichero.
    expect(FUENTE).toMatch(/community_leader/);
  });
});

describe("T14 · RF_15: la suscripcion de una cuenta con los dos papeles", () => {
  it("RF_15: los objetivos de comunidad se AÑADEN a los del papel operativo", () => {
    const objetivos = bloqueDeObjetivos();
    expect(
      objetivos,
      "no hay ninguna union: los objetivos de comunidad tienen que sumarse a los del rol, no ser una rama mas de la cadena de ternarios que solo gana cuando el rol es community_leader"
    ).toMatch(/(\.\.\.|\.concat\()[\s\S]{0,80}?([Cc]ommunity|[Cc]omunidad)/);
    // Positivo de control: el extractor trajo el bloque bueno, donde ya se suman los pedidos.
    expect(objetivos).toMatch(/\.\.\.orderTargets\(/);
  });

  it("RF_15: la decision consulta el VINCULO con la comunidad, no solo el rol", () => {
    const objetivos = bloqueDeObjetivos();
    const vinculo = campoDelVinculo();
    expect(
      objetivos,
      `los objetivos no miran "${vinculo}": con solo \`role\` un vendedor-lider entra por la rama de vendedor y sus cortes de comunidad no se piden jamas`
    ).toMatch(new RegExp(`${vinculo}\\b|(\\.\\.\\.|\\.concat\\()[\\s\\S]{0,80}?([Cc]ommunity|[Cc]omunidad)`));
    // Positivo de control.
    expect(objetivos).toContain('key: "settlements"');
  });

  it("RF_15: sumar la comunidad no le quita nada al papel operativo", () => {
    // Principio 8 al reves: al abrir la puerta de la comunidad es facil pisar lo que ya bajaba el
    // vendedor. Su wallet pendiente y sus cortes son cifras de dinero de la MISMA pantalla.
    const objetivos = bloqueDeObjetivos();
    expect(objetivos).toMatch(/\.\.\.orderTargets\(where\("sellerId", "==", context\.profileId\)\)/);
    expect(objetivos).toContain('where("ownerType", "==", "seller")');
    expect(objetivos).toMatch(CORTES_DE_VENDEDOR);
    expect(objetivos).toContain('key: "payouts"');
    // ...y tampoco al domiciliario, que es el otro papel que puede liderar.
    expect(objetivos).toContain('where("ownerType", "==", "driver")');
    expect(objetivos).toMatch(/where\(\s*"kind",\s*"==",\s*"driver"\s*\)/);
  });

  it("RF_15: un lider sin papel operativo sigue recibiendo sus cortes y nada mas", () => {
    // El caso limite de la union: quien SOLO lidera no puede caer en la rama por defecto, que es
    // la del admin (colecciones enteras y un 403 con la pantalla en blanco).
    const objetivos = bloqueDeObjetivos();
    expect(objetivos).toMatch(/role === "community_leader"/);
    expect(objetivos).toMatch(CORTES_DE_COMUNIDAD);
  });
});

describe("T14 · RF_16: como mucho la suma, nunca mas", () => {
  it("RF_16: el papel de comunidad aporta cortes y nada mas: cero pedidos, cero asientos", () => {
    // Lo que aporta la comunidad es UN objetivo. Si aqui aparecieran pedidos o wallet, la cuenta
    // con dos papeles pasaria de "la suma" a "la suma por tienda de la comunidad" (T42: 10.000
    // documentos con 10.000 pedidos, creciendo para siempre).
    const objetivos = bloqueDeObjetivos();
    const alrededor = ventana(objetivos, CORTES_DE_COMUNIDAD, 200, 160);
    expect(alrededor).toContain('key: "settlements"');
    expect(alrededor).not.toContain('key: "orders"');
    expect(alrededor).not.toContain('key: "wallet"');
    expect(alrededor).not.toContain("orderTargets(");
    expect(alrededor).not.toContain('key: "inventory"');
    expect(alrededor).not.toContain('key: "productCatalog"');
    // Positivo de control: los mismos literales SI aparecen en el bloque completo.
    expect(objetivos).toContain('key: "orders"');
    expect(objetivos).toContain('key: "wallet"');
  });

  it("RF_16: la consulta de los cortes del lider esta escrita UNA sola vez en la suscripcion", () => {
    // Repetirla en cada rama de rol da el mismo resultado en ejecucion y una bomba de relojeria en
    // el codigo: el dia que cambie, cambiara en una sola de las copias.
    const objetivos = bloqueDeObjetivos();
    const veces = objetivos.match(new RegExp(CORTES_DE_COMUNIDAD.source, "g"))?.length ?? 0;
    expect(veces, "la consulta de cortes de comunidad esta duplicada en varias ramas de rol").toBe(1);
  });

  it("RF_16: liderar no abre ni una consulta de pedidos ni de asientos", () => {
    const pedidos = cuerpoDeFuncion("async function getOrdersForContext");
    const wallet = cuerpoDeFuncion("async function getWalletForContext");
    expect(pedidos).not.toContain('where("communityId"');
    expect(wallet).not.toContain('where("communityId"');
    expect(wallet).not.toContain('"community_cashback"');
    // Positivos de control: los dos cuerpos son los buenos y siguen trayendo lo operativo.
    expect(pedidos).toContain('where("sellerId", "==", context.profileId)');
    expect(wallet).toContain('where("ownerType", "==", "seller")');
  });
});

describe("T14 · RF_15: el primer pintado tiene que decir lo mismo que el listener", () => {
  it("RF_15: la carga inicial tiene un predicado del vinculo, como ya lo tiene la tienda", () => {
    // `storeRole` existe porque seller y seller_logistics comparten descarga. El vinculo con la
    // comunidad necesita lo mismo: lo consultan la comunidad propia, sus tiendas y sus cortes.
    const carga = cuerpoDeFuncion("export async function loadFirestoreState");
    expect(carga).toContain("const storeRole =");
    expect(
      carga,
      "loadFirestoreState no deriva el vinculo con la comunidad: decide todo por `role` y para un vendedor-lider gana siempre la rama de vendedor"
    ).toMatch(/const\s+\w*(?:[Cc]ommunity|[Cc]omunidad)\w*\s*=/);
  });

  it("RF_15: la comunidad propia llega aunque el rol de la cuenta sea operativo", () => {
    // Sin el documento de la comunidad no hay precios congelados ni sobreprecio que pintar: la
    // pantalla de comunidad se queda sin la cifra de la que sale todo lo demas.
    const carga = bloqueDeCargaInicial();
    const vinculo = campoDelVinculo();
    const guarda = anteriorA(carga, /getOwnDocument<Community>\("communities"/, 240);
    expect(
      guarda,
      `la comunidad propia solo se pide cuando \`role === "community_leader"\`; con el vinculo (${vinculo}) tiene que pedirse tambien para un rol operativo`
    ).toContain(vinculo);
    // Positivo de control: el bloque extraido es el Promise.all de verdad.
    expect(carga).toContain('getCollection<City>("cities")');
  });

  it("RF_15: las tiendas de la comunidad se suman a la tienda propia, no la sustituyen", () => {
    // Las dos cosas son necesarias a la vez: sin la propia, el vendedor-lider pierde su tienda (y
    // con ella su saldo); sin las de la comunidad, el desglose por tienda del panel sale vacio. Y
    // si su tienda no pertenece a su comunidad, elegir una rama pierde una de las dos seguro.
    const carga = bloqueDeCargaInicial();
    const alrededor = ventana(carga, /getCollection<Seller>\("sellers", where\("communityId"/, 260, 260);
    expect(
      alrededor,
      "las tiendas de la comunidad y la tienda propia estan en ramas excluyentes de un ternario: para una cuenta con los dos papeles solo llega una de las dos"
    ).toMatch(UNION);
  });

  it("RF_15: la carga inicial pide los mismos cortes que abre el listener", () => {
    // La trampa documentada del proyecto: son dos sitios y hay que tocar los dos. Si solo se toca
    // uno, el primer pintado y el listener muestran cifras distintas y nadie ve un error.
    expect(bloqueDeObjetivos()).toMatch(CORTES_DE_COMUNIDAD);
    expect(cuerpoDeFuncion("async function getSettlementsForContext")).toMatch(CORTES_DE_COMUNIDAD);
  });
});

describe("T14 · RF_15: las tres funciones que ramifican por rol", () => {
  /** La que toca el dinero: el "pagado" del lider sale de `state.settlements`. */
  it("RF_15: getSettlementsForContext trae los cortes de comunidad", () => {
    const cuerpo = cuerpoDeFuncion("async function getSettlementsForContext");
    expect(
      cuerpo,
      "getSettlementsForContext no tiene consulta de cortes `kind: community_leader`: el cashback PAGADO del lider sale en cero en el primer pintado"
    ).toMatch(CORTES_DE_COMUNIDAD);
    // Positivo de control: es el cuerpo bueno y conserva los cortes del vendedor.
    expect(cuerpo).toMatch(CORTES_DE_VENDEDOR);
  });

  it("RF_15: la rama de vendedor de getSettlementsForContext no es un retorno anticipado", () => {
    const cuerpo = cuerpoDeFuncion("async function getSettlementsForContext");
    expect(
      cuerpo,
      "la rama de vendedor devuelve y corta: para una cuenta que ademas lidera, los cortes de comunidad no se piden nunca"
    ).not.toMatch(/role === "seller"\s*\)\s*\{?\s*return/);
    expect(
      cuerpo,
      "los cortes del vendedor y los del lider tienen que juntarse, no elegirse"
    ).toMatch(UNION);
    // Positivo de control.
    expect(cuerpo).toContain('getCollection<Settlement>("settlements"');
  });

  it("RF_15: lo mismo para el domiciliario, que es el otro papel que puede liderar", () => {
    const cuerpo = cuerpoDeFuncion("async function getSettlementsForContext");
    expect(
      cuerpo,
      "la rama de domiciliario devuelve y corta: un domiciliario-lider perderia sus cortes de comunidad"
    ).not.toMatch(/role === "driver"\s*\)\s*\{?\s*return/);
    // Positivo de control: sus propios cortes siguen ahi.
    expect(cuerpo).toMatch(/where\(\s*"kind",\s*"==",\s*"driver"\s*\)/);
  });

  it("RF_15: getWalletForContext no vacia la wallet de quien ademas lidera", () => {
    // El lider baja CERO asientos (T42), asi que el riesgo aqui es el contrario: que la rama de
    // comunidad gane y devuelva [] a un vendedor, borrandole el "pendiente por liquidar".
    const cuerpo = cuerpoDeFuncion("async function getWalletForContext");
    const posicionVendedor = cuerpo.indexOf('where("ownerType", "==", "seller")');
    const posicionDomiciliario = cuerpo.indexOf('where("ownerType", "==", "driver")');
    const posicionComunidad = cuerpo.indexOf("community_leader");
    expect(posicionVendedor).toBeGreaterThan(-1);
    expect(posicionComunidad, "la rama de comunidad se evalua antes que la del vendedor y le devuelve [] su wallet").toBeGreaterThan(posicionVendedor);
    expect(posicionComunidad, "la rama de comunidad se evalua antes que la del domiciliario").toBeGreaterThan(posicionDomiciliario);
    // Y el vacio del lider sigue siendo un vacio, no una consulta (RNF_01 de la spec 001).
    expect(cuerpo).toMatch(/community_leader[\s\S]{0,160}?return\s+(Promise\.resolve\(\s*\[\]\s*\)|\[\])/);
  });

  it("RF_15: getOrdersForContext no vacia los pedidos de quien ademas lidera", () => {
    const cuerpo = cuerpoDeFuncion("async function getOrdersForContext");
    // El corte de pedidos del lider tiene que seguir atado al ROL, no al vinculo: atarlo al
    // vinculo le quita los pedidos al vendedor-lider, y con ellos todo su dinero.
    expect(cuerpo).toMatch(/role === "community_leader"\)\s*return\s*\[\]/);
    expect(
      cuerpo,
      "un `return []` guardado por el vinculo con la comunidad deja sin pedidos al vendedor-lider"
    ).not.toMatch(/context\?\.\w*[Cc]ommunity\w*\s*\)?\s*\)?\s*return\s*\[\]/);
    // Positivo de control.
    expect(cuerpo).toContain('where("sellerId", "==", context.profileId)');
    expect(cuerpo).toContain('where("driverId", "==", context.profileId)');
  });
});

/**
 * =================================================================================================
 * T5 (spec 005) · La mitad de comunidad no puede tumbar la tienda propia. RF_01, RF_06, RF_02.
 *
 * Lo que DECIDE la union (que sale, en que orden, sin duplicar la tienda propia, y que se avisa
 * cuando falta la mitad de comunidad) se prueba por comportamiento en `load-status.test.ts`, sobre
 * el modulo puro. Aqui solo queda lo que ese modulo no puede ver desde dentro: que
 * `loadFirestoreState` lo USE, y que las dos mitades esten conectadas como dice el plan §3.2 —la de
 * comunidad envuelta para que un rechazo se convierta en `{ failed: true }`, la propia exigida.
 *
 * Vale lo que dice la cabecera de este archivo: son guardas de fuente, con su falso rojo posible, y
 * cada negativa lleva su positiva de control emparejada.
 * =================================================================================================
 */

/** La consulta de las tiendas de la comunidad: la mitad que produccion rechaza (plan §0, T1). */
const TIENDAS_DE_LA_COMUNIDAD = /getCollection<Seller>\("sellers", where\("communityId"/;

/** La peticion de la tienda propia: la mitad que NO es degradable. */
const TIENDA_PROPIA = 'getOwnDocument<Seller>("sellers"';

/** Donde acaba la entrada de `sellers` del `Promise.all` y empieza la siguiente. */
const SIGUIENTE_ENTRADA = 'skipped("shopifyStores"';

/** La entrada entera de `sellers`: las dos mitades y lo que las une. */
function tramoDeLasTiendas(): string {
  const carga = bloqueDeCargaInicial();
  const inicio = carga.indexOf(TIENDA_PROPIA);
  const fin = carga.indexOf(SIGUIENTE_ENTRADA, inicio);
  expect(inicio, `no se encontro ${TIENDA_PROPIA} en el Promise.all de loadFirestoreState`).toBeGreaterThan(-1);
  expect(fin, `no se encontro ${SIGUIENTE_ENTRADA}, que delimita el final de la entrada de sellers`).toBeGreaterThan(inicio);
  return carga.slice(inicio, fin);
}

/** Solo la mitad de comunidad: desde su consulta hasta el final de la entrada de `sellers`. */
function tramoDeLaComunidad(): string {
  const tiendas = tramoDeLasTiendas();
  const encontrado = tiendas.match(TIENDAS_DE_LA_COMUNIDAD);
  const inicio = encontrado?.index ?? -1;
  expect(inicio, "no se encontro la consulta de las tiendas de la comunidad en la entrada de sellers").toBeGreaterThan(-1);
  return tiendas.slice(inicio);
}

/** Solo la mitad propia: desde su peticion hasta la consulta de la comunidad. */
function tramoDeLaTiendaPropia(): string {
  const tiendas = tramoDeLasTiendas();
  const encontrado = tiendas.match(TIENDAS_DE_LA_COMUNIDAD);
  const fin = encontrado?.index ?? -1;
  expect(fin, "no se encontro la consulta de las tiendas de la comunidad en la entrada de sellers").toBeGreaterThan(0);
  return tiendas.slice(0, fin);
}

describe("T5 · RF_01, RF_06: la mitad de comunidad se degrada; la tienda propia, no", () => {
  it("RF_06: la union de las dos mitades la hace `mergeCommunitySellers`, no `mergeById`", () => {
    // El nucleo puro existe justamente para que la union y el parte se puedan probar por
    // comportamiento (`load-status.test.ts`): `state-store.ts` importa el SDK de Firebase y no se
    // puede importar desde una prueba. Si la union se quedara aqui, la unica verificacion posible
    // volveria a ser una regex.
    expect(
      FUENTE,
      "state-store.ts no importa mergeCommunitySellers de ../load-status: la union y el parte se quedan dentro del archivo que no se puede importar desde una prueba"
    ).toMatch(/import\s*(?:type\s*)?\{[^}]*\bmergeCommunitySellers\b[^}]*\}\s*from\s*"\.\.\/load-status"/);

    const tiendas = tramoDeLasTiendas();
    expect(tiendas, "la entrada de `sellers` no llama a mergeCommunitySellers").toContain("mergeCommunitySellers(");
    expect(
      tiendas,
      "las dos mitades de `sellers` se siguen uniendo con mergeById: esa union no sabe de partes, asi que un rechazo de la mitad de comunidad no puede avisarse"
    ).not.toContain("mergeById(");

    // Positivos de control: el extractor trajo el bloque bueno, y `mergeById` sigue existiendo para
    // lo suyo (pedidos, cortes) — esta prueba no pide borrarlo, solo sacarlo de aqui.
    expect(tiendas).toContain(TIENDA_PROPIA);
    expect(tiendas).toMatch(TIENDAS_DE_LA_COMUNIDAD);
    expect(FUENTE).toContain("function mergeById");
  });

  it("RF_06: la mitad de comunidad va envuelta y entrega `{ failed: true }` en vez de rechazar", () => {
    // Medido contra produccion (plan §0): esa consulta devuelve 403. Dentro de un `Promise.all` el
    // rechazo sube hasta el `Promise.all` general de 21 consultas y deja la pantalla sin tienda, sin
    // ciudades y sin ajustes. Envuelta, lo unico que falta es la mitad que fallo.
    const comunidad = tramoDeLaComunidad();
    expect(
      comunidad,
      "la consulta de las tiendas de la comunidad no esta envuelta: su rechazo sigue tumbando la carga entera"
    ).toMatch(/\.catch\(/);
    expect(
      comunidad,
      "la mitad de comunidad no entrega `{ failed: true }`: sin eso el parte no puede distinguir 'no hay tiendas' de 'no se pudo saber'"
    ).toMatch(/failed:\s*true/);

    // Positivo de control: el tramo extraido es el de la consulta de comunidad.
    expect(comunidad).toMatch(TIENDAS_DE_LA_COMUNIDAD);
  });

  it("RF_01: la tienda propia NO va envuelta: si falla, falla la carga", () => {
    // Es la asimetria de §3.2 y hay que protegerla en los dos sentidos. Tragarse tambien el fallo de
    // la tienda propia dejaria la pantalla de una tienda sin tienda y sin error: volveria el "Perfil
    // de vendedor pendiente" de siempre, ahora por la puerta de atras.
    const propia = tramoDeLaTiendaPropia();
    expect(
      propia,
      "la tienda propia esta envuelta en un .catch: un fallo suyo se convertiria en una lista vacia, y la pantalla lo leeria como un problema de configuracion de la cuenta"
    ).not.toMatch(/\.catch\(/);
    expect(propia, "la tienda propia no puede degradarse a `{ failed: true }`").not.toMatch(/failed:\s*true/);

    // Positivo de control: el tramo extraido es de verdad el de la tienda propia.
    expect(propia).toContain(TIENDA_PROPIA);
  });
});

/**
 * =================================================================================================
 * T10 (spec 005) · No regresion de los cinco papeles SIN comunidad. RNF_01, RNF_03.
 *
 * RNF_01: la referencia para tienda, logistico, domiciliario, mensajero y administrador sin vinculo
 * es "como se comportan hoy". T5 envolvio la mitad de comunidad de `sellers` y anadio `onReport`;
 * T8/T9 anadieron `onError` y el parte a `onState`. Nada de eso puede haber cambiado QUE baja una
 * cuenta sin vinculo ni haberle anadido una consulta que pueda fallar.
 *
 * Estas pruebas nacen en verde a proposito: caracterizan que nada cambio. Un rojo es regresion.
 *
 * LO QUE AQUI NO SE REPITE: que `FirestoreStateContext` no lleva el sombrero y que `state-store.ts`
 * no lo menciona ya lo fija "T14 · RNF_03: el sombrero no llega hasta aqui", arriba.
 * =================================================================================================
 */

/** Cuerpo de una funcion ANIDADA en `subscribeFirestoreState` (cierra con dos espacios de sangria). */
function cuerpoDeFuncionAnidada(firma: string): string {
  const inicio = FUENTE.indexOf(firma);
  expect(inicio, `no se encontro "${firma}" en state-store.ts`).toBeGreaterThan(-1);
  const fin = FUENTE.indexOf("\n  }", inicio);
  expect(fin, `no se encontro el cierre de "${firma}"`).toBeGreaterThan(inicio);
  return FUENTE.slice(inicio, fin);
}

/** Las ramas de `roleTargets()`, recortadas entre los ternarios por rol. */
function ramasDeRoleTargets(): Record<"driver" | "seller_logistics" | "seller" | "messenger" | "admin", string> {
  const cuerpo = cuerpoDeFuncionAnidada("function roleTargets(): TargetEntry[] {");
  const marca = (rol: string) => {
    const i = cuerpo.indexOf(`context?.role === "${rol}"`);
    expect(i, `roleTargets ya no ramifica por "${rol}"`).toBeGreaterThan(-1);
    return i;
  };
  const driver = marca("driver");
  const logistics = marca("seller_logistics");
  const seller = marca("seller");
  const leader = marca("community_leader");
  const messenger = marca("messenger");
  expect([driver, logistics, seller, leader, messenger]).toEqual([driver, logistics, seller, leader, messenger].slice().sort((a, b) => a - b));
  // La rama por defecto (admin) empieza en el ultimo `:` de la cadena, tras la del mensajero.
  const admin = cuerpo.lastIndexOf("\n          : [", cuerpo.length);
  expect(admin, "no se encontro la rama por defecto (admin) de roleTargets").toBeGreaterThan(messenger);
  return {
    driver: cuerpo.slice(driver, logistics),
    seller_logistics: cuerpo.slice(logistics, seller),
    seller: cuerpo.slice(seller, leader),
    messenger: cuerpo.slice(messenger, admin),
    admin: cuerpo.slice(admin)
  };
}

describe("T10 · RNF_01: los cinco papeles sin vinculo bajan lo mismo que hoy", () => {
  it.each([
    ["driver", 'where("driverId", "==", context.profileId)'],
    ["seller_logistics", 'where("sellerId", "==", context.profileId)'],
    ["seller", 'where("sellerId", "==", context.profileId)'],
    ["messenger", 'where("messengerId", "==", context.profileId)'],
    ["admin", "orderTargets(null)"]
  ] as const)("RNF_01: la rama de %s de roleTargets no mira la comunidad y sigue pidiendo lo suyo", (rol, positivo) => {
    const rama = ramasDeRoleTargets()[rol];
    // Positivo de control: la rama existe y sigue trayendo su consulta de siempre.
    expect(rama, `la rama de ${rol} ya no pide ${positivo}`).toContain(positivo);
    // La suma con la comunidad la hace `communityTargets()`, aparte. Si una rama de rol mirara
    // el vinculo, sumar la comunidad podria quitarle o anadirle algo a quien no tiene vinculo.
    expect(rama, `la rama de ${rol} mira communityId`).not.toMatch(/communityId/);
    expect(rama, `la rama de ${rol} llama a mergeCommunitySellers`).not.toMatch(/mergeCommunitySellers/);
    expect(rama).not.toMatch(/communityTargets\(/);
  });

  it("RNF_01: la comunidad se SUMA fuera de las ramas de rol, en communityTargets, y sin vinculo aporta cero", () => {
    const comunidad = cuerpoDeFuncionAnidada("function communityTargets(): TargetEntry[] {");
    expect(comunidad).toMatch(/if \(!ownerId\) return \[\];/);
    expect(comunidad).toMatch(CORTES_DE_COMUNIDAD);
    // Y la suscripcion las junta, no las elige (positivo de T14 "RF_15").
    expect(bloqueDeObjetivos()).toMatch(/\[\.\.\.roleTargets\(\), \.\.\.communityTargets\(\)\]/);
  });

  it("RNF_01: en loadFirestoreState la mitad de comunidad de `sellers` solo se pide con vinculo", () => {
    const tiendas = tramoDeLasTiendas();
    // Sin `communityId` no se pide (ni puede fallar, ni degradar el parte): una cuenta sin vinculo
    // no tiene forma de recibir un `{ failed: true }`.
    expect(
      tiendas,
      "la consulta de las tiendas de la comunidad ya no esta condicionada por `communityId`"
    ).toMatch(/communityId\s*\?\s*getCollection<Seller>\("sellers", where\("communityId"[\s\S]{0,160}?:\s*Promise\.resolve<Seller\[\]>\(\[\]\)/);
    // Positivo de control: la mitad propia sigue condicionada a `storeRole && context`, como hoy.
    // (`tramoDeLasTiendas` empieza EN `getOwnDocument`, asi que la guarda se mira en el bloque entero.)
    expect(bloqueDeCargaInicial()).toContain('storeRole && context ? getOwnDocument<Seller>("sellers", context.profileId)');
  });

  it("RNF_01: `onReport` y `onError` son OPCIONALES: los llamadores de siempre siguen compilando", () => {
    expect(FUENTE).toMatch(/onReport\?:\s*\(report: LoadReport\) => void/);
    const firma = FUENTE.slice(
      FUENTE.indexOf("export function subscribeFirestoreState("),
      FUENTE.indexOf(") {", FUENTE.indexOf("export function subscribeFirestoreState("))
    );
    expect(firma).toMatch(/onError\?:\s*\(error: unknown\) => void/);
    expect(firma).toMatch(/onEmpty\?:/);
    // Positivo: `onState` sigue siendo obligatorio — es el unico canal por el que llega el estado.
    expect(firma).toMatch(/\bonState:\s*\(state: AppState, report: LoadReport\) => void/);
    expect(firma).not.toMatch(/onState\?:/);
    // Y `loadFirestoreState` conserva su firma publica: `options` entero es opcional.
    expect(FUENTE).toMatch(/export async function loadFirestoreState\(context\?: FirestoreStateContext, options\?: LoadOptions\)/);
  });

  it("RNF_01: el parte de una cuenta sin vinculo sale limpio: onReport solo se emite desde la union de `sellers`", () => {
    // Un solo punto de emision. Si otra consulta emitiera un parte, una cuenta sin vinculo podria
    // recibir avisos de algo que nunca pidio.
    const veces = FUENTE.match(/options\?\.onReport\?\.\(/g)?.length ?? 0;
    expect(veces).toBe(1);
    expect(tramoDeLasTiendas()).toContain("options?.onReport?.(union.report)");
  });
});

describe("T10 · RNF_03: la suscripcion no recibe el sombrero", () => {
  it("RNF_03: los parametros de subscribeFirestoreState son contexto y callbacks; ninguno es el sombrero", () => {
    const inicio = FUENTE.indexOf("export function subscribeFirestoreState(");
    const firma = FUENTE.slice(inicio, FUENTE.indexOf(") {", inicio));
    expect(firma).toContain("context: FirestoreStateContext | undefined");
    expect(firma).not.toMatch(/\bhat\b|activeHat|hatChoice/i);
    // El contexto tampoco (T14 lo fija sobre el tipo; aqui, sobre los campos que se leen).
    const contexto = bloqueDelContexto();
    expect(contexto).toContain("communityId?: string;");
    expect(contexto).not.toMatch(/\bhat\b|activeHat/i);
  });
});
