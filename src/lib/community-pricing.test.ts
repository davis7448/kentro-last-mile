import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyScheduledChanges,
  communityChargeAtClose,
  freezeOrderPricing,
  resolveCommunityPricing,
  scheduleEffectiveAt,
  SCHEDULED_RAISE_NOTICE_DAYS,
  type FrozenPricing,
  type PricingValues
} from "../../functions/src/community-pricing";
import type { Community, CommunityPricingFields, ScheduledPriceChange } from "./types";
import { buildStoreTariffView as vistaTarifaDeTienda } from "../../functions/src/community-pricing";

const BASE = { sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000 };
const T0 = "2026-09-01T00:00:00.000Z";
const day = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.parse(T0) + days * day).toISOString();

/**
 * Una comunidad tal como la ve `resolveCommunityPricing` DESPUES de la spec 003: el documento
 * entero, con el `leaderUid` que la concesion escribe (`community-grant.ts`) y la revocacion
 * borra. El campo es opcional en el tipo porque en el documento es opcional de verdad: hay
 * comunidades creadas antes de que existiera, y son exactamente las que no deben cobrar de mas.
 */
type ComunidadConLider = Community & { leaderUid?: string };

const UID_LIDER = "uid-lider-ana";

/**
 * La comunidad SANA: activa y CON lider, el unico estado en el que el precio propio se cobra.
 * Es el punto de partida de T3, T4, T5, T39 y T47, que hablan de precios, pisos y programadas
 * dando por hecho que hay quien los cobre. Si aqui falta el `leaderUid`, toda comunidad del
 * archivo nace huerfana y esas cinco tandas piden sobreprecio a una comunidad que, por RF_20,
 * debe cobrar la base: el archivo se contradice solo. Para el caso huerfano esta `sinLider`.
 */
function community(pricing: CommunityPricingFields = {}, extra: Partial<Community> = {}): ComunidadConLider {
  return {
    id: "com-1", name: "Comunidad", slug: "comunidad",
    leaderName: "Ana", leaderEmail: "ana@x.co", leaderPhone: "3000000000",
    linkStatus: "active", status: "active", pricing, leaderUid: UID_LIDER,
    createdAt: T0, updatedAt: T0, ...extra
  };
}

describe("T3 · precio vigente y piso", () => {
  it("RF_20: sin precio propio se cobra la base y el cashback es cero", () => {
    const p = resolveCommunityPricing(BASE, community(), T0);
    expect(p.sellerDeliveredFeeCop).toBe(12000);
    expect(communityChargeAtClose(freezeOrderPricing(BASE, community(), T0)!, BASE).cashback.totalCop).toBe(0);
  });

  it("RF_17, RF_18: con precio propio por encima, se cobra el del lider", () => {
    const p = resolveCommunityPricing(BASE, community({ sellerDeliveredFeeCop: 15000 }), T0);
    expect(p.sellerDeliveredFeeCop).toBe(15000);
  });

  it("RF_35: si la base supera el precio del lider, manda la base", () => {
    const p = resolveCommunityPricing({ ...BASE, sellerDeliveredFeeCop: 14000 }, community({ sellerDeliveredFeeCop: 13000 }), T0);
    expect(p.sellerDeliveredFeeCop).toBe(14000);
  });

  it("RF_36: el cashback nunca es negativo, suba antes la base o el precio", () => {
    const baseAlta = { ...BASE, sellerDeliveredFeeCop: 20000 };
    const subeBase = freezeOrderPricing(baseAlta, community({ sellerDeliveredFeeCop: 13000 }), T0)!;
    const subePrecio = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 13000 }), T0)!;
    // Cada pedido se cierra con la base con la que se congelo: la intencion de siempre.
    expect(communityChargeAtClose(subeBase, baseAlta).cashback.totalCop).toBe(0);
    expect(communityChargeAtClose(subePrecio, BASE).cashback.totalCop).toBe(1000);
    expect(communityChargeAtClose(subeBase, baseAlta).cashback.totalCop).toBeGreaterThanOrEqual(0);
  });

  it("RF_19: el minimo que se le puede exigir a un lider es la base", () => {
    const p = resolveCommunityPricing(BASE, community({ fulfillmentFeeCop: 1 }), T0);
    expect(p.fulfillmentFeeCop).toBe(2000);
  });
});

describe("T4 · cambios programados", () => {
  const conSubida = community({ sellerDeliveredFeeCop: 13000 }, {
    scheduled: {
      sellerDeliveredFeeCop: {
        field: "sellerDeliveredFeeCop", fromCop: 13000, toCop: 16000,
        effectiveAt: at(8), scheduledBy: "uid-lider", scheduledAt: T0
      }
    }
  });

  it("RF_28: una subida espera ocho dias antes de aplicarse", () => {
    expect(SCHEDULED_RAISE_NOTICE_DAYS).toBe(8);
    expect(scheduleEffectiveAt(13000, 16000, T0)).toBe(at(8));
    expect(applyScheduledChanges(conSubida, at(7)).sellerDeliveredFeeCop).toBe(13000);
    expect(applyScheduledChanges(conSubida, at(8)).sellerDeliveredFeeCop).toBe(16000);
    expect(applyScheduledChanges(conSubida, at(9)).sellerDeliveredFeeCop).toBe(16000);
  });

  it("RF_38: una bajada entra de inmediato", () => {
    expect(scheduleEffectiveAt(16000, 13000, T0)).toBe(T0);
  });

  it("RF_54: solo hay una programada por concepto y la segunda reinicia el plazo", () => {
    const segunda = scheduleEffectiveAt(13000, 18000, at(3));
    expect(segunda).toBe(at(11));
  });

  it("RF_40: el precio programado se ve antes de entrar, sin afectar al vigente", () => {
    expect(conSubida.scheduled?.sellerDeliveredFeeCop?.toCop).toBe(16000);
    expect(resolveCommunityPricing(BASE, conSubida, at(7)).sellerDeliveredFeeCop).toBe(13000);
  });
});

describe("T5 · congelado del precio en el pedido", () => {
  it("RF_21: guarda final y base de los tres conceptos", () => {
    const frozen = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 15000 }), T0)!;
    expect(frozen.communityId).toBe("com-1");
    expect(frozen.sellerDeliveredFeeCop).toBe(15000);
    expect(frozen.baseDeliveredFeeCop).toBe(12000);
    expect(frozen.frozenAt).toBe(T0);
  });

  it("RF_37: sin comunidad no se congela nada", () => {
    expect(freezeOrderPricing(BASE, undefined, T0)).toBeUndefined();
  });

  it("RF_21: el cashback se reparte por concepto", () => {
    const frozen = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 15000, fulfillmentFeeCop: 2500 }), T0)!;
    const { cashback } = communityChargeAtClose(frozen, BASE);
    expect(cashback.deliveredCop).toBe(3000);
    expect(cashback.fulfillmentCop).toBe(500);
    expect(cashback.failedCop).toBe(0);
    expect(cashback.totalCop).toBe(3500);
  });
});

/**
 * T39 · Lo que la tienda VE de su tarifa (RNF_04, RF_28, RF_40).
 *
 * T3, T4 y T5 prueban cuanto se COBRA. Ninguno prueba que la tienda pueda ENTERARSE, y ese es
 * un requisito aparte: "ninguna tienda MUST descubrir su tarifa solo al recibir el cobro"
 * (RNF_04). Hoy la respuesta que contesta esa pregunta se arma inline dentro de
 * `getMyStoreTariff` (functions/src/communities.ts, ~507-542), entre dos lecturas de Firestore,
 * asi que no hay forma de afirmar nada sobre ella sin una sesion real contra produccion.
 *
 * Este bloque exige sacar ese armado a una funcion pura, `buildStoreTariffView`, y que la
 * callable pase a llamarla. Lo que se ata aqui:
 *
 *  - RNF_04: la vista se puede pedir en CUALQUIER instante y trae los tres conceptos que la
 *    tienda paga —entrega, fallido y manejo— tanto si hay comunidad como si no. La forma es la
 *    misma en los dos casos: hoy no lo es (sin comunidad se devuelve `resolveTariffs` entero,
 *    que ademas incluye lo que se le paga al mensajero), y una tienda que recibe dos formas
 *    distintas segun un dato que no controla no tiene tarifa consultable.
 *  - RF_28: la subida se anuncia DESDE QUE SE PROGRAMA, no cuando entra, y con su fecha exacta.
 *    Ocho dias de antelacion sin aviso hasta el octavo dia no son ocho dias de antelacion.
 *  - RF_40: la programada se puede cancelar y se puede rebajar ANTES de la fecha; despues no,
 *    porque una vez vencida ya es el precio vigente y borrarla lo bajaria en silencio.
 *
 * La elevacion al piso de RF_35 es la unica subida exenta del plazo, y por eso NO se anuncia
 * como programada: cuando la tienda pregunta, ya la esta pagando.
 */

type StoreTariffPrices = {
  sellerDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  fulfillmentFeeCop: number;
};

/**
 * Lo que se le cuenta a la tienda de una subida pendiente: que concepto, de cuanto a cuanto y
 * desde cuando. `fromCop` es lo que paga HOY, no el valor que se guardo al programar: si la
 * base se movio entretanto, ese valor guardado esta rancio y anunciarlo seria decirle a la
 * tienda un precio que no es el suyo. `scheduledBy` no entra: el uid del lider no es asunto de
 * la tienda y RNF_04 habla del precio, no de quien lo puso.
 */
type StoreTariffRaiseNotice = {
  field: keyof StoreTariffPrices;
  fromCop: number;
  toCop: number;
  effectiveAt: string;
};

type StoreTariffView = {
  communityId: string | null;
  communityName: string | null;
  current: StoreTariffPrices;
  /** Solo lo que aun NO ha entrado en vigor. `null` si no hay nada pendiente. */
  scheduled: Partial<Record<keyof StoreTariffPrices, StoreTariffRaiseNotice>> | null;
};

type BuildStoreTariffView = (
  base: Record<string, number>,
  community: Community | undefined,
  nowIso: string
) => StoreTariffView;

type ScheduledRaiseCancellation =
  | { ok: true; field: keyof StoreTariffPrices; fromCop: number; toCop: number; effectiveAt: string }
  | { ok: false; reason: string };

type PlanScheduledRaiseCancellation = (
  community: Community,
  field: keyof StoreTariffPrices,
  nowIso: string
) => ScheduledRaiseCancellation;

let buildStoreTariffView: BuildStoreTariffView;
let planScheduledRaiseCancellation: PlanScheduledRaiseCancellation;

/**
 * La base que devuelve `resolveTariffs`: los tres conceptos de la tienda MAS lo que cobra el
 * mensajero. Se usa entera a proposito, porque es exactamente lo que la callable tiene en la
 * mano cuando arma la respuesta.
 */
const BASE_COMPLETA: Record<string, number> = {
  ...BASE,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 4000
};

const CONCEPTOS = ["fulfillmentFeeCop", "sellerDeliveredFeeCop", "sellerFailedFeeCop"];

/** 13.000 vigentes y una subida a 16.000 programada en T0, que entra a los ocho dias. */
const SUBIDA_PROGRAMADA = community(
  { sellerDeliveredFeeCop: 13000 },
  {
    scheduled: {
      sellerDeliveredFeeCop: {
        field: "sellerDeliveredFeeCop",
        fromCop: 13000,
        toCop: 16000,
        effectiveAt: at(8),
        scheduledBy: "uid-lider",
        scheduledAt: T0
      }
    }
  }
);

/** El mismo documento despues de cancelar: la programada desaparece, el precio propio no. */
const TRAS_CANCELAR = community({ sellerDeliveredFeeCop: 13000 });

