# Plan tecnico — Spec 024: la comunidad puede ganar de la utilidad de Kentro, sin encarecer a sus tiendas

- **Spec:** `specs/024_reconocimiento_de_comunidad_que_paga_kentro.md` (**BORRADOR**, sin grill)
- **Fecha:** 2026-10-02
- **Estado del plan:** listo para revisar. El nucleo y los callables se pueden construir ya; la
  interfaz espera a `/sdd-design` (§9) y hay doce preguntas abiertas (§10). Cuatro de ellas (P1–P4)
  cambian datos que se escriben en produccion y deberian responderse antes de `/sdd-tasks`.

> **Sobre el stack por defecto.** No hay Prisma ni SQL: Next.js 16 + Firebase (Functions Node 20 +
> Firestore). Se respeta TypeScript estricto sin `any` nuevo (los `Record<string, any>` que ya existen
> en `wallet-entries.ts`/`orders.ts` no se amplian), Zod en el borde de cada callable nueva, nucleo
> puro separado de la red (principio 3) y pruebas sin red.

---

## 0. Lo que el codigo dice hoy (medido, no supuesto)

| Hecho | Donde | Consecuencia para el plan |
|---|---|---|
| El cashback sale de `order.communityPricing`, congelado **al crear** (`communityPricing.communityId`) | `wallet-entries.ts:117-150`, `community-order-pricing.ts` | El reconocimiento NO puede colgarse de ese sello: la spec quiere la comunidad **al cerrar** (caso limite 1, RF_08). Hace falta un sello propio, puesto al cerrar |
| La regla del fallido cobrable es una `const` local, no exportada | `wallet-entries.ts:207` | Se **exporta** como funcion (`isChargeableFailedVisit`) sin cambiar su cuerpo; el reconocimiento se emite dentro de `buildWalletEntries` y la reusa (RF_03) |
| Hay **tres** sitios que llaman a `buildWalletEntries` y escriben: `closeOrder` (`orders.ts:1213`), `classifyFailedOrder` (`orders.ts:659`, el paso `pending_review` -> `failed_visit`) y el planificador de correcciones (`order-corrections-plan.ts:354`). Un cuarto solo proyecta: `seller-retention.ts:69` | — | Los tres que escriben tienen que ver el reconocimiento. `classifyFailedOrder` es justo el caso limite "`pending_review` no causa hasta que se clasifique" |
| `closeOrder` escribe los asientos con `set(..., { merge: true })` y `withOpenSettlementFlags` pone `settlementId: ""` | `orders.ts:1214`, `wallet-entries.ts:271` | **Reescribir un asiento ya cortado le borra el corte** y se volveria a pagar. El reconocimiento es uno por pedido (P1), asi que un segundo cierre tras `retry_pending` NO debe reescribirlo: hay que filtrarlo leyendo antes (§3.2) |
| `getCommunityStats` suma **todos** los asientos `ownerType == community_leader` como "cashback causado", sin mirar `type` | `community-stats.ts:99-107` | En cuanto exista un asiento de reconocimiento, se sumaria al cashback: viola RF_06. Hay que separar por tipo |
| `pendingCommunityCashbackCop` (deuda de un acreedor) filtra `type === "community_cashback"` | `communities.ts:585-603` | Un lider retirado al que se le deba reconocimiento perderia el vinculo de acreedor. Debe contar ambos tipos |
| `buildCommunityLeaderLiquidationRows` y `buildAdminCommunityList` filtran `community_cashback` | `community-view.ts:337`, `:634` | Sin tocarlos, el admin nunca veria reconocimiento pendiente de girar |
| `computePlatformPosition` / `calculatePlatformPosition` ignoran por completo `ownerType == community_leader` | `platform-position.ts:47`, `finance.ts:863` | RF_10 se implementa anadiendo cifras a las dos copias; la prueba de igualdad ya existe (`platform-position.test.ts`) |
| El documento de comunidad no guarda cual es la tienda del lider (`leaderSellerId` solo existe en tipos del cliente; nadie lo escribe en `functions/`) | `community-view.ts:462` | La exclusion de la tienda del lider no puede inferirse: se declara como lista explicita en la configuracion (§2.1) |
| `reassignSellerCommunity` solo cambia `sellers/{id}.communityId` | `communities.ts:1058` | RF_08 sale gratis si el cierre lee `seller.communityId` en vivo: lo ya causado tiene `ownerId` fijo |
| Las comunidades no las escribe ningun cliente (`firestore.rules:168-171`) | — | La configuracion solo entra por callable de admin (RF_05) sin tocar reglas de `communities` |

---

## 1. Arbol de modulos

### Nuevos

