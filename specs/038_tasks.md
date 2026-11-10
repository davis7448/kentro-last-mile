# Tareas 038: cada recaudo se le cobra al domiciliario una sola vez

Spec: `specs/038_cada_recaudo_se_cobra_una_vez.md` (aprobada el 2026-11-08). Plan: `specs/038_plan.md`.
Cada tarea se codifica y se prueba en 20-30 minutos. Ninguna tarea despliega ni escribe en produccion: los
scripts de T19 y T20 se construyen y se prueban en seco; ejecutarlos con `--write`/`--apply` lo aprueba el
responsable aparte.

Las pruebas del codigo de `functions/src` viven en `src/lib/*.test.ts`, como en el resto del repo.

**Orden de ejecucion** (no es el numerico): T1, T2, T3, T4, T7, T8, T5, T6, T9, T10, T11, T12, T13, T14, T15,
T16, T17, T18, T19, T20, T21, T22, T23. T5 va despues de T8 porque su generador ejercita la vuelta de pedidos
y las retenciones (analyze M7). La regla vieja convive hasta T22 para que `tsc` y la suite esten en verde al
cerrar **cada** tarea (constitucion §4, analyze B1).

## Nucleo puro: `functions/src/driver-cash-ledger.ts`

- [x] **T1: Tipos y lo que un pedido debe hoy**
  * Requisitos cubiertos: RF_01, RF_02
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: tipos `DriverCashCharge`, `DriverSettlementLedgerFields`, `DriverLedgerBaseline`,
    `DriverCashHolds` (con `releasedCop`), `DriverLedgerContext` (plan §2) y
    `orderOwedByDriver(entries, driverId)` (§3.1): por pedido, recaudo vigente (`cod_revenue` +
    `cod_remittance`, de cualquier tienda), pago vigente (`driver_earning` solo de ese domiciliario) y debido
  * Verificacion: `npx vitest run src/lib/driver-cash-ledger.test.ts`: reversa de recaudo resta, pago de otro
    domiciliario no cuenta, pedido con recaudo en dos tiendas suma las dos

- [x] **T2: Reconstruccion historica de un corte viejo**
  * Requisitos cubiertos: RF_05, RF_05b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `rebuildHistoricalCharges(settlement, entriesByOrder, payByOrder)` con la regla validada de
    `specs/038_measure.js` (plan §3.4): asignacion si existe; `min(0, reconstruido)` si el corte tiene
    asignaciones y el pedido no figura; reconstruido si no tiene; asientos cortados por el ultimo recalculo
    (creacion, abonos, pago, conciliacion). Devuelve `source: "allocation" | "rebuilt"` por pedido
  * Verificacion: pruebas sinteticas **por pedido**: cada pedido con asignacion reconstruye su `expectedCop`;
    un corte con asignaciones que no lista un pedido da `min(0, …)` (forma del caso KNT-000056); un asiento
    posterior al ultimo recalculo no cuenta. Los datos reales van en T6

- [x] **T3: El cargo de un corte**
  * Requisitos cubiertos: RF_02, RF_03, RF_09b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `computeDriverCorte(input)` sin saldo a favor todavia: `registrado(o, X)` desde `cashCharges`
    de los otros cortes o desde la foto (§3.2); `cargo = debido − registrado + retencion`; `pago_X` = solo
    los asientos del propio corte; `recaudo_X = cargo + pago_X` (§3.3). Un `DriverCashCharge` por pedido de
    `orderIds`, incluidos los de 0 y los negativos, sin recortar. `feesCop` solo de pedidos que entran por un
    asiento propio; `platformMarginCop = feesCop − driverPayCop` (tabla de §3.3, analyze B4)
  * Verificacion: pruebas: pedido en dos cortes cobra una sola vez; pago descontado en otro corte no se
    descuenta dos veces; ningun pedido con dos montos; `recaudo − pago = Σ cargos`; un pedido que entra sin
    asiento propio aporta 0 a fletes y margen

