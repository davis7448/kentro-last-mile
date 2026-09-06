import { describe, expect, it } from "vitest";
import { GMF_RATE, gmfForPayout, netAfterGmf } from "./finance";

describe("gmfForPayout (4x1000)", () => {
  it("es el 0,4% del monto transferido", () => {
    expect(GMF_RATE).toBe(0.004);
    expect(gmfForPayout(1_000_000)).toBe(4000);
    expect(gmfForPayout(250_000)).toBe(1000);
  });

  it("no grava a quien cobra en efectivo", () => {
    expect(gmfForPayout(1_000_000, true)).toBe(0);
    expect(netAfterGmf(1_000_000, true)).toBe(1_000_000);
  });

  it("no grava cuando no sale dinero del banco", () => {
    expect(gmfForPayout(0)).toBe(0);
    // Neto negativo: es el domiciliario quien debe entregar efectivo.
    expect(gmfForPayout(-500_000)).toBe(0);
    expect(netAfterGmf(-500_000)).toBe(-500_000);
  });

  it("redondea al peso", () => {
    expect(gmfForPayout(1234)).toBe(5);      // 4,936
    expect(gmfForPayout(1_234_567)).toBe(4938); // 4.938,268
  });

  it("el neto mas el gravamen reconstruye el bruto", () => {
    for (const bruto of [1, 999, 12_345, 7_675_440, 100_000_000]) {
      expect(netAfterGmf(bruto) + gmfForPayout(bruto)).toBe(bruto);
    }
  });

  it("aguanta valores no numericos sin inventar cobros", () => {
    expect(gmfForPayout(Number.NaN)).toBe(0);
    expect(gmfForPayout(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

/**
 * La formula vive dos veces: cliente (`src/lib/finance.ts`) y servidor (`functions/src/gmf.ts`),
 * porque functions no puede importar del cliente. Esta prueba las ata: si alguien cambia una y
 * olvida la otra, falla aqui y no en una liquidacion real.
 */
describe("las dos copias de la formula coinciden", () => {
  it("dan el mismo resultado en todo el rango util", async () => {
    const servidor = await import("../../functions/src/gmf");
    expect(servidor.GMF_RATE).toBe(GMF_RATE);
    const montos = [0, 1, 7, 999, 1234, 50_000, 1_234_567, 7_675_440, 100_000_000, -1, -500_000, Number.NaN];
    for (const monto of montos) {
      expect(servidor.gmfForPayout(monto)).toBe(gmfForPayout(monto));
      expect(servidor.gmfForPayout(monto, true)).toBe(gmfForPayout(monto, true));
    }
  });
});