| Archivo | Responsabilidad |
|---|---|
| `functions/src/community-recognition.ts` | **Nucleo puro.** Tipos de configuracion y sello; `validateRecognitionConfig` (limites); `stampRecognitionAtClose` (que sello lleva un pedido al cerrar); `recognitionEntryId`; `COMMUNITY_LEADER_ENTRY_TYPES`; `splitCommunityLeaderEntries` (cashback vs reconocimiento, para panel y deuda). No importa `wallet-entries` en valor (solo tipos), para no crear ciclo |
| `functions/src/community-recognition-backfill-plan.ts` | **Planificador puro** del relleno (RF_12): dado comunidad, tiendas, pedidos cerrados y asientos ya existentes, devuelve sellos, asientos a crear, omitidos con motivo, totales y (opcional) el corte "pagado a mano". Importa `buildWalletEntries` para no copiar la regla. `dryRun` y aplicacion recorren el mismo codigo (principio 10) |
| `functions/src/community-recognition-api.ts` | Callables `setCommunityRecognition` y `backfillCommunityRecognition`: permisos, Zod, lecturas, lotes, auditoria. Solo cableado |
| `src/lib/community-recognition.test.ts` | Pruebas del nucleo y de la emision via `buildWalletEntries` (RF_01–RF_04, RF_06, RF_08, RF_09, RNF_01, casos limite) |
| `src/lib/community-recognition-backfill.test.ts` | Pruebas del planificador de relleno (RF_12, caso limite de la liquidacion manual) |
| `src/lib/spec-024-guards.test.ts` | Guardas de fuente (§4.3) sobre el cableado que no se puede ejecutar sin `firebase-admin` |
| `scripts/verify-024.js` | Guion de un solo uso para el DoD 5: compara, por sesion real de lider (canal del cliente), las cifras del panel con 144/$144.000 y 360/$360.000. Lo lanza una persona (principio 7) |

### Modificados

| Archivo | Cambio |
|---|---|
| `functions/src/wallet-entries.ts` | Exporta `isChargeableFailedVisit(order)` (mismo cuerpo que la `const` de hoy). `buildWalletEntries` emite el asiento `community_recognition` a partir de `order.communityRecognition`. `isLiquidationWalletType` incluye el tipo nuevo |
| `functions/src/settlement-math.ts` | `WalletEntryDoc["type"]` suma `"community_recognition"` y un `sellerId?` opcional. `SettlementDoc` y `SettlementTotals` ganan `communityCashbackCop?` / `communityRecognitionCop?` (desglose del corte de lider) |
| `functions/src/orders.ts` | `closeOrder`: lee `sellers/{sellerId}`, `communities/{communityId}` y el asiento de reconocimiento existente **dentro** de la transaccion, antes de escribir; aplica `stampRecognitionAtClose` y filtra el asiento ya causado. `classifyFailedOrder`: misma lectura/filtro. `createSettlement`: escribe el desglose para `kind == community_leader` |
| `functions/src/order-corrections.ts` | Carga los asientos `community_recognition` de la comunidad en `cashInputs.leaderEntries` (hoy carga los del lider por `ownerType`, se verifica que el tipo nuevo entra) |
| `functions/src/order-corrections-plan.ts` | Sin cambio de logica: el reconocimiento entra en `canonical` porque lo emite `buildWalletEntries`. Solo el parche de cortes de lider anade el desglose (`settlementTotals`) |
| `functions/src/community-stats.ts` | Deja de hacer `sum()` ciego: lee los asientos del lider del periodo (mismo indice de hoy) y los parte con `splitCommunityLeaderEntries` |
| `functions/src/community-stats-math.ts` | `RawCommunityAggregates` y `CommunityStats.totals` ganan `recognitionAccruedCop`, `recognitionPaidCop`, `recognitionPendingCop`, `recognizedOrders`. Metrica nueva `"recognition"` con eje `closed` sobre `walletEntries` |
| `functions/src/communities.ts` | `pendingCommunityCashbackCop` cuenta los tipos de `COMMUNITY_LEADER_ENTRY_TYPES` (renombrar a `pendingCommunityLeaderCop`) |
| `functions/src/community-access.ts` | `canSetCommunityRecognition(actor)` y `canBackfillCommunityRecognition(actor)`: solo `admin` (RF_05) |
| `functions/src/platform-position.ts` + `src/lib/finance.ts` | Tres cifras nuevas en las dos copias (§3.5) |
| `functions/src/order-import-merge.ts` | `IMPORT_WRITE_EXEMPTIONS` anade `community-recognition-api.ts` (el relleno escribe el sello en pedidos cerrados) con su razon. Ninguna via de importacion emite `communityRecognition`, asi que el `merge` nunca lo toca |
| `functions/src/index.ts` | Exporta las dos callables nuevas |
| `src/lib/types.ts` | `WalletEntry["type"]` + `"community_recognition"`; `Order.communityRecognition?`; `Community.recognition?`; campos de desglose en `Settlement`; `PlatformPosition` con las cifras nuevas |
| `src/lib/community-view.ts` | `communityCashbackPaidCop`/`OwedCop` pasan a devolver el desglose por concepto (cortes viejos sin desglose = todo cashback, que es cierto: el reconocimiento no existia). `buildCommunityLeaderLiquidationRows` y `buildAdminCommunityList` incluyen el tipo nuevo, separado |
| `src/lib/firebase/auth.ts` | Wrappers tipados de las dos callables |
| `src/components/operations-app.tsx` | **Solo tras `/sdd-design`** (§9). Lo unico no visual que se puede hacer antes: anadir el tipo a los dos mapas de rotulos (`:3122`, `:10485`) para que no salga el identificador crudo; el texto exacto lo decide diseno |
| `firestore.rules` | Verificar que ningun cliente (tampoco admin por escritura directa) puede escribir `orders.communityRecognition`; si el admin tiene `update` libre sobre `orders`, anadir la clave a las prohibidas |
| `docs/constitution.md` | Nada nuevo; se cita el principio 9 en el modulo. (Si P7 se resuelve "restar tambien el cashback", se documenta ahi) |

