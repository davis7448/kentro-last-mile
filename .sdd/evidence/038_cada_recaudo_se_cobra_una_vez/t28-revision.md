# Spec 038 T28 — revision independiente de T24-T27 (2026-11-12)

Veredicto: **no lista para desplegar.** H1 y H3 cerrados; T27 correcto; H2 sigue abierto en la via real.

## Bloqueante

**R1 — H2 sigue abierto cuando la correccion BORRA y RECREA el recaudo** (reproducido: `t28-repro-h2b.js`).
`order-corrections-plan.ts`: si el `cod_revenue` de la tienda no esta cortado, entregado->fallido lo borra (no
hay reversa) y fallido->entregado lo recrea con `createdAt` nuevo. Tras el corte saldado del domiciliario solo
queda +100.000, que no suma cero: `buildCodReceivedSet` da "no recibido" para siempre, y `pendingDeltaOrders`
da `[]` (el pedido no vuelve a ningun corte). Antes de la 038 salia recibido: regresion. La prueba de T26 usa
una reversa que la herramienta de correccion solo produce cuando la tienda ya cobro.

Salida de la reproduccion:
```
pendingDeltaOrders D1: []
recibido o: false
recibido (con reversa): true
cambio de tienda, todos los asientos (createSettlement): true
cambio de tienda, solo asientos de B (store-api/saldo): false
```

## Menores

- **R2 — la suma cero depende de que asientos lea cada llamador (RF_12).** `createSettlement` pasa el recaudo
  de todas las tiendas; `store-api.ts:291` y `seller-balance-api.ts:27,52`, solo los de la tienda. En un cambio
  de tienda A->B, la creacion de corte dice recibido y la tienda B no. Siempre hacia lo estricto.
- **R3 — recibido antes de tiempo** si D1 entrega y se salda, se corrige y entrega D2 sin corte aun: lo
  posterior suma cero mezclando asientos de dos domiciliarios. No se vio dinero moverse (razonado).
- **R4 — informe 026 en vista de lider:** `deliveredByOf` solo ve los pedidos del lider; un pedido entregado
  por D2 dentro de un corte de D1 cuenta como hasta hoy. Solo la cifra del informe.
- **R5 — `loadDeliveredBy` lee ~4.840 pedidos dentro de la transaccion de `createSettlement`:** contencion y
  reintentos posibles. Operativo, no de dinero.

## Verificado sin defecto

H1 (todos los llamadores pasan `deliveredBy`; dato ausente nunca reembolsa), H3 (`uncoveredInOpenOldCorte` no
bloquea a quien no lo estuviera ya), T27 (`refreshFrozenReceipts` solo reordena; RF_04 intacto) y
`writeSnapshots` (un lote, `create`, atomico).
