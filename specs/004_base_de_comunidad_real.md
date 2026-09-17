# Spec 004: La base de una comunidad es lo que Kentro cobra de verdad

- **Estado:** aprobada (2026-09-11, tras escrutinio adversarial de seis preguntas)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-11

## 1. Contexto y objetivo

La spec 001 dice que la tarifa base "es lo que cobra Kentro y es el piso de cualquier precio de
comunidad" (RF_17). Hoy eso no se cumple, y el error aun no ha costado dinero solo porque la unica
comunidad viva tiene una tienda de prueba sin pedidos.

**El hueco.** Para el pedido fallido cobrable, Kentro cobra **$12.000** a toda tienda que no tenga
tarifa especial, digan lo que digan los ajustes. Los ajustes dicen **$9.000**, y ese valor no tiene
efecto sobre ninguna tienda sin comunidad. Pero la parte de comunidades toma la base de los ajustes,
no de lo que realmente se cobra. Consecuencias medidas el 2026-09-11 en produccion:

- **Una tienda de comunidad pagaria $9.000 por fallido y el resto $12.000.** Estar en una comunidad
  le bajaria el cobro a la tienda $3.000 por fallido sin que nadie lo haya decidido, y Kentro dejaria
  de cobrarlos. No falla ni avisa. Afecta a practicamente todo pedido futuro: 997 de los ultimos
  1.000 pedidos no tienen zona, y sin zona la base sale de los ajustes.
- **Si un lider fija su fallido entre $9.001 y $12.000**, el sistema lo acepta como si fuera un
  sobreprecio y le causa cashback. En realidad es dinero que Kentro ya cobraba: se lo estaria
  regalando al lider.
- **El administrador ve "Fallido $9.000"** en el panel de comunidades, y la tienda ve lo mismo en
  "Tu tarifa". Ninguna de las dos cifras es lo que se cobra.

**El segundo hueco, de lectura.** En el panel de comunidades el administrador ve "Entrega $12.000 ·
Fallido $9.000 · Manejo $2.000" sin saber si son precios que fijo el lider o la base porque el lider
no fijo nada. Se lee como "la comunidad cobra y paga $2.000 de manejo", cuando en realidad son la
base y el cashback es cero.

**Objetivo:** que en todo lo que toca comunidades (lo que se congela en el pedido, lo que se acepta
como precio del lider, lo que se causa como cashback y lo que se muestra) la base sea **el mismo
numero que Kentro le cobraria a esa tienda si no estuviera en ninguna comunidad**, y que el
administrador distinga de un vistazo el precio propio de la base.

## 2. Historias de usuario

- **Como** responsable de la plataforma **quiero** que una tienda de comunidad nunca pague menos que
  una tienda sin comunidad **para** no perder dinero por el simple hecho de que alguien la invito.
- **Como** responsable de la plataforma **quiero** que el cashback de un lider salga solo de lo que
  cobra por encima de lo que Kentro ya cobraba **para** no pagarle un margen que no genero.
- **Como** responsable de la plataforma **quiero** ver en el panel de comunidades si cada tarifa es
  precio propio del lider o la base, y cuanto cashback deja **para** no leer como margen lo que es
  el cobro de siempre.
- **Como** tienda de una comunidad **quiero** ver en "Tu tarifa" lo que de verdad me van a cobrar
  **para** que el corte no me sorprenda.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 Una sola base

- **RF_01 (ubicua):** El sistema MUST tomar como base de comunidad, para cada concepto (entrega,
  fallido cobrable y manejo), exactamente lo que cobraria a esa misma tienda por ese mismo pedido si
  la tienda no perteneciera a ninguna comunidad, incluidas las tarifas que hoy mandan sobre los
  ajustes (el fallido de $12.000).
- **RF_02 (ubicua):** El sistema MUST calcular esa base en un solo sitio, y ese sitio MUST ser el
  mismo que decide el cobro de las tiendas sin comunidad. Si alguien cambia el cobro de las tiendas
  sin comunidad, la base de comunidad MUST moverse con el sin tocar nada mas. Esto rige en el
  servidor y en la app por igual: lo que muestran el panel del administrador y "Tu tarifa" MUST
  salir de ese mismo sitio, sin una segunda copia de la regla en la app (constitucion, principio 3).
