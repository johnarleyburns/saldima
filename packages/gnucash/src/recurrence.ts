// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure recurrence math for scheduled transactions, matching desktop
 * GnuCash's own `Recurrence` engine (`libgnucash/engine/Recurrence.c`):
 * a period type, a multiplier ("every N periods"), a start date that
 * also fixes the recurrence's phase (which day of the week/month it
 * falls on), and an optional weekend adjustment. All dates are plain
 * `YYYY-MM-DD` strings -- never a `Date` object, consistent with the
 * rest of this package and the repo's AST gate.
 */

export type PeriodType =
  | "once"
  | "day"
  | "week"
  | "month"
  | "end_of_month"
  | "nth_weekday"
  | "last_weekday"
  | "year";

export type WeekendAdjust = "none" | "back" | "forward";

export interface Recurrence {
  readonly periodType: PeriodType;
  /** "Every N periods". Must be at least 1. */
  readonly multiplier: number;
  /** `YYYY-MM-DD`. Also fixes the recurrence's phase (weekday, day-of-month). */
  readonly start: string;
  readonly weekendAdjust: WeekendAdjust;
}

interface DateParts {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

function parseIso(date: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`invalid date: ${date}`);
  const [, y, m, d] = match;
  return { y: Number(y), m: Number(m), d: Number(d) };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatIso(parts: DateParts): string {
  return `${parts.y.toString().padStart(4, "0")}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return days[month - 1] ?? 30;
}

/** Howard Hinnant's `days_from_civil`: days since 1970-01-01, proleptic Gregorian. */
function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor((year >= 0 ? year : year - 399) / 400);
  const yoe = year - era * 400;
  const monthIndex = m + (m > 2 ? -3 : 9);
  const doy = Math.floor((153 * monthIndex + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of `daysFromCivil`. */
function civilFromDays(daysSinceEpoch: number): DateParts {
  const z = daysSinceEpoch + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** `0` Sunday .. `6` Saturday. */
function dayOfWeek(parts: DateParts): number {
  const z = daysFromCivil(parts.y, parts.m, parts.d);
  return (((z + 4) % 7) + 7) % 7;
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

function addCalendarMonths(
  parts: DateParts,
  deltaMonths: number,
): { y: number; m: number } {
  const totalIndex = parts.y * 12 + (parts.m - 1) + deltaMonths;
  const y = Math.floor(totalIndex / 12);
  const m = totalIndex - y * 12 + 1;
  return { y, m };
}

/** The `n`th occurrence of `weekday` in `year`-`month`, clamped to the last if `n` doesn't exist. */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): number {
  const firstWeekday = dayOfWeek({ y: year, m: month, d: 1 });
  const firstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  const candidate = firstOccurrence + (n - 1) * 7;
  if (candidate <= daysInMonth(year, month)) return candidate;
  return lastWeekdayOfMonth(year, month, weekday);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDay = daysInMonth(year, month);
  const lastDayWeekday = dayOfWeek({ y: year, m: month, d: lastDay });
  return lastDay - ((lastDayWeekday - weekday + 7) % 7);
}

function resolveDay(
  periodType: PeriodType,
  start: DateParts,
  year: number,
  month: number,
): number {
  switch (periodType) {
    case "end_of_month":
      return daysInMonth(year, month);
    case "nth_weekday": {
      const weekday = dayOfWeek(start);
      const occurrence = Math.floor((start.d - 1) / 7) + 1;
      return nthWeekdayOfMonth(year, month, weekday, occurrence);
    }
    case "last_weekday":
      return lastWeekdayOfMonth(year, month, dayOfWeek(start));
    default:
      return Math.min(start.d, daysInMonth(year, month));
  }
}

/** Adds (or, with a negative count, subtracts) whole days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const parts = parseIso(date);
  return formatIso(civilFromDays(daysFromCivil(parts.y, parts.m, parts.d) + days));
}

/** Absolute number of days between two `YYYY-MM-DD` dates, order-independent. */
export function daysBetween(a: string, b: string): number {
  const left = parseIso(a);
  const right = parseIso(b);
  const leftDays = daysFromCivil(left.y, left.m, left.d);
  const rightDays = daysFromCivil(right.y, right.m, right.d);
  return Math.abs(rightDays - leftDays);
}

function applyWeekendAdjust(parts: DateParts, adjust: WeekendAdjust): DateParts {
  if (adjust === "none") return parts;
  const weekday = dayOfWeek(parts);
  if (!isWeekend(weekday)) return parts;
  const shift = adjust === "back" ? (weekday === 0 ? -2 : -1) : weekday === 6 ? 2 : 1;
  return civilFromDays(daysFromCivil(parts.y, parts.m, parts.d) + shift);
}

const MONTH_BASED: ReadonlySet<PeriodType> = new Set([
  "month",
  "end_of_month",
  "nth_weekday",
  "last_weekday",
  "year",
]);

/**
 * The earliest date strictly after `refDate`, on or after the
 * recurrence's `start`, that is an integral number of periods from
 * `start` -- matching desktop GnuCash's own `recurrenceNextInstance`.
 * `null` only for `"once"`, once it has already fired.
 */
export function nextInstance(recurrence: Recurrence, refDate: string): string | null {
  if (recurrence.multiplier < 1) {
    throw new RangeError("recurrence multiplier must be at least 1");
  }
  const start = parseIso(recurrence.start);
  const ref = parseIso(refDate);

  if (recurrence.periodType === "once") {
    return formatIso(ref) < formatIso(start) ? formatIso(start) : null;
  }

  if (!MONTH_BASED.has(recurrence.periodType)) {
    const periodDays =
      recurrence.periodType === "week"
        ? recurrence.multiplier * 7
        : recurrence.multiplier;
    const startDays = daysFromCivil(start.y, start.m, start.d);
    const refDays = daysFromCivil(ref.y, ref.m, ref.d);
    const diff = refDays - startDays;
    const k = diff < 0 ? 0 : Math.floor(diff / periodDays) + 1;
    const candidate = civilFromDays(startDays + k * periodDays);
    return formatIso(applyWeekendAdjust(candidate, recurrence.weekendAdjust));
  }

  const monthMultiplier =
    recurrence.periodType === "year"
      ? recurrence.multiplier * 12
      : recurrence.multiplier;
  const monthsDiff = ref.y * 12 + (ref.m - 1) - (start.y * 12 + (start.m - 1));
  const estimate = Math.floor(monthsDiff / monthMultiplier);
  let k = Math.max(0, estimate - 2);
  const refIso = formatIso(ref);
  // A handful of steps past the estimate always finds the crossing point;
  // the cap only guards against a pathological input, never real use.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const { y, m } = addCalendarMonths(start, k * monthMultiplier);
    const day = resolveDay(recurrence.periodType, start, y, m);
    const candidate = { y, m, d: day };
    if (formatIso(candidate) > refIso) {
      return formatIso(applyWeekendAdjust(candidate, recurrence.weekendAdjust));
    }
    k += 1;
  }
  throw new RangeError("could not find a next recurrence instance");
}
