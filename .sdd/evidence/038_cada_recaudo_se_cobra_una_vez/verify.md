# Spec 038 · Verificacion (2026-11-10)

Rama `claude/strange-cohen-839664`, commits `a6a88cc` (borrador de la spec) a `21b2f3b` (T23). Nada desplegado,
nada mergeado, nada escrito en produccion: todas las corridas contra produccion fueron de solo lectura (ADC).

## 1. Tareas

23 de 23 hechas (`specs/038_tasks.md`, `.sdd/state.json`), cada una en estricto TDD (prueba en rojo, codigo,
suite completa) y en su propio commit. Las ampliaciones de alcance de cada tarea estan anotadas en la propia
tarea.

## 2. Requisitos → prueba

| Req | Donde se prueba (archivos de `src/lib/`) |
|---|---|
| RF_01 | driver-cash-ledger.test, .property.test (500 secuencias), settlement-math.test ("el pago de OTRO domiciliario") |
| RF_02 | driver-cash-ledger.test (T3: causas 1-4, cobrado una vez) |
| RF_03 | driver-cash-ledger.test (`cashCharges` con ceros y negativos), .cases.test |
| RF_04 | driver-cash-ledger.test (T13: pagado/conciliado no recalcula), driver-ledger-io.test |
| RF_04b | driver-ledger-io.test (recalculo cruzado lanza `recalculo_cruzado`) |
| RF_05 | driver-cash-ledger.test (T2), .cases.test (cada asignacion reconstruye su cifra; KNT-000056) |
| RF_05b | driver-cash-ledger.cases.test, snapshot-038-baseline.test, measure-038.test, spec-038-guards.test, spec-038-rules.test |
| RF_06 | driver-cash-ledger.test (T7) |
| RF_07 | driver-cash-ledger.test (T7, `pendingDeltaOrders`), order-corrections-plan.test |
| RF_08 | driver-cash-ledger.test (T4: saldo a favor y deuda), .property.test, order-corrections-plan.test (KNT-002929) |
| RF_09 | settlement-math.test, cash-outstanding.test (T15), spec-038-guards.test (una sola regla) |
| RF_09b | driver-cash-ledger.test (T3/T4), finance.test (T17: la app pinta lo guardado) |
| RF_10 | order-corrections-plan.test (T14: aviso de lo que se le devuelve) |
| RF_11 | seller-ledger.test (por tiempo, caso B5), seller-balance / store-api-orders / cash-outstanding / finance (T16-T17), spec-038-guards.test |
| RF_12 | seller-ledger.test (cortes viejos con la regla de hoy), spec-038-guards.test |
| RF_13 | driver-cash-ledger.test (T8), compensate-038.test, .cases.test (T20) |
| RF_14 | driver-cash-ledger.test (huella), compensate-038.test (transaccion, aborta si cambio) |
| RF_15 | driver-cash-ledger.test ("aplicar dos veces no cambia nada"), .cases.test (T20) |
| RF_16 | compensate-038.test, .cases.test (opcion A) |
| RF_17 | driver-cash-ledger.test (retenciones), .cases.test (16 retenciones, desplegar no cambia nada), cash-outstanding.test |
| RNF_01 | measure-038.test; corrida `--deploy-check` contra produccion (abajo) |
| RNF_02 | driver-cash-ledger.property.test (registrado = debido + retencion), cash-outstanding.test (identidad de la 026) |
| RNF_03 | driver-cash-ledger.cases.test (cuatro casos reales anonimizados) |
| RNF_04 | driver-ledger-io.test (tres lecturas del contexto) |

## 3. Calidad

- `npx vitest run`: 74 archivos, 3668 pruebas, todas en verde.
- `npx tsc --noEmit` en la raiz y en `functions/`: sin errores. `npm run lint`: 0 errores, los 3 avisos de siempre.
- Guardas `spec-018`, `spec-026`, `spec-038` y pruebas de la 027 (`seller-ledger`, `cash-outstanding`): 571 en verde.
- Cada guarda nueva se vio fallar: la de "recibido" encontro cinco llamadas reales sin recaudo; las de "una sola
  regla" y "regla vieja" cazaron un archivo de mutacion temporal (borrado despues).
- Consultas nuevas: solo filtros de igualdad e `in`, sin orden ni rangos. Las sirven los indices de un campo; no
  hace falta indice compuesto nuevo. Todas corrieron ya contra produccion (scripts de T19-T21).

## 4. Produccion, solo lectura

