# Tareas — Spec 029: una tienda confirma, corrige y cancela sus pedidos por API

Plan: `specs/029_plan.md` (preguntas P1-P5 resueltas el 2026-10-04). Diseno:
`specs/design/029_store_api_confirma_y_corrige_pedidos/` (README + 14 pantallas). Evidencia:
`.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/` (abajo `EV/`).

Cada tarea empieza por una prueba que falla (RED) y dura 20-30 minutos. Vitest solo recoge
`src/**/*.test.ts`; `functions/src` se importa como `../../functions/src/<modulo>`. Cada tarea lleva al menos un
archivo de prueba en su alcance.

**Archivos compartidos (plan 5.2):** un bloque `describe("T<n> · ...")` por tarea, sin editar los de otra, en
`src/lib/spec-029-guards.test.ts` (casi todas), `src/lib/order-seller-actions.test.ts` (T4, T5, T6),
`src/lib/store-api-request.test.ts` (T8, T12), `src/lib/store-api-history.test.ts` (T13, T14).
`functions/src/orders.ts`: T6 (tres callables), T14 (`getOrderAuditTrail`), T15 y T16 (historial), cada una en
su callable. `functions/src/store-api.ts`: T9, T10, T13, cada una en su ruta. `operations-app.tsx`: T20, T21,
T22, T23, cada una en su punto de montaje.

**Reglas transversales:** escrituras nuevas con `stripUndefined`; la regla de confirmar/corregir/cancelar solo
en `order-seller-actions.ts` (plan 2.2); `orderHistory` nunca guarda `driverId`/`messengerId`; la key de
escritura nunca en logs, en Firestore en claro ni en `localStorage`; `STORE_API_WRITES_PER_MINUTE` es el unico
sitio del limite; `historySince` nunca como literal.

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
    2.3 y las dos comparaciones siempre; `planWriteKeyChange({ config, rotate, actor, now })` → campos
    `writeKey*` + evento, o `failed-precondition` (generar con key existente / rotar sin key).
  * Verificacion: `store-api-auth.test.ts`: cada fila de la tabla 2.3 (lectura en escritura → `read_only_key`;
    `kw_` por query → 401 en ruta nueva y vieja; escritura por Bearer en lectura → pasa; `status` inactivo →
    `invalid_key`); la key mide 48 y empieza por `kw_`; `planWriteKeyChange` no toca `apiKey` ni `status` y el
    evento no contiene la key.

- [ ] **T4: Confirmar y cancelar (planificador puro)**
  * Requisitos cubiertos: RF_04, RF_05, RF_06, RF_13, RF_14, RF_15, RF_19, RF_21
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: tipos del plan 4.1, `isApiEditable`, `planConfirm`, `planCancel` con la tabla de politica
    (`panel` / `api`) y `expectedStatus`.
  * Verificacion: bloque `describe("T4 · ...")`: `imported` → `ready_to_assign`, `accepted`, `confirmedVia`
    `api`/`manual`; `ready_to_assign`, `in_route`, `delivered` → `unchanged` en API y rechazo en panel;
    `cancelled` → `order_cancelled`; `address_risk` → `address_review_pending` (con lider:
    `order_not_editable`); `expectedStatus` distinto → `status_changed` antes que todo; cancelar editable con
    motivo → `cancelled`, `callNote`, `inventory: "release"` si reservo y no `imported`; `assigned` →
    `order_not_editable` en API y aplicado en panel (admin); `cancelled` → `unchanged`; otra tienda →
    `order_not_found`.

- [ ] **T5: Corregir datos de entrega, validacion e historial (puro)**
  * Requisitos cubiertos: RF_07, RF_08, RF_09, RF_10, RF_11, RF_12, RF_16, RF_22, RF_23
  * Archivos: functions/src/order-seller-actions.ts, src/lib/order-seller-actions.test.ts
  * Accion: `validateDeliveryInput` (tabla 4.4, todos los errores a la vez), `planDeliveryCorrection` (pasos
    1-9 del plan 4.1, incluido `order.address_reviewed` sin campos cambiados, P1), `buildOrderHistoryRecord`.
  * Verificacion: bloque `describe("T5 · ...")`: solo campos enviados; `imported` sigue `imported`;
    `in_route`, `call_pending`, `address_risk` con lider → 409; telefono valido + ciudad inactiva →
    `out_of_coverage` y el telefono no esta en el parche; telefonos validos (10 digitos, `+57`, E.164) e
    invalidos; producto/valor/pago/modo → `not_allowed`; direccion cambiada → `clear` con los cuatro campos;
    `address_risk` sin lider con valores identicos → `imported` + `review` + `order.address_reviewed` con solo
    `status`; propiedad: ningun plan `api` emite `address_risk`; sello `MANUAL_EDIT_STAMP` presente; historial
    sin `driverId`/`messengerId` y `null` sin cambios; el resultado pasado por `mergeImportedOrder` conserva
    cliente y direccion.

