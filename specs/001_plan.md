# Plan tecnico 001: Lider de comunidad

- **Spec:** `specs/001_lider_de_comunidad.md` (aprobada, 54 RF + 5 RNF)
- **Fecha:** 2026-09-08

## 0. Desviacion del stack por defecto, y por que

El stack por defecto del usuario es Next.js + Prisma + PostgreSQL. **Este plan no lo usa**: Kentro es
Next.js 16 + Firebase (Firestore, Functions, Auth, Storage) en produccion, con dinero real y
liquidaciones conciliadas. Meter Prisma/Postgres aqui seria una migracion de plataforma disfrazada de
funcionalidad. Se conserva: TypeScript estricto sin `any` nuevo, Zod en los limites de las callables
(ya es el patron del repo), mobile-first y los cuatro estados de UI asincrona.

## 1. Hallazgos del codigo que condicionan el plan

Cuatro cosas comprobadas leyendo el codigo, no supuestas. Cambian el diseno:

1. **`buildWalletEntries` pisa `sellerFailedFeeCop` con 12.000 DESPUES del spread**
   (`functions/src/wallet-entries.ts:156`). El comentario avisa de que ya paso: se cambio el ajuste a
   9.000 y se siguio cobrando 12.000 sin que nada avisara. Un precio de comunidad para el flete de
   fallido seria ignorado exactamente igual. **Consecuencia:** el precio congelado del pedido debe
   entrar DESPUES de esa linea, o RF_18 nace roto para uno de los tres conceptos.
2. **Los pedidos se crean en seis sitios, y no son los que parecen.** Verificado uno a uno:
   `createManualOrder` (orders.ts:229), `shopifyWebhook` (index.ts:137), `upsertShopifyOrder`
   (shopify.ts:677 — **compartido** por `importShopifyOrder` y `syncShopifyHistoricalOrders`, asi que
   es un solo sitio), `onstockOrderWebhook` (onstock-webhook.ts:255),
   `mercadotiendaContactFormWebhook` (contact-form.ts:226) y `storeOrderWebhook`
   (**store-webhook.ts:276**, que la primera lectura del plan se dejo fuera). RF_21 congela el precio
   al crear: si falta uno, RF_37 se dispara en silencio y el lider no cobra.
3. **No hay fecha de cierre fiable en el pedido.** `Order` declara `createdAt` y `updatedAt`;
   `closedAt` solo se escribe en un camino (orders.ts:797). El eje de cierre de RF_46 **no** puede
   salir del pedido: sale del `createdAt` de los asientos de wallet, que por construccion es el
   instante del cierre. Es exacto y ademas agregable.
4. **El dinero no era agregable en servidor** — asi lo dice el comentario de `order-stats.ts`, porque
   la tarifa de DANDA depende de la fecha de entrega de cada pedido. **Con RF_21 deja de serlo para el
   cashback**: al viajar congelado en el asiento, se suma con `sum()` en Firestore. Es lo que hace
   cumplible RNF_01 sin descargar pedidos.
5. **Los asientos NO sirven para contar pedidos.** Dos razones comprobadas: un cashback de cero no
   emite asiento (un lider sin markup veria cero entregas), y `reversalEntryFor`
   (`order-corrections-plan.ts:186`) **conserva el `type` del asiento original**, asi que cada reversa
   de correccion se contaria como una entrega mas. Sumar si es correcto —una reversa es negativa y
   neta bien—, contar no. **Los contadores salen de `orders`; el dinero, de `walletEntries`.**
6. **La raiz no tiene `firebase-admin`** (comprobado en `package.json`). Una prueba en `src/lib/` no
   puede importar un modulo que cargue `firebase-admin`: de ahi que todo lo probable tenga que vivir
   en modulos puros y los callables sean solo cableado.

## 2. Arbol de modulos

### Nucleo puro (sin Firestore, probable sin red) — donde vive la regla de negocio

