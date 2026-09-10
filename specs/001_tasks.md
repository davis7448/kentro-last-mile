# Tareas 001: Lider de comunidad

- **Spec:** `specs/001_lider_de_comunidad.md` · **Plan:** `specs/001_plan.md`
- 28 tareas, revisadas tras `/sdd-analyze`. Nucleo puro primero, servidor despues, interfaz al final.
- **Cada `it()` empieza por el identificador del requisito** (`it("RF_19: ...")`), para que la
  trazabilidad prueba → requisito se compruebe con un `grep`.

- [x] **T1: Tipos, enumerados y rol**
  * Requisitos cubiertos: RF_01
  * Archivos: `src/lib/types.ts`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`
  * Accion: Rol `community_leader`; tipos `Community`, `ScheduledPriceChange`, `CommunityPriceHistoryEntry`, `CommunitySlugDoc`, `OrderCommunityPricing`; campos en `Seller` y `Order`; `ownerType`/`type` de `WalletEntry` y `kind` de `Settlement`. `roleLabel` distingue lider de comunidad de lider logistico.
  * Verificacion: `npx tsc --noEmit` limpio y `it("RF_01: ...")` comprueba la etiqueta de cada rol.

- [x] **T2: Nombre corto del enlace**
  * Requisitos cubiertos: RF_02, RF_03, RF_04
  * Archivos: `functions/src/community-slug.ts`, `src/lib/community-slug.test.ts`
  * Accion: Normalizar a `[a-z0-9-]{3,32}` sin acentos, lista de reservadas, y vigencia de 30 dias de un slug retirado.
  * Verificacion: Slug valido, reservado, con acentos, y retirado a 29 y a 31 dias.

- [x] **T3: Precio vigente y piso**
  * Requisitos cubiertos: RF_17, RF_18, RF_19, RF_20, RF_35, RF_36
  * Archivos: `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `resolveCommunityPricing(base, community, nowIso)` y `clampToFloor`. Sin precio propio devuelve base; por debajo del piso devuelve base; nunca negativo.
  * Verificacion: Los dos ordenes de cambio (sube la base despues / sube el precio despues) dan cashback >= 0.

- [x] **T4: Cambios programados**
  * Requisitos cubiertos: RF_28, RF_38, RF_40, RF_54
  * Archivos: `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `applyScheduledChanges(community, nowIso)`: subida a +8 dias, bajada inmediata, una sola programada por concepto que reemplaza y reinicia el plazo. El instante entra por parametro.
  * Verificacion: Dia 7, dia 8, dia 9 y encadenado de dos subidas.

- [x] **T5: Congelado del precio**
  * Requisitos cubiertos: RF_21, RF_37
  * Archivos: `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `freezeOrderPricing` devuelve los seis numeros o `undefined` sin comunidad. **Falla en alto** si la tienda tiene tarifa especial en codigo (DANDA), en vez de calcular mal.
  * Verificacion: Sin comunidad no hay bloque; sin bloque se cobra base y no hay cashback; tienda especial lanza error.

- [x] **T6: Asiento de cashback**
  * Requisitos cubiertos: RF_22, RF_23, RF_26
  * Archivos: `functions/src/wallet-entries.ts`, `src/lib/community-cashback-entries.test.ts`
  * Accion: Usar el precio congelado **despues** de la linea que fija `sellerFailedFeeCop: 12000`; emitir `we-{orderId}-community-cashback-{concepto}`. Cashback cero no emite asiento.
  * Verificacion: Entregado, fallido con segunda visita, manejo, cashback cero. **Prueba dedicada de que el flete de fallido congelado no lo pisa la linea de los 12.000.**

- [x] **T7: Cashback en correcciones**
  * Requisitos cubiertos: RF_24, RF_25
  * Archivos: `functions/src/order-corrections-plan.ts`, `src/lib/community-corrections.test.ts`
  * Accion: Corte pagado o conciliado: asiento compensatorio en el periodo abierto. Corte pendiente: recalculo.
  * Verificacion: `dryRun` y aplicacion coinciden en ambos caminos.

