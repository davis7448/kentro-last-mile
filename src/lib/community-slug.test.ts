import { beforeEach, describe, expect, it } from "vitest";
import { RETIRED_SLUG_GRACE_DAYS, isRetiredSlugStillValid, normalizeSlug, validateSlug } from "../../functions/src/community-slug";

const day = 24 * 60 * 60 * 1000;
const at = (base: string, days: number) => new Date(Date.parse(base) + days * day).toISOString();

describe("T2 · nombre corto del enlace", () => {
  it("RF_02: normaliza a minusculas, sin acentos y con guiones", () => {
    expect(normalizeSlug("  Comunidad Ñandú  ")).toBe("comunidad-nandu");
    expect(normalizeSlug("Los Andes 2026")).toBe("los-andes-2026");
    expect(normalizeSlug("a---b")).toBe("a-b");
  });

  it("RF_04: rechaza slugs reservados", () => {
    for (const reserved of ["admin", "api", "registro", "login"]) {
      expect(validateSlug(reserved).ok).toBe(false);
    }
  });

  it("RF_04: rechaza los que quedan fuera de forma o longitud", () => {
    expect(validateSlug("ab").ok).toBe(false);
    expect(validateSlug("a".repeat(33)).ok).toBe(false);
    expect(validateSlug("").ok).toBe(false);
    expect(validateSlug("///").ok).toBe(false);
    expect(validateSlug("--").ok).toBe(false);
  });

  it("RF_02: el espacio y el guion inicial se normalizan, no se rechazan", () => {
    // Rechazarlos seria hostil: el lider escribe el nombre de su comunidad, no una URL.
    expect(validateSlug("con espacio")).toEqual({ ok: true, slug: "con-espacio" });
    expect(validateSlug("-empieza-con-guion")).toEqual({ ok: true, slug: "empieza-con-guion" });
  });

  it("RF_02: acepta un slug valido y devuelve el normalizado", () => {
    const result = validateSlug("Mi Comunidad");
    expect(result.ok).toBe(true);
    expect(result.ok && result.slug).toBe("mi-comunidad");
  });

  it("RF_03: un slug retirado sigue valido 30 dias y deja de serlo despues", () => {
    const retiredAt = "2026-09-01T00:00:00.000Z";
    expect(RETIRED_SLUG_GRACE_DAYS).toBe(30);
    expect(isRetiredSlugStillValid(retiredAt, at(retiredAt, 29))).toBe(true);
    expect(isRetiredSlugStillValid(retiredAt, at(retiredAt, 31))).toBe(false);
  });

  it("RF_03: un slug vigente (sin fecha de retirada) siempre vale", () => {
    expect(isRetiredSlugStillValid(undefined, "2030-01-01T00:00:00.000Z")).toBe(true);
  });
});

/**
 * T40 · Rechazar un nombre corto NO puede costar el que ya tenias (RF_04).
 *
 * De RF_04 ya se prueba la mitad facil, arriba: que un slug reservado o mal formado se
 * RECHAZA (`validateSlug`). Lo que no esta probado es la otra mitad del requisito, que es la
 * que cuesta dinero:
 *
 *   RF_04: "...el sistema MUST rechazarlo, explicar el motivo y MUST conservar el anterior."
 *
 * El modo de fallo no es aceptar un slug malo. Es un rechazo que ademas deja a la comunidad
 * SIN nombre corto: el enlace de registro es la unica puerta de entrada de una tienda referida
 * (RF_02) y el lider lo reparte impreso, por WhatsApp y en eventos. Si un intento fallido de
 * renombrar borra el vigente, todos esos enlaces mueren de golpe y en silencio — nadie ve un
 * error, simplemente dejan de llegar altas.
 *
 * Hoy `setCommunitySlug` (functions/src/communities.ts:158) conserva el anterior por
 * CASUALIDAD: los `throw new HttpsError` salen antes de que la transaccion escriba nada. Eso es
 * cierto de la forma de hoy y de ninguna otra. Nada impide que manana alguien mueva la reserva
 * del slug nuevo antes de la comprobacion, o anada un `transaction.delete` del viejo "para
 * limpiar", y las siete pruebas de arriba seguirian verdes.
 *
 * Por eso el rechazo tiene que ser un DATO y no un `throw`: un plan puro `planSlugChange` que
 * declare que se escribe, para poder afirmar sobre la estructura ENTERA que un rechazo no
 * ordena NADA. Es el mismo instrumento de T31/T32/T36/T37 y la unica razon por la que se elige
 * es esta: comprobar campo por campo no dice nada de la operacion que alguien anada manana; un
 * barrido sobre el plan entero, si.
 *
 * Dos hallazgos de leer la callable de hoy, que estas pruebas fijan:
 *
 *  1. `if (nextSnap.exists) throw "ya esta en uso"` no mira DE QUIEN es el documento. El slug
 *     que el propio lider acaba de retirar sigue existiendo treinta dias (RF_03), asi que
 *     volver a tu nombre anterior te lo rechaza diciendote que lo tiene otro. Es tuyo.
 *  2. El camino de aceptacion tiene que seguir retirando el anterior con gracia de 30 dias
 *     (RF_03, ya probado en `isRetiredSlugStillValid`): retirar y BORRAR no son lo mismo, y el
 *     plan tiene que ordenar lo primero.
 */