| Archivo | Responsabilidad |
|---|---|
| `functions/src/community-pricing.ts` **(nuevo)** | Toda la aritmetica de precios y cashback: `resolveCommunityPricing`, `freezeOrderPricing`, `cashbackForOrder`, `applyScheduledChanges`, `clampToFloor`. Puro. Es el unico sitio donde se decide cuanto gana un lider. |
| `functions/src/community-slug.ts` **(nuevo)** | Normalizacion y validacion del nombre corto: minusculas, sin acentos, `[a-z0-9-]{3,32}`, lista de palabras reservadas, y vigencia de los slugs retirados (30 dias). Puro. |
| `functions/src/wallet-entries.ts` *(modificar)* | Sigue siendo la unica fuente de verdad del dinero de un pedido. Pasa a leer el precio congelado del pedido y a emitir el asiento de cashback llamando a `community-pricing`. **No** se le copia la formula. |
| `functions/src/settlement-math.ts` *(modificar)* | `settlementTotals` acepta el nuevo tipo de dueno. |
| `functions/src/order-corrections-plan.ts` *(modificar)* | El plan de correccion incluye el cashback: compensa si el corte esta pagado, recalcula si esta pendiente (RF_24, RF_25). Sigue siendo puro, asi que `dryRun` sigue sin poder divergir de la aplicacion. |
| `functions/src/community-signup-doc.ts` **(nuevo, T29)** | `buildSignupSellerDoc`: el documento de tienda que escribe el registro publico. Se extrae de `registerSellerBySlug` porque ahi dentro no se puede probar (RF_07, RF_08) y es el punto donde queda constancia permanente de por que enlace entro cada tienda. Puro. |
| `functions/src/community-containment.ts` **(nuevo, T31)** | `planBulkSignupDisable`: a quien alcanza la desactivacion en bloque de un rango y —tan importante como eso— que deja intacto (RF_41, RF_42). Puro. Es el nucleo del unico remedio que existe ante un enlace filtrado, y hoy no tiene ninguna prueba. |

### Capa de servidor (Firestore, auth, transacciones)

| Archivo | Responsabilidad |
|---|---|
| `functions/src/communities.ts` **(nuevo)** | Callables de administracion: `createCommunityLeader`, `setCommunityLeaderStatus`, `setCommunitySlug`, `setCommunityLogo`, `scheduleCommunityPrice`, `cancelScheduledCommunityPrice`, `setCommunityLinkStatus`, `dismissMassSignupAlert`, `disableCommunitySignupsInRange`. |
| `functions/src/community-signup.ts` **(nuevo)** | Lo publico: `getCommunityBySlug` (sin auth, solo marca y estado del enlace) y `registerSellerBySlug` (sin auth, crea usuario + tienda de forma atomica). |
| `functions/src/community-stats.ts` **(nuevo)** | `getCommunityStats`: solo consultas `count()`/`sum()` y Zod. Nunca devuelve pedidos. |
| `functions/src/community-stats-math.ts` **(nuevo)** | La aritmetica del panel, **pura**: rangos, porcentaje de entrega con denominador, activas frente a inactivas, cero real frente a sin datos. Es lo unico que importan las pruebas (hallazgo 6). |
| `functions/src/community-access.ts` **(nuevo)** | Predicados puros de permiso: quien puede crear un lider, que puede tocar un lider, que ve y que no. Da sitio probable a RF_27, RF_31, RF_50, RF_52. |
| `functions/src/community-signup-validate.ts` **(nuevo)** | Validacion pura del registro: los cinco campos, forma del correo y del telefono, y decision de reversion (RF_43, RF_45). |
| `functions/src/store-webhook.ts` *(modificar)* | Septimo punto de creacion detectado en el analisis. Congela precio igual que los demas. |
| `functions/src/orders.ts` *(modificar)* | `createManualOrder` congela precio; `createSettlement` y `updateSettlementStatus` admiten cortes de lider; **`closedAt` pasa a escribirse en todos los cierres**, que es lo que hace viable el eje de cierre de 4.5. |
| `functions/src/index.ts`, `shopify.ts`, `onstock-webhook.ts`, `contact-form.ts` *(modificar)* | Congelar el precio al crear el pedido, por el mismo helper. |
| `functions/src/roles.ts` *(modificar)* | Nuevo rol y su reclamo `communityId`. |
| `functions/src/community-order-pricing.ts` *(creado en T19)* | El helper unico de congelado que llaman los siete puntos de creacion. No estaba en este arbol; se anade para que el mapa refleje el codigo. |
| `functions/src/community-floor-trigger.ts` **(nuevo, RF_35)** | Disparador de la elevacion al piso. Ver 4.7. |

### Cliente

