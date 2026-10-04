# Spec 022: Ningun pedido vale mil millones — un importe imposible no debe poder guardarse

- **Estado:** **aprobada** (2026-09-19) — el responsable pidio expresamente "corrigelo, y haz algo que
  evite que pasen esos errores de digitacion"
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-19
- **Origen:** fuera de alcance consciente de la 019, seccion 6, ultimo punto: *"El valor corrupto de
  KNT-003174. Se trata aparte."* Esta es esa spec — y al medirla aparecio que **no es un pedido, son
  dos**, y el segundo esta vivo.
- **Prioridad:** **p0** — hay un pedido cobrable en la calle por $11.770.047.900

## 1. Contexto y objetivo

La 019 aparto "el valor corrupto de KNT-003174" para tratarlo despues. Al buscarlo en produccion el
2026-09-19 para este borrador, se barrieron los 5.103 pedidos buscando importes imposibles (no finitos,
negativos, o por encima de $5.000.000). Salieron **dos**:

| Guia | Importe | Pago | Estado | Tienda | Creado |
|---|---:|---|---|---|---|
| KNT-003174 | **$76.506.523.000** | prepago | entregado | `seller-1783783071241` | 2026-08-06 |
| **KNT-005321** | **$11.770.047.900** | **contra entrega** | **anulado el 2026-09-19** | `seller-1783783071241` | **2026-09-19** |

**KNT-003174 ya no puede hacer daño al efectivo:** es prepago, y `orderCollectedCodCop` devuelve 0 para
todo lo que no sea contra entrega. Ensucia indicadores y el lado de la tienda, nada mas.

**KNT-005321 si.** Es contra entrega, esta en `ready_to_assign` —o sea, listo para asignarse a un
mensajero— y se creo el mismo dia que se escribio este borrador. **Si se entrega y entra en un corte, la
cabecera de ese corte pedira once mil setecientos millones de pesos en efectivo**, y esa cabecera es
justamente la cifra que la 019 acaba de consagrar como "la que se liquida". Un corte pagado o conciliado
no se reescribe (principio 10 de la constitucion): habria que compensarlo con asientos de correccion.

**Los dos son de la misma tienda y los dos son pedidos manuales** (`shopifyOrderId` `MAN-KNT-005321` y
`#Pedido Mercado libre. Medidas` — en el segundo alguien escribio texto libre donde iba el numero del
pedido). Sus lineas no traen precio unitario: el importe se tecleo entero, a mano, en el formulario. Dos
en 5.103 pedidos es una tasa baja; lo que no es bajo es el daño de cada uno.

**Objetivo:** que un importe imposible no se pueda guardar, y que los dos que ya estan guardados dejen de
estarlo por una via auditada y no por un script de una vez.

## 2. Historias de usuario

- **HU_01:** **Como** tienda **quiero** que el formulario me pare si escribo un importe absurdo **para**
  no descubrirlo cuando el mensajero ya salio.
- **HU_02:** **Como** lider logistico **quiero** que la cabecera de mi corte no pueda pedirme una cifra
  imposible **para** no tener que reclamar contra un corte ya emitido.
- **HU_03:** **Como** responsable de la plataforma **quiero** enterarme de un importe fuera de rango
  cuando entra, no tres semanas despues **para** corregirlo mientras el pedido sigue abierto.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** una persona teclee el importe de un pedido —crearlo a mano, editar uno
  importado, o ajustar lo que se cobra en la calle—, el sistema MUST rechazar el guardado si el importe
  no es finito, no es entero, es cero o negativo, o supera el tope.
- **RF_02 (ubicua):** El tope MUST ser **un solo valor con nombre**, justificado con datos, y no un
  numero magico repartido por el codigo. Valor inicial **$2.000.000**: el maximo legitimo observado en
  los 5.103 pedidos de produccion es $239.800, el percentil 99,9 es $224.775 y el mayor prepago real es
  $1.233.000. El tope deja pasar todo lo real con holgura y rechaza los dos imposibles por un factor de
  casi seis mil.
- **RF_03 (ubicua):** La comprobacion MUST vivir en **una sola funcion pura** que usen las tres
  callables que aceptan un importe tecleado, igual que `order-import-merge.ts` es la unica regla sobre
  que se conserva al reimportar. Una guarda de fuente MUST ponerse roja si alguna de ellas vuelve a
  declarar su propio `totalCop` sin pasar por ella.
- **RF_04 (error):** **Si** el importe se rechaza, el mensaje MUST decir el importe recibido y el tope,
  en pesos legibles, y el pedido MUST NOT quedar a medias: o entra entero y valido, o no entra.
- **RF_05 (interfaz):** El formulario de pedido manual MUST avisar **antes** de enviar, junto al campo,
  y MUST NOT depender solo del rechazo del servidor. Por encima de **$500.000** —el 99,99 % de los
  pedidos esta por debajo— MUST pedir una confirmacion explicita en vez de bloquear, porque una venta
  cara de verdad tiene que poder entrar.
