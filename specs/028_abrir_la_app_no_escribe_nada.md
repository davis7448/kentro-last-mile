# Spec 028: Abrir la app como administrador no escribe nada

- **Estado:** aprobada
- **Autor:** Claude (prueba E2E de la spec 023, 2026-11-10)
- **Fecha:** 2026-11-10
- **Aprobada por:** el responsable, 2026-11-10 ("Aprobar spec 028"), sobre el borrador del mismo dia. P1 y P2
  siguen sin responder; no bloquean la implementacion porque la spec no toca valores (RNF_04).
- **Origen:** la prueba E2E de la spec 023 con una cuenta admin desechable aborto 8 intentos de escritura al
  abrir la app sin tocar nada, igual en la version anterior y en la nueva. Ya se habia visto en octubre
  (memoria "autoguardado-admin-pisa-tarifas", spec 028 sin archivo hasta hoy).

## 1. Contexto y objetivo

El administrador tiene un **autoguardado**: un efecto de `useAppState` (`src/components/operations-app.tsx`) que,
cada vez que cambia el estado en el navegador por algo que no vino del servidor, llama a `saveFirestoreState`
(`src/lib/firebase/state-store.ts`). Esa funcion escribe `settings/global` y las 12 colecciones de
`AUTOSAVED_COLLECTIONS` que hayan cambiado frente a `lastRemoteCollections`, y **lo escribe todo** cuando esa
referencia es `null`.

### Lo que se midio (2026-11-10, produccion, solo lectura)

Guion: `PROD_URL=https://kentro-last-mile.web.app node e2e/verify-028-writes.mjs`. Entra con una cuenta admin
desechable, espera 45 s sin hacer clic y decodifica cada mensaje del canal `Write` de Firestore. Deja pasar el
saludo del canal, que no escribe, y aborta todo mensaje que lleve `writes`. Evidencia en
`.sdd/evidence/028/admin-abre-sin-tocar-2026-11-10.json`.

- **Que se intenta escribir:** dos lotes, a los **596 ms y 602 ms** de pulsar "Entrar". Cada lote lleva
  `settings/global` (`set` con `merge`, los 10 campos de fabrica de `emptyState()` mas `updatedAt`) y
  `cities/city-cali` (`id`, `name`, `active`). Nada mas: ningun pedido, ninguna wallet y ninguna callable.
- **Por que son 8 (o 28):** el SDK reintenta los dos lotes con espera exponencial mientras no recibe
  confirmacion. La 023 contaba los saludos reintentados. Sin abortar seria **un solo intento de commit por
  lote**.
- **Cuando:** antes de que llegue el estado del servidor ("base ligera lista" a los 1.582 ms). El estado que
  se escribe es el **de fabrica**, sin nada leido de produccion.

**Mecanismo (leido del codigo y coherente con la medicion).** En la pantalla de entrada no hay sesion, asi que
`useAppState` hidrata desde `localStorage` y marca `hydrated = true` con `emptyState()`. Cuando llega la sesion,
`remoteEnabled` pasa a `true` (y `setState` cambia `activeRole`), pero `hydrated` **sigue en `true` desde el
modo local**. El efecto de autoguardado ve entonces "hidratado, remoto, admin, el cambio no vino del servidor"
y guarda. `lastRemoteCollections` todavia es `null`, asi que escribe todo lo que no esta vacio: las tarifas de
fabrica y `city-cali`. Hay dos ejecuciones del efecto (cambia `state` y cambia `remoteEnabled`), y por eso
salen dos lotes.

**Segundo defecto, el de todos los dias.** `withoutLegacyDemo` rehace `settings` como objeto nuevo
(`{ ...base.settings, ...state.settings }`) en cada emision del servidor. Por eso `state.settings` nunca es
identico a la referencia guardada, y **cualquier** cambio local posterior reescribe `settings/global` aunque nadie
toque una tarifa, rellenando con valores de fabrica cualquier campo que falte en produccion. El trigger
`onSettingsFloorRaise` (que solo salta cuando se actualiza `settings/global`) se ejecuto con exito **entre 1 y
65 veces al dia** del 2026-10-11 al 2026-11-10 (Cloud Logging). Nadie cambia las tarifas 65 veces al dia.

### Como esta `settings/global` hoy (leido con Admin SDK, sin escribir)

| Campo | Produccion hoy | Lo que escribe la app al abrir (`emptyState`) |
|---|---|---|
| `sellerDeliveredFeeCop` | 12.000 | 12.000 |
| `sellerFailedFeeCop` | **9.000** | **12.000** |
| `fulfillmentFeeCop` | 2.000 | 2.000 |
| `driverDeliveredPayCop` | **8.000** | **9.000** |
| `driverFailedPayCop` | **8.000** | **9.000** |
| `pendingReserveCop`, `debtBlockDays`, `failedRateAlertPercent`, `payoutDays`, `activeCityId` | iguales | iguales |

