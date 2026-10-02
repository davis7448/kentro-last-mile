# Diseno — Spec 026: efectivo que no llega a un corte

Sistema "Acid Glass" (`docs/design-system.md`). Las cifras de los dibujos salen de la medicion de la spec
del 2026-10-02 (153 pedidos, $14.557.721; 34 vencidos, $2.954.111). Los nombres de lideres y mensajeros son
**inventados**. Los textos visibles van sin tildes, como el resto de la app ("Operacion", "Historico").

**Observacion:** ninguna pantalla se observo con el navegador de diseno. El preflight de esta maquina
declara `design.observe: unavailable`, asi que las once pantallas llegan a la verificacion **degradadas / sin
observar**.

## Decisiones

1. **Donde vive la lista del admin (HU_01).** Es una pestana nueva de Liquidaciones, **"Efectivo sin
   llegar"**, la segunda despues de "Por pagar". No es una entrada nueva del riel, que ya tiene seis. Usa el
   mismo `role="tablist"` "Secciones de liquidaciones". Encaja ahi porque responde a una pregunta del mismo
   trabajo: que parte no se puede pagar todavia.
2. **Total vencido en la pantalla principal (RF_03).** Es una tarjeta, region "Efectivo vencido", en
   Operacion del admin, encima de los indicadores actuales. Muestra la cifra en rust (dinero que se debe), el
   numero de pedidos, el lider con mas pedidos vencidos y la antiguedad del mas viejo. Su unica accion,
   "Ver efectivo sin llegar", abre la pestana. Con vencido $0 la tarjeta se reduce a una linea muda,
   "Efectivo vencido: $0 · al dia". No desaparece, porque RF_03 exige mostrar el total.
3. **Que total se ve (P1, aprobado).** Es el **recaudo bruto** (`totals.collectedCop`, y `collectedCop` por
   fila). El cuadre con la posicion se ve en la divulgacion plegada "Cuadre con la posicion de la
   plataforma":
   - plegada, muestra `driverReceivableCop`, `listOutstandingCop` y `unexplainedCop`;
   - desplegada, muestra una fila por cada causa de `causes`, con su importe y sus guias o cortes;
   - si `unexplainedCop != 0`, el icono pasa a rust y la divulgacion se abre sola;
   - solo aparece cuando `reconciliation != null` (admin sin filtro de lider).

   El nombre accesible del boton es fijo ("Cuadre con la posicion de la plataforma"). Las cifras van en
   `aria-describedby`.
4. **Agrupado por lider y orden.** Los grupos se ordenan por `overdueCop` descendente; dentro de cada
   grupo, del mas antiguo al mas reciente (`deliveredAt` ascendente).
   - Solo se despliega el primer grupo con importe vencido. Los demas van plegados (divulgacion progresiva).
   - Cada grupo pagina de 6 en 6 en movil y de 25 en 25 en escritorio ("Ver los N pedidos restantes").
   - "Sin lider" es un grupo propio, con el texto rust "no hay a quien cobrarle" (caso de la spec 017).
5. **Fuera de corte frente a corte pendiente.** Se distinguen con una pildora con texto, nunca solo por
   color:
   - "Fuera de todo corte": contorno rust;
   - "En corte pendiente": relleno info.

   El lider ve la misma idea en su lenguaje: "No esta en ningun corte" o "En el corte del 30 sep, sin
   cubrir".
6. **Fecha aproximada.** Si `deliveredAtSource` es `"updatedAt"`, la fecha va con el sufijo "aprox." en
   texto muted, y el detalle de la fila dice de donde salio. Con las fuentes `evidence` y `cod_entry` no se
   marca nada en la fila, solo en el detalle.
7. **Detalle de la fila (al tocarla).** Muestra lo que sirve una vez elegido el pedido:
   - `settlementIds`;
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
     todavia: $X (efectivo sin llegar)", con `amountCop` del mismo informe.
   - Al lider no se le muestra nada de esto (el informe le llega sin esos campos).
9. **Plazo y umbral (RF_04).**
   - Se ajustan en el dialogo "Plazo y aviso": hoja inferior en movil, modal en escritorio. Escape cierra.
   - Plazo de 1 a 120 dias; "Avisar desde, en pesos" con 0 como minimo. Por defecto, 7 dias y $20.000.
   - Muestra si el canal del aviso esta configurado. Sin secreto dice "Sin canal: el aviso solo se ve en
     la app".
   - Guarda por `updateCashAlertSettings`, recalcula la lista y anuncia "Guardado" en un `status`. Un error
     de validacion queda bajo el campo, con `aria-invalid`.
10. **Vista del lider (HU_02, P6: complementa).**
    - Es un panel nuevo, region "Efectivo sin llegar a Kentro", al inicio de Finanzas. No sustituye a
      "Pendiente por entregar" de Operacion.
    - Su cifra es `outstandingCop`, neta de su pago: lo que de verdad tiene que entregar.
    - El boton "?" ("Que incluye esta cifra") explica por que no coincide con "Pendiente por entregar":
      aquella suma los cortes abiertos por su saldo guardado y el total del pedido.
    - Densidad de calle: cuerpo de 15 a 17 px y controles de 56 px. Se queda en tema oscuro, como el resto
      de DriverView; solo el mensajero va en claro.
    - No tiene accion "ya lo entregue": la spec no la pide. Una nota le dice que avise al administrador con
      la guia.
11. **Cuando se calcula.** El callable se llama al abrir la pestana o Finanzas, y con "Actualizar". No hay
    suscripcion. La cabecera dice "calculado hoy HH:MM".

## Estados

| Estado | Admin (HU_01) | Lider (HU_02) |
|---|---|---|
| Cargando | `HU_01.cargando`: esqueleto, `status` "Calculando el efectivo sin llegar" y Actualizar deshabilitado | El mismo patron dentro del panel: esqueleto de cifra y dos tarjetas, con el mismo `status`. Sin dibujo propio |
| Vacio | `HU_01.vacio`: "Todo el efectivo llego" | `HU_02.al-dia`: "Kentro tiene todo tu efectivo" |
| Error | `HU_01.error`: `alert` sin ninguna cifra parcial, con Reintentar. Actualizar se oculta | `HU_02.error`: igual, con boton de 56 px |
| Documentos ilegibles | `HU_01.ilegibles`: region "Documentos ilegibles", "Cifras incompletas" | Igual que el admin, sin ids. Texto: "Hay datos que no se pudieron leer; el total puede no estar completo. Avisa al administrador." Sin dibujo propio |
| Con datos | `HU_01.lista` (movil), `HU_01.lista-escritorio` | `HU_02.finanzas` |

Sobre los documentos ilegibles:
- La lista de "Ver documentos ilegibles" muestra el tipo y el id de cada documento. No hace falta mas
  identificacion.
- Si hay algun corte en `unreadableSettlementIds`, el texto lo advierte expresamente, porque un corte
  ilegible puede dejar en la lista pedidos que en realidad ya estan cubiertos.

## Accesibilidad (WCAG 2.2 AA)

- Contraste sobre panel: rust 7,4:1, info alrededor de 8:1, muted 6,1:1 y tinta sobre acido 13,9:1.
- Un solo relleno acido por pantalla. Es la accion primaria; ninguna cifra va en acido.
- Encabezados en orden: h1 de la pagina, h2 de la pestana o del panel, h3 de cada grupo de lider.
- La tabla de escritorio pasa a tarjetas por fila en movil.
- Los botones que son solo un icono llevan `aria-label` ("Actualizar", "Que incluye esta cifra",
  "Cerrar").
- Los "dias" vencidos llevan texto ademas del color.
