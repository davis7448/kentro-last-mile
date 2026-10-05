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

// ===================================================================================================
// T5 — corregir datos de entrega, validacion de contenido e historial (planificador puro)
// ===================================================================================================
//
// Contrato que fijan estas pruebas (plan 4.1, 4.4, 2.5, 2.6):
//   validateDeliveryInput(input: DeliveryInput): FieldProblem[]
//     solo mira las claves presentes; devuelve TODOS los problemas a la vez; `deliveryNotes` null/""/blanco
//     no es problema (borrar, unica excepcion de RF_09).
//   planDeliveryCorrection(i: PlanInput<DeliveryInput & { expectedStatus?; city: CityFact | null;
//     panelExtras?: PanelEditExtras; fieldProblems?: FieldProblem[] }>): SellerActionRejection | SellerActionPlan
//   buildOrderHistoryRecord(before, after, meta: { orderId; sellerId; origin; action; actor: SellerActor; now;
//     auditEventId? }): OrderHistoryDraft (+ auditEventId si se pasa) | null

const MERGE_MODULE = "../../functions/src/order-import-merge";
const STAMP = "manuallyEditedAt";

const CALI = { id: "cali", active: true } as const;
const CALI_OFF = { id: "cali", active: false } as const;
const JAMUNDI = { id: "jamundi", active: true } as const;

function deliveryOrder(overrides: Record<string, unknown> = {}) {
  return order({
    deliveryNotes: "Porteria",
    productName: "Crema",
    sku: "CR-1",
    quantity: 1,
    totalCop: 89000,
    paymentMethod: "cod",
    ...overrides
  });
}

/** Lo que el panel manda hoy en cada guardado: los datos de entrega completos. */
function panelDelivery(o: Record<string, unknown>) {
  return {
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    addressRaw: o.addressRaw,
    deliveryNotes: o.deliveryNotes,
    cityId: o.cityId
  };
}

async function correct(
  policy: "api" | "panel",
  o: Record<string, unknown>,
  input: Record<string, unknown> = {},
  actor: unknown = policy === "api" ? API_ACTOR : ADMIN_ACTOR
) {
  const { planDeliveryCorrection } = await load();
  return planDeliveryCorrection({ policy, actor, order: o, input: { city: null, ...input }, now: NOW }) as AnyResult;
}

async function validate(input: Record<string, unknown>) {
  const { validateDeliveryInput } = await load();
  return validateDeliveryInput(input) as Array<{ field: string; code: string }>;
}

function changesOf(r: AnyResult) {
  return ((r.history as AnyResult | null)?.changes ?? []) as Array<{ field: string; from: unknown; to: unknown }>;
}

/** Borrar las indicaciones: `deliveryNotes: null` en el parche o la clave en `clear` (decision a ratificar). */
function notesCleared(r: AnyResult) {
  const patch = r.patch as AnyResult;
  return (("deliveryNotes" in patch) && patch.deliveryNotes === null) || (r.clear as string[]).includes("deliveryNotes");
}

