# Plan tecnico — Spec 018: la tienda ve el mismo saldo que el admin puede liquidarle

- **Spec:** `specs/018_saldo_de_tienda_igual_al_cierre.md` (aprobada 2026-09-16, enmendada el mismo dia)
- **Fecha:** 2026-09-16 (reescrito tras `/sdd-analyze`: la retencion ya no escribe movimientos; ajustado
  tras la segunda pasada: una sola regla de seleccion, modulos puros para la API y la entrada, manejo
  cobrado por asiento)
- **Diseno:** no hay `specs/design/018/`. Como en la 013, la interfaz se limita a cambiar cifras y
  rotulos dentro de tarjetas que ya existen (tarjeta heroe, panel de wallet, detalle de liquidacion),
  sin pantallas nuevas; se construye con los patrones de `docs/design-system.md`. Si el responsable
  quiere otra disposicion, se vuelve a `/sdd-design` antes de las tareas de interfaz (T10–T12).

## 1. Lo que hay hoy (medido en el codigo y en produccion, no supuesto)

| Donde | Que hace | Linea |
|---|---|---|
| `sellerBalance` | `ledgerCop` = todos los asientos sin cortar; `reservedCop` = pedidos no terminales × `settings.pendingReserveCop` (9.000); `availableCop = max(0, ledger − reserva)` | `src/lib/finance.ts:382` |
| Tarjeta heroe de la tienda | pinta `max(0, sellerBalance().ledgerCop)` con el texto falso "Lo pendiente de hoy, no el acumulado" | `operations-app.tsx:11471` |
| `WalletPanel` (tienda) | pinta `availableCop` y "Reserva: X · N pendientes" | `operations-app.tsx:6996` |
| Cierre pendiente del admin | `buildLiquidationRows` sobre asientos abiertos filtrados por una **copia de cliente** de `isSellerEntryEligible` (rechaza todo asiento sin `orderId` salvo abono y 4x1000); `netCop` = suma | `operations-app.tsx:7548, 7557, 7986` |
| Efectivo recibido, **cliente** | `receivedDriverOrderIds`: asignaciones cubiertas; si no, corte pagado/conciliado **o `cashPendingCop === 0`**; y un reparto legado por `cashReceipts` | `operations-app.tsx:7417` |
| Efectivo recibido, **servidor (solicitud y API de tiendas)** | `buildCodReceivedSet`: asignaciones cubiertas; si no, pagado/conciliado **o `cashPendingCop === 0`** | `functions/src/seller-ledger.ts:18` |
| Efectivo recibido, **corte** | inline en `createSettlement`: asignaciones cubiertas; si no, **solo** pagado/conciliado | `functions/src/orders.ts:1258` |
| Corte | cierra los asientos candidatos; `settlementTotals` suma todos sus importes y calcula el 4x1000 sobre esa suma | `orders.ts:1208`, `settlement-math.ts:209` |
| Abono a proveedor | liquida `product_cost` del mas antiguo al mas nuevo y se detiene en el primero que no cabe (`break`) | `orders.ts:1670-1682` |
| Solicitud de liquidacion | `summarizeSellerPayable`: rechaza si `eligibleCop <= 0` | `orders.ts:2316` |
| API de solo lectura para tiendas | `buildStoreSummary`: `disponibleCop` = asientos abiertos elegibles; `bloqueadoCodCop`; sin retencion | `functions/src/store-api.ts:209-284` |
| Cobro de fallido | `resolveTariffs(settings, zona)` → `resolveSellerCharges` (fijo 12.000; DANDA 0) → `communityChargeAtClose` (lider si es mayor) → `buildWalletEntries` | `seller-charges.ts:107`, `wallet-entries.ts:98` |
| Manejo de bodega | asiento de id fijo `we-<pedido>-fulfillment-fee`; la evidencia de fallido **sin** `failedCategory` es "cliente reagenda" y no cobra (`wallet-entries.ts:213`) | `wallet-entries.ts:207-260` |
| Descarga de la tienda | sus asientos con `settlementId == ""`; **no** puede leer cortes de domiciliarios | `state-store.ts:573`, `firestore.rules` |
| Descarga del admin | pedidos activos, cortes, wallet; rescata por id los pedidos de asientos sin liquidar | `state-store.ts:738` |

