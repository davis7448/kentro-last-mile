/**
 * T31 · Nucleo puro de la desactivacion en bloque (RF_41, RF_42).
 *
 * `planBulkSignupDisable` es la contencion ante un enlace filtrado: decide a quien alcanza
 * la desactivacion de un rango de fechas y —igual de importante— que deja intacto.
 *
 * Estas pruebas fijan la semantica que HOY vive suelta dentro de la callable
 * `disableCommunitySignupsInRange` (functions/src/communities.ts): filtro por
 * `communityId` mas `communityJoinedAt` entre `fromIso` y `toIso` con los dos extremos
 * incluidos, y como unico efecto sobre la tienda el sello `debtBlockedAt` mas el
 * `disabled: true` del usuario de Auth. T32 cablea la callable a este nucleo, y no puede
 * cambiar de comportamiento por el camino.
 */
import { describe, expect, it } from "vitest";
import {
  planBulkSignupDisable,
  planMassSignupAlertDismissal,
  summarizeBulkSignupDisable,
  type BulkSignupDisableAuthResult,
  type BulkSignupDisableSeller
} from "../../functions/src/community-containment";

const NOW = "2026-09-10T12:00:00.000Z";
const FROM = "2026-09-01T00:00:00.000Z";
const TO = "2026-09-05T23:59:59.999Z";

/**
 * Fixtures literales: ninguna prueba toca datos reales ni simula Firestore.
 * Los campos son los que escribe `community-signup.ts` al crear la tienda por enlace.
 */
const dentro: BulkSignupDisableSeller = {
  id: "seller-dentro",
  communityId: "com-1",
  communityJoinedAt: "2026-09-03T10:00:00.000Z",
  contactEmail: "dentro@tienda.co"
};

const enElBordeInicial: BulkSignupDisableSeller = {
  id: "seller-limite-inicial",
  communityId: "com-1",
  communityJoinedAt: FROM,
  contactEmail: "limite-inicial@tienda.co"
};

const enElBordeFinal: BulkSignupDisableSeller = {
  id: "seller-limite-final",
  communityId: "com-1",
  communityJoinedAt: TO,
  contactEmail: "limite-final@tienda.co"
};

const antesDelRango: BulkSignupDisableSeller = {
  id: "seller-antes",
  communityId: "com-1",
  communityJoinedAt: "2026-08-31T23:59:59.999Z",
  contactEmail: "antes@tienda.co"
};

const despuesDelRango: BulkSignupDisableSeller = {
  id: "seller-despues",
  communityId: "com-1",
  communityJoinedAt: "2026-09-06T00:00:00.000Z",
  contactEmail: "despues@tienda.co"
};

const otraComunidad: BulkSignupDisableSeller = {
  id: "seller-otra-comunidad",
  communityId: "com-2",
  communityJoinedAt: "2026-09-03T10:00:00.000Z",
  contactEmail: "otra@tienda.co"
};

/** Alta manual del admin, anterior a que existieran las comunidades: no tiene fecha de ingreso. */
const sinFechaDeIngreso: BulkSignupDisableSeller = {
  id: "seller-sin-fecha",
  communityId: "com-1",
  contactEmail: "sin-fecha@tienda.co"
};

const TODAS = [
  dentro,
  enElBordeInicial,
  enElBordeFinal,
  antesDelRango,
  despuesDelRango,
  otraComunidad,
  sinFechaDeIngreso
];

const plan = (sellers: BulkSignupDisableSeller[], overrides: Partial<{ fromIso: string; toIso: string }> = {}) =>
  planBulkSignupDisable({
    sellers,
    communityId: "com-1",
    fromIso: overrides.fromIso ?? FROM,
    toIso: overrides.toIso ?? TO,
    nowIso: NOW
  });

/**
 * Sin `.sort()` a proposito: el orden de salida ES parte del contrato del nucleo (`disable` y
 * `untouched` preservan el orden de entrada). Ordenar aqui no solo tapaba esa comprobacion:
 * `Array.prototype.sort()` sin comparador es lexicografico, asi que "seller-limite-final"
 * quedaba SIEMPRE antes de "seller-limite-inicial" y ninguna implementacion podia cuadrar.
 */