- **RF_03 (evento):** **Cuando** un pedido de una tienda de comunidad se cree o se importe, el
  sistema MUST guardar en el pedido el precio del lider vigente en ese instante. Ese precio queda
  fijo para el pedido (RF_21 de la spec 001). La base NO se fija al crear: se decide al cerrar
  (RF_11). El sistema MAY guardar tambien la base del momento de crear, solo como referencia.
- **RF_11 (evento):** **Cuando** un pedido de una tienda de comunidad genere cobro a la tienda, el
  sistema MUST calcular la base de RF_01 en ese momento, con los mismos datos con los que se cobraria
  a una tienda sin comunidad (tarifa vigente y zona del pedido al cierre). MUST cobrar el mayor entre
  el precio guardado del lider y esa base, y MUST causar como cashback la diferencia entre lo cobrado
  y esa base, que nunca es negativa. **Esto reemplaza a RF_22 de la spec 001 en lo que respecta a la
  base**: el precio del lider sigue fijo desde la creacion, la base no.
- **RF_04 (ubicua):** El sistema MUST NOT cobrar nunca a una tienda de comunidad, por un pedido y un
  concepto, menos de lo que cobraria por ese mismo pedido a una tienda sin comunidad, sin importar si
  la zona o las tarifas cambiaron entre que se creo y se cerro. **Mientras** el lider no haya fijado
  precio propio para un concepto, el cobro MUST ser exactamente ese y el cashback MUST ser cero
  (precisa a RF_20 de la spec 001).

### 3.2 Lo que el lider puede fijar

- **RF_05 (error):** **Si** el lider intenta fijar un precio por debajo de la base de RF_01 para un
  pedido **sin zona**, el sistema MUST rechazarlo aplicando RF_19 de la spec 001 contra esa base, y
  MUST indicar esa base como minimo. Un precio igual a la base sigue siendo valido (RF_18 de la spec
  001). La validacion MUST NOT exigir superar la base de ninguna zona: en un pedido con zona, RF_11
  cobra la base de la zona si es mayor.
- **RF_12 (ubicua):** Donde el sistema muestre al lider, al administrador o a la tienda un precio de
  comunidad o un margen (RF_05, RF_07, RF_09, RF_10), MUST indicar que en pedidos con zona la base
  puede ser mayor, y que en ese caso se cobra la base y el cashback de ese pedido es menor o cero.
- **RF_06 (ubicua):** El sistema MUST NOT causar cashback por la diferencia entre la base de los
  ajustes y la base de RF_01. Un precio del lider que no supera lo que Kentro ya cobraba MUST dar
  cashback cero en ese concepto.
- **RF_13 (evento):** **Cuando** el administrador guarde los ajustes de tarifas y eso suba la base de
  RF_01 (sin zona) por encima del precio guardado de un lider, el sistema MUST aplicar RF_35 de la
  spec 001: elevar ese precio hasta la nueva base, avisar al lider, registrarlo en el historial
  (RF_39 de la 001) y descartar cualquier subida programada que quede por debajo de la nueva base.
  El sistema MUST reaccionar a los ajustes que de verdad se usan para cobrar: hoy RF_35 escucha unos
  ajustes que no existen en produccion y nunca se ha ejecutado.
- **RF_14 (evento):** **Cuando** se despliegue esta spec, o cualquier cambio que suba la base de
  RF_01 sin pasar por la pantalla de ajustes (por ejemplo, un cambio en el cobro fijo del fallido),
  el sistema MUST aplicar una vez la misma elevacion de RF_13 a todo precio guardado que haya quedado
  por debajo de la nueva base, con el mismo aviso e historial. Esta pasada MUST poder ejecutarse en
  seco, mostrando que cambiaria antes de escribir nada.

### 3.3 Lo que se ve

- **RF_07 (ubicua):** El panel de comunidades del administrador MUST mostrar, por cada concepto, lo
  que se le cobraria hoy a un pedido sin zona de esa comunidad cerrado en ese instante: el precio del
  lider con las subidas programadas ya vencidas aplicadas, llevado como minimo a la base de RF_01, y
  la base sola si la comunidad esta desactivada o sin lider (RF_20 de la 001). MUST NOT mostrar el
  precio guardado cuando no coincida con lo que se cobra.
