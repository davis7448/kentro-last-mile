import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Manual API de Tiendas | Kentro",
  description:
    "Documentacion de la API para tiendas conectadas a Kentro: pedidos, KPIs operativos y liquidaciones, y confirmacion, correccion y anulacion de pedidos."
};

const BASE_URL = "https://us-central1-kentro-last-mile.cloudfunctions.net/storeApi";

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-ink px-4 py-3 text-xs leading-5 text-white">
      <code>{children}</code>
    </pre>
  );
}

function C({ children }: { children: string }) {
  return <code className="rounded bg-field px-1 font-mono text-xs">{children}</code>;
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-xs uppercase text-black/50">
            {head.map((cell) => <th key={cell} className="py-2 pr-3 font-semibold">{cell}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join("|")} className="border-b border-black/5 align-top last:border-0">
              {row.map((cell, index) => (
                <td key={`${row[0]}-${index}`} className={`py-2 pr-3 ${index === 0 ? "font-mono text-xs font-semibold" : "text-black/70"}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ApiTiendasPage() {
  return (
    <main className="min-h-screen bg-field px-4 py-8 text-fg">
      <article className="mx-auto grid max-w-3xl gap-6 rounded-lg border border-black/10 bg-white p-6 shadow-panel">
        <header>
          <p className="text-sm font-semibold uppercase tracking-normal text-black/50">Kentro</p>
          <h1 className="mt-2 text-3xl font-bold">Manual — API de Tiendas</h1>
          <p className="mt-2 text-sm text-black/60">Version 1 · Lectura de pedidos, KPIs y liquidaciones; confirmacion y correccion de pedidos.</p>
          <p className="mt-4 text-sm leading-6 text-black/70">
            Esta API permite a cada tienda consultar sus pedidos, los KPIs operativos (calculados con las mismas formulas del
            dashboard de Kentro) y sus liquidaciones, para corroborar que pedidos ya fueron pagados y cuales estan pendientes.
            Con la clave de escritura, ademas, puede confirmar, corregir los datos de entrega y anular pedidos que aun no
            estan en operacion. Cada clave ve y cambia unicamente los datos de su propia tienda.
          </p>
        </header>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">1. Obtener tus claves</h2>
          <p className="text-sm leading-6 text-black/70">
            Hay dos claves distintas. La <b>clave de lectura</b> solo consulta: en la plataforma Kentro, con tu usuario de tienda,
            abre la tarjeta <b>Clave de lectura</b> y presiona <b>Ver clave de lectura</b>. Desde ahi puedes copiarla y, si crees
            que se filtro, usar <b>Rotar key</b>: la anterior deja de funcionar de inmediato.
          </p>
          <p className="text-sm leading-6 text-black/70">
            La <b>clave de escritura</b> confirma, corrige y anula pedidos. Se genera en la seccion <b>Clave de escritura</b> de la
            misma tarjeta (solo la cuenta principal de la tienda o Kentro pueden generarla) y se muestra completa una sola vez:
            Kentro guarda solo su huella. Si no la copiaste, rotala con <b>Rotar clave de escritura</b>.
          </p>
          <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/60">
            Trata las dos claves como contraseñas. Usalas solo desde tu servidor (nunca en el codigo de una pagina web publica).
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">2. Autenticacion</h2>
          <p className="text-sm leading-6 text-black/70">
            Todas las peticiones van sobre HTTPS y llevan siempre tu <C>sellerId</C> en la URL. La clave va de una de dos formas,
            segun el tipo de ruta:
          </p>
          <Code>{`# Lecturas (GET): la clave de lectura en la cabecera (recomendado)
GET ${BASE_URL}/kpis?sellerId=TU_SELLER_ID
Authorization: Bearer TU_CLAVE_DE_LECTURA

# Lecturas (GET): o en el query string. SOLO vale en lecturas.
GET ${BASE_URL}/kpis?sellerId=TU_SELLER_ID&key=TU_CLAVE_DE_LECTURA

# Escrituras (POST / PATCH): la clave de escritura, SOLO en la cabecera
POST ${BASE_URL}/orders/{id}/confirm?sellerId=TU_SELLER_ID
Authorization: Bearer TU_CLAVE_DE_ESCRITURA`}</Code>
          <div className="grid gap-2">
            <p className="text-sm leading-6 text-black/70">• Cualquier clave en la URL de una escritura responde <C>401 key_in_query</C>, aunque sea la correcta: una clave en la URL queda en registros y en el historial del navegador.</p>
            <p className="text-sm leading-6 text-black/70">• La clave de lectura en la cabecera de una escritura responde <C>403 read_only_key</C>.</p>
            <p className="text-sm leading-6 text-black/70">• Si el <C>sellerId</C> no corresponde a la clave, la respuesta es <C>401 invalid_key</C>. Todas las consultas se filtran en el servidor por tu tienda; no es posible ver ni cambiar datos de otra.</p>
          </div>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">3. GET /resumen — Saldo y pagos (empieza aqui)</h2>
          <p className="text-sm leading-6 text-black/70">
            Devuelve el <b>saldo consolidado autoritativo</b> de tu tienda, calculado por Kentro con las mismas reglas del panel de operacion.
            <b> Usa este numero directamente; no lo reconstruyas sumando pedidos</b>, porque asi evitas descuadres por fletes o abonos.
          </p>
          <Code>{`curl "${BASE_URL}/resumen?sellerId=TU_SELLER_ID&key=TU_CLAVE_DE_LECTURA"`}</Code>
          <Table
            head={["Campo", "Significado"]}
            rows={[
              ["saldoPendiente.disponibleCop", "Lo que Kentro ya te puede pagar ahora (COD recibido del domiciliario o prepago), neto de abonos."],
              ["saldoPendiente.enLiquidacionCop", "Ya incluido en un corte creado pero aun no pagado."],
              ["saldoPendiente.bloqueadoCodCop", "Pedidos COD cuyo efectivo aun no se recibe del domiciliario; se habilita al recibirse."],
              ["saldoPendiente.totalCop", "Suma de los tres anteriores: todo lo que aun se te debe."],
              ["totales.codCop / cobrosCop / costoProductoCop", "Acumulados: COD a tu favor, cobros operativos (fletes/fallidos/fulfillment) y costo de producto descontado."],
              ["totales.abonadoCop", "Total de abonos (pagos parciales) que ya te entregamos."],
              ["totales.liquidadoCop", "Total neto ya liquidado en cortes pagados/conciliados."],
              ["pagos[]", "Historial de pagos recibidos: tipo (liquidacion|abono), fecha, montoCop, referencia."],
              ["abonos[]", "Cada abono recibido: fecha, montoCop, nota."]
            ]}
          />
          <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/60">
            Tu saldo real a favor = <code className="rounded bg-white px-1 font-mono">saldoPendiente.totalCop</code>. Los pagos ya recibidos (liquidaciones + abonos) estan en <code className="rounded bg-white px-1 font-mono">pagos[]</code>.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">4. GET /kpis — KPIs operativos</h2>
          <p className="text-sm leading-6 text-black/70">
            Devuelve los indicadores del rango de fechas, calculados <b>exactamente igual</b> que el dashboard de Kentro.
            El rango filtra por la fecha de creacion del pedido (formato <C>YYYY-MM-DD</C>, inclusivo).
          </p>
          <Code>{`curl "${BASE_URL}/kpis?sellerId=TU_SELLER_ID&key=TU_CLAVE_DE_LECTURA&from=2026-07-01&to=2026-07-31"`}</Code>
          <Table
            head={["Campo", "Significado"]}
            rows={[
              ["totalPedidos", "Total de pedidos del rango."],
              ["embudo.*", "Conteos excluyentes por etapa: pendienteConfirmar, listoSinLider, asignadoPendienteRecoger, recogidoSinMensajero, enGestionORuta, entregados, fallidos, cancelados, liquidados."],
              ["indicadores.tomadosPorDomiciliario", "Pedidos con domiciliario asignado en estado llamada pendiente, agendado, recogido, en ruta, reintento, entregado, fallido o liquidado."],
              ["indicadores.despachables", "Tomados por domiciliario menos fallidos sin cobertura, pedido malo / no contesta y sin telefono / linea inactiva."],
              ["indicadores.abiertosDespachables", "Despachables menos cerrados (entregados + fallidos con visita + liquidados)."],
              ["indicadores.porcentajeDespacho", "despachables / tomados por domiciliario (entero 0-100)."],
              ["indicadores.porcentajeTerminacion", "(entregados + fallidos con visita + liquidados) / despachables."],
              ["indicadores.porcentajeEntrega", "entregados / despachables."],
              ["indicadores.porcentajeDevolucion", "fallidos con visita / despachables."],
              ["fallidosPorCategoria.*", "fallidoConVisita, sinCobertura, pedidoMaloNoContesta, sinTelefonoLineaInactiva."]
            ]}
          />
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">5. GET /orders — Pedidos con estado operativo y de pago</h2>
          <Code>{`curl "${BASE_URL}/orders?sellerId=TU_SELLER_ID&key=TU_CLAVE_DE_LECTURA&from=2026-07-01&to=2026-07-31&status=delivered&limit=200"`}</Code>
          <Table
            head={["Parametro", "Descripcion"]}
            rows={[
              ["from / to", "Rango de fechas (opcional, inclusivo, por fecha de creacion)."],
              ["status", "Filtra por estado exacto: imported, ready_to_assign, assigned, call_pending, scheduled, picked_up, in_route, retry_pending, delivered, failed, cancelled, liquidated (opcional)."],
              ["limit", "Maximo de pedidos (default 500, tope 1000). Ordenados del mas reciente al mas antiguo."],
              ["shopifyOrderId", "Busca el pedido por su numero de Shopify en tu tienda (opcional): texto no vacio de hasta 1500 bytes. Admite cualquier numero tal como lo devuelve GET /orders, codificado en la URL (# → %23, espacio → %20). Ver el ejemplo de abajo."]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">
            Para encontrar el id de Kentro de un pedido de Shopify, filtra por su numero. El numeral <b>#</b> va codificado
            como <C>%23</C>: un # sin codificar lo corta el cliente HTTP como fragmento y el filtro llega vacio
            (<C>400 invalid_shopify_order_id</C>). Si no hay un pedido con ese numero, la respuesta es una lista vacia, no un error.
          </p>
          <Code>{`curl "${BASE_URL}/orders?sellerId=TU_SELLER_ID&key=TU_CLAVE_DE_LECTURA&shopifyOrderId=%232849"`}</Code>
          <p className="text-sm leading-6 text-black/70">Cada pedido incluye tres bloques:</p>
          <Table
            head={["Bloque", "Campos"]}
            rows={[
              ["datos", "id, trackingCode, shopifyOrderId, status, failedCategory, failedReason, paymentMethod (cod/prepaid), totalCop, customerName, createdAt, fecha."],
              ["operacion", "takenByDriver (tomado por domiciliario), dispatchable (despachable), delivered, failed, chargeableFailed (fallido con visita), noCoverageFailed, badOrderFailed, closed. Mismos criterios de los KPIs."],
              ["pago", "estado, pagado (true/false), habilitadoParaPago, netoCop, desglose (codCop, fleteCop, failedFeeCop, fulfillmentCop, costoProductoCop) con el flete REAL cobrado, movimientos, movimientosSinLiquidar, settlements[] (id, status, paidAt)."]
            ]}
          />
          <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/60">
            El campo <code className="rounded bg-white px-1 font-mono">pago.desglose.fleteCop</code> es el flete real que Kentro cobro por ese pedido. No asumas una tarifa: usa este valor.
          </p>
          <p className="text-sm leading-6 text-black/70">Valores de <C>pago.estado</C>:</p>
          <Table
            head={["Estado", "Significado"]}
            rows={[
              ["pagado", "Todos los movimientos del pedido estan en liquidaciones ya pagadas o conciliadas. El dinero ya se te entrego."],
              ["en_liquidacion", "Los movimientos estan en una liquidacion creada pero aun no marcada como pagada."],
              ["pendiente_habilitado", "Aun sin liquidar, pero ya habilitado para tu proximo corte (el COD ya fue recibido del domiciliario, o el pedido es prepago)."],
              ["pendiente_bloqueado_cod", "Aun sin liquidar y bloqueado: Kentro todavia no marca recibido el efectivo COD del domiciliario para este pedido."],
              ["sin_movimientos", "El pedido no tiene movimientos financieros (por ejemplo, aun no se cierra)."]
            ]}
          />
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">6. GET /settlements — Liquidaciones (pagos a tu tienda)</h2>
          <Code>{`curl "${BASE_URL}/settlements?sellerId=TU_SELLER_ID&key=TU_CLAVE_DE_LECTURA"`}</Code>
          <Table
            head={["Campo", "Significado"]}
            rows={[
              ["id", "Identificador de la liquidacion."],
              ["status", "pending (creada), paid (pagada), reconciled (conciliada/cerrada definitivamente)."],
              ["desde / hasta", "Rango de fechas que cubrio el corte."],
              ["netoCop", "Monto neto pagado a la tienda en ese corte."],
              ["codCop / cobrosCop / costoProductoCop", "Desglose: COD recaudado a tu favor, cobros operativos (fletes/fallidos/fulfillment) y costo de producto descontado."],
              ["paidAt / reconciledAt", "Fechas de pago y conciliacion."],
              ["pedidos[]", "Pedidos incluidos en el corte: orderId, trackingCode y status."]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">
            Para corroborar pagos pedido a pedido, cruza <C>/orders</C> (campo <C>pago</C>) con <C>/settlements</C>: un pedido esta
            pagado cuando su liquidacion aparece con status <C>paid</C> o <C>reconciled</C>.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">7. Un pedido y su historial</h2>
          <Table
            head={["Ruta", "Que devuelve"]}
            rows={[
              ["GET /orders/{id}", "Un pedido de tu tienda por su id de Kentro: { ok, pedido }, con la misma forma que un elemento de GET /orders. Un pedido de otra tienda o inexistente responde 404 order_not_found."],
              ["GET /orders/{id}/history", "Los cambios del pedido desde historySince, del mas viejo al mas nuevo: { ok, orderId, historySince, excludes, aviso, registros: [{ at, origin, action, changes: [{ field, from, to }] }] }. No dice quien hizo el cambio."]
            ]}
          />
          <Code>{`curl "${BASE_URL}/orders/ID_DEL_PEDIDO?sellerId=TU_SELLER_ID" \\
  -H "Authorization: Bearer TU_CLAVE_DE_LECTURA"

curl "${BASE_URL}/orders/ID_DEL_PEDIDO/history?sellerId=TU_SELLER_ID" \\
  -H "Authorization: Bearer TU_CLAVE_DE_LECTURA"`}</Code>
          <p className="text-sm leading-6 text-black/70">
            El historial empieza en <C>historySince</C>: la fecha desde la que Kentro registra estos cambios. Lo anterior no
            aparece. El historial no incluye los cambios de importaciones (Shopify y webhooks de tienda) ni la confirmacion
            automatica de ChatBy; la respuesta lo repite en <C>excludes</C> y <C>aviso</C>. Si el historial aun no esta
            disponible, la respuesta es <C>503 history_not_ready</C>.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">8. Confirmar, corregir y anular pedidos</h2>
          <p className="text-sm leading-6 text-black/70">
            Las tres escrituras usan la clave de escritura en la cabecera <C>Authorization: Bearer</C> y un cuerpo JSON. Solo
            actuan sobre pedidos en estado editable: <C>imported</C>, <C>address_risk</C> o <C>ready_to_assign</C> sin lider
            asignado. Un pedido ya en operacion (o con lider) responde <C>409 order_not_editable</C> con su <C>status</C> y
            <C> hasLeader</C>.
          </p>
          <Table
            head={["Ruta", "Que hace"]}
            rows={[
              ["POST /orders/{id}/confirm", "Confirma el pedido: pasa a ready_to_assign (listo para asignar). Cuerpo vacio u { expectedStatus }; nada mas. Un pedido con la direccion en revision (address_risk) responde 409 address_review_pending: corrige primero sus datos de entrega."],
              ["PATCH /orders/{id}", "Corrige los datos de entrega. Cuerpo con los campos a cambiar y expectedStatus opcional."],
              ["POST /orders/{id}/cancel", "Anula el pedido. Cuerpo { reason } obligatorio (de 1 a 500 caracteres) y expectedStatus opcional."]
            ]}
          />
          <Code>{`# Confirmar
curl -X POST "${BASE_URL}/orders/ID_DEL_PEDIDO/confirm?sellerId=TU_SELLER_ID" \\
  -H "Authorization: Bearer TU_CLAVE_DE_ESCRITURA" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: confirmar-ID_DEL_PEDIDO" \\
  -d '{"expectedStatus":"imported"}'

# Corregir los datos de entrega
curl -X PATCH "${BASE_URL}/orders/ID_DEL_PEDIDO?sellerId=TU_SELLER_ID" \\
  -H "Authorization: Bearer TU_CLAVE_DE_ESCRITURA" \\
  -H "Content-Type: application/json" \\
  -d '{"customerPhone":"3001234567","addressRaw":"Calle 5 # 38-20 apto 301","deliveryNotes":null}'

# Anular
curl -X POST "${BASE_URL}/orders/ID_DEL_PEDIDO/cancel?sellerId=TU_SELLER_ID" \\
  -H "Authorization: Bearer TU_CLAVE_DE_ESCRITURA" \\
  -H "Content-Type: application/json" \\
  -d '{"reason":"El cliente desistio de la compra"}'`}</Code>
          <p className="text-sm leading-6 text-black/70">Campos que admite <C>PATCH</C> (cualquier otro responde <C>422 field_not_allowed</C>):</p>
          <Table
            head={["Campo", "Regla"]}
            rows={[
              ["customerName", "Texto de hasta 120 caracteres. No puede ir vacio ni null."],
              ["customerPhone", "10 digitos, +57 y 10 digitos, o formato internacional E.164."],
              ["addressRaw", "Direccion de hasta 300 caracteres. No puede ir vacia ni null."],
              ["deliveryNotes", "Indicaciones de hasta 500 caracteres. \"\" o null BORRA las indicaciones."],
              ["cityId", "Id de una ciudad con cobertura activa. Si no la tiene: 422 out_of_coverage, con activeCities (id y nombre de las ciudades activas)."],
              ["expectedStatus", "Opcional (tambien en confirmar y anular). El estado en que lo leiste; si ya cambio: 409 status_changed."]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">
            Un cuerpo sin ningun dato de entrega responde <C>422 no_fields</C>. Los problemas de campo se devuelven todos a la
            vez en <C>fields</C> (<C>422 validation_failed</C>), cada uno con su <C>field</C>, <C>code</C> y <C>message</C>.
          </p>
          <p className="text-sm leading-6 text-black/70">
            La respuesta de una escritura que funciona es <C>{"200 { ok, changed, pedido }"}</C>, con <C>pedido</C> en la misma
            forma que <C>{"GET /orders/{id}"}</C>. <C>changed: false</C> significa &quot;ya estaba hecho&quot;: confirmar un pedido ya
            confirmado, o enviar los mismos datos que ya tiene, no cambia nada y no es un error. Por eso un reintento con el
            <C> expectedStatus</C> anterior (por ejemplo <C>imported</C> despues de que tu primera llamada ya lo confirmo)
            responde 200 sin cambios en vez de <C>409 status_changed</C>.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">9. Reintentos: Idempotency-Key y limite de tasa</h2>
          <p className="text-sm leading-6 text-black/70">
            Las escrituras admiten la cabecera <C>Idempotency-Key</C> (de 1 a 255 caracteres imprimibles; otra cosa responde
            <C> 400 invalid_idempotency_key</C>). Durante <b>24 horas</b>, repetir la misma key con el mismo cuerpo devuelve la
            respuesta guardada sin volver a ejecutar la operacion, incluidos los <C>409</C> y <C>422</C>: se repiten igual. La
            misma key con otro cuerpo responde <C>422 idempotency_key_reused</C>; usa una key nueva por operacion.
          </p>
          <p className="text-sm leading-6 text-black/70">
            Limite: maximo 120 escrituras por minuto por tienda (se cuentan todas, tambien las repetidas y las que terminan en error).
            Al superarlo la respuesta es <C>429 rate_limited</C> con la cabecera <C>Retry-After</C>: los segundos que faltan
            para el minuto siguiente. Las lecturas no tienen este limite.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">10. Errores</h2>
          <p className="text-sm leading-6 text-black/70">
            Las rutas de un pedido responden los errores como <C>{"{ ok: false, code, message }"}</C> y, segun el caso,
            <C> fields</C>, <C>status</C>, <C>hasLeader</C> o <C>activeCities</C>. Decide por el <C>code</C>, no por el texto
            de <C>message</C>. Las rutas de antes (<C>/resumen</C>, <C>/kpis</C>, <C>/orders</C>, <C>/settlements</C>)
            conservan su forma <C>{"{ ok: false, error }"}</C>.
          </p>
          <Table
            head={["Codigo", "HTTP", "Causa"]}
            rows={[
              ["route_not_found", "404", "La ruta no existe."],
              ["unknown_parameter", "400", "Parametros de consulta que la ruta no admite (las escrituras solo admiten sellerId)."],
              ["invalid_shopify_order_id", "400", "shopifyOrderId vacio o invalido: texto no vacio de hasta 1500 bytes (el # codificado como %23, el espacio como %20)."],
              ["invalid_idempotency_key", "400", "Idempotency-Key fuera de 1 a 255 caracteres imprimibles."],
              ["invalid_json", "400", "El cuerpo no es JSON valido."],
              ["invalid_body", "400", "El cuerpo no tiene la forma esperada (no es un objeto, expectedStatus no es texto, o confirmar trae algo mas que expectedStatus)."],
              ["missing_credentials", "401", "Falta sellerId o la clave."],
              ["invalid_key", "401", "La clave no corresponde al sellerId, fue rotada o la tienda tiene la API desactivada."],
              ["key_in_query", "401", "Una clave en la URL de una ruta de escritura."],
              ["read_only_key", "403", "La clave de lectura en una escritura."],
              ["order_not_found", "404", "No existe un pedido con ese id en tu tienda."],
              ["method_not_allowed", "405", "La ruta no admite ese metodo; la cabecera Allow dice cuales si."],
              ["status_changed", "409", "El estado no es el expectedStatus enviado. Vuelve a leer el pedido antes de reintentar."],
              ["order_cancelled", "409", "El pedido esta anulado."],
              ["address_review_pending", "409", "Confirmar un pedido con la direccion en revision (address_risk)."],
              ["order_not_editable", "409", "El pedido ya esta en operacion o tiene lider; trae status y hasLeader."],
              ["validation_failed", "422", "Uno o mas campos no son validos; detalle en fields."],
              ["field_not_allowed", "422", "Campos que la API no permite cambiar; detalle en fields."],
              ["out_of_coverage", "422", "La ciudad no tiene cobertura activa; trae activeCities."],
              ["no_fields", "422", "PATCH sin ningun dato de entrega."],
              ["idempotency_key_reused", "422", "La Idempotency-Key ya se uso con otro cuerpo."],
              ["rate_limited", "429", "Mas de 120 escrituras en el minuto; espera Retry-After."],
              ["history_not_ready", "503", "El historial aun no esta disponible."],
              ["internal_error", "500", "Error interno; reintenta en unos minutos."]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">
            <b>Precedencia.</b> Cuando una peticion tiene varios problemas, responde el primero de esta secuencia. Las lecturas
            usan los pasos 0 a 4. <C>history_not_ready</C> e <C>internal_error</C> no son pasos: pueden salir en cualquiera.
          </p>
          <Table
            head={["Paso", "Comprueba", "Codigos"]}
            rows={[
              ["0", "Ruta y metodo", "route_not_found, method_not_allowed"],
              ["1", "Clave en la URL de una ruta de escritura", "key_in_query"],
              ["2", "Credenciales", "missing_credentials, invalid_key, key_in_query, read_only_key"],
              ["3", "Parametros de consulta y forma del cuerpo", "unknown_parameter, invalid_json, invalid_body, invalid_idempotency_key, invalid_shopify_order_id"],
              ["3a", "Limite de tasa (solo escrituras)", "rate_limited"],
              ["3b", "Atajo de idempotencia (solo escrituras)", "idempotency_key_reused"],
              ["4", "Pedido de tu tienda", "order_not_found"],
              ["5", "Estado", "order_cancelled, address_review_pending, order_not_editable"],
              ["6", "Validacion y cobertura", "field_not_allowed, validation_failed, no_fields, out_of_coverage"],
              ["7", "Sin cambios", "200 changed: false"],
              ["8", "expectedStatus distinto", "status_changed"],
              ["9", "Aplicar", "200 changed: true"]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">Errores de las rutas de antes:</p>
          <Table
            head={["Codigo", "Causa"]}
            rows={[
              ["401 missing_credentials", "Falta sellerId o key."],
              ["401 invalid_key", "La key no corresponde al sellerId, esta inactiva o fue rotada."],
              ["404 unknown_resource", "Ruta invalida. Recursos validos: /resumen, /kpis, /orders, /settlements."],
              ["405 method_not_allowed", "Estas rutas solo aceptan GET."]
            ]}
          />
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">11. Buenas practicas</h2>
          <div className="grid gap-2">
            <p className="text-sm leading-6 text-black/70">• Llama la API desde tu servidor o herramienta de integracion (Make, n8n, Zapier, Google Sheets vía Apps Script), nunca desde el navegador de tus clientes.</p>
            <p className="text-sm leading-6 text-black/70">• Consulta por rangos de fechas acotados y cachea resultados; los datos operativos cambian durante el dia, las liquidaciones cambian solo cuando hay un corte.</p>
            <p className="text-sm leading-6 text-black/70">• En cada escritura envia expectedStatus y una Idempotency-Key: asi un reintento tras un corte de red no hace nada dos veces.</p>
            <p className="text-sm leading-6 text-black/70">• Si sospechas que una clave quedo expuesta, rotala desde la plataforma y actualiza tus integraciones.</p>
          </div>
        </section>

        <footer className="border-t border-black/10 pt-4 text-xs text-black/50">
          Kentro · https://kentro-last-mile.web.app · Soporte: contacta a tu asesor de operacion.
        </footer>
      </article>
    </main>
  );
}
