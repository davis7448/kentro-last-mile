# Plan tecnico — Spec 013: el pedido manual se ve entero y la guia lleva la direccion

- **Spec:** `specs/013_pedido_manual_entero_y_direccion_en_la_guia.md` (aprobada 2026-09-15)
- **Fecha:** 2026-09-15

## 1. Lo que hay hoy (medido en el codigo, no supuesto)

| Donde | Que hace | Linea |
|---|---|---|
| `printOrderLabels` | `const address = order.normalizedAddress ?? order.addressRaw;` — la nota pisa la direccion | `operations-app.tsx:936` |
| `OrderRow` (tarjeta; **es tambien la vista del mensajero**: no hay otro sitio que pinte la direccion de un pedido, comprobado con `grep addressRaw\|normalizedAddress`) | `{order.normalizedAddress ?? order.addressRaw}` | `operations-app.tsx:1851` |
| Excel (`buildOrderExportRows`) | `direccion_original: order.addressRaw`, `direccion_normalizada: order.normalizedAddress` | `order-export.ts:163-164` |
| `ManualOrderPanel` | casilla "Direccion normalizada opcional" que la tienda usa como observacion | `operations-app.tsx:5937` |
| `ImportedOrderReviewForm` (la tienda edita un pedido suyo antes de confirmarlo) | misma casilla | `operations-app.tsx:2351` |
| Fila de paneles de la tienda | `grid gap-3 lg:grid-cols-3` — el formulario desplegado vive en un tercio | `operations-app.tsx:11571` |
| Fila de producto del formulario | `sm:grid-cols-[2fr_1fr_auto_auto]` con `fr` sin `minmax(0,…)`: los inputs no encogen y desbordan | `operations-app.tsx:5980` |
| Controles del formulario | `py-2 text-sm` (~38 px), botones `min-h-10` (40 px) | `operations-app.tsx:5918-6022` |
| Servidor, creacion manual | `manualOrderSchema` sin campo de indicaciones; escribe `normalizedAddress` | `functions/src/orders.ts:52-70, 327` |
| Servidor, edicion de importado | `updateImportedOrderSchema`; `transaction.set(orderRef, stripUndefined({...current, normalizedAddress: input.normalizedAddress?.trim(), …}), { merge: true })` — si el cliente **deja de enviar** `normalizedAddress`, la clave se limpia y `merge` conserva la que habia (RF_11 sale gratis) | `functions/src/orders.ts:164-178, 489-507` |
| Estado local (sin Firebase) | `createManualOrder` en `actions.ts:284` copia `normalizedAddress` | `actions.ts:324` |
| `Order` | `addressRaw: string; normalizedAddress?: string;` — no hay campo de indicaciones | `types.ts:309-310` |

Nada mas lee la direccion de un pedido para mostrarla. Las demas vias de entrada (`index.ts` webhook Shopify, `store-webhook.ts`, `onstock-webhook.ts`, `contact-form.ts`) no escriben `normalizedAddress` ni nada parecido: RF_13 se cumple no tocandolas y se guarda con una comprobacion de fuente.

## 2. Decisiones de diseno

### 2.1 Un modulo puro para las lineas de direccion (RF_05–RF_08, RF_11, RNF_02)

`src/lib/order-address-lines.ts`, sin React ni DOM:

```ts
export type AddressLineLabel = "Direccion" | "Correccion o nota" | "Indicaciones";
export type AddressLine = { label: AddressLineLabel; text: string };
export const SIN_DIRECCION = "SIN DIRECCION";

/** Igualdad de RF_07: sin tildes, sin mayusculas, espacios colapsados, recortado. */
export function sameAddressText(left: string | undefined, right: string | undefined): boolean;

/** Las lineas que TODA superficie pinta, en este orden y con estos rotulos. */
export function orderAddressLines(
  order: Pick<Order, "addressRaw" | "normalizedAddress" | "deliveryNotes">
): AddressLine[];
```

Reglas de `orderAddressLines`, en orden:

1. `Direccion`: `addressRaw` recortado; si queda vacio, `SIN_DIRECCION` (RF_05).
2. `Correccion o nota`: `normalizedAddress` recortado, solo si no esta vacio y **no** es `sameAddressText` con
   la original (RF_07, RF_11). No se intenta adivinar que es.
3. `Indicaciones`: `deliveryNotes` recortado, solo si no esta vacio (RF_06).

La normalizacion de `sameAddressText`: `normalize("NFD")` + quitar `\p{M}`, `toLowerCase()`, `replace(/\s+/g, " ")`, `trim()`.
La puntuacion NO se toca (caso limite declarado: "Cra 5 #10-20" y "Carrera 5 # 10 - 20" son distintas).

