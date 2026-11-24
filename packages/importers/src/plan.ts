// SPDX-License-Identifier: AGPL-3.0-only

import { addMoney, isZeroMoney, type Money, negateMoney } from "@saldima/gnucash";

import type { ImportRow } from "./types.ts";

export interface ImportMapping {
  readonly targetAccountGuid: string;
  readonly defaultAccountGuid: string;
  readonly categoryAccounts: Readonly<Record<string, string>>;
}

export interface PlannedSplit {
  readonly accountGuid: string;
  readonly value: Money;
}

export interface PlannedTransaction {
  readonly date: string;
  readonly description: string;
  readonly splits: readonly PlannedSplit[];
}

/** QIF writes transfers as `[Savings]`; map either form to the account name. */
export function categoryKey(category: string): string {
  const value = category.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function counterGuid(category: string, mapping: ImportMapping): string {
  return mapping.categoryAccounts[categoryKey(category)] ?? mapping.defaultAccountGuid;
}

function description(row: ImportRow): string {
  const parts = [row.payee.trim(), row.memo.trim()].filter(Boolean);
  const joined = parts.length > 0 ? parts.join(" — ") : "Imported transaction";
  return joined.slice(0, 200);
}

/** Builds balanced two-or-more-split transactions from statement rows. */
export function planImport(
  rows: readonly ImportRow[],
  mapping: ImportMapping,
): PlannedTransaction[] {
  return rows.map((row): PlannedTransaction => {
    const splits: PlannedSplit[] = [
      { accountGuid: mapping.targetAccountGuid, value: row.amount },
    ];
    if (row.splits.length === 0) {
      splits.push({
        accountGuid: counterGuid(row.category, mapping),
        value: negateMoney(row.amount),
      });
    } else {
      let counterTotal = { num: 0n, denom: 1n };
      for (const split of row.splits) {
        const value = negateMoney(split.amount);
        counterTotal = addMoney(counterTotal, value);
        splits.push({ accountGuid: counterGuid(split.category, mapping), value });
      }
      const remainder = addMoney(counterTotal, row.amount);
      if (!isZeroMoney(remainder)) {
        splits.push({
          accountGuid: mapping.defaultAccountGuid,
          value: negateMoney(remainder),
        });
      }
    }
    return { date: row.date, description: description(row), splits };
  });
}
