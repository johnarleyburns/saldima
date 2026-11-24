// SPDX-License-Identifier: AGPL-3.0-only

import { addMoney, type Money, money, negateMoney } from "@saldima/gnucash";

export interface SplitAmount {
  readonly accountGuid: string;
  readonly value: Money;
}

export interface AccountTypeRow {
  readonly guid: string;
  readonly account_type: string;
}

export interface BookTotals {
  readonly assets: Money;
  readonly liabilities: Money;
  readonly netAssets: Money;
  readonly profit: Money;
}

/** Sums split values per account. Exact rationals throughout. */
export function sumSplitBalances(splits: readonly SplitAmount[]): Map<string, Money> {
  const balances = new Map<string, Money>();
  for (const split of splits) {
    balances.set(
      split.accountGuid,
      addMoney(balances.get(split.accountGuid) ?? money(0n), split.value),
    );
  }
  return balances;
}

const ASSET_TYPES = new Set(["ASSET", "BANK", "CASH", "RECEIVABLE"]);
const LIABILITY_TYPES = new Set(["LIABILITY", "CREDIT", "PAYABLE"]);

/** Net assets and profit, the same numbers the Apps show. */
export function bookTotals(
  accounts: readonly AccountTypeRow[],
  balances: ReadonlyMap<string, Money>,
): BookTotals {
  let assets = money(0n);
  let liabilities = money(0n);
  let income = money(0n);
  let expense = money(0n);
  for (const account of accounts) {
    const balance = balances.get(account.guid) ?? money(0n);
    if (ASSET_TYPES.has(account.account_type)) assets = addMoney(assets, balance);
    else if (LIABILITY_TYPES.has(account.account_type))
      liabilities = addMoney(liabilities, balance);
    else if (account.account_type === "INCOME") income = addMoney(income, balance);
    else if (account.account_type === "EXPENSE") expense = addMoney(expense, balance);
  }
  return {
    assets,
    liabilities,
    netAssets: addMoney(assets, negateMoney(liabilities)),
    profit: negateMoney(addMoney(income, expense)),
  };
}
