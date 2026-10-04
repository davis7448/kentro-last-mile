# Plan tecnico — Spec 025: el costo de producto de un pedido cerrado se corrige desde la plataforma

Spec: `specs/025_corregir_costo_de_producto_de_pedidos_cerrados.md` (**borrador, sin grill**).
Este plan no la aprueba: las ambiguedades que bloquean estan en la seccion 13 y deben cerrarse en el
grill antes de `/sdd-tasks`. Interfaz: **pendiente de `/sdd-design`** (seccion 12); este plan no decide
pantallas, textos visibles ni flujo.

---

## 1. Lo que hay hoy (leido en el codigo, no supuesto)

**El costo se decide una vez, al cerrar.** `closeOrder` (`functions/src/orders.ts:1212`) llama a
`resolveProductCostLinesForOrder(order, catalog)` (`functions/src/wallet-entries.ts:65`) y pasa las
lineas a `buildWalletEntries` (`:98`). Emparejamiento por linea (`matchCatalogForLine`, `:43`): id (solo
sin `lineItems`) → SKU en mayusculas → nombre normalizado **solo en fichas sin SKU**; una ficha con
`productCostConfigured !== true` no produce linea (`:81`). Cada producto da **un** asiento
`product_cost` de `ownerType: "seller"`, importe negativo, con `supplierId`/`supplierName`/`productId`,
id `we-${orderId}-product-cost-${productId}` (o `we-${orderId}-product-cost` sin `lineItems`), y
`withOpenSettlementFlags` deja `settlementId: ""` y `supplierSettlementId: ""`.

**Un mismo asiento sirve a dos cuentas.** No hay asiento de proveedor: su saldo se deriva de los
`product_cost` de tienda con su `supplierId` y sin `supplierSettlementId` (`createSettlement`,
`orders.ts:1262-1277`; `recordSupplierAbono`, `:1673-1690`; UI `buildSupplierLiquidationRows`,
`operations-app.tsx:7764`). Por tanto **cargar a la tienda y abonar al proveedor (RF_06) es UN asiento**,
y un asiento positivo con `supplierId` es un cruce que reduce lo que se le debe al proveedor (ya
contemplado en `recordSupplierAbono`, comentario `:1682-1685`).

**El costo de un pedido no vive en un solo asiento.** `recordSupplierAbono` **parte** asientos: reduce
el original y crea `${id}-parcial-${ts}` ya liquidado (`:1713-1781`). Comparar "lo que el pedido tiene"
contra "lo que deberia tener" por id unico, como hace `order-corrections-plan.ts:393`, aqui daria un
cobro doble. Lo ya descontado es una **suma por (pedido, producto)**.

**Dos compuertas que ya existen y se heredan gratis.**
- Tienda: `isSellerEntryEligible` (`functions/src/seller-ledger.ts:43`) — prepagado siempre; COD solo
  con efectivo recibido (`buildCodReceivedSet`, `:20`).
- Proveedor: la UI (`operations-app.tsx:8036-8042`) y `createSettlement` exigen lo mismo para un
  `product_cost` aun no cortado con la tienda.
Un asiento nuevo con `orderId` de un pedido COD sin efectivo recibido **no es pagable** ni a la tienda
ni al proveedor hasta que llegue el efectivo: es el caso limite "efectivo en manos del domiciliario",
resuelto sin codigo nuevo.

**Un asiento de tienda sin pedido BLOQUEA su corte.** `computeSellerBalance`
(`functions/src/seller-balance.ts:184-200`) manda a `unreadableEntryIds` todo asiento no elegible sin
pedido legible, y `createSettlement` (`orders.ts:1299-1301`) se niega a cortar. Un cruce sin `orderId`
dejaria a la tienda sin poder cobrar. **Todo asiento de esta spec lleva el `orderId` de un pedido real.**

**Ya hay un retro-cobro, en el cliente.** `buildMissingProductCostEntries` (`src/lib/product-catalog.ts:74`)
se ejecuta al guardar una ficha (`operations-app.tsx:6778`) y escribe asientos desde el navegador del
admin, pero solo sobre `state.orders` — la ventana descargada (constitucion, principio 8) — y con la
copia cliente del emparejamiento (`src/lib/finance.ts:72-127`). Por eso los pedidos viejos de Nambu
quedaron sin costo aunque luego se creo la ficha. Ver pregunta abierta P7.

**El patron a imitar.** `order-corrections-plan.ts` (puro) + `order-corrections.ts` (callable
`correctOrderStatus`): `dryRun` devuelve plan + huella (`hashPlan`, sin marcas de tiempo); aplicar exige
la huella, usa `batch` con precondiciones `lastUpdateTime` y `batch.create` para asientos nuevos.

**Lo escrito a mano el 2026-09-30** (sin scripts en el repo; forma a confirmar en T0):

| Movimiento | Id | Forma |
|---|---|---|
| 43 costos faltantes (Nambu 37, Bella Mujer 3, +3) | id estandar del cierre | `product_cost` negativo |
| Lemme (LuminXP) | id estandar | 0 → −23.000 → 0, campos `retroCorrectedAt`, `retroRevertedAt` |
| Kit Cuidado Completo 42.000 → 50.000 | `${id}-ajuste-costo-50000` | −8.000 c/u |
| Envios LuminXP que asume LAB | `we-${orderId}-cruce-envio-adma-lab` | `product_cost` **positivo** +12.000, `supplierId` de LAB |
| Precedente anterior | `we-cruce-fletes-seller-1783783071241-1785966764476` | +48.000, cruce de fletes contra ADMA COMPANY |

