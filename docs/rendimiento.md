# Rendimiento — presupuesto de carga por rol

Este documento existe porque la lentitud de Kentro nunca ha estado en el pintado: ha estado en
**cuántos documentos baja el navegador antes de mostrar algo**. Si vuelve a haber reportes de
"la app va lenta", empieza midiendo aquí antes de tocar componentes.

Cifras medidas contra producción el 6 de septiembre de 2026, después de acotar la ventana de
líder y mensajero.

## Presupuesto actual

| Rol | Carga inicial | Caché | Ventana de pedidos cerrados |
|---|---|---|---|
| Líder logístico | 3.235 docs / 1,87 MB | memoria | 7 días + rescatados por id |
| Admin | ~5,2 MB | disco | 7 días |
| Mensajero (el de más ruta) | 39 docs / 0,07 MB | memoria | 7 días |
| Tienda (la de más volumen) | 621 docs / 0,95 MB | disco | 7 días |

JavaScript del primer pintado: **1,55 MB sin comprimir / 358 KB por la red**.

De la carga del admin, **3,58 MB son la colección `walletEntries` entera** (10.452 asientos, el
68%), y crece ~3.700 al mes. Es la próxima deuda: ver "Pendiente" abajo.

## Cómo medir

El propio código trae el instrumento. En el navegador:

```
localStorage.setItem("kentro-perf", "1")
```

y recargar. Imprime en consola cuánto tarda cada listener en dar su primer snapshot, cuántos
documentos trae, y cuánto cuesta cada render del árbol completo.

Para medir el peso real de un rol sin abrir la app, un script node con
`admin.initializeApp({ projectId: "kentro-last-mile" })` que reproduzca las consultas de
`subscribeFirestoreState` y sume `Buffer.byteLength(JSON.stringify(doc.data()))`.

## Las dos reglas que sostienen el presupuesto

**1. Ningún rol descarga su historial completo.** Los pedidos van en dos consultas: los activos
siempre completos (son la operación del día), los cerrados solo dentro de una ventana. El helper es
`orderTargets` en `subscribeFirestoreState`, y su espejo para la carga inicial es
`getWindowedOrders`. **Hay que cambiar los dos o el primer pintado diverge del listener.**

Antes de esto, el líder bajaba 4.127 pedidos (6,93 MB) — el 95% de la colección entera — en un móvil
y sin caché persistente, así que los repetía enteros en cada apertura.

**2. Acotar la descarga sin rescatar lo que sostiene el dinero es un error financiero.**
`calculateDriverFinancialSummary` deriva "Pendiente por entregar" de los pedidos entregados en
efectivo que aún no entraron en ningún corte, y esos pueden ser muy anteriores a la ventana. Se
rescatan por id (`pinOrders`), sembrando desde los asientos sin liquidar del propio líder — su
wallet se sigue suscribiendo sin recorte, así que la semilla está completa.

Comprobado forzando una ventana de un día: sin el rescate el saldo caía de $1.233.349 a $97.629,
**$1.135.720 menos y sin un solo aviso**. Con el rescate, la cifra exacta.

## Trampas comprobadas

**Leer por id: de uno en uno para driver y messenger, por lotes solo para el admin.** Probado con
una sesión real de domiciliario contra producción:

| Operación | |
|---|---|
| `getDoc` de un pedido propio | 200 |
| `getDoc` de un pedido ajeno | 403 |
| `documentId() in` con 5 propios | **200** |
| `documentId() in` con 4 propios + 1 ajeno | **403, cae el lote entero** |
| `documentId() in` con 4 propios + 1 inexistente | **403, cae el lote entero** |

O sea: el lote **sí** pasa las reglas, pero basta con que un pedido se haya borrado o reasignado
para tumbar hasta 30 rescates de golpe. Y como `getDocumentsByIds` se traga el error con
`.catch(() => [])`, la pérdida sería **silenciosa**, justo en las cifras que sostienen el saldo. Por
eso existe `getDocumentsOneByOne`, que además registra los fallos en vez de tragárselos. No lo
"optimices" de vuelta al lote.