describe("T39 · la tarifa que la tienda puede consultar", () => {
  // Dentro del describe y con `beforeEach`: un gancho de raiz que falle pinta en rojo los doce
  // casos de T3, T4 y T5, que no tienen nada que ver con esto. Y `beforeEach` en vez de
  // `beforeAll` para que, mientras el modulo no exporte nada, cada caso salga FALLIDO y no
  // omitido: un caso omitido no se distingue de un caso que nadie escribio.
  beforeEach(async () => {
    const modulo = (await import("../../functions/src/community-pricing")) as unknown as {
      buildStoreTariffView?: BuildStoreTariffView;
      planScheduledRaiseCancellation?: PlanScheduledRaiseCancellation;
    };
    if (!modulo.buildStoreTariffView) {
      throw new Error("functions/src/community-pricing.ts todavia no exporta buildStoreTariffView (T39).");
    }
    if (!modulo.planScheduledRaiseCancellation) {
      throw new Error("functions/src/community-pricing.ts todavia no exporta planScheduledRaiseCancellation (T39).");
    }
    buildStoreTariffView = modulo.buildStoreTariffView;
    planScheduledRaiseCancellation = modulo.planScheduledRaiseCancellation;
  });

  it("RNF_04: una tienda sin comunidad consulta su tarifa y recibe la base, por concepto", () => {
    const vista = buildStoreTariffView(BASE_COMPLETA, undefined, at(3));
    expect(vista.communityId).toBeNull();
    expect(vista.communityName).toBeNull();
    expect(vista.scheduled).toBeNull();
    // `toEqual` exacto y no campo a campo: la vista de la tienda son SUS tres conceptos. Hoy esta
    // rama devuelve `resolveTariffs` entera, con `driverDeliveredPayCop` dentro; lo que se le paga
    // al mensajero no es la tarifa de nadie y no tiene por que viajar hasta el navegador de la tienda.
    expect(vista.current).toEqual({
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 12000,
      fulfillmentFeeCop: 2000
    });
  });

  it("RNF_04: con comunidad o sin ella la respuesta tiene la misma forma y los mismos tres conceptos", () => {
    const sin = buildStoreTariffView(BASE_COMPLETA, undefined, at(3));
    const con = buildStoreTariffView(BASE_COMPLETA, community({ sellerDeliveredFeeCop: 15000 }), at(3));
    expect(Object.keys(sin.current).sort()).toEqual(CONCEPTOS);
    expect(Object.keys(con.current).sort()).toEqual(CONCEPTOS);
    expect(Object.keys(sin).sort()).toEqual(Object.keys(con).sort());
    expect(con.communityId).toBe("com-1");
    expect(con.communityName).toBe("Comunidad");
  });

  it("RNF_04: la tarifa vigente se consulta en cualquier instante y siempre es la que se cobra", () => {
    const propia = community({ sellerDeliveredFeeCop: 15000, sellerFailedFeeCop: 13000, fulfillmentFeeCop: 2500 });
    for (const cuando of [T0, at(1), at(9), at(400)]) {
      const vista = buildStoreTariffView(BASE_COMPLETA, propia, cuando);
      expect(vista.scheduled).toBeNull();
      // Atado a `resolveCommunityPricing` y no a numeros sueltos: la vista NO puede ser una
      // segunda formula del precio. Lo que se muestra y lo que se congela en el pedido salen
      // del mismo sitio o acabaran diciendo cosas distintas.
      expect(vista.current).toEqual(resolveCommunityPricing(BASE, propia, cuando));
    }
  });

  it("RF_28: la subida se anuncia DE INMEDIATO, con su fecha exacta, no al llegar el octavo dia", () => {
    // El dia siguiente de programarla ya la muestra. Este es el "de inmediato" del requisito:
    // ocho dias de antelacion solo existen si la tienda se entera el primer dia.
    for (const cuando of [T0, at(1), at(4), at(7)]) {
      const vista = buildStoreTariffView(BASE_COMPLETA, SUBIDA_PROGRAMADA, cuando);
      expect(vista.scheduled).not.toBeNull();
      expect(vista.scheduled?.sellerDeliveredFeeCop).toEqual({
        field: "sellerDeliveredFeeCop",
        fromCop: 13000,
        toCop: 16000,
        effectiveAt: at(8)
      });
    }
  });

  it("RF_28: mientras se anuncia, lo que se cobra sigue siendo el precio viejo", () => {
    expect(buildStoreTariffView(BASE_COMPLETA, SUBIDA_PROGRAMADA, at(7)).current.sellerDeliveredFeeCop).toBe(13000);
    // Y el anuncio no sobrevive a su propia fecha: a partir de ella el valor esta en `current`,
    // no en `scheduled`. Anunciar una subida ya aplicada le dice a la tienda que va a pagar algo
    // que ya esta pagando.
    const alEntrar = buildStoreTariffView(BASE_COMPLETA, SUBIDA_PROGRAMADA, at(8));
    expect(alEntrar.current.sellerDeliveredFeeCop).toBe(16000);
    expect(alEntrar.scheduled).toBeNull();
    expect(buildStoreTariffView(BASE_COMPLETA, SUBIDA_PROGRAMADA, at(9)).scheduled).toBeNull();
  });

  it("RF_28: el anuncio dice de cuanto a cuanto contando desde lo que la tienda paga HOY", () => {
    // La base subio a 14.000 despues de programar la subida: el `fromCop` guardado (13.000) esta
    // rancio y la tienda ya paga 14.000 por el piso de RF_35. El anuncio tiene que partir de ahi.
    const vista = buildStoreTariffView({ ...BASE_COMPLETA, sellerDeliveredFeeCop: 14000 }, SUBIDA_PROGRAMADA, at(3));
    expect(vista.current.sellerDeliveredFeeCop).toBe(14000);
    expect(vista.scheduled?.sellerDeliveredFeeCop?.fromCop).toBe(14000);
    expect(vista.scheduled?.sellerDeliveredFeeCop?.toCop).toBe(16000);
  });

  it("RF_28: cada concepto anuncia su propia subida y su propia fecha", () => {
    const dos = community(
      { sellerDeliveredFeeCop: 13000, fulfillmentFeeCop: 2500 },
      {
        scheduled: {
          sellerDeliveredFeeCop: {
            field: "sellerDeliveredFeeCop", fromCop: 13000, toCop: 16000,
            effectiveAt: at(8), scheduledBy: "uid-lider", scheduledAt: T0
          },
          fulfillmentFeeCop: {
            field: "fulfillmentFeeCop", fromCop: 2500, toCop: 3000,
            effectiveAt: at(11), scheduledBy: "uid-lider", scheduledAt: at(3)
          }
        }
      }
    );
    const vista = buildStoreTariffView(BASE_COMPLETA, dos, at(4));
    expect(vista.scheduled?.sellerDeliveredFeeCop?.effectiveAt).toBe(at(8));
    expect(vista.scheduled?.fulfillmentFeeCop?.effectiveAt).toBe(at(11));
    // A los nueve dias la de entrega ya entro y solo queda anunciada la de manejo.
    const despues = buildStoreTariffView(BASE_COMPLETA, dos, at(9));
    expect(despues.current.sellerDeliveredFeeCop).toBe(16000);
    expect(Object.keys(despues.scheduled ?? {})).toEqual(["fulfillmentFeeCop"]);
  });

  it("RF_40: el lider cancela una subida antes de la fecha y desaparece del anuncio sin mover el precio", () => {
    const plan = planScheduledRaiseCancellation(SUBIDA_PROGRAMADA, "sellerDeliveredFeeCop", at(7));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan).toEqual({
      ok: true,
      field: "sellerDeliveredFeeCop",
      fromCop: 13000,
      toCop: 16000,
      effectiveAt: at(8)
    });
    // Cancelada: ni se anuncia ni entra nunca, y el precio vigente es el de siempre.
    const vista = buildStoreTariffView(BASE_COMPLETA, TRAS_CANCELAR, at(20));
    expect(vista.scheduled).toBeNull();
    expect(vista.current.sellerDeliveredFeeCop).toBe(13000);
  });

  it("RF_40: pasada la fecha ya no se cancela, porque borrarla bajaria el precio en silencio", () => {
    // `cancelScheduledCommunityPrice` borra hoy sin mirar el reloj. El precio programado NO se
    // escribe en `pricing`: se aplica al leer. Asi que borrar una programada ya vencida devuelve
    // la tarifa de 16.000 a 13.000 sin aviso, sin historial y sin que nadie lo pida — justo lo
    // contrario del MAY "antes de la fecha" de RF_40.
    expect(buildStoreTariffView(BASE_COMPLETA, SUBIDA_PROGRAMADA, at(9)).current.sellerDeliveredFeeCop).toBe(16000);
    expect(buildStoreTariffView(BASE_COMPLETA, TRAS_CANCELAR, at(9)).current.sellerDeliveredFeeCop).toBe(13000);

    const plan = planScheduledRaiseCancellation(SUBIDA_PROGRAMADA, "sellerDeliveredFeeCop", at(8));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/vigor|aplicad|tarde/i);
    expect(planScheduledRaiseCancellation(SUBIDA_PROGRAMADA, "sellerDeliveredFeeCop", at(30)).ok).toBe(false);
  });

  it("RF_40: cancelar un concepto que no tiene nada programado se rechaza, no se inventa un cambio", () => {
    expect(planScheduledRaiseCancellation(SUBIDA_PROGRAMADA, "fulfillmentFeeCop", at(3)).ok).toBe(false);
    expect(planScheduledRaiseCancellation(TRAS_CANCELAR, "sellerDeliveredFeeCop", at(3)).ok).toBe(false);
  });

  it("RF_40: rebajar la subida programada la REEMPLAZA por otra programada y reinicia los ocho dias (RF_54), no hereda la fecha vieja", () => {
    // La lectura elegida, y por que. "Rebajar" 16.000 a 14.000 sigue siendo SUBIR respecto a lo
    // que la tienda paga hoy (13.000), asi que `scheduleEffectiveAt` compara contra el vigente y
    // no contra la programada: es una subida nueva y RF_54 manda —una sola por concepto, la
    // segunda reemplaza a la primera y REINICIA el plazo desde que se programa—. Heredar la fecha
    // del 16.000 dejaria entrar un precio con menos de ocho dias de aviso, que es exactamente lo
    // que RF_28 prohibe. Que sea menor que la anterior no lo convierte en una bajada.
    expect(scheduleEffectiveAt(13000, 14000, at(3))).toBe(at(11));

    const rebajada = community(
      { sellerDeliveredFeeCop: 13000 },
      {
        scheduled: {
          sellerDeliveredFeeCop: {
            field: "sellerDeliveredFeeCop", fromCop: 13000, toCop: 14000,
            effectiveAt: at(11), scheduledBy: "uid-lider", scheduledAt: at(3)
          }
        }
      }
    );
    const vista = buildStoreTariffView(BASE_COMPLETA, rebajada, at(4));
    expect(vista.scheduled?.sellerDeliveredFeeCop).toEqual({
      field: "sellerDeliveredFeeCop",
      fromCop: 13000,
      toCop: 14000,
      effectiveAt: at(11)
    });
    // El octavo dia, la fecha de la subida vieja, ya no pasa nada: aquella se reemplazo.
    expect(buildStoreTariffView(BASE_COMPLETA, rebajada, at(8)).current.sellerDeliveredFeeCop).toBe(13000);
    expect(buildStoreTariffView(BASE_COMPLETA, rebajada, at(11)).current.sellerDeliveredFeeCop).toBe(14000);
  });

  it("RF_40: rebajar por debajo del precio vigente si es una bajada, entra ya (RF_38) y cancela la programada", () => {
    // La otra mitad de la misma decision: 12.500 esta por DEBAJO de los 13.000 que se cobran, asi
    // que es una bajada, entra en el acto y no puede quedar una subida pendiente detras que la
    // deshaga sola a los ocho dias.
    expect(scheduleEffectiveAt(13000, 12500, at(3))).toBe(at(3));
    const bajada = community({ sellerDeliveredFeeCop: 12500 });
    const vista = buildStoreTariffView(BASE_COMPLETA, bajada, at(3));
    expect(vista.current.sellerDeliveredFeeCop).toBe(12500);
    expect(vista.scheduled).toBeNull();
    expect(buildStoreTariffView(BASE_COMPLETA, bajada, at(30)).current.sellerDeliveredFeeCop).toBe(12500);
  });

  it("RF_40: la elevacion al piso de RF_35 no se anuncia como programada, porque ya esta aplicada", () => {
    const baseAlta = { ...BASE_COMPLETA, sellerDeliveredFeeCop: 15000 };
    // Antes de que el disparador materialice nada: el piso ya manda al leer.
    const sinMaterializar = buildStoreTariffView(baseAlta, community({ sellerDeliveredFeeCop: 13000 }), at(3));
    expect(sinMaterializar.current.sellerDeliveredFeeCop).toBe(15000);
    expect(sinMaterializar.scheduled).toBeNull();
    // Y despues de que `raiseCommunityPricesToFloor` escriba el precio elevado: mismo resultado.
    const materializada = community({ sellerDeliveredFeeCop: 15000 });
    const vista = buildStoreTariffView(baseAlta, materializada, at(3));
    expect(vista.current.sellerDeliveredFeeCop).toBe(15000);
    expect(vista.scheduled).toBeNull();
  });

  it("RF_40: una programada que el piso ya rebaso no se anuncia: anunciarla prometeria un precio que no es", () => {
    // Se programo subir a 14.000 y entretanto la base subio a 15.000. La tienda ya paga 15.000
    // por RF_35. Anunciar "subiras a 14.000" seria anunciarle una BAJADA que no va a ocurrir.
    const vista = buildStoreTariffView(
      { ...BASE_COMPLETA, sellerDeliveredFeeCop: 15000 },
      community(
        { sellerDeliveredFeeCop: 13000 },
        {
          scheduled: {
            sellerDeliveredFeeCop: {
              field: "sellerDeliveredFeeCop", fromCop: 13000, toCop: 14000,
              effectiveAt: at(8), scheduledBy: "uid-lider", scheduledAt: T0
            }
          }
        }
      ),
      at(3)
    );
    expect(vista.current.sellerDeliveredFeeCop).toBe(15000);
    expect(vista.scheduled).toBeNull();
  });
});

/**
 * T47 · Quien eleva los precios al piso, y cuando (RF_35, RF_39, RF_40).
 *
 * T3 ya prueba que el piso manda AL LEER: `resolveCommunityPricing` nunca devuelve menos que la
 * base, asi que ninguna tienda paga por debajo del costo de Kentro. Lo que no prueba nadie es
 * que el precio del lider se eleve DE VERDAD en su documento, que quede rastro de ello y que se
 * le avise — y eso es literalmente lo que pide RF_35: "MUST elevar automaticamente el precio de
 * ese lider hasta la nueva base [...] y MUST notificarselo".
 *
 * Hoy eso no ocurre. `raiseCommunityPricesToFloor` (functions/src/communities.ts:292) esta
 * escrita y desplegada y **no la llama nadie**, y la tarifa base ni siquiera pasa por un
 * callable: la escribe el navegador directo a `settings/app` (state-store.ts:293). El plan §4.7
 * cierra el hueco con un trigger `onDocumentUpdated` sobre `settings/app`, que se dispara
 * escriba quien escriba y no se puede saltar desde el cliente.
 *
 * Este bloque ata el NUCLEO PURO de ese trigger, `planFloorRaise`: que comunidades suben, que
 * conceptos y con que historial. Puro y con el instante por parametro, como todo lo de este
 * archivo, para que la decision se pueda probar sin Firestore y para que la previsualizacion no
 * pueda divergir de lo que se escribe (mismo criterio que `order-corrections-plan.ts`).
 *
 * Lo que se decide aqui y no estaba escrito en ningun sitio:
 *
 *  - El plan recibe el documento de ajustes ENTERO, antes y despues, y es el quien mira si
 *    alguna tarifa subio. `settings/app` tiene muchisimos campos que no son tarifas, y el
 *    trigger salta con todos ellos; el filtro es parte de la decision, no del cableado.
 *  - Lo que se compara con el piso nuevo es el precio VIGENTE del lider —el de `pricing` con
 *    las programadas ya vencidas aplicadas—, no el literal de `pricing`. Si no, una programada
 *    vencida en 14.000 se quedaria intacta bajo un piso de 15.000 y el historial mentiria en el
 *    `fromCop`, igual que ya se decidio para el anuncio a la tienda en T39.
 *  - Las escrituras viajan como rutas con punto (`pricing.<concepto>`) y los borrados en una
 *    lista aparte, porque `FieldValue.delete()` es de firebase-admin y aqui no puede entrar: el
 *    trigger traduce, no decide.
 */

type PricingField = keyof CommunityPricingFields;

