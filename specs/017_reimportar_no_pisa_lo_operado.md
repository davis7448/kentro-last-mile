# Spec 017: Volver a importar un pedido no puede borrar lo que ya paso en la calle

- **Estado:** aprobada (2026-09-17)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Prioridad:** alta — nace de un incidente en produccion que dejo a un mensajero sin poder entregar y
  descuadro el efectivo pendiente de un lider sin avisar a nadie

## 1. Contexto y objetivo

La plataforma puede volver a traer pedidos de una tienda conectada por un rango de fechas. Se usa para
rellenar huecos: cuando la tienda dejo de avisar de pedidos nuevos, se reimporta ese periodo y los pedidos
que faltaban aparecen. Es una herramienta de rescate y funciona.

El problema es que esa reimportacion no distingue entre un pedido que **no existia** y uno que **ya existe y
ya se opero**. A los dos les escribe lo mismo, como si acabaran de llegar de la tienda. Un pedido que ya tiene
un lider asignado, una direccion corregida por telefono y un precio de comunidad congelado, vuelve a quedar
como recien importado en todo lo que la tienda no sabe.

El 15 de septiembre de 2026, entre las 16:36 y las 16:39, una reimportacion dejo **34 pedidos sin lider**: 26
ya entregados, 5 recogidos, 2 fallidos y 1 en ruta. Lo que se vio fue lo de menos: el mensajero del pedido
KNT-004747 abrio la app y ya no tenia con que subir la foto ni con que marcar la entrega, porque esos
controles solo aparecen cuando el pedido tiene lider. Llamo, y por eso nos enteramos.

Lo que no se vio es lo grave. El saldo pendiente y el corte de un lider se construyen a partir de los pedidos
que son suyos; 26 entregas en efectivo que dejaron de serlo salen de su saldo **sin ningun error y sin ningun
aviso**, exactamente el fallo silencioso que el principio 8 de la constitucion describe. Y los 5 pedidos ya
recogidos desaparecieron de su pantalla: mercancia en la calle que la plataforma ya no le atribuia a nadie.

En el mismo movimiento se reescribieron la direccion, el nombre y el telefono del cliente con lo que dice la
tienda —perdiendo las correcciones hechas al confirmar por WhatsApp—, la direccion volvio a quedar marcada como
pendiente de revisar, y el precio de comunidad se volvio a sellar con el del dia, no con el del dia en que el
pedido nacio.

Los datos del incidente ya se repararon a mano. Esta spec existe para que no vuelva a pasar.

**Objetivo:** que reimportar un periodo actualice lo que la tienda sabe de un pedido y **no toque nada de lo
que la plataforma aprendio despues**.

## 2. Historias de usuario

- **Como** mensajero **quiero** que un pedido que llevo en la mano siga siendo mio pase lo que pase en la
  oficina **para** poder entregarlo y subir la evidencia cuando llego a la puerta del cliente.
- **Como** lider logistico **quiero** que mis pedidos entregados sigan contando en lo que se me debe **para**
  que mi corte no baje sin que nadie me diga por que.
- **Como** responsable de la plataforma **quiero** poder reimportar un periodo sin miedo **para** rescatar
  pedidos perdidos sin romper la operacion del dia.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** una reimportacion encuentre un pedido que ya existe en la plataforma, el
  sistema MUST conservar intactos su lider asignado, su mensajero asignado y su lote de recogida.
- **RF_02 (estado):** **Mientras** un pedido que ya existe haya salido de "importado sin confirmar" —esto es,
  en cuanto alguien hablo con el cliente o el pedido entro en la operacion—, el sistema MUST conservar la
  direccion de entrega, el nombre y el telefono del cliente tal como los tiene la plataforma, porque pueden
  haber sido corregidos al confirmar y la tienda no se entera de esa correccion. Se conserva con ellos
  **todo lo que se derivo de esa direccion** —su version normalizada, sus coordenadas y de que servicio
  salieron—: refrescar la direccion de la tienda dejando la geocodificacion de la corregida, o al reves,
  dejaria el pedido apuntando a dos sitios a la vez.
- **RF_03 (estado):** **Mientras** un pedido siga importado, sin confirmar **y sin editar a mano**, el
  sistema MUST refrescar la direccion, el nombre y el telefono con lo que diga la tienda: ahi la tienda sigue
  siendo la fuente de verdad porque nadie ha tocado ese pedido todavia. Son **dos** senales del pedido y solo
  dos —su estado y si fue editado—, y MUST seguir siendo asi: la decision nunca depende de recordar que campo
  toco cada cual (ver RF_17).
