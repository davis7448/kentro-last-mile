/**
 * Guardas de fuente de la spec 005 — `specs/005_tienda_lider_ve_su_pantalla.md`.
 *
 * Archivo aparte y por tema (plan 1, precedente de `state-store-targets.test.ts`): lo que se guarda
 * aqui no es el comportamiento de un modulo puro, sino la FORMA de artefactos que la suite no puede
 * ejecutar — el guion contra produccion, las reglas de Firestore y el JSX de las pantallas.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Fuente del repo sin comentarios: un requisito escrito en un comentario no es una garantia. */
function repoSourceWithoutComments(relativeToRepo: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../${relativeToRepo}`, import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Posicion del cierre que empareja la apertura en `openIndex` (`(`/`)` o `{`/`}`). */
function matchingClose(source: string, openIndex: number): number {
  const open = source[openIndex];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Apertura "${open}" sin cerrar en la posicion ${openIndex}.`);
}

type LocalFunctions = Map<string, string>;

/** Funciones con nombre del archivo: `function x(` y `const x = (async) (...) => {`. */
function localFunctions(source: string): LocalFunctions {
  const functions: LocalFunctions = new Map();
  const bodyAt = (braceIndex: number): string => source.slice(braceIndex, matchingClose(source, braceIndex) + 1);
  for (const match of source.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paramsEnd = matchingClose(source, (match.index ?? 0) + match[0].length - 1);
    const brace = source.indexOf("{", paramsEnd);
    if (brace >= 0) functions.set(match[1], bodyAt(brace));
  }
  for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    const paramsEnd = matchingClose(source, (match.index ?? 0) + match[0].length - 1);
    const arrow = source.slice(paramsEnd + 1).match(/^\s*=>\s*\{/);
    if (arrow) functions.set(match[1], bodyAt(paramsEnd + arrow[0].length));
  }
  return functions;
}

