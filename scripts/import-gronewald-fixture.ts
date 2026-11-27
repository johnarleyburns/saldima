// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds fixtures/books/gronewald-gl-<month>.gnucash from the Gronewald et
// al. synthetic general-ledger dataset ("DIB General Ledger Data", Jan
// Gronewald, Sebastian Stephan, Alexander Rombach, Peter Fettke -- Saarland
// University / DFKI; Zenodo record 22014653, v2, 2026-08-19;
// https://doi.org/10.5281/zenodo.22014653, CC BY 4.0): a real, complex
// chart of accounts and balanced multi-leg journal entries spanning
// 2023-01 through 2024-12, used to exercise accounting end to end rather
// than a handful of toy fixtures. Each generated file is one calendar
// month's postings, standalone (not a cumulative, opening-balance-linked
// series across months) -- matching how the existing fixture and its
// consuming tests already treat it (imported into a fresh company).
//
// The source CSV is not committed (31 MB, third-party data); download it
// first:
//   curl -sL -o /tmp/gronewald/journal_entries_4203.csv \
//     'https://zenodo.org/records/22014653/files/journal_entries_4203.csv?download=1'
//   tsx scripts/import-gronewald-fixture.ts /tmp/gronewald/journal_entries_4203.csv [YYYY-MM]
//
// YYYY-MM defaults to 2023-01 (the original fixture). The full dataset
// covers 2023-01..2024-12.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import type {
  BookSnapshot,
  SnapshotAccount,
  SnapshotTransaction,
} from "../packages/gnucash/src/book-file.ts";
import { parseGnuCashXml } from "../packages/gnucash/src/book-file.ts";
import { money } from "../packages/gnucash/src/money.ts";
import { writeGnuCashXml } from "../packages/gnucash/src/xml-writer.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface GlRow {
  readonly posting_id: string;
  readonly document_date: string;
  readonly gl_account: string;
  readonly gl_account_name: string;
  readonly amount: string;
  readonly cd_flag: string;
  readonly text: string;
}

function parseCsv(text: string): GlRow[] {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const header = (lines[0] ?? "").split(";");
  return lines.slice(1).map((line) => {
    const cells = line.split(";");
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? "";
    });
    return row as unknown as GlRow;
  });
}

/** Deterministic 32-hex GUID from a stable seed, so re-running reproduces the same book. */
function guidFromSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

type AccountType = SnapshotAccount["type"];

const ACCOUNT_TYPES: Record<string, AccountType> = {
  "0980": "ASSET",
  "1000": "CASH",
  "1100": "BANK",
  "1200": "BANK",
  "1400": "RECEIVABLE",
  "1576": "ASSET",
  "1600": "PAYABLE",
  "1700": "LIABILITY",
  "1776": "LIABILITY",
  "2020": "EXPENSE",
  "3400": "EXPENSE",
  "4100": "EXPENSE",
  "4120": "EXPENSE",
  "4130": "EXPENSE",
  "4210": "EXPENSE",
  "4240": "EXPENSE",
  "4250": "EXPENSE",
  "4260": "EXPENSE",
  "4360": "EXPENSE",
  "4580": "EXPENSE",
  "4600": "EXPENSE",
  "4710": "EXPENSE",
  "4930": "EXPENSE",
  "4950": "EXPENSE",
  "8400": "INCOME",
};

function buildSnapshot(rows: readonly GlRow[], month: string): BookSnapshot {
  const bookGuid = guidFromSeed(`gronewald-${month}/book`);
  const rootGuid = guidFromSeed(`gronewald-${month}/root`);

  const codes = new Map<string, string>();
  for (const row of rows) codes.set(row.gl_account, row.gl_account_name);

  const accounts: SnapshotAccount[] = [
    {
      guid: rootGuid,
      name: "Root Account",
      type: "ROOT",
      parentGuid: null,
      commodityCode: null,
      code: "",
      description: "",
    },
    ...[...codes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, name]): SnapshotAccount => {
        const type = ACCOUNT_TYPES[code];
        if (!type) throw new Error(`unclassified GL account ${code} ${name}`);
        return {
          guid: guidFromSeed(`gronewald-${month}/account/${code}`),
          name,
          type,
          parentGuid: rootGuid,
          commodityCode: "EUR",
          code,
          description: `Gronewald synthetic ledger account ${code}`,
        };
      }),
  ];

  const byPosting = new Map<string, GlRow[]>();
  for (const row of rows) {
    const list = byPosting.get(row.posting_id) ?? [];
    list.push(row);
    byPosting.set(row.posting_id, list);
  }

  const transactions: SnapshotTransaction[] = [...byPosting.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([postingId, splits]): SnapshotTransaction => {
      const first = splits[0];
      if (!first) throw new Error(`empty posting ${postingId}`);
      return {
        guid: guidFromSeed(`gronewald-${month}/transaction/${postingId}`),
        date: first.document_date,
        description: first.text || `Posting ${postingId}`,
        currencyCode: "EUR",
        splits: splits.map((split, index) => {
          const cents = BigInt(Math.round(Number.parseFloat(split.amount) * 100));
          const signed = split.cd_flag === "D" ? cents : -cents;
          return {
            guid: guidFromSeed(`gronewald-${month}/split/${postingId}/${index}`),
            accountGuid: guidFromSeed(`gronewald-${month}/account/${split.gl_account}`),
            value: money(signed, 100n),
          };
        }),
      };
    });

  return {
    bookGuid,
    currencyCode: "EUR",
    fraction: 100,
    accounts,
    transactions,
  };
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function main(): void {
  const csvPath = process.argv[2];
  const month = process.argv[3] ?? "2023-01";
  if (!csvPath) {
    console.error(
      "usage: tsx scripts/import-gronewald-fixture.ts <path-to-journal_entries_4203.csv> [YYYY-MM]",
    );
    process.exit(1);
  }
  if (!MONTH_RE.test(month)) {
    throw new Error(`month must be YYYY-MM, got ${JSON.stringify(month)}`);
  }
  const output = join(ROOT, "fixtures", "books", `gronewald-gl-${month}.gnucash`);

  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text).filter((row) => row.document_date.startsWith(month));
  if (rows.length === 0)
    throw new Error(
      `no rows found for ${month}; is this the right CSV, or an out-of-range month?`,
    );

  const snapshot = buildSnapshot(rows, month);
  const xml = writeGnuCashXml(snapshot);

  // Prove the file we are about to commit actually re-parses to the same shape.
  const reparsed = parseGnuCashXml(xml);
  if (reparsed.transactions.length !== snapshot.transactions.length) {
    throw new Error(
      `round-trip mismatch: wrote ${snapshot.transactions.length} transactions, reparsed ${reparsed.transactions.length}`,
    );
  }

  writeFileSync(output, gzipSync(Buffer.from(xml, "utf8")));
  console.log(
    `wrote ${output}: ${snapshot.accounts.length - 1} accounts, ${snapshot.transactions.length} transactions, ${rows.length} splits (${month})`,
  );
}

main();
