# Plan tecnico — Spec 005: la tienda que ademas lidera puede entrar y ver sus dos pantallas

- **Spec:** `specs/005_tienda_lider_ve_su_pantalla.md` (aprobada 2026-09-11)
- **Fecha:** 2026-09-13 · **Segunda version**, tras `/sdd-analyze` (14 hallazgos)

## 0. Diagnostico localizado

| Sintoma de la spec | Donde esta en el codigo |
|---|---|
| La tienda desaparece | `firestore.rules:143` usa `sellerInMyCommunity(sellerId)` (`:63-66`), que decide con `exists()` + `get()` sobre el id **comodin** del `match` |
| ... y arrastra todo lo demas | `state-store.ts:170-193`: la carga inicial es **un** `Promise.all` de 21 consultas; la entrada de `sellers` es a su vez un `Promise.all` de dos mitades (tienda propia + tiendas de la comunidad). Un rechazo en cualquiera tumba la carga entera |
| ... en silencio | `state-store.ts:775`: `.catch((error) => console.warn(...))`. `subscribeFirestoreState` (`:431-435`) solo ofrece `onEmpty`; no hay canal de error hacia la pantalla (`operations-app.tsx:438-449`) |
| El mensaje miente | `operations-app.tsx:11177` busca la tienda en `state.sellers`; `:11255` pinta `EmptyRoleState` "Perfil de vendedor pendiente" sin saber si la carga funciono |
| No hay selector | `Header` (`operations-app.tsx:1389-1430`) **desestructura** `canPickHat` y `onHatChange` y no los usa en su JSX (`:1404-1429`). El nucleo `src/lib/session-hats.ts` ya es correcto y esta probado (21 casos): decide por el VINCULO, asi que el acreedor ya tiene sombrero |

### Lo que NO esta comprobado, y como se comprueba

Que la consulta `sellers where communityId == X` sea rechazada es **deduccion**. Y la primera version
de este plan la razonaba mal: decia que el problema es "ser una consulta". Eso no explica nada por si
solo — en un `list` el comodin `{sellerId}` se liga a cada documento candidato, asi que `exists()` y
`get()` **si** resuelven, igual que en la regla de hoy. Hay al menos dos causas posibles y **el codigo
de error es el mismo en las dos**:

1. la forma de la regla (el `get()` sobre el comodin no es evaluable en el modo en que se pide);
2. el **limite de accesos a documento** (10 por lectura simple, 20 por consulta): cada documento
   candidato gasta un `exists()` + un `get()`. Con E-master, que tiene UNA tienda, este limite no
   deberia alcanzarse — lo que **debilita** la deduccion y obliga a medir.

Por eso T1 no se limita a imprimir el codigo: registra el error crudo, cuantas tiendas tiene la
comunidad y una consulta de control. **T1 tiene tres desenlaces**, no dos:

- **no falla** -> la hipotesis esta refutada, se para y se corrige el plan;
- **falla por la forma de la regla** -> sigue T2 tal cual;
- **falla por otra causa** (limite de accesos, indice, otra regla) -> T2 sigue siendo correcto
  (`resource.data` elimina el `get()` y cubre las dos causas), pero hay que anotar la causa real en
  la spec y revisar si toca algo mas.

### Medicion de T1 (2026-09-13, produccion, cuenta desechable)

Desenlace: **`FALLA_PERMISSION_DENIED`**. Con una cuenta que es tienda y ademas lidera, cuya tienda
propia esta FUERA de la comunidad que lidera —el caso exacto de Brayan—, leyendo por REST con su
propia sesion:

| Lectura | Resultado |
|---|---|
| su tienda propia, por id | **pasa**, 1 documento |
| `sellers where communityId ==` la suya | **falla**, `403 PERMISSION_DENIED` |
| control (`cities`, abierta a cualquier sesion) | **pasa**, 1 documento |

El sintoma queda **reproducido**: la mitad de comunidad se rechaza y, por el `Promise.all` de
`state-store.ts:170-193`, se lleva por delante la carga entera. El control descarta que sea la sesion.

