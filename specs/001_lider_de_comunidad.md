# Spec 001: Lider de comunidad

- **Estado:** aprobada
- **Autor:** admashopp@gmail.com
- **Fecha:** 2026-09-08

## 0. Aviso de vocabulario

En Kentro ya existe el **lider logistico**: quien recoge la mercancia y la reparte entre mensajeros.
El **lider de comunidad** de esta spec es una figura **distinta y sin relacion** con aquella: no
toca mercancia, no reparte y no ve rutas. Agrupa tiendas y gana por lo que ellas operan. Los dos
nombres conviven en la misma interfaz, asi que en pantalla nunca se escribe "lider" a secas.

## 1. Contexto y objetivo

Hoy toda tienda nueva la crea a mano un administrador de Kentro. Eso convierte al administrador en
el cuello de botella de la unica palanca de crecimiento que tiene la plataforma: mas tiendas
vendiendo. No escala, y ademas no hay forma de reconocerle nada a quien trae y sostiene a esas
tiendas.

El lider de comunidad resuelve las dos cosas. Es una persona que reune a un grupo de tiendas, las
trae a Kentro con su propio enlace de invitacion, les pone su marca y cobra por el servicio un
precio que el decide, siempre por encima de lo que Kentro cobra. La diferencia entre lo que le
cobra a su tienda y lo que Kentro le cobra a el es su ingreso: el **cashback**. A cambio, el lider
se ocupa de su comunidad y ve como va cada uno de sus miembros.

Lo que se busca con esto: que crecer deje de depender de que un administrador cree cuentas, y que
quien trae volumen tenga un motivo economico medible para sostenerlo.

## 2. Historias de usuario

- **Como** lider de comunidad **quiero** invitar tiendas con un enlace propio **para** que entren a
  operar sin esperar a que un administrador de Kentro las cree una por una.
- **Como** lider de comunidad **quiero** poner mi logo en el registro y en el panel de mis tiendas
  **para** que la comunidad perciba mi marca y no la de un proveedor ajeno.
- **Como** lider de comunidad **quiero** fijar el precio que pagan mis tiendas por cada envio
  **para** decidir yo cuanto gano por sostener la comunidad.
- **Como** lider de comunidad **quiero** ver como va cada tienda de mi comunidad **para** detectar a
  tiempo quien dejo de vender o quien tiene demasiados pedidos fallidos.
- **Como** tienda de una comunidad **quiero** enterarme de una subida de precio antes de que me la
  cobren **para** poder decidir si sigo operando con ese lider.
- **Como** lider de comunidad **quiero** ver cuanto cashback llevo causado y cuanto ya me pagaron
  **para** saber que me deben sin tener que preguntarle a nadie.
- **Como** administrador **quiero** crear y desactivar lideres de comunidad **para** controlar quien
  puede invitar tiendas en nombre de Kentro.
- **Como** administrador **quiero** cortar el enlace de un lider en cualquier momento **para** frenar
  altas indebidas sin tener que borrar tiendas ya creadas.
- **Como** tienda referida **quiero** registrarme y empezar a operar de una vez **para** no perder
  dias esperando una aprobacion.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 La comunidad y su enlace

- **RF_01 (ubicua):** El sistema MUST reconocer la figura de lider de comunidad, distinta del lider
  logistico, a la que pertenece un conjunto de tiendas llamado su comunidad.
- **RF_50 (ubicua):** El sistema MUST permitir que solo un administrador cree, desactive y reactive
  cuentas de lider de comunidad, y MUST exigir para crearla nombre, correo y telefono de contacto.
  Ningun lider MAY crear otro lider ni darse de alta por si mismo.
- **RF_51 (estado):** **Mientras** una cuenta de lider este desactivada, el sistema MUST impedirle
  entrar y MUST conservar intactos su comunidad, su historial de precios y su cashback pendiente:
  desactivar a un lider MUST NOT borrar una deuda que la plataforma tiene con el.
- **RF_02 (ubicua):** El sistema MUST asignar a cada lider de comunidad un enlace de registro propio
  e irrepetible, identificado por un nombre corto que el lider elige.
