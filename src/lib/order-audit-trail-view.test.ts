/**
 * Spec 029 · T19 — modelo de vista del "Historial del pedido" (`src/lib/order-audit-trail-view.ts`).
 *
 * Puro: recibe lo que devuelve `getOrderAuditTrail` (`OrderAuditTrail` de `src/lib/types.ts`) y decide lo que
 * se pinta. Ninguna prueba toca Firebase. La pantalla (T22) solo pinta lo que este modulo devuelve.
 *
 * Contrato (README del diseno, decisiones 8-16; plan seccion 9, fila `order-audit-trail-view.ts`):
 *
 *   HISTORY_FIELD_LABELS: Record<OrderHistoryField, string>     // tabla de la decision 15, sin tildes
 *   historyFieldLabel(field: unknown) -> string | null          // null si el campo no esta en la tabla
 *   AUDIT_ACTION_LABELS: Record<string, string>                 // incluye las nuevas de las decisiones 15 y 16
 *   auditActionLabel(action: string) -> string                  // accion desconocida -> la accion cruda (como hoy)
 *   CHANGE_LABELS = { before: "Antes", after: "Ahora" }
 *   EMPTY_VALUE_TEXT = "Sin dato"
 *   formatHistoryValue(field: string, value: unknown, options?: { cityNames?: Record<string, string> }) -> string
 *   formatHistoryDateTime(iso) -> "6 oct 2026, 09:12"           // hora de Bogota
 *   formatHistoryDate(iso)     -> "6 oct 2026"
 *   buildHistoryScopeNote(historySince: string | null, viewport: "mobile" | "desktop")
 *     -> { name: "Que incluye el historial"; title: string; body: string } | null
 *
 *   buildOrderAuditTrailView(input: {
 *     viewer: "admin" | "store";
 *     viewport: "mobile" | "desktop";
 *     load: { status: "loading" } | { status: "error" } | { status: "loaded"; trail: OrderAuditTrail };
 *     cityNames?: Record<string, string>;
 *   }) -> {
 *     state: "loading" | "error" | "empty" | "events";
 *     statusText: string | null;                                   // "Cargando historial..."
 *     alert: { title: string; body: string; retryLabel: string } | null;
 *     note: ReturnType<typeof buildHistoryScopeNote>;
 *     empty: { title: string; body: string } | null;
 *     events: {
 *       id: string; dateText: string;
 *       origin: { text: "API" | "Kentro" | "Tu tienda" | "Panel"; tone: "info" | "muted" };
 *       actionLabel: string;
 *       transition: string | null;                                 // "Pendiente confirmacion → Listo para asignar"
 *       changes: { label: string; before: string; after: string }[];
 *       summary: string | null;                                    // solo eventos sin cambios campo a campo
 *       who: { line: string; keyLine: string | null } | null;      // null para la tienda (RF_27)
 *     }[];
 *   }
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle con su
 * propio mensaje en vez de tumbar el archivo entero.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatCop } from "./finance";
import type { OrderAuditEntry, OrderAuditTrail } from "./types";

type ViewModule = typeof import("./order-audit-trail-view");
const loadView = (): Promise<ViewModule> => import("./order-audit-trail-view");

// ---------------------------------------------------------------------------------------------------
// Fuente de verdad de los campos: el tipo del servidor
// ---------------------------------------------------------------------------------------------------

const SELLER_ACTIONS_SOURCE = readFileSync(
  fileURLToPath(new URL("../../functions/src/order-seller-actions.ts", import.meta.url)),
  "utf8"
);

function unionMembers(typeName: string): string[] {
  const match = SELLER_ACTIONS_SOURCE.match(new RegExp(`export type ${typeName} =([^;]+);`));
  if (!match) throw new Error(`No se encontro el tipo ${typeName} en order-seller-actions.ts`);
  return match[1].split("|").map((part) => part.trim()).filter(Boolean);
}

/** `OrderHistoryField` expandido: los literales tal cual y los alias (`DeliveryField`) resueltos. */
function orderHistoryFields(): string[] {
  return unionMembers("OrderHistoryField").flatMap((member) =>
    member.startsWith('"') ? [member.slice(1, -1)] : unionMembers(member).map((inner) => inner.slice(1, -1))
  );
}

