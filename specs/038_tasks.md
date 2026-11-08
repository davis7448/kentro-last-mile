# Tareas 038: cada recaudo se le cobra al domiciliario una sola vez

Spec: `specs/038_cada_recaudo_se_cobra_una_vez.md` (aprobada el 2026-11-08). Plan: `specs/038_plan.md`.
Cada tarea se codifica y se prueba en 20-30 minutos. Orden: primero el nucleo puro (T1-T9), despues los
que lo llaman en servidor (T10-T16), el cliente (T17), y al final reglas, scripts y guardas (T18-T22).
Ninguna tarea despliega ni escribe en produccion: los scripts de T19 y T20 se construyen y se prueban en
seco; ejecutarlos con `--write`/`--apply` lo aprueba el responsable aparte.

Las pruebas del codigo de `functions/src` viven en `src/lib/*.test.ts`, como en el resto del repo.

## Nucleo puro: `functions/src/driver-cash-ledger.ts`

- [ ] **T1: Tipos y lo que un pedido debe hoy**
  * Requisitos cubiertos: RF_01, RF_02
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: tipos `DriverCashCharge`, `DriverSettlementLedgerFields`, `DriverLedgerBaseline`,
    `DriverCashHolds`, `DriverLedgerContext` (plan §2) y `orderOwedByDriver(entries, driverId)` (§3.1):
    por pedido, recaudo vigente (`cod_revenue` + `cod_remittance`, de cualquier tienda), pago vigente
    (`driver_earning` solo de ese domiciliario) y debido
  * Verificacion: pruebas de unidad: reversa de recaudo resta, pago de otro domiciliario no cuenta, pedido
    con recaudo en dos tiendas suma las dos

- [ ] **T2: Reconstruccion historica de un corte viejo**
  * Requisitos cubiertos: RF_05, RF_05b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `rebuildHistoricalCharges(settlement, entriesByOrder, payByOrder)` con la regla validada de
    `specs/038_measure.js` (plan §3.4): asignacion si existe; `min(0, reconstruido)` si el corte tiene
    asignaciones y el pedido no figura; reconstruido si no tiene; corte de asientos por el ultimo recalculo
    (creacion, abonos, pago, conciliacion). Devuelve `source: "allocation" | "rebuilt"` por pedido
  * Verificacion: prueba **por pedido**: cada pedido con asignacion reconstruye su `expectedCop`; caso
    KNT-000056 (corte con asignaciones que no lo lista) da `min(0, …)`; el total del corte cuadra con
    `cashExpectedCop`

- [ ] **T3: El cargo de un corte**
  * Requisitos cubiertos: RF_02, RF_03, RF_09b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `computeDriverCorte(input)` sin saldo a favor todavia: `registrado(o, X)` desde `cashCharges`
    de los otros cortes o desde la foto (§3.2); `cargo = debido − registrado + retencion`; `pago_X` = solo
    los asientos del propio corte; `recaudo_X = cargo + pago_X` (§3.3). Un `DriverCashCharge` por pedido de
    `orderIds`, incluidos los de 0 y los negativos, sin recortar
  * Verificacion: pruebas: pedido en dos cortes cobra una sola vez; pedido con pago descontado en otro corte
    no se descuenta dos veces; ningun pedido aparece con dos montos; `recaudo − pago = Σ cargos`

- [ ] **T4: Saldo a favor y reparto de lo recibido**
  * Requisitos cubiertos: RF_08, RF_09b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `creditoEntrada = Σ creditOut − Σ creditIn` de los demas cortes (puede ser negativo);
    `bruto = Σ cargos + creditoEntrada`; `esperado = max(0, bruto)`; `creditoSalida = max(0, −bruto)`.
    `cashAllocations` reparte el efectivo recibido entre los pedidos con cargo > 0, en el orden de hoy
    (creacion, tracking), con los campos que leen la 026 y la 027
  * Verificacion: pruebas: devolucion mayor que lo que se debe → esperado 0 y credito de salida exacto; el
    siguiente corte lo consume una vez; un corte pendiente que reduce su credito despues deja la deuda en el
    siguiente; las asignaciones suman lo recibido

