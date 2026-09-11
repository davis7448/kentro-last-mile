# Tareas 003: Una persona, su tienda y su comunidad

- **Spec:** `specs/003_doble_rol.md` · **Plan:** `specs/003_plan.md`
- 12 tareas, numeracion propia. **Cada `it()` empieza por el identificador del requisito.**
- **Cada tarea lleva su prueba en el alcance**: el hook deniega escrituras no-test mientras no haya
  prueba, y deniega cualquier archivo fuera del alcance — incluido el propio test.

## Orden, y por que

El plan lo fija: **la no regresion de los cinco papeles actuales va primero**. Esta funcionalidad la
pidio uno y la usan cinco; romper a los otros cuatro seria un precio que nadie acepto.

---

- [ ] **T1: Los predicados dejan de mirar el rol, sin romper a nadie**
  * Requisitos: RF_01, RF_02, RF_03, RNF_01
  * Archivos: `functions/src/community-access.ts`, `src/lib/community-access.test.ts`
  * Accion: `isLeaderOf` comprueba **solo** el vinculo de comunidad, no el rol. Los trece predicados que cuelgan de el quedan arreglados de golpe. Se anaden `leadsCommunity` e `isCreditorOf`.
  * Verificacion: **tabla exhaustiva de no regresion (RNF_01)** — cada uno de los cinco papeles actuales, con reclamos **sin** `communityId`, obtiene exactamente los mismos permisos que antes. Si alguien rompe uno, la tabla dice cual. Y un vendedor **con** `communityId` pasa a liderar sin dejar de vender.

- [ ] **T2: Liderar no es lo mismo que ser acreedor**
  * Requisitos: RF_23, RF_22
  * Archivos: `functions/src/community-access.ts`, `src/lib/community-access.test.ts`
  * Accion: `communityStanding: "leader" | "creditor"`. El primero causa cashback nuevo y gobierna precios; el segundo **solo ve y cobra lo ya causado**.
  * Verificacion: un acreedor no puede cambiar un precio ni causar cashback, y **si** ve sus cortes pendientes. Retirar el liderazgo no puede borrar una deuda.

- [ ] **T3: Conceder el liderazgo**
  * Requisitos: RF_04, RF_06, RF_17, RF_18
  * Archivos: `functions/src/community-grant.ts` (nuevo), `src/lib/community-grant.test.ts` (nuevo)
  * Accion: `planLeadershipGrant`. Puro.
  * Verificacion: **el aserto que mas vale de toda la spec** — el plan **nunca toca** `sellerId`, `driverId` ni `messengerId` del destino (RF_04). Barrido sobre el plan entero, como en la 001. Y una cuenta que ya lidera otra comunidad se rechaza diciendo cual (RF_06).

- [ ] **T4: Traspasar una comunidad que ya tiene lider**
  * Requisitos: RF_19
  * Archivos: `functions/src/community-grant.ts`, `src/lib/community-grant.test.ts`
  * Accion: dos efectos en un plan — degradar al anterior a `creditor`, promover al nuevo a `leader`.
  * Verificacion: el cashback ya causado del anterior queda **integro**; el nuevo empieza en cero.

- [ ] **T5: Retirar el liderazgo**
  * Requisitos: RF_05, RF_22
  * Archivos: `functions/src/community-grant.ts`, `src/lib/community-grant.test.ts`
  * Accion: `planLeadershipRevoke`. Con deuda cero el vinculo se elimina; **con deuda queda como acreedor**.
  * Verificacion: la cuenta queda operando **exactamente** como antes de recibir el liderazgo, y `leaderUid` sale del documento de la comunidad en los dos casos.

