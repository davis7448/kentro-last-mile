# Spec 018: La tienda ve el mismo saldo que el admin puede liquidarle

- **Estado:** aprobada (2026-09-16); enmendada el mismo dia tras `/sdd-analyze` (ver seccion 9)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-16
- **Prioridad:** alta — las tiendas ven una cifra de dinero que el admin no les puede pagar, y la
  diferencia llega a millones
- **Accesibilidad:** WCAG 2.2 AA

## 1. Contexto y objetivo

Una tienda tiene dos lugares donde ve cuanto se le debe: la tarjeta grande "Saldo pendiente por
liquidar" y la cifra "disponible" de su wallet. El admin, en el cierre pendiente de liquidaciones, ve
otra. Las tres no coinciden, y la tienda reclama un dinero que el admin no puede pagarle.

Medido en produccion el 2026-09-16 (sin escribir nada):

| Tienda | Tarjeta grande | "Disponible" | Cierre del admin | Efectivo aun con el domiciliario | Reserva por abiertos |
|---|---|---|---|---|---|
| Bella Mujer | 1.603.350 | 1.414.350 | 354.280 | 1.249.070 | 189.000 (21 pedidos) |
| DANDA | 4.889.900 | 1.262.900 | 229.200 | 4.660.700 | 3.627.000 (403 pedidos) |
| Kovia | 1.139.385 | 1.112.385 | 833.885 | 305.500 | 27.000 (3 pedidos) |
| Nambu | 2.358.910 | 2.259.910 | 2.054.710 | 304.200 | 99.000 (11 pedidos) |
| ADMA COMERCIAL | 57.000 | 48.000 | −26.500 | 83.500 | 9.000 (1 pedido) |

La diferencia tiene tres causas:

1. **Efectivo que el domiciliario aun no entrega.** La tienda cuenta como suyo el recaudo de pedidos
   entregados cuyo efectivo todavia no llego a la plataforma. El admin no puede liquidarlo hasta que
   llegue. Es la diferencia mas grande (Bella Mujer: 1.249.070 de 1.603.350).
2. **Reserva fija por pedido abierto.** La cifra "disponible" resta 9.000 por cada pedido sin cerrar,
   incluidos los que ni siquiera se han confirmado. Esa cifra no corresponde a ninguna tarifa real, y
   el cierre del admin no la resta. En DANDA la reserva y el efectivo retenido se compensan en parte y
   esconden el error.
3. **La tarjeta grande dice "Lo pendiente de hoy, no el acumulado"**, y es falso: muestra el acumulado
   sin cortar, con el efectivo retenido dentro.

Los abonos ya pagados a la tienda NO son una causa: las dos pantallas ya los descuentan (Kovia tiene
−777.765 en abonos, restados en ambos lados).

**Como se cobra hoy un fallido** (y por tanto cuanto hay que retener): 12.000 fijos a toda tienda que
no sea DANDA —ese fijo gana sobre la tarifa de zona y sobre la pantalla de ajustes, a proposito desde
ago-2026—; 0 a DANDA; y en un pedido de comunidad, el precio del lider cuando supera esa base. La
retencion usa exactamente esa regla, no otra.

**Objetivo:** que la tienda y el admin vean la misma cifra de "disponible para liquidar", que lo que no
se puede pagar todavia aparezca separado y con su motivo, y que lo que se retiene por pedidos abiertos
sea el flete que de verdad se le cobraria a esa tienda si el pedido vuelve.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** tienda **quiero** ver cuanto se me puede liquidar hoy, cuanto esta
  retenido y por que **para** no reclamar dinero que todavia no se puede pagar.
- **HU_02 (interfaz):** **Como** administrador **quiero** que el cierre pendiente de una tienda muestre
  la misma cifra que ella ve **para** no tener que explicar diferencias a mano.
- **HU_03 (sin interfaz):** **Como** responsable de la plataforma **quiero** que lo retenido por
  pedidos abiertos salga de la tarifa real de cada tienda **para** no pagar un flete que despues tendre
  que cobrar, y tampoco retener de mas.

## 3. Requisitos funcionales (EARS + RFC 2119)

### Una sola cifra de disponible

- **RF_01 (ubicua):** El sistema MUST calcular el "disponible para liquidar" de una tienda con una sola
  regla, la misma para la pantalla de la tienda, el cierre pendiente del admin, la solicitud de
  liquidacion de la tienda, el corte que crea el admin y la API de solo lectura para tiendas.
