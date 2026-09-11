import { beforeEach, describe, expect, it } from "vitest";
import {
  canBulkDisableCommunitySignups,
  canCreateCommunityLeader,
  canEditCommunityBrand,
  canEditCommunityPricing,
  canReadCommunityStats,
  canReadSellerFinancials,
  canReadSellerOperational,
  canReassignSellerCommunity,
  canSetCommunityLeaderStatus,
  canSetCommunityLinkStatus,
  communityAcceptsSignups,
  communityIdForAdminCreatedSeller,
  leaderCanSignIn,
  type Actor
} from "../../functions/src/community-access";

const admin: Actor = { uid: "u-admin", role: "admin" };
const lider: Actor = { uid: "u-lider", role: "community_leader", communityId: "com-1" };
const otroLider: Actor = { uid: "u-otro", role: "community_leader", communityId: "com-2" };
const tienda: Actor = { uid: "u-tienda", role: "seller", sellerId: "seller-1" };

const sellerPropio = { id: "seller-1", communityId: "com-1" };
const sellerAjeno = { id: "seller-9", communityId: "com-2" };
const sellerSinComunidad = { id: "seller-0" };

describe("T10 · permisos del lider de comunidad", () => {
  it("RF_50: solo un administrador crea lideres de comunidad", () => {
    expect(canCreateCommunityLeader(admin)).toBe(true);
    expect(canCreateCommunityLeader(lider)).toBe(false);
    expect(canCreateCommunityLeader(tienda)).toBe(false);
  });

  it("RF_50, RF_51: solo un administrador activa o desactiva a un lider", () => {
    expect(canSetCommunityLeaderStatus(admin)).toBe(true);
    expect(canSetCommunityLeaderStatus(lider)).toBe(false);
  });

  it("RF_05: solo un administrador revoca o reactiva un enlace", () => {
    expect(canSetCommunityLinkStatus(admin)).toBe(true);
    expect(canSetCommunityLinkStatus(lider)).toBe(false);
  });

  it("RF_51: un lider desactivado no entra, pero eso no toca su comunidad", () => {
    expect(leaderCanSignIn({ status: "active" })).toBe(true);
    expect(leaderCanSignIn({ status: "disabled" })).toBe(false);
  });

  it("RF_06: un enlace revocado o de un lider desactivado no admite altas", () => {
    expect(communityAcceptsSignups({ status: "active", linkStatus: "active" })).toBe(true);
    expect(communityAcceptsSignups({ status: "active", linkStatus: "revoked" })).toBe(false);
    expect(communityAcceptsSignups({ status: "disabled", linkStatus: "active" })).toBe(false);
  });

  it("RF_27: un lider fija precios de SU comunidad y de ninguna otra", () => {
    expect(canEditCommunityPricing(lider, "com-1")).toBe(true);
    expect(canEditCommunityPricing(lider, "com-2")).toBe(false);
    expect(canEditCommunityPricing(otroLider, "com-1")).toBe(false);
    expect(canEditCommunityPricing(tienda, "com-1")).toBe(false);
  });

  it("RF_14: la marca la cambia su lider, o un administrador", () => {
    expect(canEditCommunityBrand(lider, "com-1")).toBe(true);
    expect(canEditCommunityBrand(admin, "com-1")).toBe(true);
    expect(canEditCommunityBrand(otroLider, "com-1")).toBe(false);
  });

  it("RF_52: un lider solo ve cifras de su comunidad", () => {
    expect(canReadCommunityStats(lider, "com-1")).toBe(true);
    expect(canReadCommunityStats(lider, "com-2")).toBe(false);
    expect(canReadCommunityStats(admin, "com-2")).toBe(true);
  });

  it("RF_52: un lider ve la operacion de sus tiendas y de ninguna ajena", () => {
    expect(canReadSellerOperational(lider, sellerPropio)).toBe(true);
    expect(canReadSellerOperational(lider, sellerAjeno)).toBe(false);
    expect(canReadSellerOperational(lider, sellerSinComunidad)).toBe(false);
  });

  it("RF_31: un lider NUNCA ve el saldo de una tienda, ni de la suya", () => {
    expect(canReadSellerFinancials(lider, sellerPropio)).toBe(false);
    expect(canReadSellerFinancials(admin, sellerPropio)).toBe(true);
    expect(canReadSellerFinancials(tienda, { id: "seller-1" })).toBe(true);
  });

  it("RF_11: solo un administrador reasigna una tienda de comunidad", () => {
    expect(canReassignSellerCommunity(admin)).toBe(true);
    expect(canReassignSellerCommunity(lider)).toBe(false);
    expect(canReassignSellerCommunity(tienda)).toBe(false);
  });

  it("RF_12: una tienda creada a mano por un administrador nace sin comunidad", () => {
    expect(communityIdForAdminCreatedSeller()).toBeUndefined();
  });
});

/**
 * T44 · Quien puede lanzar la desactivacion en bloque (RF_41, RF_42).
 *
 * `disableCommunitySignupsInRange` lleva desplegada desde T32 sin un solo llamador: no hay
 * envoltorio en `src/lib/firebase/auth.ts` ni control en el panel, asi que un administrador
 * real no puede ejecutar lo que la spec declara **el unico remedio ante un enlace filtrado**
 * (RF_41). T44 construye esa superficie, y este es el unico trozo de ella que se puede afirmar
 * con una prueba pura: el predicado de quien ve el control. El recorrido de punta a punta va
 * con captura en la evidencia de `/sdd-verify`, tal como declara `specs/001_tasks.md`.
 *
 * El predicado vive aqui, y no dentro del componente, por la misma razon que sus hermanos: es
 * una frontera de permiso, y la callable ya decide lo mismo por su cuenta
 * (`communities.ts:414`, hoy con un `actor.role !== "admin"` suelto). Si la interfaz y el
 * servidor deciden por caminos distintos, tarde o temprano dicen cosas distintas.
 */

const logistico: Actor = { uid: "u-log", role: "seller_logistics", sellerId: "seller-1" };
const transportista: Actor = { uid: "u-driver", role: "driver", driverId: "driver-1" };
const mensajero: Actor = { uid: "u-mens", role: "messenger", driverId: "driver-2" };

