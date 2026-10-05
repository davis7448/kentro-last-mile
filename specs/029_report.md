# Informe de entrega — Spec 029: la tienda confirma, corrige y cancela pedidos por API

**Desplegada el 2026-10-05 y verificada en produccion, pero NO cerrada.** Faltan la aceptacion humana de las 14
pantallas, la firma del responsable (DoD 6) y el merge del PR #6. El primer E2E contra produccion **fallo**
(RF_25 admin: "por por <nombre>"); se corrigio en T33 y el recorrido repetido paso (14/14). La revision adversarial
encontro 5 defectos reales que las pruebas unitarias no habian cazado (T28-T32). Hay tres cosas sin verificar en
produccion: las politicas TTL de idempotencia y tasa, el 404 con un pedido **real** de otra tienda, y ONEP (sin
key de lectura, no entro en ninguna comparacion).

- Spec: `specs/029_store_api_confirma_y_corrige_pedidos.md` · Plan: `specs/029_plan.md` · Tareas:
  `specs/029_tasks.md` (T1-T33, todas `[x]`)
- Evidencia (`EV/` = `.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/`):
  [t27-smoke.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t27-smoke.txt),
  [verify-e2e.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/verify-e2e.txt) (con addenda),
  [verify-e2e-RF_25.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/verify-e2e-RF_25.txt),
  [a11y-axe.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/a11y-axe.txt),
  [a11y-axe-RF_25.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/a11y-axe-RF_25.txt),
  [t1-linea-base.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t1-linea-base.txt),
  [t2-query-check.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t2-query-check.txt),
  [t24-reads-antes.json](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/t24-reads-antes.json),
  [mutacion-rf19.txt](../.sdd/evidence/029_store_api_confirma_y_corrige_pedidos/mutacion-rf19.txt)

## 1. Veredicto por requisito

Pruebas en `src/lib/`. "smoke" = `EV/t27-smoke.txt`; "e2e" = `EV/verify-e2e.txt` + addenda y
`EV/verify-e2e-RF_25.txt`.

