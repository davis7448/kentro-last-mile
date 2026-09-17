/**
 * RF_04, RF_06, RF_17, RF_18, RF_19: conceder el liderazgo de una comunidad a una cuenta que YA
 * opera en la plataforma. Y, al final del archivo, las dos caras del camino de vuelta: el RETIRO
 * del mando (RF_05, RF_22) y la EXTINCION del vinculo de acreedor cuando se le termina de pagar
 * (RF_23, RF_11). Viven juntas porque las tres leen la misma pregunta —"esta en cero lo que se le
 * debe?"— en instantes distintos; separadas podrian divergir, y el dia que divergieran una cuenta
 * se quedaria vinculada para siempre sin que nadie lo hubiera decidido.
 *
 * Este modulo solo DESCRIBE lo que hay que escribir. Quien escribe es la callable, igual que en
 * `community-leader-create.ts` (RF_55) y en `community-containment.ts` (RF_41). Por eso no
 * importa `firebase-admin` ni `firebase-functions` ni mira el reloj: el instante entra por
 * `nowIso`. Asi la decision entera se prueba con Vitest desde la raiz del repo, que es donde se
 * puede comprobar barata y repetidamente algo que toca a la vez los reclamos de dos cuentas y el
 * documento de una comunidad.
 *
 * Por que el plan es un PARCHE de reclamos y no el juego completo
 * --------------------------------------------------------------
 * `setCustomUserClaims` REEMPLAZA los reclamos: lo que no vaya en la llamada desaparece. Si este
 * plan describiera el estado final tendria que NOMBRAR `sellerId` —y `driverId`, y
 * `messengerId`— para conservarlos, y RF_04 quedaria colgando de que nadie se olvide nunca de
 * copiarlos: el dia que se olvidara, la tienda perderia su identidad operativa en el mismo
 * commit en que gana un sombrero nuevo, sin error y sin una linea en el log. Describiendo solo
 * lo que CAMBIA, conservar lo demas deja de ser una tarea que se pueda olvidar, porque el plan
 * literalmente no puede nombrarlo. La callable aplica el parche SOBRE los reclamos que acaba de
 * leer.
 *
 * Por que `communityStanding: "leader"` se escribe EXPLICITO
 * ---------------------------------------------------------
 * Su ausencia ya significa lider (ver `Actor.communityStanding` en `community-access.ts`), asi
 * que omitirlo parece inofensivo. No lo es: conceder es tambien el camino de vuelta de un
 * acreedor retirado, y ese SI lleva `"creditor"` escrito. Un parche que no nombrara el campo
 * dejaria el `"creditor"` viejo intacto y la concesion no concederia nada — retirado con cara de
 * lider nuevo.
 *
 * Por que el traspaso no es otra funcion
 * --------------------------------------
 * Traspasar no es una operacion distinta de conceder: es el caso en que la comunidad YA tiene
 * lider (RF_19). Partirlo en dos funciones obligaria a quien llama a decidir antes cual de las
 * dos toca, y esa decision —leer `leaderUid` y compararlo— es justo la que aqui se prueba. Con
 * una sola entrada, "ya habia lider" no puede pasarse por alto: la degradacion sale del mismo
 * plan que la promocion, y la callable las mete en la misma transaccion. RF_18 (una comunidad,
 * un lider) se cumple porque no hay forma de pedir lo uno sin lo otro.
 */

import { UNSET_FIELD } from "./community-access";
import type { CommunityStanding, UnsetField } from "./community-access";

/** Lo que cambia en los reclamos de quien RECIBE el liderazgo. Nada mas: ver la cabecera. */
export type ClaimsPatch = {
  /**
   * Se reescribe con el MISMO valor que ya tenia. Liderar es una atribucion de la cuenta, no un
   * papel que sustituya al suyo (RF_02): pisar el role con algo como "community_leader" dejaria
   * a la tienda sin poder entrar a sus propios pedidos.
   */
  role: string;
  communityId: string;
  communityStanding: Extract<CommunityStanding, "leader">;
};

/** Lo que cambia en los reclamos de quien DEJA de liderar. Conserva el vinculo: ver `demote`. */
export type DemoteClaimsPatch = {
  communityId: string;
  communityStanding: Extract<CommunityStanding, "creditor">;
};