- **RF_02 (ubicua):** El "disponible para liquidar" MUST ser lo que un corte le pagaria hoy a la tienda
  **en pedidos completos**: de lo que tiene sin cortar y ya se puede pagar (abonos y su 4x1000, prepagos,
  pedidos no entregados y entregados cuyo efectivo ya se recibio del domiciliario), sin superar ese
  pagable menos los fletes retenidos por pedidos en la calle (RF_06), con la seleccion de RF_12.
- **RF_03 (ubicua):** El sistema MUST seguir descontando del disponible los abonos ya pagados y su
  4x1000, como hace hoy.
- **RF_04 (ubicua):** El sistema MUST dar por recibido el efectivo de un pedido entregado con una sola
  definicion, la que hoy usa el corte de la tienda (asignacion de efectivo cubierta del corte del
  domiciliario, o corte del domiciliario pagado o conciliado cuando no tiene asignaciones). La pantalla
  de la tienda, el cierre del admin y la solicitud de liquidacion MUST usar esa misma.

### Lo retenido, separado y con su motivo

- **RF_05 (ubicua):** El sistema MUST mostrar a la tienda, aparte del disponible, el **efectivo aun con
  el domiciliario**: el neto de los pedidos entregados cuyo efectivo todavia no se recibio (RF_04). Ese
  neto MAY ser negativo, y se muestra con su signo.
- **RF_06 (ubicua):** El sistema MUST calcular los **fletes retenidos por pedidos en la calle** sumando,
  pedido por pedido, lo que se le cobraria a esa tienda si ese pedido terminara ahora en visita fallida
  cobrable: el flete de fallido y, si el pedido sale de bodega y su manejo aun no se ha cobrado, el
  manejo.
- **RF_07 (ubicua):** Lo que RF_06 suma por pedido MUST salir de la misma regla con la que el cierre
  cobra un fallido (seccion 1: fijo general, DANDA en cero, precio congelado del lider de comunidad si
  es mayor). MUST NOT existir una segunda copia de esa regla ni un valor fijo propio de la retencion.
- **RF_08 (ubicua):** El sistema MUST mostrar el **total sin cortar**, y MUST cumplirse siempre: total
  sin cortar = disponible + efectivo aun con el domiciliario + **retenido**. El retenido que se muestra
  es lo pagable que queda fuera del disponible: la retencion por pedidos en la calle mas lo que no
  alcanza a completar un pedido (RF_12). MUST mostrarse tambien cuantos pedidos quedan retenidos.

### Que pedidos retienen

- **RF_09 (estado):** **Mientras** un pedido de la tienda tenga la mercancia en la calle —recogido por
  el domiciliario, en ruta, o pendiente de una nueva visita despues de haber sido recogido—, el sistema
  MUST retener lo que indica RF_06, completo (decisiones 8.1 y 8.2). Un pedido reabierto y reasignado
  que conserva la mercancia recogida MUST seguir reteniendo sin interrupcion.
- **RF_10 (estado):** **Mientras** un pedido este importado, en revision de direccion, pendiente de
  llamada, listo para asignar, asignado, agendado o pendiente de recogida sin haber sido recogido
  nunca, el sistema MUST NOT retener nada por el.
- **RF_11 (evento):** **Cuando** un pedido en la calle se entregue, falle, se anule o se liquide, el
  sistema MUST dejar de retener por el; su dinero pasa a contar por lo que realmente genero al cerrarse.

### Cortes y solicitudes

- **RF_12 (evento):** **Cuando** el admin cree el corte de una tienda, el sistema MUST liquidar solo
  pedidos completos: MUST incluir siempre los abonos, su 4x1000 y los pedidos cuyo neto sea cero o
  negativo, y despues los pedidos con neto positivo **del mas antiguo al mas nuevo** mientras la suma no
  supere el tope (lo pagable menos la retencion). El primer pedido que no cabe entero, y todos los
  posteriores, MUST quedar pendientes. Ningun pedido se liquida en parte.
- **RF_13 (evento):** **Cuando** un corte deje pedidos pendientes por la retencion, el sistema MUST
  conservarlos integros para el siguiente corte, que MUST volver a calcular la retencion con los pedidos
  que sigan en la calle en ese momento. No se escribe ningun movimiento de retencion.
- **RF_14 (si):** **Si** la tienda tiene pagable positivo y la retencion es igual o mayor que ese pagable,
  **o** la seleccion de RF_12 sumaria cero o menos (por ejemplo, abonos grandes que se comen los pedidos
  que caben), el sistema MUST mostrar el disponible en cero, MUST tratar todo el pagable como retenido, MUST NOT convertir la retencion en una deuda de la tienda, y MUST
  mostrar a la tienda cuantos pedidos en la calle la explican.
