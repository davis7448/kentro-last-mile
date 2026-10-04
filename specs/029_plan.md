# Plan tecnico — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API, sin pisar lo operado

- **Spec:** `specs/029_store_api_confirma_y_corrige_pedidos.md` — **aprobada el 2026-10-04** (decisiones 1-8,
  seccion 9).
- **Fecha:** 2026-10-04. Preguntas del plan resueltas el mismo dia por el orquestador, por delegacion del
  responsable (seccion 12). Precisado tras `/sdd-analyze` el mismo dia (seccion 13).
- **Diseno:** `specs/design/029_store_api_confirma_y_corrige_pedidos/` (README + 14 pantallas observadas):
  - HU_04 (clave de escritura): `HU_04.tienda-sin-clave`, `HU_04.tienda-recien-generada`, `HU_04.tienda-activa`,
    `HU_04.tienda-rotar`, `HU_04.tienda-error`, `HU_04.admin-lista`, `HU_04.admin-lista-movil`,
    `HU_04.admin-recien-generada`;
  - HU_05 (historial): `HU_05.tienda`, `HU_05.tienda-escritorio`, `HU_05.admin`, `HU_05.admin-escritorio`,
    `HU_05.vacio`, `HU_05.error`.
  Este plan no decide textos ni disposicion: los toma del README. Sus tres pendientes "fuera del diseno" se
  resuelven aqui (2.10 → 2.4, 2.3 y T23).