/** RF_39: el rastro de un cambio de precio. Mismos campos que `buildPriceHistoryEntry`. */
type FloorPriceHistoryEntry = {
  field: PricingField;
  fromCop: number;
  toCop: number;
  /** Desde cuando aplica. En una elevacion al piso es AHORA: RF_40 la exime de los ocho dias. */
  effectiveAt: string;
  actorUid: string;
  actorRole: string;
  createdAt: string;
};

/** Todo lo que hay que escribir en UNA comunidad. Vacio = esa comunidad no aparece en el plan. */
type CommunityFloorRaise = {
  communityId: string;
  /** Conceptos elevados. En el orden de `COMMUNITY_PRICING_FIELDS`. */
  fields: PricingField[];
  /** Rutas con punto listas para `doc.update()`: `pricing.X`, `floorRaisedAt.X`, `updatedAt`. */
  communityUpdate: Record<string, string | number>;
  /** Rutas a borrar (`scheduled.X`). El trigger las convierte en `FieldValue.delete()`. */
  deleteFields: string[];
  /** Una por concepto elevado. Subcoleccion `priceHistory`. */
  historyEntries: FloorPriceHistoryEntry[];
};

type FloorRaisePlan = {
  /** Conceptos cuya base SUBIO. Vacio => no se escribe absolutamente nada. */
  raisedFields: PricingField[];
  communities: CommunityFloorRaise[];
};

type PlanFloorRaise = (input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  communities: Community[];
  nowIso: string;
}) => FloorRaisePlan;

let planFloorRaise: PlanFloorRaise;

/** Quien firma la elevacion. No es un humano y el historial no puede fingir que lo sea. */
const AUTOR_PISO = "system:floor";

/** `settings/app` tal como esta hoy: las tarifas y un monton de cosas que no lo son. */
const AJUSTES_ANTES: Record<string, unknown> = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 9000,
  driverFailedPayCop: 4000,
  whatsappToken: "token-viejo",
  pickupPoints: ["Centro", "Sur"]
};

const ajustesCon = (cambios: Record<string, unknown>): Record<string, unknown> => ({
  ...AJUSTES_ANTES,
  ...cambios
});

const programada = (
  field: PricingField,
  fromCop: number,
  toCop: number,
  effectiveAt: string
): Partial<Record<PricingField, ScheduledPriceChange>> => ({
  [field]: { field, fromCop, toCop, effectiveAt, scheduledBy: "uid-lider", scheduledAt: T0 }
});

const cambioDe = (plan: FloorRaisePlan, communityId: string): CommunityFloorRaise | undefined =>
  plan.communities.find((c) => c.communityId === communityId);

/**
 * Aplica el plan a un documento de comunidad, como haria el trigger. Existe para poder correr el
 * plan DOS VECES sobre el resultado del primero, que es la unica forma honesta de comprobar la
 * idempotencia: un reintento de Firestore repite el mismo evento con el mismo `before`/`after`.
 */
function aplicar(base: Community, cambio: CommunityFloorRaise | undefined): Community {
  if (!cambio) return base;
  const pricing: CommunityPricingFields = { ...base.pricing };
  for (const [ruta, valor] of Object.entries(cambio.communityUpdate)) {
    if (!ruta.startsWith("pricing.") || typeof valor !== "number") continue;
    pricing[ruta.slice("pricing.".length) as PricingField] = valor;
  }
  const scheduled: Partial<Record<PricingField, ScheduledPriceChange>> = { ...(base.scheduled ?? {}) };
  for (const ruta of cambio.deleteFields) {
    if (!ruta.startsWith("scheduled.")) continue;
    delete scheduled[ruta.slice("scheduled.".length) as PricingField];
  }
  return {
    ...base,
    pricing,
    scheduled: Object.keys(scheduled).length > 0 ? scheduled : undefined
  };
}

describe("T47 · elevacion automatica al piso", () => {
  // Mismo gancho que T39 y por el mismo motivo: que un modulo sin la funcion pinte estos casos
  // en ROJO y no en omitido, y sin arrastrar consigo los veintiseis anteriores.
  beforeEach(async () => {
    const modulo = (await import("../../functions/src/community-pricing")) as unknown as {
      planFloorRaise?: PlanFloorRaise;
    };
    if (!modulo.planFloorRaise) {
      throw new Error("functions/src/community-pricing.ts todavia no exporta planFloorRaise (T47).");
    }
    planFloorRaise = modulo.planFloorRaise;
  });

  it("RF_35: la base sube por encima del precio del lider y ese concepto se eleva al piso exacto", () => {
    const antes = community({ sellerDeliveredFeeCop: 13000 });
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      communities: [antes],
      nowIso: at(3)
    });

    expect(plan.raisedFields).toEqual(["sellerDeliveredFeeCop"]);
    expect(plan.communities).toHaveLength(1);
    const cambio = plan.communities[0];
    expect(cambio.communityId).toBe("com-1");
    expect(cambio.fields).toEqual(["sellerDeliveredFeeCop"]);
    // Exacto y nada mas: al piso, ni un peso por encima —eso seria subirle el precio a las
    // tiendas sin que nadie lo pidiera— y sin rozar los otros dos conceptos, cuya base no se
    // movio. Por eso `toEqual` del update entero y no una comprobacion clave a clave.
    expect(cambio.communityUpdate).toEqual({
      "pricing.sellerDeliveredFeeCop": 15000,
      "floorRaisedAt.sellerDeliveredFeeCop": at(3),
      updatedAt: at(3)
    });
    expect(cambio.deleteFields).toEqual([]);

    // Y el efecto de dinero que RF_35 exige: tras aplicarlo, el cashback de ese concepto es cero
    // (queda en cero "hasta que el lo suba") y la tienda paga exactamente el piso.
    const despues = aplicar(antes, cambio);
    const base = { ...BASE, sellerDeliveredFeeCop: 15000 };
    expect(resolveCommunityPricing(base, despues, at(3)).sellerDeliveredFeeCop).toBe(15000);
    expect(communityChargeAtClose(freezeOrderPricing(base, despues, at(3))!, base).cashback.deliveredCop).toBe(0);
  });

  it("RF_35: una bajada de la base no eleva a nadie y no escribe nada", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 10000, fulfillmentFeeCop: 1500 }),
      communities: [community({ sellerDeliveredFeeCop: 13000, fulfillmentFeeCop: 2500 })],
      nowIso: at(3)
    });
    // Una bajada de base no puede subirle el precio a nadie: ampliaria el cashback del lider, no
    // lo recortaria. El plan tiene que salir por la puerta de atras sin tocar una sola comunidad.
    expect(plan.raisedFields).toEqual([]);
    expect(plan.communities).toEqual([]);
  });

  it("RF_35: un cambio en un campo de ajustes que no es tarifa no escribe nada", () => {
    // `settings/app` guarda decenas de cosas —tokens, puntos de recogida, textos— y el trigger
    // salta con todas. Si el plan no las distingue, cada guardado de ajustes reescribe todas las
    // comunidades y llena el historial de entradas que no corresponden a ningun cambio de precio.
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ whatsappToken: "token-nuevo", pickupPoints: ["Centro", "Sur", "Norte"] }),
      communities: [community({ sellerDeliveredFeeCop: 13000 })],
      nowIso: at(3)
    });
    expect(plan.raisedFields).toEqual([]);
    expect(plan.communities).toEqual([]);
  });

  it("RF_35: una comunidad que ya cobra por encima —o justo en— la base nueva no se toca", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 14000 }),
      communities: [
        community({ sellerDeliveredFeeCop: 16000 }),
        // Justo en el piso: 14.000 no esta POR DEBAJO de 14.000. Elevarlo seria escribir y dejar
        // historial de un cambio que no cambia nada, y romperia la idempotencia del segundo pase.
        community({ sellerDeliveredFeeCop: 14000 }, { id: "com-2" })
      ],
      nowIso: at(3)
    });
    expect(plan.raisedFields).toEqual(["sellerDeliveredFeeCop"]);
    expect(plan.communities).toEqual([]);
  });

  it("RF_35: varias comunidades y varios conceptos a la vez, cada uno con su propio piso", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000, fulfillmentFeeCop: 2500 }),
      communities: [
        community({ sellerDeliveredFeeCop: 13000, fulfillmentFeeCop: 3000 }),
        community({ sellerDeliveredFeeCop: 16000, fulfillmentFeeCop: 2100 }, { id: "com-2" }),
        community(
          { sellerDeliveredFeeCop: 12500, fulfillmentFeeCop: 2000, sellerFailedFeeCop: 11000 },
          { id: "com-3" }
        ),
        community({ sellerDeliveredFeeCop: 20000, fulfillmentFeeCop: 4000 }, { id: "com-4" })
      ],
      nowIso: at(3)
    });

    expect([...plan.raisedFields].sort()).toEqual(["fulfillmentFeeCop", "sellerDeliveredFeeCop"]);
    expect(plan.communities.map((c) => c.communityId).sort()).toEqual(["com-1", "com-2", "com-3"]);

    expect(cambioDe(plan, "com-1")!.fields).toEqual(["sellerDeliveredFeeCop"]);
    expect(cambioDe(plan, "com-1")!.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(15000);
    expect(cambioDe(plan, "com-1")!.communityUpdate["pricing.fulfillmentFeeCop"]).toBeUndefined();

    expect(cambioDe(plan, "com-2")!.fields).toEqual(["fulfillmentFeeCop"]);
    expect(cambioDe(plan, "com-2")!.communityUpdate["pricing.fulfillmentFeeCop"]).toBe(2500);

    const tres = cambioDe(plan, "com-3")!;
    expect([...tres.fields].sort()).toEqual(["fulfillmentFeeCop", "sellerDeliveredFeeCop"]);
    expect(tres.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(15000);
    expect(tres.communityUpdate["pricing.fulfillmentFeeCop"]).toBe(2500);
    // 11.000 esta por debajo de la base de fallido (12.000), pero esa base NO subio en este
    // guardado. Elevarlo aqui seria arreglar de tapadillo un estado que ningun cambio provoco,
    // y el aviso al lider hablaria de una subida de base que nunca ocurrio.
    expect(tres.communityUpdate["pricing.sellerFailedFeeCop"]).toBeUndefined();
    expect(tres.historyEntries.map((e) => e.field)).not.toContain("sellerFailedFeeCop");

    expect(cambioDe(plan, "com-4")).toBeUndefined();
  });

  it("RF_39: cada elevacion deja historial con quien, cuando, de cuanto a cuanto y desde cuando", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000, fulfillmentFeeCop: 2500 }),
      communities: [community({ sellerDeliveredFeeCop: 13000, fulfillmentFeeCop: 2100 })],
      nowIso: at(3)
    });

    const cambio = plan.communities[0];
    expect(cambio.historyEntries).toHaveLength(2);
    const entrega = cambio.historyEntries.find((e) => e.field === "sellerDeliveredFeeCop")!;
    expect(entrega).toEqual({
      field: "sellerDeliveredFeeCop",
      fromCop: 13000,
      toCop: 15000,
      effectiveAt: at(3),
      actorUid: AUTOR_PISO,
      actorRole: "system",
      createdAt: at(3)
    });
    // El otro concepto lleva SU propio par de cifras: una sola entrada resumiendo dos conceptos
    // dejaria el historial sin poder responder "cuanto valia el manejo antes de esto".
    const manejo = cambio.historyEntries.find((e) => e.field === "fulfillmentFeeCop")!;
    expect(manejo.fromCop).toBe(2100);
    expect(manejo.toCop).toBe(2500);
    expect(manejo.actorUid).toBe(AUTOR_PISO);
  });

  it("RF_40: la elevacion al piso entra de inmediato y NO se programa a ocho dias", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      communities: [community({ sellerDeliveredFeeCop: 13000 })],
      nowIso: at(3)
    });
    const cambio = plan.communities[0];

    // Es la trampa exacta de esta tarea: `buildPriceHistoryEntry` pasa por `scheduleEffectiveAt`,
    // que a toda SUBIDA le pone ocho dias. Reusarlo tal cual dejaria a Kentro cobrando por debajo
    // de su costo durante ocho dias, que es justo lo que RF_40 exime.
    expect(scheduleEffectiveAt(13000, 15000, at(3))).toBe(at(11));
    expect(cambio.historyEntries[0].effectiveAt).toBe(at(3));
    expect(cambio.historyEntries[0].effectiveAt).not.toBe(at(11));

    // Y no se programa: el precio nuevo se escribe en `pricing`, no en `scheduled`.
    expect(cambio.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(15000);
    for (const ruta of Object.keys(cambio.communityUpdate)) {
      expect(ruta.startsWith("scheduled.")).toBe(false);
    }

    // Comprobado por el efecto, no solo por la forma: aplicado el plan, la tienda paga el piso
    // YA, no dentro de ocho dias.
    const despues = aplicar(community({ sellerDeliveredFeeCop: 13000 }), cambio);
    const base = { ...BASE, sellerDeliveredFeeCop: 15000 };
    expect(resolveCommunityPricing(base, despues, at(3)).sellerDeliveredFeeCop).toBe(15000);
    expect(applyScheduledChanges(despues, at(3)).sellerDeliveredFeeCop).toBe(15000);
  });

  it("RF_35: correr el plan sobre lo ya elevado no produce una segunda entrada de historial", () => {
    const original = community({ sellerDeliveredFeeCop: 13000 });
    const entrada = {
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      nowIso: at(3)
    };
    const primero = planFloorRaise({ ...entrada, communities: [original] });
    const yaElevada = aplicar(original, primero.communities[0]);

    // Firestore reintrega el MISMO evento cuando el trigger falla a medias: mismo `before`,
    // mismo `after`, comunidades ya corregidas. El segundo pase tiene que ser mudo, o el
    // historial acumula elevaciones fantasma de 15.000 a 15.000 y el aviso al lider se repite.
    const segundo = planFloorRaise({ ...entrada, communities: [yaElevada] });
    expect(segundo.raisedFields).toEqual(["sellerDeliveredFeeCop"]);
    expect(segundo.communities).toEqual([]);
  });

  it("RF_35: una comunidad sin precios propios no se toca: hereda la base y nunca esta por debajo", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000, fulfillmentFeeCop: 2500 }),
      communities: [community()],
      nowIso: at(3)
    });
    expect(plan.communities).toEqual([]);
    // Y sigue cobrando la base nueva sin que nadie escriba nada (RF_20): es el mismo numero.
    expect(resolveCommunityPricing({ ...BASE, sellerDeliveredFeeCop: 15000 }, community(), at(3)).sellerDeliveredFeeCop).toBe(15000);
  });

  it("RF_40: una subida programada que el piso nuevo ya rebasa se cancela, no se deja dormida", () => {
    // Decision de T47, atada aqui porque no estaba escrita en ninguna parte y es destructiva.
    // T39 ya decidio que una programada por debajo del piso NO se le anuncia a la tienda: seria
    // prometerle un precio que no es. Pero si ademas se deja en el documento, queda una subida
    // que la tienda nunca vio y que puede cobrar vida sola —basta con que la base vuelva a
    // bajar— y aplicarse SIN los ocho dias de aviso que exige RF_28. Una subida invisible que se
    // aplica sola es peor que ninguna: se borra en el mismo movimiento que la deja sin sentido.
    const conProgramadaMuerta = community(
      { sellerDeliveredFeeCop: 13000 },
      { scheduled: programada("sellerDeliveredFeeCop", 13000, 14000, at(8)) }
    );
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      communities: [conProgramadaMuerta],
      nowIso: at(3)
    });

    const cambio = plan.communities[0];
    expect(cambio.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(15000);
    expect(cambio.deleteFields).toEqual(["scheduled.sellerDeliveredFeeCop"]);
    // Aplicado, no queda rastro que pueda revivir a los ocho dias.
    expect(aplicar(conProgramadaMuerta, cambio).scheduled?.sellerDeliveredFeeCop).toBeUndefined();
  });

  it("RF_40: una subida programada POR ENCIMA del piso nuevo sobrevive intacta, con su fecha", () => {
    // La otra mitad de la decision anterior. 18.000 sigue siendo una subida real y anunciada;
    // borrarla seria cancelarle al lider un cambio legitimo sin que lo pidiera, que es
    // exactamente lo que `planScheduledRaiseCancellation` existe para impedir.
    const conProgramadaViva = community(
      { sellerDeliveredFeeCop: 13000 },
      { scheduled: programada("sellerDeliveredFeeCop", 13000, 18000, at(8)) }
    );
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      communities: [conProgramadaViva],
      nowIso: at(3)
    });

    const cambio = plan.communities[0];
    expect(cambio.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(15000);
    expect(cambio.deleteFields).toEqual([]);
    const despues = aplicar(conProgramadaViva, cambio);
    expect(despues.scheduled?.sellerDeliveredFeeCop?.toCop).toBe(18000);
    expect(despues.scheduled?.sellerDeliveredFeeCop?.effectiveAt).toBe(at(8));
    // Y a los ocho dias entra, por encima del piso.
    expect(resolveCommunityPricing({ ...BASE, sellerDeliveredFeeCop: 15000 }, despues, at(9)).sellerDeliveredFeeCop).toBe(18000);
  });

  it("RF_39: el `fromCop` del historial es el precio VIGENTE, no el literal de `pricing`", () => {
    // El lider tenia 13.000 y programo 14.000, que ya vencio: hoy cobra 14.000 aunque `pricing`
    // siga diciendo 13.000, porque una programada nunca se escribe en `pricing` (la aplica
    // `applyScheduledChanges` al leer). Escribir "de 13.000 a 15.000" en el historial seria
    // falso, y ademas dejaria a la comunidad cobrando por debajo del piso en cuanto alguien
    // borrase la programada.
    const conVencida = community(
      { sellerDeliveredFeeCop: 13000 },
      { scheduled: programada("sellerDeliveredFeeCop", 13000, 14000, at(1)) }
    );
    expect(applyScheduledChanges(conVencida, at(3)).sellerDeliveredFeeCop).toBe(14000);

    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      communities: [conVencida],
      nowIso: at(3)
    });
    const cambio = plan.communities[0];
    expect(cambio.historyEntries[0].fromCop).toBe(14000);
    expect(cambio.historyEntries[0].toCop).toBe(15000);
    expect(cambio.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(15000);
    // La vencida ya esta absorbida en `pricing`: dejarla bajaria el precio al releer.
    expect(cambio.deleteFields).toEqual(["scheduled.sellerDeliveredFeeCop"]);
    expect(applyScheduledChanges(aplicar(conVencida, cambio), at(3)).sellerDeliveredFeeCop).toBe(15000);
  });

  it("RF_35: sin comunidades no se escribe nada, aunque la base suba", () => {
    const plan = planFloorRaise({
      before: AJUSTES_ANTES,
      after: ajustesCon({ sellerDeliveredFeeCop: 15000 }),
      communities: [],
      nowIso: at(3)
    });
    expect(plan.raisedFields).toEqual(["sellerDeliveredFeeCop"]);
    expect(plan.communities).toEqual([]);
  });

  it("RF_35: una tarifa que aparece por primera vez en los ajustes cuenta como subida", () => {
    // `settings/app` es un documento que ha ido creciendo: hay instalaciones donde un concepto
    // no existia y se guarda por primera vez. Tratar "ausente -> 2.500" como "no cambio" dejaria
    // a las comunidades por debajo del piso sin que nadie se entere, que es el fallo que esta
    // tarea viene a cerrar.
    const sinManejo: Record<string, unknown> = { ...AJUSTES_ANTES };
    delete sinManejo.fulfillmentFeeCop;
    const plan = planFloorRaise({
      before: sinManejo,
      after: ajustesCon({ fulfillmentFeeCop: 2500 }),
      communities: [community({ fulfillmentFeeCop: 2000 })],
      nowIso: at(3)
    });
    expect(plan.raisedFields).toEqual(["fulfillmentFeeCop"]);
    expect(plan.communities[0].communityUpdate["pricing.fulfillmentFeeCop"]).toBe(2500);
    expect(plan.communities[0].historyEntries[0].fromCop).toBe(2000);
  });
});

