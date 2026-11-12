/**
 * Spec 040: guardas de fuente. La bodega de cada linea se decide con la MISMA regla que cobra
 * (`functions/src/catalog-match.ts`), y la impresion no escribe nada mas que la marca de impreso.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const walletEntries = read("../../functions/src/wallet-entries.ts");
const packages = read("../../functions/src/supplier-packages.ts");
const app = read("../components/operations-app.tsx");
const sliceFn = (source: string, name: string) => {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

describe("spec 040 — una sola regla linea -> producto (RNF_01)", () => {
  it("wallet-entries ya no declara su propio emparejador: lo importa de catalog-match", () => {
    expect(walletEntries).not.toMatch(/function matchCatalogForLine\(/);
    expect(walletEntries).not.toMatch(/function normalizeProductName\(/);
    expect(walletEntries).toMatch(/import \{ matchCatalogForLine \} from "\.\/catalog-match"/);
  });

  it("supplier-packages usa el mismo emparejador y no declara otro", () => {
    expect(packages).toMatch(/import \{ matchCatalogForLine \} from "\.\/catalog-match"/);
    expect(packages).not.toMatch(/function matchCatalog/);
    expect(packages).not.toMatch(/firebase/);
  });
});

describe("spec 040 — la impresion (RNF_02, RF_03)", () => {
  const print = sliceFn(app, "printOrderLabels");

  it("el bloque de producto sale de los paquetes, no de los campos colapsados del pedido", () => {
    expect(print).toMatch(/splitOrderIntoPackages|groupBatchBySupplier/);
    expect(print).not.toMatch(/order\.productName/);
    expect(print).not.toMatch(/order\.sku\b/);
    expect(print).not.toMatch(/order\.quantity/);
  });

  it("el cobro solo se imprime en el paquete que cobra (D3)", () => {
    expect(print).toMatch(/pkg\.collectsPayment/);
  });

  it("imprimir no llama a callables ni escribe en Firestore", () => {
    expect(print).not.toMatch(/saveFirestore|httpsCallable|callFirebase|setDoc|updateDoc/);
    const mark = sliceFn(app, "markOrdersLabelsPrinted");
    expect(mark.match(/saveFirestore\w+/g)).toEqual(["saveFirestoreOrderLabelPrint"]);
  });

  it("la tienda imprime sin hoja de tanda ni selector (RF_10)", () => {
    const sellerCall = app.match(/printOrderLabels\(pendingSellerLabelOrders, state, "Rotulos vendedor pendientes"\)/);
    expect(sellerCall).not.toBeNull();
  });
});
