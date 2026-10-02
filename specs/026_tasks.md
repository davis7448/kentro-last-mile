# Tareas — Spec 026: efectivo que no llega a un corte

Plan: `specs/026_plan.md` (revisado tras cinco pasadas de `/sdd-analyze`, seccion 12). Spec enmendada el
2026-10-02 con RF_09 ("cubierto por compensacion", decidido por el responsable). Diseno:
`specs/design/026_efectivo_que_no_llega_a_un_corte/` (redibujado y observado tras la enmienda).
Evidencia: `.sdd/evidence/026_efectivo_que_no_llega_a_un_corte/` (abajo `EV/`).

Cada tarea empieza por una prueba que falla (RED). Vitest solo recoge `src/**/*.test.ts`; `functions/src`
se importa como `../../functions/src/<modulo>`.

**Archivos compartidos (plan 5.2):** un bloque `describe("T<n> · ...")` por tarea, sin editar los de otra,
en `src/lib/spec-026-guards.test.ts` (T1, T6, T12, T13, T15, T16, T17), `src/lib/cash-outstanding.test.ts`
(T6-T9) y `src/lib/cash-outstanding-loads.test.ts` (T14, T16). `src/components/operations-app.tsx`: T15,
T16 y T17, cada una en su punto de montaje. `functions/src/cash-outstanding-schemas.ts`: T5 lo crea, T12
anade `resolveCashOutstandingScope`. `src/lib/cash-outstanding-loads.ts`: T14 crea la cache, T16 anade
`reloadAfterCashAlertSave`.

**Reglas transversales:** escrituras nuevas por constructores con `stripUndefined` (plan 2.8); dos modos
de carga (plan 2.1); guarda RNF_01 solo sobre archivos nuevos con el conteo de `buildCodReceivedSet` en
`operations-app.tsx` congelado (medido al escribir la guarda; hoy 3); guarda anti-copia con lista fija de
cuatro archivos (plan 2.2); `covered_by_netting` va a `nettedRows`, nunca vence ni avisa (plan 2.9).

## Medicion previa (compuertas)

- [x] **T1: Linea base contra produccion, con ids**
  * Requisitos cubiertos: RNF_01, RNF_02, RF_07, RF_09
  * Archivos: scripts/verify-026.js, src/lib/spec-026-guards.test.ts, .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t1-linea-base.txt, .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t1-linea-base-ids.json
  * Accion: modo `baseline` de solo lectura (plan 5.3): conteos; fuentes de `deliveredAt`; neto <= 0;
    asientos de domiciliario sin `settlementId`; cortes de domiciliario sin `cashPendingCop`; cortes con
    pendiente guardado distinto del recalculado; **cortes saldados por compensacion y sus pedidos** (criterio
    de `isDriverSettlementCashSettled`, plan 2.9). La cifra de compensados se mide **con la misma metrica que
    la spec** (cortes, pedidos e importe tal como se midieron el 2026-10-02) y **T1 nombra la unidad** del
    importe (recaudo, efectivo esperado o pendiente) en la evidencia; ademas da el recaudo de esos pedidos.
    Cortes con excedente; coste de los dos modos; tabla de antiguedad. Ids en `EV/t1-linea-base-ids.json`
    (`{ over30Days, coveredByNetting, rows }`).
  * Verificacion: bloque `describe("T1 · verify-026 es de solo lectura")` (sin `.set(`, `.update(`,
    `.delete(`, `.create(`, `batch(`, `runTransaction(`); `node scripts/verify-026.js baseline` sin error y
    con las dos evidencias; la evidencia nombra la unidad de $1.151.997. Compuertas (plan 5.4): compensados
    distintos de 29 / 36 / $1.151.997 **en la misma metrica** → reportar antes de T7; filas >30 dias por
    `updatedAt` → reportar antes de T7; umbrales de coste → decision antes de T12.

