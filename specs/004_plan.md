# Plan tecnico — Spec 004: la base de una comunidad es lo que Kentro cobra de verdad

- **Spec:** `specs/004_base_de_comunidad_real.md` (aprobada 2026-09-11)
- **Fecha:** 2026-09-11

## 0. Diagnostico en el codigo (lo que la spec describe, localizado)

| Hueco | Donde esta hoy |
|---|---|
| El fallido fijo de $12.000 vive en el cierre, no en la base | `functions/src/wallet-entries.ts:151-158` (`sellerFailedFeeCop: 12000` tras el spread) |
| Segunda copia del mismo fijo en la app | `src/lib/finance.ts:38-62` (`applySellerTariffOverrides`) |
| La base de comunidad sale de los ajustes crudos | `resolveTariffs(settings, zone)` sin el fijo en `community-order-pricing.ts:60`, `communities.ts:845-846` (validacion del lider, **sin siquiera `resolveTariffs`**) y `communities.ts:1105` ("Tu tarifa") |
| La base se congela al crear y el cashback sale de lo congelado | `freezeOrderPricing` + `cashbackForFrozenPricing` (`community-pricing.ts:152-190`) |
| RF_35 escucha un documento que no existe | `community-floor-trigger.ts:22` escucha `settings/app`; produccion solo tiene `settings/global` (medido 2026-09-11), que es el que escriben el navegador (`state-store.ts:26`) y leen todos los cierres |
| RF_35 compara ajustes crudos | `planFloorRaise` -> `tariffFromSettings` (`community-pricing.ts:492`) |
| El panel del admin pinta el precio guardado o el ajuste crudo | `buildAdminCommunityList` -> `communityPriceOr` (`community-view.ts:431-545`) y JSX `operations-app.tsx:4816-4820` |

Datos de produccion al 2026-09-11: `settings/global` = entrega 12.000 / **fallido 9.000** / manejo
2.000; las tres zonas = 12.000 / 12.000 / 2.500; una comunidad (E-master) con `pricing: {}`;
**0 pedidos con `communityId`** y **0 asientos `community_cashback`**. No hay historico que migrar.

## 1. Arbol de modulos

### Nuevo

- **`functions/src/seller-charges.ts`** — PURO, sin imports. La unica copia de "cuanto cobra
  Kentro a una tienda por un pedido". Contiene: `defaultSettings`, `tariffFields`,
  `resolveTariffs` (movida desde `wallet-entries.ts`), las constantes DANDA, `dandaDeliveredFeeCop`
  (movida), `SELLER_FAILED_FEE_FIXED_COP = 12000`, `resolveSellerCharges` y `communityBase`.
  Sin `firebase-admin` porque la importa tambien la app (mismo patron que `community-access.ts`).
- **`functions/src/community-floor-writer.ts`** — traduce un `CommunityFloorRaise` a un batch de
  Firestore (update + `FieldValue.delete()` + entradas de `priceHistory`). Lo usan el trigger (RF_13)
  y la pasada unica (RF_14): una sola forma de escribir una elevacion.
- **`scripts/raise-community-floors.js`** — RF_14. En seco por defecto, `--apply` para escribir.
  Carga el codigo puro compilado de `functions/lib/` (hay que `npm run build` antes; lo dice su
  cabecera y falla con mensaje claro si falta).
- **`scripts/smoke-004.js`** — DoD 5. Pasos separados (`count`, `create`, `close`, `check`,
  `cleanup`), cada uno idempotente a partir de los ids que imprime el anterior. Solo se ejecuta
  tras el despliegue firmado por el humano.
- **`src/lib/seller-charges.test.ts`** — pruebas del modulo nuevo y guardas de fuente de RF_02.

### Modificados

