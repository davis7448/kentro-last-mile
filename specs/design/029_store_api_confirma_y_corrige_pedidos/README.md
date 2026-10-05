# Diseno — Spec 029: la tienda confirma, corrige y cancela pedidos por API

Sistema "Acid Glass" (`docs/design-system.md`). Los textos visibles van sin tildes, como el resto de la app.
Las personas (Martha Lucia Rios, Paola Rincon, Laura Gomez, Carolina Mesa) son **inventadas**; las tiendas
son reales (Kovia, ONEP, DANDA, Bella Mujer, Senziacol, E-master). La fecha de despliegue, que es tambien
`historySince`, se dibuja como **6 oct 2026** y es **ilustrativa**: la real la pone el despliegue.

Solo dos historias tienen interfaz: HU_04 (clave de escritura) y HU_05 (historial del pedido). HU_01 a HU_03
estan marcadas "sin interfaz" y no tienen pantalla.

## Pantallas

| Archivo | Historia | Quien | Viewport | Estado |
|---|---|---|---|---|
| `HU_04.tienda-sin-clave` | HU_04 | tienda | 375x812 | vacio: hay lectura, no hay escritura |
| `HU_04.tienda-recien-generada` | HU_04 | tienda | 375x960 | clave completa, mostrada una sola vez |
| `HU_04.tienda-activa` | HU_04 | tienda | 375x812 | normal: existe, fecha, ultimos 4 |
| `HU_04.tienda-rotar` | HU_04 | tienda | 375x812 | confirmacion de rotacion (hoja inferior) |
| `HU_04.tienda-error` | HU_04 | tienda | 375x812 | error al rotar; la anterior sigue activa |
| `HU_04.admin-lista` | HU_04 | admin | 1280x860 | normal: tabla por tienda |
| `HU_04.admin-lista-movil` | HU_04 | admin | 375x812 | normal: tarjetas por tienda |
| `HU_04.admin-recien-generada` | HU_04 | admin | 1280x800 | clave completa para una tienda (dialogo) |
| `HU_05.tienda` | HU_05 | tienda | 375x812 | con eventos, sin identidades |
| `HU_05.tienda-escritorio` | HU_05 | tienda | 1280x800 | con eventos, sin identidades |
| `HU_05.admin` | HU_05 | admin | 375x812 | con eventos, nombre, correo y rol |
| `HU_05.admin-escritorio` | HU_05 | admin | 1280x800 | con eventos, nombre, correo y rol |
| `HU_05.vacio` | HU_05 | tienda | 375x812 | sin cambios registrados |
| `HU_05.error` | HU_05 | tienda | 375x812 | no se pudo cargar |

Las 14 se observaron con el navegador de diseno el 2026-10-04, cada una a su `viewport` y despues de su
ultima edicion (ver "Correcciones de la observacion"). La decision 15 (2026-10-05) solo fija textos que estos
dibujos no muestran; ningun SVG ni `.screen.json` cambio, asi que siguen observados.

## Decisiones — HU_04, clave de escritura

1. **Donde vive (tienda).** Dentro del panel plegable **"Clave de API"** que ya existe en Integraciones
   (`CollapsiblePanel` → `StoreApiKeyCard`). No se crea otro panel. Su resumen pasa de "Consulta de pedidos
   desde tus sistemas" a **"Lectura y escritura desde tus sistemas"**, y su ayuda "?" deja de decir "solo
   lectura". El panel se divide en dos secciones con `h3`, separadas por un filete:
   - **"Clave de lectura"**: "Consulta pedidos, KPIs y liquidaciones." y el boton que ya existe, renombrado
     de "Ver mi API key" a **"Ver clave de lectura"** para que no se confunda con la otra. Su comportamiento
     no cambia (RF_26, RF_20): se sigue viendo completa cada vez, con copiar, URL de pedidos y rotar.
   - **"Clave de escritura"**: la nueva, con los estados de abajo.
