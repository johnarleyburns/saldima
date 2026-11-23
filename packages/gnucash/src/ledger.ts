// SPDX-License-Identifier: AGPL-3.0-only

import type { Guid } from "./guid.ts";
import {
  addMoney,
  equalsMoney,
  type Money,
  money,
  negateMoney,
  roundToFractionHalfUp,
  subtractMoney,
} from "./money.ts";

export type AccountType =
  | "ASSET"
  | "BANK"
  | "CASH"
  | "CREDIT"
  | "LIABILITY"
  | "INCOME"
  | "EXPENSE"
  | "EQUITY"
  | "RECEIVABLE"
  | "PAYABLE";

export interface Account {
  readonly id: Guid;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId?: Guid;
}

export interface Split {
  readonly accountId: Guid;
  readonly value: Money;
}

export interface Transaction {
  readonly id: Guid;
  readonly date: string;
  readonly description: string;
  /** Transaction currency fraction; split values normalise to this with half-up. */
  readonly fraction?: bigint;
  readonly splits: readonly Split[];
}

export interface Ledger {
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
}

export type LedgerErrorCode =
  | "DUPLICATE_ACCOUNT"
  | "DUPLICATE_TRANSACTION"
  | "UNKNOWN_ACCOUNT"
  | "INVALID_DATE"
  | "TOO_FEW_SPLITS"
  | "UNBALANCED_TRANSACTION";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const ZERO = money(0n, 1n);
const ASSET_TYPES: ReadonlySet<AccountType> = new Set([
  "ASSET",
  "BANK",
  "CASH",
  "RECEIVABLE",
]);
const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set([
  "LIABILITY",
  "CREDIT",
  "PAYABLE",
]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createLedger(accounts: readonly Account[]): Ledger {
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new LedgerError("DUPLICATE_ACCOUNT", `duplicate account ${account.id}`);
    }
    ids.add(account.id);
  }
  return { accounts: [...accounts], transactions: [] };
}

export function post(ledger: Ledger, transaction: Transaction): Ledger {
  if (!DATE.test(transaction.date)) {
    throw new LedgerError("INVALID_DATE", `invalid date ${transaction.date}`);
  }
  if (ledger.transactions.some((existing) => existing.id === transaction.id)) {
    throw new LedgerError(
      "DUPLICATE_TRANSACTION",
      `duplicate transaction ${transaction.id}`,
    );
  }
  if (transaction.splits.length < 2) {
    throw new LedgerError("TOO_FEW_SPLITS", "a transaction needs at least two splits");
  }
  const accounts = new Set(ledger.accounts.map((account) => account.id));
  const fraction = transaction.fraction ?? 100n;
  const normalizedSplits = transaction.splits.map((split) => {
    if (!accounts.has(split.accountId)) {
      throw new LedgerError("UNKNOWN_ACCOUNT", `unknown account ${split.accountId}`);
    }
    return {
      accountId: split.accountId,
      value: roundToFractionHalfUp(split.value, fraction),
    };
  });
  let total = ZERO;
  for (const split of normalizedSplits) {
    total = addMoney(total, split.value);
  }
  if (!equalsMoney(total, ZERO)) {
    throw new LedgerError("UNBALANCED_TRANSACTION", "split values must sum to zero");
  }
  return {
    accounts: ledger.accounts,
    transactions: [
      ...ledger.transactions,
      { ...transaction, fraction, splits: normalizedSplits },
    ],
  };
}

function inRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function sumBalances(
  ledger: Ledger,
  types: ReadonlySet<AccountType>,
  from?: string,
  to?: string,
): Money {
  const ids = new Set(
    ledger.accounts
      .filter((account) => types.has(account.type))
      .map((account) => account.id),
  );
  let total = ZERO;
  for (const transaction of ledger.transactions) {
    if (!inRange(transaction.date, from, to)) continue;
    for (const split of transaction.splits) {
      if (ids.has(split.accountId)) total = addMoney(total, split.value);
    }
  }
  return total;
}

