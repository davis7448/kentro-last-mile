# Plan tecnico 037: el webhook de tienda acepta todo por defecto, y lo dice

Spec: `specs/037_el_webhook_de_tienda_acepta_todo_por_defecto.md`. Pantallas: `specs/design/037_el_webhook_de_tienda_acepta_todo_por_defecto/`
(el plan construye sobre ellas; no redecide la interfaz).

## 1. Arbol de modulos

| Archivo | Responsabilidad |
|---|---|
| `functions/src/store-webhook-filter.ts` (nuevo, puro, sin firebase-admin) | La unica regla del filtro de productos: valor por defecto de una conexion nueva, que se guarda al regenerar, filtro efectivo de una conexion guardada, frase que lo describe, y cuenta de descartados de los ultimos 7 dias. Lo importan el servidor y la pantalla, como `seller-balance.ts`. |
| `functions/src/store-webhook.ts` | `createStoreWebhookConfig` usa `resolveFilterOnSave` (RF_01, RF_02, RF_09). `storeOrderWebhook` usa `effectiveFilter` y, al descartar por filtro un pedido de una ciudad cubierta, lo apunta en la conexion (RF_07). Se borran `defaultSkuContains`/`defaultTagContains` y `normalizeFilter` de aqui. |
| `src/lib/types.ts` | `StoreWebhookConfig` gana `filterDiscards?: Record<string, Record<string, true>>` y `lastFilterDiscardAt?: string`. |
| `src/lib/firebase/auth.ts` | `createFirebaseStoreWebhookConfig`: `skuContains`/`tagContains` siguen opcionales; sin cambios de forma. |
| `src/components/store-webhook-filter-card.tsx` (nuevo) | Bloque "Webhook de sincronizacion" de la tienda: frase (status), contador, edicion con dos opciones y vista previa, instruccion segun filtro. Saca ~80 lineas del monolito. |
| `src/components/operations-app.tsx` | La tarjeta de tienda delega en el componente nuevo y deja de mandar `"ADMA"` de relleno (RF_04, RNF_01). `StoreWebhookConfigsPanel` (admin) muestra frase y contador (RF_06, RF_07). |
| `src/lib/store-webhook-filter.test.ts` (nuevo) | Pruebas del modulo puro. |
| `src/lib/spec-037-guards.test.ts` (nuevo) | Guardas de fuente: el cliente no manda `"ADMA"` de relleno; el servidor no declara otro valor por defecto; el webhook usa `effectiveFilter`. |

## 2. Modelo de datos

`storeWebhookConfigs/{sellerId}` (existente) — campos que se tocan:

```ts
type StoreWebhookConfig = {
  // existentes
  skuContains?: string;   // "*" = todos | texto en mayusculas | ausente (conexion antigua = "ADMA")
  tagContains?: string;   // idem
  cityAllowlist: string[];
  // nuevos (los escribe solo el servidor)
  filterDiscards?: Record<string /* YYYY-MM-DD, America/Bogota */, Record<string /* id del pedido */, true>>;
  lastFilterDiscardAt?: string; // ISO
};
```

Entrada de `createStoreWebhookConfig` (Zod, sin cambios de forma): `{ sellerId, shopDomain?, skuContains?, tagContains? }`.
Nuevo en la entrada: `filterMode?: "all" | "sku"` — si viene `"all"`, se guarda `*`/`*` aunque llegue texto.

```ts
// store-webhook-filter.ts
export const ALL_PRODUCTS = "*";
export const LEGACY_DEFAULT = "ADMA";
export type ProductFilter = { skuContains: string; tagContains: string };
export function resolveFilterOnSave(args: {
  existing: { skuContains?: unknown; tagContains?: unknown } | null; // null = conexion nueva
  input: { filterMode?: "all" | "sku"; skuContains?: string; tagContains?: string };
}): Partial<ProductFilter>; // claves ausentes = no escribir (conservar)
export function effectiveFilter(config: { skuContains?: unknown; tagContains?: unknown }): ProductFilter;
export function acceptsAllProducts(filter: ProductFilter): boolean;
export function describeFilter(filter: ProductFilter, cities: string[]): string;
export function syncInstruction(filter: ProductFilter): string;
export function recentFilterDiscards(discards: StoreWebhookConfig["filterDiscards"], now: Date): number;
export function discardDayKey(now: Date): string;
export function staleDiscardDays(discards, now: Date): string[]; // dias > 7 para borrar al escribir
```

## 3. Algoritmos criticos

