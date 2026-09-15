# Spec 012: El webhook de Shopify se prueba como lo usa Shopify

- **Estado:** borrador
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Prioridad:** tercera de las tres specs nacidas del incidente del webhook. Es el **primer tramo entregable
  de la spec 002** (entorno de verificacion), que lleva dos semanas en borrador porque su alcance completo es
  grande; este tramo es pequeno y cierra el hueco exacto que costo cuatro dias

## 1. Contexto y objetivo

El fallo del webhook no lo cazo ninguna prueba porque **ninguna prueba ejercita el webhook**. Las pruebas
unitarias cubren el calculo del sello de comunidad con comunidades reales; el smoke de produccion crea pedidos
con la cuenta de administrador, por otro camino. El unico que envia pedidos por el webhook es Shopify, y
Shopify no avisa cuando se los rechazan.

La tienda con mas volumen de la plataforma no pertenece a ninguna comunidad. Ese caso —el mas comun— era
justo el que no se probaba.

**Objetivo:** que antes de cada despliegue exista una prueba que envie al webhook un pedido **como lo envia
Shopify**, para una tienda sin comunidad y para una con comunidad, y compruebe que el pedido queda guardado
con lo que debe llevar.

## 2. Historias de usuario

- **Como** responsable de la plataforma **quiero** que un cambio que rompa la entrada de pedidos de Shopify no
  pueda desplegarse **para** no volver a enterarme por los clientes.
- **Como** quien mantiene el codigo **quiero** poder reproducir localmente lo que Shopify envia **para**
  depurar sin esperar a que un pedido real falle.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El sistema MUST tener una prueba que envie al webhook de Shopify una peticion con la
  misma forma que envia Shopify —cabeceras, firma y cuerpo— y compruebe la respuesta y el pedido resultante.
- **RF_02 (ubicua):** La prueba MUST cubrir al menos: una tienda **sin** comunidad, una tienda **con**
  comunidad, un pedido fuera de Cali (que se registra como incidencia y no como pedido) y un pedido repetido
  (que no se duplica).
- **RF_03 (ubicua):** La prueba MUST correr sin tocar produccion: contra un entorno aislado con datos propios,
  y MUST poder correr en la maquina de quien desarrolla.
- **RF_04 (evento):** **Cuando** la prueba falle, el despliegue de esa funcion MUST quedar bloqueado hasta que
  pase. Es la razon de ser de la spec: sin esto es una prueba mas.
- **RF_05 (ubicua):** La prueba MUST comprobar el pedido guardado campo a campo contra lo que se espera, no
  solo que "existe": el sello de comunidad correcto (vacio para la tienda sin comunidad), la tienda, la guia y
  el estado inicial.
- **RF_06 (error):** **Si** el webhook rechaza la peticion, la prueba MUST mostrar el motivo tal como lo
  devuelve la plataforma, no un "fallo generico".

## 4. Requisitos no funcionales

- **RNF_01:** La prueba entera MUST correr en menos de dos minutos, o no se ejecutara antes de cada despliegue.
- **RNF_02:** La firma de Shopify se MUST verificar de verdad en la prueba, con una clave de pruebas, no
  desactivarse "para que pase".

## 5. Casos limite

- **Pedido con productos que la plataforma no conoce:** se guarda igual; el costo de producto es cosa del
  cierre, no de la entrada.
- **Dos peticiones del mismo pedido en el mismo segundo** (Shopify reintenta): un solo pedido.
- **Tienda desconectada:** la peticion se rechaza con motivo claro y no crea nada.
- **Cuerpo malformado:** rechazo con motivo, sin tumbar la funcion.

## 6. Fuera de alcance

- El entorno de verificacion completo (spec 002: reglas, dinero, todos los recorridos). Esta spec es su primer
  tramo y MUST construirse de forma que la 002 lo reutilice, no lo repita.
- Los demas webhooks (tienda, OnStock, formulario). Mismo patron, specs siguientes; primero el que mas
  volumen mueve.

## 7. Definition of Done

1. La prueba existe, pasa, y **falla de verdad** cuando se reintroduce el fallo del 10 de septiembre (quitar la
   limpieza de campos sin valor en el webhook): se demuestra por mutacion.
2. Cubre los cuatro casos de RF_02 con comprobacion campo a campo (RF_05).
3. Corre en local en menos de dos minutos y forma parte del paso previo al despliegue de funciones (RF_04).
4. La spec 002 registra que este tramo queda cubierto y que reutiliza.
5. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | El webhook cayo cuatro dias sin que ninguna prueba lo ejercitara; primer tramo de la 002 |