Auditorias: `auditEvents` con `wallet.product_cost_retro` y `wallet.product_cost_retro_reverted`.

---

## 2. Decisiones de diseno

### 2.1 La correccion es una DIFERENCIA calculada por suma, no una comparacion por id

Para cada pedido y producto en alcance:

```
cobrado(o, p)  = Σ amountCop de los asientos de COSTO de o atribuidos a p   (≤ 0)
objetivo(o, p) = amountCop del product_cost que buildWalletEntries emitiria HOY para p   (≤ 0)
delta(o, p)    = objetivo − cobrado
```

`delta = 0` → nada (RF_03). `delta ≠ 0` → **un** asiento nuevo por `delta` (negativo cobra mas, positivo
devuelve). Reaplicar da `delta = 0` porque el asiento anterior ya entra en `cobrado` (RF_04). Las piezas
`-parcial-`, los ajustes manuales y los asientos del 30-09 entran en la suma sin tratamiento especial
(seccion 6 de la spec: "reconocerlos como ya aplicados").

### 2.2 RF_01 sin aritmetica propia: el objetivo lo emite `buildWalletEntries`

El planificador llama a `buildWalletEntries(orderDelivered, defaultSettings, now, lines)` y se queda con
los asientos `type === "product_cost"`: mismo importe, mismo id canonico, mismo proveedor que el cierre.
Las tarifas no intervienen en el costo de producto, asi que pasar `defaultSettings` no cambia una cifra
(una prueba lo fija: el subconjunto `product_cost` es identico con dos juegos de tarifas distintos). No
hay un `unitCost × quantity` en ningun archivo nuevo; una guarda de fuente lo vigila.

### 2.3 Solo se corrigen los productos que el admin elige

"Costo vigente hoy" aplicado a **todo** el pedido re-preciaria productos que se cobraron bien a un costo
anterior (un proveedor que subio precio en agosto). La peticion lleva `productIds` y solo esos productos
pueden moverse; el resto del pedido no se lee como objetivo. Ver P1.

### 2.4 El caso KNT-004603: nunca se devuelve lo que hoy no empareja

El emparejamiento se separa en una funcion que dice, linea por linea, **que ficha le toca y por que**
(`matchProductCostLines`, 4.1). Tres situaciones para un producto elegido `p`:

| Situacion | Objetivo | Efecto |
|---|---|---|
| Alguna linea empareja `p`, ficha configurada (incluido $0) | importe del cierre | `delta` normal |
| Alguna linea empareja `p`, ficha `costPaidOutsideKentro` | 0 | `delta` normal (puede devolver) |
| Alguna linea empareja `p`, ficha sin configurar | desconocido | **sin movimiento**, aviso `cost_not_configured` |
| Ninguna linea empareja `p` y `cobrado(o,p) ≠ 0` | desconocido | **sin movimiento**, aviso `charged_but_unmatched` |

La ultima fila es KNT-004603: la ficha de Tentacion tenia un JSON de paquete en el nombre y hoy no
empareja por nombre, pero el pedido **ya tiene** su asiento con ese `productId`. Lo cobrado manda; un
emparejamiento fallido nunca se interpreta como "no tenia costo".

### 2.5 Ficha elegida a mano, con guarda contra el cobro doble

Para nombres que cambian en cada pedido, la peticion admite `lineOverrides: { orderId, lineIndex,
productId }[]`. El override solo existe en el planificador; el cierre nunca lo recibe. Si un pedido con
override tiene `cobrado(o, q) ≠ 0` para alguna ficha `q` que **ninguna** linea empareja hoy, ese pedido
queda bloqueado (`override_may_double_charge`): es muy probable que `q` sea la misma linea cobrada con
otra ficha.

### 2.6 Nunca se reescribe un asiento existente; nunca se recalcula un corte

Los asientos nuevos nacen abiertos en las dos cuentas y se netean en el siguiente corte de la tienda y
del proveedor. Ningun asiento existente cambia de importe. Es mas estricto que RF_05 (que solo protege
cortes pagados/conciliados) y elimina por construccion el recalculo de cortes pendientes, el 4x1000 de
corte y la carrera con `createSettlement`. Coste aceptado: si el costo original esta en un corte
pendiente, el ajuste cae en el siguiente, no en ese.

### 2.7 Ids deterministas y numerados: la carrera entre dos admins falla ruidosamente

| Asiento | Id |
|---|---|
| Primer costo de `p` en `o`, sin asiento canonico | id canonico del cierre (`we-${o}-product-cost-${p}` / `we-${o}-product-cost`) |
| Ajuste posterior | `we-${o}-product-cost-${p}-adj-${k}`, `k = 1 + max(k existentes)` |
| Reversa de una correccion | `${entryId}-revert` |
| Cruce | `we-${o}-cruce-${supplierId}-${k}` |

Se escriben con `batch.create`: dos aplicaciones simultaneas calculan el mismo `k` y la segunda falla
entera. Usar el id canonico para el primer costo deja el pedido igual que si el cierre lo hubiera
cobrado bien, que es lo que hizo el script del 30-09 con sus 43 asientos.

### 2.8 Clasificacion de asientos existentes: costo, cruce o inatribuible

