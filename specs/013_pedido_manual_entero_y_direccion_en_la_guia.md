# Spec 013: El pedido manual se ve entero, y la guia lleva la direccion de verdad

- **Estado:** aprobada (2026-09-15; segunda version tras el escrutinio adversarial de seis preguntas.
  Aprobacion bajo el objetivo del responsable "haz todo el flujo hasta que me entregues el resultado":
  las seis decisiones las tomo el orquestador con la recomendacion escrita y estan marcadas como
  revertibles en la seccion 8)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15

## 1. Contexto y objetivo

Dos fallos en la misma pantalla, la de la tienda, que el responsable vio en produccion el 2026-09-15.

**1. El formulario de pedido manual se ve cortado.** En escritorio, "Crear pedido manual" comparte una fila
con "Solicitudes de liquidacion" y "Movimientos recientes", a un tercio del ancho cada uno. Esa fila se
diseno para verlos **plegados**, una linea cada uno. Al desplegar el formulario, no cabe en un tercio: los
campos quedan recortados por la derecha, el boton de quitar producto aparece fuera de su fila, y hay
controles que no se alcanzan. En telefono es peor: las columnas se apilan, pero las filas internas del
formulario no, y desbordan a lo ancho.

**2. La guia no lleva la direccion.** El formulario tiene dos casillas: "Direccion original" y "Direccion
normalizada (opcional)". Las tiendas escriben la direccion en la primera y **una observacion** en la
segunda ("timbre azul", "preguntar por Marta", "local al fondo"), porque no hay otra casilla para eso. Y la
guia impresa —igual que la tarjeta del pedido en pantalla— muestra la segunda **en lugar de** la primera
cuando existe. Resultado: el mensajero sale con un rotulo que dice "timbre azul" y ninguna direccion.

Hay un tercer hecho que la spec no puede ignorar: "direccion normalizada" no es una observacion. En la
plataforma es la direccion **corregida** para el reparto —la rellena el mensajero al resolverla y la
edita durante la entrega—. La tienda la esta usando para otra cosa porque le falta la casilla que de
verdad necesita. Y como el mensajero, al resolver, conserva lo que ya hubiera en esa casilla, hoy existen
pedidos en los que **no se puede saber** si ese texto es una direccion corregida o una nota de la tienda.
Esta spec no intenta adivinarlo: lo muestra todo, rotulado, y evita que vuelva a pasar.

**Objetivo:** que el pedido manual se cree comodo en cualquier pantalla, que la guia lleve **siempre** la
direccion, y que la observacion tenga su sitio propio sin pisar la direccion corregida.

## 2. Historias de usuario

- **Como** tienda **quiero** crear un pedido manual sin que se me corten los campos, en el computador y en
  el telefono, **para** registrar ventas fuera de Shopify sin pelear con la pantalla.
- **Como** tienda **quiero** dejarle al mensajero una indicacion ("timbre azul", "preguntar por Marta")
  **para** que encuentre al cliente, sin que esa nota sustituya a la direccion.
- **Como** mensajero **quiero** que la guia lleve la direccion completa y, aparte, las indicaciones **para**
  no salir a la calle con una nota en vez de una direccion.
- **Como** mensajero **quiero** que la direccion que yo corregi al resolverla siga a la vista en el reparto
  **para** que una nota de la tienda no me la borre.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 El formulario se ve entero

- **RF_01 (ubicua):** El sistema MUST mostrar el formulario de pedido manual completo, sin recortar ningun
  campo ni control, en escritorio y en un telefono de 390 px de ancho. **"Sin recortar" se mide asi:** con
  el formulario desplegado, la pagina no tiene desplazamiento horizontal (su ancho de contenido es igual a
  su ancho visible) y el borde derecho de cada control queda dentro de la pantalla.
- **RF_02 (estado):** **Mientras** el formulario este desplegado, el sistema MUST darle el ancho completo de
  la zona de paneles, y los otros dos paneles MUST bajar debajo de el; plegado, MAY volver a compartir
  fila con ellos.
- **RF_03 (ubicua):** Cada fila del formulario con varios controles (zona y aceptacion de direccion, pago y
  recogida, cada producto con su cantidad y su boton de quitar) MUST adaptarse al ancho disponible: en
  telefono se apilan, no desbordan.
- **RF_04 (ubicua):** Todo control del formulario MUST medir al menos 44 px de alto y ninguno MUST quedar
  escondido tras un desplazamiento horizontal.

### 3.2 La guia lleva la direccion

- **RF_05 (ubicua):** La guia impresa MUST llevar siempre una linea rotulada "Direccion" con la direccion
  original del pedido, tal como la escribio la tienda o llego de la tienda conectada. **Si** la original
  esta vacia, esa misma linea MUST decir "SIN DIRECCION" de forma visible, nunca quedar en blanco ni
  rellenarse con otra cosa.