- **RF_06 (evento):** **Cuando** un importe llegue por una via automatica (webhook de Shopify, de
  tienda, OnStock, formulario de contacto) y supere el tope, el sistema MUST registrarlo como incidencia
  y MUST NOT rechazar el pedido. Perder un pedido real de un cliente es peor que guardarlo con un
  importe raro: en septiembre de 2026 un webhook que fallaba en silencio dejo la plataforma cuatro dias
  sin pedidos. La via automatica no tiene dedos, no se equivoca al teclear.

## 4. Requisitos no funcionales

- **RNF_01 (seguridad de los datos):** El tope MUST NOT poder saltarse desde el cliente. La ultima
  palabra es del servidor.
- **RNF_02 (compatibilidad):** Ningun pedido legitimo existente puede quedar fuera del tope. Se comprueba
  barriendo la coleccion antes de fijar el valor.
- **RNF_03 (observabilidad):** Un rechazo MUST quedar registrado con guia, tienda, via de entrada e
  importe, para poder ver si es un dedo o un formato mal leido.

## 5. Casos limite

- **KNT-005321, hoy:** esta abierto. Corregirlo mientras lo este es barato; despues de entregarse, no.
  La spec debe atenderlo primero y por separado de la validacion.
- **KNT-003174:** esta entregado y es prepago. Corregir su importe mueve cifras de tienda hacia atras;
  decidir si se corrige o se marca, y dejarlo escrito.
- **Pedido legitimo caro:** una venta mayorista real por encima del tope. Entre $500.000 y $2.000.000
  entra con una confirmacion explicita de quien lo teclea (RF_05). Por encima del tope, hoy, no entra:
  subir el tope es una decision del responsable, con su fecha y su motivo en esta spec, no un cambio
  silencioso.
- **Importe como cadena con separadores** (`"1.199.900"`): al convertirlo puede dar un numero valido pero
  equivocado. Es probablemente el origen de los dos casos.
- **Moneda distinta de COP** llegando por webhook.
- **Pedido con lineas sin precio unitario**, como los dos casos: el total no se puede contrastar contra la
  suma de sus lineas. Decidir si eso, por si solo, ya es motivo de aviso.

## 6. Fuera de alcance

- Reconstruir el importe correcto de KNT-003174 a partir de su venta original: es trabajo de datos, no de
  producto.
- Validar otros campos del pedido (telefono, direccion). La 011 ya cubre los valores ausentes al guardar.
- Cambiar como se calcula el costo de producto o las tarifas.

## 7. Definition of Done

1. **KNT-005321 fuera de circulacion antes de que se asigne, por la via auditada.** ✅ Cumplido el
   2026-09-19: anulado con la callable `cancelOrder` desde una cuenta admin desechable (borrada al
   terminar), no con una escritura directa. Queda el rastro en `auditEvents`
   (`order.cancelled`, `ready_to_assign` -> `cancelled`) y el motivo en `callNote`.
2. Una prueba por cada una de las tres callables que aceptan un importe tecleado demuestra que un
   importe fuera de rango se rechaza (RF_01, RF_03).
3. Una guarda de fuente se pone roja si alguna de esas callables vuelve a declarar su propio `totalCop`
   sin pasar por la funcion comun (RF_03).
4. Una prueba demuestra que el mensaje de rechazo dice el importe y el tope en pesos legibles (RF_04).
5. Una prueba demuestra que el formulario avisa antes de enviar y que por encima del umbral de
   confirmacion no envia sin confirmar (RF_05).
6. Una prueba demuestra que una via automatica con un importe fuera de tope **no** pierde el pedido
   (RF_06).
7. Barrido de produccion que demuestre RNF_02: cero pedidos legitimos por encima del tope elegido.
8. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
9. El responsable de la plataforma firma la entrega.

**Fuera de este ciclo, por decision explicita:** KNT-003174 ($76.506.523.000, prepago, entregado en
agosto) se queda como esta. Es el unico importe imposible que sobrevive, no toca efectivo —
`orderCollectedCodCop` devuelve 0 para todo lo que no sea contra entrega— y corregirlo mueve cifras de
tienda de un mes ya cerrado. Se trata aparte, con su propia spec, o se deja documentado aqui como
conocido. Tambien queda fuera señalar en pantalla los importes fuera de rango ya guardados (el RF_06
del borrador): con KNT-005321 anulado, no hay ninguno en circulacion que señalar.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-19 | Aprobada: el tope se fija en $2.000.000 con el barrido de los 5.103 pedidos; las vias automaticas registran en vez de rechazar (un webhook que rechaza ya dejo la plataforma 4 dias sin pedidos); KNT-003174 y el señalado en pantalla salen del alcance | Peticion del responsable y datos de produccion |
| 2026-09-19 | Borrador inicial | La 019 aparto "el valor corrupto de KNT-003174"; al medirlo aparecio KNT-005321, contra entrega, `ready_to_assign` y creado ese mismo dia, por $11.770.047.900 |
