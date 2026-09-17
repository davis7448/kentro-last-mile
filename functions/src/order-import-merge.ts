/**
 * Que se conserva y que se refresca cuando una importacion se encuentra un pedido que YA existe.
 * SIN acceso a Firestore: decide, no escribe (mismo patron que `wallet-entries.ts` y
 * `order-corrections-plan.ts`).
 *
 * Existe por el incidente del 2026-09-15: una reimportacion historica trato 34 pedidos ya operados
 * como si acabaran de llegar de la tienda y les escribio `driverId: null`. Lo que se vio fue que el
 * mensajero del KNT-004747 se quedo sin poder subir evidencia ni marcar entregado (la tarjeta
 * esconde esos controles sin lider); lo que no se vio fue que 26 entregas en efectivo salieron del
 * saldo del lider sin un solo error en pantalla.
 *
 * La regla vive UNA sola vez, aqui, y la usan todas las vias por las que entra un pedido desde
 * fuera (spec 017, RNF_01).
 *
 * **Conservar significa NO EMITIR la clave, no emitir `null`.** `driverId: null` dentro de un
 * `set(merge: true)` no es "no tocar": es "borrar". Ese fue literalmente el bug. Omitir tampoco
 * puede pisar a nadie si el pedido cambia entre la lectura y la escritura, que es lo que pide el
 * principio 5 de la constitucion.
 */

/** Las cinco fases que deciden que se conserva. Salen del estado guardado y del sello de edicion. */
export type OrderPhase = "new" | "unconfirmed" | "edited" | "open" | "closed";

/**
 * Cerrado = su dinero ya se calculo. `orders.ts` construye su `TERMINAL_STATUS` a partir de esta
 * lista en vez de repetirla: dos listas iguales terminan divergiendo, y si divergieran, una
 * reimportacion trataria un pedido cerrado como abierto y le refrescaria el catalogo (RF_09 caido,
 * sin error y sin aviso).
 */
export const CLOSED_STATUSES = ["delivered", "failed", "cancelled", "liquidated"] as const;

/** Sin confirmar = nadie ha hablado aun con el cliente NI ha editado el pedido. */
const UNCONFIRMED_STATUS = "imported";

/**
 * Marca que ponen las dos ediciones manuales (`updateImportedOrder` y `updateOrderAdjustments`) al
 * guardar. Se exporta para que quien la escribe y quien la lee usen la MISMA constante: como dos
 * literales sueltos podrian divergir y RF_17 dejaria de activarse en silencio.
 */
export const MANUAL_EDIT_STAMP = "manuallyEditedAt";

/**
 * Quien puede escribir en `orders` sin pasar por aqui, y por que. Es codigo y no un comentario
 * porque la guarda de `spec-017-guards.test.ts` lee las fuentes SIN comentarios: una lista en la
 * cabecera le seria invisible. Ninguna de estas cuatro importa nada de fuera.
 */
export const IMPORT_WRITE_EXEMPTIONS: Record<string, string> = {
  "uchat-pull.ts": "Confirmacion por ChatBy (consulta programada): su trabajo es corregir la direccion con lo que dice el cliente, que es justo la correccion que el resto debe respetar.",
  "uchat-webhook.ts": "Confirmacion por ChatBy (webhook entrante): el gemelo del anterior, mismo trabajo por otra puerta.",
  "orders.ts": "Escrituras de la propia operacion: alta manual, transiciones de ciclo de vida y edicion de un pedido sin confirmar. Nacen de que una persona de la plataforma decide algo, no de una tienda.",
  "order-corrections.ts": "Correccion administrativa de estados terminales: reescribe pedidos cerrados a proposito, por decision de una persona y con su propia spec."
};

/** Lo unico que el nucleo necesita saber del pedido guardado. No es el documento entero. */
export type ExistingOrderFacts = {
  status?: string;
  driverId?: string | null;
  messengerId?: string | null;
  pickupBatchId?: string | null;
  customerName?: string;
  customerPhone?: string;
  addressRaw?: string;
  normalizedAddress?: string;
  lat?: number;
  lng?: number;
  geoProvider?: string;
  addressRisk?: string;
  communityId?: string;
  communityPricing?: Record<string, unknown>;
  lineItems?: unknown;
  productId?: string;
  productName?: string;
  sku?: string;
  quantity?: number;
  totalCop?: number;
  source?: string;
  /** El nucleo decide si los omite o los deja pasar segun el pedido YA los tenga (RF_11). */
  trackingCode?: string;
  createdAt?: string;
  evidence?: unknown;
  pickupPointName?: string;
  pickupAddress?: string;
  paymentMethod?: string;
  fulfillmentMode?: string;
  /** RF_17: si tiene valor, el pedido ya se edito a mano y no se le refresca nada. */
  [MANUAL_EDIT_STAMP]?: string;
};

