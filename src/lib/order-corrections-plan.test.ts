import { describe, expect, it } from "vitest";
// El planificador vive en functions/ porque reusa buildWalletEntries, que es la unica
// fuente de verdad sobre cuanta plata genera un pedido. Los casos de abajo reproducen las
// cifras EXACTAS de los pedidos que se corrigieron a mano con scripts one-off: esos
// numeros son la especificacion, y esta tabla es la red que impide perderlos.
import {
  type CorrectionRequest,
  planOrderCorrection,
  relabelEvidence,
  reversalEntryFor,
  type PlanInput
} from "../../functions/src/order-corrections-plan";
import type { SettlementDoc, WalletEntryDoc } from "../../functions/src/settlement-math";

const NOW = "2026-08-23T15:00:00.000Z";
const DANDA_SELLER = "seller-1779315416119";

const TARIFFS = {
  sellerDeliveredFeeCop: 12000,
  sellerFailedFeeCop: 12000,
  fulfillmentFeeCop: 2000,
  driverDeliveredPayCop: 8000,
  driverFailedPayCop: 8000
};

function entry(over: Partial<WalletEntryDoc> & Pick<WalletEntryDoc, "id" | "ownerType" | "type" | "amountCop" | "orderId">): WalletEntryDoc {
  return { ownerId: "owner", description: "asiento", createdAt: "2026-08-01T10:00:00.000Z", settlementId: "", ...over };
}

function settlement(over: Partial<SettlementDoc> & Pick<SettlementDoc, "id" | "kind" | "status">): SettlementDoc {
  return {
    ownerId: "owner",
    ownerName: "Cuenta",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    walletEntryIds: [],
    orderIds: [],
    codCop: 0,
    feesCop: 0,
    driverPayCop: 0,
    platformMarginCop: 0,
    netCop: 0,
    createdAt: "2026-08-08T00:00:00.000Z",
    ...over
  };
}

function plan(over: Partial<PlanInput> & { request: CorrectionRequest; order: Record<string, any> }) {
  const entries = over.entries ?? [];
  return planOrderCorrection({
    entries,
    settlementsById: new Map(),
    cashInputs: {
      sellerEntries: entries.filter((item) => item.ownerType === "seller"),
      driverEntries: entries.filter((item) => item.ownerType === "driver"),
      orderMeta: new Map()
    },
    tariffs: TARIFFS,
    productCostLines: [],
    sellerPaysInCash: false,
    driverExists: true,
    actorId: "admin-uid",
    now: NOW,
    ...over
  });
}

const byId = (list: WalletEntryDoc[]) => new Map(list.map((item) => [item.id, item.amountCop]));

