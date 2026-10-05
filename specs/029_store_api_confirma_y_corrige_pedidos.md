# Spec 029: Una tienda puede confirmar, corregir y cancelar sus pedidos por API, sin pisar lo operado

- **Estado:** aprobada (2026-10-04, con las respuestas propuestas por Claude y aceptadas por el responsable; el
  mismo dia el responsable ratifico la precision de la decision 2, acoto el historial a API y panel (decision 6) y
  metio en esta spec que la tienda no vea identidades de Kentro en el historial (decision 7); precisada tras
  `/sdd-analyze` el 2026-10-04 y el 2026-10-05, seccion 10)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-02 (aprobada y contrastada contra el codigo el 2026-10-04)
- **Origen:** peticion de CENTRAL (plataforma de operacion de Kovia y ONEP), "Spec · Confirmar y corregir pedidos
  por API en Kentro", del 2-oct-2026. CENTRAL va a confirmar con el cliente por WhatsApp, con un agente propio,
  antes de que el pedido salga a ruta.
- **Prioridad:** alta. Es una integracion de un cliente activo y abre la primera via de escritura externa sobre
  pedidos.
- **Accesibilidad:** WCAG 2.2 AA
- **Numeracion:** redactada como "Spec 028"; renumerada a 029 porque la 028 es "abrir la app no escribe nada".
- **Siguientes:** la spec 030 (webhook firmado hacia la tienda, OPC_01) va inmediatamente despues; la 031
  (historial de importaciones y ChatBy) recoge lo que esta spec deja fuera del historial; la 032 (auditoria solo
  de servidor) cierra la mitigacion de RF_27 y estudia el hueco declarado en RF_16.

## 1. Contexto y objetivo

Hoy la API de tiendas (`/storeApi`, `functions/src/store-api.ts`) es **solo de lectura**: responde 405 a todo lo
que no sea `GET`, y expone `/resumen`, `/kpis`, `/orders`, `/settlements` y, en la raiz, un indice (`docs`). La
autenticacion es `sellerId` por query **mas** una key, por query (`key=`) o por `Authorization: Bearer`; la key
se guarda **en claro** en `storeApiConfigs/{sellerId}.apiKey` (coleccion sin acceso de cliente), con
`status: "active"`, y se compara en tiempo constante. La genera y rota `createStoreApiKey` (roles `admin` y
`seller`; el `seller_logistics` no), que **devuelve la key completa cada vez que se consulta**. En el panel solo la
tienda tiene la tarjeta "Clave de API"; el admin no tiene pantalla para ella.

Cada tienda confirma sus pedidos de dos formas: a mano en el panel (`confirmImportedOrder`), o con la integracion
de ChatBy/UChat (`uchat-pull.ts`, cada 2 horas, y `uchat-webhook.ts`), que pasa de `imported` a
`ready_to_assign` los pedidos confirmados y de paso puede reescribir `addressRaw` y `customerName` con lo que dijo
el cliente.

CENTRAL quiere confirmar por su cuenta y, en la misma conversacion, corregir los datos de entrega o cancelar.
Para eso pide escritura por API. **Su peticion tiene un supuesto equivocado sobre los estados**, y esta spec lo
corrige:

| CENTRAL lo entiende asi | En Kentro es asi |
|---|---|
| `CALL_PENDING` = pendiente de confirmar con el cliente | `call_pending` es la llamada que hace el **mensajero que ya recogio el pedido** (`picked_up` → `call_pending`). El pedido ya tiene lider y esta en curso |
| Confirmar = sacar el pedido de la cola de llamadas | Confirmar = **`imported` → `ready_to_assign`**, la misma transicion que hacen hoy el panel y ChatBy |
| Editable = IMPORTED, READY_TO_ASSIGN, CALL_PENDING | Editable = `imported`, `address_risk` o `ready_to_assign` **y sin lider** (`driverId` vacio) |

Si se construyera tal como lo pidieron, una confirmacion o una correccion por API podria caer sobre un pedido que
ya va en la calle. Es exactamente el "clobber" que la regla de oro 1 prohibe.

**Lo que hay en el codigo y condiciona esta spec** (contrastado el 2026-10-04):

- `GET /orders` ya devuelve `shopifyOrderId` y `updatedAt` en cada pedido. Hoy lee **todos** los pedidos de la
  tienda y filtra en memoria; `from`/`to` son opcionales (sin ellos no hay ventana) y los parametros que no
  reconoce se ignoran.
- `confirmImportedOrder` solo acepta `imported` (cualquier otro estado da `failed-precondition`), pone
  `addressRisk: "accepted"`, `confirmedVia: "manual"` y audita `order.seller_confirmed`.
- `updateImportedOrder` solo acepta `imported`, exige el pedido **entero** (cliente, direccion, pago, modo,
  valor y producto) y deja la marca `MANUAL_EDIT_STAMP` (`manuallyEditedAt`, spec 017). Su auditoria
  (`order.imported_updated`) solo trae un `summary`: **no guarda que campo cambio ni sus valores**.
- `cancelOrder` deja cancelar a la tienda cualquier pedido no cerrado que no este recogido (incluido `assigned`),
  con motivo **opcional** que guarda en `callNote`, libera inventario si el pedido lo reservo, y da error si el
  pedido ya esta cancelado.
- `address_risk` **no lo produce ninguna importacion**: las cinco vias crean el pedido en `imported` con
  `addressRisk: "review"`. Lo producen el alta manual marcada "revisar", el reintento confirmado de un pedido
  marcado "revisar" (`confirmRetryOrder`) y la toma por un lider de un pedido marcado "revisar" — este ultimo
  caso deja un `address_risk` **con lider**. Lo resuelve solo el admin, con "Aceptar direccion" (`resolveAddress`
  en `src/lib/actions.ts`, via `applyOrderTransition`), sin geocodificar. No existe ningun detector automatico de
  direccion dudosa. `normalizeAddress` existe solo como **endpoint stub sin uso**: no lo llama ninguna via de
  importacion, ni la app, ni ninguna callable, y no puntua ni geocodifica.
- La cobertura es por ciudad: coleccion `cities` con `active`, y zonas (`zones`) colgadas de una ciudad. Todas las
  importaciones escriben `cityId: "city-cali"`; la ciudad que escribe el cliente va dentro de `addressRaw`.
- No existe una "franja de entrega" que ponga la tienda: `scheduledWindow` la fija el mensajero al agendar
  (`call_pending` → `scheduled`).
- La reimportacion conserva siempre el `status` (`order-import-merge.ts`): un pedido cancelado o confirmado en
  Kentro no cambia de estado porque Shopify lo reenvie, y ninguna via propaga hoy una cancelacion de Shopify.
