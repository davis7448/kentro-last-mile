/**
 * Spec 029 · T6 — ejecutor transaccional de las acciones de tienda (`functions/src/order-seller-actions-run.ts`).
 *
 * El planificador (`order-seller-actions.ts`, T4/T5) decide; el ejecutor abre la transaccion, lee el pedido (y la
 * ciudad y el inventario cuando toca), llama al planificador DENTRO de la transaccion y escribe: parche con
 * `merge`, `clear` con `FieldValue.delete()`, inventario, evento e historial (con sus ids). Si el plan rechaza,
 * no escribe nada en `orders`, `auditEvents` ni `orderHistory` (plan 2.2).
 *
 * Contrato que fijan estas pruebas (inyeccion, para que el modulo no importe `firebase-admin` en tiempo de
 * ejecucion — la raiz del repo no lo tiene instalado — y se pueda probar con una transaccion falsa):
 *
 *   type SellerActionRunDeps = {
 *     db: { runTransaction(fn): Promise<T>; collection(name): CollectionReference }; // Firestore en prod
 *     deleteField: () => unknown;                                                       // () => FieldValue.delete()
 *   };
 *   type RunRequest<T> = { orderId: string; policy: "panel" | "api"; actor: SellerActor; input: T; now: string };
 *   runConfirm(deps, RunRequest<ConfirmInput>)
 *   runDeliveryCorrection(deps, RunRequest<Omit<DeliveryCorrectionInput, "city">>)  // la ciudad la lee el ejecutor
 *   runCancel(deps, RunRequest<CancelInput>)
 *     → Promise<{ kind: "rejected"; rejection: SellerActionRejection }
 *              | { kind: "applied" | "unchanged"; order: Record<string, unknown> & { id: string } }>
 *
 * El inventario NO se inyecta: el ejecutor usa `readSellerInventoryIndex` + `applyInventoryMovements` (los de
 * `cancelOrder`) sobre `deps.db.collection("inventory")`, y la transaccion falsa responde esa consulta.
 *
 * La transaccion falsa imita lo que importa de Firestore: lecturas antes que escrituras (si no, lanza), escrituras
 * en buffer hasta el commit y, si un documento leido cambio entre la lectura y el commit, REINTENTA la funcion
 * entera con el estado nuevo. `beforeCommit` mete un escritor concurrente justo en esa ventana (RF_19).
 */
import { describe, expect, it } from "vitest";

const RUN_MODULE = "../../functions/src/order-seller-actions-run";
const MERGE_MODULE = "../../functions/src/order-import-merge";

async function loadRun() {
  return import(RUN_MODULE);
}

const SELLER = "seller-test";
const OTHER_SELLER = "seller-ajeno";
const NOW = "2026-10-05T15:00:00.000Z";
const LATER = "2026-10-05T15:00:05.000Z";
const STAMP = "manuallyEditedAt";

const API_ACTOR = { kind: "api", sellerId: SELLER, keyLast4: "c41e" } as const;
const ADMIN_ACTOR = { kind: "user", uid: "admin-1", role: "admin" } as const;

// ---------------------------------------------------------------------------------------------------
// Firestore falso
// ---------------------------------------------------------------------------------------------------

const DELETE_SENTINEL = Object.freeze({ __fieldValue: "delete" });

type Data = Record<string, unknown>;
type Call = {
  attempt: number;
  committed: boolean;
  op: "set" | "update" | "create" | "delete";
  collection: string;
  id: string;
  data?: Data;
  merge?: boolean;
};

type FakeRef = { id: string; path: string; collectionName: string; parent: { id: string } };
type FakeQuery = { kind: "query"; collectionName: string; filters: Array<[string, string, unknown]> };

class FakeDb {
  docs = new Map<string, { data: Data; version: number }>();
  calls: Call[] = [];
  attempts = 0;
  /** Cada gancho se consume una vez, en el primer commit que encuentra (entre lectura y commit). */
  beforeCommit: Array<() => unknown | Promise<unknown>> = [];
  private autoId = 0;

  seed(collectionName: string, id: string, data: Data) {
    this.docs.set(`${collectionName}/${id}`, { data: structuredClone(data), version: 1 });
  }

  read(collectionName: string, id: string): Data | undefined {
    const entry = this.docs.get(`${collectionName}/${id}`);
    return entry ? structuredClone(entry.data) : undefined;
  }