- **RF_08 (estado):** **Mientras** lo que se cobra en un concepto sea igual a la base de RF_01, el
  panel MUST rotularlo como base, con margen $0, se deba a que el lider no fijo precio, lo fijo igual
  a la base o lo tiene guardado por debajo. **Si** la comunidad esta desactivada o sin lider, el
  panel MUST ademas indicar ese motivo.
- **RF_09 (estado):** **Mientras** lo que se cobra en un concepto supere la base de RF_01, el panel
  MUST rotularlo como precio del lider y MUST mostrar a su lado el margen por pedido (lo cobrado
  menos la base).
- **RF_15 (estado):** **Mientras** haya una subida programada del lider que aun no entra en vigor,
  el panel MUST mostrarla aparte del precio vigente, con su valor y su fecha, y MUST NOT sumarla al
  precio ni al margen de hoy.
- **RF_10 (ubicua):** La tarjeta "Tu tarifa" de la tienda MUST mostrar, por concepto, lo que se le
  cobraria hoy a un pedido **sin zona** cerrado en ese instante: el mayor entre el precio vigente del
  lider y la base de RF_01. Para un pedido sin zona, lo mostrado y lo cobrado MUST ser el mismo
  numero. Para pedidos con zona aplica el aviso de RF_12.

## 4. Requisitos no funcionales

- **RNF_01:** Ninguna tienda sin comunidad MUST ver alterado su cobro por esta spec: el mismo pedido
  cerrado antes y despues del cambio MUST generar los mismos movimientos de dinero, centavo a
  centavo, comprobado con prueba automatizada sobre tiendas normales y tiendas con tarifa especial.
- **RNF_02:** El administrador MUST NOT descargar datos nuevos para pintar el panel: todo lo que
  pide RF_07 a RF_09 se deriva de lo que ya tiene cargado (constitucion, principio 11).
- **RNF_03:** La regla de la base MUST poder probarse sin red ni base de datos (constitucion,
  principios 3 y 9).

## 5. Casos limite

- **Pedido con zona.** La base de RF_01 es, concepto por concepto, lo que se le cobraria a una
  tienda sin comunidad con esa zona. Para entrega y manejo eso es la tarifa de la zona (hoy manejo
  $2.500 en las tres). **Para el fallido es $12.000 aunque la zona diga otra cosa**, porque ese
  valor fijo le gana tambien a la zona en el cobro normal. No hay excepcion por zona: RF_01 manda.
- **Lider que fija manejo $2.300.** Se acepta (supera la base sin zona de $2.000). En un pedido sin
  zona la tienda paga $2.300 y el lider cobra $300. En un pedido con zona la tienda paga $2.500 y el
  lider cobra $0. El lider, el administrador y la tienda ven el aviso de RF_12.
- **Tienda con tarifa especial en codigo (DANDA).** Ya no puede entrar en una comunidad (la creacion
  del pedido lo rechaza). Esa proteccion MUST mantenerse: esta spec no la relaja.
- **Lider que ya fijo un fallido entre $9.001 y $12.000 antes del cambio.** Hoy no existe ninguno
  (E-master no tiene precios propios). Si existiera, la pasada de RF_14 le eleva el precio a $12.000
  con aviso e historial. Mientras tanto, RF_11 ya cobra $12.000 al cierre con cashback cero, asi que
  no se pierde dinero ni siquiera antes de la pasada. No se reescribe nada ya causado.
- **La pasada de RF_14 se ejecuta dos veces.** La segunda MUST no cambiar nada ni volver a avisar:
  un precio que ya esta en la base no esta por debajo de ella.
- **El administrador guarda los ajustes sin cambiar ninguna tarifa** (por ejemplo, un texto). RF_13
  MUST NOT elevar ni avisar nada.
