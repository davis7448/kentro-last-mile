# Spec 016: La tienda edita un pedido con la misma comodidad con la que lo crea

- **Estado:** borrador (propuesto por el informe de cierre de la spec 013, 2026-09-15)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Origen:** la 013 acoto RF_01 a RF_04 al formulario de **crear** pedido manual y dejo fuera, a
  sabiendas, el de **editar** un pedido importado antes de confirmarlo.

## 1. Contexto y objetivo

La 013 llevo el formulario de pedido manual a 44 px por control, filas que se apilan en telefono y fila
entera al desplegarse, y lo midio a 390 y 1.280 px. El otro formulario que la tienda usa en la misma
pantalla, el de revisar y corregir un pedido importado (`ImportedOrderReviewForm`,
`src/components/operations-app.tsx`), recibio de la 013 solo la casilla de indicaciones: sus **trece
controles siguen en `py-2 text-sm`, ninguno lleva `min-h-11`** (contado para este borrador), y nadie ha
medido si cabe en un telefono. Es el formulario que la tienda usa mas veces al dia: cada pedido de
Shopify que entra con direccion dudosa pasa por el antes de confirmarse.

**Objetivo:** que editar un pedido cumpla las mismas cuatro reglas que crearlo, medidas de la misma forma.

## 2. Historias de usuario

- **Como** tienda **quiero** corregir la direccion o el telefono de un pedido importado desde el telefono
  sin que se me escapen los campos **para** confirmar pedidos donde este.
- **Como** logistico de tienda (`seller_logistics`) **quiero** lo mismo, porque es mi trabajo principal.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** Todo control de `ImportedOrderReviewForm` MUST medir al menos 44 px de alto (mismo
  criterio y misma guarda de fuente que RF_04 de la 013).
- **RF_02 (ubicua):** Con el formulario de edicion abierto, la pagina MUST NOT tener desplazamiento
  horizontal a 390 px y el borde derecho de cada control MUST quedar dentro de la pantalla (criterio de
  RF_01 de la 013, medido igual).
- **RF_03 (ubicua):** Las filas con dos controles (zona y riesgo, pago y recogida) MUST apilarse en
  telefono, con `minmax(0, …)` como en la 013.
- **RF_04 (ubicua):** La casilla "Indicaciones para el mensajero" y la de "Direccion" MUST ser areas de
  texto de la misma altura minima que en el formulario de crear (`min-h-20`), para que la tienda vea una
  direccion larga entera al corregirla.
- **RF_05 (ubicua):** La guarda de fuente de la 013 sobre `ManualOrderPanel` (T6) MUST extenderse a
  `ImportedOrderReviewForm` con las mismas reglas, sin copiar el extractor.

## 4. Requisitos no funcionales

- **RNF_01:** Ningun campo cambia de nombre ni de destino: la callable `updateImportedOrder` recibe lo
  mismo que hoy.
- **RNF_02:** Sigue el sistema de diseno vigente (`docs/design-system.md`) y pasa su checklist de cierre.

## 5. Casos limite

- Pedido con direccion de tres lineas: el area de texto crece y no recorta.
- Telefono girado: entero.
- Pedido en `address_risk` con el aviso de riesgo visible encima del formulario: el aviso y el formulario
  caben sin desbordar.

## 6. Fuera de alcance

- Cambiar que campos se pueden editar o quien puede editarlos.
- El formulario de creacion del administrador (ya cubierto por la 013, que quito la casilla normalizada
  tambien para el).

## 7. Definition of Done

1. RF_01, RF_03, RF_04 y RF_05 con guardas de fuente en verde; RF_02 con la medida real a 390 y 1.280 px
   (misma tecnica que `verify-013.js`, o el arnes de la 015 si ya existe) guardada en `.sdd/evidence/016/`.
2. `npx tsc --noEmit` y `npm run lint` sin errores.
3. Comprobado en produccion por una tienda que edite pedidos a diario.
4. El humano valido el resultado y aprobo la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | La 013 midio el formulario de crear; el de editar quedo con 13 controles por debajo de 44 px |
