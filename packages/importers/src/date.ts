// SPDX-License-Identifier: AGPL-3.0-only

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const NUMERIC = /^(\d{1,4})[/. '-](\d{1,2})[/. '-](\d{1,4})$/;
const OFX_STAMP = /^(\d{4})(\d{2})(\d{2})/;

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fullYear(value: number, digits: number): number {
  if (digits === 4) return value;
  return value >= 70 ? 1900 + value : 2000 + value;
}

/**
 * Bank exports are not ISO. Supports ISO, US and European slash dates (the
 * first component above 12 disambiguates day-first) and OFX timestamps.
 */
export function parseImportDate(text: string): string | null {
  const value = text.trim();
  if (!value) return null;

  const ofx = OFX_STAMP.exec(value);
  if (ofx?.[1] && ofx[2] && ofx[3]) {
    return iso(Number(ofx[1]), Number(ofx[2]), Number(ofx[3]));
  }

  const dashed = ISO.exec(value);
  if (dashed?.[1] && dashed[2] && dashed[3]) {
    return iso(Number(dashed[1]), Number(dashed[2]), Number(dashed[3]));
  }

  const parts = NUMERIC.exec(value);
  if (!parts?.[1] || !parts[2] || !parts[3]) return null;
  const first = Number(parts[1]);
  const middle = Number(parts[2]);
  const third = Number(parts[3]);

  if (parts[1].length === 4) {
    return iso(first, middle, third);
  }
  const year = fullYear(third, parts[3].length);
  if (first > 12) return iso(year, middle, first);
  return iso(year, first, middle);
}
