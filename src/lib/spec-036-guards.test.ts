/**
 * Spec 036 — la API de tiendas dice, dentro del propio JSON, que la cifra que se paga hoy es
 * `disponibleCop` y que `bloqueadoCodCop` es efectivo que todavia tiene el domiciliario.
 * Origen: el agente de una tienda reconstruia el saldo sumando pedidos entregados de `/orders` y
 * reclamaba como deuda el efectivo del mismo dia.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSellerBalanceInput, computeSellerBalance } from "../../functions/src/seller-balance";
import {
  buildStoreSummary,
  STORE_API_NOTICES,
  STORE_BALANCE_NOTICE,
  STORE_ORDER_PAYMENT_MEANING,
  STORE_PAYOUT_NOTICE
} from "../../functions/src/store-summary";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
}

/** El bloque de codigo de una respuesta, desde su `if` hasta su `return;`. */
function block(code: string, marker: string): string {
  const start = code.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return code.slice(start, code.indexOf("return;", start));
}

const SELLER = "seller-x";
const NOW = "2026-11-06T12:00:00.000Z";
const balance = computeSellerBalance(buildSellerBalanceInput({ sellerId: SELLER, wallet: [], orders: [], settlements: [], settings: {}, zones: [], now: NOW }));
const summary = buildStoreSummary([], new Map(), balance, []);

describe("spec 036 · RF_01 · el aviso de pago", () => {
  it("esta fechado el 2026-11-06 y nombra las dos cifras", () => {
    expect(STORE_PAYOUT_NOTICE.fecha).toBe("2026-11-06");
    expect(STORE_PAYOUT_NOTICE.campos).toEqual(expect.arrayContaining(["disponibleCop", "bloqueadoCodCop"]));
  });

  it("dice que se paga disponibleCop, quien tiene el bloqueado y cuando pasa a disponible", () => {
    const texto = STORE_PAYOUT_NOTICE.cambio;
    expect(texto).toMatch(/paga hoy es disponibleCop/);
    expect(texto).toMatch(/bloqueadoCodCop/);
    expect(texto).toMatch(/domiciliario todavia no ha entregado/);
    expect(texto).toMatch(/dia siguiente/);
    expect(texto).toMatch(/pasa a disponibleCop cuando Kentro/);
    expect(texto).toMatch(/no lo reconstruyas sumando pedidos entregados/);
  });

  it("/resumen lo trae", () => {
    expect(summary.avisos).toContain(STORE_PAYOUT_NOTICE);
  });
});

describe("spec 036 · RF_02 · significados del resumen", () => {
  it("bloqueadoCodCop dice que lo tiene el domiciliario y que no se paga aun", () => {
    expect(summary.significado.bloqueadoCodCop).toMatch(/lo tiene todavia el domiciliario/);
    expect(summary.significado.bloqueadoCodCop).toMatch(/no se paga hasta/);
  });

  it("disponibleCop dice que es la cifra que se paga", () => {
    expect(summary.significado.disponibleCop).toMatch(/cifra que se paga/);
  });
});

describe("spec 036 · RF_03 · /orders trae avisos y significado de pago.estado", () => {
  it("el significado explica cada estado y el bloqueado igual que el resumen", () => {
    expect(Object.keys(STORE_ORDER_PAYMENT_MEANING).sort()).toEqual(
      ["en_liquidacion", "pagado", "pendiente_bloqueado_cod", "pendiente_habilitado", "sin_movimientos"].sort()
    );
    expect(STORE_ORDER_PAYMENT_MEANING.pendiente_bloqueado_cod).toMatch(/lo tiene todavia el domiciliario/);
  });

  it("la respuesta del listado usa la lista de avisos y el significado", () => {
    const orders = block(source("functions/src/store-api.ts"), 'if (resource === "orders") {');
    expect(orders.includes("avisos: STORE_API_NOTICES")).toBe(true);
    expect(orders.includes("significado: { pago: STORE_ORDER_PAYMENT_MEANING }")).toBe(true);
  });
});

describe("spec 036 · RNF_03 · storeApi con memoria suficiente para /orders", () => {
  it("declara 512MiB (con 256 MiB, /orders de DANDA respondia 500 desde Node 22)", () => {
    expect(/export const storeApi = onRequest\(\s*\{[^}]*memory: "512MiB"/.test(source("functions/src/store-api.ts"))).toBe(true);
  });
});

describe("spec 036 · RF_04 / RF_05 / RNF_02 · una sola lista de avisos", () => {
  it("el mas reciente primero y el de la 018 se conserva", () => {
    expect(STORE_API_NOTICES).toEqual([STORE_PAYOUT_NOTICE, STORE_BALANCE_NOTICE]);
    expect(summary.avisos).toEqual([...STORE_API_NOTICES]);
  });

  it("/docs lo trae en una clave nueva y deja `avisos` como estaba (spec 029 RF_20)", () => {
    const docs = block(source("functions/src/store-api.ts"), 'if (resource === "docs")');
    expect(docs.includes("avisoDePago: STORE_PAYOUT_NOTICE")).toBe(true);
    expect(docs.includes("avisos: [STORE_BALANCE_NOTICE]")).toBe(true);
  });
});
