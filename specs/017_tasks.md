# Tareas — Spec 017: volver a importar no pisa lo operado

- **Spec:** `specs/017_reimportar_no_pisa_lo_operado.md` (aprobada 2026-09-17)
- **Plan:** `specs/017_plan.md`
- **Comando de pruebas:** `npm test` (raiz). Tipos: `npx tsc --noEmit` en raiz y en `functions/`.

**Orden obligatorio:**
1. **T1 a T7** (nucleo puro) antes de tocar ninguna via (T8 a T11). Cambiar una via con el nucleo a
   medias es reescribir la creacion de pedidos sin red de seguridad, que es el incidente del webhook
   otra vez.
2. **T1 -> T16 -> T12.** T16 escribe la marca en `orders.ts` importando la constante que crea T1, y
   la guarda **(7)** de T12 comprueba justamente eso. T16 es la unica excepcion a la regla 1: toca codigo
   de produccion fuera del nucleo, pero no es una via de importacion — es el callable que pone la
   senal que el nucleo lee. La prueba de RF_17 (T3) es pura y se construye su propia fixture con la
   marca, asi que **no** depende de T16.
3. **T17 va entre dos despliegues**, no antes de todos: primero se suben las dos callables que sellan
   (T16), luego se corre el relleno, y solo entonces el resto de functions. Si el relleno corriera
   antes de que el sello exista, toda edicion manual hecha en esa ventana se quedaria sin marca para
   siempre. Ver §6 del plan.
4. **T17 antes que T12**, aunque esté listada después: la guarda (9) de T12 comprueba el guion de
   relleno, que lo escribe T17. La regla 3 dice cuándo se CORRE el relleno; esta dice cuándo se
   ESCRIBE. Es la única de las nueve guardas que no tenía regla de orden, y T12 se exige a sí misma
   no pedir nada que nadie haya escrito aún.
5. **T14 antes que T12.** La guarda (5) de T12 comprueba que el principio ya esta en la constitucion,
   y quien lo escribe es T14: al reves, `npm test` queda en rojo entre una y otra sin que nadie haya
   hecho nada mal. Se conservan los numeros —el orden de ejecucion no es el orden de la lista— para
   no mover el registro del arnes.

En cada tarea la prueba se escribe **primero** y debe fallar antes de existir el codigo.

**Nota sobre el alcance de T1 a T7:** las siete declaran los mismos dos archivos, asi que el arnes no
distingue una de otra; el corte real es por grupo de politica, no por archivo. Se asume a proposito —
es TDD incremental sobre un unico modulo puro, el patron de `wallet-entries.ts` y de la spec 018— y la
garantia de que ninguna se pasa de la raya es la prueba de cada una, no el bloqueo por ruta.

---

## Nucleo puro

- [ ] **T1: Esqueleto del nucleo y salida temprana en creacion**
  * Requisitos cubiertos: RF_10, RF_11, RF_18
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: tipos (`OrderPhase`, `ExistingOrderFacts`, `PreservedGroup`, `MergeResult`),
    `existingFactsFrom()`, `orderPhase()` con las **cinco** fases —`imported` sin marca de edicion es
    la unica sin confirmar, y **cualquier pedido no cerrado con marca es `edited`**, tambien si ya se
    confirmo— y la lista cerrada de estados
    cerrados, la constante **exportada** `MANUAL_EDIT_STAMP` (la escribe T16 y la lee el nucleo: una
    sola constante para los dos lados), `mergeImportedOrder()` con la salida temprana literal de
    `phase === "new"`, y `viewAfterMerge(existingRaw, merged)` —la vista que la via devuelve al cliente: parte de
    `{...existingRaw, ...merged.doc}` y **quita las claves de `merged.clear`**; pura para que sea
    probable (§2.45 del plan)—. Los grupos de campos se declaran como tabla de
    datos, no como `if`s sueltos. **El modulo exporta la lista canonica de las cuatro exenciones de
    RNF_01** como codigo (`export const IMPORT_WRITE_EXEMPTIONS: Record<string, string>`, archivo ->
    razon), no como comentario: la guarda de T12 lee las fuentes sin comentarios, asi que una lista
    en la cabecera le seria invisible.
  * Verificacion: `existing: null` devuelve `doc` identico a **`stripUndefined(incoming)`** campo a
    campo (igualdad profunda) y `preserved: []`, **con una fixture de tienda SIN comunidad** —sello
    en `undefined`, el caso que tumbo el webhook en septiembre—: comparar contra el `incoming` crudo
    haria fallar la prueba justo en el caso real; `orderPhase` clasifica las **cinco** fases, con
    cuatro casos explicitos: `imported` + marca -> `edited`, **`ready_to_assign` + marca -> `edited`**
    (la marca sobrevive a la confirmacion: editar y confirmar despues es el flujo normal),
    `address_risk` -> `open` (no `unconfirmed`) y **un `existing` sin `status` -> `open`**, que es lo
    conservador (tratarlo como sin confirmar refrescaria cliente y condiciones de entrega); ninguna
    fase existente emite `status`; **`trackingCode`, `createdAt` y `evidence` se omiten solo si el
    pedido ya los tiene** —si no, pasa el entrante, que es lo que hace hoy el codigo (`evidence ?? []`,
    `createdAt ?? order.created_at ?? now`) y lo que RF_11 pide al decir "como ya hace hoy": un pedido
    sin fecha de creacion que no la recibiera nunca saltaria al dia de la corrida en cada carga—;
    `viewAfterMerge` devuelve el pedido completo aunque el parche omita claves **y sin las claves de
    `clear`**, que se acaban de borrar (si no, la vista del admin traeria la geocodificacion vieja); **`clear` sale vacio en
    toda fase que no sea `unconfirmed`** (RF_18, cuyo contenido prueba T3).