| Req | Cumplido | Prueba | Evidencia en produccion |
|---|---|---|---|
| RF_01 | si | `store-api-write.test.ts` T10 (404 identico ajeno/inexistente) | smoke CA_01; `GET /orders/{id}` = su elemento de `GET /orders` en 20 pedidos reales (Kovia, DANDA), 0 distintos |
| RF_02 | si | `store-api-write.test.ts` T10; `store-api-request.test.ts` T28, T32 | smoke CA_01 (numero inexistente → 200 lista vacia, aceptado por CENTRAL) |
| RF_03 | si | `store-api-request.test.ts` T8 (paso 3, precedencia 0-3) | sin evidencia propia en prod; cubierto solo por pruebas |
| RF_04 | si | `order-seller-actions.test.ts` T4; `order-seller-actions-run.test.ts` T6; `store-api-request.test.ts` T8 (cuerpo de confirmar) | smoke CA_02 |
| RF_05 | si | T4 (`ready_to_assign` + `expectedStatus` distinto → `unchanged`); T6 carrera (a) | smoke CA_02 (repetir), CA_07 (con lider → 200 sin cambios) |
| RF_06 | si | T4 | smoke CA_08 (confirmar cancelado → 409 `order_cancelled`) |
| RF_07 | si | T5 | smoke CA_05 (en `imported` y en `ready_to_assign`) |
| RF_08 | si | T5 (`in_route`, `call_pending`, `address_risk` con lider) | smoke CA_07 (con lider → 409) |
| RF_09 | si | T5; `store-api-request.test.ts` T8 (todos los campos, `field_not_allowed` de primer nivel, `deliveryNotes` null/"") | smoke CA_06 |
| RF_10 | si | T5 (misma ciudad desactivada → 422, no no-op) | smoke CA_09 (ciudad inexistente; la variante "misma ciudad desactivada" solo en prueba) |
| RF_11 | si | T6 (`cityId` conservado), T25 (fixture Kovia + `mergeImportedOrder`) | smoke `kovia-replay` (replay → PATCH → replay: cliente, telefono, direccion y estado conservados) |
| RF_12 | si | T8, T29 (huella sobre cuerpo entero) | smoke CA_06 |
| RF_13 | si | T4, T30 (libera reserva tambien en `imported` manual) | smoke CA_08 (inventario reservado 1 → 0) |
| RF_14 | si | T4 | smoke CA_07 |
| RF_15 | si | T4, T6 carrera (c) | smoke CA_08 (repetir → 200) |
| RF_16 | si, con el limite declarado | `spec-029-guards.test.ts` T15, T16 (lista cerrada por nombre de 11 callables); `order-seller-actions.test.ts` T15 | smoke CA_05, CA_12 (`/history` con fecha y origen); e2e RF_27 ("Antes/Ahora") |
| RF_17 | si | `store-api-history.test.ts` T13; `store-api-write.test.ts` T13 | e2e RF_17 (nota de alcance, vacio y error a 375 y 1280) |
| RF_18 | si | T13 (sin `actor`/`uid`/`auditEventId`), T14, T31 | smoke CA_11 (ver nota 1) |
| RF_19 | si | T6 (transaccion, carreras), T6b anti-copia + `EV/mutacion-rf19.txt` (la mutacion pone la guarda en rojo), T11 | smoke CA_02/CA_07/CA_08 |
| RF_20 | si (2 de 3 tiendas) | `store-api-orders.test.ts` T9 (instantanea), `store-api-write.test.ts` T10, T13 (indice por valor) | smoke compare-reads: 0 diferencias en Kovia, DANDA y tienda de pruebas (lectura vs escritura); captura en `EV/t24-reads-antes.json` |
| RF_21 | si | T4 (con y sin lider, con `expectedStatus` distinto) | smoke CA_03 (solo sin lider) |
| RF_22 | si | T5 (propiedad: ningun plan `api` emite `address_risk`) | smoke CA_04 |
| RF_23 | si | T5 (`clear` de los cuatro derivados) | no comprobado en prod (CA_04 no lee los derivados) |
| RF_24 | si | `spec-029-guards.test.ts` T16 (4): ningun relleno desde `auditEvents` | — |
| RF_25 | si, tras T33 | `store-api-auth.test.ts` T3, T17; `store-api-keys-view.test.ts` T19, T33; guardas T17, T20, T21 | e2e RF_25 **fallo** en la primera pasada; addenda y `verify-e2e-RF_25.txt` pasan a 375 y 1280 |
| RF_26 | si | T3 (`planWriteKeyChange` no toca `apiKey`), guarda T17 (`createStoreApiKey` no escribe `writeKey*`) | indirecta: smoke CA_11 + compare-reads con key de lectura tras rotar (ver nota 2) |
| RF_27 | si | `store-api-history.test.ts` T14, T31; guardas T14, T22 | smoke RF_27 (sesiones `seller` y `seller_logistics` reales); e2e RF_27 (sin identidades, pildoras) |
| RNF_01 | si | T3 (una prueba por fila de la tabla 2.3), T10 | smoke CA_11 (401 `missing_credentials`, 403 `read_only_key`, 401 `key_in_query`, 401 `invalid_key` tras rotar) |
| RNF_02 | si | T8 (catalogo congelado), T11 (`mapRejectionToResponse`) | smoke (codigos en cada CA) |
| RNF_03 | si | `store-api-request.test.ts` T12, `order-seller-actions-run.test.ts` T12, `store-api-write.test.ts` T12, T29 | smoke CA_10; **TTL no verificada** (seccion 3) |
| RNF_04 | si | T8, T12 (121 → 429, nunca 403) | smoke CA_12: rafaga de 130 → 429 `Retry-After=31` |
| RNF_05 | si | guarda T10 (sin `where("sellerId")` solo ni `settlements.get()`) | smoke: p95 escrituras 442 ms (n=25), `GET /orders/{id}` 160 ms; umbral 2.000 ms |

Notas:
1. **CA_11 "pedido de otra tienda" se probo en produccion con un id inexistente, no con un pedido real ajeno.** La
   igualdad 404 ajeno = 404 inexistente solo esta probada con el `db` falso (T10). Es coherente con DoD 3 (no tocar
   tiendas reales), pero la etiqueta del smoke dice mas de lo que prueba.
2. `verify-e2e.txt` rotula como "RF_26" los recorridos de la seccion de la tienda (HU_04): lo que comprueban es
   RF_25 (mostrar una vez, rotar). RF_26 queda cubierto por prueba unitaria y de forma indirecta en el smoke.