- [x] **T4: Saldo a favor, neto y reparto de lo recibido**
  * Requisitos cubiertos: RF_08, RF_09b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `creditoEntrada = Σ creditOut − Σ creditIn` de los demas cortes (puede ser negativo);
    `bruto = Σ cargos − creditoEntrada`; `esperado = max(0, bruto)`; `creditoSalida = max(0, −bruto)`;
    `netCop = grossNetCop = −esperado`, `gmfCop = 0` (tabla de §3.3). `cashAllocations` reparte el efectivo
    recibido entre los pedidos con cargo > 0, en el orden de hoy (creacion, tracking), con los campos que leen
    la 026 y la 027
  * Verificacion: pruebas: devolucion mayor que lo debido → esperado 0, neto 0 y credito de salida exacto; el
    siguiente corte lo consume una vez; un corte pendiente que reduce su credito despues deja la deuda en el
    siguiente; las asignaciones suman lo recibido

- [x] **T5: Prueba de propiedad** *(se ejecuta despues de T8)*
  * Requisitos cubiertos: RF_01, RF_08, RNF_02
  * Archivos: src/lib/driver-cash-ledger.property.test.ts
  * Accion: LCG con semilla fija (sin dependencia nueva) que genera secuencias por pedido: entrega, visita
    fallida, correccion entregado→fallido con corte cerrado o pendiente, recaudo borrado, re-entrega, cambio
    de tienda, abonos parciales, cortes recalculados en distinto orden, retenciones y liberacion
  * Verificacion: `npx vitest run src/lib/driver-cash-ledger.property.test.ts`: tras cada paso, para todo
    pedido `Σ cargos = debido + retencion`, y `esperado + creditoEntrada − creditoSalida = Σ cargos`; 500
    secuencias, mismo resultado en dos corridas

- [x] **T6: Casos reales como fixtures**
  * Requisitos cubiertos: RNF_03, RF_05, RF_05b
  * Archivos: specs/038_measure.js, src/lib/fixtures/038-knt-003259.json, src/lib/fixtures/038-knt-004540.json,
    src/lib/fixtures/038-knt-002682.json, src/lib/fixtures/038-knt-002965.json,
    src/lib/fixtures/038-driver-16.json, src/lib/driver-cash-ledger.cases.test.ts,
    functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts (ampliado en T6: ver §3.6 del plan)
  * Accion: opcion `--fixtures <dir>` del script de medicion (solo lectura) que vuelca cortes y asientos
    **anonimizados** (sin telefono, direccion ni nombre; quedan ids y tracking): los cuatro casos y un fixture
    con los 16 pedidos de §1 mas el corte del 2026-05-29 (KNT-000056) (analyze B3, M15)
  * Verificacion: `npx vitest run src/lib/driver-cash-ledger.cases.test.ts`: en los cuatro casos la regla vieja
    (copiada en la prueba como referencia) reproduce el cobro de produccion y la nueva da el debido (+78.900,
    +78.900, +93.900, −8.000 de diferencia); en el fixture de 16, las 16 filas de §1 (cobrado, debido,
    diferencia; total +686.200 en la medicion del 2026-11-09, ver nota de T6) y cada pedido con asignacion reconstruye su `expectedCop`

- [x] **T7: Pedidos que vuelven solos al siguiente corte**
  * Requisitos cubiertos: RF_06, RF_07
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `pendingDeltaOrders(input)` (§3.5): pedidos de algun corte del domiciliario, en ningun corte suyo
    pendiente, con `debido − Σ cargos + retencion ≠ 0`
  * Verificacion: pruebas: recaudo que cambia de tienda sin asiento nuevo del domiciliario (forma de
    KNT-005724) entra; un pedido en corte pendiente no entra; uno retenido no entra; una vez cobrado deja de
    entrar

- [x] **T8: Retenciones y compensacion**
  * Requisitos cubiertos: RF_13, RF_14, RF_15, RF_16, RF_17
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `computeHolds(...)` con `debidoVisto` (§3.6); `planDriverCompensation(input)`: por pedido
    retenido, cobrado, debido, diferencia, excluido (y por que), corte donde entraria; total; huella
    determinista. `applyCompensationPlan(holds, plan, approval)` puro: filas liberadas con `releasedCop`,
    `releasedBy`, `releasedAt`, `compensationId`, y el registro de auditoria (autor, motivo, huella, filas)
  * Verificacion: pruebas: re-entrega de hoy aun sin cortar no queda retenida; recaudo borrado (forma de
    KNT-007828) si; excluidos listados y fuera del total; aplicar con una huella distinta lanza; aplicar dos
    veces no cambia nada; un pedido liberado que vuelve a entrar a un corte no se devuelve dos veces

