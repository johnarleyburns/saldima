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