- El historial por pedido ya existe para el panel: `getOrderAuditTrail` lee `auditEvents` por `entityId` y la
  tarjeta del pedido lo pinta ("Historial del pedido", `OrderAuditTrail` en `operations-app.tsx`). **A la tienda
  (`seller` y `seller_logistics`) le devuelve el uid, el nombre y el correo de quien actuo en Kentro**, y la
  tarjeta los pinta. Las importaciones de Shopify no escriben `auditEvents` (dejan `importRuns`).
- `firestore.rules` (`operationalOrderUpdateByAssignee`) deja que el lider o el mensajero asignados cambien desde
  el cliente el `status` de un pedido en curso (`assigned`, `call_pending`, `scheduled`, `picked_up`,
  `in_route`, `retry_pending`) sin pasar por una callable. Esos cambios no pasan por ningun codigo de servidor
  (ver el limite conocido de RF_16).

**Objetivo:** que una tienda autorizada pueda, por API, encontrar un pedido, confirmarlo, corregir sus datos de
entrega y cancelarlo **solo mientras no tenga lider**, con la misma regla y la misma auditoria que el panel, un
historial consultable por pedido, y errores y seguridad que un integrador pueda programar sin adivinar; y que la
tienda deje de ver identidades de quien opera en Kentro.

## 2. Glosario

| Termino | Significado en Kentro |
|---|---|
| Pedido editable | Estado `imported`, `address_risk` o `ready_to_assign` **y** `driverId` vacio (nulo o ausente). Un `address_risk` con lider NO es editable |
| Pedido en curso | Con lider, o en `assigned`, `call_pending`, `scheduled`, `pickup_pending`, `picked_up`, `in_route`, `retry_pending` |
| Pedido final | `delivered`, `liquidated`, `failed`, `cancelled` (los `CLOSED_STATUSES` de `order-import-merge.ts`) |
| Origen | Quien hizo el cambio: `panel` (una persona en Kentro o en la tienda, por la app) o `api` (la tienda por API). `shopify` (cualquier via de importacion) y `chatby` (la confirmacion automatica) quedan para la spec 031 |
| Datos de entrega | Nombre del cliente (`customerName`), telefono (`customerPhone`), direccion completa (`addressRaw`), indicaciones (`deliveryNotes`, spec 013) y ciudad (`cityId`) |
| Ciudad cubierta | Una ciudad de la coleccion `cities` con `active: true` |
| Etiqueta de actor para la tienda | Lo unico que la tienda ve de quien hizo algo: "Kentro" (personas y procesos de la plataforma), "Tu tienda" (usuarios de esa misma tienda) o "API" (la key de escritura de la tienda) |
| Key de lectura | La key actual de la tienda (`storeApiConfigs.apiKey`), que sigue funcionando como hoy |
| Key de escritura | Una key nueva, distinta, que ademas puede escribir. Kentro solo guarda su huella, asi que se muestra completa una sola vez |
| `historySince` | Fecha desde la que hay historial campo por campo: la del despliegue de esta spec. Solo cubre cambios por API y por el panel |
| Accion sin cambios (no-op) | Una escritura que, aplicada al estado real, no cambiaria nada: confirmar un pedido ya en `ready_to_assign` o posterior no cancelado (RF_05), cancelar uno ya `cancelled` (RF_15), o corregir con los valores que ya tiene un pedido editable que no esta en `address_risk`. Solo se responde como no-op si antes no salio ningun error de mayor precedencia (decision 12), incluida la ciudad no cubierta (RF_10) |

## 3. Historias de usuario

- **HU_01 (sin interfaz):** **Como** integrador de una tienda **quiero** encontrar un pedido por su id de
  Kentro o por su numero de Shopify **para** no tener que releer dias enteros.
- **HU_02 (sin interfaz):** **Como** integrador **quiero** confirmar, corregir o cancelar un pedido sin lider
  **para** cerrar la conversacion con el cliente antes del despacho.
- **HU_03 (sin interfaz):** **Como** integrador **quiero** consultar el historial de cambios de un pedido, con
  su origen **para** saber quien cambio que y cuando.
- **HU_04 (interfaz):** **Como** tienda o administrador **quiero** generar, ver una vez y rotar una key de
  escritura separada de la de lectura **para** dar escritura solo a quien la necesita.
- **HU_05 (interfaz):** **Como** administrador o tienda **quiero** ver en el "Historial del pedido" que ya existe
  los cambios que llegaron por API, junto con los del panel, con su origen y los campos que cambiaron **para**
  entender por que un pedido cambio sin que nadie lo tocara a mano. La tienda lo ve sin identidades de quien
  opera en Kentro (RF_27).

## 4. Requisitos funcionales (EARS + RFC 2119)

Cuando una peticion reune varias condiciones de error, la que se responde la fija la **precedencia de codigos**
de la decision 12.

### Busqueda

- **RF_01 (ubicua):** El sistema MUST exponer `GET /orders/{id}`, que devuelve un solo pedido de la tienda con el
  mismo esquema que un elemento de `GET /orders`. Un pedido de otra tienda o inexistente MUST responder 404.
- **RF_02 (ubicua):** El sistema MUST permitir filtrar `GET /orders` por `shopifyOrderId`, y MUST devolver solo
  los pedidos de la tienda con ese numero (o una lista vacia), sin aplicar `from`/`to` aunque vengan. Los
  parametros `status` y `limit` de hoy MUST seguir aplicandose junto con el filtro.
- **RF_03 (error):** **Si** una peticion a una ruta **nueva** de esta spec (`/orders/{id}`, `/orders/{id}/history`
  y las escrituras) trae un parametro que la ruta no reconoce, el sistema MUST responder 400 nombrando el
  parametro. En `GET /orders`, un `shopifyOrderId` mal formado MUST responder 400 **con la forma de error de las
  rutas existentes**, `{ ok: false, error: "invalid_shopify_order_id" }` (RF_20). El resto de parametros de las
  rutas existentes se sigue tratando como hoy (RF_20).

### Confirmar

- **RF_04 (evento):** **Cuando** se confirme por API un pedido `imported` sin lider, el sistema MUST pasarlo a
  `ready_to_assign` con la **misma regla y la misma auditoria** que `confirmImportedOrder` (incluido
  `addressRisk: "accepted"`), con `confirmedVia: "api"` y origen `api` en el historial. **Si** el pedido
  `imported` ya tiene lider (caso anomalo), confirmar por API MUST responder 409 con
  `code: "order_not_editable"`, su estado y `hasLeader: true`, sin cambiar nada.
