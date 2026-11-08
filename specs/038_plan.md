# Plan 038: cada recaudo se le cobra al domiciliario una sola vez

Spec: `specs/038_cada_recaudo_se_cobra_una_vez.md` (aprobada el 2026-11-08). Sin pantallas nuevas: las seis
historias son `(sin interfaz)` y `design-check` dio completo sin entregables.

## 0. Lo que hay hoy (y por que el arreglo no es una linea)

La regla de "cuanto efectivo pide un corte de domiciliario" existe hoy en **cuatro** sitios, y no dicen lo
mismo:

| Sitio | Recaudo | Pago del domiciliario |
|---|---|---|
| `settlementTotals` (al **crear** el corte, `orders.ts` → `buildSettlement`) | todo el de sus pedidos | solo los asientos **del corte** |
| `computeDriverCashSummary` (cada **abono**, **pago**, **conciliacion**, la **correccion** y el informe de la **026**) | todo el de sus pedidos | **todos** los del pedido |
| `cash-outstanding.ts` (T25 de la 026) | parche `belongsHere`: corta por `createdAt` si el pedido esta en un corte posterior | idem |
| `calculateDriverSettlementFinancials` (`src/lib/finance.ts`, lo que **pinta** la app) | solo `cod_revenue` (ignora `cod_remittance`) | los del corte + los del pedido |

Ademas, al crear el corte no se guarda `cashExpectedCop`: la app lo pinta con su propia copia hasta el primer
abono. El arreglo (RF_09, RF_09b) es que **una sola funcion pura** decida todas esas cifras y las cuatro las
lean de ella o del documento que ella escribio.

## 1. Arbol de modulos

### Nucleo puro (nuevo)

- `functions/src/driver-cash-ledger.ts` — **la unica regla** (RF_01-RF_03, RF_05, RF_05b, RF_08, RF_09b,
  RF_11, RF_13, RF_15, RF_17). Sin Firestore. Exporta:
  - `orderOwedByDriver(entries, driverId)` → por pedido: recaudo vigente, pago vigente, debido (§3.1).
  - `rebuildHistoricalCharges(settlement, entriesByOrder)` → lo cobrado por pedido en un corte viejo (§3.4).
  - `computeDriverCorte(input)` → cifras completas de un corte: cargos por pedido, totales, asignaciones del
    efectivo recibido, saldo a favor que entra y que sale (§3.2, §3.3).
  - `pendingDeltaOrders(input)` → pedidos con diferencia distinta de 0 que deben entrar al siguiente corte
    aunque no tengan asientos nuevos (RF_07, §3.5).
  - `planDriverCompensation(input)` → previsualizacion de la compensacion historica (RF_13, RF_16, §3.6).
  - `isOrderCodSettled(...)` → la parte nueva de "recibido" (RF_11, §3.7).
- `functions/src/settlement-math.ts` — `computeDriverCashSummary` y la rama `driver` de `settlementTotals`
  pasan a **delegar** en `computeDriverCorte`. Se conservan sus firmas publicas (las usan 7 archivos y las
  guardas de la 026) con un parametro de contexto nuevo (`DriverLedgerContext`, §2). Sin contexto lanzan
  error en vez de calcular a la antigua: es la forma de que ningun llamador se quede con la regla vieja.

### Entrada/salida (servidor)

- `functions/src/driver-ledger-io.ts` (nuevo) — `loadDriverLedgerContext(db, driverId)`: los cortes de
  domiciliario de ese domiciliario, su foto historica y sus retenciones (§2). Una lectura por coleccion.
- `functions/src/orders.ts`:
  - `createSettlement` (kind `driver`): suma a los pedidos de sus asientos sin cortar los de
    `pendingDeltaOrders` (RF_07); guarda **desde la creacion** `cashExpectedCop`, `cashCharges`,
    `creditInCop`/`creditOutCop` y las cifras de `computeDriverCorte` (RF_09). Lee los otros cortes del
    domiciliario **dentro** de la transaccion (RF_04b).
  - `recordDriverCashReceipt` y `updateSettlementStatus`: calculan **dentro** de la transaccion con el
    contexto leido en ella; si el `updateTime` de algun otro corte pendiente del domiciliario cambio respecto
    al usado, `failed-precondition` con `recalculo_cruzado` (RF_04b). Hoy el resumen se calcula fuera de la
    transaccion (`cashSummaryBeforeReceipt`): ese es el hueco.
  - `loadDriverCashInputs`: se queda (lo usa la correccion), pero el que llama a la regla le anade el contexto.
  - `buildCodReceivedSet` en la liquidacion de tienda y de proveedor: recibe el recaudo por pedido (§3.7). El
    camino de proveedor no lo tiene hoy: lee los asientos de recaudo de los pedidos que va a pagar.
