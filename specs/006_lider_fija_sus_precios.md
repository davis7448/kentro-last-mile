# Spec 006: El lider fija sus precios desde su pantalla

- **Estado:** borrador (propuesto por el informe de cierre del ciclo 004/005, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15

## 1. Contexto y objetivo

Todo lo que hace falta en el servidor para que un lider fije precios existe y esta probado:
`scheduleCommunityPrice` (`functions/src/communities.ts:837`) valida contra la base real de la 004
(RF_05), programa las subidas a ocho dias (RF_28 de la 001), aplica las bajadas al instante (RF_38),
admite una sola subida programada por concepto (RF_54) y escribe el historial (RF_39);
`cancelScheduledCommunityPrice` (`:894`) retira una subida antes de que entre (RF_40). Los envoltorios
de cliente tambien existen (`src/lib/firebase/auth.ts:582` y `:589`) y las reglas dejan al lider leer
`communities/{id}/priceHistory` (`firestore.rules:174`).

**Ninguna pantalla los llama.** `operations-app.tsx` no menciona ninguno de los dos. En consecuencia
hoy toda comunidad cobra la base y causa cashback cero, y la unica forma de que un lider tenga precio
propio es que alguien invoque la callable a mano. Las specs 001, 003 y 004 lo dejaron fuera de
alcance tres veces seguidas ("es otra spec"). Esta es esa spec.

**Objetivo:** que el lider, desde su pantalla de comunidad, vea por concepto lo que cobra hoy, la
base y el margen; fije un precio nuevo; vea y cancele una subida programada; y lea su historial. Sin
reimplementar en el cliente ninguna regla que ya decide el servidor.

## 2. Historias de usuario

- **Como** lider de comunidad **quiero** fijar el precio de entrega, fallido y manejo de mis tiendas
  **para** ganar el margen por el que acepte liderar.
- **Como** lider **quiero** ver la fecha exacta en que entra una subida y poder cancelarla **para**
  no sorprender a mis tiendas ni sorprenderme yo.
- **Como** lider **quiero** que la pantalla me diga el minimo antes de escribir un precio **para** no
  adivinar contra el servidor.
- **Como** responsable de la plataforma **quiero** que la pantalla solo llame a las callables que ya
  existen **para** que la regla del piso siga viviendo en un solo sitio (RF_02 de la 004).

## 3. Requisitos funcionales (EARS + RFC 2119)

### 3.1 Lo que ve

- **RF_01 (estado):** **Mientras** la cuenta gobierne su comunidad (`communityStanding` = lider) y
  tenga activo el papel de comunidad, el sistema MUST mostrarle, por cada concepto (entrega, fallido
  cobrable, manejo): el precio que se cobra hoy a un pedido sin zona, la base de RF_01 de la 004 y el
  margen por pedido. Las tres cifras MUST salir de `buildStoreTariffView` / `resolveCommunityPricing`,
  nunca de un calculo en el JSX (RF_02 de la 004).
- **RF_02 (ubicua):** Junto a las cifras el sistema MUST mostrar el aviso de zona (`ZONE_BASE_NOTICE`,
  RF_12 de la 004).
- **RF_03 (estado):** **Mientras** exista una subida programada para un concepto, el sistema MUST
  mostrarla aparte del precio vigente, con su valor y su fecha de entrada, y MUST ofrecer cancelarla
  (RF_40 de la 001).
- **RF_04 (ubicua):** El sistema MUST mostrar el historial de precios de la comunidad (quien, cuando,
  de cuanto a cuanto, desde cuando), incluidas las elevaciones firmadas `system:floor`, sin
  reescribir ni filtrar ninguna entrada (RF_39 de la 001).

### 3.2 Lo que hace

- **RF_05 (evento):** **Cuando** el lider fije un precio para un concepto, el sistema MUST enviarlo a
  `scheduleCommunityPrice` tal cual, y MUST mostrar el resultado que devuelva el servidor: si es
  una bajada, que ya entro (RF_38 de la 001); si es una subida, la fecha exacta en que entra (RF_28).
- **RF_06 (error):** **Si** el servidor rechaza el precio por estar bajo la base, el sistema MUST
  mostrar el motivo que devuelve el servidor (`reason` de `validateCommunityPriceFloor`), que ya nombra
  la base como minimo y el aviso de zona. MUST NOT sustituirlo por un texto propio.
- **RF_07 (ubicua):** El control de precio MAY anticipar la base como minimo (para no dejar teclear
  por debajo), pero la anticipacion MUST leerse del mismo dato que muestra RF_01 y MUST NOT ser la
  unica barrera: el servidor decide (RNF_02 de la 003).
- **RF_08 (evento):** **Cuando** el lider cancele una subida programada, el sistema MUST llamar a
  `cancelScheduledCommunityPrice` y, si el servidor responde que la subida ya entro en vigor
  (`failed-precondition`), MUST decirlo y refrescar el precio vigente en vez de fingir la cancelacion.

### 3.3 Quien no

- **RF_09 (estado):** **Mientras** la cuenta ya no gobierne la comunidad (acreedora), el sistema MUST
  NOT mostrar ningun control de edicion, y MUST seguir mostrandole lo que se le debe (RF_12 de la 005).
- **RF_10 (ubicua):** La pantalla MUST NOT mostrar pedidos, clientes ni saldos de las tiendas (RF_09 de
  la 003). Precios e historial de la comunidad, nada mas.

## 4. Requisitos no funcionales

- **RNF_01:** La pantalla MUST NOT anadir descargas continuas: el documento de la comunidad ya llega
  con la carga base; el historial se pide por consulta acotada (las ultimas N entradas) y solo al
  abrir esa seccion (principio 11 de la constitucion).
- **RNF_02:** Sistema de diseno vigente (`docs/design-system.md`), cabe en 390 px y no depende de
  nada que iOS 14 no entienda (principio 2).
- **RNF_03:** Ninguna cuenta sin sombrero de comunidad MUST cambiar de comportamiento.

## 5. Casos limite

- **El lider fija exactamente la base.** El servidor lo acepta (RF_18 de la 001); la pantalla lo
  muestra como base con margen $0, igual que el panel del administrador (RF_08 de la 004).
- **Programa una subida y antes de que entre la base sube por encima** (RF_13 de la 004): el
  servidor descarta la programada; la pantalla MUST reflejarlo al refrescar, no seguir mostrando una
  subida que ya no existe.
- **Dos subidas seguidas del mismo concepto** (RF_54): la segunda reemplaza a la primera y reinicia
  los ocho dias; la pantalla muestra una sola, con la fecha nueva.
- **Cancelar una subida que ya entro:** el servidor la niega (`planScheduledRaiseCancellation`); ver
  RF_08.
- **Historial largo:** se pagina o se acota; nunca se baja entero.

## 6. Fuera de alcance

- **El aviso de elevacion al piso** (marca `floorRaisedAt`): es la spec 008. Esta pantalla solo
  muestra la entrada `system:floor` en el historial.
- **Precio por zona.** El lider fija un precio unico (fuera de alcance en la 004 tambien).
- **Que el administrador fije precios en nombre del lider.**

## 7. Definition of Done

1. Cada RF y RNF con al menos una prueba automatizada que pasa (`npm test`). La vista (cifras,
   subida aparte, historial ordenado) se prueba como funcion pura en `src/lib/community-view.ts`.
2. Guarda de fuente: la pantalla llama a los envoltorios de `auth.ts` y no reimplementa
   `validateCommunityPriceFloor` ni `scheduleEffectiveAt`.
3. `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` sin errores, build sin `static{`.
4. Evidencia en produccion con una comunidad y un lider desechables (prefijo reconocible): fijar un
   manejo por encima de la base, ver la subida programada, cancelarla, ver el historial. **Sin
   pedidos ni dinero**: fijar un precio no causa cashback hasta que se cierra un pedido, y no se
   cierra ninguno. Limpieza repetible que comprueba que no queda nada con el prefijo.
5. Capturas en escritorio y a 390 px, tomadas **despues** de que la pantalla termine de cargar (la
   captura de escritorio de la 005 pillo el "Cargando": el guion espera al selector de la cifra,
   no a un tiempo fijo).
6. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Propuesta del informe de cierre del ciclo 004/005: la callable y sus envoltorios existen desde la 001 y ninguna pantalla los usa; dejado fuera de alcance en la 001, la 003 y la 004 |
