// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A GnuCash XML document kept as a live, mutable, full-fidelity model.
 *
 * Unlike `book-file.ts`'s `BookSnapshot` (a narrow, lossy projection used for
 * one-shot import/export), this keeps the original parsed element tree and
 * mutates it in place: known objects (accounts, transactions, splits) are
 * read from and written back to their own nodes, and anything this engine
 * does not model (other commodities, prices, lots, budgets, unrelated
 * slots) is never touched, so it survives a parse/edit/serialize round
 * trip untouched.
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
import {
  addMoney,
  equalsMoney,
  formatMoney,
  type Money,
  negateMoney,
} from "./money.ts";
import {
  addDays,
  nextInstance,
  type PeriodType,
  type Recurrence,
  type WeekendAdjust,
} from "./recurrence.ts";

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
  /** `"n"` not reconciled, `"c"` cleared, `"y"` reconciled, `"v"` voided -- GnuCash's own codes. */
  readonly reconcileState: string;
  /** Set only once `reconcileState` is `"y"`; `YYYY-MM-DD HH:MM:SS +ZZZZ`. */
  readonly reconcileDate: string | null;
  readonly value: Money;
  readonly quantity: Money;
  /** Pre-void value/quantity, set only while the parent transaction is voided. */
  readonly voidFormerValue: Money | null;
  readonly voidFormerQuantity: Money | null;
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
  /** True once `voidTransaction` has run; every split's value/quantity is zeroed. */
  readonly voided: boolean;
  readonly voidReason: string | null;
  /** `YYYY-MM-DD HH:MM:SS +ZZZZ`, set only while voided. */
  readonly voidTime: string | null;
}

/** One leg of a scheduled transaction's template. Signed: positive debits, negative credits. */
export interface XmlScheduledSplit {
  readonly accountGuid: string;
  readonly value: Money;
}

/**
 * A GnuCash `GncSchedXaction` (desktop's "Scheduled Transactions"): a
 * recurrence rule plus a template of splits that `postScheduledInstance`
 * turns into a real transaction when due. Milestone 1 (issue tracked in
 * the repo): fixed amounts only, no algebraic formulas; no deferred
 * ("postpone") instances.
 */
export interface XmlScheduledTransaction {
  readonly guid: string;
  readonly name: string;
  readonly description: string;
  readonly currency: CommodityRef;
  readonly enabled: boolean;
  /** Silently post a due instance with no review. */
  readonly autoCreate: boolean;
  /** Only meaningful with `autoCreate`: still post silently, but flag it for review. */
  readonly autoCreateNotify: boolean;
  /** How many days before the due date an instance is created/posted. */
  readonly advanceCreateDays: number;
  /** How many further days before that an upcoming instance is shown as a reminder. */
  readonly advanceRemindDays: number;
  readonly start: string;
  /** `YYYY-MM-DD`; `null` if no instance has posted yet. */
  readonly lastOccurred: string | null;
  readonly instanceCount: number;
  /** Mutually exclusive end conditions, matching desktop GnuCash; `null` means it never ends. */
  readonly end: { readonly occurrences: number } | { readonly date: string } | null;
  readonly recurrence: Recurrence;
  readonly templateAccountGuid: string;
  readonly templateSplits: readonly XmlScheduledSplit[];
}

export interface CreateScheduledTransactionInput {
  readonly name: string;
  readonly description: string;
  readonly currency: CommodityRef;
  readonly enabled?: boolean;
  readonly autoCreate?: boolean;
  readonly autoCreateNotify?: boolean;
  readonly advanceCreateDays?: number;
  readonly advanceRemindDays?: number;
  readonly start: string;
  readonly end?: { readonly occurrences: number } | { readonly date: string };
  readonly recurrence: Recurrence;
  readonly templateSplits: readonly XmlScheduledSplit[];
}

export interface UpdateScheduledTransactionInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly autoCreate?: boolean;
  readonly autoCreateNotify?: boolean;
  readonly advanceCreateDays?: number;
  readonly advanceRemindDays?: number;
}

export interface CreateScheduledTransactionIds {
  readonly scheduledTransaction: Guid;
  readonly templateAccount: Guid;
  readonly templateTransaction: Guid;
  readonly templateSplits: readonly Guid[];
  /** Only used the first time ever -- the template root is shared across the whole book. */
  readonly templateRoot?: Guid;
}

export type DueInstanceAction =
  | "autoPost"
  | "autoPostNotify"
  | "needsApproval"
  | "reminder";

