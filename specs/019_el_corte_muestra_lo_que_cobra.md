# Spec 019: El corte muestra el mismo dinero que cobra

- **Estado:** **aprobada** (2026-09-19) — pasada por `sdd-skeptic`, decisiones del responsable en la seccion 8
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Prioridad:** alta — el domiciliario ofrecio pagar por segunda vez $533.400 que ya habia pagado
- **Accesibilidad:** WCAG 2.2 AA

## 1. Contexto y objetivo

El corte de liquidacion de un domiciliario tiene dos partes: una cabecera con el total de efectivo
que debe entregar, y debajo el detalle pedido a pedido. **La cabecera es correcta y el detalle no.**
Muchas filas del detalle salen con el codigo interno del pedido en vez de su KNT y con valor $0.

Medido en produccion el 2026-09-19 sobre el corte del 14 al 17 de septiembre
(`stl-1789686589616-driver-driver-1778271901513`, 185 pedidos, 169 con efectivo):

El detalle pinta las **185** filas. De ellas, **82 salen en $0 por dos motivos distintos que el
domiciliario no puede distinguir**:

| | Filas | Efectivo |
|---|---:|---:|
| Cabecera del corte (correcta) | — | $14.167.490 |
| Filas con valor visible | 103 | $8.205.000 |
| **Filas en $0 porque el pedido no esta descargado** | **66** | **$6.082.490** |
| **Filas en $0 porque su importe a favor se trunca** | **16** | **−$120.000** |

**La causa es de pantalla, no de dinero.** El navegador solo descarga los pedidos cerrados de los
ultimos seis dias, y esa ventana corta por fecha de **creacion**. Un pedido creado el 11 de
septiembre y entregado el 17 queda fuera de la descarga aunque su cierre sea reciente. El detalle
del corte resuelve cada fila buscando el pedido entre los descargados; si no lo encuentra, escribe
cero.

Existe ya un mecanismo que rescata por id los pedidos que hacen falta para el dinero, pero se
alimenta **solo de los movimientos que aun no entraron en ningun corte**. Los pedidos que salen en
cero son exactamente los contrarios: los que **si** estan en un corte. El rescate pide la mitad
equivocada.

**El dano real no es que falte plata: es que sobra.** El 2026-09-19 el domiciliario reclamo seis
pedidos de DANDA (KNT-005077, KNT-005058, KNT-004892, KNT-005064, KNT-005054, KNT-005060) porque en
su corte salian en $0. Esos seis estaban contados por $533.400 y ya cubiertos por sus abonos. De
haber cuadrado contra la pantalla, habria pagado dos veces.

**La segunda causa es independiente de la descarga.** Dieciseis de esos 185 pedidos son visitas donde
no se cobro nada —fallidos y prepago— por las que aun asi se le pagan $120.000. Ese pago **si** baja
lo que debe entregar, asi que su fila vale **−$8.000**, no cero; pero el calculo la trunca en cero.
Mientras se trunque, la lista no podria sumar la cabecera aunque todos los pedidos estuviesen
descargados. Esas 16 filas no hay que añadirlas: ya se pintan, solo hay que dejar de aplastarlas.

**Objetivo:** que el detalle de un corte sume exactamente lo que dice su cabecera, y que ninguna fila
muestre $0 ni un identificador interno.

**Ambito:** solo la pantalla del lider logistico (`driver`) y su exportacion a Excel. El admin ve el
mismo corte por otra via, que se deriva de la wallet y no de los pedidos descargados, y no presenta
este fallo.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** domiciliario **quiero** que el detalle de mi corte sume exactamente lo
  mismo que su cabecera **para** poder cuadrar el efectivo con una calculadora sin pagar dos veces.
- **HU_02 (interfaz):** **Como** domiciliario **quiero** ver el codigo KNT y el valor de cada pedido de
  mi corte, por antiguo que sea **para** reconocer cual entregue y cuando.
- **HU_03 (interfaz):** **Como** domiciliario **quiero** ver tambien las visitas por las que no cobre
  nada y lo que se me paga por ellas **para** entender por que entrego menos de lo que recaude.