describe("T44 · desactivacion en bloque desde el panel del admin", () => {
  it("RF_41: solo un administrador lanza la desactivacion en bloque", () => {
    expect(canBulkDisableCommunitySignups(admin, "com-1")).toBe(true);
    // Los cinco roles de la plataforma, uno a uno: la accion cierra accesos de decenas de
    // tiendas de golpe y no hay nadie mas que pueda dispararla.
    expect(canBulkDisableCommunitySignups(tienda, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(logistico, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(transportista, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(mensajero, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(otroLider, "com-1")).toBe(false);
  });

  it("RF_41: ni el lider de la comunidad del enlace filtrado puede ejecutar la limpieza", () => {
    // El caso interesante: es SU enlace el que se filtro y son SUS tiendas las que entraron,
    // asi que es quien mas incentivo tiene para tapar el rastro. La contencion sigue siendo
    // del administrador — como revocar el enlace (RF_05), que tampoco es suyo.
    expect(canBulkDisableCommunitySignups(lider, "com-1")).toBe(false);
    expect(canBulkDisableCommunitySignups(lider, "com-2")).toBe(false);
  });

  it("RF_42: el permiso no depende de pedidos ni del historial de dinero de esas cuentas", () => {
    // El predicado recibe DOS cosas —quien pide y sobre que comunidad— y ninguna mas: ni
    // saldos, ni cortes, ni pedidos. Fijar la aridad es lo que impide que manana alguien
    // condicione la contencion a que las tiendas "no deban nada", que es justo lo contrario
    // de lo que dice RF_42: no se borra ni se toca su historial, solo se cierra el acceso.
    expect(canBulkDisableCommunitySignups.length).toBe(2);
    // La comunidad solo sirve para contrastarla con la del actor. Ni se consulta ni se mira su
    // volumen: un administrador la desactiva igual sea cual sea, tambien una que no conoce.
    expect(canBulkDisableCommunitySignups(admin, "com-2")).toBe(true);
    expect(canBulkDisableCommunitySignups(admin, "com-que-no-existe")).toBe(true);
  });
});

/**
 * T35 · El veto de pedidos a una tienda sin datos operativos (RF_44).
 *
 * Hoy la condicion vive suelta dentro de `createManualOrder` (functions/src/orders.ts, ~284),
 * entre la lectura del perfil de la tienda y la transaccion que escribe el pedido. Ahi dentro no
 * se puede afirmar nada: para comprobar que el mensaje nombra lo que falta hay que registrar una
 * tienda de verdad y llamar a la callable. Y lo que decide esa condicion es de lo mas delicado
 * de todo el alta por enlace:
 *
 *   - Si veta de menos, se crea un pedido de una tienda sin punto de recogida ni cuenta: el
 *     domiciliario no tiene donde recoger la mercancia y la plataforma no tiene a quien pagarle.
 *   - Si veta de mas, y este es el riesgo grande, se cae la operacion ENTERA. Las tiendas que ya
 *     existian no tienen el campo `onboardingComplete`; tratarlas como incompletas dejaria a toda
 *     la plataforma sin poder crear un solo pedido, sin que nada lo avise.
 *
 * Por eso el predicado sale a `community-access.ts` como funcion pura, y por eso devuelve QUE
 * falta y no solo si falta: RF_44 exige decirlo "con claridad", y el mismo dato le sirve a la
 * interfaz para senalar donde completarlo. El `HttpsError` lo sigue construyendo la callable.
 */

/**
 * Los campos entran como `unknown` a proposito. Lo que llega en produccion es
 * `sellerDoc.data() ?? {}`: Firestore no garantiza el tipo de nada, y el resto del backend ya
 * trata cada uno de estos campos con `typeof x === "string" ? x.trim() : ""`
 * (orders.ts:346, index.ts:188, shopify.ts:717...). La frontera se defiende aqui, no en la
 * llamada.
 */
type SellerOperationalData = {
  onboardingComplete?: unknown;
  cityId?: unknown;
  pickupAddress?: unknown;
  bankAccount?: unknown;
};

type MissingOperationalData = (seller: SellerOperationalData) => string[];
type OperationalDataBlockMessage = (seller: SellerOperationalData) => string | null;

/**
 * Carga diferida, como en el bloque T29 de `community-signup.test.ts`: `community-access.ts` ya
 * existe, asi que un `import` estatico de un export que todavia no esta es un error de ENLACE de
 * ESM y tumba la recoleccion del archivo entero, llevandose por delante los 15 casos de T10 y
 * T44, que no tienen nada que ver. Asi el rojo queda acotado a T35, que es donde debe estar.
 */
let missingOperationalData: MissingOperationalData;
let operationalDataBlockMessage: OperationalDataBlockMessage;

/** Una tienda que ya opera: tiene los tres datos y el onboarding cerrado. */
const tiendaCompleta: SellerOperationalData = {
  onboardingComplete: true,
  cityId: "city-cali",
  pickupAddress: "Carrera 9 #10-11, Barrio Obrero",
  bankAccount: "Bancolombia ahorros 123456789"
};

/**
 * Lo que HOY escribe `buildSignupSellerDoc` para una tienda captada por un enlace
 * (community-signup-doc.ts:73, y el literal de community-signup.test.ts:151): nace con la ciudad
 * activa, con `bankAccount: ""` y sin punto de recogida. Es el caso real, no uno inventado.
 */
const tiendaRecienRegistrada: SellerOperationalData = {
  onboardingComplete: false,
  cityId: "city-cali",
  bankAccount: ""
};

/** Registrada y sin rellenar nada todavia. */
const tiendaSinDatos: SellerOperationalData = { onboardingComplete: false };

/** Una tienda anterior a RF_44: el campo `onboardingComplete` no existe en su documento. */
const tiendaAntigua: SellerOperationalData = { cityId: "city-cali" };

/**
 * Estado incoherente: el onboarding sigue marcado como abierto pero los tres datos estan. Hoy la
 * callable tambien lo veta, y con el texto generico. Se conserva tal cual.
 */
const tiendaIncoherente: SellerOperationalData = {
  onboardingComplete: false,
  cityId: "city-cali",
  pickupAddress: "Carrera 9 #10-11",
  bankAccount: "Bancolombia ahorros 123456789"
};

/** El mensaje que HOY ve la tienda, copiado literal de `orders.ts` (~292). No puede cambiar. */
const mensajeDeHoy = (faltan: string) =>
  `Completa los datos de tu tienda antes de crear pedidos: ${faltan}.`;

describe("T35 · veto de pedidos a una tienda sin datos operativos", () => {
  // Dentro del describe y no en la raiz: un gancho de raiz que falle marca en rojo TODOS los
  // casos del archivo, incluidos los 15 de T10 y T44. Y `beforeEach` en vez de `beforeAll` para
  // que, mientras el modulo no exporte nada, los casos salgan FALLIDOS uno a uno y no omitidos:
  // un caso omitido no se distingue de un caso que nadie escribio.
  beforeEach(async () => {
    const modulo = (await import("../../functions/src/community-access")) as unknown as {
      missingOperationalData?: MissingOperationalData;
      operationalDataBlockMessage?: OperationalDataBlockMessage;
    };
    if (!modulo.missingOperationalData || !modulo.operationalDataBlockMessage) {
      throw new Error(
        "T35: functions/src/community-access.ts debe exportar `missingOperationalData` y `operationalDataBlockMessage`."
      );
    }
    missingOperationalData = modulo.missingOperationalData;
    operationalDataBlockMessage = modulo.operationalDataBlockMessage;
  });

  it("RF_44: si faltan los tres datos se nombran los tres, en el orden en que se piden", () => {
    // El orden es parte del contrato: es el que ve la tienda en el mensaje y el que sigue el
    // formulario de su perfil. `toEqual` sobre un array compara posicion a posicion.
    expect(missingOperationalData(tiendaSinDatos)).toEqual([
      "ciudad",
      "punto de recogida",
      "cuenta bancaria"
    ]);
  });

  it("RF_44: si solo falta la ciudad, solo se nombra la ciudad", () => {
    expect(
      missingOperationalData({
        onboardingComplete: false,
        pickupAddress: "Carrera 9 #10-11",
        bankAccount: "Bancolombia ahorros 123456789"
      })
    ).toEqual(["ciudad"]);
  });

  it("RF_44: si solo falta el punto de recogida, solo se nombra el punto de recogida", () => {
    expect(
      missingOperationalData({
        onboardingComplete: false,
        cityId: "city-cali",
        bankAccount: "Bancolombia ahorros 123456789"
      })
    ).toEqual(["punto de recogida"]);
  });

  it("RF_44: si solo falta la cuenta bancaria, solo se nombra la cuenta bancaria", () => {
    expect(
      missingOperationalData({
        onboardingComplete: false,
        cityId: "city-cali",
        pickupAddress: "Carrera 9 #10-11"
      })
    ).toEqual(["cuenta bancaria"]);
  });

  it("RF_44: a la tienda recien captada por un enlace le faltan recogida y cuenta", () => {
    // El documento con el que nace: ciudad puesta por el alta, `bankAccount: ""` y sin punto de
    // recogida. Es exactamente lo que vera la primera tienda que intente crear un pedido.
    expect(missingOperationalData(tiendaRecienRegistrada)).toEqual([
      "punto de recogida",
      "cuenta bancaria"
    ]);
  });

  it("RF_44: con los tres datos no falta nada y el pedido se puede crear", () => {
    expect(missingOperationalData(tiendaCompleta)).toEqual([]);
    expect(operationalDataBlockMessage(tiendaCompleta)).toBeNull();
  });

  it("RF_44: una tienda SIN el campo `onboardingComplete` crea pedidos aunque le falte todo", () => {
    // EL CASO QUE MAS IMPORTA. La comparacion es `=== false` explicito y esta comentada asi en
    // `orders.ts`. Ninguna de las tiendas que ya existian tiene el campo: si "sin campo" contara
    // como onboarding abierto, TODA la plataforma se quedaria sin poder crear un solo pedido.
    // Ni un `!seller.onboardingComplete`, ni un `?? false`, ni un `Boolean(...)`.
    expect(missingOperationalData(tiendaAntigua)).toEqual([]);
    expect(operationalDataBlockMessage(tiendaAntigua)).toBeNull();
    // El caso extremo: tienda antigua a la que ademas le faltan los tres datos. Sigue creando.
    expect(missingOperationalData({})).toEqual([]);
    expect(operationalDataBlockMessage({})).toBeNull();
  });

  it("RF_44: solo el `false` booleano abre el veto; ningun otro valor lo hace", () => {
    // Firestore no garantiza el tipo. Un `undefined`, un `null`, un 0 o la cadena "false" NO son
    // el booleano `false`, y por tanto no vetan nada — misma razon que el caso anterior.
    expect(operationalDataBlockMessage({ onboardingComplete: undefined })).toBeNull();
    expect(operationalDataBlockMessage({ onboardingComplete: null })).toBeNull();
    expect(operationalDataBlockMessage({ onboardingComplete: "false" })).toBeNull();
    expect(operationalDataBlockMessage({ onboardingComplete: 0 })).toBeNull();
    expect(operationalDataBlockMessage({ onboardingComplete: true })).toBeNull();
    // Y el unico que si.
    expect(operationalDataBlockMessage({ onboardingComplete: false })).not.toBeNull();
  });

  it("RF_44: el mensaje nombra cual falta y dice donde completarlo", () => {
    // Texto identico al que hoy construye `orders.ts`: la extraccion no puede cambiar ni una
    // coma de lo que lee la tienda. "los datos de tu tienda" es el "donde" que pide RF_44.
    expect(operationalDataBlockMessage(tiendaRecienRegistrada)).toBe(
      mensajeDeHoy("punto de recogida, cuenta bancaria")
    );
    expect(operationalDataBlockMessage(tiendaSinDatos)).toBe(
      mensajeDeHoy("ciudad, punto de recogida, cuenta bancaria")
    );
  });

  it("RF_44: cuando se sabe que falta, el mensaje NO se refugia en el generico", () => {
    for (const tienda of [tiendaSinDatos, tiendaRecienRegistrada]) {
      expect(operationalDataBlockMessage(tienda)).not.toContain("datos pendientes");
    }
  });

  it("RF_44: el generico solo aparece en el estado incoherente, y ahi sigue vetando", () => {
    // Onboarding abierto con los tres datos puestos. No hay nada que nombrar, pero hoy la
    // callable veta igual, y eso no se toca: el veto no puede depender de una lista vacia.
    expect(missingOperationalData(tiendaIncoherente)).toEqual([]);
    expect(operationalDataBlockMessage(tiendaIncoherente)).toBe(mensajeDeHoy("datos pendientes"));
  });

  it("RF_44: un dato vacio o de solo espacios no es un dato", () => {
    // OJO, unica divergencia deliberada con el `!valor` de hoy: `!" "` es false, asi que hoy un
    // punto de recogida de un espacio cuenta como puesto. Pero el pedido lo escribe con
    // `pickupAddress: seller.pickupAddress.trim()` (orders.ts:346), o sea "": el domiciliario se
    // queda sin direccion de recogida y nadie se entera. Una cadena en blanco no es un dato.
    expect(
      missingOperationalData({
        onboardingComplete: false,
        cityId: "   ",
        pickupAddress: "",
        bankAccount: "\t\n"
      })
    ).toEqual(["ciudad", "punto de recogida", "cuenta bancaria"]);
  });

  it("RF_44: un valor que no es texto tampoco es un dato operativo", () => {
    // Mismo criterio que el resto del backend, que lee estos campos como
    // `typeof x === "string" ? x.trim() : ""`. Un numero o un objeto en `bankAccount` no es un
    // numero de cuenta al que transferir.
    expect(
      missingOperationalData({
        onboardingComplete: false,
        cityId: 0,
        pickupAddress: null,
        bankAccount: { numero: "123" }
      })
    ).toEqual(["ciudad", "punto de recogida", "cuenta bancaria"]);
  });

  it("RF_44: la lista y el mensaje jamas se contradicen", () => {
    // Son dos consumidores distintos —la interfaz senala el campo, la callable lanza el error— y
    // si cada uno decidiera por su cuenta acabarian diciendo cosas distintas al mismo usuario.
    const tiendas = [
      tiendaCompleta,
      tiendaRecienRegistrada,
      tiendaSinDatos,
      tiendaAntigua,
      tiendaIncoherente
    ];
    for (const tienda of tiendas) {
      const faltan = missingOperationalData(tienda);
      const mensaje = operationalDataBlockMessage(tienda);
      if (faltan.length > 0) {
        expect(mensaje).not.toBeNull();
        for (const etiqueta of faltan) expect(mensaje).toContain(etiqueta);
      }
    }
  });

  it("RF_44: el veto no mira pedidos, ni saldos, ni comunidad: solo los tres datos", () => {
    // La aridad se fija a proposito, igual que en T44/RF_42. El dia que alguien quiera
    // condicionar la creacion de pedidos a que la tienda "no deba nada" o a que su comunidad
    // este activa, tendra que cambiar la firma y pasar por aqui. RF_44 habla de tres datos y de
    // nada mas: entrar y moverse por la aplicacion se permite siempre.
    expect(missingOperationalData.length).toBe(1);
    expect(operationalDataBlockMessage.length).toBe(1);
    // Y es puro: no toca lo que recibe.
    const tienda: SellerOperationalData = { onboardingComplete: false, cityId: "city-cali" };
    missingOperationalData(tienda);
    operationalDataBlockMessage(tienda);
    expect(tienda).toEqual({ onboardingComplete: false, cityId: "city-cali" });
  });
});

/**
 * T36 · Reasignar una tienda NO mueve el cashback ya causado (RF_11).
 * T37 · Desactivar a un lider NO borra la deuda que la plataforma tiene con el (RF_51).
 *
 * Las dos mitades que faltaban. De RF_11 ya se prueba QUIEN puede reasignar
 * (`canReassignSellerCommunity`, arriba); de RF_51 ya se prueba que el lider desactivado no entra
 * (`leaderCanSignIn`, arriba). Lo que no estaba probado es el MUST NOT de cada uno, que es donde
 * esta el dinero:
 *
 *   - RF_11: "...y esa reasignacion MUST NOT mover el cashback ya causado por el lider anterior".
 *   - RF_51: "...MUST conservar intactos su comunidad, su historial de precios y su cashback
 *     pendiente: desactivar a un lider MUST NOT borrar una deuda que la plataforma tiene con el".
 *
 * Hoy la unica garantia de lo primero es un comentario suelto dentro de `reassignSellerCommunity`
 * (functions/src/communities.ts:465): "El cashback ya causado se queda con el lider que lo causo:
 * no se toca ningun asiento". Un comentario no impide nada. La segunda no tiene ni comentario: el
 * `update({ status, updatedAt })` de `setCommunityLeaderStatus` es correcto hoy por lo que NO
 * escribe, y eso no se puede afirmar sobre un `update` inline.
 *
 * De ahi la forma: un plan PURO que declare lo que se toca, para poder afirmar sobre la estructura
 * ENTERA que no toca nada mas. Es el mismo instrumento de T31/T32/T44 y es el unico que sobrevive
 * al paso del tiempo: comprobar los campos de hoy uno a uno no dice nada de la operacion que
 * alguien anada manana; un barrido sobre el plan entero, si.
 *
 * OJO con el marcador de borrado de campo. Hoy la callable escribe
 * `communityId: parsed.data.communityId || FieldValue.delete()`, y `FieldValue` viene de
 * firebase-admin: un nucleo puro no puede devolverlo. El plan declara el borrado con un marcador
 * propio, `UNSET_FIELD`, y la callable lo traduce. El marcador se llama "unset" y no "delete" a
 * proposito: el barrido que protege el dinero busca verbos de destruccion en el plan entero, y un
 * marcador legitimo llamado "delete" obligaria a apagar justo la prueba que importa.
 */

/** Marcador de "quitar este campo del documento". La callable lo traduce a `FieldValue.delete()`. */
type UnsetFieldMarker = { readonly kind: "unset" };

/** Lo que la callable lee del documento de la tienda antes de reasignarla. */
type ReassignmentSeller = { id: string; communityId?: string };

type SellerReassignmentPlan = {
  sellerId: string;
  previousCommunityId: string | null;
  nextCommunityId: string | null;
  changed: boolean;
  sellerUpdate: Partial<{
    communityId: string | UnsetFieldMarker;
    communityJoinedAt: string | UnsetFieldMarker;
  }>;
  collectionsTouched: readonly string[];
};

/**
 * El documento de la comunidad tal como lo escribe `createCommunityLeader` (communities.ts:88):
 * ahi viven tambien el precio vigente y el historial, que es justo lo que RF_51 manda conservar.
 */
type CommunityRecord = {
  id: string;
  status?: string;
  linkStatus?: string;
  pricing?: Record<string, number>;
  pricingHistory?: { at: string; concept: string; author: string }[];
};

type LeaderStatusPlan = {
  communityId: string;
  previousStatus: string | null;
  nextStatus: string;
  changed: boolean;
  communityUpdate: Partial<{ status: string; updatedAt: string }>;
  collectionsTouched: readonly string[];
};

type PlanSellerReassignment = (
  seller: ReassignmentSeller,
  communityId: string | undefined,
  nowIso: string
) => SellerReassignmentPlan;

type PlanLeaderStatusChange = (
  community: CommunityRecord,
  status: "active" | "disabled",
  nowIso: string
) => LeaderStatusPlan;

type IsUnsetField = (value: unknown) => boolean;

/**
 * Carga diferida, por lo mismo que en T35: `community-access.ts` ya existe, asi que importar de
 * forma estatica un export que todavia no esta es un error de ENLACE de ESM y tumba la
 * recoleccion del archivo entero, llevandose por delante los 30 casos de T10, T44 y T35.
 */
let planSellerReassignment: PlanSellerReassignment;
let planLeaderStatusChange: PlanLeaderStatusChange;
let unsetField: UnsetFieldMarker;
let isUnsetField: IsUnsetField;

type CommunityAccessPlanModule = {
  planSellerReassignment?: PlanSellerReassignment;
  planLeaderStatusChange?: PlanLeaderStatusChange;
  UNSET_FIELD?: UnsetFieldMarker;
  isUnsetField?: IsUnsetField;
};

const cargarPlanes = async (): Promise<void> => {
  const modulo = (await import(
    "../../functions/src/community-access"
  )) as unknown as CommunityAccessPlanModule;
  if (
    !modulo.planSellerReassignment ||
    !modulo.planLeaderStatusChange ||
    !modulo.UNSET_FIELD ||
    !modulo.isUnsetField
  ) {
    throw new Error(
      "T36/T37: functions/src/community-access.ts debe exportar `planSellerReassignment`, `planLeaderStatusChange`, `UNSET_FIELD` e `isUnsetField`."
    );
  }
  planSellerReassignment = modulo.planSellerReassignment;
  planLeaderStatusChange = modulo.planLeaderStatusChange;
  unsetField = modulo.UNSET_FIELD;
  isUnsetField = modulo.isUnsetField;
};

/** Recorre la estructura ENTERA: claves y valores de texto, a cualquier profundidad. */
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

const fragmentosQueCoinciden = (plan: unknown, prohibido: RegExp): string[] => {
  const encontrados: string[] = [];
  recorrerPlan(plan, (fragment) => {
    if (prohibido.test(fragment)) encontrados.push(fragment);
  });
  return encontrados;
};

/** Todo lo que huele a dinero causado: asientos, cortes, saldos, pedidos. */
const DINERO =
  /wallet|cashback|settlement|liquidac|corte|asiento|entr(y|ies)|saldo|abono|payout|ledger|balance|deuda|debt|order|pedido|recaud|efectivo/i;

/** Cualquier rastro de destruccion. El marcador legitimo se llama `unset` y no cae aqui. */
const DESTRUCCION = /delete|remove|destroy|purge|erase|drop|wipe|truncate|revoke|borr|elimin|anul/i;

/** El precio vigente y su historial, que RF_51 manda conservar intactos. */
const PRECIOS = /pricing|precio|tarifa|histor|floor|piso/i;

const AHORA = "2026-09-10T12:00:00.000Z";

const tiendaEnComunidad: ReassignmentSeller = { id: "seller-1", communityId: "com-1" };
const tiendaSinAdscripcion: ReassignmentSeller = { id: "seller-0" };

describe("T36 · reasignar una tienda no mueve el cashback ya causado", () => {
  // Dentro del describe y no en la raiz: un gancho de raiz que falle marca en rojo TODOS los
  // casos del archivo. Y `beforeEach` en vez de `beforeAll` para que, mientras el modulo no
  // exporte nada, los casos salgan FALLIDOS uno a uno y no omitidos.
  beforeEach(cargarPlanes);

  it("RF_11: la tienda cambia de comunidad escribiendo esos dos campos y ningun otro", () => {
    const plan = planSellerReassignment(tiendaEnComunidad, "com-2", AHORA);
    expect(plan.sellerId).toBe("seller-1");
    expect(plan.previousCommunityId).toBe("com-1");
    expect(plan.nextCommunityId).toBe("com-2");
    expect(plan.changed).toBe(true);
    // `toEqual` sobre las claves, no `toMatchObject` sobre el objeto: lo que se afirma aqui es que
    // no hay un tercer campo, que es todo el punto de la prueba.
    expect(Object.keys(plan.sellerUpdate)).toEqual(["communityId", "communityJoinedAt"]);
    expect(plan.sellerUpdate).toEqual({ communityId: "com-2", communityJoinedAt: AHORA });
  });

  it("RF_11: una tienda sin comunidad entra en una, y el plan declara que no venia de ninguna", () => {
    const plan = planSellerReassignment(tiendaSinAdscripcion, "com-2", AHORA);
    expect(plan.previousCommunityId).toBeNull();
    expect(plan.nextCommunityId).toBe("com-2");
    expect(plan.sellerUpdate).toEqual({ communityId: "com-2", communityJoinedAt: AHORA });
  });

  it("RF_11: sacar a una tienda de su comunidad se declara con el marcador, no con un vacio", () => {
    // Hoy la callable hace `parsed.data.communityId || FieldValue.delete()`, o sea que sin
    // comunidad de destino QUITA los dos campos. Se conserva, pero declarado: un `""` guardado en
    // `communityId` haria que la tienda pareciera adscrita a una comunidad de nombre vacio.
    for (const destino of [undefined, "", "   "]) {
      const plan = planSellerReassignment(tiendaEnComunidad, destino, AHORA);
      expect(plan.nextCommunityId).toBeNull();
      expect(plan.changed).toBe(true);
      expect(Object.keys(plan.sellerUpdate)).toEqual(["communityId", "communityJoinedAt"]);
      expect(plan.sellerUpdate.communityId).toBe(unsetField);
      expect(plan.sellerUpdate.communityJoinedAt).toBe(unsetField);
    }
  });

  it("RF_11: el marcador se reconoce por su guarda, que es lo que traduce la callable", () => {
    // El nucleo es puro y no puede devolver un `FieldValue` de firebase-admin. `communities.ts`
    // traduce con esta guarda: `isUnsetField(v) ? FieldValue.delete() : v`. Si la guarda dijera
    // que si a una cadena, la callable borraria el campo en vez de escribirlo.
    expect(isUnsetField(unsetField)).toBe(true);
    expect(isUnsetField("com-2")).toBe(false);
    expect(isUnsetField("")).toBe(false);
    expect(isUnsetField(undefined)).toBe(false);
    expect(isUnsetField(null)).toBe(false);
    expect(isUnsetField({ kind: "otra-cosa" })).toBe(false);
    expect(isUnsetField({})).toBe(false);
    expect(isUnsetField(AHORA)).toBe(false);
  });

  it("RF_11: el plan no nombra asientos, cashback, cortes ni pedidos, en ninguna de sus formas", () => {
    // EL CASO DE RF_11. Deliberadamente NO se comprueban los campos de hoy uno a uno: se recorre
    // el plan ENTERO, claves y valores a cualquier profundidad. El cashback ya causado se queda
    // con el lider que lo causo, y una operacion nueva que lo tocara tendria que nombrarlo.
    const planes = [
      planSellerReassignment(tiendaEnComunidad, "com-2", AHORA),
      planSellerReassignment(tiendaSinAdscripcion, "com-2", AHORA),
      planSellerReassignment(tiendaEnComunidad, undefined, AHORA)
    ];
    for (const plan of planes) expect(fragmentosQueCoinciden(plan, DINERO)).toEqual([]);
  });

  it("RF_11: el plan no lleva ninguna orden de destruccion mas alla del marcador de campo", () => {
    const planes = [
      planSellerReassignment(tiendaEnComunidad, "com-2", AHORA),
      planSellerReassignment(tiendaEnComunidad, undefined, AHORA)
    ];
    for (const plan of planes) expect(fragmentosQueCoinciden(plan, DESTRUCCION)).toEqual([]);
  });

  it("RF_11: el plan declara en positivo que su alcance es la tienda y nada mas", () => {
    // En positivo, no por ausencia: la lista COMPLETA de colecciones que la operacion puede
    // tocar. Anadir `walletEntries` para "mover el cashback a la comunidad nueva" —que es
    // exactamente lo que RF_11 prohibe— tendria que pasar por esta linea.
    for (const destino of ["com-2", undefined]) {
      const plan = planSellerReassignment(tiendaEnComunidad, destino, AHORA);
      expect([...plan.collectionsTouched]).toEqual(["sellers"]);
    }
  });

  it("RF_11: reasignar a la MISMA comunidad no reescribe la fecha de ingreso", () => {
    // No es un capricho de idempotencia. `communityJoinedAt` es el eje por el que la contencion
    // de un enlace filtrado selecciona a quien cerrar (RF_41: `where(\"communityJoinedAt\", \">=\",
    // fromIso)`, community-containment.ts). Un doble clic del administrador sobre la comunidad
    // que la tienda ya tiene le moveria la fecha a hoy y la sacaria del rango de la limpieza,
    // en silencio. Sin cambio de comunidad no hay nada que escribir.
    const plan = planSellerReassignment(tiendaEnComunidad, "com-1", AHORA);
    expect(plan.changed).toBe(false);
    expect(plan.sellerUpdate).toEqual({});
    expect(plan.previousCommunityId).toBe("com-1");
    expect(plan.nextCommunityId).toBe("com-1");
  });

  it("RF_11: sacar de la comunidad a una tienda que ya no tenia tampoco escribe nada", () => {
    const plan = planSellerReassignment(tiendaSinAdscripcion, undefined, AHORA);
    expect(plan.changed).toBe(false);
    expect(plan.sellerUpdate).toEqual({});
    expect(plan.previousCommunityId).toBeNull();
    expect(plan.nextCommunityId).toBeNull();
  });

  it("RF_11: el destino se compara ya recortado: ' com-1 ' es com-1, no una comunidad nueva", () => {
    // La callable valida con `z.string().trim().optional()`, asi que lo que llegue con espacios
    // llega recortado. Que el nucleo aplique el mismo criterio evita que las dos capas discrepen
    // y que un espacio de mas cuente como cambio de comunidad y mueva la fecha de ingreso.
    const plan = planSellerReassignment(tiendaEnComunidad, "  com-1  ", AHORA);
    expect(plan.nextCommunityId).toBe("com-1");
    expect(plan.changed).toBe(false);
    expect(plan.sellerUpdate).toEqual({});
  });

  it("RF_11: el instante lo pone quien llama, no un reloj global", () => {
    const otroInstante = "2027-01-31T05:00:00.000Z";
    const plan = planSellerReassignment(tiendaEnComunidad, "com-2", otroInstante);
    expect(plan.sellerUpdate.communityJoinedAt).toBe(otroInstante);
  });

  it("RF_11: el plan es puro: tres datos de entrada y ni uno se modifica", () => {
    // La aridad se fija a proposito, igual que en T44/RF_42 y T35/RF_44. El dia que alguien
    // quiera pasarle los asientos del lider anterior "para reasignarlos", tendra que cambiar la
    // firma y pasar por aqui.
    expect(planSellerReassignment.length).toBe(3);
    const tienda: ReassignmentSeller = { id: "seller-1", communityId: "com-1" };
    planSellerReassignment(tienda, "com-2", AHORA);
    expect(tienda).toEqual({ id: "seller-1", communityId: "com-1" });
  });
});

/** Una comunidad con precio vigente e historial: lo que RF_51 manda conservar intacto. */
const comunidadActiva: CommunityRecord = {
  id: "com-1",
  status: "active",
  linkStatus: "active",
  pricing: { delivery: 9000, returnFee: 4000 },
  pricingHistory: [{ at: "2026-08-01T00:00:00.000Z", concept: "delivery", author: "u-lider" }]
};

const comunidadDesactivada: CommunityRecord = { ...comunidadActiva, status: "disabled" };

/** Documento anterior a RF_51: nunca se le escribio `status`. */
const comunidadSinEstado: CommunityRecord = { id: "com-antigua" };

describe("T37 · desactivar a un lider no borra la deuda pendiente con el", () => {
  beforeEach(cargarPlanes);

  it("RF_51: desactivar cambia el estado y lo sella, y no escribe un campo mas", () => {
    const plan = planLeaderStatusChange(comunidadActiva, "disabled", AHORA);
    expect(plan.communityId).toBe("com-1");
    expect(plan.previousStatus).toBe("active");
    expect(plan.nextStatus).toBe("disabled");
    expect(plan.changed).toBe(true);
    expect(Object.keys(plan.communityUpdate)).toEqual(["status", "updatedAt"]);
    expect(plan.communityUpdate).toEqual({ status: "disabled", updatedAt: AHORA });
    // Y lo unico que consigue: que no entre. Que es la mitad de RF_51 que ya estaba probada.
    expect(leaderCanSignIn({ status: plan.communityUpdate.status ?? "" })).toBe(false);
  });

  it("RF_51: reactivar es exactamente simetrico", () => {
    const plan = planLeaderStatusChange(comunidadDesactivada, "active", AHORA);
    expect(plan.previousStatus).toBe("disabled");
    expect(plan.nextStatus).toBe("active");
    expect(plan.changed).toBe(true);
    expect(plan.communityUpdate).toEqual({ status: "active", updatedAt: AHORA });
    expect(leaderCanSignIn({ status: plan.communityUpdate.status ?? "" })).toBe(true);
    // Reactivar no resucita nada ni reabre el enlace: RF_05 y RF_06 son otra decision.
    expect(plan.communityUpdate).not.toHaveProperty("linkStatus");
  });

  it("RF_51: el plan no nombra el cashback pendiente, ni asientos, ni cortes, ni saldos", () => {
    // EL CASO DE RF_51. El cashback pendiente de un lider desactivado sigue siendo una deuda de
    // la plataforma con el: la desactivacion corta el acceso, no la deuda. Si el plan ni siquiera
    // puede mencionar esas colecciones, no hay forma de que las marque, las cierre ni las borre.
    for (const status of ["disabled", "active"] as const) {
      const plan = planLeaderStatusChange(comunidadActiva, status, AHORA);
      expect(fragmentosQueCoinciden(plan, DINERO)).toEqual([]);
    }
  });

  it("RF_51: el plan no toca el historial de precios ni el precio vigente", () => {
    // La comunidad entra con `pricing` e `pricingHistory` puestos. El plan no los copia, no los
    // reescribe y ni siquiera los nombra: se quedan tal cual estaban en el documento.
    const plan = planLeaderStatusChange(comunidadActiva, "disabled", AHORA);
    expect(fragmentosQueCoinciden(plan, PRECIOS)).toEqual([]);
    expect(plan.communityUpdate).not.toHaveProperty("pricing");
    expect(plan.communityUpdate).not.toHaveProperty("pricingHistory");
  });

  it("RF_51: el plan no lleva ninguna orden de destruccion", () => {
    const plan = planLeaderStatusChange(comunidadActiva, "disabled", AHORA);
    expect(fragmentosQueCoinciden(plan, DESTRUCCION)).toEqual([]);
  });

  it("RF_51: el alcance declarado es la comunidad, y las tiendas del lider quedan fuera", () => {
    // En positivo, la lista COMPLETA. "Sus tiendas siguen operando" es un caso limite explicito
    // de la spec: la desactivacion no puede alcanzar a `sellers` ni para desadscribirlas.
    const plan = planLeaderStatusChange(comunidadActiva, "disabled", AHORA);
    expect([...plan.collectionsTouched]).toEqual(["communities"]);
    expect(plan.collectionsTouched).not.toContain("sellers");
  });

  it("RF_51: desactivar a quien ya estaba desactivado no vuelve a sellar la comunidad", () => {
    // Repetir la accion no debe mover `updatedAt`: ese sello es lo unico con lo que se audita
    // cuando se corto el acceso, y reescribirlo sin cambiar nada hace que el rastro mienta.
    const plan = planLeaderStatusChange(comunidadDesactivada, "disabled", AHORA);
    expect(plan.changed).toBe(false);
    expect(plan.communityUpdate).toEqual({});
    expect(plan.previousStatus).toBe("disabled");
    expect(plan.nextStatus).toBe("disabled");
  });

  it("RF_51: una comunidad sin el campo `status` se desactiva igual, declarando que no lo tenia", () => {
    // Ninguna comunidad anterior a RF_51 tiene el campo. Tratar "sin campo" como ya desactivada
    // dejaria a su lider sin poder entrar sin que nadie lo hubiera decidido; tratarlo como un
    // no-cambio al desactivar dejaria el acceso abierto. Se escribe, y el previo se declara nulo.
    const plan = planLeaderStatusChange(comunidadSinEstado, "disabled", AHORA);
    expect(plan.previousStatus).toBeNull();
    expect(plan.changed).toBe(true);
    expect(plan.communityUpdate).toEqual({ status: "disabled", updatedAt: AHORA });
  });

  it("RF_51: el instante lo pone quien llama, y el plan es puro", () => {
    const otroInstante = "2027-01-31T05:00:00.000Z";
    expect(planLeaderStatusChange(comunidadActiva, "disabled", otroInstante).communityUpdate).toEqual({
      status: "disabled",
      updatedAt: otroInstante
    });
    expect(planLeaderStatusChange.length).toBe(3);
    const comunidad: CommunityRecord = { id: "com-1", status: "active", pricing: { delivery: 9000 } };
    planLeaderStatusChange(comunidad, "disabled", AHORA);
    expect(comunidad).toEqual({ id: "com-1", status: "active", pricing: { delivery: 9000 } });
  });
});

/**
 * T41 · El veto de tarifas: un lider encarece lo suyo y no toca el pago a terceros (RF_27).
 *
 * Arriba, en T10, ya se prueba la mitad facil de RF_27: `canEditCommunityPricing` dice que si al
 * lider sobre SU comunidad y que no sobre una ajena. Lo que no esta probado es la otra mitad, que
 * es la que mueve dinero de otra gente:
 *
 *   RF_27: "...y ese ajuste MUST NOT alcanzar al pago del lider logistico, al del mensajero ni al
 *   costo de producto."
 *
 * Hoy esa frontera existe SOLO por omision: `COMMUNITY_PRICING_FIELDS` tiene tres campos y
 * `tariffFields` (wallet-entries.ts:25) tiene cinco; los dos que sobran —`driverDeliveredPayCop` y
 * `driverFailedPayCop`— son el pago al lider logistico y al mensajero. Y el costo de producto ni
 * siquiera es una tarifa: es el asiento `product_cost` que `buildWalletEntries` calcula desde el
 * catalogo (regla de oro #2). Que hoy no se pueda tocar es cierto porque nadie lo puso en la lista,
 * no porque algo lo impida. Un `z.enum([...tariffFields])` en `communities.ts:277` —un cambio de una
 * linea, que ademas parece una mejora: "que el lider ajuste todas las tarifas de su comunidad"— y
 * el lider se estaria bajando el sueldo del mensajero sin que nada se ponga rojo.
 *
 * Por eso el veto sale a un predicado propio y por CONCEPTO, no por lista: `canEditTariffConcept`.
 * Una lista contesta "que campos hay"; un predicado contesta "quien puede tocar este", que es la
 * pregunta que hay que responder tambien para el concepto que alguien anada manana.
 *
 * Contrato:
 *   export type TariffConcept =
 *     | "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop"
 *     | "driverDeliveredPayCop" | "driverFailedPayCop" | "product_cost";
 *   export const TARIFF_CONCEPTS: readonly TariffConcept[];
 *   export function canEditTariffConcept(actor: Actor, communityId: string, concept: TariffConcept): boolean;
 */

/**
 * Los dos constantes reales con las que el veto tiene que casar. Son imports de VALOR de modulos
 * que ya existen y ya exportan esto, asi que no tumban la recoleccion. `wallet-entries.ts` es puro
 * (sin firebase-admin) a proposito, justo para poder leerlo desde una prueba.
 */
import { COMMUNITY_PRICING_FIELDS } from "../../functions/src/community-pricing";
import { tariffFields } from "../../functions/src/wallet-entries";

/**
 * El tipo se importa del nucleo con `import type`, y esto es deliberado: un import de tipo lo borra
 * el transpilador antes de ejecutar nada, asi que —al reves que un import de valor— pedir un tipo
 * que todavia no existe NO es un error de enlace de ESM y no se lleva por delante los 51 casos ya
 * verdes de T10, T44, T35, T36 y T37. Lo que si hace es que `npx tsc --noEmit` se ponga rojo hasta
 * que el nucleo declare el tipo, que es exactamente la mitad en compilacion que pide esta tarea:
 * anadir un concepto de pago a terceros sin decidir quien lo toca tiene que cantarlo `tsc` en el
 * `Record<TariffConcept, ...>` de aqui abajo, ademas del aserto en ejecucion.
 */
import type { TariffConcept } from "../../functions/src/community-access";

type CanEditTariffConcept = (actor: Actor, communityId: string, concept: TariffConcept) => boolean;

/** Quien decide cada concepto. No hay tercera opcion: o lo fija el lider, o no lo fija. */
type QuienLoFija = "el lider de su comunidad" | "solo el administrador";

/**
 * LA TABLA. Un `Record` sobre la union completa: un concepto nuevo en `TariffConcept` sin una
 * entrada aqui no compila, y quien lo anada tendra que escribir en esta linea si el lider puede
 * subirlo o no. Los tres de abajo son pago a terceros y costo de catalogo: los tres que RF_27
 * nombra uno a uno.
 */
const QUIEN_FIJA_CADA_CONCEPTO: Record<TariffConcept, QuienLoFija> = {
  sellerDeliveredFeeCop: "el lider de su comunidad",
  sellerFailedFeeCop: "el lider de su comunidad",
  fulfillmentFeeCop: "el lider de su comunidad",
  driverDeliveredPayCop: "solo el administrador",
  driverFailedPayCop: "solo el administrador",
  product_cost: "solo el administrador"
};

const CONCEPTOS_DEL_LIDER = (Object.keys(QUIEN_FIJA_CADA_CONCEPTO) as TariffConcept[]).filter(
  (concepto) => QUIEN_FIJA_CADA_CONCEPTO[concepto] === "el lider de su comunidad"
);
const CONCEPTOS_VETADOS = (Object.keys(QUIEN_FIJA_CADA_CONCEPTO) as TariffConcept[]).filter(
  (concepto) => QUIEN_FIJA_CADA_CONCEPTO[concepto] === "solo el administrador"
);

/**
 * Carga diferida, igual que en T35/T36/T37: `community-access.ts` ya existe, asi que un import de
 * VALOR de un export que todavia no esta si es un error de enlace y tumbaria el archivo entero.
 */
let canEditTariffConcept: CanEditTariffConcept;
let tariffConcepts: readonly TariffConcept[];

const cargarVetoDeTarifas = async (): Promise<void> => {
  const modulo = (await import("../../functions/src/community-access")) as unknown as {
    canEditTariffConcept?: CanEditTariffConcept;
    TARIFF_CONCEPTS?: readonly TariffConcept[];
  };
  if (!modulo.canEditTariffConcept || !modulo.TARIFF_CONCEPTS) {
    throw new Error(
      "T41: functions/src/community-access.ts debe exportar `canEditTariffConcept` y `TARIFF_CONCEPTS`."
    );
  }
  canEditTariffConcept = modulo.canEditTariffConcept;
  tariffConcepts = modulo.TARIFF_CONCEPTS;
};

describe("T41 · el lider fija sus tarifas y no el pago a terceros", () => {
  beforeEach(cargarVetoDeTarifas);

  it("RF_27: el lider no modifica el pago al lider logistico por pedido entregado", () => {
    // Una asercion y un concepto por caso, a proposito: si manana se anade otro pago a terceros y
    // el veto se le olvida a alguien, tiene que verse en el nombre del caso CUAL quedo abierto, no
    // en un bucle que solo dice "falla el veto".
    expect(canEditTariffConcept(lider, "com-1", "driverDeliveredPayCop")).toBe(false);
  });

  it("RF_27: el lider no modifica el pago al mensajero por pedido fallido", () => {
    expect(canEditTariffConcept(lider, "com-1", "driverFailedPayCop")).toBe(false);
  });

  it("RF_27: el lider no modifica el costo de producto, que sale del catalogo", () => {
    // El costo de producto no es una tarifa de comunidad y nunca puede llegar a serlo: es el
    // asiento `product_cost`, costo del item por unidad de Shopify por cantidad real de Shopify
    // (regla de oro #2). Si un lider pudiera moverlo, estaria reescribiendo el margen de la tienda.
    expect(canEditTariffConcept(lider, "com-1", "product_cost")).toBe(false);
  });

  it("RF_27: el veto es del lider, no de todos: el administrador si fija los tres", () => {
    // El error simetrico, y el que se cuela sin ruido: un veto escrito como "este concepto no se
    // toca" en vez de "este concepto no lo toca el lider" deja a la plataforma sin poder ajustar
    // lo que le paga a su propia operacion.
    for (const concepto of CONCEPTOS_VETADOS) {
      expect(canEditTariffConcept(admin, "com-1", concepto)).toBe(true);
    }
    expect(CONCEPTOS_VETADOS).toEqual(["driverDeliveredPayCop", "driverFailedPayCop", "product_cost"]);
  });

  it("RF_27: el lider si fija sus tres conceptos, y solo en SU comunidad", () => {
    for (const concepto of CONCEPTOS_DEL_LIDER) {
      expect(canEditTariffConcept(lider, "com-1", concepto)).toBe(true);
      expect(canEditTariffConcept(lider, "com-2", concepto)).toBe(false);
      expect(canEditTariffConcept(otroLider, "com-1", concepto)).toBe(false);
    }
  });

  it("RF_27: el veto no se relaja para nadie mas: ningun otro rol fija tarifa alguna", () => {
    // Los cinco roles restantes contra los seis conceptos. Un logistico de tienda confirma pedidos
    // de su tienda (RF_43) y eso no le da precio; un domiciliario menos todavia sobre su propio pago.
    for (const concepto of Object.keys(QUIEN_FIJA_CADA_CONCEPTO) as TariffConcept[]) {
      expect(canEditTariffConcept(tienda, "com-1", concepto)).toBe(false);
      expect(canEditTariffConcept(logistico, "com-1", concepto)).toBe(false);
      expect(canEditTariffConcept(transportista, "com-1", concepto)).toBe(false);
      expect(canEditTariffConcept(mensajero, "com-1", concepto)).toBe(false);
    }
  });

  it("RF_27: la lista de conceptos esta completa y ninguno se quedo sin dueno", () => {
    // La mitad en EJECUCION de la exhaustividad. `tsc` obliga a que el `Record` cubra la union;
    // esto obliga a que la union cubra la realidad: los cinco campos de tarifa con los que
    // `buildWalletEntries` calcula el dinero de un pedido, mas el costo de producto.
    expect([...tariffConcepts].sort()).toEqual((Object.keys(QUIEN_FIJA_CADA_CONCEPTO) as string[]).sort());
    expect([...tariffConcepts].sort()).toEqual([...tariffFields, "product_cost"].sort());
    // Y cada concepto declarado tiene una respuesta para el lider: ni `undefined`, ni excepcion.
    for (const concepto of tariffConcepts) {
      expect(typeof canEditTariffConcept(lider, "com-1", concepto)).toBe("boolean");
    }
  });

  it("RF_27: lo que el lider puede tocar es EXACTAMENTE lo que hoy valida la callable", () => {
    // El veto y `COMMUNITY_PRICING_FIELDS` (el `z.enum` de communities.ts:277) tienen que decir lo
    // mismo, porque si no acaban discrepando: ampliar el enum a los cinco `tariffFields` seguiria
    // dejando el predicado verde y viceversa. Aqui se atan, en las dos direcciones.
    expect(CONCEPTOS_DEL_LIDER).toEqual([...COMMUNITY_PRICING_FIELDS]);
    for (const campo of COMMUNITY_PRICING_FIELDS) {
      expect(canEditTariffConcept(lider, "com-1", campo)).toBe(true);
    }
    // Y los dos campos de tarifa que NO estan en la lista de la callable son, uno a uno, pago a
    // terceros vetado. Se calcula desde `tariffFields` para que anadir un campo de pago nuevo a
    // wallet-entries sin vetarlo caiga aqui.
    const pagosATerceros = tariffFields.filter(
      (campo) => !(COMMUNITY_PRICING_FIELDS as readonly string[]).includes(campo)
    );
    expect(pagosATerceros).toEqual(["driverDeliveredPayCop", "driverFailedPayCop"]);
    for (const campo of pagosATerceros) {
      expect(canEditTariffConcept(lider, "com-1", campo)).toBe(false);
    }
  });

  it("RF_27: el veto coincide con `canEditCommunityPricing` alla donde los dos opinan", () => {
    // `canEditCommunityPricing` sigue contestando "puede este actor tocar precios de esta
    // comunidad"; `canEditTariffConcept` afina POR CONCEPTO. Para los tres conceptos del lider las
    // dos preguntas son la misma y no pueden dar respuestas distintas: si divergen, la pantalla
    // ensena un control que el servidor rechaza, o al reves.
    const actores: Actor[] = [admin, lider, otroLider, tienda, logistico, transportista, mensajero];
    for (const actor of actores) {
      for (const comunidad of ["com-1", "com-2"]) {
        for (const concepto of CONCEPTOS_DEL_LIDER) {
          if (actor.role === "admin") continue; // el admin puede todo; `canEditCommunityPricing` no le aplica
          expect(canEditTariffConcept(actor, comunidad, concepto)).toBe(
            canEditCommunityPricing(actor, comunidad)
          );
        }
      }
    }
  });

  it("RF_27: el permiso mira quien, que comunidad y que concepto, y nada mas", () => {
    // La aridad se fija igual que en T44/RF_42, T35/RF_44 y T36/RF_11. El dia que alguien quiera
    // condicionar el veto al volumen de la comunidad, al saldo del domiciliario o a "cuanto lleva
    // ganado el lider", tendra que cambiar la firma y pasar por esta linea. RF_27 no habla de nada
    // de eso: habla de conceptos.
    expect(canEditTariffConcept.length).toBe(3);
    // Y el actor no se toca: es un predicado, no un sitio donde mutar permisos de paso.
    const actor: Actor = { uid: "u-lider", role: "community_leader", communityId: "com-1" };
    canEditTariffConcept(actor, "com-1", "driverFailedPayCop");
    expect(actor).toEqual({ uid: "u-lider", role: "community_leader", communityId: "com-1" });
  });
});

// -------------------------------------------------------------------------------------------
// T45 y T46 · dos callables desplegadas y SIN un solo llamador
//
// `setCommunityLogo` (communities.ts) y `reassignSellerCommunity` existen en produccion, pero no
// hay envoltorio en `src/lib/firebase/auth.ts` ni control en `operations-app.tsx`: para un
// administrador real la funcionalidad no existe. Lo que se prueba aqui es la unica mitad que se
// puede probar en una unidad — QUIEN VE EL CONTROL — para que cuando la interfaz se construya no
// invente su propia regla (`user.role === "admin"` suelto en un JSX, que es exactamente como se
// desincronizan pantalla y servidor). El recorrido de punta a punta va en /sdd-verify.
// -------------------------------------------------------------------------------------------

/**
 * Los seis roles de la plataforma, uno a uno. Se declara como tabla y no como lista suelta para
 * que el `Record` de abajo obligue a `tsc` a cubrir la union entera: el dia que aparezca un
 * septimo rol, esto no compila en vez de dejarlo sin comprobar (y por tanto, sin veto).
 */
const TODOS_LOS_ROLES = [
  "admin",
  "seller",
  "seller_logistics",
  "driver",
  "messenger",
  "community_leader"
] as const;

type RolDeLaPlataforma = (typeof TODOS_LOS_ROLES)[number];

const ACTOR_POR_ROL: Record<RolDeLaPlataforma, Actor> = {
  admin,
  seller: tienda,
  seller_logistics: logistico,
  driver: transportista,
  messenger: mensajero,
  community_leader: lider
};

/** Un lider de dato viejo: existe la cuenta, pero nunca se le adscribio comunidad. */
const liderSinComunidad: Actor = { uid: "u-huerfano", role: "community_leader" };

describe("T45 · quien ve el control de subir el logo de la comunidad (RF_14, RF_16)", () => {
  it("RF_14: el lider de ESA comunidad ve el control, porque el logo que se muestra es el suyo", () => {
    // RF_14 dice que donde el lider haya cargado logo se muestra el suyo en la pantalla de
    // registro de su enlace y en el panel de sus tiendas. El unico que puede cargarlo es el
    // dueno de esa marca: si el control no le sale, RF_14 es inalcanzable por construccion.
    expect(canEditCommunityBrand(lider, "com-1")).toBe(true);
    expect(canEditCommunityBrand(otroLider, "com-2")).toBe(true);
  });

  it("RF_14: el administrador tambien lo ve, para poder corregir", () => {
    // Un logo mal cargado (o una marca que hay que retirar) no puede depender de que el lider
    // este disponible. El admin gobierna cualquier comunidad, tenga o no relacion con ella.
    expect(canEditCommunityBrand(admin, "com-1")).toBe(true);
    expect(canEditCommunityBrand(admin, "com-2")).toBe(true);
    expect(canEditCommunityBrand(admin, "com-que-no-existe")).toBe(true);
  });

  it("RF_14: el lider de OTRA comunidad no lo ve: no se pisa la marca del vecino", () => {
    expect(canEditCommunityBrand(otroLider, "com-1")).toBe(false);
    expect(canEditCommunityBrand(lider, "com-2")).toBe(false);
  });

  it("RF_14: una tienda no ve el control de logo de la comunidad a la que pertenece", () => {
    expect(canEditCommunityBrand(tienda, "com-1")).toBe(false);
  });

  it("RF_14: un logistico de tienda no ve el control de logo", () => {
    // Confirma y edita pedidos de SU tienda (RF_43); eso no le da la marca de la comunidad.
    expect(canEditCommunityBrand(logistico, "com-1")).toBe(false);
  });

  it("RF_14: un transportista no ve el control de logo", () => {
    expect(canEditCommunityBrand(transportista, "com-1")).toBe(false);
  });

  it("RF_14: un mensajero no ve el control de logo", () => {
    expect(canEditCommunityBrand(mensajero, "com-1")).toBe(false);
  });

  it("RF_14: un lider sin comunidad adscrita no ve el control de ninguna", () => {
    // `communityId` es opcional en `Actor` porque Firestore no garantiza nada. Un actor a medio
    // construir no puede acabar editando la marca de la primera comunidad que se le pase.
    expect(canEditCommunityBrand(liderSinComunidad, "com-1")).toBe(false);
    expect(canEditCommunityBrand(liderSinComunidad, "com-2")).toBe(false);
  });

  it("RF_14: una comunidad vacia o en blanco no abre el control a un lider", () => {
    // El caso de "la pantalla todavia no sabe que comunidad esta mirando": el predicado tiene que
    // contestar que no, no colarse por comparar dos cadenas vacias.
    expect(canEditCommunityBrand(lider, "")).toBe(false);
    expect(canEditCommunityBrand(liderSinComunidad, "")).toBe(false);
    // El admin sigue pudiendo: su permiso no depende de a que comunidad apunta la pantalla.
    expect(canEditCommunityBrand(admin, "")).toBe(true);
  });

  it("RF_14: el control sale AUNQUE la comunidad no tenga logo todavia", () => {
    // El caso de bloqueo mutuo: si el control solo se pintara donde ya hay logo, una comunidad
    // recien creada no podria cargar el primero nunca. Por eso el permiso no mira el estado de
    // la marca — mira quien pregunta y por que comunidad, y nada mas.
    expect(canEditCommunityBrand.length).toBe(2);
    // Que una comunidad sin logo cae a la marca de la plataforma ya esta probado en T13/T15
    // sobre `brandFor`; aqui lo que importa es que esa situacion no apaga el control.
    expect(canEditCommunityBrand(lider, "com-1")).toBe(true);
  });

  it("RF_16: rechazar un logo invalido no es cosa del permiso, y el permiso no muta al actor", () => {
    // RF_16 (conservar el logo anterior cuando el nuevo no vale) vive en `planLogoChange`
    // (community-pricing.ts) y esta probado en T40 sobre community-view.test.ts. Lo que se ata
    // aqui es la frontera: el permiso contesta lo mismo antes y despues de un intento fallido,
    // asi que un logo rechazado NO puede dejar al lider sin el control para reintentar.
    const actor: Actor = { uid: "u-lider", role: "community_leader", communityId: "com-1" };
    expect(canEditCommunityBrand(actor, "com-1")).toBe(true);
    expect(canEditCommunityBrand(actor, "com-1")).toBe(true);
    expect(actor).toEqual({ uid: "u-lider", role: "community_leader", communityId: "com-1" });
  });

  it("RF_14: la tabla de roles esta completa y cada rol tiene una respuesta booleana", () => {
    // La mitad en EJECUCION de la exhaustividad, igual que en T41/RF_27: `tsc` obliga a que el
    // `Record` cubra la union de roles; esto obliga a que la tabla no tenga fixtures cruzados.
    for (const rol of TODOS_LOS_ROLES) {
      expect(ACTOR_POR_ROL[rol].role).toBe(rol);
      expect(typeof canEditCommunityBrand(ACTOR_POR_ROL[rol], "com-1")).toBe("boolean");
    }
    // Y sobre com-1 los unicos dos que pueden son el admin y el lider de com-1.
    const puedenSobreCom1 = TODOS_LOS_ROLES.filter((rol) =>
      canEditCommunityBrand(ACTOR_POR_ROL[rol], "com-1")
    );
    expect([...puedenSobreCom1].sort()).toEqual(["admin", "community_leader"]);
  });
});

describe("T46 · quien ve el control de reasignar una tienda de comunidad (RF_11)", () => {
  it("RF_11: solo un administrador ve el control — los seis roles, uno a uno", () => {
    // "Solo un administrador MAY reasignarla". Tabla exhaustiva: si manana entra un rol nuevo,
    // el `Record` de `ACTOR_POR_ROL` no compila hasta que alguien decida su respuesta aqui.
    const resultados = TODOS_LOS_ROLES.map((rol) => [rol, canReassignSellerCommunity(ACTOR_POR_ROL[rol])]);
    expect(resultados).toEqual([
      ["admin", true],
      ["seller", false],
      ["seller_logistics", false],
      ["driver", false],
      ["messenger", false],
      ["community_leader", false]
    ]);
  });

  it("RF_11: ni el lider de la comunidad de ORIGEN ni el de la de DESTINO lo ven", () => {
    // El caso interesante: `seller-1` esta en com-1. El lider de com-1 tiene el motivo de
    // retenerla y el de com-2 el de llevarsela — y con ella el cashback futuro. Ninguno de los
    // dos manda sobre la adscripcion de una tienda: eso es RF_11, y por eso el predicado no
    // acepta ni la tienda ni la comunidad de destino como argumento.
    expect(canReassignSellerCommunity(lider)).toBe(false);
    expect(canReassignSellerCommunity(otroLider)).toBe(false);
    expect(canReassignSellerCommunity(liderSinComunidad)).toBe(false);
  });

  it("RF_11: la tienda tampoco puede sobre si misma, ni su logistico", () => {
    // Autoservicio de comunidad = elegir el cashback propio. No.
    expect(canReassignSellerCommunity(tienda)).toBe(false);
    expect(canReassignSellerCommunity(logistico)).toBe(false);
  });

  it("RF_11: el permiso mira SOLO quien pregunta, y no muta al actor", () => {
    // La aridad se fija igual que en T44/RF_42, T35/RF_44 y T41/RF_27. Que sea 1 es la forma
    // ejecutable de "solo un administrador": no hay tienda, ni comunidad de destino, ni saldo
    // que puedan ablandar la respuesta. Si alguien quiere condicionarla ("el lider puede si la
    // tienda aun no factura"), tiene que cambiar la firma y pasar por esta linea.
    expect(canReassignSellerCommunity.length).toBe(1);
    const actor: Actor = { uid: "u-lider", role: "community_leader", communityId: "com-1" };
    canReassignSellerCommunity(actor);
    expect(actor).toEqual({ uid: "u-lider", role: "community_leader", communityId: "com-1" });
  });

  it("RF_11: el control de reasignar es ESTRICTAMENTE mas cerrado que el de la marca", () => {
    // Los dos controles de este ciclo caen en la misma pantalla de comunidad y es facil que la
    // interfaz los pinte bajo la misma condicion. No son el mismo permiso: el lider gobierna su
    // marca (RF_14) y no gobierna a que comunidad pertenece una tienda (RF_11). Quien reasigna
    // siempre puede editar marca; el reves no se cumple, y esa asimetria queda atada aqui.
    for (const rol of TODOS_LOS_ROLES) {
      const actor = ACTOR_POR_ROL[rol];
      if (canReassignSellerCommunity(actor)) {
        expect(canEditCommunityBrand(actor, "com-1")).toBe(true);
      }
    }
    expect(canEditCommunityBrand(lider, "com-1")).toBe(true);
    expect(canReassignSellerCommunity(lider)).toBe(false);
  });

  it("RF_11: el permiso no es donde se protege el cashback ya causado", () => {
    // Que la reasignacion NO mueva el cashback causado es invariante de
    // `planSellerReassignment` y esta probado en T36 (arriba, en este mismo archivo). Aqui solo
    // se deja constancia de la frontera: que el admin tenga permiso no licencia mover dinero, y
    // por eso el permiso no recibe ni el seller ni el instante — no puede decidir sobre importes.
    expect(canReassignSellerCommunity(admin)).toBe(true);
    expect(canReassignSellerCommunity.length).toBe(1);
  });
});
