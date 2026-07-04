# Dropi — API de Integraciones (referencia)

Documentación entregada por el usuario (2026-07-02). Resumen operativo para Kentro.

## Auth
- Header en cada request: **`dropi-integration-key: <Token_Integracion>`**
- El token de integración es **permanente** (el usuario lo genera en Dropi → Integraciones, o vía `/login` + `/shops/store` para plataformas privadas).
- ⚠️ NUNCA pedir credenciales de acceso de Dropi al usuario (bloqueo definitivo del API). Solo el token de integración.

## URLs base
- Producción: `https://api.dropi.co/integrations`
- Pruebas: `https://test-api.dropi.co/integrations` (recursos limitados, sin transportadoras reales)

## Endpoints clave para Kentro
| Uso | Método | Path | Notas |
|---|---|---|---|
| Listar mis órdenes | GET | `/orders/myorders` | filtros: `status` (PENDIENTE, GUIA_GENERADA…), `filter_by`=GUIA/ORDEN ID/CELULAR + `value_filter_by` (multi separado por coma), `from`/`untill` (yyyy-mm-dd) + `filter_date_by`, `result_number`, `textToSearch` |
| Orden por ID | GET | `/orders/myorders/{id}` | el id es el de Dropi (LucidBot lo guarda en el custom field `[Logistica] ID de la orden` / `[Logistica] Order ID`) |
| Orden por guía | GET | `/orders/myorderbyguide/{guia}` | |
| **Cambiar estatus / generar guía** | PUT | `/orders/myorders/{id}` | body `{"status": "GUIA_GENERADA"}` — sirve para cambiar estatus de la orden; validar con Dropi qué estatus acepta (¿CANCELADO?) |
| Masivo estatus | POST | `/orders/myorder/masive` | `[{id, status}, ...]` |
| Crear orden | POST | `/orders/myorders` | body completo (state, city, name, surname, dir, phone, rate_type CON/SIN RECAUDO, type FINAL_ORDER, total_order, products[{id,price,quantity,variation_id}], shop_order_id...) |
| Novedades pendientes | GET | `/orders/myorders` | `haveIncidenceProcesamiento:true`, `issue_solved_by_parent_order:false` |
| PDF de guía | GET | `/guias/{transportadora}/{sticker}` | Servientrega y Envia usan `/guias/servientrega/...` |
| Cotizar flete | POST | `/orders/cotizaEnvioTransportadoraV2` | cod_dane origen/destino (7 chars), EnvioConCobro, amount |
| Departamentos / Ciudades | GET/POST | `/department`, `/trajectory/bycity` | |
| Productos | POST/GET | `/products/index`, `/products/v2/{id}` | |
| Cartera | GET | (historial de cartera) | |

## Webhook (opcional, requiere registro con TI de Dropi)
Dropi puede notificar cambios de estado de órdenes a un endpoint — **pero solo de órdenes creadas por el propio shop_type de la integración** (no serviría para órdenes creadas por LucidBot, que usa su propio shop_type). Estructura: `{id, status, dir, phone, total_order, name, surname, state, city, rate_type, shipping_company, shipping_guide, sticker, shop_order_id, orderdetails[...]}`.

## Notas de diseño para Kentro
- El token Dropi se guarda por tienda en `storeUchatSecrets/{sellerId}.dropiApiToken` (sin acceso de cliente). UI: campo "Token sincronización Dropi" visible solo para plataforma LucidBot.
- Cruce Kentro ↔ Dropi: vía el contacto de LucidBot (`[Logistica] ID de la orden`) o `filter_by=CELULAR` con el teléfono del pedido.
- Requisito de Dropi: registrar dominio + IP en su white-list (equipo TI Dropi) para consumir el API. Para tokens generados por el usuario en "Integraciones" (plataforma pública) el usuario lo relaciona directo.