**Lo que NO se toca:** `community-pricing.ts` y el calculo del cashback (fuera de alcance), lo que paga
la tienda, el domiciliario y el costo de producto (RF_02), `seller-retention.ts` (proyecta solo
asientos de tienda; se anade una prueba que lo confirma), y las vias de importacion.

---

## 2. Modelo de datos

### 2.1 Configuracion en la comunidad (`communities/{id}.recognition`)

```ts
/** Lo que el admin fija. Ausente o `amountCop === 0` = la comunidad no reconoce nada. */
export type CommunityRecognitionConfig = {
  /** Pesos enteros por pedido. 0 < amountCop <= RECOGNITION_MAX_COP. */
  amountCop: number;
  /**
   * Tiendas cuya comunidad es esta pero que NO causan reconocimiento. Existe porque la tienda del
   * lider no se puede inferir del documento (no hay `leaderSellerId` en servidor) y la liquidacion
   * manual de ADMA excluyo a ADMA COMERCIAL. Lista explicita, decidida por una persona (P2).
   */
  excludedSellerIds: string[];
  updatedAt: string;
  updatedBy: string; // uid del admin
};

export const RECOGNITION_MAX_COP = 12_000; // provisional, ver P9: nunca mas que la tarifa base de entrega

/** Historial: subcoleccion `communities/{id}/recognitionHistory/{autoId}`. Nunca se edita. */
export type RecognitionHistoryEntry = {
  fromAmountCop: number | null;
  toAmountCop: number | null;      // null = se quito
  excludedSellerIds: string[];
  actorUid: string;
  createdAt: string;
};
```

### 2.2 Sello en el pedido (`orders/{id}.communityRecognition`)

```ts
/**
 * Que comunidad y que valor regian AL CERRAR (RF_04, RF_08, RNF_01). Lo escribe el servidor al
 * cerrar (o el relleno). `null` = se evaluo y no aplica (sin comunidad, sin valor, tienda excluida).
 * Ausente = pedido cerrado antes de la spec y no rellenado.
 */
export type RecognitionStamp = {
  communityId: string;
  amountCop: number;
  stampedAt: string;
  /** "close" | "classify" | "backfill": por que puerta entro. Trazabilidad (RNF_01). */
  source: "close" | "backfill";
};
```

El sello se escribe en **todo** cierre terminal (entregado o fallido de cualquier categoria) cuando la
comunidad tiene valor, no solo cuando el resultado es cobrable. Asi una correccion posterior
(fallido no cobrable -> entregado) encuentra el valor y la comunidad del cierre sin volver a mirar
la configuracion viva, y `pending_review` -> `failed_visit` (via `classifyFailedOrder`) causa con lo
que regia al cerrar, no al clasificar.

### 2.3 Asiento

```ts
// Emitido por buildWalletEntries. Id deterministico, UNO por pedido (P1).
{
  id: `we-${order.id}-community-recognition`,
  ownerType: "community_leader",
  ownerId: stamp.communityId,
  orderId: order.id,
  sellerId: order.sellerId,                  // desglose por tienda y trazabilidad (RNF_01)
  type: "community_recognition",
  amountCop: stamp.amountCop,                // > 0 siempre; con 0 no se emite (caso limite)
  description: `Reconocimiento comunidad ${order.shopifyOrderId}`,
  createdAt: now,
  settlementId: ""                           // withOpenSettlementFlags
}
```