/**
 * Comunidad viva y con lider: el unico estado en el que el sobreprecio tiene a quien pagarse.
 * Es ya lo que construye `community`; se conserva el nombre porque en T8 el contraste con
 * `sinLider` es el objeto de la prueba y decirlo en el nombre es lo que la hace legible.
 */
function conLider(pricing: CommunityPricingFields = {}, extra: Partial<Community> = {}): ComunidadConLider {
  return { ...community(pricing, extra), leaderUid: UID_LIDER };
}

/**
 * Comunidad huerfana: el campo AUSENTE, que es como queda tras `planLeaderRevocation`.
 * Se BORRA de verdad, no se deja sin poner: ausente y presente-pero-vacio son dos casos
 * distintos y ambos se prueban por separado aqui abajo.
 */
function sinLider(pricing: CommunityPricingFields = {}, extra: Partial<Community> = {}): ComunidadConLider {
  const huerfana = community(pricing, extra);
  delete huerfana.leaderUid;
  return huerfana;
}

describe("T8 · una comunidad sin lider cobra la base", () => {
  it("RF_20: sin lider se cobra la tarifa base y no se causa cashback", () => {
    // Precio propio por encima de la base en los tres conceptos. Con lider seria 15.000/14.000/3.000.
    const huerfana = sinLider({
      sellerDeliveredFeeCop: 15000,
      sellerFailedFeeCop: 14000,
      fulfillmentFeeCop: 3000
    });

    expect(resolveCommunityPricing(BASE, huerfana, T0)).toEqual(BASE);

    // El cashback no se puede quedar colgado: sin lider no hay a quien abonarselo. Y la unica
    // forma de que no exista es que el precio congelado sea IGUAL a la base, concepto a concepto.
    const congelado = freezeOrderPricing(BASE, huerfana, T0);
    expect(congelado).toBeDefined();
    expect(congelado!.sellerDeliveredFeeCop).toBe(congelado!.baseDeliveredFeeCop);
    expect(congelado!.sellerFailedFeeCop).toBe(congelado!.baseFailedFeeCop);
    expect(congelado!.fulfillmentFeeCop).toBe(congelado!.baseFulfillmentFeeCop);
    expect(communityChargeAtClose(congelado!, BASE).cashback.totalCop).toBe(0);
  });

  it("RF_20: la comprobacion del lider va ANTES del piso y de las programadas", () => {
    // Comunidad huerfana cuyo precio literal esta POR DEBAJO de la base (11.000 < 12.000) pero con
    // una subida programada ya vencida a 18.000. Si la comprobacion del lider se hiciera al final
    // —sobre los valores ya resueltos, o solo sobre `pricing`— los 18.000 de la programada
    // ganarian igual y la tienda seguiria pagando 6.000 de mas por pedido sin que nadie los cobre.
    const huerfana = sinLider(
      { sellerDeliveredFeeCop: 11000 },
      { scheduled: programada("sellerDeliveredFeeCop", 11000, 18000, at(1)) }
    );

    // `applyScheduledChanges` NO cambia: sigue diciendo que quiso cobrar el lider, y de ella
    // dependen el historial y la elevacion al piso (T47). La decision vive en el resolutor.
    expect(applyScheduledChanges(huerfana, at(3)).sellerDeliveredFeeCop).toBe(18000);

    expect(resolveCommunityPricing(BASE, huerfana, at(3)).sellerDeliveredFeeCop).toBe(12000);
    // Y, mas fuerte: una comunidad sin lider tiene que dar EXACTAMENTE lo mismo que no tener
    // comunidad. Si queda un solo camino por el que el precio propio se cuele, esto lo caza.
    expect(resolveCommunityPricing(BASE, huerfana, at(3))).toEqual(
      resolveCommunityPricing(BASE, undefined, at(3))
    );
  });

  it("RF_20: una comunidad desactivada tambien cobra la base, aunque conserve su leaderUid", () => {
    // `planLeaderStatusChange` declara que desactivar no toca NADA mas que el estado: el
    // `leaderUid` y el `pricing` se quedan escritos tal cual. Sin esta comprobacion, desactivar
    // una comunidad la deja cobrando sobreprecio indefinidamente.
    const apagada = conLider({ sellerDeliveredFeeCop: 15000 }, { status: "disabled" });

    expect(resolveCommunityPricing(BASE, apagada, T0)).toEqual(BASE);
    expect(communityChargeAtClose(freezeOrderPricing(BASE, apagada, T0)!, BASE).cashback.totalCop).toBe(0);
  });

  it("RF_20: el enlace de registro revocado NO cambia el precio, porque sigue habiendo lider", () => {
    // `linkStatus: "revoked"` solo cierra la pantalla de alta de tiendas. Confundirlo con quedarse
    // sin lider le quitaria el ingreso a un lider que sigue trabajando.
    const enlaceCerrado = conLider({ sellerDeliveredFeeCop: 15000 }, { linkStatus: "revoked" });

    expect(resolveCommunityPricing(BASE, enlaceCerrado, T0).sellerDeliveredFeeCop).toBe(15000);
    expect(communityChargeAtClose(freezeOrderPricing(BASE, enlaceCerrado, T0)!, BASE).cashback.deliveredCop).toBe(3000);
  });

  it("RF_20: con leaderUid y comunidad activa no cambia nada de lo de hoy", () => {
    // La no regresion: el caso normal, con precio propio y una programada vencida, sigue igual.
    const viva = conLider(
      { sellerDeliveredFeeCop: 15000 },
      { scheduled: programada("fulfillmentFeeCop", 2000, 3000, at(1)) }
    );

    const precio = resolveCommunityPricing(BASE, viva, at(3));
    expect(precio.sellerDeliveredFeeCop).toBe(15000);
    expect(precio.sellerFailedFeeCop).toBe(12000);
    expect(precio.fulfillmentFeeCop).toBe(3000);
    expect(communityChargeAtClose(freezeOrderPricing(BASE, viva, at(3))!, BASE).cashback.totalCop).toBe(4000);
  });

  it("RF_20: un leaderUid en cadena vacia cuenta como sin lider", () => {
    const huerfana: ComunidadConLider = { ...community({ sellerDeliveredFeeCop: 15000 }), leaderUid: "" };

    expect(resolveCommunityPricing(BASE, huerfana, T0)).toEqual(BASE);
    expect(communityChargeAtClose(freezeOrderPricing(BASE, huerfana, T0)!, BASE).cashback.totalCop).toBe(0);
  });

  it("RF_20: un leaderUid en blanco cuenta como sin lider", () => {
    // Mismo criterio que `community-grant.ts` para decidir quien lidera hoy: un uid que al
    // recortarlo no queda nada no es un lider. Dos criterios distintos para "sin lider" es como
    // se llega a cobrar un sobreprecio que el panel del lider no muestra.
    const huerfana: ComunidadConLider = { ...community({ sellerDeliveredFeeCop: 15000 }), leaderUid: "   " };

    expect(resolveCommunityPricing(BASE, huerfana, T0)).toEqual(BASE);
  });

  it("RF_20: una comunidad sin lider no le anuncia a la tienda una subida que nunca llegara", () => {
    // La vista de la tienda sale del mismo resolutor (T39). Si `current` cae a la base pero el
    // aviso se sigue calculando contra la programada, la tienda ve "subira a 16.000 el dia 8" de
    // una comunidad que no tiene quien suba nada.
    const huerfana = sinLider(
      { sellerDeliveredFeeCop: 13000 },
      { scheduled: programada("sellerDeliveredFeeCop", 13000, 16000, at(8)) }
    );

    const vista = vistaTarifaDeTienda(BASE_COMPLETA, huerfana, at(3));
    expect(vista.current.sellerDeliveredFeeCop).toBe(12000);
    expect(vista.scheduled).toBeNull();
  });

  it("RF_21: lo ya congelado en un pedido no cambia cuando la comunidad se queda sin lider", () => {
    const viva = conLider({ sellerDeliveredFeeCop: 15000 });
    const congelado = freezeOrderPricing(BASE, viva, T0);
    expect(congelado!.sellerDeliveredFeeCop).toBe(15000);

    // Se le revoca el lider. Los pedidos NUEVOS entran ya a la base...
    const huerfana = sinLider({ sellerDeliveredFeeCop: 15000 });
    expect(resolveCommunityPricing(BASE, huerfana, at(30)).sellerDeliveredFeeCop).toBe(12000);

    // ...y el que entro antes conserva su precio y su cashback, un mes despues.
    expect(congelado!.sellerDeliveredFeeCop).toBe(15000);
    expect(congelado!.baseDeliveredFeeCop).toBe(12000);
    expect(communityChargeAtClose(congelado!, BASE).cashback.deliveredCop).toBe(3000);
  });

  it("RF_11 · cambio de intencion deliberado: el precio del lider no se recalcula al cerrar, la base si", () => {
    // Antes aqui se afirmaba `cashbackForFrozenPricing.length === 1`: el cierre no recibia NADA
    // mas que lo congelado, asi que no podia recalcular ni el precio ni la base (RF_22 de la 001).
    // RF_11 de la 004 reemplaza esa garantia EN LA BASE, a proposito: la zona se puede editar
    // despues de crear el pedido y la tienda sin comunidad paga la tarifa del cierre, asi que
    // congelar la base dejaba cobrar de menos. Lo que sigue garantizado es la mitad del lider.
    //
    // Estructura: dos parametros, lo congelado y la base del cierre. Ninguno es la comunidad, asi
    // que revocar al lider despues de crear el pedido sigue sin poder tocar su precio.
    expect(communityChargeAtClose.length).toBe(2);

    const congelado = freezeOrderPricing(BASE, conLider({ sellerDeliveredFeeCop: 15000 }), T0)!;
    const copia = structuredClone(congelado);

    // Misma `frozen`, bases distintas al cierre: el cobro y el cashback cambian con la base...
    const baseSube = communityChargeAtClose(congelado, { ...BASE, sellerDeliveredFeeCop: 14000 });
    const baseBaja = communityChargeAtClose(congelado, { ...BASE, sellerDeliveredFeeCop: 11000 });
    expect(baseSube.cashback.deliveredCop).toBe(1000);
    expect(baseBaja.cashback.deliveredCop).toBe(4000);
    // ...pero el precio del lider es el mismo en los dos: sale de lo congelado, no de la base.
    expect(baseSube.charged.sellerDeliveredFeeCop).toBe(15000);
    expect(baseBaja.charged.sellerDeliveredFeeCop).toBe(15000);
    // Y cerrar no reescribe lo congelado: un segundo cierre (una correccion) lee el mismo precio.
    expect(congelado).toEqual(copia);
  });

  it("RF_12: la tienda del propio lider causa cashback igual que cualquier otra", () => {
    const viva = conLider({ sellerDeliveredFeeCop: 15000 });

    // Mismo pedido, misma comunidad: uno de la tienda del lider, otro de una tienda cualquiera.
    const deLaTiendaDelLider = freezeOrderPricing(BASE, viva, T0);
    const deOtraTienda = freezeOrderPricing(BASE, viva, T0);
    expect(deLaTiendaDelLider).toEqual(deOtraTienda);
    expect(communityChargeAtClose(deLaTiendaDelLider!, BASE)).toEqual(communityChargeAtClose(deOtraTienda!, BASE));
    expect(communityChargeAtClose(deLaTiendaDelLider!, BASE).cashback.totalCop).toBe(3000);

    // La ausencia de rama especial, afirmada de la unica forma que no depende del resultado: ni
    // el precio ni el congelado ni el cashback reciben la tienda, su id o su dueño. Sin ese dato
    // a la vista no hay donde escribir "si la tienda es del lider, entonces...". Si alguien
    // quisiera distinguirla tendria que anadir un parametro, y esto lo caza al instante.
    expect(resolveCommunityPricing.length).toBe(3);
    expect(freezeOrderPricing.length).toBe(3);
    // RF_11 · cambio de intencion deliberado: el cierre pasa de UN parametro (lo congelado) a DOS
    // (lo congelado y la base del cierre). La afirmacion que importa aqui no cambia: ninguno de
    // los dos es la tienda, su id ni su dueño.
    expect(communityChargeAtClose.length).toBe(2);
  });
});

