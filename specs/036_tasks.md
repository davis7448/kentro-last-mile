# Tareas 036

- [x] **T1: Aviso de pago y significados en la API de tiendas**
  * Requisitos cubiertos: RF_01, RF_02, RF_03, RF_04, RF_05, RNF_01, RNF_02
  * Archivos: functions/src/store-summary.ts, functions/src/store-api.ts, src/lib/store-summary.test.ts,
    src/lib/spec-018-guards.test.ts, src/lib/spec-036-guards.test.ts
  * Accion: constante `STORE_PAYOUT_NOTICE` y lista `STORE_API_NOTICES` (nuevo primero) en
    `store-summary.ts`; `/resumen`, `/orders` y `/docs` la usan; significados de `disponibleCop`,
    `bloqueadoCodCop` y de `pago.estado`
  * Verificacion: `npx vitest run`, `tsc` en raiz y `functions/`, `npm run lint`

- [x] **T2: Desplegar `storeApi` y comprobar en produccion**
  * Requisitos cubiertos: RF_01, RF_03, RNF_01
  * Archivos: .sdd/evidence/036_la_api_dice_que_se_paga_hoy/verify.txt
  * Accion: `firebase deploy --only functions:storeApi`; leer `/resumen` y `/orders` de una tienda real
  * Verificacion: el aviso aparece y las cifras de `/resumen` coinciden con las de antes del despliegue

- [x] **T3: `storeApi` con 512 MiB (regresion de Node 22)**
  * Requisitos cubiertos: RNF_03
  * Archivos: functions/src/store-api.ts, src/lib/spec-036-guards.test.ts
  * Accion: `onRequest({ memory: "512MiB" }, ...)`
  * Verificacion: guarda en verde; tras desplegar, `GET /orders` de DANDA responde 200

## Cobertura

| Requisito | Tarea |
|---|---|
| RF_01 a RF_05 | T1 |
| RNF_01 | T1, T2 |
| RNF_02 | T1 |
