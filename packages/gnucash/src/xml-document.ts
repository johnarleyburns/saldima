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
  /**
   * GnuCash's "Associate File/Location": an `assoc_uri` slot. Saldima
   * writes a path relative to the book's own storage (so it never depends
   * on where that storage physically lives), but reads whatever is there.
   */
  readonly docLink: string | null;
}

/** A GnuCash `GncCustomer` business object: a billing contact for invoices. */
export interface XmlCustomer {
  readonly guid: string;
  readonly name: string;
  readonly customerNumber: string;
  readonly addressName: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly phone: string;
  readonly email: string;
  readonly notes: string;
  readonly active: boolean;
}

export interface CreateCustomerInput {
  readonly name: string;
  readonly customerNumber?: string;
  readonly addressName?: string;
  readonly addressLine1?: string;
  readonly addressLine2?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly notes?: string;
  readonly currency: CommodityRef;
}

export interface UpdateCustomerInput {
  readonly name?: string;
  readonly customerNumber?: string;
  readonly addressName?: string;
  readonly addressLine1?: string;
  readonly addressLine2?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly notes?: string;
  readonly active?: boolean;
}

/** One line on an invoice: a `GncEntry` business object. */
export interface XmlInvoiceEntry {
  readonly guid: string;
  readonly invoiceGuid: string;
  readonly date: string;
  readonly description: string;
  readonly quantity: Money;
  readonly unitPrice: Money;
  readonly incomeAccountGuid: string;
}

export interface CreateInvoiceEntryInput {
  readonly invoiceGuid: string;
  readonly date: string;
  readonly description: string;
  readonly quantity: Money;
  readonly unitPrice: Money;
  readonly incomeAccountGuid: string;
}

/**
 * A GnuCash `GncInvoice` business object. `datePosted === null` means it
 * is still a draft -- GnuCash's own distinction between an open and a
 * posted invoice; posting is the one-way action that creates the real
 * receivable/income transaction behind it.
 */
export interface XmlInvoice {
  readonly guid: string;
  readonly invoiceNumber: string;
  readonly customerGuid: string;
  readonly dateOpened: string;
  readonly datePosted: string | null;
  readonly notes: string;
  readonly active: boolean;
  readonly postedTransactionGuid: string | null;
  readonly receivableAccountGuid: string | null;
}

