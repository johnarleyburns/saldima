// SPDX-License-Identifier: AGPL-3.0-only

import { formatMoney, isZeroMoney, type Money } from "@saldima/gnucash";

import { parseImportAmount } from "./amount.ts";
import { parseImportDate } from "./date.ts";
import {
  ImportFormatError,
  type ImportResult,
  type ImportRow,
  type ImportSplit,
} from "./types.ts";

interface QifRecord {
  date: string;
  amount: Money | null;
  payee: string;
  memo: string;
  reference: string;
  category: string;
  splits: ImportSplit[];
  warnings: string[];
}

function blankRecord(): QifRecord {
  return {
    date: "",
    amount: null,
    payee: "",
    memo: "",
    reference: "",
    category: "",
    splits: [],
    warnings: [],
  };
}

function finishSplit(
  record: QifRecord,
  split: { category: string; amount: Money | null } | null,
): void {
  if (!split) return;
  if (!split.amount) {
    record.warnings.push(`record: split "${split.category}" has no amount`);
    return;
  }
  record.splits.push({ category: split.category, amount: split.amount });
}

export function parseQif(text: string): ImportResult {
  const rows: ImportRow[] = [];
  const warnings: string[] = [];
  let record = blankRecord();
  let recordNumber = 1;
  let split: { category: string; amount: Money | null } | null = null;

  const finish = (): void => {
    for (const warning of record.warnings) {
      warnings.push(`record ${recordNumber}: ${warning}`);
    }
    const date = parseImportDate(record.date);
    if (!date) {
      warnings.push(`record ${recordNumber}: skipped (no valid date)`);
    } else if (!record.amount) {
      warnings.push(`record ${recordNumber}: skipped (no valid amount)`);
    } else if (isZeroMoney(record.amount)) {
      warnings.push(`record ${recordNumber}: skipped (zero amount)`);
    } else {
      rows.push({
        date,
        amount: record.amount,
        payee: record.payee,
        memo: record.memo,
        reference: record.reference,
        category: record.category,
        splits: record.splits,
      });
    }
    recordNumber += 1;
    record = blankRecord();
    split = null;
  };

  for (const raw of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const code = raw.charAt(0);
    const value = raw.slice(1).trim();
    if (code === "!" || raw.trim() === "") continue;
    if (code === "^") {
      finishSplit(record, split);
      finish();
      continue;
    }
    if (code === "S") {
      finishSplit(record, split);
      split = { category: value, amount: null };
      continue;
    }
    if (code === "$") {
      if (!split) {
        record.warnings.push("record: split amount without a category");
      } else {
        split.amount = parseImportAmount(value);
      }
      continue;
    }
    if (code === "D") record.date = value;
    else if (code === "T") record.amount = parseImportAmount(value);
    else if (code === "P") record.payee = value;
    else if (code === "M") record.memo = value;
    else if (code === "N") record.reference = value;
    else if (code === "L") record.category = value;
  }

  // A final record without the `^` terminator is still a record.
  if (record.date || record.amount || record.payee) {
    finishSplit(record, split);
    finish();
  }

  if (rows.length === 0) {
    throw new ImportFormatError("No QIF transactions found.");
  }
  return { source: "qif", rows, warnings };
}

/** Writes a register's rows as a `!Type:Bank` QIF file, the inverse of `parseQif`. */
export function serializeQif(rows: readonly ImportRow[]): string {
  const lines: string[] = ["!Type:Bank"];
  for (const row of rows) {
    lines.push(`D${row.date}`);
    lines.push(`T${formatMoney(row.amount, 100n)}`);
    if (row.payee) lines.push(`P${row.payee}`);
    if (row.memo) lines.push(`M${row.memo}`);
    if (row.reference) lines.push(`N${row.reference}`);
    if (row.category) lines.push(`L${row.category}`);
    lines.push("^");
  }
  return `${lines.join("\n")}\n`;
}
