# Tareas 003: Una persona, su tienda y su comunidad

- **Spec:** `specs/003_doble_rol.md` · **Plan:** `specs/003_plan.md`
- **15 tareas**, numeracion propia. Cada `it()` empieza por el identificador del requisito.
- **Cada tarea lleva su prueba en el alcance**: el hook deniega escrituras no-test mientras no haya
  prueba, y deniega cualquier archivo fuera del alcance — incluido el propio test.
- Segunda version, tras `/sdd-analyze`: se fundieron dos tareas, se partieron dos pozos, y cuatro
  requisitos que estaban huerfanos de facto tienen dueno.

## Orden, y por que

1. **La no regresion primero.** Esto lo pidio un papel y lo usan seis; romper a los otros cinco seria
   un precio que nadie acepto.
2. **La migracion antes que la regla de precio.** Desplegar RF_20 sin `leaderUid` relleno convierte
   **todas** las comunidades vivas en comunidades sin lider: tarifa base y cashback cero, sin error y
   sin aviso.
3. **El alcance de descarga, el ultimo de los tecnicos.** Es el que toca dinero.

---

## 1. Que los seis papeles de hoy sigan funcionando

- [ ] **T1: Los predicados dejan de mirar el rol**
  * Requisitos: RF_01, RF_02, RF_03, RNF_01
  * Archivos: `functions/src/community-access.ts`, `src/lib/community-access.test.ts`
  * Accion: `isLeaderOf` comprueba **solo** el vinculo de comunidad. De el cuelgan **cuatro** predicados —`canEditCommunityPricing`, `canEditCommunityBrand`, `canReadCommunityStats` y, por el primero, `canEditTariffConcept`—, no trece: el archivo exporta trece booleanos pero los otros nueve no dependen del candado.
  * **Y el que mas importa no se arregla ahi:** `canReadSellerOperational` comprueba el rol **a mano y con retorno anticipado**, asi que una tienda-lider entra por la rama de vendedor y devuelve `false` para todas las tiendas de su comunidad. Hay que reescribirlo como **union de los dos derechos**, no como cadena de exclusion.
  * Verificacion: **tabla exhaustiva de no regresion (RNF_01) sobre los SEIS papeles** —`community_leader` incluido; `TODOS_LOS_ROLES` ya existe en el archivo de pruebas y fuerza a `tsc` a cubrir la union—. Cada uno, con reclamos sin `communityId`, obtiene exactamente los mismos permisos que antes.

- [ ] **T2: Liderar no es lo mismo que ser acreedor**
  * Requisitos: RF_23, RF_22
  * Archivos: `functions/src/community-access.ts`, `functions/src/communities.ts`, `functions/src/community-stats.ts`, `src/lib/community-access.test.ts`
  * Accion: `communityStanding: "leader" | "creditor"` en el `Actor`. El primero causa cashback y gobierna precios; el segundo **solo ve y cobra lo ya causado**.
  * **Alcance ampliado tras el analisis:** el `Actor` se construye en **dos** sitios —`communities.ts` (`actorFrom`) y `community-stats.ts`, este ultimo **inline**—. Sin tocar los dos, un acreedor seguiria pasando `canReadCommunityStats`, que es justo lo que RF_23 prohibe.
  * Verificacion: un acreedor no cambia un precio ni causa cashback, y **si** ve sus cortes pendientes.

## 2. Conceder, traspasar y retirar

- [ ] **T3: Conceder el liderazgo, incluido el traspaso**
  * Requisitos: RF_04, RF_06, RF_17, RF_18, RF_19
  * Archivos: `functions/src/community-grant.ts` (nuevo), `src/lib/community-grant.test.ts` (nuevo)
  * Accion: `planLeadershipGrant`, puro. El traspaso **no es otra funcion**: es el caso en que la comunidad ya tiene lider, y produce dos efectos —degradar al anterior a acreedor, promover al nuevo—. Fundida con la que era T4, porque el propio plan decia que salia del mismo algoritmo.
  * Verificacion: **el aserto que mas vale de toda la spec** — el plan **nunca toca** `sellerId`, `driverId` ni `messengerId` del destino (RF_04). Barrido sobre el plan entero, como en la 001. Una cuenta que ya lidera otra se rechaza diciendo cual (RF_06). En el traspaso, el cashback del anterior queda **integro** y el nuevo empieza en cero (RF_19).

- [ ] **T4: Retirar el liderazgo**
  * Requisitos: RF_05, RF_22
  * Archivos: `functions/src/community-grant.ts`, `src/lib/community-grant.test.ts`
  * Accion: `planLeadershipRevoke`. Con deuda cero el vinculo se elimina; **con deuda queda como acreedor**.
  * Verificacion: la cuenta queda operando **exactamente** como antes de recibir el liderazgo, y `leaderUid` sale del documento de la comunidad en los dos casos.