- [ ] **T2: Pertenencia — el pedido no cambia de dueno**
  * Requisitos cubiertos: RF_01, RF_12
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: grupo `ownership` (`driverId`, `messengerId`, `pickupBatchId`) conservado en las tres
    fases existentes, **omitiendo la clave** en vez de reescribir el valor guardado.
  * Verificacion: un pedido `in_route` con lider y mensajero produce un `doc` que **no contiene** esas
    claves; prueba dedicada a que `driverId` nunca sale como `null` ni `undefined` en ninguna fase
    (es la forma exacta del bug del 15-09); un pedido `delivered` tampoco las emite.

- [ ] **T3: Datos del cliente segun el estado**
  * Requisitos cubiertos: RF_02, RF_03, RF_17, RF_18
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: grupo `customer` (`customerName`, `customerPhone`, `addressRaw`, `normalizedAddress`,
    `lat`, `lng`, `geoProvider`): se refresca en `unconfirmed` y se conserva en `edited`, `open` y
    `closed`. **En `edited` se conserva ademas el catalogo entero, `totalCop` incluido** (RF_17):
    `updateImportedOrder` deja editar a mano productos, cantidades y valor total de un pedido sin
    confirmar, y el valor total es dinero.
  * Accion (2): al refrescar la direccion de un pedido sin confirmar, `clear` nombra la
    geocodificacion derivada (`normalizedAddress`, `lat`, `lng`, `geoProvider`) para que la via la
    borre (RF_18): ninguna importacion la trae, y dejarla dejaria el pedido apuntando a la direccion
    vieja y a la nueva a la vez.
  * Verificacion: **tres** casos, no dos, porque la frontera tiene tres lados — `imported` sin marca de
    edicion recibe la direccion entrante; `imported` **con** marca conserva direccion, cliente,
    condiciones **y catalogo con `totalCop`** (RF_17) — la parte de RF_17 que toca dinero se prueba
    aqui, no en T6—, y **un pedido ya confirmado con marca tambien conserva su catalogo**: es el caso
    que deja expuesto el dinero si la marca solo valiera mientras el pedido siga sin confirmar; y
    `clear` trae los cuatro campos de geocodificacion en el pedido sin confirmar y sale **vacio** en
    todas las demas fases (RF_18);
    `ready_to_assign` con direccion corregida la conserva. Ademas el caso del bot: un pedido
    confirmado por ChatBy al que nadie edito a mano cae del lado de conservar.

- [ ] **T4: La revision de direccion no vuelve a empezar**
  * Requisitos cubiertos: RF_04
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: `addressRisk` se conserva cuando el guardado es `accepted` o `rejected`; si es `review`
    o falta, pasa el entrante.
  * Verificacion: `accepted` guardado + `review` entrante no emite la clave; `review` guardado la
    deja pasar sin cambio observable.

