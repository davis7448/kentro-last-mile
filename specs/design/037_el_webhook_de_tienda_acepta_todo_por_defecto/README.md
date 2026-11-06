# Diseno — Spec 037: la conexion de una tienda nueva acepta todos sus productos, y la pantalla lo dice

Sistema "Acid Glass" (`docs/design-system.md`). Los textos visibles van **sin tildes**, como el resto de la app
(por eso "abrelo", "guardalo", "Los demas"). Las tiendas son reales (Infinito, Nambu, Kovia); los dominios
`*.myshopify.com`, las horas del ultimo webhook y el "12 descartados" de la tienda son **ilustrativos**. Los
153 de Nambu se tomaron del incidente de Infinito solo como cifra verosimil para el resaltado.

HU_01, HU_02 y HU_03 tienen interfaz. HU_04 esta marcada "sin interfaz" y no tiene pantalla.

## Pantallas

| Archivo | Historia | Quien | Viewport | Estado |
|---|---|---|---|---|
| `HU_01.tienda-acepta-todo` | HU_01 | tienda | 375x812 | conexion que acepta todo (lo normal desde ahora) |
| `HU_02.tienda-editar-filtro` | HU_02 | tienda | 375x812 | edicion del filtro con vista previa, "ADMA" escrito |
| `HU_02.tienda-con-filtro-y-descartados` | HU_02 | tienda | 375x812 | filtro ADMA activo y 12 descartados en 7 dias |
| `HU_03.admin-lista` | HU_03 | admin | 1280x800 | tabla: Infinito (todo), Nambu (ADMA, 153), Kovia (sin filtro guardado) |
| `HU_03.admin-lista-movil` | HU_03 | admin | 375x812 | la misma lista en tarjetas |

**Observacion: NINGUNA pantalla se observo con el navegador de diseno.** Este agente no tenia disponibles las
herramientas `mcp__plugin_sdd_playwright_design__*` (resize, navigate, take_screenshot), asi que no hay marca
de observado del arnes. Como comprobacion propia, no registrada, se rasterizaron los cinco SVG con `sharp`
fuera del repo y se miraron: de ahi salieron dos correcciones (la etiqueta del segundo radio desbordaba su
caja y sobraba hueco bajo la pildora de Nambu en movil). Esa revision no sustituye a la observacion: las cinco
llegan a la verificacion como **no observadas** hasta que alguien las navegue y capture con el navegador de
diseno.

## Decisiones

1. **Donde vive.** No se crea panel nuevo. En la tienda, dentro de la tarjeta "Conexion Shopify", bloque
   "Webhook de sincronizacion" (que pasa de `<p>` a `h3`). En el admin, la tarjeta "Webhooks Shopify por
   tienda" que ya existe (`StoreWebhookConfigsPanel`).
2. **La frase sustituye a las pildoras.** "SKU contiene X" / "Etiqueta X" desaparecen: eran datos sin
   consecuencia visible (spec, seccion 1). En su lugar, una caja `role="status"` con la frase de RF_04. El
   nombre accesible del status es exactamente la frase (con `aria-label` o con el texto como unico
   contenido), sin prefijos.
   - Acepta todo: contorno acido y check. "Entran todos tus productos. Solo se descartan pedidos fuera de
     Cali." La ciudad sale de las ciudades cubiertas; si algun dia hay varias, se enumeran ("fuera de Cali y
     Jamundi").
   - Filtra: contorno informativo (`#7cc4ff`) e icono de embudo. Filtrar no es un error, asi que no va en rojo.
   - **La frase describe el filtro que aplica el servidor, no el guardado** (RF_04, caso limite Kovia): una
     conexion antigua sin filtro guardado muestra la frase de ADMA. En el admin, ademas, una linea muted
     "Sin filtro guardado: aplica ADMA, el valor antiguo." para que el admin entienda de donde sale. En la
     pantalla de la tienda esa linea no aparece (no le sirve).
   - Conexion mixta (Bella Mujer: SKU todos, etiqueta ADMA): la frase es la de "acepta todo" (caso limite).
3. **Un solo campo para SKU y etiqueta.** La edicion ofrece un unico texto "SKU contiene" y la ayuda dice
   "Tambien entran pedidos con esa etiqueta". La frase usa el mismo valor para SKU y etiqueta. Si el plan
   tecnico decide conservar una etiqueta distinta guardada, la frase muestra los dos valores reales (RF_04),
   nunca el del campo.
4. **Cambiar filtro (HU_02).** Boton secundario "Cambiar filtro" bajo la frase. Al pulsarlo, el bloque se
   sustituye en el sitio (no modal) por:
   - `radiogroup` "Filtro de productos" con dos radios: **"Todos mis productos"** y **"Solo productos cuyo SKU
     contenga..."**, preseleccionado el que aplica hoy.
   - `textbox` **"SKU contiene"**, visible solo con el segundo radio. Se muestra en mayusculas al escribir
     ("adma" → "ADMA", caso limite).
   - Vista previa "Asi quedara" (`role="status"`, `aria-live="polite"`) con la frase resultante, que se
     recalcula al cambiar radio o texto, **antes de guardar** (RF_05).
   - **RF_09:** texto vacio o solo espacios con el segundo radio → la vista previa dice la frase de "acepta
     todo" ("Entran todos tus productos. Solo se descartan pedidos fuera de Cali.") y al guardar queda "Todos
     mis productos". No se bloquea el boton ni se muestra error: se dice lo que va a pasar.
   - **"Guardar filtro"** (primario, unico acido de la pantalla) y **"Cancelar"** (vuelve al estado anterior
     sin escribir). Linea final: "La URL del webhook no cambia al guardar." para que la tienda no reconfigure
     Shopify.
