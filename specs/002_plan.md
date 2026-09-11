# Plan tecnico 002: Entorno de verificacion aislado

- **Spec:** `specs/002_entorno_de_verificacion.md` (aprobada, 26 requisitos)
- **Fecha:** 2026-09-11

## 0. Desviacion del stack por defecto, y por que

El stack por defecto del usuario menciona Prisma y PostgreSQL; este repositorio usa Firebase, y el
arnes tiene que verificar **este** sistema. Todo lo de abajo se apoya en lo que el repo ya usa:
`firebase-tools` 15.8.0 (instalado), Java 21 (instalado, requisito del emulador de Firestore),
Vitest y el propio `functions/src`. **Ninguna dependencia nueva en el programa que se entrega**
(RNF_02); las del arnes viven en `devDependencies` o en ninguna parte.

## 1. Hallazgos que condicionan el plan

Estos tres salieron de la investigacion previa y **cambian decisiones**, no son adorno.

### H1. El prefijo `demo-` NO garantiza el aislamiento por si solo

La hipotesis de partida era que un identificador `demo-*` hace imposible alcanzar produccion. **Es
falso a medias:**

- Con la suite de emuladores corriendo y las variables de entorno puestas, si aisla.
- **El Admin SDK con `projectId: "demo-x"` pero SIN `FIRESTORE_EMULATOR_HOST` puede intentar salir
  a produccion** si encuentra credenciales validas en el entorno — y en esta maquina las hay (ADC).
  Ese es exactamente el modo de fallo que RF_02 llama "silencioso y destructivo".

**Consecuencia:** RF_01 y RF_03 **no se apoyan en el prefijo**. Se apoyan en una comprobacion
explicita de tres condiciones simultaneas (ver 4.1). El prefijo se usa igualmente, como segunda
barrera, no como primera.

### H2. Emuladores + proyecto `demo-` + web frameworks tienen un fallo conocido

`firebase-tools` #6377: con un proyecto `demo-`, el arranque de la aplicacion por el integrador de
frameworks falla buscando "sites" del proyecto en la nube.

**Consecuencia:** los tres recorridos se ejecutan contra **la superficie de servidor** (las
callables servidas por el emulador de funciones), no conduciendo el navegador por la aplicacion. Es
donde vive todo lo que la spec 001 dejo sin verificar. RF_20 de la spec 002 es una forma "Donde":
si ningun recorrido necesita el navegador, queda satisfecho sin construir nada. **Conducir la
interfaz contra emuladores queda fuera de este plan y se dice por escrito**, no se da por hecho.

### H4. El emulador de funciones **no** compila desde la fuente

La primera version de este plan afirmaba que el emulador "sirve `functions/src` directamente: misma
procedencia". **Es falso.** El delegado de Node de `firebase-tools` 15.8.0 tiene el paso de
compilacion vacio, y el emulador carga lo que diga `main` del `package.json`, que es `lib/index.js`
— un directorio **ignorado por el control de versiones y que puede estar rancio**.

**Consecuencia:** RF_06 se quedaba sin mecanismo. Se arregla con dos piezas: el corredor **compila
antes de arrancar**, y `assertBuildIsFresh` comprueba que lo compilado no es mas viejo que la
fuente, **abortando si lo es**. Un recorrido verde contra codigo rancio es peor que no tenerlo.

### H3. `NEXT_PUBLIC_*` se incrusta al compilar, no al arrancar

Una vez compilado el paquete, ninguna variable del servidor puede cambiarlo. El riesgo real no es
de ejecucion sino de **compilacion**: quien compile con la variable apuntando al entorno aislado
deja ese valor incrustado para siempre.

**Consecuencia:** la proteccion de RF_21/RF_22 va **en el cliente y en tiempo de ejecucion**, como
red de seguridad de un build mal hecho: si la version es de produccion y el identificador de
proyecto no es el real, **se ignora la variable y se usan los valores reales**, dejando constancia.
**Nunca se lanza un error**: RF_22 lo prohibe expresamente, y la constitucion registra dos veces la
pantalla en blanco como el peor desenlace de esta plataforma.

