# Spec 002: Entorno de verificacion aislado

- **Estado:** borrador (segunda version, tras revision adversarial)
- **Autor:** Codex (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-11

## 1. Contexto y objetivo

La spec 001 (lider de comunidad) esta desplegada y tiene 532 pruebas automatizadas en verde. Aun
asi, **tres recorridos que tocan dinero y datos personales no se han ejecutado nunca de verdad**:

1. **El alta de una tienda por el enlace de un lider.** Es la unica superficie de la plataforma
   abierta sin sesion, crea una cuenta de acceso y adscribe la tienda a una comunidad de forma
   permanente. Sus piezas estan probadas por separado; la cadena entera, no.
2. **La contencion de un enlace filtrado.** La spec 001 la declara el *unico* remedio cuando un
   enlace se difunde donde no debia, y su efecto es cerrar accesos en bloque. Nunca se ha visto
   cerrar uno.
3. **La cadena del dinero del lider**: lo que causa un pedido, la fila que lo agrupa, el corte que
   lo liquida y la cifra de "pagado" que ve el lider. Cada eslabon tiene prueba; el encadenado, no.

**Por que no se han ejecutado.** Hacerlo sobre la plataforma viva exigiria crear tiendas reales,
desactivar cuentas reales y mover cifras que alimentan los indicadores, los cortes y la posicion
financiera. Es la misma razon por la que la medicion de carga del panel del lider se hizo derivando
y no sembrando. Hoy, ademas, escribir sobre los datos reales desde una sesion automatizada esta
bloqueado, y esa barrera es correcta y no se toca.

**Objetivo:** disponer de un entorno donde el ciclo de vida completo de una comunidad se pueda
ejecutar de principio a fin cuantas veces haga falta, **sin que exista ninguna posibilidad de que
una ejecucion de prueba escriba sobre los datos reales**.

## 2. Historias de usuario

- **Como** responsable de la plataforma **quiero** ver el alta de una tienda por enlace ejecutarse
  entera **para** saber que el camino que mas datos personales toca funciona antes de repartir un
  enlace.
- **Como** responsable de la plataforma **quiero** ver una contencion cerrar accesos de verdad
  **para** confiar en el unico remedio que tengo si un enlace se filtra.
- **Como** responsable de la plataforma **quiero** seguir el dinero de un lider desde que lo causa
  un pedido hasta que el lider lo ve como pagado **para** comprobar que la cadena no se rompe.
- **Como** quien desarrolla **quiero** partir siempre del mismo estado conocido **para** que un
  recorrido que falla senale un fallo del producto y no restos de la ejecucion anterior.
- **Como** responsable de la plataforma **quiero** tener la certeza de que una verificacion jamas
  tocara los datos reales **para** poder autorizarla sin revisarla cada vez.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 Aislamiento — el requisito que sostiene a los demas

- **RF_01 (ubicua):** El sistema MUST ejecutar toda verificacion contra un conjunto de datos
  separado del real, sin ninguna via de lectura ni de escritura entre ambos. **"Datos reales"
  significa cualquier conjunto que contenga informacion de personas o de dinero reales**, no solo
  el de produccion.
- **RF_02 (error):** **Si** una verificacion arranca sin que el entorno aislado este disponible, el
  sistema MUST detenerse con un aviso explicito y MUST NOT continuar contra los datos reales. Caer
  hacia el entorno real cuando falta el aislado es el modo de fallo mas caro que puede tener este
  arnes: silencioso y destructivo.
- **RF_03 (ubicua):** El sistema MUST rechazar el arranque de una verificacion que apunte al
  entorno real, aunque quien la lance se lo pida explicitamente.
- **RF_04 (estado):** **Mientras** una verificacion este en curso, el sistema MUST identificar en
  todo momento y de forma visible contra que entorno esta corriendo.
- **RF_05 (ubicua):** El sistema MUST ejecutar, en el entorno aislado, **la misma logica de
  servidor y las mismas reglas de acceso** que rigen en el real. Lo unico que puede diferir son los
  datos. Si la logica difiere, un recorrido verde aqui no dice nada de alli, que es justo lo que
  este arnes existe para evitar.
- **RF_06 (ubicua):** El sistema MUST poder demostrar esa equivalencia **por procedencia** —que
  ambos entornos ejecutan el mismo codigo— y MUST NOT hacerlo comparando contra los datos reales,
  que RF_01 prohibe.

### 3.2 Estado de partida y limpieza

- **RF_07 (ubicua):** El sistema MUST poder dejar el entorno aislado en un estado de partida
  conocido y descrito, con los participantes y las tarifas minimas para que una comunidad opere.
- **RF_08 (evento):** **Cuando** empiece una verificacion, el sistema MUST dejar el entorno en ese
  estado conocido **antes** de ejecutar nada, sin restos de ejecuciones anteriores. La limpieza va
  **al principio y no al final**, de modo que lo que deja una ejecucion fallida sobrevive hasta que
  alguien lance la siguiente (RF_10).
- **RF_09 (ubicua):** El estado de partida MUST ser reproducible: dos preparaciones seguidas MUST
  dejar el entorno equivalente, sin depender del reloj ni del orden de ejecucion.
- **RF_10 (opcion):** **Donde** una verificacion haya fallado, el sistema MUST conservar el estado
  tal como quedo hasta la siguiente ejecucion, para poder mirarlo.
- **RF_11 (estado):** **Mientras** haya una verificacion en curso, el sistema MUST impedir que otra
  arranque sobre el mismo entorno, y MUST NOT quedar bloqueado si la anterior murio sin liberarlo.

### 3.3 El tiempo

- **RF_12 (ubicua):** El sistema MUST poder fijar el instante de **los datos de partida**, para
  poder situarse al otro lado de los plazos de la spec 001 —los ocho dias de una subida, los treinta
  de un nombre corto retirado— y comprobar que la regla se aplica cuando la fecha llega. **No** se
  exige gobernar el reloj del servidor: los pasos cuyo instante lo pone el propio sistema caen en
  RF_13.
- **RF_13 (ubicua):** Los tramos cuyo instante **no** sea gobernable desde fuera MUST declararse
  como no verificados, en vez de falsearse sembrando fechas. Un recorrido que salta el paso que
  pretende demostrar es peor que no tenerlo, porque se reporta en verde.

### 3.4 Los tres recorridos

- **RF_14 (ubicua):** El sistema MUST permitir ejecutar, de principio a fin y sobre el entorno
  aislado, el alta de una tienda por el enlace de un lider, y MUST comprobar que la tienda queda
  con acceso, adscrita a la comunidad, y con constancia de por que enlace entro y cuando.
  *(Demuestra de la spec 001: RF_07, RF_08, RF_09, RF_10, RF_43, RF_44, RF_45.)*
- **RF_15 (ubicua):** El sistema MUST permitir ejecutar la contencion de un enlace y MUST comprobar
  que los accesos alcanzados quedan efectivamente cerrados, que los que quedan fuera del criterio
  siguen abiertos, y que ningun pedido ni movimiento de dinero desaparece.
  *(Demuestra de la spec 001: RF_41, RF_42, RF_53.)*
- **RF_16 (ubicua):** El estado de partida de ese recorrido MUST contener, como minimo: una cuenta
  del enlace **dentro** del rango, otra del mismo enlace **fuera** del rango, otra de **otro**
  enlace, una **justo en la frontera** del rango, y una **sin correo de contacto**. Sin esa
  composicion, "los que quedan fuera siguen abiertos" no es comprobable y dos ejecuciones darian por
  verde cosas distintas.
- **RF_17 (ubicua):** El sistema MUST permitir seguir el dinero de un lider hasta la cifra de
  "pagado", y MUST comprobar **estas igualdades**, que no son "la misma cifra" sino tres relaciones
  distintas:
  1. lo que causa un pedido es la **diferencia** entre el precio de la comunidad y la base;
  2. la fila de liquidacion es la **suma** de lo causado y sin cortar de esa comunidad;
  3. lo que el lider ve como pagado es la **suma de sus cortes ya marcados**, y vale cero mientras
     no se marque ninguno.
  Un importe causado de cero es un resultado valido y MUST NOT tratarse como fallo.
  *(Demuestra de la spec 001: RF_22, RF_23, RF_26, RF_29, RF_49.)*
- **RF_18 (ubicua):** El recorrido del dinero MUST cubrir tambien los dos caminos de correccion de
  la spec 001: compensacion cuando el corte ya se pago, y recalculo cuando sigue pendiente. Son el
  encadenado con mas dinero en riesgo.
  *(Demuestra de la spec 001: RF_24, RF_25.)*
- **RF_19 (ubicua):** Cada recorrido MUST dejar evidencia de lo ocurrido —lo que respondio cada
  peticion, el estado en que quedaron los datos y los avisos de error— asociada a los requisitos de
  la spec 001 que demuestra.

### 3.5 La aplicacion que se verifica

- **RF_20 (opcion):** **Donde** un recorrido necesite recorrer la aplicacion como lo haria una
  persona, el sistema MUST permitir que la aplicacion opere contra el entorno aislado.
- **RF_21 (ubicua):** Una version destinada a personas usuarias MUST operar **siempre** contra los
  datos reales, y MUST ignorar por completo cualquier indicacion de apuntar a otro sitio, venga de
  donde venga.
- **RF_22 (error):** **Si** se detectase la intencion de apuntar una version publicada al entorno
  aislado, el sistema MUST ignorarla y seguir sirviendo la aplicacion con normalidad, y MUST dejar
  constancia del intento. **MUST NOT dejar de servir la aplicacion**: la pantalla en blanco es el
  peor desenlace conocido de esta plataforma —esta registrado dos veces en la constitucion— y una
  proteccion que lo provoca hace mas dano que el fallo del que protege.

## 4. Requisitos no funcionales

- **RNF_01:** Una verificacion completa de los tres recorridos MUST poder ejecutarse en una sola
  orden y sin intervencion manual, y SHOULD terminar en menos de diez minutos: un arnes que exige
  vigilancia no se usa.
- **RNF_02:** El arnes MUST NOT anadir ninguna dependencia al programa que se entrega a las
  personas usuarias.
- **RNF_03:** La preparacion del entorno en una maquina limpia MUST estar descrita y MUST poder
  seguirse sin conocimiento previo del proyecto.
- **RNF_04:** Un fallo del arnes MUST distinguirse de un fallo del producto en el propio informe.
  Un arnes que se reporta como fallo del producto envia a corregir lo que no esta roto.

## 5. Casos limite

Cada uno cuelga del requisito que lo gobierna; ninguno introduce comportamiento nuevo.

- **Segunda ejecucion seguida** (RF_08, RF_09): la segunda da el mismo resultado que la primera. Si
  la primera dejo una tienda registrada, la segunda no falla por correo duplicado.
- **Verificacion interrumpida a la mitad** (RF_08, RF_10): el entorno queda sucio y asi se queda
  hasta la siguiente ejecucion, que lo limpia al arrancar.
- **El entorno ya esta ocupado** (RF_11): se avisa, no se mezclan las dos, y una ejecucion muerta no
  deja el arnes bloqueado.
- **Un recorrido falla** (RNF_04): el informe dice si fallo el producto o el arnes.
- **Reglas de acceso** (RF_05): el entorno aislado las aplica igual que el real.
- **Participante sin correo de contacto dentro del criterio** (RF_15, RF_16): se reporta como **no
  cerrado**. No es comportamiento nuevo: es lo que la plataforma ya hace, y el recorrido existe para
  verlo ocurrir.

## 6. Fuera de alcance

- **Reproducir el volumen de datos de la plataforma real.** El presupuesto de carga se mide como ya
  describe la documentacion de rendimiento; este arnes verifica comportamiento, no escala.
- **Las integraciones con terceros** (tienda externa, confirmacion por mensajeria). Los recorridos
  usan el alta manual, que es la via que la spec 001 toca.
- **Verificar la plataforma ya desplegada.** Eso se seguira haciendo contra la version publicada y
  sin escribir; esta spec no lo sustituye.
- **Sustituir las pruebas automatizadas existentes.** El arnes cubre el encadenado, no la
  aritmetica: esa se queda donde esta.
- **Que el arnes corra en integracion continua.** Deseable, pero es trabajo propio y se decidira en
  una spec futura.
- **Verificar a la vez desde dos sitios.** RF_11 solo exige no mezclar y no bloquearse; la ejecucion
  simultanea de dos verificaciones no se soporta en esta spec.
- **Recorrer la aplicacion con un navegador (RF_20).** Queda **fuera de este ciclo**, por dos
  razones y no por una: hay un fallo conocido del utillaje entre emuladores, identificadores `demo-`
  y el integrador de frameworks; y sobre todo, el precio de no hacerlo esta acotado y se declara —la
  cifra de "pagado" que ve el lider se completa **en el cliente**, asi que contra la superficie de
  servidor vale siempre cero. Esa relacion se afirma con la funcion pura de cliente que la calcula,
  y **"lo que el lider ve en pantalla" queda como tramo no verificado** (RF_13). Decirlo es lo que
  distingue una exclusion de un hueco.

## 7. Definition of Done

1. Cada RF y cada RNF de esta spec tiene al menos una prueba automatizada que pasa, o —para los que
   describen una imposibilidad— una comprobacion que falla si la imposibilidad deja de serlo.
2. Verificacion de tipos y linters sin errores.
3. Los tres recorridos se ejecutan completos y dejan evidencia, y esa evidencia demuestra los
   requisitos de la spec 001 enumerados en RF_14, RF_15, RF_17 y RF_18 — **diecisiete en total**:
   RF_07, RF_08, RF_09, RF_10, RF_22, RF_23, RF_24, RF_25, RF_26, RF_29, RF_41, RF_42, RF_43,
   RF_44, RF_45, RF_49, RF_53.
4. Queda demostrado, con una comprobacion ejecutable, que una verificacion no puede escribir sobre
   los datos reales.
5. Los tramos no verificables por no gobernar su instante (RF_13) estan enumerados por escrito.
6. Una persona que no conozca el proyecto consigue levantar el entorno siguiendo lo escrito.
7. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-11 | Borrador inicial | La spec 001 se desplego con tres recorridos criticos jamas ejecutados de verdad |
| 2026-09-11 | Segunda version tras revision adversarial | Seis huecos: RF_15 prescribia dejar la app en blanco (el peor desenlace registrado de esta plataforma); "la misma cifra en cada eslabon" era falso por diseno; el tiempo no se gobernaba y los plazos de la 001 eran inalcanzables; la composicion minima del estado de partida no estaba; RF_06 y RF_08 se contradecian; y seis MUST de casos limite colgaban del aire, el mismo defecto que la 001 ya corrigio el 08-09 |