- **RF_15 (si):** **Si** lo pagable de la tienda ya es cero o negativo (le debe a la plataforma, como
  ADMA COMERCIAL), el sistema MUST aplicar retencion cero y mostrar la deuda tal como hoy.
- **RF_16 (si):** **Si** una tienda pide su liquidacion con el disponible en cero, el sistema MUST
  rechazar la solicitud y decirle cuanto esta retenido y por cuantos pedidos en la calle, o cuanto
  efectivo falta por recibir del domiciliario.
- **RF_17 (evento):** **Cuando** se cree un corte para una tienda con una solicitud abierta por un
  monto calculado con la regla anterior, el sistema MUST pagar segun la regla nueva; la solicitud no
  manda sobre el corte.
- **RF_23 (evento):** **Cuando** el admin cree un corte con limite de fechas o con movimientos escogidos,
  el sistema MUST aplicar la seleccion de RF_12 dentro de lo escogido con el mismo tope de la tienda
  entera (todo lo pagable de la tienda menos la retencion): asi lo pagable que queda fuera de lo escogido
  cuenta como cobertura de la retencion y no se retiene dos veces.
- **RF_24 (si):** **Si** la tienda tiene pagable positivo y, por la retencion, el corte pagaria cero o
  menos (no entra ningun pedido con neto positivo, o lo que entra no supera los abonos), el sistema MUST
  NOT crear el corte y MUST decirle al admin cuanto esta
  retenido y por cuantos pedidos en la calle.
- **RF_25 (ubicua):** La API de solo lectura para tiendas MUST devolver el disponible, el efectivo aun con
  el domiciliario y el retenido con la misma regla que la pantalla de la tienda.
- **RF_26 (evento):** **Cuando** alguien —persona o agente automatico— consulte la API de solo lectura
  para tiendas (su indice o su resumen de saldo), el sistema MUST incluir en la propia respuesta que significa
  cada cifra del saldo y un aviso fechado del cambio del 2026-09-17 (`disponibleCop` ya descuenta la retencion
  por pedidos en la calle; `retenidoCop` y `retenidoPedidos` son nuevos), para que quien consulte se entere sin
  documentacion aparte.

### Pantallas

- **RF_18 (ubicua):** La tarjeta grande de la tienda MUST mostrar el disponible para liquidar, y su
  texto MUST decir lo que la cifra es, sin afirmar que es "lo de hoy".
- **RF_19 (evento):** **Cuando** la tienda abra su wallet, el sistema MUST mostrarle el disponible, el
  efectivo aun con el domiciliario, los fletes retenidos (con el numero de pedidos en la calle) y el
  total sin cortar.
- **RF_20 (evento):** **Cuando** el admin abra el cierre pendiente de una tienda, el sistema MUST
  mostrar el mismo disponible que ve la tienda y, desglosados, el efectivo aun con el domiciliario y los
  fletes retenidos.
- **RF_21 (estado):** **Mientras** la tienda tenga su panel abierto, el sistema SHOULD refrescar sus
  cifras al menos cada cinco minutos y MUST refrescarlas al recargar la pagina; no se exige tiempo real.
- **RF_22 (si):** **Si** no se puede obtener el saldo completo de la tienda (sin conexion, error del
  servidor, o algun pedido que interviene en el calculo no se pudo leer), el sistema MUST mostrar un
  aviso de error en la tarjeta y MUST NOT mostrar una cifra parcial.

## 4. Requisitos no funcionales

- **RNF_01:** La regla del disponible y la de la retencion MUST vivir en modulos puros sin red, y una
  prueba MUST atar la cifra de la tienda, la del cierre del admin y el importe de un corte para los
  mismos datos (principio 3).
- **RNF_02:** Lo retenido por un pedido MUST obtenerse del mismo calculo que genera el cobro de fallido
  al cerrarlo (principio 9), y una prueba MUST fallar si divergen para: una tienda general (fijo), DANDA
  (cero), un pedido de comunidad con precio del lider mayor que la base, y un pedido de bodega.
- **RNF_03:** Calcular el saldo de una tienda MUST NOT obligarla a descargar cortes de domiciliarios ni
  pedidos ajenos (principios 8 y 11): lo que la tienda no puede leer se calcula en el servidor.
- **RNF_04:** El tiempo hasta ver la tarjeta grande de una tienda MUST quedar dentro de ±10 % de una
  linea base medida **antes** del cambio con el instrumento `kentro-perf` sobre la misma tienda y el mismo
  dispositivo, y registrada en `docs/rendimiento.md` junto con la medicion posterior.

