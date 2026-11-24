// SPDX-License-Identifier: AGPL-3.0-only
import { formatMoney, type Money } from "@saldima/gnucash";
import { describe, expect, it } from "vitest";

import { parseImportAmount } from "./amount.ts";
import { parseImportDate } from "./date.ts";
import { dayOrdinal, isLikelyDuplicate } from "./duplicates.ts";
import { decodeImportRows, encodeImportRows } from "./encode.ts";
import { planImport } from "./plan.ts";
import { ImportFormatError } from "./types.ts";

function cents(value: Money): string {
  return formatMoney(value, 100n);
}

describe("bank dates", () => {
  it("accepts the date shapes banks export", () => {
    expect(parseImportDate("2024-01-31")).toBe("2024-01-31");
    expect(parseImportDate("2024/1/31")).toBe("2024-01-31");
    expect(parseImportDate("01/31/2024")).toBe("2024-01-31");
    expect(parseImportDate("31/01/2024")).toBe("2024-01-31");
    expect(parseImportDate("1/2/24")).toBe("2024-01-02");
    expect(parseImportDate("20240131120000[0:GMT]")).toBe("2024-01-31");
  });

  it("rejects impossible and unrecognised dates", () => {
    expect(parseImportDate("2024-02-30")).toBeNull();
    expect(parseImportDate("13/13/2024")).toBeNull();
    expect(parseImportDate("yesterday")).toBeNull();
    expect(parseImportDate("")).toBeNull();
  });

  it("handles leap years, short years and other separators", () => {
    expect(parseImportDate("02/29/2024")).toBe("2024-02-29");
    expect(parseImportDate("02/29/2023")).toBeNull();
    expect(parseImportDate("01/02/70")).toBe("1970-01-02");
    expect(parseImportDate("2024/13/01")).toBeNull();
    expect(parseImportDate("1 2 2024")).toBe("2024-01-02");
    expect(parseImportDate("20241301")).toBeNull();
  });
});

describe("bank amounts", () => {
  it("parses exact cents from common formats", () => {
    expect(cents(parseImportAmount("1,234.56") ?? { num: 0n, denom: 1n })).toBe(
      "1234.56",
    );
    expect(cents(parseImportAmount("$1.234,56") ?? { num: 0n, denom: 1n })).toBe(
      "1234.56",
    );
    expect(cents(parseImportAmount("(45.00)") ?? { num: 0n, denom: 1n })).toBe(
      "-45.00",
    );
    expect(cents(parseImportAmount("-12.345") ?? { num: 0n, denom: 1n })).toBe(
      "-12.35",
    );
    expect(cents(parseImportAmount("1.234") ?? { num: 0n, denom: 1n })).toBe("1.23");
  });

  it("rejects empty and non-numeric text", () => {
    expect(parseImportAmount("")).toBeNull();
    expect(parseImportAmount("n/a")).toBeNull();
  });

  it("handles signs, thousands and multiple separators", () => {
    expect(cents(parseImportAmount("45.00-") ?? { num: 0n, denom: 1n })).toBe("-45.00");
    expect(cents(parseImportAmount("+45.00") ?? { num: 0n, denom: 1n })).toBe("45.00");
    expect(cents(parseImportAmount("1,234") ?? { num: 0n, denom: 1n })).toBe("1234.00");
    expect(cents(parseImportAmount("1,23") ?? { num: 0n, denom: 1n })).toBe("1.23");
    expect(cents(parseImportAmount("1.234.567") ?? { num: 0n, denom: 1n })).toBe(
      "1234567.00",
    );
    expect(cents(parseImportAmount("USD 12.00") ?? { num: 0n, denom: 1n })).toBe(
      "12.00",
    );
    expect(cents(parseImportAmount("1,234.56") ?? { num: 0n, denom: 1n })).toBe(
      "1234.56",
    );
    expect(cents(parseImportAmount("1.234,56") ?? { num: 0n, denom: 1n })).toBe(
      "1234.56",
    );
    expect(parseImportAmount(".")).toBeNull();
    expect(parseImportAmount(",")).toBeNull();
  });
});

describe("duplicate detection", () => {
  const existing = [{ date: "2024-01-10", amount: { num: 1000n, denom: 100n } }];

  it("flags the same amount within three days", () => {
    expect(
      isLikelyDuplicate(
        { date: "2024-01-13", amount: { num: 10n, denom: 1n } },
        existing,
      ),
    ).toBe(true);
  });

  it("does not flag a different amount or a distant date", () => {
    expect(
      isLikelyDuplicate(
        { date: "2024-01-13", amount: { num: 1001n, denom: 100n } },
        existing,
      ),
    ).toBe(false);
    expect(
      isLikelyDuplicate(
        { date: "2024-01-14", amount: { num: 1000n, denom: 100n } },
        existing,
      ),
    ).toBe(false);
    expect(
      isLikelyDuplicate(
        { date: "2024-01-10", amount: { num: -1000n, denom: 100n } },
        existing,
      ),
    ).toBe(false);
  });

  it("ignores entries with unreadable dates", () => {
    expect(
      isLikelyDuplicate(
        { date: "not-a-date", amount: { num: 1000n, denom: 100n } },
        existing,
      ),
    ).toBe(false);
    expect(
      isLikelyDuplicate({ date: "2024-01-10", amount: { num: 1000n, denom: 100n } }, [
        { date: "not-a-date", amount: { num: 1000n, denom: 100n } },
      ]),
    ).toBe(false);
  });

  it("computes calendar ordinals without a clock", () => {
    expect(dayOrdinal("2024-02-29")).not.toBeNull();
    expect(dayOrdinal("2023-02-29")).toBeNull();
    expect(dayOrdinal("2024-04-31")).toBeNull();
    expect(dayOrdinal("2024-06-30")).not.toBeNull();
    expect(dayOrdinal("2024-09-30")).not.toBeNull();
    expect(dayOrdinal("2024-11-30")).not.toBeNull();
    expect(dayOrdinal("2024-13-01")).toBeNull();
    expect(dayOrdinal("bad")).toBeNull();
  });
});

