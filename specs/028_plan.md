# Plan 028: abrir la app no escribe nada

Spec: `specs/028_abrir_la_app_no_escribe_nada.md` (aprobada el 2026-11-10).

## Decision

El autoguardado del admin se queda. Solo deja de escribir lo que nadie pidio. Hay tres cortes, cada uno con
su prueba.

1. **Que se guarda lo decide una funcion pura**, `planAutosave(baseline, state)` en `src/lib/autosave-plan.ts`
   (RNF_01):
   - sin linea base devuelve **nada** (RF_01, RF_03, RF_07, RF_08);
   - `settings` se compara **campo a campo**, sin `updatedAt`, y devuelve solo los campos cambiados (RF_04,
     RF_05);
   - en cada coleccion compara **entidad a entidad** por id y referencia, y devuelve solo las que cambiaron
     (RF_06).

   Con el ultimo punto, editar una zona ya no reescribe las otras con lo que el navegador tenia en memoria:
   es el riesgo que quedo abierto al pasar las zonas a 8.000.
2. **`saveFirestoreState` usa ese plan.** Sin linea base sale sin escribir. La linea base se vacia al empezar
   cada suscripcion (`resetRemoteBaseline`), asi que una sesion nueva nunca guarda contra la de la sesion
   anterior (RF_08).
3. **`useAppState`:**
   - al pasar a modo remoto, `hydrated` vuelve a `false` hasta la primera emision del servidor, y el estado
     del modo local deja de contar (RF_01);
   - `onEmpty` ya no llama a `saveFirestoreState` (RF_03, RF_07).

## Archivos

- `src/lib/autosave-plan.ts` y `src/lib/autosave-plan.test.ts` (nuevos).
- `src/lib/firebase/state-store.ts`: `saveFirestoreState`, `resetRemoteBaseline` y la llamada en
  `subscribeFirestoreState`.
- `src/components/operations-app.tsx`: `useAppState`.
- `src/lib/spec-028-guards.test.ts` (nuevo): guardas de fuente de los cortes 2 y 3.

## Verificacion

- `npx vitest run`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint`.
- `e2e/verify-028-writes.mjs` contra produccion despues de desplegar el hosting (RNF_02). Antes, contra la
  version local.
- Solo hosting: no cambian callables, reglas ni indices.