- **El pedido del smoke (DoD 5) es fallido y en produccion.** La regla del proyecto es no borrar
  nunca pedidos fallidos o entregados, porque sus movimientos acaban en cortes de transportista ya
  conciliados que mezclan varias tiendas. El smoke es la unica excepcion, y solo porque usa un
  transportista desechable (ningun corte real puede incluirlo) y porque se comprueba, antes de
  borrar, que ningun movimiento entro en un corte. Si esa comprobacion falla, rige la regla general:
  se compensa, no se borra.
- **El smoke se interrumpe a mitad** (pedido creado pero sin cerrar, o cerrado sin limpiar). La
  limpieza MUST poder repetirse a partir de los ids del pedido y del transportista desechable, y MUST
  dar el mismo resultado si ya se habia hecho en parte.
- **Subida programada que queda por debajo de la base real.** Una subida del lider a $11.000 ya
  programada MUST NOT anunciarse a la tienda como subida: al vencer no cambiaria el cobro. Ya lo
  cumple `buildStoreTariffView` si recibe la base correcta.
- **Pedidos creados antes del despliegue con la base vieja de $9.000 guardada.** Al 2026-09-11 son
  cero (ningun pedido tiene precio de comunidad guardado). Si aparece alguno antes de desplegar,
  RF_11 lo cubre sin intervencion manual: al cerrar se cobra el mayor entre lo guardado ($9.000) y la
  base real ($12.000), o sea $12.000, con cashback cero. La base guardada en esos pedidos se ignora.
- **La base sube entre que se crea y se cierra el pedido.** La tienda paga la base nueva, igual que
  una tienda sin comunidad, y el cashback del lider en ese pedido se reduce o queda en cero. La
  tienda no recibe los ocho dias de aviso de RF_28 de la spec 001: esos dias protegen de las subidas
  del lider, no de las de Kentro, que tampoco se avisan a las tiendas sin comunidad.
- **La base baja entre que se crea y se cierra el pedido.** La tienda paga el precio guardado del
  lider (que no baja) y el cashback crece en lo que bajo la base. Se acepta: el lider fijo un precio
  y la tienda lo vio al crear el pedido.
- **Correccion administrativa de un pedido de comunidad ya cerrado** (fallido a entregado, etc.):
  MUST recalcular la base con la misma regla de RF_11, en el momento de la correccion, y compensar
  segun RF_24 y RF_25 de la spec 001.
- **El administrador cambia el fallido en ajustes.** Hoy eso no mueve el cobro de nadie. Con esta
  spec tampoco mueve la base de comunidad (RF_02). Es coherente pero sigue siendo engañoso; ver
  fuera de alcance.

## 6. Fuera de alcance

- **Decidir si el fallido lo manda la pantalla de ajustes o los $12.000 fijos.** Esta spec no cambia
  el cobro de ninguna tienda: solo hace que comunidades use el cobro real. Quitar el valor fijo o
  arreglar la pantalla de ajustes (que hoy deja editar un valor sin efecto) es otra spec.
- **La pantalla para que el lider fije sus precios.** La funcion del servidor existe y ninguna
  pantalla la usa. Es otra spec; esta solo corrige contra que base se valida.
- **Ensenarle al lider el aviso de elevacion (RF_13, RF_14).** *Decision tomada sin respuesta del
  responsable, revertible.* En esta spec "avisar al lider" significa lo mismo que ya hace RF_35 de la
  001: dejar escrita la marca de aviso por concepto y la entrada de historial (RF_39 de la 001). Hoy
  **ninguna pantalla la lee** —es un hueco de la 001, no de esta—, y mostrarla es parte de la
  pantalla de precios del lider, fuera de alcance por el punto anterior. No se pierde nada hoy:
  ninguna comunidad tiene precios propios, asi que no hay nada que elevar ni nadie a quien avisar.
  Se exige que la marca y el historial se escriban (T7, T8), para que esa pantalla futura los tenga.
- **Cashback ya causado o pagado.** No hay ninguno (0 movimientos al 2026-09-11). No se toca nada.
- **Precio de comunidad por zona.** El lider fija un precio unico, no uno por zona.

## 7. Definition of Done

1. Todos los RF tienen al menos una prueba automatizada que pasa (`npm test`).
2. Prueba que ata RNF_01: el mismo pedido de tienda sin comunidad produce los mismos movimientos
   antes y despues, incluida una tienda DANDA.
