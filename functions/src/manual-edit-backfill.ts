/**
 * Que pedidos hay que marcar como "ya editados a mano" antes de desplegar la spec 017. SIN
 * Firestore: decide, no escribe (mismo patron que `order-corrections-plan.ts`).
 *
 * Por que hace falta. Hoy una reimportacion pisa la direccion cruda pero NO la corregida, asi que
 * la correccion sobrevive. Con la spec 017, un pedido sin confirmar y sin marca se trata como "nadie
 * lo ha tocado": se le refresca la direccion y se le descarta la geocodificacion derivada. Para los
 * pedidos editados ANTES de que existiera la marca, eso seria una perdida silenciosa causada por el
 * propio arreglo, sobre pedidos que existen el dia del despliegue.
 *
 * El historial de auditoria ya registra las dos ediciones manuales, asi que la marca se puede
 * reconstruir. La fecha que se sella es **la de la edicion**, no la del relleno: es cuando de verdad
 * alguien toco el pedido.
 */
import { CLOSED_STATUSES, MANUAL_EDIT_STAMP } from "./order-import-merge";

/** Las dos acciones que deja una edicion manual en `auditEvents` (`orders.ts:520` y `:715`). */
export const MANUAL_EDIT_ACTIONS = ["order.imported_updated", "order.adjusted"] as const;

export type AuditEventLike = { action?: unknown; entityId?: unknown; createdAt?: unknown };
export type OrderLike = { id: string; status?: unknown; [MANUAL_EDIT_STAMP]?: unknown };

export type StampPlan = {
  orderId: string;
  /** La fecha de la edicion mas reciente de ese pedido. */
  editedAt: string;
  action: string;
};

function isClosed(status: unknown): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(String(status ?? ""));
}

/**
 * Decide que pedidos llevan marca y con que fecha.
 *
 * Deja fuera, a proposito:
 * - los pedidos **cerrados**, que ya congelan todo por su estado y no ganan nada con la marca;
 * - los que **ya la tienen**, para que correr el relleno dos veces no mueva ninguna fecha.
 */
export function ordersToStamp(events: AuditEventLike[], orders: OrderLike[]): StampPlan[] {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const latest = new Map<string, StampPlan>();

  for (const event of events) {
    const action = String(event.action ?? "");
    if (!(MANUAL_EDIT_ACTIONS as readonly string[]).includes(action)) continue;
    const orderId = String(event.entityId ?? "");
    const editedAt = String(event.createdAt ?? "");
    if (!orderId || !editedAt) continue;

    const order = byId.get(orderId);
    if (!order) continue;
    if (isClosed(order.status)) continue;
    if (typeof order[MANUAL_EDIT_STAMP] === "string" && order[MANUAL_EDIT_STAMP]) continue;

    const previous = latest.get(orderId);
    if (!previous || editedAt > previous.editedAt) latest.set(orderId, { orderId, editedAt, action });
  }

  return [...latest.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
}