- **HU_04 (sin interfaz):** **Como** responsable de la plataforma **quiero** que una diferencia
  inexplicada entre cabecera y detalle sea imposible **para** no arbitrar reclamos a mano contra la
  base de datos.

## 3. Requisitos funcionales (EARS + RFC 2119)

### El detalle cuadra con la cabecera

- **RF_01 (ubicua):** El sistema MUST mostrar, en el detalle de un corte de domiciliario, **una fila por
  cada pedido del corte**, incluidas las visitas sin cobro, con su codigo de seguimiento, su recaudo, el
  pago al domiciliario y el efectivo a entregar.
- **RF_02 (ubicua):** El efectivo a entregar de una fila MUST ser su recaudo menos el pago al
  domiciliario por ese pedido, **sin truncarse en cero**. Una fila sin recaudo MUST presentarse como
  importe a favor del domiciliario.
- **RF_03 (ubicua):** La suma del efectivo a entregar de todas las filas del detalle MUST ser igual al
  efectivo esperado de la cabecera del corte. No se admite termino correctivo ni diferencia residual.
- **RF_04 (ubicua):** El sistema MUST distinguir visualmente las filas sin recaudo de las filas con
  recaudo, de modo que no se confundan con entregas cobradas.

### Los pedidos que el detalle necesita

- **RF_05 (evento):** **Cuando** un domiciliario abre el **detalle de un corte**, el sistema MUST
  obtener los pedidos referidos por ESE corte que no esten ya descargados; y **cuando** abre su
  informacion financiera, MUST obtener los referidos por movimientos aun sin liquidar.
- **RF_06 (ubicua):** El sistema MUST pedir esos pedidos de uno en uno, de modo que un identificador
  ajeno, borrado o inexistente no impida recuperar los demas.
- **RF_07 (ubicua):** El sistema MUST pedir cada identificador una sola vez por carga de pagina y MUST
  respetar el tope de pedidos rescatados vigente.
- **RF_08 (estado):** **Mientras** queden pedidos del corte por llegar, el sistema MUST indicar que el
  detalle se esta completando y MUST NOT presentar su suma parcial como definitiva.

### Ninguna fila miente

- **RF_09 (error):** **Si** un pedido de un corte no se puede recuperar, el sistema MUST mostrar su fila
  con el importe que el propio corte guarda para ese pedido, MUST rotularla como pedido no disponible y
  MUST NOT mostrarla con valor cero.
- **RF_10 (ubicua):** El sistema MUST mostrar el codigo de seguimiento de cada pedido. **Si** no se
  dispone de el, MUST usar un rotulo explicito de no disponible; en ningun caso MUST usar el
  identificador interno del documento como etiqueta visible.
- **RF_11 (error):** **Si** la suma del detalle no coincide con la cabecera, el sistema MUST mostrar la
  diferencia con su motivo —detalle aun incompleto, o ajustes posteriores al corte (RF_12)— y MUST
  seguir presentando la cabecera como la cifra que se liquida.
- **RF_12 (evento):** **Cuando** un pedido del corte haya sido corregido despues de emitirse el corte,
  el sistema MUST reflejar en el detalle el valor vigente del pedido y MUST presentar la diferencia
  contra la cabecera como ajuste posterior, nunca como detalle incompleto.
- **RF_13 (ubicua):** La exportacion a Excel del corte MUST contener las mismas filas e importes que la
  pantalla, con el mismo rotulo para las filas no disponibles.

## 4. Requisitos no funcionales

- **RNF_01 (rendimiento):** El rescate de pedidos MUST NOT retrasar el primer pintado: la cabecera y los
  totales se muestran con lo que ya hay y el detalle se completa despues. Se verifica con
  `localStorage.setItem("kentro-perf","1")` contra la linea base de `docs/rendimiento.md`, con margen de
  ±10 %.
