/**
 * T11 (spec 003) · El nucleo del selector de sombreros. RF_07, RF_10, RF_11.
 *
 * Decide QUE sombreros tiene una cuenta, CUAL se abre primero y SI hay que ensenar un selector.
 * Nada mas. Sin React, sin Firestore, sin sesion: solo los reclamos.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO QUE ESTA PRUEBA FIJA (`src/lib/session-hats.ts`):
 *
 *   export type Hat = "operational" | "community";
 *
 *   export type SessionClaims = {
 *     role: Role;
 *     sellerId?: string;
 *     driverId?: string;
 *     messengerId?: string;
 *     communityId?: string;
 *     communityStanding?: "leader" | "creditor";
 *   };
 *
 *   export function availableHats(claims: SessionClaims): readonly Hat[];
 *   export function defaultHat(claims: SessionClaims): Hat;
 *   export function shouldShowHatSelector(claims: SessionClaims): boolean;
 *
 * Las tres reglas que se derivan de los casos de abajo, escritas para que el implementador no
 * tenga que adivinarlas:
 *
 *   1. Sombrero OPERATIVO  <=> `role !== "community_leader"`. Los otros cinco papeles operan.
 *   2. Sombrero COMUNIDAD  <=> hay VINCULO (`communityId` no vacio) O el papel es
 *      `community_leader`. El vinculo basta: la POSICION (`leader` / `creditor`) NO entra en
 *      esta decision — ver el caso de RF_11 del acreedor, que es el que justifica que T5 exista.
 *   3. Selector           <=> hay mas de un sombrero. Exactamente eso, sin condiciones aparte.
 *
 * ---------------------------------------------------------------------------------------------
 * POR QUE LA CARGA ES DIFERIDA: en fase RED el modulo no existe. Con un `import` estatico el
 * archivo entero no se recoge y el fallo es uno solo, "no se pudo cargar"; con `await import`
 * cada `it()` falla por separado y el rojo dice QUE caso falta, que es la informacion util.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Role } from "./types";

type SessionHatsModule = typeof import("./session-hats");
const cargar = async (): Promise<SessionHatsModule> => import("./session-hats");

/** Espejo local del contrato: si el modulo se aparta de esta forma, los fixtures no compilan. */
type Claims = {
  role: Role;
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
  communityId?: string;
  communityStanding?: "leader" | "creditor";
};

const COMUNIDAD = "com-andes";

const LOS_SEIS_PAPELES: readonly Role[] = [
  "admin",
  "seller",
  "seller_logistics",
  "driver",
  "messenger",
  "community_leader"
];

/** Vendedor corriente: una tienda y nada mas. El caso mayoritario de produccion. */
const TIENDA: Claims = { role: "seller", sellerId: "sel-1" };

/** Lider "puro": su unico papel es la comunidad. Asi se emiten hoy los reclamos de un lider. */
const LIDER_PURO: Claims = { role: "community_leader", communityId: COMUNIDAD };

/** Tienda que ademas lidera: dos papeles de verdad, una sola cuenta. */
const TIENDA_QUE_LIDERA: Claims = {
  role: "seller",
  sellerId: "sel-1",
  communityId: COMUNIDAD,
  communityStanding: "leader"
};

/** Tienda retirada del mando a la que se le sigue debiendo lo ya causado (RF_22, RF_23). */
const TIENDA_ACREEDORA: Claims = {
  role: "seller",
  sellerId: "sel-1",
  communityId: COMUNIDAD,
  communityStanding: "creditor"
};

/** Congela en profundidad para poder afirmar que nadie escribe sobre los reclamos. */
const congelar = <T>(valor: T): T => {
  Object.freeze(valor);
  for (const clave of Object.keys(valor as Record<string, unknown>)) {
    const hijo = (valor as Record<string, unknown>)[clave];
    if (hijo !== null && typeof hijo === "object") congelar(hijo);
  }
  return valor;
};

describe("T11 · RF_11: quien no elige no decide nada", () => {
  it("RF_11: un vendedor sin vinculo tiene UN sombrero y NO ve selector", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    expect(availableHats(TIENDA)).toEqual(["operational"]);
    expect(shouldShowHatSelector(TIENDA)).toBe(false);
  });

  it("RF_11: un lider puro tampoco ve selector — tiene un solo papel, aunque sea el de comunidad", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    expect(availableHats(LIDER_PURO)).toEqual(["community"]);
    expect(shouldShowHatSelector(LIDER_PURO)).toBe(false);
  });

  it("RF_11: los SEIS papeles sin vinculo se quedan sin selector — tabla exhaustiva", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    // Exhaustiva a proposito: anadir un septimo papel a `Role` rompe esta tabla y obliga a
    // decidir que sombreros le tocan, en vez de heredar un default silencioso.
    for (const role of LOS_SEIS_PAPELES) {
      const sinVinculo: Claims = { role };
      expect(availableHats(sinVinculo), `papel ${role}`).toHaveLength(1);
      expect(shouldShowHatSelector(sinVinculo), `papel ${role}`).toBe(false);
    }
    expect(LOS_SEIS_PAPELES).toHaveLength(6);
  });

  it("RF_11: ningun papel se queda sin sombrero — la lista nunca es vacia", async () => {
    const { availableHats, defaultHat } = await cargar();
    // Sin esto, `community_leader` sin `communityId` (reclamo degradado, o recien creado antes
    // del vinculo) tendria cero sombreros y la pantalla no tendria nada que pintar.
    for (const role of LOS_SEIS_PAPELES) {
      const hats = availableHats({ role });
      expect(hats.length, `papel ${role}`).toBeGreaterThan(0);
      expect(hats, `papel ${role}`).toContain(defaultHat({ role }));
    }
  });
});