- **RF_04 (evento):** **Cuando** una reimportacion encuentre un pedido que ya existe, el sistema MUST conservar
  el resultado de la revision de su direccion, y MUST NOT devolverlo a "pendiente de revisar" si ya estaba
  revisado.
- **RF_05 (evento):** **Cuando** una reimportacion encuentre un pedido que ya existe **y ese pedido ya tenga
  sello de comunidad**, el sistema MUST conservar el precio de comunidad y la comunidad con los que nacio, sin
  volver a sellarlos con los del dia.
- **RF_06 (evento):** **Cuando** una reimportacion encuentre un pedido que ya existe, **no** tenga sello de
  comunidad y siga abierto, el sistema MAY sellarlo con el que corresponda a su tienda en ese momento. Un
  pedido sin sello no tiene ningun precio congelado que proteger, y esta es la unica via para reparar los
  pedidos que nacieron sin sello cuando la tienda si tenia comunidad.
- **RF_07 (si):** **Si** el pedido ya esta cerrado, el sistema MUST NOT sellarlo aunque no tenga sello: su
  dinero ya se calculo sin comunidad, y ponerle una ahora cambiaria lo que se le debe a un lider por un pedido
  ya liquidado (principio 10).
- **RF_08 (estado):** **Mientras** un pedido que ya existe siga abierto —no entregado, fallido, anulado ni
  liquidado— **y nadie lo haya editado a mano**, el sistema MUST seguir actualizando lo que la tienda es la
  fuente de verdad: los productos del pedido, sus cantidades y su valor total. Si fue editado, manda RF_17.
- **RF_09 (estado):** **Mientras** un pedido este cerrado —entregado, fallido, anulado o liquidado—, el sistema
  MUST conservar sus productos, cantidades y valor total tal como quedaron al cerrarse, y ninguna reimportacion
  MUST poder cambiarlos. Un pedido cerrado congela sus productos igual que congela su dinero: el costo ya se
  calculo sobre ellos, y cambiarlos despues solo puede descuadrar un corte ya hecho (principio 10).
- **RF_10 (evento):** **Cuando** una reimportacion encuentre un pedido que **no** existe, el sistema MUST
  crearlo exactamente como lo crea hoy, sin cambio alguno de comportamiento.
- **RF_11 (ubicua):** El sistema MUST conservar, como ya hace hoy, el estado del pedido, su evidencia, su
  fecha de creacion y su codigo de seguimiento.
- **RF_12 (estado):** **Mientras** un pedido este asignado a un lider, ninguna importacion automatica o manual
  procedente de la tienda MUST poder dejarlo sin lider. Quitar el lider es una decision de la operacion, y
  para eso ya existen sus propios caminos.
- **RF_13 (evento):** **Cuando** termine una reimportacion, el sistema MUST dejar un resumen unico de esa
  corrida con: cuantos pedidos ya existian, cuantos datos protegidos se conservaron, de que tipo (lider,
  cliente, revision de direccion, precio de comunidad, productos congelados, procedencia y datos de
  entrega) y los codigos de seguimiento de los pedidos afectados. Un resumen por corrida, nunca uno por
  pedido: el historial que ve el responsable trae solo los ultimos eventos, y miles de constancias
  desplazarian todo lo demas. **Los recuentos MUST ser exactos siempre**; la lista de codigos MAY recortarse
  a partir de un tope, y entonces el resumen MUST decir que esta recortada. Un resumen que miente por omision
  es peor que no tenerlo.
- **RF_14 (si):** **Si** el dato que llega de la tienda es identico al que ya tiene la plataforma, el sistema
  MUST NOT contarlo como dato conservado en el resumen de RF_13: solo se cuenta lo que de verdad se iba a
  pisar. Asi el resumen de una corrida sin novedades sale en cero y el responsable puede fiarse de que un
  numero distinto de cero significa algo.
  **El precio de comunidad se compara por sus importes, no por cuando se sello**: el sello lleva dentro la
  fecha en que se calculo, que cambia en cada corrida aunque los precios sean identicos. Compararlo entero
  haria que TODOS los pedidos con sello contaran como afectados siempre, y el resumen dejaria de distinguir
  nada. **La procedencia es la otra excepcion y va en su propio recuento**, fuera de los pedidos "afectados": un pedido
  que nacio por el aviso automatico y se vuelve a ver en una reimportacion por rango SIEMPRE llega con una
  procedencia distinta, sin que eso sea ninguna novedad. Si contara como afectacion, la via normal de las
  tiendas grandes haria que cada corrida listara miles de pedidos y el resumen no distinguiria nada.