- [x] **T2: Consultas exactas, indices y coste de los dos modos documentado**
  * Requisitos cubiertos: RNF_01, RF_07
  * Archivos: scripts/verify-026.js, firestore.indexes.json, .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t2-query-check.txt, docs/rendimiento.md, src/lib/spec-026-guards.test.ts (bloque `describe("T2 · ...")`; anadido en implement el 2026-10-02 para que T2 tenga su RED)
  * Accion: `query-check`: cada consulta del cargador con `limit(1)` e indices pedidos; carga completa de
    cada modo cronometrada. Si pide indice: comparar con `firebase firestore:indexes` y **anadir** sin quitar
    nada; si no, `firestore.indexes.json` no se toca. Seccion "Spec 026" en `docs/rendimiento.md`.
  * Verificacion: guarda de T1 verde; `query-check` sin error; diff de indices solo anade; cifras de las
    evidencias, no estimaciones.

## Nucleo puro

- [x] **T3: Extraer la formula de "por cobrar al domiciliario" y la clave de proveedor**
  * Requisitos cubiertos: RNF_02, RF_08
  * Archivos: functions/src/driver-receivable.ts, functions/src/supplier-withheld.ts, functions/src/platform-position.ts, src/lib/driver-receivable.test.ts
  * Accion: `computeDriverReceivable` y predicados (`cashPendingCop` ausente = 0, como hoy);
    `withheldSupplierKey` y `groupWithheldBySupplier`. `computePlatformPosition` delega sin cambiar cifras.
  * Verificacion: `driver-receivable.test.ts` y `platform-position.test.ts` verdes; mismas cifras (incluido
    corte sin `cashPendingCop` y asiento sin `supplierId`); subconjunto = ledger.

- [x] **T4: Parcial recibido y corte saldado, junto a sus reglas**
  * Requisitos cubiertos: RF_01, RF_09
  * Archivos: functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts, functions/src/settlement-math.ts, src/lib/settlement-math.test.ts
  * Accion: `codPartialReceivedCop(settlements)` en `seller-ledger.ts` (llama a `buildCodReceivedSet`).
    `isDriverSettlementCashSettled(settlement)` en `settlement-math.ts` (plan 2.9): driver, `paid|reconciled`,
    `(cashPendingCop ?? 0) === 0`, `cashExpectedCop` numerico y `settlementCashReceivedCop >= cashExpectedCop`;
    no lee `cashAllocations`.
  * Verificacion: `seller-ledger.test.ts`: parcial en uno y dos cortes, cubierto en otro no aparece, pagado
    sin asignaciones no aparece; pruebas de la 018 verdes. `settlement-math.test.ts`: pagado exacto →
    saldado; conciliado con excedente → saldado; pagado con pendiente > 0 → no; `pending` con pendiente 0
    → **no**; sin `cashPendingCop` y recibido = esperado → saldado; sin `cashExpectedCop` → no; kind
    distinto de driver → no.

- [x] **T5: Esquemas, ajustes de alerta y sus escrituras**
  * Requisitos cubiertos: RF_04
  * Archivos: functions/src/cash-outstanding-schemas.ts, src/lib/cash-outstanding-schemas.test.ts
  * Accion: Zod de entrada `{ includeReconciliation: boolean = false }.strict()`; ajustes (7 y 20.000,
    enteros, rangos, `.strict()`); pedido; corte con `cashPendingCop`, `cashExpectedCop`, `cashReceivedCop`
    opcionales (ausente = 0 para el pendiente); asiento (`amountCop` finito). `readCashAlertSettings`,
    `parseWalletEntries` → `{ entries, unreadableEntryIds }`, constructores con `stripUndefined`.
  * Verificacion: `cash-outstanding-schemas.test.ts`: `{}` → `false`; `driverId` rechazado; defectos y
    rechazos de ajustes; corte sin `cashPendingCop` pasa (no va a ilegibles); asiento `NaN` o sin `orderId`
    → `unreadableEntryIds`; constructores sin ningun `undefined`.

