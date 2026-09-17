# Tareas — Spec 018: la tienda ve el mismo saldo que el admin puede liquidarle

Plan: `specs/018_plan.md`. Cada tarea: 20–30 min, prueba primero. Evidencia en `.sdd/evidence/018/`.
Reescritas el 2026-09-16 tras las dos pasadas de `/sdd-analyze`.

- [x] **T1: Linea base en produccion antes de tocar nada (con compuerta)**
  * Requisitos cubiertos: RF_04, RF_22, RNF_04
  * Archivos: scripts/verify-018.js, .sdd/evidence/018/t1-linea-base.txt, docs/rendimiento.md
  * Accion: script de solo lectura (ADC, `functions/node_modules`), subcomando `baseline`:
    - por tienda y por proveedor, lo pendiente del admin con la definicion de efectivo recibido del
      cliente frente a la del corte (plan 2.3, 2.10);
    - asientos abiertos de tienda liquidables sin pedido (no abono/4x1000) o con pedido inexistente
      (plan 2.4), y los de tipos no liquidables;
    - pedidos abiertos no `picked_up/in_route` con `pickedUpAt`.
    Medicion de tiempo hasta la tarjeta heroe segun el guion de RNF_04 del plan (seccion 5: Playwright,
    Bella Mujer, 390 y 1280, mediana de 5, usuario desechable creado y borrado), anotada en
    `docs/rendimiento.md`.
  * Verificacion: salida en la evidencia; el usuario desechable no existe al terminar. **Compuerta:** si
    hay asientos ilegibles, o alguna tienda/proveedor cambia de cifra, se detiene el ciclo y se muestra al
    responsable; T3 y T5 no empiezan sin su respuesta.

- [x] **T2: Cuanto retiene un pedido y cuales estan en la calle**
  * Requisitos cubiertos: RF_06, RF_07, RF_09, RF_10, RF_11, RNF_02
  * Archivos: functions/src/seller-retention.ts, src/lib/seller-retention.test.ts, .sdd/evidence/018/mutacion-rnf02.txt
  * Accion: `isOrderOnTheStreet` (plan 2.6) y `retentionForOrder(order, tariffs, now, {
    fulfillmentAlreadyCharged })` sobre `buildWalletEntries` con el pedido hipotetico (plan 2.7).
  * Verificacion: estados (terminales, `picked_up`, `in_route`, reabierto con/sin marca, `retry_pending`
    sin marca, `imported`); igualdad con el cobro real en tienda general, DANDA, comunidad con lider mayor
    y bodega (sin y con manejo ya cobrado); mutacion con 12.000 literal registrada.

- [x] **T3: Una sola definicion de efectivo recibido**
  * Requisitos cubiertos: RF_03, RF_04
  * Archivos: functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts
  * Accion: `buildCodReceivedSet` = regla del corte (asignaciones cubiertas con `orderId`; sin
    asignaciones, `paid`/`reconciled`), sin la rama `cashPendingCop === 0`.
  * Verificacion: corte de domiciliario pendiente con `cashPendingCop 0` y sin asignaciones ya no cuenta;
    asignacion sin `orderId` ignorada; abonos, 4x1000 y restituciones siguen elegibles.

- [x] **T4: Entrada, seleccion por pedidos completos y cifras del saldo**
  * Requisitos cubiertos: RF_02, RF_05, RF_08, RF_12, RF_13, RF_14, RF_15, RF_16, RF_23, RF_24, RNF_01
  * Archivos: functions/src/seller-balance.ts, src/lib/seller-balance.test.ts
  * Accion: `buildSellerBalanceInput`, `selectPayableOrders`, `selectSettlementEntries` (la unica regla
    del tope), `computeSellerBalance`, `payoutRejectionMessage` (plan 2.1, 2.2, 2.4, 4.1, 4.2).
  * Verificacion:
    - tope 50.000 con 30/30/10 mil → solo el primero; fijos y negativos siempre dentro;
    - ejemplo del analisis (pagable 100.000 con abonos −500.000, teorica 150.000) → `empty_by_retention`,
      disponible 0, retenido 100.000, total cuadra;
    - ADMA (pagable negativo) sin retencion; sin retencion se toma todo;
    - corte con rango: la condicion de RF_15 se evalua sobre la tienda entera;
    - invariante del total; efectivo con neto negativo; tipos no liquidables fuera; asiento ilegible;
    - `buildSellerBalanceInput`: candidatos por estado, `chargedFulfillmentOrderIds` desde la wallet;
    - dos cortes encadenados (plan 4.4, DoD 4) sin pedido partido;
    - mensajes de rechazo (solo retencion, solo efectivo, ambos, corte vacio).

