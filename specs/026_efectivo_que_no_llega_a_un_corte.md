# Spec 026: Que nadie descubra a los tres meses que el efectivo de una entrega nunca llego

- **Estado:** aprobada (2026-10-02, por el responsable de la plataforma, con las decisiones de la seccion 9;
  enmendada el mismo dia, ver seccion 9 "Enmienda" y el historial)
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

**Lo que mostro el analisis (2026-10-02):** esos 24 **no son efectivo perdido**. Estan en cortes ya
pagados o conciliados en los que el lider entrego **exactamente** lo esperado (`cashReceivedCop ==
cashExpectedCop`, `cashPendingCop` 0). El corte calcula lo esperado en agregado, neteando el pago del
domiciliario (por ejemplo, visitas fallidas), pero la regla de "recibido" reparte lo entregado pedido a
pedido solo entre los que deben efectivo, y los 1-3 mas nuevos de cada corte quedan sin cubrir. En
produccion son **29 cortes, 36 pedidos, $1.151.997 (unidad por confirmar en T1)**, y entre ellos estan los
24. Esta spec los muestra **aparte**, como "cubiertos por compensacion"; corregir la regla de fondo es la
spec 027 (borrador).

Nadie lo vio hasta que hubo que pagarle a un proveedor y la cifra no cuadro. No hay error, no hay aviso:
el dinero simplemente no aparece como recibido. Puede ser efectivo que se entrego y no quedo en un corte,
efectivo que de verdad se debe, o efectivo que el corte ya saldo en total aunque la regla por pedido no lo
reconozca. Desde la plataforma no se distingue, y esa es la falla.

**Objetivo:** que el efectivo de una contraentrega entregada que no llega a un corte en un plazo razonable
se vea a tiempo, en un solo sitio, con quien lo tiene y desde cuando, **separado** del que un corte ya saldo
por compensacion, para que la alerta hable solo de dinero que de verdad falta.

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
  administrador. Un pedido **cubierto por compensacion** (RF_09) MUST NOT contar como vencido ni sumar al
  total vencido.
- **RF_04 (ubicua):** El plazo MUST ser configurable por el administrador. Por defecto SHOULD ser de 7
  dias.
