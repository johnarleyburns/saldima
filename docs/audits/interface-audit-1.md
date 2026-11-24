<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Interface audit 1 — web and mobile against GnuCash 5.14

Method: walked GnuCash 5.14 desktop (Accounts, Register, Reports, Tools,
Preferences, Help) against `apps/web` (`/app`, `/app/accounts`) and the iOS
Accounts/Settings screens; read `book.ts`, `app.ts`, `AccountsView.swift`.
Spec: `docs/spec/INTERFACE.md`.

## Findings and actions

| #   | GnuCash behaviour                                                                                   | Before                                          | Action                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Account tree branches collapse with a triangle; View → Expand/Collapse All; expansion is remembered | Web tree always open; iOS tree always open      | **Applied**: web renders `<details>` per branch; iOS adds a disclosure chevron, persists folds via `@AppStorage`, and adds Expand All / Collapse All               |
| 2   | Window title "Accounts"; the chart is the same window                                               | Dashboard said "Chart of accounts"              | **Applied**: dashboard link is "Accounts (N)" with a "Chart of accounts" caption; accounts page explains the triangles                                             |
| 3   | Account types display as "Bank", "Accounts Receivable"                                              | Raw enums ("BANK")                              | **Applied**: web and iOS title-case the type for display; the file keeps uppercase                                                                                 |
| 4   | Menu bar order: File, Edit, View, Actions, Business, Reports, Tools, Windows, Help                  | Two links (Accounts, Settings)                  | Deferred to #46: add Reports and Tools as their features land; Business with invoicing; keep the documented order                                                  |
| 5   | Toolbar New/Edit/Delete above the tree                                                              | "+" and per-row edit only                       | Partially applied: iOS has toolbar add + overflow (Expand/Collapse All); Delete via swipe. Web keeps an Add link and per-row Edit. A shared toolbar lands with #46 |
| 6   | Register columns Date/Num/Description/Transfer/R/Amount; tabbed registers; reconcile letters        | Not built on either track                       | Deferred to the transaction phase (P2), specified in `INTERFACE.md`                                                                                                |
| 7   | Reports menu groups (Assets & Liabilities, …)                                                       | Not built                                       | Deferred; reports UI is saldima-ios #32                                                                                                                            |
| 8   | Help → Contents / Tutorial and Concepts Guide                                                       | No help                                         | Deferred to #46: offline topics with the same chapter structure, original wording                                                                                  |
| 9   | Preferences grouped (Accounting Period, Register, Business, Warnings)                               | Flat Settings                                   | iOS already groups Book/About/Support/Source; rename and add groups when options exist                                                                             |
| 10  | Keyboard: arrows in tree, F1 help, Ctrl+N/E, type-ahead                                             | Pointer only                                    | Deferred to #46 with the accessibility pass                                                                                                                        |
| 11  | Mobile tab names                                                                                    | Accounts, Register, Receipts, Reports, Settings | **Kept**: four match GnuCash windows; Receipts is deliberately mobile-only                                                                                         |

## Lessons applied now

1. Trees must fold. Both UIs now behave like the Accounts window; iOS remembers
   folds per device, web uses native `<details>`.
2. Speak GnuCash. "Accounts", title-cased account types, and the "Chart of
   accounts" caption match what a desktop user already reads.
3. Put bulk commands where a desktop user looks. iOS overflow offers Expand All
   / Collapse All, mirroring View menu commands.

## Next audit targets

- Register and reconciliation side-by-side with GnuCash, including column order,
  tab behaviour and the reconcile dialog. Blocks P2 register work.
- Report window chrome: options bar, reload, save report.
- Help search relevance: a new user should find "how do I reconcile" in two
  keystrokes.

## Round 2 — applied after the first pass

- The structural ROOT row is gone from the iOS tree; the spec now states the
  rule for every track.
- iOS keeps a library of company files with a switcher, a New book wizard
  (name, template, USD/EUR/GBP) and Import book via the system picker.
- iOS shows per-account balances plus Net assets and Profit.
- Every deferred item is assigned: multi-company/wizard web #49 and iOS #38,
  totals web #50, menus and General Journal web #51 / iOS #39, import/export
  web #52 / iOS #40, Android parity #17 (plus #15 help and #16 formats).
