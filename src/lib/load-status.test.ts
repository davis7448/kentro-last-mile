/**
 * T3 (spec 005) · Que tiene derecho a decir la pantalla de la tienda. RF_07, RF_08.
 *
 * Hoy `SellerView` (`operations-app.tsx:11177`) busca la tienda en `state.sellers` y, si no la
 * encuentra, pinta "Perfil de vendedor pendiente. Tu cuenta existe, pero falta vincularla a una
 * tienda" (`:11255`) SIN saber si la carga funciono. Con la carga caida ese mensaje es falso: manda
 * a la persona a pedirle al administrador un arreglo que no hace falta.
 *
 * Este modulo es quien DECIDE; la pantalla (T8) solo pinta.
 *
 * ---------------------------------------------------------------------------------------------
 * CONTRATO QUE ESTA PRUEBA FIJA (`src/lib/load-status.ts`, plan 005 §2):
 *
 *   export type LoadOutcome = "loading" | "ok" | "failed";
 *
 *   export type StoreProfileState =
 *     | { kind: "loading" }
 *     | { kind: "ok"; sellerId: string }
 *     | { kind: "load_failed" }          // RF_07: aviso + reintentar
 *     | { kind: "no_store_assigned" }    // RF_08, caso 1
 *     | { kind: "store_missing" };       // RF_08, caso 2
 *
 *   export function storeProfileState(input: {
 *     outcome: LoadOutcome;
 *     sellerId: string;                  // el del reclamo; "" si la cuenta no tiene tienda
 *     sellers: ReadonlyArray<{ id: string }>;
 *   }): StoreProfileState;
 *
 * Las reglas que salen de la tabla del plan §3.3, escritas para que el implementador no adivine:
 *
 *   1. `outcome` manda PRIMERO. Con `loading` o `failed` no se mira ni `sellerId` ni `sellers`:
 *      sin datos no se puede afirmar NADA de la configuracion de la cuenta (RF_07 gana a RF_08).
 *   2. Solo tras `ok` se distinguen los dos casos de configuracion: `sellerId` vacio (o en blanco)
 *      es "no tiene tienda asignada"; `sellerId` con valor que no aparece en `sellers` es "la
 *      tienda asignada ya no existe".
 *   3. La lista puede traer OTRAS tiendas (un lider descarga las de su comunidad ademas de la
 *      suya) y eso no cambia ninguna decision: lo unico que importa es si el id reclamado esta.
 *
 * ---------------------------------------------------------------------------------------------
 * POR QUE LA CARGA ES DIFERIDA: en fase RED el modulo no existe. Con un `import` estatico el
 * archivo entero no se recoge y el fallo es uno solo, "no se pudo cargar"; con `await import`
 * dentro de cada `it()` cada caso falla por separado y el rojo dice QUE caso falta, que es la
 * informacion util. Ademas `tsc --noEmit` sigue limpio.
 */

import { describe, expect, it } from "vitest";

/** Espejo local del contrato: si el modulo se aparta de esta forma, los fixtures no compilan. */
type LoadOutcome = "loading" | "ok" | "failed";

type StoreProfileState =
  | { kind: "loading" }
  | { kind: "ok"; sellerId: string }
  | { kind: "load_failed" }
  | { kind: "no_store_assigned" }
  | { kind: "store_missing" };

type StoreProfileInput = {
  outcome: LoadOutcome;
  sellerId: string;
  sellers: ReadonlyArray<{ id: string }>;
};

type StoreProfileState_ = (input: StoreProfileInput) => StoreProfileState;

/**
 * Carga diferida por caso: mientras `load-status.ts` no exista, cada `it()` falla por si mismo.
 * La ruta va en una constante y no como literal dentro del `import()` a proposito: en fase RED el
 * modulo AUN no existe, y un especificador literal hace que `tsc --noEmit` falle con TS2307 en todo
 * el repo (el rojo tiene que estar en las pruebas, no en el compilador). Vitest resuelve igual el
 * especificador relativo respecto a este archivo.
 */
const RUTA_MODULO = "./load-status";

const cargar = async (): Promise<StoreProfileState_> => {
  const modulo = (await import(RUTA_MODULO)) as unknown as {
    storeProfileState?: StoreProfileState_;
  };
  if (typeof modulo.storeProfileState !== "function") {
    throw new Error("src/lib/load-status.ts todavia no exporta storeProfileState (T3).");
  }
  return modulo.storeProfileState;
};

/** La tienda propia del caso realista. */
const TIENDA = "s-1";
/** Otras tiendas que el lider baja junto con la suya: ruido que no debe cambiar ninguna decision. */
const TIENDAS_DE_LA_COMUNIDAD: ReadonlyArray<{ id: string }> = Object.freeze([
  Object.freeze({ id: "s-otra-1" }),
  Object.freeze({ id: "s-otra-2" })
]);

