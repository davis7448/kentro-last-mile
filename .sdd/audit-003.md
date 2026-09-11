# Auditoria de trazabilidad — spec 003 "Una persona, su tienda y su comunidad"

- **Spec:** `specs/003_doble_rol.md` (27 requisitos: RF_01–RF_24 + RNF_01–RNF_03)
- **Plan:** `specs/003_plan.md` · **Tareas:** `specs/003_tasks.md` (15 tareas, las 15 `done: true`)
- **Rama:** `feat/pedido-manual-multilinea` · **HEAD:** `fa0041a`
- **Fecha:** 2026-09-11
- **Auditor:** contexto limpio, sin permiso de escritura sobre codigo de produccion.

---

## 0. Como se leen las dos columnas de "estado"

Tres tareas declararon en `.sdd/state.json` un canal de verificacion **distinto de Vitest**, y esta
auditoria **no los mezcla** con la cobertura automatizada:

| Canal declarado | Tareas | Motivo declarado |
|---|---|---|
| Sesion real con usuario desechable (callables) | T6, T9 | Las callables importan `firebase-admin`; la raiz no puede cargarlo en Vitest (`environment: "node"`, `include: src/**/*.test.ts`) |
| Sesion real con usuario desechable (reglas) | T10 | No hay `@firebase/rules-unit-testing` instalado |
| Pasada en seco contra produccion | T7 | Guion de migracion de un solo uso; no es probable en unidad y no se despliega |

**Un canal declarado no es cobertura automatizada.** En la matriz, `cubierto` significa que existe
un `it()` que se ejecuta en `npm test` y pasa. `canal declarado` significa que hay un procedimiento
escrito; mas abajo se dice, para cada uno, si consta que **se haya ejecutado**.

---

## 1. Matriz de trazabilidad

Los nombres son los literales de los `it()`. Cuando un requisito tiene varias pruebas se cita la
que lo ata de forma mas directa, con el recuento total entre parentesis.

### 1.1 Los dos papeles conviven (3.1)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_01 | `RF_01: el vector completo de la tienda-lider, celda a celda` (+8 mas) | `src/lib/community-access.test.ts:1561` | cubierto |
| RF_02 | `RF_02: el liderazgo es atribucion de la cuenta y no se deduce del papel operativo` (+2) | `src/lib/community-access.test.ts:1498` | cubierto |
| RF_03 | `RF_03: liderar no es pertenecer — la tienda de com-1 sin atribucion no lidera nada` · `RF_03: y al reves — se lidera com-1 con la tienda propia dentro de com-2` | `src/lib/community-access.test.ts:1516, 1528` | cubierto |
| RF_04 | `RF_04: el plan NO nombra sellerId, driverId ni messengerId a ninguna profundidad` (+6, con control positivo del barrido) | `src/lib/community-grant.test.ts:151` | cubierto |
| RF_06 | `RF_06: si el destino ya lidera OTRA comunidad se rechaza, y el motivo dice cual` (+2) | `src/lib/community-grant.test.ts:224` | cubierto |

### 1.2 Que es conceder el liderazgo (3.2)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_17 | `RF_17: crear la comunidad y asignarla es el MISMO plan, no dos llamadas` (+6) | `src/lib/community-grant.test.ts:207` | cubierto **en el plan puro**; el cableado de la callable va por canal declarado (T6/T9) |
| RF_18 | `RF_18: tras el plan la comunidad tiene EXACTAMENTE un leaderUid` (+4) | `src/lib/community-grant.test.ts:363` | cubierto |
| RF_19 | `RF_19: asignar una comunidad que ya tiene lider es un TRASPASO: degrada al anterior y promueve al nuevo` (+4) | `src/lib/community-grant.test.ts:304` | cubierto |

