/**
 * Guardas de fuente de la spec 018 — `specs/018_saldo_de_tienda_igual_al_cierre.md`.
 *
 * La aritmetica vive en modulos puros y se prueba en `seller-balance.test.ts` y
 * `seller-retention.test.ts`. Aqui se guarda la FORMA de lo que la suite no puede ejecutar: las
 * callables (importan `firebase-admin`) y el monolito `operations-app.tsx` (importa el SDK del
 * navegador). Como en la 005 y la 013, se afirma sobre booleanos y fragmentos cortos, nunca con
 * `expect(FUENTE).toMatch(...)`, para no volcar miles de lineas en un fallo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Fuente sin comentarios: un requisito escrito en un comentario no es una garantia. */
function source(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Cuerpo de `export const <name> = onCall(...)` hasta el siguiente `export ` de primer nivel. */
function exportedBlock(code: string, name: string): string {
  const start = code.indexOf(`export const ${name} =`);
  if (start < 0) return "";
  const next = code.indexOf("\nexport ", start + 1);
  return code.slice(start, next < 0 ? undefined : next);
}

/** Cuerpo de una funcion local `function <name>(` hasta la siguiente declaracion de primer nivel. */
function functionBlock(code: string, name: string): string {
  const start = code.search(new RegExp(`\\n(export )?(async )?function ${name}\\b`));
  if (start < 0) return "";
  const next = code.slice(start + 1).search(/\n(export |async |function |const |type |let )/);
  return code.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe("spec 018 · T5 · callable getSellerBalance (RF_01, RF_22, RNF_03)", () => {
  const api = source("functions/src/seller-balance-api.ts");
  const callable = exportedBlock(api, "getSellerBalance");
  const loader = functionBlock(api, "loadSellerBalanceInput");

  it("existe y se exporta desde index.ts", () => {
    expect(callable.length > 0).toBe(true);
    expect(/export \{[^}]*\bgetSellerBalance\b[^}]*\} from "\.\/seller-balance-api"/.test(source("functions/src/index.ts"))).toBe(true);
  });

  it("calcula con la regla unica: buildSellerBalanceInput + computeSellerBalance", () => {
    expect(loader.includes("buildSellerBalanceInput(")).toBe(true);
    expect(callable.includes("computeSellerBalance(")).toBe(true);
  });

  it("solo admin y tienda; el logistico de tienda (sin acceso financiero) queda fuera", () => {
    expect(/role !== "seller" && role !== "admin"/.test(callable)).toBe(true);
    expect(callable.includes("seller_logistics")).toBe(false);
    expect(callable.includes("permission-denied")).toBe(true);
  });

  it("la tienda consulta SIEMPRE su propia tienda (el claim), nunca un sellerId del cliente", () => {
    expect(/role === "seller"\s*\?\s*sellerClaim/.test(callable)).toBe(true);
  });

  it("RF_22: con asientos ilegibles no devuelve cifra", () => {
    expect(/unreadableEntryIds\.length\s*>\s*0/.test(callable)).toBe(true);
    expect(callable.includes("failed-precondition")).toBe(true);
  });

  it("lee por id los asientos de manejo de los candidatos (manejo ya cobrado)", () => {
    expect(/fulfillment-fee/.test(loader)).toBe(true);
  });

  it("RNF_03: la consulta de candidatos esta acotada por tienda y por estado", () => {
    expect(/where\("sellerId", "==", sellerId\)\.where\("status", "in"/.test(loader)).toBe(true);
  });

  it("el wrapper del navegador existe", () => {
    expect(/export async function getFirebaseSellerBalance\(/.test(source("src/lib/firebase/auth.ts"))).toBe(true);
  });
});

describe("spec 018 · T6 · createSettlement liquida pedidos completos (RF_01, RF_12, RF_13, RF_17, RF_23, RF_24)", () => {
  const orders = source("functions/src/orders.ts");
  const create = exportedBlock(orders, "createSettlement");

  it("usa la definicion unica de efectivo recibido y no conserva una copia inline", () => {
    expect(create.includes("buildCodReceivedSet(")).toBe(true);
    expect(/allocation\.covered/.test(create)).toBe(false);
  });

  it("en tienda, la seleccion sale de selectSettlementEntries con el saldo de la tienda entera", () => {
    expect(create.includes("loadSellerBalanceInput(")).toBe(true);
    expect(create.includes("computeSellerBalance(")).toBe(true);
    expect(create.includes("selectSettlementEntries(")).toBe(true);
  });

  it("no hay otra comparacion con la retencion fuera de la regla unica", () => {
    expect(/retentionTheoreticalCop\s*[<>]/.test(create)).toBe(false);
    expect(/payableCop\s*[-<>]/.test(create)).toBe(false);
  });

  it("RF_24: si la seleccion no es valida, rechaza con el motivo", () => {
    expect(/if \(!\w+\.ok\)/.test(create)).toBe(true);
    expect(create.includes("payoutRejectionMessage(")).toBe(true);
  });

  it("la transaccion solo cierra lo seleccionado", () => {
    expect(/selection\.entryIds/.test(create)).toBe(true);
  });

  it("RF_17: el monto de una solicitud abierta no decide el corte", () => {
    expect(/amountCop/.test(create.slice(create.indexOf("openPayoutRefs")))).toBe(false);
  });
});

describe("spec 018 · T7 · requestSellerPayout usa el disponible (RF_01, RF_16)", () => {
  const orders = source("functions/src/orders.ts");
  const request = exportedBlock(orders, "requestSellerPayout");

  it("calcula con el cargador y la regla unica", () => {
    expect(request.includes("loadSellerBalanceInput(")).toBe(true);
    expect(request.includes("computeSellerBalance(")).toBe(true);
    expect(request.includes("summarizeSellerPayable(")).toBe(false);
  });

  it("RF_16: con disponible en cero rechaza explicando el motivo", () => {
    expect(/availableCop\s*<=\s*0/.test(request)).toBe(true);
    expect(request.includes("payoutRejectionMessage(")).toBe(true);
  });

  it("pide exactamente el disponible", () => {
    expect(/amountCop:\s*balance\.availableCop/.test(request)).toBe(true);
  });
});

describe("spec 018 · T8 · API para tiendas (RF_25)", () => {
  it("store-summary.ts es puro: no importa firebase-admin ni firebase-functions", () => {
    const summary = source("functions/src/store-summary.ts");
    expect(/from "firebase-(admin|functions)/.test(summary)).toBe(false);
  });

  it("store-api.ts arma el saldo con la regla unica y lee ajustes y zonas", () => {
    const api = source("functions/src/store-api.ts");
    expect(api.includes("buildSellerBalanceInput(")).toBe(true);
    expect(api.includes("computeSellerBalance(")).toBe(true);
    expect(/collection\("settings"\)\.doc\("global"\)/.test(api)).toBe(true);
    expect(/collection\("zones"\)/.test(api)).toBe(true);
    expect(/function buildStoreSummary\(/.test(api)).toBe(false);
  });
});

describe("spec 018 · T9 · el admin usa la definicion y la elegibilidad del servidor (RF_04, RF_20)", () => {
  const app = source("src/components/operations-app.tsx");

  it("no quedan copias locales de 'efectivo recibido' ni de la elegibilidad de tienda", () => {
    expect(/function receivedDriverOrderIds\b/.test(app)).toBe(false);
    expect(/cashPendingCop === 0/.test(app)).toBe(false);
    expect(/function isSellerEntryEligible\b/.test(app)).toBe(false);
  });

  it("importa las del servidor", () => {
    expect(/import \{[^}]*\bbuildCodReceivedSet\b[^}]*\bisSellerEntryEligible\b[^}]*\} from "\.\.\/\.\.\/functions\/src\/seller-ledger"/.test(app)).toBe(true);
  });
});

describe("spec 018 · T10 · cierre pendiente del admin con el disponible (RF_01, RF_20, RF_22)", () => {
  const app = source("src/components/operations-app.tsx");

  it("las filas de tienda salen de buildSellerBalanceInput + computeSellerBalance", () => {
    expect(app.includes("buildSellerBalanceInput(")).toBe(true);
    expect(app.includes("computeSellerBalance(")).toBe(true);
    expect(/selection\.entryIds/.test(app)).toBe(true);
  });

  it("ya no se construyen filas de tienda con TODO lo elegible", () => {
    expect(/buildLiquidationRows\(state, eligiblePendingSellerEntries/.test(app)).toBe(false);
  });

  it("el detalle muestra efectivo con el domiciliario, retenido, total y saldo incompleto", () => {
    expect(app.includes("Efectivo aun con el domiciliario")).toBe(true);
    expect(/Retenido \(/.test(app)).toBe(true);
    expect(app.includes("Total sin cortar")).toBe(true);
    expect(app.includes("Saldo incompleto")).toBe(true);
  });

  it("el corte de tienda envia exactamente los asientos que muestra la fila", () => {
    expect(/walletEntryIds: row\.role === "seller" \? row\.walletEntryIds : undefined/.test(app)).toBe(true);
  });
});

describe("spec 018 · T11 · tarjeta heroe de la tienda (RF_18, RF_21, RF_22)", () => {
  const app = source("src/components/operations-app.tsx");
  const hook = functionBlock(app, "useSellerBalance");
  const sellerViewStart = app.indexOf("function SellerView(");
  const sellerView = app.slice(sellerViewStart, app.indexOf("\nfunction ", sellerViewStart + 10));

  it("RF_18: la tarjeta heroe dice lo que es y no promete 'lo de hoy'", () => {
    expect(sellerView.includes("Disponible para liquidar")).toBe(true);
    expect(sellerView.includes("Lo pendiente de hoy")).toBe(false);
    expect(sellerView.includes("Saldo pendiente por liquidar")).toBe(false);
  });

  it("la cifra sale del servidor, no de la suma local de asientos", () => {
    expect(hook.includes("getFirebaseSellerBalance(")).toBe(true);
    expect(/sellerBalance\(state/.test(sellerView)).toBe(false);
  });

  it("RF_21: refresca cada 5 minutos y al volver a la pestana", () => {
    expect(/const SELLER_BALANCE_REFRESH_MS = 300000;/.test(app)).toBe(true);
    expect(/setInterval\(load, SELLER_BALANCE_REFRESH_MS\)/.test(hook)).toBe(true);
    expect(hook.includes("visibilitychange")).toBe(true);
  });

  it("RF_22: un error deja el estado sin cifra previa y la tarjeta ofrece reintentar", () => {
    expect(/status: "error"/.test(hook)).toBe(true);
    expect(/\{ status: "error"[^}]*balance/.test(hook)).toBe(false);
    expect(sellerView.includes("No pudimos calcular tu saldo")).toBe(true);
    expect(sellerView.includes("Reintentar")).toBe(true);
  });

  it("principio 13: el hook se llama antes del return anticipado de SellerView", () => {
    const hookCall = sellerView.indexOf("useSellerBalance(");
    const earlyReturn = sellerView.indexOf("if (profileState.kind !== \"ok\"");
    expect(hookCall > 0).toBe(true);
    expect(earlyReturn < 0 || hookCall < earlyReturn).toBe(true);
  });
});

describe("spec 018 · T12 · panel de wallet de la tienda y retirada de la reserva fija (RF_07, RF_16, RF_19)", () => {
  const app = source("src/components/operations-app.tsx");
  const panel = functionBlock(app, "WalletPanel");
  const request = functionBlock(app, "SellerPayoutRequest");

  it("RF_07: nadie usa la reserva fija ni la vieja funcion sellerBalance", () => {
    for (const file of ["src/components/operations-app.tsx", "src/lib/finance.ts", "src/lib/actions.ts"]) {
      const code = source(file);
      expect(/\bsellerBalance\(/.test(code), file).toBe(false);
      expect(/\.pendingReserveCop\b/.test(code), file).toBe(false);
    }
    expect(panel.includes("Reserva")).toBe(false);
  });

  it("RF_19: el panel muestra disponible, efectivo con el domiciliario, retenido y total", () => {
    expect(panel.includes("Disponible para liquidar")).toBe(true);
    expect(panel.includes("Efectivo aun con el domiciliario")).toBe(true);
    expect(panel.includes("Retenido")).toBe(true);
    expect(panel.includes("Total sin cortar")).toBe(true);
  });

  it("RF_16: con disponible en cero el boton de solicitud no se ofrece y explica el motivo", () => {
    expect(/availableCop <= 0/.test(request)).toBe(true);
    expect(request.includes("payoutRejectionMessage(")).toBe(true);
  });
});

describe("spec 018 · T14 · hallazgos de la revision adversarial (ronda 1)", () => {
  const app = source("src/components/operations-app.tsx");

  it("R1-RF_20-1: una tienda con efectivo, retenido o ilegibles no desaparece del cierre del admin", () => {
    expect(/function buildLiquidationRows\(.*keepSellerIds: ReadonlySet<string>/.test(app)).toBe(true);
    expect(/keepSellerIds\.has\(row\.id\)/.test(app)).toBe(true);
    expect(/buildLiquidationRows\(state, selectedSellerEntries, state\.wallet, audits, \w+\)/.test(app)).toBe(true);
  });

  it("R1-RF_22-1: la API para tiendas no devuelve cifra con asientos ilegibles", () => {
    const api = source("functions/src/store-api.ts");
    const resumen = api.slice(api.indexOf('if (resource === "resumen")'));
    expect(/unreadableEntryIds\.length\s*>\s*0/.test(resumen.slice(0, resumen.indexOf("buildStoreSummary(")))).toBe(true);
  });

  it("R1-RF_09-1: pasar a recogido o en ruta sella pickedUpAt si faltaba", () => {
    const transition = exportedBlock(source("functions/src/orders.ts"), "applyOrderTransition");
    expect(/pickedUpAt/.test(transition)).toBe(true);
    expect(/"picked_up"/.test(transition) && /"in_route"/.test(transition)).toBe(true);
  });

  it("R1-RF_01-1: el panel de wallet no congela la hora del calculo", () => {
    expect(/useMemo\(\(\) => new Date\(\)\.toISOString\(\), \[\]\)/.test(app)).toBe(false);
  });
});

describe("spec 018 · T15 · hallazgos de la ronda 2", () => {
  const app = source("src/components/operations-app.tsx");
  const closeRow = app.slice(app.indexOf("const closeRow = ("), app.indexOf("const closeRow = (") + 2500);

  it("R2-RF_20-1: una fila de tienda sin asientos no lanza un corte", () => {
    expect(/row\.role === "seller" && row\.walletEntryIds\.length === 0/.test(closeRow)).toBe(true);
    const guardAt = closeRow.indexOf('row.walletEntryIds.length === 0');
    expect(guardAt >= 0 && guardAt < closeRow.indexOf("createFirebaseSettlement(")).toBe(true);
  });

  it("R2-RF_20-1 / RF_22: el servidor no corta una tienda con asientos ilegibles", () => {
    const create = exportedBlock(source("functions/src/orders.ts"), "createSettlement");
    expect(/balance\.unreadableEntryIds\.length\s*>\s*0/.test(create)).toBe(true);
  });
});

describe("spec 018 · T16 · RNF_04: la cifra no espera a la carga de Firestore", () => {
  const app = source("src/components/operations-app.tsx");

  it("el hook usa la tienda de la sesion, disponible desde el primer pintado", () => {
    expect(/useSellerBalance\(session\.profileId,/.test(app)).toBe(true);
  });

  it("la callable declara memoria (CPU) para el arranque en frio", () => {
    const api = source("functions/src/seller-balance-api.ts");
    expect(/export const getSellerBalance = onCall\(\{[^}]*memory: "512MiB"/.test(api)).toBe(true);
  });
});

describe("spec 018 · T17 · RF_26: el indice de la API avisa del cambio", () => {
  it("la respuesta de docs incluye el aviso y la descripcion de /resumen nombra retenidoCop", () => {
    const api = source("functions/src/store-api.ts");
    const docs = api.slice(api.indexOf('if (resource === "docs")'), api.indexOf("return;", api.indexOf('if (resource === "docs")')));
    expect(docs.includes("avisos: [STORE_BALANCE_NOTICE]")).toBe(true);
    expect(/"GET \/resumen":[^\n]*retenidoCop/.test(docs)).toBe(true);
  });
});
