/**
 * Spec 026 · T5 — esquemas de frontera, ajustes de alerta y sus escrituras (RF_04).
 *
 * `functions/src/cash-outstanding-schemas.ts` es puro (sin firebase-admin). Ata:
 *  1. La entrada del callable `getCashOutstanding`: `{ includeReconciliation: boolean = false }.strict()`.
 *     `{}` es el modo resumen; cualquier otra clave (un `driverId` colado desde el cliente) se rechaza:
 *     el alcance del lider sale del token (T12), nunca de la entrada.
 *  2. Los ajustes `settings/cashAlerts`: plazo entero 1..120 dias (7 por defecto) y umbral entero >= 0
 *     pesos (20.000 por defecto). `readCashAlertSettings` nunca lanza: un documento ausente da los
 *     defectos; uno ilegible da los defectos Y `settingsInvalid: true`, para que la pantalla lo diga.
 *  3. Pedido, corte de domiciliario y asiento: lo ilegible se separa por id (`unreadable*Ids`) en vez
 *     de tumbar el calculo o, peor, sumarse como 0 en silencio. Un corte SIN `cashPendingCop` es
 *     legible: `buildSettlement` los crea asi y la posicion lo trata como 0 (plan 1 y 4.1).
 *  4. Los constructores de escritura pasan por `stripUndefined` y no dejan ningun `undefined` en
 *     profundidad (plan 2.8): Firestore rechaza el documento entero si encuentra uno (el webhook de
 *     Shopify estuvo cuatro dias caido por eso).
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle
 * con su propio mensaje en vez de tumbar el archivo entero.
 */
import { describe, expect, it } from "vitest";

const MODULE = "../../functions/src/cash-outstanding-schemas";

async function load() {
  return import(MODULE);
}

