# Auditoria de trazabilidad — Spec 001: Lider de comunidad

Fecha: 2026-09-11 · Fase `verify`, paso 1 · Rama `feat/pedido-manual-multilinea` · 47/47 tareas cerradas

Esta auditoria **sustituye** a la del 10-09-2026. Aquella queda recogida al final, en
"Historico", para poder comparar sin abrir el git.

---

## 1. Recuento

- **59 requisitos** (54 RF + 5 RNF)
- **53 cubiertos**, **4 parciales**, **2 sin cobertura alguna**
- **328 de las 532 pruebas** llevan el identificador del requisito en el nombre

**Los 54 RF tienen al menos una prueba automatizada que pasa y que se rastrea al requisito por el
nombre.** Era el hueco del informe anterior: doce RF sin ninguna prueba. Ya no queda ninguno.

**Sin cobertura alguna:** RNF_03 y RNF_05. Ninguno de los dos es probable en unidad —uno es
"funciona en iOS 14 y en movil" y el otro "sigue el sistema de diseno"—; los dos caen enteros en la
evidencia funcional de `/sdd-verify`.

**Parciales:** RF_13, RF_17, RF_31 y RF_52. Detalle en §3.

---

## 2. Matriz de trazabilidad — requisitos funcionales

Una fila por requisito. "Prueba" es el nombre EXACTO de una prueba que pasa; cuando hay varias, se
cita la primera y se indica el total entre parentesis.

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RF_01 | `RF_01: distingue al lider de comunidad del lider logistico en la etiqueta visible` (2) | `src/lib/community-view.test.ts` | cubierto |
| RF_02 | `RF_02: normaliza a minusculas, sin acentos y con guiones` (3) | `src/lib/community-slug.test.ts` | cubierto |
| RF_03 | `RF_03: un slug retirado sigue valido 30 dias y deja de serlo despues` (5) | `src/lib/community-slug.test.ts` | cubierto |
| RF_04 | `RF_04: un nombre corto ya en uso por otra comunidad se rechaza y deja el anterior vigente` (12) | `src/lib/community-slug.test.ts` | cubierto |
| RF_05 | `RF_05: solo un administrador revoca o reactiva un enlace` (1) | `src/lib/community-access.test.ts` | cubierto |
| RF_06 | `RF_06: un enlace revocado o de un lider desactivado no admite altas` (1) | `src/lib/community-access.test.ts` | cubierto |
| RF_07 | `RF_07: la tienda nace sin ningun campo de aprobacion, revision o bloqueo` (7) | `src/lib/community-signup.test.ts` | cubierto |
| RF_08 | `RF_08: quedan los tres campos de procedencia: comunidad, instante y enlace` (7) | `src/lib/community-signup.test.ts` | cubierto |
| RF_09 | `RF_09: un enlace inexistente, revocado o de lider desactivado no admite alta` (2) | `src/lib/community-signup.test.ts` | cubierto |
| RF_10 | `RF_10: el correo duplicado se rechaza mandando a iniciar sesion` (11) | `src/lib/community-signup.test.ts` | cubierto |
| RF_11 | `RF_11: el plan no nombra asientos, cashback, cortes ni pedidos, en ninguna de sus formas` (19) | `src/lib/community-access.test.ts` | cubierto |
| RF_12 | `RF_12: una tienda creada a mano por un administrador nace sin comunidad` (1) | `src/lib/community-access.test.ts` | cubierto |
| RF_13 | `RF_13: se avisa al superar diez altas en una hora deslizante, sin bloquear` (2) | `src/lib/community-signup.test.ts` | **PARCIAL** |
| RF_14 | `RF_14: el lider de ESA comunidad ve el control, porque el logo que se muestra es el suyo` (15) | `src/lib/community-access.test.ts` | cubierto |
| RF_15 | `RF_15: sin logo se pinta la marca de la plataforma, nunca un hueco` (2) | `src/lib/community-view.test.ts` | cubierto |
| RF_16 | `RF_16, RF_15: un archivo ausente o vacio se rechaza sin borrar el logo que ya habia` (22) | `src/lib/community-view.test.ts` | cubierto |
| RF_17 | `RF_17, RF_18: con precio propio por encima, se cobra el del lider` (1) | `src/lib/community-pricing.test.ts` | **PARCIAL** |
| RF_18 | `RF_17, RF_18: con precio propio por encima, se cobra el del lider` (1) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_19 | `RF_19: el minimo que se le puede exigir a un lider es la base` (1) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_20 | `RF_20: sin precio propio se cobra la base y el cashback es cero` (1) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_21 | `RF_21: guarda final y base de los tres conceptos` (2) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_22 | `RF_22: un pedido entregado cobra el precio congelado, no la tarifa viva` (4) | `src/lib/community-cashback-entries.test.ts` | cubierto |
| RF_23 | `RF_23: un fallido no cobrable no causa cashback` (3) | `src/lib/community-cashback-entries.test.ts` | cubierto |
| RF_24 | `RF_24: si el corte del lider ya se pago, se compensa y no se toca el corte` (2) | `src/lib/community-corrections.test.ts` | cubierto |
| RF_25 | `RF_25: si el corte del lider sigue pendiente, se recalcula en vez de compensarse` (2) | `src/lib/community-corrections.test.ts` | cubierto |
| RF_26 | `RF_26: el cashback es un tipo liquidable, o quedaria como saldo abierto para siempre` (3) | `src/lib/settlement-math.test.ts` | cubierto |
| RF_27 | `RF_27: el lider no modifica el pago al lider logistico por pedido entregado` (11) | `src/lib/community-access.test.ts` | cubierto |
| RF_28 | `RF_28: la subida se anuncia DE INMEDIATO, con su fecha exacta, no al llegar el octavo dia` (5) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_29 | `RF_29, RF_30: agrega el total y el desglose por tienda` (2) | `src/lib/community-stats.test.ts` | cubierto |
| RF_30 | `RF_29, RF_30: agrega el total y el desglose por tienda` (1) | `src/lib/community-stats.test.ts` | cubierto |
| RF_31 | `RF_31: un lider NUNCA ve el saldo de una tienda, ni de la suya` (1) | `src/lib/community-access.test.ts` | **PARCIAL** |
| RF_32 | `RF_32: una comunidad sin ninguna tienda muestra las cifras en cero Y el enlace` (5) | `src/lib/community-view.test.ts` | cubierto |
| RF_33 | `RF_33: distingue cero real de sin datos` (1) | `src/lib/community-stats.test.ts` | cubierto |
| RF_34 | `RF_34: cada comunidad sale con su lider, sus tres precios vigentes y su cashback causado` (14) | `src/lib/community-view.test.ts` | cubierto |
| RF_35 | `RF_35: la base sube por encima del precio del lider y ese concepto se eleva al piso exacto` (11) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_36 | `RF_36: el cashback nunca es negativo, suba antes la base o el precio` (1) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_37 | `RF_37: sin comunidad no se congela nada` (1) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_38 | `RF_38: una bajada entra de inmediato` (2) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_39 | `RF_39: cada elevacion deja historial con quien, cuando, de cuanto a cuanto y desde cuando` (3) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_40 | `RF_40: el lider cancela una subida antes de la fecha y desaparece del anuncio sin mover el precio` (11) | `src/lib/community-pricing.test.ts` | cubierto |
| RF_41 | `RF_41: una tienda que entro dentro del rango entra en el plan` (45) | `src/lib/community-containment.test.ts` | cubierto |
| RF_42 | `RF_42: el plan no contiene ninguna orden de borrado, ni hoy ni cuando alguien lo amplie` (10) | `src/lib/community-containment.test.ts` | cubierto |
| RF_43 | `RF_43: acepta exactamente los cinco campos, normalizados` (3) | `src/lib/community-signup.test.ts` | cubierto |
| RF_44 | `RF_44: el mensaje nombra cual falta y dice donde completarlo` (16) | `src/lib/community-access.test.ts` | cubierto |
| RF_45 | `RF_45: si falla un paso posterior, hay que borrar el usuario creado` (1) | `src/lib/community-signup.test.ts` | cubierto |
| RF_46 | `RF_46: el rotulo de cada metrica sale del mismo eje que se consulta, en las cinco` (12) | `src/lib/community-stats.test.ts` | cubierto |
| RF_47 | `RF_47: activa es la tienda con al menos un pedido creado en el periodo` (1) | `src/lib/community-stats.test.ts` | cubierto |
| RF_48 | `RF_48: el porcentaje de entrega excluye los abiertos y viaja con su denominador` (2) | `src/lib/community-stats.test.ts` | cubierto |
| RF_49 | `RF_49: al marcar pagado el corte, su neto pasa a pagado` (25) | `src/lib/community-view.test.ts` | cubierto |
| RF_50 | `RF_50: solo un administrador crea lideres de comunidad` (2) | `src/lib/community-access.test.ts` | cubierto |
| RF_51 | `RF_51: el plan no nombra el cashback pendiente, ni asientos, ni cortes, ni saldos` (11) | `src/lib/community-access.test.ts` | cubierto |
| RF_52 | `RF_52: un lider ve la operacion de sus tiendas y de ninguna ajena` (2) | `src/lib/community-access.test.ts` | **PARCIAL** |
| RF_53 | `RF_53: descartar el aviso no desactiva a nadie, ni cuando alguien amplie la operacion` (5) | `src/lib/community-containment.test.ts` | cubierto |
| RF_54 | `RF_54: solo hay una programada por concepto y la segunda reinicia el plazo` (2) | `src/lib/community-pricing.test.ts` | cubierto |

