# Tareas — Spec 026: efectivo que no llega a un corte

Plan: `specs/026_plan.md`. Diseno: `specs/design/026_efectivo_que_no_llega_a_un_corte/`.
Cada tarea empieza por una prueba que falla (RED). Vitest solo recoge `src/**/*.test.ts`; el codigo de
`functions/src` se prueba importando `../../functions/src/<modulo>`.

- [ ] **T1: Extraer la formula de "por cobrar al domiciliario"**
  * Requisitos cubiertos: RNF_02
  * Archivos: functions/src/driver-receivable.ts, functions/src/platform-position.ts, src/lib/driver-receivable.test.ts
  * Accion: `computeDriverReceivable(settlements, codEntries, driverEarnings)` puro con la formula exacta de
    `driverReceivableCop` (pendiente en cortes + max(0, COD fuera de cortes − pago fuera de cortes));
    `computePlatformPosition` delega en ella sin cambiar ninguna cifra.
  * Verificacion: `src/lib/driver-receivable.test.ts` y `src/lib/platform-position.test.ts` en verde; mismas
    cifras antes y despues con los fixtures de la posicion.

- [ ] **T2: Esquemas y ajustes de alerta**
  * Requisitos cubiertos: RF_04
  * Archivos: functions/src/cash-outstanding-schemas.ts, src/lib/cash-outstanding-schemas.test.ts
  * Accion: Zod para la entrada del callable (`driverId` opcional, `.strict()`), para `settings/cashAlerts`
    (`overdueDays` entero 1..120 por defecto 7; `notifyMinCop` entero >= 0 por defecto 20.000) y para los
    documentos leidos (pedido, corte de domiciliario, asiento). `readCashAlertSettings(raw)` devuelve los
    defectos ante un documento ausente o invalido e indica que lo era.
  * Verificacion: `src/lib/cash-outstanding-schemas.test.ts`: defectos, rechazo de 0, de decimales y de claves
    extra; documento invalido → defectos con `invalid: true`.

- [ ] **T3: Filas del informe (nucleo puro)**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_07
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts
  * Accion: `buildCashOutstandingReport(input)` con `buildCodReceivedSet` importado de `./seller-ledger`;
    filas con lider, mensajero, tienda, `deliveredAt` (closedAt → evidencia delivery → asiento cod_revenue →
    updatedAt, con su fuente), `ageDays`, `isOverdue` (`ageDays > overdueDays`), recaudo, pago, esperado,
    recibido, pendiente, `location` y `settlementIds`. Sin filtro de fecha.
  * Verificacion: `src/lib/cash-outstanding.test.ts`: aparece ⇔ `!isSellerEntryEligible`; dia 7 al dia, dia 8
    vencido; pedido de 2026-06-01 aparece con 123 dias a 2026-10-02; parcial cuenta lo que falta; $1 aparece
    con $0; las cuatro fuentes de fecha.

- [ ] **T4: Agrupaciones, proveedor, alcance y conciliacion**
  * Requisitos cubiertos: RF_06, RF_08, RNF_02
  * Archivos: functions/src/cash-outstanding.ts, src/lib/cash-outstanding.test.ts
  * Accion: `byLeader` (con grupo "sin lider"), `bySupplier` y `supplierWithheld` (product_cost sin
    `supplierSettlementId`), totales; alcance de lider sin desglose de proveedor; `reconciliation` con
    `computeDriverReceivable` y causas, solo para admin sin filtro.
  * Verificacion: `src/lib/cash-outstanding.test.ts`: lider solo ve lo suyo y sin proveedor; `deltaCop === 0`
    sin causas; con cada causa sembrada `unexplainedCop === 0` y la causa nombra sus pedidos.

- [ ] **T5: Composicion del aviso**
  * Requisitos cubiertos: RF_05
  * Archivos: functions/src/cash-overdue-notice.ts, src/lib/cash-overdue-notice.test.ts
  * Accion: `selectNoticeCandidates(report, alreadyNotified, settings)` (vencido, `outstandingCop >=
    notifyMinCop`, no avisado) y `composeOverdueNotice(candidates, now)`: un mensaje agrupado por lider, "Sin
    lider" aparte, sin datos del cliente final, truncado a 2.000 caracteres conservando el total.
  * Verificacion: `src/lib/cash-overdue-notice.test.ts`: umbral, una vez por pedido, agrupacion, sin lider,
    truncado con "y N pedidos mas".

- [ ] **T6: Canal de aviso por webhook**
  * Requisitos cubiertos: RF_05
  * Archivos: functions/src/ops-notify.ts, src/lib/ops-notify.test.ts
  * Accion: `sendOpsNotice(text, { url, fetchImpl })` con `fetch` nativo; POST JSON con `content` y `text`
    (Discord, Slack y Google Chat); devuelve `{ ok, status, error? }`; sin URL devuelve
    `{ ok: false, error: "no_channel" }` sin llamar a la red; nunca lanza.
  * Verificacion: `src/lib/ops-notify.test.ts` con un `fetch` falso: 2xx → ok; 500 → no ok con estado;
    excepcion de red → no ok con mensaje; sin URL → no_channel sin llamada.

