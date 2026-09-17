/**
 * T3 · Nucleo puro de la CONCESION del liderazgo de una comunidad (RF_04, RF_06, RF_17, RF_18, RF_19).
 *
 * `planLeadershipGrant` responde a una sola pregunta: que hay que escribir para que una cuenta
 * pase a liderar una comunidad. Nada mas. Quien escribe es la callable, igual que en
 * `community-leader-create.ts` (RF_55) y en `community-containment.ts` (RF_41).
 *
 * Por que el plan es un PARCHE de reclamos y no un juego completo:
 *   `setCustomUserClaims` REEMPLAZA los reclamos. Si el plan describiera el juego final tendria
 *   que nombrar `sellerId` para conservarlo, y un dia que se olvidara de copiarlo la tienda se
 *   quedaria sin su identidad operativa en el mismo commit en que gana un sombrero nuevo. Al
 *   describir solo lo que CAMBIA, conservar lo demas deja de ser una tarea que se pueda olvidar:
 *   el plan literalmente no puede nombrarlo (RF_04, caso del barrido).
 *
 * Por que `communityStanding: "leader"` se escribe EXPLICITO aunque su ausencia ya signifique
 * lider (ver `Actor.communityStanding` en `community-access.ts`): conceder tambien es el camino
 * de vuelta de un acreedor retirado, y ese SI lleva `"creditor"` escrito. Omitir el campo lo
 * dejaria retirado con cara de lider nuevo.
 *
 * Puro: sin `firebase-admin`, sin `firebase-functions`, sin reloj global. El instante entra por
 * `nowIso`. Carga diferida del modulo para que en rojo falle cada caso por su nombre y no la
 * recoleccion entera del archivo.
 */
import { describe, expect, it } from "vitest";
import type { CommunityStanding, UnsetField } from "../../functions/src/community-access";
import { UNSET_FIELD, isUnsetField } from "../../functions/src/community-access";

type GrantModule = typeof import("../../functions/src/community-grant");
type Planner = GrantModule["planLeadershipGrant"];
type GrantInput = Parameters<Planner>[0];
type GrantOutcome = ReturnType<Planner>;
type GrantPlan = Extract<GrantOutcome, { ok: true }>;
type GrantRejection = Extract<GrantOutcome, { ok: false }>;

const cargarPlanificador = async (): Promise<Planner> =>
  (await import("../../functions/src/community-grant")).planLeadershipGrant;

const NOW = "2026-09-11T14:00:00.000Z";
const COMUNIDAD = "com-siloe";
const OTRA_COMUNIDAD = "com-aguablanca";
const DESTINO = "uid-tienda-rio";
const LIDER_SALIENTE = "uid-lider-saliente";

/**
 * Un mismo uid con tienda, vehiculo y mensajeria a la vez es artificial a proposito: el caso del
 * barrido necesita los tres valores que buscar. Lo realista (solo `sellerId`) va aparte.
 */
const RECLAMOS_QUE_YA_OPERAN = {
  role: "seller",
  sellerId: "seller-42",
  driverId: "driver-7",
  messengerId: "messenger-9"
} as const;

const entrada = (overrides: Partial<GrantInput> = {}): GrantInput => ({
  targetUid: DESTINO,
  targetClaims: { ...RECLAMOS_QUE_YA_OPERAN },
  community: { id: COMUNIDAD },
  nowIso: NOW,
  ...overrides
});

const planificar = async (overrides: Partial<GrantInput> = {}): Promise<GrantOutcome> =>
  (await cargarPlanificador())(entrada(overrides));

const esperarPlan = (outcome: GrantOutcome): GrantPlan => {
  if (!outcome.ok) throw new Error(`Se esperaba un plan y llego un rechazo: ${outcome.reason}`);
  return outcome;
};

const esperarRechazo = (outcome: GrantOutcome): GrantRejection => {
  if (outcome.ok) throw new Error(`Se esperaba un rechazo y llego un plan: ${outcome.kind}`);
  return outcome;
};

/** Recorre el plan entero: claves y valores, a cualquier profundidad. */
const recorrerPlan = (value: unknown, visit: (fragment: string) => void): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recorrerPlan(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      recorrerPlan(inner, visit);
    }
  }
};

const rastros = (value: unknown, prohibido: RegExp): string[] => {
  const encontrados: string[] = [];
  recorrerPlan(value, (fragment) => {
    if (prohibido.test(fragment)) encontrados.push(fragment);
  });
  return encontrados;
};

/** Valores de todas las apariciones de una clave, a cualquier profundidad. */
const valoresDeClave = (value: unknown, clave: string): unknown[] => {
  const encontrados: unknown[] = [];
  const recorrer = (nodo: unknown): void => {
    if (Array.isArray(nodo)) {
      for (const item of nodo) recorrer(item);
      return;
    }
    if (nodo && typeof nodo === "object") {
      for (const [key, inner] of Object.entries(nodo as Record<string, unknown>)) {
        if (key === clave) encontrados.push(inner);
        recorrer(inner);
      }
    }
  };
  recorrer(value);
  return encontrados;
};

/**
 * `seller-42` y no `/seller/i`: el rol operativo del destino ES "seller" y tiene que seguir
 * estando (RF_04). Lo prohibido son los IDENTIFICADORES, no la palabra.
 */