export function accountBalance(ledger: Ledger, accountId: Guid, asOf?: string): Money {
  let total = ZERO;
  for (const transaction of ledger.transactions) {
    if (!inRange(transaction.date, undefined, asOf)) continue;
    for (const split of transaction.splits) {
      if (split.accountId === accountId) total = addMoney(total, split.value);
    }
  }
  return total;
}

export interface TrialBalanceRow {
  readonly accountId: Guid;
  readonly name: string;
  readonly type: AccountType;
  readonly debit: Money;
  readonly credit: Money;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebits: Money;
  readonly totalCredits: Money;
  readonly balanced: boolean;
}

export function trialBalance(ledger: Ledger, asOf?: string): TrialBalance {
  const rows: TrialBalanceRow[] = [];
  let totalDebits = ZERO;
  let totalCredits = ZERO;
  for (const account of ledger.accounts) {
    const balance = accountBalance(ledger, account.id, asOf);
    if (equalsMoney(balance, ZERO)) continue;
    const debit = balance.num > 0n ? balance : ZERO;
    const credit = balance.num < 0n ? negateMoney(balance) : ZERO;
    const row: TrialBalanceRow = {
      accountId: account.id,
      name: account.name,
      type: account.type,
      debit,
      credit,
    };
    rows.push(row);
    totalDebits = addMoney(totalDebits, row.debit);
    totalCredits = addMoney(totalCredits, row.credit);
  }
  return {
    rows,
    totalDebits,
    totalCredits,
    balanced: equalsMoney(totalDebits, totalCredits),
  };
}

export interface BalanceSheet {
  readonly assets: Money;
  readonly liabilities: Money;
  readonly equity: Money;
  readonly retainedEarnings: Money;
  readonly totalLiabilitiesAndEquity: Money;
  readonly balanced: boolean;
}

export function balanceSheet(ledger: Ledger, asOf: string): BalanceSheet {
  const assets = sumBalances(ledger, ASSET_TYPES, undefined, asOf);
  const liabilities = negateMoney(
    sumBalances(ledger, LIABILITY_TYPES, undefined, asOf),
  );
  const equity = negateMoney(
    sumBalances(ledger, new Set<AccountType>(["EQUITY"]), undefined, asOf),
  );
  const income = sumBalances(ledger, new Set<AccountType>(["INCOME"]), undefined, asOf);
  const expense = sumBalances(
    ledger,
    new Set<AccountType>(["EXPENSE"]),
    undefined,
    asOf,
  );
  const retainedEarnings = negateMoney(addMoney(income, expense));
  const totalLiabilitiesAndEquity = addMoney(
    addMoney(liabilities, equity),
    retainedEarnings,
  );
  return {
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalLiabilitiesAndEquity,
    balanced: equalsMoney(assets, totalLiabilitiesAndEquity),
  };
}

export interface InvariantFailure {
  readonly code: "UNBALANCED_TRIAL_BALANCE" | "ASSETS_NE_LIABILITIES_PLUS_EQUITY";
  readonly message: string;
}

/** Checks a ledger that may have come from an import, not through `post`. */
export function verifyLedger(ledger: Ledger, asOf: string): InvariantFailure[] {
  const failures: InvariantFailure[] = [];
  const trial = trialBalance(ledger, asOf);
  if (!trial.balanced) {
    failures.push({
      code: "UNBALANCED_TRIAL_BALANCE",
      message: "trial balance debits do not equal credits",
    });
  }
  const sheet = balanceSheet(ledger, asOf);
  if (!sheet.balanced) {
    failures.push({
      code: "ASSETS_NE_LIABILITIES_PLUS_EQUITY",
      message: "assets do not equal liabilities plus equity",
    });
  }
  return failures;
}

export interface IncomeStatement {
  readonly revenue: Money;
  readonly expenses: Money;
  readonly netIncome: Money;
}

export function incomeStatement(
  ledger: Ledger,
  from: string,
  to: string,
): IncomeStatement {
  const income = sumBalances(ledger, new Set<AccountType>(["INCOME"]), from, to);
  const expenses = sumBalances(ledger, new Set<AccountType>(["EXPENSE"]), from, to);
  const revenue = negateMoney(income);
  return {
    revenue,
    expenses,
    netIncome: subtractMoney(revenue, expenses),
  };
}
