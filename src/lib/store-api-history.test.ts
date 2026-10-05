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

/*
 * T14 · getOrderAuditTrail sin identidades para la tienda (RF_27, RF_18; plan 2.7).
 *
 * Contrato que fijan estas pruebas (todo PURO, en functions/src/store-api-history.ts):
 *
 *   export const STORE_SUMMARY_ACTIONS: readonly string[];   // la lista permitida del plan 2.7 (15 acciones)
 *   export function storeActorTag(actorRole: unknown): "Kentro" | "Tu tienda" | "API";
 *   export function storeSafeSummary(action: string, summary: unknown): string;   // "" fuera de la lista
 *   export function isStoreVisibleEvent(
 *     event: { id: string; action: string },
 *     verifiedAuditEventIds: ReadonlySet<string>          // los `auditEventId` de orderHistory del pedido
 *   ): boolean;                                            // verificable O accion en la lista permitida
 *   export function buildAuditTrailResponse(input: {
 *     role: string;                                        // admin | seller | seller_logistics | driver | messenger
 *     events: Array<Record<string, unknown>>;              // auditEvents del pedido, con `id`
 *     history: Array<Record<string, unknown>>;             // orderHistory del pedido
 *     historySince: string | null;                         // settings/storeApi.historySince
 *     sellerName: string;                                  // nombre de la tienda del pedido
 *     actors?: ReadonlyMap<string, { label: string; email?: string }>;  // SOLO para roles que no son tienda
 *   }): { events: AuditTrailEvent[]; historySince: string | null };
 *
 * Salida por evento (orden del mas viejo al mas nuevo): `id`, `createdAt`, `action`, `summary`, `fromStatus?`,
 * `toStatus?`, `origin?` (del registro de orderHistory o del propio evento) y `changes?` (si hay registro con
 * ese `auditEventId`). Para la tienda (`seller` / `seller_logistics`) ademas `actorTag`, y NUNCA `actorId`,
 * `actorLabel`, `actorEmail`, `actorRole` ni `apiKeyLast4`. Para el admin, como hoy (`actorId`, `actorLabel`,
 * `actorEmail`, `actorRole`) y, en los eventos de la API, `apiKeyLast4` y `actorLabel` "Clave de escritura de
 * <sellerName>". La callable `getOrderAuditTrail` delega en `buildAuditTrailResponse`.
 */
type TrailEvent = Record<string, unknown>;
type TrailInput = {
  role: string;
  events: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  historySince: string | null;
  sellerName: string;
  actors?: ReadonlyMap<string, { label: string; email?: string }>;
};

async function loadTrailModule(): Promise<{
  STORE_SUMMARY_ACTIONS: readonly string[];
  storeActorTag: (actorRole: unknown) => string;
  storeSafeSummary: (action: string, summary: unknown) => string;
  isStoreVisibleEvent: (event: { id: string; action: string }, verified: ReadonlySet<string>) => boolean;
  buildAuditTrailResponse: (input: TrailInput) => { events: TrailEvent[]; historySince: string | null };
}> {
  const mod = (await import(HISTORY_MODULE)) as Record<string, unknown>;
  for (const name of ["storeActorTag", "storeSafeSummary", "isStoreVisibleEvent", "buildAuditTrailResponse"]) {
    if (typeof mod[name] !== "function") throw new Error(`functions/src/store-api-history.ts no exporta ${name}`);
  }
  if (!Array.isArray(mod.STORE_SUMMARY_ACTIONS)) {
    throw new Error("functions/src/store-api-history.ts no exporta STORE_SUMMARY_ACTIONS");
  }
  return mod as never;
}

const PLAN_ALLOWED_ACTIONS = [
  "order.seller_confirmed",
  "order.imported_updated",
  "order.cancelled",
  "order.retry_confirmed",
  "order.transition",
  "order.delivered",
  "order.failed",
  "order.retry_scheduled",
  "order.webhook_imported",
  "order.manual_created",
  "order.confirmed_uchat",
  "order.failed_classified",
  "order.delivery_corrected",
  "order.address_reviewed",
  "order.picked_up"
];