- [ ] **T6: Una comunidad sin lider cobra tarifa base**
  * Requisitos: RF_20, RF_21
  * Archivos: `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: sin `leaderUid`, `resolveCommunityPricing` devuelve la base — **comprobado antes que el piso**.
  * Verificacion: si se comprobara despues, una comunidad sin lider con precio propio por encima **seguiria cobrando de mas**. Cobrarle a una tienda un sobreprecio que no va a nadie es justo lo que RF_20 impide. Lo ya congelado en pedidos existentes no cambia (RF_21).

- [ ] **T7: Las callables de conceder y retirar**
  * Requisitos: RF_17, RF_05
  * Archivos: `functions/src/communities.ts`, `functions/src/roles.ts`, `src/lib/community-grant.test.ts`
  * Accion: `grantCommunityLeadership` y `revokeCommunityLeadership` sobre los planes puros, con la reversion de la spec 001 RF_55. Y **`setUserRole` deja de borrar `communityId`**: hoy lo pierde al reescribir los reclamos, asi que cambiar el papel operativo de alguien le quitaria la comunidad sin que nadie lo pidiera.
  * Verificacion: sesion real con usuario desechable.

- [ ] **T8: Las reglas de Firestore**
  * Requisitos: RNF_02
  * Archivos: `firestore.rules`, `src/lib/community-access.test.ts`
  * Accion: `isCommunityLeader()` y `sellerInMyCommunity()` dejan de exigir el rol.
  * Verificacion: **son dos capas independientes** — sin esto el servidor sigue negando aunque los predicados de las callables pasen. Se comprueba con sesion real, no con Vitest.

- [ ] **T9: La sesion con dos identidades**
  * Requisitos: RF_07, RF_10, RF_11
  * Archivos: `src/lib/types.ts`, `src/lib/session-hats.ts` (nuevo), `src/lib/session-hats.test.ts` (nuevo)
  * Accion: `profileId` pasa a ser **solo** la identidad operativa; la comunidad viaja aparte. `availableHats`, `defaultHat`, `shouldShowHatSelector`.
  * Verificacion: hoy `profileId` significa cosas distintas segun el rol —para un lider es su comunidad— y una cuenta con dos papeles tiene **dos identidades y una sola casilla**. Sin selector para quien tiene un solo papel, **salvo que arrastre una deuda de uno anterior** (RF_11).

- [ ] **T10: El selector en pantalla**
  * Requisitos: RF_07, RF_08, RF_09, RF_10
  * Archivos: `src/components/operations-app.tsx`, `src/lib/session-hats.test.ts`
  * Accion: el selector y el reparto de vistas. **El sombrero no viaja al servidor.**
  * Verificacion: como lider no se ve el detalle de un pedido, ni el cliente, ni el saldo de **ninguna** tienda, **incluida la suya** — es regla de **presentacion**, no de autorizacion (RF_09). Cambiar de sombrero **no exige volver a entrar** (RF_10). Guarda de fuente que ate que la pantalla usa el nucleo y no una copia.

- [ ] **T11: Lo que baja el navegador**
  * Requisitos: RF_15, RF_16, RNF_03
  * Archivos: `src/lib/firebase/state-store.ts`, `src/lib/state-store-targets.test.ts` (nuevo)
  * Accion: los objetivos del lider se **suman** a los del papel operativo.
  * Verificacion: **la tarea que toca dinero.** Principio 8 de la constitucion: antes de tocar una descarga hay que comprobar que cifra depende de lo que se toca — un recorte mal hecho no falla ni avisa, solo muestra menos dinero del que se debe, y ya paso una vez con $1.135.720. Se afirma que **no se pierde ninguna cifra** que el papel veria por separado, que el total es **como mucho la suma** (RF_16) y que cambiar de sombrero lee **cero documentos** (RNF_03).

- [ ] **T12: El cashback de su propia tienda, a la vista**
  * Requisitos: RF_13, RF_14, RF_24
  * Archivos: `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `functions/src/community-pricing.ts`
  * Accion: el reparto de cuanto cashback procede de la tienda del propio lider, y el aviso al administrador cuando un lider cambia un precio que le afecta a el mismo.
  * Verificacion: la tienda del lider cuenta como una mas en los totales (RF_14) — excluirla haria que no cuadraran con los cortes. El plazo de aviso de subida se le aplica **sin excepcion**, aunque la unica tienda afectada sea la suya (RF_24). **Permitirlo y esconderlo son cosas distintas.**

---

## Cobertura: requisito → tarea

| Req | Tarea | Req | Tarea |
|---|---|---|---|
| RF_01 | T1 | RF_15 | T11 |
| RF_02 | T1 | RF_16 | T11 |
| RF_03 | T1 | RF_17 | T3, T7 |
| RF_04 | T3 | RF_18 | T3 |
| RF_05 | T5, T7 | RF_19 | T4 |
| RF_06 | T3 | RF_20 | T6 |
| RF_07 | T9, T10 | RF_21 | T6 |
| RF_08 | T10 | RF_22 | T2, T5 |
| RF_09 | T10 | RF_23 | T2 |
| RF_10 | T9, T10 | RF_24 | T12 |
| RF_11 | T9 | RNF_01 | T1 |
| RF_12 | T6, T12 | RNF_02 | T8 |
| RF_13 | T12 | RNF_03 | T11 |
| RF_14 | T12 | | |

**Los 27 requisitos con tarea. Sin huerfanos.**
