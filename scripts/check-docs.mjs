#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from "node:fs";

const REQUIRED = [
  "CLAUDE.md",
  "LICENSE",
  "CLA.md",
  "CONTRIBUTING.md",
  "NOTICE",
  "CODEOWNERS",
  "docs/plans/P0.md",
  "docs/plans/P1.md",
  "docs/environments.md",
  "docs/plans/accounting-verification.md",
  "docs/research/gnucash-verification.md",
  "docs/integrations/stripe-and-email.md",
  "docs/spec/SPEC.md",
  "docs/spec/DESIGN.md",
  "docs/spec/GO-TO-MARKET.md",
];

const errors = [];
for (const file of REQUIRED) {
  if (!existsSync(file)) errors.push(`missing ${file}`);
}

if (existsSync("CLAUDE.md")) {
  const claude = readFileSync("CLAUDE.md", "utf8");
  for (const heading of [
    "## Stack",
    "## Commands",
    "## Test-first, always",
    "## License and dependencies",
    "## Git and GitHub workflow",
    "## Hard limits for agents",
  ]) {
    if (!claude.includes(heading)) errors.push(`CLAUDE.md lacks ${heading}`);
  }
}

if (existsSync("docs/plans/P0.md")) {
  const plan = readFileSync("docs/plans/P0.md", "utf8");
  for (let issue = 1; issue <= 9; issue += 1) {
    const link = `https://github.com/johnarleyburns/saldima/issues/${issue}`;
    if (!plan.includes(link)) errors.push(`P0.md does not link issue ${issue}`);
  }
  if (!plan.includes("## Exit criteria")) {
    errors.push("P0.md lacks exit criteria");
  }
}

if (
  !existsSync("LICENSE") ||
  !readFileSync("LICENSE", "utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE")
) {
  errors.push("LICENSE is not the AGPL text");
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("docs: handoff docs and P0 plan are present and linked.");