- [x] **T8: Cortes del lider**
  * Requisitos cubiertos: RF_26, RF_49
  * Archivos: `functions/src/settlement-math.ts`, `functions/src/orders.ts`, `src/lib/settlement-math.test.ts`
  * Accion: `settlementTotals` acepta el dueno nuevo; `createSettlement` y `updateSettlementStatus` admiten `kind: "community_leader"`. Causado pasa a pagado solo al marcar el corte.
  * Verificacion: Totales de un corte de lider; solo el admin puede marcarlo pagado.

- [x] **T9: `closedAt` fiable en todos los cierres**
  * Requisitos cubiertos: RF_46
  * Archivos: `functions/src/orders.ts`, `functions/src/order-corrections.ts`
  * Accion: Escribir `closedAt` en cada transicion a estado terminal, no solo en el camino que ya lo hacia. Es lo que hace viable el eje de cierre sin descargar pedidos.
  * Verificacion: Script contra el proyecto: todo pedido cerrado despues del cambio trae `closedAt`.

- [x] **T10: Predicados de permiso**
  * Requisitos cubiertos: RF_05, RF_06, RF_11, RF_12, RF_27, RF_31, RF_34, RF_50, RF_51, RF_52
  * Archivos: `functions/src/community-access.ts`, `src/lib/community-access.test.ts`
  * Accion: Nucleo puro: quien crea un lider, que puede tocar, que ve. Un lider desactivado no entra pero conserva comunidad, historial y cashback. Un lider **si** ve su propio cashback; lo que no ve es el saldo de sus tiendas.
  * Verificacion: Una prueba por requisito, con el identificador en el nombre del `it`.

- [x] **T11: Validacion del registro**
  * Requisitos cubiertos: RF_43, RF_45
  * Archivos: `functions/src/community-signup-validate.ts`, `src/lib/community-signup.test.ts`
  * Accion: Nucleo puro: los cinco campos exactos, forma de correo y telefono, y la decision de reversion cuando falla un paso posterior.
  * Verificacion: Un sexto campo se rechaza; el fallo posterior ordena borrar el usuario creado.

- [x] **T12: Alta y baja de lideres**
  * Requisitos cubiertos: RF_05, RF_06, RF_50, RF_51
  * Archivos: `functions/src/communities.ts`, `functions/src/roles.ts`, `functions/src/index.ts`
  * Accion: `createCommunityLeader`, `setCommunityLeaderStatus`, `setCommunityLinkStatus`, apoyados en `community-access`.
  * Verificacion: Sesion real con usuario desechable: un lider no puede crear otro.

- [x] **T13: Nombre corto y logo**
  * Requisitos cubiertos: RF_02, RF_03, RF_14, RF_15, RF_16
  * Archivos: `functions/src/communities.ts`, `storage.rules`, `src/lib/community-view.test.ts`
  * Accion: `setCommunitySlug` con reserva atomica en `communitySlugs`; `setCommunityLogo` con limite de tamano y formato conservando el anterior.
  * Verificacion: Slug duplicado rechazado; logo de 12 MB rechazado y el anterior intacto.

- [x] **T14: Precios de la comunidad**
  * Requisitos cubiertos: RF_18, RF_19, RF_27, RF_28, RF_35, RF_39, RF_54
  * Archivos: `functions/src/communities.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `scheduleCommunityPrice` y `cancelScheduledCommunityPrice`; historial en `communities/{id}/priceHistory`; elevacion al piso con aviso cuando el admin sube la base. Se valida contra la base **global**; el piso por zona actua al congelar.
  * Verificacion: Precio bajo el piso rechazado con el minimo en el mensaje; historial escrito.

- [x] **T15: Marca publica por slug**
  * Requisitos cubiertos: RF_09, RF_14, RF_15
  * Archivos: `functions/src/community-signup.ts`, `src/lib/community-view.test.ts`
  * Accion: `getCommunityBySlug` sin autenticacion: solo nombre visible, logo y si admite altas.
  * Verificacion: Slug revocado e inexistente devuelven lo mismo, sin filtrar si existe.

- [x] **T16: Registro atomico**
  * Requisitos cubiertos: RF_07, RF_08, RF_09, RF_10, RF_43, RF_45
  * Archivos: `functions/src/community-signup.ts`, `src/lib/community-signup.test.ts`
  * Accion: `registerSellerBySlug`: resolver slug, crear usuario, transaccion de tienda y adscripcion, reclamo de rol. Si algo falla despues del usuario, se borra el usuario.
  * Verificacion: Correo repetido rechazado sin tocar la cuenta existente; fallo forzado no deja rastro.

- [x] **T17: Captacion masiva y limpieza**
  * Requisitos cubiertos: RF_13, RF_41, RF_42, RF_53
  * Archivos: `functions/src/communities.ts`, `functions/src/community-signup.ts`, `src/lib/community-signup.test.ts`
  * Accion: Aviso al superar diez altas en una hora deslizante **sin bloquear**; descartar aviso; desactivar en bloque por rango conservando pedidos e historial.
  * Verificacion: Las altas once y doce se crean igual; desactivar en bloque no borra ningun pedido.

- [x] **T18: Datos operativos antes del primer pedido**
  * Requisitos cubiertos: RF_44
  * Archivos: `functions/src/orders.ts`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`
  * Accion: `onboardingComplete` derivado de ciudad, punto de recogida y cuenta bancaria; sin el, se rechaza crear pedidos de esa tienda.
  * Verificacion: Tienda incompleta entra a la app pero no crea pedido.

