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
  unit + coverage, workerd runtime, Playwright on iPhone/Android/desktop.
- GitHub environment `dev` holds the Cloudflare token and account ID.

## Staging

Reserved for release candidates. Do not use it as the day-to-day environment.
Deploys are deliberate and verify the candidate before production.

## Local

`pnpm dev` creates `.dev.vars` from `.dev.vars.example` when missing. The local
setup token is `local-setup-token`; it is development-only.

`pnpm e2e` uses a separate `.wrangler/e2e-state` and port 8789, so it never
disturbs local data.
