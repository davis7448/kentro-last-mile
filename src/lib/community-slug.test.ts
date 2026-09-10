import { describe, expect, it } from "vitest";
import { RETIRED_SLUG_GRACE_DAYS, isRetiredSlugStillValid, normalizeSlug, validateSlug } from "../../functions/src/community-slug";

const day = 24 * 60 * 60 * 1000;
const at = (base: string, days: number) => new Date(Date.parse(base) + days * day).toISOString();

describe("T2 · nombre corto del enlace", () => {
  it("RF_02: normaliza a minusculas, sin acentos y con guiones", () => {
    expect(normalizeSlug("  Comunidad Ñandú  ")).toBe("comunidad-nandu");
    expect(normalizeSlug("Los Andes 2026")).toBe("los-andes-2026");
    expect(normalizeSlug("a---b")).toBe("a-b");
  });

  it("RF_04: rechaza slugs reservados", () => {
    for (const reserved of ["admin", "api", "registro", "login"]) {
      expect(validateSlug(reserved).ok).toBe(false);
    }
  });

  it("RF_04: rechaza los que quedan fuera de forma o longitud", () => {
    expect(validateSlug("ab").ok).toBe(false);
    expect(validateSlug("a".repeat(33)).ok).toBe(false);
    expect(validateSlug("").ok).toBe(false);
    expect(validateSlug("///").ok).toBe(false);
    expect(validateSlug("--").ok).toBe(false);
  });

  it("RF_02: el espacio y el guion inicial se normalizan, no se rechazan", () => {
    // Rechazarlos seria hostil: el lider escribe el nombre de su comunidad, no una URL.
    expect(validateSlug("con espacio")).toEqual({ ok: true, slug: "con-espacio" });
    expect(validateSlug("-empieza-con-guion")).toEqual({ ok: true, slug: "empieza-con-guion" });
  });

  it("RF_02: acepta un slug valido y devuelve el normalizado", () => {
    const result = validateSlug("Mi Comunidad");
    expect(result.ok).toBe(true);
    expect(result.ok && result.slug).toBe("mi-comunidad");
  });

  it("RF_03: un slug retirado sigue valido 30 dias y deja de serlo despues", () => {
    const retiredAt = "2026-09-01T00:00:00.000Z";
    expect(RETIRED_SLUG_GRACE_DAYS).toBe(30);
    expect(isRetiredSlugStillValid(retiredAt, at(retiredAt, 29))).toBe(true);
    expect(isRetiredSlugStillValid(retiredAt, at(retiredAt, 31))).toBe(false);
  });

  it("RF_03: un slug vigente (sin fecha de retirada) siempre vale", () => {
    expect(isRetiredSlugStillValid(undefined, "2030-01-01T00:00:00.000Z")).toBe(true);
  });
});
