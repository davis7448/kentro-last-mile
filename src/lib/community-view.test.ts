import { describe, expect, it } from "vitest";
import { brandFor, roleLabel } from "./community-view";
import { buildPriceHistoryEntry, LOGO_MAX_BYTES, validateLogo } from "../../functions/src/community-pricing";

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
