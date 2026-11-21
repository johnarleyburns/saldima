#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

/**
 * Fail closed: every named license in the expression must be allowlisted, even
 * in an `OR` branch. That keeps GPL code out of the dependency tree entirely.
 * @param {string} expression
 */
export function isAllowedLicense(expression) {
  if (typeof expression !== "string" || expression.trim() === "") return false;
  const cleaned = expression.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned
    .split(/\s+(?:AND|OR)\s+/i)
    .map((part) => part.replace(/\s+WITH\s+.*$/i, "").trim())
    .filter(Boolean)
    .every((token) => ALLOWED.has(token));
}

/** @param {unknown} data */
function collectLicenses(data) {
  /** @type {Array<{ name: string, license: string }>} */
  const packages = [];
  /** @param {unknown} value @param {string} [name] */
  const walk = (value, name) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, name);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = /** @type {Record<string, unknown>} */ (value);
    const recordName =
      typeof record.name === "string" ? record.name : (name ?? "unknown");
    if (typeof record.license === "string") {
      packages.push({ name: recordName, license: record.license });
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "license") continue;
      walk(child, recordName);
    }
  };
  walk(data);
  return packages;
}

function main() {
  let parsed;
  try {
    const output = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (output.trim() === "No licenses in packages found") {
      console.log("license scan: no production dependencies yet.");
      return;
    }
    parsed = JSON.parse(output);
  } catch {
    console.error("license scan: could not read `pnpm licenses list --json`");
    process.exit(1);
  }

  const packages = collectLicenses(parsed);
  const bad = packages.filter((pkg) => !isAllowedLicense(pkg.license));
  if (bad.length > 0) {
    for (const pkg of bad) console.error(`  ${pkg.name}: ${pkg.license}`);
    console.error(`license scan: ${bad.length} disallowed dependency license(s)`);
    process.exit(1);
  }
  console.log(`license scan: ${packages.length} dependency license(s) allowed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
