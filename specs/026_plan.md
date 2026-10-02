# Plan tecnico — Spec 026: que nadie descubra a los tres meses que el efectivo de una entrega nunca llego

- **Spec:** `specs/026_efectivo_que_no_llega_a_un_corte.md` — **aprobada el 2026-10-02** y **enmendada el
  mismo dia** (RF_09 "cubierto por compensacion", decidido por el responsable; seccion 9 de la spec). Grill
  omitido por decision del responsable; las preguntas abiertas del plan se respondieron con las propuestas
  por defecto.
- **Fecha:** 2026-10-02 (revisado tras cinco pasadas de `/sdd-analyze` el mismo dia; ver seccion 12).
- **Spec relacionada:** `specs/027_la_compensacion_cubre_los_pedidos.md` (**borrador**): corrige de fondo
  `buildCodReceivedSet`. Esta spec no la implementa; solo muestra aparte lo que la 027 corregira.
- **Diseno:** `specs/design/026_efectivo_que_no_llega_a_un_corte/` (README + 11 pantallas, redibujadas y
  observadas tras la enmienda). Pantallas:
  - admin (HU_01): `HU_01.aviso-operacion`, `HU_01.lista` (movil), `HU_01.lista-escritorio`, `HU_01.plazo`,
    `HU_01.cargando`, `HU_01.vacio`, `HU_01.error`, `HU_01.ilegibles`;
  - lider (HU_02): `HU_02.finanzas`, `HU_02.al-dia`, `HU_02.error`.
- **Evidencia:** `.sdd/evidence/026_efectivo_que_no_llega_a_un_corte/` (abajo `EV/`).

### Preguntas del plan: resueltas (2026-10-02, seccion 9 de la spec)

| Pregunta | Respuesta aplicada |
|---|---|
| P1 — RNF_02 y total del admin | "coincide salvo diferencias explicadas por causa, residuo $0" (4.4). El admin ve el **recaudo bruto** y la conciliacion plegada |
| P2 — canal | webhook generico por secreto `OPS_NOTICE_WEBHOOK_URL`; `none`/vacio = solo en la app (2.5) |
| P3 — umbral | `notifyMinCop` por defecto **20.000** |
| P4 — plazo | global |
| P5 — hora y primera corrida | diaria 08:00 `America/Bogota`; la primera corrida con canal avisa todo el atraso en un mensaje y lo marca |
| P6 — vista del lider | complementa "Pendiente por entregar" |
| P7 — neto <= 0 | fuera de alcance; se ven con $0 y no avisan |
| P8 — `liquidated` | se incluyen |
| Enmienda — corte saldado por compensacion | estado propio `covered_by_netting`, aparte, sin vencer ni avisar (2.9). Decidido por el responsable |
| Enmienda — RF_05 | "al menos una vez", aceptado (2.4); el texto visible conserva "una vez" |

## 1. Lo que hay hoy (leido en el codigo, no supuesto)

| Donde | Que hace | Consecuencia para la 026 |
|---|---|---|
| `functions/src/seller-ledger.ts` `buildCodReceivedSet` | LA regla de "recibido" (spec 018 RF_04): con `cashAllocations`, las `covered`; sin ellas, el corte `paid`/`reconciled` cubre todos sus `orderIds` | RF_01 se cumple **importandola**. No se cambia (spec 027) |
| `seller-ledger.ts` `isSellerEntryEligible` | compuerta de tienda/proveedor para `delivered` y `liquidated` | universo: `cod` y `delivered|liquidated` |
| `functions/src/settlement-math.ts` `computeDriverCashSummary` | esperado del corte **agregado** (`max(0, Σcod − Σpago)`, el pago incluye fallidos); asigna lo recibido pedido a pedido solo a los que deben efectivo | **origen de la compensacion**: en un corte saldado exacto los 1-3 pedidos mas nuevos quedan `covered: false` (29 cortes, 36 pedidos, $1.151.997 medidos el 2026-10-02; unidad por confirmar en T1) |
| `settlement-math.ts` `settlementCashReceivedCop` | recibido del corte | predicado de saldado (2.9) y recalculo (4.4) |
| `functions/src/orders.ts:1464, 1571` | `cashPendingCop = max(0, expected − received)` al conciliar/registrar recibos | el guardado puede quedar viejo (4.4) |
| `functions/src/orders.ts:~1949` `buildSettlement` | crea cortes de domiciliario **sin** `cashPendingCop` | campo opcional; ausente = 0 como la posicion; causa propia (4.4); T1 los cuenta |
| `functions/src/platform-position.ts` | `driverReceivableCop = Σ (cashPendingCop || 0) + max(0, codFuera − pagoFuera)`; "fuera" por pertenencia a `settlement.orderIds`; proveedor `supplierId ?? "(sin proveedor)"` | mismo criterio, documentos y clave (T3) |
| `getPlatformPosition` | lee `walletEntries` y `settlements` enteras | precedente de coste (4.3) |
| `src/lib/finance.ts:863` `calculatePlatformPosition` | espejo de cliente (`platform-position.test.ts`) | la extraccion no lo mueve |
| `src/components/operations-app.tsx` (l. 53, 7509, 8027) | ya usa `buildCodReceivedSet` (3 apariciones) | guarda RNF_01 limitada a archivos nuevos; conteo congelado (5.1) |
| `src/lib/firebase/state-store.ts` | ya lee `walletEntries` y `settings` | fuera de la guarda; ninguna tarea lo toca |
| `functions/src/orders.ts:754` | lider por claim `token.driverId` | 2.7 |
| `functions/src/wallet-entries.ts:279` `stripUndefined` | superficial | 2.8 |
| Canales salientes | ninguno | 2.5 |
| `settings/{id}` / `community-floor-trigger.ts` | trigger sobre `settings/global` | plazo en `settings/cashAlerts` |
| `src/lib/firebase/auth.ts` | envoltorios `getFirebase<X>` / `<verbo>Firebase<X>`; no hay precedente de `vi.mock` de este archivo | `getFirebaseCashOutstanding`, `updateFirebaseCashAlertSettings`; la cache va fuera (2.1) |

