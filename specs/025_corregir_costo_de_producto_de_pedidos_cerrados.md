# Spec 025: El costo de producto de un pedido cerrado se corrige desde la plataforma, no con scripts

- **Estado:** aprobada (2026-10-02, por el responsable de la plataforma, con las decisiones de la seccion 9)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-02
- **Origen:** liquidacion de ADMA LABORATORIO del 2026-09-30. Hubo que corregir el costo de producto de
  pedidos ya cerrados con cuatro scripts escritos sobre la marcha contra produccion.
- **Prioridad:** alta — mueve dinero de tiendas y proveedores, y hoy solo se puede hacer a mano
- **Accesibilidad:** WCAG 2.2 AA

## 1. Contexto y objetivo

El costo de producto se calcula **al cerrar** el pedido con el catalogo vivo (constitucion, principio 9).
Si en ese momento el producto no tenia costo, o tenia uno equivocado, el pedido queda cerrado con ese
error y **nada en la plataforma lo arregla**: corregir el catalogo solo sirve para los pedidos que se
cierren despues.

Lo que hubo que corregir el 2026-09-30 para liquidarle a ADMA LABORATORIO:

| Que | Pedidos | Dinero |
|---|---:|---:|
| Nambu: ningun producto en el catalogo (Lung Cleansing, Chest Relief) | 37 | $926.000 |
| Bella Mujer: Amor en Doble y Bella Skin sin ficha | 3 | $70.000 |
| Bella Mujer: Kit Cuidado Completo a $42.000 en lugar de $50.000 | 2 | $16.000 |
| LuminXP: Lemme a $0; luego se supo que LuminXP le paga el producto a LAB directo y hubo que **revertirlo** | 3 | $115.000 |
| LuminXP: sus envios los asume LAB (cruce contra la cuenta por pagar) | 3 | $36.000 |

Cada fila se hizo con un script distinto contra produccion. Dos cosas salieron mal en el camino y se
atajaron por poco. Un script de revision dio por "sin costo" el pedido KNT-004603 (Tentacion), que **ya**
tenia su costo cobrado; si no se detiene, se cobra dos veces. Y la regla para no cobrar dos veces
(conservar el mismo identificador que usa el cierre) existio solo en la cabeza de quien escribio el
script. Ademas, el sistema de permisos bloqueo una de esas escrituras y hubo que darle el script al
usuario para que lo corriera el. Es exactamente el patron que la spec de correcciones de estado vino a
quitar (`correctOrderStatus` sustituyo a ocho scripts one-off).

**Objetivo:** que el administrador corrija el costo de producto de pedidos ya cerrados desde la
plataforma, viendo antes exactamente que se va a escribir, sin poder cobrar dos veces y sin reescribir
cortes ya pagados.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** administrador **quiero** ver los pedidos cerrados de una tienda cuyo
  producto no tenia costo o tenia otro **para** saber cuanto se dejo de descontar.
- **HU_02 (interfaz):** **Como** administrador **quiero** previsualizar la correccion (pedido por pedido,
  tienda y proveedor) antes de aplicarla **para** no mover dinero a ciegas.
- **HU_03 (interfaz):** **Como** administrador **quiero** revertir una correccion **para** deshacerla si
  resulta que el acuerdo era otro, como paso con LuminXP.
- **HU_04 (sin interfaz):** **Como** tienda **quiero** que el ajuste me llegue en mi siguiente corte con
  un concepto claro **para** entender por que me descuentan.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El sistema MUST permitir corregir el costo de producto de un conjunto de pedidos ya
  cerrados, usando el costo **vigente hoy** en el catalogo, por linea y producto, con la misma regla del
  cierre (constitucion, principio 9). La correccion MUST NOT tener su propia aritmetica.
- **RF_02 (ubicua):** La previsualizacion y la aplicacion MUST salir del mismo calculo, de modo que lo que
  se previsualiza es exactamente lo que se escribe (constitucion, principio 10).
- **RF_03 (ubicua):** La correccion MUST cobrar solo la **diferencia** entre lo ya descontado y lo que
  corresponde. Un pedido con su costo correcto MUST NOT producir ningun movimiento.
- **RF_04 (error):** **Si** una correccion ya se aplico a un pedido, aplicarla otra vez MUST NOT mover
  dinero.
- **RF_05 (ubicua):** Un costo ya incluido en un corte pagado o conciliado, de la tienda o del proveedor,
  MUST NOT reescribirse: la diferencia MUST compensarse en el periodo abierto (constitucion, principio 10).