- **RF_05 (estado):** **Mientras** el pedido ya este en `ready_to_assign` o en un estado posterior, sin estar
  cancelado, confirmar MUST responder exito con el pedido tal como esta, sin cambiar nada ni anadir historial,
  **aunque traiga un `expectedStatus` que no coincida** con el estado real: la idempotencia gana (RF_19). (Un
  `imported` con lider no es "posterior": responde segun RF_04.)
- **RF_06 (error):** **Si** el pedido esta `cancelled`, confirmar MUST responder 409 con `code: "order_cancelled"`.
- **RF_21 (error):** **Si** el pedido esta en `address_risk`, **tenga o no lider**, confirmar MUST responder 409
  con `code: "address_review_pending"` y sin cambiar nada: primero se corrige la direccion (RF_22) y despues se
  confirma. Al confirmar, este codigo prevalece sobre `order_not_editable` y sobre `status_changed`: un
  `address_risk` con lider, o con un `expectedStatus` distinto, tambien responde `address_review_pending`
  (aunque no sea corregible por API, RF_08). Es la misma regla que hoy tiene la tienda en el panel, que no puede
  aceptar una direccion en revision.

### Corregir datos de entrega

- **RF_07 (estado):** **Mientras** el pedido sea editable, el sistema MUST aplicar solo los datos de entrega
  enviados (nombre, telefono, direccion completa, indicaciones, ciudad). Lo que no se envia MUST quedar intacto.
  Corregir MUST NOT confirmar: un pedido `imported` corregido sigue `imported`, y uno `ready_to_assign` sigue
  `ready_to_assign`.
- **RF_08 (error):** **Si** el pedido esta en curso o es final, el sistema MUST responder 409 con
  `code: "order_not_editable"` y su estado actual, sin aplicar ningun campo.
- **RF_09 (error):** **Si** algun campo enviado tiene un problema — no es un dato de entrega (no permitido), o
  es invalido (vacio, demasiado largo, telefono que no da un numero colombiano de 10 digitos ni un E.164, tipo
  incorrecto) —, el sistema MUST responder 422 sin aplicar ninguno (todo o nada) y MUST listar **todos** los
  campos con problema **de los dos tipos** en la misma respuesta, cada uno con su motivo. El `code` de primer
  nivel MUST ser `field_not_allowed` si hay al menos un campo no permitido, y `validation_failed` si no.
  **Unica excepcion a "vacio = invalido":** `deliveryNotes` enviado como `""` o `null` MUST borrar las
  indicaciones del pedido (es la forma de quitarlas). Cualquier otro campo de entrega enviado vacio o `null`
  MUST contarse como invalido.
- **RF_10 (error):** **Si** la ciudad enviada no es una ciudad cubierta, el sistema MUST responder 422 con
  `code: "out_of_coverage"`, sin aplicar ningun campo, **aunque sea la misma ciudad que ya tiene el pedido**: la
  ciudad enviada se valida antes de decidir si la correccion cambia algo (no-op). La API valida campos (RF_09) y
  ciudad, y **no juzga la direccion**: no geocodifica ni la puntua. Una direccion que pasa RF_09 en una ciudad
  cubierta se acepta.
- **RF_22 (evento):** **Cuando** se corrija por API un pedido en `address_risk` sin lider con datos que pasan
  RF_09 y RF_10, el sistema MUST devolverlo a `imported` con `addressRisk: "review"` (pendiente de confirmar,
  como cualquier pedido recien importado), y MUST registrar ese cambio de estado en el historial con origen
  `api`. Una escritura por API MUST NOT llevar nunca un pedido a `address_risk`.
- **RF_23 (ubicua):** **Cuando** una correccion cambie la direccion, el sistema MUST borrar lo derivado de la
  direccion anterior (`normalizedAddress`, `lat`, `lng`, `geoProvider`), igual que hace la reimportacion
  (spec 017, RF_18), para que el pedido no apunte a dos sitios.
- **RF_11 (ubicua):** Una correccion por API MUST dejar la misma marca de edicion manual que el panel
  (`MANUAL_EDIT_STAMP`, spec 017), de modo que una reimportacion no la pise.
- **RF_12 (ubicua):** El producto, la cantidad, el valor a cobrar, el metodo de pago y el modo de despacho MUST
  NOT poder cambiarse por API.

### Cancelar

- **RF_13 (estado):** **Mientras** el pedido sea editable, cancelar por API con un motivo obligatorio (1 a 500
  caracteres) MUST pasarlo a `cancelled` por la misma logica que `cancelOrder` (incluida la liberacion de
  inventario reservado y el motivo en `callNote`), con auditoria y origen `api`.
- **RF_14 (error):** **Si** el pedido esta en curso o es final y no esta cancelado, cancelar MUST responder 409
  con `code: "order_not_editable"` y su estado actual, sin cancelarlo. Es mas estricto que el panel, donde la
  tienda puede anular un `assigned`: por API no se anula nada que ya tenga lider.
- **RF_15 (estado):** **Mientras** el pedido ya este `cancelled`, cancelar MUST responder exito sin cambios ni
  historial nuevo, **aunque traiga un `expectedStatus` que no coincida** (la idempotencia gana, RF_19).

### Historial

- **RF_16 (ubicua):** A partir del despliegue de esta spec, todo cambio de estado o de datos de entrega de un
  pedido hecho **por la API o desde el panel** MUST quedar registrado con fecha y hora, origen, campo, valor
  anterior y valor nuevo. En el ajuste del admin (`updateOrderAdjustments`) y en la edicion del panel
  (`updateImportedOrder`) MUST registrarse ademas `totalCop`, `productName`, `sku` y `quantity` cuando cambien.
  Las callables del panel cubiertas son exactamente las de la tabla 2.6 del plan:
  - `confirmImportedOrder`, `updateImportedOrder` y `cancelOrder` (por el nucleo compartido con la API);
  - `confirmRetryOrder`, `updateOrderAdjustments`, `applyOrderTransition` y `closeOrder`;
  - `assignMessengerToOrders` y `unassignMessengerFromOrders` (asignar y quitar mensajero; solo `status`);
  - `createOrUpdatePickupBatch` (paso a `picked_up`; hoy no audita y gana el evento `order.picked_up`);
  - `correctOrderStatus` (`order-corrections.ts`).

  Un registro MUST NOT reescribirse ni borrarse. **Unica excepcion:** el `cleanup` de la verificacion contra
  produccion (DoD 3) MUST borrar el historial solo de los pedidos de prueba que la propia verificacion creo, y de
  ningun otro. Los cambios que hacen ChatBy y las cinco vias de importacion, y la creacion de pedidos, quedan
  fuera de este requisito (spec 031). **Limite conocido:** los cambios de `status` que el lider o el mensajero
  hacen directamente desde el cliente, permitidos por la regla `operationalOrderUpdateByAssignee`, no pasan por
  ninguna callable y **no quedan registrados**; esta spec no cierra ese hueco y lo traslada a la spec 032.
