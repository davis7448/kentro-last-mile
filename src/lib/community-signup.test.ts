import { beforeEach, describe, expect, it } from "vitest";
import {
  MASS_SIGNUP_ALERT_THRESHOLD,
  MASS_SIGNUP_WINDOW_MINUTES,
  parseSignupInput,
  resolveSignupSlug,
  shouldRaiseMassSignupAlert,
  signupRollbackPlan,
  type SignupInput
} from "../../functions/src/community-signup-validate";
import type { SignupSellerDoc, SignupSellerDocContext } from "../../functions/src/community-signup-doc";

const NOW = "2026-09-10T12:00:00.000Z";
const minutesBefore = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

const valido = {
  email: "  Tienda@Ejemplo.CO ",
  password: "secreta123",
  responsibleName: "  Ana Ruiz ",
  phone: "300 123 4567",
  storeName: "  Mi Tienda  "
};

describe("T11 · validacion del registro por enlace", () => {
  it("RF_43: acepta exactamente los cinco campos, normalizados", () => {
    const parsed = parseSignupInput(valido);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.email).toBe("tienda@ejemplo.co");
    expect(parsed.value.responsibleName).toBe("Ana Ruiz");
    expect(parsed.value.storeName).toBe("Mi Tienda");
    expect(parsed.value.phone).toBe("3001234567");
    expect(Object.keys(parsed.value).sort()).toEqual(
      ["email", "password", "phone", "responsibleName", "storeName"].sort()
    );
  });

  it("RF_43: descarta cualquier campo de mas en vez de guardarlo", () => {
    const parsed = parseSignupInput({ ...valido, cityId: "cali", role: "admin" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty("cityId");
    expect(parsed.value).not.toHaveProperty("role");
  });

  it("RF_43: rechaza correo invalido, contrasena corta, telefono o nombres vacios", () => {
    expect(parseSignupInput({ ...valido, email: "no-es-correo" }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, password: "123" }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, phone: "  " }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, storeName: "" }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, responsibleName: "" }).ok).toBe(false);
  });

  it("RF_09: un enlace inexistente, revocado o de lider desactivado no admite alta", () => {
    expect(resolveSignupSlug(undefined, NOW).ok).toBe(false);
    expect(resolveSignupSlug({ community: { id: "c", status: "active", linkStatus: "revoked" } }, NOW).ok).toBe(false);
    expect(resolveSignupSlug({ community: { id: "c", status: "disabled", linkStatus: "active" } }, NOW).ok).toBe(false);
  });

  it("RF_03, RF_09: un slug retirado sirve dentro de los 30 dias y no despues", () => {
    const community = { id: "c", status: "active", linkStatus: "active" };
    const hace10 = new Date(Date.parse(NOW) - 10 * 86400_000).toISOString();
    const hace40 = new Date(Date.parse(NOW) - 40 * 86400_000).toISOString();
    expect(resolveSignupSlug({ community, retiredAt: hace10 }, NOW).ok).toBe(true);
    expect(resolveSignupSlug({ community, retiredAt: hace40 }, NOW).ok).toBe(false);
  });

  it("RF_45: si falla un paso posterior, hay que borrar el usuario creado", () => {
    expect(signupRollbackPlan({ authUserCreated: true, sellerWritten: false })).toEqual({
      deleteAuthUser: true,
      reason: "La tienda no se pudo crear: se borra el acceso para que el correo quede libre."
    });
    expect(signupRollbackPlan({ authUserCreated: true, sellerWritten: true }).deleteAuthUser).toBe(false);
    expect(signupRollbackPlan({ authUserCreated: false, sellerWritten: false }).deleteAuthUser).toBe(false);
  });

  it("RF_13: se avisa al superar diez altas en una hora deslizante, sin bloquear", () => {
    expect(MASS_SIGNUP_ALERT_THRESHOLD).toBe(10);
    expect(MASS_SIGNUP_WINDOW_MINUTES).toBe(60);
    const dentro = Array.from({ length: 10 }, (_, i) => minutesBefore(i * 5));
    expect(shouldRaiseMassSignupAlert(dentro, NOW)).toBe(true);
    expect(shouldRaiseMassSignupAlert(dentro.slice(0, 9), NOW)).toBe(false);
  });

  it("RF_13: las altas viejas no cuentan para el aviso", () => {
    const viejas = Array.from({ length: 20 }, (_, i) => minutesBefore(61 + i));
    expect(shouldRaiseMassSignupAlert(viejas, NOW)).toBe(false);
  });
});