- [x] **T6: Pertenencia a la lista e importes (nucleo)**
  * Requisitos cubiertos: RF_01, RF_07
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts, src/lib/spec-026-guards.test.ts, .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/mutacion-rf01.txt
  * Accion: `buildCashOutstandingReport` (plan 4.2 pasos 1-3): regla importada, filtro propio, importes,
    `isIncomplete` y `unreadable*`.
  * Verificacion: bloque `describe("T6 · ...")`: equivalencia con `!isSellerEntryEligible` (todo pedido de
    `rows` o `nettedRows` es no elegible y todo no elegible del universo esta en una de las dos); `failed`
    en la entrada no sale; pedido de 2026-06-01 aparece (DoD 2); parcial; $1; filas identicas
    `full`/`targeted`; `isIncomplete` con asiento ilegible. Bloque `describe("T6 · RF_01: la regla de
    recibido no se copia")`: importa y llama la regla; `findReceivedRuleCopies` `[]` en los archivos de la
    lista fija que existan; mutacion detectada. `EV/mutacion-rf01.txt`.

- [x] **T7: Fecha, antiguedad y ubicacion (incluida la compensacion)**
  * Requisitos cubiertos: RF_02, RF_03, RF_09
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts
  * Accion: `deliveredAt`, `ageDays`, `isOverdue` (falso si `covered_by_netting`); `row.settlements` con
    `cashSettled`; `location` con la precedencia del plan 2.9; `attributedSettlementId`; nombres; reparto
    `rows` / `nettedRows`.
  * Verificacion: bloque `describe("T7 · ...")`: cuatro fuentes; dia 7/8; abierto; pagado con faltante
    real; corte pagado saldado en total con el pedido sin asignacion cubierta → `covered_by_netting`, en
    `nettedRows`, `isOverdue: false` aunque tenga 90 dias; pendiente + saldado → abierto; saldado + con
    faltante → `covered_by_netting`; fuera → `[]`.

- [x] **T8: Agrupaciones, proveedor, alcance y totales**
  * Requisitos cubiertos: RF_06, RF_08, RF_03, RF_09
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts
  * Accion: `byLeader` solo de `rows` (orden `overdueCop` desc, empate `outstandingCop`, id);
    `bySupplier`/`supplierWithheld` con `groupWithheldBySupplier`, solo de `rows`; totales con
    `netted*` aparte; alcance de lider.
  * Verificacion: bloque `describe("T8 · ...")`: lider solo lo suyo; sin proveedor para el lider;
    `"(sin proveedor)"`; **una fila con `driverId: null` forma un grupo de `byLeader` con `leaderId: null`**
    (caso limite "pedido sin lider"); un compensado no suma a `outstandingCop`, `overdueCop`, `byLeader` ni
    `bySupplier` y si a `nettedCount`/`nettedCollectedCop`; subtotales de ubicacion suman `outstandingCop`;
    orden de `byLeader` por importe vencido aunque otro lider tenga mas pedidos.

- [x] **T9: Conciliacion por causas sin residuo**
  * Requisitos cubiertos: RNF_02, RF_09
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts
  * Accion: `reconciliation` (plan 4.4): razones independientes de las filas (incluida
    `covered_by_netting` calculada desde los cortes); causas de fuera y por corte con el pendiente
    recalculado; `stale` (campo presente y distinto) y `missing` (campo ausente) como causas propias;
    `staleSettlementsCop`, `missingPendingSettlementsCop`, `unexplainedCop`, `unexplainedOrderIds`.
  * Verificacion: bloque `describe("T9 · ...")`: sin causas `deltaCop === 0`; cada causa sola y todas →
    `unexplainedCop === 0`; propiedad (semilla fija, >= 200 casos); fila con importe quitada de `rows`,
    fuera y en corte → `unexplainedCop !== 0` con su id; fila quitada de `nettedRows` → nada cambia; corte
    con pendiente viejo → `stale`; corte sin `cashPendingCop` → `missing` (no `stale`); los cortes del tipo
    medido (fixture) → `unexplainedCop === 0` con `settlement_orders_covered_by_netting`; sin
    `includeReconciliation`, `targeted` o lider → `null`.