### 1.3 Retirar el liderazgo (3.3)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_05 | `RF_05: con deuda cero los reclamos quedan EXACTAMENTE como antes de concederle el liderazgo` (+15) | `src/lib/community-grant.test.ts:595` | cubierto **en el plan puro**; la callable, canal declarado (T9) |
| RF_20 | `RF_20: sin lider se cobra la tarifa base y no se causa cashback` (+7) | `src/lib/community-pricing.test.ts:945` | cubierto |
| RF_21 | `RF_21: lo ya congelado en un pedido no cambia cuando la comunidad se queda sin lider` | `src/lib/community-pricing.test.ts:1050` | cubierto |
| RF_22 | `RF_22: con deuda pendiente el vinculo QUEDA como acreedor y conserva el communityId` · `RF_22: un acreedor SI sigue siendo acreedor de la comunidad que lidero` · `RF_22: la descarga de los cortes no se filtra por la posicion, solo por el vinculo` | `community-grant.test.ts:612`, `community-access.test.ts:1723`, `state-store-targets.test.ts:136` | cubierto |
| RF_23 | `RF_23: la tabla de las dos posiciones, celda a celda` (+13 entre los dos archivos) | `community-access.test.ts:1826`, `community-grant.test.ts:746ss` | cubierto |

### 1.4 Lo que se ve en cada momento (3.4)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_07 | `RF_07: el selector aparece exactamente cuando hay mas de un sombrero, sin excepciones` (+8) | `src/lib/session-hats.test.ts:181` | cubierto |
| **RF_08** | **—** | **—** | **SIN COBERTURA** |
| **RF_09** | **—** | **—** | **SIN COBERTURA** |
| RF_10 | `RF_10: las tres funciones dependen SOLO de los reclamos — aridad uno` (+3) | `src/lib/session-hats.test.ts:254` | cubierto |
| RF_11 | `RF_11: los SEIS papeles sin vinculo se quedan sin selector — tabla exhaustiva` (+7 en session-hats, +2 en community-grant) | `session-hats.test.ts:114`, `community-grant.test.ts:790` | cubierto |

### 1.5 La tienda del propio lider (3.5)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_12 | `RF_12: la tienda del propio lider causa cashback igual que cualquier otra` | `src/lib/community-pricing.test.ts:1070` | cubierto |
| RF_13 | `RF_13: la fila separa cuanto del cashback procede de la tienda del propio lider` (+5) | `src/lib/community-view.test.ts:2358` | cubierto |
| RF_14 | `RF_14: la tienda del lider cuenta como una tienda mas y su cashback cuenta en el total` | `src/lib/community-view.test.ts:2394` | cubierto |
| RF_24 | `RF_24: el plazo de subida es el mismo aunque su tienda sea la UNICA afectada` (+4) | `src/lib/community-view.test.ts:2518` | cubierto |

### 1.6 Lo que baja el navegador (3.6)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_15 | `RF_15: los objetivos de comunidad se AÑADEN a los del papel operativo` (+11) | `src/lib/state-store-targets.test.ts:147` | cubierto **como guarda de fuente** (no como medicion) |
| RF_16 | `RF_16: el papel de comunidad aporta cortes y nada mas: cero pedidos, cero asientos` (+2) | `src/lib/state-store-targets.test.ts:191` | **cubierto solo estructuralmente**; la medicion en documentos que exige el propio RF_16 no existe |

### 1.7 No funcionales (4)

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RNF_01 | `RNF_01: los SEIS papeles de hoy, sin atribucion de liderazgo, conservan permiso por permiso` · `RNF_01: los SEIS papeles sin communityId siguen sin gobernar y sin cobrar nada` (+2) | `src/lib/community-access.test.ts:1395, 1771` | cubierto |
| RNF_02 | `RNF_02: la posicion se lee de los reclamos, no se anota ni se pregunta a la pantalla` (+ apoyos: `RF_02: los predicados siguen sin mutar al actor ni cambiar de aridad`, `RNF_03: state-store.ts no menciona el sombrero por ningun lado`) | `community-access.test.ts:1802, 1577`, `state-store-targets.test.ts:118` | **cubierto solo en la capa de predicados**; las TRES capas de reglas van por canal declarado (T10) |
| RNF_03 | `RNF_03: state-store.ts no menciona el sombrero por ningun lado` · `RNF_03: el contexto de descarga tampoco lleva el sombrero activo` | `src/lib/state-store-targets.test.ts:118, 128` | **cubierto solo estructuralmente**; "cero documentos" no esta medido |

