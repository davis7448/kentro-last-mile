# Plan tecnico — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API, sin pisar lo operado

- **Spec:** `specs/029_store_api_confirma_y_corrige_pedidos.md` — **aprobada el 2026-10-04** (decisiones 1-7,
  seccion 9).
- **Fecha:** 2026-10-04.
- **Diseno:** `specs/design/029_store_api_confirma_y_corrige_pedidos/` (README + 14 pantallas observadas):
  - HU_04 (clave de escritura): `HU_04.tienda-sin-clave`, `HU_04.tienda-recien-generada`, `HU_04.tienda-activa`,
    `HU_04.tienda-rotar`, `HU_04.tienda-error`, `HU_04.admin-lista`, `HU_04.admin-lista-movil`,
    `HU_04.admin-recien-generada`;
  - HU_05 (historial): `HU_05.tienda`, `HU_05.tienda-escritorio`, `HU_05.admin`, `HU_05.admin-escritorio`,
    `HU_05.vacio`, `HU_05.error`.
  Este plan no decide textos ni disposicion: los toma del README. Sus tres pendientes "fuera del diseno" se
  resuelven aqui (2.10, 2.4 y T19).
- **Evidencia:** `.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).
- **Siguientes:** 030 (webhook firmado) reutilizara `orderHistory` como fuente de eventos; 031 anadira los
  origenes `shopify` y `chatby` al mismo registro. Este plan deja el tipo abierto para eso (4.2).

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
| `firestore.rules` `auditEvents` | `allow create: if signedIn()` | **Cualquier sesion puede crear un evento con el `entityId` de un pedido ajeno.** No sirve como historial que la API ensena a una tienda (RF_18): el historial campo a campo va a una coleccion nueva solo de servidor (2.5) |
| `firestore.rules` `storeApiConfigs` | `allow read, write: if false` | La huella de la key de escritura vive ahi (2.3) |
| `order-import-merge.ts` | `MANUAL_EDIT_STAMP`, `CLOSED_STATUSES`, `IMPORT_WRITE_EXEMPTIONS` (cuatro) | RF_11 usa la constante; el ejecutor nuevo es la quinta exencion (2.2) |
| `src/lib/spec-017-guards.test.ts` | guarda 1 (quien escribe `orders`), guarda 3 (**exactamente cuatro** exenciones), guarda 7 (**exactamente dos** `[MANUAL_EDIT_STAMP]:` en `orders.ts`) | T5 actualiza guarda 3 (cinco) y guarda 7 (cuenta en `orders.ts` + nucleo), con la razon en el propio test |
| `src/components/operations-app.tsx` `CollapsiblePanel` (l. 1105), `OrderAuditTrail` (l. 2091), `AUDIT_ACTION_LABELS` (l. 2053), `StoreApiKeyCard` (l. 11162) | el "?" mide `h-8 w-8`; el historial pinta `actorLabel`/`actorEmail`/`actorRole` a todos y no reintenta | HU_04 y HU_05 (T17-T19) |
| `cities` | `{ active }`; todas las importaciones escriben `cityId: "city-cali"` | RF_10 lee `cities/{cityId}` dentro de la transaccion |

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
valores ya eran los guardados.

`storeApi` deja de responder 405 a todo lo que no es `GET`: `Allow` pasa a ser por ruta. Las rutas existentes
siguen solo `GET` y con su 405 de hoy (`{ ok: false, error: "method_not_allowed" }`).

**Orden de evaluacion de una peticion nueva** (pura en `store-api-request.ts`, T7): ruta y metodo → parametros
de consulta (RF_03, 400 `unknown_parameter`, nombrando cada uno) → credenciales (2.3) → limite de tasa en
escrituras (2.9) → idempotencia (2.8) → cuerpo (422 por campo, 4.4) → transaccion (2.2).

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
(datos de entrega, 1), con constante y sin literal (T5).

**Condicion en la transaccion (RF_19).** El planificador se evalua con el pedido leido por
`transaction.get`; si otro escritor (lider que toma el pedido, ChatBy que confirma) cambio el documento,
Firestore reintenta la funcion y la segunda evaluacion ve el estado nuevo: o rechaza con 409 o, en confirmar,
responde no-op (caso limite "ChatBy y API a la vez"). `expectedStatus` opcional: si viene y difiere, 409
`status_changed`, evaluado antes que cualquier otra regla de estado.

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
- **Resolucion de credenciales** (pura, `store-api-auth.ts`):

| Situacion | Ruta de lectura (existente o nueva) | Ruta de escritura |
|---|---|---|
| Key de lectura valida (query o Bearer) | pasa | 403 `read_only_key` |
| Key de escritura valida por Bearer | pasa (RF_20) | pasa |
| Key con prefijo `kw_` por query, valida o no | 401 (`invalid_key` en rutas viejas; `write_key_in_query` en nuevas) | 401 `write_key_in_query` |
| Sin `sellerId` o sin key | 401 de hoy (`missing_credentials`) / `missing_credentials` | 401 `missing_credentials` |
| Nada coincide, config inexistente o `status != "active"` | 401 `invalid_key` | 401 `invalid_key` |

  La key de escritura no tiene su propio `status`: existe o no. Desactivar la tienda (`status` de la config)
  apaga las dos.
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
  otra (planificador puro `planWriteKeyChange`, T3) y la guarda T6 comprueba que `createStoreApiKey` no escribe
  ningun campo `writeKey*`.

### 2.4 `historySince` es un dato, no una constante (pendiente 1 del README)

Vive en `settings/storeApi.historySince` (ISO). Lo escribe **una vez** el paso de despliegue
`scripts/verify-029.js set-history-since`, inmediatamente despues del despliegue de functions, con
`create` (falla si ya existe: no se puede mover hacia adelante por error). El valor es la hora real del
despliegue, no la del diseno ("6 oct 2026" es ilustrativo).

- `GET /orders/{id}/history`, `getOrderAuditTrail` y el indice de la API lo leen de ahi.
- Sin el documento, `GET /orders/{id}/history` responde 503 `history_not_ready` y `getOrderAuditTrail`
  devuelve `historySince: null` (la UI no pinta la nota de alcance con fecha inventada; ver T18). Es una
  ventana de minutos entre functions y el script; la escritura de historial **no** depende del dato (registra
  siempre).
- Guarda (T6): ninguna fuente de `functions/src` ni de `src/` contiene un literal de fecha de 2026-10 asociado
  a `historySince`.

### 2.5 Historial: coleccion propia, solo de servidor (RF_16, RF_18, RF_24)

`orderHistory/{autoId}`, un documento **por escritura** (no por campo) con la lista de cambios. Reglas
`allow read, write: if false`: solo el Admin SDK la escribe y la lee, por eso no se puede falsificar como hoy
`auditEvents`. Nunca se actualiza ni se borra (tampoco desde codigo: la guarda T6 comprueba que ninguna fuente
hace `update`/`delete` sobre `orderHistory`, salvo el `cleanup` del guion de verificacion sobre su pedido de
prueba).

- Campos registrados: `status` y los datos de entrega (`customerName`, `customerPhone`, `addressRaw`,
  `deliveryNotes`, `cityId`); en el ajuste del admin, ademas `totalCop`, `productName`, `sku`, `quantity`.
  **Nunca** `driverId`, `messengerId`, `pickupBatchId` ni nada que identifique a una persona de Kentro: el
  registro dice "pasó a `call_pending`", no quien lo tomo.
- Un registro sin cambios no se escribe (RF_05, RF_15: confirmar o cancelar dos veces deja un solo registro).
- Cada registro guarda `auditEventId`: el evento de `auditEvents` de la misma escritura. `getOrderAuditTrail`
  une los dos por ese id (2.7) en vez de duplicar datos.
- No hay reconstruccion (RF_24): no existe relleno; un pedido viejo devuelve `[]` hasta su primer cambio.
- Lectura: `where("orderId", "==", id).limit(200)`, orden en memoria por `createdAt` (indice automatico de un
  campo, como hoy `auditEvents`). Se comprueba antes que el pedido es de la tienda (RF_18); el registro lleva
  `sellerId` para comprobarlo dos veces.

### 2.6 Que callables del panel escriben historial (RF_16)

Un solo constructor, `buildOrderHistoryRecord(before, after, meta)` (en el nucleo puro), que hace el diff de
los campos de 2.5 y devuelve `null` si no hay cambios. Lo llaman, dentro de su transaccion o batch:

| Callable | Accion | Origen |
|---|---|---|
| `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` | via el ejecutor (2.2) | `panel` |
| `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder` | anaden la escritura del registro junto a su evento | `panel` |
| `assignMessengerToOrders`, `unassignMessengerFromOrders` | cambian `picked_up`↔`call_pending`; solo `status` | `panel` |
| `createOrUpdatePickupBatch` | `→ picked_up`; hoy sin auditoria: se le anade evento `order.picked_up` y registro | `panel` |
| `correctOrderStatus` (`order-corrections.ts`) | en su batch | `panel` |
| rutas de escritura de la API | via el ejecutor | `api` |

Fuera, como dice la spec: `uchat-pull.ts`, `uchat-webhook.ts` y las cinco importaciones (spec 031).
`classifyFailedOrder` no cambia estado ni datos de entrega: no registra.

Guarda (T13): cada una de esas callables contiene `buildOrderHistoryRecord(` en su cuerpo, y la lista de
callables de `orders.ts` que hacen `transaction.set(` sobre un pedido con `status` en el parche es igual a la
tabla (una callable nueva que cambie estado sin registrar pone la suite en rojo).

### 2.7 Lo que ve la tienda en "Historial del pedido" (RF_27, decisiones 11-12 del diseno)

`getOrderAuditTrail` pasa a devolver `{ events, historySince }` y cada evento lleva `origin`, `changes` (si
hay registro con ese `auditEventId`) y, segun el rol de quien pregunta:

- **admin:** como hoy (`actorLabel`, `actorEmail`, `actorRole`) + `origin` (`panel` | `api`) +, para la API,
  `apiKeyLast4` y `actorLabel` "Clave de escritura de <tienda>". El lider y el mensajero siguen como hoy
  (fuera de alcance de RF_27).
- **`seller` y `seller_logistics`:** **no** se llama a `resolveAuditActors` (ni `getUsers`): la identidad no se
  oculta despues de resolverla, simplemente no se resuelve. El evento sale sin `actorId`, `actorLabel`,
  `actorEmail`, `actorRole`, con `storeActorTag` (puro, T12):
  - `"API"` si `actorRole === "store_api"`;
  - `"Tu tienda"` si `actorRole` es `seller` o `seller_logistics` (en un pedido de la tienda solo puede actuar
    su propia tienda: las callables de tienda comprueban `sellerId`; con doble rol, `actorRole` es el sombrero
    con el que actuo);
  - `"Kentro"` en cualquier otro caso, incluido evento sin `actorRole` (procesos: ChatBy, webhooks, sistema).
- **`summary` historicos que nombran a alguien** (caso limite de la spec; pendiente 3 del README): no se
  reescriben registros. A la tienda se le pasa el `summary` solo si la accion esta en una **lista permitida**
  cuyas plantillas se comprobaron sin identidades de Kentro (`order.seller_confirmed`, `order.imported_updated`,
  `order.cancelled`, `order.retry_confirmed`, `order.transition`, `order.delivered`, `order.failed`,
  `order.retry_scheduled`, `order.webhook_imported`, `order.manual_created`, `order.confirmed_uchat`,
  `order.failed_classified`). El resto (`order.messenger_reassigned` y `order.messenger_unassigned`, que llevan
  ids de mensajero; las correcciones, que llevan `auditSummary` libre; cualquier accion futura) llega con
  `summary: ""` y la pantalla pinta solo la etiqueta de la accion. Lista permitida, no prohibida: lo que no se
  conoce no se muestra. Guarda (T12): cada plantilla `summary:` de `functions/src` de una accion de la lista
  permitida no interpola variables de actor (`actorId`, `uid`, `messengerId`, `driverId`, `email`, `name` de
  persona).
- El filtro financiero del `seller_logistics` se conserva.

### 2.8 Idempotencia (RNF_03)

`storeApiIdempotency/{sellerId}__{sha256(Idempotency-Key)}` con `{ bodyHash, method, path, status, body,
createdAt, expiresAt }`. Se lee y se escribe **dentro de la misma transaccion** que la escritura: o se aplica
el cambio y se guarda la respuesta, o ninguna de las dos. Misma key y mismo `sha256(metodo + ruta + cuerpo
canonico)` en 24 h → la respuesta guardada, sin tocar nada. Mismo key con otro hash → 422
`idempotency_key_reused`. Expirado (`expiresAt < now`) → como nuevo. Se guardan las respuestas 200 y 409 (las
que dependen del estado); los 400/401/403/422 de validacion no se guardan porque no aplican nada y se
recalculan igual. `Idempotency-Key` de 1 a 255 caracteres imprimibles; fuera de eso, 400
`invalid_idempotency_key`. Limpieza: politica TTL de Firestore sobre `expiresAt` (se crea con `gcloud firestore
fields ttls update`; no va en `firestore.indexes.json`). Reglas: `allow read, write: if false`.

### 2.9 Limite de tasa (RNF_04)

Ventana fija por minuto: `storeApiRateLimits/{sellerId}__{YYYYMMDDHHmm}` con `count`, incrementado en una
transaccion corta **antes** de la de escritura. Limite **120 escrituras/minuto por tienda** (la spec pide un
minimo de 60). Superado → 429 `rate_limited` con `Retry-After` = segundos hasta el siguiente minuto (minimo
1). Solo cuenta escrituras; las lecturas nuevas no se limitan en esta spec (igual que las de hoy). TTL sobre
`expiresAt` (+2 minutos). Reglas: `false`. Limite y ventana son constantes del modulo puro con prueba.

### 2.10 Lectura de un pedido sin bajar la tienda entera (RNF_05, RF_01, RF_02)

`GET /orders/{id}`: `orders/{id}` por id (404 si no existe o es de otra tienda, mismo cuerpo); asientos de la
tienda de ese pedido con `walletEntries where orderId == id` (filtrados en memoria por `ownerType ==
"seller"` y `ownerId`); cortes por `getAll` de los `settlementId` de esos asientos **mas**
`settlements where orderIds array-contains id` (lo que `buildCodReceivedSet` necesita para decidir si su
contraentrega se recibio). Con eso, `buildPaymentInfo` produce lo mismo que con la carga completa: la prueba
T8 lo ata (mismo resultado con todos los cortes que con los dirigidos, sobre fixtures con cortes ajenos,
`cashAllocations` y pedidos parcialmente cubiertos). Si al implementar `buildCodReceivedSet` necesitara algo que
`array-contains` no trae, T8 lo encuentra en rojo y se para ahi.

`GET /orders?shopifyOrderId=`: `where("sellerId","==",s).where("shopifyOrderId","==",v)` (dos igualdades:
Firestore las resuelve con los indices de un campo; T2 lo comprueba en prod con `limit(1)`). El tipo guardado
de `shopifyOrderId` se mide en T1: si hay pedidos con numero y con texto, se consulta con `in [texto, numero]`.
Formato valido: `^[0-9A-Za-z#._-]{1,64}$`; otro → 400 `invalid_shopify_order_id` (RF_03). La carga de pago
es la de arriba, por cada pedido encontrado (normalmente uno).

Las escrituras devuelven el pedido con la misma forma, armada con la misma funcion tras el commit.

## 3. Arbol de modulos

| Archivo | Cambio | Responsabilidad | Tarea |
|---|---|---|---|
| `scripts/verify-029.js` | nuevo | `baseline` (T1), `query-check` (T2), `capture-reads`/`compare-reads` (RF_20), `set-history-since` (2.4), `smoke` y `cleanup` (DoD 3) | T1, T2, T20, T21 |
| `functions/src/order-seller-actions.ts` | nuevo, **puro** | politica, `planConfirm`, `planDeliveryCorrection`, `planCancel`, `buildOrderHistoryRecord`, validacion de datos de entrega (telefono, largos, ciudad como dato) | T3, T4 |
| `functions/src/order-seller-actions-run.ts` | nuevo | ejecutor transaccional (2.2) | T5 |
| `functions/src/order-import-merge.ts` | toca | quinta entrada de `IMPORT_WRITE_EXEMPTIONS` | T5 |
| `functions/src/orders.ts` | toca | `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` delegan; historial en el resto (2.6); `getOrderAuditTrail` con 2.7 | T5, T12, T13 |
| `functions/src/order-corrections.ts` | toca | registro de historial en su batch | T13 |
| `functions/src/store-api-orders.ts` | nuevo, puro | `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` movidos tal cual desde `store-api.ts` | T8 |
| `functions/src/store-api-auth.ts` | nuevo, puro | formato de la key, huella, `resolveStoreCredentials` (tabla de 2.3), `planWriteKeyChange` | T3 |
| `functions/src/store-api-request.ts` | nuevo, puro | enrutado nuevo, parametros permitidos por ruta (RF_03), esquemas Zod de cuerpo con `.strict()`, catalogo de `code`, `buildErrorBody`, hash de cuerpo, ventana de tasa | T7 |
| `functions/src/store-api-history.ts` | nuevo, puro | `toStoreHistoryResponse` (4.3), `storeActorTag`, `storeSafeSummary`, `HISTORY_EXCLUDES` | T11, T12 |
| `functions/src/store-api-write.ts` | nuevo | handlers HTTP de las rutas nuevas, idempotencia, tasa, carga dirigida (2.10) | T9, T10, T11 |
| `functions/src/store-api-keys.ts` | nuevo | callables `rotateStoreWriteKey`, `getStoreApiKeyStatus`, `listStoreApiKeys` | T14 |
| `functions/src/store-api.ts` | toca | delega rutas nuevas a `store-api-write.ts`; autenticacion via `store-api-auth.ts`; rutas viejas con su salida identica; indice con rutas nuevas, codigos, estados editables, `historySince` y `HISTORY_EXCLUDES` | T8, T9, T11 |
| `functions/src/index.ts` | toca | exporta las tres callables nuevas | T14 |
| `firestore.rules` | toca | `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`: `allow read, write: if false` | T6 |
| `src/lib/types.ts` | toca | `OrderAuditEntry` ampliado (4.2), `StoreApiKeyStatus` | T15 |
| `src/lib/firebase/auth.ts` | toca | `fetchFirebaseOrderAuditTrail` devuelve `{ events, historySince }`; `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`, `listFirebaseStoreApiKeys` | T15 |
| `src/lib/store-api-keys-view.ts` | nuevo, puro | estados de la seccion (sin clave / recien generada / activa / error / cargando / solo lectura para el logistico), partir la key en dos lineas de 24, paginacion y busqueda del admin | T16 |
| `src/lib/order-audit-trail-view.ts` | nuevo, puro | modelo de vista del historial: pildora de origen, nombres de campo visibles, "Antes/Ahora", nota de alcance desde `historySince` | T16 |
| `src/components/store-api-write-key.tsx` | nuevo | seccion "Clave de escritura" y dialogo de rotar (un componente para tienda y admin) | T17 |
| `src/components/store-api-keys-admin.tsx` | nuevo | panel "Claves de API de tiendas" (tabla / tarjetas) | T17 |
| `src/components/order-audit-trail.tsx` | nuevo | `OrderAuditTrail` sacado de `operations-app.tsx`, con origen, cambios, nota, vacio, error con "Reintentar" | T18 |
| `src/components/operations-app.tsx` | toca | montaje; `StoreApiKeyCard` en dos secciones; `AUDIT_ACTION_LABELS` + "Datos de entrega corregidos"; `CollapsiblePanel` "?" a 44 px | T17, T18, T19 |
| `src/app/api-tiendas/page.tsx` | toca | manual: rutas, codigos, estados editables, `historySince`, exclusiones, key solo por cabecera | T22 |
| pruebas `src/lib/*.test.ts` | nuevas | ver 5.1 | todas |
| `src/lib/spec-017-guards.test.ts` | toca | guardas 3 y 7 (2.2) | T5 |
| `src/lib/spec-029-guards.test.ts` | nuevo | un `describe("T<n> · ...")` por tarea | T5-T19 |

## 4. Modelo de datos y algoritmos

### 4.1 Nucleo de acciones (`order-seller-actions.ts`)

```ts
export type SellerActionPolicy = "panel" | "api";
export type SellerActor =
  | { kind: "user"; uid: string; role: "admin" | "seller" | "seller_logistics"; sellerId?: string }
  | { kind: "api"; sellerId: string; keyLast4: string };

export type DeliveryField = "customerName" | "customerPhone" | "addressRaw" | "deliveryNotes" | "cityId";
export type DeliveryInput = Partial<Record<Exclude<DeliveryField, "deliveryNotes">, string>> & {
  deliveryNotes?: string | null;          // null = borrar las indicaciones
};

export const API_EDITABLE_STATUSES = ["imported", "address_risk", "ready_to_assign"] as const;
export const ADDRESS_DERIVED_FIELDS = ["normalizedAddress", "lat", "lng", "geoProvider"] as const;

export type SellerActionRejection =
  | { code: "order_not_found" }                                   // inexistente u otra tienda (404)
  | { code: "status_changed"; status: string }                    // expectedStatus != real (409)
  | { code: "order_cancelled"; status: "cancelled" }              // RF_06 (409)
  | { code: "address_review_pending"; status: "address_risk" }    // RF_21 (409)
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
| `address_risk` (con o sin lider) | 409 `address_review_pending` (con lider: `order_not_editable`) | error de hoy |
| `cancelled` | 409 `order_cancelled` | error de hoy |
| `ready_to_assign` o posterior, no cancelado (incluidos los finales) | 200 `changed: false`, sin evento ni historial (RF_05) | error de hoy |

**Corregir datos de entrega** (`PATCH`):

1. Tienda; `expectedStatus`.
2. API: `!isApiEditable` → 409 `order_not_editable` con `status` y `hasLeader` (cubre `in_route`,
   `call_pending`, `address_risk` con lider y finales). Panel: solo `imported` (hoy).
3. Ciudad (si viene `cityId`): `city` leido en la transaccion; ausente o `active !== true` → 422
   `out_of_coverage` (RF_10). La validacion por campo (4.4) ya se hizo fuera: si alguno falla, 422 con todos y
   ni se abre la transaccion (todo o nada, RF_09).
4. Diff campo a campo contra lo guardado, con valores recortados. `deliveryNotes: null` o `""` borra.
5. Si el estado es `address_risk` (sin lider): `status: "imported"`, `addressRisk: "review"` (RF_22), aunque
   ningun campo cambie de valor (ver pregunta abierta P1). Nunca se emite `address_risk` (invariante probada:
   ningun plan de politica `api` tiene `patch.status === "address_risk"`).
6. Si no hay cambios ni paso 5 → `unchanged`, sin escribir.
7. Si cambia `addressRaw` y la politica es `api` → `clear = ADDRESS_DERIVED_FIELDS` presentes en el pedido
   (RF_23). Politica `panel`: conserva como hoy.
8. `patch` = campos cambiados + `[MANUAL_EDIT_STAMP]: now` (RF_11) + `updatedAt`; evento
   `order.delivery_corrected` (API) / `order.imported_updated` (panel), con `fromStatus/toStatus` si cambio el
   estado; historial con cada campo y `status` si cambio.
9. Producto, cantidad, valor, pago y modo no existen en `DeliveryInput` (RF_12): mandarlos por API es 422
   `field_not_allowed` por el `.strict()` del esquema.

**Cancelar:**

| Estado real | API | Panel |
|---|---|---|
| `expectedStatus` distinto | 409 `status_changed` | — |
| `cancelled` | 200 `changed: false` (RF_15) | error de hoy |
| editable (`isApiEditable`) | → `cancelled`, `closedAt`, `callNote = reason` (obligatorio, 1-500), libera inventario si `orderOwnsInventoryReservation` y no `imported` (misma regla de hoy), evento `order.cancelled`, historial `status` | igual que hoy, con su precondicion por rol (admin cualquiera no cerrado; tienda no recogido) |
| en curso o final no cancelado | 409 `order_not_editable` (RF_14; incluye `assigned`) | como hoy |

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
  | "missing_credentials" | "invalid_key" | "write_key_in_query"
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

Codigo HTTP por `code`: 400 (`unknown_parameter`, `invalid_shopify_order_id`, `invalid_idempotency_key`,
`invalid_json`), 401 (`missing_credentials`, `invalid_key`, `write_key_in_query`), 403 (`read_only_key`), 404
(`order_not_found`), 405, 409 (`status_changed`, `order_cancelled`, `address_review_pending`,
`order_not_editable`), 422 (`validation_failed`, `field_not_allowed`, `out_of_coverage`, `no_fields`,
`idempotency_key_reused`), 429, 503 (`history_not_ready`), 500. La tabla vive en `store-api-request.ts`; una
prueba fija que ningun `code` existente cambia de nombre ni de HTTP (RNF_02: se agregan, no se renombran).

El registro de historial que sale por la API es `{ at, origin, action, changes }`: sin `actor`, sin `uid`, sin
`auditEventId` (RF_18). `toStoreHistoryResponse` es una funcion con lista explicita de claves de salida.

### 4.4 Validacion de datos de entrega (RF_09)

| Campo | Regla |
|---|---|
| `customerName` | texto, recortado 1-120 |
| `customerPhone` | quitando espacios, guiones, puntos y parentesis: 10 digitos (`^\d{10}$`), o `+57` + 10 digitos, o E.164 `^\+[1-9]\d{7,14}$`. Se guarda recortado tal como vino (no se reformatea: ChatBy compara por los ultimos 10 digitos) |
| `addressRaw` | recortado 1-300 |
| `deliveryNotes` | `null`/`""` borra; si no, 1-500 |
| `cityId` | `^[a-z0-9-]{1,64}$`; la cobertura se decide en la transaccion (RF_10) |
| cualquier otra clave | `field_not_allowed` (incluye producto, valor, pago, modo, `status`, `driverId`) |

Todos los errores se recogen a la vez (`fields`); cuerpo sin ningun campo de entrega → 422 `no_fields`. El
fallo de ciudad y el de campo salen juntos si el resto se valida: se valida primero el formato de todo y, si
pasa, la cobertura (asi el ejemplo del DoD "telefono valido + ciudad no cubierta" da 422 nombrando `cityId` y
no aplica el telefono).

### 4.5 Coste por peticion (RNF_05)

| Ruta | Lecturas | Escrituras |
|---|---|---|
| autenticacion | 1 (`storeApiConfigs/{sellerId}`) | — |
| `GET /orders/{id}` | 1 pedido + asientos del pedido (≈3-8) + cortes que lo contienen (≈1-3) | — |
| `GET /orders/{id}/history` | 1 pedido + registros (decenas) + `settings/storeApi` | — |
| escritura | tasa (1+1) + idempotencia (1) + pedido (1) + ciudad (0-1) + inventario de la tienda si libera + payload (≈10) | pedido, evento, historial, idempotencia |

Nada depende del numero de pedidos de la tienda. T21 mide p95 en produccion (objetivo < 2 s, contando arranque
en frio aparte).

## 5. Estrategia de testing

### 5.1 Mapa requisito → prueba → tarea

| Req. | Prueba | Tarea |
|---|---|---|
| RF_01 | `GET /orders/{id}` == elemento de `GET /orders` (fixtures, carga dirigida vs completa); 404 ajeno = 404 inexistente | T8, T9 |
| RF_02 | filtro por `shopifyOrderId` solo de la tienda; ignora `from`/`to`; numero repetido entre tiendas | T9 |
| RF_03 | parametro desconocido → 400 nombrandolo, en cada ruta nueva; `shopifyOrderId` mal formado → 400; rutas viejas siguen ignorando | T7 |
| RF_04, RF_05 | `planConfirm`: `imported` → `ready_to_assign` + `accepted` + `confirmedVia: "api"`; dos veces → un registro | T3, T5 |
| RF_06, RF_21 | `cancelled` → `order_cancelled`; `address_risk` → `address_review_pending` | T3 |
| RF_07, RF_08 | solo campos enviados; corregir no confirma; `in_route`, `call_pending`, `address_risk` con lider → 409 sin cambios | T4 |
| RF_09, RF_10 | tabla 4.4 entera; telefono valido + ciudad inactiva → 422 `cityId`, telefono intacto | T4 |
| RF_22 | `address_risk` sin lider → `imported` + `review`; confirmar despues → `ready_to_assign`; invariante "nunca `address_risk`" (propiedad sobre todos los estados × acciones con politica `api`) | T4 |
| RF_23 | cambio de direccion → `clear` con los cuatro campos; sin cambio de direccion → `clear` vacio | T4 |
| RF_11 | el plan lleva `MANUAL_EDIT_STAMP`; `mergeImportedOrder` sobre el resultado conserva cliente y direccion (prueba cruzada con el nucleo de la 017) | T4 |
| RF_12 | `field_not_allowed` para producto, cantidad, valor, pago, modo | T4, T7 |
| RF_13-RF_15 | cancelar editable con motivo + inventario `release`; `assigned` → 409; dos veces → un registro; sin motivo → 422 | T3, T5 |
| RF_16 | `buildOrderHistoryRecord` (diff, `null` sin cambios, campos de identidad nunca); guarda de 2.6 | T4, T13 |
| RF_17 | respuesta con `historySince`, `excludes` y `aviso`; el indice lo dice | T11 |
| RF_18 | `toStoreHistoryResponse` sin `actor`/`uid`/`auditEventId`; pedido ajeno → 404 | T11 |
| RF_19 | guarda anti-copia (5.2); condicion dentro de la transaccion; `status_changed` | T3, T5 |
| RF_20 | `compare-reads` antes/despues sobre `/resumen`, `/kpis`, `/orders`, `/settlements`, indice (sin las claves nuevas del indice) con key de lectura y con key de escritura; errores viejos con `{ ok, error }` | T8, T20, T21 |
| RF_24 | sin relleno: guarda que nada lee `auditEvents` para construir `orderHistory` | T13 |
| RF_25, RF_26 | `planWriteKeyChange`; atomicidad (transaccion con huella + auditoria); `createStoreApiKey` no toca `writeKey*` | T3, T14 |
| RF_27 | `storeActorTag`, `storeSafeSummary`; `getOrderAuditTrail` para `seller`/`seller_logistics` sin identidades y sin llamar a `getUsers`; admin igual que hoy; guarda de pantalla: `order-audit-trail.tsx` no pinta `actorEmail` cuando hay `storeActorTag` | T12, T18 |
| RNF_01 | tabla 2.3 completa | T3, T10 |
| RNF_02 | catalogo de codigos congelado; forma `{ ok:false, code, message, fields? }` | T7 |
| RNF_03 | misma key mismo cuerpo → misma respuesta sin aplicar; otro cuerpo → 422; expirado → nuevo | T10 |
| RNF_04 | ventana, 429 + `Retry-After`, nunca 403 | T7, T10 |
| RNF_05 | guarda: los handlers nuevos no contienen `where("sellerId"` sin un segundo filtro ni leen `collection("settlements").get()`; p95 medido | T9, T21 |

### 5.2 Guardas de fuente (`spec-029-guards.test.ts`, mismo patron que la 017 y la 026: fuente sin comentarios)

- **Anti-copia (RF_19):** `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`, `cancelOrder`) y
  `store-api-write.ts` llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel`; ninguno de esos cuerpos
  contiene `status: "ready_to_assign"`, `status: "cancelled"`, `addressRisk: "accepted"` ni
  `[MANUAL_EDIT_STAMP]`; mutacion comprobada a mano (pegar el parche de confirmar en `store-api-write.ts` pone
  la guarda en rojo) en `EV/mutacion-rf19.txt`.
- **Nadie mas escribe `orders`:** guarda 1 de la 017 sigue en verde; `store-api*.ts` y `store-api-keys.ts` no
  escriben pedidos (`writesOrders` de la 017 reutilizado).
- **Historial (2.6)**, **identidades (2.7)**, **`historySince` sin literal (2.4)**, **reglas** (tres
  colecciones nuevas con `allow read, write: if false`), **la key no sale** (`store-api-keys.ts` solo devuelve
  `writeKey` en `rotateStoreWriteKey` y nunca escribe `writeKey:` en Firestore; ningun `console.*`/`logger.*`
  recibe la key ni la cabecera `authorization`).
- **UI:** `operations-app.tsx` solo monta los componentes nuevos; `localStorage` no aparece en
  `store-api-write-key.tsx`; el "?" de `CollapsiblePanel` no usa `h-8 w-8` (T19).

### 5.3 Canal del cliente: verificacion contra produccion (DoD 3)

Las rutas son HTTP y la UI usa callables: se prueban **por su canal**, no reimplementando la regla en un
script (memoria "verificar por el canal del cliente").

- **Tienda de pruebas** (OPC_04, operativa): `seller-test-029` creada por `verify-029.js smoke --setup` con su
  usuario `seller` y `seller_logistics` desechables (contrasena aleatoria, nunca en la evidencia) y su ciudad
  `city-cali` (ya activa). Key de escritura generada **por la callable** con la sesion `seller`.
- **Lecturas reales** (solo lectura) contra tiendas reales con su key de lectura existente: `capture-reads`
  antes del despliegue y `compare-reads` despues (RF_20). `GET /orders/{id}` sobre 20 pedidos reales de
  Kovia, ONEP y DANDA comparados con su elemento en `GET /orders` (RF_01).
- **Escrituras solo sobre pedidos de la tienda de pruebas**, creados por `createManualOrder` con la sesion
  de la tienda: `imported` (CA_01-CA_04, RF_04/05), uno en `address_risk` (`addressRisk: "review"` +
  `confirmRetryOrder` no aplica; se crea con alta manual marcada "revisar", que hoy produce `address_risk`)
  para RF_21/22, uno tomado por un lider desechable para RF_08/RF_14, uno con inventario reservado para
  RF_13. Los CA_01-CA_12 de CENTRAL se recorren tal cual, con CA_03 corregido (confirmar `imported`).
- **RF_27 con sesion real:** `getOrderAuditTrail` con `seller` y con `seller_logistics` sobre un pedido de
  prueba con eventos de admin, de lider, de la propia tienda y de la API, **y** sobre un pedido real viejo de
  la tienda de pruebas no hay: se usa una sesion `seller` desechable con claim de una tienda real **solo en
  lectura** (la callable no escribe) para comprobar eventos historicos. E2E de `HU_05.tienda` con esa sesion:
  ningun nombre ni correo de Kentro en el DOM.
- **`cleanup`:** borra pedidos de prueba, sus `auditEvents`, `orderHistory`, `storeApiIdempotency`,
  `storeApiRateLimits`, `walletEntries` si los hubiera, inventario de prueba, usuarios y la tienda; imprime
  recuento y falla si queda algo. Es el unico codigo que borra `orderHistory`, y solo por `orderId` de prueba.
- **RF_11 con Kovia (caso limite):** ver pregunta abierta P2.

## 6. Indices

**Previstos: ninguno compuesto.** Todas las consultas nuevas son igualdad sobre un campo
(`orderHistory.orderId`, `walletEntries.orderId`, `settlements.orderIds array-contains`) o dos igualdades
(`orders.sellerId` + `orders.shopifyOrderId`), que Firestore sirve con los indices automaticos. `query-check`
(T2) ejecuta cada una con `limit(1)` en produccion **antes** de escribir el handler; si alguna pide indice, se
**anade** a `firestore.indexes.json` tras `firebase firestore:indexes` contra prod (se anaden, nunca se
reemplazan) y se despliega primero. Politicas **TTL** (no son indices): `storeApiIdempotency.expiresAt` y
`storeApiRateLimits.expiresAt`, con `gcloud firestore fields ttls update`.

## 7. Reglas de Firestore

Se anaden tres bloques, todos `allow read, write: if false`: `orderHistory`, `storeApiIdempotency`,
`storeApiRateLimits`. `settings/storeApi` hereda la regla de `settings` (comprobar en T6 que el cliente no
puede escribirlo; si la regla de `settings` lo permitiera, bloque propio `allow write: if false`). No se toca
`auditEvents` (ver P3).

## 8. Dependencias nuevas

Ninguna. `crypto` de Node (`randomBytes`, `createHash("sha256")`, `timingSafeEqual`), Zod y `firebase-admin`
ya estan.

## 9. Tareas propuestas (para `/sdd-tasks`)

| T | Que | Req. |
|---|---|---|
| T1 | `verify-029.js baseline`: tipos de `shopifyOrderId`, pedidos editables por estado y con/sin lider, `address_risk` con lider, `cities` activas, eventos historicos por accion (para la lista permitida), configs con key; confirmar que `uchat-pull`/`uchat-webhook` confirman en transaccion | todos |
| T2 | `query-check` de las consultas de 2.10 y 2.5 | RNF_05 |
| T3 | `order-seller-actions.ts` (confirmar, cancelar, politica) y `store-api-auth.ts` | RF_04-06, RF_13-15, RF_21, RF_25-26, RNF_01 |
| T4 | correccion de datos de entrega, validacion 4.4, `buildOrderHistoryRecord` | RF_07-12, RF_16, RF_22-23 |
| T5 | ejecutor, delegacion de las tres callables, quinta exencion, guardas 3 y 7 de la 017 | RF_19, RF_11 |
| T6 | reglas, `settings/storeApi`, guardas de reglas | RF_16, 2.4 |
| T7 | `store-api-request.ts`: rutas, parametros, codigos, cuerpos, tasa | RF_03, RNF_02, RNF_04 |
| T8 | `store-api-orders.ts` (movido sin cambio) + equivalencia carga dirigida/completa | RF_01, RF_20 |
| T9 | `GET /orders/{id}` y filtro `shopifyOrderId` | RF_01-03, RNF_05 |
| T10 | rutas de escritura, idempotencia, tasa | RF_04-15, RNF_01, RNF_03, RNF_04 |
| T11 | historial por API e indice | RF_17, RF_18, RF_24 |
| T12 | `getOrderAuditTrail` con 2.7 | RF_27 |
| T13 | historial en el resto de callables del panel (2.6) | RF_16 |
| T14 | callables de la key de escritura | RF_25, RF_26 |
| T15 | `types.ts` y envoltorios de `auth.ts` | HU_04, HU_05 |
| T16 | modelos de vista puros | HU_04, HU_05 |
| T17 | UI de la clave (tienda y admin) segun las ocho pantallas de HU_04 | HU_04 |
| T18 | `order-audit-trail.tsx` segun las seis pantallas de HU_05 | HU_05, RF_27 |
| T19 | `CollapsiblePanel`: el "?" mide >= 44x44 px (pendiente 3 del README) | WCAG 2.2 AA |
| T20 | `capture-reads` antes de desplegar | RF_20 |
| T21 | despliegue (seccion 10), `set-history-since`, `smoke`, `compare-reads`, p95, `cleanup` | DoD 3 |
| T22 | manual `/api-tiendas` e indice | DoD 5 |

**T19 en detalle.** `CollapsiblePanel` pinta el boton "?" con `h-8 w-8` (32 px). Se cambia a un area de
44x44 (`h-11 w-11`, conservando el icono de 16 px y el aspecto circular), sin mover el resto de la cabecera.
Comprobacion: (a) guarda de fuente: el boton de ayuda de `CollapsiblePanel` no lleva `h-8`/`w-8` y si
`h-11 w-11` (o `min-h-11 min-w-11`); la guarda de la 013 que inspecciona `function CollapsiblePanel(` sigue
en verde; (b) E2E en `/sdd-verify`: `boundingBox()` del boton "?" de Integraciones a 375 y a 1280 da
`width >= 44 && height >= 44`, igual que el boton "Cerrar" del dialogo de rotar; (c) captura en `EV/`.

## 10. Orden de despliegue

1. `capture-reads` (T20) con las keys de lectura actuales.
2. Reglas (`orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`).
3. Indices solo si T2 los pidio (comparando con prod) y esperar `READY`; politicas TTL.
4. Functions: `storeApi`, las callables tocadas de `orders.ts` y `order-corrections.ts`, y las tres nuevas,
   con `ALLOW_FUNCTIONS_DEPLOY=1` tras `npm run build` y `firebase functions:list`. Humano (principio 7).
5. `verify-029.js set-history-since` (una vez; `create`).
6. Hosting (`npm run lint`, `static{` = 0, `ALLOW_FUNCTIONS_DEPLOY=1`).
7. `smoke`, `compare-reads`, p95, E2E de HU_04/HU_05, `cleanup`.
8. Entregar la key de escritura a CENTRAL: la genera la tienda (Kovia/ONEP) desde su panel o el admin, y se
   entrega por canal seguro (README, decision 4).

## 11. Riesgos

| Riesgo | Mitigacion |
|---|---|
| La API confirma o corrige un pedido que ya tomo un lider (clobber) | condicion dentro de la transaccion; `driverId` en la definicion de editable; prueba de carrera simulada con dos planes sobre el mismo pedido |
| Copiar la regla de confirmar/cancelar en la API | nucleo + ejecutor unicos; guarda anti-copia con mutacion |
| Historial falsificable | coleccion solo de servidor (2.5) |
| Identidades de Kentro a la tienda por `summary` viejos | lista permitida, no prohibida (2.7) |
| La key de escritura en logs o en `localStorage` | guardas 5.2; solo cabecera |
| Rotacion a medias que deja a la integracion sin key | transaccion huella + auditoria; la key se devuelve tras el commit |
| `GET /orders/{id}` distinto del elemento de `GET /orders` | misma funcion movida; equivalencia de carga dirigida; comparacion en prod sobre 20 pedidos |
| Romper integraciones de lectura | rutas viejas sin cambio interno; `compare-reads` antes/despues |
| Doble aplicacion por reintento de CENTRAL | `Idempotency-Key` en la misma transaccion |
| ChatBy reescribe una direccion corregida por API | aceptado por la spec (caso limite); advertido en `aviso` y en el manual; spec 031 |
| Coste del limite de tasa (1 escritura por peticion) | ~120/min por tienda en el peor caso; TTL limpia |

## 12. Preguntas abiertas

- **P1 — `address_risk` corregido sin cambiar nada.** Una correccion valida cuyos valores son los ya
  guardados sobre un `address_risk` sin lider: ¿lo devuelve a `imported` (lectura literal de RF_22: "datos
  que pasan RF_09 y RF_10") o responde `changed: false` y lo deja en revision? Propuesta del plan: **lo
  devuelve a `imported`**, porque CENTRAL ya hablo con el cliente y la decision 2 dice que la API no juzga
  direcciones; la confirmacion sigue siendo aparte. Si el responsable prefiere exigir al menos un campo
  distinto, cambia una linea de la tabla 4.1 y su prueba.
- **P2 — Reimportacion con un pedido real de Kovia (caso limite y DoD 1, RF_11).** Kovia entra por
  `shopifyWebhook`; reproducir su reimportacion contra produccion exige escribir sobre un pedido real de Kovia
  o firmar un webhook con el secreto de Shopify dirigido a la tienda de pruebas. Propuesta: (a) prueba unitaria
  con el **documento real** de un pedido de Kovia copiado en solo lectura como fixture, pasado por
  `planDeliveryCorrection` y despues por `mergeImportedOrder` con su payload de Shopify real; y (b) en prod,
  replay firmado del webhook hacia la tienda de pruebas con un pedido sintetico con forma de Kovia. ¿Se acepta
  (a)+(b) en lugar de tocar un pedido real de Kovia?
- **P3 — `auditEvents` acepta `create` de cualquier sesion.** No es de esta spec (el historial nuevo no
  depende de ella), pero hoy cualquier usuario puede escribir un evento en el "Historial del pedido" de otra
  tienda, y con RF_27 la tienda lo veria como "Kentro". ¿Se abre una spec aparte para cerrarlo
  (`allow create: if false`, tras comprobar que ningun cliente lo usa) o se incluye aqui como cambio de
  reglas? Propuesta: spec aparte, para no ampliar el alcance aprobado.
- **P4 — Ciudades validas para CENTRAL.** Hoy la unica ciudad de importacion es `city-cali` y `GET /coverage`
  (OPC_03) esta fuera de alcance. El manual listara los `cityId` activos a mano en la fecha de entrega.
  ¿Suficiente?
- **P5 — Limite de tasa.** El plan fija 120 escrituras/minuto por tienda (minimo de la spec: 60). Confirmar la
  cifra con lo que CENTRAL espera en picos.