- [ ] **T5: Sello de comunidad — congelar, rellenar solo si esta vacio**
  * Requisitos cubiertos: RF_05, RF_06, RF_07
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: `communityId` y `communityPricing` se conservan si hay sello; si esta vacio y el pedido
    sigue abierto, pasa el entrante; si esta vacio y el pedido esta cerrado, se conserva el vacio.
  * Verificacion: los tres casos, mas el de un pedido cerrado sin sello (RF_07), que es el flanco
    que se anadio en el escrutinio.

- [ ] **T6: Catalogo — un pedido cerrado congela sus productos**
  * Requisitos cubiertos: RF_08, RF_09
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: `lineItems`, `productName`, `sku`, `quantity`, `totalCop` y **`productId`** se refrescan mientras el
    pedido este abierto o sin confirmar **y sin editar a mano**, y se conservan en `closed` y en
    `edited` (RF_17, probado en T3).
  * Verificacion: pedido `in_route` con un articulo anadido en la tienda recibe el catalogo nuevo;
    pedido `delivered` con el mismo cambio no emite ninguna de las **seis** claves (`productId`
    incluido: lo escriben las dos ediciones manuales y RF_09/RF_17 congelan "los productos"); **un pedido que se
    cierra entre dos reimportaciones** (dos merges seguidos, el segundo con el pedido ya `delivered`)
    actualiza en el primero y conserva en el segundo — la frontera es el estado en el momento de
    escribir, que es el caso limite de la spec que no tenia prueba.

- [ ] **T7: Procedencia, condiciones de entrega y resumen de lo conservado**
  * Requisitos cubiertos: RF_13 (parte pura), RF_14, RF_15, RF_16
  * Archivos: `functions/src/order-import-merge.ts`, `src/lib/order-import-merge.test.ts`
  * Accion: grupos `provenance` (`source`, RF_16: se conserva en TODA fase existente, tambien sin
    confirmar) y `delivery_terms` (`pickupPointName`, `pickupAddress`, `paymentMethod`,
    `fulfillmentMode`, RF_15: se refrescan solo sin confirmar); calculo de `preserved` con
    comparacion estructural para `lineItems` y estricta para escalares.
  * Verificacion: `preserved` nombra los grupos correctos por fase; un entrante identico al guardado
    devuelve `preserved: []` (RF_14) — con **dos sellos de precio de fechas distintas e importes
    iguales**, que es el caso real: el sello lleva dentro su fecha de calculo y las vias lo recalculan
    en cada corrida, asi que una fixture con el mismo `frozenAt` pasaria en verde con produccion rota; en dos pasadas seguidas, aplicar el `doc` de la segunda sobre
    el pedido **no cambia ningun valor**, en cualquier fase — se compara el documento resultante y
    **no** se exige "solo `updatedAt`": los campos de identidad se refrescan siempre y siempre salen,
    y en un pedido sin confirmar salen ademas cliente, catalogo y condiciones de entrega con el mismo
    valor. El caso limite de la spec pide que no cambie ningun dato, no que no se emita ninguna
    clave;
    `source` de un pedido nacido por webhook sobrevive a una reimportacion.

## Vias de entrada

