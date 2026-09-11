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
