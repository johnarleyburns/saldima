#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { scanSource } from "./gates/rules.mjs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && f.length > 0);

const findings = files.flatMap((file) => scanSource(file, readFileSync(file, "utf8")));

if (findings.length > 0) {
  for (const f of findings) {
    console.error(`${f.file}:${f.line} [${f.rule}] ${f.message}`);
  }
  console.error(`\n${findings.length} gate violation(s).`);
  process.exit(1);
}

console.log(`gates: ${files.length} TypeScript file(s) clean.`);