const IDENTITY_KEYS = ["actorId", "actorLabel", "actorEmail", "actorRole", "apiKeyLast4"];
const STORE_ROLES = ["seller", "seller_logistics"] as const;

function auditRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ev-1",
    createdAt: "2026-10-05T13:00:00.000Z",
    action: "order.seller_confirmed",
    actorId: "uid-ana",
    actorRole: "admin",
    entity: "order",
    entityId: "o-1",
    summary: "Pedido KNT-1 confirmado por admin",
    ...overrides
  };
}

const API_EVENT = auditRow({
  id: "ev-api",
  actorId: "store-api",
  actorRole: "store_api",
  origin: "api",
  apiKeyLast4: "9f3a",
  summary: "Pedido KNT-1 confirmado por API de la tienda"
});
const API_HISTORY = record({ id: "h-api", auditEventId: "ev-api", origin: "api" });

const ACTORS = new Map([
  ["uid-ana", { label: "Ana Admin", email: "ana@kentro.co" }],
  ["uid-leo", { label: "Leo Lider", email: "leo@kentro.co" }],
  ["store-api", { label: "store-api" }]
]);

function trailInput(overrides: Partial<TrailInput>): TrailInput {
  return { role: "admin", events: [], history: [], historySince: HISTORY_SINCE, sellerName: "Kovia", actors: ACTORS, ...overrides };
}

