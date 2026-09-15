# Tareas 005: La tienda que ademas lidera puede entrar y ver sus dos pantallas

- **Spec:** `specs/005_tienda_lider_ve_su_pantalla.md` · **Plan:** `specs/005_plan.md`
- **15 tareas**, numeracion propia (T14 se abrio en la verificacion en produccion; T15 en la validacion humana). Cada `it()` empieza por el identificador del requisito.
- **Segunda version**, tras `/sdd-analyze` (14 hallazgos): T1 gana su tercer desenlace, T4 el estado de
  carga y el `null` real de `emptiness`, T5 pasa a verificarse por comportamiento sobre un modulo puro,
  T9 se hace cargo del enlace de invitacion, T11 reclama RNF_04 y T13 se hace cargo del despliegue de
  reglas, que no tenia dueno.
- **Cada tarea lleva su prueba en el alcance**: el hook deniega escrituras no-test mientras no haya
  prueba, y deniega cualquier archivo fuera del alcance — incluido el propio test.
- **Pruebas por tema:** `src/lib/load-status.test.ts` (comportamiento del modulo puro, T3-T5),
  `src/lib/spec-005-guards.test.ts` (guardas de fuente de reglas, guion y pantallas; T1, T2, T8, T9,
  T11-T13) y `src/lib/community-view.test.ts` (la cifra del acreedor, T9, donde ya vive esa familia). Las guardas del selector siguen en `src/lib/session-hats.test.ts`, donde ya vive esa
  familia desde la 003.
- **Archivos compartidos entre tareas, a sabiendas:** `spec-005-guards.test.ts` (ocho tareas),
  `load-status.ts` y su test (T3-T5), `operations-app.tsx` (T6-T9), `session-hats.test.ts` (T6, T7, T10),
  `scripts/verify-005.js` (T1, T11, T13). Las tareas van en orden estricto y cada una anade su bloque.

## Orden, y por que

1. **Medir antes de arreglar (T1).** Que la consulta falle por la forma de la regla es **deduccion**, y
   el codigo de error no distingue esa causa del limite de accesos a documento. T1 mide.
2. **La regla antes que el cliente (T2, T13).** Sin reglas desplegadas, el cliente nuevo recibe la misma
   negativa.
3. **Los nucleos puros antes que la pantalla (T3-T5).** La pantalla no decide nada.
4. **La no regresion antes de dar nada por bueno (T10).** Cinco papeles que no pidieron esto.

---

## 1. Medir antes de tocar

- [x] **T1: Reproducir el fallo con una cuenta desechable, y poder refutarlo**
  * Requisitos: RF_05, RNF_02 (evidencia)
  * Archivos: `scripts/verify-005.js` (nuevo), `src/lib/spec-005-guards.test.ts` (nuevo)
  * Accion: pasos `setup` / `reproduce` / `cleanup`, todo con prefijo `smoke005-`, sin tocar E-master ni
    el registro de dinero: crea una comunidad de prueba con una tienda dentro y una cuenta que es tienda
    (con su tienda FUERA de esa comunidad) y ademas lidera; entra por REST y ejecuta las dos consultas de
    la carga inicial —la tienda propia por id y `sellers where communityId ==`—. **Registra el error
    crudo** (codigo y mensaje), cuantas tiendas tiene la comunidad y una consulta de control.
  * Verificacion: su canal es la **ejecucion contra produccion**, declarada (las reglas no son probables
    en Vitest: no hay `@firebase/rules-unit-testing`, es la spec 002 sin implementar). Tres desenlaces,
    no dos: **no falla** -> hipotesis refutada, se para y se corrige el plan; **falla por la forma de la
    regla** -> sigue T2; **falla por otra causa** (limite de accesos a documento, indice, otra regla) ->
    T2 sigue siendo valido pero la causa real se anota en la spec. En el test solo van guardas: prefijo
    fijo, `cleanup` idempotente, y ningun paso escribe en `walletEntries` ni en `settlements`.

## 2. La regla