- **RF_17 (ubicua):** El sistema MUST exponer `GET /orders/{id}/history` con esos registros, del mas viejo al
  mas nuevo. La respuesta MUST incluir `historySince` y MUST decir de forma explicita, en un campo estable y en el
  indice de la API, que el historial **no incluye** los cambios hechos por importaciones (Shopify y webhooks de
  tienda) ni por la confirmacion automatica de ChatBy.
- **RF_18 (ubicua):** El historial de la API MUST NOT exponer datos de otras tiendas ni identidades de quien
  opera en Kentro (uid, nombre, correo): solo el origen.
- **RF_24 (ubicua):** El historial MUST empezar con esta spec: los pedidos anteriores MUST NOT reconstruirse
  desde `auditEvents`, y su historial devuelve lo que haya desde `historySince` (posiblemente vacio).
- **RF_27 (ubicua, HU_05):** Cuando quien consulta el historial de un pedido en la app es una tienda (`seller` o
  `seller_logistics`), `getOrderAuditTrail` MUST NOT devolver el uid, el nombre ni el correo de quien actuo, y
  "Historial del pedido" MUST NOT pintarlos. Cada evento MUST llevar solo la etiqueta de actor para la tienda:
  "Kentro", "Tu tienda" o "API". Aplica a todos los eventos, tambien a los anteriores a esta spec. El admin
  sigue viendo nombre y correo como hoy. **Mitigacion hasta la spec 032** (que cierra la creacion de
  `auditEvents` desde el cliente; decision P3 del plan): a la tienda MUST llegarle solo un evento verificable
  (con un registro de `orderHistory` que lo apunte) o cuya accion este en la lista permitida del plan (2.7). Los
  demas MUST dejar de mostrarse a la tienda, tambien los anteriores a esta spec que hoy ve; el admin los sigue
  viendo.

### Key de escritura

- **RF_25 (evento):** **Cuando** la tienda (rol `seller`, solo la suya) o un admin generen o roten la key de
  escritura, el sistema MUST mostrarla completa **una sola vez**, guardar solo su huella, invalidar la anterior en
  el acto, y auditar quien la genero. Despues MUST mostrar solo lo que ya muestra el diseno de HU_04, nunca la
  key: **que existe, en que termina (sus ultimos 4 caracteres), cuando se genero la key vigente y quien la
  genero** (a la tienda, "Tu tienda" o "Kentro"; al admin, "por la tienda" o el nombre del admin). El prefijo y
  la fecha de la ultima rotacion pueden guardarse, pero no forman parte de lo que se muestra.
- **RF_26 (ubicua):** Generar o rotar la key de escritura MUST NOT cambiar la key de lectura, y viceversa.

### Consistencia con lo que hay

- **RF_19 (ubicua):** Todas las escrituras por API MUST pasar por la misma logica de servidor que el panel
  (confirmar, editar y cancelar), extraida a un nucleo compartido y no copiada. La condicion de cada escritura
  (estado y lider) MUST evaluarse dentro de la misma transaccion que escribe; si el pedido cambio de estado o tomo
  lider, MUST fallar con 409 y no aplicar nada. Las escrituras MAY traer `expectedStatus`; si viene, no coincide
  con el estado real **y la accion cambiaria algo**, MUST responder 409 con `code: "status_changed"`
  (constitucion, principio 5). **Si la accion seria un no-op** (glosario), MUST responder exito sin cambios
  aunque `expectedStatus` no coincida: la idempotencia gana sobre `expectedStatus`. `status_changed` es el
  ultimo control antes de aplicar (decision 12).
- **RF_20 (ubicua):** Las rutas de lectura existentes (`/resumen`, `/kpis`, `/orders` y `/settlements`) MUST
  seguir respondiendo igual para las integraciones actuales, con la key de lectura o con la de escritura,
  incluida la forma de sus errores (`{ ok: false, error }`), tambien en los errores nuevos que gane `GET /orders`
  por el filtro de RF_02 (`invalid_shopify_order_id`). El indice de la raiz MUST conservar **con valores
  identicos** todas sus claves actuales (rutas, autenticacion y el resto) y la documentacion nueva (rutas nuevas,
  lo que el historial no incluye, codigos de error, estados editables y `historySince`, como exigen RF_17 y el
  DoD 5) MUST ir **solo en claves nuevas de primer nivel**, sin anadir nada dentro de las actuales. La
  comparacion antes/despues se hace **por valor** sobre datos que no cambian entre la captura y la comparacion
  (rangos cerrados del pasado y pedidos y cortes no modificados desde la captura); `/resumen`, que depende del
  dia, se compara por forma (plan 5.3). La unica respuesta nueva en una ruta existente sin el filtro nuevo es el
  401 a una key de escritura enviada por query (RNF_01), que ninguna integracion actual puede estar usando
  porque esa key no existe hoy.

## 5. Requisitos no funcionales

- **RNF_01 (seguridad):**
  - Las escrituras MUST exigir la **key de escritura** en la cabecera `Authorization: Bearer`. Una key de
    lectura enviada **en esa cabecera** a una escritura MUST recibir 403 con `code: "read_only_key"`; es el unico
    caso de 403.
  - Una key enviada por parametro de consulta (`key=`) a una ruta de escritura MUST rechazarse **siempre** con
    401, sea de lectura o de escritura, valida o no, y aunque tambien venga una cabecera valida. Nunca 403. Es
    la primera comprobacion: gana tambien sobre un parametro desconocido (decision 12).
  - Una key de escritura (prefijo `kw_`) enviada por parametro de consulta MUST rechazarse con 401 tambien en las
    rutas de lectura, nuevas y existentes (en las existentes, con su forma de error de hoy, RF_20).
  - Escribir o leer un pedido de otra tienda MUST responder 404, igual que uno inexistente.
- **RNF_02 (errores):** Toda respuesta fallida de las rutas nuevas MUST llevar su codigo HTTP real y el cuerpo
  `{ ok: false, code, message, fields? }`. Los `code` son estables: se agregan, no se renombran. Las rutas
  existentes conservan su forma (RF_20). Cuando aplican varios, se responde el primero segun la decision 12.
- **RNF_03 (idempotencia):** Las escrituras MUST aceptar `Idempotency-Key`. La misma key con el mismo cuerpo
  durante 24 horas MUST devolver la misma respuesta sin aplicar el cambio dos veces. La misma key con otro
  cuerpo MUST responder 422 con `code: "idempotency_key_reused"`.