## 2. Arbol de modulos

### Nucleo puro — donde vive la decision, probable sin red

| Archivo | Responsabilidad |
|---|---|
| `src/lib/verification/isolation.ts` **(nuevo)** | `assertIsolation(env)`: dadas las variables de entorno, decide si se puede ejecutar y, si no, **por que no**. Puro. Es el guardian de RF_01, RF_02 y RF_03. |
| `src/lib/verification/seed.ts` **(nuevo)** | Constructores puros del estado de partida: la comunidad, su enlace, las cinco tiendas que exige RF_16, las tarifas base. Sin reloj: el instante entra por parametro (RF_09). |
| `src/lib/verification/outcome.ts` **(nuevo)** | Clasifica cada paso en **fallo del arnes** o **fallo del producto** y arma el informe (RNF_04). Puro. |
| `src/lib/verification/money-chain.ts` **(nuevo)** | Las tres relaciones de RF_17 como funciones puras que el recorrido usa para afirmar. **No reimplementan la aritmetica**, la importan — y **cada relacion vive en un sitio distinto**, comprobado contra el codigo: el causado en `functions/src/wallet-entries.ts`; la fila de liquidacion en **`src/lib/community-view.ts`** (`buildCommunityLeaderLiquidationRows`); lo pagado tambien en **`src/lib/community-view.ts`** (`communityCashbackPaidCop`). La primera version de este plan las situaba las tres en `functions/src`, y seguirlo al pie de la letra habria hecho reimplementar dos, rompiendo la constitucion 9. |

### Capa impura — habla con los emuladores

| Archivo | Responsabilidad |
|---|---|
| `scripts/verify/run.mjs` **(nuevo)** | El corredor. Comprueba aislamiento, toma el cerrojo, limpia, siembra, ejecuta los tres recorridos, escribe la evidencia. Una sola orden (RNF_01). |
| `scripts/verify/lock.mjs` **(nuevo)** | Cerrojo con el identificador del proceso; un cerrojo cuyo proceso ya no vive se considera caducado y se recupera (RF_11). |
| `scripts/verify/emulator.mjs` **(nuevo)** | Envoltura de lo que hace falta del emulador: comprobacion de vida, borrado de datos, invocacion de callables. |

### Configuracion y producto

| Archivo | Responsabilidad |
|---|---|
| `firebase.json` *(modificar)* | Bloque `emulators`. **No se toca nada mas de este archivo**: la cache de hosting esta como esta por un incidente (constitucion 12). |
| `src/lib/verification/provenance.ts` **(nuevo)** | `assertBuildIsFresh(srcMtime, libMtime)`: decide si lo compilado es mas viejo que la fuente. Es el mecanismo de RF_06 (ver H4 abajo). Puro. |
| `src/lib/firebase/client.ts` *(modificar)* | La red de seguridad de RF_21/RF_22. Unico cambio en el programa que se entrega. |
| `docs/verificacion.md` **(nuevo)** | Como se levanta en una maquina limpia (RNF_03). |
| `.gitignore` *(modificar)* | El cerrojo y los datos exportados del emulador no se versionan. |

## 3. Modelo de datos

### 3.1 Entorno de ejecucion

```ts
export type IsolationEnv = {
  projectId?: string;                    // GCLOUD_PROJECT / FIREBASE_PROJECT
  firestoreHost?: string;                // FIRESTORE_EMULATOR_HOST
  authHost?: string;                     // FIREBASE_AUTH_EMULATOR_HOST
  storageHost?: string;                  // FIREBASE_STORAGE_EMULATOR_HOST
  functionsHost?: string;                // FUNCTIONS_EMULATOR_HOST (o el puerto conocido)
  allowRealData?: string;                // cualquier intento de forzar produccion
};

export type IsolationVerdict =
  | { ok: true; projectId: string }
  | { ok: false; reason: string; missing: string[] };
```

### 3.2 Estado de partida (RF_07, RF_16)