- `functions/src/order-corrections-plan.ts` — el recalculo de cortes pendientes de domiciliario usa
  `computeDriverCorte`; para cada corte de domiciliario **cerrado** que tocaba el pedido, la previsualizacion
  anade `driverNextCorteDeltaCop` y un aviso con la cifra que se le devolvera o cobrara (RF_10). La huella del
  plan la incluye, asi que lo que se ve es lo que se aplica.
- `functions/src/order-corrections.ts` — carga `loadDriverLedgerContext` del domiciliario del pedido y pone
  precondicion `lastUpdateTime` sobre sus otros cortes pendientes (RF_04b, ya es el patron de este archivo).
- `functions/src/cash-outstanding.ts` — quita el parche `belongsHere` (T25) y usa `computeDriverCorte`
  (RF_09). La identidad de reconciliacion de la 026 se mantiene: se reescribe su prueba de identidad, no se
  relaja.
- `functions/src/seller-ledger.ts` — `buildCodReceivedSet(settlements, codByOrder?)`: la regla de hoy mas
  `isOrderCodSettled` (RF_11, RF_12). Sigue siendo la unica.
- Llamadores de `buildCodReceivedSet` que pasan `codByOrder`: `seller-balance.ts`, `store-api.ts`,
  `store-api-orders.ts`, `cash-outstanding.ts`, `cash-outstanding-api.ts`, `orders.ts`, `operations-app.tsx`.

### Cliente

- `src/lib/finance.ts` — `calculateDriverSettlementFinancials`: si el corte trae `cashCharges` (todos los
  creados tras el despliegue) devuelve las cifras **guardadas**; si no (cortes viejos), la copia de hoy, sin
  tocarla, para que el historico se siga viendo igual. Es la unica linea de interfaz que cambia, y no cambia
  nada visible.
- `src/components/operations-app.tsx` — pasa `codByOrder` a `buildCodReceivedSet` (2 sitios). La cuenta
  congelada de apariciones en la guarda de la 026 no cambia.

### Datos, reglas y scripts

- `firestore.rules` — `driverLedgerBaselines` y `driverCashHolds`: lectura solo admin, escritura nadie desde
  cliente.
- `scripts/snapshot-038-baseline.js` (nuevo) — escribe la foto (RF_05b) y las retenciones (RF_17). Por
  defecto **no escribe**: imprime lo que escribiria. Con `--write --approved-by "<nombre>"` escribe, y aborta
  si las retenciones no son exactamente los 16 pedidos / $694.200 de la medicion (o lo que la medicion de ese
  dia diga, impreso al lado).
- `scripts/compensate-038.js` (nuevo) — previsualiza la compensacion de un domiciliario (RF_13); con
  `--apply --approved-by --exclude KNT-005724,KNT-006347` escribe el documento de compensacion (RF_14, RF_16).
  Mismo patron que `correctOrderStatus`: huella del plan previsualizado, y si los datos cambiaron, aborta.
- `specs/038_measure.js` — deja de llevar su copia de la regla: importa `rebuildHistoricalCharges` y
  `orderOwedByDriver` de `functions/lib` (RF_05b). Anade lo de RNF_01 (§4.4).

### Pruebas

- `src/lib/driver-cash-ledger.test.ts` — unidad + propiedad (RNF_02) + los cuatro casos reales (RNF_03).
- `src/lib/settlement-math.test.ts`, `src/lib/cash-outstanding.test.ts`, `src/lib/seller-ledger.test.ts`,
  `src/lib/order-corrections-plan.test.ts` (o el que exista), `src/lib/finance.test.ts` — se ajustan a la regla
  nueva caso por caso; ningun caso existente se borra sin escribir por que.
