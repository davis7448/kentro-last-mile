# Matriz de QA Kentro

Fecha base: 2026-05-15
Ambiente: https://kentro-last-mile.web.app
Firebase project: `kentro-last-mile`

## Criterio de Salida

El MVP queda listo para avanzar a Shopify cuando todos los casos `P0` y `P1` esten en `OK`, sin errores 4xx/5xx inesperados en consola, y con wallets/inventario consistentes despues de completar pedidos.

Estados:

- `Pendiente`: no probado.
- `OK`: probado y funciona.
- `Falla`: probado y falla.
- `Bloqueado`: no se pudo probar por datos, permisos o dependencia externa.

## Usuarios y Datos Minimos

Antes de probar, confirmar que existen:

- 1 admin activo.
- 1 vendedor activo con ciudad Cali.
- 1 transportista activo.
- 1 zona activa con tarifas completas.
- 1 producto de inventario con `Stock fisico total >= 3`, `Reservado por pedidos abiertos = 0`, SKU unico.

## P0 - Flujo Critico

Ejecucion completa: 2026-05-15
Pedido probado: `KNT-000009`
SKU probado: `QA-SKU-20260515-1738`
Resultado: P0 aprobado. Puede avanzar a P1.

| ID | Rol | Caso | Pasos | Resultado Esperado | Estado |
| --- | --- | --- | --- | --- | --- |
| QA-P0-01 | Admin | Login admin | Iniciar sesion con usuario admin. | Carga solo dashboard admin y navegacion admin. | OK |
| QA-P0-02 | Vendedor | Login vendedor | Iniciar sesion con usuario vendedor. | Carga solo dashboard vendedor, sin accesos admin. | OK |
| QA-P0-03 | Transportista | Login transportista | Iniciar sesion con usuario transportista. | Carga solo dashboard transportista, sin accesos admin/vendedor. | OK |
| QA-P0-04 | Admin | Crear producto inventario | Crear SKU nuevo con stock fisico 3. | Producto aparece y permanece tras recargar. Reservado inicia en 0. | OK |
| QA-P0-05 | Vendedor | Crear pedido manual con producto | Crear pedido seleccionando el SKU disponible. | Pedido queda creado con guia `KNT-000000`, visible para vendedor y admin. Inventario reservado aumenta en 1. | OK |
| QA-P0-06 | Admin | Asignar transportista | Desde admin asignar pedido a transportista. | Pedido muestra transportista asignado y no vuelve a mostrar boton de asignar. | OK |
| QA-P0-07 | Transportista | Avanzar flujo operativo | Tomar pedido asignado y avanzar llamada/recogida/ruta segun botones disponibles. | Solo aparece la siguiente accion valida; no hay acciones ambiguas. | OK |
| QA-P0-08 | Transportista | Entregar con evidencia | Subir imagen, observacion y confirmar entregado. | Pedido queda entregado, evidencia visible, inventario baja stock fisico en 1 y reservado baja en 1. Wallet vendedor/driver se actualiza. | OK |
| QA-P0-09 | Admin | Ver pedido entregado | Revisar admin despues de entrega. | Pedido entregado aparece con evidencia, novedades legibles y movimientos wallet. | OK |
| QA-P0-10 | Admin | Liquidar vendedor | Crear liquidacion vendedor para rango que incluye el pedido. | Movimientos quedan asociados a liquidacion, neto vendedor correcto, margen plataforma positivo. | OK |
| QA-P0-11 | Admin | Liquidar transportista | Crear liquidacion transportista para rango que incluye el pedido. | Movimientos quedan asociados a liquidacion, pago driver correcto, margen plataforma negativo por costo. | OK |

## P1 - Excepciones Operativas

Ejecucion completa: 2026-05-16
Pedidos probados: `KNT-000012`, `KNT-000013`
Resultado: P1 aprobado. Puede avanzar a P2.

