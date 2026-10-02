# Spec 024: La comunidad puede ganar de la utilidad de Kentro, sin encarecer a sus tiendas

- **Estado:** aprobada (2026-10-02, por el responsable de la plataforma, con las decisiones de la seccion 9)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-02
- **Origen:** liquidaciones de ADMA COMPANY y ADMA LABORATORIO del 2026-09-29/30. Los $1.000 por pedido
  que se les reconocen se calcularon a mano, con scripts de solo lectura y una hoja de calculo.
- **Prioridad:** alta — ya hay dos comunidades que cobran asi, y cada liquidacion se arma fuera de la
  plataforma
- **Accesibilidad:** WCAG 2.2 AA

## 1. Contexto y objetivo

Hoy una comunidad solo puede ganar de una forma: el lider **sube la tarifa** a sus tiendas por encima de
la base, y la diferencia es su cashback (spec 001, spec 004). Quien paga es la tienda.

Con ADMA se acordo otra cosa. Por cada pedido **entregado** o **fallido con flete cobrado** de una tienda
de su comunidad, Kentro le reconoce **$1.000 de su propia utilidad**, y la tienda sigue pagando la tarifa
de siempre ($12.000). La plataforma no sabe hacer eso, asi que el 2026-09-29/30 se calculo a mano:

| Comunidad | Pedidos reconocidos | Reconocimiento |
|---|---:|---:|
| ADMA (lider ADMA COMERCIAL) | 144 | $144.000 |
| ADMA LABORATORIO | 360 | $360.000 |

Calcularlo a mano tiene tres problemas. El primero, que nadie lo ve: ni el lider en su pantalla ni el
admin en la posicion de la plataforma, que sobrestima la utilidad en exactamente esa cifra. El segundo,
que no queda registro de que pedidos ya se reconocieron, asi que la siguiente liquidacion tiene que
reconstruir el corte anterior para no pagarlos dos veces. El tercero, que la membresia cambio tres veces
en la misma tarde (que tiendas son de ADMA y cuales de LAB), y cada cambio movio la cifra sin dejar rastro.

**Objetivo:** que una comunidad pueda tener un **reconocimiento por pedido pagado por Kentro**, que se
cause solo al cerrar el pedido, que el lider y el admin lo vean, y que se pague por el mismo mecanismo de
cortes que el cashback.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** administrador **quiero** fijar para una comunidad un reconocimiento por
  pedido que paga Kentro **para** no tener que calcularlo a mano en cada liquidacion.
- **HU_02 (interfaz):** **Como** lider de comunidad **quiero** ver cuanto reconocimiento llevo causado y
  cuanto ya me pagaron **para** saber que me deben sin pedirle una hoja de calculo a nadie.
- **HU_03 (sin interfaz):** **Como** tienda de una comunidad **quiero** seguir pagando exactamente la
  misma tarifa **para** que pertenecer a la comunidad no me cueste.
- **HU_04 (interfaz):** **Como** administrador **quiero** que la utilidad de la plataforma descuente lo
  reconocido a las comunidades **para** no creer que gano mas de lo que gano.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (opcion):** **Donde** una comunidad tenga un reconocimiento por pedido configurado, el sistema
  MUST causar ese valor a favor de la comunidad por cada pedido de sus tiendas que se cierre como
  **entregado**, o como **fallido con flete cobrado**.
- **RF_02 (ubicua):** El reconocimiento MUST salir de la utilidad de Kentro y MUST NOT cambiar ni un peso
  de lo que paga la tienda, de lo que cobra el domiciliario, ni del costo de producto.
- **RF_03 (ubicua):** Un fallido cuenta como cobrado con la **misma regla** que ya decide si se cobra el
  flete (constitucion, principio 9: se cuenta en positivo). El reconocimiento MUST NOT tener su propia
  copia de esa regla.
- **RF_04 (ubicua):** El valor que se causa MUST ser el vigente **cuando se cierra el pedido**. Cambiar el
  valor despues MUST NOT recalcular lo ya causado.
- **RF_05 (ubicua):** Solo el administrador MAY fijar, cambiar o quitar el reconocimiento de una
  comunidad. El lider MUST NOT poder tocarlo.
- **RF_06 (ubicua):** Una comunidad MAY tener a la vez cashback (precio del lider) y reconocimiento. Son
  dos conceptos distintos y MUST verse por separado en todas las pantallas.
- **RF_07 (evento):** **Cuando** se corrija administrativamente un pedido (fallido↔entregado, anulado,
  nueva visita), el reconocimiento MUST seguir la misma regla que el cashback en las specs 001 y 004:
  si ya se pago, se compensa en el periodo abierto; si no, se recalcula.