/**
 * T4 (spec 004) · El precio del lider se congela al crear; la base se decide al cerrar.
 *
 * Hasta la 004 se congelaban las DOS cosas al crear: el precio final y la base. Eso cobraba de
 * menos en cuanto la base del cierre no coincidia con la de crear —la zona se edita despues, y
 * una tienda sin comunidad paga la tarifa del cierre— y, peor, convertia en cashback una bajada
 * de la base aunque el lider no hubiera fijado nada (RF_04). Ahora:
 *
 *  - `freezeOrderPricing` guarda el precio PROPIO del lider (`leader<X>FeeCop`) y marca
 *    `pricingVersion: 2`. Ausente = el lider no fijo precio para ese concepto.
 *  - `communityChargeAtClose(frozen, base)` recibe la base DEL CIERRE y cobra el mayor entre esa
 *    base y el precio del lider; el cashback es la diferencia, nunca negativa.
 *  - Un pedido legado (sin `pricingVersion`) trata su `seller<X>` como precio del lider e ignora
 *    su base guardada: la de $9.000 pierde contra la base real sin intervencion manual.
 *
 * RNF_03: todo sin red ni mocks. Si alguna de estas funciones necesitara Firestore, este bloque
 * no podria ni escribirse asi.
 */

/** Base del cierre sin zona, tal como la da `communityBase` hoy (fallido fijo de 12.000). */
const BASE_SIN_ZONA: PricingValues = { sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000 };
/** La misma base en un pedido con zona: la zona sube el manejo a 2.500. */
const BASE_CON_ZONA: PricingValues = { ...BASE_SIN_ZONA, fulfillmentFeeCop: 2500 };

const SIN_CASHBACK = { deliveredCop: 0, failedCop: 0, fulfillmentCop: 0, totalCop: 0 };

const CAMPOS_LIDER = ["leaderDeliveredFeeCop", "leaderFailedFeeCop", "leaderFulfillmentFeeCop"] as const;

type PreciosDelLider = Partial<Pick<FrozenPricing, (typeof CAMPOS_LIDER)[number]>>;

/**
 * Pedido v2 escrito a mano. Sirve para fijar la ENTRADA del cierre sin depender de que el
 * congelado este bien: si `freezeOrderPricing` fallara, estas pruebas del cierre no deben
 * arrastrarse con el. Los campos de referencia se rellenan como lo haria el congelado.
 */
function congeladoV2(lider: PreciosDelLider, creadoCon: PricingValues = BASE_SIN_ZONA): FrozenPricing {
  const referencia = (precio: number | undefined, base: number): number =>
    precio !== undefined && precio > base ? precio : base;
  return {
    communityId: "com-1",
    frozenAt: T0,
    pricingVersion: 2,
    ...lider,
    sellerDeliveredFeeCop: referencia(lider.leaderDeliveredFeeCop, creadoCon.sellerDeliveredFeeCop),
    baseDeliveredFeeCop: creadoCon.sellerDeliveredFeeCop,
    sellerFailedFeeCop: referencia(lider.leaderFailedFeeCop, creadoCon.sellerFailedFeeCop),
    baseFailedFeeCop: creadoCon.sellerFailedFeeCop,
    fulfillmentFeeCop: referencia(lider.leaderFulfillmentFeeCop, creadoCon.fulfillmentFeeCop),
    baseFulfillmentFeeCop: creadoCon.fulfillmentFeeCop
  };
}

/**
 * Pedido anterior a la 004: sin `pricingVersion` ni `leader<X>`. Por defecto es EXACTAMENTE el
 * congelado de `community-corrections.test.ts` y `community-cashback-entries.test.ts`, para que
 * lo que esos archivos dan hoy quede atado tambien aqui.
 */
function congeladoLegado(over: Partial<FrozenPricing> = {}): FrozenPricing {
  return {
    communityId: "com-1",
    frozenAt: T0,
    sellerDeliveredFeeCop: 15000,
    baseDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 14000,
    baseFailedFeeCop: 12000,
    fulfillmentFeeCop: 2500,
    baseFulfillmentFeeCop: 2000,
    ...over
  };
}

