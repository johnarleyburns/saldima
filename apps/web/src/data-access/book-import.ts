// SPDX-License-Identifier: AGPL-3.0-only

import type { BookSnapshot } from "@saldima/gnucash";

interface ExecLike {
  exec(query: string, ...bindings: Array<string | number | null>): unknown;
}

/** Replaces a workspace with the contents of an imported GnuCash book. */
export function replaceBook(
  sql: ExecLike,
  snapshot: BookSnapshot,
  newGuid: () => string,
  now: string,
): void {
  sql.exec("DELETE FROM splits");
  sql.exec("DELETE FROM transactions");
  sql.exec("DELETE FROM accounts");
  for (const account of snapshot.accounts) {
    sql.exec(
      `INSERT INTO accounts
       (guid, name, account_type, commodity_guid, parent_guid, code,
        description, hidden, placeholder, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, ?)`,
      account.guid,
      account.name,
      account.type,
      account.parentGuid,
      account.code,
      account.description,
      now,
    );
  }
  for (const transaction of snapshot.transactions) {
    sql.exec(
      "INSERT INTO transactions (guid, currency_guid, post_date, description, created_at) VALUES (?, NULL, ?, ?, ?)",
      transaction.guid,
      transaction.date,
      transaction.description,
      now,
    );
    for (const split of transaction.splits) {
      sql.exec(
        "INSERT INTO splits (guid, tx_guid, account_guid, value_num, value_denom) VALUES (?, ?, ?, ?, ?)",
        newGuid(),
        transaction.guid,
        split.accountGuid,
        split.value.num.toString(),
        split.value.denom.toString(),
      );
    }
  }
}
