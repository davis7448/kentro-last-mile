# Plan tecnico — Spec 026: que nadie descubra a los tres meses que el efectivo de una entrega nunca llego

- **Spec:** `specs/026_efectivo_que_no_llega_a_un_corte.md` (**aprobada el 2026-10-02**; las preguntas de la
  seccion 11 estan resueltas en la seccion 9 de la spec).
- **Fecha:** 2026-10-02
- **Diseno:** `specs/design/026_efectivo_que_no_llega_a_un_corte/` (11 pantallas + README, completo segun
  `design-check`, sin observar). La interfaz se construye sobre esas pantallas; este plan fija el contrato de
  datos que consumen.

### Resolucion de las preguntas de la seccion 11 (2026-10-02)

| Pregunta | Resolucion |
|---|---|
| P1 | RNF_02 = coincide salvo diferencias explicadas por causa, residuo $0. El admin ve el recaudo bruto |
| P2 | webhook generico por secreto `OPS_NOTICE_WEBHOOK_URL`; sin URL, `notifyOverdueCash` registra la corrida como `skipped: no_channel` y no marca avisos |
| P3 | `notifyMinCop` por defecto **20.000** |
| P4 | plazo global |
| P5 | diaria 08:00 `America/Bogota`; la primera corrida avisa todo el atraso en un solo mensaje |
| P6 | la vista del lider **complementa** "Pendiente por entregar" (ver README del diseno) |
| P7 | fuera de alcance; los pedidos de neto <= 0 se ven con $0 y no avisan |
| P8 | se incluyen `liquidated` |

## 1. Lo que hay hoy (leido en el codigo, no supuesto)

| Donde | Que hace | Consecuencia para la 026 |
|---|---|---|
| `functions/src/seller-ledger.ts` `buildCodReceivedSet` | LA regla de "efectivo recibido" (spec 018, RF_04): si el corte de domiciliario trae `cashAllocations`, cuentan las `covered`; si no, el corte `paid`/`reconciled` cubre todos sus `orderIds` | RF_01 se cumple **importandola**. Es pura (sin `firebase-admin`), la raiz ya la importa |
| `seller-ledger.ts` `isSellerEntryEligible` | la compuerta de tienda/proveedor: pedido COD en `delivered` **o `liquidated`** exige estar en `codReceived` | el universo de la 026 es `paymentMethod == "cod"` y `status in ["delivered","liquidated"]`, no solo `delivered` como la medicion de la spec |
| `functions/src/settlement-math.ts` `computeDriverCashSummary` | efectivo esperado por pedido = `max(0, cod − pago domiciliario)`; **solo** los pedidos con esperado > 0 reciben `cashAllocation` | un pedido de recaudo menor que el pago (el caso de $1, KNT-005242) **nunca** tiene asignacion: segun la regla, su efectivo nunca "llega". Ver 4.5 |
| `functions/src/platform-position.ts` `computePlatformPosition` | `driverReceivableCop = Σ cashPendingCop (cortes de domiciliario) + max(0, codFueraDeCortes − pagoDomiciliarioFueraDeCortes)`; "fuera" = `orderId` ausente de todo `settlement.orderIds` de domiciliario | **no** es la suma por pedido de lo no recibido: netea en agregado el pago de visitas fallidas y de pedidos de $1 (ver 4.4 y pregunta P1) |
| `src/lib/finance.ts:863` `calculatePlatformPosition` | espejo de cliente, atado por `src/lib/platform-position.test.ts` | la tarjeta del admin hoy la calcula en el navegador con el ledger entero |
| `src/lib/finance.ts:735` `calculateDriverFinancialSummary` | "Pendiente por entregar" del lider = cortes incompletos (`cashPendingCop`) + entregados COD fuera de corte | HU_02 se solapa con esta cifra: hay que decidir si convive o la sustituye (pregunta P6) |
| `functions/src/orders.ts:1198` `closeOrder` | escribe `closedAt` en todo cierre terminal y una evidencia `type: "delivery"` con `createdAt` | `closedAt` es el eje de fecha del dinero, pero **solo es fiable desde la spec 001**; los pedidos de junio-julio pueden no tenerlo |
| `functions/src/order-corrections-plan.ts:350` | al corregir a entregado conserva `order.closedAt ?? now` | una correccion fallido→entregado hereda la fecha del fallo; aceptable (es la fecha de la visita) |
| `functions/src/uchat-pull.ts`, `sync-issues-cleanup.ts` | patron de funcion programada (`onSchedule`) | RF_05 usa el mismo patron |
| Canales salientes | **no hay ninguno.** No hay correo (`nodemailer` no esta), ni mensajeria a una persona. La spec 010 pide lo mismo y sigue en borrador sin implementar. UChat/ChatBy usa tokens **de cada tienda**, no de la plataforma | RF_05 necesita un canal nuevo (seccion 6, pregunta P2) |
| `firestore.rules` `settings/{id}` | lectura para cualquier sesion, escritura del admin | el plazo se guarda en un documento propio, no en `settings/global` (4.6) |
| `community-floor-trigger.ts` | `onDocumentUpdated("settings/global")` | escribir el plazo en `settings/global` dispararia ese trigger en cada cambio: por eso va aparte |

