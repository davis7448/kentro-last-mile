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
