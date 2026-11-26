// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A GnuCash XML document kept as a live, mutable, full-fidelity model.
 *
 * Unlike `book-file.ts`'s `BookSnapshot` (a narrow, lossy projection used for
 * one-shot import/export), this keeps the original parsed element tree and
 * mutates it in place: known objects (accounts, transactions, splits) are
 * read from and written back to their own nodes, and anything this engine
 * does not model (other commodities, prices, lots, scheduled transactions,
 * budgets, business objects, unrelated slots) is never touched, so it
 * survives a parse/edit/serialize round trip untouched.
 */

import {
  BookFormatError,
  children,
  findNode,
  first,
  local,
  parseXml,
  rational,
  text,
  type XmlNode,
} from "./book-file.ts";
import type { Guid } from "./guid.ts";
import { addMoney, equalsMoney, type Money } from "./money.ts";

export class GncXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GncXmlError";
  }
}

export interface CommodityRef {
  readonly space: string;
  readonly id: string;
}

export interface XmlCommodity extends CommodityRef {
  readonly name: string | null;
  readonly fraction: number | null;
}

export interface XmlAccount {
  readonly guid: string;
  readonly name: string;
  readonly type: string;
  readonly parentGuid: string | null;
  readonly commodity: CommodityRef | null;
  readonly commodityScu: number | null;
  readonly code: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly placeholder: boolean;
}

export interface XmlSplit {
  readonly guid: string;
  readonly accountGuid: string;
  readonly memo: string;
  readonly action: string;
  /** `"n"` not reconciled, `"c"` cleared, `"y"` reconciled -- GnuCash's own codes. */
  readonly reconcileState: string;
  /** Set only once `reconcileState` is `"y"`; `YYYY-MM-DD HH:MM:SS +ZZZZ`. */
  readonly reconcileDate: string | null;
  readonly value: Money;
  readonly quantity: Money;
}

export interface XmlTransaction {
  readonly guid: string;
  readonly currency: CommodityRef | null;
  /** Full `YYYY-MM-DD HH:MM:SS +ZZZZ` timestamp, as GnuCash stores it. */
  readonly datePosted: string;
  readonly dateEntered: string;
  readonly num: string;
  readonly description: string;
  readonly splits: readonly XmlSplit[];
}

export interface CreateAccountInput {
  readonly name: string;
  readonly type: string;
  readonly parentGuid: string | null;
  readonly commodity: CommodityRef;
  readonly commodityScu?: number;
  readonly code?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly placeholder?: boolean;
}

export interface UpdateAccountInput {
  readonly name?: string;
  readonly type?: string;
  readonly parentGuid?: string | null;
  readonly code?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly placeholder?: boolean;
}

export interface PostSplitInput {
  readonly accountGuid: string;
  readonly value: Money;
  readonly quantity?: Money;
  readonly memo?: string;
  readonly action?: string;
  readonly reconcileState?: string;
}

export interface PostTransactionInput {
  readonly currency: CommodityRef;
  /** Full `YYYY-MM-DD HH:MM:SS +ZZZZ` timestamp for both posted and entered. */
  readonly datePosted: string;
  readonly dateEntered: string;
  readonly description: string;
  readonly num?: string;
  readonly splits: readonly PostSplitInput[];
}

export interface PostTransactionIds {
  readonly transaction: Guid;
  readonly splits: readonly Guid[];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** `text()` from book-file.ts returns raw (still-escaped) XML text; decode it. */
function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, body) => {
    if (match in ENTITIES) return ENTITIES[match] as string;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#"))
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return match;
  });
}

/** Keeps `.text` fields consistently stored pre-escaped, matching parsed nodes. */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decoded(node: XmlNode | undefined): string {
  return decodeXmlEntities(text(node));
}

function nested(
  parent: XmlNode,
  outerTag: string,
  innerTag: string,
): XmlNode | undefined {
  const outer = first(parent, outerTag);
  return outer ? first(outer, innerTag) : undefined;
}

function rationalText(value: Money): string {
  return `${value.num}/${value.denom}`;
}

