import JSZip from "jszip";
import { isChargeableFailedOrder } from "./finance";
import type { AppState, FailedCategory, Order, OrderStatus, WalletEntry } from "./types";

export type OrderExportCell = string | number;
export type OrderExportRow = Record<string, OrderExportCell>;

export const orderExportColumns = [
  "numero_guia",
  "referencia_shopify",
  "id_pedido",
  "vendedor",
  "dominio_tienda",
  "ciudad",
  "zona",
  "estado",
  "cliente",
  "telefono",
  "direccion_original",
  "direccion_normalizada",
  "lat",
  "lng",
  "metodo_pago",
  "modo_fulfillment",
  "valor_cod_cop",
  "valor_total_cop",
  "producto",
  "sku",
  "cantidad",
  "recaudo_cod_cop",
  "cobro_flete_cop",
  "cobro_fallido_cop",
  "cobro_fulfillment_cop",
  "costo_producto_cop",
  "neto_pedido_cop",
  "lider_logistico",
  "mensajero",
  "punto_recogida",
  "direccion_recogida",
  "fecha_programada",
  "ventana_programada",
  "resultado_llamada",
  "nota_llamada",
  "fecha_reprogramada",
  "ventana_reprogramada",
  "categoria_fallido",
  "fallido_cobrable",
  "motivo_fallido",
  "decision_reintento",
  "rotulo_impreso_en",
  "rotulo_impreso_por",
  "veces_impreso",
  "cantidad_evidencias",
  "evidencia_tipo",
  "evidencia_motivo",
  "evidencia_nota",
  "evidencia_archivo",
  "evidencia_link_foto",
  "evidencia_creada_en",
  "todos_links_evidencia",
  "todas_notas_evidencia",
  "recogido_en",
  "creado_en",
  "actualizado_en",
  "pedido_json",
  "evidencias_json"
] as const;

const statusLabels: Record<OrderStatus, string> = {
  imported: "Pendiente confirmacion",
  address_risk: "Direccion por revisar",
  ready_to_assign: "Listo para asignar",
  assigned: "Asignado",
  call_pending: "Llamada pendiente",
  scheduled: "Llamada registrada",
  pickup_pending: "Pendiente recogida",
  picked_up: "Recogido",
  in_route: "En ruta",
  delivered: "Entregado",
  failed: "Fallido",
  retry_pending: "Visita reprogramada",
  cancelled: "Cancelado",
  liquidated: "Liquidado"
};

const failedCategoryLabels: Record<FailedCategory, string> = {
  failed_visit: "Fallido real con visita",
  no_coverage: "Sin cobertura",
  bad_order_or_no_contact: "Pedido malo / no contesta",
  pending_review: "Pendiente revisar"
};

function statusLabel(status: OrderStatus) {
  return statusLabels[status] ?? status.replaceAll("_", " ");
}

function failedCategoryLabel(category?: FailedCategory) {
  return failedCategoryLabels[category ?? "failed_visit"];
}

function cleanCell(value: unknown): OrderExportCell {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return String(value);
}

function rowFrom(values: Partial<OrderExportRow>, columns: readonly string[]): OrderExportRow {
  return columns.reduce<OrderExportRow>((row, column) => {
    row[column] = cleanCell(values[column]);
    return row;
  }, {});
}

function fullOrderExportRow(values: Partial<OrderExportRow>): OrderExportRow {
  return rowFrom(values, orderExportColumns);
}

// Suma, por pedido, los movimientos de wallet del vendedor (lo realmente cobrado/recaudado),
// para que el reporte muestre el desglose financiero y el vendedor pueda auditar.
function sellerChargesByOrder(state: AppState) {
  const byOrder = new Map<string, { cod: number; deliveryFee: number; failedFee: number; fulfillmentFee: number; productCost: number; net: number }>();
  for (const entry of state.wallet ?? []) {
    if (entry.ownerType !== "seller" || !entry.orderId) continue;
    const agg = byOrder.get(entry.orderId) ?? { cod: 0, deliveryFee: 0, failedFee: 0, fulfillmentFee: 0, productCost: 0, net: 0 };
    agg.net += entry.amountCop;
    if (entry.type === "cod_revenue") agg.cod += entry.amountCop;
    else if (entry.type === "delivery_fee") agg.deliveryFee += -entry.amountCop;
    else if (entry.type === "failed_fee") agg.failedFee += -entry.amountCop;
    else if (entry.type === "fulfillment_fee") agg.fulfillmentFee += -entry.amountCop;
    else if (entry.type === "product_cost") agg.productCost += -entry.amountCop;
    byOrder.set(entry.orderId, agg);
  }
  return byOrder;
}