Reversa de correccion: la produce `reversalEntryFor` sin cambios
(`we-{orderId}-correction-reverse-community-recognition`, mismo `type`, importe negativo).

### 2.4 Desglose del corte de lider

```ts
// SettlementDoc / Settlement (opcionales: los cortes viejos no los tienen)
communityCashbackCop?: number;     // suma neta de asientos community_cashback del corte
communityRecognitionCop?: number;  // suma neta de asientos community_recognition del corte
// Invariante probado: communityCashbackCop + communityRecognitionCop === grossNetCop del corte.
```

### 2.5 Panel del lider y posicion

```ts
// community-stats-math.ts
type RawCommunityAggregates = { /* ...lo de hoy... */
  recognitionAccruedCop: number;
  recognitionPaidCop: number;      // lo completa el cliente con sus cortes, como el cashback
  recognizedOrders: number;        // asientos positivos - reversas, en el periodo
};

// platform-position.ts y finance.ts (las dos copias)
type PlatformPosition = { /* ...las quince de hoy... */
  communityRecognitionCop: number;        // todo lo causado, neto de reversas
  paidCommunityRecognitionCop: number;    // en cortes paid/reconciled
  payableCommunityRecognitionCop: number; // causado y aun no pagado (RF_10, pasivo)
};
```

### 2.6 Callables (borde, Zod)

```ts
const setRecognitionSchema = z.object({
  communityId: z.string().trim().min(1),
  amountCop: z.number().int().min(0).max(RECOGNITION_MAX_COP), // 0 = quitar
  excludedSellerIds: z.array(z.string().trim().min(1)).max(100).default([])
});

const backfillSchema = z.object({
  communityId: z.string().trim().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dryRun: z.boolean().default(true),
  /** Registrar lo causado como YA PAGADO a mano (liquidaciones del 29/30-09). Ver §3.6 y P3. */
  manualPayment: z.object({
    expectedOrders: z.number().int().positive(),
    expectedAmountCop: z.number().int().positive(),
    paidAt: z.string().datetime(),
    note: z.string().trim().min(1).max(500)
  }).optional()
});
```

Respuestas tipadas (`RecognitionBackfillPlan`, §3.6); errores como `HttpsError` con mensaje en
espanol, siguiendo `communities.ts`.

---

## 3. Algoritmos criticos

### 3.1 `stampRecognitionAtClose` (puro)

Entrada: `{ order, seller: { id, communityId? } | null, community: { id, status?, recognition? } | null,
alreadyCaused: boolean, nextStatus, now }`. Salida: `{ kind: "keep" } | { kind: "set", stamp: RecognitionStamp | null }`.

1. `nextStatus` no terminal (reagendado -> `retry_pending`): `keep` (no se toca nada).
2. `alreadyCaused` (ya existe `we-{id}-community-recognition`): `keep`. El pedido ya reconocio con su
   comunidad y valor; re-sellar tras un reintento haria que una correccion posterior viera un sello
   distinto del asiento y lo compensara (RF_09, RF_04).
3. Sin `seller.communityId`, sin comunidad, `community.status !== "active"` (P6), sin
   `recognition` o `amountCop <= 0`, o `seller.id` en `excludedSellerIds`: `set(null)`.
4. Si no: `set({ communityId: community.id, amountCop: recognition.amountCop, stampedAt: now, source: "close" })`.

La comunidad sale de `seller.communityId` **leido al cerrar**, no de `order.communityId` (que es el de
creacion). Consecuencia declarada: un pedido creado en A y cerrado tras pasar la tienda a B da
cashback a A (si A tenia precio) y reconocimiento a B (P8).

### 3.2 Cableado en `closeOrder` (idempotencia)

Dentro de `db.runTransaction`, en la fase de lecturas (todas antes de cualquier escritura):

1. Las lecturas de hoy (pedido, ajustes, zona, inventario, catalogo).
2. `sellers/{order.sellerId}` y `walletEntries/we-{orderId}-community-recognition` en paralelo.
3. Si la tienda tiene `communityId`: `communities/{communityId}`. (Segunda ronda; +2/3 lecturas en la
   ruta caliente del domiciliario, ver riesgos.)
4. `decision = stampRecognitionAtClose(...)`. Si `set`, `nextOrder.communityRecognition = decision.stamp`.
5. `buildWalletEntries(nextOrder, ...)` — el asiento sale del sello, sin parametro nuevo.
6. **Filtro**: si el asiento existia, se quita de la lista a escribir (`filterAlreadyCausedRecognition`,
   puro, en `community-recognition.ts`). Es lo que hace imposible el doble reconocimiento por
   reintento de red o por segundo cierre tras `retry_pending`, y lo que evita que el `set(merge)`
   devuelva a `settlementId: ""` un asiento ya cortado.