### 2.2 El campo nuevo: `deliveryNotes` (RF_09)

`Order.deliveryNotes?: string` en `src/lib/types.ts`, con comentario: indicaciones de la tienda para el
mensajero; nunca sustituye a la direccion. Nombre en ingles como el resto del tipo (`addressRaw`,
`callNote`); en pantalla siempre "Indicaciones".

### 2.3 Las cuatro superficies consumen el modulo (RF_08)

- **Guia** (`printOrderLabels`): la seccion "Direccion" se genera recorriendo `orderAddressLines(order)`:
  primera linea con la clase `.address` que ya existe; las siguientes con `key` = rotulo y una clase nueva
  `.address-extra` (`max-height` de tres lineas + `overflow: hidden`, caso limite "indicacion muy larga").
- **Tarjeta / vista del mensajero** (`OrderRow`): la fila primaria con `MapPin` pinta la linea `Direccion`;
  debajo, una `<p>` por linea extra con el rotulo en `text-ink-60` y el texto entero (sin `truncate`: la
  tarjeta la muestra completa).
- **Excel** (`buildOrderExportRows`): `direccion_original` = texto de `Direccion`; `direccion_normalizada` =
  texto de `Correccion o nota` o `""`; columna nueva `indicaciones` **al final** de `orderExportColumns`
  (RF_12). Las columnas existentes no cambian de nombre ni de orden; su valor sale ahora del modulo (solo
  difiere de hoy cuando la corregida era igual a la original: antes se duplicaba, ahora va vacia — es
  exactamente RF_07). Los rotulos de RF_08 en Excel son las cabeceras de columna.
- **Guarda de RNF_02** (`src/lib/spec-013-guards.test.ts`, mismo estilo que `spec-005-guards.test.ts`):
  - `operations-app.tsx` sin comentarios no contiene `normalizedAddress ??` ni `?? order.addressRaw`;
  - los cuerpos de `printOrderLabels` y `OrderRow` llaman a `orderAddressLines(`;
  - `order-export.ts` sin comentarios no contiene `order.addressRaw` ni `order.normalizedAddress` y llama a
    `orderAddressLines(`;
  - DoD 4 (mutacion): reintroducir `order.normalizedAddress ?? order.addressRaw` en la guia hace fallar la
    guarda; se deja constancia de la corrida en `.sdd/evidence/013/mutacion-rnf02.txt`.

### 2.4 El servidor acepta y guarda las indicaciones (RF_09, RF_10, RF_13)

- `manualOrderSchema` gana `deliveryNotes: optionalText`; el documento escribe
  `deliveryNotes: input.deliveryNotes?.trim() || undefined` (pasa por `stripUndefined`, como todo).
- `updateImportedOrderSchema` gana `deliveryNotes: optionalString`; la escritura pone
  `deliveryNotes: input.deliveryNotes?.trim() || undefined`. Como el cliente deja de enviar
  `normalizedAddress`, el `merge: true` que ya existe conserva la corregida (RF_11). **No se toca** la linea
  `normalizedAddress: input.normalizedAddress?.trim()` (el admin podria seguir enviandola desde otro cliente).
- `createManualFirebaseOrder` y `updateFirebaseImportedOrder` (`auth.ts`) y `createManualOrder` (`actions.ts`)
  aceptan `deliveryNotes?: string`.
- RF_13 se guarda por fuente: `index.ts`, `store-webhook.ts`, `onstock-webhook.ts`, `contact-form.ts` no
  contienen `deliveryNotes`.
- Ningun cambio en `firestore.rules`: la creacion manual y la edicion van por callables (admin SDK).
- **Despliegue de functions necesario** (createManualOrder y updateImportedOrder). Hasta que se despliegue,
  el cliente nuevo enviaria `deliveryNotes` a un schema `z.object` no estricto: zod lo ignora, no falla.
  Orden: functions → hosting.

### 2.5 La tienda escribe indicaciones, no "normalizada" (RF_10)

En `ManualOrderPanel` y en `ImportedOrderReviewForm` la casilla "Direccion normalizada opcional" se sustituye
por un `<textarea>` con `aria-label`/placeholder "Indicaciones para el mensajero (opcional)". Se retira para
todos los usuarios del formulario, tambien el admin (`operations-app.tsx:5612`): la spec dice que esa direccion
la corrige quien reparte, y el admin corrige direcciones donde el mensajero (transicion `resolveAddress`), no
al crear. El estado `normalizedAddress` del formulario desaparece; entra `deliveryNotes`.

### 2.6 El formulario cabe (RF_01–RF_04, RNF_03, RNF_04)

