// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BookFormatError } from "./book-file";
import { equalsMoney, money } from "./money";
import { readSqliteSnapshot } from "./sqlite";

const fixture = fileURLToPath(
  new URL("../../../fixtures/books/oracle-mini.sqlite.gnucash", import.meta.url),
);

describe("SQLite reader", () => {
  it("refuses bytes that are not SQLite", () => {
    expect(() => readSqliteSnapshot(new TextEncoder().encode("not a book"))).toThrow(
      BookFormatError,
    );
  });

  it("refuses a corrupt header or page", async () => {
    const original = new Uint8Array(await readFile(fixture));
    const badPageSize = new Uint8Array(original);
    badPageSize[16] = 0;
    badPageSize[17] = 0;
    expect(() => readSqliteSnapshot(badPageSize)).toThrow(BookFormatError);

    const badPage = new Uint8Array(original);
    badPage[100] = 0;
    expect(() => readSqliteSnapshot(badPage)).toThrow(BookFormatError);
  });

  it("reads the oracle SQLite book", async () => {
    const snapshot = readSqliteSnapshot(new Uint8Array(await readFile(fixture)));
    expect(snapshot.bookGuid).toBe("529ef4d2cf0a4ebb8f6238f6f2ddcac0");
    expect(snapshot.templateRootGuid).toBe("18802302696643e9936ee82d7deeef01");
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
    expect(tx.splits.every((split) => /^[0-9a-f]{32}$/.test(split.guid ?? ""))).toBe(
      true,
    );
    expect(
      tx.splits.some((split) => equalsMoney(split.value, money(250_000n, 100n))),
    ).toBe(true);
    expect(
      tx.splits.some((split) => equalsMoney(split.value, money(-250_000n, 100n))),
    ).toBe(true);
  });
});
