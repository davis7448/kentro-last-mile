# Tareas 037: el webhook de tienda acepta todo por defecto, y lo dice

Plan: `specs/037_plan.md`. Pantallas: `specs/design/037_el_webhook_de_tienda_acepta_todo_por_defecto/`.

- [x] **T1: Regla pura del filtro**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_09, RNF_01
  * Archivos: functions/src/store-webhook-filter.ts, src/lib/store-webhook-filter.test.ts
  * Accion: `resolveFilterOnSave`, `effectiveFilter`, `acceptsAllProducts`, `describeFilter`, `syncInstruction`,
    `discardDayKey`, `recentFilterDiscards`, `staleDiscardDays`.
  * Verificacion: la tabla de casos del plan (seccion 4) pasa; incluye conexion nueva, existente sin campos,
    mixta, vacio, minusculas, borde de 7 dias y cambio de dia en Bogota.

- [x] **T2: El servidor usa la regla y apunta los descartes**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_07, RF_09, RNF_01, RNF_02, RNF_03
  * Archivos: functions/src/store-webhook.ts, src/lib/types.ts, src/lib/spec-037-guards.test.ts
  * Accion: `createStoreWebhookConfig` con `resolveFilterOnSave` y `filterMode`; `storeOrderWebhook` con
    `effectiveFilter`, ciudad evaluada antes de apuntar, `filterDiscards` con poda; tipo ampliado.
  * Verificacion: guardas de fuente (servidor sin otro valor por defecto, usa las dos funciones, apunta solo
    pedidos de ciudad cubierta); `npx tsc --noEmit` en `functions/`.

- [x] **T3: Tarjeta de la tienda**
  * Requisitos cubiertos: RF_04, RF_05, RF_07, RF_08, RF_09, RNF_01
  * Archivos: src/components/store-webhook-filter-card.tsx, src/components/operations-app.tsx,
    src/lib/firebase/auth.ts, src/lib/spec-037-guards.test.ts
  * Accion: componente con frase (status), contador, "Cambiar filtro" con dos opciones y vista previa, instruccion
    segun filtro; la tarjeta deja de mandar "ADMA" de relleno.
  * Verificacion: guarda de fuente (sin `|| "ADMA"` ni `tagContains: "ADMA"` en el cliente); lint y tsc.

- [x] **T4: Lista del admin**
  * Requisitos cubiertos: RF_06, RF_07
  * Archivos: src/components/operations-app.tsx, src/lib/spec-037-guards.test.ts
  * Accion: `StoreWebhookConfigsPanel` muestra `describeFilter` y `recentFilterDiscards` por tienda.
  * Verificacion: guarda de fuente (el panel usa las dos funciones del modulo, no repite la frase); lint y tsc.

- [x] **T5: Correcciones de la revision adversarial (ronda 1)**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_04, RF_06
  * Archivos: functions/src/store-webhook-filter.ts, functions/src/store-webhook.ts,
    src/components/operations-app.tsx, src/lib/store-webhook-filter.test.ts, src/lib/spec-037-guards.test.ts
  * Accion: (a) una conexion es "existente" solo si ya tiene `webhookKey`; el documento que crea
    `setStoreUchatConfig` (sin clave) es una conexion nueva y nace con `*` (R1-RF_01-1, R1-RF_02-1, R1-RF_03-1).
    La tarjeta de la tienda trata ese documento como "sin conexion" y ofrece "Generar webhook".
    (b) las ciudades efectivas se resuelven en el modulo (`effectiveCityAllowlist`, Cali / Santiago de Cali si
    falta o esta vacia); el servidor y `describeFilter` usan la misma, y la frase no rompe sin `cityAllowlist`
    (R1-RF_04-1).
  * Verificacion: pruebas del modulo (documento sin clave = nueva, con clave = existente; frase sin ciudades);
    guardas de fuente; tsc, vitest, lint.

## Cobertura RF -> tarea

| Requisito | Tareas |
|---|---|
| RF_01 | T1, T2 |
| RF_02 | T1, T2 |
| RF_03 | T1, T2 |
| RF_04 | T3 |
| RF_05 | T3 |
| RF_06 | T4 |
| RF_07 | T2, T3, T4 |
| RF_08 | T3 |
| RF_09 | T1, T2, T3 |
| RNF_01 | T1, T2, T3 |
| RNF_02 | T2 |
| RNF_03 | T2 |

Ningun requisito huerfano.