## 2. Decisiones de diseno

### 2.1 Calcular en servidor sobre una consulta acotada por estado, no por fecha (RF_07, RNF_01)

Un callable `getCashOutstanding` recorre en servidor todas las contraentregas cerradas como entregadas,
sin ventana de fecha, y les resta las cubiertas con `buildCodReceivedSet`. El navegador recibe solo el
resultado (hoy ~153 filas). Constitucion 8 y 11.

**Alternativas evaluadas:**

| Opcion | Lecturas por llamada | Riesgo | Decision |
|---|---|---|---|
| A. Recorrer en cada llamada `orders` COD entregados + cortes de domiciliario | N entregados COD (medir en T1; orden de 2–4 mil hoy) + cortes de domiciliario (decenas–cientos) + asientos de las filas | ninguno de coherencia: misma regla, mismos datos, en el momento | **elegida para la Fase 1** |
| B. Cola materializada (`cashOutstanding/{orderId}`) mantenida por triggers sobre `orders` y `settlements` | ~filas pendientes | la cola puede divergir en silencio (evento perdido, correccion que recalcula un corte, despliegue a medias). Es exactamente el tipo de fallo que esta spec existe para cazar | descartada en Fase 1; queda como Fase 2 con umbral (abajo) |
| C. Campo denormalizado en el pedido (`cashReceived: boolean`) | ~filas | escribe en `orders` desde cortes: toca los listeners de todos los roles, entra en el terreno de la spec 017 (que conserva una importacion) y del principio 5 | descartada |

- Las lecturas se proyectan con `.select(...)` (mismas lecturas facturadas, mucho menos transferencia).
- **Umbral para pasar a B:** si T1 mide mas de 20.000 contraentregas entregadas, o si el callable pasa de
  3 s en caliente, se abre un plan de Fase 2. Con el volumen actual (~3.700 pedidos/mes en total, la mitad
  COD) el umbral queda a varios meses; T1 lo anota en `docs/rendimiento.md`.
- **Frecuencia:** el callable no se suscribe; se llama al abrir la pantalla y bajo demanda (cadencia
  final en `/sdd-design`). La alerta programada (2.4) lo recorre una vez al dia.

### 2.2 Un solo modulo puro con toda la decision (RF_01–RF_03, RF_06, RF_08)

`functions/src/cash-outstanding.ts` es **puro** (sin `firebase-admin`), como `seller-balance.ts` y
`computePlatformPosition`. Recibe documentos ya validados y devuelve el informe completo. La regla de
recibido **no** se reescribe: el modulo importa `buildCodReceivedSet` de `./seller-ledger` y una guarda
de fuente (T3) se pone roja si aparece `cashAllocations` o `covered` en el archivo.

`functions/src/cash-outstanding-api.ts` contiene solo lecturas: el cargador, el callable y el
programador. Zod valida cada documento en la frontera; un documento que no pasa no se descarta en
silencio: va a `unreadableOrderIds` / `unreadableSettlementIds` y el informe lo dice (mismo criterio que
RF_22 de la 018).

### 2.3 Fecha de entrega y antiguedad

`deliveredAt` se resuelve en este orden y la fila declara de donde salio (`deliveredAtSource`):

1. `order.closedAt` — eje oficial del dinero (spec 001, `closeOrder`).
2. `createdAt` de la **ultima** evidencia con `type === "delivery"` — existe en todo cierre por la app,
   tambien antes de la 001.
3. `createdAt` del asiento `cod_revenue` del pedido — lo escribe el cierre en el mismo instante.
4. `order.updatedAt` — ultimo recurso, marcado como `"updatedAt"` para que se sepa que es aproximada.

`ageDays = floor((now − deliveredAt) / 86_400_000)`. Bogota no tiene horario de verano, asi que el
calculo en milisegundos no se desplaza. **Vencido** (RF_03) = `ageDays > overdueDays` (con plazo 7, el
dia 8 ya vence; coincide con la tabla de la spec, "7 dias o menos" = al dia).

T1 cuenta en produccion cuantas filas caen en cada fuente. Si alguna fila de mas de 30 dias sale de
`updatedAt`, se reporta antes de T4.

### 2.4 Aviso fuera de la app (RF_05)

Funcion programada `notifyOverdueCash` (diaria, `America/Bogota`, hora en P5):

1. Calcula el informe con el mismo cargador que el callable.
2. Candidatas = filas vencidas con `outstandingCop >= notifyMinCop` (caso de $1, pregunta P3) y sin
   documento en `cashOverdueNotices/{orderId}`.
