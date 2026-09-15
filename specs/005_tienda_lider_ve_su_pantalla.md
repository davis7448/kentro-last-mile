# Spec 005: La tienda que ademas lidera puede entrar y ver sus dos pantallas

- **Estado:** aprobada (2026-09-11, por el responsable de la plataforma, tras revision adversarial)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-11

## 1. Contexto y objetivo

La spec 003 prometio que una persona puede ser tienda y lider de comunidad con **una sola cuenta**,
y cambiar entre las dos pantallas sin volver a entrar (RF_07, RF_10 de la 003). Esta desplegada y
marcada como implementada. **La primera cuenta real que la uso no vio nada.**

El 2026-09-11 se le dio el liderazgo de la comunidad E-master a la tienda "Brayan E-master", que ya
operaba. La concesion salio bien: la comunidad existe, tiene a esa cuenta como lider y la cuenta
conserva su tienda. Al entrar, la persona vio solo esto:

> **Perfil de vendedor pendiente.** Tu cuenta existe, pero falta vincularla a una tienda. Un
> administrador debe asignar tu usuario al sellerId correcto.

Tres cosas estan mal a la vez, y ninguna la ve quien administra:

1. **La tienda desaparece.** Para una cuenta con los dos papeles, la plataforma intenta traer a la
   vez la tienda propia y las tiendas de la comunidad. La segunda peticion se rechaza siempre, y el
   rechazo arrastra a la primera y a todo lo demas que se carga al entrar. La pantalla se queda sin
   tienda, sin ciudades y sin ajustes.
2. **El mensaje miente.** Dice que falta vincular la cuenta a una tienda, y la cuenta si esta
   vinculada. Manda a la persona a pedirle al administrador un arreglo que no hace falta, y al
   administrador a buscar un fallo de configuracion que no existe.
3. **No hay forma de llegar a la comunidad.** La plataforma sabe que la cuenta tiene dos pantallas,
   pero el control para cambiar entre ellas nunca se llego a mostrar. Aunque la tienda cargara, la
   persona no podria abrir su comunidad.

El mismo fallo de la tienda desaparecida alcanza tambien a quien **solo** lidera: hoy no hay ninguno
en produccion, y por eso no se ha visto.

**Objetivo:** que una cuenta con tienda y comunidad entre, vea su tienda completa, pueda cambiar a
su comunidad y vea ahi sus tiendas; y que un fallo al cargar datos nunca vuelva a presentarse como
un problema de configuracion de la cuenta.

## 2. Historias de usuario

- **Como** tienda que ademas lidera una comunidad **quiero** entrar y ver mi tienda como siempre
  **para** seguir operando el dia en que me dieron el liderazgo.
- **Como** tienda que ademas lidera **quiero** un control visible para pasar a mi comunidad y volver
  **para** atender las dos cosas sin tener dos cuentas.
- **Como** lider de comunidad, con tienda o sin ella, **quiero** ver en mi pantalla de comunidad las
  tiendas que la forman **para** saber a quien tengo. Lo que se ve de cada una lo gobierna RF_09 de
  la 003, que esta spec no toca: nada de saldos ni de pedidos.
- **Como** responsable de la plataforma **quiero** que, si algo no carga, la pantalla lo diga como un
  fallo de carga **para** no perder tiempo buscando un error de configuracion que no existe.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 La tienda se ve

- **RF_01 (evento):** **Cuando** entre una cuenta que es tienda y ademas lidera una comunidad, el
  sistema MUST mostrarle su tienda con lo mismo que ve cualquier tienda: sus pedidos, su saldo, su
  inventario, sus integraciones y todo lo que la pantalla necesita para operar (ciudades, ajustes).
  Hace cumplir RF_08 de la spec 003.
- **RF_09 (evento):** **Cuando** entre una cuenta con tienda y vinculo con una comunidad, el sistema
  MUST abrirle primero su tienda. Es lo que ya decide la regla de papeles de la 003 (T11): si la
  cuenta opera, se abre lo operativo; aqui se deja escrito como requisito para que no dependa de
  una lectura del codigo.
