/**
 * Spec 029 · nucleo puro de acciones de tienda (`functions/src/order-seller-actions.ts`).
 *
 * T4 — confirmar y cancelar: `isApiEditable`, `planConfirm`, `planCancel`, con la tabla de politica del plan
 * 4.1 (`panel` / `api`) y los pasos 4-9 de la precedencia (decision 12 de la spec):
 *   4) 404 tienda → 5) 409 por estado → 6) 422 → 7) sin cambios → 8) `status_changed` → 9) aplicar.
 * El parche de cancelar conserva la forma de `cancelOrder` de hoy: `driverId: current.driverId ?? null`.
 *
 * T5 anade su propio bloque `describe("T5 · ...")` al final de este archivo.
 *
 * El modulo se carga con `import()` dentro de cada prueba para que, mientras no exista, cada caso falle con
 * su propio mensaje en vez de tumbar el archivo entero.
 */
import { describe, expect, it } from "vitest";

const MODULE = "../../functions/src/order-seller-actions";

async function load() {
  return import(MODULE);
}

const SELLER = "seller-test";
const OTHER_SELLER = "seller-ajeno";
const NOW = "2026-10-05T15:00:00.000Z";

const API_ACTOR = { kind: "api", sellerId: SELLER, keyLast4: "c41e" } as const;
const ADMIN_ACTOR = { kind: "user", uid: "admin-1", role: "admin" } as const;
const SELLER_ACTOR = { kind: "user", uid: "seller-uid", role: "seller", sellerId: SELLER } as const;

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    sellerId: SELLER,
    status: "imported",
    driverId: null,
    trackingCode: "KNT-000001",
    customerName: "Ana Perez",
    customerPhone: "+573001234567",
    addressRaw: "Calle 5 # 10-20",
    cityId: "cali",
    callNote: "nota previa",
    ...overrides
  };
}

type AnyResult = Record<string, unknown>;
const isPlan = (r: AnyResult) => typeof r === "object" && r !== null && "outcome" in r;

function expectRejection(r: AnyResult, code: string) {
  expect(isPlan(r), `se esperaba rechazo ${code}, llego un plan`).toBe(false);
  expect(r.code).toBe(code);
}

function expectUnchanged(r: AnyResult) {
  expect(isPlan(r), `se esperaba plan unchanged, llego ${JSON.stringify(r)}`).toBe(true);
  expect(r.outcome).toBe("unchanged");
  expect(r.patch).toEqual({});
  expect(r.clear).toEqual([]);
  expect(r.audit).toBeNull();
  expect(r.history).toBeNull();
  expect(r.inventory).toBe("none");
}

function expectApplied(r: AnyResult) {
  expect(isPlan(r), `se esperaba plan applied, llego ${JSON.stringify(r)}`).toBe(true);
  expect(r.outcome).toBe("applied");
}

async function confirm(policy: "api" | "panel", o: Record<string, unknown>, input: Record<string, unknown> = {}, actor: unknown = policy === "api" ? API_ACTOR : ADMIN_ACTOR) {
  const { planConfirm } = await load();
  return planConfirm({ policy, actor, order: o, input, now: NOW }) as AnyResult;
}

async function cancel(policy: "api" | "panel", o: Record<string, unknown>, input: Record<string, unknown> = {}, actor: unknown = policy === "api" ? API_ACTOR : ADMIN_ACTOR) {
  const { planCancel } = await load();
  return planCancel({ policy, actor, order: o, input, now: NOW }) as AnyResult;
}