### Requisitos no funcionales

| Requisito | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| RNF_01 | `RNF_01: la cuenta de documentos de wallet es la MISMA con 100 y con 10.000 pedidos` (11) | `src/lib/community-cashback-entries.test.ts` | **PARCIAL** (ver §4) |
| RNF_02 | `RNF_02: un pedido SIN comunidad produce exactamente los mismos asientos que antes` (1) | `src/lib/community-cashback-entries.test.ts` | cubierto |
| RNF_03 | — | — | **SIN COBERTURA** |
| RNF_04 | `RNF_04: la tarifa vigente se consulta en cualquier instante y siempre es la que se cobra` (3) | `src/lib/community-pricing.test.ts` | cubierto |
| RNF_05 | — | — | **SIN COBERTURA** |

---

## 3. Los cuatro parciales, uno a uno

**RF_13 — el aviso de captacion masiva.** Se prueba el umbral (`shouldRaiseMassSignupAlert`: diez
altas en una hora deslizante, y las viejas no cuentan). No se prueban las otras dos mitades del
MUST: que el aviso salga **en el panel del administrador**, y que **esas altas queden marcadas**
como captacion masiva pendiente de revision. Y hay un desajuste real, no solo de cobertura:
`functions/src/community-signup.ts:150` marca la **comunidad** (`massSignupAlertAt`), no las altas.
Al levantarse el aviso no queda forma de saber cuales fueron las once altas que lo dispararon.
Quien luego quiera revisarlas tiene que deducirlas del rango de fechas a mano. El panel existe
(`src/components/operations-app.tsx:4399`) y descarta el aviso (RF_53, probado), asi que el hueco
es la marca por alta.