- [x] **T2: Una regla sin `get()` sobre el comodin**
  * Requisitos: RF_05, RF_02, RNF_02
  * Archivos: `firestore.rules`, `src/lib/spec-005-guards.test.ts`
  * Accion: `sellerInMyCommunity()` decide con `isCommunityLeader(resource.data.get("communityId",""))`
    y deja de recibir el id comodin; el `match /sellers` la sigue usando.
  * Verificacion: guarda de fuente — la funcion no contiene `get(` ni `exists(` sobre rutas, el `match
    /sellers` la llama, y `isCommunityLeader` sigue exigiendo reclamo presente y no vacio (no se abre a
    cuentas sin comunidad). El `get("communityId","")` es deliberado: una tienda sin comunidad no tiene
    el campo y leerlo directo seria error de evaluacion, no `false`. La comprobacion real es T13.

## 3. Los nucleos puros

- [x] **T3: Que tiene derecho a decir la pantalla de la tienda**
  * Requisitos: RF_07, RF_08
  * Archivos: `src/lib/load-status.ts` (nuevo), `src/lib/load-status.test.ts` (nuevo)
  * Accion: `storeProfileState({ outcome, sellerId, sellers })` con los cinco resultados del plan 3.3.
  * Verificacion: la tabla entera. Los dos que importan: con `outcome: "failed"` **nunca** sale "perfil
    pendiente" (RF_07 gana), y con carga buena se distingue "sin tienda asignada" de "la tienda asignada
    ya no existe" (RF_08).

- [x] **T4: Por que no hay tiendas en la pantalla de comunidad**
  * Requisitos: RF_10, RF_11, RF_12
  * Archivos: `src/lib/load-status.ts`, `src/lib/load-status.test.ts`
  * Accion: `communityStoresState({ statsOutcome, standing, emptiness })` con los cinco resultados del
    plan 3.5. `emptiness` se tipa **como lo emite el servidor**: `"no_stores" | "no_orders_in_period" |
    null | undefined` (`functions/src/community-stats-math.ts:151`).
  * Verificacion: acreedor => `not_governing` **siempre**, sin reintentar, decida lo que decida la carga
    (el servidor le niega por diseno, no por fallo); lider con `statsOutcome: "loading"` => `loading`;
    con `failed` => `load_failed`; con `ok` y `"no_stores"` => `no_stores`, que no es un error; con `ok`
    y `null` => `ok`. **Caso limite de la spec §5 (retirada en caliente):** mientras la pantalla no se
    entera, el mismo lider con `standing: "leader"` y `statsOutcome: "failed"` da `load_failed`; al
    volver a entrar, con `standing: "creditor"`, da `not_governing`.

- [x] **T5: La mitad de comunidad no puede tumbar la tienda propia**
  * Requisitos: RF_01, RF_06, RF_02
  * Archivos: `src/lib/load-status.ts`, `src/lib/load-status.test.ts`, `src/lib/firebase/state-store.ts`,
    `src/lib/state-store-targets.test.ts`
  * Accion: `mergeCommunitySellers({ own, community })` puro —union por id y parte de lo que falto—; en
    `loadFirestoreState` la mitad de comunidad se envuelve para entregar `{ failed: true }` en vez de
    rechazar, y la tienda propia se sigue exigiendo.
  * Verificacion: **por comportamiento sobre el modulo puro**, no por regex: `state-store.ts` importa el
    SDK de Firebase y no se puede importar desde una prueba (`state-store-targets.test.ts:15-26` lo
    declara). Se afirma que con la mitad de comunidad caida la tienda propia sigue presente y el parte
    trae `community_sellers`; que **la tienda propia que ademas pertenece a su comunidad aparece una sola
    vez** (caso limite §5, viñeta 1, hoy garantizado por `mergeById`); y que sin fallo el parte va vacio.
    Mas guarda de fuente de que `state-store.ts` usa el nucleo. **Ojo:** `state-store-targets.test.ts:136-144`
    exige que ese archivo NO mencione `communityStanding`; este cambio no debe introducirlo.

## 4. La sesion y la pantalla

- [x] **T6: La sesion propaga la posicion en la comunidad**
  * Requisitos: RF_12
  * Archivos: `src/lib/firebase/auth.ts`, `src/components/operations-app.tsx`, `src/lib/session-hats.test.ts`
  * Accion: `FirebaseSessionClaims` declara `communityStanding` y `subscribeFirebaseUser` lo emite; la
    sesion lo lee sin el cast de hoy.
  * Verificacion: cabo suelto de la 003 confirmado en el analisis — `auth.ts:11-18` no lo declara y
    `:40-46` no lo emite, asi que `session.communityStanding` es **siempre** `undefined` y el cast de
    `operations-app.tsx:12921` lo admite en su comentario. No rompe nada hoy (los sombreros los da el
    vinculo), pero sin el, RF_12 es inalcanzable.

