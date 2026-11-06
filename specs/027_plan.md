# Plan 027: un corte saldado cubre todos sus pedidos con efectivo

## 1. Arbol de modulos

| Archivo | Cambio |
|---|---|
| `functions/src/seller-ledger.ts` | `buildCodReceivedSet`: en un corte de domiciliario saldado (`isDriverSettlementCashSettled`), da por recibidos TODOS los pedidos de `cashAllocations`, cubiertos o no. El resto de la regla no cambia. |
| `src/lib/seller-ledger.test.ts` | Pruebas de RF_01, RF_01b, RF_03 y casos limite. |
| `scripts/verify-027.js` | Solo lectura contra produccion: que pedidos pasan a recibidos y cuanto se libera por tienda y por proveedor (RF_04, DoD 3), y que la posicion no cambia (RNF_01). |

No se toca ningun otro archivo: la regla es una sola funcion (RF_02) y ya la consumen la liquidacion de
tienda (`orders.ts`), el saldo de tienda (`seller-balance.ts`), la API de tiendas (`store-api*.ts`), la
alerta de efectivo (`cash-outstanding*.ts`) y la UI (`operations-app.tsx` la importa desde `functions/src`).

## 2. Modelo de datos

Sin cambios. Se leen campos existentes de `settlements` (`kind`, `status`, `cashExpectedCop`,
`cashReceivedCop`, `cashReceipts`, `cashPendingCop`, `cashAllocations[{orderId, covered}]`, `orderIds`).
Ningun documento se reescribe (RNF_02).

## 3. Algoritmo

```
para cada corte con kind == "driver":
  si tiene cashAllocations no vacio:
     saldado = isDriverSettlementCashSettled(corte)   // pagado|conciliado, pendiente 0, recibido >= esperado
     para cada asignacion con orderId:
        si asignacion.covered o saldado: agregar orderId
  si no, y status es paid|reconciled: agregar todos los orderIds   // igual que hoy
```

- RF_01: corte saldado -> toda asignacion cuenta, cubierta o no.
- RF_01b: un pedido en `orderIds` sin asignacion en un corte saldado no entra por ese corte (solo se recorre
  `cashAllocations`).
- RF_03: corte pagado/conciliado con faltante real (pendiente > 0 o recibido < esperado) -> solo las cubiertas.
- Corte pendiente: nunca saldado (`isDriverSettlementCashSettled` exige paid|reconciled), asi que la variante
  que la spec 018 elimino no vuelve.

`isDriverSettlementCashSettled` vive en `settlement-math.ts`, que no importa nada de `seller-ledger.ts`: no
hay ciclo. La UI ya importa `settlement-math` indirectamente por `functions/src`, asi que no cambia el bundle
de forma apreciable.

## 4. Estrategia de pruebas

Pruebas puras en `src/lib/seller-ledger.test.ts` con cortes literales (sin Firestore, sin fechas):
saldado con asignacion sin cubrir -> recibida; faltante real -> no; corte pendiente con pendiente 0 -> no;
pedido en `orderIds` sin asignacion -> no; excedente -> saldado; corte sin `cashPendingCop` y recibido igual a
lo esperado -> saldado. La guarda anti-copia de la 026 (`spec-026-guards.test.ts`) debe seguir en verde.

Verificacion contra produccion con `scripts/verify-027.js` (ADC, solo lectura), que compara la regla vieja
(copiada en el script solo como linea base) contra la nueva importada de `functions/lib`.

## 5. Dependencias nuevas

Ninguna.
