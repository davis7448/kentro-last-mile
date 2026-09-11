# Plan tecnico 003: Una persona, su tienda y su comunidad

- **Spec:** `specs/003_doble_rol.md` (aprobada, 27 requisitos)
- **Fecha:** 2026-09-11

## 1. Hallazgos del codigo que condicionan el plan

### H1. El tipo `Actor` ya esta preparado; el candado es una linea

`functions/src/community-access.ts:16` **ya declara los dos campos por separado**:

```ts
export type Actor = { uid: string; role: string; communityId?: string; sellerId?: string; driverId?: string };
```

Lo unico que impide que convivan es el predicado:

```ts
const isLeaderOf = (actor, communityId) =>
  actor.role === "community_leader" && !!communityId && actor.communityId === communityId;
```

De `isLeaderOf` cuelgan **cuatro** predicados, no trece: `canEditCommunityPricing`,
`canEditCommunityBrand`, `canReadCommunityStats` y —por el primero— `canEditTariffConcept`. El
archivo exporta trece booleanos, pero los otros nueve son `isAdmin` puro o estado de comunidad. La
primera version de este plan confundio "predicados del archivo" con "predicados que dependen del
candado".

**Y el que mas importa no se arregla tocando `isLeaderOf`.** `canReadSellerOperational` comprueba el
rol **a mano y con retorno anticipado**:

```ts
if (actor.role === "seller" || actor.role === "seller_logistics") return actor.sellerId === seller.id;
if (actor.role === "community_leader") return !!seller.communityId && seller.communityId === actor.communityId;
```

Una tienda-lider entra por la **primera** rama y devuelve `false` para todas las tiendas de su
comunidad. Hay que reescribirlo como union de los dos derechos, no como cadena de exclusion.

### H2. No hay colision posible entre "lidera" y "pertenece"

Un vendedor recibe `{ role: "seller", sellerId }` — **nunca `communityId`** (`community-signup.ts:133`).
La pertenencia de una tienda a una comunidad vive en el **documento** del vendedor
(`seller.communityId`). Asi que un `communityId` en los reclamos significa siempre **"lidera"**. Es
la razon por la que RF_03 es implementable sin inventar nada.

### H3. `profileId` significa cosas distintas segun el rol — y ese es el problema de verdad

En `operations-app.tsx:12621-12631`, la sesion calcula un **unico** `profileId`: para un vendedor es
su tienda; **para un lider es su comunidad** (con su comentario diciendolo). Una cuenta con los dos
papeles tiene **dos identidades**, y una sola casilla donde ponerlas.

**Consecuencia:** la sesion deja de tener un `profileId` polivalente y pasa a llevar la identidad
operativa **y** la atribucion de comunidad por separado. Es el cambio estructural de esta spec; todo
lo demas se deriva.

### H4. Una comunidad no sabe si tiene lider

El vinculo comunidad↔lider vive **solo** en los reclamos de la cuenta. El documento de la comunidad
no guarda a quien la lidera. Para RF_20 —una comunidad sin lider cobra tarifa base— el servidor
necesita saberlo **al congelar el precio de un pedido**, donde no hay sesion del lider a mano.

**Consecuencia:** el documento de la comunidad gana `leaderUid`. Es la unica forma de que RF_20
funcione, y de paso hace auditable quien lidera sin leer los reclamos de nadie.

### H6. `leaderUid` no existe, y desplegar RF_20 sin migrar apaga el cashback de todas

`grep leaderUid` sobre el repositorio da **cero resultados**, y `createCommunityLeader` escribe nueve
campos en el documento de la comunidad, ninguno de ellos el lider.

**Consecuencia, y es la mas grave de este plan:** desplegar la regla de RF_20 —sin `leaderUid` se
cobra tarifa base— convertiria **todas las comunidades vivas en comunidades sin lider**. Tarifa base
y **cashback cero** en cada pedido nuevo, sin error y sin aviso. Es literalmente la regla de oro #5.

Hacen falta **dos** piezas que la primera version no tenia: escribir `leaderUid` en el alta, y
**rellenar las comunidades que ya existen**. La migracion va **antes** de que RF_20 llegue a
produccion, no despues.

