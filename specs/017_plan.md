# Plan tecnico — Spec 017: volver a importar no pisa lo operado

- **Spec:** `specs/017_reimportar_no_pisa_lo_operado.md` (aprobada 2026-09-17)
- **Fecha:** 2026-09-17

> **Nota sobre el stack por defecto.** El stack de referencia del arnes (Prisma + PostgreSQL) no
> aplica: este repo es Next.js 16 + Firebase (Functions Node 20 + Firestore), sin ORM ni SQL. Lo que
> si se respeta al pie de la letra: TypeScript estricto sin `any`, Zod en los limites, nucleo puro
> separado de la capa de red (principio 3 de la constitucion) y pruebas sin red.

---

## 0. Lo que el codigo dice hoy (medido, no supuesto)

Antes de disenar nada se leyeron las seis vias. **El alcance real es mas pequeno de lo que la spec
temia, y conviene escribirlo porque cambia el plan:**

| Via | Archivo | Que hace hoy con un pedido que YA existe |
|---|---|---|
| Reimportacion por rango + importacion manual | `functions/src/shopify.ts:679` (`upsertShopifyOrder`) | **Lo pisa casi entero**, incluido `driverId: null` — origen del incidente. Ya conserva `status`, `evidence`, `createdAt` y `trackingCode` (`:719-724`), con sus propios `existing.data()?.…`: esa es la regla duplicada que RNF_01 viene a unificar |
| Aviso automatico de Shopify | `functions/src/index.ts:158` | Lo actualiza. Conserva `driverId`, `status`, `evidence`, `createdAt`, `trackingCode`; **pisa** cliente, direccion, `addressRisk`, sello y catalogo |
| Aviso de tienda conectada | `functions/src/store-webhook.ts:287` | **Sale antes**: `if (existing.exists) return { created: false }` |
| OnStock | `functions/src/onstock-webhook.ts:269` | **Sale antes**, igual |
| Formulario de contacto | `functions/src/contact-form.ts:228` | Id nuevo siempre (`cf7-${sampleId}`): nunca colisiona |
| Confirmacion ChatBy (consulta programada) | `functions/src/uchat-pull.ts:355` | Actualiza direccion a proposito. **Exenta** (RNF_01) |
| Confirmacion ChatBy (webhook entrante) | `functions/src/uchat-webhook.ts:245` | El gemelo del anterior: mismo trabajo, otra puerta. **Exenta** por el mismo motivo |
| Alta manual de pedido | `functions/src/orders.ts:355` (`createManualOrder`) | Crea desde dentro de la plataforma, nunca actualiza. **Exenta**: no es una via "desde fuera" |
| Correccion administrativa | `functions/src/order-corrections.ts:211` (`batch.update`) | Reescribe pedidos cerrados a proposito, por decision de una persona y con su propia spec. **Exenta** |

Son **diez vias repartidas en nueve archivos** (la reimportacion y el import manual comparten
`shopify.ts`): las seis que cubre RNF_01 mas las cuatro exentas. Los recuentos anteriores se dejaron fuera
el webhook de ChatBy, el alta manual y la correccion administrativa; las tres escriben con verbos
distintos (`set`, `create`, `update`), que es justo por lo que la guarda tiene que mirar los cuatro.
Conclusion: **solo dos pueden pisar un pedido operado** (`shopify.ts` e `index.ts`). Las otras
tres ya son seguras, pero lo son *por accidente de su forma*, no por una regla — y eso es
exactamente lo que RNF_01 prohibe. Por eso las tres pasan igualmente por el modulo nuevo: hoy no
cambia su comportamiento (nunca hay `existing`), y manana no se pueden equivocar — **siempre que
pasen `existingFactsFrom(existing)` y no un `null` escrito a mano**. `store-webhook.ts` y
`onstock-webhook.ts` ya leen su snapshot: si pasaran `null` fijo, el dia que alguien quite su salida
temprana el nucleo tratara un pedido operado como nuevo y volvemos al incidente. `contact-form.ts`
es la unica que puede pasar `null` de verdad, porque su id es nuevo siempre.

---

## 1. Arbol de modulos

### Nuevo

| Archivo | Responsabilidad |
|---|---|
| `functions/src/order-import-merge.ts` | **Nucleo puro.** Decide, para un pedido entrante y lo que ya hay guardado, que campos se escriben y cuales se conservan. Sin `firebase-admin`, sin red, sin reloj propio. Misma forma que `wallet-entries.ts` y `order-corrections-plan.ts` |
| `src/lib/order-import-merge.test.ts` | Pruebas del nucleo, un caso por requisito (RF_01 a RF_19), importando `../../functions/src/order-import-merge` — el patron del repo (principio 4) |
| `functions/src/import-run-summary.ts` | Acumulador **puro** del resumen de corrida (RF_13, RF_14): cuenta grupos conservados y recorta la lista de codigos. Sin Firestore: quien escribe el documento es la via |
| `src/lib/import-run-summary.test.ts` | Pruebas del acumulador: recuentos exactos aunque la lista se recorte |
| `src/lib/spec-017-guards.test.ts` | Las diez guardas de fuente (§4.2): quien escribe `orders`, los valores de creacion, las exenciones, las reglas, la constitucion, el resumen fuera de transaccion, el sello de edicion, el `clear` aplicado, y la forma de los dos guiones de `scripts/`. Misma tecnica que `spec-005-guards.test.ts` |
| `functions/src/manual-edit-backfill.ts` | **Puro** (RF_19): `ordersToStamp(auditEvents, orders)` decide que pedidos llevan marca y con que fecha (la del evento, no la del relleno). Separado del guion por el mismo motivo que `order-corrections-plan.ts` lo esta de `order-corrections.ts` |
| `src/lib/manual-edit-backfill.test.ts` | Pruebas de `ordersToStamp`: pedido cerrado excluido, pedido ya marcado sin tocar, fecha = la del evento |
| `scripts/backfill-manual-edit-stamp.js` | Guion de un solo uso (RF_19): rellena la marca de edicion en los pedidos no cerrados que ya tenian una edicion manual, leyendola de `auditEvents` (`order.imported_updated` y `order.adjusted`). Se corre ANTES de desplegar las vias |
| `scripts/verify-017.js` | Guion de un solo uso para el DoD 4: `--backup`, `--compare`, `--restore` (detalle en §4.4) |