const IDENTIDAD_OPERATIVA = /sellerId|driverId|messengerId|seller-42|driver-7|messenger-9/;
const PALABRAS_DE_DINERO =
  /wallet|entry|entries|asiento|settlement|liquidac|corte|payout|cashback|ledger|balance|saldo|abono|remittance|order|pedido/i;

describe("T3 · conceder el liderazgo de una comunidad a una cuenta que ya opera", () => {
  it("RF_04: control positivo del barrido — si el plan nombrara la identidad operativa, esta prueba lo veria", () => {
    // Sin esto, un barrido roto (que no baje al segundo nivel, o que no mire las claves) pasaria
    // en vacio y el aserto que mas vale de la spec no estaria comprobando nada.
    const planFalsoQueSiLaToca = {
      ok: true,
      promote: { uid: DESTINO, claimsPatch: { role: "seller", sellerId: "seller-42" } },
      anidado: [{ profundo: { driverId: "driver-7" } }, { otro: ["messenger-9"] }]
    };
    // Ordenado, y con el orden que da `Array.prototype.sort()` sin comparador: es lexicografico,
    // asi que "driver-7" va ANTES que "driverId" ('-' es 45 y 'I' es 73). Escribirlo "como suena"
    // hace que el control no pueda cuadrar nunca.
    expect(rastros(planFalsoQueSiLaToca, IDENTIDAD_OPERATIVA).sort()).toEqual([
      "driver-7",
      "driverId",
      "messenger-9",
      "seller-42",
      "sellerId"
    ]);
    expect(rastros({ ok: true, promote: { claimsPatch: { role: "seller" } } }, IDENTIDAD_OPERATIVA)).toEqual([]);
  });

  it("RF_04: el plan NO nombra sellerId, driverId ni messengerId a ninguna profundidad", async () => {
    // El aserto central de la spec. No se comprueban los campos de hoy uno a uno: se recorre el
    // plan ENTERO, claves y valores. Un campo nuevo que arrastre la identidad operativa tendra
    // que nombrarla, y esta prueba lo vera aunque nadie se acuerde de volver aqui.
    const plan = esperarPlan(await planificar());
    expect(rastros(plan, IDENTIDAD_OPERATIVA)).toEqual([]);
  });

  it("RF_04: el barrido tambien cubre el traspaso, que es el plan mas grande", async () => {
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(rastros(plan, IDENTIDAD_OPERATIVA)).toEqual([]);
  });

  it("RF_04: una tienda sigue siendo tienda — el parche conserva el role operativo tal cual", async () => {
    // Liderar es una ATRIBUCION de la cuenta, no un papel que sustituya al suyo: pisarlo con
    // "community_leader" dejaria a la tienda sin poder entrar a sus propios pedidos.
    const plan = esperarPlan(await planificar({ targetClaims: { role: "seller", sellerId: "seller-42" } }));
    expect(plan.promote?.claimsPatch.role).toBe("seller");
  });

  it("RF_04: un domiciliario que ademas lidera conserva su role, no se convierte en tienda", async () => {
    const plan = esperarPlan(await planificar({ targetClaims: { role: "driver", driverId: "driver-7" } }));
    expect(plan.promote?.claimsPatch.role).toBe("driver");
  });

  it("RF_04: el parche cambia exactamente tres claves y ninguna mas", async () => {
    const plan = esperarPlan(await planificar());
    expect(Object.keys(plan.promote?.claimsPatch ?? {}).sort()).toEqual([
      "communityId",
      "communityStanding",
      "role"
    ]);
  });

  it("RF_17: conceder una comunidad que ya existe y no tiene lider deja al destino como leader", async () => {
    const plan = esperarPlan(await planificar());
    expect(plan.kind).toBe("grant");
    expect(plan.createCommunity).toBe(false);
    expect(plan.promote).toEqual({
      uid: DESTINO,
      claimsPatch: { role: "seller", communityId: COMUNIDAD, communityStanding: "leader" satisfies CommunityStanding }
    });
    expect(plan.demote).toBeNull();
  });

  it("RF_17: el documento de la comunidad gana leaderUid y el instante de la concesion", async () => {
    const plan = esperarPlan(await planificar());
    expect(plan.communityUpdate).toEqual({ leaderUid: DESTINO, leaderGrantedAt: NOW });
    expect(plan.communityId).toBe(COMUNIDAD);
  });

  it("RF_17: crear la comunidad y asignarla es el MISMO plan, no dos llamadas", async () => {
    // Atomico quiere decir que la callable recibe las dos escrituras juntas y las mete en una
    // transaccion. Si fueran dos planes encadenados volveria la comunidad fantasma de RF_55.
    const plan = esperarPlan(await planificar({ community: { id: COMUNIDAD, exists: false } }));
    expect(plan.kind).toBe("create_and_grant");
    expect(plan.createCommunity).toBe(true);
    expect(plan.communityUpdate).toEqual({ leaderUid: DESTINO, leaderGrantedAt: NOW });
    expect(plan.promote?.uid).toBe(DESTINO);
  });

  it("RF_17: los dos caminos declaran las mismas colecciones — nada se escribe por un lado y no por el otro", async () => {
    const existente = esperarPlan(await planificar());
    const nueva = esperarPlan(await planificar({ community: { id: COMUNIDAD, exists: false } }));
    expect([...existente.collectionsTouched].sort()).toEqual(["authClaims", "communities"]);
    expect([...nueva.collectionsTouched].sort()).toEqual(["authClaims", "communities"]);
  });

  it("RF_06: si el destino ya lidera OTRA comunidad se rechaza, y el motivo dice cual", async () => {
    const rechazo = esperarRechazo(
      await planificar({
        targetClaims: { ...RECLAMOS_QUE_YA_OPERAN, communityId: OTRA_COMUNIDAD, communityStanding: "leader" }
      })
    );
    expect(rechazo.code).toBe("already-leads-other");
    expect(rechazo.reason).toContain(OTRA_COMUNIDAD);
  });

  it("RF_06: el rechazo no deja plan a medias — no hay ni parche ni escritura de comunidad", async () => {
    const rechazo = esperarRechazo(
      await planificar({
        targetClaims: { ...RECLAMOS_QUE_YA_OPERAN, communityId: OTRA_COMUNIDAD, communityStanding: "leader" }
      })
    );
    expect(valoresDeClave(rechazo, "claimsPatch")).toEqual([]);
    expect(valoresDeClave(rechazo, "leaderUid")).toEqual([]);
  });

  it("RF_06 / RF_22: un ACREEDOR de otra comunidad tambien se rechaza, nombrandola: su vinculo es su cobro", async () => {
    // Un reclamo solo puede llevar un `communityId`. Concederle esta comunidad sobreescribiria el
    // vinculo con la anterior, que es lo unico por lo que la plataforma sabe que todavia le debe
    // cashback causado (RF_22). No es un permiso que se pisa: es dinero que se apaga en silencio.
    const rechazo = esperarRechazo(
      await planificar({
        targetClaims: { role: "seller", sellerId: "seller-42", communityId: OTRA_COMUNIDAD, communityStanding: "creditor" }
      })
    );
    expect(rechazo.code).toBe("creditor-of-other");
    expect(rechazo.reason).toContain(OTRA_COMUNIDAD);
  });

  it("RF_06 / RF_18: si el destino YA lidera esa misma comunidad es no-op, no error: repetir la concesion no es un fallo del administrador", async () => {
    // Se elige no-op y no rechazo porque el estado final que se pide YA es el estado real: el
    // doble clic, el reintento tras un timeout y el refresco de la pantalla acaban aqui, y
    // ninguno es un error que merezca un mensaje rojo. Un rechazo ademas empujaria a la callable
    // a tratar "ya esta hecho" como "no se pudo hacer".
    const plan = esperarPlan(
      await planificar({
        targetClaims: { ...RECLAMOS_QUE_YA_OPERAN, communityId: COMUNIDAD },
        community: { id: COMUNIDAD, leaderUid: DESTINO },
        currentLeaderClaims: { uid: DESTINO, communityId: COMUNIDAD }
      })
    );
    expect(plan.kind).toBe("noop");
    expect(plan.promote).toBeNull();
    expect(plan.demote).toBeNull();
    expect(plan.communityUpdate).toBeNull();
    expect(plan.collectionsTouched).toEqual([]);
  });

  it("RF_18: el no-op NO se degrada a si mismo — mismo uid en las dos puntas no puede dejar la comunidad sin lider", async () => {
    // Tratar el caso como traspaso generico degradaria al destino a `creditor` y acto seguido lo
    // promoveria: con el orden equivocado la comunidad se queda sin lider.
    const plan = esperarPlan(
      await planificar({
        targetClaims: { ...RECLAMOS_QUE_YA_OPERAN, communityId: COMUNIDAD },
        community: { id: COMUNIDAD, leaderUid: DESTINO },
        currentLeaderClaims: { uid: DESTINO, communityId: COMUNIDAD }
      })
    );
    expect(rastros(plan, /creditor/)).toEqual([]);
  });

  it("RF_18: re-promover a un ACREEDOR de ESTA misma comunidad no es rechazo: vuelve a leader", async () => {
    // Es el camino de vuelta de un retiro. Y es la razon de que `communityStanding: "leader"` se
    // escriba explicito: sin el, el parche dejaria el "creditor" viejo intacto y la concesion no
    // concederia nada.
    const plan = esperarPlan(
      await planificar({
        targetClaims: { role: "seller", sellerId: "seller-42", communityId: COMUNIDAD, communityStanding: "creditor" },
        community: { id: COMUNIDAD }
      })
    );
    expect(plan.kind).toBe("grant");
    expect(plan.promote?.claimsPatch.communityStanding).toBe("leader");
    expect(plan.communityUpdate).toEqual({ leaderUid: DESTINO, leaderGrantedAt: NOW });
  });

  it("RF_19: asignar una comunidad que ya tiene lider es un TRASPASO: degrada al anterior y promueve al nuevo", async () => {
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(plan.kind).toBe("transfer");
    expect(plan.demote).toEqual({
      uid: LIDER_SALIENTE,
      claimsPatch: { communityId: COMUNIDAD, communityStanding: "creditor" satisfies CommunityStanding }
    });
    expect(plan.promote?.uid).toBe(DESTINO);
    expect(plan.promote?.claimsPatch.communityStanding).toBe("leader");
  });

  it("RF_19 / RF_22: el lider saliente CONSERVA su communityId — es lo que le deja cobrar lo ya causado", async () => {
    // Retirar el vinculo junto con el mando apagaria su cashback causado en el mismo commit y sin
    // una linea en el log. El parche de degradacion tiene que nombrar `communityId`, no omitirlo
    // y menos aun ponerlo a null.
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(plan.demote?.claimsPatch.communityId).toBe(COMUNIDAD);
    expect(Object.keys(plan.demote?.claimsPatch ?? {}).sort()).toEqual(["communityId", "communityStanding"]);
  });

  it("RF_19: el traspaso no toca el role del saliente — deja de liderar, no deja de trabajar", async () => {
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(valoresDeClave(plan.demote, "role")).toEqual([]);
  });

  it("RF_19: control positivo del barrido de dinero — un plan que nombrara un asiento seria visto", async () => {
    const planFalsoQueSiLoToca = {
      demote: { uid: LIDER_SALIENTE, reverse: [{ collection: "walletEntries", concept: "cashback" }] }
    };
    expect(rastros(planFalsoQueSiLoToca, PALABRAS_DE_DINERO).sort()).toEqual(["cashback", "walletEntries"]);
  });

  it("RF_19: el traspaso no nombra ni un asiento, ni un corte, ni un pedido del saliente", async () => {
    // Mismo barrido que RF_04, con palabras de dinero: si el plan ni siquiera puede mencionar esas
    // colecciones, no hay forma de que las recalcule al degradar a nadie.
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(rastros(plan, PALABRAS_DE_DINERO)).toEqual([]);
  });

  it("RF_18: tras el plan la comunidad tiene EXACTAMENTE un leaderUid", async () => {
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(valoresDeClave(plan, "leaderUid")).toEqual([DESTINO]);
    expect(typeof plan.communityUpdate?.leaderUid).toBe("string");
  });

  it("RF_18: en un traspaso hay una sola promocion y una sola degradacion, y no son el mismo uid", async () => {
    const plan = esperarPlan(
      await planificar({
        community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE },
        currentLeaderClaims: { uid: LIDER_SALIENTE, communityId: COMUNIDAD }
      })
    );
    expect(valoresDeClave(plan, "claimsPatch")).toHaveLength(2);
    expect(plan.demote?.uid).not.toBe(plan.promote?.uid);
  });

  it("RF_18: si la comunidad declara lider pero no llegan sus reclamos, se degrada IGUAL", async () => {
    // Lo contrario dejaria dos lideres vivos por no haber podido leer un documento. El uid ya lo
    // trae la comunidad, y `communityId` es el de la comunidad que se traspasa: no hace falta
    // nada mas para degradar sin borrarle el vinculo.
    const plan = esperarPlan(await planificar({ community: { id: COMUNIDAD, leaderUid: LIDER_SALIENTE } }));
    expect(plan.kind).toBe("transfer");
    expect(plan.demote).toEqual({
      uid: LIDER_SALIENTE,
      claimsPatch: { communityId: COMUNIDAD, communityStanding: "creditor" satisfies CommunityStanding }
    });
  });

  it("RF_04: un destino sin reclamos operativos previos no estrena claves que nunca tuvo", async () => {
    // Ni `sellerId: undefined` ni `driverId: null`: una clave presente con valor vacio es una
    // clave escrita, y `setCustomUserClaims` la persiste.
    const plan = esperarPlan(await planificar({ targetClaims: { role: "seller" } }));
    expect(Object.keys(plan.promote?.claimsPatch ?? {}).sort()).toEqual([
      "communityId",
      "communityStanding",
      "role"
    ]);
    expect(rastros(plan, IDENTIDAD_OPERATIVA)).toEqual([]);
  });

  it("RF_17: el instante lo pone quien llama, no un reloj global", async () => {
    const otroInstante = "2027-02-28T05:00:00.000Z";
    const plan = esperarPlan(await planificar({ nowIso: otroInstante }));
    expect(plan.communityUpdate?.leaderGrantedAt).toBe(otroInstante);
  });

  it("RF_17: una comunidad sin id no se concede a nadie", async () => {
    // Llega de una pantalla que todavia no sabe que comunidad mira. Conceder aqui escribiria un
    // `communityId: \"\"` en los reclamos, y `isCreditorOf` compara en falso con eso: el lider
    // quedaria sin gobierno y sin cobro, sin que nadie lo haya decidido.
    const rechazo = esperarRechazo(await planificar({ community: { id: "" } }));
    expect(rechazo.code).toBe("invalid-input");
  });

  it("RF_17: un destino sin uid no se concede a nadie", async () => {
    const rechazo = esperarRechazo(await planificar({ targetUid: "" }));
    expect(rechazo.code).toBe("invalid-input");
  });
});