- [x] **T5: Cargador de servidor y callable `getSellerBalance`**
  * Requisitos cubiertos: RF_01, RF_22, RNF_03
  * Archivos: functions/src/seller-balance-api.ts, functions/src/index.ts, src/lib/firebase/auth.ts, src/lib/spec-018-guards.test.ts, scripts/verify-018.js, .sdd/evidence/018/t5-query-check.txt
  * Accion: requiere la compuerta de T1 resuelta. `loadSellerBalanceInput` (plan 2.5, seis lecturas,
    delega en `buildSellerBalanceInput`); callable para `seller` por su claim y `admin` con `sellerId`;
    **rechaza `seller_logistics`** y cualquier otro rol; `failed-precondition` con asientos ilegibles o
    lectura fallida. Wrapper `getFirebaseSellerBalance`. Subcomando `query-check` ejecuta la consulta de
    candidatos contra produccion.
  * Verificacion: guardas (usa `buildSellerBalanceInput` y `computeSellerBalance`; lista blanca de roles
    sin `seller_logistics`; la tienda no puede pasar `sellerId`; lee `we-<id>-fulfillment-fee` por id);
    `tsc` en `functions/` limpio; `query-check` sin error de indice.

- [x] **T6: El corte de tienda liquida pedidos completos**
  * Requisitos cubiertos: RF_01, RF_12, RF_13, RF_17, RF_23, RF_24
  * Archivos: functions/src/orders.ts, src/lib/spec-018-guards.test.ts
  * Accion: `createSettlement` usa `buildCodReceivedSet` (sin copia inline) y, en tienda,
    `selectSettlementEntries(balance, candidatos)`; rechaza si `!ok`; la transaccion cierra solo
    `selection.entryIds` (plan 4.3). El monto de la solicitud abierta no se lee.
  * Verificacion: guardas — no queda la copia inline de efectivo recibido; se llama a
    `selectSettlementEntries` y no hay otra comparacion con la retencion en `orders.ts`; la transaccion
    itera sobre la seleccion; no se lee `amountCop` de `payouts`. La regla ya esta probada en T4.

- [x] **T7: La solicitud de liquidacion usa el disponible**
  * Requisitos cubiertos: RF_01, RF_16
  * Archivos: functions/src/orders.ts, functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts, src/lib/spec-018-guards.test.ts
  * Accion: `requestSellerPayout` con `loadSellerBalanceInput` + `computeSellerBalance`; rechaza con
    disponible <= 0 usando `payoutRejectionMessage`; `amountCop = availableCop`, `blockedCop =
    codPendingCop + heldCop`. Borra `summarizeSellerPayable` y sus pruebas si queda sin llamadores.
  * Verificacion: guardas (usa el cargador y el mensaje); suite de `seller-ledger` en verde.

- [x] **T8: La API para tiendas devuelve las mismas cifras**
  * Requisitos cubiertos: RF_25, RF_01, RNF_01
  * Archivos: functions/src/store-summary.ts, functions/src/store-api.ts, src/lib/store-summary.test.ts, src/lib/spec-018-guards.test.ts
  * Accion: mover `buildStoreSummary` y sus helpers a `store-summary.ts` (puro); anadir `SellerBalance`,
    `retenidoCop`, `retenidoPedidos` y `significado` (plan 2.9). `store-api.ts` lee `settings/global` y
    las zonas de los candidatos, arma la entrada con `buildSellerBalanceInput` y delega.
  * Verificacion: con los mismos documentos, `disponibleCop == computeSellerBalance().availableCop` y el
    total cuadra; guarda: `store-summary.ts` no importa `firebase-admin` ni `firebase-functions`.

