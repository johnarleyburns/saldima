#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HEADER = "SPDX-License-Identifier: AGPL-3.0-only";
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".css",
  ".sql",
  ".yml",
  ".yaml",
  ".toml",
  ".md",
  ".html",
  ".sh",
];
const EXEMPT = new Set([
  "LICENSE",
  "NOTICE",
  "CLA.md",
  "package.json",
  "pnpm-lock.yaml",
  "CODEOWNERS",
]);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((f) => !EXEMPT.has(f))
  .filter((f) => !f.startsWith("fixtures/vectors/"))
  .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)));

const missing = files.filter((file) => {
  const head = readFileSync(file, "utf8").split("\n").slice(0, 5).join("\n");
  return !head.includes(HEADER);
});

if (missing.length > 0) {
  console.error("Missing SPDX header:");
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`spdx: ${files.length} file(s) carry ${HEADER}.`);
