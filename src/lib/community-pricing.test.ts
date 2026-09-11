import { beforeEach, describe, expect, it } from "vitest";
import {
  applyScheduledChanges,
  cashbackForFrozenPricing,
  freezeOrderPricing,
  resolveCommunityPricing,
  scheduleEffectiveAt,
  SCHEDULED_RAISE_NOTICE_DAYS
} from "../../functions/src/community-pricing";
import type { Community, CommunityPricingFields, ScheduledPriceChange } from "./types";

const BASE = { sellerDeliveredFeeCop: 12000, sellerFailedFeeCop: 12000, fulfillmentFeeCop: 2000 };
const T0 = "2026-09-01T00:00:00.000Z";
const day = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.parse(T0) + days * day).toISOString();

function community(pricing: CommunityPricingFields = {}, extra: Partial<Community> = {}): Community {
  return {
    id: "com-1", name: "Comunidad", slug: "comunidad",
    leaderName: "Ana", leaderEmail: "ana@x.co", leaderPhone: "3000000000",
    linkStatus: "active", status: "active", pricing,
    createdAt: T0, updatedAt: T0, ...extra
  };
}

describe("T3 · precio vigente y piso", () => {
  it("RF_20: sin precio propio se cobra la base y el cashback es cero", () => {
    const p = resolveCommunityPricing(BASE, community(), T0);
    expect(p.sellerDeliveredFeeCop).toBe(12000);
    expect(cashbackForFrozenPricing(freezeOrderPricing(BASE, community(), T0)!).totalCop).toBe(0);
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
    const subeBase = freezeOrderPricing({ ...BASE, sellerDeliveredFeeCop: 20000 }, community({ sellerDeliveredFeeCop: 13000 }), T0)!;
    const subePrecio = freezeOrderPricing(BASE, community({ sellerDeliveredFeeCop: 13000 }), T0)!;
    expect(cashbackForFrozenPricing(subeBase).totalCop).toBe(0);
    expect(cashbackForFrozenPricing(subePrecio).totalCop).toBe(1000);
    expect(cashbackForFrozenPricing(subeBase).totalCop).toBeGreaterThanOrEqual(0);
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
    const cashback = cashbackForFrozenPricing(frozen);
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
    expect(cashbackForFrozenPricing(freezeOrderPricing(base, despues, at(3))!).deliveredCop).toBe(0);
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