### Modificados

| Archivo | Cambio |
|---|---|
| `functions/src/shopify.ts` | `upsertShopifyOrder` deja de construir el documento final: construye el **candidato** y lo pasa por `mergeImportedOrder`. Acumula el resumen de corrida |
| `functions/src/index.ts` | El webhook hace lo mismo. Pierde su `driverId: existingData.driverId ?? null` y sus `existingData.*` sueltos: eso ahora lo decide el modulo |
| `functions/src/orders.ts` | `updateImportedOrder` y `updateOrderAdjustments` sellan la edicion manual (RF_17). Es la unica escritura que esta spec anade a un callable de la operacion, y no cambia nada de lo que ese callable ya hacia |
| `functions/src/store-webhook.ts`, `onstock-webhook.ts` | Pasan por el modulo con `existingFactsFrom(existing)` — sus hechos reales, no un `null` literal. Hoy no cambia nada porque salen antes; manana las protege |
| `functions/src/contact-form.ts` | Pasa por el modulo con `null`: su id es nuevo siempre, y eso si es un hecho |
| `firestore.rules` | Lectura admin-only de `importRuns` |
| `docs/constitution.md` | Principio nuevo (RNF_03) |

**Lo que NO se toca:** las dos vias de ChatBy, el alta manual y la correccion administrativa
(`order-corrections.ts`) —las cuatro exentas y declaradas—, la UI, y
`operations-app.tsx:1987` — la tarjeta seguira escondiendo los controles sin lider, porque eso es
correcto; lo que estaba mal era que el pedido perdiera el lider.

---

## 2. Modelo de datos

### 2.1 Fase del pedido — la frontera de todo

```ts
/** Las cinco fases que deciden que se conserva. Derivadas del estado guardado y del sello de edicion. */
export type OrderPhase = "new" | "unconfirmed" | "edited" | "open" | "closed";

/** Sin confirmar = nadie ha hablado aun con el cliente. Es EXACTAMENTE `imported`. */
const UNCONFIRMED_STATUS = "imported" as const;

/**
  * Marca que pone `updateImportedOrder` al guardar; su presencia lleva al pedido a la fase `edited`.
  * **Se exporta** para que el callable que la escribe y el nucleo que la lee usen la MISMA constante:
  * como dos literales sueltos podrian divergir y RF_17 dejaria de activarse en silencio.
  */
export const MANUAL_EDIT_STAMP = "manuallyEditedAt" as const;

/**
 * Cerrado = su dinero ya se calculo. **Se exporta y `orders.ts` construye su `TERMINAL_STATUS` a
 * partir de ella** (T16), en vez de mantener dos listas iguales: si manana se anade un estado
 * terminal en un solo sitio, la reimportacion trataria un pedido cerrado como abierto y le
 * refrescaria el catalogo — RF_09 caido, sin error y sin aviso. El repo ya hace esto mismo con
 * `OPERATIONAL_TARGET_STATUSES` ("existe UNA sola vez", `orders.ts:2036`).
 */
export const CLOSED_STATUSES = ["delivered", "failed", "cancelled", "liquidated"] as const;

export function orderPhase(existing: ExistingOrderFacts | null): OrderPhase;
// Orden de decision: sin `existing` -> `new`; estado cerrado -> `closed`; marca de edicion ->
// `edited` (gana a `unconfirmed` y a `open`); `imported` -> `unconfirmed`; resto -> `open`.

/**
 * RF_17: el estado NO significa "nadie lo ha tocado". Hay **dos** ediciones manuales, las dos sin
 * cambiar el estado: `updateImportedOrder` (`orders.ts:464`), con la que la tienda corrige cliente,
 * direccion, condiciones y lineas de un pedido sin confirmar; y `updateOrderAdjustments`
 * (`orders.ts:660`, admin), que ajusta producto, cantidad y **recaudo** de cualquier pedido no
 * terminal — es decir, tambien de uno que ya va en la calle. **Las dos sellan.** La regla no es
 * "`updateImportedOrder` sella", es: toda escritura de la operacion que edite a mano un campo
 * protegido pone la marca. Un pedido asi ya esta trabajado: cuenta como `edited`,
 * que conserva lo mismo que `open` **y ademas el catalogo**, porque el valor total es editable a mano
 * y es dinero.
 * La senal es una sola marca por pedido que pone el servidor al guardar la edicion —no memoria de
 * que campo toco cada cual—, asi que RF_03 sigue en pie: se decide por el pedido, no por el campo.
 */
```

**Un `existing` sin `status` es `open`, no `unconfirmed`.** El caso es real: `shopify.ts:722` escribe
hoy `status: existing.exists ? existing.data()?.status : "imported"`, que para un pedido sin estado
produce `undefined` y `stripUndefined` lo borra. Ante la duda se elige la fase que **mas conserva**:
tratarlo como sin confirmar refrescaria cliente y condiciones de entrega, que es el incidente.

```

**`address_risk` cuenta como confirmado, y esto es la decision fina del plan.** `confirmOrder`
(`orders.ts:334`) mueve el pedido de `imported` a `address_risk` o a `ready_to_assign` segun el
riesgo: llegar a `address_risk` significa que la llamada con el cliente **ya ocurrio** y que la
direccion que hay es la corregida. Conservarla es justo el punto de RF_02. (`store-api.ts:140`
agrupa `imported` y `address_risk` como "pendientes de confirmar" de cara a la tienda; es otra
pregunta — "¿falta trabajo?" — y no debe contagiar esta.)

### 2.2 Entradas y salida del nucleo

```ts
/** Lo unico que el nucleo necesita saber del pedido guardado. No es el documento entero. */
export type ExistingOrderFacts = {
  status?: string;
  driverId?: string | null;
  messengerId?: string | null;
  pickupBatchId?: string | null;   // `orders.ts:566` escribe null al desasignar
  customerName?: string;
  customerPhone?: string;
  addressRaw?: string;
  normalizedAddress?: string;
  lat?: number;
  lng?: number;
  geoProvider?: string;
  addressRisk?: "accepted" | "review" | "rejected";
  communityId?: string;
  communityPricing?: Record<string, unknown>;
  lineItems?: Array<{ sku?: string; productName?: string; quantity: number }>;
  /** Lo escriben las dos ediciones manuales (`orders.ts:499` y `:699`): es identidad de producto,
   *  y RF_09/RF_17 congelan "los productos". Ninguna via de importacion lo emite hoy. */
  productId?: string;
  productName?: string;
  sku?: string;
  quantity?: number;
  totalCop?: number;
  source?: string;
  /** RF_11, fila "Repesque": el nucleo necesita saber si el pedido YA los tiene para decidir si los
   *  omite o los deja pasar. Sin ellos no puede, y un pedido sin fecha de creacion no la recibiria
   *  nunca: `normalizeOrder` (`state-store.ts:881`) le pondria la de hoy en cada carga. */
  createdAt?: string;
  evidence?: unknown[];
  /** RF_17: si tiene valor, el pedido ya se edito a mano y no se le refresca nada aunque siga `imported`. */
  manuallyEditedAt?: string;
  /** Solo para que la via NO llame a `nextTrackingCode()` sobre un pedido que ya existe: ese
   *  contador escribe. Ver la nota del codigo de seguimiento mas abajo. */
  trackingCode?: string;
  // RF_15: sin el valor guardado no se puede decidir si de verdad se iba a pisar (RF_14).
  pickupPointName?: string;
  pickupAddress?: string;
  paymentMethod?: string;
  fulfillmentMode?: string;
};