/**
 * Nombres IDENTICOS a los que se escriben en `source`, para que un resumen de corrida se pueda
 * cruzar con los pedidos que dice haber tocado. No lo usa el nucleo: vive en el resumen. Un
 * `origin` aqui dentro invitaria a tener politica por via, que es lo que RNF_01 prohibe.
 */
export type ImportOrigin =
  | "shopify_historical_sync"
  | "shopify_manual_import"
  | "shopify_webhook"
  | "store_order_webhook"
  | "onstock_webhook"
  | "contact_form_7_webhook";

/** Que grupo de campos se conservo, para el resumen de corrida (RF_13). */
export type PreservedGroup =
  | "ownership"
  | "customer"
  | "address_review"
  | "community_stamp"
  | "frozen_catalog"
  | "provenance"
  | "delivery_terms";

export type MergeResult = {
  /** El documento a escribir con `{ merge: true }`. Ya paso por `stripUndefined`. */
  doc: Record<string, unknown>;
  /**
   * Claves que la via debe BORRAR (`FieldValue.delete()`), no escribir. Solo se llena al refrescar
   * la direccion de un pedido sin confirmar: la geocodificacion derivada es de la direccion vieja y
   * ninguna via de importacion la trae, asi que dejarla dejaria el pedido apuntando a dos sitios.
   * El nucleo sigue siendo puro: nombra las claves, no las borra.
   */
  clear: string[];
  phase: OrderPhase;
  /** Solo lo que DE VERDAD se iba a pisar y se conservo (RF_14): valor entrante != guardado. */
  preserved: PreservedGroup[];
};

/** Que hacer con un grupo de campos en una fase dada. */
type Policy = "keep" | "pass" | "keep-if-present" | "keep-if-decided" | "clear";

type FieldGroup = {
  /** `undefined` = se resuelve fuera del bucle y nunca se reporta (andamiaje del pedido). */
  group?: PreservedGroup;
  fields: string[];
  /** Que hacer en cada fase existente. La fase `new` no pasa por aqui: se escribe entera. */
  policy: Record<Exclude<OrderPhase, "new">, Policy>;
};

const ALWAYS_KEEP: Record<Exclude<OrderPhase, "new">, Policy> = {
  unconfirmed: "keep",
  edited: "keep",
  open: "keep",
  closed: "keep"
};

/**
 * La politica, como tabla de datos y no como `if`s sueltos: un campo nuevo se anade a una fila, y
 * lo que no esta en ninguna fila se refresca, que es el comportamiento de hoy — nunca peor.
 */