- **`functions/src/wallet-entries.ts`** — `buildWalletEntries` obtiene los valores de
  `resolveSellerCharges`; para pedidos de comunidad cobra y causa con `communityChargeAtClose`.
  Reexporta `resolveTariffs`, `defaultSettings`, `tariffFields`, `dandaDeliveredFeeCop` para no
  romper a sus importadores actuales.
- **`functions/src/community-pricing.ts`** — `FrozenPricing` gana el precio propio del lider y un
  marcador de version; `freezeOrderPricing` lo registra; `cashbackForFrozenPricing` se sustituye
  por `communityChargeAtClose`; `planFloorRaise` compara bases reales y se parte en
  `raisedCommunityFloors` + `planRaiseToFloors`.
- **`functions/src/community-order-pricing.ts`** — base = `communityBase(resolveTariffs(settings, zone))`;
  deja de definir su propio conjunto de tiendas con tarifa especial e importa el de `seller-charges`.
- **`functions/src/communities.ts`** — `scheduleCommunityPrice` valida contra la base sin zona
  real (RF_05) con mensaje que nombra la base y el aviso de zona (RF_12); `getMyStoreTariff` pasa la
  base real a `buildStoreTariffView` (RF_10).
- **`functions/src/community-floor-trigger.ts`** — escucha `settings/global` (RF_13) y escribe via
  `community-floor-writer.ts`.
- **`src/lib/finance.ts`** — borra `applySellerTariffOverrides` y sus constantes DANDA; usa
  `resolveTariffs` + `resolveSellerCharges` importados de `functions/src/seller-charges`.
- **`src/lib/types.ts`** — `OrderCommunityPricing` refleja los campos nuevos (opcionales).
- **`src/lib/community-view.ts`** — `buildAdminCommunityList` calcula por concepto lo cobrado hoy,
  la base, el margen, el rotulo, el motivo (sin lider / desactivada) y la subida pendiente
  (RF_07, RF_08, RF_09, RF_15). Exporta `ZONE_BASE_NOTICE` (RF_12).
- **`src/components/operations-app.tsx`** — la tarjeta de comunidades del admin pinta la fila nueva;
  "Tu tarifa" anade el aviso de zona. Solo presentacion: ninguna cifra se calcula en el JSX.
- Pruebas extendidas: `community-pricing.test.ts`, `community-cashback-entries.test.ts`,
  `community-view.test.ts`, `finance.test.ts`, `order-corrections-plan.test.ts`.

**Lo que NO se toca:** `resolveTariffs` no cambia de comportamiento (se mueve, no se reescribe);
`order-corrections-plan.ts` no se edita (hereda la regla nueva por `buildWalletEntries`, que es lo
que exige el caso limite de correcciones); indices y reglas de Firestore no cambian.

## 2. Modelo de datos

```ts
// functions/src/seller-charges.ts
export type TariffField =
  | "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop"
  | "driverDeliveredPayCop" | "driverFailedPayCop";
export type Tariffs = Record<TariffField, number>;

/** Lo minimo del pedido que decide el cobro. */
export type SellerChargeOrder = {
  sellerId?: string;
  driverId?: string | null;
  pickedUpAt?: string;
};

/** Los tres conceptos que paga la tienda (== CommunityPricingField). */
export type SellerFeeValues = Pick<Tariffs, "sellerDeliveredFeeCop" | "sellerFailedFeeCop" | "fulfillmentFeeCop">;

export function resolveTariffs(settings: Record<string, unknown>, zone?: Record<string, unknown>): Tariffs;
export function resolveSellerCharges(order: SellerChargeOrder, tariffs: Tariffs, deliveredAtIso: string): Tariffs;
export function communityBase(tariffs: Tariffs): SellerFeeValues;
```