- [ ] **T5: Prueba de propiedad**
  * Requisitos cubiertos: RF_01, RF_08, RNF_02
  * Archivos: src/lib/driver-cash-ledger.property.test.ts
  * Accion: LCG con semilla fija (sin dependencia nueva) que genera secuencias por pedido: entrega, visita
    fallida, correccion entregado→fallido con corte cerrado o pendiente, recaudo borrado, re-entrega, cambio
    de tienda, abonos parciales, cortes recalculados en distinto orden
  * Verificacion: tras cada paso, para todo pedido `Σ cargos = debido + retencion`, y
    `esperado − creditoEntrada + creditoSalida = Σ cargos`; varios cientos de secuencias, reproducibles

- [ ] **T6: Los cuatro casos reales como fixtures**
  * Requisitos cubiertos: RNF_03, RF_05b
  * Archivos: specs/038_measure.js, src/lib/fixtures/038-knt-003259.json, src/lib/fixtures/038-knt-004540.json,
    src/lib/fixtures/038-knt-002682.json, src/lib/fixtures/038-knt-002965.json,
    src/lib/driver-cash-ledger.cases.test.ts
  * Accion: opcion `--fixtures <dir>` del script de medicion (solo lectura) que vuelca cortes y asientos de
    un pedido **anonimizados** (sin telefono, direccion ni nombre; quedan ids y tracking). Prueba por caso
  * Verificacion: para cada uno, la regla vieja (`computeDriverCashSummary` de hoy, copiada en la prueba como
    referencia) reproduce el cobro de produccion y la nueva da el debido: +78.900, +78.900, +93.900, −8.000
    de diferencia respectivamente

- [ ] **T7: Pedidos que vuelven solos al siguiente corte**
  * Requisitos cubiertos: RF_06, RF_07
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `pendingDeltaOrders(input)` (§3.5): pedidos de algun corte del domiciliario, en ningun corte suyo
    pendiente, con `debido − Σ cargos + retencion ≠ 0`
  * Verificacion: pruebas: KNT-005724 sintetico (recaudo que cambia de tienda sin asiento nuevo del
    domiciliario) entra; un pedido en corte pendiente no entra; un pedido retenido no entra; una vez cobrado
    deja de entrar

- [ ] **T8: Retenciones y compensacion**
  * Requisitos cubiertos: RF_13, RF_15, RF_16, RF_17
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `computeHolds(...)` con `debidoVisto` (§3.6) y `planDriverCompensation(input)`: por pedido
    retenido, cobrado, debido, diferencia, excluido (y por que), corte donde entraria; total; huella
    determinista del plan. Liberar = retencion a 0 con `releasedBy/releasedAt/compensationId`
  * Verificacion: pruebas: re-entrega de hoy aun sin cortar no queda retenida; recaudo borrado (KNT-007828)
    si; excluidos listados y fuera del total; liberar dos veces no cambia nada; un pedido liberado que vuelve a
    entrar a un corte no se devuelve dos veces

- [ ] **T9: "Recibido" con cortes nuevos**
  * Requisitos cubiertos: RF_11, RF_12
  * Archivos: functions/src/driver-cash-ledger.ts, functions/src/seller-ledger.ts,
    src/lib/driver-cash-ledger.test.ts, src/lib/seller-ledger.test.ts
  * Accion: `isOrderCodSettled(orderId, driverSettlements, codByOrder)` (§3.7) y
    `buildCodReceivedSet(settlements, codByOrder?)`: regla de hoy y, para pedidos con algun corte nuevo, ademas
    todo corte nuevo con cargo > 0 saldado (regla 027) y recaudo vigente ≤ `codSeenCop` del ultimo saldado
  * Verificacion: todas las pruebas existentes de `seller-ledger` sin cambios; nuevas: pedido solo con cortes
    viejos igual que hoy; re-entrega con recaudo nuevo no cuenta hasta saldar; corte saldado en total cuenta
    todas sus asignaciones; guardas 018 y 027 en verde