Funcion pura `classifyProductCostEntry` (4.2). Un cruce **no** es costo de un producto y no entra en
`cobrado`; si entrara, los +12.000 de LuminXP harian creer que falta cobrar 12.000 de producto.
Un asiento de costo sin `productId` en un pedido **con** `lineItems` es inatribuible → el pedido se
bloquea (`unattributed_cost_entry`) en vez de adivinar.

### 2.9 Reversion (RF_07) desde un registro de correccion

Cada aplicacion escribe `productCostCorrections/{id}` con la lista exacta de movimientos. Revertir
planifica, por cada movimiento, sobre su **familia** actual (el asiento y sus piezas `-parcial-`):
- familia abierta en las dos cuentas (`settlementId` y `supplierSettlementId` vacios) → se borra, con
  precondicion `lastUpdateTime`;
- cualquier pieza en un corte (de tienda o de proveedor, pendiente o no) → reversa
  `${entryId}-revert` por `−Σ familia`, abierta.
Resultado: tienda y proveedor como antes de la correccion en ambos casos. Ver P6.

### 2.10 Cruce (RF_08) como asiento por pedido

Positivo, `product_cost`, `ownerType: "seller"`, `supplierId` del proveedor que asume, `adjustmentKind:
"cruce"`, `orderId` obligatorio (2.1 de la seccion 1: sin pedido bloquea el corte). Tambien queda
registrado en `productCostCorrections` (`kind: "cross"`) y es reversible por el mismo camino. Ver P5.

### 2.11 Dos marcas nuevas en la ficha, que el cierre respeta

- `zeroCostIntended: true` — "$0 a proposito" (DANDA, productos propios, pruebas). Solo afecta a RF_10:
  la ficha sale del listado de huecos y pasa a un grupo aparte. No cambia ningun importe.
- `costPaidOutsideKentro: true` — la tienda paga el producto al proveedor por fuera (LuminXP con LAB).
  `resolveProductCostLinesForOrder` **no emite linea** para esa ficha: el cierre deja de descontar
  producto. Vive en `wallet-entries.ts` porque es dinero (principio 9), y su copia cliente
  (`finance.ts:productCostLinesForOrder`) se cambia en el mismo commit y se ata con prueba de paridad
  (principio 3). Ver P2.

Ambas se cambian por una callable auditada (`setProductCostPolicy`), no por `saveProduct`, porque
`costPaidOutsideKentro` mueve dinero en cada cierre futuro.

### 2.12 RF_10 en servidor

`listProductCostGaps({ sellerId })` lee ficha + pedidos entregados de la tienda y agrega con
`matchProductCostLines`. Calcularlo en el navegador solo veria la ventana descargada: el mismo fallo
que dejo a Nambu sin costo (principio 11).

---

## 3. Arbol de modulos

```
functions/src/wallet-entries.ts                 MODIFICADO  matchProductCostLines (extraida), resolveProductCostLinesForOrder
                                                            honra costPaidOutsideKentro y acepta overrides opcionales
functions/src/product-cost-ledger.ts            NUEVO puro  clasificar asientos, sumar cobrado por (pedido, producto), familias, ids
functions/src/product-cost-correction-plan.ts   NUEVO puro  planificar correccion, reversion y cruce; nada de Firestore
functions/src/product-cost-gaps.ts              NUEVO puro  RF_10: fichas activas a $0 con pedidos entregados
functions/src/product-cost-schemas.ts           NUEVO puro  Zod de entrada de las callables y de los documentos leidos
functions/src/product-cost-corrections.ts       NUEVO E/S   callables: previewOrApplyProductCostCorrection, revertProductCostCorrection,
                                                            applyProductCostCross, listProductCostGaps, setProductCostPolicy
functions/src/index.ts                          MODIFICADO  exporta las cinco callables
src/lib/finance.ts                              MODIFICADO  productCostLinesForOrder honra costPaidOutsideKentro (paridad)
src/lib/types.ts                                MODIFICADO  campos nuevos de ProductCatalogItem y WalletEntry; ProductCostCorrection
src/lib/firebase/auth.ts                        MODIFICADO  envoltorios tipados de las cinco callables
src/components/operations-app.tsx               MODIFICADO  solo tras /sdd-design; saveProduct conserva las marcas nuevas
firestore.rules                                 MODIFICADO  productCostCorrections: lectura admin, escritura nadie
scripts/verify-025-inventory.js                 NUEVO       solo lectura: forma real de los asientos del 30-09 (T0)
scripts/verify-025.js                           NUEVO       DoD 5: sesion admin desechable, tienda de prueba, aplicar y revertir

src/lib/product-cost-ledger.test.ts             NUEVO       clasificacion y sumas, con los ids historicos literales
src/lib/product-cost-correction-plan.test.ts    NUEVO       DoD 1-4, KNT-004603, overrides, cruce
src/lib/product-cost-gaps.test.ts               NUEVO       RF_10
src/lib/product-cost-parity.test.ts             NUEVO       wallet-entries vs finance.ts con las marcas nuevas
src/lib/spec-025-guards.test.ts                 NUEVO       guardas de fuente (callable, reglas, saveProduct)
```

---

## 4. Modelo de datos

### 4.1 Emparejamiento (en `wallet-entries.ts`)

