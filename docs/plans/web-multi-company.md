<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web multi-company migration

Goal: several companies (`.gnucash` books) inside one tenant, like desktop
GnuCash files, without duplicating auth. One Durable Object, books scoped by id.

## Schema

- `gcw_books(id TEXT PRIMARY KEY, name TEXT NOT NULL, template_id TEXT NOT NULL,
  created_at TEXT NOT NULL)`.
- `ALTER TABLE accounts ADD COLUMN book_id TEXT NOT NULL DEFAULT 'main'`;
  same for `transactions` and `splits`.
- On migrate: insert `('main', 'My book', 'personal', now)` if missing and
  backfill existing rows to `main`.

## Request scope

- `currentBookId(c)`: `book` cookie if it names an existing row, else the first
  book (ordered by created_at). Never trust a cookie pointing elsewhere.
- Thread `bookId` through: `accountRows`, `splitRows`, `accountsTree`,
  `accountOptions`, `descendantGuids`, child counts, balances, journal lists,
  reports, import and export, and every INSERT/UPDATE/DELETE.
- Guides are globally unique, so update/delete by guid stays safe, but every
  SELECT must filter `book_id`.

## UI

- `/app/books`: list with name, template, created date; select sets the cookie;
  create form (name, template, currency) seeds accounts via `seedAccounts`.
- App bar gets a Books link and a current-company label on dashboard/accounts.
- Settings shows the active company and a Rename action.

## Import / export

- Import replaces only the active book (`DELETE ... WHERE book_id = ?`).
- XML export writes only the active book; filename is the book name.

## Tests

- Two books in one workspace: accounts, transactions, balances, journal and
  reports never leak across books.
- Switching the cookie changes every view; an unknown cookie falls back safely.
- Importing into book B leaves book A untouched.
- Deleting a book removes its accounts/splits only.

## Definition of done

Same commands as STATUS.md; browser smoke on dev with two companies, plus the
existing 148 web tests.