## Servidor

- [ ] **T10: `settlement-math` delega en el nucleo**
  * Requisitos cubiertos: RF_09, RF_09b
  * Archivos: functions/src/settlement-math.ts, src/lib/settlement-math.test.ts
  * Accion: `computeDriverCashSummary` y la rama `driver` de `settlementTotals` reciben un
    `DriverLedgerContext` y delegan en `computeDriverCorte`; sin contexto lanzan error. Firmas publicas
    conservadas salvo ese parametro
  * Verificacion: pruebas de `settlement-math` ajustadas caso por caso (cada caso que cambia de cifra lleva
    comentario con el porque); prueba nueva de que sin contexto lanza; `npx tsc --noEmit` en `functions/`
    marca los llamadores que faltan (se arreglan en T12-T15)

- [ ] **T11: Leer el contexto del domiciliario**
  * Requisitos cubiertos: RF_04b, RF_05b, RNF_04
  * Archivos: functions/src/driver-ledger-io.ts, src/lib/driver-ledger-io.test.ts
  * Accion: `loadDriverLedgerContext(dbOrTx, driverId)`: cortes `kind == driver && ownerId == driverId`
    (con `updateTime`), `driverLedgerBaselines/{id}` y `driverCashHolds/{id}`; una lectura por coleccion.
    `assertNoCrossedRecalc(before, after, selfId)`: si cambio el `updateTime` de otro corte pendiente,
    `failed-precondition` con `recalculo_cruzado`. Sin foto: error explicito, no regla vieja
  * Verificacion: pruebas con un doble de Firestore: cuenta de lecturas (3 consultas); dos recalculos con el
    mismo contexto viejo → el segundo lanza `recalculo_cruzado`; sin foto lanza

- [ ] **T12: Crear el corte de domiciliario con la regla nueva**
  * Requisitos cubiertos: RF_03, RF_04b, RF_07, RF_09
  * Archivos: functions/src/orders.ts, src/lib/orders-driver-settlement.test.ts
  * Accion: `createSettlement` (kind `driver`): lee el contexto dentro de la transaccion; anade los pedidos
    de `pendingDeltaOrders`; guarda desde la creacion `cashExpectedCop`, `cashCharges`, `creditInCop`,
    `creditOutCop`, `ledgerVersion: 1` y las cifras de `computeDriverCorte`. El asiento de margen sigue usando
    el pago propio del corte
  * Verificacion: prueba de la funcion que arma el documento (sin red): un corte con un pedido de
    `pendingDeltaOrders` lo incluye con cargo negativo; `cashExpectedCop` presente al crear; margen sin cambios

- [ ] **T13: Abonos, pagado y conciliado dentro de la transaccion**
  * Requisitos cubiertos: RF_04, RF_04b, RF_09
  * Archivos: functions/src/orders.ts, src/lib/orders-driver-settlement.test.ts
  * Accion: `recordDriverCashReceipt` y `updateSettlementStatus` calculan con el contexto leido **en** la
    transaccion y aplican `assertNoCrossedRecalc`; un corte `paid`/`reconciled` no recalcula `cashCharges`
    ni sus cifras (solo registra el abono o el estado). Se elimina el calculo previo fuera de la transaccion
    (`cashSummaryBeforeReceipt`)
  * Verificacion: pruebas: abono en corte pendiente recalcula y guarda; corte conciliado conserva sus cifras
    al recibir un abono; recalculo cruzado se rechaza sin escribir