## 2. Decisiones de diseno

### 2.1 Calcular en servidor, dos modos de carga (RF_07, RNF_01)

Un callable `getCashOutstanding` recorre en servidor todas las contraentregas entregadas sin ventana de
fecha y les resta las cubiertas con `buildCodReceivedSet`. Opcion A (recorrer en cada llamada); B (cola
materializada) queda como Fase 2 con umbral; C (campo en el pedido) descartada (spec 017, principio 5).

| Modo | Quien | Lectura (4.3) | Devuelve |
|---|---|---|---|
| **resumen** (`includeReconciliation: false`, defecto) | tarjeta de Operacion, linea de Por pagar, lider, programada | `targeted` | sin `reconciliation` |
| **con conciliacion** (`true`) | solo la pestana "Efectivo sin llegar" | `full` | con `reconciliation` |

**Carga resumen compartida — cache con la llamada inyectada:** en `src/lib/cash-outstanding-loads.ts`
(T14), sin importar `auth.ts`:

```ts
export function createCashOutstandingSummaryCache(
  fetchReport: (input: { includeReconciliation: boolean }) => Promise<CashOutstandingReport>
): {
  get(options: { uid: string; refresh?: boolean }): Promise<CashOutstandingReport>; // una peticion por uid
  prime(uid: string, report: CashOutstandingReport): void;   // la carga con conciliacion la sustituye
  clear(): void;
};
```

La instancia la crea `cash-outstanding-admin.tsx` (T15) con `getFirebaseCashOutstanding` y el `uid` de la
sesion. Se prueba con un `fetchReport` falso, sin `vi.mock`.

**Frecuencia** (README, decision 11; sin suscripcion):

- Admin: la carga resumen se pide una vez al entrar y solo "Actualizar" la refresca; tarjeta y linea de
  proveedor la comparten.
- Pestana: al abrirla y con "Actualizar", `includeReconciliation: true` y `prime`.
- Guardar "Plazo y aviso": `reloadAfterCashAlertSave` (T16): pestana abierta → con conciliacion y `prime`;
  cerrada → `get({ refresh: true })`.
- Filtro "Lider": en cliente; con filtro activo el cuadre no se muestra.
- Lider: al abrir Finanzas y con "Actualizar", resumen. Programada: una al dia, resumen.

### 2.2 Un solo modulo puro; la regla de recibido no se copia (RF_01)

`functions/src/cash-outstanding.ts` es puro. Importa `buildCodReceivedSet` y `codPartialReceivedCop` de
`./seller-ledger` (T4) y no toca `cashAllocations`. En el nucleo, la unica comparacion de estado de corte es
`status === "pending"`; el saldado por compensacion lo decide `isDriverSettlementCashSettled` (2.9, en
`settlement-math.ts`). Los rotulos viven en el modelo de vista.

**Guarda anti-copia** (`spec-026-guards.test.ts`):

- Lista fija: `functions/src/cash-outstanding.ts`, `functions/src/cash-outstanding-api.ts`,
  `functions/src/cash-overdue-notice.ts`, `src/lib/cash-outstanding-view.ts`.
- `describe("T6 · RF_01: la regla de recibido no se copia")`: importa y llama `buildCodReceivedSet`;
  `findReceivedRuleCopies` (`cashAllocations`, `covered`, fuera de comentarios) da `[]` en los que ya
  existan (los pendientes, nombrados); mutacion con el cuerpo de la regla pegado detectada.
