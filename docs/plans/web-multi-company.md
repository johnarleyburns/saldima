<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web multi-company migration

Status: **implemented** (2026-11-24). One Durable Object keeps several
companies (`.gnucash` books), like desktop GnuCash files, without duplicating
auth.

## Schema

- `gcw_books(id TEXT PRIMARY KEY, name TEXT NOT NULL, template_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL)`. Currency is
  presentation metadata for the new-company form and XML export; account names
  and amounts are unaffected.
- `ALTER TABLE accounts ADD COLUMN book_id TEXT NOT NULL DEFAULT 'main'`;
  same for `transactions` and `splits`.
- On migrate: create `gcw_books` if absent, add the `book_id` columns, backfill
  existing rows to `main`, and insert `('main', 'My book', 'personal', 'USD',
  now)` only when no book exists. An empty `gcw_books` after a deletion is not
  resurrected on the next start.

## Request scope

- `currentBookId(c)`: `book` cookie if it names an existing row, else the first
  book (ordered by `created_at`). Never trust a cookie pointing elsewhere. The
  resolved id is set once per request and read from the Hono context.
- Thread `bookId` through: `accountRows`, `splitRows`, `accountsTree`,
  `accountOptions`, `descendantGuids`, child counts, balances, journal lists,
  reports, import and export, and every INSERT/UPDATE/DELETE.
- GUIDs are globally unique, so update/delete by guid stays safe, but every
  SELECT filters `book_id`. A guid from another company reads as not found.

## UI

- `/app/books`: list with name, template, currency, created date; Select sets
  the cookie; create form (name, template, currency) seeds accounts via
  `seedAccounts` and makes the new company active.
- Rename lives in Settings; Delete lives on the book list. The last remaining
  company cannot be deleted (`409`), so every tenant always has a workspace.
- App bar gets a Books link and a current-company label on dashboard/accounts.
- Settings shows the active company, template and currency plus Rename.

## Import / export

- Import replaces only the active book (`DELETE ... WHERE book_id = ?`) and
  marks it as `imported`, taking the file's currency when the snapshot has one.
- XML export writes only the active book; filename is the company name
  (`Acme-Ltd.gnucash`) and the XML book guid derives from tenant + book.
- Bank statements (QIF, CSV, OFX/QFX) stage in `gcw_import_batches`, scoped by
  book, and are removed with the book. Parsed rows are never posted until the
  mapping screen is submitted.

## Tests

- [x] Two books in one workspace: accounts, transactions, balances, journal and
      reports never leak across books.
- [x] Switching the cookie changes every view; an unknown cookie falls back.
- [x] A guid from another company cannot be read, edited or deleted.
- [x] Importing into book B leaves book A untouched.
- [x] Exporting writes only the active book, on its own filename.
- [x] Deleting the active book clears the cookie; the last book is protected.
- [x] Renaming one company leaves the other unchanged.

Runtime coverage lives in
`packages/testkit/src/runtime/books.runtime.test.ts`; pure cookie and filename
helpers are unit-tested in `apps/web/src/books.test.ts`.

## Risks and open questions

- Issue #49 also lists a fiscal-year start in the new-book wizard. This
  migration does not add one; reports still cover all postings and the field
  lands with report options (interface parity).
- Two books created in the same millisecond order by `(created_at, id)`. The id
  tie-break keeps this deterministic; a sequence column would be needed only if
  sub-millisecond ordering ever matters.
- GnuCash GUIDs are unique per book, not across books. Importing the same source
  file into two companies currently collides with the global primary keys. This
  was accepted by the existing "GUIDs are globally unique" rule; remapping
  imported GUIDs would remove the limitation if a user needs the same file twice.

## Definition of done

Same commands as STATUS.md; browser smoke on dev with two companies, plus the
web unit and workerd suites.