3. Agrupa por lider (caso limite "muchos pedidos del mismo lider") y compone **un solo mensaje por
   corrida**: una seccion por lider con total, numero de pedidos y el mas antiguo; "Sin lider" como grupo
   propio (caso de la spec 017).
4. Envia por el canal (2.5). **Solo si el envio responde 2xx**, escribe en lote
   `cashOverdueNotices/{orderId}` = `{ orderId, leaderId, outstandingCop, ageDays, notifiedAt, runId }`.
   Si falla, no escribe nada, registra el error con `console.error` (estructurado) y la siguiente corrida
   lo reintenta. Nunca `catch` vacio.
5. Escribe `cashOverdueRuns/{runId}` con el resultado (enviados, omitidos por umbral, error) para poder
   auditar que el aviso corre.

"Una sola vez por pedido" es al menos una vez: si el envio sale y la escritura del lote cae, el pedido se
repite al dia siguiente. Se acepta y se documenta; lo contrario (escribir antes de enviar) puede perder
un aviso, que es peor.

**Primera corrida:** avisaria de todo el atraso actual (los 24 de mas de 30 dias y los de 8–30 dias) en un
solo mensaje agrupado. Es deseable, pero se confirma en P5.

### 2.5 Canal: un webhook HTTP con `fetch` nativo, sin dependencias

Node 20 trae `fetch`. El modulo `functions/src/ops-notify.ts` expone
`sendOpsNotice(text: string): Promise<OpsNoticeResult>` y lee la URL de un secreto de Firebase
(`defineSecret("OPS_NOTICE_WEBHOOK_URL")`), igual que `shopify.ts` lee los suyos. Sirve para un webhook
entrante de Discord (el responsable ya opera con Discord), de Slack o de Google Chat: los tres aceptan un
POST JSON. Telegram requeriria token + chat id; correo requeriria SMTP y una dependencia (descartado por
principio 2).

- La composicion del texto es pura (`cash-overdue-notice.ts`) y se prueba; el envio es delgado.
- La spec 010 puede reutilizar `ops-notify.ts` cuando se implemente. No se generaliza mas alla de eso
  (YAGNI).
- **Bloqueante:** que servicio y que destino (pregunta P2). Sin esa respuesta T9–T10 no empiezan; el
  resto del plan si.

### 2.6 El plazo y el umbral son configuracion del admin (RF_04)

Documento `settings/cashAlerts`, **no** `settings/global` (evita disparar `onSettingsFloorRaise`).
Escritura por callable `updateCashAlertSettings` (Zod + auditoria en `auditLogs`), no por escritura directa:
es configuracion que decide avisos de dinero y queda rastro de quien la cambio. Lectura en servidor con
Zod y valores por defecto; un documento invalido usa los defectos y lo registra.

### 2.7 Alcance por rol (RF_06)

- `admin`: todo; filtro opcional `driverId`.
- `driver` (lider logistico): el `driverId` se **impone desde el claim**, venga lo que venga en la
  peticion (patron de `getOrderStats`). La respuesta del lider **omite** el desglose por proveedor
  (`supplierWithheld`, `bySupplier`): hoy el lider no puede leer la wallet de las tiendas y no se le abre
  por esta via.
- Cualquier otro rol: `permission-denied`.

La consulta del lider anade `where("driverId","==", claim)`; sigue sin ventana de fecha.

## 3. Arbol de modulos