const FIELD_GROUPS: FieldGroup[] = [
  // Andamiaje del pedido: se conserva siempre y no se reporta (inflaria el resumen con ruido).
  { fields: ["status"], policy: ALWAYS_KEEP },
  // RF_11 "como ya hace hoy": hoy hay repesque (`evidence ?? []`, `createdAt ?? ... ?? now`), y sin
  // el, un pedido sin fecha de creacion no la recibiria nunca y saltaria al dia de la corrida.
  {
    fields: ["trackingCode", "createdAt", "evidence"],
    policy: { unconfirmed: "keep-if-present", edited: "keep-if-present", open: "keep-if-present", closed: "keep-if-present" }
  },
  // RF_01 y RF_12: el pedido no cambia de dueno por una importacion.
  { group: "ownership", fields: ["driverId", "messengerId", "pickupBatchId"], policy: ALWAYS_KEEP },
  // RF_02 y RF_03: la tienda manda mientras nadie haya tocado el pedido; despues, no.
  {
    group: "customer",
    fields: ["customerName", "customerPhone", "addressRaw"],
    policy: { unconfirmed: "pass", edited: "keep", open: "keep", closed: "keep" }
  },
  // RF_18: al refrescar la direccion hay que descartar lo que se derivo de la anterior, o el pedido
  // queda apuntando a dos sitios a la vez. Se reporta dentro de `customer`, de donde cuelga.
  {
    group: "customer",
    fields: ["normalizedAddress", "lat", "lng", "geoProvider"],
    policy: { unconfirmed: "clear", edited: "keep", open: "keep", closed: "keep" }
  },
  // RF_04: una direccion ya revisada no vuelve a "pendiente de revisar".
  {
    group: "address_review",
    fields: ["addressRisk"],
    policy: { unconfirmed: "keep-if-decided", edited: "keep-if-decided", open: "keep-if-decided", closed: "keep-if-decided" }
  },
  // RF_05, RF_06 y RF_07: el sello se congela si existe; se rellena solo si esta vacio y el pedido
  // no esta cerrado (un pedido cerrado calculo su dinero sin comunidad).
  {
    group: "community_stamp",
    fields: ["communityId", "communityPricing"],
    policy: { unconfirmed: "keep-if-present", edited: "keep-if-present", open: "keep-if-present", closed: "keep" }
  },
  // RF_08, RF_09 y RF_17: el catalogo se congela al cerrar y tambien al editarlo a mano — el valor
  // total es dinero y es editable en un pedido sin confirmar.
  {
    group: "frozen_catalog",
    fields: ["lineItems", "productName", "sku", "quantity", "totalCop", "productId"],
    policy: { unconfirmed: "pass", edited: "keep", open: "pass", closed: "keep" }
  },
  // RF_16: por donde entro el pedido es historia, no estado. Un pedido entra una sola vez.
  { group: "provenance", fields: ["source"], policy: ALWAYS_KEEP },
  // RF_15: deciden cuanto efectivo cobrar y con que guia salio el mensajero.
  {
    group: "delivery_terms",
    fields: ["pickupPointName", "pickupAddress", "paymentMethod", "fulfillmentMode"],
    policy: { unconfirmed: "pass", edited: "keep", open: "keep", closed: "keep" }
  }
];

/** Una direccion ya revisada tiene veredicto; `review` es "todavia no". */
const DECIDED_ADDRESS_RISK = new Set(["accepted", "rejected"]);

function isClosedStatus(status: string | undefined): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(String(status ?? ""));
}

/**
 * Deriva los hechos del pedido guardado A PARTIR DEL SNAPSHOT. Devuelve `null` —y solo `null`—
 * cuando el pedido no existe.
 *
 * Vive aqui a proposito: si cada via derivara lo suyo, bastaria un `existing.data() ?? {}` (que es
 * lo que `index.ts` hacia) para que un pedido nuevo llegara como `{}`, y `{}` no es `null`:
 * `orderPhase` lo leeria como `open` y el nucleo omitiria estado, evidencia, fecha y lider. El
 * pedido naceria casi vacio, sin un solo error.
 */
export function existingFactsFrom(
  snapshot: { exists: boolean; data(): Record<string, unknown> | undefined } | null | undefined
): ExistingOrderFacts | null {
  if (!snapshot?.exists) return null;
  return (snapshot.data() ?? {}) as ExistingOrderFacts;
}

/**
 * La fase manda sobre todo lo demas.
 *
 * Orden de decision: sin pedido -> `new`; estado cerrado -> `closed`; marca de edicion -> `edited`;
 * `imported` -> `unconfirmed`; el resto -> `open`. Un pedido guardado sin estado cae en `open`, que
 * es lo que mas conserva: tratarlo como sin confirmar le refrescaria cliente y condiciones.
 */
export function orderPhase(existing: ExistingOrderFacts | null): OrderPhase {
  if (!existing) return "new";
  const status = typeof existing.status === "string" ? existing.status : undefined;
  if (isClosedStatus(status)) return "closed";
  // RF_17: `imported` NO significa "nadie lo ha tocado". Hay dos ediciones manuales que no cambian
  // el estado, y la de ajustes toca el recaudo de pedidos que ya van en la calle. La marca vale
  // hasta que el pedido se cierre, no hasta que se confirme: editar y confirmar despues es normal.
  if (typeof existing[MANUAL_EDIT_STAMP] === "string" && existing[MANUAL_EDIT_STAMP]) return "edited";
  if (status === UNCONFIRMED_STATUS) return "unconfirmed";
  return "open";
}