- `src/lib/spec-038-guards.test.ts` — guardas de fuente: ningun archivo fuera de `driver-cash-ledger.ts`
  suma `cod_revenue`/`cod_remittance` contra `driver_earning` para decidir efectivo de un corte; `settlement-math`
  delega; el script de medicion importa el modulo.

## 2. Modelo de datos

```ts
/** Lo que un corte de domiciliario cobro por un pedido en su ultimo calculo (RF_03). */
type DriverCashCharge = {
  orderId: string;
  /** Recaudo que este corte cobra: cargo + pago propio. Puede ser negativo (devolucion). */
  codCop: number;
  /** Pago del domiciliario por asientos de ESTE corte (settlementId == este corte). */
  driverPayCop: number;
  /** codCop - driverPayCop, SIN recortar (RF_08). La suma por pedido entre cortes es lo debido. */
  chargedCop: number;
  /** Recaudo vigente total del pedido al calcular (RF_11, §3.7). */
  codSeenCop: number;
};

// Campos nuevos en settlements (kind "driver"). Los existentes se siguen escribiendo igual.
type DriverSettlementLedgerFields = {
  cashCharges: DriverCashCharge[];          // un elemento por pedido de orderIds, incluidos los de 0
  creditInCop: number;                      // saldo a favor (o en contra, si es negativo) que consumio
  creditOutCop: number;                     // lo que su total negativo deja para el siguiente (>= 0)
  ledgerVersion: 1;
};

/** Foto historica, un documento por domiciliario: driverLedgerBaselines/{driverId}. ~300 KB hoy. */
type DriverLedgerBaseline = {
  driverId: string;
  createdAt: string;
  createdBy: string;                        // quien aprobo (RF_05b)
  measuredDiffCop: number;                  // 694.202 hoy, para auditar
  settlements: Record<string, Array<{ orderId: string; chargedCop: number; driverPayCop: number; source: "allocation" | "rebuilt" }>>;
};

/** Retenciones de RF_17: driverCashHolds/{driverId}. 16 filas hoy. */
type DriverCashHolds = {
  driverId: string;
  createdAt: string;
  holds: Array<{ orderId: string; holdCop: number; releasedBy?: string; releasedAt?: string; compensationId?: string }>;
};
```

`cashAllocations` sigue existiendo con el mismo significado (reparto del efectivo recibido entre pedidos que
deben efectivo) porque lo leen la 026 y la 027; ahora sale de `cashCharges` con `chargedCop > 0`.

**Contexto de calculo** (`DriverLedgerContext`): los otros cortes del domiciliario (con su `updateTime`), su
foto y sus retenciones. 58 cortes + 2 documentos hoy (RNF_04: los cortes del propio domiciliario, mas sus dos
documentos de foto).

## 3. Algoritmos criticos

### 3.1 Lo que un pedido debe hoy

`debido(o) = Σ cod_revenue + cod_remittance de la tienda del pedido − Σ driver_earning del domiciliario`, con
los asientos vigentes. Es la misma cifra de la medicion. Solo cuenta el pago de **ese** domiciliario.

### 3.2 Lo ya registrado por los demas cortes

`registrado(o, X) = Σ_{Y ≠ X} cargo_Y(o)`, donde `cargo_Y(o)` es:
- `cashCharges[o].chargedCop` si Y tiene `cashCharges` (cortes nuevos);
- si no, la fila de Y en la foto historica (cortes viejos, RF_05b).

Un corte pendiente viejo (el del 2026-11-07, hoy) esta en la foto con su cifra de la asignacion; al
recalcularse por primera vez con la regla nueva pasa a tener `cashCharges` y deja de leerse de la foto.

### 3.3 El cargo de un corte

Para cada pedido `o` de X:

```
cargo_X(o)   = debido(o) − registrado(o, X) + retencion(o)     // retencion = 0 si se libero (§3.6)
pago_X(o)    = Σ driver_earning del domiciliario con settlementId == X (o que entran en X al crearlo)
recaudo_X(o) = cargo_X(o) + pago_X(o)
```