## 5. Casos limite

- **DANDA, con 403 pedidos abiertos.** Su fallido se cobra en cero, asi que no retiene flete; solo
  retendria manejo de bodega de pedidos en la calle que aun no lo tengan cobrado.
- **Pedido asignado que el domiciliario recoge.** Empieza a retener en ese momento; si se anula antes de
  recogerse, nunca retuvo.
- **Pedido de comunidad cuyo lider cambia su precio mientras el pedido esta abierto.** Se usa el precio
  del lider congelado en el pedido y la base que resultaria al cerrar hoy, igual que el cierre.
- **Pedido en bodega, primera visita.** Retiene fallido + manejo.
- **Pedido en bodega reabierto tras un fallido.** El manejo ya se cobro en la primera visita y no se
  vuelve a cobrar: retiene solo el fallido de la siguiente visita.
- **Pedido reabierto que vuelve a asignado o pendiente de recogida.** Si la mercancia ya fue recogida,
  sigue reteniendo (RF_09); la cifra no aparece y desaparece.
- **Fallido no cobrable** (sin cobertura, pedido malo, telefono malo). Al cerrarse deja de retener
  (RF_11) y no genera cobro: la tienda recupera el disponible.
- **Entregado contra entrega con cargos mayores que lo recaudado.** Su neto es negativo y resta del
  efectivo aun con el domiciliario (RF_05).
- **Efectivo recibido en parte** (la asignacion del corte del domiciliario no cubre el pedido). No se da
  por recibido hasta que quede cubierto (RF_04).
- **Corte con retencion y luego todos los pedidos en la calle se cierran.** El corte siguiente ya no
  retiene y liquida los pedidos que quedaron pendientes, integros (RF_13).
- **Tope de 50.000 y pedidos de 30.000, 30.000 y 10.000 (del mas antiguo al mas nuevo).** Entra el
  primero; el segundo no cabe entero y queda pendiente junto con el tercero, aunque este si cabria
  (RF_12). Disponible = 30.000; retenido = lo pagable restante.
- **Tienda con fallidos cobrados y ningun pedido positivo.** Lo pagable es negativo: retencion cero y el
  corte se crea como hoy (RF_15), no aplica RF_24.
- **ADMA COMERCIAL (pagable negativo con un pedido abierto).** Retencion aplicada cero; total = deuda +
  efectivo con domiciliario (RF_15, RF_08).
- **El domiciliario entrega el efectivo mientras la tienda mira.** Se refleja en el siguiente refresco
  (RF_21): pasa de "efectivo con el domiciliario" a "disponible" sin cambiar el total.
- **Tienda con el rol logistico (sin acceso financiero).** No ve ninguna de estas cifras, igual que hoy.

## 6. Fuera de alcance

- Cambiar las tarifas o la regla de cobro de fallidos (incluido el fijo general y el cero de DANDA). Si
  algun dia la tarifa de zona o de ajustes debe mandar sobre el fijo, es otra spec: cambia lo que se
  cobra, no solo lo que se retiene.
- Cambiar el momento en que el corte de la tienda da por recibido el efectivo: RF_04 solo alinea las
  pantallas y la solicitud con la definicion que el corte ya usa.
- Rehacer cortes ya creados, pagados o conciliados (principio 10).
- La pantalla de wallet del domiciliario y la del lider de comunidad.
- Los abonos: ya se descuentan bien; solo se garantiza que siga siendo asi (RF_03).
- **Manejo de bodega cobrado dos veces al reabrir** (fallo previo detectado por `/sdd-analyze`): si un
  pedido de bodega se reabre despues de que su manejo se pago en un corte, el segundo cierre reabre ese
  cobro. Hoy no hay pedidos de bodega en produccion. Va a la spec 019; esta spec lo registra como riesgo
  y su prueba de bodega no fija ese comportamiento.

## 7. Definition of Done

1. Cada RF tiene al menos una prueba automatizada que pasa.
2. Una prueba ata, para los mismos datos, el disponible de la tienda, el del cierre del admin, el de la API
   para tiendas y el importe de un corte (RF_01, RF_25, RNF_01).
3. Una prueba compara lo retenido por un pedido en la calle con lo que cobra ese mismo pedido al cerrarse
   como fallido cobrable, en los cuatro casos de RNF_02.
4. Una prueba encadena dos cortes con retencion y comprueba que la suma pagada a la tienda es igual a lo
   que habria cobrado sin retencion una vez cerrados todos sus pedidos, y que ningun pedido quedo
   liquidado en parte (RF_12, RF_13).
