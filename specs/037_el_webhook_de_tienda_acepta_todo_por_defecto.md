# Spec 037: La conexion de una tienda nueva acepta todos sus productos, y la pantalla lo dice

- **Estado:** aprobada
- **Autor:** Claude (incidente Infinito, 2026-11-06)
- **Fecha:** 2026-11-06
- **Aprobada por:** el responsable, 2026-11-06 ("Aprobar y seguir"), sobre el borrador del mismo dia.
- **Origen:** pedido del responsable: "haz que eso aplique para todas las tiendas, a menos que ellas
  explicitamente configuren eso, pero solo para las nuevas y que eso sea visible y claro en la plataforma".

## 1. Contexto y objetivo

Una tienda que conecta su Shopify a Kentro por la URL de sincronizacion recibe, sin pedirlo, un filtro de
productos: solo entran los pedidos cuyos productos o etiquetas llevan la marca "ADMA". Ese filtro nacio para las
tiendas de la comunidad ADMA y se quedo como valor por defecto para todas. Se aplica antes que el de ciudad, y no
deja rastro visible: la pantalla de la tienda lo muestra como un dato ("SKU contiene ADMA"), no como algo que
descarta pedidos.

**Lo que costo (medido en produccion el 2026-11-06):** Infinito conecto su tienda el 2026-10-05. En un mes Kentro
recibio 3.608 avisos de su Shopify y los descarto todos por ese filtro: 153 pedidos distintos de Cali, entre
ellos #10133 (confirmado por el cliente el 4-nov) y #10165. La tienda concluyo que "Kentro no deja crear
pedidos" y estuvo a punto de despacharlos por otro operador. Se corrigio a mano: se abrio su filtro y se
reenviaron los dos pedidos (KNT-008290, KNT-008291).

**La trampa que haria volver el fallo:** el boton con que la tienda regenera su conexion vuelve a poner el filtro
"ADMA" aunque la tienda no lo haya pedido. Si Infinito lo pulsa hoy, deja de recibir pedidos otra vez, en
silencio.

**Objetivo:** una tienda que se conecta desde ahora recibe todos sus pedidos de la ciudad cubierta salvo que ella
pida un filtro; las tiendas ya conectadas no cambian; nadie pierde su filtro sin pedirlo; y la pantalla dice, en
una frase, que entra y que se descarta.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** tienda que conecta su Shopify **quiero** que entren todos mis pedidos de Cali
  sin configurar nada, y ver en mi pantalla que es asi, **para** no descubrir un mes despues que se estaban
  perdiendo.
- **HU_02 (interfaz):** **Como** tienda que solo quiere mandar a Kentro una parte de sus productos **quiero**
  elegir el filtro a proposito y ver que pedidos va a descartar **para** que el filtro sea una decision mia y no
  un valor heredado.
- **HU_03 (interfaz):** **Como** administrador de Kentro **quiero** ver, por cada tienda conectada, si filtra
  productos y cuantos pedidos le descarto el filtro en la ultima semana **para** detectar una tienda mal
  conectada antes de que la tienda se queje.
- **HU_04 (sin interfaz):** **Como** tienda ya conectada **quiero** que mi filtro actual siga igual **para** que
  este cambio no me haga entrar pedidos que no queria.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** una tienda genera su conexion por primera vez sin escribir un filtro, el sistema
  MUST dejarla aceptando todos sus productos.
- **RF_02 (evento):** **Cuando** una tienda ya conectada regenera su conexion sin tocar el filtro, el sistema MUST
  conservar el filtro que tenia y MUST NOT reponer "ADMA".
- **RF_03 (ubicua):** El sistema MUST conservar el comportamiento de todas las conexiones que existen hoy; ninguna
  cambia de filtro por esta spec. Una conexion antigua sin filtro guardado MUST seguir filtrando por "ADMA", que
  es lo que hace hoy.