const idsAlcanzados = (sellers: BulkSignupDisableSeller[]) =>
  plan(sellers).disable.map((accion) => accion.sellerId);

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

describe("T31 · contencion: desactivacion en bloque por rango de fechas", () => {
  it("RF_41: una tienda que entro dentro del rango entra en el plan", () => {
    const resultado = plan([dentro]);
    expect(resultado.disable).toHaveLength(1);
    expect(resultado.disable[0]).toMatchObject({
      sellerId: "seller-dentro",
      contactEmail: "dentro@tienda.co",
      disableAuthUser: true,
      sellerUpdate: { debtBlockedAt: NOW }
    });
    expect(resultado.untouched).toEqual([]);
  });

  it("RF_41: los dos extremos del rango son inclusivos", () => {
    expect(idsAlcanzados([enElBordeInicial, enElBordeFinal])).toEqual([
      "seller-limite-inicial",
      "seller-limite-final"
    ]);
  });

  it("RF_41: un milisegundo fuera de cualquiera de los dos extremos queda intacto", () => {
    expect(idsAlcanzados([antesDelRango, despuesDelRango])).toEqual([]);
    expect(plan([antesDelRango, despuesDelRango]).untouched).toEqual([
      { sellerId: "seller-antes", reason: "out_of_range" },
      { sellerId: "seller-despues", reason: "out_of_range" }
    ]);
  });

  it("RF_41: una tienda de la MISMA comunidad pero fuera del rango queda intacta", () => {
    const resultado = plan([dentro, antesDelRango, despuesDelRango]);
    expect(resultado.disable.map((accion) => accion.sellerId)).toEqual(["seller-dentro"]);
    expect(resultado.untouched.map((fuera) => fuera.sellerId).sort()).toEqual([
      "seller-antes",
      "seller-despues"
    ]);
  });

  it("RF_41: una tienda dentro del rango pero de OTRA comunidad queda intacta", () => {
    const resultado = plan([dentro, otraComunidad]);
    expect(resultado.disable.map((accion) => accion.sellerId)).toEqual(["seller-dentro"]);
    expect(resultado.untouched).toEqual([{ sellerId: "seller-otra-comunidad", reason: "other_community" }]);
  });

  it("RF_41: una tienda sin comunidad tampoco entra, aunque la fecha caiga dentro", () => {
    const huerfana: BulkSignupDisableSeller = {
      id: "seller-sin-comunidad",
      communityJoinedAt: "2026-09-03T10:00:00.000Z",
      contactEmail: "huerfana@tienda.co"
    };
    expect(plan([huerfana]).disable).toEqual([]);
    expect(plan([huerfana]).untouched).toEqual([
      { sellerId: "seller-sin-comunidad", reason: "other_community" }
    ]);
  });

  it("RF_41: una tienda sin communityJoinedAt no entra en el plan", () => {
    // La consulta real (`where(\"communityJoinedAt\", \">=\", fromIso)`) ya excluye de raiz a los
    // documentos que no tienen el campo, asi que este caso solo llega si alguien alimenta el
    // nucleo desde otro sitio. Excluirla es lo unico correcto: no se sabe por que enlace entro.
    expect(plan([sinFechaDeIngreso]).disable).toEqual([]);
    expect(plan([sinFechaDeIngreso]).untouched).toEqual([
      { sellerId: "seller-sin-fecha", reason: "no_join_date" }
    ]);
  });

  it("RF_41: una fecha de ingreso ilegible no se desactiva a ciegas, se reporta", () => {
    const rota: BulkSignupDisableSeller = {
      id: "seller-fecha-rota",
      communityId: "com-1",
      communityJoinedAt: "ayer por la tarde",
      contactEmail: "rota@tienda.co"
    };
    expect(plan([rota]).disable).toEqual([]);
    expect(plan([rota]).untouched).toEqual([
      { sellerId: "seller-fecha-rota", reason: "invalid_join_date" }
    ]);
  });

  it("RF_41: el rango compara instantes, no cadenas: otro huso o sin milisegundos cuenta igual", () => {
    // "2026-08-31T19:00:00-05:00" es exactamente FROM en hora de Cali, y ordenado como texto
    // caeria fuera. La contencion no puede depender de como se escribio la fecha.
    const mismoInstanteEnCali: BulkSignupDisableSeller = {
      id: "seller-cali",
      communityId: "com-1",
      communityJoinedAt: "2026-08-31T19:00:00-05:00",
      contactEmail: "cali@tienda.co"
    };
    const sinMilisegundos: BulkSignupDisableSeller = {
      id: "seller-sin-ms",
      communityId: "com-1",
      communityJoinedAt: "2026-09-03T10:00:00Z",
      contactEmail: "sin-ms@tienda.co"
    };
    expect(idsAlcanzados([mismoInstanteEnCali, sinMilisegundos])).toEqual([
      "seller-cali",
      "seller-sin-ms"
    ]);
  });

  it("RF_41: un rango invertido no desactiva a nadie", () => {
    const resultado = plan(TODAS, { fromIso: TO, toIso: FROM });
    expect(resultado.disable).toEqual([]);
    expect(resultado.untouched).toHaveLength(TODAS.length);
  });

  it("RF_41: una tienda ya bloqueada se vuelve a desactivar, pero conserva su sello original", () => {
    // El remedio se corre mas de una vez: la primera pasada pudo dejar la cuenta de Auth activa
    // (T32). Reintentar no debe borrar cuando se bloqueo por primera vez.
    const yaBloqueada: BulkSignupDisableSeller = {
      ...dentro,
      id: "seller-ya-bloqueada",
      debtBlockedAt: "2026-09-04T08:00:00.000Z"
    };
    const accion = plan([yaBloqueada]).disable[0];
    expect(accion.sellerId).toBe("seller-ya-bloqueada");
    expect(accion.disableAuthUser).toBe(true);
    expect(accion.sellerUpdate.debtBlockedAt).toBe("2026-09-04T08:00:00.000Z");
    expect(accion.alreadyBlocked).toBe(true);
  });

  it("RF_41: una tienda sin correo de contacto entra igual, y el plan lo declara nulo", () => {
    // Su documento SI se puede bloquear; el usuario de Auth no se puede ni buscar. T32 tiene que
    // poder contarla como fallida en vez de dar por hecha una desactivacion que no ocurrio.
    const sinCorreo: BulkSignupDisableSeller = {
      id: "seller-sin-correo",
      communityId: "com-1",
      communityJoinedAt: "2026-09-03T10:00:00.000Z"
    };
    const accion = plan([sinCorreo]).disable[0];
    expect(accion.sellerId).toBe("seller-sin-correo");
    expect(accion.contactEmail).toBeNull();
    expect(accion.sellerUpdate.debtBlockedAt).toBe(NOW);
  });

  it("RF_41: no se pierde ninguna tienda: cada entrada sale alcanzada o intacta, nunca en silencio", () => {
    const resultado = plan(TODAS);
    const vistos = [
      ...resultado.disable.map((accion) => accion.sellerId),
      ...resultado.untouched.map((fuera) => fuera.sellerId)
    ].sort();
    expect(vistos).toEqual(TODAS.map((seller) => seller.id).sort());
    expect(resultado.disable).toHaveLength(3);
    expect(resultado.untouched).toHaveLength(4);
  });

  it("RF_41: el instante lo pone quien llama, no un reloj global", () => {
    const otroInstante = "2027-01-31T05:00:00.000Z";
    const resultado = planBulkSignupDisable({
      sellers: [dentro],
      communityId: "com-1",
      fromIso: FROM,
      toIso: TO,
      nowIso: otroInstante
    });
    expect(resultado.disable[0].sellerUpdate.debtBlockedAt).toBe(otroInstante);
  });

  it("RF_42: el plan solo escribe debtBlockedAt en la tienda, ningun campo mas", () => {
    for (const accion of plan(TODAS).disable) {
      expect(Object.keys(accion.sellerUpdate)).toEqual(["debtBlockedAt"]);
    }
  });

  it("RF_42: el plan no contiene ninguna orden de borrado, ni hoy ni cuando alguien lo amplie", () => {
    // Deliberadamente NO se comprueban los campos de hoy uno a uno: se recorre el plan ENTERO,
    // claves y valores a cualquier profundidad, buscando cualquier rastro de destruccion. Una
    // operacion nueva que borre algo tendra que nombrarlo, y esta prueba la vera.
    const prohibido = /delete|remove|destroy|purge|erase|drop|wipe|clear|truncate|borr|elimin|anul/i;
    const encontrados: string[] = [];
    recorrerPlan(plan(TODAS), (fragment) => {
      if (prohibido.test(fragment)) encontrados.push(fragment);
    });
    expect(encontrados).toEqual([]);
  });

  it("RF_42: el plan no nombra pedidos, asientos de wallet, cortes ni inventario", () => {
    // El historial de dinero de estas tiendas queda intacto: si el plan ni siquiera puede
    // mencionar esas colecciones, no hay forma de que las toque.
    const intocable = /order|wallet|settlement|liquidac|pedido|inventor|stock|cashback|payout|remittance|ledger/i;
    const encontrados: string[] = [];
    recorrerPlan(plan(TODAS), (fragment) => {
      if (intocable.test(fragment)) encontrados.push(fragment);
    });
    expect(encontrados).toEqual([]);
  });

  it("RF_42: el plan declara que solo alcanza a la tienda y a su acceso", () => {
    const resultado = plan(TODAS);
    expect([...resultado.collectionsTouched].sort()).toEqual(["authUsers", "sellers"]);
  });

  it("RF_41: el plan devuelve el rango con el que se calculo, para poder auditarlo", () => {
    const resultado = plan([dentro]);
    expect(resultado.communityId).toBe("com-1");
    expect(resultado.fromIso).toBe(FROM);
    expect(resultado.toIso).toBe(TO);
  });
});

