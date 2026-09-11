import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { brandFor, roleLabel, shouldOpenCommunitiesPanel } from "./community-view";
import { buildPriceHistoryEntry, LOGO_MAX_BYTES, validateLogo } from "../../functions/src/community-pricing";
import { validateSlug } from "../../functions/src/community-slug";

describe("T1 · rol de lider de comunidad", () => {
  it("RF_01: distingue al lider de comunidad del lider logistico en la etiqueta visible", () => {
    expect(roleLabel("driver")).toBe("Lider logistico");
    expect(roleLabel("community_leader")).toBe("Lider de comunidad");
    expect(roleLabel("driver")).not.toBe(roleLabel("community_leader"));
  });

  it("RF_01: etiqueta todos los roles sin devolver nunca 'lider' a secas", () => {
    const roles = ["admin", "seller", "seller_logistics", "driver", "messenger", "community_leader"] as const;
    for (const role of roles) {
      const label = roleLabel(role);
      expect(label.length).toBeGreaterThan(0);
      expect(label.trim().toLowerCase()).not.toBe("lider");
    }
  });
});

describe("T13, T15 · marca visible y logo", () => {
  it("RF_14: con logo del lider se pinta su marca", () => {
    expect(brandFor({ name: "Comunidad Andes", logoPath: "logos/com-1.png" })).toEqual({
      kind: "community",
      name: "Comunidad Andes",
      logoPath: "logos/com-1.png"
    });
  });

  it("RF_15: sin logo se pinta la marca de la plataforma, nunca un hueco", () => {
    expect(brandFor({ name: "Comunidad Andes" }).kind).toBe("platform");
    expect(brandFor({ name: "Comunidad Andes", logoPath: "  " }).kind).toBe("platform");
    expect(brandFor(undefined)).toEqual({ kind: "platform", name: "Kentro" });
  });

  it("RF_16: se rechaza el logo fuera de formato o de tamano", () => {
    expect(validateLogo({ contentType: "image/png", sizeBytes: 100_000 }).ok).toBe(true);
    expect(validateLogo({ contentType: "image/gif", sizeBytes: 100 }).ok).toBe(false);
    expect(validateLogo({ contentType: "image/png", sizeBytes: LOGO_MAX_BYTES + 1 }).ok).toBe(false);
  });
});

describe("T14 · historial de precios", () => {
  it("RF_39: registra quien, cuando, de cuanto a cuanto y desde cuando aplica", () => {
    const entry = buildPriceHistoryEntry({
      field: "sellerDeliveredFeeCop",
      fromCop: 12000,
      toCop: 15000,
      nowIso: "2026-09-01T00:00:00.000Z",
      actorUid: "uid-lider",
      actorRole: "community_leader"
    });
    expect(entry.fromCop).toBe(12000);
    expect(entry.toCop).toBe(15000);
    expect(entry.actorUid).toBe("uid-lider");
    // Es una subida: entra a los ocho dias, no al instante.
    expect(entry.effectiveAt).toBe("2026-09-09T00:00:00.000Z");
  });
});

/**
 * T44 · El recuento de la desactivacion en bloque, tal cual, en pantalla (RF_41, RF_42).
 *
 * T32 dejo `summarizeBulkSignupDisable` repartiendo cada tienda planeada entre desactivadas,
 * fallidas, intactas y selladas, cada una con su motivo de un enumerado cerrado. Eso cierra el
 * fallo mudo EN EL SERVIDOR. Falta la otra mitad: lo que el administrador lee.
 *
 * El modo de fallo peligroso no es desactivar de mas, sino de menos. Un administrador que lee
 * "18 tiendas desactivadas" da por contenida la fuga y se va; si las fallidas se suman con las
 * desactivadas, o las intactas se agrupan en un solo numero sin motivo, vuelve exactamente el
 * fallo que T32 acaba de cerrar — solo que ahora en la interfaz, y sin que nada se ponga rojo.
 * Y esta es la unica contencion que la spec reconoce ante un enlace filtrado (RF_41).
 *
 * Por eso el mapeo no puede vivir inline en `operations-app.tsx`: va en una funcion pura,
 * `buildBulkSignupDisableView`, y lo que sigue es su contrato. Los TIPOS del informe se
 * importan del nucleo (`import type`) y no se redeclaran: si los enumerados cambian, esto tiene
 * que enterarse por `tsc`, no por casualidad.
 */
import type {
  BulkSignupDisableFailureReason,
  BulkSignupDisableReport,
  BulkSignupDisableSkipReason
} from "../../functions/src/community-containment";
import {
  BULK_DISABLE_FAILURE_LABELS,
  BULK_DISABLE_SKIP_LABELS,
  buildBulkSignupDisableView
} from "./community-view";

const COM = "com-1";
const DESDE = "2026-09-01T00:00:00.000Z";
const HASTA = "2026-09-05T23:59:59.999Z";

const informeBase = (
  partes: Pick<BulkSignupDisableReport, "disabled" | "failed" | "untouched" | "blocked">
): BulkSignupDisableReport => ({
  communityId: COM,
  fromIso: DESDE,
  toIso: HASTA,
  collectionsTouched: ["sellers", "authUsers"],
  ...partes
});

/**
 * Un informe con los NUEVE motivos a la vez y los cuatro repartos de tamano distinto
 * (2 / 5 / 4 / 7): si alguien funde dos repartos o dos motivos, ningun numero cuadra por
 * casualidad. Fixture literal: no se calcula desde el plan, para que esta prueba no dependa
 * de que el nucleo siga comportandose igual.
 */
const informeCompleto = informeBase({
  disabled: [
    { sellerId: "seller-cerrada-a", authUids: ["uid-a1", "uid-a2"] },
    { sellerId: "seller-cerrada-b", authUids: ["uid-b1"] }
  ],
  failed: [
    { sellerId: "seller-sin-correo", reason: "no_contact_email" },
    { sellerId: "seller-busqueda-rota", reason: "auth_lookup_failed" },
    { sellerId: "seller-sin-cuenta", reason: "no_auth_user" },
    { sellerId: "seller-cierre-roto", reason: "auth_update_failed" },
    { sellerId: "seller-no-intentada", reason: "not_attempted" }
  ],
  untouched: [
    { sellerId: "seller-otra-comunidad", reason: "other_community" },
    { sellerId: "seller-fuera-de-rango", reason: "out_of_range" },
    { sellerId: "seller-sin-fecha", reason: "no_join_date" },
    { sellerId: "seller-fecha-rota", reason: "invalid_join_date" }
  ],
  blocked: [
    "seller-cerrada-a",
    "seller-cerrada-b",
    "seller-sin-correo",
    "seller-busqueda-rota",
    "seller-sin-cuenta",
    "seller-cierre-roto",
    "seller-no-intentada"
  ]
});

/**
 * El caso realista del desastre: veinte tiendas alcanzadas por el rango y NI UN acceso cerrado
 * (a Auth se le cayo la busqueda). Es el informe que no puede leerse como un exito.
 */
const veinteAlcanzadas = Array.from({ length: 20 }, (_, indice) => `seller-fuga-${indice + 1}`);
const informeSinContencion = informeBase({
  disabled: [],
  failed: veinteAlcanzadas.map((sellerId) => ({
    sellerId,
    reason: "auth_lookup_failed" as BulkSignupDisableFailureReason
  })),
  untouched: [],
  blocked: veinteAlcanzadas
});

/** El rango no alcanzo a nadie: todas quedaron fuera. Tampoco es una fuga contenida. */
const informeSinAlcance = informeBase({
  disabled: [],
  failed: [],
  untouched: [
    { sellerId: "seller-fuera-de-rango", reason: "out_of_range" },
    { sellerId: "seller-otra-comunidad", reason: "other_community" }
  ],
  blocked: []
});

/** La contencion que si salio entera. */
const informeLimpio = informeBase({
  disabled: [
    { sellerId: "seller-cerrada-a", authUids: ["uid-a1"] },
    { sellerId: "seller-cerrada-b", authUids: ["uid-b1"] }
  ],
  failed: [],
  untouched: [{ sellerId: "seller-otra-comunidad", reason: "other_community" }],
  blocked: ["seller-cerrada-a", "seller-cerrada-b"]
});

/** Los enumerados, en el orden en que se declaran en el nucleo. */
const MOTIVOS_DE_FALLO: BulkSignupDisableFailureReason[] = [
  "no_contact_email",
  "auth_lookup_failed",
  "no_auth_user",
  "auth_update_failed",
  "not_attempted"
];
const MOTIVOS_DE_EXCLUSION: BulkSignupDisableSkipReason[] = [
  "other_community",
  "out_of_range",
  "no_join_date",
  "invalid_join_date"
];

/** Recorre la vista entera: claves y valores, a cualquier profundidad. Igual que en T31/T32. */
const recorrerVista = (value: unknown, visit: (fragment: string) => void): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recorrerVista(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      recorrerVista(inner, visit);
    }
  }
};

/** Todos los identificadores de tienda que aparecen en una estructura, sin repetir. */
const idsDeTiendaEn = (value: unknown): string[] => {
  const vistos = new Set<string>();
  recorrerVista(value, (fragment) => {
    if (fragment.startsWith("seller-")) vistos.add(fragment);
  });
  return [...vistos].sort();
};

describe("T44 · el recuento de la desactivacion en bloque en pantalla", () => {
  it("RF_41: los cuatro repartos se cuentan por separado y ninguno se funde con otro", () => {
    const vista = buildBulkSignupDisableView(informeCompleto);
    expect(vista.counts).toEqual({ disabled: 2, failed: 5, untouched: 4, blocked: 7 });
    // Sin ningun contador de mas: un "total" o un "procesadas" es exactamente la forma que
    // toma el resumen que esta tarea prohibe. Si hace falta uno, que lo sume la pantalla.
    expect(Object.keys(vista.counts).sort()).toEqual(["blocked", "disabled", "failed", "untouched"]);
  });

  it("RF_41: un informe sin ni un acceso cerrado no puede parecer un exito", () => {
    // Veinte tiendas alcanzadas, veinte fallos, cero cierres. Si `disabled` y `failed` se
    // suman en cualquier punto del camino, el administrador lee "20 desactivadas" y se va.
    const vista = buildBulkSignupDisableView(informeSinContencion);
    expect(vista.counts.disabled).toBe(0);
    expect(vista.counts.failed).toBe(20);
    expect(vista.counts.blocked).toBe(20);
    expect(vista.disabled).toEqual([]);
    expect(vista.outcome).toBe("none");
  });

  it("RF_41: un rango que no alcanzo a ninguna tienda tampoco es una fuga contenida", () => {
    const vista = buildBulkSignupDisableView(informeSinAlcance);
    expect(vista.counts).toEqual({ disabled: 0, failed: 0, untouched: 2, blocked: 0 });
    expect(vista.outcome).toBe("none");
  });

  it("RF_41: con cierres y fallos a la vez la contencion es parcial, nunca completa", () => {
    expect(buildBulkSignupDisableView(informeCompleto).outcome).toBe("partial");
  });

  it("RF_41: solo sin un solo fallo se da la contencion por completa", () => {
    const vista = buildBulkSignupDisableView(informeLimpio);
    expect(vista.outcome).toBe("contained");
    // Que queden tiendas intactas NO impide la contencion: son las que el filtro dejo fuera
    // a proposito, no fallos. Confundirlas seria el error simetrico.
    expect(vista.counts.untouched).toBe(1);
  });

  it("RF_41: cada motivo de fallo se cuenta aparte, con las tiendas que le corresponden", () => {
    const vista = buildBulkSignupDisableView(informeCompleto);
    expect(vista.failures).toEqual([
      { reason: "no_contact_email", label: BULK_DISABLE_FAILURE_LABELS.no_contact_email, count: 1, sellerIds: ["seller-sin-correo"] },
      { reason: "auth_lookup_failed", label: BULK_DISABLE_FAILURE_LABELS.auth_lookup_failed, count: 1, sellerIds: ["seller-busqueda-rota"] },
      { reason: "no_auth_user", label: BULK_DISABLE_FAILURE_LABELS.no_auth_user, count: 1, sellerIds: ["seller-sin-cuenta"] },
      { reason: "auth_update_failed", label: BULK_DISABLE_FAILURE_LABELS.auth_update_failed, count: 1, sellerIds: ["seller-cierre-roto"] },
      { reason: "not_attempted", label: BULK_DISABLE_FAILURE_LABELS.not_attempted, count: 1, sellerIds: ["seller-no-intentada"] }
    ]);
    // Los cinco motivos, presentes de verdad y no colapsados: un `Record<Union,string>` avisa
    // en compilacion de un motivo nuevo, pero no impide que un contador agrupe dos en uno.
    expect(vista.failures).toHaveLength(MOTIVOS_DE_FALLO.length);
    expect(vista.failures.reduce((suma, grupo) => suma + grupo.count, 0)).toBe(vista.counts.failed);
  });

  it("RF_41: cada motivo de exclusion se cuenta aparte, con las tiendas que le corresponden", () => {
    const vista = buildBulkSignupDisableView(informeCompleto);
    expect(vista.skipped).toEqual([
      { reason: "other_community", label: BULK_DISABLE_SKIP_LABELS.other_community, count: 1, sellerIds: ["seller-otra-comunidad"] },
      { reason: "out_of_range", label: BULK_DISABLE_SKIP_LABELS.out_of_range, count: 1, sellerIds: ["seller-fuera-de-rango"] },
      { reason: "no_join_date", label: BULK_DISABLE_SKIP_LABELS.no_join_date, count: 1, sellerIds: ["seller-sin-fecha"] },
      { reason: "invalid_join_date", label: BULK_DISABLE_SKIP_LABELS.invalid_join_date, count: 1, sellerIds: ["seller-fecha-rota"] }
    ]);
    expect(vista.skipped).toHaveLength(MOTIVOS_DE_EXCLUSION.length);
    expect(vista.skipped.reduce((suma, grupo) => suma + grupo.count, 0)).toBe(vista.counts.untouched);
  });

  it("RF_41: varias tiendas con el mismo motivo se agrupan sin perder ninguna", () => {
    const repetido = informeBase({
      disabled: [],
      failed: [
        { sellerId: "seller-1", reason: "no_auth_user" },
        { sellerId: "seller-2", reason: "no_auth_user" },
        { sellerId: "seller-3", reason: "no_contact_email" }
      ],
      untouched: [],
      blocked: ["seller-1", "seller-2", "seller-3"]
    });
    const vista = buildBulkSignupDisableView(repetido);
    expect(vista.failures.map((grupo) => [grupo.reason, grupo.count])).toEqual([
      ["no_contact_email", 1],
      ["no_auth_user", 2]
    ]);
    expect(vista.failures.find((grupo) => grupo.reason === "no_auth_user")?.sellerIds).toEqual([
      "seller-1",
      "seller-2"
    ]);
    expect(vista.counts.failed).toBe(3);
  });

  it("RF_41: solo salen los motivos que ocurrieron, y en el orden en que se declaran", () => {
    // El orden es el del enumerado, no el del informe: si dependiera de como vinieran las
    // respuestas de Auth, la misma operacion se leeria distinta cada vez que se corre.
    const desordenado = informeBase({
      disabled: [],
      failed: [
        { sellerId: "seller-tarde", reason: "not_attempted" },
        { sellerId: "seller-pronto", reason: "no_contact_email" }
      ],
      untouched: [
        { sellerId: "seller-fecha-rota", reason: "invalid_join_date" },
        { sellerId: "seller-otra-comunidad", reason: "other_community" }
      ],
      blocked: ["seller-tarde", "seller-pronto"]
    });
    const vista = buildBulkSignupDisableView(desordenado);
    expect(vista.failures.map((grupo) => grupo.reason)).toEqual(["no_contact_email", "not_attempted"]);
    expect(vista.skipped.map((grupo) => grupo.reason)).toEqual(["other_community", "invalid_join_date"]);
  });

  it("RF_41: los nueve motivos tienen rotulo propio en espanol, y ninguno repite texto", () => {
    // Agrupar dos motivos bajo el mismo texto es resumir por la puerta de atras: el numero
    // sigue partido pero el administrador lee lo mismo dos veces y no sabe que hacer.
    expect(Object.keys(BULK_DISABLE_FAILURE_LABELS)).toEqual(MOTIVOS_DE_FALLO);
    expect(Object.keys(BULK_DISABLE_SKIP_LABELS)).toEqual(MOTIVOS_DE_EXCLUSION);

    const rotulos = [
      ...MOTIVOS_DE_FALLO.map((motivo) => BULK_DISABLE_FAILURE_LABELS[motivo]),
      ...MOTIVOS_DE_EXCLUSION.map((motivo) => BULK_DISABLE_SKIP_LABELS[motivo])
    ];
    expect(rotulos).toHaveLength(9);
    expect(new Set(rotulos).size).toBe(9);
    for (const rotulo of rotulos) {
      expect(rotulo.trim()).toBe(rotulo);
      expect(rotulo.length).toBeGreaterThan(3);
      // Ni el identificador crudo ni nada que se le parezca: `no_auth_user` no es un rotulo.
      expect(rotulo).not.toMatch(/_/);
    }
    const identificadores: string[] = [...MOTIVOS_DE_FALLO, ...MOTIVOS_DE_EXCLUSION];
    for (const identificador of identificadores) {
      expect(rotulos).not.toContain(identificador);
    }
  });

  it("RF_41: el rotulo de cada grupo es el del mapa, para que no puedan divergir", () => {
    const vista = buildBulkSignupDisableView(informeCompleto);
    for (const grupo of vista.failures) {
      expect(grupo.label).toBe(BULK_DISABLE_FAILURE_LABELS[grupo.reason]);
    }
    for (const grupo of vista.skipped) {
      expect(grupo.label).toBe(BULK_DISABLE_SKIP_LABELS[grupo.reason]);
    }
  });

  it("RF_41: los accesos cerrados se muestran uno a uno, no reducidos a un numero", () => {
    // Una tienda puede tener mas de un usuario de Auth con su correo. El informe los devuelve
    // en crudo (T32) y la vista no es quien para resumirlos.
    const vista = buildBulkSignupDisableView(informeCompleto);
    expect(vista.disabled).toEqual(informeCompleto.disabled);
    expect(vista.disabled[0].authUids).toEqual(["uid-a1", "uid-a2"]);
  });

  it("RF_41: no se pierde ninguna tienda: todas las del informe aparecen en la vista", () => {
    // El barrido no mira campo por campo a proposito: recorre la vista entera. Un reparto
    // nuevo que alguien se olvide de pintar tambien tendra que aparecer aqui.
    const vista = buildBulkSignupDisableView(informeCompleto);
    expect(idsDeTiendaEn(vista)).toEqual(idsDeTiendaEn(informeCompleto));
  });

  it("RF_41: la vista devuelve la comunidad y el rango con los que se calculo, para auditarlo", () => {
    const vista = buildBulkSignupDisableView(informeCompleto);
    expect(vista.communityId).toBe(COM);
    expect(vista.fromIso).toBe(DESDE);
    expect(vista.toIso).toBe(HASTA);
  });

  it("RF_42: lo que se pinta no nombra pedidos, asientos de wallet, cortes ni inventario", () => {
    // Mismo enfoque que los barridos de `community-containment.test.ts`: la estructura entera,
    // claves y valores a cualquier profundidad, rotulos incluidos. El historial de dinero de
    // esas cuentas queda intacto y la pantalla de la contencion no tiene por que mencionarlo
    // — ni para explicar un fallo.
    const intocable = /order|wallet|settlement|liquidac|pedido|inventor|stock|cashback|payout|remittance|ledger/i;
    const encontrados: string[] = [];
    recorrerVista(buildBulkSignupDisableView(informeCompleto), (fragment) => {
      if (intocable.test(fragment)) encontrados.push(fragment);
    });
    expect(encontrados).toEqual([]);
  });

  it("RF_42: lo que se pinta no anuncia ningun borrado, ni hoy ni cuando alguien lo amplie", () => {
    // RF_42 dice que no se borra nada. Un rotulo que diga "eliminadas" es la misma mentira que
    // un contador mal sumado: el administrador cree que paso algo que no paso.
    const prohibido = /delete|remove|destroy|purge|erase|drop|wipe|clear|truncate|borr|elimin|anul/i;
    const encontrados: string[] = [];
    recorrerVista(buildBulkSignupDisableView(informeCompleto), (fragment) => {
      if (prohibido.test(fragment)) encontrados.push(fragment);
    });
    expect(encontrados).toEqual([]);
  });
});