describe("planOrderCorrection - fallido a entregado", () => {
  const order = {
    id: "o1",
    trackingCode: "KNT-000001",
    status: "failed",
    sellerId: "seller-1",
    driverId: "driver-1",
    paymentMethod: "cod",
    totalCop: 100000,
    failedCategory: "failed_visit",
    failedReason: "Cliente no contesta",
    evidence: [{ id: "ev-1", type: "failed", photoLabel: "Fachada", note: "nadie abrio", reason: "Cliente no recibe", failedCategory: "failed_visit", createdAt: "2026-08-02T10:00:00.000Z", actorId: "driver-1" }]
  };
  const request: CorrectionRequest = { kind: "failed_to_delivered", reason: "El cliente confirmo que si recibio el pedido." };

  it("sin asientos previos crea los canonicos y no borra nada", () => {
    const result = plan({ order, request });
    expect(result.blockers).toEqual([]);
    expect(result.entriesToDelete).toEqual([]);
    expect(result.entriesToCompensate).toEqual([]);
    expect(byId(result.entriesToCreate)).toEqual(
      new Map([
        ["we-o1-cod", 100000],
        ["we-o1-seller-delivery-fee", -12000],
        ["we-o1-driver-delivery-pay", 8000]
      ])
    );
    expect(result.toStatus).toBe("delivered");
    expect(result.financials.sellerDeltaCop).toBe(88000);
  });

  it("reetiqueta la evidencia a entrega y borra los rotulos de fallido", () => {
    const result = plan({ order, request });
    const evidence = result.orderPatch.evidence as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ type: "delivery", photoLabel: "Fachada", note: "nadie abrio" });
    expect(evidence[0].failedCategory).toBeUndefined();
    expect(evidence[0].reason).toBeUndefined();
    expect(result.orderPatchPreview.failedCategory).toBe("(se borra)");
    expect(result.orderPatchPreview.retryDecision).toBe("(se borra)");
  });

  it("bloquea si nadie hizo la entrega (evita una wallet 'unassigned')", () => {
    const result = plan({ order: { ...order, driverId: undefined }, request });
    expect(result.blockers.map((item) => item.code)).toContain("missing_driver");
  });

  it("KNT-003316: con el pago de la visita en un corte CONCILIADO, lo compensa sin tocar el corte", () => {
    // Corte conciliado: crear los asientos de entrega aunque el pago netee a cero es lo unico
    // que hace reaparecer el pedido en el proximo corte y permite cobrar los 129.900.
    const orderKnt = { ...order, id: "onstock-1", trackingCode: "KNT-003316", totalCop: 129900 };
    const entries = [
      entry({ id: "we-onstock-1-seller-failed-fee", ownerType: "seller", ownerId: "seller-1", type: "failed_fee", amountCop: -12000, orderId: "onstock-1" }),
      entry({ id: "we-onstock-1-driver-failed-pay", ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 8000, orderId: "onstock-1", settlementId: "stl-conciliado" })
    ];
    const result = plan({
      order: orderKnt,
      request,
      entries,
      settlementsById: new Map([["stl-conciliado", settlement({ id: "stl-conciliado", kind: "driver", status: "reconciled", ownerName: "Lider" })]]),
      productCostLines: [{ productId: "p1", productName: "Producto", totalCostCop: 46000 }]
    });

    expect(result.blockers).toEqual([]);
    // El cobro de fallido nunca debio existir y no estaba liquidado: se borra.
    expect(result.entriesToDelete.map((item) => item.id)).toEqual(["we-onstock-1-seller-failed-fee"]);
    // El pago ya conciliado se compensa; el corte queda intacto.
    expect(result.entriesToCompensate).toHaveLength(1);
    expect(result.entriesToCompensate[0]).toMatchObject({ sourceId: "we-onstock-1-driver-failed-pay", frozenSettlementId: "stl-conciliado" });
    expect(result.entriesToCompensate[0].entry).toMatchObject({
      id: "we-onstock-1-correction-reverse-driver-failed-pay",
      type: "driver_earning",
      amountCop: -8000,
      settlementId: ""
    });
    expect(byId(result.entriesToCreate)).toEqual(
      new Map([
        ["we-onstock-1-cod", 129900],
        ["we-onstock-1-seller-delivery-fee", -12000],
        ["we-onstock-1-driver-delivery-pay", 8000],
        ["we-onstock-1-product-cost", -46000]
      ])
    );
    // El domiciliario queda neteado: cobra la entrega y devuelve el pago del fallido.
    expect(result.financials.driverNetAfterCop).toBe(8000);
    // El cobro de fallido (-12.000) se borro: no entra en el neto final.
    expect(result.financials.sellerNetAfterCop).toBe(129900 - 12000 - 46000);
    expect(result.financials.sellerDeltaCop).toBe(71900 - -12000);
    expect(result.settlementsToRecalculate).toEqual([]);
    expect(result.frozenSettlements.map((item) => item.id)).toEqual(["stl-conciliado"]);
    expect(result.warnings.map((item) => item.code)).toContain("frozen_settlement");
  });
});