**La causa exacta NO queda demostrada, y asi se declara.** La comunidad de prueba tenia **una** tienda,
con lo que el limite de accesos a documento (20 por consulta) no deberia alcanzarse — eso apunta a la
forma de la regla, pero no lo prueba: las dos causas devuelven el mismo codigo. T2 es valido para ambas,
porque `resource.data` elimina a la vez el `get()` y el consumo de accesos. Si tras desplegar la regla
(T13) la consulta sigue fallando, la causa era otra y hay que volver aqui.

Evidencia: `.sdd/evidence/005/verify-reproduce.json`.

### Dos hallazgos del analisis que cambian el alcance

1. **El patron que si funciona ya esta en el repo.** `messengers:173`, `pickupBatches:187`,
   `orders:194-198`, `inventory:215` y `productCatalog:224` autorizan comparando `resource.data.<campo>`
   con el reclamo. `sellerInMyCommunity` es la **unica** regla del archivo que hace `exists()`/`get()`
   sobre el comodin de su propio `match` (el otro helper con `get()`, `messengerBelongsToDriver:72-77`,
   lo hace sobre `resource.data.messengerId`, que es otra cosa). Un domiciliario lista hoy sus
   mensajeros (`state-store.ts:202` y `:505`) contra `messengers:173` y funciona en produccion.
2. **`CommunityLeaderView` SI depende de `state.sellers`** — la primera version de este plan decia lo
   contrario y era falso en el punto que importa. Es cierto que la lista de tiendas y sus cifras llegan
   de `fetchCommunityStats` (`operations-app.tsx:5017-5030`), pero `:5049` llama a `communitySlug`
   (`:5208-5211`), que es `state.sellers.find(item => item.communityId === communityId)?.communitySignupSlug`
   — o sea, **la mitad de comunidad que 3.2 vuelve degradable**. Si esa mitad se rechaza, el lider ve su
   tarjeta "Todavia no tienes tiendas" **sin el enlace de invitacion**, sin que nada avise: el mismo
   tipo de fallo mudo que esta spec existe para eliminar (principio 8 de la constitucion). Por eso la
   degradacion de 3.2 **no es gratis** y tiene que contarse en pantalla.

## 1. Arbol de modulos

### Nuevo

- **`src/lib/load-status.ts`** — PURO. Que tiene derecho a decir la pantalla segun como fue cada carga:
  `storeProfileState`, `communityStoresState` y `mergeCommunitySellers` (la union de las dos mitades y
  el parte de lo que falto). Sin React ni Firestore, por tanto **importable desde las pruebas**.
- **`src/lib/load-status.test.ts`** — pruebas de comportamiento de ese modulo.
- **`src/lib/spec-005-guards.test.ts`** — guardas de fuente de la spec 005 (reglas, guion de
  verificacion y pantallas). Archivo aparte y con nombre por tema, siguiendo el precedente de
  `state-store-targets.test.ts`: mezclarlas con las pruebas del modulo puro las esconde.
- **`scripts/verify-005.js`** — T1 y DoD 4: recorrido con cuentas, tiendas y comunidades desechables
  con prefijo `smoke005-`, pasos idempotentes, sin tocar E-master ni el registro de dinero.

### Modificados

- **`firestore.rules`** — `sellerInMyCommunity` decide con `resource.data`.
- **`src/lib/firebase/state-store.ts`** — usa `mergeCommunitySellers`; `subscribeFirestoreState` gana
  `onError` y entrega el parte de carga.
- **`src/components/operations-app.tsx`** — `Header` pinta el selector; la suscripcion recibe el error;
  `SellerView` decide con `storeProfileState`; `CommunityLeaderView` distingue los motivos y avisa
  cuando el enlace de invitacion no se pudo resolver.
- **`src/lib/firebase/auth.ts`** — propaga `communityStanding` (cabo suelto de la 003).
- **`src/lib/community-view.ts`** y **`src/lib/community-view.test.ts`** — `communityCashbackOwedCop`,
  la cifra que RF_12 le sigue mostrando al acreedor (ver 3.6), y su prueba. Hermana de
  `communityCashbackPaidCop`, en el mismo modulo puro y en el archivo donde ya vive esa familia.