/**
 * T40 · Rechazar un logo NO puede costar el que ya tenias (RF_16).
 *
 * Arriba, en "T13, T15 · marca visible y logo", ya se prueba la mitad facil de RF_16: que
 * `validateLogo` dice que no a un GIF y a un archivo de mas de 512 KB. Falta la otra mitad, que
 * es la que escribe el requisito entero:
 *
 *   RF_16: "...el sistema MUST rechazarlo indicando el limite concreto y MUST conservar el logo
 *   anterior."
 *
 * Y el caso limite de la spec lo dice con todas las letras: "Logo enorme o corrupto. Se rechaza
 * y se conserva el anterior (RF_16); nunca una pantalla de registro con la imagen rota."
 *
 * El modo de fallo es el mismo que en RF_04 y por eso las dos mitades de T40 van juntas: un
 * rechazo que ademas deja a la comunidad SIN logo le borra la marca de la pantalla de registro
 * y del panel de sus tiendas (RF_14), y `brandFor` cae a la marca de la plataforma (RF_15). No
 * es un error visible: es la comunidad convertida en Kentro sin que nadie se entere.
 *
 * Hoy `setCommunityLogo` (functions/src/communities.ts:189) conserva el anterior por lo que NO
 * hace: el `throw new HttpsError` sale antes del `update`. Igual que con el slug, eso es cierto
 * de la forma de hoy y de ninguna otra — un `update({ logoPath })` movido dos lineas arriba, o
 * un borrado del objeto viejo en Storage "antes de subir el nuevo", y `validateLogo` seguiria
 * verde mientras la marca desaparece.
 *
 * De ahi el mismo instrumento: `planLogoChange`, plan puro, con las escrituras como dato para
 * poder barrer la estructura entera. La forma es deliberadamente la MISMA que la de
 * `planSlugChange` (`ok` / `reasonCode` / `reason` / `previous*` / `effective*` / `writes`),
 * porque el requisito es el mismo y dos formas distintas para la misma regla es como se
 * desincronizan.
 */
import { LOGO_CONTENT_TYPES } from "../../functions/src/community-pricing";

type LogoWrite = {
  collection: "communities";
  docId: string;
  op: "update";
  data: Record<string, string>;
};

type LogoChangeRejection = {
  ok: false;
  /** Los dos motivos que nombra RF_16, distinguibles sin leer prosa. */
  reasonCode: "unsupported_format" | "too_large" | "missing_file";
  /** El motivo en castellano, con el limite CONCRETO dentro: RF_16 lo exige. */
  reason: string;
  previousLogoPath: string | null;
  /** El logo que queda VIGENTE tras la operacion. En un rechazo es, por fuerza, el anterior. */
  effectiveLogoPath: string | null;
  writes: readonly LogoWrite[];
};

type LogoChangeAcceptance = {
  ok: true;
  previousLogoPath: string | null;
  effectiveLogoPath: string;
  changed: boolean;
  writes: readonly LogoWrite[];
};

type LogoChangePlan = LogoChangeRejection | LogoChangeAcceptance;

type LogoChangeInput = {
  community: { id: string; logoPath?: string };
  file: { logoPath: string; contentType: string; sizeBytes: number };
  nowIso: string;
};

type PlanLogoChange = (input: LogoChangeInput) => LogoChangePlan;

/**
 * Carga diferida por lo mismo que en T36 y en el bloque T40 de community-slug.test.ts:
 * `community-pricing.ts` ya existe y este archivo lo importa de forma estatica arriba, asi que
 * pedirle un export que todavia no esta es un error de ENLACE de ESM y tumbaria la recoleccion
 * del archivo entero, llevandose por delante los 22 casos que ya estan verdes.
 */
let planLogoChange: PlanLogoChange;

const cargarPlanLogo = async (): Promise<void> => {
  const modulo = (await import("../../functions/src/community-pricing")) as unknown as {
    planLogoChange?: PlanLogoChange;
  };
  if (!modulo.planLogoChange) {
    throw new Error("T40: functions/src/community-pricing.ts debe exportar `planLogoChange`.");
  }
  planLogoChange = modulo.planLogoChange;
};

/** Recorre la estructura ENTERA: claves y valores de texto, a cualquier profundidad. */
const recorrerPlanLogo = (
  value: unknown,
  visit: (fragment: string) => void,
  saltar: ReadonlySet<string>
): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recorrerPlanLogo(item, visit, saltar);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      if (!saltar.has(key)) recorrerPlanLogo(inner, visit, saltar);
    }
  }
};

/** `reason` es prosa para el lider y menciona formatos y limites; el barrido no la mira. */
const PROSA_LOGO: ReadonlySet<string> = new Set(["reason"]);

const fragmentosDelPlanLogo = (plan: unknown, prohibido: RegExp): string[] => {
  const encontrados: string[] = [];
  recorrerPlanLogo(
    plan,
    (fragment) => {
      if (prohibido.test(fragment)) encontrados.push(fragment);
    },
    PROSA_LOGO
  );
  return encontrados;
};

const ORDEN_SOBRE_EL_LOGO =
  /collection|docId|firestore|transaction|batch|storage|bucket|\bset\b|\bupdate\b|\bmerge\b|delete|remove|unlink|escrib|guard|borr|elimin/i;

const HOY = "2026-09-10T12:00:00.000Z";
const LOGO_VIGENTE = "communities/com-1/logo-andes.png";
const CON_LOGO = { id: "com-1", logoPath: LOGO_VIGENTE };

const logoBueno = { logoPath: "communities/com-1/logo-nuevo.webp", contentType: "image/webp", sizeBytes: 90_000 };

const rechazoLogo = (plan: LogoChangePlan): LogoChangeRejection => {
  if (plan.ok) throw new Error(`Se esperaba un rechazo y el plan acepto: ${JSON.stringify(plan)}`);
  return plan;
};

const aceptacionLogo = (plan: LogoChangePlan): LogoChangeAcceptance => {
  if (!plan.ok) throw new Error(`Se esperaba una aceptacion y el plan rechazo: ${plan.reason}`);
  return plan;
};

describe("T40 · rechazar un logo conserva el anterior", () => {
  beforeEach(cargarPlanLogo);

  it("RF_16: un formato no soportado se rechaza, con el limite concreto, y deja el logo anterior", () => {
    for (const contentType of ["image/gif", "application/pdf", "image/bmp", "text/html"]) {
      const plan = rechazoLogo(
        planLogoChange({
          community: CON_LOGO,
          file: { logoPath: "communities/com-1/logo-nuevo.gif", contentType, sizeBytes: 1_000 },
          nowIso: HOY
        })
      );
      expect(plan.reasonCode).toBe("unsupported_format");
      // "Indicando el limite concreto": el motivo tiene que decir que SI se admite, no solo que
      // esto no. Un "formato no valido" a secas deja al lider probando extensiones a ciegas.
      expect(plan.reason).toContain(LOGO_CONTENT_TYPES[0]);
      expect(plan.previousLogoPath).toBe(LOGO_VIGENTE);
      expect(plan.effectiveLogoPath).toBe(LOGO_VIGENTE);
      expect(plan.writes).toEqual([]);
    }
  });

  it("RF_16: un archivo fuera de tamano se rechaza, con el limite concreto, y deja el logo anterior", () => {
    const plan = rechazoLogo(
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: "communities/com-1/enorme.png", contentType: "image/png", sizeBytes: LOGO_MAX_BYTES + 1 },
        nowIso: HOY
      })
    );
    expect(plan.reasonCode).toBe("too_large");
    // El limite en KB, tal cual, dentro del texto.
    expect(plan.reason).toContain(String(Math.round(LOGO_MAX_BYTES / 1024)));
    expect(plan.previousLogoPath).toBe(LOGO_VIGENTE);
    expect(plan.effectiveLogoPath).toBe(LOGO_VIGENTE);
    expect(plan.writes).toEqual([]);

    // Justo en el limite si entra: el rechazo empieza en el byte siguiente, no antes.
    const alBorde = aceptacionLogo(
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: "communities/com-1/justo.png", contentType: "image/png", sizeBytes: LOGO_MAX_BYTES },
        nowIso: HOY
      })
    );
    expect(alBorde.effectiveLogoPath).toBe("communities/com-1/justo.png");
  });

  it("RF_16: los dos motivos son distinguibles entre si, en codigo y en texto", () => {
    // Se arreglan de forma distinta: uno reexportando la imagen, el otro comprimiendola.
    const formato = rechazoLogo(
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: "communities/com-1/x.gif", contentType: "image/gif", sizeBytes: 1_000 },
        nowIso: HOY
      })
    );
    const tamano = rechazoLogo(
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: "communities/com-1/x.png", contentType: "image/png", sizeBytes: LOGO_MAX_BYTES + 1 },
        nowIso: HOY
      })
    );
    expect(formato.reasonCode).not.toBe(tamano.reasonCode);
    expect(formato.reason).not.toBe(tamano.reason);
    expect(formato.reason.trim().length).toBeGreaterThan(0);
    expect(tamano.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_16: el rechazo no ordena NINGUNA escritura, en ninguna parte del plan", () => {
    // Barrido sobre el resultado entero, igual que en RF_04: aqui lo que se vigila ademas de
    // Firestore es Storage, porque "limpiar el logo viejo antes de subir el nuevo" es
    // exactamente la clase de mejora que borraria la marca en un rechazo.
    const rechazos = [
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: "communities/com-1/x.gif", contentType: "image/gif", sizeBytes: 1_000 },
        nowIso: HOY
      }),
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: "communities/com-1/x.png", contentType: "image/png", sizeBytes: LOGO_MAX_BYTES + 1 },
        nowIso: HOY
      })
    ];
    for (const plan of rechazos) {
      const rechazado = rechazoLogo(plan);
      expect(rechazado.writes).toHaveLength(0);
      expect(fragmentosDelPlanLogo(rechazado, ORDEN_SOBRE_EL_LOGO)).toEqual([]);
    }
  });

  it("RF_16, RF_14: un logo valido si sustituye al anterior, y solo escribe eso", () => {
    const plan = aceptacionLogo(planLogoChange({ community: CON_LOGO, file: logoBueno, nowIso: HOY }));
    expect(plan.changed).toBe(true);
    expect(plan.previousLogoPath).toBe(LOGO_VIGENTE);
    expect(plan.effectiveLogoPath).toBe(logoBueno.logoPath);
    expect(plan.writes).toHaveLength(1);
    const [write] = plan.writes;
    expect(write.collection).toBe("communities");
    expect(write.docId).toBe("com-1");
    expect(write.op).toBe("update");
    // `toEqual` sobre las claves: lo que se afirma es que no hay un tercer campo. Un lider no
    // toca dinero, y este plan no puede convertirse en la puerta por la que se escriba otra cosa.
    expect(Object.keys(write.data).sort()).toEqual(["logoPath", "updatedAt"]);
    expect(write.data).toEqual({ logoPath: logoBueno.logoPath, updatedAt: HOY });
  });

  it("RF_16: los cuatro formatos admitidos se aceptan, para que la lista y el plan no diverjan", () => {
    for (const contentType of LOGO_CONTENT_TYPES) {
      const plan = aceptacionLogo(
        planLogoChange({
          community: CON_LOGO,
          file: { logoPath: `communities/com-1/logo.${contentType}`, contentType, sizeBytes: 10_000 },
          nowIso: HOY
        })
      );
      expect(plan.effectiveLogoPath).toBe(`communities/com-1/logo.${contentType}`);
    }
  });

  it("RF_16, RF_15: un archivo ausente o vacio se rechaza sin borrar el logo que ya habia", () => {
    // Un `logoPath` en blanco o un tamano de cero bytes es un formulario enviado a medias o una
    // subida cortada. Escribirlo dejaria `brandFor` cayendo a la marca de la plataforma (RF_15)
    // con el logo del lider perdido: exactamente la pantalla que RF_16 quiere evitar.
    const vacios = [
      { logoPath: "   ", contentType: "image/png", sizeBytes: 10_000 },
      { logoPath: "", contentType: "image/png", sizeBytes: 10_000 },
      { logoPath: "communities/com-1/vacio.png", contentType: "image/png", sizeBytes: 0 }
    ];
    for (const file of vacios) {
      const plan = rechazoLogo(planLogoChange({ community: CON_LOGO, file, nowIso: HOY }));
      expect(plan.reasonCode).toBe("missing_file");
      expect(plan.effectiveLogoPath).toBe(LOGO_VIGENTE);
      expect(plan.writes).toEqual([]);
    }
  });

  it("RF_16: una comunidad sin logo no tiene nada que conservar, y el rechazo no lo inventa", () => {
    const sinLogo = { id: "com-2" };
    const rechazado = rechazoLogo(
      planLogoChange({
        community: sinLogo,
        file: { logoPath: "communities/com-2/x.gif", contentType: "image/gif", sizeBytes: 1_000 },
        nowIso: HOY
      })
    );
    expect(rechazado.previousLogoPath).toBeNull();
    expect(rechazado.effectiveLogoPath).toBeNull();
    // Sigue sin logo, que es lo correcto: RF_15 pinta la marca de la plataforma, no un hueco.
    expect(brandFor({ name: "Comunidad Nueva", logoPath: rechazado.effectiveLogoPath ?? undefined }).kind).toBe(
      "platform"
    );
    expect(rechazado.writes).toEqual([]);

    const aceptado = aceptacionLogo(planLogoChange({ community: sinLogo, file: logoBueno, nowIso: HOY }));
    expect(aceptado.previousLogoPath).toBeNull();
    expect(aceptado.effectiveLogoPath).toBe(logoBueno.logoPath);
  });

  it("RF_16: subir el mismo logo que ya se tiene no es un rechazo ni pierde la marca", () => {
    const plan = aceptacionLogo(
      planLogoChange({
        community: CON_LOGO,
        file: { logoPath: LOGO_VIGENTE, contentType: "image/png", sizeBytes: 40_000 },
        nowIso: HOY
      })
    );
    expect(plan.changed).toBe(false);
    expect(plan.effectiveLogoPath).toBe(LOGO_VIGENTE);
    expect(plan.writes).toEqual([]);
  });
});

