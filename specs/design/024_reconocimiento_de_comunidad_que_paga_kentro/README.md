# Diseno — Spec 024: reconocimiento de comunidad que paga Kentro

Fase design adelantada (el estado activo es la 026). Sistema "Acid Glass" (`docs/design-system.md`),
movil primero a 375 px, WCAG 2.2 AA. **Ningun SVG se observo con navegador**: el navegador de diseno
no esta disponible en esta maquina, asi que todas las pantallas llegan a verificacion como **no observadas
/ degradadas**.

`route` es `null` en todas: la app no tiene rutas por vista; se llega por navegacion interna.

| Pantalla | Donde vive | HU |
|---|---|---|
| `HU_01.ficha-reconocimiento` | Ajustes > Comunidades > tarjeta de la comunidad, boton "Editar reconocimiento" (despliegue en linea, como "Contener enlace filtrado") | HU_01 |
| `HU_01.relleno-previsualizacion` | Dialogo desde "Poner al dia pedidos cerrados" | HU_01 (RF_12) |
| `HU_01.relleno-bloqueado` | El mismo dialogo cuando el pago manual no cuadra | HU_01 (RF_12, decision P3) |
| `HU_01.estados` | Hoja de estados (vacio, guardando, error, previsualizando, nada que reconocer, aplicado) | HU_01 |
| `HU_01.escritorio` | La misma ficha a 1280 px, editor a la derecha | HU_01 |
| `HU_02.panel-reconocimiento` | Panel del lider (`CommunityLeaderView`), tarjeta nueva bajo "Tu cashback" | HU_02 |
| `HU_02.estados` | Cargando, error, sin reconocimiento, periodo vacio, acreedor, correccion negativa | HU_02 |
| `HU_04.posicion` | Liquidaciones > Por pagar > "Posicion de la plataforma" | HU_04 (RF_10) |
| `HU_04.liquidaciones` | Tabla de comunidades por girar (en movil, tarjetas), vacio, corte cerrado y exito | HU_04 (RF_06, RF_09) |

HU_03 es `(sin interfaz)`: no tiene pantalla.

## Decisiones

1. **Dos conceptos, nunca fundidos (RF_06).** Rotulo del concepto nuevo en todas partes:
   **"Reconocimiento de Kentro"**. En los mapas de tipo de asiento (`:3122`, `:10485`):
   `community_recognition: "Reconocimiento Kentro a comunidad"`. Donde una comunidad tiene uno de los dos
   en $0, ese renglon se pinta en $0 dentro de su fila; la unica suma de ambos es el "A girar" de la fila
   y el KPI "Comunidades", que muestra debajo el desglose.
2. **Sin valor configurado no hay renglon (caso limite):** ni tarjeta en el panel del lider, ni resumen
   en la ficha, ni boton "Poner al dia". Con valor y periodo vacio si hay tarjeta, con un mensaje.
3. **Una sola cifra en acido por pantalla.** En el panel del lider el "Pendiente" de cashback hoy va en
   `text-acid`; con dos tarjetas eso darian dos. Los dos "Pendiente" pasan a `text-mint` (dinero a favor de
   quien mira) y el acido queda para acciones.
4. **Panel del lider: pagado y pendiente son de lo causado en el periodo** (mismo eje de fecha que
   "Causado", rotulado). Pide al plan (§3.7) que el servidor devuelva, por asiento del periodo, si su corte
   esta pagado, en vez de restar lo pagado acumulado a lo causado del periodo. P12: solo total, sin desglose
   por tienda; si una tienda esta excluida se dice con su nombre.
5. **Exclusiones como casillas por tienda**, con "tienda del lider" rotulado; se ven 4 en movil y
   "Ver las 9 tiendas" despliega el resto. El servidor no deduce la tienda del lider (plan §0).
6. **Toggle del editor:** el boton se llama siempre "Editar reconocimiento" y lleva `aria-expanded`;
   no cambia de nombre al abrir (contrato estable).
7. **Relleno:** dialogo a pantalla completa en movil (Escape y "Cerrar" lo cierran). El boton de confirmar
   no existe hasta tener previsualizacion; dice cuantos pedidos y cuanto ("Reconocer 144 pedidos ·
   $144.000"). Si `manualPayment` no cuadra, caja de alerta "No se escribira nada", lista paginada de
   pedidos (tarjetas, 6 por pagina) para cuadrar y confirmar deshabilitado. Un fallo a mitad se informa
   como error con "Se escribieron N de M; vuelve a previsualizar" (re-ejecucion idempotente).
8. **Posicion (HU_04):** nueva linea "Reconocido a comunidades" restando en Utilidad, con "pagado · por
   pagar" debajo; "Reconocimiento por pagar a comunidades" en Obligaciones; "pagado a comunidades" en la
   linea de caja. El texto de cabecera de `PlatformPositionCard` cambia a "...menos lo pagado a
   domiciliarios y lo reconocido a comunidades". Si nunca se causo nada, las tres lineas no se pintan.
9. **Liquidaciones:** la tabla "Cashback de lideres pendiente de girar" pasa a "Comunidades pendientes de
   girar" con columnas Cashback y Reconocimiento separadas; KPI "Cashback lideres" pasa a "Comunidades".
   Boton por fila "Girar a <comunidad>" (nombre accesible unico). El modal de giro muestra el desglose; el
   corte cerrado tambien (cortes anteriores a la 024 = todo cashback). El corte del relleno sale con su nota.
10. Reversas negativas en `text-rust`, nunca recortadas a cero (regla del repo).

## Estados no dibujados (descritos)

- Posicion de la plataforma cargando: esqueleto en los tres bloques; error: "No se pudo calcular la posicion
  de la plataforma" + "Reintentar", sin cifras parciales.
- HU_02 y HU_04 a escritorio: mismas tarjetas en rejilla (`sm:grid-cols-3/4`); la tabla de comunidades
  mantiene tabla (<= 8 columnas: Comunidad, Lider, Pedidos, Cashback, Reconocimiento, A girar, Accion).

## Accesibilidad

Controles de 44 px, texto sobre acido en `#10140c`, ningun texto por debajo de `#9aa5b3`, cifras con
`tabular-nums`, el "?" con `aria-label="Que es el reconocimiento"`, cifras como pares `dt/dd` (rol `term`),
alertas de bloqueo y error con `role="alert"`, exitos con `role="status"`.