`classifyFailedOrder` hace 2, 6 (y no 3–4: usa el sello del cierre). Si el pedido no tiene sello
(cerrado antes del despliegue), no causa: no se infiere comunidad a posteriori fuera del relleno.

### 3.3 Emision en `buildWalletEntries`

```
stamp = order.communityRecognition
if stamp && stamp.amountCop > 0 && (order.status === "delivered" || isChargeableFailedVisit(order)):
    push asiento §2.3
```

Usa la misma `isChargeableFailedVisit` que decide el flete de fallido (RF_03): `failed_visit` o
categoria ausente, en positivo; `pending_review` y los tres no cobrables no causan. No depende del
importe del flete (P11). No modifica `values` ni ningun otro asiento (RF_02).

### 3.4 Correcciones (RF_07)

Sin logica nueva: `planOrderCorrection` compara `canonical` (que ya trae el reconocimiento) contra lo
que existe.
- entregado -> fallido no cobrable: el asiento sobra; si su corte esta pagado se compensa con la
  reversa en periodo abierto, si esta pendiente se borra y el corte se recalcula (con desglose).
- fallido no cobrable -> entregado: el sello del cierre ya esta en el pedido; el asiento se crea.
- entregado <-> fallido cobrable: mismo id y mismo importe -> `entriesToKeep`.
- fallido -> nueva visita: no mueve dinero (regla 5). Al volver a cerrar, §3.2 paso 2 conserva.
- Pedido sin sello (anterior a la spec, no rellenado): no causa en la correccion. Declarado.

### 3.5 Posicion de la plataforma (RF_10)

En las dos copias, sobre `wallet.filter(ownerType === "community_leader" && type === "community_recognition")`:
- `communityRecognitionCop = sum(todos)` (neto de reversas).
- `paidCommunityRecognitionCop = sum(los de corte paid/reconciled)`.
- `payableCommunityRecognitionCop = communityRecognitionCop - paidCommunityRecognitionCop`.
- `profitCop = feesCop - driverPayCop - communityRecognitionCop`.
- `cashCop -= paidCommunityRecognitionCop` (sale de caja cuando se paga).
- `liabilitiesCop += payableCommunityRecognitionCop`.

El cashback del lider sigue fuera de la posicion, igual que hoy (hueco previo: P7).

### 3.6 Relleno (RF_12) — `planRecognitionBackfill`

Entrada: comunidad (con `recognition` vigente), tiendas **actuales** de la comunidad (P4), pedidos
`delivered`/`failed` de esas tiendas, ids de asientos de reconocimiento ya existentes, rango, `now`,
`manualPayment?`.

1. Instante de cierre por pedido: `closedAt ?? ultima evidencia ?? updatedAt` (P5: los pedidos
   anteriores a `closedAt` no lo tienen). Fuera de rango -> omitido `out_of_range`.
2. Omitidos con motivo: `already_caused` (id existe — esto hace el relleno re-ejecutable),
   `excluded_seller`, `not_chargeable` (incluye `pending_review`), `no_value`.
3. Para el resto: sello `{ source: "backfill", amountCop: config vigente }` y asiento con
   `buildWalletEntries({...order, communityRecognition: sello}, ...)` filtrado a `type === "community_recognition"`
   (no se copia la regla; los demas asientos del resultado se descartan, ya existen).
4. Con `manualPayment`: **bloqueo** si `count !== expectedOrders` o `total !== expectedAmountCop`
   (el plan devuelve la lista para cuadrar a mano). Si cuadra, el plan anade un corte
   `kind: "community_leader", status: "paid", paidAt, note, gmfCop: 0` (P3) con todos los
   `walletEntryIds`, y cada asiento nace con ese `settlementId`. Asi lo pagado a mano queda causado Y
   pagado en el libro: el lider ve "pagado $144.000", la posicion no lo cuenta como pasivo, y el id
   por pedido impide reconocerlo otra vez (RF_09) — sin listas de exclusion paralelas.
5. Salida `RecognitionBackfillPlan = { stamps, entries, settlement?, skipped: Record<motivo, string[]>, totals: { orders, amountCop }, blockers }`.

Aplicacion: el callable con `dryRun: false` recalcula el mismo plan y escribe en lotes de <= 400
operaciones, **pedido + asiento siempre en el mismo lote**, y el corte manual en el **primer** lote
(con la lista completa) para que un fallo a mitad nunca deje asientos de un pago manual sin
`settlementId` (se pagarian otra vez). Un segundo intento omite lo ya escrito por `already_caused`.
Audita en `auditEvents` un unico evento resumen por corrida.