- **RF_04 (ubicua):** La pantalla de conexion de la tienda MUST explicar el filtro con una frase:
  - si acepta todo: "Entran todos tus productos. Solo se descartan pedidos fuera de [ciudades cubiertas].";
  - si filtra: "Solo entran pedidos con un producto cuyo SKU contenga X o con la etiqueta Y. Los demas se
    descartan.";
  y MUST mostrar el filtro que el sistema aplica de verdad, no uno supuesto.
- **RF_05 (evento):** **Cuando** la tienda quiere cambiar el filtro, el sistema MUST ofrecer dos opciones
  explicitas, "Todos mis productos" y "Solo productos cuyo SKU contenga...", y MUST mostrar la frase resultante
  antes de guardar.
- **RF_06 (ubicua):** La lista de conexiones del administrador MUST mostrar la misma frase por tienda.
- **RF_07 (estado):** **Mientras** una conexion tenga pedidos descartados por el filtro de productos en los
  ultimos 7 dias, la pantalla de la tienda y la lista del administrador SHOULD mostrar cuantos fueron.
- **RF_08 (ubicua):** La instruccion "para sincronizar un pedido viejo, agrega la etiqueta X" MUST mostrarse solo
  si la conexion filtra por etiqueta; si acepta todo, MUST decir que basta con guardar el pedido en Shopify.
- **RF_09 (error):** **Si** la tienda escribe un filtro vacio o solo con espacios, el sistema MUST tratarlo como
  "Todos mis productos" y MUST decirlo en la frase antes de guardar.

## 4. Requisitos no funcionales

- **RNF_01:** El valor por defecto de una conexion nueva se decide en un solo sitio, en el servidor. Una guarda
  automatica MUST fallar si la pantalla vuelve a mandar "ADMA" como relleno.
- **RNF_02:** El filtro de ciudad no cambia: sigue decidiendo que pedidos entran por cobertura.
- **RNF_03:** Contar los descartados de la semana no debe bajar al navegador los avisos descartados; se cuenta
  en el servidor (regla de la casa: agregar en servidor, no descargar).

## 5. Casos limite

- La tienda pulsa "Actualizar" dos veces seguidas: el filtro queda igual las dos veces.
- Una conexion antigua sin filtro guardado (Kovia, DANDA): la pantalla dice "SKU contiene ADMA", que es lo que el
  sistema aplica; no se inventa "todos".
- Una conexion mixta (Bella Mujer: SKU todos, etiqueta ADMA): acepta todo, porque basta con que se cumpla una de
  las dos; la frase MUST decir que acepta todo.
- Una tienda escribe "adma" en minusculas: se guarda y se muestra en mayusculas, como hoy.
- Con todo aceptado, un pedido viejo de Cali que la tienda edita en Shopify entra a Kentro como pedido nuevo sin
  confirmar. Se puede borrar sin consecuencias de dinero. La frase de la tarjeta lo advierte.

## 6. Fuera de alcance

- Cambiar el filtro de las tiendas ya conectadas (el responsable lo pidio "solo para las nuevas").
- Recuperar los otros 151 pedidos viejos de Cali de Infinito: casi todos ya salieron por otro operador.
- Dejar de recibir los avisos de "cliente creado" que manda el Shopify de Infinito (ruido inofensivo).
- Las tiendas conectadas por la app de Shopify (Kovia, DANDA): usan otra via de entrada.

## 7. Definition of Done

1. Pruebas automatizadas de RF_01, RF_02, RF_03, RF_09 y de la guarda de RNF_01, en verde.
2. `npm test`, `npx tsc --noEmit` (raiz y funciones) y `npm run lint` sin errores.
3. Capturas de la pantalla de la tienda y de la lista del administrador con: todo aceptado, filtro ADMA, conexion
   sin filtro guardado, y con descartados en la semana; movil 375 y escritorio 1280.
4. En produccion: pulsar "Actualizar" como Infinito deja su conexion aceptando todo.
5. El responsable valida el resultado.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-11-06 | Borrador inicial | Infinito: un mes de pedidos descartados por el filtro ADMA por defecto |
| 2026-11-06 | Reescrita al formato de la plantilla (historias, casos limite) y aprobada | "Aprobar y seguir" del responsable |
