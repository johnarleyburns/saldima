<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# GnuCash verification research for Saldima

**Date:** 2026-11-23
**Scope:** read GnuCash to understand behaviour; no GnuCash source is copied into Saldima.
**Source clone:** `/tmp/opencode/gnucash-src`, `https://github.com/Gnucash/gnucash`
**Commit:** `e72b724c37993a57bcf3f86d3618e828e4c060a2` (2026-11-23, `stable`, merge `delete-zero-imbalance`)
**Version:** `PROJECT_VERSION 5.17`; release tag `5.17` is `0e302675fff4bf6dccf62ba876c7d306b7152d0e` (2026-09-26). HEAD is 5.17 plus post-release fixes.
**Installed oracle used for experiments:** GnuCash `5.14` (`Build ID 5.14+(2025-12-20)`) and `python3-gnucash 5.14` on Ubuntu 26.04. Treat 5.14 vs 5.17 as a version risk, not a blocker for schema work.
**License note:** GnuCash is GPL-2.0-or-later. Saldima is AGPL-3.0-only. The recommended oracle invokes GnuCash binaries as a **separate process** and never imports, links or vendors GnuCash code into Saldima.

---

## 1. The GnuCash data model and invariants

### Transactions and splits

A transaction has a currency (the “common currency”), posted/entered dates, num, description, notes and KVP slots. It owns one or more splits. A split has:

- an **account**
- an **amount / quantity** in the **account’s commodity**
- a **value** in the **transaction’s currency**
- memo, action, reconcile state, reconcile date, lot reference and KVP slots.

Key sources:

- `libgnucash/engine/Transaction.h` — the double-entry description at the top and the imbalance APIs.
- `libgnucash/engine/Split.h` — reconciled flag constants, value-vs-amount comments.
- `libgnucash/engine/Split.cpp` — `xaccSplitSetAmount`, `xaccSplitSetValue`, void and balance getters.
- `libgnucash/engine/Account.cpp` — `xaccAccountRecomputeBalance`, balance-as-of-date.

Important behaviour:

1. **Balance rule is on `value`, not `amount`.** `xaccTransGetImbalanceValue()` sums split values exactly and should be zero. `xaccTransIsBalanced()` additionally requires per-commodity sums to be zero when trading accounts are enabled.
2. **Account balances sum `amount`**, not `value` (`xaccAccountRecomputeBalance`). Reports such as the balance sheet use account amounts; value is used for unrealised gains and transaction-currency views.
3. **For same-currency splits, `value == amount`.** The engine scrub (`Scrub.cpp`) enforces this when the account commodity equals the transaction currency. Otherwise value and amount legitimately differ (foreign currency, stocks).
4. **Splits are normalised to the commodity/currency fraction on write.** `xaccSplitSetAmount()` converts to the account SCU with `GNC_HOW_RND_ROUND_HALF_UP`; `xaccSplitSetValue()` converts to the transaction-currency fraction with half-up. A test posting of `2.665 USD` became `2.67 USD` in the SQLite split. Saldima must do the same normalisation (its current `roundToFraction` is half-to-even, which differs on exact .005 ties).
5. **GnuCash does not reject unbalanced transactions on commit.** File → Check & Repair (`xaccTransScrubImbalance`) repairs them, creating an `Imbalance-<CUR>` bank account. Saldima should reject them on write, but the oracle must be able to _read_ imbalanced books and report the imbalance.
6. **Running balances are derived, not stored** in SQLite. Account balances are recomputed from splits on load.

### Reconcile flags

`Split.h` defines the characters:

| Flag | Meaning                       | Counts in cleared | Counts in reconciled |
| ---- | ----------------------------- | ----------------- | -------------------- |
| `n`  | not cleared/reconciled        | no                | no                   |
| `c`  | cleared                       | yes               | no                   |
| `y`  | reconciled                    | yes               | yes                  |
| `f`  | frozen into accounting period | yes               | yes                  |
| `v`  | void                          | no (amount is 0)  | no (amount is 0)     |

`xaccAccountRecomputeBalance` implements exactly that: cleared sums every split whose flag is not `n`; reconciled sums `y` and `f`.

### Void and reverse

- **Void** (`xaccTransVoid`, `xaccSplitVoid`): moves transaction notes to `void-former-notes`, writes `void-reason`, `void-time`, `trans-read-only`, sets every split amount/value to zero and reconcile flag to `v`, and stores former amounts/values in split KVP (`void-former-amount`, `void-former-value`). The transaction remains, but contributes nothing.
- **Reverse** (`xaccTransReverse`): clones the transaction, negates every split’s amount and value, sets reconcile flags to `n`, links the original to the new transaction with a `reversed-by` GUID KVP. Both transactions remain and the pair nets to zero. `xaccTransGetReversedBy()` follows the link.

### Closing entries

A closing transaction is identified by `xaccTransSetIsClosingTxn()`, which writes the transaction KVP `book_closing = 1` (INT64). `xaccSplitGetNoclosingBalance()` excludes those transactions from the running balance. Separately, the legacy balance-sheet/income-statement/trial-balance reports identify closing entries by a **description pattern** (default `"Closing Entries"`, case-insensitive substring; regex optional). These two mechanisms are not the same, and they differ between legacy and multicolumn reports.

---

## 2. Opening balances and templates

### New-book templates

- Account templates are XML files: `data/accounts/<locale>/acctchrt_*.gnucash-xea` (463 files across 40 locales at this commit; 68 contain the opening-balance slot). Format is `gnc-account-example` with `gnc:account` elements, `act:type`, `act:commodity`, `act:parent`, and `act:slots`.
- Every template has a `ROOT` account. The common/full templates include an equity hierarchy:
  - `Equity` (EQUITY, placeholder)
  - `Equity > Opening Balances` (EQUITY) with slot `equity-type = "opening-balance"`.
