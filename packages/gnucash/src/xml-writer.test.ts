// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { parseGnuCashXml } from "./book-file";
import { money } from "./money";
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

  it("adds a structural root, valid split ids and the tags GnuCash requires", () => {
    const snapshot = {
      bookGuid: "a".repeat(32),
      currencyCode: "USD",
      fraction: 100,
      accounts: [
        {
          guid: "1".repeat(32),
          name: "Assets",
          type: "ASSET",
          parentGuid: null,
          commodityCode: "USD",
          code: "",
          description: "",
        },
        {
          guid: "2".repeat(32),
          name: "Bank",
          type: "BANK",
          parentGuid: "1".repeat(32),
          commodityCode: "USD",
          code: "",
          description: "",
        },
      ],
      transactions: [
        {
          guid: "3".repeat(32),
          date: "2026-01-01",
          description: "Opening",
          currencyCode: "USD",
          splits: [
            {
              guid: "4".repeat(32),
              accountGuid: "2".repeat(32),
              value: money(1_000n, 100n),
            },
            {
              guid: "5".repeat(32),
              accountGuid: "1".repeat(32),
              value: money(-1_000n, 100n),
            },
          ],
        },
      ],
    };
    const xml = writeGnuCashXml(snapshot);
    const parsed = parseGnuCashXml(xml);
    const root = parsed.accounts.find((account) => account.type === "ROOT");
    expect(root).toBeDefined();
    expect(
      parsed.accounts.find((account) => account.name === "Assets")?.parentGuid,
    ).toBe(root?.guid);
    expect(xml).toContain("<trn:date-entered>");
    expect(xml).toContain("<split:reconciled-state>n</split:reconciled-state>");
    expect(xml).toMatch(/<split:id type="guid">[0-9a-f]{32}<\/split:id>/);
  });

  it("keeps hidden and placeholder accounts", () => {
    const snapshot = {
      bookGuid: "a".repeat(32),
      currencyCode: "USD",
      fraction: 100,
      accounts: [
        {
          guid: "6".repeat(32),
          name: "Group",
          type: "ASSET",
          parentGuid: null,
          commodityCode: "USD",
          code: "",
          description: "",
          placeholder: true,
        },
        {
          guid: "7".repeat(32),
          name: "Old",
          type: "BANK",
          parentGuid: "6".repeat(32),
          commodityCode: "USD",
          code: "",
          description: "",
          hidden: true,
        },
      ],
      transactions: [],
    };
    const parsed = parseGnuCashXml(writeGnuCashXml(snapshot));
    expect(
      parsed.accounts.find((account) => account.name === "Group")?.placeholder,
    ).toBe(true);
    expect(parsed.accounts.find((account) => account.name === "Old")?.hidden).toBe(
      true,
    );
  });
});
