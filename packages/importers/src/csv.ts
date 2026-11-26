// SPDX-License-Identifier: AGPL-3.0-only

import {
  addMoney,
  formatMoney,
  isZeroMoney,
  type Money,
  negateMoney,
} from "@saldima/gnucash";

import { parseImportAmount } from "./amount.ts";
import { parseImportDate } from "./date.ts";
import { ImportFormatError, type ImportResult, type ImportRow } from "./types.ts";

export interface CsvColumnMap {
  readonly dateIndex: number;
  readonly descriptionIndex: number;
  readonly valueIndex: number | null;
  readonly outflowIndex: number | null;
  readonly inflowIndex: number | null;
  readonly categoryIndex: number | null;
  readonly referenceIndex: number | null;
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: string;
}

const DELIMITERS = [",", ";", "\t", "|"];

const DATE_NAMES = [
  "date",
  "posted",
  "postdate",
  "transactiondate",
  "bookingdate",
  "valuedate",
  "datum",
];
const DESCRIPTION_NAMES = [
  "description",
  "payee",
  "name",
  "details",
  "narrative",
  "merchant",
  "memo",
];
const VALUE_NAMES = ["amount", "value", "transactionamount", "amountusd", "amt"];
const OUTFLOW_NAMES = [
  "debit",
  "debitamount",
  "withdrawal",
  "withdrawals",
  "moneyout",
  "paidout",
  "outflow",
];
const INFLOW_NAMES = [
  "credit",
  "creditamount",
  "deposit",
  "deposits",
  "moneyin",
  "paidin",
  "inflow",
];
const CATEGORY_NAMES = ["category", "type", "classification", "class"];
const REFERENCE_NAMES = [
  "reference",
  "ref",
  "checknumber",
  "checkno",
  "check",
  "fitid",
  "transactionid",
  "id",
];

function normaliseHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text: string): string {
  const line =
    text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = countOutsideQuotes(line, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function scan(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ""));
}

export function parseCsvTable(text: string): CsvTable {
  const delimiter = detectDelimiter(text);
  const rows = scan(text, delimiter);
  const header = (rows[0] ?? []).map((value) => value.trim());
  return { header, rows: rows.slice(1), delimiter };
}

function findColumn(
  header: readonly string[],
  names: readonly string[],
  claimed: ReadonlySet<number>,
): number | null {
  const normalised = header.map(normaliseHeader);
  const exact = normalised.findIndex(
    (value, index) => !claimed.has(index) && names.includes(value),
  );
  if (exact >= 0) return exact;
  const partial = normalised.findIndex(
    (value, index) => !claimed.has(index) && names.some((name) => value.includes(name)),
  );
  return partial >= 0 ? partial : null;
}

/** Detects the common bank CSV shapes; throws when the table is unusable. */
export function detectCsvMap(header: readonly string[]): CsvColumnMap {
  const claimed = new Set<number>();
  const take = (names: readonly string[]): number | null => {
    const found = findColumn(header, names, claimed);
    if (found !== null) claimed.add(found);
    return found;
  };

  const dateIndex = take(DATE_NAMES);
  let descriptionIndex = take(DESCRIPTION_NAMES);
  if (descriptionIndex === null) {
    const fallback = header.findIndex((_value, index) => !claimed.has(index));
    if (fallback >= 0) {
      descriptionIndex = fallback;
      claimed.add(fallback);
    } else {
      descriptionIndex = 0;
    }
  }
  const valueIndex = take(VALUE_NAMES);
  const outflowIndex = take(OUTFLOW_NAMES);
  const inflowIndex = take(INFLOW_NAMES);
  const categoryIndex = take(CATEGORY_NAMES);
  const referenceIndex = take(REFERENCE_NAMES);

  if (dateIndex === null) {
    throw new ImportFormatError(
      `No date column found. Columns: ${header.join(", ") || "(none)"}.`,
    );
  }
  if (valueIndex === null && outflowIndex === null && inflowIndex === null) {
    throw new ImportFormatError(
      `No amount, debit or credit column found. Columns: ${header.join(", ") || "(none)"}.`,
    );
  }
  return {
    dateIndex,
    descriptionIndex,
    valueIndex,
    outflowIndex,
    inflowIndex,
    categoryIndex,
    referenceIndex,
  };
}

function cell(row: readonly string[], index: number | null): string {
  return index === null ? "" : (row[index] ?? "").trim();
}

export function parseCsv(text: string, map?: CsvColumnMap): ImportResult {
  const table = parseCsvTable(text);
  if (table.header.length === 0) throw new ImportFormatError("The CSV file is empty.");
  const columns = map ?? detectCsvMap(table.header);
  const rows: ImportRow[] = [];
  const warnings: string[] = [];

  table.rows.forEach((row, index) => {
    const line = index + 2;
    const date = parseImportDate(cell(row, columns.dateIndex));
    if (!date) {
      if (row.some((value) => value.trim() !== "")) {
        warnings.push(`row ${line}: skipped (invalid date)`);
      }
      return;
    }

    let amount: Money | null = null;
    if (columns.valueIndex !== null) {
      amount = parseImportAmount(cell(row, columns.valueIndex));
    } else {
      const outflow = cell(row, columns.outflowIndex);
      const inflow = cell(row, columns.inflowIndex);
      const out = outflow ? parseImportAmount(outflow) : null;
      const into = inflow ? parseImportAmount(inflow) : null;
      if (outflow && !out) {
        warnings.push(`row ${line}: skipped (invalid debit)`);
        return;
      }
      if (inflow && !into) {
        warnings.push(`row ${line}: skipped (invalid credit)`);
        return;
      }
      amount = addMoney(
        into ?? { num: 0n, denom: 1n },
        negateMoney(out ?? { num: 0n, denom: 1n }),
      );
      if (!outflow && !inflow) amount = null;
    }

    if (!amount) {
      warnings.push(`row ${line}: skipped (invalid amount)`);
      return;
    }
    if (isZeroMoney(amount)) {
      warnings.push(`row ${line}: skipped (zero amount)`);
      return;
    }

    rows.push({
      date,
      amount,
      payee: cell(row, columns.descriptionIndex),
      memo: "",
      reference: cell(row, columns.referenceIndex),
      category: cell(row, columns.categoryIndex),
      splits: [],
    });
  });

  if (rows.length === 0)
    throw new ImportFormatError("No usable CSV transactions found.");
  return { source: "csv", rows, warnings };
}

function escapeCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Writes a register's rows with headers `detectCsvMap` recognises, the inverse of `parseCsv`. */
export function serializeCsv(rows: readonly ImportRow[]): string {
  const header = ["Date", "Description", "Memo", "Amount", "Category", "Reference"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.payee,
        row.memo,
        formatMoney(row.amount, 100n),
        row.category,
        row.reference,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
