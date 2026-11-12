# Plan — Spec 023

## Fase A — hecha y desplegada (2026-11-10)

`functions/src/store-api-range.ts` y `store-api.ts`. Pruebas: `src/lib/spec-023-store-api-range.test.ts`.
Comparación contra producción: `scripts/verify-023.js compare`. Evidencia: `.sdd/evidence/023/`.
PR: davis7448/kentro-last-mile#9. Desplegado solo `storeApi` (revisión `storeapi-00035-rah`), sin `minInstances`.

## Fase B — el admin no descarga `walletEntries` entera

Inventario hecho el 2026-11-10 en modo solo lectura: cuentas con `count()` contra producción y lectura de los 110 cortes.

### Hallazgos que cambian el planteamiento

1. **`getPlatformPosition` no ahorra lecturas tal como está.** Hace `db.collection("walletEntries").get()`
   (`functions/src/platform-position.ts:113-116`), es decir, unas 19.425 lecturas por llamada. Hay que reescribir su
   carga con `sum()` y `count()`. `computePlatformPosition`, que es puro y está atado por la prueba, se conserva.
2. **Hay 7 asientos sin `settlementId`** (19.425 en total: 1.087 con el campo vacío y 18.331 con valor).
   `where("settlementId","==","")` los perdería en silencio. Lo mismo pasa con 1 `product_cost` sin
   `supplierSettlementId`. **Antes de recortar nada hay que correr `scripts/backfill-wallet-settlement-flag.js`.**
3. **Un listener caído deja hoy todo en $0 sin avisar.** El error de `onSnapshot` solo hace `console.warn`
   (`state-store.ts:830`). Tiene que pasar a `LoadReport.issues`, y las tarjetas de dinero tienen que decir
   «no disponible» (RF_04).
4. **`getDocumentsByIds` se traga los errores** (`state-store.ts:1015`). Hacen falta lecturas estrictas nuevas.
5. **`docs/rendimiento.md` está desactualizado en dos puntos.** `orderCashToReturnCop` no existe; lo que hay es
   `cashToReturnCop` de `buildLiquidationRows`. Y `receivedDriverOrderIds` ya fue reemplazado por
   `buildCodReceivedSet(state.settlements)`.

### Consumidores de `state.wallet` con rol admin, y cómo se alimentan

| # | Consumidor | Necesita | Nueva fuente |
|---|---|---|---|
| 1 | `PlatformPositionCard`, `CashReconciliationCard` (`operations-app.tsx:9807`, `:9851`). Además escribe `expectedCop` en `cashSnapshots` | Histórico | `getPlatformPosition` con agregados. Si falla, error y botón de cuadre deshabilitado |
| 2 | Filas de domiciliario de `LiquidationsPage` (`:7963`, `getRelatedSellerEntries`) | Asientos de tienda de esos pedidos, aunque estén liquidados | Lectura estricta `orderId in` al montar la página |
| 3 | `selectOpenWalletEntries` (`:7932`) | Asientos sin liquidar, más `product_cost` sin pagar al proveedor | Suscripción Q1, más Q2 (4.109) mientras la página está abierta |
| 4 | `sellerBalanceFromState` (`:9169`) | Q1, más `fulfillment_fee` liquidados de pedidos de bodega en la calle | Lectura por id, igual que `seller-balance-api.ts:42` |
| 5 | «Periodo»: `summarizeWalletPeriod`, `buildStoreLiquidationRows` (`:8003`) | Asientos del rango | Bajo demanda por `createdAt`, con nuevo filtro `isEntryInRange`. «Acumulado» relee todo solo si se pulsa, y lo avisa |
| 6-8 | `SettlementsTable`, `ClosedSettlementDetail` y el respaldo de `settlementFinancialView` (`:10022`, `:10142`, `:10406`) | Asientos de los 10 cortes visibles | Por página: `orderId in` más `documentId in` de los `walletEntryIds` que falten (unos 2.600). Sin asientos no se pinta la cifra |
| 9 | `WalletPage` del admin (`:7162`) | Libro filtrado | Saldo con `sum()`, lista con `fetchWalletHistoryPage`. El Excel de «todos» se lee solo al pulsarlo |
| 10 | `buildAdminCommunityList` (`:4695`) | Cashback causado | Agregado `sum` por comunidad |
| 11 | Exportes (`order-export.ts:133`) | Asientos de los pedidos exportados | Lectura estricta al pulsar. Si falla, el export se aborta |
| 12 | **Escritura**: `buildMissingProductCostEntries` (`product-catalog.ts:87`) | Asientos **liquidados** de los candidatos | Lectura estricta antes de construir. Sin ella cobraría dos veces y pisaría asientos liquidados |
| 13 | Siembra de `pinOrders` (`state-store.ts:770`) | Q1 | Sin cambios |

### Lo que lee la carga inicial del admin

En `walletEntries` pasa de **19.425 a 1.087**, y esa cifra no crece con el histórico (RNF_02). Lo demás solo se lee
al abrir la pantalla que lo necesita:

| Pantalla | Lecturas extra |
|---|---|
| Liquidaciones | unas 4.500 |
| «Cerradas» | unas 2.600 por página |
| `getPlatformPosition` | unas 650, frente a las 19.535 de hoy |

Además, `getCashOutstanding` se pide al montar la vista y cuesta unas 4.120 lecturas por llamada. Hay que cachearla.

### CQRS y GraphQL

- **Proyecciones materializadas: no hacen falta.** Los agregados de Firestore (1 lectura por cada 1.000 entradas de
  índice), junto con las lecturas bajo demanda y los callables que ya existen, cubren del RF_01 al RF_06. Mantener
  proyecciones con disparadores obligaría a reconciliarlas cada vez que se cierra o se corrige un corte.
- **GraphQL no reduce lecturas**, porque Firestore cobra por documento y no por campo. El responsable pidió mantenerlo
  como opción. Si se adopta, primero se documenta en `docs/research/graphql.md` con el protocolo de dependencias y
  se aprueba antes de instalar nada. Este plan no lo necesita.

### Orden de trabajo

1. Correr el backfill de `settlementId` y `supplierSettlementId`, y añadir a `verify-023.js` la comparación de las 15
   cifras (lectura completa frente a agregados).
2. Pasar `getPlatformPosition` a agregados: prueba, comparación contra producción, y despliegue de índices antes que
   de functions.
3. Añadir las lecturas estrictas y llevar los errores del listener a `LoadReport`.
4. Cambiar la suscripción y `getWalletForContext` a la vez.
5. Migrar los consumidores en este orden: #12, Liquidaciones (#2-#8), Periodo, Wallet, comunidades y exportes.
6. Escribir las guardas `023/RF_xx`, medir antes y después, y añadir capturas de las mismas cifras (DoD 5).

### Riesgos y guarda de cada uno

| Riesgo | Guarda |
|---|---|
| Asientos sin indicador | Backfill, y en el callable `count(total) == count("") + count(>"")` |
| Listener caído | `LoadReport` y estado «no disponible» |
| Lecturas que se tragan el error | Funciones estrictas y una guarda de texto |
| Neto de domiciliario en «Cerradas» | Sin asientos cargados no hay cifra |
| Doble cobro de producto | Lectura estricta antes de escribir |
| `sum()` sin `Math.round` por asiento | `compare` peso por peso y detección de `amountCop` no enteros |
| Nombre del proveedor | Se toma del documento `suppliers` y se compara |