| Archivo | Responsabilidad |
|---|---|
| `src/app/registro/[slug]/page.tsx` **(nuevo)** | Pagina publica de registro: server component que resuelve la marca. Unica ruta nueva. |
| `src/app/registro/[slug]/signup-form.tsx` **(nuevo)** | El formulario, en cliente. Cuatro estados: cargando, error, vacio y exito. |
| `storage.rules` *(modificar)* | Subida del logo del lider: solo el suyo, con limite de tamano. |
| `src/lib/types.ts` *(modificar)* | Tipos nuevos y campos anadidos. |
| `src/lib/community-view.ts` **(nuevo)** | Derivaciones puras para el panel del lider (rotulos de eje, % de entrega con denominador, "cero real" vs "sin datos"). Probable sin React. |
| `src/components/operations-app.tsx` *(modificar)* | `CommunityLeaderView` nueva y la seccion de comunidades en admin. **Pendiente y decidido construir (ver 2.1):** desactivacion en bloque (RF_41), carga de logo (RF_14, RF_16), reasignacion de tienda (RF_11), cashback causado en la lista de comunidades (RF_34) y corte de lider en liquidaciones (RF_49). |
| `src/lib/firebase/state-store.ts` *(modificar)* | Alcance del rol nuevo: **no** descarga pedidos; solo su comunidad, sus tiendas y sus cortes. |
| `src/lib/firebase/auth.ts` *(modificar)* | Envoltorios de las callables nuevas. **Faltan tres** —`disableCommunitySignupsInRange`, `setCommunityLogo`, `reassignSellerCommunity` (2.1)— mas el tipo de corte de lider en `createFirebaseSettlement` (T43). `raiseCommunityPricesToFloor` no lleva envoltorio: la resuelve el trigger de 4.7. |
| `firestore.rules`, `firestore.indexes.json` *(modificar)* | Reglas e indices. |

### 2.1 La superficie de cliente que falta (hallazgo de `/sdd-analyze`, 10-09-2026)

Cuatro callables estan **desplegadas y sin un solo llamador**: no hay envoltorio en
`src/lib/firebase/auth.ts` ni control en la interfaz. El backend existe, la funcionalidad no.

| Callable | Requisito | Consecuencia de que no exista |
|---|---|---|
| `disableCommunitySignupsInRange` | RF_41, RF_42 | La spec la declara **el unico remedio ante un enlace filtrado**, y hoy un administrador real no puede ejecutarla. Es el hueco mas caro de la lista. |
| `setCommunityLogo` | RF_14, RF_16 | La marca del lider es una historia de usuario entera; el enlace se pinta siempre con la marca de la plataforma. |
| `reassignSellerCommunity` | RF_11 | Solo un administrador puede reasignar, y ninguno puede. |
| `raiseCommunityPricesToFloor` | RF_35 | Ver 4.7: no lo llama nadie, ni cliente ni servidor. |

A esto se suman dos huecos que no son de cableado sino de implementacion: la lista de comunidades del
admin **no muestra el cashback causado** que pide RF_34, y `LiquidationRow.role` solo admite
`"seller" | "driver"`, asi que la pantalla de liquidaciones **no puede crear un corte de
`community_leader`** aunque `createSettlement` lo acepte — el "pagado" del lider es cero por
construccion (RF_49).

**Decision del 10-09-2026: se construyen las cuatro**, RF_41 primero por ser el remedio unico. Sin
esto, cerrar el Definition of Done dejaria requisitos MUST sin poder ejecutarse.

## 3. Modelo de datos