/** `undefined` no es un valor: el Admin SDK lo rechaza y `merge` ya conserva lo que no se emite. */
function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * Igualdad estructural para todo lo que no sea escalar, **descontando `frozenAt`** del sello de
 * comunidad: `freezeOrderPricing` sella la fecha del calculo y las vias lo recalculan en cada
 * corrida, asi que comparar el objeto entero daria "distinto" siempre y el resumen marcaria todos
 * los pedidos como afectados.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(withoutFrozenAt(a)) === JSON.stringify(withoutFrozenAt(b));
}

function withoutFrozenAt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { frozenAt: _frozenAt, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Hay algo que pisar: el entrante trae valor y es distinto del guardado. */
function wouldOverwrite(incomingValue: unknown, existingValue: unknown): boolean {
  if (incomingValue === undefined) return false;
  return !sameValue(incomingValue, existingValue);
}

/**
 * Decide, para un pedido entrante y lo que ya hay guardado, que se escribe y que se conserva.
 *
 * @param incoming El candidato que la via construye, con sus valores de creacion intactos.
 * @param existing Los hechos del pedido guardado, SIEMPRE de `existingFactsFrom`. `null` = no existe.
 */
export function mergeImportedOrder(input: {
  incoming: Record<string, unknown>;
  existing: ExistingOrderFacts | null;
  now: string;
}): MergeResult {
  const { incoming, existing, now } = input;
  const phase: OrderPhase = orderPhase(existing);

  // Salida temprana literal: la creacion no puede cambiar (RF_10). Un pedido nuevo se escribe
  // entero, `driverId: null` incluido — sin ese campo no lo encuentra el pozo del lider.
  if (phase === "new" || !existing) {
    return { doc: stripUndefined({ ...incoming, updatedAt: now }), clear: [], phase: "new", preserved: [] };
  }

  const doc: Record<string, unknown> = { ...incoming };
  const clear: string[] = [];
  const preserved = new Set<PreservedGroup>();
  const facts = existing as Record<string, unknown>;

  const existingPhase = phase as Exclude<OrderPhase, "new">;
  for (const { group, fields, policy } of FIELD_GROUPS) {
    const rule = policy[existingPhase];
    for (const field of fields) {
      const incomingValue = doc[field];
      const existingValue = facts[field];

      let conserve = false;
      if (rule === "keep") {
        conserve = true;
      } else if (rule === "keep-if-present") {
        // El sello de comunidad vacio se rellena; el que ya existe se congela (RF_05/RF_06).
        conserve = existingValue !== undefined && existingValue !== null && existingValue !== "";
      } else if (rule === "keep-if-decided") {
        conserve = DECIDED_ADDRESS_RISK.has(String(existingValue ?? ""));
      } else if (rule === "clear") {
        // RF_18: no se conserva ni se escribe — se borra, porque es de la direccion anterior.
        if (existingValue !== undefined) clear.push(field);
        delete doc[field];
        continue;
      }

      if (!conserve) continue;
      if (group && wouldOverwrite(incomingValue, existingValue)) preserved.add(group);
      // Borrar la clave, nunca escribir el valor leido: omitir no puede pisar a nadie si el pedido
      // cambia entre la lectura y la escritura.
      delete doc[field];
    }
  }

  doc.updatedAt = now;
  return { doc: stripUndefined(doc), clear, phase, preserved: [...preserved] };
}

/**
 * La vista del pedido DESPUES de la escritura, que es lo que la via devuelve al cliente.
 *
 * Existe porque esa respuesta viaja al navegador del admin, que la mete directa en su estado: si se
 * devolviera el parche, justo despues de una reimportacion se verian tarjetas sin lider y sin
 * estado. Quita ademas las claves de `clear`, que se acaban de borrar.
 *
 * `existingRaw` es `snapshot.data()` tal cual, sin `?? {}`: el spread de `undefined` ya da `{}`, y
 * ese `?? {}` es justo la expresion que la guarda persigue. Aqui los datos crudos son legitimos —
 * solo se componen para responder, nunca para decidir.
 */
export function viewAfterMerge(
  existingRaw: Record<string, unknown> | undefined,
  merged: MergeResult
): Record<string, unknown> {
  const view = { ...(existingRaw ?? {}), ...merged.doc };
  for (const key of merged.clear) delete view[key];
  return view;
}