- [ ] **T7: Callables y aviso programado**
  * Requisitos cubiertos: RF_04, RF_05, RF_06, RF_07, RNF_01
  * Archivos: functions/src/cash-outstanding-api.ts, functions/src/index.ts, src/lib/spec-026-guards.test.ts
  * Accion: `loadCashOutstandingInput(db, scope, now)` (consultas sin rango de fecha, `select`, lotes de 30
    para asientos, nombres por `getAll`, documentos invalidos a `unreadable*`); callables
    `getCashOutstanding` (admin o lider; el lider por claim) y `updateCashAlertSettings` (solo admin, Zod,
    auditoria); `notifyOverdueCash` diaria 08:00 Bogota que marca `cashOverdueNotices` solo tras un envio
    ok y registra `cashOverdueRuns`. Exportar en `index.ts`.
  * Verificacion: `src/lib/spec-026-guards.test.ts`: importa `buildCodReceivedSet`; la consulta de pedidos
    no filtra por fecha ni tiene `limit`; el lider toma `driverId` del claim; la escritura de avisos va
    despues de comprobar `ok`; sin `catch` vacio; las tres funciones exportadas.

- [ ] **T8: Envoltorios de cliente y modelo de vista**
  * Requisitos cubiertos: RF_02, RF_03, RF_06
  * Archivos: src/lib/firebase/auth.ts, src/lib/types.ts, src/lib/cash-outstanding-view.ts, src/lib/cash-outstanding-view.test.ts
  * Accion: `fetchCashOutstanding(driverId?)` y `updateCashAlertSettings(settings)`; tipos reexportados por
    `import type`; `buildCashOutstandingView(report)` puro: grupos ordenados por vencido, primer grupo con
    vencido desplegado, paginas (6 movil, 25 escritorio), etiquetas de ubicacion y "aprox.", tarjeta de
    Operacion (total vencido, lider con mas vencidos, mas antiguo; "al dia" con $0).
  * Verificacion: `src/lib/cash-outstanding-view.test.ts`: orden, plegado, paginas, etiquetas y tarjeta en $0.

- [ ] **T9: Interfaz del administrador**
  * Requisitos cubiertos: RF_02, RF_03, RF_04, RF_08
  * Archivos: src/components/cash-outstanding-admin.tsx, src/components/operations-app.tsx, src/lib/spec-026-guards.test.ts
  * Accion: segun `specs/design/026_*`: tarjeta "Efectivo vencido" en Operacion, pestana "Efectivo sin
    llegar" en Liquidaciones (franja de cifras, filtro por lider, grupos, filas, detalle, cuadre plegado,
    proveedor retenido), dialogo "Plazo y aviso", estados cargando, vacio, error e ilegibles; linea "No se
    puede pagar todavia" en la tarjeta de proveedor de Por pagar.
  * Verificacion: guardas en `src/lib/spec-026-guards.test.ts` (la UI solo consume el callable, sin
    `buildCodReceivedSet` en componentes; los textos y regiones del diseno existen); `npm run lint` sin errores.

- [ ] **T10: Interfaz del lider logistico**
  * Requisitos cubiertos: RF_06
  * Archivos: src/components/cash-outstanding-leader.tsx, src/components/operations-app.tsx, src/lib/spec-026-guards.test.ts
  * Accion: panel "Efectivo sin llegar a Kentro" en Finanzas del lider (complementa "Pendiente por
    entregar"), con sus estados al dia, cargando y error.
  * Verificacion: guardas en `src/lib/spec-026-guards.test.ts` (el panel no envia `driverId`; textos del
    diseno); `npm run lint` sin errores.

- [ ] **T11: Guion de verificacion contra produccion**
  * Requisitos cubiertos: RNF_01, RNF_02, RF_07
  * Archivos: scripts/verify-026.js, docs/rendimiento.md, src/lib/spec-026-guards.test.ts
  * Accion: guion de solo lectura con `baseline` (cuentas, fuentes de fecha, neto <= 0), `query-check`
    (consultas exactas del cargador) y `compare` (24 pedidos de mas de 30 dias, recaudo total,
    `unexplainedCop === 0`); lecturas por llamada y umbral de la Fase 2 en `docs/rendimiento.md`.
  * Verificacion: guarda en `src/lib/spec-026-guards.test.ts` (el guion no escribe: sin `set(`, `update(`,
    `delete(`, `batch`); ejecucion `node scripts/verify-026.js baseline` sin errores.

## Cobertura RF → tarea

| Requisito | Tareas |
|---|---|
| RF_01 | T3 |
| RF_02 | T3, T8, T9 |
| RF_03 | T3, T8, T9 |
| RF_04 | T2, T7, T9 |
| RF_05 | T5, T6, T7 |
| RF_06 | T4, T7, T8, T10 |
| RF_07 | T3, T7, T11 |
| RF_08 | T4, T9 |
| RNF_01 | T7, T11 |
| RNF_02 | T1, T4, T11 |
