# Tareas — Spec 019: el corte muestra el mismo dinero que cobra

Plan: `specs/019_plan.md`. Cada tarea: 20–30 min, **prueba que falla primero**.
Evidencia en `.sdd/evidence/019/`.

Orden = orden de la tabla. T1–T4 son puras y aterrizan sin tocar el store. T5 puede ir en paralelo a
T6–T7. T8–T10 dependen de T5 y T7. **T2 es prerrequisito de T8**, no una mejora aparte (plan 2.10).

---

- [x] **T1: Fixture del corte real y la prueba que falla**
  * Requisitos cubiertos: RF_01, RF_02, RF_03
  * Archivos: `src/lib/finance.test.ts`
  * Accion: `describe("spec 019 · detalle del corte")` con el patron del `baseState()` local de
    `finance.test.ts:375-380`. Fixture que reproduce `stl-1789686589616-driver-driver-1778271901513`:
    185 pedidos generados con los agregados reales (`codCop` 15.996.490, `driverPayCop` 1.829.000; 169
    con efectivo, 16 sin recaudo a $8.000 salvo uno a $0), mas un subcaso literal con los seis KNT de
    DANDA (KNT-005077, KNT-005058, KNT-004892, KNT-005064, KNT-005054, KNT-005060). Los asientos
    `cod_revenue` de tienda deben cuadrar con `order.totalCop`.
  * Verificacion: `it("RF_01 · el detalle pinta una fila por pedido del corte")` → 185;
    `it("RF_03 · la suma del detalle iguala la cabecera")` → $14.167.490;
    `it("RF_02 · las visitas sin recaudo suman −$120.000")`. **Las tres en rojo** (hoy dan 185 / no
    cuadra / 0). Guardar la salida en `.sdd/evidence/019/t1-rojo.txt`.

- [x] **T2: Quitar el truncamiento y pasar a `Map`**
  * Requisitos cubiertos: RF_02, RNF_01
  * Archivos: `src/lib/finance.ts:614-651`
  * Accion: `ordersById = new Map(state.orders.map((o) => [o.id, o]))` antes del bucle (plan 2.10) y
    `expectedCashCop: codCop - orderDriverPayCop` **sin `Math.max`** (`:648`). Comentario explicito de
    que `summary.unsettledOrders` (`:679-691`) conserva a proposito su propio `Math.max` (`:688`) y su
    `trackingCode ?? order.id` (`:682`), porque sus pedidos estan descargados por definicion.
  * Verificacion: la 3ª asercion de T1 pasa a verde. La 2ª sigue roja (faltan los 66 pedidos).

- [x] **T3: Escalera de resolucion y respaldo desde `cashAllocations`**
  * Requisitos cubiertos: RF_09, RF_10, RF_06
  * Archivos: `src/lib/finance.ts` (tipos `:382-414`, funcion pura `settlementOrderRow`),
    `src/lib/finance.test.ts`
  * Accion: tipos `DriverSettlementOrderSource` / `DriverSettlementOrderRow` (plan 2.1) y las cuatro
    ramas del plan 2.3. `trackingCode` **cadena vacia** cuando no se conoce, nunca el id interno.
  * Verificacion: cuatro pruebas, una por rama. Pedido ausente con entrada en `cashAllocations` →
    importe del corte y `source "settlement"`; array no vacio sin ese id → `−pago`; corte **sin**
    `cashAllocations` → `amountKnown: false`, fuera de `detailCashCop`. `it("RF_10 · ninguna fila usa
    el id interno como etiqueta")`. La 2ª asercion de T1 pasa a verde (DoD 3, DoD 5).