- [x] **T19: Congelado en los siete caminos de creacion**
  * Requisitos cubiertos: RF_21
  * Archivos: `functions/src/orders.ts`, `functions/src/index.ts`, `functions/src/shopify.ts`, `functions/src/onstock-webhook.ts`, `functions/src/contact-form.ts`, `functions/src/store-webhook.ts`
  * Accion: Llamar a `freezeOrderPricing` y denormalizar `communityId` en los seis sitios reales, `store-webhook.ts` incluido. Cache por comunidad en los que crean en lote.
  * Verificacion: Script que crea un pedido por cada camino y comprueba que los seis traen `communityPricing`.

- [x] **T20: Aritmetica del panel**
  * Requisitos cubiertos: RF_29, RF_30, RF_46, RF_47, RF_48
  * Archivos: `functions/src/community-stats-math.ts`, `src/lib/community-stats.test.ts`
  * Accion: Puro: armado de los tres rangos, porcentaje de entrega con denominador, activas frente a inactivas, cero real frente a sin datos, contador de markup comido por el piso de zona.
  * Verificacion: Sobre agregados simulados; el porcentaje excluye abiertos y viaja con su denominador.

- [x] **T21: Agregacion en servidor**
  * Requisitos cubiertos: RF_29, RF_30, RF_46, RF_47, RF_48
  * Archivos: `functions/src/community-stats.ts`, `functions/src/index.ts`
  * Accion: `getCommunityStats`: `count()` sobre `orders` en los ejes de creacion, despacho y cierre; `sum()` sobre `walletEntries` solo para el cashback.
  * Verificacion: Con `kentro-perf`: la cuenta de documentos no cambia entre 100 y 10.000 pedidos.

- [x] **T22: Reglas e indices**
  * Requisitos cubiertos: RF_11, RF_31, RF_52
  * Archivos: `firestore.rules`, `firestore.indexes.json`
  * Accion: El lider lee su comunidad, sus tiendas y **sus propios cortes**; nunca pedidos, clientes, saldos de tienda ni otra comunidad. Una tienda no se cambia de comunidad. Indices **anadidos**, comparando antes contra produccion.
  * Verificacion: Sesion real de lider: lectura ajena devuelve 403; lectura de su corte funciona.

- [x] **T23: Alcance de descarga del rol**
  * Requisitos cubiertos: RF_52
  * Archivos: `src/lib/firebase/state-store.ts`
  * Accion: El lider carga comunidad, tiendas y cortes propios. **Cero pedidos.** Tocar carga inicial y suscripcion a la vez o el primer pintado diverge del listener.
  * Verificacion: Contador de documentos con `kentro-perf`.

