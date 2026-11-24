// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  BookFormatError,
  type BookSnapshot,
  detectBookFormat,
  parseGnuCashXml,
  parseXml,
  readBookSnapshot,
} from "./book-file";
import { equalsMoney, money } from "./money";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/books/${name}`, import.meta.url));

const load = async (name: string) => new Uint8Array(await readFile(fixture(name)));

describe("book formats", () => {
  it("detects SQLite and gzip XML by bytes", async () => {
    expect(await detectBookFormat(await load("oracle-mini.sqlite.gnucash"))).toBe(
      "sqlite",
    );
    expect(await detectBookFormat(await load("oracle-mini.gnucash"))).toBe("xml");
  });

  it("refuses an unknown file", async () => {
    await expect(
      detectBookFormat(new TextEncoder().encode("not a book")),
    ).rejects.toBeInstanceOf(BookFormatError);
  });

  it("reads the GnuCash XML backend", async () => {
    const snapshot = await readBookSnapshot(await load("oracle-mini.gnucash"));

    expect(snapshot.currencyCode).toBe("USD");
    expect(snapshot.fraction).toBe(100);
    expect(snapshot.accounts).toHaveLength(5);

    const byName = new Map(snapshot.accounts.map((account) => [account.name, account]));
    expect(byName.get("Root Account")?.type).toBe("ROOT");
    expect(byName.get("Assets")?.type).toBe("ASSET");
    expect(byName.get("Bank")?.type).toBe("BANK");
    expect(byName.get("Income")?.type).toBe("INCOME");
    expect(byName.get("Salary")?.type).toBe("INCOME");
    expect(byName.get("Assets")?.parentGuid).toBe(byName.get("Root Account")?.guid);
    expect(byName.get("Bank")?.parentGuid).toBe(byName.get("Assets")?.guid);
    expect(byName.get("Salary")?.parentGuid).toBe(byName.get("Income")?.guid);
    expect(byName.get("Bank")?.commodityCode).toBe("USD");

    expect(snapshot.transactions).toHaveLength(1);
    const transaction = snapshot.transactions[0];
    if (!transaction) throw new Error("missing transaction");
    expect(transaction.description).toBe("Opening deposit");
    expect(transaction.date).toBe("2025-01-15");
    expect(transaction.currencyCode).toBe("USD");
    expect(transaction.splits).toHaveLength(2);

    const bank = transaction.splits.find(
      (split) => split.accountGuid === byName.get("Bank")?.guid,
    );
    const salary = transaction.splits.find(
      (split) => split.accountGuid === byName.get("Salary")?.guid,
    );
    expect(bank && equalsMoney(bank.value, money(250_000n, 100n))).toBe(true);
    expect(salary && equalsMoney(salary.value, money(-250_000n, 100n))).toBe(true);
  });

  it("reads plain XML as well as gzip", async () => {
    const plain = gunzipSync(await readFile(fixture("oracle-mini.gnucash")));
    const snapshot = parseGnuCashXml(plain.toString("utf8"));
    expect(snapshot.accounts).toHaveLength(5);
    expect(snapshot.transactions[0]?.splits).toHaveLength(2);
  });
});

describe("book format errors", () => {
  it("rejects malformed XML", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(BookFormatError);
    expect(() => parseXml("<a>")).toThrow(BookFormatError);
    expect(() => parseXml("</a>")).toThrow(BookFormatError);
    expect(() => parseXml("<a><!-- open")).toThrow(BookFormatError);
    expect(() => parseXml("<?xml")).toThrow(BookFormatError);
    expect(() => parseXml("<a")).toThrow(BookFormatError);
  });

  it("rejects books without a GUID, accounts or rational values", () => {
    expect(() => parseGnuCashXml("<gnc-v2></gnc-v2>")).toThrow(BookFormatError);
    expect(() => parseGnuCashXml("<gnc-v2><gnc:book></gnc:book></gnc-v2>")).toThrow(
      BookFormatError,
    );
    expect(() =>
      parseGnuCashXml(
        '<gnc-v2><gnc:book><book:id type="guid">abc</book:id></gnc:book></gnc-v2>',
      ),
    ).toThrow(BookFormatError);
    expect(() =>
      parseGnuCashXml(`
        <gnc-v2><gnc:book>
          <book:id type="guid">abc</book:id>
          <gnc:account><act:id type="guid">a1</act:id><act:name>Cash</act:name><act:type>CASH</act:type></gnc:account>
          <gnc:transaction>
            <trn:id type="guid">t1</trn:id>
            <trn:splits><trn:split><split:account>a1</split:account><split:value>oops</split:value></trn:split></trn:splits>
          </gnc:transaction>
        </gnc:book></gnc-v2>
      `),
    ).toThrow(BookFormatError);
  });

  it("rejects gzip that is not XML", async () => {
    const zipped = gzipSync(Buffer.from("not xml"));
    await expect(detectBookFormat(new Uint8Array(zipped))).rejects.toBeInstanceOf(
      BookFormatError,
    );
  });

  it("requires a SQLite reader for SQLite books and delegates to it", async () => {
    const bytes = await load("oracle-mini.sqlite.gnucash");
    await expect(readBookSnapshot(bytes)).rejects.toBeInstanceOf(BookFormatError);

    const snapshot: BookSnapshot = {
      bookGuid: "1".repeat(32),
      currencyCode: "USD",
      fraction: 100,
      accounts: [],
      transactions: [],
    };
    expect(await readBookSnapshot(bytes, async () => snapshot)).toBe(snapshot);
  });
});