- **RF_15 (estado):** **Mientras** un pedido que ya existe haya salido de "importado sin confirmar", el
  sistema MUST conservar su punto y direccion de recogida, su forma de pago y su modo de entrega. Esos
  cuatro deciden cuanto efectivo hay que cobrar y con que guia salio el mensajero: cambiarlos con el pedido
  ya en la calle descuadra el corte o cambia el pedido de flujo sin que nadie lo pida.
- **RF_16 (evento):** **Cuando** una reimportacion encuentre un pedido que ya existe, el sistema MUST
  conservar **por donde entro ese pedido**, en cualquier estado, tambien si sigue sin confirmar. La
  procedencia no es estado, es historia: en el incidente, 34 pedidos nacidos por el aviso automatico pasaron
  a declararse como reimportados, y con eso se perdio para siempre la respuesta a "¿por donde entro esto?".
  Un pedido entra una sola vez, y eso ya ocurrio antes de que la reimportacion llegara.
- **RF_17 (estado):** **Mientras** un pedido **no cerrado** haya sido **editado a mano** por alguien de la
  tienda o del equipo —siga sin confirmar o ya se haya confirmado despues—, el sistema MUST tratarlo como ya trabajado y conservar **todo lo que esa edicion
  pudo tocar**: los datos del cliente, la direccion, las condiciones de entrega **y los productos, cantidades
  y valor total**. El valor total es dinero, y es editable a mano en un pedido sin confirmar: dejar que una
  reimportacion lo pise seria la perdida silenciosa mas cara de todas. La marca vale **hasta que el pedido
  se cierre**, no hasta que se confirme: editar y confirmar despues es el flujo normal, y si la marca dejara
  de contar al confirmar, la correccion de la manana se perderia con la reimportacion de la tarde, un estado
  mas tarde y con el mismo silencio. La plataforma
  permite corregir un pedido antes de confirmarlo, asi que "sigue importado" NO garantiza que nadie lo haya
  tocado; sin esta regla, un logistico corrige una direccion por la manana y la reimportacion de la tarde se
  la lleva **sin error y sin aviso**, y ni siquiera aparece en el resumen, porque a un pedido sin confirmar
  se le refrescan esos datos a proposito. La marca de "esto ya se edito" MUST ponerla el servidor al guardar
  **cualquier** edicion manual de campos protegidos —hoy son dos: la correccion de un pedido sin confirmar
  y el ajuste administrativo de producto y recaudo, que puede hacerse con el pedido ya en la calle—: una
  sola senal por pedido, no memoria de que campo toco cada cual.

- **RF_18 (evento):** **Cuando** el sistema refresque la direccion de un pedido sin confirmar (RF_03), MUST
  descartar tambien lo que se habia derivado de la direccion anterior —su version normalizada, sus
  coordenadas y de que servicio salieron—, de modo que vuelva a calcularse a partir de la direccion nueva.
  Ninguna importacion trae esos datos derivados: si se refresca la direccion y se dejan los de antes, el
  pedido apunta a dos sitios a la vez, que es justo lo que RF_02 declara inaceptable. Descartarlos es seguro
  porque se regeneran solos al validar la direccion; conservarlos, no.

- **RF_19 (evento):** **Cuando** esta funcionalidad entre en produccion, el sistema MUST marcar como ya
  editados los pedidos **no cerrados que alguien edito a mano antes**, reconstruyendolo del historial de
  auditoria, que ya guarda esas ediciones. Sin ese relleno, el arreglo empeoraria las cosas el primer dia:
  un pedido corregido la semana pasada no tiene marca, caeria del lado de "nadie lo ha tocado" y perderia su
  direccion corregida en la primera reimportacion — una perdida silenciosa causada por el propio arreglo,
  sobre pedidos que existen el dia del despliegue. La decision de que pedidos marcar MUST ser una funcion
  probable sin red, separada del guion que escribe: el DoD exige prueba automatizada para cada requisito, y
  "lo corri y parecio bien" no lo es. La marca MUST llevar **la fecha de la edicion**, no la del relleno.