### 1.8 Casos limite (seccion 5 de la spec)

| Caso limite | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| Tienda con pedidos abiertos al recibir el liderazgo (RF_04) | `RF_04: el parche cambia exactamente tres claves y ninguna mas` · `RF_04: una tienda sigue siendo tienda — el parche conserva el role operativo tal cual` | `community-grant.test.ts:181, 169` | cubierto |
| La tienda del lider entra a su comunidad a mitad de periodo (RF_12, RF_14) | — (el eje `communityJoinedAt` viene de la spec 001; **ningun `it()` de la 003 lo ata para la tienda del propio lider**) | — | **SIN COBERTURA** |
| Se retira el liderazgo con cashback pendiente (RF_05, RF_22) | `RF_22: con deuda pendiente el juego de reclamos resultante sigue nombrando la comunidad` · `RF_05: el leaderUid sale del documento de la comunidad TAMBIEN con deuda pendiente` | `community-grant.test.ts:623, 635` | cubierto |
| Traspaso con cashback pendiente del anterior (RF_19, RF_22) | `RF_19 / RF_22: el lider saliente CONSERVA su communityId — es lo que le deja cobrar lo ya causado` · `RF_19: el traspaso no nombra ni un asiento, ni un corte, ni un pedido del saliente` | `community-grant.test.ts:320, 351` | cubierto |
| Se desactiva la cuenta: caen los dos papeles a la vez | — | — | **SIN COBERTURA** (se apoya implicitamente en que deshabilitar la cuenta de Auth apaga el token entero; nadie lo afirma) |
| La comunidad que lidera se desactiva (RF_05, RF_22) | `RF_20: una comunidad desactivada tambien cobra la base, aunque conserve su leaderUid` | `community-pricing.test.ts:987` | **parcial** — cubierto el lado del precio; "pierde el papel" no lo afirma ninguna prueba, y `planLeaderStatusChange` sigue sin tocar los reclamos |
| Cuenta que lidera com-1 y cuya tienda pertenece a OTRA (RF_03) | `RF_03: y al reves — se lidera com-1 con la tienda propia dentro de com-2` | `community-access.test.ts:1528` | cubierto |
| Selector en un movil (RF_07) | — | — | **SIN COBERTURA** (es visual; correspond a `/sdd-verify`) |
| Sesion abierta cuando se retira el liderazgo: el servidor niega desde el primer intento (RF_05, RNF_02) | — | — | **SIN COBERTURA automatizada**; depende de las reglas, canal declarado T10 no ejecutado |

### 1.9 Recuento

- Requisitos **con prueba automatizada que pasa**: **25 de 27**.
- Requisitos **sin ninguna prueba y sin canal declarado**: **2** — RF_08 y RF_09.
- Requisitos **cubiertos solo por guarda de fuente / argumento estructural**, no por medicion ni por
  ejercicio real: RF_15, RF_16, RNF_02 (capa de reglas), RNF_03.
- Casos limite de la seccion 5: **4 de 9 cubiertos**, 1 parcial, 4 sin cobertura.
- Pruebas de la spec 003: **148** (`community-grant` 58, `community-access` 27, `session-hats` 21,
  `state-store-targets` 19, `community-view` 12, `community-pricing` 11).

---

## 2. Ejecucion real de la suite