3. DoD 4 (calidad) y DoD 5 (documentacion, guarda T26) en verde segun el cierre; este informe no re-ejecuto la
   suite. DoD 6 (firma) pendiente.

## 2. Metricas frente a los RNF

| Metrica | Valor | Requisito | Resultado |
|---|---|---|---|
| Pruebas | 3.501 en verde (dato del cierre) | DoD 4 | OK |
| p95 escrituras | 442 ms (25 muestras) | RNF_05 < 2 s | OK, con margen; muestra pequena |
| p95 `GET /orders/{id}` | 160 ms | RNF_05 < 2 s | OK |
| Limite de tasa | 429 en la rafaga de 130, `Retry-After=31` | RNF_04 >= 60/min (120 acordado con CENTRAL) | OK |
| compare-reads | 0 diferencias en Kovia y DANDA, 0 excluidos por `updatedAt` | RF_20 | OK; ONEP sin captura |
| `GET /orders/{id}` vs `GET /orders` | 20 pedidos reales, 0 distintos | RF_01 | OK |
| Accesibilidad (axe) | 0 hallazgos en nodos de la 029 (32 + 6 estados); 3 `region` moderados en el resto de la app | WCAG 2.2 AA | OK para la 029 |
| Revision adversarial | 3 rondas; 5 hallazgos corregidos (T28-T31 ronda 1, T32 ronda 2); ronda 3 limpia | — | — |
| E2E en produccion | 12/14 en la primera pasada; 14/14 tras T33 | DoD 3 | OK tras correccion |
| Limpieza | cero en las 16 colecciones en las tres corridas | RF_16 (excepcion) | OK |

## 3. Que se degrado o queda en riesgo

No hay regresion conocida en lo medido (compare-reads en cero, 20 pedidos iguales, guardas de 013 y 017 en verde).
Lo que si cambio y conviene no perder de vista:

- **Guardas de otras specs relajadas a sabiendas (T6, T6b).** `spec-017-guards.test.ts`: guarda 3 de cuatro a
  cinco exenciones (el ejecutor escribe `orders` fuera de `orders.ts`); guarda 7 movio un sello y un literal de
  estados cerrados al nucleo. `spec-013-guards.test.ts` T4 dejo de exigir el `action` y el `set(merge)` en
  `updateImportedOrder`. Justificado (la logica se movio, no se borro), pero son tres vigilancias que ahora
  apuntan a otro archivo.
- **La tienda ve menos historial que antes, a proposito.** Eventos no verificables fuera de la lista permitida
  (p. ej. `order.messenger_reassigned` historicos) desaparecieron de su "Historial del pedido". Si una tienda
  pregunta por ellos, es la mitigacion de RF_27 hasta la 032, no un fallo.
- **Coste por escritura de la API.** Cada escritura suma una escritura del contador de tasa y una de idempotencia;
  hasta ~120/min por tienda en el peor caso.
- **TTL comprobada (2026-10-05, despues del informe).** `gcloud firestore fields ttls list
  --project=kentro-last-mile` devuelve `state: ACTIVE` para `storeApiIdempotency.expiresAt` y
  `storeApiRateLimits.expiresAt`.
- **Cambio de forma de `getOrderAuditTrail`** (array → `{ events, historySince }`): el envoltorio acepta las dos
  formas. Un bundle viejo en cache recibe objeto; mitigado por el `no-cache` del HTML.
- **Dependencias nuevas:** ninguna (Zod ya estaba en `functions/`).

## 4. Deuda tecnica

1. **Regla duplicada de campos y motivo (T8, no saldada en T30).** `functions/src/store-api-request.ts:322`
   (`PATCH_FIELDS`) repite `DELIVERY_FIELDS` de `functions/src/order-seller-actions.ts:331`, ya exportada;
   `store-api-request.ts:328-334` (`reasonProblem`) repite `cancelReasonProblems`
   (`order-seller-actions.ts:549`), tambien exportada. Hoy no divergen; divergiran en silencio con el primer campo
   nuevo. → spec 034.
2. **Mensajero asignado sin `auditEvent` invisible en la app.** `functions/src/orders.ts:990-1004` escribe
   `order.messenger_assigned` en `orderHistory` sin `auditEventId`; `buildAuditTrailResponse`
   (`functions/src/store-api-history.ts:210-223`) solo une registros a eventos, asi que la app no lo pinta y
   `GET /orders/{id}/history` si. App y API cuentan historias distintas. → spec 033.