- [ ] **T14: Correcciones: previsualizar lo que se devuelve**
  * Requisitos cubiertos: RF_04, RF_04b, RF_10
  * Archivos: functions/src/order-corrections-plan.ts, functions/src/order-corrections.ts,
    src/lib/order-corrections-plan.test.ts
  * Accion: el recalculo de cortes pendientes de domiciliario usa `computeDriverCorte`; para cada corte
    cerrado que cobro el pedido, `driverNextCorteDeltaCop` y un aviso con la cifra, dentro de la huella del
    plan. `order-corrections.ts` carga el contexto y pone precondicion `lastUpdateTime` sobre los otros
    cortes pendientes del domiciliario
  * Verificacion: pruebas: entregado→fallido con corte conciliado muestra el delta exacto y no toca ese corte;
    con corte pendiente lo recalcula; lo previsualizado y lo aplicado tienen la misma huella

- [ ] **T15: El informe de efectivo de la 026 sin el parche T25**
  * Requisitos cubiertos: RF_09, RF_12
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts, src/lib/spec-026-guards.test.ts
  * Accion: se quita `belongsHere` y se usa `computeDriverCorte` con el contexto de cada domiciliario
  * Verificacion: la prueba de identidad de reconciliacion de la 026 se reescribe con la regla nueva y cierra
    (no se relaja); guarda 026 en verde (si una cuenta congelada cambia, se anota el porque en la guarda)

- [ ] **T16: Los llamadores de "recibido" pasan el recaudo por pedido**
  * Requisitos cubiertos: RF_11, RF_12
  * Archivos: functions/src/seller-balance.ts, functions/src/store-api.ts, functions/src/store-api-orders.ts,
    functions/src/cash-outstanding-api.ts, functions/src/orders.ts, src/lib/store-api-orders.test.ts
  * Accion: cada llamador de `buildCodReceivedSet` le pasa `codByOrder` con los asientos de recaudo que ya
    lee; la liquidacion de proveedor lee los de los pedidos que va a pagar
  * Verificacion: `npx tsc --noEmit` en `functions/` limpio; pruebas de `store-api-orders` y `seller-ledger` en
    verde; ningun llamador sin `codByOrder` (lo comprueba la guarda de T22)

## Cliente

- [ ] **T17: La app pinta las cifras guardadas**
  * Requisitos cubiertos: RF_09b, RF_11
  * Archivos: src/lib/finance.ts, src/lib/finance.test.ts, src/components/operations-app.tsx
  * Accion: `calculateDriverSettlementFinancials` devuelve las cifras guardadas cuando el corte trae
    `cashCharges`; si no, la copia de hoy sin tocar. `operations-app.tsx` pasa `codByOrder` a
    `buildCodReceivedSet` (2 sitios)
  * Verificacion: pruebas de `finance`: corte nuevo devuelve exactamente lo guardado; corte viejo igual que
    hoy; `npm run lint` sin errores; la cuenta congelada de la guarda 026 no cambia

## Datos, scripts y guardas

- [ ] **T18: Reglas de Firestore para la foto y las retenciones**
  * Requisitos cubiertos: RF_05b, RF_17
  * Archivos: firestore.rules, src/lib/spec-038-rules.test.ts
  * Accion: `driverLedgerBaselines` y `driverCashHolds`: lectura solo admin, escritura nadie desde cliente
  * Verificacion: prueba de fuente sobre `firestore.rules` (mismo patron que las guardas existentes): ambos
    `match` existen, `allow write: if false`, `allow read` solo con `isAdmin()`

- [ ] **T19: Script de la foto historica (en seco por defecto)**
  * Requisitos cubiertos: RF_05b, RF_17
  * Archivos: scripts/snapshot-038-baseline.js, functions/src/driver-cash-ledger.ts
  * Accion: usa `rebuildHistoricalCharges` y `computeHolds` de `functions/lib`; sin flags imprime lo que
    escribiria (cortes, pedidos, retenciones, total); con `--write --approved-by "<nombre>"` escribe un
    documento por domiciliario y aborta si las retenciones no coinciden con la medicion del momento
  * Verificacion: corrida en seco contra produccion (solo lectura): 16 retenciones y $694.200 para
    `driver-1778271901513`, 0 para el resto; la salida se guarda como evidencia. **No** se corre con `--write`

