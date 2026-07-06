import { describe, expect, it } from "vitest";
import { findCatalogMatch } from "./finance";
import { buildMissingProductCostEntries, buildUnassociatedProductRows } from "./product-catalog";
import { seedState } from "./seed";
import type { AppState, Order, ProductCatalogItem } from "./types";

const catalogItem = (overrides: Partial<ProductCatalogItem>): ProductCatalogItem => ({
  id: "prd-test",
  sellerId: "seller-1",
  supplierId: "sup-1",
  name: "Producto",
  normalizedProductName: "producto",
  productCostCop: 10000,
  productCostConfigured: true,
  active: true,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  ...overrides
});

const baseState = (): AppState => ({
  ...seedState(),
  orders: [],
  wallet: [],
  settlements: [],
  suppliers: [{ id: "sup-1", name: "Proveedor Uno", active: true, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }],
  productCatalog: []
});

const comboOrder = (overrides: Partial<Order> = {}): Order => ({
  ...seedState().orders[0],
  id: "ord-combo",
  status: "delivered",
  sku: "SPRAY-X2 + BIOHAIR",
  productName: "Spray x2 + Biohair x1",
  quantity: 3,
  lineItems: [
    { sku: "SPRAY-X2", productName: "Spray", quantity: 2 },
    { sku: "BIOHAIR", productName: "Biohair", quantity: 1 }
  ],
  ...overrides
});

describe("findCatalogMatch", () => {
  it("does not match individual line skus against a combined-sku catalog entry (regression)", () => {
    const state = { ...baseState(), productCatalog: [catalogItem({ sku: "SPRAY-X2 + BIOHAIR" })] };
    expect(findCatalogMatch(state, "seller-1", { sku: "SPRAY-X2" })).toBeUndefined();
    expect(findCatalogMatch(state, "seller-1", { sku: "BIOHAIR" })).toBeUndefined();
    expect(findCatalogMatch(state, "seller-1", { sku: "spray-x2 + biohair" })).toBeDefined();
  });

  it("prefers sku match, uses name only against entries without sku, and skips inactive", () => {
    const bySku = catalogItem({ id: "prd-sku", sku: "SPRAY-X2", normalizedProductName: "otro nombre" });
    const byName = catalogItem({ id: "prd-name", sku: undefined, normalizedProductName: "spray" });
    const inactive = catalogItem({ id: "prd-off", sku: "APAGADO", active: false });
    const state = { ...baseState(), productCatalog: [bySku, byName, inactive] };
    expect(findCatalogMatch(state, "seller-1", { sku: "spray-x2" })?.id).toBe("prd-sku");
    expect(findCatalogMatch(state, "seller-1", { productName: "SPRAY" })?.id).toBe("prd-name");
    expect(findCatalogMatch(state, "seller-1", { sku: "SIN-CATALOGO", productName: "Spray" })?.id).toBe("prd-name");
    expect(findCatalogMatch(state, "seller-1", { sku: "APAGADO" })).toBeUndefined();
    expect(findCatalogMatch(state, "seller-2", { sku: "SPRAY-X2" })).toBeUndefined();
  });
});

describe("buildUnassociatedProductRows", () => {
  it("splits multi-line orders into one row per sku with the combo label as source", () => {
    const state = { ...baseState(), orders: [comboOrder()] };
    const rows = buildUnassociatedProductRows(state);
    expect(rows).toHaveLength(2);
    const spray = rows.find((row) => row.sku === "SPRAY-X2");
    const biohair = rows.find((row) => row.sku === "BIOHAIR");
    expect(spray?.productName).toBe("Spray");
    expect(spray?.quantity).toBe(2);
    expect(spray?.sources).toEqual(["Spray x2 + Biohair x1"]);
    expect(biohair?.quantity).toBe(1);
  });

  it("dedupes the same sku across orders counting each order once", () => {
    const state = {
      ...baseState(),
      orders: [
        comboOrder({ id: "ord-a" }),
        comboOrder({ id: "ord-b", lineItems: [{ sku: "SPRAY-X2", productName: "Spray", quantity: 1 }] })
      ]
    };
    const rows = buildUnassociatedProductRows(state);
    const spray = rows.find((row) => row.sku === "SPRAY-X2");
    expect(spray?.orderCount).toBe(2);
    expect(spray?.quantity).toBe(3);
  });

  it("falls back to top-level sku/name for orders without lineItems", () => {
    const state = { ...baseState(), orders: [{ ...seedState().orders[0], id: "ord-legacy", sku: "AUR-TERMO", productName: "Termo acero", quantity: 2, lineItems: undefined }] };
    const rows = buildUnassociatedProductRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe("AUR-TERMO");
    expect(rows[0].sources).toEqual([]);
  });

  it("hides lines already associated in the catalog", () => {
    const state = { ...baseState(), orders: [comboOrder()], productCatalog: [catalogItem({ sku: "SPRAY-X2" })] };
    const rows = buildUnassociatedProductRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe("BIOHAIR");
  });
});

