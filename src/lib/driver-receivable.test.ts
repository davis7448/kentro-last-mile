/**
 * Spec 026 · T3 — extraccion de "por cobrar al domiciliario" y de la clave de proveedor.
 *
 * RNF_02 exige que el total de la lista de efectivo no recibido cuadre con lo que la posicion de la
 * plataforma ya llama "por cobrar al domiciliario". Para que eso no dependa de dos copias de la misma
 * formula, la formula sale de `platform-position.ts` a `functions/src/driver-receivable.ts` y la clave
 * de proveedor ("(sin proveedor)" incluido) a `functions/src/supplier-withheld.ts`. La posicion delega
 * en ellas SIN cambiar ninguna cifra.
 *
 * Estas pruebas atan tres cosas:
 *  1. Las funciones nuevas dan exactamente lo que da hoy la formula de la posicion (copiada abajo como
 *     referencia congelada, `formulaActualDeLaPosicion`), incluido el corte sin `cashPendingCop`
 *     (ausente = 0, como hoy) y el asiento sin `supplierId`.
 *  2. El subconjunto que basta (asientos de tienda `cod_revenue|cod_remittance`, asientos
 *     `driver_earning` de domiciliario y cortes `driver`) da la misma cifra que el ledger entero: es lo
 *     que va a leer el cargador de la 026 en vez de bajarse `walletEntries` entera.
 *  3. `computePlatformPosition` delega (guarda de fuente) y sus quince cifras no cambian.
 *
 * Los modulos se cargan con `import()` dentro de cada prueba para que, mientras no existan, cada caso
 * falle con su propio mensaje en vez de tumbar el archivo entero.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SettlementDoc, WalletEntryDoc } from "../../functions/src/settlement-math";

type DriverReceivableModule = typeof import("../../functions/src/driver-receivable");
type SupplierWithheldModule = typeof import("../../functions/src/supplier-withheld");

const loadReceivable = (): Promise<DriverReceivableModule> => import("../../functions/src/driver-receivable");
const loadSupplier = (): Promise<SupplierWithheldModule> => import("../../functions/src/supplier-withheld");
const loadPosition = () => import("../../functions/src/platform-position");

function absolute(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

function sourceWithoutComments(relativePath: string): string {
  const raw = readFileSync(absolute(relativePath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

let nextId = 0;
function entry(partial: Partial<WalletEntryDoc> & Pick<WalletEntryDoc, "ownerType" | "type" | "amountCop">): WalletEntryDoc {
  nextId += 1;
  return {
    id: `w${nextId}`,
    ownerId: partial.ownerType === "driver" ? "driver-1" : "seller-1",
    orderId: `order-${nextId}`,
    description: "",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...partial
  };
}

function settlement(partial: Partial<SettlementDoc> & Pick<SettlementDoc, "id" | "kind">): SettlementDoc {
  return {
    ownerId: partial.kind === "driver" ? "driver-1" : "seller-1",
    ownerName: "Alguien",
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
  };
}

/**
 * Copia CONGELADA de la formula de `computePlatformPosition` tal como estaba antes de T3
 * (functions/src/platform-position.ts, "Por cobrar al domiciliario"). No se importa a proposito: si la
 * extraccion cambiara la cifra, comparar la posicion consigo misma no lo detectaria.
 */
function formulaActualDeLaPosicion(wallet: WalletEntryDoc[], settlements: SettlementDoc[]) {
  const sum = (entries: WalletEntryDoc[]) => entries.reduce((total, e) => total + Math.round(e.amountCop), 0);
  const sellerEntries = wallet.filter((e) => e.ownerType === "seller");
  const driverEarnings = wallet.filter((e) => e.ownerType === "driver" && e.type === "driver_earning");
  const driverPendingInSettlementsCop = settlements
    .filter((s) => s.kind === "driver")
    .reduce((total, s) => total + Math.round(Number(s.cashPendingCop) || 0), 0);
  const inDriverSettlements = new Set(settlements.filter((s) => s.kind === "driver").flatMap((s) => s.orderIds ?? []));
  const outsideCod = sum(sellerEntries.filter((e) =>
    (e.type === "cod_revenue" || e.type === "cod_remittance") && e.orderId && !inDriverSettlements.has(e.orderId)
  ));
  const outsidePay = sum(driverEarnings.filter((e) => e.orderId && !inDriverSettlements.has(e.orderId)));
  const driverCodOutsideSettlementsCop = Math.max(0, outsideCod - outsidePay);
  return {
    driverReceivableCop: driverPendingInSettlementsCop + driverCodOutsideSettlementsCop,
    driverPendingInSettlementsCop,
    driverCodOutsideSettlementsCop
  };
}