2. **Donde vive (admin).** Panel plegable nuevo **"Claves de API de tiendas"** en Integraciones del admin,
   despues de "Incidencias de sincronizacion". El admin no tenia pantalla para la clave (spec, seccion 1).
   Resumen: "3 de 14 tiendas con clave de escritura". Se abre plegado (no es trabajo pendiente).
   - Escritorio: tabla "Claves de API por tienda" con Tienda, Lectura, Escritura, Generada y una columna de
     acciones (cabecera "Acciones" solo para lectores de pantalla). Pagina de 6 en 6 con Anterior/Siguiente.
   - Movil: la tabla pasa a tarjetas por tienda (lista "Claves de API por tienda"), 4 por pagina.
   - Buscador "Buscar tienda" (filtra en el navegador sobre la lista de tiendas que ya hay en el estado).
   - La columna Lectura es solo informativa: el admin no gestiona aqui la clave de lectura (fuera de HU_04).
   - Botones por fila con texto corto visible ("Rotar", "Generar") y nombre accesible completo:
     **"Rotar clave de escritura de Kovia"**, **"Generar clave de escritura de Bella Mujer"**.
3. **Estados de la seccion de escritura** (un solo componente para tienda y admin):
   - **Sin clave** (`HU_04.tienda-sin-clave`): pildora de contorno muted "Sin clave de escritura"
     (`role=status`) y la accion primaria **"Generar clave de escritura"** (relleno acido, la unica de la
     pantalla). Texto: "Confirma, corrige y cancela pedidos que aun no tienen lider. Kentro solo guarda su
     huella: la veras completa una sola vez."
   - **Recien generada** (`HU_04.tienda-recien-generada`, `HU_04.admin-recien-generada`): ver decision 4.
   - **Activa** (`HU_04.tienda-activa`): pildora "Activa" (contorno acido, `role=status`) y tres filas:
     "Termina en c41e", "Generada 6 oct 2026, 10:42", "Generada por". **Nunca la clave**, ni enmascarada con
     asteriscos: solo existe, cuando y los ultimos 4 (RF_25). La accion es **"Rotar clave de escritura"**,
     secundaria con texto rust (es destructiva para las integraciones), sin relleno acido.
   - **Error** (`HU_04.tienda-error`): ver decision 6.
   - **Cargando**: sin dibujo. La seccion muestra un esqueleto de pildora y dos filas, y el boton queda
     deshabilitado con el texto "Consultando..." (patron que ya usa la tarjeta).
   - **"Generada por"** dice "Tu tienda" o "Kentro" a la tienda (misma regla que RF_27: nunca el nombre de un
     admin). Al admin le dice "por la tienda" o el nombre del admin ("por Laura Gomez").
   - Pie fijo en todos los estados: "Va solo en la cabecera Authorization: Bearer." (RNF_01) y el enlace
     "Manual completo: /api-tiendas".
4. **La clave se ve una sola vez (RF_25).** Al generar o rotar, la seccion (tienda) o un dialogo (admin)
   muestra un aviso `role=alert` "Copiala ahora", con fondo acido al 8 % y contorno acido:
   - "Solo se muestra completa esta vez: Kentro guarda su huella, no la clave." (tienda) / "Es la unica vez
     que se muestra completa: Kentro guarda solo su huella. Entregala a la tienda por un canal seguro." (admin).
   - Campo de solo lectura **"Clave de escritura"** con la clave partida en dos lineas de 24 caracteres, en
     la sans con cifras tabulares (no monoespaciada).
   - **"Copiar clave de escritura"** (primaria, acida) y **"Ya la guarde"** (secundaria). "Copiar" anuncia
     "Copiada" en un `status`. "Ya la guarde" descarta la clave de memoria y pasa al estado Activa.
   - Aviso mudo: "Si sales sin copiarla, tendras que generar otra." / "Si cierras sin copiarla, tendras que
     rotarla." No se bloquea la salida: la clave no se recupera, solo se rota.
   - La clave vive solo en el estado del componente; no se guarda en `localStorage`, ni en el estado global
     de la app, ni en la URL. Al recargar, cerrar el dialogo o cambiar de vista se pierde.
   - El dialogo del admin dice ademas "Queda registrado que la generaste tu (Laura Gomez), hoy a las 11:08." y
     "La clave de lectura de Bella Mujer no cambia." (RF_25 audita quien; RF_26).
   - Si fue una **rotacion**, el aviso suma una linea: "La clave que terminaba en c41e ya no funciona."
5. **Confirmacion de rotacion** (`HU_04.tienda-rotar`). Dialogo modal (`role=dialog`, nombre "Rotar la clave
   de escritura"): hoja inferior en movil, modal centrado en escritorio, el mismo para tienda y admin.
   Sustituye al `window.confirm` que usa hoy la clave de lectura. Escape y "Cerrar" (icono, `aria-label`)
   cancelan. Texto: "La clave que termina en c41e deja de funcionar en el acto: tus integraciones reciben 401
   hasta que pongas la nueva. La clave de lectura no cambia." Acciones: **"Rotar ahora"** (relleno rust, tinta
   `#10140c`, 9:1) y **"Cancelar"**. El foco entra en "Cancelar", no en la accion destructiva. Generar la
   primera clave no pide confirmacion: no invalida nada.
