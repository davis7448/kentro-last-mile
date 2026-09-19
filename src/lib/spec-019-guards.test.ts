/**
 * Guardas de fuente de la spec 019 — `specs/019_el_corte_muestra_lo_que_cobra.md`.
 *
 * La aritmetica del detalle vive en modulos puros y se prueba de verdad en `finance.test.ts` y
 * `driver-settlement-export.test.ts`. Aqui se guarda la FORMA de lo que la suite no puede ejecutar:
 * `state-store.ts` y `operations-app.tsx` importan el SDK del navegador.
 *
 * La guarda que de verdad importa es la de los DOS puntos de llamada de `pinOrders`. El fallo que
 * origino esta spec fue exactamente ese: el rescate de pedidos por id se alimentaba de una sola via
 * —los movimientos SIN liquidar— y los pedidos que salian en $0 eran justo los contrarios, los que
 * ya estaban en un corte. Si alguien vuelve a dejar una sola via, esto se pone rojo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Fuente sin comentarios: un requisito escrito en un comentario no es una garantia. */
function source(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Cuerpo de una declaracion `const <name> = ...` por BALANCE DE LLAVES.
 *
 * Buscar "la siguiente declaracion de primer nivel" con una regex corta el bloque en el primer
 * `const` anidado, que es justo lo que tiene dentro cualquier funcion de verdad. Contar llaves es
 * mas aburrido y no se equivoca.
 */
function constBlock(code: string, name: string): string {
  const start = code.search(new RegExp(`\\bconst ${name}\\b`));
  if (start < 0) return "";
  const open = code.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(start, index + 1);
    }
  }
  return code.slice(start);
}

const STATE_STORE = source("src/lib/firebase/state-store.ts");
const OPERATIONS = source("src/components/operations-app.tsx");

describe("spec 019 · T6 · el tope de rescate es acumulado (RF_07, RNF_02)", () => {
  const pinOrders = constBlock(STATE_STORE, "pinOrders");

  it("existe el bloque de pinOrders", () => {
    expect(pinOrders.length).toBeGreaterThan(100);
  });

  it("RNF_02 · el tope NO se aplica por llamada", () => {
    // `.slice(0, MAX_PINNED_ORDERS)` a secas dejaba que N llamadas fijaran N x 800.
    expect(pinOrders.includes("slice(0, MAX_PINNED_ORDERS)")).toBe(false);
  });

  it("RNF_02 · el tope se consume contra lo ya pedido en esta carga de pagina", () => {
    expect(pinOrders.includes("MAX_PINNED_ORDERS - pinnedRequested.size")).toBe(true);
  });

  it("RF_11 · devuelve el parte para poder decir que el detalle quedo incompleto a proposito", () => {
    expect(pinOrders.includes("skippedByBudget")).toBe(true);
  });

  it("el lider sigue leyendo de uno en uno, nunca por lotes", () => {
    // Regla de oro 7: un solo id ajeno tumba un lote entero y la perdida seria silenciosa.
    expect(pinOrders.includes("getDocumentsOneByOne")).toBe(true);
    expect(pinOrders.includes('context?.role === "admin"')).toBe(true);
  });

  it("RF_06 · y ese bucle es el modulo puro, el que la suite SI ejecuta", () => {
    // Mientras vivio aqui dentro, vaciar su `try/catch` no ponia nada en rojo. Ver
    // `read-each-by-id.test.ts`, que prueba el comportamiento de verdad (DoD 5).
    expect(STATE_STORE.includes('from "@/lib/read-each-by-id"')).toBe(true);
    const oneByOne = STATE_STORE.slice(STATE_STORE.indexOf("async function getDocumentsOneByOne"));
    expect(oneByOne.slice(0, 900).includes("readEachById")).toBe(true);
  });

  it("RF_07 · un id ya descargado o ya pedido no gasta una segunda lectura", () => {
    // Sostiene "cada identificador una sola vez por carga de pagina" y dos casos limite: la lectura
    // fallida que no se reintenta en bucle, y el pedido que ya trajo la otra via del rescate.
    expect(pinOrders.includes("!known.has(id)")).toBe(true);
    expect(pinOrders.includes("!pinnedRequested.has(id)")).toBe(true);
  });
});