- [ ] **T5: El acreedor deja de serlo cuando se le paga**
  * Requisitos: RF_23, RF_11
  * Archivos: `functions/src/community-grant.ts`, `functions/src/orders.ts`, `src/lib/community-grant.test.ts`
  * Accion: al marcarse pagado el ultimo corte pendiente de un acreedor, el vinculo se extingue.
  * **Sin esto RF_23 esta a medias:** la deuda se evalua solo en el instante de retirar, asi que nada degrada el vinculo cuando se paga despues — y esa cuenta se queda con el selector de RF_11 para siempre.

## 3. La comunidad sin lider

- [ ] **T6: `leaderUid` en el documento de la comunidad**
  * Requisitos: RF_17
  * Archivos: `functions/src/communities.ts`, `functions/src/community-grant.ts`, `src/lib/community-grant.test.ts`
  * Accion: el alta y la concesion escriben `leaderUid`; retirar lo quita.
  * Verificacion: `grep leaderUid` da hoy **cero resultados** en todo el repositorio. Es un campo nuevo, no uno que se lea mal.

- [ ] **T7: Rellenar `leaderUid` en las comunidades que ya existen**
  * Requisitos: RF_20 (precondicion)
  * Archivos: `scripts/backfill-leader-uid.js` (nuevo), `docs/migraciones.md` (nuevo)
  * Accion: recorrer las comunidades vivas y escribir su `leaderUid` a partir de los reclamos de sus lideres.
  * **Va ANTES que T8 en produccion, y no es negociable.** Desplegar la regla de precio sin esto convierte todas las comunidades en comunidades sin lider: **tarifa base y cashback cero en cada pedido nuevo, sin error y sin aviso**. Regla de oro #5.
  * Verificacion: en seco primero; contar cuantas se tocarian y compararlo con las que hay.

- [ ] **T8: Una comunidad sin lider cobra tarifa base**
  * Requisitos: RF_20, RF_21, RF_12
  * Archivos: `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: sin `leaderUid` **o con la comunidad desactivada**, `resolveCommunityPricing` devuelve la base — **comprobado antes que el piso**.
  * Verificacion: si se comprobara despues, una comunidad sin lider con precio propio por encima **seguiria cobrando de mas**. Y lo de "desactivada" no es adorno: `planLeaderStatusChange` declara que no toca nada mas que el estado, asi que sin esta comprobacion una comunidad desactivada sigue cobrando sobreprecio. Lo ya congelado no cambia (RF_21). **RF_12** entra aqui: la tienda del propio lider causa cashback como cualquier otra, sin rama especial.

## 4. Las tres capas del servidor

- [ ] **T9: Las callables de conceder y retirar**
  * Requisitos: RF_17, RF_05
  * Archivos: `functions/src/communities.ts`, `functions/src/roles.ts`, `src/lib/community-grant.test.ts`
  * Accion: `grantCommunityLeadership` y `revokeCommunityLeadership` sobre los planes puros, con la reversion de la spec 001 RF_55. Y **`setUserRole` Y `createManagedUser` dejan de borrar `communityId`**: las dos reescriben los reclamos con el mismo patron, y el analisis encontro que la primera version solo nombraba una.
  * Verificacion: cambiar el papel operativo de alguien **no** le quita la comunidad. Sesion real con usuario desechable.

- [ ] **T10: Las reglas de Firestore y de Storage**
  * Requisitos: RNF_02
  * Archivos: `firestore.rules`, `storage.rules`, `src/lib/community-access.test.ts`
  * Accion: `isCommunityLeader()` y `sellerInMyCommunity()` en Firestore, **y `isCommunityLeaderOf()` en `storage.rules`**, dejan de exigir el rol.
  * **Son TRES capas, no dos.** Sin la de Storage, una tienda-lider pasa el predicado y la callable de logo, y Storage la deniega igual. Y al quitar el rol hay que **exigir que `communityId` exista y no sea vacio** en los dos lados: `isCommunityLeader` gobierna lecturas de `walletEntries` y `settlements`, asi que sin esa guarda se abren lecturas de dinero a cuentas sin comunidad.
  * Verificacion: sesion real, no Vitest.

## 5. La pantalla

- [ ] **T11: El nucleo del selector**
  * Requisitos: RF_07, RF_10, RF_11
  * Archivos: `src/lib/session-hats.ts` (nuevo), `src/lib/session-hats.test.ts` (nuevo)
  * Accion: `availableHats`, `defaultHat`, `shouldShowHatSelector`. Puro, sin React.
  * Verificacion: sin selector para quien tiene un solo papel, **salvo que arrastre una deuda de uno anterior** (RF_11, y por eso T5 existe).

- [ ] **T12: La sesion con dos identidades**
  * Requisitos: RF_07, RF_10
  * Archivos: `src/components/operations-app.tsx`, `src/lib/session-hats.test.ts`
  * Accion: `Session` —que vive **aqui**, en la linea 177, no en `types.ts`— gana `ledCommunityId` y `communityStanding`; `profileId` pasa a ser **solo** la identidad operativa. Se reescribe el calculo de la sesion a partir de los reclamos.
  * Verificacion: hoy `profileId` significa cosas distintas segun el rol —para un lider **es su comunidad**— y una cuenta con dos papeles tiene dos identidades y una sola casilla. Los consumidores a los que llega el cambio estan enumerados en el plan; ninguno puede quedarse leyendo un `profileId` que ya no significa lo que creia.

- [ ] **T13: El selector y el reparto de vistas**
  * Requisitos: RF_07, RF_08, RF_09
  * Archivos: `src/components/operations-app.tsx`, `src/lib/session-hats.test.ts`, `src/lib/community-access.test.ts`
  * Accion: el selector en pantalla y el despacho de vistas segun el sombrero. **El sombrero no viaja al servidor.**
  * Verificacion: como lider no se ve el detalle de un pedido, ni el cliente, ni el saldo de **ninguna** tienda, **incluida la suya** — es regla de **presentacion**, no de autorizacion (RF_09), y por eso se prueba tambien en el lado del servidor: que **el sombrero no concede**. Guarda de fuente que ate que la pantalla usa el nucleo de T11 y no una copia. Partida de la que era T10, que era un pozo de 2-4 h sobre un archivo de 7.500 lineas.

## 6. El dinero

- [ ] **T14: Lo que baja el navegador**
  * Requisitos: RF_15, RF_16, RNF_03
  * Archivos: `src/lib/firebase/state-store.ts`, `src/lib/state-store-targets.test.ts` (nuevo)
  * Accion: los objetivos del lider se **suman** a los del papel operativo. **No es un solo sitio**: la suscripcion, la carga inicial, y `getOrdersForContext`, `getWalletForContext` y `getSettlementsForContext`, que ramifican por rol **con retornos anticipados**.
  * Verificacion: para un vendedor-lider gana hoy la rama de vendedor, asi que **los cortes del lider no llegarian en el primer pintado aunque el listener si los traiga** — la divergencia exacta que el CLAUDE.md avisa. Principio 8: antes de tocar una descarga, comprobar que cifra depende de lo que se toca; un recorte mal hecho no falla ni avisa, y ya paso una vez con $1.135.720. Se afirma que **no se pierde ninguna cifra**, que el total es **como mucho la suma** (RF_16) y que cambiar de sombrero lee **cero documentos** (RNF_03).

- [ ] **T15: El cashback de su propia tienda, a la vista**
  * Requisitos: RF_13, RF_14, RF_24
  * Archivos: `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: el reparto de cuanto cashback procede de la tienda del propio lider, y el aviso al administrador cuando un lider cambia un precio que le afecta a el mismo.
  * Verificacion: la tienda del lider cuenta como una mas en los totales (RF_14) — excluirla haria que no cuadraran con los cortes. El plazo de aviso de subida se le aplica **sin excepcion** (RF_24). **Permitirlo y esconderlo son cosas distintas.**

