// SPDX-License-Identifier: AGPL-3.0-only
//
// Golden vectors are the contract between the web and iPhone tracks. Output is
// deterministic: no timestamps, no commit hashes, stable ordering. The iPhone
// repo pins a web commit and replays these files.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  addMoney,
  formatMoney,
  type Money,
  money,
  multiplyMoney,
  parseMoney,
  roundToFraction,
  subtractMoney,
} from "../packages/gnucash/src/money.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VECTOR_DIR = join(ROOT, "fixtures", "vectors");

type MoneyJson = { readonly num: string; readonly denom: string };

function json(value: Money): MoneyJson {
  return { num: value.num.toString(), denom: value.denom.toString() };
}

function moneyVector(
  id: string,
  operation: Record<string, unknown>,
): Record<string, unknown> {
  return { id, ...operation };
}

export function buildMoneyVectors(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    fraction: "100",
    cases: [
      moneyVector("add_thirds", {
        op: "add",
        left: json(money(1n, 3n)),
        right: json(money(1n, 3n)),
        expected: json(addMoney(money(1n, 3n), money(1n, 3n))),
      }),
      moneyVector("add_cents", {
        op: "add",
        left: json(money(1234n, 100n)),
        right: json(money(766n, 100n)),
        expected: json(addMoney(money(1234n, 100n), money(766n, 100n))),
      }),
      moneyVector("add_beyond_safe_integer", {
        op: "add",
        left: json(money(9_007_199_254_740_993n, 100n)),
        right: json(money(7n, 100n)),
        expected: json(addMoney(money(9_007_199_254_740_993n, 100n), money(7n, 100n))),
      }),
      moneyVector("subtract_cents", {
        op: "subtract",
        left: json(money(1n, 100n)),
        right: json(money(3n, 100n)),
        expected: json(subtractMoney(money(1n, 100n), money(3n, 100n))),
      }),
      moneyVector("multiply_quantity", {
        op: "multiply",
        left: json(money(250n, 100n)),
        right: json(money(2n, 1n)),
        expected: json(multiplyMoney(money(250n, 100n), money(2n, 1n))),
      }),
      moneyVector("round_down", {
        op: "round",
        value: json(money(12344n, 1000n)),
        fraction: "100",
        expected: json(roundToFraction(money(12344n, 1000n), 100n)),
      }),
      moneyVector("round_up", {
        op: "round",
        value: json(money(12346n, 1000n)),
        fraction: "100",
        expected: json(roundToFraction(money(12346n, 1000n), 100n)),
      }),
      moneyVector("round_tie_to_even_down", {
        op: "round",
        value: json(money(12345n, 1000n)),
        fraction: "100",
        expected: json(roundToFraction(money(12345n, 1000n), 100n)),
      }),
      moneyVector("round_tie_to_even_up", {
        op: "round",
        value: json(money(12355n, 1000n)),
        fraction: "100",
        expected: json(roundToFraction(money(12355n, 1000n), 100n)),
      }),
      moneyVector("round_negative_tie", {
        op: "round",
        value: json(money(-12345n, 1000n)),
        fraction: "100",
        expected: json(roundToFraction(money(-12345n, 1000n), 100n)),
      }),
      moneyVector("parse_negative_tie", {
        op: "parse",
        text: "-12.345",
        fraction: "100",
        expected: json(parseMoney("-12.345", 100n)),
      }),
      moneyVector("parse_plain", {
        op: "parse",
        text: "12.355",
        fraction: "100",
        expected: json(parseMoney("12.355", 100n)),
      }),
      moneyVector("format_cents", {
        op: "format",
        value: json(money(1234n, 100n)),
        fraction: "100",
        expected: "12.34",
      }),
      moneyVector("format_negative", {
        op: "format",
        value: json(money(-5n, 100n)),
        fraction: "100",
        expected: formatMoney(money(-5n, 100n), 100n),
      }),
      moneyVector("format_rounds", {
        op: "format",
        value: json(money(12345n, 1000n)),
        fraction: "100",
        expected: formatMoney(money(12345n, 1000n), 100n),
      }),
    ],
  };
}

export function buildGuidVectors(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    pattern: "^[0-9a-f]{32}$",
    valid: [
      "0123456789abcdef0123456789abcdef",
      "00000000000000000000000000000000",
      "ffffffffffffffffffffffffffffffff",
      "fedcba9876543210fedcba9876543210",
    ],
    invalid: [
      "0123456789ABCDEF0123456789abcdef",
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "g123456789abcdef0123456789abcdef",
      "",
      "not-a-guid",
    ],
  };
}

export function buildIndex(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    description:
      "Saldima golden vectors. Replay, do not reinterpret. Pinned by web commit.",
    money: "money.json",
    guid: "guid.json",
  };
}

export function buildVectors(): Record<string, string> {
  return {
    "index.json": `${JSON.stringify(buildIndex(), null, 2)}\n`,
    "money.json": `${JSON.stringify(buildMoneyVectors(), null, 2)}\n`,
    "guid.json": `${JSON.stringify(buildGuidVectors(), null, 2)}\n`,
  };
}

export function writeVectors(): void {
  mkdirSync(VECTOR_DIR, { recursive: true });
  for (const [name, content] of Object.entries(buildVectors())) {
    writeFileSync(join(VECTOR_DIR, name), content, "utf8");
  }
}

export function checkVectors(): string[] {
  const problems: string[] = [];
  for (const [name, content] of Object.entries(buildVectors())) {
    let actual: string;
    try {
      actual = readFileSync(join(VECTOR_DIR, name), "utf8");
    } catch {
      problems.push(`${name} is missing`);
      continue;
    }
    if (actual !== content) problems.push(`${name} is out of date`);
  }
  return problems;
}

const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invoked) {
  if (process.argv.includes("--check")) {
    const problems = checkVectors();
    if (problems.length > 0) {
      for (const problem of problems) console.error(`vectors: ${problem}`);
      console.error("vectors: run `pnpm vectors` and commit the result");
      process.exit(1);
    }
    console.log("vectors: committed files match the generator.");
  } else {
    writeVectors();
    console.log("vectors: wrote fixtures/vectors/{index,money,guid}.json");
  }
}