| Archivo | Cambio | Responsabilidad |
|---|---|---|
| `functions/src/cash-outstanding.ts` | nuevo, **puro** | `buildCashOutstandingReport`: filas, antiguedad, vencidos, agrupaciones, desglose por proveedor, reconciliacion con la posicion. Importa `buildCodReceivedSet` |
| `functions/src/cash-outstanding-schemas.ts` | nuevo, puro | esquemas Zod de entrada del callable, de `settings/cashAlerts` y de los documentos leidos (pedido, corte, asiento, nombres) |
| `functions/src/driver-receivable.ts` | nuevo, puro | `computeDriverReceivable(settlements, codEntries, driverEarnings)`: la formula de `driverReceivableCop` extraida de `computePlatformPosition` para que la 026 la **use** y no la copie (4.4) |
| `functions/src/platform-position.ts` | toca | `computePlatformPosition` delega las tres cifras de "por cobrar al domiciliario" en `computeDriverReceivable`. Sin cambio de resultado (lo vigila `platform-position.test.ts`) |
| `functions/src/cash-overdue-notice.ts` | nuevo, puro | `selectNoticeCandidates`, `composeOverdueNotice` (texto en espanol, agrupado por lider) |
| `functions/src/ops-notify.ts` | nuevo | `sendOpsNotice` por `fetch` al webhook del secreto; devuelve `{ ok, status, error? }`, no lanza silencioso |
| `functions/src/cash-outstanding-api.ts` | nuevo | `loadCashOutstandingInput(db, scope, now)`, callables `getCashOutstanding` y `updateCashAlertSettings`, programador `notifyOverdueCash` |
| `functions/src/index.ts` | toca | exporta las tres funciones nuevas |
| `src/lib/firebase/auth.ts` | toca | `getFirebaseCashOutstanding()` y `updateFirebaseCashAlertSettings()` |
| `src/lib/types.ts` | toca | reexporta (por `import type` desde `functions/src`) `CashOutstandingReport` y `CashAlertSettings` para la UI |
| `src/components/...` | **pendiente de `/sdd-design`** | lista del admin, total vencido en la pantalla principal, vista del lider, ajuste del plazo |
| `src/lib/cash-outstanding.test.ts` | nuevo | RF_01–RF_03, RF_06–RF_08, casos limite, RNF_02 |
| `src/lib/driver-receivable.test.ts` | nuevo | la extraccion no cambia ninguna cifra; atadura con el cliente |
| `src/lib/cash-overdue-notice.test.ts` | nuevo | RF_05: umbral, una vez por pedido, agrupacion, texto |
| `src/lib/spec-026-guards.test.ts` | nuevo | guardas de fuente (2.2, 2.7, sin ventana de fecha, orden enviar→marcar, sin `catch` vacio) |
| `scripts/verify-026.js` | nuevo, solo lectura | `baseline`, `query-check`, `compare` contra produccion via `functions/lib` (ver 5.3) |
| `docs/rendimiento.md` | toca | lecturas por llamada medidas y umbral de la Fase 2 |

Sin cambios en `firestore.rules`: `cashOverdueNotices` y `cashOverdueRuns` solo se tocan con Admin SDK y
la regla por defecto ya niega al cliente; `settings/cashAlerts` cae en la regla existente de `settings`.

## 4. Modelo de datos y algoritmos

### 4.1 Tipos (en `cash-outstanding.ts`; nada de `any`)

```ts
export type CashSettlementLocation = "outside_settlement" | "in_settlement";
export type DeliveredAtSource = "closedAt" | "evidence" | "cod_entry" | "updatedAt";

export type CashOutstandingOrder = {
  id: string;
  trackingCode?: string;
  shopifyOrderId?: string;
  sellerId: string;
  driverId: string | null;          // lider logistico; null = sin lider (spec 017)
  messengerId: string | null;
  status: "delivered" | "liquidated";
  paymentMethod: "cod";
  totalCop: number;
  closedAt?: string;
  updatedAt?: string;
  evidence: Array<{ type: string; createdAt: string }>;
};

export type CashSettlement = {
  id: string;
  kind: "driver";
  ownerId: string;
  status: "pending" | "paid" | "reconciled";
  orderIds: string[];
  cashPendingCop?: number;
  cashAllocations?: Array<{ orderId: string; expectedCop: number; receivedCop: number; covered: boolean }>;
  createdAt: string;
};

export type CashWalletEntry = {
  id: string;
  ownerType: "seller" | "driver";
  orderId: string;
  type: "cod_revenue" | "cod_remittance" | "driver_earning" | "product_cost";
  amountCop: number;
  createdAt: string;
  supplierId?: string;
  supplierName?: string;
  supplierSettlementId?: string;
};

export type CashAlertSettings = { overdueDays: number; notifyMinCop: number };

export type CashOutstandingInput = {
  orders: CashOutstandingOrder[];
  settlements: CashSettlement[];          // TODOS los cortes de domiciliario (la regla los necesita todos)
  entriesByOrderId: Map<string, CashWalletEntry[]>; // solo de los pedidos que quedan como no recibidos
  names: { sellers: Map<string, string>; leaders: Map<string, string>; messengers: Map<string, string> };
  settings: CashAlertSettings;
  scope: { kind: "admin"; driverId?: string } | { kind: "leader"; driverId: string };
  now: string;
  unreadableOrderIds: string[];
  unreadableSettlementIds: string[];
};

export type SupplierWithheld = { supplierId: string; supplierName: string; amountCop: number };

export type CashOutstandingRow = {
  orderId: string;
  trackingCode: string;
  sellerId: string; sellerName: string;
  leaderId: string | null; leaderName: string | null;
  messengerId: string | null; messengerName: string | null;
  deliveredAt: string; deliveredAtSource: DeliveredAtSource;
  ageDays: number;
  isOverdue: boolean;
  collectedCop: number;                     // recaudo: Σ cod_revenue + cod_remittance (neteado)
  collectedSource: "wallet" | "order_total"; // order_total = el pedido no tiene asientos COD
  driverPayCop: number;
  expectedCashCop: number;                  // max(0, collectedCop − driverPayCop)
  receivedCop: number;                      // parcial imputado en un corte; 0 fuera de corte
  outstandingCop: number;                   // expectedCashCop − receivedCop
  location: CashSettlementLocation;
  settlementIds: string[];                  // cortes de domiciliario que lo contienen sin cubrirlo
  supplierWithheld: SupplierWithheld[];     // RF_08; [] en la respuesta del lider
};

export type CashOutstandingGroup = {
  leaderId: string | null; leaderName: string | null;
  orderCount: number; outstandingCop: number;
  overdueCount: number; overdueCop: number;
  oldestDeliveredAt: string;
};

export type CashOutstandingReport = {
  generatedAt: string;
  settings: CashAlertSettings;
  rows: CashOutstandingRow[];               // orden: deliveredAt ascendente, empate por orderId
  byLeader: CashOutstandingGroup[];         // orden: overdueCop desc
  bySupplier: Array<SupplierWithheld & { overdueAmountCop: number }>; // [] para el lider
  totals: {
    orderCount: number;
    collectedCop: number;                   // lo que mide la tabla de la spec (DoD 3)
    outstandingCop: number;                 // Σ filas
    outsideSettlementCop: number;
    inSettlementCop: number;
    overdueCount: number; overdueCop: number;
  };
  reconciliation: PositionReconciliation | null; // solo admin sin filtro (4.4)
  unreadableOrderIds: string[];
  unreadableSettlementIds: string[];
};
```

