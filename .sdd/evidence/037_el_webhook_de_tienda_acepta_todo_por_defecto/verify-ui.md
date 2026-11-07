# Verificacion de interfaz, spec 037 (2026-11-07)

App real en modo local (`NEXT_PUBLIC_USE_FIRESTORE=false npx next dev -p 3100`), estado inventado
inyectado en `localStorage` con `video/scripts/capture.mjs`. No toca produccion. Axe 4.13.0,
etiquetas wcag2a/2aa/21a/21aa/22aa. Viewports 375x812 (movil) y 1280x860 (escritorio).

El capturador del arnes (`sdd-ui-capture.mjs`) marca las cinco pantallas `unverified (no-route)`:
la app es una sola ruta y la vista depende del estado. Estas capturas son la observacion real que
falta para que el responsable las acepte con `/sdd-accept`.

| Captura | Frase (role=status) | Axe | Consola |
|---|---|---|---|
| HU_01-tienda-acepta-todo (375 y 1280) | "Entran todos tus productos. Solo se descartan pedidos fuera de Cali." | 0 | 0 |
| HU_02-tienda-adma-descartados (375 y 1280) | "Solo entran pedidos con un producto cuyo SKU contenga ADMA o con la etiqueta ADMA. Los demas se descartan." + "3 pedidos descartados por el filtro esta semana" | 0 | 0 |
| HU_02-tienda-editar-sin-ciudades (375 y 1280) | vista previa "Entran todos tus productos... fuera de Cali." con un documento SIN `cityAllowlist` (R1-RF_04-1: antes rompia la pantalla) | 0 | 0 |
| HU_03-admin-lista (375 y 1280) | "3 configurados"; la tienda solo-ChatBy no sale (R3-RF_03-1); Kovia legado con nota "Sin filtro guardado: aplica ADMA" | 0 | 0 |
| T5-tienda-solo-chatby (375 y 1280) | sin tarjeta; boton "Generar webhook" visible (R1-RF_03-1) | 1: `color-contrast` en "Quitar token" del formulario de ChatBy (`text-red-600` sobre `bg-field`, 3.07:1), previo a la 037 y fuera de su alcance | 0 |