/** Tabla de la decision 15 del README, copiada a mano: es lo que la guarda compara. */
const README_FIELD_LABELS: Record<string, string> = {
  status: "Estado",
  customerName: "Cliente",
  customerPhone: "Telefono",
  addressRaw: "Direccion",
  deliveryNotes: "Indicaciones",
  cityId: "Ciudad",
  totalCop: "Valor",
  productName: "Producto",
  sku: "SKU",
  quantity: "Cantidad",
};

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

/** 6 oct 2026 00:00 en Bogota. */
const HISTORY_SINCE = "2026-10-06T05:00:00.000Z";

function makeEvent(over: Partial<OrderAuditEntry> & { id: string }): OrderAuditEntry {
  return {
    createdAt: "2026-10-06T14:12:00.000Z", // 09:12 Bogota
    action: "order.seller_confirmed",
    actorId: "",
    summary: "",
    ...over,
  };
}

const loaded = (events: OrderAuditEntry[], historySince: string | null = HISTORY_SINCE) => ({
  status: "loaded" as const,
  trail: { events, historySince } satisfies OrderAuditTrail,
});

const storeApiCorrection = makeEvent({
  id: "e-api-1",
  action: "order.delivery_corrected",
  actorTag: "API",
  origin: "api",
  changes: [
    { field: "addressRaw", from: "Cra 8 # 45-12, Cali", to: "Cra 8 # 45-12 apto 302, Cali" },
    { field: "customerPhone", from: "315 482 0917", to: "317 220 5531" },
  ],
  summary: "Datos de entrega corregidos por API",
});

// ---------------------------------------------------------------------------------------------------
// Nombres de campo (decision 15)
// ---------------------------------------------------------------------------------------------------

describe("T19 · nombres visibles de los campos del historial (decision 15)", () => {
  it("la guarda lee los diez campos de OrderHistoryField del servidor", () => {
    expect(orderHistoryFields().sort()).toEqual(Object.keys(README_FIELD_LABELS).sort());
  });

  it("cada OrderHistoryField tiene nombre visible: un campo sin texto es un fallo", async () => {
    const { HISTORY_FIELD_LABELS } = await loadView();
    for (const field of orderHistoryFields()) {
      const label = (HISTORY_FIELD_LABELS as Record<string, string | undefined>)[field];
      expect(label, `el campo ${field} no tiene nombre visible`).toBeTruthy();
    }
    expect(Object.keys(HISTORY_FIELD_LABELS).sort()).toEqual(orderHistoryFields().sort());
  });

  it("cada nombre coincide con la tabla del README", async () => {
    const { HISTORY_FIELD_LABELS, historyFieldLabel } = await loadView();
    expect(HISTORY_FIELD_LABELS).toEqual(README_FIELD_LABELS);
    for (const [field, label] of Object.entries(README_FIELD_LABELS)) expect(historyFieldLabel(field)).toBe(label);
  });

  it("sin tildes, como el resto de la app", async () => {
    const { HISTORY_FIELD_LABELS } = await loadView();
    for (const label of Object.values(HISTORY_FIELD_LABELS)) expect(label).not.toMatch(/[áéíóúÁÉÍÓÚ]/);
  });

  it("un campo fuera de la tabla no recibe un texto inventado ni su nombre crudo", async () => {
    const { historyFieldLabel, buildOrderAuditTrailView } = await loadView();
    expect(historyFieldLabel("driverId")).toBeNull();
    expect(historyFieldLabel(42)).toBeNull();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([makeEvent({ id: "x", actorTag: "API", origin: "api", changes: [{ field: "driverId", from: "a", to: "b" }] })]),
    });
    expect(view.events[0]?.changes).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("driverId");
  });
});

// ---------------------------------------------------------------------------------------------------
// Etiquetas de accion (decisiones 15 y 16)
// ---------------------------------------------------------------------------------------------------

