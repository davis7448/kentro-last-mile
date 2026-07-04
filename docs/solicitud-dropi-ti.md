# Solicitud de habilitación — API de Integraciones Dropi (plataforma Kentro)

> Borrador listo para enviar al equipo de TI de Dropi (vía el ejecutivo de cuenta o el canal de soporte de integraciones). Completar los datos entre corchetes antes de enviar.

---

**Asunto:** Solicitud de registro de plataforma para consumo del API de Integraciones (Integrations Core Dropi)

Estimado equipo de TI de Dropi:

Solicitamos el registro de nuestra plataforma logística en la white-list de integraciones, conforme al procedimiento descrito en su documentación "Integrations: Core Dropi", con los siguientes datos:

**1. Datos de la plataforma**
- Nombre de la aplicación / integración (shop_type): **Kentro**
- Descripción: plataforma de logística de última milla (Cali, Colombia). Gestiona la entrega local de pedidos COD de tiendas que también operan con Dropi para el resto del país.
- Dominio de la plataforma: **https://kentro-last-mile.web.app**
- IP desde donde se consumirán los servicios: **72.60.121.154** (IP fija)

**2. Datos para la cuenta de pruebas**
- Nombre completo: **[NOMBRE COMPLETO DEL RESPONSABLE]**
- Documento de identificación: **[CC / NIT]**
- Correo electrónico: **[CORREO]**

**3. Proyección de uso de las APIs**
Volumen bajo, orientado a conciliación y prevención de despachos duplicados:
- `GET /orders/myorders` y `GET /orders/myorders/{id}`: consultas de estado de órdenes, estimado **< 500 solicitudes/día**.
- `PUT /orders/myorders/{id}`: actualizaciones puntuales de estatus (p. ej. cancelación de órdenes duplicadas ya cubiertas por entrega local), estimado **< 20 solicitudes/día**.
- Sin creación masiva de órdenes ni consumo de catálogos en esta fase.

**4. Contexto del caso de uso**
Tiendas clientes de Dropi utilizan nuestra plataforma para la entrega de última milla en Cali. Cuando un pedido con destino Cali se registra simultáneamente en Dropi (vía el bot de confirmación de la tienda), se genera un despacho duplicado. Con acceso al API, nuestra plataforma consultará el estado de esas órdenes y, con autorización del usuario dueño de la cuenta, ajustará el estatus de las órdenes duplicadas. Cada tienda usuaria generará su propio token desde el apartado de Integraciones y lo relacionará en nuestra plataforma; en ningún caso solicitamos credenciales de acceso de Dropi a los usuarios.

Quedamos atentos a los pasos siguientes y a las pruebas en el ambiente test (`https://test-api.dropi.co/integrations`) que consideren necesarias.

Cordialmente,
**[NOMBRE]** — [CARGO], Kentro
[CORREO] · [TELÉFONO]
