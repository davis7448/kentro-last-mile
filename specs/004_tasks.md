# Tareas 004: La base de una comunidad es lo que Kentro cobra de verdad

- **Spec:** `specs/004_base_de_comunidad_real.md` · **Plan:** `specs/004_plan.md`
- **12 tareas**, numeracion propia. Cada `it()` empieza por el identificador del requisito.
- **Cada tarea lleva su prueba en el alcance**: el hook deniega escrituras no-test mientras no haya
  prueba, y deniega cualquier archivo fuera del alcance — incluido el propio test.
- **Archivos compartidos entre tareas, a sabiendas** (hallazgo #7 del analisis): `community-pricing.ts`
  (T4, T5, T6, T7), `community-pricing.test.ts` (T4, T6, T7, T8), `seller-charges.test.ts` (T1, T2,
  T3, T6, T11, T12), `wallet-entries.ts` (T2, T5), `types.ts` (T5, T9), `operations-app.tsx` (T9,
  T10) y `community-view.test.ts` (T9, T10). Se acepta porque las tareas se ejecutan en orden estricto y cada una anade su
  bloque `describe` propio; ninguna reescribe el de otra.

## Orden, y por que

1. **Fijar el cobro de hoy antes de moverlo (T1).** RNF_01 exige "centavo a centavo". La unica
   forma honesta de probarlo es escribir la prueba con los importes de HOY, verla en verde contra el
   codigo viejo, y que siga en verde despues. Si se escribe despues del cambio, fija el cambio.
2. **Una sola regla antes de usarla (T2, T3).** Comunidades no puede leer una base que todavia
   tiene dos copias.
3. **El dinero antes que la pantalla (T4-T9).** El panel pinta lo que el cierre cobra; al reves se
   pintaria una regla que aun no existe.

---

## 1. Una sola regla de cobro

- [x] **T1: Caracterizar el cobro de hoy (sin tocar codigo)**
  * Requisitos: RNF_01
  * Archivos: `src/lib/seller-charges.test.ts` (nuevo)
  * Accion: importes literales de lo que generan HOY `buildWalletEntries` (servidor) y `entriesForClosedOrder` (app) para: tienda normal sin zona y con zona, entregado COD, fallido cobrable (1a y 2a visita, fallido 12.000 aunque ajustes y zona digan otra cosa), bodega, y DANDA antes/despues de sus cortes de fecha (flete 12.000/13.500, fallido 0, pago 10.000/11.000).
  * Ademas, **aparte y rotulado**, el unico caso donde servidor y app difieren hoy: un ajuste ausente o en 0. La app calcula `zone?.x || settings.x` (cobra 0); el servidor cae al valor por defecto. Es solo modo local (la app no escribe dinero con Firebase) y en produccion los ajustes estan completos, asi que no es un cobro real: T3 lo alinea con el servidor A PROPOSITO y cambia solo esa expectativa, diciendolo.
  * Verificacion: verde contra el codigo ACTUAL. Es la red de las tareas siguientes: si se pone rojo, se rompio RNF_01.

- [x] **T2: `seller-charges.ts`, la unica copia**
  * Requisitos: RF_01, RF_02, RNF_03
  * Archivos: `functions/src/seller-charges.ts` (nuevo), `functions/src/wallet-entries.ts`, `src/lib/seller-charges.test.ts`
  * Accion: mover `defaultSettings`, `tariffFields`, `resolveTariffs`, DANDA y `dandaDeliveredFeeCop`; crear `resolveSellerCharges` y `communityBase`. `buildWalletEntries` usa `resolveSellerCharges` y reexporta lo movido.
  * Verificacion: T1 sigue verde; `communityBase` de los ajustes de produccion da 12.000 / 12.000 / 2.000 sin zona y 12.000 / 12.000 / 2.500 con zona; guarda de fuente: `seller-charges.ts` no importa nada.

- [x] **T3: La app deja de tener su copia**
  * Requisitos: RF_02, RNF_01
  * Archivos: `src/lib/finance.ts`, `src/lib/finance.test.ts`, `src/lib/seller-charges.test.ts`
  * Accion: borrar `applySellerTariffOverrides` y las constantes DANDA de `finance.ts`; `entriesForClosedOrder` y `sellerDeliveredFeeForOrder` usan `resolveTariffs` + `resolveSellerCharges` de `functions/src/seller-charges`, pasando la fecha de la evidencia de entrega como hoy.
  * Verificacion: T1 y `finance.test.ts` verdes (salvo la expectativa rotulada del ajuste ausente, que cambia a proposito); guarda de fuente (DoD 3) sobre una **lista cerrada** de archivos —`src/lib/finance.ts` y `functions/src/wallet-entries.ts`—: ninguno define el fijo `sellerFailedFeeCop: 12000` ni las constantes DANDA (id de tienda, id de transportista, cortes de fecha). La lista no incluye `seed.ts` (datos de demostracion, no regla), `operations-app.tsx` ni los `scripts/correct-*.js` historicos, que usan el id de DANDA para otra cosa; `community-order-pricing.ts` entra en la guarda en T6; mismo pedido **sin comunidad** => mismo cobro en servidor y app (la app ignora `communityPricing` y solo escribe dinero en modo local, asi que la paridad se afirma donde existe).

## 2. El dinero de una comunidad

- [x] **T4: Congelar el precio del lider y cobrar la base del cierre (nucleo)**
  * Requisitos: RF_03, RF_04, RF_06, RF_11, RNF_03
  * Archivos: `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `FrozenPricing` gana `pricingVersion: 2` y `leader<X>FeeCop` opcionales; `freezeOrderPricing` los registra solo si la comunidad cobra precio propio; `communityChargeAtClose(frozen, base)` nace AL LADO de `cashbackForFrozenPricing` (legado sin version => `seller<X>` como precio del lider). **No la borra**: su llamador es `wallet-entries.ts`, que no esta en esta tarea; la retira T5. Lo que SI hace T4 es migrar a `communityChargeAtClose` las ~17 aserciones de `community-pricing.test.ts` que usan `cashbackForFrozenPricing` (lineas 48, 64-66, 123, 644, 962-1086), para que T5 pueda retirarla sin tocar ese archivo. Las de las lineas 1062-1067 y 1086 (`cashbackForFrozenPricing.length === 1`, "un cierre no puede recalcular") **cambian de intencion a proposito**: afirmaban RF_22 de la 001, que RF_11 de la 004 reemplaza en la base; se reescriben rotuladas como tales, afirmando lo nuevo (el precio del lider no se recalcula; la base si).
  * Verificacion: tabla de la spec — sin precio propio (base, 0), manejo 2.300 sin zona (2.300 / 300) y con zona (2.500 / 0), base que sube y que baja entre crear y cerrar, pedido legado con 9.000 (cobra 12.000, 0), sin lider o desactivada al crear (base, 0). Nunca cashback negativo.

- [x] **T5: El cierre usa el nucleo**
  * Requisitos: RF_04, RF_06, RF_11, RNF_01
  * Archivos: `functions/src/wallet-entries.ts`, `functions/src/community-pricing.ts`, `src/lib/types.ts`, `src/lib/community-cashback-entries.test.ts`, `src/lib/order-corrections-plan.test.ts`
  * Accion: en `buildWalletEntries`, la base del cierre sale de `resolveSellerCharges` (misma que sin comunidad) y cobro + cashback de `communityChargeAtClose`. Se retira `cashbackForFrozenPricing`, que queda sin llamadores. `OrderCommunityPricing` refleja los campos nuevos.
  * Verificacion: los asientos de un pedido de comunidad cerrado como fallido: cobro 12.000, sin asiento de cashback; ids deterministas intactos; una correccion fallido->entregado recalcula con la base del momento de la correccion (caso limite). T1 verde.

- [x] **T6: El sello del pedido y las dos callables**
  * Requisitos: RF_03, RF_05, RF_10, RF_12, RF_02
  * Archivos: `functions/src/seller-charges.ts` (solo exportar el conjunto de tiendas con tarifa especial, hoy privado — anadido en ejecucion), `functions/src/community-pricing.ts`, `functions/src/community-order-pricing.ts`, `functions/src/communities.ts`, `src/lib/community-pricing.test.ts`, `src/lib/seller-charges.test.ts`
  * Accion: `validateCommunityPriceFloor(field, amountCop, base)` puro con el mensaje de RF_05 + aviso de zona (RF_12); `scheduleCommunityPrice` lo usa con `communityBase(resolveTariffs(settings))`; `getMyStoreTariff` y el sello del pedido pasan `communityBase(...)`. `community-order-pricing.ts` deja de definir su propio conjunto de tiendas con tarifa especial e importa el de `seller-charges`.
  * Verificacion: 12.000 de fallido valido, 11.999 rechazado nombrando $12.000 y la zona; guarda de fuente: las tres entradas usan `communityBase` y ninguna lee `settings[field]` crudo; la guarda de "una sola copia" de T3 se amplia a `community-order-pricing.ts`.

## 3. El piso

- [x] **T7: Elevar al piso real, escuchando los ajustes que existen**
  * Requisitos: RF_13
  * Archivos: `functions/src/community-pricing.ts`, `functions/src/community-floor-writer.ts` (nuevo), `functions/src/community-floor-trigger.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `raisedCommunityFloors(before, after)` sobre `communityBase(resolveTariffs(...))`; `planRaiseToFloors` (la parte por comunidad de hoy); `planFloorRaise` = composicion; el trigger escucha `settings/global` y escribe via el writer.
  * Verificacion: subir el fallido en ajustes (9.000 -> 11.000) no eleva nada; subir la entrega si, y el plan lleva **el aviso al lider (`floorRaisedAt.<campo>`) y la entrada de historial** de cada concepto elevado; guardar sin cambiar tarifas no escribe; guarda de fuente de la ruta `settings/global`. El writer importa `firebase-admin` y no es probable en unidad (declarado en el plan §4): una guarda de fuente comprueba que copia `communityUpdate` entero —`floorRaisedAt` incluido— y recorre `historyEntries`, para que el aviso no se pierda entre el plan y Firestore. Los casos T47 existentes siguen verdes.

- [x] **T8: La pasada unica (RF_14)**
  * Requisitos: RF_14
  * Archivos: `scripts/raise-community-floors.js` (nuevo), `src/lib/community-pricing.test.ts`
  * Accion: en seco por defecto, `--apply` escribe via `functions/lib/community-floor-writer`; `planRaiseToFloors` con `communityBase(resolveTariffs(settings/global))`.
  * Verificacion: la pasada sobre un precio por debajo de la base produce el mismo aviso e historial que el trigger (RF_14 "con el mismo aviso e historial"); prueba de idempotencia (dos pasadas => segunda vacia, sin segundo aviso) y guarda de fuente (seco por defecto, usa el plan puro y el mismo writer que el trigger). Contra produccion, en seco, tras compilar: 0 cambios (E-master no tiene precios propios).

## 4. Lo que se ve

- [x] **T9: La fila del panel del administrador (nucleo)**
  * Requisitos: RF_07, RF_08, RF_09, RF_15, RF_12, RF_02, RNF_02
  * Archivos: `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `src/components/operations-app.tsx`, `src/lib/types.ts`
  * Accion: `buildAdminCommunityList` recibe `nowIso` y la tarifa global entera. En `operations-app.tsx` solo lo minimo para que la raiz compile al cerrar la tarea: su UNICA llamada (`:4701`, que ya pasa `nowIso` y `state.settings`: el parametro es obligatorio, porque el nucleo recibe el instante y no lo inventa) y las tres lecturas de `:4817-4819`, que pasan a `row.pricing.<X>.chargedCop`; el rediseno del JSX es de T10. `Community` en `types.ts` declara `leaderUid` (`scheduled` ya existe; en ejecucion `leaderUid` ya llega: `state-store.ts` copia el documento entero). La base del panel sale de `communityBase(resolveTariffs(settings))` importado de `functions/src/seller-charges`, nunca de un calculo propio. `baseOnlyReason` usa el MISMO criterio que `chargesOwnPricing` (estado distinto de `active` => desactivada; uid recortado vacio => sin lider); por concepto `chargedCop` (via `resolveCommunityPricing`), `baseCop`, `marginCop`, `source`, `upcoming`; `baseOnlyReason`. Exporta `ZONE_BASE_NOTICE`.
  * Verificacion: E-master de hoy => los tres en `base`, fallido 12.000; precio propio con programada futura (no se suma); programada vencida (si se suma); desactivada o sin lider con precio guardado => base + motivo; **uid de lider en blanco (`"   "`) => base Y motivo "sin lider"** (si el panel no usara el recorte, cobraria la base sin decir por que); la entrada solo son comunidades y ajustes (RNF_02). **Guarda de fuente (DoD 3, RF_02):** `community-view.ts` importa `communityBase` de `seller-charges` y no define el fijo `12000` ni una base propia — la prueba de "fallido 12.000" sola pasaria con un literal escrito a mano.

- [x] **T10: La pantalla**
  * Requisitos: RF_07, RF_08, RF_09, RF_10, RF_12, RF_15
  * Archivos: `src/components/operations-app.tsx`, `src/lib/community-view.test.ts`
  * Accion: la tarjeta de comunidades pinta rotulo, margen, subida aparte, motivo y `ZONE_BASE_NOTICE`; "Tu tarifa" anade `ZONE_BASE_NOTICE` (el `nowIso` ya lo pasa T9). Ninguna cifra se calcula en el JSX.
  * Verificacion: guardas de fuente (los dos componentes usan `ZONE_BASE_NOTICE`; el JSX lee `row.pricing.*.chargedCop` y no `community.pricing`); `npm run lint` sin errores.

## 5. Cierre

- [x] **T11: Guion del smoke en produccion (DoD 5)**
  * Requisitos: RF_11, RNF_01 (evidencia real)
  * Archivos: `scripts/smoke-004.js` (nuevo), `src/lib/seller-charges.test.ts`
  * Accion: pasos `count` / `create` / `close` / `check` / `cleanup` / `compare`, cada uno idempotente desde los ids del anterior; transportista desechable; antes de borrar comprueba que ningun asiento esta en un corte, y si lo esta no borra nada. `count` guarda la posicion de la plataforma y el saldo de la tienda "Prueba"; `compare` los vuelve a calcular tras `cleanup` y falla si no coinciden (DoD 5, ultimo punto).
  * Verificacion: guardas de fuente (la limpieza exige la comprobacion de cortes antes de borrar; existe el paso `compare` contra las cifras de `count`). `count` es de solo lectura y se ejecuta **antes** de desplegar (DoD 5, primer punto; plan §7 paso 0); el resto, despues del despliegue firmado por el humano.

- [x] **T12: Verificacion completa**
  * Requisitos: todos (DoD 1-4)
  * Archivos: `src/lib/seller-charges.test.ts`
  * Accion: `npm test`, `npx tsc --noEmit` en raiz y `functions/`, `npm run lint`, `npm run build` en raiz y `functions/`.
  * Verificacion: todo en verde; cualquier rojo vuelve a su tarea.

- [x] **T13: La proteccion de DANDA, atada a una prueba** (abierta tras `/sdd-audit`)
  * Requisitos: RF_01, RF_03 (caso limite "Tienda con tarifa especial en codigo (DANDA)")
  * Archivos: `functions/src/seller-charges.ts`, `functions/src/community-order-pricing.ts`, `src/lib/seller-charges.test.ts`
  * Accion: extraer el rechazo a una funcion pura en `seller-charges.ts` (p.ej. `assertSellerCanJoinCommunity(sellerId)`) que LANZA con el mensaje de hoy, y que el sello la llame.
  * Verificacion: la auditoria encontro que la unica guarda exigia una llamada a `.has(sellerId)`: cambiar el `throw` por un `return {}` la dejaba en verde, y la spec dice que esa proteccion "MUST mantenerse: esta spec no la relaja". Ahora una prueba de comportamiento afirma que lanza para la tienda DANDA y no lanza para una normal.

---

## Cobertura: requisito -> tarea

| Req | Tarea | Req | Tarea |
|---|---|---|---|
| RF_01 | T2 | RF_09 | T9, T10 |
| RF_02 | T2, T3, T6, T9 | RF_10 | T6, T10 |
| RF_03 | T4, T6 | RF_11 | T4, T5, T11 |
| RF_04 | T4, T5 | RF_12 | T6, T9, T10 |
| RF_05 | T6 | RF_13 | T7 |
| RF_06 | T4, T5 | RF_14 | T8 |
| RF_07 | T9, T10 | RF_15 | T9, T10 |
| RF_08 | T9, T10 | RNF_01 | T1, T3, T5, T11 |
| | | RNF_02 | T9 |
| | | RNF_03 | T2, T4 |

Ningun requisito huerfano.
