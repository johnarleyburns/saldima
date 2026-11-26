// SPDX-License-Identifier: AGPL-3.0-only

import { equalsMoney, money } from "@saldima/gnucash";
import { describe, expect, it } from "vitest";
import { balanceSheet, incomeStatement, trialBalance } from "./reports";

const accounts = [
  { guid: "bank", name: "Bank", account_type: "BANK" },
  { guid: "equity", name: "Opening Balances", account_type: "EQUITY" },
  { guid: "sales", name: "Sales", account_type: "INCOME" },
  { guid: "rent", name: "Rent", account_type: "EXPENSE" },
];

// Opening balance on 2026-01-01, then a sale and a rent payment on
// 2026-02-10 -- split across two days so period filtering has something
// real to filter.
const splits = [
  { accountGuid: "bank", value: money(100_000n, 100n), date: "2026-01-01" },
  { accountGuid: "equity", value: money(-100_000n, 100n), date: "2026-01-01" },
  { accountGuid: "bank", value: money(20_000n, 100n), date: "2026-02-10" },
  { accountGuid: "sales", value: money(-20_000n, 100n), date: "2026-02-10" },
  { accountGuid: "bank", value: money(-5_000n, 100n), date: "2026-02-10" },
  { accountGuid: "rent", value: money(5_000n, 100n), date: "2026-02-10" },
];

describe("reports", () => {
  it("trial balance ties out", () => {
    const report = trialBalance(accounts, splits);
    expect(report.balanced).toBe(true);
    expect(equalsMoney(report.totalDebits, money(120_000n, 100n))).toBe(true);
    expect(equalsMoney(report.totalCredits, money(120_000n, 100n))).toBe(true);
  });

  it("balance sheet balances and income statement ties to profit", () => {
    const sheet = balanceSheet(accounts, splits);
    expect(equalsMoney(sheet.assets, money(115_000n, 100n))).toBe(true);
    expect(equalsMoney(sheet.retainedEarnings, money(15_000n, 100n))).toBe(true);
    expect(sheet.balanced).toBe(true);

    const pnl = incomeStatement(accounts, splits);
    expect(equalsMoney(pnl.revenue, money(20_000n, 100n))).toBe(true);
    expect(equalsMoney(pnl.expenses, money(5_000n, 100n))).toBe(true);
    expect(equalsMoney(pnl.netIncome, money(15_000n, 100n))).toBe(true);
  });

  it("balance sheet and trial balance are as-of a single date, cumulative since inception", () => {
    const beforeTheSale = balanceSheet(accounts, splits, "2026-01-31");
    expect(equalsMoney(beforeTheSale.assets, money(100_000n, 100n))).toBe(true);
    expect(equalsMoney(beforeTheSale.retainedEarnings, money(0n))).toBe(true);

    const afterEverything = balanceSheet(accounts, splits, "2026-02-10");
    expect(equalsMoney(afterEverything.assets, money(115_000n, 100n))).toBe(true);

    const trialBeforeTheSale = trialBalance(accounts, splits, "2026-01-31");
    expect(trialBeforeTheSale.rows).toHaveLength(2);
    expect(equalsMoney(trialBeforeTheSale.totalDebits, money(100_000n, 100n))).toBe(
      true,
    );
  });

  it("income statement is a range: only activity between from and to counts", () => {
    const wholeYear = incomeStatement(accounts, splits, {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(equalsMoney(wholeYear.netIncome, money(15_000n, 100n))).toBe(true);

    const beforeTheSale = incomeStatement(accounts, splits, {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(equalsMoney(beforeTheSale.revenue, money(0n))).toBe(true);
    expect(equalsMoney(beforeTheSale.expenses, money(0n))).toBe(true);

    const onlyFebruary = incomeStatement(accounts, splits, {
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(equalsMoney(onlyFebruary.revenue, money(20_000n, 100n))).toBe(true);
    expect(equalsMoney(onlyFebruary.expenses, money(5_000n, 100n))).toBe(true);
  });
});