export type GrantTargetClaims = {
  role: string;
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
  communityId?: string;
  communityStanding?: CommunityStanding;
};

export type GrantCommunity = {
  id: string;
  /** Quien la lidera hoy, segun el DOCUMENTO. Ausente o vacio: no tiene lider. */
  leaderUid?: string;
  /** Ausente significa que la comunidad YA existe. `false` pide crearla en el mismo acto. */
  exists?: boolean;
};

export type GrantCurrentLeaderClaims = {
  uid: string;
  communityId?: string;
  communityStanding?: CommunityStanding;
};

export type LeadershipGrantInput = {
  targetUid: string;
  targetClaims: GrantTargetClaims;
  community: GrantCommunity;
  /**
   * Contexto que la callable quiza ya leyo. NO decide nada, y es deliberado: si la degradacion
   * dependiera de poder leer estos reclamos, un fallo de lectura dejaria DOS lideres vivos
   * (RF_18). Quien lidera hoy lo dice el documento de la comunidad, que es el unico sitio donde
   * ese hecho es unico.
   */
  currentLeaderClaims?: GrantCurrentLeaderClaims;
  nowIso: string;
};

export type LeadershipGrantRejection = {
  ok: false;
  code: "already-leads-other" | "creditor-of-other" | "invalid-input";
  reason: string;
};

export type LeadershipGrantPlan = {
  ok: true;
  kind: "grant" | "create_and_grant" | "transfer" | "noop";
  communityId: string;
  createCommunity: boolean;
  /** `null` solo en el no-op: no hay nada que escribir. */
  communityUpdate: { leaderUid: string; leaderGrantedAt: string } | null;
  promote: { uid: string; claimsPatch: ClaimsPatch } | null;
  demote: { uid: string; claimsPatch: DemoteClaimsPatch } | null;
  /** Vacio en el no-op. Sirve para que la callable sepa que transaccion abrir. */
  collectionsTouched: readonly string[];
  reason: string;
};

export type LeadershipGrantOutcome = LeadershipGrantPlan | LeadershipGrantRejection;

const COLECCIONES_DE_LA_CONCESION: readonly string[] = ["authClaims", "communities"];
const SIN_COLECCIONES: readonly string[] = [];

const vacio = (value: string | undefined): boolean => (value ?? "").trim() === "";

/**
 * `?? "leader"` porque la ausencia del campo es el estado de TODOS los reclamos vivos: la
 * posicion se escribe para retirar, nunca para conceder (ver `community-access.ts`). Leer la
 * ausencia como "creditor" convertiria a cualquier lider actual en un acreedor retirado.
 */
const posicion = (standing: CommunityStanding | undefined): CommunityStanding => standing ?? "leader";