## 4. Requisitos no funcionales

- **RNF_01:** Las reglas de RF_01 a RF_12 y RF_15 a RF_18 MUST vivir en un unico sitio, comun a **todas** las
  vias por las que un pedido entra desde fuera, y no repetidas en cada una: hoy hay seis vias y esa duplicidad
  es precisamente lo que permite que una se olvide. Las vias que MUST quedar cubiertas son la reimportacion por
  rango de fechas, la importacion manual de un pedido, el aviso automatico de Shopify, el aviso automatico de
  una tienda conectada, el de OnStock y el formulario de contacto. Quedan **exentas a proposito** las dos
  puertas de la confirmacion por ChatBy —la consulta programada y el webhook entrante, que hacen el mismo
  trabajo— porque lo suyo es justamente corregir la direccion con lo que dice el cliente, y esa es la
  correccion que el resto debe respetar; y **todas las escrituras de pedidos que hace la
  propia operacion** —el alta manual, las transiciones de ciclo de vida y la edicion de un pedido sin
  confirmar—: ninguna importa nada de fuera, todas nacen de que una persona de la plataforma decide algo. Cada exencion MUST quedar escrita donde vive la regla,
  con su razon, para que no parezca un olvido. Exenta tambien la **correccion administrativa de estados
  terminales**: reescribe pedidos ya cerrados a proposito y por decision de una persona, con su propia
  spec y sus propias salvaguardas, y no importa nada de fuera.
- **RNF_02:** La comprobacion MUST ejecutarse sin red en cada cambio, y MUST fallar si alguien vuelve a
  escribir un pedido existente pisando un dato protegido.
- **RNF_03:** El incidente y su regla MUST quedar escritos en la constitucion del proyecto, para que nadie
  revierta esto sin saber lo que costo.

## 5. Casos limite

- **Un pedido ya entregado o fallido.** Es el caso mas comun del incidente (28 de 34). Sus datos protegidos
  MUST quedar igual, porque de ellos cuelga dinero ya calculado.
- **Un pedido abierto y sin sello de comunidad cuya tienda SI tiene comunidad.** Se sella (RF_06). Es el
  unico dato protegido que una reimportacion puede rellenar, y solo porque estaba vacio.
- **Un pedido con un sello EQUIVOCADO** (tiene comunidad, pero no la que debia). La reimportacion no lo
  corrige (RF_05) y hoy **no existe ningun camino** para corregirlo. Queda declarado como hueco conocido: si
  aparece un caso real, necesita su propia spec, no un parche por esta via.
- **Un pedido anulado que la tienda vuelve a enviar.** No debe resucitar: el estado se conserva (RF_11).
- **Un pedido sin confirmar que alguien ya edito a mano.** Cae del lado de conservar (RF_17), no del de
  refrescar: el estado dice "sin confirmar", pero la edicion dice "ya trabajado", y manda la edicion.
- **Un pedido importado, sin confirmar y que nadie ha editado.** Aqui reimportar SI debe
  refrescar la direccion y los datos del cliente (RF_03): no hay nada que la plataforma sepa mejor que la
  tienda. La frontera es el estado del pedido y va escrita en la prueba, con un caso a cada lado.
- **Un pedido confirmado por el bot de WhatsApp al que nadie corrigio la direccion a mano.** Cae del lado de
  conservar (RF_02): ya salio de "importado sin confirmar", y la confirmacion misma sincroniza la direccion.
  No se distingue "editado por una persona" de "editado por el bot": la senal es el estado, no quien escribio.
- **La misma reimportacion corrida dos veces seguidas.** La segunda MUST NOT cambiar ningun dato de ningun
  pedido respecto de la primera. Dos excepciones, ambas deliberadas: el resumen de RF_13, que es el registro
  de que la corrida ocurrio y no un cambio en los pedidos; y la marca de "ultima vez que se toco" del pedido,
  que se refresca en cada corrida. **El dinero no la usa** —se calcula sobre la fecha de cierre—, pero si es
  el eje de fecha **de respaldo** cuando a un pedido le falta la de creacion: ahi ordena y filtra pantallas.
  La excepcion se sostiene porque la reimportacion conserva siempre la fecha de creacion, asi que ningun
  pedido que la tenga se mueve de dia. Un pedido que YA hubiera perdido su fecha de creacion saltaria al dia
  de la corrida en cada reimportacion: si aparece un caso asi, esta excepcion hay que revisarla.