- **RF_06 (ubicua):** Toda correccion MUST cargar a la tienda y abonar al proveedor del producto por el
  mismo valor, y MUST quedar auditada con quien, cuando, que pedidos y cuanto.
- **RF_07 (evento):** **Cuando** el administrador revierta una correccion, el sistema MUST dejar la
  tienda y el proveedor como estaban antes de ella, con las mismas garantias de RF_05.
- **RF_08 (ubicua):** El sistema MUST permitir un **cruce** auditado entre tienda y proveedor (que el
  proveedor asuma cargos de la tienda, como los envios de LuminXP), sin escribir asientos a mano.
- **RF_09 (ubicua):** Solo el administrador MAY previsualizar, aplicar o revertir correcciones.
- **RF_10 (ubicua):** El sistema MUST mostrar los productos activos con costo $0 que tienen pedidos
  entregados, para que un catalogo incompleto se vea antes de liquidar y no despues.

## 4. Requisitos no funcionales

- **RNF_01 (rendimiento):** Previsualizar una tienda con 400 pedidos cerrados SHOULD tardar menos de 10
  segundos, calculado en servidor (constitucion, principio 11).
- **RNF_02 (seguridad):** Ningun cambio de dinero de esta spec MUST requerir credenciales de servicio en
  la maquina de nadie: todo pasa por la plataforma con la sesion del administrador.

## 5. Casos limite

- **Producto con costo $0 a proposito** (DANDA, productos propios de ADMA COMERCIAL, productos de prueba):
  RF_10 los lista, pero no debe empujar a "corregirlos". El administrador MUST poder marcarlos como $0
  intencional.
- **Ficha nueva con nombre que cambia en cada pedido** (Kit Cuidado Completo con sufijos de la tienda,
  Tentacion con un paquete de descuento en el nombre): el emparejamiento por nombre no sirve; la
  correccion debe poder emparejar por la ficha que el administrador elija.
- **Prepagado:** Kentro no recaudo nada; el cargo deja a la tienda con saldo negativo. Debe verse antes de
  aplicar.
- **Pedido con efectivo aun en manos del domiciliario:** el abono al proveedor no es pagable hasta que
  llegue el efectivo (misma compuerta que la liquidacion).
- **Tienda que le paga el producto al proveedor por fuera de Kentro** (LuminXP con LAB): debe poder
  marcarse para que el cierre no le descuente producto.

## 6. Fuera de alcance

- Cambiar el estado de un pedido (eso es `correctOrderStatus`).
- Corregir fletes o tarifas.
- Rehacer los movimientos ya escritos a mano el 2026-09-30: quedan como estan, auditados. La correccion
  nueva MUST reconocerlos como ya aplicados y no duplicarlos.

## 7. Definition of Done

1. Una prueba demuestra RF_02: previsualizacion y aplicacion producen los mismos movimientos.
2. Una prueba demuestra RF_03 y RF_04: un pedido ya correcto o ya corregido no mueve dinero (incluye el
   caso de KNT-004603).
3. Una prueba demuestra RF_05: un corte pagado no se reescribe; la diferencia va al periodo abierto.
4. Una prueba demuestra RF_07: aplicar y revertir deja tienda y proveedor como estaban.
5. Recorrido real del administrador contra produccion corrigiendo un pedido de prueba, con evidencia.
6. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
7. El responsable de la plataforma firma la entrega.

## 9. Decisiones de aprobacion (2026-10-02)

Respuestas del responsable a las preguntas abiertas del plan (`specs/025_plan.md`), aprobadas con las
propuestas por defecto:

- **Solo se corrige el producto elegido** (P1), no se re-precia el pedido entero.
- **"Paga por fuera" es una marca de la ficha** (P2); con ella el cierre no descuenta producto.
- **Revertir borra lo que sigue abierto y compensa lo que ya entro en un corte** (P6).
- **El retro-cobro que hace hoy el navegador al guardar una ficha se retira** (P7) y lo sustituye el
  corrector de esta spec.
- El resto de preguntas abiertas del plan se resuelven con la opcion propuesta en el propio plan.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-02 | Borrador inicial | Cuatro scripts contra produccion el 2026-09-30 para corregir $1.127.000 de costo de producto (incluida una reversion) y $36.000 de cruce; un cobro doble evitado por poco |
| 2026-10-02 | Aprobada con las decisiones de la seccion 9 | Directiva del responsable (`/goal`), respuestas por defecto del plan |