describe("T19 · etiquetas de las acciones (decisiones 15 y 16)", () => {
  it.each([
    ["order.delivery_corrected", "Datos de entrega corregidos"],
    ["order.address_reviewed", "Direccion revisada"],
    ["order.picked_up", "Recogido"],
    ["order.messenger_assigned", "Mensajero asignado"],
    ["order.messenger_unassigned", "Mensajero retirado"],
    ["order.messenger_reassigned", "Mensajero reasignado"],
  ])("%s -> %s", async (action, label) => {
    const { auditActionLabel, AUDIT_ACTION_LABELS } = await loadView();
    expect(AUDIT_ACTION_LABELS[action]).toBe(label);
    expect(auditActionLabel(action)).toBe(label);
  });

  it("confirmar por API reutiliza \"Confirmado\" y cancelar, \"Anulado\" (las existentes no cambian)", async () => {
    const { auditActionLabel } = await loadView();
    expect(auditActionLabel("order.seller_confirmed")).toBe("Confirmado");
    expect(auditActionLabel("order.cancelled")).toBe("Anulado");
    expect(auditActionLabel("order.imported_updated")).toBe("Editado antes de confirmar");
    expect(auditActionLabel("order.transition")).toBe("Cambio de estado");
  });

  it("una accion desconocida cae al nombre crudo, no a un texto vacio (como hoy)", async () => {
    const { auditActionLabel } = await loadView();
    expect(auditActionLabel("order.algo_futuro")).toBe("order.algo_futuro");
  });
});

// ---------------------------------------------------------------------------------------------------
// Antes / Ahora y "Sin dato"
// ---------------------------------------------------------------------------------------------------

describe("T19 · valores de Antes / Ahora (decision 15)", () => {
  it("los rotulos son \"Antes\" y \"Ahora\"; el vacio es \"Sin dato\"", async () => {
    const { CHANGE_LABELS, EMPTY_VALUE_TEXT } = await loadView();
    expect(CHANGE_LABELS).toEqual({ before: "Antes", after: "Ahora" });
    expect(EMPTY_VALUE_TEXT).toBe("Sin dato");
  });

  it.each([[null], [undefined], [""], ["   "]])("valor %j -> \"Sin dato\", nunca blanco ni guion", async (value) => {
    const { formatHistoryValue } = await loadView();
    expect(formatHistoryValue("deliveryNotes", value)).toBe("Sin dato");
    expect(formatHistoryValue("sku", value)).toBe("Sin dato");
  });

  it("status se pinta con statusLabel, nunca el valor crudo", async () => {
    const { formatHistoryValue } = await loadView();
    expect(formatHistoryValue("status", "imported")).toBe("Pendiente confirmacion");
    expect(formatHistoryValue("status", "address_risk")).toBe("Direccion por revisar");
    expect(formatHistoryValue("status", "ready_to_assign")).toBe("Listo para asignar");
  });

  it("totalCop con formatCop", async () => {
    const { formatHistoryValue } = await loadView();
    expect(formatHistoryValue("totalCop", 89900)).toBe(formatCop(89900));
  });

  it("cityId con el nombre de la ciudad, nunca el id", async () => {
    const { formatHistoryValue } = await loadView();
    expect(formatHistoryValue("cityId", "city-cali", { cityNames: { "city-cali": "Cali" } })).toBe("Cali");
  });

  it("quantity es el numero sin unidad; texto tal cual", async () => {
    const { formatHistoryValue } = await loadView();
    expect(formatHistoryValue("quantity", 2)).toBe("2");
    expect(formatHistoryValue("customerPhone", "317 220 5531")).toBe("317 220 5531");
  });

  it("un cambio con un lado vacio pinta \"Sin dato\" en ese lado", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([
        makeEvent({
          id: "e1",
          action: "order.delivery_corrected",
          actorTag: "API",
          origin: "api",
          changes: [
            { field: "deliveryNotes", from: "Porteria", to: null },
            { field: "sku", from: undefined, to: "KV-01" },
          ],
        }),
      ]),
    });
    expect(view.events[0]?.changes).toEqual([
      { label: "Indicaciones", before: "Porteria", after: "Sin dato" },
      { label: "SKU", before: "Sin dato", after: "KV-01" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Pildora de origen (decisiones 11-13)
// ---------------------------------------------------------------------------------------------------

describe("T19 · pildora de origen (decisiones 11-13)", () => {
  it.each([
    ["API", "info"],
    ["Kentro", "muted"],
    ["Tu tienda", "muted"],
  ] as const)("tienda: actorTag %s -> pildora %s", async (tag, tone) => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([makeEvent({ id: "e", actorTag: tag })]),
    });
    expect(view.events[0]?.origin).toEqual({ text: tag, tone });
  });

  it("admin: un evento de la API -> \"API\" (info), con \"Clave de escritura de Kovia\" y \"termina en c41e\"", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "admin",
      viewport: "desktop",
      load: loaded([
        makeEvent({ id: "e", origin: "api", actorId: "store_api", actorLabel: "Clave de escritura de Kovia", actorRole: "store_api", apiKeyLast4: "c41e" }),
      ]),
    });
    expect(view.events[0]?.origin).toEqual({ text: "API", tone: "info" });
    expect(view.events[0]?.who).toEqual({ line: "Clave de escritura de Kovia", keyLine: "termina en c41e" });
  });

  it("admin: una persona por la app -> \"Panel\" (muted) con \"Nombre (correo) · rol\"", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "admin",
      viewport: "mobile",
      load: loaded([
        makeEvent({ id: "e", action: "order.imported_updated", actorId: "u1", actorLabel: "Paola Rincon", actorEmail: "paola@kovia.co", actorRole: "seller" }),
      ]),
    });
    expect(view.events[0]?.origin).toEqual({ text: "Panel", tone: "muted" });
    expect(view.events[0]?.who).toEqual({ line: "Paola Rincon (paola@kovia.co) · seller", keyLine: null });
  });

  it("ninguna pildora es acida", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([makeEvent({ id: "a", actorTag: "API" }), makeEvent({ id: "b", actorTag: "Kentro" }), makeEvent({ id: "c", actorTag: "Tu tienda" })]),
    });
    for (const event of view.events) expect(["info", "muted"]).toContain(event.origin.tone);
  });

  it("la tienda nunca recibe una linea de quien (RF_27), aunque el evento traiga identidad", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "desktop",
      load: loaded([makeEvent({ id: "e", actorTag: "Kentro", actorLabel: "Carolina Mesa", actorEmail: "cmesa@kentro.co", actorRole: "driver" })]),
    });
    expect(view.events[0]?.who).toBeNull();
    const text = JSON.stringify(view);
    expect(text).not.toContain("Carolina Mesa");
    expect(text).not.toContain("cmesa@kentro.co");
    expect(text).not.toContain("driver");
  });
});