export function planLeadershipGrant(input: LeadershipGrantInput): LeadershipGrantOutcome {
  const { targetUid, targetClaims, community, nowIso } = input;

  /**
   * El `communityId: ""` que llega de una pantalla que todavia no sabe que comunidad mira no se
   * puede conceder: `isCreditorOf` compara en falso contra la cadena vacia, asi que la cuenta
   * quedaria con un sombrero que no gobierna nada y tampoco cobra nada. Y sin uid no hay a quien
   * conceder.
   */
  if (vacio(targetUid)) {
    return { ok: false, code: "invalid-input", reason: "No se indico la cuenta a la que conceder el liderazgo." };
  }
  if (vacio(community.id)) {
    return { ok: false, code: "invalid-input", reason: "No se indico la comunidad que se concede." };
  }
  /**
   * El parche NOMBRA `role`, asi que un role vacio no se quedaria como estaba: se escribiria
   * vacio, y la cuenta dejaria de ser lo que era al recibir el sombrero.
   */
  if (vacio(targetClaims.role)) {
    return { ok: false, code: "invalid-input", reason: "La cuenta no tiene un rol operativo que conservar." };
  }

  const communityId = community.id;
  const vinculoPrevio = vacio(targetClaims.communityId) ? "" : (targetClaims.communityId as string);
  const posicionPrevia = posicion(targetClaims.communityStanding);

  if (vinculoPrevio !== "" && vinculoPrevio !== communityId) {
    /**
     * RF_06: un reclamo solo puede llevar UN `communityId`, asi que conceder esta comunidad
     * sobreescribiria el vinculo con la otra. Si alla lidera, se rechaza porque una cuenta
     * lidera como mucho una comunidad. Y si alla es ACREEDOR se rechaza por una razon peor: ese
     * vinculo es lo unico por lo que la plataforma sabe que todavia le debe lo ya causado
     * (RF_22). No es un permiso que se pisa, es una deuda que se apaga en silencio. Los dos
     * motivos NOMBRAN la otra comunidad, que es lo que le permite al administrador resolverlo.
     */
    return posicionPrevia === "creditor"
      ? {
          ok: false,
          code: "creditor-of-other",
          reason:
            `Esa cuenta sigue vinculada a la comunidad ${vinculoPrevio} como acreedora de lo ya causado. ` +
            `Concederle ${communityId} borraria ese vinculo. Liquida antes lo que se le deba alli.`
        }
      : {
          ok: false,
          code: "already-leads-other",
          reason: `Esa cuenta ya lidera la comunidad ${vinculoPrevio}. Una cuenta lidera como mucho una comunidad.`
        };
  }

  const lideraHoy = vacio(community.leaderUid) ? "" : (community.leaderUid as string);

  /**
   * RF_18: el estado que se pide YA es el estado real. Se responde no-op y no rechazo porque
   * aqui acaban el doble clic, el reintento tras un timeout y el refresco de la pantalla, y
   * ninguno es un error del administrador; un rechazo empujaria ademas a la callable a tratar
   * "ya esta hecho" como "no se pudo hacer".
   *
   * Se exige que las TRES cosas coincidan —quien lidera segun la comunidad, el vinculo de los
   * reclamos y la posicion— porque si alguna no cuadra hay algo que arreglar y el plan tiene que
   * arreglarlo: un acreedor retirado al que su comunidad todavia apunta vuelve por el camino de
   * la concesion, no por el del no-op.
   */
  if (lideraHoy === targetUid && vinculoPrevio === communityId && posicionPrevia === "leader") {
    return {
      ok: true,
      kind: "noop",
      communityId,
      createCommunity: false,
      communityUpdate: null,
      promote: null,
      demote: null,
      collectionsTouched: SIN_COLECCIONES,
      reason: `Esa cuenta ya lidera la comunidad ${communityId}: no hay nada que cambiar.`
    };
  }

  const promote = {
    uid: targetUid,
    claimsPatch: {
      role: targetClaims.role,
      communityId,
      communityStanding: "leader" as const
    }
  };

  /**
   * RF_19: el saliente CONSERVA su `communityId`. Retirarle el vinculo junto con el mando
   * apagaria lo ya causado en el mismo commit (RF_22). Y no se toca su `role`: deja de liderar,
   * no deja de trabajar.
   *
   * Sale del documento de la comunidad y no de `currentLeaderClaims` a proposito: ver la nota de
   * ese campo en la entrada. El `!== targetUid` evita el peor final posible del mismo uid en las
   * dos puntas: degradarlo y promoverlo, que con el orden equivocado deja la comunidad sin
   * lider.
   */
  const demote =
    lideraHoy !== "" && lideraHoy !== targetUid
      ? {
          uid: lideraHoy,
          claimsPatch: { communityId, communityStanding: "creditor" as const }
        }
      : null;

  const createCommunity = community.exists === false;
  const kind = demote ? "transfer" : createCommunity ? "create_and_grant" : "grant";

  return {
    ok: true,
    kind,
    communityId,
    createCommunity,
    /**
     * RF_17: crear la comunidad y asignarla son el MISMO plan, no dos llamadas encadenadas. Si
     * fueran dos, un fallo entre medias devolveria la comunidad fantasma de RF_55.
     */
    communityUpdate: { leaderUid: targetUid, leaderGrantedAt: nowIso },
    promote,
    demote,
    collectionsTouched: COLECCIONES_DE_LA_CONCESION,
    reason: motivo(kind, { communityId, targetUid, salienteUid: demote?.uid ?? "" })
  };
}