```ts
export type SeedCommunity = {
  id: "com-verificacion";
  name: string;
  slug: "verificacion";
  leaderEmail: string;
  status: "active";
  linkStatus: "active";
};

/** Las cinco de RF_16, cada una con el papel que le toca demostrar. */
export type SeedSellerRole =
  | "inRange"        // la contencion la alcanza
  | "outOfRange"     // sigue abierta
  | "otherLink"      // sigue abierta
  | "rangeBoundary"  // la alcanza: el rango es inclusivo
  | "noContactEmail"; // la alcanza en el documento, y se reporta NO cerrada

export type SeedSeller = {
  id: string;
  role: SeedSellerRole;
  communityId?: string;
  communityJoinedAt?: string;
  contactEmail?: string;
  onboardingComplete: boolean;
};
```

### 3.3 Informe (RNF_04, RF_19)

```ts
export type StepOutcome = {
  step: string;
  requirement: string[];        // que requisitos de la spec 001 demuestra
  status: "pasa" | "falla";
  blame?: "product" | "harness"; // solo cuando falla
  detail?: string;
};

export type VerificationReport = {
  projectId: string;
  startedAt: string;
  steps: StepOutcome[];
  notVerified: { step: string; reason: string }[];   // RF_13
};
```

## 4. Algoritmos criticos

### 4.1 El guardian del aislamiento (RF_01, RF_02, RF_03) — el algoritmo mas importante del plan

`assertIsolation(env)` devuelve `ok` **solo si se cumplen las tres a la vez**:

1. `projectId` empieza por `demo-`;
2. estan puestas **todas** las variables de emulador que el recorrido va a usar —Firestore, Auth,
   Storage **y funciones**— y ninguna apunta a un anfitrion que no sea local;
3. no hay ninguna variable de escape puesta (`allowRealData`), y **si la hay, se rechaza igual**:
   RF_03 dice que se rechaza "aunque quien la lance se lo pida explicitamente".

**El anfitrion de funciones entra en la condicion 2, y es la correccion mas importante de este
plan.** Los recorridos **invocan callables**. Si la direccion base apunta a `cloudfunctions.net`, la
callable se ejecuta **en produccion y con las credenciales del servidor**, y ningun
`FIRESTORE_EMULATOR_HOST` del corredor protege nada: el dano ocurre al otro lado. Es exactamente el
modo "silencioso y destructivo" de RF_02, por la unica via que la primera version de este plan no
miraba. **Corolario que no se negocia:** la direccion de cada callable se **deriva** de ese
anfitrion, nunca se construye aparte.

Falta cualquiera → `{ ok: false }` con **la lista de lo que falta**, y el corredor **termina sin
tocar nada**. No hay camino que continue.

**Por que las tres y no solo el prefijo:** por H1. Con `demo-` pero sin `FIRESTORE_EMULATOR_HOST`,
el Admin SDK encuentra las credenciales de aplicacion de esta maquina e intenta salir a produccion.
La condicion 2 es la que de verdad ata; la 1 es el cinturon sobre los tirantes.

Ademas, el corredor comprueba **en ejecucion** que los emuladores responden antes de escribir nada
(segunda mitad de RF_02): un anfitrion configurado pero muerto no es aislamiento, es una escritura
que fallara a medias. Esa comprobacion se parte en dos: `assertLiveHosts(responses)` **puro** —dado
lo que contesto cada anfitrion, decide si se puede seguir— y la llamada por red, que vive en el
corredor. Asi se prueba sin red.

Y el corredor **anuncia el entorno antes de cada paso** (RF_04): identificador de proyecto y
anfitriones, en cada linea del informe.

**Lo que ata el corredor al guardian** (punto 4 del Definition of Done): una prueba comprueba que
`run.mjs` **no tiene ninguna ruta de ejecucion que escriba sin haber pasado por `assertIsolation`**.
La tabla negativa demuestra que el guardian rechaza; esto demuestra que alguien le pregunta. Sin lo
segundo, lo primero es un adorno.

### 4.2 Limpieza al arrancar, no al terminar (RF_08, RF_10)

