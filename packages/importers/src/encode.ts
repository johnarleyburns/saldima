// SPDX-License-Identifier: AGPL-3.0-only

import { type Money, money } from "@saldima/gnucash";

import { ImportFormatError, type ImportRow, type ImportSplit } from "./types.ts";

interface StoredSplit {
  category: string;
  amount: string;
}

interface StoredRow {
  date: string;
  amount: string;
  payee: string;
  memo: string;
  reference: string;
  category: string;
  splits: StoredSplit[];
}

function ratio(value: Money): string {
  return `${value.num.toString()}/${value.denom.toString()}`;
}

function parseRatio(value: unknown): Money {
  if (typeof value !== "string") throw new ImportFormatError("invalid money");
  const match = /^(-?\d+)\/(\d+)$/.exec(value);
  if (!match?.[1] || !match[2]) throw new ImportFormatError("invalid money");
  const num = BigInt(match[1]);
  const denom = BigInt(match[2]);
  if (denom <= 0n) throw new ImportFormatError("invalid money");
  return money(num, denom);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parsed rows are staged as JSON between the upload and mapping screens. */
export function encodeImportRows(rows: readonly ImportRow[]): string {
  const stored: StoredRow[] = rows.map((row) => ({
    date: row.date,
    amount: ratio(row.amount),
    payee: row.payee,
    memo: row.memo,
    reference: row.reference,
    category: row.category,
    splits: row.splits.map((split) => ({
      category: split.category,
      amount: ratio(split.amount),
    })),
  }));
  return JSON.stringify(stored);
}

export function decodeImportRows(payload: string): ImportRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ImportFormatError("staged import is not readable");
  }
  if (!Array.isArray(parsed))
    throw new ImportFormatError("staged import is not a list");
  return parsed.map((item: unknown): ImportRow => {
    if (typeof item !== "object" || item === null) {
      throw new ImportFormatError("staged import row is not readable");
    }
    const row = item as Record<string, unknown>;
    const splits = Array.isArray(row.splits) ? row.splits : [];
    return {
      date: text(row.date),
      amount: parseRatio(row.amount),
      payee: text(row.payee),
      memo: text(row.memo),
      reference: text(row.reference),
      category: text(row.category),
      splits: splits.map((raw): ImportSplit => {
        if (typeof raw !== "object" || raw === null) {
          throw new ImportFormatError("staged split is not readable");
        }
        const split = raw as Record<string, unknown>;
        return {
          category: text(split.category),
          amount: parseRatio(split.amount),
        };
      }),
    };
  });
}