describe("T11 · RF_07: quien tiene los dos papeles elige", () => {
  it("RF_07: una tienda CON vinculo de lider tiene DOS sombreros y SI ve selector", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    expect(availableHats(TIENDA_QUE_LIDERA)).toEqual(["operational", "community"]);
    expect(shouldShowHatSelector(TIENDA_QUE_LIDERA)).toBe(true);
  });

  it("RF_11: una tienda con vinculo de ACREEDOR ve selector igual — ya no lidera, pero cobra", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    // Este es el caso que justifica que T5 exista. Si la POSICION entrara en esta decision, a
    // quien se retira se le esconderia la unica pantalla desde la que cobra lo ya causado: el
    // vinculo sobrevive al retiro (RF_22, RF_23), y con el vinculo sobrevive el sombrero.
    expect(availableHats(TIENDA_ACREEDORA)).toEqual(["operational", "community"]);
    expect(shouldShowHatSelector(TIENDA_ACREEDORA)).toBe(true);
  });

  it("RF_07: la POSICION no cambia los sombreros — lider, acreedor y ausente dan lo mismo", async () => {
    const { availableHats } = await cargar();
    const sinPosicion: Claims = { role: "seller", sellerId: "sel-1", communityId: COMUNIDAD };
    // Ausente == `leader` (asi esta produccion hoy), pero aqui ni siquiera hay que distinguirlo.
    expect(availableHats(sinPosicion)).toEqual(availableHats(TIENDA_QUE_LIDERA));
    expect(availableHats(sinPosicion)).toEqual(availableHats(TIENDA_ACREEDORA));
  });

  it("RF_07: un domiciliario acreedor tambien elige — el segundo papel no es cosa de tiendas", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    const domiciliarioAcreedor: Claims = {
      role: "driver",
      driverId: "drv-1",
      communityId: COMUNIDAD,
      communityStanding: "creditor"
    };
    expect(availableHats(domiciliarioAcreedor)).toEqual(["operational", "community"]);
    expect(shouldShowHatSelector(domiciliarioAcreedor)).toBe(true);
  });

  it("RF_07: un administrador con vinculo elige tambien — administrar es un papel operativo", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    const adminConVinculo: Claims = { role: "admin", communityId: COMUNIDAD };
    expect(availableHats(adminConVinculo)).toEqual(["operational", "community"]);
    expect(shouldShowHatSelector(adminConVinculo)).toBe(true);
  });

  it("RF_07: el selector aparece exactamente cuando hay mas de un sombrero, sin excepciones", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    const matriz: readonly Claims[] = [
      TIENDA,
      LIDER_PURO,
      TIENDA_QUE_LIDERA,
      TIENDA_ACREEDORA,
      { role: "messenger", messengerId: "msg-1" },
      { role: "seller_logistics", sellerId: "sel-1", communityId: COMUNIDAD },
      { role: "community_leader", communityId: COMUNIDAD, communityStanding: "creditor" }
    ];
    for (const claims of matriz) {
      const esperado = availableHats(claims).length > 1;
      expect(shouldShowHatSelector(claims), JSON.stringify(claims)).toBe(esperado);
    }
  });

  it("RF_07: los sombreros no se repiten y salen en orden estable, el operativo primero", async () => {
    const { availableHats } = await cargar();
    // El orden es contrato: es el de la pildora en pantalla y el que hace legible el default.
    const hats = availableHats(TIENDA_QUE_LIDERA);
    expect(hats).toEqual(["operational", "community"]);
    expect(new Set(hats).size).toBe(hats.length);
  });
});

describe("T11 · RF_11: un vinculo en blanco no es un vinculo", () => {
  it("RF_11: `communityId` vacio NO cuenta como vinculo — ni sombrero ni selector", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    const vacio: Claims = { role: "seller", sellerId: "sel-1", communityId: "" };
    expect(availableHats(vacio)).toEqual(["operational"]);
    expect(shouldShowHatSelector(vacio)).toBe(false);
  });

  it("RF_11: `communityId` en blanco NO cuenta como vinculo", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    const enBlanco: Claims = { role: "seller", sellerId: "sel-1", communityId: "   " };
    expect(availableHats(enBlanco)).toEqual(["operational"]);
    expect(shouldShowHatSelector(enBlanco)).toBe(false);
  });

  it("RF_11: la POSICION sola, sin `communityId`, no concede el sombrero de comunidad", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    // Reclamo incoherente (posicion sin vinculo). Lo que sostiene el cobro es el `communityId`;
    // dejar que la posicion lo supla abriria la pantalla de comunidad sin comunidad que mirar.
    const posicionHuerfana: Claims = { role: "seller", sellerId: "sel-1", communityStanding: "creditor" };
    expect(availableHats(posicionHuerfana)).toEqual(["operational"]);
    expect(shouldShowHatSelector(posicionHuerfana)).toBe(false);
  });
});

describe("T11 · RF_07: cual se abre primero", () => {
  it("RF_07: para una tienda que ademas lidera abre el OPERATIVO — su negocio diario es la tienda", async () => {
    const { defaultHat } = await cargar();
    expect(defaultHat(TIENDA_QUE_LIDERA)).toBe("operational");
    expect(defaultHat(TIENDA_ACREEDORA)).toBe("operational");
  });

  it("RF_07: para un lider puro abre el de COMUNIDAD — es el unico que tiene", async () => {
    const { defaultHat } = await cargar();
    expect(defaultHat(LIDER_PURO)).toBe("community");
  });

  it("RF_07: el sombrero por defecto siempre esta entre los disponibles", async () => {
    const { availableHats, defaultHat } = await cargar();
    const matriz: readonly Claims[] = [TIENDA, LIDER_PURO, TIENDA_QUE_LIDERA, TIENDA_ACREEDORA];
    for (const claims of matriz) {
      expect(availableHats(claims), JSON.stringify(claims)).toContain(defaultHat(claims));
    }
  });
});