- `describe("T17 · RF_01: la guarda anti-copia mira los cuatro archivos")`: los cuatro existen y dan `[]`.
- Equivalencia (T6): todo pedido de `rows` o `nettedRows` es `!isSellerEntryEligible` (la 026 no cambia la
  compuerta) y todo no elegible del universo esta en una de las dos.
- Evidencia manual en `EV/mutacion-rf01.txt`.

Zod en la frontera; lo ilegible a `unreadableOrderIds`, `unreadableSettlementIds`, `unreadableEntryIds`.

### 2.3 Fecha de entrega y antiguedad

`deliveredAt`: `closedAt` → ultima evidencia `delivery` → `cod_revenue` → `updatedAt` ("aprox."). `ageDays =
floor((now − deliveredAt) / 86_400_000)`; vencido = `ageDays > overdueDays` **y no `covered_by_netting`**.

### 2.4 Aviso fuera de la app (RF_05)

`notifyOverdueCash` diaria 08:00 Bogota, modo resumen. Sin canal → `skipped_no_channel` sin marcar.
Candidatas = `selectNoticeCandidates` sobre `report.rows` (los `covered_by_netting` estan en `nettedRows` y
nunca son candidatos). Un mensaje por corrida agrupado por lider. Marca `cashOverdueNotices` solo tras
`ok`. Corrida en `cashOverdueRuns`.

**"Una sola vez por pedido" = al menos una vez** — decision aceptada (spec, seccion 9): si el envio sale y
el marcado cae, se repite (`mark_failed`). El texto visible de `HU_01.plazo` conserva "una vez por pedido"
porque la repeticion solo ocurre ante un fallo del marcado.

### 2.5 Canal: webhook con `fetch` nativo

`ops-notify.ts` (sin `firebase-functions`): `isOpsChannelConfigured(url)` (`""`, espacios, `none` = no) y
`sendOpsNotice(text, { url, fetchImpl?, timeoutMs? }): Promise<OpsNoticeResult>`, nunca lanza. El secreto
`OPS_NOTICE_WEBHOOK_URL` (`defineSecret` en `cash-outstanding-api.ts`) se crea **siempre** antes del
despliegue (URL o `none`); si no existe, el despliegue falla antes de tocar nada y se crea.

### 2.6 Plazo y umbral (RF_04)

`settings/cashAlerts` por `updateCashAlertSettings` (Zod + `auditLogs`); defectos 7 dias y $20.000.

### 2.7 Alcance por rol (RF_06)

`resolveCashOutstandingScope(auth, input)` (T12): admin → `{ kind: "admin", includeReconciliation }`;
`driver` con `token.driverId` → `{ kind: "leader", driverId }` (sin conciliacion, sin proveedor); driver sin
claim, otro rol o sin sesion → `permission-denied`.

### 2.8 Toda escritura nueva pasa por `stripUndefined`

`buildCashAlertSettingsDoc`, `buildCashAlertAuditDoc` (T5), `buildNoticeDocs`, `buildRunDoc` (T10);
documentos planos, prueba profunda; guarda en T13.

### 2.9 Cubierto por compensacion (RF_09, decidido por el responsable 2026-10-02)

Predicado puro en `settlement-math.ts` (T4), junto a `settlementCashReceivedCop`:

```ts
/** Corte de domiciliario cerrado con el efectivo TOTAL saldado. Ausencia de cashPendingCop = 0, como la
 *  posicion. No mira cashAllocations: no es la regla de recibido, y no la cambia (spec 027). */
export function isDriverSettlementCashSettled(settlement: SettlementDoc): boolean;
// kind === "driver" && (status === "paid" || status === "reconciled")
// && (cashPendingCop ?? 0) === 0
// && typeof cashExpectedCop === "number" && settlementCashReceivedCop(settlement) >= cashExpectedCop
```

Se usa `>=` (un corte con excedente tambien esta saldado). En los 29 cortes medidos es igualdad; T1 cuenta
cuantos tienen excedente.

`location` (precedencia, sobre los cortes de domiciliario que contienen al pedido):

1. alguno `pending` → `in_settlement_open`;
2. si no, alguno con `isDriverSettlementCashSettled` → **`covered_by_netting`**;
3. si no, alguno `paid`/`reconciled` → `settlement_paid_short`;
4. ninguno → `outside_settlement`.

Un pedido `covered_by_netting` va a `report.nettedRows`, no a `report.rows`: no entra en `byLeader`,
`bySupplier`, ni en los totales de efectivo no recibido ni vencidos; `isOverdue = false`; no es candidato
de aviso. Tiene sus propios totales (`totals.netted*`). No cambia ningun saldo ni la regla de RF_01.

## 3. Arbol de modulos