describe("T3 · RF_07, RF_08: storeProfileState, la tabla del plan §3.3", () => {
  it("RF_07 · `loading` da `loading`: mientras se carga no se afirma nada de la cuenta", async () => {
    const storeProfileState = await cargar();
    expect(storeProfileState({ outcome: "loading", sellerId: TIENDA, sellers: [] })).toEqual({ kind: "loading" });
  });

  it("RF_07 · `failed` da `load_failed`: aviso y reintento, nunca 'perfil pendiente'", async () => {
    const storeProfileState = await cargar();
    expect(storeProfileState({ outcome: "failed", sellerId: TIENDA, sellers: [] })).toEqual({ kind: "load_failed" });
  });

  it("RF_08 · carga buena y cuenta sin tienda asignada (`sellerId` vacio) da `no_store_assigned`", async () => {
    const storeProfileState = await cargar();
    expect(storeProfileState({ outcome: "ok", sellerId: "", sellers: [{ id: TIENDA }] })).toEqual({
      kind: "no_store_assigned"
    });
  });

  it("RF_08 · carga buena y tienda asignada que no aparece en la lista da `store_missing`", async () => {
    const storeProfileState = await cargar();
    expect(storeProfileState({ outcome: "ok", sellerId: TIENDA, sellers: [] })).toEqual({ kind: "store_missing" });
  });

  it("RF_08 · carga buena y la tienda esta en la lista da `ok` con su id", async () => {
    const storeProfileState = await cargar();
    expect(storeProfileState({ outcome: "ok", sellerId: TIENDA, sellers: [{ id: TIENDA }] })).toEqual({
      kind: "ok",
      sellerId: TIENDA
    });
  });
});

/**
 * El fallo que esta spec existe para eliminar: con la carga caida, la pantalla NO puede atribuirle
 * el problema a la configuracion de la cuenta, ni siquiera cuando los datos que tiene a mano
 * "parecen" decir que la cuenta esta mal (sin `sellerId`, o con la lista vacia). No hay datos.
 */
describe("T3 · RF_07 gana siempre a RF_08: sin carga no se puede hablar de la cuenta", () => {
  const SOSPECHOSOS: ReadonlyArray<{ nombre: string; sellerId: string; sellers: ReadonlyArray<{ id: string }> }> = [
    { nombre: "sin tienda en el reclamo y lista vacia", sellerId: "", sellers: [] },
    { nombre: "sin tienda en el reclamo y lista con otras tiendas", sellerId: "", sellers: TIENDAS_DE_LA_COMUNIDAD },
    { nombre: "con tienda en el reclamo y lista vacia", sellerId: TIENDA, sellers: [] },
    { nombre: "con tienda en el reclamo que no esta en la lista", sellerId: TIENDA, sellers: TIENDAS_DE_LA_COMUNIDAD },
    { nombre: "con tienda en el reclamo que si esta en la lista", sellerId: TIENDA, sellers: [{ id: TIENDA }] }
  ];

  for (const caso of SOSPECHOSOS) {
    it(`RF_07 · \`failed\` da \`load_failed\` tambien ${caso.nombre}`, async () => {
      const storeProfileState = await cargar();
      expect(storeProfileState({ outcome: "failed", sellerId: caso.sellerId, sellers: caso.sellers })).toEqual({
        kind: "load_failed"
      });
    });

    it(`RF_07 · \`loading\` da \`loading\` tambien ${caso.nombre}`, async () => {
      const storeProfileState = await cargar();
      expect(storeProfileState({ outcome: "loading", sellerId: caso.sellerId, sellers: caso.sellers })).toEqual({
        kind: "loading"
      });
    });
  }
});

describe("T3 · RF_08: los dos casos de configuracion son distintos y solo se afirman tras una carga buena", () => {
  it("RF_08 · sin tienda asignada NO es 'la tienda ya no existe' (mensajes distintos, arreglos distintos)", async () => {
    const storeProfileState = await cargar();
    const sinAsignar = storeProfileState({ outcome: "ok", sellerId: "", sellers: TIENDAS_DE_LA_COMUNIDAD });
    const yaNoExiste = storeProfileState({ outcome: "ok", sellerId: TIENDA, sellers: TIENDAS_DE_LA_COMUNIDAD });
    expect(sinAsignar).toEqual({ kind: "no_store_assigned" });
    expect(yaNoExiste).toEqual({ kind: "store_missing" });
    expect(sinAsignar.kind).not.toBe(yaNoExiste.kind);
  });

  it("RF_08 · un `sellerId` en blanco ('   ') cuenta como SIN ASIGNAR, no como tienda inexistente", async () => {
    const storeProfileState = await cargar();
    expect(storeProfileState({ outcome: "ok", sellerId: "   ", sellers: TIENDAS_DE_LA_COMUNIDAD })).toEqual({
      kind: "no_store_assigned"
    });
  });

  it("RF_08 · la tienda propia se reconoce aunque la lista traiga ademas las de la comunidad", async () => {
    const storeProfileState = await cargar();
    const sellers = [...TIENDAS_DE_LA_COMUNIDAD, { id: TIENDA }];
    expect(storeProfileState({ outcome: "ok", sellerId: TIENDA, sellers })).toEqual({ kind: "ok", sellerId: TIENDA });
  });

  it("RF_08 · `ok` devuelve el id RECLAMADO, que es con el que la pantalla busca la tienda", async () => {
    const storeProfileState = await cargar();
    const estado = storeProfileState({ outcome: "ok", sellerId: "s-9", sellers: [{ id: "s-1" }, { id: "s-9" }] });
    expect(estado).toEqual({ kind: "ok", sellerId: "s-9" });
  });
});