/**
 * T4 · Nucleo puro del RETIRO del liderazgo (RF_05, RF_22) y T5 · la extincion del vinculo de
 * acreedor cuando se le paga (RF_23, RF_11).
 *
 * Van juntos en el mismo archivo porque son la misma decision leida en dos instantes distintos:
 * "esta la deuda en cero?". T4 la lee cuando el administrador retira el mando; T5 la vuelve a
 * leer cuando se marca pagado el ultimo corte. Si esa regla viviera en dos modulos podrian
 * divergir, y el dia que divergieran una cuenta se quedaria con el vinculo —y con el selector de
 * RF_11— para siempre, sin que nadie lo hubiera decidido.
 *
 * El contrato que estas pruebas fijan:
 *
 *   planLeadershipRevoke(input: {
 *     targetUid; targetClaims; community: { id; leaderUid? }; pendingCashbackCop; nowIso;
 *   }): { ok: true; kind: "revoke_clear" | "revoke_keep_creditor" | "noop"; ... }
 *    | { ok: false; code: "not-leader-here" | "invalid-input"; reason }
 *
 *   planCreditorSettlement(input: { claims; pendingCashbackCop }):
 *     { extinguish: boolean; claimsPatch: ... | null; reason }
 *
 * Igual que la concesion, los dos son PARCHES de reclamos, no juegos completos: lo que el plan no
 * puede nombrar tampoco puede borrarlo. Y borrar un campo se pide con `UNSET_FIELD`, el marcador
 * que ya usa `planSellerReassignment`, no con `null` ni con `""`: la callable es la unica que
 * traduce eso a `FieldValue`.
 *
 * La regla unica que atraviesa los dos: **solo el cero exacto extingue el vinculo**. Cualquier
 * otra cosa —positivo, negativo o no finito— lo conserva, que es el lado seguro: conservarlo de
 * mas deja un selector sobrante y se arregla pagando; borrarlo de menos apaga el cobro en
 * silencio y no deja rastro de que existia.
 */

