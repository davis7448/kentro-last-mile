# Tareas — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API

Plan: `specs/029_plan.md` (preguntas P1-P5 resueltas el 2026-10-04; precisado tras siete pasadas de
`/sdd-analyze`, 2026-10-04 y 2026-10-05, la ultima como **pasada final**, seccion 13). Diseno:
`specs/design/029_store_api_confirma_y_corrige_pedidos/` (README + 14 pantallas). Evidencia:
`.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).

Cada tarea empieza por una prueba que falla (RED) y dura 20-30 minutos. Vitest solo recoge
`src/**/*.test.ts`; `functions/src` se importa como `../../functions/src/<modulo>`. Cada tarea lleva al menos un
archivo de prueba en su alcance. Ante dos formas de verificar algo, la mas simple y robusta; ningun mecanismo
nuevo que no pida la spec. Los hallazgos menores de la pasada final van como **"Nota para la prueba"** dentro de
la tarea afectada: se resuelven al escribir su RED, sin otra ronda de analisis.

**Archivos compartidos (plan 5.2):** un bloque `describe("T<n> · ...")` por tarea, sin editar los de otra, en
`src/lib/spec-029-guards.test.ts` (casi todas), `src/lib/order-seller-actions.test.ts` (T4, T5, T15, T25),
`src/lib/order-seller-actions-run.test.ts` (T6, T12), `src/lib/spec-017-guards.test.ts` (T6 guarda 3, T6b
guarda 7; nada mas), `src/lib/store-api-request.test.ts` (T8, T12), `src/lib/store-api-write.test.ts` (T10, T11,
T13), `src/lib/store-api-history.test.ts` (T13, T14), `src/lib/store-api-auth.test.ts` (T3, T17).
`functions/src/orders.ts`: T6b (tres callables), T14 (`getOrderAuditTrail`), T15 y T16 (historial), cada una
en su callable. `functions/src/order-seller-actions-run.ts`: T6 (ejecutor), T12 (registro idempotente dentro
de su transaccion). `functions/src/store-api.ts`: T9, T10 (autenticacion de rutas viejas, filtro
`shopifyOrderId` y rutas de lectura nuevas), T11, T13, cada una en su ruta. `operations-app.tsx`: T18 (solo la
adaptacion de `fetchFirebaseOrderAuditTrail`), T20, T21, T22, T23, cada una en su punto de montaje.
`scripts/verify-029.js`: T1, T2, T24 (modos de solo lectura), T25 (modulo de salvaguardas y modo `kovia-replay`,
sin ejecutarlo en produccion) y T27 (`run-all`, `set-history-since`, `cleanup --from-registro`).

**Reglas transversales:** escrituras nuevas con `stripUndefined`; la regla de confirmar/corregir/cancelar solo
en `order-seller-actions.ts` (plan 2.2), y el sello `MANUAL_EDIT_STAMP` solo lo pone el nucleo; **precedencia de
codigos unica** (decision 12 de la spec, tabla del plan 2.1): ruta y metodo → 401 key en query → 401/403
credenciales → 400 parametros y forma del cuerpo → [429, idempotencia] → 404 → 409 por estado → 422 validacion y
cobertura → sin cambios → 409 `status_changed` → aplicar; `orderHistory` nunca guarda `driverId`/`messengerId`;
la key de escritura nunca en logs, en Firestore en claro, en `localStorage` ni en el registro de `run-all`; el
secreto de Shopify nunca en disco ni en logs; `STORE_API_WRITES_PER_MINUTE` es el unico sitio del limite;
`historySince` nunca como literal; con tiendas reales, solo key de lectura y ninguna sesion de tienda; el guion
solo escribe ids de prueba y todo borrado pasa por `safeDelete`.

## Medicion previa (compuertas)

- [x] **T1: Linea base contra produccion, solo lectura**
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

- [x] **T2: Consultas exactas e indices**
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

- [x] **T3: Credenciales y key de escritura (puro)**
  * Requisitos cubiertos: RNF_01, RNF_02, RF_25, RF_26, RF_20
  * Archivos: functions/src/store-api-auth.ts, src/lib/store-api-auth.test.ts
  * Accion: `generateWriteKey()` (`kw_` + 45 base64url, 48 en total), `writeKeyFingerprint` (sha256 hex),
    `last4`; `resolveStoreCredentials({ route, querySellerId, queryKey, bearer, config })` con la tabla del plan
    2.3 (pasos 1-2 de la precedencia), evaluada en su orden, y las dos comparaciones siempre. En rutas de lectura
    la candidata es **`queryKey ?? bearer`, como hoy**: si viene key por query, es la unica que se evalua. En
    rutas de escritura, cualquier key por query da 401 **antes de mirar parametros**. `planWriteKeyChange({
    config, rotate, actor, now })` → campos `writeKey*` + evento con `entityId = sellerId`, o
    `failed-precondition` (generar con key existente / rotar sin key).
  * Verificacion: `store-api-auth.test.ts`, una prueba por fila de la tabla 2.3: en ruta de escritura,
    **cualquier** `key` por query → 401 `key_in_query` (key de lectura valida, key de escritura valida, key
    invalida, y tambien con una cabecera Bearer valida), nunca 403; key de lectura valida en la cabecera de una
    escritura → 403 `read_only_key` (unico 403); `kw_` por query → 401 en ruta de lectura nueva (`key_in_query`)
    y vieja (`invalid_key` con la forma `{ ok, error }` de hoy); key de lectura por query en ruta de lectura →
    pasa; escritura por Bearer en lectura → pasa; en ruta de lectura (vieja y nueva), key de query invalida +
    Bearer valida (de lectura o de escritura) → 401 `invalid_key` (la Bearer no se evalua); `status` inactivo →
    `invalid_key`; **precedencia (decision 12):** en ruta de escritura, key en query **y** un parametro
    desconocido → 401 `key_in_query` (no 400), y credenciales invalidas con un parametro desconocido → 401 (no
    400); la key mide 48 y empieza por `kw_`; `planWriteKeyChange` no toca `apiKey` ni `status`, el evento no
    contiene la key y lleva `entityId` igual al `sellerId`.

- [x] **T4: Confirmar y cancelar (planificador puro)**
  * Requisitos cubiertos: RF_04, RF_05, RF_06, RF_13, RF_14, RF_15, RF_19, RF_21, RNF_02
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: tipos del plan 4.1, `isApiEditable`, `planConfirm`, `planCancel` con la tabla de politica
    (`panel` / `api`), los **pasos 4-9 de la precedencia** (404 → 409 por estado → 422 → sin cambios →
    `status_changed` → aplicar) y el parche de cancelar con `driverId: current.driverId ?? null` como hoy.
    `planConfirm` no recibe errores de campo: el cuerpo invalido de confirmar ya se respondio con 400 en el paso 3.
  * Verificacion: bloque `describe("T4 · ...")`: `imported` sin lider → `ready_to_assign`, `accepted`,
    `confirmedVia` `api`/`manual`; `imported` con lider → 409 `order_not_editable` con `hasLeader: true` en API
    (y aplica en panel, como hoy); `ready_to_assign`, `in_route`, `delivered` → `unchanged` en API y rechazo en
    panel; **sin cambios antes que `status_changed`:** confirmar un `ready_to_assign` con
    `expectedStatus: "imported"` → `unchanged`, y cancelar un `cancelled` (con motivo) con
    `expectedStatus: "imported"` → `unchanged`; **`status_changed` solo cuando cambiaria algo y nada anterior
    respondio:** confirmar un `imported` sin lider con `expectedStatus: "ready_to_assign"` → `status_changed`, y
    cancelar un `imported` sin lider con `expectedStatus: "address_risk"` → `status_changed`; **409 por estado
    antes que `status_changed`:** confirmar un `address_risk` (con o sin lider) **con un `expectedStatus`
    distinto** → `address_review_pending` (no `status_changed`), confirmar un `cancelled` con `expectedStatus`
    distinto → `order_cancelled`, cancelar un `in_route` con `expectedStatus` distinto → `order_not_editable`;
    **409 por estado antes que 422:** cancelar un `assigned` sin motivo → `order_not_editable` (no 422);
    **422 antes que sin cambios:** cancelar un `cancelled` sin motivo → 422 `validation_failed` (`reason`);
    **404 antes que todo:** otra tienda con `expectedStatus` distinto → `order_not_found`; `address_risk` sin
    lider y con lider → los dos `address_review_pending` (RF_21 prevalece sobre `order_not_editable`); cancelar
    editable con motivo → `cancelled`, `callNote`, `driverId: null` en el parche (desde
    `current.driverId ?? null`), `inventory: "release"` si reservo y no `imported`; panel (admin) cancelando un
    `assigned` → parche con el `driverId` actual, como hoy; `assigned`, `imported` con lider y `address_risk` con
    lider → `order_not_editable` al cancelar en API.

- [x] **T5: Corregir datos de entrega, validacion e historial (puro)**
  * Requisitos cubiertos: RF_07, RF_08, RF_09, RF_10, RF_11, RF_12, RF_16, RF_22, RF_23, RNF_02
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: `validateDeliveryInput` (reglas de contenido de la tabla 4.4, todos los errores a la vez, con la
    excepcion de `deliveryNotes` solo para la API), `planDeliveryCorrection` (pasos del plan 4.1 con la
    precedencia: 404 → 409 `order_not_editable` → 422 (`fieldProblems` recibidos de `parseWriteBody`, `no_fields`,
    ciudad no cubierta aunque sea la misma) → sin cambios → `status_changed` → aplicar; incluido
    `order.address_reviewed` sin campos cambiados, P1, y `panelExtras` con politica `panel`: cuentan como cambio,
    siempre en el parche, sello y auditoria puestos por el nucleo), `buildOrderHistoryRecord`.
  * Verificacion: bloque `describe("T5 · ...")`: solo campos enviados; `imported` sigue `imported`;
    `in_route`, `call_pending`, `address_risk` con lider, `imported` con lider → 409; **409 antes que 422:** un
    `in_route` con `fieldProblems` (telefono invalido) → `order_not_editable`, y con una ciudad desactivada →
    `order_not_editable`; **422 antes que sin cambios (RF_10):** un `PATCH` que solo reenvia el `cityId` que ya
    tiene el pedido, con esa ciudad `active: false` → 422 `out_of_coverage` (no `unchanged`), tambien con
    `expectedStatus` distinto; `fieldProblems` sobre un editable con valores identicos → 422 (no `unchanged`);
    **sin cambios antes que `status_changed`:** correccion con los mismos valores sobre un editable que no esta en
    `address_risk` → `unchanged` aunque `expectedStatus` no coincida; con un campo que cambia y `expectedStatus`
    distinto → `status_changed`; telefono valido + ciudad inactiva → `out_of_coverage` y el telefono no esta en el
    parche; telefonos validos (10 digitos, `+57`, E.164) e invalidos; politica `api`: `deliveryNotes: ""` y
    `deliveryNotes: null` → borran las indicaciones (cambio a `null` en el historial) y no dan `no_fields`;
    politica `panel`: **indicaciones en blanco se conservan** (ni en el parche ni en el historial); **edicion del
    panel solo de producto** (`panelExtras` con otro `productName`/`totalCop`, entrega identica) → `applied`,
    parche con el producto y `MANUAL_EDIT_STAMP`, evento `order.imported_updated`, historial con
    `productName`/`totalCop` (y `sku`/`quantity` si cambian); `customerName`, `customerPhone`, `addressRaw` o
    `cityId` vacios o `null` → `empty`; `panelExtras` con politica `api` → lanza; direccion cambiada (API) →
    `clear` con los cuatro campos; `address_risk` sin lider con valores identicos → `imported` + `review` +
    `order.address_reviewed` con solo `status`; propiedad: ningun plan `api` emite `address_risk`; sello
    `MANUAL_EDIT_STAMP` presente en todo plan `applied` de correccion; historial sin `driverId`/`messengerId` y
    `null` sin cambios; el resultado pasado por `mergeImportedOrder` conserva cliente y direccion.

- [x] **T6: Ejecutor transaccional y carreras simuladas**
  * Requisitos cubiertos: RF_19, RF_04, RF_11, RF_13
  * Archivos: functions/src/order-seller-actions-run.ts, functions/src/order-import-merge.ts, src/lib/spec-017-guards.test.ts, src/lib/order-seller-actions-run.test.ts
  * Accion: `runConfirm`, `runDeliveryCorrection`, `runCancel` (plan 2.2) con transaccion, `clear` por
    `FieldValue.delete()`, inventario, evento e historial; si el plan rechaza, ninguna escritura. Quinta
    exencion en `IMPORT_WRITE_EXEMPTIONS` con su razon y guarda 3 de la 017 de cuatro a cinco (el ejecutor es
    quien escribe `orders` fuera de `orders.ts`). **`cityId` entra en el grupo `customer` de `FIELD_GROUPS`
    de `order-import-merge.ts`** (`pass` sin confirmar, `keep-if-present` editado/abierto/cerrado: un pedido viejo sin `cityId` no tenia
    correccion que proteger y recibe la de la importacion sin reportarse): las cinco vias de
    entrada escriben `cityId` (`"city-cali"` o el de la tienda) y, sin esto, una reimportacion revertiria la
    ciudad corregida por API (RF_11; hallazgo del RED de T5, 2026-10-05). `deliveryNotes` no la escribe ninguna
    via de entrada: no hace falta grupo.
  * Verificacion: `spec-017-guards.test.ts` guarda 3 verde con cinco exenciones; `mergeImportedOrder` sobre un
    pedido sellado conserva el `cityId` corregido; bloque `describe("T6 · ...")`
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

- [x] **T6b: Delegacion de las tres callables del panel, guardas 017 y anti-copia**
  * Requisitos cubiertos: RF_19, RF_11, RF_16
  * Archivos: functions/src/orders.ts, src/lib/spec-017-guards.test.ts, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/mutacion-rf19.txt,
    functions/src/order-seller-actions-run.ts, src/lib/order-seller-actions-run.test.ts, src/lib/spec-013-guards.test.ts
    (ampliado el 2026-10-05: `resolveEditedOrderLines` necesita el pedido leido DENTRO de la transaccion, asi que
    `runDeliveryCorrection` acepta `panelExtras` como funcion del pedido leido; y la guarda T4 de la 013 exigia
    en `updateImportedOrder` el `action` y el `transaction.set(...merge)` que ahora viven en nucleo y ejecutor)
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

- [x] **T7: Reglas y `settings/storeApi`**
  * Requisitos cubiertos: RF_16, RF_17, RF_24
  * Archivos: firestore.rules, src/lib/spec-029-guards.test.ts
  * Accion: bloques `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits` con `allow read, write: if
    false`; **acotar la regla general de `settings`** a `allow write: if isAdmin() && settingId != "storeApi";`
    (la lectura no cambia), para que `settings/storeApi` solo lo escriba el Admin SDK del guion (plan 2.4, 7).
  * Verificacion: bloque `describe("T7 · ...")`: los tres bloques con su regla; el bloque
    `match /settings/{settingId}` tiene un `allow write` que exige `isAdmin()` **y** `settingId != "storeApi"`, y
    no hay otro `allow write` ni `allow create/update` en `settings` sin esa condicion; ninguna fuente de `src/`
    ni `functions/src/` contiene un literal de fecha asociado a `historySince`; ninguna fuente salvo el `cleanup`
    de `scripts/verify-029.js` (en `run-all` y `--from-registro`) hace `delete`/`update` sobre `orderHistory`
    (excepcion de RF_16).

## API

- [x] **T8: Peticion, errores y limite (puro)**
  * **Deuda anotada al cerrar (2026-10-05):** el orden required → empty → too_long del motivo de cancelar vive en
    `parseWriteBody` y en `cancelReasonProblems` (privada de `order-seller-actions.ts`), y la lista de campos de
    `PATCH` se repite como `PATCH_FIELDS` porque `DELIVERY_FIELDS` no esta exportada. Hoy no divergen (el
    planificador usa los `fieldProblems` recibidos). Unificar exportando ambas en la primera tarea que tenga
    `order-seller-actions.ts` en su alcance.
  * Requisitos cubiertos: RF_03, RF_09, RF_12, RF_13, RNF_02, RNF_04
  * Archivos: functions/src/store-api-request.ts, src/lib/store-api-request.test.ts, src/lib/spec-029-guards.test.ts
  * Accion: `routeStoreApiRequest` (paso 0: rutas nuevas y viejas, `Allow` por ruta), parametros permitidos por
    ruta y forma del cuerpo (paso 3), **validador puro de `shopifyOrderId`** (`^[0-9A-Za-z#._-]{1,64}$`, plan
    2.10; T10 solo lo llama y responde con la forma vieja); **cuerpo de confirmar** (plan 4.4, decision 13):
    vacio o `{ expectedStatus }` con texto; cualquier otra clave o un tipo invalido → **400 `invalid_body`** en el
    paso 3; `parseWriteBody` para `PATCH` y cancelar segun el plan 4.4: 400 `invalid_json` si el cuerpo no es
    JSON y 400 `invalid_body` si no es un objeto (se responden en el paso 3); si no, separa `expectedStatus`
    **antes** de validar, anota cada clave no permitida (`not_allowed`), valida forma y tipos de las permitidas
    con Zod (solo forma y tipos basicos; `invalid_type`), valida el contenido con `validateDeliveryInput` (T5) en
    `PATCH` y el motivo en cancelar (obligatorio, recortado 1-500), y devuelve `{ input, expectedStatus,
    fieldProblems }` **sin responder el 422**: lo responde el nucleo en el paso 6, tras 404 y 409;
    `buildFieldError(fieldProblems)` construye ese 422 con **todos** los campos y `code` de primer nivel
    `field_not_allowed` si hay alguno `not_allowed`, si no `validation_failed`; la tabla de precedencia (plan 2.1)
    como constante documentada; catalogo `code` → HTTP (con `key_in_query` en 401 e `invalid_body` en 400),
    `buildErrorBody`, `bodyHash` canonico, `STORE_API_WRITES_PER_MINUTE = 120`, `rateWindow(now)` →
    `{ bucketId, retryAfterSeconds }`.
  * Verificacion: bloque `describe("T8 · ...")`: parametro desconocido → 400 nombrando cada uno en cada ruta
    nueva; **en una ruta de escritura con `key` en query y un parametro desconocido, el paso 3 no llega a
    ejecutarse: la respuesta es 401 `key_in_query`** (prueba sobre la secuencia `routeStoreApiRequest` →
    `resolveStoreCredentials` → parametros); rutas viejas sin validacion de parametros; `shopifyOrderId` valido
    (`1001`, `#1001`, `KOV-1001`) e invalido (vacio, 65 caracteres, espacios, `/`); cuerpo que no es JSON → 400
    `invalid_json`, cuerpo que es un array → 400 `invalid_body`; **confirmar con `{ expectedStatus: "imported",
    foo: 1 }` → 400 `invalid_body`; confirmar con `{ expectedStatus: 5 }` → 400 `invalid_body`; confirmar con
    `{}` o sin cuerpo → pasa el paso 3**; `expectedStatus` no cuenta como campo en `PATCH` (cuerpo
    `{ expectedStatus }` → sin `fieldProblems`, y el nucleo dara `no_fields`); cuerpo con `totalCop` y `sku` →
    `fieldProblems` con los dos `not_allowed` y `buildFieldError` → `field_not_allowed`; cuerpo con `totalCop` y
    `customerName: ""` → `field_not_allowed` de primer nivel y `fields` con los dos (`totalCop` `not_allowed`,
    `customerName` `empty`); cuerpo con `customerName: ""` y telefono invalido → `validation_failed` con los dos
    campos; tipo incorrecto (`customerName: 5`) → `validation_failed` con `invalid_type`; cancelar sin motivo →
    `reason` `required`, motivo solo espacios → `empty`, motivo de 1 y de 500 caracteres pasa, de 501 →
    `too_long`; catalogo congelado (nombres y HTTP); `Retry-After` >= 1; hash igual con claves en otro orden.
    Guarda: el limite solo aparece en `STORE_API_WRITES_PER_MINUTE`; `store-api-request.ts` no repite reglas de
    contenido de entrega (importa `validateDeliveryInput`); `parseWriteBody` no devuelve nunca un 422.
  * **Nota para la prueba (pasada final, 9):** el paso 0 de la precedencia necesita su codigo de ruta: al
    escribir el RED, fijar `route_not_found` (404) para ruta desconocida y `method_not_allowed` (405) para metodo
    no admitido en las rutas nuevas, anadir `route_not_found` al catalogo y probar que el paso 0 gana sobre una key
    en query.
  * **Nota para la prueba (pasada final, 12):** en el esquema de forma, los cinco campos de entrega aceptan
    `null` como tipo valido (no `invalid_type`): `deliveryNotes: null` borra y los otros cuatro con `null` dan
    `empty` en la validacion de contenido de T5. Probar los cinco con `null`.

