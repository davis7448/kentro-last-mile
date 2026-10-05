# Plan tecnico — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API, sin pisar lo operado

- **Spec:** `specs/029_store_api_confirma_y_corrige_pedidos.md` — **aprobada el 2026-10-04** (decisiones 1-13,
  seccion 9; anexo A con los criterios de CENTRAL).
- **Fecha:** 2026-10-04. Preguntas del plan resueltas el mismo dia por el orquestador, por delegacion del
  responsable (seccion 12). Precisado tras siete pasadas de `/sdd-analyze` (2026-10-04 y 2026-10-05); la septima
  es la **pasada final** decidida por el responsable (seccion 13).
- **Diseno:** `specs/design/029_store_api_confirma_y_corrige_pedidos/` (README + 14 pantallas observadas):
  - HU_04 (clave de escritura): `HU_04.tienda-sin-clave`, `HU_04.tienda-recien-generada`, `HU_04.tienda-activa`,
    `HU_04.tienda-rotar`, `HU_04.tienda-error`, `HU_04.admin-lista`, `HU_04.admin-lista-movil`,
    `HU_04.admin-recien-generada`;
  - HU_05 (historial): `HU_05.tienda`, `HU_05.tienda-escritorio`, `HU_05.admin`, `HU_05.admin-escritorio`,
    `HU_05.vacio`, `HU_05.error`.
  Este plan no decide textos ni disposicion: los toma del README. Sus tres pendientes "fuera del diseno" se
  resuelven aqui (2.10 → 2.4, 2.3 y T23). Lo que el README aun no nombra va a la compuerta de `sdd-uxui`
  (seccion 12).
- **Tareas:** `specs/029_tasks.md` (T1-T27, con T6 partida en T6 y T6b). Toda referencia a una tarea en este
  plan usa esa numeracion. Los hallazgos menores de la pasada final viven como "Nota para la prueba" dentro de
  la tarea afectada y se resuelven al escribir su RED.