/** Builds a new leaf/branch node from scratch; children already carry escaped text. */
function node(
  name: string,
  attributes: Record<string, string> = {},
  childrenNodes: XmlNode[] = [],
  leafText = "",
): XmlNode {
  return { name, attributes, children: childrenNodes, text: leafText };
}

function leaf(
  name: string,
  value: string,
  attributes: Record<string, string> = {},
): XmlNode {
  return node(name, attributes, [], escapeXml(value));
}

function guidNode(name: string, guid: string): XmlNode {
  return leaf(name, guid, { type: "guid" });
}

function commodityNode(tag: string, ref: CommodityRef): XmlNode {
  return node(tag, {}, [leaf("cmdty:space", ref.space), leaf("cmdty:id", ref.id)]);
}

function readCommodityRef(parent: XmlNode, tag: string): CommodityRef | null {
  const commodityNode_ = first(parent, tag);
  if (!commodityNode_) return null;
  return {
    space: decoded(first(commodityNode_, "space")),
    id: decoded(first(commodityNode_, "id")),
  };
}

function setOrCreateChild(
  parent: XmlNode,
  localName: string,
  build: () => XmlNode,
): XmlNode {
  const existing = first(parent, localName);
  if (existing) return existing;
  const created = build();
  parent.children.push(created);
  return created;
}

function removeChild(parent: XmlNode, child: XmlNode): void {
  const index = parent.children.indexOf(child);
  if (index !== -1) parent.children.splice(index, 1);
}

function setLeafText(parent: XmlNode, tag: string, value: string): void {
  const existing = first(parent, local(tag));
  if (existing) {
    existing.children.length = 0;
    existing.text = escapeXml(value);
    return;
  }
  parent.children.push(leaf(tag, value));
}

function findOrCreateSlots(
  accountOrTransaction: XmlNode,
  ownerTag: "act" | "trn",
): XmlNode {
  return setOrCreateChild(accountOrTransaction, "slots", () =>
    node(`${ownerTag}:slots`),
  );
}

function setBooleanSlot(slots: XmlNode, key: string, value: boolean): void {
  const existing = children(slots, "slot").find(
    (slot) => decoded(first(slot, "key")) === key,
  );
  if (!value) {
    if (existing) removeChild(slots, existing);
    return;
  }
  if (existing) {
    setLeafText(existing, "slot:value", "true");
    return;
  }
  slots.children.push(
    node("slot", {}, [
      leaf("slot:key", key),
      leaf("slot:value", "true", { type: "string" }),
    ]),
  );
}

function readBooleanSlot(account: XmlNode, key: string): boolean {
  const slots = first(account, "slots");
  if (!slots) return false;
  return children(slots, "slot").some(
    (slot) =>
      decoded(first(slot, "key")) === key && decoded(first(slot, "value")) === "true",
  );
}

/**
 * A live, mutable GnuCash XML book. Known objects (accounts, transactions,
 * splits) are read from and written back to their own element in the parsed
 * tree; everything else in the document is left untouched.
 */
export class GncXmlDocument {
  private readonly root: XmlNode;
  private readonly book: XmlNode;
  private readonly accountNodes = new Map<string, XmlNode>();
  private readonly transactionNodes = new Map<string, XmlNode>();

  private constructor(root: XmlNode, book: XmlNode) {
    this.root = root;
    this.book = book;
    this.reindex();
  }

  static parse(xml: string): GncXmlDocument {
    const root = parseXml(xml);
    const book = findNode(root.children, "book");
    if (!book) throw new BookFormatError("missing gnc:book");
    return new GncXmlDocument(root, book);
  }

  private reindex(): void {
    this.accountNodes.clear();
    this.transactionNodes.clear();
    for (const accountNode of children(this.book, "account")) {
      const guid = decoded(first(accountNode, "id"));
      if (guid) this.accountNodes.set(guid, accountNode);
    }
    for (const transactionNode of children(this.book, "transaction")) {
      const guid = decoded(first(transactionNode, "id"));
      if (guid) this.transactionNodes.set(guid, transactionNode);
    }
  }

