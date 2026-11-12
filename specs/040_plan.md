# Plan tecnico 040: cada bodega imprime lo suyo

Spec: `specs/040_cada_bodega_imprime_lo_suyo.md` (aprobada el 2026-11-12, decisiones D1-D4).

Este cambio solo toca la **impresion**, que ocurre entera en el navegador (`printOrderLabels` abre una ventana y
llama a `window.print()`). No hay callables, reglas, indices ni dinero que tocar: el unico cambio en servidor es
**mover** una funcion pura de `wallet-entries.ts` a su propio modulo, sin cambiarla.

## 1. Arbol de modulos

| Archivo | Responsabilidad |
|---|---|
| `functions/src/catalog-match.ts` (nuevo, puro) | `normalizeProductName` y `matchCatalogForLine`, **movidas tal cual** desde `wallet-entries.ts`. Es la unica regla linea -> producto del catalogo (RF_01). Se separa para que el cliente la importe sin arrastrar tarifas, comunidades ni asientos. |
| `functions/src/wallet-entries.ts` | Importa las dos funciones de `catalog-match.ts` en lugar de declararlas. Ningun otro cambio: `resolveProductCostLinesForOrder` y `buildWalletEntries` quedan identicas. |
| `functions/src/supplier-packages.ts` (nuevo, puro) | La particion de un pedido en paquetes por proveedor (RF_01-RF_04, RF_07) y la de una tanda en grupos por proveedor con su resumen (RF_05, RF_06). La importa la pantalla, como `seller-balance.ts`. |
| `src/components/operations-app.tsx` | `printOrderLabels` pinta un rotulo **por paquete** (no por pedido), con proveedor, "Paquete N de M", lineas del paquete y cobro solo en el paquete 1; en modo admin, una hoja de tanda por grupo. Selector de proveedor en la vista del admin aplicado a sus tres botones de tanda (RF_06, RF_10). `markOrdersLabelsPrinted` no cambia (RF_08). |
| `src/lib/supplier-packages.test.ts` (nuevo) | Pruebas del modulo puro y la prueba que ata la particion al cobro (RNF_01). |
| `src/lib/spec-040-guards.test.ts` (nuevo) | Guardas de fuente (seccion 4). |

**Por que no se reutiliza `findCatalogMatch` de `src/lib/finance.ts`:** es la copia cliente de la misma regla y
recibe `AppState`. La que **cobra** es la del servidor, y la spec exige la misma regla que genera el
`product_cost`. Comparadas linea a linea hoy son equivalentes (id solo sin `lineItems`, luego SKU en mayusculas,
luego nombre normalizado de un producto sin SKU, todo con `active !== false` y la misma tienda); una prueba lo
deja atado (seccion 4) y la copia cliente no se toca en esta spec.

## 2. Modelo de datos

**Ninguno persistido.** No se escribe ningun campo nuevo en Firestore. Imprimir sigue escribiendo solo
`labelPrintedAt/By/Count` por `saveFirestoreOrderLabelPrint` (RNF_02).

Tipos del modulo puro:

```ts
// functions/src/supplier-packages.ts
export const NO_SUPPLIER = "__no_supplier__";

export type CatalogItemLike = {
  id: string; sellerId: string; supplierId?: string; sku?: string;
  name?: string; normalizedProductName?: string; active?: boolean;
};
export type SupplierLike = { id: string; name: string };
export type OrderLike = {
  id: string; sellerId: string; totalCop: number; paymentMethod: string;
  productId?: string; productName?: string; sku?: string; quantity?: number;
  lineItems?: Array<{ sku?: string; productName?: string; quantity: number }>;
};

export type PackageLine = { label: string; sku?: string; quantity: number };

export type OrderPackage = {
  orderId: string;
  supplierKey: string;          // supplierId del catalogo, o NO_SUPPLIER
  supplierName?: string;        // undefined si quien imprime no puede leer `suppliers` (tienda)
  index: number;                // 1..total
  total: number;
  lines: PackageLine[];
  collectsPayment: boolean;     // true solo en index 1 (D3)
};

export function splitOrderIntoPackages(
  order: OrderLike,
  catalog: CatalogItemLike[],
  suppliers: SupplierLike[]
): OrderPackage[];

export type BatchGroup = {
  supplierKey: string;
  supplierName?: string;
  packages: OrderPackage[];
  unitsByProduct: Array<{ label: string; quantity: number }>;
  /** Pedidos de este grupo con otro paquete en un grupo que NO entra en esta impresion. */
  ordersWithPackagesElsewhere: string[];
};

export function groupBatchBySupplier(
  orders: OrderLike[],
  catalog: CatalogItemLike[],
  suppliers: SupplierLike[],
  options?: { onlySupplierKey?: string }  // RF_06; ausente = todos
): BatchGroup[];
```

## 3. Algoritmos criticos