**RF_17 — la base la define el administrador.** Se prueba que la base es el piso de todo precio de
comunidad (`RF_19`) y que manda cuando supera al del lider (`RF_35`). No hay ninguna prueba de que
**el administrador** sea quien la fija, ni del veto correspondiente a los demas roles. Es el unico
predicado de permiso de toda la spec que no tiene su prueba, teniendo diez hermanos que si.

**RF_31 y RF_52 — el aislamiento.** Los predicados estan probados (`canReadSellerFinancials`,
`canReadCommunityStats`, `canReadSellerOperational`). Lo que no tiene prueba es donde el aislamiento
se aplica de verdad: `firestore.rules`. **No existe en este repo ninguna prueba de reglas**
(`@firebase/rules-unit-testing` no esta instalado). Concretamente, RF_31 dice tres cosas —ni
detalle de pedido, ni datos del cliente final, ni saldo/deuda/recaudo— y solo la tercera tiene
prueba. Las dos primeras se sostienen hoy sobre dos patas: las reglas (sin prueba) y el hecho de
que el navegador del lider no abra ningun target de pedidos, que si esta fijado por
`RNF_01: la suscripcion del lider sigue sin abrir pedidos y conserva sus cortes`.

### Nota sobre el nivel al que prueba esta suite

Vale para toda la matriz, no solo para los cuatro parciales: **esta suite prueba funciones puras —
predicados de permiso, planificadores de escritura y aritmetica— no callables ni reglas.** Es
coherente con el diseno del backend (planificador puro + aplicador, como ya hacia
`order-corrections-plan.ts`), y varias pruebas van mas alla de lo obvio comprobando que un plan
**no** contiene ordenes de borrado ni nombra colecciones ajenas, que es exactamente el fallo que
importa. Pero conviene decirlo sin adornos: una prueba verde aqui garantiza que el plan es
correcto, no que la callable lo ejecute, ni que las reglas lo respalden. Ese salto lo tiene que dar
la evidencia funcional de `/sdd-verify`.

