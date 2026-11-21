# Golden vectors

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

`fixtures/vectors/` is the machine-readable contract between the web and iPhone
tracks. The web suite generates it; the Swift suite replays it.

| File         | Contents                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| `index.json` | schema version and file names                                              |
| `money.json` | exact rational add/subtract/multiply, half-even rounding, parse and format |
| `guid.json`  | valid and invalid GnuCash GUIDs                                            |

## Rules

- Amounts are decimal strings for `num` and `denom`; never JSON numbers.
- Generation is deterministic: no timestamps, no commit hashes, stable order.
  `pnpm vectors` rewrites the files; `pnpm vectors:check` fails on drift, and the
  unit suite asserts the committed files match the generator.
- The iPhone repo pins a **web commit SHA** and copies these files at that
  revision. It never re-derives behaviour from the web source.
- Changing a case or an expected value is a contract change: update this doc,
  regenerate, and land it on the web before the iOS code that consumes it.
- The iPhone generator script must fail if `schemaVersion` is newer than it
  understands.
- `accounts.json` is generated from a synthetic fixture so the iPhone tree
  builder can be compared across tracks now. A real-book tree vector replaces
  it once the owner supplies the anonymised book (web P0-5); the file name and
  schema stay the same.

## Regenerating

```sh
pnpm vectors
pnpm vectors:check
```

See `docs/plans/P0.md` item P0-7.
