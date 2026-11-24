// SPDX-License-Identifier: AGPL-3.0-only

interface ExecLike {
  exec(query: string, ...bindings: Array<string | number | null>): unknown;
}

/** Removes one company and its ledger rows. Users and sessions stay intact. */
export function deleteBook(sql: ExecLike, bookId: string): void {
  sql.exec("DELETE FROM splits WHERE book_id = ?", bookId);
  sql.exec("DELETE FROM transactions WHERE book_id = ?", bookId);
  sql.exec("DELETE FROM accounts WHERE book_id = ?", bookId);
  sql.exec("DELETE FROM gcw_books WHERE id = ?", bookId);
}
