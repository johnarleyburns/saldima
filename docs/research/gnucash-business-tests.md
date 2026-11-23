<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# GnuCash automated tests and business-accounting coverage

**Research target:** `/tmp/opencode/gnucash-src`, GnuCash 5.17 (`e72b724`). Read for behaviour only; no GnuCash code is copied.

**Bottom line**

- GnuCash has useful **engine-level** tests for double-entry transactions, invoices/bills and tax-table entry arithmetic, plus good **single-report** tests for invoices, owner/AR aging, GST/VAT and budgets.
- It has **no end-to-end business workflow test** and **no hypothetical two-year business fixture**. The closest things are a synthetic multi-year personal-income fixture (`create-test-data`) and an 8-invoice business fixture (`create-test-invoice-data`), each used to test individual reports.
- There are **no tests at all** for depreciation, deferred revenue, partnership capital/basis, monthly close, or a full annual close workflow. Those are manual accounting workflows in GnuCash, not modules. GnuCash's built-ins are invoices/bills, customers/vendors/employees/jobs, tax tables, AR/AP control accounts, lots/payments, owner and aging reports, budgets, scheduled transactions, accounting-period freeze, and the Close Book tool.
- The biggest functional gap for Saldima is **statement-level business verification**: invoice → payment → AR aging → trial balance → balance sheet → close → partner capital roll-forward is never asserted as a chain.

---

## 1. Inventory of automated tests

Approximate scale: about **558 assertions in the standard report tests**, **259 in report-core tests**, **620 gtest/GNC_TEST_ADD registrations in the engine tests**, **96 Python test methods**, and **122 Guile test assertions**. There is no `gnucash/gnucash/test` directory; app-level tests live under `gnucash/gnome/test`, `gnucash/gnome-utils/test` and `gnucash/register/ledger-core/test`.

All of these are registered with CMake/CTest via `gnc_add_test` and `gnc_add_scheme_tests` (`common/cmake_modules/GncAddTest.cmake`), so `ninja check` or `ctest --output-on-failure` runs them. Scheme tests run inside the GnuCash Guile environment against a programmatically built book; Python binding tests run as the CTest target `python-bindings` when `-DWITH_PYTHON=ON`.

### Engine tests (`libgnucash/engine/test`)

Business-relevant files and test names:

| File                                                                                  | Test names / coverage                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `utest-Invoice.c`                                                                     | `post/unpost`; `doclink`; `post trans - vendor bill`; `post trans - vendor credit note`; `post trans - customer creditnote`; `post trans - customer invoice`; `tests txntype I & P`; `tests txntype L`. Asserts one split per control account and account balance equals invoice total. |
| `utest-Entry.c`                                                                       | `basics`; `value rounding`. Builds a 10% VAT tax table and checks invoice/bill entry values with tax included/excluded and value/percentage tax types.                                                                                                                                  |
| `utest-Budget.c`                                                                      | budget name, description, number of periods, data retention, recurrence, account-period value. No budget-vs-actual report assertions (those are in `test-budget.scm`).                                                                                                                  |
| `utest-Transaction.cpp`                                                               | `xaccTransGetImbalanceValue`, `xaccTransGetImbalance`, `xaccTransGetImbalance Trading Accounts`, `xaccTransIsBalanced`, `xaccTransIsBalanced Trading Accounts`, account value/amount/conversion, clone/copy, KVP.                                                                       |
| `utest-Account.cpp`                                                                   | account create/destroy, root account, recompute balance, insert/remove split, descendants, lookup, KVP, type compatibility. Includes a reconciled/cleared balance test around `YREC`/`FREC`.                                                                                            |
| `utest-Split.cpp`                                                                     | `xaccSplitSetAmount`, `SetValue`, `SetBaseValue`, `SetSharePriceAndAmount`, conversion, ordering, correspondence accounts, void former values.                                                                                                                                          |
| `test-transaction-reversal.cpp`                                                       | Random transaction reversal checks (old test framework): reverse, balance, amounts/values.                                                                                                                                                                                              |
| `test-transaction-voiding.cpp`                                                        | Random void/unvoid checks: zeroed amounts/values, former values, restore.                                                                                                                                                                                                               |
| `test-split-vs-account.cpp`                                                           | Split/account insertion and relationship checks. Mostly minimal/old.                                                                                                                                                                                                                    |
| `gtest-scrub.cpp`                                                                     | `zero_imbalance_split_removed_when_balanced`, `zeroed_imbalance_split_removed_on_edit`, `zero_imbalance_split_with_memo_kept`, `zero_imbalance_split_with_action_kept`, `zero_split_in_ordinary_account_kept`, `needed_imbalance_split_kept`.                                           |
| `test-lots.cpp`                                                                       | Automatic lot scrubbing and lot KVP. Minimal, random-data based.                                                                                                                                                                                                                        |
| `test-customer.c`, `test-vendor.c`, `test-employee.c`, `test-job.c`, `test-address.c` | Basic CRUD/property tests for business objects. No invoice/payment posting.                                                                                                                                                                                                             |
| `test-engine-kvp-properties.c`                                                        | KVP properties for Account, Transaction, Split, Lot, Customer, Employee, Job, Vendor.                                                                                                                                                                                                   |
| `test-business.c`                                                                     | **Effectively disabled.** The old test body is inside `#if 0`; `main()` returns without running `test_business()`. It is still registered in CMake.                                                                                                                                     |

There is no test for `dialog-book-close.c` (the Close Book tool), `gnc-accounting-period.c` beyond date-option plumbing, or a close-book workflow.

### Report tests (`gnucash/report/reports/standard/test`, `gnucash/report/test`)