| Archivo | Cambio | Responsabilidad | Tarea |
|---|---|---|---|
| `scripts/verify-026.js` | nuevo, solo lectura | `baseline`, `query-check`, `compare`, `compare --deployed` | T1, T2, T18 |
| `docs/rendimiento.md` | toca | coste por modo, umbrales | T2 |
| `firestore.indexes.json` | toca solo si `query-check` pide indice | se **anade**, nunca se reemplaza | T2 |
| `functions/src/driver-receivable.ts` | nuevo, puro | `computeDriverReceivable` y predicados | T3 |
| `functions/src/supplier-withheld.ts` | nuevo, puro | clave y agrupacion de proveedor | T3 |
| `functions/src/platform-position.ts` | toca | delega sin cambio de resultado | T3 |
| `functions/src/seller-ledger.ts` | toca | `codPartialReceivedCop` | T4 |
| `functions/src/settlement-math.ts` | toca | `isDriverSettlementCashSettled` (2.9) | T4 |
| `functions/src/cash-outstanding-schemas.ts` | nuevo, puro | Zod (con `cashPendingCop` opcional), ajustes, asientos, constructores (T5); `resolveCashOutstandingScope` (T12) | T5, T12 |
| `functions/src/cash-outstanding.ts` | nuevo, **puro** | informe y conciliacion | T6-T9 |
| `functions/src/cash-overdue-notice.ts` | nuevo, puro | candidatas, mensaje, constructores | T10 |
| `functions/src/ops-notify.ts` | nuevo | canal | T11 |
| `functions/src/cash-outstanding-api.ts` | nuevo | cargador, callables, programada, secreto | T12, T13 |
| `functions/src/index.ts` | toca | exporta | T12, T13 |
| `src/lib/firebase/auth.ts` | toca | `getFirebaseCashOutstanding`, `updateFirebaseCashAlertSettings` | T14 |
| `src/lib/types.ts` | toca | reexporta tipos | T14 |
| `src/lib/cash-outstanding-view.ts` | nuevo, puro | modelo de vista, rotulos | T14 |
| `src/lib/cash-outstanding-loads.ts` | nuevo, puro (llamadas inyectadas) | `createCashOutstandingSummaryCache` (T14), `reloadAfterCashAlertSave` (T16) | T14, T16 |
| `src/components/cash-outstanding-admin.tsx` | nuevo | instancia de la cache, tarjeta, pestana, dialogo, linea de proveedor | T15, T16 |
| `src/components/cash-outstanding-leader.tsx` | nuevo | panel del lider | T17 |
| `src/components/operations-app.tsx` | toca | solo montaje | T15, T16, T17 |
| `src/lib/driver-receivable.test.ts` | nuevo | | T3 |
| `src/lib/seller-ledger.test.ts`, `src/lib/settlement-math.test.ts` | tocan | `codPartialReceivedCop`, `isDriverSettlementCashSettled` | T4 |
| `src/lib/cash-outstanding-schemas.test.ts` | nuevo | | T5 |
| `src/lib/cash-outstanding.test.ts` | nuevo | | T6-T9 |
| `src/lib/cash-overdue-notice.test.ts` | nuevo | | T10 |
| `src/lib/ops-notify.test.ts` | nuevo | | T11 |
| `src/lib/cash-outstanding-view.test.ts` | nuevo | | T14 |
| `src/lib/cash-outstanding-loads.test.ts` | nuevo | cache (T14), recarga (T16) | T14, T16 |
| `src/lib/spec-026-guards.test.ts` | nuevo | un bloque por tarea | T1, T6, T12, T13, T15, T16, T17 |
| `EV/*` | nuevo | linea base (con ids), query-check, mutacion, compare | T1, T2, T6, T18 |

Sin cambios en `firestore.rules`.

## 4. Modelo de datos y algoritmos

### 4.1 Tipos (en `cash-outstanding.ts`)