describe("T3 · la funcion es pura: no muta nada y repetir la llamada da lo mismo", () => {
  it("RF_08 · no muta ni la entrada ni la lista (ambas congeladas, sin castear)", async () => {
    const storeProfileState = await cargar();
    const sellers: ReadonlyArray<{ id: string }> = Object.freeze([
      Object.freeze({ id: TIENDA }),
      Object.freeze({ id: "s-otra-1" })
    ]);
    const input: StoreProfileInput = Object.freeze({ outcome: "ok", sellerId: TIENDA, sellers });

    expect(storeProfileState(input)).toEqual({ kind: "ok", sellerId: TIENDA });
    expect(input).toEqual({ outcome: "ok", sellerId: TIENDA, sellers });
    expect(sellers).toEqual([{ id: TIENDA }, { id: "s-otra-1" }]);
  });

  it("RF_08 · dos llamadas con la misma entrada dan el mismo resultado", async () => {
    const storeProfileState = await cargar();
    const input: StoreProfileInput = { outcome: "ok", sellerId: TIENDA, sellers: TIENDAS_DE_LA_COMUNIDAD };
    expect(storeProfileState(input)).toEqual(storeProfileState(input));
    expect(storeProfileState(input)).toEqual({ kind: "store_missing" });
  });
});

/**
 * =================================================================================================
 * T4 (spec 005) · Por que no hay tiendas en la pantalla de comunidad. RF_10, RF_11, RF_12.
 *
 * Hoy `CommunityLeaderView` (`operations-app.tsx:5052-5092`) tiene una rama de carga, UNA tarjeta de
 * error generica (`:5060`) y una tarjeta de "Todavia no tienes tiendas" (`:5078-5092`). Esa tarjeta de
 * error absorbe tres situaciones distintas, y una de ellas NO es un fallo: al **acreedor** —quien dejo
 * de liderar pero sigue cobrando lo que se le debe— el servidor le niega `getCommunityStats` **por
 * diseno** (`community-access.ts:130-132`: `canReadCommunityStats` solo reconoce admin o lider). Hoy
 * ve un error, con boton de reintentar, por algo que ningun reintento puede cambiar.
 *
 * -------------------------------------------------------------------------------------------------
 * CONTRATO QUE ESTA PRUEBA FIJA (plan 005 §2 y §3.5):
 *
 *   export type CommunityStoresState =
 *     | { kind: "loading" }
 *     | { kind: "ok" }
 *     | { kind: "load_failed" }     // RF_10
 *     | { kind: "no_stores" }       // RF_11
 *     | { kind: "not_governing" };  // RF_12
 *
 *   export function communityStoresState(input: {
 *     statsOutcome: LoadOutcome;                                         // la CALLABLE getCommunityStats
 *     standing: "leader" | "creditor" | undefined;
 *     emptiness: "no_stores" | "no_orders_in_period" | null | undefined; // tal cual lo emite el servidor
 *   }): CommunityStoresState;
 *
 * Dos avisos sobre la forma de la entrada, que el plan §3.5 subraya:
 *
 *   1. `statsOutcome` es la carga de la CALLABLE, no la carga base. Son dos cargas distintas y no se
 *      mezclan: que falte la mitad de comunidad de `sellers` (el `LoadReport` de RF_06) no cambia
 *      ninguno de estos cinco estados, solo anade el aviso aparte del enlace de invitacion.
 *   2. `emptiness` se declara EXACTAMENTE como lo emite el servidor
 *      (`functions/src/community-stats-math.ts:151,186`): `"no_stores" | "no_orders_in_period" | null`,
 *      mas el `undefined` de una respuesta que no traiga el campo.
 *
 * POR QUE LA CARGA SIGUE SIENDO DIFERIDA: `load-status.ts` ya existe (T3), asi que el especificador
 * puede ir literal y el tipo `LoadOutcome` se importa de verdad (ver abajo). Lo que NO existe todavia
 * es `communityStoresState`, y un `import` estatico de un nombre inexistente hace dos danos: TS2305 en
 * `tsc --noEmit` y un unico fallo de carga que tapa los 30 casos. Con `await import()` por caso, cada
 * `it()` falla por si mismo con "todavia no exporta communityStoresState (T4)", que es el rojo util.
 * =================================================================================================
 */