type CuentaClaims = {
  role: string;
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
  communityId?: string;
  communityStanding?: CommunityStanding;
};

type RevokeClaimsPatch = {
  communityId: string | UnsetField;
  communityStanding: Extract<CommunityStanding, "creditor"> | UnsetField;
};

type RevokeInput = {
  targetUid: string;
  targetClaims: CuentaClaims;
  community: { id: string; leaderUid?: string };
  /** Lo que la plataforma le debe HOY por lo ya causado. Lo calcula quien llama; aqui solo se lee. */
  pendingCashbackCop: number;
  nowIso: string;
};

type RevokePlan = {
  ok: true;
  kind: "revoke_clear" | "revoke_keep_creditor" | "noop";
  communityId: string;
  /** `null` solo en el no-op. `leaderUid: UNSET_FIELD` = sale del documento de la comunidad. */
  communityUpdate: { leaderUid: UnsetField; leaderRevokedAt: string } | null;
  revoke: { uid: string; claimsPatch: RevokeClaimsPatch } | null;
  collectionsTouched: readonly string[];
  reason: string;
};

type RevokeRejection = { ok: false; code: "not-leader-here" | "invalid-input"; reason: string };
type RevokeOutcome = RevokePlan | RevokeRejection;
type RevokePlanner = (input: RevokeInput) => RevokeOutcome;

