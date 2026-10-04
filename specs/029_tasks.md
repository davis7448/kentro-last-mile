# Tareas — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API

Plan: `specs/029_plan.md` (preguntas P1-P5 resueltas el 2026-10-04; precisado tras cuatro pasadas de
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
de su transaccion). `functions/src/store-api.ts`: T9, T10 (autenticacion de rutas viejas, filtro
`shopifyOrderId` y rutas de lectura nuevas), T11, T13, cada una en su ruta. `operations-app.tsx`: T18 (solo la
adaptacion de `fetchFirebaseOrderAuditTrail`), T20, T21, T22, T23, cada una en su punto de montaje.
`scripts/verify-029.js`: T1, T2, T24, T25, T27, cada una en su modo; las salvaguardas de envio y de limpieza
(plan 5.3 (a)-(c)) son un modulo comun del guion que crea T25 y reutiliza T27.

**Reglas transversales:** escrituras nuevas con `stripUndefined`; la regla de confirmar/corregir/cancelar solo
en `order-seller-actions.ts` (plan 2.2), y el sello `MANUAL_EDIT_STAMP` solo lo pone el nucleo; la idempotencia
gana sobre `expectedStatus` (no-op antes que `status_changed`); `orderHistory` nunca guarda
`driverId`/`messengerId`; la key de escritura nunca en logs, en Firestore en claro ni en `localStorage`; el
secreto de Shopify nunca en disco ni en logs; `STORE_API_WRITES_PER_MINUTE` es el unico sitio del limite;
`historySince` nunca como literal; con tiendas reales, solo key de lectura y ninguna sesion con permisos sobre
ellas; todo envio de prueba con las salvaguardas del plan 5.3.

## Medicion previa (compuertas)

- [ ] **T1: Linea base contra produccion, solo lectura**
  * Requisitos cubiertos: RF_01, RF_02, RF_08, RF_10, RF_22, RF_27, RNF_05
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t1-linea-base.txt
  * Accion: modo `baseline`: tipos de `shopifyOrderId` guardados (texto / numero / mixto) por tienda; pedidos
    por estado y con/sin `driverId` en los tres editables; `address_risk` con lider; `cities` activas; eventos
    de `auditEvents` por `action` y por presencia de `actorRole` (para la lista permitida, plan 2.7); configs
    de `storeApiConfigs` (sin imprimir keys); **cortes (`settlements`) con algun `cashAllocations[].orderId` que
    no este en su `orderIds`** (recuento y, si hay, sus ids; esperado 0, plan 2.10); comprobar en codigo que
    `uchat-pull.ts` y `uchat-webhook.ts` confirman dentro de `runTransaction`.
  * Verificacion: bloque `describe("T1 · verify-029 baseline es de solo lectura")` (sin `.set(`, `.update(`,
    `.delete(`, `.create(`, `batch(`, `runTransaction(` fuera de los modos de escritura declarados);
    `node scripts/verify-029.js baseline` sin error y con el recuento de `cashAllocations` fuera de `orderIds`
    escrito en la evidencia. Compuertas: `shopifyOrderId` mixto → T10 usa `in`; recuento de `cashAllocations`
    > 0 → parar T9/T10 y reportar; ChatBy sin transaccion → reportar antes de T6; accion historica con identidad
    en el `summary` dentro de la lista permitida → reportar antes de T14.