**Partir un pedido (`splitOrderIntoPackages`).**
1. Lineas: `lineItems[]` si trae alguna; si no, una sola linea con `productName/sku/quantity` (RF_01, como
   `resolveProductCostLinesForOrder`). El `productId` del pedido solo se usa en el segundo caso, igual que el cobro.
2. Cada linea se empareja con `matchCatalogForLine` (el mismo codigo que cobra). **No** se filtra por
   `productCostConfigured`: el cobro lo exige para generar costo, pero un producto sin costo configurado sigue
   teniendo bodega. Ese es el unico punto donde la impresion y el cobro miran cosas distintas, y la prueba de
   RNF_01 lo declara en vez de esconderlo.
3. Clave de proveedor: `product.supplierId` si hay producto y lo tiene (cadena no vacia); si no, `NO_SUPPLIER`
   (RF_07). Nunca se infiere por descarte.
4. Dentro de cada proveedor, las lineas que emparejan con el **mismo producto** se suman (caso limite "mismo SKU
   en dos lineas"); el rotulo muestra el nombre que trae la linea de Shopify (es lo que la bodega reconoce, con su
   "OFERTA 2 X 1") y el SKU de la linea. Las lineas sin producto se dejan una a una. Si dos lineas sumadas traen
   nombres distintos, se usa el nombre del catalogo (visto en las capturas: "variedad 1 x3" mentia).
5. Orden de los paquetes, determinista para que la reimpresion numere igual: por **id** de proveedor, y
   `NO_SUPPLIER` siempre al final. *(Corregido en la implementacion: el borrador ordenaba por nombre, pero la
   tienda no ve los nombres, y su "Paquete 1" —el que cobra— habria sido otra bodega que el del admin. Una
   prueba lo fija.)* Los **grupos** de la tanda del admin si van por nombre.
6. `index`/`total` y `collectsPayment = index === 1`. Un pedido de un solo proveedor da **un** paquete con
   `total = 1` (RF_02, RF_09): el rotulo no muestra "Paquete 1 de 1".
7. `supplierName` sale de `suppliers`; para la tienda esa lista llega vacia (no puede leer la coleccion) y el
   nombre queda `undefined` (RNF_03): su rotulo dice "Paquete N de M" sin nombre.

**Agrupar una tanda (`groupBatchBySupplier`)** — solo admin (RF_10).
1. Parte cada pedido; reparte sus paquetes por `supplierKey`.
2. Con `onlySupplierKey`, se queda con ese grupo. `ordersWithPackagesElsewhere` lista los pedidos de ese grupo
   cuyo `total > 1`: la hoja de tanda los nombra ("KNT-x tiene otro paquete en ADMA COMPANY"), porque el pedido
   se marca impreso entero (RF_08) y ese otro paquete no volvera a salir en "pendientes".
3. `unitsByProduct`: suma de cantidades por etiqueta de linea dentro del grupo (RF_05).
4. Orden de grupos: el mismo que el de los paquetes; dentro del grupo, el orden de entrada de los pedidos.

**Pintar (`printOrderLabels`).** Gana un parametro `options: { mode: "admin" | "seller"; onlySupplierKey?: string }`.
- Admin: `groupBatchBySupplier`; por grupo, primero la hoja de tanda (misma pagina de 100x150 mm, `page-break`
  como los rotulos: proveedor, fecha, n.º de rotulos, unidades por producto, aviso de "Sin proveedor asignado"
  y de paquetes en otra bodega), luego sus rotulos. Un pedido suelto (boton de la tarjeta) imprime todos sus
  paquetes **sin** hoja de tanda.
- Tienda: `splitOrderIntoPackages` pedido a pedido, sin hojas ni selector, con `suppliers = []`.
- Cada rotulo: lo de hoy (codigo, QR, barras, cliente, direccion de `orderAddressLines`, zona, pie) mas una franja
  de proveedor ("ADMA LABORATORIO · Paquete 1 de 2"). El bloque `.pay` dice `COBRAR $total`/`PAGADO` si
  `collectsPayment`, y "Sin cobro — va con el paquete 1" si no (RF_04, D3).
- El bloque de producto pasa de un nombre + un SKU + una cantidad a una lista de lineas
  (`nombre · SKU · xN`). Tope de 4 lineas y "+N mas" debajo (RNF_04); la cantidad grande de la derecha pasa a
  ser la suma de unidades del paquete.
- El QR y las barras se generan **una vez por pedido**, no por paquete (mismo codigo KNT), para no multiplicar el
  coste de `QRCode.toDataURL` en pedidos mixtos.
- El conteo de la barra de herramientas pasa a decir "N pedidos · M rotulos".

**Selector de proveedor (RF_06).** Un `<select>` de pildora con el patron que ya usa `OrderFilters`
(`focus-ring rounded-full border border-white/10 ...`), junto a "Rotulos pendientes" en la cabecera de
"Operacion en vivo". Opciones: "Todos los proveedores", cada proveedor de `state.suppliers` con algun producto en
el catalogo, y "Sin proveedor asignado". Estado local del panel admin (`useState`, sin persistir), y se aplica a
los tres botones de tanda: "Imprimir pendientes", "Rotulos bodega pendientes" y "Reimprimir rotulos visibles".
Los contadores de los botones pasan a contar los **pedidos** que entran con el filtro elegido, para que el
numero del boton coincida con lo que sale. Los pedidos que se marcan impresos son los que tienen algun paquete
en la impresion.

