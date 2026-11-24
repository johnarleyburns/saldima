// SPDX-License-Identifier: AGPL-3.0-only

import { type Money, money } from "./money.ts";

export type BookFormat = "sqlite" | "xml";

export interface SnapshotAccount {
  readonly guid: string;
  readonly name: string;
  readonly type: string;
  readonly parentGuid: string | null;
  readonly commodityCode: string | null;
  readonly code: string;
  readonly description: string;
  readonly hidden?: boolean;
  readonly placeholder?: boolean;
}

export interface SnapshotSplit {
  readonly guid?: string | undefined;
  readonly accountGuid: string;
  readonly value: Money;
}

export interface SnapshotTransaction {
  readonly guid: string;
  readonly date: string;
  readonly description: string;
  readonly currencyCode: string | null;
  readonly splits: readonly SnapshotSplit[];
}

export interface BookSnapshot {
  readonly bookGuid: string;
  readonly currencyCode: string | null;
  readonly fraction: number | null;
  readonly accounts: readonly SnapshotAccount[];
  readonly transactions: readonly SnapshotTransaction[];
  readonly templateRootGuid?: string | null;
}

export class BookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookFormatError";
  }
}

const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\u0000");

function isGzip(prefix: Uint8Array): boolean {
  return prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** GnuCash 5.x sniffs bytes, never extensions. XML may be gzip-compressed. */
export async function detectBookFormat(bytes: Uint8Array): Promise<BookFormat> {
  if (startsWith(bytes, SQLITE_HEADER)) return "sqlite";
  if (isGzip(bytes)) {
    const attempt = new TextDecoder().decode(
      await gunzip(bytes).catch(() => new Uint8Array()),
    );
    if (
      attempt.startsWith("<?xml") ||
      attempt.startsWith("<gnc-v2") ||
      attempt.startsWith("<")
    ) {
      return "xml";
    }
    throw new BookFormatError("gzip is not a GnuCash XML book");
  }
  const text = new TextDecoder().decode(bytes.subarray(0, 64));
  if (text.startsWith("<?xml") || text.startsWith("<gnc-v2")) return "xml";
  throw new BookFormatError("unknown book format");
}

/** Reads either backend. SQLite needs the Durable Object's binding; callers pass it. */
export async function readBookSnapshot(
  bytes: Uint8Array,
  readSqlite?: (bytes: Uint8Array) => Promise<BookSnapshot>,
): Promise<BookSnapshot> {
  const format = await detectBookFormat(bytes);
  if (format === "sqlite") {
    if (!readSqlite) {
      throw new BookFormatError(
        "SQLite books are read through the book Durable Object",
      );
    }
    return readSqlite(bytes);
  }
  const xml = isGzip(bytes)
    ? new TextDecoder().decode(await gunzip(bytes))
    : new TextDecoder().decode(bytes);
  return parseGnuCashXml(xml);
}

interface XmlNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

/**
 * A deliberately small parser for GnuCash's machine-generated XML. It handles
 * elements, attributes, self-closing tags, comments and processing
 * instructions; GnuCash writes no DTD or CDATA in books.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const top = (): XmlNode => {
    const node = stack[stack.length - 1];
    if (!node) throw new BookFormatError("unbalanced XML");
    return node;
  };
  let index = 0;

  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open === -1) {
      top().text += xml.slice(index);
      break;
    }
    if (open > index) {
      top().text += xml.slice(index, open);
    }
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end === -1) throw new BookFormatError("unterminated comment");
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end === -1) throw new BookFormatError("unterminated processing instruction");
      index = end + 2;
      continue;
    }
    const close = xml.indexOf(">", open + 1);
    if (close === -1) throw new BookFormatError("unterminated tag");
    const body = xml.slice(open + 1, close).trim();
    index = close + 1;

    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) {
        throw new BookFormatError(`mismatched closing tag ${name}`);
      }
      continue;
    }

    const selfClosing = body.endsWith("/");
    const content = selfClosing ? body.slice(0, -1).trim() : body;
    const space = content.search(/\s/);
    const name = space === -1 ? content : content.slice(0, space);
    const attributes: Record<string, string> = {};
    if (space !== -1) {
      const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      const rest = content.slice(space + 1);
      for (const match of rest.matchAll(pattern)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined) attributes[key] = value;
      }
    }
    const node: XmlNode = { name, attributes, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (!parent) throw new BookFormatError("unbalanced XML");
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) throw new BookFormatError("unbalanced XML");
  return root;
}

function local(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function children(node: XmlNode, localName: string): XmlNode[] {
  return node.children.filter((child) => local(child.name) === localName);
}

function first(node: XmlNode, localName: string): XmlNode | undefined {
  return children(node, localName)[0];
}

function findNode(nodes: readonly XmlNode[], localName: string): XmlNode | undefined {
  for (const node of nodes) {
    if (local(node.name) === localName) return node;
    const found = findNode(node.children, localName);
    if (found) return found;
  }
  return undefined;
}

function text(node: XmlNode | undefined): string {
  return (node?.text ?? "").trim();
}

function rational(value: string): Money {
  const [num, denom] = value.split("/");
  if (!num || !denom) throw new BookFormatError(`bad rational ${value}`);
  return money(BigInt(num), BigInt(denom));
}

export function parseGnuCashXml(xml: string): BookSnapshot {
  const document = parseXml(xml);
  const book = findNode(document.children, "book");
  if (!book) throw new BookFormatError("missing gnc:book");

  const bookGuid = text(first(book, "id"));
  if (!bookGuid) throw new BookFormatError("missing book GUID");

  const commodities = children(book, "commodity");
  const currency = commodities.find(
    (commodity) => text(first(commodity, "space")) === "CURRENCY",
  );

  const accounts: SnapshotAccount[] = children(book, "account").map((account) => {
    const commodity = first(account, "commodity");
    const flags = { hidden: false, placeholder: false };
    const slots = first(account, "slots");
    for (const slot of slots ? children(slots, "slot") : []) {
      const key = text(first(slot, "key"));
      const value = text(first(slot, "value"));
      if (key === "hidden") flags.hidden = value === "true";
      else if (key === "placeholder") flags.placeholder = value === "true";
    }
    return {
      guid: text(first(account, "id")),
      name: text(first(account, "name")),
      type: text(first(account, "type")),
      parentGuid: text(first(account, "parent")) || null,
      commodityCode: commodity ? text(first(commodity, "id")) : null,
      code: text(first(account, "code")),
      description: text(first(account, "description")),
      hidden: flags.hidden,
      placeholder: flags.placeholder,
    };
  });
  if (accounts.length === 0) throw new BookFormatError("book has no accounts");

  const transactions: SnapshotTransaction[] = children(book, "transaction").map(
    (transaction) => {
      const currencyNode = first(transaction, "currency");
      const dateNode = first(transaction, "date-posted");
      const splitContainer = first(transaction, "splits");
      const splits = children(splitContainer ?? transaction, "split").map((split) => ({
        guid: text(first(split, "id")) || undefined,
        accountGuid: text(first(split, "account")),
        value: rational(text(first(split, "value"))),
      }));
      return {
        guid: text(first(transaction, "id")),
        date: text(dateNode ? first(dateNode, "date") : undefined).slice(0, 10),
        description: text(first(transaction, "description")),
        currencyCode: currencyNode ? text(first(currencyNode, "id")) : null,
        splits,
      };
    },
  );

  return {
    bookGuid,
    currencyCode: currency ? text(first(currency, "id")) : null,
    fraction: transactions[0]?.splits[0]
      ? Number(transactions[0].splits[0].value.denom)
      : null,
    accounts,
    transactions,
  };
}