- **RF_08 (evento):** **Cuando** una tienda cambie de comunidad, lo ya causado MUST quedarse con la
  comunidad que lo causo, y solo los pedidos cerrados despues del cambio MUST causar para la nueva.
- **RF_09 (ubicua):** El reconocimiento MUST pagarse por el mismo mecanismo de cortes que el cashback del
  lider, y un pedido MUST NOT poder reconocerse dos veces.
- **RF_10 (ubicua):** La posicion de la plataforma MUST restar de la utilidad lo reconocido a las
  comunidades, y MUST mostrar como pasivo lo causado y aun no pagado.
- **RF_11 (ubicua):** El lider MUST ver en su pantalla, por periodo, cuantos pedidos le causaron
  reconocimiento, cuanto lleva causado y cuanto ya se le pago.
- **RF_12 (opcion):** **Donde** el administrador lo pida, el sistema SHOULD causar el reconocimiento de
  pedidos ya cerrados de las tiendas de la comunidad dentro de un rango de fechas, con previsualizacion
  antes de escribir, para poner al dia a ADMA y ADMA LABORATORIO sin pagar dos veces lo ya liquidado a
  mano.

## 4. Requisitos no funcionales

- **RNF_01 (trazabilidad):** Cada reconocimiento causado MUST poder rastrearse hasta su pedido, su
  comunidad y el valor vigente al cerrarlo.
- **RNF_02 (coherencia):** La regla de cuanto se reconoce MUST vivir en un solo modulo puro y estar atada
  por prueba a lo que muestra el cliente (constitucion, principios 3 y 9).

## 5. Casos limite

- **Pedido de una tienda que se une a la comunidad el mismo dia:** decide la comunidad vigente al
  **cerrar** el pedido, no al crearlo.
- **Fallido que se reabre y se vuelve a visitar:** cada visita cobrada causa su propio flete; decidir y
  dejar escrito si cada una causa tambien su reconocimiento.
- **Fallido `pending_review`:** no es cobrable hasta que se clasifique; no causa nada hasta entonces.
- **Pedidos de la propia tienda del lider** (ADMA COMERCIAL lidera ADMA): en la liquidacion manual NO se
  le reconocieron. Decidir si la regla los excluye.
- **Comunidad sin valor configurado:** no causa nada, y no debe aparecer un renglon en $0.
- **Las liquidaciones ya hechas a mano** (ADMA $144.000 y LAB $360.000, hasta el 2026-09-29): el relleno
  de RF_12 MUST NOT volver a causar esos pedidos.

## 6. Fuera de alcance

- Cambiar como funciona el cashback por precio del lider.
- Reconocimientos en porcentaje, por producto o por volumen. Aqui es un valor fijo por pedido.
- Pagar automaticamente: el corte lo sigue marcando como pagado el administrador.

## 7. Definition of Done

1. Una prueba demuestra RF_01 y RF_03: entregado y fallido cobrado causan; los tres fallidos no cobrables
   y `pending_review` no.
2. Una prueba demuestra RF_02: los asientos de la tienda, del domiciliario y de producto son identicos con
   y sin reconocimiento.
3. Una prueba demuestra RF_09: el mismo pedido no puede causar dos veces, ni al reintentar el cierre.
4. La posicion de la plataforma resta lo reconocido (RF_10), atada por prueba al calculo del cliente.
5. El lider de ADMA ve en su pantalla las mismas cifras que la liquidacion manual para el mismo periodo.
6. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
7. El responsable de la plataforma firma la entrega.

## 9. Decisiones de aprobacion (2026-10-02)

Respuestas del responsable a las preguntas abiertas del plan (`specs/024_plan.md`), aprobadas con las
propuestas por defecto:

- **Por pedido, no por visita** (P1): un pedido causa como maximo un reconocimiento, aunque tenga varias
  visitas fallidas cobradas.
- **La tienda del propio lider se excluye** (P2): sus pedidos no causan reconocimiento a su comunidad
  (ADMA COMERCIAL en ADMA), igual que en la liquidacion manual.
- **Lo pagado a mano se registra como corte ya pagado** (P3): el relleno asienta los 144 pedidos de ADMA
  y los 360 de ADMA LABORATORIO en un corte de lider en estado pagado, y se bloquea si las cifras no dan
  exactamente $144.000 y $360.000.
- El resto de preguntas abiertas del plan (P4-P12) se resuelven con la opcion marcada como provisional en
  el propio plan.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-02 | Borrador inicial | Liquidaciones de ADMA y ADMA LABORATORIO calculadas a mano el 2026-09-29/30 ($144.000 y $360.000) |
| 2026-10-02 | Aprobada con las decisiones de la seccion 9 | Directiva del responsable (`/goal`), respuestas por defecto del plan |