export function buildOrderExportRows(orders: Order[], state: AppState): OrderExportRow[] {
  const sellers = new Map(state.sellers.map((seller) => [seller.id, seller]));
  const cities = new Map(state.cities.map((city) => [city.id, city]));
  const zones = new Map(state.zones.map((zone) => [zone.id, zone]));
  const drivers = new Map(state.drivers.map((driver) => [driver.id, driver]));
  const messengers = new Map(state.messengers.map((messenger) => [messenger.id, messenger]));
  const charges = sellerChargesByOrder(state);

  return orders.map((order) => {
    const seller = sellers.get(order.sellerId);
    const city = cities.get(order.cityId);
    const zone = order.zoneId ? zones.get(order.zoneId) : undefined;
    const driver = order.driverId ? drivers.get(order.driverId) : undefined;
    const messenger = order.messengerId ? messengers.get(order.messengerId) : undefined;
    const latestEvidence = [...order.evidence].reverse().find((item) => item.type === "failed") ?? order.evidence.at(-1);

    return fullOrderExportRow({
      numero_guia: order.trackingCode,
      referencia_shopify: order.shopifyOrderId,
      id_pedido: order.id,
      vendedor: seller?.name,
      dominio_tienda: seller?.shopDomain,
      ciudad: city?.name ?? order.cityId,
      zona: zone?.name ?? order.zoneId,
      estado: statusLabel(order.status),
      cliente: order.customerName,
      telefono: order.customerPhone,
      direccion_original: order.addressRaw,
      direccion_normalizada: order.normalizedAddress,
      lat: order.lat,
      lng: order.lng,
      metodo_pago: order.paymentMethod,
      modo_fulfillment: order.fulfillmentMode,
      valor_cod_cop: order.paymentMethod === "cod" ? order.totalCop : "",
      valor_total_cop: order.totalCop,
      producto: order.productName,
      sku: order.sku,
      cantidad: order.quantity,
      recaudo_cod_cop: charges.get(order.id)?.cod ?? "",
      cobro_flete_cop: charges.get(order.id)?.deliveryFee ?? "",
      cobro_fallido_cop: charges.get(order.id)?.failedFee ?? "",
      cobro_fulfillment_cop: charges.get(order.id)?.fulfillmentFee ?? "",
      costo_producto_cop: charges.get(order.id)?.productCost ?? "",
      neto_pedido_cop: charges.get(order.id)?.net ?? "",
      lider_logistico: driver?.name,
      mensajero: messenger?.name,
      punto_recogida: order.pickupPointName,
      direccion_recogida: order.pickupAddress,
      fecha_programada: order.scheduledDate,
      ventana_programada: order.scheduledWindow,
      resultado_llamada: order.callOutcome,
      nota_llamada: order.callNote,
      fecha_reprogramada: order.rescheduledDate,
      ventana_reprogramada: order.rescheduledWindow,
      categoria_fallido: order.status === "failed" ? failedCategoryLabel(order.failedCategory) : "",
      fallido_cobrable: order.status === "failed" ? (isChargeableFailedOrder(order) ? "si" : "no") : "",
      motivo_fallido: order.failedReason,
      decision_reintento: order.retryDecision,
      rotulo_impreso_en: order.labelPrintedAt,
      rotulo_impreso_por: order.labelPrintedBy,
      veces_impreso: order.labelPrintCount,
      cantidad_evidencias: order.evidence.length,
      evidencia_tipo: latestEvidence?.type,
      evidencia_motivo: latestEvidence?.reason,
      evidencia_nota: latestEvidence?.note,
      evidencia_archivo: latestEvidence?.photoLabel,
      evidencia_link_foto: latestEvidence?.photoUrl,
      evidencia_creada_en: latestEvidence?.createdAt,
      todos_links_evidencia: order.evidence.map((item) => item.photoUrl).filter(Boolean).join(" | "),
      todas_notas_evidencia: order.evidence.map((item) => [item.createdAt, item.reason, item.note].filter(Boolean).join(" - ")).join(" | "),
      recogido_en: order.pickedUpAt,
      creado_en: order.createdAt,
      actualizado_en: order.updatedAt,
      pedido_json: JSON.stringify(order),
      evidencias_json: JSON.stringify(order.evidence)
    });
  });
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index: number) {
  let name = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function worksheetCell(value: OrderExportCell, rowIndex: number, columnIndex: number) {
  const reference = `${columnName(columnIndex)}${rowIndex}`;
  if (typeof value === "number") return `<c r="${reference}"><v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function worksheetXml(columns: readonly string[], rows: OrderExportCell[][]) {
  const rowXml = rows.map((row, rowIndex) => {
    const excelRowIndex = rowIndex + 1;
    const cells = row.map((value, columnIndex) => worksheetCell(value, excelRowIndex, columnIndex + 1)).join("");
    return `<row r="${excelRowIndex}">${cells}</row>`;
  }).join("");
  const lastCell = `${columnName(columns.length)}${Math.max(rows.length, 1)}`;
  const cols = columns.map((column, index) => {
    const width = Math.min(Math.max(column.length + 4, 12), 40);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastCell}"/>
  <cols>${cols}</cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

// Genera y descarga un .xlsx generico a partir de columnas + filas de datos.
async function downloadXlsx(sheetName: string, columns: readonly string[], dataRows: OrderExportCell[][], filename: string) {
  const sheetRows = [[...columns], ...dataRows];
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.folder("xl")?.file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`);
  zip.folder("xl")?.folder("_rels")?.file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  zip.folder("xl")?.folder("worksheets")?.file("sheet1.xml", worksheetXml(columns, sheetRows));
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadOrdersXlsx(orders: Order[], state: AppState, filename: string) {
  const rows = buildOrderExportRows(orders, state);
  const dataRows = rows.map((row) => orderExportColumns.map((column) => row[column]));
  await downloadXlsx("Pedidos", orderExportColumns, dataRows, filename);
}

// ----- Export de wallet (movimientos financieros) -----

export const walletExportColumns = [
  "fecha",
  "tipo",
  "descripcion",
  "monto_cop",
  "guia",
  "referencia_shopify",
  "pedido_id",
  "producto",
  "proveedor",
  "propietario_tipo",
  "propietario",
  "liquidacion_id",
  "movimiento_id"
] as const;

const walletTypeLabels: Record<string, string> = {
  cod_revenue: "Recaudo COD",
  delivery_fee: "Cobro flete entrega",
  failed_fee: "Cobro fallido",
  fulfillment_fee: "Fulfillment bodega",
  product_cost: "Costo de producto",
  driver_earning: "Pago transportista",
  platform_margin: "Margen plataforma",
  cod_remittance: "Remesa COD",
  payout: "Pago a tienda",
  seller_abono: "Abono a tienda",
  cash_shortage: "Faltante de efectivo"
};

export function buildWalletExportRows(entries: WalletEntry[], state: AppState): OrderExportRow[] {
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  const sellersById = new Map(state.sellers.map((seller) => [seller.id, seller]));
  const driversById = new Map(state.drivers.map((driver) => [driver.id, driver]));
  return [...entries]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((entry) => {
      const order = entry.orderId ? ordersById.get(entry.orderId) : undefined;
      const ownerName =
        entry.ownerType === "seller"
          ? sellersById.get(entry.ownerId)?.name ?? entry.ownerId
          : entry.ownerType === "driver"
            ? driversById.get(entry.ownerId)?.name ?? entry.ownerId
            : "Plataforma";
      return rowFrom({
        fecha: entry.createdAt,
        tipo: walletTypeLabels[entry.type] ?? entry.type,
        descripcion: entry.description,
        monto_cop: entry.amountCop,
        guia: order?.trackingCode ?? "",
        referencia_shopify: order?.shopifyOrderId ?? "",
        pedido_id: entry.orderId ?? "",
        producto: entry.productName ?? order?.productName ?? "",
        proveedor: entry.supplierName ?? "",
        propietario_tipo: entry.ownerType,
        propietario: ownerName,
        liquidacion_id: entry.settlementId ?? "",
        movimiento_id: entry.id
      }, walletExportColumns);
    });
}

export async function downloadWalletXlsx(entries: WalletEntry[], state: AppState, filename: string) {
  const rows = buildWalletExportRows(entries, state);
  const dataRows = rows.map((row) => walletExportColumns.map((column) => row[column]));
  await downloadXlsx("Wallet", walletExportColumns, dataRows, filename);
}

// Helper genérico: descarga un .xlsx a partir de columnas + filas (objetos {columna: valor}).
// Lo usan los exports de liquidaciones, cuyos tipos viven en el componente (operations-app.tsx).
export async function downloadRowsXlsx(sheetName: string, columns: readonly string[], rows: OrderExportRow[], filename: string) {
  const dataRows = rows.map((row) => columns.map((column) => cleanCell(row[column])));
  await downloadXlsx(sheetName, columns, dataRows, filename);
}