**Los ejes de fecha no son el mismo.** La ventana de descarga corta por `createdAt`; el histórico
del líder filtra por fecha de **cierre** (`orderClosedAt`, que es la evidencia o `updatedAt`), y
`weeklyFailedRate` mira `updatedAt`. Un pedido creado el 28 de julio y cerrado el 3 de agosto entra
en "desde el 1 de agosto" pero se habría quedado fuera de la descarga. Por eso al ensanchar la
ventana desde el histórico se restan **30 días de margen**.

**Cualquier contador de cerrados pasa a cubrir solo la ventana.** Si un número deja de ser
"histórico", su etiqueta tiene que decirlo. Ya pasó con "Recaudo COD histórico de la flota", que con
la ventana era directamente falso.

**Índices antes que hosting.** Una consulta sin índice falla **en duro**, no en silencio: el rol
afectado se queda sin pedidos. Desplegar `firestore:indexes` y esperar a que estén `READY` antes de
desplegar el cliente que los usa. Un índice sobre `orders` tarda varios minutos.

**`in` + rango pide el índice en ASC.** `where("status","in",[...])` con
`where("createdAt",">=",…)` y sin `orderBy` explícito hace que Firestore añada
`orderBy("createdAt","asc")` implícito, así que el índice compuesto va **ASC**.

**`localeCompare` sobre listas largas.** Es un orden de magnitud más lento que comparar cadenas
directamente, y `createdAt` es ISO 8601, que ya ordena bien así (14,8 ms → 2,1 ms sobre 3.000
asientos). Consérvalo solo donde ordena **nombres con acentos** (puntos de recogida, tiendas).

**`React.memo` aquí es inerte.** `OrderCard`, `OrderRow` y `WalletEntryRow` reciben el objeto
`state` entero, que cambia de identidad en cada emisión de Firestore: la comparación de props nunca
acierta. Para que memoizar sirva habría que estrechar las props primero.

**Trocear por rol rinde poco.** Las vistas son de 74 a 354 líneas y usan entre 6 y 32 definiciones
del mismo archivo; lo pesado (Firebase, `OrderCard`, formularios de evidencia, tarjetas de wallet)
lo comparten los cuatro roles. El chunk grande es UI compartida, no código por rol.

## Carga diferida

`JSZip`, `QRCode` y `jsQR` entran por `import()` dentro de la función que los usa, no en la cabecera:
las tres solo hacen falta después de un clic, y el mensajero no exporta a Excel ni imprime rótulos.
JSZip tiene una sola puerta de entrada (`downloadXlsx` en `src/lib/order-export.ts`).

Tras tocar el bundle, repetir la comprobación de `browserslist` que documenta el CLAUDE.md:
descargar los chunks de producción y verificar que `grep -o 'static{'` da **0**. Un
`class static block` es un error de SINTAXIS en iOS 14 y tira el bundle entero.

## Pendiente

**El admin sigue bajando el ledger completo.** `getPlatformPosition`
(`functions/src/platform-position.ts`) ya calcula en servidor las quince cifras que lo obligan, y
una prueba ata su aritmética a la del cliente. Lo que falta es recortar la suscripción, y no es
trivial: **seis** consumidores necesitan asientos ya liquidados —`settlementFinancialView`,
`settlementLiquidationRow`, `ClosedSettlementDetail`, `buildLiquidationOrderAudits` sobre el wallet
completo, `summarizeWalletPeriod` por rango y `orderCashToReturnCop`—. Recortar exige que la tabla
de liquidaciones cerradas cargue los asientos de cada corte bajo demanda (sus ids ya vienen en
`settlement.walletEntryIds`). Es la pantalla donde un error se ve como dinero mal, así que merece su
propio cambio y su propia verificación.

**Búsqueda en servidor para líder y mensajero.** `findFirestoreOrders` ya soporta el scoping, pero
la UI lo cierra a los roles con ventana. Abrirlo pediría seis índices más
(`driverId`/`messengerId` × `trackingCode`/`shopifyOrderId`/`customerPhone`).
