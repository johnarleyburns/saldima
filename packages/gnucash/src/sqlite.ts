// SPDX-License-Identifier: AGPL-3.0-only

import {
  BookFormatError,
  type BookSnapshot,
  type SnapshotAccount,
  type SnapshotTransaction,
} from "./book-file";
import { money } from "./money";

type Row = Record<string, string | null>;

const COLUMNS: Record<string, string[]> = {
  books: ["guid", "root_account_guid", "root_template_guid"],
  commodities: [
    "guid",
    "namespace",
    "mnemonic",
    "fullname",
    "cusip",
    "fraction",
    "quote_flag",
    "quote_source",
    "quote_tz",
  ],
  accounts: [
    "guid",
    "name",
    "account_type",
    "commodity_guid",
    "commodity_scu",
    "non_std_scu",
    "parent_guid",
    "code",
    "description",
    "hidden",
    "placeholder",
  ],
  transactions: [
    "guid",
    "currency_guid",
    "num",
    "post_date",
    "enter_date",
    "description",
  ],
  splits: [
    "guid",
    "tx_guid",
    "account_guid",
    "memo",
    "action",
    "reconcile_state",
    "reconcile_date",
    "value_num",
    "value_denom",
    "quantity_num",
    "quantity_denom",
    "lot_guid",
  ],
};

class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  pageSize = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\u0000") {
      throw new BookFormatError("not SQLite");
    }
    this.pageSize = this.view.getUint16(16, false);
    if (this.pageSize < 512 || this.pageSize > 65536 || this.pageSize % 2 !== 0) {
      throw new BookFormatError("bad page size");
    }
  }

  private page(number: number): {
    offset: number;
    type: number;
    cells: number;
    header: number;
  } {
    const offset = (number - 1) * this.pageSize + (number === 1 ? 100 : 0);
    const type = this.bytes[offset];
    const cells = this.view.getUint16(offset + 3, false);
    const header = type === 13 || type === 10 ? 8 : 12;
    if (type !== 13 && type !== 5)
      throw new BookFormatError(`unsupported b-tree page ${number} type ${type}`);
    return { offset, type, cells, header };
  }

  private cellOffset(page: number, index: number): number {
    const { offset, header } = this.page(page);
    // Pointer values are relative to the start of the page, not its header.
    const relative = this.view.getUint16(offset + header + index * 2, false);
    return (page - 1) * this.pageSize + relative;
  }

  private varint(offset: number): { value: number; next: number } {
    let value = 0;
    for (let i = 0; i < 9; i += 1) {
      const byte = this.bytes[offset + i];
      if (byte === undefined) throw new BookFormatError("bad varint");
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
    }
    throw new BookFormatError("bad varint");
  }

  private signed(bytes: Uint8Array): number {
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    const bits = bytes.length * 8;
    if (bits < 64 && (value & (1 << (bits - 1))) !== 0) value -= 2 ** bits;
    return value;
  }

  private record(offset: number, length: number): Array<string | null> {
    const headerSize = this.varint(offset);
    let cursor = headerSize.next;
    const headerEnd = offset + headerSize.value;
    const types: number[] = [];
    while (cursor < headerEnd) {
      const serial = this.varint(cursor);
      types.push(serial.value);
      cursor = serial.next;
    }
    let body = headerEnd;
    const values: Array<string | null> = [];
    for (const type of types) {
      if (type === 0) values.push(null);
      else if (type === 8) values.push("0");
      else if (type === 9) values.push("1");
      else if (type >= 1 && type <= 6) {
        const size = [0, 1, 2, 3, 4, 6, 8][type] ?? 0;
        values.push(String(this.signed(this.bytes.subarray(body, body + size))));
        body += size;
      } else if (type === 7) {
        values.push(String(this.view.getFloat64(body, false)));
        body += 8;
      } else {
        const size = type >= 13 ? (type - 13) / 2 : (type - 12) / 2;
        const slice = this.bytes.subarray(body, body + size);
        values.push(type >= 13 ? new TextDecoder().decode(slice) : null);
        body += size;
      }
    }
    if (body - offset > length) throw new BookFormatError("bad record");
    return values;
  }

  roots: Record<string, number> = {};

  private tableRows(root: number, columns: string[]): Row[] {
    const rows: Row[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const pageNumber = queue.shift() as number;
      const { type, cells } = this.page(pageNumber);
      for (let index = 0; index < cells; index += 1) {
        const cell = this.cellOffset(pageNumber, index);
        if (type === 5) {
          queue.push(this.view.getUint32(cell, false));
          continue;
        }
        const payload = this.varint(cell);
        const recordStart =
          payload.next + (this.varint(payload.next).next - payload.next);
        const values = this.record(recordStart, payload.value);
        const row: Row = {};
        columns.forEach((column, columnIndex) => {
          row[column] = values[columnIndex] ?? null;
        });
        rows.push(row);
      }
    }
    return rows;
  }

  read(): { master: Row[]; tables: Record<string, Row[]> } {
    const master: Row[] = [];
    const queue = [1];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const pageNumber = queue.shift() as number;
      if (visited.has(pageNumber)) continue;
      visited.add(pageNumber);
      const { type, cells } = this.page(pageNumber);
      for (let index = 0; index < cells; index += 1) {
        const cell = this.cellOffset(pageNumber, index);
        if (type === 5) {
          queue.push(this.view.getUint32(cell, false));
          continue;
        }
        const payload = this.varint(cell);
        const rowid = this.varint(payload.next);
        const values = this.record(rowid.next, payload.value);
        master.push({
          type: values[0] ?? null,
          name: values[1] ?? null,
          rootpage: values[3] ?? null,
        });
      }
    }
    const tables: Record<string, Row[]> = {};
    for (const entry of master) {
      const name = entry.name;
      if (!name || entry.type !== "table" || !COLUMNS[name]) continue;
      const root = Number(entry.rootpage);
      if (!Number.isFinite(root) || root === 0) continue;
      tables[name] = this.tableRows(root, COLUMNS[name]);
    }
    return { master, tables };
  }
}

