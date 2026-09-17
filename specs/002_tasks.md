# Tareas 002: Entorno de verificacion aislado

- **Spec:** `specs/002_entorno_de_verificacion.md` · **Plan:** `specs/002_plan.md`
- 16 tareas. Numeracion propia: **no se mezclan con las 47 de la spec 001**, implementada y
  desplegada.
- **Cada `it()` empieza por el identificador del requisito** (`it("RF_01: ...")`).
- **Cada tarea que escribe codigo lleva su prueba en el alcance.** El hook deniega escrituras
  no-test mientras no haya prueba, y deniega cualquier archivo fuera del alcance declarado —
  incluido el propio test. Una tarea sin su test declarado es un punto muerto mecanico.

## Orden, y por que no es negociable

La seccion 7 del plan lo fija: **el guardian va primero y solo**. Hasta que rechace todo lo que debe
rechazar, no se escribe una linea que hable con un emulador. Es el unico orden que impide un
accidente **mientras se construye el arnes**, que es justo cuando el arnes todavia no protege.

---

## 1. El guardian — antes que nada

- [ ] **T1: El guardian del aislamiento**
  * Requisitos: RF_01, RF_02 (primera mitad), RF_03
  * Archivos: `src/lib/verification/isolation.ts`, `src/lib/verification/isolation.test.ts`
  * Accion: `assertIsolation(env)` puro. `ok` **solo** si: el identificador empieza por `demo-`; estan puestas **las cuatro** variables de emulador —Firestore, Auth, Storage **y funciones**— y ninguna apunta fuera de la maquina; y no hay variable de escape (**y si la hay, se rechaza igual**, RF_03). Al fallar, devuelve **la lista de lo que falta**.
  * Verificacion: **tabla de entornos incompletos, rechazados todos, con motivo.** No se puede probar "no escribio en produccion" sin conectarse; se prueba en negativo, y si alguien relaja el guardian la tabla se pone roja.
  * **El anfitrion de funciones es la correccion critica del analisis:** los recorridos invocan callables, y si su direccion apunta a `cloudfunctions.net` se ejecutan **en produccion con credenciales de servidor**. Ningun `FIRESTORE_EMULATOR_HOST` protege de eso: el dano ocurre al otro lado.

## 2. Lo que el guardian no puede ver sin red

- [ ] **T2: Anfitriones vivos y procedencia del codigo**
  * Requisitos: RF_02 (segunda mitad), RF_06
  * Archivos: `src/lib/verification/hosts.ts`, `src/lib/verification/hosts.test.ts`, `src/lib/verification/provenance.ts`, `src/lib/verification/provenance.test.ts`
  * Accion: `assertLiveHosts(responses)` —dado lo que contesto cada anfitrion, decide si se sigue— y `assertBuildIsFresh(srcMtime, libMtime)`. Las dos puras; la llamada por red vive en el corredor.
  * Verificacion: un anfitrion **configurado pero muerto** no es aislamiento, es una escritura que fallara a medias. Y lo compilado **mas viejo que la fuente** aborta: el emulador carga `lib/`, que esta fuera del control de versiones y puede estar rancio — un recorrido verde contra codigo viejo es peor que no tenerlo.

- [ ] **T3: Los emuladores**
  * Requisitos: RF_05
  * Archivos: `firebase.json`, `src/lib/verification/emulator-config.test.ts`
  * Accion: bloque `emulators` (auth, functions, firestore, storage, interfaz) con puertos fijos. Firestore carga `firestore.rules` y Storage `storage.rules`: **las mismas reglas de acceso que el real**.
  * Verificacion: la prueba lee `firebase.json` y fija los puertos y los archivos de reglas, que son los que el guardian de T1 espera. Si alguien mueve un puerto sin tocar el guardian, salta.
  * **No se toca nada mas de `firebase.json`.** La cache de hosting esta como esta por un incidente que dejo la app en blanco en moviles (constitucion 12).