- New SQLite books also contain a hidden `Template Root` ROOT account; `books.root_template_guid` points to it. Preserve both root accounts and `books.root_template_guid` on round-trip.

### Creating an opening balance

`gnc_account_create_opening_balance()` in `libgnucash/app-utils/gnc-ui-util.cpp`:

- refuses non-currency accounts;
- finds or creates an equity account via `gnc_find_or_create_equity_account(root, EQUITY_OPENING_BALANCE, commodity)`;
- uses name `"Opening Balances"` for the default currency, else `"Opening Balances - <CUR>"`; one equity account per currency;
- creates a transaction dated at the chosen date, description `"Opening Balance"`;
- posts the target account with `amount = value = balance`, and the equity account with the negated balance;
- marks the equity account with the `equity-type = "opening-balance"` slot when the feature is in use.

The Python example `bindings/python/example_scripts/new_book_with_opening_balances.py` follows the same convention: income/expense accounts are excluded; only balance-sheet accounts get opening balances.

For Saldima, the clean fixture convention is an explicit transaction:

```
Debit  Assets:Bank                 1000.00
Credit Equity:Opening Balances      800.00
Credit Liabilities:Card             200.00
```

with the equity account carrying `equity-type: opening-balance`. This is exactly what GnuCash’s account dialog generates, and is what the first fixtures should use.

---

## 3. How the reports compute their numbers

### Balance sheet

Single-column report: `gnucash/report/reports/standard/balance-sheet.scm`.

- Report date is converted to **end of day**; account balances use `xaccAccountGetBalanceAsOfDate()` (amount).
- Groups accounts by type using `gnc:decompose-accountlist`: asset-like types (ASSET, BANK, CASH, CHECKING, SAVINGS, MONEYMRKT, RECEIVABLE, STOCK, MUTUAL, CURRENCY), liability-like (LIABILITY, PAYABLE, CREDIT, CREDITLINE), equity, income, expense, trading.
- Presentation:
  - `asset-balance = Σ amount(asset accounts, date)`
  - `liability-balance = -Σ amount(liability accounts, date)`
  - `equity-balance = -Σ amount(equity accounts, date)`
  - `retained-earnings = -Σ amount(income + expense accounts, date)`
  - `total-equity = equity-balance + retained-earnings + trading + unrealized`
  - `liability-plus-equity = liability-balance + total-equity`
- “Retained Earnings” is omitted when zero; “Retained Losses” is used when negative. Other labels also flip for negative values.
- Unrealised gains appear only when a common/report currency requires value-vs-amount conversion.
- Multicolumn report `balsheet-pnl.scm` uses `xaccSplitGetNoclosingBalance()` for the balance sheet, so it excludes `book_closing` transactions; the legacy single-column report uses raw balances. For an unclosed book they agree; for a closed book both normally agree because income/expense are zero after closing.

### Income statement / Profit & Loss

Legacy: `gnucash/report/reports/standard/income-statement.scm`.

- Start date = start of day; end date = end of day.
- Revenue and expense balances are accumulated over the interval with `gnc:account-get-trans-type-balance-interval-with-closing`.
- The report subtracts closing splits matched by the description pattern:
  - `expense-total = all expense − closing expense`
  - `revenue-total = closing revenue − all revenue` (because income balances are negative)
  - `net-income = revenue-total + trading − expense-total`
- Revenue is displayed with reversed sign (natural positive), expenses positive, net income positive for a profit.
- Multicolumn P&L uses the `book_closing` KVP / noclosing balances rather than description matching.

### Trial balance

`gnucash/report/reports/standard/trial-balance.scm`.

- Gets account balances at the report date.
- Sign decides the column: positive raw balance → Debit, negative → Credit. This is sign-based, **not** account-type-based.
- Default variation “current” includes adjusting and closing entries; variants “pre-adj” and “pre-closing” remove them by description pattern.
- Income/expense accounts remain in the trial balance (unless closed), so the report balances because all transaction values net to zero.
- The final totals row is the sum of debit and credit columns; for a balanced single-currency book they are equal.
- Unrealised gains/losses may add a separate line.
- Account type decomposition and `double-col` are in `report-utilities.scm` and `trial-balance.scm`.

### Transaction report / General Journal

`gnucash/report/trep-engine.scm` and `reports/standard/transaction.scm`.

- Builds a QOF split query: account set, date interval, cleared/reconciled filter, void filter, closing-transaction filter, description/memo/notes matcher.
- Sorts by account/date/register order; optional running balance and subtotals.
- Amount column can be split amount (account commodity) or split value (transaction currency); optional common-currency conversion.
- Voided splits are excluded by default; when included, the report can show the former amount and optionally include it in totals.
- Closing transactions are excluded by default.
- CSV export exists inside trep-engine, but the shipped `Transaction Report` template does not expose an export thunk, so `gnucash-cli --export-type CSV` is not available for it.
- **The plain Transaction Report defaults to no selected accounts** and is empty under CLI. **General Journal** is the useful CLI transaction-level report: it selects all accounts, all non-void transactions, all dates, and shows debits/credits plus totals. Its source is `reports/standard/general-journal.scm`; it delegates rendering to the Register report.

### Reconciliation report

`reports/standard/reconcile-report.scm`. It is a trep report with reconciled-date filtering and Funds In/Funds Out columns. It requires an account selection; CLI default is “No accounts selected”. A custom saved report can select an account (see below).

---

## 4. SQLite file format, account table and KVP slots

### Table versions

From `libgnucash/backend/sql/*.cpp` and a generated 5.14 book:

| Table          | Version | Columns / notes                                                                                                                              |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`     | 1       | `guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder`                  |
| `transactions` | 4       | `guid, currency_guid, num, post_date, enter_date, description`                                                                               |
| `splits`       | 5       | `guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid` |
| `slots`        | 4       | `id, obj_guid, name, slot_type, int64_val, string_val, double_val, timespec_val, guid_val, numeric_val_num, numeric_val_denom, gdate_val`    |
| `books`        | 1       | `guid, root_account_guid, root_template_guid`                                                                                                |
| `commodities`  | 1       | `guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz`                                                   |
| `prices`       | 3       | `guid, commodity_guid, currency_guid, date, source, type, value_num, value_denom`                                                            |
| `lots`         | 2       | lots                                                                                                                                         |
| `versions`     | —       | `table_name, table_version`                                                                                                                  |

These versions are the same in 4.14, 5.14 and 5.17 for the tables above. The `versions` table also has:

- `Gnucash` = `major*1,000,000 + minor`: 4000014, 5000014, 5000017.
- `Gnucash-Resave` = 19920.
- `GNUCASH_RESAVE_VERSION` = 19920 in CMake.

SQLite dates are ISO text (`YYYY-MM-DD HH:MM:SS`), created with the `ISO-8601 formatted date strings in SQLite3 databases` feature. In a test book, posted dates are normalised to `10:59:00` local time; unreconciled `reconcile_date` is `1970-01-01 00:00:00`, not NULL.

### Account types

`account_type` strings: `NONE, BANK, CASH, CREDIT, ASSET, LIABILITY, STOCK, MUTUAL, CURRENCY, INCOME, EXPENSE, EQUITY, RECEIVABLE, PAYABLE, ROOT, TRADING, CHECKING, SAVINGS, MONEYMRKT, CREDITLINE`. The last four are legacy aliases; GnuCash 5 says do not use them for new accounts, but imported books may contain them.

`commodity_scu` is the smallest unit (100 for USD, 1 for JPY, 1000 for KWD). `non_std_scu = 1` means the account SCU differs from the commodity fraction (e.g. a stock account with fraction 10000).

### Account notes and tax storage (KVP)

Getters/setters are in `Account.cpp` around `xaccAccountGetNotes`, `xaccAccountGetTaxRelated`, `xaccAccountGetTaxUSCode`, `xaccAccountGetTaxUSPayerNameSource`, `xaccAccountGetTaxUSCopyNumber`, `xaccAccountGetIsOpeningBalance`. Slots are stored in the `slots` table keyed by `obj_guid` (account GUID).

| Key / path                                                         | Slot type | Encoding                                                                                            |
| ------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------- |
| `notes`                                                            | 4 STRING  | `string_val`; multi-line text allowed                                                               |
| `tax-related`                                                      | 4 STRING  | `"true"` or absent (false). BOOLEAN-as-string, not INT64                                            |
| `tax-US`                                                           | 9 FRAME   | row on the account GUID; `guid_val` points to the child frame GUID                                  |
| `tax-US/code`                                                      | 4 STRING  | child frame row                                                                                     |
| `tax-US/payer-name-source`                                         | 4 STRING  | child frame row                                                                                     |
| `tax-US/copy-number`                                               | 1 INT64   | child frame row; `int64_val`; getter defaults to 1                                                  |
| `equity-type`                                                      | 4 STRING  | `"opening-balance"` on the equity account                                                           |
| `placeholder`                                                      | 4 STRING  | `"true"`; also mirrored in `accounts.placeholder` column                                            |
| `hidden`                                                           | 4 STRING  | `"true"`; also mirrored in `accounts.hidden` column                                                 |
| `features`                                                         | 9 GLIST   | row on the book GUID; `guid_val` points to a child list GUID; child rows named `features/<feature>` |
| `book_closing`                                                     | 1 INT64   | 1 on closing transactions                                                                           |
| `void-former-amount` / `void-former-value`                         | 3 NUMERIC | `numeric_val_num/denom` on split                                                                    |
| `void-reason`, `void-time`, `void-former-notes`, `trans-read-only` | 4 STRING  | transaction KVP                                                                                     |
| `reversed-by`                                                      | 5 GUID    | transaction KVP; points to reversal                                                                 |
| `date-posted`                                                      | 10 GDATE  | transaction KVP `gdate_val` (`YYYYMMDD`)                                                            |

Slot type numbers: `1 INT64, 2 DOUBLE, 3 NUMERIC, 4 STRING, 5 GUID, 6 TIME64, 8 GLIST, 9 FRAME, 10 GDATE` (`7` is a retired binary placeholder). Nested paths use `/`. A frame parent row lives on the object GUID; children live on the frame GUID and carry the full path in `name`.

When patching SQL directly, write both the columns and the KVP mirrors for `hidden`/`placeholder`, and preserve unknown slots and the `features` GLIST. Otherwise a GnuCash round-trip can change behaviour.

---

## 5. Existing GnuCash tests and fixtures

### Engine tests

`libgnucash/engine/test/`:

- `test-transaction-reversal.cpp`, `test-transaction-voiding.cpp` — reverse/void semantics.
- `test-split-vs-account.cpp` — split/account relationships.
- `utest-Transaction.cpp`, `utest-Split.cpp`, `utest-Account.cpp` — unit tests, including `xaccTransIsBalanced`.
- `gtest-scrub.cpp` — scrub/repair behaviour.
- `test-engine-stuff.cpp` — random account/transaction generator. It constructs two opposite-value splits by default and has a `do_bork()` switch to deliberately create imbalances. This is a useful model for property-based testing: generate valid by construction, then mutate to create invalid cases.

### Report tests

`gnucash/report/reports/standard/test/`:

- `test-balsheet-pnl.scm`, `test-trial-balance.scm`, `test-transaction.scm`, `test-equity-statement.scm`, `test-cash-flow.scm`, etc.
- They set `LC_ALL` to `C`, build a test book with `tests/test-engine-extras.scm`, render the report to SXML with `tests/test-report-extras.scm` (`gnc:options->sxml`), and compare exact strings such as `$1,330.00` via XPath (`sxml->table-row-col`).
- `test-trial-balance.scm` explicitly creates a closing transaction with description `"Closing Entries"` and calls `xaccTransSetIsClosingTxn`, then compares `current`, `pre-adj`, and `pre-closing` variants.

### Python tests

`bindings/python/tests/` (`unittest`, run through CTest `python-bindings`) cover `Account`, `Transaction`, `Split`, `Session`, `Query`, numeric, etc. Python bindings are built only with `-DWITH_PYTHON=ON` (default OFF).

### How they run

CMake targets `gnc_add_test` and `gnc_add_scheme_tests` register tests with CTest:

```sh
cmake -G Ninja -DWITH_PYTHON=ON ..
ninja
ctest --output-on-failure        # or: ninja check / ninja distcheck
```

GnuCash CI (`.github/workflows/ci-tests.yml`) runs Ubuntu 22.04 with `TZ=America/Los_Angeles`, builds with Python bindings, and uploads `LastTest.log` on failure. The Arch Docker CI is in `.github/workflows/ci-docker.yml`.

---

## 6. Oracle capabilities: `gnucash-cli` and `python3-gnucash`

### `gnucash-cli --report`

Verified commands (5.14 installed):

```sh
gnucash-cli --report list
gnucash-cli --report show --name "Trial Balance"
gnucash-cli --report run --name "Balance Sheet" --output-file bs.html book.gnucash
gnucash-cli --report run --name "Profit & Loss" --output-file pl.html book.gnucash
gnucash-cli --report run --name "Trial Balance" --output-file tb.html book.gnucash
gnucash-cli --report run --name "General Journal" --output-file gj.html book.gnucash
```

- `--name` accepts a report name **or a report GUID** (tested with the Balance Sheet GUID).
- Output is HTML by default and contains the full rendered document. The report opens the book read-only.
- `--export-type CSV` works only for reports that define an export thunk. **Balance Sheet, Profit & Loss, Income Statement and Trial Balance do not**, so CSV export fails with a list of reports that do support it. HTML parsing is required.
- `--logto /dev/null` is rejected; use a real temp file and clean it. `gnucash-cli` also writes `<book>.<timestamp>.log` transaction logs next to the book, even for read-only report runs.
- Report defaults are the accounting period (calendar year if no accounting period): Balance Sheet as of 12/31, P&L 01/01–12/31, Trial Balance as of 12/31. Titles use locale date formatting.

Report GUIDs (same in 5.14/5.17):

| Report                         | GUID                               |
| ------------------------------ | ---------------------------------- |
| Balance Sheet                  | `c4173ac99b2b448289bf4d11c731af13` |
| Profit & Loss                  | `8758ba23984c40dea5527f5f0ca2779e` |
| Income Statement               | `0b81a3bdfd504aff849ec2e8630524bc` |
| Trial Balance                  | `216cd0cf6931453ebcce85415aba7082` |
| General Journal                | `25455562bd234dd0b048ecc5a8af9e43` |
| Transaction Report             | `2fe3b9833af044abb929a88d5a59620f` |
| Balance Sheet (Multicolumn)    | `065d5d5a77ba11e8b31e83ada73c5eea` |
| Income Statement (Multicolumn) | `0e94fd0277ba11e8825d43e27232c9d4` |
| Reconciliation Report          | `e45218c6d76f11e7b5ef0800277ef320` |

### The custom saved-report trick (important)

`gnucash-cli --report run` cannot set report options on the command line. But GnuCash loads user “saved reports” at startup, and `--report run --name <saved-name>` will run a custom template with arbitrary options. This gives fixed dates, periods, currencies and account selections without patching the book or faking the clock.

Put a file at **`$XDG_DATA_HOME/gnucash/saved-reports-2.8`** (default `~/.local/share/gnucash/saved-reports-2.8`; not `~/.config/gnucash`). `--report list` shows the custom report with a `C` marker. A minimal template that pins a Balance Sheet date:

```scheme
(let ()
  (define (options-gen)
    (let ((options (gnc:report-template-new-options/report-guid
                    "c4173ac99b2b448289bf4d11c731af13" "Balance Sheet")))
      (gnc-set-option (gnc:optiondb options) "General" "Balance Sheet Date"
                      (cons 'absolute (gnc-dmy2time64 31 12 2025)))
      options))
  (gnc:define-report
    'version 1
    'name "Saldima Oracle BS 2025-12-31"
    'report-guid "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    'parent-type "c4173ac99b2b448289bf4d11c731af13"
    'options-generator options-gen
    'menu-path (list gnc:menuname-custom)
    'renderer (gnc:report-template-renderer/report-guid
               "c4173ac99b2b448289bf4d11c731af13" "Balance Sheet")))
```

P&L uses `"General" "Start Date"` / `"End Date"`; Trial Balance uses `"Date of Report"` and `"Report variation"`. Account lists can be selected by filtering `(gnc-account-get-descendants (gnc-get-current-root-account))` and passing a list to `"Accounts" "Accounts"` (verified for the Reconciliation Report). This is the recommended way to get deterministic oracle reports.

### `python3-gnucash`

Python bindings are a **ledger** oracle, not a report engine. They expose:

- `Session(uri, SessionOpenMode.SESSION_READ_ONLY)` — opens read-only and ignores locks.
- `Session(uri, SessionOpenMode.SESSION_NEW_STORE)` — creates a SQLite book.
- `Account`: `GetBalance`, `GetClearedBalance`, `GetReconciledBalance`, `GetBalanceAsOfDate`, `GetBalanceChangeForPeriod`, `GetNoclosingBalanceAsOfDateInCurrency`, `GetNotes`, `SetNotes`, `GetTaxRelated`, `GetTaxUSCode`, `SetIsOpeningBalance`, etc.
- `Transaction`: `BeginEdit`, `SetCurrency`, `SetDate`, `SetDateEnteredSecs`, `SetDescription`, `CommitEdit`, `GetImbalanceValue`, `GetImbalance`, `IsBalanced`, `Void`, `Reverse`, `GetVoidStatus`, `GetReversedBy`, `SetIsClosingTxn`.
- `Split`: `SetAccount`, `SetValue`, `SetAmount`, `SetReconcile`, `SetDateReconciledSecs`, `GetReconcile`, `GetAmount`, `GetValue`, `GetParent`.

Useful examples in the repo: `bindings/python/example_scripts/simple_sqlite_create.py`, `new_book_with_opening_balances.py`, `test_imbalance_transaction.py`.

Caveats: `GetBalanceAsOfDate` is exclusive of the timestamp; pass end-of-day (or next midnight) in the same timezone. A stale `gnclock` row produces `ERR_BACKEND_LOCKED`; use read-only or delete `gnclock` on a copy. Python bindings cannot render reports.

### `gnucash-cli` report HTML shape

The report HTML tables expose:

- account rows: `<td class="anchor-cell"><a href="gnc-register:acct-guid=<32 hex>#">Name</a>`
- amounts: `<td class="number-cell">$1,860.00</td>`
- subtotal/total rows: `class="total-label-cell"` and `class="total-number-cell"`

Parse by **account GUID from the anchor**, not by name (account names are not unique). Use totals labels for report totals. General Journal rows expose `split-guid` anchors and debit/credit columns.

---

## 7. Proposed Saldima accounting verification system

### Layers

1. **Pure TypeScript ledger core** (`packages/gnucash/src`): Money (already exists), accounts, transactions/splits, posting, balances, void/reverse/reconcile, closing. No DOM, Node or GnuCash dependency.
2. **Report calculators**: balance sheet, P&L, trial balance, account balances, General Journal. Return exact rational values plus presentation signs.
3. **Scenario DSL + fixture loader**: declarative books and journal operations; deterministic IDs; no timestamps.
4. **Invariant engine**: structural and semantic checks returning typed violations.
5. **Golden vectors**: the existing `scripts/vectors.ts` contract extended with accounting cases for the iPhone track.
6. **Oracle harness** (`tools/oracle`, test-only): generates a GnuCash SQLite book, runs `gnucash-cli` reports, parses HTML, compares to TS to the cent.
7. **Property-based tests**: fast-check generators for valid and invalid journals, plus a model-based command sequence.
8. **CI**: fast unit/invariant job; containerized oracle job; nightly real-fixture job.

### Scenario DSL / fixture format

Use JSON with fixed-point decimal strings for amounts and ISO dates. Amounts are **raw GnuCash split signs** (positive = debit, negative = credit), so there is no hidden sign convention in the fixture. The DSL should also allow optional `value` and `price` for later multi-currency.

Core shape:

```jsonc
{
  "schemaVersion": 1,
  "id": "02-sale-and-expense",
  "book": {
    "currency": "USD",
    "accounts": [
      { "path": "Assets", "type": "ASSET", "placeholder": true },
      { "path": "Assets:Bank", "type": "BANK", "code": "1000" },
      { "path": "Liabilities:Card", "type": "CREDIT" },
      {
        "path": "Equity:Opening Balances",
        "type": "EQUITY",
        "equityType": "opening-balance"
      },
      { "path": "Income:Sales", "type": "INCOME" },
      { "path": "Expenses:Rent", "type": "EXPENSE" }
    ]
  },
  "operations": [
    {
      "op": "post",
      "id": "open",
      "date": "2025-01-01",
      "description": "Opening Balance",
      "currency": "USD",
      "splits": [
        { "account": "Assets:Bank", "amount": "1000.00" },
        { "account": "Liabilities:Card", "amount": "-200.00" },
        { "account": "Equity:Opening Balances", "amount": "-800.00" }
      ]
    },
    {
      "op": "post",
      "id": "sale",
      "date": "2026-01-15",
      "description": "2026 sale",
      "splits": [
        { "account": "Assets:Bank", "amount": "500.00" },
        { "account": "Income:Sales", "amount": "-500.00" }
      ]
    },
    { "op": "void", "entry": "voidme", "reason": "entered in error" },
    { "op": "reverse", "entry": "rev" },
    {
      "op": "reconcile",
      "entry": "sale",
      "account": "Assets:Bank",
      "flag": "y",
      "date": "2026-02-01"
    }
  ],
  "periods": {
    "asOf": "2026-12-31",
    "pnl": { "start": "2026-01-01", "end": "2026-12-31" }
  }
}
```

Rules:

- A scenario account path maps to a deterministic 32-hex GUID (hash of book ID + path), so oracle HTML anchors and TS output align.
- `amount` is signed; for same-currency books `value` defaults to `amount`. Amounts should be multiples of the commodity fraction; if a fixture supplies sub-unit precision, both Saldima and the oracle must normalise half-up exactly as GnuCash does. For multi-currency, require `value` or a price and balance on values.
- `reconcile` defaults to `n`; `void`/`reverse` are explicit operations so the original entry remains in the model.
- Opening balances are ordinary posts to an equity account with `equity-type: opening-balance`; optionally a `postOpeningBalance` sugar can generate the GnuCash-style transaction.
- Notes/tax/placeholder/hidden slots are optional account fields and must round-trip untouched.
- Invalid scenarios are separate fixtures with an `expectedError` code, not mixed into valid expected outputs.

Expected output JSON should include:

- `ledger.accounts[]`: path, GUID, type, commodity, raw balance, cleared balance, reconciled balance, as-of balance.
- `ledger.transactions[]`: id, GUID, date, description, balanced/imbalance, voided, reversedBy.
- `reports.balanceSheet`: section rows (assets/liabilities/equity), retained earnings, totals.
- `reports.profitLoss`: revenue, expenses, net income.
- `reports.trialBalance`: rows with debit/credit, totals.
- `exact` rationals (`{num,denom}`) for raw values; display strings only in a separate `formatted` section, pinned to a locale.
- No `enter_date`, random GUIDs or timestamps.

### Deterministic expected outputs

Use the same fixed chart, fixed dates and fixed GUIDs. Hand-check the first five scenarios; thereafter generate expected JSON from TS, review it, and have the oracle confirm it. Treat the oracle as an independent check, not the source of truth.

### Invariant checks

Implement as pure functions over the ledger. Suggested codes:

**Structural**

- `UNKNOWN_ACCOUNT`, `ORPHAN_ACCOUNT`, `DUPLICATE_GUID`, `INVALID_DATE`, `TOO_FEW_SPLITS`, `INVALID_RECONCILE_FLAG`, `MISSING_CURRENCY`, `MISSING_COMMODITY`.

**Balancing**

- `UNBALANCED_TRANSACTION` (sum of values ≠ 0, exact).
- `UNBALANCED_CURRENCY` (per-currency when trading accounts are enabled).
- `AMOUNT_VALUE_MISMATCH` (same account commodity and transaction currency, amounts differ beyond SCU; round half-up).
- `IMBALANCE_ACCOUNT_USED` (imported GnuCash repair account present; audit-only).

**Semantic/report**

- `ASSETS_NE_LIABILITIES_PLUS_EQUITY`.
- `RETAINED_EARNINGS_MISMATCH` (`RE = -(Σ income + Σ expense)` for unclosed books; explicit closing accounts handled separately).
- `TRIAL_BALANCE_NOT_ZERO` (debit total ≠ credit total).
- `REPORT_TOTAL_MISMATCH` (report total ≠ sum of leaf account values).
- `PNL_NET_MISMATCH` (net ≠ revenue − expenses).
- `VOID_NOT_ZERO` (voided split amount/value non-zero or flag not `v`).
- `REVERSAL_NOT_OPPOSITE` (original + reversal per account ≠ 0, or missing `reversed-by`).
- `RECONCILED_SUM_MISMATCH` (cleared/reconciled sums do not match flags).
- `CLOSING_ACCOUNT_DOUBLE_COUNT` (explicit retained-earnings account plus non-zero computed RE without a closing model).

Use two modes:

- **Strict (Saldima writes):** any violation rejects the write with a typed error.
- **Audit (imports):** violations become findings, because real GnuCash books can contain imbalances or repair accounts; show them and offer repair.

### GnuCash oracle pipeline

Two channels are useful:

**A. Book generation + ledger check (clean process boundary)**

- Use a checked-in **blank GnuCash SQLite template** generated once by a pinned GnuCash version (record its SHA and version).
- `tools/oracle/gen_book.ts` or `.py` copies the template, clears `gnclock`, and inserts accounts/transactions/splits with deterministic GUIDs using only Python’s stdlib `sqlite3` or Node’s SQLite driver. It writes slots for notes/tax/opening-balance/placeholder/features when needed.
- `tools/oracle/dump_ledger` reads the book with plain SQL and computes raw/cleared/reconciled/as-of balances, split sums and transaction balance; this is a second independent implementation, not GnuCash code.
- This avoids importing GPL Python bindings entirely and gives fixed GUIDs and deterministic files.
- For development convenience, a Python-bindings generator/dumper can exist behind a flag; it is a separate process and not required in CI.

**B. Report check (GnuCash CLI as external program)**

- Generate a scenario-specific `saved-reports-2.8` with one custom template per variant: BS at as-of, P&L for the period, TB at as-of, General Journal, optional Reconciliation Report with an account selection.
- Run in a temp directory with:

```sh
HOME=/tmp/gnc-home
XDG_DATA_HOME=/tmp/gnc-data
XDG_CONFIG_HOME=/tmp/gnc-config
TZ=UTC LC_ALL=C LANG=C
gnucash-cli --logto /tmp/gnc.log --report run --name "Saldima Oracle <id> BS" \
  --output-file /tmp/out/bs.html /tmp/out/book.gnucash
```

- Parse HTML rows by `acct-guid`; map totals by label/class. Normalize to integer cents and compare with TS to the cent. Compare exact rationals separately from the ledger dump.
- Assert report totals tie to the leaf sums from both the oracle book and the TS ledger; this catches report-level bugs, not just arithmetic.

**Parsing and comparison rules**

- Account identity: GUID first, full path fallback.
- Amount parsing: strip `$`, commas and NBSP; support leading `-` and parentheses; parse to BigInt cents; never use JS `number`.
- Sign normalization: BS liabilities/equity/RE and P&L revenue are displayed natural-positive; TS should produce the same presentation values, while raw ledger uses GnuCash signs. Keep both and test the conversion.
- Zero rows: compare all expected leaf accounts; allow extra zero rows optionally, or mirror GnuCash’s account-inclusion rule exactly.
- Labels can flip (`Retained Losses`, `Unrealized Losses`); map by account GUID/total key, not label text.
- Ignore report titles/dates in numeric comparisons; validate dates separately.

### CI in a container without linking GPL code

- **Unit/invariant job:** Node image, `pnpm test:unit`; no GnuCash.
- **Oracle job:** Ubuntu 26.04 container (pin image digest) with `gnucash`, `python3-gnucash` (optional), `sqlite3`; copy the repo, `pnpm install --frozen-lockfile`, run `pnpm test:oracle`.
- `pnpm test:oracle` checks `gnucash-cli --version` and skips with a clear message if absent; CI requires it.
- Oracle scripts live under `tools/oracle/` with SPDX headers; they are test-only, not part of `packages/*`, not published, and never imported by the Workers app. GnuCash is invoked via `child_process`; no native addon, no SWIG binding, no GPL code in the build.
- Set isolated `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`; temp book copies; delete `gnclock`; clean logs; use `SESSION_READ_ONLY` if bindings are used.
- Nightly: run the oracle against real anonymised fixtures and both GnuCash 4.14 and 5.x images (4.14 needs an older distro or a pinned build; optional).
- Add a `NOTICE`/README line: GnuCash is a separate GPL program used only in tests; Saldima contains no GnuCash source.

### fast-check / property-based testing

- Use `fast-check` + Vitest; keep `bigint` cents (`fc.bigInt` / `fc.integer`) and never `number` for money.
- Valid generator: fixed 2–3-level chart; choose 2–5 distinct accounts; generate n−1 signed cent amounts and set the last to the exact negative sum; assign dates in a window; optional memo/action/reconcile flag. This makes `sum(values) = 0` true by construction.
- Invalid generator: mutate the last split by ±1 cent; remove a split; use an unknown account; duplicate a GUID; set amount ≠ value for same-currency; invalid date; invalid flag. Assert the typed error code.
- Model-based sequence with `fc.commands`: post / void / reverse / reconcile. Maintain an expected model of balances and flags; after each command assert invariants. Properties: account balances unchanged by void; reverse leaves balances unchanged; reconcile only changes cleared/reconciled sums; TB stays balanced.
- Money properties: add commutative/associative, negate involution, parse/format round-trip, monotonic formatting.
- Oracle property: sample 5–10 generated valid journals, build books, run the three reports, compare; small `numRuns` in CI, larger nightly. Log the seed.

### Recommended file layout

```
packages/gnucash/src/
  money.ts, guid.ts, versions.ts          # existing
  ledger.ts                               # Account/Transaction/Split types
  journal.ts                              # posting, void, reverse, reconcile
  balances.ts                             # raw/cleared/reconciled/as-of
  format.ts                               # half-up report formatting
  invariants.ts                           # typed invariant report
  scenario.ts                             # DSL parse/validate
  reports/balance-sheet.ts
  reports/profit-loss.ts
  reports/trial-balance.ts
  reports/general-journal.ts
  *.test.ts

fixtures/
  scenarios/
    01-opening-balances.json
    02-sale-and-expense.json
    03-split-sale-tax-and-payment.json
    04-void-and-reverse.json
    05-reconcile-flags.json
  expected/
    <scenario>.ledger.json
    <scenario>.reports.json
  vectors/
    accounting.json                       # iPhone-replayable golden vectors
  gnucash/
    blank-5.14.gnucash                    # pinned blank SQLite template + SHA

tools/oracle/
  gen_book.ts | gen_book.py               # scenario -> SQLite book (stdlib SQL)
  dump_ledger.ts | dump_ledger.py         # exact ledger JSON from SQL
  saved_reports.ts                        # generate saved-reports-2.8
  run_reports.sh                          # env-isolated gnucash-cli
  parse_report.ts                         # HTML -> normalized JSON by GUID
  compare.ts                              # TS vs oracle diff
  Dockerfile.oracle
  README.md                               # license/process boundary notes

scripts/vectors.ts                        # extend with accounting vectors
scripts/oracle.ts                         # pnpm test:oracle entry point
.github/workflows/oracle.yml              # containerized oracle job
```

### First five scenarios (verified against GnuCash 5.14)

All are USD, single currency, dates 2025/2026. Amounts below are the exact HTML report values observed from `gnucash-cli`; raw ledger signs are shown in the last column.

| #   | Scenario                        |   Assets | Liabilities | Retained earnings | Total equity |      L&E | P&L revenue | P&L expenses | P&L net | TB debit = credit | Ledger notes                                                                                                               |
| --- | ------------------------------- | -------: | ----------: | ----------------: | -----------: | -------: | ----------: | -----------: | ------: | ----------------: | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `01-opening-balances`           | 1,000.00 |      200.00 |              0.00 |       800.00 | 1,000.00 |        0.00 |         0.00 |    0.00 |          1,000.00 | Bank +1000, Card −200, OB −800                                                                                             |
| 2   | `02-sale-and-expense`           | 1,530.00 |      200.00 |            530.00 |     1,330.00 | 1,530.00 |      500.00 |       120.00 |  380.00 |          1,700.00 | 2025 sale 200, rent 50; 2026 sale 500, rent 120; RE includes 2025 net 150                                                  |
| 3   | `03-split-sale-tax-and-payment` | 1,280.00 |      180.00 |            300.00 |     1,100.00 | 1,280.00 |      300.00 |         0.00 |  300.00 |          1,280.00 | 3-split sale 330 / −300 / −30 (tax); pay card 50                                                                           |
| 4   | `04-void-and-reverse`           | 1,380.00 |      200.00 |            380.00 |     1,180.00 | 1,380.00 |      500.00 |       120.00 |  380.00 |          1,500.00 | void rent 77 (zero), reverse rent 55 (pair nets zero); General Journal excludes void, shows reversal pair and totals 1,730 |
| 5   | `05-reconcile-flags`            | 1,680.00 |      200.00 |            680.00 |     1,480.00 | 1,680.00 |      800.00 |       120.00 |  680.00 |          1,800.00 | Bank cleared 800, reconciled 300; raw Bank 1680                                                                            |

These five cover opening balances, prior-year vs current-year P&L, retained earnings, split transactions, liabilities and payments, void/reverse, and reconcile flags. Add a sixth `06-closing-entry` when closing semantics are implemented.

---

## 8. Risks and uncertainties

1. **HTML report layout is presentation, not an API.** Classes, labels, table nesting and zero-row rules can change between versions. Keep the parser small, version-gated, and fail loudly with the raw HTML on mismatch.
2. **Locale and formatting.** `LC_ALL=C` gives `$1,860.00`, `12/31/26`, English labels. Other locales change decimal separators, currency placement, negative parentheses and month names. Always force `TZ=UTC`, `LC_ALL=C`/`C.UTF-8`, `LANG=C`, isolated config; never parse titles.
3. **Rounding mismatch.** GnuCash stores postings at commodity/currency fraction and rounds half-up. Saldima’s `money.ts` `roundToFraction` currently rounds half-to-even; a 2.665 USD entry becomes 2.67 in GnuCash but 2.66 in Saldima. Use half-up for posting normalisation and report display; keep half-even only where GnuCash explicitly uses `GNC_HOW_RND_ROUND` (some price-database operations).
4. **Date semantics.** As-of balances are computed against a time64 and `xaccAccountGetBalanceAsOfDate` is exclusive; reports pass end-of-day. SQLite posted times are normalised to 10:59 local. Use calendar-day semantics in Saldima and end-of-day in the oracle; a UTC container avoids DST surprises.
5. **Version drift.** Research source is 5.17; the installed oracle is 5.14. Table versions are stable, but report labels/layout and closing/void edge cases can differ. 4.14’s report code was rewritten for 5.x and may format or order rows differently. Pin the oracle image and assert its version.
6. **Default report options are not controllable from the CLI alone.** The saved-report file solves this, but its Scheme syntax is not a public API. Generate it from a small, reviewed template; verify with `--report list` and a smoke report.
7. **Transaction Report defaults to no accounts.** Use General Journal for transaction-level CLI checks, or a custom saved report with an account list.
8. **Retained earnings vs explicit closing accounts.** GnuCash computes RE from income/expense balances on the balance sheet; an explicit `Retained Earnings` equity account plus non-zero income/expense can double count. Legacy BS/P&L use description matching; multicolumn uses the `book_closing` KVP. Decide Saldima’s model and document it; test both unclosed and closed books.
9. **Zero-balance row inclusion.** Accounts with future activity can appear as `$0.00` as of an earlier date. Compare expected leaf accounts and allow extra zero rows, or replicate GnuCash’s inclusion rule exactly.
10. **Direct SQL patching is fragile.** Hidden/placeholder are both columns and KVP; frames have child GUIDs; features are a GLIST; locks are a `gnclock` row. Use a pinned blank template + fixed GUIDs, or Python bindings, and validate the generated book by loading it with GnuCash.
11. **Locking and logs.** A stale `gnclock` causes `ERR_BACKEND_LOCKED`; never run concurrent sessions on one book. `gnucash-cli` writes `.log` files even read-only; use a temp copy and clean up.
12. **GPL process boundary.** `gnucash-cli` and `python3-gnucash` are GPL. Keep them external; do not vendor or copy. AGPL-3.0-only Saldima can host the test harness, but the product build must not link GnuCash.
13. **Multi-currency is a separate problem.** Value vs amount, trading accounts, prices, unrealised gains and report-currency conversion need price fixtures and real books; do not fold it into the P0 single-currency oracle.

---

## 9. What can be built now vs what needs real fixtures

**Can build now (synthetic, deterministic):**

- Scenario DSL and validator.
- TypeScript ledger core with posting/void/reverse/reconcile/closing.
- BS/P&L/TB/General Journal calculators and presentation signs.
- Invariant engine with typed errors.
- Blank-template SQL book generator with fixed GUIDs.
- `gnucash-cli` runner, custom saved-report generator, HTML parser, cents comparator.
- First five scenarios and their expected JSON.
- fast-check valid/invalid/model-based tests.
- CI oracle job with GnuCash 5.14 (or pinned 5.17 image).

**Needs real fixtures or owner input:**

- The ~20 MB anonymised GnuCash 5.x book for the P0 spike.
- Business features: invoices, bills, customers/vendors, tax tables, lots/capital gains.
- Scheduled transactions, budgets, prices and stock splits.
- Multi-currency and stock portfolios (value/amount/price/trading accounts).
- Real-world edge cases: duplicate account names, Unicode, non-USD currencies, non-standard SCU, legacy CHECKING/SAVINGS types, existing closing entries, repair/imbalance accounts.
- Exact parity against GnuCash 4.14 and 5.17 binaries if the oracle image uses 5.14.
- XML-backend books and GnuCash-created locale templates.

## 10. Bottom line

GnuCash’s core invariant is simple and testable: **split values sum to zero per transaction; account balances are sums of split amounts; liabilities/equity/income are presented with reversed signs; retained earnings is the negative of income+expense balances.** The report layer is a set of thin calculators over that ledger, but its HTML output, default periods, closing-entry handling and locale formatting are the fragile parts.

The practical verification system is therefore: a deterministic scenario DSL and pure TS ledger/report core; a GnuCash oracle that generates a SQLite book (prefer a pinned blank template plus stdlib SQL over GPL imports), runs `gnucash-cli` with custom saved reports for fixed dates, parses HTML by account GUID, and compares integer cents; plus exact ledger checks from SQL and property-based generation of valid and invalid journals. The first five scenarios above are verified against GnuCash 5.14 and can be implemented immediately; real anonymised books are needed for business features, multi-currency and the 20 MB spike.
