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

const splits = [
  { accountGuid: "bank", value: money(115_000n, 100n) },
  { accountGuid: "equity", value: money(-100_000n, 100n) },
  { accountGuid: "sales", value: money(-20_000n, 100n) },
  { accountGuid: "rent", value: money(5_000n, 100n) },
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
});