Entrada del callable (Zod): `z.object({ driverId: z.string().trim().min(1).optional() }).strict()`.
Ajustes (Zod): `z.object({ overdueDays: z.number().int().min(1).max(120).default(7), notifyMinCop:
z.number().int().min(0).default(<P3>) })`.

### 4.2 `buildCashOutstandingReport(input)`

1. `received = buildCodReceivedSet(input.settlements)` — **la** regla (RF_01).
2. `candidates = input.orders` filtrados por alcance y por `!received.has(order.id)`. No hay filtro de
   fecha en ningun punto (RF_07).
3. Para cada candidato, con `entries = entriesByOrderId.get(id) ?? []`:
   - `collectedCop` = Σ `cod_revenue` + `cod_remittance` de tienda; si no hay ninguno, `totalCop` y
     `collectedSource = "order_total"` (se ve, no se esconde).
   - `driverPayCop` = Σ `driver_earning`.
   - `expectedCashCop = max(0, collectedCop − driverPayCop)` — misma formula por pedido que
     `computeDriverCashSummary`.
   - `settlementIds` = cortes de domiciliario cuyo `orderIds` lo contiene. `location` =
     `in_settlement` si hay alguno, si no `outside_settlement`.
   - `receivedCop` = Σ `receivedCop` de sus `cashAllocations` (caso limite "cubierto en parte": sigue en
     la lista con lo que falta). Sin asignaciones, 0.
   - `outstandingCop = max(0, expectedCashCop − receivedCop)`.
   - `deliveredAt` segun 2.3; `ageDays`; `isOverdue = ageDays > settings.overdueDays`.
   - `supplierWithheld` = por proveedor, `−Σ product_cost` de tienda con `supplierSettlementId` vacio
     (RF_08). En alcance de lider, `[]`.
4. Agrupa por lider (`null` = "sin lider") y por proveedor; suma totales.
5. Si el alcance es admin sin filtro, calcula `reconciliation` (4.4).

Un pedido corregido de entregado a fallido sale solo: deja de cumplir `status in [delivered,
liquidated]` en la consulta (caso limite 1).

### 4.3 Cargador `loadCashOutstandingInput(db, scope, now)`

1. `orders` con `paymentMethod == "cod"` y `status in ["delivered","liquidated"]` (+ `driverId == x`
   si hay alcance), `.select(...)` de los campos de 4.1. **Sin rango de fecha.**
2. `settlements` con `kind == "driver"` (todos).
3. Calcula `received` y descarta los recibidos **antes** de leer asientos.
4. `walletEntries` con `where("orderId","in", lote de 30)` sobre los no recibidos (~153 → 6 consultas,
   ~800 lecturas). Solo se conservan los tipos de 4.1.
5. Nombres: `sellers`, `drivers`, `messengers` por `getAll` de los ids que aparecen.
6. `settings/cashAlerts` con Zod y defectos.
7. Para la reconciliacion (solo admin sin filtro): asientos `driver_earning` con `settlementId == ""`
   (convencion de `withOpenSettlementFlags`, `wallet-entries.ts:271`). T1 comprueba que el campo esta
   presente en todos los asientos de domiciliario; si falta en alguno, la consulta lo perderia y T1 lo
   reporta antes de seguir.

Lecturas estimadas por llamada del admin: N(COD entregados) + cortes + ~800 + nombres. T1 lo mide.

### 4.4 RNF_02: por que la suma por pedido NO es `driverReceivableCop`, y como se ata