```ts
// functions/src/community-pricing.ts
export type FrozenPricing = {
  communityId: string;
  frozenAt: string;
  /** 2 = la base se decide al cierre (spec 004). Ausente = pedido anterior a la 004. */
  pricingVersion?: 2;
  /** Precio PROPIO del lider vigente al crear. Ausente = el lider no fijo nada => se cobra la base. */
  leaderDeliveredFeeCop?: number;
  leaderFailedFeeCop?: number;
  leaderFulfillmentFeeCop?: number;
  // Se conservan como REFERENCIA (RF_03 MAY): precio resuelto y base del momento de crear.
  sellerDeliveredFeeCop: number;
  baseDeliveredFeeCop: number;
  sellerFailedFeeCop: number;
  baseFailedFeeCop: number;
  fulfillmentFeeCop: number;
  baseFulfillmentFeeCop: number;
};

export type CommunityChargeAtClose = {
  charged: PricingValues;        // lo que se cobra a la tienda, por concepto
  base: PricingValues;           // la base de RF_01 en el cierre
  cashback: CashbackBreakdown;   // charged - base, nunca negativo
};
export function communityChargeAtClose(frozen: FrozenPricing, base: PricingValues): CommunityChargeAtClose;

export function raisedCommunityFloors(before: Tariffs, after: Tariffs): Partial<PricingValues>;
export function planRaiseToFloors(input: {
  floors: Partial<PricingValues>;
  communities: CommunityLike[];
  nowIso: string;
}): CommunityFloorRaise[];
```

```ts
// src/lib/community-view.ts — fila del panel del administrador
export type AdminPriceSource = "base" | "leader";
export type AdminConceptPrice = {
  chargedCop: number;          // lo que se cobraria hoy a un pedido sin zona (RF_07)
  baseCop: number;             // base de RF_01 sin zona
  marginCop: number;           // chargedCop - baseCop, >= 0 (RF_08: 0; RF_09: > 0)
  source: AdminPriceSource;    // "base" si chargedCop === baseCop
  upcoming: { toCop: number; effectiveAt: string } | null; // RF_15, nunca sumado a lo de hoy
};
export type AdminCommunityRow = {
  communityId: string;
  name: string;
  leaderName: string;
  stores: number;
  pricing: Record<CommunityPricingField, AdminConceptPrice>;
  /** RF_08: por que cobra solo la base aunque tenga precio guardado. */
  baseOnlyReason: "no_leader" | "disabled" | null;
  cashbackAccruedCop: number;
  leaderStoreCashbackAccruedCop: number;
};
// AdminCommunityLike gana: status?, leaderUid?, scheduled? (el admin ya descarga el documento entero)
// buildAdminCommunityList recibe ademas `nowIso: string`; `settings` pasa a ser la tarifa global entera.
export const ZONE_BASE_NOTICE: string;
```

## 3. Algoritmos criticos

### 3.1 `resolveSellerCharges` — el cobro sin comunidad (una sola copia)

Es el cuerpo actual de `buildWalletEntries:139-158` movido sin cambiar una coma de su resultado:

1. Si `sellerId` es DANDA: `{...tariffs, sellerDeliveredFeeCop: dandaDeliveredFeeCop(deliveredAtIso),
   sellerFailedFeeCop: 0, driverDeliveredPayCop: 11000|10000 (segun driver y pickedUpAt),
   driverFailedPayCop: 0}`.
2. Si no: `{...tariffs, sellerFailedFeeCop: SELLER_FAILED_FEE_FIXED_COP}`.

`deliveredAtIso` es un parametro porque los dos lados lo derivan distinto y eso NO se unifica aqui
(RNF_01 lo prohibe): el servidor pasa el instante del cierre; la app pasa la fecha de la evidencia de
entrega, como hoy.

### 3.2 `communityBase(tariffs)` — la base de RF_01

`communityBase(t) = seller fees de resolveSellerCharges({ sellerId: "" }, t, "")` — es decir, lo que
se cobraria a una tienda **normal** con esas tarifas. Una tienda con tarifa especial no puede estar en
una comunidad (el sello del pedido lanza, `community-order-pricing.ts:39`), asi que la base de una
tienda normal es la unica que existe para comunidades. Con los datos de hoy: sin zona 12.000 /
**12.000** / 2.000; con zona 12.000 / 12.000 / 2.500.