/**
 * T41 · Una comunidad sin tiendas ensena su enlace de invitacion, no un panel muerto (RF_32).
 *
 *   RF_32: "...el panel MUST mostrar las cifras en cero y el enlace de invitacion, y MUST NOT
 *   quedarse en blanco."
 *
 * De ese requisito ya hay media prueba en `community-stats.test.ts` (T20/T24): un cero real se
 * distingue de "todavia no hay datos". Aqui va la otra mitad, que es el enlace — y que hoy no
 * existe como codigo que se pueda probar: la unica forma del enlace en toda la plataforma esta
 * dentro del JSX (`operations-app.tsx:4332`),
 *
 *     `${window.location.origin}/registro/${communitySlug(state, communityId)}`
 *
 * o sea una plantilla montada durante el pintado, con `window` dentro. De ahi salen los dos modos
 * de fallo de esta tarea:
 *
 *   - Una comunidad recien creada, todavia sin slug, produce `/registro/undefined`. Es un enlace
 *     que se puede copiar, mandar por WhatsApp y abrir: lleva a una pantalla de registro que no
 *     resuelve ninguna comunidad. El lider no tiene forma de saber que reparte una ruta rota.
 *   - Y es justo la comunidad SIN TIENDAS —la que RF_32 describe— la que mas probablemente aun no
 *     tiene slug, porque nunca ha pasado por la pantalla que lo fija.
 *
 * Por eso el nucleo produce la RUTA (`/registro/<slug>`) y no la URL: una funcion pura no puede
 * leer `window`, y el origen lo antepone la pantalla, que si vive en el navegador. Lo que se
 * afirma aqui es que sin slug no hay ruta que repartir, y que la vista vacia lleva el enlace al
 * lado de los ceros.
 *
 * Contrato:
 *   export function communityInvitePath(community: { slug?: string | null }): string | null;
 *   export function buildEmptyCommunityView(
 *     community: { slug?: string | null },
 *     stats: CommunityStats
 *   ): { hasStores: boolean; totals: CommunityStats["totals"]; invitePath: string | null };
 */

import { buildCommunityStats } from "../../functions/src/community-stats-math";
import type { CommunityStats, RawCommunityAggregates } from "../../functions/src/community-stats-math";

type EmptyCommunityView = {
  hasStores: boolean;
  totals: CommunityStats["totals"];
  invitePath: string | null;
};

type CommunityInvitePath = (community: { slug?: string | null }) => string | null;
type BuildEmptyCommunityView = (
  community: { slug?: string | null },
  stats: CommunityStats
) => EmptyCommunityView;

/**
 * Carga diferida, por lo mismo que en el bloque T40 de mas arriba: este archivo ya importa
 * `./community-view` de forma estatica, asi que pedirle un export que todavia no esta seria un
 * error de ENLACE de ESM y tumbaria la recoleccion entera, llevandose por delante los 31 casos que
 * ya estan verdes.
 */
let communityInvitePath: CommunityInvitePath;
let buildEmptyCommunityView: BuildEmptyCommunityView;

const cargarVistaDeComunidadVacia = async (): Promise<void> => {
  const modulo = (await import("./community-view")) as unknown as {
    communityInvitePath?: CommunityInvitePath;
    buildEmptyCommunityView?: BuildEmptyCommunityView;
  };
  if (!modulo.communityInvitePath || !modulo.buildEmptyCommunityView) {
    throw new Error(
      "T41: src/lib/community-view.ts debe exportar `communityInvitePath` y `buildEmptyCommunityView`."
    );
  }
  communityInvitePath = modulo.communityInvitePath;
  buildEmptyCommunityView = modulo.buildEmptyCommunityView;
};

/** Una comunidad recien creada: ni una tienda, ni un pedido, ni un peso de cashback. */
const SIN_NINGUNA_TIENDA: RawCommunityAggregates = {
  storeCount: 0,
  createdByStore: {},
  dispatchedByStore: {},
  deliveredByStore: {},
  failedByStore: {},
  cashbackAccruedCop: 0,
  cashbackPaidCop: 0,
  ordersWithoutCashbackByZoneFloor: 0
};

/**
 * Las cifras se toman del nucleo que ya las calcula, no se copian a mano: la aritmetica del cero
 * es de T20/T24 y aqui no se vuelve a probar. Lo que se prueba es que la vista vacia las lleva.
 */
const estadisticasEnCero = (): CommunityStats => buildCommunityStats(SIN_NINGUNA_TIENDA);