- **RF_06 (estado):** **Mientras** el pedido tenga indicaciones para el mensajero, la guia MUST mostrarlas
  en una linea aparte rotulada "Indicaciones", debajo de la direccion y nunca en su lugar.
- **RF_07 (estado):** **Mientras** el pedido tenga en su casilla de direccion corregida un texto distinto de
  la original, la guia MUST mostrarlo en una linea aparte rotulada "Correccion o nota", debajo de la
  direccion. **No se intenta distinguir** si ese texto es una correccion del mensajero o una nota vieja de
  la tienda: se muestra tal cual, con ese rotulo, para los dos casos. Un texto igual a la original no se
  repite. **"Igual" significa:** iguales tras quitar tildes, ignorar mayusculas y minusculas, y reducir
  cualquier secuencia de espacios a uno.
- **RF_08 (ubicua):** La tarjeta del pedido en pantalla, la vista del mensajero y la exportacion a Excel
  MUST mostrar exactamente las mismas lineas que la guia, con los mismos rotulos, y MUST obtenerlas del
  mismo sitio que la guia (ver RNF_02): la direccion nunca se sustituye por una nota en ninguna de ellas.

### 3.3 La observacion tiene su sitio

- **RF_09 (ubicua):** El pedido MUST tener un campo propio de **indicaciones para el mensajero**, opcional,
  separado de la direccion y de la direccion corregida.
- **RF_10 (ubicua):** La tienda MUST poder escribir las indicaciones al crear un pedido manual y al editar
  un pedido suyo, en el mismo lugar donde hoy edita la direccion. La tienda MUST NOT ver ni editar la
  casilla de "direccion normalizada": esa direccion la corrige quien reparte, no quien vende.
- **RF_11 (estado):** **Mientras** existan pedidos anteriores a esta spec con una nota de la tienda en la
  casilla de direccion corregida, el sistema MUST seguir mostrando ese texto (por RF_07, rotulado
  "Correccion o nota") y MUST NOT borrarlo ni moverlo. Es una regla de compatibilidad con lo ya escrito,
  no un comportamiento nuevo: con RF_10, ninguna nota nueva de tienda vuelve a entrar por esa casilla.
- **RF_12 (ubicua):** La exportacion a Excel de pedidos MUST ganar una columna de indicaciones, al final,
  sin cambiar las columnas existentes ni su orden.
- **RF_13 (ubicua):** Los pedidos que entran por Shopify, webhook de tienda, OnStock o formulario de
  contacto MUST crearse sin indicaciones (campo ausente); el mensajero MAY leerlas pero no las escribe.

## 4. Requisitos no funcionales

- **RNF_01:** Ninguna via de creacion de pedidos cambia su comportamiento (RF_13), y las guias de esos
  pedidos MUST verse igual que hoy salvo por RF_05 a RF_07, que les aplica tambien.
- **RNF_02:** Las lineas de direccion de un pedido (direccion, correccion o nota, indicaciones, con sus
  rotulos) MUST salir de **una sola funcion pura** que recibe el pedido y devuelve las lineas, sin
  navegador ni impresora; guia, tarjeta, vista del mensajero y Excel MUST consumirla, y MUST existir una
  comprobacion automatica que falle si alguna de esas cuatro superficies vuelve a leer la direccion por su
  cuenta (constitucion, principio 3).
- **RNF_03:** El formulario MUST seguir el sistema de diseno vigente y pasar el checklist de cierre de
  pantalla (sin desbordamiento horizontal a 390 px, controles a 44 px).
- **RNF_04:** Las reglas de RF_01 a RF_04 no son probables en unidad con las herramientas del proyecto (no
  hay navegador en `vitest`). Se verifican con **guardas de fuente** sobre las clases de adaptacion y con
  el guion de capturas que ya existe (spec 005), midiendo el criterio de RF_01 y RF_04 en la pagina real a
  390 px y en escritorio. Queda declarado como la unica excepcion al principio 4, con la medida como
  evidencia.

## 5. Casos limite

- **Pedido viejo con observacion en "normalizada" y sin indicaciones** (RF_07, RF_11): la guia muestra
  "Direccion" con la original y "Correccion o nota" con el texto viejo. Es el caso de todos los pedidos
  manuales de hoy.
- **Pedido con direccion corregida por el mensajero Y indicaciones de la tienda**: tres lineas rotuladas:
  Direccion, Correccion o nota, Indicaciones.
