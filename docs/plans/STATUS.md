<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Project status — 2026-11-28

Snapshot for resuming. Canonical plans: `P1.md`, `P2.md`,
`mobile-parity.md`, `web-multi-company.md`. Android: `saldima-android/docs/plans/P0.md`.
iOS: `saldima-ios/docs/plans/P1-MOBILE.md`.

## Where each track stands

| Capability                                               | Web                           | iOS                      | Android                        |
| -------------------------------------------------------- | ----------------------------- | ------------------------ | ------------------------------ |
| Exact money, posting rules, TB/BS/P&L, verifyLedger      | yes                           | yes                      | core yes                       |
| Read GnuCash XML                                         | yes                           | yes                      | yes                            |
| Read GnuCash SQLite                                      | yes (Worker parser)           | yes                      | yes (row port)                 |
| Import a book                                            | both formats                  | file picker              | system picker                  |
| Write / post                                             | post; XML export              | post into SQLite         | post into SQLite               |
| Journal / register                                       | General Journal page          | Register tab             | Register tab                   |
| Rolled account totals, net assets, profit                | yes                           | yes                      | yes                            |
| Reports                                                  | yes                           | yes                      | yes                            |
| Help topics                                              | yes                           | yes                      | yes                            |
| Multiple companies                                       | yes (library + switcher)      | yes (library + wizard)   | yes (switcher)                 |
| QIF / CSV / OFX import                                   | yes (mapping, dupes)          | in progress (#ios-recon) | yes (+PDF, Reconcile tab, #57) |
| QIF/CSV export                                           | no (#52 open)                 | yes                      | yes                            |
| XML export on mobile                                     | n/a                           | yes (gzip XML)           | yes (gzip XML)                 |
| Scheduled/recurring transactions                         | yes (#98)                     | yes (#79)                | yes (#51)                      |
| Budgets                                                  | yes (#102/#103)               | yes (#81/#82)            | yes (#53)                      |
| Multi-currency price database / manual conversion        | yes (#104/#107)               | yes (#84)                | yes (#55)                      |
| Reconcile as a top-level nav item                        | yes                           | in progress (#ios-recon) | yes, tab bar (#57)             |
| Statement-PDF import                                     | no (not planned)              | in progress (#ios-recon) | yes (pdfbox-android, #57)      |
| Check printing                                           | yes, one preset (#108/#109)   | no (web-only, by design) | no (web-only, by design)       |
| Zero-knowledge vault backup (opt-in, backup/verify only) | Milestone 1 shipped (#88–#91) | n/a                      | n/a                            |
| Supporter one-time purchase                              | n/a                           | StoreKit                 | Play adapter                   |
| Design theme                                             | yes                           | yes (accent palette)     | yes (Material 3 indigo)        |
| Auth, billing, TOTP, tenant routing                      | yes                           | n/a                      | n/a                            |

"in progress (#ios-recon)" = the Reconcile tab + QIF/OFX/CSV/PDF statement
importer, dispatched to the iOS track on 2026-11-28, mirroring Android #57;
not yet merged as of this snapshot.

Deployed: web dev auto-deploys every merge. iOS releases every owner-authored
merge to TestFlight (latest build includes the price database, #84). Android
builds on CI; Play Console still awaits owner approval.

## Web multi-company landed

The migration in `docs/plans/web-multi-company.md` is implemented: several
companies per tenant, each book scoped by `book_id`, with import/export touching
only the active company. Every query is scoped, and the workerd suite proves two
books cannot leak into each other.

## Next work, in order

1. QIF/CSV export on web (remaining #52).
2. iOS Reconcile tab + statement importer (in progress, see table above).
3. 100 industry templates and country overlays (`P2.md` track 2).
4. GnuCash locale set with machine-marked translations (`P2.md` track 3).
5. Interface parity remainders: register columns/reconcile, report options,
   keyboard shortcuts, Actions/Business/Tools menus.
6. Zero-knowledge vault, Milestone 2+ (live client-side editing, multi-device
   key distribution, snapshot-DAG merge) — not started, see `P0.md` risks.

## Resuming

```sh
cd ~/github/saldima   && pnpm install && pnpm test && pnpm typecheck
cd ~/github/saldima-ios && docker run --rm -v "$PWD":/w -w /w swift:6.2-noble \
  bash -lc 'apt-get update -qq && apt-get install -y -qq libsqlite3-dev zlib1g-dev && swift test -Xswiftc -warnings-as-errors'
cd ~/github/saldima-android && ./gradlew :core:test :app:assembleDebug
```
Rules unchanged: PRs only, squash, owner-authored merges release iOS; never
upload to Play; AGPL-3.0-only; no GnuCash code or help text copied.
