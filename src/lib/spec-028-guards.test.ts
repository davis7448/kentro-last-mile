/**
 * Spec 028: guardas de fuente. La aritmetica de que se guarda vive en `autosave-plan.ts`, con sus pruebas.
 * Lo que fallo en produccion fue el CABLEADO: un efecto que guardaba antes de que llegara el servidor, un
 * callback que "inicializaba" con el estado de fabrica y una linea base que se escribia entera cuando era
 * nula. Estas guardas fallan si vuelve cualquiera de los tres.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const store = read("./firebase/state-store.ts");
const app = read("../components/operations-app.tsx");

const sliceFrom = (source: string, marker: string, endMarker: string) => {
  const start = source.indexOf(marker);
  expect(start, `no se encontro ${marker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start + marker.length);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("spec 028 — saveFirestoreState", () => {
  const save = sliceFrom(store, "export async function saveFirestoreState(", "\nexport async function ");

  it("RF_01/RF_03: decide con planAutosave y no tiene camino propio para una linea base nula", () => {
    expect(save).toContain("planAutosave(lastRemoteCollections, state)");
    expect(save).toContain("if (plan.writeCount === 0) return;");
    // El fallo original: `!baseline ||` hacia que todo contara como cambiado.
    expect(save).not.toMatch(/!baseline\s*\|\|/);
    expect(save).not.toMatch(/AUTOSAVED_COLLECTIONS\.filter/);
  });

  it("RF_05: settings/global se escribe con los campos cambiados, no con settings entero", () => {
    expect(save).toContain("{ ...plan.settings, updatedAt: serverTimestamp() }");
    expect(save).not.toContain("...state.settings");
  });

  it("RF_08: cada suscripcion empieza sin linea base", () => {
    const subscribe = sliceFrom(store, "export function subscribeFirestoreState(", "const orderRef");
    expect(subscribe).toContain("resetRemoteBaseline();");
  });
});

describe("spec 028 — useAppState", () => {
  const hook = sliceFrom(app, "function useAppState(", "\nfunction ");

  it("RF_03/RF_07: una base vacia no se inicializa desde el navegador", () => {
    // Solo hay una llamada a saveFirestoreState en el hook: la del efecto de autoguardado.
    expect(hook.match(/saveFirestoreState\(/g)).toHaveLength(1);
    expect(hook).not.toContain("No se pudo inicializar el estado remoto");
  });

  it("RF_01: el autoguardado remoto espera la primera emision del servidor, no la hidratacion local", () => {
    expect(hook).toMatch(/if \(session && canUseFirestoreStore\(\)\) \{\s*remoteReady\.current = false;/);
    expect(hook).toMatch(/applyingRemote\.current = true;\s*remoteReady\.current = true;/);
    expect(hook).toMatch(/if \(session\?\.role !== "admin"\) return;\s*if \(!remoteReady\.current\) return;/);
  });
});
