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
- `src/lib/firebase/state-store.ts` — carga/suscripción de estado Firestore (scoping por rol) + escrituras. **Ningún rol baja su historial completo**: los pedidos activos van enteros y los cerrados solo dentro de una ventana (`orderTargets` en la suscripción, `getWindowedOrders` en la carga inicial — hay que tocar los dos o el primer pintado diverge del listener). Lo que queda fuera de la ventana y hace falta para el dinero se rescata por id (`pinOrders`).
- `src/lib/firebase/auth.ts` — wrappers de callables.
- `functions/src/` — backend: `orders.ts` (callables de ciclo de vida: confirm/close/cancel/adjust/**applyOrderTransition**…), `roles.ts`, `shopify.ts`, `index.ts` (webhook Shopify; tiene su PROPIA copia de helpers `summarizeShopifyLineItems`/offers), `onstock-webhook.ts`, `store-webhook.ts`, `uchat-pull.ts` (**confirmación de pedidos vía ChatBy/UChat, enfoque PULL**: callable `setStoreUchatConfig` guarda token en `storeUchatSecrets` (sin acceso cliente); scheduled `pullUchatConfirmations` **cada 2 horas** (a las :32 UTC; antes decía "cada 3 min" y era falso) consulta la API de UChat por teléfono E.164 y pasa `imported`→`ready_to_assign` los pedidos con `lead_status=CONFIRMADO` o tag `PED-Confirmado`. Toma TODOS los `imported` sin ventana de fecha, hasta 500 por corrida. Para adelantarlo: `gcloud scheduler jobs run firebase-schedule-pullUchatConfirmations-us-central1 --location us-central1`), `uchat-webhook.ts` (`uchatConfirmWebhook`: webhook entrante alternativo/secundario).
- `functions/src/order-stats.ts` — callable `getOrderStats`: indicadores de un periodo **agregando en Firestore**, sin descargar pedidos. Lo usa la UI cuando el rango elegido se sale de la ventana descargada (atajos "Mes pasado"/"Acumulado"). Devuelve solo contadores exactos; el embudo por mensajero y el recaudo neto siguen en cliente porque no son agregables (ver el comentario del archivo).
- `functions/src/platform-position.ts` — callable `getPlatformPosition` + `computePlatformPosition` (puro): las quince cifras de caja, activos, pasivos y utilidad de la plataforma, calculadas EN SERVIDOR. Existe para que el admin deje de bajarse `walletEntries` entera (10.452 asientos, 3,58 MB, el 68% de su carga) solo para derivarlas. **La suscripción todavía no se recorta**: ver "Pendiente" en `docs/rendimiento.md`. `src/lib/platform-position.test.ts` ata su aritmética a la del cliente para que no puedan divergir.
- `functions/src/wallet-entries.ts` — **la unica fuente de verdad sobre cuanta plata genera un pedido**: `buildWalletEntries`, `resolveTariffs`, costo de producto y las reglas de tarifa de DANDA. Puro (sin firebase-admin) para que lo reusen el cierre y las correcciones sin copiarlo.
- `functions/src/settlement-math.ts` — aritmetica de cortes sin Firestore: `computeDriverCashSummary` (cuanto efectivo debe un domiciliario), `settlementTotals`. `orders.ts` conserva `loadDriverCashInputs`, que es la parte que lee. Se separo para poder responder "como queda el corte DESPUES del cambio" sin escribir primero.
- `functions/src/order-corrections-plan.ts` + `order-corrections.ts` — **correccion administrativa de estados terminales desde la UI** (callable `correctOrderStatus`): fallido→entregado, entregado→fallido, anulado→operativo, fallido→nueva visita. Sustituye a los ocho scripts one-off que se corrian a mano (`correct-*.js`, `clawback-*.js`, `reopen-order-for-retry.js`), cuyo razonamiento esta recogido en la cabecera del planificador. El planificador es PURO, asi que `dryRun: true` devuelve exactamente lo que se va a escribir: la previsualizacion y la aplicacion no pueden divergir. Regla central: un corte ya pagado o conciliado NO se toca — se compensa con asientos `-correction-reverse-*` en el periodo abierto; uno pendiente si se recalcula. Usa batch con precondiciones `lastUpdateTime` (no transaccion) porque recalcular un corte necesita las colecciones de asientos completas.
- `src/lib/date-ranges.ts` — atajos de periodo (semana pasada / mes pasado / acumulado), todos cortando en la ultima semana completa. Con pruebas.
- `firestore.rules` — reglas.

## Roles
`admin | seller | seller_logistics | driver | messenger`. `seller_logistics` = logístico de tienda (confirma/edita pedidos de SU tienda, SIN acceso financiero).

## Reglas de oro (aprendidas a la mala)
1. **El ciclo de vida de un pedido (status/driverId/evidencia) se cambia SOLO por callables del servidor**, nunca con escrituras directas del cliente. Un `applyOrderTransition` valida optimistic-concurrency (`expectedStatus` debe == estado real) y audita. Las reglas prohíben que el cliente escriba esos campos (solo rótulos/no-op). Esto evita el "clobber": un navegador con estado viejo pisando una entrega.
2. **Costo de producto = costo del ítem por unidad-de-Shopify × cantidad real de Shopify.** Nada de expandir cantidades en la plataforma. Los pedidos guardan `lineItems[]` y se cobra por línea/SKU (una entrada `product_cost` por producto). Excluir "envío prioritario". `closeOrder` lee el catálogo en vivo.
3. **No re-introducir dependencias de cálculo frágiles** (ej. el viejo `unitsPerSoldUnit` del 2x1 de Kovia se eliminó).
4. **`failedCategory` tiene CINCO valores, no cuatro**: `failed_visit`, `no_coverage`, `bad_order_or_no_contact`, `bad_phone` y `pending_review`. Cobrable = `failed_visit` **o campo ausente**; despachable excluye solo los tres del medio (`pending_review` SÍ es despachable). Contar cobrables **restando** las no-cobrables es un error: se hizo así y `pending_review` desviaba 44 pedidos. Contar `failed_visit` en positivo, que además absorbe categorías futuras sin tocar nada.

5. **Al acotar una descarga, comprobar primero qué cifras de dinero dependen de lo que se recorta.**
   El saldo "Pendiente por entregar" del líder sale de pedidos entregados en efectivo aún sin cortar,
   que pueden ser muy anteriores a la ventana: acotar sin rescatarlos por id le bajaba el saldo
   **$1.135.720 en silencio** (medido forzando una ventana de un día). No falla, no avisa: solo
   muestra menos dinero del que se debe.
6. **Leer pedidos por id: el admin puede por lotes, el líder y el mensajero NO.** Comprobado con una
   sesión real contra producción: `where(documentId(), "in", [...])` **sí** pasa las reglas para un
   domiciliario mientras todos los ids sean suyos, pero un solo id ajeno o inexistente devuelve 403 y
   **tumba el lote entero** — y `getDocumentsByIds` se traga el error, así que la pérdida sería
   silenciosa justo en el saldo. Por eso existe `getDocumentsOneByOne`. No devolverlo al lote.

## Rendimiento
**Antes de tocar nada por lentitud, leer `docs/rendimiento.md`.** Trae el presupuesto de carga
medido por rol, cómo medirlo (`localStorage.setItem("kentro-perf","1")`), las trampas comprobadas
(ejes de fecha que no coinciden, `localeCompare`, `React.memo` inerte con `state` entero, índices
antes que hosting) y lo que queda pendiente. La lentitud de esta app nunca ha estado en el pintado,
sino en cuántos documentos baja el navegador antes de mostrar algo.

## Diseno
Sistema "Acid Glass": tema oscuro, verde acido `#c6f24e` como unico acento, Plus Jakarta Sans,
pildoras y tarjetas redondeadas, glassmorfismo solo en controles y una tarjeta heroe.
**Antes de tocar UI, leer `docs/design-system.md`** — trae los tokens con sus ratios de contraste
verificados, los patrones de composicion (riel, franja de KPI, tablas a tarjetas, divulgacion
progresiva), las trampas comprobadas (pildoras en bloques, regex sobre clases, colores literales)
y un checklist de cierre.

## Deploy
- **Orden cuando el cambio toca consultas nuevas: índices → functions → hosting.** Una consulta sin
  índice falla EN DURO, no en silencio: el rol afectado se queda sin pedidos. Desplegar
  `firebase deploy --only firestore:indexes` y esperar a que estén `READY` (varios minutos en
  `orders`) ANTES de subir el cliente que los usa.
- **Los índices se AÑADEN, nunca se reemplazan**: desplegar borra los que falten en el archivo.
  Comparar contra prod antes (`firebase firestore:indexes`).
- Reglas: `firebase deploy --only firestore:rules --project kentro-last-mile`
- Hosting: `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only hosting --project kentro-last-mile` (o
  `npm run deploy:hosting`). **La variable es obligatoria aunque no se toque ninguna callable:**
  `/registro/[slug]` es dinamica y Firebase la sirve con la funcion `ssrkentrolastmile`, asi que todo
  despliegue de hosting incluye un objetivo de functions y dispara el guard. Sin la variable falla con
  "Blocked Firebase Functions deploy" (comprobado el 2026-09-13). Es seguro: con `--only hosting` el
  alcance es hosting mas esa funcion SSR; las demas no se tocan.
- **Caché (no tocar sin pensar):** `firebase.json` fija `no-cache` para el HTML y `immutable` un año para `/_next/static/**`. Firebase por defecto pone `max-age=3600` a TODO, y eso rompía la app en móviles tras cada despliegue: el navegador conservaba el índice viejo pidiendo chunks con hash que el despliegue ya había borrado, y el JS no arrancaba (pantalla en blanco / "this page couldn't load"). El HTML debe revalidar siempre; los assets con hash en el nombre nunca.
- **Functions (¡ojo!):** un guard (`scripts/guard-functions-deploy.js`) las bloquea. Compilar primero (`cd functions && npm run build`) y desplegar con `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions`, tras confirmar con `firebase functions:list` que el set local == prod (no borra funciones). El set local == prod está verificado.

## Navegadores (browserslist)
`package.json` fija `browserslist` en Safari/iOS 14, Chrome 87. **No subirlo sin motivo.** Por defecto
Next 16 compila para Safari 16.4+ y emitia un `class static block` en su propio runtime; en un iPhone
con iOS anterior eso no es un error de ejecucion sino de SINTAXIS, asi que el navegador descarta el
bundle entero y la app no pinta NADA (pantalla de error del navegador, en cualquier sesion, tambien en
incognito). Con el target bajo, Next ademas inyecta los polyfills de `Object.hasOwn` y `.at()`.
Comprobacion tras cambiar el build: descargar los chunks de produccion y verificar que
`grep -o 'static{'` da 0.

## Verificar datos en vivo
Scripts node con `admin.initializeApp({projectId:"kentro-last-mile"})` (ADC; usar libs de `functions/node_modules`). Sirve para Firestore/Auth. `createCustomToken` NO funciona (ADC sin signBlob) — para probar callables/reglas como usuario, crear usuario desechable + `signInWithPassword` REST con la API web key del `src/lib/firebase/client.ts`.

## Calidad
`npx tsc --noEmit` (raíz y en `functions/`), `npx vitest run`, `npm run lint`.

**`npm run lint` no es opcional antes de desplegar UI.** Existe por un fallo que llegó a producción:
un `useMemo` puesto después del `return` anticipado de `SellerView`. En el PC no se veía (la caché de
IndexedDB ya traía los datos en el primer render, así que el número de hooks nunca cambiaba); en un
móvil sin caché el primer render salía por el `return` y el segundo ejecutaba un hook más → React #310
y app muerta, solo para tiendas y solo en móvil. `react-hooks/rules-of-hooks` va como **error**;
`exhaustive-deps` como aviso (3 pendientes, no rompen nada).

## Arnes SDD
Este repo trabaja bajo Spec Driven Development. Consulta el skill `/sdd` antes de escribir codigo.

- **Constitucion:** `docs/constitution.md` — reglas que no se negocian (las 13 estan atadas a fallos
  reales de este proyecto, no a teoria).
- **Especificaciones:** `specs/NNN_feature.md`, en sintaxis EARS.
- **Estado del ciclo:** `.sdd/state.json` (`phase`, spec y tarea activas, comando de pruebas).
- **Flujo:** `/sdd-spec` -> `/sdd-plan` -> `/sdd-tasks` -> `/sdd-run` -> `/sdd-verify` -> `/sdd-audit`.

Las escrituras de codigo de produccion estan bloqueadas hasta que exista una spec aprobada. La
escotilla es `/sdd-bypass`, es efimera (`.sdd/bypass.json`, sin versionar) y su uso queda registrado.