- **RF_02 (ubicua):** El sistema MUST mostrar la tienda propia de esa cuenta tanto si la tienda
  pertenece a la comunidad que lidera como si pertenece a otra o a ninguna. Hace cumplir RF_03 de la
  spec 003.

### 3.2 La comunidad se ve

- **RF_03 (estado):** **Mientras** una cuenta sea tienda **y** tenga vinculo con una comunidad —la
  lidere o sea acreedora de ella tras dejar de liderarla—, el sistema MUST mostrarle en la cabecera,
  en todo momento y en cualquier seccion, un control que indique con que papel esta operando y
  permita cambiar al otro. "En todo momento" incluye el aviso de fallo de carga de RF_07: si la
  tienda no carga, la comunidad MUST seguir alcanzable. Hace cumplir RF_07 y RF_11 de la spec 003;
  el vinculo, no la posicion, es lo que da acceso a la pantalla de comunidad (RF_22 de la 003).
- **RF_04 (evento):** **Cuando** la persona elija su papel de lider, el sistema MUST mostrarle su
  pantalla de comunidad sin pedirle que vuelva a entrar; y **cuando** elija su papel de tienda, MUST
  devolverla a su tienda del mismo modo. Hace cumplir RF_10 de la spec 003.
- **RF_05 (evento):** **Cuando** un lider de comunidad —con tienda propia o sin ella— abra su
  pantalla de comunidad, el sistema MUST mostrarle las tiendas que pertenecen a su comunidad, y MUST
  NOT mostrarle ninguna tienda de otra comunidad.

### 3.3 Un fallo al cargar no es un problema de configuracion

- **RF_06 (error):** **Si** no se pueden obtener las tiendas de la comunidad, el sistema MUST seguir
  mostrando la tienda propia y todo lo demas de esa cuenta; lo que falte MUST limitarse a la parte
  de comunidad.
- **RF_07 (error):** **Si** falla la carga de los datos con los que arranca la pantalla, el sistema
  MUST mostrar un aviso visible de que no se pudo cargar la informacion y MUST ofrecer reintentar.
  MUST NOT mostrar en su lugar un mensaje que atribuya el problema a la configuracion de la cuenta.
