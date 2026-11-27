#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Bundles apps/web/src/client/*.ts into apps/web/static/*.js for Workers
// Assets to serve. Output is generated, not checked in -- re-run this (or
// let dev.sh/e2e.sh/deploy.sh do it) whenever a client entry point changes.
// See docs/architecture/TECHNICAL-DESIGN.md §8 and issue #88.

import { build } from "esbuild";

await build({
  entryPoints: ["apps/web/src/client/vault.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: "apps/web/static/vault.js",
  logLevel: "info",
});