6. **Error** (`HU_04.tienda-error`). `role=alert` rust "No se pudo rotar la clave" con la verdad que importa:
   "La que termina en c41e sigue activa. No se genero ninguna clave nueva." y **"Reintentar"** (acido). Si
   falla la primera generacion: "No se pudo generar la clave. No se creo ninguna." Debajo se sigue viendo el
   estado real. El plan tiene que garantizar esa frase: rotar es todo o nada.
7. **Logistico de tienda (`seller_logistics`).** No puede generar ni rotar (`createStoreApiKey` lo rechaza,
   RF_25 dice "rol `seller`"). Ve el estado de la seccion de escritura sin botones, con la linea "Solo la
   cuenta principal de la tienda o Kentro pueden generarla." Sin dibujo propio.

## Decisiones — HU_05, historial del pedido

8. **Donde vive.** El bloque "Historial del pedido" que ya existe en la tarjeta del pedido (`OrderAuditTrail`),
   el mismo para admin y tienda. No hay pantalla nueva. Sigue cargando bajo demanda al abrirlo.
   - El boton de cabecera tiene nombre fijo **"Historial del pedido"** con `aria-expanded`; el texto de la
     derecha ("Ocultar" / "Ver cambios") es `aria-hidden`. Hoy el nombre accesible incluye "Ver quien hizo
     cada accion", que para la tienda ya no es cierto.
   - Orden del mas viejo al mas nuevo, igual que la API (RF_17).
9. **Aviso de alcance (RF_17, `historySince`).** Al abrir, siempre y antes de los eventos, una nota
   (`role=note`, nombre "Que incluye el historial") en tono info:
   - escritorio: "**Campo por campo desde el 6 oct 2026.** No incluye los cambios de importaciones (Shopify y
     webhooks de tienda) ni la confirmacion automatica de ChatBy."
   - movil (mas corto para que quepa en 295 px): "**Campo por campo desde el 6 oct 2026.** No incluye
     importaciones de Shopify ni webhooks de tienda, ni ChatBy."
   - La fecha sale de `historySince`, nunca escrita en el codigo.
   - Se muestra tambien con el historial vacio; con error no (no se sabe nada).
10. **Cada evento** pinta: fecha y hora; **pildora de origen**; accion (`auditActionLabel`); transicion de
    estado si la hay ("Pendiente confirmacion → Listo para asignar"); y, si es un cambio de datos, los campos
    con **"Antes"** y **"Ahora"** escritos (no solo color ni tachado). Movil: campo y debajo sus dos lineas.
    Escritorio: mini tabla Campo / Antes / Ahora. Los eventos anteriores a la spec, que solo traen `summary`,
    muestran el `summary` (como hoy).
    - Accion nueva para la correccion de datos de entrega: **"Datos de entrega corregidos"** (se anade a
      `AUDIT_ACTION_LABELS`). Confirmar por API reutiliza "Confirmado"; cancelar, "Anulado".
    - Nombres de campo visibles: **los ratificados en la decision 15** (sustituye la lista que habia aqui el
      2026-10-04; el unico cambio es `customerName`, de "Nombre" a "Cliente").
11. **Que ve la tienda (RF_27).** Nunca uid, nombre, correo ni rol. Solo la pildora de actor:
    - **"Kentro"**: admin, lider, mensajero o proceso de la plataforma (ChatBy, webhooks, sistema);
    - **"Tu tienda"**: un usuario de esa tienda, incluido su logistico;
    - **"API"**: la clave de escritura de la tienda.

    Aplica a todos los eventos, tambien a los historicos. Como la pildora ya dice quien, no hay columna "Quien"
    en la tienda (`HU_05.tienda`, `HU_05.tienda-escritorio`). El filtrado es del servidor
    (`getOrderAuditTrail`); la pantalla solo pinta lo que llega.
12. **Que ve el admin.** Lo de hoy (nombre, correo y rol) mas el origen:
    - pildora **"Panel"** (una persona por la app) o **"API"** (la clave de escritura);
    - linea de quien: "Paola Rincon (paola@kovia.co) · seller" en movil; columna **"Quien"** en escritorio;
    - para la API: "Clave de escritura de Kovia" y, en escritorio, "termina en c41e" (que clave era).