- [x] **T4: Totales del detalle y motivo de la diferencia**
  * Requisitos cubiertos: RF_03, RF_11, RF_12
  * Archivos: `src/lib/finance.ts:382-393`, `:652-667`, `src/lib/finance.test.ts`
  * Accion: `detailCashCop`, `detailDeltaCop`, `detailStatus`, `unavailableOrderCount`,
    `unknownAmountCount`, `noCollectionCount` (plan 2.4). `detailCashCop` suma **solo** filas con
    importe.
  * Verificacion: `balanced` con el corte completo; pedido reabierto a `retry_pending` tras el corte →
    `"adjusted"` con el delta exacto (DoD 6); corte sin `cashAllocations` → `"incomplete"`.
    **No-regresion:** `pendingBalanceCop`, `incompleteSettlementsCop` y `unsettledCashCop` no cambian
    respecto a las pruebas existentes de `finance.test.ts:375-563`.

- [x] **T5: Modulo puro de presentacion y Excel**
  * Requisitos cubiertos: RF_13, RF_10
  * Archivos: **nuevo** `src/lib/driver-settlement-export.ts`, **nuevo**
    `src/lib/driver-settlement-export.test.ts`, `src/lib/order-export.ts:95` (exportar `statusLabel`),
    `src/components/operations-app.tsx` (quitar `:9824`, `:12388-12409`)
  * Accion: plan 2.5. `UNAVAILABLE_ORDER_LABEL`, `NO_AMOUNT_LABEL`,
    `buildDriverSettlementDetailRows`, `buildDriverSettlementExportRows`,
    `driverSettlementExportColumns` con `no_disponible` y `sin_recaudo`.
    **No tocar `statusLabel` de `operations-app.tsx:539`** — `community-view.test.ts:1786` afirma que
    existe.
  * Verificacion: el Excel se construye **desde** las filas de pantalla, no en paralelo; misma etiqueta
    en ambos; los negativos sobreviven como numero; la columna `efectivo_esperado` suma la cabecera
    (DoD 7).

- [x] **T6: Tope de rescate acumulado por carga de pagina**
  * Requisitos cubiertos: RF_07, RNF_02
  * Archivos: `src/lib/firebase/state-store.ts:97-98`, `:665-687`, **nuevo**
    `src/lib/spec-019-guards.test.ts`
  * Accion: plan 2.9. `slice(0, MAX_PINNED_ORDERS − pinnedRequested.size)`, retorno
    `{ requested, fetched, skippedByBudget }`, comentario actualizado (tope por carga de pagina,
    compartido con la via de la wallet).
  * Verificacion: guarda de fuente con el patron de `spec-018-guards.test.ts:16-35`: el cuerpo de
    `pinOrders` ya **no** contiene `.slice(0, MAX_PINNED_ORDERS)` y **si** la resta contra
    `pinnedRequested.size`; devuelve objeto.

- [x] **T7: Canal `onControls` y cableado hasta el panel**
  * Requisitos cubiertos: RF_05, RF_06
  * Archivos: `src/lib/firebase/state-store.ts:472-477`, `:836`;
    `src/components/operations-app.tsx:417-506`, `:13080`, `:13359`, `:11820`
  * Accion: plan 2.7. Quinto callback **opcional**; **el retorno sigue siendo la desuscripcion**.
    `useAppState` guarda los controles en `useRef` y expone `pinSettlementOrders` (`:506`).
    De paso, corregir el comentario obsoleto de `state-store.ts:544`, que remite a un `pinDriverOrders`
    que no existe desde un renombrado.
  * Verificacion: guardas — la firma declara el quinto callback opcional; `onControls?.(` se invoca una
    vez; `useAppState` lo devuelve; `DriverView` lo reenvia. **DoD 4:** `pinOrders(` tiene ≥2 puntos de
    llamada y al menos uno **fuera** del bloque de `selectUnsettledWalletEntries`. Re-ejecutar sin
    cambios `state-store-targets.test.ts`, `spec-005-guards.test.ts` y `session-hats.test.ts`.

