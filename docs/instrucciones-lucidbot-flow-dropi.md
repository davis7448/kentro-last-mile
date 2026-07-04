# Guía paso a paso — Flows "puente" Dropi en LucidBot (Senziacol)

**Para:** administrador del bot en `panel.lucidbot.co`
**Objetivo:** que Kentro pueda consultar (y si Dropi lo permite, cancelar) órdenes en Dropi a través de LucidBot. Las "Solicitudes de API Externa" de un flow salen desde los servidores de LucidBot, cuya IP SÍ está autorizada en el token de Dropi.
**Tiempo estimado:** 10–15 minutos. Se hace una sola vez.

**Ten a mano antes de empezar:**
- El **token de integración de Dropi** (el mismo que usa la integración Dropi del bot; se ve en Dropi → Integraciones).
- Verificar que los contactos tienen el campo **`[Logistica] ID de la orden`** con el número de orden de Dropi (la integración Dropi V2 ya lo llena).

---

## PASO 1 — Crear el campo donde quedará la respuesta

1. En el panel de LucidBot, ir a **Configuración → Campos personalizados** (o Herramientas → Campos personalizados, según la versión).
2. Clic en **+ Nuevo campo**.
3. Nombre: **`Kentro Dropi Respuesta`** (exactamente así, respetando mayúsculas).
4. Tipo: **Texto**.
5. Guardar.

---

## PASO 2 — Crear el flow "Kentro - Dropi Consultar"

1. Ir a **Automatización → Flujos** y clic en **+ Nuevo flujo**.
2. Nombre del flujo: **`Kentro - Dropi Consultar`** (debe empezar por "Kentro - ").
3. ⚠️ **No agregar ningún mensaje de texto** en el flujo — el cliente no debe recibir nada. Solo acciones.
4. Agregar un paso: **Acciones → Solicitud de API Externa**.
5. Configurar la solicitud:
   - **Método:** `GET`
   - **URL:**
     ```
     https://api.dropi.co/integrations/orders/myorders/
     ```
     y al final de la URL, **insertar la variable** del campo `[Logistica] ID de la orden` (usar el selector de variables `{{ }}` del editor). Debe quedar:
     ```
     https://api.dropi.co/integrations/orders/myorders/{{[Logistica] ID de la orden}}
     ```
   - **Headers:** agregar una cabecera:
     - Clave: `dropi-integration-key`
     - Valor: *(pegar el token de Dropi)*
6. **Probar la solicitud** (botón de probar/enviar del propio nodo): elegir como contacto de prueba uno que tenga `[Logistica] ID de la orden` con valor (cualquier pedido reciente). Debe responder estado **200** con un JSON que incluye `"isSuccess": true` y los datos de la orden.
7. **Response Mapping** (mapeo de la respuesta): mapear la ruta **`http_response_body`** (la respuesta completa) al campo **`Kentro Dropi Respuesta`**.
   - Opcional: si el editor lo permite, mapear también `http_status_code` a otro campo, pero no es necesario.
8. Guardar / **Publicar** el flujo.
9. **No** asignarle ningún disparador (trigger): este flujo lo dispara Kentro por API cuando lo necesite.

---

## PASO 3 — Crear el flow "Kentro - Dropi Cancelar"

> ⚠️ **Este flow cambia el estado de la orden en Dropi. Crearlo igual, pero probarlo SOLO con una orden de prueba** (ver Paso 4). La documentación de Dropi ejemplifica este endpoint con `GUIA_GENERADA`; hay que validar que acepte `CANCELADO`.

1. **Automatización → Flujos → + Nuevo flujo**, nombre: **`Kentro - Dropi Cancelar`**.
2. Sin mensajes; agregar **Acciones → Solicitud de API Externa**:
   - **Método:** `PUT`
   - **URL:** la misma del paso anterior (con la variable):
     ```
     https://api.dropi.co/integrations/orders/myorders/{{[Logistica] ID de la orden}}
     ```
   - **Headers:**
     - `dropi-integration-key` = *(token de Dropi)*
     - `Content-Type` = `application/json`
   - **Body** (tipo raw / JSON):
     ```json
     {"status": "CANCELADO"}
     ```
3. **Response Mapping:** `http_response_body` → campo `Kentro Dropi Respuesta`.
4. Guardar / Publicar. Sin disparadores.

---

## PASO 4 — Prueba controlada del flow de cancelar

1. Crear una **orden de prueba** en Dropi (o elegir una orden vieja que de todas formas se vaya a cancelar), asociada a un contacto del bot con su `[Logistica] ID de la orden`.
2. Ejecutar el flow "Kentro - Dropi Cancelar" manualmente sobre ese contacto (opción "Enviar flujo" desde la bandeja o el perfil del contacto).
3. Revisar en el panel de **Dropi** que la orden quedó **CANCELADA**.
   - Si quedó cancelada → ✅ listo.
   - Si Dropi responde error o no cambia → anotar el mensaje que quedó en el campo `Kentro Dropi Respuesta` y consultar con soporte de Dropi cuál es el valor de estatus correcto para cancelar (o si no está permitido por API). En ese caso el flow de cancelar se deja deshabilitado y solo se usa el de consultar.

---

## PASO 5 — Avisar a Kentro

Cuando los dos flows existan (y la prueba del Paso 4 esté hecha), avisar al equipo Kentro. Kentro conectará su lado: disparará estos flows por API sobre el contacto del pedido y leerá el resultado en `Kentro Dropi Respuesta`, con reglas de seguridad (solo órdenes de pedidos de Cali existentes en Kentro, siempre con auditoría).

## Notas finales
- El token de Dropi queda guardado dentro de la configuración del flow, en la infraestructura de LucidBot (la misma que Dropi ya autoriza). No sale de ahí.
- Estos flows **no reemplazan** la condición del flujo de confirmación (si Ciudad = Cali → no subir a Dropi). Son complementarios: la condición **evita** duplicados; este puente permite **corregir** los que se escapen.
- Si el editor muestra los nombres en otro idioma o levemente distintos ("External Request", "Actions"), es la misma opción.