describe("buildMissingProductCostEntries", () => {
  it("backfills per line using the edited product and unit cost x line quantity", () => {
    const state = { ...baseState(), orders: [comboOrder()] };
    const item = catalogItem({ id: "prd-spray", sku: "SPRAY-X2", productCostCop: 10000 });
    const entries = buildMissingProductCostEntries(state, item);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("we-ord-combo-product-cost-prd-spray");
    expect(entries[0].amountCop).toBe(-20000);
    expect(entries[0].productId).toBe("prd-spray");
  });

  it("skips orders that already have a legacy product_cost entry without productId", () => {
    const state = {
      ...baseState(),
      orders: [comboOrder()],
      wallet: [{ id: "we-ord-combo-product-cost", ownerType: "seller" as const, ownerId: "seller-1", orderId: "ord-combo", type: "product_cost" as const, amountCop: -5000, description: "Costo producto legacy", createdAt: "2026-06-01T00:00:00.000Z" }]
    };
    const entries = buildMissingProductCostEntries(state, catalogItem({ id: "prd-spray", sku: "SPRAY-X2" }));
    expect(entries).toHaveLength(0);
  });

  it("does not skip when the existing product_cost entry belongs to another product", () => {
    const state = {
      ...baseState(),
      orders: [comboOrder()],
      wallet: [{ id: "we-ord-combo-product-cost-prd-biohair", ownerType: "seller" as const, ownerId: "seller-1", orderId: "ord-combo", type: "product_cost" as const, amountCop: -23000, description: "Costo producto", productId: "prd-biohair", createdAt: "2026-06-01T00:00:00.000Z" }]
    };
    const entries = buildMissingProductCostEntries(state, catalogItem({ id: "prd-spray", sku: "SPRAY-X2" }));
    expect(entries).toHaveLength(1);
    expect(entries[0].productId).toBe("prd-spray");
  });

  it("excludes orders already included in a seller settlement", () => {
    const state = {
      ...baseState(),
      orders: [comboOrder()],
      wallet: [{ id: "we-ord-combo-cod", ownerType: "seller" as const, ownerId: "seller-1", orderId: "ord-combo", type: "cod_revenue" as const, amountCop: 100000, description: "Recaudo", createdAt: "2026-06-01T00:00:00.000Z" }],
      settlements: [{ ...({} as AppState["settlements"][number]), id: "stl-1", kind: "seller" as const, ownerId: "seller-1", ownerName: "Tienda", startDate: "2026-06-01", endDate: "2026-06-30", walletEntryIds: ["we-ord-combo-cod"], orderIds: ["ord-combo"], codCop: 0, feesCop: 0, productCostCop: 0, driverPayCop: 0, platformMarginCop: 0, netCop: 0, status: "paid" as const, createdAt: "2026-06-30T00:00:00.000Z" }]
    };
    const entries = buildMissingProductCostEntries(state, catalogItem({ id: "prd-spray", sku: "SPRAY-X2" }));
    expect(entries).toHaveLength(0);
  });

  it("returns nothing when the cost is not configured", () => {
    const state = { ...baseState(), orders: [comboOrder()] };
    const entries = buildMissingProductCostEntries(state, catalogItem({ id: "prd-spray", sku: "SPRAY-X2", productCostConfigured: false }));
    expect(entries).toHaveLength(0);
  });
});
