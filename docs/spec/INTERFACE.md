<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# GnuCash-familiar interface spec (web, iOS, Android)

Goal: a GnuCash desktop user can move to Saldima with **no retraining**. Same
vocabulary, same task order, same tree and register behaviours, in-app help that
answers the same questions. Platform idioms replace desktop chrome only where a
literal copy would be hostile (mobile has no menu bar).

This is behavioural parity, not a pixel copy. We do **not** copy GnuCash icons,
screenshots or help prose (GnuCash and its documentation are GPL). We describe
the same workflows in our own words and reuse only generic, non-copyrightable
labels such as *File*, *Reports*, *Help*, and accounting terms.

## 1. Desktop inventory and where it lives

| GnuCash desktop | Web | iOS / Android |
| --- | --- | --- |
| Menu bar: File, Edit, View, Actions, Business, Reports, Tools, Windows, Help | Same top-level order in the app shell. `Business` appears when invoices/bills land. | No menu bar: each tab has a toolbar; a `⋯` menu offers the same commands; Settings holds Preferences and Help. |
| Toolbar (New, Edit, Delete, …) | Context toolbar above the tree/register. | Toolbar buttons; swipe actions for Edit/Delete. |
| Accounts tab (list of open books) | Tenant book (one per subdomain); a book switcher appears when multiple books exist. | `Accounts` tab; book picker in Settings. |
| Account Tree window | `Accounts` screen: expandable tree, same columns. | `Accounts` tab: disclosure tree, same fields. |
| Register window, tabbed per account | `Register` screen with tabs for open accounts. | `Register` tab with a per-account picker; tabs inside the tab. |
| Reports menu (Assets & Liabilities, Income & Expenses, Business, Sample & Custom) | `Reports` menu grouped identically. | `Reports` tab with the same groups. |
| Tools: General Ledger, Reconciliation, Import/Export, Price Editor | `Tools` menu (same names where the feature exists). | Tools inside `⋯` / Settings; Reconciliation from the register. |
| Edit → Preferences | Settings screen with the same groups (Accounting Period, Register, Business, Warnings). | Settings tab, same groups. |
| Help: Contents, Tutorial & Concepts Guide, About | Help overlay with the same chapter structure, search, and per-screen context help. | Help inside Settings plus `?` on every screen. |
| Window menu / open windows | Browser tabs and in-app tab strip. | Recent screens and register tabs. |

## 1a. Companies, roots and totals

- Every `.gnucash` file is a **company**. A person may keep several and switch
  between them (web: book switcher; iOS/Android: the Accounts menu). There is no
  "root" company.
- The book root account is structural: GnuCash never shows it as a row, and
  neither do we. Its children are the top level of the tree.
- **New Book wizard**: company name, template, currency, fiscal year start.
- The Accounts window shows a **Balance** per account and a rolled-up **Total**
  for parents, then **Net assets** (assets − liabilities) and **Profit**
  (income − expenses) for the book. Amounts use half-even display.
- Import/export lives in the File/Tools menus: `.gnucash` XML and SQLite first,
  then QIF, CSV and OFX with mapping and duplicate detection.

## 2. Terminology (never paraphrase these)

Assets, Liabilities, Equity, Income, Expenses; Chart of Accounts; Account Type
(ASSET, BANK, CASH, CREDIT, LIABILITY, INCOME, EXPENSE, EQUITY, RECEIVABLE,
PAYABLE, ROOT); Placeholder; Hidden; Register; Split; Transfer; Reconciliation
(Not reconciled / Cleared / Reconciled); Opening Balance; Trial Balance; Balance
Sheet; Profit & Loss; Retained Earnings; Accounts Receivable/Payable; Tax Table;
Book Options.

Translations follow `docs/plans/P2.md`: stored account names stay English in the
file; the UI overlays translated labels.

## 3. Account tree behaviour

Must match GnuCash expectations:

- Disclosure triangle on every account with children; collapsed by default for
  newly opened books beyond the first level.
- Expansion state persisted per book and per device.
- Keyboard: `↑/↓` move, `←` collapse or go to parent, `→` expand or first child,
  type-ahead search, `Enter` edits.
- Columns: Account, Type, Code, Balance (and Total when rolled up). Web shows
  Balance from the ledger; mobile hides Balance until the register exists.
- Placeholders render as folder rows and cannot receive postings.
- Hidden accounts stay visible in the tree but are excluded from pickers and
  reports unless "Show hidden" is on.
