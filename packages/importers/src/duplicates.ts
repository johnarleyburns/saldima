// SPDX-License-Identifier: AGPL-3.0-only

import { equalsMoney, type Money } from "@saldima/gnucash";

export interface ExistingEntry {
  readonly date: string;
  readonly amount: Money;
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** Days since 1970-01-01 without a Date object, so tests stay deterministic. */
export function dayOrdinal(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  let year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  year -= month <= 2 ? 1 : 0;
  const era = Math.trunc(year / 400);
  const yearOfEra = year - era * 400;
  const monthIndex = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.trunc((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.trunc(yearOfEra / 4) -
    Math.trunc(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * The same purchase entered twice usually has different GUIDs but the same
 * account, amount and a date within three days.
 */
export function isLikelyDuplicate(
  candidate: { readonly date: string; readonly amount: Money },
  existing: readonly ExistingEntry[],
  windowDays = 3,
): boolean {
  const candidateDay = dayOrdinal(candidate.date);
  if (candidateDay === null) return false;
  return existing.some((entry) => {
    if (!equalsMoney(candidate.amount, entry.amount)) return false;
    const entryDay = dayOrdinal(entry.date);
    return entryDay !== null && Math.abs(candidateDay - entryDay) <= windowDays;
  });
}