`updatedAt` = 2026-11-10 12:31:19 UTC. **Hoy no tiene valores de fabrica**: tres tarifas difieren. Por eso,
si el lote de arranque llega a confirmarse, cambia dinero. Las tres zonas (`zones`) traen sus propias tarifas
(12.000 / 12.000 / 9.000 / 9.000), y `resolveTariffs` les da prioridad. El fallido de la tienda se fija ademas
en codigo (`SELLER_FAILED_FEE_FIXED_COP`). Lo expuesto a `settings/global` es el **pago al domiciliario de
los pedidos sin zona**.

**Lo que NO se pudo probar sin escribir:** si en una sesion real (sin abortar) el lote de fabrica llega a
confirmarse y cuanto dura antes de que un guardado posterior reponga los valores leidos. Hay un indicio sin
explicar: desde el 2026-10-11 hay **4 asientos `driver_earning` de 9.000 en pedidos sin zona**
(shopify-7742993924385, shopify-7615305973932, shopify-7646694572204, shopify-7820453413153), cuando la tarifa
global es 8.000. Pueden venir de este fallo o de otra regla. Esta spec no los atribuye (ver P2).

### Objetivo

Que abrir la app, como cualquier rol, **no escriba ningun documento**. Que `settings/global` solo se escriba
cuando el administrador cambia un ajuste, y solo con lo que cambio. Que el estado de fabrica no pueda llegar
nunca a Firestore.

## 2. Historias de usuario

- **HU_01 (sin interfaz):** **Como** responsable de la plataforma **quiero** que entrar como administrador no
  toque las tarifas **para** que lo que se paga al domiciliario y se cobra a la tienda sea lo que yo fije, y no
  lo que traiga el codigo de fabrica.
- **HU_02 (interfaz):** **Como** administrador **quiero** que, cuando cambio una tarifa en Ajustes, se guarde
  igual que hoy **para** que el arreglo no me quite la forma de cambiarlas.
- **HU_03 (sin interfaz):** **Como** responsable **quiero** que el trigger de pisos de comunidad salte solo
  cuando de verdad cambian los ajustes **para** que una elevacion de piso nunca venga de un guardado fantasma.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (estado):** **Mientras** la sesion remota no haya recibido su primer estado del servidor, el
  sistema MUST NOT escribir ningun documento en Firestore desde el autoguardado. El estado hidratado en modo
  local (`localStorage`, `emptyState()`) MUST NOT contar como hidratacion para la sesion remota.
- **RF_02 (evento):** **Cuando** un administrador abre la app y no cambia nada, el sistema MUST NOT enviar
  ninguna escritura a Firestore ni llamar a ninguna callable de escritura durante la sesion.
- **RF_03 (ubicua):** El sistema MUST NOT persistir en Firestore los valores de `emptyState()` ni de
  `seedState()` por ninguna via del cliente. Eso incluye el callback `onEmpty` de la suscripcion, que hoy
  guarda el `state` de su clausura, es decir, el de fabrica.
- **RF_04 (evento):** **Cuando** llega un estado del servidor, el sistema MUST tomarlo como referencia de lo
  guardado de forma que un cambio local que no toque los ajustes no reescriba `settings/global`. Rehacer
  `settings` como objeto nuevo MUST NOT contar como cambio.
- **RF_05 (evento):** **Cuando** el administrador cambia uno o mas ajustes, el sistema MUST escribir en
  `settings/global` solo los campos que cambio, y MUST NOT rellenar con valores de fabrica los campos que falten
  en el documento.
- **RF_06 (evento):** **Cuando** el administrador cambia una entidad de `AUTOSAVED_COLLECTIONS` (ciudad, zona,
  tienda, etc.), el sistema MUST seguir guardandola como hoy (sin regresion de HU_02).
- **RF_07 (error):** **Si** la carga base falla o vuelve vacia, el sistema MUST NOT escribir nada para
  "inicializar" el estado remoto, y MUST mostrar el aviso de fallo que ya existe.
- **RF_08 (evento):** **Cuando** la sesion cambia (salir y entrar, otra cuenta), el sistema MUST NOT guardar
  con el estado ni con la referencia de la sesion anterior.

## 4. Requisitos no funcionales

- **RNF_01:** La decision "que hay que escribir dado el estado anterior y el nuevo" MUST poder probarse sin
  navegador ni Firestore, con pruebas que cubran RF_01, RF_03, RF_04 y RF_05.
