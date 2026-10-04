# Tareas — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API

Plan: `specs/029_plan.md` (preguntas P1-P5 resueltas el 2026-10-04; precisado tras dos pasadas de
`/sdd-analyze` el mismo dia, seccion 13). Diseno: `specs/design/029_store_api_confirma_y_corrige_pedidos/`
(README + 14 pantallas). Evidencia: `.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).

Cada tarea empieza por una prueba que falla (RED) y dura 20-30 minutos. Vitest solo recoge
`src/**/*.test.ts`; `functions/src` se importa como `../../functions/src/<modulo>`. Cada tarea lleva al menos un
archivo de prueba en su alcance.

**Archivos compartidos (plan 5.2):** un bloque `describe("T<n> · ...")` por tarea, sin editar los de otra, en
`src/lib/spec-029-guards.test.ts` (casi todas), `src/lib/order-seller-actions.test.ts` (T4, T5, T15, T25),
`src/lib/order-seller-actions-run.test.ts` (T6, T12), `src/lib/spec-017-guards.test.ts` (T6 guarda 3, T6b
guarda 7), `src/lib/store-api-request.test.ts` (T8, T12), `src/lib/store-api-write.test.ts` (T10, T11, T13),
`src/lib/store-api-history.test.ts` (T13, T14), `src/lib/store-api-auth.test.ts` (T3, T17).
`functions/src/orders.ts`: T6b (tres callables), T14 (`getOrderAuditTrail`), T15 y T16 (historial), cada una
en su callable. `functions/src/order-seller-actions-run.ts`: T6 (ejecutor), T12 (registro idempotente dentro
de su transaccion). `functions/src/store-api.ts`: T9, T10 (autenticacion de rutas viejas y rutas de lectura
nuevas), T11, T13, cada una en su ruta. `operations-app.tsx`: T18 (solo la adaptacion de
`fetchFirebaseOrderAuditTrail`), T20, T21, T22, T23, cada una en su punto de montaje.

**Reglas transversales:** escrituras nuevas con `stripUndefined`; la regla de confirmar/corregir/cancelar solo
en `order-seller-actions.ts` (plan 2.2), y el sello `MANUAL_EDIT_STAMP` solo lo pone el nucleo;
`orderHistory` nunca guarda `driverId`/`messengerId`; la key de escritura nunca en logs, en Firestore en claro
ni en `localStorage`; `STORE_API_WRITES_PER_MINUTE` es el unico sitio del limite; `historySince` nunca como
literal.

## Medicion previa (compuertas)

- [ ] **T1: Linea base contra produccion, solo lectura**
  * Requisitos cubiertos: RF_02, RF_08, RF_10, RF_22, RF_27, RNF_05
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t1-linea-base.txt
  * Accion: modo `baseline`: tipos de `shopifyOrderId` guardados (texto / numero / mixto) por tienda; pedidos
    por estado y con/sin `driverId` en los tres editables; `address_risk` con lider; `cities` activas; eventos
    de `auditEvents` por `action` y por presencia de `actorRole` (para la lista permitida, plan 2.7); configs
    de `storeApiConfigs` (sin imprimir keys); comprobar en codigo que `uchat-pull.ts` y `uchat-webhook.ts`
    confirman dentro de `runTransaction`.
  * Verificacion: bloque `describe("T1 · verify-029 baseline es de solo lectura")` (sin `.set(`, `.update(`,
    `.delete(`, `.create(`, `batch(`, `runTransaction(` fuera de los modos de escritura declarados);
    `node scripts/verify-029.js baseline` sin error. Compuertas: `shopifyOrderId` mixto → T10 usa `in`; ChatBy
    sin transaccion → reportar antes de T6; accion historica con identidad en el `summary` dentro de la lista
    permitida → reportar antes de T14.

- [ ] **T2: Consultas exactas e indices**
  * Requisitos cubiertos: RNF_05, RF_01, RF_02, RF_17
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t2-query-check.txt, firestore.indexes.json (solo si una consulta pide indice)
  * Accion: `query-check` con `limit(1)`: `orders` `sellerId` + `shopifyOrderId`; `walletEntries` `orderId`;
    `settlements` `orderIds array-contains`; `orderHistory` `orderId` (vacia hoy: comprobar que no pide
    indice); `cities` `active`. Si alguna pide indice, comparar con `firebase firestore:indexes` y **anadir**.
  * Verificacion: bloque `describe("T2 · query-check")`: el modo existe y solo lee; evidencia sin error;
    `firestore.indexes.json` sin cambios o solo con entradas anadidas.

## Nucleo puro

- [ ] **T3: Credenciales y key de escritura (puro)**
  * Requisitos cubiertos: RNF_01, RF_25, RF_26, RF_20
  * Archivos: functions/src/store-api-auth.ts, src/lib/store-api-auth.test.ts
  * Accion: `generateWriteKey()` (`kw_` + 45 base64url, 48 en total), `writeKeyFingerprint` (sha256 hex),
    `last4`; `resolveStoreCredentials({ route, querySellerId, queryKey, bearer, config })` con la tabla del plan
    2.3, evaluada en su orden, y las dos comparaciones siempre; `planWriteKeyChange({ config, rotate, actor,
    now })` → campos `writeKey*` + evento, o `failed-precondition` (generar con key existente / rotar sin key).
  * Verificacion: `store-api-auth.test.ts`, una prueba por fila de la tabla 2.3: en ruta de escritura,
    **cualquier** `key` por query → 401 `key_in_query` (key de lectura valida, key de escritura valida, key
    invalida, y tambien con una cabecera Bearer valida), nunca 403; key de lectura valida en la cabecera de una
    escritura → 403 `read_only_key` (unico 403); `kw_` por query → 401 en ruta de lectura nueva (`key_in_query`)
    y vieja (`invalid_key` con la forma `{ ok, error }` de hoy); key de lectura por query en ruta de lectura →
    pasa; escritura por Bearer en lectura → pasa; `status` inactivo → `invalid_key`; la key mide 48 y empieza
    por `kw_`; `planWriteKeyChange` no toca `apiKey` ni `status` y el evento no contiene la key.

- [ ] **T4: Confirmar y cancelar (planificador puro)**
  * Requisitos cubiertos: RF_04, RF_05, RF_06, RF_13, RF_14, RF_15, RF_19, RF_21
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: tipos del plan 4.1, `isApiEditable`, `planConfirm`, `planCancel` con la tabla de politica
    (`panel` / `api`) y `expectedStatus`.
  * Verificacion: bloque `describe("T4 · ...")`: `imported` → `ready_to_assign`, `accepted`, `confirmedVia`
    `api`/`manual`; `ready_to_assign`, `in_route`, `delivered` → `unchanged` en API y rechazo en panel;
    `cancelled` → `order_cancelled`; `address_risk` sin lider y `address_risk` con lider → los dos
    `address_review_pending` (RF_21 prevalece; nunca `order_not_editable` al confirmar un `address_risk`);
    `expectedStatus` distinto → `status_changed` antes que todo; cancelar editable con motivo → `cancelled`,
    `callNote`, `inventory: "release"` si reservo y no `imported`; `assigned` y `address_risk` con lider →
    `order_not_editable` al cancelar en API y `assigned` aplicado en panel (admin); `cancelled` → `unchanged`;
    otra tienda → `order_not_found`.

- [ ] **T5: Corregir datos de entrega, validacion e historial (puro)**
  * Requisitos cubiertos: RF_07, RF_08, RF_09, RF_10, RF_11, RF_12, RF_16, RF_22, RF_23
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: `validateDeliveryInput` (reglas de contenido de la tabla 4.4, todos los errores a la vez, con la
    excepcion de `deliveryNotes` solo para la API), `planDeliveryCorrection` (pasos 1-10 del plan 4.1, incluido
    `order.address_reviewed` sin campos cambiados, P1, y `panelExtras` con politica `panel`: cuentan como
    cambio, siempre en el parche, sello y auditoria puestos por el nucleo), `buildOrderHistoryRecord`.
  * Verificacion: bloque `describe("T5 · ...")`: solo campos enviados; `imported` sigue `imported`;
    `in_route`, `call_pending`, `address_risk` con lider → 409; telefono valido + ciudad inactiva →
    `out_of_coverage` y el telefono no esta en el parche; telefonos validos (10 digitos, `+57`, E.164) e
    invalidos; politica `api`: `deliveryNotes: ""` y `deliveryNotes: null` → borran las indicaciones (cambio a
    `null` en el historial) y no dan `no_fields`; politica `panel`: **indicaciones en blanco se conservan** (ni
    en el parche ni en el historial); **edicion del panel solo de producto** (`panelExtras` con otro
    `productName`/`totalCop`, entrega identica) → `applied`, parche con el producto y `MANUAL_EDIT_STAMP`, evento
    `order.imported_updated`, historial con `productName`/`totalCop`; `customerName`, `customerPhone`,
    `addressRaw` o `cityId` vacios o `null` → `empty`; producto/valor/pago/modo por API → `not_allowed`;
    `panelExtras` con politica `api` → lanza; direccion cambiada (API) → `clear` con los cuatro campos;
    `address_risk` sin lider con valores identicos → `imported` + `review` + `order.address_reviewed` con solo
    `status`; propiedad: ningun plan `api` emite `address_risk`; sello `MANUAL_EDIT_STAMP` presente en todo plan
    `applied` de correccion; historial sin `driverId`/`messengerId` y `null` sin cambios; el resultado pasado
    por `mergeImportedOrder` conserva cliente y direccion.

- [ ] **T6: Ejecutor transaccional y carreras simuladas**
  * Requisitos cubiertos: RF_19, RF_04, RF_11, RF_13
  * Archivos: functions/src/order-seller-actions-run.ts, functions/src/order-import-merge.ts, src/lib/spec-017-guards.test.ts, src/lib/order-seller-actions-run.test.ts
  * Accion: `runConfirm`, `runDeliveryCorrection`, `runCancel` (plan 2.2) con transaccion, `clear` por
    `FieldValue.delete()`, inventario, evento e historial; si el plan rechaza, ninguna escritura. Quinta
    exencion en `IMPORT_WRITE_EXEMPTIONS` con su razon y guarda 3 de la 017 de cuatro a cinco (el ejecutor es
    quien escribe `orders` fuera de `orders.ts`).
  * Verificacion: `spec-017-guards.test.ts` guarda 3 verde con cinco exenciones; bloque `describe("T6 · ...")`
    en `order-seller-actions-run.test.ts` con una transaccion falsa: aplica `patch`, `clear`, evento e
    historial en ese orden; **si el plan rechaza, no escribe nada en `orders`, `auditEvents` ni
    `orderHistory`** (cero llamadas a `set`/`update`/`delete` sobre esas colecciones); politica `panel`:
    **edicion solo de producto** escribe el producto y `MANUAL_EDIT_STAMP` en el pedido y el evento
    `order.imported_updated`; **indicaciones en blanco desde el panel se conservan** (el documento escrito
    mantiene las `deliveryNotes` previas); **carrera simulada (RF_19, caso limite):** dos planes sobre el mismo
    pedido con una transaccion falsa que reintenta con el documento ya escrito por el primero: (a) confirmar +
    confirmar (ChatBy y API) → el segundo ve `ready_to_assign` y responde `unchanged`, sin segundo evento ni
    segundo historial; (b) un lider toma el pedido (`driverId` puesto) entre la lectura y el commit de una
    correccion → el reintento responde 409 `order_not_editable` y no aplica ningun campo; (c) cancelar +
    cancelar → el segundo `unchanged`.

- [ ] **T6b: Delegacion de las tres callables del panel, guardas 017 y anti-copia**
  * Requisitos cubiertos: RF_19, RF_11, RF_16
  * Archivos: functions/src/orders.ts, src/lib/spec-017-guards.test.ts, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/mutacion-rf19.txt
  * Accion: `confirmImportedOrder`, `updateImportedOrder` y `cancelOrder` delegan en el ejecutor de T6 con
    politica `panel`, sin cambiar sus mensajes ni sus codigos de error. `updateImportedOrder` traduce los campos
    extra (producto/`lineItems` via `resolveEditedOrderLines` intacto, pago, modo, valor, zona,
    `normalizedAddress` y demas que escribe hoy) a `panelExtras`; no escribe el sello ni ningun campo del
    pedido. Guarda 7 de la 017: el sello cuenta en `orders.ts` (ajustes, 1) + `order-seller-actions.ts`
    (datos de entrega, 1), con su razon.
  * Verificacion: `spec-017-guards.test.ts` verde con la guarda 7 actualizada; bloque
    `describe("T6b · RF_19 anti-copia")` en `spec-029-guards.test.ts`: las tres callables llaman a
    `runConfirm`/`runDeliveryCorrection`/`runCancel` y sus cuerpos no contienen `status: "ready_to_assign"`,
    `status: "cancelled"`, `addressRisk: "accepted"` ni `[MANUAL_EDIT_STAMP]`; `updateImportedOrder` contiene
    `resolveEditedOrderLines(` y `panelExtras`; mutacion a mano (pegar el parche de confirmar en una callable)
    pone la guarda en rojo, registrada en `EV/mutacion-rf19.txt`.

- [ ] **T7: Reglas y `settings/storeApi`**
  * Requisitos cubiertos: RF_16, RF_17, RF_24
  * Archivos: firestore.rules, src/lib/spec-029-guards.test.ts
  * Accion: bloques `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits` con `allow read, write: if
    false`; comprobar la regla de `settings` y, si el cliente pudiera escribir `settings/storeApi`, bloque
    propio.
  * Verificacion: bloque `describe("T7 · ...")`: los tres bloques con su regla; `settings/storeApi` no
    escribible por cliente; ninguna fuente de `src/` ni `functions/src/` contiene un literal de fecha asociado a
    `historySince`; ninguna fuente salvo `scripts/verify-029.js cleanup` hace `delete`/`update` sobre
    `orderHistory` (excepcion de RF_16).

## API

- [ ] **T8: Peticion, errores y limite (puro)**
  * Requisitos cubiertos: RF_03, RF_09, RF_12, RF_13, RNF_02, RNF_04
  * Archivos: functions/src/store-api-request.ts, src/lib/store-api-request.test.ts, src/lib/spec-029-guards.test.ts
  * Accion: `routeStoreApiRequest` (rutas nuevas y viejas, `Allow` por ruta), parametros permitidos por ruta,
    **validador puro de `shopifyOrderId`** (`^[0-9A-Za-z#._-]{1,64}$`, 400 `invalid_shopify_order_id`, plan
    2.10; T10 solo lo llama); `parseWriteBody` en dos capas (plan 4.4): separa `expectedStatus` del cuerpo
    **antes** de validar; esquemas Zod `.strict()` de los tres cuerpos **solo de forma y tipos basicos**; si hay
    alguna clave no permitida → 422 `field_not_allowed` listandolas todas; si no, delega el contenido de `PATCH`
    en `validateDeliveryInput` (T5) y valida el motivo de cancelar (obligatorio, recortado 1-500) → 422
    `validation_failed` con todos los campos; catalogo `code` → HTTP (con `key_in_query` en 401),
    `buildErrorBody`, `bodyHash` canonico, `STORE_API_WRITES_PER_MINUTE = 120`, `rateWindow(now)` →
    `{ bucketId, retryAfterSeconds }`.
  * Verificacion: bloque `describe("T8 · ...")`: parametro desconocido → 400 nombrando cada uno en cada ruta
    nueva; `key` en ruta de escritura no se reporta como parametro desconocido (lo resuelve T3 con 401); rutas
    viejas sin validacion de parametros; `shopifyOrderId` valido (`1001`, `#1001`, `KOV-1001`) e invalido
    (vacio, 65 caracteres, espacios, `/`) → `invalid_shopify_order_id`; `expectedStatus` no cuenta como campo
    (cuerpo `{ expectedStatus }` en `PATCH` → `no_fields`, nunca `field_not_allowed`); cuerpo con `totalCop` y
    `sku` → `field_not_allowed` listando los dos; cuerpo con `totalCop` y `customerName: ""` →
    `field_not_allowed` (gana sobre `validation_failed`) listando solo `totalCop`; cuerpo con `customerName: ""`
    y telefono invalido → `validation_failed` con los dos campos; tipo incorrecto (`customerName: 5`) →
    `validation_failed` con `invalid_type`; **cancelar sin motivo → 422 `validation_failed` (`reason`
    `required`)**, motivo solo espacios → `empty`, motivo de 1 y de 500 caracteres pasa, de 501 → `too_long`;
    catalogo congelado (nombres y HTTP); `Retry-After` >= 1; hash igual con claves en otro orden. Guarda: el
    limite solo aparece en `STORE_API_WRITES_PER_MINUTE`; `store-api-request.ts` no repite reglas de contenido
    de entrega (importa `validateDeliveryInput`).

- [ ] **T9: Forma de pedido extraida sin cambiar la salida**
  * Requisitos cubiertos: RF_01, RF_20
  * Archivos: functions/src/store-api-orders.ts, functions/src/store-api.ts, src/lib/store-api-orders.test.ts
  * Accion: mover `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` y su ayudante de fecha a
    `store-api-orders.ts` tal cual; `store-api.ts` los importa. Anadir `loadTargetedPaymentInputs` puro sobre
    asientos y cortes ya leidos.
  * Verificacion: `store-api-orders.test.ts`: con fixtures (cortes ajenos, `cashAllocations`, parcialmente
    cubierto, prepago, sin asientos) `buildPaymentInfo` con los cortes dirigidos == con todos los cortes;
    instantanea de un payload de `/orders` antes y despues de mover identica.

- [ ] **T10: Autenticacion de todas las rutas, `GET /orders/{id}` y filtro por `shopifyOrderId`**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_20, RNF_01, RNF_05
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-write.test.ts
  * Accion: **conectar `resolveStoreCredentials` (T3) en `store-api.ts` para las rutas viejas** (sustituye su
    comparacion propia; los errores conservan la forma `{ ok: false, error }` de hoy) y para las de lectura
    nuevas; el handler de `storeApi` recibe el `db` inyectable para poder probarlo. Carga dirigida (plan 2.10);
    404 identico (mismo HTTP y mismo cuerpo) para ajeno e inexistente; consulta por `shopifyOrderId` siempre
    acotada al `sellerId` de la key, con `in` si T1 midio tipos mixtos; `from`/`to` ignorados con el filtro; el
    formato lo decide el validador de T8 (400 `invalid_shopify_order_id`).
  * Verificacion: bloque `describe("T10 · RNF_05")` en guardas: el handler no contiene
    `where("sellerId", "==", ...)` sin segundo filtro ni `collection("settlements").get()`; `store-api.ts` no
    conserva una comparacion de key propia (`safeEqual(` solo dentro de `store-api-auth.ts`). Bloque
    `describe("T10 · ...")` en `store-api-write.test.ts` con un `db` falso en memoria: **rutas viejas (RF_20,
    RNF_01)** — el handler viejo con una key `kw_` por query en `/resumen` y `/orders` → 401 con cuerpo
    `{ ok: false, error: "invalid_key" }` (sin `code`); con la key de escritura por Bearer → 200 con la misma
    respuesta que con la key de lectura; con la key de lectura por query → 200 como hoy; **RF_02** — devuelve
    solo los pedidos de la tienda de la key con ese numero; con `from`/`to` que excluirian la fecha del pedido
    lo devuelve igual; el mismo numero en otra tienda no aparece, y un numero que solo existe en otra tienda da
    lista vacia (200); un `shopifyOrderId` invalido → 400 `invalid_shopify_order_id` sin consultar; **RF_01 /
    RNF_01** — `GET /orders/{id}` de un pedido de otra tienda y de uno inexistente dan 404 `order_not_found`
    con cuerpo identico (comparacion profunda).

- [ ] **T11: Rutas de escritura**
  * Requisitos cubiertos: RF_04, RF_07, RF_10, RF_13, RF_19, RNF_01, RNF_02
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-write.test.ts
  * Accion: `POST /confirm`, `PATCH`, `POST /cancel` → `parseWriteBody` (T8) y ejecutor con `policy: "api"` y
    actor `{ kind: "api", keyLast4 }`; mapeo de rechazos a `StoreApiError`; 422 `out_of_coverage` con
    `activeCities` (P4); respuesta `{ ok, changed, pedido }` con la forma de T9.
  * Verificacion: `store-api-write.test.ts`: `mapRejectionToResponse` para cada rechazo (codigo, HTTP,
    `status`, `hasLeader`, `activeCities` ordenadas por nombre y ausentes si fallo su lectura); guarda: los
    handlers llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel` y no escriben en `orders`.

- [ ] **T12: Idempotencia y limite de tasa**
  * Requisitos cubiertos: RNF_03, RNF_04
  * Archivos: functions/src/store-api-request.ts, functions/src/store-api-write.ts, functions/src/order-seller-actions-run.ts, src/lib/store-api-request.test.ts, src/lib/order-seller-actions-run.test.ts
  * Accion: `decideIdempotency(stored, { bodyHash, now })` → `replay | conflict | fresh`; lectura y escritura
    del registro dentro de la transaccion del ejecutor (`order-seller-actions-run.ts` recibe el registro
    idempotente opcional y lo escribe junto al pedido, **tambien cuando el plan rechaza con 409**, en cuyo caso
    es la unica escritura); ventana de tasa en transaccion corta previa; 429 con `Retry-After`.
  * Verificacion: bloque `describe("T12 · ...")` en `store-api-request.test.ts`: misma key y cuerpo →
    `replay`; otro cuerpo → `idempotency_key_reused`; expirado → `fresh`; key vacia o > 255 →
    `invalid_idempotency_key`; contador 121 → 429 y nunca 403; se guardan 200 y 409 y no 422. Bloque
    `describe("T12 · ...")` en `order-seller-actions-run.test.ts` con una transaccion falsa: una correccion
    rechazada con 409 (`order_not_editable`) **escribe el registro idempotente** con `status: 409` y su cuerpo,
    y ninguna escritura en `orders`, `auditEvents` ni `orderHistory`; una aplicada escribe el registro con 200
    en la misma transaccion que el pedido; un 422 no escribe registro.

- [ ] **T13: Historial por API e indice**
  * Requisitos cubiertos: RF_17, RF_18, RF_24
  * Archivos: functions/src/store-api-history.ts, functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/store-api-history.test.ts, src/lib/store-api-write.test.ts
  * Accion: `toStoreHistoryResponse(records, historySince)` con lista explicita de claves, orden ascendente,
    `excludes` y `aviso`; `GET /orders/{id}/history` (comprueba antes que el pedido es de la tienda; 503
    `history_not_ready` sin `settings/storeApi`); indice con rutas nuevas, codigos, estados editables,
    `historySince` y `HISTORY_EXCLUDES`, sin tocar sus claves actuales (RF_20).
  * Verificacion: bloque `describe("T13 · ...")` en `store-api-history.test.ts`: ningun registro de salida
    trae `actor`, `uid` ni `auditEventId`; orden del mas viejo al mas nuevo; vacio → `registros: []` con
    `historySince`; el indice contiene las rutas nuevas y las exclusiones, y sus claves viejas no cambian. Bloque
    `describe("T13 · ...")` en `store-api-write.test.ts` con un `db` falso: **historial de un pedido de otra
    tienda → 404 `order_not_found`** con el mismo cuerpo que uno inexistente y sin leer `orderHistory`; **sin
    `settings/storeApi` → 503 `history_not_ready`**; con el documento → 200 con `historySince` de ese documento.

- [ ] **T14: `getOrderAuditTrail` sin identidades para la tienda**
  * Requisitos cubiertos: RF_27, RF_18
  * Archivos: functions/src/store-api-history.ts, functions/src/orders.ts, src/lib/store-api-history.test.ts, src/lib/spec-029-guards.test.ts
  * Accion: `storeActorTag`, `storeSafeSummary` (lista permitida), `isStoreVisibleEvent` (verificable por
    `orderHistory.auditEventId` o accion permitida: mitigacion hasta la 032); la callable une `orderHistory`
    por `auditEventId`, devuelve `{ events, historySince }`, para `seller`/`seller_logistics` no llama a
    `resolveAuditActors`, y para el admin anade a los eventos de la API `apiKeyLast4` y `actorLabel`
    "Clave de escritura de <tienda>".
  * Verificacion: bloque `describe("T14 · ...")`: admin → "Kentro"; lider → "Kentro"; `seller` y
    `seller_logistics` → "Tu tienda"; `store_api` → "API"; sin `actorRole` → "Kentro"; evento historico sin
    origen sale sin `actorId`/`actorLabel`/`actorEmail`/`actorRole`; `order.messenger_reassigned` verificable →
    `summary: ""`; evento no verificable fuera de la lista → descartado para la tienda y visible al admin;
    **para el admin, un evento de la API trae `apiKeyLast4` (los 4 ultimos de la key) y `actorLabel`
    "Clave de escritura de <nombre de la tienda>", y esos dos campos no aparecen nunca en la salida para
    `seller`/`seller_logistics`**. Guarda: en `getOrderAuditTrail` la llamada a `resolveAuditActors` esta en la
    rama que excluye a los roles de tienda; las plantillas `summary:` de la lista permitida no interpolan
    variables de actor.

- [ ] **T15: Historial en confirmar reintento, ajuste, transicion y cierre**
  * Requisitos cubiertos: RF_16
  * Archivos: functions/src/orders.ts, src/lib/spec-029-guards.test.ts, src/lib/order-seller-actions.test.ts
  * Accion: `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition` y `closeOrder` escriben
    `buildOrderHistoryRecord(...)` con `origin: "panel"` y el `auditEventId` de su evento, en su transaccion.
  * Verificacion: bloque `describe("T15 · ...")` en guardas: las cuatro callables contienen
    `buildOrderHistoryRecord(`; bloque en `order-seller-actions.test.ts`: ajuste registra `totalCop`/producto;
    cierre registra solo `status`.

- [ ] **T16: Historial en mensajero, recogida y correcciones**
  * Requisitos cubiertos: RF_16, RF_24
  * Archivos: functions/src/orders.ts, functions/src/order-corrections.ts, src/lib/spec-029-guards.test.ts
  * Accion: `assignMessengerToOrders`, `unassignMessengerFromOrders` (solo `status`), `createOrUpdatePickupBatch`
    (evento `order.picked_up` nuevo + registro), `correctOrderStatus` (en su batch).
  * Verificacion: bloque `describe("T16 · ...")`: la lista de callables y modulos de `functions/src` que
    escriben `status` en un pedido es igual a **la tabla 2.6 del plan (la misma lista de RF_16) mas la lista
    explicita de exclusiones**, declarada en la guarda con su razon: `createManualOrder` (creacion),
    `shopify.ts`, `index.ts` (`shopifyWebhook`), `store-webhook.ts`, `onstock-webhook.ts`, `contact-form.ts`
    (importaciones, spec 031), `uchat-pull.ts`, `uchat-webhook.ts` (ChatBy, spec 031); todas las de la tabla
    llaman a `buildOrderHistoryRecord(` y ninguna exclusion la llama; una escritura de `status` que no este en
    ninguna de las dos listas pone la guarda en rojo; ninguna fuente lee `auditEvents` para escribir
    `orderHistory` (RF_24).

- [ ] **T17: Callables de la key de escritura**
  * Requisitos cubiertos: RF_25, RF_26
  * Archivos: functions/src/store-api-keys.ts, functions/src/index.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-auth.test.ts
  * Accion: `rotateStoreWriteKey` (transaccion huella + auditoria; key devuelta tras el commit),
    `getStoreApiKeyStatus`, `listStoreApiKeys` con `generatedByLabel` segun quien pregunta.
  * Verificacion: bloque `describe("T17 · ...")` en guardas: `runTransaction(` envuelve la escritura de
    `storeApiConfigs` y la de `auditEvents`; el `return` con `writeKey` esta despues de la transaccion; no hay
    `writeKey:` en ningun `set`; `createStoreApiKey` no escribe `writeKey*`; `seller_logistics` rechazado al
    rotar; las de estado no devuelven `apiKey` ni `writeKeyHash`. Bloque en `store-api-auth.test.ts`:
    `toStoreApiKeyStatus` con "Tu tienda" / "Kentro" para la tienda y nombre del admin para el admin.

## Interfaz

- [ ] **T18: Tipos y envoltorios de cliente**
  * Requisitos cubiertos: RF_25, RF_27
  * Archivos: src/lib/types.ts, src/lib/firebase/auth.ts, src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts
  * Accion: `OrderAuditEntry` ampliado, `StoreApiKeyStatus`; `fetchFirebaseOrderAuditTrail` →
    `{ events, historySince }`; `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`,
    `listFirebaseStoreApiKeys`. En `operations-app.tsx`, **solo** la adaptacion de los usos actuales de
    `fetchFirebaseOrderAuditTrail` a la forma `{ events, historySince }` (sin cambiar lo que se pinta: eso es
    T22).
  * Verificacion: bloque `describe("T18 · ...")`: los cuatro envoltorios llaman a la callable de su nombre;
    en `operations-app.tsx` todo uso de `fetchFirebaseOrderAuditTrail(` lee `.events`; `npx tsc --noEmit`
    limpio con los usos actuales adaptados.

- [ ] **T19: Modelos de vista**
  * Requisitos cubiertos: RF_25, RF_27, RF_17
  * Archivos: src/lib/store-api-keys-view.ts, src/lib/store-api-keys-view.test.ts, src/lib/order-audit-trail-view.ts, src/lib/order-audit-trail-view.test.ts
  * Accion: estados de la seccion de escritura (sin clave, recien generada, activa, error de generar, error de
    rotar, cargando, logistico sin botones), key en dos lineas de 24, paginas de 6 (escritorio) y 4 (movil),
    busqueda; historial: pildora de origen ("API", "Kentro", "Tu tienda", "Panel"), nombres de campo visibles,
    "Antes"/"Ahora", nota de alcance con la fecha de `historySince` (sin nota si es `null` o hay error).
  * Verificacion: `store-api-keys-view.test.ts` y `order-audit-trail-view.test.ts` con un caso por estado del
    README (decisiones 3-7, 9-14).

- [ ] **T20: Seccion "Clave de escritura" de la tienda**
  * Requisitos cubiertos: RF_25, RF_26
  * Archivos: src/components/store-api-write-key.tsx, src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts
  * Accion: `StoreApiKeyCard` en dos secciones `h3` ("Clave de lectura" con su comportamiento de hoy y el boton
    renombrado; "Clave de escritura" con el componente nuevo); dialogo de rotar (foco en "Cancelar", Escape);
    pantallas `HU_04.tienda-*`.
  * Verificacion: bloque `describe("T20 · ...")`: `store-api-write-key.tsx` no usa `localStorage` ni
    `sessionStorage`; `operations-app.tsx` solo monta; el dialogo no usa `window.confirm`; E2E en `/sdd-verify`
    contra los cinco `HU_04.tienda-*.screen.json`.

- [ ] **T21: Panel "Claves de API de tiendas" del admin**
  * Requisitos cubiertos: RF_25, RF_26
  * Archivos: src/components/store-api-keys-admin.tsx, src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts
  * Accion: panel plegable tras "Incidencias de sincronizacion"; tabla (escritorio) y tarjetas (movil);
    dialogo de recien generada; mismo componente de seccion que T20.
  * Verificacion: bloque `describe("T21 · ...")`: montado solo para admin; la columna Lectura no muestra la key;
    E2E en `/sdd-verify` contra `HU_04.admin-*.screen.json`.

- [ ] **T22: "Historial del pedido" con origen y cambios**
  * Requisitos cubiertos: RF_27, RF_17, RF_24
  * Archivos: src/components/order-audit-trail.tsx, src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts
  * **Compuerta:** no empieza hasta que `sdd-uxui` ratifique en el README del diseno las etiquetas
    "Direccion revisada" (`order.address_reviewed`) y "Recogido" (`order.picked_up`) (plan, seccion 12; lo
    lanza la sesion principal). Si cambian el texto, se usa el del README.
  * Accion: `OrderAuditTrail` sacado a su archivo; nombre fijo "Historial del pedido" con `aria-expanded`;
    nota de alcance; eventos con pildora, accion, transicion y "Antes/Ahora"; vacio; error con "Reintentar";
    etiquetas nuevas en `AUDIT_ACTION_LABELS` ("Datos de entrega corregidos" y las dos ratificadas por
    `sdd-uxui`).
  * Verificacion: bloque `describe("T22 · RF_27")`: `order-audit-trail.tsx` no pinta `actorEmail`,
    `actorLabel` ni `actorRole` cuando el evento trae `storeActorTag`; no hay fecha literal; las etiquetas de
    `AUDIT_ACTION_LABELS` para las tres acciones nuevas coinciden con el README; E2E en `/sdd-verify` contra los
    seis `HU_05.*.screen.json`.

- [ ] **T23: El "?" de `CollapsiblePanel` mide 44 px**
  * Requisitos cubiertos: RF_25 — aceptada por el orquestador el 2026-10-04 como parte del diseno de HU_04: el
    "?" vive en el panel de la clave de API y su area tactil es requisito WCAG 2.2 AA de la spec (pendiente 3
    del README)
  * Archivos: src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts, src/lib/spec-013-guards.test.ts (solo si su bloque de `CollapsiblePanel` deja de reconocer el boton)
  * Accion: boton de ayuda de `h-8 w-8` a `h-11 w-11`, icono de 16 px y forma circular sin cambio.
  * Verificacion: bloque `describe("T23 · ...")`: el boton de ayuda de `function CollapsiblePanel(` no contiene
    `h-8`/`w-8` y si `h-11 w-11`; guardas de la 013 verdes; E2E en `/sdd-verify`: `boundingBox()` del "?" de
    Integraciones a 375 y 1280 con ancho y alto >= 44; captura en `EV/`.

## Verificacion contra produccion y entrega

- [ ] **T24: Captura de lecturas antes de desplegar**
  * Requisitos cubiertos: RF_20, RF_01
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t24-reads-antes.json
  * Accion: `capture-reads`: `/resumen`, `/kpis`, `/orders`, `/settlements` y el indice de tres tiendas reales
    con su key de lectura (keys leidas del servidor, nunca escritas en la evidencia); `compare-reads` (ignora
    campos dependientes del reloj declarados en el guion; del indice compara solo las claves actuales, RF_20)
    para despues del despliegue.
  * Verificacion: bloque `describe("T24 · ...")`: el modo solo hace `GET`; la evidencia no contiene ninguna key
    (busqueda de 48 hex y de `kw_`); captura sin error.

- [ ] **T25: Kovia: fixture real y replay firmado**
  * Requisitos cubiertos: RF_11
  * Archivos: src/lib/fixtures/029-kovia-order.json, src/lib/order-seller-actions.test.ts, scripts/verify-029.js, src/lib/spec-029-guards.test.ts
  * Accion: copiar en solo lectura un pedido real de Kovia y su payload de Shopify, sustituyendo nombre,
    telefono y direccion por valores sinteticos de la misma forma; modo `kovia-replay` del guion: webhook con la
    forma de Kovia firmado con el secreto de Shopify hacia la tienda de pruebas, sobre un pedido ya corregido por
    API.
  * Verificacion: bloque `describe("T25 · ...")` en `order-seller-actions.test.ts`: corregir el fixture y
    reimportarlo con `mergeImportedOrder` conserva cliente y direccion, y el `status` no cambia aunque el payload
    venga cancelado; guarda: el fixture no contiene telefonos ni correos reales (patron) y `kovia-replay` solo
    apunta a `seller-test-029`.

- [ ] **T26: Manual de la API**
  * Requisitos cubiertos: RF_17, RNF_01, RNF_02 (DoD 5)
  * Archivos: src/app/api-tiendas/page.tsx, src/lib/spec-029-guards.test.ts
  * Accion: rutas nuevas, codigos, estados editables, `historySince`, que el historial no incluye
    importaciones ni ChatBy, key de escritura solo por cabecera (cualquier key por query en una escritura da
    401), `Idempotency-Key`, limite y ciudades activas.
  * Verificacion: bloque `describe("T26 · ...")`: la pagina menciona cada `code` del catalogo de T8, las tres
    rutas de escritura, `Authorization: Bearer` y `historySince`.

- [ ] **T27: Despliegue, recorrido real y limpieza**
  * Requisitos cubiertos: RF_20, RF_27, RF_16 (excepcion del `cleanup`), RNF_05, DoD 3
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-smoke.txt
  * Accion: modos `set-history-since` (`create`), `smoke --setup` (tienda, usuarios y pedidos de prueba del plan
    5.3), CA_01-CA_12, RF_27 con sesiones reales, p95 de escrituras y de `GET /orders/{id}`, `compare-reads`,
    `cleanup`. Orden de despliegue del plan 10 (humano).
  * Verificacion: bloque `describe("T27 · ...")`: `set-history-since` usa `create`; `cleanup` borra solo ids de
    prueba creados por el propio `smoke --setup` (tambien su `orderHistory`, unica excepcion de RF_16) y falla
    si queda algo; las escrituras del guion solo apuntan a `seller-test-029`. Evidencia con p95 < 2 s,
    `compare-reads` sin diferencias, `cleanup` en cero.