- **RF_03 (ubicua):** El sistema MUST permitir al lider de comunidad cambiar su nombre corto, y MUST
  seguir aceptando el anterior durante al menos treinta dias para no romper los enlaces ya
  repartidos.
- **RF_04 (error):** **Si** el nombre corto elegido ya esta en uso, es una palabra reservada por la
  plataforma o contiene caracteres no permitidos, el sistema MUST rechazarlo, explicar el motivo y
  MUST conservar el anterior.
- **RF_05 (ubicua):** El sistema MUST permitir a un administrador revocar o reactivar el enlace de
  cualquier lider de comunidad en cualquier momento.
- **RF_06 (estado):** **Mientras** el enlace de un lider este revocado o su cuenta desactivada, el
  sistema MUST impedir altas nuevas por ese enlace y MUST NOT alterar en nada las tiendas ya
  registradas ni su cashback ya causado.

### 3.2 Alta de tiendas por referido

- **RF_07 (evento):** **Cuando** una tienda complete el registro desde el enlace de un lider de
  comunidad, el sistema MUST crear su cuenta con acceso inmediato, sin aprobacion previa de nadie, y
  MUST adscribirla a la comunidad de ese lider.
- **RF_43 (ubicua):** El formulario de registro por enlace MUST pedir exactamente cinco datos: correo,
  contrasena, nombre del responsable, telefono de contacto y nombre de la tienda. MUST NOT pedir nada
  mas: cada campo extra en un formulario abierto en un movil es una tienda que no se registra.
- **RF_44 (estado):** **Mientras** una tienda registrada no tenga ciudad, punto de recogida y cuenta
  bancaria, el sistema MUST dejarla entrar y moverse por la aplicacion, y MUST impedir que se cree
  ningun pedido suyo, diciendo con claridad que falta y donde completarlo. Sin esos datos no se puede
  recoger la mercancia ni pagarle.
- **RF_45 (error):** **Si** el registro se interrumpe despues de crear el acceso y antes de dejar la
  tienda creada, el sistema MUST NOT dejar una cuenta a medias: o queda todo, o no queda nada y el
  correo MUST quedar libre para reintentar.
- **RF_08 (evento):** **Cuando** una tienda quede adscrita a una comunidad, el sistema MUST dejar
  registrado de forma permanente por que enlace entro y en que momento.
- **RF_09 (error):** **Si** el enlace no existe, esta revocado o pertenece a un lider desactivado, el
  sistema MUST rechazar el registro sin crear ninguna cuenta y MUST indicar que pida un enlace
  vigente a quien lo invito.
- **RF_10 (error):** **Si** el correo del registro ya pertenece a una cuenta de la plataforma, el
  sistema MUST rechazar el alta indicando que inicie sesion, MUST NOT modificar la cuenta existente y
  MUST NOT revelar a que comunidad pertenece.
- **RF_11 (estado):** **Mientras** una tienda pertenezca a una comunidad, el sistema MUST impedir que
  ella misma o su lider la cambien de comunidad; solo un administrador MAY reasignarla, y esa
  reasignacion MUST NOT mover el cashback ya causado por el lider anterior. Los pedidos creados a
  partir de la reasignacion MUST tomar el precio de la comunidad nueva; los ya creados conservan el
  suyo (RF_21).
- **RF_12 (ubicua):** El sistema MUST conservar la via actual de alta manual por administrador, y una
  tienda creada asi MUST quedar sin comunidad hasta que un administrador diga lo contrario.
- **RF_13 (evento):** **Cuando** un mismo enlace supere diez altas en una hora deslizante, el sistema
  MUST avisarlo en el panel del administrador y MUST marcar esas altas como captacion masiva
  pendiente de revision, y MUST NOT rechazar ni bloquear ninguna de ellas: el alta sigue siendo
  automatica por decision de negocio.
- **RF_41 (ubicua):** El sistema MUST permitir al administrador revocar un enlace y desactivar en
  bloque las cuentas creadas por ese enlace dentro de un rango de fechas que el elija. Sin tope
  automatico, esta limpieza es el unico remedio ante un enlace filtrado, y por eso MUST existir.
- **RF_42 (evento):** **Cuando** el administrador desactive cuentas en bloque, el sistema MUST
  conservar sus pedidos y su historial de dinero intacto, y MUST NOT borrar nada.