type SettlementInput = {
  claims: { communityId?: string; communityStanding?: CommunityStanding };
  pendingCashbackCop: number;
};

type SettlementResult = {
  extinguish: boolean;
  /** `null` mientras no haya nada que extinguir: un parche vacio tambien es una escritura. */
  claimsPatch: { communityId: UnsetField; communityStanding: UnsetField } | null;
  reason: string;
};

type SettlementPlanner = (input: SettlementInput) => SettlementResult;

type CicloDeVidaModule = {
  planLeadershipRevoke: RevokePlanner;
  planCreditorSettlement: SettlementPlanner;
};

/**
 * `as unknown as` y no `any`: el modulo todavia no exporta estas funciones, asi que el contrato lo
 * fija esta prueba. En rojo falla por "no es una funcion", que es exactamente lo que debe fallar.
 */
const cargarModulo = async (): Promise<CicloDeVidaModule> =>
  (await import("../../functions/src/community-grant")) as unknown as CicloDeVidaModule;

const cargarRetiro = async (): Promise<RevokePlanner> => (await cargarModulo()).planLeadershipRevoke;
const cargarPago = async (): Promise<SettlementPlanner> => (await cargarModulo()).planCreditorSettlement;

const LIDER = "uid-lider-retirado";
const OTRO_LIDER = "uid-otro-lider";

/** Lo que la cuenta era ANTES de que nadie le concediera nada. RF_05 la devuelve aqui, literal. */
const RECLAMOS_ANTES_DEL_LIDERAZGO: CuentaClaims = { ...RECLAMOS_QUE_YA_OPERAN };

/** Los mismos, ya con el sombrero puesto. Es de aqui de donde se retira. */
const RECLAMOS_LIDERANDO: CuentaClaims = {
  ...RECLAMOS_QUE_YA_OPERAN,
  communityId: COMUNIDAD,
  communityStanding: "leader"
};

const entradaRetiro = (overrides: Partial<RevokeInput> = {}): RevokeInput => ({
  targetUid: LIDER,
  targetClaims: { ...RECLAMOS_LIDERANDO },
  community: { id: COMUNIDAD, leaderUid: LIDER },
  pendingCashbackCop: 0,
  nowIso: NOW,
  ...overrides
});

const retirar = async (overrides: Partial<RevokeInput> = {}): Promise<RevokeOutcome> =>
  (await cargarRetiro())(entradaRetiro(overrides));

const esperarRetiro = (outcome: RevokeOutcome): RevokePlan => {
  if (!outcome.ok) throw new Error(`Se esperaba un plan de retiro y llego un rechazo: ${outcome.reason}`);
  return outcome;
};

const esperarRechazoRetiro = (outcome: RevokeOutcome): RevokeRejection => {
  if (outcome.ok) throw new Error(`Se esperaba un rechazo y llego un plan: ${outcome.kind}`);
  return outcome;
};