13. **Pildoras de origen.** Todas de contorno y con texto; nunca solo color. "API" en info (`#7cc4ff`);
    "Kentro", "Tu tienda" y "Panel" en muted (`#9aa5b3` al 70 %, texto `#cbd3dc`). Ninguna en acido: el
    acido es solo para acciones.
14. **Estados del bloque.**
    - Cargando: "Cargando historial..." en `status` (sin dibujo, como hoy).
    - Vacio (`HU_05.vacio`): nota de alcance y, debajo, `status` "Sin cambios registrados" con "Este pedido
      no tiene cambios desde el 6 oct 2026 ni eventos anteriores." Es el caso normal de un pedido viejo
      (RF_24).
    - Error (`HU_05.error`): `role=alert` "No se pudo cargar el historial", "Revisa la conexion y vuelve a
      intentarlo. El pedido no ha cambiado por esto." y **"Reintentar"** (nuevo: hoy, tras un error, el bloque
      no vuelve a pedir nada). Sin nota ni eventos a medias.
15. **Textos visibles de acciones y campos del historial (ratificado el 2026-10-05).** Cierra la compuerta de
    diseno de T19 y T22 (plan, secciones 9 y 12). Son los textos exactos que usan `AUDIT_ACTION_LABELS` y el
    modelo de vista `order-audit-trail-view.ts`; las guardas de T19 y T22 los comparan con esta tabla.

    **Acciones nuevas en `AUDIT_ACTION_LABELS`:**

    | Accion | Texto visible | Por que |
    |---|---|---|
    | `order.delivery_corrected` | **Datos de entrega corregidos** | Ratifica la decision 10. Distinto de "Editado antes de confirmar" (`order.imported_updated`, edicion del panel) para que la tienda vea que la correccion vino por otra via |
    | `order.address_reviewed` | **Direccion revisada** | Cierra el estado que la app ya llama "Direccion por revisar" (`address_risk`); misma raiz, en participio como "Confirmado" o "Anulado". No dice "corregida" porque en este caso no cambio ningun campo (plan, P1) |
    | `order.picked_up` | **Recogido** | Es el texto que la app ya da al estado `picked_up` (`statusLabel` y la exportacion a Excel). Coincidir con la etiqueta del estado sigue el patron de "Entregado", "Fallido" y "Anulado"; la transicion de la misma linea ("... → Recogido") no lo hace redundante, porque la accion es la que nombra el evento y la transicion puede faltar en eventos historicos |

    Las acciones existentes no cambian (confirmar por API reutiliza "Confirmado"; cancelar, "Anulado").

    **Nombres de campo en "Antes/Ahora":**

    | Campo | Texto visible | Valor que se pinta en Antes/Ahora | Coherencia con la app |
    |---|---|---|---|
    | `status` | **Estado** | la etiqueta de `statusLabel` ("Pendiente confirmacion", "Direccion por revisar", "Listo para asignar"...), nunca el valor crudo | igual que la pildora de estado de la tarjeta |
    | `customerName` | **Cliente** | el nombre tal cual | es el rotulo del formulario de la tienda ("Cliente", `ImportedOrderReviewForm`) y de su mensaje "Completa cliente, telefono, direccion y valor". Sustituye a "Nombre", que con "Producto" en la misma lista ya no dice de quien es el nombre. No estaba dibujado en ningun SVG |
    | `customerPhone` | **Telefono** | el telefono tal cual | rotulo del formulario; ya dibujado |
    | `addressRaw` | **Direccion** | la direccion tal cual | rotulo del formulario; ya dibujado |
    | `deliveryNotes` | **Indicaciones** | el texto tal cual | forma corta de "Indicaciones para el mensajero (opcional)"; el resto no cabe en la columna de 375 px |
    | `cityId` | **Ciudad** | el nombre de la ciudad, nunca el id | la app habla de "la ciudad activa"; el id no le dice nada a la tienda |
    | `totalCop` | **Valor** | importe con `formatCop` ("$89.900") y cifras tabulares | rotulo del formulario de la tienda ("Valor"; "Completa ... y valor"). No "Recaudo": es el rotulo del ajuste del admin ("Recaudo COP") pero en un pedido pagado no hay recaudo, y la tienda y el admin ven el mismo modelo de vista |
    | `productName` | **Producto** | el nombre tal cual | rotulo de los dos formularios (tienda y ajuste del admin) |
    | `sku` | **SKU** | el SKU tal cual | rotulo de los dos formularios y de la tarjeta ("SKU ...") |
    | `quantity` | **Cantidad** | el numero, sin unidad | rotulo de los dos formularios |

    - Valor vacio o ausente a un lado (por ejemplo, indicaciones borradas por la API, o un SKU que no habia):
      se escribe **"Sin dato"**, en muted pero con contraste 6,1:1, nunca una celda en blanco ni un guion
      (un lector de pantalla no lee nada util en ninguno de los dos).
    - Sin tildes, como el resto de los textos visibles de la app (`statusLabel`, `AUDIT_ACTION_LABELS` y los
      formularios van todos sin tildes: "Direccion", "Telefono", "Anulado"). Mezclar "Teléfono" en el historial
      con "Telefono" en el formulario de al lado seria la incoherencia visible; el cambio a tildes, si se hace,
      es de toda la app y no de esta spec.
    - Un campo de `OrderHistoryField` sin fila en esta tabla es un fallo de la guarda de T19, no un texto que
      el codigo pueda inventar.