/** Rutas de toda clave cuyo valor es `undefined`, a cualquier profundidad (objetos y arrays). */
function undefinedPaths(value: unknown, path = "$"): string[] {
  if (value === undefined) return [path];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`));
}

describe("T5 · entrada del callable getCashOutstanding", () => {
  it("{} se lee como modo resumen (includeReconciliation false)", async () => {
    const { cashOutstandingInputSchema } = await load();
    expect(cashOutstandingInputSchema.parse({})).toEqual({ includeReconciliation: false });
  });

  it("acepta includeReconciliation true", async () => {
    const { cashOutstandingInputSchema } = await load();
    expect(cashOutstandingInputSchema.parse({ includeReconciliation: true })).toEqual({ includeReconciliation: true });
  });

  it("rechaza un driverId en la entrada (el alcance sale del token, no del cliente)", async () => {
    const { cashOutstandingInputSchema } = await load();
    expect(cashOutstandingInputSchema.safeParse({ driverId: "drv-1" }).success).toBe(false);
  });

  it("rechaza includeReconciliation que no sea booleano", async () => {
    const { cashOutstandingInputSchema } = await load();
    expect(cashOutstandingInputSchema.safeParse({ includeReconciliation: "true" }).success).toBe(false);
  });
});

describe("T5 · ajustes de alerta (RF_04)", () => {
  it("los defectos son 7 dias y $20.000", async () => {
    const { DEFAULT_CASH_ALERT_SETTINGS } = await load();
    expect(DEFAULT_CASH_ALERT_SETTINGS).toEqual({ overdueDays: 7, notifyMinCop: 20_000 });
  });

  it("el esquema rellena los defectos cuando faltan los campos", async () => {
    const { cashAlertSettingsSchema } = await load();
    expect(cashAlertSettingsSchema.parse({})).toEqual({ overdueDays: 7, notifyMinCop: 20_000 });
  });

  it("acepta los extremos del rango: 1 y 120 dias, umbral 0", async () => {
    const { cashAlertSettingsSchema } = await load();
    expect(cashAlertSettingsSchema.parse({ overdueDays: 1, notifyMinCop: 0 })).toEqual({ overdueDays: 1, notifyMinCop: 0 });
    expect(cashAlertSettingsSchema.parse({ overdueDays: 120, notifyMinCop: 0 })).toEqual({ overdueDays: 120, notifyMinCop: 0 });
  });

  it.each([
    ["plazo 0", { overdueDays: 0, notifyMinCop: 20_000 }],
    ["plazo 121", { overdueDays: 121, notifyMinCop: 20_000 }],
    ["plazo no entero", { overdueDays: 7.5, notifyMinCop: 20_000 }],
    ["plazo como texto", { overdueDays: "7", notifyMinCop: 20_000 }],
    ["umbral negativo", { overdueDays: 7, notifyMinCop: -1 }],
    ["umbral no entero", { overdueDays: 7, notifyMinCop: 1_500.5 }],
    ["umbral NaN", { overdueDays: 7, notifyMinCop: Number.NaN }],
    ["clave extra (strict)", { overdueDays: 7, notifyMinCop: 20_000, channelUrl: "https://x" }]
  ])("rechaza %s", async (_label, value) => {
    const { cashAlertSettingsSchema } = await load();
    expect(cashAlertSettingsSchema.safeParse(value).success).toBe(false);
  });
});

describe("T5 · readCashAlertSettings (lectura de settings/cashAlerts)", () => {
  it("documento ausente: defectos y settingsInvalid false", async () => {
    const { readCashAlertSettings } = await load();
    expect(readCashAlertSettings(undefined)).toEqual({ settings: { overdueDays: 7, notifyMinCop: 20_000 }, settingsInvalid: false });
    expect(readCashAlertSettings(null)).toEqual({ settings: { overdueDays: 7, notifyMinCop: 20_000 }, settingsInvalid: false });
  });

  it("documento guardado (con updatedAt/updatedBy): devuelve sus valores", async () => {
    const { readCashAlertSettings } = await load();
    const stored = { overdueDays: 10, notifyMinCop: 50_000, updatedAt: "2026-10-02T12:00:00.000Z", updatedBy: "admin-1" };
    expect(readCashAlertSettings(stored)).toEqual({ settings: { overdueDays: 10, notifyMinCop: 50_000 }, settingsInvalid: false });
  });

  it("documento parcial: completa con el defecto el campo que falta", async () => {
    const { readCashAlertSettings } = await load();
    expect(readCashAlertSettings({ overdueDays: 14 })).toEqual({ settings: { overdueDays: 14, notifyMinCop: 20_000 }, settingsInvalid: false });
  });

  it("documento ilegible: defectos y settingsInvalid true, sin lanzar", async () => {
    const { readCashAlertSettings } = await load();
    expect(readCashAlertSettings({ overdueDays: 0, notifyMinCop: 20_000 })).toEqual({
      settings: { overdueDays: 7, notifyMinCop: 20_000 },
      settingsInvalid: true
    });
    expect(readCashAlertSettings("basura")).toEqual({ settings: { overdueDays: 7, notifyMinCop: 20_000 }, settingsInvalid: true });
  });
});

describe("T5 · pedidos de la frontera", () => {
  const order = {
    id: "ord-1",
    trackingCode: "KNT-000001",
    sellerId: "seller-1",
    driverId: "drv-1",
    messengerId: "msg-1",
    status: "delivered",
    paymentMethod: "cod",
    totalCop: 85_000,
    closedAt: "2026-06-01T15:00:00.000Z",
    evidence: [{ type: "delivery", createdAt: "2026-06-01T14:59:00.000Z" }]
  };

  it("un pedido legible pasa", async () => {
    const { parseCashOutstandingOrders } = await load();
    const result = parseCashOutstandingOrders([order]);
    expect(result.unreadableOrderIds).toEqual([]);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({ id: "ord-1", sellerId: "seller-1", driverId: "drv-1", totalCop: 85_000 });
  });

  it("sin driverId ni messengerId ni evidencia: null, null y [] (el caso 'sin lider' es legible)", async () => {
    const { parseCashOutstandingOrders } = await load();
    const { driverId: _d, messengerId: _m, evidence: _e, ...bare } = order;
    const result = parseCashOutstandingOrders([bare]);
    expect(result.unreadableOrderIds).toEqual([]);
    expect(result.orders[0]).toMatchObject({ driverId: null, messengerId: null, evidence: [] });
  });

  it("totalCop no numerico o sin sellerId: va a unreadableOrderIds y no a orders", async () => {
    const { parseCashOutstandingOrders } = await load();
    const result = parseCashOutstandingOrders([
      { ...order, id: "ord-bad-total", totalCop: "85000" },
      { ...order, id: "ord-no-seller", sellerId: undefined },
      order
    ]);
    expect(result.unreadableOrderIds).toEqual(["ord-bad-total", "ord-no-seller"]);
    expect(result.orders.map((o: { id: string }) => o.id)).toEqual(["ord-1"]);
  });
});

describe("T5 · cortes de domiciliario de la frontera", () => {
  const settlement = {
    id: "set-1",
    kind: "driver",
    ownerId: "drv-1",
    status: "paid",
    orderIds: ["ord-1", "ord-2"],
    createdAt: "2026-06-05T12:00:00.000Z",
    cashExpectedCop: 170_000,
    cashReceivedCop: 170_000,
    cashPendingCop: 0
  };

  it("un corte sin cashPendingCop (como los crea buildSettlement) es legible, no va a ilegibles", async () => {
    const { parseDriverSettlements } = await load();
    const { cashPendingCop: _p, cashExpectedCop: _e, cashReceivedCop: _r, ...withoutCash } = settlement;
    const result = parseDriverSettlements([withoutCash]);
    expect(result.unreadableSettlementIds).toEqual([]);
    expect(result.settlements).toHaveLength(1);
    expect(result.settlements[0].id).toBe("set-1");
  });

  it("conserva los campos de efectivo y las cashAllocations (la regla de recibido las lee)", async () => {
    const { parseDriverSettlements } = await load();
    const withAllocations = { ...settlement, cashAllocations: [{ orderId: "ord-1", covered: true }] };
    const result = parseDriverSettlements([withAllocations]);
    expect(result.settlements[0]).toMatchObject({
      cashPendingCop: 0,
      cashExpectedCop: 170_000,
      cashReceivedCop: 170_000,
      cashAllocations: [{ orderId: "ord-1", covered: true }]
    });
  });

  it("cashPendingCop NaN, status desconocido u orderIds ausente: va a unreadableSettlementIds", async () => {
    const { parseDriverSettlements } = await load();
    const result = parseDriverSettlements([
      { ...settlement, id: "set-nan", cashPendingCop: Number.NaN },
      { ...settlement, id: "set-status", status: "archived" },
      { ...settlement, id: "set-no-orders", orderIds: undefined },
      settlement
    ]);
    expect(result.unreadableSettlementIds).toEqual(["set-nan", "set-status", "set-no-orders"]);
    expect(result.settlements.map((s: { id: string }) => s.id)).toEqual(["set-1"]);
  });
});

describe("T5 · parseWalletEntries", () => {
  const entry = {
    id: "we-1",
    ownerType: "seller",
    ownerId: "seller-1",
    orderId: "ord-1",
    type: "cod_revenue",
    amountCop: 85_000,
    createdAt: "2026-06-01T15:00:00.000Z",
    supplierId: "sup-1"
  };

  it("un asiento legible pasa y conserva sus campos extra (supplierId)", async () => {
    const { parseWalletEntries } = await load();
    const result = parseWalletEntries([entry]);
    expect(result.unreadableEntryIds).toEqual([]);
    expect(result.entries).toEqual([entry]);
  });

  it("amountCop NaN va a unreadableEntryIds", async () => {
    const { parseWalletEntries } = await load();
    const result = parseWalletEntries([{ ...entry, id: "we-nan", amountCop: Number.NaN }]);
    expect(result).toEqual({ entries: [], unreadableEntryIds: ["we-nan"] });
  });

  it("amountCop infinito o como texto va a unreadableEntryIds", async () => {
    const { parseWalletEntries } = await load();
    const result = parseWalletEntries([
      { ...entry, id: "we-inf", amountCop: Number.POSITIVE_INFINITY },
      { ...entry, id: "we-text", amountCop: "85000" }
    ]);
    expect(result.unreadableEntryIds).toEqual(["we-inf", "we-text"]);
    expect(result.entries).toEqual([]);
  });

  it("asiento sin orderId (o vacio) va a unreadableEntryIds", async () => {
    const { parseWalletEntries } = await load();
    const { orderId: _o, ...withoutOrder } = entry;
    const result = parseWalletEntries([{ ...withoutOrder, id: "we-no-order" }, { ...entry, id: "we-empty-order", orderId: "" }, entry]);
    expect(result.unreadableEntryIds).toEqual(["we-no-order", "we-empty-order"]);
    expect(result.entries.map((e: { id: string }) => e.id)).toEqual(["we-1"]);
  });
});

describe("T5 · constructores de escritura sin undefined (plan 2.8)", () => {
  it("buildCashAlertSettingsDoc: ajustes + updatedAt + updatedBy", async () => {
    const { buildCashAlertSettingsDoc } = await load();
    const doc = buildCashAlertSettingsDoc({
      settings: { overdueDays: 10, notifyMinCop: 50_000 },
      actorId: "admin-1",
      now: "2026-10-02T12:00:00.000Z"
    });
    expect(doc).toEqual({ overdueDays: 10, notifyMinCop: 50_000, updatedAt: "2026-10-02T12:00:00.000Z", updatedBy: "admin-1" });
  });

  it("buildCashAlertSettingsDoc sin actorId: omite la clave, no escribe undefined", async () => {
    const { buildCashAlertSettingsDoc } = await load();
    const doc = buildCashAlertSettingsDoc({ settings: { overdueDays: 7, notifyMinCop: 20_000 }, actorId: undefined, now: "2026-10-02T12:00:00.000Z" });
    expect(undefinedPaths(doc)).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(doc, "updatedBy")).toBe(false);
  });

  it("buildCashAlertAuditDoc: forma de auditEvents con antes y despues", async () => {
    const { buildCashAlertAuditDoc } = await load();
    const doc = buildCashAlertAuditDoc({
      id: "audit-1",
      actorId: "admin-1",
      actorRole: "admin",
      previous: { overdueDays: 7, notifyMinCop: 20_000 },
      next: { overdueDays: 10, notifyMinCop: 50_000 },
      now: "2026-10-02T12:00:00.000Z"
    });
    expect(doc).toMatchObject({
      id: "audit-1",
      actorId: "admin-1",
      actorRole: "admin",
      action: "cash_alert_settings.updated",
      entity: "settings",
      entityId: "cashAlerts",
      before: { overdueDays: 7, notifyMinCop: 20_000 },
      after: { overdueDays: 10, notifyMinCop: 50_000 },
      createdAt: "2026-10-02T12:00:00.000Z"
    });
    expect(typeof doc.summary).toBe("string");
    expect(doc.summary.length).toBeGreaterThan(0);
  });

  it("buildCashAlertAuditDoc sin actor ni ajustes previos: ningun undefined en profundidad", async () => {
    const { buildCashAlertAuditDoc } = await load();
    const doc = buildCashAlertAuditDoc({
      id: "audit-2",
      actorId: undefined,
      actorRole: undefined,
      previous: null,
      next: { overdueDays: 7, notifyMinCop: 20_000 },
      now: "2026-10-02T12:00:00.000Z"
    });
    expect(undefinedPaths(doc)).toEqual([]);
    expect(doc.before).toBeNull();
  });

  it("los constructores reutilizan stripUndefined de wallet-entries (no una copia)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../functions/src/cash-outstanding-schemas.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*\bstripUndefined\b[^}]*\}\s*from\s*["']\.\/wallet-entries["']/);
    expect(source).not.toMatch(/function\s+stripUndefined\b/);
  });
});
