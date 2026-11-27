<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Oracle book fixtures

Synthetic books used by every track (web, iOS, Android) to prove both GnuCash
backends are read identically. They were generated on 2026-11-23 with GnuCash
5.14 as an external oracle (Python bindings) and re-opened and re-saved by
GnuCash before being committed. No GnuCash source or data is included.

| File                         | Backend                                |
| ---------------------------- | -------------------------------------- |
| `oracle-mini.gnucash`        | XML, gzip-compressed (GnuCash default) |
| `oracle-mini.sqlite.gnucash` | SQLite                                 |

Contents (identical semantics, independent GUIDs):

- Commodity: USD, fraction 100.
- Accounts: Root Account (ROOT); Assets (ASSET) > Bank (BANK);
  Income (INCOME) > Salary (INCOME).
- Transaction: 2025-01-15, "Opening deposit", Bank +2500.00, Salary -2500.00.

Do not edit by hand. Regenerate with GnuCash 5.14 and record the new hashes:

```
eef19522ed04a7d657742f63d85d3fbdb249a02ff66f03ce894ff5c1353b3670  oracle-mini.gnucash
255d350f0b55a4d0154603648575895e0c16b6b3b66859aae5d7f3b3b8778a10  oracle-mini.sqlite.gnucash
```

## `fa-001-straight-line-equipment-depreciation.gnucash`

A larger, richer synthetic fixture from the sibling
[`saldima-accounting-verifier`](https://github.com/johnarleyburns/saldima-accounting-verifier)
project's reviewed `FA-001` scenario: a service business buys $60,000 of
equipment (zero salvage value, 60-month useful life, straight-line
depreciation) and operates for five full fiscal years with steady monthly
cash revenue and expense. 8 real accounts (Cash, Equipment, Accumulated
Depreciation, Owner's Equity, Retained Earnings, Service Revenue, Operating
Expense, Depreciation Expense) plus the implicit root account; 187
transactions.

Exported with that project's `scripts/export_gnucash_book.py`, hand-verified
against its own independent reference-model numbers (see its
`expected/reviewed/fa-001-straight-line-equipment-depreciation/`), then
re-opened and re-saved by GnuCash 5.5 as an external oracle -- the same
process used for `oracle-mini.*` above. Exporting this file surfaced and
fixed a real bug on that project's side (a transaction's currency was
written as `trn:commodity` instead of `trn:currency`, which the real
GnuCash engine rejected outright) -- see that project's commit
`5be2c418dadf706c0b25e697531628f098de5ae8` and its own
`docs/accounting-policy.md`.

This is **not** the owner's real anonymised book mentioned elsewhere as
still pending for the cross-track/oracle acceptance checks (see
`saldima-ios`'s `Fixtures/books/README.md` and its P0 plan's open risks) --
it's fully synthetic test data, useful for exercising the read path against
independently-verified, known-correct numbers across all three tracks.

```
791a5ddd8fa3e9ee293090dbe68ce8f2d5270b6ed2be3daea620265c99d6e0e9  fa-001-straight-line-equipment-depreciation.gnucash
```

## `gronewald-gl-<month>.gnucash`

A real, independently-published academic synthetic general-ledger dataset
-- **"DIB General Ledger Data"**, Jan Gronewald, Sebastian Stephan,
Alexander Rombach, and Peter Fettke (Saarland University / DFKI), Zenodo
record [22014653](https://doi.org/10.5281/zenodo.22014653) (v2,
2026-08-19), **CC BY 4.0**. A genuinely complex German SME chart of
accounts (VAT, trade receivables/payables, payroll, multiple expense
categories) and balanced multi-leg journal entries spanning 2023-01
through 2024-12 (256,232 source rows in total) -- used to exercise
accounting end to end against something richer than a handful of toy
fixtures.

Built by `scripts/import-gronewald-fixture.ts` from the source CSV
(`journal_entries_4203.csv`, 31 MB, not committed -- see the script's own
header comment for the download command) via `tsx
scripts/import-gronewald-fixture.ts <csv-path> [YYYY-MM]` (`YYYY-MM`
defaults to `2023-01`). Each file is one calendar month's postings,
standalone -- not a cumulative, opening-balance-linked series across
months (matching `e2e/gronewald-fixture.spec.ts`'s own treatment: each
import lands in a fresh company). The script proves its own output
re-parses to the same shape before writing it, and -- new as of this
addition -- every file here was also actually opened and re-saved by the
real GnuCash engine (`python3-gnucash`) as an external oracle, with zero
errors, the same bar `oracle-mini.*` and `fa-001-*` above already meet.

| File                           | Month   | Accounts | Transactions | SHA-256                                                            |
| ------------------------------ | ------- | -------: | -----------: | ------------------------------------------------------------------ |
| `gronewald-gl-2023-01.gnucash` | 2023-01 |       22 |        3,305 | `d22e60590536ed28410d8199f69a19f050ab6ff4d507140fd89e407222770a0b` |
| `gronewald-gl-2023-07.gnucash` | 2023-07 |       21 |        5,620 | `59561e1347319086537d93fbca5d0d423cbca7d81d110d35844e5ea58a27c1a0` |
| `gronewald-gl-2024-12.gnucash` | 2024-12 |       21 |        2,429 | `df1cef1fa55083014ba01c8840ef4aa13a6e7a9a8b69cc9756d1dcdb21fe1011` |

Three non-adjacent months (first, a mid-year month of the same year, and
the dataset's final month) were picked deliberately for temporal spread
rather than three consecutive months, while keeping the number of
committed files small. The full 24-month range (2023-01..2024-12) is
available by re-running the script against the source CSV with a
different `YYYY-MM` if a specific month is ever needed for a test.