- [x] **T7: El selector de papel en la cabecera**
  * Requisitos: RF_03, RF_04, RF_09, RNF_04 (parcial: forma; las capturas son T11)
  * Archivos: `src/components/operations-app.tsx`, `src/lib/session-hats.test.ts`
  * Accion: `Header` pinta dos pildoras ("Tienda" / "Comunidad") cuando `canPickHat`, con la activa
    marcada y `aria-pressed`, dentro del JSX que devuelve y antes de cualquier retorno anticipado.
  * Verificacion: **es el hueco exacto por el que la 003 se dio por buena** (DoD 2). La guarda vieja
    (`session-hats.test.ts:349-351`) solo exige que `shouldShowHatSelector(` aparezca en el archivo, y
    **pasa hoy con el selector invisible**: se endurece en esta tarea para exigir el uso de `canPickHat`
    y `onHatChange` **dentro del cuerpo de `Header`** y las dos etiquetas. Mas una prueba de que el
    nucleo dice `true` para tienda+lider y tienda+acreedor y `false` sin vinculo. No se escribe logica
    nueva. RF_09 (se abre la tienda primero) ya esta probado: el caso "defaultHat abre el OPERATIVO" de
    `session-hats.test.ts`; se cita, no se duplica.

- [x] **T8: El canal del fallo, y la pantalla de la tienda que lo usa**
  * Requisitos: RF_01, RF_07, RF_08
  * Archivos: `src/lib/firebase/state-store.ts`, `src/components/operations-app.tsx`, `src/lib/spec-005-guards.test.ts`
  * Accion: **el canal primero** — `subscribeFirestoreState` gana `onError` y entrega el parte junto al
    estado, y el `.catch(console.warn)` de `state-store.ts:775` deja de tragarse el fallo.
    **Y lo primero de lo primero: que `loadFirestoreState` deje de DESCARTAR el parte.** T5 lo dejo
    calculado en el sitio de llamada pero tirandolo (`mergeCommunitySellers({...}).sellers`) para no
    cambiar una firma con otros llamadores. Mientras siga tirandose, una mitad de comunidad rechazada
    se degrada **en silencio** — el principio 8 en estado puro — y ni el aviso del enlace (T9) ni el de
    carga tienen de donde salir. Despues la
    pantalla: `SellerView` pinta segun `storeProfileState`; el aviso de fallo ofrece reintentar (volver a
    montar la suscripcion, no recargar la pagina); los dos textos de "perfil pendiente" dicen cual de los
    dos casos es.
  * **Por que el canal vive aqui y no en T5:** T5 quedo enfocada en el modulo puro
    (`mergeCommunitySellers`) y sus requisitos son RF_01/RF_06/RF_02. Quien necesita el canal es RF_07,
    que es de esta tarea; dejarlo en T5 lo implementaria en una tarea que no lo verifica, y el hook
    bloquearia la escritura aqui.
  * Verificacion: guarda de fuente — `SellerView` no decide con un `if (!seller)` suelto, y el texto de
    "falta vincularla a una tienda" no puede salir tras una carga fallida.