```ts
export type CashSettlementLocation =
  | "outside_settlement" | "in_settlement_open" | "settlement_paid_short"
  | "covered_by_netting";               // RF_09: corte cerrado y saldado en total (2.9)
export type DeliveredAtSource = "closedAt" | "evidence" | "cod_entry" | "updatedAt";

export type CashOutstandingOrder = {
  id: string; trackingCode?: string; sellerId: string;
  driverId: string | null; messengerId: string | null;
  status: string; paymentMethod: string; totalCop: number;
  closedAt?: string; updatedAt?: string; evidence: Array<{ type: string; createdAt: string }>;
};

export type CashAlertSettings = { overdueDays: number; notifyMinCop: number };

export type CashOutstandingInput = {
  orders: CashOutstandingOrder[];
  settlements: SettlementDoc[];               // kind "driver"; cashPendingCop puede faltar (= 0)
  receivableEntries: WalletEntryDoc[];
  coverage: "full" | "targeted";
  productCostEntries: WalletEntryDoc[];
  names: { sellers: Map<string, string>; leaders: Map<string, string>; messengers: Map<string, string> };
  settings: CashAlertSettings; settingsInvalid: boolean;
  channelConfigured: boolean | null;
  scope: { kind: "admin"; includeReconciliation: boolean } | { kind: "leader"; driverId: string };
  now: string;
  unreadableOrderIds: string[]; unreadableSettlementIds: string[]; unreadableEntryIds: string[];
};

export type SupplierWithheld = { supplierId: string; supplierName: string; amountCop: number };
export type CashRowSettlement = { id: string; status: "pending" | "paid" | "reconciled"; createdAt: string; cashSettled: boolean };

export type CashOutstandingRow = {
  orderId: string; trackingCode: string;
  sellerId: string; sellerName: string;
  leaderId: string | null; leaderName: string | null;
  messengerId: string | null; messengerName: string | null;
  deliveredAt: string; deliveredAtSource: DeliveredAtSource;
  ageDays: number; isOverdue: boolean;        // false si covered_by_netting
  collectedCop: number; collectedSource: "wallet" | "order_total";
  driverPayCop: number; expectedCashCop: number; receivedCop: number; outstandingCop: number;
  location: CashSettlementLocation;
  settlements: CashRowSettlement[];           // createdAt desc
  attributedSettlementId: string | null;
  supplierWithheld: SupplierWithheld[];
};

export type CashOutstandingGroup = {
  leaderId: string | null; leaderName: string | null;   // null = "Sin lider"
  orderCount: number; collectedCop: number; outstandingCop: number;
  overdueCount: number; overdueCop: number; oldestDeliveredAt: string;
};

export type CashOutstandingReport = {
  generatedAt: string; mode: "summary" | "with_reconciliation";
  settings: CashAlertSettings; settingsInvalid: boolean; channelConfigured: boolean | null;
  rows: CashOutstandingRow[];                 // efectivo que falta; deliveredAt asc
  nettedRows: CashOutstandingRow[];           // RF_09, aparte; deliveredAt asc
  byLeader: CashOutstandingGroup[];           // solo `rows`; orden overdueCop desc (empate: outstandingCop, id)
  bySupplier: Array<SupplierWithheld & { overdueAmountCop: number }>; // solo `rows`; [] para el lider
  totals: {
    orderCount: number; collectedCop: number; outstandingCop: number;
    outsideSettlementCop: number; inOpenSettlementCop: number; paidShortCop: number;
    overdueCount: number; overdueCop: number;
    nettedCount: number; nettedCollectedCop: number; nettedSettlementCount: number;
  };
  reconciliation: PositionReconciliation | null;
  isIncomplete: boolean;
  unreadableOrderIds: string[]; unreadableSettlementIds: string[]; unreadableEntryIds: string[];
};
```

Zod (T5): entrada `{ includeReconciliation: boolean = false }.strict()`; ajustes 1..120 / >= 0, defectos 7
y 20.000; corte de domiciliario con `cashPendingCop`, `cashExpectedCop`, `cashReceivedCop` **opcionales**
(`buildSettlement` los crea sin `cashPendingCop`; ausente = 0); asiento con `amountCop` finito.

**Rotulos (mapa de `cash-outstanding-view.ts`, T14; README decisiones 4, 5 y 12):**

| `location` | Admin | Lider |
|---|---|---|
| `in_settlement_open` | "En corte abierto" | "En el corte del <fecha>, abierto" (el `pending` mas reciente) |
| `settlement_paid_short` | "Pagado con faltante" | "Corte del <fecha> pagado con faltante" (el mas reciente) |
| `outside_settlement` | "Fuera de todo corte" | "No esta en ningun corte" |
| `covered_by_netting` | "Cubierto por compensacion" | "Cubierto en el corte del <fecha>" (el saldado mas reciente) |

Grupo con `leaderId: null`: "Sin lider", con el texto "no hay a quien cobrarle". Tarjeta de Operacion: "el
lider con mas efectivo vencido" = `byLeader[0]` (orden por `overdueCop`).

### 4.2 `buildCashOutstandingReport(input)`

1. `received`, `partial` (`./seller-ledger`).
2. Filtro propio: `cod`, `delivered|liquidated`, alcance, `!received.has(id)`. Sin fecha.
3. Por candidato: importes con los predicados de `./driver-receivable`; `settlements` con `cashSettled =
   isDriverSettlementCashSettled(s)`; `location` por la precedencia de 2.9; `deliveredAt`, `ageDays`,
   `isOverdue` (falso si `covered_by_netting`); `supplierWithheld`.
4. `covered_by_netting` → `nettedRows`; el resto → `rows`. Agrupaciones (una fila con `driverId: null`
   forma el grupo `leaderId: null`) y totales; `isIncomplete`.
5. `reconciliation` solo con admin + `includeReconciliation` + `full`.