- [x] **T9: Forma de pedido extraida sin cambiar la salida**
  * Requisitos cubiertos: RF_01, RF_20
  * Archivos: functions/src/store-api-orders.ts, functions/src/store-api.ts, src/lib/store-api-orders.test.ts
  * Accion: mover `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` y su ayudante de fecha a
    `store-api-orders.ts` tal cual; `store-api.ts` los importa. Anadir `loadTargetedPaymentInputs` puro sobre
    asientos y cortes ya leidos. No empieza si el recuento de T1/T2 de `cashAllocations` fuera de `orderIds` no
    es 0.
  * Verificacion: `store-api-orders.test.ts`: con fixtures (cortes ajenos, `cashAllocations`, parcialmente
    cubierto, prepago, sin asientos) `buildPaymentInfo` con los cortes dirigidos == con todos los cortes;
    instantanea de un payload de `/orders` antes y despues de mover identica.

- [x] **T10: Autenticacion de todas las rutas, `GET /orders/{id}` y filtro por `shopifyOrderId`**
  * **Al cerrar (2026-10-05):** las rutas nuevas aun sin handler (`/history`, `confirm`, `cancel`, `PATCH`)
    responden 404 `route_not_found` antes de autenticar: **no desplegar `storeApi` antes de T11-T13**.
    `shopifyOrderId=""` → 400 a proposito (un `#` sin codificar llega vacio y, sin el 400, devolveria la lista
    entera). Con el filtro, `rango` sale `{ desde: null, hasta: null }` porque no se aplica.
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_20, RNF_01, RNF_05
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-write.test.ts
  * Accion: **conectar `resolveStoreCredentials` (T3) en `store-api.ts` para las rutas viejas** (sustituye su
    comparacion propia, conservando `query ?? bearer`; los errores conservan la forma `{ ok: false, error }` de
    hoy) y para las de lectura nuevas; el handler de `storeApi` recibe el `db` inyectable para poder probarlo.
    Carga dirigida (plan 2.10) en `functions/src/store-api-write.ts`; 404 identico (mismo HTTP y mismo cuerpo)
    para ajeno e inexistente. Filtro `shopifyOrderId` en `GET /orders` (ruta existente): consulta siempre acotada
    al `sellerId` de la key, con `in` si T1 midio tipos mixtos; `from`/`to` ignorados; **`status` y `limit`
    aplicados** sobre lo encontrado como hoy; formato decidido por el validador de T8 y, si falla, **400 con la
    forma vieja** `{ ok: false, error: "invalid_shopify_order_id" }`.
  * Verificacion: bloque `describe("T10 · RNF_05")` en guardas: **`functions/src/store-api-write.ts`** no
    contiene `where("sellerId", "==", ...)` sin segundo filtro ni `collection("settlements").get()`;
    `store-api.ts` no conserva una comparacion de key propia (`safeEqual(` solo dentro de `store-api-auth.ts`).
    Bloque `describe("T10 · ...")` en `store-api-write.test.ts` con un `db` falso en memoria (la tienda del `db`
    falso hace de tienda de pruebas: es el unico sitio, junto con la tienda de pruebas real de T27, donde se
    compara con key de escritura): **rutas viejas (RF_20, RNF_01)** — el handler viejo con una key `kw_` por query
    en `/resumen` y `/orders` → 401 con cuerpo `{ ok: false, error: "invalid_key" }` (sin `code`); con la key de
    escritura por Bearer → 200 con la misma respuesta, comparada por valor, que con la key de lectura; con la key
    de lectura por query → 200 como hoy; con key de query invalida y Bearer valida → 401 como hoy; **RF_02** —
    devuelve solo los pedidos de la tienda de la key con ese numero; con `from`/`to` que excluirian la fecha del
    pedido lo devuelve igual; con `status` que no coincide → lista vacia; con dos pedidos del mismo numero (texto
    y numero) y `limit=1` → uno; el mismo numero en otra tienda no aparece, y un numero que solo existe en otra
    tienda da lista vacia (200); un `shopifyOrderId` invalido → 400
    `{ ok: false, error: "invalid_shopify_order_id" }` (sin `code` ni `message`) sin consultar; **RF_01 /
    RNF_01** — `GET /orders/{id}` de un pedido de otra tienda y de uno inexistente dan 404 `order_not_found`
    con cuerpo identico (comparacion profunda); con un parametro desconocido y un pedido inexistente → 400 (el
    paso 3 va antes que el 404).