- [x] **T9: "Recibido" con cortes nuevos**
  * Requisitos cubiertos: RF_11, RF_12
  * Archivos: functions/src/driver-cash-ledger.ts, functions/src/seller-ledger.ts,
    src/lib/driver-cash-ledger.test.ts, src/lib/seller-ledger.test.ts
  * Accion: `isOrderCodSettled(orderId, driverSettlements, codEntriesByOrder)` (§3.7, comparacion por
    **tiempo**) y `buildCodReceivedSet(settlements, codByOrder?)`: regla de hoy y, para pedidos con algun corte
    nuevo, ademas todo corte nuevo con cargo > 0 saldado (regla 027) y ningun recaudo posterior al ultimo
    recalculo del ultimo corte saldado que lo tiene
  * Verificacion: todas las pruebas existentes de `seller-ledger.test.ts` (incluidas las de la 027) sin
    cambios; nuevas: pedido solo con cortes viejos igual que hoy; re-entrega con recaudo nuevo no cuenta hasta
    saldar; el caso A cobra → B devuelve y se salda → re-entrega del mismo monto **no** cuenta (analyze B5);
    corte saldado en total cuenta todas sus asignaciones

## Servidor

- [x] **T10: `settlement-math` expone la regla nueva**
  * Requisitos cubiertos: RF_09, RF_09b
  * Archivos: functions/src/settlement-math.ts, src/lib/settlement-math.test.ts
  * Accion: `computeDriverCorteSummary(inputs, orderIds, receivedCop, context)` con contexto **obligatorio**,
    que delega en `computeDriverCorte`. `computeDriverCashSummary` y la rama `driver` vieja de
    `settlementTotals` **no se tocan** todavia: sus llamadores se migran en T12-T16 y se borran en T22
  * Verificacion: pruebas nuevas en `settlement-math.test.ts` (cifras de la tabla de §3.3); las existentes
    sin cambios; `npx tsc --noEmit` en `functions/` limpio

- [x] **T11: Leer el contexto del domiciliario**
  * Requisitos cubiertos: RF_04b, RF_05b, RNF_04
  * Archivos: functions/src/driver-ledger-io.ts, src/lib/driver-ledger-io.test.ts
  * Accion: `loadDriverLedgerContext(dbOrTx, driverId)`: cortes `kind == driver && ownerId == driverId`
    (con `updateTime`), `driverLedgerBaselines/{id}` y `driverCashHolds/{id}`; una lectura por coleccion.
    `assertNoCrossedRecalc(before, after, selfId)` (plan §1, "que es antes"): si cambio el `updateTime` de otro
    corte pendiente, `failed-precondition` con `recalculo_cruzado`. Sin foto: error explicito
  * Verificacion: pruebas con un doble de Firestore: 3 consultas; dos recalculos con el mismo contexto de
    fuera → el segundo lanza `recalculo_cruzado`; sin foto lanza

- [x] **T12: Crear el corte de domiciliario con la regla nueva**
  * Requisitos cubiertos: RF_03, RF_04b, RF_07, RF_09
  * Archivos: functions/src/driver-cash-ledger.ts, functions/src/orders.ts, src/lib/driver-cash-ledger.test.ts
  * Accion: `buildDriverSettlementFields(input)` puro en el nucleo (analyze M5). `createSettlement` (kind
    `driver`): lee el contexto fuera y dentro de la transaccion, aplica `assertNoCrossedRecalc`, anade los
    pedidos de `pendingDeltaOrders` y escribe lo que devuelve el constructor (`cashExpectedCop`, `cashCharges`,
    `creditInCop`, `creditOutCop`, `ledgerVersion: 1`, cifras de §3.3). Acepta un corte formado solo por
    pedidos de `pendingDeltaOrders` (analyze M6)
  * Verificacion: pruebas del constructor: un pedido de `pendingDeltaOrders` entra con cargo negativo;
    `cashExpectedCop` presente al crear; margen igual que hoy en un corte normal; corte solo de devoluciones
    valido. `npx tsc --noEmit` en `functions/` limpio

