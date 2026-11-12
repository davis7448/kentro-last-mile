# Spec 038 — auditoria (2026-11-12)

Rama `claude/strange-cohen-839664`, con `origin/main` unido (specs 023, 028, 037 y 039). Un unico conflicto
textual, en `.sdd/state.json` (se queda el ciclo activo de la 038). Tras unir: tsc raiz y `functions/` limpios,
`npx vitest run` 83 archivos / 3864 pruebas en verde, lint 0 errores (3 avisos de siempre). La guarda T23 de la 038
cazo un archivo nuevo de la 023 que mezcla recaudo y pago del domiciliario (`platform-position-sums.ts`): es
posicion de plataforma, gemela de `driver-receivable.ts`, y entra en la lista blanca con su motivo.

## Definition of Done (spec §7)

| # | Punto | Estado |
|---|---|---|
| 1 | Todo RF con prueba automatizada; propiedad de RNF_02 y casos reales de RNF_03 | Cumplido (tabla de cobertura de `specs/038_tasks.md`; T1-T33) |
| 2 | tsc, vitest y lint sin errores nuevos; guardas 018, 026 y 027 en verde | Cumplido, tambien tras unir `main` |
| 3 | Medicion de RNF_01 contra produccion, aprobada por el responsable antes de desplegar functions | Medida (`audit-deploy-check-tras-main.txt`: diferencia 0, ningun recibido cambia). **Aprobada por el responsable el 2026-11-12.** |
| 4 | Previsualizacion de compensacion de `driver-1778271901513` con la regla desplegada = tabla de §1 | Previsualizada sin desplegar: $632.200 + $54.000 excluidos (huella 743cbbb8). **Repetir tras desplegar** |
| 5 | El humano valida y aprueba la entrega; ningun agente despliega ni escribe dinero | **Pendiente**. Nada desplegado, nada escrito |

## Decisiones del responsable

- 2026-11-12: segunda enmienda de RF_11 (recaudo neto = el que vio el ultimo corte saldado) — aprobada.
- 2026-11-12: medicion de RNF_01 aprobada por el responsable; PR #15 unido a main. Sin desplegar.
- 2026-11-12: M2 (ventana de recibido en una reasignacion con la tienda sin cobrar) — aceptado.
- KNT-007828: ya no hace falta (su corte se concilio el 2026-11-10; ver `t28-explicacion.md`).
- **Pendientes:** escribir la foto (`--write --approved-by ... --expect-total 686200 --expect-orders 16`);
  KNT-005724 y KNT-006347 (efectivo o prepago); aplicar la compensacion (opcion A) tras desplegar.

## Orden de despliegue (cuando se apruebe)

1. Reglas (`driverLedgerBaselines` y `driverCashHolds`: lectura solo admin, escritura de nadie).
2. La foto: `node scripts/snapshot-038-baseline.js --write ...` con las cifras de la medicion de ESE dia.
3. Functions (sin indices nuevos: las consultas nuevas son de un campo). `cd functions && npm run build`;
   comparar `firebase functions:list` con el set local; `ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions`.
4. Hosting (`npm run deploy:hosting`).
5. Previsualizar otra vez la compensacion (DoD 4) y, con aprobacion, `--apply` con la huella del dia.

## Pendientes fuera de alcance (anotados)

- La previsualizacion del admin antes de cerrar (`buildLiquidationOrderAudits`) sigue con la estimacion vieja.
- `driverCompensations` no tiene regla propia (la niega el comodin).
- El cliente decide "recibido" con la wallet recortada (solo pantalla; el servidor completa).
- Menores de las revisiones: R4, R5 (T28); N2, N3, M3 (T31).
