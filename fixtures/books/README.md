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