- [x] **T11: Rutas de escritura**
  * Requisitos cubiertos: RF_04, RF_07, RF_10, RF_13, RF_19, RNF_01, RNF_02
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-write.test.ts
  * Accion: `POST /confirm`, `PATCH`, `POST /cancel` en el orden de la precedencia (plan 2.1): credenciales →
    cuerpo (T8; solo los 400 se responden aqui) → tasa → idempotencia → ejecutor con `policy: "api"`, actor
    `{ kind: "api", keyLast4 }` y los `fieldProblems`; mapeo de rechazos a `StoreApiError`; 422 `out_of_coverage`
    con `activeCities` (P4); respuesta `{ ok, changed, pedido }` con la forma de T9.
  * Verificacion: `store-api-write.test.ts`: `mapRejectionToResponse` para cada rechazo (codigo, HTTP,
    `status`, `hasLeader`, `fields`, `activeCities` ordenadas por nombre y ausentes si fallo su lectura); con un
    `db` falso, **un `PATCH` con un campo invalido sobre un pedido de otra tienda → 404, y sobre uno `in_route` →
    409** (no 422); guarda: los handlers llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel` y no escriben
    en `orders`.
  * **Nota para la prueba (pasada final, 8):** completar con el `db` falso los pares de precedencia que faltan:
    parametro desconocido + limite superado → 400 (no 429); limite superado + `Idempotency-Key` ya usada → 429;
    `Idempotency-Key` reutilizada con otro cuerpo + pedido inexistente → 422 `idempotency_key_reused` (no 404);
    y **404 frente a 409 con un pedido de otra tienda que esta `in_route`** → 404 (nunca revela su estado).
  * **Nota para la prueba (pasada final, 10):** la guarda anti-copia de RF_19 tambien cubre
    `functions/src/store-api-write.ts`: sus handlers no contienen `status: "ready_to_assign"`,
    `status: "cancelled"`, `addressRisk: "accepted"` ni `[MANUAL_EDIT_STAMP]`; escribirla en el bloque de T11.
  * **Nota para la prueba (pasada final, 11):** T11 deja el enganche de idempotencia (el handler pasa
    `Idempotency-Key` y `bodyHash` al ejecutor, que en T11 los ignora); **T12** conecta `decideIdempotency` y el
    registro. La prueba de T11 no depende de la idempotencia.

- [x] **T12: Idempotencia y limite de tasa**
  * **Al cerrar (2026-10-05), para el despliegue:** las politicas TTL de `storeApiIdempotency.expiresAt` y
    `storeApiRateLimits.expiresAt` (plan 2.8, 2.9, 6) se crean con `gcloud firestore fields ttls update expiresAt
    --collection-group=<coleccion> --enable-ttl --project=kentro-last-mile`; no estan comprobadas en prod. El
    codigo no depende de ellas (un registro vencido cuenta como `fresh`). El contador deja de escribir pasado el
    limite (el 429 no cuesta una escritura).
  * Requisitos cubiertos: RNF_03, RNF_04
  * Archivos: functions/src/store-api-request.ts, functions/src/store-api-write.ts, functions/src/order-seller-actions-run.ts, src/lib/store-api-request.test.ts, src/lib/order-seller-actions-run.test.ts,
    src/lib/store-api-write.test.ts, functions/src/store-api.ts (ampliado al cerrar T11: los pares de precedencia de
    la nota 8 de T11 que dependen de tasa o idempotencia viven en `store-api-write.test.ts`, y el handler lee la
    cabecera en `store-api.ts`)
  * Accion: `decideIdempotency(stored, { bodyHash, now })` → `replay | conflict | fresh`; ids
    `{sellerId}__{...}` en `storeApiIdempotency` y `storeApiRateLimits` (plan 2.8, 2.9); **la decision que vale se
    toma dentro de la transaccion del ejecutor** (`order-seller-actions-run.ts` recibe la key del enganche que dejo
    T11, vuelve a leer el registro en la transaccion, decide y lo escribe junto al pedido, **tambien cuando el plan
    rechaza con un 409 (pasos 5 y 8) o un 422 del paso 6**, en cuyo caso es la unica escritura); el handler puede
    leer antes fuera de la transaccion **solo como atajo** para responder pronto `replay`/`conflict` (pasos 3a-3b
    del plan 2.1); ventana de tasa en transaccion corta previa; 429 con `Retry-After`.
  * Verificacion: bloque `describe("T12 · ...")` en `store-api-request.test.ts`: misma key y cuerpo →
    `replay`; otro cuerpo → `idempotency_key_reused`; expirado → `fresh`; key vacia o > 255 →
    `invalid_idempotency_key`; contador 121 → 429 y nunca 403; **se guardan 200, 409 y 422 del paso 6**, y no
    400, 401, 403, 404, 429 ni `idempotency_key_reused`; los ids de idempotencia y de tasa empiezan por
    `{sellerId}__`. Bloque `describe("T12 · ...")` en `order-seller-actions-run.test.ts` con una transaccion
    falsa: una correccion rechazada con 409 (`order_not_editable`) **escribe el registro idempotente** con
    `status: 409` y su cuerpo, y ninguna escritura en `orders`, `auditEvents` ni `orderHistory`; **una correccion
    rechazada con 422 (`out_of_coverage` o `validation_failed`) escribe el registro con `status: 422` y su cuerpo,
    y la segunda peticion con la misma key y cuerpo devuelve ese mismo 422 sin reevaluar el pedido**; una
    aplicada escribe el registro con 200 en la misma transaccion que el pedido; **el atajo no decide:** con el
    atajo diciendo `fresh` y un registro ya presente al leer dentro de la transaccion (otra peticion gano), el
    ejecutor responde `replay` con la respuesta guardada y no aplica el cambio.

- [x] **T13: Historial por API e indice**
  * Requisitos cubiertos: RF_17, RF_18, RF_20, RF_24
  * Archivos: functions/src/store-api-history.ts, functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/store-api-history.test.ts, src/lib/store-api-write.test.ts
  * Accion: `toStoreHistoryResponse(records, historySince)` con lista explicita de claves, orden ascendente,
    `excludes` y `aviso`; `GET /orders/{id}/history` (comprueba antes que el pedido es de la tienda; 503
    `history_not_ready` sin `settings/storeApi`); indice (plan 2.1): la documentacion nueva (rutas nuevas,
    codigos y su precedencia, estados editables, `historySince`, `HISTORY_EXCLUDES` y su aviso, key solo por
    cabecera, y que el filtro `shopifyOrderId` lleva el numeral codificado: `?shopifyOrderId=%232849`, porque
    un `#` literal lo corta el cliente HTTP como fragmento — nota de la respuesta de CENTRAL del 2026-10-05)
    va **solo en claves nuevas de primer nivel**; los valores de las claves actuales (rutas,
    autenticacion y el resto) no se tocan.
  * Verificacion: bloque `describe("T13 · ...")` en `store-api-history.test.ts`: ningun registro de salida
    trae `actor`, `uid` ni `auditEventId`; orden del mas viejo al mas nuevo; vacio → `registros: []` con
    `historySince`. Indice: con una instantanea del indice de hoy, el nuevo tiene **cada clave actual con valor
    identico** (comparacion profunda por valor, sin claves anadidas dentro de ellas) y las claves nuevas de
    primer nivel contienen las rutas nuevas, las exclusiones, los codigos y su precedencia, los estados editables
    y `historySince`. Bloque `describe("T13 · ...")` en `store-api-write.test.ts` con un `db` falso: historial de
    un pedido de otra tienda → 404 `order_not_found` con el mismo cuerpo que uno inexistente y sin leer
    `orderHistory`; sin `settings/storeApi` → 503 `history_not_ready`; con el documento → 200 con
    `historySince` de ese documento.

