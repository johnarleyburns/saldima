// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GnuCash money: an exact rational held as a bigint numerator/denominator pair.
 * A JavaScript `number` never touches an amount; the AST gate enforces it.
 */
export interface Money {
  readonly num: bigint;
  readonly denom: bigint;
}

export function money(num: bigint, denom: bigint = 1n): Money {
  if (denom <= 0n) throw new RangeError("denominator must be positive");
  return { num, denom };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let left = abs(a);
  let right = abs(b);
  while (right !== 0n) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left === 0n ? 1n : left;
}

/** Lowest terms with a positive denominator. Zero becomes 0/1. */
export function normalizeMoney(value: Money): Money {
  if (value.num === 0n) return { num: 0n, denom: 1n };
  const divisor = gcd(value.num, value.denom);
  const sign = value.denom < 0n ? -1n : 1n;
  return {
    num: (value.num / divisor) * sign,
    denom: abs(value.denom / divisor),
  };
}

export function equalsMoney(a: Money, b: Money): boolean {
  if (a.num === 0n && b.num === 0n) return true;
  return a.num * b.denom === b.num * a.denom;
}

export function negateMoney(value: Money): Money {
  return { num: -value.num, denom: value.denom };
}

export function addMoney(a: Money, b: Money): Money {
  return normalizeMoney({
    num: a.num * b.denom + b.num * a.denom,
    denom: a.denom * b.denom,
  });
}

export function subtractMoney(a: Money, b: Money): Money {
  return addMoney(a, negateMoney(b));
}

export function multiplyMoney(a: Money, b: Money): Money {
  return normalizeMoney({ num: a.num * b.num, denom: a.denom * b.denom });
}

export function multiplyInt(value: Money, factor: bigint): Money {
  return normalizeMoney({ num: value.num * factor, denom: value.denom });
}

/**
 * Round to a denominator (a commodity fraction, e.g. 100 for cents) using
 * round-half-to-even, matching GnuCash's currency rounding.
 */
export function roundToFraction(value: Money, fraction: bigint): Money {
  if (fraction <= 0n) throw new RangeError("fraction must be positive");
  const scaled = value.num * fraction;
  const quotient = scaled / value.denom;
  const remainder = scaled % value.denom;
  const twiceRemainder = abs(remainder) * 2n;
  const sign = remainder < 0n ? -1n : 1n;

  let rounded = quotient;
  if (twiceRemainder > value.denom) {
    rounded += sign;
  } else if (twiceRemainder === value.denom && quotient % 2n !== 0n) {
    rounded += sign;
  }
  return { num: rounded, denom: fraction };
}

/**
 * GnuCash posting normalisation: round half away from zero (half-up).
 * Use this for split value/amount normalisation; `roundToFraction` remains
 * half-to-even for report display and price work.
 */
export function roundToFractionHalfUp(value: Money, fraction: bigint): Money {
  if (fraction <= 0n) throw new RangeError("fraction must be positive");
  const scaled = value.num * fraction;
  const quotient = scaled / value.denom;
  const remainder = scaled % value.denom;
  const twiceRemainder = abs(remainder) * 2n;
  const sign = remainder < 0n ? -1n : 1n;
  const rounded = twiceRemainder >= value.denom ? quotient + sign : quotient;
  return { num: rounded, denom: fraction };
}

export function decimalPlaces(fraction: bigint): number {
  if (fraction <= 0n) throw new RangeError("fraction must be positive");
  let remaining = fraction;
  let places = 0;
  while (remaining % 10n === 0n && remaining > 1n) {
    remaining /= 10n;
    places += 1;
  }
  if (remaining !== 1n) {
    throw new RangeError("fraction must be a power of ten to format");
  }
  return places;
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Parse an exact decimal without rounding. */
export function parseDecimal(text: string): Money {
  const match = DECIMAL.exec(text);
  if (!match) throw new RangeError(`not a decimal amount: ${text}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const decimals = match[3] ?? "";
  const scale = 10n ** BigInt(decimals.length);
  const numerator = sign * (whole * scale + BigInt(decimals === "" ? "0" : decimals));
  return { num: numerator, denom: scale };
}

/** Report/display parsing (half-even), retained for compatibility. */
export function parseMoney(text: string, fraction: bigint): Money {
  return roundToFraction(parseDecimal(text), fraction);
}

/** Posting parsing: exact decimal then GnuCash half-up normalisation. */
export function parseMoneyHalfUp(text: string, fraction: bigint): Money {
  return roundToFractionHalfUp(parseDecimal(text), fraction);
}

export function formatMoney(value: Money, fraction: bigint): string {
  const places = decimalPlaces(fraction);
  const rounded = roundToFraction(value, fraction);
  const negative = rounded.num < 0n;
  const digits = abs(rounded.num)
    .toString()
    .padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const decimals = places === 0 ? "" : `.${digits.slice(digits.length - places)}`;
  return `${negative ? "-" : ""}${whole}${decimals}`;
}

export function isZeroMoney(value: Money): boolean {
  return value.num === 0n;
}
