# Diseno — Spec 026: efectivo que no llega a un corte

Sistema "Acid Glass" (`docs/design-system.md`). Las cifras de los dibujos salen de la medicion de la spec
del 2026-10-02 (153 pedidos, $14.557.721; 34 vencidos, $2.954.111) **despues de apartar los cubiertos por
compensacion** (ver "Cifras de muestra"). Los nombres de lideres y mensajeros son **inventados**. Los textos
visibles van sin tildes, como el resto de la app ("Operacion", "Historico").

**Enmienda de la spec (2026-10-02, decidido por el responsable):** los 24 pedidos de mas de 30 dias estan
en cortes ya saldados en total; con los demas casos iguales son 29 cortes y 36 pedidos. Pasan a un estado
propio, **"Cubierto por compensacion"** (decision 12), que no vence ni avisa. Los cuatro dibujos afectados
(`HU_01.aviso-operacion`, `HU_01.lista`, `HU_01.lista-escritorio`, `HU_02.finanzas`) estan redibujados con la
enmienda, y `HU_01.ilegibles` y `HU_02.al-dia` ajustados para que cuadren (ver "Redibujo por la enmienda").

**Observacion:** las once pantallas se observaron con el navegador de diseno el 2026-10-02, cada una a su
`viewport` y despues de su ultima edicion: primero en la pasada inicial y otra vez tras el redibujo de la
enmienda. Las correcciones que salieron de la observacion estan anotadas al final de este archivo.

## Decisiones

1. **Donde vive la lista del admin (HU_01).** Es una pestana nueva de Liquidaciones, **"Efectivo sin
   llegar"**, la segunda despues de "Por pagar". No es una entrada nueva del riel, que ya tiene seis. Usa el
   mismo `role="tablist"` "Secciones de liquidaciones". Encaja ahi porque responde a una pregunta del mismo
   trabajo: que parte no se puede pagar todavia.