/**
 * T29 · El documento con el que nace una tienda captada por un enlace (RF_07, RF_08).
 *
 * Hoy este objeto se arma inline dentro de `registerSellerBySlug`
 * (functions/src/community-signup.ts, ~lineas 118-136), entre una llamada a Auth y otra a
 * Firestore. Ahi dentro no se puede afirmar nada: para leer lo que se guarda hay que crear
 * una cuenta de verdad. Y lo que se guarda es exactamente lo que sostiene los dos requisitos
 * mas delicados del alta por enlace:
 *
 *   - RF_07: la tienda nace OPERATIVA. Nadie aprueba nada. Un solo campo que insinue lo
 *     contrario —un `status: "pending"`, un `approved: false`— y la tienda que se registro
 *     desde el movil en la reunion del lider no puede operar, sin que nadie se entere.
 *   - RF_08: queda constancia PERMANENTE de por que enlace entro y cuando. Es lo unico que
 *     hace posible la contencion de T31/T32 (desactivar en bloque un rango de fechas de una
 *     comunidad). Si el slug o la fecha no se escriben, o se escriben sin normalizar, el
 *     remedio ante un enlace filtrado deja tiendas fuera y nadie lo ve.
 *
 * `buildSignupSellerDoc` saca ese armado a una funcion pura. La callable pasa a llamarla y
 * NO cambia lo que escribe: por eso la ultima prueba compara campo a campo contra el literal
 * de hoy. La extraccion tiene que ser invisible en Firestore.
 */

/**
 * El modulo se carga con un import dinamico y no con un `import` de arriba a proposito: mientras no
 * exista, un import estatico tumbaria la RECOLECCION del archivo entero y se llevaria por
 * delante los ocho casos de T11, que no tienen nada que ver. Asi el fallo queda acotado a T29,
 * que es donde debe estar. El `import type` de arriba se borra al transpilar y no carga nada.
 */
type BuildSignupSellerDoc = (input: SignupInput, context: SignupSellerDocContext) => SignupSellerDoc;

let buildSignupSellerDoc: BuildSignupSellerDoc;

const CONTEXTO: SignupSellerDocContext = {
  sellerId: "seller-1757505600000",
  communityId: "com-barrio-obrero",
  slug: "barrio-obrero",
  activeCityId: "city-cali",
  nowIso: NOW
};

/**
 * La entrada del constructor es SIEMPRE lo que devolvio `parseSignupInput`: se encadenan las
 * dos piezas a proposito para que ninguna prueba invente un `SignupInput` a mano con formas
 * que la callable nunca produce.
 */
const entrada = (raw: Record<string, unknown> = valido): SignupInput => {
  const parsed = parseSignupInput(raw);
  if (!parsed.ok) throw new Error(`Fixture invalida: ${parsed.reason}`);
  return parsed.value;
};

const documento = (
  raw: Record<string, unknown> = valido,
  overrides: Partial<SignupSellerDocContext> = {}
): SignupSellerDoc => buildSignupSellerDoc(entrada(raw), { ...CONTEXTO, ...overrides });

/**
 * El literal que HOY escribe `registerSellerBySlug`, copiado campo a campo del archivo.
 * Es el contrato de no-regresion: la extraccion no puede cambiar ni una clave ni un valor.
 */
const DOCUMENTO_DE_HOY = {
  id: "seller-1757505600000",
  name: "Mi Tienda",
  shopDomain: "",
  cityId: "city-cali",
  bankAccount: "",
  email: "tienda@ejemplo.co",
  contactEmail: "tienda@ejemplo.co",
  contactName: "Ana Ruiz",
  contactPhone: "3001234567",
  communityId: "com-barrio-obrero",
  communityJoinedAt: NOW,
  communitySignupSlug: "barrio-obrero",
  onboardingComplete: false,
  createdAt: NOW,
  updatedAt: NOW
};

/** Recorre el documento entero: claves y valores de texto, a cualquier profundidad. */
const recorrerDocumento = (value: unknown, visit: (fragment: string) => void): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recorrerDocumento(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      recorrerDocumento(inner, visit);
    }
  }
};

const barrer = (doc: SignupSellerDoc, prohibido: RegExp): string[] => {
  const encontrados: string[] = [];
  recorrerDocumento(doc, (fragment) => {
    if (prohibido.test(fragment)) encontrados.push(fragment);
  });
  return encontrados;
};