- **Un pedido ABIERTO cuyos productos si cambiaron en la tienda** (el cliente anadio un articulo). Los
  productos se actualizan (RF_08) aunque el pedido ya este asignado a un lider; lo que no se toca es a quien
  pertenece.
- **Un pedido CERRADO cuyos productos cambian en la tienda despues del cierre.** No se tocan (RF_09). Decidido
  el 2026-09-17: el pedido congela sus productos al cerrarse, igual que congela su dinero.
- **Un pedido que se cierra entre dos reimportaciones.** La primera actualizo sus productos y la segunda ya no
  puede: la frontera es el estado en el momento de escribir, no el del inicio de la reimportacion.

## 6. Fuera de alcance

- Reparar los 34 pedidos del incidente: ya esta hecho, fuera del ciclo, con su rastro de auditoria.
- Cambiar como se asigna o se reasigna un lider: esta spec solo impide que una importacion lo borre.
- La alerta al responsable (spec 010) y la constancia de RF_13 comparten proposito, pero aqui solo se exige
  dejar el rastro, no construir el aviso.
- ~~El resto de datos que la reimportacion reescribe y que nadie ha reclamado~~: decidido el 2026-09-17, ya no
  esta fuera de alcance. Son RF_15.

## 7. Definition of Done

1. Cada RF tiene al menos una prueba automatizada que pasa.
2. Se reproduce el incidente: un pedido en ruta, con lider y mensajero, pasa por una reimportacion y conserva
   su lider; la prueba falla si se revierte el arreglo (prueba de mutacion).
3. Se reproduce el caso contrario: un pedido nuevo se crea igual que hoy, campo a campo (RF_10).
4. Una reimportacion real sobre un dia ya operado en produccion no cambia ningun dato protegido, comprobado
   pedido a pedido antes y despues, con este procedimiento:
   a. El responsable elige el dia y autoriza la corrida; ningun agente la lanza por su cuenta (principio 7).
   b. **Antes** de correr nada se guarda una copia de todos los pedidos de ese dia. El punto de recuperacion
      de Firestore esta DESACTIVADO —la retencion es de una hora—, asi que esa copia es la unica vuelta
      atras que va a existir. Sin copia, no se corre.
   c. Se reimporta ese dia y se comparan los datos protegidos pedido a pedido.
   d. **Si algun dato protegido cambio**, se restauran los pedidos afectados desde la copia y la spec NO se
      cierra: el arreglo esta incompleto y vuelve a la fase de implementacion.
5. La regla esta escrita en la constitucion con el incidente que la motivo.
6. El humano valido el resultado y aprobo la entrega.

## 8. Decisiones tomadas por el responsable (2026-09-17)

1. **Un pedido cerrado congela tambien sus productos** (RF_09). El dinero ya esta calculado sobre ellos.
2. **La frontera de los datos del cliente es el estado del pedido** (RF_02 / RF_03): se refrescan mientras siga
   importado y sin confirmar, y se conservan en cuanto sale de ahi. No se distingue quien hizo la correccion.
3. **La constancia es un resumen por corrida** (RF_13), no un evento por pedido: el historial del responsable
   trae solo los ultimos eventos y no puede inundarse.
4. **La regla cubre las seis vias de entrada**, con la confirmacion por ChatBy exenta a proposito (RNF_01).
5. **El sello de comunidad se congela si existe, y se rellena solo si esta vacio y el pedido sigue abierto**
   (RF_05, RF_06, RF_07). Un sello equivocado no tiene hoy camino de correccion: queda como hueco declarado.
6. **La validacion contra produccion se hace con copia previa y vuelta atras** (DoD 4), porque el punto de
   recuperacion de Firestore esta desactivado.

7. **Los cinco campos que nadie habia reclamado quedan protegidos**: punto y direccion de recogida, forma
   de pago y modo de entrega (RF_15), y la procedencia (RF_16). Decidido el 2026-09-17, tras el analisis de
   coherencia: estaban propuestos en el plan sin haber pasado por la spec, que es donde se deciden los
   alcances.
8. **La procedencia se conserva tambien en un pedido sin confirmar** (RF_16), a diferencia de los otros
   cuatro. El segundo analisis encontro que spec, plan y pruebas no decian lo mismo en este caso. La razon
   para separarlo: los otros cuatro describen **como se va a entregar** el pedido, y mientras nadie ha hablado
   con el cliente la tienda sigue mandando sobre eso; la procedencia describe **como llego**, y eso ya
   ocurrio — no es un dato que la tienda pueda actualizar, es un hecho pasado.