```ts
export type CatalogItemDoc = {
  id: string;
  sellerId: string;
  supplierId?: string;
  supplierName?: string;
  sku?: string;
  name: string;
  normalizedProductName?: string;
  productCostCop: number;
  productCostConfigured: boolean;
  active?: boolean;
  zeroCostIntended?: boolean;          // NUEVO, 2.11
  costPaidOutsideKentro?: boolean;     // NUEVO, 2.11
};

export type LineMatchReason = "id" | "sku" | "name" | "override";
export type LineMatch = {
  lineIndex: number;                   // -1 para pedidos sin lineItems
  quantity: number;
  productId: string | null;
  reason: LineMatchReason | null;
  costState: "configured" | "not_configured" | "paid_outside" | "unmatched";
};

export type LineOverride = { lineIndex: number; productId: string };

export function matchProductCostLines(
  order: ProductCostOrder,
  catalog: CatalogItemDoc[],
  overrides?: readonly LineOverride[]
): LineMatch[];

// Firma ampliada, compatible: el tercer parametro es opcional y el cierre no lo pasa.
export function resolveProductCostLinesForOrder(
  order: ProductCostOrder,
  catalog: CatalogItemDoc[],
  overrides?: readonly LineOverride[]
): ProductCostLine[];
```

`ProductCostOrder` es un `Pick` explicito (`id`, `sellerId`, `status`, `paymentMethod`, `shopifyOrderId`,
`trackingCode`, `productId`, `sku`, `productName`, `quantity`, `lineItems`). Los llamantes actuales pasan
`Record<string, any>`; el cambio de tipo se limita a los modulos nuevos con un adaptador validado por
Zod, para no arrastrar una refactorizacion de `orders.ts` fuera de alcance.

### 4.2 Asientos (en `settlement-math.ts`, campos opcionales nuevos)

```ts
export type ProductCostAdjustmentKind = "correction" | "revert" | "cruce";

// Se anaden a WalletEntryDoc (y a WalletEntry en src/lib/types.ts):
adjustmentKind?: ProductCostAdjustmentKind;
correctionId?: string;      // productCostCorrections/{id} que lo creo
reverses?: string;          // en una reversa, id del asiento que anula
```

```ts
// product-cost-ledger.ts
export type ProductCostEntryClass =
  | { kind: "cost"; productId: string }
  | { kind: "cruce"; supplierId: string }
  | { kind: "unattributed" };

export function classifyProductCostEntry(entry: WalletEntryDoc, order: ProductCostOrder): ProductCostEntryClass;
export function chargedByProduct(entries: WalletEntryDoc[], order: ProductCostOrder): Map<string, number>;
export function entryFamily(entries: WalletEntryDoc[], entryId: string): WalletEntryDoc[];
export function nextAdjustmentId(entries: WalletEntryDoc[], orderId: string, productId: string): string;
export function nextCrossId(entries: WalletEntryDoc[], orderId: string, supplierId: string): string;
export function isFullyOpen(entry: WalletEntryDoc): boolean;   // settlementId y supplierSettlementId vacios
```

Reglas de `classifyProductCostEntry`, en este orden:
1. `adjustmentKind === "cruce"`, o id que contiene `-cruce-`, o empieza por `we-cruce-` → `cruce`.
2. Tiene `productId` → `cost` de ese producto.
3. Sin `productId` y el pedido **sin** `lineItems` → `cost` del unico producto que el pedido puede tener
   (el de `matchProductCostLines` de la linea −1); si esa linea no empareja → `unattributed`.
4. Si no → `unattributed`.

### 4.3 Peticiones (Zod, `product-cost-schemas.ts`)

```ts
export const productCostCorrectionRequestSchema = z.object({
  sellerId: z.string().min(1),
  productIds: z.array(z.string().min(1)).min(1).max(20),
  orderIds: z.array(z.string().min(1)).max(500).optional(),     // sin esto: todos los entregados de la tienda
  closedFrom: z.string().date().optional(),
  closedTo: z.string().date().optional(),
  lineOverrides: z.array(z.object({
    orderId: z.string().min(1), lineIndex: z.number().int().min(-1), productId: z.string().min(1)
  })).max(500).default([]),
  excludeOrderIds: z.array(z.string().min(1)).max(500).default([]),
  reason: z.string().trim().min(10),
  dryRun: z.boolean(),
  expectedPlanHash: z.string().optional()
}).strict();

export const productCostRevertRequestSchema = z.object({
  correctionId: z.string().min(1),
  reason: z.string().trim().min(10),
  dryRun: z.boolean(),
  expectedPlanHash: z.string().optional()
}).strict();

export const productCostCrossRequestSchema = z.object({
  sellerId: z.string().min(1),
  supplierId: z.string().min(1),
  items: z.array(z.object({ orderId: z.string().min(1), amountCop: z.number().int().positive().max(2_000_000) }))
    .min(1).max(450),
  concept: z.string().trim().min(3).max(120),
  reason: z.string().trim().min(10),
  dryRun: z.boolean(),
  expectedPlanHash: z.string().optional()
}).strict();

export const productCostPolicyRequestSchema = z.object({
  productId: z.string().min(1),
  zeroCostIntended: z.boolean().optional(),
  costPaidOutsideKentro: z.boolean().optional(),
  reason: z.string().trim().min(10)
}).strict();

export const listProductCostGapsRequestSchema = z.object({ sellerId: z.string().min(1) }).strict();
```

Los documentos leidos de Firestore (`orders`, `walletEntries`, `productCatalog`, `settlements`) pasan
por esquemas Zod `.passthrough()` con los campos que se usan; un documento que no valida es un
`blocker` del pedido afectado, no un `any`. El tope de 2.000.000 por cruce reutiliza el de la spec 022.