Totales: `recaudo = Σ recaudo_X`, `pago = Σ pago_X`, `bruto = Σ cargo_X + creditoEntrada`.
`efectivoEsperado = max(0, bruto)`, `creditoSalida = max(0, −bruto)`.
`creditoEntrada = Σ creditOut − Σ creditIn` de los **demas** cortes del domiciliario: puede ser negativo (una
deuda), y asi un saldo a favor que un corte pendiente reduce despues se cobra en el siguiente y no se pierde.
El pago (`driverPayCop`) sigue siendo el de los asientos propios del corte: de el depende el asiento de margen
de la plataforma (`buildPlatformWalletEntry`), que ya es por asiento y no tiene el defecto.

`cashAllocations` reparte lo recibido entre los pedidos con `cargo_X > 0`, en el mismo orden de hoy
(creacion, tracking).

Propiedad (RNF_02): tras calcular X, `Σ_Y cargo_Y(o) = debido(o) + retencion(o)` para todo pedido de X.

### 3.4 Reconstruccion historica (RF_05, foto de RF_05b)

La de `specs/038_measure.js`, validada en 60/60 cortes:
- con asignacion del pedido en el corte → `expectedCop` de la asignacion;
- corte con asignaciones donde el pedido no figura → `min(0, reconstruido)`;
- corte sin asignaciones → reconstruido;
- `reconstruido` = recaudo − pago del pedido con asientos `createdAt <=` ultimo recalculo del corte (creacion,
  abonos, pago, conciliacion).

La foto se escribe una vez. Despues, nadie reconstruye: se lee.

### 3.5 Pedidos que vuelven solos (RF_07)

Al crear un corte de domiciliario, ademas de los pedidos de sus asientos sin cortar, entran los pedidos `o`
tales que: `o` esta en algun corte del domiciliario, **no** esta en ningun corte suyo pendiente, y
`debido(o) − Σ_Y cargo_Y(o) + retencion(o) ≠ 0`. Un pedido en un corte pendiente lo absorbe ese corte al
recalcularse.

### 3.6 Retenciones y compensacion (RF_13-RF_17)

Retencion al hacer la foto: `retencion(o) = Σ_Y cargo_Y(o) − debidoVisto(o)`, donde `debidoVisto` usa solo
asientos con `createdAt <=` el ultimo recalculo del ultimo corte que contiene `o`. Asi un pedido con
movimientos nuevos aun sin cortar (una re-entrega de hoy) no queda retenido por error, y uno cuyo recaudo se
**borro** (KNT-007828) si lo queda. Con esto, al desplegar, ningun corte cambia (RNF_01 = 0).

Compensar = liberar retenciones. `planDriverCompensation` devuelve, por pedido retenido: cobrado, debido,
diferencia, si esta excluido (RF_16) y si el domiciliario tiene corte donde entraria. Aplicar escribe
`releasedBy/releasedAt/compensationId` en esas filas y un registro de auditoria; **nada mas**. El siguiente
corte del domiciliario los recoge por §3.5 con `cargo = −diferencia`. Liberar dos veces no cambia nada (ya
estaba en 0) y un pedido que vuelve a entrar no se devuelve dos veces porque su cargo ya quedo registrado
(RF_15).

### 3.7 Recibido (RF_11, RF_12)

`buildCodReceivedSet` = la regla de hoy, y ademas, para un pedido con al menos un corte **nuevo** (con
`cashCharges`):
1. todo corte nuevo con `chargedCop > 0` para el pedido esta saldado con la regla de la 027 (asignacion
   cubierta, o corte saldado en total);
2. el recaudo vigente del pedido no supera el `codSeenCop` del ultimo corte saldado que lo cobro.

Un pedido solo con cortes viejos sigue con la regla de hoy, sin cambios (RF_12). **Esto no es literalmente
"neto contra neto"** (ver §6, riesgo 1): necesita solo los cortes y los asientos de recaudo, que tienen todos los
llamadores, mientras que el neto exige el pago del domiciliario, que la tienda y la API de tiendas no leen.

## 4. Estrategia de testing

### 4.1 Unidad y propiedad (vitest, `src/lib/driver-cash-ledger.test.ts`)