- **RNF_02 (rendimiento):** Las lecturas adicionales MUST contarse sobre el total acumulado de la sesion
  y MUST mantenerse dentro del tope de pedidos rescatados vigente, compartido con el rescate ya
  existente. Referencia medida: el corte del 14 al 17 de septiembre necesita 66 lecturas.
- **RNF_03 (interfaz):** El aviso de detalle incompleto, el rotulo de no disponible y la distincion de
  las filas sin recaudo MUST cumplir los tokens y contrastes de `docs/design-system.md`.
- **RNF_04 (compatibilidad):** El cambio MUST funcionar en el objetivo de navegadores declarado en
  `package.json`, sin subirlo.

## 5. Casos limite

- **Pedido borrado o reasignado.** Un identificador que ya no existe o dejo de pertenecer al
  domiciliario no tumba el resto del detalle (RF_06) y su fila sale con el importe guardado en el corte
  y el rotulo de no disponible (RF_09).
- **Lectura fallida por red o permiso.** Cuenta como no disponible para esa carga de pagina, no se
  reintenta en bucle, y **si** se reintenta en la siguiente carga: el tope de RF_07 es por carga de
  pagina, no permanente.
- **Corte con mas pedidos fuera de ventana que el tope.** El detalle queda incompleto a proposito, lo
  avisa (RF_08, RF_11) y no presenta su suma parcial como buena.
- **Varios cortes en pantalla.** El domiciliario tiene 35 cortes historicos. Solo se rescatan los
  pedidos de los cortes que la pantalla esta mostrando, no los de todos.
- **Pedido ya descargado o ya rescatado por la otra via.** No se pide otra vez (RF_07).
- **Corte sin importes guardados por pedido.** Los 35 cortes actuales los tienen; si alguno no los
  tuviera, la fila no disponible se rotula sin importe y cuenta como detalle incompleto (RF_11).
- **Las 16 visitas sin cobro del corte medido.** Aparecen como filas a favor del domiciliario por
  $120.000 en total, y son las que hacen que la suma pase de $14.287.490 a los $14.167.490 de la
  cabecera (RF_01, RF_02, RF_03).

## 6. Fuera de alcance

- **El eje de fecha del listado de pedidos.** Que la lista de tienda y de admin filtre por fecha de
  creacion en vez de por fecha de entrega es un fallo real, medido el mismo dia (442 de 442 cierres de
  septiembre caen en un dia distinto al de creacion; filtrar DANDA por "17 de septiembre" devuelve 0 de
  70). Tiene su propia spec.
- **Cambiar el tamano o el eje de la ventana de descarga.** Aqui solo se rescata por id lo que falta.
- **Cambiar como se calcula un corte**, como se reparten los abonos entre pedidos, o reescribir un corte
  pagado o conciliado (principio 10 de la constitucion).
- **La pantalla del admin y la del mensajero.** El admin deriva el mismo corte de la wallet y no
  presenta el fallo; el mensajero no tiene detalle de corte.
- **El valor corrupto de KNT-003174.** Se trata aparte.

## 7. Definition of Done

1. Una prueba automatizada demuestra, con las cifras reales del corte del 14 al 17 de septiembre, que
   la suma del efectivo a entregar de las 185 filas es exactamente $14.167.490.
2. Una prueba demuestra que las 16 filas sin recaudo aparecen como importe a favor y suman −$120.000.
3. Ninguna fila muestra $0 por ausencia del pedido, y ninguna muestra un identificador interno como
   etiqueta.
4. Una prueba falla si el rescate de pedidos vuelve a alimentarse unicamente de los movimientos sin
   liquidar.
5. Una prueba demuestra que un identificador inexistente no impide recuperar los demas y que su fila
   sale con el importe guardado en el corte.
6. Una prueba demuestra que un pedido corregido tras el corte se presenta como ajuste posterior y no
   como detalle incompleto (RF_12).