- [ ] **T4: El cerrojo**
  * Requisitos: RF_11
  * Archivos: `src/lib/verification/lock-core.ts`, `src/lib/verification/lock-core.test.ts`, `scripts/verify/lock.mjs`, `.gitignore`
  * Accion: `decideLock(existing, isAlive)` puro → tomar / rechazar / recuperar. El `.mjs` solo lee, escribe y pregunta al sistema si el proceso vive.
  * Verificacion: la tercera rama es la que importa — una ejecucion que murio sin soltar el cerrojo **no** deja el arnes bloqueado para siempre.

- [ ] **T5: Limpieza al arrancar, nunca al terminar**
  * Requisitos: RF_08, RF_10
  * Archivos: `src/lib/verification/run-order.ts`, `src/lib/verification/run-order.test.ts`, `scripts/verify/emulator.mjs`
  * Accion: el orden de una corrida como **dato** —cerrojo, aislamiento, limpieza, siembra, recorridos, evidencia— y el borrado masivo por el punto propio del emulador.
  * Verificacion: la limpieza aparece **antes** de la siembra y **no hay ninguna al final**. Lo que deja una corrida fallida sobrevive para poder mirarlo, y aun asi la siguiente parte de un estado conocido.

## 3. Estado de partida

- [ ] **T6: La semilla**
  * Requisitos: RF_07, RF_09, RF_12, RF_16
  * Archivos: `src/lib/verification/seed.ts`, `src/lib/verification/seed.test.ts`
  * Accion: constructores puros de la comunidad, su enlace, las tarifas, **las cinco tiendas de RF_16** (dentro, fuera, otro enlace, frontera, sin correo) **y los pedidos y asientos** que el recorrido del dinero necesita. El instante entra por parametro (RF_12).
  * Verificacion: dos preparaciones seguidas dan un estado equivalente. **Sin pedidos ni asientos en la semilla, "ningun movimiento de dinero desaparece" (RF_15) seria una comprobacion vacua** — lo detecto el analisis.

- [ ] **T7: El informe y la atribucion de culpa**
  * Requisitos: RF_13, RF_19, RNF_04
  * Archivos: `src/lib/verification/outcome.ts`, `src/lib/verification/outcome.test.ts`
  * Accion: clasifica cada paso en **fallo del arnes** (cerrojo, aislamiento, limpieza, siembra, arranque) o **del producto** (invocar y comprobar). Arrastra la lista de tramos no verificados de RF_13.
  * Verificacion: ningun fallo queda sin atribuir. Un fallo del arnes reportado como del producto manda a corregir lo que no esta roto.

- [ ] **T8: Las tres relaciones del dinero**
  * Requisitos: RF_17, RF_18
  * Archivos: `src/lib/verification/money-chain.ts`, `src/lib/verification/money-chain.test.ts`
  * Accion: causado, fila y pagado. **Importando, nunca reimplementando** — y cada una vive en un sitio distinto: el causado en `functions/src/wallet-entries.ts`, **la fila y lo pagado en `src/lib/community-view.ts`**. El plan las situaba las tres en `functions/src` y seguirlo habria hecho reimplementar dos (constitucion 9).
  * Verificacion: causado cero es **valido**; pagado cero mientras no se marque ningun corte, tambien.

## 4. El producto

- [ ] **T9: La red de seguridad del cliente**
  * Requisitos: RF_21, RF_22
  * Archivos: `src/lib/firebase/client.ts`, `src/lib/firebase/client.test.ts`
  * Accion: si la version es de produccion **y** el identificador de proyecto no es el real, **se ignora lo configurado y se usan los valores reales**, con constancia por consola.
  * Verificacion: **nunca lanza y nunca deja de servir.** Es el **unico cambio en el programa que se entrega**, y es una red para un paquete compilado con variables equivocadas, no una promesa de seguridad.

## 5. El corredor