describe("T29 · el documento de una tienda captada por enlace", () => {
  // Dentro del describe y no en la raiz del archivo: un gancho de raiz que falle marca en rojo
  // TODOS los casos, incluidos los ocho de T11. Y `beforeEach` en vez de `beforeAll` para que,
  // mientras el modulo no exista, los trece casos salgan FALLIDOS uno a uno y no omitidos: un
  // caso omitido no se distingue de un caso que nadie escribio.
  beforeEach(async () => {
    const modulo = await import("../../functions/src/community-signup-doc");
    buildSignupSellerDoc = modulo.buildSignupSellerDoc;
  });

  it("RF_07: la tienda nace sin ningun campo de aprobacion, revision o bloqueo", () => {
    // Deliberadamente NO se listan los campos de hoy: se recorre el documento ENTERO, claves y
    // valores a cualquier profundidad, buscando cualquier rastro de alta condicionada. El alta
    // es automatica por decision de negocio; un campo nuevo que la condicione tendra que
    // nombrarse, y esta prueba lo vera aunque nadie se acuerde de RF_07.
    const prohibido =
      /approv|aprob|pending|pendiente|awaiting|espera|review|revisi|moderat|verified|verificad|blocked|bloque|suspend|suspens|quarantin|cuarenten|frozen|congelad|denied|rejected|rechaz|inactiv|deshabilit|desactiv|disabled|status|estado/i;
    expect(barrer(documento(), prohibido)).toEqual([]);
  });

  it("RF_07: ni siquiera cuando el formulario intenta colar el estado o el rol", () => {
    // El formulario es publico. `parseSignupInput` ya descarta lo que sobra (T11); esto ata el
    // otro extremo: aunque algo se colara, no llega al documento.
    const hostil = { ...valido, role: "admin", status: "pending_approval", approved: true };
    expect(documento(hostil)).toEqual(DOCUMENTO_DE_HOY);
    expect(documento(hostil)).not.toHaveProperty("role");
    expect(documento(hostil)).not.toHaveProperty("status");
    expect(documento(hostil)).not.toHaveProperty("approved");
  });

  it("RF_07: la contrasena no se guarda en el documento, ni como campo ni como valor", () => {
    // Vive en Auth y solo en Auth. `sellers` la lee cualquiera con permiso de tienda.
    const doc = documento();
    expect(doc).not.toHaveProperty("password");
    expect(barrer(doc, /secreta123|password|contrasena|clave/i)).toEqual([]);
  });

  it("RF_07: la tienda queda adscrita a la comunidad del enlace usado, no a otra", () => {
    expect(documento().communityId).toBe("com-barrio-obrero");
    expect(documento(valido, { communityId: "com-otra" }).communityId).toBe("com-otra");
  });

  it("RF_07: la ciudad es la que entra por parametro, sin defecto propio", () => {
    // El defecto `city-cali` vive en la callable, que es quien lee `settings/app`.
    expect(documento(valido, { activeCityId: "city-palmira" }).cityId).toBe("city-palmira");
  });

  it("RF_08: quedan los tres campos de procedencia: comunidad, instante y enlace", () => {
    const doc = documento();
    expect(doc.communityId).toBe("com-barrio-obrero");
    expect(doc.communityJoinedAt).toBe(NOW);
    expect(doc.communitySignupSlug).toBe("barrio-obrero");
  });

  it("RF_08: el enlace se guarda normalizado, aunque llegue con mayusculas o acentos", () => {
    // El enlace se comparte por WhatsApp y se reescribe a mano: "Barrió-Obréro" y
    // " BARRIO OBRERO " son el mismo enlace. Si se guardara en crudo, la contencion por
    // comunidad y la trazabilidad dejarian de casar con `communitySlugs`.
    expect(documento(valido, { slug: "Barrió-Obréro" }).communitySignupSlug).toBe("barrio-obrero");
    expect(documento(valido, { slug: "  BARRIO OBRERO  " }).communitySignupSlug).toBe("barrio-obrero");
  });

  it("RF_08: el instante lo pone quien llama, no un reloj global", () => {
    const otroInstante = "2027-01-31T05:00:00.000Z";
    const doc = documento(valido, { nowIso: otroInstante });
    expect(doc.communityJoinedAt).toBe(otroInstante);
    expect(doc.createdAt).toBe(otroInstante);
    expect(doc.updatedAt).toBe(otroInstante);
  });

  it("RF_08: dos llamadas con la misma entrada dan exactamente el mismo documento", () => {
    // Pureza: sin `Date.now()` dentro, la previsualizacion y lo que se escribe no pueden
    // divergir, y una reejecucion no reescribe la procedencia con otra fecha.
    expect(documento()).toEqual(documento());
  });

  it("RF_08: la procedencia se escribe siempre, no solo cuando el enlace es el vigente", () => {
    // Un slug retirado sigue admitiendo altas 30 dias (RF_03). Esas tiendas son justo las que
    // hay que poder rastrear despues, asi que el campo no puede quedar vacio ni ausente.
    const doc = documento(valido, { slug: "barrio-obrero-2025", communityId: "com-barrio-obrero" });
    expect(doc.communitySignupSlug).toBe("barrio-obrero-2025");
    expect(doc.communityJoinedAt).toBe(NOW);
  });

  it("RF_44: la tienda nace con el onboarding sin completar", () => {
    // Es lo unico que sostiene el veto de RF_44: entra y se mueve por la app, pero no crea
    // pedidos hasta tener ciudad, punto de recogida y cuenta bancaria. Si este campo
    // desaparece o nace en `true`, se despachan pedidos sin a donde ni a quien pagarle.
    expect(documento().onboardingComplete).toBe(false);
    expect(documento().cityId).toBeTruthy();
    expect(documento().bankAccount).toBe("");
  });

  it("RF_07, RF_08: el correo y los nombres son los ya normalizados por la validacion", () => {
    // La entrada del fixture trae espacios y mayusculas a proposito. El documento no puede
    // guardar " Tienda@Ejemplo.CO ": ese correo es la llave con la que T32 busca el acceso.
    const doc = documento();
    expect(doc.email).toBe("tienda@ejemplo.co");
    expect(doc.contactEmail).toBe(doc.email);
    expect(doc.contactName).toBe("Ana Ruiz");
    expect(doc.name).toBe("Mi Tienda");
    expect(doc.contactPhone).toBe("3001234567");
  });

  it("RF_07, RF_08: el documento es exactamente el que hoy escribe la callable", () => {
    // La prueba que impide que la extraccion cambie lo que se guarda. Campo a campo contra el
    // literal de `registerSellerBySlug`, mas las claves exactas: ni una de mas, ni una menos.
    const doc = documento();
    for (const [campo, esperado] of Object.entries(DOCUMENTO_DE_HOY)) {
      expect(doc[campo as keyof SignupSellerDoc]).toBe(esperado);
    }
    expect(Object.keys(doc).sort()).toEqual(Object.keys(DOCUMENTO_DE_HOY).sort());
    expect(doc).toEqual(DOCUMENTO_DE_HOY);
  });
});