### H7. Una comunidad desactivada tiene que dejar de cobrar el sobreprecio

El caso limite "la comunidad que lidera se desactiva" se apoyaba solo en `leaderUid`. Pero
`planLeaderStatusChange` pone `status: "disabled"` y **declara que no toca nada mas**. Si el precio
solo mira `leaderUid`, una comunidad desactivada **sigue cobrando de mas**. RF_20 tiene que mirar las
dos cosas: sin lider **o** desactivada, tarifa base.

### H8. `Session` no vive donde el plan decia

No esta en `src/lib/types.ts`: es `type Session = Omit<LocalAccount, "password">` en
**`operations-app.tsx:177`**. El corte de tareas que separaba "los tipos" de "la pantalla" era
inviable: son el mismo archivo.

### H5. Las reglas de Firestore repiten el mismo candado, **y hay una tercera capa**

**`storage.rules:24`** tiene su propio `isCommunityLeaderOf()` que exige el rol. Sin tocarlo, una
tienda-lider pasara el predicado y la callable de logo, y **Storage la denegara**. Son tres capas
independientes, no dos.

`firestore.rules:34-42`: `isCommunityLeader()` y `sellerInMyCommunity()` comprueban las dos
`role() == "community_leader"`. Mismo cambio, misma razon. **Sin esto, el servidor sigue negando**
aunque los predicados de las callables pasen: son dos capas independientes.

## 2. Arbol de modulos

### Nucleo puro

| Archivo | Responsabilidad |
|---|---|
| `functions/src/community-access.ts` *(modificar)* | `isLeaderOf` deja de mirar el rol. Se anaden `leadsCommunity(actor)`, `isCreditorOf(actor, communityId)` y el predicado que separa **liderar** de **ser acreedor** (RF_23). |
| `functions/src/community-grant.ts` **(nuevo)** | `planLeadershipGrant` y `planLeadershipRevoke`: que reclamos quedan, que se escribe en la comunidad, y que **no** se toca. Puros. Cubre RF_04, RF_05, RF_06, RF_17, RF_18, RF_19. |
| `functions/src/community-pricing.ts` *(modificar)* | Una comunidad **sin `leaderUid` o desactivada** resuelve a tarifa base y no causa cashback (RF_20, H7), conservando lo ya congelado (RF_21). |
| `scripts/backfill-leader-uid.js` **(nuevo)** | Rellena `leaderUid` en las comunidades que ya existen (H6). Se corre **antes** de desplegar RF_20. |
| `src/lib/session-hats.ts` **(nuevo)** | Que papeles tiene una cuenta, cual esta activo, y si debe verse el selector (RF_07, RF_11). Puro, sin React. |
| `src/lib/community-view.ts` *(modificar)* | El reparto del cashback de la tienda del propio lider (RF_13). |

### Servidor

| Archivo | Responsabilidad |
|---|---|
| `functions/src/communities.ts` *(modificar)* | Callables `grantCommunityLeadership` y `revokeCommunityLeadership`, sobre los planes puros y con la reversion de la spec 001 RF_55. |
| `functions/src/roles.ts` *(modificar)* | **`setUserRole` Y `createManagedUser`** conservan `communityId`: las dos reescriben los reclamos con el mismo patron y las dos lo borrarian. |
| `functions/src/community-stats.ts` *(modificar)* | Construye su `Actor` **inline**, aparte de `actorFrom`. Sin anadirle `communityStanding`, un acreedor seguiria pasando `canReadCommunityStats`. |
| `firestore.rules`, `storage.rules` *(modificar)* | Los candados de H5. **Tres capas, no dos.** Y al quitar el rol hay que exigir que `communityId` exista y no sea vacio, o se abren lecturas de dinero a cuentas sin comunidad. |

### Cliente