Produccion, 2026-09-16, pedidos abiertos por estado y marca de recogida (`pickedUpAt`):
`picked_up` 197 (todos con marca), `in_route` 28 (todos), `call_pending` 3 (todos), `ready_to_assign`
128 sin marca y **9 con marca** (reabiertos), `imported` 99 sin marca. Ninguno sale de bodega.

## 2. Decisiones de diseno

### 2.1 Retener dejando pedidos completos fuera (RF_02, RF_12–RF_14, RF_23, RF_24)

No hay asiento de retencion. La retencion es un **tope** y el corte elige que pedidos caben:

```
tope = pagableTienda − retencionTeorica          (pagableTienda: TODO lo pagable de la tienda)
seleccion(candidatos, tope):
  fijos   = asientos sin pedido (abonos, 4x1000, restituciones)  + pedidos con neto <= 0
  suma    = Σ fijos
  positivos = pedidos con neto > 0, del mas antiguo al mas nuevo
  para cada p en positivos:
    si suma + neto(p) > tope: parar            (el primero que no cabe y los siguientes quedan)
    suma += neto(p); incluir p
  devuelve { asientos incluidos, suma, pedidosRetenidos }
```

- **Antiguedad de un pedido:** el `createdAt` mas antiguo de sus asientos abiertos; empate por `orderId`.
  Es el mismo eje que ya usa el abono a proveedor.
- **Neto de un pedido:** suma de sus asientos abiertos elegibles de tienda.
- **Disponible (RF_02)** = suma de la seleccion sobre todo lo pagable de la tienda con ese tope. Los
  bordes (sin retencion, pagable negativo, tope por debajo de los fijos) estan en 4.2.
- **Corte con rango o seleccion (RF_23):** `candidatos` = lo escogido; `tope` sigue siendo el de la
  tienda entera. Lo pagable que queda fuera cubre la retencion sin escribir nada.
- **Seleccion que suma cero o menos (RF_14, RF_24):** si lo pagable es positivo pero la seleccion suma
  <= 0 (abonos grandes que se comen los pedidos que caben), disponible = 0, todo lo pagable es retenido y
  el corte se rechaza. Asi un corte con pagable positivo nunca deja a la tienda debiendo.
- **Siguiente corte (RF_13):** los pedidos que quedaron fuera siguen con `settlementId` vacio; nada que
  devolver.

Se descartaron: el movimiento de retencion con devolucion (version anterior del plan; el responsable
eligio pedidos completos) y la seleccion "mochila" que salta un pedido grande para meter uno pequeno
posterior (rompe "del mas antiguo al mas nuevo" y lo que ya hace el abono a proveedor).

### 2.2 Modulos puros nuevos

`functions/src/seller-retention.ts` — cuanto retiene un pedido. Importa `wallet-entries.ts` y
`seller-charges.ts` (puros; ya los importa el cliente).

```ts
export type RetentionOrder = {
  id: string; sellerId: string; status: string; pickedUpAt?: string;
  fulfillmentMode?: string; zoneId?: string; driverId?: string | null;
  shopifyOrderId?: string; communityPricing?: unknown; evidence?: unknown[];
};
export function isOrderOnTheStreet(order: RetentionOrder): boolean;              // RF_09, RF_10
export function retentionForOrder(order: RetentionOrder, tariffs: Tariffs, now: string): number; // RF_06, RF_07
```

`functions/src/seller-balance.ts` — seleccion y cifras. Importa `seller-ledger.ts` y `seller-retention.ts`.