/**
 * `LoadOutcome` SI se importa del modulo real —existe desde T3— para recuperar el tipado estatico: si
 * el implementador le anadiera o quitara un valor, estos fixtures dejarian de compilar. Se importa con
 * alias porque el bloque de T3 declara su propio espejo local con ese nombre, y la comprobacion de
 * abajo ata los dos: si divergen, `tsc` se queja aqui y no en produccion.
 */
import type { LoadOutcome as LoadOutcomeDelModulo } from "./load-status";

const _mismaFormaQueT3: LoadOutcomeDelModulo = "ok" satisfies LoadOutcome;
void _mismaFormaQueT3;

type CommunityStoresState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "load_failed" }
  | { kind: "no_stores" }
  | { kind: "not_governing" };

type CommunityStoresInput = {
  statsOutcome: LoadOutcomeDelModulo;
  standing: "leader" | "creditor" | undefined;
  emptiness: "no_stores" | "no_orders_in_period" | null | undefined;
};

type CommunityStoresState_ = (input: CommunityStoresInput) => CommunityStoresState;

const cargarCommunity = async (): Promise<CommunityStoresState_> => {
  const modulo = (await import("./load-status")) as unknown as {
    communityStoresState?: CommunityStoresState_;
  };
  if (typeof modulo.communityStoresState !== "function") {
    throw new Error("src/lib/load-status.ts todavia no exporta communityStoresState (T4).");
  }
  return modulo.communityStoresState;
};

/** Las tres cargas posibles de la callable, con nombre legible para el titulo del caso. */
const CARGAS: ReadonlyArray<{ nombre: string; valor: LoadOutcomeDelModulo }> = Object.freeze([
  Object.freeze({ nombre: "`loading`", valor: "loading" as const }),
  Object.freeze({ nombre: "`ok`", valor: "ok" as const }),
  Object.freeze({ nombre: "`failed`", valor: "failed" as const })
]);

/** Los CUATRO valores que `emptiness` puede tener al llegar del servidor. */
const VACIEDADES: ReadonlyArray<{ nombre: string; valor: CommunityStoresInput["emptiness"] }> = Object.freeze([
  Object.freeze({ nombre: '`"no_stores"`', valor: "no_stores" as const }),
  Object.freeze({ nombre: '`"no_orders_in_period"`', valor: "no_orders_in_period" as const }),
  Object.freeze({ nombre: "`null`", valor: null }),
  Object.freeze({ nombre: "`undefined`", valor: undefined })
]);

describe("T4 · RF_10, RF_11, RF_12: communityStoresState, la tabla del plan §3.5", () => {
  it("RF_12 · el acreedor da `not_governing` (fila 1 de la tabla)", async () => {
    const communityStoresState = await cargarCommunity();
    expect(communityStoresState({ statsOutcome: "failed", standing: "creditor", emptiness: null })).toEqual({
      kind: "not_governing"
    });
  });

  it("RF_10 · lider con la callable cargando da `loading`", async () => {
    const communityStoresState = await cargarCommunity();
    expect(communityStoresState({ statsOutcome: "loading", standing: "leader", emptiness: null })).toEqual({
      kind: "loading"
    });
  });

  it("RF_10 · lider con la callable caida da `load_failed`: eso si es un fallo y si admite reintento", async () => {
    const communityStoresState = await cargarCommunity();
    expect(communityStoresState({ statsOutcome: "failed", standing: "leader", emptiness: null })).toEqual({
      kind: "load_failed"
    });
  });

  it('RF_11 · lider, carga buena y `emptiness: "no_stores"` da `no_stores`, que no es un error', async () => {
    const communityStoresState = await cargarCommunity();
    expect(communityStoresState({ statsOutcome: "ok", standing: "leader", emptiness: "no_stores" })).toEqual({
      kind: "no_stores"
    });
  });

  it('RF_11 · lider, carga buena y `emptiness: "no_orders_in_period"` da `ok`: hay tiendas, faltan pedidos', async () => {
    const communityStoresState = await cargarCommunity();
    expect(communityStoresState({ statsOutcome: "ok", standing: "leader", emptiness: "no_orders_in_period" })).toEqual({
      kind: "ok"
    });
  });

  it("RF_11 · lider, carga buena y `emptiness: null` da `ok`", async () => {
    const communityStoresState = await cargarCommunity();
    expect(communityStoresState({ statsOutcome: "ok", standing: "leader", emptiness: null })).toEqual({ kind: "ok" });
  });

  it("RF_11 · lider, carga buena y `emptiness` AUSENTE da `ok`: una respuesta sin el campo no es una comunidad vacia", async () => {
    const communityStoresState = await cargarCommunity();
    // El campo se omite de verdad (no se pasa `undefined`): es lo que llegaria de un servidor que aun
    // no lo emitiera. La asercion de tipo solo tapa la propiedad que falta, no cambia el valor.
    const sinCampo = { statsOutcome: "ok", standing: "leader" } as CommunityStoresInput;
    expect(communityStoresState(sinCampo)).toEqual({ kind: "ok" });
  });
});

