# Spec 040: Cada bodega imprime lo suyo

- **Estado:** aprobada (2026-11-12, por el responsable; decisiones D1-D4 en la seccion 9)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-11-12

## 1. Contexto y objetivo

Kovia vende productos de **dos proveedores**, y cada uno despacha desde su bodega:

| Proveedor (`suppliers`) | Productos de Kovia en `productCatalog` |
|---|---|
| ADMA LABORATORIO (`sup-1781914882801`) | Joint health (SKU 94030000), CEELIKE crema dental (93070000 y 93070000ADMA) |
| ADMA COMPANY (`sup-1781914554522`) | KAHI Wrinkle Bounce Multi Balm 9g (33680000), y dos "PRODUCTO PRUEBA" |

Hoy, cuando se imprimen los rotulos, sale todo en un solo fajo: no hay forma de darle a cada bodega solo lo
que le toca. Esta spec hace que **cada proveedor reciba su propia tanda de rotulos, con solo sus productos**.

### Como funciona hoy (leido en el codigo)

- **El rotulo** lo pinta `printOrderLabels` (`src/components/operations-app.tsx`): una etiqueta de 100x150 mm
  por pedido, con codigo KNT, QR, barras, cliente, direccion (spec 013, `orderAddressLines`), y **un unico
  bloque de producto** con `order.productName`, `order.sku` y `order.quantity`. Esos tres campos son el
  resumen colapsado que arma `summarizeShopifyLineItems` (`"A x1 + B x2"`, `"SKU1 + SKU2"`, suma de
  cantidades). El rotulo **no lee `lineItems[]`** ni sabe de proveedores.
- **Donde se imprime:** el admin tiene "Imprimir pendientes", "Rotulos bodega pendientes" (solo
  `fulfillmentMode = warehouse`) y "Reimprimir rotulos visibles"; la tienda imprime los suyos mientras
  `canPrintSellerLabel` (listo/asignado y aun no recogido). Imprimir solo marca `labelPrintedAt/By/Count`.
- **El proveedor de un producto** vive en `productCatalog.supplierId`. El emparejamiento linea -> producto
  (por SKU, y por nombre normalizado si el producto no tiene SKU) existe dos veces: `matchCatalogForLine`
  en `functions/src/wallet-entries.ts` (el que cobra) y `findCatalogMatch` en `src/lib/finance.ts`.
  Al cerrar, cada linea genera su `product_cost` con `supplierId`: **el dinero ya esta separado por
  proveedor**, solo la impresion no lo esta.
- **La recogida** sale de la tienda, no del producto: las cinco vias de importacion copian
  `seller.pickupPointName/pickupAddress` al pedido, y `orders.ts` agrupa los lotes de recogida por ese
  punto. Kovia tiene un solo punto, "Kovia", **sin direccion**.
- **Permisos:** la tienda lee su `productCatalog` (con `supplierId`) pero **no** la coleccion `suppliers`
  (solo admin), asi que hoy la tienda no podria ver el nombre del proveedor.

### Como vienen los pedidos de Kovia (medido en produccion, solo lectura, 2026-11-12)

- **192 pedidos** en total, todos `seller_pickup`, 186 con punto de recogida "Kovia" (6 sin punto).
- **Pedidos que mezclan los dos proveedores: 0.** Solo **un** pedido en toda la historia tuvo mas de una
  linea (KNT-002718, dos "PRODUCTO PRUEBA" de COMPANY, anulado).
- Por mes, pedidos con producto de cada proveedor:

  | Mes | Total | LAB | COMPANY |
  |---|---|---|---|
  | 2026-05 | 11 | 11 | 0 |
  | 2026-06 | 17 | 17 | 0 |
  | 2026-07 | 23 | 21 | 1 (prueba) |
  | 2026-08 | 37 | 37 | 0 |
  | 2026-09 | 28 | 28 | 0 |
  | 2026-10 | 41 | 35 | 6 |
  | 2026-11 (hasta el 12) | 35 | 24 | 11 |

  El KAHI (COMPANY) empezo el 2026-10-14 y ya es un tercio de noviembre.
- 1 pedido con una linea que no empareja con el catalogo (sin SKU ni nombre).
- Quien imprime: admin 116, la tienda 24, sin imprimir 52.