describe("T41 · la comunidad sin tiendas ensena su enlace de invitacion", () => {
  beforeEach(cargarVistaDeComunidadVacia);

  it("RF_32: una comunidad sin ninguna tienda muestra las cifras en cero Y el enlace", () => {
    const stats = estadisticasEnCero();
    const vista = buildEmptyCommunityView({ slug: "comunidad-andes" }, stats);
    expect(vista.hasStores).toBe(false);
    // Las cifras, tal cual las calcula el nucleo: la vista no las reinterpreta ni las esconde
    // porque sean cero, que es como el panel se queda en blanco.
    expect(vista.totals).toEqual(stats.totals);
    // Y el enlace al lado: es lo unico accionable que tiene un lider sin tiendas.
    expect(vista.invitePath).toBe("/registro/comunidad-andes");
  });

  it("RF_32: el enlace es el de SU comunidad, no el de otra", () => {
    // Repartir el enlace de otra comunidad manda las tiendas captadas al lider equivocado, y el
    // cashback se le causa a quien no las trajo. Un solo `slug` de mas en el alcance de un render
    // basta para eso, y no hay nada en pantalla que lo delate.
    expect(communityInvitePath({ slug: "comunidad-andes" })).toBe("/registro/comunidad-andes");
    expect(communityInvitePath({ slug: "comunidad-pacifico" })).toBe("/registro/comunidad-pacifico");
    expect(communityInvitePath({ slug: "comunidad-andes" })).not.toBe(
      communityInvitePath({ slug: "comunidad-pacifico" })
    );

    const vista = buildEmptyCommunityView({ slug: "comunidad-pacifico" }, estadisticasEnCero());
    expect(vista.invitePath).toBe("/registro/comunidad-pacifico");
    expect(vista.invitePath).not.toContain("comunidad-andes");
  });

  it("RF_32: sin slug todavia no hay enlace que repartir, y NUNCA '/registro/undefined'", () => {
    // EL CASO QUE MAS IMPORTA, y el que produce hoy la plantilla del JSX. Una comunidad sin
    // tiendas es justo la que puede no tener slug aun.
    for (const community of [{}, { slug: undefined }, { slug: null }, { slug: "" }, { slug: "   " }]) {
      expect(communityInvitePath(community)).toBeNull();
      const vista = buildEmptyCommunityView(community, estadisticasEnCero());
      expect(vista.invitePath).toBeNull();
      // Sin slug la comunidad sigue siendo una comunidad vacia legitima: las cifras en cero se
      // pintan igual. Faltar el enlace no puede dejar el panel en blanco (RF_32).
      expect(vista.hasStores).toBe(false);
      expect(vista.totals).toEqual(estadisticasEnCero().totals);
      // Aserto explicito sobre el TEXTO, y sobre la vista entera: ni un fragmento, a ninguna
      // profundidad, puede contener una ruta rota. `toBeNull()` sobre `invitePath` no lo cubre —
      // el enlace roto tambien puede colarse como rotulo, como texto para copiar o como `href`.
      const rotos: string[] = [];
      recorrerVista(vista, (fragment) => {
        if (/undefined|\bnull\b|\/registro\//i.test(fragment)) rotos.push(fragment);
      });
      expect(rotos).toEqual([]);
    }
  });

  it("RF_32: un slug con espacios alrededor da una ruta limpia, no una con el espacio dentro", () => {
    // Un espacio de mas al final del slug produce `/registro/comunidad-andes ` — que al copiarlo a
    // WhatsApp se rompe o se escapa a `%20`, y deja de resolver la comunidad. Misma familia que el
    // `/registro/undefined`: un enlace que parece bueno y no lleva a ninguna parte.
    for (const slug of ["  comunidad-andes", "comunidad-andes  ", "  comunidad-andes  ", "\tcomunidad-andes\n"]) {
      expect(communityInvitePath({ slug })).toBe("/registro/comunidad-andes");
    }
    expect(buildEmptyCommunityView({ slug: " comunidad-andes " }, estadisticasEnCero()).invitePath).toBe(
      "/registro/comunidad-andes"
    );
  });

  it("RF_32: lo que devuelve es una RUTA, no una URL: el origen lo pone la pantalla", () => {
    // El nucleo es puro y no puede leer `window.location.origin` (hoy la plantilla del JSX si lo
    // hace). Que devuelva ruta y no URL es lo que permite probarlo aqui y lo que evita que una
    // funcion de dominio quede atada al navegador.
    const ruta = communityInvitePath({ slug: "comunidad-andes" });
    expect(ruta).toBe("/registro/comunidad-andes");
    expect(ruta?.startsWith("/")).toBe(true);
    expect(ruta).not.toMatch(/^https?:|localhost|web\.app|window|origin/i);
    expect(communityInvitePath.length).toBe(1);
  });
});

describe("T33 · cashback causado frente a cashback pagado", () => {
  // RF_49: el cashback solo pasa de causado a pagado cuando el corte del lider se marca pagado.
  // El reparto vive hoy INLINE en operations-app.tsx (~4313), dentro de un render de 7.5k lineas:
  // sin nucleo puro no hay nada que probar y un filtro de mas se cuela sin que nadie lo vea.
  // Lo que NO se cubre aqui es "nadie mas puede marcarlo pagado": esa autorizacion esta en
  // functions/src/orders.ts, que importa firebase-admin y no se puede cargar desde la raiz.
  type SettlementLike = { kind: string; ownerId: string; status: string; netCop: number };
  type CommunityCashbackPaidCop = (settlements: SettlementLike[], communityId: string) => number;

  let communityCashbackPaidCop: CommunityCashbackPaidCop;
  let buildCommunityStats: typeof import("../../functions/src/community-stats-math").buildCommunityStats;

  // Carga diferida: `communityCashbackPaidCop` todavia no existe, y un import estatico roto
  // tumbaria la recoleccion de los 36 casos verdes de este archivo.
  beforeEach(async () => {
    const vista = (await import("./community-view")) as unknown as {
      communityCashbackPaidCop: CommunityCashbackPaidCop;
    };
    communityCashbackPaidCop = vista.communityCashbackPaidCop;
    ({ buildCommunityStats } = await import("../../functions/src/community-stats-math"));
  });

  const corte = (over: Partial<SettlementLike> = {}): SettlementLike => ({
    kind: "community_leader",
    ownerId: "com-1",
    status: "pending",
    netCop: 10000,
    ...over
  });

  it("RF_49: un corte pendiente NO suma: el cashback sigue causado y pendiente de pago", () => {
    // El caso que mas importa. Contar lo pendiente como pagado le dice al lider que ya cobro un
    // dinero que sigue en la plataforma, y la conversacion que sigue es un reclamo.
    expect(communityCashbackPaidCop([corte({ netCop: 42000 })], "com-1")).toBe(0);
    expect(communityCashbackPaidCop([corte({ netCop: 42000 }), corte({ netCop: 8000 })], "com-1")).toBe(0);
  });

  it("RF_49: al marcar pagado el corte, su neto pasa a pagado", () => {
    expect(communityCashbackPaidCop([corte({ status: "paid", netCop: 42000 })], "com-1")).toBe(42000);
    expect(
      communityCashbackPaidCop(
        [corte({ status: "paid", netCop: 42000 }), corte({ status: "pending", netCop: 8000 })],
        "com-1"
      )
    ).toBe(42000);
  });

  it("RF_49: 'reconciled' tambien esta pagado: conciliar es un paso DESPUES de pagar", () => {
    // Solo hay tres estados (pending | paid | reconciled). Filtrar unicamente por "paid" haria
    // que el pagado del lider BAJARA solo a base de conciliar cortes ya girados.
    expect(communityCashbackPaidCop([corte({ status: "reconciled", netCop: 30000 })], "com-1")).toBe(30000);
    expect(
      communityCashbackPaidCop(
        [
          corte({ status: "paid", netCop: 12000 }),
          corte({ status: "reconciled", netCop: 30000 }),
          corte({ status: "pending", netCop: 99000 })
        ],
        "com-1"
      )
    ).toBe(42000);
  });

  it("RF_49: solo cuenta lo de ESA comunidad", () => {
    const cortes = [
      corte({ status: "paid", netCop: 12000 }),
      corte({ status: "paid", ownerId: "com-2", netCop: 500000 })
    ];
    expect(communityCashbackPaidCop(cortes, "com-1")).toBe(12000);
    expect(communityCashbackPaidCop(cortes, "com-2")).toBe(500000);
    expect(communityCashbackPaidCop(cortes, "com-3")).toBe(0);
  });

  it("RF_49: un corte de tienda o de domiciliario con el mismo ownerId no se cuela", () => {
    // `ownerId` no es unico entre colecciones de cortes: un seller y una comunidad pueden
    // compartir id. Filtrar por ownerId sin filtrar por `kind` le paga al lider el corte de una
    // tienda entera, que es un orden de magnitud mayor.
    const cortes = [
      corte({ status: "paid", netCop: 12000 }),
      corte({ kind: "seller", status: "paid", netCop: 1800000 }),
      corte({ kind: "driver", status: "paid", netCop: 260000 }),
      corte({ kind: "supplier", status: "reconciled", netCop: 90000 })
    ];
    expect(communityCashbackPaidCop(cortes, "com-1")).toBe(12000);
  });

  it("RF_49: un neto ausente, nulo o no numerico no envenena la suma con NaN", () => {
    // Un NaN no rompe la pantalla: la pinta con "NaN" o con un guion donde iba el dinero del
    // lider. Los cortes viejos pueden no traer netCop, y Firestore devuelve lo que se escribio.
    const cortes = [
      corte({ status: "paid", netCop: 12000 }),
      { kind: "community_leader", ownerId: "com-1", status: "paid" } as unknown as SettlementLike,
      { kind: "community_leader", ownerId: "com-1", status: "paid", netCop: null } as unknown as SettlementLike,
      { kind: "community_leader", ownerId: "com-1", status: "paid", netCop: "8000" } as unknown as SettlementLike,
      { kind: "community_leader", ownerId: "com-1", status: "paid", netCop: "no-es-plata" } as unknown as SettlementLike
    ];
    const total = communityCashbackPaidCop(cortes, "com-1");
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(20000);
    expect(communityCashbackPaidCop([], "com-1")).toBe(0);
  });

  it("RF_49: causado y pagado son DOS cifras distintas: lo causado no se sustituye por lo pagado", () => {
    // El causado sale de los asientos del periodo; el pagado, de los cortes marcados pagados.
    // Si el panel los iguala, el lider deja de ver lo que le deben.
    const pagado = communityCashbackPaidCop(
      [corte({ status: "paid", netCop: 30000 }), corte({ status: "pending", netCop: 90000 })],
      "com-1"
    );
    const stats = buildCommunityStats({
      storeCount: 2,
      createdByStore: { "s-1": 10 },
      dispatchedByStore: { "s-1": 9 },
      deliveredByStore: { "s-1": 8 },
      failedByStore: { "s-1": 1 },
      cashbackAccruedCop: 120000,
      cashbackPaidCop: pagado
    });
    expect(stats.totals.cashbackAccruedCop).toBe(120000);
    expect(stats.totals.cashbackPaidCop).toBe(30000);
    expect(stats.totals.cashbackAccruedCop).not.toBe(stats.totals.cashbackPaidCop);
    // Lo que queda por pagar es la diferencia, y no puede ser negativo por un filtro de mas.
    expect(stats.totals.cashbackAccruedCop - stats.totals.cashbackPaidCop).toBe(90000);
  });
});

describe("T43 · filas de liquidacion del lider de comunidad", () => {
  // RF_49: `createSettlement` ya acepta `kind: "community_leader"`, pero la pantalla de
  // liquidaciones no sabe construir esa fila: `LiquidationRow` (operations-app.tsx ~6404) solo
  // contempla "seller" | "driver", y `createFirebaseSettlement` (auth.ts ~423) solo acepta
  // "seller" | "driver" | "supplier". Mientras no exista el constructor de filas, el "pagado"
  // del lider que T33 ya sabe sumar es CERO POR CONSTRUCCION: no hay ningun corte que sumar.
  // El nucleo va puro y aparte (como `buildSupplierLiquidationRows`, ~6832) en vez de ensanchar
  // el tipo comun, que obligaria a tocar todas las ramas que hacen `row.role === "seller"`.
  type CommunityLike = { id: string; name: string; leaderName?: string };
  type EntryLike = {
    id: string;
    ownerType: string;
    ownerId: string;
    type: string;
    amountCop: number;
    orderId?: string;
    settlementId?: string;
  };
  type CommunityLeaderLiquidationRow = {
    communityId: string;
    communityName: string;
    leaderName: string;
    walletEntryIds: string[];
    orderIds: string[];
    orders: number;
    cashbackCop: number;
  };
  type BuildRows = (
    communities: CommunityLike[],
    entries: EntryLike[]
  ) => CommunityLeaderLiquidationRow[];

  let buildCommunityLeaderLiquidationRows: BuildRows;

  // Carga diferida: la funcion todavia no existe y un import estatico roto tumbaria la
  // recoleccion de los 43 casos verdes de este archivo.
  beforeEach(async () => {
    const vista = (await import("./community-view")) as unknown as {
      buildCommunityLeaderLiquidationRows?: BuildRows;
    };
    if (typeof vista.buildCommunityLeaderLiquidationRows !== "function") {
      throw new Error(
        "buildCommunityLeaderLiquidationRows no existe en src/lib/community-view.ts (fase RED de T43)"
      );
    }
    buildCommunityLeaderLiquidationRows = vista.buildCommunityLeaderLiquidationRows;
  });

  const COMUNIDADES: CommunityLike[] = [
    { id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" },
    { id: "com-2", name: "Comunidad Pacifico", leaderName: "Luis Paz" }
  ];

  const asiento = (over: Partial<EntryLike> = {}): EntryLike => ({
    id: "we-1",
    ownerType: "community_leader",
    ownerId: "com-1",
    type: "community_cashback",
    amountCop: 3000,
    orderId: "ord-1",
    settlementId: "",
    ...over
  });

  const fila = (
    rows: CommunityLeaderLiquidationRow[],
    communityId: string
  ): CommunityLeaderLiquidationRow | undefined =>
    rows.find((row) => row.communityId === communityId);

  it("RF_49: una comunidad con cashback pendiente produce su fila, con el total y los ids de asiento", () => {
    // Los ids de asiento son lo que despues viaja a `createSettlement`: sin ellos el corte se
    // crea pero los asientos se quedan sin `settlementId` y se vuelven a liquidar el mes siguiente.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", amountCop: 4500, orderId: "ord-2" })
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.communityId).toBe("com-1");
    expect(row.communityName).toBe("Comunidad Andes");
    expect(row.leaderName).toBe("Marta Ruiz");
    expect(row.cashbackCop).toBe(7500);
    expect(row.orders).toBe(2);
    expect([...row.walletEntryIds].sort()).toEqual(["we-1", "we-2"]);
    expect([...row.orderIds].sort()).toEqual(["ord-1", "ord-2"]);
  });

  it("RF_49: solo entran los asientos sin cortar: uno ya liquidado no se vuelve a pagar", () => {
    // Volver a liquidarlo es cobrarle dos veces a la plataforma el mismo cashback. Un asiento
    // cortado trae `settlementId` no vacio; uno pendiente lo trae "" (o ausente, en los viejos).
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000, settlementId: "" }),
      asiento({ id: "we-2", amountCop: 4500, settlementId: undefined, orderId: "ord-2" }),
      asiento({ id: "we-3", amountCop: 900000, settlementId: "set-9", orderId: "ord-3" })
    ]);
    const row = fila(rows, "com-1");
    expect(row).toBeDefined();
    expect(row?.cashbackCop).toBe(7500);
    expect(row?.walletEntryIds).not.toContain("we-3");
    expect(row?.orderIds).not.toContain("ord-3");
  });

  it("RF_49: solo 'community_cashback' con ownerType 'community_leader': un asiento de tienda con el mismo ownerId no se cuela", () => {
    // `ownerId` no es unico entre colecciones: una tienda y una comunidad pueden compartir id.
    // Filtrar solo por ownerId le gira al lider el saldo de una tienda entera.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000 }),
      asiento({ id: "we-2", ownerType: "seller", amountCop: 1800000, orderId: "ord-2" }),
      asiento({ id: "we-3", ownerType: "driver", amountCop: 260000, orderId: "ord-3" }),
      asiento({ id: "we-4", type: "delivery_fee", amountCop: 12000, orderId: "ord-4" }),
      asiento({ id: "we-5", type: "product_cost", amountCop: 55000, orderId: "ord-5" })
    ]);
    const row = fila(rows, "com-1");
    expect(row?.cashbackCop).toBe(3000);
    expect(row?.walletEntryIds).toEqual(["we-1"]);
    expect(row?.orders).toBe(1);
  });

  it("RF_49: los asientos de otra comunidad no entran en esta fila", () => {
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", ownerId: "com-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", ownerId: "com-2", amountCop: 80000, orderId: "ord-2" })
    ]);
    expect(rows).toHaveLength(2);
    expect(fila(rows, "com-1")?.cashbackCop).toBe(3000);
    expect(fila(rows, "com-1")?.orderIds).toEqual(["ord-1"]);
    expect(fila(rows, "com-2")?.cashbackCop).toBe(80000);
    expect(fila(rows, "com-2")?.leaderName).toBe("Luis Paz");
  });

  it("RF_49: las reversas de correccion netean dentro de la fila", () => {
    // `correctOrderStatus` compensa un cashback ya causado con un asiento NEGATIVO en el periodo
    // abierto (`-correction-reverse-*`). Sumar solo los positivos le paga al lider un pedido que
    // termino fallido.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", amountCop: 4500, orderId: "ord-2" }),
      asiento({ id: "we-2-correction-reverse", amountCop: -4500, orderId: "ord-2" })
    ]);
    const row = fila(rows, "com-1");
    expect(row?.cashbackCop).toBe(3000);
    // La reversa TAMBIEN se corta: si se queda fuera del corte sigue pendiente para siempre y
    // muerde el neto del mes que viene.
    expect(row?.walletEntryIds).toContain("we-2-correction-reverse");
    expect(row?.walletEntryIds).toHaveLength(3);
  });

  it("RF_49: una comunidad sin asientos pendientes no produce fila: no se crean cortes vacios", () => {
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", ownerId: "com-1", amountCop: 3000 }),
      asiento({
        id: "we-9",
        ownerId: "com-2",
        amountCop: 99000,
        settlementId: "set-1",
        orderId: "ord-9"
      })
    ]);
    expect(rows.map((row) => row.communityId)).toEqual(["com-1"]);
    expect(fila(rows, "com-2")).toBeUndefined();
    expect(buildCommunityLeaderLiquidationRows(COMUNIDADES, [])).toEqual([]);
  });

  it("RF_49: orderIds no repite ids aunque un pedido genere varios asientos, y orders los cuenta una vez", () => {
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", amountCop: 1500, orderId: "ord-1" }),
      asiento({ id: "we-3", amountCop: 2000, orderId: "ord-2" })
    ]);
    const row = fila(rows, "com-1");
    expect(row?.orderIds).toEqual(["ord-1", "ord-2"]);
    expect(row?.orders).toBe(2);
    expect(row?.cashbackCop).toBe(6500);
    // Los asientos SI son tres: deduplicar pedidos no puede deduplicar dinero.
    expect(row?.walletEntryIds).toHaveLength(3);
  });

  it("RF_49: un neto de cero exacto SI produce fila: hay asientos que cortar aunque no haya plata que girar", () => {
    // La decision, atada aqui para que no se resuelva sola mas adelante: la fila existe cuando
    // hay ASIENTOS pendientes, no cuando el neto es positivo. Filtrando por neto > 0 el par
    // (cashback + su reversa) se quedaria pendiente para siempre y morderia el corte siguiente;
    // filtrando por neto != 0 pasaria lo mismo en el empate exacto.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 4500, orderId: "ord-1" }),
      asiento({ id: "we-1-correction-reverse", amountCop: -4500, orderId: "ord-1" })
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.cashbackCop).toBe(0);
    expect(row.walletEntryIds).toHaveLength(2);
    expect(row.orders).toBe(1);
  });

  it("RF_49: un neto negativo produce fila y no se recorta a cero", () => {
    // La reversa de un cashback ya cortado y pagado cae en el periodo abierto. Recortar a cero
    // regala la diferencia; el corte negativo es un descuento del proximo giro, que es lo que es.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 2000, orderId: "ord-1" }),
      asiento({ id: "we-2-correction-reverse", amountCop: -9000, orderId: "ord-2" })
    ]);
    const row = fila(rows, "com-1");
    expect(row?.cashbackCop).toBe(-7000);
  });

  it("RF_49: un importe ausente, nulo o no numerico no envenena el total con NaN", () => {
    // Un NaN aqui no rompe la pantalla: pinta "NaN" donde va el dinero del lider y, peor, viaja
    // al callable como neto del corte.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000, orderId: "ord-1" }),
      {
        id: "we-2",
        ownerType: "community_leader",
        ownerId: "com-1",
        type: "community_cashback",
        orderId: "ord-2"
      } as unknown as EntryLike,
      {
        id: "we-3",
        ownerType: "community_leader",
        ownerId: "com-1",
        type: "community_cashback",
        amountCop: null,
        orderId: "ord-3"
      } as unknown as EntryLike,
      {
        id: "we-4",
        ownerType: "community_leader",
        ownerId: "com-1",
        type: "community_cashback",
        amountCop: "1500",
        orderId: "ord-4"
      } as unknown as EntryLike,
      {
        id: "we-5",
        ownerType: "community_leader",
        ownerId: "com-1",
        type: "community_cashback",
        amountCop: "no-es-plata",
        orderId: "ord-5"
      } as unknown as EntryLike
    ]);
    const row = fila(rows, "com-1");
    expect(row).toBeDefined();
    expect(Number.isFinite(row?.cashbackCop ?? NaN)).toBe(true);
    expect(row?.cashbackCop).toBe(4500);
  });

  it("RF_49: un asiento sin orderId no mete un id vacio en orderIds ni infla el recuento", () => {
    // Los ajustes manuales de cashback no cuelgan de ningun pedido. Un "" en la lista viaja al
    // callable y deja el corte apuntando a un pedido que no existe.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", amountCop: 2000, orderId: undefined }),
      asiento({ id: "we-3", amountCop: 1000, orderId: "" })
    ]);
    const row = fila(rows, "com-1");
    expect(row?.orderIds).toEqual(["ord-1"]);
    expect(row?.orders).toBe(1);
    // El dinero de los ajustes sin pedido SI entra: es cashback que se le debe igual.
    expect(row?.cashbackCop).toBe(6000);
    expect(row?.walletEntryIds).toHaveLength(3);
  });

  it("RF_49: un asiento de una comunidad que no esta en el catalogo no se pierde en silencio", () => {
    // Regla 5 del proyecto: acotar una lista sin comprobar que cuelga de ella baja saldos sin
    // avisar. Si `communities` llega incompleto (scoping por rol, comunidad recien creada), el
    // dinero tiene que seguir visible aunque el nombre no se pueda resolver.
    const rows = buildCommunityLeaderLiquidationRows(COMUNIDADES, [
      asiento({ id: "we-1", ownerId: "com-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-7", ownerId: "com-huerfana", amountCop: 25000, orderId: "ord-7" })
    ]);
    const huerfana = fila(rows, "com-huerfana");
    expect(huerfana).toBeDefined();
    expect(huerfana?.cashbackCop).toBe(25000);
    expect(huerfana?.communityName.trim().length).toBeGreaterThan(0);
    expect(huerfana?.leaderName.trim().length).toBeGreaterThan(0);
  });

  it("RF_49: una comunidad sin leaderName no pinta un hueco", () => {
    const rows = buildCommunityLeaderLiquidationRows(
      [{ id: "com-3", name: "Comunidad Norte" }],
      [asiento({ id: "we-1", ownerId: "com-3", amountCop: 3000, orderId: "ord-1" })]
    );
    expect(rows[0].communityName).toBe("Comunidad Norte");
    expect(rows[0].leaderName.trim().length).toBeGreaterThan(0);
  });

  it("RF_49: el orden de las filas no depende del orden en que lleguen los asientos", () => {
    // Firestore no garantiza orden de llegada: si las filas bailan entre renders, el admin marca
    // pagado el corte de otra comunidad.
    const entries: EntryLike[] = [
      asiento({ id: "we-1", ownerId: "com-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", ownerId: "com-2", amountCop: 80000, orderId: "ord-2" })
    ];
    const directo = buildCommunityLeaderLiquidationRows(COMUNIDADES, entries);
    const alReves = buildCommunityLeaderLiquidationRows(COMUNIDADES, [...entries].reverse());
    expect(alReves.map((row) => row.communityId)).toEqual(directo.map((row) => row.communityId));
  });

  it("RF_49: no muta ni el catalogo de comunidades ni los asientos que recibe", () => {
    const entries: EntryLike[] = [
      asiento({ id: "we-1", amountCop: 3000, orderId: "ord-1" }),
      asiento({ id: "we-2", ownerId: "com-2", amountCop: 5000, orderId: "ord-2" })
    ];
    const copiaEntries = JSON.parse(JSON.stringify(entries)) as EntryLike[];
    const copiaComunidades = JSON.parse(JSON.stringify(COMUNIDADES)) as CommunityLike[];
    buildCommunityLeaderLiquidationRows(COMUNIDADES, entries);
    expect(entries).toEqual(copiaEntries);
    expect(COMUNIDADES).toEqual(copiaComunidades);
  });
});