export interface DueScheduledInstance {
  readonly scheduledTransactionGuid: string;
  readonly name: string;
  readonly date: string;
  readonly action: DueInstanceAction;
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

/** A GnuCash `GncVendor` business object: who a bill is owed to. */
export interface XmlVendor {
  readonly guid: string;
  readonly name: string;
  readonly vendorNumber: string;
  readonly addressLine1: string;
  readonly phone: string;
  readonly email: string;
  readonly notes: string;
  readonly active: boolean;
}

export interface CreateVendorInput {
  readonly name: string;
  readonly vendorNumber?: string;
  readonly addressLine1?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly notes?: string;
  readonly currency: CommodityRef;
}

export interface UpdateVendorInput {
  readonly name?: string;
  readonly vendorNumber?: string;
  readonly addressLine1?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly notes?: string;
  readonly active?: boolean;
}

/**
 * One line on a bill: also a `GncEntry`, but using its bill-side fields
 * (`entry:bill`/`entry:b-acct`/`entry:b-price`) -- distinct from an
 * invoice line's `entry:invoice`/`entry:i-acct`/`entry:i-price`, even
 * though both share the same XML element.
 */
export interface XmlBillEntry {
  readonly guid: string;
  readonly billGuid: string;
  readonly date: string;
  readonly description: string;
  readonly quantity: Money;
  readonly unitPrice: Money;
  readonly expenseAccountGuid: string;
}

export interface CreateBillEntryInput {
  readonly billGuid: string;
  readonly date: string;
  readonly description: string;
  readonly quantity: Money;
  readonly unitPrice: Money;
  readonly expenseAccountGuid: string;
}

/**
 * A vendor bill: GnuCash stores it as a `gnc:GncInvoice` exactly like a
 * customer invoice, distinguished only by `invoice:owner`'s
 * `owner:type` (`"gncVendor"` here, `"gncCustomer"` for an invoice).
 * `datePosted === null` means it is still a draft; posting is the
 * one-way action that creates the real payable/expense transaction.
 */
export interface XmlBill {
  readonly guid: string;
  readonly billNumber: string;
  readonly vendorGuid: string;
  readonly dateOpened: string;
  readonly datePosted: string | null;
  readonly notes: string;
  readonly active: boolean;
  readonly postedTransactionGuid: string | null;
  readonly payableAccountGuid: string | null;
}

export interface CreateBillInput {
  readonly vendorGuid: string;
  readonly billNumber: string;
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
  accountOrTransactionOrSplit: XmlNode,
  ownerTag: "act" | "trn" | "split",
): XmlNode {
  return setOrCreateChild(accountOrTransactionOrSplit, "slots", () =>
    node(`${ownerTag}:slots`),
  );
}

function findSlot(slots: XmlNode, key: string): XmlNode | undefined {
  return children(slots, "slot").find((slot) => decoded(first(slot, "key")) === key);
}

function readStringSlot(owner: XmlNode, key: string): string | null {
  const slots = first(owner, "slots");
  if (!slots) return null;
  const slot = findSlot(slots, key);
  return slot ? decoded(first(slot, "value")) : null;
}

function setStringSlot(slots: XmlNode, key: string, value: string | null): void {
  const existing = findSlot(slots, key);
  if (value === null) {
    if (existing) removeChild(slots, existing);
    return;
  }
  if (existing) {
    setLeafText(existing, "slot:value", value);
    return;
  }
  slots.children.push(
    node("slot", {}, [
      leaf("slot:key", key),
      leaf("slot:value", value, { type: "string" }),
    ]),
  );
}

function readNumericSlot(owner: XmlNode, key: string): Money | null {
  const slots = first(owner, "slots");
  if (!slots) return null;
  const slot = findSlot(slots, key);
  const valueNode = slot ? first(slot, "value") : undefined;
  return valueNode ? rational(text(valueNode)) : null;
}

function setNumericSlot(slots: XmlNode, key: string, value: Money | null): void {
  const existing = findSlot(slots, key);
  if (value === null) {
    if (existing) removeChild(slots, existing);
    return;
  }
  const valueText = rationalText(value);
  if (existing) {
    setLeafText(existing, "slot:value", valueText);
    return;
  }
  slots.children.push(
    node("slot", {}, [
      leaf("slot:key", key),
      leaf("slot:value", valueText, { type: "numeric" }),
    ]),
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
 * Desktop GnuCash's own `recurrencePeriodTypeToString`/`FromString`
 * (`libgnucash/engine/Recurrence.cpp`) -- note the spaces, not
 * underscores, in three of these: verified against real GnuCash source.
 */
const PERIOD_TYPE_TO_XML: Record<PeriodType, string> = {
  once: "once",
  day: "day",
  week: "week",
  month: "month",
  end_of_month: "end of month",
  nth_weekday: "nth weekday",
  last_weekday: "last weekday",
  year: "year",
};

const PERIOD_TYPE_FROM_XML: ReadonlyMap<string, PeriodType> = new Map(
  Object.entries(PERIOD_TYPE_TO_XML).map(([internal, xml]) => [
    xml,
    internal as PeriodType,
  ]),
);

function gdateNode(tag: string, date: string): XmlNode {
  return node(tag, {}, [leaf("gdate", date)]);
}

function readGdate(parent: XmlNode, tag: string): string | null {
  const wrapper = first(parent, tag);
  if (!wrapper) return null;
  const inner = first(wrapper, "gdate");
  return inner ? decoded(inner) : null;
}

/** A KVP frame value: `<slot:value type="frame">` wrapping its own nested `<slot>` entries. */
function frameSlotValue(
  entries: ReadonlyArray<{ key: string; type: string; text: string }>,
): XmlNode {
  return node(
    "slot:value",
    { type: "frame" },
    entries.map((entry) =>
      node("slot", {}, [
        leaf("slot:key", entry.key),
        leaf("slot:value", entry.text, { type: entry.type }),
      ]),
    ),
  );
}

/** Reads a nested KVP frame slot (e.g. `sched-xaction`) as a flat key -> text map. */
function readFrameSlotEntries(owner: XmlNode, frameKey: string): Map<string, string> {
  const entries = new Map<string, string>();
  const slots = first(owner, "slots");
  if (!slots) return entries;
  const frameSlot = children(slots, "slot").find(
    (slot) => decoded(first(slot, "key")) === frameKey,
  );
  const frameValue = frameSlot ? first(frameSlot, "value") : undefined;
  if (!frameValue) return entries;
  for (const entry of children(frameValue, "slot")) {
    const key = decoded(first(entry, "key"));
    const valueNode = first(entry, "value");
    if (key && valueNode) entries.set(key, decoded(valueNode));
  }
  return entries;
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
  private readonly vendorNodes = new Map<string, XmlNode>();
  private readonly scheduledTransactionNodes = new Map<string, XmlNode>();

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
    this.vendorNodes.clear();
    this.scheduledTransactionNodes.clear();
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
    // Customer invoices and vendor bills are both `gnc:GncInvoice`,
    // distinguished only by `invoice:owner`'s `owner:type` -- this index
    // holds both; `invoices()`/`bills()` filter by owner type on read.
    for (const invoiceNode of children(this.book, "GncInvoice")) {
      const guid = decoded(first(invoiceNode, "guid"));
      if (guid) this.invoiceNodes.set(guid, invoiceNode);
    }
    for (const vendorNode of children(this.book, "GncVendor")) {
      const guid = decoded(first(vendorNode, "guid"));
      if (guid) this.vendorNodes.set(guid, vendorNode);
    }
    for (const sxNode of children(this.book, "schedxaction")) {
      const guid = decoded(first(sxNode, "id"));
      if (guid) this.scheduledTransactionNodes.set(guid, sxNode);
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
          voidFormerValue: readNumericSlot(splitNode, "void-former-value"),
          voidFormerQuantity: readNumericSlot(splitNode, "void-former-amount"),
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
      voided: readStringSlot(transactionNode, "void-time") !== null,
      voidReason: readStringSlot(transactionNode, "void-reason"),
      voidTime: readStringSlot(transactionNode, "void-time"),
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

  /**
   * Voids a transaction exactly like desktop GnuCash's own `xaccTransVoid`:
   * every split's value and quantity is preserved in a `void-former-*`
   * slot, then zeroed (so the transaction stops affecting any balance
   * without being deleted), every split is marked `"v"`, and the
   * transaction's notes/void-reason/void-time/read-only slots record why
   * and when. Refuses to void an already-voided transaction.
   */
  voidTransaction(transactionGuid: string, reason: string, voidTime: string): void {
    const transactionNode = this.transactionNodes.get(transactionGuid);
    if (!transactionNode) {
      throw new GncXmlError(`unknown transaction ${transactionGuid}`);
    }
    if (!reason.trim()) {
      throw new GncXmlError("a reason is required to void a transaction");
    }
    if (readStringSlot(transactionNode, "void-time") !== null) {
      throw new GncXmlError(`transaction ${transactionGuid} is already voided`);
    }

    const slots = findOrCreateSlots(transactionNode, "trn");
    const existingNotes = readStringSlot(transactionNode, "notes");
    if (existingNotes !== null)
      setStringSlot(slots, "void-former-notes", existingNotes);
    setStringSlot(slots, "notes", "Voided transaction");
    setStringSlot(slots, "void-reason", reason);
    setStringSlot(slots, "void-time", voidTime);
    setStringSlot(slots, "trans-read-only", "Transaction Voided");

    const splitsContainer = first(transactionNode, "splits") ?? transactionNode;
    for (const splitNode of children(splitsContainer, "split")) {
      const value = rational(text(first(splitNode, "value")));
      const quantity = rational(
        text(first(splitNode, "quantity")) || text(first(splitNode, "value")),
      );
      const splitSlots = findOrCreateSlots(splitNode, "split");
      setNumericSlot(splitSlots, "void-former-value", value);
      setNumericSlot(splitSlots, "void-former-amount", quantity);
      setLeafText(
        splitNode,
        "split:value",
        rationalText({ num: 0n, denom: value.denom }),
      );
      setLeafText(
        splitNode,
        "split:quantity",
        rationalText({ num: 0n, denom: quantity.denom }),
      );
      setLeafText(splitNode, "split:reconciled-state", "v");
    }
  }

  /**
   * Reverses `voidTransaction`: restores every split's original
   * value/quantity and reconcile state (always back to `"n"`, matching
   * desktop GnuCash -- a split's reconciled state before voiding is not
   * preserved), restores the transaction's notes, and clears every
   * void-related slot. No-ops are not allowed: refuses a transaction that
   * isn't voided.
   */
  unvoidTransaction(transactionGuid: string): void {
    const transactionNode = this.transactionNodes.get(transactionGuid);
    if (!transactionNode) {
      throw new GncXmlError(`unknown transaction ${transactionGuid}`);
    }
    if (readStringSlot(transactionNode, "void-time") === null) {
      throw new GncXmlError(`transaction ${transactionGuid} is not voided`);
    }

    const slots = findOrCreateSlots(transactionNode, "trn");
    setStringSlot(slots, "notes", readStringSlot(transactionNode, "void-former-notes"));
    setStringSlot(slots, "void-former-notes", null);
    setStringSlot(slots, "void-reason", null);
    setStringSlot(slots, "void-time", null);
    setStringSlot(slots, "trans-read-only", null);
    if (slots.children.length === 0) removeChild(transactionNode, slots);

    const splitsContainer = first(transactionNode, "splits") ?? transactionNode;
    for (const splitNode of children(splitsContainer, "split")) {
      const formerValue = readNumericSlot(splitNode, "void-former-value");
      const formerQuantity = readNumericSlot(splitNode, "void-former-amount");
      if (formerValue) setLeafText(splitNode, "split:value", rationalText(formerValue));
      if (formerQuantity) {
        setLeafText(splitNode, "split:quantity", rationalText(formerQuantity));
      }
      setLeafText(splitNode, "split:reconciled-state", "n");
      const splitSlots = first(splitNode, "slots");
      if (splitSlots) {
        setNumericSlot(splitSlots, "void-former-value", null);
        setNumericSlot(splitSlots, "void-former-amount", null);
        if (splitSlots.children.length === 0) removeChild(splitNode, splitSlots);
      }
    }
  }

  // MARK: scheduled transactions

  private findTemplateTransactionsNode(): XmlNode | undefined {
    return first(this.book, "template-transactions");
  }

  private findOrCreateTemplateTransactionsNode(): XmlNode {
    const existing = this.findTemplateTransactionsNode();
    if (existing) return existing;
    const created = node("gnc:template-transactions", {}, []);
    this.book.children.push(created);
    return created;
  }

  /**
   * The single, book-wide hidden "Template Root" account every scheduled
   * transaction's own template account lives under, matching desktop
   * GnuCash's `gnc_book_get_template_root` -- verified against a real
   * GnuCash test fixture (`bug-746937-sx-split-order.gnucash`), not
   * guessed. Created the first time any scheduled transaction is made;
   * `templateRootGuid` is only used then.
   */
  private findOrCreateTemplateRootNode(
    templateTransactionsNode: XmlNode,
    templateRootGuid: Guid | undefined,
  ): XmlNode {
    const existing = children(templateTransactionsNode, "account").find(
      (accountNode) => decoded(first(accountNode, "type")) === "ROOT",
    );
    if (existing) return existing;
    if (!templateRootGuid) {
      throw new GncXmlError(
        "creating the first scheduled transaction in this book requires ids.templateRoot",
      );
    }
    const created = node("gnc:account", { version: "2.0.0" }, [
      leaf("act:name", "Template Root"),
      guidNode("act:id", templateRootGuid),
      leaf("act:type", "ROOT"),
      commodityNode("act:commodity", { space: "template", id: "template" }),
      leaf("act:commodity-scu", "1"),
    ]);
    templateTransactionsNode.children.push(created);
    return created;
  }

  /** Named after its own guid, like real GnuCash -- never shown to a user. */
  private createTemplateAccountNode(guid: Guid, parentGuid: string): XmlNode {
    return node("gnc:account", { version: "2.0.0" }, [
      leaf("act:name", guid),
      guidNode("act:id", guid),
      leaf("act:type", "BANK"),
      commodityNode("act:commodity", { space: "template", id: "template" }),
      leaf("act:commodity-scu", "1"),
      guidNode("act:parent", parentGuid),
    ]);
  }

  private findTemplateTransactionNode(
    templateAccountGuid: string,
  ): XmlNode | undefined {
    const templateTransactionsNode = this.findTemplateTransactionsNode();
    if (!templateTransactionsNode) return undefined;
    return children(templateTransactionsNode, "transaction").find((transactionNode) => {
      const splitsContainer = first(transactionNode, "splits") ?? transactionNode;
      return children(splitsContainer, "split").some(
        (splitNode) => decoded(first(splitNode, "account")) === templateAccountGuid,
      );
    });
  }

  private currencyFraction(ref: CommodityRef): bigint {
    const match = this.commodities().find(
      (commodity) => commodity.space === ref.space && commodity.id === ref.id,
    );
    return match?.fraction ? BigInt(match.fraction) : 100n;
  }

  /**
   * Creates a scheduled transaction: a recurrence rule plus a template of
   * splits, matching desktop GnuCash's own on-disk shape exactly (verified
   * against a real GnuCash test fixture, not guessed) -- a hidden,
   * per-schedule template account (type `BANK`, named after its own guid)
   * under the one shared, book-wide "Template Root" account; a template
   * `gnc:transaction` whose splits point at that template account (never
   * the real one); and a `sched-xaction` KVP frame on each split carrying
   * the real account and amount. Both sides of every split's KVP
   * (`credit-*`/`debit-*`) are always written, matching real GnuCash --
   * the unused side is an empty formula and a zero numeric, never
   * omitted. Amount formulas are always a plain decimal number in this
   * engine (Milestone 1: no algebraic formula evaluation).
   */
  createScheduledTransaction(
    input: CreateScheduledTransactionInput,
    ids: CreateScheduledTransactionIds,
  ): XmlScheduledTransaction {
    if (this.scheduledTransactionNodes.has(ids.scheduledTransaction)) {
      throw new GncXmlError(
        `duplicate scheduled transaction ${ids.scheduledTransaction}`,
      );
    }
    if (input.templateSplits.length < 2) {
      throw new GncXmlError(
        "a scheduled transaction needs at least two template splits",
      );
    }
    if (input.templateSplits.length !== ids.templateSplits.length) {
      throw new GncXmlError("one split id is required per template split");
    }
    let total: Money = { num: 0n, denom: 1n };
    for (const split of input.templateSplits) total = addMoney(total, split.value);
    if (!equalsMoney(total, { num: 0n, denom: 1n })) {
      throw new GncXmlError("template split values must sum to zero");
    }

    const templateTransactionsNode = this.findOrCreateTemplateTransactionsNode();
    const templateRootNode = this.findOrCreateTemplateRootNode(
      templateTransactionsNode,
      ids.templateRoot,
    );
    const templateRootGuid = decoded(first(templateRootNode, "id"));
    const templateAccountNode = this.createTemplateAccountNode(
      ids.templateAccount,
      templateRootGuid,
    );
    templateTransactionsNode.children.push(templateAccountNode);

    const currencyFraction = this.currencyFraction(input.currency);
    const zeroValue: Money = { num: 0n, denom: currencyFraction };
    const zeroQuantity: Money = { num: 0n, denom: 1n };
    const splitNodes = input.templateSplits.map((split, index) => {
      const splitId = ids.templateSplits[index];
      if (!splitId) throw new GncXmlError("missing template split id");
      const isDebit = split.value.num >= 0n;
      const magnitude: Money = isDebit ? split.value : negateMoney(split.value);
      const debitFormula = isDebit ? formatMoney(magnitude, magnitude.denom) : "";
      const creditFormula = isDebit ? "" : formatMoney(magnitude, magnitude.denom);
      const debitNumeric = isDebit ? rationalText(magnitude) : "0/1";
      const creditNumeric = isDebit ? "0/1" : rationalText(magnitude);
      const splitNode = node("trn:split", {}, [
        guidNode("split:id", splitId),
        leaf("split:reconciled-state", "n"),
        leaf("split:value", rationalText(zeroValue)),
        leaf("split:quantity", rationalText(zeroQuantity)),
        guidNode("split:account", ids.templateAccount),
      ]);
      const slots = findOrCreateSlots(splitNode, "split");
      slots.children.push(
        node("slot", {}, [
          leaf("slot:key", "sched-xaction"),
          frameSlotValue([
            { key: "account", type: "guid", text: split.accountGuid },
            { key: "credit-formula", type: "string", text: creditFormula },
            { key: "credit-numeric", type: "numeric", text: creditNumeric },
            { key: "debit-formula", type: "string", text: debitFormula },
            { key: "debit-numeric", type: "numeric", text: debitNumeric },
          ]),
        ]),
      );
      return splitNode;
    });

    const templateTransactionNode = node("gnc:transaction", { version: "2.0.0" }, [
      guidNode("trn:id", ids.templateTransaction),
      commodityNode("trn:currency", input.currency),
      node("trn:date-posted", {}, [leaf("ts:date", `${input.start} 00:00:00 +0000`)]),
      node("trn:date-entered", {}, [leaf("ts:date", `${input.start} 00:00:00 +0000`)]),
      leaf("trn:description", input.description),
      node("trn:splits", {}, splitNodes),
    ]);
    templateTransactionsNode.children.push(templateTransactionNode);

    const sxChildren: XmlNode[] = [
      guidNode("sx:id", ids.scheduledTransaction),
      leaf("sx:name", input.name),
      leaf("sx:enabled", input.enabled === false ? "n" : "y"),
      leaf("sx:autoCreate", input.autoCreate ? "y" : "n"),
      leaf("sx:autoCreateNotify", input.autoCreateNotify ? "y" : "n"),
      leaf("sx:advanceCreateDays", String(input.advanceCreateDays ?? 0)),
      leaf("sx:advanceRemindDays", String(input.advanceRemindDays ?? 0)),
      leaf("sx:instanceCount", "0"),
      gdateNode("sx:start", input.start),
    ];
    if (input.end) {
      if ("occurrences" in input.end) {
        sxChildren.push(leaf("sx:num-occur", String(input.end.occurrences)));
        sxChildren.push(leaf("sx:rem-occur", String(input.end.occurrences)));
      } else {
        sxChildren.push(gdateNode("sx:end", input.end.date));
      }
    }
    sxChildren.push(guidNode("sx:templ-acct", ids.templateAccount));
    const recurrenceChildren: XmlNode[] = [
      leaf("recurrence:mult", String(input.recurrence.multiplier)),
      leaf("recurrence:period_type", PERIOD_TYPE_TO_XML[input.recurrence.periodType]),
      gdateNode("recurrence:start", input.recurrence.start),
    ];
    if (input.recurrence.weekendAdjust !== "none") {
      recurrenceChildren.push(
        leaf("recurrence:weekend_adj", input.recurrence.weekendAdjust),
      );
    }
    sxChildren.push(
      node("sx:schedule", {}, [
        node("gnc:recurrence", { version: "1.0.0" }, recurrenceChildren),
      ]),
    );

    const sxNode = node("gnc:schedxaction", { version: "2.0.0" }, sxChildren);
    this.book.children.push(sxNode);
    this.scheduledTransactionNodes.set(ids.scheduledTransaction, sxNode);
    return this.readScheduledTransaction(sxNode);
  }

  scheduledTransactions(): XmlScheduledTransaction[] {
    return [...this.scheduledTransactionNodes.values()].map((sxNode) =>
      this.readScheduledTransaction(sxNode),
    );
  }

  scheduledTransaction(guid: string): XmlScheduledTransaction | undefined {
    const sxNode = this.scheduledTransactionNodes.get(guid);
    return sxNode ? this.readScheduledTransaction(sxNode) : undefined;
  }

  private readScheduledTransaction(sxNode: XmlNode): XmlScheduledTransaction {
    const guid = decoded(first(sxNode, "id"));
    const name = decoded(first(sxNode, "name"));
    const enabled = decoded(first(sxNode, "enabled")) !== "n";
    const autoCreate = decoded(first(sxNode, "autoCreate")) === "y";
    const autoCreateNotify = decoded(first(sxNode, "autoCreateNotify")) === "y";
    const advanceCreateDays = Number(
      decoded(first(sxNode, "advanceCreateDays")) || "0",
    );
    const advanceRemindDays = Number(
      decoded(first(sxNode, "advanceRemindDays")) || "0",
    );
    const instanceCount = Number(decoded(first(sxNode, "instanceCount")) || "0");
    const start = readGdate(sxNode, "start") ?? "";
    const lastOccurred = readGdate(sxNode, "last");
    const numOccurNode = first(sxNode, "num-occur");
    const endDate = readGdate(sxNode, "end");
    const end = numOccurNode
      ? { occurrences: Number(decoded(numOccurNode)) }
      : endDate
        ? { date: endDate }
        : null;
    const templateAccountGuid = decoded(first(sxNode, "templ-acct"));

    const scheduleNode = first(sxNode, "schedule");
    const recurrenceNode = scheduleNode ? first(scheduleNode, "recurrence") : undefined;
    const multiplier = recurrenceNode
      ? Number(decoded(first(recurrenceNode, "mult")) || "1")
      : 1;
    const periodTypeXml = recurrenceNode
      ? decoded(first(recurrenceNode, "period_type"))
      : "once";
    const periodType = PERIOD_TYPE_FROM_XML.get(periodTypeXml) ?? "once";
    const recurrenceStart =
      (recurrenceNode ? readGdate(recurrenceNode, "start") : null) ?? start;
    const weekendAdjustText = recurrenceNode
      ? decoded(first(recurrenceNode, "weekend_adj"))
      : "";
    const weekendAdjust: WeekendAdjust =
      weekendAdjustText === "back" || weekendAdjustText === "forward"
        ? weekendAdjustText
        : "none";

    const templateTransactionNode =
      this.findTemplateTransactionNode(templateAccountGuid);
    let description = "";
    let currency: CommodityRef = { space: "CURRENCY", id: "USD" };
    const templateSplits: XmlScheduledSplit[] = [];
    if (templateTransactionNode) {
      description = decoded(first(templateTransactionNode, "description"));
      currency = readCommodityRef(templateTransactionNode, "currency") ?? currency;
      const splitsContainer =
        first(templateTransactionNode, "splits") ?? templateTransactionNode;
      for (const splitNode of children(splitsContainer, "split")) {
        const frame = readFrameSlotEntries(splitNode, "sched-xaction");
        const realAccountGuid = frame.get("account");
        if (!realAccountGuid) continue;
        const debitNumeric = frame.get("debit-numeric");
        const creditNumeric = frame.get("credit-numeric");
        const debitMoney = debitNumeric ? rational(debitNumeric) : null;
        const creditMoney = creditNumeric ? rational(creditNumeric) : null;
        const value: Money =
          debitMoney && debitMoney.num !== 0n
            ? debitMoney
            : creditMoney && creditMoney.num !== 0n
              ? { num: -creditMoney.num, denom: creditMoney.denom }
              : { num: 0n, denom: 1n };
        templateSplits.push({ accountGuid: realAccountGuid, value });
      }
    }

    return {
      guid,
      name,
      description,
      currency,
      enabled,
      autoCreate,
      autoCreateNotify,
      advanceCreateDays,
      advanceRemindDays,
      start,
      lastOccurred,
      instanceCount,
      end,
      recurrence: { periodType, multiplier, start: recurrenceStart, weekendAdjust },
      templateAccountGuid,
      templateSplits,
    };
  }

  updateScheduledTransaction(
    guid: string,
    patch: UpdateScheduledTransactionInput,
  ): XmlScheduledTransaction {
    const sxNode = this.scheduledTransactionNodes.get(guid);
    if (!sxNode) throw new GncXmlError(`unknown scheduled transaction ${guid}`);
    if (patch.name !== undefined) setLeafText(sxNode, "sx:name", patch.name);
    if (patch.enabled !== undefined) {
      setLeafText(sxNode, "sx:enabled", patch.enabled ? "y" : "n");
    }
    if (patch.autoCreate !== undefined) {
      setLeafText(sxNode, "sx:autoCreate", patch.autoCreate ? "y" : "n");
    }
    if (patch.autoCreateNotify !== undefined) {
      setLeafText(sxNode, "sx:autoCreateNotify", patch.autoCreateNotify ? "y" : "n");
    }
    if (patch.advanceCreateDays !== undefined) {
      setLeafText(sxNode, "sx:advanceCreateDays", String(patch.advanceCreateDays));
    }
    if (patch.advanceRemindDays !== undefined) {
      setLeafText(sxNode, "sx:advanceRemindDays", String(patch.advanceRemindDays));
    }
    return this.readScheduledTransaction(sxNode);
  }

  /** Also removes its template account and template transaction. */
  deleteScheduledTransaction(guid: string): void {
    const sxNode = this.scheduledTransactionNodes.get(guid);
    if (!sxNode) return;
    const templateAccountGuid = decoded(first(sxNode, "templ-acct"));
    const templateTransactionsNode = this.findTemplateTransactionsNode();
    if (templateTransactionsNode) {
      const templateTransactionNode =
        this.findTemplateTransactionNode(templateAccountGuid);
      if (templateTransactionNode) {
        removeChild(templateTransactionsNode, templateTransactionNode);
      }
      const templateAccountNode = children(templateTransactionsNode, "account").find(
        (accountNode) => decoded(first(accountNode, "id")) === templateAccountGuid,
      );
      if (templateAccountNode)
        removeChild(templateTransactionsNode, templateAccountNode);
    }
    removeChild(this.book, sxNode);
    this.scheduledTransactionNodes.delete(guid);
  }

  /**
   * Every enabled schedule's due instances as of `asOf`, classified by what
   * should happen to them -- this is a pure read, it never posts or
   * mutates anything; the caller (the web route, when the book is opened)
   * is responsible for calling `postScheduledInstance` for every
   * `"autoPost"`/`"autoPostNotify"` result and surfacing `"needsApproval"`/
   * `"reminder"` ones for the owner to act on.
   */
  dueScheduledInstances(asOf: string): DueScheduledInstance[] {
    const results: DueScheduledInstance[] = [];
    for (const sx of this.scheduledTransactions()) {
      if (!sx.enabled) continue;
      if (sx.end && "occurrences" in sx.end && sx.instanceCount >= sx.end.occurrences)
        continue;
      const createBoundary = addDays(asOf, sx.advanceCreateDays);
      const remindBoundary = addDays(createBoundary, sx.advanceRemindDays);
      let current = sx.lastOccurred ?? "0001-01-01";
      for (let guard = 0; guard < 1000; guard += 1) {
        const next = nextInstance(sx.recurrence, current);
        if (next === null) break;
        if (sx.end && "date" in sx.end && next > sx.end.date) break;
        if (next > remindBoundary) break;
        const action: DueInstanceAction =
          next <= createBoundary
            ? sx.autoCreate
              ? sx.autoCreateNotify
                ? "autoPostNotify"
                : "autoPost"
              : "needsApproval"
            : "reminder";
        results.push({
          scheduledTransactionGuid: sx.guid,
          name: sx.name,
          date: next,
          action,
        });
        if (action === "reminder") break;
        current = next;
      }
    }
    return results;
  }

  /** Posts a real transaction from the template and advances `sx:last`. */
  postScheduledInstance(
    scheduledTransactionGuid: string,
    date: string,
    ids: PostTransactionIds,
  ): XmlTransaction {
    const sx = this.scheduledTransaction(scheduledTransactionGuid);
    if (!sx) {
      throw new GncXmlError(
        `unknown scheduled transaction ${scheduledTransactionGuid}`,
      );
    }
    const result = this.postTransaction(
      {
        currency: sx.currency,
        datePosted: `${date} 00:00:00 +0000`,
        dateEntered: `${date} 00:00:00 +0000`,
        description: sx.description,
        splits: sx.templateSplits.map((split) => ({
          accountGuid: split.accountGuid,
          value: split.value,
        })),
      },
      ids,
    );
    this.advanceScheduledTransaction(scheduledTransactionGuid, date);
    return result;
  }

  /** Advances `sx:last` past this instance without posting anything -- Milestone 1's "skip". */
  skipScheduledInstance(scheduledTransactionGuid: string, date: string): void {
    if (!this.scheduledTransactionNodes.has(scheduledTransactionGuid)) {
      throw new GncXmlError(
        `unknown scheduled transaction ${scheduledTransactionGuid}`,
      );
    }
    this.advanceScheduledTransaction(scheduledTransactionGuid, date);
  }

  private advanceScheduledTransaction(guid: string, date: string): void {
    const sxNode = this.scheduledTransactionNodes.get(guid);
    if (!sxNode) return;
    const existingLast = first(sxNode, "last");
    if (existingLast) {
      setLeafText(existingLast, "gdate", date);
    } else {
      const startNode = first(sxNode, "start");
      const insertAt = startNode
        ? sxNode.children.indexOf(startNode) + 1
        : sxNode.children.length;
      sxNode.children.splice(insertAt, 0, gdateNode("sx:last", date));
    }
    const instanceCount = Number(decoded(first(sxNode, "instanceCount")) || "0");
    setLeafText(sxNode, "sx:instanceCount", String(instanceCount + 1));
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

  private ownerType(invoiceOrBillNode: XmlNode): string {
    const owner = first(invoiceOrBillNode, "owner");
    return owner ? decoded(first(owner, "type")) : "";
  }

  invoices(): XmlInvoice[] {
    return [...this.invoiceNodes.values()]
      .filter((node) => this.ownerType(node) !== "gncVendor")
      .map((node) => this.readInvoice(node));
  }

  invoice(guid: string): XmlInvoice | undefined {
    const invoiceNode = this.invoiceNodes.get(guid);
    return invoiceNode && this.ownerType(invoiceNode) !== "gncVendor"
      ? this.readInvoice(invoiceNode)
      : undefined;
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

  // MARK: vendors

  vendors(): XmlVendor[] {
    return [...this.vendorNodes.values()].map((node) => this.readVendor(node));
  }

  vendor(guid: string): XmlVendor | undefined {
    const vendorNode = this.vendorNodes.get(guid);
    return vendorNode ? this.readVendor(vendorNode) : undefined;
  }

  private readVendor(vendorNode: XmlNode): XmlVendor {
    const address = first(vendorNode, "addr");
    const addressField = (name: string): string =>
      address ? decoded(first(address, name)) : "";
    return {
      guid: decoded(first(vendorNode, "guid")),
      name: decoded(first(vendorNode, "name")),
      vendorNumber: decoded(first(vendorNode, "id")),
      addressLine1: addressField("addr1"),
      phone: addressField("phone"),
      email: addressField("email"),
      notes: decoded(first(vendorNode, "notes")),
      active: decoded(first(vendorNode, "active")) !== "0",
    };
  }

  createVendor(input: CreateVendorInput, guid: Guid): XmlVendor {
    if (this.vendorNodes.has(guid)) {
      throw new GncXmlError(`duplicate vendor ${guid}`);
    }
    const addressChildren = [
      leaf("addr:name", ""),
      leaf("addr:addr1", input.addressLine1 ?? ""),
      leaf("addr:addr2", ""),
      leaf("addr:phone", input.phone ?? ""),
      leaf("addr:email", input.email ?? ""),
    ];
    const vendorNode = node("gnc:GncVendor", { version: "2.0.0" }, [
      guidNode("vendor:guid", guid),
      leaf("vendor:name", input.name),
      leaf("vendor:id", input.vendorNumber ?? ""),
      node("vendor:addr", { version: "2.0.0" }, addressChildren),
      leaf("vendor:notes", input.notes ?? ""),
      leaf("vendor:taxincluded", "0"),
      leaf("vendor:active", "1"),
      commodityNode("vendor:currency", input.currency),
    ]);
    this.book.children.push(vendorNode);
    this.vendorNodes.set(guid, vendorNode);
    return this.readVendor(vendorNode);
  }

  updateVendor(guid: string, patch: UpdateVendorInput): XmlVendor {
    const vendorNode = this.vendorNodes.get(guid);
    if (!vendorNode) throw new GncXmlError(`unknown vendor ${guid}`);
    if (patch.name !== undefined) setLeafText(vendorNode, "vendor:name", patch.name);
    if (patch.vendorNumber !== undefined) {
      setLeafText(vendorNode, "vendor:id", patch.vendorNumber);
    }
    if (patch.notes !== undefined) setLeafText(vendorNode, "vendor:notes", patch.notes);
    if (patch.active !== undefined) {
      setLeafText(vendorNode, "vendor:active", patch.active ? "1" : "0");
    }
    const addressFields: Array<[keyof UpdateVendorInput, string]> = [
      ["addressLine1", "addr:addr1"],
      ["phone", "addr:phone"],
      ["email", "addr:email"],
    ];
    if (addressFields.some(([key]) => patch[key] !== undefined)) {
      const address =
        first(vendorNode, "addr") ??
        setOrCreateChild(vendorNode, "addr", () =>
          node("vendor:addr", { version: "2.0.0" }),
        );
      for (const [key, tag] of addressFields) {
        const value = patch[key];
        if (value !== undefined) setLeafText(address, tag, String(value));
      }
    }
    return this.readVendor(vendorNode);
  }

  deleteVendor(guid: string): void {
    const vendorNode = this.vendorNodes.get(guid);
    if (!vendorNode) return;
    removeChild(this.book, vendorNode);
    this.vendorNodes.delete(guid);
  }

  vendorInUse(guid: string): boolean {
    return this.bills().some((bill) => bill.vendorGuid === guid);
  }

  // MARK: bills and bill entries

  bills(): XmlBill[] {
    return [...this.invoiceNodes.values()]
      .filter((node) => this.ownerType(node) === "gncVendor")
      .map((node) => this.readBill(node));
  }

  bill(guid: string): XmlBill | undefined {
    const billNode = this.invoiceNodes.get(guid);
    return billNode && this.ownerType(billNode) === "gncVendor"
      ? this.readBill(billNode)
      : undefined;
  }

  private readBill(billNode: XmlNode): XmlBill {
    const owner = first(billNode, "owner");
    return {
      guid: decoded(first(billNode, "guid")),
      billNumber: decoded(first(billNode, "id")),
      vendorGuid: owner ? decoded(first(owner, "id")) : "",
      dateOpened: decoded(nested(billNode, "opened", "date")),
      datePosted: first(billNode, "posted")
        ? decoded(nested(billNode, "posted", "date"))
        : null,
      notes: decoded(first(billNode, "notes")),
      active: decoded(first(billNode, "active")) !== "0",
      postedTransactionGuid: first(billNode, "posttxn")
        ? decoded(first(billNode, "posttxn"))
        : null,
      payableAccountGuid: first(billNode, "postacc")
        ? decoded(first(billNode, "postacc"))
        : null,
    };
  }

  /** Every line on one bill, oldest first. */
  billEntries(billGuid: string): XmlBillEntry[] {
    return children(this.book, "GncEntry")
      .map((entryNode) => this.readBillEntry(entryNode))
      .filter((entry): entry is XmlBillEntry => entry?.billGuid === billGuid)
      .sort((a, b) =>
        a.date === b.date ? (a.guid < b.guid ? -1 : 1) : a.date < b.date ? -1 : 1,
      );
  }

  private readBillEntry(entryNode: XmlNode): XmlBillEntry | null {
    const billGuid = decoded(first(entryNode, "bill"));
    const expenseAccountGuid = decoded(first(entryNode, "b-acct"));
    if (!billGuid || !expenseAccountGuid) return null;
    return {
      guid: decoded(first(entryNode, "guid")),
      billGuid,
      date: decoded(nested(entryNode, "date", "date")),
      description: decoded(first(entryNode, "description")),
      quantity: rational(text(first(entryNode, "qty"))),
      unitPrice: rational(text(first(entryNode, "b-price"))),
      expenseAccountGuid,
    };
  }

  createBill(input: CreateBillInput, guid: Guid): XmlBill {
    if (this.invoiceNodes.has(guid)) {
      throw new GncXmlError(`duplicate bill ${guid}`);
    }
    const owner = node("invoice:owner", { version: "2.0.0" }, [
      leaf("owner:type", "gncVendor"),
      guidNode("owner:id", input.vendorGuid),
    ]);
    const billNode = node("gnc:GncInvoice", { version: "2.0.0" }, [
      guidNode("invoice:guid", guid),
      leaf("invoice:id", input.billNumber),
      owner,
      node("invoice:opened", {}, [leaf("ts:date", input.dateOpened)]),
      leaf("invoice:notes", input.notes ?? ""),
      leaf("invoice:active", "1"),
      commodityNode("invoice:currency", input.currency),
    ]);
    this.book.children.push(billNode);
    this.invoiceNodes.set(guid, billNode);
    return this.readBill(billNode);
  }

  /** Drafts only: a posted bill is part of permanent ledger history. */
  deleteBill(guid: string): void {
    const billNode = this.invoiceNodes.get(guid);
    if (!billNode) return;
    for (const entryNode of children(this.book, "GncEntry")) {
      if (decoded(first(entryNode, "bill")) === guid) removeChild(this.book, entryNode);
    }
    removeChild(this.book, billNode);
    this.invoiceNodes.delete(guid);
  }

  addBillEntry(input: CreateBillEntryInput, guid: Guid): XmlBillEntry {
    const entryNode = node("gnc:GncEntry", { version: "2.0.0" }, [
      guidNode("entry:guid", guid),
      node("entry:date", {}, [leaf("ts:date", input.date)]),
      node("entry:entered", {}, [leaf("ts:date", input.date)]),
      leaf("entry:description", input.description),
      leaf("entry:qty", rationalText(input.quantity)),
      guidNode("entry:b-acct", input.expenseAccountGuid),
      leaf("entry:b-price", rationalText(input.unitPrice)),
      guidNode("entry:bill", input.billGuid),
      leaf("entry:billable", "0"),
      leaf("entry:b-taxable", "0"),
      leaf("entry:b-taxincluded", "0"),
    ]);
    this.book.children.push(entryNode);
    const entry = this.readBillEntry(entryNode);
    if (!entry) throw new GncXmlError("failed to build bill entry");
    return entry;
  }

  deleteBillEntry(guid: string): void {
    const entryNode = children(this.book, "GncEntry").find(
      (candidate) => decoded(first(candidate, "guid")) === guid,
    );
    if (entryNode) removeChild(this.book, entryNode);
  }

  /**
   * Marks a draft bill posted: stamps the posted date, the real ledger
   * transaction behind it, and the payable account used -- matching
   * desktop GnuCash's own "Post Bill" action. The caller creates that
   * transaction separately via `postTransaction`.
   */
  markBillPosted(
    guid: string,
    postedDate: string,
    transactionGuid: string,
    payableAccountGuid: string,
  ): void {
    const billNode = this.invoiceNodes.get(guid);
    if (!billNode) throw new GncXmlError(`unknown bill ${guid}`);
    billNode.children.push(
      node("invoice:posted", {}, [leaf("ts:date", postedDate)]),
      guidNode("invoice:posttxn", transactionGuid),
      guidNode("invoice:postacc", payableAccountGuid),
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