---

## 4. RNF_01: la mitad medible se cumple, la otra sigue sin medir

El informe anterior lo dio por **medido e incumplido**. T42 lo resolvio por la via que no se habia
visto: la suscripcion de wallet del lider **no se acoto, se elimino** —`CommunityLeaderView` no
lee `state.wallet` en ningun punto—, asi que la cuenta de documentos ya no depende del volumen.

| Pedidos en el periodo | Asientos que baja el lider | Antes de T42 |
|---|---|---|
| 100 | 0 | 100 (27,3 KB) |
| 10.000 | 0 | 10.000 (2,67 MB) |

Fijado por once pruebas en tres bloques `T42 · RNF_01`, con control negativo (tienda y domiciliario
si crecen: 18.000 y 10.000 asientos con 10.000 pedidos) para que un espejo roto que devuelva cero
para todos no pase en vacio. Registrado en `docs/rendimiento.md:142`.

**Lo que falta:** RNF_01 pide dos cosas, y la segunda —"el tiempo hasta ver cifras MUST mantenerse
dentro del presupuesto de carga por rol vigente, medido en el mismo perfil de red que usan las
mediciones ya registradas"— **no se ha medido**. La documentacion lo dice de frente y explica por
que (meter 10.000 pedidos sinteticos en `orders` contaminaria `getPlatformPosition`, `getOrderStats`
y los cortes de la plataforma viva). La cuenta de documentos es la mitad sustantiva y esta
respondida; el tiempo queda pendiente de una comunidad real en produccion.

---

## 5. Casos limite de la spec (§5)