---

## Cobertura: requisito → tarea

| Req | Tarea | Req | Tarea |
|---|---|---|---|
| RF_01 | T1 | RF_15 | T14 |
| RF_02 | T1 | RF_16 | T14 |
| RF_03 | T1 | RF_17 | T3, T6, T9 |
| RF_04 | T3 | RF_18 | T3 |
| RF_05 | T4, T9 | RF_19 | T3 |
| RF_06 | T3 | RF_20 | T7, T8 |
| RF_07 | T11, T12, T13 | RF_21 | T8 |
| RF_08 | T13 | RF_22 | T2, T4 |
| RF_09 | T13 | RF_23 | T2, T5 |
| RF_10 | T11, T12 | RF_24 | T15 |
| RF_11 | T11, T5 | RNF_01 | T1 |
| RF_12 | T8 | RNF_02 | T10 |
| RF_13 | T15 | RNF_03 | T14 |
| RF_14 | T15 | | |

**Los 27 requisitos con tarea. Sin huerfanos.**

## Lo que cambio respecto a la primera version

| Hallazgo del analisis | Correccion |
|---|---|
| `isLeaderOf` no gobierna trece predicados sino cuatro, y `canReadSellerOperational` rompe aparte | Accion de T1 reescrita |
| `storage.rules` es una tercera capa que nadie tenia en alcance | Entra en T10 |
| `leaderUid` no existe y desplegarlo sin migrar apaga el cashback de todas | T6 lo crea, **T7 lo rellena antes** |
| Una comunidad desactivada seguiria cobrando sobreprecio | T8 mira las dos cosas |
| `Session` no vive en `types.ts` sino en `operations-app.tsx:177` | T12 re-cortada |
| `createManagedUser` tambien borra `communityId` | T9 lo incluye |
| El `Actor` se construye tambien en `community-stats.ts`, inline | T2 lo incluye |
| RF_12 estaba huerfano de facto | T8 |
| El acreedor no dejaba de serlo nunca | **T5, nueva** |
| T3+T4 eran el mismo algoritmo | Fundidas |
| T10 y T11 eran pozos de 2-4 h | Partidas en T12/T13 y acotada T14 |
| RNF_01 decia cinco papeles; son seis | Corregido |
