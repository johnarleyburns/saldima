// SPDX-License-Identifier: AGPL-3.0-only

import { decimalPlaces, type Money, roundToFraction } from "./money.ts";

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
/** No comma/"and" between a group's hundreds and tens, matching standard check-writing style. */
const SCALES = ["", " thousand", " million", " billion", " trillion"];

function threeDigitsToWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 10) parts.push(ONES[rest] ?? "");
    else if (rest < 20) parts.push(TEENS[rest - 10] ?? "");
    else {
      const tensDigit = Math.floor(rest / 10);
      const onesDigit = rest % 10;
      parts.push(
        onesDigit > 0
          ? `${TENS[tensDigit]}-${ONES[onesDigit]}`
          : (TENS[tensDigit] ?? ""),
      );
    }
  }
  return parts.join(" ");
}

function wholeNumberToWords(n: bigint): string {
  if (n === 0n) return "zero";
  const groups: bigint[] = [];
  let remaining = n;
  while (remaining > 0n) {
    groups.push(remaining % 1000n);
    remaining /= 1000n;
  }
  if (groups.length > SCALES.length) {
    throw new RangeError("amount is too large to spell out");
  }
  const parts: string[] = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (!group) continue;
    parts.push(threeDigitsToWords(Number(group)) + (SCALES[index] ?? ""));
  }
  const text = parts.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The standard check-writing form, e.g. `"One hundred eight dollars and
 * 00/100"`. A check is never written for a zero or negative amount, so this
 * throws `RangeError` for both rather than printing nonsense.
 */
export function amountInWords(value: Money, fraction: bigint): string {
  if (fraction <= 0n) throw new RangeError("fraction must be positive");
  const normalized = roundToFraction(value, fraction);
  if (normalized.num <= 0n) {
    throw new RangeError("a check amount must be a positive value");
  }
  const whole = normalized.num / fraction;
  const remainder = normalized.num % fraction;
  const decimals = decimalPlaces(fraction);
  const remainderText = remainder.toString().padStart(decimals, "0");
  const wholeWords = wholeNumberToWords(whole);
  return `${wholeWords} dollar${whole === 1n ? "" : "s"} and ${remainderText}/${fraction}`;
}