describe("T34 · lista de comunidades del admin", () => {
  type AdminCommunityLike = {
    id: string;
    name: string;
    leaderName?: string;
    pricing?: {
      sellerDeliveredFeeCop?: number;
      sellerFailedFeeCop?: number;
      fulfillmentFeeCop?: number;
    };
  };
  type AdminSellerLike = { id: string; communityId?: string };
  type AdminEntryLike = {
    ownerType: string;
    ownerId: string;
    type: string;
    amountCop: number;
    settlementId?: string;
  };
  type AdminSettingsLike = {
    sellerDeliveredFeeCop: number;
    sellerFailedFeeCop: number;
    fulfillmentFeeCop: number;
  };
  type AdminCommunityRow = {
    communityId: string;
    name: string;
    leaderName: string;
    stores: number;
    pricing: {
      sellerDeliveredFeeCop: number;
      sellerFailedFeeCop: number;
      fulfillmentFeeCop: number;
    };
    cashbackAccruedCop: number;
  };
  type BuildAdminList = (input: {
    communities: AdminCommunityLike[];
    sellers: AdminSellerLike[];
    entries: AdminEntryLike[];
    settings: AdminSettingsLike;
  }) => AdminCommunityRow[];

  let buildAdminCommunityList: BuildAdminList;

  // Carga diferida: la funcion todavia no existe y un import estatico roto tumbaria la
  // recoleccion de los 58 casos verdes de este archivo.
  beforeEach(async () => {
    const vista = (await import("./community-view")) as unknown as {
      buildAdminCommunityList?: BuildAdminList;
    };
    if (typeof vista.buildAdminCommunityList !== "function") {
      throw new Error(
        "buildAdminCommunityList no existe en src/lib/community-view.ts (fase RED de T34)"
      );
    }
    buildAdminCommunityList = vista.buildAdminCommunityList;
  });

  const AJUSTES: AdminSettingsLike = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 6000,
    fulfillmentFeeCop: 2000
  };

  const cashback = (over: Partial<AdminEntryLike> = {}): AdminEntryLike => ({
    ownerType: "community_leader",
    ownerId: "com-1",
    type: "community_cashback",
    amountCop: 3000,
    settlementId: "",
    ...over
  });

  const fila = (
    rows: AdminCommunityRow[],
    communityId: string
  ): AdminCommunityRow | undefined => rows.find((row) => row.communityId === communityId);

  it("RF_34: cada comunidad sale con su lider, sus tres precios vigentes y su cashback causado", () => {
    const rows = buildAdminCommunityList({
      communities: [
        {
          id: "com-1",
          name: "Comunidad Andes",
          leaderName: "Marta Ruiz",
          pricing: { sellerDeliveredFeeCop: 15000, sellerFailedFeeCop: 7000, fulfillmentFeeCop: 2500 }
        }
      ],
      sellers: [
        { id: "sel-1", communityId: "com-1" },
        { id: "sel-2", communityId: "com-1" }
      ],
      entries: [cashback({ amountCop: 3000 }), cashback({ amountCop: 4500 })],
      settings: AJUSTES
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      communityId: "com-1",
      name: "Comunidad Andes",
      leaderName: "Marta Ruiz",
      stores: 2,
      pricing: { sellerDeliveredFeeCop: 15000, sellerFailedFeeCop: 7000, fulfillmentFeeCop: 2500 },
      cashbackAccruedCop: 7500
    });
  });

  it("RF_34: el cashback causado incluye los asientos ya cortados, no solo los pendientes", () => {
    // Diferencia con T43: alli se listaba lo que falta por pagar, aqui lo que la comunidad ha
    // generado en total. Filtrar por `settlementId` vacio dejaria la cifra en cero en cuanto se
    // hiciera el primer corte, y el admin veria comunidades productivas como si no generaran nada.
    const rows = buildAdminCommunityList({
      communities: [{ id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" }],
      sellers: [],
      entries: [
        cashback({ amountCop: 3000, settlementId: "set-1" }),
        cashback({ amountCop: 4500, settlementId: "set-2" }),
        cashback({ amountCop: 2500, settlementId: "" }),
        cashback({ amountCop: 1000, settlementId: undefined })
      ],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.cashbackAccruedCop).toBe(11000);
  });

  it("RF_34: dos comunidades no se mezclan: los asientos de una no suman en la otra", () => {
    const rows = buildAdminCommunityList({
      communities: [
        { id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" },
        { id: "com-2", name: "Comunidad Pacifico", leaderName: "Luis Paz" }
      ],
      sellers: [],
      entries: [
        cashback({ ownerId: "com-1", amountCop: 3000 }),
        cashback({ ownerId: "com-2", amountCop: 80000 }),
        cashback({ ownerId: "com-2", amountCop: 20000 })
      ],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.cashbackAccruedCop).toBe(3000);
    expect(fila(rows, "com-2")?.cashbackAccruedCop).toBe(100000);
  });

  it("RF_34: una comunidad sin tiendas y sin asientos sale en la lista con ceros, no ausente", () => {
    // Es la comunidad recien creada: si desaparece de la tarjeta, el admin no puede ni ver su
    // enlace de invitacion ni corregirle los precios.
    const rows = buildAdminCommunityList({
      communities: [
        { id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" },
        { id: "com-nueva", name: "Comunidad Naciente", leaderName: "Ana Gil" }
      ],
      sellers: [{ id: "sel-1", communityId: "com-1" }],
      entries: [cashback({ ownerId: "com-1", amountCop: 3000 })],
      settings: AJUSTES
    });
    expect(rows).toHaveLength(2);
    const nueva = fila(rows, "com-nueva");
    expect(nueva).toBeDefined();
    expect(nueva?.stores).toBe(0);
    expect(nueva?.cashbackAccruedCop).toBe(0);
    expect(nueva?.pricing).toEqual({
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 6000,
      fulfillmentFeeCop: 2000
    });
  });

  it("RF_34: un concepto sin precio propio hereda el de los ajustes; con precio propio manda el suyo", () => {
    const rows = buildAdminCommunityList({
      communities: [
        {
          id: "com-1",
          name: "Comunidad Andes",
          leaderName: "Marta Ruiz",
          pricing: { sellerFailedFeeCop: 9000 }
        }
      ],
      sellers: [],
      entries: [],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.pricing).toEqual({
      sellerDeliveredFeeCop: 12000,
      sellerFailedFeeCop: 9000,
      fulfillmentFeeCop: 2000
    });
  });

  it("RF_34: un precio propio de cero manda sobre el ajuste, no se toma por ausente", () => {
    // `?? ` distingue 0 de undefined; un `||` no. Una comunidad con envio gratis en fallidos
    // veria el precio global y el admin le cobraria de mas.
    const rows = buildAdminCommunityList({
      communities: [
        {
          id: "com-1",
          name: "Comunidad Andes",
          leaderName: "Marta Ruiz",
          pricing: { sellerDeliveredFeeCop: 0, sellerFailedFeeCop: 0, fulfillmentFeeCop: 0 }
        }
      ],
      sellers: [],
      entries: [],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.pricing).toEqual({
      sellerDeliveredFeeCop: 0,
      sellerFailedFeeCop: 0,
      fulfillmentFeeCop: 0
    });
  });

  it("RF_34: las reversas de correccion netean en el causado", () => {
    // `correctOrderStatus` compensa un corte cerrado con asientos negativos. Si se suman en
    // valor absoluto, una entrega revertida aparece como si hubiera generado el doble.
    const rows = buildAdminCommunityList({
      communities: [{ id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" }],
      sellers: [],
      entries: [
        cashback({ amountCop: 3000, settlementId: "set-1" }),
        cashback({ amountCop: -3000, settlementId: "" }),
        cashback({ amountCop: 4500 })
      ],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.cashbackAccruedCop).toBe(4500);
  });

  it("RF_34: importes no numericos no envenenan la suma con NaN", () => {
    const rows = buildAdminCommunityList({
      communities: [{ id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" }],
      sellers: [],
      entries: [
        cashback({ amountCop: 3000 }),
        { ownerType: "community_leader", ownerId: "com-1", type: "community_cashback", amountCop: "1500" } as unknown as AdminEntryLike,
        { ownerType: "community_leader", ownerId: "com-1", type: "community_cashback", amountCop: undefined } as unknown as AdminEntryLike,
        { ownerType: "community_leader", ownerId: "com-1", type: "community_cashback", amountCop: Number.NaN } as unknown as AdminEntryLike,
        { ownerType: "community_leader", ownerId: "com-1", type: "community_cashback", amountCop: "no-es-plata" } as unknown as AdminEntryLike
      ],
      settings: AJUSTES
    });
    const row = fila(rows, "com-1");
    expect(Number.isFinite(row?.cashbackAccruedCop ?? Number.NaN)).toBe(true);
    expect(row?.cashbackAccruedCop).toBe(3000);
  });

  it("RF_34: stores cuenta solo las tiendas de esa comunidad", () => {
    const rows = buildAdminCommunityList({
      communities: [
        { id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" },
        { id: "com-2", name: "Comunidad Pacifico", leaderName: "Luis Paz" }
      ],
      sellers: [
        { id: "sel-1", communityId: "com-1" },
        { id: "sel-2", communityId: "com-2" },
        { id: "sel-3", communityId: "com-2" },
        { id: "sel-4" },
        { id: "sel-5", communityId: "" },
        { id: "sel-6", communityId: "com-borrada" }
      ],
      entries: [],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.stores).toBe(1);
    expect(fila(rows, "com-2")?.stores).toBe(2);
  });

  it("RF_34: solo cuentan los asientos de cashback de lider de comunidad, no cualquier movimiento", () => {
    // La wallet del lider tambien lleva pagos de corte y ajustes; sumarlos todos infla la cifra
    // que el admin usa para decidir precios.
    const rows = buildAdminCommunityList({
      communities: [{ id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" }],
      sellers: [],
      entries: [
        cashback({ amountCop: 3000 }),
        cashback({ type: "settlement_payout", amountCop: -3000 }),
        cashback({ ownerType: "seller", amountCop: 99000 }),
        cashback({ ownerType: "driver", type: "delivery_fee", amountCop: 50000 })
      ],
      settings: AJUSTES
    });
    expect(fila(rows, "com-1")?.cashbackAccruedCop).toBe(3000);
  });

  it("RF_34: una comunidad sin leaderName no pinta un hueco", () => {
    const rows = buildAdminCommunityList({
      communities: [{ id: "com-1", name: "Comunidad Andes" }],
      sellers: [],
      entries: [],
      settings: AJUSTES
    });
    expect(rows[0].name).toBe("Comunidad Andes");
    expect(rows[0].leaderName.trim().length).toBeGreaterThan(0);
  });

  it("RF_34: el orden de las filas no depende del orden en que lleguen asientos ni tiendas", () => {
    const communities: AdminCommunityLike[] = [
      { id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz" },
      { id: "com-2", name: "Comunidad Pacifico", leaderName: "Luis Paz" }
    ];
    const sellers: AdminSellerLike[] = [
      { id: "sel-1", communityId: "com-1" },
      { id: "sel-2", communityId: "com-2" }
    ];
    const entries: AdminEntryLike[] = [
      cashback({ ownerId: "com-1", amountCop: 3000 }),
      cashback({ ownerId: "com-2", amountCop: 8000 })
    ];
    const directo = buildAdminCommunityList({ communities, sellers, entries, settings: AJUSTES });
    const alReves = buildAdminCommunityList({
      communities,
      sellers: [...sellers].reverse(),
      entries: [...entries].reverse(),
      settings: AJUSTES
    });
    expect(alReves.map((row) => row.communityId)).toEqual(directo.map((row) => row.communityId));
    expect(alReves).toEqual(directo);
  });

  it("RF_34: sin comunidades devuelve lista vacia, no revienta", () => {
    expect(
      buildAdminCommunityList({ communities: [], sellers: [], entries: [], settings: AJUSTES })
    ).toEqual([]);
  });

  it("RF_34: no muta las colecciones que recibe", () => {
    const communities: AdminCommunityLike[] = [
      { id: "com-1", name: "Comunidad Andes", leaderName: "Marta Ruiz", pricing: { fulfillmentFeeCop: 2500 } }
    ];
    const sellers: AdminSellerLike[] = [{ id: "sel-1", communityId: "com-1" }];
    const entries: AdminEntryLike[] = [cashback({ amountCop: 3000 })];
    const copiaComunidades = JSON.parse(JSON.stringify(communities)) as AdminCommunityLike[];
    const copiaSellers = JSON.parse(JSON.stringify(sellers)) as AdminSellerLike[];
    const copiaEntries = JSON.parse(JSON.stringify(entries)) as AdminEntryLike[];
    buildAdminCommunityList({ communities, sellers, entries, settings: AJUSTES });
    expect(communities).toEqual(copiaComunidades);
    expect(sellers).toEqual(copiaSellers);
    expect(entries).toEqual(copiaEntries);
  });
});

/**
 * T48 · RF_01 — el guarda de fuente: que la interfaz use LA etiqueta, no una suya.
 *
 * RF_01 ya estaba "cubierto" por los dos casos de T1 y la pantalla mentia igual: hay DOS
 * `roleLabel`. El de `src/lib/community-view.ts` devuelve "Lider de comunidad"; el de
 * `src/components/operations-app.tsx` es una cadena de ternarios sin rama para
 * `community_leader`, asi que cae en el `else` y devuelve "Mensajero". La interfaz usa el
 * segundo en seis sitios, incluida la cabecera de sesion: hoy, en produccion, un lider de
 * comunidad ve "Mensajero" junto a su nombre.
 *
 * Probar la funcion buena no detecta eso. Lo unico que lo detecta es atar QUIEN la llama, y eso
 * se comprueba leyendo `operations-app.tsx` COMO TEXTO: el fichero no se puede importar (es un
 * componente cliente de Next con `@/` y JSX que arrastra medio SDK, y la suite corre en Node).
 *
 * Con lo que implica una comprobacion de fuente: si alguien reescribe el import con otra forma
 * sintactica, esto se pone rojo sin que nada este mal. Se acepta a proposito — el fallo real es
 * silencioso (la app funciona, solo etiqueta mal a un rol entero) y un falso rojo que obliga a
 * mirar el import es barato al lado.
 *
 * Cada `expect` negativo (no contiene X) va con uno positivo sobre otra cosa del mismo fichero,
 * para que un extractor roto que devuelva cadena vacia no deje pasar la prueba en vacio.
 */
const OPERATIONS_APP_SOURCE = readFileSync(
  fileURLToPath(new URL("../components/operations-app.tsx", import.meta.url)),
  "utf8"
);

/** La linea de import de un modulo concreto dentro de `operations-app.tsx`. */
function lineaDeImportDe(modulo: string): string {
  const linea = OPERATIONS_APP_SOURCE.split("\n").find(
    (l) => l.trimStart().startsWith("import") && l.includes(`from "${modulo}"`)
  );
  expect(linea, `operations-app.tsx ya no importa nada de ${modulo}; actualizar esta prueba`).toBeTruthy();
  return linea ?? "";
}

describe("T48 · RF_01: la interfaz etiqueta los roles con la funcion unica", () => {
  it("RF_01: operations-app.tsx no define su propio roleLabel", () => {
    expect(OPERATIONS_APP_SOURCE).not.toMatch(/function roleLabel/);
    expect(OPERATIONS_APP_SOURCE).not.toMatch(/const roleLabel\s*=/);

    // Control positivo del mismo extractor: si el fichero se leyera vacio (ruta mal, encoding),
    // los dos `not.toMatch` de arriba pasarian sin comprobar nada. `statusLabel` es otra funcion
    // local del mismo fichero que T48 no toca: mientras exista, el texto se leyo de verdad.
    expect(OPERATIONS_APP_SOURCE.length).toBeGreaterThan(100_000);
    expect(OPERATIONS_APP_SOURCE).toMatch(/function statusLabel/);
  });

  it("RF_01: operations-app.tsx importa roleLabel de @/lib/community-view", () => {
    const linea = lineaDeImportDe("@/lib/community-view");
    expect(linea).toContain("roleLabel");

    // Control positivo: `brandFor` ya viaja en ese mismo import hoy. Si el extractor devolviera
    // la linea equivocada (o vacia), esta asercion cae y no la anterior por casualidad.
    expect(linea).toContain("brandFor");
  });

  it("RF_01: la cabecera de sesion sigue pasando por roleLabel", () => {
    // El sitio concreto donde un lider ve "Mensajero" junto a su nombre. Si alguien "arregla"
    // RF_01 borrando la llamada en vez de arreglando la funcion, la etiqueta desaparece y esto
    // lo caza. Es una asercion positiva: no puede pasar en vacio.
    expect(OPERATIONS_APP_SOURCE).toContain("roleLabel(session.role)");
  });
});

/**
 * T48 · RF_50, RF_02, RF_04 — la validacion previa del formulario de alta de lider.
 *
 * `createCommunityLeader` esta desplegada y con envoltorio en `src/lib/firebase/auth.ts`, pero
 * NADA de la interfaz la llama: no se puede crear una comunidad desde el panel. Antes de abrir
 * ese formulario hace falta la funcion pura que decide si lo tecleado vale, para que el error se
 * vea en el campo y no como un `invalid-argument` generico devuelto por el servidor.
 *
 * Regla que fija la constitucion y que estas pruebas amarran: el criterio del nombre corto vive
 * en UN solo sitio (`validateSlug`, en functions/src/community-slug.ts, ya probado por T2). Aqui
 * se comprueba comparando el motivo devuelto con el de `validateSlug` LETRA A LETRA: una regla
 * reimplementada con otra prosa falla aunque acierte el veredicto.
 *
 * Carga diferida: la funcion todavia no existe y un import estatico tumbaria el fichero entero.
 */
type CommunityLeaderFormInput = {
  name: string;
  slug: string;
  leaderName: string;
  leaderEmail: string;
  leaderPhone: string;
  password: string;
};

type CommunityLeaderFormResult =
  | { ok: true; value: CommunityLeaderFormInput }
  | { ok: false; field: keyof CommunityLeaderFormInput; reason: string };

type CommunityLeaderFormOptions = { takenSlugs?: readonly string[] };

type ValidarFormulario = (
  input: CommunityLeaderFormInput,
  options?: CommunityLeaderFormOptions
) => CommunityLeaderFormResult;

async function cargarValidador(): Promise<ValidarFormulario> {
  const mod: Record<string, unknown> = await import("./community-view");
  const fn = mod.validateCommunityLeaderForm;
  expect(
    typeof fn,
    "src/lib/community-view.ts todavia no exporta validateCommunityLeaderForm"
  ).toBe("function");
  return fn as ValidarFormulario;
}

/** Los seis campos bien rellenados. Cada caso estropea exactamente uno. */
const FORMULARIO_VALIDO: CommunityLeaderFormInput = {
  name: "Comunidad Andes",
  slug: "comunidad-andes",
  leaderName: "Marta Ruiz",
  leaderEmail: "marta@andes.co",
  leaderPhone: "+573001112233",
  password: "clave-segura"
};

const conCampo = (campo: keyof CommunityLeaderFormInput, valor: string): CommunityLeaderFormInput => ({
  ...FORMULARIO_VALIDO,
  [campo]: valor
});

describe("T48 · RF_50: el formulario valida antes de llamar a la callable", () => {
  it("RF_50: con los seis campos bien, acepta", async () => {
    const validar = await cargarValidador();
    const res = validar(FORMULARIO_VALIDO);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual(FORMULARIO_VALIDO);
  });

  it("RF_50: el nombre de la comunidad vacio se rechaza senalando 'name'", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("name", ""));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("name");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: el nombre corto vacio se rechaza senalando 'slug'", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("slug", ""));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("slug");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: el nombre del lider vacio se rechaza senalando 'leaderName'", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("leaderName", ""));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("leaderName");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: el correo vacio se rechaza senalando 'leaderEmail'", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("leaderEmail", ""));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("leaderEmail");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: el telefono vacio se rechaza senalando 'leaderPhone'", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("leaderPhone", ""));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("leaderPhone");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: la contrasena vacia se rechaza senalando 'password'", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("password", ""));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("password");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: un campo con solo espacios cuenta como vacio, no como relleno", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("leaderName", "   "));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("leaderName");
  });

  it("RF_50: con varios campos mal, senala el primero en orden de formulario", async () => {
    // El orden de comprobacion se fija aqui a proposito: sin el, "que campo se senala" queda al
    // azar del implementador y la prueba anterior podria pasar por otro motivo.
    const validar = await cargarValidador();
    const res = validar({ ...FORMULARIO_VALIDO, name: "", password: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("name");
  });

  it("RF_50: no inventa valores por defecto ni campos de mas", async () => {
    const validar = await cargarValidador();
    const res = validar({
      name: "  Comunidad Andes  ",
      slug: "comunidad-andes",
      leaderName: "  Marta Ruiz  ",
      leaderEmail: "  marta@andes.co  ",
      leaderPhone: "  +573001112233  ",
      password: "clave-segura"
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Recorta, que es lo que hace `z.string().trim()` en el servidor. Nada mas: ni rellena el
    // telefono, ni deduce el nombre corto del nombre, ni anade banderas que el servidor no espera.
    expect(res.value).toEqual(FORMULARIO_VALIDO);
    expect(Object.keys(res.value).sort()).toEqual([
      "leaderEmail",
      "leaderName",
      "leaderPhone",
      "name",
      "password",
      "slug"
    ]);
  });

  it("RF_50: no muta el objeto que recibe", async () => {
    const validar = await cargarValidador();
    const entrada: CommunityLeaderFormInput = { ...FORMULARIO_VALIDO, leaderEmail: "  Marta@Andes.CO  " };
    const copia: CommunityLeaderFormInput = { ...entrada };
    validar(entrada);
    expect(entrada).toEqual(copia);
  });
});

describe("T48 · RF_02, RF_04: el nombre corto se valida con validateSlug, no con una regla nueva", () => {
  it("RF_02: acepta el nombre corto normalizado, igual que lo guardara el servidor", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("slug", "Comunidad Andes"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // `validateSlug` devuelve el slug ya normalizado; el formulario debe enviar ESE, no lo
    // tecleado. Si enviara lo tecleado, el enlace que se le ensena al lider no seria el suyo.
    expect(res.value.slug).toBe(validateSlug("Comunidad Andes").ok ? "comunidad-andes" : "");
    expect(res.value.slug).toBe("comunidad-andes");
  });

  it("RF_04: un nombre corto reservado se rechaza con el motivo exacto de validateSlug", async () => {
    const validar = await cargarValidador();
    const esperado = validateSlug("admin");
    expect(esperado.ok).toBe(false);
    const res = validar(conCampo("slug", "admin"));
    expect(res.ok).toBe(false);
    if (res.ok || esperado.ok) return;
    expect(res.field).toBe("slug");
    // Letra a letra: una regla reimplementada aqui con otra prosa falla aunque acierte.
    expect(res.reason).toBe(esperado.reason);
  });

  it("RF_04: un nombre corto con caracteres no permitidos se rechaza con el motivo de validateSlug", async () => {
    const validar = await cargarValidador();
    const esperado = validateSlug("@@@");
    expect(esperado.ok).toBe(false);
    const res = validar(conCampo("slug", "@@@"));
    expect(res.ok).toBe(false);
    if (res.ok || esperado.ok) return;
    expect(res.field).toBe("slug");
    expect(res.reason).toBe(esperado.reason);
  });

  it("RF_04: un nombre corto demasiado corto se rechaza con el motivo de validateSlug", async () => {
    const validar = await cargarValidador();
    const esperado = validateSlug("ab");
    expect(esperado.ok).toBe(false);
    const res = validar(conCampo("slug", "ab"));
    expect(res.ok).toBe(false);
    if (res.ok || esperado.ok) return;
    expect(res.field).toBe("slug");
    expect(res.reason).toBe(esperado.reason);
  });

  it("RF_04: un nombre corto demasiado largo se rechaza con el motivo de validateSlug", async () => {
    const validar = await cargarValidador();
    const largo = "a".repeat(40);
    const esperado = validateSlug(largo);
    expect(esperado.ok).toBe(false);
    const res = validar(conCampo("slug", largo));
    expect(res.ok).toBe(false);
    if (res.ok || esperado.ok) return;
    expect(res.field).toBe("slug");
    expect(res.reason).toBe(esperado.reason);
  });

  it("RF_02: un nombre corto ya en uso se rechaza antes de ir al servidor", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("slug", "comunidad-andes"), { takenSlugs: ["comunidad-andes"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("slug");
    expect(res.reason.trim().length).toBeGreaterThan(0);
    // El motivo tiene que distinguirse del de forma invalida: "ya esta en uso" se arregla
    // cambiando el nombre, "no vale" se arregla escribiendolo bien.
    expect(res.reason.toLowerCase()).toContain("uso");
  });

  it("RF_02: el choque de nombre corto se compara ya normalizado", async () => {
    // Tecleado con mayusculas y espacios, en uso en su forma normalizada. Comparar el texto
    // crudo dejaria pasar el duplicado y lo cazaria la transaccion del servidor con un
    // `already-exists` sin campo, que es justo lo que este formulario existe para evitar.
    const validar = await cargarValidador();
    const res = validar(conCampo("slug", "Comunidad Andes"), { takenSlugs: ["comunidad-andes"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("slug");
  });

  it("RF_02: un nombre corto libre pasa aunque haya otros ocupados", async () => {
    // Control positivo del caso anterior: sin el, una implementacion que rechazara todo slug
    // cuando `takenSlugs` no esta vacio pasaria las dos pruebas de arriba.
    const validar = await cargarValidador();
    const res = validar(conCampo("slug", "comunidad-pacifico"), {
      takenSlugs: ["comunidad-andes", "comunidad-caribe"]
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.slug).toBe("comunidad-pacifico");
  });
});

describe("T48 · RF_50: correo y contrasena se comprueban como los comprueba el servidor", () => {
  it("RF_50: un correo con forma invalida se rechaza senalando 'leaderEmail'", async () => {
    const validar = await cargarValidador();
    for (const correo of ["marta", "marta@", "@andes.co", "marta andes@x.co"]) {
      const res = validar(conCampo("leaderEmail", correo));
      expect(res.ok, `deberia rechazar el correo ${correo}`).toBe(false);
      if (res.ok) continue;
      expect(res.field).toBe("leaderEmail");
      expect(res.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("RF_50: el correo se normaliza a minusculas, igual que hace el servidor al crear la cuenta", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("leaderEmail", "  Marta.Ruiz@Andes.CO  "));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Si se enviara tal cual, el lider entraria con un correo distinto del que se le dijo y
    // "no existe la cuenta" seria el sintoma.
    expect(res.value.leaderEmail).toBe("marta.ruiz@andes.co");
  });

  it("RF_50: una contrasena mas corta que el minimo del servidor se rechaza aqui", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("password", "12345"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("password");
    expect(res.reason.trim().length).toBeGreaterThan(0);
  });

  it("RF_50: el minimo es exactamente el del servidor: seis caracteres pasan", async () => {
    // Frontera pegada a `z.string().min(6)` de `createLeaderSchema`. Validar aqui con un minimo
    // MAS estricto que el del servidor es un fallo igual: bloquea altas que el backend acepta.
    const validar = await cargarValidador();
    const res = validar(conCampo("password", "123456"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.password).toBe("123456");
  });

  it("RF_50: la contrasena no se recorta ni se toca; los espacios cuentan", async () => {
    const validar = await cargarValidador();
    const res = validar(conCampo("password", " abc123 "));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.password).toBe(" abc123 ");
  });
});

/**
 * T46 (reabierta) · RF_11 — guarda de fuente: un componente definido no es una pantalla.
 *
 * T46 se cerro dandola por buena con `SellerCommunityReassignPanel` definido en
 * `operations-app.tsx` y montado en NINGUN sitio. La verificacion de cierre busco
 * `canReassignSellerCommunity` en el archivo, lo encontro... dentro del componente muerto.
 * Es la tercera vez en esta spec que "existe el codigo" se confunde con "existe la pantalla"
 * (antes: cuatro callables sin envoltorio, y una con envoltorio pero sin boton).
 *
 * Nada del tooling actual lo caza: `eslint.config.mjs` solo activa `react-hooks`, asi que
 * `no-unused-vars` no corre; y `tsc --noEmit` no marca funciones de modulo sin usar.
 *
 * Por eso esto se lee COMO TEXTO, con lo que implica: es un extractor por regex sobre fuente,
 * no un analisis del AST. Si alguien define un componente de otra forma sintactica
 * (`const X = () => ...`) se le escapa, y si lo renombra puede ponerse rojo sin que nada este
 * mal. Se acepta a proposito: el fallo que previene es SILENCIOSO — compila, pasa los tipos,
 * pasa el lint y no se ve en ninguna pantalla.
 *
 * Cada afirmacion negativa (este conjunto esta vacio) va con un control positivo sobre un
 * componente que SI se monta, para que un extractor roto no pase la prueba en vacio.
 */
/** Sufijos que, por convencion del archivo, identifican un componente de pantalla. */
const SUFIJOS_DE_COMPONENTE = /(Panel|Table|Card|Form)$/;

/**
 * Excepciones LEGITIMAS: componentes definidos aqui y montados desde otro archivo, o elegidos
 * dinamicamente (`const Componente = mapa[clave]`), que por tanto nunca aparecen como `<X`.
 *
 * La lista va explicita y comentada a proposito. Un filtro silencioso (por ejemplo, ignorar
 * todo lo exportado) volveria a dejar pasar exactamente el fallo de T46. Anadir un nombre aqui
 * obliga a escribir AL LADO desde donde se monta.
 */
const MONTADOS_FUERA_DE_ESTE_ARCHIVO: readonly string[] = [
  // Vacia hoy: todo componente de pantalla de este archivo se monta en este archivo.
];

/** Componentes de pantalla DEFINIDOS en el archivo (`function X(` a nivel de modulo). */
function componentesDefinidos(): Set<string> {
  const nombres = new Set<string>();
  const patron = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*[(<]/gm;
  for (const coincidencia of OPERATIONS_APP_SOURCE.matchAll(patron)) {
    const nombre = coincidencia[1];
    if (SUFIJOS_DE_COMPONENTE.test(nombre)) nombres.add(nombre);
  }
  return nombres;
}

/** Componentes USADOS como elemento JSX (`<X ...>` o `<X/>`) en el archivo. */
function componentesMontados(): Set<string> {
  const nombres = new Set<string>();
  const patron = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;
  for (const coincidencia of OPERATIONS_APP_SOURCE.matchAll(patron)) {
    nombres.add(coincidencia[1]);
  }
  return nombres;
}

describe("T46 · RF_11: los componentes definidos tienen que estar montados", () => {
  it("RF_11: los dos extractores funcionan — un componente que SI se monta sale en ambos", () => {
    // Control positivo, primero. Sin el, las dos pruebas siguientes podrian pasar en vacio:
    // un extractor que devuelve conjuntos vacios tambien da diferencia vacia.
    const definidos = componentesDefinidos();
    const montados = componentesMontados();

    expect(definidos.has("AdminCommunitiesPanel"), "el extractor de definiciones no ve `function AdminCommunitiesPanel(`").toBe(true);
    expect(montados.has("AdminCommunitiesPanel"), "el extractor de JSX no ve `<AdminCommunitiesPanel`").toBe(true);

    // Y que los conjuntos tengan tamano real, no uno o dos por casualidad.
    expect(definidos.size).toBeGreaterThan(20);
    expect(montados.size).toBeGreaterThan(20);
  });

  it("RF_11: `SellerCommunityReassignPanel` no solo se define: se monta", () => {
    // El fallo concreto de T46. Definirlo no es implementarlo: mientras no aparezca como
    // elemento JSX, ninguna tienda puede reasignar comunidad desde la aplicacion.
    expect(
      componentesDefinidos().has("SellerCommunityReassignPanel"),
      "SellerCommunityReassignPanel dejo de definirse; si se renombro, actualizar esta prueba"
    ).toBe(true);
    expect(
      OPERATIONS_APP_SOURCE.includes("<SellerCommunityReassignPanel"),
      "SellerCommunityReassignPanel esta definido pero no se renderiza en ninguna parte: es una pantalla que el usuario no puede abrir"
    ).toBe(true);
  });

  it("RF_11: ningun componente *Panel/*Table/*Card/*Form queda sin montar", () => {
    // El caso general, que es el que de verdad vale: cierra la clase de fallo entera, no solo
    // la instancia de T46.
    const definidos = componentesDefinidos();
    const montados = componentesMontados();

    const muertos = [...definidos]
      .filter((nombre) => !montados.has(nombre))
      .filter((nombre) => !MONTADOS_FUERA_DE_ESTE_ARCHIVO.includes(nombre))
      .sort();

    expect(
      muertos,
      `componentes definidos y nunca montados: ${muertos.join(", ")}. O se renderizan, o se borran, o se justifican en MONTADOS_FUERA_DE_ESTE_ARCHIVO diciendo desde donde se montan.`
    ).toEqual([]);
  });
});

/**
 * T50 · RF_50: el sitio donde se crea la primera comunidad no puede estar plegado.
 *
 * El formulario de alta se puso FUERA de `AdminCommunitiesPanel` para que no desapareciera
 * cuando no hay ninguna comunidad — y el desplegable que lo contiene se tragaba esa misma
 * intencion, porque `CollapsiblePanel` arranca cerrado. Con cero comunidades, un administrador
 * veia una linea plegada que decia "Comunidades · 0 con enlace propio", indistinguible de una
 * seccion vacia sin nada que hacer.
 */
describe("T50 · cuando no hay ninguna comunidad, el panel se abre solo", () => {
  it("RF_50: sin ninguna comunidad el panel se abre, porque es donde se crea la primera", () => {
    expect(shouldOpenCommunitiesPanel(0)).toBe(true);
  });

  it("RF_50: con comunidades ya creadas el panel arranca plegado, como sus hermanos", () => {
    expect(shouldOpenCommunitiesPanel(1)).toBe(false);
    expect(shouldOpenCommunitiesPanel(37)).toBe(false);
  });

  it("RF_50: una cuenta que no sabe cuantas hay se trata como que no hay: mejor abrir de mas", () => {
    // Abrir de mas cuesta un clic; abrir de menos esconde la unica via de crear la primera.
    expect(shouldOpenCommunitiesPanel(Number.NaN)).toBe(true);
    expect(shouldOpenCommunitiesPanel(-1)).toBe(true);
  });

  it("RF_50: la pantalla usa esa decision y no una copia suya", () => {
    // Control positivo: si el lector de fuente falla, esto lo delata antes que las aserciones.
    expect(OPERATIONS_APP_SOURCE.length).toBeGreaterThan(100_000);
    expect(OPERATIONS_APP_SOURCE).toContain("shouldOpenCommunitiesPanel");
    // La leccion de `roleLabel`: probar la funcion correcta no dice nada sobre quien la llama.
    expect(OPERATIONS_APP_SOURCE).toMatch(/defaultOpen=\{shouldOpenCommunitiesPanel\(/);
  });
});

import { scheduleEffectiveAt } from "../../functions/src/community-pricing";

/**
 * T15 · RF_13, RF_14, RF_24: la tienda del propio lider dentro de su comunidad.
 *
 * Que un lider tenga tienda en la comunidad que lidera es legitimo — es el caso normal, de hecho:
 * el lider suele ser el primer vendedor. Lo que NO es legitimo es que esa circunstancia quede
 * invisible. Permitirlo y esconderlo son cosas distintas: lo primero es una decision de negocio,
 * lo segundo es una cifra que nadie audita. El admin fija precios mirando el cashback causado de
 * cada comunidad; si una parte de ese cashback vuelve al bolsillo del que decide el precio, el
 * admin tiene que verlo desglosado, no sumado.
 *
 * Y la tentacion obvia al implementar esto es la contraria: excluir la tienda del lider de las
 * cifras "para que no contamine". Eso descuadraria los totales con los cortes, que si la cobran.
 * Por eso RF_14 tiene un `it()` propio: cuenta como una tienda mas, sin trato especial. Dos
 * numeros, no uno.
 */
describe("T15 · la tienda del propio lider: visible, contada y sin privilegios", () => {
  type T15SellerLike = { id: string; communityId?: string };
  type T15CommunityLike = {
    id: string;
    name: string;
    leaderName?: string;
    /**
     * CUAL de las tiendas es la del lider. El nucleo puro no lee reclamos de autenticacion, asi
     * que el dato entra como entrada de la fila; quien construye el input lo saca del documento
     * de la comunidad (`leaderUid` -> tienda) o del reclamo `sellerId` del lider.
     */
    leaderSellerId?: string;
    pricing?: {
      sellerDeliveredFeeCop?: number;
      sellerFailedFeeCop?: number;
      fulfillmentFeeCop?: number;
    };
  };
  type T15EntryLike = {
    ownerType: string;
    ownerId: string;
    type: string;
    amountCop: number;
    settlementId?: string;
    /** Que tienda genero el cashback. Sin esto no hay forma de desglosar el de la tienda del lider. */
    sellerId?: string;
  };
  type T15SettingsLike = {
    sellerDeliveredFeeCop: number;
    sellerFailedFeeCop: number;
    fulfillmentFeeCop: number;
  };
  type T15Row = {
    communityId: string;
    name: string;
    leaderName: string;
    stores: number;
    pricing: T15SettingsLike;
    cashbackAccruedCop: number;
    /**
     * Cuanto del `cashbackAccruedCop` procede de la tienda del propio lider. Es una cifra APARTE,
     * no un descuento del total: el total sigue siendo todo lo que la comunidad causo.
     */
    leaderStoreCashbackAccruedCop: number;
  };
  type T15BuildAdminList = (input: {
    communities: T15CommunityLike[];
    sellers: T15SellerLike[];
    entries: T15EntryLike[];
    settings: T15SettingsLike;
  }) => T15Row[];

  type T15PricingField = "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop";
  type T15Notice = {
    field: T15PricingField;
    fromCop: number;
    toCop: number;
    isRaise: boolean;
    /** RF_24: si el que sube el precio se lo sube (tambien) a si mismo. */
    affectsLeaderOwnStore: boolean;
    /** El mismo plazo que para cualquier otro cambio. Sin excepcion. */
    effectiveAt: string;
    /** El aviso al administrador. `null` cuando el lider no tiene tienda en su comunidad. */
    adminAlert: string | null;
  };
  type T15BuildNotice = (input: {
    communityId: string;
    leaderSellerId?: string;
    sellers: T15SellerLike[];
    field: T15PricingField;
    fromCop: number;
    toCop: number;
    nowIso: string;
  }) => T15Notice;

  let buildAdminCommunityList: T15BuildAdminList;
  let buildLeaderPriceChangeNotice: T15BuildNotice;

  // Carga diferida, igual que en T34: `buildLeaderPriceChangeNotice` todavia no existe y un import
  // estatico roto tumbaria la recoleccion de los casos verdes de todo el archivo.
  beforeEach(async () => {
    const vista = (await import("./community-view")) as unknown as {
      buildAdminCommunityList?: T15BuildAdminList;
      buildLeaderPriceChangeNotice?: T15BuildNotice;
    };
    if (typeof vista.buildAdminCommunityList !== "function") {
      throw new Error("buildAdminCommunityList no existe en src/lib/community-view.ts");
    }
    buildAdminCommunityList = vista.buildAdminCommunityList;
    // La funcion de RF_24 todavia no existe. No se lanza aqui: si el `beforeEach` reventara, los
    // casos de RF_13 y RF_14 fallarian por una razon que no es la suya y no diriamos nada sobre
    // ellos. Que falle al invocarla, dentro del `it()` que la necesita.
    buildLeaderPriceChangeNotice =
      typeof vista.buildLeaderPriceChangeNotice === "function"
        ? vista.buildLeaderPriceChangeNotice
        : () => {
            throw new Error(
              "buildLeaderPriceChangeNotice no existe en src/lib/community-view.ts (fase RED de T15)"
            );
          };
  });

  const AJUSTES: T15SettingsLike = {
    sellerDeliveredFeeCop: 12000,
    sellerFailedFeeCop: 6000,
    fulfillmentFeeCop: 2000
  };

  // Andes: la lidera Marta, y la tienda `sel-marta` es SUYA y esta dentro de la comunidad.
  // Pacifico: la lidera Hugo, cuya tienda `sel-hugo` esta en OTRA comunidad (Andes).
  const COMUNIDADES: T15CommunityLike[] = [
    { id: "com-andes", name: "Comunidad Andes", leaderName: "Marta Ruiz", leaderSellerId: "sel-marta" },
    { id: "com-pacifico", name: "Comunidad Pacifico", leaderName: "Hugo Paz", leaderSellerId: "sel-hugo" }
  ];

  const TIENDAS: T15SellerLike[] = [
    { id: "sel-marta", communityId: "com-andes" },
    { id: "sel-bodega", communityId: "com-andes" },
    { id: "sel-hugo", communityId: "com-andes" },
    { id: "sel-costa", communityId: "com-pacifico" }
  ];

  const cashback = (over: Partial<T15EntryLike> = {}): T15EntryLike => ({
    ownerType: "community_leader",
    ownerId: "com-andes",
    type: "community_cashback",
    amountCop: 3000,
    settlementId: "",
    sellerId: "sel-bodega",
    ...over
  });

  const fila = (rows: T15Row[], communityId: string): T15Row => {
    const encontrada = rows.find((row) => row.communityId === communityId);
    if (!encontrada) throw new Error(`no hay fila para ${communityId}`);
    return encontrada;
  };

  const listaBase = (entries: T15EntryLike[]): T15Row[] =>
    buildAdminCommunityList({
      communities: COMUNIDADES,
      sellers: TIENDAS,
      entries,
      settings: AJUSTES
    });

  it("RF_13: la fila separa cuanto del cashback procede de la tienda del propio lider", () => {
    // 20.000 + 10.000 de la tienda de Marta (la lider) y 45.000 de una tienda ajena.
    const rows = listaBase([
      cashback({ sellerId: "sel-marta", amountCop: 20000 }),
      cashback({ sellerId: "sel-marta", amountCop: 10000 }),
      cashback({ sellerId: "sel-bodega", amountCop: 45000 })
    ]);
    const andes = fila(rows, "com-andes");

    expect(andes.cashbackAccruedCop, "el total causado de la comunidad").toBe(75000);
    expect(
      andes.leaderStoreCashbackAccruedCop,
      "cuanto de ese cashback lo genero la tienda de la propia lider"
    ).toBe(30000);
    // Dos numeros, no uno: si la implementacion devolviera el mismo valor en ambos campos, o
    // restara uno del otro, esto lo delata.
    expect(andes.leaderStoreCashbackAccruedCop).not.toBe(andes.cashbackAccruedCop);
    expect(andes.leaderStoreCashbackAccruedCop).toBeLessThan(andes.cashbackAccruedCop);
  });

  it("RF_13: si la tienda del lider no esta en su comunidad, la cifra es CERO, no un hueco", () => {
    // Hugo lidera Pacifico pero vende en Andes: nada del cashback de Pacifico es suyo.
    const rows = listaBase([
      cashback({ ownerId: "com-pacifico", sellerId: "sel-costa", amountCop: 7000 })
    ]);
    const pacifico = fila(rows, "com-pacifico");

    expect(pacifico.cashbackAccruedCop).toBe(7000);
    expect(
      Object.prototype.hasOwnProperty.call(pacifico, "leaderStoreCashbackAccruedCop"),
      "cero es un dato auditable; omitir el campo obliga al lector a adivinar si es cero o si nadie lo calculo"
    ).toBe(true);
    expect(pacifico.leaderStoreCashbackAccruedCop).toBe(0);
    expect(typeof pacifico.leaderStoreCashbackAccruedCop).toBe("number");
  });

  it("RF_14: la tienda del lider cuenta como una tienda mas y su cashback cuenta en el total", () => {
    // La tentacion obvia al implementar RF_13 es excluir la tienda del lider "para que no
    // contamine". Los cortes SI la cobran: excluirla aqui descuadra el panel con la caja.
    const rows = listaBase([
      cashback({ sellerId: "sel-marta", amountCop: 30000 }),
      cashback({ sellerId: "sel-bodega", amountCop: 45000 }),
      cashback({ sellerId: "sel-hugo", amountCop: 5000 })
    ]);
    const andes = fila(rows, "com-andes");

    expect(
      andes.stores,
      "sel-marta (la lider), sel-bodega y sel-hugo: tres tiendas, sin descontar la del lider"
    ).toBe(3);
    expect(
      andes.cashbackAccruedCop,
      "el total incluye los 30.000 de la tienda de la lider; si sale 50.000 es que se excluyo"
    ).toBe(80000);
  });

  it("RF_13: dos comunidades no se mezclan, ni en el total ni en la cifra del lider", () => {
    const rows = listaBase([
      cashback({ ownerId: "com-andes", sellerId: "sel-marta", amountCop: 30000 }),
      cashback({ ownerId: "com-andes", sellerId: "sel-bodega", amountCop: 45000 }),
      cashback({ ownerId: "com-pacifico", sellerId: "sel-costa", amountCop: 7000 }),
      // Cashback de Pacifico generado por la tienda de Marta: no es de Marta la cifra de
      // Pacifico (ella no lidera Pacifico) ni suma al total de Andes.
      cashback({ ownerId: "com-pacifico", sellerId: "sel-marta", amountCop: 1000 })
    ]);

    expect(fila(rows, "com-andes").cashbackAccruedCop).toBe(75000);
    expect(fila(rows, "com-andes").leaderStoreCashbackAccruedCop).toBe(30000);
    expect(fila(rows, "com-pacifico").cashbackAccruedCop).toBe(8000);
    expect(fila(rows, "com-pacifico").leaderStoreCashbackAccruedCop).toBe(0);
  });

  it("RF_13: un asiento sin tienda, o de otro concepto, no se atribuye al lider", () => {
    const rows = listaBase([
      cashback({ sellerId: "sel-marta", amountCop: 30000 }),
      // Asiento antiguo, sin `sellerId`: cuenta en el total (la comunidad lo causo) pero no se
      // le puede imputar a nadie. Atribuirlo al lider por defecto seria inventarse una cifra.
      cashback({ sellerId: undefined, amountCop: 12000 }),
      // Pago de corte en la wallet del lider: ni total ni desglose.
      cashback({ type: "settlement_payment", sellerId: "sel-marta", amountCop: 500000 }),
      // Asiento de otra coleccion con el mismo ownerId.
      cashback({ ownerType: "seller", sellerId: "sel-marta", amountCop: 900000 })
    ]);
    const andes = fila(rows, "com-andes");

    expect(andes.cashbackAccruedCop).toBe(42000);
    expect(andes.leaderStoreCashbackAccruedCop).toBe(30000);
  });

  it("RF_13: una comunidad sin lider declarado sale con cero, no rompe la lista", () => {
    const rows = buildAdminCommunityList({
      communities: [{ id: "com-huerfana", name: "Comunidad Huerfana" }],
      sellers: [{ id: "sel-x", communityId: "com-huerfana" }],
      entries: [cashback({ ownerId: "com-huerfana", sellerId: "sel-x", amountCop: 4000 })],
      settings: AJUSTES
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].stores).toBe(1);
    expect(rows[0].cashbackAccruedCop).toBe(4000);
    expect(rows[0].leaderStoreCashbackAccruedCop).toBe(0);
  });

  it("RF_13: un importe que no es numero vale cero en las dos cifras, no NaN", () => {
    const roto = { ...cashback({ sellerId: "sel-marta" }), amountCop: "30000" } as unknown as T15EntryLike;
    const rows = listaBase([
      cashback({ sellerId: "sel-marta", amountCop: 20000 }),
      roto,
      cashback({ sellerId: "sel-marta", amountCop: Number.NaN })
    ]);
    const andes = fila(rows, "com-andes");

    expect(Number.isFinite(andes.leaderStoreCashbackAccruedCop)).toBe(true);
    expect(andes.leaderStoreCashbackAccruedCop).toBe(20000);
    expect(andes.cashbackAccruedCop).toBe(20000);
  });

  // --- RF_24: el aviso de conflicto de interes al cambiar un precio ---------------------------

  const AHORA = "2026-09-01T00:00:00.000Z";

  const aviso = (over: Partial<Parameters<T15BuildNotice>[0]> = {}): T15Notice =>
    buildLeaderPriceChangeNotice({
      communityId: "com-andes",
      leaderSellerId: "sel-marta",
      sellers: TIENDAS,
      field: "sellerDeliveredFeeCop",
      fromCop: 12000,
      toCop: 15000,
      nowIso: AHORA,
      ...over
    });

  it("RF_24: subir el precio teniendo tienda en la comunidad queda marcado y avisado al admin", () => {
    const notice = aviso();

    expect(notice.affectsLeaderOwnStore, "Marta se sube el precio tambien a si misma").toBe(true);
    expect(notice.isRaise).toBe(true);
    expect(typeof notice.adminAlert).toBe("string");
    expect(
      (notice.adminAlert ?? "").trim().length,
      "el aviso al administrador no puede ser una cadena vacia: un aviso que no dice nada no es un aviso"
    ).toBeGreaterThan(0);
  });

  it("RF_24: si el lider no tiene tienda en su comunidad, no hay conflicto ni aviso", () => {
    // Hugo lidera Pacifico y vende en Andes: cambiar el precio de Pacifico no le toca el bolsillo.
    const notice = aviso({ communityId: "com-pacifico", leaderSellerId: "sel-hugo" });

    expect(notice.affectsLeaderOwnStore).toBe(false);
    expect(notice.adminAlert, "sin conflicto no se inventa un aviso que el admin aprenderia a ignorar").toBeNull();
  });

  it("RF_24: un lider sin tienda registrada tampoco dispara el aviso", () => {
    const notice = aviso({ leaderSellerId: undefined });

    expect(notice.affectsLeaderOwnStore).toBe(false);
    expect(notice.adminAlert).toBeNull();
  });

  it("RF_24: el plazo de subida es el mismo aunque su tienda sea la UNICA afectada", () => {
    // El atajo tentador: "si la unica tienda que paga mas es la del propio lider, que entre ya,
    // nadie mas se entera". No. El plazo es del precio, no de a quien le duela.
    const notice = aviso({ sellers: [{ id: "sel-marta", communityId: "com-andes" }] });
    const esperado = scheduleEffectiveAt(12000, 15000, AHORA);

    expect(notice.affectsLeaderOwnStore).toBe(true);
    expect(
      notice.effectiveAt,
      "la subida del lider a su propia tienda entra cuando entraria la de cualquier otro"
    ).toBe(esperado);
    expect(notice.effectiveAt, "una subida NUNCA entra en el acto").not.toBe(AHORA);
    // Y es exactamente la misma fecha que si la comunidad tuviera tiendas ajenas.
    expect(notice.effectiveAt).toBe(aviso().effectiveAt);
  });

  it("RF_24: una bajada tambien se avisa — el conflicto no depende del sentido del cambio", () => {
    const notice = aviso({ fromCop: 15000, toCop: 12000 });

    expect(notice.isRaise).toBe(false);
    expect(notice.affectsLeaderOwnStore).toBe(true);
    expect(typeof notice.adminAlert).toBe("string");
    // Bajar entra en el acto, igual que para cualquiera.
    expect(notice.effectiveAt).toBe(scheduleEffectiveAt(15000, 12000, AHORA));
    expect(notice.effectiveAt).toBe(AHORA);
  });
});

/* ---------------------------------------------------------------------------------------------
 * T17 · RF_17 — la MITAD que faltaba: dar el liderazgo a una cuenta que ya existe.
 *
 * RF_17 pide dos caminos: asignar el liderazgo de una comunidad QUE YA EXISTE, y crear la
 * comunidad y asignarsela EN EL MISMO ACTO. Solo se construyo el primero, y ademas se quedo sin
 * envoltorio y sin pantalla: `grantCommunityLeadership` estaba desplegada, exigia una comunidad
 * previa y no la llamaba nadie. Con cero comunidades el camino estaba cerrado por los dos lados.
 *
 * El caso real que lo motiva: un administrador intento crear un lider con el correo de una cuenta
 * que YA existe y es una tienda. La precomprobacion de RF_55 lo rechazo limpiamente —sin dejar
 * comunidad fantasma— pero no habia ninguna forma de darle el liderazgo a esa cuenta.
 *
 * Lo que se ata aqui es la parte PURA (el validador previo del formulario) mas dos guardas de
 * fuente, por la misma razon que en T46: en esta spec "existe el codigo" se ha confundido cuatro
 * veces con "existe la pantalla", y ni `tsc` ni el lint cazan un callable sin envoltorio ni un
 * componente sin montar.
 * ------------------------------------------------------------------------------------------- */

type CommunityGrantFormInput = { name: string; slug: string; targetEmail: string };

type CommunityGrantFormResult =
  | { ok: true; value: CommunityGrantFormInput }
  | { ok: false; field: keyof CommunityGrantFormInput; reason: string };

type ValidarConcesion = (
  input: CommunityGrantFormInput,
  options?: { takenSlugs?: readonly string[] }
) => CommunityGrantFormResult;

/** Carga diferida: la funcion todavia no existe y un import estatico tumbaria el fichero entero. */
async function cargarValidadorDeConcesion(): Promise<ValidarConcesion> {
  const mod: Record<string, unknown> = await import("./community-view");
  const fn = mod.validateCommunityGrantForm;
  expect(
    typeof fn,
    "src/lib/community-view.ts todavia no exporta validateCommunityGrantForm"
  ).toBe("function");
  return fn as ValidarConcesion;
}

/** Los tres campos bien. Cada caso estropea exactamente uno. */
const CONCESION_VALIDA: CommunityGrantFormInput = {
  name: "Comunidad Andes",
  slug: "comunidad-andes",
  targetEmail: "marta@andes.co"
};

const conCampoDeConcesion = (
  campo: keyof CommunityGrantFormInput,
  valor: string
): CommunityGrantFormInput => ({ ...CONCESION_VALIDA, [campo]: valor });

describe("T17 · RF_17: el formulario de concesion valida antes de llamar a la callable", () => {
  it("RF_17: con los tres campos bien, acepta", async () => {
    const validar = await cargarValidadorDeConcesion();
    const res = validar(CONCESION_VALIDA);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual(CONCESION_VALIDA);
  });

  it("RF_17: pide solo TRES campos; los del alta completa no son suyos", async () => {
    // La razon de que exista un validador hermano y no se reuse `validateCommunityLeaderForm`:
    // aquel exige seis campos, y aqui no hay ni contrasena ni telefono que pedir — la cuenta ya
    // existe. Pasarle esto a aquel lo rechazaria por `leaderName` sin que nada este mal.
    const validarAlta = await cargarValidador();
    const alta = validarAlta({
      ...CONCESION_VALIDA,
      leaderName: "",
      leaderPhone: "",
      password: ""
    } as unknown as CommunityLeaderFormInput);
    expect(alta.ok).toBe(false);

    const validar = await cargarValidadorDeConcesion();
    expect(validar(CONCESION_VALIDA).ok).toBe(true);
  });

  it("RF_17: devuelve lo NORMALIZADO, no lo tecleado", async () => {
    // El enlace que se le ensena al administrador tiene que ser el que quedo guardado, y la
    // cuenta que se busca en Auth, la del correo en minusculas: es con ese con el que se creo.
    const validar = await cargarValidadorDeConcesion();
    const res = validar({
      name: "  Comunidad Andes  ",
      slug: "  Comunidad Andes  ",
      targetEmail: "  Marta@Andes.CO  "
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      name: "Comunidad Andes",
      slug: "comunidad-andes",
      targetEmail: "marta@andes.co"
    });
  });

  it("RF_17: sin nombre de comunidad se senala el campo `name`", async () => {
    const validar = await cargarValidadorDeConcesion();
    for (const vacio of ["", "   "]) {
      const res = validar(conCampoDeConcesion("name", vacio));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.field).toBe("name");
      expect(res.reason.length).toBeGreaterThan(0);
    }
  });

  it("RF_17: sin correo se senala `targetEmail` y no otro campo", async () => {
    const validar = await cargarValidadorDeConcesion();
    const res = validar(conCampoDeConcesion("targetEmail", "   "));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("targetEmail");
  });

  it("RF_17: un correo sin forma de correo se rechaza en el campo, no en el servidor", async () => {
    const validar = await cargarValidadorDeConcesion();
    for (const malo of ["marta", "marta@", "@andes.co", "marta andes@x.co"]) {
      const res = validar(conCampoDeConcesion("targetEmail", malo));
      expect(res.ok, `deberia rechazar "${malo}"`).toBe(false);
      if (res.ok) return;
      expect(res.field).toBe("targetEmail");
    }
  });

  it("RF_17: el motivo del nombre corto es el de `validateSlug`, letra a letra", async () => {
    // La regla del slug vive en UN solo sitio (functions/src/community-slug.ts). Reimplementarla
    // aqui con otra prosa produce dos criterios que divergen en cuanto alguien toque uno.
    //
    // Los valores de abajo son los que `validateSlug` rechaza DE VERDAD, y el propio caso lo
    // comprueba antes de exigirle nada al formulario. Ojo con lo que NO va en la lista: el guion
    // es un caracter permitido, tambien al borde ("-andes" y "andes-" normalizan a "andes" y
    // pasan). Estuvieron aqui y el caso fallaba, porque afirmaban una propiedad que la funcion no
    // tiene. Prohibir el guion al borde seria cambiar el comportamiento desplegado de la spec 001
    // —con enlaces repartidos que podrian usarlo— y eso es una decision de negocio: va en una
    // spec, no en este bucle.
    const validar = await cargarValidadorDeConcesion();
    for (const malo of ["", "ad", "admin", "a".repeat(40)]) {
      const esperado = validateSlug(malo);
      expect(esperado.ok, `validateSlug deberia rechazar "${malo}"`).toBe(false);
      if (esperado.ok) return;

      const res = validar(conCampoDeConcesion("slug", malo));
      expect(res.ok, `deberia rechazar el slug "${malo}"`).toBe(false);
      if (res.ok) return;
      expect(res.field).toBe("slug");
      expect(res.reason).toBe(esperado.reason);
    }
  });

  it("RF_17: el choque con un nombre corto ya tomado se compara NORMALIZADO", async () => {
    // "Comunidad Andes" y "comunidad-andes" son el mismo enlace. Comparar lo tecleado deja pasar
    // el duplicado hasta la transaccion del servidor, que es justo lo que esto adelanta.
    const validar = await cargarValidadorDeConcesion();
    const res = validar(conCampoDeConcesion("slug", "Comunidad Andes"), {
      takenSlugs: ["comunidad-andes"]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("slug");
    expect(res.reason).toContain("comunidad-andes");

    // Y un nombre corto libre sigue pasando con la misma lista: la comparacion no rechaza todo.
    expect(validar(conCampoDeConcesion("slug", "andes-sur"), { takenSlugs: ["comunidad-andes"] }).ok).toBe(true);
  });

  it("RF_17: con varios campos mal se senala el primero del formulario", async () => {
    // Sin un orden fijado, "que campo se senala" queda al azar del implementador y cambia al
    // reordenar el codigo. El orden es el que se ve en pantalla: nombre, nombre corto, correo.
    const validar = await cargarValidadorDeConcesion();
    const todoMal = validar({ name: "", slug: "", targetEmail: "" });
    expect(todoMal.ok).toBe(false);
    if (todoMal.ok) return;
    expect(todoMal.field).toBe("name");

    const sinSlugNiCorreo = validar({ name: "Comunidad Andes", slug: "", targetEmail: "" });
    expect(sinSlugNiCorreo.ok).toBe(false);
    if (sinSlugNiCorreo.ok) return;
    expect(sinSlugNiCorreo.field).toBe("slug");
  });

  it("RF_17: no inventa valores por defecto ni deduce el nombre corto del nombre", async () => {
    const validar = await cargarValidadorDeConcesion();
    const res = validar({ name: "Comunidad Andes", slug: "", targetEmail: "marta@andes.co" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe("slug");
  });
});

/** El envoltorio de las callables, leido como texto: ver la cabecera de la guarda de T46. */
const AUTH_SOURCE = readFileSync(
  fileURLToPath(new URL("./firebase/auth.ts", import.meta.url)),
  "utf8"
);

/** La callable del servidor, tambien como texto. Importarla arrastraria firebase-admin. */
const COMMUNITIES_FUNCTIONS_SOURCE = readFileSync(
  fileURLToPath(new URL("../../functions/src/communities.ts", import.meta.url)),
  "utf8"
);

describe("T17 · RF_17: los dos caminos llegan hasta la pantalla", () => {
  it("RF_17: `grantCommunityLeadership` y `revokeCommunityLeadership` tienen envoltorio", () => {
    // Las dos estaban desplegadas y ninguna tenia envoltorio: desde el navegador no habia forma
    // de invocarlas. Control positivo con una que SI lo tiene desde el principio.
    expect(AUTH_SOURCE).toContain("export async function createCommunityLeader");
    expect(
      AUTH_SOURCE,
      "src/lib/firebase/auth.ts no envuelve grantCommunityLeadership: la callable no se puede invocar desde el navegador"
    ).toContain("export async function grantCommunityLeadership");
    expect(
      AUTH_SOURCE,
      "src/lib/firebase/auth.ts no envuelve revokeCommunityLeadership"
    ).toContain("export async function revokeCommunityLeadership");
    // Y que cada envoltorio apunte a SU callable, no dos veces a la misma.
    expect(AUTH_SOURCE).toContain('"grantCommunityLeadership"');
    expect(AUTH_SOURCE).toContain('"revokeCommunityLeadership"');
  });

  it("RF_17: la pantalla del segundo camino existe Y esta montada", () => {
    // El fallo de T46, otra vez: definir el componente no es tener la pantalla.
    expect(
      componentesDefinidos().has("GrantCommunityLeadershipForm"),
      "operations-app.tsx no define GrantCommunityLeadershipForm"
    ).toBe(true);
    expect(
      OPERATIONS_APP_SOURCE.includes("<GrantCommunityLeadershipForm"),
      "GrantCommunityLeadershipForm esta definido pero no se renderiza: es una pantalla que el administrador no puede abrir"
    ).toBe(true);
    // Y que valide con el hermano probado, no con una regla escrita a mano en el JSX.
    expect(lineaDeImportDe("@/lib/community-view")).toContain("validateCommunityGrantForm");
  });

  it("RF_17: la callable admite crear la comunidad y reserva su nombre corto", () => {
    // Control positivo: el camino viejo sigue ahi.
    expect(COMMUNITIES_FUNCTIONS_SOURCE).toContain("export const grantCommunityLeadership");

    const callable = COMMUNITIES_FUNCTIONS_SOURCE.slice(
      COMMUNITIES_FUNCTIONS_SOURCE.indexOf("const grantLeadershipSchema"),
      COMMUNITIES_FUNCTIONS_SOURCE.indexOf("async function pendingCommunityCashbackCop")
    );
    expect(callable.length).toBeGreaterThan(500);

    // El destino se puede indicar por correo: quien administra conoce el correo, no el uid.
    expect(callable, "grantCommunityLeadership no acepta targetEmail").toContain("targetEmail");
    // Y la comunidad se puede crear en el mismo acto, reservando el enlace como hace el alta.
    expect(callable, "grantCommunityLeadership no acepta crear la comunidad").toMatch(/\bname\b/);
    expect(callable, "el nombre corto de la comunidad nueva no se reserva").toContain("communitySlugs");
    expect(callable, "el nombre corto no pasa por validateSlug").toContain("validateSlug");
  });
});