describe("T4 · RF_03, RF_11: el precio del lider se congela, la base se decide al cierre", () => {
  // ── Al crear (RF_03) ──────────────────────────────────────────────────────────────────────

  it("RF_03 · congela el precio PROPIO vigente del lider, con las programadas vencidas, y marca pricingVersion 2", () => {
    const viva = conLider(
      { sellerDeliveredFeeCop: 13000, sellerFailedFeeCop: 12500, fulfillmentFeeCop: 2300 },
      { scheduled: programada("sellerDeliveredFeeCop", 13000, 16000, at(1)) }
    );
    const congelado = freezeOrderPricing(BASE, viva, at(3))!;

    expect(congelado).toMatchObject({
      pricingVersion: 2,
      // La programada vencio en at(1): a at(3) el lider ya cobra 16.000, no los 13.000 de `pricing`.
      leaderDeliveredFeeCop: 16000,
      leaderFailedFeeCop: 12500,
      leaderFulfillmentFeeCop: 2300,
      // Los seis de referencia (RF_03 MAY) se siguen escribiendo como hoy: pantallas y scripts
      // existentes los leen y no pueden perderlos.
      communityId: "com-1",
      frozenAt: at(3),
      sellerDeliveredFeeCop: 16000,
      baseDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 12500,
      baseFailedFeeCop: 12000,
      fulfillmentFeeCop: 2300,
      baseFulfillmentFeeCop: 2000
    });
  });

  it("RF_03 · una subida programada que aun no vence NO se congela: el pedido lleva el precio de hoy", () => {
    const conFutura = conLider(
      { sellerDeliveredFeeCop: 13000 },
      { scheduled: programada("sellerDeliveredFeeCop", 13000, 16000, at(8)) }
    );
    expect(freezeOrderPricing(BASE, conFutura, at(3))).toMatchObject({
      pricingVersion: 2,
      leaderDeliveredFeeCop: 13000
    });
  });

  it("RF_03 · se guarda lo que fijo el lider, sin llevarlo al piso de la base de crear (el piso lo pone el cierre)", () => {
    // Un fallido de 11.000 por debajo de la base de 12.000. Si se guardara ya elevado a 12.000 y la
    // base del cierre bajara a 10.000, se cobraria 12.000 en vez de los 11.000 que fijo el lider.
    const congelado = freezeOrderPricing(BASE, conLider({ sellerFailedFeeCop: 11000 }), T0)!;
    expect(congelado).toMatchObject({ pricingVersion: 2, leaderFailedFeeCop: 11000 });

    const conBaseReal = communityChargeAtClose(congelado, BASE_SIN_ZONA);
    expect(conBaseReal.charged.sellerFailedFeeCop).toBe(12000);
    expect(conBaseReal.cashback.failedCop).toBe(0);

    const conBaseBaja = communityChargeAtClose(congelado, { ...BASE_SIN_ZONA, sellerFailedFeeCop: 10000 });
    expect(conBaseBaja.charged.sellerFailedFeeCop).toBe(11000);
    expect(conBaseBaja.cashback.failedCop).toBe(1000);
  });

  it("RF_03 · un concepto sin precio propio (o sin numero valido) deja su campo AUSENTE, no en cero", () => {
    const congelado = freezeOrderPricing(
      BASE,
      conLider({ sellerDeliveredFeeCop: 15000, fulfillmentFeeCop: Number.NaN }),
      T0
    )!;
    expect(congelado).toMatchObject({ pricingVersion: 2, leaderDeliveredFeeCop: 15000 });
    // Ausente = "el lider no fijo nada" => el cierre cobra la base. Un cero escrito se leeria
    // como precio del lider y, por ejemplo, un legado lo tomaria como tal.
    expect(congelado).not.toHaveProperty("leaderFailedFeeCop");
    expect(congelado).not.toHaveProperty("leaderFulfillmentFeeCop");
  });

  it("RF_03, RF_20 · sin lider, con lider en blanco o desactivada: pricingVersion 2 y NINGUN precio del lider", () => {
    const precios = { sellerDeliveredFeeCop: 15000, sellerFailedFeeCop: 14000, fulfillmentFeeCop: 3000 };
    const casos: Array<[string, ComunidadConLider]> = [
      ["sin leaderUid", sinLider(precios)],
      ["leaderUid vacio", { ...community(precios), leaderUid: "" }],
      ["leaderUid en blanco", { ...community(precios), leaderUid: "   " }],
      ["desactivada con lider", conLider(precios, { status: "disabled" })]
    ];
    for (const [nombre, comunidad] of casos) {
      const congelado = freezeOrderPricing(BASE, comunidad, T0);
      expect(congelado, nombre).toMatchObject({ pricingVersion: 2 });
      for (const campo of CAMPOS_LIDER) {
        expect(congelado, `${nombre}: ${campo}`).not.toHaveProperty(campo);
      }
    }
  });

  // ── Al cerrar (RF_11, RF_04, RF_06) ───────────────────────────────────────────────────────

  it("RF_04 · sin precio propio se cobra EXACTAMENTE la base del cierre y el cashback es cero", () => {
    const congelado = freezeOrderPricing(BASE, conLider(), T0)!;
    const bases: PricingValues[] = [
      BASE_SIN_ZONA,
      BASE_CON_ZONA,
      { sellerDeliveredFeeCop: 14000, sellerFailedFeeCop: 13000, fulfillmentFeeCop: 3000 }
    ];
    for (const base of bases) {
      const cierre = communityChargeAtClose(congelado, base);
      expect(cierre.charged).toEqual(base);
      expect(cierre.base).toEqual(base);
      expect(cierre.cashback).toEqual(SIN_CASHBACK);
    }
  });

  it("RF_11 · manejo del lider 2.300: sin zona cobra 2.300 y causa 300; con zona cobra la base de 2.500 y causa 0", () => {
    const congelado = freezeOrderPricing(BASE, conLider({ fulfillmentFeeCop: 2300 }), T0)!;

    const sinZona = communityChargeAtClose(congelado, BASE_SIN_ZONA);
    expect(sinZona.charged.fulfillmentFeeCop).toBe(2300);
    expect(sinZona.cashback.fulfillmentCop).toBe(300);

    const conZona = communityChargeAtClose(congelado, BASE_CON_ZONA);
    expect(conZona.charged.fulfillmentFeeCop).toBe(2500);
    expect(conZona.cashback.fulfillmentCop).toBe(0);
  });

  it("RF_11 · la base SUBE entre crear y cerrar: se cobra la base nueva y el cashback queda en cero", () => {
    const congelado = congeladoV2({ leaderDeliveredFeeCop: 13000 });
    const cierre = communityChargeAtClose(congelado, { ...BASE_SIN_ZONA, sellerDeliveredFeeCop: 14000 });
    expect(cierre.charged.sellerDeliveredFeeCop).toBe(14000);
    expect(cierre.cashback.deliveredCop).toBe(0);
  });

  it("RF_11 · la base BAJA entre crear y cerrar: se cobra el precio del lider, que no baja, y el cashback crece", () => {
    const congelado = congeladoV2({ leaderDeliveredFeeCop: 13000 });
    const cierre = communityChargeAtClose(congelado, { ...BASE_SIN_ZONA, sellerDeliveredFeeCop: 11000 });
    expect(cierre.charged.sellerDeliveredFeeCop).toBe(13000);
    expect(cierre.cashback.deliveredCop).toBe(2000);
  });

  it("RF_04 · la base baja y el lider NO fijo precio: se cobra la base nueva sin cashback (el congelado viejo lo convertia en cashback)", () => {
    // El fallo concreto que corrige la 004: congelado con base 12.000/12.000/2.000 y cerrado con
    // una base mas baja. Leyendo `seller<X> - base<X>` del congelado, la tienda pagaba lo viejo y
    // la diferencia salia como cashback de un lider que nunca fijo nada.
    const baseBaja: PricingValues = { sellerDeliveredFeeCop: 11000, sellerFailedFeeCop: 10000, fulfillmentFeeCop: 1800 };
    const sinPrecioPropio: Array<[string, FrozenPricing]> = [
      ["con lider, sin pricing", freezeOrderPricing(BASE, conLider(), T0)!],
      ["sin lider, con pricing", freezeOrderPricing(BASE, sinLider({ sellerDeliveredFeeCop: 15000 }), T0)!],
      ["desactivada, con pricing", freezeOrderPricing(BASE, conLider({ sellerDeliveredFeeCop: 15000 }, { status: "disabled" }), T0)!]
    ];
    for (const [nombre, congelado] of sinPrecioPropio) {
      const cierre = communityChargeAtClose(congelado, baseBaja);
      expect(cierre.charged, nombre).toEqual(baseBaja);
      expect(cierre.cashback, nombre).toEqual(SIN_CASHBACK);
    }
  });

  it("RF_11 · pedido LEGADO con fallido de 9.000 guardado: pierde contra la base real, cobra 12.000 y causa 0", () => {
    // Caso limite de la spec: lo guardado se trata como precio del lider y la base guardada
    // (9.000) se ignora. Sin intervencion manual, al cerrar se cobran los 12.000 de la base real.
    const legado = congeladoLegado({ sellerFailedFeeCop: 9000, baseFailedFeeCop: 9000 });
    expect(legado).not.toHaveProperty("pricingVersion");

    const cierre = communityChargeAtClose(legado, BASE_SIN_ZONA);
    expect(cierre.charged.sellerFailedFeeCop).toBe(12000);
    expect(cierre.cashback.failedCop).toBe(0);
  });

  it("RF_11 · pedido LEGADO 15.000/12.000 contra base 12.000 da el mismo cashback que hoy (3.000 / 2.000 / 500)", () => {
    // Lo que hoy afirman `community-corrections.test.ts` y `community-cashback-entries.test.ts`
    // sobre este mismo congelado. Cerrar un legado con la base de siempre no puede mover un peso.
    const cierre = communityChargeAtClose(congeladoLegado(), BASE_SIN_ZONA);
    expect(cierre.charged).toEqual({ sellerDeliveredFeeCop: 15000, sellerFailedFeeCop: 14000, fulfillmentFeeCop: 2500 });
    expect(cierre.cashback).toEqual({ deliveredCop: 3000, failedCop: 2000, fulfillmentCop: 500, totalCop: 5500 });
  });

  it("RF_11 · en un LEGADO la base guardada se ignora: el cashback se mide contra la base del cierre", () => {
    // 15.000 guardado con una base vieja de 9.000. Contra la base real de 12.000 el lider gana
    // 3.000, no los 6.000 que diria la base guardada.
    const legado = congeladoLegado({ baseDeliveredFeeCop: 9000 });
    expect(communityChargeAtClose(legado, BASE_SIN_ZONA).cashback.deliveredCop).toBe(3000);
  });

  it("RF_06, RF_04 · nunca cashback negativo ni cobro bajo la base, en ningun orden de base y precio", () => {
    const precios: Array<number | undefined> = [undefined, 0, 5000, 11000, 12000, 13000, 20000];
    const bases = [0, 9000, 11000, 12000, 14000, 25000];
    const conceptos = [
      ["sellerDeliveredFeeCop", "deliveredCop"],
      ["sellerFailedFeeCop", "failedCop"],
      ["fulfillmentFeeCop", "fulfillmentCop"]
    ] as const;

    for (const precio of precios) {
      // v2: ausente = sin precio propio. Legado: no existe "ausente"; lo guardado era la base de crear.
      const v2 = congeladoV2(
        precio === undefined
          ? {}
          : { leaderDeliveredFeeCop: precio, leaderFailedFeeCop: precio, leaderFulfillmentFeeCop: precio }
      );
      const guardadoLegado = precio ?? 12000;
      const legado = congeladoLegado({
        sellerDeliveredFeeCop: guardadoLegado,
        sellerFailedFeeCop: guardadoLegado,
        fulfillmentFeeCop: guardadoLegado,
        baseDeliveredFeeCop: 12000,
        baseFailedFeeCop: 12000,
        baseFulfillmentFeeCop: 12000
      });

      for (const valorBase of bases) {
        const base: PricingValues = {
          sellerDeliveredFeeCop: valorBase,
          sellerFailedFeeCop: valorBase,
          fulfillmentFeeCop: valorBase
        };
        const casos: Array<[string, FrozenPricing, number | undefined]> = [
          ["v2", v2, precio],
          ["legado", legado, guardadoLegado]
        ];
        for (const [version, congelado, precioLider] of casos) {
          const cierre = communityChargeAtClose(congelado, base);
          for (const [campo, concepto] of conceptos) {
            const etiqueta = `${version} precio=${String(precioLider)} base=${valorBase} ${campo}`;
            const esperado = precioLider !== undefined && precioLider > valorBase ? precioLider : valorBase;
            expect(cierre.cashback[concepto], etiqueta).toBeGreaterThanOrEqual(0);
            expect(cierre.charged[campo], etiqueta).toBeGreaterThanOrEqual(valorBase);
            expect(cierre.charged[campo], etiqueta).toBe(esperado);
            expect(cierre.cashback[concepto], etiqueta).toBe(esperado - valorBase);
          }
        }
      }
    }
  });

  it("RF_06 · un precio del lider que no supera la base del cierre da cashback cero en ese concepto", () => {
    const congelado = congeladoV2({ leaderDeliveredFeeCop: 12000, leaderFulfillmentFeeCop: 1500 });
    const cierre = communityChargeAtClose(congelado, BASE_SIN_ZONA);
    expect(cierre.charged).toEqual(BASE_SIN_ZONA);
    expect(cierre.cashback).toEqual(SIN_CASHBACK);
  });

  it("RF_11 · cashback.totalCop es la suma de los tres conceptos", () => {
    const congelado = congeladoV2({
      leaderDeliveredFeeCop: 15000,
      leaderFailedFeeCop: 13000,
      leaderFulfillmentFeeCop: 2300
    });
    const { cashback } = communityChargeAtClose(congelado, { ...BASE_SIN_ZONA, sellerDeliveredFeeCop: 14000 });
    expect(cashback).toEqual({ deliveredCop: 1000, failedCop: 1000, fulfillmentCop: 300, totalCop: 2300 });
    expect(cashback.totalCop).toBe(cashback.deliveredCop + cashback.failedCop + cashback.fulfillmentCop);
  });

  it("RNF_03 · el cierre es puro: no muta sus entradas y repetido da exactamente lo mismo", () => {
    // Entradas congeladas con `Object.freeze`: en un modulo ESM (modo estricto) cualquier escritura
    // sobre ellas lanza. Sin red, sin mocks, sin reloj: lo que se prueba es la regla sola.
    const congelado = Object.freeze(congeladoV2({ leaderDeliveredFeeCop: 15000 }));
    const base = Object.freeze({ ...BASE_CON_ZONA });
    const primero = communityChargeAtClose(congelado, base);
    const segundo = communityChargeAtClose(congelado, base);
    expect(segundo).toEqual(primero);
    expect(primero.charged.sellerDeliveredFeeCop).toBe(15000);
    expect(primero.charged.fulfillmentFeeCop).toBe(2500);
  });
});

/**
 * T6 · RF_05, RF_12 — El minimo que el lider puede fijar es la base REAL sin zona.
 *
 * Hoy `scheduleCommunityPrice` (functions/src/communities.ts) valida contra el ajuste CRUDO:
 * `Number(settingsSnap.data()?.[field])`. En produccion el fallido del ajuste es 9.000, pero se
 * cobra 12.000 (fijo de `resolveSellerCharges`): la callable deja fijar 9.000 y el mensaje dice
 * "El minimo para este concepto es 9000." — un minimo que no es lo que Kentro cobra.
 *
 * La decision sale a una funcion pura, `validateCommunityPriceFloor(field, amountCop, base)`, para
 * probar el minimo y su mensaje sin Firestore (plan §3.5). La `base` que recibe es la de
 * `communityBase(resolveTariffs(settings/global))`, SIN zona: RF_05 no exige superar la base de
 * ninguna zona; en un pedido con zona, RF_11 cobra la base de la zona si es mayor, y el mensaje lo
 * avisa (RF_12).
 *
 * Carga diferida en `beforeEach`, como T39: mientras el modulo no exporte la funcion, cada caso sale
 * FALLIDO por separado y el resto del archivo sigue en verde (y `tsc` no se rompe).
 */
type ValidateCommunityPriceFloor = (
  field: "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop",
  amountCop: number,
  base: PricingValues
) => { ok: true } | { ok: false; floorCop: number; reason: string };

describe("T6 · RF_05, RF_12: el minimo es la base real sin zona", () => {
  // `settings/global` de PRODUCCION (plan 004 §0): el fallido del ajuste es 9.000 y NO es lo que se cobra.
  const SETTINGS_PROD = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 9000,
    fulfillmentFeeCop: 2000,
    driverDeliveredPayCop: 8000,
    driverFailedPayCop: 8000
  };
  // Zona de produccion: manejo 2.500.
  const ZONA_PROD = { sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2500 };
  const CONCEPTOS = ["sellerDeliveredFeeCop", "sellerFailedFeeCop", "fulfillmentFeeCop"] as const;

  let validateCommunityPriceFloor: ValidateCommunityPriceFloor;
  let baseSinZona: PricingValues;
  let baseConZona: PricingValues;

  beforeEach(async () => {
    const cargos = await import("../../functions/src/seller-charges");
    baseSinZona = cargos.communityBase(cargos.resolveTariffs(SETTINGS_PROD));
    baseConZona = cargos.communityBase(cargos.resolveTariffs(SETTINGS_PROD, ZONA_PROD));
    const modulo = (await import("../../functions/src/community-pricing")) as unknown as {
      validateCommunityPriceFloor?: ValidateCommunityPriceFloor;
    };
    if (typeof modulo.validateCommunityPriceFloor !== "function") {
      throw new Error("functions/src/community-pricing.ts todavia no exporta validateCommunityPriceFloor (T6).");
    }
    validateCommunityPriceFloor = modulo.validateCommunityPriceFloor;
  });

  it("RF_05 · la base de produccion sin zona es 12.000 / 12.000 / 2.000 (precondicion de los casos)", () => {
    expect(baseSinZona).toEqual({ sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000 });
  });

  it("RF_05 · fallido de 12.000 (igual a la base real) es valido", () => {
    expect(validateCommunityPriceFloor("sellerFailedFeeCop", 12000, baseSinZona)).toEqual({ ok: true });
  });

  it("RF_05 · fallido de 11.999 se rechaza con floorCop 12.000", () => {
    expect(validateCommunityPriceFloor("sellerFailedFeeCop", 11999, baseSinZona)).toMatchObject({ ok: false, floorCop: 12000 });
  });

  it("RF_05 · el rechazo nombra el minimo como $12.000 (es-CO, punto de miles), no el numero crudo", () => {
    const resultado = validateCommunityPriceFloor("sellerFailedFeeCop", 11999, baseSinZona);
    expect(resultado.ok).toBe(false);
    const reason = (resultado as { reason: string }).reason;
    expect(reason).toContain("$12.000");
    expect(reason).not.toMatch(/\b12000\b/);
  });

  it("RF_05 · el rechazo menciona la zona (el minimo es el de un pedido sin zona)", () => {
    const resultado = validateCommunityPriceFloor("sellerFailedFeeCop", 11999, baseSinZona);
    expect(resultado.ok).toBe(false);
    expect((resultado as { reason: string }).reason).toMatch(/zona/i);
  });

  it("RF_05 · fallido de 9.000 (el ajuste crudo que hoy la callable aceptaria) se rechaza con floorCop 12.000", () => {
    expect(validateCommunityPriceFloor("sellerFailedFeeCop", 9000, baseSinZona)).toMatchObject({ ok: false, floorCop: 12000 });
  });

  it("RF_05, RF_18 de la 001 · un precio IGUAL a la base es valido en los tres conceptos", () => {
    for (const campo of CONCEPTOS) {
      expect(validateCommunityPriceFloor(campo, baseSinZona[campo], baseSinZona), campo).toEqual({ ok: true });
    }
  });

  it("RF_05 · un peso por debajo de la base se rechaza en los tres conceptos, con SU base como floorCop", () => {
    for (const campo of CONCEPTOS) {
      expect(validateCommunityPriceFloor(campo, baseSinZona[campo] - 1, baseSinZona), campo).toMatchObject({
        ok: false,
        floorCop: baseSinZona[campo]
      });
    }
  });

  it("RF_05 · el minimo sale de la base recibida, concepto a concepto (no de una constante)", () => {
    const baseAlta: PricingValues = { sellerDeliveredFeeCop: 14000, sellerFailedFeeCop: 13000, fulfillmentFeeCop: 3000 };
    expect(validateCommunityPriceFloor("sellerDeliveredFeeCop", 13999, baseAlta)).toMatchObject({ ok: false, floorCop: 14000 });
    expect(validateCommunityPriceFloor("sellerDeliveredFeeCop", 14000, baseAlta)).toEqual({ ok: true });
    const manejo = validateCommunityPriceFloor("fulfillmentFeeCop", 2999, baseAlta);
    expect(manejo).toMatchObject({ ok: false, floorCop: 3000 });
    expect((manejo as { reason: string }).reason).toContain("$3.000");
  });

  it("RF_05 · manejo de 2.300 es valido contra la base sin zona (2.000) aunque la zona de produccion sea 2.500", () => {
    // La zona existe y es mas cara: si la validacion exigiera superarla, 2.300 se rechazaria.
    expect(baseConZona.fulfillmentFeeCop).toBe(2500);
    expect(validateCommunityPriceFloor("fulfillmentFeeCop", 2300, baseSinZona)).toEqual({ ok: true });
  });

  it("RF_12 · el mensaje avisa que en pedidos con zona la base puede ser mayor y que ahi se cobra la base", () => {
    const resultado = validateCommunityPriceFloor("sellerFailedFeeCop", 11999, baseSinZona);
    expect(resultado.ok).toBe(false);
    const reason = (resultado as { reason: string }).reason;
    expect(reason).toMatch(/pedidos? con zona/i);
    expect(reason).toMatch(/base puede ser mayor/i);
    expect(reason).toMatch(/se cobra la base/i);
    expect(reason).toMatch(/cashback/i);
  });

  it("RNF_03 · es pura: no muta la base que recibe", () => {
    const base = Object.freeze({ ...baseSinZona });
    validateCommunityPriceFloor("sellerFailedFeeCop", 11999, base);
    validateCommunityPriceFloor("sellerFailedFeeCop", 12000, base);
    expect(base).toEqual(baseSinZona);
  });
});