/**
 * T32 · El informe de la desactivacion en bloque (RF_41, RF_42, RF_53).
 *
 * El plan de T31 dice a quien HAY que cerrarle el acceso. Esto dice a quien se le cerro DE
 * VERDAD, que es otra cosa. Hoy la callable `disableCommunitySignupsInRange` las confunde:
 *
 *   const users = await auth.getUsers([{ email: ... }]).catch(() => null);
 *   for (const user of users?.users ?? []) await auth.updateUser(user.uid, { disabled: true });
 *   disabled.push(doc.id);
 *
 * El `.catch(() => null)` se traga el fallo de la busqueda y el bucle interior no itera cuando
 * no hay usuario; en los dos casos la cuenta de Auth sigue viva y el `sellerId` se empuja igual
 * a `disabled`. El administrador lee "18 tiendas desactivadas", da por contenida la fuga y hay
 * cuentas que siguen entrando: la regla de oro #5 del CLAUDE.md en su version peor, porque aqui
 * lo que se pierde no es un saldo sino el UNICO remedio que la spec reconoce ante un enlace
 * filtrado (RF_41).
 *
 * Por eso el reparto no lo decide quien llama: `summarizeBulkSignupDisable` recibe lo que Auth
 * contesto —en crudo— y deriva el veredicto. Una tienda solo cuenta como desactivada si consta
 * al menos un acceso efectivamente cerrado. Todo lo demas es un fallo con nombre.
 *
 * La callable no se puede importar desde aqui (la raiz no instala `firebase-admin`), asi que
 * todo lo afirmable vive en el nucleo puro. La callable queda reducida a: leer, ejecutar y
 * pasar por aqui lo que le contesten.
 */