describe("planning double-entry rows", () => {
  const mapping = {
    targetAccountGuid: "target",
    defaultAccountGuid: "unclassified",
    categoryAccounts: {
      "Food:Groceries": "groceries",
      Salary: "salary",
      Household: "household",
    },
  };

  it("posts a two-split transaction", () => {
    const [planned] = planImport(
      [
        {
          date: "2024-01-15",
          amount: { num: -4567n, denom: 100n },
          payee: "Grocery Mart",
          memo: "",
          reference: "1001",
          category: "Food:Groceries",
          splits: [],
        },
      ],
      mapping,
    );
    expect(planned?.description).toBe("Grocery Mart");
    expect(planned?.splits.map((split) => split.accountGuid)).toEqual([
      "target",
      "groceries",
    ]);
    expect(planned?.splits.map((split) => cents(split.value))).toEqual([
      "-45.67",
      "45.67",
    ]);
  });

  it("keeps QIF splits and balances any remainder to the default account", () => {
    const [planned] = planImport(
      [
        {
          date: "2024-03-01",
          amount: { num: -6000n, denom: 100n },
          payee: "Store",
          memo: "",
          reference: "",
          category: "",
          splits: [
            { category: "Food:Groceries", amount: { num: -4000n, denom: 100n } },
            { category: "Household", amount: { num: -1900n, denom: 100n } },
          ],
        },
      ],
      mapping,
    );
    expect(planned?.splits.map((split) => split.accountGuid)).toEqual([
      "target",
      "groceries",
      "household",
      "unclassified",
    ]);
    expect(planned?.splits.map((split) => cents(split.value))).toEqual([
      "-60.00",
      "40.00",
      "19.00",
      "1.00",
    ]);
  });

  it("falls back to the default account for unknown categories", () => {
    const [planned] = planImport(
      [
        {
          date: "2024-01-01",
          amount: { num: 150000n, denom: 100n },
          payee: "Employer",
          memo: "Payroll",
          reference: "",
          category: "Unknown",
          splits: [],
        },
      ],
      mapping,
    );
    expect(planned?.description).toBe("Employer — Payroll");
    expect(planned?.splits.map((split) => split.accountGuid)).toEqual([
      "target",
      "unclassified",
    ]);
  });

  it("normalises transfer categories and default descriptions", () => {
    const [planned] = planImport(
      [
        {
          date: "2024-01-01",
          amount: { num: -1000n, denom: 100n },
          payee: "",
          memo: "",
          reference: "",
          category: "[Savings]",
          splits: [],
        },
      ],
      { ...mapping, categoryAccounts: { Savings: "savings" } },
    );
    expect(planned?.description).toBe("Imported transaction");
    expect(planned?.splits.map((split) => split.accountGuid)).toEqual([
      "target",
      "savings",
    ]);
  });

  it("does not add a balancing split when QIF splits already balance", () => {
    const [planned] = planImport(
      [
        {
          date: "2024-01-01",
          amount: { num: -1000n, denom: 100n },
          payee: "Shop",
          memo: "",
          reference: "",
          category: "",
          splits: [
            { category: "Food:Groceries", amount: { num: -1000n, denom: 100n } },
          ],
        },
      ],
      mapping,
    );
    expect(planned?.splits).toHaveLength(2);
  });
});

describe("batch encoding", () => {
  it("round-trips exact rationals", () => {
    const rows = [
      {
        date: "2024-01-01",
        amount: { num: -4567n, denom: 100n },
        payee: "Shop",
        memo: "",
        reference: "1",
        category: "Food",
        splits: [{ category: "Food", amount: { num: -4567n, denom: 100n } }],
      },
    ] as const;
    const decoded = decodeImportRows(encodeImportRows(rows));
    expect(decoded[0]?.amount).toEqual({ num: -4567n, denom: 100n });
    expect(decoded[0]?.splits[0]?.amount).toEqual({ num: -4567n, denom: 100n });
  });

  it("rejects malformed staged batches", () => {
    expect(() => decodeImportRows("not json")).toThrow(ImportFormatError);
    expect(() => decodeImportRows("{}")).toThrow(ImportFormatError);
    expect(() => decodeImportRows("[null]")).toThrow(ImportFormatError);
    expect(() => decodeImportRows('[{"amount":"nope"}]')).toThrow(ImportFormatError);
    expect(() => decodeImportRows('[{"amount":"1/0"}]')).toThrow(ImportFormatError);
    expect(() => decodeImportRows('[{"amount":"1/2","splits":[null]}]')).toThrow(
      ImportFormatError,
    );
    expect(decodeImportRows('[{"amount":"1/2"}]')[0]).toMatchObject({
      date: "",
      payee: "",
      category: "",
    });
  });
});
