# Plan tecnico — Spec 019: el corte muestra el mismo dinero que cobra

Spec: `specs/019_el_corte_muestra_lo_que_cobra.md` (aprobada el 2026-09-19).
Tareas: `specs/019_tasks.md`. Evidencia: `.sdd/evidence/019/`.

---

## 1. Lo que hay hoy (medido, no supuesto)

**El detalle de un corte se construye en `calculateDriverFinancialSummary`**
(`src/lib/finance.ts:614-698`). Por cada corte del domiciliario mapea `settlement.orderIds` — los
**185**, no los 169 con efectivo — y resuelve cada fila asi (`:637-651`):

```ts
const order = state.orders.find((item) => item.id === orderId);   // :638
const orderDriverPayCop = driverPayForOrder(state.wallet, driverId, orderId);
const codCop = orderCollectedCodCop(order);                        // :640  undefined -> 0
return {
  trackingCode: order?.trackingCode ?? orderId,                    // :643  id interno visible
  totalCop: codCop,
  expectedCashCop: Math.max(0, codCop - orderDriverPayCop)         // :648  trunca lo negativo
};
```

**Dos defectos independientes, un solo sintoma.** Medido en produccion el 2026-09-19 sobre
`stl-1789686589616-driver-driver-1778271901513` (185 pedidos, cabecera $14.167.490):

| | Filas | Efectivo |
|---|---:|---:|
| Con valor visible | 103 | $8.205.000 |
| En $0 porque el pedido no esta descargado | 66 | $6.082.490 |
| En $0 porque su importe a favor se trunca | 16 | −$120.000 |

1. **La descarga.** La ventana de cerrados son 6 dias cortados por `createdAt`
   (`state-store.ts:496-510`, `operations-app.tsx:415`). Un pedido creado el 11 y entregado el 17 queda
   fuera. `pinOrders` (`state-store.ts:665-687`) existe para rescatar por id, pero su unico punto de
   llamada (`:738-746`) lo alimenta con `selectUnsettledWalletEntries` = asientos **sin**
   `settlementId` (`finance.ts:374-376`). Los pedidos rotos son justo los que **si** lo tienen.
2. **El truncamiento.** Una visita sin recaudo vale `0 − pago = −$8.000`. El `Math.max(0, ...)` la
   aplasta a cero y la vuelve indistinguible de una fila rota.

**Lo que si esta bien y no se toca.** La cabecera sale de `cashExpectedForSettlement`
(`finance.ts:512-527`), que usa `settlement.codCop` / `driverPayCop` guardados por el servidor.
`pendingBalanceCop` = `incompleteSettlementsCop` + `unsettledCashCop`, y el primero deriva de
`settlement.cashPendingCop` / `cashReceipts` (`:628-634`), **nunca** de `orders[]`.

**Datos disponibles que hoy nadie lee en cliente.** `Settlement.cashAllocations`
(`src/lib/types.ts:423-429`): el importe por pedido que el propio corte guardo. Comprobado: los **35**
cortes del domiciliario la tienen poblada (169 entradas en el corte medido). Sus unicos consumidores
son el backend (`functions/src/orders.ts:1474`, `seller-ledger.ts:24-25`).

**Ambito.** Solo el rol `driver`. El admin deriva el mismo corte de la wallet
(`operations-app.tsx:10462-10472`) y no presenta el fallo. El mensajero no tiene detalle de corte.

---

## 2. Decisiones de diseno

### 2.1 Un tipo propio para las filas del corte, no ensanchar el existente

`DriverUnsettledCashOrderRow` (`finance.ts:406-414`) tipa **dos** cosas distintas: las filas del
detalle de un corte y `summary.unsettledOrders`. La segunda tiene otras garantias (sus pedidos estan
descargados por definicion). Se añade un tipo derivado para que ningun lector actual deje de compilar
y para que nadie confunda las garantias:

```ts
export type DriverSettlementOrderSource = "order" | "settlement" | "unknown";
export type DriverSettlementOrderRow = DriverUnsettledCashOrderRow & {
  source: DriverSettlementOrderSource;
  amountKnown: boolean;
  noCollection: boolean;
};
```

`DriverSettlementCashRow.orders` (`:386`) pasa a `DriverSettlementOrderRow[]`.

### 2.2 La etiqueta visible no vive en el nucleo

`trackingCode` vale **cadena vacia** cuando no se conoce, nunca el id interno (RF_10). El rotulo que
ve la persona (`"Pedido no disponible"`) vive en el modulo de presentacion (2.5), en una sola
constante, para que no pueda cumplirse en pantalla y violarse en Excel.

### 2.3 Escalera de resolucion por pedido