/** Lo que Auth contesto por cada tienda planeada, en crudo y sin interpretar. */
const cerrado = (...uids: string[]): BulkSignupDisableAuthResult => ({ kind: "disabled", uids });
const sinUsuario: BulkSignupDisableAuthResult = { kind: "not_found" };
const busquedaFallida: BulkSignupDisableAuthResult = { kind: "lookup_error" };
const cierreFallido: BulkSignupDisableAuthResult = { kind: "update_error" };

/** Tienda alcanzada por el rango pero sin correo: su acceso no se puede ni buscar. */
const sinCorreoDeContacto: BulkSignupDisableSeller = {
  id: "seller-sin-correo-contacto",
  communityId: "com-1",
  communityJoinedAt: "2026-09-03T10:00:00.000Z"
};

const informe = (
  sellers: BulkSignupDisableSeller[],
  authResults: { sellerId: string; result: BulkSignupDisableAuthResult }[]
) => summarizeBulkSignupDisable({ plan: plan(sellers), authResults });

const idsDesactivados = (
  sellers: BulkSignupDisableSeller[],
  authResults: { sellerId: string; result: BulkSignupDisableAuthResult }[]
) => informe(sellers, authResults).disabled.map((cuenta) => cuenta.sellerId);

describe("T32 · contencion: quien quedo desactivado de verdad y quien no", () => {
  it("RF_41: una tienda cuyo acceso se cerro sale en disabled, con los accesos que se cerraron", () => {
    const resultado = informe([dentro], [{ sellerId: "seller-dentro", result: cerrado("uid-dentro") }]);
    expect(resultado.disabled).toEqual([{ sellerId: "seller-dentro", authUids: ["uid-dentro"] }]);
    expect(resultado.failed).toEqual([]);
  });

  it("RF_41: si la busqueda en Auth lanza, la tienda sale en failed y NUNCA en disabled", () => {
    // Este es el fallo mudo literal: hoy `.catch(() => null)` se lo traga y el sellerId se
    // reporta como desactivado con la cuenta viva.
    const resultado = informe([dentro], [{ sellerId: "seller-dentro", result: busquedaFallida }]);
    expect(resultado.disabled).toEqual([]);
    expect(resultado.failed).toEqual([{ sellerId: "seller-dentro", reason: "auth_lookup_failed" }]);
  });

  it("RF_41: si el correo no corresponde a ningun usuario, la tienda sale en failed", () => {
    // La otra mitad del fallo: el bucle interior no itera y aun asi se contaba como cerrada.
    const resultado = informe([dentro], [{ sellerId: "seller-dentro", result: sinUsuario }]);
    expect(resultado.disabled).toEqual([]);
    expect(resultado.failed).toEqual([{ sellerId: "seller-dentro", reason: "no_auth_user" }]);
  });

  it("RF_41: una respuesta de Auth sin ningun acceso cerrado vale lo mismo que no encontrar usuario", () => {
    // `getUsers` puede contestar bien y con la lista vacia. Cero accesos cerrados es cero
    // contencion, se llame como se llame la respuesta.
    const resultado = informe([dentro], [{ sellerId: "seller-dentro", result: cerrado() }]);
    expect(resultado.disabled).toEqual([]);
    expect(resultado.failed).toEqual([{ sellerId: "seller-dentro", reason: "no_auth_user" }]);
  });

  it("RF_41: si cerrar el acceso lanza, la tienda sale en failed con su propio motivo", () => {
    const resultado = informe([dentro], [{ sellerId: "seller-dentro", result: cierreFallido }]);
    expect(resultado.disabled).toEqual([]);
    expect(resultado.failed).toEqual([{ sellerId: "seller-dentro", reason: "auth_update_failed" }]);
  });

  it("RF_41: una tienda sin correo de contacto sale en failed sin haber intentado nada", () => {
    // T31 ya la deja en el plan con `contactEmail: null`: su documento SI se sella, pero su
    // acceso no se puede ni buscar. No hay nada que informar salvo que sigue viva.
    const resultado = informe([sinCorreoDeContacto], []);
    expect(resultado.disabled).toEqual([]);
    expect(resultado.failed).toEqual([
      { sellerId: "seller-sin-correo-contacto", reason: "no_contact_email" }
    ]);
  });

  it("RF_41: una tienda sin correo no cuenta como desactivada aunque quien llame lo afirme", () => {
    // El veredicto no lo pone la callable. Si un dia alguien le pasa un cierre inventado para
    // una tienda cuyo acceso no se puede buscar, el nucleo no lo acepta.
    expect(idsDesactivados(
      [sinCorreoDeContacto],
      [{ sellerId: "seller-sin-correo-contacto", result: cerrado("uid-inventado") }]
    )).toEqual([]);
  });

  it("RF_41: una tienda planeada de la que no hay respuesta no se da por buena", () => {
    // Un `return` a mitad del bucle, una excepcion que corta la pasada: lo que no se intento
    // no se cuenta como contenido.
    const resultado = informe([dentro], []);
    expect(resultado.disabled).toEqual([]);
    expect(resultado.failed).toEqual([{ sellerId: "seller-dentro", reason: "not_attempted" }]);
  });

  it("RF_41: el sello de la tienda es independiente de que Auth responda", () => {
    // El documento se bloquea igual —es una escritura propia, no depende de Auth—; lo que no
    // puede pasar es que un bloqueo escrito se lea como un acceso cerrado.
    const resultado = informe(
      [dentro, sinCorreoDeContacto],
      [{ sellerId: "seller-dentro", result: busquedaFallida }]
    );
    expect(resultado.blocked).toEqual(["seller-dentro", "seller-sin-correo-contacto"]);
    expect(resultado.disabled).toEqual([]);
  });

  it("RF_41: no se pierde ninguna planeada: cada una sale desactivada o fallida", () => {
    const resultado = informe(TODAS, [
      { sellerId: "seller-dentro", result: cerrado("uid-dentro") },
      { sellerId: "seller-limite-inicial", result: busquedaFallida }
    ]);
    const vistas = [
      ...resultado.disabled.map((cuenta) => cuenta.sellerId),
      ...resultado.failed.map((fallo) => fallo.sellerId)
    ].sort();
    expect(vistas).toEqual(plan(TODAS).disable.map((accion) => accion.sellerId).sort());
    expect(resultado.disabled).toHaveLength(1);
    expect(resultado.failed).toHaveLength(2);
  });

  it("RF_41: el informe arrastra intactas las tiendas que el filtro dejo fuera", () => {
    // Las que el plan descarto siguen contadas con su motivo: T31 existe para que ninguna
    // desaparezca en silencio, y el informe no puede deshacer eso.
    expect(informe(TODAS, []).untouched).toEqual(plan(TODAS).untouched);
  });

  it("RF_41: el orden es el del plan, no el de las respuestas de Auth", () => {
    const resultado = informe(TODAS, [
      { sellerId: "seller-limite-final", result: sinUsuario },
      { sellerId: "seller-limite-inicial", result: busquedaFallida },
      { sellerId: "seller-dentro", result: cerrado("uid-dentro") }
    ]);
    expect(resultado.disabled.map((cuenta) => cuenta.sellerId)).toEqual(["seller-dentro"]);
    expect(resultado.failed.map((fallo) => fallo.sellerId)).toEqual([
      "seller-limite-inicial",
      "seller-limite-final"
    ]);
  });

  it("RF_41: una respuesta sobre una tienda que el plan dejo intacta no la mete en el informe", () => {
    // Contener de mas es tan grave como contener de menos: una tienda de otra comunidad no
    // puede aparecer cerrada porque alguien colara su resultado.
    const resultado = informe(
      [dentro, otraComunidad],
      [
        { sellerId: "seller-dentro", result: cerrado("uid-dentro") },
        { sellerId: "seller-otra-comunidad", result: cerrado("uid-ajeno") }
      ]
    );
    expect(resultado.disabled.map((cuenta) => cuenta.sellerId)).toEqual(["seller-dentro"]);
    expect(resultado.failed).toEqual([]);
    expect(resultado.blocked).toEqual(["seller-dentro"]);
  });

  it("RF_41: el informe devuelve el rango con el que se calculo, para poder auditarlo", () => {
    const resultado = informe([dentro], []);
    expect(resultado.communityId).toBe("com-1");
    expect(resultado.fromIso).toBe(FROM);
    expect(resultado.toIso).toBe(TO);
  });

  it("RF_42: el informe no contiene ninguna orden de borrado, ni hoy ni cuando alguien lo amplie", () => {
    // Mismo enfoque que T31: se recorre el informe ENTERO, claves y valores a cualquier
    // profundidad. Una operacion nueva que borre algo tendra que nombrarlo, y esto la vera.
    const prohibido = /delete|remove|destroy|purge|erase|drop|wipe|clear|truncate|borr|elimin|anul/i;
    const encontrados: string[] = [];
    recorrerPlan(
      informe(TODAS, [
        { sellerId: "seller-dentro", result: cerrado("uid-dentro") },
        { sellerId: "seller-limite-inicial", result: busquedaFallida }
      ]),
      (fragment) => {
        if (prohibido.test(fragment)) encontrados.push(fragment);
      }
    );
    expect(encontrados).toEqual([]);
  });

  it("RF_42: el informe no nombra pedidos, asientos de wallet, cortes ni inventario", () => {
    // Ni siquiera para explicar un fallo: los motivos son un enumerado cerrado y no llevan
    // texto libre, precisamente para que este barrido siga significando algo.
    const intocable = /order|wallet|settlement|liquidac|pedido|inventor|stock|cashback|payout|remittance|ledger/i;
    const encontrados: string[] = [];
    recorrerPlan(
      informe(TODAS, [
        { sellerId: "seller-dentro", result: cerrado("uid-dentro") },
        { sellerId: "seller-limite-inicial", result: cierreFallido }
      ]),
      (fragment) => {
        if (intocable.test(fragment)) encontrados.push(fragment);
      }
    );
    expect(encontrados).toEqual([]);
  });

  it("RF_42: el informe declara que solo alcanza a la tienda y a su acceso", () => {
    expect([...informe(TODAS, []).collectionsTouched].sort()).toEqual(["authUsers", "sellers"]);
  });
});