- [x] **T9: El admin usa la definicion y la elegibilidad del servidor**
  * Requisitos cubiertos: RF_04, RF_20
  * Archivos: src/components/operations-app.tsx, src/lib/spec-018-guards.test.ts
  * Accion: `receivedDriverOrderIds` → `buildCodReceivedSet`; la copia de cliente `isSellerEntryEligible`
    → la de `seller-ledger.ts`. Afecta tambien a la fila de proveedores (plan 2.10); su cambio ya lo midio
    T1.
  * Verificacion: guardas — no quedan `receivedDriverOrderIds`, `cashPendingCop === 0` ni una funcion
    local `isSellerEntryEligible` en el componente; `tsc` raiz limpio.

- [x] **T10: Cierre pendiente del admin con el disponible y su desglose**
  * Requisitos cubiertos: RF_01, RF_20, RF_22
  * Archivos: src/components/operations-app.tsx, src/lib/spec-018-guards.test.ts
  * Accion: la fila de tienda arma `buildSellerBalanceInput` con los arrays de `state` y usa
    `computeSellerBalance`; detalle con efectivo y retenido; "Saldo incompleto" con ilegibles; el boton de
    corte envia `selection.entryIds`.
  * Verificacion: guardas — la fila llama a `buildSellerBalanceInput` y `computeSellerBalance` y no suma
    asientos por su cuenta para `availableCop`; rotulos del detalle; `walletEntryIds` en la llamada de
    corte de tienda.

- [x] **T11: Tarjeta heroe de la tienda con refresco y error**
  * Requisitos cubiertos: RF_18, RF_21, RF_22
  * Archivos: src/components/operations-app.tsx, src/lib/spec-018-guards.test.ts
  * Accion: hook `useSellerBalance` (al montar, cada 300000 ms, al volver visible; error sin cifra
    previa); heroe "Disponible para liquidar" con esqueleto, error y reintento; hooks antes de cualquier
    `return` anticipado (principio 13).
  * Verificacion: guardas (sin "de hoy", intervalo 300000, rama de error sin cifra, hook antes del
    `return`); `npm run lint` sin errores.

- [x] **T12: Panel de wallet de la tienda y retirada de la reserva fija**
  * Requisitos cubiertos: RF_07, RF_16, RF_19
  * Archivos: src/components/operations-app.tsx, src/lib/finance.ts, src/lib/finance.test.ts, src/lib/actions.ts, src/lib/types.ts, src/lib/spec-018-guards.test.ts
  * Accion: `WalletPanel` de tienda con las cuatro lineas (plan 2.8); boton deshabilitado con disponible
    <= 0 y el motivo; quitar `sellerBalance`, su prueba y el import muerto; `pendingReserveCop`
    `@deprecated`.
  * Verificacion: guardas (nadie lee `pendingReserveCop` ni `sellerBalance`; sin "Reserva"); suite
    completa, `tsc` raiz y `functions/`, lint en verde.

- [x] **T13: Medicion posterior en produccion y rendimiento**
  * Requisitos cubiertos: RF_01, RF_08, RF_09, RNF_04
  * Archivos: scripts/verify-018.js, docs/rendimiento.md, .sdd/evidence/018/t13-medicion.txt
  * Accion: tras compilar `functions/` (`npm run build`), subcomando `compare` en JS puro sobre
    `functions/lib` (plan 5): para las cinco tiendas de la spec, camino del servidor
    (`loadSellerBalanceInput`) frente al camino del admin (colecciones enteras →
    `buildSellerBalanceInput`), al peso, e invariante del total; reabiertos que retienen; lecturas por
    llamada. Repetir el guion de RNF_04 de T1.
  * Verificacion: coincidencia al peso en las cinco; tiempo dentro de ±10 % de T1 o riesgo elevado al
    responsable con la propuesta de `minInstances`.

- [x] **T14: Hallazgos de la revision adversarial (ronda 1)**
  * Requisitos cubiertos: RF_01, RF_02, RF_09, RF_14, RF_20, RF_22, RF_24, RF_25
  * Archivos: functions/src/seller-balance.ts, src/lib/seller-balance.test.ts, functions/src/store-api.ts, functions/src/orders.ts, src/components/operations-app.tsx, src/lib/spec-018-guards.test.ts
  * Accion: R1-RF_20-1 la fila de una tienda con disponible 0 pero efectivo, retenido o ilegibles no desaparece del
    cierre del admin; R1-RF_02-1 las restituciones positivas sin pedido compiten por el tope como un pedido;
    R1-RF_22-1 la API para tiendas no devuelve cifra con asientos ilegibles; R1-RF_24-1 solo se rechaza el corte si
    la retencion es la causa; R1-RF_09-1 la transicion a recogido/en ruta sella `pickedUpAt` si falta;
    R1-RF_01-1 el panel de wallet no congela la hora del calculo.
  * Verificacion: pruebas nuevas en `seller-balance.test.ts` (restitucion y corte negativo con retencion) y guardas
    en `spec-018-guards.test.ts` para los otros cuatro; suite completa, tsc y lint en verde.