/** Copia CONGELADA de la agrupacion de retenido por proveedor de la posicion (antes de T3). */
function agrupacionActualDeLaPosicion(wallet: WalletEntryDoc[]) {
  const withheld = wallet.filter((e) => e.ownerType === "seller" && e.type === "product_cost" && !e.supplierSettlementId);
  const bySupplier = new Map<string, { supplierId: string; supplierName: string; amountCop: number }>();
  for (const e of withheld) {
    const supplierId = e.supplierId ?? "(sin proveedor)";
    const current = bySupplier.get(supplierId) ?? { supplierId, supplierName: e.supplierName ?? supplierId, amountCop: 0 };
    current.amountCop += -Math.round(e.amountCop);
    if (e.supplierName) current.supplierName = e.supplierName;
    bySupplier.set(supplierId, current);
  }
  return [...bySupplier.values()].filter((r) => r.amountCop !== 0).sort((l, r) => r.amountCop - l.amountCop);
}

const isWithheldProductCost = (e: WalletEntryDoc) => e.ownerType === "seller" && e.type === "product_cost" && !e.supplierSettlementId;

/**
 * Escenario con todo lo que no es una suma simple: pedido fuera de corte, pedido dentro de un corte de
 * domiciliario, corte de domiciliario SIN `cashPendingCop`, corte de tienda (no cuenta como "dentro"),
 * remesa, asiento sin `orderId`, montos con decimales, ruido de otros tipos, y retenido con proveedor,
 * sin proveedor y ya liquidado.
 */
function escenario(): { wallet: WalletEntryDoc[]; settlements: SettlementDoc[] } {
  const wallet: WalletEntryDoc[] = [
    // o1: fuera de todo corte de domiciliario.
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 150_000, orderId: "o1" }),
    entry({ ownerType: "seller", type: "delivery_fee", amountCop: -12_000, orderId: "o1" }),
    entry({ ownerType: "driver", type: "driver_earning", amountCop: 6_000, orderId: "o1" }),
    // o2: dentro del corte de domiciliario d-1 (pendiente, con cashPendingCop).
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 90_000, orderId: "o2", settlementId: "s-open" }),
    entry({ ownerType: "driver", type: "driver_earning", amountCop: 5_000, orderId: "o2" }),
    // o3: dentro del corte d-2, que NO tiene cashPendingCop (lo crea asi buildSettlement).
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 70_000, orderId: "o3" }),
    entry({ ownerType: "driver", type: "driver_earning", amountCop: 5_000, orderId: "o3" }),
    // o4: solo en un corte de TIENDA: para el domiciliario sigue "fuera".
    entry({ ownerType: "seller", type: "cod_remittance", amountCop: 40_000.6, orderId: "o4", settlementId: "s-paid" }),
    entry({ ownerType: "driver", type: "driver_earning", amountCop: 4_999.5, orderId: "o4" }),
    // Sin orderId: no cuenta ni como COD fuera ni como pago fuera.
    entry({ ownerType: "seller", type: "cod_revenue", amountCop: 999_999, orderId: "" }),
    entry({ ownerType: "driver", type: "driver_earning", amountCop: 888_888, orderId: "" }),
    // Ruido: tipos que no son del "por cobrar".
    entry({ ownerType: "seller", type: "seller_abono", amountCop: -40_000, orderId: "" }),
    entry({ ownerType: "admin", ownerId: "admin", type: "platform_margin", amountCop: 3_000, orderId: "o1" }),
    entry({ ownerType: "driver", type: "cash_shortage", amountCop: -2_000, orderId: "o1" }),
    // Un cod_revenue con ownerType driver (no deberia existir, pero no es de tienda: no cuenta).
    entry({ ownerType: "driver", type: "cod_revenue", amountCop: 77_000, orderId: "o9" }),
    // Retenido a proveedores: dos con proveedor, uno sin proveedor, uno ya liquidado.
    entry({ ownerType: "seller", type: "product_cost", amountCop: -30_000, orderId: "o1", supplierId: "sup-1", supplierName: "Proveedor Uno" }),
    entry({ ownerType: "seller", type: "product_cost", amountCop: -20_000, orderId: "o2", supplierId: "sup-2", supplierName: "Proveedor Dos" }),
    entry({ ownerType: "seller", type: "product_cost", amountCop: -5_000, orderId: "o3" }),
    entry({ ownerType: "seller", type: "product_cost", amountCop: -9_000, orderId: "o4", supplierId: "sup-1", supplierSettlementId: "sup-cut" })
  ];
  const settlements: SettlementDoc[] = [
    settlement({ id: "s-paid", kind: "seller", status: "paid", orderIds: ["o4"] }),
    settlement({ id: "s-open", kind: "seller", status: "pending", orderIds: ["o2"] }),
    settlement({ id: "d-1", kind: "driver", orderIds: ["o2"], cashReceivedCop: 75_000, cashPendingCop: 10_000.4, status: "pending" }),
    settlement({ id: "d-2", kind: "driver", orderIds: ["o3"], cashReceivedCop: 65_000, status: "paid" }) // sin cashPendingCop
  ];
  return { wallet, settlements };
}

