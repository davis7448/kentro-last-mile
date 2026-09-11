# Tareas 001: Lider de comunidad

- **Spec:** `specs/001_lider_de_comunidad.md` · **Plan:** `specs/001_plan.md`
- 47 tareas: las 28 originales mas T29-T47, anadidas tras la auditoria y revisadas en dos pasadas de `/sdd-analyze`. Nucleo puro primero, servidor despues, interfaz al final.
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

- [x] **T28: No regresion y medicion**
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

---

## Cierre de auditoria — tareas T29 a T47

Anadidas el 10-09-2026 a partir de `.sdd/audit-001.md`, en el orden de riesgo que fija la propia
auditoria. **T1–T28 no se tocan**; T28 sigue bloqueada y la desbloquea T42.

La tabla de arriba mide requisito → **tarea**. Estas tareas existen porque esa tabla no es
trazabilidad: doce requisitos tenian tarea y **cero pruebas**. Cada `it()` de aqui empieza por el
identificador del requisito, igual que en T1–T28.

### 1. Alta por enlace — el camino que mas dinero y mas datos personales toca

- [x] **T29: Documento de alta por enlace**
  * Requisitos cubiertos: RF_07, RF_08
  * Archivos: `functions/src/community-signup-doc.ts`, `functions/src/community-signup.ts`, `src/lib/community-signup.test.ts`
  * Accion: Extraer de `registerSellerBySlug` el armado del documento a `buildSignupSellerDoc(input, { communityId, slug, activeCityId, nowIso })`, puro. La callable pasa a llamarlo; no cambia lo que escribe.
  * Verificacion: `RF_07` la tienda nace operativa sin ningun campo de aprobacion pendiente y con `onboardingComplete: false`; `RF_08` los tres campos de procedencia (`communityId`, `communityJoinedAt`, `communitySignupSlug` normalizado) estan y son los del enlace usado.

- [x] **T30: Correo ya registrado**
  * Requisitos cubiertos: RF_10
  * Archivos: `functions/src/community-signup-validate.ts`, `functions/src/community-signup.ts`, `src/lib/community-signup.test.ts`
  * Accion: `mapSignupAuthError(code)` puro. Solo `auth/email-already-exists` se traduce; cualquier otro codigo se relanza en vez de tragarse.
  * Verificacion: El mensaje dice que inicie sesion y **no nombra comunidad alguna** (aserto explicito sobre el texto); otro codigo de error propaga. Sesion real con usuario desechable: el segundo registro no modifica el seller existente ni su `communityId`.

### 2. Contencion del enlace filtrado — remedio unico, hoy sin una sola prueba

- [x] **T31: Nucleo puro de la desactivacion en bloque**
  * Requisitos cubiertos: RF_41, RF_42
  * Archivos: `functions/src/community-containment.ts`, `src/lib/community-containment.test.ts`
  * Accion: `planBulkSignupDisable({ sellers, communityId, fromIso, toIso })` devuelve a quien desactiva y que deja intacto. Puro, sin firebase-admin.
  * Verificacion: `RF_41` rango inclusivo en los dos extremos, tienda fuera del rango y tienda de otra comunidad intactas; `RF_42` el plan **no contiene ninguna orden de borrado** ni toca pedidos ni asientos.

- [x] **T32: Cablear la contencion y dejar de fallar en silencio**
  * Requisitos cubiertos: RF_41, RF_42, RF_53
  * Archivos: `functions/src/communities.ts`, `functions/src/community-containment.ts`, `src/lib/community-containment.test.ts`
  * Nota de alcance (10-09-2026): se anade `community-containment.ts`. La callable importa `firebase-admin` y la raiz no puede importarlo, asi que el reparto desactivadas/fallidas y el alcance de RF_53 solo son probables si viven en el nucleo puro, junto al plan de T31.
  * Accion: `disableCommunitySignupsInRange` usa el nucleo de T31. **Arreglar el fallo mudo**: hoy `auth.getUsers(...).catch(() => null)` deja la cuenta ACTIVA sin avisar, en el unico remedio que existe ante un enlace filtrado. La respuesta debe distinguir desactivados de fallidos.
  * Verificacion: Una tienda cuyo usuario de Auth no se resuelve aparece en `failed`, no en `disabled`; `RF_53` descartar el aviso no desactiva a nadie. Sesion real con usuario desechable: un no-admin recibe `permission-denied`.

