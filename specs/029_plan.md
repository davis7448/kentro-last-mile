# Plan tecnico — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API, sin pisar lo operado

- **Spec:** `specs/029_store_api_confirma_y_corrige_pedidos.md` — **aprobada el 2026-10-04** (decisiones 1-9,
  seccion 9).
- **Fecha:** 2026-10-04. Preguntas del plan resueltas el mismo dia por el orquestador, por delegacion del
  responsable (seccion 12). Precisado tras tres pasadas de `/sdd-analyze` el mismo dia (seccion 13).
- **Diseno:** `specs/design/029_store_api_confirma_y_corrige_pedidos/` (README + 14 pantallas observadas):
  - HU_04 (clave de escritura): `HU_04.tienda-sin-clave`, `HU_04.tienda-recien-generada`, `HU_04.tienda-activa`,
    `HU_04.tienda-rotar`, `HU_04.tienda-error`, `HU_04.admin-lista`, `HU_04.admin-lista-movil`,
    `HU_04.admin-recien-generada`;
  - HU_05 (historial): `HU_05.tienda`, `HU_05.tienda-escritorio`, `HU_05.admin`, `HU_05.admin-escritorio`,
    `HU_05.vacio`, `HU_05.error`.
  Este plan no decide textos ni disposicion: los toma del README. Sus tres pendientes "fuera del diseno" se
  resuelven aqui (2.10 → 2.4, 2.3 y T23).
- **Tareas:** `specs/029_tasks.md` (T1-T27, con T6 partida en T6 y T6b). Toda referencia a una tarea en este
  plan usa esa numeracion.