- [x] **T15: Hallazgos de la revision adversarial (ronda 2)**
  * Requisitos cubiertos: RF_08, RF_14, RF_20, RF_22, RF_23, RF_24
  * Archivos: functions/src/seller-balance.ts, src/lib/seller-balance.test.ts, functions/src/orders.ts, src/components/operations-app.tsx, src/lib/spec-018-guards.test.ts
  * Accion: R2-RF_20-1 una fila de tienda sin asientos no puede lanzar un corte (el cliente no lo envia y el servidor
    rechaza un corte de tienda con asientos ilegibles); R2-RF_23-1 con retencion, un corte que ya seria negativo usa la
    seleccion CON tope; R2-RF_08-1 el conteo de retenidos incluye las restituciones sin pedido en todos los casos.
  * Verificacion: pruebas nuevas en `seller-balance.test.ts` y guardas en `spec-018-guards.test.ts`; suite, tsc y lint.

- [x] **T16: RNF_04 — la tarjeta heroe no puede tardar mas de +10 %**
  * Requisitos cubiertos: RNF_04, RF_18
  * Archivos: src/components/operations-app.tsx, functions/src/seller-balance-api.ts, src/lib/spec-018-guards.test.ts, scripts/verify-018.js, docs/rendimiento.md, .sdd/evidence/018/t13-medicion.txt
  * Accion: medido en produccion tras desplegar, la tarjeta paso de 989/975 ms a 1.574/1.417 ms (movil/escritorio).
    El saldo se pide con la tienda de la SESION, en paralelo con la carga de Firestore (antes esperaba a que llegara
    la lista de tiendas), y la callable corre con 512 MiB (CPU, arranque en frio), como `applyOrderTransition`.
  * Verificacion: guardas (el hook recibe `session.profileId`; la callable declara memoria); nueva medicion `perf`
    en produccion dentro de +10 %, o riesgo elevado al responsable con `minInstances`.

- [x] **T17: La API para tiendas avisa del cambio a quien la consulta**
  * Requisitos cubiertos: RF_26
  * Archivos: functions/src/store-summary.ts, functions/src/store-api.ts, src/lib/store-summary.test.ts, src/lib/spec-018-guards.test.ts
  * Accion: aviso fechado `STORE_BALANCE_NOTICE` en `store-summary.ts`; `buildStoreSummary` lo devuelve en
    `avisos`; el indice (`docs`) lo incluye y su descripcion de `/resumen` nombra `retenidoCop`.
  * Verificacion: `store-summary.test.ts` (el resumen trae el aviso con fecha y los campos nombrados); guarda
    del indice; despliegue de `storeApi` y consulta real al indice.


## Cobertura RF → tarea

| Requisito | Tareas |
|---|---|
| RF_01 | T5, T6, T7, T8, T10, T13 |
| RF_02 | T4 |
| RF_03 | T3 |
| RF_04 | T1, T3, T9 |
| RF_05 | T4 |
| RF_06 | T2 |
| RF_07 | T2, T12 |
| RF_08 | T4, T13 |
| RF_09 | T2, T13 |
| RF_10 | T2 |
| RF_11 | T2 |
| RF_12 | T4, T6 |
| RF_13 | T4, T6 |
| RF_14 | T4 |
| RF_15 | T4 |
| RF_16 | T4, T7, T12 |
| RF_17 | T6 |
| RF_18 | T11 |
| RF_19 | T12 |
| RF_20 | T9, T10 |
| RF_21 | T11 |
| RF_22 | T1, T5, T10, T11 |
| RF_23 | T4, T6 |
| RF_24 | T4, T6 |
| RF_25 | T8 |
| RF_26 | T17 |
| RNF_01 | T4, T8 |
| RNF_02 | T2 |
| RNF_03 | T5 |
| RNF_04 | T1, T13 |

Sin requisitos huerfanos. Caso limite "tienda logistica no ve las cifras": T5 (guarda de rol).
