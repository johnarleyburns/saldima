// SPDX-License-Identifier: AGPL-3.0-only

interface ExecLike {
  exec(query: string, ...bindings: Array<string | number | null>): unknown;
}

/**
 * Removes one company's metadata and staged imports. Users and sessions
 * stay intact; the ledger itself is a separate R2 object the caller deletes
 * through `BookXmlStore.delete`.
 */
export function deleteBook(sql: ExecLike, bookId: string): void {
  sql.exec("DELETE FROM gcw_import_batches WHERE book_id = ?", bookId);
  sql.exec("DELETE FROM gcw_books WHERE id = ?", bookId);
}
