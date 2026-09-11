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

## Lider de comunidad (rol nuevo, spec 001)

**Presupuesto de diseno: CERO pedidos.** El rol no descarga la coleccion `orders` en ningun
momento; las reglas se lo prohiben y `getOrdersForContext` devuelve `[]` para el. Sus cifras
llegan agregadas del servidor por `getCommunityStats`, que solo hace `count()` y `sum()`.

Lo que si descarga: su comunidad (1 documento), las tiendas de su comunidad (N, decenas como
mucho) y sus cortes. Nada mas: ni un pedido ni un asiento de wallet.

### RNF_01 se cumple: la suscripcion de wallet del lider se elimino (11-09-2026)

| Pedidos en el periodo | Asientos que baja el lider | Peso |
|---|---|---|
| 100 | 0 (antes de T42: 100) | 0 KB (antes de T42: 27,3 KB) |
| 10.000 | 0 (antes de T42: 10.000) | 0 KB (antes de T42: 2,67 MB) |

**La cuenta no depende del volumen porque la consulta ya no existe.** RNF_01 exige que las dos
filas den lo mismo, y dan lo mismo: cero.

Lo que resolvio el requisito no fue encontrar como acotar la consulta, sino descubrir que **no
habia que consultar nada**. `CommunityLeaderView` no lee `state.wallet` en ningun punto —
comprobado sobre el cuerpo entero de la vista—. Las dos cifras de cashback del panel salen de otro
sitio:

- **CAUSADO**: agregado en el servidor, `getCommunityStats` -> `cashbackAccruedCop`, que solo hace
  `count()` y `sum()` en Firestore y no descarga un solo documento.
- **PAGADO**: `communityCashbackPaidCop` sobre `state.settlements`, que son decenas de documentos.
- **PENDIENTE**: la resta de los dos. Tampoco necesita un asiento.

O sea que el rol bajaba un documento por pedido cerrado de su comunidad **para no leerlo**. En T42
la suscripcion se ELIMINO; no se acoto.

Por que acotarla no habria bastado: el filtro `where("settlementId","==","")` que si tiene el rol
`seller` no sirve aqui, porque todo asiento nace sin liquidar y dentro de un periodo abierto la
cuenta seguiria subiendo uno a uno (lo fija una prueba, para que nadie "arregle" RNF_01 anadiendo
ese where). Acotar de verdad habria pedido una ventana de fecha o agregacion en servidor.

**No confundirlo con la deuda del admin.** El administrador tambien baja `walletEntries` entera
(3,58 MB, el 68% de su carga) y eso sigue pendiente —ver "Pendiente", mas arriba—, pero es un caso
**distinto**: ahi el dato SI se lee. Seis consumidores necesitan asientos ya liquidados, y
`buildAdminCommunityList` deriva de ellos el cashback causado por comunidad. Por eso ese caso pide
agregacion en servidor o rescate por id, y este solo pedia borrar la consulta.

**Como se midio, y por que no contra produccion.** `buildWalletEntries` es puro y determinista, asi
que la cuenta se deriva exacta sin datos reales. En `src/lib/community-cashback-entries.test.ts` hay
**tres** bloques `T42 · RNF_01`:

1. *la carga del lider frente al volumen* — cuenta los documentos con 100 y con 10.000 pedidos. Va
   con control negativo (tienda y domiciliario, que si crecen: 18.000 y 10.000 asientos con 10.000
   pedidos) para que un espejo roto que devuelva cero para todo el mundo no deje pasar la prueba en
   vacio.
2. *la consulta de wallet del lider no existe en el codigo* — lee `state-store.ts` COMO TEXTO y
   comprueba que la rama del lider no abre ningun target de `wallet`, que conserva `settlements`, y
   que `getWalletForContext` tiene rama propia que devuelve vacio.
3. *las cifras del panel no salen de la wallet del navegador* — fija la procedencia de las dos
   cifras (agregado del servidor y cortes). Es lo que justifica que la suscripcion sobrara: si
   manana alguien hace depender el panel de `state.wallet`, esta prueba es la que lo discute.

El segundo es una comprobacion de fuente y puede dar falso rojo si alguien reescribe el bloque con
otra sintaxis. Se acepta a proposito: el fallo que previene es silencioso —la app funciona, solo
baja megabytes de mas—, y un rojo que obliga a mirar la consulta sale barato comparado con eso.

Medirlo contra produccion habria exigido meter 10.000 pedidos sinteticos en la coleccion `orders`
de la plataforma viva, que es la fuente de verdad del dinero: contaminaria `getPlatformPosition`,
`getOrderStats`, los cortes y el panel del admin. **No se hizo a proposito.** Lo que si falta tomar
contra produccion, cuando exista una comunidad real, es el tiempo hasta ver cifras en el perfil de
red de las demas mediciones; la cuenta de documentos, que es la mitad sustantiva del requisito, ya
esta respondida.

El instrumento de siempre sigue sirviendo para esa segunda mitad:

```
localStorage.setItem("kentro-perf","1")
```

**La trampa a vigilar aqui** es la de siempre en este proyecto: la carga inicial y los targets de
`subscribeFirestoreState` son dos sitios y hay que tocar los dos. Si solo se toca uno, el primer
pintado y el listener muestran cosas distintas. En T42 el segundo sitio era `getWalletForContext`,
que ademas **estaba mal**: no tenia rama de `community_leader`, asi que el lider caia al
`getCollection("walletEntries")` final —la coleccion ENTERA— bajo un comentario que llama a esa
funcion "espejo exacto" de la suscripcion. Quedaba tapado porque la suscripcion metia `wallet` en
`skip`; al quitarla, sin esa rama el primer pintado habria pedido la coleccion completa y las
reglas habrian respondido 403.
