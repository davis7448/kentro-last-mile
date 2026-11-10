# Spec 023: Abrir la app no relee el histórico

- **Estado:** aprobada (fases A y B, por el responsable, 2026-11-10)
- **Autor:** Claude, a petición del responsable de la plataforma
- **Fecha:** 2026-10-01
- **Origen:** revisión de la subida del costo de Google Cloud, hecha el 2026-10-01 desde
  ADMA. Su equivalente para ADMA es la spec 053 de ADMA Inventario.

## 1. Contexto y objetivo

La base de datos cobra cada documento que se lee. En `kentro-last-mile`, las lecturas se
han duplicado mes a mes:

| Mes | Lecturas | Variación |
|---|---:|---|
| Agosto 2026 | 20,6 millones | |
| Septiembre 2026 | 40,7 millones | ×2 |
| Última semana de septiembre | 11,6 millones | en ritmo de unos 50 millones al mes |

En Kentro no las causan tareas programadas. **Siguen el uso de la app.** Lecturas por
hora del 29 de septiembre (hora de Colombia):

| Franja | Lecturas |
|---|---:|
| Noche (0–6 h) | unas 13.000 por hora, constantes |
| 10 h | **334.000** |
| 14–15 h | 107.000 – 122.000 |
| 18 h | **664.000** |
| 20 h | **226.000** |

Los picos coinciden con las horas en que el equipo abre la app: confirmaciones de la
mañana, cierres y cortes de la tarde. La causa está documentada en `docs/rendimiento.md`:

- **Abrir la app como admin descarga el libro de caja entero.** Son más de 10.452
  asientos, que crecen unos 3.700 al mes, y se vuelven a leer completos cada vez que el
  admin abre o recarga la app.
- **Abrir la app como líder logístico** descarga unos 3.235 documentos.
- **Lo que pesa es repetirlo.** Cada pestaña que se abre o se recarga vuelve a pagar la
  carga completa.

Por eso el costo crece con el histórico de la plataforma, no con el trabajo del día.

### 1.1 Línea base del 2026-11-10: el que más lee no es la app, es la API de tiendas

Medido con la misma métrica (detalle y datos crudos en `.sdd/evidence/023/baseline.md`):

- El proyecto lee **~2,5 M documentos por día hábil** (mediana 27-oct a 9-nov).
- El suelo nocturno ya no es de 13.000/h sino de **~72.000–78.000/h constantes**, unos 1,75 M/día.
- Ese suelo lo produce `GET /orders?from=&to=` de la API de tiendas (`functions/src/store-api.ts`):
  aunque pida un solo día, cada llamada lee **todos** los pedidos de la tienda, **todos** sus asientos
  y **todos** los cortes. Para DANDA son **19.148 lecturas por llamada**. Las integraciones de las
  tiendas la consultan cada hora, día y noche.
- **La API de tiendas es entre el 66 % y el 80 % de todas las lecturas.** Abrir la app es el resto,
  ~0,6–0,9 M/día.

Por eso esta spec se parte en dos fases, en este orden:

- **Fase A — la API de tiendas lee solo el rango pedido** (RF_09 a RF_12). Solo servidor, sin
  pantalla, y por sí sola debería cumplir RNF_01.
- **Fase B — abrir la app no relee el histórico** (RF_01 a RF_08). El objetivo original. Se mide de
  nuevo después de la fase A, con su propio plan, porque toca las pantallas de dinero del admin.

**Objetivo:** que lo que cuesta abrir la app dependa de lo que la pantalla muestra, no
del tamaño del histórico, sin que ninguna cifra de dinero cambie.

**Restricción heredada:** reglas de oro 6 y 7 del `CLAUDE.md` y las specs 018 y 019.
Acotar una descarga ya ha bajado saldos en silencio: $1.135.720 en el saldo «Pendiente
por entregar», y 66 filas en $0 en el detalle de un corte. Ningún ahorro puede volver a
producir una cifra de dinero menor sin aviso.

## 2. Historias de usuario

- **HU_01 (interfaz):** **Como** admin **quiero** que la app abra sin descargar el
  libro de caja entero **para** que abrirla y recargarla no multiplique la factura.
- **HU_02 (interfaz):** **Como** líder logístico, tienda o mensajero **quiero** que mi
  pantalla traiga solo lo que me muestra **para** que el costo de usar la app no crezca
  con el histórico.