**Conclusion:** el problema real de hoy no es partir un pedido, es que **la tanda** mezcla pedidos de las dos
bodegas. El pedido mixto todavia no existe, pero la spec lo cubre porque es la consecuencia natural de
vender los dos productos en la misma tienda.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** administrador **quiero** imprimir los rotulos pendientes de una tienda
  separados por proveedor **para** entregarle a cada bodega solo su tanda.
- **HU_02 (interfaz):** **Como** bodega **quiero** que cada rotulo que recibo muestre solo mis productos y
  cantidades **para** no empacar ni buscar lo que despacha la otra bodega.
- **HU_03 (interfaz):** **Como** mensajero **quiero** que un pedido que llega en dos paquetes lo diga en
  cada rotulo ("paquete 1 de 2") **para** no entregar ni cerrar el pedido con un paquete de menos.
- **HU_04 (sin interfaz):** **Como** responsable **quiero** que el cobro, el corte y el ciclo de vida del
  pedido no cambien **para** que separar la impresion no mueva dinero.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El sistema MUST asignar cada linea de un pedido a un proveedor con **la misma regla
  de emparejamiento que genera el `product_cost`**; no MAY existir una segunda regla para la impresion.
  Un pedido sin `lineItems[]` MUST tratarse como una sola linea con `productName/sku/quantity`, como ya
  hace el cobro.
- **RF_02 (ubicua):** Cuando todas las lineas de un pedido son del mismo proveedor, el sistema MUST
  imprimir **un** rotulo, como hoy, y MUST mostrar en el el nombre de ese proveedor.
- **RF_03 (evento):** **Cuando** se imprime un pedido cuyas lineas son de **dos o mas** proveedores, el
  sistema MUST imprimir **un rotulo por proveedor**, cada uno con solo las lineas (nombre, SKU, cantidad)
  de ese proveedor, el mismo codigo KNT, QR y barras, y la marca "Paquete N de M".
- **RF_04 (ubicua):** Todo rotulo MUST conservar lo que lleva hoy: direccion e indicaciones (spec 013),
  cliente, "COBRAR $X"/"PAGADO" y zona. El importe a cobrar MUST ser el **total del pedido** y MUST
  aparecer **solo en el paquete 1**; los demas paquetes dicen "Sin cobro — va con el paquete 1" (D3).
- **RF_05 (evento):** **Cuando** el administrador imprime una tanda (pendientes, bodega o reimpresion), el
  sistema MUST ordenarla por proveedor y MUST abrir cada proveedor con una **hoja de tanda**: nombre del
  proveedor, fecha, numero de rotulos y la suma de unidades por producto.
- **RF_06 (evento):** **Cuando** el administrador lo elige, el sistema MUST permitir imprimir la tanda de
  **un solo proveedor** (selector de proveedor junto a los botones de impresion).
- **RF_07 (si):** **Si** una linea no empareja con ningun producto del catalogo, o empareja con un
  producto sin proveedor, el sistema MUST imprimirla en un grupo "Sin proveedor asignado" y MUST avisarlo
  en la hoja de tanda; MUST NOT asignarla a una bodega por descarte.
- **RF_08 (ubicua):** Imprimir MUST seguir marcando el pedido como impreso una sola vez por impresion
  (`labelPrintCount` sube 1 por pedido, no por paquete). Marcar como impreso solo los paquetes de un
  proveedor esta fuera de alcance (seccion 6).
- **RF_09 (ubicua):** Una tienda con un solo proveedor, o cuyos productos no tienen proveedor, MUST ver el
  rotulo igual que hoy salvo por el nombre del proveedor de RF_02 (si lo tiene).
- **RF_10 (ubicua):** El selector de proveedor y la hoja de tanda MUST existir solo para el administrador
  (D4). La tienda MUST seguir imprimiendo como hoy, con el pedido mixto partido en paquetes (RF_03).

## 4. Requisitos no funcionales

- **RNF_01:** La particion pedido -> paquetes por proveedor vive en un modulo puro (`src/lib/`, con pruebas).
  La regla de emparejamiento se reutiliza, no se copia: una prueba MUST atar la particion de la impresion
  al `resolveProductCostLinesForOrder` del cobro sobre los mismos pedidos, como hace
  `platform-position.test.ts` (constitucion 3). Si `findCatalogMatch` y `matchCatalogForLine` difieren
  hoy, la prueba lo destapa y se corrige en el plan.