- **RNF_02:** `e2e/verify-028-writes.mjs` contra produccion MUST registrar **0** mensajes con `writes` en 45 s
  de sesion admin sin tocar nada. El guion queda en el repo como guarda repetible.
- **RNF_03:** Tras desplegar, las ejecuciones de `onSettingsFloorRaise` SHOULD bajar al numero de cambios reales
  de ajustes (medido en Cloud Logging durante 3 dias; hoy, de 1 a 65 al dia).
- **RNF_04:** No se tocan los valores de `settings/global` en produccion. Los decide el responsable (ver P1).

## 5. Casos limite

- Un administrador con una pestana abierta desde ayer: la emision del servidor llega con ajustes iguales. No se
  escribe nada.
- Un administrador cambia una tarifa mientras otro tiene la app abierta: el segundo MUST NOT devolver el valor
  viejo con un guardado posterior (hoy lo haria, porque reescribe `settings` entero con lo que tenia en
  memoria).
- La base de produccion queda vacia (proyecto nuevo o emulador): la app no siembra tarifas. El servidor ya tiene
  sus valores por defecto en `resolveTariffs` (`defaultSettings`).
- Otros roles (tienda, logistico, domiciliario, mensajero, lider): ya hoy `saveFirestoreState` sale sin escribir.
  RF_02 se comprueba igual para el admin, que es el unico que escribe.
- Modo local sin Firebase: `localStorage` sigue funcionando como hoy.

## 6. Fuera de alcance

- Fijar o corregir los valores de las tarifas en produccion. Si 8.000 / 8.000 / 9.000 son los correctos lo
  decide el responsable (P1).
- Explicar los 4 asientos de 9.000 sin zona (P2). Si resultan ser de este fallo, se corrigen con
  `correctOrderStatus` o con una spec aparte.
- Sustituir el autoguardado por guardados explicitos por callable. Seria lo coherente con la regla de oro 1,
  pero es mucho mas grande. Esta spec solo quita las escrituras que nadie pidio.
- Que `onSettingsFloorRaise` ignore bajadas y subidas fantasma: si deja de haber escrituras fantasma, no hace
  falta.

## 7. Preguntas para el responsable

- **P1:** En `settings/global`, ¿son correctos `driverDeliveredPayCop = 8.000`, `driverFailedPayCop = 8.000` y
  `sellerFailedFeeCop = 9.000`? La spec no los cambia. Si alguno no es el que quieres, se fija aparte.
  - *Respuesta parcial (2026-11-10):* "a la tienda se le cobra 12". Ya es asi: `resolveSellerCharges` fija el
    fallido de tienda en `SELLER_FAILED_FEE_FIXED_COP = 12000` e ignora el 9.000 de `settings/global` (62 de 63
    `failed_fee` desde el 2026-10-11 son de 12.000). Ese 9.000 es un valor muerto que confunde; corregirlo es
    cosa aparte.
  - *Respuesta (2026-11-10):* "Si, 8.000 y 8.000" para entrega y visita fallida del domiciliario. **P1 cerrada:**
    los valores de produccion de las tarifas del domiciliario son los correctos y la spec los protege. Con eso,
    los 4 pagos de 9.000 de P2 son, salvo otra regla, 1.000 de mas cada uno.
  - *Aclaracion del responsable:* "solo DANDA tiene un valor diferente". Coincide con el codigo: DANDA
    (`seller-1779315416119`) paga 10.000 u 11.000 por entrega y 0 por fallido (`resolveSellerCharges`). Los 4
    pagos de 9.000 son de Bella Mujer (2) y Kovia (2), no de DANDA, asi que esa regla no los explica.