Invariante (T6): `rows` y `nettedRows` identicos con `full` y `targeted`.

### 4.3 Cargador y coste

`coverage = "full"` solo con admin e `includeReconciliation`.

1. `orders` (`cod`, `delivered|liquidated`, + `driverId` del claim), `select`, sin fecha ni `limit`.
2. `settlements` `kind == "driver"`.
3. `received` y descarte.
4. `full`: `walletEntries` de tienda `cod_revenue|cod_remittance` y de domiciliario `driver_earning`,
   enteras. `targeted`: `orderId in` por lotes de 30 sobre los no recibidos.
5. `product_cost` (admin). 6. Zod por asiento (`unreadableEntryIds`), nombres, ajustes, canal.

| Modo | Estimacion hoy | Crece | Cuando |
|---|---|---|---|
| resumen | ~4.000-6.000 lecturas | ~1.800/mes | una por sesion de admin, por Finanzas del lider, una al dia |
| con conciliacion | ~12.000-16.000 | ~2.500/mes | pestana, "Actualizar" en ella, guardar ajustes con ella abierta |

Umbrales: con conciliacion > 30.000 docs o > 3 s → conciliacion diaria guardada **con decision del
responsable**; resumen > 20.000 o > 3 s → Fase 2. T1 mide, T2 cronometra y documenta.

### 4.4 RNF_02: conciliacion por causas que no absorbe un pedido perdido

Ninguna causa es residuo. Cada pedido con asientos "por cobrar" se clasifica **independientemente de
`rows`/`nettedRows`**:

| Razon | Como se decide |
|---|---|
| `listed` | esta en `rows` |
| `outside_universe` | no esta en `input.orders` |
| `received` | esta en `buildCodReceivedSet(settlements)` |
| `covered_by_netting` | universo, no recibido, sin corte `pending`, y algun corte que lo contiene cumple `isDriverSettlementCashSettled` (calculado desde los cortes, no desde `nettedRows`) |
| `unreadable_order` | esta en `unreadableOrderIds` |
| `attributed_elsewhere` | (solo por corte) es fila atribuida a otro corte |
| **sin razon** | universo, no recibido, legible, ni listado ni compensado → `unexplainedCop`, `unexplainedOrderIds` |

**Fuera de corte:** `posicionFuera − listaFuera = Σ_U(cod − pago) − T − N + K` (U = no listados por razon;
T = filas `order_total`; N = netos negativos; K = `max(0, P − C)`).

**Por corte** `s`, con `R_s = max(0, expectedCop_s − settlementCashReceivedCop(s))` recalculado con
`computeDriverCashSummary` sobre los mismos asientos, y `G_s = s.cashPendingCop ?? 0`:

`G_s − A_s = (G_s − R_s) + Σ_{O_s no atribuidos}(cod − pago) − T_s − N_s + K1_s + K2_s − (Rec_s − P_s) − Q_s`

- `G_s − R_s` es la **unica causa propia del corte**: `settlement_cash_pending_stale` si el campo existe y
  difiere; `settlement_cash_pending_missing` si el campo falta.
- `Σ_{O_s no atribuidos}` por razon (incluida `covered_by_netting`); "sin razon" → `unexplainedCop`.
- `T_s`, `N_s`, `K1_s` (tope a 0 del esperado), `K2_s` (excedente), `Rec_s − P_s` (recibido no imputado a
  filas atribuidas), `Q_s` (imputacion por encima del esperado actual).

```ts
export type ReconciliationCause =
  | "outside_orders_outside_universe" | "outside_unreadable_orders"
  | "outside_order_total_without_cod" | "outside_negative_net" | "outside_aggregate_clamp"
  | "settlement_cash_pending_stale" | "settlement_cash_pending_missing"
  | "settlement_orders_received" | "settlement_orders_covered_by_netting"
  | "settlement_orders_outside_universe" | "settlement_unreadable_orders"
  | "settlement_orders_attributed_elsewhere"
  | "settlement_order_total_without_cod" | "settlement_negative_net"
  | "settlement_expected_clamp" | "settlement_excess_received"
  | "settlement_cash_received" | "settlement_allocation_over_expected";

export type PositionReconciliation = {
  driverReceivableCop: number; listOutstandingCop: number; deltaCop: number;
  causes: Array<{ cause: ReconciliationCause; amountCop: number; orderIds: string[]; settlementId?: string }>;
  staleSettlementsCop: number;
  missingPendingSettlementsCop: number;
  unexplainedCop: number;         // deltaCop − Σ causes (todas, incluidas stale y missing)
  unexplainedOrderIds: string[];
};
```