describe("T11 · RF_10: cambiar de sombrero no exige volver a entrar", () => {
  it("RF_10: las tres funciones dependen SOLO de los reclamos — aridad uno", async () => {
    const { availableHats, defaultHat, shouldShowHatSelector } = await cargar();
    // Si alguna necesitara un segundo argumento (sesion, estado, store), cambiar de sombrero
    // dependeria de algo que hay que traer, y traer es justo lo que RF_10 prohibe.
    expect(availableHats.length).toBe(1);
    expect(defaultHat.length).toBe(1);
    expect(shouldShowHatSelector.length).toBe(1);
  });

  it("RF_10: llamar no muta los reclamos ni guarda estado — mismo dato, misma respuesta", async () => {
    const { availableHats, defaultHat, shouldShowHatSelector } = await cargar();
    const congelados = congelar<Claims>({
      role: "seller",
      sellerId: "sel-1",
      communityId: COMUNIDAD,
      communityStanding: "creditor"
    });
    const primera = availableHats(congelados);
    const segunda = availableHats(congelados);
    expect(segunda).toEqual(primera);
    expect(defaultHat(congelados)).toBe(defaultHat(congelados));
    expect(shouldShowHatSelector(congelados)).toBe(shouldShowHatSelector(congelados));
    expect(congelados).toEqual({
      role: "seller",
      sellerId: "sel-1",
      communityId: COMUNIDAD,
      communityStanding: "creditor"
    });
  });

  it("RF_10: el orden de las llamadas no cambia el resultado — no hay sombrero 'recordado'", async () => {
    const { defaultHat } = await cargar();
    // Si `defaultHat` memorizara el ultimo sombrero elegido, pedirlo despues de otra cuenta
    // devolveria el de esa otra, y el estado de interfaz dejaria de ser reconstruible.
    expect(defaultHat(TIENDA_QUE_LIDERA)).toBe("operational");
    expect(defaultHat(LIDER_PURO)).toBe("community");
    expect(defaultHat(TIENDA_QUE_LIDERA)).toBe("operational");
    expect(defaultHat(LIDER_PURO)).toBe("community");
  });

  it("RF_10: el modulo no importa React, Firebase ni toca el navegador — nada que recargar", async () => {
    await cargar();
    const fuente = readFileSync(fileURLToPath(new URL("./session-hats.ts", import.meta.url)), "utf8");
    for (const prohibido of ["react", "firebase", "firestore", "next/"]) {
      expect(fuente.toLowerCase(), `importa ${prohibido}`).not.toContain(`from "${prohibido}`);
    }
    for (const global of ["window.", "document.", "localStorage", "fetch("]) {
      expect(fuente, `usa ${global}`).not.toContain(global);
    }
  });
});

/**
 * T16 · RF_08 y RF_09: que la PANTALLA reparta por sombrero, no por papel.
 *
 * La auditoria de la spec 003 los encontro huerfanos: el reparto estaba implementado y no lo
 * probaba nada, y la guarda que T13 prometia —atar la pantalla al nucleo de este modulo— no
 * llegaba a existir. Sin ella se puede reescribir el selector con una copia local de la condicion
 * y la suite sigue verde. Es exactamente la leccion de `roleLabel` en la spec 001: probar la
 * funcion correcta no dice nada sobre quien la llama.
 *
 * Son comprobaciones de TEXTO sobre la fuente, con su falso rojo posible si alguien reformatea. Se
 * acepta a proposito: el fallo que previenen es silencioso —compila, tipa, pasa `react-hooks`— y
 * solo se ve abriendo la pantalla con la cuenta adecuada, que es justo lo que nadie hace.
 */
/**
 * RECORTES COMPARTIDOS DE LA PANTALLA (los usan la guarda endurecida de T16 y el bloque de T7).
 *
 * Viven en modulo, y no dentro de un `describe`, porque la guarda vieja de T16 y la nueva de T7
 * miran exactamente el mismo trozo de codigo: el cuerpo de `Header`. Extraerlo dos veces invitaria
 * a que una copia se quedara mirando otra cosa.
 */
const FUENTE_PANTALLA = readFileSync(
  fileURLToPath(new URL("../components/operations-app.tsx", import.meta.url)),
  "utf8"
);

/** El cuerpo de `function Header({ ... })`, hasta la siguiente declaracion de primer nivel. */
const CUERPO_HEADER = (() => {
  const inicio = FUENTE_PANTALLA.indexOf("function Header({");
  if (inicio === -1) return "";
  const siguientes = ["\nfunction ", "\nconst ", "\nexport "]
    .map((marca) => FUENTE_PANTALLA.indexOf(marca, inicio + 1))
    .filter((i) => i > -1);
  return siguientes.length === 0
    ? FUENTE_PANTALLA.slice(inicio)
    : FUENTE_PANTALLA.slice(inicio, Math.min(...siguientes));
})();

/**
 * Solo lo que `Header` DEVUELVE, desde `return (`. Es la distincion que decide esta tarea: hoy
 * `canPickHat` y `onHatChange` estan en la firma y en el tipo de props —o sea, dentro del cuerpo—
 * y no aparecen en el JSX. Afirmar sobre el cuerpo entero volveria a dar verde con el control
 * invisible, que es justo el fallo que se esta cerrando.
 */
const JSX_HEADER = (() => {
  const i = CUERPO_HEADER.indexOf("return (");
  return i === -1 ? "" : CUERPO_HEADER.slice(i);
})();