`driverReceivableCop` de la posicion **no** es "Σ de lo que falta por pedido". Diferencias de definicion,
todas leidas en `platform-position.ts`:

| # | La posicion | La lista por pedido | Efecto |
|---|---|---|---|
| a | fuera de corte: `max(0, Σcod − Σpago)` **agregado**, y `Σpago` incluye el pago de **visitas fallidas** y entregas prepago fuera de corte | solo contraentregas entregadas, `max(0, ...)` por pedido | la posicion es **menor** por el pago de fallidos sin cortar |
| b | un pedido de $1 resta su pago (−$5.999) del total | ese pedido aporta 0 | la posicion es menor |
| c | en corte: `Σ cashPendingCop` del corte guardado | Σ (esperado − recibido) de las asignaciones no cubiertas | iguales si el corte cuadra; distintas en cortes viejos sin `cashPendingCop` o con cifras guardadas antes de una correccion |
| d | COD de cualquier pedido con asientos fuera de corte | solo `delivered`/`liquidated` | distintas si hay asientos COD de pedidos en otro estado sin reversa |

O sea, **literalmente** RNF_02 no se cumple con datos reales: (a) y (b) las mueve el propio diseno de la
posicion. El plan propone (P1):

- La formula de "por cobrar al domiciliario" sale de `computePlatformPosition` a
  `computeDriverReceivable` (puro, `driver-receivable.ts`). La posicion la llama; la 026 tambien. Una
  sola formula, ninguna copia (principios 3 y 9). `platform-position.test.ts` sigue atando el cliente.
- El informe devuelve `reconciliation`:

```ts
export type PositionReconciliation = {
  driverReceivableCop: number;          // computeDriverReceivable sobre los mismos documentos
  listOutstandingCop: number;           // totals.outstandingCop
  deltaCop: number;                     // driverReceivableCop − listOutstandingCop
  causes: Array<{
    cause: "driver_pay_outside_not_listed" | "negative_net_order" | "settlement_cash_pending_mismatch" | "cod_entries_outside_list";
    amountCop: number;
    orderIds: string[];                 // o ids de corte para la causa c
  }>;
  unexplainedCop: number;               // deltaCop − Σ causes; DEBE ser 0
};
```

- La prueba de RNF_02 fija **dos** cosas: (1) sin fallidos ni pedidos de neto negativo ni cortes
  descuadrados, `deltaCop === 0`; (2) con cada causa sembrada, `unexplainedCop === 0` y la causa nombra
  los pedidos. DoD 4 en produccion se da por cumplido con `unexplainedCop === 0`.
- Coste de (a) para la reconciliacion: asientos `driver_earning` abiertos (4.3 paso 7) y los `orderIds`
  de cortes ya cargados; no se lee el ledger entero.

### 4.5 Pedidos sin efectivo esperado (hallazgo)