## 4. Estrategia de testing

`src/lib/supplier-packages.test.ts`, con un catalogo de prueba que reproduce el de Kovia (LAB con SKU 94030000 y
93070000, COMPANY con 33680000 y un producto sin SKU por nombre):
- RF_01: pedido sin `lineItems` usa los campos colapsados; un `sku` colapsado `"A + B"` cae en `NO_SUPPLIER`.
- RF_02/RF_09: un proveedor con dos lineas -> un paquete, `total = 1`, `collectsPayment`.
- RF_03/RF_04: LAB + COMPANY -> dos paquetes, cada uno con solo sus lineas, `collectsPayment` solo en el 1, orden
  estable entre dos llamadas.
- Mismo SKU en dos lineas -> una linea sumada.
- RF_07: linea sin emparejar y producto sin `supplierId` -> `NO_SUPPLIER`, al final.
- Tienda (`suppliers = []`): `supplierName` indefinido, particion identica.
- `groupBatchBySupplier`: dos grupos, `unitsByProduct`, `onlySupplierKey` y `ordersWithPackagesElsewhere`.
- **RNF_01 (atadura al cobro):** sobre los mismos pedidos y con todos los productos con costo configurado, el
  conjunto `{productId -> supplierId}` de los paquetes es igual al de `resolveProductCostLinesForOrder` de
  `functions/src/wallet-entries.ts`; con un producto sin costo configurado, el cobro lo omite y el paquete lo
  conserva (la diferencia declarada del paso 2). Y la misma comparacion contra `productCostLinesForOrder` de
  `src/lib/finance.ts`, para que la copia cliente no se aleje sin que nadie lo vea.

`src/lib/spec-040-guards.test.ts` (lectura de fuente):
- `wallet-entries.ts` ya no declara `function matchCatalogForLine` y la importa de `./catalog-match`.
- `supplier-packages.ts` importa `matchCatalogForLine` de `./catalog-match` y no declara otro emparejador.
- `printOrderLabels` no lee `order.productName`/`order.sku` para el bloque de producto (debe salir de los
  paquetes).
- La funcion de impresion no llama a ningun callable ni escribe otra cosa que `saveFirestoreOrderLabelPrint`.

Las pruebas existentes del cobro (`seller-charges.test.ts`, `community-cashback-entries.test.ts` y las de cierre)
deben seguir en verde sin tocarlas: son la prueba de que mover el emparejador no cambio el dinero.

Verificacion visual (DoD 3), en modo local con estado inyectado (memoria "Capturar la UI sin tocar produccion"):
rotulo de un proveedor, pedido mixto en dos paquetes, hoja de tanda con aviso de otra bodega, grupo "Sin
proveedor asignado", y el selector a 375 y 1280. La ventana de impresion se captura antes de `window.print()`.

## 5. Dependencias nuevas

Ninguna. `qrcode` y `renderCode128Svg` ya estan.

## 6. Despliegue

Solo **hosting** (`ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only hosting --project kentro-last-mile`, que la
pagina SSR exige aunque no se toque ninguna callable). `wallet-entries.ts` cambia de archivo de origen pero no de
comportamiento: **no** hace falta desplegar functions para esta spec. Se recompilan (`cd functions && npm run
build` + `npx tsc --noEmit`) para comprobar que el movimiento compila; el despliegue de functions puede esperar al
siguiente que toque. Sin indices ni reglas. `npm run lint` antes de subir (regla de la casa).

Comprobacion en produccion (DoD 4): el admin imprime la tanda pendiente de Kovia con "Todos los proveedores" y
salen dos fajos, LAB y COMPANY, cada uno con su hoja.

## 7. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Mover el emparejador cambia el cobro sin querer. | Movimiento literal, guardas de fuente y las pruebas de cobro existentes sin tocar. |
| Un pedido mixto impreso con el selector deja su otro paquete fuera de "pendientes". | La hoja de tanda lo nombra; marcar por paquete esta fuera de alcance (spec, seccion 6). Hoy hay 0 pedidos mixtos. |
| Rotulos largos con muchas lineas desbordan 100x150 mm. | Tope de 4 lineas + "+N mas" (RNF_04), y captura con un pedido de 6 lineas. |
| Un pedido viejo sin `lineItems` y con SKU colapsado `"A + B"` cae en "Sin proveedor". | Correcto por spec (RF_07), y hoy no hay ninguno en Kovia: de sus 31 pedidos sin `lineItems`, 30 traen un solo SKU (93070000 o 94030000) y emparejan igual que en el cobro, y 1 no trae ni SKU ni nombre (el unico "Sin proveedor" medido). |