/**
 * T30 · Que se responde cuando el correo del registro ya tiene cuenta (RF_10).
 *
 * Hoy esta decision vive dentro del `catch` de `auth.createUser`, en
 * `functions/src/community-signup.ts` (~linea 100): tres lineas entre una llamada a Auth y otra,
 * donde no se puede afirmar nada sin crear cuentas de verdad contra Auth. Y son tres lineas que
 * deciden lo unico que ve una persona que NO tiene sesion, en la unica superficie de la
 * plataforma abierta a cualquiera:
 *
 *   - Lo que se dice. "Ese correo ya tiene una cuenta" es informacion sobre una cuenta ajena
 *     entregada a un desconocido. Es el minimo imprescindible para que quien se equivoco de
 *     formulario sepa que tiene que ir a iniciar sesion, y ni una palabra mas: por el mensaje
 *     NO se puede deducir a que comunidad pertenece ese correo. Quien tenga el enlace de un
 *     lider podria, si no, barrer correos y reconstruir su cartera de tiendas sin registrarse.
 *   - Lo que NO se hace. La cuenta existente no se toca: ni se le cambia la clave, ni se le
 *     mueve la comunidad, ni se le "vincula" nada. El alta se rechaza y punto.
 *   - Lo que no se traga. Solo `auth/email-already-exists` significa correo duplicado. Un
 *     `auth/internal-error` convertido en "ese correo ya existe" manda a iniciar sesion a
 *     alguien que no tiene cuenta, y deja el fallo real sin rastro en los logs.
 *
 * `mapSignupAuthError` saca esa decision a una funcion pura. NO puede devolver un `HttpsError`:
 * eso vive en `firebase-functions`, que esta suite no puede importar. Devuelve la descripcion
 * del rechazo —codigo y mensaje— o `undefined` para decir "esto no es cosa mia, propagalo tal
 * cual". La callable construye el `HttpsError` con esos dos campos y, si recibe `undefined`,
 * hace `throw error` sin tocarlo.
 */

/**
 * Import diferido, por lo mismo que en T29: mientras el export no exista, un `import` estatico
 * de un nombre ausente rompe el ENLACE del modulo y tumba la recoleccion del archivo entero,
 * llevandose por delante los 21 casos que ya estan en verde. Asi el rojo queda acotado a T30.
 */
type SignupAuthRejection = { code: string; message: string };
type MapSignupAuthError = (error: unknown) => SignupAuthRejection | undefined;

let mapSignupAuthError: MapSignupAuthError;

/** El error tal como lo lanza el Admin SDK: un objeto con `code` y un `message` en ingles. */
const errorDeAuth = (code: string, message = "The email address is already in use by another account."): unknown => ({
  code,
  message
});

const DUPLICADO = errorDeAuth("auth/email-already-exists");

/** Recorre el rechazo entero —claves y valores— reusando el barrido de T29. */
const barrerRechazo = (rechazo: SignupAuthRejection | undefined, prohibido: RegExp): string[] => {
  const encontrados: string[] = [];
  recorrerDocumento(rechazo, (fragment) => {
    if (prohibido.test(fragment)) encontrados.push(fragment);
  });
  return encontrados;
};

