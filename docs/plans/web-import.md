<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web bank statement import (QIF, CSV, OFX)

Status: **implemented** (2026-11-24). Issue #52 covers the wider import/export
menu; this migration adds statement import with account mapping and duplicate
detection. `.gnucash` import/export already existed.

## Formats

- **Sniffed by content, never the extension.** OFX (`OFXHEADER` or `<OFX>`),
  QIF (`!Type:` or a `^` record terminator plus a date/amount line), otherwise
  CSV. CSV delimiters `, ; \t |` are detected from the header; quoted fields,
  escaped quotes, CRLF and a UTF-8 BOM are handled.
- **Amounts** are read to exact cents with `parseImportAmount`, which handles
  currency symbols, thousands separators, European `1.234,56`, accounting
  parentheses and trailing minus. Posting stays half-up.
- **Dates** accept ISO, US and European slash forms (a first component above 12
  selects day-first), two-digit years and OFX timestamps.
- **QIF** reads date, amount, payee, memo, number, category, transfer categories
  (`[Savings]`) and split lines (`S`/`$`).
- **OFX** reads both SGML (unclosed tags) and XML, using `DTPOSTED`, `TRNAMT`,
  `NAME`/`PAYEE`, `MEMO`, `FITID`/`CHECKNUM`.
- **CSV** detects date, description, amount-or-debit/credit, category and
  reference columns from common bank headers.

## Mapping and posting

1. Choose the statement account (asset/liability types only) and upload.
2. Parsed rows are staged in `gcw_import_batches`, scoped by book; nothing is
   posted yet.
3. The mapping screen lists the statement categories. Each maps to an existing
   account, pre-selected by name when possible. The default account, a visible
   top-level EQUITY account named **Imports**, receives unmatched rows and is
   created on first use.
4. Each row posts one split on the statement account and one split on the mapped
   category account (or the QIF splits). A QIF split remainder posts to the
   default account so the transaction balances. The description is payee, then
   memo, capped at 200 characters.
5. Positive statement amounts increase the statement account; negative amounts
   decrease it. For a card, a payment may need the statement's sign convention
   checked by the user.

## Duplicate detection

Rows are compared with existing splits on the statement account: same exact
amount and a date within three days (the rule in `docs/spec/SPEC.md`). Possible
duplicates are marked on the mapping screen and skipped by default; a checkbox
imports them anyway. Duplicate checks and every read/write are scoped to the
active `book_id`.

## Tests

- `packages/importers/src/*.test.ts`: date/amount formats, QIF/CSV/OFX parsing,
  format sniffing, duplicate matcher, double-entry planning and staged-row
  encoding.
- `packages/testkit/src/runtime/imports.runtime.test.ts`: a QIF upload maps and
  posts, a repeat upload is flagged and skipped, the override imports it, CSV
  works, a second company imports independently, and cancel removes the batch.
- `e2e/auth.setup.spec.ts`: browser journey for upload, mapping, posting and the
  duplicate warning.

## Risks and open questions

- CSV columns are auto-detected; there is no manual column-remap screen yet. An
  unusual header fails with the column list so the user can rename it before
  uploading. A remap screen is the natural follow-up if bank layouts demand it.
- Slash dates are US-first unless the first component is above 12. A bank that
  writes `03/04/2024` for 3 April cannot be disambiguated from the file alone.
- QIF/CSV export is not part of this step; issue #52 still tracks it.
- Hidden accounts are excluded from mapping pickers; a hidden account named
  `Imports` is made visible when it is reused as the default.