/**
 * T7 · RF_13 — Elevar al piso REAL, escuchando los ajustes que existen.
 *
 * Dos fallos de hoy, los dos silenciosos:
 *
 *  1. `planFloorRaise` compara el ajuste CRUDO (`tariffFromSettings`). En produccion el fallido del
 *     ajuste es 9.000 y se cobra 12.000 (fijo de `resolveSellerCharges`): subir el ajuste de 9.000 a
 *     11.000 "sube la base" para el plan y eleva a los lideres a 11.000, un piso que no es el de
 *     nadie — y escribe un aviso y un historial de una subida que no ocurrio. La base de RF_13 es
 *     la de RF_01: `communityBase(resolveTariffs(ajustes))`, la misma que cobra el cierre.
 *  2. El trigger escucha `settings/app`, que no existe en produccion (solo `settings/global`):
 *     RF_35 de la 001 no se ha ejecutado nunca.
 *
 * El plan se parte en dos para que la pasada unica de T8 (RF_14) reuse la mitad por comunidad sin
 * tener un "antes": `raisedCommunityFloors(before, after)` decide que conceptos subieron y hasta
 * donde; `planRaiseToFloors({floors, communities, nowIso})` decide que comunidades elevar.
 * `planFloorRaise` queda como su composicion, con el mismo tipo de retorno (el bloque T47 sigue
 * atandolo).
 *
 * Firma elegida: `raisedCommunityFloors` recibe los AJUSTES CRUDOS (no `Tariffs`). Es lo que el
 * trigger tiene en la mano (`before.data()` / `after.data()`), y si recibiera tarifas ya resueltas
 * cada llamador tendria que acordarse de pasar por `resolveTariffs` + `communityBase` — que es
 * justo el olvido que causo el fallo 1. La resolucion vive dentro, una vez.
 *
 * "Avisar al lider" (spec 004 §6) = la marca `floorRaisedAt.<campo>` + la entrada de historial. Se
 * afirman las dos en el plan, y una guarda de fuente comprueba que el writer las copia a Firestore.
 *
 * Carga diferida en `beforeEach`, como T6 y T39: sin las funciones, estos casos salen en ROJO uno a
 * uno y el resto del archivo sigue en verde.
 */
type RaisedCommunityFloors = (
  before: Record<string, unknown>,
  after: Record<string, unknown>
) => Partial<PricingValues>;

type PlanRaiseToFloors = (input: {
  floors: Partial<PricingValues>;
  communities: Community[];
  nowIso: string;
}) => CommunityFloorRaise[];

/** Codigo sin comentarios: una guarda de fuente no puede darse por buena con un comentario. */
function fuenteSinComentarios(relativeToFunctionsSrc: string): string {
  const raw = readFileSync(
    fileURLToPath(new URL(`../../functions/src/${relativeToFunctionsSrc}`, import.meta.url)),
    "utf8"
  );
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("T7 · RF_13: elevar al piso real, escuchando los ajustes que existen", () => {
  /** `settings/global` de PRODUCCION (plan 004 §0): el fallido del ajuste dice 9.000 y se cobra 12.000. */
  const GLOBAL_PROD: Record<string, unknown> = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 9000,
    fulfillmentFeeCop: 2000,
    driverDeliveredPayCop: 8000,
    driverFailedPayCop: 8000,
    payoutDays: 7,
    supportText: "Escribenos por WhatsApp"
  };
  const globalCon = (cambios: Record<string, unknown>): Record<string, unknown> => ({ ...GLOBAL_PROD, ...cambios });
  const AHORA = at(3);

  let raisedCommunityFloors: RaisedCommunityFloors;
  let planRaiseToFloors: PlanRaiseToFloors;
  let planFloorRaiseNuevo: PlanFloorRaise;

  beforeEach(async () => {
    const modulo = (await import("../../functions/src/community-pricing")) as unknown as {
      raisedCommunityFloors?: RaisedCommunityFloors;
      planRaiseToFloors?: PlanRaiseToFloors;
      planFloorRaise?: PlanFloorRaise;
    };
    if (typeof modulo.raisedCommunityFloors !== "function") {
      throw new Error("functions/src/community-pricing.ts todavia no exporta raisedCommunityFloors (T7).");
    }
    if (typeof modulo.planRaiseToFloors !== "function") {
      throw new Error("functions/src/community-pricing.ts todavia no exporta planRaiseToFloors (T7).");
    }
    if (typeof modulo.planFloorRaise !== "function") {
      throw new Error("functions/src/community-pricing.ts dejo de exportar planFloorRaise (T7 la conserva).");
    }
    raisedCommunityFloors = modulo.raisedCommunityFloors;
    planRaiseToFloors = modulo.planRaiseToFloors;
    planFloorRaiseNuevo = modulo.planFloorRaise;
  });

  it("RF_13 · subir el fallido del ajuste de 9.000 a 11.000 no sube la base: el fijo de 12.000 manda en los dos lados", () => {
    expect(raisedCommunityFloors(GLOBAL_PROD, globalCon({ sellerFailedFeeCop: 11000 }))).toEqual({});
  });

  it("RF_13 · subir el fallido del ajuste no eleva a ninguna comunidad (ni aviso ni historial)", () => {
    // 10.000 esta por debajo de los 11.000 del ajuste nuevo: el plan de hoy, que compara el ajuste
    // crudo, lo eleva a 11.000 y le escribe al lider un aviso de una subida que no ocurrio.
    const plan = planFloorRaiseNuevo({
      before: GLOBAL_PROD,
      after: globalCon({ sellerFailedFeeCop: 11000 }),
      communities: [community({ sellerFailedFeeCop: 10000 })],
      nowIso: AHORA
    });
    expect(plan).toEqual({ raisedFields: [], communities: [] });
  });

  it("RF_13 · el ajuste del fallido tampoco sube nada cuando supera el fijo (9.000 -> 15.000)", () => {
    // Cambiar `sellerFailedFeeCop` en la pantalla de ajustes NO tiene efecto en el cobro
    // (seller-charges.ts, SELLER_FAILED_FEE_FIXED_COP). Un piso que el cierre no cobra no es piso.
    expect(raisedCommunityFloors(GLOBAL_PROD, globalCon({ sellerFailedFeeCop: 15000 }))).toEqual({});
  });

  it("RF_13 · subir la entrega de 12.000 a 13.000 sube ese concepto, y solo ese, hasta 13.000", () => {
    expect(raisedCommunityFloors(GLOBAL_PROD, globalCon({ sellerDeliveredFeeCop: 13000 }))).toEqual({
      sellerDeliveredFeeCop: 13000
    });
  });

  it("RF_13 · subir la entrega eleva a 13.000 la comunidad que cobraba 12.500, con el aviso al lider", () => {
    const plan = planFloorRaiseNuevo({
      before: GLOBAL_PROD,
      after: globalCon({ sellerDeliveredFeeCop: 13000 }),
      communities: [community({ sellerDeliveredFeeCop: 12500 })],
      nowIso: AHORA
    });
    expect(plan.raisedFields).toEqual(["sellerDeliveredFeeCop"]);
    expect(plan.communities).toHaveLength(1);
    const cambio = plan.communities[0];
    expect(cambio.communityUpdate["pricing.sellerDeliveredFeeCop"]).toBe(13000);
    // El AVISO de RF_13 (spec 004 §6): la marca por concepto con el instante de la elevacion.
    expect(cambio.communityUpdate["floorRaisedAt.sellerDeliveredFeeCop"]).toBe(AHORA);
  });

  it("RF_13 · la elevacion de la entrega deja su entrada de historial (de 12.500 a 13.000, desde ya, firmada por el sistema)", () => {
    const plan = planFloorRaiseNuevo({
      before: GLOBAL_PROD,
      after: globalCon({ sellerDeliveredFeeCop: 13000 }),
      communities: [community({ sellerDeliveredFeeCop: 12500 })],
      nowIso: AHORA
    });
    expect(plan.communities[0].historyEntries).toEqual([
      expect.objectContaining({
        field: "sellerDeliveredFeeCop",
        fromCop: 12500,
        toCop: 13000,
        effectiveAt: AHORA,
        actorUid: AUTOR_PISO
      })
    ]);
  });

  it("RF_13 · guardar los ajustes sin cambiar ninguna tarifa (plazo de pago, un texto) no sube nada", () => {
    expect(
      raisedCommunityFloors(GLOBAL_PROD, globalCon({ payoutDays: 15, supportText: "Nuevo horario de soporte" }))
    ).toEqual({});
  });

  it("RF_13 · guardar los ajustes sin cambiar ninguna tarifa no eleva ni avisa a nadie, aunque haya precios bajo la base", () => {
    // La comunidad tiene un fallido propio de 10.000 bajo la base real de 12.000: esta por debajo,
    // pero ningun guardado la puso ahi. Arreglarla es trabajo de la pasada unica (RF_14, T8), no de
    // un guardado de textos.
    const plan = planFloorRaiseNuevo({
      before: GLOBAL_PROD,
      after: globalCon({ payoutDays: 15, supportText: "Nuevo horario de soporte" }),
      communities: [community({ sellerFailedFeeCop: 10000 })],
      nowIso: AHORA
    });
    expect(plan).toEqual({ raisedFields: [], communities: [] });
  });

  it("RF_13 · escribir en el ajuste un valor que ya era el que se cobraba (manejo ausente -> 2.000) no sube nada", () => {
    // Sin el campo, `resolveTariffs` ya cobraba el defecto de 2.000. Guardarlo explicito no mueve la
    // base de RF_01, asi que no hay nada que elevar (el plan crudo de hoy lo lee como 0 -> 2.000).
    const sinManejo: Record<string, unknown> = { ...GLOBAL_PROD };
    delete sinManejo.fulfillmentFeeCop;
    expect(raisedCommunityFloors(sinManejo, globalCon({ fulfillmentFeeCop: 2000 }))).toEqual({});
  });

  it("RF_13 · planFloorRaise es la composicion: los conceptos de raisedCommunityFloors y las comunidades de planRaiseToFloors", () => {
    const before = GLOBAL_PROD;
    const after = globalCon({ sellerDeliveredFeeCop: 14000, fulfillmentFeeCop: 2500, sellerFailedFeeCop: 11000 });
    const comunidades = [
      community({ sellerDeliveredFeeCop: 12500, fulfillmentFeeCop: 2100, sellerFailedFeeCop: 10000 }),
      community({ sellerDeliveredFeeCop: 16000 }, { id: "com-2" })
    ];
    const floors = raisedCommunityFloors(before, after);
    expect(planFloorRaiseNuevo({ before, after, communities: comunidades, nowIso: AHORA })).toEqual({
      raisedFields: Object.keys(floors),
      communities: planRaiseToFloors({ floors, communities: comunidades, nowIso: AHORA })
    });
  });

  it("RF_13, RF_14 · planRaiseToFloors eleva un fallido propio de 10.000 al piso de 12.000 con aviso e historial", () => {
    const cambios = planRaiseToFloors({
      floors: { sellerFailedFeeCop: 12000 },
      communities: [community({ sellerFailedFeeCop: 10000 })],
      nowIso: AHORA
    });
    expect(cambios).toEqual([
      {
        communityId: "com-1",
        fields: ["sellerFailedFeeCop"],
        communityUpdate: {
          "pricing.sellerFailedFeeCop": 12000,
          "floorRaisedAt.sellerFailedFeeCop": AHORA,
          updatedAt: AHORA
        },
        deleteFields: [],
        historyEntries: [
          {
            field: "sellerFailedFeeCop",
            fromCop: 10000,
            toCop: 12000,
            effectiveAt: AHORA,
            actorUid: AUTOR_PISO,
            actorRole: "system",
            createdAt: AHORA
          }
        ]
      }
    ]);
  });

  it("RF_13, RF_14 · planRaiseToFloors aplicado dos veces seguidas: la segunda no eleva ni vuelve a avisar", () => {
    const original = community({ sellerFailedFeeCop: 10000 });
    const entrada = { floors: { sellerFailedFeeCop: 12000 }, nowIso: AHORA };
    const primero = planRaiseToFloors({ ...entrada, communities: [original] });
    expect(primero).toHaveLength(1);
    const yaElevada = aplicar(original, primero[0]);
    expect(planRaiseToFloors({ ...entrada, communities: [yaElevada] })).toEqual([]);
  });

  it("RF_13 · planRaiseToFloors solo mira los conceptos que recibe: un piso de fallido no toca la entrega", () => {
    const cambios = planRaiseToFloors({
      floors: { sellerFailedFeeCop: 12000 },
      communities: [community({ sellerFailedFeeCop: 10000, sellerDeliveredFeeCop: 11000 })],
      nowIso: AHORA
    });
    expect(cambios[0].fields).toEqual(["sellerFailedFeeCop"]);
  });

  it("RF_13 · planRaiseToFloors borra la programada que el piso rebasa (criterio de T47 intacto)", () => {
    const cambios = planRaiseToFloors({
      floors: { sellerFailedFeeCop: 12000 },
      communities: [
        community(
          { sellerFailedFeeCop: 10000 },
          { scheduled: programada("sellerFailedFeeCop", 10000, 11500, at(8)) }
        )
      ],
      nowIso: AHORA
    });
    expect(cambios[0].deleteFields).toEqual(["scheduled.sellerFailedFeeCop"]);
  });
});

