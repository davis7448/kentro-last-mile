/**
 * Spec 039: guardas de fuente de la tarjeta «Recogidos pendientes de mensajero». La logica de
 * busqueda y orden se prueba en `pending-pickup-search.test.ts`; aqui se ata la tarjeta a ella y a
 * las reglas de seleccion, que son las que el lider nota si se rompen.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../components/operations-app.tsx");
const sliceFn = (source: string, name: string) => {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};
const panel = sliceFn(app, "AssignPickedUpOrdersPanel");

describe("spec 039 — tarjeta de recogidos pendientes", () => {
  it("RF_01/RF_02/RF_04: ordena y filtra con el modulo puro, sobre toda la lista", () => {
    expect(panel).toMatch(/sortPendingPickup\(orders\)/);
    expect(panel).toMatch(/filterPendingPickup\(sortedOrders, search, sellerNameById\)/);
    expect(panel).toMatch(/<PaginatedList[\s\S]*items=\{visibleOrders\}/);
    expect(panel).toMatch(/placeholder="KNT, cliente o tienda"/);
  });

  it("RF_05: cambiar la busqueda vuelve a la primera pagina", () => {
    expect(panel).toMatch(/<PaginatedList\s+key=\{search\.trim\(\)\}/);
  });

  it("RF_06: lo marcado se asigna aunque no se vea", () => {
    expect(panel).toMatch(/const selectedOrders = orders\.filter\(\(order\) => selectedIds\.includes\(order\.id\)\)/);
    expect(panel).toMatch(/assignSelected\(selectedOrders\)/);
  });

  it("RF_07/RF_10: cuenta lo oculto, quita la seleccion y selecciona lo que coincide", () => {
    expect(panel).toMatch(/fuera de esta busqueda/);
    expect(panel).toMatch(/Quitar seleccion/);
    expect(panel).toMatch(/que coinciden/);
  });

  it("RF_08: sin coincidencias lo dice", () => {
    expect(panel).toMatch(/Ningun pedido coincide con/);
  });

  it("RF_09: «Asignar toda la recogida» sigue siendo toda, con su numero", () => {
    expect(panel).toMatch(/onClick=\{\(\) => void assignSelected\(orders\)\}/);
    expect(panel).toMatch(/Asignar toda la recogida \(<span className="tabular">\{orders\.length\}<\/span>\)/);
  });

  it("RNF_02: la tarjeta no lee de Firestore", () => {
    expect(panel).not.toMatch(/getDocs|onSnapshot|getDoc\(|collection\(/);
  });

  it("la tienda llega desde la vista del lider", () => {
    expect(app).toMatch(/<AssignPickedUpOrdersPanel\s+orders=\{pendingMessenger\}\s+messengers=\{messengers\}\s+sellers=\{state\.sellers\}/);
  });
});