describe("T4 · confirmar y cancelar (planificador puro)", () => {
  describe("isApiEditable", () => {
    it("imported, address_risk y ready_to_assign sin lider son editables por API", async () => {
      const { isApiEditable } = await load();
      for (const status of ["imported", "address_risk", "ready_to_assign"]) {
        expect(isApiEditable({ status, driverId: null }), status).toBe(true);
        expect(isApiEditable({ status }), `${status} sin campo driverId`).toBe(true);
        expect(isApiEditable({ status, driverId: "" }), `${status} con driverId vacio`).toBe(true);
      }
    });

    it("con lider no es editable aunque el estado lo sea", async () => {
      const { isApiEditable } = await load();
      for (const status of ["imported", "address_risk", "ready_to_assign"]) {
        expect(isApiEditable({ status, driverId: "driver-1" }), status).toBe(false);
      }
    });

    it("estados en curso y finales no son editables", async () => {
      const { isApiEditable } = await load();
      for (const status of ["assigned", "call_pending", "in_route", "delivered", "failed", "cancelled", "liquidated"]) {
        expect(isApiEditable({ status, driverId: null }), status).toBe(false);
      }
    });
  });

  describe("planConfirm", () => {
    it("API: imported sin lider pasa a ready_to_assign, accepted, confirmedVia api, evento y historial", async () => {
      const r = await confirm("api", order());
      expectApplied(r);
      expect(r.patch).toMatchObject({ status: "ready_to_assign", addressRisk: "accepted", confirmedVia: "api", updatedAt: NOW });
      expect(r.audit).toMatchObject({ action: "order.seller_confirmed", actorRole: "store_api", fromStatus: "imported", toStatus: "ready_to_assign", entityId: "order-1" });
      const history = r.history as AnyResult;
      expect(history).toMatchObject({ orderId: "order-1", sellerId: SELLER, origin: "api", createdAt: NOW });
      expect(history.changes).toEqual([{ field: "status", from: "imported", to: "ready_to_assign" }]);
      expect(r.inventory).toBe("none");
    });

    it("panel: imported sin lider aplica igual con confirmedVia manual", async () => {
      const r = await confirm("panel", order(), {}, SELLER_ACTOR);
      expectApplied(r);
      expect(r.patch).toMatchObject({ status: "ready_to_assign", addressRisk: "accepted", confirmedVia: "manual" });
      expect(r.audit).toMatchObject({ action: "order.seller_confirmed", fromStatus: "imported", toStatus: "ready_to_assign" });
      expect((r.history as AnyResult).origin).toBe("panel");
    });

    it("API: imported con lider → 409 order_not_editable con hasLeader true (RF_04)", async () => {
      const r = await confirm("api", order({ driverId: "driver-1" }));
      expectRejection(r, "order_not_editable");
      expect(r).toMatchObject({ status: "imported", hasLeader: true });
    });

    it("panel: imported con lider aplica como hoy", async () => {
      const r = await confirm("panel", order({ driverId: "driver-1" }));
      expectApplied(r);
      expect(r.patch).toMatchObject({ status: "ready_to_assign", confirmedVia: "manual" });
    });

    it.each(["ready_to_assign", "in_route", "delivered"])("API: confirmar un %s → unchanged, sin evento ni historial (RF_05)", async (status) => {
      expectUnchanged(await confirm("api", order({ status, driverId: status === "ready_to_assign" ? null : "driver-1" })));
    });

    it.each(["ready_to_assign", "in_route", "delivered"])("panel: confirmar un %s → rechazo de hoy", async (status) => {
      const r = await confirm("panel", order({ status }));
      expectRejection(r, "panel_precondition");
    });

    it("sin cambios antes que status_changed: ready_to_assign con expectedStatus imported → unchanged", async () => {
      expectUnchanged(await confirm("api", order({ status: "ready_to_assign" }), { expectedStatus: "imported" }));
    });

    it("status_changed solo si cambiaria algo: imported sin lider con expectedStatus ready_to_assign → 409 status_changed", async () => {
      const r = await confirm("api", order(), { expectedStatus: "ready_to_assign" });
      expectRejection(r, "status_changed");
      expect(r.status).toBe("imported");
    });

    it("expectedStatus igual al real no bloquea", async () => {
      expectApplied(await confirm("api", order(), { expectedStatus: "imported" }));
    });

    it("409 por estado antes que status_changed: address_risk sin y con lider, con expectedStatus distinto → address_review_pending", async () => {
      for (const driverId of [null, "driver-1"]) {
        const r = await confirm("api", order({ status: "address_risk", driverId }), { expectedStatus: "imported" });
        expectRejection(r, "address_review_pending");
        expect(r.status).toBe("address_risk");
      }
    });

    it("RF_21 prevalece sobre order_not_editable: address_risk sin y con lider, sin expectedStatus → address_review_pending", async () => {
      for (const driverId of [null, "driver-1"]) {
        expectRejection(await confirm("api", order({ status: "address_risk", driverId })), "address_review_pending");
      }
    });

    it("409 por estado antes que status_changed: cancelled con expectedStatus distinto → order_cancelled (RF_06)", async () => {
      const r = await confirm("api", order({ status: "cancelled" }), { expectedStatus: "imported" });
      expectRejection(r, "order_cancelled");
      expect(r.status).toBe("cancelled");
    });

    it("404 antes que todo: pedido de otra tienda con expectedStatus distinto → order_not_found", async () => {
      expectRejection(await confirm("api", order({ sellerId: OTHER_SELLER, status: "cancelled" }), { expectedStatus: "ready_to_assign" }), "order_not_found");
    });

    it("panel: una tienda confirmando un pedido ajeno → rechazo (sin plan)", async () => {
      const r = await confirm("panel", order({ sellerId: OTHER_SELLER }), {}, SELLER_ACTOR);
      expect(isPlan(r)).toBe(false);
    });
  });

  describe("planCancel", () => {
    it("API: editable con motivo → cancelled, closedAt, callNote, driverId null, evento e historial", async () => {
      const r = await cancel("api", order({ status: "ready_to_assign" }), { reason: "  Cliente desistio  " });
      expectApplied(r);
      expect(r.patch).toMatchObject({ status: "cancelled", closedAt: NOW, callNote: "Cliente desistio", updatedAt: NOW });
      expect(r.patch).toHaveProperty("driverId", null);
      expect(r.audit).toMatchObject({ action: "order.cancelled", actorRole: "store_api", fromStatus: "ready_to_assign", toStatus: "cancelled" });
      expect((r.history as AnyResult).changes).toEqual([{ field: "status", from: "ready_to_assign", to: "cancelled" }]);
    });

    it("API: driverId ausente en el pedido → el parche lo escribe como null (current.driverId ?? null)", async () => {
      const o = order({ status: "imported" });
      delete (o as Record<string, unknown>).driverId;
      const r = await cancel("api", o, { reason: "Duplicado" });
      expectApplied(r);
      expect(r.patch).toHaveProperty("driverId", null);
    });

    it("libera inventario si reservo y no esta imported", async () => {
      expect((await cancel("api", order({ status: "ready_to_assign", inventoryReserved: true }), { reason: "x" })).inventory).toBe("release");
      expect((await cancel("api", order({ status: "address_risk", inventoryReserved: true }), { reason: "x" })).inventory).toBe("release");
    });

    it("no libera inventario si no reservo o si esta imported", async () => {
      expect((await cancel("api", order({ status: "ready_to_assign" }), { reason: "x" })).inventory).toBe("none");
      expect((await cancel("api", order({ status: "imported", inventoryReserved: true }), { reason: "x" })).inventory).toBe("none");
    });

    it("panel (admin) cancelando un assigned → parche con el driverId actual, como hoy", async () => {
      const r = await cancel("panel", order({ status: "assigned", driverId: "driver-1" }));
      expectApplied(r);
      expect(r.patch).toMatchObject({ status: "cancelled", closedAt: NOW, driverId: "driver-1" });
    });

    it("panel: motivo opcional, sin motivo conserva el callNote de hoy", async () => {
      const r = await cancel("panel", order({ status: "imported" }), {}, SELLER_ACTOR);
      expectApplied(r);
      expect(r.patch).toMatchObject({ status: "cancelled" });
      const callNote = (r.patch as AnyResult).callNote;
      expect(callNote === undefined || callNote === "nota previa").toBe(true);
    });

    it("API: assigned, imported con lider y address_risk con lider → 409 order_not_editable (RF_14)", async () => {
      const assigned = await cancel("api", order({ status: "assigned", driverId: "driver-1" }), { reason: "x" });
      expectRejection(assigned, "order_not_editable");
      expect(assigned).toMatchObject({ status: "assigned", hasLeader: true });
      const importedLeader = await cancel("api", order({ status: "imported", driverId: "driver-1" }), { reason: "x" });
      expectRejection(importedLeader, "order_not_editable");
      expect(importedLeader).toMatchObject({ status: "imported", hasLeader: true });
      const riskLeader = await cancel("api", order({ status: "address_risk", driverId: "driver-1" }), { reason: "x" });
      expectRejection(riskLeader, "order_not_editable");
      expect(riskLeader).toMatchObject({ status: "address_risk", hasLeader: true });
    });

    it("409 por estado antes que status_changed: in_route con expectedStatus distinto → order_not_editable", async () => {
      const r = await cancel("api", order({ status: "in_route", driverId: "driver-1" }), { reason: "x", expectedStatus: "imported" });
      expectRejection(r, "order_not_editable");
    });

    it("409 por estado antes que 422: assigned sin motivo → order_not_editable", async () => {
      expectRejection(await cancel("api", order({ status: "assigned", driverId: "driver-1" }), {}), "order_not_editable");
    });

    it("422 antes que sin cambios: cancelled sin motivo → validation_failed sobre reason", async () => {
      const r = await cancel("api", order({ status: "cancelled" }), {});
      expectRejection(r, "validation_failed");
      expect((r.fields as Array<{ field: string }>).map((f) => f.field)).toContain("reason");
    });

    it("422 con los fieldProblems recibidos de parseWriteBody (motivo demasiado largo) en un editable", async () => {
      const r = await cancel("api", order(), { reason: "x".repeat(501), fieldProblems: [{ field: "reason", code: "too_long" }] });
      expectRejection(r, "validation_failed");
      expect(r.fields).toEqual([{ field: "reason", code: "too_long" }]);
    });

    it("API: motivo vacio o solo espacios en un editable → 422 validation_failed", async () => {
      expectRejection(await cancel("api", order(), { reason: "   " }), "validation_failed");
    });

    it("sin cambios antes que status_changed: cancelled con motivo y expectedStatus imported → unchanged (RF_15)", async () => {
      expectUnchanged(await cancel("api", order({ status: "cancelled" }), { reason: "x", expectedStatus: "imported" }));
    });

    it("status_changed solo si cambiaria algo: imported sin lider con expectedStatus address_risk → 409 status_changed", async () => {
      const r = await cancel("api", order(), { reason: "x", expectedStatus: "address_risk" });
      expectRejection(r, "status_changed");
      expect(r.status).toBe("imported");
    });

    it("404 antes que todo: pedido de otra tienda con expectedStatus distinto → order_not_found", async () => {
      expectRejection(await cancel("api", order({ sellerId: OTHER_SELLER, status: "assigned", driverId: "driver-1" }), { expectedStatus: "imported" }), "order_not_found");
    });

    it("ningun plan de politica api escribe status address_risk", async () => {
      for (const status of ["imported", "address_risk", "ready_to_assign", "assigned", "cancelled"]) {
        for (const r of [await confirm("api", order({ status })), await cancel("api", order({ status }), { reason: "x" })]) {
          if (isPlan(r)) expect((r.patch as AnyResult).status).not.toBe("address_risk");
        }
      }
    });
  });
});