### 3.3 Marca del lider

- **RF_53 (ubicua):** El sistema MUST permitir al administrador descartar un aviso de captacion
  masiva sin desactivar ninguna cuenta: un lider que capta en un evento dispara el aviso sin hacer
  nada malo.
- **RF_14 (opcion):** **Donde** el lider de comunidad haya cargado un logo, el sistema MUST mostrarlo
  en la pantalla de registro de su enlace y en el panel de las tiendas de su comunidad, en lugar del
  logo de la plataforma.
- **RF_15 (opcion):** **Donde** el lider no haya cargado logo, el sistema MUST mostrar la marca de la
  plataforma, sin huecos ni imagenes rotas.
- **RF_16 (error):** **Si** el archivo de logo excede el tamano admitido o no es un formato de imagen
  soportado, el sistema MUST rechazarlo indicando el limite concreto y MUST conservar el logo
  anterior.

### 3.4 Tarifas y cashback

- **RF_17 (ubicua):** El sistema MUST mantener una tarifa base por cada concepto que se le cobra a la
  tienda —flete de pedido entregado, flete de pedido fallido cobrable y manejo—, definida por el
  administrador. Esa base es lo que cobra Kentro y es el piso de cualquier precio de comunidad.
- **RF_18 (ubicua):** El sistema MUST permitir al lider de comunidad fijar, para las tiendas de su
  comunidad, un precio final por cada uno de esos conceptos, igual o superior a la base vigente.
- **RF_19 (error):** **Si** el lider intenta fijar un precio por debajo de la base vigente, el sistema
  MUST rechazar el cambio, explicar cual es el minimo y MUST conservar el precio anterior.
- **RF_20 (estado):** **Mientras** un lider no haya fijado precio propio para un concepto, el sistema
  MUST cobrar a sus tiendas la base vigente y el cashback de ese concepto MUST ser cero.
- **RF_35 (evento):** **Cuando** el administrador suba una tarifa base por encima del precio que un
  lider ya tenia fijado, el sistema MUST elevar automaticamente el precio de ese lider hasta la nueva
  base, MUST dejar en cero su cashback de ese concepto hasta que el lo suba, y MUST notificarselo.
- **RF_36 (ubicua):** El sistema MUST NOT causar nunca un cashback negativo, ni cobrar a una tienda
  por debajo de la base vigente, sea cual sea el orden en que cambien la base y el precio del lider.

- **RF_21 (evento):** **Cuando** un pedido de una tienda de la comunidad se cree o se importe, el
  sistema MUST guardar junto al pedido el precio final de esa comunidad y la base vigente en ese
  instante. Ese es el unico momento en que se fija el precio de un pedido.
- **RF_22 (evento):** **Cuando** el pedido genere cobro a la tienda, el sistema MUST cobrar el precio
  guardado en el pedido y MUST causar como cashback la diferencia entre ese precio guardado y esa
  base guardada, aunque la base o el precio del lider hayan cambiado entretanto.
- **RF_37 (error):** **Si** un pedido llega al cobro sin precio guardado —creado antes de existir su
  comunidad, o importado sin ella—, el sistema MUST cobrar la base vigente al cierre y MUST NOT
  causar cashback, en lugar de adivinar un precio.
- **RF_23 (estado):** **Mientras** un pedido no genere cobro a la tienda —fallido no cobrable, anulado
  o aun abierto—, el sistema MUST NOT causar cashback por el.
- **RF_24 (evento):** **Cuando** se corrija administrativamente un pedido cuyo cashback ya fue
  liquidado y pagado, el sistema MUST compensarlo con un movimiento de signo contrario en el periodo
  abierto, y MUST NOT reescribir el corte ya pagado.
- **RF_25 (evento):** **Cuando** se corrija un pedido cuyo cashback esta en un corte todavia
  pendiente, el sistema MUST recalcular ese corte en lugar de compensarlo.
- **RF_26 (ubicua):** El sistema MUST pagar el cashback por el mismo mecanismo de cortes y
  liquidaciones con el que ya se paga a los demas participantes, con la misma periodicidad, y MUST
  dejarlo trazable pedido a pedido.