- **RF_05 (evento):** **Cuando** un pedido pase el plazo, el sistema SHOULD avisar al responsable de la
  plataforma por un canal que no exija abrir la app, una sola vez por pedido (ver seccion 9: "al menos una
  vez"). Un pedido cubierto por compensacion (RF_09) MUST NOT disparar el aviso.
- **RF_06 (ubicua):** El lider logistico MUST ver solo sus propios pedidos de efectivo no recibido, con el
  total que debe.
- **RF_07 (ubicua):** La lista MUST incluir pedidos de cualquier antiguedad. No puede depender de la
  ventana de pedidos que descarga el navegador (constitucion, principio 8): un pedido de junio es
  justamente el que mas importa.
- **RF_08 (ubicua):** La lista MUST distinguir el efectivo de producto que se le debe a un proveedor, para
  que en una liquidacion se sepa de antemano que parte no se puede pagar todavia.
- **RF_09 (estado, enmienda 2026-10-02):** **Mientras** un pedido que la regla de RF_01 no da por recibido
  este en un corte de domiciliario pagado o conciliado cuyo efectivo total quedo saldado (`cashPendingCop`
  0 y recibido igual o mayor que lo esperado), el sistema MUST mostrarlo **aparte**, como "cubierto por
  compensacion", y MUST NOT tratarlo como pagado con faltante. Esto no cambia ningun saldo ni la regla de
  RF_01.

## 4. Requisitos no funcionales

- **RNF_01:** (rendimiento) El total y la lista MUST calcularse en servidor (constitucion, principio 11).
  El navegador del administrador MUST NOT bajar el historico para obtenerlos.
- **RNF_02:** (coherencia) El total de efectivo no recibido MUST coincidir con lo que la posicion de la
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
- **Corte pagado en el que el lider entrego todo lo esperado pero la regla por pedido deja pedidos sin
  cubrir:** aparecen como "cubiertos por compensacion" (RF_09), no como vencidos ni como faltante.

## 6. Fuera de alcance

- Cobrarle al domiciliario o descontarle de forma automatica.
- Cambiar como se crean o cubren los cortes de domiciliario (incluida la regla por pedido que deja sin
  cubrir pedidos de un corte saldado: es la spec 027).
- Aclarar los 24 pedidos de mas de 30 dias que hay hoy: es tarea operativa. Esta spec los hace visibles.

## 7. Definition of Done

1. Una prueba demuestra RF_01: la regla de "recibido" es la misma funcion que usa la liquidacion de tienda
   y proveedor.
2. Una prueba demuestra RF_07: un pedido entregado meses antes de la ventana aparece en la lista.
3. Contra produccion, los 36 pedidos de los 29 cortes saldados por compensacion (entre ellos los 24 de mas
   de 30 dias del 2026-10-02) aparecen como "cubiertos por compensacion" y no como vencidos; el resto de la
   lista del administrador cuadra con la medicion de la linea base (T1), y cada pedido que cambie de grupo
   entre la linea base y la verificacion tiene su motivo anotado.
4. El total coincide con "por cobrar al domiciliario" de la posicion de la plataforma (RNF_02).
5. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
6. El responsable de la plataforma firma la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-02 | Borrador inicial | 153 contraentregas entregadas sin efectivo recibido ($14.557.721); 24 de mas de 30 dias, todas de un mismo lider; $1.551.550 de producto de LAB sin poder pagarse |
| 2026-10-02 | Aprobada con las decisiones de la seccion 9 | Directiva del responsable (`/goal`), respuestas por defecto del plan |
| 2026-10-02 | Enmienda: RF_09 "cubierto por compensacion", RF_03, RF_05, objetivo, cifras base, DoD 3, seccion 9 (compensacion, "al menos una vez", pendiente ausente); spec 027 en borrador | Cuarta pasada de `/sdd-analyze`: los 24 pedidos de mas de 30 dias estan en 29 cortes saldados en total (36 pedidos, $1.151.997, unidad por confirmar en T1). Decidido por el responsable |
| 2026-10-02 | Retoques: unidad de $1.151.997 por confirmar en T1; nota sobre el texto visible "una vez"; seccion 9 tras la 8 | Quinta pasada de `/sdd-analyze` |

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

### Enmienda (2026-10-02, tras la cuarta pasada de `/sdd-analyze`)

- **Cubierto por compensacion — decidido por el responsable 2026-10-02 (opcion a).** Un pedido que la regla
  por pedido no da por recibido, pero que esta en un corte de domiciliario pagado o conciliado con el
  efectivo total saldado (`cashPendingCop` 0 y recibido >= esperado), es un estado propio: se muestra
  aparte, no cuenta como vencido, no dispara el aviso externo y no es "pagado con faltante" (RF_09). No
  cambia ningun saldo ni la regla de cobertura; la correccion de fondo de la regla queda en la spec 027
  (borrador). Cifra medida el 2026-10-02: 29 cortes, 36 pedidos, $1.151.997 (unidad por confirmar en T1),
  que incluyen los 24 de mas de 30 dias.
- **"Una sola vez por pedido" (RF_05) se implementa como "al menos una vez" — aceptado.** Si el aviso sale
  y falla el registro de que salio, el pedido se repite en la corrida siguiente. Lo contrario (registrar
  antes de enviar) puede perder un aviso, que es peor. Cada corrida queda registrada para auditarlo. El
  texto visible al usuario (pantalla `HU_01.plazo`) conserva "una vez por pedido": la repeticion solo
  ocurre ante un fallo del marcado, no en el funcionamiento normal.
- **Pendiente de corte ausente.** Hay cortes de domiciliario creados sin `cashPendingCop`; la posicion de
  la plataforma lo trata como 0 y esta spec hace lo mismo, con la diferencia visible en la conciliacion.