- **Tareas:** `specs/029_tasks.md` (T1-T27). Toda referencia a una tarea en este plan usa esa numeracion.
- **Evidencia:** `.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).
- **Specs relacionadas:** 030 (webhook firmado) reutilizara `orderHistory` como fuente de eventos; 031 anadira
  los origenes `shopify` y `chatby` al mismo registro; **032** (borrador, prioridad alta,
  `specs/032_auditoria_solo_la_escribe_el_servidor.md`) cierra el `create` de cliente en `auditEvents`. Hasta
  la 032, este plan aplica la mitigacion de 2.7.

### Preguntas del plan: resueltas (2026-10-04)

| Pregunta | Respuesta aplicada |
|---|---|
| P1 — `address_risk` corregido con valores identicos | Vuelve a `imported` igual: es la unica forma de que CENTRAL lo desbloquee (confirmarlo da 409). Historial con accion `order.address_reviewed` ("direccion revisada"), solo el cambio de `status`, sin campos de entrega (4.1) |
| P2 — Kovia y RF_11 | Fixture con el documento real de un pedido de Kovia copiado en solo lectura + replay firmado del webhook de Shopify hacia la tienda de pruebas (5.3) |
| P3 — `auditEvents` con `create` abierto | Spec aparte de prioridad alta: 032 (borrador). En la 029, mitigacion explicita: a la tienda solo le llegan eventos con actor verificable o de accion permitida (2.7); los demas dejan de verse para la tienda (RF_27) |
| P4 — ciudades | Manual con las ciudades activas; el 422 `out_of_coverage` trae la lista de ciudades activas (4.3) |
| P5 — limite de tasa | 120 escrituras/minuto por tienda, constante con nombre en un solo modulo (2.9); "a confirmar con CENTRAL" en riesgos |

## 1. Lo que hay hoy (leido en el codigo, no supuesto)

| Donde | Que hace | Consecuencia para la 029 |
|---|---|---|
| `functions/src/store-api.ts` `storeApi` | `onRequest`, solo `GET`; autentica `sellerId` + key (query o Bearer) contra `storeApiConfigs.apiKey` en claro con `safeEqual`; **lee todos los pedidos de la tienda** antes de mirar la ruta (salvo `docs`); `/orders` lee ademas `walletEntries` de la tienda y **`settlements` entera** | Las rutas nuevas no pueden pasar por esa carga (RNF_05). Las existentes no se tocan por dentro (RF_20): se extraen sus funciones de forma sin cambiar su salida |
| `store-api.ts` `orderPayload`, `classifyOrder`, `buildPaymentInfo` | forma de un elemento de `GET /orders` | RF_01 exige el mismo esquema: se mueven a un modulo puro y las dos rutas las llaman (no se copian) |
| `store-api.ts` `createStoreApiKey` | `admin`/`seller`; devuelve la key de lectura completa cada vez; audita `store_api_key.viewed/created` | Se queda igual (RF_26). La de escritura va por callables nuevas |
| `orders.ts` `confirmImportedOrder` | transaccion; solo `imported`; `addressRisk: "accepted"`, `confirmedVia: "manual"`, audita `order.seller_confirmed` con `fromStatus/toStatus` | Nucleo compartido de confirmar (2.2) |
| `orders.ts` `updateImportedOrder` | solo `imported`; pedido entero; `[MANUAL_EDIT_STAMP]: now`; **conserva** `normalizedAddress` si no viene (spec 013); audita sin campos ni valores | Nucleo compartido de datos de entrega; el panel sigue con su precondicion y sus campos (seccion 7 de la spec) |
| `orders.ts` `cancelOrder` | cualquier no cerrado; la tienda no puede si esta recogido; libera inventario si reservo y no es `imported`; motivo opcional a `callNote`; error si ya `cancelled` | Nucleo compartido de cancelar con dos politicas (panel / api) |
| `orders.ts` `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder`, `assignMessengerToOrders`, `unassignMessengerFromOrders`, `createOrUpdatePickupBatch`; `order-corrections.ts` `correctOrderStatus` | cambian estado (o, el ajuste, producto/recaudo). `createOrUpdatePickupBatch` **no audita** | Todas escriben historial (RF_16, 2.6) |
| `orders.ts` `getOrderAuditTrail` | lee `auditEvents` por `entityId`; resuelve uid → nombre y correo con `getUsers` **para cualquier rol**; al `seller_logistics` le filtra acciones financieras | RF_27: el filtrado de identidades va en el servidor (2.7) |
| `firestore.rules` `auditEvents` | `allow create: if signedIn()` | **Cualquier sesion puede crear un evento con el `entityId` de un pedido ajeno.** No sirve como historial que la API ensena a una tienda (RF_18): el historial campo a campo va a una coleccion nueva solo de servidor (2.5); el cierre de la regla es la spec 032 |
| `firestore.rules` `storeApiConfigs` | `allow read, write: if false` | La huella de la key de escritura vive ahi (2.3) |
| `order-import-merge.ts` | `MANUAL_EDIT_STAMP`, `CLOSED_STATUSES`, `IMPORT_WRITE_EXEMPTIONS` (cuatro) | RF_11 usa la constante; el ejecutor nuevo es la quinta exencion (2.2) |
| `src/lib/spec-017-guards.test.ts` | guarda 1 (quien escribe `orders`), guarda 3 (**exactamente cuatro** exenciones), guarda 7 (**exactamente dos** `[MANUAL_EDIT_STAMP]:` en `orders.ts`) | T6 actualiza guarda 3 (cinco) y guarda 7 (cuenta en `orders.ts` + nucleo), con la razon en el propio test |
| `src/components/operations-app.tsx` `CollapsiblePanel` (l. 1105), `OrderAuditTrail` (l. 2091), `AUDIT_ACTION_LABELS` (l. 2053), `StoreApiKeyCard` (l. 11162) | el "?" mide `h-8 w-8`; el historial pinta `actorLabel`/`actorEmail`/`actorRole` a todos y no reintenta | HU_04 y HU_05 (T18 adapta el uso de `fetchFirebaseOrderAuditTrail`; T20-T23) |
| `cities` | `{ active }`; todas las importaciones escriben `cityId: "city-cali"` | RF_10 lee `cities/{cityId}` dentro de la transaccion; el 422 lista las activas |

## 2. Decisiones de diseno

### 2.1 Superficie HTTP nueva (dentro de la misma funcion `storeApi`)

| Metodo y ruta | Key | Cuerpo | Exito |
|---|---|---|---|
| `GET /orders/{id}` | lectura o escritura | — | 200 `{ ok: true, pedido }` (mismo esquema que un elemento de `GET /orders`) |
| `GET /orders?shopifyOrderId=` | lectura o escritura | — | 200, forma de `GET /orders` (RF_02); ignora `from`/`to` |
| `GET /orders/{id}/history` | lectura o escritura | — | 200 `StoreOrderHistoryResponse` (4.3) |
| `POST /orders/{id}/confirm` | **escritura**, solo Bearer | `{ expectedStatus? }` | 200 `{ ok: true, changed, pedido }` |
| `PATCH /orders/{id}` | **escritura**, solo Bearer | `{ customerName?, customerPhone?, addressRaw?, deliveryNotes?, cityId?, expectedStatus? }` | 200 `{ ok: true, changed, pedido }` |
| `POST /orders/{id}/cancel` | **escritura**, solo Bearer | `{ reason, expectedStatus? }` | 200 `{ ok: true, changed, pedido }` |

`sellerId` sigue por query en todas (no es secreto, y asi la autenticacion es una lectura por id, sin buscar
la huella en toda la coleccion). `changed: false` es la respuesta de RF_05, RF_15 y de una correccion cuyos
valores ya eran los guardados (salvo el caso `address_risk`, 4.1).

`storeApi` deja de responder 405 a todo lo que no es `GET`: `Allow` pasa a ser por ruta. Las rutas existentes
siguen solo `GET` y con su 405 de hoy (`{ ok: false, error: "method_not_allowed" }`).

**Orden de evaluacion de una peticion nueva** (pura en `store-api-request.ts`, T8): ruta y metodo → parametros
de consulta (RF_03, 400 `unknown_parameter`, nombrando cada uno) → credenciales (2.3) → limite de tasa en
escrituras (2.9) → idempotencia (2.8) → cuerpo (422 por campo, 4.4) → transaccion (2.2). En una ruta de
escritura, `key` no es un parametro desconocido: es una credencial en el sitio prohibido, y responde 401
`key_in_query` (2.3), no 400.

### 2.2 Un nucleo puro y un ejecutor transaccional compartidos por panel y API (RF_19, regla de oro 1)

Tres piezas, para que ninguna regla exista dos veces:

1. **`functions/src/order-seller-actions.ts` — puro** (sin `firebase-admin`). Decide, no escribe:
   `planConfirm`, `planDeliveryCorrection`, `planCancel` (4.1). Cada uno recibe el pedido leido, la politica
   (`"panel"` o `"api"`), la entrada ya validada, el actor y `now`, y devuelve o un **rechazo tipado** o un
   **plan**: el parche del pedido, las claves a borrar (`clear`), el evento de auditoria y el registro de
   historial. Importa `MANUAL_EDIT_STAMP` y `CLOSED_STATUSES` de `order-import-merge.ts`.
2. **`functions/src/order-seller-actions-run.ts` — ejecutor.** Una funcion por accion
   (`runConfirm`, `runDeliveryCorrection`, `runCancel`): abre la transaccion, lee el pedido (y, si toca, la
   ciudad, el inventario y el registro de idempotencia), llama al planificador **dentro** de la transaccion,
   aplica `plan.patch` con `merge`, borra `plan.clear` con `FieldValue.delete()`, mueve inventario con
   `applyInventoryMovements` (el mismo de `cancelOrder`), escribe el evento, el historial y, en la API, la
   respuesta idempotente. Devuelve `{ kind: "rejected", rejection } | { kind: "applied" | "unchanged", order }`.
   No sabe de HTTP ni de `HttpsError`.
3. **Adaptadores.** Las callables de `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`,
   `cancelOrder`) y las rutas de `store-api-write.ts` traducen la entrada a la del ejecutor y el rechazo a su
   canal (`HttpsError` con los mismos codigos y mensajes de hoy en el panel; `{ ok:false, code, message }` en la
   API).

**Que se comparte y que no.** El panel y la API comparten: el chequeo de tienda, el parche de confirmar, el
constructor de datos de entrega (recorte, sello `MANUAL_EDIT_STAMP`, diff para el historial), la liberacion
de inventario, la auditoria y el historial. Lo que difiere es **politica declarada en una tabla del nucleo**
(4.1), no codigo duplicado: precondiciones (panel: confirmar/editar solo `imported`; API: editable segun el
glosario), `confirmedVia` (`manual` / `api`), RF_05/RF_15 (no-op en API, error en panel como hoy), RF_23 (la
API borra lo derivado de la direccion; el panel conserva `normalizedAddress` como hoy, spec 013) y el motivo
de cancelar (obligatorio 1-500 en API, opcional en panel). El panel sigue editando producto, pago, modo y
valor: esos campos se anaden al parche **en el adaptador del panel** sobre el plan de datos de entrega, con
`resolveEditedOrderLines` intacto.

**Escritura en `orders` fuera de `orders.ts`.** `order-seller-actions-run.ts` escribe pedidos, asi que entra
como **quinta exencion** en `IMPORT_WRITE_EXEMPTIONS`, con la razon: "Confirmar, corregir datos de entrega y
anular por decision de la tienda o de la plataforma, por panel o por API; nunca crea pedidos ni toca lider,
mensajero ni catalogo". `store-api*.ts` **no** escribe `orders`: solo llama al ejecutor. Guarda 3 de la 017
pasa de cuatro a cinco y guarda 7 cuenta el sello en `orders.ts` (ajustes, 1) + `order-seller-actions.ts`
(datos de entrega, 1), con constante y sin literal (T6).

**Condicion en la transaccion (RF_19).** El planificador se evalua con el pedido leido por
`transaction.get`; si otro escritor (lider que toma el pedido, ChatBy que confirma) cambio el documento,
Firestore reintenta la funcion y la segunda evaluacion ve el estado nuevo: o rechaza con 409 o, en confirmar,
responde no-op (caso limite "ChatBy y API a la vez"). `expectedStatus` opcional: si viene y difiere, 409
`status_changed`, evaluado antes que cualquier otra regla de estado. T6 lo prueba con una carrera simulada:
dos planes sobre el mismo pedido, donde el segundo se evalua con el estado que dejo el primero.

### 2.3 Key de escritura (RF_25, RF_26, RNF_01)

- **Formato:** `kw_` + 45 caracteres base64url de `crypto.randomBytes(34)` → 48 caracteres (las dos lineas de
  24 del diseno). El prefijo `kw_` es visible y sirve para distinguirla a ojo y para rechazarla barato en
  query; la key de lectura (48 hex) no lo tiene.
- **Huella:** `sha256(key)` en hex. Sin pepper ni HMAC con secreto: la key tiene ~270 bits de entropia, asi
  que un hash rapido no es atacable por diccionario y no hace falta un secreto nuevo que gestionar. Se guarda
  solo la huella y `last4`. La key completa existe solo en la respuesta de la callable.
- **Comparacion en tiempo constante:** `crypto.timingSafeEqual` entre `sha256(suministrada)` y la huella
  guardada (mismo largo siempre, 32 bytes), y el `safeEqual` de hoy para la de lectura. Se calculan **las dos
  comparaciones siempre**, para no filtrar por tiempo cual de las dos es.
- **Resolucion de credenciales** (pura, `store-api-auth.ts`). Las filas se evaluan **en este orden**; la
  primera que aplica decide:

| # | Situacion | Ruta de lectura existente | Ruta de lectura nueva | Ruta de escritura |
|---|---|---|---|---|
| 1 | Hay `key` por query (cualquier valor: de lectura, de escritura, valida o no), con o sin cabecera | sigue a la fila 2 | sigue a la fila 2 | **401 `key_in_query`**, sin comparar nada. Nunca 403 |
| 2 | Key con prefijo `kw_` por query, valida o no | 401 `{ ok:false, error: "invalid_key" }` (forma de hoy, RF_20) | 401 `key_in_query` | (ya cubierto por la fila 1) |
| 3 | Sin `sellerId` o sin key | 401 de hoy (`missing_credentials`) | 401 `missing_credentials` | 401 `missing_credentials` |
| 4 | Nada coincide, config inexistente o `status != "active"` | 401 `invalid_key` de hoy | 401 `invalid_key` | 401 `invalid_key` |
| 5 | Key de lectura valida (query o Bearer en lectura; **solo Bearer** en escritura) | pasa | pasa | **403 `read_only_key`** (unico 403) |
| 6 | Key de escritura valida por Bearer | pasa (RF_20) | pasa | pasa |

  `key_in_query` sustituye al `write_key_in_query` de la primera version de este plan (nunca desplegado): el
  codigo nombra el sitio prohibido, no el tipo de key. La key de escritura no tiene su propio `status`: existe o
  no. Desactivar la tienda (`status` de la config) apaga las dos.
- **Generar y rotar, atomico** (pendiente 2 del README). Callable `rotateStoreWriteKey({ sellerId, rotate })`
  (roles `admin` y `seller` de esa tienda; `seller_logistics` → `permission-denied`, decision 7 del diseno).
  Todo en **una transaccion** sobre `storeApiConfigs/{sellerId}` que escribe, a la vez, la huella nueva y el
  evento `store_api_key.write_generated` / `store_api_key.write_rotated` en `auditEvents` (actor, rol,
  `last4` anterior y nuevo; nunca la key). La transaccion es lo que hace verdad la frase de `HU_04.tienda-error`
  "La que termina en c41e sigue activa. No se genero ninguna clave nueva": o se confirman huella y auditoria
  juntas, o no cambia nada. La key se genera **antes** de la transaccion y se devuelve **solo despues** del
  commit; si el commit falla, la key generada se descarta y nunca salio del servidor. Precondiciones dentro de
  la transaccion: `rotate: false` con una key ya existente → `failed-precondition` (no se pisa una key por un
  doble clic de "Generar"); `rotate: true` sin key → `failed-precondition`. Si la config no existe (tienda sin
  key de lectura), se crea con `status: "active"` y sin `apiKey`; las rutas de lectura con key de escritura
  funcionan igual.
- **Lectura del estado sin secretos:** `getStoreApiKeyStatus({ sellerId })` (admin, `seller` y
  `seller_logistics` de esa tienda) y `listStoreApiKeys()` (solo admin, una lectura de `storeApiConfigs` +
  `sellers`; ~14 documentos). Devuelven `StoreApiKeyStatus` (4.2), nunca `apiKey` ni la huella. "Generada por"
  se resuelve en servidor segun quien pregunta (decision 3 del diseno): a la tienda "Tu tienda" o "Kentro"; al
  admin "por la tienda" o el nombre del admin (con `getUsers`, como hoy el historial).
- `createStoreApiKey` (lectura) no cambia (RF_26). Prueba de RF_26: la rotacion de una no toca los campos de la
  otra (planificador puro `planWriteKeyChange`, T3) y la guarda de T17 comprueba que `createStoreApiKey` no
  escribe ningun campo `writeKey*`.

### 2.4 `historySince` es un dato, no una constante (pendiente 1 del README)

Vive en `settings/storeApi.historySince` (ISO). Lo escribe **una vez** el paso de despliegue
`scripts/verify-029.js set-history-since`, inmediatamente despues del despliegue de functions, con
`create` (falla si ya existe: no se puede mover hacia adelante por error). El valor es la hora real del
despliegue, no la del diseno ("6 oct 2026" es ilustrativo).

- `GET /orders/{id}/history`, `getOrderAuditTrail` y el indice de la API lo leen de ahi.
- Sin el documento, `GET /orders/{id}/history` responde 503 `history_not_ready` y `getOrderAuditTrail`
  devuelve `historySince: null` (la UI no pinta la nota de alcance con fecha inventada; ver T19 y T22). Es una
  ventana de minutos entre functions y el script; la escritura de historial **no** depende del dato (registra
  siempre).
- Guarda (T7): ninguna fuente de `functions/src` ni de `src/` contiene un literal de fecha de 2026-10 asociado
  a `historySince`.

### 2.5 Historial: coleccion propia, solo de servidor (RF_16, RF_18, RF_24)

`orderHistory/{autoId}`, un documento **por escritura** (no por campo) con la lista de cambios. Reglas
`allow read, write: if false`: solo el Admin SDK la escribe y la lee, por eso no se puede falsificar como hoy
`auditEvents`. Nunca se actualiza ni se borra (tampoco desde codigo: la guarda de T7 comprueba que ninguna
fuente hace `update`/`delete` sobre `orderHistory`), **salvo la excepcion declarada en RF_16**: el `cleanup`
del guion de verificacion (T27) borra el historial solo de los pedidos de prueba que la verificacion creo.

- Campos registrados: `status` y los datos de entrega (`customerName`, `customerPhone`, `addressRaw`,
  `deliveryNotes`, `cityId`); en el ajuste del admin, ademas `totalCop`, `productName`, `sku`, `quantity`.
  **Nunca** `driverId`, `messengerId`, `pickupBatchId` ni nada que identifique a una persona de Kentro: el
  registro dice "paso a `call_pending`", no quien lo tomo.
- Un registro sin cambios no se escribe (RF_05, RF_15: confirmar o cancelar dos veces deja un solo registro).
- Cada registro guarda `auditEventId`: el evento de `auditEvents` de la misma escritura. `getOrderAuditTrail`
  une los dos por ese id (2.7) en vez de duplicar datos. Ese enlace es tambien lo que hace **verificable** un
  evento: solo el servidor puede escribir un `orderHistory` que lo apunte.
- No hay reconstruccion (RF_24): no existe relleno; un pedido viejo devuelve `[]` hasta su primer cambio.
- Lectura: `where("orderId", "==", id).limit(200)`, orden en memoria por `createdAt` (indice automatico de un
  campo, como hoy `auditEvents`). Se comprueba antes que el pedido es de la tienda (RF_18); el registro lleva
  `sellerId` para comprobarlo dos veces.

### 2.6 Que callables del panel escriben historial (RF_16)

Un solo constructor, `buildOrderHistoryRecord(before, after, meta)` (en el nucleo puro), que hace el diff de
los campos de 2.5 y devuelve `null` si no hay cambios. Lo llaman, dentro de su transaccion o batch (esta tabla
es la misma lista que enumera RF_16 en la spec):

| Callable | Accion | Origen | Tarea |
|---|---|---|---|
| `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` | via el ejecutor (2.2) | `panel` | T6 |
| `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder` | anaden la escritura del registro junto a su evento | `panel` | T15 |
| `assignMessengerToOrders`, `unassignMessengerFromOrders` | cambian `picked_up`↔`call_pending`; solo `status` | `panel` | T16 |
| `createOrUpdatePickupBatch` | `→ picked_up`; hoy sin auditoria: se le anade evento `order.picked_up` y registro | `panel` | T16 |
| `correctOrderStatus` (`order-corrections.ts`) | en su batch | `panel` | T16 |
| rutas de escritura de la API | via el ejecutor | `api` | T11 |

Fuera, como dice la spec: `uchat-pull.ts`, `uchat-webhook.ts` y las cinco importaciones (spec 031).
`classifyFailedOrder` no cambia estado ni datos de entrega: no registra.

Guarda (T16): cada una de esas callables contiene `buildOrderHistoryRecord(` en su cuerpo, y la lista de
callables de `orders.ts` y `order-corrections.ts` que escriben `status` en un pedido es igual a la tabla (una
callable nueva que cambie estado sin registrar pone la suite en rojo).

### 2.7 Lo que ve la tienda en "Historial del pedido" (RF_27, decisiones 11-12 del diseno)

`getOrderAuditTrail` pasa a devolver `{ events, historySince }` y cada evento lleva `origin`, `changes` (si
hay registro con ese `auditEventId`) y, segun el rol de quien pregunta:

- **admin:** como hoy (`actorLabel`, `actorEmail`, `actorRole`) + `origin` (`panel` | `api`) +, para la API,
  `apiKeyLast4` y `actorLabel` "Clave de escritura de <tienda>". El lider y el mensajero siguen como hoy
  (fuera de alcance de RF_27).
- **`seller` y `seller_logistics`:** **no** se llama a `resolveAuditActors` (ni `getUsers`): la identidad no se
  oculta despues de resolverla, simplemente no se resuelve. El evento sale sin `actorId`, `actorLabel`,
  `actorEmail`, `actorRole`, con `storeActorTag` (puro, T14):
  - `"API"` si `actorRole === "store_api"`;
  - `"Tu tienda"` si `actorRole` es `seller` o `seller_logistics` (en un pedido de la tienda solo puede actuar
    su propia tienda: las callables de tienda comprueban `sellerId`; con doble rol, `actorRole` es el sombrero
    con el que actuo);
  - `"Kentro"` en cualquier otro caso, incluido evento sin `actorRole` (procesos: ChatBy, webhooks, sistema).
- **Mitigacion hasta la spec 032 (decision P3, RF_27).** Hoy cualquier sesion puede crear un `auditEvents` con
  el `entityId` de un pedido ajeno. Para no ensenarle a una tienda un evento fabricado por otra, a `seller` y
  `seller_logistics` solo les llegan:
  1. eventos **verificables**: los que tienen un registro en `orderHistory` (solo servidor) cuyo `auditEventId`
     es su `id`; y
  2. eventos cuya `action` esta en la **lista permitida** de abajo.
  El resto se descarta para la tienda (el admin los sigue viendo). **Consecuencia visible, aceptada por la
  spec:** la tienda deja de ver eventos que hoy ve, por ejemplo una reasignacion de mensajero anterior a esta
  spec (no verificable y fuera de la lista). Riesgo residual declarado: un cliente aun podria crear un evento con
  una accion de la lista permitida; lo cierra la 032 y la tienda lo veria sin ninguna identidad, porque
  `storeActorTag` no lee nada mas que `actorRole`.
- **`summary` historicos que nombran a alguien** (caso limite de la spec; pendiente 3 del README): no se
  reescriben registros. A la tienda se le pasa el `summary` solo si la accion esta en la **lista permitida**
  cuyas plantillas se comprobaron sin identidades de Kentro (`order.seller_confirmed`, `order.imported_updated`,
  `order.cancelled`, `order.retry_confirmed`, `order.transition`, `order.delivered`, `order.failed`,
  `order.retry_scheduled`, `order.webhook_imported`, `order.manual_created`, `order.confirmed_uchat`,
  `order.failed_classified`, y las nuevas `order.delivery_corrected`, `order.address_reviewed`,
  `order.picked_up`). Un evento verificable con accion fuera de la lista (`order.messenger_reassigned` y
  `order.messenger_unassigned`, que llevan ids de mensajero; las correcciones, con `auditSummary` libre)
  llega con `summary: ""` y la pantalla pinta solo la etiqueta de la accion y sus cambios. Lista permitida, no
  prohibida: lo que no se conoce no se muestra. Guarda (T14): cada plantilla `summary:` de `functions/src` de
  una accion de la lista no interpola variables de actor (`actorId`, `uid`, `messengerId`, `driverId`,
  `email`, nombre de persona).
- El filtro financiero del `seller_logistics` se conserva.

### 2.8 Idempotencia (RNF_03)

`storeApiIdempotency/{sellerId}__{sha256(Idempotency-Key)}` con `{ bodyHash, method, path, status, body,
createdAt, expiresAt }`. Se lee y se escribe **dentro de la misma transaccion** que la escritura: o se aplica
el cambio y se guarda la respuesta, o ninguna de las dos. Misma key y mismo `sha256(metodo + ruta + cuerpo
canonico)` en 24 h → la respuesta guardada, sin tocar nada. Misma key con otro hash → 422
`idempotency_key_reused`. Expirado (`expiresAt < now`) → como nuevo. Se guardan las respuestas 200 y 409 (las
que dependen del estado); los 400/401/403/422 de validacion no se guardan porque no aplican nada y se
recalculan igual. `Idempotency-Key` de 1 a 255 caracteres imprimibles; fuera de eso, 400
`invalid_idempotency_key`. Limpieza: politica TTL de Firestore sobre `expiresAt` (se crea con `gcloud firestore
fields ttls update`; no va en `firestore.indexes.json`). Reglas: `allow read, write: if false`.

### 2.9 Limite de tasa (RNF_04)

Ventana fija por minuto: `storeApiRateLimits/{sellerId}__{YYYYMMDDHHmm}` con `count`, incrementado en una
transaccion corta **antes** de la de escritura. El limite es **una sola constante con nombre**,
`STORE_API_WRITES_PER_MINUTE = 120`, en `functions/src/store-api-request.ts` (la spec pide un minimo de 60);
ningun otro archivo repite la cifra (guarda de T8). Superado → 429 `rate_limited` con `Retry-After` = segundos
hasta el siguiente minuto (minimo 1). Solo cuenta escrituras; las lecturas nuevas no se limitan en esta spec
(igual que las de hoy). TTL sobre `expiresAt` (+2 minutos). Reglas: `false`.

### 2.10 Lectura de un pedido sin bajar la tienda entera (RNF_05, RF_01, RF_02)

`GET /orders/{id}`: `orders/{id}` por id (404 si no existe o es de otra tienda, mismo HTTP y mismo cuerpo);
asientos de la tienda de ese pedido con `walletEntries where orderId == id` (filtrados en memoria por
`ownerType == "seller"` y `ownerId`); cortes por `getAll` de los `settlementId` de esos asientos **mas**
`settlements where orderIds array-contains id` (lo que `buildCodReceivedSet` necesita para decidir si su
contraentrega se recibio). Con eso, `buildPaymentInfo` produce lo mismo que con la carga completa: la prueba
de T9 lo ata (mismo resultado con todos los cortes que con los dirigidos, sobre fixtures con cortes ajenos,
`cashAllocations` y pedidos parcialmente cubiertos). Si `buildCodReceivedSet` necesitara algo que
`array-contains` no trae, T9 lo encuentra en rojo y se para ahi.

`GET /orders?shopifyOrderId=`: `where("sellerId","==",s).where("shopifyOrderId","==",v)` (dos igualdades:
Firestore las resuelve con los indices de un campo; T2 lo comprueba en prod con `limit(1)`). El tipo guardado
de `shopifyOrderId` se mide en T1: si hay pedidos con numero y con texto, se consulta con `in [texto, numero]`.
Formato valido: `^[0-9A-Za-z#._-]{1,64}$`; otro → 400 `invalid_shopify_order_id` (RF_03). El validador es puro
y vive en `store-api-request.ts` (T8); el handler (T10) solo lo llama. La carga de pago es la de arriba, por
cada pedido encontrado (normalmente uno). T10 prueba el handler con un `db` falso en memoria: solo pedidos de la
tienda de la key, `from`/`to` ignorados, numero repetido en otra tienda fuera, y 404 identico para ajeno e
inexistente.

Las escrituras devuelven el pedido con la misma forma, armada con la misma funcion tras el commit.

## 3. Arbol de modulos

| Archivo | Cambio | Responsabilidad | Tarea |
|---|---|---|---|
| `scripts/verify-029.js` | nuevo | `baseline` (T1), `query-check` (T2), `capture-reads`/`compare-reads` (RF_20, T24), `kovia-replay` (T25), `set-history-since` (2.4), `smoke` y `cleanup` (DoD 3, T27) | T1, T2, T24, T25, T27 |
| `functions/src/order-seller-actions.ts` | nuevo, **puro** | politica, `planConfirm`, `planDeliveryCorrection`, `planCancel`, `buildOrderHistoryRecord`, validacion de datos de entrega | T4, T5 |
| `functions/src/order-seller-actions-run.ts` | nuevo | ejecutor transaccional (2.2); registro idempotente dentro de su transaccion | T6, T12 |
| `functions/src/order-import-merge.ts` | toca | quinta entrada de `IMPORT_WRITE_EXEMPTIONS` | T6 |
| `functions/src/orders.ts` | toca | `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` delegan; historial en el resto (2.6); `getOrderAuditTrail` con 2.7 | T6, T14, T15, T16 |
| `functions/src/order-corrections.ts` | toca | registro de historial en su batch | T16 |
| `functions/src/store-api-orders.ts` | nuevo, puro | `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` movidos tal cual desde `store-api.ts` | T9 |
| `functions/src/store-api-auth.ts` | nuevo, puro | formato de la key, huella, `resolveStoreCredentials` (tabla de 2.3), `planWriteKeyChange` | T3 |
| `functions/src/store-api-request.ts` | nuevo, puro | enrutado nuevo, parametros permitidos por ruta (RF_03), validador de `shopifyOrderId`, esquemas Zod de cuerpo con `.strict()`, catalogo de `code`, `buildErrorBody`, hash de cuerpo, `STORE_API_WRITES_PER_MINUTE` y ventana, `decideIdempotency` | T8, T12 |
| `functions/src/store-api-history.ts` | nuevo, puro | `toStoreHistoryResponse` (4.3), `storeActorTag`, `storeSafeSummary`, `isStoreVisibleEvent`, `HISTORY_EXCLUDES` | T13, T14 |
| `functions/src/store-api-write.ts` | nuevo | handlers HTTP de las rutas nuevas, idempotencia, tasa, carga dirigida (2.10), lista de ciudades activas del 422 | T10, T11, T12, T13 |
| `functions/src/store-api-keys.ts` | nuevo | callables `rotateStoreWriteKey`, `getStoreApiKeyStatus`, `listStoreApiKeys` | T17 |
| `functions/src/store-api.ts` | toca | delega rutas nuevas a `store-api-write.ts`; autenticacion via `store-api-auth.ts`; rutas viejas con su salida identica; indice con rutas nuevas, codigos, estados editables, `historySince` y `HISTORY_EXCLUDES` | T9, T10, T11, T13 |
| `functions/src/index.ts` | toca | exporta las tres callables nuevas | T17 |
| `firestore.rules` | toca | `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`: `allow read, write: if false` | T7 |
| `src/lib/types.ts` | toca | `OrderAuditEntry` ampliado (4.2), `StoreApiKeyStatus` | T18 |
| `src/lib/firebase/auth.ts` | toca | `fetchFirebaseOrderAuditTrail` devuelve `{ events, historySince }`; `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`, `listFirebaseStoreApiKeys` | T18 |
| `src/lib/store-api-keys-view.ts` | nuevo, puro | estados de la seccion (sin clave / recien generada / activa / error / cargando / solo lectura para el logistico), partir la key en dos lineas de 24, paginacion y busqueda del admin | T19 |
| `src/lib/order-audit-trail-view.ts` | nuevo, puro | modelo de vista del historial: pildora de origen, nombres de campo visibles, "Antes/Ahora", nota de alcance desde `historySince` | T19 |
| `src/components/store-api-write-key.tsx` | nuevo | seccion "Clave de escritura" y dialogo de rotar (un componente para tienda y admin) | T20 |
| `src/components/store-api-keys-admin.tsx` | nuevo | panel "Claves de API de tiendas" (tabla / tarjetas) | T21 |
| `src/components/order-audit-trail.tsx` | nuevo | `OrderAuditTrail` sacado de `operations-app.tsx`, con origen, cambios, nota, vacio, error con "Reintentar" | T22 |
| `src/components/operations-app.tsx` | toca | adaptacion del uso de `fetchFirebaseOrderAuditTrail` a `{ events, historySince }` (T18); montaje; `StoreApiKeyCard` en dos secciones; `AUDIT_ACTION_LABELS` + "Datos de entrega corregidos", "Direccion revisada" y "Recogido"; `CollapsiblePanel` "?" a 44 px | T18, T20, T21, T22, T23 |
| `src/app/api-tiendas/page.tsx` | toca | manual: rutas, codigos, estados editables, `historySince`, exclusiones, key solo por cabecera, ciudades activas | T26 |
| `src/lib/fixtures/029-kovia-order.json` | nuevo | fixture de Kovia sin datos personales (P2) | T25 |
| pruebas `src/lib/*.test.ts` | nuevas | ver 5.1 | todas |
| `src/lib/spec-017-guards.test.ts` | toca | guardas 3 y 7 (2.2) | T6 |
| `src/lib/spec-029-guards.test.ts` | nuevo | un `describe("T<n> · ...")` por tarea | T1-T27 |

## 4. Modelo de datos y algoritmos

### 4.1 Nucleo de acciones (`order-seller-actions.ts`)

```ts
export type SellerActionPolicy = "panel" | "api";
export type SellerActor =
  | { kind: "user"; uid: string; role: "admin" | "seller" | "seller_logistics"; sellerId?: string }
  | { kind: "api"; sellerId: string; keyLast4: string };

export type DeliveryField = "customerName" | "customerPhone" | "addressRaw" | "deliveryNotes" | "cityId";
export type DeliveryInput = Partial<Record<Exclude<DeliveryField, "deliveryNotes">, string>> & {
  deliveryNotes?: string | null;          // null o "" = borrar las indicaciones (RF_09, unica excepcion)
};

export const API_EDITABLE_STATUSES = ["imported", "address_risk", "ready_to_assign"] as const;
export const ADDRESS_DERIVED_FIELDS = ["normalizedAddress", "lat", "lng", "geoProvider"] as const;

export type CityFact = { id: string; active: boolean };

export type SellerActionRejection =
  | { code: "order_not_found" }                                   // inexistente u otra tienda (404)
  | { code: "status_changed"; status: string }                    // expectedStatus != real (409)
  | { code: "order_cancelled"; status: "cancelled" }              // RF_06 (409)
  | { code: "address_review_pending"; status: "address_risk" }    // RF_21 (409), con o sin lider
  | { code: "order_not_editable"; status: string; hasLeader: boolean } // RF_08, RF_14 (409)
  | { code: "out_of_coverage"; field: "cityId" }                  // RF_10 (422)
  | { code: "panel_precondition"; message: string };              // mensajes de hoy del panel

export type SellerActionPlan = {
  outcome: "applied" | "unchanged";
  patch: Record<string, unknown>;        // ya con stripUndefined; vacio si unchanged
  clear: string[];                       // claves a FieldValue.delete()
  audit: AuditEventDoc | null;
  history: OrderHistoryDoc | null;       // null si no hay cambios
  inventory: "release" | "none";
};

export function isApiEditable(order: { status?: string; driverId?: string | null }): boolean;
export function planConfirm(i: PlanInput<{ expectedStatus?: string }>): SellerActionRejection | SellerActionPlan;
export function planDeliveryCorrection(i: PlanInput<DeliveryInput & { expectedStatus?: string; city: CityFact | null }>): SellerActionRejection | SellerActionPlan;
export function planCancel(i: PlanInput<{ reason?: string; expectedStatus?: string }>): SellerActionRejection | SellerActionPlan;
// PlanInput<T> = { policy; actor; order: Record<string, unknown> & { id: string }; input: T; now: string }
```

**`isApiEditable`:** estado en `API_EDITABLE_STATUSES` **y** `driverId` nulo, ausente o `""`.

**Confirmar** (tienda primero: actor de tienda con `order.sellerId` distinto → `order_not_found` en API,
`permission-denied` de hoy en panel):

| Estado real | API | Panel (como hoy) |
|---|---|---|
| `expectedStatus` presente y distinto | 409 `status_changed` | — (el panel no lo manda) |
| `imported` sin lider | → `ready_to_assign`, `addressRisk: "accepted"`, `confirmedVia: "api"`, evento `order.seller_confirmed` con `actorRole: "store_api"`, historial `status` | igual con `confirmedVia: "manual"` |
| `imported` con lider (anomalo) | 409 `order_not_editable` | aplica como hoy |
| `address_risk` (con o sin lider) | 409 `address_review_pending` (RF_21 prevalece sobre `order_not_editable`) | error de hoy |
| `cancelled` | 409 `order_cancelled` | error de hoy |
| `ready_to_assign` o posterior, no cancelado (incluidos los finales) | 200 `changed: false`, sin evento ni historial (RF_05) | error de hoy |

**Corregir datos de entrega** (`PATCH`):

1. Tienda; `expectedStatus`.
2. API: `!isApiEditable` → 409 `order_not_editable` con `status` y `hasLeader` (cubre `in_route`,
   `call_pending`, `address_risk` con lider y finales). Panel: solo `imported` (hoy).
3. Ciudad (si viene `cityId`): `city` leido en la transaccion; ausente o `active !== true` → 422
   `out_of_coverage` con la lista de ciudades activas (RF_10, P4). La validacion por campo (4.4) ya se hizo
   fuera: si alguno falla, 422 con todos y ni se abre la transaccion (todo o nada, RF_09).
4. Diff campo a campo contra lo guardado, con valores recortados. `deliveryNotes: null` o `""` borra (unica
   excepcion de RF_09 a "vacio = invalido").
5. **`address_risk` sin lider (RF_22, P1):** `status: "imported"`, `addressRisk: "review"`, **aunque ningun
   campo cambie de valor**: es la unica forma de que la integracion lo desbloquee, porque confirmarlo da 409.
   - Sin campos cambiados → evento y historial con accion **`order.address_reviewed`** ("direccion
     revisada"), `fromStatus: "address_risk"`, `toStatus: "imported"`, `changes` con solo `status`.
   - Con campos cambiados → accion `order.delivery_corrected`, `changes` con `status` y cada campo.
   - Nunca se emite `address_risk` (invariante probada: ningun plan de politica `api`, para ningun estado de
     partida ni accion, tiene `patch.status === "address_risk"`).
6. Si no hay cambios y no aplica el paso 5 → `unchanged`, sin escribir.
7. Si cambia `addressRaw` y la politica es `api` → `clear = ADDRESS_DERIVED_FIELDS` presentes en el pedido
   (RF_23). Politica `panel`: conserva como hoy.
8. `patch` = campos cambiados + `[MANUAL_EDIT_STAMP]: now` (RF_11) + `updatedAt`; evento
   `order.delivery_corrected` (API) / `order.imported_updated` (panel), con `fromStatus/toStatus` si cambio el
   estado; historial con cada campo y `status` si cambio. El sello tambien se pone en el caso
   `order.address_reviewed`: la tienda ha decidido sobre la direccion y una reimportacion no debe deshacerlo.
9. Producto, cantidad, valor, pago y modo no existen en `DeliveryInput` (RF_12): mandarlos por API es 422
   `field_not_allowed` por el `.strict()` del esquema.

**Cancelar:**

| Estado real | API | Panel |
|---|---|---|
| `expectedStatus` distinto | 409 `status_changed` | — |
| `cancelled` | 200 `changed: false` (RF_15) | error de hoy |
| editable (`isApiEditable`) | → `cancelled`, `closedAt`, `callNote = reason` (obligatorio, 1-500), libera inventario si `orderOwnsInventoryReservation` y no `imported` (misma regla de hoy), evento `order.cancelled`, historial `status` | igual que hoy, con su precondicion por rol (admin cualquiera no cerrado; tienda no recogido) |
| en curso o final no cancelado | 409 `order_not_editable` (RF_14; incluye `assigned` y `address_risk` con lider) | como hoy |

### 4.2 Tipos guardados y de UI

```ts
// storeApiConfigs/{sellerId} — campos NUEVOS (los de lectura no cambian)
export type StoreWriteKeyFields = {
  writeKeyHash?: string;            // sha256 hex de la key completa
  writeKeyPrefix?: "kw_";
  writeKeyLast4?: string;
  writeKeyCreatedAt?: string;       // primera generacion
  writeKeyRotatedAt?: string;       // ultima rotacion; ausente si nunca se roto
  writeKeyGeneratedBy?: { uid: string; role: "admin" | "seller" };
};

// orderHistory/{autoId}
export type OrderHistoryOrigin = "api" | "panel";          // 031 anadira "shopify" | "chatby"
export type OrderHistoryField = "status" | DeliveryField | "totalCop" | "productName" | "sku" | "quantity";
export type OrderHistoryChange = { field: OrderHistoryField; from: string | number | null; to: string | number | null };
export type OrderHistoryDoc = {
  id: string; orderId: string; sellerId: string;
  createdAt: string; origin: OrderHistoryOrigin; action: string;
  changes: OrderHistoryChange[];    // nunca vacio
  auditEventId: string;
  actor: { kind: "api"; keyLast4: string } | { kind: "user"; uid: string; role: string };
};

// auditEvents — campos NUEVOS en eventos de la API
//   actorId: "store-api", actorRole: "store_api", origin: "api", apiKeyLast4
// eventos del panel desde esta spec: origin: "panel"

// settings/storeApi
export type StoreApiSettings = { historySince: string };

// getOrderAuditTrail -> { events: OrderAuditEntry[]; historySince: string | null }
export type OrderAuditEntry = {
  id: string; createdAt: string; action: string;
  origin?: OrderHistoryOrigin;               // ausente en eventos anteriores a la spec
  changes?: OrderHistoryChange[];
  fromStatus?: string; toStatus?: string;
  summary: string;                            // "" para la tienda fuera de la lista permitida
  storeActorTag?: "Kentro" | "Tu tienda" | "API";   // solo tienda
  actorId?: string; actorLabel?: string; actorEmail?: string; actorRole?: string; // solo admin, lider, mensajero
  apiKeyLast4?: string;                       // solo admin
};

export type StoreApiKeyStatus = {
  sellerId: string; sellerName: string;
  read: { exists: boolean; status: "active" | "inactive" | "none" };   // nunca la key
  write: { exists: false } | {
    exists: true; prefix: "kw_"; last4: string;
    createdAt: string; rotatedAt: string | null;
    generatedByLabel: string;                 // "Tu tienda" | "Kentro" | "por la tienda" | nombre del admin
  };
  canManageWrite: boolean;                    // false para seller_logistics
};
// rotateStoreWriteKey -> { status: StoreApiKeyStatus; writeKey: string; previousLast4: string | null }
```

### 4.3 Respuestas de las rutas nuevas

```ts
export type StoreApiErrorCode =
  | "unknown_parameter" | "invalid_shopify_order_id" | "invalid_idempotency_key" | "invalid_json"
  | "missing_credentials" | "invalid_key" | "key_in_query"
  | "read_only_key"
  | "order_not_found" | "method_not_allowed"
  | "status_changed" | "order_cancelled" | "address_review_pending" | "order_not_editable"
  | "validation_failed" | "field_not_allowed" | "out_of_coverage" | "no_fields" | "idempotency_key_reused"
  | "rate_limited" | "history_not_ready" | "internal_error";

export type StoreApiError = {
  ok: false; code: StoreApiErrorCode; message: string;     // message en espanol
  fields?: Array<{ field: string; code: "required" | "empty" | "too_long" | "invalid_phone" | "not_allowed" | "out_of_coverage" | "invalid_type"; message: string }>;
  status?: string;                                         // estado actual en 409
  hasLeader?: boolean;
  activeCities?: Array<{ id: string; name: string }>;      // solo en out_of_coverage (P4)
};

export type StoreOrderWriteResponse = { ok: true; changed: boolean; pedido: StoreOrderPayload };

export type StoreOrderHistoryResponse = {
  ok: true; orderId: string;
  historySince: string;
  excludes: ["imports", "chatby"];                          // campo estable (RF_17)
  aviso: string;   // "No incluye cambios de importaciones (Shopify y webhooks de tienda) ni la confirmacion automatica de ChatBy."
  registros: Array<{ at: string; origin: OrderHistoryOrigin; action: string; changes: OrderHistoryChange[] }>;
};
```

`activeCities` sale de `cities where active == true` (una consulta de igualdad sobre una coleccion de pocos
documentos, fuera de la transaccion), con `id` y `name`; se ordena por `name`. Si la consulta falla, el 422 se
responde igual sin `activeCities` (la cobertura ya se decidio dentro de la transaccion).

Codigo HTTP por `code`: 400 (`unknown_parameter`, `invalid_shopify_order_id`, `invalid_idempotency_key`,
`invalid_json`), 401 (`missing_credentials`, `invalid_key`, `key_in_query`), 403 (`read_only_key`, unico 403),
404 (`order_not_found`), 405, 409 (`status_changed`, `order_cancelled`, `address_review_pending`,
`order_not_editable`), 422 (`validation_failed`, `field_not_allowed`, `out_of_coverage`, `no_fields`,
`idempotency_key_reused`), 429, 503 (`history_not_ready`), 500. La tabla vive en `store-api-request.ts`; una
prueba fija que ningun `code` existente cambia de nombre ni de HTTP (RNF_02: se agregan, no se renombran).

El registro de historial que sale por la API es `{ at, origin, action, changes }`: sin `actor`, sin `uid`, sin
`auditEventId` (RF_18). `toStoreHistoryResponse` es una funcion con lista explicita de claves de salida.

### 4.4 Validacion de datos de entrega (RF_09)

| Campo | Regla |
|---|---|
| `customerName` | texto, recortado 1-120; vacio o `null` → `empty` |
| `customerPhone` | quitando espacios, guiones, puntos y parentesis: 10 digitos (`^\d{10}$`), o `+57` + 10 digitos, o E.164 `^\+[1-9]\d{7,14}$`. Se guarda recortado tal como vino (no se reformatea: ChatBy compara por los ultimos 10 digitos); vacio o `null` → `empty` |
| `addressRaw` | recortado 1-300; vacio o `null` → `empty` |
| `deliveryNotes` | `null` o `""` (tambien solo espacios) **borra** las indicaciones (unica excepcion de RF_09); si no, 1-500 |
| `cityId` | `^[a-z0-9-]{1,64}$`; vacio o `null` → `empty`; la cobertura se decide en la transaccion (RF_10) |
| cualquier otra clave | `field_not_allowed` (incluye producto, valor, pago, modo, `status`, `driverId`) |

Todos los errores de formato se recogen a la vez (`fields`); cuerpo sin ningun campo de entrega → 422
`no_fields` (`{ deliveryNotes: null }` si es un campo y no da `no_fields`). Primero se valida el formato de todo
y, si pasa, la cobertura: el ejemplo del DoD "telefono valido + ciudad no cubierta" da 422 `out_of_coverage`
nombrando `cityId` y no aplica el telefono.

### 4.5 Coste por peticion (RNF_05)

| Ruta | Lecturas | Escrituras |
|---|---|---|
| autenticacion | 1 (`storeApiConfigs/{sellerId}`) | — |
| `GET /orders/{id}` | 1 pedido + asientos del pedido (≈3-8) + cortes que lo contienen (≈1-3) | — |
| `GET /orders/{id}/history` | 1 pedido + registros (decenas) + `settings/storeApi` | — |
| escritura | tasa (1+1) + idempotencia (1) + pedido (1) + ciudad (0-1) + inventario de la tienda si libera + payload (≈10); `cities` activas solo en el 422 | pedido, evento, historial, idempotencia |

Nada depende del numero de pedidos de la tienda. T27 mide p95 en produccion (objetivo < 2 s, contando arranque
en frio aparte).

## 5. Estrategia de testing

### 5.1 Mapa requisito → prueba → tarea

| Req. | Prueba | Tarea |
|---|---|---|
| RF_01 | `GET /orders/{id}` == elemento de `GET /orders` (fixtures, carga dirigida vs completa); 404 ajeno = 404 inexistente (mismo HTTP y cuerpo) | T9, T10 |
| RF_02 | filtro por `shopifyOrderId` solo de la tienda; ignora `from`/`to`; numero repetido entre tiendas | T10 |
| RF_03 | parametro desconocido → 400 nombrandolo, en cada ruta nueva; `shopifyOrderId` mal formado → 400 (validador); rutas viejas siguen ignorando | T8, T10 |
| RF_04, RF_05 | `planConfirm`: `imported` → `ready_to_assign` + `accepted` + `confirmedVia: "api"`; dos veces → un registro | T4, T6 |
| RF_06, RF_21 | `cancelled` → `order_cancelled`; `address_risk` con y sin lider → `address_review_pending` | T4 |
| RF_07, RF_08 | solo campos enviados; corregir no confirma; `in_route`, `call_pending`, `address_risk` con lider → 409 sin cambios | T5 |
| RF_09, RF_10 | tabla 4.4 entera (incluida la excepcion de `deliveryNotes`); telefono valido + ciudad inactiva → 422 `cityId` con `activeCities`, telefono intacto | T5, T11 |
| RF_22 | `address_risk` sin lider → `imported` + `review`, tambien con valores identicos (`order.address_reviewed`); confirmar despues → `ready_to_assign`; invariante "nunca `address_risk`" | T5 |
| RF_23 | cambio de direccion → `clear` con los cuatro campos; sin cambio de direccion → `clear` vacio | T5 |
| RF_11 | el plan lleva `MANUAL_EDIT_STAMP`; `mergeImportedOrder` sobre el resultado conserva cliente y direccion; fixture real de Kovia (P2) | T5, T25 |
| RF_12 | `field_not_allowed` para producto, cantidad, valor, pago, modo | T5, T8 |
| RF_13-RF_15 | cancelar editable con motivo + inventario `release`; `assigned` → 409; dos veces → un registro; sin motivo → 422 | T4, T6 |
| RF_16 | `buildOrderHistoryRecord` (diff, `null` sin cambios, campos de identidad nunca); guarda de 2.6 con la lista exacta de RF_16; solo el `cleanup` borra `orderHistory` | T5, T7, T15, T16, T27 |
| RF_17 | respuesta con `historySince`, `excludes` y `aviso`; el indice lo dice; el manual tambien | T13, T26 |
| RF_18 | `toStoreHistoryResponse` sin `actor`/`uid`/`auditEventId`; pedido ajeno → 404 | T13, T14 |
| RF_19 | guarda anti-copia (5.2); condicion dentro de la transaccion; `status_changed`; carrera simulada (dos planes sobre el mismo pedido) | T4, T6 |
| RF_20 | `compare-reads` antes/despues sobre `/resumen`, `/kpis`, `/orders`, `/settlements` y las claves actuales del indice, con key de lectura y con key de escritura; errores viejos con `{ ok, error }` | T9, T24, T27 |
| RF_24 | sin relleno: guarda que nada lee `auditEvents` para construir `orderHistory` | T16 |
| RF_25, RF_26 | `planWriteKeyChange`; atomicidad (transaccion con huella + auditoria); `createStoreApiKey` no toca `writeKey*`; "?" de 44 px del panel de la clave (diseno de HU_04) | T3, T17, T23 |
| RF_27 | `storeActorTag`, `storeSafeSummary`, `isStoreVisibleEvent` (mitigacion hasta la 032: no verificable fuera de la lista → descartado para la tienda); `getOrderAuditTrail` para `seller`/`seller_logistics` sin identidades y sin `getUsers`; admin igual que hoy; guarda de pantalla: `order-audit-trail.tsx` no pinta `actorEmail` cuando hay `storeActorTag` | T14, T22 |
| RNF_01 | tabla 2.3 completa (cualquier key por query en escritura → 401; `kw_` por query en lectura vieja y nueva → 401; 403 solo para key de lectura en la cabecera); 404 identico | T3, T10 |
| RNF_02 | catalogo de codigos congelado; forma `{ ok:false, code, message, fields? }` | T8, T11 |
| RNF_03 | misma key mismo cuerpo → misma respuesta sin aplicar; otro cuerpo → 422; expirado → nuevo | T12 |
| RNF_04 | ventana, 429 + `Retry-After`, nunca 403; la cifra solo en `STORE_API_WRITES_PER_MINUTE` | T8, T12 |
| RNF_05 | guarda: los handlers nuevos no contienen `where("sellerId"` sin un segundo filtro ni leen `collection("settlements").get()`; p95 medido | T10, T27 |

### 5.2 Guardas de fuente (`spec-029-guards.test.ts`, mismo patron que la 017 y la 026: fuente sin comentarios)

- **Anti-copia (RF_19, T6 y T11):** `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`, `cancelOrder`) y
  `store-api-write.ts` llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel`; ninguno de esos cuerpos
  contiene `status: "ready_to_assign"`, `status: "cancelled"`, `addressRisk: "accepted"` ni
  `[MANUAL_EDIT_STAMP]`; mutacion comprobada a mano (pegar el parche de confirmar en `store-api-write.ts` pone
  la guarda en rojo) en `EV/mutacion-rf19.txt`.
- **Nadie mas escribe `orders`:** guarda 1 de la 017 sigue en verde; `store-api*.ts` y `store-api-keys.ts` no
  escriben pedidos (`writesOrders` de la 017 reutilizado).
- **Historial (2.6, T15 y T16)**, **identidades y mitigacion (2.7, T14)**, **`historySince` sin literal (2.4,
  T7)**, **reglas** (tres colecciones nuevas con `allow read, write: if false`, T7), **la key no sale**
  (`store-api-keys.ts` solo devuelve `writeKey` en `rotateStoreWriteKey` y nunca escribe `writeKey:` en
  Firestore; ningun `console.*`/`logger.*` recibe la key ni la cabecera `authorization`; T17), **limite en un
  solo sitio** (el literal `120` asociado a escrituras por minuto solo aparece en
  `STORE_API_WRITES_PER_MINUTE`; T8).
- **UI:** `operations-app.tsx` solo monta los componentes nuevos (T20-T22); `localStorage` no aparece en
  `store-api-write-key.tsx` (T20); el "?" de `CollapsiblePanel` no usa `h-8 w-8` (T23).

### 5.3 Canal del cliente: verificacion contra produccion (DoD 3)

Las rutas son HTTP y la UI usa callables: se prueban **por su canal**, no reimplementando la regla en un
script (memoria "verificar por el canal del cliente").

- **Tienda de pruebas** (OPC_04, operativa): `seller-test-029`, creada por `verify-029.js smoke --setup` con
  un usuario `seller` y uno `seller_logistics` desechables (contrasena aleatoria, nunca en la evidencia), en
  `city-cali` (ya activa). La key de escritura la genera **la callable** con la sesion `seller`.
- **Lecturas reales** (solo lectura) contra tiendas reales con su key de lectura existente: `capture-reads`
  antes del despliegue (T24) y `compare-reads` despues (RF_20, T27). `GET /orders/{id}` sobre 20 pedidos reales
  de Kovia, ONEP y DANDA comparados con su elemento en `GET /orders` (RF_01).
- **Escrituras solo sobre pedidos de la tienda de pruebas**, todos creados con `createManualOrder` y la sesion
  de esa tienda:
  - uno `imported` para CA_01-CA_04 y RF_04/RF_05;
  - uno en `address_risk`, creado con el alta manual marcada "revisar" (`addressRisk: "review"`), que es la via
    que hoy produce ese estado, para RF_21 y RF_22 (con y sin cambio de valores);
  - uno tomado por un lider desechable, para RF_08 y RF_14;
  - uno con inventario reservado, para RF_13.
  Los CA_01-CA_12 de CENTRAL se recorren tal cual, con CA_03 corregido (confirmar `imported`).
- **RF_27 con sesion real:**
  - sobre un pedido de prueba con eventos de admin, de lider, de la propia tienda y de la API: `getOrderAuditTrail`
    con la sesion `seller` y con la `seller_logistics` de la tienda de pruebas, y con una de admin;
  - sobre eventos historicos (anteriores a la spec), que la tienda de pruebas no tiene: un usuario `seller`
    desechable con el claim de una tienda real llama a `getOrderAuditTrail` sobre pedidos viejos de esa tienda.
    Es solo lectura (la callable no escribe) y el usuario se borra en `cleanup`;
  - E2E de `HU_05.tienda` con esa sesion: ningun nombre ni correo de Kentro en el DOM.
- **RF_11 con Kovia (P2, T25):** (a) prueba unitaria con el **documento real** de un pedido de Kovia copiado en
  solo lectura como fixture (`src/lib/fixtures/029-kovia-order.json`, sin datos personales: nombre, telefono y
  direccion reemplazados por valores sinteticos con la misma forma), pasado por `planDeliveryCorrection` y
  despues por `mergeImportedOrder` con el payload de Shopify de ese pedido; (b) en produccion,
  `verify-029.js kovia-replay`: un webhook de Shopify con la forma de Kovia, **firmado** con el secreto de
  Shopify y dirigido a la tienda de pruebas, sobre un pedido ya corregido por API; se comprueba que cliente y
  direccion se conservan y el estado no cambia. No se toca ningun pedido real de Kovia.
- **`cleanup` (T27):** borra pedidos de prueba, sus `auditEvents`, `orderHistory`, `storeApiIdempotency`,
  `storeApiRateLimits`, `walletEntries` si los hubiera, inventario de prueba, usuarios y la tienda; imprime
  recuento y falla si queda algo. Es el unico codigo que borra `orderHistory`, y solo por `orderId` de prueba
  (excepcion declarada en RF_16).

## 6. Indices

**Previstos: ninguno compuesto.** Todas las consultas nuevas son igualdad sobre un campo
(`orderHistory.orderId`, `walletEntries.orderId`, `settlements.orderIds array-contains`, `cities.active`) o
dos igualdades (`orders.sellerId` + `orders.shopifyOrderId`), que Firestore sirve con los indices
automaticos. `query-check` (T2) ejecuta cada una con `limit(1)` en produccion **antes** de escribir el
handler; si alguna pide indice, se **anade** a `firestore.indexes.json` tras `firebase firestore:indexes`
contra prod (se anaden, nunca se reemplazan) y se despliega primero. Politicas **TTL** (no son indices):
`storeApiIdempotency.expiresAt` y `storeApiRateLimits.expiresAt`, con `gcloud firestore fields ttls update`.

## 7. Reglas de Firestore

Se anaden tres bloques, todos `allow read, write: if false`: `orderHistory`, `storeApiIdempotency`,
`storeApiRateLimits`. `settings/storeApi` hereda la regla de `settings` (comprobar en T7 que el cliente no
puede escribirlo; si la regla de `settings` lo permitiera, bloque propio `allow write: if false`). No se toca
`auditEvents`: su cierre es la spec 032; mientras tanto, la mitigacion de 2.7.

## 8. Dependencias nuevas

Ninguna. `crypto` de Node (`randomBytes`, `createHash("sha256")`, `timingSafeEqual`), Zod y `firebase-admin`
ya estan.

## 9. Tareas

Ver `specs/029_tasks.md` (T1-T27). T23 resuelve el pendiente 3 del README y se acepta como parte del diseno de
HU_04 (RF_25): el "?" de `CollapsiblePanel` vive en el panel de la clave de API y pasa de `h-8 w-8` (32 px) a un
area de 44x44 (`h-11 w-11`, icono de 16 px y forma circular sin cambio), con guarda de fuente y `boundingBox()`
>= 44 en el E2E a 375 y 1280.

## 10. Orden de despliegue

1. `capture-reads` (T24) con las keys de lectura actuales.
2. Reglas (`orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`) (T7).
3. Indices solo si T2 los pidio (comparando con prod) y esperar `READY`; politicas TTL.
4. Functions: `storeApi`, las callables tocadas de `orders.ts` y `order-corrections.ts`, y las tres nuevas,
   con `ALLOW_FUNCTIONS_DEPLOY=1` tras `npm run build` y `firebase functions:list`. Humano (principio 7).
5. `verify-029.js set-history-since` (una vez; `create`) (T27).
6. Hosting (`npm run lint`, `static{` = 0, `ALLOW_FUNCTIONS_DEPLOY=1`).
7. `smoke`, `kovia-replay` (T25), `compare-reads`, p95, E2E de HU_04/HU_05, `cleanup` (T27).
8. Entregar la key de escritura a CENTRAL: la genera la tienda (Kovia/ONEP) desde su panel o el admin, y se
   entrega por canal seguro (README, decision 4).

## 11. Riesgos

| Riesgo | Mitigacion |
|---|---|
| La API confirma o corrige un pedido que ya tomo un lider (clobber) | condicion dentro de la transaccion; `driverId` en la definicion de editable; prueba de carrera simulada con dos planes sobre el mismo pedido (T6) |
| Copiar la regla de confirmar/cancelar en la API | nucleo + ejecutor unicos; guarda anti-copia con mutacion |
| Historial falsificable | `orderHistory` solo de servidor (2.5) |
| Evento de `auditEvents` fabricado por un cliente visible para la tienda | mitigacion 2.7 (verificable o accion permitida); riesgo residual hasta la spec 032 (prioridad alta) |
| La tienda deja de ver eventos historicos que hoy ve (efecto de la mitigacion) | aceptado en RF_27 y en los casos limite de la spec; lo revisa la 032 |
| Identidades de Kentro a la tienda por `summary` viejos | lista permitida, no prohibida (2.7) |
| La key de escritura en logs o en `localStorage` | guardas 5.2; solo cabecera; cualquier key por query en escritura → 401 |
| Rotacion a medias que deja a la integracion sin key | transaccion huella + auditoria; la key se devuelve tras el commit |
| `GET /orders/{id}` distinto del elemento de `GET /orders` | misma funcion movida; equivalencia de carga dirigida; comparacion en prod sobre 20 pedidos |
| Romper integraciones de lectura | rutas viejas sin cambio interno; `compare-reads` antes/despues; el indice solo gana claves |
| Doble aplicacion por reintento de CENTRAL | `Idempotency-Key` en la misma transaccion |
| ChatBy reescribe una direccion corregida por API | aceptado por la spec (caso limite); advertido en `aviso` y en el manual; spec 031 |
| `address_risk` desbloqueado por API sin cambiar nada | decidido (P1): queda en `imported` + `review`, con historial `order.address_reviewed`; la confirmacion sigue siendo aparte y explicita |
| **Limite de 120 escrituras/minuto por tienda: a confirmar con CENTRAL** | una sola constante (`STORE_API_WRITES_PER_MINUTE`); cambiarla es una linea y su prueba |
| Coste del limite de tasa (1 escritura por peticion) | ~120/min por tienda en el peor caso; TTL limpia |

## 12. Preguntas abiertas

Todas resueltas el 2026-10-04 (tabla de la cabecera). Pendiente operativo, no bloqueante: confirmar con
CENTRAL el limite de 120 escrituras/minuto (seccion 11). Nota para diseno: las etiquetas "Direccion revisada"
(`order.address_reviewed`) y "Recogido" (`order.picked_up`) no estan en el README; T22 las anade a
`AUDIT_ACTION_LABELS` y conviene que `sdd-uxui` las ratifique en el README antes de T22.

## 13. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-04 | Plan tecnico inicial y cierre de P1-P5 | Spec 029 aprobada |
| 2026-10-04 | Precisiones de `/sdd-analyze`: (1) confirmar un `address_risk` da siempre 409 `address_review_pending`, tambien con lider (4.1); (2) tabla 2.3 reescrita con orden de evaluacion: cualquier key por query en escritura → 401 `key_in_query` (sustituye a `write_key_in_query`, nunca desplegado), `kw_` por query → 401 tambien en rutas de lectura viejas, 403 `read_only_key` solo para la key de lectura en la cabecera; (3) `deliveryNotes` vacio o `null` borra y el resto de campos vacios dan 422 (4.4); (4) T12 toca `order-seller-actions-run.ts`; (5) T18 toca `operations-app.tsx` para adaptar `fetchFirebaseOrderAuditTrail`; (6) pruebas de RF_02 y del 404 identico en T10, validador de `shopifyOrderId` en T8; (7) todas las referencias a tareas renumeradas a T1-T27 (secciones 1, 2.x, 3, 4.5, 5.x, 9, 10, 12); (8) tabla 2.6 con su tarea y declarada igual a la lista de RF_16; (9) excepcion del `cleanup` en 2.5 y 5.3; (10) consecuencia visible de la mitigacion 2.7 y riesgo nuevo; (11) T23 aceptada como parte del diseno de HU_04 (seccion 9); (12) carrera simulada en T6 (2.2 y riesgos) | Hallazgos de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
