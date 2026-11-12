/**
 * Spec 040: cada bodega imprime lo suyo. Catalogo de prueba con la forma del de Kovia medido en
 * produccion el 2026-11-12: ADMA LABORATORIO (Joint health, CEELIKE) y ADMA COMPANY (KAHI).
 */
import { describe, expect, it } from "vitest";
import {
  NO_SUPPLIER,
  groupBatchBySupplier,
  ordersForSupplier,
  packageUnits,
  splitOrderIntoPackages,
  supplierOptionsForCatalog,
  type CatalogItemLike,
  type OrderLike
} from "../../functions/src/supplier-packages";
import { resolveProductCostLinesForOrder } from "../../functions/src/wallet-entries";
import { productCostLinesForOrder } from "./finance";
import type { AppState } from "./types";

const SELLER = "seller-kovia";
const LAB = "sup-lab";
const COMPANY = "sup-company";
const suppliers = [
  { id: LAB, name: "ADMA LABORATORIO" },
  { id: COMPANY, name: "ADMA COMPANY" }
];
const catalog: Array<CatalogItemLike & { productCostCop: number; productCostConfigured: boolean }> = [
  { id: "prd-joint", sellerId: SELLER, supplierId: LAB, sku: "94030000", name: "Joint health", productCostCop: 26700, productCostConfigured: true, active: true },
  { id: "prd-ceelike", sellerId: SELLER, supplierId: LAB, sku: "93070000", name: "CEELIKE", productCostCop: 26950, productCostConfigured: true, active: true },
  { id: "prd-kahi", sellerId: SELLER, supplierId: COMPANY, sku: "33680000", name: "KAHI Balm", productCostCop: 15000, productCostConfigured: true, active: true },
  { id: "prd-prueba", sellerId: SELLER, supplierId: COMPANY, name: "PRODUCTO PRUEBA", normalizedProductName: "producto prueba", productCostCop: 0, productCostConfigured: true, active: true },
  { id: "prd-huerfano", sellerId: SELLER, sku: "HUERFANO", name: "Sin proveedor", productCostCop: 1000, productCostConfigured: true, active: true }
];

const order = (id: string, extra: Partial<OrderLike>): OrderLike => ({ id, sellerId: SELLER, ...extra });
const mixed = order("o-mixto", {
  lineItems: [
    { sku: "94030000", productName: "Joint health · OFERTA 2 X 1", quantity: 1 },
    { sku: "33680000", productName: "KAHI Wrinkle Bounce Multi Balm 9g", quantity: 2 }
  ]
});

