# Spec 020: El listado de pedidos filtra por la fecha de cierre, no por la de creacion

- **Estado:** borrador (propuesto por el informe de cierre de la spec 019, 2026-09-19)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-19
- **Origen:** fuera de alcance consciente de la 019, seccion 6, primer punto: *"El eje de fecha del
  listado de pedidos... Tiene su propia spec."* Esta es esa spec.
- **Prioridad:** alta — es la **causa raiz** del fallo que la 019 tapo en la pantalla del corte

## 1. Contexto y objetivo

La ventana de descarga de pedidos cerrados corta por **`createdAt`**. Tambien filtran por `createdAt`
los listados de tienda y de administrador. Pero un pedido de ultima milla **no se cierra el dia que
nace**: se crea cuando la tienda lo importa y se cierra cuando el mensajero lo entrega, dias despues.

Medido contra produccion el **2026-09-19** para este borrador (5.103 pedidos):

| | |
|---|---:|
| Pedidos cerrados en septiembre | 1.062 |
| De ellos, con fecha de cierre **distinta** de la de creacion | **1.060 (99,8 %)** |

Es decir: filtrar por creacion es, en la practica, filtrar por el dia equivocado **siempre**. La
medicion que dio origen a la 019 lo dijo con otras palabras el mismo dia: filtrar los pedidos de DANDA
por "17 de septiembre" devolvia **0 de 70**.

**Que consecuencias tuvo ya.** La 019 existe porque 66 de las 185 filas del detalle de un corte salian
en $0: sus pedidos se habian creado antes de la ventana aunque se cerraran dentro de ella. La 019
resolvio el sintoma rescatando esos pedidos por id, uno a uno, contra un tope de 800 lecturas
compartido. **No toco el eje**, a proposito (seccion 6 de la 019). Mientras el eje siga en `createdAt`,
cada pantalla que dependa de "lo que paso esta semana" tendra que pagar su propio rescate.

**Objetivo:** que "los pedidos del 17 de septiembre" signifique los que se cerraron ese dia, y que la
ventana de descarga de cerrados se corte por el mismo eje, para que rescatar por id deje de ser la
unica forma de ver el dinero de la semana.

## 2. Historias de usuario

- **HU_01:** **Como** tienda **quiero** que al filtrar por un dia vea los pedidos que se entregaron ese
  dia **para** cuadrar mis ventas con lo que me liquidan.
- **HU_02:** **Como** administrador **quiero** lo mismo en el listado y en los indicadores **para** no
  tener que exportar y recalcular fuera de la plataforma.
- **HU_03:** **Como** lider logistico **quiero** que los pedidos de mi corte esten descargados sin
  rescate **para** que el detalle salga completo a la primera y no consuma el tope de lecturas.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** Un pedido **cerrado** (entregado, liquidado, fallido o anulado) MUST situarse en
  los listados y filtros por su **fecha de cierre**; un pedido **abierto** MUST situarse por su fecha de
  creacion, porque todavia no tiene otra.
- **RF_02 (ubicua):** La ventana de descarga de pedidos cerrados MUST cortarse por el mismo eje que el
  filtro que la consume. Las dos vias —`getWindowedOrders` en la carga inicial y `orderTargets` en la
  suscripcion— MUST usar el mismo eje, o el primer pintado divergira del listener (`CLAUDE.md`, mapa del
  codigo).
- **RF_03 (evento):** **Cuando** un pedido se cierre, el sistema MUST grabar su fecha de cierre en un
  campo propio, indexable y estable, que no se mueva con ediciones posteriores del pedido.
- **RF_04 (ubicua):** Los pedidos ya cerrados sin ese campo MUST recibirlo por relleno, sin cambiar
  ningun otro dato del pedido (principio de la 017: una escritura de mantenimiento no cambia de dueno a
  un pedido).
- **RF_05 (ubicua):** Las cifras de dinero ya en pantalla —saldo de tienda, posicion de plataforma,
  cabecera de un corte— MUST NOT cambiar de valor por este cambio. Es un cambio de **eje de consulta**,
  no de aritmetica.
- **RF_06 (ubicua):** La UI MUST decir por que eje esta filtrando, para que "no aparece" nunca se
  interprete como "no existe".
- **RF_07 (estado):** **Mientras** existan pedidos cerrados sin fecha de cierre rellenada, el sistema
  MUST seguir situandolos por su fecha de creacion y MUST NOT ocultarlos.

## 4. Requisitos no funcionales

- **RNF_01 (rendimiento):** Con el eje corregido, el detalle del corte medido en la 019
  (`stl-1789686589616-driver-driver-1778271901513`) MUST necesitar **menos de 66** rescates por id.
  Objetivo: cero. Se mide con `scripts/verify-019-session.js detalle`.
- **RNF_02 (rendimiento):** El presupuesto de carga por rol de `docs/rendimiento.md` MUST NOT empeorar.
  Cambiar el eje cambia **que** pedidos entran en la ventana, no cuantos.
- **RNF_03 (despliegue):** Toda consulta nueva MUST tener su indice desplegado y en `READY` **antes** de
  subir el cliente que la usa. Una consulta sin indice falla en duro y deja al rol sin pedidos
  (`CLAUDE.md`, Deploy). Los indices se **añaden**, nunca se reemplazan.

## 5. Casos limite

- **Pedido reabierto** (fallido → nueva visita, via `correctOrderStatus`): tiene dos cierres. Decidir si
  la fecha de cierre es la del ultimo o la del primero, y dejarlo escrito.
- **Pedido anulado sin haber salido** a la calle: se cierra el mismo dia que nace; el eje no lo mueve.
- **Corte a caballo entre dos dias:** un pedido entregado a las 23:50 hora local. Decidir la zona horaria
  del corte y usarla en los dos lados (servidor y cliente).
- **Correccion administrativa que cambia el estado terminal:** no debe reescribir la fecha de cierre de
  un corte ya pagado o conciliado (principio 10 de la constitucion).
- **Pedido cerrado antes del relleno** y consultado durante el despliegue: RF_07.

## 6. Fuera de alcance

- Cambiar el **tamaño** de la ventana de descarga. Aqui solo se cambia el eje.
- El rescate por id de la 019: se queda como red de seguridad, no se retira. Si RNF_01 da cero, se
  quedara sin trabajo, que es distinto de sobrar.
- Los indicadores que ya se calculan en servidor (`getOrderStats`, `getPlatformPosition`): tienen su
  propio eje y se revisan aparte.

## 7. Definition of Done

1. Una prueba demuestra RF_01 con las dos clases de pedido (abierto y cerrado) y con un pedido creado en
   un mes y cerrado en el siguiente.
2. Una guarda de fuente demuestra RF_02: las dos vias de descarga usan el mismo eje. Es exactamente el
   fallo que `CLAUDE.md` advierte y el que nadie ve hasta que el primer pintado difiere del listener.
3. Medicion contra produccion del relleno de RF_04: cuantos pedidos, cuantos cambiados, cero campos
   protegidos tocados.
4. RNF_01 medido con el corte de la 019, antes y despues.
5. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
6. Indices desplegados y `READY` antes del cliente, comparados contra prod con `firebase firestore:indexes`.
7. El responsable de la plataforma firma la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-19 | Borrador inicial | La 019 dejo el eje fuera de alcance a sabiendas; medido de nuevo para este borrador: 1.060 de 1.062 cierres de septiembre (99,8 %) caen en un dia distinto al de creacion |