- [ ] **T2: Consultas exactas e indices**
  * Requisitos cubiertos: RNF_05, RF_01, RF_02, RF_17
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t2-query-check.txt, firestore.indexes.json (solo si una consulta pide indice)
  * Accion: `query-check` con `limit(1)`: `orders` `sellerId` + `shopifyOrderId`; `walletEntries` `orderId`;
    `settlements` `orderIds array-contains`; `orderHistory` `orderId` (vacia hoy: comprobar que no pide
    indice); `cities` `active`. Junto a `array-contains`, repite y deja en la evidencia el recuento de cortes con
    `cashAllocations[].orderId` fuera de `orderIds` (esperado 0), que es lo que hace suficiente esa consulta. Si
    alguna pide indice, comparar con `firebase firestore:indexes` y **anadir**.
  * Verificacion: bloque `describe("T2 · query-check")`: el modo existe y solo lee; evidencia sin error y con
    el recuento; `firestore.indexes.json` sin cambios o solo con entradas anadidas.

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
    (`panel` / `api`), el **orden comun de evaluacion** (tienda → no-op → `expectedStatus` → reglas de estado) y
    el parche de cancelar con `driverId: current.driverId ?? null` como hoy.
  * Verificacion: bloque `describe("T4 · ...")`: `imported` sin lider → `ready_to_assign`, `accepted`,
    `confirmedVia` `api`/`manual`; `imported` con lider → 409 `order_not_editable` con `hasLeader: true` en API
    (y aplica en panel, como hoy); `ready_to_assign`, `in_route`, `delivered` → `unchanged` en API y rechazo en
    panel; **la idempotencia gana sobre `expectedStatus`:** confirmar un `ready_to_assign` con
    `expectedStatus: "imported"` → `unchanged` (no `status_changed`), y cancelar un `cancelled` con
    `expectedStatus: "imported"` → `unchanged`; **`expectedStatus` solo cuando cambiaria algo:** confirmar un
    `imported` con `expectedStatus: "ready_to_assign"` → `status_changed`, cancelar un `imported` con
    `expectedStatus: "address_risk"` → `status_changed`, y confirmar un `address_risk` con `expectedStatus`
    distinto → `status_changed` (antes que `address_review_pending`); `cancelled` → `order_cancelled` al
    confirmar; `address_risk` sin lider y `address_risk` con lider → los dos `address_review_pending` (RF_21
    prevalece; nunca `order_not_editable` al confirmar un `address_risk`); cancelar editable con motivo →
    `cancelled`, `callNote`, `driverId: null` en el parche (desde `current.driverId ?? null`), `inventory:
    "release"` si reservo y no `imported`; panel (admin) cancelando un `assigned` → parche con el `driverId`
    actual, como hoy; `assigned`, `imported` con lider y `address_risk` con lider → `order_not_editable` al
    cancelar en API; otra tienda → `order_not_found`.

- [ ] **T5: Corregir datos de entrega, validacion e historial (puro)**
  * Requisitos cubiertos: RF_07, RF_08, RF_09, RF_10, RF_11, RF_12, RF_16, RF_22, RF_23
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: `validateDeliveryInput` (reglas de contenido de la tabla 4.4, todos los errores a la vez, con la
    excepcion de `deliveryNotes` solo para la API), `planDeliveryCorrection` (pasos 1-10 del plan 4.1, incluido
    `order.address_reviewed` sin campos cambiados, P1, y `panelExtras` con politica `panel`: cuentan como
    cambio, siempre en el parche, sello y auditoria puestos por el nucleo), `buildOrderHistoryRecord`.
  * Verificacion: bloque `describe("T5 · ...")`: solo campos enviados; `imported` sigue `imported`;
    `in_route`, `call_pending`, `address_risk` con lider, `imported` con lider → 409; correccion con los mismos
    valores sobre un editable que no esta en `address_risk` → `unchanged` aunque `expectedStatus` no coincida;
    con un campo que cambia y `expectedStatus` distinto → `status_changed`; telefono valido + ciudad inactiva →
    `out_of_coverage` y el telefono no esta en el parche; telefonos validos (10 digitos, `+57`, E.164) e
    invalidos; politica `api`: `deliveryNotes: ""` y `deliveryNotes: null` → borran las indicaciones (cambio a
    `null` en el historial) y no dan `no_fields`; politica `panel`: **indicaciones en blanco se conservan** (ni
    en el parche ni en el historial); **edicion del panel solo de producto** (`panelExtras` con otro
    `productName`/`totalCop`, entrega identica) → `applied`, parche con el producto y `MANUAL_EDIT_STAMP`,
    evento `order.imported_updated`, historial con `productName`/`totalCop` (y `sku`/`quantity` si cambian);
    `customerName`, `customerPhone`, `addressRaw` o `cityId` vacios o `null` → `empty`; `panelExtras` con
    politica `api` → lanza; direccion cambiada (API) → `clear` con los cuatro campos; `address_risk` sin lider con
    valores identicos → `imported` + `review` + `order.address_reviewed` con solo `status`; propiedad: ningun
    plan `api` emite `address_risk`; sello `MANUAL_EDIT_STAMP` presente en todo plan `applied` de correccion;
    historial sin `driverId`/`messengerId` y `null` sin cambios; el resultado pasado por `mergeImportedOrder`
    conserva cliente y direccion.

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
    confirmar (ChatBy y API), el segundo con `expectedStatus: "imported"` → ve `ready_to_assign` y responde
    `unchanged`, sin 409, sin segundo evento ni segundo historial; (b) un lider toma el pedido (`driverId`
    puesto) entre la lectura y el commit de una correccion → el reintento responde 409 `order_not_editable` y no
    aplica ningun campo; (c) cancelar + cancelar → el segundo `unchanged`.