/**
 * El motivo acaba en los registros, asi que se redacta aqui y no en la callable. No nombra ni un
 * identificador operativo ni nada del dinero del saliente: lo que el plan no puede mencionar,
 * tampoco puede tocarlo.
 */
function motivo(
  kind: LeadershipGrantPlan["kind"],
  datos: { communityId: string; targetUid: string; salienteUid: string }
): string {
  if (kind === "transfer") {
    return (
      `La comunidad ${datos.communityId} ya tenia lider: ${datos.salienteUid} deja el mando y conserva su vinculo, ` +
      `y ${datos.targetUid} pasa a liderarla.`
    );
  }
  if (kind === "create_and_grant") {
    return `Se crea la comunidad ${datos.communityId} y se le asigna ${datos.targetUid} como lider en el mismo acto.`;
  }
  return `${datos.targetUid} pasa a liderar la comunidad ${datos.communityId}.`;
}

/* ------------------------------------------------------------------------------------------- *
 * RF_05, RF_22: retirar el liderazgo. Y RF_23, RF_11: apagar el vinculo cuando se termina de pagar.
 * ------------------------------------------------------------------------------------------- */

/**
 * Lo que cambia en los reclamos de quien deja de liderar por retiro.
 *
 * Las dos claves van siempre juntas y con el mismo destino: o las dos se quitan (`UNSET_FIELD`) o
 * las dos se escriben. Quitar solo la posicion dejaria un vinculo sin sentido; quitar solo el
 * vinculo dejaria un `"creditor"` de nada, que es peor: `isCreditorOf` compara contra el
 * `communityId`, asi que sin el la cuenta figuraria retirada y no cobraria en ningun sitio.
 *
 * `UNSET_FIELD` y no `null` ni `""`: es el marcador que ya usa `planSellerReassignment`, y la
 * callable es la unica que lo traduce a `FieldValue.delete()`. Un `null` se PERSISTE, y una clave
 * presente con valor vacio es una clave escrita.
 */
export type RevokeClaimsPatch = {
  communityId: string | UnsetField;
  communityStanding: Extract<CommunityStanding, "creditor"> | UnsetField;
};

export type RevokeTargetClaims = GrantTargetClaims;

export type LeadershipRevokeInput = {
  targetUid: string;
  targetClaims: RevokeTargetClaims;
  community: { id: string; leaderUid?: string };
  /**
   * Lo que la plataforma le debe HOY por lo ya causado. Lo calcula quien llama; aqui solo se lee.
   * Entra como cifra y no como booleano a proposito: quien llama no puede decidir "esto cuenta
   * como saldado", que es justo la decision que este modulo existe para tomar en un solo sitio.
   */
  pendingCashbackCop: number;
  nowIso: string;
};

export type LeadershipRevokeRejection = {
  ok: false;
  code: "not-leader-here" | "invalid-input";
  reason: string;
};

export type LeadershipRevokePlan = {
  ok: true;
  kind: "revoke_clear" | "revoke_keep_creditor" | "noop";
  communityId: string;
  /** `null` solo en el no-op. `leaderUid: UNSET_FIELD` = sale del documento de la comunidad. */
  communityUpdate: { leaderUid: UnsetField; leaderRevokedAt: string } | null;
  revoke: { uid: string; claimsPatch: RevokeClaimsPatch } | null;
  /** Vacio en el no-op. Sirve para que la callable sepa que transaccion abrir. */
  collectionsTouched: readonly string[];
  reason: string;
};

export type LeadershipRevokeOutcome = LeadershipRevokePlan | LeadershipRevokeRejection;

/**
 * Solo el cero EXACTO extingue el vinculo.
 *
 * Positivo es obvio: queda algo por pagar. Los otros dos no lo son, y son los que importan.
 *
 *  - NEGATIVO no es saldado, es la deuda al reves: netear por debajo de cero (una reversa de algo
 *    ya pagado) significa que es el lider quien le debe a la plataforma. Borrar el vinculo ahi
 *    borraria el unico sitio donde consta a quien reclamarle, y dejaria colgando un numero en rojo
 *    sin dueño.
 *  - NO FINITO no es una cifra: un `NaN` es lo que devuelve una suma sobre una lectura que fallo.
 *    Leerlo como cero apagaria un cobro por un fallo de red.
 *
 * La asimetria es deliberada porque las dos equivocaciones no cuestan lo mismo: conservar de mas
 * deja un vinculo sobrante —un selector de mas en la pantalla (RF_11)— y se arregla pagando;
 * borrar de menos apaga el cobro en silencio y no deja rastro de que existia.
 */