  all(collectionName: string): Array<Data & { __id: string }> {
    const out: Array<Data & { __id: string }> = [];
    for (const [path, entry] of this.docs) {
      const [col, id] = path.split("/");
      if (col === collectionName) out.push({ ...structuredClone(entry.data), __id: id });
    }
    return out;
  }

  /** Escritura directa de otro proceso (lider que toma el pedido, ChatBy que confirma): sube la version. */
  externalWrite(collectionName: string, id: string, patch: Data) {
    const key = `${collectionName}/${id}`;
    const entry = this.docs.get(key);
    this.docs.set(key, { data: { ...(entry?.data ?? {}), ...structuredClone(patch) }, version: (entry?.version ?? 0) + 1 });
  }

  ref(collectionName: string, id?: string): FakeRef {
    const docId = id ?? `${collectionName}-auto-${++this.autoId}`;
    return { id: docId, path: `${collectionName}/${docId}`, collectionName, parent: { id: collectionName } };
  }

  collection(name: string) {
    const make = (filters: Array<[string, string, unknown]>): FakeQuery & { where: (f: string, op: string, v: unknown) => unknown } => ({
      kind: "query",
      collectionName: name,
      filters,
      where: (f: string, op: string, v: unknown) => make([...filters, [f, op, v]])
    });
    return {
      id: name,
      doc: (id?: string) => this.ref(name, id),
      where: (f: string, op: string, v: unknown) => make([[f, op, v]])
    };
  }

  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      this.attempts += 1;
      const tx = new FakeTx(this, this.attempts);
      const result = await fn(tx);
      const hook = this.beforeCommit.shift();
      if (hook) await hook();
      if (tx.isStale()) continue; // Firestore descarta el intento y vuelve a llamar a la funcion
      tx.commit();
      return result;
    }
    throw new Error("FakeDb: demasiada contencion (5 intentos)");
  }

  version(path: string): number {
    return this.docs.get(path)?.version ?? 0;
  }
}

function applyFields(base: Data, patch: Data): Data {
  const next: Data = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === DELETE_SENTINEL) delete next[key];
    else next[key] = structuredClone(value);
  }
  return next;
}

class FakeTx {
  private reads = new Map<string, number>();
  private buffered: Array<() => void> = [];
  private myCalls: Call[] = [];

  constructor(private db: FakeDb, private attempt: number) {}

  async get(target: FakeRef | FakeQuery) {
    if (this.myCalls.length > 0) throw new Error("Firestore: las lecturas de una transaccion van antes que las escrituras");
    if ((target as FakeQuery).kind === "query") {
      const query = target as FakeQuery;
      const docs = [];
      for (const [path, entry] of this.db.docs) {
        const [col, id] = path.split("/");
        if (col !== query.collectionName) continue;
        if (!query.filters.every(([field, op, value]) => op === "==" && entry.data[field] === value)) continue;
        this.reads.set(path, entry.version);
        const ref = this.db.ref(col, id);
        const data = structuredClone(entry.data);
        docs.push({ id, ref, exists: true, data: () => structuredClone(data) });
      }
      return { docs, empty: docs.length === 0, size: docs.length };
    }
    const ref = target as FakeRef;
    const entry = this.db.docs.get(ref.path);
    this.reads.set(ref.path, entry?.version ?? 0);
    const data = entry ? structuredClone(entry.data) : undefined;
    return { id: ref.id, ref, exists: entry !== undefined, data: () => (data ? structuredClone(data) : undefined) };
  }

  private record(call: Omit<Call, "attempt" | "committed">, apply: () => void) {
    const full: Call = { ...call, attempt: this.attempt, committed: false };
    this.myCalls.push(full);
    this.db.calls.push(full);
    this.buffered.push(apply);
    return this;
  }

  set(ref: FakeRef, data: Data, options?: { merge?: boolean }) {
    const merge = options?.merge === true;
    return this.record({ op: "set", collection: ref.collectionName, id: ref.id, data: { ...data }, merge }, () => {
      const current = this.db.docs.get(ref.path);
      const base = merge ? (current?.data ?? {}) : {};
      this.db.docs.set(ref.path, { data: applyFields(base, data), version: (current?.version ?? 0) + 1 });
    });
  }

  update(ref: FakeRef, data: Data) {
    return this.record({ op: "update", collection: ref.collectionName, id: ref.id, data: { ...data } }, () => {
      const current = this.db.docs.get(ref.path);
      if (!current) throw new Error(`update sobre documento inexistente ${ref.path}`);
      this.db.docs.set(ref.path, { data: applyFields(current.data, data), version: current.version + 1 });
    });
  }