/** Una escritura declarada, no ejecutada. La callable la traduce a la transaccion. */
type SlugWrite = {
  collection: "communities" | "communitySlugs";
  docId: string;
  /** `set` reemplaza el documento entero (y con el, un `retiredAt` viejo); `merge` lo respeta. */
  op: "set" | "merge" | "update";
  data: Record<string, string>;
};

type SlugChangeRejection = {
  ok: false;
  /** Los tres motivos que nombra RF_04, distinguibles entre si sin leer prosa. */
  reasonCode: "invalid" | "reserved" | "taken";
  /** El motivo en castellano, para el lider. */
  reason: string;
  previousSlug: string | null;
  /** El que queda VIGENTE tras la operacion. En un rechazo es, por fuerza, el anterior. */
  effectiveSlug: string | null;
  writes: readonly SlugWrite[];
};

type SlugChangeAcceptance = {
  ok: true;
  previousSlug: string | null;
  effectiveSlug: string;
  changed: boolean;
  writes: readonly SlugWrite[];
};

type SlugChangePlan = SlugChangeRejection | SlugChangeAcceptance;

type SlugChangeInput = {
  community: { id: string; slug?: string };
  /** Lo que el lider escribio, en crudo: normalizar es cosa del plan. */
  requestedSlug: string;
  /**
   * De quien es HOY el documento `communitySlugs/{slug normalizado}`, vigente o retirado.
   * `null`/ausente = libre. Lo lee la callable dentro de la transaccion y lo pasa aqui.
   */
  takenByCommunityId?: string | null;
  nowIso: string;
};

type PlanSlugChange = (input: SlugChangeInput) => SlugChangePlan;

/**
 * Carga diferida, por lo mismo que en T36: `community-slug.ts` ya existe, asi que importar de
 * forma estatica un export que todavia no esta es un error de ENLACE de ESM y tumba la
 * recoleccion del archivo entero, llevandose por delante los 7 casos de T2 que ya estan verdes.
 */
let planSlugChange: PlanSlugChange;

const cargarPlanSlug = async (): Promise<void> => {
  const modulo = (await import("../../functions/src/community-slug")) as unknown as {
    planSlugChange?: PlanSlugChange;
  };
  if (!modulo.planSlugChange) {
    throw new Error("T40: functions/src/community-slug.ts debe exportar `planSlugChange`.");
  }
  planSlugChange = modulo.planSlugChange;
};

/** Recorre la estructura ENTERA: claves y valores de texto, a cualquier profundidad. */
const recorrerPlan = (value: unknown, visit: (fragment: string) => void, saltar: ReadonlySet<string>): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recorrerPlan(item, visit, saltar);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      if (!saltar.has(key)) recorrerPlan(inner, visit, saltar);
    }
  }
};

/**
 * `reason` es prosa dirigida al lider y puede decir legitimamente "no se guardo"; el barrido no
 * la mira. `writes` si se mira POR DENTRO: el nombre del contenedor no es una orden, su
 * contenido si.
 */
const PROSA: ReadonlySet<string> = new Set(["reason"]);

