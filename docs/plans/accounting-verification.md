<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Accounting verification system

Goal: prove that every journal Saldima accepts produces the same balances,
trial balance, balance sheet and income statement as GnuCash, and that invalid
journals are rejected. Research and source references:
[`docs/research/gnucash-verification.md`](../research/gnucash-verification.md).

## Layers

1. **Pure ledger core** (`packages/gnucash/src/ledger.ts`): accounts, splits,
   transactions, signed bigint money, `post`, `verifyLedger`, balances, trial
   balance, balance sheet and P&L.
2. **Scenario DSL**: deterministic GUIDs, post/void/reverse/reconcile steps,
   raw split signs, explicit dates; JSON fixtures with exact expected cents.
3. **Invariant engine**: unbalanced journal, trial balance not zero,
   A ≠ L + E, retained earnings mismatch, report total ties, void/reversal
   pair checks.
4. **GnuCash oracle**: pinned blank SQLite template + stdlib SQL book
   generation; `gnucash-cli` as a separate process; custom saved reports with
   fixed dates; HTML parsed by account GUID; integer-cent comparison. Never
   link or vendor GnuCash code.
5. **Property tests**: fast-check valid-by-construction journals, mutated
   invalid journals, model-based post/void/reverse/reconcile sequences.

## First five scenarios (verified against GnuCash 5.14)

| #   | Scenario                          | Assets | Liabilities | Retained earnings | Total equity | Revenue | Expenses | Net |
| --- | --------------------------------- | -----: | ----------: | ----------------: | -----------: | ------: | -------: | --: |
| 1   | Opening balances                  |  1,000 |         200 |                 0 |          800 |       0 |        0 |   0 |
| 2   | Sale + expense, two years         |  1,530 |         200 |               530 |        1,330 |     500 |      120 | 380 |
| 3   | 3-split sale + tax + card payment |  1,280 |         180 |               300 |        1,100 |     300 |        0 | 300 |
| 4   | Void + reverse                    |  1,380 |         200 |               380 |        1,180 |     500 |      120 | 380 |
| 5   | Reconcile flags                   |  1,680 |         200 |               680 |        1,480 |     800 |      120 | 680 |

## Checklist

- [x] Ledger, trial balance, balance sheet, P&L and invariants with property tests.
- [ ] Scenario DSL and the first five JSON fixtures with exact expected cents.
- [ ] Pinned blank book generator and `gnucash-cli` saved-report runner.
- [ ] HTML parser by account GUID and the cents comparator.
- [ ] `pnpm test:oracle` in a pinned CI container (`gnucash-cli` 5.14/5.17).
- [ ] Wire the core into Book posting and reports in P2.
- [ ] Closing entries, void/reverse and reconcile flags in the model.
- [ ] Multi-currency/prices/lots only after single-currency parity.

## Open decisions and risks

- **Rounding decision:** posting normalisation is half-up (`toScu` /
  `roundToFractionHalfUp`), matching GnuCash; report display keeps half-even.
  The 2.665 → 2.67 case is in the ledger tests.
- **Report HTML is not an API.** Pin the oracle image and fail loudly on
  layout/version drift; parse by `acct-guid`, not names.
- **Locale/timezone:** force `TZ=UTC`, `LC_ALL=C`, isolated `HOME`/`XDG_*`.
- **Closing entries:** legacy description matching and `book_closing` KVP
  differ; choose one model and test both unclosed and closed books.
- **Version matrix:** research is 5.17, oracle 5.14, target includes 4.14.
  Pin images and record expected report labels per version.