- **RF_49 (evento):** **Cuando** el administrador marque como pagado un corte de un lider, el sistema
  MUST pasar ese cashback de causado a pagado; **mientras** no lo marque, MUST seguir mostrandose
  como causado y pendiente. Nadie mas MAY marcar un cashback como pagado.
- **RF_27 (ubicua):** El lider de comunidad MUST NOT poder modificar el pago al lider logistico, el
  pago al mensajero, el costo de producto ni ninguna tarifa de una tienda ajena a su comunidad.
- **RF_28 (evento):** **Cuando** el lider **suba** un precio, el sistema MUST programarlo con ocho
  dias de antelacion: MUST mostrarlo de inmediato a las tiendas afectadas junto con la fecha exacta
  en que entra, y MUST aplicarlo solo a los pedidos creados a partir de esa fecha.
- **RF_38 (evento):** **Cuando** el lider **baje** un precio, el sistema MUST aplicarlo de inmediato a
  los pedidos nuevos, sin espera: una rebaja no perjudica a la tienda.
- **RF_54 (estado):** **Mientras** exista una subida programada para un concepto, el sistema MUST
  admitir solo una: programar otra MUST reemplazar la anterior y MUST reiniciar los ocho dias.
- **RF_39 (ubicua):** El sistema MUST registrar de todo cambio de precio quien lo hizo, cuando, de
  cuanto a cuanto y desde cuando aplica, y MUST conservar ese historial aunque el lider se desactive.
- **RF_40 (estado):** **Mientras** haya una subida de precio programada y sin entrar en vigor, el
  sistema MUST mostrarla tanto al lider como a sus tiendas, y el lider MAY cancelarla o rebajarla
  antes de la fecha. La elevacion forzosa al piso de RF_35 es la unica subida exenta de los ocho
  dias, porque de lo contrario Kentro cobraria por debajo de su costo durante ese plazo.

### 3.5 Lo que ve el lider

- **RF_29 (ubicua):** El sistema MUST mostrar al lider de comunidad, para un periodo que el elige,
  las cifras agregadas de su comunidad: tiendas activas, pedidos creados, despachados, entregados y
  fallidos, porcentaje de entrega y cashback causado y pagado.
- **RF_46 (ubicua):** El sistema MUST agrupar los pedidos creados por su fecha de creacion, y los
  entregados, fallidos y el cashback por su fecha de cierre, y MUST rotular en pantalla que fecha usa
  cada bloque. Mezclar ejes en silencio es una desviacion de cifras ya vista en esta plataforma.
- **RF_47 (ubicua):** El sistema MUST considerar tienda activa a la que tenga al menos un pedido
  creado dentro del periodo consultado, y MUST mostrar aparte cuantas tiendas de la comunidad no
  llegan a ese minimo, para que el lider vea quien dejo de vender.
- **RF_48 (ubicua):** El sistema MUST calcular el porcentaje de entrega como entregados sobre pedidos
  cerrados del periodo, MUST excluir los pedidos aun abiertos del denominador y MUST mostrar el
  denominador junto al porcentaje.
- **RF_30 (ubicua):** El sistema MUST mostrar esas mismas cifras desglosadas **por cada tienda** de la
  comunidad, para que el lider sepa como va cada miembro.
- **RF_31 (ubicua):** El sistema MUST NOT dar al lider de comunidad acceso al detalle de un pedido, a
  los datos del cliente final, ni al saldo, deuda o recaudo en efectivo de sus tiendas.
- **RF_52 (ubicua):** El sistema MUST NOT permitir a un lider de comunidad ver, ni siquiera de forma
  agregada, dato alguno de tiendas que no pertenezcan a su comunidad, ni de otras comunidades, ni de
  la plataforma en conjunto.
- **RF_32 (estado):** **Mientras** la comunidad no tenga ninguna tienda, el sistema MUST mostrar las
  cifras en cero junto con el enlace de invitacion, en vez de una pantalla vacia o un error.
- **RF_33 (error):** **Si** el lider pide un periodo sin datos o invalido, el sistema MUST distinguir
  en pantalla entre "cero real" y "sin datos para este periodo", y MUST NOT presentar una cifra
  parcial como si fuera completa.