Uso previsto: ADMA con `manualPayment` para 27/04–29/09 (144 / $144.000) y LAB igual (360 / $360.000);
luego cada una sin `manualPayment` desde 30/09 hasta el dia del despliegue.

### 3.7 Panel del lider (RF_11)

`getCommunityStats` cambia `sum()` por la lectura de los asientos del lider en el periodo (mismo
filtro e indice que hoy: `ownerType`, `ownerId`, `createdAt`) y `splitCommunityLeaderEntries`:
cashback causado, reconocimiento causado y `recognizedOrders` = asientos de reconocimiento con
importe > 0 menos los < 0. Leer documentos cuesta lecturas en servidor (cientos al mes por
comunidad), no descarga en el navegador (principio 11). Lo pagado lo completa el cliente con el
desglose de sus cortes.

---

## 4. Estrategia de testing

Vitest solo recoge `src/**/*.test.ts`; el codigo de `functions/` se importa como
`../../functions/src/<modulo>`. Sin red, sin reloj (`now` como dato).

### 4.1 Nucleo — `src/lib/community-recognition.test.ts`

| Requisito | Prueba |
|---|---|
| RF_01 | Entregado con sello $1.000 -> un asiento `community_recognition` de 1.000 a la comunidad |
| RF_01, RF_03 | Fallido `failed_visit` y fallido sin categoria causan; `no_coverage`, `bad_order_or_no_contact`, `bad_phone` y `pending_review` no (DoD 1) |
| RF_03 | Guarda de fuente: `community-recognition*.ts` no contiene el literal `failed_visit`; `buildWalletEntries` usa `isChargeableFailedVisit` en los dos sitios (flete y reconocimiento) |
| RF_02 | Mismo pedido con y sin sello: asientos de tienda, domiciliario y producto identicos campo a campo (DoD 2), con y sin `communityPricing`, entregado y fallido |
| RF_04 | `stampRecognitionAtClose` toma el valor de la config pasada; cambiar la config despues no altera un asiento construido desde el sello guardado |
| RF_06 | Pedido con cashback y reconocimiento: dos asientos de tipos distintos; `splitCommunityLeaderEntries` los separa |
| RF_08 | Pedido con `communityId` A (creacion) y tienda hoy en B -> sello B; asiento de cashback sigue con A |
| RF_09 | `alreadyCaused` -> `keep`; `filterAlreadyCausedRecognition` quita el asiento; dos cierres (fallido cobrable, `retry_pending`, entregado) -> un solo asiento (DoD 3) |
| Casos limite | Sin valor o `amountCop: 0` -> ni asiento ni renglon en 0; tienda en `excludedSellerIds` -> `set(null)`; comunidad desactivada -> `set(null)` (provisional, P6); reagendado -> `keep` |
| RNF_01 | El asiento lleva `orderId`, `ownerId` (comunidad), `sellerId` e importe; el pedido lleva `stampedAt` y `source` |
| RF_05 | `canSetCommunityRecognition`/`canBackfillCommunityRecognition`: admin si; lider, acreedor, tienda, mensajero no |
| `validateRecognitionConfig` | Enteros, tope, lista sin duplicados |

### 4.2 Otros modulos puros

| Archivo | Requisito | Prueba |
|---|---|---|
| `src/lib/order-corrections-plan.test.ts` (ampliar) | RF_07 | entregado->fallido no cobrable con corte pagado: reversa `-correction-reverse-community-recognition`; con corte pendiente: borrado y corte recalculado con desglose; fallido no cobrable->entregado: crea; entregado<->fallido cobrable: conserva; `dryRun` == aplicacion |
| `src/lib/settlement-math.test.ts` (ampliar) | RF_09, RF_06 | `isLiquidationWalletType("community_recognition")`; desglose del corte suma `grossNetCop` |
| `src/lib/platform-position.test.ts` (ampliar) | RF_10, RNF_02 | Escenario con reconocimiento pagado, pendiente y revertido: cliente == servidor (DoD 4); `profitCop` baja exactamente lo causado; el pasivo es lo no pagado |
| `src/lib/community-stats.test.ts` (ampliar) | RF_11, RF_06 | `buildCommunityStats` con los dos conceptos: separados, pendientes = causado - pagado, `recognizedOrders` neto de reversas |
| `src/lib/community-view.test.ts` (ampliar) | RF_06, RF_09, RF_11 | Filas de liquidacion incluyen reconocimiento pendiente y lo separan; cortes viejos sin desglose cuentan como cashback; pagado/adeudado por concepto |
| `src/lib/community-recognition-backfill.test.ts` | RF_12 | Omite `already_caused` (re-ejecucion = cero escrituras); bloquea si `manualPayment` no cuadra; si cuadra, todos los asientos nacen con el `settlementId` del corte pagado y el corte va en el primer lote; pedidos sin `closedAt` usan el respaldo; `pending_review` omitido |
| `src/lib/seller-charges.test.ts` o `seller-retention.test.ts` | RF_02 | La retencion de la tienda no cambia con sello |