- [x] **T13: Abonos, pagado y conciliado dentro de la transaccion**
  * Requisitos cubiertos: RF_04, RF_04b, RF_09
  * Archivos: functions/src/driver-cash-ledger.ts, functions/src/orders.ts, src/lib/driver-cash-ledger.test.ts,
    src/lib/driver-ledger-io.test.ts, functions/src/driver-ledger-io.ts (anadido en T13: el recalculo dentro de la
    transaccion es E/S y se prueba con el doble de T11)
  * Accion: `recordDriverCashReceipt` y `updateSettlementStatus` calculan con `buildDriverSettlementFields` y
    el contexto leido **en** la transaccion, comparado con el de fuera; un corte `paid`/`reconciled` no
    recalcula `cashCharges` ni sus cifras. Se elimina `cashSummaryBeforeReceipt`
  * Verificacion: pruebas: abono en corte pendiente recalcula; un corte conciliado conserva sus cifras al
    recibir un abono; con el doble de T11, un recalculo cruzado lanza y no llama a `set`

- [x] **T14: Correcciones: previsualizar lo que se devuelve**
  * Requisitos cubiertos: RF_04, RF_04b, RF_10
  * Archivos: functions/src/order-corrections-plan.ts, functions/src/order-corrections.ts,
    src/lib/order-corrections-plan.test.ts, functions/src/driver-ledger-io.ts, src/lib/driver-ledger-io.test.ts
    (anadidos en T14: la callable necesita las referencias de los otros cortes pendientes para la precondicion)
  * Accion: el recalculo de cortes pendientes de domiciliario usa `computeDriverCorteSummary`; para cada corte
    cerrado que cobro el pedido, `driverNextCorteDeltaCop` y un aviso con la cifra, dentro de la huella del
    plan. `order-corrections.ts` carga el contexto y pone precondicion `lastUpdateTime` sobre los otros
    cortes pendientes del domiciliario
  * Verificacion: pruebas: entregado→fallido con corte conciliado muestra el delta exacto y no toca ese corte;
    con corte pendiente lo recalcula; previsualizado y aplicado tienen la misma huella

- [x] **T15: El informe de efectivo de la 026 sin el parche T25**
  * Requisitos cubiertos: RF_09, RF_12
  * Archivos: functions/src/cash-outstanding.ts, functions/src/cash-outstanding-api.ts,
    src/lib/cash-outstanding.test.ts, src/lib/cash-outstanding-loads.test.ts, src/lib/spec-026-guards.test.ts,
    src/lib/cash-outstanding-view.ts, functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts (anadidos en
    T15: las etiquetas de las causas nuevas, y `isOrderCashSettledInCorte` para no copiar la regla de recibido)
  * Accion: se quita `belongsHere` y se usa `computeDriverCorteSummary`; `cash-outstanding-api.ts` carga el
    contexto de cada domiciliario (analyze M1)
  * Verificacion: la prueba de identidad de reconciliacion de la 026 se reescribe con la regla nueva y cierra
    (no se relaja); guarda 026 en verde (si una cuenta congelada cambia, se anota el porque en la guarda)

- [x] **T16: Los llamadores de "recibido" pasan el recaudo por pedido**
  * Requisitos cubiertos: RF_11, RF_12
  * Archivos: functions/src/seller-balance.ts, functions/src/store-api.ts, functions/src/store-api-orders.ts,
    functions/src/cash-outstanding.ts, functions/src/cash-outstanding-api.ts, functions/src/orders.ts,
    src/lib/store-api-orders.test.ts, src/lib/seller-balance.test.ts, src/lib/cash-outstanding-loads.test.ts,
    functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts, src/lib/cash-outstanding.test.ts (anadidos al
    ejecutar: `codEntriesByOrder` y `codPartialReceivedCop` tambien llaman a la regla, y el informe de la 026 se
    prueba en su propio archivo; `cash-outstanding-loads.test.ts` es la cache del cliente y no se toca)
  * Accion: cada llamador de `buildCodReceivedSet` le pasa `codByOrder` con los asientos de recaudo que ya
    lee; la liquidacion de proveedor lee los de los pedidos que va a pagar (analyze M1, M4)
  * Verificacion: `npx tsc --noEmit` en `functions/` limpio; `store-api-orders`, `seller-balance`,
    `cash-outstanding-loads` y `seller-ledger` en verde

## Cliente