/**
 * Nombres IDENTICOS a los que se escriben en `source` (comprobado en el codigo), para que un
 * resumen de corrida se pueda cruzar con los pedidos que dice haber tocado. No lo usa el nucleo:
 * vive en el acumulador del resumen. Un `origin` dentro de `mergeImportedOrder` invitaria a tener
 * politica por via, que es justo lo que RNF_01 prohibe.
 */
export type ImportOrigin =
  | "shopify_historical_sync" | "shopify_manual_import" | "shopify_webhook"
  | "store_order_webhook" | "onstock_webhook" | "contact_form_7_webhook";

/** Que grupo de campos se conservo, para el resumen de corrida (RF_13). */
export type PreservedGroup =
  | "ownership" | "customer" | "address_review" | "community_stamp" | "frozen_catalog"
  | "provenance" | "delivery_terms";

export type MergeResult = {
  /** El documento a escribir con `{ merge: true }`. Ya paso por stripUndefined. */
  doc: Record<string, unknown>;
  /**
   * RF_18: claves que la via debe BORRAR del documento (`FieldValue.delete()`), no escribir.
   * Solo se llena al refrescar la direccion de un pedido sin confirmar: la geocodificacion derivada
   * (`normalizedAddress`, `lat`, `lng`, `geoProvider`) es de la direccion vieja y ninguna via de
   * importacion la trae, asi que dejarla seria dejar el pedido apuntando a dos sitios. El nucleo
   * sigue siendo puro: nombra las claves, no las borra.
   */
  clear: string[];
  phase: OrderPhase;
  /** Solo lo que DE VERDAD se iba a pisar y se conservo (RF_14): valor entrante != guardado. */
  preserved: PreservedGroup[];
};

/**
 * Deriva los hechos del pedido guardado A PARTIR DEL SNAPSHOT. Devuelve `null` —y solo `null`—
 * cuando el pedido no existe. Vive en el nucleo a proposito: si cada via derivara lo suyo,
 * bastaria un `existing.data() ?? {}` (que es lo que `index.ts:166` hace HOY) para que un pedido
 * nuevo llegara como `{}`, y `{}` no es `null`: `orderPhase` lo leeria como `open` y el nucleo
 * omitiria `status`, `evidence`, `createdAt`, `driverId` y los datos del cliente. El pedido
 * naceria casi vacio, sin un solo error. Ninguna via construye `ExistingOrderFacts` a mano.
 */
export function existingFactsFrom(
  snapshot: { exists: boolean; data(): Record<string, unknown> | undefined }
): ExistingOrderFacts | null;

export function mergeImportedOrder(input: {
  incoming: Record<string, unknown>;
  existing: ExistingOrderFacts | null;
  now: string;
}): MergeResult;

/**
 * La vista del pedido DESPUES de la escritura, que es lo que la via devuelve al cliente (§2.45).
 * `existingRaw` es `snapshot.data()` **tal cual, sin `?? {}`**: el spread de `undefined` ya da `{}`,
 * y ese `?? {}` es justo la expresion que la guarda de T12 persigue. Aqui los datos crudos son
 * legitimos —solo se componen para responder, nunca para decidir—; lo que no puede salir de ahi es
 * el `existing` de `mergeImportedOrder`, que viene de `existingFactsFrom`.
 */