const fragmentosQueCoinciden = (plan: unknown, prohibido: RegExp): string[] => {
  const encontrados: string[] = [];
  recorrerPlan(
    plan,
    (fragment) => {
      if (prohibido.test(fragment)) encontrados.push(fragment);
    },
    PROSA
  );
  return encontrados;
};

/**
 * Cualquier rastro de una orden sobre Firestore: a que coleccion, a que documento, con que
 * verbo. Un rechazo no puede contener ninguno, hoy ni cuando alguien amplie el plan.
 */
const ORDEN_DE_ESCRITURA =
  /collection|docId|firestore|transaction|batch|\bset\b|\bupdate\b|\bmerge\b|delete|remove|escrib|guard|retir|borr|elimin/i;

const AHORA = "2026-09-10T12:00:00.000Z";
const VIGENTE = "comunidad-andes";
const COMUNIDAD = { id: "com-1", slug: VIGENTE };

const rechazo = (plan: SlugChangePlan): SlugChangeRejection => {
  if (plan.ok) throw new Error(`Se esperaba un rechazo y el plan acepto: ${JSON.stringify(plan)}`);
  return plan;
};

const aceptacion = (plan: SlugChangePlan): SlugChangeAcceptance => {
  if (!plan.ok) throw new Error(`Se esperaba una aceptacion y el plan rechazo: ${plan.reason}`);
  return plan;
};

const escrituraEn = (plan: SlugChangeAcceptance, collection: SlugWrite["collection"], docId: string): SlugWrite => {
  const encontrada = plan.writes.find((write) => write.collection === collection && write.docId === docId);
  if (!encontrada) throw new Error(`El plan no escribe en ${collection}/${docId}: ${JSON.stringify(plan.writes)}`);
  return encontrada;
};