### 3.3 Congelar al crear (RF_03)

`freezeOrderPricing(base, community, now)`:
- `pricingVersion: 2`.
- `leader<X>FeeCop` = precio propio vigente (`applyScheduledChanges`) **solo si** la comunidad cobra
  precio propio (`chargesOwnPricing`) y el concepto tiene un numero finito. Si no, el campo no se
  escribe (ausente = sin precio propio).
- Los seis campos de referencia se siguen escribiendo con la base de 3.2, para que la pantalla y los
  scripts existentes no pierdan nada.

### 3.4 Cobrar y causar al cerrar (RF_11, RF_04, RF_06)

En `buildWalletEntries`:
1. `values = resolveSellerCharges(order, tariffs, now)` — lo mismo que hoy para cualquier tienda.
2. Si el pedido trae `communityPricing`:
   - `base = { sellerDeliveredFeeCop, sellerFailedFeeCop, fulfillmentFeeCop }` **de `values`** — la
     base del cierre, con la zona y la tarifa vigentes en el cierre, calculada por la misma funcion
     que cobra a una tienda sin comunidad. Esto es literalmente RF_02.
   - `communityChargeAtClose(frozen, base)`, por concepto:
     - `leader` = si `pricingVersion === 2`: `frozen.leader<X>` (puede faltar); si no (pedido anterior
       a la 004): `frozen.seller<X>` — el caso limite de la spec (lo guardado a $9.000 se trata como
       precio del lider y pierde contra la base real).
     - `charged = leader` finito y `> base` ? `leader` : `base`.
     - `cashback = charged - base` (>= 0 por construccion).
   - `values.<X> = charged.<X>`; los asientos de cashback salen de `cashback`.
3. Ids deterministas sin cambios (`we-{id}-community-cashback-{concepto}`); cashback cero no emite
   asiento (igual que hoy).

Por que asi y no "frozen.base": si la base sube o baja entre crear y cerrar, el cobro sigue a la base
del cierre (casos limite 11 y 12 de la spec) y un pedido sin precio propio cobra **exactamente** la
base con cashback cero (RF_04) — con lo congelado, una bajada de la base convertia en cashback un
precio que el lider nunca fijo.

Las correcciones administrativas (`order-corrections-plan.ts:354`) ya llaman a `buildWalletEntries`
con las tarifas del momento de la correccion (`order-corrections.ts:172`): heredan la regla sin
tocarlas, que es lo que pide el caso limite de correcciones.

### 3.5 Validar el precio del lider (RF_05)

La decision vive en una funcion pura nueva de `community-pricing.ts`,
`validateCommunityPriceFloor(field, amountCop, base): { ok: true } | { ok: false; floorCop; reason }`,
para que el minimo y su mensaje se prueben sin Firestore; la callable solo la llama.
`scheduleCommunityPrice`: `floor = communityBase(resolveTariffs(settings/global, undefined))[field]`.
Rechazo si `amountCop < floor` con `El minimo para este concepto es $12.000 (lo que Kentro cobra en
un pedido sin zona). En pedidos con zona la base puede ser mayor: ahi se cobra la base y ese pedido
deja menos o cero cashback.` Igual a la base = valido. `currentCop` de la programacion usa ese mismo
`floor` como respaldo.

### 3.6 Elevar precios al piso (RF_13, RF_14)

- `raisedCommunityFloors(before, after)`: para cada concepto,
  `b = communityBase(resolveTariffs(before))`, `a = communityBase(resolveTariffs(after))`; entra si
  `a > b`. Consecuencias que se prueban: cambiar `sellerFailedFeeCop` en los ajustes **no** sube nada
  (el fijo manda en los dos lados); guardar ajustes sin tocar tarifas no sube nada (caso limite).
