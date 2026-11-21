# Saldima

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

Saldima is a hosted, GnuCash-compatible accounting app: TypeScript end to end on
Cloudflare, mobile-first, with lossless `.gnucash` upload and download.

**Compatible with GnuCash.** Saldima is an independent project, not affiliated
with or endorsed by the GnuCash project.

## Status

Phase **P0 (Foundations)**. The web track lives here; the iPhone track lives in
[`johnarleyburns/saldima-ios`](https://github.com/johnarleyburns/saldima-ios).

- Agent contract and stack: [`CLAUDE.md`](CLAUDE.md)
- P0 checklist and exit criteria: [`docs/plans/P0.md`](docs/plans/P0.md)
- Contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CLA.md`](CLA.md)

## Development

Requires Node 22+ and pnpm 11+.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test:unit
```

`pnpm dev` currently starts once the Cloudflare scaffold lands (P0-6).

## Licence

`AGPL-3.0-only`. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Copyright is
retained by John Arley Burns; outside contributions are accepted under the CLA.
