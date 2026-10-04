# Spec 032: la auditoria solo la escribe el servidor

- **Estado:** borrador
- **Autor:** Claude (planner de la 029, por decision del responsable delegada en el orquestador)
- **Fecha:** 2026-10-04
- **Origen:** plan de la spec 029 (P3). `firestore.rules` permite `create` en `auditEvents` a cualquier sesion
  (`allow create: if signedIn();`). Con la 029, la tienda ve el "Historial del pedido" etiquetado como
  "Kentro", "Tu tienda" o "API": un evento fabricado por un cliente sobre un pedido ajeno apareceria ahi con
  apariencia de oficial.
- **Prioridad:** alta. Va inmediatamente despues de la 029, que aplica una mitigacion temporal (plan 029, 2.7).
- **Accesibilidad:** sin interfaz.

## 1. Contexto y objetivo

`auditEvents` es el rastro de quien hizo que. Las callables lo escriben con el Admin SDK (que ignora las
reglas), pero la regla deja ademas que cualquier usuario con sesion cree documentos directamente. Nadie lo ha
explotado que se sepa, pero:

- un usuario de una tienda puede crear un evento con el `entityId` de un pedido de otra tienda;
- `getOrderAuditTrail` lo devolveria en el historial de ese pedido;
- la 029 solo lo mitiga (eventos verificables por `orderHistory` o de accion permitida), sin cerrarlo.

**Objetivo:** que solo el servidor pueda escribir `auditEvents`, sin perder ningun evento que hoy escriba el
cliente legitimamente.

## 2. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** Las reglas de Firestore MUST NOT permitir `create`, `update` ni `delete` en
  `auditEvents` a ninguna sesion de cliente.
- **RF_02 (ubicua):** Antes de cerrar la regla, el sistema MUST tener un inventario comprobado de todo codigo
  de cliente (`src/`) que escriba en `auditEvents`, incluidas escrituras indirectas (batches, helpers de
  `state-store.ts`), y de cuantos eventos por accion creo el cliente en los ultimos 90 dias en produccion.
- **RF_03 (evento):** **Cuando** el inventario encuentre una escritura de cliente legitima, el sistema MUST
  moverla a una callable que audite en servidor, con el mismo `action` y los mismos campos, antes de cerrar la
  regla.
- **RF_04 (ubicua):** Una guarda de fuente MUST fallar si algun archivo de `src/` escribe en `auditEvents`.
- **RF_05 (ubicua):** Los eventos ya existentes MUST NOT modificarse ni borrarse.
- **RF_06 (evento):** **Cuando** esta spec este desplegada, la mitigacion temporal de la 029 (2.7: solo
  eventos verificables o de accion permitida para la tienda) MAY retirarse, decidiendolo en esta spec con
  prueba de que ya no hay eventos de cliente posteriores al cierre.

## 3. Requisitos no funcionales

- **RNF_01 (despliegue):** El cierre de la regla se despliega despues de las callables que sustituyan a las
  escrituras de cliente, nunca antes: un cliente con el bundle viejo en cache no debe perder la accion, solo su
  evento (y eso se mide).

## 4. Casos limite

- Navegador con el bundle anterior en cache que intenta crear un evento tras el cierre: la escritura falla con
  `permission-denied`; el plan debe comprobar que ese fallo no tumba la accion principal del usuario.
- Eventos de cliente historicos: se quedan; si alguno resulta fabricado, se documenta, no se borra (RF_05).

## 5. Fuera de alcance

- Reescribir `summary` historicos.
- Cambiar quien puede leer `auditEvents` (sigue `isAdmin()`).

## 6. Definition of Done (borrador)

1. Inventario (RF_02) con evidencia de codigo y de produccion.
2. Pruebas: guarda de fuente (RF_04) y guarda de reglas (`allow create, update, delete: if false`).
3. Comprobacion con sesion real de `seller`: crear un `auditEvents` directo devuelve 403.
4. `npm test`, `npx tsc --noEmit` (raiz y `functions/`), `npm run lint` en verde.
5. Firma del responsable.

## 7. Preguntas abiertas

- ¿Hay escrituras de cliente legitimas hoy? La busqueda rapida de la 029 solo encontro lecturas en
  `src/lib/firebase/state-store.ts`; el inventario de RF_02 lo confirma o lo desmiente.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-04 | Borrador inicial | P3 del plan de la 029, decidida como spec aparte de prioridad alta |
