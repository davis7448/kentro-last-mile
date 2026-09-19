# Spec 021: Un asiento de corte no es un pedido, y el rescate por id no deberia pedirlo

- **Estado:** borrador (propuesto por el informe de cierre de la spec 019, 2026-09-19)
- **Autor:** Claude (a peticion del responsable de la plataforma)
- **Fecha:** 2026-09-19
- **Origen:** anomalia observada en la evidencia funcional de la 019. Las tres capturas de consola de
  `.sdd/evidence/019/HU_0*/consola.txt` traen el mismo 403 y el mismo aviso, en las tres historias.
- **Prioridad:** media — no mueve dinero, pero gasta el presupuesto del que ahora depende el detalle del
  corte y grita "puede faltar informacion en el saldo" cuando no falta nada

## 1. Contexto y objetivo

Al sembrar el saldo, el cliente toma los asientos de wallet **sin liquidar** y pide por id el pedido de
cada uno (`src/lib/firebase/state-store.ts:771-773`):

```ts
const openOrderIds = selectUnsettledWalletEntries(next.wallet)
  .map((entry) => entry.orderId)
  .filter((orderId): orderId is string => Boolean(orderId));
```

`entry.orderId` se toma como id de pedido sin comprobar que lo sea. **Y no siempre lo es.** Medido
contra produccion el 2026-09-19 para este borrador:

| | |
|---|---:|
| Asientos de wallet de domiciliario cuyo `orderId` es un id de **corte** (`stl-*`) | **36** |
| Ids de corte distintos entre ellos | **36** |
| Ejemplo | `we-stl-1789686589616-…-cash-shortage`, tipo `cash_shortage`, `settlementId: ""` |

Como esos asientos no llevan `settlementId`, cuentan como "sin liquidar" y entran en la siembra. El
navegador pide entonces `orders/stl-1789686589616-driver-driver-1778271901513`, que **no es un pedido**.
Las reglas lo rechazan con 403, la lectura se pierde y la consola escribe:

```
No se pudo leer orders/stl-…; puede faltar informacion en el saldo.
```

**Tres daños, ninguno de dinero.** Primero, hasta 36 lecturas tiradas en cada carga de pagina, contra el
tope de 800 que desde la 019 comparten las dos vias de rescate: es presupuesto que el detalle de un
corte ya no tiene. Segundo, un aviso que dice que puede faltar dinero cuando no falta, que es
exactamente la clase de mentira que la 019 vino a eliminar. Tercero, ese 403 aparece en toda evidencia
funcional y hay que ir descartandolo a mano en cada smoke, lo que entrena a ignorar 403 en la consola.

**Objetivo:** que el rescate por id pida solo pedidos, y que un aviso de "puede faltar informacion en el
saldo" signifique que de verdad puede faltar.

## 2. Historias de usuario

- **HU_01 (sin interfaz):** **Como** lider logistico **quiero** que las lecturas de mi sesion se gasten
  en pedidos de mis cortes **para** que el detalle salga completo aunque abra varios.
- **HU_02 (sin interfaz):** **Como** responsable de la plataforma **quiero** que un aviso de saldo
  incompleto en la consola sea siempre real **para** poder creerme el siguiente.

## 3. Requisitos funcionales (EARS + RFC 2119)

- **RF_01 (ubicua):** El rescate de pedidos por id MUST recibir unicamente identificadores de pedido.
  Un identificador que no lo sea MUST descartarse **antes** de gastar una lectura.
- **RF_02 (ubicua):** El sistema MUST determinar si un asiento se refiere a un pedido por el **tipo del
  asiento**, no por la forma de la cadena. Un filtro por prefijo `stl-` funcionaria hoy y se romperia el
  dia que cambie el esquema de ids.
- **RF_03 (error):** **Si** una lectura por id falla de verdad, el aviso MUST distinguir "no se pudo
  leer" de "no existe", y MUST NOT afirmar que puede faltar dinero cuando el documento pedido no era un
  pedido.
- **RF_04 (ubicua):** Un asiento de tipo `cash_shortage` (y cualquier otro asiento de nivel de corte)
  MUST seguir contando en el saldo exactamente igual que hoy. Este cambio es de **que se pide por red**,
  no de aritmetica: ninguna cifra en pantalla puede moverse.
- **RF_05 (ubicua):** El presupuesto de lecturas MUST NOT consumirse por identificadores descartados.

## 4. Requisitos no funcionales

- **RNF_01 (rendimiento):** Tras el cambio, una sesion de lider logistico MUST registrar **cero**
  lecturas denegadas por las reglas, medido como en `.sdd/evidence/019/t11-sesion-driver.txt`
  ("Lecturas denegadas por las reglas: 1" hoy).
- **RNF_02 (observabilidad):** El guion de verificacion MUST NOT necesitar una lista de 403 esperados
  para dar verde.

## 5. Casos limite

- **Asiento sin `orderId`:** ya se filtra hoy (`Boolean(orderId)`); no debe regresar.
- **Asiento de pedido cuyo pedido fue borrado:** sigue siendo una lectura legitima que no encuentra nada.
  No es este caso y no debe confundirse con el.
- **Tipos de asiento futuros de nivel de corte:** el criterio debe ser una lista explicita de tipos que
  SI llevan pedido, no una lista de excepciones, para que un tipo nuevo caiga del lado seguro.
- **El admin:** lee por lotes (`where(documentId(), "in", …)`) y un id ajeno tumba el lote entero (regla
  de oro 7 de `CLAUDE.md`). Comprobar si esos 36 ids le estan costando lotes completos.

## 6. Fuera de alcance

- **Corregir los 36 asientos en produccion.** Guardar un id de corte en `orderId` puede ser intencionado
  (es como el asiento se ata a su corte). Aqui se arregla **quien lee**, no el dato. Si se decide que el
  dato esta mal, es otra spec, con su relleno y su auditoria.
- Cambiar `selectUnsettledWalletEntries` o lo que cuenta como saldo pendiente.
- El tope de 800 lecturas y su reparto entre vias.

## 7. Definition of Done

1. Una prueba demuestra que un asiento de nivel de corte no genera ninguna lectura por id.
2. Una prueba demuestra RF_04: el saldo y las cifras derivadas no se mueven ni un peso con los mismos
   asientos de entrada.
3. Una guarda de fuente demuestra RF_02: el criterio es por tipo de asiento y no por prefijo de cadena.
4. Sesion real de lider logistico contra produccion con **cero** lecturas denegadas (RNF_01), con la
   evidencia guardada junto a la de la 019 para poder compararlas.
5. `npm test`, `npx tsc --noEmit` (raiz y `functions/`) y `npm run lint` en verde.
6. El responsable de la plataforma firma la entrega.

## 8. Historial de cambios

| Fecha | Cambio | Motivo |
|---|---|---|
| 2026-09-19 | Borrador inicial | 403 repetido en las tres evidencias funcionales de la 019; medido en produccion: 36 asientos de domiciliario con un id de corte en `orderId` |
