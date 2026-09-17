import { describe, expect, it } from "vitest";
import { accumulatedUntilLastWeekRange, lastCompletedWeekRange, previousMonthRange } from "./date-ranges";

/** Fecha local a mediodia, para que el desfase horario no mueva el dia por si solo. */
const localNoon = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12, 0, 0);

describe("lastCompletedWeekRange", () => {
  it("desde un sabado devuelve la semana lunes-domingo anterior", () => {
    // 2026-08-22 es sabado; su lunes es el 17, asi que la ultima semana cerrada es 10-16.
    expect(lastCompletedWeekRange(localNoon(2026, 8, 22))).toEqual({ startDate: "2026-08-10", endDate: "2026-08-16" });
  });

  it("un lunes ya cuenta la semana recien terminada", () => {
    expect(lastCompletedWeekRange(localNoon(2026, 8, 17))).toEqual({ startDate: "2026-08-10", endDate: "2026-08-16" });
  });

  it("un domingo NO incluye la semana en curso", () => {
    // Domingo 2026-08-16 pertenece a la semana del 10; la ultima cerrada es la del 3.
    expect(lastCompletedWeekRange(localNoon(2026, 8, 16))).toEqual({ startDate: "2026-08-03", endDate: "2026-08-09" });
  });

  it("cruza el cambio de anio", () => {
    expect(lastCompletedWeekRange(localNoon(2026, 1, 2))).toEqual({ startDate: "2025-12-22", endDate: "2025-12-28" });
  });

  it("el rango siempre son 7 dias y empieza en lunes", () => {
    for (let day = 1; day <= 28; day += 1) {
      const { startDate, endDate } = lastCompletedWeekRange(localNoon(2026, 2, day));
      expect(new Date(`${startDate}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(new Date(`${endDate}T00:00:00Z`).getUTCDay()).toBe(0);
      const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
      expect(days).toBe(6);
    }
  });

  it("no se corre un dia por la noche colombiana", () => {
    // 20:00 en Colombia (UTC-5) ya es el dia siguiente en UTC: el corte debe ser el mismo.
    const tarde = new Date(2026, 7, 22, 20, 30, 0);
    expect(lastCompletedWeekRange(tarde)).toEqual(lastCompletedWeekRange(localNoon(2026, 8, 22)));
  });
});

describe("previousMonthRange", () => {
  it("devuelve el mes calendario anterior completo", () => {
    expect(previousMonthRange(localNoon(2026, 8, 22))).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31" });
  });

  it("respeta los meses de 30 dias", () => {
    expect(previousMonthRange(localNoon(2026, 7, 5))).toEqual({ startDate: "2026-06-01", endDate: "2026-06-30" });
  });

  it("cruza el cambio de anio", () => {
    expect(previousMonthRange(localNoon(2026, 1, 15))).toEqual({ startDate: "2025-12-01", endDate: "2025-12-31" });
  });

  it("acierta febrero en anio bisiesto", () => {
    expect(previousMonthRange(localNoon(2028, 3, 10))).toEqual({ startDate: "2028-02-01", endDate: "2028-02-29" });
  });

  it("acierta febrero en anio normal", () => {
    expect(previousMonthRange(localNoon(2026, 3, 10))).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
  });

  it("funciona el dia 1 del mes", () => {
    expect(previousMonthRange(localNoon(2026, 8, 1))).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31" });
  });
});

describe("accumulatedUntilLastWeekRange", () => {
  it("no pone limite inferior y corta en el domingo pasado", () => {
    expect(accumulatedUntilLastWeekRange(localNoon(2026, 8, 22))).toEqual({ startDate: "", endDate: "2026-08-16" });
  });

  it("comparte el corte con la semana pasada", () => {
    const now = localNoon(2026, 5, 6);
    expect(accumulatedUntilLastWeekRange(now).endDate).toBe(lastCompletedWeekRange(now).endDate);
  });
});