describe("spec 019 · T7 · el rescate se alimenta de DOS vias (RF_05, DoD 4)", () => {
  it("DoD 4 · pinOrders se usa desde mas de un sitio, no solo donde se declara", () => {
    // La declaracion (`const pinOrders = async ...`) mas, al menos, la llamada de los movimientos
    // sin liquidar y la entrega por `onControls`. Si alguien vuelve a dejar una sola via, cae.
    const mentions = STATE_STORE.match(/\bpinOrders\b/g) ?? [];
    expect(mentions.length).toBeGreaterThanOrEqual(3);
  });

  it("DoD 4 · sigue existiendo la via de los movimientos sin liquidar", () => {
    // Es la que sostiene "Pendiente por entregar" del lider (constitucion, principio 8).
    expect(STATE_STORE.includes("selectUnsettledWalletEntries")).toBe(true);
  });

  it("DoD 4 · y existe una via que NO pasa por los movimientos sin liquidar", () => {
    // La suscripcion entrega `pinOrders` a quien la abre, para que lo pida bajo demanda.
    expect(STATE_STORE.includes("onControls?.({ pinOrders })")).toBe(true);
  });

  it("RF_05 · la firma declara el canal como quinto callback OPCIONAL", () => {
    const start = STATE_STORE.indexOf("export function subscribeFirestoreState(");
    const signature = STATE_STORE.slice(start, STATE_STORE.indexOf(") {", start));
    expect(signature.includes("onControls?:")).toBe(true);
    expect(signature.includes("onError?:")).toBe(true);
  });

  it("el valor de retorno sigue siendo la desuscripcion", () => {
    // Quien llama lo devuelve como cleanup de su efecto: cambiarlo de tipo romperia la limpieza.
    const tail = STATE_STORE.slice(STATE_STORE.indexOf("onControls?.({ pinOrders })"));
    expect(tail.includes("stopped = true")).toBe(true);
    expect(tail.includes("unsubscribers.forEach")).toBe(true);
  });

  it("la vista expone el canal hasta el panel del domiciliario", () => {
    expect(OPERATIONS.includes("pinSettlementOrders")).toBe(true);
    expect(OPERATIONS.includes("onPinSettlementOrders={pinSettlementOrders}")).toBe(true);
  });
});

describe("spec 019 · T8 · el rescate va al EXPANDIR, no al montar (RF_05, RNF_02)", () => {
  const toggle = constBlock(OPERATIONS, "toggleSettlement");

  it("existe el manejador de expandir", () => {
    expect(toggle.length).toBeGreaterThan(100);
  });

  it("RF_05 · pide solo los pedidos que no estan descargados", () => {
    expect(toggle.includes("row.unavailable")).toBe(true);
    expect(toggle.includes("onPinSettlementOrders(missing)")).toBe(true);
  });

  it("RNF_02 · no pide los pedidos de la pagina entera de cortes", () => {
    // Seis cortes x 185 pedidos se irian por encima del tope de 800 en el primer pintado.
    expect(toggle.includes("visibleItems")).toBe(false);
  });

  it("RF_08 · marca el corte como en vuelo para poder avisar de que falta", () => {
    expect(toggle.includes("setLoadingSettlements")).toBe(true);
  });
});

