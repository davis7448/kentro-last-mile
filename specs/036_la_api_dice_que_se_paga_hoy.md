# Spec 036: La API de tiendas dice que se paga hoy y que es el efectivo bloqueado

- **Estado:** aprobada (2026-11-06, por el responsable de la plataforma: "Explicarlo, no ocultarlo")
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-11-06
- **Origen:** DANDA consulta su saldo por la API con un agente automatico y pide que se le entregue todo lo
  entregado, incluso lo del mismo dia.
- **Prioridad:** alta, porque es un reclamo activo de una tienda
- **Accesibilidad:** sin interfaz (solo texto dentro de respuestas JSON)

## 1. Contexto y objetivo

`GET /resumen` ya separa `disponibleCop` (lo que Kentro puede pagar hoy) de `bloqueadoCodCop` (contraentregas
cuyo efectivo el domiciliario todavia no ha entregado a Kentro), y cada pedido de `GET /orders` trae
`pago.estado = "pendiente_bloqueado_cod"` y `pago.habilitadoParaPago`. Aun asi, el agente de la tienda:

- reconstruye el saldo sumando pedidos entregados de `/orders` en vez de usar `/resumen`
  (el 2026-11-05 a las 4:39 p. m. reporto disponible $0 y bloqueado $8.053.900; Kentro decia otra cosa), y
- trata el bloqueado como deuda vencida de Kentro.

El significado actual del bloqueado ("se habilita al recibirse") no dice **quien** tiene ese efectivo ni
**cuando** suele llegar, y `/orders` no trae ningun aviso.

Ocultar el bloqueado se descarto: la tienda ve sus entregas en tiempo real y lo recalcularia por su cuenta,
con una cifra que no cuadraria con la de Kentro.

**Objetivo:** que cualquier respuesta de la que un agente pueda sacar un saldo diga, en el propio JSON, que la
cifra que se paga hoy es `disponibleCop` y que el bloqueado es efectivo que todavia esta en manos del
domiciliario.

## 2. Historias de usuario

- **HU_01 (sin interfaz):** **Como** tienda que consulta la API con un agente **quiero** que la respuesta me
  diga cuanto se me paga hoy y por que el resto esta bloqueado **para** no reclamar plata que Kentro aun no
  recibe.
- **HU_02 (sin interfaz):** **Como** responsable de la plataforma **quiero** que la API explique la regla de
  pago **para** no tener que explicarsela a cada tienda.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** La respuesta de `GET /resumen` MUST incluir en `avisos` un aviso fechado el 2026-11-06
  que diga que la cifra que Kentro paga hoy es `disponibleCop`, que `bloqueadoCodCop` es efectivo de entregas
  que el domiciliario todavia no ha entregado a Kentro (normalmente lo entrega al dia siguiente), que pasa a
  `disponibleCop` cuando Kentro lo registra, y que el saldo no se debe reconstruir sumando pedidos entregados.
- **RF_02 (ubicua):** `significado.bloqueadoCodCop` MUST decir que ese efectivo lo tiene todavia el
  domiciliario y que no se paga hasta que Kentro lo recibe; `significado.disponibleCop` MUST decir que es la
  cifra que se paga.
- **RF_03 (ubicua):** La respuesta de `GET /orders` (listado por rango) MUST incluir los mismos `avisos` y un
  `significado` de los valores de `pago.estado`, con `pendiente_bloqueado_cod` explicado igual que en RF_02.
- **RF_04 (ubicua):** El indice `GET /docs` MUST incluir el aviso nuevo en una clave NUEVA de primer nivel,
  `avisoDePago`, y MUST NOT cambiar el valor de su clave `avisos`: la spec 029 (RF_20) congela los valores de las
  claves actuales del indice.
- **RF_05 (ubicua):** En `/resumen` y `/orders`, el aviso del 2026-09-17 MUST conservarse dentro de `avisos`,
  despues del nuevo (el mas reciente primero).

## 4. Requisitos no funcionales

- **RNF_01 (compatibilidad):** Ninguna cifra cambia y ninguna clave existente cambia de valor ni de tipo; solo
  se anaden claves y textos (la misma regla que la spec 029, RF_20).
- **RNF_02 (una sola fuente):** El texto del aviso MUST vivir en una sola constante, usada por las tres
  respuestas.

- **RNF_03 (disponibilidad):** `storeApi` MUST declarar 512 MiB de memoria. Desde la subida a Node 22
  (2026-11-06, spec 027 T3) `GET /orders` de DANDA se pasaba de los 256 MiB por defecto y respondia 500: 11
  errores "Memory limit of 256 MiB exceeded" entre las 17:00 y las 19:36 UTC, ninguno en los 10 dias anteriores.

## 5. Fuera de alcance

- Ocultar o renombrar `bloqueadoCodCop`.
- Cambiar cuando se paga el efectivo, o pagar lo del mismo dia.
- La busqueda `GET /orders?shopifyOrderId=` (respuesta de un solo pedido, no sirve para reconstruir saldos).

## 6. Definition of Done

1. Pruebas de RF_01 a RF_05 en verde, y las guardas de las specs 018 y 029 tambien.
2. `npx vitest run`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
3. Desplegada la function `storeApi`; `/resumen` y `/orders` de una tienda real traen el aviso y las cifras de
   `/resumen` no cambian.

## 7. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-06 | Borrador y aprobacion | DANDA pide que se le pague todo lo entregado, incluso lo del dia; el responsable eligio explicar el bloqueado, no ocultarlo |