- **P2:** ¿Se revisan ahora los 4 pagos de 9.000 al domiciliario en pedidos sin zona, o se dejan para despues
  de arreglar esto?
  - *Revisado el 2026-11-10 a peticion del responsable (solo lectura).* Los 4 son del mismo domiciliario
    (`driver-1778271901513`), de tiendas sin regla propia (Bella Mujer y Kovia) y sin zona. En ese mismo caso
    (sin DANDA y sin zona) hay 228 pagos de 8.000 y solo estos 4 de 9.000. `resolveTariffs` solo puede dar 9.000
    si `settings/global` decia 9.000 (o le faltaba el campo) en ese momento. Cruzado con las actualizaciones de
    `settings/global` (ejecuciones de `onSettingsFloorRaise`), **cada 9.000 cae entre una actualizacion y la
    siguiente, y ningun 8.000 cae en esos huecos:**

    | Pago de 9.000 | Ultima actualizacion antes | Siguiente actualizacion | 8.000 alrededor |
    |---|---|---|---|
    | 2026-10-16 13:48:19 y 13:48:51 (fallidos #190267, #4258) | 2026-10-15 17:26:51 | 2026-10-16 14:11:52 | 10-15 16:26 antes; 10-16 15:26 despues |
    | 2026-11-05 21:31:59 (fallido #4519) | 2026-11-05 21:31:12 (47 s antes) | 2026-11-05 21:47:38 | 20:21 antes |
    | 2026-11-07 16:18:57 (entregado #193210) | 2026-11-07 14:58:33 | 2026-11-07 17:13:49 | 14:04 antes; 17:57 despues |

    **Conclusion:** es lo que cabe esperar si el lote de fabrica de esta spec **si llego a guardarse** en sesiones
    reales y se quedo puesto hasta que otro guardado repuso 8.000. No es una prueba directa (Firestore no guarda
    versiones y no hay registros de acceso a datos), pero no hay otra regla en el codigo que de 9.000 aqui.
    **Dinero:** 4 x 1.000 = **4.000 de mas** al domiciliario. Tres estan en cortes ya conciliados
    (`stl-1792422938736-…`, dos pagos; `stl-1794012264268-…`, uno) y uno en el corte pendiente
    `stl-1794233484852-…`. Por la regla 10 de la constitucion, los conciliados no se reescriben: se compensan en
    el periodo abierto. Esa correccion **no se ha hecho**; espera decision del responsable.
  - *2026-11-10, el responsable aprueba compensar; se detiene antes de escribir.* Un asiento de compensacion
    **no mueve el efectivo del domiciliario**. `computeDriverCashSummary` calcula lo que debe entregar por
    pedido como `max(0, COD - pagos)`, sumando TODOS los asientos del pedido, tambien los ya cortados.
    - En los 3 fallidos (COD 0) un `driver_earning` de -1.000 no cambia lo esperado y solo descuadra el
      `driverPayCop` mostrado.
    - Sin `orderId` no entra en el calculo.
    - En #193210 (entregado, corte **pendiente** `stl-1794233484852-…`), una reversa que caiga en un corte nuevo
      volveria a esperar su COD entero: es el doble cobro de la memoria `auditar-abonos-domiciliario`.

    Lo unico limpio es recalcular el corte pendiente de #193210 con el pago a 8.000, que sube lo esperado en
    1.000. Ademas, esa misma memoria midio que este domiciliario lleva entregados unos 369.000 **de mas** en todo
    su historial: los 4.000 de mas quedan dentro de un saldo que ya es a su favor.
  - *Decision del responsable (2026-11-10): "Solo el corte pendiente".* Aplicado a las 17:38:36 UTC con
    `scripts/fix-028-driver-pay-193210.js`:
    - El pago de #193210 baja de 9.000 a 8.000 (`correctedFromCop: 9000`).
    - El corte pendiente `stl-1794233484852-…` se recalcula con `computeDriverCashSummary`: lo esperado pasa de
      6.032.440 a 6.033.440 y el pendiente de 819.895 a 820.895.
    - El faltante de recaudo del corte se mueve igual (-820.895).
    - Se registra en `audit` (`YVwk3jOGyVb8o2CfJI0E`).

    Antes de escribir, el calculo sin la correccion reprodujo exactamente el corte guardado. La escritura se hizo
    con precondiciones `lastUpdateTime`. Los otros 3.000, en cortes conciliados, se quedan asi por decision del
    responsable.
  - *Hallazgo al margen:* las tres zonas (`zone-center`, `zone-north`, `zone-south`) tienen 9.000 / 9.000 para el
    domiciliario, y ganan a `settings/global`. Desde el 2026-10-11 solo un pedido con zona (`ord-knt-007112`,
    9.000) uso esa tarifa. Si "solo DANDA tiene un valor diferente", las zonas tambien estan mal configuradas.

## 8. Definition of Done

1. Pruebas automatizadas de RF_01, RF_03, RF_04, RF_05 y RF_07 en verde, y una que falle si se reintroduce el
   guardado con `lastRemoteCollections` nulo.
2. `npx vitest run`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` sin errores.
3. `e2e/verify-028-writes.mjs` contra produccion, tras desplegar: 0 escrituras en 45 s (RNF_02).
4. Prueba de HU_02 en produccion: cambiar una tarifa en Ajustes escribe solo ese campo, y se devuelve a su valor.
   Requiere permiso expreso del responsable porque toca `settings/global`.
5. `settings/global` igual antes y despues del despliegue (comparado campo a campo).
6. Tres dias de `onSettingsFloorRaise` en Cloud Logging (RNF_03).
7. El responsable valida el resultado.

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-10 | Borrador inicial con la medicion de produccion | Prueba E2E de la 023: 8 escrituras al abrir como admin |
| 2026-11-10 | Aprobada | "Aprobar spec 028" del responsable |
