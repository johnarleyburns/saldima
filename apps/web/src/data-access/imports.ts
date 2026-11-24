// SPDX-License-Identifier: AGPL-3.0-only

interface ExecLike {
  exec(query: string, ...bindings: Array<string | number | null>): unknown;
}

export interface StagedImport {
  readonly id: string;
  readonly bookId: string;
  readonly targetAccountGuid: string;
  readonly source: string;
  readonly payload: string;
  readonly createdAt: string;
}

/** Imports are staged between upload and the mapping screen. */
export function insertImportBatch(sql: ExecLike, batch: StagedImport): void {
  sql.exec(
    `INSERT INTO gcw_import_batches
     (id, book_id, target_account_guid, source, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    batch.id,
    batch.bookId,
    batch.targetAccountGuid,
    batch.source,
    batch.payload,
    batch.createdAt,
  );
}

export function deleteImportBatch(sql: ExecLike, id: string, bookId: string): void {
  sql.exec("DELETE FROM gcw_import_batches WHERE id = ? AND book_id = ?", id, bookId);
}

export function deleteStaleImportBatches(
  sql: ExecLike,
  bookId: string,
  before: string,
): void {
  sql.exec(
    "DELETE FROM gcw_import_batches WHERE book_id = ? AND created_at < ?",
    bookId,
    before,
  );
}
