/**
 * Spec 029 — historial de un pedido por la Store API (T13; T14 anade su propio bloque).
 *
 * Contrato que fijan estas pruebas (T13):
 *
 *   // functions/src/store-api-history.ts (puro, sin firebase-admin)
 *   export const HISTORY_EXCLUDES: readonly ["imports", "chatby"];
 *   export function toStoreHistoryResponse(
 *     records: OrderHistoryDoc[],          // los de `orderHistory` ya filtrados por pedido (y tienda) en el handler
 *     historySince: string                 // settings/storeApi.historySince
 *   ): {
 *     ok: true; historySince: string; excludes: ["imports", "chatby"]; aviso: string;
 *     registros: Array<{ at: string; origin: "api" | "panel"; action: string; changes: Array<{ field; from; to }> }>;
 *   };
 *   `orderId` lo anade el handler (la funcion no lo conoce cuando no hay registros).
 *
 * Lista EXPLICITA de claves de salida (RF_18, plan 4.3): un registro sale con `at` (= `createdAt`), `origin`,
 * `action` y `changes`, y cada cambio con `field`, `from`, `to`. Lo demas que traiga el documento (actor, uid,
 * auditEventId, sellerId, id, orderId, o cualquier clave que se anada manana) no sale.
 */
import { describe, expect, it } from "vitest";

const HISTORY_MODULE = "../../functions/src/store-api-history";

type HistoryRecordOut = { at: string; origin: string; action: string; changes: Array<Record<string, unknown>> };
type HistoryResponse = {
  ok: true;
  historySince: string;
  excludes: string[];
  aviso: string;
  registros: HistoryRecordOut[];
} & Record<string, unknown>;

async function loadHistoryModule(): Promise<{
  toStoreHistoryResponse: (records: unknown[], historySince: string) => HistoryResponse;
  HISTORY_EXCLUDES: readonly string[];
}> {
  const mod = (await import(HISTORY_MODULE)) as Record<string, unknown>;
  if (typeof mod.toStoreHistoryResponse !== "function") {
    throw new Error("functions/src/store-api-history.ts no exporta toStoreHistoryResponse(records, historySince)");
  }
  if (!Array.isArray(mod.HISTORY_EXCLUDES)) {
    throw new Error("functions/src/store-api-history.ts no exporta HISTORY_EXCLUDES");
  }
  return mod as never;
}

const HISTORY_SINCE = "2026-10-05T12:00:00.000Z";

function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "h-x",
    orderId: "o-1",
    sellerId: "seller-test-029",
    createdAt: "2026-10-05T13:00:00.000Z",
    origin: "api",
    action: "order.seller_confirmed",
    changes: [{ field: "status", from: "imported", to: "ready_to_assign" }],
    auditEventId: "audit-1",
    actor: { kind: "api", keyLast4: "9f3a" },
    ...overrides
  };
}

const PANEL_RECORD = record({
  id: "h-panel",
  createdAt: "2026-10-05T14:30:00.000Z",
  origin: "panel",
  action: "order.imported_updated",
  changes: [{ field: "addressRaw", from: "Cra 1 # 2-3", to: "Cra 1 # 2-30" }],
  auditEventId: "audit-panel",
  actor: { kind: "user", uid: "uid-admin-secreto", role: "admin" },
  // Lo que se le pueda colar manana al documento tampoco sale.
  uid: "uid-admin-secreto",
  actorEmail: "admin@kentro.co",
  actorLabel: "Camilo Admin"
});

