/**
 * Atajos de periodo para los filtros de fecha.
 *
 * Los tres cortan en la ultima semana COMPLETA. La semana en curso todavia tiene pedidos en
 * ruta, asi que hunde el % de entrega y el % de terminacion: mezclarla con periodos ya cerrados
 * haria que las cifras no se puedan comparar entre si.
 *
 * La aritmetica va sobre un Date anclado a medianoche UTC construido con las partes LOCALES de
 * hoy. Con `new Date()` directo, un lunes a las 20:00 en Colombia (UTC-5) ya es martes en UTC y
 * el corte de semana se correria un dia.
 */

export type DateRange = { startDate: string; endDate: string };

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfLocalDayUtc(now: Date) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function shiftDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Ultima semana lunes-domingo ya cerrada. */
export function lastCompletedWeekRange(now = new Date()): DateRange {
  const today = startOfLocalDayUtc(now);
  const daysSinceMonday = (today.getUTCDay() + 6) % 7; // getUTCDay: 0 = domingo
  const thisMonday = shiftDays(today, -daysSinceMonday);
  return { startDate: isoDate(shiftDays(thisMonday, -7)), endDate: isoDate(shiftDays(thisMonday, -1)) };
}

/** Mes calendario anterior, completo. */
export function previousMonthRange(now = new Date()): DateRange {
  const today = startOfLocalDayUtc(now);
  const firstOfThisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastDayPrevMonth = shiftDays(firstOfThisMonth, -1);
  const firstDayPrevMonth = new Date(Date.UTC(lastDayPrevMonth.getUTCFullYear(), lastDayPrevMonth.getUTCMonth(), 1));
  return { startDate: isoDate(firstDayPrevMonth), endDate: isoDate(lastDayPrevMonth) };
}

/**
 * Todo el historico hasta el cierre de la semana anterior.
 * `startDate` vacio = sin limite inferior, igual que en las consultas de Firestore.
 */
export function accumulatedUntilLastWeekRange(now = new Date()): DateRange {
  return { startDate: "", endDate: lastCompletedWeekRange(now).endDate };
}

export const ORDER_RANGE_PRESETS: Array<{ id: string; label: string; hint: string; resolve: (now?: Date) => DateRange }> = [
  { id: "last-week", label: "Semana pasada", hint: "Ultima semana completa, de lunes a domingo.", resolve: lastCompletedWeekRange },
  { id: "last-month", label: "Mes pasado", hint: "Mes calendario anterior, completo.", resolve: previousMonthRange },
  { id: "accumulated", label: "Acumulado", hint: "Todo el historico hasta el cierre de la semana pasada.", resolve: accumulatedUntilLastWeekRange }
];