- [x] **T24: Panel del lider**
  * Requisitos cubiertos: RF_29, RF_30, RF_31, RF_32, RF_33, RF_40, RF_46, RNF_05
  * Archivos: `src/components/operations-app.tsx`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`
  * Accion: `CommunityLeaderView` con los cuatro estados, rotulo de eje por bloque, desglose por tienda, cero real distinguido de sin datos, subida programada visible.
  * Verificacion: `npm run lint` sin errores de `rules-of-hooks`; comunidad vacia no rompe.

- [x] **T25: Admin de comunidades**
  * Requisitos cubiertos: RF_05, RF_11, RF_12, RF_34, RF_50, RF_53, RNF_05
  * Archivos: `src/components/operations-app.tsx`, `src/lib/firebase/auth.ts`
  * Accion: Lista de comunidades con lider, precios vigentes y cashback causado; crear y desactivar lider; revocar enlace; reasignar tienda; descartar aviso. El alta manual sigue igual y queda sin comunidad.
  * Verificacion: Crear un lider de prueba de punta a punta.

- [x] **T26: Pagina publica de registro**
  * Requisitos cubiertos: RF_14, RF_15, RF_43, RNF_03
  * Archivos: `src/app/registro/[slug]/page.tsx`, `src/app/registro/[slug]/signup-form.tsx`
  * Accion: Cinco campos y nada mas; logo del lider o marca de la plataforma; mobile-first; los cuatro estados; enlace invalido explicado.
  * Verificacion: Probada en movil real; `grep -o 'static{'` da 0 en los chunks.

- [x] **T27: La tienda ve su precio**
  * Requisitos cubiertos: RF_28, RF_40, RNF_04
  * Archivos: `src/components/operations-app.tsx`
  * Accion: Tarifa vigente consultable en cualquier momento y subida programada con su fecha de entrada.
  * Verificacion: Una tienda con subida programada la ve antes de que le cobren.

- [ ] **T28: No regresion y medicion**
  * Requisitos cubiertos: RNF_01, RNF_02
  * Archivos: `src/lib/community-cashback-entries.test.ts`, `docs/rendimiento.md`
  * Accion: Prueba de que un pedido sin comunidad produce los mismos asientos que hoy; medir el panel con 100 y con 10.000 pedidos y anotar la cifra real.
  * Verificacion: Asientos identicos y cuenta de documentos independiente del volumen.

## Cobertura: requisito → tarea

| Requisito | Tareas | Requisito | Tareas |
|---|---|---|---|
| RF_01 | T1 | RF_31 | T10, T22, T24 |
| RF_02 | T2, T13 | RF_32 | T24 |
| RF_03 | T2, T13 | RF_33 | T24 |
| RF_04 | T2 | RF_34 | T10, T25 |
| RF_05 | T10, T12, T25 | RF_35 | T3, T14 |
| RF_06 | T10, T12 | RF_36 | T3 |
| RF_07 | T16 | RF_37 | T5 |
| RF_08 | T16 | RF_38 | T4 |
| RF_09 | T15, T16 | RF_39 | T14 |
| RF_10 | T16 | RF_40 | T4, T24, T27 |
| RF_11 | T10, T22, T25 | RF_41 | T17 |
| RF_12 | T10, T25 | RF_42 | T17 |
| RF_13 | T17 | RF_43 | T11, T16, T26 |
| RF_14 | T13, T15, T26 | RF_44 | T18 |
| RF_15 | T13, T15, T26 | RF_45 | T11, T16 |
| RF_16 | T13 | RF_46 | T9, T20, T21, T24 |
| RF_17 | T3 | RF_47 | T20, T21 |
| RF_18 | T3, T14 | RF_48 | T20, T21 |
| RF_19 | T3, T14 | RF_49 | T8 |
| RF_20 | T3 | RF_50 | T10, T12, T25 |
| RF_21 | T5, T19 | RF_51 | T10, T12 |
| RF_22 | T6 | RF_52 | T10, T22, T23 |
| RF_23 | T6 | RF_53 | T17, T25 |
| RF_24 | T7 | RF_54 | T4, T14 |
| RF_25 | T7 | RNF_01 | T28 |
| RF_26 | T6, T8 | RNF_02 | T28 |
| RF_27 | T10, T14 | RNF_03 | T26 |
| RF_28 | T4, T14, T27 | RNF_04 | T27 |
| RF_29 | T20, T21, T24 | RNF_05 | T24, T25 |
| RF_30 | T20, T21, T24 |  |  |

**Comprobado por script: 59 requisitos, sin tarea: ninguno.**