```ts
export type SellerBalanceInput = {
  openEntries: WalletEntryDoc[];              // asientos de la tienda con settlementId vacio
  ordersById: Map<string, OrderDoc>;          // pedidos de esos asientos
  streetCandidates: RetentionOrder[];         // pedidos abiertos de la tienda
  codReceived: ReadonlySet<string>;
  chargedFulfillmentOrderIds: ReadonlySet<string>; // pedidos con asiento we-<id>-fulfillment-fee (2.7)
  settings: Record<string, unknown>;
  zonesById: Map<string, Record<string, unknown>>;
  now: string;
};
export type PayoutSelection = {
  entryIds: string[]; totalCop: number;
  includedOrderIds: string[]; heldOrderIds: string[];
};
export type SellerBalance = {
  totalUnsettledCop: number;       // RF_08: suma de asientos de tipo liquidable
  payableCop: number;              // antes de retener
  codPendingCop: number;           // RF_05, puede ser negativo
  codPendingOrderCount: number;
  retentionTheoreticalCop: number; // Σ retentionForOrder
  streetOrderCount: number;
  availableCop: number;            // RF_02: selection.totalCop
  heldCop: number;                 // RF_08: payableCop − availableCop
  heldOrderCount: number;
  unreadableEntryIds: string[];    // RF_22
  selection: PayoutSelection;
};
/** Arma la entrada desde documentos planos. La usan el cargador del servidor y la fila del admin:
 *  una sola forma de decidir que pedidos son candidatos y que manejos ya se cobraron. */
export function buildSellerBalanceInput(docs: {
  sellerId: string; wallet: WalletEntryDoc[]; orders: OrderDoc[]; settlements: SettlementDoc[];
  settings: Record<string, unknown>; zones: Record<string, unknown>[]; now: string;
}): SellerBalanceInput;
export function computeSellerBalance(input: SellerBalanceInput): SellerBalance;
/** Nucleo de la seleccion: del mas antiguo al mas nuevo, con `break`. */
export function selectPayableOrders(entries: WalletEntryDoc[], capCop: number): PayoutSelection;
/** LA regla del tope, unica (RF_12-RF_15, RF_23, RF_24). La usan computeSellerBalance (candidatos =
 *  todo lo pagable) y createSettlement (candidatos = lo escogido). */
export function selectSettlementEntries(
  balance: Pick<SellerBalance, "payableCop" | "retentionTheoreticalCop">,
  candidates: WalletEntryDoc[]
): { ok: true; selection: PayoutSelection } | { ok: false; reason: "empty_by_retention"; selection: PayoutSelection };
export function payoutRejectionMessage(balance: SellerBalance): string;          // RF_16, RF_24
```

Invariante que las pruebas fijan, con `unreadableEntryIds` vacio: `totalUnsettledCop === availableCop + codPendingCop + heldCop`. Con asientos ilegibles no se muestra cifra (RF_22).

### 2.3 Una sola definicion de efectivo recibido y de elegibilidad (RF_04, hallazgo 5)

`buildCodReceivedSet` pasa a ser **exactamente** la regla del corte: asignaciones con `covered` y
`orderId`; sin asignaciones, corte `paid` o `reconciled`. Se quita la rama `cashPendingCop === 0`.
`createSettlement` deja su copia inline. En el cliente se retiran `receivedDriverOrderIds` y la copia de
`isSellerEntryEligible` (`operations-app.tsx:7548`); ambos pasan a importar las de `seller-ledger.ts`,
que no importa nada de servidor.

**Riesgo:** puede mover cifras hoy visibles. T1 mide la diferencia por tienda en produccion antes de
tocarlo; si alguna cambia, se muestra al responsable antes de T3.

### 2.4 Que asientos entran (RF_22, decision 8.11)

- Solo tipos de `SELLER_LIQUIDATION_TYPES` (los mismos que el corte acepta via
  `isLiquidationWalletType`). `payout`, `cash_shortage` o `platform_margin` con dueno tienda no entran
  al total ni al disponible, como hoy no entran al corte.
- Asiento liquidable **sin pedido** que no sea abono ni 4x1000 (ni restitucion `seller_abono` positiva),
  o cuyo pedido no existe: va a `unreadableEntryIds`, y RF_22 se aplica literal: error, sin cifra.
- **Compuerta al final de T1:** si produccion tiene alguno, el ciclo se detiene y el responsable decide
  antes de T5 (corregir datos o enmendar RF_22). T5 no se empieza sin esa respuesta.

### 2.5 Donde se calcula cada superficie (RNF_03)