- [ ] **T6b: Delegacion de las tres callables del panel, guardas 017 y anti-copia**
  * Requisitos cubiertos: RF_19, RF_11, RF_16
  * Archivos: functions/src/orders.ts, src/lib/spec-017-guards.test.ts, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/mutacion-rf19.txt
  * Accion: `confirmImportedOrder`, `updateImportedOrder` y `cancelOrder` delegan en el ejecutor de T6 con
    politica `panel`, sin cambiar sus mensajes ni sus codigos de error. `updateImportedOrder` traduce los campos
    extra (producto/`lineItems` via `resolveEditedOrderLines` intacto, pago, modo, valor, zona,
    `normalizedAddress` y demas que escribe hoy) a `panelExtras`; no escribe el sello ni ningun campo del
    pedido. `cancelOrder` deja de tener su propio parche (incluido `driverId: current.driverId ?? null`, que pasa
    al nucleo tal cual) y su lista literal de estados cerrados. **Guarda 7 de la 017, sus dos pruebas, con su
    razon escrita en la guarda:** (1) el sello `[MANUAL_EDIT_STAMP]:` pasa de 2 a 1 en `orders.ts` (queda
    `updateOrderAdjustments`) y la de `updateImportedOrder` se cuenta en `order-seller-actions.ts` (1);
    (2) el literal `["delivered", "failed", "cancelled", "liquidated"]` pasa de 2 a 1 en `orders.ts`, porque el
    de `cancelOrder` desaparece al delegar en el nucleo (que usa `CLOSED_STATUSES`) y queda solo el de inventario.
  * Verificacion: `spec-017-guards.test.ts` verde con las dos pruebas de la guarda 7 actualizadas (1 sello en
    `orders.ts` + 1 en el nucleo; 1 literal de estados cerrados en `orders.ts`), cada una con la razon en un
    comentario; bloque `describe("T6b · RF_19 anti-copia")` en `spec-029-guards.test.ts`: las tres callables
    llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel` y sus cuerpos no contienen
    `status: "ready_to_assign"`, `status: "cancelled"`, `addressRisk: "accepted"` ni `[MANUAL_EDIT_STAMP]`;
    `updateImportedOrder` contiene `resolveEditedOrderLines(` y `panelExtras`; `order-seller-actions.ts` contiene
    `driverId: current.driverId ?? null` (o la misma expresion sobre el pedido leido) en el parche de cancelar;
    mutacion a mano (pegar el parche de confirmar en una callable) pone la guarda en rojo, registrada en
    `EV/mutacion-rf19.txt`.

- [ ] **T7: Reglas y `settings/storeApi`**
  * Requisitos cubiertos: RF_16, RF_17, RF_24
  * Archivos: firestore.rules, src/lib/spec-029-guards.test.ts
  * Accion: bloques `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits` con `allow read, write: if
    false`; **acotar la regla general de `settings`** a `allow write: if isAdmin() && settingId != "storeApi";`
    (la lectura no cambia), para que `settings/storeApi` solo lo escriba el Admin SDK del guion (plan 2.4, 7).
  * Verificacion: bloque `describe("T7 · ...")`: los tres bloques con su regla; el bloque
    `match /settings/{settingId}` tiene un `allow write` que exige `isAdmin()` **y** `settingId != "storeApi"`, y
    no hay otro `allow write` ni `allow create/update` en `settings` sin esa condicion; ninguna fuente de `src/`
    ni `functions/src/` contiene un literal de fecha asociado a `historySince`; ninguna fuente salvo los modos
    `cleanup` de `scripts/verify-029.js` hace `delete`/`update` sobre `orderHistory` (excepcion de RF_16).

## API

- [ ] **T8: Peticion, errores y limite (puro)**
  * Requisitos cubiertos: RF_03, RF_09, RF_12, RF_13, RNF_02, RNF_04
  * Archivos: functions/src/store-api-request.ts, src/lib/store-api-request.test.ts, src/lib/spec-029-guards.test.ts
  * Accion: `routeStoreApiRequest` (rutas nuevas y viejas, `Allow` por ruta), parametros permitidos por ruta,
    **validador puro de `shopifyOrderId`** (`^[0-9A-Za-z#._-]{1,64}$`, plan 2.10; T10 solo lo llama y responde
    con la forma vieja); `parseWriteBody` segun el plan 4.4: separa `expectedStatus` **antes** de validar;
    anota cada clave no permitida (`not_allowed`); valida forma y tipos de las permitidas con Zod (solo forma y
    tipos basicos; `invalid_type`); valida el contenido con `validateDeliveryInput` (T5) en `PATCH` y el motivo
    en cancelar (obligatorio, recortado 1-500); responde 422 con **todos** los campos anotados de los dos tipos,
    cada uno con su motivo, y `code` de primer nivel `field_not_allowed` si hay alguno `not_allowed`, si no
    `validation_failed`; catalogo `code` → HTTP (con `key_in_query` en 401), `buildErrorBody`, `bodyHash`
    canonico, `STORE_API_WRITES_PER_MINUTE = 120`, `rateWindow(now)` → `{ bucketId, retryAfterSeconds }`.
  * Verificacion: bloque `describe("T8 · ...")`: parametro desconocido → 400 nombrando cada uno en cada ruta
    nueva; `key` en ruta de escritura no se reporta como parametro desconocido (lo resuelve T3 con 401); rutas
    viejas sin validacion de parametros; `shopifyOrderId` valido (`1001`, `#1001`, `KOV-1001`) e invalido
    (vacio, 65 caracteres, espacios, `/`); `expectedStatus` no cuenta como campo (cuerpo `{ expectedStatus }` en
    `PATCH` → `no_fields`, nunca `field_not_allowed`); cuerpo con `totalCop` y `sku` → `field_not_allowed`
    listando los dos con `not_allowed`; cuerpo con `totalCop` y `customerName: ""` → `field_not_allowed` de
    primer nivel y `fields` con los dos (`totalCop` `not_allowed`, `customerName` `empty`); cuerpo con
    `customerName: ""` y telefono invalido → `validation_failed` con los dos campos; tipo incorrecto
    (`customerName: 5`) → `validation_failed` con `invalid_type`; cancelar sin motivo → 422
    `validation_failed` (`reason` `required`), motivo solo espacios → `empty`, motivo de 1 y de 500 caracteres
    pasa, de 501 → `too_long`; catalogo congelado (nombres y HTTP); `Retry-After` >= 1; hash igual con claves en
    otro orden. Guarda: el limite solo aparece en `STORE_API_WRITES_PER_MINUTE`; `store-api-request.ts` no repite
    reglas de contenido de entrega (importa `validateDeliveryInput`).

- [ ] **T9: Forma de pedido extraida sin cambiar la salida**
  * Requisitos cubiertos: RF_01, RF_20
  * Archivos: functions/src/store-api-orders.ts, functions/src/store-api.ts, src/lib/store-api-orders.test.ts
  * Accion: mover `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` y su ayudante de fecha a
    `store-api-orders.ts` tal cual; `store-api.ts` los importa. Anadir `loadTargetedPaymentInputs` puro sobre
    asientos y cortes ya leidos. No empieza si el recuento de T1/T2 de `cashAllocations` fuera de `orderIds` no
    es 0.
  * Verificacion: `store-api-orders.test.ts`: con fixtures (cortes ajenos, `cashAllocations`, parcialmente
    cubierto, prepago, sin asientos) `buildPaymentInfo` con los cortes dirigidos == con todos los cortes;
    instantanea de un payload de `/orders` antes y despues de mover identica.

- [ ] **T10: Autenticacion de todas las rutas, `GET /orders/{id}` y filtro por `shopifyOrderId`**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_20, RNF_01, RNF_05
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-write.test.ts
  * Accion: **conectar `resolveStoreCredentials` (T3) en `store-api.ts` para las rutas viejas** (sustituye su
    comparacion propia; los errores conservan la forma `{ ok: false, error }` de hoy) y para las de lectura
    nuevas; el handler de `storeApi` recibe el `db` inyectable para poder probarlo. Carga dirigida (plan 2.10);
    404 identico (mismo HTTP y mismo cuerpo) para ajeno e inexistente. Filtro `shopifyOrderId` en `GET /orders`
    (ruta existente): consulta siempre acotada al `sellerId` de la key, con `in` si T1 midio tipos mixtos;
    `from`/`to` ignorados; **`status` y `limit` aplicados** sobre lo encontrado como hoy; formato decidido por el
    validador de T8 y, si falla, **400 con la forma vieja** `{ ok: false, error: "invalid_shopify_order_id" }`.
  * Verificacion: bloque `describe("T10 · RNF_05")` en guardas: el handler no contiene
    `where("sellerId", "==", ...)` sin segundo filtro ni `collection("settlements").get()`; `store-api.ts` no
    conserva una comparacion de key propia (`safeEqual(` solo dentro de `store-api-auth.ts`). Bloque
    `describe("T10 · ...")` en `store-api-write.test.ts` con un `db` falso en memoria (la tienda del `db` falso
    hace de tienda de pruebas: es el unico sitio, junto con la tienda de pruebas real de T27, donde se compara con
    key de escritura): **rutas viejas (RF_20, RNF_01)** — el handler viejo con una key `kw_` por query en
    `/resumen` y `/orders` → 401 con cuerpo `{ ok: false, error: "invalid_key" }` (sin `code`); con la key de
    escritura por Bearer → 200 con la misma respuesta, comparada por valor, que con la key de lectura; con la key
    de lectura por query → 200 como hoy; **RF_02** — devuelve solo los pedidos de la tienda de la key con ese
    numero; con `from`/`to` que excluirian la fecha del pedido lo devuelve igual; con `status` que no coincide →
    lista vacia; con dos pedidos del mismo numero (texto y numero) y `limit=1` → uno; el mismo numero en otra
    tienda no aparece, y un numero que solo existe en otra tienda da lista vacia (200); un `shopifyOrderId`
    invalido → 400 `{ ok: false, error: "invalid_shopify_order_id" }` (sin `code` ni `message`) sin consultar;
    **RF_01 / RNF_01** — `GET /orders/{id}` de un pedido de otra tienda y de uno inexistente dan 404
    `order_not_found` con cuerpo identico (comparacion profunda).

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
  * Accion: `decideIdempotency(stored, { bodyHash, now })` → `replay | conflict | fresh`; **la decision que
    vale se toma dentro de la transaccion del ejecutor** (`order-seller-actions-run.ts` recibe la key, vuelve a
    leer el registro en la transaccion, decide y lo escribe junto al pedido, **tambien cuando el plan rechaza con
    409**, en cuyo caso es la unica escritura); el handler puede leer antes fuera de la transaccion **solo como
    atajo** para responder pronto `replay`/`conflict` (plan 2.1, 2.8); ventana de tasa en transaccion corta
    previa; 429 con `Retry-After`.
  * Verificacion: bloque `describe("T12 · ...")` en `store-api-request.test.ts`: misma key y cuerpo →
    `replay`; otro cuerpo → `idempotency_key_reused`; expirado → `fresh`; key vacia o > 255 →
    `invalid_idempotency_key`; contador 121 → 429 y nunca 403; se guardan 200 y 409 y no 422. Bloque
    `describe("T12 · ...")` en `order-seller-actions-run.test.ts` con una transaccion falsa: una correccion
    rechazada con 409 (`order_not_editable`) **escribe el registro idempotente** con `status: 409` y su cuerpo,
    y ninguna escritura en `orders`, `auditEvents` ni `orderHistory`; una aplicada escribe el registro con 200
    en la misma transaccion que el pedido; un 422 no escribe registro; **el atajo no decide:** con el atajo
    diciendo `fresh` y un registro ya presente al leer dentro de la transaccion (otra peticion gano), el
    ejecutor responde `replay` con la respuesta guardada y no aplica el cambio.

- [ ] **T13: Historial por API e indice**
  * Requisitos cubiertos: RF_17, RF_18, RF_20, RF_24
  * Archivos: functions/src/store-api-history.ts, functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/store-api-history.test.ts, src/lib/store-api-write.test.ts
  * Accion: `toStoreHistoryResponse(records, historySince)` con lista explicita de claves, orden ascendente,
    `excludes` y `aviso`; `GET /orders/{id}/history` (comprueba antes que el pedido es de la tienda; 503
    `history_not_ready` sin `settings/storeApi`); indice (plan 2.1): la documentacion nueva (rutas nuevas,
    codigos, estados editables, `historySince`, `HISTORY_EXCLUDES` y su aviso, key solo por cabecera) va **solo
    en claves nuevas de primer nivel**; los valores de las claves actuales (rutas, autenticacion y el resto) no
    se tocan.
  * Verificacion: bloque `describe("T13 · ...")` en `store-api-history.test.ts`: ningun registro de salida
    trae `actor`, `uid` ni `auditEventId`; orden del mas viejo al mas nuevo; vacio → `registros: []` con
    `historySince`. Indice: con una instantanea del indice de hoy, el nuevo tiene **cada clave actual con valor
    identico** (comparacion profunda por valor, sin claves anadidas dentro de ellas) y las claves nuevas de
    primer nivel contienen las rutas nuevas, las exclusiones, los codigos, los estados editables y
    `historySince`. Bloque `describe("T13 · ...")` en `store-api-write.test.ts` con un `db` falso: historial de
    un pedido de otra tienda → 404 `order_not_found` con el mismo cuerpo que uno inexistente y sin leer
    `orderHistory`; sin `settings/storeApi` → 503 `history_not_ready`; con el documento → 200 con
    `historySince` de ese documento.

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
    para el admin, un evento de la API trae `apiKeyLast4` (los 4 ultimos de la key) y `actorLabel`
    "Clave de escritura de <nombre de la tienda>", y esos dos campos no aparecen nunca en la salida para
    `seller`/`seller_logistics`. Guarda: en `getOrderAuditTrail` la llamada a `resolveAuditActors` esta en la
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

- [ ] **T16: Historial en mensajero, recogida y correcciones; clasificacion de todo escritor de `orders`**
  * Requisitos cubiertos: RF_16, RF_24
  * Archivos: functions/src/orders.ts, functions/src/order-corrections.ts, src/lib/spec-029-guards.test.ts
  * Accion: `assignMessengerToOrders`, `unassignMessengerFromOrders` (solo `status`), `createOrUpdatePickupBatch`
    (evento `order.picked_up` nuevo + registro), `correctOrderStatus` (en su batch). Guarda de clasificacion con
    el criterio de la 017: **las callables y modulos de `functions/src` que escriben `orders`, detectados con
    `writesOrders`** (reutilizado de `spec-017-guards.test.ts`), cada uno clasificado en la tabla 2.6 del plan o
    en sus exclusiones explicitas. Si `writesOrders` encuentra un escritor que no cambia `status` ni datos de
    entrega y no esta en la lista, se anade a las exclusiones con su razon (una entrada por escritor).
  * Verificacion: bloque `describe("T16 · ...")`: el conjunto de escritores de `orders` que devuelve
    `writesOrders` es **igual** a la union de dos listas declaradas en la guarda, alineadas con el plan 2.6:
    **registran** (su cuerpo contiene `buildOrderHistoryRecord(`): `confirmImportedOrder`, `updateImportedOrder`,
    `cancelOrder` (via ejecutor), `order-seller-actions-run.ts`, `confirmRetryOrder`, `updateOrderAdjustments`,
    `applyOrderTransition`, `closeOrder`, `assignMessengerToOrders`, `unassignMessengerFromOrders`,
    `createOrUpdatePickupBatch`, `correctOrderStatus`; **excluidos** (no la contienen), cada uno con su razon:
    `createManualOrder` (creacion), `shopify.ts`, `index.ts` (`shopifyWebhook`), `store-webhook.ts`,
    `onstock-webhook.ts`, `contact-form.ts` (importaciones, spec 031), `uchat-pull.ts`, `uchat-webhook.ts`
    (ChatBy, spec 031), `classifyFailedOrder` (solo `failedCategory`) y los que T16 anada por la regla de arriba.
    Un escritor nuevo sin clasificar, o uno de la lista "registran" sin `buildOrderHistoryRecord(`, pone la
    guarda en rojo; ninguna fuente lee `auditEvents` para escribir `orderHistory` (RF_24). La guarda lleva un
    comentario de cabecera que remite a la 032 por las escrituras directas de cliente
    (`operationalOrderUpdateByAssignee`), que no puede ver.

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
  * **Compuerta:** no empieza hasta que `sdd-uxui` ratifique en el README del diseno las etiquetas
    "Direccion revisada" y "Recogido" y los **nombres visibles de `totalCop`, `productName`, `sku` y
    `quantity`** en "Antes/Ahora" (plan, seccion 12; lo lanza la sesion principal).
  * Accion: estados de la seccion de escritura (sin clave, recien generada, activa, error de generar, error de
    rotar, cargando, logistico sin botones), key en dos lineas de 24, paginas de 6 (escritorio) y 4 (movil),
    busqueda; historial: pildora de origen ("API", "Kentro", "Tu tienda", "Panel"), nombres de campo visibles
    (los cinco de entrega, `status` y los cuatro de producto y valor, con los textos del README), "Antes"/"Ahora",
    nota de alcance con la fecha de `historySince` (sin nota si es `null` o hay error).
  * Verificacion: `store-api-keys-view.test.ts` y `order-audit-trail-view.test.ts` con un caso por estado del
    README (decisiones 3-7, 9-14); cada `OrderHistoryField` tiene nombre visible y coincide con el del README.

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
    "Direccion revisada" (`order.address_reviewed`) y "Recogido" (`order.picked_up`) y los nombres visibles de
    `totalCop`, `productName`, `sku` y `quantity` (plan, seccion 12; lo lanza la sesion principal). Si cambian
    el texto, se usa el del README.
  * Accion: `OrderAuditTrail` sacado a su archivo; nombre fijo "Historial del pedido" con `aria-expanded`;
    nota de alcance; eventos con pildora, accion, transicion y "Antes/Ahora" (nombres de campo del modelo de
    vista de T19); vacio; error con "Reintentar"; etiquetas nuevas en `AUDIT_ACTION_LABELS` ("Datos de entrega
    corregidos" y las dos ratificadas por `sdd-uxui`).
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
    **solo con su key de lectura** (keys leidas del servidor, nunca escritas en la evidencia); `compare-reads`
    para despues del despliegue: compara **por valor** (comparacion profunda, no por forma ni por longitud),
    ignorando solo los campos dependientes del reloj declarados en el guion; del indice compara **el valor de
    cada clave actual** y admite unicamente claves nuevas de primer nivel (RF_20). La comparacion con key de
    escritura no se hace sobre tiendas reales: solo sobre la tienda de pruebas, en T27.
  * Verificacion: bloque `describe("T24 · ...")`: el modo solo hace `GET`; contra tiendas que no sean
    `seller-test-029` solo usa la key de lectura (el guion no lee `writeKey*` de configs reales); `compare-reads`
    usa comparacion profunda por valor y su lista de campos ignorados es explicita; la evidencia no contiene
    ninguna key (busqueda de 48 hex y de `kw_`); captura sin error.

- [ ] **T25: Forma de Kovia: fixture sintetico y replay firmado sobre la tienda de pruebas**
  * Requisitos cubiertos: RF_11, RF_16 (excepcion del `cleanup`)
  * Archivos: src/lib/fixtures/029-kovia-order.json, src/lib/order-seller-actions.test.ts, scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t25-kovia-replay.txt
  * Accion: (a) copiar en solo lectura un pedido real de Kovia y su payload de Shopify como fixture,
    sustituyendo nombre, telefono, direccion **e id de Shopify** por valores sinteticos de la misma forma (id en
    el rango reservado del guion). (b) **Modulo de salvaguardas del guion** (plan 5.3), reutilizado por T27:
    `assertNotExists(ruta)` justo antes de cada envio (aborta si el documento que la via crearia ya existe);
    constantes de ids sinteticos (rango reservado de id de Shopify, p. ej. `9029000000000`-`9029000000999`,
    prefijo `TEST-029-` del numero de pedido, prefijo `test-029-` del id externo del webhook de tienda, dominio
    `kentro-test-029.myshopify.com`); `safeDelete(doc)` que lee el documento y **se niega a borrar** (aborta con
    error) si no tiene `sellerId == "seller-test-029"`, salvo el `shopifyStores` de prueba (por su dominio
    sintetico) y los `importRuns` registrados por el propio guion. (c) Modo `kovia-replay`: crea el
    `shopifyStores` de prueba apuntando a `seller-test-029`; `assertNotExists("orders/shopify-<id sintetico>")`;
    **replay 1** al `shopifyWebhook` con el payload de forma Kovia, firmado con HMAC calculado leyendo el secreto
    de Shopify existente **solo en memoria** (nunca a disco, evidencia ni logs); `PATCH` por API con la key de
    escritura de la tienda de pruebas; antes del **replay 2**, comprueba que el pedido existente es el del
    replay 1 (`sellerId == "seller-test-029"`) o aborta; replay 2 (mismo payload); comprobacion de RF_11
    (cliente y direccion corregidos conservados, estado sin cambio, fase `edited`). (d) `kovia-replay --cleanup`
    (tambien llamado por el `cleanup` de T27), solo con `safeDelete`: `shopifyStores` de prueba, `importRuns` de
    esas corridas, `orderHistory` y `auditEvents` del pedido, y el pedido; falla si queda algo.
  * Verificacion: bloque `describe("T25 · ...")` en `order-seller-actions.test.ts`: corregir el fixture y
    reimportarlo con `mergeImportedOrder` conserva cliente y direccion, y el `status` no cambia aunque el payload
    venga cancelado. Guardas en `spec-029-guards.test.ts` (salvaguardas (d) del plan 5.3): **(a)** toda llamada
    de envio del guion (al `shopifyWebhook` o al `storeOrderWebhook`) va precedida, en la misma funcion, de
    `assertNotExists(`; **(b)** el fixture y el guion solo usan ids de Shopify dentro del rango reservado
    declarado, numeros con `TEST-029-`, ids externos con `test-029-` y el dominio sintetico (ningun literal de id
    o dominio fuera de esas constantes; el fixture no contiene telefonos ni correos reales); **(c)** ningun
    `.delete(` ni `batch.delete(` del guion esta fuera de `safeDelete`, y `safeDelete` compara
    `sellerId` con `"seller-test-029"` sobre el documento leido antes de borrar; `kovia-replay` solo escribe con
    `sellerId` `seller-test-029`; el secreto de Shopify no aparece en ningun `fs.write*`, `console.*` ni en la
    evidencia. Evidencia `EV/t25-kovia-replay.txt` con las tres fases, la comprobacion de RF_11 y el `cleanup`
    en cero.

- [ ] **T26: Manual de la API**
  * Requisitos cubiertos: RF_17, RNF_01, RNF_02 (DoD 5)
  * Archivos: src/app/api-tiendas/page.tsx, src/lib/spec-029-guards.test.ts
  * Accion: rutas nuevas, codigos, estados editables, `historySince`, que el historial no incluye
    importaciones ni ChatBy, key de escritura solo por cabecera (cualquier key por query en una escritura da
    401), `Idempotency-Key` (y que un reintento de una accion ya aplicada responde sin cambios aunque traiga el
    `expectedStatus` anterior), limite y ciudades activas.
  * Verificacion: bloque `describe("T26 · ...")`: la pagina menciona cada `code` del catalogo de T8, las tres
    rutas de escritura, `Authorization: Bearer` y `historySince`.

- [ ] **T27: Despliegue, recorrido real y limpieza**
  * Requisitos cubiertos: RF_20, RF_27, RF_16 (excepcion del `cleanup`), RNF_05, DoD 3
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-smoke.txt
  * Accion: modos `set-history-since` (`create`), `smoke --setup` (tienda `seller-test-029`, usuarios, config
    de webhook de tienda de prueba y pedidos de prueba del plan 5.3: el `imported` **entra por el
    `storeOrderWebhook` de `seller-test-029`**, con id externo `test-029-…`, firmado con su secreto de prueba y
    precedido de `assertNotExists` (salvaguardas de T25); el `address_risk`, el tomado por un lider y el de
    inventario reservado, por `createManualOrder`), CA_01-CA_12, **RF_27 con sesiones reales solo de la tienda de
    pruebas**: el guion **siembra con el Admin SDK**, sobre un pedido de `seller-test-029`, dos `auditEvents` con
    forma historica (sin `origin`, sin `orderHistory`, con `actorId` de un usuario de Kentro): uno de accion
    permitida (`order.transition`) y otro fuera de la lista (`order.messenger_reassigned`), y lo comprueba con la
    sesion `seller` desechable de la tienda de pruebas y con la de admin; p95 de escrituras y de
    `GET /orders/{id}`; `compare-reads` por valor (tiendas reales con key de lectura; key de escritura solo contra
    `seller-test-029`); `cleanup` con `safeDelete`. Ningun usuario con claim de una tienda real. Cada pedido
    creado por webhook consume un numero del contador de `trackingCode` (aceptado, plan 5.3). Orden de despliegue
    del plan 10 (humano).
  * Verificacion: bloque `describe("T27 · ...")`: `set-history-since` usa `create`; el `imported` de prueba se
    crea con una peticion al `storeOrderWebhook` precedida de `assertNotExists(` y no con `createManualOrder`;
    el guion no crea usuarios ni custom claims con un `sellerId` distinto de `seller-test-029`; la siembra de
    eventos historicos escribe solo `auditEvents` con `entityId` de un pedido de `seller-test-029`; `cleanup`
    borra solo mediante `safeDelete` (pedidos, `auditEvents` incluidos los sembrados, su `orderHistory` —unica
    excepcion de RF_16—, `storeApiIdempotency`, `storeApiRateLimits`, `importRuns` de prueba, la config de
    webhook de prueba, el `shopifyStores` de prueba, inventario, usuarios y tienda) y falla si queda algo; las
    escrituras del guion solo apuntan a `seller-test-029`; `compare-reads` solo usa key de escritura con
    `seller-test-029`. Evidencia con p95 < 2 s, el resultado de RF_27 (evento permitido sin identidades y con su
    etiqueta para la tienda; el de fuera de la lista ausente para la tienda; los dos con nombre y correo para el
    admin), `compare-reads` sin diferencias y `cleanup` en cero.