### 3. Dinero y vista del admin

- [x] **T33: Reparto causado/pagado del cashback**
  * Requisitos cubiertos: RF_49
  * Archivos: `functions/src/settlement-math.ts`, `src/lib/settlement-math.test.ts`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`
  * **Depende de T43**, que va once posiciones despues: sin ella no existe la pantalla que crea el corte, asi que el recorrido real de esta tarea no se puede hacer hasta entonces. Implementar T43 antes, o dejar el recorrido pendiente por escrito.
  * Accion: El cashback se rotula causado y pendiente mientras el corte no este pagado, y pagado al marcarlo. **Solo la aritmetica**: la pantalla que crea el corte no existe y la construye T43.
  * Verificacion: Los dos estados del mismo corte. **"Solo el admin lo marca" NO se prueba aqui**: vive en `orders.ts:1402`, que importa `firebase-admin` y la raiz no puede importarlo — va como script con usuario desechable, igual que T32.

- [x] **T34: Cashback causado en la lista de comunidades del admin**
  * Requisitos cubiertos: RF_34
  * Archivos: `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `src/components/operations-app.tsx`
  * Accion: **No es una extraccion: falta funcionalidad.** La tarjeta del admin (`operations-app.tsx:3947-4010`) muestra precios, tiendas y estado, pero **no el cashback causado** que RF_34 exige. Selector puro `buildAdminCommunityList(state)` con las cuatro cifras, y pintarlo.
  * Verificacion: Dos comunidades no se mezclan; una sin tiendas sale en cero, no ausente; el cashback sale del mismo sitio que el del lider (RNF_02: una sola formula).

- [x] **T35: Veto de pedidos sin datos operativos**
  * Requisitos cubiertos: RF_44
  * Archivos: `functions/src/community-access.ts`, `functions/src/orders.ts`, `src/lib/community-access.test.ts`
  * Accion: Extraer a `missingOperationalData(seller)` la condicion que hoy vive suelta en `orders.ts`.
  * Verificacion: Falta ciudad / punto de recogida / cuenta bancaria y el mensaje nombra **cual** falta; **tienda antigua sin el campo SI crea pedidos** (la comparacion es `=== false` a proposito).

### 4. Las mitades sueltas de dos MUST de dinero

- [x] **T36: Reasignar no mueve el cashback ya causado**
  * Requisitos cubiertos: RF_11
  * Archivos: `functions/src/community-access.ts`, `functions/src/communities.ts`, `src/lib/community-access.test.ts`
  * Accion: `planSellerReassignment(seller, communityIdNuevo, nowIso)` declara los campos que toca; los asientos no estan entre ellos.
  * Verificacion: El plan no incluye asiento alguno; los pedidos ya creados conservan su precio congelado y los nuevos toman el de la comunidad nueva.

- [x] **T37: Desactivar a un lider no borra la deuda**
  * Requisitos cubiertos: RF_51
  * Archivos: `functions/src/community-access.ts`, `functions/src/communities.ts`, `src/lib/community-access.test.ts`
  * Accion: Afirmar en prueba que la desactivacion no marca ni elimina asientos de cashback pendientes. `communities.ts` entra en alcance porque el consumidor es `setCommunityLeaderStatus` (mismo patron que T36).
  * Verificacion: Lider desactivado: no entra, y su cashback pendiente, su comunidad y su historial de precios siguen enteros.

### 5. El eje de fecha real