describe("T40 · rechazar un nombre corto conserva el anterior", () => {
  // Dentro del describe y no en la raiz: un gancho de raiz que falle marca en rojo TODOS los
  // casos del archivo, incluidos los 7 de T2. Y `beforeEach` en vez de `beforeAll` para que,
  // mientras el modulo no exporte nada, los casos salgan FALLIDOS uno a uno y no omitidos.
  beforeEach(cargarPlanSlug);

  it("RF_04: un nombre corto ya en uso por otra comunidad se rechaza y deja el anterior vigente", () => {
    const plan = rechazo(
      planSlugChange({
        community: COMUNIDAD,
        requestedSlug: "Comunidad Pacifico",
        takenByCommunityId: "com-9",
        nowIso: AHORA
      })
    );
    expect(plan.reasonCode).toBe("taken");
    expect(plan.reason.trim().length).toBeGreaterThan(0);
    expect(plan.previousSlug).toBe(VIGENTE);
    // El corazon del requisito: despues del rechazo el enlace repartido sigue siendo el mismo.
    expect(plan.effectiveSlug).toBe(VIGENTE);
    expect(plan.writes).toEqual([]);
  });

  it("RF_04: una palabra reservada por la plataforma se rechaza y deja el anterior vigente", () => {
    for (const reservada of ["admin", "api", "registro", "login", "_next"]) {
      const plan = rechazo(
        planSlugChange({ community: COMUNIDAD, requestedSlug: reservada, takenByCommunityId: null, nowIso: AHORA })
      );
      expect(plan.reasonCode).toBe("reserved");
      expect(plan.reason.trim().length).toBeGreaterThan(0);
      expect(plan.effectiveSlug).toBe(VIGENTE);
      expect(plan.writes).toEqual([]);
    }
  });

  it("RF_04: los caracteres no permitidos se rechazan y dejan el anterior vigente", () => {
    // Todo lo que `normalizeSlug` no puede convertir en un slug utilizable: solo simbolos, solo
    // guiones, demasiado corto, demasiado largo, o nada.
    for (const escrito of ["%%%", "---", "@/@", "ab", "", "   ", "a".repeat(40)]) {
      const plan = rechazo(
        planSlugChange({ community: COMUNIDAD, requestedSlug: escrito, takenByCommunityId: null, nowIso: AHORA })
      );
      expect(plan.reasonCode).toBe("invalid");
      expect(plan.reason.trim().length).toBeGreaterThan(0);
      expect(plan.effectiveSlug).toBe(VIGENTE);
      expect(plan.writes).toEqual([]);
    }
  });

  it("RF_04: los tres motivos son distinguibles entre si, en codigo y en texto", () => {
    // El lider tiene que saber CUAL de los tres le paso: "esta cogido" se arregla eligiendo
    // otro, "es reservado" tambien, pero "tiene caracteres raros" se arregla escribiendo bien
    // el mismo. Un unico "nombre corto invalido" para los tres lo deja adivinando.
    const enUso = rechazo(
      planSlugChange({ community: COMUNIDAD, requestedSlug: "pacifico", takenByCommunityId: "com-9", nowIso: AHORA })
    );
    const reservado = rechazo(
      planSlugChange({ community: COMUNIDAD, requestedSlug: "admin", takenByCommunityId: null, nowIso: AHORA })
    );
    const invalido = rechazo(
      planSlugChange({ community: COMUNIDAD, requestedSlug: "%%%", takenByCommunityId: null, nowIso: AHORA })
    );

    const codigos = [enUso.reasonCode, reservado.reasonCode, invalido.reasonCode];
    expect(new Set(codigos).size).toBe(3);
    const textos = [enUso.reason, reservado.reason, invalido.reason];
    expect(new Set(textos).size).toBe(3);
  });

  it("RF_04: el rechazo no ordena NINGUNA escritura, en ninguna parte del plan", () => {
    // Barrido sobre el resultado ENTERO, no sobre los campos de hoy. Si manana alguien anade al
    // plan una limpieza del slug viejo, o una reserva anticipada del nuevo, esto se pone rojo
    // aunque nadie toque esta prueba.
    const rechazos = [
      planSlugChange({ community: COMUNIDAD, requestedSlug: "pacifico", takenByCommunityId: "com-9", nowIso: AHORA }),
      planSlugChange({ community: COMUNIDAD, requestedSlug: "admin", takenByCommunityId: null, nowIso: AHORA }),
      planSlugChange({ community: COMUNIDAD, requestedSlug: "%%%", takenByCommunityId: null, nowIso: AHORA })
    ];
    for (const plan of rechazos) {
      const rechazado = rechazo(plan);
      expect(rechazado.writes).toHaveLength(0);
      expect(fragmentosQueCoinciden(rechazado, ORDEN_DE_ESCRITURA)).toEqual([]);
    }
  });

  it("RF_04: un rechazo tampoco puede quedarse con el slug pedido como vigente", () => {
    // El fallo simetrico al anterior: no basta con no escribir. Si el plan devuelve como
    // vigente el que se acaba de rechazar, quien lo consuma pintara en pantalla un enlace que
    // no existe y el lider lo repartira.
    for (const pedido of ["admin", "%%%", "pacifico"]) {
      const plan = rechazo(
        planSlugChange({
          community: COMUNIDAD,
          requestedSlug: pedido,
          takenByCommunityId: pedido === "pacifico" ? "com-9" : null,
          nowIso: AHORA
        })
      );
      expect(plan.effectiveSlug).toBe(VIGENTE);
      expect(plan.effectiveSlug).not.toBe(normalizeSlug(pedido));
    }
  });

  it("RF_04, RF_03: un nombre corto valido si cambia, y retira el anterior conservandolo 30 dias", () => {
    const plan = aceptacion(
      planSlugChange({
        community: COMUNIDAD,
        requestedSlug: "Comunidad Andes Norte",
        takenByCommunityId: null,
        nowIso: AHORA
      })
    );
    expect(plan.changed).toBe(true);
    expect(plan.previousSlug).toBe(VIGENTE);
    expect(plan.effectiveSlug).toBe("comunidad-andes-norte");
    expect(plan.writes).toHaveLength(3);

    // El anterior se RETIRA, no se borra: `merge` para no perder lo que ya tenga el documento.
    const retirado = escrituraEn(plan, "communitySlugs", VIGENTE);
    expect(retirado.op).toBe("merge");
    expect(retirado.data.communityId).toBe("com-1");
    expect(retirado.data.retiredAt).toBe(AHORA);
    // La gracia se comprueba con la funcion que ya la define, para que no puedan divergir.
    expect(isRetiredSlugStillValid(retirado.data.retiredAt, at(AHORA, RETIRED_SLUG_GRACE_DAYS - 1))).toBe(true);
    expect(isRetiredSlugStillValid(retirado.data.retiredAt, at(AHORA, RETIRED_SLUG_GRACE_DAYS + 1))).toBe(false);

    // El nuevo se reserva sin fecha de retirada: es el vigente.
    const reservado = escrituraEn(plan, "communitySlugs", "comunidad-andes-norte");
    expect(reservado.op).toBe("set");
    expect(reservado.data).toEqual({ communityId: "com-1" });

    const comunidad = escrituraEn(plan, "communities", "com-1");
    expect(comunidad.op).toBe("update");
    expect(comunidad.data.slug).toBe("comunidad-andes-norte");
    expect(comunidad.data.updatedAt).toBe(AHORA);
  });

  it("RF_04: pedir el mismo nombre corto que ya se tiene no es un rechazo, y no retira nada", () => {
    // Caso limite con dientes: el documento del slug vigente EXISTE y es de esta comunidad, asi
    // que un `if (existe) rechaza` lo trataria como "ya esta en uso". Y si en vez de eso se
    // procesara como cambio, el plan retiraria el slug vigente contra si mismo y arrancaria una
    // cuenta atras de 30 dias sobre el unico enlace bueno que hay.
    const plan = aceptacion(
      planSlugChange({
        community: COMUNIDAD,
        requestedSlug: "  Comunidad Andes  ",
        takenByCommunityId: "com-1",
        nowIso: AHORA
      })
    );
    expect(plan.changed).toBe(false);
    expect(plan.effectiveSlug).toBe(VIGENTE);
    expect(plan.writes).toEqual([]);
  });

  it("RF_04, RF_03: recuperar tu propio nombre corto retirado no es 'ya esta en uso'", () => {
    // Un lider renombro de `comunidad-andes-norte` a `comunidad-andes` y quiere volver. El
    // documento del que dejo sigue ahi durante los 30 dias de gracia (RF_03), pero es SUYO.
    // Rechazarlo diciendo que lo tiene otro es mentira, y le impide recuperar el enlace que
    // tiene impreso.
    const plan = aceptacion(
      planSlugChange({
        community: COMUNIDAD,
        requestedSlug: "comunidad-andes-norte",
        takenByCommunityId: "com-1",
        nowIso: AHORA
      })
    );
    expect(plan.changed).toBe(true);
    expect(plan.effectiveSlug).toBe("comunidad-andes-norte");
    // `set` y no `merge`: reemplazar el documento entero es lo que le quita el `retiredAt`. Con
    // `merge` el slug volveria a ser el vigente y seguiria marcado como retirado, y caducaria
    // solo a los 30 dias de haberse recuperado.
    const reservado = escrituraEn(plan, "communitySlugs", "comunidad-andes-norte");
    expect(reservado.op).toBe("set");
    expect(reservado.data).toEqual({ communityId: "com-1" });
  });

  it("RF_04: una comunidad sin nombre corto todavia no tiene nada que conservar, y no lo inventa", () => {
    // Alta a medias o comunidad creada antes de que existiera el slug: el rechazo no puede
    // fabricar un `effectiveSlug` de la nada, ni el camino bueno retirar un slug que no existe.
    const sinSlug = { id: "com-2" };
    const rechazado = rechazo(
      planSlugChange({ community: sinSlug, requestedSlug: "admin", takenByCommunityId: null, nowIso: AHORA })
    );
    expect(rechazado.previousSlug).toBeNull();
    expect(rechazado.effectiveSlug).toBeNull();
    expect(rechazado.writes).toEqual([]);

    const aceptado = aceptacion(
      planSlugChange({ community: sinSlug, requestedSlug: "Comunidad Nueva", takenByCommunityId: null, nowIso: AHORA })
    );
    expect(aceptado.previousSlug).toBeNull();
    expect(aceptado.effectiveSlug).toBe("comunidad-nueva");
    // Dos escrituras, no tres: no hay anterior que retirar.
    expect(aceptado.writes).toHaveLength(2);
    expect(aceptado.writes.some((write) => write.data.retiredAt !== undefined)).toBe(false);
  });
});