- [ ] **T10: Andamio del corredor**
  * Requisitos: RF_04
  * Archivos: `scripts/verify/run.mjs`, `src/lib/verification/runner-contract.test.ts`
  * Accion: el esqueleto en el orden de T5, anunciando **identificador de proyecto y anfitriones antes de cada paso** (RF_04).
  * Verificacion: la prueba comprueba que `run.mjs` **no tiene ninguna ruta que escriba sin haber pasado por `assertIsolation`**. La tabla de T1 demuestra que el guardian rechaza; esto demuestra que alguien le pregunta. **Sin lo segundo, lo primero es un adorno** — y es el punto 4 del Definition of Done.

- [ ] **T11: Invocar callables y escribir la semilla**
  * Requisitos: RF_07 (aplicacion)
  * Archivos: `scripts/verify/emulator.mjs`
  * Accion: crear usuarios en el emulador de identidad, fijar sus roles, emitir credenciales, e invocar callables con su sobre. **La direccion de cada callable se deriva del anfitrion del guardian**, nunca se construye aparte.
  * Verificacion: una callable responde desde el emulador y la semilla queda escrita.

## 6. Los tres recorridos — en este orden

El analisis obligo a invertirlo: la contencion va **ultima**, porque antes no hay dinero que pueda
desaparecer y RF_15 seria vacuo.

- [ ] **T12: Alta por enlace**
  * Requisitos: RF_14
  * Archivos: `scripts/verify/recorrido-alta.mjs`
  * Verificacion: la tienda queda con acceso, adscrita, y con constancia de por que enlace entro y cuando. Demuestra de la 001: **RF_07, RF_08, RF_09, RF_10, RF_43, RF_44, RF_45**.

- [ ] **T13: La cadena del dinero**
  * Requisitos: RF_17, RF_18
  * Archivos: `scripts/verify/recorrido-dinero.mjs`
  * Verificacion: pedido → causado → fila → corte → pagado, y **los dos caminos de correccion**. Demuestra de la 001: **RF_22, RF_23, RF_24, RF_25, RF_26, RF_29, RF_49**.

- [ ] **T14: La contencion**
  * Requisitos: RF_15
  * Archivos: `scripts/verify/recorrido-contencion.mjs`
  * Verificacion: las alcanzadas **efectivamente cerradas**, las de fuera abiertas, la **sin correo reportada NO cerrada**, y **ningun pedido ni asiento desaparece** —ahora si hay cuales—. Demuestra de la 001: **RF_41, RF_42, RF_53**.

## 7. Cierre

- [ ] **T15: Una sola orden**
  * Requisitos: RNF_01, RNF_02
  * Archivos: `package.json`, `scripts/verify/run.mjs`
  * Verificacion: menos de diez minutos, sin intervencion, y **sin anadir ninguna dependencia al programa que se entrega**.

- [ ] **T16: Puesta en marcha**
  * Requisitos: RNF_03
  * Archivos: `docs/verificacion.md`, `README.md`
  * Verificacion: alguien que no conoce el proyecto lo levanta siguiendo lo escrito, incluido que hace falta Java.

---

## Cobertura: requisito → tarea

| Req | Tarea | Req | Tarea |
|---|---|---|---|
| RF_01 | T1 | RF_13 | T7 |
| RF_02 | T1, T2 | RF_14 | T12 |
| RF_03 | T1 | RF_15 | T14 |
| RF_04 | T10 | RF_16 | T6 |
| RF_05 | T3 | RF_17 | T8, T13 |
| RF_06 | T2 | RF_18 | T8, T13 |
| RF_07 | T6, T11 | RF_19 | T7 |
| RF_08 | T5 | RF_20 | fuera de alcance, declarado en la spec §6 |
| RF_09 | T6 | RF_21 | T9 |
| RF_10 | T5 | RF_22 | T9 |
| RF_11 | T4 | RNF_01 | T15 |
| RF_12 | T6 | RNF_02 | T15 |
| | | RNF_03 | T16 |
| | | RNF_04 | T7 |

**25 de 26 con tarea; RF_20 excluido por escrito en la spec, con su precio acotado y declarado.**