5. **"Actualizar webhook" deja de ser primario.** Con la conexion creada, la accion frecuente es "Copiar URL"
   (acida). "Actualizar webhook" pasa a secundario y NO toca el filtro (RF_02). El acido solo es primario en
   "Generar webhook" (estado vacio) y en "Guardar filtro".
6. **Descartados (RF_07).** Solo se muestran si hay alguno en los ultimos 7 dias.
   - Tienda: caja `role="status"` en tono `danger` (`#ff8b7c`): "12 pedidos descartados por el filtro esta
     semana", justo bajo la frase, antes de "Cambiar filtro" (que es lo que la tienda hara a continuacion).
     Con 0 no se pinta nada.
   - Admin escritorio: columna "Descartados 7 dias". Con alguno, celda resaltada "153 descartados esta semana"
     y la fila con un velo rojo tenue; con 0, "Ninguno" en muted. Movil: pildora roja en la tarjeta, o
     "Sin descartados esta semana" en muted. El resumen del panel cuenta las tiendas con descartados
     ("1 con pedidos descartados esta semana").
   - El contador lo calcula el servidor (RNF_03); el cliente solo recibe el numero.
7. **Advertencia del pedido viejo** (caso limite). Solo cuando acepta todo, caja informativa: "Si editas en
   Shopify un pedido viejo de Cali, entra a Kentro como pedido nuevo sin confirmar. Puedes borrarlo sin
   costo." Con filtro no aplica (el pedido viejo solo entra si se le pone la etiqueta).
8. **Instrucciones (RF_08).** El paso 3 depende del filtro:
   - acepta todo: "3. Para traer un pedido viejo, abrelo en Shopify y guardalo.";
   - filtra por etiqueta: "3. Para traer un pedido viejo, agrega la etiqueta ADMA en Shopify y guardalo."
   En el admin, una nota al pie con las dos variantes, porque la lista mezcla tiendas.
9. **Admin: nombres accesibles por fila.** Cada fila repite "Copiar URL"; el texto visible se mantiene corto y
   el nombre accesible lleva la tienda: **"Copiar URL de Infinito"**, y el campo **"URL del webhook de
   Infinito"**. Escritorio: `table` "Webhooks Shopify por tienda" (4 columnas, `PaginatedList` de 8 como hoy).
   Movil: `list` "Webhooks Shopify por tienda", una tarjeta por tienda con el nombre como `h3`.
10. **Lo que no cambia:** la URL, la caja de UChat que sigue bajo el bloque (no dibujada), la lista de tiendas
   conectadas por la app y los scopes.

## Estados

- **Cargando:** mientras llega la configuracion, el bloque muestra esqueleto (una barra para la frase y otra
  para la URL), nunca la frase de "acepta todo" por defecto: mostrar un filtro supuesto es justo el fallo que
  la spec corrige. El contador de descartados carga aparte; si aun no llego, no se pinta (ni "0").
- **Vacio (sin conexion):** solo el bloque "Webhook de sincronizacion" con su descripcion y el boton primario
  **"Generar webhook"** (`Generando...` mientras trabaja). Sin frase, sin URL, sin "Cambiar filtro": el filtro
  se puede cambiar despues de generar. Al generar, entra con "acepta todo" (RF_01). Admin sin conexiones:
  "No hay webhooks generados." como hoy.
- **Guardando el filtro:** "Guardar filtro" deshabilitado con texto "Guardando..."; radios y campo bloqueados.
- **Error al guardar:** el formulario sigue abierto con lo escrito, y bajo los botones un mensaje en `danger`
  con `role="alert"`: "No se pudo guardar el filtro. Sigue aplicando el anterior." mas la frase del filtro
  que sigue vigente. Nunca se muestra la frase nueva como si se hubiera guardado.
- **Error al actualizar el webhook:** el mensaje actual de la tarjeta, y la frase no cambia.
- **Exito al guardar:** el bloque vuelve al estado de lectura con la frase nueva en el status (que se anuncia
  por `aria-live`) y el contador de descartados se mantiene (cuenta lo ya descartado, no lo futuro).

## Accesibilidad

- Orden de encabezados: h1 "Integraciones" → h2 "Conexion Shopify" / "Webhooks Shopify por tienda" → h3
  "Webhook de sincronizacion" / nombre de tienda en movil → h4 "Instrucciones Shopify".
- Contraste: frase en `#f4f6f8`/`#cbd3dc` sobre `#212832`; descartados `#ff8b7c` (7.4:1 sobre panel);
  ningun texto bajo `#9aa5b3`. Texto sobre acido en `#10140c`.
- Controles a 44px (botones, radios como filas de 48px, campos de 44px). Los radios se pulsan en toda la fila.
- Los iconos de check, embudo y prohibido son decorativos (`aria-hidden`): el sentido va en el texto.
