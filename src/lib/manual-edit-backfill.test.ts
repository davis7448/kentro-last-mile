import { describe, expect, it } from "vitest";
import { MANUAL_EDIT_ACTIONS, ordersToStamp } from "../../functions/src/manual-edit-backfill";
import { MANUAL_EDIT_STAMP } from "../../functions/src/order-import-merge";

/**
 * El relleno de la marca de edicion (spec 017, RF_19). Si esto se equivoca, el propio arreglo borra
 * direcciones corregidas el dia del despliegue, asi que la decision va aparte del guion y se prueba.
 */

const evento = (entityId: string, createdAt: string, action: string = MANUAL_EDIT_ACTIONS[0]) => ({ action, entityId, createdAt });

describe("ordersToStamp", () => {
  it("marca un pedido sin confirmar que alguien edito", () => {
    const plan = ordersToStamp(
      [evento("shopify-1", "2026-09-14T10:00:00.000Z")],
      [{ id: "shopify-1", status: "imported" }]
    );
    expect(plan).toEqual([{ orderId: "shopify-1", editedAt: "2026-09-14T10:00:00.000Z", action: "order.imported_updated" }]);
  });

  it("marca tambien el ajuste administrativo, que toca el recaudo", () => {
    const plan = ordersToStamp(
      [evento("shopify-2", "2026-09-14T11:00:00.000Z", "order.adjusted")],
      [{ id: "shopify-2", status: "in_route" }]
    );
    expect(plan[0]?.action).toBe("order.adjusted");
  });

  /** La marca lleva la fecha de la EDICION, no la del relleno. */
  it("se queda con la edicion mas reciente de cada pedido", () => {
    const plan = ordersToStamp(
      [evento("shopify-1", "2026-09-10T10:00:00.000Z"), evento("shopify-1", "2026-09-14T10:00:00.000Z")],
      [{ id: "shopify-1", status: "imported" }]
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]?.editedAt).toBe("2026-09-14T10:00:00.000Z");
  });

  /** Un pedido cerrado ya congela todo por su estado: la marca no le anade nada. */
  it.each(["delivered", "failed", "cancelled", "liquidated"])("deja fuera un pedido %s", (status) => {
    const plan = ordersToStamp([evento("shopify-3", "2026-09-14T10:00:00.000Z")], [{ id: "shopify-3", status }]);
    expect(plan).toEqual([]);
  });

  /** Correr el relleno dos veces no puede mover ninguna fecha ya escrita. */
  it("no toca un pedido que ya tiene marca", () => {
    const plan = ordersToStamp(
      [evento("shopify-4", "2026-09-14T10:00:00.000Z")],
      [{ id: "shopify-4", status: "imported", [MANUAL_EDIT_STAMP]: "2026-09-13T08:00:00.000Z" }]
    );
    expect(plan).toEqual([]);
  });

  it("ignora las acciones que no son ediciones manuales", () => {
    const plan = ordersToStamp(
      [evento("shopify-5", "2026-09-14T10:00:00.000Z", "order.transition")],
      [{ id: "shopify-5", status: "imported" }]
    );
    expect(plan).toEqual([]);
  });

  it("ignora eventos de pedidos que ya no existen", () => {
    expect(ordersToStamp([evento("borrado", "2026-09-14T10:00:00.000Z")], [])).toEqual([]);
  });

  it("ignora eventos sin pedido o sin fecha", () => {
    const plan = ordersToStamp(
      [{ action: MANUAL_EDIT_ACTIONS[0], entityId: "", createdAt: "2026-09-14T10:00:00.000Z" }, { action: MANUAL_EDIT_ACTIONS[0], entityId: "shopify-6", createdAt: "" }],
      [{ id: "shopify-6", status: "imported" }]
    );
    expect(plan).toEqual([]);
  });
});