### 4.4 Plan

```ts
export type PlanNote = { code: string; message: string; orderId?: string };

export type ProductCostLineDiff = {
  orderId: string;
  trackingCode: string;
  productId: string;
  productName: string;
  supplierId: string;
  matchReason: LineMatchReason | null;
  quantity: number;
  chargedCop: number;          // ≤ 0
  targetCop: number | null;    // null = desconocido (2.4): no mueve dinero
  deltaCop: number;            // 0 si targetCop es null
  existingEntryIds: string[];
  existingInFrozenSettlement: boolean;   // informativo: el delta va al periodo abierto igual
};

export type PlannedEntry = WalletEntryDoc & {
  adjustmentKind: ProductCostAdjustmentKind;
  settlementId: "";
  supplierSettlementId: "";
};

export type OrderGate = {
  orderId: string;
  paymentMethod: "cod" | "prepaid";
  payableNow: boolean;         // isSellerEntryEligible con buildCodReceivedSet
};

export type ProductCostCorrectionPlan = {
  kind: "correction";
  sellerId: string;
  lines: ProductCostLineDiff[];
  entriesToCreate: PlannedEntry[];
  gates: OrderGate[];
  totals: {
    sellerDeltaCop: number;                          // Σ delta (negativo = se le cobra)
    bySupplier: Array<{ supplierId: string; supplierName: string; payableDeltaCop: number }>;
    payableNowCop: number;
    waitingCashCop: number;                          // pedidos COD sin efectivo recibido
    sellerOpenBalanceBeforeCop: number;
    sellerOpenBalanceAfterCop: number;               // prepagados: puede quedar negativo (caso limite)
  };
  recognizedHistory: PlanNote[];                     // asientos del 30-09 reconocidos (retroRevertedAt, -ajuste-, -cruce-)
  warnings: PlanNote[];
  blockers: PlanNote[];                              // por pedido; un pedido bloqueado no escribe nada
  writeCount: number;
  auditSummary: string;
};

export type ProductCostRevertPlan = {
  kind: "revert";
  correctionId: string;
  entriesToDelete: Array<{ id: string }>;
  entriesToCreate: PlannedEntry[];
  totals: { sellerDeltaCop: number; bySupplier: Array<{ supplierId: string; payableDeltaCop: number }> };
  warnings: PlanNote[];
  blockers: PlanNote[];
  auditSummary: string;
};

export type ProductCostCrossPlan = {
  kind: "cross";
  sellerId: string;
  supplierId: string;
  entriesToCreate: PlannedEntry[];
  gates: OrderGate[];
  warnings: PlanNote[];
  blockers: PlanNote[];
  auditSummary: string;
};
```

### 4.5 Registro de correccion

```ts
// productCostCorrections/{id}, id = `pcc-${Date.now()}-${sellerId}`
export type ProductCostCorrection = {
  id: string;
  kind: "correction" | "cross";
  status: "applied" | "reverted";
  sellerId: string;
  supplierIds: string[];
  productIds: string[];             // vacio en un cruce
  orderIds: string[];
  movements: Array<{ entryId: string; orderId: string; productId?: string; supplierId: string; amountCop: number }>;
  sellerDeltaCop: number;
  reason: string;
  planHash: string;
  actorId: string;
  createdAt: string;
  revertedAt?: string;
  revertedBy?: string;
  revertReason?: string;
  revertMovements?: Array<{ entryId: string; action: "deleted" | "reversed"; amountCop: number }>;
};
```

Auditoria (`auditEvents`, mismo esquema que `correctOrderStatus`): `wallet.product_cost_correction`,
`wallet.product_cost_correction_reverted`, `wallet.product_cost_cross`, `catalog.product_cost_policy`;
`entity` = `"seller"` o `"productCatalog"`, `summary` con pedidos e importes (RF_06).

---

## 5. Algoritmos criticos

### 5.1 `planProductCostCorrection(input)` — puro

Entrada: tienda, pedidos en alcance (solo `status === "delivered"`, ver P4), todos los `product_cost`
de tienda de esos pedidos, ficha de la tienda, proveedores, conjunto de efectivo recibido, saldo abierto
de la tienda, peticion validada, `now`.

Por cada pedido, en orden de `closedAt` y luego `trackingCode`:
1. Si esta en `excludeOrderIds` → fuera, sin nota.
2. Clasificar sus asientos (4.2). Si hay `unattributed` → `blocker` del pedido, siguiente.
3. `matches = matchProductCostLines(order, catalog, overridesDelPedido)`.
4. `lines = resolveProductCostLinesForOrder(order, catalog, overridesDelPedido)` y
   `canonical = buildWalletEntries(order, defaultSettings, now, lines).filter(product_cost)`.
5. Guarda 2.5 si el pedido tiene overrides.
6. Por cada `p` de `productIds`:
   - `charged = chargedByProduct(...).get(p) ?? 0`;
   - si ninguna linea empareja `p`: si `charged ≠ 0` aviso `charged_but_unmatched`; continuar;
   - si las lineas de `p` estan `not_configured`: aviso `cost_not_configured`; continuar;
   - `target = canonical.find(productId === p)?.amountCop ?? 0` (`paid_outside` da 0 porque no hay linea);
   - si el proveedor de los asientos cobrados difiere del de la ficha: `blocker supplier_mismatch` (P3);
   - `delta = target − charged`; si `0` → fila sin movimiento;
   - id: el canonico si no existe ningun asiento con ese id **y** `charged === 0`; si no, `nextAdjustmentId`;
   - asiento: `stripUndefined` + `withOpenSettlementFlags`, `type: "product_cost"`, `ownerType: "seller"`,
     `amountCop: delta`, `supplierId`/`supplierName` de la ficha y de `suppliers` (el catalogo no siempre
     trae `supplierName`), `productId`, `productName`, `adjustmentKind: "correction"`, `correctionId`,
     `description` (texto pendiente de diseno, HU_04), `createdAt: now`.