describe("T16 · el reparto de vistas sale del sombrero, no del papel", () => {
  const FUENTE = FUENTE_PANTALLA;

  it("RF_08, RF_09: la pantalla importa el nucleo de sombreros y no reimplementa la condicion", () => {
    // Control positivo: si el lector fallara, lo delata antes que las aserciones reales.
    expect(FUENTE.length).toBeGreaterThan(100_000);
    expect(FUENTE).toMatch(/from "@\/lib\/session-hats"/);
    expect(FUENTE).toContain("defaultHat");
    expect(FUENTE).toContain("shouldShowHatSelector");
  });

  it("RF_09: con el sombrero de comunidad se despacha la vista de comunidad ANTES que la del papel", () => {
    const porSombrero = FUENTE.indexOf('activeHat === "community"');
    const porPapel = FUENTE.indexOf('session.role === "messenger") return <MessengerView');
    expect(porSombrero, "el reparto por sombrero desaparecio de la pantalla").toBeGreaterThan(-1);
    expect(porPapel, "el reparto por papel desaparecio; si se renombro, actualizar esta prueba").toBeGreaterThan(-1);
    // Si el papel decidiera primero, una tienda que ademas lidera nunca veria su comunidad.
    expect(porSombrero).toBeLessThan(porPapel);
  });

  it("RF_09: la vista de comunidad recibe la comunidad, no el perfil operativo", () => {
    // `profileId` paso a ser SOLO la identidad operativa: seguir leyendo de ahi le pintaria a la
    // tienda las cifras de una comunidad que no existe.
    expect(FUENTE).toMatch(/<CommunityLeaderView[\s\S]{0,200}communityId=\{/);
    expect(FUENTE).not.toMatch(/<CommunityLeaderView[\s\S]{0,200}session=\{session\}/);
  });

  /**
   * ENDURECIDA EN T7 (spec 005). La version anterior era, entera:
   *
   *     expect(FUENTE).toMatch(/shouldShowHatSelector\(/);
   *
   * y pasaba HOY, con el selector invisible: la funcion se llama para calcular `canPickHat`, la
   * pantalla se lo pasa a `Header`, y `Header` lo desestructura y no lo usa en el JSX que devuelve.
   * O sea: el nombre aparecia en el archivo y nadie pintaba nada. Es el ejemplo exacto de una
   * prueba que no muerde — cumplia la letra de T13 y dejo pasar el hueco por el que la 003 se dio
   * por buena sin el control. Ahora se exige la CADENA COMPLETA: el nucleo decide -> el valor viaja
   * a la cabecera -> y ahi gobierna el pintado.
   */
  it("RF_08: el selector solo se pinta cuando el nucleo dice que hay donde elegir", () => {
    // Controles positivos: los extractores ven algo, y ven cosas que ya existen hoy.
    expect(CUERPO_HEADER, "no se pudo recortar el cuerpo de `Header`").not.toBe("");
    expect(JSX_HEADER, "no se pudo recortar el JSX que devuelve `Header`").not.toBe("");
    expect(JSX_HEADER, "control positivo: el JSX de la cabecera ya pinta el papel").toContain(
      "roleLabel(session.role)"
    );

    // 1. El nucleo sigue siendo quien decide (lo unico que exigia la version vieja).
    expect(FUENTE).toMatch(/shouldShowHatSelector\(/);

    // 2. Su resultado es lo que la pantalla le pasa a la cabecera, sin condicion propia por medio.
    const decideElNucleo = /const canPickHat\s*=[^;]*shouldShowHatSelector\(/.test(FUENTE);
    expect(decideElNucleo, "`canPickHat` ya no sale de `shouldShowHatSelector`").toBe(true);
    const viajaALaCabecera = /<Header[\s\S]{0,400}canPickHat=\{canPickHat\}/.test(FUENTE);
    expect(viajaALaCabecera, "`canPickHat` no llega a `Header`").toBe(true);

    // 3. Y ahi gobierna el pintado. Sin esto, todo lo anterior describe un calculo que no se ve.
    const gobiernaElPintado = /canPickHat\s*(&&|\?)/.test(JSX_HEADER);
    expect(
      gobiernaElPintado,
      "`canPickHat` llega a `Header` y no decide nada en el JSX: el selector es invisible"
    ).toBe(true);
  });
});

/**
 * T6 (spec 005) · RF_12: la sesion propaga la POSICION en la comunidad.
 *
 * EL CABO SUELTO DE LA 003 (plan 005 §2). `communityStanding` distingue a quien LIDERA de quien solo
 * es ACREEDOR — dejo de liderar y se le sigue debiendo lo ya causado. La pantalla ya sabe usarlo y el
 * nucleo de `load-status` ya decide con el, pero el dato nunca llega: `FirebaseSessionClaims` no lo
 * declara, `subscribeFirebaseUser` no lo emite, y la pantalla lo pesca con un cast que admite en su
 * propio comentario que el envoltorio "aun no la expone". Resultado: `session.communityStanding` es
 * SIEMPRE `undefined` y RF_12 es inalcanzable — no hay forma de saber que una cuenta ya no gobierna.
 *
 * POR QUE ESTO SE LEE COMO TEXTO. `firebase/auth.ts` importa el SDK de Firebase y
 * `operations-app.tsx` es el componente monolitico: ninguno de los dos se puede importar en un
 * proceso de vitest sin arrastrar medio navegador. Es el mismo patron ya usado arriba en T16 y en
 * `state-store-targets.test.ts`, y se acepta con sus mismas contrapartidas: puede dar un rojo falso
 * si alguien reformatea. A cambio atrapa un fallo que compila, tipa y pasa el lint, y que solo se ve
 * retirandole el liderazgo a una cuenta real en produccion.
 *
 * CADA NEGATIVA VA CON SU POSITIVA DE CONTROL emparejada: si un extractor se rompe (fichero
 * renombrado, funcion movida, recorte vacio) las dos caen juntas, y la negativa no puede pasar "en
 * vacio" por estar mirando una cadena vacia.
 *
 * LO QUE AQUI NO SE REPITE: que el sombrero de comunidad lo da el VINCULO y no la posicion —una
 * tienda con vinculo ve selector tanto con `"leader"` como con `"creditor"` (RF_22 de la 003)— ya
 * esta atado arriba por dos casos de T11: "RF_11: una tienda con vinculo de ACREEDOR ve selector
 * igual" y "RF_07: la POSICION no cambia los sombreros". Se citan en vez de duplicarlos: son
 * exactamente el porque de que valga la pena propagar el dato, y duplicarlos solo haria que el dia
 * que cambie la regla haya que arreglar dos sitios.
 */
describe("T6 · RF_12: la posicion en la comunidad llega hasta la sesion", () => {
  const FUENTE_AUTH = readFileSync(fileURLToPath(new URL("./firebase/auth.ts", import.meta.url)), "utf8");
  const FUENTE_APP = readFileSync(
    fileURLToPath(new URL("../components/operations-app.tsx", import.meta.url)),
    "utf8"
  );

  /** El bloque `export type FirebaseSessionClaims = { ... };` y nada mas. */
  const TIPO_RECLAMOS = (() => {
    const inicio = FUENTE_AUTH.indexOf("export type FirebaseSessionClaims = {");
    if (inicio === -1) return "";
    const fin = FUENTE_AUTH.indexOf("\n};", inicio);
    return fin === -1 ? "" : FUENTE_AUTH.slice(inicio, fin + 3);
  })();

  /** El cuerpo de `subscribeFirebaseUser`, hasta el siguiente `export` de primer nivel. */
  const CUERPO_SUBSCRIBE = (() => {
    const inicio = FUENTE_AUTH.indexOf("export function subscribeFirebaseUser");
    if (inicio === -1) return "";
    const fin = FUENTE_AUTH.indexOf("\nexport ", inicio + 1);
    return fin === -1 ? FUENTE_AUTH.slice(inicio) : FUENTE_AUTH.slice(inicio, fin);
  })();

  /** La ventana alrededor del UNICO `setSession({` de la pantalla: ahi se arma la sesion. */
  const BLOQUE_SESION = (() => {
    const i = FUENTE_APP.indexOf("setSession({");
    return i === -1 ? "" : FUENTE_APP.slice(Math.max(0, i - 1_200), i + 800);
  })();

  it("RF_12: el tipo de reclamos DECLARA `communityStanding`", () => {
    // Control positivo: el extractor ve el bloque y ve un campo que ya existe. Si esto cayera, el
    // fallo seria del recorte y no del codigo, y la aserción de abajo no significaria nada.
    expect(TIPO_RECLAMOS, "no se pudo recortar `FirebaseSessionClaims`").not.toBe("");
    expect(TIPO_RECLAMOS, "control positivo: `communityId` ya esta declarado").toMatch(/communityId\?:/);

    // Sin el campo en el tipo, la pantalla no tiene de donde leerlo mas que forzandolo con un cast.
    expect(TIPO_RECLAMOS, "`communityStanding` no viaja en los reclamos").toMatch(/communityStanding\?:/);
  });

  it("RF_12: el envoltorio EMITE `communityStanding`, leido de `token.claims` como los demas", () => {
    expect(CUERPO_SUBSCRIBE, "no se pudo recortar `subscribeFirebaseUser`").not.toBe("");
    // Control positivo: la forma exacta con la que el envoltorio ya lee un reclamo hermano.
    expect(CUERPO_SUBSCRIBE, "control positivo: asi se emite `communityId` hoy").toMatch(
      /communityId:\s*typeof\s+token\.claims\.communityId\s*===\s*"string"/
    );

    expect(CUERPO_SUBSCRIBE, "el objeto entregado a `onUser` no lleva `communityStanding`").toMatch(
      /communityStanding:/
    );
    expect(CUERPO_SUBSCRIBE, "hay que comprobar el tipo, no coaccionar").toMatch(
      /typeof\s+token\.claims\.communityStanding\s*===\s*"string"/
    );
    // `String(claim)` convertiria un `undefined` ausente en la cadena "undefined", que es un valor
    // desconocido colandose en la sesion: exactamente lo que la validacion de abajo existe para
    // impedir, pero disfrazado de texto valido.
    expect(CUERPO_SUBSCRIBE, "coaccion en vez de comprobacion de tipo").not.toMatch(
      /String\(\s*token\.claims\.communityStanding/
    );
  });

  it("RF_12: la pantalla deja de CASTEAR los reclamos para pescar la posicion", () => {
    expect(BLOQUE_SESION, "no se pudo recortar el `setSession` de la pantalla").not.toBe("");
    // Control positivo: la sesion sigue recibiendo el campo. Si esto cayera, la negativa de abajo
    // pasaria sola por haberse borrado el rasgo entero en vez de haberse arreglado.
    expect(BLOQUE_SESION, "control positivo: la sesion asigna `communityStanding`").toMatch(
      /communityStanding:/
    );

    // El cast es la confesion de que el envoltorio no expone el campo: en cuanto lo exponga sobra, y
    // dejarlo puesto haria que el tipo volviera a poder mentir sin que nadie se entere.
    // Se afirma sobre un booleano y no sobre `FUENTE_APP`: con `.not.toMatch` el rojo escupe el
    // monolito entero (cientos de miles de caracteres) y sepulta el resto del informe.
    const castea = /claims as \{[^}]*communityStanding/.test(FUENTE_APP);
    expect(castea, "el cast sigue ahi: el envoltorio no tipa la posicion").toBe(false);
  });

  it("RF_12: la sesion solo admite `leader` o `creditor`; cualquier otra cosa cae a `undefined`", () => {
    // NO REGRESION: esta pasa HOY (la valida la pantalla) y tiene que seguir pasando este donde
    // este la validacion. Se acepta en cualquiera de los dos sitios a proposito: si T6 tipa el campo
    // en `auth.ts` y filtra ahi, la comprobacion de la pantalla queda redundante y es legitimo
    // quitarla — lo que NO es legitimo es que desaparezca de los dos y un reclamo con basura
    // ("leader ", "LEADER", "undefined") entre en la sesion y decida que se le ensena a una cuenta.
    const filtro = /"leader"[\s\S]{0,120}"creditor"[\s\S]{0,120}undefined/;
    const donde = filtro.test(CUERPO_SUBSCRIBE)
      ? "auth.ts"
      : filtro.test(BLOQUE_SESION)
        ? "operations-app.tsx"
        : null;
    expect(donde, "nadie valida la posicion antes de meterla en la sesion").not.toBeNull();
  });
});

/**
 * T7 (spec 005) · RF_03, RF_04, RF_09, RNF_04 (forma). El selector de papel, PINTADO.
 *
 * EL AGUJERO QUE ESTE BLOQUE CIERRA. La spec 003 prometio que una cuenta que es tienda y ademas
 * lidera puede cambiar entre sus dos pantallas, y se dio por implementada. **El control nunca se
 * pinto.** `Header` desestructura `canPickHat` y `onHatChange` y no los usa en el JSX que devuelve;
 * la unica guarda que debia cazarlo exigia que el texto `shouldShowHatSelector(` apareciera en el
 * archivo, y aparece — para calcular una variable que nadie dibuja. Todo el nucleo esta probado
 * (los bloques T11 de arriba), todo compila, todo tipa, y la persona no tiene boton. Por eso el DoD
 * punto 2 pide exactamente esta prueba.
 *
 * COMPROBACIONES DE TEXTO, y por que se aceptan: `operations-app.tsx` es el monolito de ~13.000
 * lineas; no se puede importar en vitest sin arrastrar medio navegador. Mismo patron que T16 y T6,
 * con su misma contrapartida (un reformateo puede dar rojo falso) y su misma ganancia: atrapan un
 * fallo invisible salvo abriendo la pantalla con la cuenta adecuada, que es lo que nadie hace.
 *
 * SE AFIRMA SOBRE BOOLEANOS (`/regex/.test(recorte)`) y no sobre la fuente con `.not.toMatch`:
 * leccion de T6 — el rojo volcaria el monolito entero y sepultaria el resto del informe.
 *
 * CADA NEGATIVA CON SU POSITIVA DE CONTROL: si un recorte se rompe (funcion renombrada, movida,
 * cadena vacia) caen las dos juntas y ninguna negativa puede pasar "en vacio".
 *
 * LO QUE AQUI NO SE REPITE:
 *  - RF_09, que se abre la tienda primero: ya esta arriba, en "RF_07: para una tienda que ademas
 *    lidera abre el OPERATIVO — su negocio diario es la tienda" (bloque "T11 · cual se abre
 *    primero"). Aqui solo se ata que la PANTALLA use ese `defaultHat` y no invente el suyo.
 *  - Que el nucleo diga `true` para tienda+lider y para tienda+acreedor y `false` sin vinculo: son
 *    los casos de T11 "una tienda CON vinculo de lider ... SI ve selector", "una tienda con vinculo
 *    de ACREEDOR ve selector igual" y "un vendedor sin vinculo ... NO ve selector".
 *  - Que `canPickHat` gobierne el pintado: esta en la guarda endurecida de T16, arriba.
 */
describe("T7 · el control de papel se pinta en la cabecera", () => {
  it("DoD 2, RF_03: la cabecera USA `canPickHat` y `onHatChange` en el JSX que devuelve", () => {
    // Controles positivos: el recorte existe y trae algo que hoy ya se pinta ahi.
    expect(CUERPO_HEADER, "no se pudo recortar el cuerpo de `Header`").not.toBe("");
    expect(JSX_HEADER, "no se pudo recortar el JSX que devuelve `Header`").not.toBe("");
    expect(JSX_HEADER, "control positivo: el nombre y el papel ya se pintan").toContain(
      "roleLabel(session.role)"
    );
    expect(JSX_HEADER, "control positivo: el boton de salir ya se pinta").toContain("Cerrar sesion");

    // El fallo exacto de la 003: estan en la firma y en el tipo de props, no en lo que se dibuja.
    const usaCanPickHat = /canPickHat/.test(JSX_HEADER);
    expect(usaCanPickHat, "`canPickHat` se desestructura y no se usa en el JSX de la cabecera").toBe(true);
    const usaOnHatChange = /onHatChange/.test(JSX_HEADER);
    expect(usaOnHatChange, "`onHatChange` se desestructura y no se usa en el JSX de la cabecera").toBe(true);

    // Las dos etiquetas del control. Cortas por RNF_04; ver el caso de la forma, mas abajo.
    const etiquetaTienda = /\bTienda\b/.test(JSX_HEADER);
    const etiquetaComunidad = /\bComunidad\b/.test(JSX_HEADER);
    expect(etiquetaTienda, "no hay pildora 'Tienda' en la cabecera").toBe(true);
    expect(etiquetaComunidad, "no hay pildora 'Comunidad' en la cabecera").toBe(true);
  });

  it("RF_03: el control es accesible y dice CUAL de los dos papeles esta activo", () => {
    expect(JSX_HEADER, "no se pudo recortar el JSX que devuelve `Header`").not.toBe("");
    // Control positivo: la cabecera ya monta controles pulsables.
    expect(JSX_HEADER, "control positivo: ya hay un control en la cabecera").toMatch(/<(button|IconButton)/);

    // Es un control de ESTADO (cambia lo que se ve sin navegar), no un enlace: el estado activo
    // tiene que estar en el arbol de accesibilidad y no solo en el color de fondo. Una persona con
    // lector de pantalla necesita saber que papel lleva puesto, no solo que hay dos botones.
    const marcas = JSX_HEADER.match(/aria-(?:pressed|current)=/g) ?? [];
    expect(
      marcas.length,
      "hacen falta `aria-pressed` (o `aria-current`) en los DOS controles; encontrados: " + marcas.length
    ).toBeGreaterThanOrEqual(2);
  });

  it("RF_04: cambiar de papel no recarga la pagina ni obliga a volver a entrar", () => {
    expect(CUERPO_HEADER, "no se pudo recortar el cuerpo de `Header`").not.toBe("");
    // Control positivo: el cambio se pide por el callback, que es lo unico que debe pasar.
    const llamaAlCallback = /onHatChange\(/.test(JSX_HEADER);
    expect(llamaAlCallback, "el manejador no llama a `onHatChange`: no hay cambio de papel").toBe(true);

    // Cambiar de sombrero es estado de React y nada mas (plan 005 §3.4): cero documentos (RNF_03),
    // sin volver a entrar (RF_04). Cualquiera de estos tres seria un rodeo que vacia la sesion, la
    // cache y las suscripciones para conseguir lo que un `setState` ya hace.
    const recarga = /location\.reload/.test(CUERPO_HEADER);
    expect(recarga, "recargar la pagina para cambiar de papel incumple RF_04").toBe(false);
    const navega = /window\.location/.test(CUERPO_HEADER);
    expect(navega, "navegar para cambiar de papel incumple RF_04").toBe(false);
    const cierraSesion = /\bsignOut\s*\(/.test(CUERPO_HEADER);
    expect(cierraSesion, "cerrar sesion para cambiar de papel incumple RF_04").toBe(false);
  });

  it("RNF_04 (forma): las etiquetas son cortas y el contenedor no desborda a 390 px", () => {
    // La MEDIDA real a 390 px es T11 (captura). Aqui solo se ata la forma, y a proposito LAXO: no
    // se obliga a una implementacion concreta de Tailwind, solo a que la precaucion exista.
    expect(JSX_HEADER, "no se pudo recortar el JSX que devuelve `Header`").not.toBe("");
    expect(JSX_HEADER, "control positivo: la cabecera ya reparte el espacio con flex").toContain("flex");

    // A 390 px el control convive con el nombre, el indicador de "En vivo" y el boton de salir.
    // Una etiqueta de frase no cabe: desborda a lo ancho o empuja al boton fuera de la pantalla.
    const etiquetaLarga = /Mi tienda|Mis pedidos|Mi comunidad|Cambiar de papel a|Ver mi comunidad/i.test(
      JSX_HEADER
    );
    expect(etiquetaLarga, "etiqueta de frase en la cabecera: a 390 px no cabe").toBe(false);

    // Y el contenedor tiene que poder encoger. Sin esto, un `flex` no baja de su contenido y lo que
    // desborda es la cabecera entera.
    const puedeEncoger = /min-w-0|truncate|shrink|flex-wrap|overflow-x-auto/.test(JSX_HEADER);
    expect(puedeEncoger, "nada permite encoger el contenido de la cabecera en pantalla estrecha").toBe(true);
  });

  it("RF_09: el sombrero inicial lo decide `defaultHat`, no la pantalla por su cuenta", () => {
    // NO REGRESION, y a proposito NO duplica el caso del nucleo: cual se abre primero para una
    // tienda que lidera ya lo fija arriba "RF_07: para una tienda que ademas lidera abre el
    // OPERATIVO". Lo que falta atar es que la pantalla PREGUNTE, en vez de traerse su propia
    // condicion: repetir la regla en el JSX es como se desincronizan pantalla y nucleo.
    const preguntaAlNucleo = /const activeHat[\s\S]{0,300}defaultHat\(/.test(FUENTE_PANTALLA);
    expect(preguntaAlNucleo, "el sombrero inicial ya no sale de `defaultHat`").toBe(true);
  });
});

/**
 * =================================================================================================
 * T10 (spec 005) · No regresion de los cinco papeles SIN comunidad. RNF_01, RNF_03.
 *
 * RNF_01 fija la referencia para las cuentas sin vinculo: "como se comportan hoy". Estas pruebas
 * NACEN en verde a proposito —caracterizan que T5-T9 no movieron nada para quien no pidio nada—;
 * un rojo aqui es una regresion real, no una prueba por arreglar.
 *
 * LO QUE AQUI NO SE REPITE (ya lo fija T11 de la 003, arriba):
 *  - "RF_11: los SEIS papeles sin vinculo se quedan sin selector — tabla exhaustiva": afirma
 *    `toHaveLength(1)` y `false` para los seis, incluido `community_leader`.
 *  - "RF_11: la POSICION sola, sin `communityId`, no concede el sombrero de comunidad": el
 *    reclamo degradado para un vendedor.
 * Lo que T11 NO afirma y aqui se anade: CUAL es el unico sombrero (`"operational"`, no cualquiera)
 * y que `defaultHat` lo devuelve, para cada uno de los cinco papeles operativos; y que la posicion
 * huerfana (`communityStanding` sin `communityId`, el reclamo degradado que T6 hizo posible al
 * leerla del token) no cambia nada en NINGUNO de los cinco, no solo en el vendedor.
 * =================================================================================================
 */
const LOS_CINCO_PAPELES_OPERATIVOS: readonly Role[] = ["seller", "seller_logistics", "driver", "messenger", "admin"];

describe("T10 · RNF_01: los cinco papeles sin vinculo se comportan como hoy", () => {
  it.each(LOS_CINCO_PAPELES_OPERATIVOS)(
    "RNF_01: %s sin `communityId` tiene EXACTAMENTE el sombrero operativo, abre en el y no ve selector",
    async (role) => {
      const { availableHats, defaultHat, shouldShowHatSelector } = await cargar();
      const sinVinculo: Claims = { role };
      expect(availableHats(sinVinculo)).toEqual(["operational"]);
      expect(defaultHat(sinVinculo)).toBe("operational");
      expect(shouldShowHatSelector(sinVinculo)).toBe(false);
    }
  );

  it.each(LOS_CINCO_PAPELES_OPERATIVOS)(
    "RNF_01: %s con posicion huerfana (`communityStanding` sin `communityId`) da lo mismo que sin ella",
    async (role) => {
      const { availableHats, defaultHat, shouldShowHatSelector } = await cargar();
      // T6 lee `communityStanding` del token. Un reclamo con posicion y sin vinculo es incoherente
      // (degradado); para quien no lidera no puede abrir nada nuevo.
      for (const communityStanding of ["leader", "creditor"] as const) {
        const degradado: Claims = { role, communityStanding };
        expect(availableHats(degradado), communityStanding).toEqual(["operational"]);
        expect(defaultHat(degradado), communityStanding).toBe("operational");
        expect(shouldShowHatSelector(degradado), communityStanding).toBe(false);
      }
    }
  );

  it("RNF_01: los ids operativos (sellerId/driverId/messengerId) tampoco abren un segundo sombrero", async () => {
    const { availableHats, shouldShowHatSelector } = await cargar();
    const conIds: readonly Claims[] = [
      { role: "seller", sellerId: "sel-1" },
      { role: "seller_logistics", sellerId: "sel-1" },
      { role: "driver", driverId: "drv-1" },
      { role: "messenger", messengerId: "msg-1" },
      { role: "admin" }
    ];
    expect(conIds).toHaveLength(LOS_CINCO_PAPELES_OPERATIVOS.length);
    for (const claims of conIds) {
      expect(availableHats(claims), claims.role).toEqual(["operational"]);
      expect(shouldShowHatSelector(claims), claims.role).toBe(false);
    }
  });
});

/**
 * RNF_03 · cambiar de papel lee CERO documentos. El nucleo ya es puro (T11 "RF_10"); lo que falta
 * atar es la pantalla: el `useEffect` que monta `subscribeFirestoreState` no puede depender del
 * sombrero, porque cada cambio de dependencias desmonta y vuelve a montar la suscripcion entera.
 *
 * T14 de la 003 (`state-store-targets.test.ts`, "RNF_03: el sombrero no llega hasta aqui") ya
 * fija que `state-store.ts` no conoce el sombrero; T7 ("RF_04: cambiar de papel no recarga...")
 * que la cabecera no recarga ni navega. Aqui va el eslabon que faltaba: las DEPENDENCIAS del
 * efecto en `useAppState`.
 */
describe("T10 · RNF_03: cambiar de sombrero no toca la suscripcion", () => {
  /** El array de dependencias del `useEffect` que llama a `subscribeFirestoreState`. */
  const DEPENDENCIAS_DEL_EFECTO = (() => {
    const llamada = FUENTE_PANTALLA.indexOf("return subscribeFirestoreState(");
    if (llamada === -1) return "";
    const cierre = FUENTE_PANTALLA.indexOf("}, [", llamada);
    if (cierre === -1) return "";
    const fin = FUENTE_PANTALLA.indexOf("]);", cierre);
    return fin === -1 ? "" : FUENTE_PANTALLA.slice(cierre + 4, fin);
  })();

  it("RNF_03: el `useEffect` de la suscripcion NO depende de `hatChoice` ni de `activeHat`", () => {
    expect(DEPENDENCIAS_DEL_EFECTO, "no se pudo recortar el array de dependencias del efecto").not.toBe("");
    // Positivo de control: son las dependencias buenas — la comunidad viene del RECLAMO y el
    // reintento de T9 vuelve a montar la suscripcion.
    expect(DEPENDENCIAS_DEL_EFECTO).toContain("session?.ledCommunityId");
    expect(DEPENDENCIAS_DEL_EFECTO).toContain("reloadToken");
    expect(DEPENDENCIAS_DEL_EFECTO).toContain("session?.role");

    expect(DEPENDENCIAS_DEL_EFECTO, "cambiar de sombrero reharia la suscripcion").not.toMatch(/hatChoice/);
    expect(DEPENDENCIAS_DEL_EFECTO, "cambiar de sombrero reharia la suscripcion").not.toMatch(/activeHat/);
    expect(DEPENDENCIAS_DEL_EFECTO).not.toMatch(/\bhats?\b/i);
  });

  it("RNF_03: el contexto que se pasa a la suscripcion sale del reclamo, no del sombrero", () => {
    const llamada = FUENTE_PANTALLA.indexOf("return subscribeFirestoreState(");
    expect(llamada).toBeGreaterThan(-1);
    const contexto = FUENTE_PANTALLA.slice(Math.max(0, llamada - 900), llamada);
    // Positivo: el contexto se arma con `ledCommunityId` (el reclamo).
    expect(contexto).toMatch(/communityId:\s*session\.ledCommunityId/);
    expect(contexto).not.toMatch(/hatChoice|activeHat/);
  });
});
