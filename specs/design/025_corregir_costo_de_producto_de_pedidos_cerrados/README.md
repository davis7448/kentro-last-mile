# Diseno — Spec 025: corregir el costo de producto de pedidos cerrados

Sistema "Acid Glass" (`docs/design-system.md`). Consola de admin: tema oscuro, controles de 44 px.
Los textos visibles van sin tildes, como el resto de `operations-app.tsx`. Accesibilidad: WCAG 2.2 AA.

**Estado de observacion:** ninguna pantalla se observo. En esta maquina no hay navegador de diseno, asi
que los 13 dibujos estan **degradados / sin observar**. Nadie los ha visto renderizados; las medidas de
texto se estimaron, no se midieron.

## Donde vive

Hay una **cuarta pestana en Liquidaciones: "Costo de producto"** (`LIQUIDATION_TABS`). No va en el riel,
porque no es un trabajo aparte: es una pregunta dentro del trabajo de liquidar ("¿se desconto bien el
producto?"), y se consulta justo antes de pagar a tiendas y proveedores. Las cuatro pestanas caben a
1280 en una sola fila; a 375 ocupan dos filas (`flex-wrap`, que ya existe).

La pestana tiene:
- selector **Tienda** (RF_10 y el corrector trabajan por tienda; P9 del plan);
- acciones: **Corregir costo** (primaria, acido) y **Registrar cruce** (secundaria, cristal);
- panel abierto **Productos a $0 con pedidos entregados** (RF_10). Si esta vacio, se ve una sola linea
  de confirmacion, porque aqui el vacio es una buena noticia que el admin viene a comprobar;
- panel plegado **A $0 a proposito o pagados por fuera** (marcas `zeroCostIntended` /
  `costPaidOutsideKentro`): se listan, pero no empujan a corregir;
- panel plegado **Correcciones aplicadas** (HU_03), con **Revertir** por fila.

**Ficha (Inventario):** el retro-cobro del navegador al guardar una ficha se retira (P7). En su lugar,
al guardar una ficha que pasa de $0 a un costo y tiene pedidos entregados, sale un aviso: "Esta ficha
tiene N pedidos entregados sin costo cobrado. Abrir corrector", que abre el corrector con la tienda y el
producto ya marcados. "Poner costo" en la lista de huecos lleva a esa ficha.

## Flujo

1. Huecos (HU_01) -> Poner costo (ficha) -> Corregir costo.
2. Corrector, fase 1 (`HU_02.corrector`): tienda, productos (solo los que tienen costo en la ficha; los
   `$0 a proposito` no se pueden marcar), rango de cierre opcional, motivo (10 caracteres como minimo).
   El boton es **Previsualizar cambios**.
3. Fase 2 (`HU_02.vista-previa`), en el mismo dialogo. **Editar seleccion** vuelve a la fase 1 y descarta
   el plan. Resumen en una sola superficie: lo que se le cobra a la tienda, lo que se le debe al
   proveedor, lo pagable ahora frente a lo que espera efectivo, y el saldo abierto antes y despues.
   Debajo, conteos, historia reconocida y la tabla por pedido, paginada de 6 en 6 en movil y de 10 en
   escritorio. Luego la casilla "Entiendo..." y **Aplicar correccion** en rust: es el mismo patron que
   `Corregir estado del pedido`.
4. Si un pedido tiene una linea que no empareja, su fila muestra **Elegir ficha**, que abre
   `HU_02.elegir-ficha`. Al volver se recalcula la vista previa.
5. Bloqueos: la casilla y el boton de aplicar quedan desactivados mientras haya bloqueos. Cada bloqueo
   ofrece su salida: **Excluir <pedido>** (va a `excludeOrderIds`) o **Quitar la ficha elegida**.
   Ningun bloqueo se salta en silencio.

### Vista previa: columna "Queda"

| Valor | Cuando |
|---|---|
| Pagable | entra al proximo corte y ya se puede pagar |
| Pagable · prepagado | igual, pero Kentro no recaudo nada y la tienda puede quedar en negativo |
| Esperando efectivo | contra entrega con el efectivo aun en manos del domiciliario |
| Proximo corte (el suyo X ya se pago) | `existingInFrozenSettlement` |
| Sin movimiento | diferencia 0, ya corregido o lo cobrado manda |
| Bloqueado | ver bloqueos |

### Mensajes de avisos y bloqueos (codigos del plan 4.4)

| Codigo | Tipo | Titulo | Texto |
|---|---|---|---|
| `charged_but_unmatched` | aviso, info | Cobro doble evitado: <pedido> | Ya tiene <importe> cobrados con la ficha <ficha>. Hoy su linea no empareja, pero lo cobrado manda y no se toca. |
| `cost_not_configured` | aviso | <producto> no tiene costo en la ficha | Ponle costo en Inventario y vuelve a previsualizar. |
| `prepaid_negative_balance` | aviso, rust | La tienda queda en negativo | <tienda> pasa de <antes> a <despues>: hay pedidos prepagados donde Kentro no recaudo nada. |
| `override_may_double_charge` | bloqueo | No se puede aplicar: N pedido(s) bloqueado(s) | <pedido> · posible cobro doble. Le elegiste la ficha X a la linea N, pero el pedido ya tiene <importe> cobrados con la ficha Y, que hoy ninguna linea empareja. |
| `unattributed_cost_entry` | bloqueo | idem | <pedido> tiene un costo cobrado que no se puede atribuir a un producto. Excluyelo y revisalo a mano. |
| `supplier_mismatch` | bloqueo | idem | <pedido>: lo cobrado fue para <proveedor A> y la ficha hoy es de <proveedor B>. No se mueve deuda entre proveedores. |
| `too_many_writes` | bloqueo | Demasiados pedidos para una sola vez | Son N escrituras y el maximo es 450. Acota el rango de cierre. |
| huella distinta al aplicar | error | Los pedidos cambiaron desde la vista previa | Vuelve a previsualizar. No se escribio nada. |
| `already_reverted` | bloqueo (revertir) | Ya revertida | Esta correccion se revirtio el <fecha> por <admin>. |
| `movement_missing` | bloqueo (revertir) | Falta un movimiento | <pedido>: el movimiento de esta correccion ya no existe. No se revierte a medias. |
| `later_correction_exists` | aviso (revertir) | Hay una correccion posterior en <pedido> | Revertir esta no la deshace. |
| `cross_already_present` | aviso (cruce) | <pedido> ya tiene un cruce de <proveedor> | Revisa que no sea el mismo. |

Los avisos con tono info (#7cc4ff) avisan de que algo se protegio. Los rust piden atencion. La salida de
un bloqueo siempre es un boton dentro de la propia tarjeta.

## Estados

| Estado | Lista de huecos (HU_01) | Corrector y reversion |
|---|---|---|
| Cargando | esqueleto + `role=status` "Cargando productos a $0" (`HU_01.cargando`) | "Calculando..." en el boton; el formulario queda bloqueado |
| Vacio | "Ningun producto a $0 con pedidos entregados" (`HU_01.vacio`) | plan sin movimientos: "Nada que corregir: todos los pedidos ya tienen su costo" y sin boton de aplicar |
| Error | `role=alert` y **Reintentar**; nunca una lista a medias (`HU_01.error`) | mensaje rust bajo el formulario, se conserva lo escrito |
| Exito | — | el dialogo se cierra, aparece un aviso "Correccion aplicada: N pedidos, <importe>" y la fila nueva sale arriba en Correcciones aplicadas |
| Sin permiso | la pestana no existe para quien no es admin (Liquidaciones es solo admin) | la callable devuelve 403 y se muestra "Solo el administrador puede corregir costos" |

## Cruce (RF_08), `HU_02.cruce`

Siempre va por pedido. El importe tiene un tope de $2.000.000 por pedido, el de la spec 022, que se
valida antes de enviar. Tiene vista previa y confirmacion con el mismo patron que el corrector, y se
revierte desde Correcciones aplicadas.

## Reversion (HU_03)

- **`HU_03.correcciones`**: la tabla de correcciones de la tienda. Lo escrito a mano el 30 sep aparece
  como bloque reconocido, sin boton de revertir (P8).
- **`HU_03.revertir`**: dice que pasa con cada movimiento: **Se borra** (sigue abierto en las dos
  cuentas) o **Se compensa** (ya entro en un corte). Antes del texto va el importe del movimiento
  original.
  **Nota para quien lo construya:** en el dibujo el "+$23.000" de cada fila es el movimiento original.
  En la fila compensada conviene mostrar las dos cifras ("movimiento +$23.000 · compensa -$23.000")
  para que no se lea como un abono nuevo.

## HU_04 (sin interfaz): el concepto que ve la tienda en su corte

Es el `description` del asiento. Va en lenguaje de tienda, sin ids internos ni las palabras "asiento",
"delta" o "override". Ocupa como mucho 90 caracteres y lleva la guia al final.

| Caso | Texto |
|---|---|
| Cobro de costo que faltaba | `Costo de producto pendiente · Chest Relief x2 a $24.000 · KNT-004402` |
| Ajuste por costo distinto | `Ajuste de costo de producto · Kit Cuidado Completo: $42.000 -> $50.000 · KNT-004512` |
| Devolucion | `Devolucion de costo de producto · Lemme (lo pagas por fuera de Kentro) · KNT-004480` |
| Reversa | `Se anula un ajuste de costo de producto · Lemme · KNT-004480` |
| Cruce | `Cruce: Envios que asume ADMA LAB · KNT-004480` |

## Datos de ejemplo

Salen de la liquidacion de ADMA LABORATORIO del 30 sep: Nambu, Bella Mujer y LuminXP como tiendas y
ADMA LABORATORIO como proveedor. En la spec no consta la tienda de KNT-004603 ni de su ficha Tentacion:
el dibujo la pone en Bella Mujer **solo como ilustracion**. Los costos por unidad (25.000 / 24.000)
estan elegidos para que Nambu sume los $926.000 reales.