2. **Total vencido en la pantalla principal (RF_03).** Es una tarjeta, region "Efectivo vencido", en
   Operacion del admin, encima de los indicadores actuales. Muestra la cifra en rust (dinero que se debe), el
   numero de pedidos, **el lider con mas efectivo vencido** (por importe, no por numero de pedidos: "Carolina
   Mesa, $388.471 en 6 pedidos") y la antiguedad del mas viejo. Los pedidos cubiertos por compensacion no
   cuentan; una linea muda lo dice ("No cuenta 36 cubiertos por compensacion") para que la bajada de la cifra
   no parezca un error. Su unica accion, "Ver efectivo sin llegar", abre la pestana. Con vencido $0 la
   tarjeta se reduce a una linea muda, "Efectivo vencido: $0 · al dia". No desaparece, porque RF_03 exige
   mostrar el total.
3. **Que total se ve (P1, aprobado).** Es el **recaudo bruto** (`totals.collectedCop`, y `collectedCop` por
   fila). El cuadre con la posicion se ve en la divulgacion plegada "Cuadre con la posicion de la
   plataforma":
   - plegada, muestra `driverReceivableCop`, `listOutstandingCop` y `unexplainedCop`;
   - desplegada, muestra una fila por cada causa de `causes`, con su importe y sus guias o cortes;
   - **solo `unexplainedCop` decide si el cuadre esta bien**: si es distinto de 0, el icono pasa a rust y la
     divulgacion se abre sola;
   - los cortes con pendiente guardado viejo (`settlement_cash_pending_stale`) o sin pendiente guardado
     (`settlement_cash_pending_missing`) son causas del cuadre, pero se listan aparte dentro de la
     divulgacion como "Cortes para revisar": no hacen que el cuadre falle;
   - solo aparece cuando `reconciliation != null` **y no hay filtro de lider**. El filtro "Lider" filtra
     en el navegador sobre la misma carga (sin otra llamada): con un lider elegido el cuadre se oculta, y
     vuelve al quitar el filtro.

   El nombre accesible del boton es fijo ("Cuadre con la posicion de la plataforma"). Las cifras van en
   `aria-describedby`.
4. **Agrupado por lider y orden.** Los grupos se ordenan por `overdueCop` descendente; dentro de cada
   grupo, del mas antiguo al mas reciente (`deliveredAt` ascendente).
   - Solo se despliega el primer grupo con importe vencido. Los demas van plegados (divulgacion progresiva).
   - Cada grupo pagina de 6 en 6 en movil y de 25 en 25 en escritorio ("Ver los N pedidos restantes").
   - "Sin lider" es un grupo propio, con el texto rust "no hay a quien cobrarle" (caso de la spec 017).
   - Cada cabecera de grupo es un boton de divulgacion de al menos 44 px, con chevron (derecha plegado,
     abajo desplegado). Un grupo sin vencidos dice "sin vencidos" en muted.
5. **Donde esta el efectivo: tres estados en la lista, y uno aparte.** Se distinguen con una pildora con
   texto, nunca solo por color:
   - "Fuera de todo corte": contorno rust. El pedido no esta en ningun corte.
   - "En corte abierto": relleno info. Esta en un corte que todavia no se ha pagado ni conciliado y que
     lo incluye; es el curso normal y se cubrira al pagar ese corte.
   - "Pagado con faltante": relleno rust. Esta en un corte ya **pagado o conciliado** que no lo cubrio y
     que **no** quedo saldado en total (el corte se cerro con menos efectivo del esperado). Es el caso mas
     grave: nadie va a volver a mirar ese corte por su cuenta.
   - "Cubierto por compensacion": **contorno muted** (`#9aa5b3` al 70 %, texto `#cbd3dc`) con un **check**
     delante del texto. No va en la lista principal, sino en su seccion (decision 12). No es rust, porque no
     falta dinero, ni info, porque no es un corte en curso. El check y el texto lo distinguen sin depender
     del color de "Fuera de todo corte", que tambien es de contorno.

   El lider ve la misma idea en su lenguaje: "No esta en ningun corte", "En el corte del 30 sep, abierto",
   "Corte del 30 sep pagado con faltante" o "Cubierto en el corte del 30 sep". La fecha es la del corte
   (`row.settlements[].createdAt`): para "abierto", el corte abierto mas reciente; para "pagado con
   faltante", el mas reciente; para "cubierto", el saldado mas reciente.

   Donde las cifras se agregan sin distinguir (la linea bajo la franja en movil, la cuarta cifra de la
   franja en escritorio) el rotulo es "en un corte sin cubrir", que es cierto para abierto y pagado con
   faltante. El rotulo "En corte pendiente" de la version anterior del diseno queda retirado.
6. **Fecha aproximada.** Si `deliveredAtSource` es `"updatedAt"`, la fecha va con el sufijo "aprox." en
   texto muted, y el detalle de la fila dice de donde salio. Con las fuentes `evidence` y `cod_entry` no se
   marca nada en la fila, solo en el detalle.
7. **Detalle de la fila (al tocarla).** Muestra lo que sirve una vez elegido el pedido:
   - los cortes que lo contienen, de `row.settlements` (`{ id, status, createdAt, cashSettled }`, del mas
     reciente al mas antiguo): para cada uno, su fecha, su estado (abierto, pagado, conciliado) y si quedo
     saldado en total;
   - fuente de la fecha;
   - recaudo, pago al domiciliario, efectivo esperado, recibido y pendiente;
   - `collectedSource = "order_total"`, avisado como "sin asientos de recaudo; se usa el total del pedido";
   - `supplierWithheld` por proveedor.

   Un pedido con `expectedCashCop = 0` (el caso de $1) aparece con la nota "Sin efectivo esperado: su pago
   supera el recaudo". No dispara aviso.
8. **Proveedor (RF_08).**
   - En escritorio va la tarjeta "Producto retenido a proveedores" (`bySupplier`, los dos mayores), con un
     enlace al desglose completo. En movil va plegada debajo de la franja.
   - En Liquidaciones > Por pagar, la tarjeta de cada proveedor anade una linea: "No se puede pagar
     todavia: $X (efectivo sin llegar)", con `amountCop` de la carga resumen compartida (decision 11).
   - Al lider no se le muestra nada de esto (el informe le llega sin esos campos).
   - `bySupplier` sale solo de `rows`: el producto de los pedidos compensados no aparece como retenido.
9. **Plazo y umbral (RF_04).**
   - Se ajustan en el dialogo "Plazo y aviso": hoja inferior en movil, modal en escritorio. Escape cierra.
   - Plazo de 1 a 120 dias; "Avisar desde, en pesos" con 0 como minimo. Por defecto, 7 dias y $20.000.
   - Muestra si el canal del aviso esta configurado. Sin secreto (o con el valor `none`) dice "Sin canal:
     el aviso solo se ve en la app".
   - Guarda por `updateCashAlertSettings`, recalcula y anuncia "Guardado" en un `status`. Si la pestana
     "Efectivo sin llegar" esta abierta, recalcula con conciliacion y esa carga pasa a ser la compartida;
     si no, refresca la carga resumen. Un error de validacion queda bajo el campo, con `aria-invalid`.
10. **Vista del lider (HU_02, P6: complementa).**
    - Es un panel nuevo, region "Efectivo sin llegar a Kentro", al inicio de Finanzas. No sustituye a
      "Pendiente por entregar" de Operacion.
    - Su cifra es `outstandingCop`, neta de su pago: lo que de verdad tiene que entregar. No incluye los
      pedidos cubiertos por compensacion; esos van en una linea aparte (decision 12).
    - El boton "?" ("Que incluye esta cifra") explica por que no coincide con "Pendiente por entregar":
      aquella suma los cortes abiertos por su saldo guardado y el total del pedido.
    - Densidad de calle: cuerpo de 15 a 17 px y controles de 56 px. Se queda en tema oscuro, como el resto
      de DriverView; solo el mensajero va en claro.
    - No tiene accion "ya lo entregue": la spec no la pide. Una nota le dice que avise al administrador con
      la guia (queda al final de la lista, debajo de las tarjetas).
11. **Cuando se calcula.** No hay suscripcion. Hay dos cargas:
    - **Carga resumen compartida** (`includeReconciliation: false`): se pide una vez al entrar el admin y
      la usan la tarjeta "Efectivo vencido" de Operacion y la linea de proveedor de Por pagar. Volver a
      Operacion no la repite; solo "Actualizar" la refresca.
    - **Carga con conciliacion** (`includeReconciliation: true`): solo la pestana "Efectivo sin llegar", al
      abrirla y con "Actualizar". Al llegar sustituye a la carga compartida ("prime"), asi la tarjeta y la
      pestana muestran siempre el mismo momento.
    - El lider pide la suya al abrir Finanzas y con "Actualizar" (siempre sin conciliacion).
    - La cabecera dice "calculado hoy HH:MM".
12. **Cubierto por compensacion (RF_09, enmienda decidida por el responsable el 2026-10-02).** Un pedido
    que la regla por pedido no da por recibido, pero que esta en un corte pagado o conciliado cuyo efectivo
    total quedo saldado (el lider entrego todo lo esperado del corte).
    - **Admin:** seccion propia **al final de la pestana**, despues de todos los grupos de lider, plegada por
      defecto. Es un `h3` "Cubiertos por compensacion" que envuelve el boton de divulgacion (nombre
      accesible fijo, "Cubiertos por compensacion"); las cifras van fuera del nombre, en `aria-describedby`:
      "36 pedidos · $3.358.840 · 29 cortes saldados" (`totals.nettedCount`, `nettedCollectedCop`,
      `nettedSettlementCount`). Debajo, la explicacion: "El lider entrego todo lo que debia en estos
      cortes. La regla por pedido no los marca como recibidos; se corrige en la spec 027."
      - Movil (`HU_01.lista`): plegada; bajo el titulo, las cifras y la pildora "Cubierto por compensacion"
        como leyenda del estado de sus filas.
      - Escritorio (`HU_01.lista-escritorio`): se dibuja **desplegada** para mostrar sus filas. Es una tabla
        aparte, "Pedidos cubiertos por compensacion", con columna **Lider** en vez de Mensajero (las filas
        no estan dentro de un grupo de lider). Los dias van en muted, no en rust (`isOverdue = false`), y el
        recaudo en `#cbd3dc`. Pagina de 25 en 25 como el resto.
      - La tarjeta de la seccion es mas oscura (`#141920`) y con borde muted, para que se lea como "aparte"
        y no como un grupo mas.
      - No entran en la franja de cifras, ni en los grupos por lider, ni en el total vencido, ni en el
        producto retenido, ni en el cuadre como lista (si como causa). La franja lo advierte con una linea
        muda: "Aparte, al final: 36 cubiertos por compensacion" (movil) o "Los 36 pedidos cubiertos por
        compensacion van aparte, al final." en la descripcion de la pestana (escritorio).
    - **Lider (`HU_02.finanzas`):** bajo su cifra, separada por una linea, el texto "27 pedidos cubiertos en
      cortes ya saldados: no debes nada por ellos." y un boton de divulgacion de 56 px, "Ver pedidos
      cubiertos" (nombre fijo; el numero queda en el texto anterior). Desplegado, lista sus guias con la
      pildora "Cubierto en el corte del <fecha>" en el mismo contorno muted con check.
    - **Aviso externo:** nunca los incluye.

## Cifras de muestra (coherentes entre pantallas)

Las cifras de la spec son totales; el reparto entre grupos, tiendas y mensajeros es **ilustrativo**. Lo que
cuadra en todos los dibujos:

| Concepto | Pedidos | Recaudo |
|---|---:|---:|
| Medicion de la spec (antes de apartar) | 153 | $14.557.721 |
| Cubiertos por compensacion | 36 | $3.358.840 |
| **Lista principal** (`rows`) | **117** | **$11.198.881** |
| · fuera de todo corte | 84 | $7.902.410 |
| · en un corte sin cubrir (abierto o pagado con faltante) | 33 | $3.296.471 |
| **Vencido, mas de 7 dias** | **10** | **$707.471** |

- **Vencido.** Los 24 de mas de 30 dias ($2.246.640) son todos compensados; los otros 12 compensados se
  suponen de 7 dias o menos. Asi el vencido queda en el tramo de 8 a 30 dias de la spec: 10 pedidos,
  $707.471.
- **Grupos por lider** (orden por `overdueCop`): Carolina Mesa, 49 pedidos, $4.587.721, 6 vencidos por
  $388.471; Sin lider, 2, $164.500, 2 vencidos por $164.500; Jhon Fredy Ruiz, 4, $348.660, 2 vencidos por
  $154.500; Wilmer Ospina, 34, $3.120.500, sin vencidos; Diana Cardona, 28, $2.977.500, sin vencidos. Suman
  117 pedidos y $11.198.881.
- **Jhon Fredy Ruiz** era el primer grupo antes de la enmienda (31 pedidos, $2.884.300, 26 vencidos). Le
  salen 27 compensados (los 24 viejos y 3 recientes, $2.535.640) y baja al tercer lugar. Sus guias de julio
  y agosto (KNT-003921, KNT-004118, KNT-004302, KNT-004577) estan ahora en la seccion de compensados.
  **KNT-004118 pasa de "Pagado con faltante" a "Cubierto por compensacion"**: tiene 85 dias, y la spec dice
  que los 24 de mas de 30 dias estan en cortes saldados.
- **Lider en `HU_02.finanzas`** (JR = Jhon Fredy Ruiz): $320.660 netos por entregar en 4 pedidos, 2 de mas
  de 7 dias (KNT-005391, $79.000 de recaudo y $73.000 neto; KNT-005468, $75.500 y $68.500), y 27
  cubiertos. Los 9 compensados restantes son de Carolina Mesa ($823.200).
- **Producto retenido:** ADMA LABORATORIO baja de $1.551.550 a $1.094.350 (ilustrativo) porque parte de su
  producto estaba en pedidos compensados.
- **Cuadre:** "por cobrar al domiciliario" no cambia ($11.402.100: la posicion no se toca); la lista neta del
  pago baja a $9.233.760; la diferencia la explican las causas, entre ellas la compensacion. Sin explicar $0.
- **Ilegibles:** sobre la lista principal faltan 2 pedidos ($159.500, ninguno vencido): 115 pedidos,
  $11.039.381; 83 fuera de todo corte y 32 en un corte sin cubrir.
- **Al dia:** el lider es "LG", que no aparece en ningun grupo de la lista del admin.

**Pendiente de T1 (no es del diseno):** la spec da "36 pedidos, **$1.151.997**" para los compensados. Esa
cifra **no puede ser recaudo**, porque solo los 24 de mas de 30 dias ya suman $2.246.640 de recaudo. Lo mas
probable es que sea efectivo esperado o pendiente sin asignar. Los dibujos muestran recaudo (decision 3),
asi que la cabecera de la seccion lleva una cifra ilustrativa ($3.358.840). Cuando T1 diga que mide
$1.151.997, la seccion tiene que mostrar `nettedCollectedCop` real y, si se quiere ensenar la otra cifra,
con su propio rotulo.

## Estados

| Estado | Admin (HU_01) | Lider (HU_02) |
|---|---|---|
| Cargando | `HU_01.cargando`: esqueleto, `status` "Calculando el efectivo sin llegar" y Actualizar deshabilitado | El mismo patron dentro del panel: esqueleto de cifra y dos tarjetas, con el mismo `status`. Sin dibujo propio |
| Vacio | `HU_01.vacio`: "Todo el efectivo llego" (si solo hay compensados, se muestra este estado y debajo su seccion plegada) | `HU_02.al-dia`: "Kentro tiene todo tu efectivo" (con la linea de compensados si los hay) |
| Error | `HU_01.error`: `alert` sin ninguna cifra parcial, con Reintentar. Actualizar se oculta | `HU_02.error`: igual, con boton de 56 px |
| Documentos ilegibles | `HU_01.ilegibles`: region "Documentos ilegibles", "Cifras incompletas" | Igual que el admin, sin ids. Texto: "Hay datos que no se pudieron leer; el total puede no estar completo. Avisa al administrador." Sin dibujo propio |
| Con datos | `HU_01.lista` (movil), `HU_01.lista-escritorio` | `HU_02.finanzas` |

Sobre los documentos ilegibles:
- Cuentan como ilegibles los **pedidos**, los **cortes** y los **asientos** que no pasan la validacion
  (`unreadableOrderIds`, `unreadableSettlementIds`, `unreadableEntryIds`). Con cualquiera de los tres el
  estado es "Cifras incompletas"; el dibujo `HU_01.ilegibles` sirve para los tres.
- La lista de "Ver documentos ilegibles" muestra el tipo (pedido, corte o asiento) y el id de cada
  documento. No hace falta mas identificacion.
- Si hay algun corte en `unreadableSettlementIds`, el texto lo advierte expresamente, porque un corte
  ilegible puede dejar en la lista pedidos que en realidad ya estan cubiertos (o que serian compensados).
- Un asiento ilegible no entra en ninguna suma: el recaudo o el pago de ese pedido puede salir corto.
- Un corte sin pendiente guardado **no** es ilegible: se lee como pendiente 0, igual que la posicion.

## Accesibilidad (WCAG 2.2 AA)

- Contraste sobre panel: rust 7,4:1, info alrededor de 8:1, muted 6,1:1 y tinta sobre acido 13,9:1.
- Un solo relleno acido por pantalla. Es la accion primaria; ninguna cifra va en acido.
- Encabezados en orden: h1 de la pagina, h2 de la pestana o del panel, h3 de cada grupo de lider y de la
  seccion "Cubiertos por compensacion".
- La tabla de escritorio pasa a tarjetas por fila en movil.
- Los botones que son solo un icono llevan `aria-label` ("Actualizar", "Que incluye esta cifra",
  "Cerrar").
- Los "dias" vencidos llevan texto ademas del color. Los dias de un compensado van en muted, sin pildora.
- Los botones de divulgacion con cifras variables tienen nombre fijo y las cifras en `aria-describedby`
  ("Cuadre con la posicion de la plataforma", "Cubiertos por compensacion", "Ver pedidos cubiertos").
- Objetivos tactiles: 44 px en consola (admin), 56 px en calle (lider).

## Correcciones de la observacion (2026-10-02)

### Pasada inicial

- `HU_01.lista-escritorio`: la descripcion de la pestana se metia bajo el rotulo "Lider" (se reparte en
  dos lineas mas cortas); "Plazo y aviso" tocaba el borde de su pildora (boton mas ancho); la
  divulgacion del cuadre y "Ver los 27 pedidos restantes" median 36 px (ahora 44); la fila KNT-004118 pasa
  a "Pagado con faltante", KNT-004577 a "En corte abierto", y la cuarta cifra se rotula "En un corte, sin
  cubrir".
- `HU_01.lista` e `HU_01.ilegibles`: "en corte pendiente" pasa a "en un corte sin cubrir". En ilegibles,
  "Ver documentos ilegibles" media 40 px (ahora 44) y el selector de lider no tenia su flecha.
- `HU_01.aviso-operacion` y `HU_01.plazo`: decian "sin corte" / "sin llegar a un corte", falso para los
  pedidos que estan en un corte sin cubrir. Ahora hablan de que el efectivo no llega o no esta cubierto.
- `HU_02.finanzas`: el boton "?" de 56 px llegaba al borde de la tarjeta (los dos iconos se desplazan
  16 px); la pildora "En el corte del 30 sep, sin cubrir" desbordaba su fondo y describia un corte pagado:
  ahora es "Corte del 30 sep pagado con faltante", en rust.
- `HU_02.al-dia`: el boton Actualizar llegaba al borde de la tarjeta.
- Sin defectos: `HU_01.cargando`, `HU_01.vacio`, `HU_01.error`, `HU_02.error`.

### Redibujo por la enmienda (RF_09)

- `HU_01.aviso-operacion`: la cifra pasa de $2.954.111 / 34 a **$707.471 / 10**. "26 de Jhon Fredy Ruiz"
  pasa a "El lider con mas efectivo vencido: Carolina Mesa, $388.471 en 6 pedidos". El mas antiguo pasa de
  93 a 21 dias. Nueva linea "No cuenta 36 cubiertos por compensacion". Al observarlo, esa linea quedaba a
  6 px del boton: el boton baja 10 px y la tarjeta crece.
- `HU_01.lista`: franja $11.198.881 / 117 y vencido $707.471 / 10; "84 fuera de todo corte · 33 en un
  corte sin cubrir" y nueva linea "Aparte, al final: 36 cubiertos por compensacion". El primer grupo es
  ahora Carolina Mesa, con 6 filas (una pagina de movil) y "Ver los 43 pedidos restantes"; siguen
  plegados Sin lider, Jhon Fredy Ruiz, Wilmer Ospina y Diana Cardona; al final, la seccion plegada
  "Cubiertos por compensacion" con su pildora. Para que se vea la pagina entera, el **viewport pasa de
  375x812 a 375x1892** (el ancho sigue siendo el de movil). Cabeceras de grupo con chevron. El contrato
  anade heading y button "Cubiertos por compensacion". La observacion no encontro defectos.
- `HU_01.lista-escritorio`: las mismas cifras en cuatro columnas ($11.198.881, $707.471, $7.902.410,
  $3.296.471), producto retenido de ADMA LABORATORIO a $1.094.350, lista neta del cuadre a $9.233.760.
  Tabla con Carolina Mesa desplegada (6 filas, marcador "19 pedidos mas, sin vencer, en esta pagina" y "Ver
  los 24 pedidos restantes") y cuatro grupos plegados. Seccion "Cubiertos por compensacion" desplegada con
  KNT-003921, **KNT-004118** (antes "Pagado con faltante"), KNT-004302 y KNT-004577, marcador "21 pedidos
  mas en esta pagina" y "Ver los 11 pedidos restantes". El **viewport pasa de 1280x800 a 1280x1450**. El
  contrato anade heading y button "Cubiertos por compensacion", table "Pedidos cubiertos por compensacion"
  y columnheader "Lider". La primera captura (a 1428 de alto) mostraba el marcador de la seccion pegado a
  la ultima fila y al boton: se separan y la pagina crece a 1450.
- `HU_02.finanzas`: la cifra de Jhon Fredy Ruiz pasa de $2.247.300 / 31 pedidos / 26 vencidos a **$320.660
  / 4 / 2**. Nueva linea "27 pedidos cubiertos en cortes ya saldados: no debes nada por ellos." con el
  boton "Ver pedidos cubiertos" (56 px). Las tarjetas son ahora KNT-005391 (21 dias, "No esta en ningun
  corte") y KNT-005468 (16 dias, "Corte del 30 sep pagado con faltante"). La segunda tarjeta queda en parte
  bajo la navegacion fija, como al desplazar; la nota "Si ya entregaste este efectivo..." queda debajo. El
  contrato anade el button "Ver pedidos cubiertos".
- `HU_01.ilegibles` (no estaba en la lista de redibujo; ajustado por coherencia): mantenia el vencido de
  antes de la enmienda ($2.954.111 / 34). Ahora $11.039.381 / 115 y $707.471 / 10; "83 fuera de todo corte ·
  32 en un corte sin cubrir". Sin cambio de contrato.
- `HU_02.al-dia` (ajustado por coherencia): el avatar decia "CM", Carolina Mesa, que en la lista tiene 49
  pedidos sin llegar. Pasa a "LG", un lider que no esta en la lista. Sin cambio de contrato.
- Observadas de nuevo, sin cambios ni defectos: `HU_01.plazo`, `HU_01.cargando`, `HU_01.vacio`,
  `HU_01.error`, `HU_02.error`.

## Ajustes de texto tras el plan (2026-10-02)

- **Tercera pasada de `/sdd-analyze`:** decision 3 (cuadre solo sin filtro de lider), 5 (fecha del corte),
  7 (`row.settlements`), 8 (carga resumen), 9 (recalculo al guardar), 11 (dos cargas) e ilegibles
  (asientos).
- **Cuarta pasada:** decision 2 ("el lider con mas efectivo vencido"), 3 (solo `unexplainedCop` decide;
  cortes viejos o sin pendiente se listan para revisar), 5 y nueva 12 (cubierto por compensacion), 7
  (`cashSettled`), 10 (linea de compensados del lider), estados vacio/al dia y nota sobre cortes sin
  pendiente guardado.

## Para revisar fuera del diseno

- `HU_01.plazo` dice "Sale cada dia a las 8:00, una vez por pedido". La seccion 9 de la spec acepta "al
  menos una vez". El texto es correcto para el usuario en el caso normal y no se ha cambiado; si se quiere
  exactitud literal, seria "una vez por pedido (puede repetirse si falla el registro)".