- [x] **T38: RF_46 en la consulta, no en el rotulo**
  * Requisitos cubiertos: RF_46
  * Archivos: `functions/src/community-stats-math.ts`, `functions/src/community-stats.ts`, `src/lib/community-stats.test.ts`, `src/components/operations-app.tsx`
  * Accion: `axisForMetric(metric)` decide el eje **semantico** (`"creacion" | "despacho" | "cierre"`), y **el rotulo y la consulta salen de esa misma funcion**, de modo que no puedan divergir. `getCommunityStats` la usa en `onAxis`.
  * Verificacion: creados → eje de creacion (`orders.createdAt`); entregados y fallidos → eje de cierre (`orders.closedAt`); **cashback → eje de cierre pero sobre `walletEntries.createdAt`**, que por construccion ES el instante de cierre (hallazgo 3 del plan). Tomar "cierre" como `closedAt` literal aqui **rompe la consulta**: los asientos no tienen ese campo. El rotulo mostrado coincide con el eje consultado en los cuatro casos.
  * **Alcance de cliente:** el rotulo lo pinta `operations-app.tsx:73` importando `dateAxisLabel`. Si cambia esa firma, la UI entra en alcance.

### 6. Precio visible para la tienda

- [x] **T39: La tienda ve su tarifa y la subida que viene**
  * Requisitos cubiertos: RNF_04, RF_28, RF_40
  * Archivos: `functions/src/community-pricing.ts`, `functions/src/communities.ts`, `src/lib/community-pricing.test.ts`
  * Accion: Nucleo puro de la respuesta de `getMyStoreTariff`; `cancelScheduledCommunityPrice` admite cancelar y rebajar antes de la fecha.
  * Verificacion: `RNF_04` la tienda obtiene su tarifa vigente en cualquier momento; `RF_28` la subida se muestra **de inmediato** con su fecha exacta; `RF_40` cancelar y rebajar antes de la fecha funcionan y quedan en el historial.

### 7. Los parciales que quedaban

- [x] **T40: Un rechazo conserva lo anterior**
  * Requisitos cubiertos: RF_04, RF_16
  * Archivos: `functions/src/community-slug.ts`, `functions/src/community-pricing.ts`, `functions/src/communities.ts`, `src/lib/community-slug.test.ts`, `src/lib/community-view.test.ts`
  * Nota de alcance: `validateLogo` vive en `community-pricing.ts:160` (si, ahi); entra por si la prueba obliga a retocarlo.
  * **Ademas (anadido el 10-09-2026, al cerrar T47):** retirar `raiseCommunityPricesToFloor` de `communities.ts:292`, que queda muerta y **duplicando el criterio de piso** ahora que existe `planFloorRaise`. No es un borrado limpio: la vieja compara contra el `pricing` literal (tiene el bug del `fromCop` rancio que T47 corrige), escribe una `note` en el historial y firma con el uid del admin en vez de `system:floor`, y no borra programadas muertas. Decidir que pasa con el historial ya escrito antes de quitarla.
  * Accion: Probar el MUST que falta en ambos: tras un rechazo, el slug y el logo anteriores siguen ahi.
  * Verificacion: Slug en uso, reservado y con caracteres no permitidos → los tres explican el motivo y conservan el anterior; logo invalido conserva el anterior.

- [x] **T41: Lo que el lider no puede tocar y la comunidad vacia**
  * Requisitos cubiertos: RF_27, RF_32
  * Archivos: `functions/src/community-access.ts`, `src/lib/community-access.test.ts`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `src/components/operations-app.tsx`
  * Accion: Completar el veto de RF_27 y la pantalla de comunidad vacia. **RF_35 sale de esta tarea**: no era un parcial de prueba sino funcionalidad ausente, y se va a T47.
  * Verificacion: `RF_27` el lider no modifica pago a lider logistico, pago a mensajero, costo de producto ni tarifa de tienda ajena — una asercion por concepto; `RF_32` cifras en cero **junto al enlace de invitacion** (`inviteUrl` en `operations-app.tsx:4078, 4105, 4126, 4128`; la 4215 es el helper `communitySlug`, no el enlace).

### 8. La carga del panel del lider