## Aviso

- [x] **T10: Composicion del aviso y sus documentos**
  * Requisitos cubiertos: RF_05, RF_09
  * Archivos: functions/src/cash-overdue-notice.ts, src/lib/cash-overdue-notice.test.ts
  * Accion: `selectNoticeCandidates` (solo `rows`), `composeOverdueNotice` (por lider, sin datos del
    cliente, 2.000 caracteres, "cifras incompletas"), `buildNoticeDocs`, `buildRunDoc`.
  * Verificacion: `cash-overdue-notice.test.ts`: umbral, una vez, agrupacion, sin lider, truncado; un
    informe con `nettedRows` de 90 dias y $500.000 no produce candidatos; constructores sin `undefined`.

- [x] **T11: Canal de aviso por webhook**
  * Requisitos cubiertos: RF_05
  * Archivos: functions/src/ops-notify.ts, src/lib/ops-notify.test.ts
  * Accion: `isOpsChannelConfigured`, `sendOpsNotice(text, { url, fetchImpl, timeoutMs })`.
  * Verificacion: `fetchImpl` falso: 2xx, 500, excepcion, `""`/`"  "`/`"none"`/`undefined` sin llamada.

## Servidor

- [x] **T12: Alcance, cargador y callable `getCashOutstanding`**
  * Requisitos cubiertos: RF_06, RF_07, RNF_01, RNF_02
  * Archivos: functions/src/cash-outstanding-schemas.ts, functions/src/cash-outstanding-api.ts, functions/src/index.ts, src/lib/spec-026-guards.test.ts
  * Accion: `resolveCashOutstandingScope` (`token.driverId`); `loadCashOutstandingInput` (plan 4.3);
    secreto; `getCashOutstanding`. Exportar.
  * Verificacion: bloque `describe("T12 · alcance, cargador y callable")`: prueba de
    `resolveCashOutstandingScope` (admin con/sin; driver con claim; driver sin claim → `permission-denied`;
    driver con `true` → resumen; seller y sin sesion → denegado). Guardas: sin fecha ni `limit`; consultas
    `full` con los predicados; iguales a `query-check`; asientos por `parseWalletEntries`; URL no devuelta;
    `tsc` en `functions/`.

- [x] **T13: Ajustes y aviso programado**
  * Requisitos cubiertos: RF_04, RF_05
  * Archivos: functions/src/cash-outstanding-api.ts, functions/src/index.ts, src/lib/spec-026-guards.test.ts
  * Accion: `updateCashAlertSettings`; `notifyOverdueCash` (plan 2.4), candidatas solo de `rows`.
  * Verificacion: bloque `describe("T13 · escrituras sin undefined y aviso tras envio")`: escrituras con
    `build*Doc(`/`stripUndefined(`; marca tras `.ok`; admin y auditoria; sin `catch` vacio; `secrets` y
    `timeZone`; sin conciliacion; no lee `nettedRows` para candidatos; exportadas; `tsc`.

## Interfaz

