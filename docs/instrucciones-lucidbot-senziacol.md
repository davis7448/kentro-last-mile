# Instrucciones — Evitar pedido duplicado en Dropi (LucidBot × Kentro)

**Para:** administrador del bot de Senziacol en LucidBot (panel.lucidbot.co)
**Objetivo:** que los pedidos de **Cali** (los entrega Kentro, última milla) **NO se suban a Dropi** al confirmarse. Hoy la confirmación dispara la subida automática a Dropi → guía nacional (ENVIA/TCC) + entrega de Kentro = **pedido duplicado**.

---

## Qué hay que hacer (una sola vez, ~5 minutos)

En el flujo de confirmación del bot, **justo ANTES del paso que sube el pedido a Dropi** (el paso de LucidSales que genera la guía / deja `Estado_pedido = GUIA_GENERADA` y el tag "Pedido subido LucidSales"), agregar **un nodo de condición**:

### Condición principal (recomendada): por ciudad
- **SI** el campo personalizado **`Ciudad`** es igual a **`Cali`** o **`Santiago de Cali`** (sin distinguir mayúsculas/minúsculas)
  → **saltar la subida a Dropi** y continuar el flujo normal (mensaje de agradecimiento, etc.).
  El pedido debe quedar con **`Estado_pedido = CONFIRMADO`** (no debe llegar a `GUIA_GENERADA`).
- **SI NO** → continuar exactamente como hoy (subir a Dropi).

> Usar comparación "es igual a" (no "contiene"), para no capturar ciudades como Calima.

### Condición de refuerzo (opcional, recomendable añadirla como OR)
- **O SI** el campo personalizado **`Logistica_Kentro`** es igual a **`SI`** → también saltar Dropi.

Este campo **ya existe en la cuenta** (lo crea y lo marca Kentro automáticamente por API en los contactos cuyos pedidos entraron a la plataforma Kentro). Nota: Kentro lo marca en ciclos de ~2 horas, por eso la condición por ciudad es la principal (cubre el caso de un cliente que confirma a los pocos minutos).

## Qué NO hay que cambiar
- Nada más del flujo: la confirmación, los recordatorios, los mensajes siguen igual.
- Los pedidos del **resto del país** siguen subiendo a Dropi como siempre.

## Cómo verificar que quedó bien
1. Hacer un pedido de prueba con ciudad **Cali** en Shopify.
2. Confirmarlo en el bot (botón "Confirmar pedido").
3. Verificar que:
   - **NO** se creó pedido/guía en Dropi.
   - El contacto queda con `Estado_pedido = CONFIRMADO` (no `GUIA_GENERADA`).
4. Kentro tomará el pedido automáticamente en su siguiente ciclo (máx. ~2 h): pasa de "Pendiente confirmación" a "Listo para asignar" con la dirección sincronizada desde el bot.
5. Un pedido de prueba de **otra ciudad** (ej. Bogotá) debe seguir subiendo a Dropi normal.

## Contexto técnico (por si lo necesitan)
- Kentro consulta la API de LucidBot cada ~2 h y despacha los pedidos de Cali cuyo `Estado_pedido` sea `CONFIRMADO`.
- `GUIA_GENERADA` se interpreta como "lo envía Dropi" → Kentro no lo toca (protección extra contra duplicados).
- Campo `Logistica_Kentro`: id 957703, tipo texto, valor `SI`.