- [x] **T14: `getOrderAuditTrail` sin identidades para la tienda**
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

- [x] **T15: Historial en confirmar reintento, ajuste, transicion y cierre**
  * Requisitos cubiertos: RF_16
  * Archivos: functions/src/orders.ts, src/lib/spec-029-guards.test.ts, src/lib/order-seller-actions.test.ts
  * Accion: `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition` y `closeOrder` escriben
    `buildOrderHistoryRecord(...)` con `origin: "panel"` y el `auditEventId` de su evento, en su transaccion.
  * Verificacion: bloque `describe("T15 · ...")` en guardas: las cuatro callables, buscadas por nombre,
    contienen `buildOrderHistoryRecord(`; bloque en `order-seller-actions.test.ts`: ajuste registra
    `totalCop`/producto; cierre registra solo `status`.

- [x] **T16: Historial en mensajero, recogida y correcciones; clasificacion por nombre de las callables**
  * Requisitos cubiertos: RF_16, RF_24
  * Archivos: functions/src/orders.ts, functions/src/order-corrections.ts, src/lib/spec-029-guards.test.ts
  * Accion: `assignMessengerToOrders`, `unassignMessengerFromOrders` (solo `status`), `createOrUpdatePickupBatch`
    (evento `order.picked_up` nuevo + registro), `correctOrderStatus` (en su batch). En
    `spec-029-guards.test.ts`, **dos listas explicitas por nombre** (plan 2.6), sin `writesOrders` ni detector
    generico y sin tocar `spec-017-guards.test.ts`:
    - `REGISTRAN_HISTORIAL`: `confirmImportedOrder`, `updateImportedOrder`, `cancelOrder`, `confirmRetryOrder`,
      `updateOrderAdjustments`, `applyOrderTransition`, `closeOrder`, `assignMessengerToOrders`,
      `unassignMessengerFromOrders`, `createOrUpdatePickupBatch`, `correctOrderStatus`;
    - `EXCLUIDAS_DEL_HISTORIAL`: cada uno de los demas `export const X = onCall(`/`onRequest(` de
      `functions/src/orders.ts` y `functions/src/order-corrections.ts`, con su razon en la propia lista
      (`createManualOrder`: crea, no cambia; `classifyFailedOrder`: solo `failedCategory`; `getOrderAuditTrail`:
      solo lee; y el resto que aparezca al escribirla).
  * Verificacion: bloque `describe("T16 · ...")`: (1) los nombres extraidos con una expresion regular de los
    `export const X = onCall(`/`onRequest(` de esos dos archivos son **exactamente** la union de las dos listas,
    sin repetidos entre ellas y sin nombres de las listas que no existan; (2) el cuerpo de cada nombre de
    `REGISTRAN_HISTORIAL` contiene un escritor de historial (`buildOrderHistoryRecord(`, o `runConfirm(` /
    `runDeliveryCorrection(` / `runCancel(` para las tres que delegan); (3) **prueba positiva:**
    `createOrUpdatePickupBatch`, `assignMessengerToOrders` y `unassignMessengerFromOrders` estan en
    `REGISTRAN_HISTORIAL` y su cuerpo contiene `buildOrderHistoryRecord(`; (4) **RF_24:**
    **`getOrderAuditTrail` es la unica funcion de `functions/src` que hace `.where(` o `.get(` sobre
    `collection("auditEvents")`, y su cuerpo no escribe `orderHistory`; y no existe modo de relleno de
    `orderHistory` desde `auditEvents`** (ningun modo de `scripts/verify-029.js` escribe en `orderHistory`; el
    `cleanup` solo borra). Una callable nueva en esos archivos sin clasificar pone la guarda en rojo. La guarda
    lleva un comentario de cabecera: las importaciones y ChatBy viven en otros archivos y quedan fuera por la spec
    (031), y las escrituras directas de cliente (`operationalOrderUpdateByAssignee`) son de la 032.