El orden de cada ejecucion es: **cerrojo → aislamiento → limpieza → siembra → recorridos →
evidencia → soltar cerrojo**. La limpieza va la tercera y **no hay limpieza final**.

Asi, lo que deja una ejecucion fallida sobrevive para poder mirarlo, y aun asi la siguiente parte de
un estado conocido. Es lo que resuelve la contradiccion que el revisor adversarial encontro entre
las dos reglas.

El borrado usa el punto de borrado masivo del propio emulador, no un recorrido documento a
documento: mas rapido y sin dejar restos de subcolecciones.

### 4.3 El cerrojo (RF_11)

Archivo con el identificador del proceso y el instante. Al tomarlo:
- si no existe, se crea;
- si existe y **el proceso sigue vivo**, se rechaza con aviso;
- si existe y **el proceso ya no vive**, se considera caducado, se avisa y se toma.

Esa tercera rama es la que impide el bloqueo permanente que senalo la revision.

### 4.4 El gobierno del instante (RF_12, RF_13) — y lo que se declara no verificado

Los nucleos puros de este repo reciben `nowIso` por parametro; **las callables hacen `new Date()`
dentro**. De modo que el arnes **no puede** mover el reloj del servidor.

Lo que si puede, y es legitimo: **sembrar documentos con las fechas que hagan falta** para situarse
al otro lado de un plazo. Con eso se verifica *que la regla se aplica cuando la fecha llega*.

Lo que **no** se verifica, y se declara asi en el informe (RF_13):

| Tramo | Por que no |
|---|---|
| Que una subida programada hoy entre exactamente a los ocho dias | El plazo lo fija la callable con su propio reloj. Lo cubre la prueba unitaria de `scheduleEffectiveAt`. |
| Que un nombre corto retirado caduque a los treinta dias | Igual. Cubierto en unidad. |
| Que el aviso de captacion masiva salte con la hora deslizante real | El instante lo pone el servidor al registrar cada alta. |

Sembrar una fecha pasada y decir que se ha verificado el plazo seria exactamente lo que RF_13
prohibe: un recorrido que salta el paso que pretende demostrar y se reporta en verde.

### 4.4bis El orden de los recorridos, y por que cambia

RF_15 exige comprobar que tras la contencion **"ningun pedido ni movimiento de dinero desaparece"**.
Con la semilla minima —comunidad, enlace, tarifas y cinco tiendas— **no hay pedidos ni asientos**,
asi que no habria nada que pudiera desaparecer y la comprobacion seria vacua.

**Se invierte el orden**: primero el recorrido del dinero, que deja pedidos y asientos; despues la
contencion, que ahora si puede demostrar que no se lleva nada por delante. El alta por enlace sigue
primera, porque es la que crea las tiendas que usan las otras dos.

Orden definitivo: **alta por enlace → dinero → contencion.**

### 4.5 Las tres relaciones del dinero (RF_17)

No es "la misma cifra en cada eslabon" —eso era falso y lo detecto la revision—, son tres:

1. **Causado** = precio congelado de la comunidad **menos** la base, por concepto. Cero es
   resultado valido (la spec 001 lo produce cuando no hay precio propio o cuando el piso de zona
   supera al del lider) y **no se trata como fallo**.
2. **Fila de liquidacion** = suma de lo causado y **aun sin cortar** de esa comunidad.
3. **Pagado** = suma de los cortes **ya marcados** como pagados o conciliados. Vale cero mientras
   no se marque ninguno, y ese cero tambien es correcto.

Las tres se afirman importando las funciones de produccion, no reimplementandolas.

### 4.6 Atribucion de culpa (RNF_04)

Cada paso se ejecuta en una de dos zonas:

- **Zona de arnes**: cerrojo, aislamiento, limpieza, siembra, arranque. Un fallo aqui es del arnes.
- **Zona de producto**: la invocacion de una callable y la comprobacion de su efecto. Un fallo aqui
  es del producto.

