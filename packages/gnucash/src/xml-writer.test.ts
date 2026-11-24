// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { parseGnuCashXml } from "./book-file";
import { writeGnuCashXml } from "./xml-writer";

const fixture = fileURLToPath(
  new URL("../../../fixtures/books/oracle-mini.gnucash", import.meta.url),
);

describe("XML writer", () => {
  it("round-trips the oracle fixture", async () => {
    const original = parseGnuCashXml(
      gunzipSync(await readFile(fixture)).toString("utf8"),
    );
    const rewritten = parseGnuCashXml(writeGnuCashXml(original));

    expect(rewritten.bookGuid).toBe(original.bookGuid);
    expect(rewritten.currencyCode).toBe("USD");
    expect(
      rewritten.accounts.map((account) => [
        account.name,
        account.type,
        account.parentGuid,
      ]),
    ).toEqual(
      original.accounts.map((account) => [
        account.name,
        account.type,
        account.parentGuid,
      ]),
    );
    expect(rewritten.transactions).toHaveLength(1);
    const rewrittenTx = rewritten.transactions[0];
    const originalTx = original.transactions[0];
    if (!rewrittenTx || !originalTx) throw new Error("missing transaction");
    expect(rewrittenTx.description).toBe("Opening deposit");
    expect(rewrittenTx.date).toBe("2025-01-15");
    expect(rewrittenTx.splits.map((split) => split.value)).toEqual(
      originalTx.splits.map((split) => split.value),
    );
  });
});