Con `pay = driverPayForOrder(state.wallet, driverId, orderId)`, que siempre esta disponible porque la
wallet del driver se suscribe sin recorte (`state-store.ts:549-550`):

| caso | `source` | `totalCop` | `expectedCashCop` |
|---|---|---|---|
| pedido en memoria | `order` | `orderCollectedCodCop(order)` | `totalCop − pay`, **sin `Math.max`** |
| ausente, con entrada en `cashAllocations` | `settlement` | `expectedCop + pay` | `expectedCop` guardado |
| ausente, `cashAllocations` no vacio y sin ese id | `settlement` | `0` | `−pay` |
| ausente y el corte no trae `cashAllocations` | `unknown` | `0` | sin importe (`amountKnown: false`) |

**La tercera rama no es una suposicion.** `functions/src/settlement-math.ts:156-178` construye
`cashAllocations` filtrando `max(0, cod − pago) > 0`, asi que la ausencia de un id **es** informacion:
el corte registro cero efectivo para ese pedido. Por eso 169 entradas y 185 ids.

**La cuarta rama no puede colapsarse en la tercera.** Si un corte antiguo no tiene `cashAllocations`,
tratar la ausencia como "cero efectivo" daria un total falso **en silencio**, que es exactamente el
fallo que esta spec existe para eliminar. `noCollection = amountKnown && totalCop === 0`.

### 2.4 Totales del detalle y por que no cuadra

Campos nuevos en `DriverSettlementCashRow` (`finance.ts:382-393`): `detailCashCop` (suma **solo** de
filas con importe, para no pasar una suma parcial por total), `detailDeltaCop`, `detailStatus`,
`unavailableOrderCount`, `unknownAmountCount`, `noCollectionCount`.

`detailStatus`, evaluado en este orden:

1. `unknownAmountCount > 0` → `"incomplete"`
2. `detailDeltaCop !== 0` → `"adjusted"`
3. si no → `"balanced"`

Esto codifica la decision 2 del responsable: una fila resuelta desde `cashAllocations` lleva la cifra
del **propio corte** y por tanto **no puede** generar delta. Un delta solo puede venir de un pedido
vivo cuyo valor cambio despues del corte (RF_12). La cabecera sigue siendo la cifra que se liquida: un
corte pagado o conciliado no se reescribe (constitucion, principio 10).

### 2.5 Un solo origen para pantalla y Excel

`buildDriverSettlementExportRows` vive dentro de `operations-app.tsx:12392-12409`, que **no se puede
importar desde Vitest** (SDK de navegador). RF_13 y el DoD 7 exigen que el Excel coincida fila a fila
con la pantalla; la unica construccion donde eso es una **propiedad** y no una promesa es que ambos
consuman la misma lista. Modulo nuevo `src/lib/driver-settlement-export.ts`:

```ts
export const UNAVAILABLE_ORDER_LABEL = "Pedido no disponible";
export const NO_AMOUNT_LABEL = "Sin importe";
export function buildDriverSettlementDetailRows(summary: DriverFinancialSummary): DriverSettlementDetailRow[];
export function buildDriverSettlementExportRows(rows: DriverSettlementDetailRow[]): Record<string, string | number>[];
export const driverSettlementExportColumns = [...] as const;   // + no_disponible, sin_recaudo
```

El Excel escribe el **numero** cuando lo hay —asi la columna suma la cabecera— y la misma etiqueta
cuando no. Se mueven ahi `driverSettlementExportColumns` (`:12388-12390`),
`buildDriverSettlementExportRows` (`:12392-12409`) y `settlementStatusLabel` (`:9824`).
**No se toca `statusLabel` de `operations-app.tsx:539`**: `src/lib/community-view.test.ts:1786` afirma
que existe. Se exporta en su lugar el ya correcto de `src/lib/order-export.ts:95`.

### 2.6 El rescate va bajo demanda, al expandir un corte

Descartado el automatico al montar: las cifras de cabecera (`incompleteSettlementsCop`,
`pendingBalanceCop`) **no dependen de `orders[]`**, asi que fijar pedidos al entrar gastaria lecturas
sin mover un solo numero. Y fijar los 6 cortes de la pagina serian hasta 1.110 lecturas, por encima
del tope de 800.

Al expandir un corte se piden **solo los ids de ese corte con `source !== "order"`**: 185 lecturas en
el peor gesto, ~4 cortes grandes por carga de pagina dentro del tope. Es la lectura literal del caso
limite de la spec —un corte plegado no esta mostrando nada— y acota RNF_02.

**El sembrado existente desde `selectUnsettledWalletEntries` se queda** (`state-store.ts:738-746`): es
lo que mantiene correcto "Pendiente sin cortar" (`docs/rendimiento.md`, regla 2, y constitucion,
principio 8). La via nueva es **aditiva**; que existan dos puntos de llamada es lo que exige el DoD 4.