- [ ] **T8: La reimportacion y la importacion manual pasan por el nucleo**
  * Requisitos cubiertos: RF_01 a RF_12, RF_15 a RF_18, RNF_01 (la via hereda la politica entera)
  * Archivos: `functions/src/shopify.ts`
  * Accion: obtiene `existing` con `existingFactsFrom(snapshot)` — **nunca `existing.data() ?? {}`**,
    que convertiria un pedido nuevo en uno existente vacio— y construye el candidato **con sus valores de creacion intactos,
    `driverId: null` incluido**, y delega la decision en `mergeImportedOrder`. Lo que desaparece no
    es el literal: es que ese valor llegue a un pedido que ya existe — de eso se encarga el nucleo
    omitiendo la clave. **Desaparecen tambien los tres `existing.data()?.…` de `shopify.ts:719-724`**
    (`status`, `evidence`, `createdAt`): ya conservaban bien, pero son la regla duplicada que RNF_01
    viene a unificar. **El `trackingCode` de `shopify.ts:692` NO desaparece**: se sigue pidiendo de
    forma perezosa (`existing?.trackingCode ? existing.trackingCode : await nextTrackingCode(transaction)`
    — la condicion es "¿tiene codigo?", no "¿existe?": un pedido existente sin codigo debe seguir
    recibiendo uno, como hoy) porque
    ese contador **escribe** `counters/orders`; pedirlo siempre quemaria un KNT y tocaria un
    documento caliente por cada pedido ya existente de la corrida, de forma invisible. Se mantiene el
    calculo del sello fuera de la transaccion y el orden de lecturas, tal cual.
  * Accion (1b): **aplica `clear`** (RF_18): cada clave que el nucleo nombra se escribe como
    `FieldValue.delete()` en el mismo `set(merge: true)`. El nucleo nombra; la via borra.
  * Accion (2): la funcion **devuelve la vista del pedido despues de la escritura**
    (`{ ...existingRaw, ...doc }`), no el parche. Su respuesta viaja al navegador del admin
    (`operations-app.tsx:10986` hace `result.orders.forEach(onImported)` y reemplaza el pedido en
    memoria): devolver el parche pintaria tarjetas sin lider ni estado justo despues de reimportar.
    Se usa `viewAfterMerge(...)` del nucleo, ya probado en T1: `upsertShopifyOrder` no se exporta,
    llama a `getFirestore()` y no hay emulador, asi que una prueba propia de esta via no seria
    ejecutable — la garantia esta en el helper puro y en la guarda de T12. **Contrato exacto:**
    `upsertShopifyOrder` devuelve `{ order: viewAfterMerge(existingRaw, merged), merged }` —el
    `MergeResult` entero, que es lo que el acumulador de T11 necesita—, y las dos
    callables siguen respondiendo lo de siempre (`{ order }` y `orders: Order[]`): `phase` y
    `preserved` son para quien acumula el resumen, no para el navegador, que mete la respuesta
    directa en su estado.
  * Accion (3): **desaparece la prelectura de `shopify.ts:475`**, y `imported`/`existing` pasan a
    salir del `phase` que devuelve la funcion. **La respuesta de `syncShopifyHistoricalOrders`
    conserva todos sus campos** (`imported`, `existing`, `skippedOutsideCali`, `skippedSkuFilter`,
    `fetched`): el admin los imprime en su mensaje de sincronizacion
    (`operations-app.tsx:10987`), y si alguno se queda sin calcular, ese mensaje sale con
    `undefined` a la vista. Ese numero pasa a salir del `phase`: dos
    fuentes de verdad para la misma cifra terminan divergiendo, y de paso se ahorra un `.get()` por
    pedido en un bucle de miles.
  * Accion (4): el **import manual** deja una linea de log con `preserved` cuando no viene vacio.
    No escribe resumen de corrida: importa de uno en uno, y un resumen por pedido es lo que RF_13
    evita.
  * Verificacion: `npx tsc --noEmit` en `functions/`; la guarda de T12 exige que shopify.ts importe
    el modulo **y que conserve su `driverId: null` de creacion**, y que lo devuelto salga de
    `viewAfterMerge` y no del parche; `npm test` en verde.
  * **Ojo:** quitar `driverId: null` del candidato crea pedidos sin el campo, y un documento sin el
    campo no empareja `where("driverId","==",null)`: el pedido nuevo no aparece en el pozo del lider
    ni en las cifras, sin error y sin aviso. Es el fallo que el analisis de coherencia atrapo.

- [ ] **T9: El webhook de Shopify pasa por el nucleo**
  * Requisitos cubiertos: RF_01 a RF_12, RF_15 a RF_18, RNF_01 (la via hereda la politica entera)
  * Archivos: `functions/src/index.ts`
  * Accion: sustituir los `existingData.*` sueltos por la delegacion en el modulo, y con ellos el
    `const existingData = existing.data() ?? {}` de `index.ts:166`: ese `?? {}` es exactamente lo
    que haria nacer un pedido vacio si llegara al nucleo como `existing`. **Aplica `clear`** igual
    que T8 (RF_18). **El `trackingCode` sigue
    siendo perezoso**, por el mismo motivo que en T8 — y aqui importa mas: los reintentos de Shopify
    fueron ~2.000 en el incidente de septiembre. El webhook **no escribe resumen de corrida** (seria
    uno por pedido): deja una linea de log cuando `preserved` no viene vacio. El candidato
    vuelve a declarar sus valores de creacion (`driverId: null`, `status: "imported"`, `evidence: []`,
    `createdAt`) y es el nucleo quien decide omitirlos cuando el pedido ya existe. Es la via por la
    que entran DANDA y Kovia: no puede quedarse a medias.
  * Verificacion: `npx tsc --noEmit` en `functions/`; guarda de T12; `npm test` en verde.