### 4.3 Guardas de fuente — `src/lib/spec-024-guards.test.ts`

Leen las fuentes sin comentarios (patron de `spec-005/017-guards`):
1. `closeOrder` y `classifyFailedOrder` leen el asiento de reconocimiento **dentro** de la transaccion
   y llaman a `filterAlreadyCausedRecognition` antes del bucle de `set`.
2. `closeOrder` llama a `stampRecognitionAtClose` con la tienda leida en la transaccion (no con
   `order.communityId`).
3. `setCommunityRecognition` y `backfillCommunityRecognition` usan `actorFrom` + `canSet…`/`canBackfill…`
   y `safeParse` antes de leer nada.
4. `community-stats.ts` ya no agrega `sum("amountCop")` sin separar por tipo.
5. `pendingCommunityLeaderCop` usa `COMMUNITY_LEADER_ENTRY_TYPES`, no un literal.
6. `IMPORT_WRITE_EXEMPTIONS` declara `community-recognition-api.ts` con razon (y la guarda 1 de la 017
   sigue en verde).
7. En el callable de relleno el corte manual se anade al primer lote.

### 4.4 Canal del cliente (DoD 5)

`scripts/verify-024.js`: sesion real del lider de ADMA y de LAB (usuario desechable con los reclamos
del rol, como `verify-019-session.js`) leyendo `getCommunityStats` + sus cortes para 27/04–29/09:
debe dar 144 / $144.000 y 360 / $360.000 causado y pagado. No corre en la suite.

### 4.5 Mutaciones a dejar en `.sdd/evidence/024/`

- Quitar el filtro de §3.2 paso 6 -> cae RF_09.
- Copiar la regla del fallido como `failedCategory !== "pending_review"` -> cae RF_03 (pending y no cobrables).

---

## 5. Dependencias nuevas

**Ninguna.** Zod ya esta en `functions/`; todo lo demas es TypeScript sobre lo existente.

---

## 6. Indices

- Panel del lider: reusa `walletEntries (ownerType, ownerId, createdAt)`, que ya usa la consulta de hoy.
- Relleno: `orders where sellerId == X and status in [delivered, failed]`. Comprobar con
  `firebase firestore:indexes` si existe `(sellerId, status)`; si no, **anadirlo** al archivo sin
  quitar nada (comparar contra produccion antes: desplegar borra los que falten).
- `closeOrder` lee por id: sin indice.

---

## 7. Orden de despliegue

1. **Indices** (solo si §6 lo pide), esperar `READY`.
2. **Reglas** (si §1 `firestore.rules` exige cambio).
3. **Functions** completas (`cd functions && npm run build`, `firebase functions:list` == local,
   `ALLOW_FUNCTIONS_DEPLOY=1`): cambian `closeOrder`, `classifyFailedOrder`, `correctOrderStatus`,
   `createSettlement`, `getCommunityStats`, `getPlatformPosition`, `revokeCommunityLeadership` y nacen
   las dos nuevas. Con ninguna comunidad configurada, el comportamiento es identico al de hoy.
4. **Hosting** (`ALLOW_FUNCTIONS_DEPLOY=1`, `npm run lint` antes; `static{` = 0): el cliente tiene que
   entender el tipo nuevo **antes** de que exista el primer asiento.
5. **Configurar** ADMA y LAB ($1.000, exclusiones segun P2) desde la pantalla o la callable.
6. **Relleno**: `dryRun` de cada comunidad; cuadrar contra 144/360; aplicar con `manualPayment`;
   luego el tramo 30/09 -> hoy sin `manualPayment`. Los cierres entre 5 y 6 no se duplican
   (`already_caused`).
7. `verify-024.js` y firma humana (principio 7).

---