Si `collectedCop <= driverPayCop`, `computeDriverCashSummary` no le crea asignacion, asi que
`buildCodReceivedSet` **nunca** lo da por recibido mientras su corte tenga asignaciones. Consecuencias:
aparece siempre en la lista (correcto segun RF_01, aporta $0) y su asiento de tienda queda bloqueado para
siempre por la compuerta de la 018. Esta spec **no** cambia la regla (fuera de alcance: "como se cubren
los cortes"); la fila sale con `expectedCashCop = 0`, no entra al aviso (umbral) y T1 cuenta cuantos hay
para que el responsable decida si abre una spec aparte (pregunta P7).

### 4.6 `selectNoticeCandidates(report, alreadyNotified, settings)` y `composeOverdueNotice`

- Candidata = `isOverdue && outstandingCop >= notifyMinCop && !alreadyNotified.has(orderId)`.
- Grupos por lider ordenados por importe; dentro, pedidos por antiguedad. Un mensaje por corrida.
- Texto plano en espanol, sin datos del cliente final (nombre/telefono) — solo guia, tienda, dias e
  importe. Limite de longitud del canal (Discord: 2.000 caracteres): si se excede, se trunca por grupo con
  "y N pedidos mas" y el total se conserva. Probado.

## 5. Estrategia de testing

Vitest solo recoge `src/**/*.test.ts`; todo `functions/src` se importa como `../../functions/src/<modulo>`
(principio 4). Fixtures locales, `now` inyectado, sin red.

### 5.1 Mapa requisito → modulo → prueba

| Req. | Modulo | Prueba |
|---|---|---|
| RF_01 | `cash-outstanding.ts` (importa `buildCodReceivedSet`) | `cash-outstanding.test.ts`: para cada pedido de un conjunto de fixtures (asignacion cubierta, no cubierta, parcial, corte pagado sin asignaciones, pendiente sin asignaciones, fuera de corte, prepago), `aparece en la lista` ⇔ `!isSellerEntryEligible(asientoCod, ...)`. Guarda: el archivo importa `buildCodReceivedSet` de `./seller-ledger` y no contiene `cashAllocations`/`covered` fuera de la lectura de `receivedCop`. **Mutacion:** pegar una copia inline de la regla rompe la guarda (DoD 1) |
| RF_02 | idem | campos de la fila: lider, mensajero, tienda, `deliveredAt`, `ageDays`, recaudo, `location` |
| RF_03 | idem | dia 7 no vencido, dia 8 vencido; `totals.overdueCop` |
| RF_04 | `cash-outstanding-schemas.ts`, `cash-outstanding-api.ts` | Zod: defecto 7, rechaza 0 y no enteros; guarda: el callable de ajustes exige admin y audita |
| RF_05 | `cash-overdue-notice.ts`, `ops-notify.ts` | umbral, una vez por pedido, agrupacion por lider, "sin lider", truncado; guarda: en `notifyOverdueCash` la escritura de `cashOverdueNotices` va **despues** de comprobar `ok` |
| RF_06 | `cash-outstanding.ts`, `cash-outstanding-api.ts` | alcance lider: solo sus filas y sin desglose de proveedor; guarda: `driverId` sale del claim para `role === "driver"` |
| RF_07 | idem | pedido con `closedAt` 2026-06-01 y `now` 2026-10-02 aparece con `ageDays` 123 (DoD 2); guarda: la consulta de `orders` del cargador no tiene `where` sobre `createdAt`/`closedAt` ni `limit` |
| RF_08 | `cash-outstanding.ts` | `supplierWithheld` por proveedor, excluye `product_cost` ya liquidado al proveedor |
| RNF_01 | `cash-outstanding-api.ts` | guarda: ningun archivo de `src/components` ni `state-store.ts` llama a `buildCodReceivedSet` para esta lista; la UI solo consume el callable |
| RNF_02 | `driver-receivable.ts`, `cash-outstanding.ts` | `driver-receivable.test.ts`: `computePlatformPosition` da lo mismo antes y despues de la extraccion (fixtures de `platform-position.test.ts`). `cash-outstanding.test.ts`: 4.4, `deltaCop === 0` sin causas y `unexplainedCop === 0` con cada causa |
| Casos limite | `cash-outstanding.ts` | corregido a fallido sale; parcial cuenta lo que falta; $1 aparece con $0 y no avisa; sin lider agrupado aparte; `deliveredAtSource` en las cuatro fuentes |

### 5.2 Lo que no se prueba en Vitest

El cargador y el envio son delgados y se cubren con guardas y con `verify-026.js`.

### 5.3 `scripts/verify-026.js` (solo lectura, JS sobre `functions/lib`, ADC)

- `baseline` (T1): numero de contraentregas entregadas y liquidadas (`count()`), cortes de domiciliario,
  filas no recibidas, fuentes de `deliveredAt`, pedidos de neto ≤ 0, asientos de domiciliario sin campo
  `settlementId`, y la tabla de antiguedad de la spec recalculada.
- `query-check`: ejecuta las consultas exactas del cargador (admin y una de lider) contra produccion; si
  alguna pide indice, lo imprime.
- `compare` (DoD 3 y 4): informe del cargador frente a `computePlatformPosition` sobre el ledger entero;
  imprime los 24 pedidos de mas de 30 dias, el total recaudado y la reconciliacion. Exige
  `unexplainedCop === 0`.

## 6. Dependencias nuevas

**Ninguna.** `fetch` es nativo en Node 20; Zod ya esta. Se anade un **secreto** de Firebase
(`OPS_NOTICE_WEBHOOK_URL`), no un paquete; lo crea el responsable con
`firebase functions:secrets:set OPS_NOTICE_WEBHOOK_URL`.

## 7. Indices de Firestore

- **Previstos: ninguno.** Las consultas son de igualdad + `in` sin `orderBy` (`paymentMethod`, `status`,
  y `driverId` para el lider), que Firestore resuelve con los indices de un campo; `walletEntries` por
  `orderId in` tambien. `settlements` por `kind` igual.
- `query-check` (T2) lo confirma contra produccion. Si pidiera uno, se **anade** a
  `firestore.indexes.json` tras comparar con `firebase firestore:indexes` (desplegar borra los que falten),
  se despliega primero y se espera `READY`.

## 8. Orden de despliegue

1. Indices: solo si T2 lo exige (y entonces primero, esperando `READY`).
2. Secreto `OPS_NOTICE_WEBHOOK_URL` creado por el responsable (antes de functions: sin el, el despliegue
   de `notifyOverdueCash` falla).
3. Functions (`getCashOutstanding`, `updateCashAlertSettings`, `notifyOverdueCash`, y
   `getPlatformPosition` por la extraccion) con `ALLOW_FUNCTIONS_DEPLOY=1`, tras `cd functions && npm run
   build` y confirmar set local == prod (`firebase functions:list`). Lo despliega un humano (principio 7).
4. Aviso de prueba: `gcloud scheduler jobs run firebase-schedule-notifyOverdueCash-us-central1 --location
   us-central1` y captura del mensaje recibido.
5. Hosting, despues de `/sdd-design` y de las tareas de interfaz, con `ALLOW_FUNCTIONS_DEPLOY=1 npm run
   deploy:hosting`, `npm run lint` en verde.

## 9. Pendiente de /sdd-design

Sin entregables en `specs/design/026/`. Antes de las tareas de interfaz hace falta decidir: donde va el
total vencido en la pantalla principal del admin (RF_03); la lista agrupada por lider y su orden (HU_01);
como se distingue "fuera de todo corte" de "en un corte pendiente" y la fecha aproximada
(`deliveredAtSource`); como se muestra el bloqueo por proveedor (RF_08) en la liquidacion; la vista del
lider y su relacion con "Pendiente por entregar" (HU_02, P6); el control del plazo y el umbral (RF_04);
como se muestran `unreadable*` y la reconciliacion. El contrato de datos de 4.1 es el que esas pantallas
consumen.

## 10. Riesgos

| Riesgo | Mitigacion |
|---|---|
| RNF_02 no cuadra literalmente (4.4) | reconciliacion explicita por causas; DoD 4 = `unexplainedCop 0`; P1 lo pone ante el responsable antes de T4 |
| La extraccion de `computeDriverReceivable` mueve la posicion | `platform-position.test.ts` y `driver-receivable.test.ts` en verde antes y despues; comparacion en `verify-026.js` |
| Lecturas crecen con el historico (opcion A) | medidas en T1; umbral de Fase 2 en 2.1 anotado en `docs/rendimiento.md` |
| `deliveredAt` aproximado en pedidos anteriores a la spec 001 | la fila dice su fuente; T1 cuenta cuantos |
| Asientos de domiciliario sin `settlementId` escapan a la consulta de reconciliacion | T1 los cuenta; si hay, compuerta |
| Aviso duplicado si cae la escritura tras enviar | al menos una vez, documentado; `cashOverdueRuns` permite auditarlo |
| Aviso que no sale (secreto mal puesto, webhook revocado) | `cashOverdueRuns` con error; aviso de prueba en el despliegue; P4 sobre un segundo canal |
| La primera corrida avisa todo el atraso | un solo mensaje agrupado; confirmar en P5 |
| Dos cifras distintas para el lider (esta lista vs "Pendiente por entregar") | P6 y `/sdd-design` antes de construir HU_02 |
| Pedidos de neto ≤ 0 bloqueados para siempre por la regla | visibles con $0; P7, spec aparte si procede |
| Un documento invalido haria desaparecer una fila | Zod con `unreadable*` visibles, nunca descarte silencioso |

## 11. Preguntas abiertas (bloqueantes marcadas)

- **P1 (bloqueante, RNF_02):** la posicion netea en agregado el pago de visitas fallidas y de pedidos de
  $1, asi que "por cobrar al domiciliario" no es la suma por pedido de lo no recibido. ¿Se acepta
  enmendar RNF_02 a "coincide salvo diferencias explicadas por causa, con residuo 0" (propuesta del
  plan), o se quiere que la posicion cambie de definicion? Ademas: DoD 3 mide **recaudo bruto**
  ($14.557.721) y DoD 4 una cifra **neta del pago al domiciliario**; ¿cual es "el total" que ve el admin?
- **P2 (bloqueante para RF_05):** ¿por que canal y a que destino llega el aviso? Propuesta: webhook
  entrante de Discord (o Slack/Google Chat) con `fetch`, sin dependencias. Correo implicaria dependencia
  nueva.
- **P3 (bloqueante para RF_05):** umbral minimo para avisar (caso de $1). Propuesta: $20.000 de efectivo
  pendiente (`outstandingCop`), configurable junto al plazo.
- **P4:** ¿el plazo es global o por lider? El plan lo hace global (RF_04 lo nombra en singular); por lider
  exigiria otro campo y otra pantalla.
- **P5:** hora de la corrida diaria (propuesta 08:00 Bogota), y si la primera corrida debe avisar todo el
  atraso actual o empezar desde cero marcando lo existente como avisado.
- **P6:** la vista del lider (HU_02) ¿sustituye, complementa o se reconcilia con su "Pendiente por
  entregar" actual? No van a coincidir exactamente (este ultimo usa `totalCop` y `cashPendingCop`).
- **P7:** los pedidos cuyo recaudo no supera el pago al domiciliario nunca se dan por recibidos con la
  regla actual y bloquean para siempre ese asiento de la tienda. ¿Spec aparte?
- **P8:** ¿se incluyen los pedidos en estado `liquidated`? El plan si (misma compuerta que la tienda); la
  medicion de la spec uso solo `delivered`, asi que las cifras pueden subir algo.