```ts
// --- Coleccion nueva: communities/{communityId} ---
export type CommunityPricingFields = {
  sellerDeliveredFeeCop?: number;
  sellerFailedFeeCop?: number;
  fulfillmentFeeCop?: number;
};

export type ScheduledPriceChange = {
  field: keyof CommunityPricingFields;
  fromCop: number;
  toCop: number;
  effectiveAt: string;      // ISO. +8 dias para subidas (RF_28)
  scheduledBy: string;
  scheduledAt: string;
};

export type Community = {
  id: string;
  name: string;                       // nombre visible, no unico (caso limite)
  slug: string;                       // nombre corto, unico
  leaderName: string;
  leaderEmail: string;
  leaderPhone: string;
  logoPath?: string;                  // ruta en Storage, no URL firmada
  linkStatus: "active" | "revoked";   // RF_05
  status: "active" | "disabled";      // cuenta del lider, RF_51
  pricing: CommunityPricingFields;    // precio VIGENTE
  scheduled?: Partial<Record<keyof CommunityPricingFields, ScheduledPriceChange>>; // una por concepto (RF_54)
  massSignupAlertAt?: string;         // RF_13
  massSignupAlertDismissedAt?: string;// RF_53
  createdAt: string;
  updatedAt: string;
};

// communities/{id}/priceHistory/{autoId}  -- RF_39, se conserva aunque el lider se desactive
export type CommunityPriceHistoryEntry = {
  field: keyof CommunityPricingFields;
  fromCop: number; toCop: number;
  effectiveAt: string;
  actorUid: string; actorRole: Role;
  createdAt: string;
};

// --- Coleccion nueva: communitySlugs/{slug}  -- unicidad atomica y vigencia de 30 dias ---
export type CommunitySlugDoc = {
  communityId: string;
  retiredAt?: string;   // presente = slug viejo; vale hasta retiredAt + 30 dias (RF_03)
};

// --- Seller: campos anadidos ---
communityId?: string;         // RF_11, permanente salvo reasignacion de admin
communityJoinedAt?: string;   // RF_08
communitySignupSlug?: string; // por que enlace entro (RF_08)
onboardingComplete?: boolean; // ciudad + punto de recogida + cuenta bancaria (RF_44)

// --- Order: precio congelado al crear (RF_21) ---
export type OrderCommunityPricing = {
  communityId: string;
  frozenAt: string;
  /** final = lo que paga la tienda; base = lo que cobra Kentro. cashback = final - base. */
  sellerDeliveredFeeCop: number; baseDeliveredFeeCop: number;
  sellerFailedFeeCop: number;    baseFailedFeeCop: number;
  fulfillmentFeeCop: number;     baseFulfillmentFeeCop: number;
};
communityPricing?: OrderCommunityPricing;   // ausente => RF_37: base y sin cashback

// --- WalletEntry / Settlement: se amplian los enumerados ---
ownerType: "seller" | "driver" | "admin" | "community_leader";
type: ... | "community_cashback";
Settlement.kind: "seller" | "driver" | "supplier" | "community_leader";

// --- Role ---
export type Role = "admin" | "seller" | "seller_logistics" | "driver" | "messenger" | "community_leader";
```

**Por que se guardan final Y base en el pedido:** el cashback es la resta de dos numeros que en el
futuro cambian por separado. Guardar solo la resta impide auditar de donde salio; guardar solo el
final obliga a adivinar la base historica. Con los dos, RF_36 (nunca negativo) y RF_37 (sin precio
congelado, base y cero cashback) se comprueban leyendo el propio pedido.

## 4. Algoritmos criticos

### 4.1 Precio vigente de una comunidad (`resolveCommunityPricing`)

Entrada: base ya resuelta por `resolveTariffs` (zona > ajustes > defecto), documento de comunidad,
instante actual. Salida: precio final por concepto.

1. Por cada concepto, partir del precio de la comunidad si existe; si no, de la base.
2. Aplicar los cambios programados cuya `effectiveAt` ya paso (`applyScheduledChanges`): un cambio
   vencido deja de estar programado y pasa a ser el precio vigente. Es una funcion pura sobre el
   instante que se le pasa, no sobre el reloj: asi las pruebas no simulan tiempo.
3. **Elevar al piso**: si el precio resultante es menor que la base, devolver la base (RF_35). Nunca
   por debajo, sea cual sea el orden en que cambiaron base y precio (RF_36).
4. El resultado es el precio final. `cashback_concepto = final - base`, siempre >= 0 por el paso 3.

**Cual es "la base", con zonas de por medio (H6).** `resolveTariffs` da prioridad a la tarifa de zona
sobre la global, asi que la base **no es una cifra unica**: depende de la zona del pedido. Se resuelve
en dos niveles, a proposito:
- Al **programar** un precio, el lider se valida contra la base global. Es la unica cifra estable en
  ese momento y es la que se le puede ensenar como minimo.
- Al **congelar** un pedido, el piso es la base efectiva de ese pedido (zona si la hay, global si no).
  Si la zona es mas cara que el precio del lider, el cashback de ese pedido es cero.
Para que ese cero no sea silencioso —el modo de fallo que mas veces ha mordido a este proyecto—, el
pedido guarda ambos numeros y el panel del lider muestra un contador de "pedidos sin cashback porque
la tarifa de zona supera tu precio" (RF_29 y 4.5). El lider ve por que no cobro, en vez de ver menos
dinero sin explicacion.

