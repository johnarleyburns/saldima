// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { guidFrom } from "./guid.ts";
import { money } from "./money.ts";
import { GncXmlDocument, GncXmlError } from "./xml-document.ts";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/books/oracle-mini.gnucash", import.meta.url),
);

async function loadFixtureXml(): Promise<string> {
  return gunzipSync(await readFile(fixturePath)).toString("utf8");
}

const BANK = "beaccedcde8943b7ab77d5e98efa8eed";
const SALARY = "0176bdbd429c4b4bac0e48b035f51643";
const USD = { space: "CURRENCY", id: "USD" };

describe("GncXmlDocument", () => {
  it("round-trips the real fixture untouched, preserving structure it does not model", async () => {
    const xml = await loadFixtureXml();
    const doc = GncXmlDocument.parse(xml);
    const serialized = doc.serialize();

    // The transaction-level gdate slot is not modelled by this engine at all;
    // it must survive byte-for-byte because the original node is never rewritten.
    expect(serialized).toContain("<slot:key>date-posted</slot:key>");
    expect(serialized).toContain(
      '<slot:value type="gdate"><gdate>2025-01-15</gdate></slot:value>',
    );
    // All 29 namespace declarations on the root element survive untouched.
    expect(serialized).toContain('xmlns:lot="http://www.gnucash.org/XML/lot"');
    expect(serialized).toContain(
      'xmlns:billterm="http://www.gnucash.org/XML/billterm"',
    );

    const reparsed = GncXmlDocument.parse(serialized);
    expect(reparsed.bookGuid()).toBe(doc.bookGuid());
    expect(reparsed.accounts().map((a) => [a.name, a.type, a.parentGuid])).toEqual(
      doc.accounts().map((a) => [a.name, a.type, a.parentGuid]),
    );
    expect(reparsed.transactions()).toHaveLength(1);
    const tx = reparsed.transaction("9afa9610758442bebc2ebfeb77620f7f");
    expect(tx?.description).toBe("Opening deposit");
    expect(tx?.datePosted).toBe("2025-01-15 10:59:00 +0000");
    expect(tx?.splits.map((s) => [s.accountGuid, s.value])).toEqual(
      doc
        .transaction("9afa9610758442bebc2ebfeb77620f7f")
        ?.splits.map((s) => [s.accountGuid, s.value]),
    );
  });

  it("preserves unrelated accounts and the transaction slot when editing one account", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    doc.updateAccount(BANK, { name: "Checking" });
    const serialized = doc.serialize();

    expect(serialized).toContain("<act:name>Checking</act:name>");
    expect(serialized).toContain("<act:name>Salary</act:name>");
    expect(serialized).toContain(
      '<slot:value type="gdate"><gdate>2025-01-15</gdate></slot:value>',
    );
  });

  it("creates, updates and deletes an account", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const guid = guidFrom("1".repeat(32));
    const created = doc.createAccount(
      {
        name: "Petty Cash",
        type: "CASH",
        parentGuid: "8079d9c5a07c4ecebd5e7ac2067207b8",
        commodity: USD,
        placeholder: true,
      },
      guid,
    );
    expect(created).toMatchObject({
      name: "Petty Cash",
      type: "CASH",
      placeholder: true,
    });
    expect(doc.account(guid)).toMatchObject({ name: "Petty Cash", hidden: false });

    const updated = doc.updateAccount(guid, { name: "Petty Cash Box", hidden: true });
    expect(updated.name).toBe("Petty Cash Box");
    expect(updated.hidden).toBe(true);
    expect(updated.placeholder).toBe(true);

    const unhidden = doc.updateAccount(guid, { hidden: false });
    expect(unhidden.hidden).toBe(false);
    expect(doc.serialize()).not.toContain("<slot:key>hidden</slot:key>");

    doc.deleteAccount(guid);
    expect(doc.account(guid)).toBeUndefined();
    expect(() => doc.updateAccount(guid, { name: "x" })).toThrow(GncXmlError);
  });

  it("rejects a duplicate account guid", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    expect(() =>
      doc.createAccount(
        { name: "Dup", type: "ASSET", parentGuid: null, commodity: USD },
        guidFrom(BANK),
      ),
    ).toThrow(GncXmlError);
  });

  it("posts a balanced transaction and reads it back", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const txId = guidFrom("2".repeat(32));
    const splitIds = [guidFrom("3".repeat(32)), guidFrom("4".repeat(32))];
    const posted = doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-02-01 00:00:00 +0000",
        dateEntered: "2026-02-01 12:00:00 +0000",
        description: "Coffee",
        splits: [
          { accountGuid: BANK, value: money(-500n, 100n), memo: "beans" },
          { accountGuid: SALARY, value: money(500n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );
    expect(posted.description).toBe("Coffee");
    expect(posted.splits).toHaveLength(2);
    expect(posted.splits[0]?.memo).toBe("beans");

    const reparsed = GncXmlDocument.parse(doc.serialize());
    expect(reparsed.transaction(txId)?.description).toBe("Coffee");
    expect(reparsed.transactions()).toHaveLength(2);

    doc.deleteTransaction(txId);
    expect(doc.transaction(txId)).toBeUndefined();
  });

  it("reconciles a split, then un-reconciles it, like checking a row off in GnuCash's Reconcile window", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const txId = guidFrom("2".repeat(32));
    const splitIds = [guidFrom("3".repeat(32)), guidFrom("4".repeat(32))];
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-02-01 00:00:00 +0000",
        dateEntered: "2026-02-01 00:00:00 +0000",
        description: "Coffee",
        splits: [
          { accountGuid: BANK, value: money(-500n, 100n) },
          { accountGuid: SALARY, value: money(500n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );
    const [bankSplitId] = splitIds;
    if (!bankSplitId) throw new Error("expected a split id");

    doc.setSplitReconcileState(txId, bankSplitId, "c");
    expect(doc.transaction(txId)?.splits[0]?.reconcileState).toBe("c");
    expect(doc.transaction(txId)?.splits[0]?.reconcileDate).toBeNull();

    doc.setSplitReconcileState(txId, bankSplitId, "y", "2026-02-05 00:00:00 +0000");
    const reconciled = doc.transaction(txId)?.splits[0];
    expect(reconciled?.reconcileState).toBe("y");
    expect(reconciled?.reconcileDate).toBe("2026-02-05 00:00:00 +0000");

    const reparsed = GncXmlDocument.parse(doc.serialize());
    const reparsedSplit = reparsed.transaction(txId)?.splits[0];
    expect(reparsedSplit?.reconcileState).toBe("y");
    expect(reparsedSplit?.reconcileDate).toBe("2026-02-05 00:00:00 +0000");

    doc.setSplitReconcileState(txId, bankSplitId, "n");
    const cleared = doc.transaction(txId)?.splits[0];
    expect(cleared?.reconcileState).toBe("n");
    expect(cleared?.reconcileDate).toBeNull();
  });

  it("requires a reconcile date to mark a split reconciled, and rejects unknown ids", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const txId = guidFrom("2".repeat(32));
    const splitIds = [guidFrom("3".repeat(32)), guidFrom("4".repeat(32))];
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-02-01 00:00:00 +0000",
        dateEntered: "2026-02-01 00:00:00 +0000",
        description: "Coffee",
        splits: [
          { accountGuid: BANK, value: money(-500n, 100n) },
          { accountGuid: SALARY, value: money(500n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );
    const [bankSplitId] = splitIds;
    if (!bankSplitId) throw new Error("expected a split id");

    expect(() => doc.setSplitReconcileState(txId, bankSplitId, "y")).toThrow(
      GncXmlError,
    );
    expect(() =>
      doc.setSplitReconcileState(guidFrom("f".repeat(32)), bankSplitId, "c"),
    ).toThrow(GncXmlError);
    expect(() =>
      doc.setSplitReconcileState(txId, guidFrom("f".repeat(32)), "c"),
    ).toThrow(GncXmlError);
  });

  it("attaches, reads and removes a receipt (GnuCash's doc-link) on a posted transaction", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const txId = guidFrom("2".repeat(32));
    const splitIds = [guidFrom("3".repeat(32)), guidFrom("4".repeat(32))];
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-02-01 00:00:00 +0000",
        dateEntered: "2026-02-01 00:00:00 +0000",
        description: "Office supplies",
        splits: [
          { accountGuid: BANK, value: money(-4200n, 100n) },
          { accountGuid: SALARY, value: money(4200n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );
    expect(doc.transaction(txId)?.docLink).toBeNull();

    doc.setTransactionDocLink(txId, "receipts/one.jpg");
    expect(doc.transaction(txId)?.docLink).toBe("receipts/one.jpg");

    const reparsed = GncXmlDocument.parse(doc.serialize());
    expect(reparsed.transaction(txId)?.docLink).toBe("receipts/one.jpg");

    doc.setTransactionDocLink(txId, null);
    expect(doc.transaction(txId)?.docLink).toBeNull();

    expect(() => doc.setTransactionDocLink(guidFrom("f".repeat(32)), "x")).toThrow(
      GncXmlError,
    );
  });

  it("creates a customer, an invoice with lines, and posts it as a real transaction", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const customerGuid = guidFrom("c".repeat(32));

    const customer = doc.createCustomer(
      {
        name: "Acme Holdings",
        customerNumber: "C-0001",
        addressLine1: "1 Market St",
        email: "billing@acme.test",
        currency: USD,
      },
      customerGuid,
    );
    expect(customer.name).toBe("Acme Holdings");
    expect(doc.customers()).toHaveLength(1);
    expect(doc.customer(customerGuid)?.customerNumber).toBe("C-0001");

    doc.updateCustomer(customerGuid, { name: "Acme Holdings LLC" });
    expect(doc.customer(customerGuid)?.name).toBe("Acme Holdings LLC");

    const invoiceGuid = guidFrom("d".repeat(32));
    const invoice = doc.createInvoice(
      {
        customerGuid,
        invoiceNumber: "INV-1001",
        dateOpened: "2026-03-01",
        notes: "March premium",
        currency: USD,
      },
      invoiceGuid,
    );
    expect(invoice.datePosted).toBeNull();
    expect(doc.invoices()).toHaveLength(1);

    const lineGuid = guidFrom("e".repeat(32));
    const entry = doc.addInvoiceEntry(
      {
        invoiceGuid,
        date: "2026-03-01",
        description: "Monthly premium",
        quantity: money(1n, 1n),
        unitPrice: money(25000n, 100n),
        incomeAccountGuid: SALARY,
      },
      lineGuid,
    );
    expect(entry.unitPrice).toEqual(money(25000n, 100n));
    expect(doc.invoiceEntries(invoiceGuid)).toHaveLength(1);

    const txGuid = guidFrom("f".repeat(32));
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-03-01 00:00:00 +0000",
        dateEntered: "2026-03-01 00:00:00 +0000",
        description: "Invoice INV-1001",
        splits: [
          { accountGuid: BANK, value: money(25000n, 100n) },
          { accountGuid: SALARY, value: money(-25000n, 100n) },
        ],
      },
      {
        transaction: txGuid,
        splits: [guidFrom("1".repeat(32)), guidFrom("2".repeat(32))],
      },
    );
    doc.markInvoicePosted(invoiceGuid, "2026-03-01", txGuid, BANK);

    const posted = doc.invoice(invoiceGuid);
    expect(posted?.datePosted).toBe("2026-03-01");
    expect(posted?.postedTransactionGuid).toBe(txGuid);
    expect(posted?.receivableAccountGuid).toBe(BANK);

    const reparsed = GncXmlDocument.parse(doc.serialize());
    expect(reparsed.customers()).toHaveLength(1);
    expect(reparsed.invoices()).toHaveLength(1);
    expect(reparsed.invoiceEntries(invoiceGuid)).toHaveLength(1);
    expect(reparsed.invoice(invoiceGuid)?.datePosted).toBe("2026-03-01");

    doc.deleteCustomer(customerGuid);
    expect(doc.customer(customerGuid)).toBeUndefined();
  });

  it("refuses to delete a customer that still has invoices (checked by the caller)", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const customerGuid = guidFrom("c".repeat(32));
    doc.createCustomer({ name: "Acme", currency: USD }, customerGuid);
    const invoiceGuid = guidFrom("d".repeat(32));
    doc.createInvoice(
      { customerGuid, invoiceNumber: "INV-1", dateOpened: "2026-03-01", currency: USD },
      invoiceGuid,
    );
    expect(doc.customerInUse(customerGuid)).toBe(true);

    doc.deleteInvoice(invoiceGuid);
    expect(doc.invoice(invoiceGuid)).toBeUndefined();
    expect(doc.customerInUse(customerGuid)).toBe(false);
  });

  it("rejects an unbalanced or under-specified transaction", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    expect(() =>
      doc.postTransaction(
        {
          currency: USD,
          datePosted: "2026-02-01 00:00:00 +0000",
          dateEntered: "2026-02-01 00:00:00 +0000",
          description: "Bad",
          splits: [
            { accountGuid: BANK, value: money(-500n, 100n) },
            { accountGuid: SALARY, value: money(400n, 100n) },
          ],
        },
        {
          transaction: guidFrom("5".repeat(32)),
          splits: [guidFrom("6".repeat(32)), guidFrom("7".repeat(32))],
        },
      ),
    ).toThrow(GncXmlError);

    expect(() =>
      doc.postTransaction(
        {
          currency: USD,
          datePosted: "2026-02-01 00:00:00 +0000",
          dateEntered: "2026-02-01 00:00:00 +0000",
          description: "Too few",
          splits: [{ accountGuid: BANK, value: money(0n, 100n) }],
        },
        { transaction: guidFrom("8".repeat(32)), splits: [guidFrom("9".repeat(32))] },
      ),
    ).toThrow(GncXmlError);
  });

  it("adds a commodity once and is idempotent", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const before = doc.commodities().length;
    doc.ensureCommodity({ space: "NASDAQ", id: "AAPL" }, 10000);
    expect(doc.commodities()).toHaveLength(before + 1);
    doc.ensureCommodity({ space: "NASDAQ", id: "AAPL" });
    expect(doc.commodities()).toHaveLength(before + 1);
    doc.ensureCommodity(USD);
    expect(doc.commodities()).toHaveLength(before + 1);
  });

  it("escapes and decodes XML entities in names and descriptions symmetrically", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const guid = guidFrom("a".repeat(32));
    doc.createAccount(
      {
        name: 'Johnson & Sons <Corp> "Trust"',
        type: "ASSET",
        parentGuid: null,
        commodity: USD,
      },
      guid,
    );
    const serialized = doc.serialize();
    expect(serialized).toContain("Johnson &amp; Sons &lt;Corp&gt; &quot;Trust&quot;");
    expect(serialized).not.toContain('Johnson & Sons <Corp> "Trust"');

    const reparsed = GncXmlDocument.parse(serialized);
    expect(reparsed.account(guid)?.name).toBe('Johnson & Sons <Corp> "Trust"');
  });

  it("round-trips a hand-built book exercising prices, lots and scheduled transactions it does not model", () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:act="http://www.gnucash.org/XML/act" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty" xmlns:price="http://www.gnucash.org/XML/price" xmlns:slot="http://www.gnucash.org/XML/slot" xmlns:split="http://www.gnucash.org/XML/split" xmlns:sx="http://www.gnucash.org/XML/sx" xmlns:trn="http://www.gnucash.org/XML/trn" xmlns:ts="http://www.gnucash.org/XML/ts" xmlns:lot="http://www.gnucash.org/XML/lot">
<gnc:book version="2.0.0">
<book:id type="guid">${"b".repeat(32)}</book:id>
<gnc:commodity version="2.0.0"><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></gnc:commodity>
<gnc:account version="2.0.0">
  <act:name>Brokerage</act:name>
  <act:id type="guid">${"1".repeat(32)}</act:id>
  <act:type>ASSET</act:type>
  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:slots>
    <slot><slot:key>notes</slot:key><slot:value type="string">Taxable brokerage account</slot:value></slot>
  </act:slots>
  <act:lots>
    <gnc:lot version="2.0.0"><lot:id type="guid">${"2".repeat(32)}</lot:id></gnc:lot>
  </act:lots>
</gnc:account>
<gnc:pricedb version="1">
  <price>
    <price:id type="guid">${"3".repeat(32)}</price:id>
    <price:commodity><cmdty:space>NASDAQ</cmdty:space><cmdty:id>AAPL</cmdty:id></price:commodity>
    <price:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></price:currency>
    <price:time><ts:date>2026-01-01 00:00:00 +0000</ts:date></price:time>
    <price:source>user:price-editor</price:source>
    <price:type>last</price:type>
    <price:value>19000/100</price:value>
  </price>
</gnc:pricedb>
<gnc:schedxaction version="2.0.0">
  <sx:id type="guid">${"4".repeat(32)}</sx:id>
  <sx:name>Rent</sx:name>
  <sx:enabled>y</sx:enabled>
</gnc:schedxaction>
</gnc:book>
</gnc-v2>`;

    const doc = GncXmlDocument.parse(xml);
    doc.updateAccount("1".repeat(32), { description: "Main brokerage" });
    const serialized = doc.serialize();

    expect(serialized).toContain("<act:description>Main brokerage</act:description>");
    // Account-level slot this engine does not model (only hidden/placeholder are).
    expect(serialized).toContain("<slot:key>notes</slot:key>");
    expect(serialized).toContain("Taxable brokerage account");
    // Lots, price database and scheduled transactions are untouched siblings.
    expect(serialized).toContain(`<lot:id type="guid">${"2".repeat(32)}</lot:id>`);
    expect(serialized).toContain("<price:value>19000/100</price:value>");
    expect(serialized).toContain("<sx:name>Rent</sx:name>");

    const reparsed = GncXmlDocument.parse(serialized);
    expect(reparsed.account("1".repeat(32))?.description).toBe("Main brokerage");
  });

  it("decodes numeric XML entities", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const guid = guidFrom("c".repeat(32));
    doc.createAccount(
      { name: "Ampersand", type: "ASSET", parentGuid: null, commodity: USD },
      guid,
    );
    const reparsed = GncXmlDocument.parse(
      doc.serialize().replace("Ampersand", "Caf&#233; &#x26;"),
    );
    expect(reparsed.account(guid)?.name).toBe("Café &");
  });

  it("reads and writes every optional split and account field explicitly", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const accountGuid = guidFrom("d".repeat(32));
    const created = doc.createAccount(
      {
        name: "Brokerage",
        type: "ASSET",
        parentGuid: BANK,
        commodity: { space: "NASDAQ", id: "AAPL" },
        commodityScu: 10000,
        code: "1050",
        description: "Taxable account",
      },
      accountGuid,
    );
    expect(created).toMatchObject({
      parentGuid: BANK,
      commodity: { space: "NASDAQ", id: "AAPL" },
      commodityScu: 10000,
      code: "1050",
      description: "Taxable account",
    });

    const txId = guidFrom("e".repeat(32));
    const splitIds = [guidFrom("f".repeat(32)), guidFrom("1".repeat(32))];
    const posted = doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-03-01 00:00:00 +0000",
        dateEntered: "2026-03-01 00:00:00 +0000",
        description: "Buy shares",
        num: "1001",
        splits: [
          {
            accountGuid,
            value: money(-1000n, 100n),
            quantity: money(5n, 1n),
            action: "Buy",
            reconcileState: "y",
          },
          { accountGuid: BANK, value: money(1000n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );
    expect(posted.num).toBe("1001");
    expect(posted.splits[0]).toMatchObject({
      quantity: money(5n, 1n),
      action: "Buy",
      reconcileState: "y",
    });

    const reparsed = GncXmlDocument.parse(doc.serialize());
    const reparsedTx = reparsed.transaction(txId);
    expect(reparsedTx?.num).toBe("1001");
    expect(reparsedTx?.splits[0]).toMatchObject({
      quantity: money(5n, 1n),
      action: "Buy",
      reconcileState: "y",
    });
  });

  it("moves an account between parents and then to the top level", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const guid = guidFrom("2".repeat(32));
    doc.createAccount(
      { name: "Orphan", type: "ASSET", parentGuid: null, commodity: USD },
      guid,
    );
    expect(doc.account(guid)?.parentGuid).toBeNull();

    doc.updateAccount(guid, { parentGuid: BANK });
    expect(doc.account(guid)?.parentGuid).toBe(BANK);

    doc.updateAccount(guid, { parentGuid: SALARY });
    expect(doc.account(guid)?.parentGuid).toBe(SALARY);

    doc.updateAccount(guid, { parentGuid: null });
    expect(doc.account(guid)?.parentGuid).toBeNull();
  });

  it("reads a commodity's name and fraction when present", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const template = doc
      .commodities()
      .find((commodity) => commodity.space === "template");
    expect(template).toMatchObject({ name: "template", fraction: 1 });
    const currency = doc
      .commodities()
      .find((commodity) => commodity.space === "CURRENCY");
    expect(currency?.name).toBeNull();
  });

  it("updates an account's type and code independently of other fields", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const updated = doc.updateAccount(BANK, { type: "CASH", code: "1020" });
    expect(updated).toMatchObject({ type: "CASH", code: "1020", name: "Bank" });
  });

  it("creates a hidden (not placeholder) account, and a placeholder (not hidden) one", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const hiddenOnly = doc.createAccount(
      {
        name: "Hidden only",
        type: "ASSET",
        parentGuid: null,
        commodity: USD,
        hidden: true,
      },
      guidFrom("5".repeat(32)),
    );
    expect(hiddenOnly).toMatchObject({ hidden: true, placeholder: false });

    const placeholderOnly = doc.createAccount(
      {
        name: "Placeholder only",
        type: "ASSET",
        parentGuid: null,
        commodity: USD,
        placeholder: true,
      },
      guidFrom("6".repeat(32)),
    );
    expect(placeholderOnly).toMatchObject({ hidden: false, placeholder: true });
  });

  it("clears a parent that was never set, and creates an account in a book with no transactions yet", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:act="http://www.gnucash.org/XML/act" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty">
<gnc:book version="2.0.0">
<book:id type="guid">${"7".repeat(32)}</book:id>
<gnc:commodity version="2.0.0"><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></gnc:commodity>
</gnc:book>
</gnc-v2>`);
    const guid = guidFrom("8".repeat(32));
    const created = doc.createAccount(
      { name: "Only account", type: "ASSET", parentGuid: null, commodity: USD },
      guid,
    );
    expect(created.parentGuid).toBeNull();

    const unchanged = doc.updateAccount(guid, { parentGuid: null });
    expect(unchanged.parentGuid).toBeNull();
  });

  it("defaults missing optional split fields when reading a hand-written transaction", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:act="http://www.gnucash.org/XML/act" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty" xmlns:trn="http://www.gnucash.org/XML/trn" xmlns:split="http://www.gnucash.org/XML/split">
<gnc:book version="2.0.0">
<book:id type="guid">${"9".repeat(32)}</book:id>
<gnc:transaction version="2.0.0">
  <trn:id type="guid">${"a".repeat(32)}</trn:id>
  <trn:description>Minimal</trn:description>
  <trn:splits>
    <trn:split>
      <split:id type="guid">${"b".repeat(32)}</split:id>
      <split:value>100/100</split:value>
      <split:account type="guid">${"c".repeat(32)}</split:account>
    </trn:split>
  </trn:splits>
</gnc:transaction>
</gnc:book>
</gnc-v2>`);
    const tx = doc.transaction("a".repeat(32));
    expect(tx?.currency).toBeNull();
    expect(tx?.num).toBe("");
    expect(tx?.splits[0]).toMatchObject({
      memo: "",
      action: "",
      reconcileState: "n",
      quantity: money(100n, 100n),
    });
  });

  it("reads and reconciles splits on a transaction with no trn:splits wrapper", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book" xmlns:trn="http://www.gnucash.org/XML/trn" xmlns:split="http://www.gnucash.org/XML/split">
<gnc:book version="2.0.0">
<book:id type="guid">${"1".repeat(32)}</book:id>
<gnc:transaction version="2.0.0">
  <trn:id type="guid">${"2".repeat(32)}</trn:id>
  <trn:description>Direct splits</trn:description>
  <trn:split>
    <split:id type="guid">${"3".repeat(32)}</split:id>
    <split:value>100/100</split:value>
    <split:account type="guid">${"4".repeat(32)}</split:account>
  </trn:split>
  <trn:split>
    <split:id type="guid">${"5".repeat(32)}</split:id>
    <split:value>-100/100</split:value>
    <split:account type="guid">${"6".repeat(32)}</split:account>
  </trn:split>
</gnc:transaction>
</gnc:book>
</gnc-v2>`);
    const txId = "2".repeat(32);
    const splitId = "3".repeat(32);
    expect(doc.transaction(txId)?.splits).toHaveLength(2);

    doc.setSplitReconcileState(txId, splitId, "y", "2026-04-01 00:00:00 +0000");
    doc.setSplitReconcileState(txId, splitId, "y", "2026-04-02 00:00:00 +0000");
    expect(doc.transaction(txId)?.splits[0]?.reconcileDate).toBe(
      "2026-04-02 00:00:00 +0000",
    );
  });

  it("updates an existing doc-link in place, and clearing an absent one is a no-op", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const txId = guidFrom("2".repeat(32));
    const splitIds = [guidFrom("3".repeat(32)), guidFrom("4".repeat(32))];
    doc.postTransaction(
      {
        currency: USD,
        datePosted: "2026-02-01 00:00:00 +0000",
        dateEntered: "2026-02-01 00:00:00 +0000",
        description: "Office supplies",
        splits: [
          { accountGuid: BANK, value: money(-4200n, 100n) },
          { accountGuid: SALARY, value: money(4200n, 100n) },
        ],
      },
      { transaction: txId, splits: splitIds },
    );

    doc.setTransactionDocLink(txId, null);
    expect(doc.transaction(txId)?.docLink).toBeNull();

    doc.setTransactionDocLink(txId, "receipts/one.jpg");
    doc.setTransactionDocLink(txId, "receipts/two.jpg");
    expect(doc.transaction(txId)?.docLink).toBe("receipts/two.jpg");
  });

  it("rejects a duplicate transaction id and a split/id count mismatch", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    const txId = guidFrom("2".repeat(32));
    const splitIds = [guidFrom("3".repeat(32)), guidFrom("4".repeat(32))];
    const input = {
      currency: USD,
      datePosted: "2026-02-01 00:00:00 +0000",
      dateEntered: "2026-02-01 00:00:00 +0000",
      description: "Coffee",
      splits: [
        { accountGuid: BANK, value: money(-500n, 100n) },
        { accountGuid: SALARY, value: money(500n, 100n) },
      ],
    };
    doc.postTransaction(input, { transaction: txId, splits: splitIds });

    expect(() =>
      doc.postTransaction(input, { transaction: txId, splits: splitIds }),
    ).toThrow(GncXmlError);
    expect(() =>
      doc.postTransaction(input, {
        transaction: guidFrom("5".repeat(32)),
        splits: [guidFrom("6".repeat(32))],
      }),
    ).toThrow(GncXmlError);
  });

  it("no-ops deleting an unknown account, and clears both hidden and placeholder together", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    expect(() => doc.deleteAccount(guidFrom("f".repeat(32)))).not.toThrow();

    const guid = guidFrom("9".repeat(32));
    doc.createAccount(
      {
        name: "Petty cash",
        type: "CASH",
        parentGuid: null,
        commodity: USD,
        hidden: true,
        placeholder: true,
      },
      guid,
    );
    doc.updateAccount(guid, { parentGuid: BANK });
    expect(doc.account(guid)?.parentGuid).toBe(BANK);

    doc.updateAccount(guid, { hidden: true });
    expect(doc.account(guid)).toMatchObject({ hidden: true, placeholder: true });
    doc.updateAccount(guid, { placeholder: false });
    expect(doc.account(guid)).toMatchObject({ hidden: true, placeholder: false });
    doc.updateAccount(guid, { hidden: false, placeholder: false });
    expect(doc.account(guid)).toMatchObject({ hidden: false, placeholder: false });
  });

  it("adds the first commodity to a book that has none yet", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:book="http://www.gnucash.org/XML/book">
<gnc:book version="2.0.0">
<book:id type="guid">${"3".repeat(32)}</book:id>
</gnc:book>
</gnc-v2>`);
    expect(doc.commodities()).toHaveLength(0);
    doc.ensureCommodity(USD);
    expect(doc.commodities()).toHaveLength(1);
  });

  it("updates individual customer fields independently, including on a customer with no address block", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:cust="http://www.gnucash.org/XML/cust" xmlns:book="http://www.gnucash.org/XML/book" xmlns:cmdty="http://www.gnucash.org/XML/cmdty">
<gnc:book version="2.0.0">
<book:id type="guid">${"7".repeat(32)}</book:id>
<gnc:GncCustomer version="2.0.0">
  <cust:guid type="guid">${"8".repeat(32)}</cust:guid>
  <cust:name>No Address LLC</cust:name>
  <cust:id>C-0002</cust:id>
  <cust:active>1</cust:active>
</gnc:GncCustomer>
</gnc:book>
</gnc-v2>`);
    const guid = "8".repeat(32);
    expect(doc.customer(guid)?.addressLine1).toBe("");

    doc.updateCustomer(guid, { customerNumber: "C-0003" });
    expect(doc.customer(guid)?.customerNumber).toBe("C-0003");
    expect(doc.customer(guid)?.name).toBe("No Address LLC");

    doc.updateCustomer(guid, { notes: "VIP", active: false });
    expect(doc.customer(guid)).toMatchObject({ notes: "VIP", active: false });

    doc.updateCustomer(guid, { addressLine1: "500 Market St" });
    expect(doc.customer(guid)?.addressLine1).toBe("500 Market St");

    expect(() => doc.updateCustomer(guidFrom("f".repeat(32)), { name: "x" })).toThrow(
      GncXmlError,
    );
  });

  it("no-ops deleting an unknown customer, invoice or invoice entry", async () => {
    const doc = GncXmlDocument.parse(await loadFixtureXml());
    expect(() => doc.deleteCustomer(guidFrom("f".repeat(32)))).not.toThrow();
    expect(() => doc.deleteInvoice(guidFrom("f".repeat(32)))).not.toThrow();
    expect(() => doc.deleteInvoiceEntry(guidFrom("f".repeat(32)))).not.toThrow();
  });

  it("reads an invoice missing its owner and posting fields, and filters out a malformed entry", () => {
    const doc = GncXmlDocument.parse(`<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2 xmlns:gnc="http://www.gnucash.org/XML/gnc" xmlns:invoice="http://www.gnucash.org/XML/invoice" xmlns:entry="http://www.gnucash.org/XML/entry" xmlns:book="http://www.gnucash.org/XML/book" xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:book version="2.0.0">
<book:id type="guid">${"9".repeat(32)}</book:id>
<gnc:GncInvoice version="2.0.0">
  <invoice:guid type="guid">${"a".repeat(32)}</invoice:guid>
  <invoice:id>INV-0</invoice:id>
  <invoice:opened><ts:date>2026-01-01</ts:date></invoice:opened>
  <invoice:active>1</invoice:active>
</gnc:GncInvoice>
<gnc:GncEntry version="2.0.0">
  <entry:guid type="guid">${"b".repeat(32)}</entry:guid>
</gnc:GncEntry>
</gnc:book>
</gnc-v2>`);
    const invoiceGuid = "a".repeat(32);
    const invoice = doc.invoice(invoiceGuid);
    expect(invoice?.customerGuid).toBe("");
    expect(invoice?.datePosted).toBeNull();
    expect(invoice?.postedTransactionGuid).toBeNull();
    expect(invoice?.receivableAccountGuid).toBeNull();
    expect(doc.invoiceEntries(invoiceGuid)).toHaveLength(0);
  });
});