```
$ npm test

> kentro@0.1.0 test
> vitest run

 RUN  v3.2.4 /root/kentro-last-mile

 ✓ src/lib/community-pricing.test.ts (50 tests) 29ms
 ✓ src/lib/barcode.test.ts (14 tests) 50ms
 ✓ src/lib/community-grant.test.ts (58 tests) 54ms
 ✓ src/lib/community-access.test.ts (106 tests) 40ms
 ✓ src/lib/evidence-queue.test.ts (12 tests) 34ms
 ✓ src/lib/community-stats.test.ts (18 tests) 14ms
 ✓ src/lib/finance.test.ts (44 tests) 23ms
 ✓ src/lib/order-corrections-plan.test.ts (24 tests) 26ms
 ✓ src/lib/session-hats.test.ts (21 tests) 22ms
 ✓ src/lib/driver-history.test.ts (4 tests) 14ms
 ✓ src/lib/actions.test.ts (8 tests) 12ms
 ✓ src/lib/settlement-math.test.ts (20 tests) 17ms
 ✓ src/lib/product-catalog.test.ts (13 tests) 24ms
 ✓ src/lib/community-containment.test.ts (41 tests) 18ms
 ✓ src/lib/community-slug.test.ts (17 tests) 14ms
 ✓ src/lib/community-corrections.test.ts (4 tests) 9ms
 ✓ src/lib/state-store-targets.test.ts (19 tests) 12ms
 ✓ src/lib/order-export.test.ts (4 tests) 8ms
 ✓ src/lib/inventory-movements.test.ts (22 tests) 39ms
 ✓ src/lib/date-ranges.test.ts (14 tests) 25ms
 ✓ src/lib/gmf.test.ts (7 tests) 8ms
 ✓ src/lib/merge-wallet.test.ts (6 tests) 7ms
 ✓ src/lib/seller-ledger.test.ts (12 tests) 21ms
 ✓ src/lib/order-labels.test.ts (3 tests) 4ms

 Test Files  28 passed (28)
      Tests  728 passed (728)
   Duration  16.27s
```

**Cobertura medida: no hay herramienta de cobertura configurada.** `vitest.config.ts` no declara
bloque `coverage` y `@vitest/coverage-v8` / `@vitest/coverage-istanbul` no estan instalados
(`node_modules/@vitest/` contiene `expect, mocker, pretty-format, runner, snapshot, spy, utils`).
**No se estima un porcentaje.** La unica medida de cobertura de esta auditoria es la matriz de la
seccion 1, que es trazabilidad por requisito, no por linea.

### 2.1 Verificacion de tipos y linters

```
$ npx tsc --noEmit                  # raiz      → exit 0, sin salida
$ cd functions && npx tsc --noEmit  # functions → exit 0, sin salida
$ npm run lint
  src/components/operations-app.tsx
    454:6   warning  React Hook useEffect has missing dependencies: 'session' and 'state'
    771:67  warning  React Hook useMemo has a missing dependency: 'state'
   2483:6   warning  React Hook useEffect has a missing dependency: 'processQueue'
  ✖ 3 problems (0 errors, 3 warnings)
```

Los tres avisos son los tres `exhaustive-deps` preexistentes que el `CLAUDE.md` ya declara
conocidos. `react-hooks/rules-of-hooks` (que va como **error**) esta limpio.

---

## 3. Estado de los tres canales declarados

