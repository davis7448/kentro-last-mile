# Spec 027: Que un corte saldado en total cubra todos sus pedidos

- **Estado:** borrador (sin aprobar)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-02
- **Origen:** cuarta pasada de `/sdd-analyze` de la spec 026. Los 24 pedidos de mas de 30 dias que la 026
  iba a mostrar como efectivo perdido estan en cortes donde el lider entrego exactamente lo esperado.
- **Prioridad:** alta — bloquea dinero de tiendas y proveedores que ya entro a Kentro
- **Accesibilidad:** sin interfaz nueva (cambia cifras que ya se muestran)

## 1. Contexto y objetivo

Un corte de domiciliario calcula el efectivo esperado **en agregado**: `max(0, Σ recaudo − Σ pago al
domiciliario)` sobre todos sus pedidos (`computeDriverCashSummary`, `functions/src/settlement-math.ts`). El
pago del domiciliario incluye pedidos que no traen efectivo (por ejemplo, visitas fallidas), asi que lo
esperado es **menor** que la suma de lo que debe cada contraentrega.

Lo recibido, en cambio, se reparte **pedido a pedido** (`cashAllocations`), en orden de creacion, solo
entre los pedidos que deben efectivo. Cuando el lider entrega exactamente lo esperado, lo repartido no
alcanza para los ultimos: los 1-3 pedidos mas nuevos de cada corte quedan con `covered: false`. La regla de
"recibido" (`buildCodReceivedSet`, `functions/src/seller-ledger.ts`, spec 018 RF_04) los da por **no
recibidos** aunque el corte este pagado o conciliado y saldado.

Medido en produccion el 2026-10-02: **29 cortes pagados o conciliados** con `cashReceivedCop ==
cashExpectedCop` y `cashPendingCop` 0 dejan **36 pedidos / $1.151.997** sin cubrir.

Consecuencias, porque la misma regla es la compuerta de pago de la spec 018:

- **Proveedores:** forma parte de los **$1.551.550 de producto de ADMA LABORATORIO** que no se pudieron
  pagar en la liquidacion del 2026-09-30.
- **Tiendas:** el saldo disponible de las tiendas de esos 36 pedidos esta retenido como "efectivo con el
  domiciliario" aunque el efectivo ya entro a Kentro.
- **Alerta de la spec 026:** sin esta correccion, la 026 los tiene que mostrar aparte como "cubiertos por
  compensacion" (su RF_09) para no presentarlos como dinero perdido.

**Objetivo:** que un corte de domiciliario saldado en total deje cubiertos todos los pedidos que contiene,
con una sola regla que sigan usando la liquidacion de tienda, la de proveedor y la alerta de la 026.

## 2. Historias de usuario

- **HU_01 (sin interfaz):** **Como** responsable de la plataforma **quiero** que el producto de un pedido
  cuyo corte ya se saldo se pueda pagar al proveedor **para** no retener dinero que ya entro.
- **HU_02 (sin interfaz):** **Como** tienda **quiero** que mi saldo disponible incluya los pedidos cuyo
  efectivo ya entrego el lider **para** cobrar lo que me corresponde.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (estado):** **Mientras** un corte de domiciliario este pagado o conciliado con su efectivo total
  saldado (pendiente 0 y recibido igual o mayor que lo esperado), el sistema MUST dar por recibidos todos
  los pedidos que contiene, tengan o no una asignacion cubierta.
- **RF_02 (ubicua):** La regla MUST seguir siendo una sola funcion, usada por la liquidacion de tienda, la
  de proveedor, el saldo de tienda (spec 018) y la alerta de efectivo (spec 026).
- **RF_03 (ubicua):** Un corte pagado o conciliado **con** faltante real MUST seguir dejando sin cubrir
  los pedidos que la asignacion no cubre.
- **RF_04 (evento):** **Cuando** la regla cambie, el sistema MUST permitir saber, antes de desplegar, que
  pedidos pasan a recibidos y cuanto dinero de tiendas y proveedores se libera.
- **RF_05 (ubicua):** Tras el cambio, los pedidos que la spec 026 mostraba como "cubiertos por
  compensacion" MUST dejar de aparecer en su lista; el estado puede quedar sin uso.

## 4. Requisitos no funcionales

- **RNF_01 (coherencia):** La posicion de la plataforma ("por cobrar al domiciliario") MUST NOT cambiar por
  esta correccion: solo cambia que pedido se considera recibido, no cuanto efectivo hay.
- **RNF_02 (seguridad del dinero):** Ningun corte ya pagado o conciliado MUST reescribirse; la correccion
  es de lectura de la regla, no de los documentos.

## 5. Casos limite

- **Corte con excedente** (recibido mayor que lo esperado): tambien saldado.
- **Corte creado sin `cashPendingCop`:** decidir si cuenta como saldado (la posicion lo trata como 0).
- **Pedido en dos cortes**, uno saldado y otro no: decidir cual manda.
- **Corte pendiente con pendiente 0** (variante que la spec 018 elimino a proposito): MUST NOT volver a
  aceptarse; solo cortes pagados o conciliados.

## 6. Fuera de alcance

- Cambiar como se calcula lo esperado de un corte o como se reparten las asignaciones al registrarlas.
- Corregir cortes historicos.
- Pagar automaticamente a tiendas o proveedores lo liberado.

## 7. Definition of Done

1. Una prueba demuestra RF_01 y RF_03 con los dos casos (saldado y con faltante real).
2. La guarda de la spec 026 (la regla no se copia) sigue en verde.
3. Contra produccion, los 36 pedidos de los 29 cortes del 2026-10-02 (o su estado actualizado) pasan a
   recibidos, y se informa cuanto se libera por tienda y por proveedor (incluida ADMA LABORATORIO).
4. La posicion de la plataforma no cambia (RNF_01).
5. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
6. El responsable de la plataforma firma la entrega.

## 8. Preguntas abiertas

- ¿Un corte sin `cashPendingCop` y con recibido igual a lo esperado cuenta como saldado?
- ¿Se libera lo retenido en el siguiente corte de tienda/proveedor sin mas, o con un aviso al admin?

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-02 | Borrador inicial | Cuarta pasada de `/sdd-analyze` de la 026: 29 cortes saldados dejan 36 pedidos / $1.151.997 sin cubrir; parte de los $1.551.550 de producto de LAB no pagable y de saldos de tienda retenidos |