/**
 * Lo que `setCustomUserClaims` acabara guardando: los reclamos leidos, con el parche encima, y sin
 * las claves marcadas `UNSET_FIELD`. Se simula aqui porque RF_05 no habla del parche sino del
 * RESULTADO —"la cuenta operando exactamente como antes"—, y esa frase solo se puede afirmar
 * mirando el juego completo.
 */
const aplicarParche = (claims: CuentaClaims, patch: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  const resultado: Record<string, unknown> = { ...claims };
  for (const [clave, valor] of Object.entries(patch ?? {})) {
    if (isUnsetField(valor)) delete resultado[clave];
    else resultado[clave] = valor;
  }
  return resultado;
};

/**
 * RF_11 reducido a la unica pregunta que la pantalla le hace a los reclamos. Vive en la prueba y
 * no en el modulo a proposito: T5 no decide como se pinta el selector, decide si los reclamos que
 * quedan pueden seguir respondiendo "si". La pantalla (T11) leera esto mismo.
 */
const necesitaSelector = (claims: Record<string, unknown>): boolean =>
  typeof claims.communityId === "string" && claims.communityId.trim() !== "";

describe("T4 · retirar el liderazgo de una comunidad (RF_05, RF_22)", () => {
  it("RF_05: control positivo del barrido — un plan de retiro que nombrara la identidad operativa seria visto", () => {
    // Sin esto, un barrido que no bajara al `claimsPatch` daria vacio por estar roto, no por estar
    // limpio, y los asertos de RF_05 pasarian con un plan que si pisa la tienda.
    const planFalsoQueSiLaToca = {
      revoke: { uid: LIDER, claimsPatch: { sellerId: "seller-42", communityId: UNSET_FIELD } }
    };
    expect(rastros(planFalsoQueSiLaToca, IDENTIDAD_OPERATIVA).sort()).toEqual(["seller-42", "sellerId"]);
  });

  it("RF_05: con deuda cero los reclamos quedan EXACTAMENTE como antes de concederle el liderazgo", async () => {
    // El aserto que mas vale de T4, y por eso se afirma sobre el juego COMPLETO y no sobre el
    // parche: "exactamente como antes" es una igualdad, no una lista de campos que alguien tiene
    // que acordarse de comprobar.
    const plan = esperarRetiro(await retirar());
    expect(aplicarParche(RECLAMOS_LIDERANDO, plan.revoke?.claimsPatch)).toEqual({ ...RECLAMOS_ANTES_DEL_LIDERAZGO });
  });

  it("RF_05: con deuda cero el parche quita el vinculo entero — las dos claves, no una", async () => {
    const plan = esperarRetiro(await retirar());
    expect(plan.kind).toBe("revoke_clear");
    expect(plan.revoke).toEqual({
      uid: LIDER,
      claimsPatch: { communityId: UNSET_FIELD, communityStanding: UNSET_FIELD }
    });
  });

  it("RF_22: con deuda pendiente el vinculo QUEDA como acreedor y conserva el communityId", async () => {
    // Borrarlo apagaria su cobro en silencio: `isCreditorOf` compara contra ese id, y sin el la
    // pantalla desde la que se le paga deja de existir para el. Eso es justo lo que RF_22 prohibe.
    const plan = esperarRetiro(await retirar({ pendingCashbackCop: 250_000 }));
    expect(plan.kind).toBe("revoke_keep_creditor");
    expect(plan.revoke).toEqual({
      uid: LIDER,
      claimsPatch: { communityId: COMUNIDAD, communityStanding: "creditor" satisfies CommunityStanding }
    });
  });

  it("RF_22: con deuda pendiente el juego de reclamos resultante sigue nombrando la comunidad", async () => {
    const plan = esperarRetiro(await retirar({ pendingCashbackCop: 250_000 }));
    const resultantes = aplicarParche(RECLAMOS_LIDERANDO, plan.revoke?.claimsPatch);
    expect(resultantes.communityId).toBe(COMUNIDAD);
    expect(resultantes.communityStanding).toBe("creditor");
  });

  it("RF_05: el leaderUid sale del documento de la comunidad con deuda cero", async () => {
    const plan = esperarRetiro(await retirar());
    expect(plan.communityUpdate).toEqual({ leaderUid: UNSET_FIELD, leaderRevokedAt: NOW });
  });

  it("RF_05: el leaderUid sale del documento de la comunidad TAMBIEN con deuda pendiente", async () => {
    // Seguir acreedor no es seguir liderando (RF_23). Si la deuda dejara el leaderUid puesto, la
    // comunidad seguiria cobrando el sobreprecio de RF_20 para un lider que ya no gobierna.
    const plan = esperarRetiro(await retirar({ pendingCashbackCop: 1 }));
    expect(plan.communityUpdate).toEqual({ leaderUid: UNSET_FIELD, leaderRevokedAt: NOW });
  });

  it("RF_05: el retiro no nombra sellerId, driverId ni messengerId — con deuda y sin ella", async () => {
    const sinDeuda = esperarRetiro(await retirar());
    const conDeuda = esperarRetiro(await retirar({ pendingCashbackCop: 900_000 }));
    expect(rastros(sinDeuda, IDENTIDAD_OPERATIVA)).toEqual([]);
    expect(rastros(conDeuda, IDENTIDAD_OPERATIVA)).toEqual([]);
  });

  it("RF_05: el retiro no toca el role — deja de liderar, no deja de trabajar", async () => {
    const plan = esperarRetiro(await retirar());
    expect(valoresDeClave(plan.revoke, "role")).toEqual([]);
  });

  it("RF_05: el retiro no nombra ni un asiento, ni un corte, ni un pedido", async () => {
    // MUST NOT tocar el cashback ya causado: si el plan ni siquiera puede mencionar esas
    // colecciones, no hay forma de que las reverse al retirar el mando.
    const sinDeuda = esperarRetiro(await retirar());
    const conDeuda = esperarRetiro(await retirar({ pendingCashbackCop: 900_000 }));
    expect(rastros(sinDeuda, PALABRAS_DE_DINERO)).toEqual([]);
    expect(rastros(conDeuda, PALABRAS_DE_DINERO)).toEqual([]);
  });

  it("RF_05: el alcance declarado del retiro son los reclamos y la comunidad, y nada mas", async () => {
    const plan = esperarRetiro(await retirar());
    expect([...plan.collectionsTouched].sort()).toEqual(["authClaims", "communities"]);
  });

  it("RF_05: el instante lo pone quien llama, no un reloj global", async () => {
    const otroInstante = "2027-02-28T05:00:00.000Z";
    const plan = esperarRetiro(await retirar({ nowIso: otroInstante }));
    expect(plan.communityUpdate?.leaderRevokedAt).toBe(otroInstante);
  });

  it("RF_05: retirar a quien NO lidera esa comunidad se rechaza y nombra a quien la lidera", async () => {
    // El documento de la comunidad es el unico sitio donde "quien lidera" es unico, igual que en
    // la concesion. Aplicar el retiro aqui borraria el vinculo del destino sin quitarle el mando a
    // nadie, y dejaria vivo a un lider que el administrador creia haber retirado.
    const rechazo = esperarRechazoRetiro(await retirar({ community: { id: COMUNIDAD, leaderUid: OTRO_LIDER } }));
    expect(rechazo.code).toBe("not-leader-here");
    expect(rechazo.reason).toContain(OTRO_LIDER);
  });

  it("RF_05: el documento sin lider y unos reclamos que aun llevan el sombrero SE REPARAN, no son un no-op", async () => {
    // Un retiro a medias (la comunidad se escribio, los reclamos no) tiene que poder terminarse
    // volviendo a pedirlo. Si esto respondiera no-op, esa cuenta se quedaria con el sombrero para
    // siempre y no habria forma de quitarselo.
    const plan = esperarRetiro(await retirar({ community: { id: COMUNIDAD } }));
    expect(plan.kind).toBe("revoke_clear");
    expect(plan.revoke?.uid).toBe(LIDER);
  });

  it("RF_05: retirar dos veces es un no-op sin escrituras, no un rechazo", async () => {
    // Doble clic y reintento tras un timeout acaban aqui, y ninguno es un error del
    // administrador. El destino ya es acreedor de esa comunidad y la comunidad ya no tiene lider.
    const plan = esperarRetiro(
      await retirar({
        community: { id: COMUNIDAD },
        targetClaims: { ...RECLAMOS_QUE_YA_OPERAN, communityId: COMUNIDAD, communityStanding: "creditor" },
        pendingCashbackCop: 400_000
      })
    );
    expect(plan.kind).toBe("noop");
    expect(plan.communityUpdate).toBeNull();
    expect(plan.revoke).toBeNull();
    expect(plan.collectionsTouched).toEqual([]);
  });

  it("RF_22: una deuda NEGATIVA tampoco es cero — el lider le debe a la plataforma y el vinculo se conserva", async () => {
    // Netear por debajo de cero (reversas de cashback ya pagado) invierte el sentido de la deuda,
    // no la salda: es la plataforma quien tiene algo que reclamarle. Borrar el vinculo ahi seria
    // borrar el unico sitio donde consta a quien reclamarlo, y ademas dejaria sin explicacion el
    // saldo negativo que quedaria colgando. Solo el cero exacto extingue.
    const plan = esperarRetiro(await retirar({ pendingCashbackCop: -80_000 }));
    expect(plan.kind).toBe("revoke_keep_creditor");
    expect(plan.revoke?.claimsPatch.communityId).toBe(COMUNIDAD);
  });

  it("RF_22: una deuda que no es un numero finito no es cero — se conserva el vinculo, que es el lado seguro", async () => {
    // Una suma sobre una lectura fallida da NaN. Tratarlo como cero borraria el cobro por un fallo
    // de lectura; tratarlo como deuda deja un selector de mas, que se arregla pagando.
    const plan = esperarRetiro(await retirar({ pendingCashbackCop: Number.NaN }));
    expect(plan.kind).toBe("revoke_keep_creditor");
  });

  it("RF_05: un retiro sin uid no se aplica a nadie", async () => {
    const rechazo = esperarRechazoRetiro(await retirar({ targetUid: "" }));
    expect(rechazo.code).toBe("invalid-input");
  });

  it("RF_05: un retiro sin comunidad no se aplica a nada", async () => {
    // Sin id no se puede comprobar que el vinculo que se borra sea el de ESTA comunidad, y con
    // deuda pendiente el parche escribiria `communityId: \"\"`, que no cobra en ningun sitio.
    const rechazo = esperarRechazoRetiro(await retirar({ community: { id: "", leaderUid: LIDER } }));
    expect(rechazo.code).toBe("invalid-input");
  });
});

