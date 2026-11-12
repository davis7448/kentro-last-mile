# Spec 039: Buscador en «Recogidos pendientes de mensajero»

- **Estado:** aprobada
- **Aprobada por:** el dueño, 2026-11-12 («Aprobar spec 039»), con las propuestas de P1 (toda la recogida,
  con el numero en el boton) y P2 (si, «Seleccionar los que coinciden»).
- **Autor:** Claude, 2026-11-12
- **Origen:** mensaje de WhatsApp de un lider de mensajeros, reenviado por el dueño el 2026-11-12:
  «los knt salen en desorden y toca ponerse a buscar pagina por pagina, 1 x 1… se pierde demasiado
  tiempo». Dice que lo pidio hace tiempo.

## 1. Contexto y objetivo

La tarjeta «Recogidos pendientes de mensajero» (`AssignPickedUpOrdersPanel`,
`src/components/operations-app.tsx`) la usa el lider logistico para pasar a un mensajero los pedidos
que ya recogio. Hoy:

- La lista sale **en el orden en que llegan del estado** (no por numero KNT).
- Pagina de 8 en 8 y **no tiene buscador**: para encontrar un KNT hay que recorrer las paginas.
- La seleccion (`selectedIds`) ya vive fuera de la pagina, pero no hay forma de ver cuantos pedidos
  van marcados ni si alguno queda fuera de lo visible.

Los pedidos de esta tarjeta **ya estan en memoria**: son los activos de la flota (`pendingMessenger`),
que la carga baja enteros (ver `CLAUDE.md`, ventana de pedidos). Por eso todo se resuelve en el
cliente, sobre lo cargado: **cero lecturas nuevas a Firestore, ninguna consulta, ningun indice,
ningun cambio en functions** (y nada de `minInstances`).

**Objetivo:** que el lider encuentre un pedido escribiendo parte de su KNT, del cliente o de la tienda,
con la lista ordenada por KNT, sin perder lo que ya marco.

## 2. Requisitos (EARS)

- **RF_01** — La tarjeta mostrara un campo «Buscar» (KNT, cliente o tienda) encima de la lista.
- **RF_02** — Cuando el lider escriba en «Buscar», la lista mostrara solo los pedidos cuyo KNT,
  numero de Shopify, nombre del cliente, punto de recogida o nombre de la tienda contengan el texto,
  sin distinguir mayusculas ni tildes, buscando en **toda** la lista y no solo en la pagina visible.
- **RF_03** — Cuando el texto sea solo cifras (p. ej. `8465`), tambien encontrara el KNT aunque se
  escriba sin el prefijo `KNT-` ni los ceros a la izquierda.
- **RF_04** — La lista se ordenara por numero KNT ascendente (`KNT-008384` antes que `KNT-008465`);
  los pedidos sin KNT iran al final, ordenados por numero de Shopify.
- **RF_05** — Cuando cambie el texto de busqueda, la lista volvera a la primera pagina.
- **RF_06** — La seleccion marcada se mantendra al buscar, al borrar la busqueda y al cambiar de
  pagina. «Asignar seleccionados» asignara **todos** los marcados, esten o no visibles.
- **RF_07** — La tarjeta dira cuantos pedidos van seleccionados y, si alguno queda oculto por la
  busqueda, cuantos; y ofrecera «Quitar seleccion».
- **RF_08** — Si la busqueda no encuentra nada, la tarjeta lo dira («Ningun pedido coincide con …»)
  en lugar del mensaje de lista vacia.
- **RF_10** — Cuando haya una busqueda escrita, la tarjeta ofrecera «Seleccionar los N que coinciden»,
  que añade a la seleccion todos los resultados de la busqueda (no solo la pagina visible).
- **RF_09** — «Asignar toda la recogida» sigue asignando **toda** la recogida pendiente, no solo lo
  filtrado, y el boton muestra cuantos son (ver P1).
- **RNF_01** — La busqueda y el orden viven en un modulo puro (`src/lib/pending-pickup-search.ts`)
  con pruebas en `src/lib/pending-pickup-search.test.ts`.
- **RNF_02** — Sin lecturas nuevas a Firestore, sin cambios en reglas, indices ni functions. Solo
  hosting.
- **RNF_03** — Se ve bien a 375 px y 1280 px, con los tokens de `docs/design-system.md`. Evidencia:
  captura movil y escritorio.

## 3. Fuera de alcance

- La tarjeta «Asignados a mensajero» (misma forma, mismo problema). Si el dueño lo quiere, se aplica
  igual en una enmienda; no se incluye para no ampliar sin permiso.
- Cambiar el tamaño de pagina.

## 4. Preguntas al dueño

- **P1.** Con una busqueda escrita, ¿«Asignar toda la recogida» debe asignar **toda** la recogida (lo
  que hace hoy, propuesto) o **solo lo filtrado**? Propuesta: toda, y el boton dice el numero para que
  no haya sorpresa; para asignar solo lo filtrado esta «Seleccionar los N visibles» (ver P2).
- **P2.** ¿Añadimos «Seleccionar todos los que coinciden» (marca de golpe el resultado de la
  busqueda, p. ej. todos los de una tienda)? Propuesta: si, es lo que ahorra mas clics.

## 5. Plan corto

1. `pending-pickup-search.ts`: `sortPendingPickup(orders)` y `filterPendingPickup(orders, query,
   sellerNameById)`, con pruebas (orden, cifras sin prefijo, tildes, tienda, sin KNT).
2. `AssignPickedUpOrdersPanel`: campo «Buscar», lista ordenada y filtrada, contador de seleccion,
   «Quitar seleccion», mensaje sin resultados; recibe `sellers` para buscar por tienda.
3. `npx tsc --noEmit`, `npx vitest run`, `npm run lint`; capturas a 375 y 1280.
4. PR. El despliegue (solo hosting) lo decide el dueño.

## 6. Verificacion (2026-11-12)

- Pruebas: `src/lib/pending-pickup-search.test.ts` (13) y `src/lib/spec-039-guards.test.ts` (8); suite
  completa 73 archivos en verde. `npx tsc --noEmit` limpio; `npm run lint` sin errores (los 3 avisos de
  siempre).
- Interfaz en modo local con datos inventados (`e2e/shots-039-local.cjs`), a 375 y 1280 px, sin errores
  de pagina. Evidencia en `.sdd/evidence/039_buscador_en_recogidos_pendientes/`:
  1. orden por KNT (`KNT-008384`, `-008386`, `-008388`…);
  2. un pedido marcado y busqueda «garcia»: se ve `KNT-008465` y «1 fuera de esta busqueda»;
  3. busqueda «kovia» + «Seleccionar los 5 que coinciden»: «Asignar seleccionados (6)»;
  4. busqueda sin resultados;
  5. tras asignar: salen los 6 marcados aunque la busqueda no mostrara ninguno, quedan 16.
- No probado contra produccion: no se ha desplegado. El despliegue es solo hosting y lo decide el dueño.
