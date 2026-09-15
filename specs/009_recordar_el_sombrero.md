# Spec 009: Recordar que papel eligio la persona entre una visita y otra

- **Estado:** borrador (propuesto por el informe de cierre del ciclo 004/005, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15

## 1. Contexto y objetivo

La 005 dejo escrito (RF_09) que una cuenta con tienda y comunidad abre siempre su tienda, y puso
fuera de alcance recordar la eleccion: "es deseable y es otra spec". Hoy el papel activo vive en
`useState` (`operations-app.tsx:12933`), se vacia al cerrar sesion (`:13172`) y se resuelve con
`defaultHat` en cada arranque (`:13186`). Un lider que revisa su comunidad varias veces al dia tiene
que cambiar de papel cada vez que abre la app.

**Objetivo:** que el navegador recuerde el ultimo papel elegido por esa cuenta y lo abra la proxima
vez, sin que el recuerdo toque permisos ni descargas.

## 2. Historias de usuario

- **Como** tienda que ademas lidera **quiero** que la app abra en el papel que deje la ultima vez
  **para** no cambiar de papel en cada visita.
- **Como** responsable de la plataforma **quiero** que el recuerdo sea solo de interfaz **para** que
  lo que una cuenta puede leer siga decidiendolo el servidor (RNF_02 de la 003 y la 005).

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** la persona cambie de papel con el selector, el sistema MUST recordar
  el papel elegido en ese navegador, asociado al `uid` de la cuenta.
- **RF_02 (evento):** **Cuando** entre una cuenta con papel recordado y ese papel este entre los que
  el nucleo de sombreros le concede hoy (`availableHats`), el sistema MUST abrir ese papel.
- **RF_03 (error):** **Si** el papel recordado ya no esta disponible (por ejemplo, la cuenta perdio
  el vinculo con la comunidad), el sistema MUST abrir el papel de `defaultHat` y MUST olvidar el
  recuerdo, sin error visible.
- **RF_04 (ubicua):** El recuerdo MUST NOT influir en el contexto de descarga ni en ninguna lectura:
  `state-store.ts` sigue sin conocer el sombrero (RNF_03 de la 005, guardas existentes en
  `state-store-targets.test.ts:118-128`).
- **RF_05 (ubicua):** Dos cuentas distintas en el mismo navegador MUST tener recuerdos distintos; el
  recuerdo de una MUST NOT abrir el papel de otra.
- **RF_06 (error):** **Si** el almacenamiento del navegador no esta disponible (modo privado, iOS que
  lo bloquea, cuota llena), el sistema MUST comportarse exactamente como hoy (RF_09 de la 005) y
  MUST NOT mostrar ningun error.
- **RF_07 (evento):** **Cuando** la persona cierre sesion, el sistema MAY conservar el recuerdo para
  esa cuenta; MUST NOT aplicarlo a la cuenta que entre despues (RF_05).

## 4. Requisitos no funcionales

- **RNF_01:** Sin dependencias nuevas; `localStorage` con `try/catch` alrededor de cada lectura y
  escritura. Compatible con iOS 14 (principio 2).
- **RNF_02:** La resolucion "recordado vs disponible vs por defecto" MUST ser una funcion pura junto
  a `session-hats.ts`, probable sin navegador.
- **RNF_03:** Ninguna cuenta con un solo papel cambia de comportamiento: sin selector no hay nada que
  recordar y no se escribe nada.

## 5. Casos limite

- **Se concede el liderazgo con sesion abierta** (caso limite de la 005): al volver a entrar hay dos
  papeles y ningun recuerdo; abre la tienda (RF_09 de la 005).
- **Se retira el liderazgo y queda como acreedora:** el papel de comunidad sigue disponible (RF_11 de
  la 003), asi que el recuerdo se respeta y abre la pantalla de "ya no gobiernas" (RF_12 de la 005).
- **Recuerdo corrupto** (valor que no es un sombrero conocido): cae a RF_03.
- **Misma cuenta en dos dispositivos:** cada navegador recuerda lo suyo; no se sincroniza.

## 6. Fuera de alcance

- **Sincronizar el recuerdo entre dispositivos** (guardarlo en el servidor). Si algun dia se quiere,
  es otra spec y exige decidir si es un dato del usuario o de la sesion.
- **Recordar la seccion dentro del papel** (por ejemplo, que pestana de pedidos).

## 7. Definition of Done

1. Cada RF con al menos una prueba que pasa; la tabla completa de RNF_02 (recordado disponible,
   recordado no disponible, sin recuerdo, recuerdo corrupto, cuenta distinta).
2. Guarda de fuente: `state-store.ts` sigue sin mencionar el sombrero; el `useEffect` de la
   suscripcion sigue sin depender de el (guardas existentes de la 005 en verde).
3. `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` sin errores, build sin `static{`.
4. Evidencia con la cuenta desechable tienda-lider del guion de la 005: cambiar a comunidad, cerrar
   sesion, volver a entrar, comprobar que abre en comunidad; entrar con la cuenta tienda-sin-
   comunidad en el mismo navegador y comprobar que no se ve afectada.
5. Capturas en escritorio y a 390 px.
6. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Propuesta del informe de cierre del ciclo 004/005: la 005 lo dejo fuera de alcance de forma consciente y ahora toca decidir si sigue fuera |
