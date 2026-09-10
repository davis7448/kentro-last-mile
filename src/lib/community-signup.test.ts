import { describe, expect, it } from "vitest";
import {
  MASS_SIGNUP_ALERT_THRESHOLD,
  MASS_SIGNUP_WINDOW_MINUTES,
  parseSignupInput,
  resolveSignupSlug,
  shouldRaiseMassSignupAlert,
  signupRollbackPlan
} from "../../functions/src/community-signup-validate";

const NOW = "2026-09-10T12:00:00.000Z";
const minutesBefore = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

const valido = {
  email: "  Tienda@Ejemplo.CO ",
  password: "secreta123",
  responsibleName: "  Ana Ruiz ",
  phone: "300 123 4567",
  storeName: "  Mi Tienda  "
};

describe("T11 · validacion del registro por enlace", () => {
  it("RF_43: acepta exactamente los cinco campos, normalizados", () => {
    const parsed = parseSignupInput(valido);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.email).toBe("tienda@ejemplo.co");
    expect(parsed.value.responsibleName).toBe("Ana Ruiz");
    expect(parsed.value.storeName).toBe("Mi Tienda");
    expect(parsed.value.phone).toBe("3001234567");
    expect(Object.keys(parsed.value).sort()).toEqual(
      ["email", "password", "phone", "responsibleName", "storeName"].sort()
    );
  });

  it("RF_43: descarta cualquier campo de mas en vez de guardarlo", () => {
    const parsed = parseSignupInput({ ...valido, cityId: "cali", role: "admin" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty("cityId");
    expect(parsed.value).not.toHaveProperty("role");
  });

  it("RF_43: rechaza correo invalido, contrasena corta, telefono o nombres vacios", () => {
    expect(parseSignupInput({ ...valido, email: "no-es-correo" }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, password: "123" }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, phone: "  " }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, storeName: "" }).ok).toBe(false);
    expect(parseSignupInput({ ...valido, responsibleName: "" }).ok).toBe(false);
  });

  it("RF_09: un enlace inexistente, revocado o de lider desactivado no admite alta", () => {
    expect(resolveSignupSlug(undefined, NOW).ok).toBe(false);
    expect(resolveSignupSlug({ community: { id: "c", status: "active", linkStatus: "revoked" } }, NOW).ok).toBe(false);
    expect(resolveSignupSlug({ community: { id: "c", status: "disabled", linkStatus: "active" } }, NOW).ok).toBe(false);
  });

  it("RF_03, RF_09: un slug retirado sirve dentro de los 30 dias y no despues", () => {
    const community = { id: "c", status: "active", linkStatus: "active" };
    const hace10 = new Date(Date.parse(NOW) - 10 * 86400_000).toISOString();
    const hace40 = new Date(Date.parse(NOW) - 40 * 86400_000).toISOString();
    expect(resolveSignupSlug({ community, retiredAt: hace10 }, NOW).ok).toBe(true);
    expect(resolveSignupSlug({ community, retiredAt: hace40 }, NOW).ok).toBe(false);
  });

  it("RF_45: si falla un paso posterior, hay que borrar el usuario creado", () => {
    expect(signupRollbackPlan({ authUserCreated: true, sellerWritten: false })).toEqual({
      deleteAuthUser: true,
      reason: "La tienda no se pudo crear: se borra el acceso para que el correo quede libre."
    });
    expect(signupRollbackPlan({ authUserCreated: true, sellerWritten: true }).deleteAuthUser).toBe(false);
    expect(signupRollbackPlan({ authUserCreated: false, sellerWritten: false }).deleteAuthUser).toBe(false);
  });

  it("RF_13: se avisa al superar diez altas en una hora deslizante, sin bloquear", () => {
    expect(MASS_SIGNUP_ALERT_THRESHOLD).toBe(10);
    expect(MASS_SIGNUP_WINDOW_MINUTES).toBe(60);
    const dentro = Array.from({ length: 10 }, (_, i) => minutesBefore(i * 5));
    expect(shouldRaiseMassSignupAlert(dentro, NOW)).toBe(true);
    expect(shouldRaiseMassSignupAlert(dentro.slice(0, 9), NOW)).toBe(false);
  });

  it("RF_13: las altas viejas no cuentan para el aviso", () => {
    const viejas = Array.from({ length: 20 }, (_, i) => minutesBefore(61 + i));
    expect(shouldRaiseMassSignupAlert(viejas, NOW)).toBe(false);
  });
});