- Siblings sort alphabetically; drag-to-reparent on web, long-press menu on
  mobile.
- Context menu: New Account, Edit Account, Delete Account, Expand All, Collapse
  All.
- Deleting with children or postings is refused with the same message a
  GnuCash user expects ("Move or delete this account's children first").

## 4. Register behaviour (when the register lands)

- Tabs: one per open account, closeable, restored on reload.
- Columns in order: Date, Num, Description, Transfer, R (reconcile), Amount,
  Balance; the split view adds Account, Memo, Action, Shares, Price.
- Keyboard: `Tab` next field, `Enter` commit, `Esc` cancel, arrow keys move rows,
  `Ctrl+Enter` opens the split editor.
- Reconcile letters `n`, `c`, `y` with the same colours (grey, yellow, green) and
  a Reconcile dialog that shows starting/ending balances and the difference.
- Sorting and filtering via the same column headers as GnuCash.
- Unsaved changes prompt before closing a tab.

## 5. Reports

- Menu groups: Assets & Liabilities, Income & Expenses, Business, Sample &
  Custom, exactly in that order.
- Report window: title, options bar (date range, account depth, price source),
  body, footer with generated timestamp. "Reload" and "Save report" behave like
  GnuCash's toolbar.
- Default dates follow GnuCash: Balance Sheet = today; P&L = start of fiscal
  year to today.
- Each report has a `?` that opens its help topic.

## 6. Help system

Structure mirrors the GnuCash manual so answers are found where users expect
them; every topic is written by us:

1. Getting Started (books, first account, first transaction)
2. Accounts and the Chart of Accounts
3. Transactions and the Register
4. Reconciliation
5. Reports
6. Business features (customers, invoices, bills, tax tables) — hidden until the
   feature exists
7. Tools (import/export, general ledger)
8. Preferences
9. FAQ and Troubleshooting
10. Glossary

Delivery and rules:

- Versioned offline bundle (Markdown/JSON) shipped with the app; searchable;
  available with no network.
- Every screen declares a `helpKey`; `?` opens that topic. A test asserts every
  route has a key and every key resolves to a topic.
- Cross-links use stable topic ids (`accounts.create`, `register.split`, …).
- Each topic ends with "What GnuCash does differently" where we intentionally
  diverge (for example, mobile has no menu bar).
- Localised through the P2 catalogs; English is the source of truth.
- No GnuCash help text is copied or closely paraphrased; the About page credits
  GnuCash as the compatible application and trademark owner.

## 7. Keyboard and accessibility

- Web shortcuts follow GnuCash where the browser allows: `Ctrl/Cmd+N` new,
  `Ctrl/Cmd+E` edit, `Delete` delete, `Ctrl/Cmd+S` save, `F1` help, `/` search.
- Every tree row and register cell is reachable by keyboard with visible focus.
- Mobile: VoiceOver/TalkBack labels use the same terminology; dynamic type;
  reduced-motion respected.

## 8. Acceptance: the GnuCash user task list

A person who has used GnuCash desktop must complete these from the UI alone,
with help available but not required:

- [ ] Create a book and add the first bank account.
- [ ] Add a child account and move an account under a different parent.
- [ ] Hide an account and show it again.
- [ ] Enter a two-split transaction and a three-split transaction.
- [ ] Reconcile a bank account and finish with a zero difference.
- [ ] Open the Balance Sheet and change its date.
- [ ] Find a report from the Reports menu without searching.
- [ ] Change the accounting period in Preferences/Settings.
- [ ] Import a file and export one (when import/export ships).
- [ ] Open Help for the screen they are on and find a related topic.

Each becomes an acceptance test on the web track and a manual QA script for
iOS/Android.

## 9. Sequencing

| Step | Work |
| --- | --- |
| I1 | Web shell: menu order, contextual toolbars, tree keyboard/expansion parity |
| I2 | Mobile: disclosure tree parity, toolbar/`⋯` command sets, Settings groups |
| I3 | Register and reconciliation parity, with the transaction phase |
| I4 | Help bundle v1 (topics 1–4, 8–10) + context links + search |
| I5 | Reports menu groups and report options parity |
| I6 | Accessibility and keyboard pass; the task list above is signed off |

Interface work ships with the features it describes; the help topic for a screen
is part of that screen's definition of done.
