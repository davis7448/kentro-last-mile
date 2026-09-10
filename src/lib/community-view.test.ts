import { describe, expect, it } from "vitest";
import { brandFor, roleLabel } from "./community-view";
import { buildPriceHistoryEntry, LOGO_MAX_BYTES, validateLogo } from "../../functions/src/community-pricing";

describe("T1 · rol de lider de comunidad", () => {
  it("RF_01: distingue al lider de comunidad del lider logistico en la etiqueta visible", () => {
    expect(roleLabel("driver")).toBe("Lider logistico");
    expect(roleLabel("community_leader")).toBe("Lider de comunidad");
    expect(roleLabel("driver")).not.toBe(roleLabel("community_leader"));
  });

  it("RF_01: etiqueta todos los roles sin devolver nunca 'lider' a secas", () => {
    const roles = ["admin", "seller", "seller_logistics", "driver", "messenger", "community_leader"] as const;
    for (const role of roles) {
      const label = roleLabel(role);
      expect(label.length).toBeGreaterThan(0);
      expect(label.trim().toLowerCase()).not.toBe("lider");
    }
  });
});

describe("T13, T15 · marca visible y logo", () => {
  it("RF_14: con logo del lider se pinta su marca", () => {
    expect(brandFor({ name: "Comunidad Andes", logoPath: "logos/com-1.png" })).toEqual({
      kind: "community",
      name: "Comunidad Andes",
      logoPath: "logos/com-1.png"
    });
  });

  it("RF_15: sin logo se pinta la marca de la plataforma, nunca un hueco", () => {
    expect(brandFor({ name: "Comunidad Andes" }).kind).toBe("platform");
    expect(brandFor({ name: "Comunidad Andes", logoPath: "  " }).kind).toBe("platform");
    expect(brandFor(undefined)).toEqual({ kind: "platform", name: "Kentro" });
  });

  it("RF_16: se rechaza el logo fuera de formato o de tamano", () => {
    expect(validateLogo({ contentType: "image/png", sizeBytes: 100_000 }).ok).toBe(true);
    expect(validateLogo({ contentType: "image/gif", sizeBytes: 100 }).ok).toBe(false);
    expect(validateLogo({ contentType: "image/png", sizeBytes: LOGO_MAX_BYTES + 1 }).ok).toBe(false);
  });
});

describe("T14 · historial de precios", () => {
  it("RF_39: registra quien, cuando, de cuanto a cuanto y desde cuando aplica", () => {
    const entry = buildPriceHistoryEntry({
      field: "sellerDeliveredFeeCop",
      fromCop: 12000,
      toCop: 15000,
      nowIso: "2026-09-01T00:00:00.000Z",
      actorUid: "uid-lider",
      actorRole: "community_leader"
    });
    expect(entry.fromCop).toBe(12000);
    expect(entry.toCop).toBe(15000);
    expect(entry.actorUid).toBe("uid-lider");
    // Es una subida: entra a los ocho dias, no al instante.
    expect(entry.effectiveAt).toBe("2026-09-09T00:00:00.000Z");
  });
});
