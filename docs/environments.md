# Environments

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

| Environment | Purpose                              | Deploy                                           |
| ----------- | ------------------------------------ | ------------------------------------------------ |
| local       | Development and Playwright e2e       | `pnpm dev`, `pnpm e2e`                           |
| **dev**     | Daily work, demos, first owner setup | automatic on merge to `main` after guards        |
| staging     | Release candidates only              | deliberate `pnpm deploy:staging`                 |
| production  | Live customers                       | owner-approved `pnpm deploy:production -- --yes` |

## Dev

- Marketing: `https://dev.saldima.com`
- Tenants: `https://alice-dev.saldima.com`, `https://bob-dev.saldima.com`
- Workflow: `.github/workflows/deploy-dev.yml`
- Guards before deploy: typecheck, Biome/gates, SPDX, licence scan, actionlint,
  unit + coverage, and the workerd runtime suite. Playwright is local-only
  (`pnpm e2e`) because hosted runners are unreliable with browser installs.
- GitHub environment `dev` holds the Cloudflare token and account ID.

### Dev signup tenants

Dev signup creates `<name>-dev.saldima.com`. A proxied wildcard `*` AAAA record
and the `*.saldima.com/*` Worker route point unknown single-level subdomains at
`saldima-dev`; the App Worker resolves each hostname through KV and 404s
unknown ones. Existing custom domains (`stage`, `alice-dev`, etc.) still work.

This wildcard is a **dev-only** arrangement. Before production, replace it with
the production tenant routing plan; do not assume `*.saldima.com` points to the
production Worker.

## Staging

Reserved for release candidates. Do not use it as the day-to-day environment.
Deploys are deliberate and verify the candidate before production.

## Local

`pnpm dev` creates `.dev.vars` from `.dev.vars.example` when missing. The local
setup token is `local-setup-token`; it is development-only.

`pnpm e2e` uses a separate `.wrangler/e2e-state` and port 8789, so it never
disturbs local data.