- **HU_03 (sin interfaz):** **Como** responsable de la plataforma **quiero** que todas
  las cifras de dinero (saldos, cortes, liquidaciones, posición de la plataforma) den
  exactamente lo mismo que hoy **para** que el ahorro no se pague con dinero mal
  mostrado.
- **HU_04 (sin interfaz):** **Como** responsable **quiero** saber cuántas lecturas cuesta
  abrir cada rol **para** detectar una regresión antes de que llegue en la factura.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (evento):** **Cuando** el admin abre la app, el sistema MUST mostrar las cifras
  de caja, activos, pasivos y utilidad de la plataforma ya calculadas en el servidor, y
  MUST NOT descargar el libro de caja completo para derivarlas.
- **RF_02 (evento):** **Cuando** el admin abre el detalle de una liquidación o de un corte
  cerrado, el sistema MUST traer solo los asientos de ese corte, en ese momento.
- **RF_03 (ubicua):** Toda cifra de dinero que una pantalla muestre MUST salir del mismo
  cálculo que hoy, ya sea en el servidor o en el cliente, y MUST dar el mismo resultado,
  peso por peso.
- **RF_04 (error):** **Si** una pantalla no puede obtener todos los datos que necesita
  una cifra de dinero, el sistema MUST mostrar el fallo de forma explícita y MUST NOT
  mostrar una cifra calculada con datos incompletos.
- **RF_05 (estado):** **Mientras** la app está abierta, el sistema MUST recibir solo los
  cambios ocurridos desde la última carga, y MUST NOT volver a leer documentos que no
  han cambiado.
- **RF_06 (evento):** **Cuando** un pedido o un asiento cambia, el sistema MUST actualizar
  solo los resúmenes que dependen de él: el saldo de la tienda, el del mensajero, el del
  corte y la posición de la plataforma.
- **RF_07 (evento):** **Cuando** se abre la app con cualquier rol, el sistema MUST dejar
  medido cuántos documentos leyó esa carga, para poder compararlo con el presupuesto de
  `docs/rendimiento.md`.
- **RF_08 (error):** **Si** la carga de un rol supera su presupuesto, el sistema SHOULD
  dejar un aviso visible para el responsable. El aviso no puede bloquear el uso de la
  app.

### Fase A — API de tiendas

- **RF_09 (evento):** **Cuando** una tienda pide `GET /orders` o `GET /kpis` con `from` o `to`, el
  sistema MUST leer de la base de datos solo los pedidos de esa tienda cuya fecha cae en el rango, y
  MUST NOT leer los pedidos de fuera del rango.
- **RF_10 (evento):** **Cuando** `GET /orders` necesita el estado de pago de los pedidos devueltos, el
  sistema MUST leer solo los asientos de esos pedidos, y MUST NOT leer el resto de los asientos de la
  tienda.
- **RF_11 (ubicua):** La respuesta de `GET /orders` y `GET /kpis` MUST ser idéntica, campo por campo y
  peso por peso, a la que da hoy para el mismo rango. Se demuestra con una prueba que compara las dos
  cargas con los mismos datos y con una comparación contra producción de la respuesta antes y después.
- **RF_12 (error):** **Si** la lectura dirigida de asientos falla en parte, el sistema MUST responder
  con error y MUST NOT devolver un estado de pago calculado con asientos incompletos.

Sin `from` ni `to`, y en `/resumen` y `/settlements`, la carga sigue como hoy: el saldo de la tienda
necesita el histórico completo (spec 018) y esas rutas se piden pocas veces.

## 4. Requisitos no funcionales

- **RNF_04 (fase A):** Una llamada `GET /orders` de un día de DANDA MUST leer menos de 1.000
  documentos (hoy 19.148), y la mediana de lecturas por hora entre las 0 y las 6 h MUST bajar de
  ~72.000 a menos de 15.000.
- **RNF_01:** En una semana normal después del despliegue, las lecturas totales del
  proyecto MUST bajar al menos un 70 % respecto a la línea base medida antes del cambio.
  Se mide con la métrica de lecturas de la base de datos por hora, como en la sección 1.
- **RNF_02:** Si el libro de caja y los pedidos cerrados se duplicaran, las lecturas de la
  carga inicial de cualquier rol MUST NOT subir más de un 5 %. Se demuestra con una
  prueba que lo simula.
