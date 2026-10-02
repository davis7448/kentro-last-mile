# Spec 026: Que nadie descubra a los tres meses que el efectivo de una entrega nunca llego

- **Estado:** aprobada (2026-10-02, por el responsable de la plataforma, con las decisiones de la seccion 9)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-02
- **Origen:** liquidacion de ADMA LABORATORIO del 2026-09-30. $1.551.550 de producto de LAB no se pudieron
  pagar porque el efectivo de esos pedidos, segun Kentro, sigue con el domiciliario; algunos desde junio.
- **Prioridad:** alta — es dinero que puede estar perdido, y hoy no lo avisa nadie
- **Accesibilidad:** WCAG 2.2 AA

## 1. Contexto y objetivo

Cuando una contraentrega se entrega, el domiciliario tiene el efectivo hasta que lo entrega en un corte.
Mientras tanto, la tienda no puede cobrar ese pedido y el proveedor tampoco (spec 018: misma compuerta).
Lo normal es que ese tiempo sea de dias. Medido contra produccion el 2026-10-02:

| Antiguedad desde la entrega | Pedidos | Recaudo |
|---|---:|---:|
| 7 dias o menos | 119 | $11.603.610 |
| 8 a 30 dias | 10 | $707.471 |
| 31 a 60 dias | 16 | $1.526.140 |
| Mas de 60 dias | 8 | $720.500 |
| **Total** | **153** | **$14.557.721** |

De esos 153, **84 no estan en ningun corte** y 69 estan en un corte que no se ha cubierto. Los **24
pedidos de mas de 30 dias ($2.246.640) son todos del mismo lider logistico**. El mas antiguo se entrego el
2026-07-01.

Nadie lo vio hasta que hubo que pagarle a un proveedor y la cifra no cuadro. No hay error, no hay aviso:
el dinero simplemente no aparece como recibido. Puede ser efectivo que se entrego y no quedo en un corte,
o efectivo que de verdad se debe. Desde la plataforma no se distingue, y esa es la falla.

**Objetivo:** que el efectivo de una contraentrega entregada que no llega a un corte en un plazo razonable
se vea a tiempo, en un solo sitio, con quien lo tiene y desde cuando.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** administrador **quiero** ver las contraentregas entregadas cuyo efectivo
  no ha llegado, ordenadas por antiguedad y agrupadas por lider **para** cobrarlas antes de que pasen meses.
- **HU_02 (interfaz):** **Como** lider logistico **quiero** ver mis pedidos entregados cuyo efectivo
  Kentro todavia no tiene **para** entregarlo o aclarar si ya lo entregue.
- **HU_03 (sin interfaz):** **Como** responsable de la plataforma **quiero** enterarme sin entrar a mirar
  cuando aparezca un pedido que pasa el plazo **para** no depender de que alguien lo descubra liquidando.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El sistema MUST considerar "efectivo no recibido" a toda contraentrega entregada
  cuyo efectivo no este cubierto por un corte de domiciliario, con la **misma regla** que hoy decide si
  una tienda o un proveedor pueden cobrar ese pedido. La alerta MUST NOT tener su propia copia de la regla.
- **RF_02 (ubicua):** El administrador MUST ver la lista completa de efectivo no recibido con, por pedido:
  lider, mensajero, tienda, fecha de entrega, dias transcurridos, recaudo y si esta en un corte pendiente o
  fuera de todo corte.
- **RF_03 (estado):** **Mientras** un pedido lleve mas del plazo configurado sin que su efectivo llegue, el
  sistema MUST marcarlo como vencido y MUST mostrar el total vencido en la pantalla principal del
  administrador.
- **RF_04 (ubicua):** El plazo MUST ser configurable por el administrador. Por defecto SHOULD ser de 7
  dias.
- **RF_05 (evento):** **Cuando** un pedido pase el plazo, el sistema SHOULD avisar al responsable de la
  plataforma por un canal que no exija abrir la app, una sola vez por pedido.