- [ ] **T10: Las tres vias que hoy son seguras por accidente**
  * Requisitos cubiertos: RF_10, RF_12, RF_18, RNF_01
  * Archivos: `functions/src/store-webhook.ts`, `functions/src/onstock-webhook.ts`,
    `functions/src/contact-form.ts`
  * Accion: pasar por `mergeImportedOrder`. `store-webhook.ts` y `onstock-webhook.ts` pasan
    `existingFactsFrom(existing)` —ya leen su snapshot—, **no un `null` escrito a mano**: si lo
    hicieran, el dia que alguien quite su salida temprana el nucleo trataria un pedido operado como
    nuevo y volveria el incidente. `contact-form.ts` si pasa `null`, porque su id es nuevo siempre.
    Aplican `clear` como las demas (RF_18), aunque hoy salga siempre vacio: la regla es de la via,
    no del caso. Cambio sin efecto observable hoy; existe para que manana no puedan equivocarse
    (RNF_01).
  * Verificacion: `npx tsc --noEmit` en `functions/`; guarda de T12 las acepta; ninguna prueba
    existente de creacion cambia de resultado.

- [ ] **T11: Resumen de corrida**
  * Requisitos cubiertos: RF_13, RF_14
  * Archivos: `functions/src/shopify.ts`, `functions/src/import-run-summary.ts`,
    `src/lib/import-run-summary.test.ts`, `firestore.rules`
  * Accion: acumular `ImportRunSummary` durante una **reimportacion por rango** —no en el import
    manual, que es de un pedido por llamada— y escribirlo en `importRuns` al terminar, con tope de
    500 codigos y marca `truncated`. **La acumulacion va FUERA de la transaccion**, desde el
    `MergeResult` devuelto: dentro del callback, Firestore lo reintenta y los recuentos se inflan sin
    error (el webhook acumulo ~2.000 reintentos en septiembre), incumpliendo RF_13 en silencio.
    `ordersExisting` sale del `phase` del nucleo, no de la prelectura. Ni el webhook ni el import
    manual escriben resumen (la linea de log del webhook la pone T9, que es quien posee `index.ts`).
    Lectura admin-only en `firestore.rules`.
  * Verificacion: el acumulador es puro y se prueba sin Firestore (recuentos exactos aunque la lista
    se recorte, RF_13) **y un pedido que ya existia con `preserved: []` no suma ni al recuento ni a
    `affectedTrackingCodes` (RF_14)**, y **la procedencia va en su propio recuento, fuera de los
    afectados**: un pedido nacido por el aviso automatico siempre llega con procedencia distinta en
    una reimportacion por rango, asi que contarla como afectacion listaria miles de pedidos en cada
    corrida y el resumen no distinguiria nada; si sumara, una corrida sin novedades saldria con los
    contadores en cero y miles de codigos listados con `truncated: true` — el "resumen que miente por
    omision" que RF_13 prohibe, en su version mas enganosa. **La guarda de texto sobre
    `firestore.rules` la escribe T12**, que es la
    duena de `spec-017-guards.test.ts`: ponerla aqui chocaria con el alcance de archivos del arnes.
    **La comprobacion con un usuario real no admin va en la fase de smoke**, no aqui: desplegar
    reglas en mitad de `implement` se salta `/sdd-deploy` y no lo puede ejecutar `npm test`.