describe("T14 · getOrderAuditTrail sin identidades para la tienda", () => {
  describe("storeActorTag", () => {
    it.each([
      ["admin", "Kentro"],
      ["driver", "Kentro"],
      ["messenger", "Kentro"],
      ["seller", "Tu tienda"],
      ["seller_logistics", "Tu tienda"],
      ["store_api", "API"],
      [undefined, "Kentro"],
      ["", "Kentro"],
      ["rol_desconocido", "Kentro"]
    ])("actorRole %s → %s", async (actorRole, expected) => {
      const { storeActorTag } = await loadTrailModule();
      expect(storeActorTag(actorRole)).toBe(expected);
    });
  });

  describe("storeSafeSummary: lista permitida", () => {
    it("STORE_SUMMARY_ACTIONS es exactamente la lista permitida del plan 2.7", async () => {
      const { STORE_SUMMARY_ACTIONS } = await loadTrailModule();
      expect([...STORE_SUMMARY_ACTIONS].sort()).toEqual([...PLAN_ALLOWED_ACTIONS].sort());
    });

    it.each(PLAN_ALLOWED_ACTIONS)("%s conserva su summary", async (action) => {
      const { storeSafeSummary } = await loadTrailModule();
      expect(storeSafeSummary(action, "Pedido KNT-1 confirmado por vendedor")).toBe("Pedido KNT-1 confirmado por vendedor");
    });

    it.each(["order.messenger_reassigned", "order.messenger_unassigned", "order.correct_failed_to_delivered", "order.inventada"])(
      "%s → summary vacio",
      async (action) => {
        const { storeSafeSummary } = await loadTrailModule();
        expect(storeSafeSummary(action, "Reasignado de msg-uid-1 a msg-uid-2")).toBe("");
      }
    );

    it("un summary que no es texto sale vacio aunque la accion este en la lista", async () => {
      const { storeSafeSummary } = await loadTrailModule();
      expect(storeSafeSummary("order.seller_confirmed", undefined)).toBe("");
    });
  });

  describe("isStoreVisibleEvent: verificable o en la lista permitida (mitigacion hasta la 032)", () => {
    it("verificable por orderHistory.auditEventId aunque la accion este fuera de la lista", async () => {
      const { isStoreVisibleEvent } = await loadTrailModule();
      expect(isStoreVisibleEvent({ id: "ev-9", action: "order.messenger_reassigned" }, new Set(["ev-9"]))).toBe(true);
    });

    it("no verificable pero con accion permitida", async () => {
      const { isStoreVisibleEvent } = await loadTrailModule();
      expect(isStoreVisibleEvent({ id: "ev-9", action: "order.transition" }, new Set())).toBe(true);
    });

    it("no verificable y fuera de la lista → no visible", async () => {
      const { isStoreVisibleEvent } = await loadTrailModule();
      expect(isStoreVisibleEvent({ id: "ev-9", action: "order.messenger_reassigned" }, new Set(["otro"]))).toBe(false);
    });

    it("un id vacio no se verifica contra un auditEventId vacio", async () => {
      const { isStoreVisibleEvent } = await loadTrailModule();
      expect(isStoreVisibleEvent({ id: "", action: "order.messenger_reassigned" }, new Set([""]))).toBe(false);
    });
  });

  describe("buildAuditTrailResponse: la tienda", () => {
    it.each(STORE_ROLES)("%s: devuelve { events, historySince }", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [auditRow({})] }));
      expect(Object.keys(out).sort()).toEqual(["events", "historySince"]);
      expect(out.historySince).toBe(HISTORY_SINCE);
    });

    it.each(STORE_ROLES)("%s: evento historico sin origen sale sin identidades y con actorTag Kentro", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [auditRow({ id: "ev-old" })] }));
      expect(out.events).toHaveLength(1);
      const [event] = out.events;
      for (const key of IDENTITY_KEYS) expect(event).not.toHaveProperty(key);
      expect(event.actorTag).toBe("Kentro");
      expect(event.summary).toBe("Pedido KNT-1 confirmado por admin");
    });

    it.each(STORE_ROLES)("%s: evento de un usuario de la tienda → \"Tu tienda\"", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [auditRow({ actorRole: "seller_logistics", actorId: "uid-log" })] }));
      expect(out.events[0].actorTag).toBe("Tu tienda");
    });

    it.each(STORE_ROLES)("%s: evento de la API → \"API\", sin apiKeyLast4 ni actorLabel", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [API_EVENT], history: [API_HISTORY] }));
      const [event] = out.events;
      expect(event.actorTag).toBe("API");
      for (const key of IDENTITY_KEYS) expect(event).not.toHaveProperty(key);
      expect(JSON.stringify(out)).not.toContain("9f3a");
      expect(JSON.stringify(out)).not.toContain("Clave de escritura");
    });

    it.each(STORE_ROLES)("%s: no usa el mapa de actores aunque se lo pasen (ningun nombre ni correo sale)", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role, events: [auditRow({}), auditRow({ id: "ev-2", actorId: "uid-leo", actorRole: "driver" })] }));
      const serialized = JSON.stringify(out);
      for (const leak of ["Ana Admin", "ana@kentro.co", "Leo Lider", "leo@kentro.co", "uid-ana", "uid-leo"]) {
        expect(serialized).not.toContain(leak);
      }
    });

    it.each(STORE_ROLES)("%s: order.messenger_reassigned verificable → visible con summary \"\" y sus cambios", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const reassigned = auditRow({ id: "ev-r", action: "order.messenger_reassigned", actorRole: "driver", summary: "Reasignado de msg-uid-1 a msg-uid-2" });
      const history = record({ id: "h-r", auditEventId: "ev-r", origin: "panel", action: "order.messenger_reassigned", changes: [{ field: "status", from: "picked_up", to: "call_pending" }] });
      const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [reassigned], history: [history] }));
      expect(out.events).toHaveLength(1);
      expect(out.events[0].summary).toBe("");
      expect(out.events[0].changes).toEqual([{ field: "status", from: "picked_up", to: "call_pending" }]);
      expect(out.events[0].origin).toBe("panel");
    });

    it.each(STORE_ROLES)("%s: evento no verificable fuera de la lista → descartado", async (role) => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const reassigned = auditRow({ id: "ev-r", action: "order.messenger_reassigned", actorRole: "driver", summary: "Reasignado de msg-uid-1 a msg-uid-2" });
      const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [reassigned, auditRow({ id: "ev-ok" })] }));
      expect(out.events.map((event) => event.id)).toEqual(["ev-ok"]);
    });
  });

  describe("buildAuditTrailResponse: el admin y los demas roles", () => {
    it("admin: ve el evento no verificable fuera de la lista, con su summary", async () => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const reassigned = auditRow({ id: "ev-r", action: "order.messenger_reassigned", actorRole: "driver", actorId: "uid-leo", summary: "Reasignado de msg-uid-1 a msg-uid-2" });
      const out = buildAuditTrailResponse(trailInput({ role: "admin", events: [reassigned] }));
      expect(out.events).toHaveLength(1);
      expect(out.events[0].summary).toBe("Reasignado de msg-uid-1 a msg-uid-2");
    });

    it("admin: ve nombre y correo como hoy", async () => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role: "admin", events: [auditRow({})] }));
      expect(out.events[0]).toMatchObject({ actorId: "uid-ana", actorLabel: "Ana Admin", actorEmail: "ana@kentro.co", actorRole: "admin" });
    });

    it("admin: un evento de la API trae apiKeyLast4 y actorLabel \"Clave de escritura de <tienda>\"", async () => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role: "admin", sellerName: "Kovia", events: [API_EVENT], history: [API_HISTORY] }));
      expect(out.events[0]).toMatchObject({ apiKeyLast4: "9f3a", actorLabel: "Clave de escritura de Kovia", origin: "api" });
      expect(out.events[0].changes).toEqual([{ field: "status", from: "imported", to: "ready_to_assign" }]);
    });

    it("admin: un evento que no es de la API no trae apiKeyLast4", async () => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role: "admin", events: [auditRow({ apiKeyLast4: "zzzz" })] }));
      expect(out.events[0]).not.toHaveProperty("apiKeyLast4");
    });

    it("driver: sigue viendo la etiqueta resuelta como hoy (RF_27 es solo para la tienda)", async () => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const out = buildAuditTrailResponse(trailInput({ role: "driver", events: [auditRow({})] }));
      expect(out.events[0]).toMatchObject({ actorLabel: "Ana Admin" });
      expect(out.events[0]).not.toHaveProperty("actorTag");
    });

    it("ordena del mas viejo al mas nuevo y no muta la entrada", async () => {
      const { buildAuditTrailResponse } = await loadTrailModule();
      const events = [auditRow({ id: "b", createdAt: "2026-10-05T14:00:00.000Z" }), auditRow({ id: "a", createdAt: "2026-10-05T13:00:00.000Z" })];
      const copy = structuredClone(events);
      const out = buildAuditTrailResponse(trailInput({ role: "seller", actors: undefined, events }));
      expect(out.events.map((event) => event.id)).toEqual(["a", "b"]);
      expect(events).toEqual(copy);
    });
  });
});

describe("T31 · la tienda verifica eventos por el id real del documento (R1-RF_27-1)", () => {
  // Regresion: buildAuditTrailResponse ya compara `row.id`; el agujero estaba en la callable, que le pasaba el
  // `id` del CUERPO. Con el id real (`doc.id`), una copia del cuerpo de un evento verificado no se verifica.
  it.each(STORE_ROLES)("%s: fila con id real ajeno a orderHistory y accion fuera de la lista → descartada aunque copie un cuerpo verificado", async (role) => {
    const { buildAuditTrailResponse } = await loadTrailModule();
    const verified = auditRow({ id: "ev-real", action: "order.seller_confirmed", summary: "Pedido KNT-1 confirmado por vendedor" });
    const history = record({ id: "h-real", auditEventId: "ev-real", origin: "panel", action: "order.seller_confirmed", changes: [{ field: "status", from: "imported", to: "ready_to_assign" }] });
    const forged = { ...verified, id: "doc-falso-xyz", action: "order.correct_delivered_to_failed", actorRole: "seller" };
    const out = buildAuditTrailResponse(trailInput({ role, actors: undefined, events: [verified, forged], history: [history] }));
    expect(out.events.map((event) => event.id)).toEqual(["ev-real"]);
  });
});