describe("T30 · el correo que ya tiene cuenta", () => {
  // Dentro del describe y con `beforeEach`, por lo mismo que en T29: un gancho de raiz que falle
  // marca en rojo los 21 casos anteriores, y `beforeAll` dejaria estos OMITIDOS —un caso omitido
  // no se distingue de un caso que nadie escribio.
  beforeEach(async () => {
    const modulo = (await import("../../functions/src/community-signup-validate")) as unknown as {
      mapSignupAuthError?: MapSignupAuthError;
    };
    if (typeof modulo.mapSignupAuthError !== "function") {
      throw new Error(
        "Falta `mapSignupAuthError` en functions/src/community-signup-validate.ts (T30, RF_10)."
      );
    }
    mapSignupAuthError = modulo.mapSignupAuthError;
  });

  it("RF_10: el correo duplicado se rechaza mandando a iniciar sesion", () => {
    const rechazo = mapSignupAuthError(DUPLICADO);
    expect(rechazo).toBeDefined();
    if (!rechazo) return;
    expect(rechazo.code).toBe("already-exists");
    // Sin decirle a donde ir, la persona reintenta con otro correo y acaba con dos cuentas.
    expect(rechazo.message).toMatch(/inicia|inicie|iniciar|ingresa|ingrese|entra|log\s?in/i);
    expect(rechazo.message).toMatch(/sesi[oó]n|cuenta|log\s?in/i);
  });

  it("RF_10: el codigo distingue el correo duplicado de un enlace invalido o un fallo interno", () => {
    // La pantalla publica ya trata `invalid-argument` (campos) y `failed-precondition` (enlace
    // caducado). Si el duplicado llegara con uno de esos, se pintaria el error equivocado.
    const rechazo = mapSignupAuthError(DUPLICADO);
    expect(rechazo?.code).toBe("already-exists");
    for (const otro of ["invalid-argument", "failed-precondition", "internal", "not-found", "unknown"]) {
      expect(rechazo?.code).not.toBe(otro);
    }
  });

  it("RF_10: el mensaje no nombra ninguna comunidad, ni al lider, ni el enlace", () => {
    // Deliberadamente NO se compara el texto de hoy palabra por palabra: se barre el rechazo
    // ENTERO —claves y valores— buscando cualquier rastro de a que comunidad pertenece el
    // correo. Este formulario se abre SIN sesion: quien tenga el enlace de un lider podria
    // probar correos uno a uno y reconstruir su cartera de tiendas. Un mensaje futuro mas
    // "util" ("ese correo ya esta en la comunidad de Ana") tendra que nombrarlo, y esta prueba
    // lo vera aunque nadie se acuerde de RF_10.
    const prohibido =
      /comunidad|community|l[ií]der|leader|barrio|obrero|vecin|grupo|colectiv|enlace|invitaci|invite|slug|referid|captad|campa[nñ]a|pertenec|miembro|afiliad|asociad/i;
    expect(barrerRechazo(mapSignupAuthError(DUPLICADO), prohibido)).toEqual([]);
  });

  it("RF_10: el mensaje no reenvia el texto que trae el error de Auth", () => {
    // El `message` del Admin SDK es texto de un tercero y puede acabar nombrando la cuenta, el
    // uid o —si alguien lo enriquece— la comunidad. El rechazo se REDACTA aqui, no se reenvia.
    const hostil = errorDeAuth(
      "auth/email-already-exists",
      "uid seller-1757505600000 de la comunidad Barrio Obrero (com-barrio-obrero), lider Ana Ruiz, enlace barrio-obrero"
    );
    const rechazo = mapSignupAuthError(hostil);
    expect(rechazo).toBeDefined();
    if (!rechazo) return;
    for (const filtracion of ["seller-1757505600000", "com-barrio-obrero", "Barrio Obrero", "Ana Ruiz", "barrio-obrero"]) {
      expect(rechazo.message).not.toContain(filtracion);
    }
    // Y el mensaje es el mismo que para un duplicado corriente: no varia con lo que traiga Auth.
    expect(rechazo).toEqual(mapSignupAuthError(DUPLICADO));
  });

  it("RF_10: la decision solo mira el error, no recibe la comunidad ni el enlace", () => {
    // Lo que no entra no se puede filtrar. Si manana hiciera falta un segundo parametro
    // obligatorio con el contexto del alta, esta prueba obliga a discutirlo antes.
    expect(mapSignupAuthError.length).toBe(1);
  });

  it("RF_10: la decision no ordena tocar la cuenta existente", () => {
    const rechazo = mapSignupAuthError(DUPLICADO);
    expect(rechazo).toBeDefined();
    if (!rechazo) return;
    // Dos claves y nada mas: no hay hueco para un `deleteAuthUser`, un `linkTo` ni un
    // `updateExisting`. Compararlo con el juego exacto de claves es lo que cierra la puerta.
    expect(Object.keys(rechazo).sort()).toEqual(["code", "message"]);
    // Y el barrido cubre lo que se colara dentro de un valor de texto. Ojo: son verbos de
    // escritura DEL SISTEMA sobre la cuenta ajena; recomendarle a la persona que recupere su
    // clave no lo es, y por eso no esta en la lista.
    const escrituras =
      /delete|remove|destroy|purge|overwrite|update|upsert|merge|patch|link|unlink|claim|takeover|migrate|transfer|borr|elimin|actualiz|sobrescrib|vincul|desvincul|fusion|reclam|apropi|traslad|mover|disable|deshabilit|desactiv|suspend/i;
    expect(barrerRechazo(rechazo, escrituras)).toEqual([]);
  });

  it("RF_10: devuelve una descripcion del rechazo, no lo lanza ni construye un HttpsError", () => {
    // `HttpsError` vive en `firebase-functions`, que este modulo no puede importar sin dejar de
    // ser puro. La callable es quien lo construye con estos dos campos.
    expect(() => mapSignupAuthError(DUPLICADO)).not.toThrow();
    const rechazo = mapSignupAuthError(DUPLICADO);
    expect(rechazo).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(rechazo)).toBe(Object.prototype);
    expect(typeof rechazo?.code).toBe("string");
    expect(typeof rechazo?.message).toBe("string");
    expect(rechazo?.message.trim()).not.toBe("");
  });

  it("RF_10: cualquier otro codigo de Auth se propaga tal cual", () => {
    // `undefined` = "esto no es cosa mia": la callable hace `throw error` sin tocarlo. Traducir
    // un fallo de infraestructura a "ese correo ya existe" es mentirle a quien se registra y
    // ademas borra el rastro del fallo real.
    for (const code of [
      "auth/internal-error",
      "auth/invalid-password",
      "auth/invalid-email",
      "auth/too-many-requests",
      "auth/operation-not-allowed",
      "auth/invalid-display-name",
      "permission-denied",
      "unavailable",
      ""
    ]) {
      expect(mapSignupAuthError(errorDeAuth(code))).toBeUndefined();
    }
  });

  it("RF_10: un correo parecido en el texto no cuela por el camino del duplicado", () => {
    // El codigo es lo unico que decide. Un error de otra cosa cuyo TEXTO hable de correos ya
    // usados no puede acabar mandando a iniciar sesion a quien no tiene cuenta.
    expect(
      mapSignupAuthError(errorDeAuth("auth/internal-error", "auth/email-already-exists: email already in use"))
    ).toBeUndefined();
  });

  it("RF_10: un error sin code, que no es objeto o es nulo, tambien se propaga", () => {
    const raros: unknown[] = [
      null,
      undefined,
      "auth/email-already-exists",
      42,
      true,
      [],
      ["auth/email-already-exists"],
      {},
      { message: "auth/email-already-exists" },
      { code: 409 },
      { code: null },
      new Error("auth/email-already-exists")
    ];
    for (const raro of raros) {
      expect(mapSignupAuthError(raro)).toBeUndefined();
    }
  });

  it("RF_10: es pura: no muta el error recibido y responde igual llamada tras llamada", () => {
    const error = errorDeAuth("auth/email-already-exists");
    const copia = JSON.parse(JSON.stringify(error)) as unknown;
    const primera = mapSignupAuthError(error);
    const segunda = mapSignupAuthError(error);
    expect(primera).toEqual(segunda);
    expect(error).toEqual(copia);
  });
});

