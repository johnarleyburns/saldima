<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web ↔ mobile feature parity

Audit date: 2026-11-23. Sources: `apps/web/src/app.ts`,
`apps/web/src/book.ts`, `packages/gnucash/src/`, `saldima-ios/Saldima*`,
`saldima-android/core|app`.

The mobile apps are **standalone books**. They are deliberately _not_ hosted
clients: no sign-up, no login, no multi-tenant routing, no subscription. A
hosted account is optional and removable; the local `.gnucash` file is the
source of truth. The only purchase on mobile is the one-time Supporter
consumable. Those differences are product decisions, not gaps.

Everything else in the accounting surface must match the web to the cent.

## Matrix

| Capability                                                   | Web                  | iOS                    | Android           | Verdict                               |
| ------------------------------------------------------------ | -------------------- | ---------------------- | ----------------- | ------------------------------------- |
| Hosted sign-up, Stripe Checkout, provisioning, welcome email | yes                  | —                      | —                 | Web-only by design                    |
| Owner setup, password, TOTP, sessions                        | yes                  | —                      | —                 | Web-only by design (device-local app) |
| Tenant routing (`alice-dev.saldima.com`)                     | yes                  | —                      | —                 | Web-only by design                    |
| Open an existing `.gnucash` SQLite book                      | — (server workspace) | read-only account tree | —                 | iOS ahead                             |
| Create a book from a template                                | yes (at setup)       | **missing**            | **missing**       | Gap                                   |
| Account tree display                                         | yes                  | **placeholder**        | **placeholder**   | Gap                                   |
| Account create/edit/move/hide/placeholder/delete             | yes                  | **missing**            | **missing**       | Gap                                   |
| Exact money, half-up posting, half-even display              | yes                  | yes                    | yes               | In sync                               |
| Journal posting validation (balance, duplicates, dates)      | yes                  | yes                    | yes               | In sync                               |
| Trial balance, balance sheet, P&L, retained earnings         | yes                  | yes                    | yes               | In sync                               |
| `verifyLedger` invariant report                              | yes                  | **missing**            | **missing**       | Gap                                   |
| Reports UI                                                   | —                    | —                      | —                 | Neither track; planned                |
| Register / transaction entry UI                              | —                    | —                      | —                 | Neither track; planned                |
| Receipts capture/attach                                      | —                    | placeholder tab        | placeholder tab   | Neither track                         |
| Theme / appearance setting                                   | colour scheme cookie | system appearance      | system appearance | Equivalent                            |
| One-time Supporter purchase                                  | — (subscription)     | StoreKit consumable    | Play consumable   | Mobile-only by design                 |
| Optional `/api/v1` sync, leases, merge                       | planned              | contract stub          | contract stub     | Neither track                         |
| Golden vectors as the numeric contract                       | source of truth      | replays                | replays           | In sync                               |

## Parity gate (must be true before the next phase)

- [x] iOS creates a book from all three templates and reopens it; GnuCash 5.14
      opens and re-saves the file.
- [ ] Android does the same (blocked on the Play Console account; core work can
      start at any time).
- [x] iOS account create/edit/move/hide/delete behaves like the web, including
      refusing a move into the account's own subtree and refusing to delete an
      account that has children.
- [x] Android account editing reaches the same rules (import + posting).
- [x] `verifyLedger` exists on iOS with the same findings as the web; Android
      still needs it.
- [ ] Reports UI renders trial balance, balance sheet and P&L from the open
      book, using half-even display.
- [ ] Web and mobile import the same vector fixtures.

## Deliberate divergences

1. Mobile has no auth: there is no server account. Optional sync will use a
   device token kept in Keychain/Keystore.
2. Mobile has no subscription. Hosting is bought on the web; mobile asks once
   for an optional Supporter purchase that never gates a feature.
3. Mobile opens `.gnucash` files directly; the web keeps a workspace copy in
   the Book Durable Object and will export later.
4. Receipts are mobile-first; there is no web equivalent yet.

## Evidence

- Web routes and account rules: `apps/web/src/book.ts`.
- Web kernel: `packages/gnucash/src/{money,ledger}.ts`.
- iOS core: `SaldimaCore/{Money,Ledger,Templates,Supporter}.swift`.
- Android core: `core/src/main/kotlin/guru/parso/saldima/core/`.
- Numeric contract: `packages/gnucash/vectors/*.json` replayed by both apps.
