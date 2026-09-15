# Spec 014: Las indicaciones llegan con el pedido de la tienda conectada

- **Estado:** borrador (propuesto por el informe de cierre de la spec 013, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Origen:** fuera de alcance consciente de la 013 ("Alimentar las indicaciones desde Shopify u OnStock. Otra spec.")

## 1. Contexto y objetivo

Desde la 013 el pedido tiene un campo propio de **indicaciones para el mensajero** (`deliveryNotes`), la guia
lo imprime rotulado "Indicaciones" y la tienda lo escribe al crear o editar un pedido manual. Pero el 81 % de
los pedidos de la plataforma entran por el webhook de Shopify (3.954 de 4.891 al 2026-09-15) y otro 9 % por
el webhook de tienda; en esos pedidos el campo queda ausente por decision de la 013 (RF_13), y el cliente
final, que en la pasarela de Shopify si puede dejar una nota ("timbre azul", "portería"), la escribe en un
sitio que hoy la plataforma descarta: `functions/src/index.ts` no lee `note` ni `note_attributes` del pedido
de Shopify (comprobado con `grep` para este borrador).

**Objetivo:** que la nota que el cliente deja al comprar llegue al mensajero por la misma linea "Indicaciones"
que la 013 abrio, sin que la tienda tenga que reescribirla a mano y sin cambiar nada mas del pedido.

## 2. Historias de usuario

- **Como** cliente final **quiero** que la indicacion que dejo al pagar en la tienda online le llegue a quien
  reparte **para** no tener que repetirla por WhatsApp.
- **Como** tienda **quiero** ver y corregir esa nota antes de confirmar el pedido **para** quitar lo que no es
  una indicacion de entrega.
- **Como** mensajero **quiero** que la guia lleve la nota del cliente igual que lleva la de la tienda **para**
  no distinguir de donde salio.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** llegue un pedido por el webhook de Shopify con `note` no vacia, el sistema
  MUST guardar `note` recortada en `deliveryNotes`, y MUST NOT tocar `addressRaw` ni `normalizedAddress`.
- **RF_02 (evento):** **Cuando** llegue un pedido por el webhook de Shopify con `note` vacia o ausente, el
  sistema MUST crear el pedido sin `deliveryNotes` (campo ausente, no cadena vacia: principio de la 011).
- **RF_03 (ubicua):** `deliveryNotes` MUST recortarse a 500 caracteres; si `note` es mas larga, se guarda el
  principio y el corte no MUST provocar un rechazo del pedido.
- **RF_04 (ubicua):** El pedido importado MUST mostrar la nota del cliente en el formulario de revision de la
  tienda en la casilla "Indicaciones para el mensajero" que la 013 creo, editable como cualquier otra.
- **RF_05 (estado):** **Mientras** el webhook de tienda (`store-webhook.ts`) y OnStock no tengan un campo
  equivalente documentado, esas vias MUST seguir creando el pedido sin `deliveryNotes`. Incorporarlas es
  una decision aparte que exige conocer su contrato.
- **RF_06 (no deseado):** **Si** el pedido de Shopify trae `note_attributes`, el sistema MUST NOT volcarlos en
  `deliveryNotes`: son pares clave-valor de apps, no una indicacion de entrega.
- **RF_07 (ubicua):** La sincronizacion historica (`shopify_historical_sync`) y la recuperacion manual MUST
  aplicar la misma regla que el webhook, con la misma funcion, para que un pedido reimportado no pierda ni
  gane la nota.

## 4. Requisitos no funcionales

- **RNF_01:** Ningun pedido que hoy entra sin nota cambia en un solo campo (caracterizacion sobre los
  fixtures del webhook que ya existen).
- **RNF_02:** La regla "de `note` a `deliveryNotes`" vive en UNA funcion pura compartida por `index.ts` y
  `shopify.ts` (hoy cada uno tiene su copia de `summarizeShopifyLineItems`; esta spec no debe anadir una
  tercera copia de nada).

## 5. Casos limite

- Nota que es solo espacios o saltos de linea: campo ausente (RF_02).
- Nota con emojis o saltos de linea: se conserva; la guia ya recorta a tres lineas (013).
- Nota que repite la direccion: se muestra igual (la 013 decidio no comparar las indicaciones con nada).
- Pedido que ya existia y llega actualizado por webhook (`orders/updated`): fuera de alcance; solo la creacion.

## 6. Fuera de alcance

- Alimentar `deliveryNotes` desde OnStock o el webhook de tienda (RF_05).
- Traducir o limpiar la nota.
- Mostrarle al cliente final que su nota fue leida.

## 7. Definition of Done

1. RF_01 a RF_03, RF_06 y RF_07 con prueba unitaria sobre la funcion pura, usando un payload real de
   Shopify anonimizado.
2. RNF_01 con la caracterizacion del webhook en verde antes y despues.
3. Un pedido de prueba con nota entra por el webhook de la tienda de pruebas y su guia impresa muestra
   "Indicaciones" con el texto (evidencia en `.sdd/evidence/014/`).
4. `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
5. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | La 013 dejo el campo listo y el webhook sigue descartando la nota del cliente |
