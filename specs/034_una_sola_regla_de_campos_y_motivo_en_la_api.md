# Spec 034: La API de tiendas tiene una sola definicion de los campos corregibles y del motivo de anular

- **Estado:** borrador
- **Autor:** Claude (informe de entrega de la spec 029)
- **Fecha:** 2026-10-05
- **Origen:** deuda anotada al cerrar T8 de la spec 029 y no saldada en T30 (`specs/029_report.md`, deuda 1).
- **Prioridad:** baja, pero antes de que otra spec toque `PATCH` o cancelar (030 no; una ampliacion de campos si).
- **Accesibilidad:** sin interfaz.

## 1. Contexto y objetivo

La constitucion pide una regla en un solo sitio. Tras la 029 hay dos copias:

- **Campos de `PATCH`:** `PATCH_FIELDS` en `functions/src/store-api-request.ts:322` repite literalmente
  `DELIVERY_FIELDS` de `functions/src/order-seller-actions.ts:331`, que ya esta exportada (T30 la exporto pero no
  sustituyo la copia).
- **Motivo de anular:** `reasonProblem` en `functions/src/store-api-request.ts:328-334` (required → empty →
  too_long) repite `cancelReasonProblems` de `functions/src/order-seller-actions.ts:549`, tambien exportada.

Hoy no divergen: el planificador usa los `fieldProblems` que le pasa `parseWriteBody`. Divergen el dia que alguien
anada un campo de entrega o cambie el largo del motivo en un solo lado: la API aceptaria un campo que el nucleo no
aplica (o rechazaria uno que si), en silencio.

**Objetivo:** una sola definicion, sin cambiar ninguna respuesta de la API.

## 2. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** `store-api-request.ts` MUST tomar la lista de campos de `PATCH` de `DELIVERY_FIELDS` y MUST
  NOT declarar otra.
- **RF_02 (ubicua):** `parseWriteBody` MUST validar el motivo de anular con `cancelReasonProblems` y MUST NOT
  contener su propia regla de required/empty/too_long.
- **RF_03 (ubicua):** Las respuestas de `PATCH` y `cancel` MUST quedar identicas para todos los casos de las
  pruebas T8, T11, T12 y T29 de la 029.
- **RF_04 (ubicua):** Una guarda de fuente MUST fallar si `store-api-request.ts` vuelve a contener un literal con
  los cinco nombres de campo de entrega o la constante del largo del motivo comparada a mano.

## 3. Fuera de alcance

- Cambiar que campos se pueden corregir o el largo del motivo.

## 4. Definition of Done (borrador)

1. Pruebas de la 029 en verde sin tocar sus expectativas; guarda de RF_04.
2. `npm test`, `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` en verde.
3. Despliegue de `storeApi` y repeticion de `run-all` de `scripts/verify-029.js` contra la tienda de pruebas.

## 5. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-05 | Borrador inicial | Deuda de T8 de la 029 que T30 no llego a saldar |