/**
 * RF_12 gana a todo. Al acreedor el servidor le niega `getCommunityStats` por DISENO
 * (`community-access.ts:130-132`), asi que da igual como haya ido la llamada y da igual lo que traiga:
 * ofrecerle "reintentar" seria mentirle —ningun reintento se lo va a conceder— y ensenarle "todavia no
 * tienes tiendas" seria peor, porque las tiendas existen y ya no son suyas.
 */
describe("T4 · RF_12 gana a todo: al acreedor no se le ofrece reintentar por algo que no es un fallo", () => {
  for (const carga of CARGAS) {
    for (const vacio of VACIEDADES) {
      it(`RF_12 · acreedor con statsOutcome ${carga.nombre} y emptiness ${vacio.nombre} da \`not_governing\``, async () => {
        const communityStoresState = await cargarCommunity();
        expect(
          communityStoresState({ statsOutcome: carga.valor, standing: "creditor", emptiness: vacio.valor })
        ).toEqual({ kind: "not_governing" });
      });
    }
  }
});

/**
 * `standing: undefined` NO es acreedor, y esto no es teorico: es el caso de HOY. `subscribeFirebaseUser`
 * (`src/lib/firebase/auth.ts:11-18,40-46`) no propaga `communityStanding`, asi que a la pantalla le llega
 * SIEMPRE vacio hasta que T6 lo arregle (cabo suelto de la 003, plan §2). Si el modulo tratara la
 * ausencia de posicion como "acreedor", a un lider de verdad —a TODOS, mientras T6 no entre— le diria
 * "ya no gobiernas esta comunidad" y le esconderia su comunidad entera. Ante la duda se gobierna.
 */
describe("T4 · RF_12: sin posicion conocida se decide como lider, nunca como acreedor", () => {
  const FILAS: ReadonlyArray<{
    nombre: string;
    statsOutcome: LoadOutcomeDelModulo;
    emptiness: CommunityStoresInput["emptiness"];
    esperado: CommunityStoresState;
  }> = [
    { nombre: "`loading`", statsOutcome: "loading", emptiness: null, esperado: { kind: "loading" } },
    { nombre: "`failed`", statsOutcome: "failed", emptiness: null, esperado: { kind: "load_failed" } },
    { nombre: '`ok` + "no_stores"', statsOutcome: "ok", emptiness: "no_stores", esperado: { kind: "no_stores" } },
    { nombre: "`ok` + `null`", statsOutcome: "ok", emptiness: null, esperado: { kind: "ok" } }
  ];

  for (const fila of FILAS) {
    it(`RF_12 · con ${fila.nombre}, \`standing: undefined\` da lo mismo que \`"leader"\``, async () => {
      const communityStoresState = await cargarCommunity();
      const sinPosicion = communityStoresState({
        statsOutcome: fila.statsOutcome,
        standing: undefined,
        emptiness: fila.emptiness
      });
      const comoLider = communityStoresState({
        statsOutcome: fila.statsOutcome,
        standing: "leader",
        emptiness: fila.emptiness
      });
      expect(sinPosicion).toEqual(fila.esperado);
      expect(sinPosicion).toEqual(comoLider);
      expect(sinPosicion).not.toEqual({ kind: "not_governing" });
    });
  }
});

describe("T4 · caso limite de la spec §5: le retiran el liderazgo con la sesion abierta", () => {
  it("RF_10 -> RF_12 · la misma negativa se lee como fallo mientras la pantalla no se entera, y como 'ya no gobiernas' al volver a entrar", async () => {
    const communityStoresState = await cargarCommunity();

    // Acto 1: el servidor ya deniega (`statsOutcome: "failed"`), pero la sesion guardada conserva los
    // permisos anteriores hasta renovarse —como mucho una hora— asi que la pantalla se sigue creyendo
    // lider. La spec §5 acepta explicitamente que durante ese rato se vea como fallo de carga.
    const mientrasNoSeEntera = communityStoresState({ statsOutcome: "failed", standing: "leader", emptiness: null });
    expect(mientrasNoSeEntera).toEqual({ kind: "load_failed" });

    // Acto 2: vuelve a iniciar sesion, el reclamo llega al dia y la posicion pasa a `creditor`. MISMO
    // `statsOutcome`: lo unico que cambia es lo que la cuenta sabe de si misma. La negativa deja de ser
    // un fallo y pasa a ser la respuesta correcta, sin boton de reintentar.
    const alVolverAEntrar = communityStoresState({ statsOutcome: "failed", standing: "creditor", emptiness: null });
    expect(alVolverAEntrar).toEqual({ kind: "not_governing" });

    expect(mientrasNoSeEntera.kind).not.toBe(alVolverAEntrar.kind);
  });
});