3. Prueba que ata RF_02 en los dos lados: la base de comunidad, el cobro sin comunidad del servidor
   y el calculo de la app salen de la misma funcion. La prueba MUST fallar si el servidor o la app
   vuelven a tener su propia copia del fallido fijo o de la base.
4. `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
5. Smoke en produccion, tras desplegar, con limpieza posterior:
   - Antes de desplegar se cuentan los pedidos de comunidad abiertos y se reporta la cifra.
   - El panel de comunidades muestra "Fallido $12.000 (base)" para E-master, y la pasada de RF_14 en
     seco reporta 0 cambios.
   - Un pedido de prueba de la tienda "Prueba" de E-master, sin zona, asignado a un **transportista
     desechable creado para el smoke**, se cierra como fallido cobrable. Debe generar un cobro de
     fallido de $12.000 a la tienda y ningun cashback. Se capturan los movimientos como evidencia.
   - Limpieza: se respaldan y luego se borran exactamente el pedido, sus movimientos, su auditoria y
     el transportista desechable, y nada mas. **Antes de borrar se comprueba que ninguno de esos
     movimientos esta en ningun corte.** Si alguno lo esta, no se borra nada: se compensa con la
     correccion administrativa (RF_24/RF_25 de la 001) y se reporta.
   - Tras la limpieza, la posicion de la plataforma y el saldo de la tienda "Prueba" vuelven a las
     cifras de antes del smoke.
6. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-11 | Borrador inicial | El administrador leyo "Manejo $2.000" como un cobro y un pago automaticos; al revisarlo aparecio que la base de comunidad sale de los ajustes y no del cobro real |
| 2026-09-11 | Grill P1: la base se decide al cierre (RF_03, RF_04, RF_11 nuevo; reemplaza RF_22 de la 001 en la base) | La zona es editable despues de crear el pedido y el cobro sin comunidad usa la tarifa del cierre: congelar la base dejaba cobrar de menos. Decision del responsable |
| 2026-09-11 | Grill P2: se valida y se muestra contra la base sin zona, con aviso (RF_05, RF_10, RF_12 nuevo) | 997 de cada 1.000 pedidos no tienen zona; exigir la base mas alta de las zonas le quitaba al lider un rango que casi siempre aplica. Decision del responsable |
| 2026-09-11 | Grill P3: RF_35 de la 001 se repara y se extiende (RF_13, RF_14 nuevos) | El disparador de RF_35 escucha unos ajustes que no existen en produccion (se guardan en otro sitio) y nunca se ha ejecutado. Decision del responsable: arreglarlo aqui, con aviso al lider |
| 2026-09-11 | Grill P4: el panel del admin rotula por lo que se cobra (RF_07, RF_08, RF_09 reescritos; RF_15 nuevo) | El panel pintaba el precio guardado sin aplicar subidas vencidas, tope a la base ni estado del lider: el mismo error de lectura que origino la spec. Decision del responsable |
| 2026-09-11 | Grill P5: "un solo sitio" incluye la app (RF_02, DoD 3) | El fallido fijo tiene hoy dos copias, servidor y app; una prueba solo de servidor dejaba pasar la del panel. Decision del responsable |
| 2026-09-11 | Grill P6: smoke de punta a punta con pedido fallido real y limpieza (DoD 5, dos casos limite) | La base se decide al cierre, asi que solo un pedido cerrado demuestra el cobro. Decision del responsable: probar y limpiar. Transportista desechable y comprobacion de cortes antes de borrar, por la regla de no borrar fallidos |
| 2026-09-11 | Aprobada | Aprobacion explicita del responsable tras las seis preguntas del escrutinio |
| 2026-09-11 | Aclaracion tras `/sdd-analyze`: que es "avisar al lider" (fuera de alcance) | El analisis encontro que la marca de aviso de RF_35 de la 001 no la lee ninguna pantalla. Decision tomada sin respuesta del responsable (trabajo autonomo pedido por el): el aviso es la marca + el historial; mostrarlo va con la pantalla de precios del lider. Revertible |