3. **Admin con sombrero de tienda ve "Kentro" en todas las pildoras.** `src/components/operations-app.tsx:2049`
   elige `viewer` por `activeRole`; el servidor recorta por el rol del token. Sin fuga, pero el admin no ve lo que
   vera la tienda. → spec 033.
4. **ONEP sin key de lectura.** Fuera de compare-reads y de la comparacion de 20 pedidos. Es operativo, no codigo:
   antes de que CENTRAL opere ONEP, generar sus keys desde el panel del admin y repetir `capture-reads` /
   `compare-reads` con ella.
5. **Specs 030, 031 y 032 en borrador.** Ademas, 032 no esta registrada en el mapa de specs de
   `.sdd/state.json` (030 y 031 si), y `phase` sigue en `verify` con `activeTask: T27`.
6. **Chequeo debil en el E2E de RF_25.** El texto capturado de la celda "Generada" en escritorio incluye cabeceras
   ajenas (`"por tiendaTiendaLecturaEscrituraG | por Prueba "`, `verify-e2e-RF_25.txt:30`): la comprobacion pasa
   por subcadena, no por la celda exacta. Afinar el selector la proxima vez que se toque `verify-029.js`.

## 5. Estado de despliegue

- Desplegada el 2026-10-05 (indices: ninguno nuevo, T2; functions y hosting). Recorrido real T27 OK; E2E 14/14 tras
  T33 (hosting `a7cabf6`); ultimo commit `875b891`.
- Pendiente: aceptacion humana de las 14 pantallas del diseno; firma del responsable (DoD 6); merge del PR #6;
  comprobar TTL; keys de ONEP.

## 6. Fuera de alcance de la spec: decision

| Punto | Decision | Motivo |
|---|---|---|
| Crear pedidos por API | sigue fuera | Entran por Shopify y webhooks; CENTRAL no lo pidio |
| Cambiar producto, cantidad, valor, pago, modo | sigue fuera | CENTRAL confirmo el 2026-10-05: cambiar producto = cancelar y reimportar |
| Reprogramar o tocar pedidos en curso; franja | sigue fuera | La franja la fija el mensajero; abrirlo reintroduce el clobber |
| Igualar panel y API (anular `assigned`) | sigue fuera | Nadie lo ha pedido; revisar si CENTRAL lo pide |
| Historial de ChatBy e importaciones | spec 031 | Sin cambios |
| Escrituras directas de `status` del lider y mensajero | spec 032, **subir prioridad** | La 030 avisa a CENTRAL a partir de `orderHistory`: sin cerrar 032 §1.1, "agendado" y "en ruta" hechos desde el cliente **no generarian aviso**. Conviene decidir 032 §1.1 antes de aprobar la 030 o declararlo en ella |
| Identidades para lider y mensajero | sigue fuera | Sin peticion |
| Geocodificar | sigue fuera | Decision 2 |
| OPC_01 webhook firmado | spec 030 | Ver la dependencia de arriba |
| OPC_02 paginacion de `GET /orders` | sigue fuera, medir | `GET /orders` sin filtro sigue leyendo todos los pedidos de la tienda (DANDA: 5.090). Medir su latencia antes de abrir spec |
| OPC_03 `GET /coverage` | sigue fuera | El 422 ya devuelve las ciudades activas |
| OPC_04 cuenta de pruebas | **accion operativa pendiente** | `seller-test-029` se borra en cada limpieza: CENTRAL no tiene tienda de pruebas permanente. Crearla (sin codigo) |

## 7. Propuestas de mejora (specs borrador)

Solo lo que 030/031/032 no cubren:

- `specs/033_historial_del_pedido_sin_huecos_en_la_app.md` — la app ensena los registros de `orderHistory` sin
  evento y el admin con sombrero ve lo que vera la tienda (deudas 2 y 3).
- `specs/034_una_sola_regla_de_campos_y_motivo_en_la_api.md` — una sola definicion de campos de `PATCH` y del
  motivo de anular (deuda 1).

Lo demas (TTL, keys de ONEP, tienda de pruebas de CENTRAL, latencia de `GET /orders`) es operativo o de medicion y
no necesita spec.