- **Evidencia:** `.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).
- **Specs relacionadas:** 030 (webhook firmado) reutilizara `orderHistory` como fuente de eventos; 031 anadira
  los origenes `shopify` y `chatby` al mismo registro; **032** (borrador, prioridad alta,
  `specs/032_auditoria_solo_la_escribe_el_servidor.md`) cierra el `create` de cliente en `auditEvents` y estudia
  `operationalOrderUpdateByAssignee` (1). Hasta la 032, este plan aplica la mitigacion de 2.7.

### Preguntas del plan: resueltas (2026-10-04)

| Pregunta | Respuesta aplicada |
|---|---|
| P1 — `address_risk` corregido con valores identicos | Vuelve a `imported` igual: es la unica forma de que CENTRAL lo desbloquee (confirmarlo da 409). Historial con accion `order.address_reviewed` ("direccion revisada"), solo el cambio de `status`, sin campos de entrega (4.1) |
| P2 — Kovia y RF_11 | Fixture con la forma de un pedido real de Kovia (datos sinteticos) + replay firmado de un webhook de Shopify, con tienda de Shopify e id **sinteticos**, hacia la tienda de pruebas (5.3) |
| P3 — `auditEvents` con `create` abierto | Spec aparte de prioridad alta: 032 (borrador). En la 029, mitigacion explicita: a la tienda solo le llegan eventos con actor verificable o de accion permitida (2.7); los demas dejan de verse para la tienda (RF_27) |
| P4 — ciudades | Manual con las ciudades activas; el 422 `out_of_coverage` trae la lista de ciudades activas (4.3) |
| P5 — limite de tasa | 120 escrituras/minuto por tienda, constante con nombre en un solo modulo (2.9); "a confirmar con CENTRAL" en riesgos |

## 1. Lo que hay hoy (leido en el codigo, no supuesto)

| Donde | Que hace | Consecuencia para la 029 |
|---|---|---|
| `functions/src/store-api.ts` `storeApi` | `onRequest`, solo `GET`; autentica `sellerId` + key (query o Bearer) contra `storeApiConfigs.apiKey` en claro con `safeEqual`; **lee todos los pedidos de la tienda** antes de mirar la ruta (salvo `docs`); `/orders` lee ademas `walletEntries` de la tienda y **`settlements` entera** | Las rutas nuevas no pueden pasar por esa carga (RNF_05). Las existentes no se tocan por dentro (RF_20): se extraen sus funciones de forma sin cambiar su salida, y su autenticacion pasa por `resolveStoreCredentials` (T10) |
| `store-api.ts` `orderPayload`, `classifyOrder`, `buildPaymentInfo` | forma de un elemento de `GET /orders` | RF_01 exige el mismo esquema: se mueven a un modulo puro y las dos rutas las llaman (no se copian) |
| `store-api.ts` `createStoreApiKey` | `admin`/`seller`; devuelve la key de lectura completa cada vez; audita `store_api_key.viewed/created` | Se queda igual (RF_26). La de escritura va por callables nuevas |
| `orders.ts` `confirmImportedOrder` | transaccion; solo `imported`; `addressRisk: "accepted"`, `confirmedVia: "manual"`, audita `order.seller_confirmed` con `fromStatus/toStatus` | Nucleo compartido de confirmar (2.2) |
| `orders.ts` `updateImportedOrder` | solo `imported`; pedido entero (cliente, direccion, pago, modo, valor, producto/`lineItems`, zona...); `[MANUAL_EDIT_STAMP]: now`; **conserva** `normalizedAddress` si no viene (spec 013) y las indicaciones si vienen en blanco; audita sin campos ni valores | Nucleo compartido de datos de entrega con politica `panel` que acepta esos campos extra (2.2, 4.1); el panel sigue con su precondicion y sus campos (seccion 7 de la spec) |
| `orders.ts` `cancelOrder` | cualquier no cerrado; la tienda no puede si esta recogido; libera inventario si reservo y no es `imported`; motivo opcional a `callNote`; error si ya `cancelled` | Nucleo compartido de cancelar con dos politicas (panel / api) |
| `orders.ts` `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder`, `assignMessengerToOrders`, `unassignMessengerFromOrders`, `createOrUpdatePickupBatch`; `order-corrections.ts` `correctOrderStatus` | cambian estado (o, el ajuste, producto/recaudo). `createOrUpdatePickupBatch` **no audita** | Todas escriben historial (RF_16, 2.6) |
| `orders.ts` `getOrderAuditTrail` | lee `auditEvents` por `entityId`; resuelve uid → nombre y correo con `getUsers` **para cualquier rol**; al `seller_logistics` le filtra acciones financieras | RF_27: el filtrado de identidades va en el servidor (2.7) |
| `firestore.rules` `auditEvents` | `allow create: if signedIn()` | **Cualquier sesion puede crear un evento con el `entityId` de un pedido ajeno.** No sirve como historial que la API ensena a una tienda (RF_18): el historial campo a campo va a una coleccion nueva solo de servidor (2.5); el cierre de la regla es la spec 032 |
| `firestore.rules` `operationalOrderUpdateByAssignee` (l. ~122) | el lider o el mensajero asignados cambian desde el cliente `status` entre `assigned`, `call_pending`, `scheduled`, `picked_up`, `in_route`, `retry_pending` (y campos de llamada y agenda) | **Esos cambios no escriben `orderHistory`**: limite conocido de RF_16, trasladado a la 032 (seccion 1.1 y RF_07 de su borrador). Esta spec no toca la regla |
| `firestore.rules` `settings/{settingId}` (l. ~145) | `allow read: if signedIn(); allow write: if isAdmin();` | Un admin podria escribir `settings/storeApi` desde el cliente y mover `historySince`. Se acota a `allow write: if isAdmin() && settingId != "storeApi"` (2.4, 7, T7) |
| `firestore.rules` `storeApiConfigs` | `allow read, write: if false` | La huella de la key de escritura vive ahi (2.3) |
| `order-import-merge.ts` | `MANUAL_EDIT_STAMP`, `CLOSED_STATUSES`, `IMPORT_WRITE_EXEMPTIONS` (cuatro) | RF_11 usa la constante; el ejecutor nuevo es la quinta exencion (2.2, T6) |
| `src/lib/spec-017-guards.test.ts` | guarda 1 (quien escribe `orders`), guarda 3 (**exactamente cuatro** exenciones), guarda 7 (**exactamente dos** `[MANUAL_EDIT_STAMP]:` en `orders.ts`) | T6 actualiza guarda 3 (cinco, al nacer el ejecutor) y T6b guarda 7 (cuenta en `orders.ts` + nucleo, al delegar `updateImportedOrder`), con la razon en el propio test |
| `src/components/operations-app.tsx` `CollapsiblePanel` (l. 1105), `OrderAuditTrail` (l. 2091), `AUDIT_ACTION_LABELS` (l. 2053), `StoreApiKeyCard` (l. 11162) | el "?" mide `h-8 w-8`; el historial pinta `actorLabel`/`actorEmail`/`actorRole` a todos y no reintenta | HU_04 y HU_05 (T18 adapta el uso de `fetchFirebaseOrderAuditTrail`; T20-T23) |
| `cities` | `{ active }`; todas las importaciones escriben `cityId: "city-cali"` | RF_10 lee `cities/{cityId}` dentro de la transaccion; el 422 lista las activas |

## 2. Decisiones de diseno

### 2.1 Superficie HTTP nueva (dentro de la misma funcion `storeApi`)

| Metodo y ruta | Key | Cuerpo | Exito |
|---|---|---|---|
| `GET /orders/{id}` | lectura o escritura | — | 200 `{ ok: true, pedido }` (mismo esquema que un elemento de `GET /orders`) |
| `GET /orders?shopifyOrderId=` | lectura o escritura | — | 200, forma de `GET /orders` (RF_02); ignora `from`/`to`; aplica `status` y `limit` |
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
escrituras (2.9) → cuerpo (4.4: se separa `expectedStatus`; se recogen a la vez los campos no permitidos y los
invalidos; 422 con todos, `field_not_allowed` de primer nivel si hay alguno no permitido, si no
`validation_failed`) → **atajo** de idempotencia (2.8: lectura previa fuera de la transaccion, solo para
responder pronto un `replay` o un `conflict` evidentes) → transaccion (2.2), **dentro de la cual se vuelve a leer
el registro idempotente y se toma la decision que vale**. En una ruta de escritura, `key` no es un parametro
desconocido: es una credencial en el sitio prohibido, y responde 401 `key_in_query` (2.3), no 400.

### 2.2 Un nucleo puro y un ejecutor transaccional compartidos por panel y API (RF_19, regla de oro 1)

Tres piezas, para que ninguna regla exista dos veces:

1. **`functions/src/order-seller-actions.ts` — puro** (sin `firebase-admin`). Decide, no escribe:
   `planConfirm`, `planDeliveryCorrection`, `planCancel` (4.1). Cada uno recibe el pedido leido, la politica
   (`"panel"` o `"api"`), la entrada ya validada, el actor y `now`, y devuelve o un **rechazo tipado** o un
   **plan**: el parche del pedido, las claves a borrar (`clear`), el evento de auditoria y el registro de
   historial. Importa `MANUAL_EDIT_STAMP` y `CLOSED_STATUSES` de `order-import-merge.ts`. **El sello
   `MANUAL_EDIT_STAMP` lo pone siempre el nucleo**, en las dos politicas.
2. **`functions/src/order-seller-actions-run.ts` — ejecutor.** Una funcion por accion
   (`runConfirm`, `runDeliveryCorrection`, `runCancel`): abre la transaccion, lee el pedido (y, si toca, la
   ciudad, el inventario y el registro de idempotencia), llama al planificador **dentro** de la transaccion,
   aplica `plan.patch` con `merge`, borra `plan.clear` con `FieldValue.delete()`, mueve inventario con
   `applyInventoryMovements` (el mismo de `cancelOrder`), escribe el evento, el historial y, en la API, la
   respuesta idempotente. Devuelve `{ kind: "rejected", rejection } | { kind: "applied" | "unchanged", order }`.
   No sabe de HTTP ni de `HttpsError`. **Si el plan rechaza, no escribe nada en `orders`, `auditEvents` ni
   `orderHistory`.** En la API, un rechazo de estado (409) si deja el registro idempotente (2.8), y es lo unico
   que escribe.
3. **Adaptadores.** Las callables de `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`,
   `cancelOrder`) y las rutas de `store-api-write.ts` traducen la entrada a la del ejecutor y el rechazo a su
   canal (`HttpsError` con los mismos codigos y mensajes de hoy en el panel; `{ ok:false, code, message }` en la
   API). **Ningun adaptador escribe en el pedido**, ni el sello ni ningun otro campo.

**Que se comparte y que no.** El panel y la API comparten: el chequeo de tienda, el parche de confirmar, el
constructor de datos de entrega (recorte, sello `MANUAL_EDIT_STAMP`, diff para el historial), la liberacion
de inventario, la auditoria y el historial. Lo que difiere es **politica declarada en una tabla del nucleo**
(4.1), no codigo duplicado: precondiciones (panel: confirmar/editar solo `imported`; API: editable segun el
glosario), `confirmedVia` (`manual` / `api`), RF_05/RF_15 (no-op en API, error en panel como hoy), RF_23 (la
API borra lo derivado de la direccion; el panel conserva `normalizedAddress` como hoy, spec 013), las
indicaciones en blanco (`deliveryNotes` `""`/`null` **borra solo con politica `api`**; en el panel, unas
indicaciones en blanco se conservan como hoy) y el motivo de cancelar (obligatorio 1-500 en API, opcional en
panel).

**Campos extra del panel.** `updateImportedOrder` edita hoy, ademas de los datos de entrega, producto
(`lineItems` y sus derivados), pago, modo, valor, zona, `normalizedAddress` y el resto de campos que hoy
escribe. Con politica `panel`, `planDeliveryCorrection` acepta esos campos en `panelExtras` (4.1): **cuentan
como cambio**, se aplican siempre como hoy (el panel escribe el pedido entero en cada guardado), llevan
`MANUAL_EDIT_STAMP` y auditoria `order.imported_updated`, y el historial registra los que estan en 2.5
(`totalCop`, `productName`, `sku`, `quantity`; RF_16). El adaptador del panel solo traduce la entrada a
`panelExtras` (incluido `resolveEditedOrderLines`, intacto); el nucleo los mete en el parche junto con el sello.
Asi una edicion del panel solo de producto sigue sellando el pedido (la reimportacion no la pisa, spec 017) y la
guarda anti-copia (ningun adaptador contiene el sello) se cumple. Con politica `api`, `panelExtras` no existe: la
validacion de cuerpo lo rechaza antes (RF_12).

**Escritura en `orders` fuera de `orders.ts`.** `order-seller-actions-run.ts` escribe pedidos, asi que entra
como **quinta exencion** en `IMPORT_WRITE_EXEMPTIONS`, con la razon: "Confirmar, corregir datos de entrega y
anular por decision de la tienda o de la plataforma, por panel o por API; nunca crea pedidos ni toca lider,
mensajero ni catalogo". `store-api*.ts` **no** escribe `orders`: solo llama al ejecutor. Guarda 3 de la 017
pasa de cuatro a cinco (T6) y guarda 7 cuenta el sello en `orders.ts` (ajustes, 1) + `order-seller-actions.ts`
(datos de entrega, 1), con constante y sin literal (T6b).

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
- **Resolucion de credenciales** (pura, `store-api-auth.ts`, T3). La usan **todas** las rutas, tambien las
  viejas: `store-api.ts` deja su comparacion propia y llama a `resolveStoreCredentials`, conservando la forma de
  error `{ ok: false, error }` de las rutas viejas (conexion y prueba del handler viejo con `db` falso en T10).
  Las filas se evaluan **en este orden**; la primera que aplica decide:

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

- **Nadie lo escribe desde el cliente.** La regla general de `settings` (`allow write: if isAdmin()`) se acota a
  `allow write: if isAdmin() && settingId != "storeApi"`: ni un admin puede moverlo desde la app; solo el Admin
  SDK del guion (T7, seccion 7).
- `GET /orders/{id}/history`, `getOrderAuditTrail` y el indice de la API lo leen de ahi.
- Sin el documento, `GET /orders/{id}/history` responde 503 `history_not_ready` (probado en T13) y
  `getOrderAuditTrail` devuelve `historySince: null` (la UI no pinta la nota de alcance con fecha inventada; ver
  T19 y T22). Es una ventana de minutos entre functions y el script; la escritura de historial **no** depende del
  dato (registra siempre).
- Guarda (T7): ninguna fuente de `functions/src` ni de `src/` contiene un literal de fecha de 2026-10 asociado
  a `historySince`.

### 2.5 Historial: coleccion propia, solo de servidor (RF_16, RF_18, RF_24)

`orderHistory/{autoId}`, un documento **por escritura** (no por campo) con la lista de cambios. Reglas
`allow read, write: if false`: solo el Admin SDK la escribe y la lee, por eso no se puede falsificar como hoy
`auditEvents`. Nunca se actualiza ni se borra (tampoco desde codigo: la guarda de T7 comprueba que ninguna
fuente hace `update`/`delete` sobre `orderHistory`), **salvo la excepcion declarada en RF_16**: el `cleanup`
del guion de verificacion (T25, T27) borra el historial solo de los pedidos de prueba que la verificacion creo.

- Campos registrados: `status` y los datos de entrega (`customerName`, `customerPhone`, `addressRaw`,
  `deliveryNotes`, `cityId`); en el ajuste del admin y en la edicion del panel, ademas `totalCop`,
  `productName`, `sku`, `quantity` (RF_16). **Nunca** `driverId`, `messengerId`, `pickupBatchId` ni nada que
  identifique a una persona de Kentro: el registro dice "paso a `call_pending`", no quien lo tomo.
- Un registro sin cambios no se escribe (RF_05, RF_15: confirmar o cancelar dos veces deja un solo registro).
- Cada registro guarda `auditEventId`: el evento de `auditEvents` de la misma escritura. `getOrderAuditTrail`
  une los dos por ese id (2.7) en vez de duplicar datos. Ese enlace es tambien lo que hace **verificable** un
  evento: solo el servidor puede escribir un `orderHistory` que lo apunte.
- No hay reconstruccion (RF_24): no existe relleno; un pedido viejo devuelve `[]` hasta su primer cambio.
- Lectura: `where("orderId", "==", id).limit(200)`, orden en memoria por `createdAt` (indice automatico de un
  campo, como hoy `auditEvents`). Se comprueba antes que el pedido es de la tienda (RF_18; pedido ajeno → 404,
  probado en T13); el registro lleva `sellerId` para comprobarlo dos veces.
- **Hueco declarado (limite conocido de RF_16):** las escrituras directas de `status` del lider y del mensajero
  que permite `operationalOrderUpdateByAssignee` no pasan por ninguna callable y no dejan registro. No se cierra
  aqui: spec 032 (1.1, RF_07 de su borrador).

### 2.6 Que callables del panel escriben historial (RF_16)

Un solo constructor, `buildOrderHistoryRecord(before, after, meta)` (en el nucleo puro), que hace el diff de
los campos de 2.5 y devuelve `null` si no hay cambios. Lo llaman, dentro de su transaccion o batch (esta tabla
es la misma lista que enumera RF_16 en la spec):

| Callable | Accion | Origen | Tarea |
|---|---|---|---|
| `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` | via el ejecutor (2.2) | `panel` | T6b |
| `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder` | anaden la escritura del registro junto a su evento | `panel` | T15 |
| `assignMessengerToOrders`, `unassignMessengerFromOrders` | cambian `picked_up`↔`call_pending`; solo `status` | `panel` | T16 |
| `createOrUpdatePickupBatch` | `→ picked_up`; hoy sin auditoria: se le anade evento `order.picked_up` y registro | `panel` | T16 |
| `correctOrderStatus` (`order-corrections.ts`) | en su batch | `panel` | T16 |
| rutas de escritura de la API | via el ejecutor | `api` | T11 |

**Exclusiones explicitas** (no registran historial, cada una con su razon):

| Excluida | Razon |
|---|---|
| `createManualOrder` | crea el pedido con su `status` inicial; RF_16 cubre cambios de un pedido existente |
| las cinco vias de importacion: `shopify.ts` (importacion manual y sincronizacion historica), `index.ts` (`shopifyWebhook`), `store-webhook.ts`, `onstock-webhook.ts`, `contact-form.ts` | crean pedidos y, al reimportar, quedan fuera por la spec (031) |
| `uchat-pull.ts`, `uchat-webhook.ts` | ChatBy, fuera por la spec (031) |
| `classifyFailedOrder` | no cambia estado ni datos de entrega |
| escrituras directas del cliente bajo `operationalOrderUpdateByAssignee` | no son codigo de servidor (no las ve la guarda de `functions/src`); limite conocido de RF_16, spec 032 |

Guarda (T16): cada callable de la tabla contiene `buildOrderHistoryRecord(` en su cuerpo; la lista de
callables y modulos de `functions/src` que escriben `status` en un pedido es igual a **tabla + exclusiones**,
y las exclusiones viven en la guarda como lista explicita con su razon. Una callable nueva que cambie estado y
no este en ninguna de las dos pone la suite en rojo.

### 2.7 Lo que ve la tienda en "Historial del pedido" (RF_27, decisiones 11-12 del diseno)

`getOrderAuditTrail` pasa a devolver `{ events, historySince }` y cada evento lleva `origin`, `changes` (si
hay registro con ese `auditEventId`) y, segun el rol de quien pregunta:

- **admin:** como hoy (`actorLabel`, `actorEmail`, `actorRole`) + `origin` (`panel` | `api`) +, para la API,
  `apiKeyLast4` y `actorLabel` "Clave de escritura de <tienda>" (probado en T14). El lider y el mensajero siguen
  como hoy (fuera de alcance de RF_27).
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
createdAt, expiresAt }`. **La decision que vale se toma dentro de la transaccion** de la escritura: alli se lee
el registro, se decide `replay | conflict | fresh` y, si es `fresh`, se aplica el cambio y se guarda la
respuesta en la misma transaccion: o las dos cosas, o ninguna. Antes de abrirla, el handler **puede** leer el
registro fuera de la transaccion (2.1) **solo como atajo**, para responder pronto un `replay` o un `conflict`
sin abrirla; si ese atajo dice `fresh` (o el registro aun no existe), no decide nada: la transaccion vuelve a
leer y manda. Asi dos peticiones simultaneas con la misma key no pueden aplicar dos veces.

Misma key y mismo `sha256(metodo + ruta + cuerpo canonico)` en 24 h → la respuesta guardada, sin tocar nada.
Misma key con otro hash → 422 `idempotency_key_reused`. Expirado (`expiresAt < now`) → como nuevo. Se guardan
las respuestas 200 y 409 (las que dependen del estado; en un 409 el registro idempotente es la unica escritura,
2.2); los 400/401/403/422 de validacion no se guardan porque no aplican nada y se recalculan igual.
`Idempotency-Key` de 1 a 255 caracteres imprimibles; fuera de eso, 400 `invalid_idempotency_key`. Limpieza:
politica TTL de Firestore sobre `expiresAt` (se crea con `gcloud firestore fields ttls update`; no va en
`firestore.indexes.json`). Reglas: `allow read, write: if false`.

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

**Supuesto medido en produccion:** la consulta `array-contains` sobre `orderIds` solo es suficiente si ningun
corte referencia un pedido en `cashAllocations[].orderId` sin tenerlo en `orderIds`. T1 lo cuenta en
produccion (esperado 0) y T2 deja el recuento junto a su `query-check`, ambos en la evidencia. Si sale mayor que
0, T9/T10 se paran y la carga dirigida anade la busqueda por `cashAllocations` antes de seguir.

`GET /orders?shopifyOrderId=` (ruta **existente**, con su forma de error de hoy):
`where("sellerId","==",s).where("shopifyOrderId","==",v)` (dos igualdades: Firestore las resuelve con los
indices de un campo; T2 lo comprueba en prod con `limit(1)`). El tipo guardado de `shopifyOrderId` se mide en
T1: si hay pedidos con numero y con texto, se consulta con `in [texto, numero]`. Formato valido:
`^[0-9A-Za-z#._-]{1,64}$`; otro → 400 con la **forma vieja** `{ ok: false, error: "invalid_shopify_order_id" }`
(RF_03, RF_20; no la de las rutas nuevas). El validador es puro y vive en `store-api-request.ts` (T8); el handler
(T10) solo lo llama. `from`/`to` se ignoran con el filtro; **`status` y `limit` se aplican** sobre los pedidos
encontrados, igual que hoy sobre la lista completa (RF_02). La carga de pago es la de arriba, por cada pedido
encontrado (normalmente uno). T10 prueba el handler con un `db` falso en memoria: solo pedidos de la tienda de la
key, `from`/`to` ignorados, `status`/`limit` aplicados, numero repetido en otra tienda fuera, 400 con forma vieja
y 404 identico para ajeno e inexistente.

Las escrituras devuelven el pedido con la misma forma, armada con la misma funcion tras el commit.

## 3. Arbol de modulos

| Archivo | Cambio | Responsabilidad | Tarea |
|---|---|---|---|
| `scripts/verify-029.js` | nuevo | `baseline` (T1), `query-check` (T2), `capture-reads`/`compare-reads` (RF_20, T24), `kovia-replay` y su limpieza (T25), `set-history-since` (2.4), `smoke` y `cleanup` (DoD 3, T27) | T1, T2, T24, T25, T27 |
| `functions/src/order-seller-actions.ts` | nuevo, **puro** | politica, `planConfirm`, `planDeliveryCorrection` (con `panelExtras` en politica `panel`), `planCancel`, `buildOrderHistoryRecord`, `validateDeliveryInput` (reglas de contenido) | T4, T5 |
| `functions/src/order-seller-actions-run.ts` | nuevo | ejecutor transaccional (2.2); registro idempotente dentro de su transaccion | T6, T12 |
| `functions/src/order-import-merge.ts` | toca | quinta entrada de `IMPORT_WRITE_EXEMPTIONS` | T6 |
| `functions/src/orders.ts` | toca | `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` delegan; historial en el resto (2.6); `getOrderAuditTrail` con 2.7 | T6b, T14, T15, T16 |
| `functions/src/order-corrections.ts` | toca | registro de historial en su batch | T16 |
| `functions/src/store-api-orders.ts` | nuevo, puro | `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` movidos tal cual desde `store-api.ts` | T9 |
| `functions/src/store-api-auth.ts` | nuevo, puro | formato de la key, huella, `resolveStoreCredentials` (tabla de 2.3), `planWriteKeyChange` | T3 |
| `functions/src/store-api-request.ts` | nuevo, puro | enrutado nuevo, parametros permitidos por ruta (RF_03), validador de `shopifyOrderId`, esquemas Zod de forma y tipos, separacion de `expectedStatus`, recogida conjunta de campos no permitidos e invalidos con su prioridad de `code`, motivo de cancelar, catalogo de `code`, `buildErrorBody`, hash de cuerpo, `STORE_API_WRITES_PER_MINUTE` y ventana, `decideIdempotency` | T8, T12 |
| `functions/src/store-api-history.ts` | nuevo, puro | `toStoreHistoryResponse` (4.3), `storeActorTag`, `storeSafeSummary`, `isStoreVisibleEvent`, `HISTORY_EXCLUDES` | T13, T14 |
| `functions/src/store-api-write.ts` | nuevo | handlers HTTP de las rutas nuevas, idempotencia, tasa, carga dirigida (2.10), lista de ciudades activas del 422 | T10, T11, T12, T13 |
| `functions/src/store-api-keys.ts` | nuevo | callables `rotateStoreWriteKey`, `getStoreApiKeyStatus`, `listStoreApiKeys` | T17 |
| `functions/src/store-api.ts` | toca | handler con `db` inyectable; delega rutas nuevas a `store-api-write.ts`; autenticacion de todas las rutas via `resolveStoreCredentials`; rutas viejas con su salida identica; filtro `shopifyOrderId` con forma de error vieja; indice con rutas nuevas, codigos, estados editables, `historySince` y `HISTORY_EXCLUDES` | T9, T10, T11, T13 |
| `functions/src/index.ts` | toca | exporta las tres callables nuevas | T17 |
| `firestore.rules` | toca | `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`: `allow read, write: if false`; `settings`: `allow write: if isAdmin() && settingId != "storeApi"` | T7 |
| `src/lib/types.ts` | toca | `OrderAuditEntry` ampliado (4.2), `StoreApiKeyStatus` | T18 |
| `src/lib/firebase/auth.ts` | toca | `fetchFirebaseOrderAuditTrail` devuelve `{ events, historySince }`; `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`, `listFirebaseStoreApiKeys` | T18 |
| `src/lib/store-api-keys-view.ts` | nuevo, puro | estados de la seccion (sin clave / recien generada / activa / error / cargando / solo lectura para el logistico), partir la key en dos lineas de 24, paginacion y busqueda del admin | T19 |
| `src/lib/order-audit-trail-view.ts` | nuevo, puro | modelo de vista del historial: pildora de origen, nombres de campo visibles, "Antes/Ahora", nota de alcance desde `historySince` | T19 |
| `src/components/store-api-write-key.tsx` | nuevo | seccion "Clave de escritura" y dialogo de rotar (un componente para tienda y admin) | T20 |
| `src/components/store-api-keys-admin.tsx` | nuevo | panel "Claves de API de tiendas" (tabla / tarjetas) | T21 |
| `src/components/order-audit-trail.tsx` | nuevo | `OrderAuditTrail` sacado de `operations-app.tsx`, con origen, cambios, nota, vacio, error con "Reintentar" | T22 |
| `src/components/operations-app.tsx` | toca | adaptacion del uso de `fetchFirebaseOrderAuditTrail` a `{ events, historySince }` (T18); montaje; `StoreApiKeyCard` en dos secciones; `AUDIT_ACTION_LABELS` + "Datos de entrega corregidos", "Direccion revisada" y "Recogido"; `CollapsiblePanel` "?" a 44 px | T18, T20, T21, T22, T23 |
| `src/app/api-tiendas/page.tsx` | toca | manual: rutas, codigos, estados editables, `historySince`, exclusiones, key solo por cabecera, ciudades activas | T26 |
| `src/lib/fixtures/029-kovia-order.json` | nuevo | fixture con la forma de Kovia, datos personales e id de Shopify sinteticos (P2) | T25 |
| pruebas `src/lib/*.test.ts` | nuevas | ver 5.1; el ejecutor tiene la suya, `src/lib/order-seller-actions-run.test.ts` (T6, T12) | todas |
| `src/lib/spec-017-guards.test.ts` | toca | guarda 3 (T6) y guarda 7 (T6b) (2.2) | T6, T6b |
| `src/lib/spec-029-guards.test.ts` | nuevo | un `describe("T<n> · ...")` por tarea | T1-T27, T6b |

## 4. Modelo de datos y algoritmos

### 4.1 Nucleo de acciones (`order-seller-actions.ts`)

```ts
export type SellerActionPolicy = "panel" | "api";
export type SellerActor =
  | { kind: "user"; uid: string; role: "admin" | "seller" | "seller_logistics"; sellerId?: string }
  | { kind: "api"; sellerId: string; keyLast4: string };

export type DeliveryField = "customerName" | "customerPhone" | "addressRaw" | "deliveryNotes" | "cityId";
export type DeliveryInput = Partial<Record<Exclude<DeliveryField, "deliveryNotes">, string>> & {
  deliveryNotes?: string | null;          // api: null o "" = borrar (RF_09); panel: en blanco = conservar (hoy)
};

// Solo politica "panel": lo que hoy edita updateImportedOrder ademas de los datos de entrega, con los
// mismos nombres de campo que escribe hoy. El adaptador lo arma (lineItems ya resueltos con
// resolveEditedOrderLines); el nucleo lo mete en el parche con el sello.
export type PanelEditExtras = {
  lineItems?: unknown[]; productName?: string; sku?: string; quantity?: number;
  paymentMethod?: string; dispatchMode?: string; totalCop?: number;
  zoneId?: string | null; normalizedAddress?: string | null;
  [otherFieldWrittenTodayByUpdateImportedOrder: string]: unknown;
};

export const API_EDITABLE_STATUSES = ["imported", "address_risk", "ready_to_assign"] as const;
export const ADDRESS_DERIVED_FIELDS = ["normalizedAddress", "lat", "lng", "geoProvider"] as const;

export type CityFact = { id: string; active: boolean };

export type SellerActionRejection =
  | { code: "order_not_found" }                                   // inexistente u otra tienda (404)
  | { code: "status_changed"; status: string }                    // expectedStatus != real (409)
  | { code: "order_cancelled"; status: "cancelled" }              // RF_06 (409)
  | { code: "address_review_pending"; status: "address_risk" }    // RF_21 (409), con o sin lider
  | { code: "order_not_editable"; status: string; hasLeader: boolean } // RF_04 (imported con lider), RF_08, RF_14 (409)
  | { code: "out_of_coverage"; field: "cityId" }                  // RF_10 (422)
  | { code: "panel_precondition"; message: string };              // mensajes de hoy del panel

export type SellerActionPlan = {
  outcome: "applied" | "unchanged";
  patch: Record<string, unknown>;        // ya con stripUndefined; vacio si unchanged
  clear: string[];                       // claves a FieldValue.delete()
  audit: AuditEventDoc | null;
  history: OrderHistoryDoc | null;       // null si no hay cambios en campos registrados
  inventory: "release" | "none";
};

export function isApiEditable(order: { status?: string; driverId?: string | null }): boolean;
export function planConfirm(i: PlanInput<{ expectedStatus?: string }>): SellerActionRejection | SellerActionPlan;
export function planDeliveryCorrection(i: PlanInput<DeliveryInput & { expectedStatus?: string; city: CityFact | null; panelExtras?: PanelEditExtras }>): SellerActionRejection | SellerActionPlan;
export function planCancel(i: PlanInput<{ reason?: string; expectedStatus?: string }>): SellerActionRejection | SellerActionPlan;
// PlanInput<T> = { policy; actor; order: Record<string, unknown> & { id: string }; input: T; now: string }
// panelExtras con policy "api" es un error de programacion (lanza): la validacion de la API nunca lo produce.
```

**`isApiEditable`:** estado en `API_EDITABLE_STATUSES` **y** `driverId` nulo, ausente o `""`.

**Confirmar** (tienda primero: actor de tienda con `order.sellerId` distinto → `order_not_found` en API,
`permission-denied` de hoy en panel):

| Estado real | API | Panel (como hoy) |
|---|---|---|
| `expectedStatus` presente y distinto | 409 `status_changed` | — (el panel no lo manda) |
| `imported` sin lider | → `ready_to_assign`, `addressRisk: "accepted"`, `confirmedVia: "api"`, evento `order.seller_confirmed` con `actorRole: "store_api"`, historial `status` | igual con `confirmedVia: "manual"` |
| `imported` con lider (anomalo) | 409 `order_not_editable`, `hasLeader: true` (RF_04) | aplica como hoy |
| `address_risk` (con o sin lider) | 409 `address_review_pending` (RF_21 prevalece sobre `order_not_editable`) | error de hoy |
| `cancelled` | 409 `order_cancelled` | error de hoy |
| `ready_to_assign` o posterior, no cancelado (incluidos los finales) | 200 `changed: false`, sin evento ni historial (RF_05) | error de hoy |

**Corregir datos de entrega** (`PATCH` en la API; `updateImportedOrder` en el panel):

1. Tienda; `expectedStatus`.
2. API: `!isApiEditable` → 409 `order_not_editable` con `status` y `hasLeader` (cubre `in_route`,
   `call_pending`, `address_risk` con lider, `imported` con lider y finales). Panel: solo `imported` (hoy).
3. Ciudad (si viene `cityId`): `city` leido en la transaccion; ausente o `active !== true` → 422
   `out_of_coverage` con la lista de ciudades activas (RF_10, P4). La validacion por campo (4.4) ya se hizo
   fuera: si alguno falla, 422 con todos y ni se abre la transaccion (todo o nada, RF_09).
4. Diff campo a campo contra lo guardado, con valores recortados. `deliveryNotes`:
   - politica `api`: `null` o `""` borra (unica excepcion de RF_09 a "vacio = invalido");
   - politica `panel`: unas indicaciones en blanco **se conservan** como hoy (no entran en el parche ni en el
     diff).
5. **`address_risk` sin lider (RF_22, P1, solo API):** `status: "imported"`, `addressRisk: "review"`, **aunque
   ningun campo cambie de valor**: es la unica forma de que la integracion lo desbloquee, porque confirmarlo da
   409.
   - Sin campos cambiados → evento y historial con accion **`order.address_reviewed`** ("direccion
     revisada"), `fromStatus: "address_risk"`, `toStatus: "imported"`, `changes` con solo `status`.
   - Con campos cambiados → accion `order.delivery_corrected`, `changes` con `status` y cada campo.
   - Nunca se emite `address_risk` (invariante probada: ningun plan de politica `api`, para ningun estado de
     partida ni accion, tiene `patch.status === "address_risk"`).
6. **Campos extra del panel (`panelExtras`, solo politica `panel`):** se anaden al parche tal cual, siempre,
   como hoy (el panel escribe el pedido entero en cada guardado) y **cuentan como cambio**: con politica
   `panel` el plan es siempre `applied`, con sello y evento `order.imported_updated`, aunque solo cambie el
   producto. El historial lleva los campos registrados (2.5) que cambiaron de valor (`totalCop`,
   `productName`, `sku`, `quantity` y los de entrega); si ninguno cambio, `history: null` pero el sello y el
   evento se escriben igual, como hoy.
7. Politica `api`: si no hay cambios y no aplica el paso 5 → `unchanged`, sin escribir.
8. Si cambia `addressRaw` y la politica es `api` → `clear = ADDRESS_DERIVED_FIELDS` presentes en el pedido
   (RF_23). Politica `panel`: conserva como hoy (o aplica el `normalizedAddress` de `panelExtras` si viene).
9. `patch` = campos cambiados (+ `panelExtras` en politica `panel`) + `[MANUAL_EDIT_STAMP]: now` (RF_11, puesto
   por el nucleo) + `updatedAt`; evento `order.delivery_corrected` (API) / `order.imported_updated` (panel), con
   `fromStatus/toStatus` si cambio el estado; historial con cada campo registrado que cambio y `status` si
   cambio. El sello tambien se pone en el caso `order.address_reviewed`: la tienda ha decidido sobre la
   direccion y una reimportacion no debe deshacerlo.
10. Producto, cantidad, valor, pago y modo no existen en `DeliveryInput` (RF_12): mandarlos por API es 422
    con esos campos marcados `not_allowed` (4.4).

**Cancelar:**

| Estado real | API | Panel |
|---|---|---|
| `expectedStatus` distinto | 409 `status_changed` | — |
| `cancelled` | 200 `changed: false` (RF_15) | error de hoy |
| editable (`isApiEditable`) | → `cancelled`, `closedAt`, `callNote = reason` (obligatorio, 1-500, validado antes en T8), libera inventario si `orderOwnsInventoryReservation` y no `imported` (misma regla de hoy), evento `order.cancelled`, historial `status` | igual que hoy, con su precondicion por rol (admin cualquiera no cerrado; tienda no recogido) |
| en curso o final no cancelado | 409 `order_not_editable` (RF_14; incluye `assigned`, `imported` con lider y `address_risk` con lider) | como hoy |

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
// invalid_shopify_order_id solo sale por GET /orders (ruta existente) y con la forma vieja { ok:false, error }.

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

### 4.4 Validacion de cuerpos (RF_09, RF_12, RF_13)

**Se recogen todos los problemas a la vez y se responden juntos.** Pasos (`parseWriteBody`,
`store-api-request.ts`, T8):

1. JSON valido y objeto (si no, 400 `invalid_json`). Se separa `expectedStatus` (texto opcional) **antes** de
   validar: nunca cuenta como campo.
2. **Claves no permitidas.** Cada clave fuera de las permitidas de la ruta se anota en `fields` con
   `code: "not_allowed"`. No se para aqui.
3. **Forma y tipos de las claves permitidas** (Zod, solo forma y tipos basicos: `string`, o `null` donde
   aplica). Un tipo incorrecto se anota con `code: "invalid_type"`.
4. **Contenido de las claves permitidas con tipo correcto:** `validateDeliveryInput` (nucleo puro, T5) para
   `PATCH`; el motivo para cancelar. Cada fallo se anota con su motivo (`required`, `empty`, `too_long`,
   `invalid_phone`).
5. **Respuesta:** si `fields` no esta vacio → 422 con **todos** los campos anotados de los dos tipos, cada uno
   con su motivo; `code` de primer nivel `field_not_allowed` si hay al menos un `not_allowed`, si no
   `validation_failed`. Nada se aplica.

| Campo | Regla de contenido |
|---|---|
| `customerName` | texto, recortado 1-120; vacio o `null` → `empty` |
| `customerPhone` | quitando espacios, guiones, puntos y parentesis: 10 digitos (`^\d{10}$`), o `+57` + 10 digitos, o E.164 `^\+[1-9]\d{7,14}$`. Se guarda recortado tal como vino (no se reformatea: ChatBy compara por los ultimos 10 digitos); vacio o `null` → `empty` |
| `addressRaw` | recortado 1-300; vacio o `null` → `empty` |
| `deliveryNotes` | `null` o `""` (tambien solo espacios) **borra** las indicaciones (unica excepcion de RF_09, solo API); si no, 1-500 |
| `cityId` | `^[a-z0-9-]{1,64}$`; vacio o `null` → `empty`; la cobertura se decide en la transaccion (RF_10) |
| `reason` (cancelar) | obligatorio; recortado 1-500; ausente → `required`, vacio → `empty`, mas de 500 → `too_long` |
| cualquier otra clave | `not_allowed` (incluye producto, valor, pago, modo, `status`, `driverId`) |

Cuerpo de `PATCH` sin ningun campo de entrega permitido y sin problemas (solo `expectedStatus`, o vacio) → 422
`no_fields` (`{ deliveryNotes: null }` si es un campo y no da `no_fields`). Si pasa todo, se decide la cobertura
en la transaccion: el ejemplo del DoD "telefono valido + ciudad no cubierta" da 422 `out_of_coverage` nombrando
`cityId` y no aplica el telefono.

### 4.5 Coste por peticion (RNF_05)

| Ruta | Lecturas | Escrituras |
|---|---|---|
| autenticacion | 1 (`storeApiConfigs/{sellerId}`) | — |
| `GET /orders/{id}` | 1 pedido + asientos del pedido (≈3-8) + cortes que lo contienen (≈1-3) | — |
| `GET /orders/{id}/history` | 1 pedido + registros (decenas) + `settings/storeApi` | — |
| escritura | tasa (1+1) + atajo de idempotencia (0-1) + idempotencia en transaccion (1) + pedido (1) + ciudad (0-1) + inventario de la tienda si libera + payload (≈10); `cities` activas solo en el 422 | pedido, evento, historial, idempotencia (en un 409, solo idempotencia) |

Nada depende del numero de pedidos de la tienda. T27 mide p95 en produccion (objetivo < 2 s, contando arranque
en frio aparte).

## 5. Estrategia de testing

### 5.1 Mapa requisito → prueba → tarea

| Req. | Prueba | Tarea |
|---|---|---|
| RF_01 | `GET /orders/{id}` == elemento de `GET /orders` (fixtures, carga dirigida vs completa); 404 ajeno = 404 inexistente (mismo HTTP y cuerpo); recuento en prod de cortes con `cashAllocations` fuera de `orderIds` (esperado 0) | T1, T2, T9, T10 |
| RF_02 | filtro por `shopifyOrderId` solo de la tienda; ignora `from`/`to`; aplica `status` y `limit`; numero repetido entre tiendas | T10 |
| RF_03 | parametro desconocido → 400 nombrandolo, en cada ruta nueva; `shopifyOrderId` mal formado → 400 con forma vieja (validador); rutas viejas siguen ignorando | T8, T10 |
| RF_04, RF_05 | `planConfirm`: `imported` → `ready_to_assign` + `accepted` + `confirmedVia: "api"`; dos veces → un registro; `imported` con lider → `order_not_editable` | T4, T6 |
| RF_06, RF_21 | `cancelled` → `order_cancelled`; `address_risk` con y sin lider → `address_review_pending` | T4 |
| RF_07, RF_08 | solo campos enviados; corregir no confirma; `in_route`, `call_pending`, `address_risk` con lider → 409 sin cambios | T5 |
| RF_09, RF_10 | recogida conjunta de no permitidos e invalidos con prioridad de `code` (4.4) y tabla de contenido (incluida la excepcion de `deliveryNotes`, solo API); telefono valido + ciudad inactiva → 422 `cityId` con `activeCities`, telefono intacto | T5, T8, T11 |
| RF_22 | `address_risk` sin lider → `imported` + `review`, tambien con valores identicos (`order.address_reviewed`); confirmar despues → `ready_to_assign`; invariante "nunca `address_risk`" | T5 |
| RF_23 | cambio de direccion → `clear` con los cuatro campos; sin cambio de direccion → `clear` vacio | T5 |
| RF_11 | el plan lleva `MANUAL_EDIT_STAMP` (tambien una edicion del panel solo de producto); `mergeImportedOrder` sobre el resultado conserva cliente y direccion; fixture con forma de Kovia y replay firmado con tienda e id sinteticos (P2) | T5, T6, T25 |
| RF_12 | `not_allowed` para producto, cantidad, valor, pago, modo | T5, T8 |
| RF_13-RF_15 | cancelar editable con motivo + inventario `release`; `assigned` → 409; dos veces → un registro; sin motivo → 422; motivo de 1 y 500 pasa, de 501 no | T4, T6, T8 |
| RF_16 | `buildOrderHistoryRecord` (diff, `null` sin cambios, campos de identidad nunca; producto y valor en la edicion del panel); guarda de 2.6 con la lista exacta de RF_16 y exclusiones explicitas; solo el `cleanup` borra `orderHistory` | T5, T7, T15, T16, T25, T27 |
| RF_17 | respuesta con `historySince`, `excludes` y `aviso`; 503 `history_not_ready`; el indice lo dice; el manual tambien; `settings/storeApi` no escribible desde el cliente | T7, T13, T26 |
| RF_18 | `toStoreHistoryResponse` sin `actor`/`uid`/`auditEventId`; historial de pedido ajeno → 404 | T13, T14 |
| RF_19 | guarda anti-copia (5.2); condicion dentro de la transaccion; `status_changed`; carrera simulada (dos planes sobre el mismo pedido); un rechazo no escribe en `orders`, `auditEvents` ni `orderHistory`; la decision de idempotencia se toma dentro de la transaccion | T4, T6, T6b, T12 |
| RF_20 | handler viejo con `db` falso tras conectar `resolveStoreCredentials` (key de lectura y de escritura, 400 de `shopifyOrderId` con forma vieja); `compare-reads` antes/despues sobre `/resumen`, `/kpis`, `/orders`, `/settlements` y las claves actuales del indice: **en tiendas reales solo con su key de lectura; con key de escritura, solo en la tienda de pruebas**; errores viejos con `{ ok, error }` | T9, T10, T24, T27 |
| RF_24 | sin relleno: guarda que nada lee `auditEvents` para construir `orderHistory` | T16 |
| RF_25, RF_26 | `planWriteKeyChange`; atomicidad (transaccion con huella + auditoria); `createStoreApiKey` no toca `writeKey*`; "?" de 44 px del panel de la clave (diseno de HU_04) | T3, T17, T23 |
| RF_27 | `storeActorTag`, `storeSafeSummary`, `isStoreVisibleEvent` (mitigacion hasta la 032: no verificable fuera de la lista → descartado para la tienda); `getOrderAuditTrail` para `seller`/`seller_logistics` sin identidades y sin `getUsers`; admin igual que hoy mas `apiKeyLast4` y "Clave de escritura de <tienda>"; guarda de pantalla: `order-audit-trail.tsx` no pinta `actorEmail` cuando hay `storeActorTag` | T14, T22 |
| RNF_01 | tabla 2.3 completa (cualquier key por query en escritura → 401; `kw_` por query en lectura vieja y nueva → 401; 403 solo para key de lectura en la cabecera); handler viejo conectado; 404 identico | T3, T10 |
| RNF_02 | catalogo de codigos congelado; forma `{ ok:false, code, message, fields? }` | T8, T11 |
| RNF_03 | misma key mismo cuerpo → misma respuesta sin aplicar; otro cuerpo → 422; expirado → nuevo; un 409 guarda el registro; el atajo previo no decide `fresh` | T12 |
| RNF_04 | ventana, 429 + `Retry-After`, nunca 403; la cifra solo en `STORE_API_WRITES_PER_MINUTE` | T8, T12 |
| RNF_05 | guarda: los handlers nuevos no contienen `where("sellerId"` sin un segundo filtro ni leen `collection("settlements").get()`; p95 medido | T10, T27 |

### 5.2 Guardas de fuente (`spec-029-guards.test.ts`, mismo patron que la 017 y la 026: fuente sin comentarios)

- **Anti-copia (RF_19, T6b y T11):** `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`, `cancelOrder`) y
  `store-api-write.ts` llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel`; ninguno de esos cuerpos
  contiene `status: "ready_to_assign"`, `status: "cancelled"`, `addressRisk: "accepted"` ni
  `[MANUAL_EDIT_STAMP]` (el sello lo pone el nucleo, tambien para los campos extra del panel); mutacion
  comprobada a mano (pegar el parche de confirmar en `store-api-write.ts` pone la guarda en rojo) en
  `EV/mutacion-rf19.txt`.
- **Nadie mas escribe `orders`:** guarda 1 de la 017 sigue en verde; `store-api*.ts` y `store-api-keys.ts` no
  escriben pedidos (`writesOrders` de la 017 reutilizado).
- **Historial (2.6, T15 y T16, con exclusiones explicitas)**, **identidades y mitigacion (2.7, T14)**,
  **`historySince` sin literal (2.4, T7)**, **reglas** (tres colecciones nuevas con `allow read, write: if
  false` y `settings` acotada con `settingId != "storeApi"`, T7), **la key no sale** (`store-api-keys.ts` solo
  devuelve `writeKey` en `rotateStoreWriteKey` y nunca escribe `writeKey:` en Firestore; ningun
  `console.*`/`logger.*` recibe la key ni la cabecera `authorization`; T17), **limite en un solo sitio** (el
  literal `120` asociado a escrituras por minuto solo aparece en `STORE_API_WRITES_PER_MINUTE`; T8), **el
  secreto de Shopify no sale del proceso** (`kovia-replay` no lo escribe en disco ni en logs; T25).
- **UI:** `operations-app.tsx` solo monta los componentes nuevos (T20-T22); `localStorage` no aparece en
  `store-api-write-key.tsx` (T20); el "?" de `CollapsiblePanel` no usa `h-8 w-8` (T23).

### 5.3 Canal del cliente: verificacion contra produccion (DoD 3)

Las rutas son HTTP y la UI usa callables: se prueban **por su canal**, no reimplementando la regla en un
script (memoria "verificar por el canal del cliente").

- **Tienda de pruebas** (OPC_04, operativa): `seller-test-029`, creada por `verify-029.js smoke --setup` con
  un usuario `seller` y uno `seller_logistics` desechables (contrasena aleatoria, nunca en la evidencia), en
  `city-cali` (ya activa), y con **su propia config de webhook de tienda de prueba** (la que usa
  `storeOrderWebhook`; secreto de prueba generado para la ocasion, nunca en la evidencia). La key de escritura la
  genera **la callable** con la sesion `seller`.
- **Lecturas reales** (solo lectura) contra tiendas reales **solo con su key de lectura existente**:
  `capture-reads` antes del despliegue (T24) y `compare-reads` despues (RF_20, T27). La comparacion con **key de
  escritura** se hace **solo sobre la tienda de pruebas** (unica tienda con key de escritura durante la
  verificacion; en unidad, T10 la cubre con el handler viejo y un `db` falso). `GET /orders/{id}` sobre 20
  pedidos reales de Kovia, ONEP y DANDA comparados con su elemento en `GET /orders` (RF_01), con key de lectura.
- **Escrituras solo sobre pedidos de la tienda de pruebas:**
  - el pedido **`imported`** para CA_01-CA_04 y RF_04/RF_05 entra **por el `storeOrderWebhook` de
    `seller-test-029`** (con su config de webhook de prueba), como entran los pedidos reales de esa via, y no
    con `createManualOrder`;
  - uno en `address_risk`, creado con el alta manual (`createManualOrder`, sesion de la tienda) marcada
    "revisar" (`addressRisk: "review"`), que es la via que hoy produce ese estado, para RF_21 y RF_22 (con y sin
    cambio de valores);
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
- **RF_11 con la forma de Kovia (P2, T25):**
  - (a) prueba unitaria con un fixture (`src/lib/fixtures/029-kovia-order.json`) copiado en solo lectura de un
    pedido real de Kovia y su payload de Shopify, con nombre, telefono, direccion **e id de Shopify** sustituidos
    por valores sinteticos de la misma forma, pasado por `planDeliveryCorrection` y despues por
    `mergeImportedOrder`;
  - (b) en produccion, `verify-029.js kovia-replay`: crea un documento `shopifyStores` **de prueba** con un
    dominio **sintetico** (p. ej. `kentro-test-029.myshopify.com`) que apunta a `seller-test-029`, y envia al
    `shopifyWebhook` un payload con la forma de Kovia y un **id de Shopify sintetico** (nunca el de un pedido real
    de Kovia). Secuencia: **replay 1** (crea el pedido) → `PATCH` por API (corrige cliente y direccion) →
    **replay 2** (mismo payload, reimporta) → comprobacion de RF_11: cliente y direccion corregidos se conservan,
    el estado no cambia y el pedido queda en fase `edited`. La firma HMAC se calcula **leyendo el secreto de
    Shopify existente solo en memoria**, sin escribirlo en disco, en la evidencia ni en logs. Limpieza propia
    (`kovia-replay --cleanup`, tambien incluida en el `cleanup` general): el documento `shopifyStores` de prueba,
    los `importRuns` de esas corridas, el `orderHistory` y los `auditEvents` del pedido, y el pedido. No se toca
    ninguna tienda ni pedido real de Kovia.
- **`cleanup` (T27):** borra pedidos de prueba (los del webhook de tienda, los manuales y el de `kovia-replay`),
  sus `auditEvents`, `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`, `walletEntries` si los hubiera,
  `importRuns` de las corridas de prueba, el `shopifyStores` de prueba, la config de webhook de prueba,
  inventario de prueba, usuarios y la tienda; imprime recuento y falla si queda algo. Es el unico codigo que
  borra `orderHistory`, y solo por `orderId` de prueba (excepcion declarada en RF_16).

## 6. Indices

**Previstos: ninguno compuesto.** Todas las consultas nuevas son igualdad sobre un campo
(`orderHistory.orderId`, `walletEntries.orderId`, `settlements.orderIds array-contains`, `cities.active`) o
dos igualdades (`orders.sellerId` + `orders.shopifyOrderId`), que Firestore sirve con los indices
automaticos. `query-check` (T2) ejecuta cada una con `limit(1)` en produccion **antes** de escribir el
handler; si alguna pide indice, se **anade** a `firestore.indexes.json` tras `firebase firestore:indexes`
contra prod (se anaden, nunca se reemplazan) y se despliega primero. Politicas **TTL** (no son indices):
`storeApiIdempotency.expiresAt` y `storeApiRateLimits.expiresAt`, con `gcloud firestore fields ttls update`.

## 7. Reglas de Firestore

- Se anaden tres bloques, todos `allow read, write: if false`: `orderHistory`, `storeApiIdempotency`,
  `storeApiRateLimits`.
- Se **acota** la regla general de `settings`: `allow write: if isAdmin() && settingId != "storeApi";` (la
  lectura no cambia). Asi `settings/storeApi` solo lo escribe el Admin SDK del guion (2.4); la guarda de T7 lo
  comprueba.
- No se toca `auditEvents`: su cierre es la spec 032; mientras tanto, la mitigacion de 2.7.
- No se toca `operationalOrderUpdateByAssignee`: hueco declarado en RF_16, estudiado en la 032.

## 8. Dependencias nuevas

Ninguna. `crypto` de Node (`randomBytes`, `createHash("sha256")`, `createHmac`, `timingSafeEqual`), Zod y
`firebase-admin` ya estan.

## 9. Tareas

Ver `specs/029_tasks.md` (T1-T27, con T6 partida en T6 —ejecutor y carreras— y T6b —delegacion del panel,
guardas y anti-copia—). T23 resuelve el pendiente 3 del README y se acepta como parte del diseno de HU_04
(RF_25): el "?" de `CollapsiblePanel` vive en el panel de la clave de API y pasa de `h-8 w-8` (32 px) a un area
de 44x44 (`h-11 w-11`, icono de 16 px y forma circular sin cambio), con guarda de fuente y `boundingBox()` >= 44
en el E2E a 375 y 1280. T22 no empieza hasta que `sdd-uxui` ratifique en el README las etiquetas "Direccion
revisada" y "Recogido" (seccion 12).

## 10. Orden de despliegue

1. `capture-reads` (T24) con las keys de lectura actuales.
2. Reglas (`orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`, `settings` acotada) (T7).
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
| Copiar la regla de confirmar/cancelar en la API | nucleo + ejecutor unicos; guarda anti-copia con mutacion (T6b) |
| Regresion del panel al delegar `updateImportedOrder` (perder el sello o borrar indicaciones en blanco) | politica `panel` con `panelExtras` y sello en el nucleo; pruebas "edicion solo de producto sella" e "indicaciones en blanco se conservan" (T5, T6) |
| Historial falsificable | `orderHistory` solo de servidor (2.5) |
| **Historial con hueco: el lider y el mensajero cambian `status` desde el cliente** (`operationalOrderUpdateByAssignee`) sin registro | declarado en RF_16 como limite conocido; trasladado a la 032 (1.1, RF_07 de su borrador); no se toca aqui para no cambiar la app del mensajero sin su spec |
| `historySince` movido desde la app por un admin | regla de `settings` acotada (`settingId != "storeApi"`) y `create` en el guion (2.4, T7) |
| Evento de `auditEvents` fabricado por un cliente visible para la tienda | mitigacion 2.7 (verificable o accion permitida); riesgo residual hasta la spec 032 (prioridad alta) |
| La tienda deja de ver eventos historicos que hoy ve (efecto de la mitigacion) | aceptado en RF_27 y en los casos limite de la spec; lo revisa la 032 |
| Identidades de Kentro a la tienda por `summary` viejos | lista permitida, no prohibida (2.7) |
| La key de escritura en logs o en `localStorage` | guardas 5.2; solo cabecera; cualquier key por query en escritura → 401 |
| El secreto de Shopify filtrado por `kovia-replay` | se lee y se usa solo en memoria; guarda de T25 (sin escritura a disco ni logs) |
| `kovia-replay` toca una tienda o un pedido real de Kovia | dominio e id de Shopify sinteticos, tienda `shopifyStores` de prueba apuntando a `seller-test-029`; guarda de T25 |
| La carga dirigida pierde un corte que solo referencia el pedido en `cashAllocations` | recuento en prod (T1, T2; esperado 0); si no es 0, se para T9/T10 |
| Rotacion a medias que deja a la integracion sin key | transaccion huella + auditoria; la key se devuelve tras el commit |
| `GET /orders/{id}` distinto del elemento de `GET /orders` | misma funcion movida; equivalencia de carga dirigida; comparacion en prod sobre 20 pedidos |
| Romper integraciones de lectura | rutas viejas sin cambio interno salvo la autenticacion y el filtro nuevo, probados con el handler viejo (T10); `compare-reads` antes/despues con key de lectura; el indice solo gana claves |
| Doble aplicacion por reintento de CENTRAL | `Idempotency-Key` decidida dentro de la transaccion; el atajo previo nunca decide `fresh` |
| ChatBy reescribe una direccion corregida por API | aceptado por la spec (caso limite); advertido en `aviso` y en el manual; spec 031 |
| `address_risk` desbloqueado por API sin cambiar nada | decidido (P1): queda en `imported` + `review`, con historial `order.address_reviewed`; la confirmacion sigue siendo aparte y explicita |
| **Limite de 120 escrituras/minuto por tienda: a confirmar con CENTRAL** | una sola constante (`STORE_API_WRITES_PER_MINUTE`); cambiarla es una linea y su prueba |
| Coste del limite de tasa (1 escritura por peticion) | ~120/min por tienda en el peor caso; TTL limpia |

## 12. Preguntas abiertas

Todas resueltas el 2026-10-04 (tabla de la cabecera). Pendiente operativo, no bloqueante: confirmar con
CENTRAL el limite de 120 escrituras/minuto (seccion 11). **Compuerta de diseno para T22:** las etiquetas
"Direccion revisada" (`order.address_reviewed`) y "Recogido" (`order.picked_up`) no estan en el README; las
ratifica `sdd-uxui` en el README antes de empezar T22 (lanzado por la sesion principal).

## 13. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-04 | Plan tecnico inicial y cierre de P1-P5 | Spec 029 aprobada |
| 2026-10-04 | Precisiones de `/sdd-analyze`: (1) confirmar un `address_risk` da siempre 409 `address_review_pending`, tambien con lider (4.1); (2) tabla 2.3 reescrita con orden de evaluacion: cualquier key por query en escritura → 401 `key_in_query` (sustituye a `write_key_in_query`, nunca desplegado), `kw_` por query → 401 tambien en rutas de lectura viejas, 403 `read_only_key` solo para la key de lectura en la cabecera; (3) `deliveryNotes` vacio o `null` borra y el resto de campos vacios dan 422 (4.4); (4) T12 toca `order-seller-actions-run.ts`; (5) T18 toca `operations-app.tsx` para adaptar `fetchFirebaseOrderAuditTrail`; (6) pruebas de RF_02 y del 404 identico en T10, validador de `shopifyOrderId` en T8; (7) todas las referencias a tareas renumeradas a T1-T27 (secciones 1, 2.x, 3, 4.5, 5.x, 9, 10, 12); (8) tabla 2.6 con su tarea y declarada igual a la lista de RF_16; (9) excepcion del `cleanup` en 2.5 y 5.3; (10) consecuencia visible de la mitigacion 2.7 y riesgo nuevo; (11) T23 aceptada como parte del diseno de HU_04 (seccion 9); (12) carrera simulada en T6 (2.2 y riesgos) | Hallazgos de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
| 2026-10-04 | Segunda pasada de `/sdd-analyze` (spec sin cambios): (1) politica `panel` de `planDeliveryCorrection` con `panelExtras` (lo que hoy edita `updateImportedOrder`): cuentan como cambio, se aplican siempre, llevan sello y auditoria, y el sello lo pone el nucleo; el borrado de `deliveryNotes` `""`/`null` es solo de la API y el panel conserva indicaciones en blanco (2.2, 4.1, riesgos); (2) las rutas viejas autentican con `resolveStoreCredentials`, conectado y probado con el handler viejo en T10 (2.3); (3) un rechazo no escribe en `orders`, `auditEvents` ni `orderHistory`; un 409 de la API si guarda el registro idempotente (2.2, 2.8, 4.5); (4) la creacion (`createManualOrder` e importaciones) y ChatBy excluidas de RF_16 con lista explicita en la guarda de T16 (2.6); (5) validacion en dos capas: Zod solo forma y tipos, `expectedStatus` separado antes, prioridad `field_not_allowed` sobre `validation_failed`, reglas de contenido en `validateDeliveryInput` (2.1, 4.4); (6) motivo de cancelar validado en T8 (4.4); (7) T13 prueba 404 de historial ajeno y 503; (8) T14 prueba `apiKeyLast4` y "Clave de escritura de <tienda>" para el admin; (9) T6 partida en T6 y T6b (secciones 1, 2.2, 2.6, 3, 5.1, 5.2, 9, riesgos); (10) compuerta de `sdd-uxui` antes de T22 (secciones 9 y 12) | Hallazgos de la segunda pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
| 2026-10-04 | Tercera pasada de `/sdd-analyze` (spec precisada en texto, decision 9): (1) el pedido `imported` de prueba entra por el `storeOrderWebhook` de `seller-test-029` con su config de webhook de prueba, incluida en el `cleanup` (5.3, T27); (2) `kovia-replay` con `shopifyStores` de prueba de dominio sintetico, id de Shopify sintetico, secuencia replay 1 → `PATCH` → replay 2, comprobacion de RF_11, limpieza propia (`shopifyStores`, `importRuns`, `orderHistory`, pedido) y firma HMAC con el secreto solo en memoria (5.3, riesgos, T25); (3) el 422 lista todos los campos con problema de los dos tipos, con `field_not_allowed` de primer nivel si hay alguno no permitido (2.1, 4.4, T8); (4) regla de `settings` acotada a `settingId != "storeApi"` (1, 2.4, 7, T7); (5) `GET /orders` viejo: 400 de `shopifyOrderId` con forma vieja y `status`/`limit` aplicados con el filtro (2.1, 2.10, 4.3, T10); (6) `compare-reads` con key de escritura solo sobre la tienda de pruebas; tiendas reales solo con key de lectura (5.1, 5.3, T24, T27); (7) recuento en prod de cortes con `cashAllocations[].orderId` fuera de `orderIds` (esperado 0) en T1/T2 (2.10, riesgos); (8) la decision de idempotencia se toma dentro de la transaccion; la lectura previa es solo atajo (2.1, 2.8, 4.5); (9) hueco de `operationalOrderUpdateByAssignee` declarado (1, 2.5, 2.6, 7, riesgos) y anadido al borrador de la 032; (10) `imported` con lider → 409 `order_not_editable` en confirmar (4.1, T4) | Hallazgos de la tercera pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