| Canal | Tareas | Consta ejecutado? | Evidencia |
|---|---|---|---|
| Pasada en seco de la migracion de `leaderUid` | T7 | **SI** | `docs/migraciones.md` recoge la pasada del 11-09-2026: `comunidades: 0 / ya tenian leaderUid: 0 / se escribirian: 0 / sin lider: 0 / ambiguas: 0`. Produccion no tiene todavia ninguna comunidad, asi que **hoy la migracion es un no-op**: es una pasada valida, pero **no ejercita ni una sola escritura del guion**. El propio documento pide repetirla en seco antes de desplegar la regla de precio. |
| Sesion real con usuario desechable — callables (`grantCommunityLeadership`, `revokeCommunityLeadership`, `setUserRole`, `createManagedUser`) | T6, T9 | **NO CONSTA** | No hay guion de verificacion en `scripts/`, no hay nada en `.sdd/evidence/003/` (el directorio no existe; solo hay `001/`), y ni las tareas ni `state.json` registran una pasada. El canal esta **declarado, no ejercido**. |
| Sesion real con usuario desechable — reglas de Firestore y de Storage | T10 | **NO CONSTA** | Igual que el anterior. Ningun `it()` lee `firestore.rules` ni `storage.rules` (`grep` sobre `src/lib/*.test.ts` da cero). El canal esta **declarado, no ejercido**. |

**Consecuencia:** las dos capas que RNF_02 nombra explicitamente —"las restricciones de acceso MUST
decidirse en el servidor"— cambiaron en esta spec y **no han sido ejercidas ni por prueba
automatizada ni por su canal declarado**. Lo unico verificado ahi es el predicado de
`community-access.ts`, que no es lo que Firestore evalua.

---

## 4. Veredicto sobre el Definition of Done

| # | Punto del DoD | Veredicto |
|---|---|---|
| 1 | Cada RF y RNF tiene al menos una prueba automatizada que pasa | **NO CUMPLIDO** — RF_08 y RF_09 no tienen ninguna, y no estan cubiertos por ninguno de los tres canales declarados |
| 2 | Verificacion de tipos y linters sin errores | **CUMPLIDO** — `tsc` limpio en raiz y en `functions/`; ESLint 0 errores (3 avisos preexistentes y documentados) |
| 3 | Demostrado que una cuenta con un solo papel no cambia de comportamiento (RNF_01) | **CUMPLIDO** — dos tablas exhaustivas sobre los SEIS papeles, permiso por permiso, con `TODOS_LOS_ROLES` forzando a `tsc` a cubrir la union |
| 4 | Demostrado que el selector no concede nada (RNF_02) | **NO CUMPLIDO del todo** — demostrado que el sombrero no entra en los predicados (aridad e inmutabilidad) ni en `state-store.ts`, y que un lider puro no ve el dinero de ninguna tienda; **no demostrado** en la capa donde RNF_02 se decide de verdad: `firestore.rules` y `storage.rules` se reescribieron y nadie las ha ejercido |
| 5 | Medido, **en documentos descargados**, que dos papeles no superan la suma (RF_16) y que cambiar de papel lee **cero** documentos (RNF_03) | **NO CUMPLIDO** — no hay ninguna medicion. Lo que hay son guardas de fuente sobre `state-store.ts` que argumentan estructuralmente por que deberia cumplirse. `docs/rendimiento.md` **no se toco** en toda la spec 003, pese a que RF_16 dice literalmente "medido con el procedimiento de la documentacion de rendimiento vigente" |
| 6 | Demostrado que una comunidad sin lider cobra tarifa base y no causa cashback (RF_20) | **CUMPLIDO** — 8 `it()` sobre `resolveCommunityPricing`, incluido el orden (el lider se comprueba ANTES del piso), la comunidad desactivada, y `leaderUid` vacio o en blanco |
| 7 | El humano valido el resultado y aprobo la entrega | **NO CUMPLIDO** — no consta. `.sdd/state.json` sigue en `phase: "verify"` y no hay `.sdd/evidence/003/` |

**Un DoD parcial es un DoD incumplido: el Definition of Done de la spec 003 NO se cumple.**
Cumplidos 3 de 7 puntos (2, 3 y 6). Incumplidos 4 (1, 4, 5 y 7).

---

## 5. Requisitos huerfanos — hay que volver a `/sdd-run`

### 5.1 RF_08 y RF_09: la unica pareja sin prueba y sin canal