7. Notas de historia: asientos con `retroCorrectedAt`/`retroRevertedAt`, ids `-ajuste-costo-` o cruces
   existentes → `recognizedHistory` (se muestran, no cambian la suma).

Totales: `sellerDeltaCop = Σ delta`; por proveedor `payableDeltaCop = −Σ delta`; `payableNowCop` /
`waitingCashCop` con `isSellerEntryEligible`; saldo abierto despues = antes + `sellerDeltaCop`. Si es
negativo y hay prepagados → aviso `prepaid_negative_balance`. `writeCount = asientos + 1 registro +
1 auditoria`; por encima de 450 → `blocker too_many_writes` (limite de 500 operaciones por batch).

### 5.2 Huella y aplicacion

`hashPlan` igual a `order-corrections.ts:70` (sin `createdAt`, `updatedAt`, `now`, `correctionId`).
Aplicar: recalcular el plan con lecturas frescas, exigir `blockers` vacio (los bloqueos por pedido se
resuelven con `excludeOrderIds`, no se saltan en silencio), comparar huella, y en un solo batch:
`create` de cada asiento, `create` del registro, `set` de la auditoria. Ningun `update` sobre asientos
existentes, asi que no hacen falta precondiciones sobre ellos: la huella detecta que la suma cambio y
`create` detecta la carrera (2.7).

### 5.3 `planProductCostRevert(correction, entries, now)` — puro

1. `status === "reverted"` → `blocker already_reverted`.
2. Por movimiento: `family = entryFamily(entries, entryId)`. Vacia → `blocker movement_missing`.
   Existe `${entryId}-revert` → nada (ya revertido a mano). Todas `isFullyOpen` → borrar familia.
   Si no → crear `${entryId}-revert` por `−Σ family` con `reverses: entryId`, `adjustmentKind: "revert"`,
   mismos `supplierId`/`productId`/`orderId`.
3. Si existe una correccion posterior aplicada sobre el mismo (pedido, producto) → aviso
   `later_correction_exists`.
Aplicar: `delete` con precondicion `lastUpdateTime` de cada pieza (un `createSettlement` concurrente
haria fallar el batch, igual que en `order-corrections.ts:219`), `create` de reversas, `update` del
registro con precondicion, auditoria.

**Invariante (DoD 4):** para cada tienda y proveedor, `Σ asientos despues de revertir = Σ antes de
aplicar`, tanto si la familia se borro como si se compenso.

### 5.4 `planProductCostCross` — puro

Por item: el pedido existe, es de la tienda y esta entregado; si no → `blocker`. Si ya existe un cruce
del mismo proveedor en el pedido → aviso `cross_already_present` (el de LuminXP del 30-09 aparece aqui).
Asiento `+amountCop` con `nextCrossId`. Registro `kind: "cross"`; se revierte por 5.3.

### 5.5 `computeProductCostGaps(catalog, deliveredOrders, entriesByOrder)` — puro (RF_10)

Para cada ficha activa con costo $0 (`!productCostConfigured` o `productCostCop === 0`), contar pedidos
entregados donde alguna linea la empareja (`matchProductCostLines`), unidades, ultima fecha de cierre y
cuantos de esos pedidos tienen `cobrado = 0`. Fila con `state: "not_configured" | "configured_zero" |
"zero_intended" | "paid_outside"`. Las `zero_intended` y `paid_outside` se devuelven en grupo aparte
(la spec: listarlas sin empujar a corregirlas). Fichas sin pedidos entregados no salen.

### 5.6 Lecturas de la callable (RNF_01)

Por tienda: `orders` `where sellerId == S` + `where status == "delivered"` (filtro de fechas en memoria);
`walletEntries` `where ownerType == "seller"`, `ownerId == S`, `type == "product_cost"`;
`productCatalog where sellerId == S`; `suppliers`; `settlements where kind == "driver"` (lo mismo que
`createSettlement`); saldo con `loadSellerBalanceInput` (ya existe). Todo igualdad: en principio sin
indice compuesto nuevo; T0 lo comprueba contra produccion. 400 pedidos ≈ 400 + ~1.000 asientos + cortes:
del orden de 2-3 s. Se mide en T-final (`scripts/verify-025.js`) antes de dar RNF_01 por cumplido.

---

## 6. Estrategia de testing

Vitest solo recoge `src/**/*.test.ts`: todo lo de `functions/` se prueba importando
`../../functions/src/<modulo>` (patron de `order-corrections-plan.test.ts`). Los modulos nuevos son
puros, asi que se prueba comportamiento, no fuente.

**`product-cost-ledger.test.ts`** — fixtures con los ids **literales** del 30-09 (T0 confirma su forma):
id estandar, `-ajuste-costo-50000`, Lemme a 0 con `retroRevertedAt`, `we-${o}-cruce-envio-adma-lab`,
`we-cruce-fletes-seller-…`, pieza `-parcial-`. Cada uno con su clase y su suma esperada.

