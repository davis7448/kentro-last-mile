# Spec 011: Un dato ausente no puede tumbar una escritura entera

- **Estado:** borrador
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-15
- **Prioridad:** segunda de las tres specs nacidas del incidente del webhook; es una decision de diseno, no
  un parche, y por eso no se hizo de urgencia

## 1. Contexto y objetivo

El webhook de Shopify cayo cuatro dias porque al guardar un pedido de una tienda sin comunidad dos campos iban
"sin valor", y la base de datos no ignora un campo sin valor: **rechaza el documento entero**. La plataforma
ya lo sabia —tiene una funcion que limpia esos campos antes de guardar y la usan la mayoria de las escrituras—
pero esa limpieza es responsabilidad de cada sitio que escribe, y dos sitios no la hicieron.

Hoy la regla se cumple por disciplina: cada persona que escribe un documento tiene que acordarse. La guarda que
se anadio tras el incidente vigila las seis rutas de creacion de pedidos, pero **no vigila ninguna otra
escritura**: el mismo tipo de fallo puede repetirse en cortes, movimientos, tiendas o comunidades, con el mismo
silencio.

**Objetivo:** decidir, de una vez y para toda la plataforma, que pasa con un dato ausente al guardar, y que esa
decision no dependa de que cada escritura se acuerde.

Hay dos caminos y esta spec existe para elegir uno con los ojos abiertos:

- **Ignorar los campos sin valor en toda la plataforma.** Ninguna escritura vuelve a fallar por esto. El precio:
  un campo que alguien olvido rellenar **desaparece sin ruido**, y un documento puede quedar sin un dato que
  deberia tener.
- **Mantener el rechazo y hacer obligatoria la limpieza.** El fallo sigue siendo ruidoso —que es una virtud—,
  pero hay que garantizar que ninguna escritura se salta la limpieza, con una comprobacion que no dependa de
  la memoria de nadie.

## 2. Historias de usuario

- **Como** responsable de la plataforma **quiero** que un pedido valido nunca se pierda por un detalle de
  formato interno **para** no volver a estar cuatro dias sin pedidos.
- **Como** responsable de la plataforma **quiero** enterarme cuando un documento se guarda sin un dato que
  deberia llevar **para** que "no falla" no signifique "falta informacion en silencio".
- **Como** quien mantiene el codigo **quiero** una sola regla, aplicada en un solo sitio, **para** no tener que
  acordarme en cada escritura nueva.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El sistema MUST aplicar una unica politica ante un dato ausente al guardar, la misma en
  todas las escrituras, decidida y escrita en esta spec antes de implementar nada.
- **RF_02 (ubicua):** Sea cual sea la politica, un pedido, un movimiento de dinero o un corte con todos sus
  datos obligatorios presentes MUST guardarse aunque falte un dato opcional.
- **RF_03 (ubicua):** Si la politica es ignorar los campos sin valor, el sistema MUST seguir rechazando la
  escritura cuando falte un dato **obligatorio** para ese documento (por ejemplo, un pedido sin tienda o un
  movimiento sin importe). Ignorar no puede convertirse en aceptar cualquier cosa.
- **RF_04 (ubicua):** Si la politica es mantener el rechazo, el sistema MUST comprobar de forma automatica que
  **toda** escritura pasa por la limpieza, no solo las seis rutas de pedidos, y esa comprobacion MUST fallar
  al anadir una escritura nueva que no la haga.
- **RF_05 (evento):** **Cuando** una escritura se rechace por un dato ausente, el sistema MUST dejar constancia
  con el nombre del documento y del campo, de forma que la spec 010 pueda avisar.
- **RF_06 (ubicua):** El comportamiento de todo lo que hoy funciona MUST NOT cambiar: los documentos que hoy
  se guardan bien MUST guardarse igual, campo a campo.

## 4. Requisitos no funcionales

- **RNF_01:** La decision MUST quedar escrita en la constitucion del proyecto como principio, con el incidente
  que la motivo, para que nadie la revierta sin saber por que existe.
- **RNF_02:** La comprobacion de RF_03 o RF_04 MUST ejecutarse en cada cambio, sin red.

## 5. Casos limite

- **Un campo anidado sin valor** (un objeto dentro del documento con un campo vacio): MUST tratarse igual que
  uno de primer nivel. Hoy un caso asi ya tumbo una escritura de inventario y esta documentado en el codigo.
- **Un campo con valor nulo explicito**: no es "ausente"; es un valor. La politica no lo toca.
- **Una lista con un elemento sin valor**: decidir si se limpia el elemento o se rechaza la lista; hoy no esta
  definido.
- **Escrituras parciales** (actualizar solo algunos campos): un campo ausente MUST NOT borrar el valor que ya
  habia.

## 6. Fuera de alcance

- La alerta (spec 010) y la prueba del webhook (spec 012): son sus propias specs.
- Cambiar que datos son obligatorios en cada documento: esta spec usa los que hoy existen.

## 7. Definition of Done

1. La politica elegida esta escrita en la constitucion con su motivo.
2. Cada RF tiene prueba que pasa; la de RF_03/RF_04 falla de verdad al introducir una escritura que viole la
   politica (se demuestra con una prueba de mutacion).
3. Se reproduce la escritura que tumbo el webhook y se comprueba que con la politica nueva el pedido se guarda.
4. Comparacion campo a campo de una muestra de documentos reales antes y despues (RF_06): identicos.
5. El humano valido el resultado y aprobo la entrega.

## 8. Decisiones pendientes del responsable

**Cual de los dos caminos.** Recomendacion: **mantener el rechazo y hacer obligatoria la limpieza** (RF_04).
Motivo: en una plataforma que mueve dinero, un fallo ruidoso que se ve —con la spec 010 avisando— es mejor que
un dato que desaparece sin ruido y se descubre al cuadrar un corte. El coste es una comprobacion automatica
que hoy no existe; el beneficio es que el silencio no vuelve a ser una opcion.

## 9. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-15 | Borrador inicial | Incidente del webhook: la limpieza de campos sin valor dependia de cada escritura, y dos no la hacian |