  create(ref: FakeRef, data: Data) {
    return this.record({ op: "create", collection: ref.collectionName, id: ref.id, data: { ...data } }, () => {
      if (this.db.docs.has(ref.path)) throw new Error(`create sobre documento existente ${ref.path}`);
      this.db.docs.set(ref.path, { data: applyFields({}, data), version: 1 });
    });
  }

  delete(ref: FakeRef) {
    return this.record({ op: "delete", collection: ref.collectionName, id: ref.id }, () => {
      this.db.docs.delete(ref.path);
    });
  }

  isStale(): boolean {
    for (const [path, version] of this.reads) if (this.db.version(path) !== version) return true;
    return false;
  }

  commit() {
    for (const apply of this.buffered) apply();
    for (const call of this.myCalls) call.committed = true;
  }
}

function makeDeps(db: FakeDb) {
  return { db, deleteField: () => DELETE_SENTINEL };
}

const GUARDED = ["orders", "auditEvents", "orderHistory"];

/** Toda llamada de escritura (de cualquier intento, confirmado o no) sobre las tres colecciones. */
function guardedCalls(db: FakeDb, committedOnly = false) {
  return db.calls.filter((call) => GUARDED.includes(call.collection) && (!committedOnly || call.committed));
}

function committed(db: FakeDb, collection: string) {
  return db.calls.filter((call) => call.committed && call.collection === collection);
}

// ---------------------------------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------------------------------

function baseOrder(overrides: Data = {}): Data {
  return {
    sellerId: SELLER,
    status: "imported",
    driverId: null,
    trackingCode: "KNT-000001",
    customerName: "Ana Perez",
    customerPhone: "+573001234567",
    addressRaw: "Calle 5 # 10-20",
    deliveryNotes: "Porteria",
    cityId: "cali",
    callNote: "nota previa",
    productName: "Crema",
    sku: "CR-1",
    quantity: 1,
    totalCop: 89000,
    paymentMethod: "cod",
    ...overrides
  };
}

function seededDb(orderOverrides: Data = {}) {
  const db = new FakeDb();
  db.seed("orders", "order-1", baseOrder(orderOverrides));
  db.seed("cities", "cali", { name: "Cali", active: true });
  db.seed("cities", "jamundi", { name: "Jamundi", active: true });
  db.seed("cities", "palmira", { name: "Palmira", active: false });
  return db;
}

function request(policy: "api" | "panel", input: Data, actor: unknown = policy === "api" ? API_ACTOR : ADMIN_ACTOR, now = NOW) {
  return { orderId: "order-1", policy, actor, input, now };
}

/** Lo que el panel manda hoy en cada guardado: los datos de entrega completos, tal como estan. */
function panelDeliveryOf(order: Data) {
  return {
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    addressRaw: order.addressRaw,
    deliveryNotes: order.deliveryNotes,
    cityId: order.cityId
  };
}

// ---------------------------------------------------------------------------------------------------