| Superficie | Donde | Datos |
|---|---|---|
| Tienda (heroe y wallet) | callable nuevo `getSellerBalance` | cargador de servidor |
| Solicitud de liquidacion | `requestSellerPayout` | mismo cargador |
| Corte de tienda | `createSettlement` | mismo cargador + `selectSettlementEntries` sobre lo escogido |
| API para tiendas | `store-api.ts` `resumen` → `store-summary.ts` (puro) | sus lecturas + `settings/global` + zonas |
| Cierre pendiente del admin | cliente: `buildSellerBalanceInput` con los arrays de `state` | pedidos activos y rescatados, cortes, wallet, zonas, ajustes |

Todas las superficies pasan por `buildSellerBalanceInput` → `computeSellerBalance`. Solo cambia de donde
salen los documentos.

Cargador `loadSellerBalanceInput(db, sellerId, now)` en `functions/src/seller-balance-api.ts` (lee y
delega en `buildSellerBalanceInput`):

1. `walletEntries` con `ownerType == "seller"`, `ownerId == sellerId`, `settlementId == ""`.
2. Pedidos de esos asientos con `db.getAll`.
3. Candidatos a la calle: `orders` con `sellerId == sellerId` y `status in [address_risk,
   ready_to_assign, assigned, call_pending, scheduled, pickup_pending, picked_up, in_route,
   retry_pending]`. T5 comprueba en produccion que no pide indice compuesto.
4. Asientos de manejo de esos candidatos cuando salen de bodega: `db.getAll` de
   `walletEntries/we-<id>-fulfillment-fee` (existan o no; hoy cero pedidos de bodega).
5. `settlements` con `kind == "driver"`.
6. `settings/global` y las zonas de los candidatos.

### 2.6 Regla de "en la calle" (RF_09, RF_10)

`isOrderOnTheStreet(order)`:

- Terminal (`delivered`, `failed`, `cancelled`, `liquidated`) → `false`.
- `picked_up` o `in_route` → `true` (son por definicion mercancia recogida).
- Cualquier otro estado abierto, **incluido `retry_pending`** → `true` solo si `pickedUpAt` tiene valor.
- Resto → `false`.

T1 lista los 9 `ready_to_assign` con marca, que retendran.

### 2.7 Cuanto retiene un pedido (RF_06, RF_07, RNF_02)

`retentionForOrder(order, tariffs, now, { fulfillmentAlreadyCharged })` no reimplementa la tarifa: llama a
`buildWalletEntries` con el pedido tal como quedaria si fallara ahora en visita cobrable (`status:
"failed"`, `failedCategory: "failed_visit"`, evidencia anadida con esa categoria), con `tariffs =
resolveTariffs(settings, zona)` y `productCostLines = []`. Suma los asientos de tienda `failed_fee` y
`fulfillment_fee`, y quita el de manejo si `fulfillmentAlreadyCharged`.

**Manejo ya cobrado = existe el asiento `we-<pedido>-fulfillment-fee`**, liquidado o no. Es la verdad
exacta (el id es fijo) y no depende de interpretar evidencias viejas. `buildSellerBalanceInput` llena
`chargedFulfillmentOrderIds` desde la wallet que recibe: el admin tiene la wallet entera; el cargador del
servidor lee esos ids por nombre (2.5 paso 4). El doble cobro al reabrir tras un corte pagado es de la 019.

### 2.8 Pantallas

- **Tarjeta heroe (RF_18, RF_22):** "Disponible para liquidar" con `availableCop`; texto "Lo que Kentro
  te puede pagar hoy, en pedidos completos."; esqueleto al cargar; error con reintento y sin cifra.
- **Panel de wallet de la tienda (RF_19):** Disponible · Efectivo aun con el domiciliario (N pedidos) ·
  Retenido (N pedidos, de ellos M en la calle) · Total sin cortar. Sin "Reserva". Boton de solicitud
  deshabilitado con `availableCop <= 0` mostrando `payoutRejectionMessage`.