- [x] **T17: La app pinta las cifras guardadas**
  * Requisitos cubiertos: RF_09b, RF_11
  * Archivos: src/lib/finance.ts, src/lib/finance.test.ts, src/components/operations-app.tsx,
    src/lib/types.ts, src/lib/driver-settlement-export.ts (anadidos al ejecutar: los campos nuevos del corte en
    el tipo `Settlement`, y el saldo que trae de otros cortes en el aviso del detalle, sin el cual las filas no
    suman la cabecera)
  * Accion: `calculateDriverSettlementFinancials` devuelve las cifras guardadas cuando el corte trae
    `cashCharges`, y sus filas por pedido leen `cashCharges` (con los negativos), no `cashAllocations`
    (analyze M16); si no hay `cashCharges`, la copia de hoy sin tocar. `operations-app.tsx` pasa `codByOrder`
    a `buildCodReceivedSet` (2 sitios)
  * Verificacion: pruebas de `finance.test.ts`: corte nuevo devuelve exactamente lo guardado y una devolucion
    se pinta negativa; corte viejo igual que hoy; `npm run lint` sin errores; guarda 026 en verde

## Datos, scripts y guardas

- [x] **T18: Reglas de Firestore para la foto y las retenciones**
  * Requisitos cubiertos: RF_05b, RF_17
  * Archivos: firestore.rules, src/lib/spec-038-rules.test.ts
  * Accion: `driverLedgerBaselines` y `driverCashHolds`: lectura solo admin, escritura nadie desde cliente
  * Verificacion: prueba de fuente sobre `firestore.rules`: ambos `match` existen, `allow write: if false`,
    `allow read` solo con la funcion de admin que ya usan las reglas

- [x] **T19: Script de la foto historica (en seco por defecto)**
  * Requisitos cubiertos: RF_05b, RF_17
  * Archivos: scripts/snapshot-038-baseline.js, src/lib/snapshot-038-baseline.test.ts,
    functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts, src/lib/driver-cash-ledger.cases.test.ts,
    functions/src/cash-outstanding.ts (anadidos al ejecutar: la derivacion de la foto y las retenciones pasa a una
    funcion pura del nucleo, `buildDriverLedgerSnapshot`, que usan el script y el informe de la 026 en vez de
    tener cada uno su copia)
  * Accion: usa `rebuildHistoricalCharges` y `computeHolds` de `functions/lib` (tras `cd functions && npm
    run build`); sin flags imprime lo que escribiria (cortes, pedidos, retenciones, total); con `--write
    --approved-by "<nombre>"` escribe un documento por domiciliario y aborta si las retenciones no coinciden
    con la medicion del momento (`--expect-total <cop> --expect-orders <n>`, las cifras que la medicion de ese
    dia imprime); escribe con `create`, asi que nunca pisa una foto existente
  * Verificacion: corrida en seco contra produccion (solo lectura): 16 retenciones y la cifra de la medicion de ese dia ($686.200 el 2026-11-09) para
    `driver-1778271901513`, 0 para el resto; la salida se guarda como evidencia. **No** se corre con `--write`

- [x] **T20: Script de compensacion (previsualizar y, con aprobacion, aplicar)**
  * Requisitos cubiertos: RF_13, RF_14, RF_15, RF_16
  * Archivos: scripts/compensate-038.js, src/lib/driver-cash-ledger.cases.test.ts, src/lib/compensate-038.test.ts
    (anadido al ejecutar: las pruebas del propio script, con un doble de la transaccion)
  * Accion: previsualiza con `planDriverCompensation`; con `--apply --approved-by --reason --exclude` corre
    `applyCompensationPlan` dentro de una transaccion que recalcula la huella y aborta si difiere. No toca
    cortes
  * Verificacion: prueba sobre `038-driver-16.json` (analyze B2): la previsualizacion con exclusion de
    KNT-005724 y KNT-006347 da la opcion A ($686.200 − $54.000 = $632.200 con los datos del 2026-11-09), con esos dos listados como pendientes; aplicar sobre
    el fixture libera exactamente esas filas con autor y motivo. **No** se corre con `--apply`

- [x] **T21: El script de medicion usa el modulo y comprueba antes de desplegar**
  * Requisitos cubiertos: RF_05b, RNF_01
  * Archivos: specs/038_measure.js, src/lib/measure-038.test.ts (anadido al ejecutar: las pruebas del script,
    que pasa a exportar sus funciones y solo lee produccion al ejecutarse directamente)
  * Accion: quita su copia de la regla e importa `rebuildHistoricalCharges` y `orderOwedByDriver` de
    `functions/lib`; `--check` falla si un solo pedido con asignacion no reconstruye su cifra;
    `--deploy-check` compara, para cada corte pendiente y el siguiente de cada domiciliario, esperado viejo
    vs. nuevo con las retenciones que escribiria la foto, y el conjunto de "recibidos" viejo vs. nuevo
  * Verificacion: contra produccion (solo lectura): mismo resultado que la medicion del dia (686.202 / 686.200 el 2026-11-09, 0 cortes sin
    cuadrar), `--check` en verde y `--deploy-check` con ambas diferencias en 0 (si no, la cifra va al
    responsable). Salidas guardadas como evidencia

