# Spec 013: El pedido manual se ve entero, y la guia lleva la direccion de verdad

- **Estado:** borrador
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
verdad necesita.

**Objetivo:** que el pedido manual se cree comodo en cualquier pantalla, que la guia lleve **siempre** la
direccion, y que la observacion tenga su sitio propio sin pisar la direccion corregida.

## 2. Historias de usuario

- **Como** tienda **quiero** crear un pedido manual sin que se me corten los campos, en el computador y en
  el telefono, **para** registrar ventas fuera de Shopify sin pelear con la pantalla.
- **Como** tienda **quiero** dejarle al mensajero una indicacion ("timbre azul", "preguntar por Marta")
  **para** que encuentre al cliente, sin que esa nota sustituya a la direccion.
- **Como** mensajero **quiero** que la guia lleve la direccion completa y, aparte, las indicaciones **para**
  no salir a la calle con una nota en vez de una direccion.
- **Como** mensajero **quiero** que la direccion que yo corregi al resolverla siga siendo la que manda en el
  reparto **para** que una nota de la tienda no me la borre.

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 El formulario se ve entero

- **RF_01 (ubicua):** El sistema MUST mostrar el formulario de pedido manual completo, sin recortar ningun
  campo ni control, en escritorio y en un telefono de 390 px de ancho.
- **RF_02 (estado):** **Mientras** el formulario este desplegado, el sistema MUST darle el ancho que
  necesita, aunque eso signifique que los otros dos paneles bajen o se aparten; plegado, MAY volver a
  compartir fila con ellos.
- **RF_03 (ubicua):** Cada fila del formulario con varios controles (zona y aceptacion de direccion, pago y
  recogida, cada producto con su cantidad y su boton de quitar) MUST adaptarse al ancho disponible: en
  telefono se apilan, no desbordan.
- **RF_04 (ubicua):** Todo control del formulario MUST ser alcanzable con el dedo en telefono: 44 px de
  alto minimo, y nada escondido tras un desplazamiento horizontal.

### 3.2 La guia lleva la direccion

- **RF_05 (ubicua):** La guia impresa MUST mostrar **siempre** la direccion original del pedido, tal como la
  escribio la tienda o llego de la tienda conectada.
- **RF_06 (estado):** **Mientras** el pedido tenga indicaciones para el mensajero, la guia MUST mostrarlas
  en una linea aparte, rotulada como indicaciones, debajo de la direccion y nunca en su lugar.
- **RF_07 (estado):** **Mientras** el pedido tenga una direccion corregida distinta de la original, la guia
  MUST mostrar la corregida como direccion de reparto y la original como referencia, ambas rotuladas.
  Una corregida igual a la original se muestra una sola vez.
- **RF_08 (ubicua):** La tarjeta del pedido en pantalla MUST seguir la misma regla que la guia: la
  direccion nunca se sustituye por una nota.

### 3.3 La observacion tiene su sitio

- **RF_09 (ubicua):** El formulario de pedido manual MUST tener una casilla propia de **indicaciones para el
  mensajero**, opcional, separada de la direccion y de la direccion corregida.
- **RF_10 (ubicua):** El sistema MUST dejar de ofrecerle a la tienda la casilla de "direccion normalizada"
  al crear un pedido: esa direccion la corrige quien reparte, no quien vende. La tienda escribe la
  direccion y, si quiere, una indicacion.
- **RF_11 (evento):** **Cuando** un pedido ya existente tenga en "direccion normalizada" un texto que no es
  una direccion —porque la tienda lo uso como observacion—, el sistema MUST seguir mostrando ese texto
  como indicacion y no perderlo. Que la plataforma cambie de casilla no puede borrar lo que las tiendas
  ya escribieron.
- **RF_12 (ubicua):** Las indicaciones MUST viajar con el pedido a todo lo que hoy ve la direccion: la
  tarjeta, la guia, la vista del mensajero y la exportacion a Excel.

## 4. Requisitos no funcionales

- **RNF_01:** Ninguna otra pantalla ni papel cambia: la creacion de pedidos por Shopify, por webhook de
  tienda, por OnStock o por formulario MUST seguir igual, y las guias de esos pedidos MUST verse igual
  salvo por la regla de RF_05 a RF_07, que les aplica tambien.
- **RNF_02:** Las reglas de que se imprime MUST poder probarse sin navegador ni impresora: la guia se arma
  con una funcion pura que recibe el pedido y devuelve lo que va en cada linea.
- **RNF_03:** El formulario MUST seguir el sistema de diseno vigente y pasar el checklist de cierre de
  pantalla (sin desbordamiento horizontal a 390 px, controles a 44 px).

## 5. Casos limite

- **Pedido viejo con observacion en "normalizada" y sin indicaciones** (RF_11): la guia muestra la
  direccion original y, debajo, el texto viejo como indicacion. Es el caso de todos los pedidos manuales
  de hoy.
- **Pedido con direccion corregida por el mensajero Y observacion de la tienda**: la guia lleva las tres
  cosas rotuladas: reparto, original, indicaciones.
- **Corregida identica a la original**: una sola direccion, sin repetirla.
- **Indicacion muy larga**: la guia la recorta a un numero de lineas fijo con puntos suspensivos; la
  tarjeta la muestra entera.
- **Telefono girado (horizontal)**: el formulario sigue entero.
- **Solicitudes de liquidacion con pendientes y el formulario desplegado a la vez** (RF_02): los dos
  visibles, ninguno cortado; el orden lo decide la pantalla, no esta spec.
- **Direccion original vacia** (no deberia pasar; el formulario la exige): la guia muestra la corregida si
  la hay, y si no, un aviso visible de "sin direccion" en vez de un hueco.

## 6. Fuera de alcance

- **Cambiar como el mensajero resuelve o corrige direcciones.** La direccion corregida sigue siendo suya y
  se edita donde hoy.
- **Migrar en masa los pedidos viejos** moviendo el texto de "normalizada" a "indicaciones". RF_11 los
  muestra bien sin tocarlos; mover datos historicos es otra decision.
- **Rediseñar la pantalla de la tienda entera.** Solo la fila de los tres paneles y el formulario.
- **La guia en otro formato o tamano.** Misma guia, con la direccion donde debe.

## 7. Definition of Done

1. Cada RF tiene al menos una prueba automatizada que pasa; las reglas de la guia (RF_05 a RF_08, RF_11)
   se prueban sobre la funcion pura, con un pedido viejo real de ejemplo (observacion en "normalizada").
2. Capturas del formulario desplegado en escritorio y a 390 px, sin ningun campo cortado, y con el panel de
   liquidaciones desplegado a la vez (RF_02).
3. Una guia impresa de prueba de un pedido con direccion, corregida e indicaciones muestra las tres cosas
   rotuladas; y una de un pedido viejo con observacion en "normalizada" muestra direccion e indicacion.
4. `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
5. Comprobado en produccion por la tienda que reporto el fallo.
6. El humano valido el resultado y aprobo la entrega.

## 8. Decisiones pendientes del responsable

**Que hacer con la casilla "direccion normalizada" en el formulario de la tienda.** Recomendacion: quitarla
(RF_10) y dar una casilla de indicaciones (RF_09). Motivo: las tiendas no normalizan direcciones, dejan
notas; ofrecerles una casilla que significa otra cosa es lo que produjo guias sin direccion. Si se prefiere
conservarla, RF_10 se retira y RF_05 a RF_07 siguen valiendo igual: la guia lleva la direccion pase lo que
pase.

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | La tienda ve el formulario cortado en tres columnas y la guia sale sin direccion cuando hay observacion |