| Caso limite | Prueba que lo valida | Archivo | Estado |
|---|---|---|---|
| Enlace reenviado a quien no debia | `RF_41: una tienda que entro dentro del rango entra en el plan` | `community-containment.test.ts` | cubierto |
| Aviso de captacion masiva con altas legitimas | `RF_53: descartar el aviso no desactiva a nadie, ni cuando alguien amplie la operacion` | `community-containment.test.ts` | cubierto |
| Segundo registro con el mismo correo | `RF_10: el mensaje no nombra ninguna comunidad, ni al lider, ni el enlace` | `community-signup.test.ts` | cubierto |
| Registro a medias | `RF_45: si falla un paso posterior, hay que borrar el usuario creado` | `community-signup.test.ts` | cubierto |
| Tienda que nunca completa sus datos operativos | `RF_44: a la tienda recien captada por un enlace le faltan recogida y cuenta` | `community-access.test.ts` | cubierto |
| El lider sube el precio a mitad de semana | `RF_22: un pedido entregado cobra el precio congelado, no la tarifa viva` | `community-cashback-entries.test.ts` | cubierto |
| Pedido creado antes de que su tienda entrara a la comunidad | `RF_37: sin comunidad no se congela nada` | `community-pricing.test.ts` | cubierto |
| Subida de base con pedidos ya creados y abiertos | `RF_35: una comunidad que ya cobra por encima —o justo en— la base nueva no se toca` | `community-pricing.test.ts` | cubierto |
| El administrador sube la base por encima del precio del lider | `RF_35: la base sube por encima del precio del lider y ese concepto se eleva al piso exacto` | `community-pricing.test.ts` | cubierto |
| Entregado y luego corregido a fallido tras pagar el corte | `RF_24: si el corte del lider ya se pago, se compensa y no se toca el corte` | `community-corrections.test.ts` | cubierto |
| Tienda que cambia de comunidad | `RF_11: el plan no nombra asientos, cashback, cortes ni pedidos, en ninguna de sus formas` | `community-access.test.ts` | cubierto |
| Lider desactivado con cashback pendiente | `RF_51: el plan no nombra el cashback pendiente, ni asientos, ni cortes, ni saldos` | `community-access.test.ts` | cubierto |
| Nombre corto cambiado (enlace viejo vivo 30 dias) | `RF_04, RF_03: un nombre corto valido si cambia, y retira el anterior conservandolo 30 dias` | `community-slug.test.ts` | cubierto |
| Logo enorme o corrupto | `RF_16, RF_15: un archivo ausente o vacio se rechaza sin borrar el logo que ya habia` | `community-view.test.ts` | cubierto |
| Subida programada que se cruza con la salida de una tienda | — | — | **SIN COBERTURA** |
| Dos subidas programadas encadenadas | `RF_54: solo hay una programada por concepto y la segunda reinicia el plazo` | `community-pricing.test.ts` | cubierto |
| Comunidad con una sola tienda que no vende | `RF_33: distingue cero real de sin datos` | `community-stats.test.ts` | cubierto |
| Periodo a caballo entre dos meses | `RF_46: entregados y fallidos comparten el eje de cierre, que es orders.closedAt` | `community-stats.test.ts` | cubierto |
| Tienda que entra a mitad del periodo | — (por construccion: `getCommunityStats` filtra por `orders.communityId`, sellado al crear el pedido) | `functions/src/community-stats.ts:62` | **SIN PRUEBA NOMBRADA** |
| Dos lideres con el mismo nombre comercial | `RF_04: un nombre corto ya en uso por otra comunidad se rechaza y deja el anterior vigente` | `community-slug.test.ts` | cubierto |

El unico caso limite **sin cubrir ni por construccion** es *"subida programada que se cruza con la
salida de una tienda"*: si la tienda deja la comunidad antes de la fecha de entrada, la subida no
debe alcanzarla. La spec lo declara y no hay prueba ni codigo que lo nombre. Su riesgo es bajo
—reasignar tiendas es raro y solo lo hace un administrador (RF_11)— pero es una cifra de dinero.

---

## 6. Suite ejecutada

Comando declarado en `.sdd/state.json`: `npm test`.

```
$ npx vitest run

 Test Files  25 passed (25)
      Tests  532 passed (532)
   Duration  10.86s

$ npx tsc --noEmit                       -> exit 0
$ cd functions && npx tsc --noEmit       -> exit 0
$ npm run lint                           -> exit 0
  3 problems (0 errors, 3 warnings)
  - operations-app.tsx:433:6   react-hooks/exhaustive-deps (session, state)
  - operations-app.tsx:754:67  react-hooks/exhaustive-deps (state)
  - operations-app.tsx:2452:6  react-hooks/exhaustive-deps (processQueue)
```

Los tres avisos son los tres conocidos y declarados en `CLAUDE.md`. `rules-of-hooks` sigue en cero.

**Cobertura:** no hay herramienta de cobertura configurada (ni `@vitest/coverage-*` en
`package.json` ni bloque `coverage` en la configuracion de Vitest). **No se estima un porcentaje.**
La unica cifra defendible es la de trazabilidad por nombre: 328 de 532 pruebas llevan
identificador de requisito, y los 54 RF tienen al menos una.