export function viewAfterMerge(
  existingRaw: Record<string, unknown> | undefined,
  merged: MergeResult
): Record<string, unknown>;
// Recibe el MergeResult entero, no solo `doc`, porque tiene que QUITAR las claves de `clear`:
// si no, la vista que viaja al navegador seguiria trayendo la geocodificacion que se acaba de
// borrar — el mismo fallo de §2.45 con el signo cambiado.
```

Cada via **sigue construyendo su candidato como hoy** (cada una habla con una API distinta) y solo
delega la decision final. Asi el cambio en las cinco vias es de tres lineas y el riesgo de
regresion en la creacion —RF_10, el caso que no puede romperse— es minimo.

### 2.3 Tabla de politica (el corazon del modulo)

| Grupo | Campos | `new` | `unconfirmed` | `edited` | `open` | `closed` |
|---|---|---|---|---|---|---|
| Ciclo de vida | `status` | entrante | **conserva** | **conserva** | **conserva** | **conserva** |
| Repesque | `trackingCode`, `createdAt`, `evidence` | entrante | conserva si ya tiene | conserva si ya tiene | conserva si ya tiene | conserva si ya tiene |
| Pertenencia | `driverId`, `messengerId`, `pickupBatchId` | entrante | **conserva** | **conserva** | **conserva** | **conserva** |
| Cliente | `customerName`, `customerPhone`, `addressRaw` | entrante | **refresca** | **conserva** | **conserva** | **conserva** |
| Geocodificacion (RF_18) | `normalizedAddress`, `lat`, `lng`, `geoProvider` | entrante | **se descarta** (la via las borra) | **conserva** | **conserva** | **conserva** |
| Revision de direccion | `addressRisk` | entrante | conserva si ya decidida | conserva si ya decidida | conserva si ya decidida | conserva si ya decidida |
| Sello de comunidad | `communityId`, `communityPricing` | entrante | rellena si vacio | rellena si vacio | rellena si vacio | **conserva** |
| Catalogo | `lineItems`, `productName`, `sku`, `quantity`, `totalCop`, `productId` | entrante | refresca | **conserva** | refresca | **conserva** |
| Procedencia (RF_16) | `source` | entrante | **conserva** | **conserva** | **conserva** | **conserva** |
| Condiciones de entrega | `pickupPointName`, `pickupAddress`, `paymentMethod`, `fulfillmentMode` | entrante | refresca | **conserva** | **conserva** | **conserva** |

Requisitos por fila: 1 y 2 = RF_11; 3 = RF_01 y RF_12; 4 = RF_02 y RF_03; 5 = RF_18; 6 = RF_04;
7 = RF_05, RF_06 y RF_07; 8 = RF_08 y RF_09; 9 = RF_16; 10 = RF_15.

**La columna `new` no es decorativa: es el contrato con la creacion.** "Entrante" significa que el
candidato de la via pasa **tal cual**, incluidos los valores de creacion `driverId: null`,
`status: "imported"`, `evidence: []` y `createdAt`. Esos valores **se quedan donde estan, en cada
via**; lo que cambia es que el modulo los **omite** cuando `existing != null`. Quitarlos del
candidato crearia pedidos sin el campo `driverId`, y en Firestore **un documento sin el campo no
empareja `where("driverId", "==", null)`** —lo dice el propio repo en `order-stats.ts:118`— asi que
el pedido nuevo no apareceria en el pozo del lider (`state-store.ts:546` y `:1075`) ni en las
cifras. Sin error y sin aviso: exactamente la clase de fallo que esta spec existe para evitar.

**Tres campos del ciclo de vida se conservan "si ya tienen", no siempre**, y es lo que hoy hace el
codigo: `trackingCode` (`shopify.ts:692`), `evidence` (`:723`, `evidence ?? []`) y `createdAt`
(`:724`, `createdAt ?? order.created_at ?? now`). RF_11 pide conservarlos "**como ya hace hoy**", y
hoy incluye ese repesque. Omitir `createdAt` siempre dejaria a un pedido que no la tenga sin ella
para siempre, y `normalizeOrder` (`state-store.ts:881`) le pondria la fecha de hoy en cada carga:
el pedido "saltaria al dia de la corrida", que es justo el caso limite que la spec quiso evitar.
`status` si es conserva incondicional: hoy ya produce `undefined` y `stripUndefined` lo borra.

**Dos de las diez filas no tienen grupo en `PreservedGroup`, y es deliberado:** "Ciclo de vida" y
"Repesque". Se resuelven fuera del bucle y **nunca se reportan** en `preserved`: no son
datos que la tienda pretenda cambiar, son el andamiaje del pedido. Contarlos inflaria el resumen de
cada corrida con ruido constante y taparia lo que si importa. El bucle de §3.1 recorre solo las
siete filas con grupo; la de geocodificacion tampoco tiene grupo propio —se resuelve por `clear` y
se reporta dentro de `customer`, que es de donde cuelga—.

**El codigo de seguimiento es la excepcion, y no es un detalle.** `nextTrackingCode()` no lee: lee
**y escribe** `counters/orders` dentro de la transaccion (`store-webhook.ts:143-149`). Si las vias
dejaran de preguntar "¿ya tiene codigo?" y lo pidieran siempre, cada pedido **ya existente** de una
reimportacion quemaria un KNT y escribiria el contador — un documento unico y caliente, tocado
miles de veces en una corrida, y peor aun en el webhook con los reintentos de Shopify (~2.000 en el
incidente de septiembre). El pedido conservaria su codigo (el nucleo omite la clave), asi que el
estropicio seria **invisible**: solo se veria como un salto en la numeracion.

Por eso el codigo se pide **de forma perezosa y en la via**, no en el nucleo:

```ts
const trackingCode = existing?.trackingCode ? existing.trackingCode : await nextTrackingCode(transaction);
```

**Y la misma condicion vale dentro del nucleo**: `trackingCode` no se omite siempre, se omite *si el
pedido ya tiene uno* — la misma forma que el sello de comunidad (RF_05/RF_06), y por el mismo motivo.
Si el nucleo lo omitiera siempre, la via pediria un codigo nuevo para el pedido sin codigo, quemaria
un KNT, tocaria el contador caliente… y el nucleo tiraria la clave: el pedido seguiria sin codigo.

La condicion es "¿tiene codigo?", **no** "¿existe el pedido?", y la diferencia no es cosmetica: hoy
(`shopify.ts:692`, `index.ts:169`) un pedido que ya existe **sin** codigo recibe uno, y con la
condicion floja se quedaria sin el para siempre —el nucleo omite la clave— sin error y sin aviso.
RF_11 pide conservarlo "como ya hace hoy", y hoy incluye ese repesque. Obliga a que
`ExistingOrderFacts` incluya `trackingCode?: string`, que si no la via no tendria de donde sacarlo.

**`driverId` merece una nota.** En la pertenencia, "conservar" significa **no emitir la clave**, no
emitir `null`. Emitir `null` fue literalmente el bug: `driverId: null` dentro de un `set(merge:true)`
no es "no tocar", es "borrar". El modulo nunca emite `null` para un campo conservado, y hay una
prueba para eso sola.

### 2.4 Campos protegidos por RF_15 — decidido el 2026-09-17

La spec los dejo al plan; el plan se adelanto a darlos por decididos en §2.3, y el analisis de
coherencia lo marco como alcance colado. **Ya son decision del responsable y viven en la spec como
RF_15.** Se conservan en cuanto el pedido sale de "sin confirmar":

| Campo | Politica | Por que |
|---|---|---|
| `source` | **conservar siempre**, tambien sin confirmar (grupo `provenance`, RF_16) | En el incidente, 34 pedidos nacidos por webhook pasaron a decir `shopify_historical_sync`. La procedencia es historia, no estado: reescribirla borra la respuesta a "¿por donde entro esto?" |
| `pickupPointName`, `pickupAddress` | conservar salvo `unconfirmed` (grupo `delivery_terms`) | Salen del perfil de la tienda; si cambian a mitad de operacion, el mensajero ya salio con la guia impresa |
| `paymentMethod` | conservar salvo `unconfirmed` (grupo `delivery_terms`) | Decide si hay efectivo que cobrar. Cambiarlo con el pedido en la calle descuadra el corte |
| `fulfillmentMode` | conservar salvo `unconfirmed` (grupo `delivery_terms`) | Hoy se escribe fijo `"seller_pickup"`; pisar un pedido con otro modo lo cambiaria de flujo en silencio |
| `cityId`, `shopDomain`, `sellerId`, `shopifyOrderId`, `shopifyNumericId` | refrescar siempre | Identidad, no operacion. Si cambian es que el documento estaba mal |

Esto anade dos grupos a `PreservedGroup`: `provenance` (RF_16) y `delivery_terms` (RF_15), ya
reflejados como filas 7 y 8 de §2.3. **La diferencia entre los dos no es un descuido:** las
condiciones de entrega describen *como se va a entregar* el pedido, y mientras nadie ha hablado con
el cliente la tienda manda sobre eso; la procedencia describe *como llego*, que es un hecho pasado
y no un dato que la tienda pueda actualizar.

### 2.45 Lo que la via DEVUELVE no es lo que la via ESCRIBE

`upsertShopifyOrder` devuelve el documento que escribe, y esa respuesta viaja al navegador:
`syncShopifyHistoricalOrders` responde `orders: [...]` y el admin hace `result.orders.forEach(onImported)`
(`operations-app.tsx:10986`), que **reemplaza** cada pedido en `state.orders`. El import manual hace lo
mismo con `{ order }`.

Con el nucleo omitiendo claves, el `doc` de un pedido ya existente no trae `status`, `driverId`,
cliente ni `evidence`: devolverlo tal cual pintaria en la pantalla del admin tarjetas sin lider y sin
estado justo despues de una reimportacion. Se corregiria solo al siguiente snapshot del listener, pero
"se arregla solo dentro de un rato" no es un comportamiento que se pueda escribir en una spec.

**Regla:** la via devuelve la vista del pedido **despues** de la escritura, no el parche:

```ts
const doc = { ...merged.doc };                     // lo que se escribe (merge: true)
for (const key of merged.clear) doc[key] = FieldValue.delete();   // RF_18: borrar, no escribir
transaction.set(orderRef, doc, { merge: true });
return { order: viewAfterMerge(existingRaw, merged), merged };   // `merged` lleva phase y preserved
```

**El contrato de las dos callables no cambia:** `importShopifyOrder` sigue respondiendo `{ order }` y
`syncShopifyHistoricalOrders` sigue respondiendo `orders: Order[]`. Lo que se anade (`merged`, que
lleva `phase`, `preserved` y `clear`) viaja **dentro de `upsertShopifyOrder`, hacia quien acumula el resumen**, no hacia el
navegador. Importa escribirlo porque el admin mete esa respuesta directa en su estado
(`operations-app.tsx:10968` y `:10986`): devolver ahi el objeto entero pintaria pedidos malformados
sin un solo error, que es la clase de fallo de la que trata esta spec.

`viewAfterMerge(existingRaw, merged)` es **una funcion pura mas del nucleo**: parte de
`{...existingRaw, ...merged.doc}` y **quita las claves de `merged.clear`**, que se acaban de borrar.
No es un `spread` suelto en cada via. Se hace asi porque `upsertShopifyOrder` no se exporta, llama a
`getFirestore()` y no hay emulador: dejar la composicion dentro de la via la volveria **improbable**.
Como funcion pura se prueba en T1 igual que todo lo demas.

Escribir y devolver son dos cosas distintas y esta es la unica vez que lo son.

### 2.5 Resumen de corrida (RF_13, RF_14)

Coleccion nueva `importRuns`, un documento **por corrida de reimportacion por rango**, y solo por eso:

```ts
export type ImportRunSummary = {
  id: string;                    // `run-${Date.now()}-${origin}`
  origin: ImportOrigin;
  startedAt: string; finishedAt: string;
  range?: { startDate: string; endDate: string };
  sellerId?: string; shopDomain?: string;
  ordersSeen: number; ordersCreated: number; ordersExisting: number;
  preservedCounts: Record<PreservedGroup, number>;
  affectedTrackingCodes: string[];   // tope 500. "Afectado" = con `preserved` no vacio UNA VEZ
                                     // DESCONTADA `provenance` (RF_14): un pedido nacido por el
                                     // aviso automatico SIEMPRE llega con `source` distinto en una
                                     // reimportacion por rango, asi que contarlo listaria miles de
                                     // codigos en cada corrida y el resumen no distinguiria nada.
                                     // La procedencia lleva su propio recuento.
  truncated: boolean;                // true si hubo mas de 500
};
```

- **Tope de 500 codigos + `truncated`**: un documento de Firestore son 1 MiB y una reimportacion de
  un mes puede tocar miles de pedidos. El numero siempre es exacto; la lista puede recortarse.
- **No va a `auditEvents`**: el cliente baja los ultimos 50 eventos globales y miles de constancias
  desplazarian el historial del admin. Es la razon por la que elegiste resumen por corrida.
- **Las vias de un pedido por llamada no escriben resumen**: el webhook de Shopify **y la importacion
  manual** (`importShopifyOrder`), que tambien importa de uno en uno. Un resumen por pedido es
  exactamente lo que RF_13 evita. Dejan una linea de log con `preserved` cuando no esta vacio: la del
  webhook la escribe T9 (duena de `index.ts`) y la del import manual T8 (duena de `shopify.ts`).
  RF_13 habla de "cuando termine una reimportacion", y ni un webhook ni un import suelto lo son.
Firma del acumulador (puro, sin Firestore):

```ts
export type RunTally = { seen: number; created: number; existing: number;
  preservedCounts: Record<PreservedGroup, number>; codes: string[]; truncated: boolean };

