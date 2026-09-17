import { describe, expect, it } from "vitest";
// Vive en functions/ porque es la misma aritmetica que usan createSettlement,
// recordDriverCashReceipt y la correccion administrativa de pedidos. Antes estaba dentro de
// `calculateDriverCashSummary`, que hacia sus propias lecturas y por eso no tenia NINGUNA
// prueba, pese a ser la funcion que decide cuanto efectivo debe un domiciliario.
import {
  computeDriverCashSummary,
  type DriverCashInputs,
  settlementCashReceivedCop,
  type SettlementDoc,
  settlementTotals,
  type WalletEntryDoc
} from "../../functions/src/settlement-math";
import { isLiquidationWalletType } from "../../functions/src/wallet-entries";

function entry(over: Partial<WalletEntryDoc> & Pick<WalletEntryDoc, "id" | "ownerType" | "type" | "amountCop" | "orderId">): WalletEntryDoc {
  return { ownerId: "owner", description: "", createdAt: "2026-08-01T10:00:00.000Z", ...over };
}

function inputs(over: Partial<DriverCashInputs> = {}): DriverCashInputs {
  return { sellerEntries: [], driverEntries: [], orderMeta: new Map(), ...over };
}

describe("computeDriverCashSummary", () => {
  it("espera el COD menos el pago del domiciliario", () => {
    const summary = computeDriverCashSummary(
      inputs({
        sellerEntries: [
          entry({ id: "we-o1-cod", ownerType: "seller", type: "cod_revenue", amountCop: 100000, orderId: "o1" }),
          entry({ id: "we-o1-fee", ownerType: "seller", type: "delivery_fee", amountCop: -12000, orderId: "o1" })
        ],
        driverEntries: [entry({ id: "we-o1-pay", ownerType: "driver", type: "driver_earning", amountCop: 9000, orderId: "o1" })]
      }),
      ["o1"],
      0
    );
    expect(summary.codCop).toBe(100000);
    expect(summary.feesCop).toBe(12000);
    expect(summary.driverPayCop).toBe(9000);
    expect(summary.platformMarginCop).toBe(3000);
    expect(summary.expectedCop).toBe(91000);
  });

  it("netea cod_remittance contra cod_revenue: un pedido revertido deja el COD en cero", () => {
    // Es el mecanismo del que dependen los asientos compensatorios de la correccion.
    const summary = computeDriverCashSummary(
      inputs({
        sellerEntries: [
          entry({ id: "we-o1-cod", ownerType: "seller", type: "cod_revenue", amountCop: 89900, orderId: "o1" }),
          entry({ id: "we-o1-rev", ownerType: "seller", type: "cod_remittance", amountCop: -89900, orderId: "o1" })
        ],
        driverEntries: [entry({ id: "we-o1-pay", ownerType: "driver", type: "driver_earning", amountCop: 11000, orderId: "o1" })]
      }),
      ["o1"],
      0
    );
    expect(summary.codCop).toBe(0);
    // El domiciliario ya no debe efectivo; al contrario, se le debe el pago de la visita.
    expect(summary.expectedCop).toBe(0);
    expect(summary.driverPayCop).toBe(11000);
  });

  it("ignora asientos de pedidos que no estan en el corte", () => {
    const summary = computeDriverCashSummary(
      inputs({
        sellerEntries: [entry({ id: "we-o9-cod", ownerType: "seller", type: "cod_revenue", amountCop: 50000, orderId: "o9" })]
      }),
      ["o1"],
      0
    );
    expect(summary.codCop).toBe(0);
  });

  it("imputa lo recibido por antiguedad y marca cubierto solo lo que alcanza", () => {
    const summary = computeDriverCashSummary(
      inputs({
        sellerEntries: [
          entry({ id: "we-a-cod", ownerType: "seller", type: "cod_revenue", amountCop: 30000, orderId: "a" }),
          entry({ id: "we-b-cod", ownerType: "seller", type: "cod_revenue", amountCop: 40000, orderId: "b" })
        ],
        orderMeta: new Map([
          ["a", { createdAt: "2026-08-02T10:00:00.000Z", trackingCode: "KNT-000002" }],
          ["b", { createdAt: "2026-08-01T10:00:00.000Z", trackingCode: "KNT-000001" }]
        ])
      }),
      ["a", "b"],
      45000
    );
    // "b" es mas antiguo: se cubre primero y completo; "a" queda parcial.
    expect(summary.allocations.map((item) => item.orderId)).toEqual(["b", "a"]);
    expect(summary.allocations[0]).toMatchObject({ orderId: "b", receivedCop: 40000, covered: true });
    expect(summary.allocations[1]).toMatchObject({ orderId: "a", receivedCop: 5000, covered: false });
  });

  it("desempata por trackingCode cuando la fecha de creacion es la misma", () => {
    const meta = { createdAt: "2026-08-01T10:00:00.000Z" };
    const summary = computeDriverCashSummary(
      inputs({
        sellerEntries: [
          entry({ id: "we-x-cod", ownerType: "seller", type: "cod_revenue", amountCop: 10000, orderId: "x" }),
          entry({ id: "we-y-cod", ownerType: "seller", type: "cod_revenue", amountCop: 10000, orderId: "y" })
        ],
        orderMeta: new Map([
          ["x", { ...meta, trackingCode: "KNT-000009" }],
          ["y", { ...meta, trackingCode: "KNT-000003" }]
        ])
      }),
      ["x", "y"],
      0
    );
    expect(summary.allocations.map((item) => item.orderId)).toEqual(["y", "x"]);
  });

  it("no genera imputacion para pedidos donde el pago supera al recaudo", () => {
    // Un fallido cobrable: el domiciliario cobra y no recauda nada. No debe efectivo.
    const summary = computeDriverCashSummary(
      inputs({
        driverEntries: [entry({ id: "we-o1-fp", ownerType: "driver", type: "driver_earning", amountCop: 9000, orderId: "o1" })]
      }),
      ["o1"],
      0
    );
    expect(summary.allocations).toEqual([]);
    expect(summary.expectedCop).toBe(0);
  });

  it("devuelve ceros cuando el corte no tiene pedidos", () => {
    expect(computeDriverCashSummary(inputs(), [], 0)).toEqual({
      codCop: 0,
      feesCop: 0,
      driverPayCop: 0,
      platformMarginCop: 0,
      expectedCop: 0,
      allocations: []
    });
  });
});