- [x] **T17: Callables de la key de escritura**
  * **Al cerrar (2026-10-05):** una sola callable `rotateStoreWriteKey({ sellerId, rotate })` genera
    (`rotate: false`) o rota; `listStoreApiKeys` devuelve `{ stores: StoreApiKeyStatus[] }` (T18 lee `.stores`);
    `generatedByLabel` del admin ya trae "por " delante.
  * Requisitos cubiertos: RF_25, RF_26
  * Archivos: functions/src/store-api-keys.ts, functions/src/index.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-auth.test.ts
  * Accion: `rotateStoreWriteKey` (transaccion huella + auditoria con `entityId = sellerId`; key devuelta tras
    el commit), `getStoreApiKeyStatus`, `listStoreApiKeys` con **exactamente lo que muestra RF_25**: `exists`,
    `last4`, `generatedAt` (fecha de la key vigente: `writeKeyRotatedAt ?? writeKeyCreatedAt`) y
    `generatedByLabel` segun quien pregunta.
  * Verificacion: bloque `describe("T17 · ...")` en guardas: `runTransaction(` envuelve la escritura de
    `storeApiConfigs` y la de `auditEvents`; el evento lleva `entityId` igual al `sellerId`; el `return` con
    `writeKey` esta despues de la transaccion; no hay `writeKey:` en ningun `set`; `createStoreApiKey` no escribe
    `writeKey*`; `seller_logistics` rechazado al rotar; las de estado no devuelven `apiKey` ni `writeKeyHash`.
    Bloque en `store-api-auth.test.ts`: `toStoreApiKeyStatus` devuelve en `write` solo `exists`, `last4`,
    `generatedAt` y `generatedByLabel` (sin `prefix`, sin `rotatedAt`, sin `createdAt`); `generatedAt` es la
    fecha de rotacion si la hubo y si no la de generacion; `generatedByLabel` "Tu tienda" / "Kentro" para la
    tienda y "por la tienda" o el nombre del admin para el admin; nunca la key ni la huella.