- `CollapsiblePanel` gana `spanWhenOpen?: boolean`: con `open && spanWhenOpen` la `<section>` lleva
  `lg:col-span-full`. La fila `grid gap-3 lg:grid-cols-3` no cambia: el panel desplegado ocupa la fila entera
  y los otros dos caen debajo (RF_02); plegado, vuelve a su tercio. Solo el panel "Crear pedido manual" lo
  activa.
- Fila de producto: `sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_auto]`; inputs con `w-full min-w-0`;
  el de cantidad pierde `w-20` (la columna ya mide 5rem). En < 640 px sigue apilandose (RF_03).
- Todos los `input`, `select`, `textarea` y `button` del formulario llevan `min-h-11` (44 px; RF_04). El
  boton de enviar y "Quitar" pasan de `min-h-10` a `min-h-11`.
- Guarda de fuente (RNF_04): dentro del cuerpo de `ManualOrderPanel`, cada etiqueta `<input`, `<select`,
  `<textarea`, `<button` lleva `min-h-11`; ninguna clase `grid-cols-[` usa `fr` sin `minmax(0,`; no queda
  `w-20`; `CollapsiblePanel` con `title="Crear pedido manual"` lleva `spanWhenOpen`; el cuerpo de
  `CollapsiblePanel` contiene `lg:col-span-full`.
- Medida (DoD 2): `scripts/verify-013.js` (mismo esqueleto que `verify-005.js`: `setup` / `capture` /
  `cleanup`, prefijo `smoke013-`, evidencia en `.sdd/evidence/013/`):
  - `setup`: tienda y usuario desechables + dos pedidos escritos por admin SDK: uno "viejo" (observacion en
    `normalizedAddress`, sin `deliveryNotes`) y uno con direccion, corregida distinta e indicaciones.
  - `capture`: entra como la tienda en un servidor local (puerto 3005, `waitUntil: "networkidle"` + 1500 ms),
    despliega "Crear pedido manual" y "Solicitudes de liquidacion" a la vez; a 390 px y a 1280 px mide
    `document.documentElement.scrollWidth === clientWidth`, y para cada control del formulario
    `getBoundingClientRect()`: `height >= 44` y `right <= innerWidth`; guarda `medidas-*.json` y capturas.
    Luego pulsa "Imprimir rotulo" en cada pedido, captura la ventana emergente (`context.waitForEvent("page")`)
    y comprueba en su texto las lineas rotuladas (DoD 3).
  - `cleanup`: borra todo lo `smoke013-`.
  - Lo ejecuta el orquestador, nunca un subagente; contrasenas fuera de la evidencia antes del commit.

## 3. Orden de trabajo y dependencias

```
T1 modulo puro + tipo  ─┬─> T2 guia y tarjeta (+ guarda RNF_02)
                        ├─> T3 Excel
                        └─> T4 servidor y wrappers ─> T5 formularios de la tienda
T6 disposicion (independiente)
T7 guion de medida y capturas (necesita T2, T5, T6)
```

## 4. Pruebas

| Que | Donde | Tipo |
|---|---|---|
| `orderAddressLines`, `sameAddressText`, casos limite de la seccion 5 | `src/lib/order-address-lines.test.ts` | unidad, pura |
| Cuatro superficies consumen el modulo; sin lecturas sueltas; mutacion | `src/lib/spec-013-guards.test.ts` | guarda de fuente |
| Excel: columna `indicaciones` al final, columnas existentes intactas, valores desde el modulo | `src/lib/order-export.test.ts` | unidad |
| `createManualOrder` local copia `deliveryNotes` y no inventa `normalizedAddress` | `src/lib/actions.test.ts` | unidad |
| Schemas del servidor, RF_13 por fuente | `src/lib/spec-013-guards.test.ts` | guarda de fuente |
| Formularios sin "normalizada", con indicaciones; disposicion (RF_01–04) | `src/lib/spec-013-guards.test.ts` | guarda de fuente |
| Medida real a 390/1280 px y guias impresas | `scripts/verify-013.js` → `.sdd/evidence/013/` | Playwright, humano lanza |

## 5. Riesgos

- **Navegadores con bundle viejo** enviando `normalizedAddress` desde el formulario: el servidor lo sigue
  aceptando (no se quita del schema). Se degrada a lo de hoy, no a un error.
- **`lg:col-span-full` con `hideFinance`** (tienda sin finanzas): la fila tiene dos hijos y tres columnas;
  `col-span-full` sigue ocupando las tres. Sin caso especial.
- **Pedidos historicos con `normalizedAddress` igual a la original** salvo puntuacion: se veran dos lineas.
  Aceptado en la spec (seccion 5).
- **Excel**: quien procese el archivo por posicion de columna no se ve afectado (la nueva va al final).