  bookGuid(): string {
    return decoded(first(this.book, "id"));
  }

  commodities(): XmlCommodity[] {
    return children(this.book, "commodity").map((commodityNode_) => ({
      space: decoded(first(commodityNode_, "space")),
      id: decoded(first(commodityNode_, "id")),
      name: first(commodityNode_, "name")
        ? decoded(first(commodityNode_, "name"))
        : null,
      fraction: first(commodityNode_, "fraction")
        ? Number(decoded(first(commodityNode_, "fraction")))
        : null,
    }));
  }

  /** Adds the commodity if no commodity with the same space/id exists yet. */
  ensureCommodity(ref: CommodityRef, fraction = 100): void {
    const exists = this.commodities().some(
      (commodity) => commodity.space === ref.space && commodity.id === ref.id,
    );
    if (exists) return;
    const lastCommodity = children(this.book, "commodity").at(-1);
    const fragment = node("gnc:commodity", { version: "2.0.0" }, [
      leaf("cmdty:space", ref.space),
      leaf("cmdty:id", ref.id),
      leaf("cmdty:fraction", String(fraction)),
    ]);
    const index = lastCommodity ? this.book.children.indexOf(lastCommodity) + 1 : 0;
    this.book.children.splice(index, 0, fragment);
  }

  accounts(): XmlAccount[] {
    return [...this.accountNodes.values()].map((accountNode) =>
      this.readAccount(accountNode),
    );
  }

  account(guid: string): XmlAccount | undefined {
    const accountNode = this.accountNodes.get(guid);
    return accountNode ? this.readAccount(accountNode) : undefined;
  }

  private readAccount(accountNode: XmlNode): XmlAccount {
    const scuNode = first(accountNode, "commodity-scu");
    return {
      guid: decoded(first(accountNode, "id")),
      name: decoded(first(accountNode, "name")),
      type: decoded(first(accountNode, "type")),
      parentGuid: decoded(first(accountNode, "parent")) || null,
      commodity: readCommodityRef(accountNode, "commodity"),
      commodityScu: scuNode ? Number(decoded(scuNode)) : null,
      code: decoded(first(accountNode, "code")),
      description: decoded(first(accountNode, "description")),
      hidden: readBooleanSlot(accountNode, "hidden"),
      placeholder: readBooleanSlot(accountNode, "placeholder"),
    };
  }

  createAccount(input: CreateAccountInput, guid: Guid): XmlAccount {
    if (this.accountNodes.has(guid)) {
      throw new GncXmlError(`duplicate account ${guid}`);
    }
    const accountChildren: XmlNode[] = [
      leaf("act:name", input.name),
      guidNode("act:id", guid),
      leaf("act:type", input.type),
      commodityNode("act:commodity", input.commodity),
      leaf("act:commodity-scu", String(input.commodityScu ?? 100)),
    ];
    if (input.parentGuid)
      accountChildren.push(guidNode("act:parent", input.parentGuid));
    accountChildren.push(leaf("act:code", input.code ?? ""));
    accountChildren.push(leaf("act:description", input.description ?? ""));
    const accountNode = node("gnc:account", { version: "2.0.0" }, accountChildren);
    if (input.hidden || input.placeholder) {
      const slots = findOrCreateSlots(accountNode, "act");
      if (input.placeholder) setBooleanSlot(slots, "placeholder", true);
      if (input.hidden) setBooleanSlot(slots, "hidden", true);
    }
    this.insertAccountNode(accountNode);
    this.accountNodes.set(guid, accountNode);
    return this.readAccount(accountNode);
  }

  private insertAccountNode(accountNode: XmlNode): void {
    const firstTransaction = children(this.book, "transaction")[0];
    const index = firstTransaction
      ? this.book.children.indexOf(firstTransaction)
      : this.book.children.length;
    this.book.children.splice(index, 0, accountNode);
  }