- **RNF_04 (limites):** Al superar el limite de tasa, el sistema MUST responder 429 con `Retry-After`, nunca 403.
  El minimo es 60 escrituras por minuto por tienda. Hoy `/storeApi` no tiene limite de tasa: es nuevo.
- **RNF_05 (latencia):** El p95 de las escrituras y de `GET /orders/{id}` SHOULD ser menor a 2 segundos. Para eso
  MUST NOT leer todos los pedidos de la tienda, como hace hoy `GET /orders`.

## 6. Casos limite

- **Confirmacion automatica y por API a la vez** (ChatBy y CENTRAL sobre el mismo pedido): la segunda MUST ver
  el pedido ya confirmado y responder sin cambios (RF_05), no 409, **tambien si CENTRAL mando
  `expectedStatus: "imported"`**: confirmar algo ya confirmado es un no-op y la idempotencia gana sobre
  `expectedStatus` (RF_19). Las dos van por transaccion.
- **Correccion que llega justo cuando un lider toma el pedido:** la condicion se evalua en la transaccion
  (RF_19) y responde 409. No se corrige un pedido que ya tiene lider.
- **Correccion que reenvia la misma ciudad, ya desactivada:** responde 422 `out_of_coverage` (RF_10), no "sin
  cambios": la ciudad se valida antes del no-op.
- **Peticion con varios errores a la vez** (p. ej. key en query y un parametro desconocido; o un campo invalido
  sobre un pedido en ruta): se responde el de mayor precedencia de la decision 12 (401 en el primer ejemplo, 409
  en el segundo).
- **`imported` con lider** (anomalo): confirmar, corregir y cancelar por API responden 409 `order_not_editable`
  (RF_04, RF_08, RF_14).
- **`address_risk` con lider** (un lider tomo un pedido marcado "revisar"): no es editable ni cancelable por API
  (RF_08, RF_14: `order_not_editable`); confirmarlo responde `address_review_pending` (RF_21), igual que sin
  lider. Sigue siendo cosa del admin.
- **Pedido en `address_risk` corregido por API:** vuelve a `imported` (RF_22) y la confirmacion es un paso aparte
  (RF_04). Confirmar sin corregir da 409 `address_review_pending` (RF_21). Ninguna escritura por API produce un
  `address_risk`.
- **ChatBy confirma un pedido que CENTRAL corrigio:** ChatBy hoy puede reescribir `addressRaw` al confirmar
  (`buildSyncPatch`) y esta exento de la regla de importacion. Gana lo que ChatBy escriba despues. Ese cambio
  **no aparece** en el historial de esta spec (RF_16): la respuesta lo advierte (RF_17) y lo cubre la spec 031.
  No se cambia ese comportamiento aqui.
- **Mensajero que agenda o pasa a "en ruta" desde la app:** si lo hace por la escritura directa que permite
  `operationalOrderUpdateByAssignee`, el cambio no aparece en el historial (limite conocido de RF_16, spec 032).
- **Shopify reenvia el pedido con la direccion vieja despues de un PATCH:** gana la correccion (RF_11): el pedido
  queda en fase `edited` y la importacion no le refresca cliente ni direccion.
- **Shopify reenvia el pedido cancelado en Shopify despues de confirmarlo por API:** la reimportacion conserva
  siempre el `status`, asi que el pedido sigue `ready_to_assign` en Kentro. Ninguna via propaga hoy una
  cancelacion de Shopify; la tienda debe cancelarlo por API. Se prueba que el estado no cambia.
- **Historial visto por la tienda en la app:** un evento de un admin, de un lider o mensajero, o de un proceso de
  Kentro (ChatBy, webhooks, sistema) sale como "Kentro"; uno de un usuario de la propia tienda (incluido su
  logistico) como "Tu tienda"; uno de la key de escritura como "API". Los eventos historicos, que solo traen
  `summary`, se muestran con su `summary` pero sin nombre ni correo (RF_27). Un `summary` que nombre a una
  persona de Kentro se trata en el plan (no se reescriben registros, RF_16).
- **Eventos que la tienda deja de ver (mitigacion P3, RF_27):** un evento no verificable (sin registro de
  `orderHistory` que lo apunte) cuya accion no esta en la lista permitida deja de mostrarse a la tienda, aunque
  hoy lo vea (por ejemplo, un evento historico de reasignacion de mensajero). Es deliberado: mientras cualquier
  sesion pueda crear `auditEvents`, la tienda no ve lo que no se puede verificar. Lo revisa la spec 032.
- **Numero de Shopify repetido entre tiendas:** el filtro por `shopifyOrderId` queda siempre limitado a la
  tienda de la key.
- **Pedido con varias lineas:** la correccion no toca `lineItems` (RF_12), asi que no aplica el riesgo de
  `resolveEditedOrderLines`.
- **Pedidos de Kovia:** Kovia entra por `shopifyWebhook`. La spec debe probarse con la forma de un pedido real de
  ese canal, no solo con uno de `storeOrderWebhook`, sin tocar ningun pedido ni tienda real de Kovia (plan 5.3).

## 7. Fuera de alcance

- Crear pedidos por API: siguen entrando desde Shopify o los webhooks de tienda.
- Cambiar producto, cantidad, valor a cobrar, pago o modo de despacho (RF_12). Si el cliente cambia de producto,
  se cancela y entra un pedido nuevo.
- Reprogramar o tocar un pedido en curso, y fijar la franja de entrega (la fija el mensajero al agendar).
- Igualar el panel a la API: el panel sigue editando solo `imported` y la tienda sigue pudiendo anular un
  `assigned` desde el panel. Si se quiere la misma regla en los dos lados, es otra spec.
- **Historial campo por campo de los cambios de ChatBy y de las cinco vias de importacion** (Shopify webhook,
  importacion manual y sincronizacion historica, `storeOrderWebhook`, OnStok, formulario de contacto): va a la
  spec 031.
- Cerrar las escrituras directas de `status` del lider y del mensajero (`operationalOrderUpdateByAssignee`): va
  a la spec 032.
- Ocultar identidades en el historial que ven el lider y el mensajero: RF_27 es solo para la tienda.
- Geocodificar o puntuar direcciones.
- Los opcionales de CENTRAL: webhook firmado de cambio de estado (OPC_01, **spec 030**), paginacion real de
  `GET /orders` (OPC_02), `GET /coverage` (OPC_03) y cuenta de pruebas (OPC_04). La cuenta de pruebas es
  operativa: se crea una tienda con su propio `sellerId`, y no necesita codigo.

