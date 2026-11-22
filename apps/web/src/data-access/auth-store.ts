// SPDX-License-Identifier: AGPL-3.0-only

interface ExecLike {
  exec(query: string, ...bindings: Array<string | number | null>): unknown;
}

/** Session rows are not ledger data, but deletes still live in data-access. */
export function deleteSession(sql: ExecLike, tokenHash: string): void {
  sql.exec("DELETE FROM gcw_sessions WHERE token_hash = ?", tokenHash);
}