| Comprobacion | Resultado | Evidencia |
|---|---|---|
| Medicion | 686.202 / 686.200, 0 cortes sin cuadrar | t19-medicion.txt, t21-medicion-check-deploy-check.txt |
| `--check` | 61 cortes, 0 problemas | t21-... |
| Foto en seco | 16 retenciones, $686.200 (driver-1778271901513); 0 el otro | t19-foto-en-seco.txt |
| Compensacion previsualizada | opcion A $632.200; KNT-005724 y KNT-006347 pendientes ($54.000) | t20-compensacion-previsualizada.txt |
| `--deploy-check` esperado | pendiente 6.032.440 → 6.032.440; siguiente 6.547.910 → 6.547.910 | t21-... |
| `--deploy-check` recibidos | 1 deja de estarlo: KNT-007828 (fallido), sin efecto en dinero | t21-... (con los asientos del pedido) |

## 5. Lo que no esta probado

- **Las callables en una transaccion real.** `createSettlement`, `recordDriverCashReceipt`, `updateSettlementStatus`
  y `correctOrderStatus` estan cubiertas por la parte pura (constructor de campos, planificador) y por dobles de
  Firestore en `driver-ledger-io`, pero no hay prueba de extremo a extremo contra el emulador. Se comprueba al
  desplegar, con una sesion real, antes de dar por buena la entrega.
- **La app en el navegador.** T17 esta probada en `finance.test`; no se ha mirado ningun corte nuevo en pantalla
  (todavia no existe ninguno).

## 6. Definition of Done

1. Todos los RF con prueba automatizada (incluidas la de propiedad y los casos reales): **cumplido**.
2. tsc, vitest, lint y guardas: **cumplido**.
3. Medicion de RNF_01 aprobada por el responsable antes de desplegar functions: **pendiente del responsable**
   (la cifra a aprobar: esperados con diferencia 0; recibidos, KNT-007828).
4. Previsualizacion de compensacion con la regla desplegada = tabla de §1: **pendiente** (se cumple en seco hoy;
   hay que repetirla despues de desplegar y de escribir la foto).
5. Validacion y aprobacion del humano; ningun agente despliega ni escribe dinero: **pendiente del responsable**.

## 7. Revision independiente

Un revisor sin contexto previo leyo el diff entero (solo lectura). Sus tres defectos se reprodujeron con la regla
compilada, en memoria (`repro_findings.js`, fuera del repo), y los tres son reales:

| # | Gravedad | Defecto | Reproduccion |
|---|---|---|---|
| H1 | **alta** | `orderOwedByDriver` cobra el recaudo de un pedido a CUALQUIER domiciliario que tenga ese pedido en un corte, no solo al que lo entrego (spec §5: "el recaudo se le cobra al que entrega"). D1 hace la visita fallida, D2 entrega: el siguiente corte de D1 recoge el pedido solo (`pendingDeltaOrders`) y le cobra 100.000, y D2 tambien los paga. | D1 esperado 100.000; D2 91.000. **El mismo recaudo dos veces.** |
| H2 | media | `isOrderCodSettled` exige que NINGUN asiento de recaudo sea posterior al ultimo corte saldado. Un cambio que netea cero para el domiciliario (cambio de tienda bien hecho; entregado→fallido→entregado) no lo devuelve a ningun corte: la tienda queda bloqueada para siempre. | `pendingDeltaOrders` = []; recibido = false sin salida. |
| H3 | media-baja | Para un pedido con un corte nuevo, la rama nueva de `buildCodReceivedSet` sustituye a la vieja: con un corte viejo pendiente sin cubrir y un corte nuevo saldado (cargo negativo), sale "recibido" aunque el efectivo no llego. | Regla vieja: false; con B saldado: true. |

Menores, sin efecto en dinero hoy: cada abono lee dentro de la transaccion todos los asientos de tienda (riesgo de
contencion); conciliar un corte viejo ya pagado reescribe el orden de sus `cashAllocations` (mismas cifras); la
foto con mas de 200 domiciliarios escribiria en varios lotes (hoy son 2); las correcciones no ponen precondicion
sobre las retenciones.

**Exposicion en produccion hoy (solo lectura):** de 4.840 pedidos en cortes de domiciliario, 0 estan en cortes de
dos domiciliarios y 0 tienen un `driverId` distinto del de su corte. H1 no afecta a la medicion ni a las 16
retenciones, pero aparecera en cuanto un domiciliario entregue un pedido que otro ya tuvo en un corte.

## 8. Veredicto

**No lista para desplegar.** H1 cobra dos veces el mismo recaudo, que es justo lo que la 038 existe para
impedir; H2 y H3 son la regla de "recibido". Los tres piden una enmienda de la spec (RF_01 y RF_11) y tareas
nuevas antes de auditar y abrir el PR.