**Regla de paso (DoD 4):** `unexplainedCop === 0` es la **unica condicion de paso**.
`staleSettlementsCop` y `missingPendingSettlementsCop` forman parte de la descomposicion, pero **se
reportan** por corte como hallazgo; distintos de 0 **no fallan**. `unexplainedCop` mide si la lista pierde
pedidos; "stale/missing" miden si los cortes guardados estan al dia, que es otro problema.

**Pruebas (T9):** sin causas `deltaCop === 0`; cada causa sola y todas juntas → `unexplainedCop === 0`;
propiedad con semilla fija; fila quitada de `rows` (fuera y en corte) → `unexplainedCop !== 0` con su id;
fila quitada de `nettedRows` no cambia nada; corte con campo viejo → `stale`; sin campo → `missing`.

**T18** compara contra `getPlatformPosition` desplegado; DoD 4 = igualdad de `driverReceivableCop` +
`unexplainedCop === 0`; lista aparte `stale` y `missing` por corte.

### 4.5 Pedidos sin efectivo esperado

`collectedCop <= driverPayCop`: aparece con `expectedCashCop = 0`, no avisa; P7 fuera de alcance.

### 4.6 Aviso

Candidata = fila de `rows` con `isOverdue && outstandingCop >= notifyMinCop` no avisada. Mensaje por lider,
2.000 caracteres, "cifras incompletas" si `isIncomplete`. Constructores planos.

## 5. Estrategia de testing

### 5.1 Mapa requisito → prueba → tarea

| Req. | Prueba | Tarea |
|---|---|---|
| RF_01 | equivalencia con `isSellerEntryEligible`; guarda anti-copia con lista fija y mutacion | T4, T6, T17 |
| RF_02 | campos, ubicaciones, `row.settlements`, rotulos | T7, T14 |
| RF_03 | dia 7/8; vencido nunca `covered_by_netting`; tarjeta "mas efectivo vencido" | T7, T8, T14, T15 |
| RF_04 | Zod; admin + auditoria; recarga | T5, T13, T16 |
| RF_05 | umbral, una vez, agrupacion, canal, marca tras `ok`; `nettedRows` nunca candidatos | T10, T11, T13 |
| RF_06 | filtro de lider; `token.driverId`; sin claim → denegado | T8, T12 |
| RF_07 | pedido de junio; sin fecha ni `limit` | T6, T12 |
| RF_08 | clave de proveedor de la posicion; linea de Por pagar | T3, T8, T16 |
| RF_09 | `isDriverSettlementCashSettled`; precedencia; `nettedRows` fuera de totales, vencidos y aviso; rotulo; produccion | T4, T7, T8, T10, T14, T15, T17, T18 |
| RNF_01 | guarda limitada a archivos nuevos; conteo de `buildCodReceivedSet` en `operations-app.tsx` congelado (medido al escribir la guarda) | T12, T15, T16, T17 |
| RNF_02 | extraccion; subconjunto = ledger; causas sin residuo; `compare` | T3, T9, T18 |
| Caso limite "sin lider" | fila con `driverId: null` → grupo `leaderId: null` (T8); "Sin lider" con "no hay a quien cobrarle" (T14) | T8, T14 |

### 5.2 Archivos compartidos

Un bloque `describe("T<n> · ...")` por tarea en `spec-026-guards.test.ts` (T1, T6, T12, T13, T15, T16,
T17), `cash-outstanding.test.ts` (T6-T9) y `cash-outstanding-loads.test.ts` (T14, T16).
`operations-app.tsx`: cada tarea en su punto de montaje. `cash-outstanding-schemas.ts`: T5 lo crea; T12
anade `resolveCashOutstandingScope`. `cash-outstanding-loads.ts`: T14 crea la cache; T16 anade
`reloadAfterCashAlertSave`.

### 5.3 `scripts/verify-026.js`

- `baseline` (T1): conteos; fuentes de fecha; neto <= 0; asientos sin `settlementId`; cortes sin
  `cashPendingCop`; cortes con pendiente viejo; **cortes saldados por compensacion y sus pedidos**, medidos
  con **la misma metrica que la spec** (cortes, pedidos e importe como el 2026-10-02) y con la **unidad
  nombrada** del importe (recaudo, efectivo esperado o pendiente), mas el recaudo de esos pedidos; cortes
  con excedente; coste de los dos modos; antiguedad. Guarda los ids en `EV/t1-linea-base-ids.json`:
  `{ over30Days, coveredByNetting, rows }`.
- `query-check` (T2): consultas con `limit(1)`, cargas completas cronometradas.
- `compare` (T18): cargador `full` + `computePlatformPosition`; exige `unexplainedCop === 0` e igualdad;
  lista `stale` y `missing`; compara contra `EV/t1-linea-base-ids.json`: por cada id que cambio de grupo
  imprime el motivo comprobado (recibido ahora, compensado, corregido de estado, ilegible, nuevo pedido). Un
  id sin motivo hace fallar.
