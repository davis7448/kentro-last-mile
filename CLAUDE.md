# CLAUDE.md — Kentro (plataforma de última milla)

## Qué es y dónde está
**Kentro** = plataforma de última milla (last-mile) para Cali: administradores, vendedores (tiendas), transportistas/mensajeros, inventario, wallets y liquidaciones. Integra Shopify.

- **Ubicación:** `/root/kentro-last-mile/` (package `"kentro"`). NO está en `/opt/workspaces/` ni `/root/.openclaw/workspace/`.
- **Proyecto Firebase:** `kentro-last-mile`. Hosting: https://kentro-last-mile.web.app

## Stack
Next.js 16 + React 19 + Firebase (Hosting/Functions/Firestore/Storage) + Shopify.

## Mapa del código
- `src/components/operations-app.tsx` — **UI monolítica** (~7.5k líneas): todas las vistas por rol, tarjetas de pedido, wallet, liquidaciones, admin.
- `src/lib/finance.ts` — cálculo financiero cliente (costo por línea/SKU, fees, saldos).
- `src/lib/actions.ts` — funciones puras de estado (assignOrder, advanceOrder, resolveAddress…).
- `src/lib/order-export.ts` — export a Excel (pedidos y wallet).
- `src/lib/firebase/state-store.ts` — carga/suscripción de estado Firestore (scoping por rol) + escrituras.
- `src/lib/firebase/auth.ts` — wrappers de callables.
- `functions/src/` — backend: `orders.ts` (callables de ciclo de vida: confirm/close/cancel/adjust/**applyOrderTransition**…), `roles.ts`, `shopify.ts`, `index.ts` (webhook Shopify; tiene su PROPIA copia de helpers `summarizeShopifyLineItems`/offers), `onstock-webhook.ts`, `store-webhook.ts`, `uchat-pull.ts` (**confirmación de pedidos vía ChatBy/UChat, enfoque PULL**: callable `setStoreUchatConfig` guarda token en `storeUchatSecrets` (sin acceso cliente); scheduled `pullUchatConfirmations` cada 3 min consulta la API de UChat por teléfono E.164 y pasa `imported`→`ready_to_assign` los pedidos con `lead_status=CONFIRMADO` o tag `PED-Confirmado`), `uchat-webhook.ts` (`uchatConfirmWebhook`: webhook entrante alternativo/secundario).
- `firestore.rules` — reglas.

## Roles
`admin | seller | seller_logistics | driver | messenger`. `seller_logistics` = logístico de tienda (confirma/edita pedidos de SU tienda, SIN acceso financiero).

## Reglas de oro (aprendidas a la mala)
1. **El ciclo de vida de un pedido (status/driverId/evidencia) se cambia SOLO por callables del servidor**, nunca con escrituras directas del cliente. Un `applyOrderTransition` valida optimistic-concurrency (`expectedStatus` debe == estado real) y audita. Las reglas prohíben que el cliente escriba esos campos (solo rótulos/no-op). Esto evita el "clobber": un navegador con estado viejo pisando una entrega.
2. **Costo de producto = costo del ítem por unidad-de-Shopify × cantidad real de Shopify.** Nada de expandir cantidades en la plataforma. Los pedidos guardan `lineItems[]` y se cobra por línea/SKU (una entrada `product_cost` por producto). Excluir "envío prioritario". `closeOrder` lee el catálogo en vivo.
3. **No re-introducir dependencias de cálculo frágiles** (ej. el viejo `unitsPerSoldUnit` del 2x1 de Kovia se eliminó).

## Deploy
- Reglas: `firebase deploy --only firestore:rules --project kentro-last-mile`
- Hosting: `firebase deploy --only hosting --project kentro-last-mile`
- **Functions (¡ojo!):** un guard (`scripts/guard-functions-deploy.js`) las bloquea. Compilar primero (`cd functions && npm run build`) y desplegar con `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions`, tras confirmar con `firebase functions:list` que el set local == prod (no borra funciones). El set local == prod está verificado.

## Verificar datos en vivo
Scripts node con `admin.initializeApp({projectId:"kentro-last-mile"})` (ADC; usar libs de `functions/node_modules`). Sirve para Firestore/Auth. `createCustomToken` NO funciona (ADC sin signBlob) — para probar callables/reglas como usuario, crear usuario desechable + `signInWithPassword` REST con la API web key del `src/lib/firebase/client.ts`.

## Calidad
`npx tsc --noEmit` (raíz y en `functions/`), `npx vitest run`.