export function readSqliteSnapshot(bytes: Uint8Array): BookSnapshot {
  const { tables } = new Reader(bytes).read();
  const book = tables.books?.[0];
  if (!book?.root_account_guid) throw new BookFormatError("book has no books row");
  const currency = (tables.commodities ?? []).find(
    (row) => row.namespace === "CURRENCY",
  );
  const accounts: SnapshotAccount[] = (tables.accounts ?? []).map((row) => ({
    guid: row.guid ?? "",
    name: row.name ?? "",
    type: row.account_type ?? "",
    parentGuid: row.parent_guid ?? null,
    commodityCode: row.commodity_guid ? (currency?.mnemonic ?? null) : null,
    code: row.code ?? "",
    description: row.description ?? "",
  }));
  if (accounts.length === 0) throw new BookFormatError("book has no accounts");

  const splits = tables.splits ?? [];
  const transactions: SnapshotTransaction[] = (tables.transactions ?? []).map(
    (row) => ({
      guid: row.guid ?? "",
      date: (row.post_date ?? "").slice(0, 10),
      description: row.description ?? "",
      currencyCode: currency?.mnemonic ?? null,
      splits: splits
        .filter((split) => split.tx_guid === row.guid)
        .map((split) => ({
          accountGuid: split.account_guid ?? "",
          value: money(
            BigInt(split.value_num ?? "0"),
            BigInt(split.value_denom ?? "1"),
          ),
        })),
    }),
  );

  return {
    bookGuid: book.root_account_guid,
    currencyCode: currency?.mnemonic ?? null,
    fraction: transactions[0]?.splits[0]
      ? Number(transactions[0].splits[0].value.denom)
      : null,
    accounts,
    transactions,
  };
}
