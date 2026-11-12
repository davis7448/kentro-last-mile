# Spec 038 T28 — medicion otra vez (solo lectura), 2026-11-12

Salidas: `t28-medicion.txt`, `t28-foto-en-seco.txt`, `t28-compensacion-previsualizada.txt`.

## Cifras frente a las de T19-T26

| Cifra | Antes (2026-11-09/10) | Hoy (2026-11-12) |
|---|---|---|
| Diferencia historica driver-1778271901513 | 686.202 / suma por pedido 686.200 | igual |
| Cortes sin cuadrar | 0 | 0 (63 cortes, `--check` en verde) |
| Retenciones de la foto | 16 · $686.200 | igual |
| Compensacion opcion A | $632.200 (+ $54.000 excluidos) | igual |
| `--deploy-check`, esperado | diferencia 0 | diferencia 0 (pendiente 3.545.070 -> 3.545.070; siguiente 3.464.210 -> 3.464.210) |
| `--deploy-check`, recibidos | 1 deja de estarlo (KNT-007828) | 0 |
| Huella de la compensacion | fd1c3b81 | 743cbbb8 |

Los cortes y pedidos crecen (59 -> 61 cortes, 4821 -> 4998 pedidos) por la operacion normal.

## Lo que cambio, pedido a pedido

- **KNT-007828 ya no cambia de "recibido".** Estaba en el corte `stl-1794233484852-driver-driver-1778271901513`,
  pendiente el 2026-11-10 y **conciliado ese mismo dia** (18:27 UTC, 6.033.440 recibido = esperado). Con el
  corte saldado, la regla de hoy y la nueva dan lo mismo. La decision del responsable sobre ese pedido ya no hace
  falta. Es un pedido fallido (`failed_visit`), sin efecto en dinero, como ya se habia visto.
- **Su retencion entra ahora por el siguiente corte** (`next`) y no por aquel corte pendiente: un corte
  conciliado no se reescribe (RF_04), se compensa en el periodo abierto. Mismo importe ($81.900).
- **La huella cambia** porque recoge la via de entrada de cada fila (la de KNT-007828) y el texto del motivo de
  exclusion (hoy "por aclarar"). El importe y las filas son los mismos. La huella vale solo para la
  previsualizacion del dia en que se apruebe: antes de `--apply` hay que volver a previsualizar.