describe("T13 · toStoreHistoryResponse (RF_17, RF_18, RF_24)", () => {
  it("cada registro sale solo con { at, origin, action, changes } y at = createdAt", async () => {
    const { toStoreHistoryResponse } = await loadHistoryModule();
    const out = toStoreHistoryResponse([record({}), PANEL_RECORD], HISTORY_SINCE);
    expect(out.registros).toEqual([
      {
        at: "2026-10-05T13:00:00.000Z",
        origin: "api",
        action: "order.seller_confirmed",
        changes: [{ field: "status", from: "imported", to: "ready_to_assign" }]
      },
      {
        at: "2026-10-05T14:30:00.000Z",
        origin: "panel",
        action: "order.imported_updated",
        changes: [{ field: "addressRaw", from: "Cra 1 # 2-3", to: "Cra 1 # 2-30" }]
      }
    ]);
    for (const out1 of out.registros) expect(Object.keys(out1).sort()).toEqual(["action", "at", "changes", "origin"]);
  });

  it("ningun registro de salida trae actor, uid ni auditEventId (ni nada que identifique a quien opero)", async () => {
    const { toStoreHistoryResponse } = await loadHistoryModule();
    const out = toStoreHistoryResponse([record({}), PANEL_RECORD], HISTORY_SINCE);
    for (const registro of out.registros) {
      for (const forbidden of ["actor", "uid", "auditEventId", "sellerId", "id", "orderId", "actorEmail", "actorLabel"]) {
        expect(registro, `el registro de salida trae ${forbidden}`).not.toHaveProperty(forbidden);
      }
    }
    const text = JSON.stringify(out);
    for (const leaked of ["uid-admin-secreto", "admin@kentro.co", "Camilo Admin", "audit-1", "audit-panel", "9f3a"]) {
      expect(text, `la respuesta filtra ${leaked}`).not.toContain(leaked);
    }
  });

  it("cada cambio sale solo con { field, from, to } (lista explicita tambien dentro de changes)", async () => {
    const { toStoreHistoryResponse } = await loadHistoryModule();
    const out = toStoreHistoryResponse(
      [record({ changes: [{ field: "status", from: "imported", to: "cancelled", by: "uid-admin-secreto" }] })],
      HISTORY_SINCE
    );
    expect(out.registros[0].changes).toEqual([{ field: "status", from: "imported", to: "cancelled" }]);
  });

  it("ordena del mas viejo al mas nuevo aunque lleguen desordenados", async () => {
    const { toStoreHistoryResponse } = await loadHistoryModule();
    const out = toStoreHistoryResponse(
      [
        record({ createdAt: "2026-10-06T09:00:00.000Z", action: "c" }),
        record({ createdAt: "2026-10-05T13:00:00.000Z", action: "a" }),
        record({ createdAt: "2026-10-05T18:00:00.000Z", action: "b" })
      ],
      HISTORY_SINCE
    );
    expect(out.registros.map((registro) => registro.action)).toEqual(["a", "b", "c"]);
  });

  it("vacio (pedido anterior a la spec, sin reconstruccion) → registros: [] con historySince, excludes y aviso", async () => {
    const { toStoreHistoryResponse, HISTORY_EXCLUDES } = await loadHistoryModule();
    const out = toStoreHistoryResponse([], HISTORY_SINCE);
    expect(out).toMatchObject({ ok: true, historySince: HISTORY_SINCE, registros: [] });
    expect(out.excludes).toEqual([...HISTORY_EXCLUDES]);
    expect(typeof out.aviso).toBe("string");
    expect(out.aviso.length).toBeGreaterThan(0);
  });

  it("HISTORY_EXCLUDES es el campo estable ['imports', 'chatby'] y sale en excludes", async () => {
    const { toStoreHistoryResponse, HISTORY_EXCLUDES } = await loadHistoryModule();
    expect([...HISTORY_EXCLUDES]).toEqual(["imports", "chatby"]);
    expect(toStoreHistoryResponse([record({})], HISTORY_SINCE).excludes).toEqual(["imports", "chatby"]);
  });

  it("el aviso dice en texto que no incluye importaciones (Shopify y webhooks de tienda) ni ChatBy", async () => {
    const { toStoreHistoryResponse } = await loadHistoryModule();
    const { aviso } = toStoreHistoryResponse([], HISTORY_SINCE);
    expect(aviso).toMatch(/no incluye/i);
    expect(aviso).toMatch(/importaci/i);
    expect(aviso).toMatch(/Shopify/);
    expect(aviso).toMatch(/webhook/i);
    expect(aviso).toMatch(/ChatBy/);
  });

  it("no muta los registros de entrada", async () => {
    const { toStoreHistoryResponse } = await loadHistoryModule();
    const input = [record({ createdAt: "2026-10-06T09:00:00.000Z" }), record({})];
    const copy = structuredClone(input);
    toStoreHistoryResponse(input, HISTORY_SINCE);
    expect(input).toEqual(copy);
  });
});