**`product-cost-correction-plan.test.ts`:**
- DoD 1 / RF_02: el mismo `input` en `dryRun` y en aplicacion produce los mismos asientos y la misma
  huella; y la callable no tiene otro camino (guarda de fuente: un solo punto de llamada al planificador).
- DoD 2 / RF_03, RF_04: pedido ya correcto → 0 asientos; aplicar, sumar los creados al input y volver a
  planificar → 0 asientos. **KNT-004603**: ficha con nombre JSON que no empareja, asiento existente con
  su `productId` → 0 asientos y aviso `charged_but_unmatched`.
- DoD 3 / RF_05: costo original en corte de tienda `paid` y de proveedor `paid` → el plan no contiene
  ningun `update` ni `delete` y el asiento nuevo nace con los dos campos de corte vacios.
- DoD 4 / RF_07: aplicar → revertir con familia abierta (borra) y con familia en corte pagado
  (compensa) y con familia partida por `recordSupplierAbono` → sumas por tienda y por proveedor iguales
  a las de antes de aplicar.
- RF_01: el asiento creado coincide con el que `buildWalletEntries` emitiria al cerrar el mismo pedido
  con la ficha corregida (id, importe, proveedor). Combos y dos lineas del mismo producto.
- Override con cobro previo bajo otra ficha → `blocker override_may_double_charge`.
- Nambu (ficha nueva, sin asiento) → id canonico; Kit 42→50 → `-adj-1` por −8.000 reconociendo el
  `-ajuste-costo-50000` (si ya existe, 0).
- `costPaidOutsideKentro` en Lemme → objetivo 0, con los asientos a 0 actuales → 0 movimientos.
- Prepagado → `payableNow` y aviso de saldo negativo; COD sin efectivo → `waitingCashCop`.
- `too_many_writes` a partir de 450.

**`product-cost-gaps.test.ts`** — RF_10 con las cuatro situaciones y la exclusion de inactivas.

**`product-cost-parity.test.ts`** — mismos pedidos y ficha por `resolveProductCostLinesForOrder` y por
`finance.ts:productCostLinesForOrder`: mismos productos y totales, incluido `costPaidOutsideKentro`
(principio 3). Y caracterizacion: sin overrides ni marcas nuevas, `resolveProductCostLinesForOrder` da
exactamente lo mismo que antes del refactor (fixtures de `finance.test.ts`).

**`spec-025-guards.test.ts`** (patron de `spec-018-guards.test.ts`, regex cortos):
- las cinco callables comprueban `role !== "admin"` antes de leer nada (RF_09);
- `product-cost-corrections.ts` no contiene `.update(` sobre `walletEntries` salvo el registro, ni
  `set(` con `merge` sobre asientos (2.6);
- los modulos nuevos no contienen `* quantity` ni `productCostCop *` (2.2);
- `firestore.rules` declara `productCostCorrections` con `allow write: if false`;
- `saveProduct` conserva `zeroCostIntended` y `costPaidOutsideKentro` al editar (si no, editar una ficha
  borraria la marca y el siguiente cierre volveria a descontar a LuminXP).

**Verificacion real (DoD 5).** `scripts/verify-025.js`: admin desechable + `signInWithPassword` REST
(`CLAUDE.md`), tienda y ficha de prueba, un pedido prepagado de prueba cerrado por la callable real;
preview → aplicar → leer asientos → revertir → comparar sumas; limpieza de todo lo de la tienda de
prueba. Evidencia en `.sdd/evidence/025/`. Nada con credenciales de servicio en la ruta de escritura
(RNF_02): el script solo usa ADC para crear y borrar la cuenta y la tienda desechables.

---

## 7. Trazabilidad

| Req | Modulos | Pruebas |
|---|---|---|
| RF_01 | `wallet-entries.ts`, `product-cost-correction-plan.ts` | plan: "coincide con el cierre"; parity; guarda sin aritmetica |
| RF_02 | `product-cost-correction-plan.ts`, `product-cost-corrections.ts` | plan: dryRun = aplicacion; guarda punto unico |
| RF_03 | `product-cost-ledger.ts`, plan | plan: pedido correcto → 0; KNT-004603 |
| RF_04 | ledger (suma), ids 2.7 | plan: reaplicar → 0 |
| RF_05 | plan (2.6) | plan: corte pagado sin update/delete; guarda sin merge |
| RF_06 | plan (un asiento, dos cuentas), registro, auditoria | plan: `bySupplier = −sellerDelta`; verify-025 lee la auditoria |
| RF_07 | `planProductCostRevert` | plan: aplicar+revertir, tres familias |
| RF_08 | `planProductCostCross` | plan: cruce con pedido, sin pedido bloquea |
| RF_09 | callables | guarda de rol; verify-025 con sesion no admin → 403 |
| RF_10 | `product-cost-gaps.ts`, `setProductCostPolicy` | gaps; guarda saveProduct |
| RNF_01 | callable 5.6 | medicion en verify-025 (tienda real de 400 pedidos, solo `dryRun`) |
| RNF_02 | callables (sesion admin) | verify-025 sin ADC en la ruta de escritura |

---

## 8. Dependencias nuevas

Ninguna. `zod` y `crypto` ya se usan en `functions/` (principio 2).

---

## 9. Tareas previas de datos (antes de escribir codigo)