- `planRaiseToFloors({floors, communities, now})`: la parte por-comunidad del `planFloorRaise` actual,
  sin cambios de criterio (contra el vigente, solo estrictamente por debajo, borra programadas que el
  piso rebasa, historial con `effectiveAt = now`, `floorRaisedAt` como aviso).
- `planFloorRaise` queda como composicion de las dos (el trigger no cambia de forma).
- **Trigger** (RF_13): `onDocumentUpdated("settings/global", ...)`. Mismo nombre exportado, asi que
  el despliegue lo actualiza en sitio.
- **Pasada unica** (RF_14): `floors = communityBase(resolveTariffs(settings/global))` para los tres
  conceptos, `planRaiseToFloors`, e imprime el plan. Con `--apply` escribe via
  `community-floor-writer.ts`. Idempotente por construccion (estrictamente por debajo), y el id de
  historial lleva el concepto y el instante, asi que un reintento del mismo plan no duplica.

### 3.7 El panel del administrador (RF_07, RF_08, RF_09, RF_15, RNF_02)

Por comunidad, con `base = communityBase(resolveTariffs(state.settings))` (sin zona) y `now`:
- `charged = resolveCommunityPricing(base, community, now)` — ya aplica programadas vencidas, el piso,
  y cae a la base si la comunidad esta sin lider o desactivada (RF_20 de la 001). Es la MISMA funcion
  con la que se congela, asi que panel y cobro no pueden divergir.
- `marginCop = charged - base`, `source = marginCop > 0 ? "leader" : "base"`.
- `baseOnlyReason`: `status !== "active"` -> `"disabled"`; `leaderUid` recortado vacio -> `"no_leader"`
  (mismo criterio que `chargesOwnPricing`); si no, null.
- `upcoming`: la programada del concepto si su fecha es futura; nunca se suma a `charged` ni al margen.
- Entrada: solo `state.communities` y `state.settings`, que el admin ya tiene. Cero descargas nuevas.

JSX: `Fallido $12.000 (base)`, `Manejo $2.300 (precio del lider · margen $300)`, subida pendiente en
linea aparte, y bajo la fila `ZONE_BASE_NOTICE` + el motivo si lo hay.

### 3.8 "Tu tarifa" (RF_10, RF_12)

`getMyStoreTariff` pasa `communityBase(resolveTariffs(settings))` a `buildStoreTariffView`, que ya
calcula `current = resolveCommunityPricing(...)` y ya descarta subidas que no superan lo vigente
(el caso limite de la programada a $11.000 queda cubierto sin tocarla). La tarjeta anade
`ZONE_BASE_NOTICE`. Sin comunidad la tarjeta ensena ahora 12.000 de fallido, que es lo que se cobra.

## 4. Estrategia de testing

- **Todo en Vitest, sin red ni Firestore.** Instantes fijos por parametro (`NOW` constantes), el
  patron de `community-pricing.test.ts`. Codigo de `functions/` importado desde `src/` como exige el
  principio 4.
- **RNF_01 primero, como caracterizacion.** Antes de mover nada, `seller-charges.test.ts` fija con
  importes literales lo que `buildWalletEntries` y `entriesForClosedOrder` generan HOY para: tienda
  normal sin zona, con zona, fallido cobrable, fallido segunda visita, bodega, y DANDA antes/despues
  de sus dos cortes de fecha. Esas pruebas pasan en verde ANTES del cambio y tienen que seguir en
  verde despues. Es la prueba de "centavo a centavo" que pide RNF_01 y el punto 2 del DoD.
