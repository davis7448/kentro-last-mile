import { describe, expect, it } from "vitest";
// Spec 038: la unica regla de cuanto efectivo le cobra un corte a un domiciliario.
// T1: lo que un pedido debe hoy (RF_01, RF_02; plan §3.1).
import { orderOwedByDriver } from "../../functions/src/driver-cash-ledger";
import type { WalletEntryDoc } from "../../functions/src/settlement-math";

const DRIVER = "driver-1";

function entry(over: Partial<WalletEntryDoc> & Pick<WalletEntryDoc, "id" | "ownerType" | "type" | "amountCop" | "orderId">): WalletEntryDoc {
  return { ownerId: "seller-1", description: "", createdAt: "2026-08-01T10:00:00.000Z", ...over };
}

const cod = (id: string, orderId: string, amountCop: number, over: Partial<WalletEntryDoc> = {}) =>
  entry({ id, ownerType: "seller", type: "cod_revenue", amountCop, orderId, ...over });
const pay = (id: string, orderId: string, amountCop: number, over: Partial<WalletEntryDoc> = {}) =>
  entry({ id, ownerType: "driver", ownerId: DRIVER, type: "driver_earning", amountCop, orderId, ...over });

describe("orderOwedByDriver", () => {
  it("debido = recaudo vigente menos el pago del domiciliario", () => {
    const owed = orderOwedByDriver([cod("c1", "o1", 100000), pay("p1", "o1", 8000)], DRIVER);
    expect(owed.get("o1")).toEqual({ orderId: "o1", codCop: 100000, driverPayCop: 8000, owedCop: 92000 });
  });

  it("una reversa de recaudo (cod_remittance negativo) resta", () => {
    // Causa 1 de la spec (KNT-003259): entregado y luego corregido a fallido.
    const owed = orderOwedByDriver(
      [
        cod("c1", "o1", 78900),
        entry({ id: "r1", ownerType: "seller", type: "cod_remittance", amountCop: -78900, orderId: "o1" }),
        pay("p1", "o1", 8000)
      ],
      DRIVER
    );
    expect(owed.get("o1")).toMatchObject({ codCop: 0, driverPayCop: 8000, owedCop: -8000 });
  });

  it("el pago de otro domiciliario no cuenta", () => {
    const owed = orderOwedByDriver(
      [cod("c1", "o1", 50000), pay("p1", "o1", 8000), pay("p2", "o1", 7000, { ownerId: "driver-2" })],
      DRIVER
    );
    expect(owed.get("o1")).toMatchObject({ driverPayCop: 8000, owedCop: 42000 });
  });

  it("un pedido con recaudo en dos tiendas suma las dos (cambio de tienda)", () => {
    const owed = orderOwedByDriver(
      [cod("c1", "o1", 27000, { ownerId: "seller-a" }), cod("c2", "o1", 27000, { ownerId: "seller-b" }), pay("p1", "o1", 8000)],
      DRIVER
    );
    expect(owed.get("o1")).toMatchObject({ codCop: 54000, owedCop: 46000 });
  });

  it("ignora asientos sin pedido y tipos que no son recaudo ni pago", () => {
    const owed = orderOwedByDriver(
      [
        cod("c1", "o1", 40000),
        entry({ id: "f1", ownerType: "seller", type: "delivery_fee", amountCop: -12000, orderId: "o1" }),
        entry({ id: "a1", ownerType: "driver", ownerId: DRIVER, type: "cash_shortage", amountCop: -5000, orderId: "o1" }),
        cod("c2", "", 99999)
      ],
      DRIVER
    );
    expect(owed.size).toBe(1);
    expect(owed.get("o1")).toMatchObject({ codCop: 40000, driverPayCop: 0, owedCop: 40000 });
  });

  it("un pedido con solo pago (prepagado) debe negativo", () => {
    const owed = orderOwedByDriver([pay("p1", "o2", 8000)], DRIVER);
    expect(owed.get("o2")).toEqual({ orderId: "o2", codCop: 0, driverPayCop: 8000, owedCop: -8000 });
  });
});