/**
 * T49 · RF_55 — crear un lider de comunidad es TODO o NADA.
 *
 * `createCommunityLeader` (functions/src/communities.ts) hace hoy tres escrituras seguidas y
 * ningun `try`/`catch`:
 *
 *   1. `db.runTransaction(...)` escribe la comunidad Y reserva el nombre corto en
 *      `communitySlugs`. COMMITEA.
 *   2. `auth.createUser(...)` — puede lanzar. Lo mas probable: `auth/email-already-exists`.
 *   3. `auth.setCustomUserClaims(uid, { role: "community_leader", communityId })` — puede
 *      lanzar tambien.
 *
 * Si revienta el 2 queda una COMUNIDAD FANTASMA con el enlace reservado, y el reintento con el
 * mismo nombre corto responde "ese nombre corto ya esta en uso" apuntando a la basura que acaba
 * de dejar el intento anterior. Si revienta el 3 es peor: queda una cuenta que ENTRA y no tiene
 * rol.
 *
 * Este bloque fija el equivalente de `signupRollbackPlan` (RF_45) para este camino, que va al
 * reves: alli Auth iba primero, aqui va Firestore primero, asi que el plan tiene que poder
 * ordenar borrar comunidad, enlace y cuenta.
 *
 * El plan es PURO y solo DESCRIBE lo que hay que deshacer. Quien borra es la callable: aqui no
 * entra `firebase-admin` ni `firebase-functions`.
 *
 * Import diferido por lo mismo que en T29 y T30: un `import` estatico de un modulo que todavia
 * no existe tumba la recoleccion del archivo entero y se lleva por delante los 32 casos que ya
 * estan en verde. Asi el rojo queda acotado a T49.
 */
type LeaderCreationState = {
  /** La transaccion del paso 1 commiteo: hay comunidad Y hay enlace reservado. */
  communityWritten: boolean;
  /** El paso 2 devolvio un uid. */
  authUserCreated: boolean;
  /** El paso 3 termino: la cuenta ya tiene `role` y `communityId`. */
  roleAssigned: boolean;
};

type LeaderRollbackPlan = {
  deleteCommunity: boolean;
  deleteSlug: boolean;
  deleteAuthUser: boolean;
  reason: string;
};