- **`src/lib/session-hats.test.ts`**, **`src/lib/state-store-targets.test.ts`** — extendidos.

**Lo que NO se toca:** `src/lib/session-hats.ts` (su nucleo ya es correcto), `functions/` (no hay
callable nueva), `firestore.indexes.json` (la consulta ya existia), y nada de la spec 004.

## 2. Modelo de datos

```ts
// src/lib/load-status.ts
/** Como fue UNA carga. Hay dos independientes y no se mezclan: ver 3.5. */
export type LoadOutcome = "loading" | "ok" | "failed";

/** Que parte de la carga base falto. Una caida no implica las demas. */
export type LoadIssue = "community_sellers";
export type LoadReport = { issues: readonly LoadIssue[] };

export type StoreProfileState =
  | { kind: "loading" }
  | { kind: "ok"; sellerId: string }
  | { kind: "load_failed" }          // RF_07: aviso + reintentar
  | { kind: "no_store_assigned" }    // RF_08, caso 1
  | { kind: "store_missing" };       // RF_08, caso 2

export function storeProfileState(input: {
  outcome: LoadOutcome;              // la carga BASE
  sellerId: string;                  // el del reclamo; "" si la cuenta no tiene tienda
  sellers: ReadonlyArray<{ id: string }>;
}): StoreProfileState;

export type CommunityStoresState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "load_failed" }     // RF_10
  | { kind: "no_stores" }       // RF_11
  | { kind: "not_governing" };  // RF_12

export function communityStoresState(input: {
  statsOutcome: LoadOutcome;                     // la CALLABLE getCommunityStats, no la carga base
  standing: "leader" | "creditor" | undefined;
  /** Tal cual lo emite el servidor: functions/src/community-stats-math.ts:151. */
  emptiness: "no_stores" | "no_orders_in_period" | null | undefined;
}): CommunityStoresState;

/** La union de las dos mitades de `sellers` y el parte de lo que falto (3.2). */
export function mergeCommunitySellers<T extends { id: string }>(input: {
  own: readonly T[];
  community: readonly T[] | { failed: true };
}): { sellers: T[]; report: LoadReport };
```

`emptiness` se declara **exactamente** como lo emite el servidor
(`functions/src/community-stats-math.ts:151,186`): `"no_stores" | "no_orders_in_period" | null`. La
primera version de este plan inventaba un `"none"` que no existe y omitia `null`.

```ts
// src/lib/firebase/state-store.ts
export function subscribeFirestoreState(
  context: FirestoreStateContext | undefined,
  onState: (state: AppState, report: LoadReport) => void,
  onEmpty?: () => void,
  onError?: (error: unknown) => void       // la carga base fallo entera (RF_07)
): () => void;
```

La sesion no cambia de forma: `ledCommunityId` y `communityStanding` ya existen
(`operations-app.tsx:183-191`). **Cabo suelto de la 003 confirmado:** `subscribeFirebaseUser`
(`src/lib/firebase/auth.ts:11-18` y `:40-46`) no declara ni emite `communityStanding`, asi que
`session.communityStanding` es **siempre** `undefined` y el cast de `:12921` lo admite en su propio
comentario. Hoy no rompe nada (los sombreros los da el vinculo) pero RF_12 lo necesita.

## 3. Algoritmos criticos

### 3.1 Una regla sin `get()` sobre el comodin (RF_05, RNF_02)

```
function sellerInMyCommunity() {
  return isCommunityLeader(resource.data.get("communityId", ""));
}
match /sellers/{sellerId} {
  allow read: if isAdmin() || isStoreMember(sellerId) || sellerInMyCommunity();
}
```

- Para leer **una** tienda suelta, `resource.data` es el documento leido: el lider sigue pudiendo.
- Para la **consulta** `where("communityId","==",X)`, la condicion se evalua contra cada documento
  devuelto sin gastar accesos a otros documentos — que es la diferencia con la regla de hoy, y lo que
  cubre **las dos causas posibles** de 0: desaparece el `get()` (causa 1) y desaparece el consumo de
  accesos (causa 2). Es la misma forma que `messengers:173`, la consulta equivalente que funciona.
