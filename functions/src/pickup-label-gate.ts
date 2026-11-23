/**
 * Un pedido no se recoge sin rotulo impreso en Kentro.
 *
 * Hasta el 2026-11-18 el rotulo era solo una marca informativa: la recogida validaba estado y lider,
 * nada mas. Ese dia habia 146 pedidos de una sola tienda recogidos o en ruta sin `labelPrintedAt`,
 * entre ellos un lote entero de 24. Un paquete sin rotulo en la calle no se puede pistolear ni
 * distinguir de otro, y el mensajero lo ve marcado "sin rotulo" cuando ya no hay nada que imprimir.
 *
 * Puro (sin firebase-admin) para que el callable y las pruebas compartan la misma regla.
 */

export type PickupLabelCandidate = {
  id: string;
  trackingCode?: unknown;
  shopifyOrderId?: unknown;
  labelPrintedAt?: unknown;
};

const MAX_CODES_IN_MESSAGE = 10;

export function hasPrintedLabel(order: Pick<PickupLabelCandidate, "labelPrintedAt">): boolean {
  return typeof order.labelPrintedAt === "string" && order.labelPrintedAt.trim().length > 0;
}

export function findOrdersWithoutLabel<T extends PickupLabelCandidate>(orders: T[]): T[] {
  return orders.filter((order) => !hasPrintedLabel(order));
}

function orderCode(order: PickupLabelCandidate): string {
  if (typeof order.trackingCode === "string" && order.trackingCode) return order.trackingCode;
  if (typeof order.shopifyOrderId === "string" && order.shopifyOrderId) return order.shopifyOrderId;
  return order.id;
}

/** Mensaje para el lider. `null` si todos los pedidos tienen rotulo. */
export function pickupLabelBlockMessage(orders: PickupLabelCandidate[]): string | null {
  const missing = findOrdersWithoutLabel(orders);
  if (missing.length === 0) return null;
  const codes = missing.slice(0, MAX_CODES_IN_MESSAGE).map(orderCode).join(", ");
  const rest = missing.length > MAX_CODES_IN_MESSAGE ? ` y ${missing.length - MAX_CODES_IN_MESSAGE} mas` : "";
  const subject = missing.length === 1 ? "Este pedido no tiene rotulo impreso" : `${missing.length} pedidos no tienen rotulo impreso`;
  return `${subject}: ${codes}${rest}. La tienda o el administrador debe imprimirlo en Kentro antes de la recogida.`;
}
