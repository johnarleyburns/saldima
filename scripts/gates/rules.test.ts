// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { scanSource } from "./rules.mjs";

const file = (name: string): string => `packages/gnucash/src/${name}`;

describe("no JS numbers for money", () => {
  it("flags a number-typed money variable", () => {
    const findings = scanSource(file("ledger.ts"), "const totalAmount: number = 10;");
    expect(findings.map((f) => f.rule)).toEqual(["money-number"]);
  });

  it("flags a money property typed number", () => {
    const findings = scanSource(
      file("ledger.ts"),
      "interface Split { readonly debit: number }",
    );
    expect(findings[0]?.rule).toBe("money-number");
  });

  it("allows bigint money and plain numbers that are not money", () => {
    expect(
      scanSource(
        file("ledger.ts"),
        "const amountNum: bigint = 1n; const rowIndex: number = 0;",
      ),
    ).toEqual([]);
  });

  it("does not police test files", () => {
    expect(scanSource(file("ledger.test.ts"), "const amount: number = 1;")).toEqual([]);
  });
});

describe("seams for randomness and time", () => {
  it("flags Math.random in product code", () => {
    expect(scanSource(file("ids.ts"), "Math.random();")[0]?.rule).toBe("math-random");
  });

  it("flags direct clock reads in product code", () => {
    expect(scanSource(file("lease.ts"), "Date.now();")[0]?.rule).toBe("direct-clock");
    expect(scanSource(file("lease.ts"), "new Date();")[0]?.rule).toBe("direct-clock");
  });

  it("allows clock reads inside the clock adapter", () => {
    expect(
      scanSource("packages/testkit/src/time/system-clock.ts", "Date.now();"),
    ).toEqual([]);
  });
});

describe("raw deletes", () => {
  it("flags DELETE FROM outside the data-access module", () => {
    expect(scanSource(file("ui.ts"), 'db.run("DELETE FROM splits")')[0]?.rule).toBe(
      "raw-delete",
    );
  });

  it("allows DELETE FROM in the data-access module", () => {
    expect(
      scanSource(
        "packages/gnucash/src/data-access/delete.ts",
        'db.run("DELETE FROM splits")',
      ),
    ).toEqual([]);
  });
});