export interface CreateInvoiceInput {
  readonly customerGuid: string;
  readonly invoiceNumber: string;
  readonly dateOpened: string;
  readonly notes?: string;
  readonly currency: CommodityRef;
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
  private readonly customerNodes = new Map<string, XmlNode>();
  private readonly invoiceNodes = new Map<string, XmlNode>();

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
    this.customerNodes.clear();
    this.invoiceNodes.clear();
    for (const accountNode of children(this.book, "account")) {
      const guid = decoded(first(accountNode, "id"));
      if (guid) this.accountNodes.set(guid, accountNode);
    }
    for (const transactionNode of children(this.book, "transaction")) {
      const guid = decoded(first(transactionNode, "id"));
      if (guid) this.transactionNodes.set(guid, transactionNode);
    }
    for (const customerNode of children(this.book, "GncCustomer")) {
      const guid = decoded(first(customerNode, "guid"));
      if (guid) this.customerNodes.set(guid, customerNode);
    }
    for (const invoiceNode of children(this.book, "GncInvoice")) {
      const guid = decoded(first(invoiceNode, "guid"));
      if (guid) this.invoiceNodes.set(guid, invoiceNode);
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
    const slots = first(transactionNode, "slots");
    const docLinkSlot = slots
      ? children(slots, "slot").find(
          (slot) => decoded(first(slot, "key")) === "assoc_uri",
        )
      : undefined;
    return {
      guid: decoded(first(transactionNode, "id")),
      currency: readCommodityRef(transactionNode, "currency"),
      datePosted: decoded(nested(transactionNode, "date-posted", "date")),
      dateEntered: decoded(nested(transactionNode, "date-entered", "date")),
      num: decoded(first(transactionNode, "num")),
      description: decoded(first(transactionNode, "description")),
      splits,
      docLink: docLinkSlot ? decoded(first(docLinkSlot, "value")) : null,
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
   * Sets or clears a transaction's "Associate File/Location" --
   * `assoc_uri`, the same slot desktop GnuCash's own right-click action
   * writes. `uri = null` removes it.
   */
  setTransactionDocLink(transactionGuid: string, uri: string | null): void {
    const transactionNode = this.transactionNodes.get(transactionGuid);
    if (!transactionNode) {
      throw new GncXmlError(`unknown transaction ${transactionGuid}`);
    }
    const slots = findOrCreateSlots(transactionNode, "trn");
    const existing = children(slots, "slot").find(
      (slot) => decoded(first(slot, "key")) === "assoc_uri",
    );
    if (uri) {
      if (existing) {
        setLeafText(existing, "slot:value", uri);
      } else {
        slots.children.push(
          node("slot", {}, [
            leaf("slot:key", "assoc_uri"),
            leaf("slot:value", uri, { type: "string" }),
          ]),
        );
      }
    } else if (existing) {
      removeChild(slots, existing);
    }
    if (slots.children.length === 0) removeChild(transactionNode, slots);
  }

  // MARK: customers

  customers(): XmlCustomer[] {
    return [...this.customerNodes.values()].map((node) => this.readCustomer(node));
  }

  customer(guid: string): XmlCustomer | undefined {
    const customerNode = this.customerNodes.get(guid);
    return customerNode ? this.readCustomer(customerNode) : undefined;
  }

  private readCustomer(customerNode: XmlNode): XmlCustomer {
    const address = first(customerNode, "addr");
    const addressField = (name: string): string =>
      address ? decoded(first(address, name)) : "";
    return {
      guid: decoded(first(customerNode, "guid")),
      name: decoded(first(customerNode, "name")),
      customerNumber: decoded(first(customerNode, "id")),
      addressName: addressField("name"),
      addressLine1: addressField("addr1"),
      addressLine2: addressField("addr2"),
      phone: addressField("phone"),
      email: addressField("email"),
      notes: decoded(first(customerNode, "notes")),
      active: decoded(first(customerNode, "active")) !== "0",
    };
  }

  createCustomer(input: CreateCustomerInput, guid: Guid): XmlCustomer {
    if (this.customerNodes.has(guid)) {
      throw new GncXmlError(`duplicate customer ${guid}`);
    }
    const addressChildren = [
      leaf("addr:name", input.addressName ?? ""),
      leaf("addr:addr1", input.addressLine1 ?? ""),
      leaf("addr:addr2", input.addressLine2 ?? ""),
      leaf("addr:phone", input.phone ?? ""),
      leaf("addr:email", input.email ?? ""),
    ];
    const customerNode = node("gnc:GncCustomer", { version: "2.0.0" }, [
      guidNode("cust:guid", guid),
      leaf("cust:name", input.name),
      leaf("cust:id", input.customerNumber ?? ""),
      node("cust:addr", { version: "2.0.0" }, addressChildren),
      leaf("cust:notes", input.notes ?? ""),
      leaf("cust:active", "1"),
      commodityNode("cust:currency", input.currency),
    ]);
    this.book.children.push(customerNode);
    this.customerNodes.set(guid, customerNode);
    return this.readCustomer(customerNode);
  }

  updateCustomer(guid: string, patch: UpdateCustomerInput): XmlCustomer {
    const customerNode = this.customerNodes.get(guid);
    if (!customerNode) throw new GncXmlError(`unknown customer ${guid}`);
    if (patch.name !== undefined) setLeafText(customerNode, "cust:name", patch.name);
    if (patch.customerNumber !== undefined) {
      setLeafText(customerNode, "cust:id", patch.customerNumber);
    }
    if (patch.notes !== undefined) setLeafText(customerNode, "cust:notes", patch.notes);
    if (patch.active !== undefined) {
      setLeafText(customerNode, "cust:active", patch.active ? "1" : "0");
    }
    const addressFields: Array<[keyof UpdateCustomerInput, string]> = [
      ["addressName", "addr:name"],
      ["addressLine1", "addr:addr1"],
      ["addressLine2", "addr:addr2"],
      ["phone", "addr:phone"],
      ["email", "addr:email"],
    ];
    if (addressFields.some(([key]) => patch[key] !== undefined)) {
      const address =
        first(customerNode, "addr") ??
        setOrCreateChild(customerNode, "addr", () =>
          node("cust:addr", { version: "2.0.0" }),
        );
      for (const [key, tag] of addressFields) {
        const value = patch[key];
        if (value !== undefined) setLeafText(address, tag, String(value));
      }
    }
    return this.readCustomer(customerNode);
  }

  deleteCustomer(guid: string): void {
    const customerNode = this.customerNodes.get(guid);
    if (!customerNode) return;
    removeChild(this.book, customerNode);
    this.customerNodes.delete(guid);
  }

  customerInUse(guid: string): boolean {
    return this.invoices().some((invoice) => invoice.customerGuid === guid);
  }

  // MARK: invoices and entries

  invoices(): XmlInvoice[] {
    return [...this.invoiceNodes.values()].map((node) => this.readInvoice(node));
  }

  invoice(guid: string): XmlInvoice | undefined {
    const invoiceNode = this.invoiceNodes.get(guid);
    return invoiceNode ? this.readInvoice(invoiceNode) : undefined;
  }

  private readInvoice(invoiceNode: XmlNode): XmlInvoice {
    const owner = first(invoiceNode, "owner");
    return {
      guid: decoded(first(invoiceNode, "guid")),
      invoiceNumber: decoded(first(invoiceNode, "id")),
      customerGuid: owner ? decoded(first(owner, "id")) : "",
      dateOpened: decoded(nested(invoiceNode, "opened", "date")),
      datePosted: first(invoiceNode, "posted")
        ? decoded(nested(invoiceNode, "posted", "date"))
        : null,
      notes: decoded(first(invoiceNode, "notes")),
      active: decoded(first(invoiceNode, "active")) !== "0",
      postedTransactionGuid: first(invoiceNode, "posttxn")
        ? decoded(first(invoiceNode, "posttxn"))
        : null,
      receivableAccountGuid: first(invoiceNode, "postacc")
        ? decoded(first(invoiceNode, "postacc"))
        : null,
    };
  }

  /** Every line on one invoice, oldest first. */
  invoiceEntries(invoiceGuid: string): XmlInvoiceEntry[] {
    return children(this.book, "GncEntry")
      .map((entryNode) => this.readEntry(entryNode))
      .filter((entry): entry is XmlInvoiceEntry => entry?.invoiceGuid === invoiceGuid)
      .sort((a, b) =>
        a.date === b.date ? (a.guid < b.guid ? -1 : 1) : a.date < b.date ? -1 : 1,
      );
  }

  private readEntry(entryNode: XmlNode): XmlInvoiceEntry | null {
    const invoiceGuid = decoded(first(entryNode, "invoice"));
    const incomeAccountGuid = decoded(first(entryNode, "i-acct"));
    if (!invoiceGuid || !incomeAccountGuid) return null;
    return {
      guid: decoded(first(entryNode, "guid")),
      invoiceGuid,
      date: decoded(nested(entryNode, "date", "date")),
      description: decoded(first(entryNode, "description")),
      quantity: rational(text(first(entryNode, "qty"))),
      unitPrice: rational(text(first(entryNode, "i-price"))),
      incomeAccountGuid,
    };
  }

  createInvoice(input: CreateInvoiceInput, guid: Guid): XmlInvoice {
    if (this.invoiceNodes.has(guid)) {
      throw new GncXmlError(`duplicate invoice ${guid}`);
    }
    const owner = node("invoice:owner", { version: "2.0.0" }, [
      leaf("owner:type", "gncCustomer"),
      guidNode("owner:id", input.customerGuid),
    ]);
    const invoiceNode = node("gnc:GncInvoice", { version: "2.0.0" }, [
      guidNode("invoice:guid", guid),
      leaf("invoice:id", input.invoiceNumber),
      owner,
      node("invoice:opened", {}, [leaf("ts:date", input.dateOpened)]),
      leaf("invoice:notes", input.notes ?? ""),
      leaf("invoice:active", "1"),
      commodityNode("invoice:currency", input.currency),
    ]);
    this.book.children.push(invoiceNode);
    this.invoiceNodes.set(guid, invoiceNode);
    return this.readInvoice(invoiceNode);
  }

  /** Drafts only: a posted invoice is part of permanent ledger history. */
  deleteInvoice(guid: string): void {
    const invoiceNode = this.invoiceNodes.get(guid);
    if (!invoiceNode) return;
    for (const entryNode of children(this.book, "GncEntry")) {
      if (decoded(first(entryNode, "invoice")) === guid)
        removeChild(this.book, entryNode);
    }
    removeChild(this.book, invoiceNode);
    this.invoiceNodes.delete(guid);
  }

  addInvoiceEntry(input: CreateInvoiceEntryInput, guid: Guid): XmlInvoiceEntry {
    const entryNode = node("gnc:GncEntry", { version: "2.0.0" }, [
      guidNode("entry:guid", guid),
      node("entry:date", {}, [leaf("ts:date", input.date)]),
      node("entry:entered", {}, [leaf("ts:date", input.date)]),
      leaf("entry:description", input.description),
      leaf("entry:qty", rationalText(input.quantity)),
      guidNode("entry:i-acct", input.incomeAccountGuid),
      leaf("entry:i-price", rationalText(input.unitPrice)),
      leaf("entry:i-discount", "0/100"),
      guidNode("entry:invoice", input.invoiceGuid),
      leaf("entry:i-disc-type", "PERCENT"),
      leaf("entry:i-disc-how", "PRETAX"),
      leaf("entry:i-taxable", "0"),
      leaf("entry:i-taxincluded", "0"),
    ]);
    this.book.children.push(entryNode);
    const entry = this.readEntry(entryNode);
    if (!entry) throw new GncXmlError("failed to build invoice entry");
    return entry;
  }

  deleteInvoiceEntry(guid: string): void {
    const entryNode = children(this.book, "GncEntry").find(
      (candidate) => decoded(first(candidate, "guid")) === guid,
    );
    if (entryNode) removeChild(this.book, entryNode);
  }

  /**
   * Marks a draft invoice posted: stamps the posted date, the real ledger
   * transaction behind it, and the receivable account used -- matching
   * desktop GnuCash's own "Post Invoice" action. The caller creates that
   * transaction separately via `postTransaction`.
   */
  markInvoicePosted(
    guid: string,
    postedDate: string,
    transactionGuid: string,
    receivableAccountGuid: string,
  ): void {
    const invoiceNode = this.invoiceNodes.get(guid);
    if (!invoiceNode) throw new GncXmlError(`unknown invoice ${guid}`);
    invoiceNode.children.push(
      node("invoice:posted", {}, [leaf("ts:date", postedDate)]),
      guidNode("invoice:posttxn", transactionGuid),
      guidNode("invoice:postacc", receivableAccountGuid),
    );
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