- [x] **T42: Acotar el cashback que baja el lider (desbloquea T28)**
  * Requisitos cubiertos: RNF_01
  * Archivos: `src/lib/firebase/state-store.ts`, `src/lib/community-cashback-entries.test.ts`, `docs/rendimiento.md`
  * Accion: **La suscripcion de wallet del lider se ELIMINA, no se acota.** `CommunityLeaderView` no lee `state.wallet` en ningun punto: el cashback causado llega agregado de `getCommunityStats` y el pagado sale de `state.settlements` (`operations-app.tsx:4059-4064`). Bajar un asiento por pedido para no leerlo es puro peso.
  * Verificacion: Las cifras fijadas en el bloque `T28 · RNF_01` se ponen en rojo y se reescriben: la cuenta con 100 y con 10.000 pedidos MUST ser la misma —y ahora es cero en ambos casos—. Actualizar `docs/rendimiento.md`.
  * **La trampa NO es la habitual.** `getOrdersForContext` ya devuelve `[]` para este rol (`state-store.ts:940`). El par real es la **suscripcion** (`:468`) y **`getWalletForContext`** (`:956-965`), que no tiene rama de `community_leader` y cae al fallback `getCollection("walletEntries")` —la coleccion entera— pese al comentario que la llama "espejo exacto". Hoy queda tapado porque la suscripcion mete `wallet` en `skip`; contra las reglas seria un 403.

### 9. La superficie de cliente que falta

Cinco tareas para cuatro callables desplegadas **sin un solo llamador** mas el corte de lider en
liquidaciones: el backend existe, la funcionalidad no. Un administrador real no puede ejecutarlas.
Decidido el 10-09-2026 construirlas, RF_41 primero. Detalle en `specs/001_plan.md` §2.1.

**Como se verifican T44, T45 y T46.** Son superficie: su comportamiento no se puede afirmar con una
prueba unitaria pura, y dejarlas sin canal declarado las colaria en el Definition of Done sin nada que
las respalde. Cada una lleva **dos**: (a) el predicado de quien ve el control sale de
`community-access.ts` y se prueba ahi, con su `it("RF_xx: ...")`, y (b) el recorrido de punta a punta
va en la evidencia de `/sdd-verify`, con captura. La exencion escrita de este documento cubre solo
RNF_03 y RNF_05; estas tres no se acogen a ella.