- **RF_34 (ubicua):** El sistema MUST permitir al administrador ver la lista de comunidades, sus
  lideres, sus precios vigentes y el cashback causado por cada uno.

## 4. Requisitos no funcionales

- **RNF_01:** Las cifras del panel del lider MUST calcularse sin que el navegador descargue los
  pedidos de la comunidad. Medible con el procedimiento ya establecido en la documentacion de
  rendimiento de la plataforma: con 20 tiendas y 10.000 pedidos en el periodo, el numero de
  documentos que baja el navegador MUST ser independiente del numero de pedidos —se compara la cuenta
  con 100 y con 10.000 pedidos y MUST ser la misma— y el tiempo hasta ver cifras MUST mantenerse
  dentro del presupuesto de carga por rol vigente, medido en el mismo perfil de red que usan las
  mediciones ya registradas.
- **RNF_02:** El cashback MUST calcularse en el mismo punto y con la misma fuente que el resto del
  dinero de un pedido. MUST NOT existir una segunda formula que pueda quedar rancia.
- **RNF_03:** La pantalla publica de registro MUST funcionar en los navegadores que la plataforma ya
  soporta, incluido iOS 14, y MUST ser usable en movil, que es donde se abrira un enlace compartido.
- **RNF_04:** El precio que paga cada tienda MUST ser consultable por ella misma en cualquier momento;
  ninguna tienda MUST descubrir su tarifa solo al recibir el cobro.
- **RNF_05:** La interfaz nueva MUST seguir el sistema de diseno vigente de la plataforma, con la
  unica salvedad del logo del lider donde corresponda.

## 5. Casos limite

- **Enlace reenviado a quien no debia.** Al no haber aprobacion NI tope de altas, cualquiera con el
  enlace crea cuentas operativas y el sistema solo avisa (RF_13). Es el riesgo aceptado a conciencia
  de este diseno: la contencion es posterior y manual —revocar el enlace y desactivar en bloque
  (RF_05, RF_41)—, no preventiva. Si aparecen cuentas basura en produccion, la decision a revisar es
  esta, no la implementacion.
- **Aviso de captacion masiva con altas legitimas.** Un lider que capta en una charla dispara el
  aviso sin hacer nada malo: se descarta sin desactivar a nadie (RF_53).
- **Segundo registro con el mismo correo.** Rechazo limpio, sin tocar la cuenta existente (RF_10).
- **Registro a medias.** Cubierto por RF_45: o queda todo o no queda nada, y el correo vuelve a estar
  libre. Nunca una cuenta que entra a una pantalla rota.
- **Tienda que se registra y nunca completa sus datos operativos.** Puede entrar pero no genera
  pedidos (RF_44); cuenta como miembro de la comunidad pero no como tienda activa.
- **El lider sube el precio a mitad de semana.** Los pedidos ya creados conservan el precio con el
  que entraron, incluso los que sigan abiertos; solo los creados a partir del cambio toman el nuevo
  (RF_21). Un mismo corte puede contener pedidos con dos precios distintos, y eso es correcto.
- **Pedido creado antes de que su tienda entrara a la comunidad.** Se cobra la base y no causa
  cashback (RF_37): la comunidad no puede cobrar retroactivamente por pedidos que no trajo.
- **Subida de base con pedidos ya creados y aun abiertos.** Esos pedidos conservan la base guardada
  al crearse, asi que ni su cobro ni su cashback cambian; RF_35 solo afecta a los pedidos nuevos.
- **El administrador sube la base por encima del precio del lider.** El precio del lider sube solo
  hasta el nuevo piso y su cashback de ese concepto queda en cero, con aviso al lider (RF_35). Kentro
  nunca cobra por debajo de su costo y la operacion no se detiene por una negociacion pendiente.
- **Pedido entregado y luego corregido a fallido no cobrable** despues de pagado el corte: el
  cashback se compensa en el periodo abierto (RF_24), nunca reescribiendo lo pagado.
- **Tienda que cambia de comunidad.** El cashback historico se queda con el lider que lo causo
  (RF_11).
- **Lider desactivado con cashback pendiente.** Sus tiendas siguen operando y el cashback pendiente
  sigue siendo una deuda de la plataforma (RF_51).