### 2.7 El canal, calcado de `onWidenHistory`

Ya hay precedente de bajar una capacidad de la suscripcion hasta un panel: `widenHistoryWindow`
(`operations-app.tsx:13092-13101`) → `DriverView` (`:13359`) → `DriverHistoryPanel` (`:12554`).

`subscribeFirestoreState` (`state-store.ts:472-477`) gana un quinto callback **opcional**:

```ts
onControls?: (controls: { pinOrders: (orderIds: string[]) => Promise<PinResult> }) => void
```

invocado una vez, justo antes del `return` de limpieza (`:836`). **El valor de retorno sigue siendo la
funcion de desuscripcion**: el efecto de `useAppState` la devuelve como cleanup
(`operations-app.tsx:457`) y cambiar el tipo lo romperia. `useAppState` guarda los controles en un
`useRef` y expone `pinSettlementOrders` en su objeto de retorno (`:506`). Una ref vieja tras
resuscribir es inocua: la clausura muerta choca con `if (stopped) return` (`state-store.ts:685`).

Las dos guardas de firma existentes lo toleran: `state-store-targets.test.ts:565-575` solo afirma que
`context` esta presente y que nada casa con `/hat/i`; `spec-005-guards.test.ts:641-651` solo afirma que
`onError` existe.

### 2.8 "Se esta completando" no necesita bandera en el store

RF_08 se resuelve con la promesa que devuelve el rescate: el panel guarda un `Set<string>` local con
los ids de corte cuyo rescate esta en vuelo. El store sigue siendo tonto; la honestidad sobre lo que
falta vive donde se pinta la suma.

### 2.9 El tope pasa a ser acumulado

`state-store.ts:674` aplica `.slice(0, MAX_PINNED_ORDERS)` **por llamada**, asi que N llamadas fijan
N × 800. `pinnedRequested` ya es el acumulador correcto: cuenta ids **pedidos**, existan o no, que es
lo que cuesta una lectura. Pasa a `slice(0, MAX_PINNED_ORDERS − pinnedRequested.size)` y `pinOrders`
devuelve `{ requested, fetched, skippedByBudget }` para que el panel pueda decir que el detalle quedo
incompleto **a proposito** (caso limite 3, RF_11). Actualizar el comentario de `:97-98`: el tope es
**por carga de pagina** y compartido con la via de la wallet.

### 2.10 `Map` en vez de `find`, y es prerrequisito

`calculateDriverFinancialSummary` hace hoy `state.orders.find(...)` dentro de un bucle de 35 cortes ×
185 ids sobre ~3.000 pedidos, en **cada** emit. El rescate añade emits (`dirty.add("orders")` +
`scheduleEmit()`, `state-store.ts:684-685`), asi que es el peor momento posible para ser O(n·m).
`const ordersById = new Map(state.orders.map((order) => [order.id, order]))` antes del bucle es
requisito de RNF_01, no una mejora suelta.

### 2.11 Trocear `getDocumentsOneByOne`

`state-store.ts:1004-1021` hace `Promise.all` sobre todos los ids; el llamante actual nunca pasa mas
de un puñado. 185 `getDoc` simultaneos desde un movil en la red del lider es territorio no medido.
Trocear de 30 en 30 y medir antes de dar RNF_01 por bueno. **No volver al lote** (constitucion,
principio 8, corolario).

---

## 3. Arbol de modulos

```
src/lib/finance.ts                        MODIFICADO  2.1-2.4, 2.10
src/lib/driver-settlement-export.ts       NUEVO       2.2, 2.5  (puro, sin React ni Firebase)
src/lib/firebase/state-store.ts           MODIFICADO  2.7, 2.9, 2.11
src/lib/order-export.ts                   MODIFICADO  exporta statusLabel (:95)
src/components/operations-app.tsx         MODIFICADO  2.6-2.8, interfaz
scripts/verify-019.js                     NUEVO       solo lectura, patron de verify-018.js

src/lib/finance.test.ts                   MODIFICADO  comportamiento (T1, T3, T4)
src/lib/driver-settlement-export.test.ts  NUEVO       comportamiento (T5)
src/lib/spec-019-guards.test.ts           NUEVO       guardas de fuente (T6-T10)
```

`src/lib/driver-settlement-export.ts` depende solo de `finance.ts` y `types.ts`: nucleo desacoplado de
la interfaz (constitucion, principio 3).

---

## 4. Algoritmos criticos

**Resolucion de fila** — la escalera de 2.3, en una funcion pura `settlementOrderRow(orderId, ctx)`
extraida para poder probar las cuatro ramas por separado.