- [ ] **T6: Ejecutor transaccional y delegacion del panel**
  * Requisitos cubiertos: RF_19, RF_04, RF_13, RF_11
  * Archivos: functions/src/order-seller-actions-run.ts, functions/src/orders.ts, functions/src/order-import-merge.ts, src/lib/spec-017-guards.test.ts, src/lib/spec-029-guards.test.ts, src/lib/order-seller-actions.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/mutacion-rf19.txt
  * Accion: `runConfirm`, `runDeliveryCorrection`, `runCancel` (plan 2.2) con transaccion, `clear` por
    `FieldValue.delete()`, inventario, evento e historial. `confirmImportedOrder`, `updateImportedOrder`
    (producto/pago/modo/valor en el adaptador) y `cancelOrder` delegan sin cambiar sus mensajes. Quinta
    exencion con su razon. Guardas 3 (cinco) y 7 (`orders.ts` 1 + `order-seller-actions.ts` 1) de la 017.
  * Verificacion: `spec-017-guards.test.ts` verde con las dos guardas actualizadas; bloque
    `describe("T6 · RF_19 anti-copia")`: las tres callables llaman al ejecutor y sus cuerpos no contienen
    `status: "ready_to_assign"`, `status: "cancelled"`, `addressRisk: "accepted"` ni el sello; mutacion a mano
    en `EV/mutacion-rf19.txt`; bloque `describe("T6 · ...")` en `order-seller-actions.test.ts`: el ejecutor con
    una transaccion falsa aplica `patch`, `clear`, evento e historial en ese orden y no escribe nada si el plan
    rechaza.

- [ ] **T7: Reglas y `settings/storeApi`**
  * Requisitos cubiertos: RF_16, RF_17, RF_24
  * Archivos: firestore.rules, src/lib/spec-029-guards.test.ts
  * Accion: bloques `orderHistory`, `storeApiIdempotency`, `storeApiRateLimits` con `allow read, write: if
    false`; comprobar la regla de `settings` y, si el cliente pudiera escribir `settings/storeApi`, bloque
    propio.
  * Verificacion: bloque `describe("T7 · ...")`: los tres bloques con su regla; `settings/storeApi` no
    escribible por cliente; ninguna fuente de `src/` ni `functions/src/` contiene un literal de fecha asociado a
    `historySince`; ninguna fuente salvo `scripts/verify-029.js cleanup` hace `delete`/`update` sobre
    `orderHistory`.

## API

- [ ] **T8: Peticion, errores y limite (puro)**
  * Requisitos cubiertos: RF_03, RF_12, RNF_02, RNF_04
  * Archivos: functions/src/store-api-request.ts, src/lib/store-api-request.test.ts, src/lib/spec-029-guards.test.ts
  * Accion: `routeStoreApiRequest` (rutas nuevas y viejas, `Allow` por ruta), parametros permitidos por ruta,
    esquemas Zod `.strict()` de los tres cuerpos, catalogo `code` → HTTP, `buildErrorBody`, `bodyHash`
    canonico, `STORE_API_WRITES_PER_MINUTE = 120`, `rateWindow(now)` → `{ bucketId, retryAfterSeconds }`.
  * Verificacion: bloque `describe("T8 · ...")`: parametro desconocido → 400 nombrando cada uno en cada ruta
    nueva; rutas viejas sin validacion de parametros; catalogo congelado (nombres y HTTP); cuerpo con
    `totalCop` → `field_not_allowed`; `Retry-After` >= 1; hash igual con claves en otro orden. Guarda: el
    limite solo aparece en `STORE_API_WRITES_PER_MINUTE`.

