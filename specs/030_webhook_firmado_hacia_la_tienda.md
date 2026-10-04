# Spec 030: Kentro avisa a la tienda, con un webhook firmado, cuando cambia uno de sus pedidos

- **Estado:** borrador
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-10-04
- **Origen:** opcional OPC_01 de la peticion de CENTRAL (Kovia/ONEP) del 2-oct-2026, sacado de la spec 029 y
  priorizado inmediatamente despues por el responsable (decision 5 de la 029, 2026-10-04).
- **Depende de:** spec 029 (historial por pedido con origen; key de escritura).
- **Prioridad:** alta, despues de la 029.
- **Accesibilidad:** WCAG 2.2 AA (solo aplica a la pantalla de configuracion)

## 1. Contexto y objetivo

Hoy una integracion que quiere saber si su pedido cambio tiene que releer `GET /orders` de la API de tiendas, que
ademas lee todos los pedidos de la tienda en cada llamada. CENTRAL confirma por WhatsApp y necesita enterarse de
que un pedido tomo lider, salio a ruta, se entrego, fallo o se cancelo, sin sondear.

La spec 029 deja un registro por cada cambio de estado o de datos de entrega, con su origen. Esta spec convierte
ese registro en un aviso saliente.

**Objetivo:** que una tienda pueda registrar una URL y reciba, firmada, una notificacion por cada cambio de su
pedido, con reintentos, sin que un receptor caido frene ni falle la operacion de Kentro.

## 2. Glosario

| Termino | Significado |
|---|---|
| Evento | Un registro del historial de la spec 029 (cambio de estado o de datos de entrega) |
| Destino | La URL HTTPS que la tienda registra para recibir eventos |
| Secreto de firma | Clave por tienda con la que Kentro firma cada envio; se muestra una sola vez |

## 3. Historias de usuario

- **HU_01 (sin interfaz):** **Como** integrador **quiero** recibir un aviso firmado cuando cambia uno de mis
  pedidos **para** no tener que sondear la API.
- **HU_02 (interfaz):** **Como** tienda o administrador **quiero** registrar el destino, ver su ultimo resultado y
  rotar el secreto **para** controlar la integracion sin pedirselo a Kentro.

## 4. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** se registre un evento de un pedido de una tienda con destino activo, el sistema
  MUST enviar un `POST` al destino con el id del pedido, `shopifyOrderId`, el tipo de cambio, el estado anterior y
  el nuevo, los campos cambiados, el origen y la fecha del evento.
- **RF_02 (ubicua):** Cada envio MUST llevar una firma HMAC-SHA256 del cuerpo con el secreto de la tienda, una
  marca de tiempo y un id de evento unico, en cabeceras.
- **RF_03 (error):** **Si** el destino no responde 2xx en un plazo acotado, el sistema MUST reintentar con espera
  creciente durante al menos 24 horas, y despues MUST marcar el envio como fallido sin reintentar mas.
- **RF_04 (ubicua):** El envio MUST hacerse fuera de la transaccion que cambia el pedido: un destino caido o lento
  MUST NOT retrasar ni hacer fallar una confirmacion, una entrega o un cierre.
- **RF_05 (ubicua):** El cuerpo MUST NOT llevar identidades de quien opera en Kentro ni datos de otras tiendas
  (misma regla que RF_18 de la 029), ni cifras de dinero.
- **RF_06 (evento):** **Cuando** la tienda o el admin registren o roten el secreto, el sistema MUST mostrarlo
  completo una sola vez y guardar solo lo necesario para firmar fuera del alcance del cliente.
- **RF_07 (ubicua):** El destino MUST ser HTTPS; un destino no HTTPS MUST rechazarse al registrarlo.

## 5. Requisitos no funcionales

- **RNF_01 (orden):** Los eventos de un mismo pedido SHOULD llegar en orden; el receptor MUST poder ordenarlos
  por la fecha del evento si no llegan en orden.
- **RNF_02 (duplicados):** Un evento MAY entregarse mas de una vez; el id de evento permite descartar duplicados.
- **RNF_03 (observabilidad):** El ultimo resultado por destino (fecha, codigo HTTP, fallidos pendientes) MUST
  poder consultarse.

## 6. Casos limite

- Un pedido que cambia varias veces en segundos genera varios eventos, no uno resumido.
- Una reimportacion que no cambia datos de entrega no genera evento (RF_16 de la 029).
- Un destino que devuelve 410 se desactiva.

## 7. Fuera de alcance

- Eventos de dinero (cortes, liquidaciones, pagos).
- Reenviar eventos anteriores al alta del destino.

## 8. Definition of Done

1. Pruebas: firma verificable con el secreto; reintento ante 5xx; un destino caido no hace fallar la transicion.
2. Recorrido real con la tienda de pruebas de la 029 y un receptor que verifica la firma.
3. Documentacion de la verificacion de firma en `/storeApi` y `/api-tiendas`.
4. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
5. Firma del responsable.

## 9. Preguntas abiertas

1. ¿Un solo destino por tienda o varios?
2. ¿Que tipos de evento por defecto: todos, o solo cambios de estado?
3. ¿Reintentos durante 24 horas bastan para CENTRAL, o necesita reenvio manual desde el panel?

## 10. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-04 | Borrador inicial | OPC_01 de CENTRAL; decision 5 de la spec 029 |