| Archivo | Responsabilidad |
|---|---|
| `src/components/operations-app.tsx` *(modificar)* | Ahi vive `Session` (H8). Gana `ledCommunityId?` y `communityStanding?`; `profileId` pasa a ser **solo** la identidad operativa. |
| `src/lib/firebase/state-store.ts` *(modificar)* | `FirestoreStateContext` gana `ledCommunityId?`. Los objetivos del lider se **suman** a los del papel operativo (RF_15, RF_16). |
| `src/components/operations-app.tsx` *(modificar)* | El selector de papel y el reparto de vistas. |

## 3. Modelo de datos

```ts
// Reclamos de la cuenta. `communityId` presente == tiene vinculo con esa comunidad;
// `communityStanding` dice cual.
type Claims = {
  role: Role;                 // el papel OPERATIVO, sin cambios
  sellerId?: string;
  driverId?: string;
  messengerId?: string;
  communityId?: string;       // la comunidad con la que tiene vinculo
  communityStanding?: "leader" | "creditor";
};

// Documento de comunidad (H4)
type CommunityDoc = {
  leaderUid?: string;         // NUEVO. Ausente == sin lider (RF_20)
  leaderName: string;         // se conserva aunque se retire: el historial no se borra
  // ...lo que ya tenia
};

// Cliente
type Session = {
  role: Role;
  profileId: string;          // SOLO la identidad operativa (H3)
  ledCommunityId?: string;
  communityStanding?: "leader" | "creditor";
};

export type Hat = "operational" | "community";
```

**`communityStanding` es lo que hace implementable RF_23.** `leader` causa cashback nuevo y gobierna
precios; `creditor` solo ve y cobra lo ya causado. Retirar el liderazgo **no borra el vinculo**: lo
degrada de uno a otro, y se extingue cuando la deuda llega a cero.

## 4. Algoritmos criticos

### 4.1 Conceder y retirar (RF_04, RF_05, RF_17, RF_18, RF_19)

`planLeadershipGrant({ actor, targetUid, targetClaims, community, nowIso })`:

- Rechaza si `targetClaims.communityId` existe con `standing: "leader"` y es **otra** comunidad
  (RF_06).
- Rechaza si la comunidad ya tiene `leaderUid` **distinto** del destino... **no**: eso es un
  **traspaso** (RF_19), y se permite. Lo que produce es un plan con **dos** efectos: degradar al
  anterior a `creditor` y promover al nuevo a `leader`.
- **Nunca toca** `sellerId`, `driverId` ni `messengerId` del destino (RF_04). Ese es el aserto que
  mas vale de toda la tarea.

`planLeadershipRevoke({ targetClaims, pendingCashbackCop })`:

- Si la deuda es **cero**, el vinculo se elimina entero.
- Si hay deuda, el vinculo **queda como `creditor`** (RF_22, RF_23).
- En los dos casos, `leaderUid` sale del documento de la comunidad (RF_20).

### 4.2 Una comunidad sin lider cobra base (RF_20, RF_21)

`resolveCommunityPricing` recibe hoy el documento de la comunidad. Se anade, **antes de todo lo
demas**: si no hay `leaderUid`, devolver la base. Lo ya congelado en pedidos existentes no se toca
(RF_21) porque el congelado vive en el pedido, no aqui.

**Por que antes de todo:** si se comprobara despues del piso, una comunidad sin lider con precio
propio por encima de la base seguiria cobrando de mas. Cobrarle a una tienda un sobreprecio que no
va a nadie es el fallo que RF_20 existe para impedir.

### 4.3 El sombrero activo no concede permisos (RNF_02) — el algoritmo mas delicado

El sombrero es **estado de interfaz y no viaja al servidor**. El servidor decide por lo que la cuenta
**es**: tiene `sellerId` ⇒ puede leer el saldo de esa tienda, lleve el sombrero que lleve.

RF_09 —como lider no ve el saldo de ninguna tienda, ni la suya— es por tanto **regla de
presentacion**, y la spec lo dice con esas palabras. La alternativa —que el servidor obedezca al
sombrero— pondria la autorizacion en manos del cliente, que es exactamente lo que la constitucion
prohibe en el principio 5.