describe("spec 019 · T9-T10 · el detalle no miente (RF_01, RF_04, RF_10, RF_11, RF_12)", () => {
  const notice = OPERATIONS.slice(
    OPERATIONS.indexOf("function SettlementDetailNotice("),
    OPERATIONS.indexOf("function DriverFinancialSummaryPanel(")
  );

  it("RF_10 · el rotulo de no disponible viene del modulo puro, no de un literal suelto", () => {
    // Si el componente escribiera su propio texto, RF_10 podria cumplirse en pantalla y violarse
    // en el Excel.
    expect(OPERATIONS.includes("UNAVAILABLE_ORDER_LABEL")).toBe(true);
    expect(OPERATIONS.includes("NO_AMOUNT_LABEL")).toBe(true);
  });

  it("RF_10 · ninguna fila cae al identificador interno como etiqueta", () => {
    expect(OPERATIONS.includes("?? order.orderId")).toBe(false);
    expect(OPERATIONS.includes("trackingCode ?? orderId")).toBe(false);
  });

  it("RF_01 · pantalla y Excel salen de la misma lista", () => {
    expect(OPERATIONS.includes("buildDriverSettlementDetailGroups")).toBe(true);
    expect(OPERATIONS.includes("flattenDriverSettlementDetail")).toBe(true);
    // El componente ya no arma sus propias filas de Excel.
    expect(OPERATIONS.includes("function buildDriverSettlementExportRows")).toBe(false);
  });

  it("RF_04 · las visitas sin recaudo se distinguen con pildora, no solo con color", () => {
    expect(OPERATIONS.includes("Sin recaudo")).toBe(true);
    expect(OPERATIONS.includes("Importe del corte")).toBe(true);
    // WCAG 2.2 AA 1.4.1: el importe a favor lleva palabra, no solo el verde.
    expect(OPERATIONS.includes('" a favor"')).toBe(true);
  });

  it("RF_11 y RF_12 · el aviso tiene sus tres desenlaces con textos distintos", () => {
    expect(notice.includes("Completando el detalle")).toBe(true);
    expect(notice.includes("Detalle incompleto")).toBe(true);
    expect(notice.includes("de ajuste posterior al corte")).toBe(true);
    expect(notice.includes("coincide con el corte")).toBe(true);
  });

  it("RF_11 · pase lo que pase, la cifra que se liquida es la del corte", () => {
    expect(notice.includes("Se liquida la cifra del corte")).toBe(true);
    // La cifra viaja en el desenlace calculado por el modulo puro, no se recalcula en el componente.
    expect(notice.includes("notice.expectedCashCop")).toBe(true);
  });

  it("RNF_03 · el aviso es accesible a lectores de pantalla", () => {
    expect(notice.includes('role="status"')).toBe(true);
    expect(notice.includes('aria-live="polite"')).toBe(true);
  });

  it("RF_08 y RF_11 · el cuarto desenlace: el tope agotado no se presenta como coincidente", () => {
    // El fallo que esta guarda vigila ya se entrego una vez: `pinOrders` devolvia `skippedByBudget`
    // desde T6 y el panel lo tiraba con un `.finally()`. Las filas sin bajar caian a su importe
    // guardado en el corte, la resta daba cero y el detalle decia "coincide con el corte".
    expect(notice.includes('notice.kind === "budget"')).toBe(true);
    expect(notice.includes("sin descargar en esta sesion")).toBe(true);
  });

  it("RF_11 · el panel LEE el parte del rescate, no lo descarta", () => {
    const toggle = constBlock(OPERATIONS, "toggleSettlement");
    expect(toggle.includes("result.skippedByBudget")).toBe(true);
    expect(toggle.includes("setBudgetSkipped")).toBe(true);
    // Y llega hasta el aviso.
    expect(OPERATIONS.includes("skippedByBudget={budgetSkipped[row.settlementId] ?? 0}")).toBe(true);
  });

  it("RF_11 · el orden de los desenlaces vive en el modulo puro, no en el JSX", () => {
    // Si el componente volviera a decidir con `group.detailStatus`, la precedencia (una fila sin
    // importe gana sobre el tope, y el tope sobre el ajuste) dejaria de tener prueba de verdad.
    expect(notice.includes("settlementDetailNotice(group,")).toBe(true);
    expect(notice.includes("group.detailStatus ===")).toBe(false);
  });

  it("RNF_03 · el acento acido no se gasta aqui", () => {
    // Se reserva al KPI heroe de la vista (docs/design-system.md).
    expect(notice.includes("bg-acid")).toBe(false);
  });
});
