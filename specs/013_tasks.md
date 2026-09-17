# Tareas — Spec 013: el pedido manual se ve entero y la guia lleva la direccion

Plan: `specs/013_plan.md`. Cada tarea: 20–30 min, prueba primero.

- [x] **T1: Modulo puro de lineas de direccion y campo `deliveryNotes`**
  * Requisitos cubiertos: RF_05, RF_06, RF_07, RF_09, RF_11, RNF_02 (la funcion), casos limite 1–4 y 8
  * Archivos: src/lib/order-address-lines.ts, src/lib/order-address-lines.test.ts, src/lib/types.ts
  * Accion: `orderAddressLines(order)` devuelve `[{label, text}]` en orden Direccion → Correccion o nota →
    Indicaciones; `SIN DIRECCION` con original vacia; `sameAddressText` sin tildes/mayusculas/espacios dobles,
    puntuacion intacta. `Order.deliveryNotes?: string`.
  * Verificacion: `order-address-lines.test.ts` pasa con un pedido viejo real de ejemplo (observacion en
    normalizada, sin indicaciones → dos lineas) y uno con las tres lineas.

- [x] **T2: La guia y la tarjeta consumen el modulo, con guarda de RNF_02**
  * Requisitos cubiertos: RF_05, RF_06, RF_07, RF_08, RF_11, RNF_01, RNF_02, caso limite "indicacion muy larga"
  * Archivos: src/components/operations-app.tsx, src/lib/spec-013-guards.test.ts
  * Accion: `printOrderLabels` genera la seccion "Direccion" desde `orderAddressLines` (primera linea `.address`,
    extras `.address-extra` recortadas a tres lineas); `OrderRow` pinta la linea Direccion junto a `MapPin` y las
    extras rotuladas debajo, enteras. Guarda: sin `normalizedAddress ??` ni `?? order.addressRaw` en el
    componente; ambos cuerpos llaman a `orderAddressLines(`.
  * Verificacion: `spec-013-guards.test.ts` pasa; DoD 4: mutacion registrada en
    `.sdd/evidence/013/mutacion-rnf02.txt`.

- [x] **T3: El Excel sale del modulo y gana la columna `indicaciones`**
  * Requisitos cubiertos: RF_08, RF_12, RNF_02
  * Archivos: src/lib/order-export.ts, src/lib/order-export.test.ts, src/lib/spec-013-guards.test.ts
  * Accion: `direccion_original` y `direccion_normalizada` desde `orderAddressLines`; columna `indicaciones`
    ultima de `orderExportColumns`. Guarda: `order-export.ts` no lee `order.addressRaw`/`order.normalizedAddress`.
  * Verificacion: `order-export.test.ts` — columnas existentes con el mismo nombre y orden, `indicaciones` al
    final, un pedido viejo exporta la nota en `direccion_normalizada` y `indicaciones` vacia.

- [x] **T4: El servidor y los wrappers aceptan `deliveryNotes`; las otras vias no lo tocan**
  * Requisitos cubiertos: RF_09, RF_10 (lado servidor), RF_11, RF_13, RNF_01
  * Archivos: functions/src/orders.ts, src/lib/firebase/auth.ts, src/lib/actions.ts, src/lib/actions.test.ts,
    src/lib/spec-013-guards.test.ts
  * Accion: `manualOrderSchema` y `updateImportedOrderSchema` con `deliveryNotes`; escritura
    `deliveryNotes: input.deliveryNotes?.trim() || undefined`; `normalizedAddress` de la edicion sin cambios
    (el `merge: true` conserva la corregida cuando el cliente no la envia). Wrappers y `createManualOrder` local
    con `deliveryNotes`.
  * Verificacion: guardas de fuente sobre `functions/src/orders.ts` (los dos schemas, la escritura, el
    `merge: true`) y ausencia de `deliveryNotes` en index.ts/store-webhook.ts/onstock-webhook.ts/contact-form.ts;
    `actions.test.ts`: `createManualOrder` copia `deliveryNotes` recortado y lo omite si va vacio.
    `cd functions && npx tsc --noEmit`.

- [x] **T5: La tienda escribe indicaciones y deja de ver "normalizada"**
  * Requisitos cubiertos: RF_10, RF_09, caso limite "la tienda edita un pedido viejo"
  * Archivos: src/components/operations-app.tsx, src/lib/spec-013-guards.test.ts
  * Accion: en `ManualOrderPanel` y `ImportedOrderReviewForm`, la casilla "Direccion normalizada opcional" se
    sustituye por un `textarea` "Indicaciones para el mensajero (opcional)" ligado a `deliveryNotes`; el
    formulario envia `deliveryNotes` y ya no envia `normalizedAddress`.
  * Verificacion: guarda: ningun cuerpo de los dos formularios contiene `normalizada` ni `setNormalizedAddress`;
    ambos contienen `deliveryNotes` y el placeholder de indicaciones.

- [x] **T6: El formulario cabe: fila entera al desplegar, filas que se apilan, controles de 44 px**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_04, RNF_03, RNF_04 (guardas), casos limite "telefono girado" y
    "liquidaciones y formulario a la vez"
  * Archivos: src/components/operations-app.tsx, src/lib/spec-013-guards.test.ts
  * Accion: `CollapsiblePanel` con `spanWhenOpen` → `lg:col-span-full` al abrir; el panel "Crear pedido manual"
    lo activa; fila de producto `sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_auto]` con inputs
    `w-full min-w-0`; todos los controles del formulario con `min-h-11`.
  * Verificacion: guarda: cada `<input|select|textarea|button` en `ManualOrderPanel` lleva `min-h-11`; ningun
    `grid-cols-[` con `fr` sin `minmax(0,`; sin `w-20`; el `CollapsiblePanel` de "Crear pedido manual" lleva
    `spanWhenOpen`; el cuerpo de `CollapsiblePanel` contiene `lg:col-span-full` condicionado a `open`.

- [x] **T7: Medida real y capturas: `scripts/verify-013.js`**
  * Requisitos cubiertos: RF_01, RF_02, RF_04 (medida), DoD 2 y 3; RF_05–RF_07 en una guia impresa real
  * Archivos: scripts/verify-013.js, src/lib/spec-013-guards.test.ts, .sdd/evidence/013/**
  * Accion: pasos `setup` (tienda, usuario y dos pedidos `smoke013-` por admin SDK), `capture` (390 y 1280 px,
    formulario y liquidaciones desplegados, `scrollWidth === clientWidth`, controles `height >= 44` y
    `right <= innerWidth`, capturas; ventana de la guia de los dos pedidos con sus lineas rotuladas) y `cleanup`.
  * Verificacion: guarda de forma del guion (tres pasos, prefijo, no escribe fuera de `.sdd/evidence/013`);
    corrida del orquestador con `medidas-movil.json` y `medidas-escritorio.json` en verde y capturas de las
    dos guias.

## Cobertura RF → tarea

| Requisito | Tareas |
|---|---|
| RF_01 | T6, T7 |
| RF_02 | T6, T7 |
| RF_03 | T6 |
| RF_04 | T6, T7 |
| RF_05 | T1, T2, T7 |
| RF_06 | T1, T2, T7 |
| RF_07 | T1, T2, T7 |
| RF_08 | T2, T3 |
| RF_09 | T1, T4, T5 |
| RF_10 | T4, T5 |
| RF_11 | T1, T2, T4 |
| RF_12 | T3 |
| RF_13 | T4 |
| RNF_01 | T2, T4 |
| RNF_02 | T1, T2, T3 |
| RNF_03 | T6 |
| RNF_04 | T6, T7 |

Ningun requisito queda huerfano.