- [x] **T9: La pantalla de la comunidad distingue los motivos, y no esconde el enlace perdido**
  * Requisitos: RF_05, RF_10, RF_11, RF_12
  * Archivos: `src/lib/community-view.ts`, `src/lib/community-view.test.ts`, `src/components/operations-app.tsx`, `src/lib/spec-005-guards.test.ts`
  * Accion: `communityCashbackOwedCop(settlements, communityId)` —suma de los cortes de comunidad no
    pagados, hermana de `communityCashbackPaidCop`—; `CommunityLeaderView` usa `communityStoresState`
    (alimentado por la **callable**, no por la carga base); la tarjeta de error generica deja de absorber
    los tres casos; el acreedor ve que ya no gobierna y **sigue viendo lo que se le debe**. Ademas:
    cuando el parte trae `community_sellers`, la pantalla avisa de que el enlace de invitacion no se
    pudo resolver.
  * **Hay una segunda conflacion que hay que retirar, no solo la tarjeta de error** (encontrada en T4):
    `operations-app.tsx:5069` decide con `if (!stats || stats.emptiness === "no_stores")`, asi que una
    respuesta que **no llego** se pinta como "Todavia no tienes tiendas". Es el espejo del otro fallo —alli
    lo que no es una averia se muestra como averia; aqui "no se pudo saber" se muestra como "no hay
    nada"—. Si se enchufa `communityStoresState` sin quitar ese `!stats ||`, el fallo sobrevive.
  * **La posicion entra por prop:** `CommunityLeaderView` no la recibe hoy (`:4998-5011`) y el sitio de
    llamada (`:13027`) no la pasa; se anade desde `session.communityStanding`, que T6 hace que llegue.
    Del sombrero no se lee: eso es interfaz, y la posicion es lo que la cuenta ES.
  * **De donde sale la deuda del acreedor** (el analisis encontro que no estaba declarada): de
    `state.settlements`, que el acreedor descarga por vinculo y las reglas le abren por
    `isCommunityCreditor` (`firestore.rules:247`). **No** de `getCommunityStats`, que le responde
    `permission-denied` por diseno. Lo causado y aun sin cortar NO se le muestra: vive en
    `walletEntries`, cuya suscripcion la 003 elimino por volumen, y reabrirla seria el fallo del
    principio 11; la pantalla lo dice en vez de pintar un cero mudo.
  * Verificacion: el analisis encontro que `communitySlug` (`operations-app.tsx:5208-5211`) lee
    `state.sellers`, asi que degradar esa mitad **apaga el enlace de invitacion en silencio** — el fallo
    mudo del principio 8 que esta spec existe para eliminar. Guardas: los tres textos, que solo
    `load_failed` ofrece reintentar, y que el aviso del enlace existe y depende del parte. Y prueba de
    comportamiento de `communityCashbackOwedCop`: suma los cortes pendientes de esa comunidad, ignora los
    pagados y conciliados, ignora los de otras comunidades, y da 0 —no `undefined`— sin cortes.

## 5. Que nadie mas cambie

- [x] **T10: No regresion de los cinco papeles sin comunidad**
  * Requisitos: RNF_01, RNF_03
  * Archivos: `src/lib/state-store-targets.test.ts`, `src/lib/session-hats.test.ts`
  * Accion: tabla sobre tienda, logistico, domiciliario, mensajero y administrador **sin vinculo**.
  * Verificacion: mismos objetivos de descarga que hoy, ningun selector, y el mensaje de perfil pendiente
    intacto cuando de verdad no hay tienda. Para la cuenta con vinculo la referencia es la 003: como
    mucho la suma de los dos papeles, y cero documentos al cambiar de papel.

## 6. Cierre

- [x] **T11: El recorrido completo con cuentas desechables (DoD 4 y 5)** — codigo listo; ejecucion tras T13
  * Requisitos: RF_01, RF_03, RF_04, RF_05, RNF_02, RNF_04
  * Archivos: `scripts/verify-005.js`, `src/lib/spec-005-guards.test.ts`
  * Accion: ampliar el guion de T1 con los cinco casos del DoD 4 —tienda-lider que ve su tienda y cambia
    a su comunidad; la misma leyendo una tienda de OTRA comunidad de prueba (debe negarse); lider puro;
    comunidad de prueba sin tiendas; tienda sin comunidad— y la limpieza repetible que comprueba que no
    queda nada con el prefijo.
  * Verificacion: ejecucion contra produccion **despues de T13**, declarada. **RNF_04 se cierra aqui**:
    capturas del selector y de las dos pantallas en escritorio y a 390 px (DoD 5); en T7 solo se afirma
    la forma, no la medida. **El acreedor no se prueba aqui**: fabricarlo exige cashback real y la spec
    lo deja en pruebas automaticas (T4).

- [x] **T12: Verificacion completa**
  * Requisitos: todos (DoD 1 a 3)
  * Archivos: `src/lib/spec-005-guards.test.ts`
  * Accion: `npm test`, `npx tsc --noEmit` en raiz y `functions/`, `npm run lint`, `npm run build` y build
    de functions; comprobar que los chunks no traen `static{` (iOS 14, principio 2).
  * Verificacion: todo en verde; cualquier rojo vuelve a su tarea.