describe("settlementCashReceivedCop", () => {
  const base: SettlementDoc = { id: "s1", kind: "driver", ownerId: "d1", ownerName: "D", startDate: "", endDate: "", walletEntryIds: [], orderIds: [], codCop: 0, feesCop: 0, driverPayCop: 0, platformMarginCop: 0, netCop: 0, status: "pending", createdAt: "" };

  it("prefiere el campo agregado cuando existe", () => {
    expect(settlementCashReceivedCop({ ...base, cashReceivedCop: 5000, cashReceipts: [{ amountCop: 999, receivedAt: "" }] })).toBe(5000);
  });

  it("suma los recibos cuando no hay campo agregado (cortes historicos)", () => {
    expect(settlementCashReceivedCop({ ...base, cashReceipts: [{ amountCop: 3000, receivedAt: "" }, { amountCop: 2000, receivedAt: "" }] })).toBe(5000);
  });

  it("nunca devuelve negativo", () => {
    expect(settlementCashReceivedCop({ ...base, cashReceivedCop: -10 })).toBe(0);
  });
});

describe("settlementTotals", () => {
  it("en un corte de tienda el neto es la suma de sus asientos, menos el 4x1000", () => {
    const totals = settlementTotals(
      "seller",
      [
        entry({ id: "a", ownerType: "seller", type: "cod_revenue", amountCop: 100000, orderId: "o1" }),
        entry({ id: "b", ownerType: "seller", type: "delivery_fee", amountCop: -12000, orderId: "o1" }),
        entry({ id: "c", ownerType: "seller", type: "product_cost", amountCop: -30000, orderId: "o1" })
      ]
    );
    expect(totals.grossNetCop).toBe(58000);
    expect(totals.gmfCop).toBe(232); // 58000 * 0.004
    expect(totals.netCop).toBe(57768);
    expect(totals.productCostCop).toBe(30000);
  });

  it("en un corte de domiciliario el COD y los fletes salen de los asientos de la tienda", () => {
    const totals = settlementTotals(
      "driver",
      [entry({ id: "pay", ownerType: "driver", type: "driver_earning", amountCop: 9000, orderId: "o1" })],
      [
        entry({ id: "cod", ownerType: "seller", type: "cod_revenue", amountCop: 100000, orderId: "o1" }),
        entry({ id: "fee", ownerType: "seller", type: "delivery_fee", amountCop: -12000, orderId: "o1" })
      ]
    );
    expect(totals.codCop).toBe(100000);
    expect(totals.feesCop).toBe(12000);
    expect(totals.driverPayCop).toBe(9000);
    expect(totals.platformMarginCop).toBe(3000);
    // Negativo: el domiciliario ENTREGA plata, no la recibe. Sin giro no hay 4x1000.
    expect(totals.grossNetCop).toBe(-91000);
    expect(totals.gmfCop).toBe(0);
    expect(totals.netCop).toBe(-91000);
  });

  it("en un corte de proveedor el neto es el costo de producto y no hay margen", () => {
    const totals = settlementTotals("supplier", [
      entry({ id: "pc", ownerType: "seller", type: "product_cost", amountCop: -46000, orderId: "o1" })
    ]);
    expect(totals.grossNetCop).toBe(46000);
    expect(totals.platformMarginCop).toBe(0);
    expect(totals.gmfCop).toBe(184);
  });

  it("no retiene 4x1000 cuando la cuenta cobra en efectivo", () => {
    const totals = settlementTotals("seller", [entry({ id: "a", ownerType: "seller", type: "cod_revenue", amountCop: 100000, orderId: "o1" })], [], true);
    expect(totals.gmfCop).toBe(0);
    expect(totals.netCop).toBe(100000);
  });
});