// ---------------------------------------------------------------------------------------------------
// Cada evento (decision 10)
// ---------------------------------------------------------------------------------------------------

describe("T19 · cada evento (decision 10)", () => {
  it("fecha y hora de Bogota, accion, y cambios con nombre visible (HU_05.tienda)", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const [event] = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: loaded([storeApiCorrection]) }).events;
    expect(event?.dateText).toBe("6 oct 2026, 09:12");
    expect(event?.actionLabel).toBe("Datos de entrega corregidos");
    expect(event?.changes).toEqual([
      { label: "Direccion", before: "Cra 8 # 45-12, Cali", after: "Cra 8 # 45-12 apto 302, Cali" },
      { label: "Telefono", before: "315 482 0917", after: "317 220 5531" },
    ]);
  });

  it("transicion con statusLabel: \"Pendiente confirmacion → Listo para asignar\"", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const [event] = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([makeEvent({ id: "e", actorTag: "API", fromStatus: "imported", toStatus: "ready_to_assign" })]),
    }).events;
    expect(event?.transition).toBe("Pendiente confirmacion → Listo para asignar");
  });

  it("transicion de mensajero: \"Recogido → Llamada pendiente\" (decision 16)", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const [event] = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([makeEvent({ id: "e", action: "order.messenger_assigned", actorTag: "Kentro", fromStatus: "picked_up", toStatus: "call_pending" })]),
    }).events;
    expect(event?.actionLabel).toBe("Mensajero asignado");
    expect(event?.transition).toBe("Recogido → Llamada pendiente");
    expect(event?.summary).toBeNull();
  });

  it("sin transicion cuando falta alguno de los dos estados", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const [event] = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([makeEvent({ id: "e", actorTag: "Kentro", toStatus: "assigned" })]),
    }).events;
    expect(event?.transition).toBeNull();
  });

  it("un evento historico sin cambios muestra su summary; uno con cambios, no", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([
        makeEvent({ id: "old", action: "order.imported_updated", actorTag: "Tu tienda", summary: "Producto y valor actualizados." }),
        storeApiCorrection,
      ]),
    });
    expect(view.events.find((event) => event.id === "old")?.summary).toBe("Producto y valor actualizados.");
    expect(view.events.find((event) => event.id === "e-api-1")?.summary).toBeNull();
  });

  it("del mas viejo al mas nuevo (decision 8)", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({
      viewer: "store",
      viewport: "mobile",
      load: loaded([
        makeEvent({ id: "new", actorTag: "Kentro", createdAt: "2026-10-06T19:05:00.000Z" }),
        makeEvent({ id: "old", actorTag: "Tu tienda", createdAt: "2026-10-05T21:40:00.000Z" }),
      ]),
    });
    expect(view.events.map((event) => event.id)).toEqual(["old", "new"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Nota de alcance (decision 9)
// ---------------------------------------------------------------------------------------------------

describe("T19 · nota de alcance desde historySince (decision 9)", () => {
  it("escritorio: titulo con la fecha de historySince y el texto largo", async () => {
    const { buildHistoryScopeNote } = await loadView();
    expect(buildHistoryScopeNote(HISTORY_SINCE, "desktop")).toEqual({
      name: "Que incluye el historial",
      title: "Campo por campo desde el 6 oct 2026.",
      body: "No incluye los cambios de importaciones (Shopify y webhooks de tienda) ni la confirmacion automatica de ChatBy.",
    });
  });

  it("movil: el texto corto", async () => {
    const { buildHistoryScopeNote } = await loadView();
    expect(buildHistoryScopeNote(HISTORY_SINCE, "mobile")?.body).toBe(
      "No incluye importaciones de Shopify ni webhooks de tienda, ni ChatBy."
    );
  });

  it("la fecha sale de historySince, no esta escrita en el codigo", async () => {
    const { buildHistoryScopeNote } = await loadView();
    expect(buildHistoryScopeNote("2026-11-20T15:00:00.000Z", "desktop")?.title).toBe("Campo por campo desde el 20 nov 2026.");
  });

  it("sin nota si historySince es null", async () => {
    const { buildHistoryScopeNote, buildOrderAuditTrailView } = await loadView();
    expect(buildHistoryScopeNote(null, "desktop")).toBeNull();
    const view = buildOrderAuditTrailView({ viewer: "store", viewport: "desktop", load: loaded([storeApiCorrection], null) });
    expect(view.note).toBeNull();
  });

  it("la nota va antes de los eventos y tambien con el historial vacio", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const withEvents = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: loaded([storeApiCorrection]) });
    const empty = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: loaded([]) });
    expect(withEvents.note?.title).toBe("Campo por campo desde el 6 oct 2026.");
    expect(empty.note?.title).toBe("Campo por campo desde el 6 oct 2026.");
  });
});