  updateAccount(guid: string, patch: UpdateAccountInput): XmlAccount {
    const accountNode = this.accountNodes.get(guid);
    if (!accountNode) throw new GncXmlError(`unknown account ${guid}`);
    if (patch.name !== undefined) setLeafText(accountNode, "act:name", patch.name);
    if (patch.type !== undefined) setLeafText(accountNode, "act:type", patch.type);
    if (patch.code !== undefined) setLeafText(accountNode, "act:code", patch.code);
    if (patch.description !== undefined) {
      setLeafText(accountNode, "act:description", patch.description);
    }
    if (patch.parentGuid !== undefined) {
      const existing = first(accountNode, "parent");
      if (patch.parentGuid === null) {
        if (existing) removeChild(accountNode, existing);
      } else if (existing) {
        setLeafText(accountNode, "act:parent", patch.parentGuid);
      } else {
        accountNode.children.push(guidNode("act:parent", patch.parentGuid));
      }
    }
    if (patch.hidden !== undefined || patch.placeholder !== undefined) {
      const slots = findOrCreateSlots(accountNode, "act");
      if (patch.hidden !== undefined) setBooleanSlot(slots, "hidden", patch.hidden);
      if (patch.placeholder !== undefined)
        setBooleanSlot(slots, "placeholder", patch.placeholder);
      if (slots.children.length === 0) removeChild(accountNode, slots);
    }
    return this.readAccount(accountNode);
  }

  deleteAccount(guid: string): void {
    const accountNode = this.accountNodes.get(guid);
    if (!accountNode) return;
    removeChild(this.book, accountNode);
    this.accountNodes.delete(guid);
  }

  transactions(): XmlTransaction[] {
    return [...this.transactionNodes.values()].map((transactionNode) =>
      this.readTransaction(transactionNode),
    );
  }

  transaction(guid: string): XmlTransaction | undefined {
    const transactionNode = this.transactionNodes.get(guid);
    return transactionNode ? this.readTransaction(transactionNode) : undefined;
  }

  private readTransaction(transactionNode: XmlNode): XmlTransaction {
    const splitsContainer = first(transactionNode, "splits");
    const splits = children(splitsContainer ?? transactionNode, "split").map(
      (splitNode): XmlSplit => {
        const reconcileDateNode = nested(splitNode, "reconcile-date", "date");
        return {
          guid: decoded(first(splitNode, "id")),
          accountGuid: decoded(first(splitNode, "account")),
          memo: decoded(first(splitNode, "memo")),
          action: decoded(first(splitNode, "action")),
          reconcileState: decoded(first(splitNode, "reconciled-state")) || "n",
          reconcileDate: reconcileDateNode ? decoded(reconcileDateNode) : null,
          value: rational(text(first(splitNode, "value"))),
          quantity: rational(
            text(first(splitNode, "quantity")) || text(first(splitNode, "value")),
          ),
        };
      },
    );
    return {
      guid: decoded(first(transactionNode, "id")),
      currency: readCommodityRef(transactionNode, "currency"),
      datePosted: decoded(nested(transactionNode, "date-posted", "date")),
      dateEntered: decoded(nested(transactionNode, "date-entered", "date")),
      num: decoded(first(transactionNode, "num")),
      description: decoded(first(transactionNode, "description")),
      splits,
    };
  }