- `compare --deployed` (T18, `/sdd-verify`): callables desplegados con sesion real de admin.

### 5.4 Compuertas (T1, T2)

| Medicion | Si sale mal | Bloquea |
|---|---|---|
| Filas >30 dias por `updatedAt` | se reporta | T7 |
| Compensados distintos de 29 cortes / 36 pedidos / $1.151.997, **comparados en la misma metrica** (la unidad que T1 nombre) | se reporta la diferencia y su causa antes de seguir | T7 |
| Con conciliacion > 30.000 docs | decision del responsable | T12 |
| Resumen > 20.000 docs o > 3 s | Fase 2 | T12 |
| Alguna consulta pide indice | se **anade** (T2) y se despliega primero | T12 |

## 6. Dependencias nuevas

Ninguna. Un secreto (`OPS_NOTICE_WEBHOOK_URL`).

## 7. Indices

Previstos: ninguno. `query-check` lo confirma; si pide uno, se anade a `firestore.indexes.json` tras
comparar con prod.

## 8. Orden de despliegue

1. Indices (si T2 lo exige). 2. Secreto creado por el responsable (URL o `none`). 3. Functions
(`getCashOutstanding`, `updateCashAlertSettings`, `notifyOverdueCash`, `getPlatformPosition`) con
`ALLOW_FUNCTIONS_DEPLOY=1` tras build y `functions:list`; humano. 4. Aviso de prueba por `gcloud scheduler
jobs run`. 5. Hosting (`lint`, `static{` = 0). 6. `compare --deployed`.

## 9. Diseno

Las once pantallas estan redibujadas y observadas tras la enmienda (incluidos ajustes de cifras en
`HU_01.ilegibles` y `HU_02.al-dia`). El README fija: decision 2 ("el lider con mas efectivo vencido"), 3
(solo `unexplainedCop` decide; cortes viejos o sin pendiente para revisar), 4 ("Sin lider" con "no hay a
quien cobrarle"), 5 y 12 ("Cubierto por compensacion"), 11 (dos cargas). Los E2E de HU_01 y HU_02 los hace
`/sdd-verify`.

## 10. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Presentar como perdido dinero que el corte ya saldo | `covered_by_netting` aparte (2.9); spec 027 para la correccion de fondo |
| `covered_by_netting` esconde un faltante real | exige corte cerrado, pendiente 0 y recibido >= esperado; T18 compara contra la linea base con motivo por id |
| Comparar la cifra de compensados en otra unidad | T1 nombra la unidad y la compuerta compara en la misma metrica (5.4) |
| Corte sin `cashPendingCop` | opcional = 0 como la posicion; causa `missing`; T1 los cuenta |
| Una causa absorbe un pedido perdido | ninguna es residuo; razones independientes de las filas; prueba de fila quitada |
| "stale/missing" leidos como explicados | regla de paso explicita (4.4) |
| Coste de los modos | 4.3 |
| Cifras de dos momentos | `prime` |
| Cache no probable por `vi.mock` | factoria con llamada inyectada (2.1) |
| Guardas rojas desde el dia uno o verdes sin mirar | 5.1, 2.2 |
| Aviso repetido | "al menos una vez" aceptado (spec, seccion 9) |
| `undefined` en escrituras | 2.8 |

## 11. Preguntas abiertas

Ninguna bloqueante. Condicional: conciliacion diaria si se supera el umbral (4.3). La 027 (borrador) tiene
las suyas.

## 12. Revisiones tras `/sdd-analyze` (2026-10-02)

**1a:** mismos documentos que la posicion; compuertas tempranas; `codPartialReceivedCop`; filtro de estado
en el nucleo; nombres; secreto; tres ubicaciones; bloques por tarea; E2E en `/sdd-verify`;
`stripUndefined`. **2a:** dos modos; `row.settlements`; `token.driverId`; filtro en cliente;
`supplier-withheld.ts`. **3a:** RNF_01 limitada; conciliacion sin residuo; cuadre sin filtro;
`unreadableEntryIds`; indices en T2; recarga al guardar; lista fija anti-copia; evidencia unificada.
**4a:** compensacion (RF_09, decidido por el responsable) y spec 027 en borrador; cortes sin
`cashPendingCop`; regla de paso; ids de la linea base; cache con llamada inyectada; "al menos una vez";
lider de la tarjeta por importe.

**5a pasada (coherente; retoques de texto)**

| Retoque | Donde |
|---|---|
| Caso limite "pedido sin lider" verificado | 4.1, 4.2, 5.1; T8 y T14 |
| Redibujo hecho y observado | cabecera y 9; sin dependencia de T15/T17 |
| Unidad de $1.151.997 | 1, 5.3, 5.4; T1; spec "(unidad por confirmar en T1)" |
| Seccion 9 de la spec tras la 8; texto visible "una vez" | spec; 2.4 |