/**
 * `emptiness` solo describe una respuesta que SI llego. Con la callable cargando o caida no hay
 * respuesta que describir, asi que lo que venga en ese campo —incluido un `"no_stores"` residual de la
 * llamada anterior— no puede decidir nada: seria el mismo fallo que esta spec elimina, pintar una
 * carga rota como "todavia no tienes tiendas".
 */
describe("T4 · RF_10: `emptiness` no decide nada cuando la carga no fue buena", () => {
  for (const vacio of VACIEDADES) {
    it(`RF_10 · lider con \`failed\` da \`load_failed\` tambien con emptiness ${vacio.nombre}`, async () => {
      const communityStoresState = await cargarCommunity();
      expect(communityStoresState({ statsOutcome: "failed", standing: "leader", emptiness: vacio.valor })).toEqual({
        kind: "load_failed"
      });
    });

    it(`RF_10 · lider con \`loading\` da \`loading\` tambien con emptiness ${vacio.nombre}`, async () => {
      const communityStoresState = await cargarCommunity();
      expect(communityStoresState({ statsOutcome: "loading", standing: "leader", emptiness: vacio.valor })).toEqual({
        kind: "loading"
      });
    });
  }
});

describe("T4 · la funcion es pura: no muta nada y repetir la llamada da lo mismo", () => {
  it("RF_11 · no muta la entrada (congelada, sin castear)", async () => {
    const communityStoresState = await cargarCommunity();
    const input: CommunityStoresInput = Object.freeze({
      statsOutcome: "ok" as const,
      standing: "leader" as const,
      emptiness: "no_stores" as const
    });

    expect(communityStoresState(input)).toEqual({ kind: "no_stores" });
    expect(input).toEqual({ statsOutcome: "ok", standing: "leader", emptiness: "no_stores" });
  });

  it("RF_12 · dos llamadas con la misma entrada dan el mismo resultado", async () => {
    const communityStoresState = await cargarCommunity();
    const input: CommunityStoresInput = { statsOutcome: "loading", standing: "creditor", emptiness: undefined };
    expect(communityStoresState(input)).toEqual(communityStoresState(input));
    expect(communityStoresState(input)).toEqual({ kind: "not_governing" });
  });
});

/**
 * =================================================================================================
 * T5 (spec 005) · La mitad de comunidad no puede tumbar la tienda propia. RF_01, RF_06, RF_02.
 *
 * Hoy `loadFirestoreState` (`state-store.ts:170-193`) pide las tiendas con un `Promise.all` de DOS
 * mitades —la tienda propia por id, y `sellers where communityId ==` la suya— y las une con
 * `mergeById` (`:193`). Medido en T1 contra produccion (plan §0): la segunda mitad se rechaza con
 * `403 PERMISSION_DENIED`, y como es un `Promise.all`, el rechazo **tumba la carga entera**: esa
 * entrada rechaza, rechaza el `Promise.all` general de 21 consultas y la pantalla se queda sin
 * tienda, sin ciudades y sin ajustes. De ahi sale el "Perfil de vendedor pendiente" que vio la
 * primera cuenta real con los dos papeles.
 *
 * La mitad que falta es degradable; la tienda propia NO. Y la degradacion **no puede ser muda**: sin
 * las tiendas de la comunidad el lider pierde tambien el enlace de invitacion (`communitySlug`,
 * `operations-app.tsx:5208-5211`, hallazgo 2 del plan §0), asi que lo que falto tiene que viajar en
 * un parte hasta la pantalla. Por eso la funcion devuelve DOS cosas: la union y el parte.
 *
 * -------------------------------------------------------------------------------------------------
 * CONTRATO QUE ESTA PRUEBA FIJA (plan 005 §2 y §3.2):
 *
 *   export type LoadIssue = "community_sellers";
 *   export type LoadReport = { issues: readonly LoadIssue[] };
 *
 *   export function mergeCommunitySellers<T extends { id: string }>(input: {
 *     own: readonly T[];
 *     community: readonly T[] | { failed: true };
 *   }): { sellers: T[]; report: LoadReport };
 *
 * POR QUE POR COMPORTAMIENTO Y NO POR REGEX: `state-store.ts` importa el SDK de Firebase y no se
 * puede importar desde una prueba (`state-store-targets.test.ts:15-26` lo declara). Sacar la union y
 * el parte a este modulo puro es justamente lo que convierte la verificacion de §3.2 en
 * comportamiento. La guarda de que `state-store.ts` lo USA vive aparte, en ese otro archivo.
 *
 * `LoadIssue` y `LoadReport` se declaran aqui como espejo local en vez de importarse: en fase RED el
 * modulo todavia no los exporta, y un `import type` de un nombre inexistente pone rojo a
 * `tsc --noEmit` en todo el repo en vez de a la prueba. Cuando T5 entre, el espejo sigue atando la
 * forma: si el implementador se aparta de ella, los fixtures dejan de compilar.
 * =================================================================================================
 */