Crecimiento desde el informe anterior: de **24 archivos / 273 pruebas** a **25 / 532**. Practicamente
todo el crecimiento esta en los cinco archivos de comunidad.

---

## 7. Estado de `.sdd/state.json`

La inconsistencia que denunciaba el informe anterior **esta corregida**: T9, T12, T16, T17, T18,
T19, T21, T22, T23, T25, T26 y T27 estan hoy en `testWritten: false`, que es la verdad. T28 dejo de
estar bloqueada, con la razon anotada en el propio registro.

Queda una inconsistencia menor y en la direccion inofensiva: **T37 y T46 declaran
`testWritten: false` y si tienen pruebas** (`T37 · desactivar a un lider no borra la deuda pendiente
con el`, nueve pruebas; `T46 · quien ve el control de reasignar una tienda de comunidad (RF_11)`,
seis). Infravalora, no infla. No cambia ningun veredicto.

**Aparte del DoD, un aviso operativo:** todo el trabajo de T28-T47 esta **sin commitear**. El ultimo
commit de la rama es `7d4d75e` (10-09-2026) y el arbol tiene 26 archivos modificados y dos nuevos
sin seguimiento (`functions/src/community-floor-trigger.ts`, `functions/src/community-signup-doc.ts`).
Esta auditoria se hizo sobre el **arbol de trabajo**, no sobre `HEAD`.

---

## 8. Veredicto sobre el Definition of Done

| # | Punto | Veredicto |
|---|---|---|
| 1 | Cada RF_01 a RF_54 tiene al menos una prueba que pasa, nombrada de forma rastreable | **SI** — 54/54, con 4 parciales anotados en §3 |
| 2 | Cashback atado por pruebas a la misma fuente, con los dos caminos de correccion | **SI** — RNF_02, RF_24 (compensacion) y RF_25 (recalculo) |
| 3 | `npm test`, `tsc` en raiz y backend, y `npm run lint` sin errores | **SI** |
| 4 | Carga del panel del lider medida y registrada segun RNF_01 | **NO** — la cuenta de documentos si (0 con 100 y con 10.000); el tiempo hasta ver cifras no se ha medido |
| 5 | Evidencia funcional por cada historia de usuario, incluido el registro en movil | **NO** — `.sdd/evidence` no existe |
| 6 | Ninguna cifra de dinero existente cambia para tiendas sin comunidad | **SI** — RNF_02, RF_37, RNF_04 y `RF_24: un pedido sin comunidad no produce ninguna reversa de cashback` |
| 7 | El humano valido el resultado y aprobo la entrega | **NO** — pendiente por construccion |

**DoD INCUMPLIDO. Tres de siete sin cumplir** (antes cuatro de siete).

El cambio de fondo respecto al informe anterior: **los tres puntos que dependian de escribir pruebas
estan cerrados.** Los tres que faltan ya no se arreglan con mas unidad —uno pide produccion (4) y
dos piden ejecucion y persona (5 y 7).

---

## 9. Que sigue

**La auditoria de trazabilidad ya no bloquea. El siguiente paso es `/sdd-verify`.**

No hay requisito huerfano que justifique volver a `/sdd-run`. Los dos RNF sin cobertura (RNF_03,
iOS 14 y movil; RNF_05, sistema de diseno) son precisamente los que solo se pueden afirmar con la
aplicacion delante, igual que el DoD 5. Van en el mismo paso.

Lo que `/sdd-verify` tiene que dejar capturado, por orden de riesgo:

1. **El registro completo desde un enlace, en un movil.** Es el DoD 5 literal y ademas es donde se
   cierran RNF_03 y las dos mitades sin prueba de RF_07 (que la callable ejecute el plan que si
   esta probado).
2. **El aislamiento de verdad, contra `firestore.rules`.** Un lider intentando leer un pedido y el
   saldo de una tienda suya. Es la pata sin prueba de RF_31 y RF_52, y en este repo no hay ninguna
   prueba de reglas que pueda sustituirla.