describe("planOrderCorrection - entregado a fallido", () => {
  const baseOrder = {
    id: "o2",
    trackingCode: "KNT-002929",
    status: "delivered",
    sellerId: "seller-2",
    driverId: "driver-2",
    paymentMethod: "cod",
    totalCop: 78900,
    evidence: [{ id: "ev-1", type: "delivery", photoLabel: "Entrega", note: "recibido", createdAt: "2026-08-02T10:00:00.000Z", actorId: "driver-2" }]
  };
  const request: CorrectionRequest = { kind: "delivered_to_failed", reason: "El cliente nunca recibio el pedido.", failedCategory: "failed_visit" };

  it("KNT-002929: con el pago en un corte PENDIENTE, lo hereda al asiento de fallido y recalcula el corte", () => {
    const entries = [
      entry({ id: "we-o2-cod", ownerType: "seller", ownerId: "seller-2", type: "cod_revenue", amountCop: 78900, orderId: "o2", settlementId: "stl-pend" }),
      entry({ id: "we-o2-seller-delivery-fee", ownerType: "seller", ownerId: "seller-2", type: "delivery_fee", amountCop: -12000, orderId: "o2", settlementId: "stl-pend" }),
      entry({ id: "we-o2-driver-delivery-pay", ownerType: "driver", ownerId: "driver-2", type: "driver_earning", amountCop: 8000, orderId: "o2", settlementId: "stl-pend" })
    ];
    const result = plan({
      order: baseOrder,
      request,
      entries,
      settlementsById: new Map([
        ["stl-pend", settlement({ id: "stl-pend", kind: "driver", status: "pending", ownerId: "driver-2", ownerName: "Lider", walletEntryIds: entries.map((item) => item.id), orderIds: ["o2"] })]
      ])
    });

    expect(result.blockers).toEqual([]);
    expect(result.entriesToDelete.map((item) => item.id).sort()).toEqual(["we-o2-cod", "we-o2-driver-delivery-pay", "we-o2-seller-delivery-fee"]);
    expect(result.entriesToCompensate).toEqual([]);

    const created = new Map(result.entriesToCreate.map((item) => [item.id, item]));
    // El pago de la visita hereda el corte: si naciera abierto se partiria entre dos cortes.
    expect(created.get("we-o2-driver-failed-pay")).toMatchObject({ amountCop: 8000, settlementId: "stl-pend" });
    // El cobro al vendedor cambia de naturaleza (recaudo -> cobro de fallido): nace abierto.
    expect(created.get("we-o2-seller-failed-fee")).toMatchObject({ amountCop: -12000, settlementId: "" });

    expect(result.settlementsToRecalculate).toHaveLength(1);
    const recalculated = result.settlementsToRecalculate[0];
    expect(recalculated.id).toBe("stl-pend");
    // walletEntryIds y orderIds se re-derivan del conjunto FINAL, nunca se conservan.
    expect(recalculated.patch.walletEntryIds).toEqual(["we-o2-driver-failed-pay"]);
    expect(recalculated.patch.orderIds).toEqual(["o2"]);
    // Sin recaudo, el domiciliario ya no debe efectivo: solo se le paga la visita.
    expect(recalculated.patch.cashExpectedCop).toBe(0);
    expect(recalculated.patch.netCop).toBe(8000);
    expect(recalculated.relatedEntryPatches).toEqual([
      { id: "we-stl-pend-cash-shortage", amountCop: 0, reason: "faltante de recaudo recalculado" }
    ]);
  });

  it("KNT-003259: DANDA con TODO conciliado no toca ningun corte y publica tres compensatorios", () => {
    // En DANDA un fallido no genera cobro ni pago: el estado financiero correcto es neto 0.
    const orderDanda = { ...baseOrder, id: "o3", trackingCode: "KNT-003259", sellerId: DANDA_SELLER, totalCop: 89900 };
    const entries = [
      entry({ id: "we-o3-cod", ownerType: "seller", ownerId: DANDA_SELLER, type: "cod_revenue", amountCop: 89900, orderId: "o3", settlementId: "stl-seller" }),
      entry({ id: "we-o3-seller-delivery-fee", ownerType: "seller", ownerId: DANDA_SELLER, type: "delivery_fee", amountCop: -13500, orderId: "o3", settlementId: "stl-seller" }),
      entry({ id: "we-o3-driver-delivery-pay", ownerType: "driver", ownerId: "driver-2", type: "driver_earning", amountCop: 11000, orderId: "o3", settlementId: "stl-driver" })
    ];
    const result = plan({
      order: orderDanda,
      request: { ...request, failedCategory: "bad_order_or_no_contact" },
      entries,
      settlementsById: new Map([
        ["stl-seller", settlement({ id: "stl-seller", kind: "seller", status: "reconciled", ownerId: DANDA_SELLER, ownerName: "DANDA" })],
        ["stl-driver", settlement({ id: "stl-driver", kind: "driver", status: "reconciled", ownerId: "driver-2", ownerName: "Lider" })]
      ])
    });

    expect(result.blockers).toEqual([]);
    expect(result.entriesToDelete).toEqual([]);
    expect(result.entriesToCreate).toEqual([]);
    expect(result.settlementsToRecalculate).toEqual([]);
    expect(byId(result.entriesToCompensate.map((item) => item.entry))).toEqual(
      new Map([
        ["we-o3-correction-reverse-cod", -89900],
        ["we-o3-correction-reverse-seller-delivery-fee", 13500],
        ["we-o3-correction-reverse-driver-delivery-pay", -11000]
      ])
    );
    // La reversa del recaudo va como remesa, no como ingreso negativo.
    expect(result.entriesToCompensate.find((item) => item.sourceId === "we-o3-cod")!.entry.type).toBe("cod_remittance");
    // DANDA queda debiendo lo que ya se le abono por una venta que no existio.
    expect(result.financials.sellerDeltaCop).toBe(-76400);
    expect(result.financials.sellerNetAfterCop).toBe(0);
    expect(result.financials.driverNetAfterCop).toBe(0);
    expect(result.frozenSettlements.map((item) => item.id).sort()).toEqual(["stl-driver", "stl-seller"]);
  });

  it("avisa cuando la tarifa de la tienda no genera cobro por el fallido", () => {
    const result = plan({ order: { ...baseOrder, sellerId: DANDA_SELLER }, request });
    expect(result.warnings.map((item) => item.code)).toContain("danda_zero_fee");
  });

  it("reetiqueta la evidencia a fallido conservando la nota original", () => {
    const result = plan({ order: baseOrder, request });
    const evidence = result.orderPatch.evidence as Array<Record<string, unknown>>;
    expect(evidence[0]).toMatchObject({ type: "failed", photoLabel: "Entrega", note: "recibido", reason: "recibido", failedCategory: "failed_visit" });
    expect(result.orderPatch.failedCategorySource).toBe("manual");
    expect(result.failedAttempt).toBe(1);
  });

  it("mezcla corte congelado y corte pendiente sobre el mismo pedido", () => {
    const entries = [
      entry({ id: "we-o4-cod", ownerType: "seller", ownerId: "seller-2", type: "cod_revenue", amountCop: 50000, orderId: "o4", settlementId: "stl-pagado" }),
      entry({ id: "we-o4-driver-delivery-pay", ownerType: "driver", ownerId: "driver-2", type: "driver_earning", amountCop: 8000, orderId: "o4", settlementId: "stl-abierto" })
    ];
    const result = plan({
      order: { ...baseOrder, id: "o4", totalCop: 50000 },
      request,
      entries,
      settlementsById: new Map([
        ["stl-pagado", settlement({ id: "stl-pagado", kind: "seller", status: "paid", ownerId: "seller-2", ownerName: "Tienda" })],
        ["stl-abierto", settlement({ id: "stl-abierto", kind: "driver", status: "pending", ownerId: "driver-2", ownerName: "Lider", walletEntryIds: ["we-o4-driver-delivery-pay"], orderIds: ["o4"] })]
      ])
    });
    expect(result.entriesToCompensate.map((item) => item.sourceId)).toEqual(["we-o4-cod"]);
    expect(result.entriesToDelete.map((item) => item.id)).toEqual(["we-o4-driver-delivery-pay"]);
    expect(result.settlementsToRecalculate.map((item) => item.id)).toEqual(["stl-abierto"]);
    expect(result.frozenSettlements.map((item) => item.id)).toEqual(["stl-pagado"]);
  });
});