describe("T8 · cortes de lider de comunidad", () => {
  const cashback = (id: string, amountCop: number): WalletEntryDoc => ({
    id,
    ownerType: "community_leader",
    ownerId: "com-1",
    orderId: id.replace("we-", "").split("-")[0],
    type: "community_cashback",
    amountCop,
    description: "Cashback comunidad",
    createdAt: "2026-09-05T10:00:00.000Z"
  });

  it("RF_26: el neto de un corte de lider es la suma de sus cashbacks, menos el 4x1000", () => {
    // El cashback se gira por transferencia como cualquier otro pago, asi que paga GMF igual
    // que el resto: 7.500 - 30. RF_26 pide el MISMO mecanismo, no uno privilegiado.
    const totals = settlementTotals("community_leader", [cashback("we-o1-cb", 3000), cashback("we-o2-cb", 4500)]);
    expect(totals.gmfCop).toBe(30);
    expect(totals.netCop).toBe(7470);
    expect(totals.driverPayCop).toBe(0);
    expect(totals.codCop).toBe(0);
  });

  it("RF_26: una reversa de correccion resta del corte del lider", () => {
    const totals = settlementTotals("community_leader", [cashback("we-o1-cb", 3000), cashback("we-o1-rev", -3000)]);
    expect(totals.netCop).toBe(0);
  });

  it("RF_26: el cashback es un tipo liquidable, o quedaria como saldo abierto para siempre", () => {
    expect(isLiquidationWalletType("community_cashback")).toBe(true);
  });
});

describe("T33 · el corte del lider convierte el cashback causado en pagado", () => {
  // RF_49 parte en dos: la ARITMETICA del corte (aqui) y el REPARTO causado/pagado que pinta el
  // panel (en community-view.test.ts). Lo que NO se cubre en ninguno de los dos es "nadie mas
  // puede marcarlo pagado": esa autorizacion vive en functions/src/orders.ts, que importa
  // firebase-admin y por tanto no se puede cargar desde la raiz del repo.
  const cashbackT33 = (id: string, amountCop: number): WalletEntryDoc => ({
    id,
    ownerType: "community_leader",
    ownerId: "com-1",
    orderId: id.split("-")[1] ?? "o1",
    type: "community_cashback",
    amountCop,
    description: "Cashback comunidad",
    createdAt: "2026-09-08T10:00:00.000Z"
  });

  it("RF_49: el neto que se marca pagado es la suma de los cashbacks del periodo, menos el 4x1000", () => {
    // Este es el numero que el lider ve como "pagado" en cuanto el corte cambia de estado. Si el
    // corte y el panel no salen de la misma aritmetica, el lider ve una cifra y cobra otra.
    const totals = settlementTotals("community_leader", [cashbackT33("we-o1", 5000), cashbackT33("we-o2", 7000)]);
    expect(totals.grossNetCop).toBe(12000);
    expect(totals.gmfCop).toBe(48);
    expect(totals.netCop).toBe(11952);
  });

  it("RF_49: una reversa de correccion netea contra su cashback y no se cuenta dos veces", () => {
    // Un pedido corregido de entregado a fallido deja el asiento original MAS su reversa. Sumar
    // valores absolutos pagaria el cashback de un pedido que nunca se entrego.
    const totals = settlementTotals("community_leader", [
      cashbackT33("we-o1", 9000),
      cashbackT33("we-o2", 4000),
      cashbackT33("we-o2-correction-reverse", -4000)
    ]);
    expect(totals.grossNetCop).toBe(9000);
    expect(totals.netCop).toBe(8964);
    // La trampa concreta: 13.000 es lo que sale si la reversa se suma en absoluto.
    expect(totals.grossNetCop).not.toBe(13000);
  });

  it("RF_49: el corte del lider no arrastra COD ni pago a domiciliario: solo su cashback", () => {
    const soloCashback = [cashbackT33("we-o1", 6000)];
    const totals = settlementTotals("community_leader", soloCashback);
    expect(totals.codCop).toBe(0);
    expect(totals.driverPayCop).toBe(0);
    expect(totals.productCostCop).toBe(0);
    expect(totals.platformMarginCop).toBe(0);
    expect(totals.feesCop).toBe(0);
    expect(totals.grossNetCop).toBe(6000);

    // Los asientos de la tienda del mismo pedido no pueden inflar lo que se le paga al lider:
    // el cashback ya es una fraccion del margen, no el recaudo.
    const conAsientosDeTienda = settlementTotals("community_leader", soloCashback, [
      entry({ id: "cod", ownerType: "seller", type: "cod_revenue", amountCop: 180000, orderId: "o1" }),
      entry({ id: "dp", ownerType: "driver", type: "driver_earning", amountCop: 9000, orderId: "o1" })
    ]);
    expect(conAsientosDeTienda.netCop).toBe(totals.netCop);
    expect(conAsientosDeTienda.codCop).toBe(0);
  });
});