- [x] **T22: Retirar la regla vieja**
  * Requisitos cubiertos: RF_09, RF_12
  * Archivos: functions/src/settlement-math.ts, src/lib/settlement-math.test.ts, scripts/verify-026.js,
    scripts/verify-027.js, functions/src/orders.ts, functions/src/order-corrections-plan.ts, specs/038_measure.js,
    src/lib/cash-outstanding.test.ts, src/lib/spec-026-guards.test.ts (anadidos al ejecutar: `settlementTotals`
    pierde la rama y el parametro de domiciliario, asi que cambian sus dos llamadores; el `--deploy-check` de la
    T21 y los cortes viejos de las pruebas de la 026 necesitan la regla vieja como REFERENCIA de comparacion, que
    pasa a una copia local rotulada; la guarda de la 026 exigia el nombre viejo en `verify-026.js`)
  * Accion: borrar `computeDriverCashSummary` y la rama `driver` vieja de `settlementTotals`; los casos de
    prueba que la ejercitaban se reescriben contra la nueva con un comentario del porque de cada cifra que
    cambia (ninguno se borra sin motivo); los dos scripts de verificacion pasan a la regla nueva y a
    `codByOrder` (analyze B1, M2)
  * Verificacion: `npx tsc --noEmit` raiz y `functions/`, y `npx vitest run` en verde; `node -c` de los dos
    scripts

- [x] **T23: Guardas de fuente y suite completa**
  * Requisitos cubiertos: RF_09, RF_12, RF_05b
  * Archivos: src/lib/spec-038-guards.test.ts, scripts/verify-026.js, specs/038_measure.js (anadidos al ejecutar:
    la guarda encontro cuatro llamadas de `verify-026.js` y una de la medicion sin el recaudo por pedido, que la
    T22 debio cubrir)
  * Accion: guardas: fuera de `driver-cash-ledger.ts` nadie suma `cod_revenue`/`cod_remittance` contra
    `driver_earning` para decidir el efectivo de un corte, con lista blanca y motivo (`finance.ts`,
    `order-export.ts`, `driver-receivable.ts`, analyze M8); `settlement-math.ts` ya no exporta la funcion
    vieja; todo llamador de `buildCodReceivedSet` (codigo y scripts) pasa `codByOrder`; el script de medicion
    importa el modulo
  * Verificacion: `npx tsc --noEmit` raiz y `functions/`, `npx vitest run` y `npm run lint` en verde; guardas
    018, 026 y 038 y pruebas de la 027 (`seller-ledger.test.ts`, `cash-outstanding.test.ts`) en verde

## Enmienda tras la verificacion (2026-11-10)

- [x] **T24: El recaudo solo al que entrega, en el nucleo**
  * Requisitos cubiertos: RF_01b
  * Archivos: functions/src/driver-cash-ledger.ts, src/lib/driver-cash-ledger.test.ts, src/lib/driver-cash-ledger.property.test.ts
  * Accion: `orderOwedByDriver` con `deliveredBy` (plan §7.1) y su paso por `computeDriverCorte`,
    `pendingDeltaOrders`, `computeHolds`, `planDriverCompensation` (fila `otherDriver`, fuera del total),
    `buildDriverLedgerSnapshot` y `driverCorteOrderIdsAtCreation`
  * Verificacion: el escenario H1 (D1 visita fallida, D2 entrega): D1 0 y su pedido no vuelve solo, D2 91.000;
    sin dato o con `driverId` nulo, como hoy; la propiedad de RNF_02 sigue en verde; los casos reales sin cambios

