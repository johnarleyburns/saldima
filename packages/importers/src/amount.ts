// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Money,
  normalizeMoney,
  parseDecimal,
  roundToFractionHalfUp,
} from "@saldima/gnucash";

function decimalSeparator(value: string): string {
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) return comma > dot ? "," : ".";
  if (comma >= 0) {
    const digits = value.length - comma - 1;
    return value.split(",").length === 2 && digits > 0 && digits <= 2 ? "," : "";
  }
  return value.split(".").length > 2 ? "" : ".";
}

/**
 * Reads a bank amount exactly to cents. Handles currency symbols, thousands
 * separators, European decimal commas and accounting parentheses.
 */
export function parseImportAmount(text: string): Money | null {
  let value = text.trim();
  if (!value) return null;

  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[\s']/g, "").replace(/[\p{Sc}A-Za-z]/gu, "");

  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1);
  }
  if (value.endsWith("-")) {
    negative = !negative;
    value = value.slice(0, -1);
  }

  const separator = decimalSeparator(value);
  const normalised =
    separator === ","
      ? value.replaceAll(".", "").replace(",", ".")
      : separator === "."
        ? value.replaceAll(",", "")
        : value.replaceAll(",", "").replaceAll(".", "");

  if (!/^\d+(?:\.\d+)?$/.test(normalised)) return null;
  const amount = roundToFractionHalfUp(parseDecimal(normalised), 100n);
  return normalizeMoney(negative ? { num: -amount.num, denom: amount.denom } : amount);
}