- [ ] **T16: La edicion manual deja marca**
  * Requisitos cubiertos: RF_17
  * Archivos: `functions/src/orders.ts`
  * Accion: **las dos** ediciones manuales sellan la marca al guardar, **importando
    `MANUAL_EDIT_STAMP` del nucleo**: `updateImportedOrder` (`orders.ts:464`, la tienda corrige un
    pedido sin confirmar) y `updateOrderAdjustments` (`orders.ts:660`, el admin ajusta producto,
    cantidad y **recaudo** de cualquier pedido no terminal — tambien uno que ya va en la calle) en vez de escribir el literal: dos literales sueltos pueden
    divergir y entonces RF_17 deja de activarse sin que nada falle. Nada mas de ese callable cambia:
    Nada mas de esos callables cambia: cada uno sigue exigiendo lo que exigia y escribiendo lo mismo.
  * Accion (2): `orders.ts` deja de repetir la lista de estados cerrados en **dos** sitios y los hace
    salir de `CLOSED_STATUSES` del nucleo: `TERMINAL_STATUS` (`:100`) y la lista en linea de
    `updateOrderAdjustments` (`:680`). Esa segunda es la que mas importa y es facil de pasar por alto:
    es la que decide si el admin puede ajustar producto y **recaudo**, asi que si divergiera, se
    podria ajustar el dinero de un pedido ya cerrado (principio 10, sin error). Las dos copias de
    `closedStatuses` (`:983` y `:1049`) **se dejan como estan**: gobiernan la anulacion y la reserva
    de inventario, no el ciclo que esta spec toca; unificarlas seria refactor fuera de alcance.
  * Verificacion: `npx tsc --noEmit` en `functions/`; la guarda **(7)** de T12 comprueba que **las
    dos** callables escriben el sello y que sale de la constante del nucleo — `orders.ts` esta exento del modulo y no hay
    emulador, asi que sin esa guarda RF_17 entraria en produccion sin ninguna red del lado servidor.

## Garantias y cierre

- [ ] **T12: Guarda de fuente — ninguna via se salta la regla**
  * Requisitos cubiertos: RF_13, RF_17, RF_18, RF_19, RNF_01, RNF_02, RNF_03
  * Archivos: `src/lib/spec-017-guards.test.ts`
  * Accion: sobre los `.ts` de `functions/src/` sin comentarios: (1) todo archivo que escriba en
    `orders` importa `order-import-merge` o esta en la lista de exentos declarada y justificada.
    **Escribir son cuatro verbos** (`set(`, `create(`, `update(` y las variantes de lote), no solo
    `.set(`, y el verbo MUST atarse a una **referencia derivada de `collection("orders")`**, no al
    archivo entero: `store-api.ts` lee pedidos y escribe en otras colecciones, asi que una heuristica
    por archivo lo marcaria y dejaria la suite en rojo el primer dia sin que nadie haya hecho nada
    mal. No necesita exencion; necesita que la guarda mire la referencia. tres vias escriben con `transaction.create(` y una guarda que solo mire `.set(` las da
    por buenas por un `.set(` ajeno del mismo archivo. **Exentos** (la lista y sus razones viven en
    `IMPORT_WRITE_EXEMPTIONS`, en el modulo — ver guarda (3)): `uchat-pull.ts` y `uchat-webhook.ts` (las dos confirmaciones de ChatBy, que
    corrigen la direccion a proposito), `order-corrections.ts` (la correccion administrativa, que
    reescribe pedidos cerrados por decision de una persona) y los callables de `orders.ts`, incluido
    `createManualOrder`. La guarda tambien exige que el `existing` venga de `existingFactsFrom(...)`
    y no de un `.data() ?? {}`, **con `contact-form.ts` como unica excepcion declarada** (pasa `null`
    literal porque su id es nuevo siempre); (2) las cinco vias **conservan
    su `driverId: null` de creacion** — la guarda al reves de lo que parece natural, porque lo que
    hay que impedir es que un pedido nazca sin el campo; (3) la exencion de ChatBy esta escrita donde
    vive la regla: la guarda lee `IMPORT_WRITE_EXEMPTIONS` de `order-import-merge.ts` (T1) —codigo
    exportado, no comentario— y no una lista propia, que se estaria comprobando a si misma;
    (4) `firestore.rules` declara la lectura de `importRuns` como admin-only;
    (5) `docs/constitution.md` contiene el principio nuevo con su fecha y los 34 pedidos — sin esto
    seria el unico artefacto de la spec sin comprobacion automatica; (6) `shopify.ts` escribe el
    documento de `importRuns`, y **la llamada al acumulador NO esta dentro del cuerpo de
    `db.runTransaction`** — es la unica parte de RF_13 que puede fallar en silencio (Firestore
    reintenta el callback y los recuentos se inflan sin error), y no la cubre ninguna prueba, ni el
    smoke, ni el DoD. `matchingClose`/`localFunctions` de `spec-005-guards.test.ts` hacen justo esto;
    (7) **`updateImportedOrder` y `updateOrderAdjustments`** escriben la marca de edicion **usando
    `MANUAL_EDIT_STAMP` del nucleo**, no un literal — es lo unico que activa RF_17 (T16), y la
    segunda ajusta el recaudo de pedidos que ya van en la calle; (9) `scripts/backfill-manual-edit-stamp.js`
    **carga** el modulo compilado en vez de repetir la decision (RF_19: la logica se prueba, el guion
    solo orquesta) — ninguna otra guarda mira `scripts/`, asi que sin esta el duplicado pasaria en
    verde; (10) `scripts/verify-017.js` tiene la forma que declara T15 —`--backup` obligatorio antes
    de `--compare`, `--restore` propio y `firebase-admin` desde `../functions/node_modules`—: ese
    guion corre contra produccion y lo lanza una persona, asi que sin esta guarda seria el unico
    artefacto de la spec sin comprobacion, y el repo ya guarda asi `verify-005.js` y `verify-013.js`;
    (8) **las cinco vias aplican el
    `clear` que devuelve el nucleo** — sin esto RF_18 quedaria en verde en el nucleo y sin efecto
    ninguno en produccion, que es la peor forma de cumplir un requisito.
  * Verificacion: la guarda pasa con el codigo de T8-T10 y con `orders.ts` **tal como queda tras
    T16** —por eso T12 va despues—, y con `uchat-webhook.ts` tal como esta hoy (si exigiera algo que
    nadie ha escrito aun, el primer `npm test` saldria en rojo sin que nadie haya hecho nada mal); **falla** al anadir un archivo de prueba que escriba pedidos con cualquiera de los cuatro
    verbos sin importar el modulo; **falla** al quitar el `driverId: null` de una via.