- [ ] **T20: Script de compensacion (previsualizar y, con aprobacion, aplicar)**
  * Requisitos cubiertos: RF_13, RF_14, RF_15, RF_16
  * Archivos: scripts/compensate-038.js, src/lib/driver-cash-ledger.cases.test.ts
  * Accion: previsualiza con `planDriverCompensation`; con `--apply --approved-by --reason --exclude` escribe
    la liberacion de retenciones y un registro de auditoria en una transaccion con la huella del plan; si los
    datos cambiaron, aborta. No toca cortes
  * Verificacion: la previsualizacion en seco solo puede correr tras la foto, asi que aqui se verifica con
    una prueba del armado del plan sobre los fixtures de T6 (opcion A: $640.200 sin KNT-005724/006347).
    **No** se corre con `--apply`

- [ ] **T21: El script de medicion usa el modulo y comprueba antes de desplegar**
  * Requisitos cubiertos: RF_05b, RNF_01
  * Archivos: specs/038_measure.js
  * Accion: quita su copia de la regla e importa `rebuildHistoricalCharges` y `orderOwedByDriver` de
    `functions/lib`; `--check` falla si un solo pedido con asignacion no reconstruye su cifra;
    `--deploy-check` compara, para cada corte pendiente y el siguiente de cada domiciliario, esperado viejo
    vs. nuevo con las retenciones que escribiria la foto, y el conjunto de "recibidos" viejo vs. nuevo
  * Verificacion: contra produccion (solo lectura): mismo resultado de hoy (694.202 / 694.200, 0 cortes sin
    cuadrar), `--check` en verde y `--deploy-check` con ambas diferencias en 0 (si no, la cifra va al
    responsable). Salidas guardadas como evidencia

- [ ] **T22: Guardas de fuente y suite completa**
  * Requisitos cubiertos: RF_09, RF_12, RF_05b
  * Archivos: src/lib/spec-038-guards.test.ts
  * Accion: guardas: fuera de `driver-cash-ledger.ts` nadie suma `cod_revenue`/`cod_remittance` contra
    `driver_earning` para decidir el efectivo de un corte; `settlement-math.ts` delega; todo llamador de
    `buildCodReceivedSet` pasa `codByOrder`; el script de medicion importa el modulo
  * Verificacion: `npx tsc --noEmit` raiz y `functions/`, `npx vitest run` y `npm run lint` en verde; guardas
    018, 026, 027 y 038 en verde

## Cobertura de requisitos

| Requisito | Tareas |
|---|---|
| RF_01 | T1, T5 |
| RF_02 | T1, T3 |
| RF_03 | T3, T12 |
| RF_04 | T13, T14 |
| RF_04b | T11, T12, T13, T14 |
| RF_05 | T2 |
| RF_05b | T2, T6, T11, T18, T19, T21, T22 |
| RF_06 | T7 |
| RF_07 | T7, T12 |
| RF_08 | T4, T5 |
| RF_09 | T10, T12, T13, T15, T22 |
| RF_09b | T3, T4, T10, T17 |
| RF_10 | T14 |
| RF_11 | T9, T16, T17 |
| RF_12 | T9, T15, T16, T22 |
| RF_13 | T8, T20 |
| RF_14 | T20 |
| RF_15 | T8, T20 |
| RF_16 | T8, T20 |
| RF_17 | T8, T18, T19 |
| RNF_01 | T21 |
| RNF_02 | T5 |
| RNF_03 | T6 |
| RNF_04 | T11 |

Ningun requisito huerfano. Fuera de las tareas, porque son escrituras en produccion que aprueba el
responsable: correr T19 con `--write`, aprobar la cifra de `--deploy-check`, desplegar (reglas → foto →
functions → hosting) y correr T20 con `--apply`.