- [ ] **T14: Envoltorios, cache de la carga compartida y modelo de vista**
  * Requisitos cubiertos: RF_02, RF_03, RF_06, RF_08, RF_09
  * Archivos: src/lib/firebase/auth.ts, src/lib/types.ts, src/lib/cash-outstanding-view.ts, src/lib/cash-outstanding-view.test.ts, src/lib/cash-outstanding-loads.ts, src/lib/cash-outstanding-loads.test.ts
  * Accion: `auth.ts`: `getFirebaseCashOutstanding({ includeReconciliation? })` y
    `updateFirebaseCashAlertSettings(input)` (patron `getFirebaseSellerBalance`). `cash-outstanding-loads.ts`:
    `createCashOutstandingSummaryCache(fetchReport)` con `get({ uid, refresh })`, `prime`, `clear` (plan
    2.1; no importa `auth.ts`). `buildCashOutstandingView(report, { viewport, role, leaderFilter })`:
    filtro en cliente y cuadre oculto con filtro; grupos, plegado, paginas; grupo "Sin lider" con el texto
    "no hay a quien cobrarle" (README, decision 4); mapa de rotulos de las cuatro ubicaciones (plan 4.1);
    seccion "Cubiertos por compensacion" plegada desde `nettedRows`; tarjeta de Operacion con "el lider con
    mas efectivo vencido" (`byLeader[0]`); linea de proveedor; "aprox."; "Cifras incompletas" por tipo.
  * Verificacion: `cash-outstanding-view.test.ts`: rotulos (ocho, con la fecha del corte correcto);
    **grupo "Sin lider" con el texto "no hay a quien cobrarle"**; seccion de compensados con sus totales y
    sin contarlos como vencidos; tarjeta: con un lider de 5 pedidos y $50.000 vencidos y otro de 2 pedidos y
    $400.000, nombra al segundo; cuadre oculto con filtro y de vuelta sin el; tarjeta en $0; ilegibles.
    Bloque `describe("T14 · cache de la carga compartida")` en `cash-outstanding-loads.test.ts` con
    `fetchReport` falso: dos `get` del mismo `uid` → una llamada con `includeReconciliation: false`; otro
    `uid` → otra; `refresh` → otra; `prime` sustituye; `clear` vacia; un rechazo no queda cacheado. `tsc` en
    la raiz.

- [ ] **T15: Admin — tarjeta de Operacion y pestana "Efectivo sin llegar"**
  * Requisitos cubiertos: RF_02, RF_03, RF_09, RNF_01
  * Archivos: src/components/cash-outstanding-admin.tsx, src/components/operations-app.tsx, src/lib/spec-026-guards.test.ts
  * Accion: instancia de la cache con `getFirebaseCashOutstanding` y el `uid` de la sesion; tarjeta desde la
    cache; pestana con `includeReconciliation: true` y `prime`; filtro en cliente; grupos, filas, detalle,
    seccion "Cubiertos por compensacion" y cuadre (solo sin filtro). Segun `HU_01.aviso-operacion`,
    `HU_01.lista`, `HU_01.lista-escritorio`, `HU_01.cargando`, `HU_01.vacio`, `HU_01.error`,
    `HU_01.ilegibles` y el README (decisiones 2, 4, 5, 12). Montaje: Operacion del admin y pestanas de
    Liquidaciones.
  * Verificacion: bloque `describe("T15 · interfaz del admin: lista y tarjeta")`: la tarjeta no pide
    conciliacion; solo la pestana pasa `true`; el filtro no llama; RNF_01 sobre `cash-outstanding-admin.tsx`
    y `cash-outstanding-view.ts`; conteo congelado en `operations-app.tsx`; textos del diseno (incluidos
    "Cubierto por compensacion" y "el lider con mas efectivo vencido"); `npm run lint`. **E2E de HU_01 en
    `/sdd-verify`.**

- [ ] **T16: Admin — "Plazo y aviso", recarga y proveedor en Por pagar**
  * Requisitos cubiertos: RF_04, RF_08, RNF_01
  * Archivos: src/lib/cash-outstanding-loads.ts, src/lib/cash-outstanding-loads.test.ts, src/components/cash-outstanding-admin.tsx, src/components/operations-app.tsx, src/lib/spec-026-guards.test.ts
  * Accion: `reloadAfterCashAlertSave({ isTabOpen }, { fetchReport, cache, uid })`; dialogo segun
    `HU_01.plazo` (su texto "una vez por pedido" se conserva, spec seccion 9); tarjeta de proveedores; linea
    "No se puede pagar todavia" desde la cache. Montaje: solo la tarjeta de proveedor de Por pagar.
  * Verificacion: bloque `describe("T16 · recarga tras guardar ajustes")` en
    `cash-outstanding-loads.test.ts`: abierta → `fetchReport({ includeReconciliation: true })` y
    `cache.prime`; cerrada → `cache.get({ refresh: true })`; el error se propaga. Bloque
    `describe("T16 · interfaz del admin: plazo y proveedor")`: el dialogo llama a `reloadAfterCashAlertSave`;
    no escribe `settings`; RNF_01 sobre `cash-outstanding-loads.ts`; conteo congelado; `lint`. **E2E con
    `HU_01.plazo` en `/sdd-verify`.**