3. **La contencion de punta a punta** (RF_41, RF_42): revocar el enlace, desactivar en bloque por
   rango y comprobar que ningun pedido ni asiento desaparecio. El planificador tiene 45 pruebas,
   pero la superficie que lo lanza se construyo en T44 y no ha ejecutado nunca de verdad.
4. **El corte del lider marcado como pagado** (RF_49) y la vista de comunidades del admin (RF_34).
5. **RNF_05**, con el checklist de `docs/design-system.md`.

Tres cosas que **no** entran en `/sdd-verify` y conviene no perder:

- **La marca por alta de RF_13** (§3). Es el unico desajuste entre spec e implementacion que
  encontro esta auditoria. Pide tarea, no captura.
- **El predicado de RF_17** (quien fija la base). Una prueba, del tamano de sus diez hermanas.
- **El caso limite de la subida programada que se cruza con la salida de una tienda** (§5).

Y antes de nada: **commitear T28-T47** (§7).

---
---

# Historico — auditoria del 2026-09-10

> Se conserva integra para poder comparar. Fase `verify`, paso 1 · Rama
> `feat/pedido-manual-multilinea` · Tarea activa T28.

## Recuento (10-09-2026)

- **59 requisitos** (54 RF + 5 RNF)
- **41 cubiertos**, **10 parciales**, **12 sin cobertura alguna**, **1 medido e incumplido** (RNF_01)

**Huerfanos (cero pruebas):** RF_07, RF_08, RF_10, RF_34, RF_41, RF_42, RF_44, RF_49, RF_53,
RNF_03, RNF_04, RNF_05.

**Parciales:** RF_04 (no prueba que conserve el slug anterior), RF_11 (falta el MUST NOT de no
mover el cashback ya causado), RF_16 (no prueba que conserve el logo anterior), RF_27 (falta el
veto sobre pago a lider logistico/mensajero/costo de producto), RF_28 (falta que se muestre de
inmediato), RF_32 (falta el enlace de invitacion junto a las cifras en cero), RF_35 (falta el
aviso), RF_40 (falta cancelar/rebajar antes de la fecha), RF_46 (solo se prueba el ROTULO; el eje
real vive en `functions/src/community-stats.ts` sin prueba), RF_51 (falta que la deuda sobreviva a
la desactivacion).

## Inconsistencia de estado detectada (10-09-2026)

`.sdd/state.json` marca `testWritten: true` en T9, T12, T16, T17, T18, T19, T21, T22, T23, T25,
T26 y T27, y varias no tienen ninguna prueba que valide sus requisitos.

## Suite ejecutada (10-09-2026)

```
Test Files  24 passed (24)
Tests      273 passed (273)
npx tsc --noEmit                 -> 0
cd functions && npx tsc --noEmit -> 0
npm run lint                     -> 0 errores, 3 avisos conocidos
```

Sin herramienta de cobertura configurada; no se estimo.

## Veredicto del 10-09-2026

| # | Punto | Veredicto |
|---|---|---|
| 1 | Cada RF con prueba rastreable | **NO** — 12 sin prueba, 10 parciales |
| 2 | Cashback atado a la misma fuente, ambos caminos de correccion | **SI** |
| 3 | test + tsc + lint sin errores | **SI** |
| 4 | Carga del lider medida y registrada (RNF_01) | **NO** — medida, y el resultado es que NO se cumple |
| 5 | Evidencia funcional por historia de usuario | **NO** — `.sdd/evidence` no existe |
| 6 | Ninguna cifra de dinero cambia sin comunidad | **SI** |
| 7 | Validacion humana | **NO** — pendiente por construccion |

**DoD INCUMPLIDO.** Cuatro de siete sin cumplir. Se ordeno volver a `/sdd-run` con tareas nuevas
por orden de riesgo: alta por enlace (RF_07, RF_08, RF_10), contencion del enlace filtrado (RF_41,
RF_42, RF_53), RF_49 y RF_34, RF_44, los tres RNF sueltos, las mitades de RF_11 y RF_51, y el
RF_46 real. Ese trabajo es el que cerraron T28-T47.
