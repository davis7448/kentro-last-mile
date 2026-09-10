# Auditoria de trazabilidad — Spec 001: Lider de comunidad

Fecha: 2026-09-10 · Fase `verify`, paso 1 · Rama `feat/pedido-manual-multilinea` · Tarea activa T28

## Recuento

- **59 requisitos** (54 RF + 5 RNF)
- **41 cubiertos**, **10 parciales**, **12 sin cobertura alguna**, **1 medido e incumplido** (RNF_01)

**Huerfanos (cero pruebas):** RF_07, RF_08, RF_10, RF_34, RF_41, RF_42, RF_44, RF_49, RF_53,
RNF_03, RNF_04, RNF_05.

**Parciales:** RF_04 (no prueba que conserve el slug anterior), RF_11 (falta el MUST NOT de no
mover el cashback ya causado), RF_16 (no prueba que conserve el logo anterior), RF_27 (falta el
veto sobre pago a lider logistico/mensajero/costo de producto), RF_28 (falta que se muestre de
inmediato), RF_32 (falta el enlace de invitacion junto a las cifras en cero), RF_35 (falta el
aviso), RF_40 (falta cancelar/rebajar antes de la fecha), RF_46 (solo se prueba el ROTULO; el eje
real vive en `functions/src/community-stats.ts` sin prueba), RF_51 (falta que la deuda sobreviva a
la desactivacion).

## Inconsistencia de estado detectada

`.sdd/state.json` marca `testWritten: true` en T9, T12, T16, T17, T18, T19, T21, T22, T23, T25,
T26 y T27, y varias no tienen ninguna prueba que valide sus requisitos (T16 -> RF_07/RF_08/RF_10;
T17 -> RF_41/RF_42/RF_53; T18 -> RF_44; T25 -> RF_34/RF_53; T26 -> RNF_03; T27 -> RNF_04). T9,
T12, T19, T21, T22 y T23 ni siquiera declaran archivo de prueba.

La tabla "Cobertura: requisito -> tarea" de `specs/001_tasks.md:211` es cierta pero mide
requisito -> **tarea**, no requisito -> **prueba**. No debe leerse como trazabilidad.

## Suite ejecutada

```
Test Files  24 passed (24)
Tests      273 passed (273)
npx tsc --noEmit                 -> 0
cd functions && npx tsc --noEmit -> 0
npm run lint                     -> 0 errores, 3 avisos conocidos
```

Sin herramienta de cobertura configurada; no se estima.

## Veredicto sobre el Definition of Done

| # | Punto | Veredicto |
|---|---|---|
| 1 | Cada RF con prueba rastreable | **NO** — 12 sin prueba, 10 parciales |
| 2 | Cashback atado a la misma fuente, ambos caminos de correccion | **SI** |
| 3 | test + tsc + lint sin errores | **SI** |
| 4 | Carga del lider medida y registrada (RNF_01) | **NO** — medida, y el resultado es que NO se cumple |
| 5 | Evidencia funcional por historia de usuario | **NO** — `.sdd/evidence` no existe |
| 6 | Ninguna cifra de dinero cambia sin comunidad | **SI** |
| 7 | Validacion humana | **NO** — pendiente por construccion |

**DoD INCUMPLIDO.** Cuatro de siete sin cumplir.

## Que sigue: NO se pasa a /sdd-verify

Hay que volver a `/sdd-run` con tareas nuevas, por orden de riesgo:

1. **Alta por enlace (RF_07, RF_08, RF_10)** — `functions/src/community-signup.ts`. Es el corazon
   de la spec y el camino que mas dinero y mas datos personales toca. Sin una sola prueba.
2. **Contencion del enlace filtrado (RF_41, RF_42, RF_53)** — `functions/src/communities.ts:328`
   y `:341`. La spec los declara el UNICO remedio ante un enlace filtrado, con el tope automatico
   descartado a conciencia. Un remedio unico sin prueba es el hueco mas caro de la lista.
3. **RF_49 (marcar pagado el corte del lider) y RF_34 (vista de comunidades del admin).**
4. **RF_44** (tienda sin datos operativos no crea pedidos) — `functions/src/orders.ts:278`.
5. **RNF_03, RNF_04, RNF_05** — RNF_04 tiene callable propia y se prueba en unidad; RNF_03 y
   RNF_05 caen en la evidencia funcional.
6. **Las mitades sueltas de RF_11 y RF_51** — ambas son MUST de dinero.
7. **RF_46 real, no el rotulo** — mezclar ejes de fecha ya desvio cifras en esta plataforma antes.

Aparte del DoD: **RNF_01 sigue incumplido y T28 abierta.** La suscripcion de wallet de
`community_leader` en `src/lib/firebase/state-store.ts` no tiene ventana ni limite. Al arreglarlo,
la trampa de siempre: `getOrdersForContext` y los targets de `subscribeFirestoreState` son dos
sitios y hay que tocar los dos.