**T0 — inventario de solo lectura** (`scripts/verify-025-inventory.js`): forma exacta de los asientos
del 30-09 (`productId`, `supplierId`, `orderId`, campos `retro*`); que asiento de costo sin `productId`
existe en pedidos con `lineItems` (cuantos pedidos quedarian bloqueados por 2.8); el `orderId` del
precedente `we-cruce-fletes-seller-…`; y si las consultas de 5.6 piden indice. Sus cifras ajustan las
fixtures de la seccion 6.

---

## 10. Orden de despliegue

1. **Indices** solo si T0 los pide; se anaden, nunca se reemplazan (comparar con
   `firebase firestore:indexes`).
2. **Reglas** (`productCostCorrections`): `firebase deploy --only firestore:rules --project kentro-last-mile`.
3. **Functions** — ojo: el cambio de `wallet-entries.ts` viaja con **todas** las que lo importan
   (`closeOrder`, `applyOrderTransition`, `correctOrderStatus`…). `cd functions && npm run build`,
   `firebase functions:list` == local, `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions`.
4. **Marca de Lemme** inmediatamente despues, por `setProductCostPolicy`, antes de que nadie corra una
   correccion sobre LuminXP (sin ella, una correccion volveria a cobrar los −23.000 revertidos).
5. **Hosting** cuando exista la interfaz: `npm run lint && npx vitest run && npx tsc --noEmit` (raiz y
   `functions/`), `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only hosting --project kentro-last-mile`.

Lo despliega y firma el responsable (principio 7).

---

## 11. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Refactor de `matchProductCostLines` cambia un cierre | Prueba de caracterizacion antes del refactor; la firma vieja sigue identica sin el tercer parametro |
| `costPaidOutsideKentro` mal puesto deja de descontar producto en cada cierre, en silencio | Callable auditada, `reason` obligatorio, RF_10 la lista en grupo aparte |
| Editar una ficha en `saveProduct` borra las marcas nuevas | Guarda de fuente + conservar campos al construir `item` |
| Asientos del 30-09 con forma distinta a la supuesta | T0 antes de las fixtures; lo inatribuible bloquea, no adivina |
| Correccion re-precia historia | Solo `productIds` elegidos (2.3) y el preview muestra fila a fila |
| Dos admins aplican a la vez | Ids numerados + `batch.create` (2.7) y huella |
| Mas de 450 escrituras | `blocker too_many_writes`; dividir por rango o `orderIds` |
| Ajuste en corte pendiente "salta" al siguiente | Aceptado (2.6); el preview lo dice con `existingInFrozenSettlement` y el estado del corte |
| El backfill del cliente (`buildMissingProductCostEntries`) sigue escribiendo con otra regla | P7; mientras exista, el planificador lo absorbe por suma |
| Prepagado deja a la tienda en negativo | `prepaid_negative_balance` visible antes de aplicar |

---

## 12. Pendiente de `/sdd-design`

No existe `specs/design/025/`. Necesitan entregable de diseno antes de `/sdd-tasks` las tareas de
interfaz (HU_01, HU_02, HU_03, RF_08, RF_10, marcas de ficha):
- donde vive el corrector (desde la ficha, desde la tienda, desde liquidaciones) y como se eligen
  productos, pedidos y overrides de linea;
- que muestra el preview (por pedido, por tienda, por proveedor; avisos y bloqueos; historia reconocida;
  pagable ahora vs esperando efectivo) y como se confirma;
- como se lista y revierte una correccion;
- formulario de cruce;
- listado RF_10 y las dos marcas;
- **textos**: `description` del asiento que ve la tienda en su corte (HU_04), mensajes de avisos y bloqueos.

El plan solo fija los datos que esas pantallas reciben (seccion 4.4).

---

## 13. Preguntas abiertas (bloquean el grill)

1. **Alcance de "costo vigente hoy" (RF_01).** El plan corrige solo los productos que el admin elige.
   ¿Se acepta, o la spec quiere re-preciar todo el pedido?
2. **Marca "paga por fuera".** ¿Por ficha (propuesto) o por par tienda-proveedor? ¿El cierre no emite
   asiento (propuesto) o emite uno en $0?
3. **Proveedor cambiado** entre lo cobrado y la ficha actual: ¿bloquear el pedido (propuesto) o mover la
   deuda de un proveedor a otro?
4. **Pedidos `liquidated`:** `buildWalletEntries` solo emite costo para `delivered`. ¿Quedan fuera del
   alcance (propuesto) o se tratan como entregados?
5. **Cruce siempre por pedido.** Un cruce sin pedido bloquea el corte de la tienda (`seller-balance.ts:199`).
   ¿Se exige pedido (propuesto)? ¿Y el precedente `we-cruce-fletes-seller-…` tiene `orderId`? (T0)
6. **Reversion:** ¿borrar el asiento si sigue abierto en las dos cuentas (propuesto) o compensar siempre
   para que quede rastro en la wallet?
7. **`buildMissingProductCostEntries`** (retro-cobro desde el navegador al guardar ficha, solo sobre la
   ventana descargada): ¿se retira y se sustituye por "abrir el corrector" (recomendado), o convive?
8. **Correcciones del 30-09:** ¿se pueden revertir desde la plataforma o, como dice la seccion 6, solo se
   reconocen? (El plan: solo se reconocen; para deshacerlas se corrige hacia el objetivo.)
9. **RF_10:** ¿por tienda (propuesto, acota lecturas) o todas las tiendas en una sola vista?
