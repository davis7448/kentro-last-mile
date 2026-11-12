import { describe, expect, it } from "vitest";
import { filterPendingPickup, sortPendingPickup, trackingNumber } from "./pending-pickup-search";

const order = (id: string, trackingCode: string | undefined, customerName: string, extra: { shopifyOrderId?: string; pickupPointName?: string; sellerId?: string } = {}) => ({
  id,
  trackingCode,
  customerName,
  shopifyOrderId: extra.shopifyOrderId ?? id,
  pickupPointName: extra.pickupPointName ?? "DANDA",
  sellerId: extra.sellerId ?? "seller-danda"
});

// Los de la captura del lider, en el orden en que salian.
const fromScreenshot = [
  order("a", "KNT-008465", "Edwin García"),
  order("b", "KNT-008503", "Luus Cortes"),
  order("c", "KNT-008504", "Francisco Quintero"),
  order("d", "KNT-008384", "Yuly Mosquera Franco"),
  order("e", "KNT-008469", "Cesar Cartaya"),
  order("f", "KNT-008386", "Rodolfo Viafara Viveros")
];

describe("spec 039 · orden por KNT (RF_04)", () => {
  it("ordena por numero KNT ascendente", () => {
    expect(sortPendingPickup(fromScreenshot).map((item) => item.trackingCode)).toEqual([
      "KNT-008384", "KNT-008386", "KNT-008465", "KNT-008469", "KNT-008503", "KNT-008504"
    ]);
  });

  it("compara por numero, no por texto", () => {
    const sorted = sortPendingPickup([order("x", "KNT-10000", "X"), order("y", "KNT-9999", "Y")]);
    expect(sorted.map((item) => item.id)).toEqual(["y", "x"]);
  });

  it("deja al final los pedidos sin KNT, por numero de Shopify", () => {
    const sorted = sortPendingPickup([
      order("s2", undefined, "Sin KNT 2", { shopifyOrderId: "200" }),
      order("k", "KNT-000001", "Con KNT"),
      order("s1", undefined, "Sin KNT 1", { shopifyOrderId: "100" })
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["k", "s1", "s2"]);
  });

  it("no muta la lista de entrada", () => {
    const input = [...fromScreenshot];
    sortPendingPickup(input);
    expect(input).toEqual(fromScreenshot);
  });
});

describe("spec 039 · busqueda (RF_02, RF_03)", () => {
  it("sin texto devuelve todo", () => {
    expect(filterPendingPickup(fromScreenshot, "  ")).toHaveLength(fromScreenshot.length);
  });

  it("encuentra por KNT completo, sin importar mayusculas", () => {
    expect(filterPendingPickup(fromScreenshot, "knt-008503").map((item) => item.id)).toEqual(["b"]);
  });

  it("encuentra por cifras sin prefijo ni ceros a la izquierda", () => {
    expect(filterPendingPickup(fromScreenshot, "8465").map((item) => item.id)).toEqual(["a"]);
  });

  it("las cifras parciales tambien coinciden como texto", () => {
    expect(filterPendingPickup(fromScreenshot, "0085").map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("encuentra por cliente sin tildes", () => {
    expect(filterPendingPickup(fromScreenshot, "garcia").map((item) => item.id)).toEqual(["a"]);
    expect(filterPendingPickup(fromScreenshot, "VIÁFARA").map((item) => item.id)).toEqual(["f"]);
  });

  it("encuentra por punto de recogida y por nombre de la tienda", () => {
    const orders = [
      order("p", "KNT-1", "Ana", { pickupPointName: "Bodega Norte", sellerId: "s-kovia" }),
      order("q", "KNT-2", "Luis", { pickupPointName: "DANDA", sellerId: "seller-danda" })
    ];
    const sellers = new Map([["s-kovia", "Kovia"], ["seller-danda", "DANDA"]]);
    expect(filterPendingPickup(orders, "norte", sellers).map((item) => item.id)).toEqual(["p"]);
    expect(filterPendingPickup(orders, "kovia", sellers).map((item) => item.id)).toEqual(["p"]);
    expect(filterPendingPickup(orders, "danda", sellers).map((item) => item.id)).toEqual(["q"]);
  });

  it("busca en toda la lista, no en una pagina", () => {
    const many = Array.from({ length: 40 }, (_, index) => order(`o${index}`, `KNT-${String(index + 1).padStart(6, "0")}`, `Cliente ${index}`));
    expect(filterPendingPickup(many, "40").map((item) => item.id)).toEqual(["o39"]);
  });

  it("sin coincidencias devuelve lista vacia", () => {
    expect(filterPendingPickup(fromScreenshot, "zzz")).toEqual([]);
  });
});

describe("trackingNumber", () => {
  it("extrae el numero o devuelve null", () => {
    expect(trackingNumber("KNT-008465")).toBe(8465);
    expect(trackingNumber(undefined)).toBeNull();
    expect(trackingNumber("sin numero")).toBeNull();
  });
});