- **RF_02 / DoD 3, guardas de fuente** (patron ya usado en el repo con `readFileSync`):
  el literal `12000` asociado a `sellerFailedFeeCop` solo aparece en `seller-charges.ts`;
  `finance.ts`, `wallet-entries.ts`, `community-order-pricing.ts` y `communities.ts` importan de
  `seller-charges` y no definen su propia base; `community-floor-trigger.ts` escucha `settings/global`.
  Mas una prueba de comportamiento: servidor (`buildWalletEntries`) y app (`entriesForClosedOrder`)
  dan el mismo cobro para el mismo pedido sin comunidad. La lista de archivos vigilados por la guarda
  es cerrada: `finance.ts`, `wallet-entries.ts`, `community-order-pricing.ts` y `community-view.ts`
  (el panel del admin, que en la app es quien calcula la base).
- **Comunidades** (`community-pricing.test.ts`, `community-cashback-entries.test.ts`): la tabla de
  casos de la spec — sin precio propio (cobra base, 0 cashback), manejo 2.300 sin zona y con zona,
  base que sube y que baja entre crear y cerrar, pedido anterior a la 004 con base 9.000 guardada,
  lider sin lider/desactivada al crear, RF_05 (igual a la base valido, por debajo rechazado).
- **Piso** (`community-pricing.test.ts`, bloque T47 existente): subir el fallido en ajustes no eleva
  nada; subir la entrega si; guardar sin cambios no escribe; `planRaiseToFloors` dos veces seguidas
  => segunda vacia.
- **Panel** (`community-view.test.ts`): E-master de hoy => los tres conceptos `source: "base"`,
  fallido 12.000; precio propio con programada futura; desactivada con precio guardado => base +
  motivo; `ZONE_BASE_NOTICE` presente en los dos JSX (guarda de fuente).
- **Correcciones** (`order-corrections-plan.test.ts`): fallido->entregado de un pedido de comunidad
  recalcula con la base del momento de la correccion.
- **Lo que no es probable en unidad y se declara:** el trigger, `community-floor-writer.ts` y las
  callables (importan `firebase-admin`), la pasada RF_14 contra produccion (su prueba es la pasada
  en seco) y el smoke. Para el writer hay guarda de fuente: copia `communityUpdate` entero (con
  `floorRaisedAt`, que es el aviso de RF_13) y escribe cada `historyEntries`.

## 5. Dependencias nuevas

Ninguna.

## 6. Desviaciones del stack por defecto del usuario

- No hay Prisma/PostgreSQL: el proyecto es Firebase (constitucion). No hay API nueva: las dos
  callables tocadas ya validan con Zod (`priceSchema`) y no cambian de contrato de entrada.
- UI asincrona: "Tu tarifa" ya maneja cargando/error/vacio/exito; el panel del admin es derivado
  sincrono de estado ya cargado, sin estados nuevos.

## 7. Despliegue (lo firma el humano, principio 7)

0. **Antes de desplegar nada:** `node scripts/smoke-004.js count` (solo lectura). Cuenta los pedidos
   de comunidad abiertos (DoD 5, primer punto) y guarda la posicion de la plataforma y el saldo de la
   tienda "Prueba" para el `compare` final.
1. Sin indices ni reglas nuevas.
2. `cd functions && npm run build`, comprobar `firebase functions:list` == set local, y
   `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions` (cierre, validacion, tarifa y trigger
   van juntos: desplegar solo una parte dejaria panel y cobro con bases distintas).
3. `firebase deploy --only hosting`.
4. `node scripts/raise-community-floors.js` en seco => se espera 0 cambios (E-master sin precios).
5. `scripts/smoke-004.js` segun DoD 5, con limpieza.

## 8. Riesgos

- **El pedido que se cierra en el hueco entre desplegar functions y hosting** no corre riesgo: el
  dinero lo decide solo el servidor.
- **`resolveTariffs` movida:** se reexporta desde `wallet-entries.ts`; `tsc` en `functions/` detecta
  cualquier importador olvidado.
- **Importar `seller-charges.ts` desde la app:** el archivo no puede importar nada de Node ni de
  `firebase-admin`; una guarda de fuente lo comprueba.
