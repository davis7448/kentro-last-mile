# Spec 033: "Historial del pedido" muestra todo lo que el servidor registro, con la vista del rol que mira

- **Estado:** borrador
- **Autor:** Claude (informe de entrega de la spec 029)
- **Fecha:** 2026-10-05
- **Origen:** deuda de la spec 029 (`specs/029_report.md`, deuda 2 y 3). Dos limites conocidos de T16 y T22 que
  ninguna de las specs 030, 031 o 032 cubre.
- **Depende de:** spec 029 (`orderHistory`, `getOrderAuditTrail`, `OrderAuditTrail`).
- **Accesibilidad:** WCAG 2.2 AA (cambia lo que pinta "Historial del pedido").

## 1. Contexto y objetivo

La 029 registra en `orderHistory` cada cambio hecho por la API o el panel, pero la app solo ensena los registros
que cuelgan de un `auditEvents`:

- `assignMessengerToOrders` (`functions/src/orders.ts`, ~990-1004) escribe un registro `order.messenger_assigned`
  **sin `auditEventId`** cuando el pedido pasa de `picked_up` a `call_pending` y no hay reasignacion (no hay
  evento que apuntar). `buildAuditTrailResponse` (`functions/src/store-api-history.ts`, ~210-223) recorre los
  eventos y une `orderHistory` por `auditEventId`, asi que ese registro **no sale nunca en la app**, aunque si sale
  en `GET /orders/{id}/history`. La app y la API cuentan dos historias distintas del mismo pedido.
- `OrderAuditTrail` elige la vista por `state.activeRole` (`operations-app.tsx`, ~2049), pero el servidor recorta
  por el rol del token. Un admin con el sombrero de tienda recibe la respuesta de admin pintada con el modelo de
  tienda: todas las pildoras dicen "Kentro", tambien las de la propia tienda y las de la API. No hay fuga (es
  admin), pero lo que ve no es lo que vera la tienda, que es justo para lo que se pone el sombrero.

**Objetivo:** que la app y la API ensenen los mismos cambios, y que el admin con sombrero de tienda vea
exactamente lo que vera la tienda.

## 2. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** `getOrderAuditTrail` MUST devolver tambien los registros de `orderHistory` del pedido que no
  tienen `auditEventId`, como eventos propios ordenados por fecha junto a los demas.
- **RF_02 (ubicua):** Para la tienda, esos registros MUST pasar las mismas reglas de la 029 (RF_18, RF_27):
  etiqueta de actor y sin uid, nombre ni correo. Un registro de `orderHistory` es verificable por definicion (solo
  lo escribe el servidor), asi que MUST mostrarse a la tienda.
- **RF_03 (ubicua):** Para un mismo pedido, el conjunto de cambios de `GET /orders/{id}/history` MUST estar
  contenido en lo que "Historial del pedido" ensena a la tienda.
- **RF_04 (estado):** **Mientras** un admin mire la app con el sombrero de tienda, "Historial del pedido" MUST
  ensenar lo mismo que veria la tienda (etiquetas "Kentro", "Tu tienda", "API" correctas y los mismos eventos
  ocultos por la mitigacion de RF_27). Como lo consigue (parametro de vista en la callable, solo honrado para
  admin, u otra via) se decide en el plan.
- **RF_05 (ubicua):** Una sesion de tienda MUST NOT poder pedir la vista de admin por ningun parametro.

## 3. Casos limite

- Pedido con un `order.messenger_assigned` sin evento y un `order.messenger_reassigned` con evento: salen los dos,
  una sola vez cada uno.
- Pedido anterior a la 029: sin registros sin evento; nada cambia.

## 4. Fuera de alcance

- Los cambios que no escriben `orderHistory` (escrituras directas del lider y el mensajero, spec 032; ChatBy e
  importaciones, spec 031).
- Ocultar identidades al lider y al mensajero.

## 5. Definition of Done (borrador)

1. Prueba pura de `buildAuditTrailResponse` con un registro sin `auditEventId` (tienda y admin).
2. Prueba de que un parametro de vista enviado por una sesion `seller` se ignora.
3. E2E en produccion con la tienda de pruebas: asignar mensajero sin reasignacion y ver el registro en la app y en
   `/history`; admin con sombrero ve "Tu tienda" y "API".
4. `npm test`, `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` en verde.
5. Firma del responsable.

## 6. Preguntas abiertas

1. Que texto visible lleva un `order.messenger_assigned` sin evento (necesita ratificacion de `sdd-uxui`).
2. El sombrero de tienda: parametro de vista en la callable o recorte en cliente sobre la respuesta de admin
   (el segundo es mas simple pero deja la regla de RF_27 en dos sitios).

## 7. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-05 | Borrador inicial | Informe de entrega de la 029: limites conocidos de T16 y T22 sin spec que los cubra |
