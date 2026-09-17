# DoD 4 — verificacion contra produccion

**Fecha:** 2026-09-17 · **Dia reimportado:** 2026-09-15 (el del incidente) · **Tienda:** DANDA (`u0jxrm-tk.myshopify.com`)

## Procedimiento seguido

1. Copia previa de los 69 pedidos del dia (`--backup`), obligatoria porque el PITR de Firestore
   esta desactivado. Se guarda fuera del repo: lleva nombres y telefonos de clientes reales.
2. Reimportacion real del 15 al 15 desde la app, con el codigo nuevo ya desplegado (las vias se
   actualizaron a las 16:54 UTC).
3. Comparacion campo a campo de los grupos protegidos (`--compare`).

## Resumen de la corrida (`importRuns/run-1789666146703-shopify_historical_sync`)

| | |
|---|---|
| Pedidos vistos | 39 |
| Creados | **0** |
| Ya existian | **39** |
| Duracion | 7 s (17:29:06 -> 17:29:13 UTC) |
| Lista de afectados recortada | no (38 codigos, tope 500) |

Datos protegidos conservados, por grupo:

| Grupo | Pedidos |
|---|---|
| `customer` (cliente y direccion) | 38 |
| `address_review` (veredicto de direccion) | 35 |
| `provenance` (por donde entro) | 29 |
| **`ownership` (lider, mensajero, lote)** | **24** |
| `frozen_catalog` (productos congelados) | 1 |

## Resultado

```
OK: ninguno de los 69 pedidos de 2026-09-15 cambio un dato protegido.
```

## Lo que esto demuestra

Es la misma corrida que el 2026-09-15 dejo 34 pedidos sin lider. Con el codigo nuevo, **24 pedidos
conservaron su lider** en vez de perderlo, y ni uno de los 69 movio un dato protegido. El numero de
`ownership` es exactamente la medida del dano que se habria repetido: 24 pedidos que el codigo viejo
habria dejado sin dueno, con su efectivo saliendo del saldo del lider sin ningun error.

El resumen de corrida, que antes no existia, es ademas la primera vez que una reimportacion deja
constancia de lo que toco.