Una excepcion inesperada en zona de producto se marca `producto`; una en zona de arnes, `arnes`. El
informe nunca deja un fallo sin atribuir, porque un fallo del arnes reportado como del producto
manda a corregir lo que no esta roto.

### 4.7 La red de seguridad del cliente (RF_21, RF_22)

En `src/lib/firebase/client.ts`, al construir la configuracion:

> Si la version es de produccion **y** el identificador de proyecto configurado **no** es el real,
> se ignora lo configurado y se usan los valores reales, **dejando constancia por consola**.

Nunca se lanza. Nunca se deja de servir. Es una red para un paquete compilado con variables
equivocadas (H3), no una validacion de seguridad —quien controla el compilador controla el
resultado, y eso queda fuera de lo que esta capa puede prometer—.

## 5. Estrategia de testing

**Los cuatro modulos del nucleo se prueban en Vitest**, como manda la constitucion: pruebas en
`src/lib/verification/<modulo>.test.ts`, fixtures literales, sin red.

| Archivo de prueba | Requisitos de la spec 002 |
|---|---|
| `src/lib/verification/isolation.test.ts` | RF_01, RF_02, RF_03, RF_04 |
| `src/lib/verification/seed.test.ts` | RF_07, RF_09, RF_16 |
| `src/lib/verification/outcome.test.ts` | RF_13, RF_19, RNF_04 |
| `src/lib/verification/money-chain.test.ts` | RF_17, RF_18 |
| `src/lib/firebase/client.test.ts` **(nuevo)** | RF_21, RF_22 |

**El requisito que mas cuidado pide es RF_01**, porque describe una imposibilidad. Su prueba no
puede ser "no escribio en produccion" (no se puede observar sin conectarse). Se prueba en negativo:
**una tabla de entornos incompletos, y `assertIsolation` los rechaza todos**, con el motivo. Si
manana alguien relaja el guardian, esa tabla se pone roja.

**Lo que Vitest no cubre** —que los emuladores arrancan, que el borrado borra, que las callables
responden— se verifica ejecutando el propio arnes, que es su razon de ser. El DoD lo pide asi.

## 6. Dependencias nuevas

**Ninguna en el programa que se entrega** (RNF_02). El arnes usa:
- `firebase-tools` 15.8.0 — ya instalado globalmente, provee los emuladores.
- Java 21 — ya instalado, lo exige el emulador de Firestore.
- `firebase-admin` — ya esta en `functions/node_modules`, que es de donde el repo ya lo usa para sus
  guiones de verificacion contra datos vivos.
- `node:test` no hace falta: Vitest ya esta.

## 7. Orden de trabajo

1. El guardian del aislamiento **primero y solo**. Hasta que rechace todo lo que debe rechazar, no
   se escribe nada que hable con un emulador. Es el unico orden que impide un accidente mientras se
   construye el arnes.
2. `firebase.json` y el arranque de los emuladores.
3. Limpieza, cerrojo y siembra.
4. Los tres recorridos, en el orden de riesgo de la spec 001: alta por enlace, contencion, dinero.
5. La red de seguridad del cliente.
6. La documentacion de puesta en marcha.

## 8. Riesgos

| Riesgo | Mitigacion |
|---|---|
| El guardian tiene un hueco y una ejecucion escribe en produccion | Las tres condiciones de 4.1, la comprobacion de vida antes de escribir, y la tabla de entornos incompletos en prueba. Es el riesgo numero uno de esta spec. |
| El emulador de funciones ejecuta codigo distinto del desplegado | Sirve `functions/src` directamente: misma procedencia (RF_06). Si alguien compilara a un artefacto aparte, se rompe la equivalencia. |
| Sembrar fechas se confunde con verificar plazos | 4.4 enumera los tramos no verificados y el informe los repite (RF_13). |
| El arnes se pudre porque nadie lo corre | RNF_01: una sola orden y menos de diez minutos. Si deja de cumplirse, deja de usarse. |
| `firebase.json` se toca mas de lo necesario | Solo se anade el bloque `emulators`. La cache de hosting esta como esta por un incidente que dejo la app en blanco en moviles. |