- `get("communityId","")` y no `resource.data.communityId`: una tienda sin comunidad no tiene el campo,
  y leerlo directo es error de evaluacion, no `false`.
- **Se retira un `exists()` que tenia un motivo escrito** (`firestore.rules:61-62`: iba antes del `get`
  para no denegar por error de evaluacion con un id inexistente). Con la forma nueva ese caso cambia de
  naturaleza, no desaparece: en la lectura de un documento que no existe `resource` es nulo y
  `resource.data` vuelve a ser error de evaluacion. El desenlace sigue siendo **denegar**, que es lo
  correcto y lo que ya pasa hoy; y en el caso que le importa a RF_08 —la tienda propia que ya no
  existe— corta antes `isStoreMember(sellerId)`, que no mira el documento.
- **No amplia el acceso** (RNF_02): `isCommunityLeader` sigue exigiendo reclamo presente, no vacio e
  igual al de la comunidad, y excluye al acreedor.

### 3.2 La mitad de comunidad no puede tumbar la tienda propia (RF_06, RF_01)

En `loadFirestoreState` (`:182-193`) la entrada de `sellers` pasa a:

1. tienda propia: como hoy (`getOwnDocument`); **si falla, falla la carga** — sin ella la pantalla de
   una tienda no tiene sentido;
2. tiendas de la comunidad: envuelta, de modo que un rechazo entregue `{ failed: true }`;
3. `mergeCommunitySellers` une ambas (conserva `mergeById`: la tienda propia que ademas pertenece a su
   comunidad aparece **una sola vez**) y devuelve el parte.

**La degradacion no es gratis y no se calla.** Por el hallazgo 2 de la seccion 0, sin la mitad de
comunidad el lider pierde el enlace de invitacion (`communitySlug`). Por eso el parte viaja al llamador
y `CommunityLeaderView` lo dice (3.5). Es una excepcion acotada al **principio 8** de la constitucion
—"antes de recortar una descarga, comprobar que depende de lo recortado"—, y la comprobacion es
justamente esta: depende el enlace, no depende ninguna cifra de dinero (el cashback del lider llega
agregado del servidor y el saldo de la tienda por su propia mitad).

El `Promise.all` general se mantiene: si falla cualquier otra coleccion, la carga base falla entera y
eso es RF_07.

### 3.3 Que tiene derecho a decir la pantalla de la tienda (RF_07, RF_08)

| outcome (carga base) | sellerId | ¿esta en `sellers`? | resultado |
|---|---|---|---|
| `loading` | — | — | `loading` |
| `failed` | — | — | `load_failed` (RF_07; **nunca** "perfil pendiente") |
| `ok` | `""` | — | `no_store_assigned` (RF_08, caso 1) |
| `ok` | `s-1` | no | `store_missing` (RF_08, caso 2) |
| `ok` | `s-1` | si | `ok` |

El reintento vuelve a montar la suscripcion (la via que ya usa el cambio de sesion), no recarga la
pagina.

### 3.4 El selector (RF_03, RF_04, RF_09, RNF_04)

No hay logica nueva: `availableHats`, `defaultHat` y `shouldShowHatSelector` ya existen y estan
probados, y deciden por el vinculo (por eso el acreedor lo recibe). Falta pintarlo: dos pildoras en
`Header`, visibles solo si `canPickHat`, con la activa marcada y `aria-pressed`, **dentro del JSX que
`Header` devuelve** y antes de cualquier retorno anticipado de contenido, para que siga visible con el
aviso de error (RF_03). Cambiar de sombrero solo cambia estado de React: cero documentos (RNF_03) y sin
volver a entrar (RF_04). Se abre la tienda primero (RF_09) porque `defaultHat` ya lo decide.

Movil (RNF_04): pildoras con `min-w-0` y texto corto ("Tienda" / "Comunidad") para caber a 390 px junto
al nombre, el indicador de "En vivo" y el boton de salir. Sin nada que iOS 14 no entienda (principio 2).

### 3.5 Por que no hay tiendas en la pantalla de comunidad (RF_10, RF_11, RF_12)

