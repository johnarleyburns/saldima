// SPDX-License-Identifier: AGPL-3.0-only

import { isZeroMoney } from "@saldima/gnucash";

import { parseImportAmount } from "./amount.ts";
import { parseImportDate } from "./date.ts";
import { ImportFormatError, type ImportResult, type ImportRow } from "./types.ts";

function clean(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function field(block: string, name: string): string {
  const closed = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (closed?.[1] !== undefined) return clean(closed[1]);
  const open = new RegExp(`<${name}\\b[^>]*>([^<\\r\\n]*)`, "i").exec(block);
  return open?.[1] ? clean(open[1]) : "";
}

function statementBlocks(text: string): string[] {
  const marker = /<STMTTRN\b[^>]*>/gi;
  const starts: number[] = [];
  let match = marker.exec(text);
  while (match) {
    starts.push(match.index + match[0].length);
    match = marker.exec(text);
  }
  return starts.map((start, index) =>
    text.slice(start, starts[index + 1] ?? text.length).replace(/<\/STMTTRN>/gi, ""),
  );
}

export function isOfx(text: string): boolean {
  return (
    /OFXHEADER/i.test(text.slice(0, 4096)) || /<OFX[\s>]/i.test(text.slice(0, 4096))
  );
}

/** Reads both OFX 1.x SGML (unclosed tags) and OFX 2.x XML statements. */
export function parseOfx(text: string): ImportResult {
  const blocks = statementBlocks(text);
  if (blocks.length === 0) throw new ImportFormatError("No OFX transactions found.");
  const rows: ImportRow[] = [];
  const warnings: string[] = [];

  blocks.forEach((block, index) => {
    const date = parseImportDate(field(block, "DTPOSTED"));
    const amount = parseImportAmount(field(block, "TRNAMT"));
    if (!date) {
      warnings.push(`transaction ${index + 1}: skipped (invalid date)`);
      return;
    }
    if (!amount) {
      warnings.push(`transaction ${index + 1}: skipped (invalid amount)`);
      return;
    }
    if (isZeroMoney(amount)) {
      warnings.push(`transaction ${index + 1}: skipped (zero amount)`);
      return;
    }
    rows.push({
      date,
      amount,
      payee: field(block, "NAME") || field(block, "PAYEE"),
      memo: field(block, "MEMO"),
      reference: field(block, "FITID") || field(block, "CHECKNUM"),
      category: field(block, "CATEGORY"),
      splits: [],
    });
  });

  if (rows.length === 0)
    throw new ImportFormatError("No usable OFX transactions found.");
  return { source: "ofx", rows, warnings };
}