/**
 * T7 · Guardas de fuente del trigger y del writer. Aparte, SIN el `beforeEach` de arriba: cada una
 * tiene que fallar por su propio motivo (la ruta `settings/app`, el import que falta, el writer que
 * no existe), no porque al modulo puro le falte un export.
 *
 * El writer importa `firebase-admin` y no se puede probar en unidad (plan 004 §4): la guarda es la
 * unica red que impide que el aviso (`floorRaisedAt`) o el historial se pierdan entre el plan y
 * Firestore.
 */
describe("T7 · RF_13: guardas de fuente del trigger y del writer", () => {
  it("RF_13 · el trigger escucha settings/global, los ajustes que de verdad se usan para cobrar", () => {
    expect(fuenteSinComentarios("community-floor-trigger.ts")).toContain('onDocumentUpdated("settings/global"');
  });

  it("RF_13 · el trigger ya no escucha settings/app, que no existe en produccion", () => {
    expect(fuenteSinComentarios("community-floor-trigger.ts")).not.toContain('"settings/app"');
  });

  it("RF_13 · el trigger escribe via community-floor-writer (el mismo writer que usara la pasada de RF_14)", () => {
    expect(fuenteSinComentarios("community-floor-trigger.ts")).toMatch(/from\s+["']\.\/community-floor-writer["']/);
  });

  it("RF_13 · el trigger no conserva su batch propio: una sola copia de la escritura", () => {
    expect(fuenteSinComentarios("community-floor-trigger.ts")).not.toMatch(/\.batch\s*\(/);
  });

  it("RF_13 · el writer copia communityUpdate ENTERO, floorRaisedAt (el aviso) incluido", () => {
    // Copiar clave a clave (`pricing.X`) perderia la marca de aviso entre el plan y Firestore.
    expect(fuenteSinComentarios("community-floor-writer.ts")).toMatch(
      /\.\.\.\s*[\w.?]*communityUpdate\b|Object\.assign\([^)]*communityUpdate/
    );
  });

  it("RF_13 · el writer traduce deleteFields a FieldValue.delete()", () => {
    const writer = fuenteSinComentarios("community-floor-writer.ts");
    expect(writer).toMatch(/deleteFields/);
    expect(writer).toMatch(/FieldValue\.delete\(\)/);
  });

  it("RF_13 · el writer recorre historyEntries y escribe cada una en priceHistory", () => {
    const writer = fuenteSinComentarios("community-floor-writer.ts");
    expect(writer).toMatch(/for\s*\([^)]*\bof\s+[\w.?]*historyEntries\s*\)|historyEntries\s*\.\s*(forEach|map)\s*\(/);
    expect(writer).toMatch(/["']priceHistory["']/);
  });
});

/**
 * T8 · RF_14: la pasada unica. Al desplegar se aplica UNA vez la elevacion de RF_13 a todo precio
 * guardado por debajo de la base real, con el mismo aviso e historial, en seco por defecto.
 *
 * Dos mitades, cada una roja por su propio motivo:
 * - Casos puros: lo que la pasada calcula. Usan `planRaiseToFloors` (T7) con los TRES pisos de
 *   `communityBase(resolveTariffs(settings/global))`. T7 ya fija la idempotencia con UN solo piso
 *   (el fallido, "planRaiseToFloors aplicado dos veces seguidas"); aqui solo se anade la entrada
 *   real de la pasada, que son los tres conceptos a la vez.
 * - Guardas de fuente sobre `scripts/raise-community-floors.js`: el script importa firebase-admin
 *   y lee produccion, asi que no se ejecuta en unidad. La guarda es la red que impide que la pasada
 *   escriba sin `--apply`, o que calcule o escriba con una copia propia de la regla.
 */
describe("T8 · RF_14: la pasada unica eleva al piso real con el mismo aviso e historial", () => {
  /** `settings/global` de PRODUCCION (plan 004 §0): el ajuste del fallido dice 9.000 y se cobra 12.000. */
  const SETTINGS_PROD: Record<string, unknown> = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 9000,
    fulfillmentFeeCop: 2000,
    driverDeliveredPayCop: 8000,
    driverFailedPayCop: 8000
  };
  const AHORA = at(5);

  let planRaiseToFloors: PlanRaiseToFloors;
  let pisosDeLaPasada: () => Partial<PricingValues>;

  beforeEach(async () => {
    const precios = (await import("../../functions/src/community-pricing")) as unknown as {
      planRaiseToFloors?: PlanRaiseToFloors;
    };
    const cargos = (await import("../../functions/src/seller-charges")) as unknown as {
      communityBase?: (tariffs: unknown) => Partial<PricingValues>;
      resolveTariffs?: (settings: Record<string, unknown>) => unknown;
    };
    if (typeof precios.planRaiseToFloors !== "function") {
      throw new Error("functions/src/community-pricing.ts no exporta planRaiseToFloors (T7).");
    }
    if (typeof cargos.communityBase !== "function" || typeof cargos.resolveTariffs !== "function") {
      throw new Error("functions/src/seller-charges.ts no exporta communityBase/resolveTariffs (T2).");
    }
    planRaiseToFloors = precios.planRaiseToFloors;
    const { communityBase, resolveTariffs } = cargos;
    // La formula de la pasada, tal como la fija el plan 004 §3.6. Nunca un literal.
    pisosDeLaPasada = () => communityBase(resolveTariffs(SETTINGS_PROD));
  });

  it("RF_14 · los pisos de la pasada son la base real de los TRES conceptos: 12.000 / 12.000 / 2.000 (el fallido del ajuste, 9.000, no manda)", () => {
    expect(pisosDeLaPasada()).toEqual({
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 12000,
      fulfillmentFeeCop: 2000
    });
  });

  it("RF_14 · con fallido propio 10.000 y entrega propia 12.500, la pasada eleva SOLO el fallido a 12.000 con su aviso", () => {
    const cambios = planRaiseToFloors({
      floors: pisosDeLaPasada(),
      communities: [community({ sellerFailedFeeCop: 10000, sellerDeliveredFeeCop: 12500 })],
      nowIso: AHORA
    });
    expect(cambios).toHaveLength(1);
    expect(cambios[0].fields).toEqual(["sellerFailedFeeCop"]);
    expect(cambios[0].communityUpdate).toEqual({
      "pricing.sellerFailedFeeCop": 12000,
      "floorRaisedAt.sellerFailedFeeCop": AHORA,
      updatedAt: AHORA
    });
  });

  it("RF_14 · el historial de la pasada es IDENTICO al que produce el trigger para ese concepto (system:floor, desde ya)", () => {
    const comunidad = community({ sellerFailedFeeCop: 10000, sellerDeliveredFeeCop: 12500 });
    const pasada = planRaiseToFloors({ floors: pisosDeLaPasada(), communities: [comunidad], nowIso: AHORA });
    // Lo que el trigger compone para el fallido: planRaiseToFloors con el piso de ESE concepto solo.
    const trigger = planRaiseToFloors({
      floors: { sellerFailedFeeCop: 12000 },
      communities: [comunidad],
      nowIso: AHORA
    });
    expect(pasada[0].historyEntries).toEqual([
      {
        field: "sellerFailedFeeCop",
        fromCop: 10000,
        toCop: 12000,
        effectiveAt: AHORA,
        actorUid: AUTOR_PISO,
        actorRole: "system",
        createdAt: AHORA
      }
    ]);
    expect(pasada).toEqual(trigger);
  });

  it("RF_14 · E-master de hoy (sin precios propios, activa y con lider) => la pasada no cambia nada", () => {
    // Lo que se espera ver en produccion al correrla en seco (plan 004 §7 paso 4): 0 cambios.
    // `community()` ya la deja activa y con `leaderUid`: el unico estado en que el precio propio cuenta.
    const eMaster = community({}, { id: "e-master", name: "E-master", slug: "e-master", status: "active" });
    expect(eMaster.leaderUid).toBe(UID_LIDER);
    expect(planRaiseToFloors({ floors: pisosDeLaPasada(), communities: [eMaster], nowIso: AHORA })).toEqual([]);
  });

  it("RF_14 · caso limite: dos pasadas con los tres pisos => la segunda no cambia nada ni vuelve a avisar", () => {
    // T7 lo fija con un solo piso; aqui con la entrada real de la pasada (los tres conceptos a la vez).
    const original = community({ sellerFailedFeeCop: 10000, sellerDeliveredFeeCop: 11000, fulfillmentFeeCop: 1500 });
    const primera = planRaiseToFloors({ floors: pisosDeLaPasada(), communities: [original], nowIso: AHORA });
    expect([...primera[0].fields].sort()).toEqual(["fulfillmentFeeCop", "sellerDeliveredFeeCop", "sellerFailedFeeCop"]);
    const yaElevada = aplicar(original, primera[0]);
    expect(planRaiseToFloors({ floors: pisosDeLaPasada(), communities: [yaElevada], nowIso: at(6) })).toEqual([]);
  });
});

/**
 * T8 · Guardas de fuente de `scripts/raise-community-floors.js`. Aparte y sin `beforeEach`: cada
 * una falla por su motivo (hoy, porque el script no existe).
 */
describe("T8 · RF_14: guardas de fuente de la pasada (scripts/raise-community-floors.js)", () => {
  const RUTA_PASADA = "../../scripts/raise-community-floors.js";

  /** Codigo del script sin comentarios: una guarda no se da por buena con un comentario. */
  function fuentePasada(): string {
    const raw = readFileSync(fileURLToPath(new URL(RUTA_PASADA, import.meta.url)), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  /** El nombre de la bandera que lee `--apply` (p.ej. `APPLY`), o null si no la hay. */
  function banderaApply(src: string): string | null {
    const m = src.match(/(?:const|let|var)\s+(\w+)\s*=\s*process\.argv\.includes\(\s*["']--apply["']\s*\)/);
    return m ? m[1] : null;
  }

  it("RF_14 · en seco por defecto: solo escribe si se pasa --apply (process.argv.includes(\"--apply\"))", () => {
    expect(banderaApply(fuentePasada())).not.toBeNull();
  });

  it("RF_14 · la escritura (writeFloorRaise) va detras de la comprobacion de --apply", () => {
    const src = fuentePasada();
    const bandera = banderaApply(src);
    expect(bandera).not.toBeNull();
    const guarda = src.search(new RegExp(`if\\s*\\(\\s*!?\\s*${bandera}\\b`));
    const llamadas = [...src.matchAll(/\bwriteFloorRaise\s*\(/g)].map((m) => m.index ?? -1);
    expect(guarda).toBeGreaterThanOrEqual(0);
    expect(llamadas.length).toBeGreaterThan(0);
    for (const i of llamadas) expect(i).toBeGreaterThan(guarda);
  });

  it("RF_14 · usa el plan puro compilado: require de ../functions/lib/community-pricing y llama a planRaiseToFloors", () => {
    const src = fuentePasada();
    expect(src).toMatch(/require\(\s*["']\.\.\/functions\/lib\/community-pricing(?:\.js)?["']\s*\)/);
    expect(src).toMatch(/\bplanRaiseToFloors\s*\(/);
  });

  it("RF_14 · los pisos salen de communityBase(resolveTariffs(...)) de ../functions/lib/seller-charges", () => {
    const src = fuentePasada();
    expect(src).toMatch(/require\(\s*["']\.\.\/functions\/lib\/seller-charges(?:\.js)?["']\s*\)/);
    expect(src).toMatch(/\bcommunityBase\s*\(\s*resolveTariffs\s*\(/);
  });

  it("RF_14 · escribe con el MISMO writer que el trigger: require de ../functions/lib/community-floor-writer", () => {
    expect(fuentePasada()).toMatch(/require\(\s*["']\.\.\/functions\/lib\/community-floor-writer(?:\.js)?["']\s*\)/);
  });

  it("RF_14 · lee settings/global (los ajustes que se cobran), no settings/app", () => {
    const src = fuentePasada();
    expect(src).toMatch(/["']settings\/global["']|collection\(\s*["']settings["']\s*\)\s*\.doc\(\s*["']global["']\s*\)/);
    expect(src).not.toMatch(/["']settings\/app["']|\.doc\(\s*["']app["']\s*\)/);
  });

  it("RF_14 · recorre la coleccion communities", () => {
    expect(fuentePasada()).toMatch(/collection\(\s*["']communities["']\s*\)/);
  });

  it("RF_14 · no redefine la aritmetica ni la escritura: sin pricing.* propios, sin FieldValue.delete, sin batch/update propios", () => {
    const src = fuentePasada();
    expect(src).not.toMatch(/["']pricing\.\w+["']/);
    expect(src).not.toMatch(/\bpricing\.\w+\s*=[^=]/);
    expect(src).not.toMatch(/FieldValue\.delete/);
    expect(src).not.toMatch(/\.batch\s*\(/);
    expect(src).not.toMatch(/\.update\s*\(/);
    expect(src).not.toMatch(/["']priceHistory["']/);
  });

  it("RF_14 · imprime el plan (console.log) antes de escribir", () => {
    const src = fuentePasada();
    const imprime = src.search(/console\.(log|table)\s*\(/);
    const escribe = src.search(/\bwriteFloorRaise\s*\(/);
    expect(imprime).toBeGreaterThanOrEqual(0);
    expect(escribe).toBeGreaterThanOrEqual(0);
    expect(imprime).toBeLessThan(escribe);
  });

  it("RF_14 · si falta functions/lib falla con un mensaje claro que pide npm run build", () => {
    expect(fuentePasada()).toMatch(/npm run build/);
  });
});
