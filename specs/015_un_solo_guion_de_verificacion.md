# Spec 015: Un solo guion de verificacion, que ademas recoge la consola

- **Estado:** borrador (propuesto por el informe de cierre de la spec 013, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Origen:** deuda observada en los informes de cierre 004/005 y 013. Es un tramo pequeno y entregable de
  la spec 002 (entorno de verificacion), como lo es la 012 para el webhook.

## 1. Contexto y objetivo

Tres specs seguidas han verificado en produccion con un guion propio: `scripts/smoke-004.js`,
`scripts/verify-005.js` (960 lineas) y `scripts/verify-013.js` (588 lineas). El de la 013 comparte con el de
la 005 **dieciseis funciones con el mismo nombre** (`ensureSeller`, `ensureAuthAccount`, `deleteIfSmoke`,
`captureAtWidth`, `loadPlaywright`, `stepSetup`, `stepCleanup`…), copiadas a proposito porque no habia un
sitio comun. Cada copia arrastra las mismas dos carencias, anotadas como deuda en el informe 004/005 y
todavia abiertas en la 013:

1. **Ninguno recoge la consola del navegador ni las peticiones fallidas.** Un error de JavaScript en la
   pagina capturada no quedaria en la evidencia; el guion mide el DOM y sigue.
2. **Esperan un reloj, no un estado** (`networkidle` + 1.500 ms). En la 005 eso dejo una captura de
   escritorio con "Cargando…" como unica evidencia de una pantalla.

La cuarta spec que necesite medir en produccion (la 014, la 016) volveria a copiar 500 lineas.

**Objetivo:** que exista un unico arnes en `scripts/verify/` del que cada spec escriba solo sus pasos
(que crea, que mide, que limpia), y que toda captura venga con su consola y sus peticiones fallidas.

## 2. Historias de usuario

- **Como** orquestador **quiero** escribir el guion de una spec nueva en menos de 100 lineas **para** no
  copiar el arnes por cuarta vez.
- **Como** responsable **quiero** que cada captura de evidencia diga si hubo errores de consola **para**
  no dar por buena una pantalla que fallo en silencio.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** MUST existir un modulo `scripts/verify/harness.js` con las funciones hoy duplicadas
  (cuenta y tienda desechables con prefijo, borrado por prefijo, login REST, captura por ancho, estado en
  `.sdd/evidence/NNN/state.json`) y MUST NOT quedar ninguna copia de esas funciones en los guiones de spec.
- **RF_02 (ubicua):** Cada captura MUST guardar junto a la imagen un `consola.log` con los mensajes
  `error` y `warning` de la pagina y un `red-fallida.log` con toda respuesta 4xx/5xx y toda peticion
  abortada, con el mismo formato que ya usa la evidencia de la 001 (`.sdd/evidence/001/*/consola.log`).
- **RF_03 (ubicua):** El paso `capture` MUST terminar en fallo (codigo de salida distinto de cero y
  `ok: false` en el resultado) si hay un `error` de consola o una respuesta 5xx, salvo que el guion de la
  spec lo declare esperado por nombre.
- **RF_04 (ubicua):** La espera antes de medir MUST ser por un selector o texto que el guion de la spec
  nombra, nunca por un tiempo fijo; el arnes MUST NOT ofrecer un `sleep`.
- **RF_05 (ubicua):** El prefijo de lo desechable MUST venir del numero de la spec (`smokeNNN-`) y el
  `cleanup` MUST negarse a borrar cualquier documento que no lo lleve.
- **RF_06 (estado):** **Mientras** `smoke-004.js`, `verify-005.js` y `verify-013.js` sigan en el repo, MUST
  seguir ejecutandose igual: se migran o se dejan intactos, no se dejan a medias.

## 4. Requisitos no funcionales

- **RNF_01:** El arnes no anade dependencias: Playwright ya esta en `functions/node_modules` o en el repo
  (comprobar antes de decidir), y `firebase-admin` se carga de `functions/node_modules` como hoy.
- **RNF_02:** Las guardas de fuente de la 013 sobre `verify-013.js` (T7) deben seguir en verde o
  reescribirse sobre el arnes en la misma tarea; no se relajan.

## 5. Casos limite

- El login falla por contrasena: el arnes lo reporta como fallo del paso, no como fallo de la app.
- La pagina emite `warning` de React en desarrollo: se registran, no tumban la captura (solo `error`).
- Dos guiones corren a la vez con el mismo prefijo: fuera de alcance; el `state.json` es por spec.

## 6. Fuera de alcance

- Emular Firestore o Auth en local (eso es la 002 entera).
- Pruebas de componente o de render en la suite de Vitest.
- Ejecutar el arnes en CI.

## 7. Definition of Done

1. RF_01, RF_04 y RF_05 con guardas de fuente sobre `scripts/verify/`; RF_02 y RF_03 con una corrida real
   contra la app local que provoque un `error` de consola a proposito y falle por el.
2. `verify-013.js` reescrito sobre el arnes reproduce las mismas medidas que la evidencia de la 013
   (`medidas-movil.json`, `medidas-escritorio.json`) con `ok: true`.
3. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Tercera copia del arnes de verificacion; ninguna recoge la consola |
