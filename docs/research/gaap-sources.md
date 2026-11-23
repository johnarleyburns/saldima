# Where "correct" accounting numbers can come from

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

**Question:** is there an authoritative source of correct journal entries and
resulting financial statements that Saldima can use as a verification oracle?

**Short answer:** no free, canonical "answer key" dataset exists. GAAP is a
principles-and-standards framework, not a lookup table of journal entries.
Correctness has three parts: (1) the arithmetic/invariants, (2) the accounting
policy applied under an identified framework, and (3) professional judgement.
A real verification system therefore combines an exact ledger, an independent
implementation, GnuCash, and a named CPA reviewer — not copied examples.

## Sources and how we may use them

| Source                                                                                                     | Authority / licence                                                | Use in Saldima                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **FASB Accounting Standards Codification (ASC)** — https://asc.fasb.org                                    | Authoritative U.S. GAAP; paid subscription; copyrighted            | Cite topic/subtopic in fixtures and design docs; never copy text. Use for policy decisions (e.g. ASC 606, 310, 326, 340, 360, 505). |
| **SEC EDGAR XBRL APIs** — https://www.sec.gov/search-filings/edgar-application-programming-interfaces      | Public filings and XBRL facts from audited 10-K/10-Q; no API key   | Optional statement-level oracle: compare our report totals/taxonomy mapping with a real filer's XBRL facts. Not journal entries.    |
| **XBRL US / SEC financial statement datasets** — https://xbrl.us/academic-repository/sec-edgar-data        | Public academic data                                               | Large-scale report-format and tag coverage tests; not a journal oracle.                                                             |
| **AICPA illustrative financial statements / FRF for SMEs** — https://www.aicpa-cima.com                    | Non-authoritative illustrations; copyrighted; free account         | Presentation/structure reference only. Do not commit or paraphrase the documents.                                                   |
| **OpenStax Principles of Accounting** — https://openstax.org/details/books/principles-financial-accounting | CC BY-NC-SA 4.0; non-commercial; site terms restrict LLM ingestion | Study/reference only. Not AGPL/commercial-compatible; do not copy examples or text into the repo.                                   |
| **CPA exam / textbook questions**                                                                          | Copyrighted                                                        | Reference for scenario ideas only; author original facts.                                                                           |
| **IRS Publications 946 (depreciation) and 541 (partnerships)** — https://www.irs.gov                       | U.S. tax guidance, not GAAP                                        | Tax-specific scenarios only (e.g. MACRS vs book depreciation, partner outside basis). Label them tax, not GAAP.                     |
| **GnuCash tests and fixtures**                                                                             | GPL-2.0-or-later                                                   | Behaviour reference only. Do not copy test code or fixture books. Reimplement scenarios clean-room.                                 |

## What is actually "vetted"

- **Arithmetic and double entry** can be proved: split values sum to zero,
  account balances sum to splits, trial balance balances, A = L + E,
  retained earnings ties to P&L. These are machine-checkable and authoritative
  by construction.
- **Accounting treatment** is vetted by citing the applicable standard and
  having a CPA review the scenario's policy choices, dates, cut-off and
  presentation.
- **Report numbers** are verified by an independent implementation and by
  GnuCash's own report engine on the same ledger. A public company's audited
  statements can validate statement-level totals/format, but cannot tell us
  which journal entries produced them.

Every fixture should carry:

```json
{
  "id": "partnership-y1-close",
  "framework": "US GAAP",
  "standardRefs": ["ASC 360-10", "ASC 606-10", "ASC 505-10"],
  "reviewedBy": "CPA name/licence",
  "reviewedAt": "2026-12-01",
  "reviewNotes": "depreciation policy, revenue cut-off, partner allocations"
}
```

A fixture without a reviewer is a regression test, not a vetted accounting
fixture. CI can require the metadata; a human must fill it.

## Recommended verification stack

1. **Pure TS ledger** — arithmetic, invariants, reports (already started).
2. **Original scenario DSL** with citations and reviewer metadata.
3. **Independent Python double-entry implementation** (small, not GnuCash)
   computing the same expected balances.
4. **GnuCash CLI/report oracle** on a generated SQLite book, comparing ledger
   JSON and HTML report totals by account GUID to the cent.
5. **CPA review** of policy, cut-off, classification and presentation.
6. **SEC XBRL statement-level tie-out** for report shape/taxonomy, optional.

## GnuCash test parity

GnuCash has roughly 620 engine tests and 558 report assertions, but no
hypothetical two-year business fixture; `test-business.c` is disabled. Its
tests are GPL and must not be copied. Saldima will maintain a **coverage
matrix** (engine invariants, invoices/bills, lots, reports, budgets) and write
original scenarios that exercise the same behaviours, then extend beyond
GnuCash with monthly/annual close, depreciation, deferred revenue, partnership
capital and AR/AP aging.

## The two-year partnership scenario

The scenario in `docs/research/gnucash-business-tests.md` is original work with
expected numbers computed from its journal; it still needs a CPA reviewer
before being labelled vetted. The standards to cite there are ASC 360
(depreciation), ASC 606/340 (deferred revenue/costs), ASC 310/326
(receivables/credit losses), ASC 405 (liabilities), ASC 505 (equity) and the
AICPA partnership guide; partnership **tax basis** additionally invokes IRC
704(b)/outside basis and is a separate tax scenario.