describe("T6 · ejecutor transaccional y carreras simuladas (RF_19, RF_04, RF_11, RF_13)", () => {
  describe("aplicar", () => {
    it("confirmar por API: el pedido queda ready_to_assign y la respuesta es el pedido despues de escribir", async () => {
      const { runConfirm } = await loadRun();
      const db = seededDb();
      const result = await runConfirm(makeDeps(db), request("api", {}));
      expect(result.kind).toBe("applied");
      expect(result.order).toMatchObject({ id: "order-1", status: "ready_to_assign", confirmedVia: "api", addressRisk: "accepted" });
      expect(db.read("orders", "order-1")).toMatchObject({ status: "ready_to_assign", confirmedVia: "api", customerName: "Ana Perez" });
    });

    it("el evento lleva su id y el historial enlaza con el (id propio + auditEventId)", async () => {
      const { runConfirm } = await loadRun();
      const db = seededDb();
      await runConfirm(makeDeps(db), request("api", {}));
      const events = db.all("auditEvents");
      const history = db.all("orderHistory");
      expect(events).toHaveLength(1);
      expect(history).toHaveLength(1);
      expect(events[0].id).toBe(events[0].__id);
      expect(events[0]).toMatchObject({ action: "order.seller_confirmed", entityId: "order-1", apiKeyLast4: "c41e" });
      expect(history[0].id).toBe(history[0].__id);
      expect(history[0].auditEventId).toBe(events[0].__id);
      expect(history[0]).toMatchObject({ orderId: "order-1", sellerId: SELLER, origin: "api" });
    });

    it("escribe en este orden: pedido (parche y clear) → evento → historial", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb({ normalizedAddress: "Calle 5 10-20, Cali", lat: 3.4, lng: -76.5, geoProvider: "mapbox" });
      const result = await runDeliveryCorrection(makeDeps(db), request("api", { addressRaw: "Carrera 80 # 12-34" }));
      expect(result.kind).toBe("applied");
      const sequence = db.calls.filter((call) => call.committed && GUARDED.includes(call.collection)).map((call) => call.collection);
      const lastOrder = sequence.lastIndexOf("orders");
      const firstEvent = sequence.indexOf("auditEvents");
      const firstHistory = sequence.indexOf("orderHistory");
      expect(lastOrder, `secuencia: ${sequence.join(" → ")}`).toBeGreaterThanOrEqual(0);
      expect(firstEvent, `secuencia: ${sequence.join(" → ")}`).toBeGreaterThan(lastOrder);
      expect(firstHistory, `secuencia: ${sequence.join(" → ")}`).toBeGreaterThan(firstEvent);
    });

    it("`clear` se borra con FieldValue.delete() y el pedido se escribe con merge (nunca un set que reemplace)", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb({ normalizedAddress: "Calle 5 10-20, Cali", lat: 3.4, lng: -76.5, geoProvider: "mapbox" });
      await runDeliveryCorrection(makeDeps(db), request("api", { addressRaw: "Carrera 80 # 12-34" }));

      const orderWrites = committed(db, "orders");
      expect(orderWrites.length).toBeGreaterThan(0);
      for (const call of orderWrites) {
        expect(call.op === "update" || (call.op === "set" && call.merge === true), `escritura ${call.op} sin merge`).toBe(true);
      }
      const deletedKeys = orderWrites.flatMap((call) => Object.entries(call.data ?? {}).filter(([, v]) => v === DELETE_SENTINEL).map(([k]) => k));
      expect(deletedKeys.sort()).toEqual(["geoProvider", "lat", "lng", "normalizedAddress"]);

      const stored = db.read("orders", "order-1") ?? {};
      expect(stored.addressRaw).toBe("Carrera 80 # 12-34");
      for (const key of ["normalizedAddress", "lat", "lng", "geoProvider"]) expect(key in stored, `${key} sigue en el pedido`).toBe(false);
      expect(stored[STAMP]).toBe(NOW);
      // Lo que no toca la correccion sigue ahi (merge, no reemplazo).
      expect(stored).toMatchObject({ customerName: "Ana Perez", productName: "Crema", totalCop: 89000, sellerId: SELLER });
    });

    it("la ciudad se lee dentro de la transaccion: una activa se aplica", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb();
      const result = await runDeliveryCorrection(makeDeps(db), request("api", { cityId: "jamundi" }));
      expect(result.kind).toBe("applied");
      expect(db.read("orders", "order-1")?.cityId).toBe("jamundi");
    });

    it("la ciudad se lee dentro de la transaccion: una desactivada → 422 out_of_coverage sin escribir", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb();
      const result = await runDeliveryCorrection(makeDeps(db), request("api", { cityId: "palmira" }));
      expect(result.kind).toBe("rejected");
      expect(result.rejection).toMatchObject({ code: "out_of_coverage", field: "cityId" });
      expect(guardedCalls(db)).toEqual([]);
    });

    it("una ciudad que no existe → 422 out_of_coverage sin escribir", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb();
      const result = await runDeliveryCorrection(makeDeps(db), request("api", { cityId: "bogota" }));
      expect(result.kind).toBe("rejected");
      expect(result.rejection).toMatchObject({ code: "out_of_coverage" });
      expect(guardedCalls(db)).toEqual([]);
    });
  });

  describe("si el plan rechaza, no se escribe nada en orders, auditEvents ni orderHistory", () => {
    const cases: Array<{ name: string; order: Data; run: "runConfirm" | "runCancel" | "runDeliveryCorrection"; input: Data; code: string }> = [
      { name: "confirmar un address_risk por API", order: { status: "address_risk" }, run: "runConfirm", input: {}, code: "address_review_pending" },
      { name: "confirmar un imported con lider por API", order: { driverId: "leader-1" }, run: "runConfirm", input: {}, code: "order_not_editable" },
      { name: "anular un in_route por API", order: { status: "in_route", driverId: "leader-1" }, run: "runCancel", input: { reason: "cliente desiste" }, code: "order_not_editable" },
      { name: "anular por API sin motivo", order: { status: "ready_to_assign" }, run: "runCancel", input: {}, code: "validation_failed" },
      { name: "corregir el pedido de otra tienda", order: { sellerId: OTHER_SELLER }, run: "runDeliveryCorrection", input: { customerName: "Otro" }, code: "order_not_found" },
      { name: "corregir con status_changed", order: { status: "ready_to_assign" }, run: "runDeliveryCorrection", input: { customerName: "Otra", expectedStatus: "imported" }, code: "status_changed" }
    ];

    it.each(cases)("$name → $code", async ({ order, run, input, code }) => {
      const mod = await loadRun();
      const db = seededDb(order);
      const before = db.read("orders", "order-1");
      const result = await mod[run](makeDeps(db), request("api", input));
      expect(result.kind).toBe("rejected");
      expect(result.rejection.code).toBe(code);
      expect(guardedCalls(db), "set/update/create/delete sobre orders, auditEvents u orderHistory").toEqual([]);
      expect(db.read("orders", "order-1")).toEqual(before);
    });

    it("pedido inexistente → order_not_found sin escribir", async () => {
      const { runConfirm } = await loadRun();
      const db = new FakeDb();
      const result = await runConfirm(makeDeps(db), request("api", {}));
      expect(result.kind).toBe("rejected");
      expect(result.rejection).toEqual({ code: "order_not_found" });
      expect(guardedCalls(db)).toEqual([]);
    });

    it("panel: el rechazo de hoy viaja tal cual (panel_precondition) y tampoco escribe", async () => {
      const { runConfirm } = await loadRun();
      const db = seededDb({ status: "ready_to_assign" });
      const result = await runConfirm(makeDeps(db), request("panel", {}));
      expect(result.kind).toBe("rejected");
      expect(result.rejection).toMatchObject({ code: "panel_precondition", httpsCode: "failed-precondition" });
      expect(guardedCalls(db)).toEqual([]);
    });
  });

  describe("sin cambios: ni pedido, ni evento, ni historial", () => {
    it("confirmar por API un ready_to_assign → unchanged con el pedido leido", async () => {
      const { runConfirm } = await loadRun();
      const db = seededDb({ status: "ready_to_assign" });
      const result = await runConfirm(makeDeps(db), request("api", { expectedStatus: "imported" }));
      expect(result.kind).toBe("unchanged");
      expect(result.order).toMatchObject({ id: "order-1", status: "ready_to_assign" });
      expect(guardedCalls(db)).toEqual([]);
    });
  });

  describe("politica panel", () => {
    it("edicion solo de producto: escribe el producto, el sello y el evento order.imported_updated", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb();
      const current = db.read("orders", "order-1") ?? {};
      const panelExtras = {
        productName: "Serum",
        sku: "SR-1",
        quantity: 2,
        lineItems: [{ productName: "Serum", sku: "SR-1", quantity: 2 }],
        totalCop: 120000
      };
      const result = await runDeliveryCorrection(makeDeps(db), request("panel", { ...panelDeliveryOf(current), panelExtras }));
      expect(result.kind).toBe("applied");
      const stored = db.read("orders", "order-1") ?? {};
      expect(stored).toMatchObject({ productName: "Serum", sku: "SR-1", quantity: 2, totalCop: 120000, status: "imported" });
      expect(stored.lineItems).toEqual([{ productName: "Serum", sku: "SR-1", quantity: 2 }]);
      expect(stored[STAMP]).toBe(NOW);
      expect(stored).toMatchObject({ customerName: "Ana Perez", addressRaw: "Calle 5 # 10-20", deliveryNotes: "Porteria" });
      const events = db.all("auditEvents");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "order.imported_updated", actorRole: "admin", origin: "panel" });
    });

    it("indicaciones en blanco desde el panel se conservan en el documento escrito", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb();
      const current = db.read("orders", "order-1") ?? {};
      const result = await runDeliveryCorrection(makeDeps(db), request("panel", { ...panelDeliveryOf(current), deliveryNotes: "" }));
      expect(result.kind).toBe("applied");
      expect(db.read("orders", "order-1")?.deliveryNotes).toBe("Porteria");
      for (const call of committed(db, "orders")) {
        expect(call.data?.deliveryNotes, "el parche del panel no debe tocar deliveryNotes").toBeUndefined();
      }
    });
  });

  describe("inventario", () => {
    function seedInventory(db: FakeDb) {
      db.seed("inventory", "inv-cr1", { sellerId: SELLER, sku: "CR-1", available: 10, reserved: 5 });
      db.seed("inventory", "inv-otro", { sellerId: OTHER_SELLER, sku: "CR-1", available: 10, reserved: 5 });
    }

    it("anular un pedido que reservo libera su reserva (plan dice release)", async () => {
      const { runCancel } = await loadRun();
      const db = seededDb({ status: "ready_to_assign", inventoryReserved: true, sku: "cr-1", quantity: 2 });
      seedInventory(db);
      const result = await runCancel(makeDeps(db), request("api", { reason: "cliente desiste" }));
      expect(result.kind).toBe("applied");
      expect(db.read("inventory", "inv-cr1")).toMatchObject({ reserved: 3, available: 10 });
      expect(db.read("inventory", "inv-otro")).toMatchObject({ reserved: 5 });
      expect(db.read("orders", "order-1")).toMatchObject({ status: "cancelled", callNote: "cliente desiste", driverId: null });
    });

    it("anular un imported (nunca reservo) no mueve inventario", async () => {
      const { runCancel } = await loadRun();
      const db = seededDb({ inventoryReserved: true, sku: "CR-1", quantity: 2 });
      seedInventory(db);
      const result = await runCancel(makeDeps(db), request("api", { reason: "cliente desiste" }));
      expect(result.kind).toBe("applied");
      expect(committed(db, "inventory")).toEqual([]);
      expect(db.read("inventory", "inv-cr1")).toMatchObject({ reserved: 5 });
    });
  });

  describe("carreras simuladas (RF_19, caso limite)", () => {
    it("(a) confirmar + confirmar (ChatBy y API): el segundo ve ready_to_assign y responde unchanged, sin segundo evento ni historial", async () => {
      const { runConfirm } = await loadRun();
      const db = seededDb();
      // Entre la lectura y el commit de la API, otro confirmador (el panel aqui, como ChatBy) confirma primero.
      db.beforeCommit.push(() => runConfirm(makeDeps(db), request("panel", {}, ADMIN_ACTOR, NOW)));
      const result = await runConfirm(makeDeps(db), request("api", { expectedStatus: "imported" }, API_ACTOR, LATER));
      expect(result.kind, JSON.stringify(result)).toBe("unchanged");
      expect(db.all("auditEvents")).toHaveLength(1);
      expect(db.all("orderHistory")).toHaveLength(1);
      expect(db.read("orders", "order-1")).toMatchObject({ status: "ready_to_assign", confirmedVia: "manual" });
      expect(db.attempts, "la API tuvo que reintentar").toBeGreaterThanOrEqual(3);
    });

    it("(b) un lider toma el pedido entre la lectura y el commit de una correccion → 409 order_not_editable sin aplicar nada", async () => {
      const { runDeliveryCorrection } = await loadRun();
      const db = seededDb({ status: "ready_to_assign" });
      db.beforeCommit.push(() => db.externalWrite("orders", "order-1", { driverId: "leader-1" }));
      const result = await runDeliveryCorrection(makeDeps(db), request("api", { customerName: "Nombre Nuevo", addressRaw: "Carrera 80 # 12-34" }));
      expect(result.kind).toBe("rejected");
      expect(result.rejection).toMatchObject({ code: "order_not_editable", hasLeader: true });
      expect(guardedCalls(db, true)).toEqual([]);
      const stored = db.read("orders", "order-1") ?? {};
      expect(stored).toMatchObject({ customerName: "Ana Perez", addressRaw: "Calle 5 # 10-20", driverId: "leader-1" });
      expect(STAMP in stored).toBe(false);
      expect(db.all("auditEvents")).toEqual([]);
      expect(db.all("orderHistory")).toEqual([]);
    });

    it("(c) anular + anular: el segundo responde unchanged", async () => {
      const { runCancel } = await loadRun();
      const db = seededDb({ status: "ready_to_assign" });
      db.beforeCommit.push(() => runCancel(makeDeps(db), request("api", { reason: "primero" }, API_ACTOR, NOW)));
      const result = await runCancel(makeDeps(db), request("api", { reason: "segundo", expectedStatus: "ready_to_assign" }, API_ACTOR, LATER));
      expect(result.kind, JSON.stringify(result)).toBe("unchanged");
      expect(db.all("auditEvents")).toHaveLength(1);
      expect(db.all("orderHistory")).toHaveLength(1);
      expect(db.read("orders", "order-1")).toMatchObject({ status: "cancelled", callNote: "primero", closedAt: NOW });
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// T6b: `panelExtras` como funcion del pedido leido DENTRO de la transaccion
//
// Contrato (ampliado el 2026-10-05): `runDeliveryCorrection` acepta en `input.panelExtras` un objeto (como en
// T6) o una funcion `(order: OrderView) => PanelEditExtras`. Si es funcion, el ejecutor la llama con el pedido
// que acaba de leer con `transaction.get` (el mismo `{ ...data, id }` que ve el planificador) y pasa lo que
// devuelve al planificador como `panelExtras`. Como la llamada esta dentro de la funcion de la transaccion, un
// reintento la vuelve a evaluar con el documento nuevo: `updateImportedOrder` resuelve las lineas con
// `resolveEditedOrderLines(input, current)` y `current` tiene que ser el pedido que se va a pisar, no una
// lectura previa. Con politica api, `panelExtras` (objeto o funcion) sigue siendo un error de programacion.
// ---------------------------------------------------------------------------------------------------

describe("T6b · panelExtras como funcion del pedido leido", () => {
  const LINES_FIRST = [{ productName: "Crema", sku: "CR-1", quantity: 1 }];
  const LINES_REIMPORTED = [
    { productName: "Crema", sku: "CR-1", quantity: 1 },
    { productName: "Serum", sku: "SR-1", quantity: 3 }
  ];

  /** Lo que haria `resolveEditedOrderLines`: derivar el producto de las lineas DEL PEDIDO que recibe. */
  function extrasFromOrder(order: Data) {
    const lines = (order.lineItems as Array<{ productName: string; sku: string; quantity: number }>) ?? [];
    return {
      lineItems: lines.map((line) => ({ ...line, quantity: line.quantity * 2 })),
      productName: lines.map((line) => line.productName).join(" + "),
      quantity: lines.reduce((sum, line) => sum + line.quantity * 2, 0)
    };
  }

  it("la funcion recibe el pedido leido en la transaccion y su resultado se escribe como panelExtras", async () => {
    const { runDeliveryCorrection } = await loadRun();
    const db = seededDb({ lineItems: LINES_FIRST });
    const current = db.read("orders", "order-1") ?? {};
    const seen: Data[] = [];
    const panelExtras = (order: Data) => {
      seen.push(structuredClone(order));
      return extrasFromOrder(order);
    };
    const result = await runDeliveryCorrection(makeDeps(db), request("panel", { ...panelDeliveryOf(current), panelExtras }));
    expect(result.kind, JSON.stringify(result)).toBe("applied");
    expect(seen, "la funcion debe llamarse una vez, con el pedido leido").toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "order-1", sellerId: SELLER, status: "imported", lineItems: LINES_FIRST });
    const stored = db.read("orders", "order-1") ?? {};
    expect(stored.lineItems).toEqual([{ productName: "Crema", sku: "CR-1", quantity: 2 }]);
    expect(stored).toMatchObject({ productName: "Crema", quantity: 2, [STAMP]: NOW });
    expect(db.all("auditEvents")).toHaveLength(1);
    expect(db.all("auditEvents")[0]).toMatchObject({ action: "order.imported_updated" });
  });

  it("carrera: una reimportacion cambia lineItems antes del commit → el reintento llama la funcion con el documento nuevo y escribe lo de ese documento", async () => {
    const { runDeliveryCorrection } = await loadRun();
    const db = seededDb({ lineItems: LINES_FIRST });
    const current = db.read("orders", "order-1") ?? {};
    const seen: Data[] = [];
    const panelExtras = (order: Data) => {
      seen.push(structuredClone(order));
      return extrasFromOrder(order);
    };
    // Entre la lectura y el commit, la tienda reimporta el pedido con otra linea (sigue imported, sin lider).
    db.beforeCommit.push(() => db.externalWrite("orders", "order-1", { lineItems: LINES_REIMPORTED }));
    const result = await runDeliveryCorrection(makeDeps(db), request("panel", { ...panelDeliveryOf(current), panelExtras }));
    expect(result.kind, JSON.stringify(result)).toBe("applied");
    expect(db.attempts, "la transaccion tuvo que reintentar").toBeGreaterThanOrEqual(2);
    expect(seen.length, "la funcion se evalua en cada intento").toBeGreaterThanOrEqual(2);
    expect(seen[0].lineItems).toEqual(LINES_FIRST);
    expect(seen[seen.length - 1].lineItems, "el ultimo intento ve la reimportacion").toEqual(LINES_REIMPORTED);
    const stored = db.read("orders", "order-1") ?? {};
    expect(stored.lineItems, "se escribe lo derivado del documento nuevo, no lo del primer intento").toEqual([
      { productName: "Crema", sku: "CR-1", quantity: 2 },
      { productName: "Serum", sku: "SR-1", quantity: 6 }
    ]);
    expect(stored).toMatchObject({ productName: "Crema + Serum", quantity: 8 });
    expect(db.all("auditEvents"), "un solo evento: el intento descartado no deja rastro").toHaveLength(1);
  });

  it("politica api con panelExtras como objeto → rechaza sin escribir (como hoy)", async () => {
    const { runDeliveryCorrection } = await loadRun();
    const db = seededDb();
    await expect(
      runDeliveryCorrection(makeDeps(db), request("api", { customerName: "Otro", panelExtras: { totalCop: 1 } }))
    ).rejects.toThrow(/panelExtras/);
    expect(guardedCalls(db, true)).toEqual([]);
  });

  it("politica api con panelExtras como funcion → rechaza sin escribir (como hoy)", async () => {
    const { runDeliveryCorrection } = await loadRun();
    const db = seededDb();
    const panelExtras = () => ({ totalCop: 1 });
    await expect(
      runDeliveryCorrection(makeDeps(db), request("api", { customerName: "Otro", panelExtras }))
    ).rejects.toThrow(/panelExtras/);
    expect(guardedCalls(db, true)).toEqual([]);
    expect(db.read("orders", "order-1")?.totalCop).toBe(89000);
  });
});

// ---------------------------------------------------------------------------------------------------
// RF_11: la ciudad corregida sobrevive a una reimportacion (cityId en el grupo `customer` de FIELD_GROUPS)
// ---------------------------------------------------------------------------------------------------

describe("T6 · una reimportacion conserva el cityId corregido (RF_11, spec 017)", () => {
  const IMPORT_NOW = "2026-10-06T10:00:00.000Z";

  function incoming(overrides: Data = {}): Data {
    return {
      id: "order-1",
      trackingCode: "KNT-000001",
      shopifyOrderId: "#1001",
      sellerId: SELLER,
      cityId: "city-cali",
      driverId: null,
      customerName: "Ana Perez",
      customerPhone: "+573001234567",
      addressRaw: "Calle 5 # 10-20",
      totalCop: 89000,
      status: "imported",
      addressRisk: "review",
      source: "shopify",
      ...overrides
    };
  }

  async function merge(existing: Data) {
    const { mergeImportedOrder } = await import(MERGE_MODULE);
    return mergeImportedOrder({ incoming: incoming(), existing, now: IMPORT_NOW });
  }

  it("pedido sellado (editado) sin confirmar: no se reescribe cityId y se reporta en `customer`", async () => {
    const merged = await merge({ status: "imported", cityId: "jamundi", [STAMP]: NOW });
    expect("cityId" in merged.doc, `cityId reescrito a ${String(merged.doc.cityId)}`).toBe(false);
    expect(merged.preserved).toContain("customer");
  });

  it("pedido abierto (ready_to_assign): se conserva cityId", async () => {
    const merged = await merge({ status: "ready_to_assign", cityId: "jamundi" });
    expect("cityId" in merged.doc).toBe(false);
  });

  it("pedido cerrado: se conserva cityId", async () => {
    const merged = await merge({ status: "delivered", cityId: "jamundi" });
    expect("cityId" in merged.doc).toBe(false);
  });

  it("sin confirmar y sin editar: manda la tienda (pass)", async () => {
    const merged = await merge({ status: "imported", cityId: "jamundi" });
    expect(merged.doc.cityId).toBe("city-cali");
  });

  it("de punta a punta: corregida por API con el ejecutor, la reimportacion no la revierte", async () => {
    const { runDeliveryCorrection } = await loadRun();
    const { mergeImportedOrder, existingFactsFrom } = await import(MERGE_MODULE);
    const db = seededDb();
    const result = await runDeliveryCorrection(makeDeps(db), request("api", { cityId: "jamundi" }));
    expect(result.kind).toBe("applied");
    const stored = db.read("orders", "order-1");
    const merged = mergeImportedOrder({
      incoming: incoming(),
      existing: existingFactsFrom({ exists: true, data: () => stored }),
      now: IMPORT_NOW
    });
    expect("cityId" in merged.doc).toBe(false);
  });
});
