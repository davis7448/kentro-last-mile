# Spec 008: El lider se entera de que su precio fue elevado al piso

- **Estado:** borrador (propuesto por el informe de cierre del ciclo 004/005, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15

## 1. Contexto y objetivo

RF_35 de la 001 dice que cuando la base sube por encima del precio de un lider, el sistema eleva ese
precio y **se lo notifica**. La 004 (RF_13, RF_14) arreglo el disparador —hoy escucha
`settings/global`, que es donde de verdad se guardan los ajustes— y dejo escrito que "avisar"
significa, por ahora, dos escrituras: la marca `floorRaisedAt.<concepto>` en la comunidad
(`functions/src/community-pricing.ts:681`) y una entrada de historial firmada `system:floor`. Lo
decidio sin respuesta del responsable y lo marco como revertible.

**Nadie lee esa marca.** Una busqueda de `floorRaisedAt` en `src/` y `functions/src/` solo encuentra
al que la escribe y al comentario que lo explica. El lider al que le eleven un precio vera que su
cashback de ese concepto pasa a cero y no sabra por que.

Hoy no ha pasado (ninguna comunidad tiene precio propio), y por eso no ha costado nada. Con la spec
006 desplegada los lideres empezaran a fijar precios, y entonces si pasara.

**Objetivo:** que el lider vea, en su pantalla, que un precio suyo fue elevado al piso, cuando, de
cuanto a cuanto y que puede hacer; y que el aviso se cierre cuando el lo atienda o cuando suba el
precio por encima de la nueva base.

## 2. Historias de usuario

- **Como** lider **quiero** saber que Kentro elevo mi precio y por que **para** no creer que la
  plataforma me quito el margen sin motivo.
- **Como** lider **quiero** poder subir el precio desde el mismo aviso **para** recuperar el margen sin
  buscar donde.
- **Como** responsable de la plataforma **quiero** que el aviso salga de la marca que ya se escribe
  **para** no inventar un segundo mecanismo.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (estado):** **Mientras** la comunidad tenga `floorRaisedAt.<concepto>` y el lider no lo
  haya atendido, el sistema MUST mostrarle un aviso por ese concepto con: el concepto, el precio que
  tenia (de la entrada `system:floor` del historial), la base a la que se elevo, la fecha, y que su
  cashback de ese concepto es cero hasta que lo suba (RF_35 de la 001).
- **RF_02 (evento):** **Cuando** el lider atienda el aviso, el sistema MUST registrarlo en el servidor
  mediante callable (por ejemplo `floorRaisedSeenAt.<concepto>`), y MUST NOT borrar la marca ni la
  entrada de historial: el historial no se reescribe (principio 10, y el comentario de
  `communities.ts:918-934`).
- **RF_03 (evento):** **Cuando** el lider suba el precio de ese concepto por encima de la nueva base
  (spec 006), el aviso de ese concepto MUST cerrarse sin que tenga que atenderlo aparte.
- **RF_04 (evento):** **Cuando** la base vuelva a subir sobre un precio ya elevado y atendido, el
  sistema MUST volver a avisar: una marca mas reciente que la ultima atencion es un aviso nuevo.
- **RF_05 (ubicua):** El aviso MUST ofrecer el camino a fijar el precio (spec 006) desde el propio
  aviso.
- **RF_06 (estado):** **Mientras** la cuenta sea acreedora y no gobierne, el sistema MUST NOT mostrar
  el aviso: ya no tiene precio que subir.

## 4. Requisitos no funcionales

- **RNF_01:** Cero descargas nuevas: la marca viaja en el documento de la comunidad que ya se baja;
  el precio anterior sale de la consulta acotada de historial de la 006.
- **RNF_02:** La decision de "hay aviso pendiente" MUST ser una funcion pura probable sin red
  (`floorRaisedAt` vs `floorRaisedSeenAt` vs precio vigente vs base).
- **RNF_03:** Las reglas MUST seguir prohibiendo al cliente escribir en `communities`: la atencion
  del aviso va por callable, como todo lo demas.

## 5. Casos limite

- **Elevacion de dos conceptos a la vez:** dos avisos, uno por concepto, atendibles por separado.
- **Elevacion por la pasada unica de RF_14 de la 004** (guion `raise-community-floors.js`): misma
  marca, mismo aviso; el guion ya la escribe con el mismo writer que el disparador.
- **El lider sube el precio pero por debajo de la nueva base:** el servidor lo rechaza (RF_05 de la
  004); el aviso sigue.
- **Marca escrita antes de existir esta spec:** hoy no hay ninguna (0 comunidades con precio
  propio). Si apareciera, se muestra como aviso nuevo.

## 6. Fuera de alcance

- **Notificar fuera de la app** (correo, WhatsApp). El aviso vive en la pantalla.
- **Avisar a las tiendas** de la subida forzosa: RF_40 de la 001 ya la exime de los ocho dias, y
  "Tu tarifa" ya muestra el cobro real (RF_10 de la 004).
- **Cambiar que se eleva o cuando:** eso es la 004 y no se toca.

## 7. Definition of Done

1. Cada RF con al menos una prueba que pasa; la decision de RNF_02 con su tabla completa.
2. `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` sin errores, build sin `static{`.
3. **Esta spec no se puede probar de punta a punta en produccion**: provocar una elevacion exige
   subir la base en `settings/global`, y eso cambia el cobro de todas las tiendas reales. La
   evidencia funcional del disparador se declara como prueba pura (`planFloorRaise`) mas una
   comunidad desechable a la que se le escribe la marca **a mano con el mismo writer** para ver el
   aviso en pantalla. Hasta que exista la spec 002 (emulador), es lo maximo honesto.
4. Capturas en escritorio y a 390 px del aviso y de su cierre.
5. El humano valido el resultado y aprobo la entrega, y con ello **ratifica o revierte** la decision
   de la 004 sobre que significa "avisar".

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Propuesta del informe de cierre del ciclo 004/005: RF_35 de la 001 escribe la marca desde la 004 y ninguna pantalla la lee; la 004 lo dejo fuera de alcance "sin respuesta del responsable, revertible" |