La elevacion al piso **no** reescribe el documento en esta funcion: la funcion se queda pura y la
escritura la hace un disparador aparte, para que el aviso al lider (RF_35) salga una sola vez y no en
cada lectura. **Cual es ese disparador se decide en 4.7**, porque la version anterior de este plan
afirmaba que lo hacia "el callable de administracion cuando el admin sube la base" y eso era falso:
ese callable existe y no lo llama nadie.

### 4.2 Congelado al crear el pedido (`freezeOrderPricing`)

Se llama en los seis puntos de creacion. Si la tienda no tiene `communityId`, no se escribe
`communityPricing` y el pedido queda gobernado por la tarifa viva de siempre: **ninguna cifra cambia
para tiendas sin comunidad** (punto 6 del Definition of Done). Si lo tiene, se resuelve el precio
vigente y se guardan los seis numeros. La comunidad se lee una vez por pedido; en los webhooks que
crean en lote, se cachea por `communityId` dentro de la misma invocacion.

### 4.3 Asiento de cashback (dentro de `buildWalletEntries`)

Se emite **despues** de la linea 156 que fija `sellerFailedFeeCop: 12000`, y sustituyendo los valores
por los congelados cuando el pedido trae `communityPricing`. Reglas:

- Pedido entregado: cobro a la tienda = `sellerDeliveredFeeCop` congelado; cashback =
  `sellerDeliveredFeeCop - baseDeliveredFeeCop`.