type LoadIssue = "community_sellers";
type LoadReport = { issues: readonly LoadIssue[] };

type MergeCommunitySellers_ = <T extends { id: string }>(input: {
  own: readonly T[];
  community: readonly T[] | { failed: true };
}) => { sellers: T[]; report: LoadReport };

const cargarMerge = async (): Promise<MergeCommunitySellers_> => {
  const modulo = (await import("./load-status")) as unknown as {
    mergeCommunitySellers?: MergeCommunitySellers_;
  };
  if (typeof modulo.mergeCommunitySellers !== "function") {
    throw new Error("src/lib/load-status.ts todavia no exporta mergeCommunitySellers (T5).");
  }
  return modulo.mergeCommunitySellers;
};

/**
 * Tiendas con los campos que de verdad viajan: el generico existe para que `state-store.ts` pueda
 * pasarle `Seller` entero sin castear ni perder nada por el camino.
 */
type TiendaFixture = { id: string; name: string; communityId?: string; communitySignupSlug?: string };

/** La tienda propia de Brayan: existe, opera, y NO pertenece a la comunidad que lidera. */
const TIENDA_PROPIA: TiendaFixture = { id: "s-propia", name: "Brayan E-master" };
/** Dos tiendas de la comunidad que lidera. */
const TIENDA_COMUNIDAD_1: TiendaFixture = { id: "s-com-1", name: "Tienda uno", communityId: "c-1" };
const TIENDA_COMUNIDAD_2: TiendaFixture = { id: "s-com-2", name: "Tienda dos", communityId: "c-1" };