**Son dos cargas distintas y no se mezclan**, que es la contradiccion que el analisis encontro en la
primera version:

- la **callable** `fetchCommunityStats` trae la lista de tiendas y sus cifras -> alimenta
  `statsOutcome` y decide los cuatro estados de abajo;
- la **carga base** (`LoadReport`) solo aporta si falto la mitad de `sellers` -> eso **no** cambia el
  estado: anade un aviso aparte de que el enlace de invitacion no se pudo resolver.

| standing | statsOutcome | emptiness | resultado |
|---|---|---|---|
| `creditor` | cualquiera | cualquiera | `not_governing` — "Ya no gobiernas esta comunidad", **sin** reintentar, con el cashback aun visible (RF_22 de la 003) |
| `leader` | `loading` | — | `loading` (la rama que ya existe en `:5052-5058`) |
| `leader` | `failed` | — | `load_failed` — "No se pudo cargar" + reintentar |
| `leader` | `ok` | `"no_stores"` | `no_stores` — la tarjeta que ya existe (`:5078-5092`) |
| `leader` | `ok` | `"no_orders_in_period"` \| `null` \| ausente | `ok` |

La tarjeta de error generica de `:5060` deja de absorber los tres casos.

**De donde sale `standing`:** hoy `CommunityLeaderView` no lo recibe — sus props (`:4998-5011`) son
`state`, `communityId` y el rango de fechas, y el sitio de llamada (`:13027`) no pasa posicion. Entra
como **prop nueva** desde la sesion (`session.communityStanding`, que T6 hace que por fin llegue). No se
lee del sombrero: el sombrero es estado de interfaz y la posicion es lo que la cuenta ES (RNF_02 de la
003).

### 3.6 Que significa "seguir mostrandole lo que se le debe" (RF_12)

El analisis encontro que la promesa no tenia fuente: la unica cifra de deuda que pinta hoy la pantalla
es `stats.totals.cashbackPendingCop` (`:5138`), y viene de `getCommunityStats`, que al acreedor le
responde `permission-denied` **por diseno** (`community-access.ts:73,130-132`). Con el estado
`not_governing` esa llamada ya no se hace, asi que sin una fuente nueva la cifra desapareceria.

**La fuente son sus cortes, que el acreedor SI descarga y SI puede leer:**

- reglas: `settlements` con `kind: "community_leader"` se abren por `isCommunityCreditor`
  (`firestore.rules:247`), no por lider — la 003 lo dejo asi a proposito (RF_22);
- descarga: `communityTargets` en `state-store.ts` pide esos cortes por el **vinculo**, no por la
  posicion, y `state-store-targets.test.ts:136-144` lo protege.

`communityCashbackOwedCop(settlements, communityId)` = suma de `netCop` de los cortes de esa comunidad
cuyo estado **no** es `paid` ni `reconciled`. Es la hermana exacta de `communityCashbackPaidCop`
(`community-view.ts:230-238`), en el mismo modulo puro y con la misma forma, para que no puedan
divergir.

**Lo que NO se le muestra, y por que:** el cashback ya causado pero aun **sin cortar** vive en
`walletEntries` (que las reglas tambien le abren, `:238`) y el cliente **no lo descarga**: la 003 (T42)
elimino esa suscripcion porque crecia un documento por pedido cerrado de la comunidad. Reabrirla aqui
seria el mismo fallo por la puerta de atras (principio 11). Si un dia hay que ensenarselo, se agrega en
servidor, como `getPlatformPosition`, y es otra spec. La pantalla lo dice con todas las letras en vez de
pintar un cero mudo.

## 4. Estrategia de testing

- **Nucleo puro en Vitest** (`load-status.test.ts`): las tablas de 3.3 y 3.5 caso a caso, y
  `mergeCommunitySellers` (union, sin duplicar la tienda propia, parte con y sin fallo).
- **Por que el nucleo existe:** `state-store.ts` importa el SDK de Firebase y **no se puede importar**
  desde una prueba (entorno `node`); `state-store-targets.test.ts:15-26` lo declara y por eso lee el
  archivo como texto. Sacar la union y el parte a `load-status.ts` es lo que convierte la verificacion
  de 3.2 en comportamiento en vez de una regex.