type LeaderEmailPrecheck = { ok: true } | { ok: false; code: "already-exists"; reason: string };

type LeaderRollbackPlanFn = (state: LeaderCreationState) => LeaderRollbackPlan;
/** Recibe lo que responde la consulta de existencia: el registro hallado, o `undefined`. */
type LeaderEmailPrecheckFn = (existing: { uid: string } | undefined) => LeaderEmailPrecheck;

let leaderRollbackPlan: LeaderRollbackPlanFn;
let leaderEmailPrecheck: LeaderEmailPrecheckFn;

const estado = (state: Partial<LeaderCreationState> = {}): LeaderCreationState => ({
  communityWritten: false,
  authUserCreated: false,
  roleAssigned: false,
  ...state
});

/** Las ocho combinaciones posibles de los tres interruptores. Ninguna se queda sin respuesta. */
const TODOS_LOS_ESTADOS: LeaderCreationState[] = [false, true].flatMap((communityWritten) =>
  [false, true].flatMap((authUserCreated) =>
    [false, true].map((roleAssigned) => ({ communityWritten, authUserCreated, roleAssigned }))
  )
);

describe("T49 · crear un lider a medias", () => {
  beforeEach(async () => {
    const modulo = (await import("../../functions/src/community-leader-create")) as unknown as {
      leaderRollbackPlan?: LeaderRollbackPlanFn;
      leaderEmailPrecheck?: LeaderEmailPrecheckFn;
    };
    if (typeof modulo.leaderRollbackPlan !== "function" || typeof modulo.leaderEmailPrecheck !== "function") {
      throw new Error(
        "Faltan `leaderRollbackPlan` y `leaderEmailPrecheck` en functions/src/community-leader-create.ts (T49, RF_55)."
      );
    }
    leaderRollbackPlan = modulo.leaderRollbackPlan;
    leaderEmailPrecheck = modulo.leaderEmailPrecheck;
  });

  it("RF_55: comunidad escrita y cuenta no creada: se borra la comunidad y el enlace, y nada mas", () => {
    // El fallo que motivo la tarea: `auth.createUser` lanza `auth/email-already-exists` justo
    // despues de que la transaccion commiteara. No hay cuenta que borrar, pero si comunidad.
    const plan = leaderRollbackPlan(estado({ communityWritten: true }));
    expect(plan.deleteCommunity).toBe(true);
    expect(plan.deleteSlug).toBe(true);
    expect(plan.deleteAuthUser).toBe(false);
  });

  it("RF_55: el nombre corto queda libre para reintentar, no solo la comunidad", () => {
    // Borrar `communities` y dejar el documento de `communitySlugs` es la MITAD del fallo:
    // el reintento con el mismo nombre corto vuelve a chocar con "ya esta en uso", ahora
    // contra una reserva que no apunta a ninguna comunidad. El enlace se borra siempre que se
    // borre la comunidad, en las ocho combinaciones.
    expect(leaderRollbackPlan(estado({ communityWritten: true })).deleteSlug).toBe(true);
    for (const state of TODOS_LOS_ESTADOS) {
      const plan = leaderRollbackPlan(state);
      expect({ ...state, deleteCommunity: plan.deleteCommunity, deleteSlug: plan.deleteSlug }).toEqual({
        ...state,
        deleteCommunity: plan.deleteCommunity,
        deleteSlug: plan.deleteCommunity
      });
    }
  });

  it("RF_55: cuenta creada sin rol: se borra tambien la cuenta", () => {
    // Una cuenta que ENTRA y no tiene rol es peor que ninguna: la persona inicia sesion y la
    // app no sabe que es. Y el correo queda ocupado, asi que el reintento tampoco funciona.
    const plan = leaderRollbackPlan(estado({ communityWritten: true, authUserCreated: true }));
    expect(plan.deleteAuthUser).toBe(true);
    expect(plan.deleteCommunity).toBe(true);
    expect(plan.deleteSlug).toBe(true);
  });

  it("RF_55: si todo salio bien no se revierte nada", () => {
    // El caso que rompe una reversion mal escrita: barrer lo que acaba de crearse bien.
    const plan = leaderRollbackPlan(estado({ communityWritten: true, authUserCreated: true, roleAssigned: true }));
    expect(plan).toEqual({ deleteCommunity: false, deleteSlug: false, deleteAuthUser: false, reason: "" });
  });

  it("RF_55: si no se escribio nada todavia no hay nada que revertir", () => {
    // Fallo ANTES de la transaccion (validacion, permisos, la propia transaccion abortada).
    const plan = leaderRollbackPlan(estado());
    expect(plan).toEqual({ deleteCommunity: false, deleteSlug: false, deleteAuthUser: false, reason: "" });
  });

  it("RF_55: una cuenta creada nunca sobrevive sin comunidad utilizable", () => {
    // Invariante sobre las ocho combinaciones: si hay cuenta y el alta no llego al final
    // (rol sin fijar, o comunidad sin escribir), la cuenta se borra. Lo contrario deja un
    // correo ocupado por alguien que no puede operar y que tampoco puede reintentar.
    for (const state of TODOS_LOS_ESTADOS) {
      const plan = leaderRollbackPlan(state);
      const altaCompleta = state.communityWritten && state.authUserCreated && state.roleAssigned;
      expect({ ...state, deleteAuthUser: plan.deleteAuthUser }).toEqual({
        ...state,
        deleteAuthUser: state.authUserCreated && !altaCompleta
      });
    }
  });

  it("RF_55: una comunidad escrita nunca sobrevive a un alta incompleta", () => {
    for (const state of TODOS_LOS_ESTADOS) {
      const plan = leaderRollbackPlan(state);
      const altaCompleta = state.communityWritten && state.authUserCreated && state.roleAssigned;
      expect({ ...state, deleteCommunity: plan.deleteCommunity }).toEqual({
        ...state,
        deleteCommunity: state.communityWritten && !altaCompleta
      });
    }
  });

  it("RF_55: el estado incoherente (cuenta sin comunidad) tambien se limpia", () => {
    // No deberia darse con el orden actual, pero si alguien invierte los pasos el plan no
    // puede responder "no hay nada que hacer" ante una cuenta huerfana.
    const plan = leaderRollbackPlan(estado({ authUserCreated: true, roleAssigned: true }));
    expect(plan.deleteAuthUser).toBe(true);
    expect(plan.deleteCommunity).toBe(false);
    expect(plan.deleteSlug).toBe(false);
  });

  it("RF_55: la razon se explica cuando se borra algo y queda vacia cuando no", () => {
    // La razon acaba en los registros: un borrado sin motivo escrito es indistinguible de un
    // borrado por error cuando se investiga meses despues.
    for (const state of TODOS_LOS_ESTADOS) {
      const plan = leaderRollbackPlan(state);
      const borraAlgo = plan.deleteCommunity || plan.deleteSlug || plan.deleteAuthUser;
      expect({ ...state, tieneRazon: plan.reason.trim() !== "" }).toEqual({ ...state, tieneRazon: borraAlgo });
    }
  });

  it("RF_55: es pura: no muta el estado recibido y responde igual llamada tras llamada", () => {
    const state = estado({ communityWritten: true, authUserCreated: true });
    const copia = { ...state };
    const primera = leaderRollbackPlan(state);
    const segunda = leaderRollbackPlan(state);
    expect(primera).toEqual(segunda);
    expect(state).toEqual(copia);
    // El plan describe, no ejecuta: solo los cuatro campos, nada de referencias a Firestore.
    expect(Object.keys(primera).sort()).toEqual(["deleteAuthUser", "deleteCommunity", "deleteSlug", "reason"]);
  });

  it("RF_55: la comprobacion previa deja pasar un correo sin cuenta", () => {
    expect(leaderEmailPrecheck(undefined)).toEqual({ ok: true });
  });

  it("RF_55: la comprobacion previa rechaza limpiamente un correo que ya tiene cuenta", () => {
    // Limpiamente = ANTES de escribir nada. El caso que motivo la tarea deja de producir
    // comunidades fantasma porque ni siquiera se llega a la transaccion.
    const rechazo = leaderEmailPrecheck({ uid: "uid-existente" });
    expect(rechazo.ok).toBe(false);
    if (rechazo.ok) return;
    expect(rechazo.code).toBe("already-exists");
    expect(rechazo.reason.trim()).not.toBe("");
  });

  it("RF_55: el rechazo no filtra el uid de la cuenta ajena", () => {
    const rechazo = leaderEmailPrecheck({ uid: "uid-existente" });
    if (rechazo.ok) throw new Error("El correo ocupado tenia que rechazarse.");
    expect(barrerRechazo({ code: rechazo.code, message: rechazo.reason }, /uid-existente/i)).toEqual([]);
  });

  it("RF_55: la comprobacion previa no lanza ni construye un HttpsError", () => {
    // `HttpsError` vive en `firebase-functions`, que este modulo no puede importar sin dejar
    // de ser puro. La callable lo construye con `code` y `reason`.
    expect(() => leaderEmailPrecheck({ uid: "uid-existente" })).not.toThrow();
    const rechazo = leaderEmailPrecheck({ uid: "uid-existente" });
    expect(rechazo).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(rechazo)).toBe(Object.prototype);
  });

  it("RF_55: la comprobacion previa NO sustituye a la reversion", () => {
    // Dos administradores a la vez pasan los dos la comprobacion con el mismo correo: uno
    // crea la cuenta y al otro le revienta `createUser` con la transaccion ya commiteada.
    // Que la comprobacion diga "libre" no exime de revertir.
    expect(leaderEmailPrecheck(undefined)).toEqual({ ok: true });
    const plan = leaderRollbackPlan(estado({ communityWritten: true }));
    expect(plan.deleteCommunity).toBe(true);
    expect(plan.deleteSlug).toBe(true);
  });
});