Business-relevant standard reports:

| File                                                                                                                                                      | Assertions | Coverage                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-invoice.scm`                                                                                                                                        |         39 | Three invoice variants (invoice, easy, fancy), eight invoice documents, customer/vendor/employee, jobs, tax tables, discounts, bill terms, order reference, exact invoice amounts, `gncInvoiceIsPaid`. Vendor bills and credit notes are printed, but not AP-aged.                  |
| `test-owner-report.scm`                                                                                                                                   |          9 | Customer owner report with invoices, credit notes, partial payments, a fully paid invoice and a $200 invoice. Asserts invoice/payment lines, running balance and an **embedded AR aging table**: `$0.00 $6.75 $1.00 $8.50 $7.50 $8.00 $31.75`. Customer only; no vendor/AP variant. |
| `test-new-owner-report.scm`                                                                                                                               |         18 | Detailed invoice/payment/credit-note/refund lines, lot-linked payments, prepayment and period totals. Customer only.                                                                                                                                                                |
| `test-income-gst.scm`                                                                                                                                     |          9 | Manual invoice/receipt/credit-purchase/payment transactions, GST and UK VAT. Exact totals: `$1,055.00` grand total, `$1,000.00` sales, `$55.00` output tax, `$248.00` purchases, `$230.00` input tax, `$18.00` tax payable. Includes a closing transaction.                         |
| `test-trial-balance.scm`                                                                                                                                  |         21 | `current`, `pre-adj`, `pre-closing`/work-sheet variants; closing and adjusting entries; exact debits/credits; foreign-currency unrealised loss.                                                                                                                                     |
| `test-equity-statement.scm`                                                                                                                               |          8 | Generic equity statement: capital, net income, investments, withdrawals, unrealised, increase in capital, ending capital. No partner concept.                                                                                                                                       |
| `test-budget.scm`                                                                                                                                         |         31 | Budget report, budget income statement and budget balance sheet; exact budget/actual/difference cells; existing/new retained earnings; budget notes. Six budget periods, not 24.                                                                                                    |
| `test-transaction.scm`                                                                                                                                    |        118 | Transaction report filters, sorting, void and closing filters, subtotals, CSV export, invoice column, reconciliation report. Includes full-year monthly income/expense data and year-end bank total `$2,280.00`.                                                                    |
| `test-balsheet-pnl.scm`                                                                                                                                   |         84 | Multi-period balance sheet/P&L, multi-currency, stocks/funds, price sources, retained earnings ($1,270), row headers, zero balances. Multi-year investment-heavy personal fixture, not business documents.                                                                          |
| `test-account-summary.scm`                                                                                                                                |          7 | Account summary and Future Scheduled Transactions Summary. The FSTS fixture is **empty** (`$0.00` rows), so scheduled-transaction reporting is not meaningfully tested.                                                                                                             |
| `test-investment-lots.scm`                                                                                                                                |         68 | Lot/investment cost basis, stock splits, CAGR/gain/ROI helpers. “Basis” here means securities cost basis, not partnership basis.                                                                                                                                                    |
| `test-portfolios.scm`                                                                                                                                     |          9 | Advanced portfolio basis methods (average/FIFO/FILO).                                                                                                                                                                                                                               |
| `test-ifrs-cost-basis.scm`                                                                                                                                |         17 | IFRS cost-basis report.                                                                                                                                                                                                                                                             |
| `test-register.scm`                                                                                                                                       |         22 | Register report with transactions.                                                                                                                                                                                                                                                  |
| `test-average-balance.scm`                                                                                                                                |          8 | Average daily/monthly balance calculations.                                                                                                                                                                                                                                         |
| `test-cash-flow.scm`                                                                                                                                      |     custom | `test-one-tx-in-cash-flow`, `test-one-tx-skip-cash-flow`, `test-both-way-cash-flow`.                                                                                                                                                                                                |
| `test-charts.scm`, `test-standard-net-barchart.scm`, `test-standard-net-linechart.scm`, `test-standard-category-report.scm`, `test-cashflow-barchart.scm` | 12–26 each | Charts, income/expense and net-worth series; closing transactions ignored in some cases.                                                                                                                                                                                            |
| `test-stress-options.scm`                                                                                                                                 |          3 | Runs most reports on empty and populated books, cycling options. Its own header states: **“No testing of report output is actually done.”**                                                                                                                                         |

Report-core tests (`gnucash/report/test`): `test-report-utilities.scm` covers balances at dates, interval balances, closing-aware balances, date boundaries, commodity collectors, monetary formatting; `test-report-html.scm` covers HTML/SXML rendering; `test-report.scm` covers report registration, serialization, export types; `test-commodity-utils.scm`, `test-html-chart.scm`, `test-html-fonts.scm`, `test-html-utilities-srfi64.scm`.

### Import/export tests

| Area               | Files / tests                                                                                                                                  | Business coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV import         | `gnucash/import-export/csv-imp/test/test-tokenizer.cpp`, `gtest-gnc-imp-props-tx.cpp` (`ParseMonetary`), `test-tx-import.cpp`                  | Tokenizer and monetary parsing only. `test-tx-import.cpp` is a 68-line fixture with no actual tests. No end-to-end transaction import, matching or posting.                                                                                                                                                                                                                                                                                                                   |
| CSV export         | `csv-exp/test/test-csv-export-helpers.cpp`                                                                                                     | `EmptyTests`, `BasicTests`, `ForcedQuote`; no business report export.                                                                                                                                                                                                                                                                                                                                                                                                         |
| QIF                | `qif-imp/test/test-qif-parse.scm`, `test-qif-imp.scm`, `test-qif-merge-groups.scm`                                                             | Parse dates/numbers/categories/actions, duplicate matching. No invoices/AR/AP.                                                                                                                                                                                                                                                                                                                                                                                                |
| OFX                | `ofx/test/test-link.c`                                                                                                                         | Link/module smoke test only.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Generic import     | `import-export/test/gtest-import-account-matcher.cpp`, `gtest-import-backend.cpp`, `gtest-import-parse.cpp`, `test-import-pending-matches.cpp` | Account matching (`test_simple_match`, `test_noisy_match`, `test_match_with_subaccounts`, `test_subaccount_match`, `test_subaccount_match_trailing_noise`, `test_subaccount_no_match`, `test_subaccount_match_trailing_space`, `test_subaccount_match_trim_trailing_space`, `test_subaccount_match_internal_space`), date/number parsing, pending matches (`match_types`, `prefer_manual_match`, `keeps_count`), backend `CreateTransInfo`. No posting to business documents. |
| AQB/HBCI           | `aqb/test/test-aqb.c`, `test-kvp.c`, `file-book*.gnucash`                                                                                      | Session/KVP round-trip, not business accounting.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Customer/bi import | `gnucash/import-export/customer-import`, `bi-import`                                                                                           | No tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Python and Guile binding tests

Python (`bindings/python/tests`, `unittest`, 96 methods):

- `test_business.py`: `test_equal`, `test_employee_name`, `test_post`, `test_owner`, `test_commodities`, `test_invoice_transaction`, `test_invoice_payment`. Creates a customer invoice for $100, posts to A/R, checks posted transaction/invoice round-trip, applies a $100 payment, asserts A/R becomes zero.
- `test_account.py`, `test_book.py`, `test_split.py`, `test_transaction.py`, `test_query.py`, `test_numeric.py`, `test_price_and_wrapping.py` (including `GetNoclosingBalance`).
- No report rendering in Python bindings.

Guile (`bindings/guile/test`):

- `test-business-core.scm`: builds multi-currency customer invoices, jobs, VAT tax tables, posts invoices, applies partial and full payments, creates credit notes, and asserts owner name/address/ID helpers. No aging or statement assertions.
- `test-engine-extras.scm`: the main fixture library, including `create-test-data`, `create-test-invoice-data`, `create-stock-test-data`, `create-budget-and-transactions`, account-tree builders, transaction builders.
- Other tests cover option DB, queries, KVP, dates, engine bindings.

### App-level / GUI-adjacent tests

- `gnucash/gnome/test/test-invoice-report-builtin-default.cpp`: invoice report default GUID and the list of built-in invoice templates; no amounts.
- `gnucash/gnome/test/gtest-assistant-stock-transaction.cpp`: stock transaction assistant failure modes and aggregation; not business AP/AR.
- `gnucash/register/ledger-core/test/test-split-register.c`, `utest-split-register-copy-ops.c`: register mechanics, not business workflows.
- `gnucash/gnome-utils/test/test-load-gnome-utils-module.scm`: module load only.

### Test data / books

- `libgnucash/backend/dbi/test/test-dbi.xml`: XML book with customer, vendor, tax table and a vendor bill/invoice; used for SQL save/reload and object-equality comparisons, not posting or statements.
- `libgnucash/backend/xml/test/test-files/xml-contents/xml-datafile.gnucash`; `load-save/sample1.gnucash`; `load-save/bug-746937-sx-split-order.gnucash` (scheduled transaction split order).
- `gnucash/import-export/aqb/test/file-book.gnucash`, `file-book-hbcislot.gnucash`: HBCI/KVP sessions.
- `gnucash/import-export/csv-imp/test/sample1.csv`; QIF and CSV examples in `doc/examples` (`taxreport.gnucash`, `invoice.csv`, `customers_import.csv`, numerous `.qif`).
- **No full business book and no multi-year business fixture.**

---

## 2. Is there a hypothetical business fixture or a whole-year scenario?

**No single “hypothetical business” fixture exists.** What exists:

1. **`create-test-data`** in `bindings/guile/test/test-engine-extras.scm`
   - A synthetic personal/multi-currency book: Bank, GBP Bank, Wallet, Income, Income-GBP, Expenses, Liabilities, Equity.
   - Old transactions from 1969–1971, a closing transaction in 1977, foreign-currency transfers in 2000, and a **12-month loop for 1978** posting monthly GBP income, USD income and expenses.
   - Used by balance sheet/P&L, trial balance, equity statement, transaction report, account summary, budget, cash-flow and stress tests.
   - `test-transaction.scm` asserts the current-year monthly pattern yields a year-end bank total of **$2,280.00**.
   - This is a full-year _report_ fixture, not a business (no invoices, AR/AP, depreciation, deferred revenue or close).

2. **`create-test-invoice-data`** in the same file
   - Eight business documents: customer invoice, customer job invoice, vendor bill, employee bill, customer credit note, vendor credit note, employee credit note, and a complex customer invoice with eight tax/discount combinations.
   - Customer/vendor/employee/job masters, VAT tax tables, bill terms, an order, posted dates in September 1980, and a full payment for invoice 8 ($17,479.18).
   - Used by `test-invoice.scm`, `test-owner-report.scm`, `test-transaction.scm` (invoice column), and `test-stress-options.scm`.
   - It is an **invoice-document fixture**, not a year of operations, and no test asserts a balance sheet, P&L, trial balance or close from it.

3. **`create-budget-and-transactions`**
   - Creates a six-period budget and matching actual transactions plus one closing transaction.
   - Used by `test-budget.scm` for budget report, budget income statement and budget balance sheet.
   - Not a business scenario and not a full year.

**How they are built and asserted:** entirely in Scheme in the test process; there are no golden HTML/JSON files. Reports are rendered to SXML with `tests/test-report-extras.scm` (`gnc:options->sxml`) and queried with XPath (`sxml->table-row-col`, `sxpath`). Expected values are inline Scheme lists of formatted strings. `LC_ALL=C` is set for deterministic formatting.

---

## 3. Coverage by accounting area

| Area                                            | GnuCash tests                                                                                                                                                                                                                                                                                     | Coverage                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Double-entry, imbalance, trading accounts       | `utest-Transaction`, `gtest-scrub`, reversal/voiding tests                                                                                                                                                                                                                                        | Strong engine-level                                               |
| Void/reverse                                    | `utest-Transaction`, `test-transaction-reversal`, `test-transaction-voiding`, transaction report void filters                                                                                                                                                                                     | Good                                                              |
| Invoice/bill posting                            | `utest-Invoice` (four document types), Python `test_business`, DBI round-trip                                                                                                                                                                                                                     | Good single-document                                              |
| Invoice payment / AR                            | Python `test_invoice_payment` ($100 → $0), owner reports, `utest-Invoice` payment/link txn types                                                                                                                                                                                                  | Good for one invoice, not statement-level                         |
| AP / vendor bills                               | `utest-Invoice` vendor bill/credit note; invoice print for vendor bills                                                                                                                                                                                                                           | Weak; no AP aging, no AP statement                                |
| AR aging                                        | `test-owner-report` embedded aging table                                                                                                                                                                                                                                                          | Partial: one customer, one date, five buckets                     |
| AP aging                                        | None                                                                                                                                                                                                                                                                                              | **None**                                                          |
| Standalone `Receivable Aging` / `Payable Aging` | Only `test-stress-options` smoke run; no assertions                                                                                                                                                                                                                                               | **None/weak**                                                     |
| Tax tables / VAT / GST                          | `test-income-gst` exact totals; invoice tax/discount combinations; `utest-Entry` rounding                                                                                                                                                                                                         | Good report-level                                                 |
| US Tax Schedule / TXF                           | No test                                                                                                                                                                                                                                                                                           | **None**                                                          |
| Budgets                                         | `test-budget` exact budget/actual/BS/IS; `utest-Budget`                                                                                                                                                                                                                                           | Good for six periods, personal fixture                            |
| Scheduled transactions                          | `libgnucash/app-utils/test/test-sx.cpp`: `test_basic`, `test_empty`, `test_once`, `test_state_changes`, `test_auto_create_transactions` with `make_one_transaction`, `make_one_zero_transaction`, `make_one_empty_transaction`, `make_one_empty_transaction_with_txcurr`; XML SX split-order test | Engine-level; FSTS report test is empty; no statement integration |
| Monthly close                                   | No test                                                                                                                                                                                                                                                                                           | **None**                                                          |
| Annual close / closing entries                  | Trial balance variants, equity statement, transaction closing filters, net-barchart closing test                                                                                                                                                                                                  | Partial report-level; **no Close Book workflow test**             |
| Retained earnings                               | `test-balsheet-pnl` multi-period ($1,270), `test-budget` existing/new retained earnings                                                                                                                                                                                                           | Partial; no close→retained earnings roll-forward                  |
| Partnership basis / capital                     | `test-equity-statement` generic capital/withdrawals; no partner concept                                                                                                                                                                                                                           | **No partnership coverage**                                       |
| Depreciation / fixed assets                     | None                                                                                                                                                                                                                                                                                              | **None**                                                          |
| Deferred revenue                                | None                                                                                                                                                                                                                                                                                              | **None**                                                          |
| Payroll / inventory / COGS                      | None                                                                                                                                                                                                                                                                                              | **None**                                                          |
| Multi-year business statements                  | None                                                                                                                                                                                                                                                                                              | **None**                                                          |
| Business import                                 | CSV tokenizer/monetary only; QIF parse/merge; no invoice/bill import                                                                                                                                                                                                                              | **Weak**                                                          |
| Reconciliation report                           | `test-transaction.scm` exact reconciled/cleared/unreconciled totals                                                                                                                                                                                                                               | One small scenario                                                |

Notable specifics:

- **Retained earnings:** `test-balsheet-pnl.scm` checks multi-period rows and a retained-earnings figure; `test-budget.scm` checks “Existing Retained Earnings” and “New Retained Earnings”. Neither posts a close and then checks the roll-forward.
- **Annual close:** tests simulate closing by description pattern and/or `xaccTransSetIsClosingTxn`, but never exercise `dialog-book-close.c`, which creates the real closing transactions and sets `book_closing`.
- **Monthly close:** the only accounting-period coverage is option parsing/date-option plumbing; there is no monthly close checklist, accrual or lock test.
- **AP aging:** the built-in `Payable Aging` report exists (`new-aging.scm`, GUID `payables-aging-guid`), but no test asserts its output. AR aging is only tested indirectly through the customer owner report, which relies on invoice lots/owners.
- **Manual AR/AP:** the aging report maps splits to owners via lots/invoices. Plain journal entries to an A/R account without lots/owners will not produce a meaningful aging report. This matters for Saldima: manual AR/AP and GnuCash business AR/AP are different models.

---

## 4. How report and business tests assert numbers

### Report tests

`gnucash/report/test/test-report-extras.scm` provides:

- `gnc:options->render`: builds a report from a GUID and options, renders HTML, writes a debug HTML file under `/tmp`.
- `gnc:options->sxml`: wraps the render in `xml->sxml`, so tests query an SXML tree.
- `sxml->table-row-col`: XPath helper for “table N, row R, column C”.

Assertions are inline `test-equal`/`test-assert` forms with exact formatted strings (`$1,860.00`, `-$111.00`) and sometimes cell counts to catch layout changes. Dates are pinned with absolute dates or ISO format; `LC_ALL=C` is set. There are **no golden report files** and no HTML snapshot files. Business-invoice tests additionally use table IDs such as `entries-table`, `client-table`, `invoice-details-table`.

### Engine/business tests

- `utest-Invoice.c` posts documents and asserts:
  - exactly one split in each control account (`account_has_one_split`),
  - `xaccAccountGetBalance` equals `gncInvoiceGetTotal` with the correct sign for customer vs vendor and invoice vs credit note,
  - transaction types `TXN_TYPE_INVOICE`, `TXN_TYPE_PAYMENT`, `TXN_TYPE_LINK`,
  - post/unpost state and doc links.
- Python `test_business.py` asserts invoice posted state/date, owner/commodity links, posted-transaction round-trip, A/R balance before and after payment.
- `test-dbi-business-stuff.cpp` compares `gncInvoiceEqual`, customer/vendor/job/tax-table equality after SQL save/reload; it does not assert postings or balances.
- Owner-report tests assert exact invoice/payment line arrays, debits/credits/running balances and the aging bucket row.
- Invoice print tests assert exact subtotal/tax/total/due amounts and “fully paid” state.
- `test-stress-options.scm` deliberately only checks that reports do not crash.

---

## 5. Built-in GnuCash feature vs manual accounting workflow

This distinction matters for Saldima’s scenarios and for what an oracle can prove.

**Built-in GnuCash features**

- Customers, vendors, employees, jobs and owners.
- Customer invoices, vendor bills, credit notes, entries, bill terms, orders.
- Tax tables (percentage/value, tax-included/excluded) used by invoices/bills.
- A/R and A/P control accounts, lots and payment application.
- Invoice/bill posting and unposting, payment and credit-note linking.
- Owner report, customer/vendor reports, Receivable Aging, Payable Aging, invoice print/easy/fancy/tax invoice.
- GST/VAT report; US Tax Schedule/TXF export.
- Budgets and budget reports.
- Scheduled transactions and “Since Last Run”.
- Accounting-period freeze (`f` reconcile flag) and Close Book (creates closing transactions per currency).
- Balance sheet, P&L, trial balance, equity statement, transaction report, cash-flow reports.

**Manual workflows, not built-in modules**

- **Depreciation / fixed-asset register:** no asset module, no depreciation schedule. Use asset and contra-asset accounts plus monthly manual journal entries; disposal gain/loss is manual.
- **Deferred revenue / revenue recognition:** no deferred-revenue or recognition module. Use a liability account and monthly manual entries.
- **Partnership capital, basis and allocations:** no partner object, no basis tracking, no profit-sharing. Use equity subaccounts per partner and manual closing allocations. GnuCash’s “basis” reports are securities cost basis, not partner basis.
- **Monthly close:** no monthly close wizard. Reconciliation, accruals, depreciation/deferred entries and report review are manual. Close Book is a period/year-end P&L zeroing tool, not a monthly close process.
- **Annual close for a partnership:** Close Book can zero income/expense to one equity account; allocating net income 60/40 to partners and closing draws is manual.
- **Retained earnings:** a report calculation (`−(income+expense)`), not a ledger account. A partnership should not present it as partner equity; closing to partner capital avoids it.
- **Payroll, inventory/COGS, revenue recognition schedules, financial statement notes:** no modules.
- **Aging for manual AR/AP:** the built-in aging reports depend on business invoices/lots/owners; plain A/R or A/P journal balances are not aged as open items.
- **Tax computation on manual journals:** tax tables apply to invoice/bill entries; a manual sales-tax journal is just a liability posting.

---

## 6. Gaps Saldima should cover that GnuCash does not test directly

1. **Two-year business lifecycle:** a coherent chart of accounts and journal sequence across two fiscal years, with monthly snapshots and both year-end closes.
2. **Monthly close:** accruals, prepayments, depreciation, deferred-revenue recognition, bank/card reconciliation, trial-balance review, and period locking; no P&L zeroing until year-end.
3. **Annual close:** close revenue/expense to an income-summary account, allocate net income to partners, close draws, zero P&L, and prove the post-close trial balance and capital roll-forward.
4. **Partnership capital and basis:** contributions, profit shares, draws, debt-share memo basis, and a partner capital statement; explicitly label basis as illustrative, not tax advice.
5. **Depreciation:** acquisition, monthly depreciation, accumulated depreciation, net book value, disposal and gain/loss; fixed-asset register.
6. **Deferred revenue:** contract liability, monthly recognition, year-end deferred balance, and full run-out in year two.
7. **AR/AP subledger and aging:** manual open-item aging in Saldima, plus a GnuCash business-invoice/bill variant for oracle compatibility. AP aging is effectively untested upstream.
8. **Invoice/bill lifecycle across periods:** partial payments, credit notes, write-offs, overpayments/prepayments, and their effect on A/R, A/P, P&L and cash.
9. **Tax:** sales tax accrual and remittance, VAT/GST report parity, tax-included vs tax-excluded pricing, rounding, and tax liability at year-end.
10. **Budget vs actual over 24 months:** monthly budget, actuals, variances, and retained-earnings/equity effects; upstream only tests six periods.
11. **Scheduled transactions across a year boundary:** posting, deferral, and report inclusion; upstream report coverage is empty.
12. **Report/ledger parity:** every report total ties to the ledger, not just to another report, for both years.
13. **Negative/edge cases:** unbalanced journals, duplicate documents, over-application of payments, closed-period edits, missing owners/lots, and rounding at half-cent boundaries.
14. **Multi-currency business:** foreign-currency invoice/payment with FX gain/loss and statement conversion; upstream has multi-currency owners but no business statement chain.

---

## 7. Recommended two-year hypothetical business scenario set

**Entity:** “Northwind Studio Partners”, a two-partner service business, USD, calendar year, accrual basis, 60/40 profit share. All amounts are exact dollars.

**Purpose:** exercise partnership capital, depreciation, deferred revenue, AR/AP, tax, monthly close and annual close without pretending GnuCash has dedicated modules.

### 7.1 Accounts

- Assets: `Assets:Bank:Checking`, `Assets:AR`, `Assets:Equipment`, `Assets:Accumulated Depreciation:Equipment` (contra-asset).
- Liabilities: `Liabilities:AP`, `Liabilities:Deferred Revenue`, `Liabilities:Sales Tax Payable`, `Liabilities:Accrued Salaries`, `Liabilities:Equipment Loan`.
- Equity: `Equity:Partner A:Capital`, `Equity:Partner A:Draws`, `Equity:Partner B:Capital`, `Equity:Partner B:Draws`, `Equity:Income Summary` (temporary).
- Income: `Income:Services`, `Income:Support Contracts`.
- Expenses: `Expenses:Salaries`, `Expenses:Rent`, `Expenses:Software`, `Expenses:Repairs`, `Expenses:Depreciation`, `Expenses:Interest`, `Expenses:Bad Debt`.

### 7.2 Opening entries (Day 1, Year 1)

| Entry               | Debit     | Credit            | Amount |
| ------------------- | --------- | ----------------- | -----: |
| A contribution      | Cash      | Partner A Capital | 60,000 |
| B contribution      | Cash      | Partner B Capital | 40,000 |
| Equipment purchase  | Equipment | Cash              | 36,000 |
| Equipment financing | Cash      | Equipment Loan    | 20,000 |

Result: Cash 84,000; Equipment 36,000; Loan 20,000; Capital A 60,000, B 40,000. Partner debt share (illustrative): A 12,000, B 8,000; outside basis memo A 72,000, B 48,000.

### 7.3 Monthly operating template

Expand for 12 months in each year; exceptions are listed separately.

| Monthly entry | Debit        | Credit                   |                                   Amount |
| ------------- | ------------ | ------------------------ | ---------------------------------------: |
| Rent bill     | Rent         | AP                       |                                    2,000 |
| Software bill | Software     | AP                       |                                      500 |
| Salaries (Y1) | Salaries     | Cash                     |                                    7,500 |
| Salaries (Y2) | Salaries     | Cash                     | 10,000 (Dec: 5,000 cash + 5,000 accrued) |
| Depreciation  | Depreciation | Accumulated Depreciation |                                      500 |

Rent/software are paid in the following month except the open items noted below. Annual interest of 1,000 is paid Dec 31 each year (Debit Interest, Credit Cash). Partner draws are quarterly, not monthly: Y1 A 3,000 and B 2,000 per quarter; Y2 A 5,000 and B 3,750 per quarter.

### 7.4 Explicit events

| Date               | Event                                                                  | Journal                                             |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Y1 Mar/Jun/Sep/Dec | Services invoices 40,000 / 45,000 / 45,000 / 50,000                    | Dr AR; Cr Services                                  |
| Y1 Apr/Jul/Oct/Dec | Collections 38,000 / 44,000 / 44,000 / 44,000                          | Dr Cash; Cr AR                                      |
| Y1 Oct 1           | Support contract invoice 18,900 (18,000 + 5% tax 900)                  | Dr AR; Cr Deferred Revenue 18,000; Cr Sales Tax 900 |
| Y1 Oct 15          | Collect support invoice                                                | Dr Cash; Cr AR                                      |
| Y1 Oct 20          | Remit sales tax                                                        | Dr Sales Tax; Cr Cash 900                           |
| Y1 Oct–Dec         | Recognize support revenue 1,500/month                                  | Dr Deferred Revenue; Cr Support Revenue 4,500       |
| Y1 Jan/Apr/Jul/Oct | Partner draws A 3,000; B 2,000 each quarter                            | Dr A/B Draws; Cr Cash                               |
| Y1 Dec 31          | Interest payment                                                       | Dr Interest; Cr Cash 1,000                          |
| Y2 Feb             | Write off 2,000 of Y1 receivable                                       | Dr Bad Debt; Cr AR 2,000                            |
| Y2 Mar/Jun/Sep/Dec | Services invoices 55,000 / 60,000 / 60,000 / 65,000                    | Dr AR; Cr Services                                  |
| Y2 Apr/Jul/Oct/Dec | Collections 55,000 / 60,000 / 60,000 / 58,000                          | Dr Cash; Cr AR                                      |
| Y2 Jan–Sep         | Recognize remaining support revenue 1,500/month                        | Dr Deferred Revenue; Cr Support Revenue 13,500      |
| Y2 Jan/Apr/Jul/Oct | Partner draws A 5,000; B 3,750 each quarter                            | Dr A/B Draws; Cr Cash                               |
| Y2 Oct 31          | Repairs bill 1,000 unpaid                                              | Dr Repairs; Cr AP 1,000                             |
| Y2 Dec 20          | Taxable services invoice 25,200 (24,000 + 1,200 tax), collected Dec 28 | Dr Cash; Cr Services 24,000; Cr Sales Tax 1,200     |
| Y2 Dec 31          | Interest payment                                                       | Dr Interest; Cr Cash 1,000                          |
| Y2 Dec 31          | Accrue December salaries                                               | Dr Salaries 5,000; Cr Accrued Salaries 5,000        |

Support deferred balance: 18,000 at Oct 1 Y1 → 13,500 at Dec 31 Y1 → 0 at Sep 30 Y2.

### 7.5 Year 1 close (Dec 31)

1. Close revenue/expense to Income Summary:
   - Dr Services 180,000; Dr Support Revenue 4,500.
   - Cr Salaries 90,000; Cr Rent 24,000; Cr Software 6,000; Cr Depreciation 6,000; Cr Interest 1,000; Cr Income Summary 57,500.
2. Allocate Income Summary: Dr Income Summary 57,500; Cr A Capital 34,500; Cr B Capital 23,000.
3. Close draws: Dr A Capital 12,000; Cr A Draws 12,000; Dr B Capital 8,000; Cr B Draws 8,000.

### 7.6 Year 2 close (Dec 31)

1. Close revenue/expense:
   - Dr Services 264,000; Dr Support Revenue 13,500.
   - Cr Salaries 120,000; Cr Rent 24,000; Cr Software 6,000; Cr Repairs 1,000; Cr Depreciation 6,000; Cr Interest 1,000; Cr Bad Debt 2,000; Cr Income Summary 117,500.
2. Allocate: Dr Income Summary 117,500; Cr A Capital 70,500; Cr B Capital 47,000.
3. Close draws: Dr A Capital 20,000; Cr A Draws 20,000; Dr B Capital 15,000; Cr B Draws 15,000.

### 7.7 Expected income statement

| Line               |      Year 1 |      Year 2 |
| ------------------ | ----------: | ----------: |
| Services revenue   |     180,000 |     264,000 |
| Support revenue    |       4,500 |      13,500 |
| **Total revenue**  | **184,500** | **277,500** |
| Salaries           |      90,000 |     120,000 |
| Rent               |      24,000 |      24,000 |
| Software           |       6,000 |       6,000 |
| Repairs            |           0 |       1,000 |
| Depreciation       |       6,000 |       6,000 |
| Interest           |       1,000 |       1,000 |
| Bad debt           |           0 |       2,000 |
| **Total expenses** | **127,000** | **160,000** |
| **Net income**     |  **57,500** | **117,500** |

### 7.8 Expected balance sheet (after close)

| Line                             |      Year 1 |      Year 2 |
| -------------------------------- | ----------: | ----------: |
| Cash                             |     134,000 |     211,200 |
| Accounts receivable              |      10,000 |      15,000 |
| Equipment at cost                |      36,000 |      36,000 |
| Accumulated depreciation         |     (6,000) |    (12,000) |
| **Total assets**                 | **174,000** | **250,200** |
| Accounts payable                 |       3,000 |       4,000 |
| Deferred revenue                 |      13,500 |           0 |
| Sales tax payable                |           0 |       1,200 |
| Accrued salaries                 |           0 |       5,000 |
| Equipment loan                   |      20,000 |      20,000 |
| **Total liabilities**            |  **36,500** |  **30,200** |
| Partner A capital                |      82,500 |     133,000 |
| Partner B capital                |      55,000 |      87,000 |
| **Total equity**                 | **137,500** | **220,000** |
| **Total liabilities and equity** | **174,000** | **250,200** |

No retained-earnings line after close in the single-column Balance Sheet; partner capital replaces it. (The multicolumn report may still emit a zero Retained Earnings row because it adds the row whenever income/expense accounts exist.) Before close, GnuCash’s balance sheet will show a computed “Retained Earnings” of 57,500/117,500 — the scenario should assert both the unclosed and closed presentations and document the difference.

### 7.9 Partner capital / illustrative basis

| Partner | Y1 beginning | Contributions | Share of income |    Draws | Y1 ending | Y2 share | Y2 draws | Y2 ending |
| ------- | -----------: | ------------: | --------------: | -------: | --------: | -------: | -------: | --------: |
| A (60%) |            0 |        60,000 |          34,500 | (12,000) |    82,500 |   70,500 | (20,000) |   133,000 |
| B (40%) |            0 |        40,000 |          23,000 |  (8,000) |    55,000 |   47,000 | (15,000) |    87,000 |
| Total   |            0 |       100,000 |          57,500 | (20,000) |   137,500 |  117,500 | (35,000) |   220,000 |

**Illustrative outside-basis memo** (book capital + 60/40 share of the 20,000 equipment loan): A 94,500 in Y1 and 145,000 in Y2; B 63,000 and 95,000. Label this as an illustrative memo, not tax advice; GnuCash has no partner-basis module.

### 7.10 Trial balance (post-close)

| Year | Total debits | Total credits |
| ---- | -----------: | ------------: |
| Y1   |      180,000 |       180,000 |
| Y2   |      262,200 |       262,200 |

Y1 debits: Cash 134,000 + AR 10,000 + Equipment 36,000. Y1 credits: Accumulated depreciation 6,000 + AP 3,000 + Deferred revenue 13,500 + Loan 20,000 + A capital 82,500 + B capital 55,000.
Y2 debits: Cash 211,200 + AR 15,000 + Equipment 36,000. Y2 credits: Accumulated depreciation 12,000 + AP 4,000 + Sales tax 1,200 + Accrued salaries 5,000 + Loan 20,000 + A capital 133,000 + B capital 87,000.

### 7.11 AR/AP aging

| Bucket    |      AR Y1 |      AR Y2 |     AP Y1 |     AP Y2 |
| --------- | ---------: | ---------: | --------: | --------: |
| Current   |     10,000 |      7,000 |     2,500 |     2,500 |
| 1–30      |          0 |          0 |         0 |         0 |
| 31–60     |          0 |          0 |       500 |       500 |
| 61–90     |          0 |          0 |         0 |     1,000 |
| >90       |          0 |      8,000 |         0 |         0 |
| **Total** | **10,000** | **15,000** | **3,000** | **4,000** |

AR Y1 is the December services invoice; AR Y2 is the old 8,000 Y1 balance plus 7,000 from the December Y2 invoice. AP Y2 open items are December rent 2,000, December software 500, November software 500 and October repairs 1,000.

### 7.12 Depreciation and deferred-revenue schedules

| Year | Equipment cost | Accumulated depreciation | Net book value | Depreciation expense |
| ---- | -------------: | -----------------------: | -------------: | -------------------: |
| Y1   |         36,000 |                    6,000 |         30,000 |                6,000 |
| Y2   |         36,000 |                   12,000 |         24,000 |                6,000 |

| Period     | Deferred beginning | Cash/AR billed | Revenue recognized | Deferred ending |
| ---------- | -----------------: | -------------: | -----------------: | --------------: |
| Oct 1 Y1   |                  0 |         18,000 |                  0 |          18,000 |
| Oct–Dec Y1 |             18,000 |              0 |              4,500 |          13,500 |
| Jan–Sep Y2 |             13,500 |              0 |             13,500 |               0 |

### 7.13 January Y1 monthly close snapshot

January adjusting entries: rent 2,000, software 500, depreciation 500. No P&L closing.

| Statement       | Expected                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| P&L             | Revenue 0; expenses 3,000; net loss (3,000)                                                                                                  |
| Balance sheet   | Cash 84,000; equipment net 35,500; total assets 119,500; AP 2,500; loan 20,000; capital 100,000; current earnings (3,000); total L&E 119,500 |
| Trial balance   | Debits 123,000 = credits 123,000                                                                                                             |
| Close checklist | Bank reconciliation, AP/AR review, depreciation/deferred adjustments, trial balance, lock January                                            |

This is a “soft close”: no revenue/expense zeroing. The annual close in 7.5/7.6 is the hard close.

### 7.14 How to run this against GnuCash

- **Manual-journal variant:** post all entries as plain transactions; use the GnuCash ledger as the exact oracle. GnuCash will validate the trial balance, balance sheet, P&L and equity statement. It will not validate depreciation/deferred/partner schedules as reports; those are Saldima-computed schedules checked against ledger balances.
- **Business-document variant:** post customer services/support as GnuCash invoices and rent/software/repairs as vendor bills, with due dates and payments. This exercises built-in lots, owner reports and Receivable/Payable Aging. Keep depreciation, deferred revenue, partner allocations and close entries as manual journals. The ledger result must equal the manual-journal variant.
- **Report dates:** run Y1 BS/P&L/TB as of 2025-12-31 (or the mapped fixture years), Y2 as of 2026-12-31. Run P&L with closing entries excluded (description `Closing Entries` and/or `book_closing`) so the year’s revenue/expense remains visible; run BS/TB both pre-close and post-close to prove the retained-earnings→partner-capital transition.
- **Oracle caveat:** manual A/R and A/P postings will not appear in GnuCash’s aging reports because aging requires invoice/lot owners. Use the business-document variant for GnuCash aging parity; use Saldima’s own open-item aging for the manual variant.

### 7.15 Suggested scenario IDs

1. `partnership-open` — contributions, loan, equipment, initial basis memo.
2. `monthly-close-jan-y1` — soft close, adjustments, monthly statements.
3. `y1-operate` — full-year services, support contract, AR/AP, tax, depreciation, interest, draws.
4. `y1-close` — closing entries, partner allocation, draws, post-close statements/aging.
5. `y2-operate` — second-year revenue/collections, deferred run-out, bad debt, repairs, tax payable, accrued salaries.
6. `y2-close` — second closing, capital roll-forward, post-close statements/aging.
7. `ar-ap-business-oracle` — same AR/AP using GnuCash invoices/bills/lots for aging and owner-report parity.
8. `manual-vs-business-equivalence` — asserts both AR/AP variants produce identical ledger balances and statements.

---

## 8. Practical conclusions for Saldima

1. **Do not model Saldima’s verification only on GnuCash tests.** GnuCash’s suite is strong on engine primitives and single reports, but it does not test business workflows end to end. Saldima needs its own statement-level chain.
2. **Keep two AR/AP models:** manual open-item subledger (native Saldima) and GnuCash business invoices/bills/lots (compatibility). They should reconcile to the same control-account balances, but only the business model feeds GnuCash aging reports.
3. **Treat depreciation, deferred revenue, partnership capital/basis and close allocation as first-class Saldima scenarios**, even though GnuCash has no modules for them. They are the areas most likely to break in real use and are untested upstream.
4. **Test both unclosed and closed presentations.** GnuCash will show “Retained Earnings” for an unclosed partnership; after closing to partner capital it will not. Saldima must decide and document which presentation it uses, and test the transition.
5. **Use exact numbers and inline/golden expected files**, not just “report does not crash”. The upstream stress test explicitly does not check output; Saldima’s oracle should.
6. **Prioritize the two-year scenario above** over more synthetic single-report cases; it covers the gaps that matter for a business user and exposes the built-in-vs-manual boundary honestly.