- **RF_06 (ubicua):** El lider logistico MUST ver solo sus propios pedidos de efectivo no recibido, con el
  total que debe.
- **RF_07 (ubicua):** La lista MUST incluir pedidos de cualquier antiguedad. No puede depender de la
  ventana de pedidos que descarga el navegador (constitucion, principio 8): un pedido de junio es
  justamente el que mas importa.
- **RF_08 (ubicua):** La lista MUST distinguir el efectivo de producto que se le debe a un proveedor, para
  que en una liquidacion se sepa de antemano que parte no se puede pagar todavia.

## 4. Requisitos no funcionales

- **RNF_01 (rendimiento):** El total y la lista MUST calcularse en servidor (constitucion, principio 11).
  El navegador del administrador MUST NOT bajar el historico para obtenerlos.
- **RNF_02 (coherencia):** El total de efectivo no recibido MUST coincidir con lo que la posicion de la
  plataforma ya llama "por cobrar al domiciliario".

## 5. Casos limite

- **Pedido corregido de entregado a fallido despues de la entrega:** sale de la lista; ya no hay efectivo
  que recibir.
- **Corte de domiciliario pendiente que cubre el pedido en parte:** cuenta como no recibido hasta que el
  corte lo cubra.
- **Contraentrega con recaudo de $1** (pedidos de prueba o mal digitados, como KNT-005242): debe aparecer,
  pero sin disparar el aviso de RF_05 por montos insignificantes; decidir el umbral.
- **Pedido sin lider** (el caso de la spec 017): debe aparecer, y debe verse que no tiene a quien cobrarle.
- **El mismo lider con muchos pedidos vencidos:** el aviso de RF_05 SHOULD agruparlos en vez de mandar uno
  por pedido.

## 6. Fuera de alcance

- Cobrarle al domiciliario o descontarle de forma automatica.
- Cambiar como se crean o cubren los cortes de domiciliario.
- Aclarar los 24 pedidos de mas de 30 dias que hay hoy: es tarea operativa. Esta spec los hace visibles.

## 7. Definition of Done

1. Una prueba demuestra RF_01: la regla de "recibido" es la misma funcion que usa la liquidacion de tienda
   y proveedor.
2. Una prueba demuestra RF_07: un pedido entregado meses antes de la ventana aparece en la lista.
3. Contra produccion, la lista del administrador muestra los 24 pedidos de mas de 30 dias del 2026-10-02
   (o su estado actualizado) con el mismo total medido aqui.
4. El total coincide con "por cobrar al domiciliario" de la posicion de la plataforma (RNF_02).
5. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
6. El responsable de la plataforma firma la entrega.

## 9. Decisiones de aprobacion (2026-10-02)

Respuestas del responsable a las preguntas abiertas del plan (`specs/026_plan.md`), aprobadas con las
propuestas por defecto:

- **Total que ve el admin: recaudo bruto** (P1), con una conciliacion por causa contra "por cobrar al
  domiciliario" de la posicion de la plataforma. RNF_02 se lee como "coincide salvo diferencias explicadas
  por causa, con residuo $0".
- **Canal del aviso: webhook generico** (P2), configurable por secreto (sirve para Discord, Slack o Google
  Chat). Sin URL configurada, el aviso solo se ve en la app.
- **Umbral del aviso: $20.000 pendientes** (P3), configurable junto al plazo.
- El resto de preguntas abiertas del plan (P4-P8) se resuelven con la opcion propuesta en el propio plan:
  plazo global, aviso diario 08:00 Bogota, la primera corrida marca el atraso actual como avisado en un
  solo mensaje, se incluyen los pedidos `liquidated`.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-02 | Borrador inicial | 153 contraentregas entregadas sin efectivo recibido ($14.557.721); 24 de mas de 30 dias, todas de un mismo lider; $1.551.550 de producto de LAB sin poder pagarse |
| 2026-10-02 | Aprobada con las decisiones de la seccion 9 | Directiva del responsable (`/goal`), respuestas por defecto del plan |