- [ ] **T9: Forma de pedido extraida sin cambiar la salida**
  * Requisitos cubiertos: RF_01, RF_20
  * Archivos: functions/src/store-api-orders.ts, functions/src/store-api.ts, src/lib/store-api-orders.test.ts
  * Accion: mover `orderPayload`, `classifyOrder`, `buildPaymentInfo`, `computeKpis` y su ayudante de fecha a
    `store-api-orders.ts` tal cual; `store-api.ts` los importa. Anadir `loadTargetedPaymentInputs` puro sobre
    asientos y cortes ya leidos.
  * Verificacion: `store-api-orders.test.ts`: con fixtures (cortes ajenos, `cashAllocations`, parcialmente
    cubierto, prepago, sin asientos) `buildPaymentInfo` con los cortes dirigidos == con todos los cortes;
    instantanea de un payload de `/orders` antes y despues de mover identica.

- [ ] **T10: `GET /orders/{id}` y filtro por `shopifyOrderId`**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RNF_01, RNF_05
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-request.test.ts
  * Accion: carga dirigida (plan 2.10); 404 identico para ajeno e inexistente; `shopifyOrderId` con `in` si T1
    midio tipos mixtos; `from`/`to` ignorados con el filtro; 400 `invalid_shopify_order_id`.
  * Verificacion: bloque `describe("T10 · RNF_05")` en guardas: el handler no contiene
    `where("sellerId", "==", ...)` sin segundo filtro ni `collection("settlements").get()`; bloque
    `describe("T10 · ...")` en `store-api-request.test.ts`: formato de `shopifyOrderId` valido/invalido.

- [ ] **T11: Rutas de escritura**
  * Requisitos cubiertos: RF_04, RF_07, RF_10, RF_13, RF_19, RNF_01, RNF_02
  * Archivos: functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/spec-029-guards.test.ts, src/lib/store-api-write.test.ts
  * Accion: `POST /confirm`, `PATCH`, `POST /cancel` → ejecutor con `policy: "api"` y actor
    `{ kind: "api", keyLast4 }`; mapeo de rechazos a `StoreApiError`; 422 `out_of_coverage` con `activeCities`
    (P4); respuesta `{ ok, changed, pedido }` con la forma de T9.
  * Verificacion: `store-api-write.test.ts`: `mapRejectionToResponse` para cada rechazo (codigo, HTTP,
    `status`, `hasLeader`, `activeCities` ordenadas por nombre y ausentes si fallo su lectura); guarda: los
    handlers llaman a `runConfirm`/`runDeliveryCorrection`/`runCancel` y no escriben en `orders`.

- [ ] **T12: Idempotencia y limite de tasa**
  * Requisitos cubiertos: RNF_03, RNF_04
  * Archivos: functions/src/store-api-request.ts, functions/src/store-api-write.ts, src/lib/store-api-request.test.ts
  * Accion: `decideIdempotency(stored, { bodyHash, now })` → `replay | conflict | fresh`; lectura y escritura
    del registro dentro de la transaccion del ejecutor; ventana de tasa en transaccion corta previa; 429 con
    `Retry-After`.
  * Verificacion: bloque `describe("T12 · ...")`: misma key y cuerpo → `replay`; otro cuerpo →
    `idempotency_key_reused`; expirado → `fresh`; key vacia o > 255 → `invalid_idempotency_key`; contador 121
    → 429 y nunca 403; se guardan 200 y 409 y no 422.

- [ ] **T13: Historial por API e indice**
  * Requisitos cubiertos: RF_17, RF_18, RF_24
  * Archivos: functions/src/store-api-history.ts, functions/src/store-api-write.ts, functions/src/store-api.ts, src/lib/store-api-history.test.ts
  * Accion: `toStoreHistoryResponse(records, historySince)` con lista explicita de claves, orden ascendente,
    `excludes` y `aviso`; `GET /orders/{id}/history` (503 `history_not_ready` sin `settings/storeApi`); indice
    con rutas nuevas, codigos, estados editables, `historySince` y `HISTORY_EXCLUDES`.
  * Verificacion: bloque `describe("T13 · ...")`: ningun registro de salida trae `actor`, `uid` ni
    `auditEventId`; orden del mas viejo al mas nuevo; vacio → `registros: []` con `historySince`; el indice
    contiene las rutas nuevas y las exclusiones, y sus claves viejas no cambian.

