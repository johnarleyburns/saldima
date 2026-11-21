<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# CLAUDE.md — Saldima web (`johnarleyburns/saldima`)

Saldima is a hosted, GnuCash-compatible accounting app: TypeScript end to end on
Cloudflare, server-rendered with Hono + JSX + htmx, one Durable Object per
customer book, and real `.gnucash` files in and out. The product is **Saldima**.
Say "compatible with GnuCash"; never use GnuCash as our product name or logo.

This file is the contract for coding agents on the **web** track. The iPhone
track lives in `johnarleyburns/saldima-ios` and consumes golden vectors and the
`/api/v1` contract published here.

## Source of truth

1. The Saldima spec (Spec tab: Coding-agent handoff, License, Local development,
   iPhone app; then Design tab). Local copy: `~/Downloads/Spec.md` on the
   owner's machine; ask for a fresh export if it is missing.
2. This file.
3. `docs/plans/P0.md` and the phase plans in `docs/plans/`.
4. The GitHub issue being worked. Its acceptance criteria are the definition of
   done.

If the spec and an issue disagree, stop and ask in the issue. Do not invent
behaviour. Record undecided items under **Risks and open questions** in the
relevant plan.

## Stack

- **Runtime:** Cloudflare Workers (workerd), Workers Paid plan, TypeScript.
- **Web:** Hono router, Hono JSX, htmx, mobile-first CSS; installable PWA.
- **Data:** one `Book` Durable Object per tenant (`idFromName(tenantId)`);
  Drizzle ORM over the object's SQLite with `durable-sqlite`; GnuCash 5.x tables
  plus `gcw_` tables for users, sessions, leases, inbox and audit.
- **Storage:** R2 for snapshots (`tenants/<id>/<sha256>.gnucash.gz`) and
  attachments; KV for hostname → tenant.
- **Converter:** Cloudflare Container running `python3-gnucash` for XML ↔ SQLite
  and the real-GnuCash oracle. Never linked into the app.
- **Tooling:** pnpm workspace, Vitest (Node + `@cloudflare/vitest-pool-workers`),
  Playwright, Biome, fast-check, Stryker weekly on money/sync packages.
- **Payments:** Stripe Checkout + webhook (test mode locally and on staging).

### Repository layout

```
apps/web/            Worker, Hono routes, JSX views, Durable Object classes
packages/gnucash/    GnuCash schema, Money, Guid, invariants (pure TS)
packages/testkit/    Ports, deterministic fakes, contract suites
packages/sync/       leases, snapshots, three-way merge (added in P3)
fixtures/            anonymised books and golden vectors
docs/plans/          phase checklists; docs/vectors.md for the iOS contract
scripts/             gates, vector generation, reset/seed
```

`packages/gnucash` is pure: no Cloudflare, Hono, Stripe, network or `fetch`.
It must also run under plain Node for fast tests.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | install the workspace (Node 22+, pnpm 11+) |
| `pnpm dev` | `wrangler dev`; `http://alice.localhost:8787`, `http://bob.localhost:8787` |
| `pnpm reset` | wipe `.wrangler/state`, seed two demo tenants from fixtures |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | Biome + AST gates (money numbers, `Math.random`, raw clock) |
| `pnpm test:unit` | Vitest in Node with fakes; must stay under 30 s |
| `pnpm test:runtime` | Vitest in workerd with real DO/KV/R2 bindings |
| `pnpm test:coverage` | unit + runtime coverage; CI requires >= 90% lines on `packages/*` |
| `pnpm e2e` | Playwright against the local stack (`--ui` for UI mode) |
| `pnpm e2e:ci` | headless Playwright across iPhone, Android and desktop projects |
| `pnpm vectors` | regenerate `fixtures/vectors/*.json` deterministically |
| `pnpm check:licenses` | dependency license scan (GPL/AGPL/unknown fail) |
| `pnpm check:spdx` | every tracked source file has an SPDX header |

Never run a deploy command. `wrangler deploy` is owner-only and lives in
protected GitHub Environments.

## Test-first, always

- Write the failing acceptance test first, watch it fail for the right reason,
  then write the smallest code that passes, then refactor with the suite green.
  A PR without a test that failed before the change is not done.
- Every async or non-deterministic dependency enters through the single `Ports`
  object in `packages/testkit`: `Clock`, `Scheduler`, `IdGenerator`, `Random`,
  `R2`, `KV`, `BookStub`, `Converter`, `Stripe`, `Email`, `Fetch`, plus
  `Files`/`Hasher`.
- Unit tests use only in-memory fakes from `packages/testkit`. Fakes are
  deterministic, instant, and can fail on demand (timeout, partial write, 5xx,
  eviction mid-request).
