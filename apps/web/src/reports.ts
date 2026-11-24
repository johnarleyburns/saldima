// SPDX-License-Identifier: AGPL-3.0-only

import { addMoney, type Money, money, negateMoney } from "@saldima/gnucash";

export interface ReportAccount {
  readonly guid: string;
  readonly name: string;
  readonly account_type: string;
}

export interface ReportSplit {
  readonly accountGuid: string;
  readonly value: Money;
}

export interface TrialBalanceReport {
  readonly rows: ReadonlyArray<{
    name: string;
    type: string;
    debit: Money;
    credit: Money;
  }>;
  readonly totalDebits: Money;
  readonly totalCredits: Money;
  readonly balanced: boolean;
}

export interface BalanceSheetReport {
  readonly assets: Money;
  readonly liabilities: Money;
  readonly equity: Money;
  readonly retainedEarnings: Money;
  readonly total: Money;
  readonly balanced: boolean;
}

export interface IncomeStatementReport {
  readonly revenue: Money;
  readonly expenses: Money;
  readonly netIncome: Money;
}

const ASSETS = new Set(["ASSET", "BANK", "CASH", "RECEIVABLE"]);
const LIABILITIES = new Set(["LIABILITY", "CREDIT", "PAYABLE"]);

function balances(splits: readonly ReportSplit[]): Map<string, Money> {
  const totals = new Map<string, Money>();
  for (const split of splits) {
    totals.set(
      split.accountGuid,
      addMoney(totals.get(split.accountGuid) ?? money(0n), split.value),
    );
  }
  return totals;
}

export function trialBalance(
  accounts: readonly ReportAccount[],
  splits: readonly ReportSplit[],
): TrialBalanceReport {
  const totals = balances(splits);
  const rows: Array<{ name: string; type: string; debit: Money; credit: Money }> = [];
  let totalDebits = money(0n);
  let totalCredits = money(0n);
  for (const account of accounts) {
    const balance = totals.get(account.guid) ?? money(0n);
    if (balance.num === 0n) continue;
    const debit = balance.num > 0n ? balance : money(0n);
    const credit = balance.num < 0n ? negateMoney(balance) : money(0n);
    rows.push({ name: account.name, type: account.account_type, debit, credit });
    totalDebits = addMoney(totalDebits, debit);
    totalCredits = addMoney(totalCredits, credit);
  }
  return {
    rows,
    totalDebits,
    totalCredits,
    balanced:
      totalDebits.num === totalCredits.num && totalDebits.denom === totalCredits.denom,
  };
}

export function balanceSheet(
  accounts: readonly ReportAccount[],
  splits: readonly ReportSplit[],
): BalanceSheetReport {
  const totals = balances(splits);
  let assets = money(0n);
  let liabilities = money(0n);
  let equity = money(0n);
  let income = money(0n);
  let expense = money(0n);
  for (const account of accounts) {
    const balance = totals.get(account.guid) ?? money(0n);
    if (ASSETS.has(account.account_type)) assets = addMoney(assets, balance);
    else if (LIABILITIES.has(account.account_type))
      liabilities = addMoney(liabilities, balance);
    else if (account.account_type === "EQUITY") equity = addMoney(equity, balance);
    else if (account.account_type === "INCOME") income = addMoney(income, balance);
    else if (account.account_type === "EXPENSE") expense = addMoney(expense, balance);
  }
  const retained = negateMoney(addMoney(income, expense));
  const total = addMoney(
    addMoney(negateMoney(liabilities), negateMoney(equity)),
    retained,
  );
  return {
    assets,
    liabilities: negateMoney(liabilities),
    equity: negateMoney(equity),
    retainedEarnings: retained,
    total,
    balanced: assets.num === total.num && assets.denom === total.denom,
  };
}

export function incomeStatement(
  accounts: readonly ReportAccount[],
  splits: readonly ReportSplit[],
): IncomeStatementReport {
  const totals = balances(splits);
  let revenue = money(0n);
  let expenses = money(0n);
  for (const account of accounts) {
    const balance = totals.get(account.guid) ?? money(0n);
    if (account.account_type === "INCOME")
      revenue = addMoney(revenue, negateMoney(balance));
    else if (account.account_type === "EXPENSE") expenses = addMoney(expenses, balance);
  }
  return { revenue, expenses, netIncome: addMoney(revenue, negateMoney(expenses)) };
}
