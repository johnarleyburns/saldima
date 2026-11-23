// SPDX-License-Identifier: AGPL-3.0-only

interface ExecLike {
  exec(query: string, ...bindings: Array<string | number | null>): unknown;
}

export function deleteAccount(sql: ExecLike, guid: string): void {
  sql.exec("DELETE FROM accounts WHERE guid = ?", guid);
}
