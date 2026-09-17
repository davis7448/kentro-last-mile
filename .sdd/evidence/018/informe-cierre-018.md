# Informe de cierre — Spec 018: la tienda ve el mismo saldo que el admin puede liquidarle

- **Fecha:** 2026-09-17
- **Estado:** desplegada en produccion el 2026-09-17 (functions y hosting, dos veces: tras T15 y tras T16)
- **Pendiente del responsable:** nada de la spec (DoD completo); PR cuando lo decida

## Que cambio para las tiendas

| Tienda | Antes: tarjeta grande | Antes: cierre admin | Ahora: tienda = admin | Efectivo con domiciliario | Retenido |
|---|---|---|---|---|---|
| Bella Mujer | 1.603.350 | 354.280 | **109.610** | 1.249.070 | 244.670 (4 pedidos; 15 en la calle) |
| DANDA | 4.889.900 | 229.200 | **229.200** | 6.085.900 | 0 (DANDA no paga fallido) |
| Kovia | 1.139.385 | 833.885 | **833.885** | 305.500 | 0 |
| Nambu | 2.358.910 | 2.054.710 | **2.054.710** | 304.200 | 0 |
| ADMA COMERCIAL | 57.000 | −26.500 | **−26.500** (deuda) | 83.500 | 0 |

Medido en produccion el 2026-09-17 (`scripts/verify-018.js compare`): el calculo del servidor con consultas
acotadas y el del admin con colecciones enteras **coinciden al peso** en las cinco, y total = disponible +
efectivo con domiciliario + retenido en todas. Bella Mujer baja de 354.280 a 109.610 en el cierre del admin
porque ahora se retiene el flete de devolucion de sus 15 pedidos en la calle (180.000) en pedidos completos.

## Veredicto por requisito

| Requisito | Veredicto | Evidencia |
|---|---|---|
| RF_01 una sola regla | Cumplido | `seller-balance.ts`; guardas T5–T10; `compare` al peso; E2E tienda == admin |
| RF_02 disponible en pedidos completos | Cumplido | `seller-balance.test.ts` |
| RF_03 abonos | Cumplido | `seller-balance.test.ts`, `seller-ledger.test.ts` |
| RF_04 efectivo recibido unico | Cumplido | `seller-ledger.test.ts`; T1: 0 tiendas y 0 proveedores cambian de cifra |
| RF_05 efectivo con domiciliario | Cumplido | pruebas + E2E (1.249.070) |
| RF_06/RF_07 retencion = cobro real | Cumplido | `seller-retention.test.ts`; mutacion registrada (`mutacion-rnf02.txt`) |
| RF_08 total cuadra | Cumplido | invariante en pruebas y en produccion |
| RF_09–RF_11 que pedidos retienen | Cumplido | `seller-retention.test.ts`; `applyOrderTransition` sella `pickedUpAt` |
| RF_12–RF_15, RF_23, RF_24 corte | Cumplido (sin corte real en produccion) | `selectSettlementEntries` probado; guardas de `createSettlement` |
| RF_16 solicitud bloqueada en cero | Cumplido | `payoutRejectionMessage` + guardas |
| RF_17 la solicitud no manda | Cumplido | guarda |
| RF_18/RF_19 pantalla tienda | Cumplido | E2E produccion 390 y 1280, 0 errores de consola |
| RF_20 cierre admin | Cumplido | E2E produccion (la fila converge en ~5,5 s, ver seguimiento) |
| RF_21 refresco 5 min | Cumplido | guarda |
| RF_22 sin cifra parcial | Cumplido | T1: 0 asientos ilegibles; guardas; API 409 |
| RF_25 API tiendas | Cumplido | `store-summary.test.ts` (contrato: `disponibleCop` baja, nuevo `retenidoCop`) |
| RNF_01–RNF_03 | Cumplido | pruebas y `query-check` (DANDA 328 candidatos en 362 ms, sin indice nuevo) |
| RNF_04 +10 % de tiempo | Cumplido tras T18 | antes 989/975 ms; T16 dejaba movil fuera (1.094–1.726 ms); T18 (despertar la callable en la pantalla de entrada): movil 991 y 1.015 ms, escritorio 1.023 y 894 ms |

## Definition of Done

1. Cada RF con prueba: **si** (1.415 pruebas en verde, 37 archivos).
2. Prueba que ata tienda, admin, API y corte: **si**.
3. Retencion == cobro de fallido en los cuatro casos: **si**, con mutacion.
4. Dos cortes encadenados sin pedido partido: **si**.
5. Produccion, cinco tiendas al peso: **si**.
6. lint (0 errores, 3 avisos previos), tsc raiz y functions, suite: **si**.
7. El responsable mira Bella Mujer en tienda y admin: **si** (confirmado por el responsable el 2026-09-17: mismo valor en las dos pantallas).

## Revision adversarial

Tres rondas con agentes en contexto limpio (un agente por ronda que revisa y refuta; no el workflow de dos
fases):

- **Ronda 1** (25 requisitos): 6 hallazgos (1 alto: la fila de una tienda con disponible 0 desaparecia del
  cierre) → corregidos en T14.
- **Ronda 2** (8 requisitos): confirmo los 6 arreglos y encontro 3 nuevos (1 alto: desde una fila sin asientos
  el admin podia crear un corte de la tienda entera y marcarlo pagado) → corregidos en T15.
- **Ronda 3** (6 requisitos): arreglos confirmados, sin hallazgos medios o altos.

## Decisiones que necesita el responsable

1. ~~RNF_04 en movil~~ — resuelto con T18 sin coste fijo (opcion A elegida con el responsable).
2. ~~Aviso a quien use la API para tiendas~~ — resuelto con RF_26 (T17): la API lo explica en `avisos` de su indice y de `/resumen`, desplegado y comprobado en produccion.

## Seguimiento propuesto (fuera de esta spec)

- **Cierre del admin al abrir:** durante ~5 s, hasta que llegan los pedidos viejos rescatados por id, las filas
  de tienda muestran $0 (ya pasaba antes de la 018; el pago queda bloqueado mientras tanto). Mostrar "cargando"
  en vez de $0.
- **Spec 019:** manejo de bodega cobrado dos veces al reabrir un pedido cuyo manejo ya se pago.
- Observaciones de severidad baja de la ronda 3: corte por fechas llamado directamente que ya seria negativo;
  la fila plegada con saldo incompleto muestra $0 (el detalle si avisa); el abono a tienda se limita en el
  servidor por el total sin cortar, no por el disponible.