- **Cierre del admin (RF_20):** fila de tienda con `availableCop`; detalle con "Efectivo aun con el
  domiciliario" y "Retenido"; `receivableCop/payoutCop/gmfCop` desde `availableCop`; "Saldo incompleto"
  si `unreadableEntryIds` no esta vacio. El boton de corte del admin envia **solo** `entryIds` de
  `selection` (con fechas vacias, como hoy), asi lo que ve es lo que se corta.
- **Refresco (RF_21):** hook `useSellerBalance` — al montar, cada 300000 ms, al volver visible; un fallo
  deja `error` sin cifra previa.

### 2.9 API para tiendas (RF_25)

`buildStoreSummary` sale de `store-api.ts` a `functions/src/store-summary.ts`, **puro** (sin
`firebase-admin` ni `firebase-functions`; hoy solo usa helpers locales), para que la raiz pueda probarlo.
Recibe ademas el `SellerBalance`. `store-api.ts` anade dos lecturas al recurso `resumen`:
`settings/global` y las zonas de los pedidos candidatos; los candidatos salen de `allOrders` (que ya lee)
y la wallet completa de la tienda (que ya lee) llena `chargedFulfillmentOrderIds`.

- `saldoPendiente.disponibleCop = balance.availableCop`
- `saldoPendiente.bloqueadoCodCop = balance.codPendingCop`
- **nuevo** `saldoPendiente.retenidoCop = balance.heldCop` y `retenidoPedidos = balance.heldOrderCount`
- `totalCop` = disponible + retenido + bloqueado + en liquidacion
- `significado` explica `retenidoCop`.

Contrato: se **anade** un campo y cambia el valor de `disponibleCop` (baja). Se anota en el informe.

### 2.10 Efecto sobre la fila de proveedores del admin

La fila de proveedores usa el mismo `sellerEligible` que T9 unifica. Cambiar la definicion de efectivo
recibido puede mover lo que el admin ve pendiente por proveedor. T1 lo mide junto con las tiendas.

### 2.11 Lo que se retira

- `sellerBalance` y su prueba de la reserva fija; el import muerto de `actions.ts`.
- `settings.pendingReserveCop` queda con `@deprecated` en `types.ts` (no se borra de Firestore).
- `summarizeSellerPayable` y sus pruebas, si tras T7 no le quedan llamadores.

## 3. Arbol de modulos

| Archivo | Cambio | Responsabilidad |
|---|---|---|
| `functions/src/seller-retention.ts` | nuevo | `isOrderOnTheStreet`, `retentionForOrder` |
| `functions/src/seller-balance.ts` | nuevo | `buildSellerBalanceInput`, `computeSellerBalance`, `selectPayableOrders`, `selectSettlementEntries`, `payoutRejectionMessage` |
| `functions/src/seller-balance-api.ts` | nuevo | `loadSellerBalanceInput`, callable `getSellerBalance` |
| `functions/src/store-summary.ts` | nuevo | `buildStoreSummary` puro (sale de `store-api.ts`) |
| `functions/src/seller-ledger.ts` | toca | `buildCodReceivedSet` = regla del corte; retira `summarizeSellerPayable` si queda huerfana |
| `functions/src/orders.ts` | toca | `createSettlement` (definicion unica + `selectSettlementEntries`); `requestSellerPayout` |
| `functions/src/store-api.ts` | toca | lee ajustes y zonas; delega en `store-summary.ts` |
| `functions/src/index.ts` | toca | exporta `getSellerBalance` |
| `src/lib/types.ts` | toca | `pendingReserveCop` `@deprecated` |
| `src/lib/finance.ts` | toca | quita `sellerBalance` |
| `src/lib/actions.ts` | toca | quita el import muerto |
| `src/lib/firebase/auth.ts` | toca | `getFirebaseSellerBalance()` |
| `src/components/operations-app.tsx` | toca | usa `buildCodReceivedSet`/`isSellerEntryEligible` de servidor, fila del admin con `buildSellerBalanceInput`, `useSellerBalance`, heroe, `WalletPanel` |
| `src/lib/seller-retention.test.ts` | nuevo | RF_06, RF_07, RF_09–RF_11, RNF_02 |
| `src/lib/seller-balance.test.ts` | nuevo | RF_02, RF_05, RF_08, RF_12–RF_16, RF_23, RF_24, DoD 4, atadura RNF_01 |
| `src/lib/store-summary.test.ts` | nuevo | RF_25 |
| `src/lib/seller-ledger.test.ts` | toca | RF_04 |
| `src/lib/spec-018-guards.test.ts` | nuevo | guardas de fuente (RF_01, RF_07, RF_16–RF_18, RF_21, RF_22, rol logistico) |
| `src/lib/finance.test.ts` | toca | quita la prueba de la reserva fija |
| `scripts/verify-018.js` | nuevo | `baseline`, `query-check`, `compare` (solo lectura, via `functions/lib`) |
| `docs/rendimiento.md` | toca | linea base y medicion posterior (RNF_04) |

