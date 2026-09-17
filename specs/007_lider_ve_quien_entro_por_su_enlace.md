# Spec 007: El lider ve quien entro por su enlace y cuando

- **Estado:** borrador (propuesto por el informe de cierre del ciclo 004/005, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15

## 1. Contexto y objetivo

El lider reparte un enlace de registro (RF_32 de la 001). Cuando una tienda entra por el, el alta
escribe en su documento `communityId`, `communityJoinedAt` y `communitySignupSlug`
(`functions/src/community-signup-doc.ts:69-70`). Desde la 005 el lider baja las tiendas de su
comunidad (`sellers where communityId ==`) y, desde T16, las ve listadas aunque no hayan movido
pedidos. Pero la lista dice solo el nombre y sus cifras del periodo: **no dice cuando entro cada
tienda ni si entro por el enlace**, aunque el dato ya esta en el navegador.

Para un lider que acaba de repartir su enlace la pregunta del dia es "¿ya entro alguien?". Hoy la
responde contando filas.

**Objetivo:** que el lider vea, sin descargar nada nuevo, cuando entro cada tienda a su comunidad y
cuales llegaron por su enlace; y que la lista deje ver de un vistazo las que entraron en la ultima
semana.

## 2. Historias de usuario

- **Como** lider de comunidad **quiero** ver cuando entro cada tienda **para** saber si mi enlace
  esta funcionando.
- **Como** lider **quiero** distinguir las que entraron por mi enlace de las que me asigno el
  administrador **para** medir lo que consigo yo.
- **Como** responsable de la plataforma **quiero** que esto no ensene ni un dato mas de cada tienda
  **para** respetar lo que la 003 le veda al lider (RF_09).

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (estado):** **Mientras** el lider tenga activo su papel de comunidad, el sistema MUST
  mostrarle la lista de tiendas de su comunidad con, por cada una, el nombre y la fecha de entrada
  (`communityJoinedAt`), ordenada de la mas reciente a la mas antigua.
- **RF_02 (estado):** **Mientras** una tienda tenga `communitySignupSlug`, el sistema MUST marcarla
  como entrada por el enlace; **mientras** no lo tenga, MUST mostrarla sin esa marca, no con una
  marca inventada.
- **RF_03 (error):** **Si** una tienda no tiene `communityJoinedAt` (asignada por el administrador
  antes de que existiera el campo), el sistema MUST mostrar "fecha no registrada", y MUST NOT
  inventar una fecha ni usar `createdAt` de la tienda como si fuera la de entrada.
- **RF_04 (ubicua):** La lista MUST mostrar cuantas tiendas entraron en los ultimos siete dias, con
  la misma regla de semana que el resto de la plataforma (`src/lib/date-ranges.ts`).
- **RF_05 (ubicua):** La lista MUST NOT mostrar telefono, correo, direccion, saldos ni pedidos de
  ninguna tienda (RF_09 de la 003). Nombre, fecha de entrada y origen; nada mas.
- **RF_06 (estado):** **Mientras** la cuenta ya no gobierne la comunidad (acreedora), el sistema MUST
  NOT mostrar la lista, porque el servidor le niega las tiendas por diseno (RF_12 de la 005).
- **RF_07 (evento):** **Cuando** entre una tienda nueva mientras el lider tiene la pantalla abierta,
  el sistema MAY reflejarla en vivo si la suscripcion ya lo permite; MUST reflejarla, como tarde, al
  volver a entrar.

## 4. Requisitos no funcionales

- **RNF_01:** Cero documentos nuevos: todo sale de los `sellers` que la 005 ya baja para el lider.
  Se comprueba con la misma tabla de objetivos de descarga de `state-store-targets.test.ts`.
- **RNF_02:** Sistema de diseno vigente; cabe en 390 px; iOS 14.
- **RNF_03:** Ninguna cuenta sin sombrero de comunidad cambia de comportamiento.

## 5. Casos limite

- **Comunidad sin tiendas:** se mantiene RF_11 de la 005 ("todavia no tiene tiendas"), sin la lista.
- **La tienda del propio lider esta en su comunidad:** aparece una vez, con su fecha, como cualquier
  otra (caso limite de la 005).
- **Una tienda reasignada por el administrador a esta comunidad** (`reassignSellerCommunity`): si el
  plan de reasignacion no escribe `communityJoinedAt`, cae en RF_03. Decidir en el plan si la
  reasignacion debe empezar a escribirlo (probablemente si, con `communitySignupSlug` ausente).
- **Fecha en el futuro por reloj mal puesto:** se muestra tal cual; no se corrige en cliente.

## 6. Fuera de alcance

- **Alertas de captacion masiva y cierre de accesos** (RF_41 y RF_42 de la 001): ya existen y son del
  administrador.
- **Exportar la lista.**
- **Notificar al lider fuera de la app cuando entra una tienda.**

## 7. Definition of Done

1. Cada RF con al menos una prueba que pasa. El orden, la marca de origen, la regla de "fecha no
   registrada" y el contador semanal se prueban como funcion pura en `src/lib/community-view.ts`.
2. Guarda de fuente: la fila no lee mas campos de la tienda que `id`, `name`, `communityJoinedAt` y
   `communitySignupSlug`.
3. `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` sin errores, build sin `static{`.
4. Evidencia con comunidad y tiendas desechables: una entrada por el enlace real de registro
   (`/registro/{slug}` de prueba) y una asignada por el administrador; la lista las distingue.
   Limpieza repetible.
5. Capturas en escritorio y a 390 px, con la pantalla ya cargada.
6. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Propuesta del informe de cierre del ciclo 004/005: T16 de la 005 mostro que el lider ya baja sus tiendas y que la pregunta "¿ya entro alguien por mi enlace?" sigue sin respuesta en pantalla |