/** Generador determinista (mulberry32) para la prueba de propiedad. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escenarioAleatorio(seed: number): { wallet: WalletEntryDoc[]; settlements: SettlementDoc[] } {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const orderIds = Array.from({ length: 8 }, (_, i) => `p${i}`);
  const types: WalletEntryDoc["type"][] = ["cod_revenue", "cod_remittance", "driver_earning", "delivery_fee", "product_cost", "cash_shortage"];
  const owners: WalletEntryDoc["ownerType"][] = ["seller", "seller", "driver", "admin"];
  const wallet: WalletEntryDoc[] = Array.from({ length: 4 + Math.floor(random() * 20) }, () => {
    const type = pick(types);
    const ownerType = type === "driver_earning" ? (random() < 0.85 ? "driver" : "seller") : pick(owners);
    const amount = Math.round((random() * 200_000 - (type === "product_cost" ? 200_000 : 20_000)) * 10) / 10;
    return entry({
      ownerType,
      type,
      amountCop: amount,
      orderId: random() < 0.1 ? "" : pick(orderIds),
      supplierId: type === "product_cost" && random() < 0.7 ? pick(["sup-a", "sup-b"]) : undefined,
      supplierName: type === "product_cost" && random() < 0.5 ? pick(["A", "B"]) : undefined,
      supplierSettlementId: type === "product_cost" && random() < 0.2 ? "sc" : undefined
    });
  });
  const settlements: SettlementDoc[] = Array.from({ length: Math.floor(random() * 4) }, (_, i) => {
    const pending = random();
    return settlement({
      id: `s${i}`,
      kind: pick(["driver", "driver", "seller", "supplier"] as const),
      status: pick(["pending", "paid", "reconciled"] as const),
      orderIds: orderIds.filter(() => random() < 0.3),
      // Un tercio sin campo (ausente = 0), el resto con importe, a veces con decimales.
      cashPendingCop: pending < 0.33 ? undefined : Math.round(random() * 50_000 * 10) / 10
    });
  });
  return { wallet, settlements };
}

const subconjuntoQueBasta = (
  mod: DriverReceivableModule,
  wallet: WalletEntryDoc[],
  settlements: SettlementDoc[]
) => ({
  wallet: wallet.filter((e) => mod.isReceivableCodEntry(e) || mod.isReceivableDriverPay(e)),
  settlements: settlements.filter((s) => s.kind === "driver")
});

// ---------------------------------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------------------------------

describe("T3 · el escenario de referencia ejercita lo que no es una suma simple", () => {
  // Proteccion del propio fixture: si estas cifras quedaran en cero, las equivalencias de abajo
  // pasarian sin comparar nada util.
  it("la formula congelada coincide hoy con computePlatformPosition y da cifras distintas de cero", async () => {
    const { computePlatformPosition } = await loadPosition();
    const { wallet, settlements } = escenario();
    const referencia = formulaActualDeLaPosicion(wallet, settlements);
    const posicion = computePlatformPosition(wallet, settlements);

    expect({
      driverReceivableCop: posicion.driverReceivableCop,
      driverPendingInSettlementsCop: posicion.driverPendingInSettlementsCop,
      driverCodOutsideSettlementsCop: posicion.driverCodOutsideSettlementsCop
    }).toEqual(referencia);
    // d-1 aporta 10.000 (redondeado de 10.000,4); d-2 sin campo aporta 0.
    expect(referencia.driverPendingInSettlementsCop).toBe(10_000);
    // Fuera: o1 (150.000 − 6.000) + o4 (40.001 − 5.000; o4 solo esta en un corte de tienda).
    expect(referencia.driverCodOutsideSettlementsCop).toBe(179_001);
    expect(posicion.withheldBySupplier).toEqual(agrupacionActualDeLaPosicion(wallet));
    expect(posicion.withheldBySupplier.map((r) => r.supplierId)).toContain("(sin proveedor)");
  });
});

describe("T3 · predicados de driver-receivable", () => {
  it("isReceivableCodEntry: solo cod_revenue y cod_remittance de tienda", async () => {
    const { isReceivableCodEntry } = await loadReceivable();
    expect(isReceivableCodEntry(entry({ ownerType: "seller", type: "cod_revenue", amountCop: 1 }))).toBe(true);
    expect(isReceivableCodEntry(entry({ ownerType: "seller", type: "cod_remittance", amountCop: 1 }))).toBe(true);
  });

  it("isReceivableCodEntry: rechaza otros tipos y otros duenos", async () => {
    const { isReceivableCodEntry } = await loadReceivable();
    const rechazados = [
      entry({ ownerType: "seller", type: "delivery_fee", amountCop: -1 }),
      entry({ ownerType: "seller", type: "product_cost", amountCop: -1 }),
      entry({ ownerType: "seller", type: "seller_abono", amountCop: -1 }),
      entry({ ownerType: "driver", type: "cod_revenue", amountCop: 1 }),
      entry({ ownerType: "admin", type: "cod_remittance", amountCop: 1 })
    ];
    expect(rechazados.map(isReceivableCodEntry)).toEqual([false, false, false, false, false]);
  });

  it("isReceivableDriverPay: solo driver_earning de domiciliario", async () => {
    const { isReceivableDriverPay } = await loadReceivable();
    expect(isReceivableDriverPay(entry({ ownerType: "driver", type: "driver_earning", amountCop: 5_000 }))).toBe(true);
    expect([
      entry({ ownerType: "seller", type: "driver_earning", amountCop: 5_000 }),
      entry({ ownerType: "driver", type: "cash_shortage", amountCop: -1 }),
      entry({ ownerType: "driver", type: "cod_revenue", amountCop: 1 })
    ].map(isReceivableDriverPay)).toEqual([false, false, false]);
  });

  it("driverSettlementOrderIds: une los orderIds de los cortes de domiciliario y solo de esos", async () => {
    const { driverSettlementOrderIds } = await loadReceivable();
    const ids = driverSettlementOrderIds([
      settlement({ id: "d-a", kind: "driver", orderIds: ["a", "b"] }),
      settlement({ id: "d-b", kind: "driver", orderIds: ["b", "c"] }),
      settlement({ id: "s", kind: "seller", orderIds: ["x"] }),
      settlement({ id: "p", kind: "supplier", orderIds: ["y"] }),
      // Documento viejo sin orderIds: no rompe.
      { ...settlement({ id: "d-c", kind: "driver" }), orderIds: undefined as unknown as string[] }
    ]);
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("T3 · computeDriverReceivable = formula actual de la posicion", () => {
  it("da las mismas tres cifras sobre el escenario completo", async () => {
    const { computeDriverReceivable } = await loadReceivable();
    const { wallet, settlements } = escenario();
    expect(computeDriverReceivable(wallet, settlements)).toEqual(formulaActualDeLaPosicion(wallet, settlements));
  });

  it("corte de domiciliario sin cashPendingCop cuenta 0 (como hoy), no NaN ni error", async () => {
    const { computeDriverReceivable } = await loadReceivable();
    const settlements = [
      settlement({ id: "d-sin", kind: "driver", orderIds: ["z"], status: "paid" }),
      settlement({ id: "d-con", kind: "driver", orderIds: ["y"], cashPendingCop: 7_000 })
    ];
    const resultado = computeDriverReceivable([], settlements);
    expect(resultado.driverPendingInSettlementsCop).toBe(7_000);
    expect(resultado.driverReceivableCop).toBe(7_000);
  });

  it("el pendiente de cortes que no son de domiciliario no cuenta", async () => {
    const { computeDriverReceivable } = await loadReceivable();
    const resultado = computeDriverReceivable([], [settlement({ id: "s", kind: "seller", cashPendingCop: 50_000 })]);
    expect(resultado.driverPendingInSettlementsCop).toBe(0);
  });

  it("el COD fuera de corte se topa en 0 cuando el pago supera al COD", async () => {
    const { computeDriverReceivable } = await loadReceivable();
    const wallet = [
      entry({ ownerType: "seller", type: "cod_revenue", amountCop: 3_000, orderId: "q" }),
      entry({ ownerType: "driver", type: "driver_earning", amountCop: 8_000, orderId: "q" })
    ];
    const resultado = computeDriverReceivable(wallet, []);
    expect(resultado.driverCodOutsideSettlementsCop).toBe(0);
    expect(resultado).toEqual(formulaActualDeLaPosicion(wallet, []));
  });

  it("ledger vacio da ceros", async () => {
    const { computeDriverReceivable } = await loadReceivable();
    expect(computeDriverReceivable([], [])).toEqual({
      driverReceivableCop: 0,
      driverPendingInSettlementsCop: 0,
      driverCodOutsideSettlementsCop: 0
    });
  });

  it("propiedad: coincide con la formula congelada en 300 escenarios (semilla fija)", async () => {
    const { computeDriverReceivable } = await loadReceivable();
    const divergentes: number[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const { wallet, settlements } = escenarioAleatorio(seed);
      const esperado = formulaActualDeLaPosicion(wallet, settlements);
      const obtenido = computeDriverReceivable(wallet, settlements);
      if (JSON.stringify(obtenido) !== JSON.stringify(esperado)) divergentes.push(seed);
    }
    expect(divergentes).toEqual([]);
  });
});

describe("T3 · el subconjunto que basta da lo mismo que el ledger entero (subconjunto = ledger)", () => {
  it("escenario completo: subconjunto por predicados + cortes driver = ledger entero = posicion", async () => {
    const mod = await loadReceivable();
    const { computePlatformPosition } = await loadPosition();
    const { wallet, settlements } = escenario();
    const sub = subconjuntoQueBasta(mod, wallet, settlements);

    // El subconjunto de verdad recorta algo: si no, la prueba no diria nada.
    expect(sub.wallet.length).toBeLessThan(wallet.length);
    expect(sub.settlements.length).toBeLessThan(settlements.length);

    const desdeSubconjunto = mod.computeDriverReceivable(sub.wallet, sub.settlements);
    expect(desdeSubconjunto).toEqual(mod.computeDriverReceivable(wallet, settlements));
    expect(desdeSubconjunto.driverReceivableCop).toBe(computePlatformPosition(wallet, settlements).driverReceivableCop);
  });

  it("propiedad: subconjunto = ledger en 300 escenarios (semilla fija)", async () => {
    const mod = await loadReceivable();
    const divergentes: number[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const { wallet, settlements } = escenarioAleatorio(seed);
      const sub = subconjuntoQueBasta(mod, wallet, settlements);
      const entero = formulaActualDeLaPosicion(wallet, settlements);
      if (JSON.stringify(mod.computeDriverReceivable(sub.wallet, sub.settlements)) !== JSON.stringify(entero)) divergentes.push(seed);
    }
    expect(divergentes).toEqual([]);
  });
});

describe("T3 · clave y agrupacion de proveedor (RF_08)", () => {
  it("withheldSupplierKey devuelve el supplierId cuando existe", async () => {
    const { withheldSupplierKey } = await loadSupplier();
    expect(withheldSupplierKey(entry({ ownerType: "seller", type: "product_cost", amountCop: -1, supplierId: "sup-1" }))).toBe("sup-1");
  });

  it("withheldSupplierKey devuelve \"(sin proveedor)\" cuando falta supplierId", async () => {
    const { withheldSupplierKey } = await loadSupplier();
    expect(withheldSupplierKey(entry({ ownerType: "seller", type: "product_cost", amountCop: -1 }))).toBe("(sin proveedor)");
  });

  it("groupWithheldBySupplier agrupa, invierte el signo, toma el nombre y ordena como la posicion", async () => {
    const { groupWithheldBySupplier } = await loadSupplier();
    const entradas = [
      entry({ ownerType: "seller", type: "product_cost", amountCop: -10_000, supplierId: "sup-1" }),
      entry({ ownerType: "seller", type: "product_cost", amountCop: -15_000.5, supplierId: "sup-1", supplierName: "Proveedor Uno" }),
      entry({ ownerType: "seller", type: "product_cost", amountCop: -40_000, supplierId: "sup-2", supplierName: "Proveedor Dos" }),
      entry({ ownerType: "seller", type: "product_cost", amountCop: -5_000 }),
      // Se anulan entre si: el grupo queda en 0 y no aparece.
      entry({ ownerType: "seller", type: "product_cost", amountCop: -2_000, supplierId: "sup-3" }),
      entry({ ownerType: "seller", type: "product_cost", amountCop: 2_000, supplierId: "sup-3" })
    ];
    expect(groupWithheldBySupplier(entradas)).toEqual([
      { supplierId: "sup-2", supplierName: "Proveedor Dos", amountCop: 40_000 },
      // round(-15.000,5) = -15.000 en JS (redondeo hacia +inf), invertido 15.000.
      { supplierId: "sup-1", supplierName: "Proveedor Uno", amountCop: 25_000 },
      { supplierId: "(sin proveedor)", supplierName: "(sin proveedor)", amountCop: 5_000 }
    ]);
  });

  it("\"(sin proveedor)\" sale igual en la agrupacion nueva y en la posicion", async () => {
    const { groupWithheldBySupplier } = await loadSupplier();
    const { computePlatformPosition } = await loadPosition();
    const { wallet, settlements } = escenario();
    const agrupado = groupWithheldBySupplier(wallet.filter(isWithheldProductCost));
    const sinProveedor = agrupado.find((r) => r.supplierId === "(sin proveedor)");

    expect(sinProveedor).toEqual({ supplierId: "(sin proveedor)", supplierName: "(sin proveedor)", amountCop: 5_000 });
    expect(computePlatformPosition(wallet, settlements).withheldBySupplier.find((r) => r.supplierId === "(sin proveedor)")).toEqual(sinProveedor);
  });

  it("groupWithheldBySupplier sobre el retenido = withheldBySupplier de la posicion = agrupacion congelada", async () => {
    const { groupWithheldBySupplier } = await loadSupplier();
    const { computePlatformPosition } = await loadPosition();
    const { wallet, settlements } = escenario();
    const agrupado = groupWithheldBySupplier(wallet.filter(isWithheldProductCost));
    expect(agrupado).toEqual(agrupacionActualDeLaPosicion(wallet));
    expect(agrupado).toEqual(computePlatformPosition(wallet, settlements).withheldBySupplier);
  });

  it("propiedad: la agrupacion coincide con la congelada en 300 escenarios (semilla fija)", async () => {
    const { groupWithheldBySupplier } = await loadSupplier();
    const divergentes: number[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const { wallet } = escenarioAleatorio(seed);
      const obtenido = groupWithheldBySupplier(wallet.filter(isWithheldProductCost));
      if (JSON.stringify(obtenido) !== JSON.stringify(agrupacionActualDeLaPosicion(wallet))) divergentes.push(seed);
    }
    expect(divergentes).toEqual([]);
  });
});

describe("T3 · computePlatformPosition delega sin cambiar cifras", () => {
  const POSITION = "functions/src/platform-position.ts";

  it("importa computeDriverReceivable de ./driver-receivable y groupWithheldBySupplier de ./supplier-withheld", () => {
    const source = sourceWithoutComments(POSITION);
    expect(source).toMatch(/import\s*\{[^}]*\bcomputeDriverReceivable\b[^}]*\}\s*from\s*["']\.\/driver-receivable["']/);
    expect(source).toMatch(/import\s*\{[^}]*\bgroupWithheldBySupplier\b[^}]*\}\s*from\s*["']\.\/supplier-withheld["']/);
  });

  it("ya no contiene su propia copia de la formula ni de la clave \"(sin proveedor)\"", () => {
    const source = sourceWithoutComments(POSITION);
    expect(source).not.toContain("(sin proveedor)");
    expect(source).not.toMatch(/cashPendingCop/);
    expect(source).not.toMatch(/orderIdsInDriverSettlements/);
  });

  it("las tres cifras del por cobrar y el retenido por proveedor siguen identicos en 300 escenarios", async () => {
    const { computePlatformPosition } = await loadPosition();
    const divergentes: number[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const { wallet, settlements } = escenarioAleatorio(seed);
      const p = computePlatformPosition(wallet, settlements);
      const obtenido = {
        driverReceivableCop: p.driverReceivableCop,
        driverPendingInSettlementsCop: p.driverPendingInSettlementsCop,
        driverCodOutsideSettlementsCop: p.driverCodOutsideSettlementsCop,
        withheldBySupplier: p.withheldBySupplier
      };
      const esperado = { ...formulaActualDeLaPosicion(wallet, settlements), withheldBySupplier: agrupacionActualDeLaPosicion(wallet) };
      if (JSON.stringify(obtenido) !== JSON.stringify(esperado)) divergentes.push(seed);
    }
    expect(divergentes).toEqual([]);
  });
});