describe("spec 040 — partir un pedido en paquetes", () => {
  it("RF_02: un solo proveedor con dos lineas da un paquete con las dos y el cobro", () => {
    const pkgs = splitOrderIntoPackages(order("o1", {
      lineItems: [{ sku: "94030000", productName: "Joint health", quantity: 1 }, { sku: "93070000", productName: "CEELIKE", quantity: 1 }]
    }), catalog, suppliers);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ supplierKey: LAB, supplierName: "ADMA LABORATORIO", index: 1, total: 1, collectsPayment: true });
    expect(pkgs[0].lines.map((line) => line.sku)).toEqual(["94030000", "93070000"]);
  });

  it("RF_03/RF_04: un pedido mixto da un paquete por proveedor, el cobro solo en el 1, orden estable", () => {
    const pkgs = splitOrderIntoPackages(mixed, catalog, suppliers);
    expect(pkgs.map((pkg) => [pkg.supplierName, pkg.index, pkg.total, pkg.collectsPayment])).toEqual([
      ["ADMA COMPANY", 1, 2, true],
      ["ADMA LABORATORIO", 2, 2, false]
    ]);
    expect(pkgs[0].lines).toEqual([{ label: "KAHI Wrinkle Bounce Multi Balm 9g", sku: "33680000", quantity: 2 }]);
    expect(pkgs[1].lines).toEqual([{ label: "Joint health · OFERTA 2 X 1", sku: "94030000", quantity: 1 }]);
    expect(packageUnits(pkgs[0])).toBe(2);
    expect(splitOrderIntoPackages(mixed, catalog, suppliers)).toEqual(pkgs);
    // El orden no depende del orden de las lineas.
    const reversed = { ...mixed, lineItems: [...mixed.lineItems!].reverse() };
    expect(splitOrderIntoPackages(reversed, catalog, suppliers).map((pkg) => pkg.supplierKey)).toEqual([COMPANY, LAB]);
  });

  it("el mismo producto en dos lineas se suma en una", () => {
    const pkgs = splitOrderIntoPackages(order("o2", {
      lineItems: [{ sku: "93070000", productName: "CEELIKE x1", quantity: 1 }, { sku: "93070000 ", productName: "CEELIKE x1", quantity: 2 }]
    }), catalog, suppliers);
    expect(pkgs[0].lines).toEqual([{ label: "CEELIKE x1", sku: "93070000", quantity: 3 }]);
  });

  it("al sumar lineas del mismo producto con nombres distintos se usa el nombre del catalogo", () => {
    const pkgs = splitOrderIntoPackages(order("o2b", {
      lineItems: [{ sku: "93070000", productName: "CEELIKE menta", quantity: 1 }, { sku: "93070000", productName: "CEELIKE fresa", quantity: 1 }]
    }), catalog, suppliers);
    expect(pkgs[0].lines).toEqual([{ label: "CEELIKE", sku: "93070000", quantity: 2 }]);
  });

  it("RF_01: sin lineItems usa los campos colapsados; un SKU colapsado 'A + B' no se adivina", () => {
    const single = splitOrderIntoPackages(order("o3", { sku: "93070000", productName: "CEELIKE x2", quantity: 2 }), catalog, suppliers);
    expect(single).toMatchObject([{ supplierKey: LAB, total: 1, lines: [{ sku: "93070000", quantity: 2 }] }]);
    const collapsed = splitOrderIntoPackages(order("o4", { sku: "94030000 + 33680000", productName: "A x1 + B x1", quantity: 2 }), catalog, suppliers);
    expect(collapsed).toMatchObject([{ supplierKey: NO_SUPPLIER, total: 1 }]);
    expect(collapsed[0].supplierName).toBeUndefined();
  });

  it("RF_07: sin producto o con producto sin proveedor va a 'Sin proveedor', siempre al final", () => {
    const pkgs = splitOrderIntoPackages(order("o5", {
      lineItems: [
        { productName: "Algo que no esta", quantity: 1 },
        { sku: "HUERFANO", productName: "Huerfano", quantity: 1 },
        { sku: "94030000", productName: "Joint", quantity: 1 }
      ]
    }), catalog, suppliers);
    expect(pkgs.map((pkg) => pkg.supplierKey)).toEqual([LAB, NO_SUPPLIER]);
    expect(pkgs[1].lines.map((line) => line.label)).toEqual(["Algo que no esta", "Huerfano"]);
    expect(pkgs[1].collectsPayment).toBe(false);
  });

  it("no empareja productos de otra tienda ni inactivos", () => {
    const pkgs = splitOrderIntoPackages({ id: "o6", sellerId: "otra", sku: "94030000", quantity: 1 }, catalog, suppliers);
    expect(pkgs[0].supplierKey).toBe(NO_SUPPLIER);
    const inactive = catalog.map((item) => (item.id === "prd-joint" ? { ...item, active: false } : item));
    expect(splitOrderIntoPackages(order("o7", { sku: "94030000", quantity: 1 }), inactive, suppliers)[0].supplierKey).toBe(NO_SUPPLIER);
  });

  it("RNF_03: la tienda (sin `suppliers`) obtiene la misma particion, sin nombres", () => {
    const pkgs = splitOrderIntoPackages(mixed, catalog, []);
    expect(pkgs.map((pkg) => [pkg.supplierKey, pkg.index, pkg.supplierName])).toEqual([[COMPANY, 1, undefined], [LAB, 2, undefined]]);
    // El paquete que cobra es el mismo para el admin y para la tienda.
    const renamed = [{ id: LAB, name: "AAA primero por nombre" }, { id: COMPANY, name: "ZZZ" }];
    expect(splitOrderIntoPackages(mixed, catalog, renamed).map((pkg) => pkg.supplierKey)).toEqual([COMPANY, LAB]);
  });
});