## 8. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Doble pago por reescribir un asiento ya cortado (`set(merge)` + `settlementId: ""`) | Uno por pedido + filtro de §3.2 leyendo dentro de la transaccion + guarda 1 + mutacion |
| El panel del lider mezcla cashback y reconocimiento (hoy suma todo) | §3.7 + guarda 4 + prueba en `community-stats.test.ts` |
| Latencia en `closeOrder` (ruta caliente del domiciliario): +1 ronda de lecturas | Las lecturas de tienda y asiento van en paralelo con las de hoy; la de comunidad solo si hay `communityId`. Medir A/B intercalado (memoria del repo) antes de firmar |
| Relleno parcial deja asientos de un pago manual sin corte -> se pagarian otra vez | Corte en el primer lote, pedido+asiento en el mismo lote, re-ejecucion idempotente |
| La membresia de ADMA cambio tres veces; el relleno con tiendas actuales no cuadra con 144/360 | `manualPayment` bloquea si no cuadra y devuelve la lista; la decision vuelve a una persona (P3, P4) |
| Pedidos viejos sin `closedAt` caen fuera del rango o en otro dia | Respaldo de §3.6 paso 1 + P5; el `dryRun` muestra cuantos usaron respaldo |
| Lider retirado pierde el vinculo de acreedor con reconocimiento pendiente | `pendingCommunityLeaderCop` cuenta ambos tipos |
| Fallo previo, fuera de alcance pero del mismo modulo: `we-{id}-community-cashback-failed` no lleva sufijo de visita, y un segundo fallido cobrable con `set(merge)` le borraria el `settlementId` al primero | Se reporta; no se corrige aqui (spec aparte) |

---

## 9. Pendiente de `/sdd-design` (`specs/design/024/`)

No se decide aqui disposicion, textos ni flujo. Hacen falta:
1. **Admin, ficha de comunidad:** fijar/cambiar/quitar el valor y la lista de tiendas excluidas; ver
   el historial (HU_01, RF_05).
2. **Admin, relleno:** elegir rango, previsualizacion (cuenta, total, omitidos por motivo, bloqueos),
   opcion de registrar pago manual y confirmar (RF_12).
3. **Lider, panel:** pedidos reconocidos, causado, pagado y pendiente del reconocimiento por periodo,
   separado del cashback (HU_02, RF_06, RF_11).
4. **Admin, posicion de la plataforma:** como se muestran las tres cifras nuevas y la utilidad neta (HU_04, RF_10).
5. **Admin, liquidaciones de lider y wallet:** fila y corte con los dos conceptos separados; rotulo del tipo nuevo (RF_06, RF_09).

Los callables y el nucleo se construyen sin esperar; la UI (T de `operations-app.tsx`) queda bloqueada
hasta tener esos entregables.

---

## 10. Preguntas abiertas

- **P1 (bloquea el modelo).** Fallido cobrable que se reabre y luego se entrega (o falla otra vez):
  ¿un reconocimiento por **pedido** (propuesta, y es lo que dice RF_09 literal) o uno por **visita
  cobrada**, como el flete? Cambia el id del asiento.
- **P2.** ¿Se excluyen los pedidos de la propia tienda del lider? El plan da el mecanismo
  (`excludedSellerIds`) pero no el valor por defecto. ¿ADMA COMERCIAL tiene hoy `communityId` = ADMA
  (la memoria dice "lider, no miembro")?
- **P3 (bloquea el relleno).** ¿Registrar las liquidaciones manuales como corte **pagado** dentro del
  libro (propuesta) o solo con una fecha de corte por comunidad que el relleno no cruza? Si es corte
  pagado: ¿se retuvo 4x1000 en esos pagos? ¿existe la lista de los 504 pedidos (el generador quedo en
  un scratchpad no versionado)?
- **P4.** El relleno atribuye pedidos viejos a la comunidad **actual** de la tienda (no hay historial
  de membresia). ¿Correcto? La liquidacion manual cubrio desde 27/04, antes de que la comunidad existiera.
- **P5.** Pedidos cerrados sin `closedAt`: ¿vale el respaldo ultima evidencia -> `updatedAt`?
- **P6.** Comunidad desactivada o sin lider: ¿causa reconocimiento (a favor de un acreedor) o no?
  Provisional: solo `status === "active"`.
- **P7.** La posicion hoy tampoco descuenta el **cashback** del lider ni lo pagado a lideres de la
  caja. ¿Se corrige en esta spec (seria cambiar el cashback de pantalla, fuera de alcance segun §6 de
  la spec) o en otra?
- **P8.** Tienda que cambia de comunidad entre crear y cerrar: cashback a la de creacion,
  reconocimiento a la de cierre. ¿Aceptable?
- **P9.** Tope del valor por pedido (provisional $12.000) y si puede ser 0 para "pausar" sin borrar.
- **P10.** Dias en UTC o en hora de Colombia para "hasta el 2026-09-29": los cortes hoy cortan por
  `createdAt.slice(0,10)` (UTC).
- **P11.** "Fallido con flete cobrado": ¿basta la categoria cobrable (propuesta, misma regla de RF_03)
  o hace falta ademas que el flete cobrado sea > 0?
- **P12.** ¿El lider debe ver su reconocimiento por tienda (como el desglose de la tienda del lider en
  el cashback) o solo el total?