- **RF_08 (estado):** **Mientras** la cuenta tenga una tienda vinculada **y esa tienda exista**, el
  sistema MUST NOT mostrar el mensaje de "perfil pendiente". Ese mensaje MUST quedar reservado a los
  dos casos que son de verdad un problema de configuracion, que solo el administrador arregla, y
  MUST decir cual de los dos es:
  - la cuenta no tiene tienda asignada;
  - la cuenta tiene asignada una tienda que ya no existe ("La tienda asignada a tu cuenta ya no
    existe; pidele al administrador que te asigne una").

  Solo se puede afirmar cualquiera de los dos **despues de una carga que funciono**. Si la carga
  fallo, gana RF_07: sin datos no se puede decir nada de la cuenta.

### 3.4 Por que no hay tiendas en la pantalla de comunidad

Una lista de tiendas vacia puede significar tres cosas distintas, y la pantalla MUST NOT confundirlas:
pintar un fallo como "no tienes tiendas" es el mismo tipo de mensaje falso que esta spec elimina.

- **RF_10 (error):** **Si** la lista de tiendas de la comunidad no se pudo obtener por un fallo de
  carga, el sistema MUST decir que no se pudo cargar y MUST ofrecer reintentar.
- **RF_11 (estado):** **Mientras** la comunidad no tenga ninguna tienda, el sistema MUST decir que
  todavia no tiene tiendas, sin presentarlo como error y sin ofrecer reintentar.
- **RF_12 (estado):** **Mientras** la cuenta ya no gobierne la comunidad —le retiraron el liderazgo
  y solo le queda ser acreedora—, el sistema MUST decirle que ya no gobierna esa comunidad, MUST NOT
  ofrecerle reintentar (el servidor se lo niega por diseno, no por fallo) y MUST seguir mostrandole
  lo que se le debe (RF_22 de la 003).

## 4. Requisitos no funcionales

- **RNF_01:** Ninguna cuenta **sin vinculo con una comunidad** —tiendas, logisticos, domiciliarios,
  mensajeros y administradores— MUST cambiar de comportamiento respecto a **como se comporta hoy**:
  ni lo que ve, ni lo que descarga, ni lo que puede leer. Ninguna de ellas esta afectada por el
  fallo, asi que su comportamiento actual es la referencia correcta. Las cuentas **con** vinculo
  (lider puro, tienda-lider, acreedor) NO se comparan con hoy, porque hoy estan rotas: las gobiernan
  RF_01 a RF_09 y RNF_03.
- **RNF_02:** Lo que una cuenta puede leer MUST seguir decidiendose en el servidor por lo que la
  cuenta **es**, nunca por el papel que la pantalla diga tener activo (RNF_02 de la 003). Arreglar la
  lectura de las tiendas de la comunidad MUST NOT abrir a un lider una sola tienda de otra comunidad
  ni a una tienda una sola tienda ajena.
- **RNF_03:** La referencia de descarga para las cuentas con vinculo es la que fija la 003, no la
  de hoy (que baja menos porque falla): el lider baja solo las tiendas de **su** comunidad, y una
  cuenta tienda-lider baja como mucho la suma de lo que bajaria cada papel por separado (RF_16 de la
  003, principio 11 de la constitucion). Las cuentas sin vinculo, por RNF_01, no bajan ni un
  documento mas que hoy.
- **RNF_04:** El control para cambiar de papel MUST caber y verse en un telefono de 390 px de ancho,
  que es donde mas se usara (caso limite "Selector en un movil" de la 003), y MUST seguir el sistema
  de diseno vigente.

## 5. Casos limite

- **La tienda propia pertenece a la misma comunidad que lidera** (RF_02, RF_05): aparece una sola
  vez como su tienda, y una vez en la lista de tiendas de la comunidad. No se duplica ni se pierde.
- **La tienda propia no pertenece a ninguna comunidad** (RF_02): es exactamente el caso de Brayan
  E-master, y tiene que funcionar.
- **Comunidad recien creada, sin ninguna tienda todavia** (RF_05, RF_11): la pantalla de comunidad
  se ve y dice que aun no tiene tiendas, sin error. Hoy E-master tiene una sola tienda, de prueba.
- **Quien dejo de liderar y sigue siendo acreedor** (RF_06, RF_12, RF_22 de la 003): ya no puede ver
  las tiendas de la comunidad. Su tienda MUST verse igual, y su pantalla de comunidad MUST decirle
  que ya no la gobierna y seguir mostrandole lo que se le debe.
- **Sesion abierta en el momento en que se concede el liderazgo** (RF_03): la cuenta no sabe todavia
  que lidera. "Entrar" significa aqui **cerrar sesion y volver a iniciarla**: recargar la pagina no
  basta, porque la sesion guardada conserva los permisos anteriores hasta renovarse sola (como mucho
  una hora). El control MUST aparecer, como tarde, al volver a iniciar sesion. No se exige antes.
- **Sesion abierta en el momento en que se retira el liderazgo** (RNF_02): la pantalla puede seguir
  ensenando el control un rato; el servidor MUST negar la lectura de las tiendas de la comunidad
  desde el primer intento, y eso, por RF_06, MUST NOT tumbar la tienda. Mientras la pantalla no se
  entere, esa negativa se vera como fallo de carga (RF_10); al volver a entrar, como RF_12.
- **Conexion que se cae a mitad de la carga** (RF_07): el aviso y el reintento, no el "perfil
  pendiente".
- **Cuenta cuya tienda asignada ya no existe** (RF_08): la carga funciona pero la tienda no aparece.
  Es configuracion, no fallo: "perfil pendiente" con el texto que dice que la tienda ya no existe,
  sin reintentar, porque reintentar nunca lo arreglaria.
- **Telefono con iOS antiguo** (RNF_04): el control no puede depender de nada que ese navegador no
  entienda (principio 2 de la constitucion).

## 6. Fuera de alcance

- **Recordar que papel eligio la persona entre una visita y otra.** Se abre la tienda (RF_09).
  Recordarlo es deseable y es otra spec.
- **Que el control aparezca al instante cuando se concede el liderazgo con la sesion abierta.**
  Basta con que aparezca al volver a entrar.
- **Un entorno automatico para probar las reglas de acceso.** Es la spec 002, que sigue sin
  implementar. Aqui el canal es la sesion real con cuenta desechable (ver Definition of Done).
- **Cualquier cambio en lo que ve la pantalla de comunidad.** Esta spec hace que se pueda llegar a
  ella y que tenga sus tiendas; su contenido lo gobiernan las specs 001 y 003.
- **El camino inverso (un lider que quiere abrir tienda).** Sigue fuera, como en la 003.

## 7. Definition of Done

1. Cada RF y RNF tiene al menos una prueba automatizada que pasa (`npm test`), salvo lo que solo
   puede comprobarse contra el servidor real, que va en el punto 4 y se declara como tal.
2. Hay una prueba que falla si la cabecera deja de mostrar el control de papel a una cuenta que es
   tienda y tiene vinculo con una comunidad (como lider **y** como acreedora), y otra que falla si se
   lo muestra a una cuenta sin vinculo. Es el hueco exacto por el que la 003 se dio por buena sin el
   control.
3. `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
4. **Evidencia contra produccion, con todo desechable.** Cuentas, tiendas y comunidades se crean
   para la prueba con un prefijo reconocible. La prueba MUST NOT tocar E-master ni ninguna tienda o
   comunidad real, y MUST NOT escribir en el registro de dinero. Casos:
   - una tienda que lidera una comunidad de prueba a la que su tienda no pertenece: ve su tienda,
     cambia a la comunidad, ve las tiendas de esa comunidad y vuelve;
   - la misma, intentando leer una tienda de **otra** comunidad de prueba: se le niega (RNF_02);
   - un lider puro: ve las tiendas de su comunidad (RF_05);
   - una comunidad de prueba sin tiendas: dice que aun no tiene tiendas (RF_11);
   - una tienda sin comunidad: no cambia nada respecto a hoy (RNF_01).

   Al terminar se borra todo lo creado. Si la prueba se corta a medias, la limpieza MUST poder
   volver a correrse, y se comprueba que no queda nada con el prefijo.

   **El acreedor no se prueba en produccion**: fabricarlo exige anotar cashback real, que apareceria
   en las cifras de la plataforma. Sus casos (RF_03, RF_12) se cubren solo con pruebas automaticas,
   y queda declarado asi.
5. Capturas en escritorio y en un telefono de 390 px del control y de las dos pantallas.
6. La cuenta de Brayan E-master cierra sesion, vuelve a entrar y ve su tienda y su comunidad,
   comprobado por el responsable.
7. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-11 | Borrador inicial | La primera cuenta real con tienda y liderazgo (Brayan E-master) entro y vio "Perfil de vendedor pendiente" y ningun acceso a su comunidad, con la spec 003 ya desplegada |
| 2026-09-11 | Segunda version tras revision adversarial | Seis huecos. El control solo contaba "dos papeles" y dejaba sin salida al acreedor, en contra de RF_11 de la 003 (RF_03 y DoD 2 ahora dicen "vinculo"). RNF_01 y RNF_03 no decian contra que se compara y el lider puro los incumplia por fuerza (ahora: cuentas sin vinculo contra hoy; con vinculo, contra la 003). Una lista vacia de tiendas podia significar tres cosas (RF_10 a RF_12). "Perfil pendiente" no distinguia cuenta sin tienda de tienda que ya no existe (RF_08). La prueba en produccion podia quitarle la comunidad a un lider real o tocar dinero (DoD 4, todo desechable, acreedor fuera de produccion). "Entrar" y la pantalla por defecto no estaban definidos (caso limite, RF_09) |