**Como se prueba el punto 4 del DoD:** no se prueba que "el servidor niega a un usuario con dos
papeles" —no debe negarle, tiene derecho—. Se prueba que **el sombrero no concede**: una cuenta
**sin** `sellerId` no obtiene acceso al saldo de ninguna tienda diga lo que diga su pantalla.

### 4.4 Lo que baja el navegador (RF_15, RF_16)

`FirestoreStateContext` gana `ledCommunityId`. Los objetivos se **suman**: los del papel operativo
tal cual estan hoy, mas los del lider (su comunidad, las tiendas de su comunidad, sus cortes).

**Aqui manda el principio 8 de la constitucion.** Antes de tocar esto hay que comprobar que cifra de
dinero depende de lo que se toca: un recorte mal hecho no falla ni avisa, solo muestra menos dinero
del que se debe — ya paso una vez, $1.135.720 en silencio. Por eso RF_15 esta redactado como una
prohibicion de **perder** cifras, no como un permiso de sumar consultas.

El cambio de sombrero **no dispara ninguna descarga** (RNF_03): los dos conjuntos ya estan en
memoria. Es lo que lo hace inmediato y lo que lo hace medible en documentos.

## 5. Estrategia de testing

| Archivo de prueba | Requisitos |
|---|---|
| `src/lib/community-access.test.ts` | RF_01, RF_02, RF_03, RF_09 (servidor), RF_23, RNF_01, RNF_02 |
| `src/lib/community-grant.test.ts` **(nuevo)** | RF_04, RF_05, RF_06, RF_17, RF_18, RF_19, RF_22 |
| `src/lib/community-pricing.test.ts` | RF_20, RF_21, RF_24 |
| `src/lib/session-hats.test.ts` **(nuevo)** | RF_07, RF_10, RF_11, RNF_03 |
| `src/lib/community-view.test.ts` | RF_13, RF_14 |
| `src/lib/state-store-targets.test.ts` **(nuevo)** | RF_15, RF_16 |

**RNF_01 es el requisito que mas cuidado pide**, porque describe una **no** regresion sobre cinco
papeles que hoy funcionan. Se prueba con una tabla: cada uno de los cinco, con reclamos sin
`communityId`, obtiene exactamente los mismos permisos y los mismos objetivos de descarga que antes.
Si alguien rompe uno, la tabla lo dice y dice cual.

**Lo que Vitest no cubre** —las reglas de Firestore— se verifica con sesion real y usuario
desechable, como ya hace el repo. Queda anotado como paso manual del DoD, no disfrazado de prueba.

## 6. Dependencias nuevas

**Ninguna.**

## 7. Orden de trabajo

1. **`isLeaderOf` y los predicados**, con la tabla de no regresion de RNF_01. Hasta que los cinco
   papeles esten atados, nada mas.
2. Los planes puros de conceder y retirar.
3. `leaderUid` en el documento y la tarifa base sin lider (RF_20).
4. Las reglas de Firestore.
5. La sesion con dos identidades y el selector.
6. El alcance de descarga — el ultimo de los tecnicos, porque es el que toca dinero.
7. El reparto del cashback propio (RF_13) y el aviso de RF_24.

## 8. Orden de despliegue

**Reglas y functions ANTES que hosting.** Un cliente que ya sabe mandar dos identidades contra un
servidor que aun exige rol unico deja al usuario con la pantalla de lider vacia. Al reves no rompe
nada: un servidor permisivo con un cliente viejo se comporta como hoy.

No hay consultas nuevas, asi que **no hacen falta indices**.

## 9. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Se rompe uno de los cinco papeles actuales | RNF_01 con tabla exhaustiva, primero en el orden de trabajo. |
| El sombrero acaba decidiendo permisos | 4.3 y la prueba del DoD 4, que comprueba que **no concede**. |
| Una comunidad sin lider sigue cobrando sobreprecio | RF_20 comprobado **antes** del piso (4.2). |
| Ampliar la descarga esconde una cifra | Principio 8: antes de tocarla, comprobar que dinero depende. RF_15 redactado como prohibicion de perder. |
| Retirar el liderazgo borra una deuda | `communityStanding: "creditor"` (RF_22, RF_23), no eliminacion del vinculo. |