## 8. Definition of Done

1. **Pruebas, una por grupo de comportamiento:**
   - RF_04 y RF_05: confirmar `imported` lo deja en `ready_to_assign` con `confirmedVia: "api"`, y confirmar dos
     veces deja un solo registro de historial; confirmar un `imported` con lider da 409 `order_not_editable`;
     confirmar un `ready_to_assign` con `expectedStatus: "imported"` responde sin cambios, no 409.
   - RF_21 y RF_22: confirmar un `address_risk` da 409 `address_review_pending`, con y sin lider y tambien con un
     `expectedStatus` distinto; corregirlo (sin lider) lo deja en `imported` con `review`; confirmarlo despues lo
     deja en `ready_to_assign`; ninguna escritura por API deja un pedido en `address_risk`.
   - RF_08: corregir un pedido en `in_route`, en `call_pending` o en `address_risk` con lider responde 409 y no
     cambia nada.
   - RF_09 y RF_10: un telefono valido con una ciudad no cubierta responde 422 nombrando la ciudad, y el telefono
     no cambia; reenviar la ciudad que ya tiene el pedido, desactivada, da 422 y no "sin cambios";
     `deliveryNotes: ""` y `deliveryNotes: null` borran las indicaciones; otro campo vacio da 422; un cuerpo con
     un campo no permitido y otro invalido lista los dos, con `code: "field_not_allowed"`.
   - RF_23: corregir la direccion borra `normalizedAddress`, `lat`, `lng` y `geoProvider`.
   - RF_11: una reimportacion de Shopify despues de un PATCH conserva la direccion corregida.
   - RF_13 a RF_15: cancelar un editable lo anula y libera inventario reservado; cancelar un `assigned` da 409;
     cancelar dos veces no duplica historial; cancelar un `cancelled` con un `expectedStatus` distinto responde
     sin cambios.
   - RF_16 y RF_18: una correccion por API y una edicion desde el panel dejan cada una su registro con origen,
     campo y valores (la del panel, tambien producto y valor si cambian); el de la API no trae uid, nombre ni
     correo; cada callable de la lista de RF_16 registra.
   - RF_17: la respuesta de `/orders/{id}/history` trae `historySince` y el aviso de que no incluye importaciones
     ni ChatBy; el indice de la API lo dice tambien.
   - RF_27: `getOrderAuditTrail` llamado con una sesion `seller` y otra `seller_logistics` no devuelve uid,
     nombre ni correo en ningun evento (tambien en uno con forma anterior a la spec) y trae la etiqueta correcta;
     un evento no verificable fuera de la lista permitida no llega a la tienda y si al admin; con sesion `admin`
     sigue trayendo nombre y correo. Guarda de fuente: `OrderAuditTrail` no pinta `actorEmail` para la tienda.
   - RF_25 y RF_26: la key de escritura se muestra una vez, se guarda solo su huella, despues solo se ve que
     existe, en que termina, cuando se genero y quien la genero, y rotarla no toca la de lectura.
   - RNF_01 y RNF_02: la key de lectura en la cabecera de una escritura recibe 403 `read_only_key`; un pedido de
     otra tienda da 404; cualquier key por query en una escritura da 401 (tambien la de lectura, aunque sea
     valida y aunque venga un parametro desconocido); una key `kw_` por query en una ruta de lectura da 401.
   - Decision 12: cada par de condiciones vecinas de la precedencia tiene una prueba que comprueba que gana la
     de mayor precedencia.
   - RNF_03: la misma `Idempotency-Key` no aplica dos veces.
   - RF_20: las respuestas de `/kpis`, `/orders` y `/settlements` sobre datos congelados al capturar, y los
     valores de las claves actuales del indice, no cambian (comparacion por valor antes/despues); `/resumen`
     conserva su forma; en tiendas reales solo con su key de lectura; con key de escritura, solo en la tienda de
     pruebas. Un `shopifyOrderId` mal formado en `GET /orders` responde con la forma vieja.
2. **Guardas de fuente:** las escrituras por API reutilizan el nucleo de confirmar, editar y cancelar sin copiarlo
   (RF_19), y la guarda de la spec 017 (`spec-017-guards.test.ts`) sigue en verde: si el codigo nuevo escribe en
   `orders` fuera de `orders.ts`, se declara en `IMPORT_WRITE_EXEMPTIONS` con su razon.
3. **Recorrido real contra produccion** con una tienda de pruebas: los criterios de aceptacion CA_01 a CA_12 de
   CENTRAL, con CA_03 corregido para confirmar un pedido `imported`. Con evidencia. Incluye abrir "Historial del
   pedido" con una sesion real de tienda y comprobar que no aparece ningun nombre ni correo de Kentro (RF_27).
   **Sesiones:** las de tienda (`seller` y `seller_logistics`) son de la tienda de pruebas; ninguna sesion de
   tienda se crea sobre una tienda real. Se acepta **explicitamente un admin desechable**, creado y borrado por
   el guion de verificacion (como en las verificaciones de las specs 022 y 026), usado solo sobre la tienda de
   pruebas. **No se crea lider ni mensajero desechable:** el pedido de prueba "con lider" se prepara poniendo su
   `driverId` con el Admin SDK, y eso se declara en la evidencia como paso que no va por el canal del cliente. El
   `cleanup` final borra solo lo creado por la verificacion (RF_16, excepcion).