- [x] **T8: Rescate al expandir un corte y estado "completando"**
  * Requisitos cubiertos: RF_05, RF_08
  * Archivos: `src/components/operations-app.tsx:12411-12494`; `state-store.ts:1004-1021` (trocear)
  * Accion: plan 2.6 y 2.8. El manejador de expandir (`:12470-12472`) llama al callback con los ids de
    **ese** corte con `source !== "order"`; `Set<string>` local de cortes en vuelo. Trocear
    `getDocumentsOneByOne` de 30 en 30 (plan 2.11).
  * Verificacion: guardas — llama al expandir, **no** al montar ni sobre `settlementPage.visibleItems`
    (RNF_02); el aviso lleva `aria-live`.

- [x] **T9: Pintado de las filas**
  * Requisitos cubiertos: RF_01, RF_04, RF_10, RNF_03
  * Archivos: `src/components/operations-app.tsx:12480-12494`
  * Accion: plan 2.5 y seccion 4 del plan. Importes negativos en `text-mint` **con la palabra "a
    favor"** (nunca solo color, WCAG 2.2 AA 1.4.1); sin importe → `NO_AMOUNT_LABEL` en `text-ink-60`,
    jamas `$0`; pildoras `Sin recaudo` e `Importe del corte`, de una sola linea; sin `bg-acid`.
  * Verificacion: guardas — el bloque mapea la salida del modulo puro, importa
    `UNAVAILABLE_ORDER_LABEL` en vez de un literal, y **no** contiene `?? order.orderId`. Revisar
    contraste contra `docs/design-system.md`.