**Total del detalle** — `detailCashCop = Σ expectedCashCop de las filas con amountKnown`.
`detailDeltaCop = detailCashCop − expectedCashCop(cabecera)`. Con todos los pedidos descargados y sin
correcciones posteriores, la identidad es exacta:

```
Σ (cod_i − pago_i)  =  Σ cod_i − Σ pago_i  =  codCop − driverPayCop  =  cashExpectedCop
15.996.490 − 1.829.000 = 14.167.490 ✓
```

Y se ve por que hoy no cuadra: las 103 filas visibles suman $8.205.000, las 66 rotas aportan $0 en vez
de $6.082.490, y las 16 truncadas aportan $0 en vez de −$120.000.

**Presupuesto de rescate** — 2.9. El tope se consume contra `pinnedRequested.size`, compartido entre
las dos vias.

---

## 5. Estrategia de testing

**Comportamiento donde se pueda** (constitucion, principio 4). `finance.ts` y
`driver-settlement-export.ts` son puros: se importan y se prueban de verdad, con el patron de
`finance.test.ts:375-563` (helper local `baseState()` sobre `seedState()`, mutando
`orders`/`wallet`/`settlements`).

El fixture de T1 reproduce el corte real: 185 pedidos generados con los agregados de produccion
(`codCop` 15.996.490, `driverPayCop` 1.829.000, 169 con efectivo y 16 sin), mas un subcaso literal con
los seis KNT de DANDA. Los asientos `cod_revenue` de tienda deben cuadrar con `order.totalCop` para
que cabecera y detalle compartan una sola verdad.

**Guardas de fuente donde no quede otra.** `state-store.ts` y `operations-app.tsx` no se pueden
importar desde Vitest. `src/lib/spec-019-guards.test.ts` sigue el patron de
`spec-018-guards.test.ts:16-35` (`source()`, `exportedBlock()`, `functionBlock()`, aserciones sobre
booleanos y regex cortos, nunca `expect(FUENTE).toMatch(...)`).

**La guarda que sostiene el DoD 4:** `pinOrders(` tiene **≥ 2** puntos de llamada y **al menos uno
fuera** del bloque de `selectUnsettledWalletEntries`. Si alguien devuelve el rescate a una sola via,
se pone roja.

**Verificacion real** (DoD 9): `scripts/verify-019.js` de solo lectura contra produccion, y sesion de
lider logistico con usuario desechable + `signInWithPassword` REST (`CLAUDE.md`), borrado al terminar.

---

## 6. Dependencias nuevas

Ninguna. Constitucion, principio 2.

---

## 7. Orden de despliegue

**No hay consultas nuevas ni indices nuevos**: el rescate usa `getDoc` por id, que no necesita indice.
Tampoco cambia ninguna callable. Por tanto el despliegue es **solo hosting**, y aun asi exige
`ALLOW_FUNCTIONS_DEPLOY=1` porque `/registro/[slug]` arrastra la funcion SSR:

```
npm run lint && npx vitest run && npx tsc --noEmit
ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only hosting --project kentro-last-mile
```

La entrega la firma el responsable (constitucion, principio 7). Ningun agente despliega.

---

## 8. Riesgos

| Riesgo | Por que no rompe | Mitigacion |
|---|---|---|
| Quitar el `Math.max` de `:648` mueve una cifra de cabecera | `pendingBalanceCop` sale de `settlement.cashPendingCop`, no de `orders[].expectedCashCop`. Los unicos lectores de ese campo son el detalle y el Excel, ambos reescritos aqui | Prueba de no-regresion sobre `pendingBalanceCop` en T4 |
| Alguien "armoniza" `summary.unsettledOrders` | Sus pedidos estan descargados por definicion; cambiar su `Math.max` (`:688`) moveria el KPI heroe | Comentario explicito en el codigo + no tocarlo |
| `trackingCode` pasa de id a cadena vacia | Ventana con celdas `guia` en blanco en el Excel si T5 aterriza despues de T2 | Secuenciar T5 antes de T9 |
| Los pedidos fijados suben los conteos de `FleetReportsPanel` | Ya pasa hoy con el rescate de la wallet; el panel ya avisa (`:12751`) | Anotarlo en la evidencia del DoD 9 para que no se lea como fallo |
| Un corte pasa de `balanced` a `adjusted` en vivo | Es la decision 2 funcionando: los pedidos llegan y el valor vigente manda | Prueba propia (T4) |
| Corte antiguo sin `cashAllocations` | La rama `"unknown"` existe para eso | T3 prueba que **no** colapsa en la rama `−pago` |
| 185 `getDoc` simultaneos en movil | No medido | Trocear (2.11) y medir en T11 antes de dar RNF_01 |