- **RF_08** (*mientras opere como tienda, ve exactamente lo que ve cualquier tienda y nada de la
  comunidad*) y **RF_09** (*mientras opere como lider, no se le muestra el detalle de un pedido, ni
  los datos del cliente, ni el saldo de NINGUNA tienda, incluida la suya*).
- Estan **implementados**: `src/components/operations-app.tsx:12783-12818` despacha por
  `activeHat` antes que por el papel, con el comentario que cita RF_09.
- **No los prueba nada.** Las apariciones de `RF_08` / `RF_09` en `src/lib/community-signup.test.ts`
  son de la **spec 001** (procedencia del enlace de registro), no de esta.
- Su tarea, **T13**, esta en `state.json` con `"testWritten": false, "done": true`, y **no declaro
  canal alternativo**: es la unica tarea de la spec que cierra sin prueba y sin canal.
- T13 prometia ademas una **guarda de fuente** que atara la pantalla al nucleo de T11 ("que la
  pantalla usa el nucleo de T11 y no una copia"). **Esa guarda no existe**: ningun `it()` lee
  `operations-app.tsx` buscando `session-hats` (`grep` sobre `src/lib/*.test.ts` solo encuentra la
  guarda de `roleLabel`, que es de la spec 001). Hoy alguien puede reescribir
  `operations-app.tsx:12777-12781` con su propia copia de la condicion y la suite sigue verde.

### 5.2 Lo que falta para el DoD 5, que es una tarea aparte

La medicion en documentos de RF_16 y RNF_03 no esta. El precedente existe y es de esta misma casa:
la T42 de la spec 001 midio RNF_01 con 100 y con 10.000 pedidos y lo dejo escrito en
`docs/rendimiento.md`. Aqui no se hizo el equivalente para la cuenta con dos papeles.

### 5.3 Lo que falta para el DoD 4, que es ejecutar un canal ya declarado

El canal de T10 esta escrito y no se ha corrido. Mientras no se corra, el cambio de
`firestore.rules` y `storage.rules` esta sin ejercer. **Observacion que conviene mirar en esa
pasada** (no es un hallazgo confirmado, es lo que mas riesgo tiene de la reescritura):
`sellerInMyCommunity` quedo como
`isCommunityLeader(get(/…/sellers/$(sellerId)).data.communityId) && exists(/…/sellers/$(sellerId))`,
es decir, **el `get()` se evalua antes que el `exists()`**, al reves que la version anterior. Con un
`sellerId` inexistente el resultado sigue siendo denegar, pero por error de evaluacion y no por
predicado falso — y eso conviene verlo con una sesion real antes de desplegar, porque `grep` no lo
va a decir.

---

## 6. Siguiente paso

**No se pasa a `/sdd-verify`.** Faltan requisitos por cubrir. Vuelta a `/sdd-run` con, como minimo,
tres tareas nuevas:

1. **T16 — RF_08 y RF_09 con prueba.** El reparto de vistas por sombrero, extraido a una funcion
   pura (`viewForHat` o equivalente) o, si eso no cabe, la guarda de fuente que T13 prometio y no
   entrego. Incluye el aserto del lado del servidor de que **el sombrero no concede**.
2. **T17 — la medicion del DoD 5.** RF_16 y RNF_03 en documentos descargados, con el procedimiento
   de `docs/rendimiento.md`, y el resultado anotado en ese mismo documento.
3. **T18 — correr los dos canales declarados y dejar constancia.** Callables (T6/T9) y reglas (T10)
   con usuario desechable, con la evidencia en `.sdd/evidence/003/`. Sin esto, el DoD 4 no se puede
   dar por cumplido por mucho que los predicados esten verdes.

Y tres huecos menores de casos limite que conviene decidir si se cubren o se declaran fuera:
la tienda del lider que entra a mitad de periodo, la desactivacion de la cuenta con los dos papeles,
y que desactivar la comunidad tambien retira el papel (hoy solo cambia el precio).