- Sin red ni Firestore: el modulo es puro. Fechas fijas en ISO; ningun `Date.now()` en el nucleo.
- **Propiedad (RNF_02)**: generador propio y determinista (semilla fija, sin dependencia nueva) de secuencias
  por pedido: entrega, visita fallida, correccion entregado→fallido con corte cerrado o pendiente, recaudo
  borrado, re-entrega, cambio de tienda, abonos parciales, cortes que se recalculan en distinto orden. Tras
  cada paso: `Σ cargos = debido + retencion` y `efectivoEsperado − creditoEntrada + creditoSalida = Σ cargos`.
- RF_04b: dos recalculos con el mismo contexto viejo → el segundo detecta el cambio (prueba del pure check y
  del IO con un doble del `updateTime`).
- RF_08: corte con devolucion mayor que su recaudo → esperado 0, credito de salida exacto, el siguiente lo
  consume una vez.
- RF_09b: en un corte, ningun pedido con dos montos; `cashExpectedCop = recaudo − pago (+ credito)`.

### 4.2 Casos reales (RNF_03)

Fixtures en `src/lib/fixtures/038-*.json` con los asientos y cortes reales, **anonimizados** (sin telefono ni
direccion; los ids y tracking se dejan porque son la evidencia): KNT-003259 (reversa neteada, +78.900),
KNT-004540 (recaudo borrado, +78.900), KNT-002682 (dos cortes, +93.900), KNT-002965 (pago dos veces, −8.000).
Para cada uno: la regla vieja reproduce el cobro de produccion y la nueva el debido.

### 4.3 Reconstruccion por pedido (RF_05b)

La prueba no compara totales: para cada corte de los fixtures, cada pedido con asignacion debe reconstruir
**su** `expectedCop`. Contra produccion, `specs/038_measure.js --check` hace lo mismo con los 60 cortes y
falla si un solo pedido no cuadra.

### 4.4 Medicion antes de desplegar (RNF_01)

`specs/038_measure.js --deploy-check` (solo lectura): para cada corte pendiente y para el siguiente corte de
cada domiciliario, esperado con la regla vieja vs. la nueva **con las retenciones que escribiria la foto**;
y el conjunto de "recibidos" viejo vs. nuevo (RF_12). Ambas diferencias deben ser 0.

### 4.5 Guardas y suite

Las guardas `spec-018`, `spec-026`, `spec-027` en verde; `spec-038-guards` nueva. `npx tsc --noEmit` raiz y
`functions/`, `npx vitest run`, `npm run lint`.

## 5. Dependencias nuevas

Ninguna. El generador de la prueba de propiedad es un LCG de diez lineas con semilla fija.

## 6. Riesgos

1. **RF_11 no queda "neto contra neto" al pie de la letra** (§3.7). Se compara con lo que todos los
   llamadores tienen. Requiere que el responsable lo acepte y que la spec se ajuste (constitucion 1) antes de
   implementar esa tarea.
2. **Cuatro copias convergen en una**: el riesgo es un llamador olvidado. Mitigacion: `computeDriverCashSummary`
   sin contexto lanza error, y la guarda de fuente.
3. **La identidad de la 026** (`cash-outstanding.ts`) depende de la regla vieja y del parche T25. Se reescribe
   con la nueva; si la identidad no cierra, la tarea no se da por hecha.
4. **Foto de ~300 KB** en un documento: holgado frente a 1 MiB, y no crece (los cortes nuevos guardan su
   registro en si mismos).
5. **Orden de despliegue**: reglas → foto (con aprobacion) → functions → hosting. Functions sin foto lanzan
   error al calcular un corte de domiciliario: es intencional, para no cobrar con la regla nueva sin
   retenciones. La foto antes que functions; hosting despues porque la app lee los campos nuevos.
6. **Un pedido que cambia de tienda** (KNT-005724): su recaudo esta repartido entre dos tiendas; §3.1 suma las
   dos. Un llamador que solo lee los asientos de una tienda (saldo de tienda) veria solo su parte en §3.7:
   esa comprobacion usa el recaudo que el llamador tiene y es mas estricta, no mas laxa.
7. **Funciones mas pesadas**: crear un corte de domiciliario ya barre todos los asientos; se anaden sus cortes
   (58) y dos documentos. Sin indices nuevos (`where kind == driver && ownerId ==` ya existe: lo usa la app del
   domiciliario).