- [x] **T43: Corte de lider en la pantalla de liquidaciones**
  * Requisitos cubiertos: RF_49
  * Archivos: `src/components/operations-app.tsx`, `src/lib/firebase/auth.ts`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`
  * Accion: `LiquidationRow.role` solo admite `"seller" | "driver"` (`operations-app.tsx:6111`), asi que **la pantalla no puede crear un corte de `community_leader`** aunque `createSettlement` lo acepte (`orders.ts:1226`). Anadir el tipo, la fila y el envoltorio. **Son DOS barreras, no una:** `createFirebaseSettlement` tipa `kind: "seller" | "driver" | "supplier"` en `src/lib/firebase/auth.ts:423`; arreglar solo el `role` deja `tsc` en rojo.
  * Verificacion: Sin esto el "pagado" del lider es cero por construccion y T33 estaria en verde sobre un camino que no existe. Prueba del selector de filas con los tres roles; recorrido real de crear y marcar pagado un corte de lider.

- [x] **T44: Desactivacion en bloque desde el panel del admin**
  * Requisitos cubiertos: RF_41, RF_42
  * Archivos: `src/lib/firebase/auth.ts`, `src/components/operations-app.tsx`, `functions/src/community-access.ts`, `src/lib/community-access.test.ts`, `src/lib/community-view.ts`, `src/lib/community-view.test.ts`
  * Nota de alcance (10-09-2026): se anaden `community-view.ts` y su prueba. "Mostrar el recuento sin resumir" es un MUST de esta tarea y con el mapeo inline en `operations-app.tsx` no lo ata nada: el dia que alguien agrupe `failed` con `untouched` en un solo numero, ninguna prueba se pone roja y volvemos al fallo que T32 acaba de cerrar.
  * Accion: Envoltorio de `disableCommunitySignupsInRange` y el control: elegir comunidad y rango, confirmar, y **mostrar el resultado distinguiendo desactivados de fallidos** (T32).
  * **Cabo suelto anotado al cerrar (10-09-2026):** `functions/src/communities.ts:414` decide el permiso con un `actor.role !== "admin"` suelto, no con `canBulkDisableCommunitySignups`. Funciona igual hoy, pero si la interfaz y el servidor deciden por caminos distintos acaban diciendo cosas distintas. `communities.ts` no estaba en el alcance de T44 y el coder acerto al no tocarlo. Recogerlo al abrir la siguiente tarea que toque ese archivo (T36 o T37).
  * Verificacion: La spec lo declara el unico remedio ante un enlace filtrado. Confirmacion explicita antes de ejecutar —es una accion en bloque y dificil de revertir—; el recuento de la respuesta se muestra tal cual, sin redondear ni resumir.

- [x] **T45: Carga del logo del lider**
  * Requisitos cubiertos: RF_14, RF_16
  * Archivos: `src/lib/firebase/auth.ts`, `src/components/operations-app.tsx`, `storage.rules`
  * **Hallazgo al implementar (11-09-2026):** `storage.rules` solo tiene regla para `evidence/`. **No hay ninguna para logos**, asi que Storage denegaria la subida por defecto — el plan la daba por hecha y no estaba. Ademas la lectura tiene que ser **publica**: la pantalla de registro se abre sin sesion y RF_14 exige que muestre el logo del lider.
  * Accion: Envoltorio de `setCommunityLogo` y el control de subida en el panel del lider.
  * Verificacion: Con logo, el registro y el panel de sus tiendas lo muestran en lugar del de la plataforma (RF_14); un logo invalido conserva el anterior y dice por que (RF_16).

- [x] **T46: Reasignar una tienda de comunidad**
  * Requisitos cubiertos: RF_11
  * Archivos: `src/lib/firebase/auth.ts`, `src/components/operations-app.tsx`
  * Accion: Envoltorio de `reassignSellerCommunity` y el control, **solo en la vista de admin**.
  * Verificacion: Ni la tienda ni el lider ven el control; el cashback ya causado no se mueve (T36); los pedidos ya creados conservan su precio congelado.

- [x] **T47: Disparador de la elevacion al piso**
  * Requisitos cubiertos: RF_35
  * Archivos: `functions/src/community-floor-trigger.ts`, `functions/src/index.ts`, `functions/src/community-pricing.ts`, `src/lib/community-pricing.test.ts`
  * Accion: `raiseCommunityPricesToFloor` no la llama nadie y la tarifa base la escribe el cliente directo a `settings/app` (`state-store.ts:293`). Trigger `onDocumentUpdated` sobre `settings/app`, por lo razonado en el plan §4.7: se dispara escriba quien escriba y no se puede saltar desde el navegador. El nucleo de decision —que comunidades y que conceptos suben— va en `community-pricing.ts`, puro.
  * Verificacion: Una bajada de base no escribe nada; una subida eleva solo los conceptos por debajo del piso, **de inmediato y sin los ocho dias** (RF_40 la exime), deja historial con autor `system:floor` (RF_39) y marca el aviso al lider (RF_35). Correrlo dos veces no produce una segunda entrada de historial.
  * **Despliegue:** es una funcion nueva → guard de functions, `firebase functions:list` antes.

### Lo que no genera tarea de implement

**RNF_03** (registro publico en iOS 14 y usable en movil) y **RNF_05** (sistema de diseno vigente)
se cierran con evidencia funcional en `/sdd-verify`, no con prueba unitaria. Quedan anotados aqui
para que no se den por cubiertos antes de tiempo.

### Cobertura: los requisitos que estaban sin prueba

| Requisito | Estaba | Tarea nueva |
|---|---|---|
| RF_04 | parcial | T40 |
| RF_07 | huerfano | T29 |
| RF_08 | huerfano | T29 |
| RF_10 | huerfano | T30 |
| RF_11 | parcial **y sin superficie** | T36, T46 |
| RF_14 | sin superficie | T45 |
| RF_16 | parcial + sin superficie | T40, T45 |
| RF_27 | parcial | T41 |
| RF_28 | parcial | T39 |
| RF_32 | parcial | T41 |
| RF_34 | huerfano **y sin implementar** | T34 |
| RF_35 | **sin implementar** (callable sin llamador) | T47 |
| RF_40 | parcial | T39 |
| RF_41 | huerfano **y sin superficie** | T31, T32, T44 |
| RF_42 | huerfano **y sin superficie** | T31, T32, T44 |
| RF_44 | huerfano | T35 |
| RF_46 | parcial | T38 |
| RF_49 | huerfano **y sin superficie** | T33, T43 |
| RF_51 | parcial | T37 |
| RF_53 | huerfano | T32 |
| RNF_01 | medido e incumplido | T42 |
| RNF_03 | huerfano | evidencia en `/sdd-verify` |
| RNF_04 | huerfano | T39 |
| RNF_05 | huerfano | evidencia en `/sdd-verify` |

**24 requisitos → 22 con tarea nueva y 2 con evidencia funcional. Sin huerfanos.**

Seis de ellos no eran deuda de pruebas sino **funcionalidad ausente**, y eso lo descubrio
`/sdd-analyze`, no la auditoria: la auditoria miraba pruebas, no llamadores. RF_35 no tenia quien lo
disparara; RF_34 y RF_49 estaban a medias en la interfaz; RF_41, RF_42, RF_11, RF_14 y RF_16 tenian
callable desplegada y ningun boton que la llamara.

### Banderas corregidas en el estado

La auditoria encontro `testWritten: true` en T9, T12, T16, T17, T18, T19, T21, T22, T23, T25, T26
y T27 sin prueba que lo respalde. Se han puesto en `false`. Siguen `done: true` —el codigo existe
y funciona—; lo que no existia era la prueba, y esa deuda la recogen T29–T42.


---

## 10. La pantalla que faltaba (anadida el 11-09-2026, tras el despliegue)

Al preguntar como se crea una comunidad desde el panel, la respuesta resulto ser **que no se
puede**. `createCommunityLeader` esta desplegada y tiene envoltorio en `src/lib/firebase/auth.ts:675`,
pero **nada en la interfaz la llama**, y el formulario de alta de usuarios
(`operations-app.tsx:5535`) ofrece cinco roles sin `community_leader` entre ellos.

Es la **quinta** callable sin superficie. Las cuatro de §2.1 se encontraron porque se busco por
ellas; esta se colo porque **si** tenia envoltorio, y tener envoltorio se confundio con tener boton.

- [x] **T48: Alta de lider de comunidad desde el panel**
  * Requisitos cubiertos: RF_50, RF_01, RF_02, RF_04
  * Archivos: `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `src/components/operations-app.tsx`
  * Accion: formulario en el panel del admin que llame a `createCommunityLeader({ name, slug, leaderName, leaderEmail, leaderPhone, password })`, con validacion previa del nombre corto para explicar el motivo antes de ir al servidor (RF_04). **Y retirar el `roleLabel` duplicado.**
  * **El fallo del rotulo esta en produccion ahora mismo:** hay dos `roleLabel` —el bueno en `src/lib/community-view.ts:16`, probado por RF_01, y una cadena de ternarios en `operations-app.tsx:483` que **cae en "Mensajero"** para un lider de comunidad—. La interfaz usa el segundo en seis sitios, incluida la cabecera de sesion. Un lider que entre hoy **ve "Mensajero" junto a su nombre**.
  * Verificacion: la prueba de RF_01 deja de cubrir solo la funcion pura y pasa a atar que **la pantalla use esa y no otra**. Trazabilidad no es superficie, y este caso lo enseña mejor que ninguno: RF_01 estaba "cubierto" y la interfaz mentia igual.