4. **Calidad:** `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
5. **Documentacion:** la de `/storeApi` (el indice de la raiz, en claves nuevas, y `/api-tiendas`) describe las
   rutas nuevas, los codigos de error y su precedencia, los estados editables, `historySince` y lo que el
   historial no incluye, y que la key de escritura va solo por cabecera.
6. **Firma:** el responsable de la plataforma firma la entrega.

## 9. Decisiones

Respuestas propuestas por Claude y aceptadas por el responsable el **2026-10-04** ("propon las respuestas y
empieza"), y tres decisiones mas del responsable el mismo dia tras el contraste con el codigo.

1. **`address_risk` (2026-10-04):** es editable por API mientras no tenga lider. Corregir NO confirma. Si el pedido
   estaba en `address_risk` y la direccion corregida es valida, vuelve a `imported` (pendiente de confirmar).
   Confirmar es siempre una accion explicita aparte. → RF_07, RF_21, RF_22.
2. **Cobertura (2026-10-04, ratificada con precision el mismo dia):** se valida la ciudad (fuera de cobertura →
   422, RF_10). No hay geocodificacion nueva. El "flujo actual" de direcciones dudosas es humano (el admin acepta
   la direccion con `resolveAddress`); no hay detector automatico, y `normalizeAddress` es solo un endpoint stub
   sin uso. Por eso **la API no juzga direcciones y nunca manda un pedido a `address_risk`**: valida campos y
   ciudad. Un `address_risk` sin lider corregido por API vuelve a `imported`. → RF_09, RF_10, RF_22.
3. **Key de escritura (2026-10-04):** la pueden generar y rotar la tienda desde su panel y el admin; separada de la
   de lectura; se muestra completa una sola vez. → RF_25, RF_26, RNF_01, HU_04.
4. **Historial (2026-10-04):** empieza con esta spec, sin reconstruir; la respuesta dice desde que fecha hay
   historial (`historySince`). → RF_16, RF_17, RF_24.
5. **Webhook firmado hacia CENTRAL (OPC_01) (2026-10-04):** spec inmediatamente despues, numero 030, en
   borrador. → `specs/030_webhook_firmado_hacia_la_tienda.md`.
6. **Alcance del historial (2026-10-04):** el historial campo por campo se registra desde el dia uno solo para
   cambios por API y por el panel. ChatBy y las cinco vias de importacion quedan fuera y van a la spec 031
   (borrador). La API dice expresamente que su historial no los incluye. → RF_16, RF_17, seccion 7,
   `specs/031_historial_de_importaciones_y_chatby.md`.
7. **Identidades en el historial de la tienda (2026-10-04):** entra en esta spec. `getOrderAuditTrail` y
   "Historial del pedido" no muestran a una tienda nombre ni correo de quien opero en Kentro; la tienda ve solo
   "Kentro", "Tu tienda" o "API". → RF_27, HU_05.
8. **Precisiones tras `/sdd-analyze` (2026-10-04, orquestador):** (a) confirmar un `address_risk` da siempre
   `address_review_pending`, tambien con lider (RF_21); (b) cualquier key por query en una escritura es 401, y el
   403 `read_only_key` es solo para la key de lectura en la cabecera; una key `kw_` por query tambien es 401 en las
   rutas de lectura viejas (RNF_01); (c) `deliveryNotes` vacio o `null` borra las indicaciones (RF_09); (d) la
   lista de callables de RF_16 es la de la tabla 2.6 del plan, y el `cleanup` de la verificacion es la unica
   excepcion a "no se borra"; (e) el indice gana claves nuevas sin cambiar las actuales (RF_20); (f) la tienda deja
   de ver eventos no verificables fuera de la lista permitida (RF_27, caso limite). → RF_09, RF_16, RF_20, RF_21,
   RF_27, RNF_01.
9. **Precisiones del tercer `/sdd-analyze` (2026-10-04, orquestador; sin cambiar la intencion):** (a) el 422 de
   RF_09 lista todos los campos con problema de los dos tipos, con `field_not_allowed` de primer nivel si hay
   alguno no permitido; (b) en `GET /orders` viejo, el 400 por `shopifyOrderId` mal formado usa la forma vieja y
   `status`/`limit` se aplican junto con el filtro (RF_02, RF_03, RF_20); (c) confirmar un `imported` con lider da
   409 `order_not_editable` (RF_04, RF_05); (d) RF_16 dice que la edicion del panel registra tambien producto y
   valor, y declara el hueco de `operationalOrderUpdateByAssignee` (spec 032); (e) `normalizeAddress` existe
   como stub sin uso (contexto; la decision 2 no cambia); (f) en la comparacion de RF_20, la key de escritura solo
   se usa sobre la tienda de pruebas (DoD).
10. **Precisiones del cuarto `/sdd-analyze` (2026-10-04, orquestador; sin cambiar la intencion):** (a) la
    idempotencia gana sobre `expectedStatus`: una accion que seria un no-op responde sin cambios aunque
    `expectedStatus` no coincida, y `status_changed` solo sale cuando la accion cambiaria algo (RF_05, RF_15,
    RF_19, glosario, caso limite ChatBy + API); (b) el indice lleva la documentacion nueva solo en claves nuevas
    de primer nivel, con los valores de las actuales identicos, y se compara por valor (RF_20, DoD 5); (c) la
    verificacion de RF_27 sobre eventos con forma historica se hace sobre la tienda de pruebas (DoD 3; precisada
    en la decision 12 (c)).
11. **Precisiones del quinto `/sdd-analyze` (2026-10-05, orquestador; sin cambiar la intencion):** (a) RF_10 se
    evalua antes del no-op: una ciudad no cubierta da 422 aunque sea la que ya tiene el pedido (RF_10, glosario,
    caso limite); (b) RF_25 enumera lo que se muestra despues (precisado en la decision 12 (b)); (c) la
    comparacion de RF_20 se hace sobre datos congelados al capturar y `/resumen` por forma (RF_20, DoD 1).
12. **Precedencia de codigos y precisiones del sexto `/sdd-analyze` (2026-10-05, orquestador):**
    (a) **Precedencia de codigos de las rutas nuevas.** Cuando una peticion reune varias condiciones, se
    responde la primera de esta lista, en este orden:
    1. 401 por key enviada en query a una ruta de escritura (`key_in_query`), antes incluso que los parametros;
    2. 401/403 de credenciales (`missing_credentials`, `invalid_key`, `key_in_query` por `kw_` en lectura,
       `read_only_key`);
    3. 400 de parametros (`unknown_parameter`) y de forma del cuerpo (`invalid_json`, cuerpo que no es un
       objeto);
    4. 404 pedido ajeno o inexistente (`order_not_found`);
    5. 409 por estado (`order_cancelled`, `address_review_pending`, `order_not_editable`);
    6. 422 de validacion y cobertura (`field_not_allowed`, `validation_failed`, `no_fields`,
       `out_of_coverage`, incluida la misma ciudad desactivada);
    7. sin cambios (`changed: false`, no-op);
    8. 409 `status_changed`, solo si la accion cambiaria algo;
    9. aplicar.

    El limite de tasa (429) y la idempotencia (`replay`, 422 `idempotency_key_reused`) son transversales: se
    evaluan despues del paso 3 y antes de leer el pedido. → RF_03, RF_09, RF_10, RF_19, RF_21, RNF_01, RNF_02.
    (b) **RF_25** se ajusta a lo que ya muestra el diseno: que existe, en que termina, cuando se genero la key
    vigente y quien la genero; el prefijo y la fecha de rotacion no se muestran (pueden guardarse). → RF_25.
    (c) **Sesiones de la verificacion (DoD 3):** sesiones de tienda solo de la tienda de pruebas; un admin
    desechable aceptado explicitamente, creado y borrado por el guion; ningun lider ni mensajero desechable (el
    `driverId` del pedido de prueba se pone con el Admin SDK, declarado como paso fuera del canal del cliente).

## 10. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-02 | Borrador inicial (como "Spec 028") | Peticion de CENTRAL (Kovia/ONEP) del 2-oct-2026, con los estados corregidos contra el codigo |
| 2026-10-04 | Renumerada a 029 | La 028 la usa otra sesion ("abrir la app no escribe nada") |
| 2026-10-04 | Aprobada. Seccion 9 pasa a "Decisiones" con las 5 respuestas; nuevos RF_21 (confirmar `address_risk` da 409), RF_22 (corregir `address_risk` → `imported`), RF_24 (historial sin reconstruir), RF_25 y RF_26 (key de escritura) | Respuestas aceptadas por el responsable |
| 2026-10-04 | Contraste con el codigo, correcciones: (a) "editable" exige ademas `driverId` vacio — un lider puede tomar un pedido "revisar" y dejarlo en `address_risk` con lider; (b) RF_04 decia que confirmar acepta `address_risk`, pero `confirmImportedOrder` solo acepta `imported`; (c) RF_10 decia que la importacion manda a `address_risk` una direccion dudosa: ninguna importacion lo hace (todas crean `imported` + `review`) y no existe detector; (d) "detalle de direccion" y "franja de entrega" no existen como datos de la tienda: se quitan de RF_07 y se nombran los campos reales; (e) RF_23 nuevo: cambiar la direccion borra lo derivado, como la 017; (f) RF_03 limitado a rutas nuevas, porque `/orders` hoy ignora parametros y RF_20 obliga a no romperlo; (g) RF_13 alineado con `cancelOrder` (motivo en `callNote`, libera inventario) y RF_14 declarado mas estricto que el panel; (h) RF_19: confirmar/editar/cancelar no reciben `expectedStatus`, validan el estado dentro de su transaccion; se dice asi y `expectedStatus` queda opcional; (i) RF_16: hoy la edicion no guarda campos ni valores y las importaciones de Shopify no auditan — se declara como trabajo nuevo; (j) caso limite de Shopify cancelado: la reimportacion conserva siempre `status`; (k) RNF_02 solo para rutas nuevas, porque las existentes responden `{ ok, error }`; (l) RNF_05: `GET /orders` lee todos los pedidos de la tienda | Constitucion, principio 1: una spec que miente es peor que no tener spec |
| 2026-10-04 | Decisiones 6 y 7 y ratificacion de la 2: RF_16 acotado a API y panel (ChatBy e importaciones a la spec 031, en fuera de alcance); RF_17 obliga a decir que el historial no los incluye; RF_27 nuevo (la tienda no ve uid, nombre ni correo de Kentro en `getOrderAuditTrail` ni en "Historial del pedido"), ligado a HU_05, que pasa a admin y tienda; glosario (origen, etiqueta de actor, `historySince`), casos limite y DoD ajustados | Decisiones del responsable sobre las tres preguntas del contraste |
| 2026-10-04 | Precisiones de `/sdd-analyze` (decision 8): RF_21 gana sobre `order_not_editable` al confirmar un `address_risk` con lider; RNF_01 separa el 401 (cualquier key por query en escritura; `kw_` por query en cualquier ruta, tambien las viejas) del 403 (solo key de lectura en la cabecera); RF_09 declara la excepcion de `deliveryNotes` vacio o `null`; RF_16 enumera las callables igual que la tabla 2.6 del plan y declara la excepcion del `cleanup` de verificacion; RF_20 reescrito para no contradecir RF_17 y DoD 5 (el indice gana claves nuevas y conserva las actuales); RF_27 y casos limite declaran que la tienda deja de ver eventos no verificables fuera de la lista permitida (mitigacion P3 hasta la 032); DoD ajustado | Hallazgos de `/sdd-analyze`: requisitos que se contradecian entre si o con el plan |
| 2026-10-04 | Precisiones del tercer `/sdd-analyze` (decision 9), sin cambiar la intencion: RF_09 (el 422 lista todos los campos de los dos tipos; prioridad del `code`); RF_02, RF_03 y RF_20 (`GET /orders` viejo: 400 con forma vieja, `status`/`limit` con el filtro); RF_04/RF_05 (`imported` con lider → 409 `order_not_editable`); RF_16 (la edicion del panel registra producto y valor; limite conocido de `operationalOrderUpdateByAssignee`, a la 032); contexto (`normalizeAddress` es un stub sin uso; escrituras directas de `status` del lider y del mensajero); casos limite, fuera de alcance y DoD ajustados (comparacion de RF_20 con key de escritura solo en la tienda de pruebas) | Tercer `/sdd-analyze`: el texto no decia lo que el plan ya hacia o el codigo ya tenia |
| 2026-10-04 | Precisiones del cuarto `/sdd-analyze` (decision 10), sin cambiar la intencion: glosario (accion sin cambios); RF_05, RF_15 y RF_19 (la idempotencia gana sobre `expectedStatus`; `status_changed` solo si la accion cambiaria algo); caso limite ChatBy + API con `expectedStatus`; RF_20 (documentacion nueva del indice solo en claves nuevas de primer nivel, valores actuales identicos, comparacion por valor); DoD 1, 3 y 5 ajustados (RF_27 sobre la tienda de pruebas, sin sesiones sobre tiendas reales) | Cuarto `/sdd-analyze`: `expectedStatus` contradecia la idempotencia de RF_05/RF_15 y el indice admitia cambios dentro de claves actuales |
| 2026-10-05 | Precisiones del quinto `/sdd-analyze` (decision 11), sin cambiar la intencion: RF_10 se valida antes del no-op (glosario y caso limite nuevo); RF_25 enumera los metadatos visibles despues de generar; RF_20 y DoD: comparacion sobre datos congelados al capturar, `/resumen` por forma | Quinto `/sdd-analyze`: criterios de verificacion que el texto dejaba abiertos |
| 2026-10-05 | Sexto `/sdd-analyze` (decision 12): precedencia de codigos de las rutas nuevas (401 key en query → credenciales → 400 parametros y forma → 404 → 409 por estado → 422 validacion y cobertura → sin cambios → 409 `status_changed` → aplicar), referida desde la seccion 4, RF_19, RF_21, RNF_01, RNF_02, glosario, casos limite y DoD; RF_25 ajustado a lo que muestra el diseno (existe, termina en, generada, generada por; sin prefijo ni fecha de rotacion); DoD 3: admin desechable aceptado explicitamente, sin lider ni mensajero desechables (`driverId` puesto con el Admin SDK, fuera del canal del cliente) | Sexto `/sdd-analyze`: orden de errores sin definir, RF_25 mas amplio que el diseno y sesiones de verificacion sin declarar |