**Guardar el filtro (`resolveFilterOnSave`).**
1. `filterMode === "all"` → `{ skuContains: "*", tagContains: "*" }`.
2. Si la entrada trae `skuContains` o `tagContains`: cada uno se recorta y se pasa a mayusculas; uno vacio o solo
   espacios vale `*` (RF_09). Si solo trae `skuContains`, la etiqueta toma el mismo valor (asi se comporta la
   pantalla de hoy: un solo campo filtra SKU y etiqueta con la misma marca). Con `filterMode === "sku"` y texto
   vacio → `*`/`*`, y la pantalla ya lo habra dicho en la vista previa.
3. Sin `filterMode` ni campos: conexion nueva (`existing === null`) → `*`/`*` (RF_01); existente → `{}`, es decir,
   no se escribe ninguna clave de filtro y se conserva lo que hay, incluida su ausencia (RF_02, RF_03).

**Filtro efectivo (`effectiveFilter`).** Campo ausente, no-string o vacio → `ADMA` (conexion antigua, RF_03). Es la
regla que hoy aplica `normalizeFilter`, movida, no cambiada.

**Aceptar todo.** `acceptsAllProducts` = `sku === "*" || tag === "*"`, porque el filtro acepta un pedido si cumple
SKU **o** etiqueta: la conexion mixta de Bella Mujer (`*`/`ADMA`) acepta todo y la frase lo dice.

**Contar descartados (RF_07, RNF_03).** En `storeOrderWebhook`, se evalua la ciudad ANTES de apuntar: solo cuenta un
pedido que el filtro de productos descarto **y** que la ciudad habria dejado entrar (los de fuera de cobertura se
descartarian igual; contarlos inflaria el aviso: Infinito tiene 3.608 avisos pero 153 pedidos de Cali). La
respuesta y el `reason` de la muestra no cambian (`sku_or_tag_filter` sigue saliendo primero). Se escribe con
`set(..., { merge: true })`: `filterDiscards.<dia>.<idPedido> = true` (un pedido que llega diez veces cuenta una),
`lastFilterDiscardAt`, y `FieldValue.delete()` sobre los dias de mas de 7 que ya trae la conexion leida (la
conexion ya se lee para validar la clave: sin lecturas extra). La pantalla suma las claves de los dias dentro de
los ultimos 7 con `recentFilterDiscards`; el documento de la conexion ya lo baja cada rol, asi que no hay
descarga nueva.

**Convivencia con el autoguardado del admin.** `storeWebhookConfigs` esta en `AUTOSAVED_COLLECTIONS`
(`state-store.ts`): si el admin cambia una conexion en su estado, se reescribe con `merge`. `merge` funde mapas
anidados, asi que un admin con estado viejo no borra descartes nuevos; como mucho reanade un dia que el servidor ya
habia podado, y `recentFilterDiscards` lo ignora por fecha. No se toca el autoguardado en esta spec.

## 4. Estrategia de testing

- Modulo puro: tabla de casos de `resolveFilterOnSave` (nueva sin filtro, existente sin filtro con y sin campos,
  `all`, `sku` con texto, `sku` vacio, minusculas, solo espacios), `effectiveFilter` (ausente, `*`, mixto),
  `describeFilter` (todo, mixto, ADMA, varias ciudades), `recentFilterDiscards` con fecha fija (borde de 7 dias,
  cambio de dia en Bogota a las 00:00 locales = 05:00 UTC), `staleDiscardDays`.
- Guardas de fuente (`readFileSync`): `operations-app.tsx` y el componente nuevo no contienen
  `|| "ADMA"` ni `tagContains: "ADMA"`; `store-webhook.ts` no declara `defaultSkuContains` y llama a
  `resolveFilterOnSave` y `effectiveFilter`.
- Sin red ni Firestore en las pruebas. La ruta real se comprueba en verificacion: llamar a la callable como tienda
  desechable (nueva → `*`; regenerar → conserva) y mandar un aviso al webhook (descarte apuntado).

## 5. Dependencias nuevas

Ninguna. `FieldValue` ya viene en `firebase-admin/firestore`.

## 6. Despliegue

Functions (`createStoreWebhookConfig`, `storeOrderWebhook`) **antes** que hosting: la pantalla nueva lee
`filterDiscards`, que solo existe cuando el servidor lo escribe, y tolera su ausencia. Sin indices ni reglas nuevas
(`storeWebhookConfigs` ya la escribe solo el servidor; comprobar en `firestore.rules` que el cliente no puede
escribir `filterDiscards`).
