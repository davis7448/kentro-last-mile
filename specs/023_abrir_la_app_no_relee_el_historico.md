# Spec 023: Abrir la app no relee el histórico

- **Estado:** borrador
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

## 4. Requisitos no funcionales

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
- **La lectura nocturna constante de unas 13.000 por hora.** El plan técnico debe
  atribuirla. Si no la causa la app abierta, va en una spec propia.
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
