# Tareas 027

- [x] **T1: La regla de recibido acepta las asignaciones de un corte saldado**
  * Requisitos cubiertos: RF_01, RF_01b, RF_02, RF_03, RF_05, RNF_02
  * Archivos: functions/src/seller-ledger.ts, src/lib/seller-ledger.test.ts
  * Accion: `buildCodReceivedSet` usa `isDriverSettlementCashSettled` para dar por recibidas todas las
    asignaciones de un corte saldado; nada mas cambia
  * Verificacion: `npx vitest run` en verde, incluidas las guardas de las specs 018 y 026

- [x] **T2: Medir lo que se libera en produccion**
  * Requisitos cubiertos: RF_04, RNF_01
  * Archivos: scripts/verify-027.js, .sdd/evidence/027_la_compensacion_cubre_los_pedidos/verify.txt
  * Accion: script de solo lectura: pedidos que pasan a recibidos, dinero liberado por tienda y proveedor,
    y comprobacion de que la posicion de la plataforma no cambia
  * Verificacion: la salida se guarda como evidencia y DANDA libera sus 16 pedidos

- [x] **T3: Subir el runtime de functions a Node 22 para poder desplegar**
  * Requisitos cubiertos: ninguno funcional; habilita el despliegue (Firebase retiro Node.js 20 el
    2026-10-30 y rechaza cualquier deploy de functions). Aprobado por el responsable el 2026-11-06
  * Archivos: firebase.json, functions/package.json
  * Accion: `runtime` nodejs20 -> nodejs22 y `engines.node` 20 -> 22
  * Verificacion: `npm run build` y la suite completa en Node 22; el deploy de functions pasa

## Cobertura

| Requisito | Tarea |
|---|---|
| RF_01 | T1 |
| RF_01b | T1 |
| RF_02 | T1 |
| RF_03 | T1 |
| RF_04 | T2 |
| RF_05 | T1 (la 026 ya excluye lo recibido; la lista de "cubiertos por compensacion" queda vacia) |
| RNF_01 | T2 |
| RNF_02 | T1 |