- **DoD 2, el hueco por el que se colo la 003:** la guarda vieja (`session-hats.test.ts:349-351`) solo
  exige que `shouldShowHatSelector(` aparezca **en el archivo**, y por eso pasa hoy con el selector
  invisible. Se endurece: el uso tiene que estar **dentro del JSX de `Header`**, con las dos etiquetas.
- **Reglas:** guarda de fuente (`sellerInMyCommunity` sin `get(`/`exists(` **sobre rutas** — el
  `resource.data.get("communityId","")` de 3.1 lleva un `get(` que no lo es y la guarda no puede
  confundirlos—, el `match` la usa,
  `isCommunityLeader` sigue exigiendo reclamo no vacio). No son probables en Vitest (no hay
  `@firebase/rules-unit-testing`: es la spec 002, sin implementar); su canal real es T1 y el DoD 4.
- **Descarga (RNF_03) y no regresion (RNF_01):** `state-store-targets.test.ts`. **Ojo:** su prueba de
  `:136-144` exige que `state-store.ts` NO mencione `communityStanding` (RF_22 de la 003); el cambio de
  3.2 no debe introducirlo.
- **Lo que no es probable en unidad y se declara:** las reglas contra el servidor real, el recorrido con
  cuentas desechables, las capturas a 390 px (RNF_04) y el despliegue.

## 5. Dependencias nuevas

Ninguna.

## 6. Desviaciones del stack por defecto del usuario

Firebase en vez de Prisma/PostgreSQL (constitucion). No hay API nueva ni validacion de entrada que
anadir. Los cuatro estados de UI asincrona (cargando / error / vacio / exito) son el objeto de 3.3 y 3.5.

## 7. Despliegue

1. **Reglas primero y solas:** `firebase deploy --only firestore:rules --project kentro-last-mile`.
   Sin esto el cliente nuevo seguiria recibiendo la misma negativa.
2. Repetir T1 con la cuenta desechable: la consulta debe pasar, y la de una tienda de OTRA comunidad
   debe seguir denegada.
3. **Hosting:** `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only hosting --project kentro-last-mile`.
   La variable es obligatoria aunque no se toque ninguna callable: `/registro/[slug]` es dinamica y
   arrastra la funcion SSR, que dispara el guard (comprobado el 2026-09-13; `CLAUDE.md` y
   `docs/deploy.md` documentan hoy comandos que fallan).
4. Sin functions y sin indices nuevos.

**Cuidado: el paso 3 publica mas de lo que dice.** El arbol de trabajo arrastra la spec 004 con su
hosting **sin desplegar** (`.sdd/state.json`: `hostingDeployed: null`, y su DoD 6 pendiente de firma), y
toca los mismos archivos de cliente (`operations-app.tsx`, `community-view.ts`, `finance.ts`,
`types.ts`). Esta spec no escribe nada de la 004, pero subir hosting para la 005 **publicaria tambien su
interfaz** (el panel con "Fallido $12.000 (base)"). Dos salidas, y hay que elegir antes de desplegar:
cerrar la 004 primero —lo natural, porque su backend ya esta en produccion y la pantalla va por detras—,
o declarar este despliegue como conjunto y verificar las dos specs en la misma pasada.

**Quien despliega:** el humano (principio 7). La fase `deploy` del arnes va a staging/preview, y el
unico entorno de esta spec es produccion; por eso T13 existe y declara ese paso como humano.

## 8. Riesgos

- **Que la causa del 403 sea otra.** T1 lo mide antes de tocar nada, con tres desenlaces (seccion 0).
- **Tocar una regla de lectura de tiendas.** El riesgo no es que falle: es que abra de mas. Por eso el
  DoD 4 exige el caso negativo —leer una tienda de otra comunidad— y no solo el positivo.
- **Degradar la mitad de comunidad.** Un `[]` mudo seria el fallo del principio 8; por eso el parte
  viaja y la pantalla avisa de que el enlace no se pudo resolver.
