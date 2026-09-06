import { describe, expect, it } from "vitest";
import { mergeWalletEntries } from "./finance";
import type { WalletEntry } from "./types";

const entry = (id: string, amountCop: number) => ({ id, amountCop, ownerType: "seller", ownerId: "s1", orderId: "o1", type: "cod_revenue", description: "", createdAt: "2026-08-01T00:00:00.000Z" }) as unknown as WalletEntry;

describe("mergeWalletEntries", () => {
  it("reemplaza los que ya existen conservando el orden", () => {
    const out = mergeWalletEntries([entry("a", 1), entry("b", 2)], [entry("b", 99)]);
    expect(out.map((e) => [e.id, e.amountCop])).toEqual([["a", 1], ["b", 99]]);
  });

  it("anade los nuevos al principio", () => {
    const out = mergeWalletEntries([entry("a", 1)], [entry("z", 5)]);
    expect(out.map((e) => e.id)).toEqual(["z", "a"]);
  });

  it("no duplica cuando la tanda mezcla nuevos y existentes", () => {
    const out = mergeWalletEntries([entry("a", 1), entry("b", 2)], [entry("b", 20), entry("c", 3)]);
    expect(out.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
    expect(out.find((e) => e.id === "b")?.amountCop).toBe(20);
  });

  it("devuelve el original si la tanda viene vacia", () => {
    const current = [entry("a", 1)];
    expect(mergeWalletEntries(current, [])).toBe(current);
  });

  it("compuesto con un filtro previo, deja fuera los asientos borrados por una correccion", () => {
    // Es la composicion que usa OrderCard al aplicar una correccion de estado:
    // mergeWalletEntries no sabe borrar, asi que los eliminados se filtran ANTES. Sin este
    // orden, un asiento revertido seguiria sumando en la wallet hasta el proximo refresco.
    const current = [entry("we-o1-cod", 100000), entry("we-o1-delivery-fee", -12000), entry("otro", 5)];
    const deleted = new Set(["we-o1-cod", "we-o1-delivery-fee"]);
    const created = [entry("we-o1-seller-failed-fee", -12000)];
    const out = mergeWalletEntries(current.filter((item) => !deleted.has(item.id)), created);
    expect(out.map((item) => item.id).sort()).toEqual(["otro", "we-o1-seller-failed-fee"]);
    expect(out.reduce((sum, item) => sum + item.amountCop, 0)).toBe(-11995);
  });

  it("da el MISMO resultado que la version lineal que sustituye", () => {
    const current = Array.from({ length: 400 }, (_, i) => entry(`e${i}`, i));
    const incoming = [entry("e5", 500), entry("e399", 900), entry("nuevo", 7)];
    const known = new Set(current.map((e) => e.id));
    const legacy = [...incoming.filter((e) => !known.has(e.id)), ...current.map((e) => incoming.find((i) => i.id === e.id) ?? e)];
    expect(mergeWalletEntries(current, incoming)).toEqual(legacy);
  });
});