describe("spec 040 — tandas por proveedor (admin)", () => {
  const onlyLab = order("o-lab", { lineItems: [{ sku: "94030000", productName: "Joint", quantity: 2 }] });
  const onlyCompany = order("o-company", { lineItems: [{ sku: "33680000", productName: "KAHI", quantity: 1 }] });

  it("RF_05: un grupo por proveedor con unidades por producto", () => {
    const groups = groupBatchBySupplier([onlyLab, onlyCompany, mixed], catalog, suppliers);
    expect(groups.map((group) => [group.supplierName, group.packages.map((pkg) => pkg.orderId)])).toEqual([
      ["ADMA COMPANY", ["o-company", "o-mixto"]],
      ["ADMA LABORATORIO", ["o-lab", "o-mixto"]]
    ]);
    expect(groups[1].unitsByProduct).toEqual([{ label: "Joint", quantity: 2 }, { label: "Joint health · OFERTA 2 X 1", quantity: 1 }]);
    expect(groups.every((group) => group.ordersWithPackagesElsewhere.length === 0)).toBe(true);
  });

  it("RF_06: con un solo proveedor sale su grupo y avisa del pedido con paquete en la otra bodega", () => {
    const groups = groupBatchBySupplier([onlyLab, onlyCompany, mixed], catalog, suppliers, { onlySupplierKey: LAB });
    expect(groups).toHaveLength(1);
    expect(groups[0].packages.map((pkg) => pkg.orderId)).toEqual(["o-lab", "o-mixto"]);
    expect(groups[0].ordersWithPackagesElsewhere).toEqual(["o-mixto"]);
    expect(ordersForSupplier([onlyLab, onlyCompany, mixed], catalog, LAB).map((item) => item.id)).toEqual(["o-lab", "o-mixto"]);
    expect(ordersForSupplier([onlyLab, onlyCompany], catalog, undefined)).toHaveLength(2);
    expect(ordersForSupplier([onlyLab, order("x", { productName: "nada" })], catalog, NO_SUPPLIER).map((item) => item.id)).toEqual(["x"]);
  });

  it("el selector ofrece los proveedores con productos activos", () => {
    expect(supplierOptionsForCatalog(catalog, suppliers)).toEqual([
      { id: COMPANY, name: "ADMA COMPANY" },
      { id: LAB, name: "ADMA LABORATORIO" }
    ]);
  });
});

describe("spec 040 — RNF_01: la bodega de cada linea es la del cobro", () => {
  const orders: OrderLike[] = [
    mixed,
    order("c1", { lineItems: [{ sku: "93070000", productName: "CEELIKE", quantity: 2 }, { productName: "Producto Prueba", quantity: 1 }] }),
    order("c2", { sku: "94030000", productName: "Joint x1", quantity: 1 }),
    order("c3", { productId: "prd-kahi", productName: "otro nombre", quantity: 1 }),
    order("c4", { lineItems: [{ sku: "HUERFANO", productName: "x", quantity: 1 }, { sku: "NOEXISTE", productName: "y", quantity: 1 }] })
  ];
  const state = { productCatalog: catalog, suppliers } as unknown as AppState;

  // productId -> supplierKey visto por la impresion, reconstruido con el id del catalogo.
  const printSuppliers = (item: OrderLike, cat: typeof catalog) => {
    const map = new Map<string, string>();
    for (const pkg of splitOrderIntoPackages(item, cat, suppliers)) {
      for (const line of pkg.lines) {
        const product = cat.find((entry) => entry.sku === line.sku || entry.name === line.label || entry.normalizedProductName === line.label.toLowerCase());
        if (product) map.set(product.id, pkg.supplierKey);
      }
    }
    return map;
  };

  it("con todo el costo configurado, la impresion y el cobro (servidor y cliente) ven los mismos productos y proveedores", () => {
    for (const item of orders) {
      const server = resolveProductCostLinesForOrder(item, catalog).map((line) => [line.productId, line.supplierId ?? NO_SUPPLIER]).sort();
      const client = productCostLinesForOrder(item as never, state).map((line) => [line.productId, line.supplierId ?? NO_SUPPLIER]).sort();
      const printed = Array.from(printSuppliers(item, catalog).entries()).sort();
      expect(client).toEqual(server);
      if (item.id === "c3") {
        // Sin lineItems, el cobro empareja por productId; la impresion tambien (misma funcion), aunque el
        // nombre de la linea no coincida: el paquete es de COMPANY.
        expect(splitOrderIntoPackages(item, catalog, suppliers)[0].supplierKey).toBe(COMPANY);
        expect(server).toEqual([["prd-kahi", COMPANY]]);
        continue;
      }
      expect(printed).toEqual(server);
    }
  });

  it("diferencia declarada: sin costo configurado el cobro omite el producto y la impresion conserva su bodega", () => {
    const unconfigured = catalog.map((item) => (item.id === "prd-kahi" ? { ...item, productCostConfigured: false } : item));
    expect(resolveProductCostLinesForOrder(mixed, unconfigured).map((line) => line.productId)).toEqual(["prd-joint"]);
    expect(splitOrderIntoPackages(mixed, unconfigured, suppliers).map((pkg) => pkg.supplierKey)).toEqual([COMPANY, LAB]);
  });
});