9. **Las exenciones son cuatro, no una** (RNF_01): las dos puertas de ChatBy, el alta manual de pedido y
   la correccion administrativa de estados terminales. Al leer el codigo aparecieron tres escrituras mas de
   las seis previstas; se examinaron una a una y ninguna importa nada de fuera. Decidido el 2026-09-17, en
   el analisis de coherencia: una exencion que solo viva en el plan o en una prueba es un alcance decidido a
   espaldas de la spec. La lista MUST estar completa antes de escribir la guarda, porque una exencion que
   falte deja la suite en rojo el primer dia sin que nadie haya hecho nada mal.

10. **Un pedido sin confirmar pero ya editado a mano se conserva** (RF_17). Decidido el 2026-09-17, en el
   septimo analisis de coherencia, al descubrir que la plataforma deja editar pedidos mientras siguen sin
   confirmar — con lo que la premisa de RF_03 ("nadie ha hablado aun con el cliente") no se sostenia sola.
   De las tres salidas posibles se descarta declararlo consecuencia conocida (es perdida silenciosa de datos,
   justo lo que la spec combate) y mover el pedido de estado al editarlo (solo se pueden editar los que
   siguen sin confirmar: se volveria imposible editar dos veces). Queda la marca del servidor, que **no**
   contradice a RF_03: la decision sigue siendo por una senal del pedido, no por recordar campo a campo
   quien toco que.

11. **Las dos ediciones manuales sellan, y un pedido sin confirmar con un ajuste de recaudo deja de recibir
   direccion y cliente de la tienda** (RF_17 sobre RF_03). Decidido el 2026-09-17, en el decimo analisis, al
   aparecer una segunda via de edicion manual (el ajuste administrativo) que toca el valor total con el
   pedido ya en la calle. Se elige el lado conservador —ante la duda, la fase que mas conserva—: un pedido
   que alguien ya toco a mano no vuelve a recibir NADA de la tienda, ni siquiera lo que la tienda todavia
   sabria mejor. El coste es que un ajuste de solo recaudo congela tambien la direccion; el beneficio es que
   no hay que decidir campo a campo, que es justo lo que RF_03 prohibe.

12. **Al refrescar la direccion de un pedido sin confirmar se descarta su geocodificacion** (RF_18).
   Decidido el 2026-09-17, en el undecimo analisis: ninguna via de importacion envia la direccion
   normalizada ni las coordenadas, asi que "refrescar la direccion" solo tocaba tres de los siete campos
   del grupo y dejaba los otros cuatro apuntando a la direccion vieja. La alternativa —conservar tambien la
   direccion— se descarto porque deja al pedido sin poder corregirse desde la tienda cuando todavia nadie lo
   ha tocado, que es lo que RF_03 existe para permitir.

13. **La marca se rellena hacia atras desde la auditoria** (RF_19). Decidido el 2026-09-17, en el duodecimo
   analisis. Hoy una reimportacion pisa la direccion cruda pero **no** la corregida, asi que la correccion
   sobrevive; al conservar la direccion cruda y descartar lo derivado (RF_18), un pedido ya corregido pero
   sin marca saldria perdiendo respecto de hoy. El historial de auditoria ya registra las dos ediciones
   manuales, asi que el relleno es posible y acotado: se descarto declarar la consecuencia por escrito
   porque "el arreglo rompe algo que hoy funciona" no es una consecuencia aceptable.