- **Nombre corto cambiado.** El enlace viejo sigue vivo treinta dias (RF_03); pasados esos, cae en
  el mismo rechazo que un enlace inexistente.
- **Logo enorme o corrupto.** Se rechaza y se conserva el anterior (RF_16); nunca una pantalla de
  registro con la imagen rota.
- **Subida programada que se cruza con la salida de una tienda.** Si la tienda deja la comunidad
  antes de la fecha de entrada, la subida no la alcanza.
- **Dos subidas programadas encadenadas.** Solo puede haber una programada por concepto: la segunda
  reemplaza a la primera y reinicia los ocho dias (RF_54).
- **Comunidad con una sola tienda que no vende.** Cifras en cero, no error.
- **Periodo a caballo entre dos meses.** Un pedido creado en agosto y cerrado en septiembre suma en
  "creados" de agosto y en "entregados" y cashback de septiembre. Es correcto y el rotulo de RF_46 lo
  hace evidente en vez de esconderlo.
- **Tienda que entra a mitad del periodo.** Solo cuenta desde que se adscribio; las cifras anteriores
  a su ingreso no son de esa comunidad.
- **Dos lideres con el mismo nombre comercial.** Los nombres cortos son unicos; los nombres visibles
  no tienen por que serlo.

## 6. Fuera de alcance

- **Subdominio o dominio propio del lider.** Aqui solo hay enlace de registro con nombre corto y
  logo. La marca blanca real se vera en una spec futura si el negocio la pide.
- **Que el lider vea el detalle de un pedido o los datos del cliente final.** Excluido a proposito.
- **Que el lider cree lideres logisticos, mensajeros u otros lideres de comunidad.** Solo tiendas.
- **Comunidades anidadas o multinivel** (un lider que gana por lo que traen sus lideres). No se
  contempla ninguna estructura de referidos por niveles.
- **Pago del cashback por fuera del sistema de cortes** (transferencias automaticas, pasarelas).
- **Que el lider toque el costo de producto o los pagos a la operacion logistica.**
- **Registro de tiendas sin enlace de lider** desde una pagina publica general.
- **Verificacion de correo o telefono en el registro.** Se decidio pedir cinco campos y ninguna
  comprobacion (RF_43): anadirla despues es un cambio de alcance, no un detalle de implementacion.
- **Tope automatico de altas por enlace.** Descartado a favor de aviso y limpieza posterior
  (RF_13, RF_41). Queda anotado para poder revisarlo si aparecen cuentas basura.

## 7. Definition of Done

1. Cada RF_01 a RF_54 tiene al menos una prueba automatizada que pasa, nombrada de forma que se
   pueda rastrear al requisito. Los numeros no son contiguos por posicion: los requisitos anadidos en
   el escrutinio conservan su numero original a proposito, para que una prueba nunca cambie de
   requisito al reordenar el documento.
2. La aritmetica del cashback esta atada por pruebas a la misma fuente que el resto del dinero del
   pedido, incluyendo los dos caminos de correccion: corte pagado (compensacion) y corte pendiente
   (recalculo).
3. `npm test`, `npx tsc --noEmit` en raiz y en el backend, y `npm run lint` sin errores.
4. Medida y registrada la carga del panel del lider segun RNF_01, con la cifra real anotada en la
   documentacion de rendimiento.
5. Evidencia funcional capturada por cada historia de usuario, incluido el registro completo desde
   un enlace en un movil.
6. Verificado que ninguna cifra de dinero existente cambia para tiendas sin comunidad.
7. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-08 | Borrador inicial | Necesidad de crecer sin que el administrador cree cada tienda |
| 2026-09-08 | Escrutinio adversarial: RF_35 a RF_49 | Seis huecos detectados en contexto limpio: subida de base, instante del precio, aviso de subida, tope de altas, datos de registro y ejes de fecha |
| 2026-09-08 | Aprobada por el humano | Escrutinio cerrado sin preguntas pendientes |
| 2026-09-08 | Cierre de completitud: RF_50 a RF_54 | Faltaba quien crea al lider, el aislamiento entre comunidades y tres MUST sueltos en casos limite sin requisito al que atarse |