export function emptyTally(): RunTally;
/** Se llama UNA vez por pedido, con la vista devuelta (de ahi sale `trackingCode`, que
 *  `MergeResult` no lleva) y su `MergeResult`. Descuenta `provenance` de los "afectados". */
export function tallyOrder(tally: RunTally, order: { trackingCode?: string }, merged: MergeResult): RunTally;
export function summarize(tally: RunTally, meta: {...}): ImportRunSummary;
```

- **El resumen se acumula FUERA de la transaccion**, a partir del `MergeResult` que devuelve cada
  pedido. Si se acumulara dentro del callback de `db.runTransaction`, Firestore lo reintenta y los
  recuentos se inflarian **sin ningun error**: en el incidente de septiembre el webhook acumulo unos
  2.000 reintentos. Un recuento inflado incumple RF_13 ("los recuentos MUST ser exactos siempre") y,
  peor, lo incumple en silencio.
- `ordersExisting` sale del `phase` que devuelve `upsertShopifyOrder`, **no** de la prelectura de
  `shopify.ts:475`, que **desaparece**: contaba exactamente ese mismo numero (el "X nuevos, Y ya
  existian" que ve el admin), y dos fuentes de verdad para una misma cifra terminan divergiendo.
  De paso se ahorra un `.get()` por pedido en un bucle de miles.
- Lectura: admin-only en `firestore.rules`. No la consume ninguna pantalla en esta spec.

---

## 3. Algoritmos criticos

### 3.1 `mergeImportedOrder`

0. La via obtiene `existing` con `existingFactsFrom(snapshot)`. **`null` significa "no existe" y
   es lo unico que significa eso**: un objeto vacio es un pedido existente sin datos conocidos.
1. `phase = orderPhase(existing)`.
2. Si `phase === "new"`: devolver `{ doc: stripUndefined(incoming), clear: [], phase, preserved: [] }`. **Salida
   temprana y literal**: la creacion no puede cambiar (RF_10).
3. Partir de `doc = { ...incoming }`.
4. Para cada grupo de la tabla §2.3 cuya politica en esa fase sea *conservar*: **borrar la clave de
   `doc`** (no ponerla a `undefined` ni a `null`) por cada campo del grupo. Registrar el grupo en
   `preserved` **solo si** algun campo del grupo llegaba con un valor distinto del guardado (RF_14).
5. Sello de comunidad con politica *rellena si vacio*: si `existing.communityId` tiene valor, se
   conserva (RF_05); si esta vacio y `phase !== "closed"`, se deja pasar el entrante (RF_06); si
   esta vacio y `phase === "closed"`, se conserva el vacio (RF_07).
6. `addressRisk`: si el guardado es `"accepted"` o `"rejected"`, se conserva (RF_04). Si es
   `"review"` o falta, pasa el entrante — que tambien es `"review"`, asi que no hay cambio real.
7. **RF_18:** si la fase es `unconfirmed`, `clear` recibe las cuatro claves de la geocodificacion
   derivada; en cualquier otra fase sale vacio. El nucleo solo las NOMBRA.
8. `doc.updatedAt = now`. Devolver `{ doc: stripUndefined(doc), clear, phase, preserved }`.

**Comparacion para `preserved`:** igualdad **estructural para todo valor no escalar** —`lineItems`
(orden incluido: un cambio de orden sin cambio de contenido no es un cambio) y tambien
`communityPricing`, que es un objeto, **descontando su `frozenAt`**: `freezeOrderPricing`
(`community-pricing.ts:190`) sella la fecha del calculo, y las dos vias lo recalculan en cada corrida
(`shopify.ts:685`, `index.ts:160`), asi que comparar el objeto entero daria "distinto" siempre— y
estricta para escalares. Con igualdad estricta, dos objetos
de contenido identico nunca son iguales y `community_stamp` saldria en `preserved` en **todas** las
corridas, que es justo lo que RF_14 existe para impedir. `undefined` entrante nunca
cuenta como cambio: no hay nada que pisar.

### 3.2 Por que borrar la clave y no escribir el valor guardado

Podria conservarse reescribiendo el valor que ya estaba (`doc.driverId = existing.driverId`). **No se
hace**, por dos razones:

1. Entre la lectura y la escritura puede cambiar el pedido. Reescribir lo leido es un *clobber*
   diminuto pero real: justo lo que prohibe el principio 5. Omitir la clave en un `merge: true` no
   puede pisar a nadie, gane quien gane la carrera.
2. `ExistingOrderFacts` es un subconjunto del documento. Si manana alguien anade un campo al grupo
   sin anadirlo al tipo, omitir sigue siendo correcto; reescribir lo pondria a `undefined`.

Ninguna de las dos vias que actualizan usa transaccion para *este* fin (`shopify.ts` si abre una, por
el contador de `trackingCode`), asi que la omision es la unica garantia barata que queda.

### 3.3 Lo que NO cambia del incidente

`upsertShopifyOrder` seguira llamando a `createCommunityPricingResolver` **antes** de la transaccion,
como hoy. Calcular el sello no es escribirlo: el modulo decide si se usa. Se deja asi para no tocar
el orden de lecturas de la transaccion, que es donde viven los errores caros de Firestore.

---

## 4. Estrategia de testing

### 4.1 Nucleo — `src/lib/order-import-merge.test.ts`

Sin red, sin Firestore, sin reloj: el nucleo recibe `now` como dato. Fixtures: un `incoming` tipico
de Shopify y cuatro `existing` (uno por fase), construidos en el propio archivo.

| Requisito | Prueba |
|---|---|
| RF_01, RF_12 | Pedido `in_route` con lider y mensajero: `doc` **no trae** las claves `driverId`/`messengerId`/`pickupBatchId` |
| RF_02 | Pedido `ready_to_assign` con direccion corregida: no trae `addressRaw`/`customerName`/`customerPhone` |
| RF_03 | Pedido `imported`: **si** trae los tres, con el valor entrante |
| RF_04 | `addressRisk: "accepted"` guardado: no se devuelve a `review` |
| RF_05 | Con sello: no trae `communityId`/`communityPricing` |
| RF_06 | Sin sello y abierto: si los trae |
| RF_07 | Sin sello y cerrado: no los trae |
| RF_08 | Abierto: trae `lineItems`/`totalCop` nuevos |
| RF_09 | `delivered`: no los trae |
| RF_10 | `existing: null`: `doc` es identico a **`stripUndefined(incoming)`** campo a campo (igualdad profunda), **incluido `driverId: null` presente** — no basta con que "no estorbe": el campo tiene que estar. La fixture obligatoria es **una tienda SIN comunidad**, con el sello en `undefined`: es el caso que tumbo el webhook en septiembre, y comparar contra el `incoming` crudo haria fallar la prueba justo ahi |
| RF_10 (H1) | `existingFactsFrom` sobre un snapshot con `exists: false` devuelve `null`, **no `{}`**; y `mergeImportedOrder` con `existing: {}` NO se comporta como creacion — es un pedido existente, y la prueba lo fija para que nadie "arregle" el tipo aceptando el objeto vacio |
| RF_17 | Pedido `imported` **con** marca de edicion (fase `edited`): no trae cliente, catalogo ni condiciones de entrega; el mismo pedido **sin** la marca (fase `unconfirmed`) si los trae. El catalogo es la diferencia con `open`: en `edited` se conserva, porque el valor total es editable a mano y es dinero |
| RF_18 | Pedido `imported` sin marca: `clear` nombra `normalizedAddress`, `lat`, `lng` y `geoProvider`; en cualquier otra fase `clear` sale **vacio** |
| RF_15 | Pedido `open`: no trae `pickupPointName`, `pickupAddress`, `paymentMethod` ni `fulfillmentMode`; pedido `imported`: si los trae |
| RF_16 | **Ninguna** fase existente trae `source`, `imported` incluida — es la diferencia con RF_15 |
| RF_11 | Ninguna fase existente emite `status`. **`trackingCode`, `createdAt` y `evidence` van aparte**: se omiten solo si el pedido YA los tiene; si no, pasa el entrante — es lo que hace hoy el codigo (`evidence ?? []`, `createdAt ?? order.created_at ?? now`) y lo que RF_11 pide al decir "como ya hace hoy". Un caso por campo, con el pedido existente sin el |
| RF_13 | `preserved` nombra los grupos correctos por fase |
| RF_14 | Entrante identico al guardado: `preserved` vacio |
| §2.3 nota | **`driverId` nunca sale como `null` ni `undefined`**: o es un id (fase `new`) o la clave no existe |
| Caso limite | Dos pasadas seguidas: aplicar el `doc` de la segunda sobre el pedido **no cambia ningun valor**, y `preserved` sale vacio. Se compara el documento resultante, NO se exige "solo `updatedAt`": los campos de identidad (`id`, `cityId`, `shopDomain`, `sellerId`, `shopifyOrderId`, `shopifyNumericId`) se refrescan siempre y por tanto siempre salen |

### 4.2 Guarda de fuente — `src/lib/spec-017-guards.test.ts`

Lee los `.ts` de `functions/src/` **sin comentarios** (un requisito en un comentario no es una
garantia, `spec-005-guards.test.ts:13`) y exige:

1. Todo archivo que escriba en `orders` importa `order-import-merge`, **o** esta en la lista de
   exentos declarada y justificada en el propio archivo de prueba. "Escribir" MUST cubrir los cuatro
   verbos, no solo `.set(`: `set(`, `create(`, `update(` y las variantes de lote (`batch.set(`,
   `batch.update(`) sobre una referencia de `orders`. Tres de las cinco vias escriben con
   `transaction.create(` (`store-webhook.ts:327`, `onstock-webhook.ts:310`, `contact-form.ts:273`),
   asi que una guarda que solo mire `.set(` las da por buenas **por un `.set(` ajeno del mismo
   archivo** y deja pasar cualquier via nueva que use otro verbo. Exentos: `uchat-pull.ts`,
   `uchat-webhook.ts` (las dos confirmaciones de ChatBy), `order-corrections.ts` (la correccion
   administrativa) y los callables de `orders.ts` — tanto los de ciclo de vida como
   `createManualOrder`, que crea desde dentro de la plataforma. **La lista canonica es codigo
   exportado**, no un comentario: `export const IMPORT_WRITE_EXEMPTIONS: Record<string, string>`
   (archivo -> razon) en `functions/src/order-import-merge.ts`, donde vive la regla (RNF_01). Tiene
   que ser codigo porque la guarda lee las fuentes **sin comentarios** —"un requisito escrito en un
   comentario no es una garantia", `spec-005-guards.test.ts:13`— asi que una lista en la cabecera
   seria invisible para ella. Ponerla en el propio archivo de prueba la dejaria comprobandose a si
   misma, que tampoco garantiza nada.
   **No basta con que el archivo IMPORTE el modulo.** Una via que lo importe y siga escribiendo su
   propio candidato saldria verde, y entonces la guarda no garantiza nada. Hay que comprobar que el
   payload de cada escritura sobre `orders` es **la variable que devolvio `mergeImportedOrder`**, y
   que el `existing` que recibe viene de `existingFactsFrom(...)` y no de un `.data() ?? {}`.
   **La prohibicion de `.data() ?? {}` se aplica al argumento `existing` de `mergeImportedOrder` y
   `existingFactsFrom`, no al archivo entero**: `viewAfterMerge` recibe los datos crudos a proposito,
   y es el unico consumidor legitimo. **Unica excepcion del origen: `contact-form.ts`**, que pasa
   `null` literal porque su id es nuevo siempre (`cf7-${sampleId}`) y no tiene snapshot que derivar.
   `spec-005-guards.test.ts` ya trae la maquinaria (`localFunctions`, `matchingClose`).
2. **Los valores de creacion siguen en el candidato**: `shopify.ts`, `index.ts`, `store-webhook.ts`,
   `onstock-webhook.ts` y `contact-form.ts` **conservan** su `driverId: null`. Es la guarda al
   reves de lo que parecia natural, y es deliberada: lo que hay que impedir no es que exista ese
   literal, sino que un pedido nuevo nazca **sin el campo**, que es invisible para
   `where("driverId","==",null)`. La rama peligrosa —pisarlo en un pedido que ya existe— la cierra
   el nucleo omitiendo la clave, con su prueba en T2, no una busqueda de texto.
3. La exencion de ChatBy esta escrita donde vive la regla (RNF_01).


4. `firestore.rules` declara la lectura de `importRuns` como admin-only.
5. `docs/constitution.md` contiene el principio nuevo con su fecha y los 34 pedidos: seria el unico
   artefacto de la spec sin comprobacion automatica.
6. `shopify.ts` escribe el documento de `importRuns` y **la llamada al acumulador no esta dentro del
   cuerpo de `db.runTransaction`**: es la unica parte de RF_13 que puede fallar en silencio, porque
   Firestore reintenta el callback y los recuentos se inflan sin error.
7. **Las dos** ediciones manuales (`updateImportedOrder` y `updateOrderAdjustments`) escriben
   `MANUAL_EDIT_STAMP` **importando la constante del nucleo**, no un literal suelto: es lo unico que
   activa RF_17, y `orders.ts` esta exento del modulo, asi que sin esta guarda RF_17 entraria en
   produccion sin ninguna red del lado servidor. Si manana aparece una tercera edicion manual, esta
   guarda es lo que obliga a decidir si sella.

8. **Las cinco vias aplican el `clear` que devuelve el nucleo.** Es la unica red de RF_18 en
   produccion: sin ella el nucleo nombraria las claves, nadie las borraria, y el requisito quedaria
   en verde y sin efecto.
9. **`scripts/backfill-manual-edit-stamp.js` carga el modulo compilado** en vez de repetir la
   decision (RF_19). Ninguna otra guarda mira `scripts/`, y la costumbre del repo —30+ guiones que
   duplican la logica en JS— empuja justo al duplicado.
10. **`scripts/verify-017.js` tiene la forma que T15 declara**: `--backup` obligatorio antes de
   `--compare`, `--restore` propio (no `restore-orders-from-backup.js`, que omite el pedido si ya
   existe, que es justo el caso del DoD 4) y `firebase-admin` desde `../functions/node_modules`. El
   guion no se ejecuta en la suite —corre contra produccion y lo lanza una persona (principio 7)—,
   asi que sin esta guarda seria el unico artefacto de la spec sin ninguna comprobacion. Mismo
   precedente que `spec-005-guards.test.ts` con `verify-005.js` y `spec-013-guards.test.ts` con
   `verify-013.js`.

Anadir una via nueva que escriba pedidos sin pasar por el modulo rompe (1). Eso es RNF_02.

### 4.3 Prueba de mutacion (DoD 2)

Dos mutaciones, porque hay dos fallos distintos que evitar y cada uno tiene su guardian:

1. **El incidente**: hacer que el nucleo deje pasar el grupo `ownership` cuando `existing != null`
   (es decir, que vuelva a emitir `driverId: null` sobre un pedido operado). La suite debe caer por
   RF_01 en `order-import-merge.test.ts`.
2. **El fallo que el analisis evito**: quitar `driverId: null` del candidato de `shopify.ts`. La
   suite debe caer **por la guarda 2 de §4.2, y solo por ella**. Conviene no enganarse con esto:
   ninguna prueba de comportamiento ejercita el candidato de `shopify.ts` —la de RF_10 corre sobre
   el nucleo con su propia fixture, y no hay emulador— asi que aqui la guarda de texto no es un
   complemento, es la **unica** red. Es tambien la razon de que la guarda 2 exista: sin ella, esta
   mutacion pasaria en verde.

Se deja constancia de ambas en `.sdd/evidence/017/`, como en la 013.

### 4.4 Produccion (DoD 4) — `scripts/verify-017.js`

Guion de un solo uso, mismo patron que `verify-013.js`:

- `--backup <fecha>`: guarda **todos** los pedidos de ese dia en `.sdd/evidence/017/backup-<fecha>.json`.
  Sin este archivo, el guion se niega a seguir. El PITR de Firestore esta **desactivado** (retencion
  1 h, comprobado el 15-09): esa copia es la unica vuelta atras que va a existir.
- `--compare`: reimportacion del dia y comparacion campo a campo de los grupos protegidos.
- `--restore`: devuelve los pedidos afectados a como estaban, desde la copia.

Lo lanza el responsable, no un agente (principio 7).

---

## 5. Dependencias nuevas

**Ninguna.** Todo es TypeScript sobre lo que ya hay: el nucleo no necesita mas que comparar objetos,
y las guardas usan `node:fs`, como las tres guardas existentes. Anadir una libreria de *deep equal*
seria cambiar una dependencia por veinte lineas que ya sabemos escribir y probar.

---

## 6. Orden de despliegue

Consultas nuevas: **ninguna** — `importRuns` solo se escribe y se lee por id desde el admin SDK, sin
indice compuesto. Asi que no aplica el "indices -> functions -> hosting" del principio 12 en su
forma completa:

1. `firestore:rules` (lectura admin-only de `importRuns`).
2. **Solo las dos callables que sellan** (T16):
   `firebase deploy --only functions:updateImportedOrder,functions:updateOrderAdjustments`.
3. **El relleno** (T17), ya con el sello vivo en produccion. Antes hace falta `cd functions &&
   npm run build`: el guion no replica la logica, **carga el modulo puro ya compilado**
   (`require("../functions/lib/manual-edit-backfill")`), que es lo que exige RF_19.
4. **El resto de functions** (`ALLOW_FUNCTIONS_DEPLOY=1`, tras `cd functions && npm run build` y
   comprobar con `firebase functions:list` que el set local == prod).

El orden importa y no es burocracia: `npm run deploy:functions` sube **todo** de una vez, asi que si
se hiciera en un solo paso, el relleno correria antes de que el sello existiera y **cualquier edicion
manual hecha entre el relleno y el despliegue se quedaria sin marca para siempre** — y la primera
reimportacion le descartaria la geocodificacion. Desplegando antes las dos callables que sellan, esa
ventana no existe: desde ese momento toda edicion nueva ya deja marca, y el relleno se ocupa de las
viejas.
5. **Hosting no hace falta**: esta spec no toca la interfaz.

---

## 7. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Romper la **creacion** de pedidos al refactorizar las cinco vias — seria el incidente del webhook otra vez, y peor | Salida temprana literal para `phase === "new"` (§3.1 paso 2) + RF_10 con igualdad profunda + las cinco vias cambian solo tres lineas cada una |
| Que `ExistingOrderFacts` se quede corto y un campo nuevo quede sin politica | La politica se declara como tabla de datos, no como `if`s sueltos; un campo sin grupo se refresca, que es el comportamiento de hoy — nunca peor que ahora |
| Que la reimportacion siga siendo peligrosa por otra via (no por los campos) | Fuera de alcance declarado; el resumen de corrida (RF_13) hace visible por primera vez que una corrida toco pedidos ya existentes |
