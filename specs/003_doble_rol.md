# Spec 003: Una persona, su tienda y su comunidad

- **Estado:** borrador (segunda version, tras revision adversarial)
- **Autor:** Codex (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-11

## 1. Contexto y objetivo

Hoy una cuenta de la plataforma tiene **un papel y solo uno**. Quien vende no puede liderar una
comunidad, y quien lidera no puede vender. Esto no se decidio: se heredo de cuando no habia
comunidades.

El caso que lo rompe es real y ya se ha dado: **una tienda que ya opera quiere ademas liderar una
comunidad**. Hoy las unicas salidas son malas: convertir su cuenta le quita la tienda —sus pedidos,
su saldo y sus cortes quedan colgando de una identidad que ya nadie puede usar—, y darle una segunda
cuenta le pasa el problema a la persona.

**Objetivo:** que una misma persona pueda ser tienda y lider con **una sola cuenta**, viendo en cada
momento solo lo que ese papel puede ver.

## 2. Historias de usuario

- **Como** tienda que ademas lidera una comunidad **quiero** entrar una sola vez y cambiar entre mi
  tienda y mi comunidad **para** no tener dos cuentas ni dos contrasenas.
- **Como** responsable de la plataforma **quiero** dar el liderazgo de una comunidad a una tienda que
  ya opera **para** no tener que pedirle que se cree otra cuenta.
- **Como** responsable de la plataforma **quiero** retirar ese liderazgo sin romperle el negocio ni
  dejar a sus tiendas pagando un sobreprecio que ya no va a nadie.
- **Como** quien dejo de liderar **quiero** seguir viendo y cobrando lo que se me debe **para** que
  una decision de la plataforma no me borre una deuda.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 Los dos papeles conviven

- **RF_01 (ubicua):** El sistema MUST permitir que una misma cuenta sea tienda y lider de comunidad
  a la vez, sin que un papel sustituya al otro.
- **RF_02 (ubicua):** El sistema MUST tratar "liderar una comunidad" como una **atribucion propia**
  de la cuenta, independiente de su papel operativo, y MUST NOT deducirla del papel.
- **RF_03 (ubicua):** El sistema MUST NOT confundir **liderar** una comunidad con que la tienda de
  esa cuenta **pertenezca** a ella. Son dos hechos distintos y pueden darse por separado, juntos o
  ninguno.
- **RF_04 (evento):** **Cuando** el administrador conceda el liderazgo a una cuenta que ya opera, el
  sistema MUST conservar intacto todo lo que esa cuenta ya tenia: su identidad operativa, sus
  pedidos, su saldo y su historial.
- **RF_06 (error):** **Si** se intenta conceder a una cuenta el liderazgo de una comunidad cuando ya
  lidera otra, el sistema MUST rechazarlo explicando cual lidera. Una cuenta lidera como mucho una
  comunidad.

### 3.2 Que es "conceder el liderazgo", exactamente

- **RF_17 (ubicua):** El sistema MUST permitir asignar a una cuenta el liderazgo de una comunidad
  **que ya existe**, y MUST permitir tambien crear la comunidad y asignarsela en el mismo acto. Los
  dos caminos MUST ser atomicos: o queda todo, o no queda nada, con la misma regla que ya rige el
  alta de un lider.
- **RF_18 (estado):** **Mientras** una comunidad tenga lider, el sistema MUST admitir **uno solo**.
- **RF_19 (evento):** **Cuando** se asigne una comunidad que ya tiene lider, el sistema MUST tratarlo
  como un **traspaso**: el anterior deja de liderarla, y MUST conservar integro su cashback ya
  causado, que sigue siendo deuda de la plataforma con quien lo genero.

### 3.3 Retirar el liderazgo, y que pasa con la comunidad

- **RF_05 (evento):** **Cuando** el administrador retire el liderazgo, el sistema MUST dejar la
  cuenta operando exactamente como antes de concederselo, y MUST NOT tocar el cashback ya causado.
- **RF_20 (estado):** **Mientras** una comunidad no tenga lider, el sistema MUST cobrar a sus tiendas
  la **tarifa base** en los pedidos nuevos, y MUST NOT causar cashback por ellos. Seguir cobrando el
  sobreprecio de una comunidad sin lider seria cobrarle de mas a las tiendas para no pagarselo a
  nadie.
- **RF_21 (ubicua):** Los pedidos ya creados MUST conservar el precio con el que entraron, tambien al
  quedarse la comunidad sin lider. Un corte puede contener pedidos de antes y de despues, y eso es
  correcto.
- **RF_22 (estado):** **Mientras** la plataforma le deba cashback a quien dejo de liderar, el sistema
  MUST seguir mostrandoselo y MUST permitir que se le pague por el mecanismo de cortes de siempre.
  **Dejar de liderar no es dejar de ser acreedor**, y retirar el papel no puede borrar la pantalla
  desde la que se cobra.
- **RF_23 (ubicua):** El sistema MUST distinguir **liderar** —causar cashback nuevo y gobernar los
  precios de la comunidad— de **ser acreedor** —ver y cobrar lo ya causado—. Lo primero se retira;
  lo segundo se extingue solo cuando la deuda queda en cero.

### 3.4 Lo que se ve en cada momento

- **RF_07 (ubicua):** El sistema MUST permitir a quien tenga los dos papeles elegir con cual esta
  operando, y MUST indicarlo de forma visible en todo momento.
- **RF_08 (estado):** **Mientras** la persona opere como **tienda**, el sistema MUST mostrarle
  exactamente lo que ve cualquier tienda —sus pedidos, sus clientes, su saldo— y nada de la
  comunidad.
- **RF_09 (estado):** **Mientras** la persona opere como **lider**, el sistema MUST NOT mostrarle el
  detalle de un pedido, los datos del cliente final ni el saldo de ninguna tienda, **incluida la
  suya**. Esto es una regla de **presentacion**: el servidor le sigue reconociendo el acceso que le
  da su papel de tienda, porque ese derecho es suyo y no depende de que sombrero lleve puesto. Lo
  que la pantalla de lider no hace es **ensenarselo**.
- **RF_10 (ubicua):** El cambio de un papel a otro MUST NOT exigir volver a entrar.
- **RF_11 (estado):** **Mientras** una cuenta tenga un solo papel **y ninguna deuda pendiente de otro
  anterior**, el sistema MUST NOT mostrarle ningun selector: quien no elige no debe decidir nada.

### 3.5 La tienda del propio lider

- **RF_12 (opcion):** **Donde** la tienda de un lider pertenezca a su propia comunidad, el sistema
  MUST permitirlo y MUST causar su cashback igual que el de cualquier otra tienda.
- **RF_13 (ubicua):** El sistema MUST mostrar al administrador, en la lista de comunidades, **cuanto
  del cashback de cada comunidad procede de la tienda del propio lider**. Permitirlo y esconderlo son
  cosas distintas: lo primero es una decision de negocio, lo segundo es una cifra que nadie audita.
- **RF_14 (ubicua):** El sistema MUST contar la tienda del lider como una tienda mas en las cifras de
  su comunidad, sin trato especial. Excluirla haria que los totales no cuadraran con los cortes.
- **RF_24 (evento):** **Cuando** un lider cuya tienda pertenece a su comunidad cambie un precio, el
  sistema MUST avisar al administrador de que ese cambio le afecta a el mismo, y MUST aplicarle el
  plazo de aviso de subida **sin excepcion**, aunque la unica tienda afectada sea la suya.

### 3.6 Lo que baja el navegador

- **RF_15 (estado):** **Mientras** una cuenta tenga los dos papeles, el sistema MUST darle lo que
  necesita cada papel, y MUST NOT dejar de mostrar ninguna cifra de dinero que veria con cualquiera
  de los dos por separado.
- **RF_16 (ubicua):** El numero de documentos que descarga una cuenta con los dos papeles MUST ser
  como mucho la **suma** de los que descarga cada papel por separado, medido con el procedimiento de
  la documentacion de rendimiento vigente. No se exige que quepa en el presupuesto de un solo papel:
  eso seria imposible por definicion.

## 4. Requisitos no funcionales

- **RNF_01:** Ninguna cuenta con un solo papel MUST cambiar de comportamiento por esta
  funcionalidad. Es la garantia de no regresion: hoy la plataforma la usan cinco papeles y ninguno
  pidio esto.
- **RNF_02:** Las restricciones de acceso MUST decidirse en el servidor a partir de **lo que la
  cuenta es**, nunca a partir del papel que la pantalla diga tener activo. Un selector de interfaz
  MUST NOT conceder ni retirar un solo permiso.
- **RNF_03:** Cambiar de papel MUST NOT provocar ninguna descarga adicional de datos ya presentes:
  **cero documentos leidos** por el cambio en si. Es lo que lo hace inmediato, y es medible.

## 5. Casos limite

- **Tienda con pedidos abiertos al recibir el liderazgo** (RF_04): siguen suyos y en curso.
- **La tienda del lider entra a su propia comunidad a mitad de periodo** (RF_12, RF_14): sus pedidos
  anteriores no causan cashback, como los de cualquier tienda que entra tarde.
- **Se retira el liderazgo con cashback pendiente** (RF_05, RF_22): la deuda sigue viva y visible; la
  tienda sigue operando; la comunidad pasa a tarifa base (RF_20).
- **Traspaso de una comunidad con cashback pendiente del anterior** (RF_19, RF_22): el anterior
  conserva lo suyo y deja de causar nuevo; el nuevo empieza en cero.
- **Se desactiva la cuenta**: caen los dos papeles a la vez. No existe media cuenta.
- **La comunidad que lidera se desactiva** (RF_05, RF_22): pierde el papel y conserva la tienda y la
  deuda.
- **Cuenta que lidera una comunidad y cuya tienda pertenece a OTRA** (RF_03): legitimo, debe
  funcionar.
- **Selector en un movil** (RF_07): tiene que caber y verse; es la pantalla donde mas se usara.
- **Sesion abierta cuando se retira el liderazgo** (RF_05, RNF_02): la pantalla puede tardar en
  enterarse, pero el servidor MUST negar desde el primer intento.

## 6. Fuera de alcance

- **El camino inverso: un lider que quiere abrir tienda con su misma cuenta.** RF_01 es simetrico,
  pero ese camino necesita ciudad, punto de recogida y cuenta bancaria, y hoy no tiene requisito que
  lo gobierne. **Queda fuera por escrito** para que nadie lo suponga incluido.
- **Cualquier otra combinacion de papeles.** Solo tienda + lider.
- **Liderar mas de una comunidad** (RF_06 lo prohibe).
- **Que la tienda del lider tenga tarifa distinta por ser suya.** Paga lo que pague su comunidad.
- **Un historial de quien lidero y cuando.** Deseable para auditar; spec futura.
- **Poner techo al precio de una comunidad.** Ver seccion 8.

## 7. Definition of Done

1. Cada RF y RNF tiene al menos una prueba automatizada que pasa.
2. Verificacion de tipos y linters sin errores.
3. Queda demostrado que una cuenta con **un solo** papel no cambia de comportamiento (RNF_01).
4. Queda demostrado que **el selector no concede nada**: una cuenta sin el papel de tienda no obtiene
   acceso al saldo de ninguna tienda por mucho que su pantalla diga lo que diga (RNF_02).
5. Esta medido, **en documentos descargados**, que una cuenta con dos papeles no supera la suma de
   los dos presupuestos (RF_16), y que cambiar de papel lee **cero** documentos (RNF_03).
6. Queda demostrado que una comunidad sin lider cobra tarifa base y no causa cashback (RF_20).
7. El humano valido el resultado y aprobo la entrega.

## 8. Decisiones tomadas sin respuesta del responsable

Se pregunto y no llego respuesta. Se decidio para no bloquear, y se deja escrito para poder
revertirlo.

**La tienda del lider SI puede pertenecer a su comunidad y cobrar cashback por sus propias ventas**
(RF_12). Prohibirlo exigiria una regla nueva con sus propios casos limite —que pasa con una tienda
que ya estaba dentro antes de que su duena fuera lider— y **hoy nada lo impide**: con el control de
reasignar comunidad ya se podria hacer. Lo que no puede es quedar escondido, de ahi RF_13.

**Y hay un conflicto de interes que esta decision abre y que conviene mirar de frente:** el precio de
una comunidad tiene **piso** pero no **techo**. Una persona cuya tienda pertenece a su propia
comunidad fija el precio que ella misma paga y se cobra a si misma la diferencia —cargo en su saldo
de tienda, abono en su cashback de lider, en cortes distintos y probablemente en fechas distintas—.
**Nada lo impide hoy, y esta spec tampoco lo impide**: se limita a hacerlo visible (RF_13) y a no
eximirla del plazo de aviso (RF_24).

Poner techo es una decision de negocio que no me corresponde y que esta **fuera de alcance** a
proposito. Si la respuesta es que debe haberlo, es una spec propia y conviene abrirla antes de que
haya comunidades con volumen.

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-11 | Borrador inicial | Una tienda que ya opera quiere liderar una comunidad |
| 2026-09-11 | Segunda version tras revision adversarial | Seis huecos: RF_09 y RNF_02 se contradecian (se resuelve declarando RF_09 regla de presentacion); retirar el liderazgo no decia que pasaba con la comunidad, que seguia cobrando sobreprecio para nadie (RF_20); quien dejaba de liderar perdia la pantalla donde cobra lo que se le debe (RF_22, RF_23); "conceder el liderazgo" no estaba definido como operacion (RF_17, RF_18, RF_19); el conflicto de interes en el precio no estaba escrito; y RF_16/RNF_03 no eran medibles. Ademas se declara fuera de alcance el camino inverso, que estaba en el limbo |