describe("T5 · el acreedor deja de serlo cuando se le paga (RF_23, RF_11)", () => {
  const pagar = async (overrides: Partial<SettlementInput> = {}): Promise<SettlementResult> =>
    (await cargarPago())({
      claims: { communityId: COMUNIDAD, communityStanding: "creditor" },
      pendingCashbackCop: 0,
      ...overrides
    });

  it("RF_23: un acreedor cuya deuda pasa a cero extingue el vinculo", async () => {
    const resultado = await pagar();
    expect(resultado.extinguish).toBe(true);
    expect(resultado.claimsPatch).toEqual({ communityId: UNSET_FIELD, communityStanding: UNSET_FIELD });
  });

  it("RF_23: un acreedor con deuda viva sigue siendo acreedor y no se le escribe nada", async () => {
    const resultado = await pagar({ pendingCashbackCop: 120_000 });
    expect(resultado.extinguish).toBe(false);
    expect(resultado.claimsPatch).toBeNull();
  });

  it("RF_23: a un LIDER con deuda cero no se le extingue nada — liderar no depende de que le deban", async () => {
    // El caso que separa los dos conceptos. Si el pago del ultimo corte mirara solo la cifra,
    // cada cierre de caja le quitaria la comunidad al lider que la gobierna.
    const resultado = await pagar({ claims: { communityId: COMUNIDAD, communityStanding: "leader" } });
    expect(resultado.extinguish).toBe(false);
    expect(resultado.claimsPatch).toBeNull();
  });

  it("RF_23: la AUSENCIA de communityStanding significa lider, asi que tampoco se extingue", async () => {
    // Es el estado de todos los reclamos vivos: la posicion se escribe para retirar, nunca para
    // conceder. Leer la ausencia como acreedor le quitaria la comunidad a todo lider existente el
    // dia que se le pague un corte.
    const resultado = await pagar({ claims: { communityId: COMUNIDAD } });
    expect(resultado.extinguish).toBe(false);
  });

  it("RF_23: una deuda negativa no es cero — el acreedor sigue vinculado", async () => {
    const resultado = await pagar({ pendingCashbackCop: -1 });
    expect(resultado.extinguish).toBe(false);
  });

  it("RF_23: una deuda no finita no es cero — no se extingue por un fallo de lectura", async () => {
    const resultado = await pagar({ pendingCashbackCop: Number.NaN });
    expect(resultado.extinguish).toBe(false);
  });

  it("RF_23: una cuenta sin vinculo no tiene nada que extinguir, y un parche vacio tambien es una escritura", async () => {
    const resultado = await pagar({ claims: {} });
    expect(resultado.extinguish).toBe(false);
    expect(resultado.claimsPatch).toBeNull();
  });

  it("RF_11: al extinguirse el vinculo, la cuenta de un solo papel deja de necesitar selector", async () => {
    // La razon de ser de T5. Antes del pago la cuenta arrastra la deuda de un papel anterior y el
    // selector hace falta (RF_11 lo exceptua explicitamente); despues no queda mas que su tienda.
    // Sin esta extincion ese selector no se apaga nunca.
    const reclamosDeAcreedor: CuentaClaims = {
      ...RECLAMOS_ANTES_DEL_LIDERAZGO,
      communityId: COMUNIDAD,
      communityStanding: "creditor"
    };
    expect(necesitaSelector({ ...reclamosDeAcreedor })).toBe(true);

    const resultado = await pagar();
    expect(necesitaSelector(aplicarParche(reclamosDeAcreedor, resultado.claimsPatch))).toBe(false);
  });

  it("RF_11: mientras la deuda siga viva el selector sigue haciendo falta", async () => {
    const reclamosDeAcreedor: CuentaClaims = {
      ...RECLAMOS_ANTES_DEL_LIDERAZGO,
      communityId: COMUNIDAD,
      communityStanding: "creditor"
    };
    const resultado = await pagar({ pendingCashbackCop: 120_000 });
    expect(necesitaSelector(aplicarParche(reclamosDeAcreedor, resultado.claimsPatch))).toBe(true);
  });

  it("RF_05: extinguir el vinculo devuelve la cuenta a lo que era, sin tocar su identidad operativa", async () => {
    const reclamosDeAcreedor: CuentaClaims = {
      ...RECLAMOS_ANTES_DEL_LIDERAZGO,
      communityId: COMUNIDAD,
      communityStanding: "creditor"
    };
    const resultado = await pagar();
    expect(aplicarParche(reclamosDeAcreedor, resultado.claimsPatch)).toEqual({ ...RECLAMOS_ANTES_DEL_LIDERAZGO });
    expect(rastros(resultado, IDENTIDAD_OPERATIVA)).toEqual([]);
  });

  it("RF_23: el pago del ultimo corte no nombra ni un asiento ni un corte — solo decide sobre el vinculo", async () => {
    // Quien escribe los asientos es `orders.ts` al marcar pagado el corte; esta funcion solo le
    // dice que hacer con los reclamos. Si pudiera nombrar el dinero, podria recalcularlo.
    const resultado = await pagar();
    expect(rastros(resultado, PALABRAS_DE_DINERO)).toEqual([]);
  });
});