describe("T5 · corregir datos de entrega, validacion e historial (planificador puro)", () => {
  describe("validateDeliveryInput (tabla 4.4)", () => {
    it("cuerpo valido completo → sin problemas", async () => {
      expect(
        await validate({ customerName: "  Ana  ", customerPhone: "3001234567", addressRaw: "Calle 1", deliveryNotes: "Timbre", cityId: "cali" })
      ).toEqual([]);
    });

    it("cuerpo vacio → sin problemas (no_fields lo decide el planificador)", async () => {
      expect(await validate({})).toEqual([]);
    });

    it("customerName, customerPhone, addressRaw o cityId vacios, en blanco o null → empty", async () => {
      for (const field of ["customerName", "customerPhone", "addressRaw", "cityId"]) {
        for (const value of ["", "   ", null]) {
          expect(await validate({ [field]: value }), `${field}=${JSON.stringify(value)}`).toEqual([{ field, code: "empty" }]);
        }
      }
    });

    it("telefonos validos: 10 digitos (con separadores), +57 + 10 digitos y E.164", async () => {
      for (const phone of ["3001234567", "300 123 4567", "300-123-4567", "(300) 123.4567", "+573001234567", "+57 300 123 4567", "+14155552671"]) {
        expect(await validate({ customerPhone: phone }), phone).toEqual([]);
      }
    });

    it("telefonos invalidos → invalid_phone", async () => {
      for (const phone of ["12345", "300123456", "30012345678", "abc", "+0123456789", "+1234567"]) {
        expect(await validate({ customerPhone: phone }), phone).toEqual([{ field: "customerPhone", code: "invalid_phone" }]);
      }
    });

    it("limites de longitud: nombre 120, direccion 300, indicaciones 500 (recortados)", async () => {
      expect(await validate({ customerName: "x".repeat(120), addressRaw: "x".repeat(300), deliveryNotes: "x".repeat(500) })).toEqual([]);
      expect(await validate({ customerName: `  ${"x".repeat(120)}  ` })).toEqual([]);
      expect(await validate({ customerName: "x".repeat(121) })).toEqual([{ field: "customerName", code: "too_long" }]);
      expect(await validate({ addressRaw: "x".repeat(301) })).toEqual([{ field: "addressRaw", code: "too_long" }]);
      expect(await validate({ deliveryNotes: "x".repeat(501) })).toEqual([{ field: "deliveryNotes", code: "too_long" }]);
    });

    it("deliveryNotes null, \"\" o en blanco no es problema (borra, unica excepcion de RF_09)", async () => {
      for (const value of [null, "", "   "]) expect(await validate({ deliveryNotes: value })).toEqual([]);
    });

    it("cityId fuera de ^[a-z0-9-]{1,64}$ → un problema sobre cityId", async () => {
      for (const cityId of ["Cali", "cali!", "x".repeat(65)]) {
        const problems = await validate({ cityId });
        expect(problems, cityId).toHaveLength(1);
        expect(problems[0].field).toBe("cityId");
      }
    });

    it("devuelve todos los errores a la vez", async () => {
      const problems = await validate({ customerName: "", customerPhone: "123", addressRaw: "x".repeat(301), cityId: null });
      expect(problems).toHaveLength(4);
      expect(problems).toEqual(
        expect.arrayContaining([
          { field: "customerName", code: "empty" },
          { field: "customerPhone", code: "invalid_phone" },
          { field: "addressRaw", code: "too_long" },
          { field: "cityId", code: "empty" }
        ])
      );
    });
  });

  describe("planDeliveryCorrection · politica api", () => {
    it("solo campos enviados: parche con el telefono recortado, sello y updatedAt; nada mas de entrega", async () => {
      const r = await correct("api", deliveryOrder(), { customerPhone: "  3109876543 " });
      expectApplied(r);
      const patch = r.patch as AnyResult;
      expect(patch.customerPhone).toBe("3109876543");
      expect(patch[STAMP]).toBe(NOW);
      expect(patch.updatedAt).toBe(NOW);
      for (const key of ["customerName", "addressRaw", "cityId", "deliveryNotes", "driverId", "productName", "totalCop"]) {
        expect(patch, key).not.toHaveProperty(key);
      }
      expect(r.clear).toEqual([]);
      expect(r.inventory).toBe("none");
    });

    it("imported sigue imported: el parche no toca status", async () => {
      const r = await correct("api", deliveryOrder(), { customerName: "Ana Maria" });
      expectApplied(r);
      expect(r.patch).not.toHaveProperty("status");
    });

    it("ready_to_assign sin lider es editable y no cambia de estado", async () => {
      const r = await correct("api", deliveryOrder({ status: "ready_to_assign" }), { customerName: "Ana Maria" });
      expectApplied(r);
      expect(r.patch).not.toHaveProperty("status");
    });

    it("evento order.delivery_corrected con actor de la API e historial con el campo cambiado", async () => {
      const r = await correct("api", deliveryOrder(), { customerName: "Ana Maria" });
      expectApplied(r);
      const audit = r.audit as AnyResult;
      expect(audit.action).toBe("order.delivery_corrected");
      expect(audit.actorId).toBe("store-api");
      expect(audit.actorRole).toBe("store_api");
      expect(audit.origin).toBe("api");
      expect(audit.apiKeyLast4).toBe("c41e");
      expect(audit.entityId).toBe("order-1");
      const history = r.history as AnyResult;
      expect(history.origin).toBe("api");
      expect(history.action).toBe("order.delivery_corrected");
      expect(history.actor).toEqual({ kind: "api", keyLast4: "c41e" });
      expect(changesOf(r)).toEqual([{ field: "customerName", from: "Ana Perez", to: "Ana Maria" }]);
    });

    it("409 order_not_editable: in_route, call_pending, address_risk con lider, imported con lider", async () => {
      const cases: Array<[Record<string, unknown>, boolean]> = [
        [{ status: "in_route", driverId: "driver-1" }, true],
        [{ status: "call_pending", driverId: "driver-1" }, true],
        [{ status: "address_risk", driverId: "driver-1" }, true],
        [{ status: "imported", driverId: "driver-1" }, true]
      ];
      for (const [overrides, leader] of cases) {
        const r = await correct("api", deliveryOrder(overrides), { customerName: "Otro" });
        expectRejection(r, "order_not_editable");
        expect(r.status).toBe(overrides.status);
        expect(r.hasLeader).toBe(leader);
      }
    });

    it("404 antes que todo: pedido de otra tienda → order_not_found", async () => {
      expectRejection(
        await correct("api", deliveryOrder({ sellerId: OTHER_SELLER, status: "in_route", driverId: "d" }), {
          customerName: "x",
          expectedStatus: "imported",
          fieldProblems: [{ field: "customerPhone", code: "invalid_phone" }]
        }),
        "order_not_found"
      );
    });

    it("409 antes que 422: in_route con fieldProblems (telefono invalido) → order_not_editable", async () => {
      expectRejection(
        await correct("api", deliveryOrder({ status: "in_route", driverId: "d" }), {
          customerPhone: "123",
          fieldProblems: [{ field: "customerPhone", code: "invalid_phone" }]
        }),
        "order_not_editable"
      );
    });

    it("409 antes que 422: in_route con ciudad desactivada → order_not_editable", async () => {
      expectRejection(
        await correct("api", deliveryOrder({ status: "in_route", driverId: "d" }), { cityId: "cali", city: CALI_OFF }),
        "order_not_editable"
      );
    });

    it("422 antes que sin cambios (RF_10): reenviar el mismo cityId con la ciudad inactiva → out_of_coverage", async () => {
      const r = await correct("api", deliveryOrder(), { cityId: "cali", city: CALI_OFF });
      expectRejection(r, "out_of_coverage");
      expect(r.field).toBe("cityId");
    });

    it("RF_10 tambien con expectedStatus distinto → out_of_coverage (no status_changed ni unchanged)", async () => {
      expectRejection(await correct("api", deliveryOrder(), { cityId: "cali", city: CALI_OFF, expectedStatus: "ready_to_assign" }), "out_of_coverage");
    });

    it("cityId con ciudad inexistente (city null) → out_of_coverage", async () => {
      expectRejection(await correct("api", deliveryOrder(), { cityId: "bogota", city: null }), "out_of_coverage");
    });

    it("telefono valido + ciudad inactiva → out_of_coverage; no se aplica el telefono", async () => {
      const r = await correct("api", deliveryOrder(), { customerPhone: "3109876543", cityId: "jamundi", city: { id: "jamundi", active: false } });
      expectRejection(r, "out_of_coverage");
      expect(r).not.toHaveProperty("patch");
    });

    it("cambiar a una ciudad activa → applied con cityId en el parche", async () => {
      const r = await correct("api", deliveryOrder(), { cityId: "jamundi", city: JAMUNDI });
      expectApplied(r);
      expect((r.patch as AnyResult).cityId).toBe("jamundi");
      expect(changesOf(r)).toEqual([{ field: "cityId", from: "cali", to: "jamundi" }]);
    });

    it("fieldProblems sobre un editable con valores identicos → 422 validation_failed (no unchanged)", async () => {
      const problems = [{ field: "customerPhone", code: "invalid_phone" }];
      const r = await correct("api", deliveryOrder(), { customerName: "Ana Perez", fieldProblems: problems });
      expectRejection(r, "validation_failed");
      expect(r.fields).toEqual(problems);
    });

    it("fieldProblems con alguna clave no permitida → field_not_allowed con todos los campos", async () => {
      const problems = [
        { field: "totalCop", code: "not_allowed" },
        { field: "customerPhone", code: "invalid_phone" }
      ];
      const r = await correct("api", deliveryOrder(), { customerName: "Ana Perez", fieldProblems: problems });
      expectRejection(r, "field_not_allowed");
      expect(r.fields).toEqual(problems);
    });

    it("el nucleo no deja pasar un valor vacio aunque no lleguen fieldProblems → 422 empty", async () => {
      const r = await correct("api", deliveryOrder(), { customerName: "" });
      expectRejection(r, "validation_failed");
      expect(r.fields).toEqual([{ field: "customerName", code: "empty" }]);
    });

    it("sin ningun campo de entrega → 422 no_fields (tambien solo con expectedStatus)", async () => {
      expectRejection(await correct("api", deliveryOrder(), {}), "no_fields");
      expectRejection(await correct("api", deliveryOrder(), { expectedStatus: "imported" }), "no_fields");
    });

    it("sin cambios antes que status_changed: mismos valores (recortados) y expectedStatus distinto → unchanged", async () => {
      expectUnchanged(await correct("api", deliveryOrder(), { customerName: "  Ana Perez ", customerPhone: "+573001234567", expectedStatus: "ready_to_assign" }));
      expectUnchanged(await correct("api", deliveryOrder({ status: "ready_to_assign" }), { addressRaw: "Calle 5 # 10-20", expectedStatus: "imported" }));
      expectUnchanged(await correct("api", deliveryOrder(), { cityId: "cali", city: CALI, expectedStatus: "ready_to_assign" }));
    });

    it("con un campo que cambia y expectedStatus distinto → 409 status_changed con el estado real", async () => {
      const r = await correct("api", deliveryOrder(), { customerName: "Ana Maria", expectedStatus: "ready_to_assign" });
      expectRejection(r, "status_changed");
      expect(r.status).toBe("imported");
    });

    it("expectedStatus igual al real y un cambio → applied", async () => {
      expectApplied(await correct("api", deliveryOrder(), { customerName: "Ana Maria", expectedStatus: "imported" }));
    });

    it("deliveryNotes \"\" y null borran las indicaciones (cambio a null en el historial) y no dan no_fields", async () => {
      for (const value of ["", null, "   "]) {
        const r = await correct("api", deliveryOrder(), { deliveryNotes: value });
        expectApplied(r);
        expect(notesCleared(r), `deliveryNotes=${JSON.stringify(value)}`).toBe(true);
        expect(changesOf(r)).toEqual([{ field: "deliveryNotes", from: "Porteria", to: null }]);
      }
    });

    it("deliveryNotes null sobre un pedido sin indicaciones → unchanged (no no_fields)", async () => {
      expectUnchanged(await correct("api", deliveryOrder({ deliveryNotes: undefined }), { deliveryNotes: null }));
    });

    it("RF_23: direccion cambiada → clear con los cuatro derivados presentes y fuera del parche", async () => {
      const o = deliveryOrder({ normalizedAddress: "CL 5 10 20", lat: 3.4, lng: -76.5, geoProvider: "google" });
      const r = await correct("api", o, { addressRaw: "Carrera 80 # 2-10" });
      expectApplied(r);
      expect([...(r.clear as string[])].sort()).toEqual(["geoProvider", "lat", "lng", "normalizedAddress"]);
      for (const key of ["normalizedAddress", "lat", "lng", "geoProvider"]) expect(r.patch).not.toHaveProperty(key);
      expect((r.patch as AnyResult).addressRaw).toBe("Carrera 80 # 2-10");
    });

    it("RF_23: solo se borran los derivados que el pedido tiene", async () => {
      const r = await correct("api", deliveryOrder({ normalizedAddress: "CL 5 10 20", lat: 3.4 }), { addressRaw: "Carrera 80 # 2-10" });
      expect([...(r.clear as string[])].sort()).toEqual(["lat", "normalizedAddress"]);
    });

    it("RF_23: sin cambio de direccion no se borra nada", async () => {
      const r = await correct("api", deliveryOrder({ normalizedAddress: "CL 5 10 20", lat: 3.4 }), { customerName: "Ana Maria", addressRaw: "Calle 5 # 10-20" });
      expectApplied(r);
      expect(r.clear).toEqual([]);
    });

    it("RF_22: address_risk sin lider con valores identicos → imported + review + order.address_reviewed con solo status", async () => {
      const r = await correct("api", deliveryOrder({ status: "address_risk", addressRisk: "review" }), { addressRaw: "Calle 5 # 10-20" });
      expectApplied(r);
      const patch = r.patch as AnyResult;
      expect(patch.status).toBe("imported");
      expect(patch.addressRisk).toBe("review");
      expect(patch[STAMP]).toBe(NOW);
      const audit = r.audit as AnyResult;
      expect(audit.action).toBe("order.address_reviewed");
      expect(audit.fromStatus).toBe("address_risk");
      expect(audit.toStatus).toBe("imported");
      expect((r.history as AnyResult).action).toBe("order.address_reviewed");
      expect(changesOf(r)).toEqual([{ field: "status", from: "address_risk", to: "imported" }]);
    });

    it("RF_22: address_risk sin lider con un campo cambiado → order.delivery_corrected con status y el campo", async () => {
      const r = await correct("api", deliveryOrder({ status: "address_risk", addressRisk: "review" }), { addressRaw: "Carrera 80 # 2-10" });
      expectApplied(r);
      expect((r.patch as AnyResult).status).toBe("imported");
      expect((r.audit as AnyResult).action).toBe("order.delivery_corrected");
      expect(changesOf(r)).toHaveLength(2);
      expect(changesOf(r)).toEqual(
        expect.arrayContaining([
          { field: "status", from: "address_risk", to: "imported" },
          { field: "addressRaw", from: "Calle 5 # 10-20", to: "Carrera 80 # 2-10" }
        ])
      );
    });

    it("RF_22: address_risk sin lider con expectedStatus distinto → status_changed (cambiaria algo)", async () => {
      expectRejection(await correct("api", deliveryOrder({ status: "address_risk" }), { addressRaw: "Calle 5 # 10-20", expectedStatus: "imported" }), "status_changed");
    });

    it("panelExtras con politica api → lanza (error de programacion)", async () => {
      const { planDeliveryCorrection } = await load();
      expect(typeof planDeliveryCorrection).toBe("function");
      expect(() =>
        planDeliveryCorrection({ policy: "api", actor: API_ACTOR, order: deliveryOrder(), input: { customerName: "x", city: null, panelExtras: { totalCop: 1 } }, now: NOW })
      ).toThrow();
    });

    it("propiedad: ningun plan api emite status address_risk, para ningun estado de partida ni entrada", async () => {
      const inputs: Array<Record<string, unknown>> = [
        { customerName: "Ana Perez" },
        { customerName: "Otra" },
        { addressRaw: "Carrera 80 # 2-10" },
        { deliveryNotes: null },
        { cityId: "jamundi", city: JAMUNDI }
      ];
      for (const status of ["imported", "address_risk", "ready_to_assign", "assigned", "in_route", "cancelled", "delivered"]) {
        for (const driverId of [null, "driver-1"]) {
          for (const input of inputs) {
            const r = await correct("api", deliveryOrder({ status, driverId, addressRisk: "review" }), input);
            if (isPlan(r)) expect((r.patch as AnyResult).status, `${status}/${driverId}/${JSON.stringify(input)}`).not.toBe("address_risk");
          }
        }
      }
    });
  });

  describe("planDeliveryCorrection · politica panel", () => {
    it("solo imported: otro estado → panel_precondition failed-precondition con el mensaje de hoy", async () => {
      const r = await correct("panel", deliveryOrder({ status: "ready_to_assign" }), panelDelivery(deliveryOrder()));
      expectRejection(r, "panel_precondition");
      expect(r.httpsCode).toBe("failed-precondition");
      expect(r.message).toBe("Only imported orders pending confirmation can be edited.");
    });

    it("tienda editando un pedido ajeno → panel_precondition permission-denied", async () => {
      const r = await correct("panel", deliveryOrder({ sellerId: OTHER_SELLER }), panelDelivery(deliveryOrder()), SELLER_ACTOR);
      expectRejection(r, "panel_precondition");
      expect(r.httpsCode).toBe("permission-denied");
      expect(r.message).toBe("Sellers can only edit their own orders.");
    });

    it("indicaciones en blanco se conservan: ni en el parche ni en clear ni en el historial", async () => {
      const o = deliveryOrder();
      const r = await correct("panel", o, { ...panelDelivery(o), deliveryNotes: "   ", panelExtras: {} });
      expectApplied(r);
      expect(r.patch).not.toHaveProperty("deliveryNotes");
      expect(r.clear).not.toContain("deliveryNotes");
      expect(changesOf(r).map((c) => c.field)).not.toContain("deliveryNotes");
    });

    it("edicion solo de producto → applied, parche con producto y sello, order.imported_updated, historial de producto", async () => {
      const o = deliveryOrder();
      const r = await correct("panel", o, {
        ...panelDelivery(o),
        panelExtras: { productName: "Serum", totalCop: 99000, sku: "CR-1", quantity: 1, paymentMethod: "cod" }
      });
      expectApplied(r);
      const patch = r.patch as AnyResult;
      expect(patch.productName).toBe("Serum");
      expect(patch.totalCop).toBe(99000);
      expect(patch[STAMP]).toBe(NOW);
      const audit = r.audit as AnyResult;
      expect(audit.action).toBe("order.imported_updated");
      expect(audit.origin).toBe("panel");
      expect(audit.actorId).toBe("admin-1");
      expect(changesOf(r)).toHaveLength(2);
      expect(changesOf(r)).toEqual(
        expect.arrayContaining([
          { field: "productName", from: "Crema", to: "Serum" },
          { field: "totalCop", from: 89000, to: 99000 }
        ])
      );
      expect((r.history as AnyResult).actor).toEqual({ kind: "user", uid: "admin-1", role: "admin" });
    });

    it("edicion del panel que cambia sku y cantidad → el historial los registra", async () => {
      const o = deliveryOrder();
      const r = await correct("panel", o, { ...panelDelivery(o), panelExtras: { sku: "CR-2", quantity: 2 } });
      expectApplied(r);
      expect(changesOf(r)).toEqual(
        expect.arrayContaining([
          { field: "sku", from: "CR-1", to: "CR-2" },
          { field: "quantity", from: 1, to: 2 }
        ])
      );
    });

    it("guardado del panel sin ningun cambio → applied con sello y evento, historial null", async () => {
      const o = deliveryOrder();
      const r = await correct("panel", o, { ...panelDelivery(o), panelExtras: { productName: "Crema", totalCop: 89000 } });
      expectApplied(r);
      expect((r.patch as AnyResult)[STAMP]).toBe(NOW);
      expect((r.audit as AnyResult).action).toBe("order.imported_updated");
      expect(r.history).toBeNull();
    });

    it("direccion cambiada en el panel → no borra derivados (conserva normalizedAddress como hoy)", async () => {
      const o = deliveryOrder({ normalizedAddress: "CL 5 10 20", lat: 3.4 });
      const r = await correct("panel", o, { ...panelDelivery(o), addressRaw: "Carrera 80 # 2-10", panelExtras: {} });
      expectApplied(r);
      expect(r.clear).toEqual([]);
      expect(r.patch).not.toHaveProperty("normalizedAddress");
    });

    it("panelExtras con normalizedAddress → va al parche tal cual", async () => {
      const o = deliveryOrder({ normalizedAddress: "CL 5 10 20" });
      const r = await correct("panel", o, { ...panelDelivery(o), panelExtras: { normalizedAddress: "KR 80 2 10" } });
      expect((r.patch as AnyResult).normalizedAddress).toBe("KR 80 2 10");
    });
  });

  describe("sello MANUAL_EDIT_STAMP", () => {
    it("presente en todo plan applied de correccion (api y panel), con la constante de order-import-merge", async () => {
      const { MANUAL_EDIT_STAMP } = await import(MERGE_MODULE);
      expect(MANUAL_EDIT_STAMP).toBe(STAMP);
      const o = deliveryOrder({ normalizedAddress: "CL 5", lat: 1 });
      const plans = [
        await correct("api", o, { customerName: "Otra" }),
        await correct("api", o, { addressRaw: "Carrera 80" }),
        await correct("api", o, { deliveryNotes: null }),
        await correct("api", deliveryOrder({ status: "address_risk" }), { customerName: "Ana Perez" }),
        await correct("api", deliveryOrder({ status: "ready_to_assign" }), { cityId: "jamundi", city: JAMUNDI }),
        await correct("panel", o, { ...panelDelivery(o), panelExtras: {} }),
        await correct("panel", o, { ...panelDelivery(o), customerName: "Otra", panelExtras: { totalCop: 1000 } })
      ];
      for (const r of plans) {
        expectApplied(r);
        expect((r.patch as AnyResult)[STAMP]).toBe(NOW);
      }
    });
  });

  describe("buildOrderHistoryRecord", () => {
    const meta = { orderId: "order-1", sellerId: SELLER, origin: "panel", action: "order.assigned", actor: ADMIN_ACTOR, now: NOW };

    async function build(before: Record<string, unknown>, after: Record<string, unknown>, m: Record<string, unknown> = meta) {
      const { buildOrderHistoryRecord } = await load();
      return buildOrderHistoryRecord(before, after, m) as AnyResult | null;
    }

    it("registra los campos registrados que cambiaron, con su forma completa", async () => {
      const r = await build(deliveryOrder(), deliveryOrder({ status: "ready_to_assign", customerName: "Ana Maria" }));
      expect(r).not.toBeNull();
      expect(r).toMatchObject({ orderId: "order-1", sellerId: SELLER, createdAt: NOW, origin: "panel", action: "order.assigned" });
      expect((r as AnyResult).actor).toEqual({ kind: "user", uid: "admin-1", role: "admin" });
      expect((r as AnyResult).changes).toHaveLength(2);
      expect((r as AnyResult).changes).toEqual(
        expect.arrayContaining([
          { field: "status", from: "imported", to: "ready_to_assign" },
          { field: "customerName", from: "Ana Perez", to: "Ana Maria" }
        ])
      );
    });

    it("nunca registra driverId, messengerId ni pickupBatchId", async () => {
      const r = await build(
        deliveryOrder({ status: "ready_to_assign" }),
        deliveryOrder({ status: "assigned", driverId: "driver-1", messengerId: "m-1", pickupBatchId: "b-1" })
      );
      const fields = ((r as AnyResult).changes as Array<{ field: string }>).map((c) => c.field);
      expect(fields).toEqual(["status"]);
      expect(JSON.stringify(r)).not.toContain("driver-1");
      expect(JSON.stringify(r)).not.toContain("m-1");
    });

    it("sin cambios en campos registrados → null (aunque cambien lider o mensajero)", async () => {
      expect(await build(deliveryOrder(), deliveryOrder())).toBeNull();
      expect(await build(deliveryOrder(), deliveryOrder({ driverId: "driver-1", messengerId: "m-1", updatedAt: "x" }))).toBeNull();
    });

    it("ausente y null son lo mismo: undefined → null no es un cambio", async () => {
      expect(await build(deliveryOrder({ deliveryNotes: undefined }), deliveryOrder({ deliveryNotes: null }))).toBeNull();
    });

    it("valores numericos de producto se registran como numero", async () => {
      const r = await build(deliveryOrder(), deliveryOrder({ totalCop: 99000, quantity: 2 }));
      expect((r as AnyResult).changes).toEqual(
        expect.arrayContaining([
          { field: "totalCop", from: 89000, to: 99000 },
          { field: "quantity", from: 1, to: 2 }
        ])
      );
    });

    it("actor api → { kind: api, keyLast4 }, sin sellerId ni uid", async () => {
      const r = await build(deliveryOrder(), deliveryOrder({ status: "cancelled" }), { ...meta, origin: "api", actor: API_ACTOR });
      expect((r as AnyResult).actor).toEqual({ kind: "api", keyLast4: "c41e" });
      expect((r as AnyResult).origin).toBe("api");
    });

    it("con auditEventId en meta lo lleva en el registro (callables de T15)", async () => {
      const r = await build(deliveryOrder(), deliveryOrder({ status: "cancelled" }), { ...meta, auditEventId: "audit-9" });
      expect((r as AnyResult).auditEventId).toBe("audit-9");
    });
  });

  describe("relacion con la reimportacion (spec 017)", () => {
    it("el pedido corregido por API, pasado por mergeImportedOrder, conserva cliente y direccion", async () => {
      const { mergeImportedOrder } = await import(MERGE_MODULE);
      const before = deliveryOrder({ normalizedAddress: "CL 5 10 20", lat: 3.4 });
      const r = await correct("api", before, { customerName: "Ana Maria", customerPhone: "3109876543", addressRaw: "Carrera 80 # 2-10" });
      expectApplied(r);
      const after: Record<string, unknown> = { ...before, ...(r.patch as AnyResult) };
      for (const key of r.clear as string[]) delete after[key];

      const merged = mergeImportedOrder({
        incoming: {
          status: "imported",
          driverId: null,
          customerName: "Nombre de Shopify",
          customerPhone: "3000000000",
          addressRaw: "Direccion de Shopify",
          normalizedAddress: "SHOPIFY",
          sellerId: SELLER
        },
        existing: after,
        now: NOW
      });
      expect(merged.phase).toBe("edited");
      for (const key of ["customerName", "customerPhone", "addressRaw", "normalizedAddress", "status", "driverId"]) {
        expect(merged.doc, key).not.toHaveProperty(key);
      }
    });
  });
});