- [ ] **T17: Interfaz del lider y cierre de las guardas**
  * Requisitos cubiertos: RF_06, RF_09, RF_01, RNF_01
  * Archivos: src/components/cash-outstanding-leader.tsx, src/components/operations-app.tsx, src/lib/spec-026-guards.test.ts
  * Accion: panel "Efectivo sin llegar a Kentro" segun `HU_02.finanzas`, `HU_02.al-dia`, `HU_02.error`
    (cifra `outstandingCop` sin compensados; linea aparte "cubiertos en un corte saldado"; rotulos de lider).
    Montaje: solo Finanzas de `DriverView`, sin hooks tras `return` anticipado.
  * Verificacion: bloque `describe("T17 · interfaz del lider")`: llama a `getFirebaseCashOutstanding()` sin
    argumentos; RNF_01 sobre `cash-outstanding-leader.tsx`; conteo congelado; textos; `lint`. Bloque
    `describe("T17 · RF_01: la guarda anti-copia mira los cuatro archivos")`: existen los cuatro y dan `[]`.
    **E2E de HU_02 en `/sdd-verify`.**

## Verificacion contra produccion

- [ ] **T18: Comparacion con la posicion y con la linea base**
  * Requisitos cubiertos: RNF_02, RF_07, RF_09, RNF_01
  * Archivos: scripts/verify-026.js, .sdd/evidence/026_efectivo_que_no_llega_a_un_corte/t18-compare.txt
  * Accion: `compare` y `compare --deployed` (plan 5.3). **Regla de paso (DoD 4):** pasa si y solo si
    `unexplainedCop === 0` y `driverReceivableCop` es igual al de la posicion, con los tres `unreadable*`
    vacios. `staleSettlementsCop` y `missingPendingSettlementsCop` se reportan por corte como hallazgo y
    **no fallan**. **DoD 3:** compara contra `EV/t1-linea-base-ids.json`: los compensados (o su estado
    actual) en `nettedRows` y no vencidos; por cada id que cambio de grupo, su motivo comprobado; un id sin
    motivo falla.
  * Verificacion: guarda de T1 verde; `node scripts/verify-026.js compare` con la regla de paso anterior;
    evidencia con la lista de stale/missing y la tabla de ids con motivo. `compare --deployed` en
    `/sdd-verify` tras el despliegue.

## Cobertura RF → tarea

| Requisito | Tareas |
|---|---|
| RF_01 | T4, T6, T17 |
| RF_02 | T7, T14, T15 |
| RF_03 | T7, T8, T14, T15 |
| RF_04 | T5, T13, T16 |
| RF_05 | T10, T11, T13 |
| RF_06 | T8, T12, T14, T17 |
| RF_07 | T1, T2, T6, T12, T18 |
| RF_08 | T3, T8, T14, T16 |
| RF_09 | T1, T4, T7, T8, T9, T10, T14, T15, T17, T18 |
| RNF_01 | T1, T2, T12, T15, T16, T17, T18 |
| RNF_02 | T1, T3, T9, T12, T18 |

Orden: T1 → T2 → (T3, T4, T5) → T6 → T7 → T8 → T9 → (T10, T11) → T12 → T13 → T14 → T15 → T16 → T17 → T18.
T12 no empieza con una compuerta de T1/T2 sin resolver.