- **RNF_02:** Cero cambios en `walletEntries`, cortes, tarifas, `status`, `driverId` ni en las vias de
  importacion. Imprimir sigue escribiendo solo los campos `label*` (constitucion 5).
- **RNF_03:** Sin descargas nuevas ni cambios de reglas: el admin ya baja `suppliers` y `productCatalog`.
  La tienda no tiene selector (D4); su rotulo se parte igual (lee su `productCatalog`), pero como no puede
  leer `suppliers` muestra "Paquete N de M" sin nombre de proveedor. MUST NOT abrirsele `suppliers`.
- **RNF_04:** El rotulo sigue cabiendo en 100x150 mm. Con muchas lineas de un proveedor, el bloque de
  productos MUST recortar con "+N mas" antes que desbordar la etiqueta.

## 5. Casos limite

- Pedido de un solo proveedor con dos lineas (CEELIKE x1 + Joint health x1, ambos LAB): **un** rotulo con
  las dos lineas.
- Pedido mixto con el mismo SKU repetido en dos lineas: se suman por producto, como el cobro.
- Pedido sin `lineItems[]` (31 de Kovia, los mas viejos): una linea con los campos colapsados; si el
  `sku` colapsado es `"A + B"` no empareja y cae en "Sin proveedor asignado" (RF_07), igual que hoy no
  genera costo. Se deja visible, no se adivina.
- "Envio prioritario" ya no esta en `lineItems[]` (lo quita la importacion): no genera paquete.
- Reimprimir un pedido mixto: vuelven a salir todos sus paquetes.
- Un producto cambia de proveedor en el catalogo despues de imprimir: la reimpresion usa el proveedor
  vigente, igual que `closeOrder` lee el catalogo en vivo.
- Pedido mixto con un proveedor sin stock: fuera de alcance (no hay entrega parcial; ver seccion 6).

## 6. Fuera de alcance

- Puntos de recogida por proveedor: las dos bodegas entregan en un mismo punto (D1). Si algun dia el
  mensajero tiene que recoger en dos sitios, es su propia spec: toca las cinco vias de importacion y los
  lotes de recogida.
- Partir un pedido en dos pedidos, entrega parcial o un cobro de envio por paquete.
- Marcar como impreso por paquete/proveedor.
- Cambiar quien paga el producto al proveedor: el `product_cost` ya va por proveedor.

## 7. Definition of Done

1. Pruebas de RF_01, RF_02, RF_03, RF_07, RF_08 y la prueba de RNF_01 contra el cobro, en verde.
2. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
3. Capturas (modo local, sin tocar produccion) de: rotulo de un proveedor, pedido mixto en dos paquetes,
   hoja de tanda, y grupo "Sin proveedor asignado".
4. El admin imprime en produccion la tanda pendiente de Kovia y salen dos fajos, LAB y COMPANY.
5. El responsable valida el resultado con las dos bodegas.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-12 | Borrador inicial con medicion de produccion | Kovia despacha de dos bodegas (ADMA LAB y ADMA COMPANY) y el rotulo sale todo junto |
| 2026-11-12 | Preguntas P1-P4 decididas (D1-D4), todas con la recomendacion; RF_10 nuevo, RNF_03 ajustado | Respuestas del responsable |
| 2026-11-12 | Aprobada | "Apruebo la spec" del responsable |
| 2026-11-12 | Plan aprobado e implementado (sin commit ni despliegue) | "Aprobar e implementar" del responsable |

## 9. Decisiones del responsable (2026-11-12)

- **D1 — Recogida:** las dos bodegas entregan en **un mismo punto**; esta spec solo toca la impresion.
- **D2 — Pedido mixto:** sigue siendo **un solo pedido**: un mensajero, un cobro contraentrega, un envio
  cobrado a la tienda. Ni el dinero ni el corte cambian (RNF_02).
- **D3 — Cobro en el rotulo:** "COBRAR $X" **solo en el paquete 1**.
- **D4 — Quien imprime por proveedor:** **solo el admin**; la tienda ve el rotulo partido sin selector.