- Every fake has a contract suite that also runs against the real binding:
  fakes in Node, KV/R2/DO in workerd, Stripe nightly in test mode. Mocks may not
  drift from reality.
- Tests never sleep, poll or read wall time. Use the manual clock and scheduler;
  script races step by step (two uploads, write during merge, alarm during
  import).
- Mix target: ~80% unit with fakes, 15% workerd runtime, 5% Playwright journeys.
- For platform behaviour that cannot be automated, document the limitation in
  the PR and add the narrowest repeatable check plus a manual verification step.

## Money and data invariants

- Money is a `bigint` numerator/denominator pair, exactly as GnuCash stores it.
  Never use a JavaScript `number` for money, rates or quantities. The AST gate
  fails the build.
- Every transaction balances: split values sum to zero in the transaction
  currency; each split's quantity uses its account's commodity and fraction.
- GUIDs are 32 lowercase hex characters, generated through `IdGenerator`, never
  reused, even after delete.
- Keep what we do not model: never delete or rewrite unknown tables, columns or
  KVP slots. Write only through `packages/gnucash` or reviewed SQL. No raw
  `DELETE FROM` outside the data-access module.
- Refuse to write a book whose `versions` row is outside the tested matrix
  (GnuCash 4.14 and 5.x). Snapshot before any replace, restore or bulk import.
- One writer: writes run inside the tenant's Book DO, which handles one request
  at a time and requires the book to be Web active. A second editor gets
  read-only plus "take over editing".
- The `.gnucash` export is lossless and always one click away.

## Gates (all required before merge)

1. Typecheck, Biome, AST gates, SPDX and license scan.
2. Unit tests with fakes; runtime tests in workerd; Playwright smoke.
3. Coverage >= 90% lines on `packages/*`.
4. actionlint on workflows.
5. A completion audit against the issue with no gaps.
6. For data-path changes: round-trip oracle in the real GnuCash engine.

## License and dependencies

- Repo license: **AGPL-3.0-only**. Sole copyright is retained by
  `johnarleyburns` through `CLA.md`; outside PRs require the CLA check.
- An SPDX header on every file we author:
  `SPDX-License-Identifier: AGPL-3.0-only` (or the correct comment syntax for
  the file type). Legal texts (`LICENSE`, `NOTICE`, `CLA.md`) are exempt.
- Dependencies must be MIT, BSD, Apache-2.0, ISC, 0BSD or CC0. GPL, AGPL,
  SSPL and unknown licenses fail CI.
- Never copy code from gnucash-web, GnuCash, piecash or any GPL project. Read
  them for behaviour only. gnucash-web is credited in `NOTICE` as a reference.
- Never add analytics or third-party scripts to the app.

## Git and GitHub workflow

- **One task, one small branch, one PR, squash merge.** Never push to `main`.
- Use the `gh` CLI for every GitHub action (issues, PRs, checks, reviews,
  labels).
- Branch from `main`, push with `-u`, open a PR that links the issue, then
  `gh pr merge <n> --auto --squash --delete-branch` once checks are green.
- Keep commits scoped; do not reformat unrelated files.
- PR body: what changed, the failing test that now passes, gates run, and any
  issue requirement not covered (with reason).
- Before opening or updating a PR, run `git diff --check`, review
  `git diff --name-only`, run the required tests in the foreground, and audit
  the saved diff against the issue. A prose-only description is not a
  deliverable.

## Hard limits for agents

1. **Never deploy, tag, upload, or touch secrets, environments or rulesets.**
   Open PRs only. The owner approves every release and every staging run.
2. Never create or modify GitHub Environments, repository rulesets, branch
   protection, deploy keys, or Actions secrets.
3. Never add a GPL/AGPL dependency or copy GPL code.
4. Never commit `.dev.vars`, keys, tokens or customer data. Use test fixtures
   only, anonymised.
5. Never guess a missing decision. Stop and ask, or add it to the plan's
   **Risks and open questions**.
6. Never invent iPhone behaviour: the iOS track consumes vectors and the
   `/api/v1` contract from a pinned web commit.
7. Web golden vectors and the API contract merge before iOS code that needs
   them.

## Definition of done (every PR)

- A test failed first and passes now; all suites and gates are green with no
  warnings.
- A completion audit against the issue finds no gaps.
- `CLAUDE.md`, the phase checklist and the spec/plan are updated if a decision
  changed.
- No secrets, environments, rulesets, tags or deploys touched.

## P0 status

See `docs/plans/P0.md`. P0 exit for this track requires the spike checks on a
real 20 MB book, CI green, and a hello-world staging deploy that only the owner
can approve.