const estaSaldado = (pendingCashbackCop: number): boolean =>
  Number.isFinite(pendingCashbackCop) && pendingCashbackCop === 0;

export function planLeadershipRevoke(input: LeadershipRevokeInput): LeadershipRevokeOutcome {
  const { targetUid, targetClaims, community, pendingCashbackCop, nowIso } = input;

  if (vacio(targetUid)) {
    return { ok: false, code: "invalid-input", reason: "No se indico la cuenta a la que retirar el liderazgo." };
  }
  /**
   * Sin id no se puede comprobar que el vinculo que se toca sea el de ESTA comunidad, y con deuda
   * viva el parche escribiria `communityId: ""`, que no cobra en ningun sitio.
   */
  if (vacio(community.id)) {
    return { ok: false, code: "invalid-input", reason: "No se indico la comunidad de la que se retira el liderazgo." };
  }

  const communityId = community.id;
  const lideraHoy = vacio(community.leaderUid) ? "" : (community.leaderUid as string);
  const vinculoPrevio = vacio(targetClaims.communityId) ? "" : (targetClaims.communityId as string);

  /**
   * Quien lidera lo dice el DOCUMENTO, igual que en la concesion: es el unico sitio donde ese
   * hecho es unico. Aplicar aqui el retiro le borraria el vinculo al destino sin quitarle el mando
   * a nadie, y dejaria vivo a un lider que el administrador creia haber retirado. El motivo NOMBRA
   * a quien si la lidera, que es lo que le permite resolverlo.
   */
  if (lideraHoy !== "" && lideraHoy !== targetUid) {
    return {
      ok: false,
      code: "not-leader-here",
      reason: `La comunidad ${communityId} la lidera ${lideraHoy}, no ${targetUid}. Retira a ${lideraHoy} si es lo que quieres.`
    };
  }

  /**
   * El vinculo de los reclamos apunta a OTRA comunidad. No se toca: con deuda viva el parche lo
   * sobreescribiria con esta, y sin ella lo borraria — las dos cosas apagan un cobro ajeno a esta
   * operacion (RF_22). Se rechaza nombrando las dos comunidades en vez de adivinar cual vale.
   */
  if (vinculoPrevio !== "" && vinculoPrevio !== communityId) {
    return {
      ok: false,
      code: "invalid-input",
      reason:
        `Esa cuenta esta vinculada a la comunidad ${vinculoPrevio}, no a ${communityId}. ` +
        `Retirarla aqui tocaria un vinculo que no es el de esta comunidad.`
    };
  }

  const llevaElSombrero = vinculoPrevio === communityId && posicion(targetClaims.communityStanding) === "leader";

  /**
   * La comunidad ya no tiene lider y el destino ya no lleva el sombrero: el retiro esta hecho. Se
   * responde no-op y no rechazo porque aqui acaban el doble clic y el reintento tras un timeout, y
   * ninguno es un error del administrador.
   *
   * Que el destino siga siendo acreedor no cambia nada: seguir cobrando lo ya causado es el estado
   * NORMAL de un retirado (RF_22), no un retiro a medio hacer. Quien apaga ese vinculo es
   * `planCreditorSettlement` cuando se le termina de pagar, no un segundo retiro.
   *
   * Lo contrario —documento sin lider pero reclamos que aun llevan el sombrero— SI se repara: es
   * un retiro que se quedo a medias (se escribio la comunidad, no los reclamos), y tiene que poder
   * terminarse volviendo a pedirlo. Si respondiera no-op, esa cuenta se quedaria con el mando para
   * siempre y no habria forma de quitarselo.
   */
  if (lideraHoy === "" && !llevaElSombrero) {
    return {
      ok: true,
      kind: "noop",
      communityId,
      communityUpdate: null,
      revoke: null,
      collectionsTouched: SIN_COLECCIONES,
      reason: `Esa cuenta ya no lidera la comunidad ${communityId}: no hay nada que cambiar.`
    };
  }

  const saldado = estaSaldado(pendingCashbackCop);

  return {
    ok: true,
    kind: saldado ? "revoke_clear" : "revoke_keep_creditor",
    communityId,
    /**
     * El `leaderUid` sale del documento en los DOS casos, tambien con deuda viva: seguir acreedor
     * no es seguir liderando (RF_23). Dejarlo puesto por deber dinero haria que la comunidad
     * siguiera gobernada —y cobrando el sobreprecio de RF_20— por alguien a quien ya se retiro, y
     * la proxima concesion lo leeria como un traspaso de un mando que ya no existe.
     */
    communityUpdate: { leaderUid: UNSET_FIELD, leaderRevokedAt: nowIso },
    revoke: {
      uid: targetUid,
      /**
       * Un PARCHE, no el juego completo: el `role` y la identidad operativa ni se nombran, asi que
       * conservarlos no es una tarea que nadie pueda olvidar (RF_05). Deja de liderar, no deja de
       * trabajar.
       */
      claimsPatch: saldado
        ? { communityId: UNSET_FIELD, communityStanding: UNSET_FIELD }
        : { communityId, communityStanding: "creditor" as const }
    },
    collectionsTouched: COLECCIONES_DE_LA_CONCESION,
    reason: saldado
      ? `${targetUid} deja de liderar la comunidad ${communityId} y no queda nada a su favor: el vinculo se apaga entero.`
      : `${targetUid} deja de liderar la comunidad ${communityId} y sigue vinculada como acreedora de lo ya causado.`
  };
}