## Interfaz

- [x] **T18: Tipos y envoltorios de cliente**
  * Requisitos cubiertos: RF_25, RF_27
  * Archivos: src/lib/types.ts, src/lib/firebase/auth.ts, src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts
  * Accion: `OrderAuditEntry` ampliado, `StoreApiKeyStatus` (con `write` = `exists`, `last4`, `generatedAt`,
    `generatedByLabel`); `fetchFirebaseOrderAuditTrail` → `{ events, historySince }`;
    `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`, `listFirebaseStoreApiKeys`. En
    `operations-app.tsx`, **solo** la adaptacion de los usos actuales de `fetchFirebaseOrderAuditTrail` a la forma
    `{ events, historySince }` (sin cambiar lo que se pinta: eso es T22).
  * **Nota (2026-10-05, al lanzar T14):** desde T14 la callable devuelve `{ events, historySince }` en vez de un
    array. Entre el despliegue de functions y el de hosting el cliente viejo recibiria un objeto: desplegar
    functions y hosting seguidos, y que el envoltorio nuevo acepte tambien un array (forma vieja) durante la
    transicion.
  * Verificacion: bloque `describe("T18 · ...")`: los cuatro envoltorios llaman a la callable de su nombre;
    en `operations-app.tsx` todo uso de `fetchFirebaseOrderAuditTrail(` lee `.events`; `npx tsc --noEmit`
    limpio con los usos actuales adaptados.

- [x] **T19: Modelos de vista**
  * **Al cerrar (2026-10-05):** `AUDIT_ACTION_LABELS` vive ahora exportado en `order-audit-trail-view.ts` con
    las acciones nuevas; **T22 debe importarlo y borrar la copia privada de `operations-app.tsx`**. Una ciudad sin
    nombre conocido se pinta "Sin dato" (nunca el id). Fixture de la key corregido a `kw_` + 45.
  * Requisitos cubiertos: RF_25, RF_27, RF_17
  * Archivos: src/lib/store-api-keys-view.ts, src/lib/store-api-keys-view.test.ts, src/lib/order-audit-trail-view.ts, src/lib/order-audit-trail-view.test.ts
  * **Compuerta:** no empieza hasta que `sdd-uxui` ratifique en el README del diseno las etiquetas
    "Direccion revisada" y "Recogido" y los **nombres visibles de `totalCop`, `productName`, `sku` y
    `quantity`** en "Antes/Ahora" (plan, seccion 12; lo lanza la sesion principal).
  * Accion: estados de la seccion de escritura (sin clave, recien generada, activa, error de generar, error de
    rotar, cargando, logistico sin botones), key en dos lineas de 24, paginas de 6 (escritorio) y 4 (movil),
    busqueda; la clave activa muestra **solo lo de RF_25 y del diseno de HU_04**: que existe, "termina en"
    `last4`, la fecha `generatedAt` y "generada por"; historial: pildora de origen ("API", "Kentro", "Tu tienda",
    "Panel"), nombres de campo visibles (los cinco de entrega, `status` y los cuatro de producto y valor, con los
    textos del README), "Antes"/"Ahora", nota de alcance con la fecha de `historySince` (sin nota si es `null` o
    hay error).
  * **Nota (2026-10-05, al cerrar T16):** el historial registra dos acciones nuevas sin evento propio o con uno
    nuevo: `order.messenger_assigned` (asignar mensajero sin reasignacion; el registro va sin `auditEventId`) y
    `order.messenger_unassigned`. Necesitan texto visible ratificado por `sdd-uxui` en el README antes de T19.
  * Verificacion: `store-api-keys-view.test.ts` y `order-audit-trail-view.test.ts` con un caso por estado del
    README (decisiones 3-7, 9-14); el estado "activa" contiene "termina en" + `last4`, la fecha de generacion y
    "generada por", y **no** contiene el prefijo `kw_` como dato ni una fecha de rotacion, ni nunca la key; cada
    `OrderHistoryField` tiene nombre visible y coincide con el del README.

