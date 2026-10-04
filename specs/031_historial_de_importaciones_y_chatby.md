# Spec 031: El historial de un pedido incluye lo que cambian las importaciones y ChatBy

- **Estado:** borrador
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-04
- **Origen:** decision 6 de la spec 029 (2026-10-04): el historial campo por campo de la 029 cubre solo la API y
  el panel; ChatBy y las cinco vias de importacion se dejaron para esta spec.
- **Depende de:** spec 029 (formato del historial, `historySince`, etiquetas de actor).
- **Accesibilidad:** WCAG 2.2 AA (solo si cambia la presentacion del historial)

## 1. Contexto y objetivo

Tras la 029, `GET /orders/{id}/history` y "Historial del pedido" registran cada cambio hecho por la API o el
panel, pero avisan de que **no incluyen** importaciones ni ChatBy. Esos cambios existen y pesan:

- La confirmacion de ChatBy (`uchat-pull.ts`, `uchat-webhook.ts`) pasa el pedido a `ready_to_assign` y puede
  reescribir `addressRaw` y `customerName` (`buildSyncPatch`). Hoy audita el cambio de estado con un `summary`
  ("direccion sincronizada"), sin valores.
- Las cinco vias de importacion (`shopify.ts` —manual e historica—, el `shopifyWebhook` de `index.ts`,
  `store-webhook.ts`, `onstock-webhook.ts`, `contact-form.ts`) pueden refrescar datos de entrega de un pedido sin
  confirmar (fase `unconfirmed` de `order-import-merge.ts`). Las de Shopify no escriben `auditEvents`; dejan un
  resumen por corrida en `importRuns`.

**Objetivo:** que el historial de un pedido cuente tambien lo que cambiaron ChatBy y las importaciones, con el
mismo formato que la 029, para que el aviso de "no incluye" pueda retirarse.

## 2. Historias de usuario

- **HU_01 (sin interfaz):** **Como** integrador **quiero** ver en el historial que ChatBy o Shopify cambiaron la
  direccion **para** no creer que mi correccion sigue vigente cuando no lo esta.
- **HU_02 (interfaz):** **Como** administrador o tienda **quiero** ver esos cambios en "Historial del pedido"
  **para** entender de donde salio la direccion actual.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** ChatBy confirme un pedido o cambie sus datos de entrega, el sistema MUST
  registrar cada campo cambiado con valor anterior y nuevo, y origen `chatby`.
- **RF_02 (evento):** **Cuando** una importacion cambie datos de entrega o el estado de un pedido existente, el
  sistema MUST registrar cada campo cambiado con valor anterior y nuevo, y origen `shopify` (o el de la via).
- **RF_03 (ubicua):** Una importacion que no cambia nada MUST NOT dejar registro, para no inundar el historial
  con las reimportaciones historicas.
- **RF_04 (ubicua):** La creacion de un pedido por importacion MUST dejar un unico registro de alta.
- **RF_05 (ubicua):** El registro MUST salir de la misma decision de `order-import-merge.ts` que escribe el
  pedido, no de una segunda comparacion, para que historial y documento no puedan divergir.
- **RF_06 (evento):** **Cuando** esta spec se despliegue, la respuesta del historial MUST dejar de decir que no
  incluye importaciones ni ChatBy a partir de esa fecha, y MUST seguir diciendolo para el tramo anterior.
- **RF_07 (ubicua):** Las reglas de identidad de la 029 (RF_18 y RF_27) aplican igual: para la tienda, ChatBy y
  las importaciones salen como "Kentro".

## 4. Requisitos no funcionales

- **RNF_01 (rendimiento):** Registrar el historial MUST NOT romper el tope ni la duracion de una corrida de
  sincronizacion historica (hoy topa en 2.000 pedidos por corrida).
- **RNF_02 (robustez):** Un fallo al registrar el historial MUST NOT hacer fallar la entrada del pedido (leccion
  del webhook de Shopify caido cuatro dias por un `undefined`).

## 5. Fuera de alcance

- Reconstruir el historial anterior a esta spec.
- Cambiar que conserva o refresca una importacion (eso es la 017).

## 6. Preguntas abiertas

1. ¿El registro va en la misma transaccion que escribe el pedido, o puede ser best-effort (RNF_02)?
2. ¿Se registra tambien el refresco de catalogo (`frozen_catalog` en fase `open`), o solo datos de entrega y
   estado?

## 7. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-04 | Borrador inicial | Decision 6 de la spec 029 |
