import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Manual API de Tiendas | Kentro",
  description: "Documentacion de la API de solo lectura para tiendas conectadas a Kentro: pedidos, KPIs operativos y liquidaciones."
};

const BASE_URL = "https://us-central1-kentro-last-mile.cloudfunctions.net/storeApi";

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-ink px-4 py-3 text-xs leading-5 text-white">
      <code>{children}</code>
    </pre>
  );
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
    <main className="min-h-screen bg-field px-4 py-8 text-ink">
      <article className="mx-auto grid max-w-3xl gap-6 rounded-lg border border-black/10 bg-white p-6 shadow-panel">
        <header>
          <p className="text-sm font-semibold uppercase tracking-normal text-black/50">Kentro</p>
          <h1 className="mt-2 text-3xl font-bold">Manual — API de Tiendas</h1>
          <p className="mt-2 text-sm text-black/60">Version 1 · API de solo lectura para tiendas conectadas a Kentro.</p>
          <p className="mt-4 text-sm leading-6 text-black/70">
            Esta API permite a cada tienda consultar sus pedidos, los KPIs operativos (calculados con las mismas formulas del
            dashboard de Kentro) y sus liquidaciones, para corroborar que pedidos ya fueron pagados y cuales estan pendientes.
            Cada API key ve unicamente los datos de su propia tienda.
          </p>
        </header>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">1. Obtener tu API key</h2>
          <p className="text-sm leading-6 text-black/70">
            En la plataforma Kentro, con tu usuario de tienda, ve a tu panel y abre la seccion <b>Conexion Shopify → API de tienda (solo lectura)</b>.
            Presiona <b>Ver mi API key</b>. Desde ahi puedes copiar la key y las URLs de ejemplo. Si crees que tu key se filtro,
            usa <b>Rotar key</b>: la key anterior deja de funcionar de inmediato.
          </p>
          <p className="rounded-md bg-field px-3 py-2 text-xs font-semibold text-black/60">
            Trata la API key como una contraseña. Usala solo desde tu servidor (nunca en el codigo de una pagina web publica).
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">2. Autenticacion</h2>
          <p className="text-sm leading-6 text-black/70">
            Todas las peticiones son <b>GET</b> sobre HTTPS. Debes enviar siempre tu <code className="rounded bg-field px-1 font-mono text-xs">sellerId</code> y
            tu key, de una de estas dos formas:
          </p>
          <Code>{`# Opcion A: query string
GET ${BASE_URL}/kpis?sellerId=TU_SELLER_ID&key=TU_API_KEY

# Opcion B: header Authorization
GET ${BASE_URL}/kpis?sellerId=TU_SELLER_ID
Authorization: Bearer TU_API_KEY`}</Code>
          <p className="text-sm leading-6 text-black/70">
            La key esta atada a tu tienda: si el <code className="rounded bg-field px-1 font-mono text-xs">sellerId</code> no corresponde a la key,
            la respuesta es <code className="rounded bg-field px-1 font-mono text-xs">401 invalid_key</code>. Todas las consultas se filtran en el
            servidor por tu tienda; no es posible ver datos de otra.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">3. GET /kpis — KPIs operativos</h2>
          <p className="text-sm leading-6 text-black/70">
            Devuelve los indicadores del rango de fechas, calculados <b>exactamente igual</b> que el dashboard de Kentro.
            El rango filtra por la fecha de creacion del pedido (formato <code className="rounded bg-field px-1 font-mono text-xs">YYYY-MM-DD</code>, inclusivo).
          </p>
          <Code>{`curl "${BASE_URL}/kpis?sellerId=TU_SELLER_ID&key=TU_API_KEY&from=2026-07-01&to=2026-07-31"`}</Code>
          <Table
            head={["Campo", "Significado"]}
            rows={[
              ["totalPedidos", "Total de pedidos del rango."],
              ["embudo.*", "Conteos excluyentes por etapa: pendienteConfirmar, listoSinLider, asignadoPendienteRecoger, recogidoSinMensajero, enGestionORuta, entregados, fallidos, cancelados, liquidados."],
              ["indicadores.tomadosPorDomiciliario", "Pedidos con domiciliario asignado en estado llamada pendiente, agendado, recogido, en ruta, reintento, entregado, fallido o liquidado."],
              ["indicadores.despachables", "Tomados por domiciliario menos fallidos sin cobertura y pedido malo / no contesta."],
              ["indicadores.abiertosDespachables", "Despachables menos cerrados (entregados + fallidos con visita + liquidados)."],
              ["indicadores.porcentajeDespacho", "despachables / tomados por domiciliario (entero 0-100)."],
              ["indicadores.porcentajeTerminacion", "(entregados + fallidos con visita + liquidados) / despachables."],
              ["indicadores.porcentajeEntrega", "entregados / despachables."],
              ["indicadores.porcentajeDevolucion", "fallidos con visita / despachables."],
              ["fallidosPorCategoria.*", "fallidoConVisita, sinCobertura, pedidoMaloNoContesta."]
            ]}
          />
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">4. GET /orders — Pedidos con estado operativo y de pago</h2>
          <Code>{`curl "${BASE_URL}/orders?sellerId=TU_SELLER_ID&key=TU_API_KEY&from=2026-07-01&to=2026-07-31&status=delivered&limit=200"`}</Code>
          <Table
            head={["Parametro", "Descripcion"]}
            rows={[
              ["from / to", "Rango de fechas (opcional, inclusivo, por fecha de creacion)."],
              ["status", "Filtra por estado exacto: imported, ready_to_assign, assigned, call_pending, scheduled, picked_up, in_route, retry_pending, delivered, failed, cancelled, liquidated (opcional)."],
              ["limit", "Maximo de pedidos (default 500, tope 1000). Ordenados del mas reciente al mas antiguo."]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">Cada pedido incluye tres bloques:</p>
          <Table
            head={["Bloque", "Campos"]}
            rows={[
              ["datos", "id, trackingCode, shopifyOrderId, status, failedCategory, failedReason, paymentMethod (cod/prepaid), totalCop, customerName, createdAt, fecha."],
              ["operacion", "takenByDriver (tomado por domiciliario), dispatchable (despachable), delivered, failed, chargeableFailed (fallido con visita), noCoverageFailed, badOrderFailed, closed. Mismos criterios de los KPIs."],
              ["pago", "estado, pagado (true/false), habilitadoParaPago, netoCop (neto a favor/en contra por el pedido), movimientos, movimientosSinLiquidar, settlements[] (id, status, paidAt)."]
            ]}
          />
          <p className="text-sm leading-6 text-black/70">Valores de <code className="rounded bg-field px-1 font-mono text-xs">pago.estado</code>:</p>
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
          <h2 className="text-lg font-bold">5. GET /settlements — Liquidaciones (pagos a tu tienda)</h2>
          <Code>{`curl "${BASE_URL}/settlements?sellerId=TU_SELLER_ID&key=TU_API_KEY"`}</Code>
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
            Para corroborar pagos pedido a pedido, cruza <code className="rounded bg-field px-1 font-mono text-xs">/orders</code> (campo <code className="rounded bg-field px-1 font-mono text-xs">pago</code>)
            con <code className="rounded bg-field px-1 font-mono text-xs">/settlements</code>: un pedido esta pagado cuando su liquidacion aparece con status
            <code className="rounded bg-field px-1 font-mono text-xs">paid</code> o <code className="rounded bg-field px-1 font-mono text-xs">reconciled</code>.
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">6. Errores</h2>
          <Table
            head={["Codigo", "Causa"]}
            rows={[
              ["401 missing_credentials", "Falta sellerId o key."],
              ["401 invalid_key", "La key no corresponde al sellerId, esta inactiva o fue rotada."],
              ["404 unknown_resource", "Ruta invalida. Recursos validos: /kpis, /orders, /settlements."],
              ["405 method_not_allowed", "Solo se acepta GET."]
            ]}
          />
        </section>

        <section className="grid gap-3">
          <h2 className="text-lg font-bold">7. Buenas practicas</h2>
          <div className="grid gap-2">
            <p className="text-sm leading-6 text-black/70">• Llama la API desde tu servidor o herramienta de integracion (Make, n8n, Zapier, Google Sheets vía Apps Script), nunca desde el navegador de tus clientes.</p>
            <p className="text-sm leading-6 text-black/70">• Consulta por rangos de fechas acotados y cachea resultados; los datos operativos cambian durante el dia, las liquidaciones cambian solo cuando hay un corte.</p>
            <p className="text-sm leading-6 text-black/70">• Si sospechas que tu key quedo expuesta, rota la key desde la plataforma y actualiza tus integraciones.</p>
          </div>
        </section>

        <footer className="border-t border-black/10 pt-4 text-xs text-black/50">
          Kentro · https://kentro-last-mile.web.app · Soporte: contacta a tu asesor de operacion.
        </footer>
      </article>
    </main>
  );
}