- [x] **T10: Aviso de diferencia**
  * Requisitos cubiertos: RF_11, RF_12
  * Archivos: `src/components/operations-app.tsx` (bloque bajo la cabecera del corte)
  * Accion: cuatro ramas — completando / `balanced` / `adjusted` (con el delta y "se liquida la cifra
    del corte") / `incomplete`. `role="status" aria-live="polite"`.
  * Verificacion: guardas — las cuatro ramas con textos distintos; la cabecera del corte sigue pintando
    `row.expectedCashCop` como la cifra que se liquida.

- [x] **T11: Verificacion en produccion y medicion**
  * Requisitos cubiertos: DoD 9, DoD 10, RNF_01, RNF_04
  * Archivos: `scripts/verify-019.js`, **nuevo** `scripts/verify-019-session.js`, `docs/rendimiento.md`,
    `.sdd/evidence/019/t11-produccion.txt`, `.sdd/evidence/019/t11-sesion-driver.txt`,
    `.sdd/evidence/019/t11-detalle-1280.png`, `.sdd/evidence/019/t11-perf.txt`
  * **Reabierta por la auditoria de trazabilidad (2026-09-19).** La primera entrega dio los dos puntos
    por cumplidos y no lo estaban: `verify-019.js` comprueba la aritmetica con ADC de **admin** y
    reproduciendo la escalera en node, asi que no ejercio ni una vez la ruta que de verdad falla —las
    reglas con rol `driver` y la lectura por id—, y RNF_01 se declaro "cumplido por construccion", que
    es un argumento, no una medicion.
  * Accion: `scripts/verify-019-session.js` abre la aplicacion REAL en Playwright con una cuenta Auth
    desechable (`smoke019-driver`, reclamos `role: driver` y `driverId`, borrada en el `finally`) y lee
    de la PANTALLA. Dos comandos: `detalle` (DoD 9) y `ab` (DoD 10, cargas A/B intercaladas contra un
    `git worktree` del commit anterior servido en otro puerto).
  * Verificacion: 185 filas en pantalla, suma $14.167.490 = cabecera, los seis KNT de DANDA con su
    importe ($533.400), 0 filas sin importe, 0 identificadores internos, **0 pedidos del corte
    denegados por las reglas**. Primer pintado: movil +6,4 %, escritorio +4,0 % (limite ±10 %) y
    **0 rescates por id antes del primer pintado**. `browserslist` intacto y `static{` = 0 en los 14
    chunks compilados.
  * **No desplegar.** La entrega la firma el responsable (constitucion, principio 7).

- [x] **T12: El aviso del cuarto desenlace (hallazgo 3 de la auditoria)**
  * Requisitos cubiertos: RF_08, RF_11 (caso limite "corte con mas pedidos fuera de ventana que el tope")
  * Archivos: `src/lib/driver-settlement-export.ts`, `src/lib/driver-settlement-export.test.ts`,
    `src/components/operations-app.tsx`, `src/lib/spec-019-guards.test.ts`
  * Problema: `pinOrders` devolvia `skippedByBudget` desde T6 y el panel lo tiraba con un `.finally()`.
    Con el tope agotado las filas no rescatadas caian a su importe guardado en el corte, la resta daba
    cero y el detalle se presentaba como "coincide con el corte": una suma parcial haciendose pasar por
    buena, que es justo lo que RF_08 prohibe.
  * Accion: `settlementDetailNotice()` —funcion PURA en el modulo de presentacion— decide el desenlace
    y su precedencia (`loading` > `incomplete` > `budget` > `adjusted` > `balanced`); el componente solo
    pinta. El panel guarda `skippedByBudget` por corte y lo pasa al aviso.
  * Verificacion: 5 pruebas de comportamiento sobre la funcion pura (incluida la precedencia) y 3
    guardas de fuente. Rojo previo en `.sdd/evidence/019/t12-rojo.txt`.

- [x] **T13: Lo que la primera auditoria dejo en "parcial"**
  * Requisitos cubiertos: RF_06, RF_07, RNF_03, DoD 5
  * Archivos: **nuevo** `src/lib/read-each-by-id.ts` + `.test.ts`, `src/lib/firebase/state-store.ts`,
    `src/lib/spec-019-guards.test.ts`, `docs/design-system.md`,
    `specs/019_el_corte_muestra_lo_que_cobra.md`
  * Problema: el bucle que hace cierto "un id ajeno no se lleva a los demas" vivia dentro de
    `state-store.ts`, que la suite no puede importar; vaciar su `try/catch` habria dejado las pruebas
    en verde. El filtro anti-duplicado de `pinOrders` no tenia ninguna asercion. Y `text-mint`, el
    color de los importes a favor, no tenia ratio de contraste verificado.
  * Accion: el bucle se extrae a `readEachById` (puro, con `readOne` inyectado) y `getDocumentsOneByOne`
    pasa a ser su adaptador; dos guardas nuevas para el filtro anti-duplicado y para que el bucle siga
    siendo el modulo puro; `text-mint` medido (12,9:1 sobre panel, 11,5:1 sobre field, 7,2:1 en tema
    claro) y anotado en la tabla de tokens; RF_05 enmendado para decir "al abrir el detalle de un
    corte", que es lo que el codigo hace y lo que la guarda RNF_02 exige.
  * Verificacion: 5 pruebas de comportamiento sobre `readEachById` (id que rechaza entre dos que
    resuelven, id inexistente, deduplicacion, tamaño de tanda) y 2 guardas. Rojo previo en
    `.sdd/evidence/019/t13-rojo.txt`. DoD 9 repetido contra produccion DESPUES del refactor.

---

## Cobertura RF → tarea

| Requisito | Tarea(s) |
|---|---|
| RF_01 | T1, T9 |
| RF_02 | T1, T2 |
| RF_03 | T1, T4 |
| RF_04 | T9 |
| RF_05 | T7, T8 |
| RF_06 | T3, T7, T13 |
| RF_07 | T6, T13 |
| RF_08 | T8, T12 |
| RF_09 | T3 |
| RF_10 | T3, T5, T9 |
| RF_11 | T4, T10, T12 |
| RF_12 | T4, T10 |
| RF_13 | T5 |
| RNF_01 | T2, T11 |
| RNF_02 | T6, T8 |
| RNF_03 | T9, T13 |
| RNF_04 | T11 |

Sin requisitos huerfanos y sin tareas sin requisito.
