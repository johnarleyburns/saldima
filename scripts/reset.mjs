#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { rmSync } from "node:fs";

rmSync(".wrangler/state", { recursive: true, force: true });
console.log(
  "reset: local wrangler state removed. alice.localhost and bob.localhost provision on first request.",
);