- **Corregida "igual" a la original con mayusculas o tildes distintas** (RF_07): una sola linea.
- **Corregida distinta solo en la puntuacion** ("Cra 5 #10-20" y "Carrera 5 # 10 - 20"): son distintas para
  la regla, y se muestran las dos. Se acepta: comparar direcciones por significado es otra spec, y el
  precio de mostrar una linea de mas es cero; el de esconderla, una entrega fallida.
- **Indicacion muy larga**: la guia la recorta a tres lineas con puntos suspensivos; la tarjeta la muestra
  entera.
- **Telefono girado (horizontal)**: el formulario sigue entero.
- **Solicitudes de liquidacion con pendientes y el formulario desplegado a la vez** (RF_02): los dos
  visibles, el formulario arriba a todo el ancho, ninguno cortado.
- **Direccion original vacia** (pedidos importados antiguos): "SIN DIRECCION" visible (RF_05); si hay
  corregida, sale debajo como siempre.
- **La tienda edita un pedido viejo**: ve la direccion y las indicaciones (vacias); no ve la casilla
  normalizada (RF_10). La nota vieja sigue mostrandose en la guia (RF_11) hasta que alguien la reescriba
  como indicacion a mano.

## 6. Fuera de alcance

- **Cambiar como el mensajero resuelve o corrige direcciones.** La direccion corregida sigue siendo suya y
  se edita donde hoy.
- **Migrar en masa los pedidos viejos** moviendo el texto de "normalizada" a "indicaciones". RF_11 los
  muestra bien sin tocarlos; mover datos historicos es otra decision.
- **Alimentar las indicaciones desde Shopify u OnStock** (la nota del cliente). Otra spec.
- **Comparar direcciones por significado.** Solo la normalizacion de RF_07.
- **Rediseñar la pantalla de la tienda entera.** Solo la fila de los tres paneles y el formulario.
- **La guia en otro formato o tamano.** Misma guia, con la direccion donde debe.

## 7. Definition of Done

1. RF_05 a RF_13 y RNF_01, RNF_02 tienen al menos una prueba automatizada que pasa, sobre la funcion pura,
   con un pedido viejo real de ejemplo (observacion en "normalizada") y uno con las tres lineas.
2. RF_01 a RF_04 (RNF_04): guardas de fuente sobre el formulario y la fila de paneles, y **medida** con el
   guion de capturas: a 390 px y en escritorio, formulario desplegado, ancho de contenido igual al visible
   y todos los controles a 44 px o mas; con el panel de liquidaciones desplegado a la vez (RF_02).
3. Una guia impresa de prueba de un pedido con direccion, corregida e indicaciones muestra las tres
   lineas rotuladas; y una de un pedido viejo con observacion en "normalizada" muestra "Direccion" y
   "Correccion o nota".
4. La comprobacion de RNF_02 falla de verdad si una de las cuatro superficies lee la direccion por su
   cuenta (se demuestra por mutacion).
5. `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
6. Comprobado en produccion por la tienda que reporto el fallo.
7. El humano valido el resultado y aprobo la entrega.

## 8. Decisiones tomadas sin respuesta del responsable (revertibles)

Tomadas por el orquestador bajo el objetivo "haz todo el flujo hasta que me entregues el resultado":

1. **No se adivina que es el texto de "normalizada".** Se muestra siempre, rotulado "Correccion o nota".
   Alternativa descartada: una heuristica de texto, que daria resultados distintos para el mismo pedido.
2. **La tienda deja de ver "direccion normalizada"** (RF_10). Alternativa: conservarla; entonces RF_11
   dejaria de ser historica y las notas seguirian entrando por la casilla equivocada.
3. **"Cortado" se mide** (RF_01) en vez de juzgarse a ojo, y la disposicion no se prueba en unidad
   (RNF_04): es la misma excepcion declarada que uso la spec 005.
4. **Las indicaciones se escriben al crear y al editar** (RF_10); no las alimentan las tiendas conectadas
   (RF_13); el Excel gana una columna al final (RF_12).
5. **Una sola funcion pura** para las cuatro superficies, con guarda (RNF_02).
6. **Original vacia = "SIN DIRECCION" visible**; igualdad sin tildes, mayusculas ni espacios dobles (RF_05,
   RF_07).

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | La tienda ve el formulario cortado en tres columnas y la guia sale sin direccion cuando hay observacion |
| 2026-09-15 | Segunda version tras escrutinio (6 preguntas) y aprobacion bajo objetivo | RF_07 y RF_11 se disparaban sobre el mismo dato y ordenaban cosas opuestas; RF_10 era MUST y "retirable" a la vez; RF_01-04 no eran verificables ni medibles; no se decia quien edita las indicaciones ni de donde salen en pedidos no manuales; RF_08 permitia copias de la regla; "siempre" en RF_05 chocaba con la original vacia y "igual" no tenia criterio |