Ya no hay `src/lib/seller-liquidation-row.ts`: la parte que podia divergir (armar la entrada desde
documentos) vive en `buildSellerBalanceInput`, en `functions/src`, y el componente solo le pasa `state`.

Sin cambios en `firestore.rules` ni en indices salvo que T5 lo demuestre (y entonces se **anade**).

## 4. Algoritmos criticos

### 4.1 `computeSellerBalance`

```
liq = openEntries filtrados por SELLER_LIQUIDATION_TYPES
total = Σ liq
para e en liq:
  si isSellerEntryEligible(e, ordersById, codReceived): payable += e ; payableEntries.push(e)
  si no, si e.orderId y pedido COD entregado/liquidado sin efectivo: codPending += e
  si no: unreadable.push(e.id)
teorica = Σ retentionForOrder(o, ..., { fulfillmentAlreadyCharged }) para o en la calle
r = selectSettlementEntries({ payableCop: payable, retentionTheoreticalCop: teorica }, payableEntries)
available = r.selection.totalCop      (0 si r.ok === false)
held = payable − available
```

### 4.2 `selectSettlementEntries` — la unica regla del tope

```
si payable <= 0 o teorica <= 0:                 → ok, seleccion = todos los candidatos      (RF_15; sin retencion)
tope = payable − teorica
sel = selectPayableOrders(candidatos, tope)
si sel.totalCop <= 0:                            → no ok, "empty_by_retention"              (RF_14, RF_24)
                                                   (computeSellerBalance: available 0, held = payable)
si no:                                           → ok, sel
```

Notas:
- `payable` y `teorica` son siempre **de la tienda entera**; `candidatos` es todo lo pagable (saldo) o
  lo escogido (corte con rango, RF_23). Por eso la condicion de RF_15 se evalua sobre la tienda, no sobre
  lo escogido.
- Ejemplo del analisis: pagable 100.000 (abonos −500.000 y seis pedidos de 100.000), teorica 150.000.
  Tope −50.000; entran cuatro pedidos y la seleccion suma −100.000 → `empty_by_retention`: disponible 0,
  retenido 100.000, total cuadra, corte rechazado. La tienda no queda debiendo.
- ADMA (pagable −26.500): primera rama, todo entra, disponible −26.500 (deuda real), retenido 0.
- Tope 50.000 y positivos 30.000/30.000/10.000 → entra solo el primero.

### 4.3 Corte (`createSettlement`, tienda)

1. `balance = computeSellerBalance(await loadSellerBalanceInput(db, ownerId, now))`.
2. `candidatos` = asientos pagables del corte (rango o ids, como hoy, con la definicion unica).
3. `r = selectSettlementEntries(balance, candidatos)`; si `!r.ok` → `failed-precondition` con
   `payoutRejectionMessage(balance)`.
4. La transaccion cierra solo `r.selection.entryIds`. El monto de solicitudes abiertas no se lee (RF_17).

`orders.ts` no se prueba directamente: toda decision esta en `selectSettlementEntries` (probada en T4) y
T6 solo comprueba por guarda que se llama y que la transaccion itera sobre su resultado.

### 4.4 Dos cortes encadenados (DoD 4)