## Accesibilidad (WCAG 2.2 AA)

- Contraste sobre panel: texto `#f4f6f8` 14,6:1; muted `#9aa5b3` 6,1:1; rust 7,4:1; info ~8:1; tinta sobre
  acido 13,9:1; tinta sobre rust ~9:1. Sin grises por debajo de `#9aa5b3`.
- Solo colores del sistema: `#0e1116`, `#191e25`, `#212832`, `#f4f6f8`, `#cbd3dc`, `#9aa5b3`, `#c6f24e`,
  `#10140c`, `#ff8b7c`, `#7cc4ff` y blanco con opacidad para filetes y cristal.
- Un solo relleno acido por pantalla, y siempre es una accion.
- Objetivos tactiles: todos los botones miden 44 px de alto (Generar, Copiar, Ya la guarde, Rotar, Rotar
  ahora, Cancelar, Reintentar, Anterior/Siguiente, y los de fila del admin); los de solo icono ("Cerrar",
  "?") llevan `aria-label` y un area de 44 px.
- Encabezados: h1 de la vista; las secciones "Clave de lectura" y "Clave de escritura" son h3 dentro del
  panel; el titulo del dialogo es su encabezado.
- Dialogos: foco atrapado, Escape cierra, el foco vuelve al boton que lo abrio.
- El campo de la clave es de solo lectura con etiqueta visible "Clave de escritura".

## Correcciones de la observacion (2026-10-04)

- `HU_05.tienda` y `HU_05.admin`: la tercera linea de la nota de alcance ("webhooks de tienda) ni la
  confirmacion de ChatBy.") se salia de su caja a 375 px. Se reescribio en tres lineas mas cortas (decision 9).
- `HU_05.admin-escritorio`: el boton "Ajustar recaudo" quedaba dentro del bloque del historial; en el codigo
  es un formulario aparte (`AdminOrderAdjustmentForm`). Se movio a la fila de datos del pedido.
- `HU_05.error`: se quito una linea "Codigo: unavailable" antes de la primera captura (era ruido tecnico
  para la tienda).
- Sin defectos en la primera captura: las ocho de HU_04, `HU_05.tienda-escritorio` y `HU_05.vacio`.

## Pendientes

- **Resuelto el 2026-10-05 — compuerta de diseno de T19 y T22** (plan, seccion 12): etiquetas de
  `order.address_reviewed` ("Direccion revisada"), `order.picked_up` ("Recogido") y `order.delivery_corrected`
  ("Datos de entrega corregidos"), y nombres visibles de `status`, los cinco de entrega y `totalCop`,
  `productName`, `sku` y `quantity`. Ver decision 15. T19 y T22 pueden empezar.

## Para revisar fuera del diseno

- `CollapsiblePanel` pinta el boton "?" con `h-8 w-8` (32 px). La guia dice que `button.focus-ring` lo sube a
  44 px; conviene comprobarlo en el navegador al implementar, porque estas pantallas lo dibujan a 44.
- La frase de error "No se genero ninguna clave nueva" solo es verdad si rotar es atomico en servidor. Es
  cosa del plan.
- Un `summary` historico que nombre a una persona de Kentro (caso limite de la spec) se resuelve en el plan;
  el diseno no reescribe registros.