- [x] **T13: Desplegar las reglas y comprobar que la consulta pasa**
  * Requisitos: RF_05, RNF_02
  * Archivos: `scripts/verify-005.js`, `src/lib/spec-005-guards.test.ts`
  * Accion: **el despliegue lo firma el humano** (principio 7; la fase `deploy` del arnes va a
    staging/preview y el unico entorno de esta spec es produccion):
    `firebase deploy --only firestore:rules --project kentro-last-mile`. Despues se repite T1 y se anota
    el resultado.
  * Verificacion: tras desplegar, la consulta `sellers where communityId ==` **pasa** para la cuenta
    desechable, y la lectura de una tienda de OTRA comunidad **sigue denegada** (RNF_02: el arreglo no
    puede abrir de mas). Si el primer resultado no cambia, la causa era otra y se vuelve al plan.

- [x] **T14: El indice que le faltaba a las cifras de la comunidad** (abierta en T11/T13, 2026-09-15)
  * Requisitos: RF_05, RF_10 (y RF_29/RF_30 de la spec 001, que son las cifras)
  * Archivos: `firestore.indexes.json`, `src/lib/spec-005-guards.test.ts`
  * Accion: anadir el indice compuesto de `walletEntries` (`ownerId`, `ownerType`, `createdAt`, `amountCop`, todos
    ascendentes) que exige `sum("amountCop")` con rango de `createdAt` en `getCommunityStats`.
  * Verificacion: hallazgo REAL de la captura de T11: la pantalla de comunidad decia "No se pudieron cargar tus
    cifras — INTERNAL", y el registro de la funcion dice `FAILED_PRECONDITION: The query requires an index`. No es un
    artefacto de los datos desechables: la pantalla siempre manda rango de fechas, asi que **Brayan lo veria igual**.
    Defecto latente de la spec 001 (nadie habia llegado a esta pantalla); el plan de la 005 decia "sin indices nuevos" y
    se equivocaba. Guarda de fuente sobre el archivo de indices. El despliegue de indices lo firma el humano
    (`firebase deploy --only firestore:indexes`; comprobado que local == prod, 39 y 39: no borra ninguno) y hay que
    esperar a que este `READY` antes de repetir la captura.

- [x] **T15: El selector de papel sigue el sistema de diseno** (abierta por la validacion humana, DoD 7, 2026-09-15)
  * Requisitos: RNF_04, RF_03
  * Archivos: `src/components/operations-app.tsx`, `src/lib/session-hats.test.ts`
  * Accion: la pastilla activa del selector Tienda/Comunidad pasa a `bg-acid text-deep` y la inactiva a
    `text-ink-60 hover:text-fg`, como el riel, la barra inferior y las pestanas de pedidos. `aria-pressed` y los 44 px
    se conservan.
  * Verificacion: el responsable lo vio en produccion y lo senalo. En T7 se eligio a proposito la variante sobria
    (activo en `bg-field`) para no juntar dos acidos con el indicador "En vivo"; era la decision equivocada: el
    sistema de diseno dice que *el riel separa trabajos*, Tienda/Comunidad separa dos trabajos y va como el riel, y
    "En vivo" es una insignia tenue, no un control. Guarda de fuente: el JSX de `Header` marca el activo con
    `bg-acid` y `text-deep` (nunca acido con texto claro: 1,7:1) y el inactivo sin acido.

---

## Cobertura: requisito -> tarea

| Req | Tarea | Req | Tarea |
|---|---|---|---|
| RF_01 | T5, T8, T11 | RF_09 | T7 |
| RF_02 | T2, T5 | RF_10 | T4, T9 |
| RF_03 | T7, T11 | RF_11 | T4, T9 |
| RF_04 | T7, T11 | RF_12 | T4, T6, T9 |
| RF_05 | T1, T2, T9, T11, T13 | RNF_01 | T10 |
| RF_06 | T5 | RNF_02 | T1, T2, T11, T13 |
| RF_07 | T3, T8 | RNF_03 | T10 |
| RF_08 | T3, T8 | RNF_04 | T7 (forma), T11 (medida) |

Ningun requisito huerfano.