5. Medido en produccion sobre las cinco tiendas de la tabla de la seccion 1: la cifra de la tienda y la
   del cierre del admin coinciden al peso, y total = disponible + efectivo con domiciliario + retenido
   aplicado.
6. `npm run lint`, `npx tsc --noEmit` (raiz y `functions/`) y `npm test` en verde.
7. El responsable ve la pantalla de una tienda real (Bella Mujer) y la del admin y confirma que cuadran.

## 8. Decisiones del responsable

1. **Retiene desde que la mercancia sale a la calle** (recogido, en ruta, pendiente de nueva visita).
   Decidido el 2026-09-16. Un pedido sin recoger puede anularse sin coste.
2. **Se retiene el cobro de fallido completo**, no una proporcion segun la tasa de fallidos. Decidido el
   2026-09-16.
3. **La retencion usa la regla de cobro real de hoy** (fijo general, DANDA en cero, lider de comunidad si
   es mayor), no la tarifa de zona ni la de ajustes. Decidido el 2026-09-16: retener otra cifra de la que
   se cobra volveria a descuadrar.
4. **En un corte, la retencion se aplica dejando pedidos completos pendientes**, del mas antiguo al mas
   nuevo; el que no cabe entero queda pendiente, como el abono a proveedores. Decidido el 2026-09-16
   (sustituye la version anterior, que escribia un movimiento de retencion y su devolucion).
5. **Con el disponible en cero, la tienda no puede solicitar liquidacion.** Decidido el 2026-09-16.
6. Aceptadas las propuestas del revisor adversarial (2026-09-16): cifras que siempre suman con la
   retencion aplicada, una sola definicion de efectivo recibido, "pedidos no entregados" en lugar de
   "fallidos", manejo retenido solo si no se cobro, retencion continua en reabiertos, refresco no en
   tiempo real, linea base de rendimiento ±10 %, y error visible en lugar de cifra parcial.
7. **Corte con fechas o seleccion:** mismo criterio de pedidos completos con el tope de RF_23; si no cabe
   ningun pedido positivo, no se crea el corte (RF_24). Decidido el 2026-09-16.
8. **La API de solo lectura para tiendas entra en esta spec** (RF_25). Decidido el 2026-09-16.
9. **El doble cobro de manejo de bodega al reabrir va a la spec 019.** Decidido el 2026-09-16.
10. **Un corte con pagable positivo nunca deja a la tienda debiendo por culpa de la retencion** (RF_14,
    RF_24): si la seleccion suma cero o menos, disponible 0 y no se crea el corte. Decidido el 2026-09-16
    tras la segunda pasada de `/sdd-analyze`, aplicando el principio ya aceptado de RF_14.
11. **Asientos que no se pueden atribuir a un pedido: RF_22 se aplica literal** (error, sin cifra
    parcial). Si T1 encuentra alguno en produccion, el ciclo se detiene y el responsable decide antes de
    T5 si se corrigen los datos o se enmienda RF_22. Decidido el 2026-09-16.

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-17 | RF_26: la API para tiendas avisa en su respuesta del cambio de `disponibleCop` y explica `retenidoCop` | Pedido del responsable al aprobar la entrega: que el agente que consulte la API se entere |
| 2026-09-16 | Segunda enmienda tras `/sdd-analyze`: RF_14 y RF_24 cubren la seleccion que suma cero o menos; decisiones 8.10 y 8.11 | Hallazgos 1 y 5 de la segunda pasada |
| 2026-09-16 | Enmienda tras `/sdd-analyze`: retencion por pedidos completos sin movimientos (RF_02, RF_08, RF_12-RF_14), cortes con rango (RF_23), corte vacio (RF_24), API de tiendas (RF_25), linea base de rendimiento previa (RNF_04), bodega a la 019 | Hallazgos 1, 2, 3 del analisis y decisiones 8.4, 8.7-8.9 |
| 2026-09-16 | Revision adversarial: regla de cobro real, retencion escrita en el corte, solicitud bloqueada en cero, una definicion de efectivo recibido; requisitos renumerados RF_01-RF_22 | Seis preguntas del revisor y decisiones 8.3-8.6 |
| 2026-09-16 | Decisiones 8.1 y 8.2: retiene desde que sale a la calle, cobro completo | Respuesta del responsable |
| 2026-09-16 | Borrador inicial | El saldo que ve la tienda no coincide con el cierre pendiente del admin (Bella Mujer: 1.603.350 frente a 354.280) |