describe("T32 · descartar el aviso de captacion masiva", () => {
  // Se invoca dentro de cada `it` y no en el cuerpo del `describe`: una excepcion aqui arriba
  // tumba la recoleccion del archivo entero y se llevaria por delante los casos de T31.
  const descarte = () => planMassSignupAlertDismissal({ communityId: "com-1", nowIso: NOW });

  it("RF_53: descartar el aviso solo sella la comunidad", () => {
    expect(descarte().communityId).toBe("com-1");
    expect(descarte().communityUpdate).toEqual({ massSignupAlertDismissedAt: NOW });
  });

  it("RF_53: descartar el aviso no desactiva a nadie, ni cuando alguien amplie la operacion", () => {
    // Deliberadamente NO se comprueban los campos de hoy uno a uno: se recorre el plan entero
    // buscando cualquier rastro de cierre de accesos. Un lider que capta en un evento dispara
    // el aviso sin hacer nada malo; descartarlo no puede costarle las cuentas de sus tiendas.
    const contencion = /disable|deshabilit|desactiv|revoke|suspend|block|auth|seller|tienda|cuenta/i;
    const encontrados: string[] = [];
    recorrerPlan(descarte(), (fragment) => {
      if (contencion.test(fragment)) encontrados.push(fragment);
    });
    expect(encontrados).toEqual([]);
  });

  it("RF_53: el plan de descarte no alcanza ni a las tiendas ni a sus accesos", () => {
    expect([...descarte().collectionsTouched]).toEqual(["communities"]);
  });

  it("RF_53: el plan de descarte no contiene ninguna orden de borrado", () => {
    const prohibido = /delete|remove|destroy|purge|erase|drop|wipe|clear|truncate|borr|elimin|anul/i;
    const encontrados: string[] = [];
    recorrerPlan(descarte(), (fragment) => {
      if (prohibido.test(fragment)) encontrados.push(fragment);
    });
    expect(encontrados).toEqual([]);
  });

  it("RF_53: el instante lo pone quien llama, no un reloj global", () => {
    const otroInstante = "2027-01-31T05:00:00.000Z";
    expect(
      planMassSignupAlertDismissal({ communityId: "com-1", nowIso: otroInstante }).communityUpdate
    ).toEqual({ massSignupAlertDismissedAt: otroInstante });
  });
});