Sigue abierta, fuera de esta spec: **que hacer cuando la tienda SI tiene una direccion nueva y mejor**.
Recomendacion para su propia spec: guardarla aparte y avisar, nunca pisar la que ya se corrigio con el cliente.

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Incidente de reimportacion: 34 pedidos sin lider, un mensajero sin poder entregar y el efectivo pendiente de un lider descuadrado en silencio |
| 2026-09-16 | En pausa | Entra la spec 018 (saldo de tienda) por delante |
| 2026-09-17 | Decimotercer analisis: RF_14 compara el precio de comunidad por importes y no por su fecha de sellado (que cambia en cada corrida y habria marcado todos los pedidos como afectados); RF_19 exige separar la decision probable del guion, y sellar con la fecha de la edicion | Hallazgos H1 y H2 de la decimotercera pasada de `/sdd-analyze` |
| 2026-09-17 | Duodecimo analisis: RF_19 — la marca de edicion se rellena hacia atras desde la auditoria antes de desplegar, o el propio arreglo borraria las direcciones corregidas de los pedidos ya editados | Hallazgo H2 de la duodecima pasada de `/sdd-analyze` |
| 2026-09-17 | Undecimo analisis: RF_18 — refrescar la direccion de un pedido sin confirmar descarta su geocodificacion derivada, que ninguna importacion trae y que si no quedaria apuntando a la direccion vieja | Hallazgo H2 de la undecima pasada de `/sdd-analyze` |
| 2026-09-17 | Decimo analisis (2): el ajuste administrativo de producto y recaudo tambien sella, y RF_17 queda al final de la lista, donde le toca | Hallazgos H1 y nota de orden de la decima pasada de `/sdd-analyze` |
| 2026-09-17 | Decimo analisis: la marca de edicion vale hasta que el pedido se CIERRE, no hasta que se confirme (editar y confirmar despues es el flujo normal, y el catalogo quedaba expuesto un estado mas tarde); RF_03 y RF_08 excluyen explicitamente al pedido editado, que hasta ahora los contradecian | Hallazgos H1, H2 y H3 de la decima pasada de `/sdd-analyze` |
| 2026-09-17 | Noveno analisis: el resumen deja de llamar "productos de un pedido cerrado" a los productos congelados, que desde RF_17 tambien lo estan en un pedido editado a mano | Hallazgo H4 de la novena pasada de `/sdd-analyze` |
| 2026-09-17 | Octavo analisis: RF_17 cubre tambien productos y valor total (editables a mano en un pedido sin confirmar, y el valor total es dinero); RF_14 saca la procedencia del recuento de afectados, porque un pedido nacido por webhook siempre llega con procedencia distinta y eso no es novedad; RNF_01 enumera RF_17 | Hallazgos H1, H4 y H5 de la octava pasada de `/sdd-analyze` |
| 2026-09-17 | Septimo analisis: RF_17 (un pedido sin confirmar ya editado a mano se conserva) y RNF_01 declara que la exencion de las escrituras de la operacion las cubre todas, no solo el alta manual | Hallazgos H1 y H3 de la septima pasada de `/sdd-analyze` |
| 2026-09-17 | Sexto analisis: el caso limite de la doble corrida acota lo que se afirmaba de la marca de "ultima vez tocado" — si es eje de fecha de respaldo cuando falta la de creacion | Hallazgo H4 de la sexta pasada de `/sdd-analyze` |
| 2026-09-17 | Quinto analisis: RF_02 nombra tambien la geocodificacion derivada de la direccion (normalizada, coordenadas y servicio), que el plan ya protegia sin que la spec lo dijera | Hallazgo H6 de la quinta pasada de `/sdd-analyze` |
| 2026-09-17 | Tercer y cuarto analisis: RNF_01 nombra las **cuatro** exenciones (las dos puertas de ChatBy, el alta manual y la correccion administrativa), que hasta ahora vivian en el plan o en ninguna parte | Hallazgos 7 y H2 de las pasadas tercera y cuarta de `/sdd-analyze` |
| 2026-09-17 | Segundo analisis: RF_16 separa la procedencia de las condiciones de entrega (se conserva tambien sin confirmar, porque es un hecho pasado y no un dato que la tienda pueda actualizar); la cabecera pasa a "aprobada" | Hallazgos 1 y 8 de la segunda pasada de `/sdd-analyze` |
| 2026-09-17 | Analisis de coherencia: RF_15 (los cinco campos sueltos pasan a protegidos, decision del responsable que el plan se habia adelantado a tomar), RF_13 acota su lista de codigos, RF_14 corrige una referencia rota a RF_09, y el caso limite de la doble corrida declara la excepcion de la marca de "ultima vez tocado" | Hallazgos 3, 7, 9 y 10 de `/sdd-analyze` |
| 2026-09-17 | Escrutinio adversarial: de 9 a 14 requisitos, todos acotados por el estado del pedido (abierto / cerrado / sin confirmar); la constancia pasa a ser un resumen por corrida; RNF_01 enumera las seis vias y la exencion de ChatBy; DoD 4 gana copia previa y vuelta atras. Requisitos renumerados de corrido | Seis preguntas del revisor en contexto limpio, respondidas por el responsable |