- [ ] **T20: Seccion "Clave de escritura" de la tienda**
  * Requisitos cubiertos: RF_25, RF_26
  * Archivos: src/components/store-api-write-key.tsx, src/components/operations-app.tsx, src/lib/spec-029-guards.test.ts
  * Accion: `StoreApiKeyCard` en dos secciones `h3` ("Clave de lectura" con su comportamiento de hoy y el boton
    renombrado; "Clave de escritura" con el componente nuevo, que pinta el modelo de vista de T19); dialogo de
    rotar (foco en "Cancelar", Escape); pantallas `HU_04.tienda-*`.
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
  * Accion: `capture-reads` de tres tiendas reales **solo con su key de lectura** (keys leidas del servidor,
    nunca escritas en la evidencia), guardando `captureAt`: `/kpis`, `/orders` y `/settlements` con **rangos
    cerrados del pasado** (`from` y `to` anteriores al dia de la captura, fijados en la evidencia para reusarlos);
    `/resumen` (solo su forma); el indice. Deja preparada la funcion de comparacion que usara `compare-reads`
    dentro de `run-all` (T27): mismos rangos; de `/orders` y `/settlements` compara **por valor** solo los
    pedidos y cortes con `updatedAt < captureAt` que conserven ese `updatedAt` (los movidos entre medias se
    excluyen de los dos lados y se cuentan); `/kpis` por valor; `/resumen` **solo por forma** (claves y tipos),
    con la razon escrita en el guion (resume el estado de hoy y ningun rango lo congela); del indice, valor
    identico de cada clave actual y solo claves nuevas de primer nivel admitidas. **Tolerancia declarada en el
    guion:** cero diferencias en lo comparado por valor; solo se ignoran las marcas de tiempo de la propia
    respuesta listadas en el guion. La comparacion con key de escritura no se hace sobre tiendas reales: solo
    sobre la tienda de pruebas, en T27.
  * Verificacion: bloque `describe("T24 · ...")`: el modo solo hace `GET`; contra tiendas que no sean
    `seller-test-029` solo usa la key de lectura (el guion no lee `writeKey*` de configs reales); los `from`/`to`
    de `capture-reads` son anteriores a `captureAt`; la funcion de comparacion filtra por `updatedAt <
    captureAt`, compara `/resumen` solo por claves y tipos y declara la lista explicita de campos ignorados; la
    evidencia no contiene ninguna key (busqueda de 48 hex y de `kw_`); captura sin error.

- [ ] **T25: Forma de Kovia: fixture sintetico, salvaguardas del guion y sus guardas (sin ejecutar en produccion)**
  * Requisitos cubiertos: RF_11, RF_16 (excepcion del `cleanup`)
  * Archivos: src/lib/fixtures/029-kovia-order.json, src/lib/order-seller-actions.test.ts, scripts/verify-029.js, src/lib/spec-029-guards.test.ts
  * Accion: (a) copiar en solo lectura un pedido real de Kovia y su payload de Shopify como fixture,
    sustituyendo nombre, telefono, direccion **e id de Shopify** por valores sinteticos de la misma forma (id en
    el rango reservado del guion). (b) **Modulo de salvaguardas del guion** (plan 5.3), que ejecutara T27:
    `assertNotExists(ruta)` justo antes de cada envio (aborta si el documento que la via crearia ya existe);
    constantes de ids sinteticos (rango reservado de id de Shopify, p. ej. `9029000000000`-`9029000000999`,
    prefijo `TEST-029-` del numero de pedido, prefijo `test-029-` del id externo del webhook de tienda, dominio
    `kentro-test-029.myshopify.com`, lider `driver-test-029`); **registro sin secretos** (`recordCreated(kind,
    id)`, que anade a `EV/t27-registro.json` solo ids, `uid`, ids de corrida y el dominio de prueba, antes de cada
    creacion); `safeDelete(coleccion, id)` que **lee el documento y comprueba su pertenencia segun la tabla por
    coleccion del plan 5.3 (c)** y **se niega a borrar** (aborta con error) si no pertenece; una coleccion sin
    regla en la tabla no se puede borrar. (c) Codigo del modo `kovia-replay` (crea el `shopifyStores` de prueba;
    `assertNotExists("orders/shopify-<id sintetico>")`; replay 1 → `PATCH` → replay 2 con la comprobacion de que
    el pedido existente es el del replay 1; firma HMAC con el secreto de Shopify leido **solo en memoria**;
    comprobacion de RF_11), **sin ejecutarlo en produccion**: lo ejecuta `run-all` en T27.
  * Verificacion: bloque `describe("T25 · ...")` en `order-seller-actions.test.ts`: corregir el fixture y
    reimportarlo con `mergeImportedOrder` conserva cliente y direccion, y el `status` no cambia aunque el payload
    venga cancelado. Guardas en `spec-029-guards.test.ts` (salvaguardas (d) del plan 5.3): **(a)** toda llamada
    de envio del guion (al `shopifyWebhook` o al `storeOrderWebhook`) va precedida, en la misma funcion, de
    `assertNotExists(`; **(b)** el fixture y el guion solo usan ids de Shopify dentro del rango reservado
    declarado, numeros con `TEST-029-`, ids externos con `test-029-`, el dominio sintetico y `driver-test-029`
    (ningun literal de id o dominio fuera de esas constantes; el fixture no contiene telefonos ni correos
    reales); **(c)** ningun `.delete(`, `batch.delete(` ni `deleteUser(` del guion esta fuera de `safeDelete`, y
    `safeDelete` tiene una regla de pertenencia para cada una de las colecciones de la tabla 5.3 (c) (`orders`,
    `orderHistory`, `walletEntries`, `auditEvents`, `inventory`, `productCatalog`, `sellers`, `storeApiConfigs`,
    `storeApiIdempotency`, `storeApiRateLimits`, `shopifyStores`, `importRuns`, `storeWebhookSamples`,
    `shopifySyncIssues`, usuarios de Auth, config de webhook de prueba) y lanza para cualquier otra;
    `kovia-replay` solo escribe con `sellerId` `seller-test-029`; **(d)** `recordCreated` solo acepta ids
    (rechaza valores con forma de key `kw_`, 48 hex, contrasena o secreto) y el secreto de Shopify no aparece en
    ningun `fs.write*`, `console.*` ni en el registro.