describe("T5 · RF_01, RF_06: mergeCommunitySellers, la union de las dos mitades y el parte", () => {
  it("RF_01 · con las dos mitades bien salen todas, sin duplicados y con el parte vacio", async () => {
    const mergeCommunitySellers = await cargarMerge();
    const { sellers, report } = mergeCommunitySellers({
      own: [TIENDA_PROPIA],
      community: [TIENDA_COMUNIDAD_1, TIENDA_COMUNIDAD_2]
    });

    expect(sellers.map((tienda) => tienda.id)).toEqual(["s-propia", "s-com-1", "s-com-2"]);
    expect(new Set(sellers.map((tienda) => tienda.id)).size).toBe(sellers.length);
    expect(report.issues, "sin fallo el parte va vacio: no hay nada que avisarle a la pantalla").toEqual([]);
  });

  it("RF_06 · con la mitad de comunidad caida la tienda propia SIGUE AHI, y el parte lo dice", async () => {
    // El corazon de la tarea: hoy este caso deja la pantalla entera sin tienda, sin ciudades y sin
    // ajustes, porque el rechazo de la mitad de comunidad viaja hacia arriba por el `Promise.all`.
    const mergeCommunitySellers = await cargarMerge();
    const { sellers, report } = mergeCommunitySellers({
      own: [TIENDA_PROPIA],
      community: { failed: true }
    });

    expect(sellers, "la mitad degradable se llevo por delante la tienda propia").toEqual([TIENDA_PROPIA]);
    expect(report.issues).toContain("community_sellers");
  });

  it("RF_06 · con la mitad de comunidad caida y la propia vacia, el parte DICE que falto la comunidad", async () => {
    // "No hay" y "no se pudo saber" son cosas distintas. Sin el parte, un lider puro con la consulta
    // rechazada veria exactamente lo mismo que un lider de una comunidad recien creada: una lista
    // vacia y ningun aviso — y perderia ademas el enlace de invitacion sin enterarse (plan §0).
    const mergeCommunitySellers = await cargarMerge();
    const { sellers, report } = mergeCommunitySellers({ own: [], community: { failed: true } });

    expect(sellers).toEqual([]);
    expect(report.issues, "una lista vacia por un rechazo no puede confundirse con una comunidad sin tiendas").toEqual([
      "community_sellers"
    ]);
  });

  it("RF_06 · la mitad de comunidad vacia NO es un fallo: parte vacio", async () => {
    // El otro lado de la moneda del caso anterior, y el de la comunidad recien creada (spec §5): una
    // consulta que responde con cero documentos funciono. Marcarla como incidencia haria que la
    // pantalla avisara de un fallo que no existe cada vez que una comunidad no tiene tiendas aun.
    const mergeCommunitySellers = await cargarMerge();
    const { sellers, report } = mergeCommunitySellers({ own: [TIENDA_PROPIA], community: [] });

    expect(sellers).toEqual([TIENDA_PROPIA]);
    expect(report.issues).toEqual([]);
  });

  it("§5 viñeta 1 · RF_02 · la tienda propia que ademas pertenece a su comunidad sale UNA sola vez", async () => {
    // Hoy lo garantiza `mergeById` (`state-store.ts:193`), que T5 sustituye. Si la union nueva
    // duplicara, la pantalla contaria dos veces la misma tienda en el desglose de la comunidad.
    // Las dos copias son el MISMO documento leido por dos consultas, asi que son identicas: cual de
    // las dos sobreviva es indiferente y esta prueba no lo fija a proposito.
    const mergeCommunitySellers = await cargarMerge();
    const propiaEnSuComunidad: TiendaFixture = { id: "s-propia", name: "Brayan E-master", communityId: "c-1" };
    const { sellers, report } = mergeCommunitySellers({
      own: [propiaEnSuComunidad],
      community: [{ ...propiaEnSuComunidad }, TIENDA_COMUNIDAD_1]
    });

    expect(sellers.filter((tienda) => tienda.id === "s-propia")).toHaveLength(1);
    expect(sellers).toEqual([propiaEnSuComunidad, TIENDA_COMUNIDAD_1]);
    expect(report.issues).toEqual([]);
  });

  it("RF_01 · el orden es estable y predecible: la propia primero, luego las de la comunidad que falten", async () => {
    // Se elige ese orden y se afirma para que no dependa del azar de un `Map`: la tienda propia es la
    // que la pantalla de la tienda busca primero, y un orden que cambie entre cargas movería las
    // filas del desglose de comunidad sin motivo.
    const mergeCommunitySellers = await cargarMerge();
    const entrada = {
      own: [TIENDA_PROPIA],
      community: [TIENDA_COMUNIDAD_2, TIENDA_PROPIA, TIENDA_COMUNIDAD_1]
    };

    const primera = mergeCommunitySellers(entrada);
    const segunda = mergeCommunitySellers(entrada);

    expect(primera.sellers.map((tienda) => tienda.id)).toEqual(["s-propia", "s-com-2", "s-com-1"]);
    expect(segunda.sellers.map((tienda) => tienda.id)).toEqual(primera.sellers.map((tienda) => tienda.id));
  });

  it("RF_01 · es pura: no muta ninguna de las dos mitades (congeladas, sin castear)", async () => {
    const mergeCommunitySellers = await cargarMerge();
    const own: readonly TiendaFixture[] = Object.freeze([Object.freeze({ ...TIENDA_PROPIA })]);
    const community: readonly TiendaFixture[] = Object.freeze([
      Object.freeze({ ...TIENDA_COMUNIDAD_1 }),
      Object.freeze({ ...TIENDA_COMUNIDAD_2 })
    ]);

    const { sellers, report } = mergeCommunitySellers({ own, community });

    expect(sellers).toHaveLength(3);
    expect(report.issues).toEqual([]);
    expect(own).toEqual([TIENDA_PROPIA]);
    expect(community).toEqual([TIENDA_COMUNIDAD_1, TIENDA_COMUNIDAD_2]);
  });

  it("RF_06 · dos llamadas con la misma entrada dan lo mismo, tambien con la comunidad caida", async () => {
    const mergeCommunitySellers = await cargarMerge();
    const entrada = { own: [TIENDA_PROPIA], community: { failed: true } as const };
    expect(mergeCommunitySellers(entrada)).toEqual(mergeCommunitySellers(entrada));
    expect(mergeCommunitySellers(entrada)).toEqual({
      sellers: [TIENDA_PROPIA],
      report: { issues: ["community_sellers"] }
    });
  });

  it("RF_02 · es generica: conserva enteros los documentos, con todos sus campos", async () => {
    // `state-store.ts` le pasa `Seller` completo. Si la union se quedara con `{ id }`, la tienda
    // perderia su nombre, su `communityId` y el `communitySignupSlug` del que sale el enlace de
    // invitacion del lider — y la pantalla no tendria de donde sacarlos.
    const mergeCommunitySellers = await cargarMerge();
    const conTodo: TiendaFixture = {
      id: "s-com-1",
      name: "Tienda uno",
      communityId: "c-1",
      communitySignupSlug: "e-master"
    };
    const { sellers } = mergeCommunitySellers({ own: [TIENDA_PROPIA], community: [conTodo] });

    expect(sellers).toEqual([TIENDA_PROPIA, conTodo]);
    expect(sellers.find((tienda) => tienda.id === "s-com-1")?.communitySignupSlug).toBe("e-master");
  });
});