  /** Splits must have at least two entries and sum to exactly zero. */
  postTransaction(
    input: PostTransactionInput,
    ids: PostTransactionIds,
  ): XmlTransaction {
    if (this.transactionNodes.has(ids.transaction)) {
      throw new GncXmlError(`duplicate transaction ${ids.transaction}`);
    }
    if (input.splits.length < 2) {
      throw new GncXmlError("a transaction needs at least two splits");
    }
    if (input.splits.length !== ids.splits.length) {
      throw new GncXmlError("one split id is required per split");
    }
    let total: Money = { num: 0n, denom: 1n };
    for (const split of input.splits) total = addMoney(total, split.value);
    if (!equalsMoney(total, { num: 0n, denom: 1n })) {
      throw new GncXmlError("split values must sum to zero");
    }

    const splitNodes = input.splits.map((split, index) => {
      const splitId = ids.splits[index];
      if (!splitId) throw new GncXmlError("missing split id");
      const splitChildren: XmlNode[] = [
        guidNode("split:id", splitId),
        leaf("split:memo", split.memo ?? ""),
        leaf("split:reconciled-state", split.reconcileState ?? "n"),
        leaf("split:value", rationalText(split.value)),
        leaf("split:quantity", rationalText(split.quantity ?? split.value)),
        guidNode("split:account", split.accountGuid),
      ];
      if (split.action) splitChildren.splice(2, 0, leaf("split:action", split.action));
      return node("trn:split", {}, splitChildren);
    });

    const transactionChildren: XmlNode[] = [
      guidNode("trn:id", ids.transaction),
      commodityNode("trn:currency", input.currency),
      node("trn:date-posted", {}, [leaf("ts:date", input.datePosted)]),
      node("trn:date-entered", {}, [leaf("ts:date", input.dateEntered)]),
      leaf("trn:description", input.description),
    ];
    if (input.num) transactionChildren.push(leaf("trn:num", input.num));
    transactionChildren.push(node("trn:splits", {}, splitNodes));

    const transactionNode = node(
      "gnc:transaction",
      { version: "2.0.0" },
      transactionChildren,
    );
    this.book.children.push(transactionNode);
    this.transactionNodes.set(ids.transaction, transactionNode);
    return this.readTransaction(transactionNode);
  }

  deleteTransaction(guid: string): void {
    const transactionNode = this.transactionNodes.get(guid);
    if (!transactionNode) return;
    removeChild(this.book, transactionNode);
    this.transactionNodes.delete(guid);
  }

  /**
   * Sets one split's reconcile state, the same action as checking a row off
   * in GnuCash's Reconcile window. `reconcileDate` is required for `"y"`
   * (reconciled) and cleared for any other state, matching desktop GnuCash.
   */
  setSplitReconcileState(
    transactionGuid: string,
    splitGuid: string,
    state: "n" | "c" | "y",
    reconcileDate?: string,
  ): void {
    const transactionNode = this.transactionNodes.get(transactionGuid);
    if (!transactionNode)
      throw new GncXmlError(`unknown transaction ${transactionGuid}`);
    const splitsContainer = first(transactionNode, "splits") ?? transactionNode;
    const splitNode = children(splitsContainer, "split").find(
      (node) => decoded(first(node, "id")) === splitGuid,
    );
    if (!splitNode) throw new GncXmlError(`unknown split ${splitGuid}`);
    setLeafText(splitNode, "split:reconciled-state", state);
    const existingDate = first(splitNode, "reconcile-date");
    if (state === "y") {
      if (!reconcileDate) {
        throw new GncXmlError(
          "a reconcile date is required to mark a split reconciled",
        );
      }
      if (existingDate) {
        setLeafText(existingDate, "ts:date", reconcileDate);
      } else {
        splitNode.children.push(
          node("split:reconcile-date", {}, [leaf("ts:date", reconcileDate)]),
        );
      }
    } else if (existingDate) {
      removeChild(splitNode, existingDate);
    }
  }

  /**
   * Renders the (possibly mutated) document back to XML. Nodes this engine
   * never touched are emitted exactly as parsed; mutated/created nodes carry
   * pre-escaped text (see `escapeXml`/`decoded`), so no node is ever escaped
   * twice.
   */
  serialize(): string {
    return `<?xml version="1.0" encoding="utf-8" ?>\n${this.root.children
      .map((child) => serializeNode(child))
      .join("\n")}\n`;
  }
}

function attributesOf(nodeToRender: XmlNode): string {
  return Object.entries(nodeToRender.attributes)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
}

function serializeNode(nodeToRender: XmlNode): string {
  const attrs = attributesOf(nodeToRender);
  if (nodeToRender.children.length > 0) {
    return `<${nodeToRender.name}${attrs}>${nodeToRender.children
      .map((child) => serializeNode(child))
      .join("")}</${nodeToRender.name}>`;
  }
  if (nodeToRender.text === "") return `<${nodeToRender.name}${attrs}/>`;
  return `<${nodeToRender.name}${attrs}>${nodeToRender.text}</${nodeToRender.name}>`;
}