- **RNF_03:** El tiempo hasta que la tarjeta héroe de la tienda muestra pesos MUST NOT
  superar la línea base de la spec 018 en más de un 10 %.

## 5. Casos limite

- **Un asiento de un corte ya pagado o conciliado:** el detalle de ese corte lo muestra
  igual que hoy, aunque el asiento sea muy anterior.
- **Una entrega en efectivo antigua, todavía sin cortar:** entra en «Pendiente por
  entregar» del líder, como exige la regla de oro 6.
- **El admin pierde la conexión y la recupera:** solo se traen los cambios ocurridos, no
  la carga completa otra vez.
- **Dos pestañas abiertas por el mismo admin:** ninguna paga dos veces la carga del
  histórico.
- **Una corrección administrativa de estado (`correctOrderStatus`) en un periodo
  abierto:** los resúmenes afectados se actualizan y los de cortes pagados no se
  reescriben, como exige el principio 10 de la constitución.
- **Una tienda nueva sin pedidos, o un mensajero sin ruta:** su pantalla carga con cero
  lecturas de pedidos, sin errores.

## 6. Fuera de alcance

- **Cambiar reglas de negocio, tarifas o la forma de cortar.** Solo cambia de dónde salen
  los datos y cuántos se leen.
- **Los webhooks de Shopify, de tiendas y de OnStock**, salvo que la medición de la línea
  base demuestre que pesan. Hoy suman unas 47.000 ejecuciones al mes.
- ~~La lectura nocturna constante~~ **Ya atribuida (1.1):** es la API de tiendas, y entra en la fase A.
- **Cambiar la frecuencia con que las integraciones de las tiendas consultan la API.** No son
  nuestras. Si tras la fase A siguen pesando, se habla con cada tienda o se pone un límite, en otra spec.
- **La búsqueda en el servidor para líder y mensajero**, que es otro punto pendiente de
  `docs/rendimiento.md`.

## 7. Definition of Done

1. Cada RF tiene una prueba automatizada que lo nombra (`023/RF_xx`) y pasa.
2. Las pruebas que atan la aritmética del servidor a la del cliente siguen pasando, y
   cubren todas las cifras que esta spec mueve al servidor (RF_03).
3. Se mide la carga de cada rol antes y después del cambio, con el guion de
   `docs/rendimiento.md`, y la tabla de presupuesto queda actualizada.
4. Hay una línea base de lecturas por hora, tomada antes del despliegue, y al menos 3
   días de medición después, que demuestran el RNF_01. Ambas quedan en
   `.sdd/evidence/023/`.
5. Hay capturas antes y después del saldo de una tienda, el de un líder, el detalle de un
   corte cerrado y la posición de la plataforma, y dan las mismas cifras.
6. El responsable validó el resultado y aprobó la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-10-01 | Borrador inicial | Subida del costo de Google Cloud: las lecturas se duplicaron de agosto a septiembre |
| 2026-11-10 | Aprobada A y B juntas; GraphQL se mantiene para evaluarlo en el plan de la fase B | Decisión del responsable |
| 2026-11-10 | Línea base nueva (1.1), fase A (RF_09–RF_12, RNF_04) antes de la fase B | La medición atribuye el 66–80 % de las lecturas a `GET /orders` de la API de tiendas, no a abrir la app |

## 9. Decisiones de arquitectura pedidas por el dueño (se concretan en el plan)

- **CQRS:** separar el lado que escribe (las callables del ciclo de vida, los webhooks y
  los cierres) del lado que se lee (los resúmenes por tienda, mensajero, corte y
  plataforma ya calculados). Cada escritura actualiza solo las proyecciones afectadas
  (RF_06), y las pantallas leen proyecciones, no el histórico.
  - **Base existente:** `getPlatformPosition`, `getOrderStats` y `getSellerBalance` ya son
    consultas del lado de lectura.
- **GraphQL:** es la interfaz de consulta del lado de lectura. Cada pantalla pide en una
  sola consulta exactamente los resúmenes y campos que muestra.
  - **Advertencia:** GraphQL por sí solo no ahorra lecturas. La base de datos cobra por
    documento leído, no por campo devuelto. El ahorro sale de que el lado de lectura sirva
    proyecciones ya calculadas.
- **Dependencias:** GraphQL es una dependencia nueva. Antes de instalar nada, pasa por la
  comparación de alternativas, compatibilidad, CVEs y documentación en `docs/research/`
  que pide la constitución.