export type CreditorSettlementInput = {
  claims: { communityId?: string; communityStanding?: CommunityStanding };
  pendingCashbackCop: number;
};

export type CreditorSettlementResult = {
  extinguish: boolean;
  /** `null` mientras no haya nada que extinguir: un parche vacio tambien es una escritura. */
  claimsPatch: { communityId: UnsetField; communityStanding: UnsetField } | null;
  reason: string;
};

/**
 * RF_23, RF_11: que hacer con los reclamos de un ACREEDOR cuando se le acaba de pagar.
 *
 * Es la misma pregunta del retiro leida mas tarde, y por eso comparte `estaSaldado` en vez de
 * repetir la comparacion: el dia que las dos versiones divergieran, una cuenta se quedaria con el
 * vinculo —y con el selector de comunidad de RF_11— para siempre.
 *
 * Solo mira los reclamos y la cifra. No nombra ni un movimiento del dinero: quien los escribe es
 * `orders.ts` al marcar pagado, y si esta funcion pudiera nombrarlos podria recalcularlos.
 */
export function planCreditorSettlement(input: CreditorSettlementInput): CreditorSettlementResult {
  const { claims, pendingCashbackCop } = input;
  const vinculo = vacio(claims.communityId) ? "" : (claims.communityId as string);

  if (vinculo === "") {
    return { extinguish: false, claimsPatch: null, reason: "Esa cuenta no esta vinculada a ninguna comunidad." };
  }

  /**
   * A un LIDER no se le extingue nada, le deban lo que le deban: liderar no depende de que se le
   * deba. Si esto mirara solo la cifra, cada cierre de caja le quitaria la comunidad al lider que
   * la gobierna. Y la AUSENCIA de `communityStanding` significa lider (ver `posicion`), que es el
   * estado de todos los reclamos vivos: leerla como acreedor tendria justo ese efecto.
   */
  if (posicion(claims.communityStanding) !== "creditor") {
    return {
      extinguish: false,
      claimsPatch: null,
      reason: `Esa cuenta lidera la comunidad ${vinculo}: su vinculo no depende de lo que se le deba.`
    };
  }

  if (!estaSaldado(pendingCashbackCop)) {
    return {
      extinguish: false,
      claimsPatch: null,
      reason: `Esa cuenta sigue siendo acreedora de la comunidad ${vinculo}: todavia queda algo a su favor.`
    };
  }

  return {
    extinguish: true,
    claimsPatch: { communityId: UNSET_FIELD, communityStanding: UNSET_FIELD },
    reason: `Ya no queda nada a favor de esa cuenta en la comunidad ${vinculo}: su vinculo de acreedora se apaga.`
  };
}