7. La exportacion a Excel coincide fila a fila con la pantalla (RF_13).
8. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
9. Verificacion real contra produccion con una sesion de lider logistico creada para la prueba (usuario
   desechable + `signInWithPassword` REST con la API web key de `src/lib/firebase/client.ts`, segun
   `CLAUDE.md`): el detalle del corte del 14 al 17 de septiembre muestra sus 185 filas, los seis pedidos
   de DANDA aparecen con su importe y la suma coincide con la cabecera.
10. Medicion de RNF_01 registrada en `docs/rendimiento.md`.
11. El responsable de la plataforma firma la entrega.

## 8. Decisiones del responsable (2026-09-19)

1. **Las visitas sin cobro se ven en la lista.** Las 16 filas de fallidos y prepago aparecen con el pago
   que generan a favor del domiciliario, en vez de resumirse en una linea al final. Consecuencia
   buscada: la lista pasa de 169 a 185 filas y su suma iguala la cabecera sin termino correctivo, lo que
   elimina la contradiccion que `sdd-skeptic` señalo entre RF_02 y el Definition of Done del borrador.
2. **El detalle muestra lo que vale hoy, no una foto del dia del corte.** Si una correccion posterior
   cambia un pedido, el detalle refleja el valor vigente y la diferencia contra la cabecera se presenta
   como ajuste posterior (RF_12). La cabecera sigue siendo la cifra que se liquida, porque un corte
   pagado o conciliado no se reescribe.

Preguntas de `sdd-skeptic` y donde quedan resueltas:

| # | Pregunta | Resolucion |
|---|---|---|
| 1 | Igualdad con termino correctivo vs igualdad pura; 53/66/69 filas | Decision 1: igualdad pura (RF_03). Cifra corregida: **66** filas rotas de 169 |
| 2 | Que dispara el aviso si la suma nunca iguala | Ya iguala. El aviso cuelga de pedidos por llegar o de ajuste posterior (RF_08, RF_11, RF_12) |
| 3 | RF_08 y RF_10 incompatibles | El corte guarda el importe por pedido (los 35 lo tienen): la fila lleva importe real y rotulo explicito (RF_09, RF_10) |
| 4 | Fallo vs "aun no llega"; que es sesion | El tope es **por carga de pagina** y se reintenta en la siguiente (RF_07, caso limite 2) |
| 5 | "Sus cortes" vs "los mostrados"; presupuesto | Solo los mostrados (RF_05). Presupuesto acumulado por sesion (RNF_02); RNF_01 con linea base medida |
| 6 | Correcciones; que roles | Decision 2 (RF_12). Ambito: solo `driver` y su Excel; admin y mensajero fuera (seccion 6) |

### Enmiendas posteriores

**E1 (2026-09-19, tras la auditoria de trazabilidad) — RF_05 dice ahora "al abrir el detalle de un
corte", no "al abrir su informacion financiera".** El borrador pedia rescatar los pedidos de *todos*
los cortes que la pantalla muestra. Al implementarlo se vio que son seis cortes por pagina y hasta
1.110 lecturas contra un tope de 800, y que ninguna cifra de cabecera las necesita: salen de
`settlement.cashPendingCop`, nunca de `orders[]`. Se rescata al expandir. La guarda
`RNF_02 · no pide los pedidos de la pagina entera de cortes` fija lo contrario de la lectura literal
del borrador, asi que el texto se corrige para que requisito y prueba no se contradigan.

## 9. Historial de cambios

- **2026-09-19:** redaccion inicial, a partir del reclamo del domiciliario del mismo dia y de la
  medicion contra produccion del corte `stl-1789686589616-driver-driver-1778271901513`.
- **2026-09-19:** revision adversarial (`sdd-skeptic`) y reescritura con las dos decisiones del
  responsable. Correcciones de hecho: las filas rotas son 66, no 69; el admin no presenta el fallo.
- **2026-09-19:** aprobada. Correccion de hecho detectada al planificar: el detalle **ya pinta las 185
  filas** (mapea `settlement.orderIds`, no las 169 con efectivo). Las 16 visitas sin recaudo no hay que
  añadirlas; salen en $0 porque su importe a favor se trunca. RF_01 se cumple quitando el truncamiento.
