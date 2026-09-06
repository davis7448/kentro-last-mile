import { describe, expect, it } from "vitest";
import { calculatePlatformPosition } from "./finance";
import { emptyState } from "./seed";
import type { AppState, Settlement, WalletEntry } from "./types";

/**
 * La posicion de la plataforma vive dos veces: cliente (`src/lib/finance.ts`) y servidor
 * (`functions/src/platform-position.ts`), porque functions no puede importar del cliente. El
 * servidor existe para que el navegador del admin deje de bajarse los 10.452 asientos del ledger
 * (3,58 MB, el 68% de su carga) solo para derivar quince cifras.
 *
 * Esta prueba las ata. Si divergen, el admin ve una caja y una utilidad que no cuadran con lo que
 * tiene delante, y eso no se detecta a ojo: se detecta aqui.
 */

let nextId = 0;
function entry(partial: Partial<WalletEntry> & Pick<WalletEntry, "ownerType" | "type" | "amountCop">): WalletEntry {
  nextId += 1;
  return {
    id: `w${nextId}`,
    ownerId: "seller-1",
    orderId: `order-${nextId}`,
    description: "",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...partial
  } as WalletEntry;
}

function settlement(partial: Partial<Settlement> & Pick<Settlement, "id" | "kind">): Settlement {
  return {
    ownerId: "seller-1",
    ownerName: "Tienda",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    walletEntryIds: [],
    orderIds: [],
    codCop: 0,
    feesCop: 0,
    driverPayCop: 0,
    platformMarginCop: 0,
    netCop: 0,
    status: "pending",
    createdAt: "2026-08-08T10:00:00.000Z",
    ...partial
  } as Settlement;
}

/** Un escenario con las cuatro cosas que NO son una simple suma agregable. */
function scenario(): { wallet: WalletEntry[]; settlements: Settlement[] } {
  const wallet: WalletEntry[] = [
    // Corte de tienda ya pagado: entra en "pagado a tiendas".
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 150_000, orderId: "o1", settlementId: "s-paid" }),
    entry({ ownerType: "seller", type: "delivery_fee", amountCop: -12_000, orderId: "o1", settlementId: "s-paid" }),
    // Corte de tienda pendiente: NO cuenta como pagado, si como saldo por pagar.
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 90_000, orderId: "o2", settlementId: "" }),
    entry({ ownerType: "seller", type: "failed_fee", amountCop: -8_000, orderId: "o2", settlementId: "" }),
    // Abono entregado por fuera del corte.
    entry({ ownerType: "seller", type: "seller_abono", amountCop: -40_000, orderId: "" }),
    // COD de un pedido que NO esta en ningun corte de domiciliario.
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 70_000, orderId: "o3", settlementId: "" }),
    entry({ ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 6_000, orderId: "o3" }),
    // COD de un pedido que SI esta en un corte de domiciliario.
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 50_000, orderId: "o4", settlementId: "" }),
    entry({ ownerType: "driver", ownerId: "driver-1", type: "driver_earning", amountCop: 5_000, orderId: "o4" }),
    // Costo de producto retenido, dos proveedores distintos y uno sin proveedor.
    entry({ ownerType: "seller", type: "product_cost", amountCop: -30_000, orderId: "o5", supplierId: "sup-1", supplierName: "Proveedor Uno" }),
    entry({ ownerType: "seller", type: "product_cost", amountCop: -20_000, orderId: "o6", supplierId: "sup-2", supplierName: "Proveedor Dos" }),
    entry({ ownerType: "seller", type: "product_cost", amountCop: -5_000, orderId: "o7" }),
    // Retenido que YA se pago al proveedor: no cuenta.
    entry({ ownerType: "seller", type: "product_cost", amountCop: -9_000, orderId: "o8", supplierId: "sup-1", supplierSettlementId: "sup-cut" }),
    entry({ ownerType: "seller", type: "fulfillment_fee", amountCop: -3_000, orderId: "o5", settlementId: "" })
  ];

  const settlements: Settlement[] = [
    settlement({ id: "s-paid", kind: "seller", status: "paid" }),
    settlement({ id: "s-open", kind: "seller", status: "pending" }),
    settlement({
      id: "d-1",
      kind: "driver",
      ownerId: "driver-1",
      orderIds: ["o4"],
      cashReceivedCop: 45_000,
      cashPendingCop: 10_000,
      status: "pending"
    })
  ];

  return { wallet, settlements };
}

function stateFrom(wallet: WalletEntry[], settlements: Settlement[]): AppState {
  return { ...emptyState(), wallet, settlements };
}

describe("las dos copias de la posicion de plataforma coinciden", () => {
  it("dan las mismas quince cifras sobre un escenario completo", async () => {
    const servidor = await import("../../functions/src/platform-position");
    const { wallet, settlements } = scenario();

    const cliente = calculatePlatformPosition(stateFrom(wallet, settlements));
    // Los tipos de documento del servidor son estructuralmente los mismos; el cast solo evita
    // arrastrar las definiciones duplicadas hasta aqui.
    const remoto = servidor.computePlatformPosition(
      wallet as unknown as Parameters<typeof servidor.computePlatformPosition>[0],
      settlements as unknown as Parameters<typeof servidor.computePlatformPosition>[1]
    );

    expect(remoto).toEqual(cliente);
  });

  it("coinciden tambien con el ledger vacio", async () => {
    const servidor = await import("../../functions/src/platform-position");
    expect(servidor.computePlatformPosition([], [])).toEqual(calculatePlatformPosition(stateFrom([], [])));
  });

  it("el escenario ejercita de verdad las cifras que no son una suma simple", () => {
    const { wallet, settlements } = scenario();
    const position = calculatePlatformPosition(stateFrom(wallet, settlements));

    // Si alguna de estas quedara en cero, la prueba de arriba pasaria sin comparar nada util.
    expect(position.paidToSellersCop).not.toBe(0);
    expect(position.driverCodOutsideSettlementsCop).not.toBe(0);
    expect(position.withheldBySupplier.length).toBeGreaterThan(1);
    expect(position.feesCop).not.toBe(0);

    // El corte pagado suma 138.000 y el abono 40.000 mas.
    expect(position.paidToSellersCop).toBe(178_000);
    // Cuenta TODO el COD cuyo pedido no esta en un corte de domiciliario, no solo lo reciente:
    // o1 + o2 + o3 = 310.000, menos los 6.000 de pago al domiciliario por o3. El unico pedido
    // excluido es o4, que si figura en el corte d-1.
    expect(position.driverCodOutsideSettlementsCop).toBe(304_000);
    // Retenido a proveedores: 30.000 + 20.000 + 5.000; los 9.000 ya liquidados no entran.
    expect(position.withheldForSuppliersCop).toBe(55_000);
  });
});