function callPattern(name: string): RegExp {
  return new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`);
}

/** Nombres de funciones locales llamadas en `text`. */
function localCallees(text: string, functions: LocalFunctions): string[] {
  return [...functions.keys()].filter((name) => callPattern(name).test(text));
}

/** `text` mas el cuerpo de toda funcion local que alcanza, transitivamente. */
function reachable(text: string, functions: LocalFunctions, visited: Set<string> = new Set()): string {
  let out = text;
  for (const name of localCallees(text, functions)) {
    if (visited.has(name)) continue;
    visited.add(name);
    out += `\n${reachable(functions.get(name) ?? "", functions, visited)}`;
  }
  return out;
}

/**
 * Primera posicion de `body` donde se alcanza `pattern`: la aparicion directa o la llamada a una
 * funcion local que lo alcanza. -1 si no se alcanza.
 */
function firstReach(body: string, pattern: RegExp, functions: LocalFunctions, self: string): number {
  const positions: number[] = [];
  const direct = body.search(pattern);
  if (direct >= 0) positions.push(direct);
  for (const name of localCallees(body, functions)) {
    if (name === self) continue;
    if (pattern.test(reachable(functions.get(name) ?? "", functions, new Set([self, name])))) {
      positions.push(body.search(callPattern(name)));
    }
  }
  return positions.length ? Math.min(...positions) : -1;
}

/*
 * =====================================================================================
 * T1 · RF_05, RNF_02 — Reproducir el fallo con una cuenta desechable, y poder refutarlo.
 * =====================================================================================
 *
 * `scripts/verify-005.js` NO se ejecuta en la suite: entra por REST contra PRODUCCION con una cuenta
 * desechable. Su canal de verificacion es la ejecucion manual (plan 0 y DoD 4). Lo unico que la suite
 * puede sostener es la FORMA del guion, y eso es lo que hay aqui: guardas de fuente sobre el archivo
 * sin comentarios.
 *
 * Por que estas guardas y no otras: T1 mide una hipotesis que NO esta comprobada (que el 403 venga de
 * la forma de `sellerInMyCommunity`), y el codigo de error es el mismo si la causa fuera el limite de
 * accesos a documento. Un guion que solo dijera "fallo: si/no" no distingue las dos causas y dejaria a
 * T2 arreglando a ciegas. De ahi la guarda 5: el error CRUDO y el numero de tiendas de la comunidad.
 * Las guardas 2, 3 y 4 son de seguridad — el guion corre en produccion, al lado de E-master y del
 * registro de dinero.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA que fijan estas guardas (lo que el coder debe respetar para que los recortes
 * encuentren lo que buscan):
 *
 * 1. CommonJS, `require("../functions/node_modules/firebase-admin")` e
 *    `initializeApp({ projectId: "kentro-last-mile" })`.
 * 2. Cada paso (`setup`, `reproduce`, `cleanup`) se elige por `process.argv` y se implementa en una
 *    funcion con nombre `<paso>`, `step<Paso>`, `run<Paso>`, `cmd<Paso>` o `<paso>Step` (declaracion
 *    `function` o `const x = async (...) => { ... }`). Las guardas siguen las llamadas a funciones
 *    LOCALES del archivo, asi que un paso puede delegar en ayudantes: cuenta todo lo que alcanza.
 * 3. El prefijo vive en una constante cuyo nombre contiene `PREFIX` y cuyo valor es `smoke005-`.
 * 4. En `reproduce`, evitar `new Map().set(` y `array.add(`: la guarda de solo lectura no distingue
 *    un Map de un documento de Firestore. Si hace falta acumular, usar objetos literales o `push`.
 * 5. La consulta de control y su resultado se nombran con la palabra `control` (p. ej.
 *    `const control = ...` o una clave `control:` en la evidencia). Es lo que permite afirmar que la
 *    sesion desechable lee ALGO, y por tanto que el rechazo de la consulta de comunidad no es una
 *    sesion rota.
 * 6. La evidencia y el estado se escriben bajo `.sdd/evidence/005/` (`path.join`, segmentos sueltos).
 * ---------------------------------------------------------------------------------------------
 */

const VERIFY_SCRIPT = "scripts/verify-005.js";
const VERIFY_STEPS = ["setup", "reproduce", "cleanup"] as const;

/** Escrituras en Firestore/Auth. `.set(` incluye `new Map().set(`: ver punto 4 del contrato. */
const FIRESTORE_WRITE = /\.(?:set|update|delete|add|create)\s*\(|\bbatch\s*\(|\brunTransaction\s*\(|\bcreateUser\s*\(|\bdeleteUser\s*\(/;
const FIRESTORE_DELETE = /\.delete\s*\(|\bdeleteUser\s*\(|\brecursiveDelete\b/;
const FILE_WRITE = /\bwriteFile(?:Sync)?\s*\(/;
/** Colecciones de dinero. La spec (DoD 4) prohibe escribir en ellas; aqui ni se nombran. */
const MONEY_COLLECTIONS = /\bwalletEntries\b|\bsettlements\b/;

function verifyScript(): { source: string; functions: LocalFunctions } {
  const source = repoSourceWithoutComments(VERIFY_SCRIPT);
  return { source, functions: localFunctions(source) };
}

/** Nombre y cuerpo de la funcion que implementa `step` (punto 2 del contrato). */
function verifyStep(step: string, functions: LocalFunctions): { name: string; body: string } {
  const cap = step[0].toUpperCase() + step.slice(1);
  for (const name of [step, `step${cap}`, `run${cap}`, `cmd${cap}`, `${step}Step`]) {
    const body = functions.get(name);
    if (body !== undefined) return { name, body };
  }
  throw new Error(`No se encuentra la funcion del paso "${step}" en ${VERIFY_SCRIPT}.`);
}

/** Todo lo que alcanza el paso, incluidos sus ayudantes locales. */
function verifyStepReach(step: string): string {
  const { functions } = verifyScript();
  const { name, body } = verifyStep(step, functions);
  return reachable(body, functions, new Set([name]));
}

/** La constante `*PREFIX* = "..."` de lo desechable: [nombre, valor]. */
function verifyPrefix(source: string): [string, string] {
  const match = source.match(/\bconst\s+([A-Za-z_$][\w$]*PREFIX[\w$]*)\s*=\s*["']([^"']+)["']/i);
  if (!match) throw new Error('No hay constante de prefijo `const *PREFIX* = "..."`.');
  return [match[1], match[2]];
}

describe("T1 · RF_05, RNF_02: guion de reproduccion contra produccion (DoD 4)", () => {
  describe("forma del guion", () => {
    it("RNF_02 · usa firebase-admin de functions/node_modules contra el proyecto kentro-last-mile", () => {
      const { source } = verifyScript();
      expect(source).toMatch(/require\(\s*["']\.\.\/functions\/node_modules\/firebase-admin["']\s*\)/);
      expect(source).toMatch(/initializeApp\(\s*\{\s*projectId\s*:\s*["']kentro-last-mile["']/);
    });

    it.each(VERIFY_STEPS)("RF_05 · el paso `%s` es una rama del argumento con su funcion", (step) => {
      const { source, functions } = verifyScript();
      expect(source).toMatch(/process\.argv/);
      expect(source).toMatch(new RegExp(`["'\`]${step}["'\`]|\\b${step}\\s*:|[{,]\\s*${step}\\s*[,}]`));
      expect(() => verifyStep(step, functions)).not.toThrow();
    });

    it("DoD 4 · escribe su estado y su evidencia bajo .sdd/evidence/005/, no bajo el de otra spec", () => {
      const { source } = verifyScript();
      // Positiva de control primero: si no escribiera ningun archivo, la negativa de abajo pasaria
      // en vacio y no habria evidencia ninguna que auditar.
      expect(source, "el guion escribe algun archivo").toMatch(FILE_WRITE);
      expect(source).toMatch(/["']\.sdd["']|\.sdd\//);
      expect(source).toMatch(/["']evidence["']|evidence\//);
      expect(source).toMatch(/["']005["']|evidence\/005/);
      expect(source, "no escribe en la evidencia de otra spec").not.toMatch(/evidence["'\/,\s)]+["']?00[1-4]\b/);
    });
  });

  describe("todo lo desechable lleva el prefijo smoke005-", () => {
    it("DoD 4 · hay una constante de prefijo con valor smoke005- y setup la usa al crear", () => {
      const { source } = verifyScript();
      const [prefixName, prefixValue] = verifyPrefix(source);
      expect(prefixValue).toBe("smoke005-");
      const reach = verifyStepReach("setup");
      expect(reach, "setup usa la constante de prefijo").toContain(prefixName);
      // Positiva de control: setup tiene que CREAR algo (cuenta, comunidad y tiendas). Sin esto, un
      // setup vacio cumpliria la exigencia del prefijo sin haber creado nada.
      expect(reach, "setup crea la cuenta desechable en Auth").toMatch(/\bcreateUser\s*\(/);
      expect(reach, "setup crea la comunidad de prueba").toMatch(/["']communities["']/);
      expect(reach, "setup crea las tiendas de prueba").toMatch(/["']sellers["']/);
    });

    it("DoD 4 · cleanup borra, y se niega a borrar lo que no lleve el prefijo", () => {
      const { source, functions } = verifyScript();
      const [prefixName] = verifyPrefix(source);
      const { name, body } = verifyStep("cleanup", functions);
      // Positiva de control: cleanup alcanza una eliminacion de verdad.
      expect(firstReach(body, FIRESTORE_DELETE, functions, name), "cleanup alcanza una eliminacion").toBeGreaterThanOrEqual(0);
      const reach = verifyStepReach("cleanup");
      expect(reach, "cleanup comprueba el prefijo antes de borrar").toMatch(new RegExp(`\\.startsWith\\(\\s*${prefixName}\\s*\\)`));
    });

    it("DoD 4 · cleanup no borra por consultas amplias: toda .where( filtra por prefijo o por id guardado", () => {
      const reach = verifyStepReach("cleanup");
      // Positiva de control: si el recorte fuera vacio, las negativas de abajo pasarian solas.
      expect(reach.length, "el cuerpo alcanzado por cleanup no esta vacio").toBeGreaterThan(0);
      expect(reach, "cleanup alcanza una eliminacion").toMatch(FIRESTORE_DELETE);
      expect(reach).not.toMatch(/\blistDocuments\s*\(|\brecursiveDelete\b/);
      expect(reach).not.toMatch(/collection\(\s*["'][^"']+["']\s*\)\s*\.(?:get|stream|limit)\s*\(/);
      const whereFields = [...reach.matchAll(/\.where\(\s*([^,]+),/g)].map((m) => m[1].trim());
      for (const field of whereFields) {
        expect(field, `.where(${field}, ...)`).toMatch(/^["'](?:communityId|sellerId|uid)["']$|FieldPath\.documentId\(\)$/);
      }
    });
  });

  describe("reproduce: mide, no escribe", () => {
    it("RNF_02 · reproduce entra por REST como la cuenta desechable y lee las dos mitades de la carga", () => {
      const reach = verifyStepReach("reproduce");
      expect(reach, "reproduce entra con signInWithPassword").toContain("signInWithPassword");
      expect(reach, "reproduce pide tiendas").toMatch(/["']sellers["']/);
      expect(reach, "reproduce pide las tiendas de la comunidad por communityId").toMatch(/\bcommunityId\b/);
    });

    it("RNF_02 · reproduce NO escribe en Firestore ni en Auth (.set( .update( .delete( .add( lotes, transacciones)", () => {
      const reach = verifyStepReach("reproduce");
      // Positiva de control emparejada: el recorte no esta vacio y alcanza la sesion REST. Sin ella,
      // un extractor roto dejaria pasar esta prueba sin haber mirado nada.
      expect(reach, "el cuerpo alcanzado por reproduce no esta vacio").toContain("signInWithPassword");
      expect(reach).not.toMatch(FIRESTORE_WRITE);
    });

    it("RF_05 · reproduce registra el error CRUDO (code y message), no un booleano", () => {
      const reach = verifyStepReach("reproduce");
      expect(reach, "registra el codigo del error").toMatch(/\bcode\b/);
      expect(reach, "registra el mensaje completo del error").toMatch(/\bmessage\b/);
      // El error crudo tiene que quedar en un archivo: es la evidencia con la que T2 decide, y el
      // desenlace "no falla" (hipotesis refutada) solo se puede sostener por escrito.
      expect(reach, "guarda la evidencia en archivo").toMatch(FILE_WRITE);
    });

    it("RF_05 · reproduce registra cuantas tiendas tiene la comunidad y una consulta de control", () => {
      const reach = verifyStepReach("reproduce");
      // Las dos causas posibles (forma de la regla vs. limite de accesos a documento) dan el mismo
      // codigo de error; lo que las separa es el numero de documentos candidatos.
      expect(reach, "cuenta los documentos de la comunidad").toMatch(/\.length\b|\.size\b|\bcount\b/i);
      expect(reach, "hace una consulta de control (punto 5 del contrato)").toMatch(/\bcontrol\b/i);
    });
  });

  describe("ningun paso toca el registro de dinero", () => {
    it.each(VERIFY_STEPS)("DoD 4 · el paso `%s` no nombra walletEntries ni settlements", (step) => {
      const reach = verifyStepReach(step);
      // Positiva de control por paso: el recorte tiene cuerpo. Un `verifyStep` que devolviera "" haria
      // pasar las tres negativas sin haber leido una linea del guion.
      expect(reach.length, `el cuerpo alcanzado por ${step} no esta vacio`).toBeGreaterThan(0);
      expect(reach).not.toMatch(MONEY_COLLECTIONS);
    });

    it("DoD 4 · el guion entero no nombra walletEntries ni settlements", () => {
      const { source } = verifyScript();
      expect(source.length, "el guion no esta vacio").toBeGreaterThan(0);
      expect(source).not.toMatch(MONEY_COLLECTIONS);
    });
  });
});

/*
 * =====================================================================================
 * T2 · RF_05, RF_02, RNF_02 — Una regla sin `get()` sobre el comodin.
 * =====================================================================================
 *
 * Lo medido en T1 contra produccion (2026-09-13, cuenta tienda-lider desechable): leer la tienda
 * propia por id PASA, la consulta `sellers where communityId == la suya` FALLA con 403
 * PERMISSION_DENIED, y el control (`cities`) PASA. El sintoma esta reproducido; la CAUSA exacta no
 * esta demostrada — la comunidad tenia una sola tienda, asi que el limite de accesos a documento no
 * deberia alcanzarse, y sin embargo el codigo de error es el mismo en ambas hipotesis.
 *
 * Por eso estas guardas no atan una causa, atan la FORMA que cubre las dos: que
 * `sellerInMyCommunity` decida con el documento que ya se esta evaluando (`resource.data`) y no
 * salga a buscar otro. Una regla que no accede a ningun documento externo no puede fallar ni por
 * evaluacion de la consulta contra el comodin ni por el limite de accesos.
 *
 * El equilibrio esta en no arreglar de mas: la guarda 4 (`isCommunityLeader` sigue exigiendo el
 * reclamo y excluyendo al acreedor) y la guarda 5 (`messengerBelongsToDriver` conserva su `get`,
 * que es legitimo porque va sobre `resource.data.messengerId` y no sobre el comodin de la ruta)
 * YA PASAN HOY: son guardas de NO REGRESION, y estan aqui para que el arreglo no se lleve por
 * delante comprobaciones que si hacen falta.
 */

const RULES_FILE = "firestore.rules";

/** Acceso a OTRO documento desde la regla: `get(/databases...` / `exists(/databases...`. */
const DOCUMENT_ACCESS = /(?<![.\w$])(?:get|exists)\s*\(\s*\/\s*databases/;

function rulesSource(): { source: string; functions: LocalFunctions } {
  const source = repoSourceWithoutComments(RULES_FILE);
  return { source, functions: localFunctions(source) };
}

/** Cuerpo de una funcion de `firestore.rules`, sin comentarios. */
function rulesFunction(name: string): string {
  const { functions } = rulesSource();
  const body = functions.get(name);
  if (body === undefined) throw new Error(`No existe la funcion \`${name}\` en ${RULES_FILE}.`);
  return body;
}

/** Cuerpo del bloque `match /<coleccion>/{comodin} { ... }` (el comodin de la ruta no confunde). */
function rulesMatchBlock(collection: string): string {
  const { source } = rulesSource();
  const header = new RegExp(`match\\s+/${collection}/\\{[^}]*\\}\\s*\\{`);
  const found = source.match(header);
  if (!found) throw new Error(`No existe el bloque \`match /${collection}/{...}\` en ${RULES_FILE}.`);
  const brace = (found.index ?? 0) + found[0].length - 1;
  return source.slice(brace, matchingClose(source, brace) + 1);
}

describe("T2 · RF_05, RF_02, RNF_02: la regla de sellers decide sin salir a buscar otro documento", () => {
  describe("RF_05 · `sellerInMyCommunity` no accede a otros documentos", () => {
    it("no llama a get(/databases ni a exists(/databases", () => {
      const body = rulesFunction("sellerInMyCommunity");
      // Positiva de control emparejada: el cuerpo se extrajo y tiene contenido. Sin ella, un
      // extractor roto que devolviera "" haria pasar las dos negativas sin haber leido la regla.
      expect(body.length, "el cuerpo de la funcion no esta vacio").toBeGreaterThan(2);
      expect(body, "la funcion sigue decidiendo algo").toMatch(/\breturn\b/);
      expect(body, "no sale a buscar otro documento con get(/databases").not.toMatch(
        /(?<![.\w$])get\s*\(\s*\/\s*databases/
      );
      expect(body, "no comprueba la existencia de otro documento con exists(/databases").not.toMatch(
        /(?<![.\w$])exists\s*\(\s*\/\s*databases/
      );
      // Redundante a proposito: si algun dia se anade otra forma de acceso, cae por aqui.
      expect(body).not.toMatch(DOCUMENT_ACCESS);
    });
  });

  describe("RF_05 · decide con el documento que se esta evaluando", () => {
    it("lee communityId de resource.data y se lo pasa a isCommunityLeader", () => {
      const body = rulesFunction("sellerInMyCommunity");
      expect(body, "lee el communityId del propio documento").toMatch(
        /resource\.data\.get\(\s*["']communityId["']/
      );
      expect(body, "se lo pasa a isCommunityLeader").toMatch(
        /(?<![.\w$])isCommunityLeader\s*\(\s*resource\.data\.get\(\s*["']communityId["']/
      );
    });
  });

  describe("RF_02, RNF_02 · el match /sellers conserva sus tres vias de lectura", () => {
    it("allow read autoriza por admin, por miembro de la tienda y por lider de la comunidad", () => {
      const block = rulesMatchBlock("sellers");
      const read = block.match(/allow\s+read\s*:\s*if([^;]*);/);
      expect(read, "el bloque declara un allow read").not.toBeNull();
      const condition = read?.[1] ?? "";
      expect(condition, "sigue leyendo el admin").toMatch(/(?<![.\w$])isAdmin\s*\(/);
      expect(condition, "sigue leyendo la propia tienda").toMatch(
        /(?<![.\w$])isStoreMember\s*\(\s*sellerId\s*\)/
      );
      expect(condition, "sigue leyendo el lider de la comunidad").toMatch(
        /(?<![.\w$])sellerInMyCommunity\s*\(/
      );
    });

    it("RNF_02 · allow write sigue siendo solo del admin (la tienda no cambia de comunidad sola)", () => {
      const block = rulesMatchBlock("sellers");
      const write = block.match(/allow\s+write\s*:\s*if([^;]*);/);
      expect(write, "el bloque declara un allow write").not.toBeNull();
      expect((write?.[1] ?? "").trim()).toBe("isAdmin()");
    });
  });

  describe("RNF_02 · no se abre de mas (NO REGRESION: estas dos ya pasan hoy)", () => {
    it("isCommunityLeader sigue exigiendo el reclamo presente, no vacio e igual, y excluye al acreedor", () => {
      const leader = rulesFunction("isCommunityLeader");
      expect(leader, "sigue apoyandose en hasCommunityClaim").toMatch(
        /(?<![.\w$])hasCommunityClaim\s*\(\s*communityId\s*\)/
      );
      expect(leader, "sigue excluyendo al acreedor").toMatch(
        /communityStanding\s*!=\s*["']creditor["']/
      );
      const claim = rulesFunction("hasCommunityClaim");
      expect(claim, "el reclamo tiene que existir y ser texto").toMatch(
        /request\.auth\.token\.communityId\s+is\s+string/
      );
      expect(claim, "el reclamo no puede ser vacio").toMatch(
        /request\.auth\.token\.communityId\s*!=\s*["']{2}/
      );
      expect(claim, "el reclamo tiene que ser el de la comunidad consultada").toMatch(
        /request\.auth\.token\.communityId\s*==\s*communityId/
      );
    });

    it("messengerBelongsToDriver conserva su get(/databases: va sobre resource.data, no sobre el comodin", () => {
      const body = rulesFunction("messengerBelongsToDriver");
      // `[^;]` y no `[^)]`: la ruta lleva `$(database)`, asi que un recorte hasta el primer
      // parentesis de cierre nunca llega al nombre de la coleccion.
      expect(body, "sigue leyendo el documento del mensajero").toMatch(
        /(?<![.\w$])get\s*\(\s*\/\s*databases[^;]*?\/messengers\//
      );
      expect(body, "sigue comprobando que existe antes de leerlo").toMatch(
        /(?<![.\w$])exists\s*\(\s*\/\s*databases[^;]*?\/messengers\//
      );
      expect(body, "sigue atando el mensajero a su lider logistico").toMatch(
        /leaderDriverId\s*==\s*request\.auth\.token\.driverId/
      );
      const orders = rulesMatchBlock("orders");
      expect(orders, "y se sigue invocando con el campo del pedido, no con el comodin").toMatch(
        /messengerBelongsToDriver\s*\(\s*resource\.data\.messengerId\s*\)/
      );
    });
  });
});

/*
 * =====================================================================================
 * T8 · RF_01, RF_07, RF_08 — El canal del fallo, y la pantalla de la tienda que lo usa.
 * =====================================================================================
 *
 * Tres averias encadenadas, y las tres son la misma: un fallo que no llega a quien tiene que
 * contarlo.
 *
 * 1. T5 dejo `mergeCommunitySellers` produciendo un PARTE que dice si falto la mitad de comunidad,
 *    pero el sitio de llamada en `loadFirestoreState` termina en `.sellers`, o sea que lo tira.
 *    Mientras siga asi, una mitad rechazada se degrada EN SILENCIO — el principio 8 de la
 *    constitucion en estado puro — y ni el aviso del enlace de invitacion (T9) ni el de carga
 *    tienen de donde salir.
 * 2. El final de `subscribeFirestoreState` se traga su propio fallo en un
 *    `.catch((error) => console.warn(...))`. La consola no es un canal: la pantalla nunca se entera.
 * 3. Y como no se entera, `SellerView` decide con un `if (!seller)` suelto y le dice a una persona
 *    cuya tienda esta perfectamente vinculada que vaya a pedirle al administrador un arreglo que no
 *    hace falta. Es el mensaje exacto que vio la primera cuenta real con los dos papeles.
 *
 * Por que guardas de fuente y no pruebas de comportamiento: `state-store.ts` importa el SDK de
 * Firebase y `operations-app.tsx` es el monolito de ~13.000 lineas; ninguno se puede importar desde
 * la suite. Lo unico sostenible aqui es la FORMA. Por eso, como en T1 y T2, se afirma sobre
 * BOOLEANOS ya calculados (`/regex/.test(recorte)`) y no con `expect(FUENTE).not.toMatch(...)`: un
 * rojo de la segunda forma volcaria el monolito entero en la salida.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA que fijan estas guardas (lo que el coder debe respetar):
 *
 * 1. `subscribeFirestoreState` declara `onError` en su firma y `onState` recibe el parte como
 *    SEGUNDO argumento, tanto en el tipo como en la llamada (plan §2).
 * 2. El sitio de llamada de `mergeCommunitySellers` conserva el parte: ya no termina en `.sellers`.
 * 3. En la pantalla, `useAppState` pasa un manejador de error a la suscripcion y guarda el fallo en
 *    estado de React cuyo nombre contenga `fail`, `fallo` o `error`.
 * 4. `SellerView` decide con `storeProfileState` importado de `@/lib/load-status`, y los textos de
 *    RF_07 y RF_08 se escriben EN SU CUERPO o en una funcion local del mismo archivo cuyo nombre
 *    contenga `Fail`, `Fallo`, `Error`, `Retry`, `Reintent`, `Missing`, `Pending` o `Pendiente`.
 *    Las guardas siguen esa funcion por su nombre (por llamada o por uso JSX) y NO siguen el resto
 *    del arbol, a proposito: `SellerView` pinta el panel de incidencias de Shopify, que ya dice
 *    "Reintentar" (`operations-app.tsx:2568`), y seguirlo pondria verde la guarda de RF_07 sin que
 *    exista aviso ninguno.
 * ---------------------------------------------------------------------------------------------
 */

const STATE_STORE = "src/lib/firebase/state-store.ts";
const MONOLITO = "src/components/operations-app.tsx";
const GUARDAS_T5 = "src/lib/state-store-targets.test.ts";

const FUENTE_STORE = repoSourceWithoutComments(STATE_STORE);
const FUENTE_PANTALLA = repoSourceWithoutComments(MONOLITO);
const FUNCIONES_STORE = funcionesSeguras(FUENTE_STORE);
const FUNCIONES_PANTALLA = funcionesSeguras(FUENTE_PANTALLA);

/**
 * Fin del literal `'...'`, `"..."` o de plantilla que empieza en `i`, saltando los escapes.
 *
 * Existe porque `matchingClose` (T1, T2) cuenta llaves sin entender cadenas, y sobre el monolito eso
 * no vale: hay una funcion cuyo cuerpo lleva una llave dentro de un literal, y contar a ciegas se
 * traga el resto del archivo. Medido: `localFunctions(operations-app.tsx)` aborta la suite entera
 * con "Apertura { sin cerrar en la posicion 112926".
 *
 * Los dos casos que enganarian a este salto son un literal de expresion regular con comillas dentro
 * y un apostrofe suelto en texto JSX. Comprobado que en este archivo no hay ninguno de los dos; si
 * algun dia aparece, la guarda del extractor (primera prueba de la seccion de pantalla) lo canta.
 */
function finDelLiteral(source: string, i: number): number {
  const comilla = source[i];
  for (let j = i + 1; j < source.length; j += 1) {
    if (source[j] === "\\") {
      j += 1;
      continue;
    }
    if (source[j] === comilla) return j;
  }
  return source.length - 1;
}

/** Como `matchingClose`, pero saltandose lo que haya dentro de los literales. */
function cierreSeguro(source: string, apertura: number): number {
  const abre = source[apertura];
  const cierra = abre === "(" ? ")" : abre === "{" ? "}" : "]";
  let profundidad = 0;
  for (let i = apertura; i < source.length; i += 1) {
    const caracter = source[i];
    if (caracter === '"' || caracter === "'" || caracter === "`") {
      i = finDelLiteral(source, i);
      continue;
    }
    if (caracter === abre) profundidad += 1;
    else if (caracter === cierra) {
      profundidad -= 1;
      if (profundidad === 0) return i;
    }
  }
  throw new Error(`Apertura "${abre}" sin cerrar en la posicion ${apertura}.`);
}

/**
 * Funciones con nombre del archivo: como `localFunctions`, pero con el escaner de arriba y
 * TOLERANTE — una funcion que no se pueda delimitar se omite en vez de tumbar la suite. En el
 * monolito hay 275 y solo 1 no cierra; ninguna de las que miran estas guardas.
 */
function funcionesSeguras(source: string): LocalFunctions {
  const funciones: LocalFunctions = new Map();
  const cuerpoDesde = (llave: number): string => source.slice(llave, cierreSeguro(source, llave) + 1);
  for (const match of source.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    try {
      const finParametros = cierreSeguro(source, (match.index ?? 0) + match[0].length - 1);
      const llave = source.indexOf("{", finParametros);
      if (llave >= 0) funciones.set(match[1], cuerpoDesde(llave));
    } catch {
      // Funcion que no se puede delimitar: se omite. Tumbar la suite por una ajena seria peor.
    }
  }
  for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    try {
      const finParametros = cierreSeguro(source, (match.index ?? 0) + match[0].length - 1);
      const flecha = source.slice(finParametros + 1).match(/^\s*=>\s*\{/);
      if (flecha) funciones.set(match[1], cuerpoDesde(finParametros + flecha[0].length));
    } catch {
      // Idem.
    }
  }
  return funciones;
}

/** Fuente tal cual, con comentarios: para mirar OTRO archivo de pruebas sin reescribirlo. */
function fuenteCruda(relativeToRepo: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativeToRepo}`, import.meta.url)), "utf8");
}

/** Indices de la APERTURA `(` de cada llamada a `nombre` (no cuenta `x.nombre(` ni el import). */
function indicesDeLlamada(source: string, nombre: string): number[] {
  const patron = new RegExp(`(?<![.\\w$])${nombre}\\s*\\(`, "g");
  return [...source.matchAll(patron)].map((match) => (match.index ?? 0) + match[0].length - 1);
}

/** Texto entre el parentesis que abre en `apertura` y el que lo cierra. */
function interiorDe(source: string, apertura: number): string {
  return source.slice(apertura + 1, cierreSeguro(source, apertura));
}

/** Argumentos de primer nivel: las comas dentro de `()`, `{}`, `[]` o de un literal no separan. */
function argumentosTopLevel(interior: string): string[] {
  const partes: string[] = [];
  let profundidad = 0;
  let actual = "";
  for (let i = 0; i < interior.length; i += 1) {
    const caracter = interior[i];
    if (caracter === '"' || caracter === "'" || caracter === "`") {
      const fin = finDelLiteral(interior, i);
      actual += interior.slice(i, fin + 1);
      i = fin;
      continue;
    }
    if ("([{".includes(caracter)) profundidad += 1;
    if (")]}".includes(caracter)) profundidad -= 1;
    if (caracter === "," && profundidad === 0) {
      partes.push(actual);
      actual = "";
      continue;
    }
    actual += caracter;
  }
  partes.push(actual);
  return partes.map((parte) => parte.trim()).filter((parte) => parte.length > 0);
}

function cuerpoDe(funciones: LocalFunctions, nombre: string): string {
  const cuerpo = funciones.get(nombre);
  if (cuerpo === undefined) throw new Error(`No se encuentra la funcion \`${nombre}\`.`);
  return cuerpo;
}

/** Firma (lo que hay entre parentesis) de `subscribeFirestoreState`. */
function firmaDeLaSuscripcion(): string {
  const [apertura] = indicesDeLlamada(FUENTE_STORE, "function\\s+subscribeFirestoreState");
  if (apertura === undefined) throw new Error("No se encuentra la declaracion de subscribeFirestoreState.");
  return interiorDe(FUENTE_STORE, apertura);
}

const NOMBRE_DE_AVISO = /fail|fallo|error|retry|reintent|missing|pending|pendiente/i;

/** El cuerpo de `SellerView` mas el de las funciones de aviso que use (punto 4 del contrato). */
function alcanceDelAviso(): string {
  const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "SellerView");
  let salida = cuerpo;
  for (const nombre of FUNCIONES_PANTALLA.keys()) {
    if (nombre === "SellerView" || !NOMBRE_DE_AVISO.test(nombre)) continue;
    const usada = callPattern(nombre).test(cuerpo) || new RegExp(`<${nombre}[\\s/>]`).test(cuerpo);
    if (usada) salida += `\n${FUNCIONES_PANTALLA.get(nombre) ?? ""}`;
  }
  return salida;
}

describe("T8 · RF_01, RF_07, RF_08: el canal del fallo y la pantalla que lo usa", () => {
  describe("state-store.ts · RF_07: el fallo sale del modulo", () => {
    it("RF_07 · el parte de `mergeCommunitySellers` deja de descartarse con `.sellers`", () => {
      const llamadas = indicesDeLlamada(FUENTE_STORE, "mergeCommunitySellers");
      // Positiva de control emparejada: la union sigue haciendose donde tiene que hacerse. Sin
      // esto, borrar la llamada entera pondria verde la negativa de abajo.
      expect(llamadas.length, "sigue habiendo una llamada a `mergeCommunitySellers(`").toBeGreaterThan(0);
      const tiraElParte = llamadas.some((apertura) => {
        const cierre = cierreSeguro(FUENTE_STORE, apertura);
        return /^\s*\.sellers\b/.test(FUENTE_STORE.slice(cierre + 1, cierre + 32));
      });
      expect(
        tiraElParte,
        "el sitio de llamada sigue terminando en `.sellers`: el parte se calcula y se tira, asi que una mitad de comunidad rechazada se degrada en silencio"
      ).toBe(false);
    });

    it("RF_07 · `subscribeFirestoreState` declara un canal de error `onError`", () => {
      const firma = firmaDeLaSuscripcion();
      // Positivas de control: la firma se extrajo y es la que se cree.
      expect(firma, "la firma trae el contexto").toContain("context");
      expect(firma, "la firma trae `onState`").toContain("onState");
      expect(
        /\bonError\b/.test(firma),
        "la firma no declara `onError`: sin canal, la pantalla no tiene por donde enterarse de que la carga base fallo"
      ).toBe(true);
    });

    it("RF_07 · el `.catch` final de la carga base llama a `onError`, no se limita a avisar por consola", () => {
      const cuerpo = cuerpoDe(FUNCIONES_STORE, "subscribeFirestoreState");
      const llamadas = indicesDeLlamada(cuerpo, "loadFirestoreState");
      expect(llamadas.length, "la suscripcion sigue haciendo la carga base").toBeGreaterThan(0);
      const desde = llamadas[llamadas.length - 1];
      const catchIndex = cuerpo.indexOf(".catch(", desde);
      // Positiva de control emparejada: el `.catch(` de la cadena sigue existiendo. Sin ella, quitar
      // el manejo de error dejaria pasar las afirmaciones de abajo sobre un recorte vacio.
      expect(catchIndex, "la cadena de la carga base sigue teniendo un `.catch(`").toBeGreaterThan(-1);
      const manejador = interiorDe(cuerpo, catchIndex + ".catch".length);
      const llamaAOnError = /\bonError\b/.test(manejador);
      const soloAvisaPorConsola = !llamaAOnError && /console\.(?:warn|error|log)/.test(manejador);
      expect(llamaAOnError, "el `.catch` final no menciona `onError`: el fallo de la carga base se queda dentro").toBe(true);
      expect(soloAvisaPorConsola, "el `.catch` final se limita a `console.warn`, que no es un canal hacia la pantalla").toBe(false);
    });

    it("RF_07 · el parte viaja con el estado: `onState` entrega dos cosas, en el tipo y en la llamada", () => {
      const firma = firmaDeLaSuscripcion();
      const posicion = firma.indexOf("onState");
      const apertura = firma.indexOf("(", posicion);
      expect(apertura, "`onState` se declara como funcion").toBeGreaterThan(-1);
      const parametrosDeOnState = argumentosTopLevel(interiorDe(firma, apertura));
      // Positiva de control: el primer parametro sigue siendo el estado.
      expect(parametrosDeOnState[0] ?? "", "`onState` sigue entregando el estado").toContain("AppState");
      expect(
        parametrosDeOnState.length,
        "`onState` solo entrega el estado: el parte no llega a la pantalla, asi que 'no hay tiendas' y 'no se pudo saber' siguen siendo indistinguibles"
      ).toBeGreaterThanOrEqual(2);

      const cuerpo = cuerpoDe(FUNCIONES_STORE, "subscribeFirestoreState");
      const [llamada] = indicesDeLlamada(cuerpo, "onState");
      expect(llamada, "la suscripcion sigue emitiendo con `onState(`").toBeGreaterThan(-1);
      expect(
        argumentosTopLevel(interiorDe(cuerpo, llamada)).length,
        "la llamada a `onState(` sigue pasando un solo argumento"
      ).toBeGreaterThanOrEqual(2);
    });
  });

  describe("operations-app.tsx · RF_07, RF_08: la pantalla deja de mentir", () => {
    it("el extractor trae el cuerpo de `SellerView` y no se pasa de largo", () => {
      // Guarda del propio extractor. `matchingClose` cuenta llaves sin entender cadenas, asi que si
      // alguna vez se desbordara, el cuerpo arrastraria vistas posteriores y las guardas de abajo se
      // pondrian verdes con textos que no son de esta pantalla.
      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "SellerView");
      expect(cuerpo, "el cuerpo extraido es el de la pantalla de la tienda").toContain("state.sellers");
      expect(cuerpo, "y llega hasta su estado vacio").toContain("EmptyRoleState");
      expect(
        cuerpo.includes("Perfil de mensajero pendiente"),
        "el cuerpo extraido se desborda hasta la vista del mensajero: el recorte no es de fiar"
      ).toBe(false);
    });

    it("RF_07 · la suscripcion recibe un manejador de error y el fallo queda en estado de React", () => {
      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "useAppState");
      const [llamada] = indicesDeLlamada(cuerpo, "subscribeFirestoreState");
      // Positiva de control emparejada: la pantalla sigue suscribiendose.
      expect(llamada, "`useAppState` sigue llamando a `subscribeFirestoreState(`").toBeGreaterThan(-1);
      const argumentos = argumentosTopLevel(interiorDe(cuerpo, llamada));
      expect(argumentos.length, "la llamada sigue pasando solo contexto, estado y vacio: no hay manejador de error").toBeGreaterThanOrEqual(4);
      expect(
        /const\s*\[\s*[A-Za-z_$][\w$]*(?:[Ff]ail|[Ee]rror|[Ff]allo)[\w$]*\s*,/.test(cuerpo),
        "no hay estado de React que recuerde que la carga fallo: sin el, el aviso de RF_07 no se puede pintar"
      ).toBe(true);
    });

    it("RF_08 · `SellerView` decide con `storeProfileState`, no con un `if (!seller)` suelto", () => {
      const importaElNucleo =
        /import\s*\{[^}]*\bstoreProfileState\b[^}]*\}\s*from\s*["']@\/lib\/load-status["']/.test(FUENTE_PANTALLA);
      expect(importaElNucleo, "la pantalla no importa `storeProfileState` de `@/lib/load-status`").toBe(true);
      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "SellerView");
      expect(
        callPattern("storeProfileState").test(cuerpo),
        "`SellerView` no llama a `storeProfileState`: sigue decidiendo por su cuenta lo que T3 ya decide"
      ).toBe(true);
      expect(
        /if\s*\(\s*!\s*seller\s*\)/.test(cuerpo),
        "`SellerView` sigue decidiendo con un `if (!seller)` suelto, que no sabe si la carga funciono y por eso culpa a la configuracion de la cuenta"
      ).toBe(false);
    });

    it("RF_08 · dos textos distintos: la cuenta sin tienda y la tienda que ya no existe", () => {
      const alcance = alcanceDelAviso();
      // Positiva de control emparejada: el recorte tiene cuerpo y es el de esta pantalla.
      expect(alcance, "el recorte del aviso no esta vacio").toContain("EmptyRoleState");
      expect(
        /\bno_store_assigned\b/.test(alcance),
        "la pantalla no distingue el caso 'la cuenta no tiene tienda asignada'"
      ).toBe(true);
      expect(
        /\bstore_missing\b/.test(alcance),
        "la pantalla no distingue el caso 'la tienda asignada ya no existe'"
      ).toBe(true);
      expect(
        /ya no existe/i.test(alcance),
        "falta el texto de la tienda que ya no existe: sin el, los dos casos de configuracion siguen diciendo lo mismo"
      ).toBe(true);
      const soloElTextoViejo = /falta vincularla a una tienda/i.test(alcance) && !/ya no existe/i.test(alcance);
      expect(soloElTextoViejo, "el unico mensaje sigue siendo el viejo 'falta vincularla a una tienda'").toBe(false);
    });

    it("RF_07 · hay aviso de que no se pudo cargar, con reintento que no recarga la pagina", () => {
      const alcance = alcanceDelAviso();
      expect(alcance, "el recorte del aviso no esta vacio").toContain("EmptyRoleState");
      expect(
        /no se pudo cargar|no se pudieron cargar/i.test(alcance),
        "no hay aviso de carga fallida en la pantalla de la tienda: el fallo se sigue contando como problema de configuracion"
      ).toBe(true);
      expect(/reintent/i.test(alcance), "el aviso no ofrece reintentar (RF_07 lo exige)").toBe(true);
      // El reintento vuelve a montar la suscripcion, que es la via que ya usa el cambio de sesion.
      // Recargar la pagina tiraria la cache de IndexedDB y volveria a pagar la descarga entera.
      expect(
        /location\.reload\s*\(/.test(alcance) || /window\.location/.test(alcance),
        "el reintento recarga la pagina en vez de volver a montar la suscripcion (plan §3.3)"
      ).toBe(false);
    });
  });

  describe("NO REGRESION: lo que T8 no puede llevarse por delante", () => {
    it("las guardas de T5 sobre la asimetria de las dos mitades siguen en pie", () => {
      // No se duplican aqui a proposito: viven en `state-store-targets.test.ts` y se ejecutan en la
      // misma orden. Esta guarda solo comprueba que nadie las borre al tocar el sitio de llamada,
      // que es justo el codigo que T8 modifica.
      const guardas = fuenteCruda(GUARDAS_T5);
      expect(guardas, "el bloque T5 sigue existiendo").toContain(
        "T5 · RF_01, RF_06: la mitad de comunidad se degrada; la tienda propia, no"
      );
      expect(guardas, "sigue exigiendo que la mitad de comunidad entregue `{ failed: true }`").toContain(
        "la mitad de comunidad va envuelta y entrega `{ failed: true }` en vez de rechazar"
      );
      expect(guardas, "y que la tienda propia NO se degrade").toContain(
        "la tienda propia no puede degradarse a `{ failed: true }`"
      );
    });

    it("RF_22 de la 003: `state-store.ts` sigue sin filtrar los cortes por la posicion en la comunidad", () => {
      // La guarda viva es `state-store-targets.test.ts:136-144`. Se comprueba que sigue ahi y, ya que
      // la fuente esta leida, que su premisa sigue siendo cierta: a un acreedor se le sigue debiendo,
      // y filtrar por `communityStanding` le esconderia el cobro en silencio.
      expect(fuenteCruda(GUARDAS_T5), "la guarda de RF_22 sigue existiendo").toContain(
        "RF_22: la descarga de los cortes no se filtra por la posicion, solo por el vinculo"
      );
      expect(/communityStanding/.test(FUENTE_STORE), "`state-store.ts` menciona `communityStanding`").toBe(false);
      expect(/"creditor"/.test(FUENTE_STORE), '`state-store.ts` menciona `"creditor"`').toBe(false);
    });
  });
});

/**
 * ---------------------------------------------------------------------------------------------
 * T9 · RF_05, RF_10, RF_11, RF_12: la pantalla de la comunidad distingue los motivos, y no esconde
 * el enlace perdido.
 *
 * Hoy `CommunityLeaderView` tiene una rama de carga, UNA tarjeta de error generica ("No se
 * pudieron cargar tus cifras") y una tarjeta vacia cuya condicion es `!stats || ... "no_stores"`.
 * Tres conflaciones: (1) al acreedor —a quien el servidor le niega la callable POR DISENO— se le
 * pinta una averia y un reintentar que nunca va a conceder nada (RF_12); (2) una respuesta que
 * NO llego se pinta como "Todavia no tienes tiendas" (RF_11); (3) si la mitad de comunidad de
 * `sellers` se degrada, `communitySlug` no encuentra el slug y el enlace de invitacion se apaga
 * en silencio, porque el parte (`loadReport`) llega a `useAppState` y la app NO lo recoge.
 *
 * Extractores: los seguros de T8 (`funcionesSeguras`/`cierreSeguro`), NUNCA `localFunctions`, que
 * revienta con el monolito. Cada negativa lleva su positiva de control.
 * ---------------------------------------------------------------------------------------------
 */

const GUARDAS_T16_003 = "src/lib/session-hats.test.ts";

/** Parametros (entre parentesis) de la declaracion `function <nombre>(`. */
function parametrosDeDeclaracion(nombre: string): string {
  const [apertura] = indicesDeLlamada(FUENTE_PANTALLA, `function\\s+${nombre}`);
  if (apertura === undefined) throw new Error(`No se encuentra la declaracion de ${nombre}.`);
  return interiorDe(FUENTE_PANTALLA, apertura);
}

/** Props del sitio de llamada JSX `<nombre ... />` (el primero que haya). */
function propsDelSitioDeLlamada(nombre: string): string {
  const match = FUENTE_PANTALLA.match(new RegExp(`<${nombre}\\b([\\s\\S]*?)\\/>`));
  if (!match) throw new Error(`No se encuentra el sitio de llamada <${nombre} ... />.`);
  return match[1];
}

/** El cuerpo de `nombre` mas el de las funciones de aviso que use (mismo contrato que T8). */
function alcanceDeLaVista(nombre: string): string {
  const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, nombre);
  let salida = cuerpo;
  for (const otra of FUNCIONES_PANTALLA.keys()) {
    if (otra === nombre || !NOMBRE_DE_AVISO.test(otra)) continue;
    const usada = callPattern(otra).test(cuerpo) || new RegExp(`<${otra}[\\s/>]`).test(cuerpo);
    if (usada) salida += `\n${FUNCIONES_PANTALLA.get(otra) ?? ""}`;
  }
  return salida;
}

/**
 * El fragmento de JSX alrededor de la posicion `i`: desde el `return`/`case` anterior hasta el
 * siguiente. Sirve para mirar UNA tarjeta sin que las vecinas contaminen la afirmacion. Si el coder
 * pinta los tres avisos en un unico `return` con ternarios encadenados, los fragmentos se solapan y
 * la negativa "el aviso del acreedor no ofrece reintentar" fallara: separarlos en ramas es lo que
 * la spec pide (tres textos distintos), asi que ese fallo tambien es informacion.
 */
function fragmentoAlrededor(texto: string, i: number): string {
  const marcas = ["return", "case "];
  const inicio = Math.max(0, ...marcas.map((marca) => texto.lastIndexOf(marca, i)));
  const fines = marcas.map((marca) => texto.indexOf(marca, i + 1)).filter((fin) => fin >= 0);
  const fin = fines.length > 0 ? Math.min(...fines) : texto.length;
  return texto.slice(inicio, fin);
}

const TEXTO_FALLO = /no se pudo cargar|no se pudieron cargar/i;
const TEXTO_YA_NO_GOBIERNA = /ya no gobiernas?|ya no lideras?|dejaste de liderar/i;
const TEXTO_ENLACE_PERDIDO = /enlace[\s\S]{0,160}?no se pudo|no se pudo[\s\S]{0,160}?enlace/i;

describe("T9 · RF_05, RF_10, RF_11, RF_12: la pantalla de la comunidad distingue los motivos", () => {
  it("el extractor trae el cuerpo de `CommunityLeaderView` y no se pasa de largo", () => {
    const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "CommunityLeaderView");
    expect(cuerpo, "el cuerpo extraido es el de la pantalla de comunidad").toContain("fetchCommunityStats");
    expect(cuerpo, "y llega hasta la tarjeta del cashback").toContain("Tu cashback");
    expect(
      /function\s+communitySlug\s*\(/.test(cuerpo),
      "el cuerpo extraido se desborda hasta `communitySlug`: el recorte no es de fiar"
    ).toBe(false);
  });

  describe("RF_10, RF_11, RF_12 · quien decide es el nucleo", () => {
    it("RF_10-12 · la pantalla importa `communityStoresState` de `@/lib/load-status` y `CommunityLeaderView` lo llama", () => {
      const importaElNucleo =
        /import\s*\{[^}]*\bcommunityStoresState\b[^}]*\}\s*from\s*["']@\/lib\/load-status["']/.test(FUENTE_PANTALLA);
      // Positiva de control: el import de load-status ya existe (T8 trajo `storeProfileState`).
      expect(
        /import\s*\{[^}]*\bstoreProfileState\b[^}]*\}\s*from\s*["']@\/lib\/load-status["']/.test(FUENTE_PANTALLA),
        "el import de `@/lib/load-status` que dejo T8 sigue ahi"
      ).toBe(true);
      expect(importaElNucleo, "la pantalla no importa `communityStoresState` de `@/lib/load-status`").toBe(true);
      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "CommunityLeaderView");
      expect(
        callPattern("communityStoresState").test(cuerpo),
        "`CommunityLeaderView` no llama a `communityStoresState`: sigue decidiendo por su cuenta lo que T4 ya decide"
      ).toBe(true);
    });

    it("RF_12 · la posicion entra por prop `standing`, desde `session.communityStanding`, no del sombrero", () => {
      const parametros = parametrosDeDeclaracion("CommunityLeaderView");
      // Positiva de control: los parametros se extrajeron y son los que se creen.
      expect(parametros, "la declaracion sigue recibiendo `communityId`").toContain("communityId");
      expect(/\bstanding\b/.test(parametros), "`CommunityLeaderView` no recibe la prop `standing`").toBe(true);

      const props = propsDelSitioDeLlamada("CommunityLeaderView");
      expect(props, "el sitio de llamada sigue pasando `communityId`").toContain("communityId=");
      expect(
        /\bstanding=\{\s*session\??\.communityStanding\s*\}/.test(props),
        "el sitio de llamada no pasa `standing={session.communityStanding}`: T6 hizo que llegara y nadie lo recoge"
      ).toBe(true);

      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "CommunityLeaderView");
      expect(/\bactiveHat\b/.test(cuerpo), "la vista lee la posicion del sombrero (`activeHat`): eso es interfaz, no lo que la cuenta ES").toBe(false);
      expect(/\bhatChoice\b/.test(cuerpo), "la vista lee la posicion del sombrero (`hatChoice`)").toBe(false);
    });

    it("RF_11 · la conflacion `!stats ||` desaparece: una respuesta que no llego ya no se pinta como comunidad vacia", () => {
      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "CommunityLeaderView");
      // Positiva de control emparejada: la tarjeta vacia sigue existiendo.
      expect(cuerpo, "la tarjeta 'Todavia no tienes tiendas' sigue existiendo (RF_11)").toContain("Todavia no tienes tiendas");
      expect(
        /!\s*stats\s*\|\|/.test(cuerpo),
        "la condicion de la tarjeta vacia sigue conteniendo `!stats ||`: 'no se pudo saber' se pinta como 'no hay nada'"
      ).toBe(false);
    });
  });

  describe("RF_10, RF_12 · tres textos distintos, y solo el fallo ofrece reintentar", () => {
    it("RF_10 · hay aviso de carga fallida y ofrece reintentar", () => {
      const alcance = alcanceDeLaVista("CommunityLeaderView");
      const i = alcance.search(TEXTO_FALLO);
      expect(i, "no hay aviso de carga fallida en la pantalla de comunidad").toBeGreaterThan(-1);
      expect(
        /reintent/i.test(fragmentoAlrededor(alcance, i)),
        "el aviso de carga fallida no ofrece reintentar (RF_10 lo exige)"
      ).toBe(true);
    });

    it("RF_12 · hay un texto que dice que ya no gobierna esa comunidad, y NO ofrece reintentar", () => {
      const alcance = alcanceDeLaVista("CommunityLeaderView");
      // Positiva de control: el nucleo distingue el caso y la pantalla lo nombra.
      expect(/\bnot_governing\b/.test(alcance), "la pantalla no distingue el caso `not_governing`").toBe(true);
      const i = alcance.search(TEXTO_YA_NO_GOBIERNA);
      expect(i, "falta el texto de que ya no gobierna la comunidad: al acreedor se le sigue pintando una averia").toBeGreaterThan(-1);
      expect(
        /reintent/i.test(fragmentoAlrededor(alcance, i)),
        "el aviso de 'ya no gobiernas' ofrece reintentar: mandarlo a reintentar algo que el servidor niega por diseno"
      ).toBe(false);
    });

    it("RF_11 · la tarjeta vacia tampoco ofrece reintentar: no es un error", () => {
      const alcance = alcanceDeLaVista("CommunityLeaderView");
      const i = alcance.indexOf("Todavia no tienes tiendas");
      expect(i).toBeGreaterThan(-1);
      expect(/reintent/i.test(fragmentoAlrededor(alcance, i)), "la tarjeta de comunidad vacia ofrece reintentar").toBe(false);
    });
  });

  describe("RF_12 · el acreedor sigue viendo lo que se le debe", () => {
    it("la deuda sale de `communityCashbackOwedCop` (cortes), no de `stats.totals.cashbackPendingCop` (callable que le niegan)", () => {
      const importaLaHermana =
        /import\s*\{[^}]*\bcommunityCashbackOwedCop\b[^}]*\}\s*from\s*["']@\/lib\/community-view["']/.test(FUENTE_PANTALLA);
      // Positiva de control: la hermana pagada ya viene de ahi.
      expect(
        /import\s*\{[^}]*\bcommunityCashbackPaidCop\b[^}]*\}\s*from\s*["']@\/lib\/community-view["']/.test(FUENTE_PANTALLA),
        "`communityCashbackPaidCop` sigue importandose de `@/lib/community-view`"
      ).toBe(true);
      expect(importaLaHermana, "la pantalla no importa `communityCashbackOwedCop` de `@/lib/community-view`").toBe(true);

      const alcance = alcanceDeLaVista("CommunityLeaderView");
      expect(
        callPattern("communityCashbackOwedCop").test(alcance),
        "`CommunityLeaderView` no llama a `communityCashbackOwedCop(`: al acreedor no le llega la callable, asi que no tiene de donde sacar su deuda"
      ).toBe(true);

      const i = alcance.search(TEXTO_YA_NO_GOBIERNA);
      expect(i, "falta el texto del acreedor").toBeGreaterThan(-1);
      const rama = fragmentoAlrededor(alcance, i);
      expect(
        /stats\s*[?!]?\.totals\.cashbackPendingCop/.test(rama),
        "la rama del acreedor lee `stats.totals.cashbackPendingCop`: para el acreedor `stats` nunca llega y pintaria cero o reventaria"
      ).toBe(false);
    });
  });

  describe("RF_05 · el enlace perdido no se esconde", () => {
    it("la app recoge `loadReport` de `useAppState` (hoy lo devuelve y nadie lo lee)", () => {
      const cuerpoApp = cuerpoDe(FUNCIONES_PANTALLA, "OperationsApp");
      const match = cuerpoApp.match(/const\s*\{([^}]*)\}\s*=\s*useAppState\s*\(/);
      // Positiva de control: la app sigue desestructurando `useAppState`, y T8 dejo `loadReport` en su retorno.
      expect(match, "`OperationsApp` sigue desestructurando `useAppState(`").not.toBeNull();
      expect(match?.[1] ?? "", "sigue recogiendo `loadOutcome`").toContain("loadOutcome");
      expect(
        /\bloadReport\b/.test(cuerpoDe(FUNCIONES_PANTALLA, "useAppState")),
        "`useAppState` sigue devolviendo `loadReport` (T8)"
      ).toBe(true);
      expect(
        /\bloadReport\b/.test(match?.[1] ?? ""),
        "`OperationsApp` no recoge `loadReport` de `useAppState`: el parte se calcula, se devuelve y se tira"
      ).toBe(true);
    });

    it("`loadReport` llega a `CommunityLeaderView` por prop y el sitio de llamada lo pasa", () => {
      expect(/\bloadReport\b/.test(parametrosDeDeclaracion("CommunityLeaderView")), "`CommunityLeaderView` no recibe la prop `loadReport`").toBe(true);
      expect(
        /\bloadReport=\{/.test(propsDelSitioDeLlamada("CommunityLeaderView")),
        "el sitio de llamada no pasa `loadReport={...}` a `CommunityLeaderView`"
      ).toBe(true);
    });

    it("hay aviso de que el enlace de invitacion no se pudo resolver, condicionado a `issues` con `community_sellers`", () => {
      const alcance = alcanceDeLaVista("CommunityLeaderView");
      // Positiva de control: el enlace se sigue pintando.
      expect(alcance, "el enlace de invitacion se sigue pintando").toContain("inviteUrl");
      expect(
        /"community_sellers"/.test(alcance),
        "la pantalla no mira `\"community_sellers\"` en el parte: la mitad de comunidad degradada apaga el enlace en silencio"
      ).toBe(true);
      expect(/\bissues\b/.test(alcance), "la pantalla no consulta `issues` del parte").toBe(true);
      expect(
        TEXTO_ENLACE_PERDIDO.test(alcance),
        "falta el texto de que el enlace de invitacion no se pudo resolver"
      ).toBe(true);
    });
  });

  describe("NO REGRESION: lo que T9 no puede llevarse por delante", () => {
    it("RF_09 de la 003 · `CommunityLeaderView` sigue sin pintar detalle de pedidos ni datos de cliente", () => {
      // Las guardas vivas de RF_09 (`session-hats.test.ts`, T16 de la 003) atan el REPARTO por
      // sombrero: que la vista de comunidad se despache antes que la del papel y reciba la
      // comunidad, no el perfil. Ninguna mira el CUERPO de la vista, asi que esta es nueva: al
      // anadirle al acreedor su deuda desde `state.settlements`, la tentacion es pintar tambien
      // los pedidos de los cortes, y eso es justo lo que RF_09 prohibe como regla de presentacion.
      const guardasT16 = fuenteCruda(GUARDAS_T16_003);
      expect(guardasT16, "la guarda de reparto de RF_09 sigue existiendo").toContain(
        "RF_09: la vista de comunidad recibe la comunidad, no el perfil operativo"
      );
      const cuerpo = cuerpoDe(FUNCIONES_PANTALLA, "CommunityLeaderView");
      // Positiva de control: el cuerpo sigue pintando la tabla agregada por tienda.
      expect(cuerpo, "la tabla 'Como va cada tienda' sigue ahi").toContain("Como va cada tienda");
      expect(/\bcustomerPhone\b/.test(cuerpo), "la vista de comunidad pinta `customerPhone`").toBe(false);
      expect(/\baddressRaw\b/.test(cuerpo), "la vista de comunidad pinta `addressRaw`").toBe(false);
      expect(/\border\.customer\b/.test(cuerpo), "la vista de comunidad pinta `order.customer`").toBe(false);
    });
  });
});

/*
 * =====================================================================================
 * T11 · RF_01, RF_03, RF_04, RF_05, RNF_02, RNF_04 — El recorrido completo con cuentas
 * desechables (DoD 4 y 5).
 * =====================================================================================
 *
 * T1 dejo `scripts/verify-005.js` con `setup` / `reproduce` / `cleanup` y UNA comunidad con una
 * tienda dentro. El DoD 4 pide cinco casos y el DoD 5 capturas a dos anchos, y nada de eso existe
 * hoy. Como en T1, la suite no puede ejecutar el guion (produccion, cuentas reales): lo que se
 * sostiene aqui es su FORMA, con los mismos extractores (`verifyStep`, `reachable`, `firstReach`).
 * Su ejecucion real es DESPUES de T13, con las reglas desplegadas por el humano.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO DE FORMA que anade T11 al de T1 (los seis puntos de T1 siguen vigentes):
 *
 * 7.  Dos pasos nuevos, `check` y `capture`, elegidos por `process.argv` como los de T1 y con su
 *     funcion `<paso>`/`step<Paso>`/... La cabecera (comentario) documenta el orden con flechas:
 *     `setup -> reproduce -> (T13: desplegar reglas) -> check -> capture -> cleanup`.
 * 8.  `setup` llama a sus ayudantes UNA VEZ por cosa creada, sin bucles: tres comunidades, al menos
 *     tres tiendas (dentro de la 1a, propia del lider fuera, dentro de la 2a) y cuatro cuentas Auth
 *     (tienda-lider, lider puro, lider de la comunidad vacia, tienda sin comunidad). Las guardas
 *     cuentan SITIOS DE LLAMADA en el cuerpo del paso; un `for` los contaria como uno.
 * 9.  Los reclamos se escriben como objetos literales planos con `role:` (`{ role: "seller", ... }`).
 *     La guarda los lee uno a uno: uno `community_leader` sin `sellerId`; uno `seller` SIN
 *     `communityId`; y el de T1 (`seller` con `communityId` y `communityStanding: "leader"`).
 * 10. Los cinco casos de `check` se nombran con estas claves exactas: `tienda_lider`,
 *     `tienda_ajena`, `lider_puro`, `comunidad_vacia`, `tienda_sin_comunidad`. Su evidencia va a
 *     una constante `path.join(<raiz de evidencia>, "verify-check.json")`.
 * 11. `capture` carga Playwright con `require("playwright")` — el UNICO instalado en esta maquina es
 *     el global `/usr/lib/node_modules/playwright` (1.58.2); `@playwright/test` NO esta, y el plan
 *     §5 dice "dependencias nuevas: ninguna", asi que no se anade a package.json. Se resuelve por
 *     `NODE_PATH` o `require.resolve("playwright", { paths: [...] })`, lo que prefiera el coder.
 *     Las medidas de viewport se escriben como `width: <numero>` o `const *WIDTH* = <numero>`.
 * 12. `cleanup` borra una cosa por llamada (sin bucles) y termina con una consulta de verificacion:
 *     rango por `FieldPath.documentId()` sobre el prefijo en Firestore y `listUsers` en Auth,
 *     imprimiendo `LIMPIO` o `QUEDAN`.
 * ---------------------------------------------------------------------------------------------
 */

const T11_STEPS = ["check", "capture"] as const;
const CHECK_CASES = ["tienda_lider", "tienda_ajena", "lider_puro", "comunidad_vacia", "tienda_sin_comunidad"] as const;

/** Como `verifyStepReach`, pero "" si el paso no existe: asi cada guarda afirma sobre un booleano. */
function reachOrEmpty(step: string): string {
  const { functions } = verifyScript();
  try {
    const { name, body } = verifyStep(step, functions);
    return reachable(body, functions, new Set([name]));
  } catch {
    return "";
  }
}

/** Cuerpo del paso SIN sus ayudantes (para contar sitios de llamada), o "" si no existe. */
function stepBodyOrEmpty(step: string): string {
  const { functions } = verifyScript();
  try {
    return verifyStep(step, functions).body;
  } catch {
    return "";
  }
}

/** Sitios de llamada en `body` a funciones locales cuyo alcance cumple `pattern`. */
function callSitesReaching(body: string, pattern: RegExp, functions: LocalFunctions, self: string): number {
  let count = 0;
  for (const name of localCallees(body, functions)) {
    if (name === self) continue;
    if (!pattern.test(reachable(functions.get(name) ?? "", functions, new Set([self, name])))) continue;
    count += (body.match(new RegExp(callPattern(name).source, "g")) ?? []).length;
  }
  return count;
}

/**
 * Constantes enraizadas en `.sdd/evidence/005/`: la de `path.join(REPO_ROOT, ".sdd", "evidence",
 * "005")` y toda `const X = path.join(<una de ellas>, ...)`. Es lo que permite exigir que una captura
 * o un archivo de evidencia cuelguen de ahi sin fijar el nombre de la constante.
 */
function evidenceRootedConstants(source: string): Set<string> {
  const rooted = new Set<string>();
  const root = source.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\([^)]*["']\.sdd["'][^)]*["']evidence["'][^)]*["']005["']\s*\)/);
  if (root) rooted.add(root[1]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*([A-Za-z_$][\w$]*)\b/g)) {
      if (rooted.has(match[2]) && !rooted.has(match[1])) {
        rooted.add(match[1]);
        grew = true;
      }
    }
  }
  return rooted;
}

/** Nombre de la constante `path.join(<enraizada>, "<fileName>")`, o null. */
function evidenceFileConstant(source: string, fileName: string): string | null {
  const rooted = evidenceRootedConstants(source);
  const escaped = fileName.replace(/\./g, "\\.");
  const pattern = new RegExp(
    `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*path\\.join\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*["']${escaped}["']\\s*\\)`,
    "g"
  );
  for (const match of source.matchAll(pattern)) {
    if (rooted.has(match[2])) return match[1];
  }
  return null;
}

/** Objetos literales planos con `role:` (punto 9 del contrato). */
function claimLiterals(text: string): string[] {
  return [...text.matchAll(/\{[^{}]*\brole\s*:\s*["'][a-z_]+["'][^{}]*\}/g)].map((m) => m[0]);
}

/** Anchos de viewport declarados: `width: N` y `const *WIDTH* = N` (punto 11 del contrato). */
function viewportWidths(source: string): number[] {
  const widths: number[] = [];
  for (const m of source.matchAll(/\bwidth\s*:\s*(\d+)\b/g)) widths.push(Number(m[1]));
  for (const m of source.matchAll(/\bconst\s+[A-Za-z_$]*(?:WIDTH|Width)[\w$]*\s*=\s*(\d+)\b/g)) widths.push(Number(m[1]));
  return widths;
}

describe("T11 · RF_01, RF_03, RF_04, RF_05, RNF_02, RNF_04: el recorrido completo con cuentas desechables (DoD 4 y 5)", () => {
  describe("forma: dos pasos nuevos y el orden documentado", () => {
    it.each(T11_STEPS)("DoD 4 · el paso `%s` es una rama del argumento con su funcion", (step) => {
      const { source, functions } = verifyScript();
      // Positiva de control: el reparto por argumento que dejo T1 sigue ahi.
      expect(/process\.argv/.test(source), "el guion sigue eligiendo el paso por process.argv").toBe(true);
      const isBranch = new RegExp(`["'\`]${step}["'\`]|\\b${step}\\s*:|[{,]\\s*${step}\\s*[,}]`).test(source);
      expect(isBranch, `el guion no tiene la rama \`${step}\``).toBe(true);
      let hasFunction = true;
      try {
        verifyStep(step, functions);
      } catch {
        hasFunction = false;
      }
      expect(hasFunction, `no hay funcion para el paso \`${step}\` (punto 2 del contrato de T1)`).toBe(true);
    });

    it("DoD 4 · la cabecera documenta el orden setup -> reproduce -> (T13) -> check -> capture -> cleanup", () => {
      const raw = fuenteCruda(VERIFY_SCRIPT);
      // Positiva de control: la cabecera sigue existiendo y nombra los pasos de T1.
      const header = raw.slice(0, 6000);
      expect(header.includes("setup") && header.includes("cleanup"), "la cabecera nombra los pasos").toBe(true);
      const step = (name: string) => `\`?${name}\`?`;
      const order = new RegExp(
        `${step("setup")}\\s*->\\s*${step("reproduce")}\\s*->\\s*\\([^)]*T13[^)]*\\)\\s*->\\s*${step("check")}\\s*->\\s*${step("capture")}\\s*->\\s*${step("cleanup")}`
      );
      expect(
        order.test(raw),
        "la cabecera no documenta el orden con T13 (reglas desplegadas por el humano) entre reproduce y check"
      ).toBe(true);
    });

    it("plan §5 · Playwright no entra en package.json: se usa el global ya instalado", () => {
      const packageJson = JSON.parse(fuenteCruda("package.json")) as Record<string, Record<string, string> | undefined>;
      const declared = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
      // Positiva de control: el package.json se leyo y es el de la app.
      expect(Object.keys(declared).length > 0, "package.json declara dependencias").toBe(true);
      expect(
        Object.keys(declared).some((name) => /playwright/i.test(name)),
        "package.json declara playwright: el plan §5 dice 'dependencias nuevas: ninguna' (el global de /usr/lib/node_modules basta)"
      ).toBe(false);
    });
  });

  describe("setup: tres comunidades, sus tiendas y cuatro cuentas", () => {
    it("DoD 4 · setup crea tres comunidades (la del lider, otra con tienda dentro y una vacia), una llamada por comunidad", () => {
      const { functions } = verifyScript();
      const body = stepBodyOrEmpty("setup");
      // Positiva de control: setup existe y crea la comunidad de T1.
      expect(body.length > 0, "setup existe").toBe(true);
      const communityCalls = callSitesReaching(body, /["']communities["']/, functions, "stepSetup");
      expect(communityCalls > 0, "setup sigue creando al menos una comunidad").toBe(true);
      expect(
        communityCalls >= 3,
        `setup crea ${communityCalls} comunidad(es): hacen falta tres (RNF_02 exige OTRA comunidad; RF_11 exige una VACIA)`
      ).toBe(true);
    });

    it("DoD 4 · setup crea al menos tres tiendas: dentro de la 1a, la propia del lider fuera, y dentro de la 2a", () => {
      const { functions } = verifyScript();
      const body = stepBodyOrEmpty("setup");
      expect(body.length > 0, "setup existe").toBe(true);
      const sellerCalls = callSitesReaching(body, /["']sellers["']/, functions, "stepSetup");
      expect(sellerCalls > 0, "setup sigue creando tiendas").toBe(true);
      expect(
        sellerCalls >= 3,
        `setup crea ${sellerCalls} tienda(s): sin una tienda dentro de la OTRA comunidad no hay caso tienda_ajena`
      ).toBe(true);
    });

    it("DoD 4 · setup crea cuatro cuentas Auth: tienda-lider, lider puro, lider de la vacia y tienda sin comunidad", () => {
      const { functions } = verifyScript();
      const body = stepBodyOrEmpty("setup");
      expect(body.length > 0, "setup existe").toBe(true);
      const accountCalls = callSitesReaching(body, /\bcreateUser\s*\(/, functions, "stepSetup");
      expect(accountCalls > 0, "setup sigue creando la cuenta desechable de T1").toBe(true);
      expect(accountCalls >= 4, `setup crea ${accountCalls} cuenta(s) Auth: los cinco casos necesitan cuatro`).toBe(true);
    });

    it("RF_05, RNF_01 · los reclamos cubren al lider puro (sin sellerId) y a la tienda sin comunidad", () => {
      const reach = reachOrEmpty("setup");
      const claims = claimLiterals(reach);
      // Positiva de control: el reclamo de T1 (tienda-lider con communityStanding leader) sigue ahi.
      const hasStoreLeader = claims.some(
        (c) => /role\s*:\s*["']seller["']/.test(c) && /\bcommunityId\b/.test(c) && /communityStanding\s*:\s*["']leader["']/.test(c)
      );
      expect(hasStoreLeader, "setup sigue escribiendo el reclamo tienda-lider de T1").toBe(true);
      const hasPureLeader = claims.some((c) => /role\s*:\s*["']community_leader["']/.test(c) && !/\bsellerId\b/.test(c));
      expect(hasPureLeader, 'no hay reclamo `role: "community_leader"` sin sellerId: falta el lider puro (RF_05)').toBe(true);
      const hasStoreWithoutCommunity = claims.some((c) => /role\s*:\s*["']seller["']/.test(c) && !/\bcommunityId\b/.test(c));
      expect(hasStoreWithoutCommunity, 'no hay reclamo `role: "seller"` sin communityId: falta la tienda sin comunidad (RNF_01)').toBe(true);
    });

    it("DoD 4 · todo id que setup construye con plantilla arranca por el prefijo (NO REGRESION: pasa hoy; vigila lo nuevo)", () => {
      const { source } = verifyScript();
      const [prefixName] = verifyPrefix(source);
      const reach = reachOrEmpty("setup");
      expect(reach.includes(prefixName), "setup usa la constante de prefijo").toBe(true);
      // Un id de comunidad o de tienda construido sin `${PREFIX}` seria una cosa real, o una que
      // cleanup —que solo borra lo que lleva el prefijo— dejaria atras. Un id no lleva espacios:
      // asi se separan de los mensajes de consola, que tambien interpolan.
      const templatedIds = [...reach.matchAll(/`([^`]*)`/g)]
        .map((m) => m[1])
        .filter((t) => !/\s/.test(t) && /\b(?:com|seller|leader|uid)\b/.test(t) && /\$\{/.test(t));
      expect(templatedIds.length > 0, "setup construye ids con plantilla").toBe(true);
      const withoutPrefix = templatedIds.filter((t) => !t.includes(`\${${prefixName}}`) && !/^\$\{[A-Za-z_$][\w$]*\}/.test(t));
      expect(withoutPrefix.length === 0, `ids construidos sin el prefijo: ${withoutPrefix.join(" | ")}`).toBe(true);
    });
  });

  describe("check: los cinco casos del DoD 4, por REST y solo lectura", () => {
    it("RF_01, RF_05 · check entra por REST y nombra los cinco casos con sus claves", () => {
      const reach = reachOrEmpty("check");
      expect(reach.length > 0, "el paso `check` no existe").toBe(true);
      expect(reach.includes("signInWithPassword"), "check no entra con signInWithPassword").toBe(true);
      expect(/["']sellers["']/.test(reach), "check no pide tiendas").toBe(true);
      expect(/\bcommunityId\b/.test(reach), "check no consulta por communityId").toBe(true);
      for (const caseName of CHECK_CASES) {
        expect(new RegExp(`\\b${caseName}\\b`).test(reach), `check no cubre el caso \`${caseName}\``).toBe(true);
      }
    });

    it("RNF_02 · el caso tienda_ajena espera una negativa (403 / PERMISSION_DENIED)", () => {
      const reach = reachOrEmpty("check");
      expect(/\btienda_ajena\b/.test(reach), "check no cubre tienda_ajena").toBe(true);
      expect(
        /\b403\b|PERMISSION_DENIED/.test(reach),
        "check no distingue una negativa de permisos: tienda_ajena no puede darse por PASA sin ella"
      ).toBe(true);
    });

    it("RF_11 · el caso comunidad_vacia espera cero documentos sin error", () => {
      const reach = reachOrEmpty("check");
      expect(/\bcomunidad_vacia\b/.test(reach), "check no cubre comunidad_vacia").toBe(true);
      expect(
        /(?:documentCount|\.size|\.length|\bcount)\s*===?\s*0\b/.test(reach),
        "check no compara el resultado de la comunidad vacia con 0"
      ).toBe(true);
    });

    it("DoD 4 · check imprime PASA/FALLA por caso y vuelca verify-check.json bajo la evidencia", () => {
      const { source } = verifyScript();
      const reach = reachOrEmpty("check");
      expect(reach.length > 0, "el paso `check` no existe").toBe(true);
      expect(/\bPASA\b/.test(reach) && /\bFALLA\b/.test(reach), "check no imprime PASA/FALLA").toBe(true);
      const checkFile = evidenceFileConstant(source, "verify-check.json");
      expect(checkFile !== null, 'no hay constante path.join(<evidencia 005>, "verify-check.json")').toBe(true);
      expect(checkFile !== null && reach.includes(checkFile), "check no escribe en la constante de verify-check.json").toBe(true);
      expect(FILE_WRITE.test(reach), "check no escribe ningun archivo").toBe(true);
    });

    it("RNF_02 · check NO escribe en Firestore ni en Auth", () => {
      const reach = reachOrEmpty("check");
      // Positiva de control emparejada: el recorte tiene cuerpo y entra por REST.
      expect(reach.includes("signInWithPassword"), "el cuerpo alcanzado por check no esta vacio").toBe(true);
      expect(FIRESTORE_WRITE.test(reach), "check escribe en Firestore o en Auth: solo puede medir").toBe(false);
    });
  });

  describe("capture: DoD 5, RNF_04 — el selector y las dos pantallas a dos anchos", () => {
    it("RNF_04 · capture usa el Playwright instalado (`playwright` global), no `@playwright/test`", () => {
      const { source } = verifyScript();
      const reach = reachOrEmpty("capture");
      expect(reach.length > 0, "el paso `capture` no existe").toBe(true);
      const usesPlaywright = /require(?:\.resolve)?\(\s*["']playwright["']/.test(source);
      expect(usesPlaywright, "el guion no carga `playwright` (es el unico instalado: /usr/lib/node_modules/playwright)").toBe(true);
      expect(/@playwright\/test/.test(source), "el guion pide `@playwright/test`, que no esta instalado en ningun sitio").toBe(false);
    });

    it("RNF_04 · la URL base llega por --base-url o entorno, con localhost:3000 por defecto", () => {
      const reach = reachOrEmpty("capture");
      expect(reach.length > 0, "el paso `capture` no existe").toBe(true);
      expect(/--base-url/.test(reach), "capture no acepta --base-url").toBe(true);
      expect(/process\.env\b/.test(reach), "capture no mira ninguna variable de entorno para la URL base").toBe(true);
      expect(
        /localhost:3000/.test(reach),
        "capture no cae a http://localhost:3000 (la interfaz nueva solo existe en local hasta el hosting)"
      ).toBe(true);
    });

    it("RNF_04 · entra como la cuenta tienda-lider del estado", () => {
      const reach = reachOrEmpty("capture");
      expect(reach.length > 0, "el paso `capture` no existe").toBe(true);
      expect(
        /\bemail\b/.test(reach) && /\bpassword\b/.test(reach),
        "capture no usa el email y la contrasena de la cuenta desechable"
      ).toBe(true);
    });

    it("RNF_04 · dos viewports: escritorio y 390 px de ancho", () => {
      const { source } = verifyScript();
      const reach = reachOrEmpty("capture");
      expect(reach.length > 0, "el paso `capture` no existe").toBe(true);
      expect(/setViewportSize\s*\(|\bviewport\s*:/.test(reach), "capture no fija el viewport (setViewportSize o viewport:)").toBe(true);
      const widths = viewportWidths(source);
      expect(widths.includes(390), `no hay ancho 390 declarado (anchos vistos: ${widths.join(", ") || "ninguno"})`).toBe(true);
      expect(
        widths.some((w) => w >= 1024),
        `no hay ancho de escritorio (>= 1024) declarado (anchos vistos: ${widths.join(", ") || "ninguno"})`
      ).toBe(true);
    });

    it("DoD 5 · guarda .png bajo .sdd/evidence/005/", () => {
      const { source } = verifyScript();
      const reach = reachOrEmpty("capture");
      expect(reach.length > 0, "el paso `capture` no existe").toBe(true);
      expect(/\bscreenshot\s*\(/.test(reach), "capture no toma capturas").toBe(true);
      expect(/\.png\b/.test(reach), "capture no escribe .png").toBe(true);
      const rooted = evidenceRootedConstants(source);
      expect(rooted.size > 0, "hay una constante enraizada en .sdd/evidence/005").toBe(true);
      expect(
        [...rooted].some((name) => reach.includes(name)),
        "las capturas no cuelgan de una constante enraizada en .sdd/evidence/005"
      ).toBe(true);
    });

    it("RNF_02 · capture NO escribe en Firestore ni en Auth", () => {
      const reach = reachOrEmpty("capture");
      expect(/\bscreenshot\s*\(/.test(reach), "el cuerpo alcanzado por capture no esta vacio").toBe(true);
      expect(FIRESTORE_WRITE.test(reach), "capture escribe en Firestore o en Auth").toBe(false);
    });
  });

  describe("cleanup ampliado: borra todo lo nuevo y comprueba que no queda nada", () => {
    it("DoD 4 · cleanup borra tres comunidades, al menos tres tiendas y cuatro cuentas, comprobando el prefijo", () => {
      const { source, functions } = verifyScript();
      const [prefixName] = verifyPrefix(source);
      const body = stepBodyOrEmpty("cleanup");
      const reach = reachOrEmpty("cleanup");
      // Positivas de control: cleanup sigue borrando y sigue negandose sin prefijo (T1).
      expect(FIRESTORE_DELETE.test(reach), "cleanup alcanza una eliminacion").toBe(true);
      expect(
        new RegExp(`\\.startsWith\\(\\s*${prefixName}\\s*\\)`).test(reach),
        "cleanup comprueba el prefijo antes de borrar"
      ).toBe(true);
      const communities = (body.match(/["']communities["']/g) ?? []).length;
      const sellers = (body.match(/["']sellers["']/g) ?? []).length;
      const accounts = callSitesReaching(body, /\bdeleteUser\s*\(/, functions, "stepCleanup");
      expect(communities >= 3, `cleanup borra ${communities} comunidad(es) por nombre: setup crea tres`).toBe(true);
      expect(sellers >= 3, `cleanup borra ${sellers} tienda(s) por nombre: setup crea al menos tres`).toBe(true);
      expect(accounts >= 4, `cleanup borra ${accounts} cuenta(s) Auth: setup crea cuatro`).toBe(true);
    });

    it("DoD 4 · sigue siendo idempotente: comprueba la existencia antes de cada borrado", () => {
      const reach = reachOrEmpty("cleanup");
      expect(FIRESTORE_DELETE.test(reach), "cleanup alcanza una eliminacion").toBe(true);
      expect(/\.exists\b/.test(reach), "cleanup no comprueba `.exists` antes de borrar un documento").toBe(true);
      expect(/\bfindAuthUser\s*\(|auth\/user-not-found/.test(reach), "cleanup no tolera una cuenta ya borrada").toBe(true);
    });

    it("DoD 4 · al final consulta por prefijo (Firestore y Auth) e imprime LIMPIO o QUEDAN", () => {
      const { functions } = verifyScript();
      const body = stepBodyOrEmpty("cleanup");
      const reach = reachOrEmpty("cleanup");
      expect(reach.length > 0, "cleanup existe").toBe(true);
      expect(/FieldPath\.documentId\(\)/.test(reach), "cleanup no consulta Firestore por rango de id con el prefijo").toBe(true);
      expect(/\blistUsers\s*\(/.test(reach), "cleanup no repasa las cuentas Auth con listUsers").toBe(true);
      expect(/\bLIMPIO\b/.test(reach) && /\bQUEDAN\b/.test(reach), "cleanup no imprime LIMPIO/QUEDAN").toBe(true);
      const firstDelete = firstReach(body, FIRESTORE_DELETE, functions, "stepCleanup");
      const verdict = firstReach(body, /\bLIMPIO\b/, functions, "stepCleanup");
      expect(firstDelete >= 0 && verdict >= 0, "cleanup borra y emite veredicto").toBe(true);
      expect(
        verdict > firstDelete,
        "la comprobacion final va ANTES del primer borrado: contaria lo que esta a punto de borrarse"
      ).toBe(true);
    });

    it("DoD 4 · la consulta de verificacion no rompe la guarda de T1: toda .where( sigue filtrando por id o vinculo", () => {
      const reach = reachOrEmpty("cleanup");
      expect(reach.length > 0, "cleanup existe").toBe(true);
      const whereFields = [...reach.matchAll(/\.where\(\s*([^,]+),/g)].map((m) => m[1].trim());
      expect(whereFields.length > 0, "cleanup hace al menos una consulta (la de verificacion)").toBe(true);
      const offending = whereFields.filter((f) => !/^["'](?:communityId|sellerId|uid)["']$|FieldPath\.documentId\(\)$/.test(f));
      expect(offending.length === 0, `.where( sobre campos no permitidos: ${offending.join(" | ")}`).toBe(true);
    });
  });

  describe("ningun paso nuevo toca el registro de dinero", () => {
    it.each(T11_STEPS)("DoD 4 · el paso `%s` no nombra walletEntries ni settlements", (step) => {
      const reach = reachOrEmpty(step);
      expect(reach.length > 0, `el paso \`${step}\` no existe`).toBe(true);
      expect(
        MONEY_COLLECTIONS.test(reach),
        `el paso \`${step}\` nombra walletEntries o settlements (el acreedor NO se prueba en produccion)`
      ).toBe(false);
    });
  });
});

describe("T14 · RF_05, RF_10: el indice que exige `sum(amountCop)` con rango de `createdAt` en getCommunityStats", () => {
  /**
   * Hallazgo real (captura de T11, 2026-09-15): la pantalla decia "No se pudieron cargar tus cifras —
   * INTERNAL" y Cloud Run registro `9 FAILED_PRECONDITION: The query requires an index`. El enlace de
   * creacion pedia en `walletEntries`: ownerId ASC, ownerType ASC, createdAt ASC, amountCop ASC.
   *
   * Orden elegido: las dos igualdades (`ownerId`, `ownerType`) se aceptan en cualquier orden porque
   * Firestore las empareja como conjunto; la desigualdad (`createdAt`) y el campo agregado (`amountCop`)
   * van al final Y en ese orden, porque es lo unico que sirve a la consulta. Un indice con `amountCop`
   * antes de `createdAt` no la resolveria y la guarda debe rechazarlo.
   */
  type IndexField = { fieldPath: string; order?: string; arrayConfig?: string };
  type FirestoreIndex = { collectionGroup: string; queryScope: string; fields: IndexField[] };

  function loadIndexes(): FirestoreIndex[] {
    const raw = readFileSync(fileURLToPath(new URL("../../firestore.indexes.json", import.meta.url)), "utf8");
    const parsed = JSON.parse(raw) as { indexes?: FirestoreIndex[] };
    return parsed.indexes ?? [];
  }

  function walletEntriesIndexes(): IndexField[][] {
    return loadIndexes()
      .filter((ix) => ix.collectionGroup === "walletEntries" && ix.queryScope === "COLLECTION")
      .map((ix) => ix.fields.filter((f) => f.fieldPath !== "__name__"));
  }

  function servesCashbackSum(fields: IndexField[]): boolean {
    if (fields.length !== 4) return false;
    if (!fields.every((f) => f.order === "ASCENDING")) return false;
    const equalities = new Set(fields.slice(0, 2).map((f) => f.fieldPath));
    return (
      equalities.has("ownerId") &&
      equalities.has("ownerType") &&
      fields[2].fieldPath === "createdAt" &&
      fields[3].fieldPath === "amountCop"
    );
  }

  it("control · el archivo parsea y ya contiene (ownerType, ownerId, createdAt ASC), que es el indice de hoy", () => {
    const present = walletEntriesIndexes().some(
      (fields) =>
        fields.length === 3 &&
        fields[0].fieldPath === "ownerType" &&
        fields[1].fieldPath === "ownerId" &&
        fields[2].fieldPath === "createdAt" &&
        fields.every((f) => f.order === "ASCENDING")
    );
    expect(present, "falta el indice (ownerType, ownerId, createdAt ASC) que existe hoy: el lector esta roto").toBe(true);
  });

  it("RF_05/RF_10 · existe el indice compuesto (ownerId, ownerType, createdAt, amountCop) ASC que pide Firestore", () => {
    const shapes = walletEntriesIndexes().map((fields) => fields.map((f) => `${f.fieldPath}:${f.order}`).join(","));
    expect(
      walletEntriesIndexes().some(servesCashbackSum),
      `ningun indice de walletEntries sirve a sum(amountCop) con rango de createdAt. Hay: ${shapes.join(" | ")}`
    ).toBe(true);
  });

  it("no regresion · el archivo conserva los 39 indices actuales (desplegar BORRA los que falten)", () => {
    expect(loadIndexes().length, "el archivo tiene menos indices que en produccion: desplegarlo borraria los que falten").toBeGreaterThanOrEqual(39);
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * T16 · RF_05: el lider ve sus tiendas aunque no hayan movido pedidos.
 *
 * Hoy la tarjeta "Como va cada tienda" pinta la tabla en la rama FALSA de un ternario sobre
 * `stats.emptiness === "no_orders_in_period"`: con cero pedidos creados en el periodo el lider ve
 * "1 sin pedidos en el periodo" y NINGUN nombre (Brayan, E-master). Los datos ya llegan: el
 * servidor recorre todas las tiendas (`functions/src/community-stats.ts`) y `buildCommunityStats`
 * produce `byStore` con ceros — lo afirma `community-stats.test.ts` en "RF_29, RF_30: agrega el
 * total y el desglose por tienda" (`byStore` tiene 3 filas con `seller-3` a 0 creados e
 * `inactiveStores` = 1). Lo que falta es que la pantalla pinte esas filas.
 *
 * Extractores: los seguros de T8/T9 (`alcanceDeLaVista`), nunca `localFunctions`.
 * ---------------------------------------------------------------------------------------------
 */

const TEXTO_SIN_PEDIDOS = "Tus tiendas no movieron pedidos en este periodo";

/** La tarjeta de tiendas: desde su titulo hasta el `stats.byStore.map` que pinta las filas. */
function tarjetaDeTiendas(alcance: string): string {
  const inicio = alcance.indexOf("Como va cada tienda");
  const fin = alcance.indexOf("stats.byStore.map", inicio);
  if (inicio < 0 || fin < 0) throw new Error("No se encuentra la tarjeta 'Como va cada tienda' con su `stats.byStore.map`.");
  return alcance.slice(inicio, fin);
}

describe("T16 · RF_05: el lider ve sus tiendas aunque no hayan movido pedidos", () => {
  it("el recorte trae la tarjeta de tiendas y la tabla (positiva de control)", () => {
    const alcance = alcanceDeLaVista("CommunityLeaderView");
    expect(alcance, "la tarjeta 'Como va cada tienda' sigue ahi").toContain("Como va cada tienda");
    expect(alcance, "la tabla sigue recorriendo `stats.byStore`").toContain("stats.byStore.map");
    expect(tarjetaDeTiendas(alcance), "la tarjeta tiene su cabecera de tabla").toContain("<table");
  });

  it("RF_05 · la tabla de tiendas NO cuelga de un ternario sobre `no_orders_in_period`", () => {
    const alcance = alcanceDeLaVista("CommunityLeaderView");
    const tarjeta = tarjetaDeTiendas(alcance);
    // Positiva de control: el aviso de periodo sin movimiento sigue en la vista (RF_33 de la 004).
    expect(alcance, "la vista ya no distingue el periodo sin pedidos").toContain(TEXTO_SIN_PEDIDOS);
    expect(
      /emptiness\s*===\s*["']no_orders_in_period["']\s*\?/.test(tarjeta),
      "la tabla de tiendas esta en la rama falsa de `emptiness === \"no_orders_in_period\" ?`: con cero pedidos el lider no ve ningun nombre"
    ).toBe(false);
    expect(
      /\bno_orders_in_period\b/.test(tarjeta),
      "entre el titulo de la tarjeta y `stats.byStore.map` se decide por `no_orders_in_period`: la tabla depende de que haya pedidos"
    ).toBe(false);
  });

  it("RF_05 · el aviso de 'no movieron pedidos' sigue existiendo, y la tabla depende de que haya tiendas, no de que haya pedidos", () => {
    const alcance = alcanceDeLaVista("CommunityLeaderView");
    // No regresion: el aviso de periodo sin movimiento no desaparece.
    expect(alcance, "se perdio el aviso 'Tus tiendas no movieron pedidos en este periodo'").toContain(TEXTO_SIN_PEDIDOS);

    const tarjeta = tarjetaDeTiendas(alcance);
    expect(
      /totals\.created\b|totals\.inactiveStores\b|totals\.activeStores\b/.test(tarjeta),
      "la tabla se condiciona a contadores de pedidos (`totals.created`/`activeStores`): eso es 'hay pedidos', no 'hay tiendas'"
    ).toBe(false);

    // "Hay tiendas" se decide o en la tarjeta (`byStore.length`) o antes, porque la vista ya devuelve
    // la tarjeta `no_stores` sin llegar aqui. Cualquiera de las dos vale.
    const enLaTarjeta = /byStore\s*\.\s*length\b|byStore\s*\.\s*some\b|["']no_stores["']/.test(tarjeta);
    const indiceNoStores = alcance.search(/view\s*\.\s*kind\s*===\s*["']no_stores["']/);
    const antesDeLaTarjeta = indiceNoStores > -1 && indiceNoStores < alcance.indexOf("Como va cada tienda");
    expect(
      enLaTarjeta || antesDeLaTarjeta,
      "ni la tarjeta mira `stats.byStore.length` ni la vista resuelve `no_stores` antes: no hay quien garantice que la tabla se pinte cuando hay tiendas"
    ).toBe(true);
    // Y la tabla no puede seguir siendo la rama falsa del aviso.
    expect(
      /\?\s*\(\s*<p[^>]*>\s*Tus tiendas no movieron/.test(tarjeta),
      "la tabla sigue siendo la rama falsa del aviso 'no movieron pedidos': tiendas sin pedidos = tabla invisible"
    ).toBe(false);
  });

  it("RF_05 · las filas siguen mostrando el nombre de la tienda (`sellerNames[row.sellerId]`), no solo el id", () => {
    const alcance = alcanceDeLaVista("CommunityLeaderView");
    const i = alcance.indexOf("stats.byStore.map");
    expect(i).toBeGreaterThan(-1);
    const filas = alcance.slice(i, i + 1200);
    expect(/sellerNames\[\s*row\.sellerId\s*\]/.test(filas), "las filas dejaron de pintar `sellerNames[row.sellerId]`").toBe(true);
    expect(/\brow\.created\b/.test(filas), "las filas dejaron de pintar `row.created` (una tienda sin pedidos debe verse con su 0)").toBe(true);
  });

  it("RF_09 de la 003 · el recorte sigue sin datos de cliente ni saldos (complementa la guarda de T9)", () => {
    // `customerPhone`, `addressRaw` y `order.customer` ya los cubre "NO REGRESION: lo que T9 no
    // puede llevarse por delante" sobre el CUERPO; aqui se anade `sellerBalance` y se mira el
    // ALCANCE (cuerpo + funciones de aviso), que es donde una tabla nueva podria colarlos.
    const alcance = alcanceDeLaVista("CommunityLeaderView");
    expect(alcance, "positiva de control: el recorte es el de la pantalla de comunidad").toContain("Como va cada tienda");
    expect(/\bsellerBalance\b/.test(alcance), "la vista de comunidad pinta `sellerBalance` (RF_09 de la 003)").toBe(false);
    expect(/\bcustomerPhone\b/.test(alcance), "el alcance de la vista de comunidad pinta `customerPhone`").toBe(false);
    expect(/\baddressRaw\b/.test(alcance), "el alcance de la vista de comunidad pinta `addressRaw`").toBe(false);
    expect(/\border\.customer\b/.test(alcance), "el alcance de la vista de comunidad pinta `order.customer`").toBe(false);
  });
});
