# Spec 010: Que nadie tarde cuatro dias en enterarse de que no entran pedidos

- **Estado:** borrador
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Prioridad:** la primera de las tres specs nacidas del incidente del webhook; es la mas barata y la que mas habria cambiado el resultado

## 1. Contexto y objetivo

Del 10 al 15 de septiembre de 2026 la plataforma rechazo **todos** los pedidos que Shopify le envio: 2.545
intentos fallidos, cuatro dias sin un solo pedido de la tienda con mas volumen. Nadie recibio ningun aviso.
La plataforma seguia respondiendo, los pedidos de otras vias seguian entrando, y el unico sintoma visible fue
que "imprimir pendientes no mostraba pedidos", que parecia un problema de pantalla.

El fallo se corrigio en una hora una vez detectado. **Detectarlo tardo cuatro dias.** Esa es la parte que
esta spec cambia: la plataforma tiene que avisar por si misma cuando una de sus puertas de entrada de
pedidos empieza a fallar, y avisar a una persona, no a un registro que nadie lee.

**Objetivo:** que un fallo sostenido en cualquier via de entrada de pedidos llegue a una persona responsable
en menos de una hora, con lo necesario para saber que via es y desde cuando.

## 2. Historias de usuario

- **Como** responsable de la plataforma **quiero** recibir un aviso cuando una via de entrada de pedidos falle
  de forma repetida **para** actuar el mismo dia y no cuando un cliente se queje.
- **Como** responsable de la plataforma **quiero** que el aviso diga que via falla, desde cuando y cuantos
  intentos se han perdido **para** no tener que investigar desde cero.
- **Como** responsable de la plataforma **quiero** que el aviso se apague solo cuando la via vuelva a funcionar
  **para** saber que el problema termino sin comprobarlo a mano.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El sistema MUST vigilar cada via de entrada de pedidos de forma separada: el webhook de
  Shopify, el webhook de tienda, el formulario de contacto, la importacion de OnStock y la creacion manual.
  Un aviso MUST nombrar la via concreta.
- **RF_02 (evento):** **Cuando** una via acumule cinco o mas intentos fallidos en diez minutos, el sistema MUST
  enviar un aviso a la persona responsable por un canal que esa persona lea (correo o mensajeria), no solo
  dejar constancia en un registro.
- **RF_03 (ubicua):** El aviso MUST incluir: la via que falla, la hora del primer fallo del episodio, el numero
  de intentos fallidos acumulados y, cuando el sistema lo sepa, el motivo mas frecuente.
- **RF_04 (estado):** **Mientras** un episodio siga abierto, el sistema MUST NOT repetir el aviso mas de una vez
  por hora: un aviso cada minuto es lo mismo que ninguno.
- **RF_05 (evento):** **Cuando** la via vuelva a aceptar pedidos durante treinta minutos seguidos, el sistema
  MUST cerrar el episodio y avisar de que se cerro, con el total de intentos perdidos.
- **RF_06 (ubicua):** El sistema MUST tratar como fallo todo intento que la via rechace por un error propio de
  la plataforma. Un intento rechazado por datos invalidos del remitente MAY contarse aparte, pero MUST NOT
  esconder un fallo propio.
- **RF_07 (ubicua):** El sistema MUST poder comprobarse: la persona responsable MUST poder provocar un aviso de
  prueba y recibirlo, sin generar pedidos ni tocar datos reales.

## 4. Requisitos no funcionales

- **RNF_01:** El aviso MUST llegar en menos de quince minutos desde el quinto fallo. Cuatro dias se convierten en
  una hora, no en otro dia.
- **RNF_02:** La vigilancia MUST NOT depender de que la plataforma este sana: si la via que falla es la propia
  plataforma, el aviso MUST salir igual (la vigilancia vive fuera de lo vigilado).
- **RNF_03:** La vigilancia MUST NOT anadir ningun coste perceptible ni latencia a la entrada de pedidos.

## 5. Casos limite

- **Cinco fallos de cinco remitentes distintos en diez minutos:** cuenta como episodio; el umbral es por via,
  no por remitente.
- **Un fallo aislado al dia:** no es episodio. Un solo intento fallido no avisa; cinco seguidos si.
- **La via se recupera y vuelve a caer en la misma hora:** dos episodios, dos avisos de apertura.
- **Fin de semana o madrugada:** el aviso sale igual. Decidir quien lo atiende es de la persona, no del
  sistema.
- **El canal de aviso falla** (correo rechazado, mensajeria caida): el sistema MUST intentarlo por un segundo
  canal, y MUST dejar constancia de que el aviso no pudo entregarse.
- **Una via sin trafico** (cero intentos en una semana): no es un fallo y no avisa. Vigilar el silencio es
  otra spec.

## 6. Fuera de alcance

- **Vigilar el silencio** ("hace 24 horas que no entra ningun pedido por Shopify"). Habria cazado este mismo
  incidente por otro lado, pero exige saber cuanto trafico es normal por via y por hora. Spec futura.
- **Vigilar las demas funciones** (cortes, confirmaciones, sincronizaciones). Esta spec cubre solo la entrada
  de pedidos, que es donde el silencio cuesta dinero cada hora.
- **Un panel de estado.** El aviso es a una persona; un tablero es otra cosa.

## 7. Definition of Done

1. Cada RF tiene al menos una prueba automatizada que pasa; la logica de umbral y de episodio se prueba sin
   red.
2. Un aviso de prueba (RF_07) provocado a proposito llega a la persona responsable por el canal elegido, con
   captura.
3. Se reproduce el incidente del 10 de septiembre en el entorno de pruebas (intentos rechazados de forma
   artificial) y el aviso llega en menos de quince minutos con via, hora y conteo correctos.
4. Se demuestra que un fallo aislado no avisa y que el episodio se cierra solo tras la recuperacion.
5. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Incidente del webhook de Shopify: cuatro dias sin pedidos y ningun aviso |