Tienda con pedidos A 40.000, B 30.000, C 20.000 (antiguedad A<B<C) y 2 en la calle (24.000). Corte 1:
tope 66.000 → A entra (40.000), B no cabe → B y C pendientes; paga 40.000. Los dos de la calle se
entregan (+2 netos de 25.000). Corte 2: teorica 0 → paga B + C + 50.000 = 100.000. Suma 140.000 ==
un solo corte con todo cerrado. Ningun pedido con asientos en dos cortes.

## 5. Estrategia de testing

- Vitest sin red; `functions/` se prueba desde `src/lib/*.test.ts` (principio 4). `now` inyectado.
- Fixtures locales (`order()`, `entry()`, `driverSettlement()`), nunca datos de produccion.
- **RNF_02:** igualdad `retentionForOrder` == cobro real de `buildWalletEntries` en tienda general, DANDA,
  comunidad con lider mayor y bodega (primera visita; y con asiento de manejo ya existente). Mutacion:
  12.000 literal en `seller-retention.ts` debe romper DANDA; registrado en
  `.sdd/evidence/018/mutacion-rnf02.txt`.
- **RNF_01:** mismos documentos → `computeSellerBalance(buildSellerBalanceInput(docs)).availableCop` ==
  `disponibleCop` de `buildStoreSummary` == suma de `selectSettlementEntries` con candidatos = todo lo
  pagable. La fila del admin es `buildSellerBalanceInput` con los arrays de `state`: la guarda de T10
  comprueba que el componente no calcula nada propio.
- **Servidor con Firestore:** cargador delgado, cubierto por guardas y por `verify-018.js`.
- **T13, comparacion en produccion** (JS puro sobre `functions/lib` compilado, sin `tsx`): para cada
  tienda, (a) camino del servidor: `loadSellerBalanceInput` con sus consultas acotadas; (b) camino del
  admin: las colecciones enteras que descarga el admin (`walletEntries`, pedidos activos + rescatados,
  `settlements`, zonas, ajustes) pasadas a `buildSellerBalanceInput`. Ambos a `computeSellerBalance`.
  Deben coincidir al peso: prueba que las consultas acotadas no pierden documentos. Ademas, `/sdd-verify`
  compara por Playwright la cifra en pantalla del admin con la del callable.
- **RNF_04:** Playwright Chromium en este servidor, perfil movil 390×844 y escritorio 1280×800, sobre
  **Bella Mujer**, con un usuario de tienda desechable vinculado a esa tienda, creado y borrado en la
  misma corrida (patron de `CLAUDE.md`, `signInWithPassword`); `kentro-perf` activo; mediana de 5
  cargas en frio. Antes (T1) y despues (T13), mismo guion.
- **Interfaz:** guardas de fuente + `/sdd-verify`.

## 6. Dependencias nuevas

Ninguna.

## 7. Orden de despliegue

1. Indices: ninguno previsto (T5 lo confirma).
2. **Functions** (`getSellerBalance`, `createSettlement`, `requestSellerPayout`, `storeApi`) con
   `ALLOW_FUNCTIONS_DEPLOY=1`, tras confirmar set local == prod.
3. **Hosting**, despues: el cliente nuevo llama a `getSellerBalance`.

## 8. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Unificar el efectivo recibido mueve cifras | T1 mide por tienda antes de cambiar |
| Asientos ilegibles bloquean el saldo de una tienda | T1 los cuenta; si hay, compuerta: decision del responsable antes de T5 (2.4) |
| La fila de proveedores del admin cambia con la definicion unica | T1 la mide (2.10) |
| Usuario desechable con acceso a la wallet de una tienda real | creado y borrado en la misma corrida; la evidencia no guarda la contrasena |
| Un pedido grande antiguo retiene a los nuevos | es la regla elegida (como proveedor); visible en "Retenido (N pedidos)" |
| Arranque en frio del callable | la tarjeta no bloquea el panel; medido en T13; si excede ±10 % se propone `minInstances: 1` |
| Cambia el valor de `disponibleCop` en la API para tiendas | campo nuevo `retenidoCop`; anotado en el informe |
| Lecturas por llamada cada 5 min | medidas en T13; si los cortes de domiciliario pasan de 500, se acotan |
| Doble cobro de manejo de bodega al reabrir | fuera de alcance, spec 019 |