| ID | Rol | Caso | Pasos | Resultado Esperado | Estado |
| --- | --- | --- | --- | --- | --- |
| QA-P1-01 | Vendedor | Duplicado referencia vendedor | Crear dos pedidos con misma referencia de vendedor. | Segundo intento falla con mensaje claro, sin crear duplicado ni reservar inventario. | OK |
| QA-P1-02 | Vendedor | Inventario sin stock | Crear pedido con SKU sin disponible. | La UI no permite seleccionarlo o backend rechaza sin crear pedido. | OK |
| QA-P1-03 | Admin | Recalcular reservas | Crear pedido con SKU y presionar `Recalcular reservas`. | Reservado coincide con pedidos abiertos por SKU/vendedor. | OK |
| QA-P1-04 | Transportista | Fallido cliente no recibe | Cerrar pedido como fallido con evidencia y motivo. | Pedido queda fallido, evidencia visible, reservado baja en 1, wallet registra fee fallido. | OK |
| QA-P1-05 | Transportista | Fallido cliente reagenda | Cerrar pedido como fallido con motivo `Cliente reagenda visita`, fecha y franja. | Pedido queda en reintento/reprogramado, evidencia visible, reservado se mantiene, wallet no se liquida aun. | OK |
| QA-P1-06 | Admin | Reasignacion despues de reagenda | Asignar/continuar pedido reprogramado. | Pedido puede continuar flujo sin duplicar wallet ni evidencia. | OK |
| QA-P1-07 | Vendedor | Visibilidad vendedor | Revisar pedidos, inventario y wallet del vendedor. | Vendedor solo ve sus pedidos, productos y movimientos. | OK |
| QA-P1-08 | Transportista | Visibilidad transportista | Revisar pedidos y wallet del transportista. | Transportista ve pedidos libres/asignados segun reglas y solo su wallet. | OK |

## P2 - Regresion y Seguridad

| ID | Rol | Caso | Pasos | Resultado Esperado | Estado |
| --- | --- | --- | --- | --- | --- |
| QA-P2-01 | Admin | Zonas y tarifas | Editar zona/tarifa y guardar. | Cambios persisten y se usan en liquidaciones nuevas. | Pendiente |
| QA-P2-02 | Admin | Evidencias | Abrir evidencia de pedido entregado/fallido. | Imagen carga desde Storage para usuarios autenticados. | Pendiente |
| QA-P2-03 | Todos | Consola navegador | Ejecutar flujo principal con consola abierta. | Sin errores 500, permisos inesperados o promesas sin capturar. | Pendiente |
| QA-P2-04 | Sistema | Build local | Ejecutar `npm run typecheck`, `npm test`, `npm run build`, build Functions. | Todos pasan. | OK |
| QA-P2-05 | Sistema | Reglas Firebase | Probar acceso cruzado entre roles. | Ningun rol ve datos que no correspondan. | Pendiente |

## Registro de Hallazgos

| ID | Caso | Severidad | Descripcion | Estado | Commit/Fix |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | Cierre con evidencia | Alta | `closeOrder` fallaba por lecturas despues de escrituras en transaccion Firestore. | Corregido | `5f8ee73` |
| BUG-002 | Crear pedido Live | Alta | `createManualOrder` fallaba por lecturas despues de escrituras en transaccion Firestore. | Corregido | `e4811e9` |
| BUG-003 | Inventario desaparece | Alta | El producto se actualizaba localmente antes de persistir en Live. | Corregido | `e5d86da` |
| BUG-004 | Reservas mezcladas | Media | Reservado podia quedar manualmente inconsistente tras pruebas. | Corregido con recalculo | `86322e6` |
| BUG-005 | Llamada pendiente | Alta | Selector nativo `type=date` bloqueo ingreso de fecha/franja en confirmar entrega y reprogramar llamada. | Corregido | `6996896` |
| BUG-006 | UX fechas | Media | El ingreso manual de fecha aun depende de formato `AAAA-MM-DD`; los botones rapidos desbloquean el flujo, pero falta una mascara/selector mas robusto. | Pendiente mejora | Pendiente |
| BUG-007 | Duplicado vendedor | Alta | Referencia duplicada no mostraba rechazo claro en UI y el submit quedaba sin feedback estable. | Corregido | Pendiente commit |
| BUG-008 | Login submit | Baja | Boton `Entrar` a veces no respondia al click y obligaba a usar Enter. | Corregido | Pendiente commit |
| BUG-009 | Persistencia zonas | Alta | Cambios en tarifas de zona se reflejaban en pantalla pero revertian al recargar porque no se guardaba la zona explicitamente en Live. | Corregido | Pendiente commit |

## Pendiente Para Despues Del QA

- Conectar Shopify por vendedor.
- Mapear pedidos Shopify contra productos/SKU.
- Notificaciones operativas.
- Reportes gerenciales.
- Upgrade runtime Functions desde Node.js 20.
