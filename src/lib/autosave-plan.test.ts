import { describe, expect, it } from "vitest";
import { AUTOSAVED_COLLECTIONS, planAutosave, type AutosaveBaseline } from "./autosave-plan";
import { emptyState } from "./seed";

/** Lo que tenia produccion el 2026-11-10: tres tarifas distintas de las de fabrica. */
function remote(): AutosaveBaseline {
  const base = emptyState();
  const picked = Object.fromEntries(AUTOSAVED_COLLECTIONS.map((name) => [name, base[name]])) as unknown as AutosaveBaseline;
  return {
    ...picked,
    cities: [{ id: "city-cali", name: "Cali", active: true }, { id: "city-bog", name: "Bogota", active: false }],
    zones: [
      { id: "zone-north", name: "Norte Cali", driverDeliveredPayCop: 8000 },
      { id: "zone-south", name: "Sur Cali", driverDeliveredPayCop: 8000 }
    ] as unknown as AutosaveBaseline["zones"],
    settings: { ...base.settings, driverDeliveredPayCop: 8000, driverFailedPayCop: 8000, sellerFailedFeeCop: 9000 }
  };
}

/** Lo que hace `withoutLegacyDemo` con cada emision: mismas listas, `settings` como objeto nuevo. */
const asEmitted = (state: AutosaveBaseline): AutosaveBaseline => ({ ...state, settings: { ...emptyState().settings, ...state.settings } });

describe("spec 028 — planAutosave", () => {
  it("RF_01/RF_03: sin linea base del servidor no escribe nada, ni siquiera el estado de fabrica", () => {
    const factory = emptyState();
    const plan = planAutosave(null, factory);
    expect(plan.writeCount).toBe(0);
    expect(plan.settings).toBeNull();
    expect(plan.entities).toEqual([]);
  });

  it("RF_07/RF_08: sin linea base tampoco escribe un estado con cambios", () => {
    const changed = { ...remote(), settings: { ...remote().settings, driverDeliveredPayCop: 7000 } };
    expect(planAutosave(null, changed).writeCount).toBe(0);
  });

  it("RF_02/RF_04: la emision del servidor rehecha como objeto nuevo no cuenta como cambio", () => {
    const baseline = remote();
    const state = asEmitted(baseline);
    expect(state.settings).not.toBe(baseline.settings);
    expect(planAutosave(baseline, state).writeCount).toBe(0);
  });

  it("RF_04: un cambio local ajeno a los ajustes (activeRole) no reescribe settings/global", () => {
    const baseline = remote();
    const state = { ...asEmitted(baseline), activeRole: "admin" } as AutosaveBaseline;
    expect(planAutosave(baseline, state).settings).toBeNull();
  });

  it("RF_04: updatedAt del servidor no es un ajuste", () => {
    const baseline = { ...remote(), settings: { ...remote().settings, updatedAt: { seconds: 1 } } } as unknown as AutosaveBaseline;
    const state = { ...baseline, settings: { ...baseline.settings, updatedAt: { seconds: 2 } } } as unknown as AutosaveBaseline;
    expect(planAutosave(baseline, state).writeCount).toBe(0);
  });

  it("RF_05: cambiar una tarifa escribe solo ese campo", () => {
    const baseline = remote();
    const state = { ...baseline, settings: { ...baseline.settings, driverDeliveredPayCop: 8500 } };
    const plan = planAutosave(baseline, state);
    expect(plan.settings).toEqual({ driverDeliveredPayCop: 8500 });
    expect(plan.writeCount).toBe(1);
  });

  it("RF_05: un campo que falta en el documento no se rellena con el valor de fabrica", () => {
    // La linea base trae el relleno de fabrica (`{...base.settings, ...doc}`) igual que el estado: no hay diferencia.
    const baseline = asEmitted(remote());
    const state = asEmitted(baseline);
    expect(planAutosave(baseline, state).settings).toBeNull();
  });

  it("RF_05: los dias de pago se comparan por contenido", () => {
    const baseline = remote();
    const same = { ...baseline, settings: { ...baseline.settings, payoutDays: [...baseline.settings.payoutDays] } };
    expect(planAutosave(baseline, same).settings).toBeNull();
    const changed = { ...baseline, settings: { ...baseline.settings, payoutDays: ["Lunes"] } };
    expect(planAutosave(baseline, changed).settings).toEqual({ payoutDays: ["Lunes"] });
  });

  it("RF_06: editar una zona escribe solo esa zona, no las demas con lo que habia en memoria", () => {
    const baseline = remote();
    const zones = baseline.zones.map((zone) => (zone.id === "zone-south" ? { ...zone, name: "Sur" } : zone));
    const plan = planAutosave(baseline, { ...baseline, zones });
    expect(plan.entities).toEqual([{ collection: "zones", items: [{ ...baseline.zones[1], name: "Sur" }] }]);
    expect(plan.writeCount).toBe(1);
  });

  it("RF_06: una entidad nueva se escribe", () => {
    const baseline = remote();
    const cities = [...baseline.cities, { id: "city-med", name: "Medellin", active: true }];
    const plan = planAutosave(baseline, { ...baseline, cities });
    expect(plan.entities).toEqual([{ collection: "cities", items: [{ id: "city-med", name: "Medellin", active: true }] }]);
  });

  it("RF_06: una lista nueva con las mismas entidades no escribe nada", () => {
    const baseline = remote();
    expect(planAutosave(baseline, { ...baseline, zones: [...baseline.zones] }).writeCount).toBe(0);
  });
});