- [ ] **T14: `getOrderAuditTrail` sin identidades para la tienda**
  * Requisitos cubiertos: RF_27, RF_18
  * Archivos: functions/src/store-api-history.ts, functions/src/orders.ts, src/lib/store-api-history.test.ts, src/lib/spec-029-guards.test.ts
  * Accion: `storeActorTag`, `storeSafeSummary` (lista permitida), `isStoreVisibleEvent` (verificable por
    `orderHistory.auditEventId` o accion permitida: mitigacion hasta la 032); la callable une `orderHistory`
    por `auditEventId`, devuelve `{ events, historySince }`, y para `seller`/`seller_logistics` no llama a
    `resolveAuditActors`.
  * Verificacion: bloque `describe("T14 · ...")`: admin → "Kentro"; lider → "Kentro"; `seller` y
    `seller_logistics` → "Tu tienda"; `store_api` → "API"; sin `actorRole` → "Kentro"; evento historico sin
    origen sale sin `actorId`/`actorLabel`/`actorEmail`/`actorRole`; `order.messenger_reassigned` verificable →
    `summary: ""`; evento no verificable fuera de la lista → descartado para la tienda y visible al admin.
    Guarda: en `getOrderAuditTrail` la llamada a `resolveAuditActors` esta en la rama que excluye a los roles de
    tienda; las plantillas `summary:` de la lista permitida no interpolan variables de actor.

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
  * Verificacion: bloque `describe("T16 · ...")`: la lista de callables de `orders.ts` y `order-corrections.ts`
    que escriben `status` en un pedido es igual a la tabla 2.6 del plan y todas llaman a
    `buildOrderHistoryRecord(`; ninguna fuente lee `auditEvents` para escribir `orderHistory` (RF_24);
    `uchat-*.ts` e importaciones no la llaman.

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
  * Archivos: src/lib/types.ts, src/lib/firebase/auth.ts, src/lib/spec-029-guards.test.ts
  * Accion: `OrderAuditEntry` ampliado, `StoreApiKeyStatus`; `fetchFirebaseOrderAuditTrail` →
    `{ events, historySince }`; `rotateFirebaseStoreWriteKey`, `getFirebaseStoreApiKeyStatus`,
    `listFirebaseStoreApiKeys`.
  * Verificacion: bloque `describe("T18 · ...")`: los cuatro envoltorios llaman a la callable de su nombre;
    `npx tsc --noEmit` limpio con los usos actuales adaptados.

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
  * Accion: `OrderAuditTrail` sacado a su archivo; nombre fijo "Historial del pedido" con `aria-expanded`;
    nota de alcance; eventos con pildora, accion, transicion y "Antes/Ahora"; vacio; error con "Reintentar";
    etiquetas nuevas en `AUDIT_ACTION_LABELS` ("Datos de entrega corregidos", "Direccion revisada", "Recogido";
    las dos ultimas, a ratificar por diseno).
  * Verificacion: bloque `describe("T22 · RF_27")`: `order-audit-trail.tsx` no pinta `actorEmail`,
    `actorLabel` ni `actorRole` cuando el evento trae `storeActorTag`; no hay fecha literal; E2E en `/sdd-verify`
    contra los seis `HU_05.*.screen.json`.

- [ ] **T23: El "?" de `CollapsiblePanel` mide 44 px**
  * Requisitos cubiertos: RF_25 (el "?" vive en el panel de la clave de API; accesibilidad WCAG 2.2 AA de la spec; pendiente 3 del README)
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
    campos dependientes del reloj declarados en el guion) para despues del despliegue.
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
    importaciones ni ChatBy, key de escritura solo por cabecera, `Idempotency-Key`, limite y ciudades activas.
  * Verificacion: bloque `describe("T26 · ...")`: la pagina menciona cada `code` del catalogo de T8, las tres
    rutas de escritura, `Authorization: Bearer` y `historySince`.

- [ ] **T27: Despliegue, recorrido real y limpieza**
  * Requisitos cubiertos: RF_20, RF_27, RNF_05, DoD 3
  * Archivos: scripts/verify-029.js, src/lib/spec-029-guards.test.ts, .sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-smoke.txt
  * Accion: modos `set-history-since` (`create`), `smoke --setup` (tienda, usuarios y pedidos de prueba del plan
    5.3), CA_01-CA_12, RF_27 con sesiones reales, p95 de escrituras y de `GET /orders/{id}`, `compare-reads`,
    `cleanup`. Orden de despliegue del plan 10 (humano).
  * Verificacion: bloque `describe("T27 · ...")`: `set-history-since` usa `create`; `cleanup` borra solo ids de
    prueba y falla si queda algo; las escrituras del guion solo apuntan a `seller-test-029`. Evidencia con p95 <
    2 s, `compare-reads` sin diferencias, `cleanup` en cero.