- [ ] **T13: Pruebas de mutacion y evidencia**
  * Requisitos cubiertos: RF_01, RF_10, RNF_02 (DoD 2)
  * Archivos: `.sdd/evidence/017/mutacion-rf01.txt`, `.sdd/evidence/017/mutacion-rf10.txt`,
    `functions/src/order-import-merge.ts`, `functions/src/shopify.ts`
  * Accion: dos mutaciones, una por cada fallo que hay que evitar. (1) Que el nucleo vuelva a dejar
    pasar el grupo `ownership` sobre un pedido que ya existe. (2) Quitar el `driverId: null` del
    candidato de `shopify.ts`. Correr `npm test` en cada una, guardar la salida en rojo y **restaurar
    el codigo** antes de seguir.
  * Verificacion: la primera cae por RF_01; la segunda **solo por la guarda 2 de T12** — ninguna
    prueba de comportamiento ejercita el candidato de `shopify.ts`, asi que ahi la guarda de texto
    no es un complemento sino la unica red, y esta evidencia es lo que lo demuestra; la suite
    vuelve a verde tras restaurar. Los dos archivos de codigo van en el alcance porque la tarea
    consiste precisamente en editarlos y devolverlos a su sitio.

- [ ] **T14: La regla entra en la constitucion**
  * Requisitos cubiertos: RNF_03
  * Archivos: `docs/constitution.md`
  * Accion: principio nuevo con el incidente que lo motiva — una importacion no puede cambiar de
    dueno un pedido, y `driverId: null` en un `merge` no es "no tocar" sino "borrar".
  * Verificacion: la guarda (5) de T12 lo comprueba en cada `npm test`; no es una lectura humana.