// ---------------------------------------------------------------------------------------------------
// Estados del bloque (decision 14)
// ---------------------------------------------------------------------------------------------------

describe("T19 · estados del bloque (decision 14)", () => {
  it("cargando: \"Cargando historial...\", sin nota ni eventos", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: { status: "loading" } });
    expect(view.state).toBe("loading");
    expect(view.statusText).toBe("Cargando historial...");
    expect(view.note).toBeNull();
    expect(view.events).toEqual([]);
  });

  it("vacio (HU_05.vacio): nota y \"Sin cambios registrados\" con la fecha de historySince", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: loaded([]) });
    expect(view.state).toBe("empty");
    expect(view.empty).toEqual({
      title: "Sin cambios registrados",
      body: "Este pedido no tiene cambios desde el 6 oct 2026 ni eventos anteriores.",
    });
    expect(view.events).toEqual([]);
  });

  it("error (HU_05.error): alerta con \"Reintentar\", sin nota ni eventos a medias", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: { status: "error" } });
    expect(view.state).toBe("error");
    expect(view.alert).toEqual({
      title: "No se pudo cargar el historial",
      body: "Revisa la conexion y vuelve a intentarlo. El pedido no ha cambiado por esto.",
      retryLabel: "Reintentar",
    });
    expect(view.note).toBeNull();
    expect(view.events).toEqual([]);
  });

  it("con eventos (HU_05.tienda): estado \"events\" y una entrada por evento", async () => {
    const { buildOrderAuditTrailView } = await loadView();
    const view = buildOrderAuditTrailView({ viewer: "store", viewport: "mobile", load: loaded([storeApiCorrection]) });
    expect(view.state).toBe("events");
    expect(view.events).toHaveLength(1);
    expect(view.alert).toBeNull();
    expect(view.empty).toBeNull();
  });
});