describe("planOrderCorrection - reabrir para nueva visita", () => {
  const order = {
    id: "o5",
    trackingCode: "KNT-002682",
    status: "failed",
    sellerId: "seller-3",
    driverId: "driver-3",
    paymentMethod: "cod",
    totalCop: 60000,
    failedCategory: "failed_visit",
    evidence: [{ id: "ev-1", type: "failed", photoLabel: "Fachada", note: "nadie", failedCategory: "failed_visit", createdAt: "2026-08-02T10:00:00.000Z", actorId: "driver-3" }]
  };
  const request: CorrectionRequest = {
    kind: "failed_to_retry_pending",
    reason: "El cliente pidio recibir el jueves.",
    scheduledDate: "2026-08-27",
    scheduledWindow: "11:00 AM - 2:00 PM"
  };

  it("no toca ni un asiento: la visita perdida se hizo y se cobra", () => {
    const entries = [
      entry({ id: "we-o5-seller-failed-fee", ownerType: "seller", ownerId: "seller-3", type: "failed_fee", amountCop: -12000, orderId: "o5" }),
      entry({ id: "we-o5-driver-failed-pay", ownerType: "driver", ownerId: "driver-3", type: "driver_earning", amountCop: 8000, orderId: "o5" })
    ];
    const result = plan({ order, request, entries });
    expect(result.blockers).toEqual([]);
    expect(result.entriesToDelete).toEqual([]);
    expect(result.entriesToCreate).toEqual([]);
    expect(result.entriesToCompensate).toEqual([]);
    expect(result.entriesToKeep).toHaveLength(2);
    expect(result.settlementsToRecalculate).toEqual([]);
    expect(result.financials.sellerDeltaCop).toBe(0);
    expect(result.orderPatch.status).toBe("retry_pending");
    expect(result.orderPatch.retryDecision).toBe("retry");
    expect(result.orderPatch.scheduledDate).toBe("2026-08-27");
    // La evidencia de la visita perdida se conserva intacta: es el soporte del cobro.
    expect(result.orderPatch.evidence).toBeUndefined();
    for (const field of ["failedReason", "failedCategory", "failedCategorySource", "failedCategoryConfidence"]) {
      expect(result.orderPatchPreview[field]).toBe("(se borra)");
    }
  });

  it("avisa (sin bloquear) cuando los asientos de la visita ya estan liquidados", () => {
    const result = plan({
      order,
      request,
      entries: [entry({ id: "we-o5-seller-failed-fee", ownerType: "seller", type: "failed_fee", amountCop: -12000, orderId: "o5", settlementId: "stl-x" })],
      settlementsById: new Map([["stl-x", settlement({ id: "stl-x", kind: "seller", status: "paid" })]])
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toContain("settled_entries_kept");
  });

  it("exige fecha y franja", () => {
    const result = plan({ order, request: { ...request, scheduledDate: undefined } });
    expect(result.blockers.map((item) => item.code)).toContain("kind_status_mismatch");
  });
});

describe("planOrderCorrection - reactivar un pedido anulado", () => {
  const order = { id: "o6", trackingCode: "KNT-003595", status: "cancelled", sellerId: "seller-4", paymentMethod: "cod", totalCop: 40000, evidence: [] };

  it("vuelve al estado operativo elegido sin mover dinero", () => {
    const result = plan({ order, request: { kind: "cancelled_to_operational", reason: "Se anulo por error, el cliente si lo quiere.", targetStatus: "ready_to_assign" } });
    expect(result.blockers).toEqual([]);
    expect(result.toStatus).toBe("ready_to_assign");
    expect(result.entriesToCreate).toEqual([]);
    expect(result.orderPatchPreview.cancelReason).toBe("(se borra)");
  });

  it("bloquea si el pedido anulado arrastra asientos de wallet", () => {
    const result = plan({
      order,
      request: { kind: "cancelled_to_operational", reason: "Se anulo por error.", targetStatus: "ready_to_assign" },
      entries: [entry({ id: "we-o6-cod", ownerType: "seller", type: "cod_revenue", amountCop: 40000, orderId: "o6" })]
    });
    expect(result.blockers.map((item) => item.code)).toContain("entries_on_cancelled");
  });
});

describe("planOrderCorrection - guardas transversales", () => {
  it("rechaza corregir un pedido que ya esta en el estado destino (doble correccion)", () => {
    const result = plan({
      order: { id: "o7", status: "delivered", sellerId: "s", driverId: "d", paymentMethod: "cod", totalCop: 1000, evidence: [] },
      request: { kind: "failed_to_delivered", reason: "Ya se corrigio antes por script." }
    });
    expect(result.blockers.map((item) => item.code)).toContain("wrong_status");
  });

  it("rechaza un pedido ya liquidado", () => {
    const result = plan({
      order: { id: "o8", status: "liquidated", sellerId: "s", driverId: "d", paymentMethod: "cod", totalCop: 1000, evidence: [] },
      request: { kind: "delivered_to_failed", reason: "El dinero ya se giro." }
    });
    expect(result.blockers.map((item) => item.code)).toContain("liquidated_order");
  });

  it("rechaza un asiento que apunta a un corte inexistente", () => {
    const result = plan({
      order: { id: "o9", status: "delivered", sellerId: "s", driverId: "d", paymentMethod: "cod", totalCop: 1000, evidence: [] },
      request: { kind: "delivered_to_failed", reason: "El cliente nunca recibio." },
      entries: [entry({ id: "we-o9-cod", ownerType: "seller", type: "cod_revenue", amountCop: 1000, orderId: "o9", settlementId: "stl-fantasma" })]
    });
    expect(result.blockers.map((item) => item.code)).toContain("settlement_missing");
  });

  it("invariante: ningun asiento a crear tiene un id que ya exista en el pedido", () => {
    const cases = [
      plan({
        order: { id: "oa", status: "failed", sellerId: "s", driverId: "d", paymentMethod: "cod", totalCop: 1000, failedCategory: "failed_visit", evidence: [] },
        request: { kind: "failed_to_delivered", reason: "El cliente si recibio el pedido." },
        entries: [entry({ id: "we-oa-seller-failed-fee", ownerType: "seller", type: "failed_fee", amountCop: -12000, orderId: "oa" })]
      }),
      plan({
        order: { id: "ob", status: "delivered", sellerId: "s", driverId: "d", paymentMethod: "cod", totalCop: 1000, evidence: [] },
        request: { kind: "delivered_to_failed", reason: "El cliente nunca recibio." },
        entries: [entry({ id: "we-ob-cod", ownerType: "seller", type: "cod_revenue", amountCop: 1000, orderId: "ob" })]
      })
    ];
    for (const result of cases) {
      const survivors = new Set([...result.entriesToKeep, ...result.entriesToCompensate.map((item) => item.entry)].map((item) => item.id));
      for (const created of result.entriesToCreate) expect(survivors.has(created.id)).toBe(false);
      expect(result.blockers.map((item) => item.code)).not.toContain("entry_id_collision");
    }
  });

  it("marca el inventario solo cuando el pedido tenia reserva propia", () => {
    const base = { id: "oc", status: "failed", sellerId: "s", driverId: "d", paymentMethod: "cod", totalCop: 1000, sku: "SKU-1", quantity: 2, evidence: [] };
    const request: CorrectionRequest = { kind: "failed_to_delivered", reason: "El cliente si recibio el pedido." };
    expect(plan({ order: base, request }).inventory.kind).toBe("none");
    const reserved = plan({ order: { ...base, inventoryReserved: true }, request });
    // El cierre fallido ya libero la reserva: solo falta descontar de disponible.
    expect(reserved.inventory.kind).toBe("consume_available");
    expect(reserved.inventory.movements).toEqual([{ skuKey: "SKU-1", quantity: 2 }]);
  });
});

describe("reversalEntryFor", () => {
  it("deriva el id del original y convierte el recaudo en remesa", () => {
    const reversal = reversalEntryFor(
      entry({ id: "we-o1-cod", ownerType: "seller", ownerId: "s1", type: "cod_revenue", amountCop: 89900, orderId: "o1", description: "Recaudo COD pedido #1" }),
      NOW
    );
    expect(reversal).toMatchObject({
      id: "we-o1-correction-reverse-cod",
      type: "cod_remittance",
      amountCop: -89900,
      ownerId: "s1",
      settlementId: ""
    });
    expect(reversal.description).toContain("Reversa por correccion");
  });

  it("conserva proveedor y producto para que el costo revertido siga imputado", () => {
    const reversal = reversalEntryFor(
      entry({ id: "we-o1-product-cost-p1", ownerType: "seller", type: "product_cost", amountCop: -46000, orderId: "o1", supplierId: "sup-1", supplierName: "Proveedor", productId: "p1", productName: "Producto" }),
      NOW
    );
    expect(reversal).toMatchObject({
      id: "we-o1-correction-reverse-product-cost-p1",
      type: "product_cost",
      amountCop: 46000,
      supplierId: "sup-1",
      productId: "p1",
      supplierSettlementId: ""
    });
  });
});

describe("relabelEvidence", () => {
  const options = { reason: "Correccion administrativa del admin", actorId: "admin-uid", now: NOW, orderId: "o1" };

  it("sintetiza una evidencia COMPLETA cuando el pedido no tiene ninguna", () => {
    // photoLabel y note son obligatorios en el tipo Evidence; los scripts los omitian.
    const [synthetic] = relabelEvidence([], "to_delivery", options);
    expect(synthetic.photoLabel).toBeTruthy();
    expect(synthetic.note).toBe(options.reason);
    expect(synthetic.type).toBe("delivery");
    expect(synthetic.actorId).toBe("admin-uid");
  });

  it("la evidencia sintetizada de un fallido lleva motivo y categoria", () => {
    const [synthetic] = relabelEvidence([], "to_failed", { ...options, failedCategory: "bad_phone" });
    expect(synthetic).toMatchObject({ type: "failed", failedCategory: "bad_phone", reason: options.reason });
  });

  it("nunca pierde photoLabel ni note al reetiquetar", () => {
    const original = { id: "ev-1", type: "delivery" as const, photoLabel: "Entrega", note: "recibido", photoUrl: "https://x/y.jpg", storagePath: "evidence/o1/y.jpg", createdAt: NOW, actorId: "driver-1" };
    for (const direction of ["to_delivery", "to_failed"] as const) {
      const [result] = relabelEvidence([original], direction, options);
      expect(result.photoLabel).toBe("Entrega");
      expect(result.note).toBe("recibido");
      expect(result.photoUrl).toBe("https://x/y.jpg");
      expect(result.storagePath).toBe("evidence/o1/y.jpg");
    }
  });
});