- [ ] **T26: Manual de la API**
  * Requisitos cubiertos: RF_17, RNF_01, RNF_02 (DoD 5)
  * Archivos: src/app/api-tiendas/page.tsx, src/lib/spec-029-guards.test.ts
  * Accion: rutas nuevas, codigos y su **precedencia** (decision 12), estados editables, `historySince`, que el
    historial no incluye importaciones ni ChatBy, key de escritura solo por cabecera (cualquier key por query en
    una escritura da 401), cuerpo de confirmar (solo `expectedStatus`), `Idempotency-Key` (y que un reintento de
    una accion ya aplicada responde sin cambios aunque traiga el `expectedStatus` anterior, y que un 409 o 422 se
    repite igual con la misma key), limite y ciudades activas.
  * Verificacion: bloque `describe("T26 · ...")`: la pagina menciona cada `code` del catalogo de T8, las tres
    rutas de escritura, `Authorization: Bearer` y `historySince`.

- [ ] **T27: Despliegue, recorrido real en un solo proceso y limpieza**
  * Requisitos cubiertos: RF_01, RF_11, RF_20, RF_27, RF_16 (excepcion del `cleanup`), RNF_05, DoD 3
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-smoke.txt, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-registro.json
  * **Compuerta:** no empieza hasta que el **anexo A de la spec** tenga los CA_01-CA_12 transcritos del documento
    de CENTRAL (2-oct-2026), sin ninguna fila "pendiente de transcribir" (lo cierra la sesion principal con el
    responsable).
  * Accion: modos `set-history-since` (`create`), **`run-all`** y **`cleanup --from-registro`** (plan 5.3).
    `run-all` hace todo en **un solo proceso**, con el `cleanup` en un `finally`: setup de la tienda
    `seller-test-029` (con `inventory` y `productCatalog` de prueba, usuarios `seller` y `seller_logistics` con
    claim `sellerId: "seller-test-029"`, **admin desechable** aceptado explicitamente en la spec, config de
    webhook de tienda de prueba y su key de lectura con `createStoreApiKey`); **key de escritura generada (y
    rotada si la prueba lo pide) con la callable dentro del proceso, sin salir nunca de memoria**; pedidos de
    prueba (el `imported` por el `storeOrderWebhook` con id externo `test-029-…` y `assertNotExists`; el
    `address_risk` y el de inventario reservado por `createManualOrder`; el "con lider" preparado con el Admin
    SDK, `status: "assigned"`, `driverId: "driver-test-029"`, **declarado en la evidencia como paso fuera del
    canal del cliente**; sin usuarios de lider o mensajero, `drivers` ni `pickupBatches`); recorrido de los
    CA_01-CA_12 del anexo A; **`kovia-replay`** (el codigo de T25: replay 1 → `PATCH` → replay 2 y comprobacion
    de RF_11); **RF_27** con los dos `auditEvents` de forma historica sembrados con el Admin SDK sobre un pedido de
    `seller-test-029` (uno de accion permitida, `order.transition`; otro fuera de la lista,
    `order.messenger_reassigned`), comprobados con la sesion `seller` y con la del admin desechable;
    **`compare-reads`** (tiendas reales con key de lectura contra la captura de T24; key de escritura solo contra
    `seller-test-029`); **`GET /orders/{id}` contra su elemento de `GET /orders` sobre 20 pedidos reales** de
    Kovia, ONEP y DANDA, solo lectura y key de lectura; p95 de escrituras y de `GET /orders/{id}`. Cada creacion se
    anota antes en `EV/t27-registro.json` (sin secretos); si el proceso se cae, `cleanup --from-registro` limpia
    con ese registro. Ninguna sesion de tienda sobre una tienda real. Cada pedido creado por webhook consume un
    numero del contador de `trackingCode` (aceptado, plan 5.3). Orden de despliegue del plan 10 (humano).
  * Verificacion: bloque `describe("T27 · ...")`: `set-history-since` usa `create`; `run-all` es una sola funcion
    que crea, prueba y llama a `cleanup` dentro de un `finally`; **la key de escritura solo existe en variables
    del proceso**: no aparece en ningun `fs.write*`, `console.*`, en el registro ni en la evidencia; el `imported`
    de prueba se crea con una peticion al `storeOrderWebhook` precedida de `assertNotExists(` y no con
    `createManualOrder`; **el guion solo escribe ids de prueba**: toda escritura con el Admin SDK y toda llamada a
    callables de escritura con la sesion del admin desechable llevan `sellerId: "seller-test-029"`, un id de
    pedido de prueba registrado o un id de las constantes sinteticas; el guion no crea usuarios con un claim
    `sellerId` distinto de `seller-test-029`, crea como mucho un admin y lo registra, y no crea usuarios de lider o
    mensajero ni escribe en `drivers` o `pickupBatches`; el unico `driverId` que escribe es `driver-test-029`; la
    siembra de eventos historicos escribe solo `auditEvents` con `entityId` de un pedido de `seller-test-029`;
    `cleanup` (en `finally` y con `--from-registro`) recorre, y solo borra mediante `safeDelete` con la prueba de
    pertenencia de su coleccion: `orders`, `auditEvents` (incluidos los sembrados y los de la key de escritura,
    `entityId = "seller-test-029"`), `orderHistory` (unica excepcion de RF_16), `walletEntries` (por `orderId` de
    prueba), `storeWebhookSamples`, `shopifySyncIssues`, `storeApiIdempotency` y `storeApiRateLimits` (prefijo
    `seller-test-029__`), `importRuns` del registro, la config de webhook de prueba, el `shopifyStores` de prueba,
    `inventory` y `productCatalog` de la tienda, `storeApiConfigs/seller-test-029`, los usuarios de Auth del
    registro (tienda y admin desechable) y `sellers/seller-test-029`; imprime recuento por coleccion y falla si
    queda algo; la comparacion de `GET /orders/{id}` solo hace `GET` con key de lectura. Evidencia en
    `EV/t27-smoke.txt` con: los CA del anexo A uno a uno; el paso del `driverId` declarado como fuera del canal del
    cliente; las tres fases de `kovia-replay` y la comprobacion de RF_11; el resultado de RF_27 (evento permitido
    sin identidades y con su etiqueta para la tienda; el de fuera de la lista ausente para la tienda; los dos
    visibles para el admin); `compare-reads` sin diferencias en lo comparado por valor (y el recuento de excluidos
    por `updatedAt`); los 20 pedidos de `GET /orders/{id}` iguales a su elemento de `GET /orders`; p95 < 2 s; y
    `cleanup` en cero en todas las colecciones. `EV/t27-registro.json` queda en la evidencia, sin secretos.
  * **Nota para la prueba (pasada final, 13):** en la tienda de pruebas, `compare-reads` compara la respuesta con
    key de lectura y con key de escritura **en el mismo momento** (llamadas consecutivas, sin escrituras entre
    medias) sobre `/resumen`, `/kpis`, `/orders` y `/settlements`, por valor; la key de lectura de la tienda de
    pruebas se crea con `createStoreApiKey` en el setup (y no se escribe en el registro).