- [ ] **T25: Los llamadores pasan quien entrego**
  * Requisitos cubiertos: RF_01b, RNF_04
  * Archivos: functions/src/orders.ts, functions/src/driver-ledger-io.ts, functions/src/order-corrections.ts,
    functions/src/order-corrections-plan.ts, functions/src/cash-outstanding.ts, scripts/snapshot-038-baseline.js,
    scripts/compensate-038.js, specs/038_measure.js, scripts/verify-026.js, src/lib/driver-ledger-io.test.ts,
    src/lib/order-corrections-plan.test.ts, src/lib/cash-outstanding.test.ts, src/lib/spec-038-guards.test.ts
  * Accion: `orderMeta` con `driverId`; `createSettlement` en dos pasadas para los que vuelven solos (plan §7.1);
    los scripts y el informe con el mapa entero; guarda: todo llamador de `computeDriverCorte` /
    `pendingDeltaOrders` / `orderOwedByDriver` en produccion pasa `deliveredBy`
  * Verificacion: doble de Firestore: `createSettlement` lee solo los candidatos; guarda en verde y vista fallar

- [ ] **T26: Recibido: lo posterior suma cero y la regla de hoy no se sustituye**
  * Requisitos cubiertos: RF_11, RF_11b, RF_12
  * Archivos: functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts
  * Accion: plan §7.2 y §7.3
  * Verificacion: escenarios H2 (cambio de tienda que netea cero: recibido) y H3 (corte viejo pendiente sin
    cubrir: no recibido); B5 sigue sin recibir; las pruebas de la 018 y la 027 sin cambios

- [ ] **T27: Menores de la revision**
  * Requisitos cubiertos: RF_04, RF_05b
  * Archivos: functions/src/orders.ts, scripts/snapshot-038-baseline.js, src/lib/snapshot-038-baseline.test.ts,
    src/lib/driver-cash-ledger.test.ts
  * Accion: plan §7.4
  * Verificacion: conciliar un corte viejo pagado no cambia el orden de sus asignaciones; la foto se niega si no
    cabe en un lote

- [ ] **T28: Medir otra vez y volver a verificar (solo lectura)**
  * Requisitos cubiertos: RNF_01, RF_05b, RF_17
  * Archivos: .sdd/evidence/038_cada_recaudo_se_cobra_una_vez/
  * Accion: `038_measure.js --check --deploy-check`, foto en seco y compensacion previsualizada contra produccion;
    el revisor independiente vuelve a leer el diff de T24-T27
  * Verificacion: las cifras de hoy (686.200, 16 retenciones, opcion A 632.200, diferencia 0) o la diferencia
    explicada pedido a pedido; ningun hallazgo nuevo sin resolver

## Cobertura de requisitos

| Requisito | Tareas |
|---|---|
| RF_01 | T1, T5 |
| RF_02 | T1, T3 |
| RF_03 | T3, T12 |
| RF_04 | T13, T14 |
| RF_04b | T11, T12, T13, T14 |
| RF_05 | T2, T6 |
| RF_05b | T2, T6, T11, T18, T19, T21, T23 |
| RF_06 | T7 |
| RF_07 | T7, T12 |
| RF_08 | T4, T5 |
| RF_09 | T10, T12, T13, T15, T22, T23 |
| RF_09b | T3, T4, T10, T17 |
| RF_10 | T14 |
| RF_01b | T24, T25 |
| RF_11 | T9, T16, T17, T26 |
| RF_11b | T26 |
| RF_12 | T9, T15, T16, T22, T23 |
| RF_13 | T8, T20 |
| RF_14 | T8, T20 |
| RF_15 | T8, T20 |
| RF_16 | T8, T20 |
| RF_17 | T8, T18, T19 |
| RNF_01 | T21 |
| RNF_02 | T5 |
| RNF_03 | T6 |
| RNF_04 | T11 |

Ningun requisito huerfano. Fuera de las tareas, porque son escrituras en produccion o decisiones del
responsable:
- correr T19 con `--write` (la foto);
- aprobar la cifra de `--deploy-check` si no da 0;
- desplegar: reglas → foto → functions → hosting;
- tras desplegar, correr la previsualizacion de compensacion contra produccion (DoD 4, analyze M12);
- correr T20 con `--apply`.

## Analisis (2026-11-08)

Auditor independiente sobre spec, plan y tareas: 5 hallazgos bloqueantes y 16 menores. Corregidos en el plan
y aqui: B1 (orden: la regla vieja convive hasta T22), B2/B3 (fixture de los 16 pedidos), B4 (fletes, margen,
neto y 4x1000 definidos en §3.3), B5 (RF_11 por tiempo, no por monto), M1-M8, M11-M16. M9 y M10 cambiaban
la spec: el responsable los aprobo el 2026-11-09 (RNF_02 con retencion, RF_08 con saldo negativo, RNF_04
ampliado). Veredicto: coherente.