- [ ] **T17: Relleno de la marca de edicion**
  * Requisitos cubiertos: RF_19
  * Archivos: `functions/src/manual-edit-backfill.ts`, `src/lib/manual-edit-backfill.test.ts`,
    `scripts/backfill-manual-edit-stamp.js`
  * Accion: `ordersToStamp(auditEvents, orders)` **puro** decide que pedidos llevan marca y con que
    fecha —**la del evento de auditoria, no la del relleno**—; el guion solo lee, llama y escribe.
    Misma separacion que `order-corrections-plan.ts` / `order-corrections.ts`, y por el mismo motivo:
    el DoD exige prueba automatizada por requisito, y un guion contra produccion no lo es. Eventos de
    entrada: `order.imported_updated` (`orders.ts:520`) y `order.adjusted` (`:715`). Solo pedidos **no
    cerrados** y sin marca previa. Dry-run por defecto, `--apply` para escribir, precondicion por pedido.
    **El guion NO replica la logica**: hace `require("../functions/lib/manual-edit-backfill")` tras
    `cd functions && npm run build`. Es lo contrario de lo que hacen los 30+ guiones de `scripts/`, que
    duplican en JS — y esa costumbre es justo lo que aqui haria que RF_19 se cumpliera de mentira.
  * **Se corre ANTES de desplegar las vias.** Si se corre despues, entre el despliegue y el relleno
    cualquier reimportacion trata como "sin tocar" un pedido que si se corrigio, y le descarta la
    geocodificacion (RF_18) — el propio arreglo causando la perdida que viene a impedir.
  * Verificacion: `npm test` cubre `ordersToStamp` (pedido cerrado excluido, pedido ya marcado
    intacto, fecha igual a la del evento); el dry-run lista los pedidos y su motivo; tras `--apply`,
    ninguno de esos pedidos queda sin marca.

- [ ] **T15: Guion de verificacion contra produccion**
  * Requisitos cubiertos: RF_01, RF_02, RF_04, RF_05, RF_09, RF_15, RF_16 (DoD 4) — es la comprobacion de que
    los grupos protegidos siguen intactos con datos reales, no un tramite suelto del DoD.
  * Archivos: `scripts/verify-017.js`
  * Accion: `--backup <fecha>` (obligatorio antes de nada, porque el PITR esta desactivado),
    `--compare` y `--restore`, sobre el dia que elija el responsable.
  * **No reutilizar `scripts/restore-orders-from-backup.js`**: su cabecera dice que omite el pedido
    si ya existe, y el escenario del DoD 4 es justo ese — un pedido que sigue existiendo y quedo
    pisado. Usarlo en caliente no restauraria nada y pareceria que si.
  * Verificacion: la guarda (10) de T12 comprueba su forma en cada `npm test`; en ejecucion, sin
    archivo de copia el guion se niega a continuar; `--compare` lista los grupos
    protegidos pedido a pedido. **Lo ejecuta el responsable, no un agente** (principio 7).

---

## Cobertura: requisito -> tarea

| Requisito | Tareas |
|---|---|
| RF_01 (lider, mensajero y lote intactos) | T2, T8, T9, T13 |
| RF_02 (datos del cliente se conservan) | T3, T8, T9, T15 |
| RF_03 (se refrescan si sigue sin confirmar) | T3, T8, T9 |
| RF_04 (la revision de direccion no se reinicia) | T4, T8, T9, T15 |
| RF_05 (sello de comunidad congelado) | T5, T8, T9, T15 |
| RF_06 (se rellena si esta vacio y sigue abierto) | T5, T8, T9 |
| RF_07 (nunca se sella un pedido cerrado) | T5, T8, T9 |
| RF_08 (catalogo se actualiza si esta abierto) | T6, T8, T9 |
| RF_09 (catalogo congelado si esta cerrado) | T6, T8, T9, T15 |
| RF_10 (un pedido nuevo se crea igual que hoy) | T1, T8, T9, T10, T13 |
| RF_11 (estado, evidencia, fecha y codigo) | T1, T8, T9 |
| RF_12 (nunca se queda sin lider) | T2, T8, T9, T10 |
| RF_13 (resumen por corrida) | T7, T11, T12 |
| RF_14 (solo cuenta lo que se iba a pisar) | T7, T11 |
| RF_15 (condiciones de entrega) | T7, T8, T9, T15 |
| RF_16 (procedencia, en cualquier estado) | T7, T8, T9, T15 |
| RF_17 (editado a mano = ya trabajado) | T3, T8, T9, T12, T16 |
| RF_18 (la geocodificacion vieja se descarta) | T1, T3, T8, T9, T10, T12 |
| RF_19 (relleno de la marca antes de desplegar) | T12, T17 |
| RNF_01 (una sola regla, seis vias, cuatro exentas) | T8, T9, T10 (la implementan), T12 (la verifica) |
| RNF_02 (comprobacion sin red en cada cambio) | T12, T13 |
| RNF_03 (queda en la constitucion) | T12, T14 |

**Sin requisitos huerfanos:** los 19 RF y los 3 RNF aparecen en al menos una tarea, y **ninguna
tarea carece de requisito de respaldo** (T15 se ata a los grupos protegidos que comprueba).
