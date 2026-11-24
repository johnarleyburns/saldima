// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { equalsMoney, money } from "./money";
import { readSqliteSnapshot } from "./sqlite";

const fixture = fileURLToPath(
  new URL("../../../fixtures/books/oracle-mini.sqlite.gnucash", import.meta.url),
);

describe("SQLite reader", () => {
  it("reads the oracle SQLite book", async () => {
    const snapshot = readSqliteSnapshot(new Uint8Array(await readFile(fixture)));
    expect(snapshot.currencyCode).toBe("USD");
    const names = snapshot.accounts
      .filter((account) => account.type !== "ROOT")
      .map((account) => account.name)
      .sort();
    expect(names).toEqual(["Assets", "Bank", "Income", "Salary"]);
    expect(snapshot.transactions).toHaveLength(1);
    const tx = snapshot.transactions[0];
    if (!tx) throw new Error("missing transaction");
    expect(tx.description).toBe("Opening deposit");
    expect(tx.date).toBe("2025-01-15");
    expect(tx.splits).toHaveLength(2);
    expect(
      tx.splits.some((split) => equalsMoney(split.value, money(250_000n, 100n))),
    ).toBe(true);
    expect(
      tx.splits.some((split) => equalsMoney(split.value, money(-250_000n, 100n))),
    ).toBe(true);
  });
});
