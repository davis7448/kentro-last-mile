# Spec 038: Que cada recaudo se le cobre al domiciliario una sola vez

- **Estado:** aprobada (2026-11-08, por el responsable de la plataforma, tras el grill); **enmendada el 2026-11-10**
  tras la verificacion (RF_01b, RF_11, RF_11b; ver §8)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-11-07
- **Origen:** el responsable pregunto por que la auditoria de efectivo del domiciliario mostraba cerca de
  $600.000 de diferencia en cortes viejos ya cerrados. La investigacion (solo lectura, 2026-11-07) encontro
  que los cortes le cobraron de mas. Hallazgo secundario de la revision del PR #7 (specs 027 y 036).
- **Prioridad:** alta — es plata del domiciliario retenida por la plataforma, y cada correccion nueva de
  entregado a fallido la sigue reteniendo
- **Base:** se escribe sobre `cf35c89` (specs 027 y 036, ya desplegadas, PR #7 sin mergear)
- **Accesibilidad:** sin interfaz nueva (cambia cifras que ya se muestran)
- **Medicion:** `specs/038_measure.js` (solo lectura contra produccion, credenciales ADC)

## 1. Contexto y objetivo

El efectivo que un domiciliario debe entregar en un corte se calcula pedido a pedido como *recaudo del
pedido − lo que el domiciliario gana por el*. El problema es **de donde** salen esas dos cifras: se suman
**todos** los movimientos de recaudo y **todos** los pagos del pedido que existen hoy, sin mirar cuales ya
cobro un corte anterior. Cuando un pedido aparece en dos cortes, el segundo vuelve a cobrar (o a descontar)
lo que el primero ya cobro.

Pasa en tres situaciones reales:

1. **Correccion de entregado a fallido despues de un corte pagado.** La regla 1 del planificador de
   correcciones (no tocar el corte cerrado, compensar en el periodo abierto) es correcta, pero la reversa
   del recaudo se netea contra el recaudo original *dentro del corte nuevo*: el pedido queda en 0 y el
   corte nuevo solo le quita al domiciliario su pago (+$11.000). Los $78.900 que el ya entrego por ese
   pedido **nunca se le devuelven**.
2. **Correccion que borra el recaudo.** Si el corte de la tienda seguia pendiente, la correccion borra el
   movimiento de recaudo en vez de revertirlo. El corte del domiciliario que ya lo cobro queda cerrado y
   ningun calculo posterior ve que ese dinero ya se le pidio.
3. **Un pedido en dos cortes por otro motivo.** KNT-002682: visita fallida el 2026-07-28 (su pago entro al
   corte del 07-30), entregado el 07-30 por la tarde (su pago entro al corte del 07-31). El corte del 07-30,
   recalculado al conciliarse, ya incluyo el recaudo nuevo; el del 07-31 lo cobro otra vez. **$93.900 dos
   veces.**

El mismo defecto funciona al reves con los pagos: una visita fallida de $8.000 descontada en un corte se
vuelve a descontar en el siguiente corte del mismo pedido, y el domiciliario se queda $8.000 de mas.

### Medicion (2026-11-07, `node specs/038_measure.js driver-1778271901513`)

Dos domiciliarios, 60 cortes. El segundo (`driver-1784251215977`, 2 cortes) cuadra al peso. El primero:

| Cifra | Valor |
|---|---|
| Cortes | 58 (57 cerrados, 1 pendiente del 2026-11-07) |
| Pedidos distintos en sus cortes | 4.754 |
| Efectivo pedido por los cortes (Σ `cashExpectedCop`) | $405.281.133 |
| Efectivo que justifican los movimientos de hoy (Σ por pedido unico de recaudo − pago) | $404.586.931 |
| **Diferencia** | **$694.202** |
| Suma de las diferencias pedido a pedido | $694.200 (16 pedidos; los $2 son redondeo del 4x1000) |
| Cortes cuya reconstruccion no cuadra con lo guardado | 0 de 58 |
| Pedidos con recaudo nuevo tras un corte saldado (riesgo de RF_08) | 0 |

Lo cobrado a cada pedido en cada corte se toma de la asignacion guardada en el propio corte; sin asignacion
se reconstruye con los movimientos que existian en el ultimo recalculo de ese corte. Las 58 reconstrucciones
cuadran con el efectivo esperado guardado, asi que la tabla de abajo **explica entera** la diferencia.

| Pedido | Hoy | Cobrado | Debido | Diferencia | Causa |
|---|---|---:|---:|---:|---|
| KNT-000262 | fallido | 109.900 | 0 | **+109.900** | 1 (corte 06-12; un script viejo lo recalculo ya conciliado) |
| KNT-002682 | entregado | 187.800 | 93.900 | **+93.900** | 3 (cortes 07-30 y 07-31) |
| KNT-007828 | fallido | 81.900 | −8.000 | **+89.900** | 2 (corregido hoy 2026-11-07, aun sin corte nuevo) |
| KNT-003259 | fallido | 78.900 | 0 | **+78.900** | 1 |
| KNT-003837 | fallido | 78.900 | 0 | **+78.900** | 1 |
| KNT-003827 | fallido | 78.900 | 0 | **+78.900** | 1 |
| KNT-004540 | fallido | 78.900 | 0 | **+78.900** | 2 |
| KNT-006258 | fallido | 78.900 | 0 | **+78.900** | 1 |
| KNT-005724 | entregado | 19.000 | −8.000 | **+27.000** | recaudo revertido al cambiar de tienda (ver §5) |
| KNT-006347 | entregado | 19.000 | −8.000 | **+27.000** | idem |
| KNT-002965 | fallido | −24.000 | −16.000 | −8.000 | pago de visita descontado dos veces |
| KNT-003316 | entregado | 113.900 | 121.900 | −8.000 | idem |
| KNT-003387 | entregado | 65.900 | 73.900 | −8.000 | idem |
| KNT-003493 | fallido | −24.000 | −16.000 | −8.000 | idem |
| KNT-006650 | entregado | 73.900 | 81.900 | −8.000 | idem |
| KNT-006722 | entregado | 73.900 | 81.900 | −8.000 | idem |
| **Total** | | | | **+694.200** | +742.200 a favor del domiciliario, −48.000 en contra |

"Cobrado" positivo = efectivo que se le pidio entregar por ese pedido; negativo = pago que se le dejo
quedarse del efectivo. "Debido" es lo mismo calculado una sola vez con los movimientos de hoy.

**Objetivo:** que un corte cobre por cada pedido solo lo que ningun otro corte le cobro ya, que devuelva lo
que ya se cobro cuando el pedido deja de deberlo, y proponer como compensar los $694.200 historicos sin
reescribir ningun corte cerrado.

## 2. Historias de usuario

- **HU_01 (sin interfaz):** **Como** domiciliario **quiero** que cada peso de recaudo se me cobre una sola
  vez **para** no entregar dos veces el mismo dinero.
- **HU_02 (sin interfaz):** **Como** domiciliario **quiero** que, si un pedido que ya pague se corrige a
  fallido, mi siguiente corte me devuelva lo que entregue por el **para** no perder ese dinero.
- **HU_03 (sin interfaz):** **Como** responsable de la plataforma **quiero** ver, antes de aprobarla, la
  compensacion de lo cobrado de mas en cortes ya cerrados **para** devolverlo sin tocar conciliaciones.
- **HU_04 (sin interfaz):** **Como** tienda **quiero** que mi recaudo no figure como recibido antes de que el
  domiciliario lo entregue **para** que la plataforma no me pague dinero que aun no tiene.

## 3. Requisitos funcionales (EARS + RFC 2119)

### Una sola vez

- **RF_01 (ubicua):** El sistema MUST cobrarle a un domiciliario cada peso de recaudo de un pedido, y
  descontarle cada peso de su pago por ese pedido, **en un solo corte**.
- **RF_01b (ubicua):** El recaudo de un pedido MUST cobrarsele **solo al domiciliario que lo entrego**: el
  `driverId` actual del pedido. Si el pedido tiene asignado a **otro** domiciliario, a este solo se le cuenta su
  propio pago (lo debido es `−pago`); si el pedido no esta o no tiene `driverId`, el recaudo cuenta como hoy (sin
  dato no se devuelve dinero). *(Verificacion 2026-11-10, hallazgo H1: la regla atribuia el recaudo a cualquier
  domiciliario con el pedido en un corte, y una visita fallida de D1 seguida de la entrega de D2 le cobraba el
  recaudo a los dos. Medido ese dia: 0 pedidos en cortes de dos domiciliarios y 0 con un `driverId` distinto del
  de su corte, asi que no cambia ninguna cifra medida.)*
- **RF_02 (evento):** **Cuando** se calcule el efectivo que un corte de domiciliario espera por un pedido,
  el sistema MUST tomar *lo que el pedido debe hoy* (recaudo − pago del domiciliario, con los movimientos
  vigentes) y restarle *lo que los demas cortes de ese domiciliario ya registraron para ese pedido*. Esa
  diferencia es lo que el corte cobra por el pedido.
- **RF_03 (ubicua):** Cada corte de domiciliario MUST dejar registrado, pedido a pedido, lo que cobro en su
  ultimo calculo, **incluidos** los pedidos que cobran 0 o un valor negativo (pago sin recaudo, devolucion).
  Ese registro es la fuente de "ya cobrado" de RF_02; no se deduce de los movimientos, porque una correccion
  puede borrarlos despues (causa 2).
- **RF_04 (estado):** **Mientras** un corte este pagado o conciliado, el sistema MUST NOT cambiar su
  registro de RF_03 ni sus cifras. Lo que haya que corregir se cobra o se devuelve en un corte abierto
  (constitucion, principio 10).
- **RF_04b (error):** **Si** los registros de RF_03 de los otros cortes del domiciliario cambiaron entre que
  se leyeron y que se guarda el recalculo de un corte, el sistema MUST rechazar ese recalculo sin escribir
  nada y decirle al administrador que lo reintente. Una prueba MUST simular dos recalculos cruzados.
  *(Grill 4, decidido por el responsable el 2026-11-07.)*
- **RF_05 (ubicua):** Para cortes creados antes de esta spec, "lo ya registrado" MUST salir de la asignacion
  guardada en el corte cuando existe, y si no, de reconstruir el pedido con los movimientos que existian en
  el ultimo recalculo del corte, con la regla que `specs/038_measure.js` valido contra los 60 cortes de
  produccion. Si un corte con asignaciones no lista un pedido, ese pedido MUST contar como que no aporto
  recaudo (solo, a lo sumo, el descuento del pago).
- **RF_05b (ubicua):** Esa reconstruccion MUST vivir en **un modulo puro** (constitucion §3 y §9) que usen la
  app y el script de medicion; el script MUST NOT llevar su propia copia. Su resultado pedido a pedido para
  todos los cortes cerrados MUST guardarse **una sola vez**, antes de desplegar, como foto auditada (fecha,
  autor, cifras), y a partir de ahi "lo ya registrado" de un corte viejo sale de la foto, no de volver a
  reconstruir. Guardar la foto es una escritura en produccion: la aprueba el responsable. Las pruebas MUST
  verificar la reconstruccion **por pedido**, no solo por total de corte: contra las asignaciones guardadas
  de cada corte y contra los 16 pedidos de §1. *(Grill 6, decidido por el responsable el 2026-11-08.)*

### Devolver lo ya cobrado

- **RF_06 (evento):** **Cuando** lo que un pedido debe hoy sea menor que lo que ya se le cobro al
  domiciliario por el (reversa de recaudo, recaudo borrado por una correccion, cambio de tienda), el
  siguiente corte del domiciliario MUST devolverle la diferencia como menor efectivo esperado.
- **RF_07 (evento):** **Cuando** una correccion cambie el recaudo o el pago de un pedido que un corte cerrado
  ya cobro, el sistema MUST hacer que ese pedido entre al siguiente corte del domiciliario **aunque** el
  domiciliario no tenga movimientos nuevos de ese pedido. Hoy un pedido solo entra a un corte de
  domiciliario si este tiene un movimiento propio sin cortar; KNT-005724 y KNT-006347 nunca volvieron a
  entrar.
- **RF_08 (error):** **Si** el total que un corte debe devolver supera el efectivo que el domiciliario debe
  entregar en ese corte, el sistema MUST conservar el resto como **una linea de saldo a favor** del
  domiciliario que el siguiente corte descuenta **una sola vez**. MUST NOT perderse al redondear el esperado
  a 0. El registro de RF_03 de cada pedido MUST guardar su cifra **sin recortar** (puede ser negativa); el
  recorte a 0 solo afecta al total del corte, y lo que ese recorte deja sin pagar es exactamente el saldo a
  favor. Asi la suma de los registros pedido a pedido sigue siendo lo debido (RNF_02) y el saldo a favor no
  vuelve a nacer de los pedidos. *(Grill 1, decidido por el responsable el 2026-11-07.)* El saldo que un
  corte recibe de los demas MAY ser negativo (una deuda): si un corte pendiente reduce despues un saldo a
  favor que otro ya consumio, el siguiente corte lo cobra y no se pierde. Un corte de domiciliario a favor del
  domiciliario no se transfiere: se arrastra (0 de 60 cortes lo han estado nunca). *(Analyze, ratificado por
  el responsable el 2026-11-09.)*

### Una sola regla

- **RF_09 (ubicua):** La regla de RF_02 MUST ser la misma al crear el corte, al registrar cada abono, al
  marcarlo pagado o conciliado, en la previsualizacion de una correccion y en el informe de efectivo de la
  spec 026. Hoy la creacion del corte descuenta solo los pagos propios del corte y los abonos descuentan
  todos los pagos del pedido: son dos reglas.
- **RF_09b (ubicua):** La regla de RF_02 MUST aplicarse a **todas** las cifras del corte de domiciliario
  (recaudo, pago al domiciliario, margen, neto girado, 4x1000 y reparto de abonos pedido a pedido), no solo al
  efectivo esperado. En un mismo corte un pedido MUST NOT mostrar dos montos distintos, y el efectivo esperado
  MUST ser recaudo − pago de ese mismo corte (mas o menos el saldo a favor de RF_08). *(Grill 3, decidido por
  el responsable el 2026-11-07.)*
- **RF_10 (evento):** **Cuando** el administrador previsualice una correccion de un pedido cuyo efectivo ya
  cobro un corte cerrado, la previsualizacion MUST mostrar cuanto se le devolvera (o cobrara) al
  domiciliario en su siguiente corte, con la misma cifra que luego se aplique.

### Recaudo recibido (hallazgo de la revision del PR #7)

- **RF_11 (estado):** **Mientras** un pedido que ya entro en un corte calculado con esta spec tenga efectivo
  cobrado en un corte de domiciliario que **no** esta saldado, o tenga recaudo nuevo posterior al ultimo corte
  saldado que lo cobro **que no sume cero**, el sistema MUST NOT dar ese pedido por "efectivo recibido" para
  pagarle a la tienda o al proveedor. *(Enmienda 2026-11-10, hallazgo H2: con "ningun asiento posterior", un
  cambio que netea cero para el domiciliario —un cambio de tienda bien hecho, o entregado → fallido → entregado—
  no devolvia el pedido a ningun corte y la tienda quedaba bloqueada para siempre. Con "suma cero" el caso B5 del
  analyze sigue bloqueado: una re-entrega de 78.900 suma 78.900.)* Nunca se compara el recaudo bruto contra lo cobrado neto. En un corte saldado en total (spec
  027 RF_01), cada asignacion cuenta como cobrada entera, cubierta o no. Un pedido que solo esta en cortes
  anteriores a esta spec sigue con la regla de hoy. *(Grill 2, el 2026-11-07, eligio neto contra neto; el
  plan, el 2026-11-08, mostro que eso obliga a que el saldo de tienda, la API de tiendas y la liquidacion de
  proveedor lean los pagos del domiciliario, y el responsable eligio esta forma, que usa solo lo que esos
  sitios ya leen.)* Hoy basta con que el pedido tenga una asignacion en un corte saldado: si se corrige
  y se vuelve a entregar, su recaudo nuevo contaria como recibido antes de que el domiciliario lo entregue.
  Medido el 2026-11-07: 0 casos.
- **RF_11b (estado):** **Mientras** un pedido tenga una asignacion sin cubrir en un corte de domiciliario
  anterior a esta spec que no este saldado, el sistema MUST NOT darlo por recibido aunque tambien este en un
  corte nuevo saldado: la parte nueva de RF_11 se suma a la regla de hoy, nunca la sustituye. *(Hallazgo H3 de la
  verificacion, 2026-11-10.)*
- **RF_12 (ubicua):** RF_11 MUST seguir siendo la regla unica de "recibido" (spec 018 RF_04, spec 027
  RF_02): la usan la liquidacion de tienda y de proveedor, el saldo de tienda, la API de tiendas y el informe
  de efectivo de la 026. Un corte saldado que cobro todo el recaudo vigente del pedido MUST seguir dandolo
  por recibido exactamente como hoy (las 027 RF_01 y RF_01b no cambian).

### Compensacion de lo historico

- **RF_13 (evento):** **Cuando** el administrador pida la compensacion historica de un domiciliario, el
  sistema MUST calcularla pedido a pedido con la regla de RF_02 (no con una segunda copia) y mostrarla
  **sin escribir nada**: pedido, cobrado, debido, diferencia y el corte abierto donde entraria.
- **RF_14 (evento):** **Cuando** el responsable apruebe una compensacion previsualizada, el sistema MUST
  aplicar exactamente lo previsualizado en el periodo abierto del domiciliario y auditarlo con autor y
  motivo. MUST NOT tocar ningun corte pagado o conciliado.
- **RF_15 (ubicua):** Aplicar la compensacion dos veces, o que despues el pedido vuelva a entrar en un corte,
  MUST NOT devolverle el mismo dinero dos veces. (Con RF_02 la segunda vez la diferencia ya es 0.)
- **RF_17 (estado):** **Mientras** no se haya aprobado su compensacion (RF_14), la diferencia que un pedido
  arrastra de antes del despliegue (la que mide `specs/038_measure.js` en ese momento) MUST quedar congelada:
  la regla de RF_02 MUST NOT devolverla ni cobrarla sola aunque el pedido entre a un corte. Lo que cambie
  despues del despliegue si se corrige solo en el siguiente corte. KNT-007828 es historico (corregido antes
  del despliegue) y espera la aprobacion como los demas. *(Grill 5, decidido por el responsable el
  2026-11-07.)*
- **RF_16 (opcion):** **Donde** el responsable excluya pedidos de la compensacion (por ejemplo, los dos de
  §5 hasta aclararlos), el sistema MUST dejarlos fuera y listarlos como pendientes en la previsualizacion.

## 4. Requisitos no funcionales

- **RNF_01:** Antes de desplegar, `specs/038_measure.js` (o su sucesor en `scripts/`) MUST informar, para cada
  corte **pendiente** y para el siguiente corte de cada domiciliario, cuanto cambia su efectivo esperado con
  la regla nueva. Con RF_17 ese cambio deberia ser 0; si no lo es, la cifra la aprueba el responsable antes
  del despliegue.
- **RNF_02:** Una prueba de propiedad MUST comprobar que, despues de calcular cualquier corte, la suma de lo
  registrado por todos los cortes de un domiciliario para un pedido es igual a lo que el pedido debe hoy **mas
  su retencion de RF_17** (0 si no tiene o ya se libero), en
  secuencias de entrega, visita fallida, correccion, re-entrega, recaudo borrado y abonos parciales.
- **RNF_03:** Las cuatro causas de la tabla de §1 (reversa neteada, recaudo borrado, pedido en dos cortes,
  pago descontado dos veces) MUST existir como pruebas con las cifras reales de un pedido de cada una
  (KNT-003259, KNT-004540, KNT-002682, KNT-002965).
- **RNF_04:** Calcular un corte MUST NOT leer mas documentos que hoy salvo: los cortes del propio
  domiciliario (60 hoy); sus dos documentos de foto historica y retenciones; en la liquidacion de proveedor,
  los asientos de recaudo de los pedidos que va a pagar (para RF_11); y en una correccion, los cortes del
  domiciliario del pedido. Ninguna lectura necesita indices nuevos. Hoy ya se barren todos los movimientos de
  tiendas y domiciliarios. *(Ampliado en analyze, aprobado por el responsable el 2026-11-09.)*

## 5. Casos limite

- **Dos cortes pendientes con el mismo pedido.** Cada uno resta lo registrado por el otro en su ultimo
  calculo; el que se recalcule despues absorbe el cambio. La suma sigue siendo lo debido (RNF_02).
- **Dos recalculos casi simultaneos** (dos abonos, o un abono y una correccion). Lo cubre RF_04b: el segundo
  se rechaza y se reintenta.
- **Un recalculo sube el esperado de un corte pendiente ya abonado en parte.** Es lo que pasa hoy con
  cualquier corte pendiente: sube su pendiente y el faltante se cobra en ese corte. Un corte cerrado nunca
  sube (RF_04).
- **Corte pendiente que se recalcula despues de que el pedido entro a otro corte** (causa 3). El corte que
  ya lo cobro conserva su registro; el otro cobra solo la diferencia.
- **Recaudo borrado por una correccion** (causa 2). Lo ya cobrado sale del registro del corte, no de los
  movimientos, asi que la devolucion aparece igual.
- **El pedido cambia de domiciliario.** "Ya cobrado" es por domiciliario; el recaudo se le cobra al que
  entrega (RF_01b). Hoy no hay ningun pedido en cortes de dos domiciliarios (medido el 2026-11-07 y el
  2026-11-10); si aparece, la compensacion lo MUST listar aparte en lugar de devolverlo.
- **Visita fallida de uno y entrega de otro.** D1 cobra su pago de visita en un corte; D2 entrega. A D1 no se le
  cobra el recaudo (RF_01b): su pedido no vuelve solo a su siguiente corte. A D2 si, entero, menos su pago.
- **Un pedido entregado sin `driverId`** (lo que dejaba la reimportacion de Shopify antes de la spec 017). El
  recaudo cuenta para el domiciliario de sus cortes, como hoy: un dato que falta no devuelve dinero. Medido el
  2026-11-10: 1 pedido sin `driverId` en cortes, y no es un contraentrega entregado.
- **Cambio que netea cero despues de un corte saldado** (cambio de tienda, o entregado → fallido → entregado). El
  pedido sigue recibido (RF_11): el efectivo que se entrego no cambio.
- **KNT-005724 y KNT-006347** (pregunta para el responsable). Ambos siguen **entregados** y contraentrega.
  Una correccion del 2026-11-04 los paso de MercadoTienda a ADMA: revirtio el recaudo de $27.000 en la tienda
  vieja y movio el flete, **pero no creo el recaudo en ADMA**. Hoy ese recaudo no esta en el libro de nadie.
  Si el cliente si pago en efectivo, lo que falta es el recaudo de ADMA y al domiciliario no se le debe nada;
  si el pedido paso a prepago, se le deben $27.000 a cada uno. No se compensan hasta aclararlo (RF_16).
- **El domiciliario ya no tiene siguiente corte** (dejo la flota). RF_07 no puede meter el pedido en ningun
  corte: la diferencia MUST quedar visible en la previsualizacion de RF_13 como saldo pendiente de ese
  domiciliario, y se paga creando un corte para el.
- **Redondeo.** La diferencia total ($694.202) y la suma por pedido ($694.200) difieren en $2 del 4x1000 de
  cortes viejos; la compensacion usa la suma por pedido.
- **Cortes viejos recalculados a mano.** Los cortes del 2026-05-29 y 2026-06-12 fueron recalculados ya
  conciliados por scripts anteriores al planificador (su asignacion refleja movimientos posteriores a la
  conciliacion). Se toman como estan: son lo que se le pidio al domiciliario.

## 6. Fuera de alcance

- **Escribir la compensacion en produccion.** Esta spec construye la previsualizacion y la aplicacion; la
  aplicacion real la decide el responsable con la propuesta de §9, despues del despliegue.
- Crear el recaudo que falta en ADMA para KNT-005724 y KNT-006347: es un defecto de la correccion de cambio
  de tienda y va en su propia spec, si el responsable confirma que el cliente pago en efectivo.
- Que una correccion **revierta** el recaudo en vez de borrarlo cuando el corte de la tienda esta pendiente.
  Con RF_03 deja de importar para el domiciliario; para la tienda ya es correcto (su corte pendiente se
  recalcula).
- Cambiar como se ve un corte: la devolucion entra como menor efectivo esperado y el saldo a favor (RF_08)
  como descuento del siguiente corte; no hay pantalla nueva.
- Cortes de tienda, proveedor y lider de comunidad: no tienen este defecto (cada movimiento lleva el id de
  su corte y se cobra una vez).

## 7. Definition of Done

1. Todos los RF tienen al menos una prueba automatizada que pasa; la de propiedad de RNF_02 y los
   casos reales de RNF_03 incluidos.
2. `npx tsc --noEmit` (raiz y `functions/`), `npx vitest run` y `npm run lint` sin errores nuevos; las guardas
   `spec-018`, `spec-026` y `spec-027` siguen en verde.
3. La medicion de RNF_01 corrida contra produccion y su resultado aprobado por el responsable antes de
   desplegar functions.
4. La previsualizacion de compensacion del domiciliario `driver-1778271901513` devuelve, con la regla
   desplegada, las cifras de la tabla de §1.
5. El humano valido el resultado y aprobo la entrega. Ningun agente despliega ni escribe dinero.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-07 | Borrador con medicion pedido a pedido y propuesta de compensacion | Pregunta del responsable sobre la diferencia en cortes viejos |
| 2026-11-08 | RF_11 reescrito: "recibido" = todo cobro en cortes saldados y sin recaudo nuevo desde el ultimo | El plan mostro el costo de leer pagos del domiciliario en tienda/API/proveedor; decidido por el responsable |
| 2026-11-09 | Remedicion en T6: 686.200 (corte pendiente nuevo con KNT-007828); la retencion congela tambien lo posterior al ultimo corte de un pedido que la regla vieja no volveria a traer (KNT-005724/006347) | Datos reales; RF_17 sin cambios, el plan §3.6 se corrige para cumplirlo |
| 2026-11-09 | Analyze: RNF_02 cuenta la retencion de RF_17; RF_08 admite saldo negativo y arrastra (no transfiere) un corte a favor; RNF_04 lista las lecturas extra | Hallazgos M9 y M10 del auditor independiente; aprobados por el responsable |
| 2026-11-10 | Enmienda tras la verificacion: RF_01b (el recaudo solo al que entrega), RF_11 (lo posterior debe sumar cero), RF_11b (la regla de hoy no se sustituye) | Tres defectos de la revision independiente (H1-H3), reproducidos; aprobada por el responsable |
| 2026-11-08 | Grill: registro sin recortar + saldo a favor (RF_08), neto contra neto (RF_11), regla en todas las cifras (RF_09b), rechazo de recalculos cruzados (RF_04b), historico congelado hasta aprobar (RF_17), modulo puro + foto (RF_05b) | Seis preguntas del revisor en contexto limpio, respondidas por el responsable |

## 9. Propuesta de compensacion (para decidir, no se aplica sola)

> **Actualizacion 2026-11-09 (T6).** Produccion creo hoy un corte **pendiente** con la regla vieja que le
> devuelve 8.000 al domiciliario por KNT-007828. La diferencia de ese pedido baja de 89.900 a 81.900 y el total
> de 694.200 a **686.200** (mismos 16 pedidos). La opcion A queda en **$632.200** (686.200 − 54.000). Como el
> corte esta pendiente, al desplegar lo recalcula la regla nueva y el pedido conserva su retencion: el total
> que se le devuelve por KNT-007828 sigue siendo 89.900 entre los dos cortes. Las cifras de abajo son las del
> 2026-11-07; la que vale al aplicar es la de la previsualizacion de ese dia (RF_13).

Lo que propongo, una vez desplegado el arreglo:

1. **KNT-007828 ($89.900)**: entrara a su siguiente corte por sus movimientos nuevos del 2026-11-07, pero por
   RF_17 su devolucion queda congelada hasta que la apruebes, igual que los demas.
2. **Este y los otros 13 pedidos** entran, con la previsualizacion de RF_13, al corte abierto del domiciliario:
   - siete a su favor por $598.300 (KNT-000262, 002682, 003259, 003837, 003827, 004540, 006258);
   - seis en su contra por $48.000 (los $8.000 de visita fallida descontados dos veces).
3. **KNT-005724 y KNT-006347 ($54.000)** quedan fuera hasta que el responsable aclare la pregunta de §5.

| Opcion | Se le devuelve | Nota |
|---|---:|---|
| **A (recomendada)** — neto, puntos 1 y 2 | **$694.200 − $54.000 = $640.200** | El libro queda exacto; los $48.000 se descuentan en el mismo corte |
| B — solo lo que le favorece | $742.200 − $54.000 = $688.200 | Se perdonan los $48.000; quedan como diferencia a favor del domiciliario para siempre |
| C — A mas los dos pedidos de §5 | $694.200 | Solo si el responsable confirma que esos dos pasaron a prepago |

Recomiendo **A**: la diferencia en su contra sale del mismo defecto que la que le favorece, y perdonarla deja
la auditoria de efectivo con un descuadre permanente de $48.000 que habria que explicar cada vez.

La compensacion la aplica el responsable (o un agente con su aprobacion explicita y por escrito para ese
domiciliario y esa cifra), despues de ver la previsualizacion. Ningun corte cerrado se modifica.
