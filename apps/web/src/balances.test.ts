// SPDX-License-Identifier: AGPL-3.0-only

import { equalsMoney, money } from "@saldima/gnucash";
import { describe, expect, it } from "vitest";
import { bookTotals, sumSplitBalances } from "./balances";

describe("account balances", () => {
  it("sums split values per account exactly", () => {
    const balances = sumSplitBalances([
      { accountGuid: "bank", value: money(250_000n, 100n) },
      { accountGuid: "salary", value: money(-250_000n, 100n) },
      { accountGuid: "bank", value: money(-1n, 3n) },
    ]);
    const bank = balances.get("bank");
    const salary = balances.get("salary");
    expect(bank && equalsMoney(bank, money(7_499n, 3n))).toBe(true);
    expect(salary && equalsMoney(salary, money(-250_000n, 100n))).toBe(true);
  });

  it("computes net assets and profit like the apps", () => {
    const accounts = [
      { guid: "bank", account_type: "BANK" },
      { guid: "card", account_type: "CREDIT" },
      { guid: "sales", account_type: "INCOME" },
      { guid: "rent", account_type: "EXPENSE" },
    ];
    const balances = sumSplitBalances([
      { accountGuid: "bank", value: money(115_000n, 100n) },
      { accountGuid: "card", value: money(-20_000n, 100n) },
      { accountGuid: "sales", value: money(-20_000n, 100n) },
      { accountGuid: "rent", value: money(5_000n, 100n) },
    ]);
    const totals = bookTotals(accounts, balances);
    expect(equalsMoney(totals.netAssets, money(135_000n, 100n))).toBe(true);
    expect(equalsMoney(totals.profit, money(15_000n, 100n))).toBe(true);
  });
});
