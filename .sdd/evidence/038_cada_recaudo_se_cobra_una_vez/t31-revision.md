# Spec 038 T31 — medicion y revision independiente de T29-T33 (2026-11-12)

## Medicion (solo lectura)
`t31-medicion.txt`, `t31-foto-en-seco.txt`, `t31-compensacion-previsualizada.txt` y, tras T32 y T33,
`t32-deploy-check.txt` y `t33-deploy-check.txt`. Iguales que en T28: diferencia 686.202 / 686.200, 0 cortes sin
cuadrar, foto 16 retenciones · $686.200, compensacion opcion A $632.200 (+ $54.000 excluidos, huella 743cbbb8),
`--deploy-check` diferencia 0 y ningun recibido cambia. `t30-verify-018-compare.txt`: el saldo acotado coincide al
peso con las colecciones enteras en las cinco tiendas.

## Revision (tres pasadas del mismo revisor, en contexto limpio respecto al codigo)
1. **T29-T30:** R1 cerrado, R2 cerrado en el servidor. Encontro **N1 (bloqueante)**: el corte de la visita fallida
   de D1, calculado despues del corte saldado de D2, bloqueaba para siempre (`codSeenCop` 0 por RF_01b). -> T32.
2. **T32:** N1 cerrado. Encontro **M1 (bloqueante)**: con la entrega pasada de D2 a D1 y la devolucion a D2
   saldada, el corte viejo de D2 daba el pedido por recibido antes de que D1 entregara nada. -> T33 (no con el
   arreglo sugerido, que bloqueaba para siempre en el orden inverso).
3. **T33: nada bloqueante.** Probo cadenas D1->D2->D1, cortes pendientes marcados, B5, R1, N1 y M1
   (`t31-repro-reasignaciones.js`, `t32-repro-n1.js`, `t33-repro-m1.js`, `t28-repro-h2b.js`). Ningun bloqueo sin
   salida: si el corte mas reciente de quien entrega esta marcado, al volver a el `pendingDeltaOrders` le cobra el
   recaudo y abre un corte sin marca.

## Menores abiertos
- **M2 — ventana de recibido en una reasignacion** (reproducido). Tras pasar la entrega de un domiciliario a otro,
  y antes de que exista el corte que le devuelve a quien entrego antes, el pedido cuenta como recibido (su efectivo
  sigue en caja). Si la tienda aun no habia cobrado, se le puede pagar en esa ventana y la plataforma adelanta el
  dinero hasta que el nuevo domiciliario pague. **Pendiente del responsable: aceptarlo o cerrarlo** (cerrarlo exige
  que la regla de recibido sepa de devoluciones aun sin corte, es decir, leer los pagos del domiciliario desde la
  tienda y la API: lo que el responsable descarto el 2026-11-08 en RF_11).
- M3 — empate total de fechas entre dos cortes del mismo domiciliario: teorico (cada pago es una transaccion).
- N2/N3 — vistas parciales: un pedido ausente de la vista no se completa (siempre estricto); un recaudo cortado con
  reversa abierta y monto nuevo podria dar recibido en la vista sin cortar, pero hoy el planificador lo impide
  (`entry_id_collision`).
- N5 / limite conocido — el cliente decide recibido con `state.wallet` recortada: solo pantalla.
- R4, R5 de T28 — informe 026 en vista de lider; lecturas de `driverId` dentro de la transaccion de `createSettlement`.