- **Evidencia:** `.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).
- **Specs relacionadas:** 030 (webhook firmado) reutilizara `orderHistory` como fuente de eventos; 031 anadira
  los origenes `shopify` y `chatby` al mismo registro; **032** (borrador, prioridad alta,
  `specs/032_auditoria_solo_la_escribe_el_servidor.md`) cierra el `create` de cliente en `auditEvents` y estudia
  `operationalOrderUpdateByAssignee` (1). Hasta la 032, este plan aplica la mitigacion de 2.7.
- **Criterio de esta version:** ante dos formas de verificar algo, la mas simple y robusta; ningun mecanismo
  nuevo que no pida la spec.

### Preguntas del plan: resueltas (2026-10-04)

| Pregunta | Respuesta aplicada |
|---|---|
| P1 — `address_risk` corregido con valores identicos | Vuelve a `imported` igual: es la unica forma de que CENTRAL lo desbloquee (confirmarlo da 409). Historial con accion `order.address_reviewed` ("direccion revisada"), solo el cambio de `status`, sin campos de entrega (4.1) |
| P2 — Kovia y RF_11 | Fixture con la forma de un pedido real de Kovia (datos sinteticos) y pruebas unitarias (T25) + replay firmado de un webhook de Shopify, con tienda de Shopify e id **sinteticos** y salvaguardas obligatorias, hacia la tienda de pruebas, dentro del recorrido real (T27, 5.3) |
| P3 — `auditEvents` con `create` abierto | Spec aparte de prioridad alta: 032 (borrador). En la 029, mitigacion explicita: a la tienda solo le llegan eventos con actor verificable o de accion permitida (2.7); los demas dejan de verse para la tienda (RF_27) |
| P4 — ciudades | Manual con las ciudades activas; el 422 `out_of_coverage` trae la lista de ciudades activas (4.3) |
| P5 — limite de tasa | 120 escrituras/minuto por tienda, constante con nombre en un solo modulo (2.9); "a confirmar con CENTRAL" en riesgos |

## 1. Lo que hay hoy (leido en el codigo, no supuesto)

| Donde | Que hace | Consecuencia para la 029 |
|---|---|---|
| `functions/src/store-api.ts` `storeApi` | `onRequest`, solo `GET`; autentica `sellerId` + key, tomando **la de query si viene y si no la Bearer** (`query ?? bearer`), contra `storeApiConfigs.apiKey` en claro con `safeEqual`; **lee todos los pedidos de la tienda** antes de mirar la ruta (salvo `docs`); `/orders` lee ademas `walletEntries` de la tienda y **`settlements` entera** | Las rutas nuevas no pueden pasar por esa carga (RNF_05). Las existentes no se tocan por dentro (RF_20): se extraen sus funciones de forma sin cambiar su salida, y su autenticacion pasa por `resolveStoreCredentials` (T10), que conserva `query ?? bearer` en lectura (2.3) |
| `store-api.ts` `orderPayload`, `classifyOrder`, `buildPaymentInfo` | forma de un elemento de `GET /orders` | RF_01 exige el mismo esquema: se mueven a un modulo puro y las dos rutas las llaman (no se copian) |
| `store-api.ts` indice (`docs`) | objeto con claves de primer nivel (rutas, autenticacion...) | RF_20: la documentacion nueva va **solo en claves nuevas de primer nivel**; los valores de las actuales no cambian (2.1) |
| `store-api.ts` `createStoreApiKey` | `admin`/`seller`; devuelve la key de lectura completa cada vez; audita `store_api_key.viewed/created` | Se queda igual (RF_26). La de escritura va por callables nuevas. La tienda de pruebas obtiene su key de lectura con esta misma callable (5.3) |
| `orders.ts` `confirmImportedOrder` | transaccion; solo `imported`; `addressRisk: "accepted"`, `confirmedVia: "manual"`, audita `order.seller_confirmed` con `fromStatus/toStatus` | Nucleo compartido de confirmar (2.2) |
| `orders.ts` `updateImportedOrder` | solo `imported`; pedido entero (cliente, direccion, pago, modo, valor, producto/`lineItems`, zona...); `[MANUAL_EDIT_STAMP]: now`; **conserva** `normalizedAddress` si no viene (spec 013) y las indicaciones si vienen en blanco; audita sin campos ni valores | Nucleo compartido de datos de entrega con politica `panel` que acepta esos campos extra (2.2, 4.1); el panel sigue con su precondicion y sus campos (seccion 7 de la spec) |
| `orders.ts` `cancelOrder` | cualquier no cerrado; la tienda no puede si esta recogido; libera inventario si reservo y no es `imported`; motivo opcional a `callNote`; error si ya `cancelled`; su parche escribe `driverId: current.driverId ?? null`; tiene su propia lista literal `["delivered", "failed", "cancelled", "liquidated"]` | Nucleo compartido de cancelar con dos politicas (panel / api); el parche conserva `driverId: current.driverId ?? null` (4.1); al delegar, su literal sale de `orders.ts` (T6b) |
| `orders.ts` `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder`, `assignMessengerToOrders`, `unassignMessengerFromOrders`, `createOrUpdatePickupBatch`; `order-corrections.ts` `correctOrderStatus` | cambian estado (o, el ajuste, producto/recaudo). `createOrUpdatePickupBatch` **no audita** | Todas escriben historial (RF_16, 2.6) |
| `orders.ts` `getOrderAuditTrail` | lee `auditEvents` por `entityId`; resuelve uid → nombre y correo con `getUsers` **para cualquier rol**; al `seller_logistics` le filtra acciones financieras | RF_27: el filtrado de identidades va en el servidor (2.7). Es y seguira siendo **la unica funcion que consulta `auditEvents`**, y no escribe `orderHistory` (guarda de RF_24, 2.6) |
| `firestore.rules` `auditEvents` | `allow create: if signedIn()` | **Cualquier sesion puede crear un evento con el `entityId` de un pedido ajeno.** No sirve como historial que la API ensena a una tienda (RF_18): el historial campo a campo va a una coleccion nueva solo de servidor (2.5); el cierre de la regla es la spec 032 |
| `firestore.rules` `operationalOrderUpdateByAssignee` (l. ~122) | el lider o el mensajero asignados cambian desde el cliente `status` entre `assigned`, `call_pending`, `scheduled`, `picked_up`, `in_route`, `retry_pending` (y campos de llamada y agenda) | **Esos cambios no escriben `orderHistory`**: limite conocido de RF_16, trasladado a la 032 (seccion 1.1 y RF_07 de su borrador). Esta spec no toca la regla |
| `firestore.rules` `settings/{settingId}` (l. ~145) | `allow read: if signedIn(); allow write: if isAdmin();` | Un admin podria escribir `settings/storeApi` desde el cliente y mover `historySince`. Se acota a `allow write: if isAdmin() && settingId != "storeApi"` (2.4, 7, T7) |
| `firestore.rules` `storeApiConfigs` | `allow read, write: if false` | La huella de la key de escritura vive ahi (2.3) |
| `order-import-merge.ts` | `MANUAL_EDIT_STAMP`, `CLOSED_STATUSES`, `IMPORT_WRITE_EXEMPTIONS` (cuatro) | RF_11 usa la constante; el ejecutor nuevo es la quinta exencion (2.2, T6) |
| `src/lib/spec-017-guards.test.ts` | guarda 1 (quien escribe `orders`), guarda 3 (**exactamente cuatro** exenciones), guarda 7 con dos pruebas: **exactamente dos** `[MANUAL_EDIT_STAMP]:` en `orders.ts`, y **exactamente dos** literales `["delivered", "failed", "cancelled", "liquidated"]` en `orders.ts` (anulacion e inventario) | T6 actualiza guarda 3 (cinco, al nacer el ejecutor). T6b actualiza las dos pruebas de la guarda 7 al delegar: el sello pasa a 1 en `orders.ts` + 1 en el nucleo, y el literal de estados cerrados pasa de 2 a 1 en `orders.ts` (el de `cancelOrder` desaparece porque delega en el nucleo, que usa `CLOSED_STATUSES`; queda el de inventario), con su razon. Nada mas de la 017 se toca; la guarda de historial de T16 es propia de la 029 y va por nombre (2.6) |
| `src/components/operations-app.tsx` `CollapsiblePanel` (l. 1105), `OrderAuditTrail` (l. 2091), `AUDIT_ACTION_LABELS` (l. 2053), `StoreApiKeyCard` (l. 11162) | el "?" mide `h-8 w-8`; el historial pinta `actorLabel`/`actorEmail`/`actorRole` a todos y no reintenta | HU_04 y HU_05 (T18 adapta el uso de `fetchFirebaseOrderAuditTrail`; T20-T23) |
| `cities` | `{ active }`; todas las importaciones escriben `cityId: "city-cali"` | RF_10 lee `cities/{cityId}` dentro de la transaccion, antes de decidir si la correccion es un no-op; el 422 lista las activas |
| Contador de `trackingCode` | cada pedido creado por una via de importacion consume un numero | Los pedidos de prueba creados por webhook (5.3) consumen numeros del contador real: **aceptado** (no se rebobina) |
| Guiones `verify-022` / `verify-026` | usan un admin desechable creado y borrado por el propio guion | El guion de la 029 hace lo mismo (5.3), aceptado explicitamente en la spec (DoD 3, decision 12 (c)) |
| Criterios CA_01-CA_12 de CENTRAL | estan en un documento externo, no en el repositorio | Anexo A de la spec, pendiente de transcribir; **compuerta de T27** (5.3) |

## 2. Decisiones de diseno

### 2.1 Superficie HTTP nueva (dentro de la misma funcion `storeApi`)

| Metodo y ruta | Key | Cuerpo | Exito |
|---|---|---|---|
| `GET /orders/{id}` | lectura o escritura | — | 200 `{ ok: true, pedido }` (mismo esquema que un elemento de `GET /orders`) |
| `GET /orders?shopifyOrderId=` | lectura o escritura | — | 200, forma de `GET /orders` (RF_02); ignora `from`/`to`; aplica `status` y `limit` |
| `GET /orders/{id}/history` | lectura o escritura | — | 200 `StoreOrderHistoryResponse` (4.3) |
| `POST /orders/{id}/confirm` | **escritura**, solo Bearer | `{ expectedStatus? }` y nada mas (otra clave o tipo invalido → 400 `invalid_body`) | 200 `{ ok: true, changed, pedido }` |
| `PATCH /orders/{id}` | **escritura**, solo Bearer | `{ customerName?, customerPhone?, addressRaw?, deliveryNotes?, cityId?, expectedStatus? }` | 200 `{ ok: true, changed, pedido }` |
| `POST /orders/{id}/cancel` | **escritura**, solo Bearer | `{ reason, expectedStatus? }` | 200 `{ ok: true, changed, pedido }` |

`sellerId` sigue por query en todas (no es secreto, y asi la autenticacion es una lectura por id, sin buscar
la huella en toda la coleccion). `changed: false` es la respuesta de un no-op (glosario de la spec: RF_05, RF_15
y una correccion cuyos valores ya eran los guardados, salvo el caso `address_risk`, 4.1), **tambien con un
`expectedStatus` que no coincide** (RF_19).

`storeApi` deja de responder 405 a todo lo que no es `GET`: `Allow` pasa a ser por ruta. Las rutas existentes
siguen solo `GET` y con su 405 de hoy (`{ ok: false, error: "method_not_allowed" }`).

**Indice de la raiz (RF_17, RF_20, DoD 5).** La documentacion nueva (rutas nuevas, `HISTORY_EXCLUDES` con su
aviso, codigos de error y su precedencia, estados editables, `historySince`, key de escritura solo por cabecera)
va **solo en claves nuevas de primer nivel** del objeto del indice (p. ej. `writeEndpoints`, `history`,
`errorCodes`, `editableStatuses`). Las claves actuales (rutas, autenticacion y el resto) **conservan su valor
identico**: no se anade nada dentro de ellas. `compare-reads` compara las claves actuales **por valor** (T13,
T24, T27).

**Orden de evaluacion de una peticion nueva = precedencia de codigos (decision 12 de la spec).** Una sola
secuencia, la misma para todas las rutas nuevas; la primera condicion que se cumple responde:

| Paso | Que se comprueba | Respuesta | Donde |
|---|---|---|---|
| 0 | ruta y metodo | 404 de ruta / 405 `method_not_allowed` | `store-api-request.ts` (T8) |
| 1 | `key` en query **en una ruta de escritura**, antes que nada mas | 401 `key_in_query` | `store-api-auth.ts` (T3) |
| 2 | credenciales (tabla 2.3) | 401 `missing_credentials` / `invalid_key` / `key_in_query` (`kw_` en lectura) / 403 `read_only_key` | T3 |
| 3 | parametros de consulta y forma del cuerpo | 400 `unknown_parameter` (nombrando cada uno) / `invalid_json` (JSON roto) / `invalid_body` (cuerpo que no es objeto; en **confirmar**, cualquier clave distinta de `expectedStatus` o un tipo invalido) | T8 |
| 3a | transversal, solo escrituras: limite de tasa | 429 `rate_limited` | T12 |
| 3b | transversal, solo escrituras: **atajo** de idempotencia (lectura previa fuera de la transaccion, 2.8) | respuesta guardada (`replay`) / 422 `idempotency_key_reused` | T12 |
| — | se abre la transaccion (2.2); dentro se vuelve a leer el registro idempotente y se toma la decision de idempotencia que vale | | T6, T12 |
| 4 | pedido de la tienda | 404 `order_not_found` (ajeno o inexistente, mismo cuerpo) | nucleo (T4, T5) |
| 5 | estado | 409 `order_cancelled` / `address_review_pending` / `order_not_editable` | nucleo |
| 6 | validacion y cobertura (los errores de campo ya calculados en el paso 3 por `parseWriteBody`, y la ciudad leida en la transaccion) | 422 `field_not_allowed` / `validation_failed` / `no_fields` / `out_of_coverage` (incluida la misma ciudad desactivada) | nucleo + T8 |
| 7 | no-op | 200 `changed: false` | nucleo |
| 8 | `expectedStatus` presente y distinto (solo llega aqui si la accion cambiaria algo) | 409 `status_changed` | nucleo |
| 9 | aplicar | 200 `changed: true` | ejecutor (T6) |

Los errores de campo de `PATCH` y cancelar se **calculan** en el paso 3 (sin leer nada), pero se **responden**
en el paso 6, despues de 404 y 409: un campo invalido sobre un pedido en ruta da 409, no 422. En **confirmar**,
cuyo cuerpo solo admite `expectedStatus`, cualquier otra clave o un tipo invalido es forma del cuerpo y se
responde en el paso 3 con 400 (decision 13). Las rutas de lectura nuevas usan los pasos 0-4. En una ruta de
escritura, `key` no es un parametro desconocido: es una credencial en el sitio prohibido, y responde 401 en el
paso 1, tambien si ademas viene un parametro desconocido.

### 2.2 Un nucleo puro y un ejecutor transaccional compartidos por panel y API (RF_19, regla de oro 1)

Tres piezas, para que ninguna regla exista dos veces:

1. **`functions/src/order-seller-actions.ts` — puro** (sin `firebase-admin`). Decide, no escribe:
   `planConfirm`, `planDeliveryCorrection`, `planCancel` (4.1). Cada uno recibe el pedido leido, la politica
   (`"panel"` o `"api"`), la entrada ya analizada (con sus errores de campo, si los hubo), el actor y `now`, y
   devuelve o un **rechazo tipado** o un **plan**: el parche del pedido, las claves a borrar (`clear`), el evento
   de auditoria y el registro de historial. Aplica los pasos 4-8 de 2.1 en ese orden. Importa
   `MANUAL_EDIT_STAMP` y `CLOSED_STATUSES` de `order-import-merge.ts`. **El sello `MANUAL_EDIT_STAMP` lo pone
   siempre el nucleo**, en las dos politicas.
2. **`functions/src/order-seller-actions-run.ts` — ejecutor.** Una funcion por accion
   (`runConfirm`, `runDeliveryCorrection`, `runCancel`): abre la transaccion, lee el pedido (y, si toca, la
   ciudad, el inventario y el registro de idempotencia), llama al planificador **dentro** de la transaccion,
   aplica `plan.patch` con `merge`, borra `plan.clear` con `FieldValue.delete()`, mueve inventario con
   `applyInventoryMovements` (el mismo de `cancelOrder`), escribe el evento, el historial y, en la API, la
   respuesta idempotente. Devuelve `{ kind: "rejected", rejection } | { kind: "applied" | "unchanged", order }`.
   No sabe de HTTP ni de `HttpsError`. **Si el plan rechaza, no escribe nada en `orders`, `auditEvents` ni
   `orderHistory`.** En la API, un rechazo de los pasos 5, 6 u 8 (409 y 422 que dependen del pedido) si deja el
   registro idempotente (2.8), y es lo unico que escribe.
3. **Adaptadores.** Las callables de `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`,
   `cancelOrder`) y las rutas de `store-api-write.ts` traducen la entrada a la del ejecutor y el rechazo a su
   canal (`HttpsError` con los mismos codigos y mensajes de hoy en el panel; `{ ok:false, code, message }` en la
   API). **Ningun adaptador escribe en el pedido**, ni el sello ni ningun otro campo.

**Que se comparte y que no.** El panel y la API comparten: el chequeo de tienda, el parche de confirmar, el
constructor de datos de entrega (recorte, sello `MANUAL_EDIT_STAMP`, diff para el historial), el parche de
cancelar (incluido `driverId: current.driverId ?? null`), la liberacion de inventario, la auditoria y el
historial. Lo que difiere es **politica declarada en una tabla del nucleo** (4.1), no codigo duplicado:
precondiciones (panel: confirmar/editar solo `imported`; API: editable segun el glosario), `confirmedVia`
(`manual` / `api`), RF_05/RF_15 (no-op en API, error en panel como hoy), RF_23 (la API borra lo derivado de la
direccion; el panel conserva `normalizedAddress` como hoy, spec 013), las indicaciones en blanco
(`deliveryNotes` `""`/`null` **borra solo con politica `api`**; en el panel, unas indicaciones en blanco se
conservan como hoy) y el motivo de cancelar (obligatorio 1-500 en API, opcional en panel).

**Campos extra del panel.** `updateImportedOrder` edita hoy, ademas de los datos de entrega, producto
(`lineItems` y sus derivados), pago, modo, valor, zona, `normalizedAddress` y el resto de campos que hoy
escribe. Con politica `panel`, `planDeliveryCorrection` acepta esos campos en `panelExtras` (4.1): **cuentan
como cambio**, se aplican siempre como hoy (el panel escribe el pedido entero en cada guardado), llevan
`MANUAL_EDIT_STAMP` y auditoria `order.imported_updated`, y el historial registra los que estan en 2.5
(`totalCop`, `productName`, `sku`, `quantity`; RF_16). El adaptador del panel solo traduce la entrada a
`panelExtras` (incluido `resolveEditedOrderLines`, intacto); el nucleo los mete en el parche junto con el sello.
Asi una edicion del panel solo de producto sigue sellando el pedido (la reimportacion no la pisa, spec 017) y la
guarda anti-copia (ningun adaptador contiene el sello) se cumple. Con politica `api`, `panelExtras` no existe: la
validacion de cuerpo lo marca como no permitido (RF_12).

**Escritura en `orders` fuera de `orders.ts`.** `order-seller-actions-run.ts` escribe pedidos, asi que entra
como **quinta exencion** en `IMPORT_WRITE_EXEMPTIONS`, con la razon: "Confirmar, corregir datos de entrega y
anular por decision de la tienda o de la plataforma, por panel o por API; nunca crea pedidos ni toca lider,
mensajero ni catalogo". `store-api*.ts` **no** escribe `orders`: solo llama al ejecutor. Guarda 3 de la 017
pasa de cuatro a cinco (T6). Guarda 7 de la 017, sus dos pruebas (T6b): el sello cuenta en `orders.ts`
(ajustes, 1) + `order-seller-actions.ts` (datos de entrega, 1), con constante y sin literal; y el literal
`["delivered", "failed", "cancelled", "liquidated"]` pasa de 2 a 1 en `orders.ts`, porque el de `cancelOrder`
desaparece al delegar (el nucleo usa `CLOSED_STATUSES`) y queda solo el de inventario, con esa razon escrita en
la guarda.

**Condicion en la transaccion (RF_19).** El planificador se evalua con el pedido leido por
`transaction.get`; si otro escritor (lider que toma el pedido, ChatBy que confirma) cambio el documento,
Firestore reintenta la funcion y la segunda evaluacion ve el estado nuevo: o rechaza con 409 o, en confirmar,
responde no-op (caso limite "ChatBy y API a la vez"). **`expectedStatus` va el ultimo** (paso 8 de 2.1): solo
se mira si nada anterior respondio y la accion cambiaria algo; un no-op responde `unchanged` **aunque
`expectedStatus` no coincida**, y un estado que bloquea (p. ej. `address_risk` al confirmar) responde su 409 de
estado, no `status_changed`. T4, T5 y T6 lo prueban (incluida la carrera simulada: dos planes sobre el mismo
pedido, donde el segundo se evalua con el estado que dejo el primero).

### 2.3 Key de escritura (RF_25, RF_26, RNF_01)

- **Formato:** `kw_` + 45 caracteres base64url de `crypto.randomBytes(34)` → 48 caracteres (las dos lineas de
  24 del diseno). El prefijo `kw_` sirve para distinguirla y para rechazarla barato en query; la key de lectura
  (48 hex) no lo tiene. Se guarda, pero no se muestra como dato aparte (RF_25).
- **Huella:** `sha256(key)` en hex. Sin pepper ni HMAC con secreto: la key tiene ~270 bits de entropia, asi
  que un hash rapido no es atacable por diccionario y no hace falta un secreto nuevo que gestionar. Se guarda
  solo la huella y `last4`. La key completa existe solo en la respuesta de la callable.
- **Comparacion en tiempo constante:** `crypto.timingSafeEqual` entre `sha256(suministrada)` y la huella
  guardada (mismo largo siempre, 32 bytes), y el `safeEqual` de hoy para la de lectura. Se calculan **las dos
  comparaciones siempre**, para no filtrar por tiempo cual de las dos es.
- **Que key se evalua (como hoy).** En una **ruta de lectura** (existente o nueva) la key candidata es
  `queryKey ?? bearer`: **si viene `key` por query, es la unica que se evalua** y la cabecera se ignora, igual
  que hace hoy `store-api.ts`. Una key por query invalida con una Bearer valida da 401 (`invalid_key`), no pasa.
  En una **ruta de escritura**, cualquier `key` por query da 401 `key_in_query` antes de mirar nada (paso 1 de
  2.1, fila 1); sin ella, la candidata es la Bearer.
- **Resolucion de credenciales** (pura, `store-api-auth.ts`, T3). La usan **todas** las rutas, tambien las
  viejas: `store-api.ts` deja su comparacion propia y llama a `resolveStoreCredentials`, conservando la forma de
  error `{ ok: false, error }` de las rutas viejas (conexion y prueba del handler viejo con `db` falso en T10).
  Las filas se evaluan **en este orden** sobre la key candidata; la primera que aplica decide:

| # | Situacion | Ruta de lectura existente | Ruta de lectura nueva | Ruta de escritura |
|---|---|---|---|---|
| 1 | Hay `key` por query (cualquier valor: de lectura, de escritura, valida o no), con o sin cabecera | la candidata es la de query (la Bearer se ignora); sigue a la fila 2 | igual; sigue a la fila 2 | **401 `key_in_query`**, sin comparar nada y antes de mirar parametros. Nunca 403 |
| 2 | Candidata con prefijo `kw_` llegada por query, valida o no | 401 `{ ok:false, error: "invalid_key" }` (forma de hoy, RF_20) | 401 `key_in_query` | (ya cubierto por la fila 1) |
| 3 | Sin `sellerId` o sin candidata | 401 de hoy (`missing_credentials`) | 401 `missing_credentials` | 401 `missing_credentials` |
| 4 | La candidata no coincide, config inexistente o `status != "active"` (tambien si habia una Bearer valida ignorada por venir key en query) | 401 `invalid_key` de hoy | 401 `invalid_key` | 401 `invalid_key` |
| 5 | Candidata = key de lectura valida (query o Bearer en lectura; **solo Bearer** en escritura) | pasa | pasa | **403 `read_only_key`** (unico 403) |
| 6 | Candidata = key de escritura valida por Bearer | pasa (RF_20) | pasa | pasa |

  `key_in_query` sustituye al `write_key_in_query` de la primera version de este plan (nunca desplegado): el
  codigo nombra el sitio prohibido, no el tipo de key. La key de escritura no tiene su propio `status`: existe o
  no. Desactivar la tienda (`status` de la config) apaga las dos.
- **Generar y rotar, atomico** (pendiente 2 del README). Callable `rotateStoreWriteKey({ sellerId, rotate })`
  (roles `admin` y `seller` de esa tienda; `seller_logistics` → `permission-denied`, decision 7 del diseno).
  Todo en **una transaccion** sobre `storeApiConfigs/{sellerId}` que escribe, a la vez, la huella nueva y el
  evento `store_api_key.write_generated` / `store_api_key.write_rotated` en `auditEvents`, **con
  `entityId = sellerId`** (actor, rol, `last4` anterior y nuevo; nunca la key). La transaccion es lo que hace
  verdad la frase de `HU_04.tienda-error` "La que termina en c41e sigue activa. No se genero ninguna clave
  nueva": o se confirman huella y auditoria juntas, o no cambia nada. La key se genera **antes** de la
  transaccion y se devuelve **solo despues** del commit; si el commit falla, la key generada se descarta y nunca
  salio del servidor. Precondiciones dentro de la transaccion: `rotate: false` con una key ya existente →
  `failed-precondition` (no se pisa una key por un doble clic de "Generar"); `rotate: true` sin key →
  `failed-precondition`. Si la config no existe (tienda sin key de lectura), se crea con `status: "active"` y
  sin `apiKey`; las rutas de lectura con key de escritura funcionan igual.
- **Lectura del estado sin secretos (lo que muestra RF_25):** `getStoreApiKeyStatus({ sellerId })` (admin,
  `seller` y `seller_logistics` de esa tienda) y `listStoreApiKeys()` (solo admin, una lectura de
  `storeApiConfigs` + `sellers`; ~14 documentos). Devuelven `StoreApiKeyStatus` (4.2), nunca `apiKey` ni la
  huella. **Lo que la pantalla muestra** es exactamente lo de RF_25 y el diseno de HU_04: que existe, en que
  termina (`last4`), cuando se genero la key vigente (`generatedAt`: la fecha de la ultima generacion o
  rotacion) y quien la genero (`generatedByLabel`). "Generada por" se resuelve en servidor segun quien pregunta
  (decision 3 del diseno): a la tienda "Tu tienda" o "Kentro"; al admin "por la tienda" o el nombre del admin
  (con `getUsers`, como hoy el historial). El prefijo y la fecha de la primera generacion quedan en
  `storeApiConfigs` y no se envian a la pantalla.
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
del guion de verificacion (T27) borra el historial solo de los pedidos de prueba que la verificacion creo.

- Campos registrados: `status` y los datos de entrega (`customerName`, `customerPhone`, `addressRaw`,
  `deliveryNotes`, `cityId`); en el ajuste del admin y en la edicion del panel, ademas `totalCop`,
  `productName`, `sku`, `quantity` (RF_16). **Nunca** `driverId`, `messengerId`, `pickupBatchId` ni nada que
  identifique a una persona de Kentro: el registro dice "paso a `call_pending`", no quien lo tomo.
- Un registro sin cambios no se escribe (RF_05, RF_15: confirmar o cancelar dos veces deja un solo registro).
- Cada registro guarda `auditEventId`: el evento de `auditEvents` de la misma escritura. `getOrderAuditTrail`
  une los dos por ese id (2.7) en vez de duplicar datos. Ese enlace es tambien lo que hace **verificable** un
  evento: solo el servidor puede escribir un `orderHistory` que lo apunte.
- No hay reconstruccion (RF_24): no existe relleno ni ningun modo, guion o funcion que cree `orderHistory` a
  partir de `auditEvents`; un pedido viejo devuelve `[]` hasta su primer cambio.
- Lectura: `where("orderId", "==", id).limit(200)`, orden en memoria por `createdAt` (indice automatico de un
  campo, como hoy `auditEvents`). Se comprueba antes que el pedido es de la tienda (RF_18; pedido ajeno → 404,
  probado en T13); el registro lleva `sellerId` para comprobarlo dos veces (y para el `cleanup`, 5.3).
- **Hueco declarado (limite conocido de RF_16):** las escrituras directas de `status` del lider y del mensajero
  que permite `operationalOrderUpdateByAssignee` no pasan por ninguna callable y no dejan registro. No se cierra
  aqui: spec 032 (1.1, RF_07 de su borrador).

### 2.6 Que callables escriben historial (RF_16)

Un solo constructor, `buildOrderHistoryRecord(before, after, meta)` (en el nucleo puro), que hace el diff de
los campos de 2.5 y devuelve `null` si no hay cambios. **"Escritor de historial"** en este plan es una llamada a
`buildOrderHistoryRecord(` en la propia callable, o a `runConfirm(`/`runDeliveryCorrection(`/`runCancel(`, que lo
hacen dentro del ejecutor. Lo usan, dentro de su transaccion o batch (esta tabla es la misma lista que enumera
RF_16 en la spec):

| Callable | Escritor de historial | Origen | Tarea |
|---|---|---|---|
| `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` | `runConfirm(` / `runDeliveryCorrection(` / `runCancel(` | `panel` | T6b |
| `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder` | `buildOrderHistoryRecord(` junto a su evento (`updateOrderAdjustments` registra `totalCop`/producto) | `panel` | T15 |
| `assignMessengerToOrders`, `unassignMessengerFromOrders` | `buildOrderHistoryRecord(`; cambian `picked_up`↔`call_pending`; solo `status` | `panel` | T16 |
| `createOrUpdatePickupBatch` | `buildOrderHistoryRecord(`; `→ picked_up`; hoy sin auditoria: se le anade evento `order.picked_up` | `panel` | T16 |
| `correctOrderStatus` (`order-corrections.ts`) | `buildOrderHistoryRecord(` en su batch | `panel` | T16 |
| rutas de escritura de la API (`store-api-write.ts`) | via el ejecutor | `api` | T11 |

**Fuera del historial** (con su razon): `createManualOrder` (crea el pedido; RF_16 cubre cambios de uno
existente); `classifyFailedOrder` (solo `failedCategory`); las cinco vias de importacion y ChatBy (`shopify.ts`,
`index.ts`, `store-webhook.ts`, `onstock-webhook.ts`, `contact-form.ts`, `uchat-pull.ts`, `uchat-webhook.ts`;
spec 031); y las escrituras directas del cliente bajo `operationalOrderUpdateByAssignee` (no son codigo de
servidor; spec 032).

**Guarda (T16), por nombre y sin detector generico.** No se reutiliza `writesOrders` ni se toca
`spec-017-guards.test.ts`. En `spec-029-guards.test.ts` hay dos listas explicitas:

- `REGISTRAN_HISTORIAL`: los nombres de la tabla de arriba que viven en `orders.ts` y `order-corrections.ts`;
- `EXCLUIDAS_DEL_HISTORIAL`: cada uno de los **demas** `export const X = onCall(` / `onRequest(` de esos dos
  archivos, con su razon (`createManualOrder`, `classifyFailedOrder`, `getOrderAuditTrail` y el resto de
  exports que T16 encuentre al escribir la lista: lecturas, rotulos, catalogos...).

La guarda extrae con una expresion regular los nombres exportados como `onCall(`/`onRequest(` de
`functions/src/orders.ts` y `functions/src/order-corrections.ts` y comprueba: (1) cada nombre esta en
**exactamente una** de las dos listas, y no hay nombres en las listas que no existan; (2) el cuerpo de cada uno de
`REGISTRAN_HISTORIAL` contiene un escritor de historial; (3) **prueba positiva** de que
`createOrUpdatePickupBatch`, `assignMessengerToOrders` y `unassignMessengerFromOrders` estan en
`REGISTRAN_HISTORIAL` y su cuerpo contiene `buildOrderHistoryRecord(`; (4) **RF_24: `getOrderAuditTrail` es la
unica funcion de `functions/src` que hace `.where(` o `.get(` sobre `collection("auditEvents")`, y su cuerpo no
escribe `orderHistory`; y `scripts/verify-029.js` no tiene ningun modo que escriba `orderHistory`** (no existe
relleno de `orderHistory` desde `auditEvents`). Una callable nueva en esos archivos sin clasificar pone la suite en
rojo. Las vias de importacion y ChatBy viven en otros archivos: quedan fuera por la spec y su escritura en
`orders` la sigue vigilando la guarda 1 de la 017, sin cambios.

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
createdAt, expiresAt }`. **El id empieza siempre por `{sellerId}__`**: los registros de la tienda de pruebas
tienen el prefijo `seller-test-029__`, que es como los reconoce el `cleanup` (5.3). **La decision que vale se
toma dentro de la transaccion** de la escritura: alli se lee el registro, se decide `replay | conflict | fresh`
y, si es `fresh`, se evalua el plan y se guarda la respuesta en la misma transaccion: o las dos cosas, o
ninguna. Antes de abrirla, el handler **puede** leer el registro fuera de la transaccion (paso 3b de 2.1) **solo
como atajo**, para responder pronto un `replay` o un `conflict` sin abrirla; si ese atajo dice `fresh` (o el
registro aun no existe), no decide nada: la transaccion vuelve a leer y manda. Asi dos peticiones simultaneas
con la misma key no pueden aplicar dos veces.

Misma key y mismo `sha256(metodo + ruta + cuerpo canonico)` en 24 h → la respuesta guardada, sin tocar nada.
Misma key con otro hash → 422 `idempotency_key_reused`. Expirado (`expiresAt < now`) → como nuevo. **Se guardan
las respuestas que dependen del pedido** (decision 13): 200 (aplicada o sin cambios), los 409 de los pasos 5 y 8
y los **422 del paso 6** (`field_not_allowed`, `validation_failed`, `no_fields`, `out_of_coverage`); en esos
rechazos el registro idempotente es la unica escritura (2.2). **No se guardan** los 400, 401, 403, 404 y 429, ni
el propio 422 `idempotency_key_reused`: se responden antes de decidir nada sobre el pedido y se recalculan
igual. `Idempotency-Key` de 1 a 255 caracteres imprimibles; fuera de eso, 400 `invalid_idempotency_key`
(paso 3). Limpieza: politica TTL de Firestore sobre `expiresAt` (se crea con `gcloud firestore fields ttls
update`; no va en `firestore.indexes.json`). Reglas: `allow read, write: if false`.

Sin `Idempotency-Key`, un reintento de una accion que ya se aplico es un no-op de estado (RF_05, RF_15) y
responde `changed: false` aunque traiga el `expectedStatus` de antes (2.2).

### 2.9 Limite de tasa (RNF_04)

Ventana fija por minuto: `storeApiRateLimits/{sellerId}__{YYYYMMDDHHmm}` con `count` (mismo prefijo
`{sellerId}__` que 2.8; para la tienda de pruebas, `seller-test-029__`), incrementado en una transaccion corta
**antes** de la de escritura (paso 3a de 2.1). El limite es **una sola constante con nombre**,
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
`cashAllocations` y pedidos parcialmente cubiertos), y T27 lo comprueba en produccion sobre 20 pedidos reales.
Si `buildCodReceivedSet` necesitara algo que `array-contains` no trae, T9 lo encuentra en rojo y se para ahi.

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
| `scripts/verify-029.js` | nuevo | `baseline` (T1), `query-check` (T2), `capture-reads` (RF_20, T24); modulo de salvaguardas y modo `kovia-replay` probados por guardas (T25); `set-history-since` (2.4); **`run-all`**: setup, smoke, `kovia-replay`, `compare-reads`, comparacion de `GET /orders/{id}` y `cleanup` en un solo proceso, con limpieza en `finally` y registro sin secretos; `cleanup --from-registro` (DoD 3, T27) | T1, T2, T24, T25, T27 |
| `functions/src/order-seller-actions.ts` | nuevo, **puro** | politica, `planConfirm`, `planDeliveryCorrection` (con `panelExtras` en politica `panel`), `planCancel` (pasos 4-8 de 2.1), `buildOrderHistoryRecord`, `validateDeliveryInput` (reglas de contenido) | T4, T5 |
| `functions/src/order-seller-actions-run.ts` | nuevo | ejecutor transaccional (2.2); registro idempotente dentro de su transaccion | T6, T12 |
| `functions/src/order-import-merge.ts` | toca | quinta entrada de `IMPORT_WRITE_EXEMPTIONS` | T6 |
| `functions/src/orders.ts` | toca | `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder` delegan; historial en el resto (2.6); `getOrderAuditTrail` con 2.7 | T6b, T14, T15, T16 |
| `functions/src/order-corrections.ts` | toca | registro de historial en su batch | T16 |
| `functions/src/store-api-orders.ts` | nuevo, puro | `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` movidos tal cual desde `store-api.ts` | T9 |
| `functions/src/store-api-auth.ts` | nuevo, puro | formato de la key, huella, `resolveStoreCredentials` (pasos 1-2 de 2.1; tabla de 2.3, con `query ?? bearer` en lectura), `planWriteKeyChange` | T3 |
| `functions/src/store-api-request.ts` | nuevo, puro | enrutado nuevo (paso 0), parametros permitidos por ruta y forma del cuerpo (paso 3, incluido el cuerpo de confirmar), validador de `shopifyOrderId`, `parseWriteBody` (separa `expectedStatus` y **calcula** los errores de campo de `PATCH` y cancelar sin responderlos), construccion del 422 (prioridad de `code`), motivo de cancelar, catalogo de `code`, `buildErrorBody`, hash de cuerpo, `STORE_API_WRITES_PER_MINUTE` y ventana, `decideIdempotency` | T8, T12 |
| `functions/src/store-api-history.ts` | nuevo, puro | `toStoreHistoryResponse` (4.3), `storeActorTag`, `storeSafeSummary`, `isStoreVisibleEvent`, `HISTORY_EXCLUDES`, claves nuevas del indice | T13, T14 |
| `functions/src/store-api-write.ts` | nuevo | handlers HTTP de las rutas nuevas, idempotencia, tasa, carga dirigida (2.10), lista de ciudades activas del 422 | T10, T11, T12, T13 |
| `functions/src/store-api-keys.ts` | nuevo | callables `rotateStoreWriteKey`, `getStoreApiKeyStatus`, `listStoreApiKeys` | T17 |
| `functions/src/store-api.ts` | toca | handler con `db` inyectable; delega rutas nuevas a `store-api-write.ts`; autenticacion de todas las rutas via `resolveStoreCredentials`; rutas viejas con su salida identica; filtro `shopifyOrderId` con forma de error vieja; indice: claves actuales con valor identico + claves nuevas de primer nivel (2.1) | T9, T10, T11, T13 |
| `functions/src/index.ts` | toca | exporta las tres callables nuevas | T17 |
| `firestore.rules` | toca | `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`: `allow read, write: if false`; `settings`: `allow write: if isAdmin() && settingId != "storeApi"` | T7 |
| `src/lib/types.ts` | toca | `OrderAuditEntry` ampliado (4.2), `StoreApiKeyStatus` | T18 |
| `src/lib/firebase/auth.ts` | toca | `fetchFirebaseOrderAuditTrail` devuelve `{ events, historySince }`; `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`, `listFirebaseStoreApiKeys` | T18 |
| `src/lib/store-api-keys-view.ts` | nuevo, puro | estados de la seccion (sin clave / recien generada / activa / error / cargando / solo lectura para el logistico), partir la key en dos lineas de 24, paginacion y busqueda del admin; la clave activa muestra solo lo de RF_25 | T19 |
| `src/lib/order-audit-trail-view.ts` | nuevo, puro | modelo de vista del historial: pildora de origen, nombres de campo visibles (los de entrega y los de producto y valor, ratificados por `sdd-uxui`), "Antes/Ahora", nota de alcance desde `historySince` | T19 |
| `src/components/store-api-write-key.tsx` | nuevo | seccion "Clave de escritura" y dialogo de rotar (un componente para tienda y admin) | T20 |
| `src/components/store-api-keys-admin.tsx` | nuevo | panel "Claves de API de tiendas" (tabla / tarjetas) | T21 |
| `src/components/order-audit-trail.tsx` | nuevo | `OrderAuditTrail` sacado de `operations-app.tsx`, con origen, cambios, nota, vacio, error con "Reintentar" | T22 |
| `src/components/operations-app.tsx` | toca | adaptacion del uso de `fetchFirebaseOrderAuditTrail` a `{ events, historySince }` (T18); montaje; `StoreApiKeyCard` en dos secciones; `AUDIT_ACTION_LABELS` + "Datos de entrega corregidos", "Direccion revisada" y "Recogido"; `CollapsiblePanel` "?" a 44 px | T18, T20, T21, T22, T23 |
| `src/app/api-tiendas/page.tsx` | toca | manual: rutas, codigos y su precedencia, estados editables, `historySince`, exclusiones, key solo por cabecera, ciudades activas | T26 |
| `src/lib/fixtures/029-kovia-order.json` | nuevo | fixture con la forma de Kovia, datos personales e id de Shopify sinteticos (P2) | T25 |
| pruebas `src/lib/*.test.ts` | nuevas | ver 5.1; el ejecutor tiene la suya, `src/lib/order-seller-actions-run.test.ts` (T6, T12) | todas |
| `src/lib/spec-017-guards.test.ts` | toca | guarda 3 (T6) y las dos pruebas de la guarda 7 (T6b) (2.2); nada mas | T6, T6b |
| `src/lib/spec-029-guards.test.ts` | nuevo | un `describe("T<n> · ...")` por tarea; listas `REGISTRAN_HISTORIAL` / `EXCLUIDAS_DEL_HISTORIAL` de T16 | T1-T27, T6b |

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

// Errores de campo calculados por parseWriteBody (T8) en el paso 3 de 2.1 y respondidos en el paso 6.
export type FieldProblem = { field: string; code: "required" | "empty" | "too_long" | "invalid_phone" | "not_allowed" | "invalid_type" };

export const API_EDITABLE_STATUSES = ["imported", "address_risk", "ready_to_assign"] as const;
export const ADDRESS_DERIVED_FIELDS = ["normalizedAddress", "lat", "lng", "geoProvider"] as const;

export type CityFact = { id: string; active: boolean };

export type SellerActionRejection =
  | { code: "order_not_found" }                                   // paso 4 (404)
  | { code: "order_cancelled"; status: "cancelled" }              // paso 5, RF_06 (409)
  | { code: "address_review_pending"; status: "address_risk" }    // paso 5, RF_21 (409), con o sin lider
  | { code: "order_not_editable"; status: string; hasLeader: boolean } // paso 5, RF_04, RF_08, RF_14 (409)
  | { code: "field_not_allowed" | "validation_failed"; fields: FieldProblem[] } // paso 6, RF_09 (422)
  | { code: "no_fields" }                                         // paso 6 (422)
  | { code: "out_of_coverage"; field: "cityId" }                  // paso 6, RF_10 (422)
  | { code: "status_changed"; status: string }                    // paso 8 (409)
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
export function planDeliveryCorrection(i: PlanInput<DeliveryInput & { expectedStatus?: string; city: CityFact | null; panelExtras?: PanelEditExtras; fieldProblems?: FieldProblem[] }>): SellerActionRejection | SellerActionPlan;
export function planCancel(i: PlanInput<{ reason?: string; expectedStatus?: string; fieldProblems?: FieldProblem[] }>): SellerActionRejection | SellerActionPlan;
// PlanInput<T> = { policy; actor; order: Record<string, unknown> & { id: string }; input: T; now: string }
// panelExtras con policy "api" es un error de programacion (lanza): la validacion de la API nunca lo produce.
// planConfirm no recibe fieldProblems: su cuerpo invalido ya se respondio con 400 en el paso 3 (decision 13).
```

**`isApiEditable`:** estado en `API_EDITABLE_STATUSES` **y** `driverId` nulo, ausente o `""`.

**Orden comun de evaluacion (API), pasos 4-9 de 2.1:** 4) tienda (`order_not_found`); 5) **estado**
(`order_cancelled`, `address_review_pending`, `order_not_editable`); 6) **validacion y cobertura**
(`fieldProblems` de `parseWriteBody` → `field_not_allowed` / `validation_failed`; `no_fields`; ciudad no
cubierta, aunque sea la misma → `out_of_coverage`); 7) **no-op** → `unchanged`, sin evento ni historial;
8) **`expectedStatus`** presente y distinto → 409 `status_changed` (solo llega aqui si la accion cambiaria
algo); 9) aplicar. El panel no manda `expectedStatus` ni `fieldProblems` y conserva sus errores de hoy.

**Confirmar** (actor de tienda con `order.sellerId` distinto → `order_not_found` en API, `permission-denied` de
hoy en panel; cuerpo con algo distinto de `expectedStatus`, o tipo invalido → 400 `invalid_body` en el paso 3):

| Paso | Estado real | API | Panel (como hoy) |
|---|---|---|---|
| 5 | `cancelled` | 409 `order_cancelled` | error de hoy |
| 5 | `address_risk` (con o sin lider, con o sin `expectedStatus`) | 409 `address_review_pending` (RF_21 prevalece sobre `order_not_editable` y sobre `status_changed`) | error de hoy |
| 5 | `imported` con lider (anomalo) | 409 `order_not_editable`, `hasLeader: true` (RF_04) | aplica como hoy |
| 7 | `ready_to_assign` o posterior, no cancelado (incluidos los finales) | 200 `changed: false`, sin evento ni historial (RF_05), **aunque `expectedStatus` no coincida** | error de hoy |
| 8 | `imported` sin lider con `expectedStatus` presente y distinto | 409 `status_changed` | — (el panel no lo manda) |
| 9 | `imported` sin lider | → `ready_to_assign`, `addressRisk: "accepted"`, `confirmedVia: "api"`, evento `order.seller_confirmed` con `actorRole: "store_api"`, historial `status` | igual con `confirmedVia: "manual"` |

**Corregir datos de entrega** (`PATCH` en la API; `updateImportedOrder` en el panel):

1. Paso 4: tienda.
2. Paso 5: API: `!isApiEditable` → 409 `order_not_editable` con `status` y `hasLeader` (cubre `in_route`,
   `call_pending`, `address_risk` con lider, `imported` con lider y finales). Panel: solo `imported` (hoy).
3. Paso 6: API: si hay `fieldProblems` → 422 con todos (4.4); si no hay ningun campo de entrega → 422
   `no_fields`; si viene `cityId`, `city` leido en la transaccion, y ausente o `active !== true` → 422
   `out_of_coverage` con la lista de ciudades activas (RF_10, P4), **aunque `cityId` sea el que ya tiene el
   pedido**.
4. Diff campo a campo contra lo guardado, con valores recortados. `deliveryNotes`:
   - politica `api`: `null` o `""` borra (unica excepcion de RF_09 a "vacio = invalido");
   - politica `panel`: unas indicaciones en blanco **se conservan** como hoy (no entran en el parche ni en el
     diff).
5. **`address_risk` sin lider (RF_22, P1, solo API):** `status: "imported"`, `addressRisk: "review"`, **aunque
   ningun campo cambie de valor** (por eso nunca es no-op): es la unica forma de que la integracion lo
   desbloquee, porque confirmarlo da 409.
   - Sin campos cambiados → evento y historial con accion **`order.address_reviewed`** ("direccion
     revisada"), `fromStatus: "address_risk"`, `toStatus: "imported"`, `changes` con solo `status`.
   - Con campos cambiados → accion `order.delivery_corrected`, `changes` con `status` y cada campo.
   - Nunca se emite `address_risk` (invariante probada: ningun plan de politica `api`, para ningun estado de
     partida ni accion, tiene `patch.status === "address_risk"`).
6. Paso 7: API: sin ningun campo que cambie de valor y fuera del caso 5 → `unchanged`, aunque `expectedStatus`
   no coincida.
7. Paso 8: API: `expectedStatus` presente y distinto → 409 `status_changed`.
8. **Campos extra del panel (`panelExtras`, solo politica `panel`):** se anaden al parche tal cual, siempre,
   como hoy (el panel escribe el pedido entero en cada guardado) y **cuentan como cambio**: con politica
   `panel` el plan es siempre `applied`, con sello y evento `order.imported_updated`, aunque solo cambie el
   producto. El historial lleva los campos registrados (2.5) que cambiaron de valor (`totalCop`,
   `productName`, `sku`, `quantity` y los de entrega); si ninguno cambio, `history: null` pero el sello y el
   evento se escriben igual, como hoy.
9. Si cambia `addressRaw` y la politica es `api` → `clear = ADDRESS_DERIVED_FIELDS` presentes en el pedido
   (RF_23). Politica `panel`: conserva como hoy (o aplica el `normalizedAddress` de `panelExtras` si viene).
10. Paso 9: `patch` = campos cambiados (+ `panelExtras` en politica `panel`) + `[MANUAL_EDIT_STAMP]: now` (RF_11,
    puesto por el nucleo) + `updatedAt`; evento `order.delivery_corrected` (API) / `order.imported_updated`
    (panel), con `fromStatus/toStatus` si cambio el estado; historial con cada campo registrado que cambio y
    `status` si cambio. El sello tambien se pone en el caso `order.address_reviewed`: la tienda ha decidido
    sobre la direccion y una reimportacion no debe deshacerlo. Producto, cantidad, valor, pago y modo no existen
    en `DeliveryInput` (RF_12): mandarlos por API sale como `not_allowed` en el paso 6.

**Cancelar:**

| Paso | Estado real | API | Panel |
|---|---|---|---|
| 5 | en curso o final no cancelado | 409 `order_not_editable` (RF_14; incluye `assigned`, `imported` con lider y `address_risk` con lider) | como hoy |
| 6 | motivo ausente, vacio o > 500 (o claves no permitidas) | 422 `validation_failed` / `field_not_allowed` | — (opcional en panel) |
| 7 | `cancelled` | 200 `changed: false` (RF_15), **aunque `expectedStatus` no coincida** | error de hoy |
| 8 | editable con `expectedStatus` presente y distinto | 409 `status_changed` | — |
| 9 | editable (`isApiEditable`) | → `cancelled`, `closedAt`, `callNote = reason`, **`driverId: current.driverId ?? null` como hoy** (en un editable vale `null`; se conserva la forma del parche de `cancelOrder` para el panel), libera inventario si `orderOwnsInventoryReservation` y no `imported` (misma regla de hoy), evento `order.cancelled`, historial `status` | igual que hoy, con su precondicion por rol (admin cualquiera no cerrado; tienda no recogido) y el mismo parche, incluido `driverId: current.driverId ?? null` |

### 4.2 Tipos guardados y de UI

```ts
// storeApiConfigs/{sellerId} — campos NUEVOS (los de lectura no cambian)
export type StoreWriteKeyFields = {
  writeKeyHash?: string;            // sha256 hex de la key completa
  writeKeyPrefix?: "kw_";           // se guarda; no se muestra (RF_25)
  writeKeyLast4?: string;
  writeKeyCreatedAt?: string;       // primera generacion; se guarda, no se muestra
  writeKeyRotatedAt?: string;       // ultima rotacion; ausente si nunca se roto
  writeKeyGeneratedBy?: { uid: string; role: "admin" | "seller" }; // quien genero la key vigente
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
// eventos de la key de escritura (store_api_key.write_generated / write_rotated): entityId = sellerId

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

// Exactamente lo que muestra RF_25 (y el diseno de HU_04): existe, termina en, generada, generada por.
export type StoreApiKeyStatus = {
  sellerId: string; sellerName: string;
  read: { exists: boolean; status: "active" | "inactive" | "none" };   // nunca la key
  write: { exists: false } | {
    exists: true;
    last4: string;                            // "termina en"
    generatedAt: string;                      // fecha de la key vigente: writeKeyRotatedAt ?? writeKeyCreatedAt
    generatedByLabel: string;                 // "Tu tienda" | "Kentro" | "por la tienda" | nombre del admin
  };
  canManageWrite: boolean;                    // false para seller_logistics
};
// rotateStoreWriteKey -> { status: StoreApiKeyStatus; writeKey: string; previousLast4: string | null }
```

### 4.3 Respuestas de las rutas nuevas

```ts
export type StoreApiErrorCode =
  | "unknown_parameter" | "invalid_shopify_order_id" | "invalid_idempotency_key" | "invalid_json" | "invalid_body"
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
`invalid_json`, `invalid_body`), 401 (`missing_credentials`, `invalid_key`, `key_in_query`), 403 (`read_only_key`,
unico 403), 404 (`order_not_found`), 405, 409 (`status_changed`, `order_cancelled`, `address_review_pending`,
`order_not_editable`), 422 (`validation_failed`, `field_not_allowed`, `out_of_coverage`, `no_fields`,
`idempotency_key_reused`), 429, 503 (`history_not_ready`), 500. La tabla vive en `store-api-request.ts`, junto con
la **precedencia** de 2.1; una prueba fija que ningun `code` existente cambia de nombre ni de HTTP (RNF_02: se
agregan, no se renombran).

El registro de historial que sale por la API es `{ at, origin, action, changes }`: sin `actor`, sin `uid`, sin
`auditEventId` (RF_18). `toStoreHistoryResponse` es una funcion con lista explicita de claves de salida.

### 4.4 Validacion de cuerpos (RF_04, RF_09, RF_12, RF_13)

**Confirmar** (decision 13): el cuerpo es vacio o `{ expectedStatus }` con `expectedStatus` texto. Cualquier
otra clave, o un tipo invalido, → **400 `invalid_body`** en el paso 3 (no hay validacion de contenido que
diferir).

**`PATCH` y cancelar: se calculan todos los problemas a la vez en el paso 3 de 2.1 y se responden juntos en el
paso 6**, despues de 404 y de los 409 de estado. `parseWriteBody` (`store-api-request.ts`, T8):

1. JSON valido; si no, **400 `invalid_json`**. Objeto; si no (array, numero, texto), **400 `invalid_body`**. Se
   separa `expectedStatus` (texto opcional) **antes** de validar: nunca cuenta como campo.
2. **Claves no permitidas.** Cada clave fuera de las permitidas de la ruta se anota con `code: "not_allowed"`.
3. **Forma y tipos de las claves permitidas** (Zod, solo forma y tipos basicos: `string`, o `null` en los
   campos donde `null` tiene significado). Un tipo incorrecto se anota con `code: "invalid_type"`.
4. **Contenido de las claves permitidas con tipo correcto:** `validateDeliveryInput` (nucleo puro, T5) para
   `PATCH`; el motivo para cancelar. Cada fallo se anota con su motivo (`required`, `empty`, `too_long`,
   `invalid_phone`).
5. **Resultado:** `{ input, expectedStatus, fieldProblems }`, sin responder. El planificador (4.1) lo convierte,
   en el paso 6, en 422 con **todos** los campos anotados de los dos tipos, cada uno con su motivo; `code` de
   primer nivel `field_not_allowed` si hay al menos un `not_allowed`, si no `validation_failed`. Nada se aplica.

| Campo | Regla de contenido |
|---|---|
| `customerName` | texto, recortado 1-120; vacio o `null` → `empty` |
| `customerPhone` | quitando espacios, guiones, puntos y parentesis: 10 digitos (`^\d{10}$`), o `+57` + 10 digitos, o E.164 `^\+[1-9]\d{7,14}$`. Se guarda recortado tal como vino (no se reformatea: ChatBy compara por los ultimos 10 digitos); vacio o `null` → `empty` |
| `addressRaw` | recortado 1-300; vacio o `null` → `empty` |
| `deliveryNotes` | `null` o `""` (tambien solo espacios) **borra** las indicaciones (unica excepcion de RF_09, solo API); si no, 1-500 |
| `cityId` | `^[a-z0-9-]{1,64}$`; vacio o `null` → `empty`; la cobertura se decide en la transaccion, en el paso 6, antes del no-op (RF_10) |
| `reason` (cancelar) | obligatorio; recortado 1-500; ausente → `required`, vacio → `empty`, mas de 500 → `too_long` |
| cualquier otra clave | `not_allowed` (incluye producto, valor, pago, modo, `status`, `driverId`) |

Cuerpo de `PATCH` sin ningun campo de entrega permitido y sin problemas (solo `expectedStatus`, o vacio) → 422
`no_fields` en el paso 6 (`{ deliveryNotes: null }` si es un campo y no da `no_fields`). El ejemplo del DoD
"telefono valido + ciudad no cubierta" da 422 `out_of_coverage` nombrando `cityId` y no aplica el telefono.

### 4.5 Coste por peticion (RNF_05)

| Ruta | Lecturas | Escrituras |
|---|---|---|
| autenticacion | 1 (`storeApiConfigs/{sellerId}`) | — |
| `GET /orders/{id}` | 1 pedido + asientos del pedido (≈3-8) + cortes que lo contienen (≈1-3) | — |
| `GET /orders/{id}/history` | 1 pedido + registros (decenas) + `settings/storeApi` | — |
| escritura | tasa (1+1) + atajo de idempotencia (0-1) + idempotencia en transaccion (1) + pedido (1) + ciudad (0-1) + inventario de la tienda si libera + payload (≈10); `cities` activas solo en el 422 | pedido, evento, historial, idempotencia (en un 409 o en un 422 del paso 6, solo idempotencia; en un no-op, solo idempotencia si trae key) |

Nada depende del numero de pedidos de la tienda. T27 mide p95 en produccion (objetivo < 2 s, contando arranque
en frio aparte).

## 5. Estrategia de testing

### 5.1 Mapa requisito → prueba → tarea

| Req. | Prueba | Tarea |
|---|---|---|
| RF_01 | `GET /orders/{id}` == elemento de `GET /orders` (fixtures, carga dirigida vs completa); 404 ajeno = 404 inexistente (mismo HTTP y cuerpo); recuento en prod de cortes con `cashAllocations` fuera de `orderIds` (esperado 0); **en prod, 20 pedidos reales comparados con su elemento de `GET /orders`, solo lectura y key de lectura** | T1, T2, T9, T10, T27 |
| RF_02 | filtro por `shopifyOrderId` solo de la tienda; ignora `from`/`to`; aplica `status` y `limit`; numero repetido entre tiendas | T10 |
| RF_03 | parametro desconocido → 400 nombrandolo, en cada ruta nueva; `shopifyOrderId` mal formado → 400 con forma vieja (validador); rutas viejas siguen ignorando | T8, T10 |
| RF_04, RF_05 | `planConfirm`: `imported` → `ready_to_assign` + `accepted` + `confirmedVia: "api"`; dos veces → un registro; `imported` con lider → `order_not_editable`; `ready_to_assign` con `expectedStatus: "imported"` → `unchanged`, no 409; **cuerpo de confirmar con otra clave o tipo invalido → 400 `invalid_body`** | T4, T6, T8 |
| RF_06, RF_21 | `cancelled` → `order_cancelled`; `address_risk` con y sin lider, y con `expectedStatus` distinto → `address_review_pending` | T4 |
| RF_07, RF_08 | solo campos enviados; corregir no confirma; `in_route`, `call_pending`, `address_risk` con lider → 409 sin cambios (tambien con campos invalidos: 409 antes que 422) | T5 |
| RF_09, RF_10 | errores de campo calculados en `parseWriteBody` y respondidos en el paso 6, con prioridad de `code` (4.4) y tabla de contenido (incluida la excepcion de `deliveryNotes`, solo API); telefono valido + ciudad inactiva → 422 `cityId` con `activeCities`, telefono intacto; **misma ciudad que ya tiene el pedido, desactivada → 422, no `unchanged`** | T5, T8, T11 |
| RF_22 | `address_risk` sin lider → `imported` + `review`, tambien con valores identicos (`order.address_reviewed`); confirmar despues → `ready_to_assign`; invariante "nunca `address_risk`" | T5 |
| RF_23 | cambio de direccion → `clear` con los cuatro campos; sin cambio de direccion → `clear` vacio | T5 |
| RF_11 | el plan lleva `MANUAL_EDIT_STAMP` (tambien una edicion del panel solo de producto); `mergeImportedOrder` sobre el resultado conserva cliente y direccion con el fixture de forma Kovia (T25); en prod, replay firmado con tienda e id sinteticos y salvaguardas (T27) | T5, T6, T25, T27 |
| RF_12 | `not_allowed` para producto, cantidad, valor, pago, modo | T5, T8 |
| RF_13-RF_15 | cancelar editable con motivo + inventario `release` y `driverId: current.driverId ?? null`; `assigned` → 409; dos veces → un registro; `cancelled` con `expectedStatus` distinto → `unchanged`; sin motivo → 422; motivo de 1 y 500 pasa, de 501 no | T4, T6, T8 |
| RF_16 | `buildOrderHistoryRecord` (diff, `null` sin cambios, campos de identidad nunca; producto y valor en la edicion del panel); guarda de 2.6 **por nombre** (`REGISTRAN_HISTORIAL` / `EXCLUIDAS_DEL_HISTORIAL` sobre los exports de `orders.ts` y `order-corrections.ts`) con prueba positiva de recogida y mensajero; solo el `cleanup` borra `orderHistory`, y solo de `seller-test-029` | T5, T7, T15, T16, T25, T27 |
| RF_17 | respuesta con `historySince`, `excludes` y `aviso`; 503 `history_not_ready`; el indice lo dice en claves nuevas; el manual tambien; `settings/storeApi` no escribible desde el cliente | T7, T13, T26 |
| RF_18 | `toStoreHistoryResponse` sin `actor`/`uid`/`auditEventId`; historial de pedido ajeno → 404 | T13, T14 |
| RF_19 | guarda anti-copia (5.2); condicion dentro de la transaccion; precedencia de 2.1 (`status_changed` el ultimo); carrera simulada (dos planes sobre el mismo pedido); un rechazo no escribe en `orders`, `auditEvents` ni `orderHistory`; la decision de idempotencia se toma dentro de la transaccion | T4, T5, T6, T6b, T11, T12 |
| RF_20 | handler viejo con `db` falso tras conectar `resolveStoreCredentials` (key de lectura y de escritura, 400 de `shopifyOrderId` con forma vieja); indice: valores de las claves actuales identicos y documentacion solo en claves nuevas de primer nivel; `compare-reads` **sobre datos congelados al capturar** (5.3): `/kpis`, `/orders`, `/settlements` e indice por valor, `/resumen` por forma; **en tiendas reales solo con su key de lectura; con key de escritura, solo en la tienda de pruebas**; errores viejos con `{ ok, error }` | T9, T10, T13, T24, T27 |
| RF_24 | sin relleno: `getOrderAuditTrail` es la unica funcion que consulta `auditEvents` (`.where(`/`.get(`) y no escribe `orderHistory`; ningun modo del guion escribe `orderHistory` | T16 |
| RF_25, RF_26 | `planWriteKeyChange`; atomicidad (transaccion con huella + auditoria, evento con `entityId = sellerId`); `createStoreApiKey` no toca `writeKey*`; el estado trae solo `exists`, `last4`, `generatedAt` y `generatedByLabel` y la pantalla solo los muestra a ellos (ni prefijo ni fecha de rotacion), nunca la key; "?" de 44 px del panel de la clave (diseno de HU_04) | T3, T17, T19, T20, T21, T23 |
| RF_27 | `storeActorTag`, `storeSafeSummary`, `isStoreVisibleEvent` (mitigacion hasta la 032: no verificable fuera de la lista → descartado para la tienda); `getOrderAuditTrail` para `seller`/`seller_logistics` sin identidades y sin `getUsers`; admin igual que hoy mas `apiKeyLast4` y "Clave de escritura de <tienda>"; en prod, eventos con forma historica sembrados sobre un pedido de `seller-test-029`; guarda de pantalla: `order-audit-trail.tsx` no pinta `actorEmail` cuando hay `storeActorTag` | T14, T22, T27 |
| RNF_01 | tabla 2.3 completa (cualquier key por query en escritura → 401, **tambien con un parametro desconocido**; `kw_` por query en lectura vieja y nueva → 401; en lectura, `query ?? bearer`: query invalida + Bearer valida → 401; 403 solo para key de lectura en la cabecera); handler viejo conectado; 404 identico | T3, T8, T10 |
| RNF_02 | catalogo de codigos congelado; forma `{ ok:false, code, message, fields? }`; **precedencia (decision 12): una prueba por cada par de pasos vecinos de 2.1** (key en query vs parametro; credenciales vs parametro; parametro vs 429; 429 vs idempotencia; idempotencia vs 404; parametro vs 404; 404 vs 409; 409 vs 422; 422 vs no-op; no-op vs `status_changed`) | T3, T4, T5, T8, T11 |
| RNF_03 | misma key mismo cuerpo → misma respuesta sin aplicar; otro cuerpo → 422; expirado → nuevo; **un 409 y un 422 del paso 6 se guardan y se repiten**; 400/401/403/404/429 no se guardan; el atajo previo no decide `fresh` | T12 |
| RNF_04 | ventana, 429 + `Retry-After`, nunca 403; la cifra solo en `STORE_API_WRITES_PER_MINUTE` | T8, T12 |
| RNF_05 | guarda: `functions/src/store-api-write.ts` no contiene `where("sellerId"` sin un segundo filtro ni `collection("settlements").get()`; p95 medido | T10, T27 |

### 5.2 Guardas de fuente (`spec-029-guards.test.ts`, mismo patron que la 017 y la 026: fuente sin comentarios)

- **Anti-copia (RF_19, T6b y T11):** `orders.ts` (`confirmImportedOrder`, `updateImportedOrder`, `cancelOrder`) y
  `store-api-write.ts` llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel`; ninguno de esos cuerpos
  contiene `status: "ready_to_assign"`, `status: "cancelled"`, `addressRisk: "accepted"` ni
  `[MANUAL_EDIT_STAMP]` (el sello lo pone el nucleo, tambien para los campos extra del panel); mutacion
  comprobada a mano (pegar el parche de confirmar en `store-api-write.ts` pone la guarda en rojo) en
  `EV/mutacion-rf19.txt`.
- **Nadie mas escribe `orders`:** guarda 1 de la 017 sigue en verde, sin cambios; `store-api*.ts` y
  `store-api-keys.ts` no escriben pedidos.
- **Historial por nombre (2.6, T16):** las listas `REGISTRAN_HISTORIAL` y `EXCLUIDAS_DEL_HISTORIAL` cubren
  exactamente los `export const X = onCall(`/`onRequest(` de `orders.ts` y `order-corrections.ts`; cada una de
  `REGISTRAN_HISTORIAL` contiene un escritor de historial; prueba positiva para `createOrUpdatePickupBatch`,
  `assignMessengerToOrders` y `unassignMessengerFromOrders`; `getOrderAuditTrail` es la unica funcion que consulta
  `auditEvents` y no escribe `orderHistory`; ningun modo del guion escribe `orderHistory`. T15 comprueba sus
  cuatro callables por nombre.
- **Carga dirigida (RNF_05, T10):** `functions/src/store-api-write.ts` no contiene `where("sellerId", "==", ...)`
  sin segundo filtro ni `collection("settlements").get()`.
- **Identidades y mitigacion (2.7, T14)**, **`historySince` sin literal (2.4, T7)**, **reglas** (tres colecciones
  nuevas con `allow read, write: if false` y `settings` acotada con `settingId != "storeApi"`, T7), **la key no
  sale** (`store-api-keys.ts` solo devuelve `writeKey` en `rotateStoreWriteKey` y nunca escribe `writeKey:` en
  Firestore; ningun `console.*`/`logger.*` recibe la key ni la cabecera `authorization`; T17), **limite en un
  solo sitio** (el literal `120` asociado a escrituras por minuto solo aparece en
  `STORE_API_WRITES_PER_MINUTE`; T8), **el secreto de Shopify y la key de escritura no salen del proceso** (ni
  disco, ni logs, ni el registro de `run-all`; T25, T27), **salvaguardas de los envios de prueba, del admin
  desechable y del `cleanup`** (5.3 (a)-(d); T25, T27).
- **UI:** `operations-app.tsx` solo monta los componentes nuevos (T20-T22); `localStorage` no aparece en
  `store-api-write-key.tsx` (T20); el "?" de `CollapsiblePanel` no usa `h-8 w-8` (T23).

### 5.3 Canal del cliente: verificacion contra produccion (DoD 3)

Las rutas son HTTP y la UI usa callables: se prueban **por su canal**, no reimplementando la regla en un
script (memoria "verificar por el canal del cliente"). **Toda la verificacion con escrituras se hace sobre la
tienda de pruebas.**

- **Compuerta del anexo A (T27):** el recorrido real no empieza mientras el anexo A de la spec tenga algun
  criterio CA_01-CA_12 "pendiente de transcribir". La transcripcion la hace la sesion principal con el
  responsable a partir del documento de CENTRAL (2-oct-2026); no es trabajo de codigo.
- **Un solo proceso (`run-all`, T27).** Todo lo que escribe en produccion (setup de la tienda de pruebas,
  generacion de la key de escritura, smoke de CA_01-CA_12, `kovia-replay`, siembra de eventos de RF_27,
  `compare-reads` sobre la tienda de pruebas, comparacion de `GET /orders/{id}`, p95) corre en **un unico
  proceso** de `node scripts/verify-029.js run-all`, con el `cleanup` en un bloque `finally` que se ejecuta pase
  lo que pase. La **key de escritura** de la tienda de pruebas se genera (y, si la prueba lo pide, se rota) con la
  callable dentro de ese proceso y **nunca sale de memoria**: ni disco, ni evidencia, ni logs. A medida que crea
  cosas, el proceso **anade a `EV/t27-registro.json` un registro sin secretos** (solo ids de documentos, `uid` de
  usuarios, ids de corridas de `importRuns` y el dominio de la tienda de Shopify de prueba; nunca keys,
  contrasenas, tokens ni secretos), escrito antes de cada creacion para que un fallo no deje nada sin anotar.
  Si el proceso se cae antes de su `finally`, **`node scripts/verify-029.js cleanup --from-registro`** lee ese
  registro y limpia con las mismas reglas de pertenencia (c); el registro queda en la evidencia con el resultado
  del `cleanup`. `capture-reads` (T24) es aparte y anterior al despliegue: solo lee y no necesita limpieza.
- **Sesiones (DoD 3, decision 12 (c) de la spec):**
  - **tienda de pruebas** (OPC_04, operativa): `seller-test-029`, creada por el setup de `run-all` con un
    usuario `seller` y uno `seller_logistics` desechables (contrasena aleatoria, solo en memoria; claim
    `sellerId: "seller-test-029"`), en `city-cali` (ya activa), con **su propia config de webhook de tienda de
    prueba** (la que usa `storeOrderWebhook`; secreto de prueba generado para la ocasion, solo en memoria) y con
    su key de lectura obtenida con `createStoreApiKey` (para la comparacion lectura/escritura). La key de
    escritura la genera **la callable** con la sesion `seller`. Ninguna sesion de tienda se crea sobre una tienda
    real;
  - **admin desechable, aceptado explicitamente** (como en `verify-022` y `verify-026`): lo crea el setup,
    registra su `uid`, lo usa solo sobre la tienda de pruebas (comprobar el historial como admin, RF_27; generar
    o ver el estado de la key desde el panel de admin) y lo borra en el `cleanup`. **Guarda (T27):** toda
    escritura del guion, con cualquier sesion o con el Admin SDK, apunta solo a ids de prueba (5.3 (c)); las
    llamadas del admin desechable a callables de escritura solo llevan `sellerId: "seller-test-029"` o ids de
    pedidos de prueba;
  - **sin lider ni mensajero desechables:** el pedido de prueba "con lider" se prepara con el **Admin SDK**,
    poniendo su `status` en `assigned` y su `driverId` a un id sintetico (`driver-test-029`, que no es un usuario).
    Ese paso **no va por el canal del cliente** y se declara asi en la evidencia. No se crean `drivers`,
    `pickupBatches` ni usuarios de lider o mensajero de prueba.
- **Salvaguardas obligatorias de todo envio por webhook o replay y de toda limpieza** (`storeOrderWebhook` y
  `shopifyWebhook`, ambos dentro de `run-all`), implementadas en el guion (T25 escribe el modulo y sus guardas;
  T27 lo ejecuta) y comprobadas por guardas de fuente:
  - **(a) Comprobacion previa:** justo antes de **cada** envio, el guion lee el documento que esa via crearia
    (`orders/shopify-<id>` en Shopify; el id equivalente que deriva `storeOrderWebhook`) y **aborta** si ya
    existe, sin enviar nada. Un envio nunca puede caer sobre un pedido existente.
  - **(b) Ids claramente sinteticos:** donde el esquema lo permite, los ids externos llevan prefijo o rango de
    prueba inconfundible: id de pedido de Shopify numerico en un rango reservado declarado en el guion
    (p. ej. `9029000000000`-`9029000000999`, fuera del rango de ids reales), numero de pedido con prefijo
    `TEST-029-`, id externo del webhook de tienda con prefijo `test-029-`, dominio `kentro-test-029.myshopify.com`,
    lider `driver-test-029`.
  - **(c) Limpieza con prueba de pertenencia por coleccion.** El `cleanup` (en el `finally` de `run-all` y en
    `cleanup --from-registro`) borra solo con `safeDelete`, que **lee cada documento y comprueba su pertenencia
    segun su coleccion** antes de borrarlo; si no pertenece, **se niega** (aborta con error, sin borrar el resto
    del lote). Una coleccion sin regla en esta tabla no se puede borrar:

    | Coleccion | Pertenece a la prueba si |
    |---|---|
    | `orders`, `orderHistory` | `sellerId == "seller-test-029"` |
    | `walletEntries` | `orderId` esta en los ids de pedidos de prueba (los del registro, leidos de vuelta con `sellerId == "seller-test-029"`) |
    | `auditEvents` | `entityId` esta en los ids de pedidos de prueba o `entityId == "seller-test-029"` (los eventos de la key de escritura usan `entityId = sellerId`, 2.3) |
    | `inventory`, `productCatalog` | `sellerId == "seller-test-029"` |
    | `sellers`, `storeApiConfigs` | id de documento `== "seller-test-029"` |
    | `storeApiIdempotency`, `storeApiRateLimits` | id de documento empieza por `"seller-test-029__"` (2.8, 2.9) |
    | `shopifyStores` | su dominio es el sintetico (`kentro-test-029.myshopify.com`) |
    | `importRuns` | su id esta en el registro del guion |
    | `storeWebhookSamples`, `shopifySyncIssues` | referencian un id de pedido de prueba o `sellerId == "seller-test-029"` |
    | usuarios de Auth | su `uid` esta en el registro del guion (los de la tienda de pruebas y el admin desechable) |
    | config de webhook de tienda de prueba | su clave es `seller-test-029` |

  - **(d) Guardas de fuente** que comprueban (a), (b) y (c), que el guion solo escribe ids de prueba y que el
    registro no lleva secretos, en `scripts/verify-029.js` (T25, T27).
  - **Contador de `trackingCode`:** cada pedido creado por webhook consume un numero del contador real; los
    numeros consumidos no se recuperan. **Aceptado** (son pocos y el contador no tiene que ser contiguo).
- **Lecturas reales: `capture-reads` (T24) y `compare-reads` (T27), RF_20.** Contra tiendas reales **solo con su
  key de lectura existente**; con **key de escritura**, **solo sobre la tienda de pruebas** (unica tienda con key
  de escritura durante la verificacion; en unidad, T10 la cubre con el handler viejo y un `db` falso). Para que
  la comparacion no dependa de la operacion del dia, **solo se comparan datos congelados al capturar**:
  - `/kpis`, `/orders` y `/settlements` se piden con **rangos cerrados del pasado** (`from` y `to` anteriores al
    dia de la captura, iguales en la captura y en la comparacion);
  - de `/orders` y `/settlements` solo se comparan los **pedidos y cortes con `updatedAt` anterior a
    `captureAt`** que sigan con ese mismo `updatedAt` en la comparacion; los que se movieron entre medias se
    excluyen de los dos lados y se cuentan en la evidencia;
  - **`/resumen` se compara solo por forma** (mismas claves, mismos tipos), porque resume el estado actual de la
    tienda (saldos y pedidos abiertos de hoy) y ningun rango lo congela; esa razon queda escrita en el guion;
  - el **indice**: valor identico de cada clave actual; solo se admiten claves nuevas de primer nivel;
  - **tolerancia declarada:** cero diferencias en los datos comparados por valor; solo se ignoran los campos de
    marca de tiempo de la propia respuesta listados en el guion (p. ej. la hora de generacion), y nada mas.
- **`GET /orders/{id}` contra `GET /orders` en produccion (RF_01, T27):** sobre **20 pedidos reales** de Kovia,
  ONEP y DANDA, solo lectura y con la key de lectura de cada tienda, en la misma corrida: el elemento de
  `GET /orders` y la respuesta de `GET /orders/{id}` son iguales por valor (mismo esquema y mismo pago).
- **Escrituras solo sobre pedidos de la tienda de pruebas:**
  - el pedido **`imported`** para los CA del anexo A y RF_04/RF_05 entra **por el `storeOrderWebhook` de
    `seller-test-029`** (con su config de webhook de prueba y las salvaguardas de arriba), como entran los
    pedidos reales de esa via, y no con `createManualOrder`;
  - uno en `address_risk`, creado con el alta manual (`createManualOrder`, sesion de la tienda) marcada
    "revisar" (`addressRisk: "review"`), que es la via que hoy produce ese estado, para RF_21 y RF_22 (con y sin
    cambio de valores);
  - uno "con lider" para RF_08 y RF_14, creado por la tienda y preparado con el Admin SDK (`status: "assigned"`,
    `driverId: "driver-test-029"`; fuera del canal del cliente, declarado);
  - uno con inventario reservado, para RF_13 (con `inventory` y `productCatalog` de prueba de `seller-test-029`).
  Los CA_01-CA_12 se recorren tal como quedan en el anexo A, con CA_03 corregido (confirmar `imported`).
- **RF_27 con sesion real:**
  - sobre un pedido de prueba con eventos del admin desechable, de la propia tienda y de la API:
    `getOrderAuditTrail` con la sesion `seller` y con la `seller_logistics` de la tienda de pruebas, y con la del
    admin desechable;
  - **eventos con forma historica (anteriores a la spec):** el guion **siembra con el Admin SDK**, sobre un
    pedido de `seller-test-029`, dos `auditEvents` con la forma de los eventos de antes de la spec (sin
    `origin`, sin registro en `orderHistory`, con `actorId` y `actorRole` de un usuario de Kentro —p. ej. el uid
    del admin desechable o `driver-test-029` con rol de lider— y `summary` de plantilla): uno de **accion
    permitida** (p. ej. `order.transition`) y otro **fuera de la lista** (p. ej. `order.messenger_reassigned`).
    Con la sesion `seller` de la tienda de pruebas: el primero llega sin `actorId`/`actorLabel`/`actorEmail`/
    `actorRole` y con la etiqueta "Kentro"; el segundo no llega. Con la sesion del admin desechable, los dos
    llegan. Los eventos sembrados se borran en `cleanup` (su `entityId` es un pedido de prueba);
  - E2E de `HU_05.tienda` con esa sesion: ningun nombre ni correo de Kentro en el DOM.
- **RF_11 con la forma de Kovia (P2):**
  - (a) **T25, solo unidad:** fixture (`src/lib/fixtures/029-kovia-order.json`) copiado en solo lectura de un
    pedido real de Kovia y su payload de Shopify, con nombre, telefono, direccion **e id de Shopify** sustituidos
    por valores sinteticos de la misma forma (id en el rango reservado), pasado por `planDeliveryCorrection` y
    despues por `mergeImportedOrder`; y las guardas del modulo de salvaguardas y del modo `kovia-replay`;
  - (b) **T27, en produccion dentro de `run-all`:** `kovia-replay` crea un documento `shopifyStores` **de
    prueba** con el dominio **sintetico** que apunta a `seller-test-029`, y envia al `shopifyWebhook` un payload
    con la forma de Kovia y un **id de Shopify del rango reservado** (nunca el de un pedido real de Kovia), con
    las salvaguardas (a)-(c). Secuencia: **replay 1** (crea el pedido) → `PATCH` por API (corrige cliente y
    direccion) → **replay 2** (mismo payload, reimporta) → comprobacion de RF_11: cliente y direccion corregidos
    se conservan, el estado no cambia y el pedido queda en fase `edited`. La comprobacion previa (a) se hace
    antes del replay 1 (el pedido no debe existir) y, antes del replay 2, se comprueba que el que existe es **el
    creado por el replay 1** (`sellerId == "seller-test-029"`); si no, aborta. La firma HMAC se calcula **leyendo
    el secreto de Shopify existente solo en memoria**, sin escribirlo en disco, en la evidencia, en el registro
    ni en logs. Lo que crea queda en el registro y lo borra el `cleanup` general. No se toca ninguna tienda ni
    pedido real de Kovia.
- **`cleanup` (T27):** en el `finally` de `run-all` (o con `--from-registro`), solo con `safeDelete` y la tabla
  (c): pedidos de prueba (los del webhook de tienda, los manuales, el "con lider" y el de `kovia-replay`), sus
  `auditEvents` (incluidos los sembrados y los de la key de escritura, con `entityId = "seller-test-029"`),
  `orderHistory`, `walletEntries`, `storeWebhookSamples` y `shopifySyncIssues` que los referencien,
  `storeApiIdempotency` y `storeApiRateLimits` con prefijo `seller-test-029__`, `importRuns` de las corridas de
  prueba, el `shopifyStores` de prueba, la config de webhook de prueba, `inventory` y `productCatalog` de
  `seller-test-029`, `storeApiConfigs/seller-test-029`, los usuarios de Auth del registro (los de la tienda y el
  admin desechable) y `sellers/seller-test-029`; imprime recuento por coleccion y falla si queda algo. Es el
  unico codigo que borra `orderHistory`, y solo de pedidos con `sellerId == "seller-test-029"` (excepcion
  declarada en RF_16).

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
en el E2E a 375 y 1280. **T19 y T22 no empiezan hasta que `sdd-uxui` ratifique en el README** las etiquetas
"Direccion revisada" y "Recogido" y los nombres visibles de `totalCop`, `productName`, `sku` y `quantity`
(seccion 12). **T27 no empieza hasta que el anexo A de la spec este transcrito** (5.3). Los hallazgos menores de
la pasada final estan en cada tarea como "Nota para la prueba".

## 10. Orden de despliegue

1. `capture-reads` (T24) con las keys de lectura actuales.
2. Reglas (`orderHistory`, `storeApiIdempotency`, `storeApiRateLimits`, `settings` acotada) (T7).
3. Indices solo si T2 los pidio (comparando con prod) y esperar `READY`; politicas TTL.
4. Functions: `storeApi`, las callables tocadas de `orders.ts` y `order-corrections.ts`, y las tres nuevas,
   con `ALLOW_FUNCTIONS_DEPLOY=1` tras `npm run build` y `firebase functions:list`. Humano (principio 7).
5. `verify-029.js set-history-since` (una vez; `create`) (T27).
6. Hosting (`npm run lint`, `static{` = 0, `ALLOW_FUNCTIONS_DEPLOY=1`).
7. Con el anexo A transcrito: `verify-029.js run-all` (setup, CA del anexo A, `kovia-replay`, RF_27,
   `compare-reads`, comparacion de `GET /orders/{id}`, p95 y `cleanup` en `finally`); si se cae, `cleanup
   --from-registro`. E2E de HU_04/HU_05 (`/sdd-verify`) con las sesiones del mismo proceso o, si van aparte,
   antes del `cleanup` (T27).
8. Entregar la key de escritura a CENTRAL: la genera la tienda (Kovia/ONEP) desde su panel o el admin, y se
   entrega por canal seguro (README, decision 4).

## 11. Riesgos

| Riesgo | Mitigacion |
|---|---|
| La API confirma o corrige un pedido que ya tomo un lider (clobber) | condicion dentro de la transaccion; `driverId` en la definicion de editable; prueba de carrera simulada con dos planes sobre el mismo pedido (T6) |
| El integrador recibe errores distintos segun el orden en que el codigo los mire | precedencia unica de la decision 12 (2.1), con una prueba por cada par de pasos vecinos (5.1) y documentada en el indice y el manual |
| Un reintento con la misma `Idempotency-Key` recibe otro error distinto del primero | se guardan tambien los 409 y los 422 del paso 6 (2.8, decision 13) |
| Un reintento legitimo de CENTRAL con el `expectedStatus` de antes recibe 409 en vez de "sin cambios" | la idempotencia gana: `status_changed` es el ultimo control (2.1, 4.1, T4) |
| Una correccion "sin cambios" deja pasar una ciudad desactivada | la cobertura (paso 6) va antes del no-op (paso 7) (RF_10, 4.1, T5) |
| Copiar la regla de confirmar/cancelar en la API | nucleo + ejecutor unicos; guarda anti-copia con mutacion (T6b, T11) |
| Regresion del panel al delegar `updateImportedOrder` o `cancelOrder` (perder el sello, borrar indicaciones en blanco o cambiar el parche de anular) | politica `panel` con `panelExtras` y sello en el nucleo; parche de cancelar con `driverId: current.driverId ?? null`; pruebas "edicion solo de producto sella" e "indicaciones en blanco se conservan" (T5, T6); guarda 7 de la 017 actualizada con razon (T6b) |
| Historial falsificable | `orderHistory` solo de servidor (2.5) |
| Alguien reconstruye `orderHistory` desde `auditEvents` (contra RF_24) | guarda de T16: `getOrderAuditTrail` es la unica funcion que consulta `auditEvents` y no escribe `orderHistory`; ningun modo del guion escribe `orderHistory` |
| **Historial con hueco: el lider y el mensajero cambian `status` desde el cliente** (`operationalOrderUpdateByAssignee`) sin registro | declarado en RF_16 como limite conocido; trasladado a la 032 (1.1, RF_07 de su borrador); no se toca aqui para no cambiar la app del mensajero sin su spec |
| Una callable nueva de `orders.ts` u `order-corrections.ts` cambia estado sin registrar | guarda de T16 por nombre: todo export `onCall`/`onRequest` de esos archivos clasificado en `REGISTRAN_HISTORIAL` o `EXCLUIDAS_DEL_HISTORIAL` |
| `historySince` movido desde la app por un admin | regla de `settings` acotada (`settingId != "storeApi"`) y `create` en el guion (2.4, T7) |
| Evento de `auditEvents` fabricado por un cliente visible para la tienda | mitigacion 2.7 (verificable o accion permitida); riesgo residual hasta la spec 032 (prioridad alta) |
| La tienda deja de ver eventos historicos que hoy ve (efecto de la mitigacion) | aceptado en RF_27 y en los casos limite de la spec; lo revisa la 032 |
| Identidades de Kentro a la tienda por `summary` viejos | lista permitida, no prohibida (2.7) |
| El admin desechable de la verificacion toca datos reales | aceptado explicitamente (DoD 3), igual que en las verificaciones 022 y 026; solo se usa sobre la tienda de pruebas, el guion solo escribe ids de prueba (guarda de T27) y se borra por su `uid` en el `cleanup` |
| El pedido "con lider" no pasa por el canal del cliente | aceptado y declarado en la evidencia: `driverId` sintetico puesto con el Admin SDK; RF_08/RF_14 se comprueban despues por el canal real (la API) |
| El guion de produccion se cae a medias y deja restos | un solo proceso con `cleanup` en `finally`; registro sin secretos escrito antes de cada creacion; `cleanup --from-registro` (5.3, T27) |
| La key de escritura, contrasenas o el secreto de Shopify acaban en disco o logs | se generan y usan solo en memoria dentro de `run-all`; el registro solo guarda ids; guardas de T25 y T27 |
| Los CA de CENTRAL no estan en el repositorio y el recorrido no se puede contrastar | anexo A en la spec y compuerta de T27 hasta que este transcrito |
| La key de escritura en logs o en `localStorage` | guardas 5.2; solo cabecera; cualquier key por query en escritura → 401 |
| Una integracion manda key en query y Bearer distintas en lectura | como hoy, manda la de query (`query ?? bearer`); si es invalida, 401 (2.3, T3) |
| Un envio de prueba (replay o webhook) cae sobre un pedido real, o el `cleanup` borra algo real | salvaguardas obligatorias 5.3 (a)-(c): comprobacion previa de existencia y aborto, ids en rango o prefijo sintetico, `safeDelete` con prueba de pertenencia por coleccion que se niega a borrar lo ajeno; guardas de fuente (d) en T25 y T27 |
| Restos de la verificacion en colecciones laterales | el `cleanup` cubre `walletEntries`, `inventory`, `productCatalog`, `storeApiConfigs`, `storeWebhookSamples`, `shopifySyncIssues`, `importRuns`, idempotencia, tasa y usuarios de Auth, con recuento por coleccion (5.3) |
| `kovia-replay` toca una tienda real de Kovia | dominio sintetico, `shopifyStores` de prueba apuntando a `seller-test-029`; guarda de T25 |
| Los pedidos de prueba consumen numeros del contador de `trackingCode` | aceptado (5.3) |
| `compare-reads` da falsos positivos por la operacion del dia | solo datos congelados al capturar (rangos cerrados del pasado, `updatedAt < captureAt`), `/resumen` por forma, tolerancia declarada (5.3) |
| La carga dirigida pierde un corte que solo referencia el pedido en `cashAllocations` | recuento en prod (T1, T2; esperado 0); si no es 0, se para T9/T10 |
| Rotacion a medias que deja a la integracion sin key | transaccion huella + auditoria; la key se devuelve tras el commit |
| `GET /orders/{id}` distinto del elemento de `GET /orders` | misma funcion movida; equivalencia de carga dirigida (T9); comparacion en prod sobre 20 pedidos reales (T27) |
| Romper integraciones de lectura | rutas viejas sin cambio interno salvo la autenticacion (con `query ?? bearer` de hoy) y el filtro nuevo, probados con el handler viejo (T10); indice con valores actuales identicos y documentacion solo en claves nuevas; `compare-reads` sobre datos congelados con key de lectura |
| Doble aplicacion por reintento de CENTRAL | `Idempotency-Key` decidida dentro de la transaccion; el atajo previo nunca decide `fresh` |
| ChatBy reescribe una direccion corregida por API | aceptado por la spec (caso limite); advertido en `aviso` y en el manual; spec 031 |
| `address_risk` desbloqueado por API sin cambiar nada | decidido (P1): queda en `imported` + `review`, con historial `order.address_reviewed`; la confirmacion sigue siendo aparte y explicita |
| **Limite de 120 escrituras/minuto por tienda: a confirmar con CENTRAL** | una sola constante (`STORE_API_WRITES_PER_MINUTE`); cambiarla es una linea y su prueba |
| Coste del limite de tasa (1 escritura por peticion) | ~120/min por tienda en el peor caso; TTL limpia |

## 12. Preguntas abiertas

Todas resueltas el 2026-10-04 (tabla de la cabecera). Pendiente operativo, no bloqueante: confirmar con
CENTRAL el limite de 120 escrituras/minuto (seccion 11).

**Compuerta de diseno para T19 y T22** (la lanza la sesion principal): `sdd-uxui` ratifica en el README, antes
de empezar T19 (modelo de vista) y T22 (pantalla):

- las etiquetas de accion "Direccion revisada" (`order.address_reviewed`) y "Recogido" (`order.picked_up`);
- los nombres visibles en "Antes/Ahora" de `totalCop`, `productName`, `sku` y `quantity`, que ahora aparecen en
  el historial por la edicion del panel y el ajuste del admin (RF_16) y no estan en el README.

**Compuerta de contenido para T27** (la cierra la sesion principal con el responsable): transcribir en el anexo A
de la spec los CA_01-CA_12 del documento de CENTRAL (2-oct-2026).

## 13. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-04 | Plan tecnico inicial y cierre de P1-P5 | Spec 029 aprobada |
| 2026-10-04 | Precisiones de `/sdd-analyze`: (1) confirmar un `address_risk` da siempre 409 `address_review_pending`, tambien con lider (4.1); (2) tabla 2.3 reescrita con orden de evaluacion: cualquier key por query en escritura → 401 `key_in_query` (sustituye a `write_key_in_query`, nunca desplegado), `kw_` por query → 401 tambien en rutas de lectura viejas, 403 `read_only_key` solo para la key de lectura en la cabecera; (3) `deliveryNotes` vacio o `null` borra y el resto de campos vacios dan 422 (4.4); (4) T12 toca `order-seller-actions-run.ts`; (5) T18 toca `operations-app.tsx` para adaptar `fetchFirebaseOrderAuditTrail`; (6) pruebas de RF_02 y del 404 identico en T10, validador de `shopifyOrderId` en T8; (7) todas las referencias a tareas renumeradas a T1-T27 (secciones 1, 2.x, 3, 4.5, 5.x, 9, 10, 12); (8) tabla 2.6 con su tarea y declarada igual a la lista de RF_16; (9) excepcion del `cleanup` en 2.5 y 5.3; (10) consecuencia visible de la mitigacion 2.7 y riesgo nuevo; (11) T23 aceptada como parte del diseno de HU_04 (seccion 9); (12) carrera simulada en T6 (2.2 y riesgos) | Hallazgos de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
| 2026-10-04 | Segunda pasada de `/sdd-analyze` (spec sin cambios): (1) politica `panel` de `planDeliveryCorrection` con `panelExtras` (lo que hoy edita `updateImportedOrder`): cuentan como cambio, se aplican siempre, llevan sello y auditoria, y el sello lo pone el nucleo; el borrado de `deliveryNotes` `""`/`null` es solo de la API y el panel conserva indicaciones en blanco (2.2, 4.1, riesgos); (2) las rutas viejas autentican con `resolveStoreCredentials`, conectado y probado con el handler viejo en T10 (2.3); (3) un rechazo no escribe en `orders`, `auditEvents` ni `orderHistory`; un 409 de la API si guarda el registro idempotente (2.2, 2.8, 4.5); (4) la creacion (`createManualOrder` e importaciones) y ChatBy excluidas de RF_16 con lista explicita en la guarda de T16 (2.6); (5) validacion en dos capas: Zod solo forma y tipos, `expectedStatus` separado antes, prioridad `field_not_allowed` sobre `validation_failed`, reglas de contenido en `validateDeliveryInput` (2.1, 4.4); (6) motivo de cancelar validado en T8 (4.4); (7) T13 prueba 404 de historial ajeno y 503; (8) T14 prueba `apiKeyLast4` y "Clave de escritura de <tienda>" para el admin; (9) T6 partida en T6 y T6b (secciones 1, 2.2, 2.6, 3, 5.1, 5.2, 9, riesgos); (10) compuerta de `sdd-uxui` antes de T22 (secciones 9 y 12) | Hallazgos de la segunda pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
| 2026-10-04 | Tercera pasada de `/sdd-analyze` (spec precisada en texto, decision 9): (1) el pedido `imported` de prueba entra por el `storeOrderWebhook` de `seller-test-029` con su config de webhook de prueba, incluida en el `cleanup` (5.3, T27); (2) `kovia-replay` con `shopifyStores` de prueba de dominio sintetico, id de Shopify sintetico, secuencia replay 1 → `PATCH` → replay 2, comprobacion de RF_11, limpieza propia y firma HMAC con el secreto solo en memoria (5.3, riesgos, T25); (3) el 422 lista todos los campos con problema de los dos tipos, con `field_not_allowed` de primer nivel si hay alguno no permitido (2.1, 4.4, T8); (4) regla de `settings` acotada a `settingId != "storeApi"` (1, 2.4, 7, T7); (5) `GET /orders` viejo: 400 de `shopifyOrderId` con forma vieja y `status`/`limit` aplicados con el filtro (2.1, 2.10, 4.3, T10); (6) `compare-reads` con key de escritura solo sobre la tienda de pruebas; tiendas reales solo con key de lectura (5.1, 5.3, T24, T27); (7) recuento en prod de cortes con `cashAllocations[].orderId` fuera de `orderIds` (esperado 0) en T1/T2 (2.10, riesgos); (8) la decision de idempotencia se toma dentro de la transaccion; la lectura previa es solo atajo (2.1, 2.8, 4.5); (9) hueco de `operationalOrderUpdateByAssignee` declarado (1, 2.5, 2.6, 7, riesgos) y anadido al borrador de la 032; (10) `imported` con lider → 409 `order_not_editable` en confirmar (4.1, T4) | Hallazgos de la tercera pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
| 2026-10-04 | Cuarta pasada de `/sdd-analyze` (spec precisada en texto, decision 10): (1) la idempotencia gana sobre `expectedStatus` (2.1, 2.2, 2.8, 4.1, riesgos, T4) — reordenado en la sexta pasada; (2) salvaguardas obligatorias de los envios de prueba y del `cleanup`; consumo del contador de `trackingCode` aceptado (1, 5.2, 5.3, riesgos, T25, T27); (3) RF_27 sobre eventos con forma historica sembrados sobre `seller-test-029`; se quita el usuario con claim de una tienda real (5.3, riesgos, T27); (4) guarda 7 de la 017: el literal de estados cerrados en `orders.ts` pasa de 2 a 1 al delegar `cancelOrder`; el parche de cancelar conserva `driverId: current.driverId ?? null` (1, 2.2, 4.1, T6b); (5) guarda de T16 por `writesOrders` — sustituida en la quinta pasada; (6) compuerta de `sdd-uxui` ampliada a los nombres visibles de `totalCop`, `productName`, `sku` y `quantity`, y T19 tambien la espera (9, 12); (7) indice: documentacion nueva solo en claves nuevas de primer nivel, valores actuales identicos, `compare-reads` por valor (1, 2.1, 3, 5.1, T13, T24) | Hallazgos de la cuarta pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-04 |
| 2026-10-05 | Quinta pasada de `/sdd-analyze` (spec precisada en texto, decision 11): (1) guarda de historial de T16 **por nombre** (`REGISTRAN_HISTORIAL` / `EXCLUIDAS_DEL_HISTORIAL`) con prueba positiva de recogida y mensajero; `spec-017-guards` no se toca mas; (2) `cleanup` con prueba de pertenencia por coleccion; prefijo `seller-test-029__` en idempotencia y tasa; (3) `compare-reads` solo sobre datos congelados al capturar, `/resumen` por forma, tolerancia declarada; (4) en rutas de lectura la key evaluada es `query ?? bearer`; (5) RF_25: metadatos visibles — acotados en la sexta pasada; (6) RF_10 antes del no-op | Hallazgos de la quinta pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-05 |
| 2026-10-05 | Sexta pasada de `/sdd-analyze` (decision 12 de la spec): (1) RF_25 acotado a lo que muestra el diseno; `StoreApiKeyStatus` con `generatedAt`; (2) admin desechable aceptado explicitamente; sin lider ni mensajero desechables (`driverId` sintetico con el Admin SDK, fuera del canal del cliente); (3) `cleanup` por coleccion ampliado (`walletEntries` por `orderId`, `inventory`, `productCatalog`, `storeApiConfigs`, usuarios por `uid` registrado); evento de la key con `entityId = sellerId`; (4) precedencia de codigos unica (tabla de 2.1) y nucleo reordenado; (5) guardas RNF_05 y RF_24 precisadas | Hallazgos de la sexta pasada de `/sdd-analyze` y decisiones del orquestador del 2026-10-05 |
| 2026-10-05 | **Pasada final** (septimo `/sdd-analyze`, decision 13 de la spec). De fondo: (1) guarda RF_24 de T16: `getOrderAuditTrail` es la unica funcion que hace `.where(`/`.get(` sobre `auditEvents` y no escribe `orderHistory`; no existe modo de relleno (1, 2.5, 2.6, 5.1, 5.2, riesgos); (2) anexo A de la spec con CA_01-CA_12 pendientes de transcribir y compuerta de T27 (1, 5.3, 9, 10, 12, riesgos); (3) el guion de produccion corre en un solo proceso (`run-all`) con `cleanup` en `finally`, registro sin secretos en `EV/t27-registro.json` y `cleanup --from-registro`; la key de escritura se genera y rota dentro del proceso y no sale de memoria (3, 5.2, 5.3, 10, riesgos); (4) T25 queda en unidad, fixture y guardas; la evidencia de `kovia-replay` pasa a T27 (P2, 3, 5.1, 5.3); (5) T27 compara `GET /orders/{id}` con su elemento de `GET /orders` sobre 20 pedidos reales y cubre RF_01 (2.10, 5.1, 5.3); (6) en confirmar, clave no permitida o tipo invalido → 400 `invalid_body` en el paso 3 (codigo nuevo) (2.1, 4.1, 4.3, 4.4, 5.1); (7) la idempotencia guarda tambien los 422 del paso 6 (2.2, 2.8, 4.5, 5.1, riesgos). Menores (pares de precedencia restantes, paso 0, anti-copia en `store-api-write.ts`, reparto T11/T12, `null` en Zod, comparacion lectura/escritura en la tienda de pruebas con su key de lectura de `createStoreApiKey`): como "Nota para la prueba" en las tareas | Decision del responsable: una pasada final |