- Fallido cobrable (`failed_visit` o categoria ausente, regla de oro #4): idem con los campos de
  fallido, y respetando el sufijo de intento que ya existe.
- Manejo (`fulfillmentMode === "warehouse"`): idem con los de manejo.
- Un unico asiento por pedido y concepto, con id determinista
  `we-{orderId}-community-cashback-{concepto}`, `ownerType: "community_leader"`,
  `ownerId: communityId`. La idempotencia por id es lo que ya permite cerrar dos veces sin duplicar.
- **Si el cashback de un concepto es 0, no se emite asiento.** Un asiento de cero ensucia los cortes.
- **DANDA (H7).** Sus tarifas van fijas en codigo y una de ellas depende de la **fecha de entrega**,
  desconocida al crear el pedido: congelar al crear y respetar DANDA al cerrar son incompatibles.
  Se resuelve por exclusion, no por precedencia: `freezeOrderPricing` **no congela** a las tiendas con
  tarifa especial en codigo, que siguen intactas por el camino de siempre. DANDA no pertenece a
  ninguna comunidad, asi que no se pierde nada. Si un dia una de esas tiendas entra en una comunidad,
  la funcion falla en alto en vez de calcular mal: es preferible un error visible a un cashback que
  nadie puede explicar.

### 4.4 Correccion de estados terminales (`order-corrections-plan.ts`)

Se anaden los asientos de cashback al mismo mecanismo que ya existe, sin inventar otro:
- Corte del lider **pagado o conciliado**: no se toca. Se emite un asiento
  `-correction-reverse-community-cashback-*` de signo contrario en el periodo abierto (RF_24).
- Corte **pendiente**: se recalcula el corte, como ya se hace para tienda y domiciliario (RF_25).
Como el planificador es puro, `dryRun: true` sigue devolviendo exactamente lo que se va a escribir.

### 4.5 Cifras del lider (`getCommunityStats`)

Sin descargar un solo pedido (RNF_01). **Los contadores salen de `orders`, el dinero de
`walletEntries`** — por el hallazgo 5. Tres ejes, cada uno rotulado en pantalla (RF_46):

- **Eje creacion** — `orders.where("communityId","==",id).where("createdAt", rango).count()`, y el
  mismo agregado por `sellerId` para el desglose por tienda (RF_30). Exige `communityId`
  **denormalizado en el pedido** al crearlo: sin el habria que consultar por lista de tiendas, y `in`
  admite 30 como mucho.
- **Eje despacho** — `count()` con `pickedUpAt` en rango. Los pedidos nunca despachados no tienen el
  campo y por tanto no entran, que es justo lo que se quiere. Resuelve el "despachados" de RF_29.
- **Eje cierre** — `count()` con `closedAt` en rango y `status` en `delivered` / `failed`. **Requiere
  escribir `closedAt` de forma fiable**, que hoy solo ocurre en un camino (hallazgo 3). No hace falta
  rellenar el historico: las comunidades no existen todavia, asi que **todo pedido con `communityId`
  nacera despues de este cambio** y llevara su `closedAt`. Es la razon por la que este eje es viable
  ahora y no lo era para el panel del admin.
- **Cashback** — unico agregado sobre `walletEntries`: `sum("amountCop")` con
  `ownerType == "community_leader"`, `ownerId == id` y `createdAt` en rango. Las reversas de
  correccion entran con signo negativo y netean correctamente, que es exactamente lo que debe pasar.
  Causado frente a pagado se parte por el estado del corte (RF_49).
- **Tiendas activas** = las que tienen al menos un pedido creado en el periodo (RF_47); las demas se
  cuentan aparte, del mismo agregado por tienda y sin consulta extra.
- **Pedidos cuyo markup se comio el piso de zona** — contador propio, para que el efecto del
  hallazgo H6 nunca sea silencioso (ver 4.1).
- "Cero real" frente a "sin datos" (RF_33): la respuesta trae `storeCount` y `hasOrders`; el cliente
  distingue con eso, no infiriendolo de un cero.

**Reparto por probabilidad:** `functions/src/community-stats.ts` es solo el callable (consultas y
Zod). Toda la aritmetica —armado de rangos, porcentaje de entrega con su denominador, activas frente
a inactivas, cero real frente a sin datos— vive en `functions/src/community-stats-math.ts`, **puro**,
que es lo unico que importan las pruebas. Es el mismo reparto que ya existe entre `orders.ts` y
`settlement-math.ts`.

### 4.6 Registro publico atomico (`registerSellerBySlug`)

Orden deliberado, para cumplir RF_45 (o todo o nada) sin transacciones entre Auth y Firestore, que no
existen:
1. Resolver el slug (vigente o retirado hace menos de 30 dias) y comprobar `linkStatus` y `status`.
   Si falla, salir sin tocar nada (RF_09).
2. Crear el usuario en Auth. Si el correo existe, Auth falla y se sale sin crear tienda (RF_10).
3. En una transaccion de Firestore: crear la tienda, adscribirla y contar las altas de la ultima hora
   deslizante para el aviso (RF_13).
4. Asignar el reclamo de rol.
5. **Si 3 o 4 fallan, se borra el usuario de Auth creado en 2** y se devuelve error. Ese borrado es lo
   que deja el correo libre para reintentar, que es la mitad de RF_45 que se suele olvidar.

El aviso de captacion masiva **no bloquea** (RF_13): marca la comunidad y las altas, y sigue.

### 4.7 Quien dispara la elevacion al piso (RF_35)

**El problema.** `raiseCommunityPricesToFloor` (`functions/src/communities.ts:292`) esta escrita,
desplegada y **sin un solo llamador en todo el repo**. Y la tarifa base no la escribe ningun callable:
la escribe el cliente, directo a `settings/app`, en el autoguardado de
`src/lib/firebase/state-store.ts:293`. De modo que RF_35 —"MUST elevar automaticamente los precios que
queden por debajo de la base y MUST notificarselo al lider"— no esta implementado de punta a punta.

**Dos opciones y por que se descarta la primera.**

1. *Llamada explicita desde el guardado de ajustes.* El cliente, tras escribir `settings/app`, invoca
   el callable. Es la de menos piezas, pero deja la correccion **a merced del navegador**: si la
   pestana se cierra, la red falla o el guardado sale por otro camino, la subida de base queda escrita
   y los precios de comunidad NO se elevan. El sintoma es que Kentro cobra por debajo de su costo, en
   silencio y sin fecha de caducidad. Es exactamente el modo de fallo que la regla de oro #5 describe:
   no falla, no avisa, solo muestra menos dinero del que se debe.
2. *Trigger `onDocumentUpdated` sobre `settings/app`.* **Elegida.** Se dispara escriba quien escriba
   —el autoguardado de hoy, un script de mantenimiento manana, una edicion a mano en la consola— y no
   se puede saltar desde el cliente. El coste es una invocacion por escritura de ajustes, que son
   raras.

**Como se comporta el trigger.**

- Compara tarifas **antes y despues**. Si ninguna base **sube**, termina sin escribir: una bajada de
  base no puede subirle el precio a nadie, y el resto de campos de `settings/app` (que son muchos) no
  tienen nada que ver con esto.
- Por cada comunidad con un precio por debajo de la base nueva, eleva ese concepto al piso, deja
  entrada en el historial de precios (RF_39: quien, cuando, de cuanto a cuanto, desde cuando) con
  autor `system:floor` y marca el aviso que la interfaz del lider muestra (RF_35).
- **La elevacion al piso es la unica subida exenta de los ocho dias** (RF_40), porque el plazo dejaria
  a Kentro cobrando por debajo de su costo durante ocho dias. Aplica de inmediato.
- **No hay recursion**: escribe en `communities`, nunca en `settings/app`.
- **Es idempotente**: correr el trigger dos veces con las mismas tarifas no produce una segunda
  entrada de historial, porque el segundo pase ya no encuentra precios por debajo del piso.
- La base que usa es la **global**, no la de zona, por lo que ya explica 4.1: la de zona depende del
  pedido y se resuelve al congelar, con su contador propio para que el cashback cero nunca sea mudo.

## 5. Estrategia de testing

Convencion del repo, respetada: las pruebas viven en `src/lib/<modulo>.test.ts` e importan el codigo
de servidor con `../../functions/src/<modulo>`, como ya hacen `settlement-math.test.ts` y
`platform-position.test.ts`. Vitest solo recoge `src/**/*.test.ts`; no se anade un segundo runner.

**Restriccion dura (hallazgo 6):** la raiz no instala `firebase-admin`, asi que una prueba solo puede
importar modulos **puros**. Por eso cada callable tiene su nucleo separado: `community-pricing`,
`community-slug`, `community-stats-math`, `community-access` y `community-signup-validate`. Lo que
queda en el callable es consulta y cableado, y se comprueba con script contra el proyecto real usando
un usuario desechable, como describe `CLAUDE.md`.

**Trazabilidad prueba → requisito (Definition of Done 1):** cada `it()` empieza por el identificador
del requisito, por ejemplo `it("RF_19: rechaza un precio por debajo del piso y conserva el anterior")`.
Asi `grep -o "RF_[0-9]*" src/lib/*.test.ts | sort -u` responde en un segundo que requisitos tienen
prueba, y el auditor no tiene que adivinar.

| Archivo de prueba | Requisitos |
|---|---|
| `src/lib/community-pricing.test.ts` | RF_17-RF_23, RF_28, RF_35-RF_38, RF_54 |
| `src/lib/community-slug.test.ts` | RF_02, RF_03, RF_04 |
| `src/lib/community-cashback-entries.test.ts` | RF_22, RF_23, RF_26 y la no regresion sin comunidad |
| `src/lib/community-corrections.test.ts` | RF_24, RF_25 |
| `src/lib/community-stats.test.ts` | RF_29, RF_30, RF_46, RF_47, RF_48 |
| `src/lib/community-access.test.ts` | RF_05, RF_06, RF_11, RF_12, RF_27, RF_31, RF_34, RF_44, RF_50, RF_51, RF_52 |
| `src/lib/community-signup.test.ts` | RF_07, RF_08, RF_09, RF_10, RF_13, RF_43, RF_45 |
| `src/lib/community-containment.test.ts` **(nuevo, T31/T32)** | RF_41, RF_42, RF_53 |
| `src/lib/community-view.test.ts` | RF_01, RF_14, RF_15, RF_16, RF_32, RF_33, RF_39, RF_40 |
| `src/lib/settlement-math.test.ts` | RF_26, RF_49 (reparto causado/pagado, T33) |
| `src/lib/community-pricing.test.ts` *(anadido)* | RNF_04 y RF_40 (T39), RF_35 (T47) |
| `src/lib/community-view.test.ts` *(anadido)* | RF_34 (T34) y las filas de corte de lider (T43) |
| `src/lib/community-cashback-entries.test.ts` *(anadido)* | RNF_01 (T28, T42) |

**Los RNF tambien entran en la tabla.** No estaban, y RNF_01 es justo el que se midio y fallo: un
indice del auditor que omite los no funcionales no es un indice.

Tres movimientos respecto a la version anterior de esta tabla, para que siga sirviendo de indice al
auditor: **RF_44** pasa a `community-access.test.ts` (su predicado vive en `community-access.ts`),
**RF_49** a `settlement-math.test.ts` (el reparto causado/pagado es aritmetica de cortes) y
**RF_41/RF_42/RF_53** salen de `community-signup.test.ts` al archivo nuevo de contencion, que es donde
esta su nucleo.

**Que se simula y como.** Nada de relojes globales: toda funcion que dependa del tiempo recibe el
instante como parametro, que es el patron que ya usa `dandaDeliveredFeeCop` con `deliveredAtIso`.
Firestore no se simula. **Ninguna prueba toca datos reales**: los fixtures son objetos literales en el
propio archivo, al estilo de `emptyState` en `src/lib/seed.ts`.

**Prueba de no regresion obligatoria:** un pedido de tienda **sin** comunidad debe producir
exactamente los mismos asientos que hoy. Es el punto 6 del Definition of Done y la unica garantia de
que esta funcionalidad no mueve el dinero que ya existe.

**Lo que no cubre Vitest**: `firestore.rules` y `storage.rules` se verifican con una sesion real
—usuario desechable y `signInWithPassword`— comprobando que una lectura ajena devuelve 403. Queda
anotado como paso manual del Definition of Done, no disfrazado de prueba automatizada.

## 6. Dependencias nuevas

**Ninguna.** Todo se resuelve con lo instalado:
- Validacion: `zod` 3.24, ya en `functions/` y en la raiz.
- Agregacion: `count()` y `sum()` vienen en `firebase-admin` 12.2, ya instalado. No hace falta nada.
- Logo: Firebase Storage, ya en uso y con `storage.rules` propio.
- Fechas: `date-fns` 3.6 en cliente; en servidor basta `Date`, como en el resto de `functions/`.

## 7. Orden de despliegue (regla de oro #12)

1. `firestore:indexes` — indices nuevos: `orders(communityId, createdAt)`, `orders(communityId,
   sellerId, createdAt)`, `walletEntries(ownerType, ownerId, createdAt)`. **Comparar antes contra
   produccion**, que desplegar borra los que falten en el archivo. Esperar a `READY`.
2. `functions` — con el guard: compilar y `ALLOW_FUNCTIONS_DEPLOY=1`, tras verificar que el set local
   coincide con produccion.
3. `firestore:rules`.
4. `hosting` — el ultimo, y solo con `npm run lint` en verde.

## 8. Riesgos

| Riesgo | Mitigacion |
|---|---|
| Olvidar uno de los seis puntos de creacion | Un unico helper `freezeOrderPricing` y una prueba por cada camino. Si falta uno, el sintoma es silencioso: el lider no cobra. |
| La linea 156 de `wallet-entries.ts` anula el precio de fallido | Prueba dedicada que falla si vuelve a pisarse. |
| El panel del lider degrada como degrado el del admin | RNF_01 se mide antes de dar por hecha la tarea, comparando la cuenta de documentos con 100 y con 10.000 pedidos. **Medido el 10-09-2026: NO se cumple** (100 pedidos/100 documentos, 10.000/10.000, 2,67 MB). Ver la correccion de abajo. |
| `getWalletForContext` no es el espejo que su comentario dice ser | No tiene rama de `community_leader` y cae al fallback `getCollection("walletEntries")`: **la coleccion entera**. Hoy queda tapado porque la suscripcion mete `wallet` en `skip`, pero es la divergencia carga-inicial/listener que este proyecto ya documenta, y contra las reglas seria un 403. |

| Alta automatica sin tope (decision de negocio) | Aviso + revocacion + desactivacion en bloque. Documentado como riesgo aceptado en la spec. |

### Correccion sobre RNF_01 (10-09-2026)

La suscripcion de wallet del lider (`src/lib/firebase/state-store.ts:468`) baja **un asiento por
pedido de la comunidad**, sin ventana ni limite. Lo que este plan no vio es que **se puede eliminar,
no solo acotar**: `CommunityLeaderView` no lee `state.wallet` en ningun punto — el cashback causado
llega agregado del servidor por `getCommunityStats` y el pagado sale de `state.settlements`.

Y los dos sitios a tocar **no** son los que dice la trampa habitual del proyecto:
`getOrdersForContext` ya devuelve `[]` para este rol (`state-store.ts:940`). El par real es la
**suscripcion** (`:468`) y **`getWalletForContext`** (`:956-965`), que hoy no distingue este rol.
| Alta automatica sin tope (decision de negocio) | Aviso + revocacion + desactivacion en bloque. Documentado como riesgo aceptado en la spec. |
